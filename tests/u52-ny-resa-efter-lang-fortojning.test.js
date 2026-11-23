'use strict';

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { BRIDGES, MOORING_DETECTION } = require('../lib/constants');

/**
 * U52 (dirigentens beslut 2026-11-23): en båt som legat förtöjd minst 2 h
 * börjar en ny resa när hon lägger ut. Enhetstest för stegen i
 * VesselDataService._applyLongMooringDeparture (släppet, riktningen på första
 * fixen i fart, bekräftelsen på andra fixen i samma riktning) och för spärren
 * i _calculateTargetBridge under fönstret. Positionerna är egna.
 */
describe('U52: ny resa efter lång förtöjning', () => {
  let vds;
  let now;
  const realDateNow = Date.now;
  const logger = { debug: jest.fn(), error: jest.fn(), log: jest.fn() };
  const MMSI = '975200001';
  // Kaj söder om Kanalinfarten (alla broar norr om den).
  const KAJ = { lat: 58.2666, lon: 12.2702 };
  const H = 60 * 60 * 1000;

  beforeEach(() => {
    jest.clearAllMocks();
    global.__TEST_MODE__ = true;
    now = new Date(2026, 10, 23, 8, 0, 0).getTime();
    Date.now = () => now;
    vds = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    vds.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
  });

  afterEach(() => {
    vds.clearAllTimers();
    delete global.__TEST_MODE__;
    Date.now = realDateNow;
  });

  const moored = (overrides = {}) => ({
    mmsi: MMSI,
    lat: KAJ.lat,
    lon: KAJ.lon,
    _moored: true,
    _stationarySince: now - 3 * H,
    passedBridges: ['Olidebron'],
    _routeDirection: 'south',
    _finalTargetDirection: 'south',
    _finalTargetBridge: 'Klaffbron',
    _longMooringDeparture: null,
    ...overrides,
  });
  const fix = (prev, overrides = {}) => ({
    ...prev,
    _moored: false,
    _stationarySince: null,
    lat: prev.lat + 0.0015,
    sog: 6.4,
    cog: 30,
    _rawPositionSog: 6.4,
    _rawPositionCog: 30,
    ...overrides,
  });

  test('släpp efter minst 2 h öppnar fönstret; under 2 h gör det inte', () => {
    const lang = moored();
    const v1 = fix(lang, { sog: 0.6, _rawPositionSog: 0.6 });
    vds._applyLongMooringDeparture(v1, lang);
    expect(v1._longMooringDeparture).toMatchObject({ mooredLat: KAJ.lat, passedAtRelease: ['Olidebron'] });

    const kort = moored({ _stationarySince: now - MOORING_DETECTION.MAX_STATIONARY_WAIT_MS + 60000 });
    const v2 = fix(kort, { sog: 0.6, _rawPositionSog: 0.6 });
    vds._applyLongMooringDeparture(v2, kort);
    expect(v2._longMooringDeparture).toBeNull();
    expect(v2.passedBridges).toEqual(['Olidebron']);
    expect(v2._routeDirection).toBe('south');
  });

  test('första fixen i minst 2 kn släpper förra resans riktning, men inte passerade broar', () => {
    const prev = moored();
    const v = fix(prev);
    vds._applyLongMooringDeparture(v, prev);
    expect(v._routeDirection).toBeNull();
    expect(v._finalTargetDirection).toBeNull();
    expect(v._finalTargetBridge).toBeNull();
    expect(v.passedBridges).toEqual(['Olidebron']);
    expect(v._longMooringDeparture).toMatchObject({ directionCleared: true, pendingDir: 'north' });
  });

  test('fixen före släppet räknas som första observation när den visade gång', () => {
    // Stillhetshållet klassade båten förtöjd en fix till, fast hon gick 2,2 kn söderut.
    const prev = moored({
      sog: 2.2, cog: 229, _rawPositionSog: 2.2, _rawPositionCog: 229,
    });
    const v = fix(prev, {
      lat: prev.lat - 0.0005, sog: 3.5, cog: 224, _rawPositionSog: 3.5, _rawPositionCog: 224,
    });
    vds._applyLongMooringDeparture(v, prev);
    expect(v._longMooringDeparture).toBeNull();
    expect(v._routeDirection).toBe('south');
    // Utan gång i fixen före släppet krävs två fixar efter släppet.
    const still = moored({
      sog: 0, cog: 229, _rawPositionSog: 0, _rawPositionCog: 229,
    });
    const w = fix(still, {
      sog: 3.5, cog: 224, _rawPositionSog: 3.5, _rawPositionCog: 224,
    });
    vds._applyLongMooringDeparture(w, still);
    expect(w._longMooringDeparture).toMatchObject({ pendingDir: 'south' });
  });

  test('under 2 kn släpps ingenting (bara fönstret öppnas)', () => {
    const prev = moored();
    const v = fix(prev, { sog: 1.5, _rawPositionSog: 1.5 });
    vds._applyLongMooringDeparture(v, prev);
    expect(v._routeDirection).toBe('south');
    expect(v._longMooringDeparture.directionCleared).toBe(false);
  });

  test('andra fixen i samma riktning: broar framför förtöjningsplatsen nollställs, eventet går', () => {
    const events = [];
    vds.on('vessel:journey-reset', (e) => events.push(e));
    const prev = moored();
    const v1 = fix(prev);
    vds._applyLongMooringDeparture(v1, prev);
    now += 60000;
    const v2 = fix(v1);
    vds._applyLongMooringDeparture(v2, v1);
    expect(v2.passedBridges).toEqual([]);
    expect(v2._routeDirection).toBe('north');
    expect(v2._longMooringDeparture).toBeNull();
    expect(v2._journeyStartLat).toBe(KAJ.lat);
    expect(v2._reversalConfirmedAt == null).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ mmsi: MMSI, direction: 'north', bridges: ['Olidebron'] });
    expect(events[0].prevJourneyDirection).toBeUndefined();
  });

  test('broar BAKOM förtöjningsplatsen står kvar (parkerad bortom passerad bro, vidare bort)', () => {
    const events = [];
    vds.on('vessel:journey-reset', (e) => events.push(e));
    // Kajen norr om Klaffbron, vidare norrut: Olidebron och Klaffbron bakom.
    const prev = moored({
      lat: 58.2861, lon: 12.2857, passedBridges: ['Olidebron', 'Klaffbron'], _routeDirection: 'north', _finalTargetDirection: null,
    });
    const v1 = fix(prev);
    vds._applyLongMooringDeparture(v1, prev);
    const v2 = fix(v1);
    vds._applyLongMooringDeparture(v2, v1);
    expect(v2.passedBridges).toEqual(['Olidebron', 'Klaffbron']);
    expect(v2._routeDirection).toBe('north');
    expect(events).toHaveLength(0);
  });

  test('samma kaj, ut söderut: broarna framför i den nya riktningen nollställs', () => {
    const prev = moored({
      lat: 58.2861, lon: 12.2857, passedBridges: ['Olidebron', 'Klaffbron'], _routeDirection: 'north', _finalTargetDirection: null,
    });
    const v1 = fix(prev, { lat: prev.lat - 0.0015, cog: 205, _rawPositionCog: 205 });
    vds._applyLongMooringDeparture(v1, prev);
    const v2 = fix(v1, { lat: v1.lat - 0.0015, cog: 205, _rawPositionCog: 205 });
    vds._applyLongMooringDeparture(v2, v1);
    expect(v2.passedBridges).toEqual([]);
    expect(v2._routeDirection).toBe('south');
  });

  test('en ensam fix åt fel håll bekräftar ingenting (två i rad krävs)', () => {
    const prev = moored({
      lat: 58.2861, lon: 12.2857, passedBridges: ['Olidebron', 'Klaffbron'], _routeDirection: 'north', _finalTargetDirection: null,
    });
    const v1 = fix(prev, {
      cog: 200, _rawPositionCog: 200, sog: 2.5, _rawPositionSog: 2.5,
    });
    vds._applyLongMooringDeparture(v1, prev);
    const v2 = fix(v1, { cog: 20, _rawPositionCog: 20 });
    vds._applyLongMooringDeparture(v2, v1);
    expect(v2.passedBridges).toEqual(['Olidebron', 'Klaffbron']);
    expect(v2._longMooringDeparture).toMatchObject({ pendingDir: 'north' });
  });

  test('kurs i dödbandet nollar den väntande riktningen', () => {
    const prev = moored();
    const v1 = fix(prev);
    vds._applyLongMooringDeparture(v1, prev);
    const v2 = fix(v1, { cog: 90, _rawPositionCog: 90 });
    vds._applyLongMooringDeparture(v2, v1);
    expect(v2._longMooringDeparture.pendingDir).toBeNull();
    const v3 = fix(v2);
    vds._applyLongMooringDeparture(v3, v2);
    expect(v3.passedBridges).toEqual(['Olidebron']);
  });

  test('en långsam fix mitt i avgången nollar inte den väntande riktningen (granskningen R-A3)', () => {
    const prev = moored();
    const v1 = fix(prev);
    vds._applyLongMooringDeparture(v1, prev);
    now += 60000;
    const v2 = fix(v1, { sog: 1.5, _rawPositionSog: 1.5 });
    vds._applyLongMooringDeparture(v2, v1);
    expect(v2._longMooringDeparture).toMatchObject({ pendingDir: 'north' });
    now += 60000;
    const v3 = fix(v2);
    vds._applyLongMooringDeparture(v3, v2);
    expect(v3.passedBridges).toEqual([]);
    expect(v3._routeDirection).toBe('north');
  });

  test('den väntande riktningen gäller i 15 min: två fixar en timme isär bekräftar ingenting', () => {
    const prev = moored();
    const v1 = fix(prev);
    vds._applyLongMooringDeparture(v1, prev);
    now += 60 * 60000; // en timme stilla, ingen ny förtöjningsklassning
    const v2 = fix(v1, { sog: 0, _rawPositionSog: 0 });
    vds._applyLongMooringDeparture(v2, v1);
    const v3 = fix(v2);
    vds._applyLongMooringDeparture(v3, v2);
    expect(v3.passedBridges).toEqual(['Olidebron']);
    expect(v3._longMooringDeparture).toMatchObject({ pendingDir: 'north', pendingAt: now });
    // Inom gränsen bekräftar nästa fix.
    now += 14 * 60000;
    const v4 = fix(v3);
    vds._applyLongMooringDeparture(v4, v3);
    expect(v4.passedBridges).toEqual([]);
  });

  test('en ny kort förtöjning i fönstret bryter följden men stänger inte fönstret', () => {
    const prev = moored();
    const v1 = fix(prev);
    vds._applyLongMooringDeparture(v1, prev);
    const v2 = {
      ...v1, _moored: true, _stationarySince: now, sog: 0, _rawPositionSog: 0,
    };
    vds._applyLongMooringDeparture(v2, v1);
    expect(v2._longMooringDeparture).toMatchObject({ pendingDir: null, directionCleared: true });
    now += 20 * 60000;
    const v3 = fix(v2);
    vds._applyLongMooringDeparture(v3, v2); // släpp efter 20 min: fönstret står kvar
    expect(v3._longMooringDeparture).toMatchObject({ pendingDir: 'north' });
    const v4 = fix(v3);
    vds._applyLongMooringDeparture(v4, v3);
    expect(v4.passedBridges).toEqual([]);
  });

  test('en ny passage utan belagd riktning stänger fönstret', () => {
    const prev = moored();
    const v1 = fix(prev, { sog: 0.6, _rawPositionSog: 0.6 });
    vds._applyLongMooringDeparture(v1, prev);
    const v2 = fix(v1, { sog: 1.0, _rawPositionSog: 1.0, passedBridges: ['Olidebron', 'Klaffbron'] });
    vds._applyLongMooringDeparture(v2, v1);
    expect(v2._longMooringDeparture).toBeNull();
    expect(v2.passedBridges).toEqual(['Olidebron', 'Klaffbron']);
  });

  test('en bro som bokförts på nytt efter släppet hör till den nya resan och står kvar', () => {
    const prev = moored({ lat: BRIDGES.olidebron.lat - 0.0008 });
    const v1 = fix(prev);
    vds._applyLongMooringDeparture(v1, prev);
    now += 60000;
    const v2 = fix(v1, { lastPassedBridge: 'Olidebron', lastPassedBridgeTime: now - 1000 });
    vds._applyLongMooringDeparture(v2, v1);
    expect(v2.passedBridges).toEqual(['Olidebron']);
    expect(v2._routeDirection).toBe('north');
  });

  test('en GPS-flaggad fix räknas varken som bevis eller motbevis', () => {
    const prev = moored();
    const v1 = fix(prev);
    vds._applyLongMooringDeparture(v1, prev);
    const v2 = fix(v1, { _gpsJumpDetected: true });
    vds._applyLongMooringDeparture(v2, v1);
    expect(v2._longMooringDeparture).toMatchObject({ pendingDir: 'north' });
    expect(v2.passedBridges).toEqual(['Olidebron']);
  });

  test('en målbro vald under fönstret i fel riktning släpps vid bekräftelsen', () => {
    // Gästhamnen: första fixen norrut (målbron Stridsbergsbron sätts av
    // tilldelningen), sedan två fixar söderut.
    const prev = moored({
      lat: 58.2873, lon: 12.2851, passedBridges: ['Olidebron', 'Klaffbron'], _routeDirection: 'north', _finalTargetDirection: null,
    });
    const v1 = fix(prev);
    vds._applyLongMooringDeparture(v1, prev);
    v1.targetBridge = 'Stridsbergsbron';
    v1._routeDirection = 'north';
    const south = { cog: 205, _rawPositionCog: 205 };
    const v2 = fix(v1, { lat: v1.lat - 0.0015, ...south });
    vds._applyLongMooringDeparture(v2, v1);
    expect(v2.targetBridge).toBe('Stridsbergsbron');
    const v3 = fix(v2, { lat: v2.lat - 0.0015, ...south });
    vds._applyLongMooringDeparture(v3, v2);
    expect(v3.targetBridge).toBeNull();
    expect(v3._routeDirection).toBe('south');
    expect(v3.passedBridges).toEqual([]);

    // Samma riktning som målbron och ingen målbro nollställd: målbron står kvar
    // (lotskajen, ut norrut, Olidebron nollställd, målbron Klaffbron).
    const p = moored();
    const w1 = fix(p);
    vds._applyLongMooringDeparture(w1, p);
    w1.targetBridge = 'Klaffbron';
    w1._routeDirection = 'north';
    const w2 = fix(w1);
    vds._applyLongMooringDeparture(w2, w1);
    expect(w2.targetBridge).toBe('Klaffbron');
    expect(w2.passedBridges).toEqual([]);
  });

  test('målbrospärren under fönstret: passerad målbro framför ger ingen målbro, bakom spärrar inte', () => {
    // Söder om Klaffbron, på väg norrut, Klaffbron passerad på förra resan.
    const v = fix(moored({ passedBridges: ['Klaffbron', 'Olidebron'] }), { lat: 58.2681, lon: 12.2714 });
    v._longMooringDeparture = {
      releasedAt: now, mooredLat: KAJ.lat, passedAtRelease: ['Klaffbron', 'Olidebron'], directionCleared: true, pendingDir: 'north',
    };
    v._routeDirection = null;
    v._finalTargetDirection = null;
    expect(vds._calculateTargetBridge(v, null)).toBeNull();
    // Utan fönstret väljer samma lista Stridsbergsbron (bortom Klaffbron).
    v._longMooringDeparture = null;
    expect(vds._calculateTargetBridge(v, null)).toBe('Stridsbergsbron');

    // Gästhamnen, vidare norrut: Klaffbron bakom, Stridsbergsbron väljs som vanligt.
    const g = fix(moored({ passedBridges: ['Olidebron', 'Klaffbron'] }), { lat: 58.2875, lon: 12.2851 });
    g._longMooringDeparture = {
      releasedAt: now, mooredLat: 58.2873, passedAtRelease: ['Olidebron', 'Klaffbron'], directionCleared: true, pendingDir: 'north',
    };
    g._routeDirection = null;
    g._finalTargetDirection = null;
    expect(vds._calculateTargetBridge(g, null)).toBe('Stridsbergsbron');
  });
});
