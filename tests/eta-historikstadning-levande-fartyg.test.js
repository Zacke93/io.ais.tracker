'use strict';

const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');

/**
 * Helgranskningen 2026-11-03: ETA-kalkylatorns 5-minutersstädning körs bara i
 * drift (testlägesgrinden i konstruktorn), så replay, measure:eta och
 * fassvepet såg den aldrig. För en båt som väntat stilla ≥ 30 min raderade den
 * historik och fartbuffert, och första ETA:n efter avgången byggde då på en
 * variant som projektet prövat och förkastat. Svepet rör nu bara fartyg som
 * inte längre spåras; drift och replay beter sig lika.
 */
describe('ETA-historikens städning rör inte levande fartyg', () => {
  const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
  const MIN = 60 * 1000;

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-03T12:00:00Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function seed(calc, mmsi) {
    calc._etaHistory.set(mmsi, [{ timestamp: Date.now() - 45 * MIN, eta: 6 }]);
    calc._speedBuffers.set(mmsi, [0, 0.1, 0]);
    calc._gpsFallbackStreak.set(mmsi, 1);
  }

  test('spårat väntande fartyg behåller historik, fartbuffert och räknare', () => {
    const tracked = new Set(['265000001']);
    const calc = new ProgressiveETACalculator(logger, null, { isTracked: (m) => tracked.has(String(m)) });
    seed(calc, '265000001');
    calc._cleanupOldETAHistory();
    expect(calc._etaHistory.has('265000001')).toBe(true);
    expect(calc._speedBuffers.get('265000001')).toEqual([0, 0.1, 0]);
    expect(calc._gpsFallbackStreak.has('265000001')).toBe(true);
    if (calc._historyCleanupTimer) clearInterval(calc._historyCleanupTimer);
  });

  test('fartyg som inte längre spåras städas som förut', () => {
    const calc = new ProgressiveETACalculator(logger, null, { isTracked: () => false });
    seed(calc, '265000002');
    calc._cleanupOldETAHistory();
    expect(calc._etaHistory.has('265000002')).toBe(false);
    expect(calc._speedBuffers.has('265000002')).toBe(false);
    expect(calc._gpsFallbackStreak.has('265000002')).toBe(false);
    if (calc._historyCleanupTimer) clearInterval(calc._historyCleanupTimer);
  });

  test('StatusService kopplar kalkylatorn till VesselDataService', () => {
    // eslint-disable-next-line global-require
    const StatusService = require('../lib/services/StatusService');
    const vessels = new Map([['265000003', { mmsi: '265000003' }]]);
    const systemCoordinator = { on: jest.fn(), getCoordinationState: jest.fn() };
    const service = new StatusService(null, logger, systemCoordinator, { getVessel: (m) => vessels.get(m) }, null);
    const calc = service.progressiveETACalculator;
    seed(calc, '265000003');
    seed(calc, '265000004');
    calc._cleanupOldETAHistory();
    expect(calc._etaHistory.has('265000003')).toBe(true);
    expect(calc._etaHistory.has('265000004')).toBe(false);
    if (calc._historyCleanupTimer) clearInterval(calc._historyCleanupTimer);
    if (typeof service.destroy === 'function') service.destroy();
  });
});
