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

      // Construct WebSocket URL with bounding box
      const wsUrl = this._constructWebSocketUrl(apiKey);

      this.ws = new WebSocket(wsUrl);
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
    this._clearTimers();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.emit('disconnected');
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
      uptime: this.lastMessageTime ? Date.now() - this.lastMessageTime : 0,
    };
  }

  /**
   * Construct WebSocket URL with bounding box
   * @private
   */
  _constructWebSocketUrl(apiKey) {
    const { BOUNDING_BOX } = AIS_CONFIG;

    // AISstream.io WebSocket URL format
    const baseUrl = 'wss://stream.aisstream.io/v0/stream';
    const bbox = `${BOUNDING_BOX.WEST},${BOUNDING_BOX.SOUTH},${BOUNDING_BOX.EAST},${BOUNDING_BOX.NORTH}`;

    return `${baseUrl}?api_key=${apiKey}&bbox=${bbox}`;
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
    this.lastMessageTime = Date.now();

    this._startHeartbeat();
    this.emit('connected');
  }

  /**
   * Handle WebSocket message event
   * @private
   */
  _onMessage(data) {
    try {
      this.lastMessageTime = Date.now();

      const message = JSON.parse(data);

      // Filter message types
      if (!AIS_CONFIG.MESSAGE_TYPES.includes(message.MessageType)) {
        return;
      }

      // Extract AIS data
      const aisData = this._extractAISData(message);
      if (aisData) {
        this.emit('ais-message', aisData);
        this.logger.debug(`📡 [AIS_CLIENT] Processed AIS message for vessel ${aisData.mmsi}`);
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
    this.logger.debug('🏓 [AIS_CLIENT] Received ping');
  }

  /**
   * Handle WebSocket pong event
   * @private
   */
  _onPong() {
    this.logger.debug('🏓 [AIS_CLIENT] Received pong');
  }

  /**
   * Extract AIS data from stream message
   * @private
   */
  _extractAISData(message) {
    if (!message.Message || !message.Message.PositionReport) {
      return null;
    }

    const report = message.Message.PositionReport;
    const metaData = message.MetaData;

    // Validate required fields
    if (!report.UserID || !report.Latitude || !report.Longitude) {
      return null;
    }

    return {
      mmsi: report.UserID.toString(),
      msgType: message.MessageType,
      lat: report.Latitude,
      lon: report.Longitude,
      sog: report.SpeedOverGround || 0,
      cog: report.CourseOverGround || 0,
      shipName: metaData?.ShipName || 'Unknown',
      timestamp: new Date(metaData?.time_utc).getTime() || Date.now(),
      callSign: metaData?.CallSign,
      destination: metaData?.Destination,
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
      // Need to get API key from somewhere - this is a limitation of current design
      // In real implementation, API key should be stored or passed differently
      this.emit('reconnect-needed');
    }, delay);
  }

  /**
   * Start heartbeat monitoring
   * @private
   */
  _startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected) {
        return;
      }

      const timeSinceLastMessage = Date.now() - this.lastMessageTime;

      // If no message for 60 seconds, consider connection stale
      if (timeSinceLastMessage > 60000) {
        this.logger.log('💔 [AIS_CLIENT] No messages received for 60s - connection may be stale');

        // Try to ping the server
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }

      // If no message for 5 minutes, force reconnect
      if (timeSinceLastMessage > 300000) {
        this.logger.error('💔 [AIS_CLIENT] No messages for 5 minutes - forcing reconnect');
        this.ws.close();
      }

    }, 30000); // Check every 30 seconds
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

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

module.exports = AISStreamClient;
