'use strict';

const SystemCoordinator = require('../lib/services/SystemCoordinator');

const makeLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });

// gpsAnalysis-former enligt GPSJumpAnalyzer.analyzeMovement (verkliga anroparen
// är VesselDataService._analyzePositionUpdate → coordinatePositionUpdate)
const CALM = { isGPSJump: false, movementDistance: 5, action: 'accept' };
const JUMP = { isGPSJump: true, movementDistance: 900, action: 'gps_jump_detected' };
const CAUTION = { isGPSJump: false, movementDistance: 120, action: 'accept_with_caution' };
const LARGE = { isGPSJump: false, movementDistance: 450, action: 'accept' };

/**
 * Beteendetester för SystemCoordinator — koordinationsanalys, debounce-fönster
 * och cleanup-vägarna.
 *
 * Verkligt kontrakt (från anroparna):
 * - VesselDataService: coordinatePositionUpdate(mmsi, analysis, vessel, old)
 *   och removeVessel(mmsi) vid borttagning.
 * - StatusService: coordinateStatusStabilization(mmsi, stabilizedResult,
 *   positionAnalysis) — läser extendedStabilization/coordinationApplied/
 *   bridgeTextDebounced.
 * - GPSJumpGateService: getCoordination(mmsi) — kräver level 'enhanced' eller
 *   'system_wide' OCH protection === true för att gata passage-detektering.
 */
describe('SystemCoordinator — koordinationsanalys och cleanup', () => {
  let sc;
  let mockNow;
  const realDateNow = Date.now;

  const MMSI = '265111222';

  // Bygger upp system-wide koordination: 3 DISTINKTA fartyg hoppar inom fönstret
  const activateSystemWide = () => {
    let lastRec = null;
    for (let i = 0; i < 3; i++) {
      lastRec = sc.coordinatePositionUpdate(`26500000${i}`, JUMP, {}, {});
      mockNow += 1000;
    }
    return lastRec;
  };

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    jest.useFakeTimers({ doNotFake: ['Date'] });
    mockNow = new Date(2026, 6, 3, 8, 0, 0).getTime();
    Date.now = () => mockNow;
    sc = new SystemCoordinator(makeLogger());
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    delete global.__TEST_MODE__;
    Date.now = realDateNow;
  });

  describe('coordinatePositionUpdate — rekommendationsnivåer', () => {
    test('normal rörelse ger normal_operation utan skydd eller debounce', () => {
      const rec = sc.coordinatePositionUpdate(MMSI, CALM, {}, {});

      expect(rec).toMatchObject({
        shouldProceed: true,
        shouldActivateProtection: false,
        shouldDebounceText: false,
        stabilizationLevel: 'normal',
        reason: 'normal_operation',
        coordinationActive: false,
      });
    });

    test('GPS-jump aktiverar enhanced koordination och emittar coordination:gps_jump', () => {
      const events = [];
      sc.on('coordination:gps_jump', (e) => events.push(e));

      const rec = sc.coordinatePositionUpdate(MMSI, JUMP, {}, {});

      expect(rec).toMatchObject({
        shouldActivateProtection: true,
        shouldDebounceText: true,
        stabilizationLevel: 'enhanced',
        reason: 'gps_jump_coordination',
        coordinationActive: true,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ mmsi: MMSI, distance: 900 });
    });

    test('accept_with_caution ger moderate koordination', () => {
      const rec = sc.coordinatePositionUpdate(MMSI, CAUTION, {}, {});

      expect(rec).toMatchObject({
        shouldActivateProtection: true,
        shouldDebounceText: true,
        stabilizationLevel: 'moderate',
        reason: 'uncertain_position_coordination',
        coordinationActive: true,
      });
    });

    test('stor men legitim rörelse (>300 m) ger light koordination utan skydd', () => {
      const rec = sc.coordinatePositionUpdate(MMSI, LARGE, {}, {});

      expect(rec).toMatchObject({
        shouldActivateProtection: false, // light aktiverar INTE protection
        shouldDebounceText: true,
        stabilizationLevel: 'light',
        reason: 'large_movement_coordination',
        coordinationActive: true,
      });
    });

    test('rörelse på exakt 300 m är fortfarande normal (gränsen är strikt >)', () => {
      const rec = sc.coordinatePositionUpdate(
        MMSI, { isGPSJump: false, movementDistance: 300, action: 'accept' }, {}, {},
      );
      expect(rec.stabilizationLevel).toBe('normal');
      expect(rec.reason).toBe('normal_operation');
    });

    test('3 distinkta hoppande fartyg eskalerar till system_wide; lugn period släpper', () => {
      const rec = activateSystemWide();
      expect(rec.stabilizationLevel).toBe('system_wide');
      expect(sc.globalSystemState.coordinationActive).toBe(true);

      // Även ett lugnt fjärde fartyg eskaleras under global instabilitet
      const calmRec = sc.coordinatePositionUpdate('265004444', CALM, {}, {});
      expect(calmRec.stabilizationLevel).toBe('system_wide');

      // Lugn period längre än jumper-fönstret (3× cooldown = 15 s) → släpp
      mockNow += 16 * 1000;
      const afterRec = sc.coordinatePositionUpdate('265004444', CALM, {}, {});
      expect(sc.globalSystemState.coordinationActive).toBe(false);
      expect(sc.globalSystemState.unstableGPSCount).toBe(0);
      expect(afterRec.reason).toBe('normal_operation');
    });
  });

  describe('getCoordination — API:t mot GPSJumpGateService', () => {
    // (Städat 2026-07-05: hasActiveCoordination och den publika
    // shouldDebounceBridgeText(vessels) raderades — inga produktionsanropare.)
    test('okänt fartyg: ingen aktiv koordination, level normal', () => {
      expect(sc.getCoordination(MMSI)).toMatchObject({
        level: 'normal',
        protection: false,
        coordinationActive: false,
        reason: 'none',
      });
    });

    test('ogiltiga mmsi hanteras fail-safe', () => {
      expect(sc.getCoordination(null)).toBeNull();
      expect(sc.getCoordination(undefined)).toBeNull();
    });

    test('efter GPS-jump: enhanced + protection (gate-kontraktet)', () => {
      sc.coordinatePositionUpdate(MMSI, JUMP, {}, {});

      const coord = sc.getCoordination(MMSI);
      // GPSJumpGateService gatar på level enhanced/system_wide + protection===true
      expect(coord).toMatchObject({
        level: 'enhanced',
        protection: true,
        coordinationActive: true,
        reason: 'gps_jump',
      });
    });

    test('koordinationstyperna mappas till publika nivåer (moderate/light)', () => {
      sc.coordinatePositionUpdate('265000111', CAUTION, {}, {});
      sc.coordinatePositionUpdate('265000222', LARGE, {}, {});

      expect(sc.getCoordination('265000111').level).toBe('moderate');
      expect(sc.getCoordination('265000222').level).toBe('light');
    });

    test('system-wide koordination gäller ÄVEN fartyg utan eget tillstånd', () => {
      activateSystemWide();

      expect(sc.getCoordination('265999888')).toMatchObject({
        level: 'system_wide',
        protection: true,
        reason: 'system_wide_coordination',
      });
    });

    test('fartyg med eget INAKTIVT tillstånd eskaleras till system_wide under global koordination', () => {
      // Lugnt fartyg med eget tillstånd (ingen egen koordinationstyp)
      sc.coordinatePositionUpdate('265888777', CALM, {}, {});
      activateSystemWide();

      const coord = sc.getCoordination('265888777');

      // Gate-kontraktet: level system_wide + protection ⇒ passage-detektering gatas
      expect(coord.level).toBe('system_wide');
      expect(coord.protection).toBe(true);
      expect(coord.coordinationActive).toBe(true);
    });

    test('fail-safe: kraschande mmsi-objekt får aldrig krascha anroparen', () => {
      const evil = {
        toString: () => {
          throw new Error('boom');
        },
      };

      expect(sc.getCoordination(evil)).toBeNull();
    });
  });

  describe('coordinateStatusStabilization — 10 s-fönstret', () => {
    test('inom koordinationsfönstret: extendedStabilization + coordinationApplied', () => {
      sc.coordinatePositionUpdate(MMSI, JUMP, {}, {});
      mockNow += 4000; // 4 s in i 10 s-fönstret

      const res = sc.coordinateStatusStabilization(
        MMSI, { status: 'waiting', statusChanged: false }, {},
      );

      expect(res.extendedStabilization).toBe(true);
      expect(res.coordinationApplied).toBe(true);
      expect(res.status).toBe('waiting'); // statusResult passeras igenom
    });

    test('efter fönstret (>10 s): koordinationen avslutas och deaktiveras', () => {
      sc.coordinatePositionUpdate(MMSI, JUMP, {}, {});
      mockNow += 10001;

      const res = sc.coordinateStatusStabilization(MMSI, { statusChanged: false }, {});

      expect(res.extendedStabilization).toBe(false);
      expect(res.coordinationApplied).toBe(false);
      expect(sc.vesselCoordinationState.get(MMSI).coordinationActive).toBe(false);
    });

    test('statusändring under aktiv koordination debouncar bridge text', () => {
      sc.coordinatePositionUpdate(MMSI, JUMP, {}, {});

      const res = sc.coordinateStatusStabilization(MMSI, { statusChanged: true }, {});

      expect(res.bridgeTextDebounced).toBe(true);
      expect(sc.bridgeTextDebounce.has(MMSI)).toBe(true);
    });

    test('statusändring UTAN koordination debouncar inte', () => {
      const res = sc.coordinateStatusStabilization(MMSI, { statusChanged: true }, {});

      expect(res.bridgeTextDebounced).toBe(false);
      expect(sc.bridgeTextDebounce.has(MMSI)).toBe(false);
    });

    test('global koordination debouncar statusändring även utan egen koordination', () => {
      activateSystemWide();

      const res = sc.coordinateStatusStabilization('265777666', { statusChanged: true }, {});

      expect(res.bridgeTextDebounced).toBe(true);
    });

    test('debounce-entryn auto-städas av sin timer efter 2 s (ingen minnesläcka)', () => {
      sc.coordinatePositionUpdate(MMSI, JUMP, {}, {});
      sc.coordinateStatusStabilization(MMSI, { statusChanged: true }, {});
      // Ny aktivering ersätter den gamla utan dubbla timers
      sc.coordinateStatusStabilization(MMSI, { statusChanged: true }, {});
      expect(sc.bridgeTextDebounce.size).toBe(1);

      jest.advanceTimersByTime(2000);

      expect(sc.bridgeTextDebounce.size).toBe(0);
    });
  });

  describe('cleanup / removeVessel — långtidsdrift', () => {
    test('cleanup tar bort fartygstillstånd äldre än en timme men behåller färska', () => {
      sc.coordinatePositionUpdate('265000OLD', CALM, {}, {});
      mockNow += 61 * 60 * 1000;
      sc.coordinatePositionUpdate('265000NEW', CALM, {}, {});

      sc.cleanup();

      expect(sc.vesselCoordinationState.has('265000OLD')).toBe(false);
      expect(sc.vesselCoordinationState.has('265000NEW')).toBe(true);
    });

    test('cleanup tar bort tillstånd som aldrig fått en positionsuppdatering (lastUpdateTime=null)', () => {
      // Skapas via statusvägen utan att coordinatePositionUpdate körts
      sc.coordinateStatusStabilization(MMSI, { statusChanged: false }, {});
      expect(sc.vesselCoordinationState.has(MMSI)).toBe(true);

      sc.cleanup();

      expect(sc.vesselCoordinationState.has(MMSI)).toBe(false);
    });

    test('cleanup rensar utgångna debounces men behåller aktiva', () => {
      sc.coordinatePositionUpdate('265000AAA', JUMP, {}, {});
      sc.coordinateStatusStabilization('265000AAA', { statusChanged: true }, {});
      mockNow += 2001; // A:s debounce har gått ut
      sc.coordinatePositionUpdate('265000BBB', JUMP, {}, {});
      sc.coordinateStatusStabilization('265000BBB', { statusChanged: true }, {});

      sc.cleanup();

      expect(sc.bridgeTextDebounce.has('265000AAA')).toBe(false);
      expect(sc.bridgeTextDebounce.has('265000BBB')).toBe(true);
    });

    test('removeVessel raderar ALLT per-fartygs-tillstånd (vessel_removed-vägen)', () => {
      sc.coordinatePositionUpdate(MMSI, JUMP, {}, {});
      sc.coordinateStatusStabilization(MMSI, { statusChanged: true }, {});
      expect(sc.vesselCoordinationState.has(MMSI)).toBe(true);
      expect(sc.bridgeTextDebounce.has(MMSI)).toBe(true);

      sc.removeVessel(MMSI);

      expect(sc.vesselCoordinationState.has(MMSI)).toBe(false);
      expect(sc.bridgeTextDebounce.has(MMSI)).toBe(false);
      expect(sc.getCoordination(MMSI)).toMatchObject({ coordinationActive: false });
    });

    test('removeVessel på okänt fartyg är en no-op utan krasch', () => {
      expect(() => sc.removeVessel('999999999')).not.toThrow();
    });

    test('getCoordinationStatus speglar tillståndsräknarna', () => {
      sc.coordinatePositionUpdate(MMSI, JUMP, {}, {});
      sc.coordinateStatusStabilization(MMSI, { statusChanged: true }, {});

      const status = sc.getCoordinationStatus();

      expect(status.activeCoordinations).toBe(1);
      expect(status.activeDebounces).toBe(1);
      expect(status.config.bridgeTextDebounceMs).toBe(2000);
      expect(status.globalState.unstableGPSCount).toBe(1);
    });
  });
});
