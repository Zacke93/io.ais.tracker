'use strict';

jest.mock('homey');

/**
 * Fältprov 6 (körningen 20260711-134232, ~7 h, 8 fartyg, 12 notiser) —
 * rad-för-rad-läst av 23 Opus 4.8 max-läsare (127 fynd: 0 critical, 5 major
 * — ALLA fem samma händelse). Pelare 2 var PERFEKT (12 notiser = 12 verkliga
 * passager, 0 miss/fantom/dubblett). Denna svit låser fixarna:
 *
 *   FP6-1 (KNIGHT OWL, det enda äkta pelare 1-felet): target-transitionen
 *     rensar BÅDE ETA-historik och fartbuffert → nästa beräkning för en
 *     nära-stillastående båt saknar all dämpning (outlier: no_history, EMA
 *     utan baslinje) och 0,5 kn-golvet publicerades rått — "beräknad
 *     broöppning om 57 minuter" i ~10 min för en båt som låg och förtöjde
 *     354 m norr om Klaffbron. Kontrast i samma körning: med historik kvar
 *     kapade outlier-skyddet ett identiskt golvfabrikat 23,9→3,8 min.
 *     Fix: _postTransitionStationaryHold — armeras av äkta BRO-TILL-BRO-
 *     målbyten (BÅDA rensningsvägarna: VDS 'target_transition_X_to_Y' och
 *     app.js STEG 1 'target_bridge_change_X_to_Y' — dubbelclearen i samma
 *     tick raderade annars holden, verifierat i replay); stationär (≤0,3 kn)
 *     ⇒ ETA null ("ETA okänd") tills första provet med verklig fart.
 *     SPIKEN/AIR-skyddet: '..._none_to_X' (första tilldelningen) armerar
 *     ALDRIG — stillaliggare med långlivat mål behåller sin golden-låsta
 *     långa ETA.
 *   FP6-2: cog=null renderades som "undefined°" i PROXIMITY_ANALYSIS
 *     (217 rader/körning) — nu "okänd".
 *   FP6-3: ZONE_TRANSITION är en tillståndsbeskrivning som återloggades
 *     varje cykel (82× för frusen båt i skyddszon) — loggen dedupas per
 *     mmsi+bro tills transitionen ändras (result-strukturen orörd).
 *
 * Replay-verifierat mot körningens rådata: ENDA diffen är 57-min-raden →
 * "ETA okänd" (+ den redundanta degraderingsraden 13:16 försvinner);
 * alla 12 notiser och övriga 24 texter identiska.
 */

const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const ProximityService = require('../lib/services/ProximityService');

global.__TEST_MODE__ = true;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

const KLAFFBRON = { name: 'Klaffbron', lat: 58.28409551543077, lon: 12.283929525245636 };

const makeCalc = () => new ProgressiveETACalculator(makeLogger(), {
  getBridgeByName: (name) => (name === 'Stridsbergsbron'
    ? { name: 'Stridsbergsbron', lat: 58.29352, lon: 12.294323 }
    : KLAFFBRON),
  getBridgeById: (id) => (id === 'stridsbergsbron'
    ? { name: 'Stridsbergsbron', lat: 58.29352, lon: 12.294323 }
    : KLAFFBRON),
  normalizeToId: (x) => (typeof x === 'string' ? x.toLowerCase() : x),
  getNameById: (id) => (id === 'stridsbergsbron' ? 'Stridsbergsbron' : 'Klaffbron'),
  getDistanceBetweenBridges: () => 1300,
});

// KNIGHT OWL-geometrin: 354 m norr om Klaffbron, target Stridsbergsbron (882 m)
const knightOwl = (sog) => ({
  mmsi: '265025880', lat: 58.28717, lon: 12.28553, sog, cog: null, targetBridge: 'Stridsbergsbron',
});

describe('FP6-1: post-transition stationär-hold (KNIGHT OWL 57-min-fabrikatet)', () => {
  let calc;

  beforeEach(() => {
    calc = makeCalc();
  });

  afterEach(() => {
    calc.destroy();
  });

  // FP7-1 (2026-07-12, NICOLINE) utökade holden med 'eta_stale_hard'-
  // armeringen. OBS: den GENERELLA varianten ("stationär + tom/stale
  // historik ⇒ null" utan armering) PRÖVADES OCH ÅTERTOGS — den fällde 6–7
  // korpusgoldens + FATAL ETA-oscillation (kö-båtar i väntläge har samma
  // signatur som förtöjare). Armeringssignalerna är de smala, säkra vägarna.

  test('VDS-vägens reason (target_transition_X_to_Y) + stationär ⇒ ETA null i stället för 57 min', () => {
    calc.clearVesselETAHistory('265025880', 'target_transition_Klaffbron_to_Stridsbergsbron');
    expect(calc._getEffectiveSpeed(knightOwl(0.1))).toBeNull();
    expect(calc.calculateProgressiveETA(knightOwl(0.1), null)).toBeNull(); // ⇒ "ETA okänd"
  });

  test('app.js STEG 1-vägens reason (target_bridge_change_X_to_Y) armerar också', () => {
    calc.clearVesselETAHistory('265025880', 'target_bridge_change_Klaffbron_to_Stridsbergsbron');
    expect(calc._getEffectiveSpeed(knightOwl(0.1))).toBeNull();
  });

  test('FP7-1: armStationaryHold (eta_stale_hard) — NICOLINE-fallet ("om 101 minuter" på 0,1 kn efter dödförklarad position)', () => {
    // Armeringen rör INTE historiken — bygg först en baslinje och verifiera
    // att en RÖRLIG återkomst behåller den (korpusdämpningen orörd).
    const nicoline = { ...knightOwl(0.1), mmsi: '211727200' };
    expect(calc.calculateProgressiveETA({ ...nicoline, sog: 4.0 }, null)).not.toBeNull(); // baslinje byggd
    calc.armStationaryHold('211727200', 'eta_stale_hard');
    expect(calc._getEffectiveSpeed(nicoline)).toBeNull(); // stationär ⇒ ETA okänd trots baslinje
    // ...rörlig återkomst släpper holden och dämpningshistoriken är INTAKT
    expect(calc._getEffectiveSpeed({ ...nicoline, sog: 3.5 })).toBeGreaterThan(0.5);
    expect(calc._etaHistory.get('211727200')).toBeDefined(); // historiken rördes aldrig
  });

  test('DUBBELCLEAREN (transition följt av bridge_change i samma tick) behåller holden — replay-fällan', () => {
    calc.clearVesselETAHistory('265025880', 'target_transition_Klaffbron_to_Stridsbergsbron');
    calc.clearVesselETAHistory('265025880', 'target_bridge_change_Klaffbron_to_Stridsbergsbron');
    expect(calc._getEffectiveSpeed(knightOwl(0.1))).toBeNull();
  });

  test('första provet med verklig fart släpper holden — numerisk ETA återupptas', () => {
    calc.clearVesselETAHistory('265025880', 'target_transition_Klaffbron_to_Stridsbergsbron');
    expect(calc._getEffectiveSpeed(knightOwl(0.1))).toBeNull();
    const speed = calc._getEffectiveSpeed(knightOwl(4.2));
    expect(speed).toBeGreaterThan(0.5); // rörlig ⇒ äkta fart används
    expect(calc._getEffectiveSpeed(knightOwl(0.1))).not.toBeNull(); // holden släppt
  });

  test('KÖ-/SPIKEN-skyddet: första tilldelningen (none_to_X) armerar ALDRIG — golv-ETA behålls', () => {
    calc.clearVesselETAHistory('265025880', 'target_bridge_change_none_to_Stridsbergsbron');
    const speed = calc._getEffectiveSpeed(knightOwl(0.1));
    expect(speed).toBe(0.5); // kö-/stillaliggarklassens golden-låsta golvbeteende
  });

  test('målsläpp (X_to_none) och removal städar holden', () => {
    calc.clearVesselETAHistory('265025880', 'target_transition_Klaffbron_to_Stridsbergsbron');
    calc.clearVesselETAHistory('265025880', 'target_bridge_change_Stridsbergsbron_to_none');
    expect(calc._getEffectiveSpeed(knightOwl(0.1))).toBe(0.5); // hold städad

    calc.clearVesselETAHistory('265025880', 'target_transition_Klaffbron_to_Stridsbergsbron');
    calc.clearVesselETAHistory('265025880', 'vessel_removed_timeout');
    expect(calc._getEffectiveSpeed(knightOwl(0.1))).toBe(0.5); // hold städad
  });

  test('sog=null (CG2-7) har företräde — fortsatt null oavsett hold', () => {
    calc.clearVesselETAHistory('265025880', 'target_transition_Klaffbron_to_Stridsbergsbron');
    expect(calc._getEffectiveSpeed(knightOwl(null))).toBeNull();
  });

  test('destroy tömmer hold-setten', () => {
    calc.clearVesselETAHistory('265025880', 'target_transition_Klaffbron_to_Stridsbergsbron');
    calc.destroy();
    expect(calc._postTransitionStationaryHold.size).toBe(0);
    calc = makeCalc(); // för afterEach-destroy
  });
});

describe('FP6-2/3: proximity-loggens kosmetik', () => {
  test('cog=null renderas som "okänd", inte "undefined°"', () => {
    const logger = makeLogger();
    const svc = new ProximityService({ getAllBridges: () => [] }, logger);
    svc._logProximityAnalysis(
      { mmsi: '265025880', sog: 0.1, cog: null },
      {
        nearestBridge: KLAFFBRON, nearestDistance: 354, isApproaching: false, withinProtectionZone: false, underBridge: false, zoneTransitions: [],
      },
    );
    const payload = logger.debug.mock.calls[0][1];
    expect(payload.course).toBe('okänd');
    expect(payload.speed).toBe('0.1kn');
  });

  test('ZONE_TRANSITION loggas EN gång per oförändrad zon, igen vid ändring', () => {
    const logger = makeLogger();
    const svc = new ProximityService({ getAllBridges: () => [] }, logger);
    const result = (transition) => ({
      nearestBridge: KLAFFBRON,
      nearestDistance: 199,
      isApproaching: false,
      withinProtectionZone: true,
      underBridge: false,
      zoneTransitions: [{ transition, bridgeName: 'Klaffbron', distance: 199 }],
    });
    const zoneLogs = () => logger.debug.mock.calls
      .filter((c) => typeof c[0] === 'string' && c[0].includes('[ZONE_TRANSITION]')).length;

    svc._logProximityAnalysis({ mmsi: '265573130', sog: 6.2, cog: 191 }, result('entered_protection_zone'));
    svc._logProximityAnalysis({ mmsi: '265573130', sog: 6.2, cog: 191 }, result('entered_protection_zone'));
    svc._logProximityAnalysis({ mmsi: '265573130', sog: 6.2, cog: 191 }, result('entered_protection_zone'));
    expect(zoneLogs()).toBe(1); // 82×-spammen borta

    svc._logProximityAnalysis({ mmsi: '265573130', sog: 6.2, cog: 191 }, result('entered_under_bridge'));
    expect(zoneLogs()).toBe(2); // äkta övergång loggas
  });
});
