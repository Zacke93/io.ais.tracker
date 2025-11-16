'use strict';

const fs = require('fs');
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
const { etaDisplay } = require('./lib/utils/etaValidation');
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
} = require('./lib/constants');

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
    process.on('uncaughtException', (err) => {
      this.error('[FATAL] Uncaught exception:', err);
      // Logga men exit inte - låt process fortsätta om möjligt
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
      // Logga men exit inte - låt process fortsätta om möjligt
    });

    this.log('AIS Bridge starting with modular architecture v2.0');

    // =========================================================================
    // STEG 2: GRUNDLÄGGANDE TILLSTÅND OCH VARIABLER
    // =========================================================================
    // Dessa variabler håller appens state mellan AIS-uppdateringar

    // --- SETTINGS OCH KONFIGURATION ---
    this.debugLevel = this.homey.settings.get('debug_level') || 'basic';
    this._replayCaptureFile = process.env.AIS_REPLAY_CAPTURE_FILE || null;
    this._replayCaptureErrorLogged = false;
    if (this._replayCaptureFile) {
      this.log(`🧪 [AIS_REPLAY] Capturing AIS data to ${this._replayCaptureFile}`);
    }

    // --- ANSLUTNINGSSTATUS ---
    // Spårar om vi är anslutna till AISstream.io WebSocket
    this._isConnected = false;
    this._lastConnectionStatus = 'disconnected'; // Cache för att undvika redundanta UI-uppdateringar

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
      }
    };

    // Registrera listener för settings-ändringar
    this.homey.settings.on('set', this._onSettingsChanged);
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
    this.vesselDataService.on('vessel:entered', this._onVesselEntered.bind(this));

    // vessel:updated: Befintlig båt har fått nya AIS-data
    this.vesselDataService.on('vessel:updated', this._onVesselUpdated.bind(this));

    // vessel:removed: Båt har tagits bort (timeout eller lämnat området)
    this.vesselDataService.on('vessel:removed', this._onVesselRemoved.bind(this));

    // --- STATUS SERVICE EVENTS ---
    // Triggas när en båts status ändras (approaching → waiting → under-bridge → passed)
    this.statusService.on('status:changed', this._onVesselStatusChanged.bind(this));

    // --- AIS CLIENT EVENTS ---
    // Dessa events kommer från WebSocket-anslutningen till AISstream.io

    // connected: WebSocket anslutning etablerad
    this.aisClient.on('connected', this._onAISConnected.bind(this));

    // disconnected: WebSocket anslutning tappad
    this.aisClient.on('disconnected', this._onAISDisconnected.bind(this));

    // ais-message: Nytt AIS-meddelande mottaget (VIKTIGAST!)
    // Detta är hjärtat av appen - här processas all båtdata
    this.aisClient.on('ais-message', this._onAISMessage.bind(this));

    // error: WebSocket fel
    this.aisClient.on('error', this._onAISError.bind(this));

    // reconnect-needed: Anslutning tappades, behöver återansluta
    this.aisClient.on('reconnect-needed', this._onAISReconnectNeeded.bind(this));

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
    // Om båten redan har en målbro tilldelad, trigga Homey Flow
    if (vessel.targetBridge) {
      await this._triggerBoatNearFlow(vessel);
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
      }

      // STEG 2: ANALYSERA POSITION OCH STATUS
      // Beräknar nya avstånd, status, ETA baserat på uppdaterad position
      await this._analyzeVesselPosition(vessel);

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
      // Ta bort dedupe-nycklar så att båten kan trigga igen om den kommer tillbaka
      this._clearBoatNearTriggers(vessel || { mmsi });

      // STEG 3: RENSA STATUS STABILIZER HISTORY
      this.statusService.statusStabilizer.removeVessel(mmsi);

      // STEG 4: RENSA ETA HISTORY
      // Ta bort alla sparade ETA-beräkningar för denna vessel
      this.statusService.clearVesselETAHistory(mmsi, `vessel_removed_${reason}`);

      // STEG 5: UPPDATERA UI
      const remainingVesselCount = currentVesselCount - 1; // Antal efter borttagning
      this.debug(`🔍 [VESSEL_REMOVAL_DEBUG] Vessels remaining after removal: ${remainingVesselCount}`);

      if (remainingVesselCount === 0) {
        // CRITICAL: Force bridge text update to default when no vessels remain
        this.debug('🔄 [VESSEL_REMOVAL_DEBUG] Last vessel removed - forcing bridge text to default');
        // eslint-disable-next-line global-require
        const { BRIDGE_TEXT_CONSTANTS } = require('./lib/constants');
        const defaultMessage = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
        this.debug(`🔄 [VESSEL_REMOVAL_DEBUG] Default message: "${defaultMessage}"`);

        // Force update even if text hasn't "changed" according to comparison
        this._lastBridgeText = defaultMessage;
        this._updateDeviceCapability('bridge_text', defaultMessage);
        this.debug(`📱 [UI_UPDATE] FORCED bridge text update to default: "${defaultMessage}"`);

        // Also update global token
        try {
          if (this._globalBridgeTextToken) {
            await this._globalBridgeTextToken.setValue(defaultMessage);
          }
        } catch (error) {
          this.error('[GLOBAL_TOKEN_ERROR] Failed to update global bridge text token:', error);
        }

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
    if (newStatus === 'waiting' && oldStatus !== 'waiting') {
      await this._triggerBoatNearFlow(vessel); // Specific bridge trigger
      await this._triggerBoatNearFlowForAny(vessel); // "Any bridge" trigger
    }

    // STEG 2: RENSA TRIGGERS NÄR BÅT LÄMNAR OMRÅDET
    // När båt inte längre är nära bro, rensa dedupe-nycklar
    if (oldStatus === 'waiting' || oldStatus === 'approaching' || oldStatus === 'under-bridge') {
      if (newStatus === 'en-route' || newStatus === 'passed') {
        this._clearBoatNearTriggers(vessel);
      }
    }

    // STEG 3: HANTERA FINAL BRIDGE PASSAGE
    // När båt passerat sin sista målbro, schemalägg borttagning efter 60s
    if (newStatus === 'passed' && vessel.targetBridge) {
      if (this._hasPassedFinalTargetBridge(vessel)) {
        this.debug(`🏁 [FINAL_BRIDGE_PASSED] Vessel ${vessel.mmsi} passed final target bridge ${vessel.targetBridge} - scheduling removal in 60s`);

        // RACE CONDITION FIX: Rensa gammal timer först (atomisk operation)
        if (this._vesselRemovalTimers.has(vessel.mmsi)) {
          clearTimeout(this._vesselRemovalTimers.get(vessel.mmsi));
          this._vesselRemovalTimers.delete(vessel.mmsi);
        }

        // VIKTIGT: "Precis passerat" meddelande måste visas i 60 sekunder
        // Därför tas båt bort först efter denna period
        try {
          const timerId = setTimeout(() => {
            // RACE CONDITION CHECK: Förhindra dubbel-borttagning
            if (!this._processingRemoval || !this._processingRemoval.has(vessel.mmsi)) {
              this.vesselDataService.removeVessel(vessel.mmsi, 'passed-final-bridge');
            }
            this._vesselRemovalTimers.delete(vessel.mmsi);
          }, PASSAGE_TIMING.PASSED_HOLD_MS); // 60 sekunder enligt spec

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

      // STEG 3: BEVARA TARGETBRIDGE
      // Kritisk fix: Spara originalvärde innan status-analys (kan ändras)
      const originalTargetBridge = vessel.targetBridge;

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
            positionAnalysis.movementDistance || 0,
            vessel,
          );
        }

        // GPS-JUMP GATE: Blockera passage-detektering under GPS-instabilitet
        if (this.gpsJumpGateService) {
          this.gpsJumpGateService.activateGate(
            vessel.mmsi.toString(),
            positionAnalysis.movementDistance || 0,
            'gps_jump_detected',
          );
        }

        // ROUTE ORDER VALIDATOR: Rensa historik vid stora GPS-hopp (>1km)
        // Stora hopp gör route order validation oanvändbar
        if (this.routeOrderValidator && positionAnalysis.movementDistance > 1000) {
          this.routeOrderValidator.clearVesselHistory(
            vessel.mmsi.toString(),
            `large_gps_jump_${positionAnalysis.movementDistance}m`,
          );
        }
      }

      // STEG 5: BEKRÄFTA STABLE CANDIDATE PASSAGES
      // Tvåstegs-validering: Kandidat-passage → Bekräftad passage
      if (this.gpsJumpGateService) {
        const confirmedPassages = this.gpsJumpGateService.confirmStableCandidates(vessel.mmsi.toString(), vessel);

        // Processa bekräftade passager
        for (const confirmedPassage of confirmedPassages) {
          this.debug(`✅ [GPS_GATE_CONFIRMED] ${vessel.mmsi}: Confirmed passage of ${confirmedPassage.bridgeName}`);

          // Hantera bekräftad passage
          if (confirmedPassage.bridgeName === vessel.targetBridge) {
            // MÅLBRO PASSAGE: Trigger transition till nästa målbro
            // CRITICAL FIX: Pass oldVessel snapshot instead of timestamp
            this.vesselDataService._handleTargetBridgeTransition(vessel, oldVessel);
          } else {
            // MELLANBRO PASSAGE: Uppdatera lastPassedBridge
            vessel.lastPassedBridge = confirmedPassage.bridgeName;
            vessel.lastPassedBridgeTime = confirmedPassage.confirmedAt;
          }
        }
      }

      // STEG 6: STATUS ANALYSIS
      // Analysera och bestäm status baserat på position och proximity
      const statusResult = this.statusService.analyzeVesselStatus(vessel, proximityData, positionAnalysis);

      // STEG 7: UPPDATERA VESSEL MED RESULTAT
      Object.assign(vessel, statusResult);

      // STEG 8: ÅTERSTÄLL TARGETBRIDGE OM DEN FÖRLORATS
      // CRITICAL FIX: Restore targetBridge if it was lost during status analysis
      if (originalTargetBridge && !vessel.targetBridge) {
        vessel.targetBridge = originalTargetBridge;
        this.debug(`🛡️ [TARGET_BRIDGE_PROTECTION] ${vessel.mmsi}: Restored targetBridge: ${originalTargetBridge}`);
      }

      vessel._distanceToNearest = proximityData.nearestDistance;

      // 6. Calculate ETA for relevant statuses (EXPANDED: includes en-route and stallbacka-waiting)
      if (statusResult.status === 'approaching' || statusResult.status === 'waiting'
          || statusResult.status === 'en-route' || statusResult.status === 'stallbacka-waiting') {
        vessel.etaMinutes = this.statusService.calculateETA(vessel, proximityData);
      } else {
        vessel.etaMinutes = null; // Clear ETA for other statuses (under-bridge, passed)
      }

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
    if (!vessel.targetBridge || !vessel.passedBridges || vessel.passedBridges.length === 0) {
      return false;
    }

    // Check if vessel has passed its target bridge
    const hasPassedTargetBridge = vessel.passedBridges.includes(vessel.targetBridge);
    if (!hasPassedTargetBridge) {
      return false;
    }

    // CRITICAL FIX: Handle null/invalid COG gracefully
    // If COG is missing, we can't determine direction reliably, so default to "not final"
    if (!Number.isFinite(vessel.cog)) {
      return false; // Conservative approach - don't remove vessel if direction is unknown
    }

    // Determine if there are more target bridges in the vessel's direction
    const isNorthbound = vessel.cog >= COG_DIRECTIONS.NORTH_MIN || vessel.cog <= COG_DIRECTIONS.NORTH_MAX;

    if (vessel.targetBridge === 'Klaffbron') {
      // If northbound and passed Klaffbron, next target would be Stridsbergsbron
      return !isNorthbound; // Only final if southbound
    }

    if (vessel.targetBridge === 'Stridsbergsbron') {
      // If southbound and passed Stridsbergsbron, next target would be Klaffbron
      return isNorthbound; // Only final if northbound
    }

    return false;
  }

  /**
   * Handle AIS connection established
   * @private
   */
  _onAISConnected() {
    this.log('🌐 [AIS_CONNECTION] Connected to AIS stream');
    this._isConnected = true;
    this._updateDeviceCapability('connection_status', 'connected');
  }

  /**
   * Handle AIS connection lost
   * @private
   */
  _onAISDisconnected(disconnectInfo = {}) {
    const { code = 'unknown', reason = 'unknown' } = disconnectInfo;
    this.log(`🔌 [AIS_CONNECTION] Disconnected from AIS stream: ${code} - ${reason}`);
    this._isConnected = false;
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
        return; // Ogiltigt meddelande, skippa processning
      }

      // STEG 2: NORMALISERA MMSI TILL STRING
      // Backend använder strings för MMSI (mer flexibelt)
      const mmsiStr = String(message.mmsi);
      const normalizedSog = Number.isFinite(message.sog) ? message.sog : null;
      const normalizedCog = Number.isFinite(message.cog) ? message.cog : null;
      const vesselPatch = {
        lat: message.lat,
        lon: message.lon,
        // VIKTIGT: Bevara null för okänd hastighet (tvinga inte till 0)
        // null = okänd hastighet, 0 = verklig nollhastighet (stillaliggande)
        sog: normalizedSog,
        cog: normalizedCog,
        name: message.shipName || 'Unknown',
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

    // CRITICAL FIX: More robust SOG validation with finite check
    if (message.sog !== undefined && (!Number.isFinite(message.sog) || message.sog < 0 || message.sog > VALIDATION_CONSTANTS.SOG_MAX)) {
      this.debug(`⚠️ [AIS_VALIDATION] Invalid SOG: ${message.sog}`);
      return false;
    }

    // CRITICAL FIX: More robust COG validation with finite check and 360° normalization
    if (message.cog !== undefined) {
      if (!Number.isFinite(message.cog) || message.cog < 0 || message.cog > 360) {
        this.debug(`⚠️ [AIS_VALIDATION] Invalid COG: ${message.cog}`);
        return false;
      }
      // Normalize 360° to 0° (both represent north)
      if (message.cog === 360) {
        message.cog = 0;
        this.debug('🔄 [AIS_VALIDATION] Normalized COG 360° to 0°');
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
        // Check for active critical transition holds (stallbacka-waiting, under-bridge)
        if (this.statusService.hasActiveCriticalTransition(vessel)) {
          this.debug(`🔥 [CRITICAL_TRANSITION_DETECTED] ${vessel.mmsi}: Active critical transition detected for micro-grace`);
          return true;
        }

        // Check for high-priority recent transitions
        const highestTransition = this.statusService.getHighestPriorityTransition(vessel);
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
      } catch (bridgeTextError) {
        this.error('[BRIDGE_TEXT] CRITICAL ERROR during bridge text generation:', bridgeTextError);
        // Use last known good text or default
        bridgeText = this._lastBridgeText || BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
        this.debug(`📱 [_actuallyUpdateUI] Using fallback bridge text: "${bridgeText}"`);
      }

      // ENHANCED: Summary validation and sanity checks
      const validationResult = this._validateBridgeTextSummary(bridgeText, relevantVessels, snapshot);
      if (!validationResult.isValid) {
        this.debug(`⚠️ [SUMMARY_VALIDATION] Bridge text failed validation: ${validationResult.reason}`);
        if (validationResult.shouldUseFallback) {
          bridgeText = validationResult.fallbackText || this._lastBridgeText || BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
          this.debug(`🔄 [SUMMARY_FALLBACK] Using validated fallback: "${bridgeText}"`);
        }
      } else {
        this.debug('✅ [SUMMARY_VALIDATION] Bridge text passed all sanity checks');
      }

      // ENHANCED: Update devices with atomic change detection and dedupe
      const bridgeTextHash = this._hashString(bridgeText);
      this.debug(`📱 [SNAPSHOT_PROCESS] Comparing: new="${bridgeText}" (hash: ${bridgeTextHash}) vs last="${this._lastBridgeText}" (hash: ${this._lastBridgeTextHash})`);

      // CRITICAL FIX: Use hash-based dedupe for exact change detection
      const timeSinceLastUpdate = Date.now() - (this._lastBridgeTextUpdate || 0);
      const hasPassedVessels = relevantVessels.some((vessel) => vessel.status === 'passed');
      const textActuallyChanged = bridgeTextHash !== this._lastBridgeTextHash;

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
        try {
          if (this._globalBridgeTextToken) {
            await this._globalBridgeTextToken.setValue(bridgeText);
          }
        } catch (error) {
          this.error('[GLOBAL_TOKEN_ERROR] Failed to update global bridge text token:', error);
        }

        this.log(`📱 [UI_UPDATE] Bridge text updated: "${bridgeText}"`);
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
      const hasActiveBoats = relevantVessels.length > 0;

      // SAFETY CHECK: This should never happen with improved bridge text generation
      if (relevantVessels.length > 0 && bridgeText === BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE) {
        this.error(`🚨 [BRIDGE_TEXT_BUG] ${relevantVessels.length} relevant vessels but got default text - this indicates a bug in bridge text generation`);
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
        const hasCriticalIssues = validationResult.checks.some((check) => !check.passed && check.severity === 'critical');

        if (hasCriticalIssues) {
          validationResult.shouldUseFallback = true;
          validationResult.fallbackText = this._generateSafeFallbackText(relevantVessels);
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
    const actualCount = vessels.length;

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

      // Check status-distance consistency
      if (vessel.status === 'under-bridge' && vessel.targetBridge) {
        const targetBridge = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
        if (targetBridge) {
          const distance = geometry.calculateDistance(vessel.lat, vessel.lon, targetBridge.lat, targetBridge.lon);
          if (distance > 100) { // Under-bridge should be <50m, allowing some tolerance
            inconsistencies.push(`${vessel.mmsi} status='under-bridge' but ${distance.toFixed(0)}m from ${vessel.targetBridge}`);
          }
        }
      }

      // Check ETA consistency with status
      if (vessel.etaMinutes !== null && vessel.etaMinutes !== undefined) {
        if (vessel.status === 'under-bridge' && vessel.etaMinutes > 1) {
          inconsistencies.push(`${vessel.mmsi} status='under-bridge' but ETA=${vessel.etaMinutes.toFixed(1)}min`);
        }
        if (vessel.status === 'passed' && vessel.etaMinutes > 0) {
          inconsistencies.push(`${vessel.mmsi} status='passed' but ETA=${vessel.etaMinutes.toFixed(1)}min`);
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

    // Look for explicit numbers
    const numberMatches = bridgeText.match(/(\d+)\s*(båt|vessel)/gi);
    if (numberMatches) {
      for (const match of numberMatches) {
        const num = parseInt(match.match(/\d+/)[0], 10);
        if (num && num > 0) {
          counts.totalMentioned += num;
        }
      }
    }

    // Look for implicit counts ("En båt", "ytterligare X båtar")
    if (bridgeText.includes('En båt') || bridgeText.includes('en båt')) {
      counts.implicitCount += 1;
    }

    const additionalMatches = bridgeText.match(/ytterligare\s*(\d+)/gi);
    if (additionalMatches) {
      for (const match of additionalMatches) {
        const num = parseInt(match.match(/\d+/)[0], 10);
        if (num && num > 0) {
          counts.implicitCount += num;
        }
      }
    }

    return counts;
  }

  /**
   * Generate safe fallback text when validation fails
   * @private
   */
  _generateSafeFallbackText(vessels) {
    if (!vessels || vessels.length === 0) {
      return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
    }

    // Generate minimal safe text based on vessel count
    const vesselCount = vessels.length;
    const bridges = [...new Set(vessels.map((v) => v.targetBridge).filter(Boolean))];

    if (vesselCount === 1) {
      return `En båt är i närheten av ${bridges.length > 0 ? bridges[0] : 'broarna'}`;
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
    const bridgeKey = this._determineBridgeKey();
    const version = ++this._updateVersion;

    this.debug(`⚡ [IMMEDIATE] Publishing immediately: ${reason} (v${version}, lane: ${bridgeKey})`);

    setImmediate(() => {
      this._publishUpdate(version, bridgeKey, [reason]);
    });
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
      if (this._inFlightUpdates.has(bridgeKey)) {
        this.debug(`✋ [IN_FLIGHT] Update in progress for ${bridgeKey} - scheduling rerun`);
        this._rerunNeeded.add(bridgeKey);
        return;
      }

      // Mark as in-flight
      this._inFlightUpdates.add(bridgeKey);

      try {
        // Generate fresh bridge text from current state (never merge strings)
        await this._actuallyUpdateUI();

        // Check if we need to rerun due to events during update
        if (this._rerunNeeded.has(bridgeKey)) {
          this._rerunNeeded.delete(bridgeKey);
          this.debug(`🔄 [RERUN] Scheduling rerun for ${bridgeKey} due to events during update`);

          // Schedule rerun with new version
          setImmediate(() => {
            this._publishUpdate(++this._updateVersion, bridgeKey, ['rerun-after-inflight']);
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
          this.debug('⚠️ [STATUS_UPDATE] Skipping invalid vessel:', vessel?.mmsi || 'unknown');
          return;
        }

        // Re-analyze proximity and status for each vessel
        const proximityData = this.proximityService.analyzeVesselProximity(vessel);
        const statusResult = this.statusService.analyzeVesselStatus(vessel, proximityData);

        // CRITICAL FIX: Always update status - it might have been changed elsewhere
        // This ensures UI always gets the latest status
        vessel.status = statusResult.status;
        vessel.isWaiting = statusResult.isWaiting;
        vessel.isApproaching = statusResult.isApproaching;

        // CRITICAL FIX: Always recalculate ETA for relevant statuses
        // ETA can change even if status doesn't change
        if (['approaching', 'waiting', 'en-route', 'stallbacka-waiting'].includes(vessel.status)) {
          vessel.etaMinutes = this.statusService.calculateETA(vessel, proximityData);
        } else {
          vessel.etaMinutes = null;
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

    // Transform vessel data to format expected by BridgeTextService
    return filteredVessels.map((vessel) => {
      // Find current bridge based on nearest distance
      const proximityData = this.proximityService.analyzeVesselProximity(vessel);
      let currentBridge = null;

      if (proximityData.nearestBridge && proximityData.nearestDistance <= BRIDGE_TEXT_CONSTANTS.VESSEL_DISTANCE_THRESHOLD) {
        // PASSAGE CLEARING: Don't set currentBridge if vessel has recently passed this bridge
        // and is now moving away (avoids "En båt vid X" messages after passage)
        const bridgeName = proximityData.nearestBridge.name;
        const hasRecentlyPassedThisBridge = vessel.lastPassedBridge === bridgeName
          && vessel.lastPassedBridgeTime
          && (Date.now() - vessel.lastPassedBridgeTime) < BRIDGE_TEXT_CONSTANTS.PASSAGE_CLEAR_WINDOW_MS; // 60 seconds (matches "precis passerat" window)

        if (!hasRecentlyPassedThisBridge) {
          currentBridge = bridgeName;
        } else {
          this.debug(`🌉 [PASSAGE_CLEAR] ${vessel.mmsi}: Not setting currentBridge to ${bridgeName} - recently passed`);
        }
      }

      // FIX: Calculate correct distance to currentBridge
      const currentBridgeId = currentBridge ? this.bridgeRegistry.findBridgeIdByName(currentBridge) : null;
      const distToCurrent = currentBridgeId
        ? (proximityData.bridgeDistances[currentBridgeId] ?? proximityData.nearestDistance)
        : proximityData.nearestDistance;

      return {
        mmsi: vessel.mmsi,
        name: vessel.name,
        targetBridge: vessel.targetBridge,
        currentBridge,
        etaMinutes: vessel.etaMinutes,
        isWaiting: vessel.isWaiting,
        isApproaching: vessel.isApproaching,
        confidence: vessel.confidence || 'medium',
        status: vessel.status,
        lastPassedBridge: vessel.lastPassedBridge,
        lastPassedBridgeTime: vessel.lastPassedBridgeTime,
        distance: proximityData.nearestDistance,
        distanceToCurrent: distToCurrent,
        sog: vessel.sog,
        cog: vessel.cog, // CRITICAL: Add COG for target bridge derivation
        passedBridges: vessel.passedBridges || [],
        // ADD: Position data needed for Stallbackabron distance calculations
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
    for (const device of this._devices) {
      try {
        if (device && device.setCapabilityValue) {
          device.setCapabilityValue(capability, value).catch((err) => {
            this.error(`Error setting ${capability} for device ${device.getName ? device.getName() : 'unknown'}:`, err);
          });
        }
      } catch (error) {
        this.error(`Error updating capability ${capability}:`, error);
        // Continue with next device
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
      this.error('❌ [FLOW_TRIGGER] boat_near trigger card unavailable – cannot fire flow');
      return null;
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

    if (
      candidates.length === 0
      && nearestBridge
      && nearestBridge.name
      && Number.isFinite(nearestBridge.distance)
      && nearestBridge.distance <= threshold
    ) {
      addCandidate(nearestBridge.name, 'nearest');
    }

    const hasTargetCandidate = candidates.some((candidate) => candidate.source === 'target');
    if (hasTargetCandidate) {
      return candidates.filter((candidate) => candidate.source === 'target');
    }

    return candidates;
  }

  /**
   * Trigger the boat_near flow for a specific bridge candidate
   * @private
   */
  async _triggerBoatNearFlowForBridge(vessel, candidate) {
    const { name: bridgeName, id: bridgeId, distance, source } = candidate;

    const dedupeKey = `${vessel.mmsi}:${bridgeName}`;

    // ENHANCED DEDUPE DEBUG: Check if already triggered for this vessel+bridge combo
    if (this._triggeredBoatNearKeys.has(dedupeKey)) {
      this.log(
        `🚫 [FLOW_TRIGGER_DEDUPE] ${vessel.mmsi}: Already triggered for "${bridgeName}" `
        + `(source=${source}) - dedupe active (${this._triggeredBoatNearKeys.size} keys stored)`,
      );
      return;
    }

    // Create tokens with validated bridge name
    const tokens = {
      vessel_name: vessel.name || 'Unknown',
      bridge_name: bridgeName,
      direction: this._getDirectionString(vessel),
    };

    tokens.eta_minutes = Number.isFinite(vessel.etaMinutes)
      ? Math.round(vessel.etaMinutes)
      : -1;

    // CRITICAL FIX: Create DEEP immutable copy to prevent race conditions and object mutation
    const safeTokens = {
      vessel_name: String(tokens.vessel_name || 'Unknown'),
      bridge_name: String(tokens.bridge_name),
      direction: String(tokens.direction || 'unknown'),
    };

    safeTokens.eta_minutes = Number.isFinite(tokens.eta_minutes)
      ? tokens.eta_minutes
      : -1;

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

    try {
      await this._triggerBoatNearFlowBest(safeTokens, { bridge: bridgeId }, vessel);

      // ENHANCED SUCCESS DEBUG: Detailed success logging
      this.log(
        `✅ [FLOW_TRIGGER_SUCCESS] ${vessel.mmsi}: boat_near fired for ${bridgeName} `
        + `(ID=${bridgeId}, distance=${Math.round(distance)}m, status=${vessel.status})`,
      );

      this._triggeredBoatNearKeys.add(dedupeKey);
      this.debug(`🔒 [FLOW_TRIGGER_DEDUPE_SET] ${vessel.mmsi}: Added "${dedupeKey}" to dedupe set (total keys: ${this._triggeredBoatNearKeys.size})`);
    } catch (triggerError) {
      this.error(
        `❌ [FLOW_TRIGGER_ERROR] ${vessel.mmsi}: boat_near failed for ${bridgeName} `
        + `(ID=${bridgeId}, distance=${Math.round(distance)}m, status=${vessel.status}): ${triggerError.message || triggerError}`,
      );
      this.error(`❌ [FLOW_TRIGGER_ERROR_TOKENS] Failed tokens: ${JSON.stringify(safeTokens)}`);
      this.error(`❌ [FLOW_TRIGGER_ERROR_STATE] State: { bridge: "${bridgeId}" }`);
      if (triggerError.stack) {
        this.error(`❌ [FLOW_TRIGGER_ERROR_STACK] ${triggerError.stack}`);
      }
      // Don't add key to deduplication set if trigger failed
    }
  }

  /**
   * Trigger boat near flow card for "any" bridge
   * @private
   */
  async _triggerBoatNearFlowForAny(vessel) {
    // Skip flow triggers entirely during tests to avoid mock token errors
    if (process.env.NODE_ENV === 'test' || global.__TEST_MODE__) {
      this.debug(`🧪 [TEST] Skipping boat_near ANY flow trigger for ${vessel.mmsi}`);
      return;
    }
    // CRITICAL FIX: Declare proximityData in outer scope for error handling
    let proximityData = null;
    let nearbyBridge = null;

    try {
      // ENHANCED DEBUG: Initial "any" bridge trigger attempt
      this.debug(`🎯 [FLOW_TRIGGER_ANY_START] ${vessel.mmsi}: Attempting boat_near "any" bridge trigger...`);

      if (!this._boatNearTrigger) {
        this.debug(`🚫 [FLOW_TRIGGER_ANY_SKIP] ${vessel.mmsi}: No _boatNearTrigger available`);
        return;
      }

      // CRITICAL FIX: Enhanced vessel validation
      if (!vessel || !vessel.mmsi || !Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
        this.error(`❌ [FLOW_TRIGGER_ANY_INVALID] ${vessel.mmsi}: Invalid vessel data - lat=${vessel?.lat}, lon=${vessel?.lon}`);
        return;
      }

      // Check if vessel is within 300m of ANY bridge
      proximityData = this.proximityService.analyzeVesselProximity(vessel);

      // CRITICAL FIX: Validate proximityData structure
      if (!proximityData || typeof proximityData !== 'object') {
        this.error(`[FLOW_TRIGGER_ANY] CRITICAL: proximityData is invalid for vessel ${vessel.mmsi}: ${JSON.stringify(proximityData)}`);
        return;
      }

      const bridges = proximityData.bridges || []; // Safety: ensure array exists

      // CRITICAL FIX: Validate bridges array
      if (!Array.isArray(bridges)) {
        this.error(`[FLOW_TRIGGER_ANY] CRITICAL: bridges is not an array for vessel ${vessel.mmsi}: ${JSON.stringify(bridges)}`);
        return;
      }

      // ENHANCED DEBUG: Log proximity data for "any" bridge debugging
      this.debug(`🔍 [FLOW_TRIGGER_ANY_DEBUG] ${vessel.mmsi}: proximityData.bridges count=${bridges.length}`);
      bridges.forEach((bridge, index) => {
        this.debug(`🔍 [FLOW_TRIGGER_ANY_DEBUG] ${vessel.mmsi}: bridge[${index}] = {name: "${bridge?.name}", distance: ${bridge?.distance?.toFixed(0)}m}`);
      });

      nearbyBridge = bridges.find((b) => b && Number.isFinite(b.distance) && b.distance <= FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD);

      if (!nearbyBridge) {
        this.debug(`🚫 [FLOW_TRIGGER_ANY] No bridge within 300m for vessel ${vessel.mmsi}`);
        return;
      }

      // CRITICAL FIX: Validate bridge name BEFORE any key generation
      if (!nearbyBridge.name || typeof nearbyBridge.name !== 'string' || nearbyBridge.name.trim() === '') {
        this.error(`[FLOW_TRIGGER_ANY] CRITICAL: Bridge name invalid for ${vessel.mmsi} - bridge: ${JSON.stringify(nearbyBridge)}`);

        // FALLBACK: Try to find a valid bridge name from proximity data
        const fallbackBridge = bridges.find((b) => b && b.name && typeof b.name === 'string' && b.name.trim() !== ''
          && Number.isFinite(b.distance) && b.distance <= FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD);

        if (fallbackBridge) {
          this.debug(`🔄 [FLOW_TRIGGER_ANY] Using fallback bridge: ${fallbackBridge.name}`);
          nearbyBridge = fallbackBridge;
        } else {
          this.error('[FLOW_TRIGGER_ANY] CRITICAL: No valid bridge names found in proximity data');
          return;
        }
      }

      // Validate the bridge name exists in our mapping
      if (!BRIDGE_NAME_TO_ID[nearbyBridge.name]) {
        this.error(`[FLOW_TRIGGER_ANY] CRITICAL: Unknown bridge name "${nearbyBridge.name}" - not found in BRIDGE_NAME_TO_ID mapping`);
        return;
      }

      // ENHANCED DEBUG: Log found nearby bridge (after validation)
      this.debug(`🔍 [FLOW_TRIGGER_ANY_DEBUG] ${vessel.mmsi}: Found valid nearby bridge = {name: "${nearbyBridge.name}", distance: ${nearbyBridge.distance?.toFixed(0)}m}`);

      // CRITICAL FIX: Create deduplication key ONLY after all validations pass
      const dedupeKey = `${vessel.mmsi}:any`;

      if (this._triggeredBoatNearKeys.has(dedupeKey)) {
        this.debug(`🚫 [FLOW_TRIGGER_ANY] Already triggered for ${dedupeKey}`);
        return;
      }

      // Create tokens with validated bridge name (already validated above)
      const tokens = {
        vessel_name: vessel.name || 'Unknown', // FIX: Changed from boat_name to match app.json declaration
        bridge_name: nearbyBridge.name, // Already validated above
        direction: this._getDirectionString(vessel),
      };

      // Always compute numeric ETA token for flows; use -1 when ETA is unavailable
      tokens.eta_minutes = Number.isFinite(vessel.etaMinutes)
        ? Math.round(vessel.etaMinutes)
        : -1;

      // ENHANCED DEBUG: Log token values before processing
      this.debug(`🔍 [FLOW_TRIGGER_ANY_DEBUG] ${vessel.mmsi}: Creating tokens = ${JSON.stringify(tokens)}`);

      // Create safe tokens (bridge name already validated)
      const safeTokens = {
        vessel_name: String(tokens.vessel_name || 'Unknown'),
        bridge_name: String(tokens.bridge_name), // Already validated, safe to use
        direction: String(tokens.direction || 'unknown'),
      };

      // Always include eta_minutes (number). -1 indicates ETA unavailable for flows
      safeTokens.eta_minutes = Number.isFinite(tokens.eta_minutes)
        ? tokens.eta_minutes
        : -1;

      // Emit diagnostic when ETA is unavailable for flows
      if (safeTokens.eta_minutes === -1) {
        this.debug(`🛈 [FLOW_TRIGGER_ANY_DIAG] ${vessel.mmsi}: ETA unavailable → sending eta_minutes=-1 for bridgeId="any"`);
      }

      // Trigger with special args for "any" bridge flows
      this.debug(`🎯 [FLOW_TRIGGER_ANY_DEBUG] ${vessel.mmsi}: About to trigger "any" with safeTokens=${JSON.stringify(safeTokens)}`);

      // Trigger validation is now handled in _triggerBoatNearFlowBest()

      try {
        // *** CRITICAL FIX: Use best available trigger method (app or device level) ***
        await this._triggerBoatNearFlowBest(safeTokens, { bridge: 'any' }, vessel);
        this.debug(`✅ [FLOW_TRIGGER_ANY_DEBUG] ${vessel.mmsi}: Successfully triggered "any" bridge flow`);

        // CRITICAL FIX: Add key to deduplication set ONLY after successful trigger
        // This prevents orphaned keys if trigger fails
        this._triggeredBoatNearKeys.add(dedupeKey);
        this.debug(`🎯 [FLOW_TRIGGER] boat_near (any) triggered for ${vessel.mmsi} at ${Math.round(nearbyBridge.distance)}m from ${nearbyBridge.name}`);

      } catch (triggerError) {
        this.error('[FLOW_TRIGGER_ANY] FAILED to trigger "any" bridge:', triggerError);
        this.error(`[FLOW_TRIGGER_ANY] Failed tokens: ${JSON.stringify(safeTokens)}`);
        this.error('[FLOW_TRIGGER_ANY] Trigger error details:', triggerError.stack || triggerError.message);
        // Don't add key to deduplication set if trigger failed
        // Don't re-throw - let app continue
        return;
      }

    } catch (error) {
      this.error('Error triggering boat near flow for any:', error);
      this.error('Error stack:', error.stack || error.message);

      // ENHANCED DEBUG: Log detailed error context with safe access
      const proximityDataAvailable = proximityData !== null && typeof proximityData === 'object';
      const bridgesAvailable = proximityDataAvailable && Array.isArray(proximityData.bridges);
      const nearbyBridgeAvailable = nearbyBridge !== null && typeof nearbyBridge === 'object';

      this.error(
        `[FLOW_TRIGGER_ANY] Error context: vessel=${vessel?.mmsi}, `
        + `proximityData available=${proximityDataAvailable}, `
        + `bridges available=${bridgesAvailable}, `
        + `nearbyBridge available=${nearbyBridgeAvailable}`,
      );

      if (proximityDataAvailable) {
        this.error(`[FLOW_TRIGGER_ANY] Proximity data: ${JSON.stringify({ bridgeCount: proximityData.bridges?.length || 0, nearestDistance: proximityData.nearestDistance })}`);
      }

      if (nearbyBridgeAvailable) {
        this.error(`[FLOW_TRIGGER_ANY] Nearby bridge: ${JSON.stringify({ name: nearbyBridge.name, distance: nearbyBridge.distance })}`);
      }
    }
  }

  /**
   * Clear boat near triggers when vessel leaves area or changes status
   * @private
   */
  _clearBoatNearTriggers(vessel) {
    // ENHANCED DEBUG: Start trigger clearing
    this.debug(`🧹 [TRIGGER_CLEAR_START] ${vessel.mmsi}: Clearing boat_near triggers...`);

    // Clear all trigger keys for this vessel
    const keysToRemove = [];
    for (const key of this._triggeredBoatNearKeys) {
      if (key.startsWith(`${vessel.mmsi}:`)) {
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
  }

  /**
   * Get human-readable direction string based on vessel's course over ground
   * @param {Object} vessel - Vessel object
   * @param {number} vessel.cog - Course over ground in degrees (0-359)
   * @returns {string} Direction string: 'northbound', 'southbound', or 'unknown'
   * @private
   */
  _getDirectionString(vessel) {
    // CRITICAL FIX: Handle COG=0 correctly (0° is valid north heading) and validate COG range
    if (vessel.cog == null || !Number.isFinite(vessel.cog) || vessel.cog < 0 || vessel.cog >= 360) {
      return 'unknown';
    }

    if (vessel.cog >= COG_DIRECTIONS.NORTH_MIN || vessel.cog <= COG_DIRECTIONS.NORTH_MAX) {
      return 'northbound';
    }
    return 'southbound';
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
        this._globalBridgeTextToken = await this.homey.flow.createToken('global_bridge_text', {
          type: 'string',
          title: 'Bridge Text',
        });
      }
      await this._globalBridgeTextToken.setValue(this._lastBridgeText);
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

            // If Flow card is configured for "Any bridge", always allow trigger
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
        setTimeout(() => this._testTriggerFunctionality(), 5000);
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
    setTimeout(() => {
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
    if (!this._replayCaptureFile || !sample || !sample.mmsi) {
      return;
    }

    const payload = {
      ...sample,
      receivedAt: sample.receivedAt || new Date().toISOString(),
    };

    fs.appendFile(this._replayCaptureFile, `${JSON.stringify(payload)}\n`, (err) => {
      if (err && !this._replayCaptureErrorLogged) {
        this._replayCaptureErrorLogged = true;
        this.error('⚠️ [AIS_REPLAY] Failed to write replay sample:', err.message);
      }
    });
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

      // FIX: Cleanup stale boat near triggers for vessels that no longer exist
      const activeVessels = this.vesselDataService.getAllVessels();
      const activeMmsis = new Set(activeVessels.map((v) => v.mmsi));
      const keysToRemove = [];

      for (const key of this._triggeredBoatNearKeys) {
        const mmsi = key.split(':')[0];
        if (!activeMmsis.has(mmsi)) {
          keysToRemove.push(key);
        }
      }

      if (keysToRemove.length > 0) {
        keysToRemove.forEach((key) => this._triggeredBoatNearKeys.delete(key));
        this.debug(`🧹 [CLEANUP] Removed ${keysToRemove.length} stale boat_near triggers`);
      }
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
    this._lastBridgeTexts = new Map(); // bridgeKey -> lastSentText (for dedupe)

    // Self-healing watchdog (minimal overhead)
    this._watchdogTimer = setInterval(() => {
      try {
        // Only run watchdog if we have vessels
        const vessels = this.vesselDataService.getAllVessels();
        if (vessels.length === 0) return;

        this.debug(`🐕 [WATCHDOG] Running self-healing check (${vessels.length} vessels)`);
        this._scheduleCoalescedUpdate('normal', 'watchdog-self-healing');
      } catch (error) {
        this.error('Error in watchdog:', error);
      }
    }, 90000); // Every 90 seconds

    this.debug('✅ [COALESCING] Micro-grace coalescing system initialized');
  }

  /**
   * Cleanup on app shutdown
   */
  async onUninit() {
    this.log('🛑 AIS Bridge shutting down...');

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

    // COALESCING CLEANUP: Clear all coalescing timers and state
    if (this._microGraceTimers) {
      for (const [bridgeKey, timerId] of this._microGraceTimers) {
        clearTimeout(timerId);
        this.debug(`🧹 [CLEANUP] Cleared micro-grace timer for ${bridgeKey}`);
      }
      this._microGraceTimers.clear();
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
    if (this._lastBridgeTexts) this._lastBridgeTexts.clear();

    // Clear all vessel service timers
    if (this.vesselDataService) {
      this.vesselDataService.clearAllTimers();
    }

    // Disconnect AIS stream
    if (this.aisClient) {
      this.aisClient.disconnect();
    }

    // Remove event listeners
    if (this.homey && this.homey.settings) {
      this.homey.settings.off('set', this._onSettingsChanged);
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
   * Debug logging with level support
   */
  debug(message, ...args) {
    if (this.debugLevel && this.debugLevel !== 'off') {
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
