'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

/**
 * =============================================================================
 * H17 (helkodsgranskning 2026-08-22) — ECHO-HÅLLNINGEN KRINGGICK 90 s-TAKET
 * =============================================================================
 *
 * MEKANISMEN. holdImminentForUncertain behåller föregående
 * _isImminentAtTargetBridge när _positionUncertain eller _gpsJumpDetected är
 * satt (echo-gaten 2026-07-02b: ett bakåtlevererat gammalt sampel ska inte
 * släcka och tända "strax" per tick). Hållningen hoppar då över HELA
 * återhärledningen — inklusive B4/F10:s tak "uttömd-strax håller max 90 s".
 * Flaggorna ärvs av _createVesselObject och ett accepterat osäkert sampel
 * stämplar om positionsklockan, så hållningens enda tak blev STALE_ETA_HARD
 * (10 min): falskt "beräknad broöppning strax" i upp till 10,5 min på en
 * gissning som skulle ha levt 90 s. Samma ZWERK-/PHILULA-klass som B4 och
 * F10 en gång stängde.
 *
 * FIXEN. Taket prövas FÖRE hållningen: en flagga som seedats av den uttömda
 * grenen (_imminentFromExhausted) släcks när IMMINENT_EXHAUSTED_MAX_AGE_MS
 * passerat. Hållningen som sådan står kvar (echo-gaten äger fortfarande
 * beslutet att inte härleda om från en osäker position), och REN
 * NÄRHETSBEVISAD imminent (<=300 m, _imminentFromExhausted=false) berörs
 * inte alls.
 *
 * SAKNAD STÄMPEL = UTGÅNGEN: ETA-blocket nollar _etaExhaustedAtMs i samma
 * andetag som _etaExtrapolationExhausted (bl.a. i HARD-zonen), och utan den
 * regeln hade en nollad stämpel frusit flaggan igen.
 */

const REAL_DATE_NOW = Date.now;

// Riggen är A3R2-1:s (fable-omgang2), som redan låser SET-grenens 90 s-tak
// på den RENA vägen — här provas HÅLLNINGEN.
function makeRig({ distM = 340, ...vesselOverrides } = {}) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app.bridgeRegistry = new BridgeRegistry();
  app.proximityService = {
    analyzeVesselProximity: () => ({ nearestBridge: null, nearestDistance: 999, bridgeDistances: {} }),
  };
  app.statusService = { analyzeVesselStatus: jest.fn(() => ({ status: 'en-route' })) };
  const KLAFF = app.bridgeRegistry.getBridgeByName('Klaffbron');
  const vessel = {
    mmsi: '265992017',
    lat: KLAFF.lat + distM / 111320,
    lon: KLAFF.lon,
    sog: 4,
    cog: 200,
    status: 'en-route',
    targetBridge: 'Klaffbron',
    timestamp: Date.now() - 6 * 60 * 1000,
    lastPositionUpdate: Date.now() - 6 * 60 * 1000,
    ...vesselOverrides,
  };
  app.vesselDataService = { getAllVessels: () => [vessel], hasGpsJumpHold: () => false };
  return { app, vessel };
}

const debugText = (app) => app.debug.mock.calls.map((c) => c.join(' ')).join('\n');

describe('H17: uttömd "strax" överlever inte 90 s bakom echo-hållningen', () => {
  let mockNow;
  beforeEach(() => {
    mockNow = 1700000000000;
    Date.now = () => mockNow;
  });
  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  test('MUTATIONSPROVET: exhausted-seedad flagga + GPS-osäkerhet ⇒ släpps efter taket', () => {
    const { app, vessel } = makeRig({
      _etaExtrapolationExhausted: true,
      _etaExhaustedAtMs: mockNow - 10 * 1000, // uttömd för 10 s sedan
    });

    // Tick 1 (rent sampel): SET-grenen seedar flaggan inom 90 s-fönstret.
    app._reevaluateVesselStatuses();
    expect(vessel._isImminentAtTargetBridge).toBe(true);
    expect(vessel._imminentFromExhausted).toBe(true);

    // Tick 2: taket passerat OCH ett GPS-osäkert sampel har landat. Före
    // fixen höll echo-gaten flaggan sann ända till STALE_ETA_HARD.
    mockNow += 91 * 1000;
    vessel._positionUncertain = true;
    vessel.timestamp = mockNow - 60 * 1000; // positionsklockan omstämplad = FÄRSK
    vessel.lastPositionUpdate = mockNow - 60 * 1000;
    app._reevaluateVesselStatuses();

    expect(vessel._isImminentAtTargetBridge).toBe(false);
    expect(debugText(app)).toContain('IMMINENT_HOLD_EXPIRED');
  });

  test('samma sak när GPS-HOPP (inte osäkerhet) bär hållningen', () => {
    const { app, vessel } = makeRig({
      _etaExtrapolationExhausted: true,
      _etaExhaustedAtMs: mockNow - 10 * 1000,
    });
    app._reevaluateVesselStatuses();
    expect(vessel._isImminentAtTargetBridge).toBe(true);

    mockNow += 120 * 1000;
    vessel._gpsJumpDetected = true;
    vessel.timestamp = mockNow - 30 * 1000;
    vessel.lastPositionUpdate = mockNow - 30 * 1000;
    app._reevaluateVesselStatuses();

    expect(vessel._isImminentAtTargetBridge).toBe(false);
  });

  test('INOM taket håller echo-gaten som förut (fixen är ett TAK, ingen rivning)', () => {
    const { app, vessel } = makeRig({
      _etaExtrapolationExhausted: true,
      _etaExhaustedAtMs: mockNow - 10 * 1000,
    });
    app._reevaluateVesselStatuses();
    expect(vessel._isImminentAtTargetBridge).toBe(true);

    mockNow += 40 * 1000; // 50 s sedan uttömningen — under 90 s
    vessel._positionUncertain = true;
    vessel.timestamp = mockNow - 10 * 1000;
    vessel.lastPositionUpdate = mockNow - 10 * 1000;
    app._reevaluateVesselStatuses();

    expect(vessel._isImminentAtTargetBridge).toBe(true);
    expect(debugText(app)).not.toContain('IMMINENT_HOLD_EXPIRED');
  });

  test('REN NÄRHETSBEVISAD imminent (<=300 m) hålls kvar — echo-gaten orörd', () => {
    const { app, vessel } = makeRig({ distM: 250 });
    app._reevaluateVesselStatuses();
    expect(vessel._isImminentAtTargetBridge).toBe(true);
    expect(vessel._imminentFromExhausted).toBe(false);

    mockNow += 10 * 60 * 1000; // långt bortom 90 s
    vessel._positionUncertain = true;
    vessel.timestamp = mockNow - 30 * 1000;
    vessel.lastPositionUpdate = mockNow - 30 * 1000;
    app._reevaluateVesselStatuses();

    // Hållningen är till för närhetsbevisad flapp och ska bestå.
    expect(vessel._isImminentAtTargetBridge).toBe(true);
    expect(debugText(app)).not.toContain('IMMINENT_HOLD_EXPIRED');
  });

  test('SAKNAD STÄMPEL RÄKNAS SOM UTGÅNGEN (HARD-nollningen får inte frysa flaggan)', () => {
    const { app, vessel } = makeRig({
      _isImminentAtTargetBridge: true,
      _imminentFromExhausted: true,
      _etaExtrapolationExhausted: true,
      _etaExhaustedAtMs: null, // nollad av ETA-blockets HARD-gren
      _positionUncertain: true,
    });

    app._reevaluateVesselStatuses();

    expect(vessel._isImminentAtTargetBridge).toBe(false);
    expect(debugText(app)).toContain('IMMINENT_HOLD_EXPIRED');
  });

  test('raden loggas EN gång per uttömning (ingen tick-spam)', () => {
    const { app, vessel } = makeRig({
      _isImminentAtTargetBridge: true,
      _imminentFromExhausted: true,
      _etaExtrapolationExhausted: true,
      _etaExhaustedAtMs: mockNow - 5 * 60 * 1000,
      _positionUncertain: true,
    });

    app._reevaluateVesselStatuses();
    mockNow += 30 * 1000;
    vessel.timestamp = mockNow - 10 * 1000;
    vessel.lastPositionUpdate = mockNow - 10 * 1000;
    app._reevaluateVesselStatuses();

    const rader = debugText(app).split('\n').filter((r) => r.includes('IMMINENT_HOLD_EXPIRED'));
    expect(rader).toHaveLength(1);
    expect(vessel._isImminentAtTargetBridge).toBe(false);
  });
});

describe('H17: konstanten', () => {
  test('SET-grenen och släppvillkoret delar EXAKT samma gräns (90 s)', () => {
    const src = require('fs').readFileSync(require('path').resolve(__dirname, '../app.js'), 'utf8');
    // Talet får bara bo på ETT ställe — glider de isär återuppstår H17 tyst.
    expect(src).toContain('const IMMINENT_EXHAUSTED_MAX_AGE_MS = 90 * 1000;');
    const konsumenter = src.match(/exhausted\w*AgeMs\s*[<>]=?\s*IMMINENT_EXHAUSTED_MAX_AGE_MS/g) || [];
    expect(konsumenter.length).toBe(2);
    // …och ingen inbakad 90-sekunderslitteral finns kvar i imminent-blocket.
    expect(src).not.toContain('exhaustedAgeMs <= 90 * 1000');
  });
});
