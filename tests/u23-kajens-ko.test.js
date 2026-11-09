'use strict';

/**
 * Ägarbeslut U23 (2026-11-09): kajen norr om Klaffbron.
 *
 * En båt på väg mot Klaffbron som stannar vid "Kajen norr om Klaffbron"
 * behandlas som i resten av väntområdet. Hon står kvar tills hon kör vidare,
 * sänder navstatus 1 eller 5, eller har legat still i
 * MOORING_DETECTION.MAX_STATIONARY_WAIT_MS (2 h). D1 (2026-06-03,
 * docs/reliability-spec.md) vinner över kajzonens 15-minutersgissning.
 *
 * Testerna går genom den riktiga VesselDataService.updateVessel:
 *  - REGRESSION (fäller c14938f, där köaren klassades förtöjd efter 15 min);
 *  - KONTROLLEN av att 2 h-backstoppen gäller vid kajen: queueBridge ger null
 *    i en MOORING_ZONE, så undantaget för färsk broväntan når aldrig dit;
 *  - NEGATIVTESTER som ska klara både c14938f och U23: norrgående med målbron
 *    bortom 600 m, båt utan målbro, navstatus 5, 2 h-gränsen, Gästhamnen och
 *    kajliggaren utan rörelsebevis.
 * Ankomstspärren i app.js prövas i opening-queue-quay-stop.test.js och hela
 * kedjan (text och varningar) i runSyntheticScenarios ("kö-25min-i-Kajens-kapsel").
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const geometry = require('../lib/utils/geometry');
const { queueBridge } = require('../lib/utils/bridgeQueue');
const { MOORING_ZONES, MOORING_DETECTION, BRIDGES } = require('../lib/constants');

const KAJEN = MOORING_ZONES.find((z) => z.name === 'Kajen norr om Klaffbron');
const GASTHAMNEN = MOORING_ZONES.find((z) => z.name === 'Gästhamnen norr om Klaffbron');
// Kapsellinjens mittpunkt, 240 m norr om Klaffbron (samma punkt som
// gasthamnskapseln.test.js och m1-ihallande-stillhetsankare.test.js).
const KAJ_MITT = { lat: 58.286060, lon: 12.285651 };
// Gästhamnens stillhetskluster (fältdygnen 2026-08-04/05).
const GAST_MITT = { lat: 58.28740, lon: 12.285705 };
// Väntposition i farleden norr om Klaffbron, utanför kajkapseln.
const FARLED = { lat: 58.28590, lon: 12.28660 };

const MIN = 60 * 1000;

describe('U23: köare i Kajens kapsel', () => {
  let svc;
  let mockNow;
  const realDateNow = Date.now;
  const logger = {
    debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.__TEST_MODE__ = true;
    mockNow = new Date(2026, 10, 9, 10, 0, 0).getTime();
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

  const tick = (ms) => {
    mockNow += ms;
  };
  const send = (mmsi, pos, sog, extra = {}) => svc.updateVessel(mmsi, {
    lat: pos.lat, lon: pos.lon, sog, cog: 195, name: 'KOARE', ...extra,
  });
  const mooredLines = (mmsi) => logger.log.mock.calls.map((c) => String(c[0]))
    .filter((s) => s.includes('[MOORED]') && s.includes(mmsi));

  // Anflygning söderut in i kapseln (gasthamnskapseln.test.js:s kajköare):
  // ger målbro Klaffbron och rörelsebevis, de två villkor köundantaget kräver.
  function sailIntoKajen(mmsi) {
    const path = [
      { lat: 58.28760, lon: 12.28600, sog: 3.4 },
      { lat: 58.28700, lon: 12.28585, sog: 3.6 },
      { lat: 58.28650, lon: 12.28572, sog: 3.2 },
      { lat: KAJ_MITT.lat, lon: KAJ_MITT.lon, sog: 2.4 },
    ];
    let vessel;
    for (const p of path) {
      vessel = send(mmsi, p, p.sog);
      tick(MIN);
    }
    return vessel;
  }

  // Ligger still vid `pos` i `minutes` minuter med en fix per `cadenceMs`.
  // Returnerar sista fartygsobjektet och tiden (ms från första stillafixen)
  // då hon först klassades förtöjd, eller null.
  function lieStill(mmsi, pos, minutes, cadenceMs = MIN, extra = {}) {
    const t0 = mockNow;
    let vessel;
    let mooredAtMs = null;
    while (mockNow - t0 <= minutes * MIN) {
      vessel = send(mmsi, pos, 0.0, extra);
      if (vessel._moored && mooredAtMs === null) mooredAtMs = mockNow - t0;
      tick(cadenceMs);
    }
    return { vessel, mooredAtMs };
  }

  test('förutsättningar: kajmitten ligger i Kajens kapsel, inom väntzonen', () => {
    const d = geometry.distancePointToSegmentM(
      KAJ_MITT.lat, KAJ_MITT.lon, KAJEN.start.lat, KAJEN.start.lon, KAJEN.end.lat, KAJEN.end.lon,
    );
    expect(d).toBeLessThanOrEqual(KAJEN.radiusM);
    const dKlaff = geometry.calculateDistance(
      KAJ_MITT.lat, KAJ_MITT.lon, BRIDGES.klaffbron.lat, BRIDGES.klaffbron.lon,
    );
    expect(dKlaff).toBeLessThan(300);
  });

  describe('regression (fäller c14938f)', () => {
    test('köaren står kvar i 60 min: målbro Klaffbron, inte förtöjd, hållen som köare', () => {
      const vessel = sailIntoKajen('265923001');
      expect(vessel.targetBridge).toBe('Klaffbron');
      expect(vessel._hasMovementProof).toBe(true);
      const { vessel: efter, mooredAtMs } = lieStill('265923001', KAJ_MITT, 60);
      expect(mooredAtMs).toBeNull();
      expect(efter._moored).toBe(false);
      expect(efter.targetBridge).toBe('Klaffbron');
      expect(svc.holdsQuayQueue(efter, 'Klaffbron')).toBe(true);
      // Kortets bro avgör: mot en annan bro är hon ingen köare.
      expect(svc.holdsQuayQueue(efter, 'Stridsbergsbron')).toBe(false);
      expect(mooredLines('265923001')).toEqual([]);
    });

    test('först 2 h-backstoppen klassar henne — inte zonlagret', () => {
      sailIntoKajen('265923002');
      const { vessel, mooredAtMs } = lieStill('265923002', KAJ_MITT, 125);
      // Ingen klassning före gränsen, och direkt efter den (inom en kadens).
      expect(mooredAtMs).toBeGreaterThan(MOORING_DETECTION.MAX_STATIONARY_WAIT_MS);
      expect(mooredAtMs).toBeLessThanOrEqual(MOORING_DETECTION.MAX_STATIONARY_WAIT_MS + 2 * MIN);
      expect(vessel._moored).toBe(true);
      expect(vessel.targetBridge).toBeNull(); // demoterad, inte borttagen
      expect(svc.getVessel('265923002')).toBeTruthy();
      const rader = mooredLines('265923002');
      expect(rader).toHaveLength(1);
      expect(rader[0]).toContain('backstop');
      expect(svc.holdsQuayQueue(vessel, 'Klaffbron')).toBe(false);
    });
  });

  describe('kontroll: 2 h-gränsen gäller vid Kajen', () => {
    test('queueBridge ger null i kajkapseln trots bekräftad anflygning — men inte i farleden', () => {
      // Samma båt, samma bevis: bara platsen skiljer. Undantaget för färsk
      // broväntan (_hasFreshBridgeQueueEvidence, användarvalet 2026-09-06)
      // bygger på queueBridge och kan därför aldrig nå en båt vid Kajen.
      const now = Date.now();
      const base = {
        mmsi: '265923003',
        targetBridge: 'Klaffbron',
        _routeDirection: 'south',
        _hasMovementProof: true,
        _moored: false,
        passedBridges: ['Stridsbergsbron', 'Järnvägsbron'],
        timestamp: now,
        lastPositionUpdate: now,
        _bridgeQueueApproaches: {
          Klaffbron: {
            bridge: 'Klaffbron', direction: 'south', confirmedAt: now - 10 * MIN,
          },
        },
      };
      const vidKajen = { ...base, ...KAJ_MITT };
      const iFarleden = { ...base, ...FARLED };
      expect(queueBridge(vidKajen)).toBeNull();
      expect(svc._hasFreshBridgeQueueEvidence(vidKajen)).toBe(false);
      expect(queueBridge(iFarleden)?.name).toBe('Klaffbron');
      expect(svc._hasFreshBridgeQueueEvidence(iFarleden)).toBe(true);
    });
  });

  describe('negativtester (ska klara både c14938f och U23)', () => {
    test('2 h-gränsen: köaren vid Kajen är förtöjd och demoterad efter 2 h', () => {
      sailIntoKajen('265923010');
      const { vessel } = lieStill('265923010', KAJ_MITT, 125, 5 * MIN);
      expect(vessel._moored).toBe(true);
      expect(vessel.targetBridge).toBeNull();
    });

    test('norrgående med målbro Stridsbergsbron bortom 600 m demoteras efter 3 min', () => {
      // ELFKUNGEN/SUSANNE-klassen: norrut förbi Klaffbron, stopp vid Kajen.
      let vessel = svc.updateVessel('265923011', {
        lat: KAJ_MITT.lat, lon: KAJ_MITT.lon, sog: 5.5, cog: 25, name: 'NORRUT',
      });
      expect(vessel.targetBridge).toBe('Stridsbergsbron');
      const dStrids = geometry.calculateDistance(
        KAJ_MITT.lat, KAJ_MITT.lon, BRIDGES.stridsbergsbron.lat, BRIDGES.stridsbergsbron.lon,
      );
      expect(dStrids).toBeGreaterThan(600);
      tick(MIN);
      const { vessel: efter, mooredAtMs } = lieStill('265923011', KAJ_MITT, 6, 30 * 1000, { cog: 25 });
      vessel = efter;
      expect(mooredAtMs).toBeGreaterThanOrEqual(3 * MIN);
      expect(mooredAtMs).toBeLessThanOrEqual(3.5 * MIN);
      expect(vessel._moored).toBe(true);
      expect(vessel.targetBridge).toBeNull();
      expect(mooredLines('265923011')[0]).toContain('zon "Kajen norr om Klaffbron"');
    });

    test('båt utan målbro (osäker kurs, men rörelsebevis) klassas efter 3 min', () => {
      let vessel = svc.updateVessel('265923012', {
        lat: KAJ_MITT.lat, lon: KAJ_MITT.lon, sog: 0.8, cog: 120, name: 'TVARS',
      });
      expect(vessel._hasMovementProof).toBe(true);
      expect(vessel.targetBridge).toBeNull();
      tick(MIN);
      const { vessel: efter, mooredAtMs } = lieStill('265923012', KAJ_MITT, 6, 30 * 1000, { cog: 120 });
      vessel = efter;
      expect(mooredAtMs).toBeGreaterThanOrEqual(3 * MIN);
      expect(mooredAtMs).toBeLessThanOrEqual(3.5 * MIN);
      expect(vessel._moored).toBe(true);
      expect(vessel.targetBridge).toBeNull();
    });

    test('navstatus 5 vid Kajen klassar köaren direkt och demoterar henne', () => {
      sailIntoKajen('265923013');
      const vessel = send('265923013', KAJ_MITT, 0.0, { navStatus: 5 });
      expect(vessel._moored).toBe(true);
      expect(vessel.targetBridge).toBeNull();
      expect(mooredLines('265923013')[0]).toContain('navstatus=5');
    });

    test('Gästhamnen: köare mot Klaffbron klassas efter 3 min (inget köundantag)', () => {
      expect(GASTHAMNEN.queueGraceMs || 0).toBe(0);
      const anflygning = [
        { lat: 58.28810, lon: 12.28578, sog: 3.4 },
        { lat: 58.28786, lon: 12.28572, sog: 3.0 },
        { lat: 58.28760, lon: 12.28571, sog: 2.6 },
      ];
      let vessel;
      for (const p of anflygning) {
        vessel = send('265923014', p, p.sog);
        tick(MIN);
      }
      expect(vessel.targetBridge).toBe('Klaffbron');
      expect(vessel._hasMovementProof).toBe(true);
      const { vessel: efter, mooredAtMs } = lieStill('265923014', GAST_MITT, 6, 30 * 1000);
      expect(mooredAtMs).toBeGreaterThanOrEqual(3 * MIN);
      expect(mooredAtMs).toBeLessThanOrEqual(3.5 * MIN);
      expect(efter._moored).toBe(true);
      expect(efter.targetBridge).toBeNull();
    });

    test('kajliggare utan rörelsebevis: aldrig målbro, förtöjd efter 3 min', () => {
      const { vessel, mooredAtMs } = lieStill('265923015', KAJ_MITT, 9, 3 * MIN, { cog: 205 });
      expect(vessel._hasMovementProof).toBe(false);
      expect(vessel.targetBridge).toBeNull();
      expect(mooredAtMs).toBe(3 * MIN);
      expect(vessel._moored).toBe(true);
    });
  });
});
