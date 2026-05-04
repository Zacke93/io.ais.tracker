'use strict';

/**
 * Reproduktion-test för Anomali 3 (rapporterat i produktionssession 2026-04-28→05-04).
 *
 * Symptom från WIZARD (265721270) 2026-04-30:
 *   09:39:52  AIS lat=58.295, dist=206m till Stridsbergsbron, ETA=5 min
 *             → bridge text: "broöppning strax" (Fix H imminent ✓)
 *   09:40:21–09:44:21  inga AIS, watchdog tickar varje minut
 *             → "broöppning strax" varje minut ✓
 *   09:45:21  5m 29s stale, fortfarande inom HARD-tröskeln (10 min)
 *             → FÖRVÄNTAT: "broöppning strax" (Fix H borde fortfarande vara aktiv)
 *             → FAKTISKT: "ETA okänd" ❌
 *
 * Detta test reproducerar scenariot deterministiskt genom att:
 *   1. Skicka en AIS för båt nära Stridsbergsbron
 *   2. Manipulera vessel.lastPositionUpdate för att simulera stale
 *   3. Anropa _reevaluateVesselStatuses() direkt
 *   4. Verifiera vessel._isImminentAtTargetBridge och bridge text
 *
 * Om testet misslyckas → vi har en deterministisk repro av Anomali 3.
 * Om testet passerar → buggen är inte i Fix H-logiken utan i timing/state
 * mellan watchdog och BridgeTextService i prod.
 */

const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');
const constants = require('../lib/constants');

describe('Anomali 3 — Fix H imminent-flagga vid stale AIS', () => {
  let runner;

  beforeAll(async () => {
    runner = new RealAppTestRunner();
    runner.logLevel = 'silent';
    runner.setWaitMultiplier(0.1);
    await runner.initializeApp();
  }, 30000);

  afterAll(async () => {
    if (runner) await runner.cleanup();
  });

  beforeEach(async () => {
    await runner._simulateVesselCleanup();
  });

  test('WIZARD 09:45:21 — vessel inom 300m + AIS 5m 29s stale → imminent=true', async () => {
    const mmsi = '265721270';
    const { stridsbergsbron } = constants.BRIDGES;

    // Steg 1: Skicka AIS som matchar WIZARDs sista observation
    // lat 58.295, lon 12.2968, sog 6.7, cog 219° (södergående mot Stridsbergsbron)
    await runner._processVesselAsAISMessage({
      mmsi,
      name: 'WIZARD',
      lat: 58.29495,
      lon: 12.296806,
      sog: 6.7,
      cog: 219,
    });

    // Verifiera att vessel skapats med target=Stridsbergsbron
    const vessel = runner.app.vesselDataService.getVessel(mmsi);
    expect(vessel).toBeTruthy();
    expect(vessel.targetBridge).toBe('Stridsbergsbron');

    // Steg 2: Simulera 5m 29s sedan senaste AIS (manipulera lastPositionUpdate)
    const STALE_MS = 5 * 60 * 1000 + 29 * 1000;
    vessel.lastPositionUpdate = Date.now() - STALE_MS;

    // Verifiera att vi fortfarande är inom HARD-tröskeln
    const ageMs = Date.now() - vessel.lastPositionUpdate;
    expect(ageMs).toBeLessThan(constants.UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS);
    expect(ageMs).toBeGreaterThan(constants.UI_CONSTANTS.STALE_ETA_SOFT_THRESHOLD_MS);

    // Steg 3: Anropa watchdog manuellt (det är den som sätter Fix H-flaggan)
    runner.app._reevaluateVesselStatuses();

    // Steg 4: Hämta vessel igen och kontrollera flaggan
    const vesselAfter = runner.app.vesselDataService.getVessel(mmsi);
    const distToTarget = Math.sqrt(
      ((vesselAfter.lat - stridsbergsbron.lat) * 111000) ** 2
      + ((vesselAfter.lon - stridsbergsbron.lon) * 111000 * Math.cos(stridsbergsbron.lat * Math.PI / 180)) ** 2,
    );

    // Sanity check: vesseln ska fortfarande vara inom 300m
    expect(distToTarget).toBeLessThan(300);

    // Förväntning: imminent-flagga ska vara satt eftersom alla villkor stämmer
    // Om denna assertion misslyckas → vi har avslöjat Anomali 3-buggen
    expect(vesselAfter._isImminentAtTargetBridge).toBe(true);

    // Bridge text ska visa "strax" (eftersom imminent=true överstyr ETA)
    runner._bridgeTextCache = null;
    const bridgeText = runner.getCurrentBridgeText();
    expect(bridgeText).toContain('Stridsbergsbron');
    expect(bridgeText).toContain('strax');
    expect(bridgeText).not.toContain('ETA okänd');
  }, 30000);

  test('Imminent-flagga sätts när AIS är färsk (1m gammalt)', async () => {
    const mmsi = '265721271';
    await runner._processVesselAsAISMessage({
      mmsi,
      name: 'FreshAIS',
      lat: 58.29495,
      lon: 12.296806,
      sog: 6.7,
      cog: 219,
    });

    runner.app._reevaluateVesselStatuses();

    const vessel = runner.app.vesselDataService.getVessel(mmsi);
    expect(vessel._isImminentAtTargetBridge).toBe(true);
  }, 30000);

  test('Imminent-flagga blir false när AIS > HARD-tröskel (12 min stale)', async () => {
    const mmsi = '265721272';
    await runner._processVesselAsAISMessage({
      mmsi,
      name: 'HardStale',
      lat: 58.29495,
      lon: 12.296806,
      sog: 6.7,
      cog: 219,
    });

    const vessel = runner.app.vesselDataService.getVessel(mmsi);
    vessel.lastPositionUpdate = Date.now() - (12 * 60 * 1000); // 12 min stale

    runner.app._reevaluateVesselStatuses();

    const vesselAfter = runner.app.vesselDataService.getVessel(mmsi);
    expect(vesselAfter._isImminentAtTargetBridge).toBe(false);
  }, 30000);

  test('Imminent-flagga blir false när dist > 300m', async () => {
    const mmsi = '265721273';
    // Position 500m norr om Stridsbergsbron
    await runner._processVesselAsAISMessage({
      mmsi,
      name: 'TooFar',
      lat: 58.298,
      lon: 12.297,
      sog: 6.7,
      cog: 219,
    });

    runner.app._reevaluateVesselStatuses();

    const vessel = runner.app.vesselDataService.getVessel(mmsi);
    expect(vessel._isImminentAtTargetBridge).toBe(false);
  }, 30000);
});
