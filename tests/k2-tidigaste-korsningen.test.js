'use strict';

/**
 * DEN TIDIGASTE KORSNINGEN FÖR NYA BÅTAR (nattjaktens kort F02 r3 och F23 r2,
 * triagen 2026-11-16 avsnitt 1b; dirigentens beslut om den enkla varianten)
 * =============================================================================
 * En öppningshändelse täcker en konvoj i ett fönster (CONVOY_WINDOW_MS, U2)
 * räknat från den först BOKFÖRDA korsningen. Korsar två medlemmar osedda och
 * bokförs i omvänd ordning, sväljer fönstret nästa öppning (värld 11777:
 * PELLE korsar Klaffbron 16:26:10 och FREJA 16:30:55 under ett avbrott, FREJA
 * bokförs först, och HAVSORN 2 hörs 16:34:14 och korsar 16:40:24 utan egen
 * varning).
 *
 * Rättningen: händelsen minns sin tidigaste bokförda korsning
 * (earliestCrossingAt, bara bakåt). En NY båt med minst två tick kvar vars
 * ankomst ligger mer än CONVOY_WINDOW_MS efter den räknas inte till händelsen
 * (_belongsToEvent) och får en egen varning. firstPassageAt, referensen,
 * bakkanten, golven, U15 och täckningsslutet är orörda.
 *
 * Geometrin i grundfallet (norrut mot Klaffbron, 5,4 kn ≈ 2,78 m/s):
 *   A (ledare) 900 m T0, 230 m T0+240 s, korsar ≈ T0+324 s
 *   B          1200 m T0, 530 m T0+240 s, korsar ≈ T0+432 s
 *   avbrott; B hörs bortom bron T0+700 s (bokförs FÖRST), A T0+760 s.
 * Gamla fönstret slutar ≈ T0+1032 s (B + 600 s), det tidigaste ≈ T0+924 s.
 *
 * PÅ 03ec89b (före rättningen) är testen märkta [FÄLLER] röda; övriga låser
 * basens utfall eller en känd begränsning.
 */

global.__TEST_MODE__ = true;

const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');

const T0 = 1_700_000_000_000;
const KLAFF = BRIDGES.klaffbron;
const S = 1000;
const W = BRIDGE_OPENING.CONVOY_WINDOW_MS;
const V54 = 5.4 * 0.514444; // m/s
const V5 = 5 * 0.514444;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

/** Position `distanceM` meter från bron längs bäring `bearingDeg` (220 = söder om, 40 = norr om). */
function posAtDistance(bridge, distanceM, bearingDeg) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceM * Math.cos(rad)) / 111320;
  const dLon = (distanceM * Math.sin(rad)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180));
  return { lat: bridge.lat + dLat, lon: bridge.lon + dLon };
}

/** Norrgående båt mot Klaffbron; `bearing` 220 = anflygningssidan, 40 = bortom bron. */
function boat(mmsi, distanceM, sog, overrides = {}) {
  const pos = posAtDistance(KLAFF, distanceM, overrides.bearing ?? 220);
  const now = Date.now();
  return {
    mmsi,
    name: mmsi,
    lat: pos.lat,
    lon: pos.lon,
    sog,
    cog: overrides.cog ?? 40,
    timestamp: now,
    fixTs: now,
    lastPositionUpdate: now,
    targetBridge: 'Klaffbron',
    _routeDirection: 'north',
    _finalTargetDirection: null,
    _hasMovementProof: true,
    _moored: false,
    _stationarySince: null,
    navStatus: null,
    etaMinutes: null,
    passedAt: {},
    passedBridges: [],
  };
}

describe('K2b: nya båtar prövas mot händelsens tidigaste bokförda korsning', () => {
  let logger;
  let warnings;
  let svc;
  let tickTimer;

  const advanceTo = (t) => jest.advanceTimersByTime(t - Date.now());
  const klaff = () => warnings.filter((w) => w.bridge === 'Klaffbron');
  const ownWarnings = (mmsi) => klaff().filter((w) => w.leadMmsi === mmsi);
  const armOf = (mmsi) => svc._arms.get(`${mmsi}::Klaffbron`);
  const eventById = (id) => svc._events.get('Klaffbron').find((e) => e.id === id);
  const debugLines = (tag) => logger.debug.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(tag));

  /** Båten bortom bron vid `atS`, korsade vid `crossS` i farten `v` (m/s). */
  const beyond = (mmsi, atS, crossS, v = V54, sog = 5.4) => {
    advanceTo(T0 + atS * S);
    svc.observeVessel(boat(mmsi, (atS - crossS) * v, sog, { bearing: 40 }));
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    logger = makeLogger();
    warnings = [];
    svc = new BridgeOpeningService({
      logger,
      onWarning: (payload) => warnings.push(payload),
      targetBridges: ['Klaffbron'],
    });
    tickTimer = setInterval(() => svc.tick(), BRIDGE_OPENING.TICK_INTERVAL_MS);
  });

  afterEach(() => {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (svc) svc.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  /**
   * Konvojen A och B (och valfritt D, 1500 m) varnas tillsammans T0; sista
   * fixen före bron T0+240 s; sedan avbrott. Returnerar händelsens id.
   */
  const stageConvoy = ({ withD = false } = {}) => {
    svc.observeVessel(boat('B', 1200, 5.4));
    if (withD) svc.observeVessel(boat('D', 1500, 5.4));
    svc.observeVessel(boat('A', 900, 5.4));
    expect(klaff()).toHaveLength(1);
    const warning = klaff()[0];
    expect(warning.mmsis.map(String).sort()).toEqual(withD ? ['A', 'B', 'D'] : ['A', 'B']);
    advanceTo(T0 + 240 * S);
    svc.observeVessel(boat('B', 1200 - 240 * V54, 5.4));
    if (withD) svc.observeVessel(boat('D', 1500 - 240 * V54, 5.4));
    svc.observeVessel(boat('A', 900 - 240 * V54, 5.4));
    return warning.eventId;
  };
  // Korsningarna enligt geometrin ovan (sekunder från T0).
  const CROSS_A = 240 + (900 - 240 * V54) / V54;
  const CROSS_B = 240 + (1200 - 240 * V54) / V54;
  const CROSS_D = 240 + (1500 - 240 * V54) / V54;

  /** Kör båten `m` från `d0` m före bron vid `tStart`; stannar på `stopM` i `stopS` s. */
  const drive = (m, tStart, d0, stopM, stopS, kn = 5) => {
    const v = kn * 0.514444;
    const out = [];
    let t = tStart;
    let d = d0;
    let stopped = 0;
    for (;;) {
      const stopping = stopS > 0 && d <= stopM + 1e-6 && stopped < stopS;
      out.push([t, m, d, stopping ? 0.1 : kn]);
      if (stopping) {
        stopped += 10;
        t += 10;
      } else if (d - v * 10 <= 0) {
        const c = t + d / v;
        out.push([c + 5, m, -5 * v, kn]);
        return { fixes: out, cross: c };
      } else if (stopS > 0 && d > stopM && d - v * 10 < stopM) {
        t += (d - stopM) / v;
        d = stopM;
      } else {
        d -= v * 10;
        t += 10;
      }
    }
  };
  const play = (fixes) => {
    for (const [t, m, d, sog] of [...fixes].sort((a, b) => a[0] - b[0])) {
      advanceTo(T0 + t * S);
      svc.observeVessel(d < 0 ? boat(m, -d, sog, { bearing: 40 }) : boat(m, d, sog));
    }
  };
  const memberWarnings = (mmsi) => klaff().filter((w) => (w.mmsis || []).map(String).includes(mmsi));

  // ===========================================================================
  // Felet: omvänd bokföring
  // ===========================================================================
  describe('två medlemmar bokförda i omvänd ordning', () => {
    it('[FÄLLER] earliestCrossingAt blir den tidigare korsningen; firstPassageAt, referensen och bokföringen står kvar', () => {
      const id = stageConvoy();
      beyond('B', 700, CROSS_B);
      const event = eventById(id);
      expect(event.firstPassageAt / S - T0 / S).toBeCloseTo(CROSS_B, 0);
      expect(event.earliestCrossingAt ?? null).toBeNull();
      beyond('A', 760, CROSS_A);
      expect(event.earliestCrossingAt / S - T0 / S).toBeCloseTo(CROSS_A, 0);
      expect(event.firstPassageAt / S - T0 / S).toBeCloseTo(CROSS_B, 0);
      expect(event.referenceArrivalMs).toBe(event.firstPassageAt);
      expect(event.firstPassageRegisteredAt).toBe(T0 + 700 * S);
      expect(debugLines('[OPENING_PASSAGE_EARLIER]')).toHaveLength(1);
    });

    it('[FÄLLER] HAVSORN 2-klassen: en ny båt efter den tidigaste korsningen + 600 s får egen varning', () => {
      stageConvoy();
      beyond('B', 700, CROSS_B);
      beyond('A', 760, CROSS_A);
      advanceTo(T0 + 761 * S);
      svc.observeVessel(boat('C', (CROSS_A + 650 - 761) * V5, 5));
      expect(armOf('C').absorbedAt).toBeNull();
      advanceTo(T0 + 800 * S);
      const own = ownWarnings('C');
      expect(own).toHaveLength(1);
      expect(armOf('C').expectedArrivalMs - own[0].t).toBeGreaterThan(2 * BRIDGE_OPENING.TICK_INTERVAL_MS);
    });

    it('KÄND BEGRÄNSNING: en båt som absorberades MELLAN bokföringarna släpps inte (som på basen)', () => {
      // C absorberas T0+730 s i fönstret från B och korsar 650 s efter A
      // (nästa öppning enligt U2). Den tidigare korsningen ändrar bara
      // medlemsprovet för nya båtar; bakkanten mäter henne som förut, och hon
      // får ingen egen varning (basens utfall).
      stageConvoy();
      beyond('B', 700, CROSS_B);
      const C = drive('C', 730, (CROSS_A + 650 - 730) * V5, 0, 0);
      play([...C.fixes.filter((f) => f[0] < 760)]);
      expect(armOf('C').absorbedAt).toBe(T0 + 730 * S);
      beyond('A', 760, CROSS_A);
      play(C.fixes.filter((f) => f[0] > 760));
      expect(armOf('C')).toBeUndefined();
      expect(ownWarnings('C')).toHaveLength(0);
      expect(memberWarnings('C')).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Bandet: nya följare på olika avstånd efter den tidigaste korsningen
  // ===========================================================================
  describe('följarbandet (ny båt T0+761 s, ankomst Δ s efter A:s korsning)', () => {
    // Före rättningen: absorberad upp till Δ ≈ CROSS_B − CROSS_A + 600 ≈ 708 s.
    // Efter: absorberad upp till Δ = 600 s, egen varning därefter.
    const cases = [
      { delta: 540, own: false },
      { delta: 590, own: false },
      { delta: 620, own: true }, // [FÄLLER]
      { delta: 690, own: true }, // [FÄLLER]
      { delta: 720, own: true }, // motfall: bortom båda fönstren
    ];
    it.each(cases)('Δ = $delta s ⇒ egen varning: $own', ({ delta, own }) => {
      stageConvoy();
      beyond('B', 700, CROSS_B);
      beyond('A', 760, CROSS_A);
      advanceTo(T0 + 761 * S);
      svc.observeVessel(boat('C', (CROSS_A + delta - 761) * V5, 5));
      advanceTo(T0 + (CROSS_A + delta) * S - 5 * S);
      expect(ownWarnings('C')).toHaveLength(own ? 1 : 0);
      expect(armOf('C').absorbedAt === null).toBe(own);
    });
  });

  // ===========================================================================
  // Tre medlemmar, olika bokföringsordning
  // ===========================================================================
  describe('tre medlemmar (korsningsordning A < B < D)', () => {
    const orders = [
      ['D', 'B', 'A'], // [FÄLLER]
      ['B', 'D', 'A'], // [FÄLLER]
      ['D', 'A', 'B'], // [FÄLLER]
      ['B', 'A', 'D'], // [FÄLLER]
      ['A', 'D', 'B'], // motfall: ledaren först
      ['A', 'B', 'D'], // motfall: naturlig ordning
    ];
    const cross = { A: CROSS_A, B: CROSS_B, D: CROSS_D };
    it.each(orders.map((o) => [o.join('-'), o]))('bokföring %s ⇒ tidigaste = A, första passagen = den först bokförda', (_label, order) => {
      const id = stageConvoy({ withD: true });
      order.forEach((mmsi, i) => beyond(mmsi, 800 + 20 * i, cross[mmsi]));
      const event = eventById(id);
      expect(event.firstPassageAt / S - T0 / S).toBeCloseTo(cross[order[0]], 0);
      expect(event.firstPassageRegisteredAt).toBe(T0 + 800 * S);
      if (order[0] === 'A') expect(event.earliestCrossingAt ?? null).toBeNull();
      else expect(event.earliestCrossingAt / S - T0 / S).toBeCloseTo(CROSS_A, 0);
      const moves = order.reduce((acc, mmsi, i) => {
        const prev = Math.min(...order.slice(0, i).map((m) => cross[m]));
        return acc + (i > 0 && cross[mmsi] < prev ? 1 : 0);
      }, 0);
      expect(debugLines('[OPENING_PASSAGE_EARLIER]')).toHaveLength(moves);
      // En ny båt 650 s efter A (inom fönstret från B, D eller A beroende på
      // ordningen) får egen varning när A inte bokfördes först, och när A
      // bokfördes först ligger hon redan utanför referensen.
      advanceTo(T0 + 861 * S);
      svc.observeVessel(boat('C', (CROSS_A + 650 - 861) * V5, 5));
      advanceTo(T0 + 900 * S);
      expect(ownWarnings('C')).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Motfall och tvåtickgränsen
  // ===========================================================================
  describe('motfall', () => {
    it('vanlig ordning: inget tidigaste-fält, ingen loggrad, en ny båt inom fönstret absorberas', () => {
      const id = stageConvoy();
      beyond('A', 700, CROSS_A);
      beyond('B', 760, CROSS_B);
      const event = eventById(id);
      expect(event.earliestCrossingAt ?? null).toBeNull();
      expect(debugLines('[OPENING_PASSAGE_EARLIER]')).toHaveLength(0);
      advanceTo(T0 + 761 * S);
      svc.observeVessel(boat('C', (CROSS_A + 560 - 761) * V5, 5));
      expect(armOf('C').eventId).toBe(id);
      expect(armOf('C').absorbedAt).toBe(T0 + 761 * S);
    });

    it('täckningen och U17: en TYST båt absorberad mellan bokföringarna får säkerhetsvarningen som förut', () => {
      const id = stageConvoy();
      beyond('B', 700, CROSS_B);
      advanceTo(T0 + 705 * S);
      svc.observeVessel(boat('F', (900 - 705) * V5, 5));
      expect(armOf('F').eventId).toBe(id);
      expect(armOf('F').coverUntilMs).toBe(T0 + 700 * S + W);
      beyond('A', 760, CROSS_A);
      expect(armOf('F').coverUntilMs).toBe(T0 + 700 * S + W);
      advanceTo(T0 + 700 * S + W - 1 * S);
      expect(ownWarnings('F')).toHaveLength(0);
      advanceTo(T0 + 700 * S + W + 2 * BRIDGE_OPENING.TICK_INTERVAL_MS);
      expect(ownWarnings('F')).toHaveLength(1);
    });

    it('ny båt under två tick: medlem som på basen (inte korsningsankarets golv)', () => {
      const id = stageConvoy();
      beyond('B', 700, CROSS_B);
      beyond('A', 760, CROSS_A);
      advanceTo(T0 + 900 * S);
      svc.observeVessel(boat('C', 100, 5));
      expect(armOf('C').eventId).toBe(id);
      expect(armOf('C').absorbedAt).toBe(T0 + 900 * S);
      expect(armOf('C').anchorFloorEventId).toBeNull();
    });

    it('korsningsankarets golv gäller som förut för en båt som bara hör till händelsen mätt mot bokföringen', () => {
      const id = stageConvoy();
      beyond('B', 700, CROSS_B);
      beyond('A', 760, CROSS_A);
      advanceTo(T0 + 1050 * S);
      svc.observeVessel(boat('C', 100, 5));
      expect(armOf('C').eventId).toBe(id);
      expect(armOf('C').anchorFloorEventId).toBe(id);
    });

    // Tvåtickgränsen: ny båt T0+900 s med ankomst efter A + 600 s (T0+924 s)
    // och inom B + 600 s. Med 59 s kvar är hon medlem (basen), med 61 s egen
    // varning. Fäller mutationerna av tickgränsen (1 eller 4 tick).
    it.each([[50, false], [59, false], [61, true], [100, true], [119, true]])(
      'tvåtickgränsen: %i s kvar ⇒ egen varning: %s',
      (rem, own) => {
        const id = stageConvoy();
        beyond('B', 700, CROSS_B);
        beyond('A', 760, CROSS_A);
        advanceTo(T0 + 900 * S);
        svc.observeVessel(boat('C', rem * V5, 5));
        const c = armOf('C');
        expect(c.expectedArrivalMs).toBeGreaterThan(T0 + (CROSS_A + 600) * S);
        expect((c.expectedArrivalMs - Date.now()) / S).toBeCloseTo(rem, 0);
        if (own) {
          expect(c.absorbedAt).toBeNull();
          expect(ownWarnings('C')).toHaveLength(1);
        } else {
          expect(c.eventId).toBe(id);
          expect(c.absorbedAt).toBe(T0 + 900 * S);
          expect(ownWarnings('C')).toHaveLength(0);
        }
      },
    );
  });

  // ===========================================================================
  // Granskningens fall: ingen senare eller utebliven varning mot basen
  // ===========================================================================
  describe('granskningens fall mot basen 03ec89b', () => {
    /**
     * PROB E: ny båt C upptäcks T0+900 s, `detM` m före bron i 5 kn (under två
     * tick), och stannar `stopS` s på `stopM` m. Varningen kommer på basens
     * sekund ([bas-tid], null = ingen varning på basen heller).
     */
    it.each([
      [100, 40, 60, null], [100, 40, 120, 1013], [100, 40, 200, 1013], [100, 40, 300, 1013],
      [100, 40, 450, 1013], [100, 40, 900, 1013], [140, 60, 150, 1001], [140, 60, 250, 1001],
      [140, 60, 400, 1001], [140, 60, 700, 1001], [100, 0, 0, null],
    ])('prob E: %i m före bron, stopp på %i m i %i s ⇒ basens varning (%s)', (detM, stopM, stopS, baseS) => {
      stageConvoy();
      beyond('B', 700, CROSS_B);
      beyond('A', 760, CROSS_A);
      const C = drive('C', 900, detM, stopM, stopS);
      play(C.fixes);
      advanceTo(T0 + (C.cross + 60) * S);
      const own = ownWarnings('C');
      if (baseS === null) {
        expect(own).toHaveLength(0);
      } else {
        expect(own.length).toBeGreaterThanOrEqual(1);
        expect(Math.round((own[0].t - T0) / S)).toBe(baseS);
      }
    });

    /**
     * ANMÄRKNING A (andra varvet): R korsade bron norrut vid P, inom 600 s
     * efter B men mer än 600 s efter A, och kommer tillbaka söderut. Händelsen
     * beskriver hennes passerade öppning (referensen är B), så hon får sin
     * egen U15-varning, som på basen: 19 s, 39 s och 78 s före ankomsten.
     */
    const southbound = (distanceM) => {
      const b = boat('R', distanceM, 5, { bearing: 40, cog: 220 });
      b._routeDirection = 'south';
      return b;
    };
    it.each([
      ['P = T0+940 s, retur 50 m T0+1000 s', 940, 950, 1000, 50, 19],
      ['P = T0+960 s, retur 100 m T0+990 s', 960, 965, 990, 100, 39],
      ['P = T0+940 s, retur 200 m T0+990 s', 940, 950, 990, 200, 78],
    ])('anm. A, U15-retur: %s ⇒ egen varning som på basen', (_label, P, regS, tR, dR, leadS) => {
      stageConvoy();
      beyond('B', 700, CROSS_B);
      beyond('A', 760, CROSS_A);
      advanceTo(T0 + regS * S);
      svc._passageMemory.set('R::Klaffbron', { at: T0 + P * S, registeredAt: T0 + regS * S, eventId: null });
      advanceTo(T0 + tR * S);
      svc.observeVessel(southbound(dR));
      const arr = tR + dR / V5;
      for (let t = tR + 10; t < arr; t += 10) {
        advanceTo(T0 + t * S);
        svc.observeVessel(southbound((arr - t) * V5));
      }
      advanceTo(T0 + (arr + 30) * S);
      const own = ownWarnings('R');
      expect(own).toHaveLength(1);
      expect(Math.abs((arr - (own[0].t - T0) / S) - leadS)).toBeLessThan(1);
    });

    /**
     * U15 villkor (b), prob C (första varvet): R:s retur binds T0+720 s, före A:s
     * bokföring. Basens utfall i alla tre lägena: händelsen läser fortfarande
     * firstPassageAt (B), och den tidigare korsningen ändrar inget för en båt
     * som redan är bunden.
     */
    it.each([
      ['P = T0−200 s', -200, true, 0],
      ['P = T0−100 s', -100, false, 1],
      ['P = T0−300 s', -300, true, 0],
    ])('prob C, U15 (b): %s ⇒ som på basen', (_label, P, absorbed, ownCount) => {
      const id = stageConvoy();
      svc._passageMemory.set('R::Klaffbron', { at: T0 + P * S, registeredAt: T0 + 200 * S, eventId: null });
      beyond('B', 700, CROSS_B);
      advanceTo(T0 + 720 * S);
      svc.observeVessel(southbound((900 - 720) * V5));
      expect(armOf('R').eventId === id).toBe(absorbed);
      advanceTo(T0 + 740 * S);
      svc.observeVessel(southbound((900 - 740) * V5));
      beyond('A', 760, CROSS_A);
      for (let t = 770; t < 900; t += 10) {
        advanceTo(T0 + t * S);
        svc.observeVessel(southbound((900 - t) * V5));
      }
      expect(ownWarnings('R')).toHaveLength(ownCount);
    });

    /**
     * ANMÄRKNING B (följdfall): en senare båt C bakom en båt X som rättningen
     * gav en egen händelse. Rör C X:s fönster (korsar inom 600 s efter X) täcks
     * hon av X:s varning, som kommer före basens egna varning för henne (U2).
     */
    it.each([
      ['C 680 s efter A, inget stopp', 620, 781, 680, 0],
      ['C 680 s efter A, stopp 300 s', 620, 781, 680, 300],
      ['C 760 s efter A, stopp 150 s', 660, 821, 760, 150],
    ])('anm. B [FÄLLER, X har ingen egen händelse på basen]: %s ⇒ täckt av en varning för hennes öppning, inte senare än basens', (_label, dX, tC, dC, stopS) => {
      stageConvoy();
      beyond('B', 700, CROSS_B);
      beyond('A', 760, CROSS_A);
      const X = drive('X', 761, (CROSS_A + dX - 761) * V5, 0, 0);
      const C = drive('C', tC, (CROSS_A + dC - tC) * V5, 40, stopS);
      play([...X.fixes, ...C.fixes]);
      advanceTo(Date.now() + 60 * S);
      expect(C.cross - X.cross).toBeLessThanOrEqual(600);
      const xw = memberWarnings('X');
      expect(xw).toHaveLength(1);
      // C absorberades i X:s händelse: hennes täckande varning är X:s, före
      // basens egna varning för henne (T0+781–1008 s i svepet).
      expect(armOf('C')).toBeUndefined();
      expect(xw[0].t).toBeLessThanOrEqual(T0 + 781 * S);
    });

    /**
     * KÄND KOSTNAD (anmärkning B, följdfall som den enkla varianten också ger):
     * X hörs första gången efter A:s bokföring och får en egen händelse (nästa
     * öppning). C, 760 s efter A, binds i X:s händelse, stannar 600 s och
     * korsar 710 s efter X. Bakkanten släpper henne mot X:s fönster: varning
     * T0+1518 s, 166 s före korsningen. Basen gav henne en egen händelse direkt
     * (T0+781 s, 903 s före), eftersom X där absorberades i E. Låst så att en
     * ändring syns; se RESULTAT och ARCHITECTURE.
     */
    it('anm. B, känd kostnad [på basen T0+781 s]: C bakom X stannar 600 s ⇒ varning senare än på basen (≥ 60 s före korsningen)', () => {
      stageConvoy();
      beyond('B', 700, CROSS_B);
      beyond('A', 760, CROSS_A);
      const X = drive('X', 761, (CROSS_A + 620 - 761) * V5, 0, 0);
      const C = drive('C', 781, (CROSS_A + 760 - 781) * V5, 40, 600);
      play([...X.fixes, ...C.fixes]);
      advanceTo(Date.now() + 60 * S);
      const cw = memberWarnings('C');
      expect(cw).toHaveLength(1);
      expect(Math.round((cw[0].t - T0) / S)).toBe(1518);
      expect(C.cross - (cw[0].t - T0) / S).toBeGreaterThan(60);
    });
  });

  // ===========================================================================
  // Risken: en för tidig skattning från den båt som bokförs sist
  // ===========================================================================
  describe('för tidig skattning (rät linje över ett glapp där båten saktade in osedd)', () => {
    /**
     * A:s sista fix före bron: 567 m i 5,4 kn T0+120 s. Hon väntar osedd vid
     * bron och korsar T0+500 s; nästa fix T0+900 s, 1111 m bortom bron. Den
     * räta linjen skattar korsningen till ≈ T0+384 s, 116 s för tidigt. B korsar
     * T0+530 s och skattas rätt. C (NY T0+915 s) korsar T0+1060 s: 560 s efter
     * A:s verkliga korsning (samma öppning enligt U2) men 676 s efter skattningen.
     * Bara nya båtar med minst två tick kvar påverkas; en redan absorberad båt
     * mäts som förut.
     */
    const stageEarly = (bFirst) => {
      svc.observeVessel(boat('B', 1200, 5.4));
      svc.observeVessel(boat('A', 900, 5.4));
      expect(klaff()).toHaveLength(1);
      advanceTo(T0 + 120 * S);
      svc.observeVessel(boat('A', 567, 5.4));
      advanceTo(T0 + 526 * S);
      svc.observeVessel(boat('B', 11, 5.4));
      if (bFirst) {
        beyond('B', 560, 530);
        beyond('A', 900, 500);
      } else {
        beyond('A', 900, 500);
        beyond('B', 910, 530);
      }
      const event = svc._events.get('Klaffbron').find((e) => e.firstPassageAt !== null);
      advanceTo(T0 + 915 * S);
      svc.observeVessel(boat('C', (1060 - 915) * V5, 5));
      advanceTo(T0 + 1050 * S);
      return event;
    };
    const estA = 120 + 780 * (567 / (567 + 400 * V54));
    it.each([
      ['B bokförs först [FÄLLER]', true],
      ['A bokförs först (motfall: samma utfall redan före rättningen)', false],
    ])('%s ⇒ C får en andra varning (känd kostnad)', (_label, bFirst) => {
      const event = stageEarly(bFirst);
      const earliest = event.earliestCrossingAt ?? event.firstPassageAt;
      expect(earliest / S - T0 / S).toBeCloseTo(estA, 0);
      expect(ownWarnings('C')).toHaveLength(1);
    });
  });
});
