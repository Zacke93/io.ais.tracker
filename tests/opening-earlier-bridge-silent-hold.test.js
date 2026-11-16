'use strict';

/**
 * Spärren vid en tidigare bro i tystnad (familj D, varv 2, 2026-11-09).
 *
 * Buggjägarens värld 263 (F02, T2 LEDTID): BRISEN 265891927 hördes var
 * 65–69:e sekund efter Klaffbron. Järnvägsbron räknas då som tidigare bro
 * (_earlierBridgeAhead), och spärren håller henne till restiden i nuvarande
 * fart minus WARNING_LEAD_MS. Sista fixet kom 459 m före Stridsbergsbron
 * (202 m före Järnvägsbron) i 2,1 kn. Därefter var hon tyst i 272 s, höll
 * 2,4 kn till Järnvägsbron, ökade efter bron och korsade i 4,2 kn. Varningen
 * gick vid spärrens slut, 44 s före korsningen.
 *
 * Rättningen (_silentHoldLimitMs): har appen inte hört henne på dubbla hennes
 * längsta mottagningsintervall, och minst 210 s (klass B:s takt under 2 kn,
 * 180 s, som AISHub tar emot den: tre pollar à högst 70 s), räknas restiden i
 * hennes fart fram till den tidigare bron och i minst 4 kn efter den. Spärren
 * släpps aldrig innan hon i sin egen fart har nått den tidigare bron. Kursen
 * bort från bron eller en väntande vändning ger ingen sådan släppning.
 *
 * Spärrens syfte står kvar (granskningen och omgranskningen av familj D): en
 * kö som börjar under tystnaden, även nära Järnvägsbron, och en vändning under
 * tystnaden ska ge samma utfall som c14938f. De smala fallen jämförs mot samma
 * tjänst med farten efter bron avstängd (EARLIER_BRIDGE_BEYOND_KN 0, alltså
 * c14938f:s spärr).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Service = require('../lib/services/BridgeOpeningService');
const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');
const { calculateDistance } = require('../lib/utils/geometry');

const START = Date.parse('2026-08-09T14:55:00Z');
const MMSI = '265891927';
const TARGET = 'Stridsbergsbron';
const KN = 0.514444;
const KLAFF = BRIDGES.klaffbron;
const JVB = BRIDGES.jarnvagsbron;
const STRID = BRIDGES.stridsbergsbron;
const SPAN = calculateDistance(KLAFF.lat, KLAFF.lon, STRID.lat, STRID.lon);
const LEAD_MS = BRIDGE_OPENING.WARNING_LEAD_MS;
const C14938F = { EARLIER_BRIDGE_BEYOND_KN: 0 };

// En punkt d meter före Stridsbergsbron på linjen Klaffbron–Stridsbergsbron.
const along = (d) => ({
  lat: STRID.lat + (KLAFF.lat - STRID.lat) * (d / SPAN),
  lon: STRID.lon + (KLAFF.lon - STRID.lon) * (d / SPAN),
});
const toJvb = (d) => {
  const p = along(d);
  return calculateDistance(p.lat, p.lon, JVB.lat, JVB.lon);
};

describe('Spärren vid en tidigare bro i tystnad (värld 263)', () => {
  const services = [];
  const make = (config) => {
    const warnings = [];
    const service = new Service({ onWarning: (w) => warnings.push(w), targetBridges: [TARGET], config });
    services.push(service);
    return { service, warnings };
  };
  // Båten norrut efter Klaffbron. fixAgeS ger AISHub-fixets ålder vid mottagningen.
  const boat = (d, sog, { fixAgeS = 0, ...extra } = {}) => ({
    mmsi: MMSI,
    name: 'BRISEN',
    ...along(d),
    sog,
    cog: 34,
    targetBridge: TARGET,
    _routeDirection: 'north',
    _hasMovementProof: true,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now() - fixAgeS * 1000,
    fixFeed: 'aishub',
    etaMinutes: null,
    status: 'en-route',
    passedBridges: ['Klaffbron'],
    ...extra,
  });
  // En bekräftad kö vid Järnvägsbron (samma bevis som brotexten läser).
  const queued = (s, d, sinceS) => [s, d, 0, {
    status: 'waiting',
    _stationarySince: START + sinceS * 1000,
    _stillnessAnchor: { ...along(d), t: START + sinceS * 1000 },
    _bridgeQueueApproaches: { Järnvägsbron: { confirmedAt: START + sinceS * 1000, direction: 'north' } },
  }];
  // Spela upp fixen [s efter START, avstånd, fart, extra] och ticka varje sekund till `untilS`.
  const play = (fixes, untilS, runs) => {
    const sorted = [...fixes].sort((a, b) => a[0] - b[0]);
    let next = 0;
    for (let s = 0; s <= untilS; s++) {
      while (next < sorted.length && sorted[next][0] <= s) {
        const [fs0, d, sog, extra] = sorted[next++];
        jest.setSystemTime(START + fs0 * 1000);
        for (const { service } of runs) service.observeVessel(boat(d, sog, extra));
      }
      jest.setSystemTime(START + s * 1000);
      for (const { service } of runs) service.tick();
    }
    return runs.map(({ warnings }) => warnings.map((w) => ({
      atS: (w.t - START) / 1000, eventId: w.eventId, firedBy: w.firedBy, mmsis: w.mmsis,
    })));
  };
  // Inflygningen ur värld 263: var 65–69:e sekund, sista fixet 459 m i 2,1 kn (AISHub, 9 s gammalt).
  const APPROACH = [
    [0, 1115, 2.5], [69, 941, 2.4], [134, 881, 2.5], [199, 832, 2.6],
    [268, 699, 2.4], [334, 670, 2.4], [400, 556, 2.4], [466, 459, 2.1, { fixAgeS: 9 }],
  ];
  const LAST_S = 466;

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
  });
  afterEach(() => {
    while (services.length) services.pop().destroy();
    jest.useRealTimers();
  });

  test('tystnad efter en krypande inflygning: sträckan efter Järnvägsbron räknas på rask fart', () => {
    const run = make();
    const [warnings] = play(APPROACH, LAST_S + 300, [run]);
    expect(warnings).toHaveLength(1);
    // Tystnadsgränsen är max(2 × 69 s, 210 s) efter sista mottagningen. Restiden
    // i 2,1 kn fram till bron och 4 kn efter den, minus 180 s, är kortare,
    // liksom tiden fram till Järnvägsbron i 2,1 kn (202 m, 187 s från fixet).
    expect(warnings[0].atS).toBe(LAST_S + 210);
    // BRISEN höll 2,4 kn till Järnvägsbron och 4,2 kn efter den. Varningen ska
    // ligga minst 60 s före (C-IV:s golv); c14938f varnade 702 s in.
    const fixS = LAST_S - 9;
    const arrivalS = fixS + toJvb(459) / (2.4 * KN) + (459 - toJvb(459)) / (4.2 * KN);
    expect(arrivalS - warnings[0].atS).toBeGreaterThanOrEqual(60);
  });

  // Granskarens prob A och A2: båten kryper i 2,5 kn och hörs var 65–69:e
  // sekund. Sista rörliga fixet ligger 709 m före Stridsbergsbron (453 m före
  // Järnvägsbron). Under 2 kn sänder klass B var 3:e minut, så nästa fix kommer
  // 204 respektive 269 s senare (värld 29), i kön vid Järnvägsbron. Efter kön
  // går hon vidare, och c14938f varnar på fixet 300 m före bron.
  const KO_APPROACH = [[0, 1207, 2.4], [66, 1146, 2.4], [132, 1063, 2.7], [201, 946, 2.6], [269, 903, 2.6],
    [334, 778, 2.3], [400, 709, 2.5, { fixAgeS: 13 }]];
  test.each([
    ['204 s', [queued(604, 430, 590), queued(808, 431, 590), queued(1012, 431, 590), queued(1216, 430, 590),
      [1290, 400, 2.6], [1356, 300, 3.0], [1422, 200, 3.5], [1488, 90, 4.0]], 1356],
    ['269 s', [queued(669, 428, 600), queued(873, 431, 600), queued(1077, 431, 600),
      [1150, 400, 2.6], [1216, 300, 3.0], [1282, 200, 3.5], [1348, 90, 4.0]], 1216],
  ])('en kö som börjar under tystnaden varnas inte tidigare än på c14938f (glapp %s)', (_label, rest, expectedS) => {
    const withRule = make();
    const without = make(C14938F);
    const [a, b] = play([...KO_APPROACH, ...rest], expectedS + 300, [withRule, without]);
    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ atS: expectedS, firedBy: 'fix' });
  });

  // Omgranskningen av familj D: kö NÄRA Järnvägsbron. Sista rörliga fixet
  // ligger e m före Järnvägsbron (e + 257 m före Stridsbergsbron), i
  // AISHub-takt 65–69 s och 5 s gammalt. Nästa fix kommer `gap` s senare i kön
  // 120 m före Järnvägsbron, sedan var 195:e sekund i 10 min, och därefter går
  // hon vidare. c14938f väntar ut kön och varnar på första fixet efter den.
  // 19e87b5 varnade 180 s efter sista fixet, före köfixet: tystnadsgränsen
  // 180 s låg under AISHub:s mottagning av klass B:s lågfartstakt (tre pollar,
  // 195–210 s). Med glapp 230 s är tystnaden längre än 210 s, och där skyddar
  // villkoret att hon i egen fart först ska ha nått bron (300 m i 2,5 kn: 233 s).
  const nearBridge = (e, sog) => {
    const steps = [66, 69, 65, 67, 68, 66];
    const fixes = [];
    let s = 0;
    let d = e + 257 + steps.reduce((sum, step) => sum + step, 0) * sog * KN;
    for (const step of steps) {
      fixes.push([s, Math.round(d), sog]);
      s += step;
      d -= step * sog * KN;
    }
    fixes.push([s, e + 257, sog, { fixAgeS: 5 }]);
    return { fixes, lastS: s };
  };
  test.each([
    ['202 m, 2,1 kn, glapp 195 s (BRISENs plats)', 202, 2.1, 195],
    ['300 m, 2,5 kn, glapp 195 s', 300, 2.5, 195],
    ['300 m, 2,5 kn, glapp 230 s', 300, 2.5, 230],
  ])('kö nära Järnvägsbron efter tystnad (%s): samma varning som c14938f, efter kön', (_label, e, sog, gap) => {
    const { fixes, lastS } = nearBridge(e, sog);
    const queueD = 257 + 120;
    const queue = [0, 1, 2, 3].map((k) => queued(lastS + gap + 195 * k, queueD, lastS + gap - 60));
    const onwardS = lastS + gap + 3 * 195;
    const onward = [[onwardS + 66, queueD - 60, 2.6], [onwardS + 132, 200, 3.5], [onwardS + 198, 80, 4.0]];
    const withRule = make();
    const without = make(C14938F);
    const [a, b] = play([...fixes, ...queue, ...onward], onwardS + 300, [withRule, without]);
    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ atS: onwardS + 66, firedBy: 'fix' });
  });

  test('en vändning under tystnaden ger ingen varning (värld 1089)', () => {
    // LINNEA: sista norrgående fixet 746 m före Stridsbergsbron i 3,1 kn, nästa
    // fix 201 s senare söderut efter vändningen. Appen har då vänt riktningen.
    const approach = [[0, 1114, 2.7], [65, 1013, 3.0], [133, 920, 2.8], [202, 840, 2.6], [269, 746, 3.1]];
    const turned = [[470, 843, 3.8, { cog: 209, _routeDirection: 'south' }]];
    const withRule = make();
    const without = make(C14938F);
    const [a, b] = play([...approach, ...turned], 900, [withRule, without]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });

  test.each([
    ['kursen i sista fixet leder bort från bron', { cog: 214 }],
    ['en vändning väntar på bekräftelse', { _fixDPendingReversal: { dir: 'south', time: START + 466000 } }],
  ])('%s: ingen tidigareläggning på rask fart', (_label, extra) => {
    const fixes = APPROACH.map(([s, d, sog, e]) => (s === LAST_S ? [s, d, sog, { ...e, ...extra }] : [s, d, sog, e]));
    const withRule = make();
    const without = make(C14938F);
    const [a, b] = play(fixes, LAST_S + 400, [withRule, without]);
    expect(a).toEqual(b);
    // Spärren gäller som på c14938f: ankare + 459 m / 2,1 kn − 180 s.
    expect(a[0].atS).toBeGreaterThan(LAST_S + 180);
  });

  test.each([
    ['hörs som vanligt', [[531, 380, 2.4], [596, 300, 2.4], [661, 220, 2.4]], false],
    ['4 kn eller fortare', [], true],
  ])('%s: samma varning som c14938f', (_label, more, fast) => {
    const fixes = fast ? APPROACH.map(([s, d, , extra]) => [s, d, 4.2, extra]) : [...APPROACH, ...more];
    const withRule = make();
    const without = make(C14938F);
    const [a, b] = play(fixes, 900, [withRule, without]);
    expect(a).toHaveLength(1);
    expect(a).toEqual(b);
  });

  test('en kö som var bekräftad i senaste fixet behåller femminutersgränsen i tystnad', () => {
    const fixes = [...APPROACH.slice(0, 6), queued(400, 470, 280), queued(466, 469, 280)];
    const withRule = make();
    const without = make(C14938F);
    const [a, b] = play(fixes, LAST_S + 400, [withRule, without]);
    const arm = withRule.service._arms.get(`${MMSI}::${TARGET}`);
    expect(arm.waitingAtBridge).toBe('Järnvägsbron');
    expect(a).toHaveLength(1);
    expect(a).toEqual(b);
  });

  test('utan två intervall finns ingen kadens: spärren räknar som förut', () => {
    const withRule = make();
    const without = make(C14938F);
    const [a, b] = play([[0, 556, 2.4], [66, 459, 2.1, { fixAgeS: 9 }]], 66 + 300, [withRule, without]);
    const arm = withRule.service._arms.get(`${MMSI}::${TARGET}`);
    if (arm) {
      const expectedHold = arm.anchorMs + Math.min(300000, (arm.distanceM / (2.1 * KN)) * 1000 - LEAD_MS);
      expect(arm.earlierBridgeUntilMs).toBeCloseTo(expectedHold, 3);
    }
    expect(a).toHaveLength(1);
    expect(a).toEqual(b);
  });
});

describe('Motorns världar genom hela kedjan (replayRunner, frusna fixturer)', () => {
  // Raderna är buggjägarens världar (bas-seed 1, R1), frysta byte för byte;
  // sha256 för varje fil är världens radhash. Sanningen (L0) står i testet.
  const RUNNER = path.join(__dirname, 'replay-validation/replayRunner.js');
  function replay(fixture, monitoring) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd-sparr-'));
    try {
      const env = { ...process.env, TMPDIR: dir, NODE_OPTIONS: '' };
      for (const key of Object.keys(env)) if (key.startsWith('REPLAY_')) delete env[key];
      if (monitoring) env.REPLAY_MONITORING = '1';
      const out = execFileSync(process.execPath, [RUNNER, path.join(__dirname, 'fixtures', fixture)], {
        env, cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
      return JSON.parse(/__REPLAY_JSON__([\s\S]*?)__END__/.exec(out)[1]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // Första täckningen (egen varning eller absorption) för båten vid Stridsbergsbron.
  const firstCover = (result, mmsi) => Math.min(...(result.openingCoverage || [])
    .filter((c) => c.bridge === TARGET && String(c.mmsi) === mmsi).map((c) => c.t));

  // Värld 263 (kortet F02-w263-Strid, radhash ac679ea4fa2c…): BRISEN korsar
  // Stridsbergsbron norrut 15:07:45,239 i 4,18 kn. Monitoringvärld i motorn.
  test.each([true, false])('värld 263: BRISEN varnas minst 60 s före korsningen (monitoring=%s)', (monitoring) => {
    const crossingMs = 1786288065238.8809;
    const result = replay('d-w263-brisen-sparr-tystnad.jsonl', monitoring);
    const covering = result.openingWarnings
      .filter((w) => w.bridge === TARGET && w.mmsis.includes(MMSI) && w.t < crossingMs)
      .pop();
    expect(covering).toBeDefined();
    // c14938f: 15:07:00,824 (spärrens slut på 2,1 kn), 44 s före korsningen.
    expect(crossingMs - covering.t).toBeGreaterThanOrEqual(60000);
  }, 60000);

  // Värld 29 (radhash ac13821b9417…): RUNA 265639400 kryper i 2,5 kn, tystnar
  // 269 s 453 m före Järnvägsbron och köar där 18:22:34–18:32:55. c14938f
  // varnar 18:34:13, efter kön; den förkastade TYST-GOLV varnade 18:21:27, före kön.
  // Värld 1767 (radhash 9555c5b3273f…, aisstream, monitoring): MASEN 265478550
  // tystnar 192 s 471 m före Järnvägsbron och köar där 14:00:51–14:09:56.
  // c14938f varnar 14:09:14; TYST-GOLV varnade 14:00:25.
  test.each([
    ['d-w29-runa-ko-under-tystnad.jsonl', false, '265639400', 1783707754000],
    ['d-w1767-masen-ko-under-tystnad.jsonl', true, '265478550', 1789048851000],
  ])('%s: en kö som börjar under tystnaden varnas inte före kön', (fixture, monitoring, mmsi, queueStartMs) => {
    const result = replay(fixture, monitoring);
    expect(firstCover(result, mmsi)).toBeGreaterThanOrEqual(queueStartMs);
  }, 60000);

  // Omgranskningen av familj D: värld 1511 (radhash c239b285bb5d…, R1,
  // monitoring) med en tillagd AISHub-rad 09:20:16,911 mitt i en missad poll;
  // sanningen är densamma. DAGNY 265252653 hörs då var 67–69:e sekund, sänder
  // sista rörliga fixet 09:24:50 i 2,4 kn 372 m före Järnvägsbron och nästa
  // 268,6 s senare, 09:29:18, i kön där hon står 09:27:11–09:46:11. Hon korsar
  // Stridsbergsbron 09:50:45. c14938f varnar 09:45:59, 286 s före; 19e87b5
  // varnade 09:28:51, före köfixet och 22 min före korsningen. Hon når
  // Järnvägsbron i egen fart först efter 372 m / 2,4 kn = 301 s, så spärren
  // står kvar tills köfixet kommer.
  test.each([true, false])('värld 1511 med en poll till: en kö nära Järnvägsbron varnas inte innan appen hört kön (monitoring=%s)', (monitoring) => {
    const firstQueueFixMs = Date.parse('2026-07-10T09:29:18.665Z');
    const result = replay('d-w1511-dagny-ko-nara-bron.jsonl', monitoring);
    expect(firstCover(result, '265252653')).toBeGreaterThanOrEqual(firstQueueFixMs);
  }, 60000);

  // Värld 1089 (radhash 4d42a3a6fc62…): LINNEA 265411070 vänder 07:18:45 i
  // tystnaden och korsar aldrig Stridsbergsbron. TYST-GOLV gav henne en
  // fantomvarning (Stridsbergsbron#15 07:20:22); c14938f ingen.
  test('värld 1089: en vändning under tystnaden ger ingen varning för Stridsbergsbron', () => {
    const result = replay('d-w1089-linnea-vandning-under-tystnad.jsonl', false);
    const own = result.openingWarnings.filter((w) => w.bridge === TARGET && w.mmsis.includes('265411070'));
    expect(own).toEqual([]);
  }, 60000);
});
