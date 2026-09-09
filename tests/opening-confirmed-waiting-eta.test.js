'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const Service = require('../lib/services/BridgeOpeningService');
const { BRIDGES } = require('../lib/constants');
const { waitingBridge } = require('../lib/utils/bridgeQueue');

const START = Date.parse('2026-09-08T08:00:07.123Z');
const MMSI = '265025880';

describe('Öppningskortets ETA följer bekräftad brokö', () => {
  let service;
  let warning;
  const boat = (distance = 402, extra = {}) => ({
    mmsi: MMSI,
    name: 'KNIGHT OWL',
    lat: BRIDGES.stridsbergsbron.lat - distance / 111320,
    lon: BRIDGES.stridsbergsbron.lon,
    sog: 0.1,
    cog: 0,
    targetBridge: 'Stridsbergsbron',
    _routeDirection: 'north',
    _hasMovementProof: true,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now(),
    fixFeed: 'aisstream',
    status: 'waiting',
    etaMinutes: null,
    ...extra,
  });
  const confirmWait = (vessel, bridge) => Object.assign(vessel, {
    _stationarySince: START - 120000,
    _stillnessAnchor: { lat: vessel.lat, lon: vessel.lon, t: START - 120000 },
    _bridgeQueueApproaches: { [bridge]: { confirmedAt: START - 180000, direction: 'north' } },
  });
  const configure = (config = {}) => {
    service = new Service({
      onWarning: warning,
      targetBridges: ['Stridsbergsbron'],
      scheduleDeadlines: true,
      config,
    });
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    warning = jest.fn();
    configure();
  });
  afterEach(() => {
    service.destroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  test.each([
    ['egen målbro', 100, 'Stridsbergsbron', 0.1],
    ['föregående mellanbro', 402, 'Järnvägsbron', 0.1],
    ['kö med okänd fart', 402, 'Järnvägsbron', null],
  ])('%s ger okänd ETA utan ändrad varning eller reservprognos', (_label, distance, bridge, sog) => {
    const vessel = confirmWait(boat(distance, { sog }), bridge);
    expect(waitingBridge(vessel)).toBe(bridge);

    service.observeVessel(vessel);

    expect(warning).toHaveBeenCalledTimes(1);
    const payload = warning.mock.calls[0][0];
    expect(payload).toMatchObject({
      t: START,
      dueMs: START,
      firedBy: 'fix',
      bridge: 'Stridsbergsbron',
      etaMinutes: null,
      leadMmsi: MMSI,
      mmsis: [MMSI],
      vesselCount: 1,
    });
    const arm = service._arms.get(`${MMSI}::Stridsbergsbron`);
    // Låg fart använder fortfarande 3 kn i motorns interna reservmodell.
    expect(arm.expectedArrivalMs).toBeCloseTo(START + arm.distanceM / (3 * 0.514444) * 1000, 2);
    expect(payload.expectedArrivalMs).toBe(arm.expectedArrivalMs);
    expect(arm.fireDueMs).toBe(arm.originalDueMs);
    expect(arm.fireDueMs).toBeLessThan(START);
  });

  test.each([
    ['verklig transit trots waiting-status', { sog: 4.3, etaMinutes: 2 }, 2],
    ['aktuell nollprognos under transit', { sog: 4.3, etaMinutes: 0 }, 0],
    ['ensamt stillhetsprov', { _stationarySince: START }, 4],
    ['status utan belagd anflygning', { _bridgeQueueApproaches: {} }, 4],
  ])('%s behåller tillgängliga minuter', (_label, extra, expected) => {
    const vessel = confirmWait(boat(), 'Järnvägsbron');
    Object.assign(vessel, extra);
    expect(waitingBridge(vessel)).toBeNull();

    service.observeVessel(vessel);

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0].etaMinutes).toBe(expected);
  });

  test('bekräftad kö läses även innan gammal approaching-status uppdaterats', () => {
    service.observeVessel(confirmWait(boat(402, { status: 'approaching' }), 'Järnvägsbron'));

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0].etaMinutes).toBeNull();
  });

  test('väntbeviset följer armens senaste observation även om gamla vesselobjektet städas', () => {
    service.destroy();
    configure({ WARNING_LEAD_MS: 0, FIRE_EXPECTED_ETA_MS: 0 });
    const vessel = confirmWait(boat(100), 'Stridsbergsbron');
    service.observeVessel(vessel);
    const arm = service._arms.get(`${MMSI}::Stridsbergsbron`);
    const due = Math.ceil(arm.fireDueMs);
    expect(warning).not.toHaveBeenCalled();
    vessel._stationarySince = null;
    vessel._bridgeQueueApproaches = {};

    jest.advanceTimersByTime(due - START);

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toMatchObject({ t: due, firedBy: 'deadline', etaMinutes: null });
    expect(arm.fireDueMs).toBe(arm.originalDueMs);
  });

  test('ny färsk rörelse ersätter väntbeviset före en senare deadline', () => {
    service.destroy();
    configure({ WARNING_LEAD_MS: 0, FIRE_EXPECTED_ETA_MS: 0 });
    const vessel = confirmWait(boat(100), 'Stridsbergsbron');
    service.observeVessel(vessel);
    jest.advanceTimersByTime(5000);
    service.observeVessel({
      ...vessel, sog: 4.3, etaMinutes: 2, timestamp: Date.now(), fixTs: Date.now(),
    });
    const arm = service._arms.get(`${MMSI}::Stridsbergsbron`);

    jest.advanceTimersByTime(Math.ceil(arm.fireDueMs) - Date.now());

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toMatchObject({ firedBy: 'deadline', etaMinutes: 2 });
  });

  test('kö vid första målbron ger okänd ETA även för kedjearmens nästa målbro', () => {
    service.destroy();
    service = new Service({
      onWarning: warning,
      targetBridges: ['Stridsbergsbron', 'Klaffbron'],
      scheduleDeadlines: true,
      config: { ARM_NEXT_TARGET: true },
    });
    const vessel = confirmWait(boat(0, {
      mmsi: '211844940',
      name: 'CALIMA',
      lat: 58.29441666666666,
      lon: 12.296661666666667,
      sog: 0.1,
      cog: 214.2,
      _routeDirection: 'south',
      etaMinutes: 4.787250200266107,
    }), 'Stridsbergsbron');
    vessel._bridgeQueueApproaches.Stridsbergsbron.direction = 'south';
    expect(waitingBridge(vessel)).toBe('Stridsbergsbron');
    service.observeVessel(vessel);
    const next = service._arms.get('211844940::Klaffbron');
    const expectedArrival = next.expectedArrivalMs;
    const due = Math.ceil(next.fireDueMs);
    expect(warning).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(due - Date.now());

    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[1][0]).toMatchObject({
      t: due, bridge: 'Klaffbron', etaMinutes: null, expectedArrivalMs: expectedArrival,
    });
    expect(next.fireDueMs).toBe(next.originalDueMs);
  });

  test('en väntande konvojmedlem tar inte bort den rörliga ledarens egen prognos', () => {
    service.destroy();
    configure({ WARNING_LEAD_MS: 0, FIRE_EXPECTED_ETA_MS: 0 });
    service.observeVessel(boat(400, {
      mmsi: '265111111', name: 'LEDAREN', sog: 4, etaMinutes: 6,
    }));
    jest.advanceTimersByTime(1000);
    service.observeVessel(confirmWait(boat(450, { etaMinutes: 6 }), 'Järnvägsbron'));
    const lead = service._arms.get('265111111::Stridsbergsbron');

    jest.advanceTimersByTime(Math.ceil(lead.fireDueMs) - Date.now());

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toMatchObject({ leadMmsi: '265111111', vesselCount: 2, etaMinutes: 5 });
    expect(warning.mock.calls[0][0].mmsis).toEqual(expect.arrayContaining(['265111111', MMSI]));
  });
});

test('KNIGHTs verkliga öppningskort har okänd ETA vid bekräftad kö, med samma tid och medlemmar', () => {
  const replayDir = path.join(__dirname, 'replay-validation');
  const output = execFileSync(process.execPath, [
    path.join(replayDir, 'replayRunner.js'),
    path.join(replayDir, 'corpora-data/ais-replay-20260711-232958.jsonl'),
  ], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env, REPLAY_MONITORING: '0', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
    },
  });
  const result = JSON.parse(output.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
  expect(result.processErrors).toBe(0);
  expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
  const warnings = result.openingWarnings.filter((entry) => entry.mmsis.includes(MMSI));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatchObject({
    t: Date.parse('2026-07-12T08:23:01.404Z'),
    etaMin: -1,
    eventId: 'Stridsbergsbron#2',
    bridge: 'Stridsbergsbron',
    mmsis: [MMSI],
    vesselCount: 1,
    success: true,
  });
});
