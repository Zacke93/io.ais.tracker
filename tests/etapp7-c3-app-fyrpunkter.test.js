'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const {
  BRIDGE_TEXT_CONSTANTS,
  PASSAGE_TIMING,
  PROTECTION_ZONE_RADIUS,
  UNDER_BRIDGE_CLEAR_DISTANCE,
  BRIDGES,
} = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

/**
 * ETAPP 7, FAS C ETAPP III — P-APP:s fyra punkter i app.js.
 *
 * C1  — [err]-kedjan: (a) hold-replay valideras inte om, (b) validatorns
 *       100 m blir konstant med hold-medveten gräns, (c) nödfallbacken faller
 *       inte till DEFAULT när en båt ligger i passed-fönstret vid målbro.
 * C2  — ETA-clampens släppgrind vid målbron.
 * C3b — persist-debounce för sista-kända-positioner (+ force i onUninit).
 * C5  — MEDVETET EJ INFÖRD grind; kvar finns bara diagnostikraden. Testerna
 *       nedan LÅSER att failsafen fortfarande fyrar på en enkelsampels-episod,
 *       eftersom ≥2-sampelkravet mätt bort 191 av 337 failsafe-notiser i
 *       korpusarna — däribland 7 av de 9 fältverifierade i korpus #18.
 */

const MIN = 60 * 1000;
const DEFAULT = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
const KLAFF = Object.values(BRIDGES).find((b) => b.name === 'Klaffbron');

/** Punkt norr om bron på ungefär `meters` avstånd (latitudförskjutning). */
const northOf = (bridge, meters) => ({
  lat: bridge.lat + (meters / 111320),
  lon: bridge.lon,
});

const riggApp = () => {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app._isConnected = true;
  app._lastConnectionLost = null;
  app._updateDeviceCapability = jest.fn();
  app._globalBridgeTextToken = null;
  app.vesselDataService = { hasGpsJumpHold: () => false };
  // Validatorn läser bridgeRegistry.bridges — utan den kastar den och hela
  // resultatet blir 'validation_error', vilket hade dolt vad testerna mäter.
  app.bridgeRegistry = {
    bridges: { klaffbron: KLAFF },
    getBridgeByName: (n) => (n === 'Klaffbron' ? KLAFF : null),
  };
  return app;
};

const makeSnapshot = (vessels) => ({
  vesselCount: vessels.length,
  relevantVessels: vessels,
  vesselsBeingRemoved: new Set(),
  timestamp: Date.now(),
});

// =============================================================================
// C1a — hold-replay hoppar summeringsvalideringen
// =============================================================================
describe('Bekräftad passage avslutar brotexten och går genom normal validering', () => {
  let app;

  beforeEach(() => {
    app = riggApp();
    // Textmotorn ger DEFAULT (målbropassagen nollade targetBridge) ⇒
    // PASSED_HOLD_UI byter till _lastBridgeText.
    app.bridgeTextService = { generateBridgeText: jest.fn(() => DEFAULT) };
  });

  test('Förra textens två båtar ersätts av default efter sista passagen', async () => {
    app._lastBridgeText = 'Två båtar på väg mot Stridsbergsbron, beräknad broöppning strax';
    const spy = jest.spyOn(app, '_validateBridgeTextSummary');

    await app._processUIUpdate(makeSnapshot([{
      mmsi: '265788210',
      targetBridge: null, // TARGET_END nollade målbron
      lastPassedBridge: 'Stridsbergsbron',
      lastPassedBridgeTime: Date.now() - 10 * 1000,
    }]));

    expect(app.debug).not.toHaveBeenCalledWith(expect.stringContaining('PASSED_HOLD_UI'));
    expect(app.debug).not.toHaveBeenCalledWith(expect.stringContaining('SUMMARY_VALIDATION_SKIP'));
    expect(spy).toHaveBeenCalledTimes(1);
    // SVÄLJ-FÄLLAN: [err]-paret är exakt två app.error-anrop. Noll är kravet.
    expect(app.error).not.toHaveBeenCalled();
    const published = app._updateDeviceCapability.mock.calls
      .filter((c) => c[0] === 'bridge_text').map((c) => c[1]);
    expect(published).toContain(DEFAULT);
    expect(published).toContain(app._lastBridgeText);
  });

  test('FÖRFIX-BEVIS: samma läge utan hoppet ger kritiskt count-larm (grinden mäter något)', async () => {
    app._lastBridgeText = 'Två båtar på väg mot Stridsbergsbron, beräknad broöppning strax';
    app.bridgeRegistry = { bridges: { klaffbron: KLAFF } };
    // Kör validatorn DIREKT på hold-replayens indata — det är exakt vad
    // förfix-koden gjorde. Utan C1a smäller den kritiskt.
    const res = app._validateBridgeTextSummary(app._lastBridgeText, [{
      mmsi: '265788210',
      targetBridge: null,
      lastPassedBridge: 'Stridsbergsbron',
      lastPassedBridgeTime: Date.now() - 10 * 1000,
    }], makeSnapshot([{ mmsi: '265788210' }]));

    expect(res.isValid).toBe(false);
    expect(res.reason).toContain('vessels provided');
    // …och fallbacken var byte-identisk med indata = ren no-op.
    expect(res.fallbackText).toBe(DEFAULT);
  });

  test('UTAN hold (mellanbropassage) körs valideringen som förut — hoppet är inte svepande', async () => {
    app._lastBridgeText = 'Två båtar på väg mot Stridsbergsbron, beräknad broöppning strax';
    const spy = jest.spyOn(app, '_validateBridgeTextSummary');

    await app._processUIUpdate(makeSnapshot([{
      mmsi: '265788210',
      targetBridge: null,
      lastPassedBridge: 'Olidebron', // mellanbro ⇒ ingen hold-gren
      lastPassedBridgeTime: Date.now() - 10 * 1000,
    }]));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(app.debug).not.toHaveBeenCalledWith(expect.stringContaining('SUMMARY_VALIDATION_SKIP'));
  });

  test('En ensam passerad båt tas också bort direkt', async () => {
    // Fältprovets 94 hold-passager nämnde alla EN båt och undgick larmet på
    // aritet. C1a får inte ändra utfallet för dem.
    app._lastBridgeText = 'En båt på väg mot Klaffbron, beräknad broöppning strax';

    await app._processUIUpdate(makeSnapshot([{
      mmsi: '265810170',
      targetBridge: null,
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 10 * 1000,
    }]));

    const published = app._updateDeviceCapability.mock.calls
      .filter((c) => c[0] === 'bridge_text').map((c) => c[1]);
    expect(published).toContain(DEFAULT);
    expect(app.error).not.toHaveBeenCalled();
  });
});

// =============================================================================
// C1b — validatorns under-bridge-gräns är hold-medveten
// =============================================================================
describe('C1b: under-bridge-gränsen följer BRIDGE_OPENING-hållningens egen ventil', () => {
  let app;

  beforeEach(() => {
    app = riggApp();
    app.bridgeRegistry = { bridges: { klaffbron: KLAFF } };
  });

  const vesselAt = (meters, holdMs) => {
    const p = northOf(KLAFF, meters);
    return {
      mmsi: '265705550',
      status: 'under-bridge',
      targetBridge: null,
      lat: p.lat,
      lon: p.lon,
      etaMinutes: null,
      _bridgeOpeningUntil: holdMs,
    };
  };

  test('263 m MED aktiv hållning ⇒ ingen inkonsistens (hållningen släpper först vid 300 m)', () => {
    const res = app._validateStatusConsistency([vesselAt(263, Date.now() + 20 * 1000)]);
    expect(res.passed).toBe(true);
    expect(res.details.inconsistencyCount).toBe(0);
  });

  test('263 m UTAN hållning ⇒ inkonsistens kvarstår (100 m-gränsen biter som förut)', () => {
    const res = app._validateStatusConsistency([vesselAt(263, null)]);
    expect(res.passed).toBe(false);
    expect(res.issue).toContain('from nearest bridge');
    expect(res.issue).toContain('gräns 100m');
  });

  test('UTGÅNGEN hållning behandlas som ingen hållning', () => {
    const res = app._validateStatusConsistency([vesselAt(263, Date.now() - 1000)]);
    expect(res.passed).toBe(false);
  });

  test('340 m MED hållning ⇒ inkonsistens ÄNDÅ (gränsen höjs, tas inte bort)', () => {
    const res = app._validateStatusConsistency([vesselAt(340, Date.now() + 20 * 1000)]);
    expect(res.passed).toBe(false);
    expect(res.issue).toContain('broöppningshållning aktiv');
  });

  test('loggraden namnger den gräns som FAKTISKT tillämpades', () => {
    const held = app._validateStatusConsistency([vesselAt(340, Date.now() + 20 * 1000)]);
    expect(held.issue).toContain(`gräns ${PROTECTION_ZONE_RADIUS}m`);
    const plain = app._validateStatusConsistency([vesselAt(263, null)]);
    expect(plain.issue).toContain(`gräns ${UNDER_BRIDGE_CLEAR_DISTANCE + 30}m`);
    expect(plain.issue).not.toContain('broöppningshållning');
  });

  test('90 m under bron ⇒ ingen inkonsistens oavsett hållning (basvärdet oförändrat)', () => {
    expect(app._validateStatusConsistency([vesselAt(90, null)]).passed).toBe(true);
    expect(app._validateStatusConsistency([vesselAt(90, Date.now() + 20 * 1000)]).passed).toBe(true);
  });

  test('tre båtar i strax-bandet behåller detaljerad brotext utan falskt statusfel', () => {
    const boats = [1.6, 1.8, 2.9].map((etaMinutes, i) => ({
      ...vesselAt(30, null), mmsi: String(265700000 + i), targetBridge: 'Klaffbron', etaMinutes,
    }));
    expect(app._validateStatusConsistency(boats).passed).toBe(true);
    expect(app._validateStatusConsistency(boats.map((v) => ({ ...v, etaMinutes: 3 }))).passed).toBe(false);
  });
});

// =============================================================================
// C1c — nödfallbacken faller inte till DEFAULT i passed-fönstret
// =============================================================================
describe('Nödfallbacken återupplivar inte en passerad båt', () => {
  let app;

  beforeEach(() => {
    app = riggApp();
    app.bridgeTextService = { generateBridgeText: jest.fn(() => DEFAULT) };
  });

  const passedVessel = (ageMs) => ({
    mmsi: '304028000',
    targetBridge: null, // ⇒ 0 renderbara
    lastPassedBridge: 'Klaffbron',
    lastPassedBridgeTime: Date.now() - ageMs,
  });

  test('0 renderbara efter färsk passage ger default', () => {
    app._lastBridgeText = 'En båt på väg mot Klaffbron, beräknad broöppning strax';
    const out = app._generateSafeFallbackText([passedVessel(10 * 1000)], 'trasig text');
    expect(out).toBe(DEFAULT);
    expect(app.debug).not.toHaveBeenCalledWith(expect.stringContaining('FALLBACK_PASSED_HOLD'));
  });

  test('passed-fönstret utgånget ⇒ DEFAULT (ingen zombie-text)', () => {
    app._lastBridgeText = 'En båt på väg mot Klaffbron, beräknad broöppning strax';
    const out = app._generateSafeFallbackText([passedVessel(PASSAGE_TIMING.PASSED_HOLD_MS + 5000)], null);
    expect(out).toBe(DEFAULT);
  });

  test('mellanbropassage ⇒ DEFAULT (endast MÅLBRO håller)', () => {
    app._lastBridgeText = 'En båt på väg mot Klaffbron, beräknad broöppning strax';
    const v = passedVessel(10 * 1000);
    v.lastPassedBridge = 'Järnvägsbron';
    expect(app._generateSafeFallbackText([v], null)).toBe(DEFAULT);
  });

  test('BT-F5 består: frånkopplingstexten återpubliceras ALDRIG', () => {
    app._lastBridgeText = 'AIS-anslutning saknas — data kan vara inaktuell';
    expect(app._generateSafeFallbackText([passedVessel(10 * 1000)], null)).toBe(DEFAULT);
  });

});

// =============================================================================
// C2 — ETA-clampens släppgrind vid målbron
// =============================================================================
describe('C2: ETA-clampen släpps när båten är framme vid målbron', () => {
  let app;

  beforeEach(() => {
    app = riggApp();
    app.bridgeRegistry = {
      getBridgeByName: (n) => (n === 'Klaffbron' ? KLAFF : null),
      bridges: { klaffbron: KLAFF },
    };
  });

  const vesselAt = (meters) => {
    const p = northOf(KLAFF, meters);
    return {
      mmsi: '265689820',
      targetBridge: 'Klaffbron',
      lat: p.lat,
      lon: p.lon,
      _etaPublishedValue: 27.6,
      _etaPublishedAtMs: Date.now() - 30 * 1000,
      _etaPublishTarget: 'Klaffbron',
      _isImminentAtTargetBridge: false,
    };
  };

  test('34 m från målbron ⇒ färskt värde publiceras rakt av (17,7-min-fabrikatet borta)', () => {
    const v = vesselAt(34);
    const out = app._reconcilePublishedETA(v, 0.2);
    expect(out).toBeCloseTo(0.2, 5);
    expect(v._etaPublishedValue).toBeCloseTo(0.2, 5);
    // Burst-tillståndet nollas i släppgrenen (annars fel skala nästa burst).
    expect(v._etaBurstAtMs).toBeNull();
    expect(v._etaBurstBase).toBeNull();
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('ETA_CLAMP_RELEASE'));
  });

  test('imminent-flaggan släpper även på långt avstånd', () => {
    const v = vesselAt(900);
    v._isImminentAtTargetBridge = true;
    expect(app._reconcilePublishedETA(v, 1.0)).toBeCloseTo(1.0, 5);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('imminent-flaggan'));
  });

  test('loggraden skriver METER när det var avståndet som bar beslutet', () => {
    app._reconcilePublishedETA(vesselAt(34), 0.2);
    const line = app.debug.mock.calls.map((c) => c[0])
      .find((s) => typeof s === 'string' && s.includes('ETA_CLAMP_RELEASE'));
    expect(line).toMatch(/\(\d+ m\)/);
    expect(line).not.toContain('imminent-flaggan');
  });

  test('140 m ut (BEAUTYFIELD-kalibreringen) ⇒ clampen biter fortfarande', () => {
    const v = vesselAt(140);
    v._etaPublishedValue = 7.2;
    const out = app._reconcilePublishedETA(v, 1.8);
    expect(out).toBeGreaterThan(1.8); // dämpat, inte släppt
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('ETA_PUBLISH_CLAMP'));
  });

  test('1 100 m ut ⇒ oförändrat sågtandsskydd (ingen bred uppmjukning)', () => {
    const v = vesselAt(1100);
    v._etaPublishedValue = 52.4;
    const out = app._reconcilePublishedETA(v, 12.0);
    expect(out).toBeGreaterThan(12.0);
    expect(app.debug).not.toHaveBeenCalledWith(expect.stringContaining('ETA_CLAMP_RELEASE'));
  });

  test(`gränsen ÄR under-bridge-hysteresens släppavstånd (${UNDER_BRIDGE_CLEAR_DISTANCE} m)`, () => {
    const inside = vesselAt(UNDER_BRIDGE_CLEAR_DISTANCE - 5);
    expect(app._reconcilePublishedETA(inside, 0.5)).toBeCloseTo(0.5, 5);
    const outside = vesselAt(UNDER_BRIDGE_CLEAR_DISTANCE + 25);
    outside._etaPublishedValue = 27.6;
    expect(app._reconcilePublishedETA(outside, 0.5)).toBeGreaterThan(0.5);
  });

  test('utan koordinater faller grinden tillbaka på tidigare beteende', () => {
    const v = vesselAt(34);
    v.lat = null;
    v.lon = null;
    expect(app._reconcilePublishedETA(v, 0.2)).toBeGreaterThan(0.2);
  });
});

// =============================================================================
// C3b — persist-debounce + force
// =============================================================================
describe('C3b: sista-kända-positioner skrivs strypt, inte per removal', () => {
  let app;
  let store;

  beforeEach(() => {
    store = {};
    app = riggApp();
    app.homey = {
      settings: {
        get: (k) => (k in store ? store[k] : null),
        set: jest.fn((k, v) => {
          store[k] = v;
        }),
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    app._lastKnownPositions = new Map([['111', { lat: 58.28, lon: 12.28, t: Date.now() }]]);
  });

  test('två anrop inom fönstret ⇒ EN skrivning', () => {
    app._persistLastKnownPositions();
    app._persistLastKnownPositions();
    app._persistLastKnownPositions();
    expect(app.homey.settings.set).toHaveBeenCalledTimes(1);
    expect(store.last_known_positions).toBeDefined();
  });

  test('force skriver även inne i fönstret (onUninit-vägen)', () => {
    app._persistLastKnownPositions();
    app._persistLastKnownPositions(true);
    expect(app.homey.settings.set).toHaveBeenCalledTimes(2);
  });

  test('nytt fönster ⇒ ny skrivning', () => {
    app._persistLastKnownPositions();
    app._lastKnownPositionsPersistedAt = Date.now() - 16 * MIN;
    app._persistLastKnownPositions();
    expect(app.homey.settings.set).toHaveBeenCalledTimes(2);
  });

  test('strypningen får INTE tappa innehåll — sista skrivningen bär hela kartan', () => {
    app._persistLastKnownPositions();
    app._lastKnownPositions.set('222', { lat: 58.29, lon: 12.29, t: Date.now() });
    app._persistLastKnownPositions(); // strypt
    app._persistLastKnownPositions(true); // force
    expect(Object.keys(store.last_known_positions).sort()).toEqual(['111', '222']);
  });

  test('TTL-städningens skrivning går genom samma strypning (ingen bypass)', () => {
    app._LAST_KNOWN_POSITION_TTL_MS = 6 * 60 * MIN;
    app._lastKnownPositions.set('333', { lat: 58.3, lon: 12.3, t: Date.now() - 7 * 60 * MIN });
    app._persistLastKnownPositions(); // öppnar fönstret
    app._pruneLastKnownPositionsTtl(); // vill skriva, men är strypt
    expect(app.homey.settings.set).toHaveBeenCalledTimes(1);
    expect(app._lastKnownPositions.has('333')).toBe(false);
  });

  test('onUninit flushar med force (anropet SAKNADES före etapp 7)', async () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
    expect(src).toContain('this._persistLastKnownPositions(true);');
  });
});

// =============================================================================
// C5 — grinden är MEDVETET inte införd; bara diagnostikraden finns
// =============================================================================
describe('C5: failsafen fyrar fortfarande på enkelsampels-episod (regressionslås)', () => {
  let app;

  const riggFailsafe = () => {
    const a = riggApp();
    a._boatNearTrigger = { trigger: jest.fn() };
    a.bridgeRegistry = { getBridgeByName: (n) => (n === 'Klaffbron' ? KLAFF : null) };
    a._persistentDedupCheck = jest.fn(() => ({ blocked: false }));
    a._triggerBoatNearFlowForBridge = jest.fn(async () => {});
    return a;
  };

  beforeEach(() => {
    app = riggFailsafe();
  });

  test('UTAN föregående position (reborn/gap) fyrar failsafen ändå', async () => {
    const p = northOf(KLAFF, 400);
    await app._triggerBoatNearFlowFallback({
      mmsi: '211216440',
      lat: p.lat,
      lon: p.lon,
      sog: 5.8,
      lastPosition: null,
      passedAt: { Klaffbron: Date.now() - 30 * 1000 },
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 30 * 1000,
    }, 'Klaffbron', {});

    expect(app._triggerBoatNearFlowForBridge).toHaveBeenCalledTimes(1);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('FALLBACK_SINGLE_SAMPLE'));
  });

  test('MED föregående position loggas ingen enkelsampelrad', async () => {
    const p = northOf(KLAFF, 400);
    await app._triggerBoatNearFlowFallback({
      mmsi: '211216440',
      lat: p.lat,
      lon: p.lon,
      sog: 5.8,
      lastPosition: { lat: p.lat - 0.002, lon: p.lon },
      passedAt: { Klaffbron: Date.now() - 30 * 1000 },
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 30 * 1000,
    }, 'Klaffbron', {});

    expect(app._triggerBoatNearFlowForBridge).toHaveBeenCalledTimes(1);
    expect(app.debug).not.toHaveBeenCalledWith(expect.stringContaining('FALLBACK_SINGLE_SAMPLE'));
  });

  test('diagnostikraden är just diagnostik — den får inte bära något beslut', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
    const i = src.indexOf('FALLBACK_SINGLE_SAMPLE');
    const block = src.slice(i, i + 400);
    expect(block).not.toContain('return');
  });
});
