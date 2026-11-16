'use strict';

/**
 * FARTÖKNINGEN FÖRE EN NÄRA BRO EMELLAN — ETT FALL PER VILLKOR (sparr,
 * 2026-11-16; granskningen SPARR-d2, M1).
 *
 * BridgeOpeningService#_accelBeforeNearEarlier: ett nytt fix högst 400 m före
 * Järnvägsbron, efter två föregående nya fix i minst 1 kn, med minst 0,8 kn
 * ökning mot fixet före det förra och minst 0,3 kn mot det förra, i minst 2,8 kn
 * (fartgolvet, omgranskningen R2), varje steg högst 240 s, kurs mot bron och
 * ingen väntande vändning, ger spärrens restid i
 * max(fart, 5 kn). Varje villkor har här ett fall som fäller sin mutation:
 * tjänsten med regeln jämförs med samma tjänst där regeln är avstängd
 * (EARLIER_BRIDGE_ACCEL_BAND_M −1). "Utlöser" betyder att varningen kommer
 * tidigare än utan regeln; "utlöser inte" att den kommer exakt som utan.
 *
 * Kortets siffra (U28): när regeln förkortade spärren säger kortet den lägsta
 * av ETA-kedjans värde och regelns restid, uppåt till hel minut.
 */

const Service = require('../lib/services/BridgeOpeningService');
const { BRIDGES } = require('../lib/constants');
const { calculateDistance } = require('../lib/utils/geometry');

const START = Date.parse('2026-08-09T14:55:00Z');
const MMSI = '265000001';
const KLAFF = BRIDGES.klaffbron;
const JVB = BRIDGES.jarnvagsbron;
const STRID = BRIDGES.stridsbergsbron;
const SPAN = calculateDistance(KLAFF.lat, KLAFF.lon, STRID.lat, STRID.lon);
const OFF = { EARLIER_BRIDGE_ACCEL_BAND_M: -1 };

// En punkt d meter före Stridsbergsbron på linjen Klaffbron–Stridsbergsbron.
const along = (d) => ({
  lat: STRID.lat + (KLAFF.lat - STRID.lat) * (d / SPAN),
  lon: STRID.lon + (KLAFF.lon - STRID.lon) * (d / SPAN),
});
const toJvb = (d) => {
  const p = along(d);
  return calculateDistance(p.lat, p.lon, JVB.lat, JVB.lon);
};
// d (från Stridsbergsbron) som ligger `m` meter före Järnvägsbron.
const beforeJvb = (m) => {
  let lo = 260;
  let hi = 1400;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (toJvb(mid) < m) lo = mid; else hi = mid;
  }
  return lo;
};

describe('fartökningsregeln: ett fall per villkor', () => {
  const services = [];
  const make = (config, target = 'Stridsbergsbron') => {
    const warnings = [];
    const service = new Service({ onWarning: (w) => warnings.push(w), targetBridges: [target], config });
    services.push(service);
    return { service, warnings };
  };
  const boat = (pos, sog, extra = {}) => ({
    mmsi: MMSI,
    name: 'VILLKOR',
    ...pos,
    sog,
    cog: 34,
    targetBridge: 'Stridsbergsbron',
    _routeDirection: 'north',
    _hasMovementProof: true,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now() - (extra.fixAgeS || 0) * 1000,
    fixFeed: 'aishub',
    etaMinutes: null,
    status: 'en-route',
    passedBridges: ['Klaffbron'],
    ...extra,
  });
  // fixes: [s, pos, sog, extra]; returnerar första varningens sekund eller null.
  const play = (fixes, runs, untilS = 900) => {
    const sorted = [...fixes].sort((a, b) => a[0] - b[0]);
    let next = 0;
    for (let s = 0; s <= untilS; s++) {
      while (next < sorted.length && sorted[next][0] <= s) {
        const [fs0, pos, sog, extra] = sorted[next++];
        jest.setSystemTime(START + fs0 * 1000);
        for (const { service } of runs) service.observeVessel(boat(pos, sog, extra));
      }
      jest.setSystemTime(START + s * 1000);
      for (const { service } of runs) service.tick();
    }
    return runs.map(({ warnings }) => (warnings.length ? (warnings[0].t - START) / 1000 : null));
  };
  // Tre fix 65 s isär som slutar `endM` före Järnvägsbron, i farterna `sogs`.
  const three = (endM, sogs, { gaps = [65, 65], extra3 = {} } = {}) => {
    const d3 = beforeJvb(endM);
    const t2 = gaps[1];
    const t1 = gaps[0] + t2;
    return [
      [0, along(d3 + t1 * sogs[0] * 0.5144), sogs[0]],
      [gaps[0], along(d3 + t2 * sogs[1] * 0.5144), sogs[1]],
      [gaps[0] + gaps[1], along(d3), sogs[2], extra3],
    ];
  };
  const compare = (fixes, target) => {
    const on = make(undefined, target);
    const off = make(OFF, target);
    return play(fixes, [on, off]);
  };

  beforeEach(() => jest.useFakeTimers({ now: START }));
  afterEach(() => {
    while (services.length) services.pop().destroy();
    jest.useRealTimers();
  });

  test('basfallet: ökning i gång 2,0 → 2,5 → 3,2 kn 300 m före Järnvägsbron utlöser', () => {
    const [on, off] = compare(three(300, [2.0, 2.5, 3.2]));
    expect(on).toBeLessThan(off);
  });

  test.each([[390, true], [410, false]])('bandet 400 m: fixet %d m före Järnvägsbron utlöser=%s', (m, fires) => {
    const [on, off] = compare(three(m, [2.0, 2.5, 3.2]));
    if (fires) expect(on).toBeLessThan(off); else expect(on).toBe(off);
  });

  test.each([[0.9, false], [1.1, true]])('i gång: fixet före det förra i %d kn utlöser=%s', (v, fires) => {
    const [on, off] = compare(three(300, [v, 2.1, 2.9]));
    if (fires) expect(on).toBeLessThan(off); else expect(on).toBe(off);
  });

  test.each([[0.9, false], [1.1, true]])('i gång: det förra fixet i %d kn utlöser=%s', (v, fires) => {
    const [on, off] = compare(three(300, [1.6, v, 2.9]));
    if (fires) expect(on).toBeLessThan(off); else expect(on).toBe(off);
  });

  test.each([[[2.0, 2.9, 3.1], false], [[2.0, 2.6, 3.0], true]])('steget mot det förra (≥ 0,3 kn): %j utlöser=%s', (sogs, fires) => {
    const [on, off] = compare(three(300, sogs));
    if (fires) expect(on).toBeLessThan(off); else expect(on).toBe(off);
  });

  test.each([[[2.3, 2.6, 3.0], false], [[2.2, 2.6, 3.1], true]])('ökningen över två fix (≥ 0,8 kn): %j utlöser=%s', (sogs, fires) => {
    const [on, off] = compare(three(300, sogs));
    if (fires) expect(on).toBeLessThan(off); else expect(on).toBe(off);
  });

  test.each([[[1.8, 2.2, 2.6], false], [[2.0, 2.4, 2.9], true]])('fartgolvet 2,8 kn: %j utlöser=%s', (sogs, fires) => {
    const [on, off] = compare(three(300, sogs));
    if (fires) expect(on).toBeLessThan(off); else expect(on).toBe(off);
  });

  test.each([
    ['förra steget 250 s', [65, 250], false],
    ['steget före det 250 s', [250, 65], false],
    ['båda stegen 230 s', [230, 230], true],
  ])('ålder: %s utlöser=%s', (_label, gaps, fires) => {
    const [on, off] = compare(three(300, [2.0, 2.5, 3.2], { gaps }));
    if (fires) expect(on).toBeLessThan(off); else expect(on).toBe(off);
  });

  test('kursen bort från bron i fixet utlöser inte', () => {
    const [on, off] = compare(three(300, [2.0, 2.5, 3.2], { extra3: { cog: 214 } }));
    expect(on).toBe(off);
  });

  test('en väntande vändning utlöser inte', () => {
    const [on, off] = compare(three(300, [2.0, 2.5, 3.2], { extra3: { _fixDPendingReversal: true } }));
    expect(on).toBe(off);
  });

  test('ett äldre fix som levereras sent är inget nytt fix och utlöser inte', () => {
    const fixes = three(300, [2.0, 2.5, 3.2]);
    // Det sista fixet ersätts av ett fix vars fixtid ligger FÖRE det förra.
    const [, second] = fixes;
    const late = [second[0] + 10, fixes[2][1], 3.4, { fixAgeS: 30 }];
    const [on, off] = compare([fixes[0], second, late]);
    expect(on).toBe(off);
  });

  test('söderut mot Klaffbron (Järnvägsbron 963 m före, ingen nära bro) utlöser inte', () => {
    // Båten går söderut 300–150 m norr om Järnvägsbron mot Klaffbron.
    const spanJK = calculateDistance(JVB.lat, JVB.lon, KLAFF.lat, KLAFF.lon);
    const southOfJvb = (m) => ({
      lat: JVB.lat + (JVB.lat - KLAFF.lat) * (m / spanJK),
      lon: JVB.lon + (JVB.lon - KLAFF.lon) * (m / spanJK),
    });
    const south = (m, sog) => ({
      ...southOfJvb(m), sog, cog: 214, targetBridge: 'Klaffbron', _routeDirection: 'south', passedBridges: ['Stridsbergsbron'],
    });
    const fixes = [
      [0, null, 2.0, south(300, 2.0)],
      [65, null, 2.5, south(230, 2.5)],
      [130, null, 3.2, south(150, 3.2)],
    ].map(([s, , sog, extra]) => [s, { lat: extra.lat, lon: extra.lon }, sog, extra]);
    const [on, off] = compare(fixes, 'Klaffbron');
    expect(off).not.toBeNull();
    expect(on).toBe(off);
  });

  describe('regelns ankomst på armen (kortets underlag)', () => {
    const armOf = (run) => [...run.service._arms.values()].find((a) => a.mmsi === MMSI);

    test('sätts när regeln förkortar spärren och nollas av nästa nya fix utan regeln', () => {
      const run = make();
      const fixes = three(300, [2.0, 2.5, 3.2]);
      play(fixes, [run], 130);
      expect(Number.isFinite(armOf(run).accelArrivalMs)).toBe(true);
      play([[131, along(beforeJvb(290)), 3.2]], [run], 131);
      expect(armOf(run).accelArrivalMs).toBeNull();
    });

    test('sätts inte när fixets fart redan är minst 5 kn (regeln förkortar inget)', () => {
      const run = make();
      play(three(300, [4.0, 4.7, 5.5]), [run], 130);
      expect(armOf(run).accelArrivalMs).toBeNull();
    });
  });

  describe('kortets siffra', () => {
    const now = START + 600000;
    const lead = (extra) => ({
      mmsi: MMSI,
      distanceM: 500,
      rawAnchorMs: now - 5000,
      waitingAtBridge: null,
      earlierBridge: 'Järnvägsbron',
      ...extra,
    });
    test('regelns restid uppåt till hel minut när den är lägre än kedjan', () => {
      const { service } = make();
      const info = service._warningLeadInfo([lead({ expectedArrivalMs: now + 6 * 60000, accelArrivalMs: now + 2.3 * 60000 })], now);
      expect(info.etaMinutes).toBe(3);
    });
    test('en hel minut med flyttalsbrus blir inte en minut för mycket', () => {
      const { service } = make();
      const info = service._warningLeadInfo([lead({ expectedArrivalMs: now + 6 * 60000, accelArrivalMs: now + 180000.003 })], now);
      expect(info.etaMinutes).toBe(3);
    });
    test('aldrig högre än kedjan', () => {
      const { service } = make();
      const info = service._warningLeadInfo([lead({ expectedArrivalMs: now + 2 * 60000, accelArrivalMs: now + 2.3 * 60000 })], now);
      expect(info.etaMinutes).toBe(2);
    });
    test('utan regelns ankomst gäller kedjan som förut', () => {
      const { service } = make();
      const info = service._warningLeadInfo([lead({ expectedArrivalMs: now + 6.2 * 60000, accelArrivalMs: null })], now);
      expect(info.etaMinutes).toBe(6);
    });
  });
});
