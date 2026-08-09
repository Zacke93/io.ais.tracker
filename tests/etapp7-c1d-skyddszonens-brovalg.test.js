'use strict';

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const geometry = require('../lib/utils/geometry');

/**
 * C1d (etapp 7 fas C, fältprovet 42h 2026-08-08, fynd F-6).
 *
 * `_isInProtectionZone` returnerade den NÄRMASTE bron inom 300 m. För en båt
 * som köade mellan Stridsbergsbron (passerad) och Järnvägsbron (opasserad, på
 * rutten mot målbron Klaffbron) valde närmast-regeln den PASSERADE bron →
 * F21:s bypass slog till → målbron rensades → Homey visade "Inga båtar är i
 * närheten av Klaffbron eller Stridsbergsbron" mitt i transiten.
 *
 * Rådata (korpus 20260806-42h): ELFKUNGEN 265573130 `2026-08-06T12:05:26`
 * lat 58.29276 lon 12.29388 sog 0 — 1 125 m till Klaffbron, 165 m till
 * Järnvägsbron, 94 m till Stridsbergsbron (passerad 11:58:40). Hon korsade
 * Järnvägsbron 12:22:12 och Klaffbron 12:31:17, dvs. hon var en ÄKTA köare.
 * Identiskt: ANDREA 219031446 18:42:15, MARY 219028537 11:47:58 + 12:03:41,
 * MISTRAL 219025192 11:51:21.
 *
 * Fixen: en OPASSERAD bro som ligger framför fartyget på rutten (närmare
 * målbron än fartyget självt) väljs före en närmare passerad. Målbron själv
 * befordras INTE — F21:s frigöringsfall ska bestå.
 */
describe('C1d: skyddszonens val mellan två broar inom radien', () => {
  const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
  let svc;
  let bridgeRegistry;

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    bridgeRegistry = new BridgeRegistry();
    svc = new VesselDataService(logger, bridgeRegistry, new SystemCoordinator(logger));
  });

  afterEach(() => {
    try {
      svc.clearAllTimers();
    } catch (_) { /* tomt */ }
    delete global.__TEST_MODE__;
  });

  /** ELFKUNGENs faktiska väntposition ur korpus 20260806-42h. */
  const ELFKUNGEN_WAIT = { lat: 58.29276, lon: 12.29388 };

  const bypassCondition = (pz, vessel) => pz.isProtected
    && Array.isArray(vessel.passedBridges)
    && vessel.passedBridges.includes(pz.bridge)
    && pz.bridge !== vessel.targetBridge;

  test('rådatapositionen ligger inom radien för BÅDA broarna (premissen)', () => {
    const jarn = bridgeRegistry.getBridgeByName('Järnvägsbron');
    const strids = bridgeRegistry.getBridgeByName('Stridsbergsbron');
    const dJarn = geometry.calculateDistance(
      ELFKUNGEN_WAIT.lat, ELFKUNGEN_WAIT.lon, jarn.lat, jarn.lon,
    );
    const dStrids = geometry.calculateDistance(
      ELFKUNGEN_WAIT.lat, ELFKUNGEN_WAIT.lon, strids.lat, strids.lon,
    );
    expect(Math.round(dJarn)).toBe(165);
    expect(Math.round(dStrids)).toBe(94);
    // Den passerade bron är NÄRMAST — det är hela buggens premiss.
    expect(dStrids).toBeLessThan(dJarn);
  });

  test('köande båt: opasserad bro på rutten väljs före närmare passerad', () => {
    const vessel = {
      mmsi: '265573130',
      ...ELFKUNGEN_WAIT,
      sog: 0,
      cog: 196.4,
      targetBridge: 'Klaffbron',
      passedBridges: ['Stallbackabron', 'Stridsbergsbron'],
    };
    const pz = svc._isInProtectionZone(vessel);
    expect(pz.isProtected).toBe(true);
    expect(pz.bridge).toBe('Järnvägsbron');
    expect(pz.selectedBy).toBe('ahead-unpassed');
    // Skyddet får INTE bypassas → målbron behålls.
    expect(bypassCondition(pz, vessel)).toBe(false);
  });

  test('samma position UTAN opasserad bro på rutten → närmast-regeln gäller (F21 intakt)', () => {
    const vessel = {
      mmsi: '265573130',
      ...ELFKUNGEN_WAIT,
      sog: 0,
      cog: 196.4,
      targetBridge: 'Klaffbron',
      // Även Järnvägsbron passerad → ingen opasserad bro framför i zonen.
      passedBridges: ['Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron'],
    };
    const pz = svc._isInProtectionZone(vessel);
    expect(pz.bridge).toBe('Stridsbergsbron');
    expect(pz.selectedBy).toBe('nearest');
    expect(bypassCondition(pz, vessel)).toBe(true);
  });

  test('MÅLBRON befordras inte — ankrad vid passerad mellanbro frigörs som förut (F21)', () => {
    const jarn = bridgeRegistry.getBridgeByName('Järnvägsbron');
    const vessel = {
      mmsi: '2',
      lat: jarn.lat,
      lon: jarn.lon,
      sog: 0.1,
      cog: 30,
      targetBridge: 'Stridsbergsbron',
      passedBridges: ['Järnvägsbron'],
    };
    const pz = svc._isInProtectionZone(vessel);
    // Stridsbergsbron ligger 257 m bort och ÄR inom radien — hade målbron
    // befordrats vore F21:s bypass död och den frysta målbron tillbaka.
    expect(pz.bridge).toBe('Järnvägsbron');
    expect(bypassCondition(pz, vessel)).toBe(true);
  });

  test('bro bakom fartyget befordras inte (rutt-villkoret, inte bara "opasserad")', () => {
    // Båt strax söder om Stridsbergsbron som ALDRIG passerat den, på väg mot
    // Klaffbron: Stridsbergsbron är opasserad men ligger BAKOM (längre från
    // målbron än fartyget) → ingen befordran, närmast vinner.
    const vessel = {
      mmsi: '3',
      ...ELFKUNGEN_WAIT,
      sog: 0.2,
      cog: 200,
      targetBridge: 'Klaffbron',
      passedBridges: [],
    };
    const strids = bridgeRegistry.getBridgeByName('Stridsbergsbron');
    const klaff = bridgeRegistry.getBridgeByName('Klaffbron');
    const bridgeToTarget = geometry.calculateDistance(
      strids.lat, strids.lon, klaff.lat, klaff.lon,
    );
    const vesselToTarget = geometry.calculateDistance(
      ELFKUNGEN_WAIT.lat, ELFKUNGEN_WAIT.lon, klaff.lat, klaff.lon,
    );
    expect(bridgeToTarget).toBeGreaterThan(vesselToTarget); // bron ligger bakom
    const pz = svc._isInProtectionZone(vessel);
    // Järnvägsbron (opasserad, framför) vinner ändå — men på rutt-villkoret,
    // inte på "opasserad".
    expect(pz.bridge).toBe('Järnvägsbron');
    expect(pz.selectedBy).toBe('ahead-unpassed');
  });

  test('utan målbro faller valet tillbaka på närmast (ingen rutt att mäta mot)', () => {
    const vessel = {
      mmsi: '4',
      ...ELFKUNGEN_WAIT,
      sog: 0,
      cog: 0,
      passedBridges: ['Stridsbergsbron'],
    };
    const pz = svc._isInProtectionZone(vessel);
    expect(pz.bridge).toBe('Stridsbergsbron');
    expect(pz.selectedBy).toBe('nearest');
  });

  test('ogiltig position: ingen bro rapporteras (null-guarden från V1-1 lever)', () => {
    const pz = svc._isInProtectionZone({
      mmsi: '5', lat: NaN, lon: NaN, targetBridge: 'Klaffbron', passedBridges: [],
    });
    expect(pz.isProtected).toBe(false);
  });

  test('MUTATIONSBEVIS: utan rutt-villkoret skulle bron bakom kunna vinna', () => {
    // Vakten mot en framtida "förenkling" till ren opasserad-preferens:
    // om rutt-villkoret tas bort blir Stridsbergsbron (opasserad, bakom,
    // 94 m) vald i föregående test i stället för Järnvägsbron (166 m).
    // Här bevisas bara att de två kandidaterna FAKTISKT rangordnas olika av
    // avstånd respektive rutt — annars vore testet ovan tautologiskt.
    const jarn = bridgeRegistry.getBridgeByName('Järnvägsbron');
    const strids = bridgeRegistry.getBridgeByName('Stridsbergsbron');
    const dJarn = geometry.calculateDistance(
      ELFKUNGEN_WAIT.lat, ELFKUNGEN_WAIT.lon, jarn.lat, jarn.lon,
    );
    const dStrids = geometry.calculateDistance(
      ELFKUNGEN_WAIT.lat, ELFKUNGEN_WAIT.lon, strids.lat, strids.lon,
    );
    expect(dStrids).toBeLessThan(dJarn); // närmast-regeln pekar på Stridsbergsbron
  });
});
