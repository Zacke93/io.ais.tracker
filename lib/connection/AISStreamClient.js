'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');
const { AIS_CONFIG, MAX_RECONNECT_ATTEMPTS, MAX_RECONNECT_DELAY } = require('../constants');

/**
 * AISStreamClient - Handles WebSocket connection to AISstream.io
 * Manages connection lifecycle, reconnection, and message filtering
 */
class AISStreamClient extends EventEmitter {
  /** Connection must survive this long before reconnect counter resets */
  static STABLE_CONNECTION_MS = 30_000;

  constructor(logger) {
    super();
    this.logger = logger;
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastMessageTime = null;
    this.apiKey = null; // Store API key for subscription
    this.openedAt = null; // Track connection open time for uptime
    this._intentionalClose = false; // F3: true while a deliberate disconnect is in flight
    this._awaitingPong = false; // F1: true after a ping until its pong arrives
    // Observabilitet (2026-06-11, SABETH-utredningen): avvisade meddelanden
    // var tidigare osynliga på info-nivå → omöjligt att i efterhand skilja
    // "transpondern tyst" från "meddelanden kom men avvisades". Rate-limited
    // info-logg (1/fartyg/5 min) gör frågan avgörbar i prodloggar.
    this._rejectLogTimes = new Map(); // mmsi → senaste logg-ts
  }

  /**
   * Rate-limited info-logg för avvisade meddelanden (1 per fartyg per 5 min).
   * @private
   */
  _logRejectedMessage(mmsi, reason) {
    const key = String(mmsi || 'unknown');
    const now = Date.now();
    const last = this._rejectLogTimes.get(key) || 0;
    if (now - last < 5 * 60 * 1000) return;
    this._rejectLogTimes.set(key, now);
    if (this._rejectLogTimes.size > 200) {
      for (const [k, ts] of this._rejectLogTimes) {
        if (now - ts > 30 * 60 * 1000) this._rejectLogTimes.delete(k);
      }
    }
    this.logger.log(`🚮 [AIS_REJECT] ${key}: message dropped (${reason})`);
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

    // CRITICAL FIX: Clear any pending reconnect timer to prevent race condition
    // If we're connecting now, any scheduled reconnect is redundant
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.logger.debug('🔧 [AIS_CLIENT] Cleared pending reconnect timer');
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

    // F3: mark this as intentional so _onClose does NOT schedule a reconnect.
    // ws.close() yields close code 1005/1006 (never 1000), so the old
    // `code !== 1000` check would otherwise schedule a zombie reconnect that
    // reopens the socket after onUninit/shutdown.
    this._intentionalClose = true;
    this.isConnected = false;
    // F3: clear ALL timers (reconnect/stable/ping), not just ping — onUninit()
    // calls disconnect(), and a surviving reconnectTimer would fire post-shutdown.
    this._clearTimers();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // FIX: Don't emit 'disconnected' here - let the 'close' event handler do it
    // This prevents double emission when ws.close() triggers the close event
  }

  /**
   * Reconnect with a (possibly new) API key. Safe across any current state
   * (connected / connecting / backing off): clears pending timers and detaches
   * the previous socket's listeners BEFORE opening a new one, so a delayed
   * 'close' from the old socket can't null out or desubscribe the new socket
   * (which would otherwise open but never subscribe → silent dead feed).
   * @param {string} apiKey - New API key for AISstream.io
   * @returns {Promise<void>}
   */
  reconnectWithKey(apiKey) {
    this.logger.log('🔑 [AIS_CLIENT] Reconnecting with updated API key');

    // Cancel any pending reconnect/stable/ping timers from the previous attempt.
    this._clearTimers();

    // Detach and close the previous socket. removeAllListeners() is critical:
    // without it the old socket's async 'close' event would fire _onClose AFTER
    // connect() installs the new socket, nulling this.ws and scheduling a
    // zombie reconnect with the OLD key.
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
      } catch (err) {
        this.logger.debug(`🔧 [AIS_CLIENT] removeAllListeners failed: ${err.message}`);
      }
      try {
        this.ws.close();
      } catch (err) {
        this.logger.debug(`🔧 [AIS_CLIENT] close failed: ${err.message}`);
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.openedAt = null;
    this.reconnectAttempts = 0; // fresh intent → allow fast retries

    return this.connect(apiKey);
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
      this.logger.log('📡 [AIS_CLIENT] Subscription message sent');
    } catch (error) {
      this.logger.error('❌ [AIS_CLIENT] Failed to send subscription:', error);
      // B1-fix (2026-06-09): utan subscription är anslutningen "uppkopplad men
      // döv" — servern skickar aldrig data och inget i flödet märker det.
      // terminate() tvingar fram 'close' → ordinarie reconnect-väg kör om
      // hela connect+subscribe-sekvensen.
      try {
        this.ws.terminate();
      } catch (terminateError) {
        this.logger.debug(`🔧 [AIS_CLIENT] terminate after failed subscribe failed: ${terminateError.message}`);
      }
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
    this.openedAt = Date.now(); // Track when connection opened
    this._intentionalClose = false; // fresh connection — clear any stale intent
    this._awaitingPong = false; // reset liveness watchdog state

    // Don't reset reconnectAttempts immediately — wait until the connection
    // has been stable for STABLE_CONNECTION_MS. This prevents infinite rapid
    // reconnect loops when the server accepts then drops connections quickly.
    if (this._stableTimer) clearTimeout(this._stableTimer);
    this._stableTimer = setTimeout(() => {
      this._stableTimer = null;
      if (this.isConnected) {
        this.reconnectAttempts = 0;
        this.logger.debug('🔧 [AIS_CLIENT] Connection stable — reset reconnect counter');
      }
    }, AISStreamClient.STABLE_CONNECTION_MS);

    // CRITICAL FIX: Clear any pending reconnect timer on successful connection
    // This prevents race condition where delayed reconnect callback fires after connection succeeds
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.logger.debug('🔧 [AIS_CLIENT] Cleared pending reconnect timer on successful connection');
    }

    // Send subscription message with API key and bounding box
    this._subscribe();

    // Start WebSocket ping to keep connection alive
    this._startPing();

    this.emit('connected');
  }

  /**
   * Handle WebSocket message event
   * @private
   */
  _onMessage(data) {
    try {
      const message = JSON.parse(data);

      // F55: surface server-side errors (e.g. invalid API key). AISstream.io
      // returns an error payload instead of a position report; previously the
      // message-type filter dropped it silently, so a bad key looked exactly
      // like "no traffic" and the user got no signal at all.
      if (message && (message.MessageType === 'Error' || message.error || message.Error)) {
        const detail = message.error || message.Error || 'unknown error';
        this.logger.error(
          `❌ [AIS_CLIENT] Server error message: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
        );
        this.emit('auth-error', detail);
        return;
      }

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

    // F3: don't reconnect after an intentional disconnect (uninit / key change).
    // Gate on the explicit intent flag — code is unreliable (close() ⇒ 1005/1006).
    const wasIntentional = this._intentionalClose;
    this._intentionalClose = false;
    if (!wasIntentional && code !== 1000) {
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
    // F1: pong arrived → connection is alive; clear the watchdog flag.
    this._awaitingPong = false;
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

    // Check for missing MMSI
    if (!mmsi) {
      this._logRejectedMessage(null, 'missing MMSI');
      return null;
    }

    // Check for missing coordinates (use explicit undefined/null checks to allow 0 values)
    if (lat === undefined || lat === null || lon === undefined || lon === null) {
      this._logRejectedMessage(mmsi, 'missing coordinates (GPS fix lost?)');
      return null;
    }

    // CRITICAL FIX: Reject lat=0, lon=0 coordinates (Gulf of Guinea intersection)
    // This is ~6000km from Trollhättan and indicates invalid/missing GPS data
    if (lat === 0 && lon === 0) {
      this._logRejectedMessage(mmsi, '0,0 coordinates (missing GPS fix)');
      return null;
    }

    // Förtöjningsdetektering lager 3 (2026-06-10): Class A-fartyg deklarerar
    // navigationsstatus (1=at anchor, 5=moored) i PositionReport — semantiskt
    // exakt signal som tidigare slängdes bort. Class B saknar fältet → null.
    const rawNavStatus = body.NavigationalStatus ?? meta.NavigationalStatus;
    const navStatus = Number.isInteger(rawNavStatus) && rawNavStatus >= 0 && rawNavStatus <= 15
      ? rawNavStatus
      : null;

    return {
      mmsi: mmsi.toString(),
      msgType: message.MessageType,
      lat,
      lon,
      sog: meta.SOG ?? meta.Sog ?? body.SOG ?? body.Sog ?? null,
      cog: meta.COG ?? meta.Cog ?? body.COG ?? body.Cog ?? null,
      navStatus,
      shipName: (body.Name ?? meta.ShipName ?? '').trim() || 'Unknown',
      timestamp: Date.now(),
    };
  }

  /**
   * Schedule reconnection attempt
   * @private
   */
  _scheduleReconnect() {
    let delay;

    const MEDIUM_RECONNECT_INTERVAL = 5 * 60 * 1000; // 5 minutes
    const MEDIUM_RECONNECT_MAX = 22; // attempts 11-22 = 12 x 5min = ~1 hour
    const SLOW_RECONNECT_INTERVAL = 60 * 60 * 1000; // 60 minutes

    if (this.reconnectAttempts >= MEDIUM_RECONNECT_MAX) {
      // Slow phase — try once per hour indefinitely
      delay = SLOW_RECONNECT_INTERVAL;
      this.reconnectAttempts++;
      this.logger.log(
        `🔄 [AIS_CLIENT] Still unreachable — switching to hourly reconnect (attempt ${this.reconnectAttempts})`,
      );
      this.emit('max-reconnects-reached');
    } else if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      // Medium phase — try every 5 minutes (after fast retries exhausted)
      delay = MEDIUM_RECONNECT_INTERVAL;
      this.reconnectAttempts++;
      this.logger.log(
        `🔄 [AIS_CLIENT] Server unreachable after ${MAX_RECONNECT_ATTEMPTS} fast attempts — retrying every 5 min (attempt ${this.reconnectAttempts})`,
      );
    } else {
      // Fast reconnect phase — progressive delay with randomization
      const delays = AIS_CONFIG.RECONNECT_DELAYS;
      const delayIndex = Math.min(this.reconnectAttempts, delays.length - 1);
      delay = delays[delayIndex];

      // Add randomization to prevent thundering herd
      delay += Math.random() * 5000;
      delay = Math.min(delay, MAX_RECONNECT_DELAY);

      this.reconnectAttempts++;
      this.logger.log(
        `🔄 [AIS_CLIENT] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
      );
    }

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
   * Start WebSocket ping to keep connection alive
   * @private
   */
  _startPing() {
    this._stopPing();
    this._awaitingPong = false;

    // F1: ping every 30s AND detect half-open connections. If the previous
    // ping got no pong by the next tick, the TCP socket is half-open (server
    // stopped sending, no 'close' event fires) — terminate() forces a 'close'
    // so the normal reconnect path runs. Without this, isConnected stays true
    // forever and the feed dies silently (no bridge_text, no notifications)
    // until the app is restarted.
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (this._awaitingPong) {
        this.logger.log('⚠️ [AIS_CLIENT] No pong since last ping — connection half-open, terminating');
        this._awaitingPong = false;
        try {
          this.ws.terminate();
        } catch (err) {
          this.logger.debug(`🔧 [AIS_CLIENT] terminate failed: ${err.message}`);
        }
        return;
      }
      this._awaitingPong = true;
      try {
        this.ws.ping();
      } catch (err) {
        this.logger.debug(`🔧 [AIS_CLIENT] ping failed: ${err.message}`);
      }
    }, 30000); // 30 seconds
  }

  /**
   * Stop WebSocket ping
   * @private
   */
  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this._awaitingPong = false;
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
    if (this._stableTimer) {
      clearTimeout(this._stableTimer);
      this._stableTimer = null;
    }

    this._stopPing();
  }
}

module.exports = AISStreamClient;
