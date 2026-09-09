'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { AIS_CONFIG, UI_CONSTANTS } = require('../lib/constants');

// Fältfallet ANYA 2026-08-05: 66 m till Stridsbergsbron i 6,9 kn.
// Gammal GPS/outlier- och EMA-historik gav 3,10015 min. Notisens strax-band
// motsvarar <0,5 min; det färska provets råa restid är bara 0,31157 min.
// Testa färdiga Flow-tokens, inklusive skydden för osäkra och stilla båtar.
describe('notis vid omedelbar målbroankomst', () => {
  let app;
  let now;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-05T08:26:16.633Z'));
    now = Date.now();
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.bridgeRegistry = new BridgeRegistry();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const candidate = (overrides = {}) => ({
    name: 'Stridsbergsbron',
    id: 'stridsbergsbron',
    source: 'target',
    distance: 66.35227776937066,
    ...overrides,
  });

  const vessel = (overrides = {}) => ({
    mmsi: '265705550',
    name: 'ANYA ELAN 380',
    lat: 58.29301,
    lon: 12.29399,
    sog: 6.9,
    cog: 37.5,
    targetBridge: 'Stridsbergsbron',
    currentBridge: 'Järnvägsbron',
    status: 'under-bridge',
    _routeDirection: 'north',
    _hasMovementProof: true,
    _positionUncertain: false,
    _gpsJumpDetected: false,
    lastPassedBridge: 'Järnvägsbron',
    lastPassedBridgeTime: now,
    passedBridges: ['Järnvägsbron'],
    etaMinutes: 3.100149579029902,
    timestamp: now,
    lastPositionUpdate: now,
    fixFeed: 'aishub',
    fixTs: Date.parse('2026-08-05T08:25:19Z'),
    ...overrides,
  });

  const send = async (v = vessel(), c = candidate()) => {
    await app._triggerBoatNearFlowForBridge(v, c);
    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
    return app._triggerBoatNearFlowBest.mock.calls[0][0];
  };

  test('ANYA:s färska 66 m-prov ger strax i samma notis utan att ändra ETA-historiken', async () => {
    const v = vessel();
    const tokens = await send(v);
    expect(tokens.eta_minutes).toBe(0);
    expect(tokens.message).toBe('ANYA ELAN 380 närmar sig Stridsbergsbron, beräknad ankomst strax');
    expect(tokens.eta_available).toBe(true);
    expect(tokens.already_passed).toBe(false);
    expect(v.etaMinutes).toBe(3.100149579029902);
    await app._triggerBoatNearFlowForBridge(v, candidate());
    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });

  test('70 m räknas fortfarande som vid bron', async () => {
    expect((await send(vessel(), candidate({ distance: 70 }))).eta_minutes).toBe(0);
  });

  test('70,1 m lämnar det vanliga ETA-taket oförändrat', async () => {
    expect((await send(vessel(), candidate({ distance: 70.1 }))).eta_minutes).toBe(3);
  });

  test('långsam manöver ger inte ett nytt löfte om omedelbar ankomst', async () => {
    expect((await send(vessel({ sog: 1.9 }), candidate({ distance: 20 }))).eta_minutes).toBe(3);
  });

  test('rå restid över strax-bandet behåller tidigare dämpning', async () => {
    expect((await send(vessel({ sog: 3.8 }), candidate({ distance: 70 }))).eta_minutes).toBe(3);
  });

  test.each([
    ['osäker position', { _positionUncertain: true }],
    ['GPS-hopp', { _gpsJumpDetected: true }],
    ['förtöjd', { _moored: true }],
  ])('%s kan inte lösa ut det nya ankomstlöftet', async (_label, overrides) => {
    expect((await send(vessel(overrides))).eta_minutes).toBe(3);
  });

  test('för gammal position får inte användas som nära ankomstbevis', async () => {
    const old = now - UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS - 1;
    expect((await send(vessel({ timestamp: old, lastPositionUpdate: old }))).eta_minutes).toBe(3);
  });

  test('färskt mottagningslivstecken förnyar inte en för gammal AISHub-position', async () => {
    expect((await send(vessel({ fixTs: now - AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS - 1 }))).eta_minutes).toBe(3);
  });

  test('saknade positionstidsstämplar ger inget ankomstbevis', async () => {
    expect((await send(vessel({ timestamp: null, lastPositionUpdate: null }))).eta_minutes).toBe(3);
  });

  test('en redan bokförd målpassage behåller passerad-form och saknar ETA', async () => {
    const tokens = await send(vessel({ lastPassedBridge: 'Stridsbergsbron' }));
    expect(tokens.eta_minutes).toBe(-1);
    expect(tokens.eta_available).toBe(false);
    expect(tokens.already_passed).toBe(true);
    expect(tokens.message).toContain('passerat Stridsbergsbron');
  });

  test('notis till en annan bro behåller sin vanliga distans-ETA', async () => {
    expect((await send(vessel(), candidate({ source: 'current' }))).eta_minutes).toBe(0);
  });
});
