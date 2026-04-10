'use strict';

/**
 * Reproduction test for targetBridge silently disappearing.
 *
 * Uses exact AIS positions from production log app-20260308-114134.log
 * for vessel 258715000 (NORDIC SOLA) northbound.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

const MMSI = '258715000';

// Exact AIS positions extracted from production log
const AIS_UPDATES = [
  {
    ts: '10:42:31', lat: 58.26992, lon: 12.27171, sog: 4.2, cog: 31.7,
  },
  {
    ts: '10:43:31', lat: 58.27095333333333, lon: 12.27292, sog: 4.5, cog: 31.2,
  },
  {
    ts: '10:44:31', lat: 58.272000000000006, lon: 12.274178333333333, sog: 4.3, cog: 34.2,
  },
  {
    ts: '10:45:31', lat: 58.27294666666667, lon: 12.275558333333333, sog: 4.3, cog: 40.6,
  },
  {
    ts: '10:46:31', lat: 58.273806666666665, lon: 12.277051666666667, sog: 4.0, cog: 42.7,
  },
  {
    ts: '10:47:31', lat: 58.27472, lon: 12.278538333333334, sog: 4.6, cog: 36.5,
  },
  {
    ts: '10:47:51', lat: 58.27508666666667, lon: 12.279005000000002, sog: 4.8, cog: 32.2,
  },
  {
    ts: '10:48:31', lat: 58.275893333333336, lon: 12.279668333333332, sog: 4.9, cog: 20.3,
  },
  {
    ts: '10:49:40', lat: 58.27747333333333, lon: 12.28069, sog: 5.0, cog: 17.4,
  },
  {
    ts: '10:50:40', lat: 58.27874666666666, lon: 12.281473333333334, sog: 4.5, cog: 17.7,
  },
  {
    ts: '10:51:41', lat: 58.27987333333333, lon: 12.28218, sog: 4.1, cog: 17.2,
  },
  {
    ts: '10:52:41', lat: 58.281013333333334, lon: 12.282846666666668, sog: 4.3, cog: 18.3,
  },
  {
    ts: '10:53:41', lat: 58.282226666666666, lon: 12.283493333333332, sog: 4.5, cog: 11.8,
  },
  {
    ts: '10:53:50', lat: 58.28244666666667, lon: 12.283581666666667, sog: 4.6, cog: 12.0,
  },
  // At 10:54:50 vessel is ~40m from Klaffbron (58.28410, 12.28393)
  {
    ts: '10:54:50', lat: 58.28373333333333, lon: 12.28394, sog: 4.6, cog: 7.7,
  },
  {
    ts: '10:55:34', lat: 58.2847, lon: 12.28422, sog: 5.0, cog: 9.3,
  },
  {
    ts: '10:56:30', lat: 58.286053333333335, lon: 12.285233333333334, sog: 5.9, cog: 27.4,
  },
  {
    ts: '10:57:31', lat: 58.2875, lon: 12.28695, sog: 5.8, cog: 33.4,
  },
  // === CRITICAL WINDOW: target should transition to Stridsbergsbron ===
  {
    ts: '10:58:31', lat: 58.288853333333336, lon: 12.288646666666667, sog: 6.1, cog: 33.7,
  },
  {
    ts: '10:59:31', lat: 58.29029333333334, lon: 12.29046, sog: 6.1, cog: 33.2,
  },
  {
    ts: '11:00:31', lat: 58.291626666666666, lon: 12.292046666666666, sog: 5.6, cog: 31.3,
  },
  // At 11:01:41 vessel is ~51m from Stridsbergsbron (58.29352, 12.29457)
  {
    ts: '11:01:41', lat: 58.29313333333334, lon: 12.29412, sog: 6.0, cog: 37.0,
  },
  {
    ts: '11:02:41', lat: 58.294446666666666, lon: 12.296268333333334, sog: 6.5, cog: 43.1,
  },
  {
    ts: '11:03:07', lat: 58.29506, lon: 12.297308333333332, sog: 6.8, cog: 39.8,
  },
];

// Helper: convert "HH:MM:SS" to epoch ms (date = 2026-03-08)
function tsToMs(ts) {
  const [h, m, s] = ts.split(':').map(Number);
  return new Date(2026, 2, 8, h, m, s).getTime();
}

describe('targetBridge disappearance reproduction (log 20260308-114134)', () => {
  let vesselDataService;
  let logEntries;
  let mockNow;
  const realDateNow = Date.now;

  const logger = {
    debug: jest.fn((...args) => logEntries.push(['debug', args.join(' ')])),
    log: jest.fn((...args) => logEntries.push(['log', args.join(' ')])),
    error: jest.fn(),
    warn: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.__TEST_MODE__ = true;
    logEntries = [];

    // Mock Date.now to simulate real time progression
    mockNow = tsToMs('10:42:00');
    Date.now = () => mockNow;

    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(logger);
    vesselDataService = new VesselDataService(logger, bridgeRegistry, systemCoordinator);

    // Stub app-level services
    vesselDataService.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
  });

  afterEach(() => {
    vesselDataService.clearAllTimers();
    delete global.__TEST_MODE__;
    Date.now = realDateNow;
  });

  test('trace exact targetBridge lifecycle with production AIS data', () => {
    const targetHistory = [];

    for (let i = 0; i < AIS_UPDATES.length; i++) {
      const update = AIS_UPDATES[i];

      // Advance mock clock to match production timestamp
      mockNow = tsToMs(update.ts);

      const vessel = vesselDataService.updateVessel(MMSI, {
        lat: update.lat,
        lon: update.lon,
        sog: update.sog,
        cog: update.cog,
        name: 'NORDIC SOLA',
      });

      if (!vessel) continue;

      targetHistory.push({
        ts: update.ts,
        targetBridge: vessel.targetBridge,
        lastPassed: vessel.lastPassedBridge,
        passedBridges: [...(vessel.passedBridges || [])],
      });
    }

    // Show target history
    console.log('\n=== TARGET BRIDGE HISTORY ===');
    for (const entry of targetHistory) {
      console.log(
        `  ${entry.ts}: target=${entry.targetBridge || 'null'}`
        + ` | lastPassed=${entry.lastPassed || 'none'}`
        + ` | passed=[${entry.passedBridges.join(',')}]`,
      );
    }

    // Show TARGET_TRAP entries (stack traces for every targetBridge change)
    const trapEntries = logEntries
      .filter(([, msg]) => msg.includes('TARGET_TRAP'))
      .map(([, msg]) => msg);

    if (trapEntries.length > 0) {
      console.log('\n=== TARGET_TRAP (every targetBridge change) ===');
      for (const entry of trapEntries) {
        console.log(`  ${entry}`);
      }
    }

    // Show protection-related entries
    const protectionEntries = logEntries
      .filter(([level, msg]) => level === 'log'
        && (msg.includes('PROTECTION') || msg.includes('TARGET_TRANSITION')
          || msg.includes('TARGET_END') || msg.includes('TARGET_CHANGE')
          || msg.includes('TARGET_BRIDGE_PASSED') || msg.includes('NEAR_MISS')
          || msg.includes('PASSAGE_OVERRIDE')))
      .map(([, msg]) => msg);

    if (protectionEntries.length > 0) {
      console.log('\n=== PROTECTION & TRANSITION LOG ENTRIES ===');
      for (const entry of protectionEntries) {
        console.log(`  ${entry}`);
      }
    }

    // Show GPS-related debug entries
    const gpsEntries = logEntries
      .filter(([, msg]) => msg.includes('GPS') || msg.includes('gps'))
      .map(([level, msg]) => `[${level}] ${msg}`);

    if (gpsEntries.length > 0) {
      console.log('\n=== GPS-RELATED ENTRIES ===');
      for (const entry of gpsEntries.slice(0, 10)) {
        console.log(`  ${entry}`);
      }
      if (gpsEntries.length > 10) {
        console.log(`  ... and ${gpsEntries.length - 10} more`);
      }
    }

    // Verify Klaffbron passage happens
    const klaffbronPassed = targetHistory.some(
      (e) => e.lastPassed === 'Klaffbron' || e.passedBridges.includes('Klaffbron'),
    );
    const transitionToStridsbergsbron = targetHistory.some(
      (e) => e.targetBridge === 'Stridsbergsbron',
    );

    console.log('\n=== DIAGNOSIS ===');
    console.log(`  Klaffbron passage detected: ${klaffbronPassed}`);
    console.log(`  Transition to Stridsbergsbron: ${transitionToStridsbergsbron}`);

    // Verify passage detection and target transition work correctly
    expect(klaffbronPassed).toBe(true);
    expect(transitionToStridsbergsbron).toBe(true);
  });
});
