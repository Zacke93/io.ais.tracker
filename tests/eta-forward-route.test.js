'use strict';

const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const geometry = require('../lib/utils/geometry');
const { BRIDGES } = require('../lib/constants');

const SPEED = 4;
const METRES_PER_MINUTE = SPEED * 1852 / 60;
const logger = { debug: jest.fn(), error: jest.fn() };
const between = (from, to, fraction) => ({
  lat: from.lat + (to.lat - from.lat) * fraction,
  lon: from.lon + (to.lon - from.lon) * fraction,
});
const distance = (a, b) => geometry.calculateDistance(a.lat, a.lon, b.lat, b.lon);

// Råa ruttavstånd prövas före EMA. En överslätad uppåtstuds är fortfarande
// fel geometri och får inte kunna döljas av monotoni-/publiceringsskydden.
describe('Progressiv ETA följer återstående broar framför båten', () => {
  let calculator;
  let registry;
  beforeEach(() => {
    registry = new BridgeRegistry();
    calculator = new ProgressiveETACalculator(logger, registry);
  });
  afterEach(() => calculator.destroy());

  function boat(position, direction = 'north', extra = {}) {
    return {
      mmsi: '902003001',
      name: 'RUTTPROV',
      sog: SPEED,
      _routeDirection: direction,
      ...position,
      ...extra,
    };
  }
  function route(vessel, nearest, target) {
    return calculator._calculateRouteETA(vessel, nearest, target, {
      nearestBridge: { id: nearest },
      nearestDistance: distance(vessel, BRIDGES[nearest]),
    });
  }

  test('35-minutersåterkomsten söder om Stallbacka räknar framåt utan ärvd passage', () => {
    const positions = [
      { lat: 58.309625022213346, lon: 12.316316798805454 },
      { lat: 58.30893370273422, lon: 12.314632419139262 },
      { lat: 58.30825344436677, lon: 12.312974989547728 },
    ];
    const etas = positions.map((position) => {
      const vessel = boat(position, 'south', { targetBridge: 'Stridsbergsbron' });
      const eta = route(vessel, 'stallbackabron', 'stridsbergsbron');
      expect(eta).toBeCloseTo(distance(vessel, BRIDGES.stridsbergsbron) / METRES_PER_MINUTE, 8);
      expect(vessel.lastPassedBridge).toBeUndefined();
      expect(vessel.passedBridges).toBeUndefined();
      return eta;
    });
    expect(etas[1]).toBeLessThan(etas[0]);
    expect(etas[2]).toBeLessThan(etas[1]);
  });

  test('norr om Olide bevaras Klaff→Järn→Strids i stället för en direkt genväg', () => {
    const vessel = boat(between(BRIDGES.olidebron, BRIDGES.klaffbron, 0.2));
    const eta = route(vessel, 'olidebron', 'stridsbergsbron');
    const expected = (distance(vessel, BRIDGES.klaffbron) + 960 + 257) / METRES_PER_MINUTE;
    expect(eta).toBeCloseTo(expected, 8);
    expect(eta).toBeGreaterThan(distance(vessel, BRIDGES.stridsbergsbron) / METRES_PER_MINUTE);
  });

  test('södergående rutt orienteras om och behåller Klaff→Olide', () => {
    const vessel = boat(between(BRIDGES.jarnvagsbron, BRIDGES.klaffbron, 0.2), 'south');
    const expected = (distance(vessel, BRIDGES.klaffbron) + 1363) / METRES_PER_MINUTE;
    expect(route(vessel, 'jarnvagsbron', 'olidebron')).toBeCloseTo(expected, 8);
  });

  test.each(['north', 'south'])('nearest-byte i %s ger samma kvarvarande rutt', (direction) => {
    const north = direction === 'north';
    const first = north ? 'olidebron' : 'jarnvagsbron';
    const next = 'klaffbron';
    const target = north ? 'stridsbergsbron' : 'olidebron';
    const vessel = boat(between(BRIDGES[first], BRIDGES[next], 0.5), direction);
    // Ett närmaste-bro-byte får inte ensamt ändra ETA på samma position.
    expect(route(vessel, first, target)).toBeCloseTo(route(vessel, next, target), 8);
  });

  test('före första bron ingår både infarten och samtliga mellanbrosträckor', () => {
    const vessel = boat(between(BRIDGES.olidebron, BRIDGES.klaffbron, -0.1));
    const expected = (distance(vessel, BRIDGES.olidebron) + 1363 + 960 + 257) / METRES_PER_MINUTE;
    expect(route(vessel, 'olidebron', 'stridsbergsbron')).toBeCloseTo(expected, 8);
  });

  test.each([
    ['utan riktning', { _routeDirection: null }],
    ['motstridig riktning', { _routeDirection: 'south' }],
    ['GPS-hopp', { _gpsJumpDetected: true }],
    ['osäker position', { _positionUncertain: true }],
  ])('%s ger inget nytt sidobeslut', (_name, extra) => {
    const vessel = boat(between(BRIDGES.olidebron, BRIDGES.klaffbron, 0.2), 'north', extra);
    const expected = (distance(vessel, BRIDGES.olidebron) + 1363 + 960 + 257) / METRES_PER_MINUTE;
    expect(route(vessel, 'olidebron', 'stridsbergsbron')).toBeCloseTo(expected, 8);
  });

  test('latitud norr om Klaff kan fortfarande vara före dess sneda brolinje', () => {
    const vessel = boat({
      lat: BRIDGES.klaffbron.lat + 10 / 111320,
      lon: BRIDGES.klaffbron.lon - 80 / (111320 * Math.cos(BRIDGES.klaffbron.lat * Math.PI / 180)),
    });
    const expected = (distance(vessel, BRIDGES.klaffbron) + 960 + 257) / METRES_PER_MINUTE;
    expect(route(vessel, 'klaffbron', 'stridsbergsbron')).toBeCloseTo(expected, 8);
  });

  test('position i brolinjens osäkerhetsband behåller första waypoint', () => {
    const vessel = boat(between(BRIDGES.klaffbron, BRIDGES.jarnvagsbron, 0.005));
    const expected = (distance(vessel, BRIDGES.klaffbron) + 960 + 257) / METRES_PER_MINUTE;
    expect(route(vessel, 'klaffbron', 'stridsbergsbron')).toBeCloseTo(expected, 8);
  });

  test('flera bakomliggande waypoints kapas utan att sista målbron försvinner', () => {
    const vessel = boat(between(BRIDGES.jarnvagsbron, BRIDGES.stridsbergsbron, 0.25));
    expect(route(vessel, 'olidebron', 'stridsbergsbron'))
      .toBeCloseTo(distance(vessel, BRIDGES.stridsbergsbron) / METRES_PER_MINUTE, 8);
  });

  test('ogiltiga broar och okänd fart ger fortsatt okänd ETA', () => {
    const vessel = boat(between(BRIDGES.olidebron, BRIDGES.klaffbron, 0.2));
    expect(calculator._calculateRouteETA(vessel, null, 'stridsbergsbron', null)).toBeNull();
    expect(route({ ...vessel, sog: null }, 'olidebron', 'stridsbergsbron')).toBeNull();
  });
});
