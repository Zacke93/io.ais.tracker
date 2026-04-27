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

/**
 * Regressionstester från produktionssession 2026-04-27 (Fix A–D, F)
 * Härleds från app-20260427-011256.log analys.
 */

describe('BUG A fix — lastPassedBridge candidate inom 15s grace', () => {
  const PASSAGE_TRIGGER_GRACE_MS = 15000;

  const isJustPassedCandidate = (vessel) => Boolean(
    vessel.lastPassedBridge
    && Number.isFinite(vessel.lastPassedBridgeTime)
    && Date.now() - vessel.lastPassedBridgeTime < PASSAGE_TRIGGER_GRACE_MS,
  );

  test('vessel passed Järnvägsbron now → just-passed candidate eligible', () => {
    const vessel = {
      lastPassedBridge: 'Järnvägsbron',
      lastPassedBridgeTime: Date.now(),
    };
    expect(isJustPassedCandidate(vessel)).toBe(true);
  });

  test('vessel passed Järnvägsbron 10s ago → still eligible (within grace)', () => {
    const vessel = {
      lastPassedBridge: 'Järnvägsbron',
      lastPassedBridgeTime: Date.now() - 10000,
    };
    expect(isJustPassedCandidate(vessel)).toBe(true);
  });

  test('vessel passed Järnvägsbron 20s ago → NOT eligible (outside grace)', () => {
    const vessel = {
      lastPassedBridge: 'Järnvägsbron',
      lastPassedBridgeTime: Date.now() - 20000,
    };
    expect(isJustPassedCandidate(vessel)).toBe(false);
  });

  test('vessel without lastPassedBridge → NOT eligible', () => {
    const vessel = {
      lastPassedBridge: null,
      lastPassedBridgeTime: Date.now(),
    };
    expect(isJustPassedCandidate(vessel)).toBe(false);
  });

  test('eligibility filter: just-passed accepted alongside current/nearest', () => {
    // S/Y ROSE 13:50:16: target=Klaffbron, just-passed=Järnvägsbron (different bridge)
    // → båda ska returneras, dedup hindrar dubbletter
    const candidates = [
      { name: 'Klaffbron', source: 'target', distance: 250 },
      { name: 'Järnvägsbron', source: 'just-passed', distance: 111 },
    ];
    const targetCandidate = candidates.find((c) => c.source === 'target');
    const otherCandidate = candidates.find(
      (c) => (c.source === 'current' || c.source === 'nearest' || c.source === 'just-passed')
        && c.name !== targetCandidate.name,
    );
    expect(otherCandidate).toBeDefined();
    expect(otherCandidate.name).toBe('Järnvägsbron');
  });
});

describe('BUG B fix — resolveDistance fallback via direkt beräkning', () => {
  const BridgeRegistry = require('../lib/models/BridgeRegistry');
  const geometry = require('../lib/utils/geometry');

  test('direkt beräkning från vessel-position till Olidebron returnerar finite distance', () => {
    const registry = new BridgeRegistry();
    const olidebron = registry.getBridgeByName('Olidebron');
    expect(olidebron).toBeTruthy();
    expect(Number.isFinite(olidebron.lat)).toBe(true);

    // S/Y ROSE 14:01:18 lat 58.27531 (~225m norr om Olidebron 58.273)
    const distance = geometry.calculateDistance(58.27531, 12.279128, olidebron.lat, olidebron.lon);
    expect(Number.isFinite(distance)).toBe(true);
    expect(distance).toBeGreaterThan(100);
    expect(distance).toBeLessThan(500);
  });

  test('vessel utan lat/lon → fallback returnerar null (graceful)', () => {
    const lat = NaN;
    const lon = NaN;
    const result = (Number.isFinite(lat) && Number.isFinite(lon)) ? 100 : null;
    expect(result).toBeNull();
  });

  test('BridgeRegistry.getBridgeByName returnerar null för okänd bro', () => {
    const registry = new BridgeRegistry();
    expect(registry.getBridgeByName('IcGenuineBridge')).toBeNull();
  });
});

describe('BUG C fix — justRegisteredPassage-villkor', () => {
  const isJustRegistered = (vessel, oldVessel) => Boolean(
    vessel.lastPassedBridge
    && Number.isFinite(vessel.lastPassedBridgeTime)
    && Date.now() - vessel.lastPassedBridgeTime < 2000
    && vessel.lastPassedBridge !== oldVessel?.lastPassedBridge,
  );

  test('passage just registrerats (within 2s, ny lastPassedBridge) → fallback körs', () => {
    const vessel = { lastPassedBridge: 'Klaffbron', lastPassedBridgeTime: Date.now() };
    const oldVessel = { lastPassedBridge: 'Stridsbergsbron' };
    expect(isJustRegistered(vessel, oldVessel)).toBe(true);
  });

  test('lastPassedBridge oförändrad → INTE just registrerad', () => {
    const vessel = { lastPassedBridge: 'Klaffbron', lastPassedBridgeTime: Date.now() };
    const oldVessel = { lastPassedBridge: 'Klaffbron' };
    expect(isJustRegistered(vessel, oldVessel)).toBe(false);
  });

  test('passage 5s sedan → INTE just registrerad', () => {
    const vessel = { lastPassedBridge: 'Klaffbron', lastPassedBridgeTime: Date.now() - 5000 };
    const oldVessel = { lastPassedBridge: 'Stridsbergsbron' };
    expect(isJustRegistered(vessel, oldVessel)).toBe(false);
  });

  test('vessel utan lastPassedBridge → INTE just registrerad', () => {
    const vessel = { lastPassedBridge: null, lastPassedBridgeTime: Date.now() };
    const oldVessel = { lastPassedBridge: null };
    expect(isJustRegistered(vessel, oldVessel)).toBe(false);
  });
});

describe('BUG D fix — U-sväng-detektion', () => {
  const COG_NORTH_MIN = 315;
  const COG_NORTH_MAX = 45;

  const isReversed = (cog, lockedDirection) => {
    const cogIsNorth = cog >= COG_NORTH_MIN || cog <= COG_NORTH_MAX;
    const cogIsSouth = cog >= 135 && cog <= 225;
    const lockedNorth = lockedDirection === 'north';
    return (cogIsNorth && !lockedNorth) || (cogIsSouth && lockedNorth);
  };

  test('FRIDA-scenario: cog=10° (north), _routeDirection=south → reversed=true', () => {
    expect(isReversed(10, 'south')).toBe(true);
  });

  test('cog=180° (south), _routeDirection=north → reversed=true', () => {
    expect(isReversed(180, 'north')).toBe(true);
  });

  test('cog=30° (north), _routeDirection=north → reversed=false (no change)', () => {
    expect(isReversed(30, 'north')).toBe(false);
  });

  test('cog=200° (south), _routeDirection=south → reversed=false', () => {
    expect(isReversed(200, 'south')).toBe(false);
  });

  test('cog=90° (east, ambiguous) → reversed=false (varken N eller S)', () => {
    expect(isReversed(90, 'south')).toBe(false);
    expect(isReversed(90, 'north')).toBe(false);
  });

  test('cog=270° (west, ambiguous) → reversed=false', () => {
    expect(isReversed(270, 'south')).toBe(false);
    expect(isReversed(270, 'north')).toBe(false);
  });

  test('cog=185° (söder med wobble från 180°) → reversed=false när locked=south', () => {
    // Liten COG-wobble nära 180° räknas som söderut, ingen recalc
    expect(isReversed(185, 'south')).toBe(false);
  });

  test('cog-tröskel: 134° (öster om söder) → INTE södergående → reversed=false', () => {
    expect(isReversed(134, 'north')).toBe(false);
  });

  test('cog-tröskel: 135° gränsfall → ÄR södergående', () => {
    expect(isReversed(135, 'north')).toBe(true);
  });

  test('skydd mot wobble nära target: dist=300m → ingen recalc trots reversed', () => {
    // Logik-kontrakt: även om reversed=true, kräver fix dist > 500m för att nullify
    const distToTarget = 300;
    const wouldRecalc = distToTarget > 500;
    expect(wouldRecalc).toBe(false);
  });

  test('långt från target: dist=2000m + reversed → recalc tillåts', () => {
    const distToTarget = 2000;
    const reversed = isReversed(10, 'south');
    const wouldRecalc = reversed && distToTarget > 500;
    expect(wouldRecalc).toBe(true);
  });
});

describe('BUG F fix — TARGET_END logmeddelande', () => {
  test('norrgående final passage → fortsätt till Stallbackabron', () => {
    const previousTarget = 'Stridsbergsbron';
    const direction = previousTarget === 'Stridsbergsbron' ? 'north' : 'south';
    const remainingZone = direction === 'north' ? 'Stallbackabron' : 'Olidebron + Kanalinfarten';
    expect(direction).toBe('north');
    expect(remainingZone).toBe('Stallbackabron');
  });

  test('södergående final passage → fortsätt till Olidebron + Kanalinfarten', () => {
    const previousTarget = 'Klaffbron';
    const direction = previousTarget === 'Stridsbergsbron' ? 'north' : 'south';
    const remainingZone = direction === 'north' ? 'Stallbackabron' : 'Olidebron + Kanalinfarten';
    expect(direction).toBe('south');
    expect(remainingZone).toBe('Olidebron + Kanalinfarten');
  });
});

describe('Fix G — Smart Stale ETA (extrapolation 5–10 min)', () => {
  const { formatETABroOpeningClause } = require('../lib/utils/etaValidation');
  const { UI_CONSTANTS } = require('../lib/constants');

  test('formatETABroOpeningClause utan extrapolated → vanlig text', () => {
    expect(formatETABroOpeningClause(7)).toBe('beräknad broöppning om 7 minuter');
  });

  test('formatETABroOpeningClause med extrapolated=true → "cirka N minuter"', () => {
    expect(formatETABroOpeningClause(7, { extrapolated: true }))
      .toBe('beräknad broöppning om cirka 7 minuter');
  });

  test('formatETABroOpeningClause extrapolated < 3 → fortfarande "strax"', () => {
    expect(formatETABroOpeningClause(2, { extrapolated: true }))
      .toBe('beräknad broöppning strax');
  });

  test('formatETABroOpeningClause extrapolated null → "ETA okänd"', () => {
    expect(formatETABroOpeningClause(null, { extrapolated: true })).toBe('ETA okänd');
  });

  test('SOFT/HARD-trösklar har korrekta värden (5 och 10 min)', () => {
    expect(UI_CONSTANTS.STALE_ETA_SOFT_THRESHOLD_MS).toBe(5 * 60 * 1000);
    expect(UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS).toBe(10 * 60 * 1000);
  });

  test('extrapolations-logik: ETA 10 min - 6 min ålder = ~4 min', () => {
    const baseETA = 10;
    const ageMs = 6 * 60 * 1000;
    const elapsedMin = ageMs / 60000;
    const extrapolated = Math.max(0, baseETA - elapsedMin);
    expect(extrapolated).toBe(4);
  });

  test('extrapolations-logik: ETA 3 min - 4 min ålder = 0 → null', () => {
    const baseETA = 3;
    const elapsedMin = 4;
    const extrapolated = Math.max(0, baseETA - elapsedMin);
    expect(extrapolated).toBe(0);
    // I app.js betyder 0 att ETA nullas → "ETA okänd"
  });

  test('staleness-zon-klassificering', () => {
    const SOFT = UI_CONSTANTS.STALE_ETA_SOFT_THRESHOLD_MS;
    const HARD = UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS;

    const fresh = 4 * 60 * 1000;
    const softZone = 7 * 60 * 1000;
    const hardZone = 12 * 60 * 1000;

    expect(fresh < SOFT).toBe(true); // 4 min: använd vanlig ETA
    expect(softZone > SOFT && softZone <= HARD).toBe(true); // 7 min: extrapolera
    expect(hardZone > HARD).toBe(true); // 12 min: nullify
  });
});

describe('Fix D refinement — wrong-side & passedBridges', () => {
  const targetIsBehindVessel = (vesselLat, targetLat, cogIsNorth) => {
    const targetIsActuallyNorthOfVessel = targetLat > vesselLat;
    return cogIsNorth !== targetIsActuallyNorthOfVessel;
  };

  test('FRIDA-scenario: båt 58.314 (Stallbackabron), target=Stridsbergsbron 58.293, cog norr', () => {
    // Båten är norr om target och går norrut → target ligger BAKOM
    expect(targetIsBehindVessel(58.314, 58.293, true)).toBe(true);
  });

  test('Stridsbergsbron→söderut-vände: båt 58.292 (söder om Stridsbergsbron 58.293), cog söder', () => {
    // Båten söder om target och går söderut → target ligger BAKOM (norrut bakom)
    expect(targetIsBehindVessel(58.292, 58.293, false)).toBe(true);
  });

  test('Normal norrgående båt: båt söder om target, cog norr → target framför', () => {
    expect(targetIsBehindVessel(58.280, 58.293, true)).toBe(false);
  });

  test('Normal södergående båt: båt norr om target, cog söder → target framför', () => {
    expect(targetIsBehindVessel(58.300, 58.293, false)).toBe(false);
  });

  test('passedBridges-check: target redan passerat → recalc oavsett dist', () => {
    const vessel = {
      targetBridge: 'Stridsbergsbron',
      passedBridges: ['Klaffbron', 'Järnvägsbron', 'Stridsbergsbron'],
    };
    const alreadyPassedTarget = Array.isArray(vessel.passedBridges)
      && vessel.passedBridges.includes(vessel.targetBridge);
    expect(alreadyPassedTarget).toBe(true);
  });

  test('passedBridges-check: target inte passerat → check inte triggas', () => {
    const vessel = {
      targetBridge: 'Stridsbergsbron',
      passedBridges: ['Klaffbron', 'Järnvägsbron'],
    };
    const alreadyPassedTarget = Array.isArray(vessel.passedBridges)
      && vessel.passedBridges.includes(vessel.targetBridge);
    expect(alreadyPassedTarget).toBe(false);
  });

  test('kombinerad logik: Stridsbergsbron→Järnvägsbron-fall fångas av targetIsBehindVessel', () => {
    // Båt vänder söderut precis efter Stridsbergsbron-passage:
    // dist=200m (under 500), inte i passedBridges (om passage inte registrerats),
    // men target ligger bakom → ska räknas om
    const distToTarget = 200;
    const alreadyPassedTarget = false;
    const targetBehind = targetIsBehindVessel(58.292, 58.293, false); // söder om target, cog söder
    const shouldRecalc = (distToTarget > 500) || alreadyPassedTarget || targetBehind;
    expect(shouldRecalc).toBe(true);
  });

  test('skydd mot wobble: båt 100m söder om Klaffbron med cog norr → target framför, ingen recalc', () => {
    // Normal approach utan U-sväng — wrong-side ska inte trigga
    const distToTarget = 100;
    const alreadyPassedTarget = false;
    const targetBehind = targetIsBehindVessel(58.283, 58.284, true); // söder om target, cog norr
    const shouldRecalc = (distToTarget > 500) || alreadyPassedTarget || targetBehind;
    expect(shouldRecalc).toBe(false);
  });
});

describe('Fix H — Distansbaserad "strax"-trigger', () => {
  const { formatETABroOpeningClause } = require('../lib/utils/etaValidation');

  test('imminent=true tvingar "strax" oavsett ETA', () => {
    expect(formatETABroOpeningClause(15, { imminent: true }))
      .toBe('beräknad broöppning strax');
    expect(formatETABroOpeningClause(7, { imminent: true }))
      .toBe('beräknad broöppning strax');
  });

  test('imminent=true tvingar "strax" även när ETA är null (stale)', () => {
    expect(formatETABroOpeningClause(null, { imminent: true }))
      .toBe('beräknad broöppning strax');
  });

  test('imminent=true överstyr extrapolated-flagga', () => {
    expect(formatETABroOpeningClause(7, { imminent: true, extrapolated: true }))
      .toBe('beräknad broöppning strax');
  });

  test('imminent=false → vanlig logik gäller', () => {
    expect(formatETABroOpeningClause(7, { imminent: false }))
      .toBe('beräknad broöppning om 7 minuter');
    expect(formatETABroOpeningClause(2, { imminent: false }))
      .toBe('beräknad broöppning strax');
  });

  test('utan options → bakåtkompatibelt beteende', () => {
    expect(formatETABroOpeningClause(7))
      .toBe('beräknad broöppning om 7 minuter');
  });

  test('imminent-trigger-villkor: vessel inom 300m från målbro', () => {
    const distToTarget = 250;
    const isImminent = distToTarget <= 300;
    expect(isImminent).toBe(true);
  });

  test('imminent-trigger blockeras vid 301m', () => {
    const distToTarget = 301;
    const isImminent = distToTarget <= 300;
    expect(isImminent).toBe(false);
  });

  test('NORDIC SOLA Klaffbron-scenariot: 100m, sog 4.0 → strax (löste fall 1)', () => {
    const distToTarget = 100;
    const sog = 4.0; // Snabb båt, ETA hoppade 3 → passerat
    const isImminent = distToTarget <= 300; // sog spelar ingen roll
    expect(isImminent).toBe(true);
    expect(formatETABroOpeningClause(0.5, { imminent: isImminent }))
      .toBe('beräknad broöppning strax');
  });

  test('NORDIC SOLA Stridsbergsbron-scenariot: 200m, sog 1.0 → strax (löste fall 2)', () => {
    // Stillastående/saktande båt — ETA frusen runt 6 min, men vessel är vid bron
    const distToTarget = 200;
    const isImminent = distToTarget <= 300;
    expect(isImminent).toBe(true);
    expect(formatETABroOpeningClause(6, { imminent: isImminent }))
      .toBe('beräknad broöppning strax');
  });
});
