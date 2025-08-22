'use strict';

const Homey = require('homey');

// Import modular services
const BridgeRegistry = require('./lib/models/BridgeRegistry');
const VesselDataService = require('./lib/services/VesselDataService');
const BridgeTextService = require('./lib/services/BridgeTextService');
const ProximityService = require('./lib/services/ProximityService');
const StatusService = require('./lib/services/StatusService');
const SystemCoordinator = require('./lib/services/SystemCoordinator');
const AISStreamClient = require('./lib/connection/AISStreamClient');
const { etaDisplay } = require('./lib/utils/etaValidation');

// Import utilities and constants
const {
  BRIDGES, COG_DIRECTIONS, UI_CONSTANTS, VALIDATION_CONSTANTS,
  FLOW_CONSTANTS, BRIDGE_TEXT_CONSTANTS, PASSAGE_TIMING,
  BRIDGE_NAME_TO_ID, BRIDGE_ID_TO_NAME,
} = require('./lib/constants');

/**
 * AIS Bridge App - Refactored modular architecture
 * Tracks boats near bridges using AIS data from AISstream.io
 * Focus on Klaffbron and Stridsbergsbron as target bridges
 */
class AISBridgeApp extends Homey.App {
  async onInit() {
    // Setup global crash protection
    process.on('uncaughtException', (err) => {
      this.error('[FATAL] Uncaught exception:', err);
      // Log but don't exit - let process continue if possible
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
      // Log but don't exit - let process continue if possible
    });

    this.log('AIS Bridge starting with modular architecture v2.0');

    // Initialize settings and state
    this.debugLevel = this.homey.settings.get('debug_level') || 'basic';
    this._isConnected = false;
    this._devices = new Set();
    this._lastBridgeText = '';
    this._lastBridgeAlarm = false;
    this._lastConnectionStatus = 'disconnected'; // Track last connection status to avoid redundant updates
    this._eventsHooked = false;

    // Boat near trigger deduplication - tracks which vessels have been triggered for each bridge
    this._triggeredBoatNearKeys = new Set(); // Track vessel+bridge combinations that have been triggered

    // UI update state tracking (no more debouncing - using immediate updates with change detection)
    this._uiUpdateScheduled = false;

    // Timer tracking for cleanup
    this._vesselRemovalTimers = new Map(); // Track vessel removal timers
    this._monitoringInterval = null; // Track monitoring interval

    // RACE CONDITION FIX: Track vessel removal processing to prevent concurrent operations
    this._processingRemoval = new Set(); // Track vessels being removed

    // Setup settings change listener
    this._setupSettingsListener();

    // Initialize modular services with dependency injection
    await this._initializeServices();

    // Setup flow cards and device management
    await this._setupFlowCards();
    await this._initGlobalToken();

    // Setup event-driven communication between services
    this._setupEventHandlers();

    // Start AIS connection
    await this._startConnection();

    // Setup monitoring
    this._setupMonitoring();

    // MIKRO-GRACE COALESCING: Initialize UI update system
    this._initializeCoalescingSystem();

    this.log('AIS Bridge initialized successfully with modular architecture');
  }

  /**
   * Initialize all modular services
   * @private
   */
  async _initializeServices() {
    try {
      this.log('🔧 Initializing modular services...');

      // System coordinator for GPS events and stabilization
      this.systemCoordinator = new SystemCoordinator(this);

      // Core models
      this.bridgeRegistry = new BridgeRegistry(BRIDGES);

      // Validate bridge configuration
      const validation = this.bridgeRegistry.validateConfiguration();
      if (!validation.valid) {
        this.error('Bridge configuration invalid:', validation.errors);
        throw new Error('Invalid bridge configuration');
      }

      // Data services (pass systemCoordinator)
      this.vesselDataService = new VesselDataService(this, this.bridgeRegistry, this.systemCoordinator);

      // Analysis services (pass systemCoordinator where needed)
      this.proximityService = new ProximityService(this.bridgeRegistry, this);
      this.statusService = new StatusService(this.bridgeRegistry, this, this.systemCoordinator, this.vesselDataService);

      // Output services (inject ProximityService for consistent distance calculations)
      this.bridgeTextService = new BridgeTextService(this.bridgeRegistry, this, this.systemCoordinator, this.vesselDataService);

      // Connection services
      this.aisClient = new AISStreamClient(this);

      this.log('✅ All services initialized successfully');
    } catch (error) {
      this.error('Failed to initialize services:', error);
      throw error;
    }
  }

  /**
   * Setup settings change listener
   * @private
   */
  _setupSettingsListener() {
    this._onSettingsChanged = (key, value) => {
      if (key === 'debug_level') {
        const newLevel = this.homey.settings.get('debug_level');
        this.log(`🔧 Debug level change received: "${newLevel}" (type: ${typeof newLevel})`);

        const allowed = ['off', 'basic', 'detailed', 'full'];
        if (allowed.includes(newLevel)) {
          this.debugLevel = newLevel;
          this.log(`🎛️ Debug level changed to: ${this.debugLevel}`);
        } else {
          this.log(`⚠️ Ignoring invalid debug_level value: ${newLevel}`);
        }
      }
    };
    this.homey.settings.on('set', this._onSettingsChanged);
  }

  /**
   * Setup event handlers for inter-service communication
   * @private
   */
  _setupEventHandlers() {
    if (this._eventsHooked) return;
    this._eventsHooked = true;

    this.log('🔗 Setting up event-driven communication...');

    // Vessel data service events
    this.vesselDataService.on('vessel:entered', this._onVesselEntered.bind(this));
    this.vesselDataService.on('vessel:updated', this._onVesselUpdated.bind(this));
    this.vesselDataService.on('vessel:removed', this._onVesselRemoved.bind(this));

    // Status service events
    this.statusService.on('status:changed', this._onVesselStatusChanged.bind(this));

    // AIS client events
    this.aisClient.on('connected', this._onAISConnected.bind(this));
    this.aisClient.on('disconnected', this._onAISDisconnected.bind(this));
    this.aisClient.on('ais-message', this._onAISMessage.bind(this));
    this.aisClient.on('error', this._onAISError.bind(this));
    this.aisClient.on('reconnect-needed', this._onAISReconnectNeeded.bind(this));

    this.log('✅ Event handlers configured');
  }

  /**
   * Handle new vessel entering the system
   * @private
   */
  async _onVesselEntered({ mmsi, vessel }) {
    this.debug(`🆕 [VESSEL_ENTERED] New vessel: ${mmsi}`);

    // Initialize target bridge if needed
    await this._initializeTargetBridge(vessel);

    // Analyze initial position
    await this._analyzeVesselPosition(vessel);

    // Trigger boat_near if vessel already has a target bridge assigned
    if (vessel.targetBridge) {
      await this._triggerBoatNearFlow(vessel);
    }

    // Update UI
    this._updateUI('normal', `vessel-entered-${mmsi}`);
  }

  /**
   * Handle vessel data updates (with crash protection)
   * @private
   */
  async _onVesselUpdated({ mmsi, vessel, oldVessel }) {
    try {
      this.debug(`📝 [VESSEL_UPDATED] Vessel: ${mmsi}`);

      // Analyze position and status changes
      await this._analyzeVesselPosition(vessel);

      // Update UI if needed
      this._updateUIIfNeeded(vessel, oldVessel);
    } catch (error) {
      this.error(`Error handling vessel update for ${mmsi}:`, error);
      // Continue processing other vessels
    }
  }

  /**
   * Handle vessel removal
   * @private
   */
  async _onVesselRemoved({ mmsi, vessel, reason }) {
    this.debug(`🗑️ [VESSEL_REMOVED] Vessel: ${mmsi} (${reason})`);

    // RACE CONDITION FIX: Check if vessel removal is already being processed
    if (this._processingRemoval && this._processingRemoval.has(mmsi)) {
      this.debug(`🔒 [RACE_PROTECTION] Vessel ${mmsi} removal already being processed - skipping`);
      return;
    }

    // RACE CONDITION FIX: Mark vessel removal as being processed
    if (!this._processingRemoval) {
      this._processingRemoval = new Set();
    }
    this._processingRemoval.add(mmsi);

    try {
      // ENHANCED DEBUG: Log current state before removal
      const currentVesselCount = this.vesselDataService.getVesselCount();
      this.debug(`🔍 [VESSEL_REMOVAL_DEBUG] Current vessel count: ${currentVesselCount}, removing: ${mmsi}`);
      this.debug(`🔍 [VESSEL_REMOVAL_DEBUG] Current _lastBridgeText: "${this._lastBridgeText}"`);

      // CRITICAL FIX: Clear any pending removal timer for this vessel
      if (this._vesselRemovalTimers.has(mmsi)) {
        clearTimeout(this._vesselRemovalTimers.get(mmsi));
        this._vesselRemovalTimers.delete(mmsi);
        this.debug(`🧹 [CLEANUP] Cleared removal timer for ${mmsi}`);
      }

      // FIX: Clear boat_near dedupe keys when vessel is removed
      this._clearBoatNearTriggers(vessel || { mmsi });

      // Clean up status stabilizer history
      this.statusService.statusStabilizer.removeVessel(mmsi);

      // RACE CONDITION FIX: Force UI update when vessel is removed
      // This ensures bridge text updates to default message when all vessels are gone
      const remainingVesselCount = currentVesselCount - 1; // Count after this removal
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
   * Handle vessel status changes
   * @private
   */
  async _onVesselStatusChanged({
    vessel, oldStatus, newStatus, reason,
  }) {
    this.debug(`🔄 [STATUS_CHANGED] Vessel ${vessel.mmsi}: ${oldStatus} → ${newStatus} (${reason})`);

    // Trigger flow cards when vessel enters 300m zone
    // Only trigger on 'waiting' status (which is set at 300m)
    if (newStatus === 'waiting' && oldStatus !== 'waiting') {
      await this._triggerBoatNearFlow(vessel);
      // Also trigger for "any" bridge
      await this._triggerBoatNearFlowForAny(vessel);
    }

    // Clear triggers when vessel leaves the area (no longer waiting/approaching/under-bridge)
    if (oldStatus === 'waiting' || oldStatus === 'approaching' || oldStatus === 'under-bridge') {
      if (newStatus === 'en-route' || newStatus === 'passed') {
        this._clearBoatNearTriggers(vessel);
      }
    }

    // Check if vessel has passed its final target bridge
    if (newStatus === 'passed' && vessel.targetBridge) {
      if (this._hasPassedFinalTargetBridge(vessel)) {
        // FIX: Correct log message to match actual timeout (60s not 15s)
        this.debug(`🏁 [FINAL_BRIDGE_PASSED] Vessel ${vessel.mmsi} passed final target bridge ${vessel.targetBridge} - scheduling removal in 60s`);

        // RACE CONDITION FIX: Track timer for cleanup with atomic operation
        // Clear any existing timer for this vessel first
        if (this._vesselRemovalTimers.has(vessel.mmsi)) {
          clearTimeout(this._vesselRemovalTimers.get(vessel.mmsi));
          this._vesselRemovalTimers.delete(vessel.mmsi); // Remove old reference immediately
        }

        // Specs: 'passed' status must show for 1 minute
        // Remove after 60 seconds to allow bridge text to show "precis passerat"
        try {
          const timerId = setTimeout(() => {
            // RACE CONDITION FIX: Check if vessel is not already being removed
            if (!this._processingRemoval || !this._processingRemoval.has(vessel.mmsi)) {
              this.vesselDataService.removeVessel(vessel.mmsi, 'passed-final-bridge');
            }
            this._vesselRemovalTimers.delete(vessel.mmsi); // Clean up timer reference
          }, PASSAGE_TIMING.PASSED_HOLD_MS); // 60 seconds per Bridge Text Format V2.0 specification

          this._vesselRemovalTimers.set(vessel.mmsi, timerId);
        } catch (error) {
          this.error(`[TIMER_ERROR] Failed to set removal timer for vessel ${vessel.mmsi}:`, error);
        }

        // FIX: Update UI immediately to show "precis passerat" message
        this._updateUI('critical', `vessel-passed-final-${vessel.mmsi}`);
        return;
      }
    }

    // Update UI for significant status changes
    // CRITICAL FIX: Added 'stallbacka-waiting' and 'en-route' to trigger UI updates
    const significantStatuses = ['approaching', 'waiting', 'under-bridge', 'passed', 'stallbacka-waiting', 'en-route'];

    this.debug(`🔍 [UI_UPDATE_CHECK] ${vessel.mmsi}: newStatus="${newStatus}", oldStatus="${oldStatus}"`);
    this.debug(`🔍 [UI_UPDATE_CHECK] significantStatuses=${JSON.stringify(significantStatuses)}`);
    this.debug(`🔍 [UI_UPDATE_CHECK] newInList=${significantStatuses.includes(newStatus)}, oldInList=${significantStatuses.includes(oldStatus)}`);

    if (significantStatuses.includes(newStatus) || significantStatuses.includes(oldStatus)) {
      // Determine priority based on status criticality
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
   * Analyze vessel position and update all related services (with crash protection)
   * @private
   */
  async _analyzeVesselPosition(vessel) {
    try {
      // 1. Analyze proximity to bridges
      const proximityData = this.proximityService.analyzeVesselProximity(vessel);

      // 2. CRITICAL FIX: Preserve targetBridge before status analysis
      const originalTargetBridge = vessel.targetBridge;

      // 3. Analyze and update vessel status (with GPS jump analysis)
      const positionAnalysis = {
        gpsJumpDetected: vessel._gpsJumpDetected || false,
        positionUncertain: vessel._positionUncertain || false,
        analysis: vessel._positionAnalysis || null,
      };
      
      // GPS JUMP HOLD: Set hold if GPS jump detected
      if (positionAnalysis.gpsJumpDetected) {
        this.vesselDataService.setGpsJumpHold(vessel.mmsi, 2000); // 2 second hold
      }
      
      const statusResult = this.statusService.analyzeVesselStatus(vessel, proximityData, positionAnalysis);

      // 4. Update vessel with analysis results but preserve critical data
      Object.assign(vessel, statusResult);

      // 5. CRITICAL FIX: Restore targetBridge if it was lost during status analysis
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
   * Handle AIS message received
   * @private
   */
  _onAISMessage(aisData) {
    this._processAISMessage(aisData);
  }

  /**
   * Handle AIS connection error
   * @private
   */
  _onAISError(error) {
    this.error('❌ [AIS_CONNECTION] AIS stream error:', error);
  }

  /**
   * Handle AIS reconnect needed
   * @private
   */
  _onAISReconnectNeeded() {
    // Try to reconnect with stored API key
    const apiKey = this.homey.settings.get('ais_api_key');
    if (apiKey) {
      this.aisClient.connect(apiKey).catch((err) => {
        this.error('Failed to reconnect to AIS stream:', err);
      });
    }
  }

  /**
   * Process AIS message from stream (with crash protection)
   * @private
   */
  _processAISMessage(message) {
    try {
      // CRITICAL FIX: Add comprehensive input validation
      if (!this._validateAISMessage(message)) {
        return;
      }

      // Update vessel in data service (normalize MMSI to string)
      const mmsiStr = String(message.mmsi);
      const vessel = this.vesselDataService.updateVessel(mmsiStr, {
        lat: message.lat,
        lon: message.lon,
        // Preserve unknown speed as null instead of forcing 0
        sog: Number.isFinite(message.sog) ? message.sog : null,
        cog: message.cog ?? null,
        name: message.shipName || 'Unknown',
      });

      if (vessel) {
        this.debug(`📡 [AIS_MESSAGE] Processed message for vessel ${message.mmsi}`);
      }

    } catch (error) {
      this.error('Error processing AIS message:', error);
      // Continue processing other messages
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
    try {
      // RACE CONDITION FIX: Filter out vessels that are being removed
      const vesselsBeingRemoved = this._processingRemoval || new Set();
      if (vesselsBeingRemoved.size > 0) {
        this.debug(`🔒 [RACE_PROTECTION] Skipping ${vesselsBeingRemoved.size} vessels being removed: ${Array.from(vesselsBeingRemoved).join(', ')}`);
      }

      // CRITICAL: Re-evaluate all vessel statuses before UI update
      // This ensures that time-sensitive statuses like "passed" are current
      this.debug('📱 [_actuallyUpdateUI] Re-evaluating vessel statuses');
      this._reevaluateVesselStatuses();

      // RACE CONDITION FIX: Get vessels relevant for bridge text with removal protection
      const relevantVessels = this._findRelevantBoatsForBridgeText()
        .filter((vessel) => !vesselsBeingRemoved.has(vessel.mmsi));
      this.debug(`📱 [_actuallyUpdateUI] Found ${relevantVessels.length} relevant vessels (filtered ${vesselsBeingRemoved.size} being removed)`);

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

      // Update devices if text changed (change detection prevents unnecessary updates)
      this.debug(`📱 [_actuallyUpdateUI] Comparing: new="${bridgeText}" vs last="${this._lastBridgeText}"`);

      // CRITICAL FIX: Also check for significant time passage to catch ETA changes
      // PASSAGE DUPLICATION FIX: Use status-based gating instead of string matching
      const timeSinceLastUpdate = Date.now() - (this._lastBridgeTextUpdate || 0);
      const hasPassedVessels = relevantVessels.some(vessel => vessel.status === 'passed');
      const forceUpdateDueToTime = timeSinceLastUpdate > 60000 && relevantVessels.length > 0 && !hasPassedVessels; // Force update every minute if vessels present, but never when "passed" vessels exist

      if (bridgeText !== this._lastBridgeText || forceUpdateDueToTime) {
        if (forceUpdateDueToTime && bridgeText === this._lastBridgeText) {
          this.debug('⏰ [_actuallyUpdateUI] Forcing update due to time passage (ETA changes)');
        }
        if (hasPassedVessels && timeSinceLastUpdate > 60000 && bridgeText === this._lastBridgeText) {
          this.debug('🚫 [PASSAGE_DUPLICATION] Prevented force update of "passed" vessels message - would create duplicate');
        }
        this.debug('✅ [_actuallyUpdateUI] Bridge text changed - updating devices');
        this._lastBridgeText = bridgeText;
        this._lastBridgeTextUpdate = Date.now(); // Track update time for force updates
        this._updateDeviceCapability('bridge_text', bridgeText);

        // CRITICAL FIX: Also update global token for flows
        try {
          if (this._globalBridgeTextToken) {
            await this._globalBridgeTextToken.setValue(bridgeText);
          }
        } catch (error) {
          this.error('[GLOBAL_TOKEN_ERROR] Failed to update global bridge text token:', error);
        }

        this.debug(`📱 [UI_UPDATE] Bridge text updated: "${bridgeText}"`);
        // Reset unchanged aggregation window on change
        this._unchangedCount = 0;
        this._unchangedWindowStart = Date.now();
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

    } catch (error) {
      this.error('Error updating UI:', error);
      // Don't let UI errors crash the app
    }
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
  _publishUpdate(version, bridgeKey, reasons) {
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
        this._actuallyUpdateUI();

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
   * Trigger boat near flow card (with deduplication)
   * @private
   */
  async _triggerBoatNearFlow(vessel) {
    try {
      if (!this._boatNearTrigger) {
        // Skip trigger if no flow card
        return;
      }

      // CRITICAL FIX: Use currentBridge as fallback when targetBridge is missing
      // This allows flow triggers for vessels at intermediate bridges
      const bridgeForFlow = vessel.targetBridge || vessel.currentBridge;

      // ENHANCED DEBUG: Log detailed vessel state for debugging
      this.debug(`🔍 [FLOW_TRIGGER_DEBUG] ${vessel.mmsi}: targetBridge="${vessel.targetBridge}", currentBridge="${vessel.currentBridge}", bridgeForFlow="${bridgeForFlow}"`);

      // CRITICAL FIX: Validate bridge name BEFORE any key generation or processing
      if (!bridgeForFlow || typeof bridgeForFlow !== 'string' || bridgeForFlow.trim() === '') {
        this.debug(`⚠️ [FLOW_TRIGGER] Skipping boat_near - vessel ${vessel.mmsi} has invalid bridge association: "${bridgeForFlow}" (type: ${typeof bridgeForFlow})`);
        return;
      }

      // Validate bridge name exists in our mapping
      const bridgeId = BRIDGE_NAME_TO_ID[bridgeForFlow];
      if (!bridgeId) {
        this.error(`[FLOW_TRIGGER] CRITICAL: Unknown bridge name "${bridgeForFlow}" - not found in BRIDGE_NAME_TO_ID mapping`);
        return;
      }

      // CRITICAL: Check if vessel is within 300m of the relevant bridge
      const proximityData = this.proximityService.analyzeVesselProximity(vessel);
      const bridges = proximityData.bridges || []; // Safety: ensure array exists

      // ENHANCED DEBUG: Log proximity data for debugging
      this.debug(`🔍 [FLOW_TRIGGER_DEBUG] ${vessel.mmsi}: proximityData.bridges count=${bridges.length}, looking for bridge="${bridgeForFlow}"`);
      bridges.forEach((bridge, index) => {
        this.debug(`🔍 [FLOW_TRIGGER_DEBUG] ${vessel.mmsi}: bridge[${index}] = {name: "${bridge.name}", distance: ${bridge.distance?.toFixed(0)}m}`);
      });

      const relevantBridgeData = bridges.find((b) => b.name === bridgeForFlow);

      if (!relevantBridgeData || relevantBridgeData.distance > FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD) {
        // Vessel is not within 300m of the bridge, skip trigger
        this.debug(`🚫 [FLOW_TRIGGER] Skipping boat_near - ${vessel.mmsi} is ${relevantBridgeData ? Math.round(relevantBridgeData.distance) : '?'}m from ${bridgeForFlow} (>300m)`);
        return;
      }

      // CRITICAL FIX: Create deduplication key ONLY after all validations pass
      // This ensures we never create keys with invalid bridge names
      const dedupeKey = `${vessel.mmsi}:${bridgeForFlow}`;

      // Skip if already triggered for this vessel+bridge combo
      if (this._triggeredBoatNearKeys.has(dedupeKey)) {
        this.debug(`🚫 [FLOW_TRIGGER] Already triggered boat_near for ${dedupeKey} - waiting for vessel to leave area`);
        return;
      }

      // Create tokens with validated bridge name
      const tokens = {
        vessel_name: vessel.name || 'Unknown', // FIX: Changed from boat_name to match app.json declaration
        bridge_name: bridgeForFlow, // Already validated above
        direction: this._getDirectionString(vessel),
      };

      // Always compute numeric ETA token for flows; use -1 when ETA is unavailable
      tokens.eta_minutes = Number.isFinite(vessel.etaMinutes)
        ? Math.round(vessel.etaMinutes)
        : -1;

      // ENHANCED DEBUG: Log token values before trigger
      this.debug(`🔍 [FLOW_TRIGGER_DEBUG] ${vessel.mmsi}: Creating tokens = ${JSON.stringify(tokens)}`);

      // CRITICAL FIX: Create DEEP immutable copy to prevent race conditions and object mutation
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
        this.debug(`🛈 [FLOW_TRIGGER_DIAG] ${vessel.mmsi}: ETA unavailable → sending eta_minutes=-1 for bridgeId="${bridgeId}"`);
      }

      // Trigger for specific bridge flows (bridgeId already validated above)
      this.debug(`🎯 [FLOW_TRIGGER_DEBUG] ${vessel.mmsi}: About to trigger with bridgeId="${bridgeId}" and safeTokens=${JSON.stringify(safeTokens)}`);

      try {
        // *** CRITICAL FIX: CORRECT PARAMETER ORDER - tokens first, state second ***
        await this._boatNearTrigger.trigger(safeTokens, { bridge: bridgeId });
        this.debug(`✅ [FLOW_TRIGGER_DEBUG] ${vessel.mmsi}: Successfully triggered for bridge "${bridgeId}"`);

        // CRITICAL FIX: Add key to deduplication set ONLY after successful trigger
        // This prevents orphaned keys if trigger fails
        this._triggeredBoatNearKeys.add(dedupeKey);
        this.debug(`🎯 [FLOW_TRIGGER] boat_near triggered for ${vessel.mmsi} at ${Math.round(relevantBridgeData.distance)}m from ${bridgeForFlow}`);

      } catch (triggerError) {
        this.error(`[FLOW_TRIGGER] FAILED to trigger bridge "${bridgeId}":`, triggerError);
        this.error(`[FLOW_TRIGGER] Failed tokens: ${JSON.stringify(safeTokens)}`);
        // Don't add key to deduplication set if trigger failed
        // Don't re-throw - let app continue
        return;
      }

    } catch (error) {
      this.error('Error triggering boat near flow:', error);
      // ENHANCED DEBUG: Log detailed error context
      this.error(`[FLOW_TRIGGER] Error context: vessel=${vessel?.mmsi}, targetBridge=${vessel?.targetBridge}, currentBridge=${vessel?.currentBridge}`);
    }
  }

  /**
   * Trigger boat near flow card for "any" bridge
   * @private
   */
  async _triggerBoatNearFlowForAny(vessel) {
    // CRITICAL FIX: Declare proximityData in outer scope for error handling
    let proximityData = null;
    let nearbyBridge = null;

    try {
      if (!this._boatNearTrigger) {
        this.debug(`🚫 [FLOW_TRIGGER_ANY] No boat_near trigger available for vessel ${vessel?.mmsi}`);
        return;
      }

      // CRITICAL FIX: Enhanced vessel validation
      if (!vessel || !vessel.mmsi || !Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
        this.error(`[FLOW_TRIGGER_ANY] CRITICAL: Invalid vessel data provided: ${JSON.stringify(vessel)}`);
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

      try {
        // *** CRITICAL FIX: CORRECT PARAMETER ORDER - tokens first, state second ***
        await this._boatNearTrigger.trigger(safeTokens, { bridge: 'any' });
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
    // Clear all trigger keys for this vessel
    const keysToRemove = [];
    for (const key of this._triggeredBoatNearKeys) {
      if (key.startsWith(`${vessel.mmsi}:`)) {
        keysToRemove.push(key);
      }
    }

    if (keysToRemove.length > 0) {
      keysToRemove.forEach((key) => this._triggeredBoatNearKeys.delete(key));
      this.debug(`🧹 [TRIGGER_CLEAR] Cleared ${keysToRemove.length} boat_near triggers for vessel ${vessel.mmsi}`);
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
      this._boatNearTrigger = this.homey.flow.getTriggerCard('boat_near');

      // Condition cards
      const boatRecentCondition = this.homey.flow.getConditionCard('boat_at_bridge');
      boatRecentCondition.registerRunListener(async (args) => {
        try {
          // Input validation - ensure bridge parameter exists and is valid
          if (!args || typeof args.bridge !== 'string' || args.bridge.trim() === '') {
            this.error('Invalid bridge parameter in boat_at_bridge condition:', args);
            return false;
          }

          const bridgeName = args.bridge.trim();

          // Validate bridge parameter against known values
          const validBridgeIds = Object.keys(BRIDGE_ID_TO_NAME).concat(['any']);
          if (!validBridgeIds.includes(bridgeName)) {
            this.error(`Unknown bridge ID in boat_at_bridge condition: "${bridgeName}". Valid IDs:`, validBridgeIds);
            return false;
          }

          const allVessels = this.vesselDataService.getAllVessels();

          // Safety check - ensure vessels array exists
          if (!Array.isArray(allVessels)) {
            this.error('boat_at_bridge condition: allVessels is not an array');
            return false;
          }

          // Check if any vessel is within 300m of the specified bridge
          return allVessels.some((vessel) => {
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

            if (bridgeName === 'any') {
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
            const actualBridgeName = BRIDGE_ID_TO_NAME[bridgeName];
            if (!actualBridgeName) {
              this.error(`boat_at_bridge condition: No bridge name mapping found for ID "${bridgeName}"`);
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

            return bridgeData.distance <= FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD;
          });

        } catch (error) {
          this.error('Unexpected error in boat_at_bridge flow condition:', error.message || error);
          this.error('Stack trace:', error.stack);
          return false; // Safe default - condition fails on error
        }
      });

      this.log('✅ Flow cards configured');
    } catch (error) {
      this.error('Error setting up flow cards:', error);
      // Flow cards are optional - don't crash the app
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
