'use strict';

// PRIMA LADYs fyra råfixar vid Olidebron 2026-08-24. Det andra landar
// 4,8 m bortom linjen: först det tredje bevisar två entydiga sidor.
const StatusService = require('../lib/services/StatusService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const ProximityService = require('../lib/services/ProximityService');
const geometry = require('../lib/utils/geometry');

const FIXES = [
  {
    lat: 58.272325, lon: 12.274451666666666, sog: 3.7, cog: 35.6, at: 0,
  },
  {
    lat: 58.27278, lon: 12.27516, sog: 3.7, cog: 39.5, at: 38921,
  },
  {
    lat: 58.27291833333334, lon: 12.275391666666668, sog: 3.7, cog: 38.9, at: 44271,
  },
  {
    lat: 58.27364, lon: 12.27662, sog: 3.4, cog: 43.8, at: 104462,
  },
];

describe('P1 — korsning genom brolinjens epsilonband', () => {
  let service;
  let proximity;
  let registry;
  let vessel;
  let vds;
  const start = Date.parse('2026-08-24T16:05:07.971Z');

  beforeEach(() => {
    jest.useFakeTimers({ now: start });
    const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    registry = new BridgeRegistry();
    vds = { anchorPassageTimestamp: jest.fn() };
    service = new StatusService(registry, logger, new SystemCoordinator(logger), vds);
    proximity = new ProximityService(registry, logger);
    vessel = {
      mmsi: '230693000', name: 'PRIMA LADY', targetBridge: 'Klaffbron', status: 'en-route',
    };
  });

  afterEach(() => jest.useRealTimers());

  const observe = (fix, positionAnalysis = null) => {
    jest.setSystemTime(start + fix.at);
    Object.assign(vessel, fix, { timestamp: Date.now(), lastPositionUpdate: Date.now() });
    const result = service.analyzeVesselStatus(vessel, proximity.analyzeVesselProximity(vessel), positionAnalysis);
    vessel.status = result.status;
    vessel.isWaiting = result.isWaiting;
  };

  test('rådata: osäker inträdesfix bokför inget; nästa fix återvinner passagen', () => {
    observe(FIXES[0]);
    observe(FIXES[1]);
    expect(vessel._underBridgeCrossedBridge).toBeNull();
    expect(vds.anchorPassageTimestamp).not.toHaveBeenCalled();
    observe(FIXES[2]);
    expect(vessel._underBridgeCrossedBridge).toBe('Olidebron');
    const exit = geometry.detectBridgePassage({ ...vessel, ...FIXES[3] }, vessel, registry.getBridgeByName('Olidebron'));
    expect(exit.passed).toBe(true);
    expect(exit.method).toBe('traditional_close_passage');
  });

  test('timerpass på samma fix bevarar kandidaten utan att bekräfta', () => {
    observe(FIXES[0]);
    observe(FIXES[1]);
    const distance = vessel._underBridgePendingCross.distanceM;
    observe({ ...FIXES[1], at: 40000 });
    expect(vessel._underBridgePendingCross.distanceM).toBe(distance);
    expect(vessel._underBridgeCrossedBridge).toBeNull();
    observe(FIXES[2]);
    expect(vessel._underBridgeCrossedBridge).toBe('Olidebron');
  });

  test('samma sida med ena fixen i epsilonbandet skapar ingen kandidat', () => {
    observe(FIXES[0]);
    const nearLine = {
      ...FIXES[1],
      lat: FIXES[0].lat + 0.9 * (FIXES[1].lat - FIXES[0].lat),
      lon: FIXES[0].lon + 0.9 * (FIXES[1].lon - FIXES[0].lon),
    };
    const bridge = registry.getBridgeByName('Olidebron');
    expect(geometry.hasChangedBridgeSide(FIXES[0], nearLine, bridge)).toBe(true);
    expect(geometry.hasCrossedBridgeLine(FIXES[0], nearLine, bridge)).toBe(false);
    observe(nearLine);
    expect(vessel._underBridgePendingCross).toBeNull();
    expect(vessel._underBridgeCrossedBridge).toBeNull();
  });

  test('osäker fix under syntetisk broöppning rensar före den tidiga returen', () => {
    observe(FIXES[0]);
    observe(FIXES[1]);
    vessel._bridgeOpeningUntil = start + 100000;
    vessel._bridgeOpeningBridgeName = 'Olidebron';
    vessel._positionUncertain = true;
    observe({ ...FIXES[1], at: 41000 });
    expect(vessel._underBridgePendingCross).toBeNull();
  });

  test('många små epsilonsteg får inte kringgå taket för hela spårets längd', () => {
    observe(FIXES[0]);
    observe(FIXES[1]);
    const bridge = registry.getBridgeByName('Olidebron');
    // Alla steg är korta och alla punkter i epsilonbandet. Det ursprungliga
    // ankaret ska ändå kasseras när den sammanlagda sträckan passerar 400 m.
    // Hela följden är under två minuter, så det är längdvakten som prövas.
    for (let i = 0; i < 80; i += 1) {
      observe({
        ...FIXES[1], lat: bridge.lat + (i % 2 ? -4 : 4) / 111320, lon: bridge.lon, at: 40000 + i * 500,
      });
    }
    observe({ ...FIXES[2], at: 81000 });
    expect(vessel._underBridgeCrossedBridge).not.toBe('Olidebron');
  });

  test('U-sväng ut på ursprungssidan ger ingen passage', () => {
    observe(FIXES[0]);
    observe(FIXES[1]);
    observe(FIXES[2]);
    observe({ ...FIXES[0], at: 60000, cog: 215 });
    const farther = {
      lat: 58.27195, lon: 12.27385, sog: 3.7, cog: 215, at: 90000,
    };
    expect(geometry.detectBridgePassage({ ...vessel, ...farther }, vessel, registry.getBridgeByName('Olidebron')).passed).toBe(false);
    observe(farther);
    expect(vds.anchorPassageTimestamp).not.toHaveBeenCalled();
  });

  test.each(['stillhet', 'GPS-hopp', 'osäker position', 'tidslucka'])('%s bryter epsilon-kedjan', (reason) => {
    observe(FIXES[0]);
    observe(FIXES[1]);
    if (reason === 'stillhet') observe({ ...FIXES[1], sog: 0, at: 41000 });
    if (reason === 'GPS-hopp') observe({ ...FIXES[1], at: 41000 }, { gpsJumpDetected: true });
    if (reason === 'osäker position') {
      vessel._positionUncertain = true;
      observe({ ...FIXES[1], at: 41000 });
      vessel._positionUncertain = false;
    }
    observe({ ...FIXES[2], at: reason === 'tidslucka' ? 180000 : FIXES[2].at });
    expect(vessel._underBridgeCrossedBridge).not.toBe('Olidebron');
  });

  test('brobyte avslutar kandidaten även när fartyget står på samma fix', () => {
    observe(FIXES[0]);
    observe(FIXES[1]);
    vessel.targetBridge = 'Stridsbergsbron';
    observe({ ...FIXES[1], at: 41000 });
    expect(vessel._underBridgePendingCross).toBeNull();
  });
});
