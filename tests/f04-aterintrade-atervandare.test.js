'use strict';

/**
 * Nattjaktens F04 (värld 19721, 2026-11-16): återinträdesspärren åt upp en
 * båt som lämnade kanalen och vände tillbaka.
 *
 * KAJSA gick norrut i 9,5 kn genom Stallbackabron, vände ~420 m bortom bron
 * och kom tillbaka i 9–10 kn. Spärren (`VESSEL_REENTRY_BLOCK`, 10 min efter
 * avslutad resa) kastade varje position, och hon syntes först 232 m före
 * Stridsbergsbron: notisen, en sju minuter gammal notis för Stallbackabron och
 * öppningsvarningen kom på en gång, 51 s före korsningen.
 *
 * Regeln (`VesselDataService._releaseReturningVessel`): under spärren släpps
 * båten igenom när en obruten kedja av godkända positioner (utfartssidan av
 * sista bron, kurs mot brolinjen, minst 3 kn, rimligt steg mot farten) har
 * kommit minst 100 m närmare linjen, räknat från kedjans första position.
 * (Granskningen av N5 höjde talen från 2 kn och 50 m.)
 * Mätningen över banken och k1/k2: ingen av 191 spärrade positioner gick mot
 * sista bron i 2 kn eller mer, så regeln slår inte till där.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

function makeLogger() {
  return {
    log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
  };
}

// F04-världens positioner efter vändningen (repro.jsonl, värld 19721).
const NORR_UT = {
  lat: 58.31328726167153, lon: 12.319276419907794, sog: 2.8, cog: 15.2,
};
const VANDER = {
  lat: 58.313359598621325, lon: 12.319313937473229, sog: 1.4, cog: 195.2,
};
const RETUR_1 = {
  lat: 58.3130159901186, lon: 12.319135724892773, sog: 3.7, cog: 195.2,
};
const RETUR_2 = {
  lat: 58.31237171072125, lon: 12.31872524100432, sog: 6, cog: 199.9,
};
const RETUR_3 = {
  lat: 58.311428206900125, lon: 12.318073799931042, sog: 8.4, cog: 199.9,
};

describe('F04: återvändaren släpps igenom återinträdesspärren', () => {
  let svc;
  let logger;
  let resets;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-16T11:52:05.000Z'));
    logger = makeLogger();
    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = { gpsJumpGateService: null, passageLatchService: null, routeOrderValidator: null };
    resets = [];
    svc.on('vessel:journey-reset', (e) => resets.push(e));
  });

  afterEach(() => {
    svc.clearAllTimers();
    jest.useRealTimers();
  });

  function complete(mmsi, direction) {
    svc._completedJourneys.set(mmsi, { completedAt: Date.now(), direction });
  }
  function send(mmsi, pos, stepS = 30) {
    jest.advanceTimersByTime(stepS * 1000);
    return svc.updateVessel(mmsi, {
      mmsi, name: 'KAJSA', timestamp: Date.now(), fixTs: Date.now(), fixFeed: 'aisstream', ...pos,
    });
  }
  const tagged = (tag, mmsi) => [...logger.debug.mock.calls, ...logger.log.mock.calls]
    .map((a) => String(a[0]))
    .filter((l) => l.includes(`[${tag}] ${mmsi}`));

  test('F04: släpps när kedjan kommit 100 m närmare bron och får en ny resa', () => {
    const mmsi = '265255496';
    complete(mmsi, 'north');
    expect(send(mmsi, NORR_UT)).toBeNull();
    expect(send(mmsi, VANDER)).toBeNull(); // 1,4 kn: under 3 kn
    expect(send(mmsi, RETUR_1)).toBeNull(); // ankare
    expect(send(mmsi, RETUR_2)).toBeNull(); // 63 m närmare: inte 100 m än
    const v = send(mmsi, RETUR_3); // 158 m närmare än ankaret
    expect(v).not.toBeNull();
    expect(tagged('REENTRY_RETURN_RELEASE', mmsi)).toHaveLength(1);
    // Samma väg som när spärren löper ut: ny resa med förra resans riktning.
    expect(svc._completedJourneys.has(mmsi)).toBe(false);
    expect(resets).toHaveLength(1);
    expect(resets[0].prevJourneyDirection).toBe('north');
    expect(v.targetBridge).toBe('Stridsbergsbron');
  });

  test('motfall: en enda position mot bron släpper inte igenom', () => {
    const mmsi = '265900501';
    complete(mmsi, 'north');
    expect(send(mmsi, RETUR_1)).toBeNull();
    // Nästa position går ut igen: följden bryts, ankaret nollas.
    expect(send(mmsi, { ...RETUR_2, cog: 20 })).toBeNull();
    expect(send(mmsi, RETUR_2)).toBeNull(); // nytt ankare
    expect(send(mmsi, RETUR_3)).toBeNull(); // bara 95 m från det nya ankaret
    expect(tagged('REENTRY_RETURN_RELEASE', mmsi)).toHaveLength(0);
    expect(svc.vessels.has(mmsi)).toBe(false);
  });

  test('motfall: under 3 kn mot bron (drift, kajmanöver) släpper inte igenom', () => {
    const mmsi = '265900502';
    complete(mmsi, 'north');
    expect(send(mmsi, { ...RETUR_1, sog: 2.9 })).toBeNull();
    expect(send(mmsi, { ...RETUR_2, sog: 2.9 })).toBeNull();
    expect(send(mmsi, { ...RETUR_3, sog: 2.9 })).toBeNull();
    expect(svc.vessels.has(mmsi)).toBe(false);
  });

  test('motfall: en position under 3 kn mitt i kedjan nollar den', () => {
    const mmsi = '265900510';
    complete(mmsi, 'north');
    expect(send(mmsi, RETUR_1)).toBeNull();
    expect(send(mmsi, { ...RETUR_2, sog: 2.5 })).toBeNull(); // underkänd: kedjan nollas
    expect(send(mmsi, RETUR_3)).toBeNull(); // nytt ankare
    expect(svc.vessels.has(mmsi)).toBe(false);
  });

  test('motfall (granskningens J): ett brusigt positionspar hos en ankrad båt släpper inte', () => {
    const mmsi = '265900511';
    complete(mmsi, 'north');
    // Två positioner i rad med kurs mot bron, den andra 58 m närmare, i 3,2 kn.
    expect(send(mmsi, { ...RETUR_1, sog: 3.2 })).toBeNull();
    const dLat = (RETUR_2.lat - RETUR_1.lat) * (58 / 63);
    const dLon = (RETUR_2.lon - RETUR_1.lon) * (58 / 63);
    expect(send(mmsi, {
      lat: RETUR_1.lat + dLat, lon: RETUR_1.lon + dLon, sog: 3.2, cog: 199,
    })).toBeNull();
    expect(svc.vessels.has(mmsi)).toBe(false);
  });

  test('motfall: en position på kanalsidan av brolinjen ingår inte i kedjan', () => {
    const mmsi = '265900512';
    complete(mmsi, 'north');
    expect(send(mmsi, RETUR_1)).toBeNull(); // ankare 330 m bortom bron
    // 60 s senare 15 m in på kanalsidan av Stallbackabrons linje, kurs mot
    // söder i 8,4 kn: steget är rimligt och 315 m närmare linjen, men
    // positionen ligger inte på utfartssidan och underkänns (kedjan nollas).
    expect(send(mmsi, {
      lat: 58.309719, lon: 12.316546, sog: 8.4, cog: 200,
    }, 60)).toBeNull();
    expect(tagged('REENTRY_RETURN_RELEASE', mmsi)).toHaveLength(0);
    expect(svc.vessels.has(mmsi)).toBe(false);
  });

  test('motfall: en båt som fortsätter ut är spärrad hela tiden', () => {
    const mmsi = '265900503';
    complete(mmsi, 'north');
    for (let i = 0; i < 18; i++) {
      expect(send(mmsi, {
        lat: NORR_UT.lat + i * 0.0006, lon: NORR_UT.lon, sog: 8, cog: 15,
      })).toBeNull();
    }
    expect(tagged('VESSEL_REENTRY_BLOCK', mmsi)).toHaveLength(18);
  });

  test('motfall: ett GPS-hopp mot bron räknas inte som förflyttning', () => {
    const mmsi = '265900504';
    complete(mmsi, 'north');
    expect(send(mmsi, RETUR_1)).toBeNull();
    // 30 s senare 480 m närmare bron i rapporterade 4 kn: orimligt.
    expect(send(mmsi, {
      lat: 58.3099, lon: 12.3170, sog: 4, cog: 200,
    })).toBeNull();
    expect(svc.vessels.has(mmsi)).toBe(false);
  });

  test('tät AIS: små steg samlas mot ankaret tills båten kommit 100 m närmare', () => {
    const mmsi = '265900505';
    complete(mmsi, 'north');
    // 3,5 kn med 10 s mellan positionerna ≈ 18 m per position.
    const dLat = (RETUR_3.lat - RETUR_1.lat) / 12;
    const dLon = (RETUR_3.lon - RETUR_1.lon) / 12;
    const results = [];
    for (let i = 0; i <= 12; i++) {
      results.push(send(mmsi, {
        lat: RETUR_1.lat + i * dLat, lon: RETUR_1.lon + i * dLon, sog: 3.5, cog: 200,
      }, 10));
    }
    const firstReleased = results.findIndex((r) => r !== null);
    expect(firstReleased).toBeGreaterThan(4);
    expect(firstReleased).toBeLessThan(12);
    expect(results.slice(0, firstReleased).every((r) => r === null)).toBe(true);
  });

  test('söderut: en båt som vänt söder om Olidebron och går tillbaka norrut släpps', () => {
    const mmsi = '265900506';
    complete(mmsi, 'south');
    // Utfarten söderut går västsydväst; tillbaka är nordost (kurs 40°).
    expect(send(mmsi, {
      lat: 58.2644, lon: 12.2690, sog: 6, cog: 40,
    })).toBeNull();
    expect(send(mmsi, {
      lat: 58.2652, lon: 12.2700, sog: 6, cog: 40,
    }, 60)).not.toBeNull();
  });

  test('motfall söderut: kurs västsydväst (på väg ut) spärras', () => {
    const mmsi = '265900507';
    complete(mmsi, 'south');
    expect(send(mmsi, {
      lat: 58.2652, lon: 12.2700, sog: 6, cog: 250,
    })).toBeNull();
    expect(send(mmsi, {
      lat: 58.2648, lon: 12.2680, sog: 6, cog: 250,
    })).toBeNull();
  });

  test('motfall: okänd riktning på den avslutade resan släpper aldrig', () => {
    const mmsi = '265900508';
    complete(mmsi, null);
    expect(send(mmsi, RETUR_1)).toBeNull();
    expect(send(mmsi, RETUR_2)).toBeNull();
  });

  test('efter släppet gäller vanlig logik: en ny avslutad resa ger en ny spärr', () => {
    const mmsi = '265900509';
    complete(mmsi, 'north');
    send(mmsi, RETUR_1);
    send(mmsi, RETUR_2);
    expect(send(mmsi, RETUR_3)).not.toBeNull();
    expect(svc._completedJourneys.has(mmsi)).toBe(false);
    svc.removeVessel(mmsi, 'journey-completed');
    // Den nya posten bär inget släpp från förra gången: nästa position spärras
    // som vanligt om den inte själv visar en återvändare.
    const fresh = svc._completedJourneys.get(mmsi);
    expect(fresh).toBeDefined();
    expect(fresh.returnReleased).toBeUndefined();
    expect(send(mmsi, { ...NORR_UT, cog: 15, sog: 6 })).toBeNull();
    expect(tagged('VESSEL_REENTRY_BLOCK', mmsi).length).toBeGreaterThan(0);
  });
});
