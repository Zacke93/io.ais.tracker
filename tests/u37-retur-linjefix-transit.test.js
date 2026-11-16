'use strict';

/**
 * U37 del 1 (dirigentens beslut 2026-11-16 på ägarens uppdrag, fråga F25):
 * RETURPASSAGEN SLÄPPS VID LINJEFIXEN I TRANSITFART, OCKSÅ VID TÄT KADENS.
 *
 * Nattjaktens F15 (värld 16704, R1, aisstream klass A): LINNEA 2 passerar
 * Klaffbron norrut 01:09:51, vänder 176 m norr om bron och passerar den söderut
 * 01:13:14. Fixen 01:12:59 ligger 35 m norr om linjen och fixen 01:13:23 26 m
 * söder om den (5,8 kn, segment 24 s); appen bokför målbropassagen i den fixen.
 * U14 krävde 30 m ut vid tät kadens, och nästa fix kom först 01:20:24, 1,2 km
 * bort. Då kom "har precis passerat Klaffbron" samtidigt med "närmar sig
 * Olidebron", 7 min 10 s efter korsningen.
 *
 * Rättningen (TriggerPointVisitTracker.releaseReturnPassage, villkor 7d):
 * korsningsfixen räcker vid vilken kadens som helst när båten går i
 * transitfart (≥ 3,13 kn) mot ankomstsidan, korsningen är noterad i just den
 * fixen, föregående fix låg entydigt på bortre sidan och bokföringen hör till
 * segmentet. Testerna nedan låser motfallen: en båt som stannar på linjen,
 * guppar, driver, vänder, får en osäker position eller saknar ny bokföring.
 */

jest.mock('homey');

const path = require('path');
const { execFileSync } = require('child_process');
const TriggerPointVisitTracker = require('../lib/services/TriggerPointVisitTracker');
const geometry = require('../lib/utils/geometry');
const { BRIDGES } = require('../lib/constants');
const { validateInvariants } = require('./replay-validation/invariants');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const MMSI = '265181647';
const LIMITS = { maxBookingAgeMs: 15000, maxLatenessMs: 10 * 60 * 1000, sparseFixGapMs: 30000 };
const CONFIRM = { ...LIMITS, maxBookingAgeMs: Infinity };

// Position `offsetM` meter från brons linje längs normalen (+ = nordöstra sidan),
// samma projektion som geometry.bridgeLineOffsetM.
const posAt = (bridge, offsetM) => {
  const normal = (((bridge.axisBearing || 125) - 90) * Math.PI) / 180;
  return {
    lat: bridge.lat + (offsetM * Math.cos(normal)) / 111320,
    lon: bridge.lon + (offsetM * Math.sin(normal)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180)),
  };
};
// Kurs längs normalen mot den sida som har tecknet `sign`.
const cogToward = (bridge, sign) => (((bridge.axisBearing || 125) - 90 + (sign > 0 ? 0 : 180)) + 360) % 360;

/**
 * Ett besök vid en bro: förvarning, utpassage åt `first`, vändning bortom
 * bron och tillbaka mot linjen. Returnerar hjälpfunktioner för returfixarna.
 */
function visit(bridge, first) {
  let now = Date.parse('2026-08-17T01:05:00Z');
  const tracker = new TriggerPointVisitTracker({ now: () => now });
  const far = first === 'north' ? 1 : -1;
  const back = first === 'north' ? 'south' : 'north';
  const at = (offsetM, extra = {}) => ({
    mmsi: MMSI,
    ...posAt(bridge, far * offsetM),
    sog: 5.8,
    cog: cogToward(bridge, -far),
    _routeDirection: back,
    timestamp: now,
    lastPositionUpdate: now,
    fixTs: now,
    fixFeed: 'aisstream',
    ...extra,
  });
  const observe = (offsetM, extra = {}, seconds = 10) => {
    now += seconds * 1000;
    const vessel = at(offsetM, typeof extra === 'function' ? extra() : extra);
    tracker.observe(vessel, bridge.name);
    return vessel;
  };
  const booked = () => ({ lastPassedBridge: bridge.name, lastPassedBridgeTime: now });
  const outward = { _routeDirection: first, cog: cogToward(bridge, far) };
  // Förvarningen 200 m före bron (bortre sidan blir `far`).
  expect(tracker.reserve(at(-200, outward), bridge.name)).not.toBeNull();
  now += 10000;
  const outAt = now;
  const passed = { lastPassedBridge: bridge.name, lastPassedBridgeTime: outAt, passedBridges: [bridge.name] };
  tracker.observe(at(5, { ...outward, ...passed }), bridge.name);
  observe(60, { ...outward, ...passed }, 15);
  observe(170, { ...outward, ...passed }, 20);
  // Vändningen bortom bron: ruttriktningen är bekräftat vänd.
  observe(120, passed, 20);
  return {
    tracker,
    far,
    observe,
    booked,
    passed,
    release: (vessel, limits = LIMITS) => tracker.releaseReturnPassage(vessel, bridge.name, limits),
    holds: () => tracker.holds(MMSI, bridge.name),
    now: () => now,
  };
}

const CASES = [];
for (const bridge of Object.values(BRIDGES)) {
  for (const first of ['north', 'south']) CASES.push([bridge.name, first, bridge]);
}

describe('U37 del 1: korsningsfixen i transitfart släpper returen vid tät kadens', () => {
  test.each(CASES)('%s, utpassage %s: korsningsfixen 26 m ut i 5,8 kn släpper (F15)', (_name, first, bridge) => {
    const v = visit(bridge, first);
    v.observe(35, v.passed, 15);
    const crossing = v.observe(-26, v.booked, 24);
    const result = v.release(crossing);
    expect(result).toMatchObject({ evidence: 'linje-transit', farSign: v.far });
    expect(result.latenessMs).toBeLessThan(15000);
    expect(v.holds()).toBe(false);
  });

  test.each(CASES)('%s, utpassage %s: korsningsfixen 12 m bortom linjen i 3,2 kn släpper', (_name, first, bridge) => {
    const v = visit(bridge, first);
    v.observe(25, v.passed, 15);
    const crossing = v.observe(-12, () => ({ ...v.booked(), sog: 3.2 }), 15);
    expect(v.release(crossing)).toMatchObject({ evidence: 'linje-transit' });
  });

  test.each(CASES)('%s, utpassage %s: korsningsfixen PÅ linjen (3 m bortom) väntar på nästa fix', (_name, first, bridge) => {
    // Motfallssvepet: en båt som bromsar mot linjen i 3,25 kn och stannar eller
    // vänder 3–8 m förbi den gav falska returer. Inom ±10 m avgör nästa fix.
    const v = visit(bridge, first);
    v.observe(25, v.passed, 15);
    const crossing = v.observe(-3, () => ({ ...v.booked(), sog: 3.2 }), 15);
    expect(v.release(crossing)).toBeNull();
    const bookedAt = crossing.lastPassedBridgeTime;
    const back = v.observe(6, { lastPassedBridge: bridge.name, lastPassedBridgeTime: bookedAt, sog: 1.0 }, 15);
    expect(v.release(back, CONFIRM)).toBeNull();
    expect(v.holds()).toBe(true);
  });

  test.each(CASES)('%s, utpassage %s: samma läge i 3,0 kn väntar på nästa fix (under transitfart)', (_name, first, bridge) => {
    const v = visit(bridge, first);
    v.observe(35, v.passed, 15);
    const crossing = v.observe(-26, () => ({ ...v.booked(), sog: 3.0 }), 24);
    expect(v.release(crossing)).toBeNull();
    expect(v.release(crossing, CONFIRM)).toBeNull();
    expect(v.holds()).toBe(true);
    // En verklig retur bevisas av nästa fix längre ut, som förut (7a).
    const bookedAt = crossing.lastPassedBridgeTime;
    const next = v.observe(-60, { lastPassedBridge: bridge.name, lastPassedBridgeTime: bookedAt, sog: 3.0 }, 15);
    expect(v.release(next, CONFIRM)).toMatchObject({ evidence: 'ankomstsidan' });
  });

  test.each(CASES)('%s, utpassage %s: båt som stannar på linjen med en bokföring släpps inte', (_name, first, bridge) => {
    const v = visit(bridge, first);
    v.observe(40, () => ({ ...v.passed, sog: 2.5 }), 15);
    v.observe(15, () => ({ ...v.passed, sog: 1.2 }), 15);
    // Passagelogiken bokför bron när bruset lägger henne över linjen.
    const onLine = v.observe(-4, () => ({ ...v.booked(), sog: 0.3, cog: 300 }), 15);
    expect(v.release(onLine)).toBeNull();
    for (const offsetM of [3, -6, 8, -2, 5, -9]) {
      const still = v.observe(offsetM, {
        lastPassedBridge: bridge.name, lastPassedBridgeTime: onLine.lastPassedBridgeTime, sog: 0.2, cog: (offsetM * 47 + 360) % 360,
      }, 15);
      expect(v.release(still, CONFIRM)).toBeNull();
    }
    expect(v.holds()).toBe(true);
  });
});

describe('U37 del 1: motfallen', () => {
  const KLAFF = BRIDGES.klaffbron;
  const STALL = BRIDGES.stallbackabron;

  test.each([
    ['kursen pekar mot bortre sidan (vänder tillbaka)', (v, b) => ({ cog: cogToward(b, v.far) })],
    ['ruttriktningen är inte vänd', (v) => ({ _routeDirection: v.far > 0 ? 'north' : 'south' })],
    ['ruttriktning saknas', () => ({ _routeDirection: null })],
    ['GPS-osäker position (utliggare)', () => ({ _positionUncertain: true })],
    ['GPS-hopp flaggat', () => ({ _gpsJumpDetected: true })],
    ['fart saknas i rapporten', () => ({ sog: null })],
  ])('%s: inget släpp på korsningsfixen', (_label, variant) => {
    for (const bridge of [KLAFF, STALL]) {
      const v = visit(bridge, 'south');
      v.observe(35, v.passed, 15);
      const crossing = v.observe(-26, () => ({ ...v.booked(), ...variant(v, bridge) }), 24);
      expect(v.release(crossing)).toBeNull();
      expect(v.release(crossing, CONFIRM)).toBeNull();
    }
  });

  test('ingen ny bokföring i segmentet (bara utpassagens stämpel): inget släpp', () => {
    const v = visit(KLAFF, 'north');
    v.observe(35, v.passed, 15);
    const crossing = v.observe(-26, v.passed, 24);
    expect(v.release(crossing)).toBeNull();
    expect(v.release(crossing, CONFIRM)).toBeNull();
  });

  test('bokföringen gjordes före korsningssegmentet (väntan vid linjen): korsningsfixen räcker inte', () => {
    const v = visit(KLAFF, 'north');
    v.observe(30, () => ({ ...v.passed, sog: 1.0 }), 15);
    const early = v.observe(6, () => ({ ...v.booked(), sog: 0.6 }), 15);
    const bookedEarly = { lastPassedBridge: KLAFF.name, lastPassedBridgeTime: early.lastPassedBridgeTime };
    v.observe(4, { ...bookedEarly, sog: 0.4 }, 60);
    const crossing = v.observe(-20, { ...bookedEarly, sog: 4 }, 15);
    expect(v.release(crossing, CONFIRM)).toBeNull();
  });

  test('föregående fix låg på linjen, inte entydigt bortom den: inget släpp', () => {
    const v = visit(KLAFF, 'south');
    v.observe(6, v.passed, 15);
    const crossing = v.observe(-20, v.booked, 10);
    expect(v.release(crossing)).toBeNull();
  });

  test('fixen FÖRE linjen (5 m på bortre sidan) i 4 kn: släpps bara vid gles kadens (7c)', () => {
    const dense = visit(KLAFF, 'south');
    dense.observe(40, dense.passed, 10);
    const denseLine = dense.observe(5, () => ({ ...dense.booked(), sog: 4 }), 10);
    expect(dense.release(denseLine)).toBeNull();
    const sparse = visit(KLAFF, 'south');
    sparse.observe(130, sparse.passed, 65);
    const sparseLine = sparse.observe(5, () => ({ ...sparse.booked(), sog: 4 }), 65);
    expect(sparse.release(sparseLine)).toMatchObject({ evidence: 'gles-linje-transit' });
  });

  test('andra fixen på ankomstsidan (inte korsningsfixen) inom 30 m: inget släpp på d', () => {
    const v = visit(KLAFF, 'south');
    v.observe(35, v.passed, 15);
    const first = v.observe(-12, () => ({ ...v.passed, sog: 1.5 }), 15);
    expect(v.release(first)).toBeNull();
    const second = v.observe(-22, v.booked, 15);
    expect(v.release(second)).toBeNull();
  });

  test('guppar ±30 m på linjen i upp till 1,5 kn med bokföringar: aldrig något släpp', () => {
    const v = visit(KLAFF, 'north');
    v.observe(40, () => ({ ...v.passed, sog: 2 }), 15);
    const offsets = [12, -14, 25, -28, 3, 18, -22, 9, -30, 27, -11, 16, -26, 4, 29, -17];
    offsets.forEach((offsetM, i) => {
      const extra = i % 3 === 0 ? v.booked() : {};
      const vessel = v.observe(offsetM, { ...extra, sog: 0.3 + (i % 5) * 0.3, cog: (i * 83) % 360 }, 15);
      expect(v.release(vessel, CONFIRM)).toBeNull();
    });
    expect(v.holds()).toBe(true);
  });

  test('vänder först efter linjen: korsningsfixen släpper (passagen tillbaka har skett)', () => {
    // Ett känt pris: en båt som är förbi linjen i över 3 kn med kursen mot
    // ankomstsidan, och SEDAN vänder, har korsat bron. Returnotisen gäller en
    // verklig passage.
    const v = visit(KLAFF, 'north');
    v.observe(30, v.passed, 15);
    const crossing = v.observe(-15, () => ({ ...v.booked(), sog: 3.5 }), 15);
    expect(v.release(crossing)).toMatchObject({ evidence: 'linje-transit' });
    expect(geometry.decisiveBridgeSide(crossing, KLAFF)).toBe(-1);
  });
});

describe('Hela appen på nattjaktens F15 (replay)', () => {
  function replay(file) {
    const env = { ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '' };
    delete env.REPLAY_MONITORING;
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tests/replay-validation/replayRunner.js'), file], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
    });
    return JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
  }
  const iso = (t) => new Date(t).toISOString().slice(11, 19);

  test('LINNEA 2: returnotisen för Klaffbron kommer vid korsningsfixen 01:13:23, inte 01:20:24', () => {
    const result = replay(path.join(FIXTURES, 'n2-f15-linnea2-retur-linjefix.jsonl'));
    const notices = result.notifications.filter((n) => n.mmsi === MMSI && n.bridge === 'Klaffbron');
    expect(notices.map((n) => [iso(n.t), n.direction, n.message])).toEqual([
      ['01:10:09', 'northbound', 'LINNEA 2 har precis passerat Klaffbron'],
      ['01:13:23', 'southbound', 'LINNEA 2 har precis passerat Klaffbron'],
    ]);
    expect(result.visitReturnReleases).toEqual([
      expect.objectContaining({
        mmsi: MMSI, bridge: 'Klaffbron', evidence: 'linje-transit', verdict: 'ankomst',
      }),
    ]);
    expect(validateInvariants(result).filter((v) => /MÅLBRO-NOTIS|NOTIS-DUBBLETT|RETURSLÄPP|INV-11/.test(v))).toEqual([]);
    expect(result.processErrors).toBe(0);
  });
});
