'use strict';

/**
 * U41 (2026-11-16): en sändare som rapporterar en fart som ingen båt i kanalen
 * håller ska inte visas som båt.
 *
 * Fältfallet: 218023240 i korpus 20260713-41h, två positioner. 13:17:01 på
 * 33,2 kn, 4 m från Stallbackabrons brolinje med kursen längs broaxeln, och
 * 13:20:31 på 21,7 kn, 877 m från farleden. Båda punkterna ligger på en
 * stamväg (Stallbackabron respektive Edsborgsvägen). Appen visade sändaren
 * som en båt i brotexten i 18 minuter och skickade en notis för
 * Stallbackabron på den första positionen.
 *
 * Mätningen (banken + fältkörningarna k1 och k2, 30 719 positioner): den
 * snabbaste riktiga båten som korsar en bro rapporterar 10,6 kn. Över 12 kn
 * finns bara bilens två positioner, PRICKBJORNs enstaka spik (22,2 kn mitt i
 * ett spår) och ett enkelsampel på 13 kn mitt i farleden (211488728).
 * Gränsen är 15 kn och gäller bara en sändare som appen inte följer.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { IMPLAUSIBLE_NEW_VESSEL_SOG_KN } = require('../lib/constants');

function makeLogger() {
  return {
    log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
  };
}

// Fältfallets två positioner (corpora-data/ais-replay-20260713-221737.jsonl).
const BIL_1 = {
  lat: 58.30892333333334, lon: 12.318136666666668, sog: 33.2, cog: 142.5,
};
const BIL_2 = {
  lat: 58.29074333333333, lon: 12.309473333333333, sog: 21.7, cog: 204.8,
};

describe('U41: en ny sändare med orimlig fart visas inte som båt', () => {
  let svc;
  let logger;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-14T13:17:01.006Z'));
    logger = makeLogger();
    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = { gpsJumpGateService: null, passageLatchService: null, routeOrderValidator: null };
  });

  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
  });

  function send(mmsi, pos) {
    return svc.updateVessel(mmsi, {
      mmsi, name: 'Unknown', timestamp: Date.now(), fixTs: Date.now(), fixFeed: 'aisstream', ...pos,
    });
  }
  const implausibleLogs = (mmsi) => logger.debug.mock.calls
    .map((a) => String(a[0]))
    .filter((l) => l.includes(`[VESSEL_IMPLAUSIBLE_SPEED] ${mmsi}`));

  test('gränsen är 15 kn', () => {
    expect(IMPLAUSIBLE_NEW_VESSEL_SOG_KN).toBe(15);
  });

  test('fältfallet 218023240: ingen av de två positionerna skapar en båt', () => {
    expect(send('218023240', BIL_1)).toBeNull();
    expect(svc.vessels.has('218023240')).toBe(false);
    jest.advanceTimersByTime(210 * 1000);
    expect(send('218023240', BIL_2)).toBeNull();
    expect(svc.vessels.has('218023240')).toBe(false);
    expect(implausibleLogs('218023240')).toHaveLength(2);
  });

  test('motfall: en riktig båt vars första position är en spik visas från nästa position', () => {
    expect(send('265900411', {
      lat: 58.3000, lon: 12.3020, sog: 22.2, cog: 210,
    })).toBeNull();
    jest.advanceTimersByTime(60 * 1000);
    const v = send('265900411', {
      lat: 58.2995, lon: 12.3014, sog: 8.1, cog: 210,
    });
    expect(v).not.toBeNull();
    expect(svc.vessels.has('265900411')).toBe(true);
  });

  test('motfall (PRICKBJORN, k2 13/11 13:56): en följd båt med EN orimlig fart ligger kvar', () => {
    expect(send('265012090', {
      lat: 58.2990, lon: 12.3010, sog: 10.2, cog: 210,
    })).not.toBeNull();
    jest.advanceTimersByTime(70 * 1000);
    const v = send('265012090', {
      lat: 58.2965, lon: 12.2985, sog: 22.2, cog: 210,
    });
    expect(v).not.toBeNull();
    expect(svc.vessels.get('265012090').sog).toBe(22.2);
    expect(implausibleLogs('265012090')).toHaveLength(0);
  });

  test('motfall (211488728, 20260804-17h): 13 kn mitt i farleden skapar en båt som förut', () => {
    expect(send('211488728', {
      lat: 58.29799333333334, lon: 12.300393333333334, sog: 13, cog: 200.9,
    })).not.toBeNull();
  });

  test('gränsfallen: 14,9 kn och okänd fart skapar en båt, 15,0 kn gör det inte', () => {
    expect(send('265900412', {
      lat: 58.3000, lon: 12.3020, sog: 14.9, cog: 210,
    })).not.toBeNull();
    expect(send('265900413', {
      lat: 58.3000, lon: 12.3020, sog: null, cog: 210,
    })).not.toBeNull();
    expect(send('265900414', {
      lat: 58.3000, lon: 12.3020, sog: 15.0, cog: 210,
    })).toBeNull();
  });
});
