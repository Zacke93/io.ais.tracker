'use strict';

// Fältkörning 3 (14–15 november 2026, koden 1f6dd46 på ägarens Homey Pro),
// låst som korpus 20261114-34h. Testet prövar de granskade fältfallen mot
// rådatan, inte mot appens egen bokföring: Järnvägsbron söderut på
// passagefixen (rättning C2 i fält), åtta varningar före åtta passager och
// att de förtöjda båtarna vid Kanalinfarten aldrig når notiser, varningar
// eller text. Två kända gränser låses som de ÄR (F7 och K6/F13 i
// docs/faltgranskning-2026-11-14.md); när ETA-etappen (U28) eller en
// rättning av spärren gör dem rättare låses de om enligt U13, och då ska
// förväntningarna nedan ändras i samma commit som referenserna.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { buildFacit } = require('./replay-validation/makeGtPassages');
const { validateInvariants, validateWarnInvariants } = require('./replay-validation/invariants');
const { eventFacitFailures } = require('./replay-validation/eventFacit');
const {
  analyseCoverage, analysePhantoms, analyseOpeningGroups, loadSamples,
} = require('./replay-validation/runOpeningGates');
const corpora = require('./replay-validation/corpora');

const ID = '20261114-34h';
const NAVEN = '231920000';
const NINA = '304244000';
const LIDAN = '231897000';
const SYLVIA = '305288000';
const TRANSITS = [NAVEN, NINA, LIDAN, SYLVIA];
const MOORED = { 265606970: 'PILOT 761', 265012090: 'PRICKBJORN', 265552060: 'CAPELLA' };
const TARGETS = ['Klaffbron', 'Stridsbergsbron'];
const key = (entry) => `${entry.mmsi}|${entry.bridge}`;
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const metres = (a, b) => {
  const dLat = (b.lat - a.lat) * 111320;
  const dLon = (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
};

describe('Fält 14–15 november: passagefixen vid Järnvägsbron, varningarna och kajliggarna', () => {
  let corpus;
  let replay;
  let raw;
  let samples;
  let recorded;

  beforeAll(() => {
    corpus = corpora.find((entry) => entry.id === ID);
    const stdout = execFileSync(process.execPath, [
      path.join(__dirname, 'replay-validation/replayRunner.js'), corpus.jsonl,
    ], {
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env, REPLAY_MONITORING: '1', REPLAY_FUSION: '0', REPLAY_VERBOSE: '', REPLAY_DEBUG_LEVEL: 'off',
      },
    });
    replay = JSON.parse(/__REPLAY_JSON__(.*)__END__/s.exec(stdout)[1]);
    raw = buildFacit(corpus.jsonl).passages;
    samples = loadSamples(corpus.jsonl);
    recorded = fs.readFileSync(corpus.jsonl, 'utf8').trim().split('\n').map(JSON.parse);
  }, 120000);

  test('rådata och startminne är byteexakta kopior av den integritetskontrollerade fångsten', () => {
    expect(sha256(corpus.jsonl)).toBe('cc5b9ecc56605fe72dbe7aae1dd3e5d033cda52eb4a40794f016e27fb6e6c00d');
    expect(sha256(corpus.jsonl.replace(/\.jsonl$/, '.state.json')))
      .toBe('daf2fc3aebb003fcd6d7ea0007ff9a0b66cbe895cbac2ce163ce403d71629f47');
    expect(replay.sampleCount).toBe(3357);
    expect(replay.initialState.source).toBe('recorded');
  });

  test('34 timmar med minutstädning, invarianter och ren avstängning', () => {
    expect(replay.processErrors).toBe(0);
    expect(replay.runtimeDiagnostics).toMatchObject({
      monitoringEnabled: true, monitoringStarts: 1, shutdownErrors: 0, timersAfterShutdown: 0,
    });
    expect(replay.runtimeDiagnostics.staleSweeps).toBeGreaterThan(0);
    expect(replay.leakDiagnostics).toMatchObject({ vessels: 0, cleanupTimers: 0, protectionTimers: 0 });
    expect(validateInvariants(replay)).toEqual([]);
    expect(validateWarnInvariants(replay)).toEqual([]);
  });

  test('alla 24 råa korsningar och zonbesök har var sin notis med rätt riktning, före linjen', () => {
    expect(raw).toHaveLength(24);
    expect(raw.every((passage) => !passage.inferred)).toBe(true);
    expect(replay.notifications).toHaveLength(24);
    expect(replay.notifications.every((notice) => notice.success)).toBe(true);
    expect(replay.notifications.map(key).sort()).toEqual(raw.map(key).sort());
    for (const passage of raw) {
      const notice = replay.notifications.find((entry) => key(entry) === key(passage));
      expect(notice.direction).toBe(passage.dir === 'nord' ? 'northbound' : 'southbound');
      if (passage.kind === 'line') {
        // Notisen bygger på en fix på ankomstsidan: senast fönstrets första fix.
        expect(notice.t).toBeLessThanOrEqual(passage.tFrom);
        expect(notice.alreadyPassed).toBe(false);
      } else {
        // Kanalinfarten: första observerade fixen inne i 300 m-zonen.
        expect(passage.bridge).toBe('Kanalinfarten');
        expect(notice.t).toBe(passage.tTo);
      }
    }
    expect(replay.targetPassages.map(key).sort())
      .toEqual(raw.filter((passage) => TARGETS.includes(passage.bridge)).map(key).sort());
    expect(replay.intermediatePassages.map(key).sort())
      .toEqual(raw.filter((passage) => passage.kind === 'line' && !TARGETS.includes(passage.bridge)).map(key).sort());
  });

  test('Järnvägsbron söderut går på Stridsbergsbrons passagefix, 69–101 s före korsningen (C2 i fält)', () => {
    // Före C2 gick notisen med vakthundens varv efter 30 s-fönstret; i k2 kom
    // alla tre vid eller efter passagen. Här är den samma fix som bokför
    // Stridsbergsbron, på ankomstsidan av Järnvägsbron.
    for (const [mmsi, distance, minLeadS, maxLeadS] of [[NAVEN, 239, 100, 101], [NINA, 150, 69, 70]]) {
      const crossing = raw.find((p) => p.mmsi === mmsi && p.bridge === 'Järnvägsbron');
      expect(crossing).toMatchObject({ kind: 'line', dir: 'syd', inferred: false });
      const notice = replay.notifications.find((n) => n.mmsi === mmsi && n.bridge === 'Järnvägsbron');
      const strids = replay.targetPassages.find((p) => p.mmsi === mmsi && p.bridge === 'Stridsbergsbron');
      expect(notice.t).toBe(strids.t);
      expect(notice).toMatchObject({
        direction: 'southbound', source: 'current', distance, eta: 1, alreadyPassed: false,
      });
      expect(notice.message).toMatch(/närmar sig Järnvägsbron, beräknad ankomst om 1 minut$/);
      const leadS = (crossing.t - notice.t) / 1000;
      expect(leadS).toBeGreaterThan(minLeadS);
      expect(leadS).toBeLessThan(maxLeadS);
      const fix = recorded.find((s) => s.mmsi === mmsi && s.aisTimestamp === notice.t);
      expect(fix).toBeDefined();
      expect(notice.t).toBeLessThanOrEqual(crossing.tFrom);
    }
  });

  test('åtta varningar före åtta råa målpassager, en per öppning, utan fantom', () => {
    const targets = raw.filter((passage) => TARGETS.includes(passage.bridge));
    expect(targets).toHaveLength(8);
    expect(replay.openingWarnings).toHaveLength(8);
    expect(replay.openingSuppressions).toEqual([]);
    const coverage = analyseCoverage(replay, samples, targets);
    expect(coverage.covered).toHaveLength(8);
    expect(coverage.misses).toEqual([]);
    expect(coverage.uncertain).toEqual([]);
    for (const { passage, warning } of coverage.covered) {
      // Mät mot fönstrets BÖRJAN så interpolation inte ger falsk förvarning.
      expect(passage.tFrom - warning.t).toBeGreaterThanOrEqual(60000);
      expect(passage.t - warning.t).toBeLessThan(20 * 60000);
    }
    const phantoms = analysePhantoms(replay, samples, targets);
    expect(phantoms.confirmed).toBe(8);
    expect(phantoms.phantoms).toEqual([]);
    expect(phantoms.inferredTime).toEqual([]);
    const { groups, unattachedWarnings } = analyseOpeningGroups(replay, targets);
    expect(groups).toHaveLength(8);
    expect(unattachedWarnings).toEqual([]);
    for (const group of groups) {
      expect(group.warnings).toHaveLength(1);
      expect(group.uncertainWarnings).toEqual([]);
    }
  });

  test('känd gräns F7: LIDANs Stridsbergsvarning kom 137,8 s före passagen och sa 5 minuter', () => {
    // Låst som den ÄR. Spärren vid Järnvägsbron släpptes på fixen 352 m från
    // bron efter 2,5–3,5 kn; hon ökade till 4,4–5,1 kn. Under utlovade 150 s,
    // över det hårda golvet 60 s. Ändras när F7/U28 avgörs (U13).
    const warning = replay.openingWarnings.find((w) => w.leadMmsi === LIDAN && w.bridge === 'Stridsbergsbron');
    expect(warning).toMatchObject({
      eventId: 'Stridsbergsbron#7', direction: 'northbound', etaMin: 5, firedBy: 'fix', distance: 352, vesselCount: 1,
    });
    const crossing = raw.find((p) => p.mmsi === LIDAN && p.bridge === 'Stridsbergsbron');
    const leadS = (crossing.t - warning.t) / 1000;
    expect(leadS).toBeGreaterThan(137);
    expect(leadS).toBeLessThan(138);
    for (const other of replay.openingWarnings.filter((w) => w !== warning)) {
      const passage = raw.find((p) => other.mmsis.includes(p.mmsi) && p.bridge === other.bridge && p.t > other.t);
      expect(passage.t - other.t).toBeGreaterThanOrEqual(150000);
    }
  });

  test('U33: Klaffbronotisen säger restiden i båtens fart när texten blir strax (förr K6/F13)', () => {
    // Före U33 sa notisen "om 4", "om 4" och "om 3" i samma pass som texten
    // blev strax: notisen bar första ETA-passets utjämnade värde, texten andra
    // passets och avståndsregeln inom 300 m. Nu säger notisen restiden
    // avstånd/fart i båtens fart (avrundad, minst 1) när den är under 3 min
    // och texten säger strax för båten. Sanningen är rådatans linjekorsning.
    const check = (mmsi) => {
      const notice = replay.notifications.find((n) => n.mmsi === mmsi && n.bridge === 'Klaffbron');
      const next = replay.bridgeTextTransitions.find((t) => t.t >= notice.t);
      expect(next.t - notice.t).toBeLessThan(100);
      expect(next.text).toBe('En båt på väg mot Klaffbron, beräknad broöppning strax');
      const fix = recorded.filter((x) => String(x.mmsi) === mmsi && Number.isFinite(x.lat)
        && x.aisTimestamp <= notice.t + 100).pop();
      const travel = notice.distance / (fix.sog * 0.5144) / 60;
      const crossing = raw.find((p) => p.mmsi === mmsi && p.bridge === 'Klaffbron');
      return { eta: notice.eta, travel, truth: (crossing.t - notice.t) / 60000 };
    };
    // LIDAN: 300 m i 3,3 kn = 2,95 min → "om 3" (förr "om 4"); korsade 2,91 min senare.
    const lidan = check(LIDAN);
    expect(lidan.travel).toBeLessThan(3);
    expect(lidan.eta).toBe(3);
    expect(Math.abs(lidan.eta - lidan.truth)).toBeLessThan(0.1);
    // SYLVIA: 175 m i 4,1 kn = 1,38 min → "om 1" (förr "om 3"); korsade 1,57 min senare.
    const sylvia = check(SYLVIA);
    expect(sylvia.eta).toBe(1);
    expect(Math.abs(sylvia.eta - sylvia.truth)).toBeLessThan(Math.abs(3 - sylvia.truth));
    // NINA BRES: 281 m i 2,9 kn = 3,14 min, alltså inte inom 3 min i sin fart:
    // notisen behåller "om 4" medan texten säger strax. Motsägelsen står kvar
    // enligt U33:s fartvillkor (en båt som saktar in mot en kö behåller sin
    // siffra); hon korsade ändå före den utlovade tiden.
    const nina = check(NINA);
    expect(nina.travel).toBeGreaterThanOrEqual(3);
    expect(nina.eta).toBe(4);
    expect(nina.truth).toBeLessThan(4);
  });

  test('de förtöjda båtarna vid Kanalinfarten får ingen notis, varning, passage eller text', () => {
    for (const mmsi of Object.keys(MOORED)) {
      const own = recorded.filter((s) => s.mmsi === mmsi);
      expect(own.length).toBeGreaterThan(300);
      expect(own[0].shipName).toBe(MOORED[mmsi]);
      expect(Math.max(...own.map((s) => metres(own[0], s)))).toBeLessThan(15);
      expect(raw.some((p) => p.mmsi === mmsi)).toBe(false);
      expect(replay.notifications.some((n) => n.mmsi === mmsi)).toBe(false);
      expect(replay.openingWarnings.some((w) => w.mmsis.includes(mmsi))).toBe(false);
      expect(replay.targetPassages.some((p) => p.mmsi === mmsi)).toBe(false);
      expect(replay.intermediatePassages.some((p) => p.mmsi === mmsi)).toBe(false);
    }
    // Varje text med en båt ligger inom någon av de fyra genomresornas
    // observationsfönster; utanför dem står "Inga båtar" och aldrig två båtar.
    const windows = TRANSITS.map((mmsi) => {
      const own = recorded.filter((s) => s.mmsi === mmsi).map((s) => s.aisTimestamp);
      return [Math.min(...own), Math.max(...own)];
    });
    for (const transition of replay.bridgeTextTransitions) {
      if (transition.text.startsWith('Inga båtar')) continue;
      expect(transition.text.startsWith('En båt på väg mot ')).toBe(true);
      expect(windows.some(([from, to]) => transition.t >= from && transition.t <= to)).toBe(true);
    }
    expect(replay.bridgeTextTransitions.filter((t) => t.text.startsWith('Inga båtar'))).toHaveLength(5);
  });

  test('fulla händelser och alla 75 brotexter motsvarar enbart denna korpus granskade referenser', () => {
    const expectedEvents = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'replay-validation/golden-events', `${ID}.json`), 'utf8',
    ));
    const expectedText = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'replay-validation/golden-text', `${ID}.json`), 'utf8',
    ));
    expect(eventFacitFailures(replay, expectedEvents)).toEqual([]);
    expect(replay.bridgeTextTransitions).toHaveLength(75);
    expect(replay.bridgeTextTransitions.map(({ iso, text }) => ({ iso, text }))).toEqual(expectedText);
  });
});
