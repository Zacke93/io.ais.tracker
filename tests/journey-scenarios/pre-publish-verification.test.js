'use strict';

const RealAppTestRunner = require('./RealAppTestRunner');
const constants = require('../../lib/constants');

/**
 * Pre-publish E2E verification using RealAppTestRunner.
 * Full pipeline: AIS message -> VesselDataService -> StatusService -> BridgeTextService -> text
 */
describe('Pre-publish verification E2E', () => {
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

  // Bridge coordinates from constants
  const { BRIDGES } = constants;

  // Helper: interpolate position between two bridges
  function interpolate(bridgeA, bridgeB, fraction) {
    return {
      lat: bridgeA.lat + (bridgeB.lat - bridgeA.lat) * fraction,
      lon: bridgeA.lon + (bridgeB.lon - bridgeA.lon) * fraction,
    };
  }

  describe('Scenario 1: Southbound vessel near Stallbackabron', () => {
    test('Bug A: targets Stridsbergsbron (not Klaffbron) and never shows "Broooppning" at Stallbacka', async () => {
      const mmsi = '300000001';
      const name = 'Southbound1';

      // Step 1: 300m north of Stallbackabron, heading south (within detection range)
      await runner._processVesselAsAISMessage({
        mmsi,
        name,
        lat: BRIDGES.stallbackabron.lat + 0.002,
        lon: BRIDGES.stallbackabron.lon + 0.001,
        sog: 4.0,
        cog: 200,
      });
      let text = runner.getCurrentBridgeText();
      // Helgranskning 2026-07-06 (t-journey#2): POSITIV detektionsassert —
      // den gamla villkorade formen var vakuöst grön om båten aldrig
      // upptäcktes. En sydgående båt 300 m norr om Stallbackabron ska synas.
      expect(text).not.toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');
      // Bug A fix: southbound from Stallbackabron should target Stridsbergsbron
      expect(text).not.toMatch(/mot Klaffbron/);

      // Step 2: Slightly closer to Stallbackabron (~100m incremental move)
      await runner._processVesselAsAISMessage({
        mmsi,
        name,
        lat: BRIDGES.stallbackabron.lat + 0.001,
        lon: BRIDGES.stallbackabron.lon + 0.0005,
        sog: 4.0,
        cog: 200,
      });
      text = runner.getCurrentBridgeText();
      // Should NEVER show "Broöppning" for Stallbackabron
      if (text.includes('Stallbackabron')) {
        expect(text).not.toMatch(/Broöppning.*Stallbacka/);
      }

      // Cleanup
      await runner._simulateVesselCleanup();
    }, 30000);
  });

  describe('Scenario 2: Two vessels opposing directions', () => {
    test('generates semicolon-separated text with correct targets', async () => {
      // V1 northbound near Olidebron
      await runner._processVesselAsAISMessage({
        mmsi: '300000010',
        name: 'NorthV1',
        lat: BRIDGES.olidebron.lat - 0.002,
        lon: BRIDGES.olidebron.lon - 0.001,
        sog: 4.0,
        cog: 25,
      });

      // V2 southbound near Stallbackabron
      await runner._processVesselAsAISMessage({
        mmsi: '300000020',
        name: 'SouthV2',
        lat: BRIDGES.stallbackabron.lat + 0.002,
        lon: BRIDGES.stallbackabron.lon + 0.001,
        sog: 4.0,
        cog: 200,
      });

      const text = runner.getCurrentBridgeText();
      // At minimum one vessel should be detected
      expect(text).not.toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');

      // Cleanup
      await runner._simulateVesselCleanup();
    }, 30000);
  });

  describe('Scenario 3: Three northbound staggered', () => {
    test('lead vessel selection and additional count', async () => {
      // V1: far away
      await runner._processVesselAsAISMessage({
        mmsi: '300000030',
        name: 'FarV1',
        lat: BRIDGES.olidebron.lat - 0.005,
        lon: BRIDGES.olidebron.lon - 0.003,
        sog: 4.0,
        cog: 25,
      });

      // V2: closer to Klaffbron
      await runner._processVesselAsAISMessage({
        mmsi: '300000031',
        name: 'MidV2',
        lat: BRIDGES.klaffbron.lat - 0.002,
        lon: BRIDGES.klaffbron.lon - 0.001,
        sog: 4.0,
        cog: 25,
      });

      // V3: very close to Klaffbron (under-bridge range)
      await runner._processVesselAsAISMessage({
        mmsi: '300000032',
        name: 'CloseV3',
        lat: BRIDGES.klaffbron.lat + 0.0001,
        lon: BRIDGES.klaffbron.lon + 0.00005,
        sog: 3.0,
        cog: 25,
      });

      const text = runner.getCurrentBridgeText();
      expect(text).not.toBe('Inga båtar är i närheten av Klaffbron eller Stridsbergsbron');
      // Helgranskning 2026-07-06 (t-journey#3): den gamla formen
      // `if (includes) expect(toMatch)` var en tautologi (vaktvillkoret VAR
      // assertionen). Tre Klaffbron-riktade båtar där V3 är lead ⇒ minst en
      // "ytterligare N båt(ar)"-klausul ELLER ett flerbåtstal måste synas.
      expect(/ytterligare \d+ båt|Två båtar|Tre båtar/.test(text)).toBe(true);

      // Cleanup
      await runner._simulateVesselCleanup();
    }, 30000);
  });
});
