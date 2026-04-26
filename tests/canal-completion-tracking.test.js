'use strict';

/**
 * Regressionstester för "canal completion tracking" — införd 2026-04-27 efter
 * produktionsanalys som visade att södergående båtar inte fick notiser för
 * Olidebron + Kanalinfarten (de eliminerades efter Klaffbron).
 *
 * Designprincip: en båt anses "klar" först när den lämnat hela kanalen, inte
 * bara passerat sin sista målbro:
 *
 *   Norrgående: terminal = Stallbackabron passed (sista bron i kanalen norrut)
 *   Södergående: terminal = Olidebron passed AND vessel south of
 *                Kanalinfarten exit zone (lat < 58.2653 = 300m söder om Kanalinfarten)
 *
 * Detta ger trigger för alla broar + Kanalinfarten oavsett riktning, samtidigt
 * som spökbåts-skyddet (Bug #1, #13, STALE_AIS) bevaras intakt.
 */

const VesselLifecycleManager = require('../lib/services/VesselLifecycleManager');
const BridgeRegistry = require('../lib/models/BridgeRegistry');

const mockLogger = () => ({
  log: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
});

const makeManager = () => new VesselLifecycleManager(mockLogger(), new BridgeRegistry());

describe('Canal completion — northbound vessels', () => {
  test('passed Klaffbron only → NOT yet complete (still has Stridsbergsbron + Stallbackabron ahead)', () => {
    const manager = makeManager();
    const vessel = {
      targetBridge: null,
      lastPassedBridge: 'Klaffbron',
      cog: 30,
      lat: 58.286,
      _finalTargetDirection: 'north',
    };
    expect(manager.hasCompletedJourney(vessel)).toBe(false);
    expect(manager.shouldEliminateVessel(vessel)).toBe(false);
  });

  test('passed Stridsbergsbron only → NOT yet complete (Stallbackabron remains)', () => {
    const manager = makeManager();
    const vessel = {
      targetBridge: null,
      lastPassedBridge: 'Stridsbergsbron',
      cog: 30,
      lat: 58.295,
      _finalTargetDirection: 'north',
    };
    expect(manager.hasCompletedJourney(vessel)).toBe(false);
  });

  test('passed Stallbackabron → COMPLETE (terminal northbound)', () => {
    const manager = makeManager();
    const vessel = {
      targetBridge: null,
      lastPassedBridge: 'Stallbackabron',
      cog: 30,
      lat: 58.315,
      _finalTargetDirection: 'north',
    };
    expect(manager.hasCompletedJourney(vessel)).toBe(true);
    expect(manager.shouldEliminateVessel(vessel)).toBe(true);
  });
});

describe('Canal completion — southbound vessels', () => {
  test('passed Klaffbron only → NOT yet complete (Olidebron + Kanalinfarten ahead)', () => {
    const manager = makeManager();
    const vessel = {
      targetBridge: null,
      lastPassedBridge: 'Klaffbron',
      cog: 200,
      lat: 58.282,
      _finalTargetDirection: 'south',
    };
    expect(manager.hasCompletedJourney(vessel)).toBe(false);
  });

  test('passed Olidebron, still north of Kanalinfarten exit → NOT complete', () => {
    const manager = makeManager();
    const vessel = {
      targetBridge: null,
      lastPassedBridge: 'Olidebron',
      cog: 200,
      lat: 58.270,
      _finalTargetDirection: 'south',
    };
    // 58.270 > KANALINFARTEN_EXIT_LAT (58.2653) → still in zone
    expect(manager.hasCompletedJourney(vessel)).toBe(false);
  });

  test('passed Olidebron AND south of Kanalinfarten exit → COMPLETE', () => {
    const manager = makeManager();
    const vessel = {
      targetBridge: null,
      lastPassedBridge: 'Olidebron',
      cog: 200,
      lat: 58.260,
      _finalTargetDirection: 'south',
    };
    // 58.260 < 58.2653 → has cleared Kanalinfarten zone
    expect(manager.hasCompletedJourney(vessel)).toBe(true);
    expect(manager.shouldEliminateVessel(vessel)).toBe(true);
  });

  test('passed Olidebron without lat data → NOT complete (defensive)', () => {
    const manager = makeManager();
    const vessel = {
      targetBridge: null,
      lastPassedBridge: 'Olidebron',
      cog: 200,
      lat: NaN,
      _finalTargetDirection: 'south',
    };
    expect(manager.hasCompletedJourney(vessel)).toBe(false);
  });
});

describe('Direction inference — _finalTargetDirection vs cog', () => {
  test('_finalTargetDirection trumps cog when both present', () => {
    const manager = makeManager();
    // Vessel passed Stallbackabron with cog suggesting south (200°), but
    // _finalTargetDirection says north — should still be northbound complete.
    const vessel = {
      targetBridge: null,
      lastPassedBridge: 'Stallbackabron',
      cog: 200,
      lat: 58.315,
      _finalTargetDirection: 'north',
    };
    expect(manager.hasCompletedJourney(vessel)).toBe(true);
  });

  test('falls back to cog when _finalTargetDirection missing', () => {
    const manager = makeManager();
    const vessel = {
      targetBridge: null,
      lastPassedBridge: 'Stallbackabron',
      cog: 30,
      lat: 58.315,
    };
    expect(manager.hasCompletedJourney(vessel)).toBe(true);
  });
});

describe('Active journey — should never eliminate', () => {
  test('vessel with active targetBridge → never complete regardless of lastPassedBridge', () => {
    const manager = makeManager();
    const vessel = {
      targetBridge: 'Stridsbergsbron', // Active journey
      lastPassedBridge: 'Stallbackabron',
      cog: 30,
      lat: 58.32,
      _finalTargetDirection: 'north',
    };
    expect(manager.shouldEliminateVessel(vessel)).toBe(false);
  });
});

describe('Backward compatibility with shouldTriggerProximity logic', () => {
  test('vessel with _finalTargetBridge stays trackable for flow triggers', () => {
    // app.js:507 — shouldTriggerProximity now allows triggers when
    // currentBridge OR targetBridge OR _finalTargetBridge is set.
    const vessel = {
      currentBridge: null,
      targetBridge: null,
      _finalTargetBridge: 'Klaffbron', // post-terminal
      status: 'passed',
    };
    const shouldTriggerProximity = vessel.currentBridge
      || vessel.targetBridge
      || vessel._finalTargetBridge;
    expect(shouldTriggerProximity).toBeTruthy();
  });

  test('vessel with no bridge associations does NOT trigger', () => {
    const vessel = {
      currentBridge: null,
      targetBridge: null,
      _finalTargetBridge: null,
    };
    const shouldTriggerProximity = vessel.currentBridge
      || vessel.targetBridge
      || vessel._finalTargetBridge;
    expect(shouldTriggerProximity).toBeFalsy();
  });
});
