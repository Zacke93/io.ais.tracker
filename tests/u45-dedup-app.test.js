'use strict';

jest.mock('homey');

/**
 * U45 I APPEN: EN SLÄPPT MEDLEMS NYA KORT TYSTAS INTE AV DEN GAMLA ANKOMSTEN
 * =============================================================================
 * Den beständiga dedupspärren (bro|mmsi|riktning, arrivalActive) tystar ett
 * nytt kort för en båt som redan varnats för samma ankomst. När en annan båt
 * har använt den öppning hon varnades för (U45) släpper öppningstjänsten
 * henne och lägger hennes mmsi i payloadens reopenedMmsis. Appen släpper då
 * hennes gamla spärr, som vid hennes egen passage (J15), och kortet går ut.
 * Utan fältet tystas kortet som förut (motfallet).
 */

// 'homey' före '../app' (se bridge-opening-app-integration.test.js).
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');

const bootApp = async () => {
  const app = new AISBridgeApp();
  app.homey = mockHomey;
  mockHomey.app.settings = { debug_level: 'off', ais_api_key: null };
  mockHomey.settings = {
    get: (key) => mockHomey.app.settings[key] || null,
    set: (key, value) => {
      mockHomey.app.settings[key] = value;
    },
    on: () => {},
    off: () => {},
  };
  global.__TEST_MODE__ = true;
  await app.onInit();
  return app;
};

const withRealFlowGate = async (fn) => {
  const savedEnv = process.env.NODE_ENV;
  const savedMode = global.__TEST_MODE__;
  process.env.NODE_ENV = 'production';
  global.__TEST_MODE__ = undefined;
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = savedEnv;
    global.__TEST_MODE__ = savedMode;
  }
};

const payloadFor = (overrides = {}) => ({
  t: Date.now(),
  eventId: 'Klaffbron#15',
  bridge: 'Klaffbron',
  direction: 'southbound',
  eventDirection: 'southbound',
  memberDirections: { 265689820: 'southbound' },
  etaMinutes: null,
  vesselCount: 1,
  leadVessel: 'BEAUTYFIELD',
  leadMmsi: '265689820',
  firedBy: 'deadline',
  mmsis: ['265689820'],
  distanceM: 1320,
  ...overrides,
});

describe('U45: reopenedMmsis släpper den gamla ankomstens dedupspärr', () => {
  let app = null;

  afterEach(async () => {
    if (app) await app.onUninit();
    app = null;
    delete global.__TEST_MODE__;
  });

  test('[FÄLLER] det nya kortet för den släppta medlemmen går ut', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor());
      await Promise.resolve();
    });
    expect(card.getTriggerCalls()).toHaveLength(1);
    let result;
    await withRealFlowGate(async () => {
      result = app._onBridgeOpeningWarning(payloadFor({
        eventId: 'Klaffbron#20', distanceM: 1417, reopenedMmsis: ['265689820'],
      }));
      await Promise.resolve();
    });
    expect(result?.suppressed).toBeUndefined();
    expect(card.getTriggerCalls()).toHaveLength(2);
    // Den nya ankomsten har en egen spärr.
    expect(app._persistentOpeningWarnings.get('Klaffbron|265689820|southbound')?.arrivalActive).toBe(true);
  });

  test('motfall: utan reopenedMmsis tystas kortet som förut (samma ankomst)', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor());
      await Promise.resolve();
    });
    let result;
    await withRealFlowGate(async () => {
      result = app._onBridgeOpeningWarning(payloadFor({ eventId: 'Klaffbron#20', distanceM: 1417 }));
      await Promise.resolve();
    });
    expect(result?.suppressed).toBe('same-arrival');
    expect(card.getTriggerCalls()).toHaveLength(1);
  });

  test('motfall: reopenedMmsis släpper bara spärren för en båt som är med i kortet', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor());
      await Promise.resolve();
    });
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({
        eventId: 'Klaffbron#21',
        leadMmsi: '111',
        leadVessel: 'ANNAN',
        mmsis: ['111'],
        memberDirections: { 111: 'southbound' },
        reopenedMmsis: ['265689820'],
      }));
      await Promise.resolve();
    });
    expect(card.getTriggerCalls()).toHaveLength(2);
    expect(app._persistentOpeningWarnings.has('Klaffbron|265689820|southbound')).toBe(true);
  });
});
