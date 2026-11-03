'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

/**
 * INV-B4 / beslut D5 (docs/reliability-spec.md, ratificerad 2026-06-03):
 * "vid avbrott visas avbrottstexten, aldrig DEFAULT" — efter > 2 min utan
 * AIS-anslutning ska brotexten vara STALE_DATA_OVERRIDE_TEXT.
 *
 * Felet (helgranskningen 2026-11-03): stale-vakten bodde bara i
 * _processUIUpdate, men ingen UI-cykel drevs när INGA båtar spårades.
 * Vakthunden returnerade tidigt vid tom kanal och _onAISDisconnected skrev
 * bara connection_status. Ett nät-/källavbrott på tom kanal visade därför
 * "Inga båtar …" under hela avbrottet, och en båttext som P8-vakten höll
 * kvar vid sista båtens borttagning frös med larmet PÅ.
 */
const STALE_TEXT = 'AIS-anslutning saknas — data kan vara inaktuell';
const DEFAULT_TEXT = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;

async function settle(ms) {
  await jest.advanceTimersByTimeAsync(ms);
}

describe('INV-B4: avbrottstexten publiceras även när inga båtar spåras', () => {
  let app;
  let device;
  let savedTestMode;

  beforeEach(async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-03T02:00:00Z') });
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    app = new App();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: () => null, set: jest.fn(), on: jest.fn(), off: jest.fn(),
      },
      flow: { ...mockHomey.flow },
    };
    await app.onInit();
    const values = new Map();
    device = {
      values,
      getName: () => 'Broläge',
      getCapabilityValue: (capability) => values.get(capability),
      setCapabilityValue: (capability, value) => {
        values.set(capability, value);
        return Promise.resolve();
      },
    };
    app._devices.add(device);
  });

  afterEach(async () => {
    await app.onUninit();
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedTestMode;
  });

  const shown = () => device.values.get('bridge_text');
  const token = () => (app._globalBridgeTextToken ? app._globalBridgeTextToken.value : undefined);

  test('tom kanal: avbrott > 2 min ⇒ avbrottstexten, larmet av; återanslutning ⇒ "Inga båtar"', async () => {
    app._onAISConnected();
    await settle(1000);
    expect(shown()).toBe(DEFAULT_TEXT);

    app._onAISDisconnected({ code: 1006, reason: 'abnormal closure' });
    // Inom 2 min: ingen ändring (samma gräns som stale-vakten i _processUIUpdate).
    await settle(90 * 1000);
    expect(shown()).toBe(DEFAULT_TEXT);

    // Vakthunden går på hela halvminuter — senast en halvminut efter gränsen.
    await settle(60 * 1000);
    expect(shown()).toBe(STALE_TEXT);
    // Larmet skrivs bara vid ändring; det var redan av och får inte slås på.
    expect(device.values.get('alarm_generic')).not.toBe(true);
    expect(app._lastBridgeAlarm).toBe(false);
    expect(token()).toBe(STALE_TEXT);

    // Långt avbrott: texten står kvar, ingen återgång till DEFAULT.
    await settle(6 * 60 * 60 * 1000);
    expect(shown()).toBe(STALE_TEXT);

    // Återanslutning: _onAISConnected tvingar en kritisk cykel ⇒ DEFAULT.
    app._onAISConnected();
    await settle(1000);
    expect(shown()).toBe(DEFAULT_TEXT);
    expect(token()).toBe(DEFAULT_TEXT);
  });

  test('appstart utan att någon källa svarar ⇒ avbrottstexten efter 2 min, aldrig "Inga båtar" som sanning', async () => {
    // _lastConnectionLost seedas vid boot och _isConnected är falsk tills en
    // källa svarat (nät nere, ingen nyckel).
    expect(app._isConnected).toBe(false);
    await settle(3 * 60 * 1000);
    expect(shown()).toBe(STALE_TEXT);
    expect(device.values.get('alarm_generic')).not.toBe(true);
    expect(app._lastBridgeAlarm).toBe(false);
  });

  test('båttext som P8 höll kvar vid sista båtens borttagning fryser inte med larmet på', async () => {
    app._onAISConnected();
    await settle(1000);
    const boatText = 'En båt på väg mot Klaffbron, beräknad broöppning om 4 minuter';
    // Läget P8-vakten lämnar efter sig: texten och larmet från sista båten,
    // båten själv borta ur VesselDataService.
    app._lastBridgeText = boatText;
    app._lastBridgeTextHash = app._hashString(boatText);
    app._lastBridgeAlarm = true;
    device.values.set('bridge_text', boatText);
    device.values.set('alarm_generic', true);
    expect(app.vesselDataService.getAllVessels()).toHaveLength(0);

    app._onAISDisconnected({ code: 1006, reason: 'abnormal closure' });
    await settle(3 * 60 * 1000);
    expect(shown()).toBe(STALE_TEXT);
    expect(device.values.get('alarm_generic')).toBe(false);
  });

  test('kontroll: ansluten tom kanal förblir "Inga båtar" utan extra publiceringar', async () => {
    app._onAISConnected();
    await settle(1000);
    const spy = jest.spyOn(app, '_processUIUpdate');
    await settle(30 * 60 * 1000);
    expect(shown()).toBe(DEFAULT_TEXT);
    expect(spy).not.toHaveBeenCalled();
  });

  test('avbrottstexten publiceras en gång — vakthunden driver inga onödiga cykler därefter', async () => {
    app._onAISConnected();
    await settle(1000);
    app._onAISDisconnected({ code: 1006, reason: 'abnormal closure' });
    await settle(3 * 60 * 1000);
    expect(shown()).toBe(STALE_TEXT);
    const spy = jest.spyOn(app, '_processUIUpdate');
    await settle(30 * 60 * 1000);
    expect(spy).not.toHaveBeenCalled();
    expect(shown()).toBe(STALE_TEXT);
  });
});
