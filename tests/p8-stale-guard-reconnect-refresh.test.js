'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

/**
 * P8 (2026-06-09), två delar:
 *  1. När SISTA fartyget tas bort MEDAN AIS-strömmen är nere (typiskt
 *     STALE_AIS under ett avbrott) trycktes DEFAULT-texten ("inga båtar...")
 *     ut ovillkorligt — en lögn, vi har ingen data. Nu hålls senaste text
 *     kvar tills återanslutning.
 *  2. _onAISConnected gjorde ingen UI-refresh → en frusen text låg kvar tills
 *     nästa fartygshändelse. Nu tvingas en kritisk uppdatering vid reconnect.
 */
describe('P8: stale-guard vid 0 båtar + UI-refresh vid reconnect', () => {
  function makeApp({ isConnected }) {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._isConnected = isConnected;
    app._lastBridgeText = 'En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter';
    app._lastBridgeAlarm = true;
    app._vesselRemovalTimers = new Map();
    app._processingRemoval = new Set();
    app._triggeredBoatNearKeys = new Set();
    // BT-F1 (2026-07-01): vessels.delete() sker FÖRE emit('vessel:removed'),
    // så getVesselCount() i handlern är antalet EFTER borttagning — "sista
    // fartyget bort" simuleras därför med 0 (gamla mocken returnerade 1 och
    // förlitade sig på handlerns numera borttagna dubbelsubtraktion).
    app.vesselDataService = { getVesselCount: jest.fn().mockReturnValue(0) };
    app.statusService = {
      statusStabilizer: { removeVessel: jest.fn() },
      clearVesselETAHistory: jest.fn(),
    };
    app.bridgeTextService = { clearVesselPhaseTracking: jest.fn() };
    app._clearBoatNearTriggers = jest.fn();
    app._updateDeviceCapability = jest.fn();
    app._globalBridgeTextToken = { setValue: jest.fn().mockResolvedValue(undefined) };
    return app;
  }

  const removedEvent = {
    mmsi: '265001111',
    vessel: { mmsi: '265001111', passedBridges: [] },
    reason: 'stale_ais',
  };

  test('AIS nere + sista fartyget bort → DEFAULT trycks INTE ut (texten behålls)', async () => {
    const app = makeApp({ isConnected: false });
    const textBefore = app._lastBridgeText;

    await app._onVesselRemoved(removedEvent);

    expect(app._lastBridgeText).toBe(textBefore);
    expect(app._updateDeviceCapability).not.toHaveBeenCalledWith(
      'bridge_text',
      BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE,
    );
    expect(app._globalBridgeTextToken.setValue).not.toHaveBeenCalled();
  });

  test('ansluten-men-döv feed (>5 min tyst) + sista fartyget bort → texten behålls (t-connection#2)', async () => {
    // Helgranskning 2026-07-06: feedIsSilent-grenen var helt otestad —
    // sviten satte aldrig app.aisClient. "Socket uppe men inga meddelanden"
    // är P8:s andra ansikte (produktionsredo 2026-07-03).
    const app = makeApp({ isConnected: true });
    app.aisClient = {
      getConnectionStats: jest.fn().mockReturnValue({
        timeSinceLastMessage: 6 * 60 * 1000, // > 5 min tystnad
        uptime: 60 * 60 * 1000,
      }),
    };
    const textBefore = app._lastBridgeText;

    await app._onVesselRemoved(removedEvent);

    expect(app._lastBridgeText).toBe(textBefore);
    expect(app._updateDeviceCapability).not.toHaveBeenCalledWith(
      'bridge_text',
      BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE,
    );
  });

  test('ansluten och FÄRSK feed + sista fartyget bort → DEFAULT trycks ut (grenen släpper)', async () => {
    const app = makeApp({ isConnected: true });
    app.aisClient = {
      getConnectionStats: jest.fn().mockReturnValue({
        timeSinceLastMessage: 20 * 1000, // färsk data
        uptime: 60 * 60 * 1000,
      }),
    };

    await app._onVesselRemoved(removedEvent);

    expect(app._lastBridgeText).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
  });

  test('AIS uppe + sista fartyget bort → DEFAULT trycks ut som tidigare', async () => {
    const app = makeApp({ isConnected: true });

    await app._onVesselRemoved(removedEvent);

    expect(app._lastBridgeText).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(app._updateDeviceCapability).toHaveBeenCalledWith(
      'bridge_text',
      BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE,
    );
    expect(app._globalBridgeTextToken.setValue).toHaveBeenCalledWith(
      BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE,
    );
    // alarm_generic ska släckas när inga båtar finns
    expect(app._updateDeviceCapability).toHaveBeenCalledWith('alarm_generic', false);
  });

  test('_onAISConnected tvingar en kritisk UI-uppdatering efter reconnect', () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._updateDeviceCapability = jest.fn();
    app._updateUI = jest.fn();
    app._microGraceTimers = new Map(); // coalescing-systemet är initierat

    app._onAISConnected();

    expect(app._isConnected).toBe(true);
    expect(app._lastConnectionLost).toBeNull();
    expect(app._updateUI).toHaveBeenCalledWith('critical', 'ais-reconnected');
  });

  test('_onAISConnected vid allra första boot (coalescing ej initierat) → ingen refresh, ingen krasch', () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._updateDeviceCapability = jest.fn();
    app._updateUI = jest.fn();
    // _microGraceTimers saknas (onInit steg 9 har inte körts än)

    expect(() => app._onAISConnected()).not.toThrow();
    expect(app._updateUI).not.toHaveBeenCalled();
  });
});
