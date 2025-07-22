'use strict';

const Homey = require('homey');

// Import modular services
const BridgeRegistry = require('./lib/models/BridgeRegistry');
const VesselDataService = require('./lib/services/VesselDataService');
const BridgeTextService = require('./lib/services/BridgeTextService');
const ProximityService = require('./lib/services/ProximityService');
const StatusService = require('./lib/services/StatusService');
const AISStreamClient = require('./lib/connection/AISStreamClient');

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
    this.log('AIS Bridge starting with modular architecture v2.0');

    // Initialize settings and state
    this.debugLevel = this.homey.settings.get('debug_level') || 'basic';
    this._isConnected = false;
    this._devices = new Set();
    this._lastBridgeText = '';
    this._lastBridgeAlarm = false;
    this._eventsHooked = false;

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

      // Output services
      this.bridgeTextService = new BridgeTextService(this.bridgeRegistry, this);

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

    // Update UI
    this._updateUI();
  }

  /**
   * Handle vessel data updates
   * @private
   */
  async _onVesselUpdated({ mmsi, vessel, oldVessel }) {
    this.debug(`📝 [VESSEL_UPDATED] Vessel: ${mmsi}`);

    // Analyze position and status changes
    await this._analyzeVesselPosition(vessel);

    // Update UI if needed
    this._updateUIIfNeeded(vessel, oldVessel);
  }

  /**
   * Handle vessel removal
   * @private
   */
  async _onVesselRemoved({ mmsi, vessel, reason }) {
    this.debug(`🗑️ [VESSEL_REMOVED] Vessel: ${mmsi} (${reason})`);

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

    // Trigger flow cards for important status changes
    if (newStatus === 'approaching') {
      await this._triggerBoatNearFlow(vessel);
    }

    // Check if vessel has passed its final target bridge
    if (newStatus === 'passed' && vessel.targetBridge) {
      if (this._hasPassedFinalTargetBridge(vessel)) {
        this.debug(`🏁 [FINAL_BRIDGE_PASSED] Vessel ${vessel.mmsi} passed final target bridge ${vessel.targetBridge} - scheduling removal in 15s`);
        // Remove after short delay to allow bridge text to show "precis passerat"
        setTimeout(() => {
          this.vesselDataService.removeVessel(vessel.mmsi, 'passed-final-bridge');
        }, 15000); // 15 seconds
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
   * Analyze vessel position and update all related services
   * @private
   */
  async _analyzeVesselPosition(vessel) {
    try {
      // 1. Analyze proximity to bridges
      const proximityData = this.proximityService.analyzeVesselProximity(vessel);

      // 2. Analyze and update vessel status
      const statusResult = this.statusService.analyzeVesselStatus(vessel, proximityData);

      // 3. Update vessel with analysis results
      Object.assign(vessel, statusResult);
      vessel._distanceToNearest = proximityData.nearestDistance;

      // 4. Calculate ETA if approaching
      if (statusResult.status === 'approaching' || statusResult.status === 'waiting') {
        vessel.etaMinutes = this.statusService.calculateETA(vessel, proximityData);
      }

      // 5. Schedule appropriate cleanup timeout
      const timeout = this.proximityService.calculateProximityTimeout(vessel, proximityData);
      this.vesselDataService.scheduleCleanup(vessel.mmsi, timeout);

      this.debug(`🎯 [POSITION_ANALYSIS] ${vessel.mmsi}: status=${vessel.status}, distance=${proximityData.nearestDistance.toFixed(0)}m, ETA=${vessel.etaMinutes?.toFixed(1)}min`);

    } catch (error) {
      this.error(`Error analyzing vessel position for ${vessel.mmsi}:`, error);
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

    // Determine target bridge based on position and course
    const targetBridge = this._calculateInitialTargetBridge(vessel);
    if (targetBridge) {
      vessel.targetBridge = targetBridge;
      this.debug(`🎯 [TARGET_BRIDGE] Assigned ${targetBridge} to vessel ${vessel.mmsi}`);
    }
  }

  /**
   * Calculate initial target bridge based on vessel position and COG
   * @private
   */
  _calculateInitialTargetBridge(vessel) {
    // FIXED: Assign target bridge based on which target bridge vessel will encounter FIRST
    // Bridge order (south to north): Klaffbron → Stridsbergsbron

    if (vessel.cog >= COG_DIRECTIONS.NORTH_MIN || vessel.cog <= COG_DIRECTIONS.NORTH_MAX) {
      // Northbound (from south): Will encounter Klaffbron first
      return 'Klaffbron';
    }

    // Southbound (from north): Will encounter Stridsbergsbron first
    return 'Stridsbergsbron';
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
   * Process AIS message from stream
   * @private
   */
  _processAISMessage(message) {
    try {
      if (!message || !message.mmsi) {
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
    }
  }

  /**
   * Update UI bridge text
   * @private
   */
  _updateUI() {
    try {
      // Get vessels relevant for bridge text
      const relevantVessels = this._findRelevantBoatsForBridgeText();

      // Generate bridge text
      const bridgeText = this.bridgeTextService.generateBridgeText(relevantVessels);

      // Update devices if text changed
      if (bridgeText !== this._lastBridgeText) {
        this._lastBridgeText = bridgeText;
        this._updateDeviceCapability('bridge_text', bridgeText);
        this.debug(`📱 [UI_UPDATE] Bridge text updated: "${bridgeText}"`);
      }

      // Update connection status
      this._updateDeviceCapability('connection_status', this._isConnected ? 'connected' : 'disconnected');

    } catch (error) {
      this.error('Error updating UI:', error);
    }
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
        currentBridge = proximityData.nearestBridge.name;
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
        lastPassedBridgeTime: vessel.lastPassedBridgeTime,
        distance: proximityData.nearestDistance,
        distanceToCurrent: proximityData.nearestDistance,
        sog: vessel.sog,
        passedBridges: vessel.passedBridges || [],
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
   * Update device capability for all devices
   * @private
   */
  _updateDeviceCapability(capability, value) {
    for (const device of this._devices) {
      try {
        device.setCapabilityValue(capability, value).catch((err) => {
          this.error(`Error setting ${capability} for device ${device.getName()}:`, err);
        });
      } catch (error) {
        this.error(`Error updating capability ${capability}:`, error);
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
   * Trigger boat near flow card
   * @private
   */
  async _triggerBoatNearFlow(vessel) {
    try {
      if (!this._boatNearTrigger) {
        return;
      }

      const tokens = {
        boat_name: vessel.name || 'Unknown',
        bridge_name: vessel.targetBridge || 'Unknown',
        direction: this._getDirectionString(vessel),
        eta_minutes: Math.round(vessel.etaMinutes || 0),
      };

      await this._boatNearTrigger.trigger(null, tokens);
      this.debug(`🎯 [FLOW_TRIGGER] boat_near triggered for ${vessel.mmsi}`);

    } catch (error) {
      this.error('Error triggering boat near flow:', error);
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
   * Initialize global flow token
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
    }
  }

  /**
   * Setup flow cards
   * @private
   */
  async _setupFlowCards() {
    try {
      // Trigger cards
      this._boatNearTrigger = this.homey.flow.getDeviceTriggerCard('boat_near');

      // Condition cards
      const boatRecentCondition = this.homey.flow.getConditionCard('boat_at_bridge');
      boatRecentCondition.registerRunListener(async (args) => {
        const bridgeName = args.bridge;
        const vessels = this.vesselDataService.getVesselsByTargetBridge(bridgeName);
        return vessels.some((vessel) => ['approaching', 'waiting', 'under-bridge'].includes(vessel.status));
      });

      this.log('✅ Flow cards configured');
    } catch (error) {
      this.error('Error setting up flow cards:', error);
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
    // Monitor vessel count
    setInterval(() => {
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

    // Disconnect AIS stream
    if (this.aisClient) {
      this.aisClient.disconnect();
    }

    // Remove event listeners
    if (this.homey && this.homey.settings) {
      this.homey.settings.off('set', this._onSettingsChanged);
    }

    this.log('✅ AIS Bridge shutdown complete');
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
