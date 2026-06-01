'use strict';

const SystemCoordinator = require('../lib/services/SystemCoordinator');

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

/**
 * F10: system-wide GPS-koordination kunde fastna PERMANENT.
 *
 * Rotorsak: _assessSystemStability stämplade om lastStabilityEvent varje tick
 * (när unstableGPSCount >= tröskel), och decayen i _updateGlobalCoordinationState
 * baserades på lastStabilityEvent → timeSinceLastEvent ~0 varje tick → decay
 * skedde ALDRIG → coordinationActive fastnade true → all passage-detektion
 * gatades, bridge_text frös globalt.
 *
 * Fix: decay baseras nu på en separat lastJumpTime (sätts bara vid faktiska
 * jumps) och körs FÖRE _assessSystemStability. En lugn period släpper därför
 * alltid koordinationen.
 *
 * (Date.now/argless new Date undviks — vi matar in currentTime via en monoton
 * klocka. coordinatePositionUpdate använder dock internt Date.now för
 * coordinationState; vi anropar därför de globala metoderna direkt där det går.)
 */
describe('F10: system-wide koordination decayar och fastnar inte permanent', () => {
  const gpsJump = { isGPSJump: true, movementDistance: 900, action: 'gps_jump_detected' };
  const calm = { isGPSJump: false, movementDistance: 5, action: 'accept' };

  test('burst aktiverar koordination, lugn period släpper den (via globala metoder)', () => {
    const sc = new SystemCoordinator(makeLogger());
    let t = 1_000_000;
    const rec = {};

    // Burst: 3 jumps inom cooldown → count >= tröskel → aktiveras
    for (let i = 0; i < 3; i++) {
      sc._handleGPSJumpEvent('111', {}, rec, t);
      sc._updateGlobalCoordinationState(gpsJump, t); // decay (ingen — färskt jump)
      sc._assessSystemStability(rec, t);
      t += 1000;
    }
    expect(sc.globalSystemState.coordinationActive).toBe(true);
    expect(sc.globalSystemState.unstableGPSCount).toBeGreaterThanOrEqual(3);

    // Lugn period: inga fler jumps, ticks var 6:e s (> cooldown 5s) → decay
    let released = false;
    for (let i = 0; i < 20; i++) {
      t += 6000;
      sc._updateGlobalCoordinationState(calm, t);
      sc._assessSystemStability(rec, t); // får INTE återaktivera (count sjunker)
      if (!sc.globalSystemState.coordinationActive) {
        released = true;
        break;
      }
    }
    expect(released).toBe(true);
    expect(sc.globalSystemState.unstableGPSCount).toBe(0);
  });

  test('ihållande jumps som omstämplar lastStabilityEvent fastnar INTE (rotorsaken)', () => {
    const sc = new SystemCoordinator(makeLogger());
    let t = 2_000_000;
    const rec = {};

    // Bygg upp till aktiv koordination
    for (let i = 0; i < 3; i++) {
      sc._handleGPSJumpEvent('222', {}, rec, t);
      sc._updateGlobalCoordinationState(gpsJump, t);
      sc._assessSystemStability(rec, t);
      t += 1000;
    }
    expect(sc.globalSystemState.coordinationActive).toBe(true);

    // FÖRE fixen: assess körde först och stämplade om lastStabilityEvent varje
    // tick → decay aldrig. Nu: decayen baseras på lastJumpTime. Efter lugn
    // period (inga jumps) släpper den även om _assessSystemStability anropas.
    let released = false;
    for (let i = 0; i < 20; i++) {
      t += 6000;
      sc._updateGlobalCoordinationState(calm, t);
      sc._assessSystemStability(rec, t);
      if (!sc.globalSystemState.coordinationActive) {
        released = true; break;
      }
    }
    expect(released).toBe(true);
  });

  test('färre jumps än tröskeln aktiverar aldrig (ingen falsk koordination)', () => {
    const sc = new SystemCoordinator(makeLogger());
    let t = 3_000_000;
    const rec = {};
    for (let i = 0; i < 2; i++) {
      sc._handleGPSJumpEvent('333', {}, rec, t);
      sc._updateGlobalCoordinationState(gpsJump, t);
      sc._assessSystemStability(rec, t);
      t += 1000;
    }
    expect(sc.globalSystemState.coordinationActive).toBe(false);
  });
});
