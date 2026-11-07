'use strict';

/**
 * U14 (användarbeslut 2026-11-04, buggjägarens kort B01): EN NOTIS PER PASSAGE,
 * ÄVEN RETURPASSAGEN. Reviderad efter den adversariella granskningen samma dag.
 *
 * Felet: besöksregeln 2026-09-07 håller ett notifierat besök tills båten setts
 * två gånger över 350 m från bron och sedan kommit tillbaka. En båt som passerar
 * en bro, vänder inom 350 m och passerar tillbaka lämnar aldrig besöket, så
 * returpassagen fick ingen notis. B01: WILMA passerar Klaffbron söderut 01:56:10,
 * vänder 162 m söder om bron och korsar norrut 01:59:54. Appen bokför två
 * målbropassager men skickar en notis (INV-5).
 *
 * Rättningen (TriggerPointVisitTracker.releaseReturnPassage): besöket minns
 * vilken sida av brolinjen den notifierade passagen leder till och när båten
 * senast setts där. Besöket avslutas först när appen har bokfört bron igen, i en
 * fix där båten inte låg på bortre sidan, och båten dessutom ligger minst 30 m ut
 * på ankomstsidan, är under gång dit och har vänd ruttriktning. Vid gles AIS
 * räcker en korsning till linjen. Granskningen visade att den första
 * prototypen gjorde passagelogikens falska bokföringar vid linjen till notiser
 * när en båt vände och sedan väntade nära bron; testerna nedan vaktar det.
 *
 * Fixturerna är buggjägarens minsta repro för B01 (r1-standard-a) och värld 40
 * ur samma körning (R1, aishub), där XENIA notifieras i passerad form och sedan
 * vänder tillbaka genom Klaffbron.
 */

jest.mock('homey');

const path = require('path');
const { execFileSync } = require('child_process');
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const TriggerPointVisitTracker = require('../lib/services/TriggerPointVisitTracker');
const geometry = require('../lib/utils/geometry');
const { BRIDGES, TRIGGER_POINTS } = require('../lib/constants');
const { validateInvariants } = require('./replay-validation/invariants');
const { generateScenario, buildPath, pathMetrics } = require('./replay-validation/scenarioGenerator');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const KLAFF = BRIDGES.klaffbron;
const MMSI = '265178387';
const GRACE_MS = 15000;
const WINDOW_MS = 60000;
const LIMITS = { maxBookingAgeMs: GRACE_MS, maxLatenessMs: 10 * 60 * 1000, sparseFixGapMs: 30000 };
// _confirmReturnPassages prövar utan bokföringsgräns.
const CONFIRM = { ...LIMITS, maxBookingAgeMs: Infinity };
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// Position `offsetM` meter från Klaffbrons linje längs kanalaxelns normal
// (+ = norr). Samma projektion som geometry.bridgeLineOffsetM.
const NORMAL = (((KLAFF.axisBearing || 125) - 90) * Math.PI) / 180;
const posAt = (offsetM, bridge = KLAFF) => ({
  lat: bridge.lat + (offsetM * Math.cos(NORMAL)) / 111320,
  lon: bridge.lon + (offsetM * Math.sin(NORMAL)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180)),
});
const NORTH_COG = 40;
const SOUTH_COG = 220;

describe('geometry: brolinjens sida, avstånd och kursens sida', () => {
  test('decisiveBridgeSide: nordöstra sidan +1, sydvästra −1, linjen och ogiltigt 0', () => {
    expect(geometry.decisiveBridgeSide(posAt(200), KLAFF)).toBe(1);
    expect(geometry.decisiveBridgeSide(posAt(-200), KLAFF)).toBe(-1);
    expect(geometry.decisiveBridgeSide(posAt(5), KLAFF)).toBe(0);
    expect(geometry.decisiveBridgeSide({ lat: null, lon: KLAFF.lon }, KLAFF)).toBe(0);
    expect(geometry.decisiveBridgeSide(posAt(200), null)).toBe(0);
  });

  test('isDecisivelyOppositeBridgeSide betyder samma sak som förut', () => {
    expect(geometry.isDecisivelyOppositeBridgeSide(posAt(200), posAt(-200), KLAFF)).toBe(true);
    expect(geometry.isDecisivelyOppositeBridgeSide(posAt(200), posAt(30), KLAFF)).toBe(false);
    expect(geometry.isDecisivelyOppositeBridgeSide(posAt(200), posAt(5), KLAFF)).toBe(false);
    expect(geometry.isDecisivelyOppositeBridgeSide(null, posAt(-200), KLAFF)).toBe(false);
  });

  test('bridgeLineOffsetM ger meter med tecken längs kanalaxeln', () => {
    expect(geometry.bridgeLineOffsetM(posAt(42), KLAFF)).toBeCloseTo(42, 6);
    expect(geometry.bridgeLineOffsetM(posAt(-7), KLAFF)).toBeCloseTo(-7, 6);
    expect(geometry.bridgeLineOffsetM({ lat: null, lon: 12 }, KLAFF)).toBeNaN();
  });

  test('courseBridgeSide: kurs mot norra sidan +1, mot södra −1, längs linjen och ogiltig 0', () => {
    expect(geometry.courseBridgeSide(NORTH_COG, KLAFF)).toBe(1);
    expect(geometry.courseBridgeSide(5, KLAFF)).toBe(1);
    expect(geometry.courseBridgeSide(SOUTH_COG, KLAFF)).toBe(-1);
    expect(geometry.courseBridgeSide(130, KLAFF)).toBe(0);
    expect(geometry.courseBridgeSide(310, KLAFF)).toBe(0);
    expect(geometry.courseBridgeSide(360, KLAFF)).toBe(0);
    expect(geometry.courseBridgeSide(Number.NaN, KLAFF)).toBe(0);
  });
});

describe('TriggerPointVisitTracker: bara en bevisad returpassage avslutar besöket', () => {
  let now;
  let tracker;
  let fixLagMs;

  beforeEach(() => {
    now = Date.parse('2026-09-15T01:53:10Z');
    tracker = new TriggerPointVisitTracker({ now: () => now });
    fixLagMs = 0;
  });

  // Fartygsobjekt `offsetM` från linjen. Färden är som standard norrut i 3 kn.
  // fixLagMs låter AIS-fixens egen tid släpa efter appens klocka.
  const at = (offsetM, extra = {}) => ({
    mmsi: MMSI,
    ...posAt(offsetM),
    sog: 3,
    cog: NORTH_COG,
    timestamp: now,
    lastPositionUpdate: now,
    fixTs: now - fixLagMs,
    fixFeed: 'aisstream',
    ...extra,
  });
  const tick = (seconds = 10) => {
    now += seconds * 1000;
  };
  // `extra` kan vara en funktion; den läses efter tidssteget, så att en
  // bokföringsstämpel i fixen får fixens egen tid.
  const observe = (offsetM, extra, seconds = 10) => {
    tick(seconds);
    const vessel = at(offsetM, typeof extra === 'function' ? extra() : extra);
    return { vessel, result: tracker.observe(vessel, KLAFF.name) };
  };
  const release = (vessel, limits = LIMITS) => tracker.releaseReturnPassage(vessel, KLAFF.name, limits);
  const southbound = { _routeDirection: 'south', cog: SOUTH_COG };
  const northbound = { _routeDirection: 'north', cog: NORTH_COG };
  const booked = (extra = {}) => ({ lastPassedBridge: KLAFF.name, lastPassedBridgeTime: now, ...extra });

  /**
   * B01-förloppet: förvarning söderut 200 m norr om bron, utpassagen bokförs
   * vid linjen, båten går 150 m söder om bron och vänder. Bortre sidan är söder.
   * @returns {number} utpassagens bokföringsstämpel
   */
  function outboundAndTurn() {
    expect(tracker.reserve(at(200, southbound), KLAFF.name)).not.toBeNull();
    tick();
    const outboundAt = now;
    const passed = { lastPassedBridge: KLAFF.name, lastPassedBridgeTime: outboundAt, passedBridges: [KLAFF.name] };
    tracker.observe(at(5, { ...southbound, ...passed }), KLAFF.name);
    expect(observe(-60, { ...southbound, ...passed }).result).toEqual({ changed: true, reentered: false });
    expect(observe(-150, { ...southbound, ...passed }).result).toEqual({ changed: false, reentered: false });
    observe(-110, { ...northbound, ...passed });
    observe(-40, { ...northbound, ...passed });
    return outboundAt;
  }

  test('B01 tät AIS: bokföring vid linjen väntar, nästa fix 45 m ut på ankomstsidan släpper', () => {
    outboundAndTurn();
    tick();
    const bookedAt = now;
    const onLine = at(5, { ...northbound, ...booked() });
    tracker.observe(onLine, KLAFF.name);
    expect(release(onLine)).toBeFalsy();
    expect(tracker.holds(MMSI, KLAFF.name)).toBe(true);
    const { vessel } = observe(45, { ...northbound, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: bookedAt });
    expect(release(vessel)).toMatchObject({ farSign: -1, bookedAt, evidence: 'ankomstsidan' });
    expect(tracker.holds(MMSI, KLAFF.name)).toBe(false);
    expect(tracker.reserve(vessel, KLAFF.name, { passageBehind: true })).not.toBeNull();
  });

  test('bokföring när båten redan är 45 m ut på ankomstsidan släpper direkt', () => {
    outboundAndTurn();
    const { vessel } = observe(45, () => ({ ...northbound, ...booked() }));
    expect(release(vessel)).toMatchObject({ evidence: 'ankomstsidan' });
  });

  test.each([
    ['ingen ny bokföring, bara utpassagens stämpel', (out) => ({ ...northbound, lastPassedBridgeTime: out })],
    ['ruttriktningen pekar fortfarande mot bortre sidan', () => ({ _routeDirection: 'south', cog: NORTH_COG })],
    ['ruttriktning saknas', () => ({ _routeDirection: null })],
    ['båten ligger still (väntande båt, sog 0,2)', () => ({ ...northbound, sog: 0.2 })],
    ['kursen pekar mot bortre sidan (avgång tillbaka)', () => ({ _routeDirection: 'north', cog: SOUTH_COG })],
    ['bokföringen är äldre än fönstret', () => ({ ...northbound, ageMs: GRACE_MS })],
    ['bokföringen gäller en annan bro', () => ({ ...northbound, bridge: 'Olidebron' })],
    ['GPS-osäker position', () => ({ ...northbound, _positionUncertain: true })],
    ['tät AIS och bara 20 m ut på ankomstsidan', () => ({ ...northbound, offsetM: 20 })],
  ])('%s släpper inte besöket', (_label, variant) => {
    const outboundAt = outboundAndTurn();
    const v = variant(outboundAt);
    tick();
    const vessel = at(v.offsetM ?? 45, {
      _routeDirection: v._routeDirection,
      cog: v.cog ?? NORTH_COG,
      sog: v.sog ?? 3,
      lastPassedBridge: v.bridge || KLAFF.name,
      lastPassedBridgeTime: v.lastPassedBridgeTime ?? now - (v.ageMs || 0),
      _positionUncertain: v._positionUncertain,
    });
    tracker.observe(vessel, KLAFF.name);
    expect(release(vessel)).toBeFalsy();
    expect(tracker.holds(MMSI, KLAFF.name)).toBe(true);
  });

  test('granskningens fall: vänd, vänta vid linjen med falsk bokföring och kör tillbaka ger inget släpp', () => {
    outboundAndTurn();
    // Båten ligger 10 m på bortre sidan; bruset för henne till linjen och
    // passagelogiken bokför en falsk passage (distance_fallback).
    for (const offsetM of [-12, -4, -15, 3, -9, -14]) observe(offsetM, { ...northbound, sog: 0.1, cog: 300 }, 30);
    let falseBooking = at(2, {
      ...northbound, sog: 0.1, cog: 120, ...booked(),
    });
    tracker.observe(falseBooking, KLAFF.name);
    expect(release(falseBooking)).toBeFalsy();
    // Nästa fix: fortfarande stilla, och bruset lägger henne 35 m norrut.
    tick(30);
    falseBooking = at(35, {
      ...northbound, sog: 0.1, cog: 20, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: now - 30000,
    });
    tracker.observe(falseBooking, KLAFF.name);
    expect(release(falseBooking, { ...LIMITS, maxBookingAgeMs: WINDOW_MS })).toBeFalsy();
    // Avgång tillbaka mot bortre sidan med ny falsk bokföring vid linjen.
    const leaving = at(4, {
      _routeDirection: 'north', sog: 4.5, cog: SOUTH_COG, ...booked(),
    });
    tick(10);
    tracker.observe({
      ...leaving, timestamp: now, lastPositionUpdate: now, fixTs: now,
    }, KLAFF.name);
    expect(release({
      ...leaving, timestamp: now, lastPositionUpdate: now, fixTs: now,
    })).toBeFalsy();
    expect(tracker.holds(MMSI, KLAFF.name)).toBe(true);
  });

  test('en bokföring i en fix på bortre sidan absorberas och räknas aldrig senare som retur', () => {
    outboundAndTurn();
    tick();
    const farBooking = now;
    const far = at(-35, { ...northbound, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: farBooking });
    tracker.observe(far, KLAFF.name);
    expect(release(far)).toBeFalsy();
    const { vessel } = observe(45, { ...northbound, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: farBooking });
    expect(release(vessel)).toBeFalsy();
  });

  test('klockorna: fixens tid släpar 20 s, men bokföringen i fixen på bortre sidan absorberas ändå', () => {
    // AIS-fixarnas egen tid ligger 20 s efter appens klocka hela vägen.
    // Passagelogiken bokför bron i samma fix där båten syns på bortre sidan.
    // Prototypen jämförde bokföringens bearbetningstid med fixens tid och
    // räknade då bokföringen som "efter observationen".
    fixLagMs = 20000;
    outboundAndTurn();
    tick();
    const farBooking = now;
    tracker.observe(at(-35, { ...northbound, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: farBooking }), KLAFF.name);
    tick();
    const later = at(45, { ...northbound, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: farBooking });
    tracker.observe(later, KLAFF.name);
    expect(release(later)).toBeFalsy();
    expect(tracker.holds(MMSI, KLAFF.name)).toBe(true);
  });

  test('M1/M2: en annan bro bokförd sist, men passedAt[Klaffbron] är färsk, släpper besöket', () => {
    outboundAndTurn();
    const { vessel } = observe(120, () => ({
      ...northbound, lastPassedBridge: 'Järnvägsbron', lastPassedBridgeTime: now, passedAt: { [KLAFF.name]: now },
    }), 180);
    expect(release(vessel)).toMatchObject({ evidence: 'ankomstsidan' });
  });

  test('passedAt som bara bär utpassagens stämpel släpper inte', () => {
    const outboundAt = outboundAndTurn();
    const { vessel } = observe(120, () => ({
      ...northbound, lastPassedBridge: 'Järnvägsbron', lastPassedBridgeTime: now, passedAt: { [KLAFF.name]: outboundAt },
    }));
    expect(release(vessel)).toBeFalsy();
  });

  test('U21: korsningen interpoleras på glappet; notisen får komma högst 10 min efter den', () => {
    // Dirigentens beslut 2026-11-05: en returnotis släpps bara om den kommer
    // högst STALE_ETA_HARD_THRESHOLD_MS efter den uppskattade korsningen.
    // 40 min tystnad, 60 m söder → 400 m norr: korsningen ≈ 5 min in i glappet.
    outboundAndTurn();
    observe(-60, northbound);
    const { vessel } = observe(400, () => ({ ...northbound, ...booked() }), 40 * 60);
    expect(release(vessel)).toBeFalsy();
    expect(release(vessel, CONFIRM)).toBeFalsy();
    expect(tracker.holds(MMSI, KLAFF.name)).toBe(true);
  });

  test.each([
    // Omgranskningens u21-25 och u21-12: båten tystnar 100 m på bortre sidan,
    // korsar och hörs igen 120 m ut. Glappet är kortare än 30 min i båda.
    ['25 min tystnad: korsningen ≈ 11 min in, notisen ≈ 14 min sen', 25, false],
    ['12 min tystnad: korsningen ≈ 5,5 min in, notisen ≈ 6,5 min sen', 12, true],
  ])('U21 %s', (_label, minutes, releases) => {
    outboundAndTurn();
    const { vessel: last } = observe(-100, northbound);
    const lastFixTs = last.fixTs;
    const { vessel } = observe(120, () => ({ ...northbound, ...booked() }), minutes * 60);
    const result = release(vessel);
    if (!releases) {
      expect(result).toBeFalsy();
      expect(release(vessel, CONFIRM)).toBeFalsy();
      return;
    }
    const expectedCrossing = lastFixTs + (minutes * 60000 * 100) / 220;
    expect(result).toMatchObject({ evidence: 'ankomstsidan', crossingGapMs: minutes * 60000 });
    expect(Math.abs(result.crossedAt - expectedCrossing)).toBeLessThan(2000);
    expect(Math.abs(result.latenessMs - (now - expectedCrossing))).toBeLessThan(2000);
  });

  test('ett glapp på 11 min med korsningen 8 min före notisen släpper, som ELFKUNGEN i both-21h', () => {
    outboundAndTurn();
    observe(-60, northbound);
    const { vessel } = observe(150, () => ({ ...northbound, ...booked() }), 11 * 60);
    expect(release(vessel)).toMatchObject({ evidence: 'ankomstsidan' });
  });

  test('gles AIS (65 s): korsning från entydigt bortre sidan till 15 m ut släpper i bokföringsticken', () => {
    outboundAndTurn();
    observe(-130, northbound, 65);
    const { vessel } = observe(15, () => ({ ...northbound, ...booked() }), 65);
    expect(release(vessel)).toMatchObject({ evidence: 'gles-korsning' });
  });

  test('gles AIS: en fix vid linjen på bortre sidan släpper aldrig i bokföringsticken (omgranskningen)', () => {
    // Förra revisionens villkor 6b godtog en fix som fortfarande låg på
    // bortre sidan, inom 10 m från linjen. Passagelogiken bokför just en sådan
    // fix (distance_fallback), så en båt som bromsade in för att vänta fick
    // notisen redan vid ankomsten till linjen.
    outboundAndTurn();
    observe(-130, northbound, 65);
    const { vessel } = observe(-6, () => ({ ...northbound, sog: 1, ...booked() }), 65);
    expect(release(vessel)).toBeFalsy();
    expect(release(vessel, CONFIRM)).toBeFalsy();
  });

  test.each([
    // Klustrets R1-världar (AISHub 65–70 s): CORDELIA 510 bokförs 9,3 m före
    // linjen i 4,0 kn, ALVA 575 9,5 m efter linjen i 5,0 kn, DAGNY 1977 4,7 m
    // före i 4,8 kn. Nästa fix kommer efter mer än 60 s (INV-7).
    ['9,3 m före linjen i 4,0 kn (CORDELIA 510)', -9.3, 4, 'gles-linje-transit'],
    ['9,5 m efter linjen i 5,0 kn (ALVA 575)', 9.5, 5, 'gles-linje-transit'],
    ['4,7 m före linjen i 4,8 kn (DAGNY 1977)', -4.7, 4.8, 'gles-linje-transit'],
    // Omgranskningens väntande båt: samma läge men inbromsad.
    ['4,7 m före linjen i 1,0 kn (väntande båt)', -4.7, 1, null],
    ['9,5 m efter linjen i 1,0 kn (väntande båt)', 9.5, 1, null],
  ])('gles AIS: linjefix %s', (_label, offsetM, sog, evidence) => {
    outboundAndTurn();
    observe(-130, northbound, 69);
    const { vessel } = observe(offsetM, () => ({ ...northbound, sog, ...booked() }), 69);
    if (evidence === null) {
      expect(release(vessel)).toBeFalsy();
      return;
    }
    const result = release(vessel);
    expect(result).toMatchObject({ evidence, crossingGapMs: 69000 });
    expect(result.latenessMs).toBeLessThan(WINDOW_MS);
  });

  /**
   * Omgranskningens svep 2 och 3 (w-i35-v1.0-d6-s1, a1): gles AIS (≈40 s),
   * båten går tillbaka från bortre sidan, bromsar in till 1 kn och stannar
   * 3,7 m från linjen på bortre sidan. Passagelogiken bokför bron i den
   * fixen. Sedan ligger hon still vid linjen i 15 min.
   * @returns {number} bokföringsstämpeln vid ankomsten till linjen
   */
  function sparseWaitAtLine() {
    outboundAndTurn();
    observe(-60, { ...northbound, sog: 3 }, 40);
    observe(-29, { ...northbound, sog: 3 }, 40);
    tick(40);
    const arrivalBooking = now;
    const arrival = at(-3.7, { ...northbound, sog: 0.98, ...booked() });
    tracker.observe(arrival, KLAFF.name);
    expect(release(arrival)).toBeFalsy();
    expect(release(arrival, CONFIRM)).toBeFalsy();
    const waiting = [-2, -9, -4, -10, -3, -6, -2, -8, -5, -3, -7, -2, -9, -4, -3, -6, -8, -2, -5, -4, -3, -7];
    waiting.forEach((offsetM, i) => {
      const { vessel } = observe(offsetM, {
        _routeDirection: 'north',
        sog: 0.1,
        cog: (i * 67) % 360,
        lastPassedBridge: KLAFF.name,
        lastPassedBridgeTime: arrivalBooking,
      }, 40);
      expect(release(vessel, CONFIRM)).toBeFalsy();
    });
    return arrivalBooking;
  }

  test('gles AIS: vänd, bromsa in och vänta 3,7 m från linjen ger inget släpp, inte heller när hon ger upp', () => {
    const arrivalBooking = sparseWaitAtLine();
    for (const offsetM of [-25, -80]) {
      const { vessel } = observe(offsetM, {
        _routeDirection: 'north',
        sog: 4.5,
        cog: SOUTH_COG,
        lastPassedBridge: KLAFF.name,
        lastPassedBridgeTime: arrivalBooking,
      }, 40);
      expect(release(vessel, CONFIRM)).toBeFalsy();
    }
    expect(tracker.holds(MMSI, KLAFF.name)).toBe(true);
  });

  test('gles AIS: samma väntan följd av en verklig passage släpps först efter korsningen', () => {
    const arrivalBooking = sparseWaitAtLine();
    const later = {
      ...northbound, sog: 3.5, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: arrivalBooking,
    };
    const { vessel: start } = observe(-2, later, 40);
    expect(release(start, CONFIRM)).toBeFalsy();
    // Första fixen efter korsningen: 25 m ut, bokföringen är 15 min gammal och
    // hör inte till korsningssegmentet. En fix räcker då inte.
    const { vessel: first } = observe(25, later, 40);
    expect(release(first)).toBeFalsy();
    expect(release(first, CONFIRM)).toBeFalsy();
    const { vessel: second } = observe(95, later, 40);
    expect(release(second)).toBeFalsy();
    const result = release(second, CONFIRM);
    expect(result).toMatchObject({ evidence: 'ankomstsidan-två-fixar', bookedAt: arrivalBooking });
    expect(result.crossedAt).toBeGreaterThan(start.fixTs);
    expect(result.crossedAt).toBeLessThan(first.fixTs);
    expect(result.latenessMs).toBeLessThan(2 * 60000);
  });

  test.each([
    // Omgranskning 2 (2026-11-07), P1: en väntande båt vars AIS rapporterar
    // 0,5–1 kn och slumpad kurs fick av ±15 m brus en gles fix entydigt på
    // ankomstsidan och en falsk "har precis passerat". En gles fix räcker nu
    // bara när båten rör sig i nuet (RE_CROSS:s och C2:s 2,0 kn).
    [0.6, null], [1.0, null], [1.9, null], [2.0, 'gles-korsning'], [3, 'gles-korsning'],
  ])('gles AIS: en fix 15 m ut på ankomstsidan i %s kn släpper bara i rörelse (revision 4)', (sog, evidence) => {
    outboundAndTurn();
    observe(-130, northbound, 65);
    const { vessel } = observe(15, () => ({ ...northbound, sog, ...booked() }), 65);
    if (evidence) {
      expect(release(vessel)).toMatchObject({ evidence });
      return;
    }
    expect(release(vessel)).toBeFalsy();
    expect(release(vessel, CONFIRM)).toBeFalsy();
    expect(tracker.holds(MMSI, KLAFF.name)).toBe(true);
    // En verklig långsam retur får notisen vid nästa fix, ute på ankomstsidan.
    const { vessel: next } = observe(60, {
      ...northbound, sog, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: vessel.lastPassedBridgeTime,
    }, 65);
    expect(release(next, CONFIRM)).toMatchObject({ evidence: 'ankomstsidan' });
  });

  test.each([
    // Utan rapporterad fart gäller RE_CROSS:s andra ben: segmentet ska vara
    // klart bortom GPS-bruset, minst 100 m längs kanalaxeln.
    ['segment 145 m', -130, 'gles-korsning'],
    ['segment 75 m', -60, null],
  ])('gles AIS utan fart: %s', (_label, fromOffset, evidence) => {
    outboundAndTurn();
    observe(fromOffset, northbound, 65);
    const { vessel } = observe(15, () => ({ ...northbound, sog: null, ...booked() }), 65);
    if (evidence) expect(release(vessel)).toMatchObject({ evidence });
    else expect(release(vessel)).toBeFalsy();
  });

  test.each([
    // Omgranskning 2, P2: tät AIS och ±30 m brus. Två fixar på ankomstsidan
    // räcker nu bara när båda ligger ENTYDIGT där (över 10 m) och båten var
    // under gång dit även i den förra.
    ['förra fixen 4 m ut (inte entydig)', -4, NORTH_COG, 1, null],
    ['förra fixen med kurs mot bortre sidan', -15, SOUTH_COG, 1, null],
    ['förra fixen i 0,3 kn', -15, NORTH_COG, 0.3, null],
    ['båda entydigt ute och under gång', -15, NORTH_COG, 1, 'ankomstsidan-två-fixar'],
  ])('två fixar på ankomstsidan: %s', (_label, firstOffset, firstCog, firstSog, evidence) => {
    const arrivalBooking = sparseWaitAtLine();
    const waitBooking = { lastPassedBridge: KLAFF.name, lastPassedBridgeTime: arrivalBooking };
    observe(-3, {
      _routeDirection: 'north', sog: 1, cog: NORTH_COG, ...waitBooking,
    }, 10);
    // Fixarna efter korsningen; bokföringen är äldre än korsningssegmentet.
    const { vessel: first } = observe(-firstOffset, {
      _routeDirection: 'north', sog: firstSog, cog: firstCog, ...waitBooking,
    }, 10);
    expect(release(first, CONFIRM)).toBeFalsy();
    const { vessel: second } = observe(35, {
      _routeDirection: 'north', sog: 1, cog: NORTH_COG, ...waitBooking,
    }, 10);
    if (evidence) expect(release(second, CONFIRM)).toMatchObject({ evidence, bookedAt: arrivalBooking });
    else expect(release(second, CONFIRM)).toBeFalsy();
  });

  /**
   * Omgranskning 2, P1-retur (granskarens retur-i60+0-d3-j15-r06-s2): båten
   * vänder, väntar vid linjen och passagelogiken bokför bron i en fix 13,8 m
   * ut på BORTRE sidan. Vid den verkliga korsningen 13 min senare bokför den
   * inte igen. Revision 3 absorberade bokföringen och missade returen (INV-5)
   * när den falska glesa korsningen inte längre släpptes.
   * @returns {number} bokföringsstämpeln i fixen på bortre sidan
   */
  function waitWithFarSideBooking() {
    outboundAndTurn();
    observe(-60, { ...northbound, sog: 3 }, 60);
    observe(-27.5, { ...northbound, sog: 1.1 }, 60);
    tick(60);
    const bookingAt = now;
    const booking = at(-13.8, {
      ...northbound, sog: 0.54, cog: 115, ...booked(),
    });
    tracker.observe(booking, KLAFF.name);
    expect(release(booking, CONFIRM)).toBeFalsy();
    for (const [offsetM, cog] of [[14.3, 41], [-5.2, 56], [-9.2, 38], [2.1, 343], [-15.3, 312], [-3.7, 170]]) {
      const { vessel } = observe(offsetM, {
        _routeDirection: 'north', sog: 0.6, cog, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: bookingAt,
      }, 60);
      expect(release(vessel, CONFIRM)).toBeFalsy();
    }
    return bookingAt;
  }

  test('förtida bokföring på bortre sidan vid linjen efter vändningen behålls och släpps vid den verkliga passagen', () => {
    const bookingAt = waitWithFarSideBooking();
    const going = {
      _routeDirection: 'north', sog: 3.5, cog: NORTH_COG, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: bookingAt,
    };
    observe(-15.9, going, 60);
    const { vessel: first } = observe(96.5, going, 60);
    expect(release(first, CONFIRM)).toBeFalsy();
    const { vessel: second } = observe(197.5, going, 60);
    const result = release(second, CONFIRM);
    expect(result).toMatchObject({ evidence: 'ankomstsidan-två-fixar', bookedAt: bookingAt });
    expect(result.crossedAt).toBeLessThan(first.fixTs);
  });

  test('samma väntan som ger upp på bortre sidan släpps aldrig', () => {
    const bookingAt = waitWithFarSideBooking();
    for (const offsetM of [-25, -140, -260, -400]) {
      const { vessel } = observe(offsetM, {
        _routeDirection: 'north', sog: 4.5, cog: SOUTH_COG, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: bookingAt,
      }, 60);
      expect(release(vessel, CONFIRM)).toBeFalsy();
    }
  });

  test.each([
    // Undantaget gäller bara en bokföring nära linjen efter en BEKRÄFTAD
    // vändning. Annars absorberas den som förut.
    ['ruttriktningen pekar fortfarande bort', -13.8, 'south'],
    ['fixen ligger 45 m ut på bortre sidan', -45, 'north'],
  ])('bokföring på bortre sidan absorberas när %s', (_label, bookingOffset, route) => {
    outboundAndTurn();
    observe(-60, { ...northbound, sog: 3 }, 60);
    tick(60);
    const bookingAt = now;
    tracker.observe(at(bookingOffset, {
      _routeDirection: route, sog: 0.6, cog: NORTH_COG, ...booked(),
    }), KLAFF.name);
    const going = {
      _routeDirection: 'north', sog: 3.5, cog: NORTH_COG, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: bookingAt,
    };
    observe(-15, going, 60);
    observe(90, going, 60);
    const { vessel } = observe(190, going, 60);
    expect(release(vessel, CONFIRM)).toBeFalsy();
  });

  test('torrkörning: beviset prövas utan att besöket avslutas (failsafen)', () => {
    outboundAndTurn();
    const { vessel } = observe(45, () => ({ ...northbound, ...booked() }));
    expect(release(vessel, { ...LIMITS, dryRun: true })).toMatchObject({ evidence: 'ankomstsidan' });
    expect(tracker.holds(MMSI, KLAFF.name)).toBe(true);
    expect(release(vessel)).toMatchObject({ evidence: 'ankomstsidan' });
    expect(tracker.holds(MMSI, KLAFF.name)).toBe(false);
  });

  test('långsam retur (1 kn, tät AIS): bokföringen 4,7 m före linjen bekräftas när båten är 30 m ut, efter 60 s', () => {
    // Omgranskningens b-1.0/b-1.3: förra revisionen räknade 60 s-fönstret från
    // bokföringen, som gjordes innan båten korsade linjen. Vid 1 kn hinner hon
    // inte 30 m ut på 60 s, och returen missades tyst.
    outboundAndTurn();
    observe(-20, { ...northbound, sog: 1 });
    observe(-9.8, { ...northbound, sog: 1 });
    tick();
    const bookedAt = now;
    const booking = at(-4.7, { ...northbound, sog: 1, ...booked() });
    tracker.observe(booking, KLAFF.name);
    expect(release(booking)).toBeFalsy();
    const slow = {
      ...northbound, sog: 1, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: bookedAt,
    };
    let result = null;
    for (const offsetM of [0.4, 5.5, 10.6, 15.7, 20.8, 25.9, 31]) {
      const { vessel } = observe(offsetM, slow);
      expect(release(vessel, { ...LIMITS, maxBookingAgeMs: WINDOW_MS })).toBeFalsy();
      result = release(vessel, CONFIRM);
      if (result) break;
    }
    expect(result).toMatchObject({ evidence: 'ankomstsidan', bookedAt });
    expect(now - bookedAt).toBeGreaterThanOrEqual(WINDOW_MS);
  });

  test('en fix tillbaka på bortre sidan stryker korsningen; nästa korsning får ny tid', () => {
    outboundAndTurn();
    const { vessel: over } = observe(5, northbound);
    expect(release(over, CONFIRM)).toBeFalsy();
    const { vessel: back } = observe(-6, northbound);
    expect(release(back, CONFIRM)).toBeFalsy();
    const { vessel } = observe(45, () => ({ ...northbound, ...booked() }));
    const result = release(vessel);
    expect(result).toMatchObject({ evidence: 'ankomstsidan' });
    expect(result.crossedAt).toBeGreaterThan(back.fixTs);
  });

  test.each([
    ['tät AIS (10 s)', -20, 10],
    ['gles AIS men föregående fix låg redan vid linjen', 6, 65],
  ])('%s: bokföring vid linjen släpper inte i bokföringsticken', (_label, prevOffset, gapS) => {
    outboundAndTurn();
    observe(prevOffset, northbound, gapS);
    const { vessel } = observe(8, () => ({ ...northbound, ...booked() }), gapS);
    expect(release(vessel)).toBeFalsy();
  });

  test('notis i passerad form: ankomsten ligger redan på bortre sidan', () => {
    tick();
    const arrival = at(-30, { ...southbound, ...booked() });
    expect(tracker.reserve(arrival, KLAFF.name, { passageBehind: true })).not.toBeNull();
    observe(-150, southbound);
    observe(-120, northbound);
    const { vessel } = observe(45, () => ({ ...northbound, ...booked() }));
    expect(release(vessel)).toMatchObject({ farSign: -1 });
  });

  test('samma förlopp utan passageBehind tolkar bortre sidan fel och släpper inte', () => {
    tick();
    const arrival = at(-30, { ...southbound, ...booked() });
    expect(tracker.reserve(arrival, KLAFF.name)).not.toBeNull();
    observe(-150, southbound);
    observe(-120, northbound);
    const { vessel } = observe(45, () => ({ ...northbound, ...booked() }));
    expect(release(vessel)).toBeFalsy();
  });

  test('ankomst på linjen: bortre sidan tas ur ruttriktningen', () => {
    expect(tracker.reserve(at(5, southbound), KLAFF.name)).not.toBeNull();
    observe(-80, southbound);
    const { vessel } = observe(45, () => ({ ...northbound, ...booked() }));
    expect(release(vessel)).toMatchObject({ farSign: -1 });
  });

  test('ett stängt besök rörs inte; där gäller återkomstregeln som förut', () => {
    expect(tracker.reserve(at(200, southbound), KLAFF.name)).not.toBeNull();
    observe(400);
    observe(420);
    tick();
    expect(release(at(-45, { ...southbound, ...booked() }))).toBeFalsy();
    expect(observe(200).result.reentered).toBe(true);
  });

  test('Kanalinfarten har ingen brolinje och följer besöksregeln oförändrad', () => {
    const point = TRIGGER_POINTS.kanalinfarten;
    const atPoint = (northM, extra = {}) => ({ ...at(0, extra), lat: point.lat + northM / 111320, lon: point.lon });
    expect(tracker.reserve(atPoint(200, southbound), point.name)).not.toBeNull();
    tick();
    tracker.observe(atPoint(-100, southbound), point.name);
    tick();
    expect(tracker.releaseReturnPassage(atPoint(50, {
      ...northbound, lastPassedBridge: point.name, lastPassedBridgeTime: now,
    }), point.name, LIMITS)).toBeFalsy();
    expect(tracker.holds(MMSI, point.name)).toBe(true);
    expect(tracker.openBridgeVisits(MMSI)).toEqual([]);
  });

  test('openBridgeVisits listar fartygets öppna brobesök', () => {
    outboundAndTurn();
    expect(tracker.openBridgeVisits(MMSI)).toEqual([KLAFF.name]);
    expect(tracker.openBridgeVisits('123')).toEqual([]);
  });

  test('bortre sidan överlever omstart; stämplarna sparas inte; skadade fält ger inget släpp', () => {
    outboundAndTurn();
    const snapshot = tracker.exportSnapshot();
    const key = `${MMSI}:${KLAFF.name}`;
    expect(snapshot.entries[key]).toMatchObject({ farSign: -1, farSideSeenAt: expect.any(Number) });
    for (const field of [
      'farSideBooking', 'farSideBookingFixTs', 'farSideBookingOffsetM', 'returnBookedAt', 'returnBookedFixTs',
      'crossing', 'lastObservedAt', 'maxGapSinceFarMs',
    ]) {
      expect(snapshot.entries[key]).not.toHaveProperty(field);
    }
    const back = () => at(45, { ...northbound, ...booked() });

    const restored = new TriggerPointVisitTracker({ now: () => now });
    expect(restored.loadSnapshot(clone(snapshot))).toBe(1);
    tick();
    restored.observe(back(), KLAFF.name);
    expect(restored.releaseReturnPassage(back(), KLAFF.name, LIMITS)).toMatchObject({ farSign: -1 });

    const damages = [
      (entry) => {
        delete entry.farSign;
        delete entry.farSideSeenAt;
      },
      (entry) => {
        entry.farSign = 7;
      },
      (entry) => {
        entry.farSideSeenAt = entry.startedAt - 1;
      },
    ];
    for (const damage of damages) {
      const broken = clone(snapshot);
      damage(broken.entries[key]);
      const other = new TriggerPointVisitTracker({ now: () => now });
      expect(other.loadSnapshot(broken)).toBe(1);
      tick();
      other.observe(back(), KLAFF.name);
      expect(other.releaseReturnPassage(back(), KLAFF.name, LIMITS)).toBeFalsy();
      expect(other.holds(MMSI, KLAFF.name)).toBe(true);
    }
  });
});

describe('Appens notisbeslut: bevisad retur får egen notis, väntande båt inte', () => {
  let store;
  let apps;
  let savedTestMode;

  const boot = async () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: (key) => clone(store[key]),
        set: jest.fn((key, value) => {
          store[key] = clone(value);
        }),
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    await app.onInit();
    apps.push(app);
    jest.spyOn(app._boatNearTrigger, 'trigger');
    return app;
  };

  const vesselAt = (offsetM, extra = {}) => ({
    mmsi: MMSI,
    name: 'WILMA',
    ...posAt(offsetM),
    sog: 3,
    cog: SOUTH_COG,
    _routeDirection: 'south',
    _hasMovementProof: true,
    passedBridges: [],
    status: 'en-route',
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now(),
    fixFeed: 'aisstream',
    ...extra,
  });
  const later = (seconds) => jest.setSystemTime(Date.now() + seconds * 1000);
  const notify = (app, vessel, source = 'current') => app._triggerBoatNearFlowForBridge(vessel, {
    name: KLAFF.name,
    id: 'klaffbron',
    distance: geometry.calculateDistance(vessel.lat, vessel.lon, KLAFF.lat, KLAFF.lon),
    source,
  });
  const klaffCalls = (app) => app._boatNearTrigger.trigger.mock.calls
    .map(([tokens]) => tokens)
    .filter((tokens) => tokens.bridge_name === KLAFF.name);
  const north = { _routeDirection: 'north', cog: NORTH_COG };
  const fix = (app, vessel) => app._observeTriggerPointVisits(vessel);

  /** Förvarning söderut och utpassage; båten vänder 150 m söder om bron. */
  async function outboundAndTurn(app) {
    await notify(app, vesselAt(200), 'target');
    expect(klaffCalls(app)).toHaveLength(1);
    later(150);
    const passed = { lastPassedBridge: KLAFF.name, lastPassedBridgeTime: Date.now(), passedBridges: [KLAFF.name] };
    fix(app, vesselAt(5, passed));
    for (const [offsetM, route] of [[-60, 'south'], [-150, 'south'], [-110, 'north'], [-40, 'north']]) {
      later(30);
      fix(app, vesselAt(offsetM, { ...passed, _routeDirection: route, cog: route === 'north' ? NORTH_COG : SOUTH_COG }));
    }
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-15T01:53:10Z'));
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    store = {};
    apps = [];
  });

  afterEach(async () => {
    for (const app of apps) {
      // eslint-disable-next-line no-await-in-loop
      if (!app._shuttingDown) await app.onUninit();
    }
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
    global.__TEST_MODE__ = savedTestMode;
    jest.useRealTimers();
  });

  test('B01: retur bokförd vid linjen får sin notis vid nästa fix, i passerad form', async () => {
    const app = await boot();
    await outboundAndTurn(app);
    later(30);
    const bookedAt = Date.now();
    const atLine = vesselAt(5, {
      ...north, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: bookedAt, passedBridges: [KLAFF.name],
    });
    fix(app, atLine);
    await notify(app, atLine);
    await app._confirmReturnPassages?.(atLine);
    expect(klaffCalls(app)).toHaveLength(1);
    later(20);
    const beyond = vesselAt(45, {
      ...north, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: bookedAt, passedBridges: [KLAFF.name],
    });
    fix(app, beyond);
    await app._confirmReturnPassages?.(beyond);
    const calls = klaffCalls(app);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      direction: 'norrut', already_passed: true, eta_minutes: -1, message: 'WILMA har precis passerat Klaffbron',
    });
    expect(app.log).toHaveBeenCalledWith(expect.stringContaining('bevis ankomstsidan'));
    expect(store.trigger_point_visits.entries[`${MMSI}:${KLAFF.name}`]).toMatchObject({ farSign: 1 });
    await app._confirmReturnPassages?.(beyond);
    await notify(app, beyond);
    expect(klaffCalls(app)).toHaveLength(2);
  });

  test('retur bokförd när båten redan är 45 m ut ger notisen i samma tick (S4)', async () => {
    const app = await boot();
    await outboundAndTurn(app);
    later(30);
    const back = vesselAt(45, {
      ...north, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: Date.now(), passedBridges: [KLAFF.name],
    });
    fix(app, back);
    await notify(app, back);
    expect(klaffCalls(app)).toHaveLength(2);
    expect(klaffCalls(app)[1].message).toBe('WILMA har precis passerat Klaffbron');
  });

  test('returpassage där första fixen ligger utanför notisradien går via failsafen', async () => {
    const app = await boot();
    await outboundAndTurn(app);
    later(60);
    const back = vesselAt(345, {
      ...north, sog: 7, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: Date.now(), passedBridges: [KLAFF.name],
    });
    fix(app, back);
    await app._triggerBoatNearFlowFallback(back, KLAFF.name);
    const calls = klaffCalls(app);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ direction: 'norrut', already_passed: true, message: 'WILMA passerade Klaffbron under AIS-tystnad' });
  });

  test('failsafen släpper inte besöket när dess egna spärrar stoppar notisen (omgranskning 2)', async () => {
    // Revision 3 släppte besöket före FALLBACK_TRIGGER_TOO_FAR: besöksskyddet,
    // dedupnyckeln och den persistenta posten försvann och loggen sa
    // "returpassagen får egen notis", men ingen notis gick ut.
    const app = await boot();
    await outboundAndTurn(app);
    later(540);
    const far = vesselAt(2100, {
      ...north, sog: 8, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: Date.now(), passedBridges: [KLAFF.name],
    });
    fix(app, far);
    await app._triggerBoatNearFlowFallback(far, KLAFF.name);
    expect(klaffCalls(app)).toHaveLength(1);
    expect(app.log).toHaveBeenCalledWith(expect.stringContaining('FALLBACK_TRIGGER_TOO_FAR'));
    expect(app.log).not.toHaveBeenCalledWith(expect.stringContaining('TRIGGER_POINT_VISIT_RETURN'));
    expect(app._triggerPointVisits.holds(MMSI, KLAFF.name)).toBe(true);
    expect(store.trigger_point_visits.entries[`${MMSI}:${KLAFF.name}`]).toMatchObject({ farSign: -1 });
  });

  test('M1/M2: failsafen för Klaffbron släpper på passedAt när Järnvägsbron bokfördes sist', async () => {
    const app = await boot();
    await outboundAndTurn(app);
    later(190);
    const back = vesselAt(300, {
      ...north,
      sog: 4,
      lastPassedBridge: 'Järnvägsbron',
      lastPassedBridgeTime: Date.now(),
      passedAt: { [KLAFF.name]: Date.now(), Järnvägsbron: Date.now() },
      passedBridges: [KLAFF.name, 'Järnvägsbron'],
    });
    fix(app, back);
    await app._triggerBoatNearFlowFallback(back, KLAFF.name, { detectionTs: Date.now() });
    const calls = klaffCalls(app);
    expect(calls).toHaveLength(2);
    expect(calls[1].message).toBe('WILMA passerade Klaffbron under AIS-tystnad');
  });

  test('granskningens fall: vänd, vänta vid linjen och kör tillbaka med falska bokföringar ger ingen andra notis', async () => {
    const app = await boot();
    await outboundAndTurn(app);
    const passedBridges = [KLAFF.name];
    for (const offsetM of [-12, -4, -15, 3, -9, -14]) {
      later(30);
      fix(app, vesselAt(offsetM, {
        ...north, sog: 0.1, cog: 300, passedBridges,
      }));
    }
    later(30);
    const falseBooking = vesselAt(2, {
      ...north, sog: 0.1, cog: 120, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: Date.now(), passedBridges,
    });
    fix(app, falseBooking);
    await notify(app, falseBooking);
    await app._triggerBoatNearFlowFallback(falseBooking, KLAFF.name);
    await app._confirmReturnPassages?.(falseBooking);
    later(30);
    const stillWaiting = vesselAt(35, {
      ...north, sog: 0.1, cog: 20, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: Date.now() - 30000, passedBridges,
    });
    fix(app, stillWaiting);
    await app._confirmReturnPassages?.(stillWaiting);
    later(30);
    const leaving = vesselAt(4, {
      _routeDirection: 'north', sog: 4.5, cog: SOUTH_COG, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: Date.now(), passedBridges,
    });
    fix(app, leaving);
    await notify(app, leaving);
    await app._triggerBoatNearFlowFallback(leaving, KLAFF.name);
    await app._confirmReturnPassages?.(leaving);
    expect(klaffCalls(app)).toHaveLength(1);
    expect(app._triggerPointVisits.holds(MMSI, KLAFF.name)).toBe(true);
  });

  test('en båt som guppar vid bron och får en falsk bokföring utan vändning får ingen andra notis', async () => {
    const app = await boot();
    await notify(app, vesselAt(200), 'target');
    for (const offsetM of [30, -15, 20, -18, 25, -14]) {
      later(30);
      fix(app, vesselAt(offsetM, { sog: 0.3 }));
    }
    later(30);
    const bobbing = vesselAt(20, {
      sog: 0.3, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: Date.now(), passedBridges: [KLAFF.name],
    });
    fix(app, bobbing);
    app._clearBoatNearTriggers(bobbing, true);
    await notify(app, bobbing);
    await app._triggerBoatNearFlowFallback(bobbing, KLAFF.name);
    await app._confirmReturnPassages?.(bobbing);
    expect(klaffCalls(app)).toHaveLength(1);
    expect(app._triggerPointVisits.holds(MMSI, KLAFF.name)).toBe(true);
  });

  test('vändning utan passage tillbaka (båten väntar på bortre sidan) ger ingen andra notis', async () => {
    const app = await boot();
    await outboundAndTurn(app);
    for (let i = 0; i < 6; i++) {
      later(60);
      const waiting = vesselAt(-120, {
        ...north, sog: 0.2, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: Date.now() - 240000 - i * 60000,
      });
      fix(app, waiting);
      // eslint-disable-next-line no-await-in-loop
      await notify(app, waiting);
      // eslint-disable-next-line no-await-in-loop
      await app._confirmReturnPassages?.(waiting);
    }
    expect(klaffCalls(app)).toHaveLength(1);
  });

  test('gles AIS: vänd, bromsa in och vänta vid linjen ger ingen andra notis (omgranskningens svep 2)', async () => {
    const app = await boot();
    await outboundAndTurn(app);
    const passedBridges = [KLAFF.name];
    later(40);
    fix(app, vesselAt(-29, { ...north, passedBridges }));
    later(40);
    const bookedAt = Date.now();
    const arrival = vesselAt(-3.7, {
      ...north, sog: 0.98, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: bookedAt, passedBridges,
    });
    fix(app, arrival);
    await notify(app, arrival);
    await app._triggerBoatNearFlowFallback(arrival, KLAFF.name);
    await app._confirmReturnPassages(arrival);
    for (const [i, offsetM] of [-2, -9, -4, -10, -3, -6, -2, -8].entries()) {
      later(40);
      const waiting = vesselAt(offsetM, {
        _routeDirection: 'north',
        sog: 0.1,
        cog: (i * 67) % 360,
        lastPassedBridge: KLAFF.name,
        lastPassedBridgeTime: bookedAt,
        passedBridges,
      });
      fix(app, waiting);
      // eslint-disable-next-line no-await-in-loop
      await app._confirmReturnPassages(waiting);
    }
    expect(klaffCalls(app)).toHaveLength(1);
    expect(app._triggerPointVisits.holds(MMSI, KLAFF.name)).toBe(true);
  });

  test('U21: korsning i 12 min tystnad, notisen 9 min efter, ger "passerade … under AIS-tystnad"', async () => {
    const app = await boot();
    await outboundAndTurn(app);
    later(12 * 60);
    const back = vesselAt(120, {
      ...north, sog: 3.5, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: Date.now(), passedBridges: [KLAFF.name],
    });
    fix(app, back);
    await notify(app, back);
    const calls = klaffCalls(app);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      direction: 'norrut', already_passed: true, eta_minutes: -1, message: 'WILMA passerade Klaffbron under AIS-tystnad',
    });
  });

  test('långsam retur (1 kn): notisen kommer när båten är 30 m ut, mer än 60 s efter bokföringen', async () => {
    const app = await boot();
    await outboundAndTurn(app);
    const passedBridges = [KLAFF.name];
    later(10);
    fix(app, vesselAt(-20, { ...north, sog: 1, passedBridges }));
    later(10);
    const bookedAt = Date.now();
    const booking = vesselAt(-4.7, {
      ...north, sog: 1, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: bookedAt, passedBridges,
    });
    fix(app, booking);
    await notify(app, booking);
    await app._confirmReturnPassages(booking);
    for (const offsetM of [0.4, 5.5, 10.6, 15.7, 20.8, 25.9, 31]) {
      later(10);
      const slow = vesselAt(offsetM, {
        ...north, sog: 1, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: bookedAt, passedBridges,
      });
      fix(app, slow);
      // eslint-disable-next-line no-await-in-loop
      await app._confirmReturnPassages(slow);
    }
    const calls = klaffCalls(app);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ direction: 'norrut', message: 'WILMA har precis passerat Klaffbron' });
    expect(Date.now() - bookedAt).toBeGreaterThan(WINDOW_MS);
  });

  test('U21: retur bokförd efter 40 min AIS-tystnad ger ingen sen notis', async () => {
    const app = await boot();
    await outboundAndTurn(app);
    later(40 * 60);
    const back = vesselAt(400, {
      ...north, sog: 6, lastPassedBridge: KLAFF.name, lastPassedBridgeTime: Date.now(), passedBridges: [KLAFF.name],
    });
    fix(app, back);
    await app._triggerBoatNearFlowFallback(back, KLAFF.name, { detectionTs: Date.now(), inferredFlush: true });
    await app._confirmReturnPassages?.(back);
    expect(klaffCalls(app)).toHaveLength(1);
    expect(app._triggerPointVisits.holds(MMSI, KLAFF.name)).toBe(true);
  });
});

describe('INV-2 prövar returpassagesläppen mot geometrin', () => {
  const notice = (t, direction) => ({
    t, mmsi: MMSI, bridge: KLAFF.name, direction, eta: -1, success: true,
  });
  const base = (releases) => ({
    notifications: [notice(1000, 'southbound'), notice(400000, 'northbound')],
    visitReturnReleases: releases,
  });

  test('ett släpp med domen bortre sidan fälls och legitimerar inte notisparet', () => {
    const v = validateInvariants(base([{
      t: 60000, mmsi: MMSI, bridge: KLAFF.name, farSign: -1, verdict: 'bortre',
    }]));
    expect(v.some((x) => x.startsWith(`FALSKT RETURSLÄPP: ${MMSI}:Klaffbron`))).toBe(true);
    expect(v.some((x) => x.startsWith(`NOTIS-DUBBLETT: ${MMSI}:Klaffbron`))).toBe(false);
    const sameDirection = validateInvariants({
      notifications: [notice(1000, 'southbound'), notice(400000, 'southbound')],
      visitReturnReleases: [{
        t: 60000, mmsi: MMSI, bridge: KLAFF.name, farSign: -1, verdict: 'bortre',
      }],
    });
    expect(sameDirection.some((x) => x.startsWith(`NOTIS-DUBBLETT: ${MMSI}:Klaffbron`))).toBe(true);
  });

  test('ett släpp med domen för tidig fälls och legitimerar inte notisparet', () => {
    // Omgranskningen 2026-11-05: domen ser också tiden. Ett släpp vid linjen
    // som följs av väntan på bortre sidan och en sen verklig korsning dömdes
    // förut 'ankomst'.
    const v = validateInvariants({
      notifications: [notice(1000, 'southbound'), notice(400000, 'southbound')],
      visitReturnReleases: [{
        t: 400000, mmsi: MMSI, bridge: KLAFF.name, farSign: -1, verdict: 'för tidig',
      }],
    });
    expect(v.some((x) => x.startsWith(`FÖR TIDIGT RETURSLÄPP: ${MMSI}:Klaffbron`))).toBe(true);
    expect(v.some((x) => x.startsWith(`NOTIS-DUBBLETT: ${MMSI}:Klaffbron`))).toBe(true);
  });

  test('ett släpp med domen ankomstsidan legitimerar returnotisen', () => {
    const v = validateInvariants({
      notifications: [notice(1000, 'southbound'), notice(400000, 'southbound')],
      visitReturnReleases: [{
        t: 400000, mmsi: MMSI, bridge: KLAFF.name, farSign: -1, verdict: 'ankomst',
      }],
    });
    expect(v).toEqual([]);
  });
});

describe('Släppets geometriska dom (returnReleaseVerdict)', () => {
  // eslint-disable-next-line global-require
  const { judgeReturnRelease } = require('./replay-validation/returnReleaseVerdict');
  const T0 = Date.parse('2026-01-01T06:12:00Z');
  const sample = (offsetM, dtS) => ({ mmsi: MMSI, aisTimestamp: T0 + dtS * 1000, ...posAt(offsetM) });
  const release = {
    t: T0, mmsi: MMSI, bridge: KLAFF.name, farSign: 1,
  };

  test('omgranskning 2: släppfixen ligger på ankomstsidan men båten väntar kvar på bortre sidan', () => {
    // retur-i60+0-d3-j15-r06-s2 (revision 3): släppfixen −14,3 m, nästa fix
    // +5,2 m och en väntan norr om linjen; korsningen söderut sker 06:25.
    const samples = [sample(13.8, -60), sample(-14.3, 0), sample(5.2, 60), sample(9.2, 120), sample(-2.1, 180),
      sample(15.3, 240), sample(3.7, 360), sample(-96.5, 840), sample(-197.5, 900)];
    expect(judgeReturnRelease(release, samples).verdict).toBe('för tidig');
  });

  test('en verklig retur vid tät kadens tål ett brusigt sampel i fönstret', () => {
    const samples = [sample(5, -10), sample(-31, 0), sample(-8, 10), sample(-45, 20), sample(-52, 30),
      sample(-61, 40), sample(-70, 50), sample(-79, 60), sample(-120, 90)];
    expect(judgeReturnRelease(release, samples)).toMatchObject({ verdict: 'ankomst' });
  });

  test('gles kadens: nästa fix avgör', () => {
    const away = [sample(15, -65), sample(-40, 0), sample(-150, 65)];
    expect(judgeReturnRelease(release, away).verdict).toBe('ankomst');
    const back = [sample(15, -65), sample(-40, 0), sample(4, 65), sample(160, 130)];
    expect(judgeReturnRelease(release, back).verdict).toBe('bortre');
  });
});

describe('Hela appen på buggjägarens repro och granskningens vakt (replay)', () => {
  function replay(file, { monitoring = false } = {}) {
    const env = { ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '' };
    if (monitoring) env.REPLAY_MONITORING = '1';
    else delete env.REPLAY_MONITORING;
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tests/replay-validation/replayRunner.js'), file], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
    });
    return JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
  }
  const iso = (t) => new Date(t).toISOString().slice(11, 19);
  const noticeInvariants = (result) => validateInvariants(result)
    .filter((v) => /MÅLBRO-NOTIS|NOTIS-DUBBLETT|RETURSLÄPP/.test(v));

  test.each([false, true])('B01 WILMA: två passager av Klaffbron ger två notiser (monitoring=%s)', (monitoring) => {
    const result = replay(path.join(FIXTURES, 'n-b01-wilma-retur-inom-besoket.jsonl'), { monitoring });
    const passages = result.targetPassages.filter((p) => p.mmsi === MMSI && p.bridge === KLAFF.name);
    const notices = result.notifications.filter((n) => n.mmsi === MMSI && n.bridge === KLAFF.name);
    expect(passages.map((p) => iso(p.t))).toEqual(['01:56:10', '02:00:10']);
    // Returen bokförs 18 m norr om linjen och bevisas av nästa fix 30 s senare.
    expect(notices.map((n) => [iso(n.t), n.direction, n.alreadyPassed, n.source])).toEqual([
      ['01:53:10', 'southbound', false, 'target'],
      ['02:00:40', 'northbound', true, 'just-passed'],
    ]);
    expect(notices[1].message).toBe('WILMA har precis passerat Klaffbron');
    expect(result.visitReturnReleases).toEqual([
      expect.objectContaining({
        mmsi: MMSI, bridge: KLAFF.name, t: notices[1].t, verdict: 'ankomst',
      }),
    ]);
    expect(noticeInvariants(result)).toEqual([]);
    expect(result.processErrors).toBe(0);
  });

  test('värld 40 XENIA: notis i passerad form, vändning och retur ger två notiser', () => {
    const result = replay(path.join(FIXTURES, 'n-w40-xenia-retur-passerad-form.jsonl'));
    const notices = result.notifications.filter((n) => n.mmsi === '265090307' && n.bridge === KLAFF.name);
    expect(notices.map((n) => [iso(n.t), n.direction, n.alreadyPassed])).toEqual([
      ['12:50:15', 'northbound', true],
      ['12:56:56', 'southbound', true],
    ]);
    expect(result.visitReturnReleases).toEqual([
      expect.objectContaining({ mmsi: '265090307', bridge: KLAFF.name, verdict: 'ankomst' }),
    ]);
    expect(noticeInvariants(result)).toEqual([]);
    expect(result.processErrors).toBe(0);
  });

  // Omgranskning 2 (2026-11-07), granskarens P1-exempel ur gen.js
  // (K/N/tmp/rr2/scripts/mk-p1.js, geupp/retur-i60+0-d3-j15-r06-s2): båten
  // passerar Klaffbron norrut, vänder 150 m bortom, bromsar in och väntar
  // 15 min 3 m norr om linjen. AIS rapporterar 0,6 kn och slumpad kurs, bruset
  // är ±15 m och kadensen 60 s. 06:12:00 lägger bruset henne 14,3 m söder om
  // linjen. Revision 3 släppte där (gles-korsning) och skickade en falsk
  // "har precis passerat" söderut.
  test('P1 ge upp: väntan vid linjen i 0,6 kn med ±15 m brus ger en notis', () => {
    const result = replay(path.join(FIXTURES, 'n-p1-vantar-vid-linjen-ger-upp.jsonl'));
    expect(result.notifications.filter((n) => n.bridge === KLAFF.name)).toHaveLength(1);
    expect(result.visitReturnReleases).toEqual([]);
    expect(validateInvariants(result).filter((v) => /NOTIS-DUBBLETT|RETURSLÄPP/.test(v))).toEqual([]);
  });

  test('P1 retur: samma väntan följd av en verklig passage söderut får notisen efter korsningen', () => {
    // Sann korsning 06:25:01,7 (generatorns s-profil). Revision 3 släppte
    // 06:12:00, 13 min för tidigt. Utan undantaget för den förtida
    // bokföringen på bortre sidan (06:11:00, 13,8 m norr om linjen) missades
    // returen helt, eftersom passagelogiken inte bokför igen vid korsningen.
    const result = replay(path.join(FIXTURES, 'n-p1-vantar-vid-linjen-retur.jsonl'));
    const notices = result.notifications.filter((n) => n.bridge === KLAFF.name);
    expect(notices.map((n) => n.direction)).toEqual(['northbound', 'southbound']);
    const trueCrossing = Date.parse('2026-01-01T06:25:01.666Z');
    expect(notices[1].t).toBeGreaterThan(trueCrossing);
    expect(notices[1].t - trueCrossing).toBeLessThan(3 * 60 * 1000);
    expect(result.visitReturnReleases).toEqual([
      expect.objectContaining({ bridge: KLAFF.name, verdict: 'ankomst', evidence: 'ankomstsidan-två-fixar' }),
    ]);
    expect(validateInvariants(result).filter((v) => /NOTIS-DUBBLETT|RETURSLÄPP|MISSAD/.test(v))).toEqual([]);
  });

  test('granskningens vakt: vänd 150 m bortom, vänta 10 m från linjen med ±10 m brus, kör vidare', () => {
    const M = pathMetrics(buildPath());
    const K = M.cum[2];
    const samples = generateScenario({
      seed: 120,
      vessels: [{
        mmsi: '901010101',
        name: 'SVEP-D10-J10',
        jitterM: 10,
        startS: K - 700,
        legs: [
          { toS: K + 150, speedKn: 4.5, intervalS: 10 },
          { toS: K + 10, speedKn: 3, intervalS: 10 },
          { stopS: 1800, stopIntervalS: 30, stopCogRandom: true },
          { toS: K + 800, speedKn: 4.5, intervalS: 10 },
        ],
      }],
    });
    const file = path.join(process.env.TMPDIR || require('os').tmpdir(), `u14-vakt-${process.pid}.jsonl`);
    require('fs').writeFileSync(file, `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`);
    try {
      const result = replay(file);
      const notices = result.notifications.filter((n) => n.bridge === KLAFF.name);
      expect(notices).toHaveLength(1);
      expect(result.visitReturnReleases).toEqual([]);
      expect(validateInvariants(result).filter((v) => /NOTIS-DUBBLETT|RETURSLÄPP/.test(v))).toEqual([]);
    } finally {
      require('fs').unlinkSync(file);
    }
  });
});
