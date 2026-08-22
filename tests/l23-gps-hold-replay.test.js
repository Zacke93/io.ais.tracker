'use strict';

jest.mock('homey');

/**
 * L23 (helkodsgranskning RUNDA 3, 2026-08-22) — C1a-SKIPPEN VAR OSPEGLAD.
 *
 * MEKANISMEN FÖRE FIXEN: `_processUIUpdate` har TVÅ strukturellt identiska
 * hållningsgrenar som återpublicerar `_lastBridgeText` när textmotorn svarat
 * DEFAULT:
 *   • F29 (GPS-hold): en aktiv målbåt är kortvarigt GPS-hållen och filtreras
 *     bort av BridgeTextService.
 *   • PASSED_HOLD (C1c): en båt ligger i passed-fönstret vid en målbro.
 * Bara den senare satte `isHoldReplay`, och C1a-hoppet läser den flaggan.
 * GPS-hold-replayen dömdes därför om mot en fartygsmängd textmotorn just
 * förklarat orenderbar: count-validatorn filtrerar bort GPS-hållna båtar, så
 * "Två båtar …" jämfördes mot renderbart antal noll ⇒ kritiskt underkännande
 * och en SUMMARY_VALIDATION-error-rad. Textutfallet var en ren no-op
 * (RC-B-grenen valde samma text tillbaka) — larmet var alltså 100 % brus,
 * precis den mätning C1a bygger på.
 *
 * NY INTERAKTION (också täckt här): F29-grenen ligger FÖRE passed-hold-grenen
 * och nollar dess DEFAULT-villkor. EN GPS-hållen båt plus EN båt i
 * passed-fönstret föregrep därför PASSED_HOLD helt och rev C1a-hoppet i exakt
 * det läge hoppet finns för.
 *
 * FIXEN: `isHoldReplay` (+ `holdReplaySource` för loggen) sätts även i
 * F29-grenen; GPS-hold-frågan är utbruten till det delade predikatet
 * `_hasGpsHeldTargetVessel` och speglas i nödfallbackens renderbara-noll-gren,
 * så alla tre hållningsvägar behandlas lika.
 */

const AISBridgeApp = require('../app');
const { BRIDGE_TEXT_CONSTANTS, BRIDGES } = require('../lib/constants');

const DEFAULT = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
const STALE_TEXT = 'AIS-anslutning saknas — data kan vara inaktuell';
const KLAFF = Object.values(BRIDGES).find((b) => b.name === 'Klaffbron');

const riggApp = (heldMmsis = []) => {
  const held = new Set(heldMmsis.map(String));
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app._isConnected = true;
  app._lastConnectionLost = null;
  app._updateDeviceCapability = jest.fn();
  app._globalBridgeTextToken = null;
  app.vesselDataService = { hasGpsJumpHold: (mmsi) => held.has(String(mmsi)) };
  // Validatorn läser bridgeRegistry.bridges — utan den kastar den och allt
  // blir 'validation_error', vilket hade dolt vad testerna mäter.
  app.bridgeRegistry = {
    bridges: { klaffbron: KLAFF },
    getBridgeByName: (n) => (n === 'Klaffbron' ? KLAFF : null),
  };
  app.bridgeTextService = { generateBridgeText: jest.fn(() => DEFAULT) };
  return app;
};

const makeSnapshot = (vessels) => ({
  vesselCount: vessels.length,
  relevantVessels: vessels,
  vesselsBeingRemoved: new Set(),
  timestamp: Date.now(),
});

/** Aktiv båt med giltig målbro — det är GPS-holden som gör henne orenderbar. */
const heldVessel = (mmsi) => ({
  mmsi,
  targetBridge: 'Klaffbron',
  lat: KLAFF.lat + 400 / 111320,
  lon: KLAFF.lon,
  etaMinutes: 4,
});

const HELD_TEXT = 'Två båtar på väg mot Klaffbron, beräknad broöppning om 4 minuter';

// =============================================================================
// L23 (a) — GPS-hold-replayen hoppar summeringsvalideringen
// =============================================================================
describe('L23 (a): GPS-hold-replay valideras inte om', () => {
  test('FÄLTFALLET: två GPS-hållna målbåtar ⇒ hållen text, INGET valideringslarm', async () => {
    const app = riggApp(['265111000', '265222000']);
    app._lastBridgeText = HELD_TEXT;
    const spy = jest.spyOn(app, '_validateBridgeTextSummary');

    await app._processUIUpdate(makeSnapshot([heldVessel('265111000'), heldVessel('265222000')]));

    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('GPS_HOLD_UI'));
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('SUMMARY_VALIDATION_SKIP'));
    expect(spy).not.toHaveBeenCalled();
    expect(app.error).not.toHaveBeenCalled();
    const published = app._updateDeviceCapability.mock.calls
      .filter((c) => c[0] === 'bridge_text').map((c) => c[1]);
    expect(published).toContain(HELD_TEXT);
    expect(published).not.toContain(DEFAULT);
  });

  test('KÄLLAN SYNS I LOGGEN — gps-hold får inte maskeras som passed-hold', async () => {
    const app = riggApp(['265111000', '265222000']);
    app._lastBridgeText = HELD_TEXT;

    await app._processUIUpdate(makeSnapshot([heldVessel('265111000'), heldVessel('265222000')]));

    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('källa=gps-hold-replay'));
  });

  test('FÖRFIX-BEVIS: samma indata utan hoppet ger kritiskt count-larm', () => {
    const app = riggApp(['265111000', '265222000']);
    app._lastBridgeText = HELD_TEXT;
    // Exakt vad förfix-koden gjorde: validera hold-replayens text mot samma
    // mängd. Utan L23 smäller den, alltså mäter grinden något.
    const res = app._validateBridgeTextSummary(
      HELD_TEXT,
      [heldVessel('265111000'), heldVessel('265222000')],
      makeSnapshot([heldVessel('265111000'), heldVessel('265222000')]),
    );
    expect(res.isValid).toBe(false);
    // …och fallbacken är byte-identisk med indata = ren no-op (C1a:s mätning).
    expect(res.fallbackText).toBe(HELD_TEXT);
  });

  test('INTERAKTIONEN: GPS-hållen + båt i passed-fönstret ⇒ hoppet består ändå', async () => {
    const app = riggApp(['265111000']);
    app._lastBridgeText = HELD_TEXT;
    const spy = jest.spyOn(app, '_validateBridgeTextSummary');

    await app._processUIUpdate(makeSnapshot([
      heldVessel('265111000'),
      {
        mmsi: '265333000',
        targetBridge: null, // TARGET_END nollade målbron
        lastPassedBridge: 'Klaffbron',
        lastPassedBridgeTime: Date.now() - 10 * 1000,
      },
    ]));

    // F29 föregriper PASSED_HOLD (bridgeText är inte längre DEFAULT), men
    // C1a-hoppet rivs inte längre.
    expect(spy).not.toHaveBeenCalled();
    expect(app.error).not.toHaveBeenCalled();
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('källa=gps-hold-replay'));
  });

  test('HOPPET ÄR INTE SVEPANDE: ingen hold ⇒ valideringen körs som förut', async () => {
    const app = riggApp([]); // ingen GPS-hold
    app._lastBridgeText = HELD_TEXT;
    const spy = jest.spyOn(app, '_validateBridgeTextSummary');

    await app._processUIUpdate(makeSnapshot([{
      mmsi: '265444000',
      targetBridge: null,
      lastPassedBridge: 'Järnvägsbron', // mellanbro ⇒ ingen hold-gren
      lastPassedBridgeTime: Date.now() - 10 * 1000,
    }]));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(app.debug).not.toHaveBeenCalledWith(expect.stringContaining('SUMMARY_VALIDATION_SKIP'));
  });

  test('BT-F5 består: frånkopplingstexten återspelas ALDRIG av GPS-holden', async () => {
    const app = riggApp(['265111000']);
    app._lastBridgeText = STALE_TEXT;

    await app._processUIUpdate(makeSnapshot([heldVessel('265111000')]));

    expect(app.debug).not.toHaveBeenCalledWith(expect.stringContaining('GPS_HOLD_UI'));
  });
});

// =============================================================================
// L23 (b) — nödfallbacken speglar GPS-hold-frågan
// =============================================================================
describe('L23 (b): _generateSafeFallbackText river inte GPS-hållningen bakvägen', () => {
  test('0 renderbara p.g.a. GPS-hold ⇒ senaste texten, inte DEFAULT', () => {
    const app = riggApp(['265111000']);
    app._lastBridgeText = HELD_TEXT;

    const out = app._generateSafeFallbackText([heldVessel('265111000')], 'trasig text');

    expect(out).toBe(HELD_TEXT);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('FALLBACK_GPS_HOLD'));
  });

  test('ingen hold alls ⇒ DEFAULT som förut (grenen är inte svepande)', () => {
    const app = riggApp([]);
    app._lastBridgeText = HELD_TEXT;
    const out = app._generateSafeFallbackText([{ mmsi: '265444000', targetBridge: null }], null);
    expect(out).toBe(DEFAULT);
  });

  test('BT-F5 består även här: frånkopplingstexten återpubliceras ALDRIG', () => {
    const app = riggApp(['265111000']);
    app._lastBridgeText = STALE_TEXT;
    expect(app._generateSafeFallbackText([heldVessel('265111000')], null)).toBe(DEFAULT);
  });

  test('passed-hold behåller sin egen loggtagg (ingen sammanblandning)', () => {
    const app = riggApp([]);
    app._lastBridgeText = HELD_TEXT;
    const out = app._generateSafeFallbackText([{
      mmsi: '265333000',
      targetBridge: null,
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 10 * 1000,
    }], null);
    expect(out).toBe(HELD_TEXT);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('FALLBACK_PASSED_HOLD'));
    expect(app.debug).not.toHaveBeenCalledWith(expect.stringContaining('FALLBACK_GPS_HOLD'));
  });

  test('_hasGpsHeldTargetVessel är EN sanning för båda konsumenterna', () => {
    const app = riggApp(['265111000']);
    expect(app._hasGpsHeldTargetVessel([heldVessel('265111000')])).toBe(true);
    // Mållös båt räknas inte — textmotorn renderar henne inte ändå.
    expect(app._hasGpsHeldTargetVessel([{ mmsi: '265111000', targetBridge: null }])).toBe(false);
    // Ohållen båt räknas inte.
    expect(app._hasGpsHeldTargetVessel([heldVessel('265999000')])).toBe(false);
    expect(app._hasGpsHeldTargetVessel(null)).toBe(false);
    // FAIL-SAFE: utan hold-API svarar predikatet false (dagens beteende).
    app.vesselDataService = {};
    expect(app._hasGpsHeldTargetVessel([heldVessel('265111000')])).toBe(false);
  });
});
