'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');
const { AIS_CONFIG, MAX_RECONNECT_ATTEMPTS, MAX_RECONNECT_DELAY } = require('../constants');

/**
 * AISStreamClient - Handles WebSocket connection to AISstream.io
 * Manages connection lifecycle, reconnection, and message filtering
 */
class AISStreamClient extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.lastMessageTime = null;
    this.apiKey = null; // Store API key for subscription
    this.openedAt = null; // Track connection open time for uptime
    this.lastSubscribeTime = null; // Track last subscription time
  }

  /**
   * Connect to AIS stream
   * @param {string} apiKey - API key for AISstream.io
   * @returns {Promise<void>}
   */
  async connect(apiKey) {
    if (this.isConnected || this.ws) {
      this.logger.debug('🌐 [AIS_CLIENT] Already connected or connecting');
      return;
    }

    try {
      this.logger.log('🌐 [AIS_CLIENT] Connecting to AISstream.io...');

      // Store API key for subscription
      this.apiKey = apiKey;

      // CRITICAL FIX: Connect to WebSocket endpoint without API key in URL
      // API key is sent via subscription message after connection opens
      this.ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
      this._setupWebSocketHandlers();

    } catch (error) {
      this.logger.error('❌ [AIS_CLIENT] Connection failed:', error);
      this.emit('error', error);
      this._scheduleReconnect();
    }
  }

  /**
   * Disconnect from AIS stream
   */
  disconnect() {
    this.logger.log('🛑 [AIS_CLIENT] Disconnecting...');

    this.isConnected = false;
    this._stopHeartbeat();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // FIX: Don't emit 'disconnected' here - let the 'close' event handler do it
    // This prevents double emission when ws.close() triggers the close event
  }

  /**
   * Get connection status
   * @returns {boolean} True if connected
   */
  getConnectionStatus() {
    return this.isConnected;
  }

  /**
   * Get connection statistics
   * @returns {Object} Connection stats
   */
  getConnectionStats() {
    return {
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      lastMessageTime: this.lastMessageTime,
      uptime: this.openedAt ? Date.now() - this.openedAt : 0,
      timeSinceLastMessage: this.lastMessageTime ? Date.now() - this.lastMessageTime : null,
    };
  }

  /**
   * Send subscription message with API key and bounding box
   * @private
   */
  _subscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.apiKey) {
      this.logger.debug('🚫 [AIS_CLIENT] Cannot subscribe - WebSocket not ready or no API key');
      return;
    }

    // Skip if we subscribed recently (within 45 seconds)
    if (this.lastSubscribeTime && Date.now() - this.lastSubscribeTime < 45000) {
      return;
    }

    // CRITICAL FIX: Use exact bounding box coordinates from old working version
    // This covers the Trollhättan canal area where the bridges are located
    const boundingBox = [
      [58.320786584215874, 12.269025682200194], // North-West corner
      [58.268138604819576, 12.323830097692591], // South-East corner
    ];

    // Use API key field name from constants for consistency
    const subscriptionMessage = {
      [AIS_CONFIG.API_KEY_FIELD]: this.apiKey, // Uses 'APIKey' from constants
      BoundingBoxes: [boundingBox],
    };

    try {
      this.ws.send(JSON.stringify(subscriptionMessage));
      this.lastSubscribeTime = Date.now();
      this.logger.log('📡 [AIS_CLIENT] Subscription message sent');
    } catch (error) {
      this.logger.error('❌ [AIS_CLIENT] Failed to send subscription:', error);
    }
  }

  /**
   * Setup WebSocket event handlers
   * @private
   */
  _setupWebSocketHandlers() {
    this.ws.on('open', this._onOpen.bind(this));
    this.ws.on('message', this._onMessage.bind(this));
    this.ws.on('close', this._onClose.bind(this));
    this.ws.on('error', this._onError.bind(this));
    this.ws.on('ping', this._onPing.bind(this));
    this.ws.on('pong', this._onPong.bind(this));
  }

  /**
   * Handle WebSocket open event
   * @private
   */
  _onOpen() {
    this.logger.log('✅ [AIS_CLIENT] Connected to AISstream.io');

    this.isConnected = true;
    this.reconnectAttempts = 0;
    this.openedAt = Date.now(); // Track when connection opened

    // CRITICAL FIX: Send subscription message with API key and bounding box
    this._subscribe();

    this._startHeartbeat();
    this.emit('connected');
  }

  /**
   * Handle WebSocket message event
   * @private
   */
  _onMessage(data) {
    try {
      const message = JSON.parse(data);

      // CRITICAL FIX: Use string message types like old working version
      const validMessageTypes = [
        'PositionReport',
        'StandardClassBPositionReport',
        'ExtendedClassBPositionReport',
      ];

      if (!validMessageTypes.includes(message.MessageType)) {
        return;
      }

      // Extract AIS data
      const aisData = this._extractAISData(message);
      if (aisData) {
        this.lastMessageTime = Date.now(); // Update last message time
        this.emit('ais-message', aisData);
        // Removed debug spam - AIS messages are processed frequently
      }

    } catch (error) {
      this.logger.log('⚠️ [AIS_CLIENT] Error parsing message:', error.message);
    }
  }

  /**
   * Handle WebSocket close event
   * @private
   */
  _onClose(code, reason) {
    this.logger.log(`🔌 [AIS_CLIENT] Connection closed: ${code} - ${reason}`);

    this.isConnected = false;
    this._clearTimers();

    // Clear WebSocket reference to allow reconnection
    this.ws = null;
    this.openedAt = null; // Reset connection time

    this.emit('disconnected', { code, reason });

    // Schedule reconnect if not intentional disconnect
    if (code !== 1000) {
      this._scheduleReconnect();
    }
  }

  /**
   * Handle WebSocket error event
   * @private
   */
  _onError(error) {
    this.logger.error('❌ [AIS_CLIENT] WebSocket error:', error.message);
    this.emit('error', error);
  }

  /**
   * Handle WebSocket ping event
   * @private
   */
  _onPing() {
    // Removed debug spam - ping/pong happens frequently
  }

  /**
   * Handle WebSocket pong event
   * @private
   */
  _onPong() {
    // Removed debug spam - ping/pong happens frequently
  }

  /**
   * Extract AIS data from stream message (based on old working version)
   * @private
   */
  _extractAISData(message) {
    // CRITICAL FIX: Use same data extraction as old working version
    const meta = message.Metadata || message.MetaData || {};
    const body = Object.values(message.Message || {})[0] || {};

    // Validate required fields (using old version field names)
    const mmsi = body.MMSI ?? meta.MMSI;
    const lat = meta.Latitude ?? body.Latitude;
    const lon = meta.Longitude ?? body.Longitude;

    if (!mmsi || !lat || !lon) {
      // Removed debug spam - missing fields are common in AIS stream
      return null;
    }

    return {
      mmsi: mmsi.toString(),
      msgType: message.MessageType,
      lat,
      lon,
      sog: meta.SOG ?? meta.Sog ?? body.SOG ?? body.Sog ?? 0,
      cog: meta.COG ?? meta.Cog ?? body.COG ?? body.Cog ?? 0,
      shipName: (body.Name ?? meta.ShipName ?? '').trim() || 'Unknown',
      timestamp: Date.now(),
    };
  }

  /**
   * Schedule reconnection attempt
   * @private
   */
  _scheduleReconnect() {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.logger.error('❌ [AIS_CLIENT] Max reconnection attempts reached');
      this.emit('max-reconnects-reached');
      return;
    }

    // Progressive delay with some randomization
    const delays = AIS_CONFIG.RECONNECT_DELAYS;
    const delayIndex = Math.min(this.reconnectAttempts, delays.length - 1);
    let delay = delays[delayIndex];

    // Add randomization to prevent thundering herd
    delay += Math.random() * 5000;
    delay = Math.min(delay, MAX_RECONNECT_DELAY);

    this.reconnectAttempts++;

    this.logger.log(
      `🔄 [AIS_CLIENT] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      // If we have an API key stored, try to reconnect directly
      if (this.apiKey && !this.isConnected && !this.ws) {
        this.connect(this.apiKey).catch((err) => {
          this.logger.error('❌ [AIS_CLIENT] Direct reconnection failed:', err);
          // Fallback to emitting event for app.js to handle
          this.emit('reconnect-needed');
        });
      } else {
        // Fallback to event-based reconnection
        this.emit('reconnect-needed');
      }
    }, delay);
  }

  /**
   * Start keep-alive (EXACTLY like old working version - simple re-subscription only)
   * @private
   */
  _startHeartbeat() {
    this._stopHeartbeat();

    // CRITICAL FIX: Use EXACT same logic as old working version
    // Only re-subscribe every 60 seconds, no ping/pong or stale checks
    this.heartbeatTimer = setInterval(() => {
      this._subscribe();
    }, 60000); // Re-subscribe every 60 seconds (exactly like old version)
  }

  /**
   * Stop keep-alive
   * @private
   */
  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Clear all timers
   * @private
   */
  _clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this._stopHeartbeat();
  }
}

module.exports = AISStreamClient;
