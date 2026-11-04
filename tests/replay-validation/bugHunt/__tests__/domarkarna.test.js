'use strict';

/**
 * Buggjägaren steg 2: domarkärnan — instansnamnrymd, signaturer, befintliga
 * domare och hälsa. Fixturerna är trimmade verkliga replayresultat; testen
 * prövar domarlogiken, inte appen. Inga barnprocesser och inga timers.
 */

const omstart = require('./fixtures/omstart42h.json');
const usvang = require('./fixtures/usvang.json');

describe('buggjägaren: domarkärnan', () => {
  test('(1) två instanser med Klaffbron#4 blir i0: och i1: och joinas rätt', () => {
    const { namespaceEventIds } = require('../lib/instances');
    const raw = omstart.resultat;
    // Utan namnrymd kolliderar id:t: två olika varningar bär Klaffbron#4.
    expect(raw.openingWarnings.filter((w) => w.eventId === 'Klaffbron#4')).toHaveLength(2);
    const ns = namespaceEventIds(raw, omstart.rader);
    const ids = ns.openingWarnings.map((w) => w.eventId);
    expect(ids).toContain('i0:Klaffbron#4');
    expect(ids).toContain('i1:Klaffbron#4');
    // Joinen: varje täckningspost hittar exakt den varning som avfyrades i
    // samma instans — den absorberade båten 11:45:30 hör till 11:45:09-varningen.
    for (const c of ns.openingCoverage) {
      const hits = ns.openingWarnings.filter((w) => w.eventId === c.eventId);
      expect(hits).toHaveLength(1);
      expect(hits[0].t).toBeLessThanOrEqual(c.t);
    }
    const absorbed = ns.openingCoverage.find((c) => c.reason === 'absorbed');
    const owner = ns.openingWarnings.find((w) => w.eventId === absorbed.eventId);
    expect(owner.iso).toBe('2026-08-07T11:45:09.631Z');
    // Originalet är orört, och utan omstart lämnas resultatet som det är.
    expect(raw.openingWarnings[0].eventId).not.toMatch(/^i\d+:/);
    expect(namespaceEventIds(usvang.resultat, usvang.rader)).toBe(usvang.resultat);
  });

  test('(2) normaliseringen är idempotent och behåller INV-id', () => {
    const sig = require('../lib/signature');
    const msgs = [
      'DEFAULT-FLASH: 2026-08-06T08:47:00.040Z "Inga båtar" inklämd (30s) mellan två "En … Stridsbergsbron"-texter utan passage',
      'INV-14W LÅNG DEFAULT-SANDWICH: 2026-07-14T03:12:00.000Z "Inga båtar" inklämd 1745s (29.1 min)',
      'INV-11 DISTANS: 265552100@Klaffbron @512m via source=current (proximity-källa >400 m)',
      'OBELAGD KONVOJTÄCKNING: i1:Klaffbron#4 för 211214850',
      '[APP ERROR] 🚨 [GPS_JUMP] 265035480: GPS jump detected 583m - COG: 9°, Speed mismatch: true',
    ];
    for (const m of msgs) {
      const once = sig.normalize(m);
      expect(sig.normalize(once)).toBe(once);
      // Inga siffror kvar utom i INV-id.
      expect(once.replace(/INV-\d+[A-Z]?/g, '')).not.toMatch(/\d/);
    }
    expect(sig.normalize(msgs[1])).toMatch(/^INV-14W LÅNG DEFAULT-SANDWICH: T /);
    expect(sig.normalize(msgs[2])).toBe('INV-11 DISTANS: M@Klaffbron @Nm via source=current (proximity-källa >N m)');
    expect(sig.normalize(msgs[3])).toBe('OBELAGD KONVOJTÄCKNING: iN:Klaffbron#N för M');
    expect(sig.invariantClass(msgs[0])).toBe('INV-14 DEFAULT-FLASH');
    expect(sig.invariantClass(msgs[2])).toBe('INV-11 DISTANS');
    expect(sig.invIdOf('MISSAD MÅLBRO-NOTIS: 265025978:Klaffbron — 2 registrerade passager men 1 notis(er)')).toBe('INV-5');
    // Instansnyckeln behåller talen: en längre flash är en annan instans.
    expect(sig.instanceKey(msgs[0])).not.toBe(sig.instanceKey(msgs[0].replace('(30s)', '(56s)')));
    expect(sig.normalize(msgs[0])).toBe(sig.normalize(msgs[0].replace('(30s)', '(56s)')));
    // Metadata extraheras ur texten.
    expect(sig.bridgeOf(msgs[2])).toBe('Klaffbron');
    expect(sig.mmsiOf(msgs[2])).toBe('265552100');
    expect(sig.timeOf(msgs[0])).toBe(Date.parse('2026-08-06T08:47:00.040Z'));
  });

  test('(3) en ny APP ERROR-signatur ger H3, baslinjens GPS_JUMP-signatur gör det inte', () => {
    const { stderrHistogram } = require('../lib/pool');
    const health = require('../lib/oracles/health');
    const bankStderr = '[APP ERROR] 🚨 [GPS_JUMP] 265035480: GPS jump detected 583m - COG: 9°, Speed mismatch: true\n';
    const baseline = health.buildH3Baseline([{ simTimmar: 485, stderr: stderrHistogram(bankStderr) }]);
    const world = stderrHistogram([
      '[APP ERROR] 🚨 [GPS_JUMP] 211593250: GPS jump detected 612m - COG: 14°, Speed mismatch: true',
      '[APP ERROR] TypeError: Cannot read properties of undefined (reading \'eta\') i _reevaluateVesselStatuses',
      '(node:123) Warning: något ofarligt',
    ].join('\n'));
    expect(Object.keys(world.övrigt)).toHaveLength(1);
    const fynd = health.h3(world.h3, baseline, { simTimmar: 3, exempel: world.exempel });
    const kandidater = fynd.filter((f) => !f.räknare);
    expect(kandidater).toHaveLength(1);
    expect(kandidater[0].orakel).toBe('H3');
    expect(kandidater[0].klass).toMatch(/TypeError: Cannot read properties of undefined/);
    expect(fynd.some((f) => /GPS_JUMP/.test(f.klass) && !f.räknare)).toBe(false);
  });

  test('(4) två resultat som bara skiljer i heapUsedMB är lika enligt H5', () => {
    const health = require('../lib/oracles/health');
    const a = JSON.parse(JSON.stringify(usvang.resultat));
    const b = JSON.parse(JSON.stringify(usvang.resultat));
    a.leakDiagnostics.heapUsedMB = 41;
    b.leakDiagnostics.heapUsedMB = 57;
    expect(health.h5(a, b)).toEqual({ lika: true, skillnad: null });
    b.notifications[2].t += 1000;
    const res = health.h5(a, b);
    expect(res.lika).toBe(false);
    expect(res.skillnad).toMatch(/^notifications\[2\]\.t:/);
  });

  test('(5) validateWarnInvariants anropas aldrig utan gt-argument', () => {
    const invariants = require('../../invariants');
    const spy = jest.spyOn(invariants, 'validateWarnInvariants');
    const existing = require('../lib/oracles/existing');
    const gt = [{
      mmsi: '265025978', bridge: 'Klaffbron', kind: 'line', t: 1789639700000, inferred: false,
    }];
    existing.judgeExisting({ result: usvang.resultat, rows: usvang.rader, gt });
    existing.judgeExisting({ result: usvang.resultat, rows: usvang.rader, gt: null });
    expect(() => existing.judgeExisting({ result: usvang.resultat, rows: usvang.rader })).toThrow(/gt måste skickas explicit/);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const call of spy.mock.calls) {
      expect(call).toHaveLength(2);
      expect(Array.isArray(call[1])).toBe(true);
    }
    expect(spy.mock.calls[0][1]).toBe(gt);
    spy.mockRestore();
  });

  test('befintliga domare ger INV-5-fyndet för U-svängaren i fyndformatet', () => {
    const existing = require('../lib/oracles/existing');
    const { fynd } = existing.judgeExisting({ result: usvang.resultat, rows: usvang.rader, gt: [] });
    const inv5 = fynd.find((f) => f.inv === 'INV-5');
    expect(inv5).toMatchObject({
      orakel: 'INV-F', klass: 'INV-5 MISSAD MÅLBRO-NOTIS', allvar: 5, mmsi: '265025978', bro: 'Klaffbron',
    });
    for (const key of ['orakel', 'klass', 'allvar', 'mmsi', 'bro', 'riktning', 't', 'detalj', 'belägg']) expect(inv5).toHaveProperty(key);
  });
});
