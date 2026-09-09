'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const RouteOrderValidator = require('../lib/services/RouteOrderValidator');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

const NOW = Date.parse('2026-07-08T07:30:09.323Z');
const MMSI = '257605080';
const SOUTH_JARN = { lat: 58.289341666666665, lon: 12.289396666666667 };
const NORTH_STRIDS = { lat: 58.29712, lon: 12.299386666666667 };
const SOUTH_KLAFF = { lat: 58.282, lon: 12.283 };

describe('Mellanbro och målbro i samma AIS-segment bokförs i färdordning', () => {
  let service;
  let route;
  let gate;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const registry = new BridgeRegistry();
    route = new RouteOrderValidator(logger, registry);
    gate = {
      shouldBlockPassageDetection: jest.fn(() => false),
      registerCandidatePassage: jest.fn(),
    };
    service = new VesselDataService(logger, registry, new SystemCoordinator(logger));
    service.app = { routeOrderValidator: route, gpsJumpGateService: gate };
  });

  afterEach(() => {
    service.clearAllTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function segment(from = SOUTH_JARN, to = NORTH_STRIDS, direction = 'north', targetBridge = 'Stridsbergsbron') {
    const previous = {
      mmsi: MMSI,
      ...from,
      timestamp: NOW - 600000,
      lastPositionUpdate: NOW - 600000,
      sog: 5,
      cog: direction === 'north' ? 30 : 210,
      _routeDirection: direction,
      _hasMovementProof: true,
      targetBridge,
      passedBridges: [],
    };
    return {
      previous,
      current: {
        ...previous, ...to, timestamp: NOW, lastPositionUpdate: NOW, passedBridges: [],
      },
    };
  }
  const history = () => route._getPassageHistory(MMSI).map((p) => p.bridgeName);

  test('AKIRA-segmentet: Järnvägsbron registreras före Stridsbergsbron', () => {
    const { previous, current } = segment();
    expect(service._hasPassedTargetBridge(current, previous)).toBe(true);
    expect(history()).toEqual(['Järnvägsbron', 'Stridsbergsbron']);
    expect(current.passedBridges).toEqual(['Järnvägsbron', 'Stridsbergsbron']);
    expect(current.lastPassedBridge).toBe('Stridsbergsbron');
    expect(current.passedAt['Järnvägsbron']).toBe(NOW);
  });

  test('söderut registreras Strids, Järnvägsbron, Klaff i den ordningen', () => {
    const { previous, current } = segment(NORTH_STRIDS, SOUTH_KLAFF, 'south', 'Klaffbron');
    expect(service._hasPassedTargetBridge(current, previous)).toBe(true);
    expect(history()).toEqual(['Stridsbergsbron', 'Järnvägsbron', 'Klaffbron']);
    expect(current.lastPassedBridge).toBe('Klaffbron');
  });

  test('en ensam målbrokorsning skapar ingen tidigare mellanbropassage', () => {
    const { previous, current } = segment({ lat: 58.29301, lon: 12.29399 });
    expect(service._hasPassedTargetBridge(current, previous)).toBe(true);
    expect(history()).toEqual(['Stridsbergsbron']);
  });

  test('segmentets senare målbroer körs först efter tidigare målbro', () => {
    const { previous, current } = segment(SOUTH_KLAFF, NORTH_STRIDS, 'north', 'Klaffbron');
    service._handleTargetBridgeTransition(current, previous);
    expect(history()).toEqual(['Klaffbron', 'Järnvägsbron', 'Stridsbergsbron']);
    expect(current.lastPassedBridge).toBe('Stridsbergsbron');
  });

  test('samma segment som prövas igen registreras inte dubbelt', () => {
    const { previous, current } = segment();
    expect(service._hasPassedTargetBridge(current, previous)).toBe(true);
    expect(service._hasPassedTargetBridge(current, previous)).toBe(true);
    expect(history()).toEqual(['Järnvägsbron', 'Stridsbergsbron']);
  });

  test('ett GPS-gatat hopp skapar inga tidigare passager', () => {
    const { previous, current } = segment();
    current._gpsJumpDetected = true;
    gate.shouldBlockPassageDetection.mockReturnValue(true);
    expect(service._hasPassedTargetBridge(current, previous)).toBe(false);
    expect(history()).toEqual([]);
    expect(current.passedBridges).toEqual([]);
  });

  test('mellanbrons egen GPS-grind kan stoppa den trots fri målbro', () => {
    const { previous, current } = segment();
    gate.shouldBlockPassageDetection.mockImplementation((_mmsi, _vessel, bridge) => bridge === 'Järnvägsbron');
    expect(service._hasPassedTargetBridge(current, previous)).toBe(true);
    expect(history()).toEqual(['Stridsbergsbron']);
    expect(gate.registerCandidatePassage).toHaveBeenCalledWith(
      MMSI, 'Järnvägsbron', expect.any(Object), current,
    );
  });

  test('befintlig historik framför segmentet får fortfarande fälla bakåtpassager', () => {
    const { previous, current } = segment();
    route.registerPassage(MMSI, 'Stallbackabron', previous, 'north');
    expect(service._hasPassedTargetBridge(current, previous)).toBe(false);
    expect(history()).toEqual(['Stallbackabron']);
  });

  test('sidomanöver utan mellanbrons sidbyte får ingen ny passage', () => {
    const { previous, current } = segment({ lat: 58.29301, lon: 12.29399 });
    service._hasPassedTargetBridge(current, previous);
    expect(current.passedBridges).not.toContain('Järnvägsbron');
  });
});

test('hela AKIRA-replayn behåller Järnvägspassagen och den rättade Strids-målpassagen', () => {
  const replayDir = path.join(__dirname, 'replay-validation');
  const output = execFileSync(process.execPath, [
    path.join(replayDir, 'replayRunner.js'),
    path.join(replayDir, 'corpora-data/ais-replay-20260708-001857.jsonl'),
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const result = JSON.parse(output.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
  expect(result.intermediatePassages.filter((p) => p.mmsi === MMSI && p.bridge === 'Järnvägsbron'))
    .toEqual([expect.objectContaining({ t: NOW, noTarget: false })]);
  expect(result.targetPassages.filter((p) => p.mmsi === MMSI && p.bridge === 'Stridsbergsbron'))
    .toEqual([expect.objectContaining({ t: NOW })]);
  expect(result.processErrors).toBe(0);
});
