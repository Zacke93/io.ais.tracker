'use strict';

/**
 * Buggjägaren steg 5–6: bankoperationer, projektioner och fasjämförelsen på
 * fixturdata. Inga barnprocesser och inga timers — integrationen (självtestet
 * och M-FAS på hela banken) körs med hunt.js.
 */

const { state } = require('./fixtures/state-20260917-16h.json');
const usvang = require('./fixtures/usvang.json');

const DAY = 86400 * 1000;

describe('buggjägaren: bankoperationer', () => {
  test('(1) shiftEpochDeep flyttar epok-ms men inte andra tal eller strängar', () => {
    const ops = require('../lib/bankOps');
    const out = ops.shiftEpochDeep(state, 30000);
    expect(out.capturedAt).toBe(state.capturedAt + 30000);
    expect(out.version).toBe(1);
    const spot = out.settings.learned_mooring_spots[0];
    expect(spot.t).toBe(state.settings.learned_mooring_spots[0].t + 30000);
    expect(spot.lat).toBe(state.settings.learned_mooring_spots[0].lat);
    const [k] = Object.keys(state.settings.persistent_recent_triggers);
    expect(out.settings.persistent_recent_triggers[k].t).toBe(state.settings.persistent_recent_triggers[k].t + 30000);
    expect(out.settings.persistent_recent_triggers[k].dir).toBe('north');
    const [w] = Object.keys(state.settings.persistent_opening_warnings);
    expect(out.settings.persistent_opening_warnings[w].firedAt).toBe(state.settings.persistent_opening_warnings[w].firedAt + 30000);
    expect(out.settings.persistent_opening_warnings[w].closestDistance).toBe(state.settings.persistent_opening_warnings[w].closestDistance);
    // Nycklar, mmsi och null rörs inte; originalet är oförändrat.
    expect(Object.keys(out.settings.known_vessel_names)).toEqual(Object.keys(state.settings.known_vessel_names));
    const [v] = Object.keys(state.settings.trigger_point_visits.entries);
    expect(out.settings.trigger_point_visits.entries[v].exitedAt).toBeNull();
    expect(ops.shiftEpochDeep({ mmsi: 265552100, s: '1789667153142', n: 4.1e12 + 1 }, 5)).toEqual({ mmsi: 265552100, s: '1789667153142', n: 4.1e12 + 1 });
  });

  test('(2) relabelDeep hanterar mmsi, mmsi:Bro och Bro|mmsi|riktning', () => {
    const ops = require('../lib/bankOps');
    const map = ops.mmsiBijection([], state);
    expect(map.get('265614080')).toBe(String(999999999 - 265614080));
    const out = ops.relabelDeep(state, map);
    const m = (x) => map.get(x);
    // Heltalsliknande nycklar räknas upp i stigande ordning i JS, så den
    // ordningsomvända bijektionen vänder uppräkningsordningen — avsiktligt.
    expect(Object.keys(out.settings.known_vessel_names)).toEqual(Object.keys(state.settings.known_vessel_names).map(m).sort());
    expect(Object.keys(out.settings.known_vessel_names)).toEqual(Object.keys(state.settings.known_vessel_names).map(m).reverse());
    expect(Object.keys(out.settings.persistent_recent_triggers)).toEqual(['734385919:Kanalinfarten', '734385919:Olidebron']);
    expect(Object.keys(out.settings.trigger_point_visits.entries)[0]).toBe(`${m('265031670')}:Stallbackabron`);
    expect(Object.keys(out.settings.persistent_opening_warnings)[0]).toBe('Klaffbron|734385919|northbound');
    // Namn och tider rörs inte; inversen återställer allt.
    expect(out.settings.known_vessel_names[m('211231860')].name).toBe('FREIHEIT');
    expect(ops.relabelDeep(out, ops.invertMap(map))).toEqual(state);
    // Bijektionen är ordningsomvänd.
    const ids = [...map.keys()].sort();
    const mapped = ids.map(m);
    expect([...mapped].sort().reverse()).toEqual(mapped);
  });

  test('(3) tidsförskjutningen behåller typen: receivedAt förblir ISO, fixTs förblir tal', () => {
    const ops = require('../lib/bankOps');
    const row = {
      mmsi: '265552100', lat: 58.28, lon: 12.28, aisTimestamp: 1786000000000, fixTs: 1785999980000, feed: 'aishub', receivedAt: '2026-08-05T19:06:40.123Z',
    };
    const [out] = ops.shiftRows([row], 7 * DAY + 30000);
    expect(out.aisTimestamp).toBe(row.aisTimestamp + 7 * DAY + 30000);
    expect(out.fixTs).toBe(row.fixTs + 7 * DAY + 30000);
    expect(typeof out.receivedAt).toBe('string');
    expect(out.receivedAt).toBe('2026-08-12T19:07:10.123Z');
    expect(row.receivedAt).toBe('2026-08-05T19:06:40.123Z');
    const [ctrl] = ops.shiftRows([{ ctrl: 'restart', aisTimestamp: 1786000000000 }], -11520);
    expect(ctrl).toEqual({ ctrl: 'restart', aisTimestamp: 1786000000000 - 11520 });
    // Samma kontrakt som fassvepets shiftTimeField.
    const sweep = require('../../runPhaseSweep');
    const a = { receivedAt: row.receivedAt, n: 5 };
    const b = { receivedAt: row.receivedAt, n: 5 };
    sweep.shiftTimeField(a, 'receivedAt', 7000);
    ops.shiftTimeField(b, 'receivedAt', 7000);
    expect(b).toEqual(a);
  });

  test('shiftTimesDeep för tillbaka ett helt resultat (tal och ISO-fält)', () => {
    const ops = require('../lib/bankOps');
    const res = usvang.resultat;
    const there = ops.shiftTimesDeep(res, 30000);
    expect(there.targetPassages[0].iso).not.toBe(res.targetPassages[0].iso);
    expect(ops.shiftTimesDeep(there, -30000)).toEqual(res);
  });

  test('writeVariant ger unikt basnamn och state bara när det finns', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const ops = require('../lib/bankOps');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-bankops-'));
    try {
      const a = ops.writeVariant({
        dir, korpusId: '20260917-16h', tagg: ops.phaseTag(-11.52), rader: usvang.rader, state,
      });
      expect(path.basename(a.jsonl)).toBe('20260917-16h.fas-11.52.jsonl');
      expect(fs.existsSync(a.statePath)).toBe(true);
      const b = ops.writeVariant({
        dir, korpusId: '20260917-16h', tagg: ops.phaseTag(-11.52), rader: usvang.rader, state: null,
      });
      expect(b.statePath).toBeNull();
      expect(fs.existsSync(a.statePath)).toBe(false);
      expect(() => ops.writeVariant({
        dir, korpusId: 'x', tagg: 'y', rader: [{ ctrl: 'restart' }], state: null,
      })).toThrow(/schemafel/);
      const gt = require('../../makeGtPassages');
      expect(gt.idForJsonl(path.basename(a.jsonl))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buggjägaren: projektioner och fasjämförelse', () => {
  test('compareExact är tyst för en ren tidsförskjutning och mmsi-bijektion', () => {
    const ops = require('../lib/bankOps');
    const project = require('../lib/project');
    const res = usvang.resultat;
    const dt = 7 * DAY + 30000;
    expect(project.compareExact(res, ops.shiftTimesDeep(res, dt), { dt, helaResultatet: true }).lika).toBe(true);
    const map = ops.mmsiBijection(usvang.rader);
    const back = ops.invertMap(map);
    const relabeled = ops.relabelDeep(res, map);
    expect(project.compareExact(res, relabeled, { mm: (x) => back.get(String(x)) || String(x) }).lika).toBe(true);
    // En flyttad notis syns.
    const moved = JSON.parse(JSON.stringify(res));
    moved.notifications[0].t += 1000;
    const cmp = project.compareExact(res, moved);
    expect(cmp.lika).toBe(false);
    expect(Object.keys(cmp.skillnader)).toEqual(['notiser']);
  });

  test('openingDiffs skiljer tillagd varning från parat riktningsbyte', () => {
    const rel = require('../lib/relations');
    const card = (direction, t, leadMmsi = '265552100') => ({
      bridge: 'Klaffbron', direction, t, leadMmsi, etaMin: 5, firedBy: 'fix', mmsis: [leadMmsi], success: true, eventId: 'Klaffbron#1',
    });
    const B = { openingWarnings: [card('southbound', 1000000)] };
    const added = rel.openingDiffs(B, { openingWarnings: [card('southbound', 1007000), card('northbound', 5000000)] }, 7000);
    expect(added.map((d) => d.klass)).toEqual(['ÖPPNINGSNYCKEL TILLAGD']);
    expect(added[0].kort.t).toBe(4993000);
    const swapped = rel.openingDiffs(B, { openingWarnings: [card('northbound', 1050000, '211000001')] }, 7000);
    expect(swapped.map((d) => d.klass)).toEqual(['ÖPPNINGSRIKTNING BYTT']);
    expect(swapped[0].par.bas.leadMmsi).toBe('265552100');
    expect(swapped[0].par.variant.leadMmsi).toBe('211000001');
    expect(rel.openingDiffs(B, { openingWarnings: [card('southbound', 1007000)] }, 7000)).toEqual([]);
  });

  test('notificationDrift mäter parade notiser i basens tidsram', () => {
    const project = require('../lib/project');
    const n = (t) => ({
      mmsi: '265552100', bridge: 'Klaffbron', direction: 'northbound', t, success: true,
    });
    const d = project.notificationDrift({ notifications: [n(100000)] }, { notifications: [n(100000 + 7000 + 23000)] }, { dt: 7000 });
    expect(d.maxDriftMs).toBe(23000);
    expect(d.perNyckel[0].nyckel).toBe('265552100:Klaffbron:northbound');
  });

  test('mergePhaseFindings slår ihop samma utslag över δ men inte olika registerutfall', () => {
    const rel = require('../lib/relations');
    const { makeFinding } = require('../lib/finding');
    const f = (deltaS, msg, post) => makeFinding({
      orakel: 'INV-F',
      klass: 'INV-14 DEFAULT-FLASH',
      inv: 'INV-14',
      bro: 'Stridsbergsbron',
      detalj: msg,
      belägg: { meddelanden: [msg] },
      ursprung: { korpus: '20260806-42h', relation: 'M-FAS', deltaS: [deltaS] },
      register: { klass: post ? 'ACCEPTERAD' : 'KANDIDAT', post },
    });
    const out = rel.mergePhaseFindings([
      f(-11.52, 'DEFAULT-FLASH … (60s)', 'KIE-PER-KORPUS'),
      f(7, 'DEFAULT-FLASH … (56s)', 'KIE-PER-KORPUS'),
      f(7, 'DEFAULT-FLASH … (90s)', null),
    ], [7, -11.52]);
    expect(out).toHaveLength(2);
    const acc = out.find((x) => x.register.post === 'KIE-PER-KORPUS');
    expect(acc.ursprung.deltaS).toEqual([7, -11.52]);
    expect(acc.belägg.meddelanden).toEqual(['DEFAULT-FLASH … (56s)', 'DEFAULT-FLASH … (60s)']);
    expect(acc.belägg.perDelta.map((p) => p.deltaS)).toEqual([7, -11.52]);
  });
});
