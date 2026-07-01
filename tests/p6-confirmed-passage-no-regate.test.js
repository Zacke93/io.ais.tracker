'use strict';

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');

/**
 * P6 (2026-06-09): En målbro-passage som bekräftats via GPS-gatens
 * tvåstegsvalidering (confirmStableCandidates) om-gatades tidigare i
 * _handleTargetBridgeTransition — _hasPassedTargetBridge kördes om och gav
 * false (gaten kunde fortfarande vara aktiv och linjekorsningen låg redan
 * bakom fartyget) → transitionen uteblev och bridge_text frös i 2-3 min.
 *
 * Fixen: options.confirmedPassage hoppar över re-detekteringen och applicerar
 * transitionen direkt.
 */
describe('P6: bekräftad GPS-gate-passage om-gatas inte', () => {
  function makeService() {
    const svc = Object.create(VesselDataService.prototype);
    svc.logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    // Simulera P6-läget: re-detekteringen skulle säga "ingen passage"
    svc._hasPassedTargetBridge = jest.fn().mockReturnValue(false);
    svc._applyTargetTransition = jest.fn();
    svc._handleIntermediateBridgePassage = jest.fn();
    svc._calculateNextTargetBridge = jest.fn().mockReturnValue('Stridsbergsbron');
    svc.bridgeRegistry = { getBridgeByName: jest.fn().mockReturnValue(null) };
    svc.passageWindowManager = { getInternalGracePeriod: jest.fn().mockReturnValue(180000) };
    return svc;
  }

  test('confirmedPassage=true → transition appliceras trots att re-detekteringen ger false', () => {
    const svc = makeService();
    const vessel = { mmsi: '265001234', targetBridge: 'Klaffbron', _pendingTarget: null };
    const oldVessel = { mmsi: '265001234', targetBridge: 'Klaffbron' };

    svc._handleTargetBridgeTransition(vessel, oldVessel, { confirmedPassage: true });

    expect(svc._applyTargetTransition).toHaveBeenCalledWith(vessel, oldVessel, 'Stridsbergsbron');
    // P6-kärnan: den BEKRÄFTADE transitionen får inte om-gatas — transitionen
    // ska ha applicerats FÖRE varje ev. detekteringsanrop. S-F3-kedjan
    // (2026-07-01) får därefter konsultera detekteringen för det NYA målet
    // (samma gap-segment kan ha korsat även nästa bro).
    const applyOrder = svc._applyTargetTransition.mock.invocationCallOrder[0];
    for (const detectOrder of svc._hasPassedTargetBridge.mock.invocationCallOrder) {
      expect(detectOrder).toBeGreaterThan(applyOrder);
    }
  });

  test('utan flaggan gäller ordinarie re-detektering (ingen transition vid false)', () => {
    const svc = makeService();
    const vessel = { mmsi: '265001234', targetBridge: 'Klaffbron', _pendingTarget: null };
    const oldVessel = { mmsi: '265001234', targetBridge: 'Klaffbron' };

    svc._handleTargetBridgeTransition(vessel, oldVessel);

    expect(svc._hasPassedTargetBridge).toHaveBeenCalled();
    expect(svc._applyTargetTransition).not.toHaveBeenCalled();
    expect(svc._handleIntermediateBridgePassage).toHaveBeenCalledWith(vessel, oldVessel);
  });

  test('utan oldVessel görs ingenting (guard oförändrad)', () => {
    const svc = makeService();
    const vessel = { mmsi: '265001234', targetBridge: 'Klaffbron' };

    svc._handleTargetBridgeTransition(vessel, null, { confirmedPassage: true });

    expect(svc._applyTargetTransition).not.toHaveBeenCalled();
  });
});
