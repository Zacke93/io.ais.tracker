'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const ProgressiveETA = require(path.join(ROOT, 'lib/services/ProgressiveETACalculator'));
const ProximityService = require(path.join(ROOT, 'lib/services/ProximityService'));
const BridgeRegistry = require(path.join(ROOT, 'lib/models/BridgeRegistry'));
const { BRIDGES } = require(path.join(ROOT, 'lib/constants'));

// Samma fysiska färd fortsätter förbi mittpunkten där ProximityService byter
// närmaste bro. Prognosen ska följa den återstående sträckan även när den
// första närmaste bron redan ligger bakom. Mellanbroar framför båten måste
// fortfarande räknas med. Ingen passage stämplas eller ärvs i dessa prov.
describe('Progressiv ETA är jämn när närmaste bro byts', () => {
  const cases = [
    ['olidebron', 'klaffbron', 'Klaffbron', 'north'],
    ['klaffbron', 'jarnvagsbron', 'Stridsbergsbron', 'north'],
    ['jarnvagsbron', 'stridsbergsbron', 'Stridsbergsbron', 'north'],
    ['stallbackabron', 'stridsbergsbron', 'Stridsbergsbron', 'south'],
    ['stridsbergsbron', 'jarnvagsbron', 'Klaffbron', 'south'],
    ['jarnvagsbron', 'klaffbron', 'Klaffbron', 'south'],
  ];

  test.each(cases)('%s → %s med mål %s och riktning %s', (from, to, target, direction) => {
    const logger = {
      debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(),
    };
    const registry = new BridgeRegistry();
    const calculator = new ProgressiveETA(logger, registry);
    const proximity = new ProximityService(registry, logger);
    // Mät själva ruttfelet. EMA/klampar får inte dölja en stigande råprognos.
    const raw = [];
    jest.spyOn(calculator, '_processETAWithProtection').mockImplementation((_vessel, eta) => {
      raw.push(eta);
      return eta;
    });
    const nearestNames = new Set();
    const start = BRIDGES[from];
    const end = BRIDGES[to];
    try {
      for (let percent = 40; percent <= 60; percent += 2) {
        const fraction = percent / 100;
        const vessel = {
          mmsi: '902003002',
          targetBridge: target,
          _routeDirection: direction,
          lat: start.lat + (end.lat - start.lat) * fraction,
          lon: start.lon + (end.lon - start.lon) * fraction,
          sog: 4,
          cog: direction === 'north' ? 35 : 215,
          status: 'en-route',
        };
        const data = proximity.analyzeVesselProximity(vessel);
        nearestNames.add(data.nearestBridge.name);
        calculator.calculateProgressiveETA(vessel, data);
        expect(vessel.lastPassedBridge).toBeUndefined();
        expect(vessel.passedBridges).toBeUndefined();
      }
      expect([...nearestNames]).toEqual([start.name, end.name]);
      expect(raw).toHaveLength(11);
      for (let i = 1; i < raw.length; i++) {
        expect(Number.isFinite(raw[i])).toBe(true);
        expect(raw[i]).toBeLessThan(raw[i - 1]);
        // Det lilla steget på 2% av delsträckan kan inte rättfärdiga ett
        // plötsligt fleraminutershopp när nearest byter identitet.
        expect(raw[i - 1] - raw[i]).toBeLessThan(0.5);
      }
    } finally {
      calculator.destroy();
    }
  });
});
