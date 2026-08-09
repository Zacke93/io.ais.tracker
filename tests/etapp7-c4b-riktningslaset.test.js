'use strict';

/**
 * C4b (etapp 7, fas C, 2026-08-08): riktningslåset skrevs om från RÅ COG i
 * ACCELERATED-grenen efter mooring-släpp.
 *
 * Bakgrund (42h-fältprovet, MARY 219028537, 2026-08-07): efter fem timmars
 * kajliggande i gästhamnen kom ett enda kajwobbel-sampel
 * `13:13:35.272Z lat=58.28714 lon=12.28560 sog=0,6 cog=354,9`. Målbrologiken
 * FÖRKASTADE uttryckligen den COG:n (F4-J):
 *   `🧭 [TARGET_ASSIGNMENT] 219028537: COG-riktning north motsäger låst
 *    ruttriktning south utan rörelsebevis (0.6 kn < 2.0) — följer låset`
 * — men raden direkt efter i ACCELERATED-grenen skrev ändå om
 * `_routeDirection` från exakt samma förkastade COG, och `_lockRouteDirection`
 * skriver alltid över. Låset blev 'north' för en båt som gick söderut
 * (rådata: lat 58,31516 → 58,26531 monotont fallande hela resan).
 *
 * TRE användarsynliga fel ur den enda raden:
 *   1. pelare 2 — Klaffbron-notisen 13:18:07 fick `direction: "northbound"`
 *      (båten gjorde 3,7 kn på cog 219,8° = rakt söderut);
 *   2. pelare 3 — fantomvarningen "Stridsbergsbron öppnar snart, MARY,
 *      norrut, om 8 minuter" 13:33:26 för en bro hon passerat 108 min
 *      tidigare (även ett U2-brott: den öppningen var redan varnad av
 *      Stridsbergsbron#29);
 *   3. dubblettnotis vid Klaffbron via felaktig re-cross-tolkning.
 *
 * Fixen låter låset ÄRVA F4-J:s bevisregel: `_routeDirection` skrivs bara om
 * från COG när riktningen är rörelsebevisad (Fix D:s `FIX_D_MIN_SOG` = 2,0 kn,
 * AERANDIR-härledningen). Testerna låser BÅDA riktningarna av grinden — annars
 * kan en framtida "förenkling" göra den ovillkorlig och tysta äkta U-svängar
 * (HALIFAX/AKIRA-klassen, 4,2/5 kn).
 */

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const geometry = require('../lib/utils/geometry');
const { BRIDGES } = require('../lib/constants');

// MARY:s faktiska kajwobbelposition i gästhamnen (sampel 13:13:35.272Z).
const MARY_WOBBEL = { lat: 58.28714, lon: 12.28560 };
// Två sydgående sampel strax norr om gästhamnen (MARY-klassens anflygning).
const SYD_1 = { lat: 58.29061, lon: 12.29060 };
const SYD_2 = { lat: 58.28915, lon: 12.28854 };

const realDateNow = Date.now;

describe('C4b: ACCELERATED-grenens riktningslås kräver rörelsebevis', () => {
  const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
  let svc;
  let mockNow;

  beforeEach(() => {
    jest.clearAllMocks();
    global.__TEST_MODE__ = true;
    mockNow = new Date(2026, 7, 7, 13, 0, 0).getTime();
    Date.now = () => mockNow;

    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
  });

  afterEach(() => {
    svc.clearAllTimers();
    delete global.__TEST_MODE__;
    Date.now = realDateNow;
  });

  function tick(minutes) {
    mockNow += minutes * 60 * 1000;
  }

  /**
   * Kör upp MARY-tillståndet: sydgående i fart (lås 'south' + rörelsebevis),
   * därefter MOORED_DEMOTE (målbron rensad, låset behållet som ankomstbevis
   * — se kommentaren i updateVessel).
   */
  function seedSouthboundThenDemote(mmsi = '219028537') {
    svc.updateVessel(mmsi, {
      lat: SYD_1.lat, lon: SYD_1.lon, sog: 3.6, cog: 212.1, name: 'MARY',
    });
    tick(1);
    const v = svc.updateVessel(mmsi, {
      lat: SYD_2.lat, lon: SYD_2.lon, sog: 3.5, cog: 219.6, name: 'MARY',
    });
    expect(v._routeDirection).toBe('south');
    expect(v._hasMovementProof).toBe(true);
    // MOORED_DEMOTE: förtöjd båt tappar målbron men BEHÅLLER ruttriktningen.
    const stored = svc.vessels.get(mmsi);
    stored.targetBridge = null;
    stored._pendingTarget = null;
    tick(5);
    return stored;
  }

  test('geometrin: wobbelpositionen ligger i ACCELERATED-vägens fönster (300–500 m från Klaffbron)', () => {
    // Härledning av testets giltighet: hade positionen legat >500 m bort hade
    // fartgrinden (0,7 kn) avvisat 0,6-knopssamplet och testet blivit tomt.
    const d = geometry.calculateDistance(
      MARY_WOBBEL.lat, MARY_WOBBEL.lon, BRIDGES.klaffbron.lat, BRIDGES.klaffbron.lon,
    );
    expect(d).toBeGreaterThan(300);
    expect(d).toBeLessThan(500);
  });

  test('MARY: rå COG 354,9° @ 0,6 kn skriver INTE om låset (behåller south)', () => {
    seedSouthboundThenDemote();

    const v = svc.updateVessel('219028537', {
      lat: MARY_WOBBEL.lat, lon: MARY_WOBBEL.lon, sog: 0.6, cog: 354.9, name: 'MARY',
    });

    // Kärnan: låset står kvar på den bevisade färdriktningen.
    expect(v._routeDirection).toBe('south');
    // ...och målbron är den som F4-J redan valde ur låset, inte nordmålet.
    expect(v.targetBridge).toBe('Klaffbron');
    // Grinden ska ha loggat sitt skäl (spårbarhet i fält).
    const keeps = logger.debug.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('[ROUTE_LOCK_KEEP]'));
    expect(keeps).toHaveLength(1);
    expect(keeps[0]).toContain('219028537');
  });

  test('kontrapositiv: samma COG @ 3,7 kn (rörelsebevisad U-sväng) skriver om låset till north', () => {
    seedSouthboundThenDemote('257605080');

    const v = svc.updateVessel('257605080', {
      lat: MARY_WOBBEL.lat, lon: MARY_WOBBEL.lon, sog: 3.7, cog: 354.9, name: 'AKIRA',
    });

    // HALIFAX/AKIRA-klassen: äkta U-sväng med fart följer COG precis som förut.
    expect(v._routeDirection).toBe('north');
    expect(v.targetBridge).toBe('Stridsbergsbron');
    expect(logger.debug.mock.calls.map((c) => String(c[0])).join('\n'))
      .not.toContain('[ROUTE_LOCK_KEEP]');
  });

  test('tröskeln ligger på FIX_D_MIN_SOG: 1,9 kn håller låset, 2,0 kn släpper det', () => {
    seedSouthboundThenDemote('111111111');
    const under = svc.updateVessel('111111111', {
      lat: MARY_WOBBEL.lat, lon: MARY_WOBBEL.lon, sog: 1.9, cog: 354.9, name: 'UNDER',
    });
    expect(under._routeDirection).toBe('south');

    seedSouthboundThenDemote('222222222');
    const over = svc.updateVessel('222222222', {
      lat: MARY_WOBBEL.lat, lon: MARY_WOBBEL.lon, sog: 2.0, cog: 354.9, name: 'OVER',
    });
    expect(over._routeDirection).toBe('north');
  });

  test('NARROWNESS 1: utan tidigare lås skriver COG låset som förut, även under 2 kn', () => {
    // Grinden får bara bita när den MOTSÄGER ett befintligt lås. En båt utan
    // lås (ny resa) ska fortfarande få riktning ur sin COG — annars strandar
    // ACCELERATED-vägen helt.
    svc.updateVessel('333333333', {
      lat: SYD_1.lat, lon: SYD_1.lon, sog: 3.6, cog: 212.1, name: 'UTAN_LÅS',
    });
    const stored = svc.vessels.get('333333333');
    stored.targetBridge = null;
    stored._routeDirection = null; // inget ankomstbevis
    tick(5);

    const v = svc.updateVessel('333333333', {
      lat: MARY_WOBBEL.lat, lon: MARY_WOBBEL.lon, sog: 0.6, cog: 354.9, name: 'UTAN_LÅS',
    });
    expect(v._routeDirection).toBe('north');
    expect(v.targetBridge).toBe('Stridsbergsbron');
  });

  test('NARROWNESS 2: COG som SAMSTÄMMER med låset skriver oförändrat, ingen grind-logg', () => {
    seedSouthboundThenDemote('444444444');
    const v = svc.updateVessel('444444444', {
      lat: MARY_WOBBEL.lat, lon: MARY_WOBBEL.lon, sog: 0.6, cog: 195.0, name: 'SAMSTÄMMIG',
    });
    expect(v._routeDirection).toBe('south');
    expect(v.targetBridge).toBe('Klaffbron');
    expect(logger.debug.mock.calls.map((c) => String(c[0])).join('\n'))
      .not.toContain('[ROUTE_LOCK_KEEP]');
  });

  test('_lockRouteDirection är fortfarande ovillkorlig (bevisen ägs av anroparna)', () => {
    // Doktrin: Fix D-debouncen och korsningsbevis-reversalen ÄR beviset på sina
    // anropsställen. En global grind här hade tystat dem — det ska den inte.
    const v = { mmsi: '555555555', _routeDirection: 'south' };
    svc._lockRouteDirection(v, 'north');
    expect(v._routeDirection).toBe('north');
  });

  test('svälj-fällan: ingen felväg triggades av grinden', () => {
    seedSouthboundThenDemote();
    svc.updateVessel('219028537', {
      lat: MARY_WOBBEL.lat, lon: MARY_WOBBEL.lon, sog: 0.6, cog: 354.9, name: 'MARY',
    });
    expect(svc.app.error).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
