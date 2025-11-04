'use strict';

const RealAppTestRunner = require('../journey-scenarios/RealAppTestRunner');
const ScenarioLibrary = require('./ScenarioLibrary');
const { BRIDGE_TEXT_CONSTANTS } = require('../../lib/constants');

const DEFAULT_TEXT = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
const MMSI = '220018000';
const VESSEL_NAME = 'STATEFUL TESTER';

/**
 * Helper to reuse ScenarioLibrary's coordinate generation for physically valid positions.
 * @param {string} bridgeName
 * @param {number} distanceMeters
 * @param {'north'|'south'} direction
 */
function position(bridgeName, distanceMeters, direction) {
  return ScenarioLibrary._calculatePosition(bridgeName, distanceMeters, direction); // eslint-disable-line no-underscore-dangle
}

describe('🧭 Stateful Bridge Text Journeys', () => {
  let runner;

  beforeAll(async () => {
    runner = new RealAppTestRunner();
    await runner.initializeApp();
    runner.setWaitMultiplier(1);
  }, 60000);

  afterAll(async () => {
    await runner?.cleanup();
  });

  test(
    'South→North vessel retains target after Klaffbron passage',
    async () => {
      const journeySteps = [
        {
          description: 'Approaching Klaffbron (450m south)',
          vessels: [{
            mmsi: MMSI,
            name: VESSEL_NAME,
            sog: 4.8,
            cog: 25,
            ...position('klaffbron', 450, 'south'),
          }],
        },
        {
          description: 'Waiting at Klaffbron (280m south)',
          vessels: [{
            mmsi: MMSI,
            name: VESSEL_NAME,
            sog: 3.0,
            cog: 25,
            ...position('klaffbron', 280, 'south'),
          }],
        },
        {
          description: 'Under Klaffbron (40m south)',
          vessels: [{
            mmsi: MMSI,
            name: VESSEL_NAME,
            sog: 2.8,
            cog: 25,
            ...position('klaffbron', 40, 'south'),
          }],
        },
        {
          description: 'Just passed Klaffbron (80m north)',
          vessels: [{
            mmsi: MMSI,
            name: VESSEL_NAME,
            sog: 3.5,
            cog: 25,
            ...position('klaffbron', 80, 'north'),
          }],
        },
        {
          description: 'Clearing Klaffbron (220m north)',
          vessels: [{
            mmsi: MMSI,
            name: VESSEL_NAME,
            sog: 3.4,
            cog: 25,
            ...position('klaffbron', 220, 'north'),
          }],
        },
        {
          description: 'Between target bridges (420m north of Klaff)',
          vessels: [{
            mmsi: MMSI,
            name: VESSEL_NAME,
            sog: 3.3,
            cog: 25,
            ...position('klaffbron', 420, 'north'),
          }],
        },
        {
          description: 'Approaching Stridsbergsbron (320m south)',
          vessels: [{
            mmsi: MMSI,
            name: VESSEL_NAME,
            sog: 3.2,
            cog: 25,
            ...position('stridsbergsbron', 320, 'south'),
          }],
        },
        {
          description: 'Minor GPS drift but still canal-bound (350m south)',
          vessels: [{
            mmsi: MMSI,
            name: VESSEL_NAME,
            sog: 3.1,
            cog: 28, // Slight wobble to trigger MOVING_AWAY heuristics if too eager
            ...position('stridsbergsbron', 350, 'south'),
          }],
        },
        {
          description: 'Recovered approach (180m south)',
          vessels: [{
            mmsi: MMSI,
            name: VESSEL_NAME,
            sog: 3.4,
            cog: 22,
            ...position('stridsbergsbron', 180, 'south'),
          }],
        },
      ];

      const report = await runner.runRealJourney(
        'Stateful south→north regression: Klaffbron to Stridsbergsbron',
        journeySteps,
      );

      // If the bug resurfaces, bridge_text often reverts to default despite active vessel data.
      const erroneousDefault = report.bridgeTextChanges.find(
        (change) => change.newText === DEFAULT_TEXT && change.vessels.some((vessel) => vessel.mmsi === MMSI),
      );
      expect(erroneousDefault).toBeUndefined();

      const finalText = report.finalBridgeText;
      expect(finalText).toContain('Stridsbergsbron');

      const activeVessel = runner.app?.vesselDataService?.getAllVessels()
        .find((vessel) => vessel.mmsi === MMSI);

      expect(activeVessel?.targetBridge).toBe('Stridsbergsbron');
    },
    180000,
  );
});
