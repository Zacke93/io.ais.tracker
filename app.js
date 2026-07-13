'use strict';

const fs = require('fs');
const path = require('path');
const Homey = require('homey');

// =============================================================================
// SERVICE IMPORTS
// =============================================================================
// Dessa services utgör appens kärna och hanterar olika aspekter av systemet:

// MODELS: Hanterar bro-konfiguration och data
const BridgeRegistry = require('./lib/models/BridgeRegistry');

// DATA SERVICES: Hanterar båtdata (CRUD operations, cleanup, lifecycle)
const VesselDataService = require('./lib/services/VesselDataService');

// OUTPUT SERVICES: Genererar användargränssnitt-texter
const BridgeTextService = require('./lib/services/BridgeTextService');

// ANALYSIS SERVICES: Analyserar position, status och rörelser
const ProximityService = require('./lib/services/ProximityService'); // Avstånd till broar
const StatusService = require('./lib/services/StatusService'); // Båtstatus (waiting, under-bridge, etc.)

// KOORDINATION: Hanterar GPS-hopp och systemkoordinering
const SystemCoordinator = require('./lib/services/SystemCoordinator');
const PassageLatchService = require('./lib/services/PassageLatchService'); // Förhindrar status-hopp vid bropassage
const GPSJumpGateService = require('./lib/services/GPSJumpGateService'); // GPS-hopp detektion
const RouteOrderValidator = require('./lib/services/RouteOrderValidator'); // Validerar logisk broordning

// CONNECTION: Hanterar WebSocket-anslutning till AISstream.io
const AISStreamClient = require('./lib/connection/AISStreamClient');

// UTILITIES: Hjälpfunktioner
const { etaDisplay, formatETABroOpeningClause, etaMinutesForDisplay } = require('./lib/utils/etaValidation');
const geometry = require('./lib/utils/geometry');

// =============================================================================
// CONSTANTS: Centraliserade konfigurations-värden
// =============================================================================
const {
  BRIDGES, // Bro-positioner och konfiguration
  COG_DIRECTIONS, // Course Over Ground riktningar (nord/syd)
  UI_CONSTANTS, // UI-uppdatering timeouts
  VALIDATION_CONSTANTS, // Validerings-trösklar
  FLOW_CONSTANTS, // Homey Flow-kort konfiguration
  BRIDGE_TEXT_CONSTANTS, // Bridge text meddelande-regler
  PASSAGE_TIMING, // Timing för bropassager
  BRIDGE_NAME_TO_ID, // Konvertering mellan bronamn och ID
  BRIDGE_ID_TO_NAME,
  TRIGGER_POINTS, // Geografiska triggerpunkter (utanför brotext-systemet)
  TARGET_BRIDGES, // Bug #4: används för att harmonisera BRIDGE_TEXT_BUG-check
  MOORING_DETECTION, // Förtöjningsdetektering (rörelsebevis-trösklar)
} = require('./lib/constants');

// Lägsta fart (knop) där COG är tillförlitlig för riktningsbestämning. Under
// detta är COG brus (stillaliggande båt). Bor i PASSAGE_TIMING i constants.
const MIN_VIABLE_SPEED_KN = PASSAGE_TIMING.MINIMUM_VIABLE_SPEED;

// Bug#12-guardens override-text vid >2 min AIS-avbrott. Hoistad till konstant
// (BT-F5, 2026-07-01) så RC-B-fallbacken kan känna igen och EXKLUDERA den —
// annars kunde frånkopplingstexten sparas som _lastBridgeText och
// återpubliceras som "validated fallback" EFTER reconnect.
const STALE_DATA_OVERRIDE_TEXT = 'AIS-anslutning saknas — data kan vara inaktuell';

/**
 * =============================================================================
 * AIS BRIDGE APP - HUVUDKLASS
 * =============================================================================
 *
 * SYFTE:
 * Spårar båtar nära broar i Trollhättekanalen med AIS-data från AISstream.io.
 * Visar meddelanden när båtar närmar sig eller passerar Klaffbron och Stridsbergsbron.
 *
 * ARKITEKTUR:
 * - Modulär service-baserad arkitektur med dependency injection
 * - Event-driven kommunikation mellan services
 * - Mikro-grace coalescing för UI-uppdateringar (intelligent batching)
 * - GPS-hopp hantering och koordinering
 *
 * HUVUDFUNKTIONER:
 * 1. Ta emot AIS-data från WebSocket
 * 2. Spåra båtar och deras position/status
 * 3. Beräkna ETA till målbroar
 * 4. Generera användarvänliga meddelanden ("bridge text")
 * 5. Trigga Homey Flow-kort för automationer
 */
class AISBridgeApp extends Homey.App {
  /**
   * INITIALISERING AV APPEN
   *
   * ORDNINGSFÖLJD (viktigt för dependencies):
   * 1. Global felhantering (crashskydd)
   * 2. Grundläggande tillstånd
   * 3. Settings listener
   * 4. Initiera services (dependency injection)
   * 5. Setup Flow cards
   * 6. Setup event handlers
   * 7. Starta AIS-anslutning
   * 8. Starta monitoring
   * 9. Initiera UI-uppdateringssystem
   */
  async onInit() {
    // =========================================================================
    // STEG 1: GLOBAL FELHANTERING
    // =========================================================================
    // SYFTE: Förhindra att appen kraschar vid oväntade fel
    // Loggar fel men låter processen fortsätta köra om möjligt
    // F54: spara referenser så lyssnarna kan avregistreras i onUninit. Homey
    // kan starta om en app i samma process; anonyma process-lyssnare skulle
    // annars ackumuleras per omstart → MaxListenersExceeded + döda app-instanser
    // hålls vid liv (minnesläcka).
    this._onUncaughtException = (err) => {
      this.error('[FATAL] Uncaught exception:', err);
      // Logga men exit inte - låt process fortsätta om möjligt
    };
    this._onUnhandledRejection = (reason, promise) => {
      this.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
      // Logga men exit inte - låt process fortsätta om möjligt
    };
    process.on('uncaughtException', this._onUncaughtException);
    process.on('unhandledRejection', this._onUnhandledRejection);

    this.log('AIS Bridge starting with modular architecture v2.0');

    // =========================================================================
    // STEG 2: GRUNDLÄGGANDE TILLSTÅND OCH VARIABLER
    // =========================================================================
    // Dessa variabler håller appens state mellan AIS-uppdateringar

    // --- SETTINGS OCH KONFIGURATION ---
    this.debugLevel = this.homey.settings.get('debug_level') || 'basic';
    const replayCapturePath = process.env.AIS_REPLAY_CAPTURE_FILE
      || process.env.AIS_REPLAY_FILE
      || (this.homey?.env ? (this.homey.env.AIS_REPLAY_CAPTURE_FILE || this.homey.env.AIS_REPLAY_FILE) : null);
    this._replayCaptureFile = replayCapturePath || null;
    this._replayCaptureErrorLogged = false;
    if (this._replayCaptureFile) {
      try {
        const replayDir = path.dirname(this._replayCaptureFile);
        if (replayDir && replayDir !== '.' && !fs.existsSync(replayDir)) {
          fs.mkdirSync(replayDir, { recursive: true });
        }
        this.log(`🧪 [AIS_REPLAY] Capturing AIS data to ${this._replayCaptureFile}`);
        this.log('🧪 [AIS_REPLAY] AIS Replay initierat (fil + stdout)');
      } catch (replayPathError) {
        this.error(`⚠️ [AIS_REPLAY] Unable to prepare replay file path "${this._replayCaptureFile}":`, replayPathError.message);
        this._replayCaptureFile = null;
      }
    } else {
      this.log('ℹ️ [AIS_REPLAY] No AIS_REPLAY_CAPTURE_FILE detected; replay samples will be emitted to stdout only');
      this.log('ℹ️ [AIS_REPLAY] AIS Replay initierat (endast stdout, jsonl skapas via run-with-logs.sh)');
    }

    // --- ANSLUTNINGSSTATUS ---
    // Spårar om vi är anslutna till AISstream.io WebSocket
    this._isConnected = false;
    this._lastConnectionStatus = 'disconnected'; // Cache för att undvika redundanta UI-uppdateringar
    // Review fix M2: seed _lastConnectionLost at boot so the stale-data guard
    // (Bug #12) works correctly even if the AIS client never succeeds in
    // connecting. Cleared on first successful _onAISConnected.
    this._lastConnectionLost = Date.now();

    // --- HOMEY DEVICES ---
    // Set med alla registrerade enheter (används för capability updates)
    this._devices = new Set();

    // --- UI STATE CACHING ---
    // SYFTE: Undvika onödiga UI-uppdateringar genom att cacha senaste värden
    this._lastBridgeText = ''; // Senaste bridge text meddelande
    this._lastBridgeAlarm = false; // Senaste alarm status (true = båtar finns)

    // --- EVENT SYSTEM ---
    // SYFTE: Förhindra dubbel-registrering av event listeners
    this._eventsHooked = false;

    // --- FLOW TRIGGER DEDUPLICATION ---
    // SYFTE: Förhindra att samma båt triggar "boat_near" flow flera gånger
    // Format: Set med nycklar "mmsi:bridgeName" (t.ex. "265648040:Klaffbron")
    // Dedupe-perioden är 10 minuter (rensas i monitoring loop)
    this._triggeredBoatNearKeys = new Set();

    // Anomali 9 fix (2026-05-07): persistent dedup som överlever vessel-removal.
    // _triggeredBoatNearKeys clearas vid STALE_AIS / journey-completion, vilket
    // gör att en återskapad vessel kan trigga samma bro igen → dubbel-notis.
    // Denna Map behåller (mmsi:bridgeName → timestamp) i 2 timmar så fallback
    // för "skipped bridges" inte triggar broar som redan fått notis nyligen.
    // Format: Map<"mmsi:bridgeName", number_timestamp_ms>
    this._persistentRecentTriggers = new Map();
    this._PERSISTENT_DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 timmar

    // P2-fix (2026-06-09): kartan var tidigare ren in-memory → en app-omstart
    // (uppdatering/krasch) nollade 2h-dedupen och ett fartyg som dröjde sig
    // kvar nära en bro fick GARANTERAT dubbelnotis. Ladda persisterat
    // tillstånd från homey.settings (med expiry-filter) och skriv tillbaka
    // vid varje mutation (se _persistRecentTriggers).
    this._loadPersistentTriggers();

    // Namncache (B1, körning 2026-07-03): aisstream backfyller MetaData.
    // ShipName först efter uppåt 30+ min för Class B (VALEN fick 5 notiser
    // som "Unknown" innan namnet kom). Cachen minns mmsi→namn över omstarter
    // så återkommande fartyg får rätt namn från FÖRSTA meddelandet.
    // Format: Map<mmsi, { name, t }> där t = senaste bekräftelsen.
    this._knownVesselNames = new Map();
    this._VESSEL_NAME_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dagar
    this._VESSEL_NAME_MAX_ENTRIES = 200; // äldst-först-eviction vid taket
    this._loadVesselNames();

    // F2-följdfix (2026-07-03, SPIKEN): sista kända position per mmsi vid
    // removal — begränsar scenario A:s porten-antagande vid återfödelse.
    // Produktionsredo-granskningen: PERSISTERAS över omstart — utan detta
    // återkom porten-antagandets falska notiser efter varje appomstart
    // (F8-beslutet tog bort tidsskattningsstrypet som råkade maskera dem).
    this._lastKnownPositions = new Map();
    this._LAST_KNOWN_POSITION_TTL_MS = 6 * 60 * 60 * 1000; // 6 timmar
    this._loadLastKnownPositions();

    // --- SJÄLVLÄRANDE KAJKARTA (F4-L, fältprov 4 2026-07-09) ---
    // Konstaterade förtöjnings-/ankringsplatser (MOORED_DEMOTE/
    // ANCHORED_DEMOTE) lärs persistent. De statiska MOORING_ZONES täcker
    // inte gästhamnar/ankringsvikar — en förstakontakt nära en INLÄRD plats
    // behandlas som kajavgång (N7-vakten) i stället för porten-gissning,
    // vilket stryper fantomnotiser där båtar bevisligen brukar ligga.
    this._learnedMooringSpots = [];
    // Fältprov 4b (2026-07-09, ANVÄNDARFRÅGA om vintern): fysiska kaj-/
    // ankringsplatser är stabila i år — 30 dagar hade raderat hela kartan
    // efter en tyst vintersäsong och tvingat om-inlärning varje vår. 365
    // dagar med TTL-FÖRNYELSE vid varje återbekräftad förtöjning låter
    // kartan övervintra; en plats försvinner bara om ingen båt legat där
    // på ett helt år.
    this._LEARNED_SPOT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
    this._loadLearnedMooringSpots();

    // --- UI UPPDATERINGS-STATE ---
    // SYFTE: Spåra om en UI-uppdatering redan är schemalagd (förhindrar duplikat)
    this._uiUpdateScheduled = false;

    // --- TIMER TRACKING ---
    // SYFTE: Hålla koll på alla timers för korrekt cleanup vid shutdown
    this._vesselRemovalTimers = new Map(); // Map<mmsi, timerId> för vessel cleanup
    this._monitoringInterval = null; // Monitoring loop timer

    // --- RACE CONDITION SKYDD ---
    // SYFTE: Förhindra att flera trådar försöker ta bort samma vessel samtidigt
    // Detta kan orsaka crashes och inkonsekvent state
    this._processingRemoval = new Set(); // Set med MMSI som håller på att tas bort

    // =========================================================================
    // STEG 3: SETUP SETTINGS LISTENER
    // =========================================================================
    // Lyssnar på ändringar av debug_level setting från Homey UI
    this._setupSettingsListener();

    // =========================================================================
    // STEG 4-9: FORTSATT INITIALISERING
    // =========================================================================
    // Initiera services, flow cards, event handlers, AIS-anslutning och monitoring
    await this._initializeServices(); // Steg 4: Skapa alla service-instanser
    await this._setupFlowCards(); // Steg 5: Registrera Homey Flow-kort
    await this._initGlobalToken(); // Steg 5b: Skapa global bridge_text token
    this._setupEventHandlers(); // Steg 6: Koppla event listeners mellan services
    await this._startConnection(); // Steg 7: Anslut till AISstream.io WebSocket
    this._setupMonitoring(); // Steg 8: Starta monitoring loops
    this._initializeCoalescingSystem(); // Steg 9: Initiera mikro-grace UI-system

    this.log('AIS Bridge initialized successfully with modular architecture');
  }

  /**
   * ==========================================================================
   * SERVICE INITIALISERING
   * ==========================================================================
   *
   * SYFTE:
   * Skapa och konfigurera alla service-instanser med dependency injection.
   *
   * DEPENDENCY ORDNING (viktigt!):
   * 1. SystemCoordinator (används av många andra services)
   * 2. BridgeRegistry (bro-konfiguration)
   * 3. VesselDataService (behöver SystemCoordinator + BridgeRegistry)
   * 4. Analysis services (behöver VesselDataService)
   * 5. Output services (behöver alla ovanstående)
   * 6. Connection services (fristående)
   *
   * VARFÖR DEPENDENCY INJECTION?
   * - Testbarhet: Services kan mockas i tester
   * - Flexibilitet: Lätt att byta implementation
   * - Tydlighet: Dependencies är explicita i konstruktorer
   *
   * @private
   */
  async _initializeServices() {
    try {
      this.log('🔧 Initializing modular services...');

      // --- STEG 1: SYSTEM COORDINATOR ---
      // SYFTE: Koordinerar GPS-hopp detektion och status-stabilisering
      // Detta är en "hub" som andra services använder för att koordinera beteende
      this.systemCoordinator = new SystemCoordinator(this);

      // --- STEG 2: BRIDGE REGISTRY (DATA MODEL) ---
      // SYFTE: Håller information om alla broar (position, namn, radie)
      // Validerar att bro-konfigurationen är korrekt vid start
      this.bridgeRegistry = new BridgeRegistry(BRIDGES);

      const validation = this.bridgeRegistry.validateConfiguration();
      if (!validation.valid) {
        this.error('Bridge configuration invalid:', validation.errors);
        throw new Error('Invalid bridge configuration');
      }

      // --- STEG 3: VESSEL DATA SERVICE ---
      // SYFTE: Central hantering av båtdata (CRUD operations)
      // - Skapar/uppdaterar/tar bort vessels
      // - Hanterar cleanup timers
      // - Spårar vessel lifecycle (entry → passage → removal)
      this.vesselDataService = new VesselDataService(this, this.bridgeRegistry, this.systemCoordinator);

      // --- STEG 4: ANALYSIS SERVICES ---
      // Dessa analyserar vessel-data och bestämmer status/position

      // ProximityService: Beräknar avstånd till broar
      this.proximityService = new ProximityService(this.bridgeRegistry, this);

      // PassageLatchService: Förhindrar status-hopp vid bropassage (anti-flicker)
      this.passageLatchService = new PassageLatchService(this);

      // GPSJumpGateService: Detekterar GPS-hopp och gatar passage-detektering
      this.gpsJumpGateService = new GPSJumpGateService(this, this.systemCoordinator);

      // RouteOrderValidator: Validerar att bropassager sker i logisk ordning
      this.routeOrderValidator = new RouteOrderValidator(this, this.bridgeRegistry);

      // StatusService: Bestämmer vessel status (approaching/waiting/under-bridge/passed)
      // Detta är kärnan i status-logiken och används av alla andra services
      this.statusService = new StatusService(
        this.bridgeRegistry,
        this,
        this.systemCoordinator,
        this.vesselDataService,
        this.passageLatchService,
      );

      // --- STEG 5: OUTPUT SERVICES ---
      // BridgeTextService: Genererar användarvänliga meddelanden från vessel-data
      // Exempel: "En båt inväntar broöppning vid Klaffbron"
      this.bridgeTextService = new BridgeTextService(
        this.bridgeRegistry,
        this,
        this.systemCoordinator,
        this.vesselDataService,
        this.passageLatchService,
      );

      // --- STEG 6: CONNECTION SERVICES ---
      // AISStreamClient: Hanterar WebSocket-anslutning till AISstream.io
      // Tar emot AIS-meddelanden och emitterar events
      this.aisClient = new AISStreamClient(this);

      this.log('✅ All services initialized successfully');
    } catch (error) {
      this.error('Failed to initialize services:', error);
      throw error;
    }
  }

  /**
   * ==========================================================================
   * SETTINGS LISTENER
   * ==========================================================================
   *
   * SYFTE:
   * Lyssnar på ändringar i Homey settings och uppdaterar app-konfiguration.
   *
   * SUPPORTED SETTINGS:
   * - debug_level: Kontrollerar hur mycket logging som visas
   *   Nivåer: 'off', 'basic', 'detailed', 'full'
   *
   * @private
   */
  _setupSettingsListener() {
    this._onSettingsChanged = (key, value) => {
      if (key === 'debug_level') {
        const newLevel = this.homey.settings.get('debug_level');
        this.log(`🔧 Debug level change received: "${newLevel}" (type: ${typeof newLevel})`);

        // Validera att nivån är tillåten
        const allowed = ['off', 'basic', 'detailed', 'full'];
        if (allowed.includes(newLevel)) {
          this.debugLevel = newLevel;
          this.log(`🎛️ Debug level changed to: ${this.debugLevel}`);
        } else {
          this.log(`⚠️ Ignoring invalid debug_level value: ${newLevel}`);
        }
      } else if (key === 'ais_api_key') {
        // F8 (KRITISK): listenern reagerade tidigare ENBART på debug_level, så
        // ett byte av API-nyckeln gjorde ingenting — connect() anropades aldrig
        // med den nya nyckeln och hela datainflödet (bridge_text + notiser) låg
        // nere tills appen startades om manuellt. Återanslut nu kontrollerat.
        const newKey = this.homey.settings.get('ais_api_key');
        if (typeof newKey === 'string' && newKey.trim().length > 0) {
          this.log('🔑 [SETTINGS] ais_api_key ändrad — återansluter AIS-strömmen med ny nyckel');
          if (this.aisClient && typeof this.aisClient.reconnectWithKey === 'function') {
            this.aisClient.reconnectWithKey(newKey.trim()).catch((err) => {
              this.error('[SETTINGS] Misslyckades att återansluta med ny API-nyckel:', err);
            });
          }
        } else {
          this.log('🔑 [SETTINGS] ais_api_key tömd/ogiltig — kopplar ner AIS-strömmen');
          if (this.aisClient && typeof this.aisClient.disconnect === 'function') {
            this.aisClient.disconnect();
          }
        }
      }
    };

    // Registrera listener för settings-ändringar
    this.homey.settings.on('set', this._onSettingsChanged);
  }

  /**
   * P2-fix: ladda persisterad 2h-dedup-karta från homey.settings.
   * Poster äldre än dedup-fönstret filtreras bort vid laddning.
   * Defensivt skriven — settings kan saknas i testkonstruktioner.
   * @private
   */
  _loadPersistentTriggers() {
    try {
      if (!this.homey || !this.homey.settings || typeof this.homey.settings.get !== 'function') {
        return;
      }
      const stored = this.homey.settings.get('persistent_recent_triggers');
      if (!stored || typeof stored !== 'object') {
        return;
      }
      const now = Date.now();
      const windowMs = this._PERSISTENT_DEDUP_WINDOW_MS;
      let loaded = 0;
      for (const [key, value] of Object.entries(stored)) {
        // Körning 2026-07-02 (ELFKUNGEN): nytt format {t, dir} — riktningen
        // gör dedupen resemedveten över omstarter. Äldre lagrade poster är
        // rena tal; de accepteras utan riktning (konservativ blockering).
        const ts = typeof value === 'number' ? value : value && value.t;
        if (Number.isFinite(ts) && now - ts < windowMs) {
          this._persistentRecentTriggers.set(
            key,
            typeof value === 'number' ? { t: value, dir: null } : { t: ts, dir: value.dir || null },
          );
          loaded++;
        }
      }
      if (loaded > 0) {
        this.log(`🔁 [PERSISTENT_DEDUP] Restored ${loaded} recent trigger entries from settings (survives restart)`);
      }
    } catch (error) {
      this.error('[PERSISTENT_DEDUP] Failed to load persisted triggers:', error.message || error);
    }
  }

  /**
   * Körning 2026-07-02 (ELFKUNGEN): riktningsmedveten persistent-dedup-koll.
   * ELFKUNGEN passerade Stridsbergsbron norrut ~10:32 (förra app-processen),
   * vände vid Stallbackabron och passerade Strids IGEN söderut 12:08 — en ny
   * broöppning, men 2h-fönstret från settings blockerade notisen ("triggered
   * 95 min ago"). I-session rensas dedupen av journey-reset/NEW_JOURNEY vid
   * vändningar, men över en omstart finns ingen sådan händelse. Regeln:
   * en post blockerar bara i SAMMA färdriktning; motsatt riktning = ny
   * passage. Saknas riktning (äldre poster/okänd cog) blockeras konservativt.
   * @param {string} dedupeKey - "mmsi:Bronamn"
   * @param {Object} vessel - för aktuell färdriktning
   * @param {Object} [opts] - { retroactiveSource: true } för failsafe-/exit-
   *   bekräftelser (passage-fallback/just-passed/exit): riktningsflip-
   *   undantaget kräver då att posten är ≥15 min gammal. Fältprov 3
   *   (2026-07-08, AKIRA Jvb ×2): en approach-notis märktes 'south' av den
   *   inlåsta ruttriktningen; när korsningsbeviset 10 min senare rättade
   *   låset till 'north' såg flip-undantaget en "ny passage" och failsafen
   *   dubbelnotifierade SAMMA broöppningshändelse. En färsk notis för samma
   *   bro täcker samma öppning oavsett riktningsflagga — äkta returer tar
   *   längre (ELFKUNGEN 117 min; korpus #9-returen ≥66 min). Approach-vägen
   *   (source=current) berörs INTE — HALIFAX äkta U-sväng (10 min) ska
   *   fortsatt släppas där.
   * @returns {{blocked: boolean, minutesSince: number}}
   * @private
   */
  _persistentDedupCheck(dedupeKey, vessel, opts = {}) {
    if (!this._persistentRecentTriggers) return { blocked: false, minutesSince: 0 };
    const entry = this._persistentRecentTriggers.get(dedupeKey);
    const ts = typeof entry === 'number' ? entry : entry && entry.t;
    if (!Number.isFinite(ts)) return { blocked: false, minutesSince: 0 };
    const windowMs = this._PERSISTENT_DEDUP_WINDOW_MS || 2 * 60 * 60 * 1000;
    const age = Date.now() - ts;
    if (age >= windowMs) return { blocked: false, minutesSince: Math.round(age / 60000) };
    const storedDir = typeof entry === 'object' && entry ? entry.dir : null;
    // F4-C (PIANO): flip-bedömningens NYA riktning kräver rörelsebevis
    const currentDir = this._dedupDirection(vessel, { requireMovement: true });
    if (storedDir && currentDir && storedDir !== currentDir) {
      // Fable-granskningen 2026-07-10b (A4-2): 15 min täckte inte vardagliga
      // köväntetider vid rusningsspärr (15–60 min) — en vobbel-lagrad post
      // (dir ur cog vid väntfart, målbrolös båt utan ruttlås) + bevisad
      // korsning >15 min senare gav ANDRA notisen för samma passage.
      // Lagringen kan inte rörelsegated:as (HALIFAX-posten 'south' @ 1,1 kn
      // är facit-låst och krävs för hennes äkta U-svängssläpp) — rätt ratt
      // är denna gräns. Kalibrering ur egna facit: äkta retroaktiva returer
      // tar ≥66 min (korpus #9) resp. 117 min (ELFKUNGEN); HALIFAX äkta
      // 10-min-U-sväng går via approach-vägen som inte berörs av gaten.
      //
      // R2 2026-07-11 (A4R2-1/A1R2-2/P2R2-3 — 3 oberoende): 60-min-
      // kalibreringen gällde BRO-returer ("samma broöppningshändelse").
      // Vid triggerPUNKTEN Kanalinfarten finns ingen öppning — nordgående
      // ENTRY och sydgående EXIT är per design TVÅ legitima notiser, och
      // sydbassäng-rundturen (kö vid Klaffbron → ger upp → ut) tar ofta
      // 25–60 min. 60-min-gaten öppnade hålet från noll (rundturer genom
      // zonen tar alltid ≥25 min > gamla 15). Kanalinfarten behåller därför
      // 15-min-gränsen (vobbel-dubbletter vid punkten skyddas ändå av
      // rörelsekravet i currentDir); broarna behåller 60.
      const isTriggerPoint = dedupeKey.endsWith(':Kanalinfarten');
      const RETROACTIVE_FLIP_MIN_AGE_MS = isTriggerPoint
        ? 15 * 60 * 1000
        : 60 * 60 * 1000;
      if (opts.retroactiveSource && age < RETROACTIVE_FLIP_MIN_AGE_MS) {
        this.log(
          `🚫 [PERSISTENT_DEDUP_RECENT] ${dedupeKey}: direction flipped (${storedDir} → ${currentDir}) `
          + `but entry only ${Math.round(age / 60000)} min old — same bridge-opening event, blocking retroactive re-notify`,
        );
        return { blocked: true, minutesSince: Math.round(age / 60000) };
      }
      this.log(
        `🔁 [PERSISTENT_DEDUP_DIRECTION] ${dedupeKey}: entry ${Math.round(age / 60000)} min old but `
        + `direction flipped (${storedDir} → ${currentDir}) — treating as NEW passage, not blocking`,
      );
      return { blocked: false, minutesSince: Math.round(age / 60000) };
    }
    return { blocked: true, minutesSince: Math.round(age / 60000) };
  }

  /**
   * Färdriktning för dedup-poster: låst ruttriktning i första hand, annars cog.
   * @param {Object} vessel - Vesselobjekt
   * @param {Object} [opts] - { requireMovement: true } för riktningsflip-
   *   BEDÖMNINGAR (F4-C, fältprov 4 2026-07-09, PIANO): den NYA riktningen i
   *   ett flip-släpp måste vara rörelsebelagd — cog-fallbacken kräver då
   *   sog ≥ 2,0 kn (Fix D-tröskeln). PIANO väntade vid Olidebron (113 m) och
   *   fick 'north' ur cog 40,6° @ 0,7 kn → flip-undantaget släppte nyckeln →
   *   DUBBELNOTIS för samma väntläge. LAGRINGEN (posten vid notis) behåller
   *   default — HALIFAX:s 08:29-post ('south' @ 1,1 kn) är facit-låst i
   *   korpus #10 och krävs för att hennes äkta U-svängssläpp (4,2 kn) ska
   *   fungera. Den låsta _routeDirection-grenen berörs inte (positionsbevisad).
   * @private
   */
  _dedupDirection(vessel, opts = {}) {
    if (!vessel) return null;
    if (vessel._routeDirection === 'north' || vessel._routeDirection === 'south') {
      return vessel._routeDirection;
    }
    const { cog } = vessel;
    if (!Number.isFinite(cog)) return null;
    if (opts.requireMovement === true
        && (!Number.isFinite(vessel.sog) || vessel.sog < 2.0)) {
      return null; // COG är vobbel vid väntfart — okänd ⇒ konservativ blockering
    }
    if (cog >= 315 || cog <= 45) return 'north';
    // Produktionsredo (2026-07-03): sydband 135–314° — harmoniserat med
    // _getDirectionString. Det smala bandet (135–225) lagrade dir=null för
    // SV-kurs (226–314°, normal sydfärd i den NE–SV-orienterade kanalen)
    // → ELFKUNGEN-undantaget (motsatt riktning släpper dedup) slog aldrig
    // för sådana returresor.
    if (cog >= 135 && cog < 315) return 'south';
    return null;
  }

  /**
   * P2-fix: skriv 2h-dedup-kartan till homey.settings. Anropas efter varje
   * mutation (set/delete/cleanup). Skrivfrekvensen är låg (en per notis) så
   * write-through är billigt och säkrar tillståndet även vid krasch.
   * @private
   */
  _persistRecentTriggers() {
    try {
      if (!this.homey || !this.homey.settings || typeof this.homey.settings.set !== 'function') {
        return;
      }
      if (!this._persistentRecentTriggers) {
        return;
      }
      const serialized = {};
      // Värdet är sedan 2026-07-02 ett {t, dir}-objekt (inte ett rent tal).
      for (const [key, entry] of this._persistentRecentTriggers.entries()) {
        serialized[key] = entry;
      }
      this.homey.settings.set('persistent_recent_triggers', serialized);
    } catch (error) {
      this.error('[PERSISTENT_DEDUP] Failed to persist triggers:', error.message || error);
    }
  }

  /**
   * B1 (2026-07-03): ladda persistent mmsi→namn-cache från settings.
   * Samma defensiva mönster som _loadPersistentTriggers; poster äldre än
   * TTL:n (30 dagar) filtreras bort vid inläsning.
   * @private
   */
  _loadVesselNames() {
    try {
      if (!this.homey || !this.homey.settings || typeof this.homey.settings.get !== 'function') {
        return;
      }
      const stored = this.homey.settings.get('known_vessel_names');
      if (!stored || typeof stored !== 'object') {
        return;
      }
      const now = Date.now();
      let loaded = 0;
      for (const [mmsi, entry] of Object.entries(stored)) {
        const name = entry && typeof entry.name === 'string' ? entry.name.trim() : null;
        const ts = entry && Number.isFinite(entry.t) ? entry.t : null;
        if (name && name !== 'Unknown' && ts && now - ts < this._VESSEL_NAME_TTL_MS) {
          this._knownVesselNames.set(String(mmsi), { name, t: ts });
          loaded++;
        }
      }
      if (loaded > 0) {
        this.log(`🔁 [NAME_CACHE] Restored ${loaded} vessel names from settings (survives restart)`);
      }
    } catch (error) {
      this.error('[NAME_CACHE] Failed to load vessel names:', error.message || error);
    }
  }

  /**
   * B1: skriv namncachen till settings. Storlekstak med äldst-först-eviction
   * (t = senaste bekräftelsen) så settings-posten inte växer obegränsat.
   * @private
   */
  _persistVesselNames() {
    try {
      if (!this.homey || !this.homey.settings || typeof this.homey.settings.set !== 'function') {
        return;
      }
      if (!this._knownVesselNames) {
        return;
      }
      if (this._knownVesselNames.size > this._VESSEL_NAME_MAX_ENTRIES) {
        const sorted = [...this._knownVesselNames.entries()].sort((a, b) => a[1].t - b[1].t);
        const excess = this._knownVesselNames.size - this._VESSEL_NAME_MAX_ENTRIES;
        for (let i = 0; i < excess; i++) {
          this._knownVesselNames.delete(sorted[i][0]);
        }
      }
      const serialized = {};
      for (const [mmsi, entry] of this._knownVesselNames.entries()) {
        serialized[mmsi] = entry;
      }
      this.homey.settings.set('known_vessel_names', serialized);
    } catch (error) {
      this.error('[NAME_CACHE] Failed to persist vessel names:', error.message || error);
    }
  }

  /**
   * B1: registrera ett bekräftat riktigt namn för mmsi. Skriver till settings
   * endast när namnet är nytt/ändrat eller senaste persisteringen är >24 h
   * gammal — inte per meddelande (Class B upprepar namnet var 30:e sekund
   * när det väl är känt; write-through per meddelande vore settings-spam).
   * @private
   */
  _rememberVesselName(mmsi, name) {
    if (!this._knownVesselNames) return;
    const trimmed = (name || '').trim();
    if (!trimmed || trimmed === 'Unknown') return;
    const key = String(mmsi);
    const existing = this._knownVesselNames.get(key);
    const now = Date.now();
    if (!existing || existing.name !== trimmed || now - existing.t > 24 * 60 * 60 * 1000) {
      this._knownVesselNames.set(key, { name: trimmed, t: now });
      this._persistVesselNames();
      if (!existing || existing.name !== trimmed) {
        this.log(`📛 [NAME_CACHE] ${key}: remembered vessel name "${trimmed}"${existing ? ` (was "${existing.name}")` : ''}`);
      }
    }
  }

  /**
   * SPIKEN-vaktens persistens (2026-07-03): sista kända position per mmsi
   * överlever omstart. Samma defensiva mönster som _loadPersistentTriggers;
   * TTL-filter (6 h) vid inläsning.
   * @private
   */
  /**
   * F4-L: läs inlärda förtöjningsplatser från settings (TTL-prövade).
   * @private
   */
  _loadLearnedMooringSpots() {
    try {
      if (!this.homey || !this.homey.settings || typeof this.homey.settings.get !== 'function') {
        return;
      }
      const stored = this.homey.settings.get('learned_mooring_spots');
      if (!Array.isArray(stored)) return;
      const now = Date.now();
      this._learnedMooringSpots = stored.filter((s) => s
        && Number.isFinite(s.lat) && Number.isFinite(s.lon)
        && Number.isFinite(s.t) && now - s.t < this._LEARNED_SPOT_TTL_MS);
      if (this._learnedMooringSpots.length > 0) {
        this.log(`⚓ [MOORING_SPOTS] Restored ${this._learnedMooringSpots.length} learned mooring spots (survives restart)`);
      }
    } catch (error) {
      this.error('[MOORING_SPOTS] Failed to load learned spots:', error.message || error);
    }
  }

  /**
   * F4-L: skriv inlärda platser till settings (write-through, låg frekvens).
   * @private
   */
  _persistLearnedMooringSpots() {
    try {
      if (!this.homey || !this.homey.settings || typeof this.homey.settings.set !== 'function') {
        return;
      }
      this.homey.settings.set('learned_mooring_spots', this._learnedMooringSpots || []);
    } catch (error) {
      this.error('[MOORING_SPOTS] Failed to persist learned spots:', error.message || error);
    }
  }

  /**
   * F4-L: lär en bevisad förtöjnings-/ankringsplats. Dedup 50 m (befintlig
   * plats får förnyad TTL), tak 200 platser (äldst evicteras).
   * @private
   */
  _learnMooringSpot(lat, lon, mmsi) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (!Array.isArray(this._learnedMooringSpots)) this._learnedMooringSpots = [];
    // Fältprov 4b (2026-07-09): BROFILTER — punkter inom 300 m från en bro
    // lärs inte. Demote-vägarna undantar redan brovänta (femlagrets
    // väntundantag; ANCHORED kräver ≥800 m från TARGET), men en långkö vid
    // en MELLANBRO (t.ex. Järnvägsbron-kö med target Klaffbron, 964 m bort)
    // kunde annars smyga in som "kajplats" och få framtida förstakontakter
    // vid bron felklassade som kajstartare. Äkta gästhamnar ligger inte
    // under broarna; de statiska MOORING_ZONES påverkas inte av filtret.
    if (this.bridgeRegistry && typeof this.bridgeRegistry.getAllBridgeIds === 'function') {
      for (const bridgeId of this.bridgeRegistry.getAllBridgeIds()) {
        const bridge = this.bridgeRegistry.getBridge(bridgeId);
        if (bridge && Number.isFinite(bridge.lat) && Number.isFinite(bridge.lon)) {
          const dBridge = geometry.calculateDistance(lat, lon, bridge.lat, bridge.lon);
          if (Number.isFinite(dBridge) && dBridge < 300) {
            this.debug(
              `⚓ [MOORING_SPOT_SKIP_NEAR_BRIDGE] ${mmsi}: ${Math.round(dBridge)} m från `
              + `${bridge.name} — brozon lärs inte som förtöjningsplats`,
            );
            return;
          }
        }
      }
    }
    const DEDUP_RADIUS_M = 50;
    for (const spot of this._learnedMooringSpots) {
      const d = geometry.calculateDistance(lat, lon, spot.lat, spot.lon);
      if (Number.isFinite(d) && d <= DEDUP_RADIUS_M) {
        // Fable-granskningen 2026-07-10b (A1-1/DIV-1): TTL-förnyelsen
        // persisterade vid VARJE AIS-meddelande från förtöjd båt (~480
        // settings-skrivningar/dygn/kajliggare — flash-slitage + IO-churn
        // på en enhet som kör i månader). En 365-dagars-TTL behöver högst
        // dygnsgranulär förnyelse — samma 24h-guard som namncachen
        // (_rememberVesselName), beprövad mall i samma fil.
        if (Date.now() - spot.t > 24 * 60 * 60 * 1000) {
          spot.t = Date.now(); // platsen återbekräftad — förnya TTL
          this._persistLearnedMooringSpots();
        }
        return;
      }
    }
    this._learnedMooringSpots.push({ lat, lon, t: Date.now() });
    const MAX_SPOTS = 200;
    if (this._learnedMooringSpots.length > MAX_SPOTS) {
      this._learnedMooringSpots.sort((a, b) => a.t - b.t);
      this._learnedMooringSpots.splice(0, this._learnedMooringSpots.length - MAX_SPOTS);
    }
    this.log(
      `⚓ [MOORING_SPOT_LEARNED] ${mmsi}: ny förtöjningsplats (${lat.toFixed(5)}, ${lon.toFixed(5)}) `
      + `— ${this._learnedMooringSpots.length} kända platser`,
    );
    this._persistLearnedMooringSpots();
  }

  /**
   * F4-L: ligger punkten nära en inlärd förtöjningsplats? (TTL-prövad)
   * @private
   */
  _isNearLearnedMooringSpot(lat, lon, radiusM = 100) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    if (!Array.isArray(this._learnedMooringSpots)) return false;
    const now = Date.now();
    return this._learnedMooringSpots.some((s) => {
      if (!Number.isFinite(s.t) || now - s.t >= this._LEARNED_SPOT_TTL_MS) return false;
      const d = geometry.calculateDistance(lat, lon, s.lat, s.lon);
      return Number.isFinite(d) && d <= radiusM;
    });
  }

  _loadLastKnownPositions() {
    try {
      if (!this.homey || !this.homey.settings || typeof this.homey.settings.get !== 'function') {
        return;
      }
      const stored = this.homey.settings.get('last_known_positions');
      if (!stored || typeof stored !== 'object') {
        return;
      }
      const now = Date.now();
      let loaded = 0;
      for (const [mmsi, entry] of Object.entries(stored)) {
        if (entry && Number.isFinite(entry.lat) && Number.isFinite(entry.lon)
            && Number.isFinite(entry.t) && now - entry.t < this._LAST_KNOWN_POSITION_TTL_MS) {
          this._lastKnownPositions.set(String(mmsi), entry);
          loaded++;
        }
      }
      if (loaded > 0) {
        this.log(`🔁 [LAST_KNOWN] Restored ${loaded} last-known positions from settings (survives restart)`);
      }
    } catch (error) {
      this.error('[LAST_KNOWN] Failed to load last-known positions:', error.message || error);
    }
  }

  /**
   * SPIKEN-vaktens persistens: skriv mappen till settings. Anropas vid
   * mutation (removal) — låg frekvens, write-through är billigt.
   * @private
   */
  _persistLastKnownPositions() {
    try {
      if (!this.homey || !this.homey.settings || typeof this.homey.settings.set !== 'function') {
        return;
      }
      if (!this._lastKnownPositions) {
        return;
      }
      const serialized = {};
      for (const [mmsi, entry] of this._lastKnownPositions.entries()) {
        serialized[mmsi] = entry;
      }
      this.homey.settings.set('last_known_positions', serialized);
    } catch (error) {
      this.error('[LAST_KNOWN] Failed to persist last-known positions:', error.message || error);
    }
  }

  /**
   * B1: slå upp cachat namn för mmsi (null om okänt/utgånget).
   * @private
   */
  _lookupVesselName(mmsi) {
    if (!this._knownVesselNames) return null;
    const entry = this._knownVesselNames.get(String(mmsi));
    if (!entry) return null;
    if (Date.now() - entry.t >= this._VESSEL_NAME_TTL_MS) {
      this._knownVesselNames.delete(String(mmsi));
      return null;
    }
    return entry.name;
  }

  /**
   * ==========================================================================
   * EVENT HANDLERS SETUP - EVENT-DRIVEN ARKITEKTUR
   * ==========================================================================
   *
   * SYFTE:
   * Koppla samman alla services via event-baserad kommunikation.
   * Detta ger löst kopplade komponenter som kan arbeta oberoende.
   *
   * EVENT FLÖDE:
   *
   * 1. AIS Client Events:
   *    connected → _onAISConnected → Uppdatera UI status
   *    disconnected → _onAISDisconnected → Uppdatera UI status
   *    ais-message → _onAISMessage → Process AIS data (VIKTIGAST!)
   *    error → _onAISError → Logga fel
   *    reconnect-needed → _onAISReconnectNeeded → Försök återanslut
   *
   * 2. VesselDataService Events:
   *    vessel:entered → _onVesselEntered → Initial setup för ny båt
   *    vessel:updated → _onVesselUpdated → Uppdatera UI
   *    vessel:removed → _onVesselRemoved → Cleanup och UI-update
   *
   * 3. StatusService Events:
   *    status:changed → _onVesselStatusChanged → Trigga flows, uppdatera UI
   *
   * VARFÖR EVENT-DRIVEN?
   * - Decoupling: Services behöver inte känna till varandra
   * - Flexibilitet: Lätt att lägga till nya listeners
   * - Testbarhet: Events kan mockas i tester
   *
   * @private
   */
  _setupEventHandlers() {
    // SKYDD MOT DUBBEL-REGISTRERING
    // Om event handlers redan är registrerade, gör ingenting
    if (this._eventsHooked) return;
    this._eventsHooked = true;

    this.log('🔗 Setting up event-driven communication...');

    // --- VESSEL DATA SERVICE EVENTS ---
    // Dessa events triggas när båtar läggs till, uppdateras eller tas bort

    // vessel:entered: Ny båt har dykt upp i systemet
    // F37: fånga ohanterade rejections (handlern är async + fire-and-forget) så
    // ett fel i en båts entry-flöde inte blir en unhandledRejection.
    this.vesselDataService.on('vessel:entered', (e) => this._onVesselEntered(e).catch((err) => this.error('[VESSEL_ENTERED] Unhandled error:', err)));

    // vessel:updated: Befintlig båt har fått nya AIS-data
    // R2 2026-07-11 (SYSR2-obs): samma F37-wrapper som systerhändelserna —
    // taggad fellogg i stället för kontextlös global unhandledRejection.
    this.vesselDataService.on('vessel:updated', (e) => this._onVesselUpdated(e).catch((err) => this.error('[VESSEL_UPDATED] Unhandled error:', err)));

    // vessel:removed: Båt har tagits bort (timeout eller lämnat området)
    // DIV-3 (Fable 2026-07-10b): samma F37-wrapper som systerhändelserna —
    // en rejection i den asynkrona handlern fick annars drunkna som
    // kontextlös global unhandledRejection i stället för taggad fellogg.
    this.vesselDataService.on('vessel:removed', (e) => this._onVesselRemoved(e).catch((err) => this.error('[VESSEL_REMOVED] Unhandled error:', err)));

    // vessel:journey-reset (N1, 2026-07-01): bekräftad U-sväng MITT i resan
    // (Fix D) = ny resa i motsatt riktning. VDS har nollat passedBridges;
    // app-lagret måste spegla NEW_JOURNEY-resetten och rensa dedup-nycklarna
    // (session + persistent) så returresans broar kan notifiera igen.
    this.vesselDataService.on('vessel:journey-reset', ({ mmsi, vessel, bridges }) => {
      try {
        if (Array.isArray(bridges) && bridges.length > 0) {
          // Fältprov 3 (2026-07-08): riktningsrelativ reset — rensa endast
          // nycklarna för broar FRAMFÖR båten i nya riktningen. Full rensning
          // dubbelnotifierade nya benets redan avfyrade broar (AKIRA:
          // Järnvägsbron ×2 i replayen av 21h-loggen).
          this.log(
            `🔁 [JOURNEY_RESET_DEDUP] ${mmsi}: clearing boat_near dedup keys for `
            + `reversed journey [${bridges.join(', ')}]`,
          );
          let persistentDirty = false;
          for (const bridgeName of bridges) {
            const key = `${mmsi}:${bridgeName}`;
            this._triggeredBoatNearKeys.delete(key);
            if (this._persistentRecentTriggers && this._persistentRecentTriggers.delete(key)) {
              persistentDirty = true;
            }
          }
          if (persistentDirty) this._persistRecentTriggers();
        } else {
          this.log(`🔁 [JOURNEY_RESET_DEDUP] ${mmsi}: clearing boat_near dedup keys for reversed journey`);
          // Fable-granskningen 2026-07-10b (P2-1): N2-reentry-resetten (10-min-
          // cooldownens utgång) var positionsblind — den raderade även poster
          // för broar som notifierats UNDER cooldownen (MOSHE-klassen: Olide-
          // bron-notis 40 s före resetten, båten kvar i 300 m-zonen) → nästa
          // proximity-tick avfyrade om SAMMA fysiska passage. Tidslinjen ger
          // en ren skiljelinje: förra resans poster är ≥10 min gamla vid
          // resetten (completion + cooldown), nya benets poster <10 min —
          // bevara de färska. (N1-vägen ovan är riktningsrelativ och rörs ej;
          // NEW_JOURNEY-fullrensningen i _onVesselUpdated är HALIFAX-facitlåst.)
          this._clearBoatNearTriggers(vessel, true, { preserveFreshPersistentMs: 10 * 60 * 1000 });
        }
      } catch (err) {
        this.error(`[JOURNEY_RESET] Error clearing triggers for ${mmsi}:`, err);
      }
    });

    // vessel:mooring-spot (F4-L, fältprov 4 2026-07-09): självlärande
    // kajkartan — konstaterade förtöjningar/ankringar lärs persistent.
    this.vesselDataService.on('vessel:mooring-spot', ({ mmsi, lat, lon }) => {
      try {
        this._learnMooringSpot(lat, lon, mmsi);
      } catch (err) {
        this.error(`[MOORING_SPOTS] Failed to learn spot for ${mmsi}:`, err.message || err);
      }
    });

    // --- STATUS SERVICE EVENTS ---
    // Triggas när en båts status ändras (approaching → waiting → under-bridge → passed)
    // F37: fånga ohanterade rejections i den asynkrona, fire-and-forget-handlern.
    this.statusService.on('status:changed', (e) => this._onVesselStatusChanged(e).catch((err) => this.error('[STATUS_CHANGED] Unhandled error:', err)));

    // --- AIS CLIENT EVENTS ---
    // Dessa events kommer från WebSocket-anslutningen till AISstream.io

    // connected: WebSocket anslutning etablerad
    this.aisClient.on('connected', this._onAISConnected.bind(this));

    // disconnected: WebSocket anslutning tappad
    this.aisClient.on('disconnected', this._onAISDisconnected.bind(this));

    // ais-message: Nytt AIS-meddelande mottaget (VIKTIGAST!)
    // Detta är hjärtat av appen - här processas all båtdata
    this.aisClient.on('ais-message', this._onAISMessage.bind(this));

    // B1 (2026-07-03): statiska rapporter (typ 5/24) bär fartygsnamnet men
    // ingen position — mata namncachen och uppdatera ev. levande vessel.
    // Skapar ALDRIG vessel (ingen position att skapa från).
    this.aisClient.on('static-name', this._onStaticName.bind(this));

    // error: WebSocket fel
    this.aisClient.on('error', this._onAISError.bind(this));

    // reconnect-needed: Anslutning tappades, behöver återansluta
    this.aisClient.on('reconnect-needed', this._onAISReconnectNeeded.bind(this));

    // F55: AIS-servern fortfarande onåbar efter många försök (annars tyst loop)
    this.aisClient.on('max-reconnects-reached', this._onAISMaxReconnects.bind(this));

    // F55: server-/auth-fel från AISstream.io (t.ex. ogiltig API-nyckel)
    this.aisClient.on('auth-error', this._onAISAuthError.bind(this));

    // ChatGPT-granskningen 2026-07-10 (D1): icke-auth-serverfel (throttling,
    // odefinierade serverfel) klassificeras nu separat i klienten — får en
    // neutral notistext i stället för det vilseledande nyckelrådet.
    this.aisClient.on('server-error', this._onAISServerError.bind(this));

    this.log('✅ Event handlers configured');
  }

  /**
   * ==========================================================================
   * VESSEL ENTERED HANDLER
   * ==========================================================================
   *
   * SYFTE:
   * Hanterar när en ny båt dyker upp i systemet första gången.
   *
   * FLÖDE:
   * 1. Initiera målbro (beräkna baserat på position och kurs)
   * 2. Analysera initial position och status
   * 3. Trigga boat_near Flow om båt redan har målbro
   * 4. Uppdatera UI
   *
   * @param {Object} param - Event data
   * @param {string} param.mmsi - Båtens MMSI
   * @param {Object} param.vessel - Vessel object
   * @private
   */
  async _onVesselEntered({ mmsi, vessel }) {
    this.debug(`🆕 [VESSEL_ENTERED] New vessel: ${mmsi}`);

    // STEG 1: INITIERA MÅLBRO
    // Beräknar vilken bro båten är på väg mot baserat på position och COG
    await this._initializeTargetBridge(vessel);

    // STEG 2: ANALYSERA INITIAL POSITION
    // Beräknar avstånd till broar och initial status
    await this._analyzeVesselPosition(vessel);

    // STEG 3: TRIGGA BOAT_NEAR FLOW
    // ChatGPT-granskning 2 (CG2-2, 2026-07-11): grinden utökad med
    // trigger-punkterna. Tidigare krävdes targetBridge — en MÅLLÖS
    // förstakontakt inne i Kanalinfartens 300 m-zon (cog utanför
    // riktningsbanden ⇒ target=null) skippades här, och varken updated-vägen
    // (kräver ett ANDRA sample i zonen), skipped-bridges-svepet (fångar bara
    // passerade broar) eller exit-fallbacken (kräver transitbevis) räddade
    // engångschansen ⇒ permanent Kanalinfarten-miss. Kandidatlogiken i
    // _triggerBoatNearFlow filtrerar själv (moored/rörelsebevis/GPS-håll/
    // stale/dedup) — positionsbevisad NÄRHET, ingen gissad passage.
    // MEDVETET SNÄV (SISU-fyndet vid införandet): currentBridge ingår INTE —
    // en ÅTERFÖDD båt intill en just gap-passerad bro ska notifieras av
    // skipped-bridges-fallbacken (STEG 3b), vars riktning kommer ur den
    // positionsbevisade hoppvektorn; en proximity-notis här hade förekommit
    // den med cog-läst 'unknown'-riktning (riktningsfacit-regression).
    const enteredNearTriggerPoint = Number.isFinite(vessel.lat) && Number.isFinite(vessel.lon)
      && Object.values(TRIGGER_POINTS).some((tp) => {
        const d = geometry.calculateDistance(vessel.lat, vessel.lon, tp.lat, tp.lon);
        return d !== null && d <= FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD;
      });
    if (vessel.targetBridge || enteredNearTriggerPoint) {
      await this._triggerBoatNearFlow(vessel);
    }

    // STEG 3b: ANOMALI 13 v2 (2026-05-19) — kör skipped-bridges-fallback även för NEW_VESSEL.
    // Tidigare körde _checkSkippedBridgesFallback bara i _onVesselUpdated → Anomali 13:s
    // NEW_VESSEL-scenario (oldVessel=null) triggade ALDRIG i praktiken.
    // Verifierat 2026-05-19: 230011000 PRIMA VIKING + 265048570 SANUK dök upp norr om
    // Kanalinfartens 300m-zon, fick Olidebron-notis direkt men aldrig Kanalinfarten.
    try {
      await this._checkSkippedBridgesFallback(vessel, null);
    } catch (err) {
      this.error(`[SKIPPED_BRIDGES_CHECK] Error for ${mmsi}:`, err);
    }

    // STEG 4: UPPDATERA UI
    this._updateUI('normal', `vessel-entered-${mmsi}`);
  }

  /**
   * ==========================================================================
   * VESSEL UPDATED HANDLER
   * ==========================================================================
   *
   * SYFTE:
   * Hanterar när en befintlig båt får uppdaterade AIS-data.
   *
   * FLÖDE:
   * 1. Kolla om målbro har ändrats → rensa ETA history
   * 2. Analysera ny position och status
   * 3. Uppdatera UI om något betydelsefullt har ändrats
   *
   * CRASH PROTECTION:
   * Omsluten av try/catch så att ett fel inte stoppar andra vessels
   *
   * @param {Object} param - Event data
   * @param {string} param.mmsi - Båtens MMSI
   * @param {Object} param.vessel - Uppdaterat vessel object
   * @param {Object} param.oldVessel - Tidigare vessel object (för jämförelse)
   * @private
   */
  async _onVesselUpdated({ mmsi, vessel, oldVessel }) {
    try {
      this.debug(`📝 [VESSEL_UPDATED] Vessel: ${mmsi}`);

      // STEG 1: HANTERA MÅLBRO-ÄNDRINGAR
      // Om målbron har ändrats, rensa ETA-historik (gamla ETA-beräkningar är inte längre relevanta)
      if (oldVessel && vessel.targetBridge !== oldVessel.targetBridge) {
        this.statusService.clearVesselETAHistory(
          mmsi,
          `target_bridge_change_${oldVessel.targetBridge || 'none'}_to_${vessel.targetBridge || 'none'}`,
        );

        // BUG 12 FIX B: Avbryt removal-timer vid targetBridge-transition.
        // Om fartyget fått ny targetBridge har det inte avslutat resan.
        if (vessel.targetBridge && this._vesselRemovalTimers.has(mmsi)) {
          clearTimeout(this._vesselRemovalTimers.get(mmsi));
          this._vesselRemovalTimers.delete(mmsi);
          vessel._finalTargetBridge = null;
          this.debug(`🛡️ [REMOVAL_CANCELLED] ${mmsi}: Target changed to ${vessel.targetBridge}, cancelled removal timer`);
        }
      }

      // Anomali 7 fix (2026-05-06): detektera "ny resa" efter U-sväng för
      // båt som tidigare slutfört en resa (t.ex. norrut till Vänern).
      // PRICKBJORN 05-05 06:42 — vände söderut efter Stallbackabron-passage,
      // passerade Stridsbergsbron + Järnvägsbron men dedup-keys från norrut
      // blockerade alla notiser. Bilförare missade hela söderut-resan.
      //
      // Logik: om vessel har targetBridge=null + _finalTargetDirection från
      // tidigare resa + nu rör sig signifikant i motsatt riktning → börja ny
      // resa genom att rensa passedBridges, dedup-keys, _finalTarget*-flaggor.
      // Det tillåter accelerated-target-assignment att tilldela ny målbro.
      //
      // Edge cases hanterade:
      //   - GPS-jump → blockerad av hasGpsJumpHold (Bug #1-skydd)
      //   - Wobble nära mål → kräver sog ≥ 2.0kn (mätbar fart)
      //   - Öster-cog (drift) → kräver cog tydligt N (315-45) eller S (135-314)
      //   - Triggerintegritet → _finalTargetDirection nullas efter rensning
      //     så detta inte triggar igen i nästa tick
      const NEW_JOURNEY_MIN_SOG = 2.0;
      if (!vessel.targetBridge
          && vessel._finalTargetDirection
          && Number.isFinite(vessel.cog)
          && Number.isFinite(vessel.sog)
          && vessel.sog >= NEW_JOURNEY_MIN_SOG
          && !this.vesselDataService?.hasGpsJumpHold?.(vessel.mmsi)) {
        const cogIsNorth = vessel.cog >= 315 || vessel.cog <= 45;
        // Helgranskning 2026-07-10 (A1-1): sydbandet var 135–225 (Anomali 7-
        // originalet) medan _dedupDirection/_getDirectionString harmoniserades
        // till 135–315 redan 2026-07-03 — SV-kurs (226–314°) är NORMAL sydfärd
        // i den NE–SV-orienterade kanalen, inte drift. En båt som vände
        // söderut med t.ex. cog 250° fick aldrig NEW_JOURNEY → dedup-nycklarna
        // från nordresan blockerade returresans alla notiser (PRICKBJORN-
        // klassen, exakt det detta block finns för att förhindra).
        const cogIsSouth = vessel.cog >= 135 && vessel.cog < 315;
        const finalWasNorth = vessel._finalTargetDirection === 'north';
        const newJourneyDetected = (cogIsSouth && finalWasNorth)
          || (cogIsNorth && !finalWasNorth);

        if (newJourneyDetected) {
          const newDir = cogIsNorth ? 'north' : 'south';
          // N6 (2026-07-01): samma 2-observations-debounce som Fix D/Anomali 18.
          // En ENDA COG-wobble ≥2 kn post-TARGET_END fick tidigare hela dedup-
          // minnet att nollas i samma tick som proximityn körde → omedelbar
          // dubblettnotis för bron båten just notifierats för.
          const pending = vessel._newJourneyPending;
          const PENDING_MAX_AGE_MS = 15 * 60 * 1000;
          const pendingConfirmed = pending
            && pending.dir === newDir
            && Number.isFinite(pending.time)
            && (Date.now() - pending.time) < PENDING_MAX_AGE_MS;
          if (!pendingConfirmed) {
            vessel._newJourneyPending = { dir: newDir, time: Date.now() };
            this.debug(
              `⏳ [NEW_JOURNEY_PENDING] ${mmsi}: reversal → ${newDir} observerad `
              + `(cog=${vessel.cog.toFixed(0)}°) — väntar på bekräftelse innan resan nollställs`,
            );
          } else {
            this.log(
              `🔁 [NEW_JOURNEY] ${mmsi}: Direction reversed CONFIRMED from previous journey `
              + `(${vessel._finalTargetDirection} → ${newDir}, sog=${vessel.sog.toFixed(1)}kn) `
              + '— resetting passedBridges + dedup keys for fresh trip',
            );
            vessel.passedBridges = [];
            vessel._finalTargetBridge = null;
            vessel._finalTargetDirection = null;
            vessel._newJourneyPending = null;
            // N6: uppdatera ruttriktningen så direction-token i kommande
            // notiser speglar den NYA resan (inte kvarvarande gamla låset).
            vessel._routeDirection = newDir;
            // Produktionsredo (2026-07-03): tömd passedBridges besegrar
            // B3-vakten — släpp kvarvarande protection så gamla resans bro
            // inte RESTORE:as som target för den nya resan.
            this.vesselDataService.clearTargetProtection?.(mmsi);
            // Rensa dedup-keys så broar i den nya riktningen kan trigga notiser.
            // F34: rensa ÄVEN persistent (clearPersistent=true) — en äkta ny resa
            // ska kunna notifiera samma broar igen även inom 2h-fönstret.
            this._clearBoatNearTriggers(vessel, true);
          }
        } else if (vessel._newJourneyPending) {
          // Inte längre reversed — kortvarig wobble, ingen ny resa.
          vessel._newJourneyPending = null;
        }
      }

      // STEG 2: ANALYSERA POSITION OCH STATUS
      // Beräknar nya avstånd, status, ETA baserat på uppdaterad position
      await this._analyzeVesselPosition(vessel);

      // STEG 2b: TRIGGA FLOW CARDS VID PROXIMITY
      // Anropa vid varje positionsuppdatering — dedup-systemet
      // (_triggeredBoatNearKeys) förhindrar dubbletter per bro automatiskt.
      // Löser problem med snabba fartyg som hoppar över 'waiting'-status.
      //
      // 2026-04-27: tog bort tidigare `vessel.status !== 'passed'` och
      // `!vessel._finalTargetBridge`-blockaden. Den blockerade notiser för
      // intermediate broar (Olidebron) och Kanalinfarten EFTER att vesseln
      // passerat sin sista målbro — södergående båtar fick aldrig
      // Kanalinfarten-notis t.ex. Notis-spam-risken som motiverade blockaden
      // är inte aktuell: dedup-keys per bro garanterar EN notis per bro per
      // resa, och VesselLifecycleManager._isJourneyComplete tar bort vesseln
      // när den faktiskt har lämnat kanalen.
      // Produktionsredo (2026-07-03, CONFIRMED): trigger-points (Kanalinfarten)
      // ligger UTANFÖR brosystemet — en MÅLLÖS båt (återfödd utan target,
      // >500 m från närmaste bro ⇒ ingen currentBridge) nådde aldrig
      // _getFlowTriggerCandidates trigger-point-grenen och exit-notisen
      // missades strukturellt (removal-fallbacken kräver dessutom
      // _finalTargetDirection). Kör proximityn även när båten är inom
      // triggerradien av en trigger-point.
      const nearTriggerPoint = Number.isFinite(vessel.lat) && Number.isFinite(vessel.lon)
        && Object.values(TRIGGER_POINTS).some((tp) => {
          const d = geometry.calculateDistance(vessel.lat, vessel.lon, tp.lat, tp.lon);
          return d !== null && d <= FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD;
        });
      // Fältprov 7 (FP7-3, 2026-07-12, CALIMA): gles Class B-kadens kan kliva
      // rakt ÖVER trigger-punktens 300 m-zon — CALIMA:s sydgående utfart hade
      // sista samplen 330 m NORR resp. 306 m SÖDER om Kanalinfarten medan
      // segmentet passerade 43 m från punkten: hela genomkorsningen låg i
      // gapet och den punktvisa kollen såg aldrig zonen (enda pelare 2-missen
      // i körningen). Segmentsvepet fångar fallet: om sträckan mellan förra
      // och nuvarande sample passerar inom tröskeln flaggas punkten som
      // transient kandidat (fältet lever bara denna tick — vessel-objektet
      // byggs om nästa update). Δlat-kravet skiljer genomkorsning från
      // sidledes drift utanför zonen; dedup-nyckeln garanterar EN notis.
      if (oldVessel
          && Number.isFinite(oldVessel.lat) && Number.isFinite(oldVessel.lon)
          && Number.isFinite(vessel.lat) && Number.isFinite(vessel.lon)) {
        for (const tp of Object.values(TRIGGER_POINTS)) {
          const dNow = geometry.calculateDistance(vessel.lat, vessel.lon, tp.lat, tp.lon);
          const dPrev = geometry.calculateDistance(oldVessel.lat, oldVessel.lon, tp.lat, tp.lon);
          const bothOutside = Number.isFinite(dNow) && Number.isFinite(dPrev)
            && dNow > FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD
            && dPrev > FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD;
          const crossedLatitude = (oldVessel.lat - tp.lat) * (vessel.lat - tp.lat) < 0;
          if (!bothOutside || !crossedLatitude) continue;
          const segDist = geometry.distancePointToSegmentM(
            tp.lat, tp.lon, oldVessel.lat, oldVessel.lon, vessel.lat, vessel.lon,
          );
          if (Number.isFinite(segDist) && segDist <= FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD) {
            vessel._tpSweepCandidate = { name: tp.name, distance: Math.round(segDist) };
            this.log(
              `🧵 [TRIGGER_POINT_SWEEP] ${vessel.mmsi}: segment ${Math.round(dPrev)}m→${Math.round(dNow)}m `
              + `crossed ${tp.name} zone (min ${Math.round(segDist)}m) inside a cadence gap — flagging candidate`,
            );
            break;
          }
        }
      }
      const shouldTriggerProximity = vessel.currentBridge
        || vessel.targetBridge
        || vessel._finalTargetBridge
        || nearTriggerPoint
        || vessel._tpSweepCandidate;
      if (shouldTriggerProximity) {
        await this._triggerBoatNearFlow(vessel);
      }

      // Anomali 9 fix (2026-05-07): kolla om broar har hoppats över via STALE_AIS
      // removal (ny vessel-instans skapad inuti kanalen) eller stora positions-hopp.
      // Persistent dedup (2h) hindrar dubbel-notis.
      try {
        await this._checkSkippedBridgesFallback(vessel, oldVessel);
      } catch (err) {
        this.error(`[SKIPPED_BRIDGES_CHECK] Error for ${mmsi}:`, err);
      }

      // BUG C fix (2026-04-27): fallback-trigger för passage detekterad utan proximity.
      // S/Y ROSE 13:58:17: Klaffbron-passage upptäcktes via trajectory_based_passage
      // efter 8 min Klass B AIS-gap, men inga AIS-uppdateringar inom 300m → ingen
      // trigger sattes och notisen missades helt. Dedup-keys förhindrar dubbletter
      // om bron redan triggat via vanlig proximity.
      // N5 (2026-07-01): jämför namn ELLER tidsstämpel — en andra passage av
      // SAMMA bro (äkta U-sväng, re-passage efter NEW_JOURNEY-reset) stämplar
      // samma namn med ny tid; den gamla namn-jämförelsen missade den och
      // failsafen uteblev. 2000ms-färskheten gatar fortfarande.
      const justRegisteredPassage = vessel.lastPassedBridge
        && Number.isFinite(vessel.lastPassedBridgeTime)
        && Date.now() - vessel.lastPassedBridgeTime < 2000
        && (vessel.lastPassedBridge !== oldVessel?.lastPassedBridge
          || vessel.lastPassedBridgeTime !== oldVessel?.lastPassedBridgeTime);
      if (justRegisteredPassage) {
        await this._triggerBoatNearFlowFallback(vessel, vessel.lastPassedBridge);
      }

      // Backfill-fix (2026-06-13): inferens-vägarna (RC9 missad målbro,
      // RC2b inferred Järnvägsbron vid TARGET_END) registrerar passager som
      // ALDRIG går genom ordinarie detektering — deras notiser måste begäras
      // explicit här. BUG C ovan täcker bara den senast STÄMPLADE passagen.
      // Fallbackens dedupe-/avstånds-/stale-skydd gäller per bro.
      if (Array.isArray(vessel._passageBackfills) && vessel._passageBackfills.length > 0) {
        const backfills = vessel._passageBackfills;
        vessel._passageBackfills = [];
        for (const backfillBridge of backfills) {
          // eslint-disable-next-line no-await-in-loop
          await this._triggerBoatNearFlowFallback(vessel, backfillBridge);
        }
      }

      // STEG 3: UPPDATERA UI OM NÖDVÄNDIGT
      // Intelligent UI-uppdatering som bara sker vid betydelsefulla ändringar
      this._updateUIIfNeeded(vessel, oldVessel);
    } catch (error) {
      // CRASH PROTECTION: Ett fel för en båt ska inte stoppa processning av andra
      this.error(`Error handling vessel update for ${mmsi}:`, error);
      // Fortsätt processa andra vessels
    }
  }

  /**
   * ==========================================================================
   * VESSEL REMOVED HANDLER
   * ==========================================================================
   *
   * SYFTE:
   * Hanterar när en båt tas bort från systemet (timeout eller lämnat området).
   *
   * FLÖDE:
   * 1. Race condition check (förhindra dubbel-borttagning)
   * 2. Rensa alla timers för denna vessel
   * 3. Rensa boat_near triggers och ETA history
   * 4. Uppdatera UI (speciell hantering när sista båt tas bort)
   *
   * RACE CONDITION SKYDD:
   * Använder _processingRemoval Set för att förhindra att samma vessel
   * processas av flera trådar samtidigt.
   *
   * SÄRSKILD HANTERING:
   * När sista båten tas bort (remainingVesselCount === 0):
   * - Tvinga bridge text till standardmeddelande
   * - Avaktivera alarm_generic
   * - Uppdatera global token
   *
   * @param {Object} param - Event data
   * @param {string} param.mmsi - Båtens MMSI
   * @param {Object} param.vessel - Vessel object (kan vara null)
   * @param {string} param.reason - Anledning till borttagning (timeout/passed-final-bridge/etc)
   * @private
   */
  async _onVesselRemoved({ mmsi, vessel, reason }) {
    this.debug(`🗑️ [VESSEL_REMOVED] Vessel: ${mmsi} (${reason})`);
    // Fältprov 3: städa svep-idempotensposten (en per mmsi)
    if (this._skippedBridgesSweepSeen) this._skippedBridgesSweepSeen.delete(String(mmsi));

    // F2-följdfix (körning 2026-07-03, SPIKEN-klassen): minns senaste kända
    // position vid removal. När fartyget återföds behandlas det som "ny båt"
    // och scenario A antog KANALPORT-start — en båt som legat ankrad norr om
    // Stridsbergsbron och avgick fick falska notiser för broar den aldrig
    // korsat (porten-antagandet). Med sista kända positionen begränsas
    // inferensfönstret till [senast kända, nuvarande] — belagd evidens i
    // stället för gissning. TTL i _startMonitoring-loopen.
    if (vessel && Number.isFinite(vessel.lat) && Number.isFinite(vessel.lon)) {
      if (!this._lastKnownPositions) this._lastKnownPositions = new Map();
      // Fältprov 3 (2026-07-08): t = removaltid (TTL-ankaret — fönsterlogiken
      // "broar mellan två kända positioner måste ha korsats" är sund oavsett
      // positionens ålder, och TTL:n på removal råkar även skydda mot
      // SPIKEN-fantomer när båten varit tyst länge FÖRE removal). posT =
      // positionens EGEN tid, för ärlig åldersloggning (ELFKUNGEN 12:54
      // loggades "1 min old" för en 31 min gammal position).
      let posT = Date.now();
      if (Number.isFinite(vessel.lastPositionUpdate)) {
        posT = vessel.lastPositionUpdate;
      } else if (Number.isFinite(vessel.timestamp)) {
        posT = vessel.timestamp;
      }
      this._lastKnownPositions.set(String(mmsi), {
        lat: vessel.lat, lon: vessel.lon, t: Date.now(), posT,
      });
      this._persistLastKnownPositions();
    }

    // RACE CONDITION CHECK: Förhindra dubbel-processning
    if (this._processingRemoval && this._processingRemoval.has(mmsi)) {
      this.debug(`🔒 [RACE_PROTECTION] Vessel ${mmsi} removal already being processed - skipping`);
      return;
    }

    // MARKERA SOM "BEING PROCESSED"
    if (!this._processingRemoval) {
      this._processingRemoval = new Set();
    }
    this._processingRemoval.add(mmsi);

    try {
      // DEBUG: Logga current state för troubleshooting
      const currentVesselCount = this.vesselDataService.getVesselCount();
      this.debug(`🔍 [VESSEL_REMOVAL_DEBUG] Current vessel count: ${currentVesselCount}, removing: ${mmsi}`);
      this.debug(`🔍 [VESSEL_REMOVAL_DEBUG] Current _lastBridgeText: "${this._lastBridgeText}"`);

      // STEG 1: RENSA REMOVAL TIMERS
      // Förhindra att gamla timers försöker ta bort vessel igen
      if (this._vesselRemovalTimers.has(mmsi)) {
        clearTimeout(this._vesselRemovalTimers.get(mmsi));
        this._vesselRemovalTimers.delete(mmsi);
        this.debug(`🧹 [CLEANUP] Cleared removal timer for ${mmsi}`);
      }

      // STEG 2: RENSA BOAT_NEAR TRIGGERS
      // BUG 7 FIX: Bevara dedupnycklar vid timeout om fartyget har aktiv resa.
      // Annars orsakar re-entry inom samma passage en dubblerad trigger.
      const hasActiveJourney = vessel && vessel.passedBridges && vessel.passedBridges.length > 0;
      if (reason === 'timeout' && hasActiveJourney) {
        this.debug(`🛡️ [DEDUP_PRESERVE] ${mmsi}: Keeping trigger dedup keys (active journey, timeout removal)`);
      } else {
        this._clearBoatNearTriggers(vessel || { mmsi });
      }

      // Anomali 10 (2026-05-12): Kanalinfarten exit-fallback för södergående båtar
      // som passerar trigger-point-zonen via långt AIS-glapp (Klass B). Verifierat
      // 2026-05-08 (265037590, 327m) och 2026-05-09 (246140000, 318m) — båda missade
      // notisen via ~20 min AIS-glapp innan COMPLETED_BYPASS. Dedup hanteras i fallback.
      // Fable-granskningen 2026-07-10b (A4-3/P2-4): gaten krävde en AVSLUTAD
      // sydresa (_finalTargetDirection + _finalTargetBridge) — en MÅLLÖS
      // sydgående transitör (MOSHE-/SY FREYJA-klassen: återfödd söder om
      // Klaffbron, target aldrig satt, passager bokförda som intermediate)
      // miste sin Kanalinfarten-notis strukturellt vid removal. Samma
      // inkonsistens som SY FREYJA-fixen tog i svepet (target-gaten bort),
      // kvarlämnad här. Krav för den mållösa vägen: låst sydriktning +
      // MINST EN bokförd bropassage (bevisad kanaltransit — inte en båt som
      // bara dök upp nära utfarten); fallbackens egna radie-/stale-/dedup-
      // gater vaktar resten.
      const completedSouthJourney = vessel
        && vessel._finalTargetDirection === 'south'
        && vessel._finalTargetBridge;
      // R2 2026-07-11 (A1R2-3, ANVÄNDARBESLUT alt. 1): transitbeviset är
      // "bokförd bropassage ELLER avfyrad bro-notis". Skipped-bridges-
      // svepets scenario A (reborn-positionsbevis) NOTIFIERAR utan att
      // bokföra i passedBridges — en båt vars enda transitbevis är
      // återfödelsefönstret nådde annars aldrig exit-anropet trots att
      // gatens intention (bevisad kanaltransit) var uppfylld. Dedup-
      // nycklarna (session — BUG 7-bevarade — och persistent) bär beviset;
      // Kanalinfarten själv räknas inte (det är notisen vi prövar).
      // Bokföringen rörs INTE (bevisprincipen/svepets inferensfrihet är
      // facit-låst design) — endast exit-gatens bevisunderlag breddas.
      const hasNotifiedRealBridge = (() => {
        if (!vessel) return false;
        const prefix = `${vessel.mmsi}:`;
        const isRealBridgeKey = (key) => key.startsWith(prefix) && !key.endsWith(':Kanalinfarten');
        for (const key of this._triggeredBoatNearKeys) {
          if (isRealBridgeKey(key)) return true;
        }
        if (this._persistentRecentTriggers) {
          for (const key of this._persistentRecentTriggers.keys()) {
            if (isRealBridgeKey(key)) return true;
          }
        }
        return false;
      })();
      const targetlessSouthTransit = vessel
        && !vessel._finalTargetDirection
        && vessel._routeDirection === 'south'
        && ((Array.isArray(vessel.passedBridges) && vessel.passedBridges.length > 0)
          || hasNotifiedRealBridge);
      // R2 2026-07-11 (A4R2-3): fantom-exit-vakterna. (a) En OBEKRÄFTAD
      // reversal (_newJourneyPending — finns i snapshotten sedan omgång 1)
      // betyder att sista observationen pekar NORRUT igen: en U-svängd
      // båt som tystnat fick annars exit-notis, och fantomposten
      // {dir:'south'} blockerade den ÄKTA exiten i 2h. (b) Samma motbevis
      // direkt ur sista sampelkursen: entydigt nordlig cog (315–45°) med
      // resenivå-riktningen 'south' är en osedd U-sväng — skippa.
      // Korpusens fyra rådataverifierade äkta exits har cog 212–217 och
      // pending=null — opåverkade.
      const lastCogIsNorth = Number.isFinite(vessel?.cog)
        && (vessel.cog >= 315 || vessel.cog <= 45);
      const exitContraEvidence = Boolean(vessel && (vessel._newJourneyPending || lastCogIsNorth));
      if (exitContraEvidence && (completedSouthJourney || targetlessSouthTransit)) {
        this.log(
          `🚫 [EXIT_TRIGGER_SKIP_REVERSAL] ${mmsi}: sydgaten uppfylld men `
          + `${vessel._newJourneyPending ? 'reversal pending' : `sista kursen nordlig (${Math.round(vessel.cog)}°)`} — ingen exit-notis`,
        );
      }
      if (vessel
          && Number.isFinite(vessel.lat)
          && Number.isFinite(vessel.lon)
          && !exitContraEvidence
          && (completedSouthJourney || targetlessSouthTransit)) {
        try {
          await this._triggerExitPointFallback(vessel);
        } catch (err) {
          this.error(`[EXIT_TRIGGER_FALLBACK] Error for ${mmsi}:`, err);
        }
      }

      // STEG 3: RENSA STATUS STABILIZER HISTORY
      this.statusService.statusStabilizer.removeVessel(mmsi);

      // STEG 4: RENSA ETA HISTORY
      // Ta bort alla sparade ETA-beräkningar för denna vessel
      this.statusService.clearVesselETAHistory(mmsi, `vessel_removed_${reason}`);

      // STEG 4b: RENSA BRIDGE TEXT PHASE TRACKING
      if (this.bridgeTextService) {
        this.bridgeTextService.clearVesselPhaseTracking(mmsi);
      }

      // STEG 5: UPPDATERA UI
      // Helkodsgranskning 2026-07-01 (BT-F1): vessels.delete() sker FÖRE
      // emit('vessel:removed') i VesselDataService.removeVessel, så
      // getVesselCount() ovan är redan antalet EFTER borttagning. Det gamla
      // "- 1" dubbelsubtraherade → när näst sista båten togs bort publicerades
      // "Inga båtar..." fast en båt var kvar mitt i resan (replay-verifierat).
      const remainingVesselCount = currentVesselCount;
      this.debug(`🔍 [VESSEL_REMOVAL_DEBUG] Vessels remaining after removal: ${remainingVesselCount}`);

      // Produktionsredo (2026-07-03, CONFIRMED): P8-vakten gäller även
      // "ansluten men döv" — B2-watchdogens eget motiverade fall (socket uppe,
      // pong svarar, inga AIS-meddelanden på >5 min: tappad subscription/
      // server slutat skicka). Utan detta tvingades DEFAULT ut som sanning
      // när sista båten STALE-timeoutade under ett feedstall, och den falska
      // "Inga båtar"-texten stod tills watchdogen tvingade reconnect
      // (20–120 min efter backoff). Första meddelandet efter återhämtning
      // uppdaterar texten precis som _onAISConnected gör efter disconnect.
      const FEED_SILENT_GUARD_MS = 5 * 60 * 1000;
      let feedSilentMs = null;
      if (this.aisClient && typeof this.aisClient.getConnectionStats === 'function') {
        try {
          const feedStats = this.aisClient.getConnectionStats();
          feedSilentMs = Number.isFinite(feedStats.timeSinceLastMessage)
            ? feedStats.timeSinceLastMessage
            : null;
        } catch (_) { /* stats är best-effort */ }
      }
      const feedIsSilent = feedSilentMs !== null && feedSilentMs > FEED_SILENT_GUARD_MS;

      if (remainingVesselCount === 0 && (!this._isConnected || feedIsSilent)) {
        // P8-fix (2026-06-09): det sista fartyget togs bort MEDAN AIS-strömmen
        // är nere (typiskt STALE_AIS-timeout under ett avbrott). Att då trycka
        // ut DEFAULT ("inga båtar...") är en lögn — vi VET inte att kanalen är
        // tom, vi har bara ingen data. Behåll senaste text; _onAISConnected
        // tvingar en färsk uppdatering så fort strömmen är tillbaka.
        this.log(
          `🛡️ [VESSEL_REMOVAL_STALE_GUARD] Last vessel removed while AIS is ${this._isConnected ? `silent (${Math.round((feedSilentMs || 0) / 1000)}s without messages)` : 'disconnected'} — `
          + 'keeping last bridge text until data returns',
        );
      } else if (remainingVesselCount === 0) {
        // CRITICAL: Force bridge text update to default when no vessels remain
        this.debug('🔄 [VESSEL_REMOVAL_DEBUG] Last vessel removed - forcing bridge text to default');
        // eslint-disable-next-line global-require
        const { BRIDGE_TEXT_CONSTANTS } = require('./lib/constants');
        const defaultMessage = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
        this.debug(`🔄 [VESSEL_REMOVAL_DEBUG] Default message: "${defaultMessage}"`);

        // Force update even if text hasn't "changed" according to comparison
        this._lastBridgeText = defaultMessage;
        // F25: håll hash + timestamp i synk med texten. Den hash-baserade
        // dedupen i _processUIUpdate jämför mot _lastBridgeTextHash; om bara
        // _lastBridgeText sätts här desyncar de, och när samma båt återkommer
        // med exakt samma fras kan dedupen frysa UI:t på DEFAULT.
        this._lastBridgeTextHash = this._hashString(defaultMessage);
        this._lastBridgeTextUpdate = Date.now();
        this._updateDeviceCapability('bridge_text', defaultMessage);
        this.debug(`📱 [UI_UPDATE] FORCED bridge text update to default: "${defaultMessage}"`);

        // Also update global token
        // R2 2026-07-11 (A2R2-2): timeout-säkrad — en hängning här läckte
        // dessutom _processingRemoval (finally nåddes aldrig).
        await this._setGlobalTokenSafe(defaultMessage);

        // Update alarm_generic to false when no boats
        if (this._lastBridgeAlarm !== false) {
          this._lastBridgeAlarm = false;
          this._updateDeviceCapability('alarm_generic', false);
          this.debug('✅ [ALARM_GENERIC] Deactivated - no boats present after removal');
        }
      } else {
        // RACE CONDITION FIX: Defer UI update to prevent accessing removed vessel data
        this.debug(`🔄 [VESSEL_REMOVAL_DEBUG] ${remainingVesselCount} vessels remain - scheduling deferred UI update`);
        setImmediate(() => {
          // Guard (2026-07-01): callbacken kan fyra EFTER onUninit (servicen
          // nullad) eller mot partial-mockar i tester — utan vakten kraschar
          // en ohanterad TypeError hela processen.
          if (!this.vesselDataService || typeof this.vesselDataService.getVessel !== 'function') {
            return;
          }
          // Double-check vessel is still removed before updating UI
          if (!this.vesselDataService.getVessel(mmsi)) {
            this._updateUI('normal', `vessel-removal-${mmsi}`);
          }
        });
      }
    } finally {
      // RACE CONDITION FIX: Always clear processing flag
      if (this._processingRemoval) {
        this._processingRemoval.delete(mmsi);
      }
    }
  }

  /**
   * ==========================================================================
   * VESSEL STATUS CHANGED HANDLER
   * ==========================================================================
   *
   * SYFTE:
   * Hanterar när en båts status ändras (t.ex. approaching → waiting → under-bridge).
   *
   * FLÖDE:
   * 1. Trigga boat_near Flow vid status 'waiting' (300m zon)
   * 2. Rensa triggers när båt lämnar området
   * 3. Hantera final bridge passage (schemalägg removal efter 60s)
   * 4. Uppdatera UI för betydelsefulla status-ändringar
   *
   * STATUS-ÖVERGÅNGAR SOM HANTERAS:
   * - approaching (500m)
   * - waiting (300m) → TRIGGAR FLOW CARDS
   * - under-bridge (50m)
   * - passed → "precis passerat" (60s window)
   * - stallbacka-waiting (Stallbackabron special)
   * - en-route (standard)
   *
   * @param {Object} param - Event data
   * @param {Object} param.vessel - Vessel object
   * @param {string} param.oldStatus - Tidigare status
   * @param {string} param.newStatus - Ny status
   * @param {string} param.reason - Anledning till statusändring
   * @private
   */
  async _onVesselStatusChanged({
    vessel, oldStatus, newStatus, reason,
  }) {
    this.debug(`🔄 [STATUS_CHANGED] Vessel ${vessel.mmsi}: ${oldStatus} → ${newStatus} (${reason})`);

    // STEG 1: TRIGGA FLOW CARDS VID 300M ZON (WAITING STATUS)
    // När båt kommer inom 300m (waiting status) trigga Homey automation
    const shouldTriggerBoatNear = (
      (newStatus === 'waiting' && oldStatus !== 'waiting')
      || (newStatus === 'stallbacka-waiting' && oldStatus !== 'stallbacka-waiting')
    );

    if (shouldTriggerBoatNear) {
      await this._triggerBoatNearFlow(vessel); // Specific bridge trigger
    }

    // STEG 2: RENSA TRIGGERS NÄR BÅT LÄMNAR OMRÅDET
    // BUG 10 FIX: Rensa INTE under aktiv resa (passedBridges). Status-transitionen
    // waiting→en-route sker naturligt vid passage, men ska inte rensa dedup
    // för broar fartyget ännu inte passerat (orsakar dubbla triggers).
    if (oldStatus === 'waiting' || oldStatus === 'approaching' || oldStatus === 'under-bridge' || oldStatus === 'stallbacka-waiting') {
      if (newStatus === 'en-route' || newStatus === 'passed') {
        const hasActiveJourney = vessel.passedBridges && vessel.passedBridges.length > 0;
        if (!hasActiveJourney) {
          this._clearBoatNearTriggers(vessel);
        } else {
          this.debug(`🛡️ [DEDUP_PRESERVE_STATUS] ${vessel.mmsi}: Keeping dedup keys during active journey (${oldStatus}→${newStatus})`);
        }
      }
    }

    // STEG 3: HANTERA FINAL BRIDGE PASSAGE
    // När båt passerat sin sista målbro, schemalägg borttagning
    if (newStatus === 'passed' && vessel.targetBridge) {
      // BUG 1 FIX: Om terminal-bro (Klaffbron/Stridsbergsbron) just passerats,
      // sätt _finalTargetBridge omedelbart — vänta inte på downstream-bekräftelse
      // som kan ta 4+ minuter och orsakar textregression.
      // BUG 12 FIX: Kontrollera riktning — Klaffbron är terminal bara för sydgående,
      // Stridsbergsbron bara för nordgående. Utan detta schemaläggs felaktig borttagning
      // för nordgående fartyg som passerat Klaffbron (som inte är deras sista bro).
      // Helgranskning 2026-07-06 (app-3#1-härdning): föredra riktningslåsen
      // (som syskonen _hasPassedFinalTargetBridge/_calculateNextTargetBridge)
      // och finit-gata rå-cog-fallbacken — null <= 45 gav annars "nord" för
      // okänd kurs. Inert idag (target-transitionen körs uppströms), men
      // raden ska inte vara den enda i familjen som litar blint på momentan cog.
      const lockedDir = vessel._finalTargetDirection || vessel._routeDirection;
      const isNorthbound = lockedDir
        ? lockedDir === 'north'
        : (Number.isFinite(vessel.cog)
          && (vessel.cog >= COG_DIRECTIONS.NORTH_MIN || vessel.cog <= COG_DIRECTIONS.NORTH_MAX));
      const terminalBridge = isNorthbound ? 'Stridsbergsbron' : 'Klaffbron';
      const isTerminalTarget = vessel.targetBridge === terminalBridge
        && vessel.passedBridges?.includes(terminalBridge);
      if (isTerminalTarget && !vessel._finalTargetBridge) {
        vessel._finalTargetBridge = vessel.targetBridge;
        this.debug(`🏁 [EARLY_FINAL_TARGET] ${vessel.mmsi}: Set _finalTargetBridge=${vessel.targetBridge} immediately on passage`);
      }

      if (isTerminalTarget || this._hasPassedFinalTargetBridge(vessel)) {
        this.debug(`🏁 [FINAL_BRIDGE_PASSED] Vessel ${vessel.mmsi} passed final target bridge ${vessel.targetBridge} - scheduling removal (PASSED_HOLD_MS)`);

        // RACE CONDITION FIX: Rensa gammal timer först (atomisk operation)
        if (this._vesselRemovalTimers.has(vessel.mmsi)) {
          clearTimeout(this._vesselRemovalTimers.get(vessel.mmsi));
          this._vesselRemovalTimers.delete(vessel.mmsi);
        }

        // VIKTIGT: "Precis passerat"-meddelandet måste hinna visas hela
        // visningsfönstret (PASSED_HOLD_MS = 150 s / 2,5 min) — därför tas
        // båten bort först efter denna period
        try {
          const timerId = setTimeout(() => {
            // RACE CONDITION CHECK: Förhindra dubbel-borttagning
            if (!this._processingRemoval || !this._processingRemoval.has(vessel.mmsi)) {
              this.vesselDataService.removeVessel(vessel.mmsi, 'passed-final-bridge');
            }
            this._vesselRemovalTimers.delete(vessel.mmsi);
          }, PASSAGE_TIMING.PASSED_HOLD_MS); // 150 s (2,5 min) visningsfönster

          this._vesselRemovalTimers.set(vessel.mmsi, timerId);
        } catch (error) {
          this.error(`[TIMER_ERROR] Failed to set removal timer for vessel ${vessel.mmsi}:`, error);
        }

        // Uppdatera UI omedelbart för att visa "precis passerat" meddelande
        this._updateUI('critical', `vessel-passed-final-${vessel.mmsi}`);
        return;
      }
    }

    // STEG 4: UPPDATERA UI FÖR BETYDELSEFULLA STATUS-ÄNDRINGAR
    // Vissa statusar kräver omedelbar UI-uppdatering
    const significantStatuses = ['approaching', 'waiting', 'under-bridge', 'passed', 'stallbacka-waiting', 'en-route'];

    this.debug(`🔍 [UI_UPDATE_CHECK] ${vessel.mmsi}: newStatus="${newStatus}", oldStatus="${oldStatus}"`);
    this.debug(`🔍 [UI_UPDATE_CHECK] significantStatuses=${JSON.stringify(significantStatuses)}`);
    this.debug(`🔍 [UI_UPDATE_CHECK] newInList=${significantStatuses.includes(newStatus)}, oldInList=${significantStatuses.includes(oldStatus)}`);

    if (significantStatuses.includes(newStatus) || significantStatuses.includes(oldStatus)) {
      // Bestäm prioritet baserat på hur kritisk statusen är
      const criticalStatuses = ['under-bridge', 'passed', 'waiting'];
      const priority = criticalStatuses.includes(newStatus) ? 'critical' : 'normal';
      const reason = `status-change-${oldStatus}-to-${newStatus}`;

      this.debug(`✅ [UI_UPDATE_TRIGGER] ${vessel.mmsi}: Calling _updateUI(${priority}) due to status change ${oldStatus} → ${newStatus}`);
      this._updateUI(priority, reason);
    } else {
      this.debug(`❌ [UI_UPDATE_SKIP] ${vessel.mmsi}: Skipping _updateUI() for status change ${oldStatus} → ${newStatus}`);
    }
  }

  /**
   * ==========================================================================
   * VESSEL POSITION ANALYSIS - KÄRN-LOGIK FÖR POSITION/STATUS
   * ==========================================================================
   *
   * SYFTE:
   * Analyserar en båts position och uppdaterar ALL relaterad data:
   * - Avstånd till broar
   * - Status (approaching/waiting/under-bridge/passed)
   * - GPS-hopp hantering
   * - Bropassage-detektering
   *
   * FLÖDE:
   * 1. Beräkna proximity (avstånd till alla broar)
   * 2. GPS-hopp hantering (om detekterat)
   *    - Sätt GPS jump hold (2s spärrning)
   *    - Aktivera passage gate (blockera falska passager)
   *    - Rensa route history vid stora hopp
   * 3. Bekräfta stable candidate passages (tvåstegs-validering)
   * 4. Analysera och uppdatera status
   * 5. Schedulera cleanup timeout
   *
   * GPS-HOPP HANTERING:
   * När GPS-hopp detekteras aktiveras flera skyddsmekanismer:
   * - PassageLatchService: Förhindrar status-hopp
   * - GPSJumpGateService: Blockerar passage-detektering
   * - RouteOrderValidator: Rensar historik vid stora hopp (>1km)
   *
   * @param {Object} vessel - Vessel object att analysera
   * @private
   */
  async _analyzeVesselPosition(vessel) {
    try {
      // STEG 1: CREATE VESSEL SNAPSHOT
      // CRITICAL FIX: Create shallow copy of vessel state before any modifications
      // This snapshot is needed for passage detection and transition logic
      const oldVessel = {
        targetBridge: vessel.targetBridge,
        lastPassedBridge: vessel.lastPassedBridge,
        lastPassedBridgeTime: vessel.lastPassedBridgeTime,
        lat: vessel.lat,
        lon: vessel.lon,
        sog: vessel.sog,
        cog: vessel.cog,
      };

      // STEG 2: PROXIMITY ANALYSIS
      // Beräkna avstånd till alla broar och hitta närmaste
      const proximityData = this.proximityService.analyzeVesselProximity(vessel);

      // STEG 3 (ändrad 2026-06-13): referensen för STEG 8-återställningen
      // fångas numera EFTER STEG 5 (targetAfterTransitions) så att gate-
      // bekräftade transitioner inte ångras — se kommentaren vid STEG 8.

      // STEG 3: HÄMTA GPS JUMP ANALYSIS DATA
      // Data från VesselDataService om GPS-hopp har detekterats
      const positionAnalysis = {
        gpsJumpDetected: vessel._gpsJumpDetected || false,
        positionUncertain: vessel._positionUncertain || false,
        analysis: vessel._positionAnalysis || null,
      };

      // STEG 4: GPS JUMP HANTERING
      if (positionAnalysis.gpsJumpDetected) {
        // GPS JUMP HOLD: Spärrning i 2 sekunder (förhindrar passage-detektering)
        this.vesselDataService.setGpsJumpHold(vessel.mmsi, 2000);

        // PASSAGE-LATCH: Stabilisera passage-detektion
        if (this.passageLatchService) {
          this.passageLatchService.handleGPSJump(
            vessel.mmsi.toString(),
            positionAnalysis.analysis?.movementDistance || 0,
            vessel,
          );
        }

        // GPS-JUMP GATE: Blockera passage-detektering under GPS-instabilitet
        if (this.gpsJumpGateService) {
          this.gpsJumpGateService.activateGate(
            vessel.mmsi.toString(),
            positionAnalysis.analysis?.movementDistance || 0,
            'gps_jump_detected',
          );
        }

        // ROUTE ORDER VALIDATOR: Rensa historik vid stora GPS-hopp (>1km)
        // Stora hopp gör route order validation oanvändbar
        if (this.routeOrderValidator && positionAnalysis.analysis?.movementDistance > 1000) {
          this.routeOrderValidator.clearVesselHistory(
            vessel.mmsi.toString(),
            `large_gps_jump_${positionAnalysis.analysis?.movementDistance}m`,
          );
        }
      }

      // STEG 5: BEKRÄFTA STABLE CANDIDATE PASSAGES
      // Tvåstegs-validering: Kandidat-passage → Bekräftad passage
      // R2 2026-07-11 (GR2-2): konsumtionen (bekräfta ELLER refutera) körs
      // ALDRIG på en tick som själv är GPS-flaggad — refuteringen konsumerar
      // kandidaten permanent, och en multipath-outlier kunde motbevisa en
      // ÄKTA passage (fysikfönstret ≥2,4 km vid 8 min gör outliern "stabil").
      // Samma gate som ETA-omräkningen haft hela tiden; kandidaterna ligger
      // kvar (TTL:n vaktar) och prövas mot nästa RENA sample.
      const tickIsGpsSuspect = vessel._gpsJumpDetected === true
        || vessel._positionUncertain === true;
      if (this.gpsJumpGateService && !tickIsGpsSuspect) {
        const confirmedPassages = this.gpsJumpGateService.confirmStableCandidates(vessel.mmsi.toString(), vessel);
        let appliedPassages = 0;

        // Processa bekräftade passager
        for (const confirmedPassage of confirmedPassages) {
          // Fable-granskningen 2026-07-10b (G-1): SIDOKONTRAKTET. GJ-1-
          // fysikens tillåtelsefönster växer linjärt med kandidatens ålder
          // medan en FALSK kandidats offset (snapshot = hopp-positionen,
          // båten kvar på äkta sidan) är konstant — varje falsk kandidat
          // "stabiliserades" därför garanterat inom C1:s 20-min-TTL
          // (600 m-hopp @ ~10 min) → falsk målbrotransition + fantomnotis
          // och den ÄKTA passagen dedupades senare bort. En verklig passage
          // lämnar båten på snapshotens sida av brolinjen; ligger hon
          // ENTYDIGT på motsatta sidan är passagen motbevisad — droppa.
          const gateBridge = this.bridgeRegistry?.getBridgeByName?.(confirmedPassage.bridgeName);
          if (gateBridge && confirmedPassage.vesselState
              && geometry.isDecisivelyOppositeBridgeSide(confirmedPassage.vesselState, vessel, gateBridge)) {
            this.log(
              `🚫 [GPS_GATE_REFUTED] ${vessel.mmsi}: ${confirmedPassage.bridgeName}-kandidaten motbevisad `
              + 'av sidokontraktet (båten kvar på pre-passage-sidan — snapshotten var ett GPS-hopp)',
            );
            continue;
          }
          this.debug(`✅ [GPS_GATE_CONFIRMED] ${vessel.mmsi}: Confirmed passage of ${confirmedPassage.bridgeName}`);

          // Hantera bekräftad passage
          if (confirmedPassage.bridgeName === vessel.targetBridge) {
            // MÅLBRO PASSAGE: Trigger transition till nästa målbro
            // CRITICAL FIX: Pass oldVessel snapshot instead of timestamp
            // P6-fix (2026-06-09): confirmedPassage=true → transitionen
            // appliceras direkt utan om-gating. Tidigare körde
            // _handleTargetBridgeTransition om hela passage-detekteringen
            // (gate + cache + linjekorsning) som vid det här laget gav false
            // → transitionen uteblev och bridge_text frös i 2-3 min.
            this.vesselDataService._handleTargetBridgeTransition(
              vessel,
              oldVessel,
              { confirmedPassage: true },
            );
            appliedPassages++;
          } else {
            // MELLANBRO PASSAGE — N8 (2026-07-01): full registrering (ankring,
            // dedup-markering, passedBridges, FIX U, RC9-inferens av missad
            // målbro) i stället för enbart lastPassedBridge-stämpling. Den
            // gamla stämplingen var en degenererad tvilling som lät target
            // fastna BAKOM båten när målbropassagen stördes av GPS-brus.
            this.vesselDataService.registerConfirmedIntermediatePassage(
              vessel, oldVessel, confirmedPassage.bridgeName, confirmedPassage.confirmedAt,
            );
            appliedPassages++;
          }
        }

        // P6-fix: en bekräftad passage bevisar 5s GPS-stabilitet
        // (confirmStableCandidates kräver det) → gaten har gjort sitt och får
        // inte fortsätta blockera nästa passage-detektering.
        // R2 2026-07-11 (GR2-3): räkna endast APPLICERADE passager —
        // refuterade poster är bevisad pågående instabilitet (P6-premissen
        // falsk) och fick inte släcka gaten. Tick där STEG 4 nyss aktiverade
        // gaten träffas inte här (tickIsGpsSuspect-gaten ovan skippar hela
        // konsumtionen på flaggade ticks).
        if (appliedPassages > 0) {
          this.gpsJumpGateService.clearGate(vessel.mmsi.toString());
        }
      }

      // STEG 8-fix (2026-06-13, helkodsgranskningen): om-fånga referensen
      // EFTER STEG 5 — en gate-bekräftad TERMINAL-passage (TARGET_END) nollar
      // targetBridge legitimt, och utan om-fångning skulle STEG 8 nedan
      // "återställa" den passerade målbron → spök-target, text som visar
      // "på väg mot" en redan passerad bro och trasig journey-completion.
      // STEG 8 ska enbart skydda mot att STATUSANALYSEN (STEG 6-7) tappar
      // target — inte ångra avsiktliga transitioner.
      const targetAfterTransitions = vessel.targetBridge;

      // STEG 6: STATUS ANALYSIS
      // Analysera och bestäm status baserat på position och proximity
      const statusResult = this.statusService.analyzeVesselStatus(vessel, proximityData, positionAnalysis);

      // STEG 7: UPPDATERA VESSEL MED RESULTAT
      Object.assign(vessel, statusResult);

      // STEG 8: ÅTERSTÄLL TARGETBRIDGE OM DEN FÖRLORATS
      // CRITICAL FIX: Restore targetBridge if it was lost during status analysis
      if (targetAfterTransitions && !vessel.targetBridge) {
        vessel.targetBridge = targetAfterTransitions;
        this.debug(`🛡️ [TARGET_BRIDGE_PROTECTION] ${vessel.mmsi}: Restored targetBridge: ${targetAfterTransitions}`);
      }

      vessel._distanceToNearest = proximityData.nearestDistance;

      // 6. Calculate ETA for relevant statuses. Includes 'under-bridge' so the
      //    bridge-text clause remains meaningful while a vessel is right at
      //    the bridge. Fix 1: also include 'passed' when targetBridge has been
      //    re-assigned to a NEW bridge after passage (e.g. passed Klaffbron,
      //    target now Stridsbergsbron). Without this, every post-passage
      //    watchdog tick nulls the ETA → "ETA okänd" appears 55× per week.
      const hasOngoingJourney = vessel.targetBridge
        && vessel.targetBridge !== vessel.lastPassedBridge;
      // RC5-fix (2026-06-11): meddelandevägen och snapshot-vägen hade OLIKA
      // staleness-semantik — snapshot-vägen nullar ETA när POSITIONEN är >10
      // min gammal (Fix G, nycklad på lastPositionUpdate som fryses för
      // stillaliggare), medan denna väg räknade om ovillkorligt vid varje
      // mottaget meddelande (fartgolvet fabricerar då t.ex. "105 minuter" för
      // en förtöjd båt 775 m bort). Resultat i förfix-loggen: texten flippade
      // numeric↔"ETA okänd" 21 gånger på en timme. Nu gatas omberäkningen på
      // SAMMA signal: har positionen inte avancerat på >10 min behålls
      // nuvarande värde och snapshot-vägen äger staleness-beslutet (SSOT).
      // F4-E PRÖVAD OCH ÅTERTAGEN HÄR (2026-07-09): max-klockan på just DENNA
      // gate gav korpusbelagd fatal ETA-oscillation (41h: Strids 8→11→9 inom
      // 180 s + 14 extra textövergångar) — stillaliggande glesa sändare fick
      // fartbrusiga omräkningar varje meddelande. Distinktionen som håller:
      // OMRÄKNING kräver positionsFÖRÄNDRING (denna gate, lastPositionUpdate
      // — utan ny position finns inget nytt att beräkna), DEGRADERING kräver
      // uteblivna LIVSTECKEN (max-klockan — ETA_STALE_HARD/IMMINENT/B5/exit).
      // SOKERI-fallet löses av degraderingsgaterna ensamma.
      const positionAgeMs = Date.now() - (vessel.lastPositionUpdate || 0);
      const positionFresh = positionAgeMs <= UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS;
      if (['approaching', 'waiting', 'en-route', 'stallbacka-waiting', 'under-bridge']
        .includes(statusResult.status)
        || (statusResult.status === 'passed' && hasOngoingJourney)) {
        if (positionFresh && vessel._positionUncertain !== true && vessel._gpsJumpDetected !== true) {
          // RC4: clampa även meddelandevägen mot senast publicerade värde —
          // annars läcker sågtänder förbi snapshot-clampen.
          // Echo-gaten (2026-07-02b): GPS-osäkra sampel (S-F4 accept_with_
          // caution, t.ex. en out-of-order-levererad gammal position) får
          // inte driva publicerade ETA-hopp — behåll värdet tills ett rent
          // sampel kommer (se tvillinggaten i _reevaluateVesselStatuses).
          const freshMsgETA = this.statusService.calculateETA(vessel, proximityData);
          vessel.etaMinutes = this._reconcilePublishedETA(vessel, freshMsgETA);
        }
        // else: behåll nuvarande värde — Fix G/HARD-nullify styr presentationen
      } else {
        // 'passed' without ongoing journey (terminal passage) → null is correct
        vessel.etaMinutes = null;
        vessel._etaPublishedValue = null;
      }

      // Bug B fix + RC5: markera färsk position ENDAST när positionen faktiskt
      // avancerat — annars konsumerar nästa snapshot flaggan och räknar om mot
      // frusen position (flip-flop-motorn i förfix-loggen).
      vessel._positionUpdatedSinceLastETA = positionFresh;

      // 7. Schedule appropriate cleanup timeout
      const timeout = this.proximityService.calculateProximityTimeout(vessel, proximityData);
      this.vesselDataService.scheduleCleanup(vessel.mmsi, timeout);

      const etaDisplayText = etaDisplay(vessel.etaMinutes);
      this.debug(
        `🎯 [POSITION_ANALYSIS] ${vessel.mmsi}: status=${vessel.status}, `
        + `distance=${Number.isFinite(proximityData.nearestDistance) ? proximityData.nearestDistance.toFixed(VALIDATION_CONSTANTS.DISTANCE_PRECISION_DIGITS) : 'unknown'}m, ETA=${etaDisplayText}`,
      );

    } catch (error) {
      this.error(`Error analyzing vessel position for ${vessel.mmsi}:`, error);
      // Continue with next vessel - don't crash
    }
  }

  /**
   * Initialize target bridge for vessel
   * @private
   */
  async _initializeTargetBridge(vessel) {
    if (vessel.targetBridge) {
      return; // Already has target bridge
    }

    // CRITICAL FIX: Respect VesselDataService's filtering decision
    // VesselDataService should be the single source of truth for target bridge assignment
    // If vessel doesn't have target bridge, it means VesselDataService filtered it out (e.g., too slow, anchored)
    // Don't override that decision here
    this.debug(`ℹ️ [TARGET_BRIDGE] VesselDataService didn't assign target bridge to ${vessel.mmsi} - respecting that decision`);
  }

  /**
   * Check if vessel has passed its final target bridge
   * @private
   */
  _hasPassedFinalTargetBridge(vessel) {
    if (!vessel || !vessel.passedBridges || vessel.passedBridges.length === 0) {
      return false;
    }

    // Determine final target context
    const finalTarget = vessel._finalTargetBridge || vessel.targetBridge;
    if (!finalTarget) return false;

    // Must have passed the final target itself
    const hasPassedTargetBridge = vessel.passedBridges.includes(finalTarget);
    if (!hasPassedTargetBridge) return false;

    // Resolve travel direction (prefer explicit lock)
    let direction = vessel._finalTargetDirection || null;
    if (!direction && Number.isFinite(vessel.cog)) {
      const northbound = vessel.cog >= COG_DIRECTIONS.NORTH_MIN || vessel.cog <= COG_DIRECTIONS.NORTH_MAX;
      direction = northbound ? 'north' : 'south';
    }
    if (!direction) return false; // Unknown direction → keep vessel

    // Require downstream bridge confirmation before cleanup
    if (direction === 'north') {
      // Northbound journeys must also pass Stallbackabron after Stridsbergsbron
      return vessel.passedBridges.includes('Stallbackabron');
    }

    // Southbound journeys must also pass Olidebron after Klaffbron
    return vessel.passedBridges.includes('Olidebron');
  }

  /**
   * Handle AIS connection established
   * @private
   */
  _onAISConnected() {
    this.log('🌐 [AIS_CONNECTION] Connected to AIS stream');
    this._isConnected = true;
    // Bug #12: clear disconnect timestamp so bridge text resumes normal operation
    this._lastConnectionLost = null;
    this._updateDeviceCapability('connection_status', 'connected');

    // P8-fix (2026-06-09): tvinga en bridge_text-synk efter (åter)anslutning.
    // Under avbrottet kan texten ha frusits (Bug#12-guard) eller hållits kvar
    // av stale-guarden i _onVesselRemoved — utan denna refresh låg den kvar
    // tills nästa fartygshändelse råkade trigga en uppdatering.
    // Guard på _microGraceTimers: vid allra första boot-connect är coalescing-
    // systemet (onInit steg 9) ännu inte initierat — och texten är ändå färsk.
    if (this._microGraceTimers) {
      try {
        this._updateUI('critical', 'ais-reconnected');
      } catch (error) {
        this.error('[AIS_CONNECTION] Post-reconnect UI refresh failed:', error.message || error);
      }
    }
  }

  /**
   * Handle AIS connection lost
   * @private
   */
  _onAISDisconnected(disconnectInfo = {}) {
    const { code = 'unknown', reason = 'unknown' } = disconnectInfo;
    this.log(`🔌 [AIS_CONNECTION] Disconnected from AIS stream: ${code} - ${reason}`);
    this._isConnected = false;
    // Bug #12 + Review fix M2: record disconnect timestamp if not already
    // recorded (boot seed or previous loss). Used by bridge text generation
    // to suppress updates against frozen vessel data after >2 min offline.
    if (!this._lastConnectionLost) {
      this._lastConnectionLost = Date.now();
    }
    this._updateDeviceCapability('connection_status', 'disconnected');
  }

  /**
   * ==========================================================================
   * AIS MESSAGE HANDLER - HJÄRTAT AV APPEN
   * ==========================================================================
   *
   * SYFTE:
   * Tar emot AIS-meddelanden från WebSocket och startar processning.
   * Detta är entry point för all båtdata som kommer in i systemet.
   *
   * FREKVENS:
   * Kallas varje gång ett AIS-meddelande tas emot från AISstream.io
   * (kan vara flera gånger per sekund per båt)
   *
   * @param {Object} aisData - Rå AIS-data från AISstream.io
   * @private
   */
  _onAISMessage(aisData) {
    this._processAISMessage(aisData);
  }

  /**
   * B1 (2026-07-03): namn från statisk AIS-rapport (typ 5/24). Registrerar i
   * namncachen och uppdaterar ett ev. levande vessel-objekt vars namn ännu är
   * "Unknown" — nästa notis/uppdatering använder då det riktiga namnet direkt
   * i stället för att vänta på aisstreams MetaData-backfill (VALEN: 36 min).
   * Skapar aldrig vessel (statiska rapporter saknar position).
   * @param {{mmsi: string, shipName: string}} data
   * @private
   */
  _onStaticName(data) {
    try {
      if (!data || !data.mmsi || !data.shipName) return;
      this._rememberVesselName(data.mmsi, data.shipName);
      const vessel = this.vesselDataService && this.vesselDataService.getVessel
        ? this.vesselDataService.getVessel(String(data.mmsi))
        : null;
      if (vessel && (!vessel.name || vessel.name === 'Unknown')) {
        vessel.name = data.shipName.trim();
        this.debug(`📛 [NAME_CACHE] ${data.mmsi}: live vessel name set from static report: "${vessel.name}"`);
      }
    } catch (error) {
      this.error('[NAME_CACHE] Failed to handle static-name:', error.message || error);
    }
  }

  /**
   * ==========================================================================
   * AIS FEL-HANTERING
   * ==========================================================================
   *
   * SYFTE:
   * Loggar WebSocket-fel från AIS-anslutningen
   *
   * @private
   */
  _onAISError(error) {
    this.error('❌ [AIS_CONNECTION] AIS stream error:', error);
  }

  /**
   * B3-fix (2026-06-09): skicka en Homey-timeline-notis vid anslutnings-/
   * nyckelproblem. Tidigare loggades felen bara — en användare utan
   * loggåtkomst fick aldrig veta att appen stod still (inga notiser, frusen
   * bridge_text). Dedupe: max en notis per 24h så ihållande fel inte spammar
   * timeline (loggarna fortsätter visa varje försök).
   * @param {string} message - Användarvänligt meddelande (visas i timeline)
   * @private
   */
  async _notifyConnectionIssue(message) {
    // ChatGPT-granskningen 2026-07-10 (J1): stämpeln sätts före await som
    // race-vakt, men måste rullas tillbaka om leveransen misslyckas — annars
    // spärrar en ALDRIG levererad notis alla nya försök i 24h (samma
    // F6-rollback-princip som boat_near-triggern).
    const prev = this._lastConnectionIssueNotifiedAt;
    try {
      const DEDUPE_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      if (prev && now - prev < DEDUPE_MS) {
        return;
      }
      if (!this.homey || !this.homey.notifications
          || typeof this.homey.notifications.createNotification !== 'function') {
        return;
      }
      this._lastConnectionIssueNotifiedAt = now;
      await this.homey.notifications.createNotification({ excerpt: message });
    } catch (error) {
      this._lastConnectionIssueNotifiedAt = prev;
      this.error('[AIS_CONNECTION] Failed to create timeline notification:', error.message || error);
    }
  }

  /**
   * F55: AIS-servern är fortfarande onåbar efter alla snabba/medium-försök.
   * Tidigare emittades 'max-reconnects-reached' utan lyssnare → ingen
   * användarsignal vid ihållande nätverks-/nyckelproblem.
   * @private
   */
  _onAISMaxReconnects() {
    this.error(
      '⚠️ [AIS_CONNECTION] AIS-servern är fortfarande onåbar efter många försök. '
      + 'Kontrollera internetanslutningen och att API-nyckeln i appens inställningar är giltig. '
      + 'Appen fortsätter försöka återansluta i bakgrunden.',
    );
    // B3: synliggör för användaren via timeline (deduped till 1/24h)
    this._notifyConnectionIssue(
      'AIS Tracker: kan inte nå AISstream.io. Kontrollera internetanslutningen '
      + 'och API-nyckeln i appens inställningar. Appen fortsätter försöka återansluta.',
    );
  }

  /**
   * F55: server-/auth-fel från AISstream.io (t.ex. ogiltig API-nyckel).
   * @param {*} detail
   * @private
   */
  _onAISAuthError(detail) {
    this.error(
      `❌ [AIS_CONNECTION] Fel från AISstream.io: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}. `
      + 'Kontrollera API-nyckeln i appens inställningar.',
    );
    // B3: synliggör för användaren via timeline (deduped till 1/24h)
    this._notifyConnectionIssue(
      'AIS Tracker: AISstream.io avvisade anslutningen — API-nyckeln är '
      + 'troligen ogiltig. Uppdatera nyckeln i appens inställningar.',
    );
  }

  /**
   * ChatGPT-granskningen 2026-07-10 (D1): serverfel som INTE är nyckel-
   * relaterade (throttling, ogiltigt request-format, odefinierade fel).
   * Klienten river socketen själv (terminate → close → reconnect+backoff),
   * så här behövs bara logg + neutral användarsignal — inte nyckelrådet.
   * @param {*} detail
   * @private
   */
  _onAISServerError(detail) {
    this.error(
      `❌ [AIS_CONNECTION] Serverfel från AISstream.io (ej nyckelrelaterat): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}. `
      + 'Appen återansluter automatiskt.',
    );
    this._notifyConnectionIssue(
      'AIS Tracker: AISstream.io returnerade ett serverfel (t.ex. tillfällig '
      + 'överbelastning). Appen återansluter automatiskt i bakgrunden.',
    );
  }

  /**
   * ==========================================================================
   * AIS ÅTERANSLUTNING
   * ==========================================================================
   *
   * SYFTE:
   * Försöker återansluta till AISstream.io om anslutningen tappas
   *
   * LOGIK:
   * 1. Hämta sparad API-nyckel från Homey settings
   * 2. Om nyckel finns, försök ansluta igen
   * 3. Om anslutning misslyckas, logga fel
   *
   * @private
   */
  _onAISReconnectNeeded() {
    // Försök återansluta med sparad API-nyckel
    const apiKey = this.homey.settings.get('ais_api_key');
    if (apiKey) {
      this.aisClient.connect(apiKey).catch((err) => {
        this.error('Failed to reconnect to AIS stream:', err);
      });
    } else {
      // B3-fix (2026-06-09): tidigare gjorde tom nyckel detta till en tyst
      // evighetsloop — klienten emittade reconnect-needed, vi gjorde inget,
      // användaren fick aldrig veta varför appen stod still.
      this.error('⚠️ [AIS_CONNECTION] Kan inte återansluta — ingen API-nyckel konfigurerad.');
      this._updateDeviceCapability('connection_status', 'disconnected');
      this._notifyConnectionIssue(
        'AIS Tracker: ingen API-nyckel är konfigurerad — appen tar inte emot '
        + 'båtdata. Lägg in din AISstream.io-nyckel i appens inställningar.',
      );
    }
  }

  /**
   * ==========================================================================
   * AIS MESSAGE PROCESSNING - KÄRNLOGIK
   * ==========================================================================
   *
   * SYFTE:
   * Processar ett AIS-meddelande och uppdaterar vessel-data i systemet.
   *
   * FLÖDE:
   * 1. VALIDERA AIS-data (position, hastighet, kurs)
   * 2. NORMALISERA MMSI till string (backend använder strings)
   * 3. UPPDATERA VESSEL i VesselDataService
   *    - Om ny båt → skapar vessel object
   *    - Om befintlig → uppdaterar properties
   *    - Triggar events som andra services lyssnar på
   *
   * VIKTIGA DETALJER:
   * - Hastighetsvärde null bevaras (betyder "okänd") istället för att tvingas till 0
   * - MMSI konverteras alltid till string för konsistens
   * - Crash protection med try/catch (en dålig AIS-meddelande ska inte krascha appen)
   *
   * NÄSTA STEG (sker i VesselDataService):
   * - Beräkna avstånd till broar
   * - Bestäm vessel status
   * - Trigga UI-uppdatering
   *
   * @param {Object} message - AIS-meddelande att processa
   * @param {string|number} message.mmsi - Båtens MMSI-nummer
   * @param {number} message.lat - Latitud
   * @param {number} message.lon - Longitud
   * @param {number} [message.sog] - Speed Over Ground (hastighet i knop)
   * @param {number} [message.cog] - Course Over Ground (kurs i grader)
   * @param {string} [message.shipName] - Båtens namn
   * @private
   */
  _processAISMessage(message) {
    try {
      // STEG 1: VALIDERA AIS-MEDDELANDE
      // Kontrollera att alla required fields är korrekta
      if (!this._validateAISMessage(message)) {
        // Observabilitet (2026-06-11): avvisningar var bara debug-loggade →
        // i SABETH-utredningen gick det inte att skilja "transpondern tyst"
        // från "meddelanden avvisades". Rate-limited info-logg (1/mmsi/5 min).
        const rejMmsi = String(message?.mmsi || 'unknown');
        if (!this._aisRejectLogTimes) this._aisRejectLogTimes = new Map();
        const lastRej = this._aisRejectLogTimes.get(rejMmsi) || 0;
        if (Date.now() - lastRej > 5 * 60 * 1000) {
          this._aisRejectLogTimes.set(rejMmsi, Date.now());
          this.log(
            `🚮 [AIS_VALIDATION_REJECT] ${rejMmsi}: message failed validation `
            + `(lat=${message?.lat}, lon=${message?.lon}, sog=${message?.sog}, cog=${message?.cog})`,
          );
        }
        return; // Ogiltigt meddelande, skippa processning
      }

      // STEG 2: NORMALISERA MMSI TILL STRING
      // Backend använder strings för MMSI (mer flexibelt)
      const mmsiStr = String(message.mmsi);
      const normalizedSog = Number.isFinite(message.sog) ? message.sog : null;
      const normalizedCog = Number.isFinite(message.cog) ? message.cog : null;
      // Förtöjningsdetektering lager 3: AIS-navigationsstatus (Class A).
      // null = okänd/saknas (Class B sänder aldrig fältet).
      const normalizedNavStatus = Number.isInteger(message.navStatus)
        && message.navStatus >= 0 && message.navStatus <= 15
        ? message.navStatus
        : null;
      // B1 (2026-07-03): namncachen ersätter aisstreams "Unknown"-platshållare
      // med senast kända riktiga namn för mmsi:t (överlever omstart). Riktiga
      // namn registreras i cachen; injektionen sker FÖRE vesselPatch så även
      // replay-inspelningen (_captureAISReplaySample) bär det effektiva namnet.
      const rawShipName = (message.shipName || '').trim();
      let effectiveName;
      if (rawShipName && rawShipName !== 'Unknown') {
        effectiveName = rawShipName;
        this._rememberVesselName(mmsiStr, rawShipName);
      } else {
        effectiveName = this._lookupVesselName(mmsiStr) || 'Unknown';
      }
      const vesselPatch = {
        lat: message.lat,
        lon: message.lon,
        // VIKTIGT: Bevara null för okänd hastighet (tvinga inte till 0)
        // null = okänd hastighet, 0 = verklig nollhastighet (stillaliggande)
        sog: normalizedSog,
        cog: normalizedCog,
        navStatus: normalizedNavStatus,
        name: effectiveName,
      };

      this._captureAISReplaySample({
        mmsi: mmsiStr,
        msgType: message.msgType || null,
        lat: vesselPatch.lat,
        lon: vesselPatch.lon,
        sog: vesselPatch.sog,
        cog: vesselPatch.cog,
        shipName: vesselPatch.name,
        aisTimestamp: message.timestamp || null,
        receivedAt: new Date().toISOString(),
      });

      // STEG 3: UPPDATERA VESSEL I DATA SERVICE
      // Detta startar hela kedjan av processning:
      // updateVessel → analyzeProximity → analyzeStatus → updateUI
      const vessel = this.vesselDataService.updateVessel(mmsiStr, vesselPatch);

      if (vessel) {
        this.debug(`📡 [AIS_MESSAGE] Processed message for vessel ${message.mmsi}`);
      }

    } catch (error) {
      // CRASH PROTECTION: Ett felaktigt meddelande ska inte krascha hela appen
      this.error('Error processing AIS message:', error);
      // Fortsätt processa andra meddelanden
    }
  }

  /**
   * Validate AIS message data for completeness and correctness
   * @param {Object} message - AIS message object to validate
   * @param {string|number} message.mmsi - Maritime Mobile Service Identity
   * @param {number} message.lat - Latitude coordinate (-90 to 90)
   * @param {number} message.lon - Longitude coordinate (-180 to 180)
   * @param {number} [message.sog] - Speed over ground in knots (0-100)
   * @param {number} [message.cog] - Course over ground in degrees (0-359)
   * @param {string} [message.shipName] - Name of the vessel
   * @returns {boolean} True if message is valid, false otherwise
   * @private
   */
  _validateAISMessage(message) {
    if (!message || typeof message !== 'object') {
      this.debug('⚠️ [AIS_VALIDATION] Invalid message object');
      return false;
    }

    // CRITICAL FIX: Accept both string and number MMSI with more robust validation
    if (!message.mmsi || (typeof message.mmsi !== 'string' && typeof message.mmsi !== 'number') || String(message.mmsi).trim() === '') {
      this.debug(`⚠️ [AIS_VALIDATION] Missing or invalid MMSI: ${message.mmsi}`);
      return false;
    }

    // CRITICAL FIX: More robust latitude validation with finite check
    if (!Number.isFinite(message.lat) || message.lat < VALIDATION_CONSTANTS.LATITUDE_MIN || message.lat > VALIDATION_CONSTANTS.LATITUDE_MAX) {
      this.debug(`⚠️ [AIS_VALIDATION] Invalid latitude: ${message.lat}`);
      return false;
    }

    // CRITICAL FIX: More robust longitude validation with finite check
    if (!Number.isFinite(message.lon) || message.lon < VALIDATION_CONSTANTS.LONGITUDE_MIN || message.lon > VALIDATION_CONSTANTS.LONGITUDE_MAX) {
      this.debug(`⚠️ [AIS_VALIDATION] Invalid longitude: ${message.lon}`);
      return false;
    }

    // Fuzz-härdning (2026-06-09): spegla klientens 0,0-avvisning (Guineabukten
    // ≈ "GPS saknas"-artefakt, ~6000 km från Trollhättan). AISStreamClient
    // filtrerar redan dessa i _extractAISData, men appnivån ska inte LITA på
    // det — defense-in-depth så att ett framtida klientbyte inte kan släppa
    // in spökfartyg i bridge_text/notiser.
    if (message.lat === 0 && message.lon === 0) {
      this.debug(`⚠️ [AIS_VALIDATION] Rejecting 0,0 coordinates (missing-GPS artefact) for ${message.mmsi}`);
      return false;
    }

    // Produktionsredo (2026-07-03): null är LEGITIMT för sog/cog — AIS-spec
    // tillåter "ej tillgänglig" och AISStreamClient levererar då null.
    // Gamla kontrollen (`!== undefined` + finit-krav) avvisade HELA
    // positionsrapporten: fartyget blev osynligt och notiser missades trots
    // giltig position. Appens dokumenterade kontrakt är "null = okänd fart"
    // — valideringen ska bara avvisa KORRUPTA värden (NaN, negativa, orimliga).
    if (message.sog !== undefined && message.sog !== null) {
      // Helgranskning 2026-07-10 (A2-2): SOG-sentinelen 102.3 ("ej
      // tillgänglig", ITU-R M.1371) normaliseras till null i AISStreamClient,
      // men appnivån ska inte LITA på det (samma försvar-på-djupet-princip
      // som 0,0-garden ovan). Regredierar klientnormaliseringen blev HELA
      // positionsrapporten annars avvisad (102.3 > SOG_MAX) → osynlig båt —
      // exakt osynliga-båtar-incidenten från helgranskningen 2026-07-06.
      // Överfart (> SOG_MAX) tolkas som "fart ej tillgänglig", inte korrupt
      // rapport; positionen är fortfarande giltig. Symmetriskt med COG
      // 360→null nedan.
      if (Number.isFinite(message.sog) && message.sog > VALIDATION_CONSTANTS.SOG_MAX) {
        this.debug(`🔄 [AIS_VALIDATION] SOG ${message.sog} > ${VALIDATION_CONSTANTS.SOG_MAX} = "not available"/korrupt fart → null (position behålls)`);
        message.sog = null;
      } else if (!Number.isFinite(message.sog) || message.sog < 0) {
        this.debug(`⚠️ [AIS_VALIDATION] Invalid SOG: ${message.sog}`);
        return false;
      }
    }

    if (message.cog !== undefined && message.cog !== null) {
      if (!Number.isFinite(message.cog) || message.cog < 0 || message.cog > 360) {
        this.debug(`⚠️ [AIS_VALIDATION] Invalid COG: ${message.cog}`);
        return false;
      }
      // AIS-spec (ITU-R M.1371): giltig COG är 0–359,9° — värdet 360 är
      // sentinelen "kurs ej tillgänglig". Gamla normaliseringen 360→0
      // FABRICERADE en nordkurs som matade riktnings-/mållogiken; rätt
      // tolkning är okänd kurs (null).
      if (message.cog === 360) {
        message.cog = null;
        this.debug('🔄 [AIS_VALIDATION] COG 360° = "not available" → null (okänd kurs)');
      }
    }

    // CRITICAL FIX: Additional validation for ship name
    if (message.shipName !== undefined && typeof message.shipName !== 'string') {
      this.debug(`⚠️ [AIS_VALIDATION] Invalid shipName type: ${typeof message.shipName}`);
      return false;
    }

    return true;
  }

  /**
   * RC4-fix (2026-06-11): dämpa en färsk ETA-beräkning mot det senast
   * PUBLICERADE värdet för samma fartyg+målbro. Kalkylatorns interna
   * monotoniskydd dämpar mot sin egen historik — som divergerar från det
   * användaren ser så fort Fix G-extrapolering varit aktiv. Tillåten delta
   * skalas med glappets längd (en båt KAN ha hunnit ändra läge under ett
   * långt glapp) + en andel av nivån, så äkta förändringar konvergerar på
   * några ticks medan sågtänder (9→4→9→17 i 19h-loggen) klipps.
   * Clampen släpps vid målbrobyte (nytt mål = ny ETA-skala).
   * @param {Object} vessel - Vessel object (muteras: _etaPublishTarget)
   * @param {number|null} freshETA - Nyberäknad ETA
   * @returns {number|null} Publicerbar ETA
   * @private
   */
  _reconcilePublishedETA(vessel, freshETA) {
    // _etaPublishedValue är ett SEPARAT spårfält — vessel.etaMinutes duger
    // inte som referens eftersom meddelandevägen skriver över det innan
    // snapshot-vägen hinner jämföra (då blir clampen en no-op och sågtänder
    // läcker: 19h-replayen visade 3→9 på 10 s via exakt det hålet).
    const published = Number.isFinite(vessel._etaPublishedValue) ? vessel._etaPublishedValue : null;
    const sameTarget = vessel._etaPublishTarget === vessel.targetBridge;
    vessel._etaPublishTarget = vessel.targetBridge;

    if (!Number.isFinite(freshETA) || published === null || !sameTarget
        // I "strax"-bandet (<3 min) släpps clampen: texten är binär där
        // (strax/om N) och ett golv på +3 skulle SKAPA artificiella
        // "om 3 minuter" för båtar som verkligen är strax framme.
        || published < 3) {
      vessel._etaPublishedValue = Number.isFinite(freshETA) ? freshETA : null;
      vessel._etaPublishedAtMs = Date.now();
      // Helkodsgranskning 2026-06-13: nolla även burst-tillståndet i släpp-
      // grenen — annars återanvänder ett clamp-anrop inom 30 s GAMLA målbrons
      // baslinje (burstfälten skrivs bara vid burststart och överlever
      // objektombyggnad) → fel skala efter målbrobyte/demotion+repromotion.
      vessel._etaBurstAtMs = null;
      vessel._etaBurstBase = null;
      vessel._etaBurstGapMin = null;
      return freshETA;
    }

    // Glappet mäts sedan senaste PUBLICERING — det är användarens upplevda
    // förändringstakt som ska begränsas, inte beräkningsintervallet.
    // BURST-skydd: meddelandevägen och snapshot-vägen anropar båda denna
    // metod inom samma sekund — utan fryst baslinje stegar clampen dubbelt
    // per burst (3→6→9 inom 10 s i 19h-replayen). Alla anrop inom 30 s
    // clampar därför mot SAMMA baslinje (värdet vid burstens början).
    const now = Date.now();
    const isNewBurst = !Number.isFinite(vessel._etaBurstAtMs) || (now - vessel._etaBurstAtMs) > 30000;
    if (isNewBurst) {
      const publishedAtMs = Number.isFinite(vessel._etaPublishedAtMs) ? vessel._etaPublishedAtMs : now;
      vessel._etaBurstAtMs = now;
      vessel._etaBurstBase = published;
      vessel._etaBurstGapMin = Math.max(0, (now - publishedAtMs) / 60000);
    }
    const base = Number.isFinite(vessel._etaBurstBase) ? vessel._etaBurstBase : published;
    const gapMin = Number.isFinite(vessel._etaBurstGapMin) ? vessel._etaBurstGapMin : 0;
    const maxDelta = Math.max(3, gapMin + 0.25 * base);
    const delta = freshETA - base;

    let result;
    if (Math.abs(delta) <= maxDelta) {
      result = freshETA;
    } else {
      result = base + Math.sign(delta) * maxDelta;
      this.debug(
        `🪜 [ETA_PUBLISH_CLAMP] ${vessel.mmsi}: fresh ${freshETA.toFixed(1)} vs burst-base `
        + `${base.toFixed(1)} (gap ${gapMin.toFixed(1)} min) → clamped to ${result.toFixed(1)}`,
      );
    }
    vessel._etaPublishedValue = result;
    vessel._etaPublishedAtMs = vessel._etaBurstAtMs;
    return result;
  }

  /**
   * Schedule UI update with micro-grace coalescing
   * @param {string} priority - 'critical' for immediate, 'normal' for coalesced
   * @param {string} reason - Debug reason for this update
   * @private
   */
  _updateUI(priority = 'normal', reason = 'unknown') {
    this._scheduleCoalescedUpdate(priority, reason);
  }

  /**
   * Core coalescing scheduler with intelligent significance detection
   * @private
   */
  _scheduleCoalescedUpdate(priority = 'normal', reason = 'unknown') {
    // Intelligent significance detection
    const significance = this._assessUpdateSignificance(reason, priority);

    if (priority === 'critical' || significance === 'immediate') {
      this.debug(`🚨 [COALESCING] ${priority === 'critical' ? 'Critical' : 'Immediate'} update: ${reason} - bypassing coalescing`);
      this._scheduleImmediatePublish(reason);
      return;
    }

    const bridgeKey = this._determineBridgeKey();
    this.debug(`🔄 [COALESCING] Scheduling coalesced update: ${reason} (lane: ${bridgeKey}, significance: ${significance})`);

    // Dynamic micro-grace period based on significance
    let gracePeriod;
    if (significance === 'high') {
      gracePeriod = 15;
    } else if (significance === 'moderate') {
      gracePeriod = 25;
    } else {
      gracePeriod = 40;
    }

    if (!this._microGraceTimers.has(bridgeKey)) {
      // Start new micro-grace period
      this._microGraceBatches.set(bridgeKey, [{ reason, significance }]);

      const timerId = setTimeout(() => {
        const batch = this._microGraceBatches.get(bridgeKey) || [];
        this.debug(`⏰ [COALESCING] Micro-grace period expired for ${bridgeKey}: ${batch.length} events`);
        this._processMicroGraceBatch(bridgeKey, batch);
      }, gracePeriod);

      this._microGraceTimers.set(bridgeKey, timerId);
    } else {
      // Add to existing batch with significance tracking
      const batch = this._microGraceBatches.get(bridgeKey) || [];
      batch.push({ reason, significance });

      // If high significance event added, reduce remaining grace period
      if (significance === 'high') {
        const existingTimer = this._microGraceTimers.get(bridgeKey);
        clearTimeout(existingTimer);

        const reducedGracePeriod = 10; // Immediate processing for high significance
        const newTimerId = setTimeout(() => {
          const currentBatch = this._microGraceBatches.get(bridgeKey) || [];
          this.debug(`⚡ [COALESCING] High significance event triggered early processing for ${bridgeKey}: ${currentBatch.length} events`);
          this._processMicroGraceBatch(bridgeKey, currentBatch);
        }, reducedGracePeriod);

        this._microGraceTimers.set(bridgeKey, newTimerId);
      }

      this.debug(`📦 [COALESCING] Added to existing batch for ${bridgeKey}: ${batch.length} events total (latest: ${significance})`);
    }
  }

  /**
   * Assess update significance for intelligent coalescing
   * @private
   */
  _assessUpdateSignificance(reason, priority) {
    // Immediate processing triggers
    if (reason.includes('under-bridge') || reason.includes('passed-final')) {
      return 'immediate';
    }

    // High significance patterns - ENHANCED for critical bridge statuses
    if (reason.includes('status-change') && (
      reason.includes('to-waiting')
      || reason.includes('to-under-bridge')
      || reason.includes('to-passed')
      || reason.includes('to-stallbacka-waiting') // CRITICAL: Stallbackabron status changes
    )) {
      return 'high';
    }

    // ENHANCED: Stallbackabron-related updates get high priority
    if (reason.includes('stallbacka') || reason.includes('Stallbackabron')) {
      return 'high';
    }

    if (reason.includes('vessel-removal') || reason.includes('vessel-entered')) {
      return 'high';
    }

    // Moderate significance patterns
    if (reason.includes('status-change') || reason.includes('eta-change')) {
      return 'moderate';
    }

    if (reason.includes('vessel-significant-change') || reason.includes('target-assignment')) {
      return 'moderate';
    }

    // Low significance (default coalescing)
    return 'low';
  }

  /**
   * Actually perform the UI update (with crash protection)
   * @private
   */
  async _actuallyUpdateUI() {
    this.debug('📱 [_actuallyUpdateUI] Starting UI update');

    // PHASE 1: UI SNAPSHOT + MICRO-GRACE SYSTEM
    // Create atomär snapshot of current system state
    const uiSnapshot = this._createUISnapshot();

    // Check if we should apply micro-grace delay
    const shouldApplyMicroGrace = this._shouldApplyMicroGrace(uiSnapshot);

    if (shouldApplyMicroGrace) {
      this.debug('⏱️ [MICRO_GRACE] Applying 200ms micro-grace delay for UI stability');
      await this._sleep(200);
      // Re-snapshot after micro-grace to get most current state
      const refreshedSnapshot = this._createUISnapshot();
      return this._processUIUpdate(refreshedSnapshot);
    }

    return this._processUIUpdate(uiSnapshot);
  }

  /**
   * Create atomic snapshot of UI-relevant system state
   * @private
   */
  _createUISnapshot() {
    try {
      // RACE CONDITION FIX: Filter out vessels that are being removed
      const vesselsBeingRemoved = this._processingRemoval || new Set();
      if (vesselsBeingRemoved.size > 0) {
        this.debug(`🔒 [RACE_PROTECTION] Skipping ${vesselsBeingRemoved.size} vessels being removed: ${Array.from(vesselsBeingRemoved).join(', ')}`);
      }

      // Re-evaluate all vessel statuses for snapshot
      this._reevaluateVesselStatuses();

      // Get vessels relevant for bridge text with removal protection
      const relevantVessels = this._findRelevantBoatsForBridgeText()
        .filter((vessel) => !vesselsBeingRemoved.has(vessel.mmsi));

      return {
        relevantVessels,
        vesselsBeingRemoved,
        timestamp: Date.now(),
        vesselCount: relevantVessels.length,
      };
    } catch (error) {
      this.error('Error creating UI snapshot:', error);
      return {
        relevantVessels: [],
        vesselsBeingRemoved: new Set(),
        timestamp: Date.now(),
        vesselCount: 0,
        error: true,
      };
    }
  }

  /**
   * Determine if micro-grace should be applied based on recent UI changes
   * ENHANCED: Zone transition capture integration
   * @private
   */
  _shouldApplyMicroGrace(snapshot) {
    // Apply micro-grace if:
    // 1. Recent transition from no vessels to vessels (prevents flicker)
    // 2. Significant vessel count change (prevents oscillation)
    // 3. Recent GPS jump activity (provides stability)
    // 4. ENHANCED: Critical zone transitions detected (prioritizes åker strax under/under-bridge)

    const timeSinceLastUpdate = Date.now() - (this._lastBridgeTextUpdate || 0);
    const hasActiveGPSJumps = this._hasActiveGPSJumps();
    const vesselCountChanged = snapshot.vesselCount !== this._lastVesselCount;
    const transitionFromEmpty = (this._lastVesselCount || 0) === 0 && snapshot.vesselCount > 0;
    const transitionToEmpty = (this._lastVesselCount || 0) > 0 && snapshot.vesselCount === 0;

    // ENHANCED: Check for critical zone transitions that need stabilization
    const hasCriticalTransitions = this._hasCriticalZoneTransitions(snapshot.relevantVessels);

    // Don't apply micro-grace if too much time has passed (>5s)
    // EXCEPTION: Allow longer micro-grace for critical transitions (up to 3s hold)
    const timeLimit = hasCriticalTransitions ? 3000 : 5000;
    if (timeSinceLastUpdate > timeLimit) {
      return false;
    }

    // Apply micro-grace for critical transitions
    return transitionFromEmpty || transitionToEmpty || hasActiveGPSJumps
           || hasCriticalTransitions || (vesselCountChanged && timeSinceLastUpdate < 1000);
  }

  /**
   * Check if any vessels have active GPS jump coordination
   * @private
   */
  _hasActiveGPSJumps() {
    try {
      const allVessels = this.vesselDataService.getAllVessels();
      return allVessels.some((vessel) => vessel.lastCoordinationLevel === 'enhanced'
        || vessel.lastCoordinationLevel === 'system_wide');
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if any vessels have active critical zone transitions
   * ENHANCED: Zone transition capture for micro-grace evaluation
   * @private
   */
  _hasCriticalZoneTransitions(vessels) {
    if (!vessels || vessels.length === 0) {
      return false;
    }

    try {
      for (const vessel of vessels) {
        // Helgranskning 2026-07-06 (app-5#1, fältlist-fällans 9:e offer —
        // projektionsvarianten): relevantVessels är BridgeText-projektionen
        // vars fältlista saknar _criticalTransitionHoldUntil/_zoneTransitions
        // (de sätts av StatusService på de RIKTIGA fartygsobjekten). Läst på
        // projektionen var båda kontrollerna alltid falska → kritisk-
        // övergångstermen i micro-grace var död. Slå upp det levande objektet.
        const liveVessel = this.vesselDataService?.getVessel?.(vessel.mmsi) || vessel;

        // Check for active critical transition holds (stallbacka-waiting, under-bridge)
        if (this.statusService.hasActiveCriticalTransition(liveVessel)) {
          this.debug(`🔥 [CRITICAL_TRANSITION_DETECTED] ${vessel.mmsi}: Active critical transition detected for micro-grace`);
          return true;
        }

        // Check for high-priority recent transitions
        const highestTransition = this.statusService.getHighestPriorityTransition(liveVessel);
        if (highestTransition && highestTransition.isCritical) {
          this.debug(`⚡ [PRIORITY_TRANSITION_DETECTED] ${vessel.mmsi}: Critical transition to ${highestTransition.status} detected for micro-grace`);
          return true;
        }
      }

      return false;
    } catch (error) {
      this.debug(`⚠️ [CRITICAL_TRANSITION_CHECK_ERROR] Error checking critical transitions: ${error.message}`);
      return false;
    }
  }

  /**
   * Process UI update with atomic snapshot
   * @private
   */
  async _processUIUpdate(snapshot) {
    try {
      this.debug(`📱 [SNAPSHOT_PROCESS] Processing UI update with ${snapshot.vesselCount} vessels`);

      // Produktionsredo (2026-07-03): en FEL-snapshot (error:true — snapshot-
      // vägen kastade) har en TOM vessellista som inte betyder "kanalen är
      // tom" utan "vi vet inte". Att fortsätta publicerade falsk "Inga
      // båtar"-text trots aktiva fartyg. Behåll senaste text; nästa lyckade
      // snapshot uppdaterar.
      if (snapshot.error === true) {
        this.log('🛡️ [SNAPSHOT_ERROR_GUARD] UI snapshot failed — keeping last bridge text');
        return { success: false, error: 'snapshot_error' };
      }

      // Use snapshot data (already filtered and processed)
      const { relevantVessels, vesselsBeingRemoved } = snapshot;
      this.debug(`📱 [SNAPSHOT_PROCESS] Found ${relevantVessels.length} relevant vessels (filtered ${vesselsBeingRemoved.size} being removed)`);

      // Store vessel count for next micro-grace evaluation
      this._lastVesselCount = relevantVessels.length;

      // Generate bridge text with BULLETPROOF error handling
      let bridgeText;
      try {
        bridgeText = this.bridgeTextService.generateBridgeText(relevantVessels);
        this.debug(`📱 [_actuallyUpdateUI] Generated bridge text: "${bridgeText}"`);

        // SAFETY: Ensure we always have a valid string
        if (!bridgeText || typeof bridgeText !== 'string' || bridgeText.trim() === '') {
          this.error('[BRIDGE_TEXT] Generated empty or invalid bridge text, using fallback');
          bridgeText = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
        }

        // F29: en ensam båt som råkar ut för en kort GPS-jump-hold filtreras bort
        // av BridgeTextService (hasGpsJumpHold) → texten flippar till DEFAULT
        // ("Inga båtar...") mitt i en resa, för att komma tillbaka ~2s senare.
        // Om resultatet blev DEFAULT MEN det finns minst en relevant båt med
        // giltig targetBridge som just nu är GPS-hållen, behåll förra texten i
        // stället för att blinka tomt (samma intention som micro-grace).
        if (bridgeText === BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE
            && this._lastBridgeText
            && this._lastBridgeText !== BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE
            // Helgranskning 2026-07-06 (app-4#1): återpublicera ALDRIG
            // frånkopplingstexten — samma BT-F5-undantag som validerings-
            // fallbacken (rad ~2730). Utan detta kunde F29 visa "AIS-
            // anslutning saknas" i ~2 s EFTER lyckad återanslutning när den
            // enda båten var kortvarigt GPS-hållen.
            && this._lastBridgeText !== STALE_DATA_OVERRIDE_TEXT
            && Array.isArray(relevantVessels)
            && this.vesselDataService
            && typeof this.vesselDataService.hasGpsJumpHold === 'function') {
          const hasHeldActiveVessel = relevantVessels.some((v) => v
            && TARGET_BRIDGES.includes(v.targetBridge)
            && this.vesselDataService.hasGpsJumpHold(v.mmsi));
          if (hasHeldActiveVessel) {
            this.debug('🛡️ [GPS_HOLD_UI] Behåller förra texten — aktiv båt är kortvarigt GPS-hållen (undviker DEFAULT-flimmer)');
            bridgeText = this._lastBridgeText;
          }
        }

        // FÄLTPROV 2026-07-07 (IMPERATOR 17:18, BALTIC JONGLEUR 20:46 —
        // två oberoende granskarfynd, samma klass): terminal-målbropassage
        // (TARGET_END) nollar targetBridge medan båten fortfarande är UNDER
        // bron → BUG 11-fönstret håller henne i listan men textmotorn
        // renderar inte targetlösa → texten föll från "…strax" till "Inga
        // båtar" MITT I broöppningen. Behåll senaste texten under passed-
        // fönstret vid en MÅLBRO (samma hold-mönster som F29 ovan; samma
        // 150 s som visningsfönstret PASSED_HOLD_MS). Släpper automatiskt:
        // nästa renderbara båt ger ny text, annars faller texten till
        // DEFAULT när fönstret löpt ut.
        if (bridgeText === BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE
            && this._lastBridgeText
            && this._lastBridgeText !== BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE
            && this._lastBridgeText !== STALE_DATA_OVERRIDE_TEXT
            && Array.isArray(relevantVessels)) {
          const recentTargetPassage = relevantVessels.some((v) => v
            && v.lastPassedBridge
            && TARGET_BRIDGES.includes(v.lastPassedBridge)
            && Number.isFinite(v.lastPassedBridgeTime)
            && (Date.now() - v.lastPassedBridgeTime) < PASSAGE_TIMING.PASSED_HOLD_MS);
          if (recentTargetPassage) {
            this.debug('🌉 [PASSED_HOLD_UI] Behåller förra texten — båt i passed-fönstret vid målbro (broöppningen pågår; undviker falskt "Inga båtar")');
            bridgeText = this._lastBridgeText;
          }
        }
      } catch (bridgeTextError) {
        this.error('[BRIDGE_TEXT] CRITICAL ERROR during bridge text generation:', bridgeTextError);
        // Use last known good text or default
        bridgeText = this._lastBridgeText || BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
        this.debug(`📱 [_actuallyUpdateUI] Using fallback bridge text: "${bridgeText}"`);
      }

      // ENHANCED: Summary validation and sanity checks
      const validationResult = this._validateBridgeTextSummary(bridgeText, relevantVessels, snapshot);
      if (!validationResult.isValid) {
        // Observabilitet (2026-06-11): valideringsfall var debug-loggade →
        // i flertrafik-scenarier degraderades texten utan spår i prodloggen.
        // Detta ÄR en anomalisignal (textmotorn producerade något validatorn
        // underkände) — error-nivå med orsak gör den diagnosbar.
        this.error(
          `⚠️ [SUMMARY_VALIDATION] Bridge text failed validation: ${validationResult.reason} `
          + `(text="${bridgeText}")`,
        );
        if (validationResult.shouldUseFallback) {
          bridgeText = validationResult.fallbackText || this._lastBridgeText || BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
          this.error(`🔄 [SUMMARY_FALLBACK] Using validated fallback: "${bridgeText}"`);
        }
      } else {
        this.debug('✅ [SUMMARY_VALIDATION] Bridge text passed all sanity checks');
      }

      // R2 2026-07-11 (A2R2-3/P1R2-4 — 2 oberoende): SSOT-spegel av
      // removal-vägens VESSEL_REMOVAL_STALE_GUARD. En läknings-/heal-cykel
      // vid 0 båtar kunde annars publicera "Inga båtar…" som sanning mitt
      // i ett "ansluten-men-döv"-feedstall (tyst prenumerationstapp, >5 min
      // utan meddelanden) eller kort avbrott — exakt P8-lögnen som removal-
      // vägen medvetet undviker. Behåll senaste texten tills data är
      // tillbaka (_onAISConnected/första meddelandet tvingar färsk cykel).
      if (bridgeText === BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE
          && relevantVessels.length === 0
          && this._lastBridgeText
          && this._lastBridgeText !== BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE
          && this._lastBridgeText !== STALE_DATA_OVERRIDE_TEXT) {
        let feedSilentMs = null;
        if (this.aisClient && typeof this.aisClient.getConnectionStats === 'function') {
          try {
            const feedStats = this.aisClient.getConnectionStats();
            feedSilentMs = Number.isFinite(feedStats.timeSinceLastMessage)
              ? feedStats.timeSinceLastMessage
              : null;
          } catch (_) { /* stats är best-effort */ }
        }
        const feedIsSilent = feedSilentMs !== null && feedSilentMs > 5 * 60 * 1000;
        if (!this._isConnected || feedIsSilent) {
          this.log(
            `🛡️ [UI_FEED_STALE_GUARD] 0 båtar men AIS är ${this._isConnected ? `döv (${Math.round((feedSilentMs || 0) / 1000)}s utan meddelanden)` : 'frånkopplad'} — behåller senaste texten`,
          );
          bridgeText = this._lastBridgeText;
        }
      }

      // Bug #12 fix: after AIS has been disconnected for >2 minutes, stop
      // showing cached bridge text against frozen vessel data. The watchdog
      // (every 30s) would otherwise keep rebroadcasting stale "En båt på väg
      // mot..." messages even though no new position updates are arriving.
      if (!this._isConnected && this._lastConnectionLost) {
        const disconnectedMs = Date.now() - this._lastConnectionLost;
        if (disconnectedMs > 2 * 60 * 1000) {
          const overrideText = STALE_DATA_OVERRIDE_TEXT;
          if (bridgeText !== overrideText) {
            this.debug(`🔌 [STALE_DATA_GUARD] AIS disconnected ${Math.round(disconnectedMs / 1000)}s — suppressing bridge text`);
          }
          bridgeText = overrideText;
        }
      }

      // ENHANCED: Update devices with atomic change detection and dedupe
      const bridgeTextHash = this._hashString(bridgeText);
      this.debug(`📱 [SNAPSHOT_PROCESS] Comparing: new="${bridgeText}" (hash: ${bridgeTextHash}) vs last="${this._lastBridgeText}" (hash: ${this._lastBridgeTextHash})`);

      // CRITICAL FIX: Use hash-based dedupe for exact change detection
      const timeSinceLastUpdate = Date.now() - (this._lastBridgeTextUpdate || 0);
      const hasPassedVessels = relevantVessels.some((vessel) => vessel.status === 'passed');
      // ChatGPT-granskning 2 (CG2-15, 2026-07-11): 32-bitshashen har äkta
      // kollisioner (1197 buckets i den realistiska textrymden) — en kollision
      // gjorde att ny text tyst behölls gammal. OR-termen jämför strängen och
      // kan bara LÄGGA TILL skrivningar; hash-ledet bevaras eftersom
      // null-sentinelen (hash=null, sträng kvar) måste fortsätta tvinga
      // omskrivning av SAMMA text efter timeout/fel.
      const textActuallyChanged = bridgeTextHash !== this._lastBridgeTextHash
        || bridgeText !== this._lastBridgeText;

      // Force update every minute if vessels present, but never when "passed" vessels exist
      const forceUpdateDueToTime = timeSinceLastUpdate > 60000 && relevantVessels.length > 0 && !hasPassedVessels;

      if (textActuallyChanged || forceUpdateDueToTime) {
        if (forceUpdateDueToTime && !textActuallyChanged) {
          this.debug('⏰ [SNAPSHOT_PROCESS] Forcing update due to time passage (ETA changes)');
        }
        if (hasPassedVessels && timeSinceLastUpdate > 60000 && !textActuallyChanged) {
          this.debug('🚫 [PASSAGE_DUPLICATION] Prevented force update of "passed" vessels message - would create duplicate');
        }
        this.debug('✅ [SNAPSHOT_PROCESS] Bridge text changed - updating devices');
        this._lastBridgeText = bridgeText;
        this._lastBridgeTextHash = bridgeTextHash;
        this._lastBridgeTextUpdate = Date.now();
        this._updateDeviceCapability('bridge_text', bridgeText);

        // CRITICAL FIX: Also update global token for flows
        // R2 2026-07-11 (A2R2-2/P1R2-1): timeout-säkrad — se _setGlobalTokenSafe.
        await this._setGlobalTokenSafe(bridgeText);

        // RC6-fix (2026-06-11): skilj ÄKTA textändring från periodisk
        // tvångsomskrivning — 128 av 231 "updated"-rader i 19h-loggen var
        // oförändrad text, vilket gör loggen/summaryn oanvändbar som
        // ändringshistorik. [UI_UPDATE] = texten ÄNDRADES; [UI_REFRESH] =
        // samma text omskriven (keepalive). Summary-verktyg filtrerar på tagg.
        if (textActuallyChanged) {
          this.log(`📱 [UI_UPDATE] Bridge text updated: "${bridgeText}"`);
        } else {
          this.log(`🔁 [UI_REFRESH] Bridge text refreshed (unchanged): "${bridgeText}"`);
        }
        // Reset unchanged aggregation window on change
        this._unchangedCount = 0;
        this._unchangedWindowStart = Date.now();

        // Record successful update for micro-grace system
        this._lastSuccessfulUpdate = {
          timestamp: Date.now(),
          bridgeText,
          vesselCount: relevantVessels.length,
        };
      } else {
        // Aggregate unchanged logs to reduce noise
        this._unchangedCount = (this._unchangedCount || 0) + 1;
        if (!this._unchangedWindowStart) this._unchangedWindowStart = Date.now();
        const elapsed = Date.now() - this._unchangedWindowStart;
        if (elapsed >= 60000) {
          this.debug(`📱 [UI_UPDATE] Bridge text unchanged x${this._unchangedCount} (last 60s)`);
          this._unchangedCount = 0;
          this._unchangedWindowStart = Date.now();
        }
      }

      // Update connection status only if changed
      const currentConnectionStatus = this._isConnected ? 'connected' : 'disconnected';
      if (currentConnectionStatus !== this._lastConnectionStatus) {
        this._lastConnectionStatus = currentConnectionStatus;
        this._updateDeviceCapability('connection_status', currentConnectionStatus);
        this.debug(`🌐 [CONNECTION_STATUS] Changed to: ${currentConnectionStatus}`);
      }

      // ENHANCED: Update alarm_generic - should match bridge text state
      // With improved generation, default text should only appear when no relevant vessels exist
      // C8 (2026-07-01): när stale-data-guarden har ersatt texten med
      // "AIS-anslutning saknas" är fartygsdatan frusen — larmet ska då vara
      // AV, inte fortsätta lysa i upp till 28 min på spökdata (texten och
      // larmet sa tidigare emot varandra under långa avbrott).
      const staleGuardActive = bridgeText === STALE_DATA_OVERRIDE_TEXT;
      // Helgranskning 2026-07-06 (app-4#2): larmet speglar TEXTEN, inte
      // rålistan. relevantVessels innehåller orenderbara båtar (targetBridge
      // nyss nollad, BUG 11-fönstret) → larmet kunde lysa i upp till 180 s
      // medan texten sa "Inga båtar". alarm ⇔ text är den enda kombination
      // som aldrig säger emot sig själv i användarens panel.
      const hasActiveBoats = bridgeText !== BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE && !staleGuardActive;

      // Bug #4 fix: harmonize filtering with BridgeTextService. The service filters
      // vessels by TARGET_BRIDGES.includes(targetBridge) (BridgeTextService.js:80).
      // relevantVessels may include vessels whose targetBridge was just cleared by
      // a JOURNEY_COMPLETED transition — those are expected to yield DEFAULT_MESSAGE
      // and are NOT bugs. Only alert when vessels with a valid target bridge are
      // present but default text still results.
      // Helgranskning 2026-07-10 (A2-1): spegla även GPS-hold-filtret —
      // BridgeTextService OCH count-validatorn (BT-F2) exkluderar båda
      // hasGpsJumpHold-fartyg, så en ensam GPS-hållen målbåt ger legitimt
      // DEFAULT-text. Utan filtret lyste error-larmet falskt i exakt det
      // fallet (error-kanalen ska bara bära äkta anomalier).
      const visibleVessels = relevantVessels.filter(
        (v) => v && TARGET_BRIDGES.includes(v.targetBridge)
          && !(this.vesselDataService
            && typeof this.vesselDataService.hasGpsJumpHold === 'function'
            && this.vesselDataService.hasGpsJumpHold(v.mmsi)),
      );
      if (visibleVessels.length > 0 && bridgeText === BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE) {
        this.error(`🚨 [BRIDGE_TEXT_BUG] ${visibleVessels.length} visible vessels but got default text - this indicates a bug in bridge text generation`);
      }

      // Only update alarm_generic capability if value has changed
      if (hasActiveBoats !== this._lastBridgeAlarm) {
        this._lastBridgeAlarm = hasActiveBoats;
        this._updateDeviceCapability('alarm_generic', hasActiveBoats);

        if (hasActiveBoats) {
          this.debug(`🚨 [ALARM_GENERIC] Activated - boats present: "${bridgeText}"`);
        } else {
          this.debug('✅ [ALARM_GENERIC] Deactivated - no boats present');
        }
      }

      return { success: true, bridgeText, vesselCount: relevantVessels.length };

    } catch (error) {
      this.error('Error processing UI update:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate simple hash for string comparison (dedupe)
   * @private
   */
  _hashString(str) {
    if (!str) return 0;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      // eslint-disable-next-line no-bitwise
      hash = ((hash << 5) - hash) + char;
      // eslint-disable-next-line no-bitwise
      hash &= hash; // Convert to 32-bit integer
    }
    return hash;
  }

  /**
   * Sleep utility for micro-grace delays
   * @private
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Validate bridge text summary against actual vessel states
   * ENHANCED: Summary generation sanity checks
   * @param {string} bridgeText - Generated bridge text
   * @param {Array} relevantVessels - Vessels used for generation
   * @param {Object} snapshot - UI snapshot data
   * @returns {Object} Validation result
   * @private
   */
  _validateBridgeTextSummary(bridgeText, relevantVessels, snapshot) {
    const validationResult = {
      isValid: true,
      reason: null,
      shouldUseFallback: false,
      fallbackText: null,
      checks: [],
    };

    try {
      // CHECK 1: Vessel count consistency
      const vesselCountCheck = this._validateVesselCounts(bridgeText, relevantVessels);
      validationResult.checks.push(vesselCountCheck);
      if (!vesselCountCheck.passed && vesselCountCheck.severity === 'critical') {
        validationResult.isValid = false;
        validationResult.reason = `Vessel count mismatch: ${vesselCountCheck.issue}`;
      }

      // CHECK 2: Status-distance consistency
      const statusConsistencyCheck = this._validateStatusConsistency(relevantVessels);
      validationResult.checks.push(statusConsistencyCheck);
      if (!statusConsistencyCheck.passed && statusConsistencyCheck.severity === 'critical') {
        validationResult.isValid = false;
        validationResult.reason = validationResult.reason
          ? `${validationResult.reason}; Status inconsistency: ${statusConsistencyCheck.issue}`
          : `Status inconsistency: ${statusConsistencyCheck.issue}`;
      }

      // CHECK 3: ETA sanity validation
      const etaSanityCheck = this._validateETASanity(relevantVessels);
      validationResult.checks.push(etaSanityCheck);
      if (!etaSanityCheck.passed && etaSanityCheck.severity === 'warning') {
        // ETA issues are warnings, not critical failures
        this.debug(`⚠️ [ETA_SANITY] ${etaSanityCheck.issue}`);
      }

      // CHECK 4: Bridge text format validation
      const formatCheck = this._validateBridgeTextFormat(bridgeText, relevantVessels);
      validationResult.checks.push(formatCheck);
      if (!formatCheck.passed && formatCheck.severity === 'critical') {
        validationResult.isValid = false;
        validationResult.reason = validationResult.reason
          ? `${validationResult.reason}; Format error: ${formatCheck.issue}`
          : `Format error: ${formatCheck.issue}`;
      }

      // CHECK 5: Snapshot consistency validation
      const snapshotCheck = this._validateSnapshotConsistency(bridgeText, relevantVessels, snapshot);
      validationResult.checks.push(snapshotCheck);
      if (!snapshotCheck.passed && snapshotCheck.severity === 'critical') {
        validationResult.isValid = false;
        validationResult.reason = validationResult.reason
          ? `${validationResult.reason}; Snapshot inconsistency: ${snapshotCheck.issue}`
          : `Snapshot inconsistency: ${snapshotCheck.issue}`;
      }

      // Determine fallback strategy
      if (!validationResult.isValid) {
        const hasMinorIssues = validationResult.checks.some((check) => !check.passed && check.severity === 'minor');
        const failedCritical = validationResult.checks.filter((check) => !check.passed && check.severity === 'critical');
        const hasCriticalIssues = failedCritical.length > 0;

        // RC-B-fix (2026-06-11): count-mismatchen är i praktiken en TRANSIENT
        // en-ticks-divergens vid passagemoment (textens klausulfiltrering ≠
        // rålistan — 19h-loggen: #108 08:04:56, #209 16:28:51). Att då ersätta
        // en nästan-korrekt detaljerad text med generiska "N båtar är i
        // närheten av broarna" är en SÄMRE lögn än att behålla föregående
        // text som är sekunder gammal. Endast när count-checken är den ENDA
        // kritiska missen och en färsk föregående text finns → behåll den;
        // alla andra kritiska fel degraderar som tidigare.
        const onlyCountFailed = failedCritical.length === 1
          && failedCritical[0].issue && failedCritical[0].issue.includes('vessels provided');
        if (hasCriticalIssues && onlyCountFailed
            && this._lastBridgeText
            && this._lastBridgeText !== BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE
            // BT-F5 (2026-07-01): återpublicera ALDRIG frånkopplingstexten
            // som fallback efter reconnect — den är per definition inaktuell.
            && this._lastBridgeText !== STALE_DATA_OVERRIDE_TEXT) {
          validationResult.shouldUseFallback = true;
          validationResult.fallbackText = this._lastBridgeText;
        } else if (hasCriticalIssues) {
          validationResult.shouldUseFallback = true;
          validationResult.fallbackText = this._generateSafeFallbackText(relevantVessels, bridgeText);
        } else if (hasMinorIssues && this._lastBridgeText) {
          // For minor issues, keep using last known good text
          validationResult.shouldUseFallback = true;
          validationResult.fallbackText = this._lastBridgeText;
        }
      }

      return validationResult;
    } catch (error) {
      this.error(`[SUMMARY_VALIDATION] Error during validation: ${error.message}`);
      return {
        isValid: false,
        reason: `validation_error: ${error.message}`,
        shouldUseFallback: true,
        fallbackText: this._lastBridgeText || BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE,
        checks: [],
      };
    }
  }

  /**
   * Validate vessel counts mentioned in bridge text match actual data
   * @private
   */
  _validateVesselCounts(bridgeText, vessels) {
    const vesselCounts = this._extractVesselCounts(bridgeText);
    // BT-F2 (2026-07-01): räkna endast fartyg som textmotorn KAN rendera.
    // getVesselsForBridgeText inkluderar avsiktligt fartyg i 180s-passage-
    // fönstret med targetBridge=null (BUG 11) som BridgeTextService filtrerar
    // bort — att räkna dem gav falsk "critical" count-mismatch vid varje
    // passagemoment, och RC-B-fallbacken återpublicerade då en INAKTUELL text
    // (replay-verifierat: "på väg mot Klaffbron, strax" i 60 s EFTER passagen).
    // Filtret speglar BridgeTextService:s eget.
    const renderable = (vessels || []).filter((v) => {
      if (!v || !v.mmsi) return false;
      if (this.vesselDataService
          && typeof this.vesselDataService.hasGpsJumpHold === 'function'
          && this.vesselDataService.hasGpsJumpHold(v.mmsi)) {
        return false;
      }
      return TARGET_BRIDGES.includes(v.targetBridge);
    });
    const actualCount = renderable.length;

    // Calculate expected total based on bridge text patterns
    let expectedTotal = 0;
    if (vesselCounts.totalMentioned > 0) {
      expectedTotal = vesselCounts.totalMentioned;
    } else if (vesselCounts.implicitCount > 0) {
      expectedTotal = vesselCounts.implicitCount;
    }

    if (expectedTotal > 0 && Math.abs(expectedTotal - actualCount) > 1) {
      return {
        passed: false,
        severity: 'critical',
        issue: `Bridge text mentions ${expectedTotal} vessels but ${actualCount} vessels provided`,
        details: { bridgeText, expectedTotal, actualCount },
      };
    }

    return {
      passed: true,
      severity: 'info',
      issue: null,
      details: { expectedTotal, actualCount },
    };
  }

  /**
   * Validate vessel statuses are consistent with their distances to bridges
   * @private
   */
  _validateStatusConsistency(vessels) {
    const inconsistencies = [];

    for (const vessel of vessels) {
      if (!vessel || !vessel.mmsi) continue;

      // RC-B2-fix (2026-06-11, hittad av syntetiska scenariosviten): de gamla
      // reglerna jämförde 'under-bridge' mot MÅLBRONS avstånd/ETA — men en båt
      // under en MELLANBRO (Olidebron/Järnvägsbron/Stallbackabron) har
      // legitimt målbron 1-2 km bort och mål-ETA 5-15 min. Falsklarmen gav
      // critical → fallback → count-degradering i flertrafik ("3 båtar är i
      // närheten av broarna"). Reglerna dömer nu mot verkligheten:
      //  1. under-bridge ⇒ nära NÄRMASTE bro (vilken som helst)
      //  2. under-bridge + stor ETA flaggas bara när bron man är under ÄR målbron
      //  3. passed + ETA flaggas bara för TERMINAL passage (ingen pågående resa)
      let nearestDist = Infinity;
      let distToTarget = Infinity;
      for (const bridge of Object.values(this.bridgeRegistry.bridges)) {
        if (!bridge || !Number.isFinite(bridge.lat)) continue;
        const d = geometry.calculateDistance(vessel.lat, vessel.lon, bridge.lat, bridge.lon);
        if (Number.isFinite(d)) {
          if (d < nearestDist) nearestDist = d;
          if (bridge.name === vessel.targetBridge) distToTarget = d;
        }
      }

      if (vessel.status === 'under-bridge' && Number.isFinite(nearestDist) && nearestDist > 100) {
        inconsistencies.push(`${vessel.mmsi} status='under-bridge' but ${nearestDist.toFixed(0)}m from nearest bridge`);
      }

      if (vessel.etaMinutes !== null && vessel.etaMinutes !== undefined) {
        const underTargetBridge = vessel.status === 'under-bridge' && distToTarget <= 100;
        if (underTargetBridge && vessel.etaMinutes > 1) {
          inconsistencies.push(`${vessel.mmsi} status='under-bridge' at target but ETA=${vessel.etaMinutes.toFixed(1)}min`);
        }
        const ongoingJourney = vessel.targetBridge && vessel.targetBridge !== vessel.lastPassedBridge;
        if (vessel.status === 'passed' && !ongoingJourney && vessel.etaMinutes > 0) {
          inconsistencies.push(`${vessel.mmsi} status='passed' (terminal) but ETA=${vessel.etaMinutes.toFixed(1)}min`);
        }
      }
    }

    return {
      passed: inconsistencies.length === 0,
      severity: inconsistencies.length > 2 ? 'critical' : 'warning',
      issue: inconsistencies.length > 0 ? inconsistencies.join('; ') : null,
      details: { inconsistencyCount: inconsistencies.length, inconsistencies },
    };
  }

  /**
   * Validate ETA values are reasonable and consistent
   * @private
   */
  _validateETASanity(vessels) {
    const issues = [];

    for (const vessel of vessels) {
      if (!vessel || !vessel.mmsi) continue;

      if (vessel.etaMinutes !== null && vessel.etaMinutes !== undefined) {
        // Check for unreasonable ETA values
        if (vessel.etaMinutes < 0) {
          issues.push(`${vessel.mmsi} has negative ETA: ${vessel.etaMinutes}min`);
        }
        if (vessel.etaMinutes > 200) { // More than ~3 hours
          issues.push(`${vessel.mmsi} has excessive ETA: ${vessel.etaMinutes.toFixed(1)}min`);
        }
        if (!Number.isFinite(vessel.etaMinutes)) {
          issues.push(`${vessel.mmsi} has invalid ETA: ${vessel.etaMinutes}`);
        }
      }
    }

    return {
      passed: issues.length === 0,
      severity: issues.length > 3 ? 'critical' : 'warning',
      issue: issues.length > 0 ? issues.join('; ') : null,
      details: { issueCount: issues.length, issues },
    };
  }

  /**
   * Validate bridge text format matches expected patterns
   * @private
   */
  _validateBridgeTextFormat(bridgeText, vessels) {
    // Basic format checks
    if (typeof bridgeText !== 'string') {
      return {
        passed: false,
        severity: 'critical',
        issue: `Bridge text is not a string: ${typeof bridgeText}`,
        details: { bridgeText, type: typeof bridgeText },
      };
    }

    // Check for suspicious patterns
    const suspiciousPatterns = [
      /undefined/i,
      /null/i,
      /NaN/i,
      /\[object Object\]/i,
      /\{\}/,
      /^\s*$/,
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(bridgeText)) {
        return {
          passed: false,
          severity: 'critical',
          issue: `Bridge text contains suspicious pattern: ${pattern}`,
          details: { bridgeText, pattern: pattern.toString() },
        };
      }
    }

    return {
      passed: true,
      severity: 'info',
      issue: null,
      details: { length: bridgeText.length },
    };
  }

  /**
   * Validate snapshot data is consistent with generated text
   * @private
   */
  _validateSnapshotConsistency(bridgeText, vessels, snapshot) {
    if (!snapshot) {
      return {
        passed: false,
        severity: 'warning',
        issue: 'No snapshot data provided',
        details: {},
      };
    }

    // Vessel count consistency
    if (vessels.length !== snapshot.vesselCount) {
      return {
        passed: false,
        severity: 'critical',
        issue: `Vessel count mismatch: vessels.length=${vessels.length} vs snapshot.vesselCount=${snapshot.vesselCount}`,
        details: { vesselLength: vessels.length, snapshotCount: snapshot.vesselCount },
      };
    }

    // Check for vessels being removed during processing
    if (snapshot.vesselsBeingRemoved && snapshot.vesselsBeingRemoved.size > 0) {
      const removingVessels = Array.from(snapshot.vesselsBeingRemoved);
      const mentionsRemovedVessels = removingVessels.some((mmsi) => bridgeText.includes(mmsi.toString()));

      if (mentionsRemovedVessels) {
        return {
          passed: false,
          severity: 'warning',
          issue: `Bridge text mentions vessels being removed: ${removingVessels.join(', ')}`,
          details: { removingVessels, bridgeText },
        };
      }
    }

    return {
      passed: true,
      severity: 'info',
      issue: null,
      details: { snapshotAge: Date.now() - snapshot.timestamp },
    };
  }

  /**
   * Extract vessel counts mentioned in bridge text
   * @private
   */
  _extractVesselCounts(bridgeText) {
    const counts = {
      totalMentioned: 0,
      implicitCount: 0,
    };

    if (typeof bridgeText !== 'string' || bridgeText.length === 0) {
      return counts;
    }

    // F16: Variant-1 skriver räkneordet som svenskt ordtal ("En/Två/.../Tio")
    // för 1-10 och som siffra för >10. Den gamla regexen matchade BARA siffror
    // (/(\d+)\s*(båt|vessel)/) och underkände därför korrekt flerbåtstext
    // (t.ex. "En båt ...; Tre båtar ...") som kritisk count-mismatch →
    // degraderad fallback "N båtar är i närheten". Räkna nu både ordtal och
    // siffror som står omedelbart före "båt"/"båtar" och summera dem.
    const WORD_TO_NUM = {
      en: 1,
      två: 2,
      tva: 2,
      tre: 3,
      fyra: 4,
      fem: 5,
      sex: 6,
      sju: 7,
      åtta: 8,
      atta: 8,
      nio: 9,
      tio: 10,
    };
    // BT-F6 (2026-07-01): inledande \b fungerar inte före "åtta"/"Åtta" —
    // "å" är inte \w i JS-regex, så ordgränsen uteblir och åtta-grupper
    // räknades aldrig. Kräv radstart eller whitespace i stället.
    const groupRe = /(?:^|\s)(\d+|en|två|tva|tre|fyra|fem|sex|sju|åtta|atta|nio|tio)\s+(?:båt|båtar)\b/gi;
    let match = groupRe.exec(bridgeText);
    while (match !== null) {
      const token = match[1].toLowerCase();
      const num = /^\d+$/.test(token) ? parseInt(token, 10) : WORD_TO_NUM[token];
      if (num && num > 0) {
        counts.totalMentioned += num;
      }
      match = groupRe.exec(bridgeText);
    }

    // Bakåtkompatibilitet: legacy "ytterligare X båtar"-fras (gamla fas-modellen).
    const additionalMatches = bridgeText.match(/ytterligare\s*(\d+)/gi);
    if (additionalMatches) {
      for (const m of additionalMatches) {
        const num = parseInt(m.match(/\d+/)[0], 10);
        if (num && num > 0) {
          counts.implicitCount += num;
        }
      }
    }

    return counts;
  }

  /**
   * Generate safe fallback text when validation fails
   * @param {Array} vessels
   * @param {string|null} [failedBridgeText] - the primary output that just
   *   failed validation; used to detect identical re-emit.
   * @private
   */
  _generateSafeFallbackText(vessels, failedBridgeText = null) {
    if (!vessels || vessels.length === 0) {
      return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
    }

    // Bug #7 fix + Review fix H3: prefer BridgeTextService's variant-1 output
    // when all input vessels pass a strict sanity check. We must NOT re-call
    // BridgeTextService with the same vessel set that just produced a
    // validation failure — that would re-emit the same bad output.
    // Strict prerequisites: vessel has a valid targetBridge, a finite ETA (or
    // null, meaning "strax" is acceptable), a usable mmsi, and is not
    // currently marked as on gps-hold (mirrors BridgeTextService's internal
    // filter so the re-call actually sees a different vessel set). If any
    // vessel fails, fall through to the descriptive fallback below. As a
    // final safety net, if the re-call still produces the exact text that
    // just failed validation, fall through rather than shipping it.
    // R2 2026-07-11 (A3R2-3): TVÅ mängder. `renderable` speglar EXAKT
    // textmotorns filter (target + ej GPS-hold) och äger räkning/DEFAULT/
    // representant — sanitized-predikatets extra ETA-gate gjorde annars
    // alla-ETA-ogiltiga (renderbara!) båtar till falsk "Inga båtar…".
    // `sanitizedVessels` (renderable + giltig ETA) används enbart för
    // variant1-omkallet, vars poäng är ett STRIKTARE urval än det som föll.
    const renderableVessels = vessels.filter((v) => {
      if (!v || !v.mmsi) return false;
      if (!TARGET_BRIDGES.includes(v.targetBridge)) return false;
      // BT-F4 (2026-07-01): hold-status finns INTE som fält på projektionen
      // (v.hasGpsJumpHold var alltid undefined → filtret dött) — fråga
      // tjänsten, precis som BridgeTextService gör.
      if (this.vesselDataService
          && typeof this.vesselDataService.hasGpsJumpHold === 'function'
          && this.vesselDataService.hasGpsJumpHold(v.mmsi)) {
        return false;
      }
      return true;
    });
    const sanitizedVessels = renderableVessels.filter((v) => !(v.etaMinutes != null
      && !(Number.isFinite(v.etaMinutes) && v.etaMinutes >= 0)));
    try {
      const vesselSetChanged = sanitizedVessels.length !== vessels.length;
      if (sanitizedVessels.length > 0 && this.bridgeTextService && vesselSetChanged) {
        const variant1 = this.bridgeTextService.generateBridgeText(sanitizedVessels);
        if (variant1
            && variant1 !== BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE
            && variant1 !== failedBridgeText) {
          return variant1;
        }
      }
    } catch (error) {
      // Fall through to legacy descriptive fallback on any error
      this.debug(`[FALLBACK_PRIMARY_FAIL] Using descriptive fallback: ${error.message}`);
    }

    // Fable-granskningen 2026-07-10b (P1-4): den beskrivande grenen räknade
    // RÅLISTAN (inkl. BUG 11-fönstrets mållösa och GPS-hållna som textmotorn
    // avsiktligt exkluderar) — när ALLA var orenderbara ersatte "N båtar är i
    // närheten av broarna" en KORREKT "Inga båtar…"-text (antalslögn + larm
    // som motsäger texten). Räkna och representera samma mängd som motorn
    // (R2/A3R2-3: renderable, INTE ETA-gatade sanitized).
    if (renderableVessels.length === 0) {
      return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
    }
    const vesselCount = renderableVessels.length;
    // Helgranskning 2026-07-10 (T-3): representanten är båten med lägst
    // giltig ETA (samma ledarprincip som huvudmotorn) — vessels[0] kunde
    // vara en godtycklig/avlägsnare båt med distans/ETA som motsade texten
    // användaren nyss såg.
    const firstVessel = renderableVessels.reduce((best, v) => {
      if (!v) return best;
      const bestEta = best && Number.isFinite(best.etaMinutes) ? best.etaMinutes : Infinity;
      const vEta = Number.isFinite(v.etaMinutes) ? v.etaMinutes : Infinity;
      return vEta < bestEta ? v : best;
    }, renderableVessels[0]);
    // Helgranskning 2026-07-10 (T-1): fallbacken fick ALDRIG säga mellanbro-
    // namn, men `currentBridge` är närmaste registerbro inom 400 m — dvs.
    // även Olidebron/Järnvägsbron/Stallbackabron. Kontraktet
    // (bridgeTextFormat.md: "Mellanbroar nämns aldrig i texten") gäller även
    // den degraderade vägen. Bronamn i fallbacktext begränsas därför till
    // målbroarna; distansen räknas mot just den bro som nämns (currentBridge
    // när den ÄR målbro, annars geometriskt mot targetBridge) så text och
    // meter aldrig pekar på olika broar.
    const currentIsTarget = TARGET_BRIDGES.includes(firstVessel.currentBridge);
    const targetName = TARGET_BRIDGES.includes(firstVessel.targetBridge)
      ? firstVessel.targetBridge
      : null;
    const bridge = currentIsTarget ? firstVessel.currentBridge : targetName;
    let dist = null;
    if (currentIsTarget) {
      dist = firstVessel.distanceToCurrent ?? firstVessel.distance;
    } else if (targetName && Number.isFinite(firstVessel.lat) && Number.isFinite(firstVessel.lon)) {
      const targetObj = this.bridgeRegistry?.getBridgeByName?.(targetName);
      if (targetObj && Number.isFinite(targetObj.lat) && Number.isFinite(targetObj.lon)) {
        dist = geometry.calculateDistance(
          firstVessel.lat, firstVessel.lon, targetObj.lat, targetObj.lon,
        );
      }
    }

    // BUG 5 FIX: Include direction and ETA when available for more informative fallback
    let dirSuffix = '';
    if (firstVessel._routeDirection) {
      dirSuffix = firstVessel._routeDirection.startsWith('north') ? ' (nordgående)' : ' (sydgående)';
    }
    // Review fix H2: route ETA clause through SSOT helper so descriptive
    // fallback can never emit "om 106 minuter" for a near-stationary vessel.
    // Produktionsredo (2026-07-03, CONFIRMED): skicka med extrapolated/
    // imminent-optionerna — utan dem kunde nödfallbacken visa hårt "strax"
    // för en extrapolerad gissning (SSOT-hjälparen säger "cirka 2 minuter"
    // för extrapolerade värden i strax-bandet). Hjälparen returnerar
    // 'ETA okänd' / 'strax' / 'om (cirka) N minuter'.
    // Fable-granskningen 2026-07-10b (A3-3): truthiness-gaten (etaMinutes
    // null/0 → ingen klausul alls) gjorde imminent-"strax" och "ETA okänd"
    // onåbara — exakt kombinationen etaMinutes=null + imminent=true sätts av
    // uttömd extrapolering, och huvudmotorn visar då "strax". Anropa
    // hjälparen även när ETA saknas men imminent är satt.
    const hasEtaClause = Number.isFinite(firstVessel.etaMinutes)
      || firstVessel._isImminentAtTargetBridge === true;
    const etaSuffix = hasEtaClause
      ? `, ${formatETABroOpeningClause(firstVessel.etaMinutes, {
        extrapolated: firstVessel._etaIsExtrapolated === true,
        imminent: firstVessel._isImminentAtTargetBridge === true,
      })}`
      : '';

    if (vesselCount === 1) {
      if (bridge && Number.isFinite(dist)) {
        return `En båt ${Math.round(dist)}m från ${bridge}${dirSuffix}${etaSuffix}`;
      }
      return `En båt är i närheten av ${bridge || 'broarna'}${dirSuffix}`;
    }

    // Flerfartyg: inkludera bronamn om alla mot samma MÅLBRO (T-1: aldrig
    // mellanbro — currentBridge deltar inte i namnvalet).
    // R2 2026-07-11 (A3R2-2): mappa RÄKNADE mängden — en exkluderad båt med
    // annan målbro tvingade annars "broarna" fast alla räknade delar bro.
    const bridges = [...new Set(renderableVessels
      .map((v) => (v && TARGET_BRIDGES.includes(v.targetBridge) ? v.targetBridge : null))
      .filter(Boolean))];
    if (bridges.length === 1) {
      return `${vesselCount} båtar är i närheten av ${bridges[0]}`;
    }
    return `${vesselCount} båtar är i närheten av broarna`;
  }

  /**
   * Determine bridge key for per-bro lane coalescing
   * @private
   */
  _determineBridgeKey() {
    try {
      const vessels = this.vesselDataService.getAllVessels();
      const activeTargets = new Set(vessels
        .filter((v) => v && v.targetBridge)
        .map((v) => v.targetBridge));

      // Use global lane if multiple target bridges or no specific targets
      if (activeTargets.size === 0) return 'global';
      if (activeTargets.size > 1) return 'global'; // Mixed-bridge scenario

      // Single target bridge - use specific lane
      return Array.from(activeTargets)[0];
    } catch (error) {
      this.error('Error determining bridge key:', error);
      return 'global';
    }
  }

  /**
   * Schedule immediate publish for critical updates
   * @private
   */
  _scheduleImmediatePublish(reason) {
    // B7b (körning 2026-07-03, F12): samla omedelbara publiceringar i ett
    // kort leading-edge-fönster (150 ms). Två passage-händelser i samma tick
    // (t.ex. OLIVIER Strids+Jvb 07:49:57) publicerade annars var sin text
    // med ett halvfärdigt mellanläge synligt för användaren ("Två båtar"→
    // "En båt" i samma sekund). Första händelsen startar fönstret;
    // efterföljande ansluter till batchen. Versionen sätts vid AVFYR så
    // publiceringsordningen förblir monoton. Max-latens 150 ms — omärkbart.
    if (!this._immediatePublishReasons) this._immediatePublishReasons = [];
    this._immediatePublishReasons.push(reason);
    if (this._immediatePublishTimer) {
      this.debug(`⚡ [IMMEDIATE] Joining pending immediate batch: ${reason} (${this._immediatePublishReasons.length} events)`);
      return;
    }
    this._immediatePublishTimer = setTimeout(() => {
      this._immediatePublishTimer = null;
      const reasons = this._immediatePublishReasons;
      this._immediatePublishReasons = [];
      const bridgeKey = this._determineBridgeKey();
      const version = ++this._updateVersion;
      this.debug(`⚡ [IMMEDIATE] Publishing immediate batch: ${reasons.join(', ')} (v${version}, lane: ${bridgeKey})`);
      this._publishUpdate(version, bridgeKey, reasons);
    }, 150);
  }

  /**
   * Process micro-grace batch after timer expires
   * @private
   */
  _processMicroGraceBatch(bridgeKey, batch) {
    try {
      // Clear timer state
      this._microGraceTimers.delete(bridgeKey);
      this._microGraceBatches.delete(bridgeKey);

      if (batch.length === 0) return;

      const version = ++this._updateVersion;

      // Extract reasons for logging (handle both old string format and new object format)
      const reasons = batch.map((item) => (typeof item === 'string' ? item : item.reason));
      const significances = batch.map((item) => (typeof item === 'string' ? 'unknown' : item.significance));
      let highestSignificance;
      if (significances.includes('immediate')) {
        highestSignificance = 'immediate';
      } else if (significances.includes('high')) {
        highestSignificance = 'high';
      } else if (significances.includes('moderate')) {
        highestSignificance = 'moderate';
      } else {
        highestSignificance = 'low';
      }

      if (batch.length === 1) {
        this.debug(`📝 [SINGLE_EVENT] Processing single event: ${reasons[0]} (${highestSignificance}) (v${version}, lane: ${bridgeKey})`);
      } else {
        this.debug(`📦 [BATCH] Processing ${batch.length} coalesced events (${highestSignificance}): ${reasons.join(', ')} (v${version}, lane: ${bridgeKey})`);
      }

      this._publishUpdate(version, bridgeKey, reasons);
    } catch (error) {
      this.error(`Error processing micro-grace batch for ${bridgeKey}:`, error);
    }
  }

  /**
   * Publish update with version tracking and in-flight protection
   * @private
   */
  async _publishUpdate(version, bridgeKey, reasons) {
    try {
      // Check for stale version
      if (version !== this._updateVersion) {
        this.debug(`⏭️ [STALE] Skipping stale update v${version} (current: v${this._updateVersion})`);
        return;
      }

      // Check for in-flight update
      // ChatGPT-granskning 2 (CG2-4, 2026-07-11): vakten är GLOBAL, inte
      // per-bridgeKey. bridge_text/global token/alarm_generic är alla globala
      // enskilda utdata — vid 1→0-båtsövergången fick ett gammalt in-flight-
      // pass ('Klaffbron') och ett nytt ('global') olika nycklar, interleavade,
      // och det äldre passet skrev token=ACTIVE + alarm=true EFTER det nyare
      // DEFAULT-passet. Alla felsentineler var normala → watchdog-osynligt
      // stale-läge tills nästa båt. Global serialisering gör att hela
      // transaktionen (text+token+larm) alltid speglar SAMMA snapshot.
      if (this._inFlightUpdates.size > 0) {
        this.debug(`✋ [IN_FLIGHT] Update in progress - scheduling rerun (blocked key: ${bridgeKey})`);
        this._rerunNeeded.add(bridgeKey);
        return;
      }

      // Mark as in-flight
      this._inFlightUpdates.add(bridgeKey);

      try {
        // Generate fresh bridge text from current state (never merge strings)
        await this._actuallyUpdateUI();

        // Check if we need to rerun due to events during update
        // CG2-4: kolla HELA setten — ett blockerat pass kan bära en annan
        // bridgeKey än den in-flight (t.ex. 'global' mot 'Klaffbron');
        // per-nyckel-kollen tappade det passets uppdatering tills nästa
        // externa händelse. En rerun genererar från aktuellt tillstånd och
        // täcker alla väntande nycklar på en gång.
        if (this._rerunNeeded.size > 0) {
          this._rerunNeeded.clear();
          this.debug('🔄 [RERUN] Scheduling rerun due to events during update');

          // Schedule rerun with new version
          setImmediate(() => {
            this._publishUpdate(++this._updateVersion, this._determineBridgeKey(), ['rerun-after-inflight']);
          });
        }
      } finally {
        // Always clear in-flight flag
        this._inFlightUpdates.delete(bridgeKey);
      }
    } catch (error) {
      this.error(`Error in publish update v${version} for ${bridgeKey}:`, error);
      this._inFlightUpdates.delete(bridgeKey); // Clean up on error
    }
  }

  /**
   * Re-evaluate all vessel statuses (critical for time-sensitive updates)
   * @private
   */
  _reevaluateVesselStatuses() {
    const allVessels = this.vesselDataService.getAllVessels();

    allVessels.forEach((vessel) => {
      try {
        // CRITICAL FIX: Validate vessel object before processing
        if (!vessel || !vessel.mmsi || !Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
          // Helgranskning 2026-07-10 (T-2): nollställ imminent-flaggan innan
          // hoppet — resten av loopen (inkl. den ordinarie reset-then-set-
          // sekvensen längre ned) körs aldrig för det här fartyget, så en
          // kvarhängande true från förra ticket kunde annars driva falskt
          // "strax" i texten för en båt utan användbar position.
          if (vessel && vessel._isImminentAtTargetBridge) {
            vessel._isImminentAtTargetBridge = false;
          }
          // A3-4 (Fable 2026-07-10b): T-2-kompletteringen — returen hoppar
          // över hela ETA-staleness-maskineriet (inkl. HARD-nollningen), så
          // etaMinutes frös annars på sist beräknade värde och texten visade
          // fryst minutsiffra i stället för degradering.
          if (vessel && vessel.etaMinutes !== null && vessel.etaMinutes !== undefined) {
            vessel.etaMinutes = null;
            vessel._etaIsExtrapolated = false;
          }
          this.debug('⚠️ [STATUS_UPDATE] Skipping invalid vessel:', vessel?.mmsi || 'unknown');
          return;
        }

        // Re-analyze proximity and status for each vessel
        const proximityData = this.proximityService.analyzeVesselProximity(vessel);
        // Fable-granskningen 2026-07-10b (S-1): timer-/snapshotvägen anropade
        // utan positionAnalysis → stabilizern (gate:ad på den i StatusService)
        // hoppades över och vessel.status skrevs ovillkorligt nedan. Det hold
        // stabilizern etablerade i meddelandevägen (GPS-hopp 30 s /
        // osäkerhets-konsistenskravet) revs därmed upp inom ≤30 s av nästa
        // timerpass från SAMMA osäkra position — falsk statusflapp i text och
        // notiskedja. ETA-vägen längre ned har haft exakt dessa gater hela
        // tiden (_positionUncertain/_gpsJumpDetected); statusvägen får nu
        // samma: syntetisera analysen ur fartygets flaggor (satta per senast
        // accepterade meddelande, nollade av nästa rena sample).
        const timerPositionAnalysis = (vessel._gpsJumpDetected === true || vessel._positionUncertain === true)
          ? {
            gpsJumpDetected: vessel._gpsJumpDetected === true,
            positionUncertain: vessel._positionUncertain === true,
          }
          : null;
        const statusResult = this.statusService.analyzeVesselStatus(vessel, proximityData, timerPositionAnalysis);

        // CRITICAL FIX: Always update status - it might have been changed elsewhere
        // This ensures UI always gets the latest status
        vessel.status = statusResult.status;
        vessel.isWaiting = statusResult.isWaiting;
        vessel.isApproaching = statusResult.isApproaching;

        // Bug B fix: only recalculate ETA if we received a fresh AIS position update
        // Timer-only re-evaluations reuse the last ETA to prevent oscillation.
        // Same status list as in _processAISMessage above — 'under-bridge' is
        // included so a vessel at the bridge keeps showing a meaningful clause
        // ("strax" for <1min) instead of "ETA okänd".
        // Fix 1: same status list as in _processAISMessage above. 'passed'
        // is included only when targetBridge points to a new (different) bridge,
        // so post-passage watchdog ticks compute ETA toward the next target
        // instead of nulling it (which would render as "ETA okänd").
        const hasOngoingJourneyEval = vessel.targetBridge
          && vessel.targetBridge !== vessel.lastPassedBridge;
        const inETACalcStatus = ['approaching', 'waiting', 'en-route', 'stallbacka-waiting', 'under-bridge']
          .includes(vessel.status)
          || (vessel.status === 'passed' && hasOngoingJourneyEval);

        if (inETACalcStatus) {
          if (vessel._positionUpdatedSinceLastETA
              && vessel._positionUncertain !== true
              && vessel._gpsJumpDetected !== true) {
            // RC4-fix (2026-06-11): dämpa färsk beräkning mot senast
            // PUBLICERADE värde (det användaren faktiskt såg) — kalkylatorns
            // interna historik vet inget om Fix G-extrapolerade publiceringar,
            // så utan detta uppstår sågtand (19h-loggen: 9→"cirka 4"→9→17).
            //
            // Echo-gaten (2026-07-02b, scenariot fördröjd-gammal-position):
            // ett GPS-osäkert sampel (S-F4 accept_with_caution — t.ex. en
            // out-of-order-levererad GAMMAL position 400 m bakåt) får inte
            // driva ett publicerat ETA-hopp ("strax"→"om 4 minuter"→"strax"
            // inom 90 s). Behåll publicerat värde tills ett RENT sampel
            // kommer (_positionUncertain nollställs per sampel). Flappen
            // maskerades tidigare av att distance_fallback felaktigt förklarade
            // ankommande båtar passerade — sidbyteskravet avslöjade den.
            const freshETA = this.statusService.calculateETA(vessel, proximityData);
            vessel.etaMinutes = this._reconcilePublishedETA(vessel, freshETA);
            vessel._positionUpdatedSinceLastETA = false;
            vessel._etaIsExtrapolated = false;
            vessel._etaExtrapolationBaseMs = Date.now();
            vessel._etaExtrapolationExhausted = false;
            vessel._etaExtrapolationBaseValue = undefined;
            vessel._etaExhaustedAtMs = null;
          } else {
            // Fix G (2026-04-28): smart stale-ETA-hantering.
            //   0–5 min:  använd senaste ETA oförändrat (täcker normalt AIS-jitter)
            //   5–10 min: extrapolera ned (lastETA - ageMin) → "om cirka N min"
            //   >10 min:  nullify → "ETA okänd"
            // För bilförare ger extrapolation användbar info under typiska
            // Klass B AIS-glapp 5–8 min. Om båten vänt under tystnaden rättas
            // siffran inom max 10 min av nästa AIS-tick.
            // F40 FÖRFINAT (fältprov 4, 2026-07-09, SOKERI — F4-E): staleness
            // mäts mot senast BEKRÄFTADE positionsrapport
            // (max(timestamp, lastPositionUpdate)), inte enbart positions-
            // ÄNDRINGSTID. SOKERI väntade 74 m från Stridsbergsbron (sog 0,
            // sände accepterade positioner var ~3:e min) men lastPositionUpdate
            // frös vid ankomsten → ETA_STALE_HARD dömde henne "615s old" och
            // texten föll till "ETA okänd" mitt i kön (åtta läsarfynd, samma
            // rot). En stillaliggande båt vars position BEKRÄFTAS färskt är
            // inte "okänd position" — det är känd, färsk, stilla position.
            // Anomali-3-/WIZARD-säkerhetsvalet BESTÅR: vessel.timestamp bumpar
            // bara när ett positionsmeddelande faktiskt bearbetas
            // (_createVesselObject) — en tyst transponder fryser båda
            // klockorna och degraderingen slår som förut.
            const ageMs = Date.now() - this._lastConfirmedPositionMs(vessel);
            if (ageMs > UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS) {
              if (vessel.etaMinutes !== null) {
                this.debug(
                  `⏰ [ETA_STALE_HARD] ${vessel.mmsi}: AIS ${Math.round(ageMs / 1000)}s old → clearing ETA`,
                );
                // FP7-1 (2026-07-12, NICOLINE): armera kalkylatorns
                // stationär-hold — UTAN att röra historiken. Nästa färska
                // sample för en STATIONÄR båt golvfabricerade annars om
                // ("om 101 minuter" på 0,1 kn, visad i 9 min); en RÖRLIG
                // återkomst släpper holden direkt och behåller sin
                // dämpningshistorik exakt som förut (rensningsvarianten
                // rörde 6 låsta korpusgoldens och ÅTERTOGS). Kö-båtar med
                // normal kadens når aldrig hit (>600 s-tröskeln).
                this.statusService.armStationaryETAHold(String(vessel.mmsi), 'eta_stale_hard');
              }
              vessel.etaMinutes = null;
              vessel._etaIsExtrapolated = false;
              vessel._etaPublishedValue = null; // RC4: "okänd" = ny baslinje
              // Anomali 3: rensa exhausted-flagga vid HARD-zon. Vid >10 min stale
              // är data för gammal för att lita på att båten fortfarande är vid bron.
              vessel._etaExtrapolationExhausted = false;
              vessel._etaExhaustedAtMs = null;
            } else if (ageMs > UI_CONSTANTS.STALE_ETA_SOFT_THRESHOLD_MS
                && Number.isFinite(vessel.etaMinutes)
                && vessel.etaMinutes > 0
                // RC4-fix (2026-06-11): dead-reckoning förutsätter FRAMDRIFT.
                // För nära-stillastående båtar (sog < 1 kn) domineras verkligt
                // ETA av fartgolven och SJUNKER inte med tiden — extrapolering
                // som drar av 1 min/min springer före verkligheten och ger
                // sågtand när färsk AIS rättar (LILLI: 9→cirka4→9). Behåll
                // senaste värdet oförändrat i stället (else-grenen nedan).
                && Number.isFinite(vessel.sog) && vessel.sog >= 1.0) {
              // Extrapolera: dra av tiden som gått sedan senaste verkliga beräkning.
              const baseMs = Number.isFinite(vessel._etaExtrapolationBaseMs)
                ? vessel._etaExtrapolationBaseMs
                : (vessel.lastPositionUpdate || Date.now());
              const elapsedMin = (Date.now() - baseMs) / 60000;
              const baseETA = Number.isFinite(vessel._etaExtrapolationBaseValue)
                ? vessel._etaExtrapolationBaseValue
                : vessel.etaMinutes;
              const extrapolated = Math.max(0, baseETA - elapsedMin);
              if (extrapolated > 0) {
                vessel.etaMinutes = extrapolated;
                vessel._etaIsExtrapolated = true;
                // RC4: extrapolerade värden ÄR publicerade — registrera dem som
                // baslinje så nästa färska beräkning dämpas mot det användaren såg
                vessel._etaPublishedValue = extrapolated;
                vessel._etaPublishedAtMs = Date.now();
                if (!Number.isFinite(vessel._etaExtrapolationBaseValue)) {
                  vessel._etaExtrapolationBaseValue = baseETA;
                }
              } else {
                // Anomali 3 fix (2026-05-06): extrapolation gick ned till 0 →
                // båten BORDE vara framme nu enligt vår sista verkliga ETA.
                // Tidigare visade vi "ETA okänd" vilket fick bilförare att se
                // 8+ minuter okänd-text när vi faktiskt vet att broöppning är
                // imminent. ELFKUNGEN 06-05 14:10–14:18 är paradigm-fallet.
                //
                // Nu sätter vi flaggan _etaExtrapolationExhausted så Fix H
                // nedan visar "broöppning strax" istället för "ETA okänd".
                // Risk: båten har vänt under tystnaden → "strax" är fel under
                // max 5 min (mellan SOFT 5min och HARD 10min) tills nästa AIS.
                vessel.etaMinutes = null;
                vessel._etaIsExtrapolated = false;
                vessel._etaExtrapolationExhausted = true;
                // B4 (F10): stämpla NÄR uttömningen inträffade — "strax" på
                // uttömd extrapolering håller max 90 s (imminent-grenen).
                if (!Number.isFinite(vessel._etaExhaustedAtMs)) {
                  vessel._etaExhaustedAtMs = Date.now();
                }
              }
            }
            // else: reuse existing vessel.etaMinutes
          }
        } else {
          vessel.etaMinutes = null;
          vessel._etaIsExtrapolated = false;
          vessel._etaExtrapolationExhausted = false;
          vessel._etaExhaustedAtMs = null;
        }

        // Fix H (2026-04-28): distansbaserad "strax"-trigger för aktiva resor.
        // Bilförare behöver veta att broöppning är imminent när båt närmar sig
        // målbro — oavsett om hon saktar ner/stannar för att vänta (vanligt
        // beteende i kanalen) eller om Class A 30s-tick hoppar över ETA<3-zonen.
        // Skydd: kräver targetBridge satt + färsk AIS + ej GPS-jump-hold så
        // spökbåtar (Bug #1) och stale data inte triggar falsk "strax".
        //
        // Anomali 3 debug (2026-05-05): producerar rikt loggning när vessel har
        // targetBridge men imminent inte sätts, så vi kan diagnosticera varför
        // "ETA okänd" visas trots att förutsättningarna borde stämma.
        // Echo-gaten (2026-07-02b): på ett GPS-osäkert sampel (S-F4
        // accept_with_caution — bakåtlevererad gammal position) behåller vi
        // FÖREGÅENDE imminent-läge i stället för att härleda om från den
        // osäkra positionen. Utan detta släcktes "strax" av ekot och tändes
        // igen av nästa rena sampel (flappen strax↔"om N minuter" i
        // fördröjd-gammal-position-scenariot). Nästa rena sampel härleder om.
        // F40 (medvetet EJ ändrat): se kommentar ovan. Imminent gatas på
        // positionsålder så vi inte påstår "broöppning strax" för en båt vars
        // position är >10 min gammal (Anomali-3-säkerhetsval).
        // F4-E (2026-07-09): samma bekräftade-position-klocka som ETA-gaten —
        // en väntande båt som sänder oförändrad position är FÄRSK (SOKERI).
        const ageMs = Date.now() - this._lastConfirmedPositionMs(vessel);
        const dataIsFreshEnough = ageMs <= UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS;
        // Produktionsredo (2026-07-03, CONFIRMED): hold-vägen delar F40:s
        // färskhetsgräns. Utan den höll en båt som fastnat med
        // _positionUncertain och sedan TYSTNAT sitt gamla "strax" i upp till
        // 20–25 min (tills STALE-removal) — echo-gaten är till för sekunders
        // eko-flapp, inte som evig frysning av stale data.
        const holdImminentForUncertain = (vessel._positionUncertain === true
          || vessel._gpsJumpDetected === true)
          && vessel.targetBridge
          && dataIsFreshEnough;
        // Fable-granskningen 2026-07-10b (P1-3): hysteres på imminent-
        // gränsen — den hårda 300 m-gränsen fick en ködrivande båt
        // (285→315→290 m mellan accepterade sampel) att flappa
        // "strax"↔"om N minuter" per tick. SET ≤300 / CLEAR >350 (samma
        // geometri som waiting-hysteresen; statuslagret hade den redan).
        const wasImminent = vessel._isImminentAtTargetBridge === true;
        if (!holdImminentForUncertain) {
          vessel._isImminentAtTargetBridge = false;
        }
        if (vessel.targetBridge && !holdImminentForUncertain) {
          const ageS = Math.round(ageMs / 1000);
          if (!dataIsFreshEnough) {
            this.debug(
              `🛡️ [IMMINENT_SKIP] ${vessel.mmsi}: target=${vessel.targetBridge}, AIS too old (${ageS}s > ${UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS / 1000}s)`,
            );
          } else if (!Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
            this.debug(
              `🛡️ [IMMINENT_SKIP] ${vessel.mmsi}: target=${vessel.targetBridge}, lat/lon not finite (lat=${vessel.lat}, lon=${vessel.lon})`,
            );
          } else if (this.vesselDataService?.hasGpsJumpHold?.(vessel.mmsi)) {
            this.debug(
              `🛡️ [IMMINENT_SKIP] ${vessel.mmsi}: target=${vessel.targetBridge}, GPS jump hold active`,
            );
          } else if (!this.bridgeRegistry) {
            this.debug(
              `🛡️ [IMMINENT_SKIP] ${vessel.mmsi}: target=${vessel.targetBridge}, bridgeRegistry missing`,
            );
          } else {
            const targetBridge = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
            if (!targetBridge
                || !Number.isFinite(targetBridge.lat)
                || !Number.isFinite(targetBridge.lon)) {
              this.debug(
                `🛡️ [IMMINENT_SKIP] ${vessel.mmsi}: target=${vessel.targetBridge} not in registry or invalid coords`,
              );
            } else {
              const distToTarget = geometry.calculateDistance(
                vessel.lat, vessel.lon,
                targetBridge.lat, targetBridge.lon,
              );
              // P1-3: hysteresgräns — se wasImminent-kommentaren ovan.
              // R2 2026-07-11 (A3R2-1/P1R2-3 — 2 oberoende): hysteresen
              // gäller ENDAST normal-seedad flagga (bevisad ≤300 m). En
              // exhausted-seedad flagga (301–350 m-bandet) fick annars
              // limit 350 nästa tick → ordinarie SET-grenen (utan
              // exhaustedAgeMs-koll) återsatte den varje tick → B4/F10:s
              // 90 s-tak kringgicks och falskt "strax" stod till HARD
              // (10 min). Med limit 300 för exhausted-seedad faller bandet
              // alltid in i >limit-grenen där 90 s-taket äger.
              const imminentLimitM = (wasImminent && vessel._imminentFromExhausted !== true)
                ? 350 : 300;
              if (!Number.isFinite(distToTarget)) {
                this.debug(
                  `🛡️ [IMMINENT_SKIP] ${vessel.mmsi}: target=${vessel.targetBridge}, distance not finite`,
                );
              } else if (distToTarget > imminentLimitM) {
                // Anomali 3 fix (2026-05-06): även när vesseln är >300m kan vår
                // egen extrapolation ha sagt att hon borde vara framme. Då är
                // "strax" mer ärligt än "ETA okänd" — vi vet inte exakt var
                // hon är just nu, men vi vet att broöppning är imminent enligt
                // hennes senaste fart och kurs.
                //
                // Körning 2026-07-02: grenen saknade övre distansgräns och satte
                // "strax" på 433 m (HAJH-LAIF — verklig öppning 25 min senare),
                // 1016 m (YEMANJA II — som redan PASSERAT målet) och 1419 m
                // (ELFKUNGEN). En uttömd extrapolation är en gissning byggd på
                // ≥5 min gammal fart — bortom ~500 m (≈"strax"-bandets räckvidd
                // vid 5 kn) är "ETA okänd" det ärliga svaret.
                // B4 (körning 2026-07-03, F10): uttömd-strax är tidsbegränsad.
                // ZWERK/PHILULA stod med fruset "strax" + antalsflimmer i
                // 2–5 min på uttömd extrapolering (AIS 314–584 s gammal).
                // 90 s täcker det ärliga fönstret "hon BORDE vara framme nu";
                // därefter är "ETA okänd" det ärliga svaret tills färsk AIS.
                const exhaustedAgeMs = Number.isFinite(vessel._etaExhaustedAtMs)
                  ? Date.now() - vessel._etaExhaustedAtMs
                  : 0;
                if (vessel._etaExtrapolationExhausted === true && distToTarget <= 500
                    && exhaustedAgeMs <= 90 * 1000) {
                  vessel._isImminentAtTargetBridge = true;
                  vessel._imminentFromExhausted = true; // A3R2-1: ingen hysteres
                  this.log(
                    `✨ [IMMINENT_SET_EXHAUSTED] ${vessel.mmsi}: target=${vessel.targetBridge}, `
                    + `dist=${Math.round(distToTarget)}m but extrapolation exhausted (AIS ${ageS}s old)`,
                  );
                } else {
                  this.debug(
                    `🛡️ [IMMINENT_SKIP] ${vessel.mmsi}: target=${vessel.targetBridge}, `
                    + `dist=${Math.round(distToTarget)}m > ${imminentLimitM}m `
                    + `(AIS ${ageS}s old, exhausted=${vessel._etaExtrapolationExhausted === true})`,
                  );
                }
              } else {
                vessel._isImminentAtTargetBridge = true;
                vessel._imminentFromExhausted = false; // äkta ≤300-bevis → hysteres OK
                this.debug(
                  `✨ [IMMINENT_SET] ${vessel.mmsi}: target=${vessel.targetBridge}, dist=${Math.round(distToTarget)}m, AIS ${ageS}s old`,
                );
              }
            }
          }
        }

        if (statusResult.statusChanged) {
          this.debug(`🔄 [STATUS_UPDATE] ${vessel.mmsi}: ${statusResult.status} (${statusResult.statusReason})`);
        }
      } catch (error) {
        this.error(`Error re-evaluating status for vessel ${vessel?.mmsi || 'unknown'}:`, error);
        // Continue with next vessel
      }
    });
  }

  /**
   * Find vessels relevant for bridge text generation
   * @private
   */
  _findRelevantBoatsForBridgeText() {
    const vessels = this.vesselDataService.getVesselsForBridgeText();

    // RACE CONDITION FIX: Filter out vessels that are being removed
    const vesselsBeingRemoved = this._processingRemoval || new Set();
    const filteredVessels = vessels.filter((vessel) => !vesselsBeingRemoved.has(vessel.mmsi));

    // Transform vessel data to format expected by BridgeTextService (stateless)
    return filteredVessels.map((vessel) => {
      // Find current bridge based on nearest distance
      const proximityData = this.proximityService.analyzeVesselProximity(vessel);
      let currentBridge = null;

      if (proximityData.nearestBridge && proximityData.nearestDistance <= BRIDGE_TEXT_CONSTANTS.VESSEL_DISTANCE_THRESHOLD) {
        const bridgeName = proximityData.nearestBridge.name;
        // ROOT FIX: Kontrollera passedBridges — inte bara tidsfönster.
        // PASSAGE_CLEAR_WINDOW (60s) löper ut medan fartyget fortfarande är inom 400m
        // av den passerade bron, vilket felaktigt sätter currentBridge till den.
        const hasPassedThisBridge = vessel.passedBridges && vessel.passedBridges.includes(bridgeName);
        const hasRecentlyPassedThisBridge = vessel.lastPassedBridge === bridgeName
          && vessel.lastPassedBridgeTime
          && (Date.now() - vessel.lastPassedBridgeTime) < BRIDGE_TEXT_CONSTANTS.PASSAGE_CLEAR_WINDOW_MS;

        if (!hasRecentlyPassedThisBridge && !hasPassedThisBridge) {
          currentBridge = bridgeName;
        }
      }

      // Calculate correct distance to currentBridge
      const currentBridgeId = currentBridge ? this.bridgeRegistry.findBridgeIdByName(currentBridge) : null;
      const distToCurrent = currentBridgeId
        ? (proximityData.bridgeDistances[currentBridgeId] ?? proximityData.nearestDistance)
        : proximityData.nearestDistance;

      // F5-C PRÖVAD OCH ÅTERKALLAD (fältprov 5, 2026-07-10): en projektions-
      // klamp av waiting-ETA till WAITING_STATUS_MAX_ETA_MINUTES (mot
      // SAGESSE-sågtanden 23↔12) FÄLLDES av 41h-korpusen — klampen växlar
      // med status-hysteresens waiting↔approaching och skapade en VÄRRE
      // korpusbelagd oscillation (12→71→12 på 9 s; INV-sågtand + INV-
      // oscillation). Samma läxa som F4-G/F4-M: visningsingrepp som följer
      // status är flappigare än beräkningsvärdet. SAGESSE-fallet (23 i 9 min
      // efter approaching→waiting-skifte tills nästa beräkning kapade)
      // accepteras som mild kosmetik — beräkningens ETA_WAIT_CAP äger.
      return {
        mmsi: vessel.mmsi,
        name: vessel.name,
        targetBridge: vessel.targetBridge,
        currentBridge,
        etaMinutes: vessel.etaMinutes,
        isWaiting: vessel.isWaiting,
        status: vessel.status,
        lastPassedBridge: vessel.lastPassedBridge,
        lastPassedBridgeTime: vessel.lastPassedBridgeTime,
        distance: proximityData.nearestDistance,
        distanceToCurrent: distToCurrent,
        sog: vessel.sog,
        cog: vessel.cog,
        passedBridges: vessel.passedBridges || [],
        _routeDirection: vessel._routeDirection,
        _finalTargetDirection: vessel._finalTargetDirection,
        _bridgeOpeningUntil: vessel._bridgeOpeningUntil,
        // F4: dessa flaggor styr "strax"/"cirka N min" i BridgeTextService.
        // Utan dem i projektionen blir de alltid undefined (=== true → false),
        // så imminent-override och extrapolerad-text aktiveras aldrig via
        // publiceringsvägen.
        _etaIsExtrapolated: vessel._etaIsExtrapolated,
        _isImminentAtTargetBridge: vessel._isImminentAtTargetBridge,
        lat: vessel.lat,
        lon: vessel.lon,
      };
    });
  }

  /**
   * Update UI only if needed (performance optimization)
   * @private
   */
  _updateUIIfNeeded(vessel, oldVessel) {
    // Update UI for significant changes
    const significantChanges = [
      'status', 'targetBridge', 'isWaiting', 'isApproaching', 'etaMinutes',
    ];

    this.debug(`🔍 [_updateUIIfNeeded] ${vessel.mmsi}: Checking for significant changes`);

    // Debug each significant change
    significantChanges.forEach((key) => {
      const oldVal = oldVessel?.[key];
      const newVal = vessel[key];
      const changed = newVal !== oldVal;
      this.debug(`🔍 [_updateUIIfNeeded] ${vessel.mmsi}: ${key}: "${oldVal}" → "${newVal}" (changed: ${changed})`);
    });

    const hasSignificantChange = significantChanges.some((key) => vessel[key] !== oldVessel?.[key]);

    this.debug(`🔍 [_updateUIIfNeeded] ${vessel.mmsi}: hasSignificantChange=${hasSignificantChange}`);

    if (hasSignificantChange) {
      this.debug(`✅ [_updateUIIfNeeded] ${vessel.mmsi}: Triggering UI update due to significant changes`);
      this._updateUI('normal', `vessel-significant-change-${vessel.mmsi}`);
    } else {
      this.debug(`❌ [_updateUIIfNeeded] ${vessel.mmsi}: No significant changes - skipping UI update`);
    }
  }

  /**
   * Update device capability for all devices (with crash protection)
   * @private
   */
  _updateDeviceCapability(capability, value) {
    // ChatGPT-verifieringen 2026-07-10 (C4b): serialisera skrivningarna per
    // capability — två snabba uppdateringar (A→B) var tidigare oawaitade
    // parallella promises som kunde landa i OMVÄND ordning på enheten (B:s
    // skrivning löste före A:s) → enheten fastnade på det GAMLA värdet
    // medan textcachen trodde det nya (hash-dedupen skrev aldrig om).
    // A2R2-4 (R2 2026-07-11): efter onUninit ska inget mer skrivas —
    // clear() på Map:en avbokar inte redan registrerade .then-continuations.
    if (this._shuttingDown) return;
    if (!this._capWriteChains) this._capWriteChains = new Map();
    const prev = this._capWriteChains.get(capability) || Promise.resolve();
    const next = prev.then(() => this._writeCapabilityWithTimeout(capability, value));
    // Kedjan får aldrig fastna på ett fel — felen hanteras/loggas i
    // _writeCapabilityToDevices.
    this._capWriteChains.set(capability, next.catch(() => {}));
  }

  /**
   * Fable-granskningen 2026-07-10b (SYS-2): C4b-serialiseringen gjorde varje
   * skrivning beroende av att föregående promise SETTLAR — en enda hängande
   * setCapabilityValue (Homey-IPC som aldrig svarar) wedgade kedjan för
   * alltid, tyst: appen trodde den publicerade, enheten stod stilla
   * (pelare 1-totalbortfall utan loggrad, oåterkalleligt utan omstart).
   * Timeout-vakten släpper kedjan efter 30 s och nollar dedup-sentinelen så
   * nästa cykel skriver om.
   * @private
   */
  _writeCapabilityWithTimeout(capability, value) {
    if (this._shuttingDown) return Promise.resolve(); // A2R2-4
    const WRITE_TIMEOUT_MS = 30 * 1000;
    let timer = null;
    let timedOut = false;
    const clearSentinel = () => {
      if (capability === 'bridge_text') this._lastBridgeTextHash = null;
      else if (capability === 'alarm_generic') this._lastBridgeAlarm = null;
      else if (capability === 'connection_status') this._lastConnectionStatus = null;
    };
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        this.error(`⏱️ [CAP_WRITE_TIMEOUT] ${capability}: skrivningen svarade inte inom 30 s — släpper kedjan och nollar dedupen`);
        clearSentinel();
        resolve();
      }, WRITE_TIMEOUT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    // R2 2026-07-11 (A2R2-1/SYSR2-2/P1R2-2/DIVR2-2 — 4 oberoende fynd):
    // en timeout-släppt skrivning kan inte avbrytas — landar den SENT (med
    // success!) appliceras det GAMLA värdet ovanpå nyare skrivningar utan
    // att någon läkning triggas (hash-dedupen pekar på det nya). Vid sen
    // settling efter timeout: nolla sentinelen IGEN så nästa cykel/heal
    // garanterat skriver om det aktuella värdet.
    const guarded = this._writeCapabilityToDevices(capability, value).then(
      () => {
        clearTimeout(timer);
        if (timedOut) {
          this.error(`⏱️ [CAP_WRITE_LATE_LANDING] ${capability}: timeout-släppt skrivning landade sent — nollar dedupen för omskrivning`);
          clearSentinel();
        }
      },
      (err) => {
        clearTimeout(timer);
        if (timedOut) clearSentinel();
        throw err;
      },
    );
    return Promise.race([guarded.catch((err) => {
      if (!timedOut) throw err; // före timeout: låt kedjans felväg hantera
      // efter timeout: felet är redan sentinel-hanterat; svälj (kedjan släppt)
    }), timeout]);
  }

  /**
   * R2 2026-07-11 (A2R2-2/P1R2-1 — 2 oberoende HÖG): den globala tokens
   * setValue är en awaitad Homey-IPC INUTI publiceringsbanans in-flight-
   * vakt — en hängning wedgade hela lanen permanent (rerun-kön körs aldrig,
   * alarm/connection-skrivningarna efter awaiten uteblir också) och i
   * _onVesselRemoved nåddes finally aldrig → _processingRemoval läckte
   * (återfödd båt permanent osynlig). Exakt klassen SYS-2 stängde för
   * device-vägen. 10 s-race; timeout/fel nollar hashen så nästa cykel
   * skriver om både device och token.
   * @private
   */
  async _setGlobalTokenSafe(text) {
    // ChatGPT-granskning 2 (CG2-12b, 2026-07-11): lat återskapning. Ett
    // transient createToken-fel vid init lämnade annars token död till
    // appomstart (early return här på varje publicering). Rate-limitad till
    // ett försök per minut; _globalTokenRecreatePending bryter rekursionen
    // (_initGlobalToken anropar den här metoden för sitt setValue).
    if (!this._globalBridgeTextToken && !this._shuttingDown && !this._globalTokenRecreatePending
        && this.homey && this.homey.flow && typeof this.homey.flow.createToken === 'function') {
      const nowTs = Date.now();
      if (!this._lastGlobalTokenRecreateAttempt || nowTs - this._lastGlobalTokenRecreateAttempt > 60 * 1000) {
        this._lastGlobalTokenRecreateAttempt = nowTs;
        this._globalTokenRecreatePending = true;
        try {
          await this._initGlobalToken();
        } finally {
          this._globalTokenRecreatePending = false;
        }
      }
    }
    if (!this._globalBridgeTextToken || this._shuttingDown) return;
    let timer = null;
    let timedOut = false;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        this.error('⏱️ [GLOBAL_TOKEN_TIMEOUT] setValue svarade inte inom 10 s — släpper publiceringsbanan, hash nollad');
        this._lastBridgeTextHash = null;
        resolve();
      }, 10 * 1000);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    const write = this._globalBridgeTextToken.setValue(text).then(
      () => {
        clearTimeout(timer);
        if (timedOut) this._lastBridgeTextHash = null; // sen landning: omskrivning
      },
      (error) => {
        clearTimeout(timer);
        this.error('[GLOBAL_TOKEN_ERROR] Failed to update global bridge text token:', error);
        // A2-3: hashen sattes före skrivningen — nolla så nästa cykel
        // skriver om BÅDE device och token.
        this._lastBridgeTextHash = null;
      },
    );
    await Promise.race([write, timeout]);
  }

  async _writeCapabilityToDevices(capability, value) {
    const writes = [];
    // Fable-granskningen 2026-07-10b (P1-1-skärpningen): deklareras FÖRE
    // loopen så även ett SYNKRONT kast ur setCapabilityValue räknas som
    // misslyckad skrivning (fångades tidigare i loop-catchen utan att
    // självläkningen nedan såg det).
    let anyRejected = false;
    for (const device of this._devices) {
      try {
        if (device && device.setCapabilityValue) {
          writes.push(device.setCapabilityValue(capability, value).then(() => {
            // ChatGPT-granskningen 2026-07-10 (I1, skärpt i andra rundan):
            // en enhet vars onInit misslyckades markeras unavailable av
            // device.js-catchen — första lyckade capability-skrivningen
            // bevisar att enheten fungerar igen. Flaggan rensas FÖRST när
            // setAvailable bevisligen lyckats; misslyckas den behålls
            // flaggan så nästa skrivning gör ett nytt försök (annars kunde
            // enheten fastna i unavailable för evigt).
            if (device._initFailed) {
              // ChatGPT-granskning 2 (CG2-6, 2026-07-11): en lyckad skrivning
              // på VILKEN kanal som helst räckte för att klarera flaggan —
              // en enhet vars bridge_text-migrering misslyckades blev
              // "available" på en lyckad alarm_generic-skrivning medan
              // pelare 1-kanalen saknades helt (error-storm, osynligt för
              // användaren). Kräv att ALLA obligatoriska capabilities finns
              // innan enheten friskförklaras; saknas någon förblir den
              // ärligt unavailable tills nästa onInit retar migreringen.
              // (Stubbar utan hasCapability-API behandlas som kompletta —
              // bevarar testlägets I1-beteende.)
              const REQUIRED_CAPABILITIES = ['alarm_generic', 'bridge_text', 'connection_status'];
              const allCapabilitiesPresent = typeof device.hasCapability !== 'function'
                || REQUIRED_CAPABILITIES.every((cap) => device.hasCapability(cap));
              if (!allCapabilitiesPresent) {
                this.error(`[INIT_RECOVERY_BLOCKED] ${device.getName ? device.getName() : 'device'} saknar obligatorisk capability — förblir unavailable tills migreringen lyckas (nästa onInit)`);
              } else if (typeof device.setAvailable === 'function') {
                device.setAvailable().then(() => {
                  device._initFailed = false;
                }).catch((availErr) => {
                  this.error('setAvailable failed — retrying on next update:', availErr);
                });
              } else {
                device._initFailed = false; // inget setAvailable-API (testläge)
              }
            }
          }).catch((err) => {
            this.error(`Error setting ${capability} for device ${device.getName ? device.getName() : 'unknown'}:`, err);
            return Promise.reject(err);
          }));
        }
      } catch (error) {
        this.error(`Error updating capability ${capability}:`, error);
        anyRejected = true; // P1-1: synkront kast = misslyckad skrivning
        // Continue with next device
      }
    }
    // (Promise.allSettled är otillgänglig i konfigens Node-golv — manuell
    // ekvivalent; felen är redan loggade i per-device-catchen ovan.)
    await Promise.all(writes.map((p) => p.then(() => {}, () => {
      anyRejected = true;
    })));
    // ChatGPT-verifieringen 2026-07-10 (C4a): textcachen/hashen uppdateras
    // FÖRE skrivningen — misslyckas den dedupas alla identiska omskrivningar
    // bort och enheten fastnar på gammal text. Värst för SLUT-texten ("Inga
    // båtar…"): utan båtar finns ingen forceUpdateDueToTime-självläkning.
    // Nollställd hash gör nästa UI-cykel till en garanterad omskrivning.
    //
    // Fable-granskningen 2026-07-10b (A2-1/P1-2): samma självläkning för
    // SYSTERKANALERNA — alarm_generic/connection_status har cache-före-
    // skrivning + värde-dedup (`!==`), så en misslyckad skrivning frös
    // enheten på fel värde tills nästa äkta värdeväxling (larm som lyser
    // hela natten mot "Inga båtar"-text). null är ren felsentinel
    // (initialvärdena är false/'disconnected') och tvingar omskrivning vid
    // nästa jämförelse.
    if (anyRejected) {
      if (capability === 'bridge_text') {
        this._lastBridgeTextHash = null;
        this.error('❌ [BRIDGE_TEXT_WRITE_FAILED] Hash-dedupen nollställd — texten skrivs om vid nästa UI-cykel');
      } else if (capability === 'alarm_generic') {
        this._lastBridgeAlarm = null;
        this.error('❌ [ALARM_WRITE_FAILED] Larm-dedupen nollställd — larmet skrivs om vid nästa UI-cykel');
      } else if (capability === 'connection_status') {
        this._lastConnectionStatus = null;
        this.error('❌ [CONNECTION_STATUS_WRITE_FAILED] Status-dedupen nollställd — skrivs om vid nästa UI-cykel');
      }
    }
  }

  /**
   * Clear bridge text references to specific vessel (currently triggers general UI update)
   * @param {string} mmsi - Vessel MMSI to clear references for
   * @private
   * @deprecated This method currently only triggers a general UI update.
   * Consider implementing specific vessel reference clearing if needed.
   */
  async _clearBridgeText(mmsi) {
    if (!mmsi || typeof mmsi !== 'string') {
      this.debug(`⚠️ [CLEAR_BRIDGE_TEXT] Invalid MMSI provided: ${mmsi}`);
      return;
    }

    // Implementation would clear any specific references
    // For now, just trigger a general UI update
    this._updateUI('normal', `clear-bridge-text-${mmsi}`);
  }

  /**
   * Trigger boat_near flow card (app-level)
   * @private
   */
  async _triggerBoatNearFlowBest(tokens, state, vessel) {
    if (!this._boatNearTrigger || typeof this._boatNearTrigger.trigger !== 'function') {
      // Helgranskning 2026-07-10 (A3-2): kasta i stället för return null —
      // en normal retur tolkades som framgång av _triggerBoatNearFlowForBridge
      // (dedup-nyckel + persistent-post skrevs, FLOW_TRIGGER_SUCCESS loggades)
      // trots att ingen notis levererades → bron 2h-spärrad utan notis.
      // Throw:en tar F4-K-rollbackvägen: nycklarna återställs, nästa
      // kandidat får försöka.
      this.error('❌ [FLOW_TRIGGER] boat_near trigger card unavailable – cannot fire flow');
      throw new Error('boat_near trigger card unavailable');
    }

    try {
      this.debug(`🔧 [TRIGGER_METHOD] ${vessel.mmsi}: Using app-level boat_near trigger`);
      return await this._boatNearTrigger.trigger(tokens, state);
    } catch (error) {
      this.error(`❌ [FLOW_TRIGGER_APP_ERROR] ${vessel.mmsi}: Failed to trigger boat_near card`, error.message || error);
      throw error;
    }
  }

  /**
   * Trigger boat near flow card (with deduplication)
   * @private
   */
  async _triggerBoatNearFlow(vessel) {
    // Skip flow triggers entirely during tests to avoid mock token errors
    if (process.env.NODE_ENV === 'test' || global.__TEST_MODE__) {
      this.debug(`🧪 [TEST] Skipping boat_near flow trigger for ${vessel.mmsi}`);
      return;
    }
    try {
      // ENHANCED DEBUG: Initial flow trigger attempt
      this.debug(`🎯 [FLOW_TRIGGER_START] ${vessel.mmsi}: Attempting boat_near trigger...`);

      if (!this._boatNearTrigger) {
        this.debug(`🚫 [FLOW_TRIGGER_SKIP] ${vessel.mmsi}: No _boatNearTrigger available`);
        return;
      }

      // FÖRTÖJNINGSDETEKTERING (2026-06-10): förtöjda/ankrade fartyg får
      // aldrig avfyra boat_near. Hängslen utöver target-demotionen — täcker
      // även framtida kandidatvägar som inte kräver targetBridge.
      if (vessel._moored) {
        this.debug(`⚓ [FLOW_TRIGGER_SKIP] ${vessel.mmsi}: Vessel is moored/anchored - no notification`);
        return;
      }

      // RC-S3 (2026-06-12): samma rörelsebevis-krav som målbro-gaten.
      // Körningen 2026-06-11 visade att source=current kringgår beviset:
      // en notis avfyrades 1 sekund efter första samplet för en stillastående
      // obevisad båt (sog 0,1). Den gången var båten en äkta väntare — men
      // mönstret är identiskt med en båt förtöjd vid okänd kajplats nära en
      // bro (kajliggar-klassen utanför MOORING_ZONES). En äkta väntare
      // notifieras i stället vid första rörelsen (typiskt nästa sample).
      const provenMoving = vessel._hasMovementProof
        || (Number.isFinite(vessel.sog) && vessel.sog >= MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN);
      if (!provenMoving) {
        this.debug(`🏃 [FLOW_TRIGGER_SKIP] ${vessel.mmsi}: No movement proof yet - no notification`);
        return;
      }

      // Fix 5: respect GPS jump hold to prevent spurious triggers during GPS noise.
      // A 150-200m GPS glitch can satisfy proximity (<300m) and set a dedup key,
      // which would then block the legitimate trigger when the vessel actually
      // arrives via real position data. Mirrors the filter BridgeTextService uses.
      if (this.vesselDataService
          && typeof this.vesselDataService.hasGpsJumpHold === 'function'
          && this.vesselDataService.hasGpsJumpHold(vessel.mmsi)) {
        this.debug(`🛡️ [FLOW_TRIGGER_GPS_HOLD] ${vessel.mmsi}: skipping during GPS jump`);
        return;
      }

      // F5: don't fire notifications on stale/frozen vessel data. If we haven't
      // received an AIS message for this vessel in a long time, the feed may be
      // half-open (see F1) or the vessel is gone — a "boat near" notification
      // would be false. Gate on AIS-RECEIPT time (vessel.timestamp/_lastSeen),
      // NOT position-change time, so a legitimately waiting boat (still
      // transmitting every ≤3 min) is never blocked. Vessels without a
      // timestamp (e.g. some unit-test fixtures) are treated as fresh.
      const lastAisMs = vessel.timestamp || vessel._lastSeen || 0;
      if (lastAisMs && (Date.now() - lastAisMs) > UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS) {
        this.debug(
          `🛡️ [FLOW_TRIGGER_STALE] ${vessel.mmsi}: skipping — last AIS `
          + `${Math.round((Date.now() - lastAisMs) / 1000)}s ago (> stale threshold)`,
        );
        return;
      }

      const proximityData = this.proximityService.analyzeVesselProximity(vessel);
      if (!proximityData || typeof proximityData !== 'object') {
        this.error(`[FLOW_TRIGGER] CRITICAL: Invalid proximity data for vessel ${vessel.mmsi}: ${JSON.stringify(proximityData)}`);
        return;
      }

      const bridges = Array.isArray(proximityData.bridges) ? proximityData.bridges : [];

      // ENHANCED DEBUG: Log proximity data for debugging
      this.debug(`🔍 [FLOW_TRIGGER_DEBUG] ${vessel.mmsi}: proximityData.bridges count=${bridges.length}`);
      bridges.forEach((bridge, index) => {
        this.debug(`🔍 [FLOW_TRIGGER_DEBUG] ${vessel.mmsi}: bridge[${index}] = {name: "${bridge?.name}", distance: ${bridge?.distance?.toFixed(0)}m}`);
      });

      const candidates = this._getFlowTriggerCandidates(vessel, proximityData);

      if (candidates.length === 0) {
        this.log(
          `🚫 [FLOW_TRIGGER_SKIP] ${vessel.mmsi}: No eligible bridges within `
          + `${FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD}m (target=${vessel.targetBridge || 'none'}, current=${vessel.currentBridge || 'none'})`,
        );
        return;
      }

      this.log(
        `🎯 [FLOW_TRIGGER_CANDIDATES] ${vessel.mmsi}: ${candidates.map((c) => `${c.name} (${Math.round(c.distance)}m, source=${c.source})`).join(', ')}`,
      );

      for (const candidate of candidates) {
        await this._triggerBoatNearFlowForBridge(vessel, candidate);
      }

    } catch (error) {
      this.error('Error triggering boat near flow:', error);
      // ENHANCED DEBUG: Log detailed error context
      this.error(`[FLOW_TRIGGER] Error context: vessel=${vessel?.mmsi}, targetBridge=${vessel?.targetBridge}, currentBridge=${vessel?.currentBridge}`);
    }
  }

  /**
   * Anomali 9 fix (2026-05-07): detektera broar som hoppats över via STALE_AIS
   * removal eller stora positions-hopp, och utlös fallback-notis.
   *
   * Två scenarios:
   *   A. Ny vessel skapas inuti kanalen (oldVessel === null): hon kom från
   *      Vänern (norr) eller söder, och har redan passerat broar mellan port
   *      och nuvarande position.
   *   B. Existerande vessel har stort lat-hopp (>500m): hon passerade broar
   *      mellan oldVessel.lat och vessel.lat.
   *
   * Persistent dedup (2h) hindrar dubbel-notis vid återskapning av samma vessel.
   * @private
   */
  async _checkSkippedBridgesFallback(vessel, oldVessel) {
    if (!Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) return;
    // Fältprov 3 (2026-07-08): svepet anropas från både entered- och
    // updated-vägen och kunde köra TVÅ gånger för samma AIS-position —
    // dubbla identiska dedup-/kandidatpass i samma millisekund (SISU,
    // HALIFAX, SOLANDE). Effekterna var deduperade men passet är inte
    // gratis: kör en gång per (mmsi, positionstid). Posten städas i
    // _onVesselRemoved.
    {
      const sweepTs = Number.isFinite(vessel.lastPositionUpdate) ? vessel.lastPositionUpdate : vessel.timestamp;
      if (Number.isFinite(sweepTs)) {
        if (!this._skippedBridgesSweepSeen) this._skippedBridgesSweepSeen = new Map();
        if (this._skippedBridgesSweepSeen.get(String(vessel.mmsi)) === sweepTs) return;
        this._skippedBridgesSweepSeen.set(String(vessel.mmsi), sweepTs);
      }
    }
    // Anomali 17 (2026-05-20): kör även för post-TARGET_END (targetBridge=null men
    // _finalTargetBridge satt). Tidigare returnerade `if (!vessel.targetBridge)` tidigt,
    // så large-jumps över Stallbackabron/Olidebron EFTER sista målbron fångades aldrig.
    //
    // Körning 2026-07-02 (SY FREYJA): target-gaten HELT borttagen. En mållös
    // båt (tyst borttagen och återfödd NORR om Stridsbergsbron på väg ut mot
    // Vänern → ingen target tilldelas) korsade Järnvägsbron OCH Stridsbergs-
    // bron i ett 20-min-gap — `!targetBridge && !_finalTargetBridge` stoppade
    // failsafen och båda notiserna uteblev trots broöppning. Samma klass som
    // MOSHE-missen men i failsafe-lagret; distans-/tidsgaterna i
    // _triggerBoatNearFlowFallback (2000 m/300 s) begränsar redan kandidaterna
    // till broar båten rimligen just passerat. Förtöjda båtar exkluderas.
    if (vessel._moored) return;
    if (this.vesselDataService?.hasGpsJumpHold?.(vessel.mmsi)) return;
    if (!this.bridgeRegistry) return;

    // Körning 2026-07-03 (ELFKUNGEN, F2): scenariovalet görs FÖRE sog-/cog-
    // gaterna. Vid det observerade hoppet (scenario B) ger själva hopp-
    // vektorn (Δlat) både rörelsebevis och riktning — cog behövs inte och
    // FÅR inte gata: kanalen svänger nordost vid Stridsbergsbron, så en
    // norrgående båt har legitimt cog 30–55° där. ELFKUNGEN återkom efter
    // 23-min-gap med cog 50,2° → gamla cog-gaten (north = cog ≤45°) klassade
    // riktningen som "öster/osäker" och strök HELA kontrollen: fyra broar
    // korsade, tre notiser borta (inkl. båda målbroarna). Scenario A (ny båt,
    // antagen start från porten) behåller sog- och cog-gaterna: där finns
    // inget observerat hopp att lita på, bara ett antagande.
    const isLargeJump = oldVessel && Number.isFinite(oldVessel.lat)
      && Math.abs(vessel.lat - oldVessel.lat) > 0.005;

    // Identifiera broar + Kanalinfarten (trigger-point). Anomali 13 (2026-05-16):
    // norrgående NEW_VESSELS som dyker upp norr om Kanalinfartens 300m-zon missade
    // notisen tidigare. Verifierat 2026-05-14/15: 246639000, 265759070, 265576710
    // dök upp ~58.27 (>300m från Kanalinfarten 58.268) och fick aldrig notis.
    const allBridges = ['Olidebron', 'Klaffbron', 'Järnvägsbron', 'Stridsbergsbron', 'Stallbackabron', 'Kanalinfarten'];

    // Bestäm lat-intervall där vi letar efter passade broar
    let minLat;
    let maxLat;
    let scenario;
    let direction;
    // F4-D: bevisade fönstrets gränser (null = hela fönstret positionsbevisat,
    // vilket gäller scenario B där hoppets ändpunkter är observerade).
    let provenLowLat = null;
    let provenHighLat = null;
    if (isLargeJump) {
      // SCENARIO B: stort lat-hopp (>~550m) → broar mellan oldLat och newLat.
      // Riktningen härleds ur hoppets fysiska förflyttning.
      scenario = 'large-jump';
      direction = vessel.lat > oldVessel.lat ? 'north' : 'south';
      minLat = Math.min(vessel.lat, oldVessel.lat);
      maxLat = Math.max(vessel.lat, oldVessel.lat);
    } else if (!oldVessel) {
      // SCENARIO A: ny vessel inuti kanalen — antag start från port
      // Norrgående: hon kom från söder (Kanalinfarten ~58.27)
      // Södergående: hon kom från norr (Vänern ~58.32)
      scenario = 'new-vessel';
      // FÄLTPROV 2026-07-07 (HERA II 09:15, missad Järnvägsbron): fart-/
      // cog-gaterna gäller PORT-GISSNINGEN (utan historik är inferensen en
      // gissning som kräver bevisad rörelse och tydlig kurs). Men en ÅTERFÖDD
      // båt med sist kända position har POSITIONSBEVIS — [senast kända →
      // nuvarande] måste ha korsats oavsett aktuell fart (HERA återföddes i
      // 0,5 kn i Klaffbron-kön → gaten strök den belagda Jvb-passagen).
      // Riktningen tas då ur positionsdeltat (säkrare än cog vid låg fart).
      let rebornLastKnown = this._lastKnownPositions?.get(String(vessel.mmsi)) || null;
      if (rebornLastKnown && Date.now() - rebornLastKnown.t >= this._LAST_KNOWN_POSITION_TTL_MS) {
        this._lastKnownPositions.delete(String(vessel.mmsi));
        rebornLastKnown = null;
      }
      const REBORN_MIN_DELTA_LAT = 100 / 111320; // ~100 m — under det är riktningen brus
      const rebornDLat = rebornLastKnown ? vessel.lat - rebornLastKnown.lat : null;
      const rebornEvidence = rebornLastKnown !== null && Math.abs(rebornDLat) >= REBORN_MIN_DELTA_LAT;
      if (rebornEvidence) {
        direction = rebornDLat > 0 ? 'north' : 'south';
        // FP8 (2026-07-13, IDUN): hoppvektorn ÄR rörelsebevis — svepet
        // notifierar på den ([lastKnown → nuvarande] = demonstrerad
        // förflyttning), men målbrotilldelningen dömde samma båt som
        // "never seen moving" (beviset raderades med objektet vid timeout-
        // removal, och _firstSeenLat = reborn-positionen ger noll netto-
        // förflyttning för en kö-väntare). IDUN stod 26 min i Järnvägsbro-
        // kön, positionsbevisat genom Klaffbron (hopp 1 149 m), och
        // räknades inte i bridge_text.
        // TRÖSKEL 500 m — INTE svepets 100 m: SOLUTION (19,5h-korpusen,
        // facit-fälld första variant) reborn:ade med 204 m hopp över 24 min
        // (0,3 kn = ankardrift/svaj) och fick via beviset FEL målbro i
        // 2,7 min ("Två båtar mot Stridsbergsbron" 07:26:45). Ett hopp
        // ≥500 m kan inte vara drift i kanalen; under det är båten inte
        // bevisat transiterande — målbron får vänta på live-rörelse som
        // förut. Svepets riktningströskel (100 m) har en annan roll
        // (notis-inferensens riktning) och är facit-låst — rörs inte.
        const REBORN_PROOF_MIN_DELTA_LAT = 500 / 111320;
        if (vessel._hasMovementProof !== true
            && Math.abs(rebornDLat) >= REBORN_PROOF_MIN_DELTA_LAT) {
          vessel._hasMovementProof = true;
          vessel._movementProofPending = false;
          this.log(
            `🏃 [REBORN_MOVEMENT_PROOF] ${vessel.mmsi}: Reborn displacement `
            + `${Math.round(Math.abs(rebornDLat) * 111320)}m (last known → current) proves movement`,
          );
        }
      } else {
        // Portgissningens ursprungliga gater (P5-banden medvetna).
        if (!Number.isFinite(vessel.sog) || vessel.sog < 2.0) return;
        if (!Number.isFinite(vessel.cog)) return;
        const cogIsNorth = vessel.cog >= 315 || vessel.cog <= 45;
        const cogIsSouth = vessel.cog >= 135 && vessel.cog <= 225;
        if (!cogIsNorth && !cogIsSouth) return; // Öster/väster — för osäkert
        direction = cogIsNorth ? 'north' : 'south';
      }
      // N7 (2026-07-01): antag INTE kanalport-start för en båt som lade ut
      // från en känd kaj mitt i kanalen (transpondern slås på vid avgång →
      // första positionen är kajen). Utan detta notifierades broar BAKOM
      // kajen som "passerade" fast båten aldrig korsat dem (t.ex. Klaffbron
      // för avgång norrut från Kajen norr om Klaffbron). Begränsa intervallet
      // till första kända positionen i stället för porten.
      // Körning 2026-07-02 (CLABBYDOO): 100 m marginal utöver kapselns 30 m.
      // Transpondern skickar första rapporten först EFTER avgång — en båt i
      // 4–5 kn hinner 50–100 m från kajen före första samplet (CLABBYDOO
      // sågs först 67 m bortom kapselns norra ände och fick en trolig falsk
      // Järnvägsbron-failsafe). Marginalens pris är att en äkta transitör
      // vars FÖRSTA sampel råkar ligga vid kajen inte får bakåt-inferens —
      // samma medvetna "gissa inte"-avvägning som MOJITO II-klassen.
      // F4-L (2026-07-09): kajvakten konsulterar även den SJÄLVLÄRANDE
      // kajkartan — förstakontakt nära en plats där båtar bevisligen legat
      // förtöjda/ankrade (gästhamnar, ankringsvikar utanför de statiska
      // kapslarna) behandlas som kajavgång, inte porten-gissning.
      const startedAtQuay = this.vesselDataService?.isNearMooringZone?.(
        vessel._firstSeenLat, vessel._firstSeenLon, 100,
      ) === true
        || this._isNearLearnedMooringSpot(vessel._firstSeenLat, vessel._firstSeenLon, 100);
      // F2-följdfix (2026-07-03, SPIKEN-klassen): en ÅTERFÖDD båt (borttagen
      // och återskapad) har en sist kända position — då är porten-antagandet
      // fel evidensnivå. SPIKEN låg ankrad norr om Stridsbergsbron, STALE-
      // removades och återföddes i rörelse → porten-inferensen notifierade
      // Järnvägsbron+Stridsbergsbron som ALDRIG korsats (gamla distans/fart-
      // skattningen råkade maskera klassen). Begränsa fönstret till
      // [senast kända, nuvarande] — broar däremellan MÅSTE ha korsats.
      // (Hämtad + TTL-prövad ovan i reborn-evidensblocket.)
      const lastKnown = rebornLastKnown;
      let startBoundLat = null;
      if (lastKnown) {
        startBoundLat = lastKnown.lat;
      } else if (startedAtQuay) {
        startBoundLat = vessel._firstSeenLat;
      }
      if (direction === 'north') {
        minLat = startBoundLat !== null ? startBoundLat : 58.265; // strax söder om Kanalinfarten
        maxLat = vessel.lat;
      } else {
        minLat = vessel.lat;
        maxLat = startBoundLat !== null ? startBoundLat : 58.32; // norr om Stallbackabron
      }
      // F4-D (fältprov 4, 2026-07-09, HERA II): det BEVISADE fönstret är
      // [lastKnown|_firstSeen, nuvarande] — båten har demonstrerat att den
      // var vid båda ändpunkterna; porten-antagandets förlängning bortom
      // bevisgränsen är en GISSNING (HERA II: förstakontakt 107 m norr om
      // Olidebron, sydgående, fick Klaffbron-notis 1467 m bort för en bro
      // hon kan ha lagt ut EFTER).
      // OBS (A4-H, Fable 2026-07-10b): F4-D:s AKTIVA STRYKNING av
      // gissningsdelens notiser ÅTERKALLADES senare (se beslutsblocket vid
      // notisloopen nedan) — F8-beteendet äger: ALLA kandidater notifieras,
      // gissningsdelen gated av 2000 m-taket, bevisdelen bär inferredFlush.
      // provenLow/High-fönstret nedan används alltså för FLAGGNING
      // (inferredFlush-undantaget från 2000 m-taket), inte för strykning.
      let provenBoundLat = vessel.lat;
      if (Number.isFinite(startBoundLat)) {
        provenBoundLat = startBoundLat;
      } else if (Number.isFinite(vessel._firstSeenLat)) {
        provenBoundLat = vessel._firstSeenLat;
      }
      provenLowLat = Math.min(provenBoundLat, vessel.lat);
      provenHighLat = Math.max(provenBoundLat, vessel.lat);
      if (lastKnown) {
        this.log(
          `📍 [SKIPPED_BRIDGES_LAST_KNOWN] ${vessel.mmsi}: Reborn vessel — limiting inferred `
          + `passage window to last known position (${lastKnown.lat.toFixed(5)}, `
          + `position ${Math.round((Date.now() - (Number.isFinite(lastKnown.posT) ? lastKnown.posT : lastKnown.t)) / 60000)} min old, `
          + `removed ${Math.round((Date.now() - lastKnown.t) / 60000)} min ago)`,
        );
      } else if (startedAtQuay) {
        this.log(
          `⚓ [SKIPPED_BRIDGES_QUAY_START] ${vessel.mmsi}: First position is in a mooring zone `
          + '— limiting inferred entry to the quay, not the canal port',
        );
      }
    } else {
      return; // Varken ny vessel eller stort hopp
    }

    // Identifiera broar inom lat-intervallet (exklusive endpoints)
    const passedBridgeEntries = [];
    for (const bridgeName of allBridges) {
      let bridgeLat;
      const bridge = this.bridgeRegistry.getBridgeByName(bridgeName);
      if (bridge && Number.isFinite(bridge.lat)) {
        bridgeLat = bridge.lat;
      } else {
        // Trigger-points (Kanalinfarten) ligger inte i bridgeRegistry — slå upp i TRIGGER_POINTS
        for (const tp of Object.values(TRIGGER_POINTS)) {
          if (tp.name === bridgeName && Number.isFinite(tp.lat)) {
            bridgeLat = tp.lat;
            break;
          }
        }
      }
      if (!Number.isFinite(bridgeLat)) continue;
      // FP8 (2026-07-13, CAPELLA): samma kanalrelevans-gate som live-grenens
      // trigger-point-kandidater — en SYDGÅENDE korsning av triggerPUNKTEN
      // utan kanalhistorik (kajstart i själva zonen, "lämnar kanalen") är
      // positionsbevisat sann men kanalirrelevant: båten har ingen resa som
      // notisen förvarnar om. Kanalhistorik = passedBridges/målbro ELLER att
      // det BEVISADE fönstrets norra ände ligger norr om punkten (båten kom
      // demonstrerat från kanalsidan — täcker SENTA-klassen: timeout-reborn
      // med raderad passedBridges men lastKnown norr om punkten, och LYS-
      // klassen: kajstart norr om punkten). Porten-gissningens OBEVISADE
      // 58.32-ände räknas inte (bevisprincipen, F4-D). Riktiga BROAR berörs
      // inte (de har brotext-/öppningsrelevans i sig).
      const isTriggerPoint = !this.bridgeRegistry.getBridgeByName(bridgeName);
      if (isTriggerPoint && direction === 'south') {
        const provenNorthLat = provenHighLat !== null ? provenHighLat : maxLat;
        const hasCanalHistory = (Array.isArray(vessel.passedBridges) && vessel.passedBridges.length > 0)
          || !!vessel.targetBridge
          || !!vessel._finalTargetBridge
          || (Number.isFinite(provenNorthLat) && provenNorthLat > bridgeLat + 0.0009);
        if (!hasCanalHistory) {
          this.debug(
            `🚪 [SKIPPED_BRIDGES_TP_SKIP] ${vessel.mmsi}: southbound ${bridgeName} crossing `
            + 'without canal history (quay start in zone) - not inferring',
          );
          continue;
        }
      }
      if (bridgeLat > minLat && bridgeLat < maxLat) {
        passedBridgeEntries.push({ name: bridgeName, lat: bridgeLat });
      }
    }

    if (passedBridgeEntries.length === 0) return;

    // Körning 2026-07-03 (F2): iterera i FÄRDRIKTNINGENS ordning. För en
    // södergående flerbro-flush måste target-transitionskedjan i
    // applyInferredPassage gå nord→syd — annars processas den bro som ÄR
    // target sist av alla och kedjan Strids→Jvb→Klaff kollapsar (Klaffbron
    // hann bli target via RC9-inferensen men fick aldrig sin egen
    // GAP_TARGET_INFERRED-transition). Speglar S-F3-fixen i
    // _handleIntermediateBridgePassage.
    passedBridgeEntries.sort((a, b) => (direction === 'south' ? b.lat - a.lat : a.lat - b.lat));
    const passedBridges = passedBridgeEntries.map((e) => e.name);

    this.log(
      `🔍 [SKIPPED_BRIDGES_CHECK] ${vessel.mmsi}: ${scenario}, direction=${direction}, `
      + `lat-range=[${minLat.toFixed(4)},${maxLat.toFixed(4)}], `
      + `candidates=[${passedBridges.join(', ')}]`,
    );

    // Fältprov 3 (2026-07-08, SISU 10:52): svepets riktning är belagd
    // (hoppvektor/reborn-positionsdelta/gated port-gissning) medan en
    // återfödd vessel kan sakna _routeDirection (osäker COG stoppade
    // targettilldelningen). Utan låset byggdes flush-notisernas
    // direction-token som 'unknown' i samma millisekund som svepet visste
    // 'north'. Lås bara när riktning saknas — motsägelser mot ett
    // befintligt lås hanteras av korsningsbevis-reversalen i VDS.
    if (!vessel._routeDirection && (direction === 'north' || direction === 'south')) {
      vessel._routeDirection = direction;
      this.log(
        `🧭 [SKIPPED_BRIDGES_DIRECTION_LOCK] ${vessel.mmsi}: route direction '${direction}' `
        + 'locked from evidenced sweep window',
      );
    }

    // Körning 2026-07-02 (YEMANJA II): failsafen var notis-enbart. När hoppet
    // korsade MÅLBRON men landade mellan broarna (utanför geometrimetodernas
    // gränser) förblev targetBridge den passerade bron i 39 min — texten
    // visade "på väg mot Klaffbron" medan båten låg vid Järnvägsbron.
    // För scenario B (observerat hopp, inte antagande) appliceras därför
    // passagen även i VDS: målbro → transition, mellanbro → registrering
    // (med RC9-inferens om den ligger bortom target). Scenario A är ett
    // antagande om resans start — där ändras ingen target.
    // Körning 2026-07-03 (F2/F3): inferensen körs FÖRE notisloopen så att
    // target-transitionen och passedAt-ankringen är på plats när fallbacken
    // bedömer varje bro, och i färdriktningsordning så transitionskedjan
    // följer resan (Klaff→Strids för norrgående; Strids→Jvb→Klaff söderut).
    if (scenario === 'large-jump' && typeof this.vesselDataService?.applyInferredPassage === 'function') {
      for (const bridgeName of passedBridges) {
        try {
          this.vesselDataService.applyInferredPassage(vessel, oldVessel, bridgeName);
        } catch (err) {
          this.error(`[SKIPPED_BRIDGES_TRANSITION] Error for ${bridgeName}:`, err);
        }
      }
    }

    // Utlös fallback för varje skipad bro (dedup hindrar dubbletter via persistent map)
    // N3 (2026-07-01): för large-jump (scenario B) är korsningen JUST NU
    // detekterad — stale-fönstret ska räknas från detektionsögonblicket,
    // inte skattas som distans/fart (som systematiskt ströp mellanbroar vid
    // normala 3–18-min-gap: 10 min gap @ 5 kn → "599 s > 300" → notis borta).
    // F8 (ANVÄNDARBESLUT 2026-07-03): även scenario A får detektionsstämpeln.
    // Varje bekräftad/inferrerad passage ska notifieras när VI FÅR VETA om
    // den — distans/fart-skattningen gjorde gränsbro-notiserna beroende av
    // en bräcklig 300 s-uppskattning (OLIVIER/ELFKUNGEN fick notis,
    // PHILULA/DIAMOND ströps godtyckligt). 2000 m-taket, sog≥2-gaten,
    // kajvakten (N7) och persistent dedupe består som skydd för scenario A.
    // inferredFlush: bron är geometriskt belagd mellan två OBSERVERADE
    // positioner — distanstaket ersätts av positionfärskhet + sanity i
    // _triggerBoatNearFlowFallback (DIANA: Järnvägsbron @2057 m ströps av
    // 2000 m-taket; ELFKUNGEN: Klaffbron @3863 m — båda verkliga passager).
    // F4-B (fältprov 4, 2026-07-09, SENTA): gäller nu ÄVEN scenario A:s
    // bevisade fönster ([lastKnown|firstSeen → nuvarande]) — SENTA:s
    // positionsbevisade Järnvägsbron-korsning ströps av 2000 m-taket (2139 m)
    // medan Klaffbron (1184 m) i samma fönster fick sin notis.
    // F4-D PRÖVAD OCH ÅTERKALLAD (2026-07-09): bevisprincipen som STRYKNING
    // av gissningsdelens broar bröt SEX låsta korpusfacit — 10 rådata-ÄKTA
    // notiser försvann (EXGRATIA/265759070:s session i 14h-korpusen,
    // SOLANDE/JUNO@Stallbackabron i 21h, 211112870 i 41h m.fl. är samma
    // geometriska klass som 07:24-"fantomen" men bevisat verkliga Vänern-/
    // kanalankomster). Klassen är OAVGÖRBAR i realtid — F8-beslutet
    // (2026-07-03: trolig passage notifieras; sog≥2-, cog-band-, kajvakts-
    // och 2000 m-gaterna är skydden) äger. HERA II 07:24-fallet
    // dokumenteras som accepterad avvägning i stället.
    for (const entry of passedBridgeEntries) {
      const bridgeName = entry.name;
      try {
        // F4-B (SENTA): inferredFlush för alla POSITIONSBEVISADE kandidater —
        // scenario B:s hoppfönster OCH scenario A:s bevisade fönster
        // ([lastKnown|firstSeen|kaj → nuvarande]). Gissningsdelens kandidater
        // (bortom bevisgränsen) behåller 2000 m-taket som förut.
        const proven = scenario === 'large-jump'
          || (provenLowLat !== null && entry.lat > provenLowLat && entry.lat < provenHighLat);
        const options = proven
          ? { detectionTs: Date.now(), inferredFlush: true }
          : { detectionTs: Date.now() };
        await this._triggerBoatNearFlowFallback(vessel, bridgeName, options);
      } catch (err) {
        this.error(`[SKIPPED_BRIDGES_FALLBACK] Error for ${bridgeName}:`, err);
      }
    }
  }

  /**
   * Determine which bridges should trigger Flow cards for a vessel
   * @private
   */
  _getFlowTriggerCandidates(vessel, proximityData) {
    const threshold = FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD;
    const bridges = Array.isArray(proximityData?.bridges) ? proximityData.bridges : [];
    const nearestBridge = proximityData?.nearestBridge;
    const candidates = [];
    const seen = new Set();

    const resolveDistance = (bridgeName) => {
      const bridgeData = bridges.find((bridge) => bridge && bridge.name === bridgeName);
      if (bridgeData && Number.isFinite(bridgeData.distance)) {
        return bridgeData.distance;
      }
      if (nearestBridge && nearestBridge.name === bridgeName && Number.isFinite(nearestBridge.distance)) {
        return nearestBridge.distance;
      }
      if (bridgeName === vessel.currentBridge && Number.isFinite(vessel.distanceToCurrent)) {
        return vessel.distanceToCurrent;
      }
      // BUG B fix (2026-04-27): direktberäkning från vessel-position till bro-koordinat
      // när proximityData är inkomplett. S/Y ROSE 14:01:18: current=Olidebron men alla
      // tre branches misslyckades trots att båten var ~225m från bron → SKIP felaktigt.
      if (Number.isFinite(vessel.lat) && Number.isFinite(vessel.lon) && this.bridgeRegistry) {
        const bridge = this.bridgeRegistry.getBridgeByName(bridgeName);
        if (bridge && Number.isFinite(bridge.lat) && Number.isFinite(bridge.lon)) {
          return geometry.calculateDistance(vessel.lat, vessel.lon, bridge.lat, bridge.lon);
        }
      }
      return null;
    };

    const addCandidate = (bridgeName, source) => {
      if (!bridgeName || typeof bridgeName !== 'string') return;
      if (seen.has(bridgeName)) return;

      const bridgeId = BRIDGE_NAME_TO_ID[bridgeName];
      if (!bridgeId) {
        this.error(`[FLOW_TRIGGER] CRITICAL: Unknown bridge name "${bridgeName}" - not found in BRIDGE_NAME_TO_ID mapping`);
        return;
      }

      const distance = resolveDistance(bridgeName);
      if (!Number.isFinite(distance) || distance > threshold) {
        this.debug(
          `🚫 [FLOW_TRIGGER_CANDIDATE_SKIP] ${vessel.mmsi}: ${bridgeName} `
          + `distance=${distance != null ? Math.round(distance) : 'unknown'}m (source=${source})`,
        );
        return;
      }

      candidates.push({
        name: bridgeName,
        id: bridgeId,
        distance,
        source,
      });
      seen.add(bridgeName);
    };

    addCandidate(vessel.targetBridge, 'target');
    addCandidate(vessel.currentBridge, 'current');

    // BUG A fix (2026-04-27): nyligen passerad bro fortfarande inom 300m är kandidat.
    // S/Y ROSE 13:50:16: BRIDGE_PASSED Järnvägsbron + currentBridge bytt till Klaffbron
    // i samma tick → Järnvägsbron försvann ur candidates trots ~111m avstånd.
    // 15s grace räcker för att fånga närliggande AIS-tick utan att läcka över i senare resor.
    // Dedup-keys (rad 2639) garanterar att bron triggar max EN gång per resa.
    const PASSAGE_TRIGGER_GRACE_MS = 15000;
    if (vessel.lastPassedBridge
        && Number.isFinite(vessel.lastPassedBridgeTime)
        && Date.now() - vessel.lastPassedBridgeTime < PASSAGE_TRIGGER_GRACE_MS) {
      addCandidate(vessel.lastPassedBridge, 'just-passed');
    }

    if (
      candidates.length === 0
      && nearestBridge
      && nearestBridge.name
      && Number.isFinite(nearestBridge.distance)
      && nearestBridge.distance <= threshold
    ) {
      addCandidate(nearestBridge.name, 'nearest');
    }

    // Trigger points: independently calculate distance and add as candidates
    // (geographic trigger points outside the bridge passage system)
    if (Number.isFinite(vessel.lat) && Number.isFinite(vessel.lon)) {
      for (const [tpId, tp] of Object.entries(TRIGGER_POINTS)) {
        if (seen.has(tp.name)) continue;
        const dist = geometry.calculateDistance(vessel.lat, vessel.lon, tp.lat, tp.lon);
        // FP7-3 (CALIMA): segmentsvepet i _onVesselUpdated flaggar en
        // genomkorsning vars BÅDA ändpunkter ligger utanför 300 m-zonen —
        // kandidatens distans är segmentets minsta avstånd till punkten.
        const sweep = vessel._tpSweepCandidate && vessel._tpSweepCandidate.name === tp.name
          ? vessel._tpSweepCandidate
          : null;
        if ((dist !== null && dist <= threshold) || sweep) {
          // FP8 (2026-07-13, PILOT 761/CAPELLA): lotskajen ligger ~120–155 m
          // från Kanalinfarten-punkten — kajstartare som lägger ut SÖDERUT
          // (bort från kanalen, "lämnar kanalen, ingen målbro") fick notis
          // enbart på zonnärvaro. Sydgående kräver kanalrelevans: transitbevis
          // (passerade broar/målbro) eller episodstart norr om punkten (äkta
          // utfart, LYS-klassen). Nordgående/okänd riktning berörs inte —
          // förvarning för inkommande båtar är punktens syfte. Exit-fallbacken
          // (removal-vägen) är en annan väg och har egna beviskrav.
          if (this._getDirectionString(vessel) === 'southbound') {
            const hasCanalHistory = (Array.isArray(vessel.passedBridges) && vessel.passedBridges.length > 0)
              || !!vessel.targetBridge
              || !!vessel._finalTargetBridge
              || (Number.isFinite(vessel._firstSeenLat) && vessel._firstSeenLat > tp.lat + 0.0009);
            if (!hasCanalHistory) {
              this.debug(
                `🚪 [TRIGGER_POINT_SKIP] ${vessel.mmsi}: southbound at ${tp.name} without canal history `
                + '(quay start in zone, leaving canal) - no candidate',
              );
              continue;
            }
          }
          candidates.push({
            name: tp.name,
            id: tpId,
            distance: (dist !== null && dist <= threshold) ? dist : sweep.distance,
            source: 'trigger-point',
          });
          seen.add(tp.name);
        }
      }
    }

    const hasTargetCandidate = candidates.some((candidate) => candidate.source === 'target');
    if (hasTargetCandidate) {
      // Fix 7: when both target and current bridges are within 300m AND are
      // different bridges, allow BOTH to trigger. This handles the geography
      // where Järnvägsbron and Stridsbergsbron are only ~260m apart, so their
      // 300m proximity-zones overlap. Without this, the EKEN scenario from
      // production logs (2026-04-26 00:49:34) silently dropped Stridsbergsbron's
      // notification because Järnvägsbron was the closer "current" bridge.
      // Dedup keys per bridge prevent duplicate notifications.
      const targetCandidate = candidates.find((c) => c.source === 'target');
      const currentCandidate = candidates.find(
        (c) => (c.source === 'current' || c.source === 'nearest' || c.source === 'just-passed')
          && c.name !== targetCandidate.name,
      );
      if (currentCandidate) {
        // Both legitimate — return target + current/nearest/just-passed + trigger-points
        return candidates.filter((candidate) => candidate.source === 'target'
          || candidate.source === 'current'
          || candidate.source === 'nearest'
          || candidate.source === 'just-passed'
          || candidate.source === 'trigger-point');
      }
      // Otherwise: target dominates (existing behavior)
      return candidates.filter((candidate) => candidate.source === 'target' || candidate.source === 'trigger-point');
    }

    return candidates;
  }

  /**
   * Anomali 10 (2026-05-12): Vid vessel removal, om södergående båt slutade
   * inom 400m norr om Kanalinfarten utan att hennes trigger utlösts under resan,
   * utlös fallback. Hanterar Klass B-båtar med ~20 min AIS-glapp över exit-zonen.
   * @private
   */
  async _triggerExitPointFallback(vessel) {
    const { kanalinfarten } = TRIGGER_POINTS;
    if (!kanalinfarten
        || !Number.isFinite(kanalinfarten.lat)
        || !Number.isFinite(kanalinfarten.lon)) {
      return;
    }
    // F63: fyra inte exit-notis på en INAKTUELL position. Detta är en
    // fallback som kan trigga upp till 400m bort baserat på vessel.lat/lon —
    // om den positionen är timmar gammal (båten redan ute ur kanalen / borta)
    // blir notisen falsk.
    // Körning 2026-07-02 (CLABBYDOO): garden var död kod — vesselSnapshot
    // saknade ålderfälten (nu tillagda) OCH 10-min-tröskeln var oförenlig med
    // featuren själv: exit-fallbacken körs vid removal, som för slutförda
    // resor sker via ~20-min-timern, så Anomali 10:s egna verifierade fall
    // (265037590, 246140000 — "~20 min AIS-glapp innan COMPLETED_BYPASS")
    // hade också stoppats. Tröskeln är därför 25 min (> removal-timern).
    // F4-E (2026-07-09): åldern mäts mot senast BEKRÄFTADE positionsrapport
    // (max-klockan). Den gamla kommentaren "timestamp uppdateras av namn-
    // meddelanden" är föråldrad: _onStaticName sätter numera bara vessel.name
    // — timestamp stämplas enbart i _createVesselObject (positionsmeddelanden).
    const EXIT_FALLBACK_MAX_POSITION_AGE_MS = 25 * 60 * 1000;
    const lastAisMs = Math.max(
      vessel.timestamp || 0, vessel.lastPositionUpdate || 0, vessel._lastSeen || 0,
    );
    if (!lastAisMs || (Date.now() - lastAisMs) > EXIT_FALLBACK_MAX_POSITION_AGE_MS) {
      this.debug(
        `🛡️ [EXIT_TRIGGER_STALE] ${vessel.mmsi}: skipping exit fallback — last position `
        + `${lastAisMs ? `${Math.round((Date.now() - lastAisMs) / 1000)}s ago` : 'unknown age'} (> 25 min or missing)`,
      );
      return;
    }
    const distance = geometry.calculateDistance(
      vessel.lat, vessel.lon,
      kanalinfarten.lat, kanalinfarten.lon,
    );
    const EXIT_FALLBACK_RADIUS = 400; // 100m buffer utöver 300m-zonen
    // F5-B (fältprov 5, IN-AXXI): TREDJE rådataverifierade fallet i klassen —
    // sydgående i 6,5 kn med Olidebron bevisat passerad försvann 546 m norr
    // om punkten (sista sample 08:48, removal 09:08) → 400 m-gaten strök
    // notisen tyst. En ren radiehöjning vore farlig: Olidebron ligger ~520 m
    // norr om punkten, så en båt som LÄGGER SIG vid Olide hamnar i bandet.
    // Utökningen kräver därför aktiv sydgående transit i sista samplet:
    // marschfart + sydlig kurs + Olidebron i passedBridges (alla tre bevisar
    // att båten var på väg UT, inte parkerad). Basradien 400 m oförändrad.
    const EXIT_FALLBACK_EXTENDED_RADIUS = 800;
    // R2 2026-07-11 (A1R2-1): F5-B-utökningen var DÖD för fartgivarlösa —
    // en aldrig-finit båt har sog=null i snapshotten och kunde inte uppfylla
    // finit ≥3,0 hur aktiv transiten än var. Endast när sog SAKNAS faller
    // vi tillbaka på maxRecentSpeed (finns i snapshotten, RC3-gatens mall);
    // en finit LÅG sog (parkerad) betyder bevisligen långsam → basradien.
    let effectiveTransitSpeed = 0;
    if (Number.isFinite(vessel.sog)) {
      effectiveTransitSpeed = vessel.sog;
    } else if (Number.isFinite(vessel.maxRecentSpeed)) {
      effectiveTransitSpeed = vessel.maxRecentSpeed;
    }
    const activeSouthTransit = effectiveTransitSpeed >= 3.0
      && Number.isFinite(vessel.cog) && vessel.cog >= 135 && vessel.cog <= 225
      && Array.isArray(vessel.passedBridges) && vessel.passedBridges.includes('Olidebron');
    const withinExitRange = Number.isFinite(distance)
      && (distance <= EXIT_FALLBACK_RADIUS
        || (distance <= EXIT_FALLBACK_EXTENDED_RADIUS && activeSouthTransit));
    if (!withinExitRange) {
      if (Number.isFinite(distance) && distance <= EXIT_FALLBACK_EXTENDED_RADIUS) {
        this.debug(
          `🚪 [EXIT_TRIGGER_SKIP_RANGE] ${vessel.mmsi}: ${Math.round(distance)}m from Kanalinfarten `
          + '— beyond 400m and no active south-transit evidence for extended range',
        );
      }
      return;
    }
    // Helgranskning 2026-07-06 (app-6#R2-2): systervägarnas förtöjnings-/
    // rörelsebevis-gate saknades här — en kajliggare inom 400 m från
    // Kanalinfarten fick annars en falsk exit-notis vid varje removal-cykel
    // (var 2:e timme via persistent-dedup-fönstret). Snapshotten bär numera
    // _moored/_hasMovementProof (fältlistan uppdaterad).
    if (vessel._moored === true) {
      this.debug(`⚓ [EXIT_TRIGGER_SKIP] ${vessel.mmsi}: moored/anchored — no exit notification`);
      return;
    }
    if (vessel._hasMovementProof !== true) {
      this.debug(`🏃 [EXIT_TRIGGER_SKIP] ${vessel.mmsi}: no movement proof — no exit notification`);
      return;
    }
    // Bara om vesseln är norr om Kanalinfarten (lat > tp.lat) — då har hon ännu
    // inte passerat söderut, men förväntas göra det. Söder om → redan passerad.
    if (vessel.lat < kanalinfarten.lat) {
      return;
    }
    const dedupeKey = `${vessel.mmsi}:Kanalinfarten`;
    if (this._triggeredBoatNearKeys && this._triggeredBoatNearKeys.has(dedupeKey)) {
      // FÄLTPROV 2026-07-07: samma riktningsundantag som huvudvägens
      // sessionscheck — en sydgående EXIT efter nordgående ENTRY-notis är en
      // fysisk returpassage, inte en dubblett (sessionsnycklar överlever
      // removal i timmar via BUG7-bevarandet).
      // C3 (ChatGPT-verifieringen 2026-07-10): utgången post = frånvarande
      // post, oberoende av prune-timing — se huvudvägens kommentar.
      const persistedRaw = this._persistentRecentTriggers
        ? this._persistentRecentTriggers.get(dedupeKey)
        : null;
      const persistedTs = typeof persistedRaw === 'number' ? persistedRaw : persistedRaw && persistedRaw.t;
      const persistedFresh = Number.isFinite(persistedTs)
        && (Date.now() - persistedTs) < (this._PERSISTENT_DEDUP_WINDOW_MS || 2 * 60 * 60 * 1000);
      const persisted = persistedFresh ? persistedRaw : null;
      const prevDir = persisted && persisted.dir ? persisted.dir : null;
      // F4-C (PIANO): flip-bedömningens NYA riktning kräver rörelsebevis
      const curDir = this._dedupDirection(vessel, { requireMovement: true });
      const oppositeDirection = prevDir && curDir && prevDir !== curDir;
      // Helgranskning 2026-07-10 (A3-1): expired-släppet var ovillkorligt här
      // medan huvudvägen fick F5-A-gaten (fältprov 5, PILOT 761) — en reborn-
      // båt med intjänat (klistrande) rörelsebevis som ligger still inom
      // 400 m norr om punkten kunde få en ANDRA exit-notis när 2h-posten
      // prunats, utan ny passage. Spegla huvudvägen: släpp kräver rörelse i
      // NUET (C2: explicit sog ≥ 2 — låst rutt räcker inte, se huvudvägen)
      // och ingen obekräftad reversal. Äkta returexits i rörelse (IN-AXXI-
      // klassen, korpuslåsta) uppfyller kraven och släpps som förut.
      const movingNow = Number.isFinite(vessel.sog) && vessel.sog >= 2.0;
      // Scenario #44-spegeln (Fable 2026-07-10b): redan-passerad-gaten från
      // huvudvägen — no-op för Kanalinfarten (triggerpunkter bokförs aldrig
      // i passedBridges) men vägarna ska förbli exakta speglar.
      // A4R2-2-spegeln (R2 2026-07-11): freshlyRecrossed-släppet — även den
      // en no-op här av samma skäl.
      const freshlyRecrossed = vessel.lastPassedBridge === 'Kanalinfarten'
        && Number.isFinite(vessel.lastPassedBridgeTime)
        && (Date.now() - vessel.lastPassedBridgeTime) < 2 * 60 * 1000;
      const alreadyPassedThisJourney = Array.isArray(vessel.passedBridges)
        && vessel.passedBridges.includes('Kanalinfarten')
        && !freshlyRecrossed;
      const expiredRelease = !persisted && !oppositeDirection
        ? (curDir !== null && movingNow && !vessel._newJourneyPending && !alreadyPassedThisJourney)
        : false;
      if (oppositeDirection || (!persisted && expiredRelease)) {
        // P2R2-4-spegeln (R2 2026-07-11): behåll nyckeln om persistentgaten
        // nedströms blockerar flippen (samma vakt som huvudvägen).
        if (oppositeDirection) {
          const verdict = this._persistentDedupCheck(dedupeKey, vessel, { retroactiveSource: true });
          if (verdict.blocked) {
            this.debug(
              `🚫 [EXIT_TRIGGER_DEDUPE] ${vessel.mmsi}: flip blocked downstream by persistent gate `
              + `(${verdict.minutesSince} min) — keeping session key`,
            );
            return;
          }
        }
        this._triggeredBoatNearKeys.delete(dedupeKey);
        this.log(
          `🔁 [EXIT_TRIGGER_DEDUPE_DIRECTION] ${dedupeKey}: session key released `
          + `(${oppositeDirection ? `direction flipped ${prevDir} → ${curDir}` : 'no persistent entry (expired)'})`,
        );
      } else if (!persisted) {
        this.log(
          `🚫 [EXIT_TRIGGER_DEDUPE_EXPIRED_HOLD] ${vessel.mmsi}: Kanalinfarten dedup expired but `
          + `${vessel._newJourneyPending ? 'reversal pending' : 'no movement evidence (stationary vessel — no new passage)'} — keeping block`,
        );
        return;
      } else {
        this.debug(
          `🚫 [EXIT_TRIGGER_DEDUPE] ${vessel.mmsi}: Kanalinfarten already triggered this session`,
        );
        return;
      }
    }
    // Anomali 10 v2: kontrollera persistent dedup (2h) här innan vi loggar "firing".
    // Utan denna check loggas missvisande "EXIT_TRIGGER_FALLBACK: firing fallback"
    // följt av "FALLBACK_TRIGGER_PERSISTENT_DEDUP: skipping" från _triggerBoatNearFlowFallback.
    {
      const exitDedup = this._persistentDedupCheck(dedupeKey, vessel, { retroactiveSource: true });
      if (exitDedup.blocked) {
        this.debug(
          `🚫 [EXIT_TRIGGER_PERSISTENT_DEDUPE] ${vessel.mmsi}: Kanalinfarten triggered `
          + `${exitDedup.minutesSince} min ago (within 2h window)`,
        );
        return;
      }
    }
    this.log(
      `🚪 [EXIT_TRIGGER_FALLBACK] ${vessel.mmsi}: Last known position ${Math.round(distance)}m `
      + 'from Kanalinfarten — firing fallback for missed exit notification',
    );
    // Fable-granskningen 2026-07-10b (A3-2): utan detectionTs föll anropet i
    // distans/fart-SKATTNINGEN (Kanalinfarten finns aldrig i passedAt) som
    // tolkar exit-avståndet som "tid sedan passage" — 300 s-gränsen ströp då
    // F5-B-radien till ~154 m per knop (700 m @ 4 kn = 340 s → struken; hela
    // 800 m kräver ≥5,2 kn). Exit-fallet ÄR detektionsögonblicket: vi fick
    // veta om den missade utfarten NU (removal). Positionens ålder vaktas
    // separat av F63-/RC3-gaterna ovan.
    await this._triggerBoatNearFlowFallback(vessel, 'Kanalinfarten', { detectionTs: Date.now() });
  }

  /**
   * BUG C fix (2026-04-27): Fallback flow-trigger när passage detekterats men
   * proximity-triggern aldrig kördes (Klass B AIS-gap där båten hoppar från
   * utanför 300m direkt till passerad). Bypassar eligibility-check men respekterar
   * dedup och GPS-jump-hold.
   * @private
   */
  async _triggerBoatNearFlowFallback(vessel, bridgeName, options = {}) {
    if (!this._boatNearTrigger) return;
    if (this.vesselDataService?.hasGpsJumpHold?.(vessel.mmsi)) {
      this.debug(
        `🛡️ [FALLBACK_TRIGGER_GPS_HOLD] ${vessel.mmsi}: skipping ${bridgeName} fallback during GPS jump`,
      );
      return;
    }
    const bridgeId = BRIDGE_NAME_TO_ID[bridgeName];
    if (!bridgeId) {
      this.error(`[FALLBACK_TRIGGER] Unknown bridge name "${bridgeName}"`);
      return;
    }

    let distance = 0;
    if (Number.isFinite(vessel.lat) && Number.isFinite(vessel.lon)) {
      if (this.bridgeRegistry) {
        const bridge = this.bridgeRegistry.getBridgeByName(bridgeName);
        if (bridge && Number.isFinite(bridge.lat) && Number.isFinite(bridge.lon)) {
          distance = geometry.calculateDistance(vessel.lat, vessel.lon, bridge.lat, bridge.lon) || 0;
        }
      }
      // Anomali 10 (2026-05-12): trigger-points (Kanalinfarten) ligger utanför bridgeRegistry.
      // Slå upp dem direkt i TRIGGER_POINTS så distance-beräkning fungerar för fallback.
      if (distance === 0) {
        for (const tp of Object.values(TRIGGER_POINTS)) {
          if (tp.name === bridgeName && Number.isFinite(tp.lat) && Number.isFinite(tp.lon)) {
            distance = geometry.calculateDistance(vessel.lat, vessel.lon, tp.lat, tp.lon) || 0;
            break;
          }
        }
      }
    }

    // Anomali 1 fix v2 (2026-05-05): tid-baserad relevans-check istället för
    // fast distans-cap. Distance i Fix C är från NUVARANDE position till bron,
    // inte position vid passage-tillfället. Frågan är inte "hur långt bort"
    // utan "hur länge sedan passagen". Notis "boat_near" är bara relevant om
    // broöppning fortfarande är pågående eller mycket nyligen avslutad.
    //
    // Logik:
    //   1. ABSOLUT max 2000m — extrema fall (GPS-fel, stora glapp), aldrig
    //      relevant att notifiera.
    //   2. För båtar med sog > 0.5 knot: uppskatta tid sedan passage som
    //      distance / sog. Om > 5 min → skippa (notis irrelevant).
    //      → Snabba båtar får mer distans-tolerans (12kn → ~1850m i 5 min)
    //      → Långsamma får mindre (3kn → ~460m i 5 min)
    //   3. För nästan-stillastående (sog ≤ 0.5): båten har inte rört sig
    //      långt sedan passage, så stor distance betyder att hon aldrig
    //      var nära. Behåll 500m-cap som säkerhetsnät (spökbåt-skydd).
    const FALLBACK_HARD_MAX_DISTANCE = 2000;
    const FALLBACK_TIME_SINCE_PASSAGE_MAX_S = 300; // 5 min
    const FALLBACK_LOW_SOG_MAX_DISTANCE = 500;
    const SOG_MOTION_THRESHOLD = 0.5;

    // Anomali 9 fix (2026-05-07): persistent dedup-check.
    // Vid vessel-återskapning (efter STALE_AIS removal) clearas _triggeredBoatNearKeys.
    // Om bron triggat senaste 2h enligt persistent map — skippa fallback för att
    // undvika dubbel-notis.
    const persistentDedupeKey = `${vessel.mmsi}:${bridgeName}`;
    const fallbackDedup = this._persistentDedupCheck(persistentDedupeKey, vessel, { retroactiveSource: true });
    if (fallbackDedup.blocked) {
      this.log(
        `🚫 [FALLBACK_TRIGGER_PERSISTENT_DEDUP] ${vessel.mmsi}: Skipping ${bridgeName} fallback `
        + `— triggered ${fallbackDedup.minutesSince} min ago (within 2h window)`,
      );
      return;
    }

    // F2/F5 (körning 2026-07-03): vid inferens-flush (scenario B, observerat
    // lat-hopp) är passagen geometriskt belagd — bron ligger mellan hoppets
    // ändpunkter — så "hur långt bort är båten NU" är fel fråga: ju större
    // gap desto längre hinner båten, och taket ströp just de största (=
    // viktigaste) flusharna (DIANA Järnvägsbron 2057 m, ELFKUNGEN Klaffbron
    // 3863 m — verkliga passager, notiser borta). Ersätts av: färsk position
    // (< 2 min — annars är även "detekterades nu" gammalt) + 10 km-sanity
    // (GPS-artefaktskydd; gaten hasGpsJumpHold ovan täcker karantänfallen).
    if (options.inferredFlush === true) {
      const INFERRED_FLUSH_SANITY_MAX_M = 10000;
      const INFERRED_FLUSH_MAX_POSITION_AGE_MS = 2 * 60 * 1000;
      // F4-E (2026-07-09): bekräftad-position-klockan — beviset är färskt även
      // när positionen är oförändrad men aktivt bekräftad (väntande sändare).
      const lastConfirmed = this._lastConfirmedPositionMs(vessel);
      const posAgeMs = lastConfirmed > 0 ? Date.now() - lastConfirmed : null;
      if (distance > INFERRED_FLUSH_SANITY_MAX_M) {
        this.log(
          `🚫 [FALLBACK_TRIGGER_TOO_FAR] ${vessel.mmsi}: Skipping ${bridgeName} inferred flush `
          + `— ${Math.round(distance)}m exceeds sanity max ${INFERRED_FLUSH_SANITY_MAX_M}m`,
        );
        return;
      }
      if (posAgeMs !== null && posAgeMs > INFERRED_FLUSH_MAX_POSITION_AGE_MS) {
        this.log(
          `🚫 [FALLBACK_TRIGGER_STALE_POSITION] ${vessel.mmsi}: Skipping ${bridgeName} inferred flush `
          + `— position ${Math.round(posAgeMs / 1000)}s old (> 2 min)`,
        );
        return;
      }
    } else if (distance > FALLBACK_HARD_MAX_DISTANCE) {
      this.log(
        `🚫 [FALLBACK_TRIGGER_TOO_FAR] ${vessel.mmsi}: Skipping ${bridgeName} fallback `
        + `— ${Math.round(distance)}m exceeds absolute max ${FALLBACK_HARD_MAX_DISTANCE}m`,
      );
      return;
    }

    // RC3-fix (2026-06-11): stale-skattningen underdrev failsafen systematiskt.
    // (a) Om passagen är ANKRAD (vessel.passedAt[bro]) är tiden EXAKT känd —
    //     använd den i stället för någon skattning alls.
    // (b) Annars: skatta med maxRecentSpeed (transitfarten) i stället för
    //     momentan sog — båtar SAKTAR IN efter passage, så momentan sog
    //     överskattar tiden grovt. 19h-prodloggen: SILJA missade Klaffbron-
    //     notisen HELT (skattat 461 s med sog 2,7 kn; verklig tid ~250 s,
    //     transitfart 5,8 kn — maxRecentSpeed hade gett 215 s < 300).
    // passedAt-följdfix (2026-06-13): referensen för stale-fönstret är när
    // VI FICK VETA om passagen (detektionsögonblicket), inte den fysiska
    // korsningen — användaren kan omöjligt notifieras före detektering, och
    // failsafens hela syfte är "notifiera så fort vi vet". passedAt kan nu
    // (korrekt) bära en äldre korsningstid från under-bridge-ankring; utan
    // max-väljaren ströps failsafen för passager som DETEKTERADES nyss men
    // KORSADES >5 min sedan (41h-korpusen: 265580000@Klaffbron).
    const anchoredTs = vessel.passedAt && vessel.passedAt[bridgeName];
    // N3 (2026-07-01): anroparen kan ange detektionsögonblicket explicit
    // (skipped-bridges scenario B: hoppet upptäcktes NU). Annars härleds det
    // ur lastPassedBridge-stämpeln som tidigare.
    let detectionTs = null;
    if (Number.isFinite(options.detectionTs)) {
      detectionTs = options.detectionTs;
    } else if (vessel.lastPassedBridge === bridgeName
        && Number.isFinite(vessel.lastPassedBridgeTime)) {
      detectionTs = vessel.lastPassedBridgeTime;
    }
    // N3: känt detektionsögonblick räcker som referens även utan ankrad
    // korsningstid — failsafens fönster mäter "hur länge sedan VI FICK VETA",
    // och distans/fart-skattningen (else-grenen nedan) är bara en nödfallsväg
    // när ingen tidsreferens alls finns.
    const anchoredPassageTs = Number.isFinite(anchoredTs)
      ? Math.max(anchoredTs, detectionTs || 0)
      : detectionTs;
    if (Number.isFinite(anchoredPassageTs)) {
      const exactTimeSinceS = (Date.now() - anchoredPassageTs) / 1000;
      if (exactTimeSinceS > FALLBACK_TIME_SINCE_PASSAGE_MAX_S) {
        this.log(
          `🚫 [FALLBACK_TRIGGER_STALE] ${vessel.mmsi}: Skipping ${bridgeName} fallback `
          + `— known passage ${Math.round(exactTimeSinceS)}s ago exceeds ${FALLBACK_TIME_SINCE_PASSAGE_MAX_S}s`,
        );
        return;
      }
    } else {
      const effectiveSogKn = Math.max(
        Number.isFinite(vessel.sog) ? vessel.sog : 0,
        Number.isFinite(vessel.maxRecentSpeed) ? vessel.maxRecentSpeed : 0,
      );
      const sogMps = effectiveSogKn * 0.5144;
      if (sogMps > SOG_MOTION_THRESHOLD * 0.5144 && distance > 0) {
        const timeSincePassageS = distance / sogMps;
        if (timeSincePassageS > FALLBACK_TIME_SINCE_PASSAGE_MAX_S) {
          this.log(
            `🚫 [FALLBACK_TRIGGER_STALE] ${vessel.mmsi}: Skipping ${bridgeName} fallback `
            + `— estimated ${Math.round(timeSincePassageS)}s since passage `
            + `(distance=${Math.round(distance)}m, effSog=${effectiveSogKn.toFixed(1)}kn) exceeds ${FALLBACK_TIME_SINCE_PASSAGE_MAX_S}s`,
          );
          return;
        }
      }
    }
    if (!Number.isFinite(anchoredPassageTs)
        && !(Number.isFinite(vessel.sog) && vessel.sog > SOG_MOTION_THRESHOLD)
        && distance > FALLBACK_LOW_SOG_MAX_DISTANCE) {
      // Låg-sog: båten har inte hunnit långt sedan passage, så stor distance
      // betyder att hon aldrig var nära bron — sannolikt felaktig passage-detektion.
      this.log(
        `🚫 [FALLBACK_TRIGGER_LOW_SOG_FAR] ${vessel.mmsi}: Skipping ${bridgeName} fallback `
        + `— ${Math.round(distance)}m with sog=${vessel.sog}kn (low-sog limit ${FALLBACK_LOW_SOG_MAX_DISTANCE}m)`,
      );
      return;
    }

    this.log(
      `⚠️ [FALLBACK_BOAT_NEAR] ${vessel.mmsi}: Passage of ${bridgeName} detected `
      + `without prior proximity trigger (distance=${Math.round(distance)}m) — firing failsafe`,
    );

    await this._triggerBoatNearFlowForBridge(vessel, {
      name: bridgeName,
      id: bridgeId,
      distance,
      source: 'passage-fallback',
    });
  }

  /**
   * Trigger the boat_near flow for a specific bridge candidate
   * @private
   */
  async _triggerBoatNearFlowForBridge(vessel, candidate) {
    const {
      name: bridgeName, id: bridgeId, distance, source,
    } = candidate;

    const dedupeKey = `${vessel.mmsi}:${bridgeName}`;
    // FÄLTPROV 2026-07-07 (kosmetiskt): fånga mmsi:t NU — vessel-objektet kan
    // nollställas av removal-race under await:andet nedan, vilket gav
    // "FLOW_TRIGGER_SUCCESS] null:" i loggen (notisen var äkta; 41h- och
    // 14h-körningarna hade var sin). Dedup-nyckeln var alltid korrekt.
    const mmsiLabel = vessel.mmsi;

    // R2 2026-07-11 (DIVR2-4): LAT SPEGEL av monitoring-prunens
    // sessionsnyckel-städning (prod-only 60s-intervall, osynlig för replay).
    // Prod-sekvensen: posten går ut → postprunen tar den → nyckeln för en
    // FRÅNVARANDE båt raderas. En båt vars spårningsepisod började EFTER
    // postens utgång hade alltså ingen nyckel i prod — i replay levde bägge
    // kvar och expired-gaten (movingNow) blockerade t.ex. den fartgivarlösa
    // returen PERMANENT: prod och batteri såg olika förhistoria och missen
    // låstes in i facit. Spegeln körs FÖRE has-kollen så orphan-fallet tar
    // exakt prod-vägen (.has()=false).
    if (this._triggeredBoatNearKeys.has(dedupeKey) && this._persistentRecentTriggers) {
      const rawEntry = this._persistentRecentTriggers.get(dedupeKey);
      const rawTs = typeof rawEntry === 'number' ? rawEntry : rawEntry && rawEntry.t;
      const winMs = this._PERSISTENT_DEDUP_WINDOW_MS || 2 * 60 * 60 * 1000;
      const entryExpired = Number.isFinite(rawTs) && (Date.now() - rawTs) >= winMs;
      if (entryExpired
          && Number.isFinite(vessel._trackingEpisodeStartTs)
          && vessel._trackingEpisodeStartTs > rawTs + winMs) {
        this._triggeredBoatNearKeys.delete(dedupeKey);
        this.log(
          `🧹 [FLOW_TRIGGER_DEDUPE_ORPHAN] ${dedupeKey}: session key predates this tracking `
          + 'episode and its entry has expired — treating as absent (prod-prune mirror)',
        );
      }
    }

    // ENHANCED DEDUPE DEBUG: Check if already triggered for this vessel+bridge combo
    if (this._triggeredBoatNearKeys.has(dedupeKey)) {
      // FÄLTPROV 2026-07-07 (ELFKUNGEN 12:05/12:37, 4 missade returnotiser):
      // riktningsundantaget fanns i PERSISTENT-lagret men inte här — och
      // sessionsnycklarna överlever removal i timmar (BUG7-bevarandet håller
      // nycklar med persistent motsvarighet), medan N2-återfödselrensningen
      // är död när _completedJourneys-posten prunats (15 min) långt före en
      // normal retur (ELFKUNGEN: 76 min). Spegla persistent-logikens beslut:
      // dokumenterat MOTSATT riktning ⇒ fysisk RETURPASSAGE ⇒ ny notis.
      // Persistent-posten bär riktningen ({t, dir}); saknas den (>2h) är
      // sessionsnyckeln uråldrig och 2h-fönstret ändå passerat → släpp.
      // ChatGPT-verifieringen 2026-07-10 (C3): en post ÄLDRE än 2h-fönstret
      // som ännu inte hunnit prunas av monitoring-cleanupen (60s-intervall)
      // räknas som UTGÅNGEN — _persistentDedupCheck behandlar den redan så,
      // men sessionssläppet krävde att posten var FYSISKT borttagen ur
      // mappen. En äkta ny passage strax efter 2h kunde då blockeras hela
      // prune-glappet och missas helt om båten hann korsa 300 m-zonen.
      const persistedRaw = this._persistentRecentTriggers
        ? this._persistentRecentTriggers.get(dedupeKey)
        : null;
      const persistedTs = typeof persistedRaw === 'number' ? persistedRaw : persistedRaw && persistedRaw.t;
      const persistedFresh = Number.isFinite(persistedTs)
        && (Date.now() - persistedTs) < (this._PERSISTENT_DEDUP_WINDOW_MS || 2 * 60 * 60 * 1000);
      const persisted = persistedFresh ? persistedRaw : null;
      const prevDir = persisted && persisted.dir ? persisted.dir : null;
      // F4-C (PIANO): flip-bedömningens NYA riktning kräver rörelsebevis
      const curDir = this._dedupDirection(vessel, { requireMovement: true });
      const oppositeDirection = prevDir && curDir && prevDir !== curDir;
      // F5-A (fältprov 5, PILOT 761): expired-släppet var ovillkorligt och
      // hade två rådataverifierade hål:
      //   (a) 08:25 — STILLALIGGAREN: lotsen parkerad 294 m från Stallbacka-
      //       bron (sog 0, ANCHOR_BLOCK) re-notifierades när 2h-posten
      //       prunades, trots att ingen ny passage förestod. Släppet kräver
      //       nu rörelsebevisad riktning — samma F4-C-princip som flip-grenen.
      //   (b) 11:32/11:33 — DUBBLETTEN: släppet avfyrade under OBEKRÄFTAD
      //       reversal (_newJourneyPending) med gamla riktningen i tokens;
      //       80 s senare rensade NEW_JOURNEY-bekräftelsen den färska
      //       nyckeln och avfyrade om. Under pending väntar släppet — den
      //       bekräftade reversalen äger notisen (rätt riktning, EN notis).
      // ChatGPT-verifieringen 2026-07-10 (C2): "curDir !== null" var inte
      // nog — en LÅST _routeDirection uppfyller det även vid sog 0 (låset
      // är från gamla resan och bevisar ingen NY passage). Intentionen var
      // rörelse I NUET: explicit fartkrav. Fönstret var realistiskt: dedup-
      // expiry (notis + 2h) infaller alltid före moored-2h-backstopen
      // (stillhetsstart + 2h) för en båt som stannat EFTER notisen.
      // Legitima >2h-returer i RÖRELSE (ELFKUNGEN-klassen, korpuslåsta)
      // uppfyller alla kraven och släpps som förut; fartgivarlösa returer
      // täcks av korsningsbevis-reversalen (NEW_JOURNEY rensar nycklarna).
      const movingNow = Number.isFinite(vessel.sog) && vessel.sog >= 2.0;
      // Fable-granskningen 2026-07-10b (scenario #44, PILOT-resume-hålet —
      // LATENT sedan C3): en båt som PASSERAT bron på innevarande resa,
      // parkerat >2h (posten utgången) och sedan ÅTERUPPTAR färden BORT
      // från bron uppfyllde rörelsekravet → fantomnotis utan ny passage.
      // C3 avslöjade hålet ("utgången = frånvarande" öppnar släppet även
      // där prune-timing tidigare råkade blockera). En bro i passedBridges
      // kan bara ge NY notis via ny resa (journey-reset rensar listan) —
      // äkta U-svängar går via flip-grenen (oppositeDirection, orörd) och
      // NEW_JOURNEY, aldrig via expired-släppet.
      // Fable R2 2026-07-11 (A4R2-2): en FÄRSKT registrerad passage av bron
      // (<2 min sedan stämpeln) bevisar NY passage — #44-gaten avser
      // PILOT-resume-klassen (timmegammal stämpel, båt som åker BORT), inte
      // en nyss bevisad korsning vars notisväg (BUG C-fallbacken) annars
      // föll på gaten när persistent-posten hunnit gå ut (>2h ankrad
      // sändande + återkorsning i sampel-hopp).
      const freshlyRecrossed = vessel.lastPassedBridge === bridgeName
        && Number.isFinite(vessel.lastPassedBridgeTime)
        && (Date.now() - vessel.lastPassedBridgeTime) < 2 * 60 * 1000;
      const alreadyPassedThisJourney = Array.isArray(vessel.passedBridges)
        && vessel.passedBridges.includes(bridgeName)
        && !freshlyRecrossed;
      const expiredRelease = !persisted && !oppositeDirection
        ? (curDir !== null && movingNow && !vessel._newJourneyPending && !alreadyPassedThisJourney)
        : false;
      if (oppositeDirection || (!persisted && expiredRelease)) {
        // R2 2026-07-11 (P2R2-4): radera INTE nyckeln om persistentgaten
        // nedströms ändå blockerar (60-min-retroaktivgaten) — nyckeln bär
        // #44-/expired-hold-skyddet, och en förlorad nyckel utan post
        // öppnade PILOT-fantomen på nytt efter 2h-prunen.
        if (oppositeDirection) {
          const retroSrc = source === 'passage-fallback' || source === 'just-passed';
          const verdict = this._persistentDedupCheck(dedupeKey, vessel, { retroactiveSource: retroSrc });
          if (verdict.blocked) {
            this.log(
              `🚫 [FLOW_TRIGGER_DEDUPE] ${vessel.mmsi}: flip for "${bridgeName}" blocked downstream `
              + `by persistent gate (${verdict.minutesSince} min) — keeping session key`,
            );
            return;
          }
        }
        this._triggeredBoatNearKeys.delete(dedupeKey);
        this.log(
          `🔁 [FLOW_TRIGGER_DEDUPE_DIRECTION] ${dedupeKey}: session key released `
          + `(${oppositeDirection ? `direction flipped ${prevDir} → ${curDir}` : 'no persistent entry (expired)'} `
          + '— treating as NEW passage)',
        );
      } else if (!persisted) {
        // Expired men utan rörelsebevis / under pending-reversal / redan
        // passerad på innevarande resa: blockera.
        let holdReason = 'no movement evidence (stationary vessel — no new passage)';
        if (vessel._newJourneyPending) {
          holdReason = 'reversal pending (confirmation owns the notification)';
        } else if (alreadyPassedThisJourney) {
          holdReason = 'bridge already passed this journey (no new passage without journey reset)';
        }
        this.log(
          `🚫 [FLOW_TRIGGER_DEDUPE_EXPIRED_HOLD] ${vessel.mmsi}: "${bridgeName}" dedup expired but `
          + `${holdReason} — keeping block`,
        );
        return;
      } else {
        this.log(
          `🚫 [FLOW_TRIGGER_DEDUPE] ${vessel.mmsi}: Already triggered for "${bridgeName}" `
          + `(source=${source}) - dedupe active (${this._triggeredBoatNearKeys.size} keys stored)`,
        );
        return;
      }
    }

    // F34: även persistent 2h-dedup i huvudvägen (speglar fallback-/exit-vägarna).
    // Vid STALE_AIS-removal tömps session-Set:en (_triggeredBoatNearKeys) men den
    // persistenta mappen lever kvar → utan denna check skulle en vessel som
    // återskapas inom 2h få DUBBELNOTIS för en bro hon redan notifierats om.
    // SÄKERT mot missade notiser: en äkta NEW_JOURNEY rensar persistent-mappen
    // (se _clearBoatNearTriggers(vessel, true)), så en legitim ny resa blockeras
    // inte.
    {
      // Fältprov 3: passage-fallback/just-passed är retroaktiva bekräftelser
      // — riktningsflip-undantaget kräver ≥15 min gammal post där (approach-
      // källor, source=current, behåller HALIFAX-semantiken).
      const isRetroactiveSource = source === 'passage-fallback' || source === 'just-passed';
      const mainDedup = this._persistentDedupCheck(dedupeKey, vessel, { retroactiveSource: isRetroactiveSource });
      if (mainDedup.blocked) {
        this.log(
          `🚫 [FLOW_TRIGGER_PERSISTENT_DEDUP] ${vessel.mmsi}: Skipping "${bridgeName}" `
          + `— triggered ${mainDedup.minutesSince} min ago (within 2h window)`,
        );
        return;
      }
    }

    // Create tokens with validated bridge name.
    // B1 (2026-07-03, ANVÄNDARBESLUT): fallback "Okänd båt" (svenska, läsbar)
    // när namnet aldrig blivit känt — cachen/statiska rapporter gör fallet
    // sällsynt. "Unknown" var aisstream-platshållaren, inte ett namn.
    const knownName = vessel.name && vessel.name !== 'Unknown' ? vessel.name : null;
    const tokens = {
      vessel_name: knownName || this._lookupVesselName(vessel.mmsi) || 'Okänd båt',
      bridge_name: bridgeName,
      direction: this._getDirectionString(vessel),
    };

    // ETA-token för notisen.
    // vessel.etaMinutes är ETA till MÅLBRON (Klaffbron/Stridsbergsbron). För en
    // notis om MÅLBRON är det rätt storhet. Men för en mellanbro / just-passad
    // bro / trigger-punkt (source ≠ 'target') är målbro-ETA fel — den kan vara
    // tiotals minuter medan båten är 80 m från den NOTIFIERADE bron.
    // Replay-fynd (2026-06-01): JOSEPHINE 80 m från Järnvägsbron fick ETA=68
    // (ETA till Klaffbron ~1 km bort). Beräkna i stället ETA mot den notifierade
    // brons faktiska avstånd för icke-target-kandidater.
    let eta = (source === 'target') ? vessel.etaMinutes : null;
    // E-F3/N9 (2026-07-01): för en REDAN PASSERAD bro (failsafe/just-passed)
    // är en framräknad "ETA" riktningslöst nonsens — dist/fart mäter tid till
    // en bro båten rör sig BORT ifrån (t.ex. "4 min" 700 m EFTER passagen).
    // -1 (okänd) är det ärliga tokenvärdet.
    const passedBridgeSource = source === 'passage-fallback' || source === 'just-passed';
    if (!passedBridgeSource && (!Number.isFinite(eta) || eta < 0)) {
      const dist = candidate.distance;
      const speedMs = (vessel.sog || 0) * 0.5144; // knop → m/s
      // För en icke-målbro där båten är nära OCH knappt rör sig (precis vid /
      // under bron) är en extrapolerad ETA till just den bron inte meningsfull
      // — hon är ju redan där. -1 (okänd) är ärligare än en stor siffra från
      // en nära-noll-fart-division.
      const nearAndSlow = source !== 'target' && dist < 150 && (vessel.sog || 0) < 1.0;
      if (!nearAndSlow && speedMs > 0.1 && Number.isFinite(dist)) {
        // E-F2 (2026-07-01): ingen förhandsavrundning — Math.round kunde ge
        // exakt 0 som isValidETA avvisar → token -1 för ett äkta imminent
        // ETA (t.ex. 27 s till bron). Skicka rå minuter; etaMinutesForDisplay
        // avrundar själv (samma semantik som target-källan).
        eta = (dist / speedMs) / 60; // minuter till den NOTIFIERADE bron
      }
    }
    // Round ETA for Flow tokens. No upper cap — post-fix ETA values are
    // trustworthy and users building Flow automations need accurate numbers.
    tokens.eta_minutes = etaMinutesForDisplay(eta) ?? -1;

    // CRITICAL FIX: Create DEEP immutable copy to prevent race conditions and object mutation
    const safeTokens = {
      vessel_name: String(tokens.vessel_name || 'Okänd båt'),
      bridge_name: String(tokens.bridge_name),
      direction: String(tokens.direction || 'unknown'),
    };

    safeTokens.eta_minutes = Number.isFinite(tokens.eta_minutes)
      ? tokens.eta_minutes
      : -1;

    // ChatGPT-granskningen 2026-07-10 (G1): additiv boolean-token så
    // flow-byggare slipper -1-sentinelens fotgevär (villkoret
    // "eta_minutes < 5" är annars sant även när ETA saknas). Semantiken
    // för eta_minutes är OFÖRÄNDRAD (-1 = okänd; korpuslåst i invariants).
    safeTokens.eta_available = safeTokens.eta_minutes >= 0;

    // ENHANCED DEBUG: Log final tokens and ETA status
    this.debug(`🔍 [FLOW_TRIGGER_SAFE_TOKENS] ${vessel.mmsi}: Safe tokens = ${JSON.stringify(safeTokens)}`);
    if (safeTokens.eta_minutes === -1) {
      this.debug(`⚠️ [FLOW_TRIGGER_ETA] ${vessel.mmsi}: ETA unavailable - sending eta_minutes=-1 to flow`);
    } else {
      this.debug(`✅ [FLOW_TRIGGER_ETA] ${vessel.mmsi}: ETA available - sending eta_minutes=${safeTokens.eta_minutes} to flow`);
    }

    this.log(
      `🚀 [FLOW_TRIGGER_ATTEMPT] ${vessel.mmsi}: bridge=${bridgeName} (${Math.round(distance)}m, source=${source}), `
      + `direction=${safeTokens.direction}, ETA=${safeTokens.eta_minutes}`,
    );

    // P2-3 (Fable 2026-07-10b): fånga en ev. FÖREXISTERANDE persistent-post
    // (flip-släppets väg skriver ÖVER en giltig färsk post med motsatt
    // riktning) så catch-rollbacken kan ÅTERSTÄLLA den i stället för att
    // radera — radering öppnade för re-notis av URSPRUNGSpassagen inom
    // 2h-fönstret om båten vobblade tillbaka efter ett trigger-fel.
    const previousPersistentEntry = this._persistentRecentTriggers
      ? this._persistentRecentTriggers.get(dedupeKey)
      : undefined;
    // R2 2026-07-11 (DIVR2-3): referens till VÅR egen post — rollbacken får
    // bara röra tillståndet om det fortfarande är vårt (ett mellanliggande
    // flip-släpp under awaiten kan ha avfyrat en NY legitim notis vars
    // nyckel/post rollbacken annars klobbade → dubblettrisk).
    let ownPersistentEntry = null;
    try {
      // RACE FIX: Sätt dedup-nyckel FÖRE async trigger för att förhindra
      // att parallella _onVesselUpdated-anrop slipper igenom.
      this._triggeredBoatNearKeys.add(dedupeKey);
      // Anomali 9 fix: lagra också i persistent map som inte clearas vid
      // vessel-removal — för 2h-dedup vid skipped-bridges-fallback.
      // Defensive: vissa testkonstruktorer hoppar över app-init, så map kan saknas.
      if (this._persistentRecentTriggers) {
        // Riktningen lagras så en returresa (motsatt riktning) inom 2h inte
        // blockeras efter omstart (ELFKUNGEN-fallet 2026-07-02).
        ownPersistentEntry = { t: Date.now(), dir: this._dedupDirection(vessel) };
        this._persistentRecentTriggers.set(dedupeKey, ownPersistentEntry);
        this._persistRecentTriggers(); // P2: överlev omstart
      }

      // F7: carry mmsi in the trigger state so the run-listener can scope an
      // "Any bridge" flow to ONE notification per vessel journey instead of one
      // per bridge candidate. distance/source ingår så replay-invarianterna
      // kan bedöma distansrimlighet och särskilja inferens-notiser.
      await this._triggerBoatNearFlowBest(safeTokens, {
        bridge: bridgeId, mmsi: vessel.mmsi, distance: Math.round(distance), source,
      }, vessel);

      // B8 (körning 2026-07-03, F6): vessel.status beskriver båtens läge mot
      // hennes AKTUELLA målbro — för en failsafe-notis om en annan/passerad
      // bro blev loggen missvisande ("under-bridge" @854 m). Märk fallback-
      // notiser som passage-inferred i stället.
      const logStatus = source === 'passage-fallback' && distance > 300
        ? 'passage-inferred'
        : vessel.status;
      this.log(
        `✅ [FLOW_TRIGGER_SUCCESS] ${mmsiLabel}: boat_near fired for ${bridgeName} `
        + `(ID=${bridgeId}, distance=${Math.round(distance)}m, status=${logStatus})`,
      );

      this.debug(`🔒 [FLOW_TRIGGER_DEDUPE_SET] ${vessel.mmsi}: Added "${dedupeKey}" to dedupe set (total keys: ${this._triggeredBoatNearKeys.size})`);
    } catch (triggerError) {
      // DIVR2-3 (R2 2026-07-11): rulla bara tillbaka VÅRT tillstånd — har
      // ett mellanliggande släpp skrivit en nyare post under awaiten äger
      // den notisen dedupen nu.
      const currentEntry = this._persistentRecentTriggers
        ? this._persistentRecentTriggers.get(dedupeKey)
        : undefined;
      const stateIsOurs = !this._persistentRecentTriggers || currentEntry === ownPersistentEntry;
      if (stateIsOurs) {
        // Rensa dedup-nyckeln vid misslyckad trigger så att retry kan ske
        this._triggeredBoatNearKeys.delete(dedupeKey);
        // F6: spegla rollbacken även för den persistenta 2h-nyckeln. Annars
        // markeras en notis som ALDRIG levererades som "nyligen skickad", vilket
        // tystar failsafe-/skipped-bridges-skyddsnätet i upp till 2 timmar.
        // P2-3: rollback = ÅTERSTÄLL föregående tillstånd — fanns en giltig
        // post före överskrivningen (flip-släppet) ska den tillbaka, inte bort.
        if (this._persistentRecentTriggers) {
          if (previousPersistentEntry !== undefined) {
            this._persistentRecentTriggers.set(dedupeKey, previousPersistentEntry);
          } else {
            this._persistentRecentTriggers.delete(dedupeKey);
          }
          this._persistRecentTriggers(); // P2: håll persisterat tillstånd i synk
        }
      } else {
        this.log(
          `🔒 [FLOW_TRIGGER_ROLLBACK_SKIPPED] ${vessel.mmsi}: "${bridgeName}" dedup state `
          + 'was rewritten by a newer notification during the failed trigger — leaving it intact',
        );
      }
      this.error(
        `❌ [FLOW_TRIGGER_ERROR] ${vessel.mmsi}: boat_near failed for ${bridgeName} `
        + `(ID=${bridgeId}, distance=${Math.round(distance)}m, status=${vessel.status}): ${triggerError.message || triggerError}`,
      );
      this.error(`❌ [FLOW_TRIGGER_ERROR_TOKENS] Failed tokens: ${JSON.stringify(safeTokens)}`);
      this.error(`❌ [FLOW_TRIGGER_ERROR_STATE] State: { bridge: "${bridgeId}" }`);
      if (triggerError.stack) {
        this.error(`❌ [FLOW_TRIGGER_ERROR_STACK] ${triggerError.stack}`);
      }
    }
  }

  /**
   * Clear boat near triggers when vessel leaves area or changes status
   * @private
   */
  _clearBoatNearTriggers(vessel, clearPersistent = false, opts = {}) {
    // ENHANCED DEBUG: Start trigger clearing
    this.debug(`🧹 [TRIGGER_CLEAR_START] ${vessel.mmsi}: Clearing boat_near triggers...`);

    // P2-1 (Fable 2026-07-10b): N2-reentryns selektivitet — en nyckel vars
    // persistenta post är färskare än gränsen tillhör det PÅGÅENDE benet
    // (notifierad under cooldownen) och ska överleva resetten i BÅDA lagren.
    const preserveMs = Number.isFinite(opts.preserveFreshPersistentMs)
      ? opts.preserveFreshPersistentMs
      : null;
    const isFreshPost = (key) => {
      if (preserveMs === null || !this._persistentRecentTriggers) return false;
      const raw = this._persistentRecentTriggers.get(key);
      const ts = typeof raw === 'number' ? raw : raw && raw.t;
      return Number.isFinite(ts) && (Date.now() - ts) < preserveMs;
    };

    // Clear all trigger keys for this vessel
    const keysToRemove = [];
    for (const key of this._triggeredBoatNearKeys) {
      if (key.startsWith(`${vessel.mmsi}:`) && !isFreshPost(key)) {
        keysToRemove.push(key);
      }
    }

    if (keysToRemove.length > 0) {
      // ENHANCED DEBUG: Log which keys are being cleared
      this.debug(`🧹 [TRIGGER_CLEAR_KEYS] ${vessel.mmsi}: Removing keys: ${keysToRemove.join(', ')}`);

      keysToRemove.forEach((key) => this._triggeredBoatNearKeys.delete(key));

      this.debug(`✅ [TRIGGER_CLEAR_SUCCESS] ${vessel.mmsi}: Cleared ${keysToRemove.length} boat_near triggers (remaining keys: ${this._triggeredBoatNearKeys.size})`);
    } else {
      this.debug(`ℹ️ [TRIGGER_CLEAR_NONE] ${vessel.mmsi}: No boat_near triggers to clear`);
    }

    // F34: clearPersistent rensar ÄVEN den persistenta 2h-dedup-mappen. Detta
    // görs ENDAST vid en bekräftad NEW_JOURNEY (riktningsvändning) — INTE vid
    // ordinarie status-rensning under en pågående resa (då ska persistent-
    // skyddsnätet leva kvar). Utan detta skulle persistent-dedupen blockera
    // notiser för den NYA resans broar i upp till 2h → MISSAD notis (värre än
    // den dubblett F34 åtgärdar).
    if (clearPersistent && this._persistentRecentTriggers) {
      const persistentToRemove = [];
      for (const key of this._persistentRecentTriggers.keys()) {
        if (key.startsWith(`${vessel.mmsi}:`) && !isFreshPost(key)) {
          persistentToRemove.push(key);
        }
      }
      persistentToRemove.forEach((key) => this._persistentRecentTriggers.delete(key));
      if (persistentToRemove.length > 0) {
        this._persistRecentTriggers(); // P2: håll persisterat tillstånd i synk
        this.debug(`🧹 [TRIGGER_CLEAR_PERSISTENT] ${vessel.mmsi}: Cleared ${persistentToRemove.length} persistent dedup keys (new journey)`);
      }
    }
  }

  /**
   * Senast BEKRÄFTADE positionsrapport (F4-E, fältprov 4 2026-07-09, SOKERI):
   * max(timestamp, lastPositionUpdate). vessel.timestamp stämplas för varje
   * bearbetat positionsmeddelande (_createVesselObject) medan
   * lastPositionUpdate bara följer positionsÄNDRINGAR — en väntande båt vid
   * bron (sog 0, sänder var ~3:e min) åldrades falskt förbi 600 s-tröskeln
   * och fick "ETA okänd" mitt i kön. RC1-mönstret (removal/display-vägarna
   * i VesselDataService) använder redan samma max-klocka.
   * @param {Object} vessel - Vesselobjekt
   * @returns {number} epoch-ms för senast bekräftade position (0 om okänd)
   * @private
   */
  _lastConfirmedPositionMs(vessel) {
    return Math.max(vessel.timestamp || 0, vessel.lastPositionUpdate || 0);
  }

  /**
   * Get human-readable direction string based on vessel's course over ground
   * @param {Object} vessel - Vessel object
   * @param {number} vessel.cog - Course over ground in degrees (0-359)
   * @returns {string} Direction string: 'northbound', 'southbound', or 'unknown'
   * @private
   */
  _getDirectionString(vessel) {
    // PRIMÄRT: den latch-låsta ruttriktningen. Den sätts av _lockRouteDirection /
    // målbro-logiken och överlever stillastående/COG-brus — vilket gör den
    // betydligt mer tillförlitlig än momentan COG för notis-token.
    // Replay-fynd (2026-06-01): en sydgående båt som ankrar vid en mellanbro
    // (sog≈0, brus-COG) fick fel/'unknown' riktning när vi bara läste COG.
    const routeDir = vessel._finalTargetDirection || vessel._routeDirection;
    if (routeDir === 'north') return 'northbound';
    if (routeDir === 'south') return 'southbound';

    // FALLBACK: COG, men endast när farten är mätbar. Vid sog < MINIMUM_VIABLE_SPEED
    // är COG brus (en stillaliggande båt kan rapportera vilken kurs som helst) →
    // returnera 'unknown' i stället för en gissning.
    if (vessel.cog == null || !Number.isFinite(vessel.cog) || vessel.cog < 0 || vessel.cog >= 360) {
      return 'unknown';
    }
    if (Number.isFinite(vessel.sog) && vessel.sog < MIN_VIABLE_SPEED_KN) {
      return 'unknown';
    }

    if (vessel.cog >= COG_DIRECTIONS.NORTH_MIN || vessel.cog <= COG_DIRECTIONS.NORTH_MAX) {
      return 'northbound';
    }
    // Sydband 135–270°: i den NE–SV-orienterade kanalen är sydväst-kurser
    // (226–270°) normal sydfärd. Tidigare 135–225° gav felaktigt 'unknown'
    // för en bevisligen sydgående båt med COG 226.7° (JOSEPHINE @09:46,
    // replay-fynd). Öst-kurser (46–134°) förblir 'unknown'.
    // FP8 (2026-07-13, 219034975): toppen snävad 314→270 — COG 314.7° (NV,
    // 0.3° från nordbandet) fick token 'southbound' för en båt vid Kanal-
    // infarten som sannolikt var på väg IN. Empiri över tre körningar
    // (136+ h): äkta nordgående in vid infarten har COG 28–33°, äkta syd-
    // gående 135–245°; INGEN legitim kanalfärd använder 270–314° (de enda
    // träffarna låg ute på älven söder om punkten, utanför alla zoner).
    // VNV–NV (271–314°) är tvetydigt → 'unknown' är den ärliga tokenen.
    if (vessel.cog > COG_DIRECTIONS.NORTH_MAX && vessel.cog < COG_DIRECTIONS.NORTH_MIN
        && vessel.cog >= 135 && vessel.cog <= 270) {
      return 'southbound';
    }
    return 'unknown';
  }

  /**
   * Normalize flow bridge arguments/state to canonical string IDs
   * @param {any} value - Bridge argument (string or object with id)
   * @returns {string|null} Normalized bridge id or null if unavailable
   * @private
   */
  _normalizeBridgeArgument(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      return value.trim() || null;
    }
    if (typeof value === 'object') {
      if (typeof value.id === 'string') {
        return value.id.trim() || null;
      }
      if (typeof value.name === 'string') {
        // Convert display name to id if possible
        return BRIDGE_NAME_TO_ID[value.name] || value.name.trim() || null;
      }
    }
    return null;
  }

  /**
   * Initialize global flow token (with crash protection)
   * @private
   */
  async _initGlobalToken() {
    try {
      if (!this._globalBridgeTextToken) {
        // ChatGPT-granskning 2 (CG2-12c, 2026-07-11): bounded. onInit
        // awaitar den här metoden FÖRE _startConnection/_setupMonitoring —
        // en hängande createToken (ej rejection; try/catch fångar bara
        // rejection) stallade hela appstarten utan AIS och utan watchdog.
        // Publiceringsvägen fick 10 s-vakten i A2R2-2; init-vägen var
        // asymmetriskt oskyddad.
        let createTimer = null;
        try {
          this._globalBridgeTextToken = await Promise.race([
            this.homey.flow.createToken('global_bridge_text', {
              type: 'string',
              title: 'Bridge Text',
            }),
            new Promise((resolve, reject) => {
              createTimer = setTimeout(() => reject(new Error('createToken(global_bridge_text) svarade inte inom 10 s')), 10 * 1000);
              if (createTimer && typeof createTimer.unref === 'function') createTimer.unref();
            }),
          ]);
        } finally {
          clearTimeout(createTimer);
        }
      }
      // BT-F8 (2026-07-01): vid appstart är _lastBridgeText fortfarande '' —
      // flows som läser global_bridge_text före första UI-uppdateringen ska
      // få DEFAULT-meddelandet, inte tom sträng.
      // CG2-12c: setValue går via _setGlobalTokenSafe (10 s-race +
      // sen-landningshantering) i stället för naken await.
      await this._setGlobalTokenSafe(
        this._lastBridgeText || BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE,
      );
    } catch (error) {
      this.error('Error initializing global token:', error);
      // Global tokens are optional - don't crash
    }
  }

  /**
   * Setup flow cards (with crash protection)
   * @private
   */
  async _setupFlowCards() {
    try {
      // Trigger cards
      // FIX: Use getTriggerCard for app-wide triggers (not device-specific)
      this.log('🔧 [FLOW_SETUP] Attempting to get boat_near trigger card...');
      this._boatNearTrigger = this.homey.flow.getTriggerCard('boat_near');

      // CRITICAL DEBUG: Verify trigger was properly initialized
      this.log('🔍 [FLOW_DEBUG] _boatNearTrigger initialized:', !!this._boatNearTrigger);
      this.log('🔍 [FLOW_DEBUG] _boatNearTrigger type:', typeof this._boatNearTrigger);
      this.log('🔍 [FLOW_DEBUG] _boatNearTrigger has trigger method:', typeof this._boatNearTrigger?.trigger);

      if (!this._boatNearTrigger) {
        this.error('❌ [FLOW_CRITICAL] boat_near trigger not found - flows WILL NOT work!');
        this.error('❌ [FLOW_CRITICAL] This is why you are not getting notifications!');
      } else {
        this.log('✅ [FLOW_SUCCESS] boat_near trigger successfully initialized');

        // Register robust run listener so Homey can match trigger arguments
        this._boatNearTrigger.registerRunListener(async (args, state) => {
          try {
            const selectedBridge = this._normalizeBridgeArgument(args?.bridge);
            const stateBridge = this._normalizeBridgeArgument(state?.bridge);

            // "Alla broar"-semantik (ANVÄNDARBESLUT 2026-07-02, 11h-körningen):
            // flowen ska trigga vid VARJE bro — inte en gång per resa som
            // F7-gaten gjorde (den behandlade per-bro-notiserna som
            // "duplikat"). Dedup sker redan UPPSTRÖMS per mmsi:bro
            // (_triggeredBoatNearKeys + persistent 2h-mappen), så varje
            // trigger()-anrop som når hit är en redan deduplicerad
            // per-bro-händelse → max EN notis per bro och resa, upp till
            // 6 för en full genomresa. mmsi:any-nyckeln är borttagen.
            if (selectedBridge === 'any') {
              return true;
            }

            // If no specific bridge provided, fail safe (prevents accidental matches)
            if (!selectedBridge) {
              this.debug('❌ [FLOW_RUN_LISTENER] Missing selected bridge in args, rejecting trigger');
              return false;
            }

            if (!stateBridge) {
              this.debug('❌ [FLOW_RUN_LISTENER] Missing bridge in trigger state, rejecting trigger');
              return false;
            }

            const matches = selectedBridge === stateBridge;
            this.debug(
              `🎯 [FLOW_RUN_LISTENER] Comparing Flow bridge "${selectedBridge}" `
              + `with trigger state "${stateBridge}" → ${matches}`,
            );
            return matches;
          } catch (error) {
            this.error('❌ [FLOW_RUN_LISTENER] Error while matching boat_near trigger:', error);
            return false;
          }
        });
      }

      // Condition cards
      const boatRecentCondition = this.homey.flow.getConditionCard('boat_at_bridge');
      boatRecentCondition.registerRunListener(async (args) => {
        try {
          // ENHANCED DEBUG: Start condition evaluation
          this.debug(`🎯 [CONDITION_START] boat_at_bridge: Evaluating condition with args=${JSON.stringify(args)}`);

          // Input validation - ensure bridge parameter exists and is valid
          if (!args || args.bridge == null) {
            this.debug(`❌ [CONDITION_INVALID_ARGS] boat_at_bridge: Missing bridge parameter - args=${JSON.stringify(args)}`);
            return false;
          }

          let bridgeIdOrName;
          if (typeof args.bridge === 'string') {
            bridgeIdOrName = args.bridge.trim();
          } else if (typeof args.bridge === 'object' && typeof args.bridge.id === 'string') {
            bridgeIdOrName = args.bridge.id.trim();
          } else {
            this.debug(`❌ [CONDITION_INVALID_ARGS] boat_at_bridge: Unsupported bridge parameter type - args=${JSON.stringify(args)}`);
            return false;
          }

          if (!bridgeIdOrName) {
            this.debug(`❌ [CONDITION_INVALID_ARGS] boat_at_bridge: Empty bridge parameter - args=${JSON.stringify(args)}`);
            return false;
          }

          this.debug(`🔍 [CONDITION_DEBUG] boat_at_bridge: Checking for bridge parameter="${bridgeIdOrName}"`);

          // Validate bridge parameter against known values
          const validBridgeIds = Object.keys(BRIDGE_ID_TO_NAME).concat(['any']);
          const normalizedBridgeId = validBridgeIds.includes(bridgeIdOrName)
            ? bridgeIdOrName
            : BRIDGE_NAME_TO_ID[bridgeIdOrName];

          if (!normalizedBridgeId || !validBridgeIds.includes(normalizedBridgeId)) {
            this.debug(
              `❌ [CONDITION_INVALID_BRIDGE] boat_at_bridge: Unknown bridge "${bridgeIdOrName}". `
              + `Valid IDs: ${validBridgeIds.join(', ')}`,
            );
            return false;
          }

          const bridgeId = normalizedBridgeId;

          const allVessels = this.vesselDataService.getAllVessels();
          this.debug(`🔍 [CONDITION_VESSELS] boat_at_bridge: Checking ${allVessels?.length || 0} vessels`);

          // Safety check - ensure vessels array exists
          if (!Array.isArray(allVessels)) {
            this.debug(`❌ [CONDITION_INVALID_VESSELS] boat_at_bridge: allVessels is not an array - type=${typeof allVessels}`);
            return false;
          }

          // Check if any vessel is within 300m of the specified bridge
          const result = allVessels.some((vessel) => {
            // Validate vessel object
            if (!vessel || typeof vessel !== 'object') {
              this.debug('boat_at_bridge condition: invalid vessel object:', vessel);
              return false;
            }

            // ChatGPT-granskningen 2026-07-10 (G2): spegla notis-/brotext-
            // vägarnas behörighetsgater. Utan dessa håller en kajförtöjd båt
            // (som sänder AIS för evigt inom 300 m från bron), en GPS-hopp-
            // spärrad båt eller en död sändare villkoret sant långt efter
            // att notiser/brotext slutat räkna med henne.
            if (vessel._moored === true) {
              return false;
            }
            if (this.vesselDataService
                && typeof this.vesselDataService.hasGpsJumpHold === 'function'
                && this.vesselDataService.hasGpsJumpHold(vessel.mmsi)) {
              return false;
            }
            const lastHeardMs = Math.max(vessel.timestamp || 0, vessel.lastPositionUpdate || 0);
            if (lastHeardMs > 0
                && Date.now() - lastHeardMs > UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS) {
              return false;
            }

            // Get proximity data with comprehensive validation
            const proximityData = this.proximityService.analyzeVesselProximity(vessel);

            // Validate proximityData structure
            if (!proximityData || typeof proximityData !== 'object') {
              this.debug(`boat_at_bridge condition: invalid proximityData for vessel ${vessel.mmsi || 'unknown'}`);
              return false;
            }

            // Ensure bridges array exists and is valid
            if (!Array.isArray(proximityData.bridges)) {
              this.debug(`boat_at_bridge condition: proximityData.bridges is not an array for vessel ${vessel.mmsi || 'unknown'}`);
              return false;
            }

            if (bridgeId === 'any') {
            // Check if vessel is within 300m of ANY bridge
              // ANVÄNDARBESLUT 2026-07-10: "any" betyder MEDVETET bara riktiga
              // broar. Kanalinfarten är ingen bro utan en nöjes-triggerpunkt —
              // den nås ENBART via det specifika dropdown-valet (F36-fallbacken
              // nedan). ChatGPT-granskningens G2-förslag att inkludera den i
              // "any" prövades och DROGS TILLBAKA på användarens begäran.
              return proximityData.bridges.some((bridge) => {
                return bridge
                     && typeof bridge === 'object'
                     && Number.isFinite(bridge.distance)
                       && bridge.distance <= FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD;
              });
            }

            // Check if vessel is within 300m of SPECIFIC bridge
            // Use centralized bridge ID mapping from constants
            const actualBridgeName = BRIDGE_ID_TO_NAME[bridgeId];
            if (!actualBridgeName) {
              this.error(`boat_at_bridge condition: No bridge name mapping found for ID "${bridgeId}"`);
              return false;
            }

            // Find specific bridge data with validation
            const bridgeData = proximityData.bridges.find((bridge) => bridge
              && typeof bridge === 'object'
              && bridge.name === actualBridgeName);

            // Validate bridge data and distance
            if (!bridgeData || !Number.isFinite(bridgeData.distance)) {
              // F36: trigger-points (Kanalinfarten) är giltiga dropdown-val men
              // ligger INTE i proximityData.bridges (bara riktiga broar finns där),
              // så villkoret kunde aldrig bli sant för Kanalinfarten. Spegla
              // notis-vägen: beräkna avstånd direkt mot TRIGGER_POINTS.
              if (Number.isFinite(vessel.lat) && Number.isFinite(vessel.lon)) {
                for (const tp of Object.values(TRIGGER_POINTS)) {
                  if (tp.name === actualBridgeName
                      && Number.isFinite(tp.lat) && Number.isFinite(tp.lon)) {
                    const tpDist = geometry.calculateDistance(
                      vessel.lat, vessel.lon, tp.lat, tp.lon,
                    );
                    return Number.isFinite(tpDist)
                      && tpDist <= FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD;
                  }
                }
              }
              return false;
            }

            const isWithinRange = bridgeData.distance <= FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD;
            if (isWithinRange) {
              this.debug(`✅ [CONDITION_MATCH] boat_at_bridge: Vessel ${vessel.mmsi} is ${bridgeData.distance.toFixed(0)}m from ${actualBridgeName} (≤300m)`);
            }
            return isWithinRange;
          });

          // ENHANCED DEBUG: Log final condition result
          this.debug(`🎯 [CONDITION_RESULT] boat_at_bridge: bridge="${bridgeId}" → ${result} (checked ${allVessels.length} vessels)`);
          return result;

        } catch (error) {
          this.error('❌ [CONDITION_ERROR] Unexpected error in boat_at_bridge flow condition:', error.message || error);
          this.error('❌ [CONDITION_ERROR_STACK] Stack trace:', error.stack);
          return false; // Safe default - condition fails on error
        }
      });

      this.log('✅ Flow cards configured');

      // Optional self-test: only run when explicitly enabled
      const selfTestEnabled = process.env.AIS_BRIDGE_SELFTEST === 'true';
      if (process.env.NODE_ENV === 'test' || global.__TEST_MODE__) {
        this.debug('🧪 [TRIGGER_TEST] Test mode detected - skipping automatic trigger self-test');
      } else if (selfTestEnabled) {
        // Produktionsredo (2026-07-03): spåra timern så onUninit kan rensa.
        this._selfTestTimer = setTimeout(() => {
          this._selfTestTimer = null;
          this._testTriggerFunctionality();
        }, 5000);
      } else {
        this.log('ℹ️ [TRIGGER_TEST] Automatic self-test disabled (set AIS_BRIDGE_SELFTEST=true to enable)');
      }
    } catch (error) {
      this.error('Error setting up flow cards:', error);
      // Flow cards are optional - don't crash the app
    }
  }

  /**
   * Test trigger functionality with minimal test case
   * @private
   */
  async _testTriggerFunctionality() {
    try {
      this.log('🧪 [TRIGGER_TEST] Starting trigger functionality test...');

      const testTokens = {
        vessel_name: 'TEST_VESSEL',
        bridge_name: 'Klaffbron',
        direction: 'northbound',
        eta_minutes: 5,
        eta_available: true,
      };

      const testState = { bridge: 'klaffbron' };

      if (this._boatNearTrigger && typeof this._boatNearTrigger.trigger === 'function') {
        this.log('🧪 [TRIGGER_TEST] Testing app-level trigger...');
        await this._boatNearTrigger.trigger(testTokens, testState);
        this.log('✅ [TRIGGER_TEST] App-level trigger test SUCCESSFUL!');
      } else {
        this.error('❌ [TRIGGER_TEST] App-level trigger NOT WORKING');
      }

      // Note: Device-level trigger removed - app uses app-level triggers only

      // Test condition card registration
      this.log('🧪 [CONDITION_TEST] Verifying boat_at_bridge condition registration...');
      const conditionCard = this.homey.flow.getConditionCard('boat_at_bridge');
      if (conditionCard) {
        this.log('✅ [CONDITION_TEST] boat_at_bridge condition card successfully retrieved');
        this.log('🔍 [CONDITION_TEST] Condition card type:', typeof conditionCard);
        this.log('🔍 [CONDITION_TEST] Available methods:', Object.getOwnPropertyNames(conditionCard).filter((name) => typeof conditionCard[name] === 'function'));

        // Note: Condition cards are evaluated by the Flow engine when used in flows
        // They cannot be directly "triggered" like trigger cards
        this.log('✅ [CONDITION_TEST] Condition card is properly registered and ready for Flow evaluation');
      } else {
        this.error('❌ [CONDITION_TEST] boat_at_bridge condition card not found!');
      }
    } catch (error) {
      this.error('❌ [TRIGGER_TEST] Trigger test failed:', error.message);
      this.error('❌ [TRIGGER_TEST] This confirms why flows are not working!');
    }
  }

  /**
   * Start AIS connection
   * @private
   */
  async _startConnection() {
    try {
      // Skip AIS connection in test environment
      if (process.env.NODE_ENV === 'test' || global.__TEST_MODE__) {
        this.log('🧪 [TEST] Skipping AIS connection in test mode');
        this._isConnected = false;
        return;
      }

      const apiKey = this.homey.settings.get('ais_api_key');

      if (!apiKey) {
        this.log('⚠️ [AIS_CONNECTION] No API key configured - using development mode');
        this._isConnected = false;

        // B3-fix (2026-06-09): synliggör för användaren att appen inte tar
        // emot data — tidigare loggades detta bara och appen såg "frisk" ut.
        this._updateDeviceCapability('connection_status', 'disconnected');
        if (process.env.NODE_ENV !== 'development') {
          this._notifyConnectionIssue(
            'AIS Tracker: ingen API-nyckel är konfigurerad — appen tar inte emot '
            + 'båtdata. Lägg in din AISstream.io-nyckel i appens inställningar.',
          );
        }

        // Simulate test data in development
        if (process.env.NODE_ENV === 'development') {
          this._simulateTestData();
        }
        return;
      }

      this.log('🌐 [AIS_CONNECTION] Starting AIS stream connection...');

      // Event handlers are already set up in _setupEventHandlers()
      // Just start the connection
      await this.aisClient.connect(apiKey);

    } catch (error) {
      this.error('Error starting AIS connection:', error);
      this._isConnected = false;

      // Fallback to simulation in development
      if (process.env.NODE_ENV === 'development') {
        this._simulateTestData();
      }
    }
  }

  /**
   * Simulate test data for development
   * @private
   */
  _simulateTestData() {
    // Helgranskning 2026-07-06 (app-8#2): spåra timern så onUninit kan rensa
    // den — annars fyrar den mot delvis nedrivna tjänster vid snabb
    // avinitiering (endast utvecklingsläge, hygien).
    this._simulateTestDataTimer = setTimeout(() => {
      this._processAISMessage({
        mmsi: '123456789',
        msgType: 1,
        lat: 58.284,
        lon: 12.284,
        sog: 3.5,
        cog: 45,
        shipName: 'Test Vessel 1',
      });

      this._processAISMessage({
        mmsi: '987654321',
        msgType: 1,
        lat: 58.293,
        lon: 12.295,
        sog: 2.1,
        cog: 225,
        shipName: 'Test Vessel 2',
      });
    }, 5000);
  }

  /**
   * Capture AIS data for replay if AIS_REPLAY_CAPTURE_FILE is set.
   * @private
   * @param {Object} sample - Normalized AIS sample
   */
  _captureAISReplaySample(sample) {
    // Helgranskning 2026-07-06 (app-2#R2-2): den ovillkorliga stdout-raden
    // spammade Homeys app-logg med VARJE AIS-meddelande i publicerad drift
    // (tiotusentals rader/dygn — dränker verklig diagnostik och sliter på
    // enheten). Replay-fångsten gatar nu på debug_level='full', som är det
    // dokumenterade läget för valideringskörningar (run-with-logs.sh varnar
    // aktivt om raderna uteblir). Fil-fångstvägen (env, lokal körning)
    // fungerar oberoende av debugnivån.
    const replayLoggingEnabled = this.debugLevel === 'full' || this._replayCaptureFile;
    if (!this._replayCaptureFile || !sample || !sample.mmsi) {
      if (replayLoggingEnabled && sample && sample.mmsi) {
        this.log('[AIS_REPLAY_SAMPLE]', JSON.stringify(sample));
      }
      return;
    }

    const payload = {
      ...sample,
      receivedAt: sample.receivedAt || new Date().toISOString(),
    };

    // Emit to stdout as well for belt-and-braces capture when filesystem is sandboxed
    this.log('[AIS_REPLAY_SAMPLE]', JSON.stringify(payload));

    fs.appendFile(this._replayCaptureFile, `${JSON.stringify(payload)}\n`, (err) => {
      if (err && !this._replayCaptureErrorLogged) {
        this._replayCaptureErrorLogged = true;
        this.error('⚠️ [AIS_REPLAY] Failed to write replay sample:', err.message);
      }
    });
  }

  /**
   * B2-fix (2026-06-09): stale-feed-watchdog. Ping/pong i AISStreamClient
   * fångar död TCP-socket, men INTE fallet "socket lever, pong svarar, men
   * inga AIS-meddelanden" (tappad subscription, misslyckad subscribe-send,
   * server slutat skicka, nyckel ogiltigförklarad utan fel-meddelande).
   * Tystnaden mäts på AKTUELL anslutning: min(tid sedan senaste meddelande,
   * uptime) — så en nyss omansluten socket får alltid ett helt fönster innan
   * nästa ingripande. Åtgärden återanvänder reconnectWithKey() som är härdad
   * mot dubbla sockets/zombie-reconnects.
   * @private
   */
  _checkAISFeedHealth() {
    try {
      if (!this.aisClient
          || !this.aisClient.isConnected
          || typeof this.aisClient.getConnectionStats !== 'function') {
        return;
      }

      const stats = this.aisClient.getConnectionStats();
      const sinceMessage = Number.isFinite(stats.timeSinceLastMessage)
        ? stats.timeSinceLastMessage
        : Infinity; // aldrig fått något meddelande → räkna från uppkoppling
      const silenceMs = Math.min(sinceMessage, stats.uptime || 0);

      const staleBase = UI_CONSTANTS.STALE_FEED_RECONNECT_MS || 20 * 60 * 1000;
      if (silenceMs < staleBase) {
        // Helgranskning 2026-07-06 (app-8#1): nollställ backoffen ENDAST på
        // riktig data (sinceMessage), inte på ung socket. Efter varje tyst
        // reconnect nollställdes openedAt → silenceMs≈uptime<staleBase →
        // strikes=0 → eskaleringen 20→40→80→120 min kunde ALDRIG ske och
        // watchdogen reconnectade var 20:e minut för evigt på tyst kanal —
        // exakt den 503-churn RC-S2 skulle stoppa. silenceMs (min:ad mot
        // uptime) styr fortfarande SJÄLVA ingripandet, så en nyss omansluten
        // socket får alltid ett helt tyst fönster innan nästa försök.
        if (sinceMessage < staleBase) {
          this._feedWatchdogStrikes = 0;
        }
        return;
      }

      // RC-S2 (2026-06-12): exponentiell tystnads-backoff. Körningen 2026-06-11
      // visade 10 watchdog-omanslutningar på 4h tyst kanal (var 20:e minut) —
      // onödig churn mot servern (och möjligt bidrag till deras 503-rate-
      // limiting). Vid upprepade tysta omanslutningar dubblas tröskeln:
      // 20 → 40 → 80 → 120 min (tak). Första meddelandet nollställer.
      const strikes = this._feedWatchdogStrikes || 0;
      const staleLimit = Math.min(staleBase * 2 ** strikes, 2 * 60 * 60 * 1000);
      if (silenceMs < staleLimit) {
        return;
      }

      const apiKey = this.homey.settings.get('ais_api_key');
      if (!apiKey || typeof this.aisClient.reconnectWithKey !== 'function') {
        return;
      }

      this.log(
        `🐕 [FEED_WATCHDOG] No AIS messages for ${Math.round(silenceMs / 60000)} min while connected — `
        + `forcing reconnect + resubscribe (strike ${strikes + 1}, next threshold `
        + `${Math.round(Math.min(staleBase * 2 ** (strikes + 1), 2 * 60 * 60 * 1000) / 60000)} min; `
        + 'harmless if the canal is just quiet)',
      );
      this._feedWatchdogStrikes = strikes + 1;
      this.aisClient.reconnectWithKey(apiKey).catch((err) => {
        this.error('[FEED_WATCHDOG] Forced reconnect failed:', err);
      });
    } catch (error) {
      this.error('[FEED_WATCHDOG] Health check failed:', error.message || error);
    }
  }

  /**
   * Dedup-cachestädningen (körs av monitoring-loopen varje minut).
   * ChatGPT-granskning 2 (CG2-10, 2026-07-11): ORDNINGEN ÄR ETT KONTRAKT —
   * persistent-posterna prunas FÖRE sessionsnycklarna. Omvänd ordning lämnade
   * ett 60 s orphan-fönster: nyckeln behölls (posten fanns kvar vid kollen)
   * medan posten raderades i samma tick — återföddes båten i fönstret var
   * mmsi:t aktivt igen och nyckeln prunades aldrig (fartgivarlös återfödd =
   * permanent notisblock, pelare 2-miss). Orphan-spegeln (DIVR2-4) täcker
   * inte fallet: den kräver postens tidsstämpel för sitt 2h-krav och kan
   * inte fyra när posten är borta.
   * @private
   */
  _pruneDedupCaches() {
    // Anomali 9 fix: rensa _persistentRecentTriggers entries äldre än 2h
    // för att map inte ska växa obegränsat.
    if (this._persistentRecentTriggers) {
      const persistentNow = Date.now();
      const persistentWindow = this._PERSISTENT_DEDUP_WINDOW_MS || 2 * 60 * 60 * 1000;
      const persistentExpired = [];
      for (const [key, value] of this._persistentRecentTriggers.entries()) {
        const ts = typeof value === 'number' ? value : value && value.t;
        if (!Number.isFinite(ts) || persistentNow - ts > persistentWindow) {
          persistentExpired.push(key);
        }
      }
      if (persistentExpired.length > 0) {
        persistentExpired.forEach((key) => this._persistentRecentTriggers.delete(key));
        this._persistRecentTriggers(); // P2: håll persisterat tillstånd i synk
        this.debug(`🧹 [CLEANUP] Removed ${persistentExpired.length} expired persistent dedup entries`);
      }
    }

    // FIX: Cleanup stale boat near triggers for vessels that no longer exist
    const activeVessels = this.vesselDataService.getAllVessels();
    const activeMmsis = new Set(activeVessels.map((v) => v.mmsi));
    const keysToRemove = [];

    for (const key of this._triggeredBoatNearKeys) {
      const mmsi = key.split(':')[0];
      // Produktionsredo (2026-07-03): BUG 7 bevarar medvetet dedup-nycklar
      // vid timeout-removal (re-entry inom samma passage) — men den här
      // städningen raderade dem ändå inom 60 s och gjorde bevarandet dött.
      // Behåll nycklar som fortfarande är dedup-relevanta enligt
      // persistent-mappen (2h-TTL:n styr livslängden).
      if (!activeMmsis.has(mmsi)
          && !(this._persistentRecentTriggers && this._persistentRecentTriggers.has(key))) {
        keysToRemove.push(key);
      }
    }

    if (keysToRemove.length > 0) {
      keysToRemove.forEach((key) => this._triggeredBoatNearKeys.delete(key));
      this.debug(`🧹 [CLEANUP] Removed ${keysToRemove.length} stale boat_near triggers`);
    }
  }

  /**
   * Setup monitoring
   * @private
   */
  _setupMonitoring() {
    // Skip monitoring in test environment to prevent hanging tests
    if (process.env.NODE_ENV === 'test' || global.__TEST_MODE__) {
      this.debug('🧪 [TEST] Skipping monitoring interval setup');
      return;
    }

    // CRITICAL FIX: Track interval for cleanup
    // Monitor vessel count and cleanup stale data
    this._monitoringInterval = setInterval(() => {
      const vesselCount = this.vesselDataService.getVesselCount();
      if (vesselCount > 0) {
        this.debug(`📊 [MONITORING] Tracking ${vesselCount} vessels`);
      }

      // Dedup-städningen (persistent 2h-map + sessionsnycklar) — extraherad
      // till egen metod (CG2-10) så ordningskontraktet kan enhetstestas
      // (monitoring-loopen är TEST_MODE-gatad och nås aldrig av jest).
      this._pruneDedupCaches();

      // B1 (2026-07-03): rensa namncache-poster äldre än TTL:n (30 dagar).
      if (this._knownVesselNames) {
        const nameNow = Date.now();
        const nameExpired = [];
        for (const [mmsi, entry] of this._knownVesselNames.entries()) {
          if (!entry || !Number.isFinite(entry.t) || nameNow - entry.t >= this._VESSEL_NAME_TTL_MS) {
            nameExpired.push(mmsi);
          }
        }
        if (nameExpired.length > 0) {
          nameExpired.forEach((mmsi) => this._knownVesselNames.delete(mmsi));
          this._persistVesselNames();
          this.debug(`🧹 [CLEANUP] Removed ${nameExpired.length} expired vessel name cache entries`);
        }
      }

      // Produktionsredo (2026-07-03): SystemCoordinators 1h-städning av
      // koordinationstillstånd anropades ALDRIG i produktion (bara i tester)
      // — per-fartygs-poster för borttagna fartyg kunde ligga kvar. Koppla
      // till monitoring-loopen (körs varje minut; cleanup är billig).
      if (this.systemCoordinator && typeof this.systemCoordinator.cleanup === 'function') {
        try {
          this.systemCoordinator.cleanup();
        } catch (error) {
          this.error('[CLEANUP] SystemCoordinator cleanup failed:', error.message || error);
        }
      }

      // Produktionsredo (2026-07-03): _aisRejectLogTimes (loggdedup för
      // avvisade AIS-meddelanden) växte obegränsat — en post per unikt
      // avvisat mmsi, aldrig städad. Rensa poster äldre än 1 h.
      if (this._aisRejectLogTimes && this._aisRejectLogTimes.size > 0) {
        const rejNow = Date.now();
        for (const [mmsi, ts] of this._aisRejectLogTimes.entries()) {
          if (!Number.isFinite(ts) || rejNow - ts > 60 * 60 * 1000) {
            this._aisRejectLogTimes.delete(mmsi);
          }
        }
      }

      // F2-följdfix (2026-07-03): rensa sista-kända-positioner äldre än TTL:n.
      if (this._lastKnownPositions && this._lastKnownPositions.size > 0) {
        const posNow = Date.now();
        const posTtl = this._LAST_KNOWN_POSITION_TTL_MS || 6 * 60 * 60 * 1000;
        let posExpired = 0;
        for (const [mmsi, entry] of this._lastKnownPositions.entries()) {
          if (!entry || !Number.isFinite(entry.t) || posNow - entry.t >= posTtl) {
            this._lastKnownPositions.delete(mmsi);
            posExpired++;
          }
        }
        if (posExpired > 0) this._persistLastKnownPositions();
      }

      // B2-fix (2026-06-09): stale-data-watchdog — upptäcker "ansluten men
      // döv" (tappad subscription, server slutat skicka) som ping/pong inte
      // fångar, och tvingar en full omanslutning + omprenumeration.
      this._checkAISFeedHealth();
    }, UI_CONSTANTS.MONITORING_INTERVAL_MS); // Every minute
  }

  /**
   * Initialize micro-grace coalescing system for optimal UI updates
   * @private
   */
  _initializeCoalescingSystem() {
    // Core coalescing state
    this._updateVersion = 0;
    this._microGraceTimers = new Map(); // bridgeKey -> timerId
    this._microGraceBatches = new Map(); // bridgeKey -> [reasons]
    this._inFlightUpdates = new Set(); // Set of bridgeKeys currently updating
    this._rerunNeeded = new Set(); // bridgeKeys needing rerun after current update
    // F75: _lastBridgeTexts (plural) borttagen — var deklarerad men aldrig
    // läst/skriven (död state, vilseledande). Faktisk dedupe sker via
    // _lastBridgeText/_lastBridgeTextHash (singular) i _processUIUpdate.

    // Self-healing watchdog (minimal overhead)
    this._watchdogTimer = setInterval(() => {
      try {
        // Only run watchdog if we have vessels — UTOM när en dedup-cache
        // står i felsentinel (null): Fable-granskningen 2026-07-10b
        // (A2-2/P1-1) visade att C4a-självläkningen saknade DRIVKRAFT i
        // exakt det värsta fallet (0 båtar): den misslyckade "Inga båtar"-
        // skrivningen nollade hashen, men ingen UI-cykel kördes förrän
        // nästa externa händelse (feed-watchdogens reconnect, 20–120 min)
        // — enheten visade nattgammal båttext i timmar. En cache i null
        // betyder "senaste skrivningen misslyckades" → kör läkningscykeln
        // även på tom kanal (den publicerar DEFAULT, sätter cachen och
        // tystnar igen).
        const vessels = this.vesselDataService.getAllVessels();
        const healNeeded = this._lastBridgeTextHash === null
          || this._lastBridgeAlarm === null
          || this._lastConnectionStatus === null;
        if (vessels.length === 0 && !healNeeded) return;

        this.debug(`🐕 [WATCHDOG] Running self-healing check (${vessels.length} vessels${healNeeded ? ', heal needed' : ''})`);
        this._scheduleCoalescedUpdate('normal', 'watchdog-self-healing');
      } catch (error) {
        this.error('Error in watchdog:', error);
      }
    }, 30000); // Every 30 seconds — ensures smooth phase transitions without AIS

    this.debug('✅ [COALESCING] Micro-grace coalescing system initialized');
  }

  /**
   * Cleanup on app shutdown
   */
  async onUninit() {
    this.log('🛑 AIS Bridge shutting down...');

    // DIV-2 (Fable 2026-07-10b) + A2R2-4 (R2 2026-07-11): clear() avbokar
    // inte redan registrerade .then-continuations — _shuttingDown-flaggan
    // gör att sena kedjelänkar och nya skrivförsök blir no-ops.
    this._shuttingDown = true;
    if (this._capWriteChains) {
      this._capWriteChains.clear();
      this._capWriteChains = null;
    }

    // CRITICAL FIX: Cleanup all timers to prevent memory leaks
    // Note: No UI update timers to clean up - using setImmediate which auto-cleans

    // RACE CONDITION FIX: Clear all vessel removal timers safely
    for (const [mmsi, timerId] of this._vesselRemovalTimers) {
      if (timerId) {
        clearTimeout(timerId);
        this.debug(`🧹 [CLEANUP] Cleared removal timer for vessel ${mmsi}`);
      }
    }
    this._vesselRemovalTimers.clear();
    this._vesselRemovalTimers = null; // Prevent memory leak

    // RACE CONDITION FIX: Clear processing removal tracking
    if (this._processingRemoval) {
      this._processingRemoval.clear();
      this._processingRemoval = null;
    }

    // Clear monitoring interval
    if (this._monitoringInterval) {
      clearInterval(this._monitoringInterval);
      this._monitoringInterval = null;
    }

    // Produktionsredo (2026-07-03): destroy-kedjan för services med EGNA
    // intervalltimers — de överlevde annars shutdown (timer-läcka om Homey
    // återanvänder processen). PassageLatch 60 s-cleanup, RouteOrderValidator
    // 2h-cleanup, GPSJumpGate 10 s/5 min-cleanup.
    // Helgranskning 2026-07-06 (app-9#1): statusService tillagd — dess
    // ProgressiveETACalculator äger ett 5-min-setInterval som annars läckte
    // per onInit-cykel.
    // ChatGPT-granskning 2 (CG2-17, 2026-07-11): systemCoordinator tillagd —
    // dess 2 s-debounce-timers saknade annars destroy-väg.
    for (const svc of [this.passageLatchService, this.routeOrderValidator, this.gpsJumpGateService, this.statusService, this.systemCoordinator]) {
      try {
        if (svc && typeof svc.destroy === 'function') svc.destroy();
      } catch (error) {
        this.error('[CLEANUP] Service destroy failed:', error.message || error);
      }
    }

    // Självtest-timern (spåras sedan 2026-07-03)
    if (this._selfTestTimer) {
      clearTimeout(this._selfTestTimer);
      this._selfTestTimer = null;
    }

    // Dev-simuleringstimern (helgranskning 2026-07-06, app-8#2)
    if (this._simulateTestDataTimer) {
      clearTimeout(this._simulateTestDataTimer);
      this._simulateTestDataTimer = null;
    }

    // COALESCING CLEANUP: Clear all coalescing timers and state
    if (this._microGraceTimers) {
      for (const [bridgeKey, timerId] of this._microGraceTimers) {
        clearTimeout(timerId);
        this.debug(`🧹 [CLEANUP] Cleared micro-grace timer for ${bridgeKey}`);
      }
      this._microGraceTimers.clear();
    }

    // B7b (F12): städa immediate-batchens fönstertimer
    if (this._immediatePublishTimer) {
      clearTimeout(this._immediatePublishTimer);
      this._immediatePublishTimer = null;
      this._immediatePublishReasons = [];
    }

    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
      this.debug('🧹 [CLEANUP] Watchdog timer cleared');
    }

    // Clear coalescing state maps
    if (this._microGraceBatches) this._microGraceBatches.clear();
    if (this._inFlightUpdates) this._inFlightUpdates.clear();
    if (this._rerunNeeded) this._rerunNeeded.clear();

    // Clear all vessel service timers
    if (this.vesselDataService) {
      this.vesselDataService.clearAllTimers();
    }

    // Disconnect AIS stream
    if (this.aisClient) {
      this.aisClient.disconnect();
    }

    // P2-fix: flusha 2h-dedup-kartan en sista gång så en kontrollerad omstart
    // garanterat har färskt tillstånd (write-through täcker normalfallet).
    this._persistRecentTriggers();

    // B8-hygien (2026-06-09): avregistrera service-/klient-lyssnare. Tjänsterna
    // återskapas visserligen i onInit, men explicit avregistrering gör
    // livscykeln robust om Homey någonsin återanvänder app-instansen.
    if (this.vesselDataService && typeof this.vesselDataService.removeAllListeners === 'function') {
      this.vesselDataService.removeAllListeners();
    }
    if (this.statusService && typeof this.statusService.removeAllListeners === 'function') {
      this.statusService.removeAllListeners();
    }
    if (this.aisClient && typeof this.aisClient.removeAllListeners === 'function') {
      this.aisClient.removeAllListeners();
    }
    this._eventsHooked = false;

    // Remove event listeners
    if (this.homey && this.homey.settings) {
      this.homey.settings.off('set', this._onSettingsChanged);
    }

    // F54: avregistrera process-nivå-lyssnarna (annars läcker de över omstart)
    if (this._onUncaughtException) {
      process.removeListener('uncaughtException', this._onUncaughtException);
      this._onUncaughtException = null;
    }
    if (this._onUnhandledRejection) {
      process.removeListener('unhandledRejection', this._onUnhandledRejection);
      this._onUnhandledRejection = null;
    }

    this.log('✅ AIS Bridge shutdown complete with proper cleanup');
  }

  /**
   * Device management methods
   */

  /**
   * Add a device to the tracking set
   * @param {Object} device - Homey device instance
   */
  addDevice(device) {
    if (!device || typeof device.getName !== 'function') {
      this.error('Invalid device object provided to addDevice');
      return;
    }

    this._devices.add(device);
    this.log(`📱 Device added: ${device.getName()}`);
  }

  /**
   * Remove a device from the tracking set
   * @param {Object} device - Homey device instance
   */
  removeDevice(device) {
    if (!device || typeof device.getName !== 'function') {
      this.error('Invalid device object provided to removeDevice');
      return;
    }

    this._devices.delete(device);
    this.log(`📱 Device removed: ${device.getName()}`);
  }

  /**
   * Debug logging with level support.
   * Levels: off < basic < detailed < full
   * @param {string} message
   * @param  {...any} args
   * @param {string} [level='detailed'] - minimum level required to show this message
   */
  debug(message, ...args) {
    if (!this.debugLevel || this.debugLevel === 'off') return;

    // Determine the minimum level needed for this message
    const levels = { basic: 1, detailed: 2, full: 3 };
    const currentLevel = levels[this.debugLevel] || 0;

    // Messages containing these patterns are "basic" (always shown when not off)
    // Everything else requires "detailed", AIS raw data requires "full"
    let requiredLevel = 2; // default: detailed
    const basicTags = [
      'UI_UPDATE', 'TARGET_BRIDGE_PASSED', 'TARGET_TRANSITION', 'JOURNEY_COMPLETED',
      'BRIDGE_OPENING', 'INTERMEDIATE_PASSAGE', 'VESSEL_ENTERED', 'VESSEL_REMOVED', 'STATUS_CHANGED',
    ];
    const basicPattern = new RegExp(basicTags.map((t) => `\\[${t}\\]`).join('|'));
    if (basicPattern.test(message)) {
      requiredLevel = 1; // basic
    } else if (/\[AIS_RAW\]|\[POSITION_ANALYSIS\]|\[PROXIMITY_ANALYSIS\]|\[ETA_CALC\]|\[COALESCING\]|\[SNAPSHOT\]/.test(message)) {
      requiredLevel = 3; // full
    }

    if (currentLevel >= requiredLevel) {
      this.log(`[DEBUG] ${message}`, ...args);
    }
  }
}

// Export the classes for testing
module.exports = AISBridgeApp;
module.exports.BridgeTextService = BridgeTextService;
module.exports.VesselDataService = VesselDataService;
module.exports.ProximityService = ProximityService;
module.exports.StatusService = StatusService;
module.exports.BridgeRegistry = BridgeRegistry;
