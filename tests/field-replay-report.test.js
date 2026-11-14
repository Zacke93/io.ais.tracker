'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseFieldLog, compareEvents, openingKeyOf, splitAtStop, measureClaims,
  measureOpeningWarningAge, formatOpeningWarningAge, makeReport, summarize, integrityBanner,
} = require('./replay-validation/compareFieldReplay');
const { crossingsForVessel, BRIDGE_STATIONS } = require('./replay-validation/makeGtPassages');

const stamp = '2026-08-24T14:22:13.959Z';
const line = (message) => `${stamp} [log] [AISBridgeApp] ${message}`;
const safe = (eta) => line(`[FLOW_TRIGGER_SAFE_TOKENS] 276015380: Safe tokens = ${JSON.stringify({
  bridge_name: 'Stridsbergsbron', message: `PHOENIX inväntar broöppning ${eta}`, already_passed: false,
})}`);
const attempt = (eta) => line(`[FLOW_TRIGGER_ATTEMPT] 276015380: bridge=Stridsbergsbron (227m, source=target), direction=söderut, ETA=${eta}`);
const success = line('[FLOW_TRIGGER_SUCCESS] 276015380: boat_near fired for Stridsbergsbron (ID=stridsbergsbron, distance=227m, status=waiting)');

describe('Fältrapporten mäter leverans, innehåll och fältstopp', () => {
  test('misslyckat försök räknas separat och lånar inte en senare lyckad leverans', () => {
    const report = parseFieldLog([
      safe(3), attempt(3),
      line('[FLOW_TRIGGER_ERROR] 276015380: boat_near failed for Stridsbergsbron (timeout)'),
      safe(4), attempt(4), success,
    ].join('\n'));
    expect(report.attempts).toBe(2);
    expect(report.undeliveredAttempts).toHaveLength(1);
    expect(report.undeliveredAttempts[0].failedAt).toBe(Date.parse(stamp));
    expect(report.notifications).toEqual([expect.objectContaining({
      eta: 4,
      message: 'PHOENIX inväntar broöppning 4',
      source: 'target',
      direction: 'southbound',
      alreadyPassed: false,
      statusAtSuccess: 'waiting',
    })]);
  });

  // Granskningen av fixvågen 2026-11-04: ett kort som inte svarat inom
  // tidsgränsen är okvitterat, och en sen kvittens bär sin verkliga tid.
  test('timeout och UNCONFIRMED är ingen kvittens; sen SUCCESS late=true får sin verkliga tid', () => {
    const later = '2026-08-24T14:24:13.959Z';
    const timeoutLines = [
      safe(3), attempt(3),
      line('[FLOW_TRIGGER_TIMEOUT] 276015380: boat_near-kortet svarade inte inom 60 s — behåller dedupen och går vidare'),
      line('[FLOW_TRIGGER_UNCONFIRMED] 276015380: boat_near för Stridsbergsbron okvitterat efter 60 s — dedupen behålls, sent svar loggas'),
    ];
    const unconfirmed = parseFieldLog(timeoutLines.join('\n'));
    expect(unconfirmed.attempts).toBe(1);
    expect(unconfirmed.notifications).toEqual([]);
    expect(unconfirmed.undeliveredAttempts).toHaveLength(1);
    const lateSuccess = `${later} [log] [AISBridgeApp] [FLOW_TRIGGER_SUCCESS] 276015380: boat_near fired for `
      + 'Stridsbergsbron (ID=stridsbergsbron, distance=227m, status=waiting) late=true';
    const delivered = parseFieldLog([...timeoutLines, lateSuccess].join('\n'));
    expect(delivered.undeliveredAttempts).toHaveLength(0);
    expect(delivered.notifications).toEqual([expect.objectContaining({ successAt: Date.parse(later) })]);
  });

  test('lyckad notis utan parsad försöksrad får aldrig bli tyst tom mätning', () => {
    expect(() => parseFieldLog(success)).toThrow('Kortleverans utan läsbart försök');
  });

  test('samma nyckelantal döljer inte flyttad tid, fel text/ETA/källa eller riktning', () => {
    const field = [{
      t: 1000, mmsi: '1', bridge: 'Klaffbron', message: 'väntar', eta: -1, source: 'target', direction: 'northbound',
    }];
    const replay = [{
      ...field[0], t: 99000, message: 'närmar sig', eta: 3, source: 'current', direction: 'southbound',
    }];
    const result = compareEvents(field, replay, (n) => `${n.mmsi}|${n.bridge}`, ['message', 'eta', 'source', 'direction']);
    expect(result.pairs[0].deltaMs).toBe(98000);
    expect(result.pairs[0].changes).toEqual(['message', 'eta', 'source', 'direction']);
  });

  test('ett annat fartyg får inte paras med en saknad notis och extra efterspel syns separat', () => {
    const a = { t: 1000, mmsi: '1', bridge: 'Klaffbron' };
    const b = { t: 1000, mmsi: '2', bridge: 'Klaffbron' };
    const c = { ...a, t: 1001 };
    const compared = compareEvents([a], [b], (n) => `${n.mmsi}|${n.bridge}`, []);
    expect(compared.pairs).toHaveLength(0);
    expect(compared.unmatchedField).toEqual([a]);
    expect(compared.unmatchedReplay).toEqual([b]);
    expect(splitAtStop([a, c], 1000)).toEqual({ observed: [a], afterStop: [c] });
  });

  test.each([0, 1, 2])('borttagen post %s förskjuter inte följande händelser med samma identitet', (removed) => {
    const field = [1000, 61000, 181000].map((t) => ({ t, mmsi: '1', bridge: 'Klaffbron' }));
    const replay = field.filter((e, i) => i !== removed).map((e) => ({ ...e, t: e.t + 100 }));
    const key = (n) => `${n.mmsi}|${n.bridge}`;
    const result = compareEvents(field, replay, key, []);
    expect(result.pairs.map((p) => p.deltaMs)).toEqual([100, 100]);
    expect(result.unmatchedField).toEqual([field[removed]]);
    expect(result.unmatchedReplay).toEqual([]);
    const reverse = compareEvents(replay, field, key, []);
    expect(reverse.pairs.map((p) => p.deltaMs)).toEqual([-100, -100]);
    expect(reverse.unmatchedReplay).toEqual([field[removed]]);
  });

  test('ELFKUNGENs borttagna dubbelvarning blir inte en saknad OLA-varning', () => {
    const first = {
      t: 1000, bridge: 'Stridsbergsbron', leadVessel: 'ELFKUNGEN', direction: 'northbound',
    };
    const duplicate = { ...first, t: 3601000 };
    const south = { ...first, t: 7201000, direction: 'southbound' };
    const ola = { ...first, t: 10801000, leadVessel: 'OLA' };
    const result = compareEvents([first, duplicate, south, ola], [first, south, ola], openingKeyOf, ['leadVessel', 'direction']);
    expect(result.pairs).toHaveLength(3);
    expect(result.pairs.every((p) => p.changes.length === 0 && p.deltaMs === 0)).toBe(true);
    expect(result.unmatchedField).toEqual([duplicate]);
    expect(result.unmatchedReplay).toEqual([]);
  });

  // V1 (fältprovet 2026-11-13): PRICKBJORN varnades 08:30:31 och passerade
  // Stridsbergsbron 12:35:22 (rådata) utan ny varning. Fältrapporten räknade
  // passagen som varnad och nämnde inte åldern; nu redovisas den som WARN.
  test('en 244,9 min gammal öppningsvarning redovisas i båda serierna, utan att fälla', () => {
    const w = Date.parse('2026-11-12T08:30:31.157Z');
    const appT = Date.parse('2026-11-12T12:36:04.670Z');
    const gtT = Date.parse('2026-11-12T12:35:22.513Z');
    const replay = {
      targetPassages: [{
        mmsi: '265012090', bridge: 'Stridsbergsbron', t: appT, iso: new Date(appT).toISOString(),
      }],
      openingWarnings: [{
        t: w,
        iso: new Date(w).toISOString(),
        bridge: 'Stridsbergsbron',
        eventId: 'Stridsbergsbron#19',
        leadVessel: 'PRICKBJORN',
        leadMmsi: '265012090',
        mmsis: ['265012090'],
      }],
      openingCoverage: [],
    };
    const gt = [{
      mmsi: '265012090', bridge: 'Stridsbergsbron', kind: 'line', dir: 'syd', t: gtT, tFrom: gtT - 30000, tTo: gtT + 30000, inferred: false,
    }, {
      mmsi: '265012090', bridge: 'Kanalinfarten', kind: 'zone', t: gtT, inferred: false,
    }];
    const age = measureOpeningWarningAge(replay, gt, new Map());
    expect(age.limitMinutes).toBe(120);
    expect(age.app).toMatchObject({ total: 1, fresh: 0, bands: { 60: 1, 120: 1, 240: 1 } });
    expect(age.groundTruth).toMatchObject({ total: 1, fresh: 0, bands: { 60: 1, 120: 1, 240: 1 } });
    expect(age.groundTruth.stale[0]).toMatchObject({
      mmsi: '265012090', bridge: 'Stridsbergsbron', eventId: 'Stridsbergsbron#19', ageMinutes: 244.9,
    });
    const text = formatOpeningWarningAge(age).join('\n');
    expect(text).toMatch(/GAMMAL VARNING \(appserien\): 265012090 @ Stridsbergsbron/);
    expect(text).toMatch(/GAMMAL VARNING \(rådataserien\): .*244\.9 min gammal/);
    expect(text).toMatch(/WARN, informativ/);
  });

  test('en färsk varning ger ingen GAMMAL VARNING-rad', () => {
    const t = Date.parse('2026-11-12T12:35:22.513Z');
    const replay = {
      targetPassages: [{
        mmsi: '1', bridge: 'Klaffbron', t, iso: new Date(t).toISOString(),
      }],
      openingWarnings: [{
        t: t - 10 * 60000, bridge: 'Klaffbron', eventId: 'Klaffbron#1', leadMmsi: '1', mmsis: ['1'],
      }],
      openingCoverage: [],
    };
    const age = measureOpeningWarningAge(replay, [], new Map());
    expect(age.app.fresh).toBe(1);
    expect(formatOpeningWarningAge(age).join('\n')).not.toMatch(/GAMMAL VARNING/);
  });

  // V4 rev 1 (granskningen 2026-11-14): replay:field kastade när integriteten
  // inte var OK, så k1 och k2 (båda FEL) gav ingen rapport alls och V1-raden
  // nåddes aldrig. Nu skrivs rapporten med en FEL-banner överst, och main()
  // behåller felkoden.
  test('fälld integritet: rapporten skrivs med banner överst och felkoden står kvar', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-field-fel-'));
    try {
      const T0 = Date.UTC(2026, 10, 13, 6, 0, 0);
      const at = (sec, msg) => `${new Date(T0 + sec * 1000).toISOString()} [log] [AISBridgeApp] ${msg}`;
      const rows = [];
      const lines = [at(0, 'AIS Bridge starting with modular architecture v2.0')];
      for (const sec of [60, 90, 120, 210, 240]) { // 90 s-bortfall 120 → 210 med belagt hjärtslag
        const row = JSON.stringify({
          mmsi: '265012090', lat: 58.29, lon: 12.29, sog: 5, aisTimestamp: T0 + sec * 1000,
        });
        rows.push(row);
        lines.push(at(sec, '[DEBUG] 🧹 [COORDINATION_CLEANUP] Cleaned old coordination state'));
        lines.push(at(sec, `[AIS_REPLAY_SAMPLE] ${row}`));
      }
      const logPath = path.join(dir, 'app.log');
      const jsonlPath = path.join(dir, 'ais.jsonl');
      fs.writeFileSync(logPath, `${lines.join('\n')}\n`);
      fs.writeFileSync(jsonlPath, `${rows.join('\n')}\n`);
      const replay = {
        notifications: [],
        openingWarnings: [],
        openingCoverage: [],
        bridgeTextTransitions: [],
        targetPassages: [],
        sampleCount: rows.length,
        processErrors: 0,
        leakDiagnostics: {},
        suppressedTokenTimeouts: 0,
      };
      const report = makeReport(logPath, jsonlPath, replay);
      expect(Object.keys(report)[0]).toBe('integrityBanner');
      expect(report.integrity.verdict).toBe('FEL');
      expect(report.integrityBanner).toMatch(/LOGG-INTEGRITET: FEL — FÄLTBEVIS, ALDRIG FACIT/);
      const text = summarize(report).split('\n');
      expect(text[0]).toBe(report.integrityBanner);
      expect(text[1]).toMatch(/TIDSHÅL I LOGGEN/);
      expect(report.field.gaps).toHaveLength(1);
      expect(integrityBanner({ verdict: 'OK', problems: [] })).toBeNull();
      // Rev 2: DELVIS är grindens "så långt mätningen räcker" (exit 0), inte FEL.
      const delvis = integrityBanner({ verdict: 'DELVIS', problems: [], partialNote: 'aisstream-delen 5/5 mot logg' });
      expect(delvis).toMatch(/^☑️ LOGG-INTEGRITET: DELVIS verifierad \(aisstream-delen 5\/5 mot logg\)/);
      expect(delvis).not.toMatch(/EJ tillåten/);
      expect(integrityBanner({ verdict: 'OKÄNT', problems: [] })).toMatch(/^❓ LOGG-INTEGRITET: OKÄNT.*EJ tillåten/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Rev 2: WARN-texterna står i txt, inte bara antalet (k2:s INV-22 syntes
  // förut bara i json).
  test('field-report.txt listar WARN-invarianternas text', () => {
    const report = {
      integrityBanner: null,
      integrity: { verdict: 'OK', jsonlComplete: 1, problems: [] },
      field: {
        firstIso: 'a', stopIso: 'b', lines: 1, gaps: [],
      },
      notificationComparison: { pairs: [], unmatchedField: [], unmatchedReplay: [] },
      openingComparison: { pairs: [], unmatchedField: [], unmatchedReplay: [] },
      afterStop: { openingWarnings: [] },
      textCounts: { field: 0, replayBeforeStop: 0, replayTotal: 0 },
      openingWarningAge: null,
      replay: {
        targetPassages: [], processErrors: 0, invariantFailures: [], invariantWarnings: ['INV-22 FÖRVARNING EFTER PASSAGE: x'],
      },
      groundTruth: { stats: { crossings: 0, inferred: 0 } },
      limitations: [],
    };
    const text = summarize(report);
    expect(text).toMatch(/1 WARN\./);
    expect(text).toMatch(/^ {2}WARN: INV-22 FÖRVARNING EFTER PASSAGE: x$/m);
  });

  test('inferred-korsning publicerar bara felgränser, aldrig ett exakt ETA-fel', () => {
    const n = {
      t: 100000, mmsi: '1', bridge: 'Stridsbergsbron', direction: 'southbound', eta: 3,
    };
    const p = {
      mmsi: '1', bridge: 'Stridsbergsbron', kind: 'line', dir: 'syd', inferred: true, t: 400000, tFrom: 300000, tTo: 900000,
    };
    const [r] = measureClaims([n], [p]);
    expect(r.measurement).toBe('interval-only');
    expect(r.errorMinutes).toBeUndefined();
    expect(r.leadTimeMinutes).toEqual({ from: 200000 / 60000, to: 800000 / 60000 });
  });
});

describe('P9: gles korsning med stillhet har fönster som facit', () => {
  const station = BRIDGE_STATIONS.find((b) => b.name === 'Stridsbergsbron');
  function cross(gapS, sogP, sogQ) {
    const t = Date.parse('2026-08-24T14:50:18.000Z');
    const p = {
      mmsi: '276015380', name: 'PHOENIX', s: station.s + 85, lat: 58.29415, lon: 12.29556, sog: sogP, t, tFix: t, offsetM: 0, feed: 'aisstream',
    };
    const q = {
      ...p, s: station.s - 236, lat: 58.29125, sog: sogQ, t: t + gapS * 1000, tFix: t + gapS * 1000,
    };
    return crossingsForVessel([p, q]).find((x) => x.bridge === station.name);
  }

  test('PHOENIX-klassen behåller korsningen och hela 721-sekundersfönstret', () => {
    const r = cross(721, 0, 6);
    expect(r.inferred).toBe(true);
    expect(r.inferredReason).toBe('sparse-stopped-endpoint');
    expect(r.tTo - r.tFrom).toBe(721000);
    expect(r.dir).toBe('syd');
  });

  test('stopp i andra ändpunkten ger samma osäkerhet; båten kan ha väntat efter bron', () => {
    expect(cross(721, 6, 0).inferred).toBe(true);
  });

  test('tätt nollfartsfix ändrar inte punktfacit; exakt tidsgräns är 120 s', () => {
    expect(cross(120, 0, 6).inferred).toBe(false);
    expect(cross(120.001, 0, 6).inferred).toBe(true);
  });

  test('rörelse i båda ändar, saknad SOG och exakt 0,5 kn fabricerar inte stillhet', () => {
    expect(cross(721, 4, 6).inferred).toBe(false);
    expect(cross(721, null, 6).inferred).toBe(false);
    expect(cross(721, 0.5, 6).inferred).toBe(false);
    expect(cross(721, -1, 6).inferred).toBe(false);
  });

  test('gamla regeln över 900 s fungerar även utan stillhetsbevis', () => {
    expect(cross(901, 4, 6).inferred).toBe(true);
  });
});
