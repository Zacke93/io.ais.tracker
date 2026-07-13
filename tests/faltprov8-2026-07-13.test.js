'use strict';

jest.mock('homey');

/**
 * Fältprov 8 (körningen 20260712-174434, ~25 h, 27 fartyg, 88 notiser) —
 * rad-för-rad-läst av 90 Opus 4.8 max-läsare (287 fynd: 0 critical, 1 major).
 * Körningen var projektets renaste: pelare 2 hade 0 missar/0 dubbletter och
 * pelare 1 inga fabricerade ETA:n. Denna svit låser fixarna:
 *
 *   FP8-1 (PILOT 761/CAPELLA, major): lotskajen ligger ~120–155 m från
 *     Kanalinfarten-TRIGGERPUNKTEN — kajstartare som lade ut SÖDERUT (bort
 *     från kanalen; appen loggade själv "lämnar kanalen, ingen målbro")
 *     fick boat_near på ren zonnärvaro. Fix i BÅDA vägarna: live-grenen
 *     (_getFlowTriggerCandidates) och svepet (_checkSkippedBridgesFallback)
 *     kräver kanalrelevans för sydgående vid triggerpunkter: transitbevis
 *     (passedBridges/målbro) eller bevisat fönster som börjar norr om
 *     punkten. SENTA-klassen (timeout-reborn transitör med raderad
 *     passedBridges men lastKnown norr om punkten) räddas av fönster-
 *     kriteriet; nordgående (förvarningens syfte) berörs aldrig.
 *   FP8-2 (219034975): COG-sydbandets topp snävad 314→270 i
 *     _getDirectionString-fallbacken — cog 314,7° (0,3° från nordbandet)
 *     gav token 'southbound' för en båt på väg IN mot kanalen. Empiri över
 *     tre körningar (136+ h): nordgående in vid infarten har cog 28–33°,
 *     sydgående 135–245°; ingen legitim kanalfärd i 271–314° (unknown är
 *     den ärliga tokenen). JOSEPHINE-fallet (226,7°) täcks fortfarande.
 *   FP8-3 (IDUN): reborn-hoppvektorn ÄR rörelsebevis — svepet notifierade
 *     på den, men målbrotilldelningen dömde samma båt som "never seen
 *     moving" + "Invalid COG (null)": IDUN stod 26 min i Järnvägsbro-kön
 *     (positionsbevisat genom Klaffbron, hopp 1 149 m) utan att räknas i
 *     bridge_text ("Fyra båtar" när fem väntade). Fix i två steg:
 *     (a) svepets rebornEvidence ≥500 m sätter _hasMovementProof —
 *     TRÖSKELN ÄR 500 m, INTE svepets 100 m: SOLUTION (19,5h-korpusen,
 *     facit-fälld första variant) hade 204 m hopp över 24 min (ankardrift)
 *     och fick FEL målbro i 2,7 min; (b) _calculateTargetBridge låter en
 *     LÅST ruttriktning ersätta SAKNAD COG (samma prioritetsprincip som
 *     F4-J: positionsbevisat lås slår opålitlig COG). Anomali 16-gaten
 *     (DAPHNE) är oförändrad för alla med giltig COG.
 *
 * Replay-verifierat: 11/11 korpusar EXAKTA; FP8-replayen 88→86 notiser
 * (−PILOT 761, −CAPELLA; 219034975 kvar med 'unknown'-token) och IDUN
 * räknas in från 08:21:48 ("Fem båtar på väg mot Stridsbergsbron" — alla
 * fem rådataverifierade Strids-passager; nedräkningen 5→4→3→2 följer dem).
 */

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

global.__TEST_MODE__ = true;

const TP_KANALINFARTEN_LAT = 58.26800304269953;

const makeApp = () => {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app.bridgeRegistry = new BridgeRegistry();
  app.vesselDataService = {
    isNearMooringZone: () => false,
    hasGpsJumpHold: () => false,
  };
  app._isNearLearnedMooringSpot = () => false;
  app._triggerBoatNearFlowFallback = jest.fn(async () => {});
  app._lastKnownPositions = new Map();
  app._LAST_KNOWN_POSITION_TTL_MS = 60 * 60 * 1000;
  app._skippedBridgesSweepSeen = new Map();
  return app;
};

// PILOT 761-geometrin: 128 m från Kanalinfarten-punkten, vid lotskajen
const atTriggerZone = (over) => ({
  mmsi: '265606970',
  lat: 58.26722666666667,
  lon: 12.267753333333333,
  sog: 4.6,
  cog: 139.7,
  timestamp: Date.now(),
  lastPositionUpdate: Date.now(),
  ...over,
});

describe('FP8-1a: live-grenens kanalrelevans-gate för trigger-punkter', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
  });

  const tpCandidates = (vessel) => app
    ._getFlowTriggerCandidates(vessel, { bridges: [] })
    .filter((c) => c.source === 'trigger-point');

  test('PILOT 761-fallet: sydgående kajstart i zonen utan kanalhistorik ⇒ ingen kandidat', () => {
    expect(tpCandidates(atTriggerZone())).toHaveLength(0);
  });

  test('nordgående i zonen (FRAM-klassen, cog 31°) ⇒ kandidat (förvarningens syfte)', () => {
    expect(tpCandidates(atTriggerZone({ cog: 31.4, sog: 4.7 }))).toHaveLength(1);
  });

  test('219034975-fallet: cog 314,7° ⇒ unknown-riktning ⇒ kandidaten behålls', () => {
    expect(tpCandidates(atTriggerZone({ cog: 314.7, sog: 1.8 }))).toHaveLength(1);
  });

  test('sydgående transitör med passedBridges ⇒ kandidat (MILES2GO-klassen)', () => {
    expect(tpCandidates(atTriggerZone({ passedBridges: ['Olidebron'] }))).toHaveLength(1);
  });

  test('sydgående med målbro ⇒ kandidat', () => {
    expect(tpCandidates(atTriggerZone({ targetBridge: 'Klaffbron' }))).toHaveLength(1);
  });

  test('sydgående kajstart NORR om punkten (LYS-klassen, firstSeen 58.273) ⇒ kandidat', () => {
    expect(tpCandidates(atTriggerZone({ _firstSeenLat: 58.273 }))).toHaveLength(1);
  });

  test('sydgående med låst ruttriktning söder + ingen historik ⇒ gated (låset ändrar inget)', () => {
    expect(tpCandidates(atTriggerZone({ _routeDirection: 'south' }))).toHaveLength(0);
  });
});

describe('FP8-1b: svepets kanalrelevans-gate för trigger-punkter', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
  });

  const sweepFor = async (mmsi, lastKnownLat, vesselOver) => {
    app._lastKnownPositions.set(String(mmsi), {
      lat: lastKnownLat, t: Date.now() - 60 * 1000, posT: Date.now() - 11 * 60 * 1000,
    });
    const vessel = atTriggerZone({ mmsi, ...vesselOver });
    await app._checkSkippedBridgesFallback(vessel, null);
    return app._triggerBoatNearFlowFallback.mock.calls.map((c) => c[1]);
  };

  test('CAPELLA-fallet: sydkorsning av punkten med fönster som börjar I zonen ⇒ ingen Kanalinfarten-fallback', async () => {
    // lastKnown 58.26801 (kajen, 8 m norr om punktlatituden) → 58.26651:
    // korsningen är positionsbevisad men fönstret börjar inte norr om
    // punkten + marginal ⇒ kanalirrelevant.
    const bridges = await sweepFor('265552060', 58.26801, { lat: 58.26651, cog: 186.9, sog: 4.4 });
    expect(bridges).not.toContain('Kanalinfarten');
  });

  test('SENTA-räddningen: timeout-reborn transitör med lastKnown norr om punkten ⇒ Kanalinfarten-fallback körs', async () => {
    // lastKnown 58.27329 (norr om Olidebron-närheten) → 58.26602: fönstret
    // börjar bevisat på kanalsidan ⇒ äkta utfart, notisen ska prövas.
    const bridges = await sweepFor('230198250', 58.27329, { lat: 58.26602, cog: null, sog: 0.1 });
    expect(bridges).toContain('Kanalinfarten');
  });

  test('riktiga broar gateas ALDRIG av kanalrelevans (Olidebron i samma SENTA-fönster)', async () => {
    const bridges = await sweepFor('230198250', 58.27329, { lat: 58.26602, cog: null, sog: 0.1 });
    expect(bridges).toContain('Olidebron');
  });
});

describe('FP8-2: COG-sydbandets topp 314→270 (_getDirectionString-fallbacken)', () => {
  let app;
  beforeEach(() => {
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
  });

  test('cog 314,7° (219034975 — 0,3° från nordbandet) ⇒ unknown, inte southbound', () => {
    expect(app._getDirectionString({ cog: 314.7, sog: 1.8 })).toBe('unknown');
  });

  test('VNV-bandet 271–314° ⇒ unknown (tvetydigt i kanalgeometrin)', () => {
    expect(app._getDirectionString({ cog: 271, sog: 5 })).toBe('unknown');
    expect(app._getDirectionString({ cog: 300, sog: 5 })).toBe('unknown');
  });

  test('bandgränsen 270° och SV-kurser förblir southbound (JOSEPHINE/MILES2GO-vakterna)', () => {
    expect(app._getDirectionString({ cog: 270, sog: 5 })).toBe('southbound');
    expect(app._getDirectionString({ cog: 245.6, sog: 2.1 })).toBe('southbound');
    expect(app._getDirectionString({ cog: 226.7, sog: 4.2 })).toBe('southbound');
    expect(app._getDirectionString({ cog: 135, sog: 5 })).toBe('southbound');
  });

  test('ruttlåset är fortsatt primärt — cog 314° med syd-lås ⇒ southbound', () => {
    expect(app._getDirectionString({ _routeDirection: 'south', cog: 314, sog: 5 })).toBe('southbound');
  });
});

describe('FP8-3a: reborn-hoppvektorn som rörelsebevis (500 m-tröskeln)', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
  });

  const rebornSweep = async (mmsi, lastKnownLat, vesselLat) => {
    app._lastKnownPositions.set(String(mmsi), {
      lat: lastKnownLat, t: Date.now() - 60 * 1000, posT: Date.now() - 24 * 60 * 1000,
    });
    const vessel = {
      mmsi,
      lat: vesselLat,
      lon: 12.290996666666667,
      sog: 0,
      cog: null,
      timestamp: Date.now(),
      lastPositionUpdate: Date.now(),
    };
    await app._checkSkippedBridgesFallback(vessel, null);
    return vessel;
  };

  test('IDUN-fallet: 1 149 m hopp ⇒ _hasMovementProof sätts', async () => {
    const vessel = await rebornSweep('265761140', 58.28022, 58.29054);
    expect(vessel._hasMovementProof).toBe(true);
    expect(vessel._movementProofPending).toBe(false);
  });

  test('SOLUTION-vakten (facit-fälld variant 1): 204 m hopp över 24 min ⇒ INGET bevis', async () => {
    const vessel = await rebornSweep('219033807', 58.28703, 58.28887);
    expect(vessel._hasMovementProof).not.toBe(true);
  });

  test('moored-churn-reborn på samma plats (0 m) ⇒ inget bevis, ingen riktningsinferens', async () => {
    const vessel = await rebornSweep('265012090', 58.26786, 58.26786);
    expect(vessel._hasMovementProof).not.toBe(true);
  });
});

describe('FP8-3b: låst ruttriktning ersätter saknad COG i målbrotilldelningen', () => {
  const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
  let svc;

  beforeEach(() => {
    svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  });

  // IDUN-geometrin: 137 m söder om Järnvägsbron, mellan Klaffbron och Stridsbergsbron
  const idun = (over) => ({
    mmsi: '265761140', lat: 58.290535, lon: 12.290996666666667, sog: 0, cog: null, ...over,
  });

  test('IDUN-fallet: cog=null + låst north ⇒ målbro tilldelas (Stridsbergsbron)', () => {
    expect(svc._calculateTargetBridge(idun({ _routeDirection: 'north' }))).toBe('Stridsbergsbron');
  });

  test('cog=null UTAN ruttlås ⇒ fortsatt hård spärr (null)', () => {
    expect(svc._calculateTargetBridge(idun())).toBeNull();
  });

  test('låst south från samma position ⇒ Klaffbron (riktningen styr valet)', () => {
    expect(svc._calculateTargetBridge(idun({ _routeDirection: 'south' }))).toBe('Klaffbron');
  });

  test('Anomali 16 (DAPHNE-vakten) intakt: giltig osäker COG + låg sog ⇒ null trots ruttlås', () => {
    expect(svc._calculateTargetBridge(idun({ cog: 73.2, sog: 0.6, _routeDirection: 'north' }))).toBeNull();
  });

  test('F4-J intakt: låst riktning slår motsägande COG under 2 kn', () => {
    const v = idun({ cog: 40.6, sog: 0.7, _routeDirection: 'south' });
    expect(svc._calculateTargetBridge(v)).toBe('Klaffbron');
  });
});
