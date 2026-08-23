'use strict';

jest.mock('homey');

/**
 * N5 (helkodsgranskning RUNDA 5, 2026-08-23) — M2-KORROBORERINGEN LÄSTE
 * GPS-FLAGGADE POSITIONER.
 *
 * MEKANISMEN FÖRE FIXEN: _noteQuayLedgerEntry bokförde `lastFix` (som blir
 * nästa `prevFix`) från VARJE sampel — även ett som appen själv flaggat som
 * GPS-hopp/osäker position. Nästa fix jämfördes då mot en position appen redan
 * dömt osäker, och just den felmoden är vad M2 finns för att stänga. En
 * flaggad 250 m-utflykt följd av en REN återkomstfix vid kajen ger implicerat
 * ~8 knop ⇒ predikatet svarar "consistent" ⇒ kajgrindens enkelsampel-
 * kortslutning öppnas ⇒ bridge_opening_soon beväpnas med ankaravstånd 0 m.
 *
 * FIXEN (och bara den): lastFix-SKIFTET hoppas över för GPS-flaggade sampel,
 * så prevFix alltid är en ren fix. Beviset vägras ALDRIG på flaggan — det vore
 * fail-closed mot modulens uttalade doktrin (quayTransitProof är fail-open by
 * design) och hade dödat äkta varningar som 265726650:s.
 *
 * SVITEN KÖR PRODUKTIONSVÄGEN: bokföringen byggs av _noteQuayStability och
 * grinden frågas via _isBridgeOpeningQuayWobbler. Kontrollarmen matar samma
 * ström utan flaggan — då ÄR utflykten en riktig observation och kortslutningen
 * ska (och får) släppa igenom.
 *
 * MUTATIONSPROV (körs manuellt): ta bort `if (!gpsSuspect)` runt skiftet i
 * _noteQuayLedgerEntry ⇒ "FIXEN"-testet nedan blir rött. Låt gpsSuspect även
 * VÄGRA beviset (fail-closed) ⇒ testet "äkta varning på glapp överlever" i
 * m2-sviten blir rött.
 */

const AISBridgeApp = require('../app');
const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');
const { MAX_PREV_FIX_AGE_MS } = require('../lib/utils/quayTransitProof');

const KLAFFBRON = Object.values(BRIDGES).find((b) => b && b.name === 'Klaffbron');
const REAL_DATE_NOW = Date.now;

const north = (m) => ({ lat: KLAFFBRON.lat + m / 111320, lon: KLAFFBRON.lon });
const QUAY = north(200); // kajläget, 200 m norr om Klaffbron
const EXCURSION = north(450); // GPS-utflykten, 250 m från kajen

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

function makeApp() {
  const app = Object.create(AISBridgeApp.prototype);
  const logger = makeLogger();
  app.debug = logger.debug;
  app.log = logger.log;
  app.error = logger.error;
  app._quayStableLedger = new Map();
  app._openingQuayLedger = new Map();
  return app;
}

const sample = (pos, sog, ts, flags = {}) => ({
  mmsi: '211777333',
  lat: pos.lat,
  lon: pos.lon,
  sog,
  cog: 15.0,
  timestamp: ts,
  fixTs: ts,
  fixFeed: 'aishub',
  targetBridge: 'Klaffbron',
  ...flags,
});

describe('N5: en GPS-flaggad position får aldrig bli prevFix', () => {
  let now;

  beforeEach(() => {
    jest.clearAllMocks();
    now = new Date(2026, 7, 6, 9, 0, 0).getTime();
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  /**
   * 40 min kajvistelse genom produktionens egen bokföring, i 'both'-lägets
   * uppmätta kajkadens (~60 s; CARAT-fallet hade 69 s mellan fixarna). Kadensen
   * är väsentlig för vad testet mäter: quayTransitProof är FAIL-OPEN mot en
   * prevFix äldre än MAX_PREV_FIX_AGE_MS, så en glesare ström hade behållit
   * kortslutningen av det skälet i stället för att pröva den rena fixen.
   */
  const stay40min = (app) => {
    for (let i = 0; i < 40; i++) {
      app._noteQuayStability(sample(QUAY, 0.2, now));
      now += 60 * 1000;
    }
  };

  test('FIXEN: flaggad utflykt + ren återkomst ⇒ kortslutningen underkänns', () => {
    const app = makeApp();
    stay40min(app);

    now += 60 * 1000;
    app._noteQuayStability(sample(EXCURSION, 0.3, now, { _gpsJumpDetected: true }));

    now += 60 * 1000;
    const back = sample(QUAY, 4.0, now); // ≥ QUAY_TRANSIT_PROOF_SOG_KN (3,13)
    app._noteQuayStability(back);

    const entry = app._openingQuayLedger.get('211777333');
    // Fixparet är det senaste RENA paret — utflykten finns inte i det.
    expect(entry.lastFix.lat).toBeCloseTo(QUAY.lat, 6);
    expect(entry.prevFix.lat).toBeCloseTo(QUAY.lat, 6);

    // Grinden får alltså pröva som vanligt, och ankaret ligger på kajen.
    expect(app._isBridgeOpeningQuayWobbler(back)).toBe(true);
    expect(app.debug).toHaveBeenCalledWith(
      expect.stringContaining('OPENING_QUAY_SOG_UNCORROBORATED'),
    );
  });

  test('KONTROLLEN (HEAD): samma ström MED utflykten som prevFix ⇒ beväpning', () => {
    const app = makeApp();
    stay40min(app);

    now += 60 * 1000;
    // Utan flaggan bokförs utflykten som fix — exakt HEAD:s beteende när
    // flaggan var satt, och samtidigt det korrekta beteendet för en ren
    // observation (då ÄR förflyttningen verklig).
    app._noteQuayStability(sample(EXCURSION, 0.3, now));

    now += 60 * 1000;
    const back = sample(QUAY, 4.0, now);
    app._noteQuayStability(back);

    const entry = app._openingQuayLedger.get('211777333');
    expect(entry.prevFix.lat).toBeCloseTo(EXCURSION.lat, 6);
    // 250 m på 60 s = 8,1 kn implicerat ⇒ 4,0 kn är förenligt ⇒ kortslutning.
    expect(app._isBridgeOpeningQuayWobbler(back)).toBe(false);
  });

  test('BARA FIXPARET RÖRS: klockor, ankare och räknare bokförs som förut', () => {
    const app = makeApp();
    stay40min(app);
    const before = { ...app._openingQuayLedger.get('211777333') };

    now += 60 * 1000;
    app._noteQuayStability(sample(EXCURSION, 0.3, now, { _positionUncertain: true }));
    const after = app._openingQuayLedger.get('211777333');

    expect(after.bandSince).toBe(before.bandSince);
    expect(after.stillAt).toBe(Date.now()); // stillasamplet räknas som förut
    expect(after.lat).toBeCloseTo(QUAY.lat, 6); // ankaret ligger kvar (moving=false)
    expect(after.movingFixes).toBe(0);
    expect(after.outOfBandFixes).toBe(0);
  });

  test('REN STRÖM: skiftet fungerar precis som förut (ingen regression)', () => {
    const app = makeApp();
    app._noteQuayStability(sample(QUAY, 0.2, now));
    now += 60 * 1000;
    app._noteQuayStability(sample(north(210), 0.2, now));
    now += 60 * 1000;
    app._noteQuayStability(sample(north(220), 0.2, now));

    const entry = app._openingQuayLedger.get('211777333');
    expect(entry.lastFix.lat).toBeCloseTo(north(220).lat, 6);
    expect(entry.prevFix.lat).toBeCloseTo(north(210).lat, 6);
  });

  test('FAIL-OPEN BEHÅLLS: en för gammal ren prevFix ⇒ kortslutningen kvar', () => {
    const app = makeApp();
    stay40min(app);

    // Flaggad utflykt, och sedan tystnad förbi färskhetskravet innan hon återkommer.
    now += 60 * 1000;
    app._noteQuayStability(sample(EXCURSION, 0.3, now, { _gpsJumpDetected: true }));
    now += MAX_PREV_FIX_AGE_MS + 60 * 1000;

    const back = sample(QUAY, 4.0, now);
    app._noteQuayStability(back);
    expect(app._isBridgeOpeningQuayWobbler(back)).toBe(false);
    expect(BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN).toBeLessThan(4.0);
  });
});
