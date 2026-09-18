'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const Service = require('../lib/services/BridgeOpeningService');
const { BRIDGES } = require('../lib/constants');
const { gtTargetPassages } = require('./replay-validation/runOpeningGates');
const corpora = require('./replay-validation/corpora');

const START = Date.parse('2026-09-18T08:00:00Z');
const LEADER = '265000001';
const FOLLOWER = '265000002';
const NEWCOMER = '265000003';
const MINUTE = 60000;

describe('En uppdaterad värdprognos begränsar endast nya konvojmedlemmar', () => {
  let service;
  let warning;
  let coverage;
  const at = (minute) => jest.advanceTimersByTime(START + minute * MINUTE - Date.now());
  const boat = (mmsi, distance, etaMinutes, extra = {}) => ({
    mmsi,
    name: mmsi,
    targetBridge: 'Klaffbron',
    _routeDirection: 'north',
    _hasMovementProof: true,
    lat: BRIDGES.klaffbron.lat - distance / 111320,
    lon: BRIDGES.klaffbron.lon,
    sog: 4,
    cog: 0,
    etaMinutes,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now(),
    ...extra,
  });
  const observeFollower = () => {
    at(3);
    service.observeVessel(boat(FOLLOWER, 1600, 25));
    at(6);
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    warning = jest.fn();
    coverage = jest.fn();
    service = new Service({
      scheduleDeadlines: true,
      targetBridges: ['Klaffbron'],
      onWarning: warning,
      onCoverage: coverage,
    });
    service.observeVessel(boat(LEADER, 1500, 30));
    at(2);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    service.destroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  test('ny ren prognos utanför det gamla konvojfönstret får inte tysta nästa båts deadline', () => {
    // Värdens prognos flyttas från 08:30 till 08:12. Följaren beräknas
    // till 08:28 och ryms enbart i det gamla, motsagda fönstret.
    service.observeVessel(boat(LEADER, 600, 10));
    observeFollower();

    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[1][0]).toMatchObject({
      mmsis: [FOLLOWER], firedBy: 'deadline',
    });
    expect(coverage.mock.calls.some(([info]) => info.mmsi === FOLLOWER && info.reason === 'absorbed')).toBe(false);
  });

  test.each([20, 18])('ETA %s minuter håller värdens prognos inom samma konvojfönster', (etaMinutes) => {
    service.observeVessel(boat(LEADER, 600, etaMinutes));
    observeFollower();

    expect(warning).toHaveBeenCalledTimes(1);
    expect(coverage).toHaveBeenCalledWith(expect.objectContaining({ mmsi: FOLLOWER, reason: 'absorbed' }));
  });

  test.each([
    ['GPS-hopp', { _gpsJumpDetected: true }],
    ['osäker position', { _positionUncertain: true }],
    ['gammalt fix med ny leverans', { fixTs: START }],
  ])('%s motsäger inte den tidigare värdprognosen', (_label, extra) => {
    service.observeVessel(boat(LEADER, 600, 10, extra));
    observeFollower();

    expect(warning).toHaveBeenCalledTimes(1);
    expect(coverage).toHaveBeenCalledWith(expect.objectContaining({ mmsi: FOLLOWER, reason: 'absorbed' }));
  });

  test('ett gammalt fix efter varningen räcker inte utan aktuell positionsbekräftelse', () => {
    at(15);
    service.observeVessel(boat(LEADER, 600, 1, {
      fixTs: START + 3 * MINUTE,
      timestamp: START + 3 * MINUTE,
      lastPositionUpdate: START + 3 * MINUTE,
    }));
    service.observeVessel(boat(FOLLOWER, 1600, 13));
    at(18);

    expect(warning).toHaveBeenCalledTimes(1);
    expect(coverage).toHaveBeenCalledWith(expect.objectContaining({ mmsi: FOLLOWER, reason: 'absorbed' }));
  });

  test('redan given täckning löper till sin tidigare utgång', () => {
    service.observeVessel(boat(FOLLOWER, 1600, 27));
    const originalExpiry = service._arms.get(`${FOLLOWER}::Klaffbron`).coverUntilMs;
    at(3);
    service.observeVessel(boat(LEADER, 600, 9));
    // Följaren sänder vidare; armens vanliga 30-minuterstimeout ska inte
    // förväxlas med den konvojtäckning som detta test prövar.
    at(20);
    service.observeVessel(boat(FOLLOWER, 1600, 9));
    jest.advanceTimersByTime(Math.floor(originalExpiry) - Date.now());
    expect(warning).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[1][0].mmsis).toEqual([FOLLOWER]);
  });

  test('en kortare prognos öppnar inte fönstret för tidigare, orelaterade ankomster', () => {
    service.observeVessel(boat(LEADER, 600, 10));
    at(3);
    service.observeVessel(boat(FOLLOWER, 200, 1));

    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[1][0].mmsis).toEqual([FOLLOWER]);
  });

  test('en absorberad följare flyttar inte den ursprungliga varningens fönster', () => {
    service.observeVessel(boat(FOLLOWER, 1600, 28));
    at(3);
    service.observeVessel(boat(FOLLOWER, 200, 1));
    at(4);
    service.observeVessel(boat(NEWCOMER, 1600, 24));
    at(7);

    expect(warning).toHaveBeenCalledTimes(1);
    expect(coverage).toHaveBeenCalledWith(expect.objectContaining({ mmsi: NEWCOMER, reason: 'absorbed' }));
  });

  test('senare faktisk passage ersätter prognosbegränsningen för nya medlemmar', () => {
    service.observeVessel(boat(LEADER, 600, 10));
    at(25);
    service.notePassage(LEADER, 'Klaffbron');
    service.observeVessel(boat(FOLLOWER, 1600, 5));
    at(28);

    expect(warning).toHaveBeenCalledTimes(1);
    expect(coverage).toHaveBeenCalledWith(expect.objectContaining({ mmsi: FOLLOWER, reason: 'absorbed' }));
  });
});

describe('SISUs uppdaterade prognos bevarar ELFKUNGENs förvarning', () => {
  test.each([false, true])('hela fältkörningen, monitoring=%s', (monitoring) => {
    const corpus = corpora.find((entry) => entry.id === '20260708-21h');
    const stdout = execFileSync(process.execPath, [path.join(__dirname, 'replay-validation/replayRunner.js'), corpus.jsonl], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env, REPLAY_MONITORING: monitoring ? '1' : '0', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
      },
    });
    const result = JSON.parse(stdout.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    const passage = gtTargetPassages(corpus).find((p) => p.mmsi === '265573130'
      && p.bridge === 'Klaffbron' && p.iso.startsWith('2026-07-08T10:'));
    const opening = result.openingWarnings.find((w) => w.mmsis.includes('265573130')
      && w.bridge === 'Klaffbron' && w.iso.startsWith('2026-07-08T10:'));

    expect(opening).toMatchObject({ success: true, direction: 'northbound', firedBy: 'deadline' });
    expect(opening.t).toBeLessThan(passage.tFrom);
    expect(opening.t).toBe(Math.ceil(opening.originalDueMs));
    expect(result.processErrors).toBe(0);
    expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
  });
});
