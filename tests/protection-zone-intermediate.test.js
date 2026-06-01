'use strict';

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

/**
 * F21: skyddszonen (300m) höll kvar målbron nära ALLA broar, inkl. redan
 * passerade mellanbroar → en stillaliggande båt ankrad vid t.ex. Järnvägsbron
 * behöll sin målbro (Klaffbron/Stridsbergsbron) för evigt med fryst ETA.
 *
 * Fixen: PROTECTION_ZONE_SAVE gäller inte längre när skyddszons-bron är (a)
 * redan passerad OCH (b) inte själva målbron. Då frigörs target via grace-
 * rensningen. HMS ARCTURUS-skyddet (ankrad NÄRA MÅLBRON) är intakt.
 *
 * Detta test verifierar protection-bypass-villkoret direkt på vessel-state.
 */
describe('F21: skyddszon vid redan passerad mellanbro', () => {
  const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
  let svc;
  let bridgeRegistry;

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    bridgeRegistry = new BridgeRegistry();
    svc = new VesselDataService(logger, bridgeRegistry, new SystemCoordinator(logger));
  });

  const bridgePos = (name) => {
    const b = bridgeRegistry.getBridgeByName(name);
    return { lat: b.lat, lon: b.lon };
  };

  test('_isInProtectionZone rapporterar mellanbron när båt ligger där', () => {
    const jarn = bridgePos('Järnvägsbron');
    const vessel = {
      mmsi: '1', lat: jarn.lat, lon: jarn.lon, sog: 0.1, cog: 30,
    };
    const result = svc._isInProtectionZone(vessel);
    expect(result.isProtected).toBe(true);
    expect(result.bridge).toBe('Järnvägsbron');
  });

  test('ankrad vid PASSERAD mellanbro (≠ målbro) → bypass-villkoret uppfyllt', () => {
    const jarn = bridgePos('Järnvägsbron');
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
    // Replikera bypass-villkoret från updateVessel
    const protectionBridgePassed = pz.isProtected
      && vessel.passedBridges.includes(pz.bridge)
      && pz.bridge !== vessel.targetBridge;
    expect(protectionBridgePassed).toBe(true);
  });

  test('ankrad vid MÅLBRON → skyddet behålls (HMS ARCTURUS intakt)', () => {
    const strids = bridgePos('Stridsbergsbron');
    const vessel = {
      mmsi: '3',
      lat: strids.lat,
      lon: strids.lon,
      sog: 0.1,
      cog: 30,
      targetBridge: 'Stridsbergsbron',
      passedBridges: ['Järnvägsbron'],
    };
    const pz = svc._isInProtectionZone(vessel);
    const protectionBridgePassed = pz.isProtected
      && vessel.passedBridges.includes(pz.bridge)
      && pz.bridge !== vessel.targetBridge;
    // Skyddszons-bron ÄR målbron → bypass ska INTE ske
    expect(protectionBridgePassed).toBe(false);
  });

  test('ankrad vid EJ passerad mellanbro → skyddet behålls', () => {
    const jarn = bridgePos('Järnvägsbron');
    const vessel = {
      mmsi: '4',
      lat: jarn.lat,
      lon: jarn.lon,
      sog: 0.1,
      cog: 30,
      targetBridge: 'Stridsbergsbron',
      passedBridges: [], // har inte passerat Järnvägsbron ännu
    };
    const pz = svc._isInProtectionZone(vessel);
    const protectionBridgePassed = pz.isProtected
      && vessel.passedBridges.includes(pz.bridge)
      && pz.bridge !== vessel.targetBridge;
    expect(protectionBridgePassed).toBe(false);
  });
});
