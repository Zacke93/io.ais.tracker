'use strict';

/**
 * J12 (helkodsgranskning RUNDA 2, 2026-08-22, major) — STALE
 * `_targetRemovalGrace` ÖVERLEVER VARJE MÅLBYTE.
 *
 * MEKANISMEN. Posten `<mmsi>:<målbro>` bär STARTTIDEN för målbrons
 * 60-sekunders nådafrist. Den raderades bara på fem ställen (grace-utgången,
 * de två demote-vägarna, lyckad omvalidering och fartygsborttagningen). Alla
 * vägar som BYTER eller NOLLAR målbron lämnade den kvar och föräldralöste den:
 * `_applyTargetTransition`, `_confirmDirectionReversal` och
 * `_clearStaleTargetBeyond`.
 *
 * FELFALLET (reproducerat nedan genom den riktiga pipelinen): en kö vid bron
 * skapar posten, passagen föräldralöser den, och när samma bro blir mål igen
 * efter en U-sväng ger FÖRSTA valideringsmissen `TARGET_CHANGE → "none"` med
 * en frist på över tusen sekunder i stället för en ny 60 s-frist. Båten faller
 * ur brotexten ("Inga båtar") tills ACCELERATED hinner återtilldela — en
 * flappande brotextcykel per drabbad resa.
 *
 * INGEN TIDSGRÄNS ÄNDRAS av fixen; posten får bara samma livslängd som den
 * målbro den gäller.
 *
 * L5 (helkodsgranskning RUNDA 3, 2026-08-22) — FJÄRDE ANROPSSTÄLLET. J12:s
 * egen fixtext namngav FYRA ställen och implementerade tre. Det fjärde är
 * kö-zonsgrenen (TARGET_QUEUE_ZONE), som håller kvar målet men lät posten stå
 * kvar och åldras; systerstället är skyddszonsgrenen (PROTECTION_ZONE_SAVE),
 * som hoppade över hela grace-blocket. Steg (4) nedan LÅSTE tidigare att
 * posten LEVER genom kö-grenen — den assertionen är medvetet vänd, se
 * motiveringen på plats.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

// lib/constants.js BRIDGES
const KLAFF = { lat: 58.28409551543077, lon: 12.283929525245636 };

const logger = {
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

const liveServices = [];
let NOW = 0;
let nowSpy = null;

function makeVDS() {
  const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  svc.app = {
    gpsJumpGateService: null,
    passageLatchService: null,
    routeOrderValidator: null,
    debug: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
  };
  liveServices.push(svc);
  return svc;
}

const graceKeys = (svc) => [...(svc._targetRemovalGrace || new Map()).keys()];

/** Alla loggrader (log + debug) sedan senaste nollställning. */
function loggedLines() {
  return [...logger.log.mock.calls, ...logger.debug.mock.calls]
    .map((args) => String(args[0]));
}

beforeAll(() => {
  global.__TEST_MODE__ = true;
});

afterAll(() => {
  delete global.__TEST_MODE__;
});

beforeEach(() => {
  // Fristen mäts i väggklocka; testet måste kunna hoppa fram minuter utan att
  // väcka städtimrarna (de är riktiga setTimeout och rensas i afterEach).
  NOW = 1755000000000;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => NOW);
});

afterEach(() => {
  while (liveServices.length > 0) {
    const svc = liveServices.pop();
    try {
      svc.clearAllTimers();
    } catch (_) { /* tomt */ }
  }
  if (nowSpy) nowSpy.mockRestore();
  jest.clearAllMocks();
});

describe('J12: grace-posten släpps när målbron släpps', () => {
  test('KÖ → PASSAGE → U-SVÄNG → ÅTERTILLDELNING: första missen ger NY 60 s-frist', () => {
    const svc = makeVDS();
    const mmsi = '265944001';
    const step = (dLat, sog, cog, dt) => {
      NOW += dt;
      logger.log.mockClear();
      logger.debug.mockClear();
      svc.updateVessel(mmsi, {
        mmsi, lat: KLAFF.lat + dLat, lon: KLAFF.lon, sog, cog, name: 'J12-PROV', timestamp: NOW,
      });
      return svc.vessels.get(mmsi);
    };

    // (1) Norrgående ~557 m söder om Klaffbron ⇒ målbro Klaffbron.
    expect(step(-0.00500, 4.0, 30, 0).targetBridge).toBe('Klaffbron');
    // (2) Närmar sig — valideringen håller. Farten trappas ned i steg om
    //     högst 2,0 kn så manöverskyddet inte aktiveras och tar över grenen.
    step(-0.00440, 3.0, 30, 70000);
    // (3) KÖN: anflygningen stannar av (< 10 m per rad) ⇒ första
    //     valideringsmissen skapar fristen.
    step(-0.00435, 1.5, 30, 70000);
    expect(graceKeys(svc)).toEqual([`${mmsi}:Klaffbron`]);
    expect(loggedLines().some((l) => l.includes('Starting 60s grace period'))).toBe(true);

    // (4) Kö-zonsvakten håller kvar målet när fristen löpt ut.
    //     VÄND ASSERTION (L5, 2026-08-22): raden låste tidigare
    //     `toEqual([`${mmsi}:Klaffbron`])`, alltså att posten LEVER genom
    //     kö-grenen. Just det var felet: posten fortsatte åldras under hela
    //     köandet, så första missen EFTER att köundantaget upphörde tog målet i
    //     samma tick i stället för efter en ny 60 s-frist (fältfallet CARAT
    //     211452170, 1550 s förfluten frist ⇒ "Inga båtar" i 139 s). Kö-grenen
    //     RADERAR nu posten; målet hålls fortfarande kvar, vilket raden under
    //     kontrollerar via TARGET_QUEUE_ZONE-loggen.
    step(-0.00434, 1.0, 30, 70000);
    expect(loggedLines().some((l) => l.includes('TARGET_QUEUE_ZONE'))).toBe(true);
    expect(graceKeys(svc)).toEqual([]);
    expect(svc.vessels.get(mmsi).targetBridge).toBe('Klaffbron');

    // (4b) L5-KÄRNAN: nästa valideringsmiss startar en FÄRSK 60 s-frist i
    //      stället för att ta målet med en minuter gammal. Utan raderingen i
    //      kö-grenen loggades "TARGET_CHANGE → none | Grace period: 210s" här.
    const afterQueue = step(-0.00433, 1.2, 30, 70000);
    expect(afterQueue.targetBridge).toBe('Klaffbron');
    expect(loggedLines().some((l) => l.includes('"Klaffbron" → "none"'))).toBe(false);

    // (5) PASSAGEN (riktig detektering): Klaffbron → Stridsbergsbron.
    const afterPassage = step(+0.00090, 3.0, 30, 70000);
    expect(afterPassage.targetBridge).toBe('Stridsbergsbron');
    expect(afterPassage.passedBridges).toContain('Klaffbron');
    // KÄRNAN: den föräldralösa posten är släppt i samma andetag som målet.
    expect(graceKeys(svc)).toEqual([]);

    // (6) U-SVÄNGEN (riktig metod, samma anrop som korsningsbevis-reversalen).
    NOW += 15 * 60 * 1000;
    svc._confirmDirectionReversal(afterPassage, 'south', 'J12-prov U-sväng');
    expect(afterPassage.targetBridge).toBeNull();
    expect(afterPassage._routeDirection).toBe('south');

    // (7) ÅTERTILLDELNINGEN: söderut ~800 m norr om Klaffbron (UTANFÖR
    //     kö-zonen, så kö-zonsvakten inte kan dölja felet).
    const reassigned = step(+0.00720, 4.0, 200, 70000);
    expect(reassigned.targetBridge).toBe('Klaffbron');

    // (8) FÖRSTA MISSEN efter återtilldelningen. Med den stale posten kvar
    //     blev detta `TARGET_CHANGE → "none" | Grace period: 1180s`.
    const afterFirstMiss = step(+0.00728, 3.0, 200, 70000);
    const lines = loggedLines();
    expect(afterFirstMiss.targetBridge).toBe('Klaffbron');
    expect(lines.some((l) => l.includes('Starting 60s grace period'))).toBe(true);
    expect(lines.some((l) => l.includes('"Klaffbron" → "none"'))).toBe(false);

    // (9) ANDRA missen 70 s senare tar målet — fristen ska fungera som förut,
    //     bara räknad från rätt tidpunkt.
    const afterSecondMiss = step(+0.00733, 2.0, 200, 70000);
    expect(afterSecondMiss.targetBridge).toBeNull();
    expect(loggedLines().some((l) => /Grace period: 7\ds/.test(l))).toBe(true);
  });

  test('_confirmDirectionReversal släpper posten för målet den nollar', () => {
    const svc = makeVDS();
    svc._targetRemovalGrace = new Map([['265944002:Klaffbron', NOW - 3000 * 1000]]);
    const vessel = {
      mmsi: '265944002',
      lat: KLAFF.lat + 0.002,
      lon: KLAFF.lon,
      targetBridge: 'Klaffbron',
      _routeDirection: 'south',
      passedBridges: [],
    };
    svc._confirmDirectionReversal(vessel, 'north', 'J12-enhetsprov');
    expect(vessel.targetBridge).toBeNull();
    expect(graceKeys(svc)).toEqual([]);
  });

  test('_clearStaleTargetBeyond släpper posten för målet den nollar', () => {
    const svc = makeVDS();
    svc._targetRemovalGrace = new Map([['265944003:Klaffbron', NOW - 3000 * 1000]]);
    const vessel = {
      mmsi: '265944003',
      lat: KLAFF.lat + 0.002,
      lon: KLAFF.lon,
      targetBridge: 'Klaffbron',
      _routeDirection: 'north',
      passedBridges: ['Järnvägsbron'],
    };
    svc._clearStaleTargetBeyond(vessel, 'Järnvägsbron', 'north');
    expect(vessel.targetBridge).toBeNull();
    expect(graceKeys(svc)).toEqual([]);
  });

  test('_applyTargetTransition släpper posten för FÖREGÅENDE mål — även vid TARGET_END', () => {
    const svc = makeVDS();
    svc._targetRemovalGrace = new Map([
      ['265944004:Stridsbergsbron', NOW - 3000 * 1000],
      ['265944005:Klaffbron', NOW - 3000 * 1000], // annat fartyg — får inte röras
    ]);
    const vessel = {
      mmsi: '265944004',
      lat: KLAFF.lat + 0.012,
      lon: KLAFF.lon,
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'north',
      passedBridges: [],
      passedAt: {},
    };
    // nextTargetBridge = null ⇒ TARGET_END-grenen (slutmålet passerat).
    svc._applyTargetTransition(vessel, { ...vessel }, null);
    expect(graceKeys(svc)).toEqual(['265944005:Klaffbron']);
  });

  test('_clearTargetGrace är tolerant: saknad karta eller argument ⇒ no-op', () => {
    const svc = makeVDS();
    svc._targetRemovalGrace = null;
    expect(() => svc._clearTargetGrace('265944006', 'Klaffbron')).not.toThrow();
    svc._targetRemovalGrace = new Map([['265944006:Klaffbron', NOW]]);
    svc._clearTargetGrace(null, 'Klaffbron');
    svc._clearTargetGrace('265944006', null);
    expect(graceKeys(svc)).toEqual(['265944006:Klaffbron']);
    svc._clearTargetGrace('265944006', 'Klaffbron');
    expect(graceKeys(svc)).toEqual([]);
  });
});
