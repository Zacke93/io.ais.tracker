'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');

const makeLogger = () => ({ debug: jest.fn(), error: jest.fn(), log: jest.fn() });

/**
 * F45: imminent/extrapolated togs tidigare bara från "lead"-fartyget (lägst ETA).
 * Om en ICKE-lead båt i gruppen var imminent (inom 300m) tappades dess "strax".
 * Nu aggregeras imminent över hela gruppen.
 */
describe('F45: imminent aggregeras över hela målbro-gruppen', () => {
  const svc = new BridgeTextService(null, makeLogger());

  test('icke-lead imminent båt ger "strax" för gruppen', () => {
    // Lead (lägst ETA) är INTE imminent; en annan båt i gruppen ÄR imminent.
    const vessels = [
      {
        mmsi: 'A', targetBridge: 'Klaffbron', etaMinutes: 4, _isImminentAtTargetBridge: false,
      },
      {
        mmsi: 'B', targetBridge: 'Klaffbron', etaMinutes: 9, _isImminentAtTargetBridge: true,
      },
    ];
    const text = svc.generateBridgeText(vessels);
    expect(text).toContain('Två båtar på väg mot Klaffbron');
    expect(text).toContain('strax');
  });

  test('ingen imminent i gruppen → vanlig ETA-text (lead)', () => {
    const vessels = [
      {
        mmsi: 'A', targetBridge: 'Klaffbron', etaMinutes: 4, _isImminentAtTargetBridge: false,
      },
      {
        mmsi: 'B', targetBridge: 'Klaffbron', etaMinutes: 9, _isImminentAtTargetBridge: false,
      },
    ];
    const text = svc.generateBridgeText(vessels);
    expect(text).toContain('om 4 minuter');
    expect(text).not.toContain('strax');
  });
});
