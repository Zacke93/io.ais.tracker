'use strict';

const Homey = require('homey');

// Import modular services
const BridgeRegistry = require('./lib/models/BridgeRegistry');
const VesselDataService = require('./lib/services/VesselDataService');
const BridgeTextService = require('./lib/services/BridgeTextService');
const ProximityService = require('./lib/services/ProximityService');
const StatusService = require('./lib/services/StatusService');
const AISStreamClient = require('./lib/connection/AISStreamClient');
const { etaDisplay } = require('./lib/utils/etaValidation');

// Import utilities and constants
const {
  BRIDGES, COG_DIRECTIONS,
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
    this._eventsHooked = false;

    // Boat near trigger deduplication - tracks which vessels have been triggered for each bridge
    this._triggeredBoatNearKeys = new Set(); // Track vessel+bridge combinations that have been triggered

    // UI update debouncing to prevent double bridge text changes
    this._uiUpdateTimer = null;
    this._uiUpdatePending = false;

    // Timer tracking for cleanup
    this._vesselRemovalTimers = new Map(); // Track vessel removal timers
    this._monitoringInterval = null; // Track monitoring interval

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

    this.log('AIS Bridge initialized successfully with modular architecture');
  }

  /**
   * Initialize all modular services
   * @private
   */
  async _initializeServices() {
    try {
      this.log('🔧 Initializing modular services...');

      // Core models
      this.bridgeRegistry = new BridgeRegistry(BRIDGES);

      // Validate bridge configuration
      const validation = this.bridgeRegistry.validateConfiguration();
      if (!validation.valid) {
        this.error('Bridge configuration invalid:', validation.errors);
        throw new Error('Invalid bridge configuration');
      }

      // Data services
      this.vesselDataService = new VesselDataService(this, this.bridgeRegistry);

      // Analysis services
      this.proximityService = new ProximityService(this.bridgeRegistry, this);
      this.statusService = new StatusService(this.bridgeRegistry, this);

      // Output services (inject ProximityService for consistent distance calculations)
      this.bridgeTextService = new BridgeTextService(this.bridgeRegistry, this, this.proximityService);

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
    this._updateUI();
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

    // CRITICAL FIX: Clear any pending removal timer for this vessel
    if (this._vesselRemovalTimers.has(mmsi)) {
      clearTimeout(this._vesselRemovalTimers.get(mmsi));
      this._vesselRemovalTimers.delete(mmsi);
      this.debug(`🧹 [CLEANUP] Cleared removal timer for ${mmsi}`);
    }

    // Clear any UI references
    await this._clearBridgeText(mmsi);

    // Update UI
    this._updateUI();
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
        this.debug(`🏁 [FINAL_BRIDGE_PASSED] Vessel ${vessel.mmsi} passed final target bridge ${vessel.targetBridge} - scheduling removal in 15s`);

        // CRITICAL FIX: Track timer for cleanup
        // Clear any existing timer for this vessel first
        if (this._vesselRemovalTimers.has(vessel.mmsi)) {
          clearTimeout(this._vesselRemovalTimers.get(vessel.mmsi));
        }

        // Specs: 'passed' status must show for 1 minute
        // Remove after 60 seconds to allow bridge text to show "precis passerat"
        const timerId = setTimeout(() => {
          this.vesselDataService.removeVessel(vessel.mmsi, 'passed-final-bridge');
          this._vesselRemovalTimers.delete(vessel.mmsi); // Clean up timer reference
        }, 60000); // 60 seconds per Bridge Text Format V2.0 specification

        this._vesselRemovalTimers.set(vessel.mmsi, timerId);
        return; // Don't update UI yet, let "precis passerat" show first
      }
    }

    // Update UI for significant status changes
    const significantStatuses = ['approaching', 'waiting', 'under-bridge', 'passed'];
    if (significantStatuses.includes(newStatus) || significantStatuses.includes(oldStatus)) {
      this._updateUI();
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

      // 3. Analyze and update vessel status
      const statusResult = this.statusService.analyzeVesselStatus(vessel, proximityData);

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
      this.debug(`🎯 [POSITION_ANALYSIS] ${vessel.mmsi}: status=${vessel.status}, distance=${proximityData.nearestDistance.toFixed(0)}m, ETA=${etaDisplayText}`);

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
   * Calculate initial target bridge based on vessel position and COG
   * @private
   */
  _calculateInitialTargetBridge(vessel) {
    // FIXED: Assign target bridge based on which target bridge vessel will encounter FIRST
    // Bridge order (south to north): Klaffbron → Stridsbergsbron

    if (vessel.cog >= COG_DIRECTIONS.NORTH_MIN || vessel.cog <= COG_DIRECTIONS.NORTH_MAX) {
      // Northbound (from south): Will encounter Stridsbergsbron first
      return 'Stridsbergsbron';
    }

    // Southbound (from north): Will encounter Klaffbron first
    return 'Klaffbron';
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

      // Update vessel in data service
      const vessel = this.vesselDataService.updateVessel(message.mmsi, {
        lat: message.lat,
        lon: message.lon,
        sog: message.sog || 0,
        cog: message.cog || 0,
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
   * Validate AIS message data
   * @private
   */
  _validateAISMessage(message) {
    if (!message || typeof message !== 'object') {
      this.debug('⚠️ [AIS_VALIDATION] Invalid message object');
      return false;
    }

    if (!message.mmsi || typeof message.mmsi !== 'string') {
      this.debug('⚠️ [AIS_VALIDATION] Missing or invalid MMSI');
      return false;
    }

    // Validate latitude (-90 to 90)
    if (typeof message.lat !== 'number' || message.lat < -90 || message.lat > 90) {
      this.debug(`⚠️ [AIS_VALIDATION] Invalid latitude: ${message.lat}`);
      return false;
    }

    // Validate longitude (-180 to 180)
    if (typeof message.lon !== 'number' || message.lon < -180 || message.lon > 180) {
      this.debug(`⚠️ [AIS_VALIDATION] Invalid longitude: ${message.lon}`);
      return false;
    }

    // Validate speed over ground (0 to reasonable max, e.g., 100 knots)
    if (message.sog !== undefined && (typeof message.sog !== 'number' || message.sog < 0 || message.sog > 100)) {
      this.debug(`⚠️ [AIS_VALIDATION] Invalid SOG: ${message.sog}`);
      return false;
    }

    // Validate course over ground (0 to 360)
    if (message.cog !== undefined && (typeof message.cog !== 'number' || message.cog < 0 || message.cog >= 360)) {
      this.debug(`⚠️ [AIS_VALIDATION] Invalid COG: ${message.cog}`);
      return false;
    }

    return true;
  }

  /**
   * Update UI bridge text
   * @private
   */
  _updateUI() {
    // DEBOUNCE: Prevent multiple UI updates in quick succession
    if (this._uiUpdatePending) {
      return; // Already scheduled
    }

    this._uiUpdatePending = true;

    // Clear any existing timer
    if (this._uiUpdateTimer) {
      clearTimeout(this._uiUpdateTimer);
    }

    // Schedule update after brief delay to allow all events to settle
    this._uiUpdateTimer = setTimeout(() => {
      this._actuallyUpdateUI();
      this._uiUpdatePending = false;
      this._uiUpdateTimer = null;
    }, 10); // 10ms debounce
  }

  /**
   * Actually perform the UI update (with crash protection)
   * @private
   */
  async _actuallyUpdateUI() {
    try {
      // CRITICAL: Re-evaluate all vessel statuses before UI update
      // This ensures that time-sensitive statuses like "passed" are current
      this._reevaluateVesselStatuses();

      // Get vessels relevant for bridge text
      const relevantVessels = this._findRelevantBoatsForBridgeText();

      // Generate bridge text
      const bridgeText = this.bridgeTextService.generateBridgeText(relevantVessels);

      // Update devices if text changed
      if (bridgeText !== this._lastBridgeText) {
        this._lastBridgeText = bridgeText;
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
      }

      // Update connection status
      this._updateDeviceCapability('connection_status', this._isConnected ? 'connected' : 'disconnected');

      // Update alarm_generic - active when boats are present
      const defaultMessage = 'Inga båtar i närheten av Stridsbergsbron eller Klaffbron';
      const hasActiveBoats = bridgeText && bridgeText !== defaultMessage;
      this._updateDeviceCapability('alarm_generic', hasActiveBoats);

      if (hasActiveBoats) {
        this.debug(`🚨 [ALARM_GENERIC] Active - boats present: "${bridgeText}"`);
      }

    } catch (error) {
      this.error('Error updating UI:', error);
      // Don't let UI errors crash the app
    }
  }

  /**
   * Re-evaluate all vessel statuses (critical for time-sensitive updates)
   * @private
   */
  _reevaluateVesselStatuses() {
    const allVessels = this.vesselDataService.getAllVessels();

    allVessels.forEach((vessel) => {
      // Re-analyze proximity and status for each vessel
      const proximityData = this.proximityService.analyzeVesselProximity(vessel);
      const statusResult = this.statusService.analyzeVesselStatus(vessel, proximityData);

      // Update vessel status if it changed
      if (statusResult.statusChanged) {
        vessel.status = statusResult.status;
        vessel.isWaiting = statusResult.isWaiting;
        vessel.isApproaching = statusResult.isApproaching;
      }

      // CRITICAL FIX: Always recalculate ETA for relevant statuses
      // ETA can change even if status doesn't change
      if (['approaching', 'waiting', 'en-route', 'stallbacka-waiting'].includes(vessel.status)) {
        vessel.etaMinutes = this.statusService.calculateETA(vessel, proximityData);
      } else {
        vessel.etaMinutes = null;

        this.debug(`🔄 [STATUS_UPDATE] ${vessel.mmsi}: ${statusResult.status} (${statusResult.statusReason})`);
      }
    });
  }

  /**
   * Find vessels relevant for bridge text generation
   * @private
   */
  _findRelevantBoatsForBridgeText() {
    const vessels = this.vesselDataService.getVesselsForBridgeText();

    // Transform vessel data to format expected by BridgeTextService
    return vessels.map((vessel) => {
      // Find current bridge based on nearest distance
      const proximityData = this.proximityService.analyzeVesselProximity(vessel);
      let currentBridge = null;

      if (proximityData.nearestBridge && proximityData.nearestDistance <= 400) {
        // PASSAGE CLEARING: Don't set currentBridge if vessel has recently passed this bridge
        // and is now moving away (avoids "En båt vid X" messages after passage)
        const bridgeName = proximityData.nearestBridge.name;
        const hasRecentlyPassedThisBridge = vessel.lastPassedBridge === bridgeName
          && vessel.lastPassedBridgeTime
          && (Date.now() - vessel.lastPassedBridgeTime) < 3 * 60 * 1000; // 3 minutes

        if (!hasRecentlyPassedThisBridge) {
          currentBridge = bridgeName;
        } else {
          this.debug(`🌉 [PASSAGE_CLEAR] ${vessel.mmsi}: Not setting currentBridge to ${bridgeName} - recently passed`);
        }
      }

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
        distanceToCurrent: proximityData.nearestDistance,
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

    const hasSignificantChange = significantChanges.some((key) => vessel[key] !== oldVessel?.[key]);

    if (hasSignificantChange) {
      this._updateUI();
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
   * Clear bridge text references to specific vessel
   * @private
   */
  async _clearBridgeText(mmsi) {
    // Implementation would clear any specific references
    // For now, just trigger a general UI update
    this._updateUI();
  }

  /**
   * Trigger boat near flow card (with deduplication)
   * @private
   */
  async _triggerBoatNearFlow(vessel) {
    try {
      if (!this._boatNearTrigger || !vessel.targetBridge) {
        // Skip trigger if no flow card or no target bridge
        return;
      }

      // CRITICAL: Check if vessel is within 300m of target bridge
      const proximityData = this.proximityService.analyzeVesselProximity(vessel);
      const targetBridgeData = proximityData.bridges.find((b) => b.name === vessel.targetBridge);

      if (!targetBridgeData || targetBridgeData.distance > 300) {
        // Vessel is not within 300m of target bridge, skip trigger
        this.debug(`🚫 [FLOW_TRIGGER] Skipping boat_near - ${vessel.mmsi} is ${targetBridgeData ? Math.round(targetBridgeData.distance) : '?'}m from ${vessel.targetBridge} (>300m)`);
        return;
      }

      // Dedupe key: vessel+bridge combination
      const key = `${vessel.mmsi}:${vessel.targetBridge}`;

      // Skip if already triggered for this vessel+bridge combo
      if (this._triggeredBoatNearKeys.has(key)) {
        this.debug(`🚫 [FLOW_TRIGGER] Already triggered boat_near for ${key} - waiting for vessel to leave area`);
        return;
      }

      const tokens = {
        boat_name: vessel.name || 'Unknown',
        bridge_name: vessel.targetBridge,
        direction: this._getDirectionString(vessel),
        eta_minutes: Math.round(vessel.etaMinutes || 0),
      };

      // Trigger for specific bridge flows
      const bridgeIdMap = {
        Olidebron: 'olidebron',
        Klaffbron: 'klaffbron',
        Järnvägsbron: 'jarnvagsbron',
        Stridsbergsbron: 'stridsbergsbron',
        Stallbackabron: 'stallbackabron',
      };
      const bridgeId = bridgeIdMap[vessel.targetBridge];
      if (bridgeId) {
        await this._boatNearTrigger.trigger({ bridge: bridgeId }, tokens);
      }
      this._triggeredBoatNearKeys.add(key);
      this.debug(`🎯 [FLOW_TRIGGER] boat_near triggered for ${vessel.mmsi} at ${Math.round(targetBridgeData.distance)}m from ${vessel.targetBridge}`);

    } catch (error) {
      this.error('Error triggering boat near flow:', error);
    }
  }

  /**
   * Trigger boat near flow card for "any" bridge
   * @private
   */
  async _triggerBoatNearFlowForAny(vessel) {
    try {
      if (!this._boatNearTrigger) {
        return;
      }

      // Check if vessel is within 300m of ANY bridge
      const proximityData = this.proximityService.analyzeVesselProximity(vessel);
      const nearbyBridge = proximityData.bridges.find((b) => b.distance <= 300);

      if (!nearbyBridge) {
        return;
      }

      // Dedupe key for "any" bridge
      const key = `${vessel.mmsi}:any`;

      if (this._triggeredBoatNearKeys.has(key)) {
        return;
      }

      const tokens = {
        boat_name: vessel.name || 'Unknown',
        bridge_name: nearbyBridge.name,
        direction: this._getDirectionString(vessel),
        eta_minutes: Math.round(vessel.etaMinutes || 0),
      };

      // Trigger with special args for "any" bridge flows
      await this._boatNearTrigger.trigger({ bridge: 'any' }, tokens);
      this._triggeredBoatNearKeys.add(key);
      this.debug(`🎯 [FLOW_TRIGGER] boat_near (any) triggered for ${vessel.mmsi} at ${Math.round(nearbyBridge.distance)}m from ${nearbyBridge.name}`);

    } catch (error) {
      this.error('Error triggering boat near flow for any:', error);
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
   * Get direction string for vessel
   * @private
   */
  _getDirectionString(vessel) {
    if (!vessel.cog) return 'unknown';

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
      this._boatNearTrigger = this.homey.flow.getDeviceTriggerCard('boat_near');

      // Condition cards
      const boatRecentCondition = this.homey.flow.getConditionCard('boat_at_bridge');
      boatRecentCondition.registerRunListener(async (args) => {
        try {
          const bridgeName = args.bridge;
          const allVessels = this.vesselDataService.getAllVessels();

          // Check if any vessel is within 300m of the specified bridge
          return allVessels.some((vessel) => {
            const proximityData = this.proximityService.analyzeVesselProximity(vessel);

            if (bridgeName === 'any') {
              // Check if vessel is within 300m of ANY bridge
              return proximityData.bridges.some((b) => b.distance <= 300);
            }
            // Check if vessel is within 300m of SPECIFIC bridge
            // Convert bridge ID to proper name
            const bridgeNameMap = {
              olidebron: 'Olidebron',
              klaffbron: 'Klaffbron',
              jarnvagsbron: 'Järnvägsbron',
              stridsbergsbron: 'Stridsbergsbron',
              stallbackabron: 'Stallbackabron',
            };
            const actualBridgeName = bridgeNameMap[bridgeName] || bridgeName;
            const bridgeData = proximityData.bridges.find((b) => b.name === actualBridgeName);
            return bridgeData && bridgeData.distance <= 300;

          });
        } catch (error) {
          this.error('Error in flow condition:', error);
          return false; // Safe default
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
    // CRITICAL FIX: Track interval for cleanup
    // Monitor vessel count
    this._monitoringInterval = setInterval(() => {
      const vesselCount = this.vesselDataService.getVesselCount();
      if (vesselCount > 0) {
        this.debug(`📊 [MONITORING] Tracking ${vesselCount} vessels`);
      }
    }, 60000); // Every minute
  }

  /**
   * Cleanup on app shutdown
   */
  async onUninit() {
    this.log('🛑 AIS Bridge shutting down...');

    // CRITICAL FIX: Cleanup all timers to prevent memory leaks

    // Clear UI update timer
    if (this._uiUpdateTimer) {
      clearTimeout(this._uiUpdateTimer);
      this._uiUpdateTimer = null;
    }

    // Clear all vessel removal timers
    for (const [mmsi, timerId] of this._vesselRemovalTimers) {
      clearTimeout(timerId);
      this.debug(`🧹 [CLEANUP] Cleared removal timer for vessel ${mmsi}`);
    }
    this._vesselRemovalTimers.clear();

    // Clear monitoring interval
    if (this._monitoringInterval) {
      clearInterval(this._monitoringInterval);
      this._monitoringInterval = null;
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
   * Update connection status on all devices
   * @private
   */
  _updateConnectionStatus(connected) {
    for (const device of this._devices) {
      if (device.setCapabilityValue) {
        device.setCapabilityValue('connection_status', connected ? 'connected' : 'disconnected')
          .catch((err) => this.error('Failed to update connection status:', err));
      }
    }
  }

  /**
   * Device management
   */
  addDevice(device) {
    this._devices.add(device);
    this.log(`📱 Device added: ${device.getName()}`);
  }

  removeDevice(device) {
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
