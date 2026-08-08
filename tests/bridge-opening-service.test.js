'use strict';

/**
 * BridgeOpeningService — kärnmotorn för bro-centrerade öppningsvarningar
 * (etapp 6, 2026-08-03).
 *
 * O4-fallen ur uppdraget körs mot den RIKTIGA servicen med fake timers och en
 * setInterval som speglar app.js 30 s-watchdog exakt (tick-doktrinen: ingen
 * setTimeout per båt, allt drivs av den periodiska loopen):
 *   - 700-metersfallet: sista fix 700 m/7 kn → total tystnad → varning i tid
 *   - tystnadsfallet 1600 m: deadline-motorn fyrar UTAN nya fix
 *   - U-sväng efter beväpning ⇒ avväpnad, ingen varning
 *   - väntande båt 250 m ut som stannar ⇒ varningen står/avfyras
 *   - kajvobblare (V1-bokförd) ⇒ beväpnas aldrig
 *   - omstart mitt i ⇒ inga krascher, boat_near tar över
 *
 * Utöver O4 låses kärnsemantiken: konvojen (EN varning), passage-invarianten
 * (ingen varning efter passage i samma händelse), klockdomänen (fixTs ankrar
 * fysiken), fartgivarlösa båtar, idempotent tick och svälj-fällan.
 *
 * Etapp 7 fas A (2026-08-08): payloadens MÄTINSTRUMENT — originalDueMs
 * (A8(iii), armens frysta ursprungsdeadline) och fixAgeMs (B2d, åldern på det
 * fix varningen vilar på). Båda är rent additiva och får aldrig röra en
 * beslutsväg; sviten låser både att de finns och att de INTE skrivs om.
 *
 * Etapp 7 fas B (2026-08-08): B2d-GRINDEN — ett fix äldre än STALE_ETA_HARD
 * får inte bära en ankomstsiffra (payloadens etaMinutes = null ⇒ tokenens
 * eta_minutes = -1, samma okänd-sentinel som boat_near; översättningen låses i
 * tests/bridge-opening-app-integration.test.js). Grinden rör ENDAST tokenen —
 * expectedArrivalMs, fireDueMs och konvojgrupperingen står still.
 */

global.__TEST_MODE__ = true;

const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
const geometry = require('../lib/utils/geometry');
const { BRIDGES, BRIDGE_OPENING, UI_CONSTANTS } = require('../lib/constants');

const T0 = 1_700_000_000_000;
const KLAFF = BRIDGES.klaffbron;
const STRIDS = BRIDGES.stridsbergsbron;
const STALLBACKA = BRIDGES.stallbackabron;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

/**
 * Position på `distanceM` meter från bron längs bäring `bearingDeg`.
 * Kanalen går NE–SV (~40°/220°), så 220° = söder om bron i farleden.
 */
function posAtDistance(bridge, distanceM, bearingDeg = 220) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceM * Math.cos(rad)) / 111320;
  const dLon = (distanceM * Math.sin(rad)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180));
  return { lat: bridge.lat + dLat, lon: bridge.lon + dLon };
}

/** Fartygsobjekt i samma form som VesselDataService._createVesselObject ger. */
function makeVessel(overrides = {}) {
  const bridge = overrides.bridge || KLAFF;
  const distanceM = overrides.distanceM ?? 1000;
  const bearing = overrides.bearing ?? 220;
  const pos = posAtDistance(bridge, distanceM, bearing);
  const now = Date.now();
  const vessel = {
    mmsi: overrides.mmsi || '265999001',
    name: overrides.name || 'TESTBÅT',
    lat: pos.lat,
    lon: pos.lon,
    sog: overrides.sog === undefined ? 5 : overrides.sog,
    cog: overrides.cog ?? 40,
    timestamp: overrides.timestamp ?? now,
    fixTs: overrides.fixTs ?? now,
    targetBridge: overrides.targetBridge === undefined ? bridge.name : overrides.targetBridge,
    _routeDirection: overrides._routeDirection === undefined ? 'north' : overrides._routeDirection,
    _finalTargetDirection: overrides._finalTargetDirection ?? null,
    _hasMovementProof: overrides._hasMovementProof === undefined ? true : overrides._hasMovementProof,
    _moored: overrides._moored === true,
    etaMinutes: overrides.etaMinutes ?? null,
    passedAt: overrides.passedAt || {},
    passedBridges: overrides.passedBridges || [],
  };
  return vessel;
}

describe('BridgeOpeningService', () => {
  let logger;
  let warnings;
  let svc;
  let tickTimer;

  const makeService = (opts = {}) => {
    const instance = new BridgeOpeningService({
      logger,
      onWarning: (payload) => warnings.push(payload),
      ...opts,
    });
    return instance;
  };

  /** Startar app.js-motsvarande 30 s-watchdog för den aktiva servicen. */
  const startTicker = (instance) => {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => instance.tick(), BRIDGE_OPENING.TICK_INTERVAL_MS);
  };

  const advance = (ms) => jest.advanceTimersByTime(ms);

  /**
   * Varningar för EN bro. Nödvändigt eftersom motorn beväpnar mot både
   * fartygets målbro OCH nästa målbro i färdriktningen när den ligger inom
   * horisonten (BRIDGE_OPENING.ARM_NEXT_TARGET): en båt 700 m söder om
   * Klaffbron är 1917 m från Stridsbergsbron och båda broarna kommer att
   * öppna för henne — två öppningar, två varningar.
   */
  const warnFor = (bridgeName) => warnings.filter((w) => w.bridge === bridgeName);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    logger = makeLogger();
    warnings = [];
    svc = makeService();
    startTicker(svc);
  });

  afterEach(() => {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (svc) svc.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // =========================================================================
  // O4-a: 700-METERSFALLET (designkravet)
  // =========================================================================
  describe('700-metersfallet — sista fix 700 m/7 kn, sedan total tystnad', () => {
    it('varnar innan tidigast möjliga ankomst utan ett enda fix till', () => {
      // Först sedd långt ut: beväpnas men ska INTE varna ännu.
      svc.observeVessel(makeVessel({ distanceM: 2200, sog: 7 }));
      expect(warnings).toHaveLength(0);
      expect(svc.getStats().armed).toBe(1);

      advance(120000); // 4 ticks — deadline från 2200 m ligger på +248 s
      expect(warnings).toHaveLength(0);

      // SISTA FIX: 700 m i 7 knop. Därefter total radiotystnad.
      const lastFixAt = Date.now();
      svc.observeVessel(makeVessel({ distanceM: 700, sog: 7 }));

      // Tidigast möjliga ankomst = 700 m / 10 kn = 136 s efter fixet.
      const earliestArrival = lastFixAt + (700 / (10 * 0.514444)) * 1000;
      expect(warnFor('Klaffbron')).toHaveLength(1);
      expect(warnFor('Klaffbron')[0].t).toBeLessThan(earliestArrival);
      expect(warnFor('Klaffbron')[0].vesselCount).toBe(1);
      expect(warnFor('Klaffbron')[0].direction).toBe('northbound');

      // Tystnaden fortsätter i en halvtimme: EN varning per bro, aldrig fler.
      advance(30 * 60 * 1000);
      expect(warnFor('Klaffbron')).toHaveLength(1);
    });

    it('deadline-motorn fyrar i ren tystnad när sista fixet låg utanför direktbandet', () => {
      const lastFixAt = Date.now();
      svc.observeVessel(makeVessel({ distanceM: 1600, sog: 7 }));
      expect(warnings).toHaveLength(0); // deadline ligger +131 s bort

      advance(120000); // 4 ticks — fortfarande före deadline
      expect(warnings).toHaveLength(0);

      advance(60000); // ticks vid +150 s och +180 s
      expect(warnings).toHaveLength(1);
      expect(warnings[0].firedBy).toBe('deadline');

      // Ledtid mot tidigast möjliga ankomst ska minst vara LEAD minus ETT tick
      // (rastreringen är hela avvikelsen — järnregel 2).
      const earliestArrival = lastFixAt + (1600 / (10 * 0.514444)) * 1000;
      expect(earliestArrival - warnings[0].t).toBeGreaterThanOrEqual(
        BRIDGE_OPENING.WARNING_LEAD_MS - BRIDGE_OPENING.TICK_INTERVAL_MS,
      );
    });

    it('fartgivarlös båt (sog=null) täcks av samma deadline — avståndet räcker', () => {
      svc.observeVessel(makeVessel({ distanceM: 1600, sog: null }));
      expect(warnings).toHaveLength(0);
      advance(180000);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].firedBy).toBe('deadline');
    });
  });

  // =========================================================================
  // O4-b: U-SVÄNG
  // =========================================================================
  describe('U-sväng efter beväpning', () => {
    it('avväpnar och varnar aldrig', () => {
      svc.observeVessel(makeVessel({ distanceM: 2200, sog: 5 }));
      expect(svc.getStats().armed).toBe(1);
      expect(warnings).toHaveLength(0);

      advance(60000);
      // Riktningsreversalen ägs av appen (_routeDirection) — vi läser den.
      svc.observeVessel(makeVessel({ distanceM: 2300, sog: 5, _routeDirection: 'south' }));
      expect(svc.getStats().armed).toBe(0);

      advance(20 * 60 * 1000);
      expect(warnings).toHaveLength(0);
    });

    it('U-sväng EFTER avfyrad varning ger ingen andra varning vid återkomst inom fönstret', () => {
      svc.observeVessel(makeVessel({ distanceM: 700, sog: 6 }));
      expect(warnings).toHaveLength(1);

      advance(60000);
      svc.observeVessel(makeVessel({ distanceM: 900, sog: 6, _routeDirection: 'south' }));
      expect(svc.getStats().armed).toBe(0);
      advance(60000);
      // Vänder tillbaka: ny arm, men den gamla händelsen lever kvar i sitt
      // konvojfönster och absorberar henne.
      svc.observeVessel(makeVessel({ distanceM: 700, sog: 6, _routeDirection: 'north' }));
      advance(60000);
      expect(warnings).toHaveLength(1);
    });
  });

  // =========================================================================
  // O4-c: VÄNTANDE BÅT NÄRA BRON
  // =========================================================================
  describe('väntande båt nära bron', () => {
    it('stopp 250 m ut avväpnar ALDRIG — varningen står kvar', () => {
      svc.observeVessel(makeVessel({ distanceM: 2200, sog: 5 }));
      expect(warnings).toHaveLength(0);

      advance(120000);
      svc.observeVessel(makeVessel({ distanceM: 250, sog: 0 }));
      expect(warnFor('Klaffbron')).toHaveLength(1);

      // Båten står stilla i 25 minuter och väntar på öppningen.
      for (let i = 0; i < 25; i++) {
        advance(60000);
        svc.observeVessel(makeVessel({ distanceM: 250, sog: 0 }));
      }
      expect(warnFor('Klaffbron')).toHaveLength(1);
      expect(svc.getStats().armedByBridge.Klaffbron).toBe(1); // fortfarande beväpnad
    });

    it('förtöjningsevidens INNANFÖR 600 m avväpnar inte (väntan är normalfallet)', () => {
      svc.observeVessel(makeVessel({ distanceM: 2200, sog: 5 }));
      advance(60000);
      svc.observeVessel(makeVessel({ distanceM: 400, sog: 0, _moored: true }));
      expect(svc.getStats().armedByBridge.Klaffbron).toBe(1);
    });

    it('förtöjningsevidens BORTOM 600 m avväpnar', () => {
      svc.observeVessel(makeVessel({ distanceM: 2200, sog: 5 }));
      expect(svc.getStats().armedByBridge.Klaffbron).toBe(1);
      advance(60000);
      svc.observeVessel(makeVessel({ distanceM: 2100, sog: 0, _moored: true }));
      expect(svc.getStats().armed).toBe(0);
      advance(20 * 60 * 1000);
      expect(warnings).toHaveLength(0);
    });
  });

  // =========================================================================
  // O4-d: KAJVOBBLARE
  // =========================================================================
  describe('kajvobblare (V1-kajbokföringen)', () => {
    it('beväpnas aldrig', () => {
      svc.destroy();
      svc = makeService({ isQuayWobbler: () => true });
      startTicker(svc);

      svc.observeVessel(makeVessel({ distanceM: 400, sog: 1.2 }));
      expect(svc.getStats().armed).toBe(0);
      advance(30 * 60 * 1000);
      expect(warnings).toHaveLength(0);
    });

    it('båt utan rörelsebevis beväpnas aldrig (kajliggarklassen)', () => {
      svc.observeVessel(makeVessel({ distanceM: 383, sog: 0, _hasMovementProof: false }));
      expect(svc.getStats().armed).toBe(0);
      advance(30 * 60 * 1000);
      expect(warnings).toHaveLength(0);
    });

    it('förtöjd båt beväpnas aldrig', () => {
      svc.observeVessel(makeVessel({ distanceM: 300, sog: 0, _moored: true }));
      expect(svc.getStats().armed).toBe(0);
    });
  });

  // =========================================================================
  // O4-e: OMSTART
  // =========================================================================
  describe('omstart mitt i en beväpnad anflygning', () => {
    it('kraschar inte och lämnar över till boat_near-lagret', () => {
      svc.observeVessel(makeVessel({ distanceM: 2200, sog: 5 }));
      expect(svc.getStats().armed).toBe(1);

      // Nedstängning mitt i (onUninit).
      svc.destroy();
      expect(svc.getStats().armed).toBe(0);
      expect(() => svc.tick()).not.toThrow();
      expect(() => svc.observeVessel(makeVessel({ distanceM: 300, sog: 5 }))).not.toThrow();
      expect(() => svc.notePassage('265999001', 'Klaffbron')).not.toThrow();
      expect(warnings).toHaveLength(0);

      // Ny process: inga armar överlever (dokumenterat v1-val).
      svc = makeService();
      startTicker(svc);
      expect(svc.getStats().armed).toBe(0);
      advance(10 * 60 * 1000);
      expect(warnings).toHaveLength(0);

      // Första färska fixet efter omstarten återbeväpnar och varnar normalt.
      svc.observeVessel(makeVessel({ distanceM: 700, sog: 6 }));
      expect(warnFor('Klaffbron')).toHaveLength(1);
    });

    it('tål trasiga indata utan att kasta', () => {
      expect(() => svc.observeVessel(null)).not.toThrow();
      expect(() => svc.observeVessel({})).not.toThrow();
      expect(() => svc.observeVessel({
        mmsi: '1', lat: NaN, lon: NaN, targetBridge: 'Klaffbron',
      })).not.toThrow();
      expect(() => svc.notePassage(null, null)).not.toThrow();
      expect(() => svc.removeVessel(null)).not.toThrow();
      expect(warnings).toHaveLength(0);
    });
  });

  // =========================================================================
  // BRO-CENTRERINGEN: EN varning per öppning
  // =========================================================================
  describe('bro-centrerade öppningshändelser', () => {
    it('en konvoj ger EN varning — den sändande båten täcker den tysta', () => {
      // Radiotyst granne beväpnas tidigt, sedan tystnar hon.
      svc.observeVessel(makeVessel({
        mmsi: '211648800', name: 'SALTYX', distanceM: 1800, sog: 6,
      }));
      expect(warnings).toHaveLength(0);

      // Sändande konvojkamrat kommer in och driver avfyrningen.
      svc.observeVessel(makeVessel({
        mmsi: '265576720', name: 'JUNO', distanceM: 900, sog: 5.6,
      }));

      expect(warnFor('Klaffbron')).toHaveLength(1);
      expect(warnFor('Klaffbron')[0].vesselCount).toBe(2);
      expect(warnFor('Klaffbron')[0].mmsis).toEqual(expect.arrayContaining(['211648800', '265576720']));
      expect(warnFor('Klaffbron')[0].leadVessel).toBe('JUNO'); // närmast bron

      advance(10 * 60 * 1000);
      expect(warnFor('Klaffbron')).toHaveLength(1);
    });

    it('två broar är två oberoende händelser', () => {
      svc.observeVessel(makeVessel({ distanceM: 700, sog: 6, bridge: KLAFF }));
      expect(warnings).toHaveLength(1);
      svc.observeVessel(makeVessel({
        mmsi: '265999002', distanceM: 700, sog: 6, bridge: STRIDS, targetBridge: STRIDS.name,
      }));
      expect(warnings).toHaveLength(2);
      expect(warnings.map((w) => w.bridge)).toEqual(['Klaffbron', 'Stridsbergsbron']);
    });

    it('målbrokedjan överlever tystnad — nästa målbro beväpnas från samma fix', () => {
      // 700 m söder om Klaffbron ⇒ 1917 m från Stridsbergsbron, båda inom
      // horisonten. Efter DETTA ENDA fix tystnar båten helt.
      svc.observeVessel(makeVessel({ distanceM: 700, sog: 6 }));
      expect(svc.getStats().armedByBridge).toEqual({ Klaffbron: 1, Stridsbergsbron: 1 });
      expect(warnFor('Klaffbron')).toHaveLength(1);

      advance(10 * 60 * 1000);
      // Stridsbergsbron varnas av deadline-motorn utan ett enda nytt fix —
      // utan kedjan hade den öppningen varit helt ovarnad (båten hinner aldrig
      // få ett fix med targetBridge = Stridsbergsbron).
      expect(warnFor('Stridsbergsbron')).toHaveLength(1);
      expect(warnFor('Stridsbergsbron')[0].firedBy).toBe('deadline');
    });

    it('kedjan pekar åt färdriktningen — sydgående kedjar Strids → Klaff', () => {
      svc.observeVessel(makeVessel({
        mmsi: '265999009',
        bridge: STRIDS,
        targetBridge: 'Stridsbergsbron',
        distanceM: 700,
        bearing: 40, // norr om Stridsbergsbron
        sog: 6,
        _routeDirection: 'south',
      }));
      expect(svc.getStats().armedByBridge).toEqual({ Klaffbron: 1, Stridsbergsbron: 1 });
    });

    it('kedjan slutar vid nordligaste målbron (Stallbackabron öppnar aldrig)', () => {
      svc.observeVessel(makeVessel({
        mmsi: '265999010',
        bridge: STRIDS,
        targetBridge: 'Stridsbergsbron',
        distanceM: 700,
        sog: 6,
        _routeDirection: 'north',
      }));
      expect(svc.getStats().armedByBridge).toEqual({ Klaffbron: 0, Stridsbergsbron: 1 });
    });

    it('Stallbackabron kan aldrig beväpnas — den öppnar aldrig', () => {
      svc.observeVessel(makeVessel({
        mmsi: '265999003',
        distanceM: 400,
        sog: 6,
        bridge: STALLBACKA,
        targetBridge: 'Stallbackabron',
      }));
      expect(svc.getStats().armed).toBe(0);
      advance(20 * 60 * 1000);
      expect(warnings).toHaveLength(0);
    });

    it('ingen varning efter registrerad målbropassage i samma händelse', () => {
      svc.observeVessel(makeVessel({
        mmsi: '111', name: 'A', distanceM: 2400, sog: 5,
      }));
      svc.observeVessel(makeVessel({
        mmsi: '222', name: 'B', distanceM: 2400, sog: 5,
      }));
      expect(warnings).toHaveLength(0);

      // A passerar innan någon deadline hunnit förfalla (konstruerat fall).
      svc.notePassage('111', 'Klaffbron');
      const passageAt = Date.now();

      advance(20 * 60 * 1000);
      for (const w of warnings) expect(w.t).toBeLessThan(passageAt);
    });

    it('en båt vars ankomst ligger långt bortom konvojfönstret får en EGEN varning', () => {
      svc.observeVessel(makeVessel({
        mmsi: '111', name: 'A', distanceM: 700, sog: 6,
      }));
      expect(warnFor('Klaffbron')).toHaveLength(1);

      // A passerar; händelsen går in i konvoj-cooldown (10 min).
      advance(120000);
      svc.notePassage('111', 'Klaffbron');

      // B dyker upp 2 min senare, 2400 m bort i 2 knop ⇒ förväntad ankomst
      // ~40 min bort. Det är en HELT ANNAN öppning, mitt i cooldownen.
      advance(120000);
      svc.observeVessel(makeVessel({
        mmsi: '222', name: 'B', distanceM: 2400, sog: 2,
      }));
      advance(20 * 60 * 1000);

      expect(warnFor('Klaffbron')).toHaveLength(2);
      expect(warnFor('Klaffbron')[1].leadVessel).toBe('B');
      expect(warnFor('Klaffbron')[1].vesselCount).toBe(1);
    });

    it('en båt som ansluter INOM konvojfönstret absorberas (ingen andra varning)', () => {
      svc.observeVessel(makeVessel({
        mmsi: '111', name: 'A', distanceM: 700, sog: 6,
      }));
      expect(warnFor('Klaffbron')).toHaveLength(1);

      advance(60000);
      // B ligger 900 m bort i 6 knop ⇒ förväntad ankomst inom minuter — samma
      // öppning som A.
      svc.observeVessel(makeVessel({
        mmsi: '222', name: 'B', distanceM: 900, sog: 6,
      }));
      advance(5 * 60 * 1000);
      expect(warnFor('Klaffbron')).toHaveLength(1);
    });
  });

  // =========================================================================
  // KLOCKDOMÄN OCH TOKENS
  // =========================================================================
  describe('klockdomän och tokens', () => {
    it('deadlinen ankras i FIXETS tid, inte i mottagningstiden', () => {
      // Hub-fix som levererades 150 s efter emissionen: båten kan redan ha
      // förflyttat sig 150 s och deadlinen måste flytta med.
      const now = Date.now();
      svc.observeVessel(makeVessel({
        distanceM: 1600, sog: 7, fixTs: now - 150000, timestamp: now,
      }));
      // Deadline = fixTs + 311 s − 180 s = now − 19 s ⇒ redan förfallen.
      expect(warnings).toHaveLength(1);
      expect(warnings[0].firedBy).toBe('fix');
    });

    it('framtida fixTs kan inte göra deadlinen optimistisk', () => {
      const now = Date.now();
      svc.observeVessel(makeVessel({
        distanceM: 1600, sog: 7, fixTs: now + 600000, timestamp: now,
      }));
      expect(warnings).toHaveLength(0); // ankaret klampas till now
      advance(180000);
      expect(warnings).toHaveLength(1);
    });

    it('eta_minutes speglar FÖRVÄNTAD ankomst från appens egen ETA', () => {
      svc.observeVessel(makeVessel({ distanceM: 700, sog: 6, etaMinutes: 4 }));
      expect(warnFor('Klaffbron')).toHaveLength(1);
      expect(warnFor('Klaffbron')[0].etaMinutes).toBe(4);
    });

    it('riktningstoken kan injiceras från app.js _getDirectionString', () => {
      svc.destroy();
      svc = makeService({ getDirection: () => 'southbound' });
      startTicker(svc);
      // BÄRING 40° = NORR om bron. En SYDGÅENDE båt söder om Klaffbron har
      // bron BAKOM sig, och beväpningen spärras då (geometriskt passagestopp).
      // Fixturen måste alltså vara geometriskt möjlig för att mäta tokenen.
      svc.observeVessel(makeVessel({
        distanceM: 700, bearing: 40, sog: 6, _routeDirection: 'south',
      }));
      expect(warnings[0].direction).toBe('southbound');
      expect(warnings[0].bridge).toBe('Klaffbron');
    });
  });

  // =========================================================================
  // TICK-KONTRAKTET
  // =========================================================================
  describe('tick-kontraktet', () => {
    it('är idempotent — upprepade anrop i samma millisekund ger EN varning', () => {
      svc.observeVessel(makeVessel({ distanceM: 1600, sog: 7 }));
      advance(180000);
      expect(warnings).toHaveLength(1);
      svc.tick();
      svc.tick();
      svc.tick();
      expect(warnings).toHaveLength(1);
    });

    it('tystnad och borttagning avväpnar aldrig — bara TTL:n släpper armen', () => {
      svc.observeVessel(makeVessel({ distanceM: 2400, sog: 5 }));
      svc.removeVessel('265999001', 'timeout'); // utan force = ingen effekt
      expect(svc.getStats().armed).toBe(1);

      // Armen hinner avfyra i tystnaden och lever sedan till TTL:n.
      advance(BRIDGE_OPENING.ARM_STALE_TTL_MS - 60000);
      expect(warnings).toHaveLength(1);
      expect(svc.getStats().armed).toBe(1);

      advance(120000);
      expect(svc.getStats().armed).toBe(0);
    });

    it('journey-reset (force) släpper armen explicit', () => {
      svc.observeVessel(makeVessel({ distanceM: 2400, sog: 5 }));
      expect(svc.getStats().armed).toBe(1);
      svc.removeVessel('265999001', 'journey-reset', true);
      expect(svc.getStats().armed).toBe(0);
    });

    it('en kastande onWarning-callback loggas som fel och dödar inte loopen', () => {
      svc.destroy();
      svc = makeService({
        onWarning: () => {
          throw new Error('flow-kortet saknas');
        },
      });
      startTicker(svc);

      expect(() => svc.observeVessel(makeVessel({ distanceM: 700, sog: 6 }))).not.toThrow();
      expect(logger.error).toHaveBeenCalled();
      const logged = logger.error.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('BRIDGE_OPENING');

      // Loopen lever vidare.
      expect(() => advance(10 * 60 * 1000)).not.toThrow();
    });

    it('MAX_ARMS-taket binder utan att kasta', () => {
      svc.destroy();
      svc = makeService({ config: { ...BRIDGE_OPENING, MAX_ARMS: 3 } });
      startTicker(svc);
      for (let i = 0; i < 10; i++) {
        svc.observeVessel(makeVessel({ mmsi: `9000${i}`, distanceM: 2400, sog: 5 }));
      }
      expect(svc.getStats().armed).toBeLessThanOrEqual(3);
    });
  });

  // =========================================================================
  // ETAPP 6-GRANSKNINGEN: de fällda hålen får varsin regressionsvakt
  // =========================================================================
  describe('granskningsfynden', () => {
    it('kedjearmen ärver ALDRIG målbrons ETA (fysikaliskt omöjlig token)', () => {
      // Båt 700 m söder om Klaffbron med appens ETA = 4 min. Kedjearmen mot
      // Stridsbergsbron ligger 1917 m bort — samma 4 minuter dit vore 15 knop.
      svc.observeVessel(makeVessel({ distanceM: 700, sog: 4, etaMinutes: 4 }));
      const klaffArm = svc._arms.get('265999001::Klaffbron');
      const stridsArm = svc._arms.get('265999001::Stridsbergsbron');
      expect(klaffArm.etaMinutes).toBe(4);
      expect(stridsArm.etaMinutes).toBeNull();
      // Kedjearmens prognos räknas på HENNES avstånd i HENNES fart.
      const impliedKn = (stridsArm.distanceM
        / ((stridsArm.expectedArrivalMs - stridsArm.anchorMs) / 1000)) / 0.514444;
      expect(impliedKn).toBeCloseTo(4, 1);
      // ...och den bortre armen får därför INTE samma deadline som den nära.
      expect(stridsArm.fireDueMs).toBeGreaterThan(klaffArm.fireDueMs);
    });

    it('en snabb båt kan inte varna bort en långsam (per-arm konvojkriterium)', () => {
      // SLOW 2400 m/3 kn (ankomst ~26 min) och FAST 800 m/6 kn (~4 min) är
      // TVÅ öppningar. Före fixen band FAST henne till sin varning och SLOWs
      // öppning blev aldrig varnad.
      svc.observeVessel(makeVessel({ mmsi: 'SLOW', distanceM: 2400, sog: 3 }));
      advance(120000);
      svc.observeVessel(makeVessel({ mmsi: 'FAST', distanceM: 800, sog: 6 }));
      advance(30 * 60 * 1000);
      const klaff = warnFor('Klaffbron');
      expect(klaff.length).toBeGreaterThanOrEqual(2);
      const covered = new Set(klaff.flatMap((w) => w.mmsis));
      expect(covered.has('SLOW')).toBe(true);
      expect(covered.has('FAST')).toBe(true);
      // Ingen varning får påstå att båda är samma öppning.
      expect(klaff.every((w) => w.mmsis.length === 1)).toBe(true);
    });

    it('konvojtäckningen är TIDSBEGRÄNSAD — en strandad båt får en egen varning', () => {
      // LEAD varnas och passerar; FOLLOWER absorberas men blir kvar långt
      // efter att den öppningen stängt. Mätt fall: ELFKUNGEN @ Klaffbron
      // 2026-07-14, absorberad 10:09 och passerade 10:32 — helt ovarnad.
      svc.observeVessel(makeVessel({ mmsi: 'LEAD', distanceM: 700, sog: 6 }));
      expect(warnFor('Klaffbron')).toHaveLength(1);
      svc.observeVessel(makeVessel({ mmsi: 'FOLLOWER', distanceM: 900, sog: 5 }));
      expect(svc._arms.get('FOLLOWER::Klaffbron').warnedAt).not.toBeNull();
      // Konvojfönstret + prognosen löper ut medan FOLLOWER ligger kvar.
      advance(2 * BRIDGE_OPENING.CONVOY_WINDOW_MS);
      const klaff = warnFor('Klaffbron');
      expect(klaff.length).toBeGreaterThanOrEqual(2);
      expect(klaff[klaff.length - 1].mmsis).toContain('FOLLOWER');
    });

    it('en bro BAKOM fartyget beväpnas aldrig (varning efter passage)', () => {
      // ELFKUNGEN-fallet: hon dyker upp 414 m NORR om Stridsbergsbron på
      // nordlig kurs efter att ha passerat under tystnaden. passedAt hinner
      // inte sättas förrän senare i samma meddelande — geometrin räcker.
      svc.observeVessel(makeVessel({
        bridge: STRIDS,
        distanceM: 414,
        bearing: 40, // norr om bron
        sog: 6.7,
        targetBridge: 'Stridsbergsbron',
        _routeDirection: 'north',
      }));
      expect(svc.getStats().armedByBridge.Stridsbergsbron).toBe(0);
      advance(20 * 60 * 1000);
      expect(warnFor('Stridsbergsbron')).toHaveLength(0);
    });

    it('en arm släpps när fartyget seglar bort UTAN målbro (fryst arm)', () => {
      svc.observeVessel(makeVessel({ distanceM: 2400, sog: 5 }));
      expect(svc.getStats().armed).toBe(1);
      for (let i = 1; i <= 4; i++) {
        advance(60000);
        svc.observeVessel(makeVessel({
          distanceM: 2400 + i * 400, sog: 5, targetBridge: null,
        }));
      }
      expect(svc.getStats().armed).toBe(0);
      advance(20 * 60 * 1000);
      expect(warnFor('Klaffbron')).toHaveLength(0);
    });

    it('U-svängen avväpnar även när riktningen låses FÖRST efter beväpningen', () => {
      svc.observeVessel(makeVessel({ distanceM: 1500, sog: 5, _routeDirection: null }));
      expect(svc.getStats().armed).toBe(1);
      expect(svc._arms.get('265999001::Klaffbron').armDirection).toBeNull();
      advance(60000);
      svc.observeVessel(makeVessel({ distanceM: 1600, sog: 5, _routeDirection: 'north' }));
      expect(svc._arms.get('265999001::Klaffbron').armDirection).toBe('north');
      advance(60000);
      svc.observeVessel(makeVessel({ distanceM: 1700, sog: 5, _routeDirection: 'south' }));
      expect(svc._arms.get('265999001::Klaffbron')).toBeUndefined();
    });

    it('ett orimligt gammalt fixankare klampas (skräpklocka)', () => {
      const stale = T0 - 60 * 60 * 1000; // en timme gammalt
      svc.observeVessel(makeVessel({ distanceM: 2400, sog: 6, fixTs: stale }));
      const arm = svc._arms.get('265999001::Klaffbron');
      expect(T0 - arm.anchorMs).toBe(BRIDGE_OPENING.MAX_FIX_ANCHOR_AGE_MS);
    });

    it('B1: platshållaren "Unknown" blir null, och namncachen används', () => {
      svc.observeVessel(makeVessel({ distanceM: 700, sog: 6, name: 'Unknown' }));
      expect(warnFor('Klaffbron')[0].leadVessel).toBeNull();

      svc.destroy();
      warnings = [];
      svc = makeService({ getVesselName: (mmsi) => (mmsi === '265999001' ? 'RONJA' : null) });
      startTicker(svc);
      svc.observeVessel(makeVessel({ distanceM: 700, sog: 6, name: 'Unknown' }));
      expect(warnFor('Klaffbron')[0].leadVessel).toBe('RONJA');
    });

    it('ett känt namn DEGRADERAS aldrig av ett senare namnlöst fix', () => {
      svc.observeVessel(makeVessel({ distanceM: 2400, sog: 5, name: 'AURANA' }));
      advance(60000);
      svc.observeVessel(makeVessel({ distanceM: 2300, sog: 5, name: 'Unknown' }));
      expect(svc._arms.get('265999001::Klaffbron').name).toBe('AURANA');
    });

    it('payloaden bär dueMs så avfyrningsfönstret kan mätas', () => {
      svc.observeVessel(makeVessel({ distanceM: 2200, sog: 7 }));
      advance(10 * 60 * 1000);
      const w = warnFor('Klaffbron')[0];
      expect(Number.isFinite(w.dueMs)).toBe(true);
      expect(w.t).toBeGreaterThanOrEqual(w.dueMs);
      expect(w.t - w.dueMs).toBeLessThanOrEqual(2 * BRIDGE_OPENING.TICK_INTERVAL_MS);
    });
  });

  // =========================================================================
  // MÄTINSTRUMENTEN I PAYLOADEN — etapp 7 fas A (A8(iii) + B2d)
  //
  // BÅDA är RENT ADDITIVA: de exponerar tal, de ändrar ingen beslutsväg.
  // originalDueMs = armens fireDueMs vid BEVÄPNINGEN, fryst en gång och
  // aldrig omskriven — referensen som gör H-4:s sista-påminnelse-mått
  // räknebart när dueMs binds om mot eligibleAt. fixAgeMs = åldern på det fix
  // varningen faktiskt vilar på (fältets Klaffbron#32: 854 s ⇒ 39 knop).
  // =========================================================================
  describe('mätinstrument i payloaden (A8(iii) originalDueMs + B2d fixAgeMs)', () => {
    it('(a) originalDueMs sätts vid beväpningen och ÄR armens första deadline', () => {
      svc.observeVessel(makeVessel({ distanceM: 2200, sog: 7 }));
      const arm = svc._arms.get('265999001::Klaffbron');

      expect(Number.isFinite(arm.originalDueMs)).toBe(true);
      expect(arm.originalDueMs).toBe(arm.fireDueMs);
      // Samma pessimistiska fysik som deadline-motorn: fixets ankare +
      // d / DEADLINE_MAX_SPEED_KN − WARNING_LEAD_MS (2200 m/10 kn ⇒ +248 s,
      // vilket ligger före snabbbåtsgrenens +311 s och alltså vinner min()).
      const deadline = arm.anchorMs
        + (arm.distanceM / (BRIDGE_OPENING.DEADLINE_MAX_SPEED_KN * 0.514444)) * 1000
        - BRIDGE_OPENING.WARNING_LEAD_MS;
      expect(arm.originalDueMs).toBeCloseTo(deadline, 0);
    });

    it('(b) originalDueMs skrivs ALDRIG om — nytt fix, absorption eller konvojsläpp', () => {
      svc.observeVessel(makeVessel({ mmsi: 'LEAD', distanceM: 700, sog: 6 }));
      expect(warnFor('Klaffbron')).toHaveLength(1);

      // FOLLOWER absorberas av LEADs redan avfyrade händelse: warnedAt sätts
      // och eligibleAt binds om — referensen ska stå still.
      svc.observeVessel(makeVessel({ mmsi: 'FOLLOWER', distanceM: 900, sog: 5 }));
      const follower = svc._arms.get('FOLLOWER::Klaffbron');
      const frozen = follower.originalDueMs;
      expect(Number.isFinite(frozen)).toBe(true);
      expect(follower.absorbedAt).not.toBeNull();
      expect(follower.originalDueMs).toBe(frozen);

      // Ett NYTT fix närmare bron flyttar fireDueMs — men inte referensen.
      advance(60000);
      svc.observeVessel(makeVessel({ mmsi: 'FOLLOWER', distanceM: 400, sog: 5 }));
      expect(follower.fireDueMs).not.toBe(frozen);
      expect(follower.originalDueMs).toBe(frozen);

      // Konvojtäckningen löper ut ⇒ armen släpps, får en EGEN händelse, ett
      // NYTT eligibleAt och en egen varning (_releaseStrandedArms).
      advance(2 * BRIDGE_OPENING.CONVOY_WINDOW_MS);
      const klaff = warnFor('Klaffbron');
      expect(klaff.length).toBeGreaterThanOrEqual(2);
      const own = klaff[klaff.length - 1];
      expect(own.mmsis).toContain('FOLLOWER');
      expect(svc._arms.get('FOLLOWER::Klaffbron').originalDueMs).toBe(frozen);
      expect(own.originalDueMs).toBe(frozen);
      // …och det är precis den skillnaden instrumentet finns för: dueMs är
      // ombunden till släpptidpunkten, ursprungsdeadlinen är det inte.
      expect(own.dueMs).toBeGreaterThan(own.originalDueMs);
    });

    it('(c) payloaden bär originalDueMs vid sidan av dueMs', () => {
      svc.observeVessel(makeVessel({ distanceM: 2200, sog: 7 }));
      const frozen = svc._arms.get('265999001::Klaffbron').originalDueMs;

      advance(10 * 60 * 1000);
      const w = warnFor('Klaffbron')[0];
      expect(w.originalDueMs).toBe(frozen);
      expect(w.firedBy).toBe('deadline');
      // EN händelse, ETT medlemskap, ingen ombindning ⇒ serierna sammanfaller
      // exakt. Varje framtida avvikelse är en ombindning, inte brus.
      expect(w.dueMs).toBe(w.originalDueMs);
    });

    it('(c) täckningsraderna bär armens originalDueMs (per fartyg)', () => {
      svc.destroy();
      warnings = [];
      const coverage = [];
      svc = makeService({ onCoverage: (info) => coverage.push(info) });
      startTicker(svc);

      svc.observeVessel(makeVessel({ mmsi: 'LEAD', distanceM: 700, sog: 6 }));
      svc.observeVessel(makeVessel({ mmsi: 'FOLLOWER', distanceM: 900, sog: 5 }));

      const rows = coverage.filter((c) => c.bridge === 'Klaffbron');
      const fired = rows.find((c) => c.reason === 'fired' && c.mmsi === 'LEAD');
      const absorbed = rows.find((c) => c.reason === 'absorbed' && c.mmsi === 'FOLLOWER');
      expect(fired).toBeDefined();
      expect(absorbed).toBeDefined();
      expect(Number.isFinite(fired.originalDueMs)).toBe(true);
      expect(fired.originalDueMs).toBe(svc._arms.get('LEAD::Klaffbron').originalDueMs);
      expect(absorbed.originalDueMs).toBe(svc._arms.get('FOLLOWER::Klaffbron').originalDueMs);
    });

    it('(d) fixAgeMs är 0 när ett färskt fix fyrar direkt', () => {
      svc.observeVessel(makeVessel({ distanceM: 700, sog: 6 }));
      const w = warnFor('Klaffbron')[0];
      expect(w).toBeDefined();
      expect(w.firedBy).toBe('fix');
      expect(w.fixAgeMs).toBe(0);
    });

    it('(d) fixAgeMs mäter fixets ålder VID AVFYRNINGEN, inte vid fixet', () => {
      const fixAt = Date.now();
      svc.observeVessel(makeVessel({ distanceM: 1600, sog: 7 }));
      expect(warnFor('Klaffbron')).toHaveLength(0);

      advance(180000); // deadline-motorn fyrar i tystnad vid +150 s
      const w = warnFor('Klaffbron')[0];
      expect(w.firedBy).toBe('deadline');
      expect(Number.isFinite(w.fixAgeMs)).toBe(true);
      expect(w.fixAgeMs).toBe(w.t - fixAt);
      expect(w.fixAgeMs).toBeGreaterThan(0);
    });

    it('(d) fixAgeMs rapporterar SANN ålder även när deadline-ankaret klampats', () => {
      // Fältfallet Klaffbron#32 (2026-08-07T13:46:58.924Z): kortet lovade "om
      // 1 minut" på d=1209 m byggt på ett 854 s gammalt fix — 39 knop.
      const now = Date.now();
      svc.observeVessel(makeVessel({
        distanceM: 1209, sog: 6, fixTs: now - 854000, timestamp: now,
      }));
      const w = warnFor('Klaffbron')[0];
      expect(w).toBeDefined();
      expect(w.fixAgeMs).toBe(854000);
      // …och varför anchorMs INTE duger som mätpunkt: den är klampad till
      // MAX_FIX_ANCHOR_AGE_MS (720 s) och hade underrapporterat med 134 s.
      const arm = svc._arms.get('265999001::Klaffbron');
      expect(now - arm.anchorMs).toBe(BRIDGE_OPENING.MAX_FIX_ANCHOR_AGE_MS);
      expect(w.fixAgeMs).toBeGreaterThan(BRIDGE_OPENING.MAX_FIX_ANCHOR_AGE_MS);
    });

    it('instrumenten är additiva — payloadens beslutsbärande fält är oförändrade', () => {
      svc.observeVessel(makeVessel({ distanceM: 700, sog: 6, etaMinutes: 4 }));
      const w = warnFor('Klaffbron')[0];
      expect(w.etaMinutes).toBe(4);
      expect(w.vesselCount).toBe(1);
      expect(w.direction).toBe('northbound');
      expect(w.firedBy).toBe('fix');
      expect(Number.isFinite(w.dueMs)).toBe(true);
      // Instrumenten ligger BREDVID kontraktet, aldrig i stället för det.
      expect(Object.prototype.hasOwnProperty.call(w, 'originalDueMs')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(w, 'fixAgeMs')).toBe(true);
    });
  });

  // =========================================================================
  // B2d — ETA-TOKENENS ÅLDERSGRIND (etapp 7 fas B, 2026-08-08)
  //
  // Fältprovet: Klaffbron#32 (2026-08-07T13:46:58.924Z) lovade "om 1 minut" på
  // d=1209 m byggt på ett 854 s gammalt fix — 39 knop. Grinden sätter tokenen
  // till okänd (payloadens etaMinutes = null ⇒ eta_minutes = -1) när fixet är
  // äldre än UI:ts BEFINTLIGA STALE_ETA_HARD, samma tröskel som brotexten
  // redan använder för att sluta lita på en ETA. Mätt över alla korpusar
  // träffar den 21 av 365 varningar, och ingen av dem hade en token inom
  // ±3 min av rådatafacit.
  //
  // AVGRÄNSNINGEN ÄR HELA POÄNGEN: avfyrningstiden och konvojgrupperingen
  // (expectedArrivalMs → fireDueMs/referenceArrivalMs) rörs INTE — en ändring
  // där flyttar öppningsfacit.
  // =========================================================================
  describe('B2d: ETA-tokenen tystnar när fixet är för gammalt', () => {
    const HARD = UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS;

    it('FÄLTFALLET Klaffbron#32: 854 s gammalt fix ⇒ okänd ETA i stället för "om 1 minut"', () => {
      const now = Date.now();
      svc.observeVessel(makeVessel({
        distanceM: 1209, sog: 6, fixTs: now - 854000, timestamp: now,
      }));

      const w = warnFor('Klaffbron')[0];
      expect(w).toBeDefined();
      // Varningen GÅR UT som förut — det är bara ankomstlöftet som tystnar.
      expect(w.etaMinutes).toBeNull();
      // …och skälet är avläsbart i samma payload (instrumentet bakom grinden).
      expect(w.fixAgeMs).toBe(854000);
      expect(w.fixAgeMs).toBeGreaterThan(HARD);
      // Svälj-fällan: en tyst token får aldrig komma ur en svald krasch.
      expect(logger.error).not.toHaveBeenCalled();
      // Loggraden skiljer "ingen prognos" från "prognos förkastad som gammal".
      const logged = logger.log.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('eta=okänd (fix 854 s > 600 s)');
    });

    it('FÄRSKT fix ⇒ tokenen är OFÖRÄNDRAD (appens egen ETA går rakt igenom)', () => {
      svc.observeVessel(makeVessel({ distanceM: 700, sog: 6, etaMinutes: 4 }));
      const w = warnFor('Klaffbron')[0];
      expect(w.etaMinutes).toBe(4);
      expect(w.fixAgeMs).toBe(0);
    });

    it('GRÄNSEN går exakt vid STALE_ETA_HARD — 600 000 ms behåller siffran', () => {
      const now = Date.now();
      svc.observeVessel(makeVessel({
        distanceM: 2400, sog: 5, fixTs: now - HARD, timestamp: now,
      }));

      const w = warnFor('Klaffbron')[0];
      expect(w).toBeDefined();
      expect(w.fixAgeMs).toBe(HARD);
      // Ankomstprognosen: ankaret (now − 600 s) + 2400 m / 5 kn = +933 s
      // ⇒ 333 s kvar vid avfyrningen ⇒ 6 min avrundat. Grinden är strikt "över
      // tröskeln", så exakt på gränsen står siffran kvar.
      expect(w.etaMinutes).toBe(6);
    });

    it('EN MILLISEKUND över gränsen ⇒ samma fixtur tappar siffran', () => {
      const now = Date.now();
      svc.observeVessel(makeVessel({
        distanceM: 2400, sog: 5, fixTs: now - (HARD + 1), timestamp: now,
      }));

      const w = warnFor('Klaffbron')[0];
      expect(w).toBeDefined();
      expect(w.fixAgeMs).toBe(HARD + 1);
      expect(w.etaMinutes).toBeNull();
    });

    it('grinden rör ENDAST tokenen — avfyrning, deadline och konvojreferens står still', () => {
      const now = Date.now();
      svc.observeVessel(makeVessel({
        distanceM: 1209, sog: 6, fixTs: now - 854000, timestamp: now,
      }));

      const w = warnFor('Klaffbron')[0];
      const arm = svc._arms.get('265999001::Klaffbron');
      // Fysiken är räknad ur det KLAMPADE ankaret precis som förut (klampningen
      // är _refreshArms, inte grindens): ankare + armens avstånd / 6 kn.
      const expectedArrival = arm.anchorMs + (arm.distanceM / (6 * 0.514444)) * 1000;
      expect(arm.expectedArrivalMs).toBeCloseTo(expectedArrival, 0);
      // Konvojgrupperingens referens = medlemmarnas tidigaste förväntade
      // ankomst. Den ÄR armens värde här, alltså oberörd av tokengrinden.
      const event = svc._events.get('Klaffbron').find((e) => e.id === w.eventId);
      expect(event.referenceArrivalMs).toBe(arm.expectedArrivalMs);
      // Avfyrningskontraktet: samma väg, samma tidpunkt, samma diagnostik.
      expect(w.firedBy).toBe('fix');
      expect(w.distanceM).toBe(Math.round(arm.distanceM));
      expect(w.vesselCount).toBe(1);
      expect(Number.isFinite(w.dueMs)).toBe(true);
      expect(w.t).toBeGreaterThanOrEqual(w.dueMs);
    });

    it('konvojsläppet: en arm som fyrar 20 min efter sitt sista fix får okänd ETA', () => {
      // Den vanligaste vägen till ett gammalt fix i fält är inte en gammal
      // leverans utan TYSTNAD: armen absorberas av konvojen, täckningen löper
      // ut och hon fyrar sin egen varning långt efter sitt sista livstecken.
      svc.observeVessel(makeVessel({ mmsi: 'LEAD', distanceM: 700, sog: 6 }));
      svc.observeVessel(makeVessel({ mmsi: 'FOLLOWER', distanceM: 900, sog: 5 }));
      expect(warnFor('Klaffbron')).toHaveLength(1);
      expect(warnFor('Klaffbron')[0].etaMinutes).not.toBeNull();

      advance(2 * BRIDGE_OPENING.CONVOY_WINDOW_MS); // 20 min utan ett enda fix
      const klaff = warnFor('Klaffbron');
      expect(klaff.length).toBeGreaterThanOrEqual(2);
      const own = klaff[klaff.length - 1];
      expect(own.mmsis).toContain('FOLLOWER');
      expect(own.fixAgeMs).toBeGreaterThan(HARD);
      expect(own.etaMinutes).toBeNull();
    });
  });

  // =========================================================================
  // GEOMETRIHJÄLPAREN (så testerna själva inte ljuger om avstånden)
  // =========================================================================
  describe('testgeometrin', () => {
    it('posAtDistance ger de avstånd testerna påstår', () => {
      for (const d of [250, 700, 1600, 2200, 2400]) {
        const p = posAtDistance(KLAFF, d);
        const actual = geometry.calculateDistance(p.lat, p.lon, KLAFF.lat, KLAFF.lon);
        expect(Math.abs(actual - d)).toBeLessThan(5);
      }
    });
  });
});
