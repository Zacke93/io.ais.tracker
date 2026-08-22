'use strict';

/**
 * L3 (helkodsgranskning RUNDA 3, 2026-08-22) — B5:s frysackumulator räknade på
 * den FRYSTA positionsklockan, så 10-minuterstaket för under-bro (Bug #5) var
 * DÖTT vid varje AIS-kadens långsammare än 2 minuter.
 *
 * MEKANISMEN FÖRE FIXEN (StatusService._isUnderBridge):
 *   • Färskhetsgrinden mäter positionens ålder mot lastConfirmedMs =
 *     max(timestamp, lastPositionUpdate) — F4-E-rättningen, RÄTT klockdomän.
 *   • Fyra rader ned byggde frysackumulatorn sitt värde ur ENBART
 *     vessel.lastPositionUpdate. Det fältet fryses BY DESIGN när förflyttningen
 *     understiger tröskeln (VesselDataService: "Position didn't change - keep
 *     old timestamp") — alltså exakt för en stillaliggare, som är hela B5:s
 *     målgrupp.
 *   • Följd: (lastPositionUpdate − _underBridgeSince) blev NEGATIV ⇒
 *     Math.max(0, …) = 0 ⇒ _underBridgeSince skrevs om till `now` vid VARJE
 *     frysning. Ackumulatorn kunde aldrig växa förbi en kadensperiod.
 *
 * NÅBARHETEN: UNDER_BRIDGE_FRESH_MS är 2 min. Class B under 2 kn sänder var
 * 3:e minut och ankrad klass A likaså, så färskhetsgrinden går över gränsen i
 * varje kadensglugg för just den fartygsklass B5 finns för. Timer-vägen
 * (app.js:_reevaluateVesselStatuses) kör _isUnderBridge mellan meddelandena
 * och är den som utlöser frysningen.
 *
 * FIXEN: ankra frysvärdet vid den gräns grinden själv ritar —
 * lastConfirmedMs + UNDER_BRIDGE_FRESH_MS. Allt medan positionen var färsk
 * räknas, allt därefter är gap. En BAR lastConfirmedMs räcker inte: basen
 * _underBridgeSince skrivs om vid VARJE stale-pass och vandrar framåt genom
 * gapet, så varje stamp före färskhetsgränsen kastar bort det fönster grinden
 * nyss godkände — en gång per AIS-glugg i stället för en gång per episod.
 * MÄTT (45 m från Klaffbron, 3-min-kadens, 30 s timerpass, 120 min sim):
 *   HEAD (lastPositionUpdate)          max 2,50 min ackumulerat, ALDRIG timeout
 *   bar lastConfirmedMs                1 min per 6 min väggtid, timeout 53 min
 *   lastConfirmedMs + FRESH  (VALD)    timeout 12,5 min
 *   now                                timeout 10,5 min, men krediterar hela
 *                                      gapet när ett stale-pass kommer sent och
 *                                      faller på det låsta B5/VALEN-testet
 * Samma klass av klockdomänfel är dokumenterad och rättad ordagrant i
 * VesselDataService (_lastNorthProgress.ts); den här raden var dess syskon.
 *
 * SVITEN LÅSER:
 *  1. HUVUDFALLET genom RIKTIG pipeline (ProximityService →
 *     analyzeVesselStatus, meddelandeväg + timerväg): stillaliggande sändare
 *     med 3-minuterskadens under bro ⇒ UNDER_BRIDGE_TIMEOUT fyrar en gång
 *     inom 13 min. Före fixen: NOLL timeouts på 120 min.
 *  2. Ackumulatorn mäts i grindens klockdomän (> 0 vid frysning, växande).
 *  3. RÖRLIG båt (lastPositionUpdate följer med) beter sig exakt som förut.
 *  4. GAP-SKYDDET består: tyst transponder (BÅDA klockorna frusna) fryser
 *     ackumuleringen — VALEN 2026-07-03, texten föll till "Inga båtar" mitt i
 *     en pågående transit när väggtiden fick räknas under gapet.
 */

const StatusService = require('../lib/services/StatusService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const ProximityService = require('../lib/services/ProximityService');
const { BRIDGES } = require('../lib/constants');

const REAL_DATE_NOW = Date.now;

const makeLogger = () => {
  const lines = [];
  const push = (...args) => {
    lines.push(args.map(String).join(' '));
  };
  return {
    lines,
    debug: jest.fn(push),
    log: jest.fn(push),
    error: jest.fn(push),
    warn: jest.fn(push),
  };
};

// Punkt `meters` rakt NORR om bron (nordgående båt som passerat bron).
const northOf = (bridge, meters) => ({
  lat: bridge.lat + meters / 111320,
  lon: bridge.lon,
});

describe('L3: frysackumulatorn räknar i färskhetsgrindens klockdomän', () => {
  let now;
  let logger;
  let statusService;
  let proximityService;

  beforeEach(() => {
    now = 1_700_000_000_000;
    Date.now = () => now;
    global.__TEST_MODE__ = true;
    logger = makeLogger();
    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(logger);
    statusService = new StatusService(
      bridgeRegistry, logger, systemCoordinator,
      { anchorPassageTimestamp: jest.fn() },
      { shouldBlockStatus: jest.fn().mockReturnValue(false) },
    );
    proximityService = new ProximityService(bridgeRegistry, logger);
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
    delete global.__TEST_MODE__;
  });

  /**
   * Förtöjd/ankrad SÄNDANDE båt 45 m norr om en redan passerad Klaffbron —
   * inom UNDER_BRIDGE_SET_DISTANCE (50 m). Målbron är nollad (TARGET_END efter
   * passagen), precis som i fält. Detta är B5:s designade force-clear-fall.
   */
  const makeStationaryUnderBridge = () => {
    const pos = northOf(BRIDGES.klaffbron, 45);
    return {
      mmsi: 265900903,
      name: 'STILLA MARIA',
      sog: 0,
      cog: 20,
      status: 'en-route',
      targetBridge: null,
      lat: pos.lat,
      lon: pos.lon,
      timestamp: now,
      // Positionsklockan är FRUSEN sedan båten stannade — VesselDataService
      // behåller den gamla stämpeln så länge positionen inte ändras.
      lastPositionUpdate: now,
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: now - 2 * 60 * 60 * 1000,
      passedBridges: ['Klaffbron'],
      _lastStatusChangeTime: now - 60_000,
    };
  };

  // Ett pass genom RIKTIG pipeline — identiskt med app.js båda vägar
  // (_processAISMessage rad 3432 och _reevaluateVesselStatuses rad 6226).
  const pass = (vessel) => {
    const prox = proximityService.analyzeVesselProximity(vessel);
    const result = statusService.analyzeVesselStatus(vessel, prox);
    vessel.status = result.status;
    return result;
  };

  const timeoutLines = () => logger.lines.filter((l) => l.includes('[UNDER_BRIDGE_TIMEOUT]'));

  test('stillaliggande sändare, 3-minuterskadens: UNDER_BRIDGE_TIMEOUT fyrar (dött tak före fixen)', () => {
    const vessel = makeStationaryUnderBridge();
    const start = now;
    // Positionen ändras ALDRIG ⇒ lastPositionUpdate fryses vid starten.
    const frozenPosClock = now;

    let latchedAt = null;
    let timeoutAt = null;
    const frysvarden = [];

    // 30 simulerade minuter i 30-sekunderssteg. Var 6:e steg (= 3 min) kommer
    // ett AIS-meddelande som avancerar timestamp (mottagningsklockan);
    // övriga steg är timer-omvärderingar utan ny data.
    for (let step = 1; step <= 60; step += 1) {
      now += 30_000;
      if (step % 6 === 0) {
        vessel.timestamp = now; // AIS-meddelande: samma position, ny mottagning
      }
      const r = pass(vessel);
      if (latchedAt === null && r.status === 'under-bridge') latchedAt = now;
      if (Number.isFinite(vessel._underBridgeFrozenAccMs)) {
        frysvarden.push(vessel._underBridgeFrozenAccMs);
      }
      if (timeoutAt === null && timeoutLines().length > 0) timeoutAt = now;
    }

    // Positionsklockan ska bevisligen ha frusit — annars provar testet fel sak.
    expect(vessel.lastPositionUpdate).toBe(frozenPosClock);
    expect(now - vessel.lastPositionUpdate).toBeGreaterThan(25 * 60 * 1000);

    // Kärnan: taket ska ha fyrat, och EN gång (S-3-spärren hindrar om-latch).
    expect(latchedAt).not.toBeNull();
    expect(timeoutAt).not.toBeNull();
    expect(timeoutLines()).toHaveLength(1);

    // Taket ligger på 10 min ACKUMULERAD tid. Vid 3-min-kadens ligger båten
    // per definition i "gap" en dryg halvminut av varje cykel (posAge 150 s
    // vid det enda stale-passet), så väggtiden blir något längre: uppmätt
    // 12,5 min efter latchningen. Undre gränsen skyddar mot att taket blir
    // FÖR ivrigt (då hade gap-skyddet brustit), övre mot att det åter dör.
    const elapsedMin = (timeoutAt - latchedAt) / 60000;
    expect(elapsedMin).toBeGreaterThanOrEqual(10);
    expect(elapsedMin).toBeLessThanOrEqual(13);

    // S-3-spärren ska ha satts på bron (den blir nåbar i drift först nu).
    expect(vessel._underBridgeTimeoutBlockedBridge).toBe('Klaffbron');
    expect(vessel._underBridgeLatched).toBe(false);

    // Frysackumulatorn ska ha mätt VERKLIG ackumulerad tid, inte noll.
    expect(frysvarden.length).toBeGreaterThan(0);
    expect(Math.max(...frysvarden)).toBeGreaterThan(60_000);
  });

  test('frysvärdet är takets egen storhet, inte den frusna positionsklockan', () => {
    const vessel = makeStationaryUnderBridge();

    // Bygg upp 6 minuters under-bro-tid med färska mottagningar (1 min kadens,
    // frusen positionsklocka) — ingen frysning hinner ske under 2-minuters-
    // gränsen, så ackumuleringen är ren väggtid.
    for (let i = 0; i < 6; i += 1) {
      now += 60_000;
      vessel.timestamp = now;
      pass(vessel);
    }
    expect(vessel._underBridgeLatched).toBe(true);
    const ackFore = now - vessel._underBridgeSince;
    expect(ackFore).toBeGreaterThanOrEqual(5 * 60 * 1000);

    // Låt kadensen glesna: 2,5 min utan meddelande ⇒ färskhetsgrinden slår till
    // och frysningen sker. Ackumulatorn ska bära de ~6 minuterna.
    now += 150_000;
    pass(vessel);
    expect(Number.isFinite(vessel._underBridgeFrozenAccMs)).toBe(true);
    // EXAKT RELATION: ankaret ligger på färskhetsgränsen, alltså den
    // ackumulerade tiden vid senaste meddelande PLUS de 120 s som grinden
    // räknar som färska. De 30 s därefter är gap och räknas inte. På HEAD
    // blev värdet 0 här, eftersom den frusna positionsklockan låg före basen.
    expect(vessel._underBridgeFrozenAccMs).toBe(ackFore + 120_000);
    expect(vessel._underBridgeFrozenAccMs).toBeGreaterThanOrEqual(5 * 60 * 1000);
    // Och basen ska hålla ackumuleringen stilla under gapet.
    expect(now - vessel._underBridgeSince).toBe(vessel._underBridgeFrozenAccMs);
  });

  test('rörlig båt: oförändrat beteende (positionsklockan följer med)', () => {
    const pos = northOf(BRIDGES.klaffbron, 45);
    const vessel = {
      ...makeStationaryUnderBridge(),
      mmsi: 265900904,
      name: 'RORLIGA RUT',
      sog: 0.4,
      lat: pos.lat,
      lon: pos.lon,
    };

    let latchedAt = null;
    let timeoutAt = null;
    // 60 s kadens, positionen kryper (så lastPositionUpdate uppdateras) men
    // båten stannar inom SET-zonen. Detta är exakt J9-testets kadens.
    for (let i = 1; i <= 20; i += 1) {
      now += 60_000;
      const p = northOf(BRIDGES.klaffbron, 45 + (i % 2 === 0 ? 0.4 : -0.4));
      vessel.lat = p.lat;
      vessel.lon = p.lon;
      vessel.timestamp = now;
      vessel.lastPositionUpdate = now;
      const r = pass(vessel);
      if (latchedAt === null && r.status === 'under-bridge') latchedAt = now;
      if (timeoutAt === null && timeoutLines().length > 0) timeoutAt = now;
    }

    expect(latchedAt).not.toBeNull();
    expect(timeoutAt).not.toBeNull();
    expect(timeoutLines()).toHaveLength(1);
    const elapsedMin = (timeoutAt - latchedAt) / 60000;
    // Ren väggtid: taket vid 10 min, upptäckt på nästa 60-sekunderspass.
    expect(elapsedMin).toBeGreaterThanOrEqual(10);
    expect(elapsedMin).toBeLessThanOrEqual(11);
    // Frysningen ska ALDRIG ha aktiverats för en färsk sändare.
    expect(vessel._underBridgeFrozenAccMs).toBeNull();
  });

  test('gap-skyddet består: tyst transponder fryser ackumuleringen (VALEN 2026-07-03)', () => {
    const vessel = {
      ...makeStationaryUnderBridge(),
      mmsi: 265900905,
      name: 'TYSTA VALEN',
      sog: 3.2,
    };

    // 4 minuters transit under bron med färska rapporter (båda klockorna).
    for (let i = 1; i <= 4; i += 1) {
      now += 60_000;
      const p = northOf(BRIDGES.klaffbron, 45 + i * 0.5);
      vessel.lat = p.lat;
      vessel.lon = p.lon;
      vessel.timestamp = now;
      vessel.lastPositionUpdate = now;
      pass(vessel);
    }
    expect(vessel._underBridgeLatched).toBe(true);
    const ackVidGapstart = now - vessel._underBridgeSince;
    const gapStart = now;

    // TYST TRANSPONDER i 20 minuter — ingen av klockorna avancerar. Enbart
    // timer-passen kör. Väggtiden passerar 10 min men ackumuleringen ska
    // stå still, annars force-clearas latchen mitt i en pågående transit.
    for (let i = 1; i <= 40; i += 1) {
      now += 30_000;
      pass(vessel);
    }

    expect(timeoutLines()).toHaveLength(0);
    expect(vessel._underBridgeLatched).toBe(true);
    // Ackumuleringen står still: frysvärdet ankrades på färskhetsgränsen
    // (120 s in i gapet) och är oförändrat 20 minuter senare. Utan frysningen
    // hade väggtiden passerat taket och force-clearat latchen mitt i transiten.
    expect(vessel._underBridgeFrozenAccMs).toBe(ackVidGapstart + 120_000);
    expect(now - vessel._underBridgeSince).toBe(vessel._underBridgeFrozenAccMs);
    expect(now - vessel._underBridgeSince).toBeLessThan(10 * 60 * 1000);
    // Väggtiden har däremot passerat taket med god marginal — det är precis
    // den skillnaden gap-skyddet finns för.
    expect(now - gapStart).toBeGreaterThan(10 * 60 * 1000);
  });
});
