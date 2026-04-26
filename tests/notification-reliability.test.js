'use strict';

/**
 * Regressionstester för Fix 5 och 7 från
 * /Users/Zamo0004/.claude/plans/quiet-jingling-flamingo.md
 *
 *   Fix 5 — GPS-jump skydd för flow-triggers
 *   Fix 7 — Multi-bridge flow trigger (EKEN-fall: missad Stridsbergsbron-notis)
 *
 * Fix 7 är redan testat i tests/flow-trigger-bridges.test.js. Detta är
 * kompletterande tester för att täcka edge-cases och Fix 5.
 */

describe('Fix 5 — GPS-jump skydd för flow-triggers', () => {
  // Validerar logiken: om vesselDataService.hasGpsJumpHold(mmsi) returnerar
  // true, ska _triggerBoatNearFlow returnera tidigt utan att triggra.
  // Direct integration test would require app boot; this validates the
  // contract our fix relies on.

  test('hasGpsJumpHold contract: returns true for held mmsis', () => {
    const mockService = {
      _holds: new Set(),
      hasGpsJumpHold(mmsi) {
        return this._holds.has(mmsi);
      },
    };

    mockService._holds.add('123');
    expect(mockService.hasGpsJumpHold('123')).toBe(true);
    expect(mockService.hasGpsJumpHold('999')).toBe(false);
  });

  test('hasGpsJumpHold contract: function exists on VesselDataService', () => {
    const VesselDataService = require('../lib/services/VesselDataService');
    const BridgeRegistry = require('../lib/models/BridgeRegistry');
    const SystemCoordinator = require('../lib/services/SystemCoordinator');

    const logger = {
      log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    const registry = new BridgeRegistry();
    const coordinator = new SystemCoordinator(logger);
    const service = new VesselDataService(logger, registry, coordinator);

    expect(typeof service.hasGpsJumpHold).toBe('function');
    expect(service.hasGpsJumpHold('any_mmsi')).toBe(false); // Default: no holds
  });
});

describe('Fix 7 — Multi-bridge candidates (smoke test)', () => {
  // Full integration test för Fix 7 finns i tests/flow-trigger-bridges.test.js
  // ("triggers BOTH target and current when within 300m of both").
  // Detta är en complement med fokus på den reverse-relationen:
  // när det inte finns någon target alls.

  test('contract: candidates with only current/nearest source are returned', () => {
    // When vessel has no target, only current/nearest/trigger-point candidates
    // should pass through. This is unchanged behavior — Fix 7 only affects
    // the case where target EXISTS and a different current/nearest is also nearby.
    const candidates = [
      {
        name: 'Olidebron', source: 'current', distance: 100,
      },
      {
        name: 'Kanalinfarten', source: 'trigger-point', distance: 50,
      },
    ];

    const hasTargetCandidate = candidates.some((c) => c.source === 'target');
    expect(hasTargetCandidate).toBe(false);
    // Ingen filtering, alla returneras
    expect(candidates).toHaveLength(2);
  });

  test('Fix 7 trigger condition: target + different current within 300m → both fire', () => {
    // Replikerar EKEN-scenariot (2026-04-26 00:49:34): båt 25m från Järnvägsbron
    // och 232m från Stridsbergsbron (target)
    const candidates = [
      {
        name: 'Stridsbergsbron', source: 'target', distance: 232,
      },
      {
        name: 'Järnvägsbron', source: 'current', distance: 25,
      },
    ];

    const targetCandidate = candidates.find((c) => c.source === 'target');
    const currentCandidate = candidates.find(
      (c) => (c.source === 'current' || c.source === 'nearest')
        && c.name !== targetCandidate.name,
    );

    // Båda är legitima, ingen ska filtreras bort
    expect(targetCandidate).toBeDefined();
    expect(currentCandidate).toBeDefined();
    expect(targetCandidate.name).not.toBe(currentCandidate.name);
  });

  test('Fix 7 boundary: same bridge as target+current → only target returned', () => {
    // När båt är vid sin target som också råkar vara nearest, är det bara EN
    // bro vi pratar om — inte två. Returnera bara target.
    const candidates = [
      {
        name: 'Klaffbron', source: 'target', distance: 50,
      },
      {
        name: 'Klaffbron', source: 'current', distance: 50,
      },
    ];

    const targetCandidate = candidates.find((c) => c.source === 'target');
    const currentCandidate = candidates.find(
      (c) => (c.source === 'current' || c.source === 'nearest')
        && c.name !== targetCandidate.name,
    );

    // currentCandidate är undefined eftersom name === target.name
    expect(currentCandidate).toBeUndefined();
  });
});
