'use strict';

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { BRIDGES } = require('../lib/constants');

/**
 * F18: _calculateTargetBridge tvingade tidigare binärt 'south' när COG var
 * tvetydig (46-134°/226-314°), vilket gav fel målbro + fel _routeDirection i
 * bridge_text och notiser. Nu används tre-vägs _safeDetermineDirection: osäker
 * COG → ingen målbro (vi gissar inte). Säkert eftersom detta bara gäller
 * tilldelning till båtar UTAN målbro (ingen pågående resa strandas).
 *
 * Kompletterar Anomali 16 (som bara skippade vid osäker COG OCH sog<1.5).
 */
describe('F18: tre-vägs riktning vid målbro-tilldelning', () => {
  const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
  let svc;

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  });

  // Mittpunkt i kanalen, mellan Klaffbron och Stridsbergsbron
  const midCanal = { lat: 58.285, lon: 12.288 };

  test('RÖRLIG båt med tvärställd COG (90° öst, 5kn) → ingen gissad målbro', () => {
    const vessel = {
      mmsi: '1', ...midCanal, sog: 5, cog: 90,
    };
    // Tidigare: tvingades 'south' → Klaffbron. Nu: null (osäker riktning).
    expect(svc._calculateTargetBridge(vessel)).toBeNull();
  });

  test('tydligt norrgående (COG 10°) → får målbro', () => {
    const vessel = {
      mmsi: '2', ...midCanal, sog: 5, cog: 10,
    };
    const target = svc._calculateTargetBridge(vessel);
    expect(['Klaffbron', 'Stridsbergsbron']).toContain(target);
  });

  test('tydligt sydgående (COG 180°) → får målbro', () => {
    const vessel = {
      mmsi: '3', ...midCanal, sog: 5, cog: 180,
    };
    const target = svc._calculateTargetBridge(vessel);
    expect(['Klaffbron', 'Stridsbergsbron']).toContain(target);
  });

  test('väst-COG (270°) på rörlig båt → ingen gissad målbro', () => {
    const vessel = {
      mmsi: '4', ...midCanal, sog: 6, cog: 270,
    };
    expect(svc._calculateTargetBridge(vessel)).toBeNull();
  });
});
