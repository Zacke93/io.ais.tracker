/* ====================================================================
   AIS Bridge – Homey-app som larmar när fartyg närmar sig broar
   ==================================================================== */
"use strict";

const Homey = require("homey");
const WS = require("ws");

/* ---------- DEBUG-FLAGGOR ---------- */
// Debug-nivåer hanteras nu via Homey-inställningar:
// - "off": Ingen debug-loggning
// - "basic": Grundläggande information
// - "detailed": Smart logik och båtanalys
// - "full": All AIS-data och behandling

/* ---------- GLOBAL TOKEN ---------- */
const TOKEN_ID = "active_bridges";

/* ---------- Bro-koordinater ---------- */
const BRIDGES = {
  olidebron: {
    name: "Olidebron",
    lat: 58.272743083145855,
    lon: 12.275115821922993,
    radius: 300,
  },
  klaffbron: {
    name: "Klaffbron",
    lat: 58.28409551543077,
    lon: 12.283929525245636,
    radius: 300,
  },
  jarnvagsbron: {
    name: "Järnvägsbron",
    lat: 58.29164042152742,
    lon: 12.292025280073759,
    radius: 300,
  },
  stridsbergsbron: {
    name: "Stridsbergsbron",
    lat: 58.293524096154634,
    lon: 12.294566425158054,
    radius: 300,
  },
  stallbackabron: {
    name: "Stallbackabron",
    lat: 58.31142992293701,
    lon: 12.31456385688822,
    radius: 300,
  },
};

/* ---------- Konstanter ---------- */
const DEFAULT_RADIUS = 300; // m
const MIN_KTS = 0.2; // knop
const MAX_AGE_SEC = 3 * 60; // sek
const WS_URL = "wss://stream.aisstream.io/v0/stream";
const KEEPALIVE_MS = 60_000;
const RECONNECT_MS = 10_000;

/* ---------- Nya konstanter för förbättrad logik ---------- */
const SPEED_HISTORY_MINUTES = 10; // Hur länge vi kommer ihåg hög hastighet
const WAITING_SPEED_THRESHOLD = 0.5; // Under denna hastighet = "väntande"
const ACTIVE_SPEED_THRESHOLD = 2.0; // Över denna hastighet = "aktiv"
const MAX_SPEED_HISTORY = 10; // Max antal historiska datapunkter
const COLLECTION_ZONE = {
  south: { lat: 58.268138604819576, lon: 12.269025682200194 },
  north: { lat: 58.320786584215874, lon: 12.323830097692591 },
};

/* ---------- Smart approach konstanter ---------- */
const SLOWDOWN_FACTOR = 0.7; // Under 70% av max hastighet = "bromsar"
const MIN_NAVIGATION_SPEED = 0.3; // Minimum för aktiv navigering

/* ---------- Hjälpfunktioner ---------- */
const now = () => Date.now();

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  return (
    2 *
    R *
    Math.asin(
      Math.sqrt(
        Math.sin(Δφ / 2) ** 2 +
          Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
      )
    )
  );
}

/* ==================================================================== */
class AISBridgeApp extends Homey.App {
  // Hämta debug-nivå från inställningar
  getDebugLevel() {
    return this.homey.settings.get('debug_level') || 'basic';
  }

  // Olika debug-nivåer med emoji för enkel identifiering
  dbg(...a) {
    const level = this.getDebugLevel();
    if (level === 'full') this.log("🔍 [FULL]", ...a);
  }
  
  ldbg(...a) {
    const level = this.getDebugLevel();
    if (level === 'basic' || level === 'detailed' || level === 'full') this.log("ℹ️ [BASIC]", ...a);
  }
  
  ddebug(...a) {
    const level = this.getDebugLevel();
    if (level === 'detailed' || level === 'full') this.log("🔧 [DETAILED]", ...a);
  }

  /* ---------------- Init --------------------- */
  async onInit() {
    const debugLevel = this.getDebugLevel();
    this.log(
      "AIS Bridge startad 🚀  (DEBUG =",
      debugLevel,
      ")"
    );

    // Lyssna på inställningsändringar
    this.homey.settings.on('set', (key) => {
      if (key === 'debug_level') {
        const newLevel = this.getDebugLevel();
        this.log(`🎛️ Debug-nivå ändrad till: ${newLevel}`);
      }
    });

    this._lastSeen = {}; // { bridgeId: { mmsi: {...} } }
    this._devices = new Set(); // måste initieras först
    this._latestBridgeSentence =
      "Inga båtar är i närheten av Klaffbron eller Stridsbergsbron";

    // NEW: Restore saved devices from storage
    await this._restoreDevices();

    await this._initGlobalToken();

    // Log that app is ready for devices
    this.log("App initialized, ready to accept devices");

    /* Flow-kort -------------------------------------- */
    this._boatNearTrigger = this.homey.flow.getTriggerCard("boat_near");

    /* Listener: strikt jämförelse -------------------- */
    this._boatNearTrigger.registerRunListener(
      (args, state) => args.bridge === state.bridge
    );

    /* Condition-kort --------------------------------- */
    this._boatRecentCard = this.homey.flow.getConditionCard("boat_recent");
    this._boatRecentCard.registerRunListener(
      this._onFlowConditionBoatRecent.bind(this)
    );

    /* Starta AIS-ström ------------------------------- */
    this._startLiveFeed();

    // Set up periodic cleanup to ensure stale data gets removed
    this._cleanupInterval = this.homey.setInterval(() => {
      // Only log if there are actually vessels to check
      const vesselCount = Object.values(this._lastSeen).reduce(
        (sum, bridge) => sum + Object.keys(bridge).length,
        0
      );
      if (vesselCount > 0) {
        this.ldbg(`Running scheduled cleanup check (${vesselCount} vessels)`);
      }
      this._updateActiveBridgesTag("scheduled_cleanup");
    }, 60000); // Run every minute

    // Register for settings changes
    this.homey.settings.on("set", this._onSettingsChange.bind(this));
  }

  /* -------- Globalt token -------- */
  async _initGlobalToken() {
    try {
      this._activeBridgesTag = await this.homey.flow.createToken(TOKEN_ID, {
        type: "string",
        title: "Aktiva broar",
      });
    } catch (err) {
      if (String(err).includes("already"))
        this._activeBridgesTag = await this.homey.flow.getToken(TOKEN_ID);
      else throw err;
    }
    await this._activeBridgesTag.setValue(this._latestBridgeSentence); // << ändrat
  }

  /* ---- Flow-condition ‘boat_recent’ ---- */
  async _onFlowConditionBoatRecent({ bridge }) {
    const cutoff = now() - MAX_AGE_SEC * 1000;

    if (bridge === "any")
      return Object.values(this._lastSeen).some((per) =>
        Object.values(per).some((v) => v.ts > cutoff)
      );

    const per = this._lastSeen[bridge];
    const res = per && Object.values(per).some((v) => v.ts > cutoff);
    this.ldbg("boat_recent:", bridge, "→", res);
    return res;
  }

  /* -------- WebSocket-ström -------- */
  _startLiveFeed() {
    // Don't try to connect if we're in API key failure mode
    if (this._apiKeyFailureMode) {
      this.log("Skipping connection attempt - in API key failure mode");
      return;
    }

    const key = this.homey.settings.get("ais_api_key");
    if (!key) {
      this.error("AIS-API-nyckel saknas! Lägg in den under App-inställningar.");
      this._updateConnectionStatus(false, "API-nyckel saknas");
      return;
    }

    // Validate key format
    if (!this._validateApiKeyFormat(key)) {
      this.error(
        "Ogiltig API-nyckelformat. Kontrollera nyckeln i App-inställningar."
      );
      this._updateConnectionStatus(false, "Ogiltig API-nyckelformat");
      return;
    }

    // Close existing connection if any
    if (this._ws) {
      try {
        this._ws.close();
      } catch (err) {
        // Ignore close errors
      }
    }

    // Clear existing intervals
    if (this._keepAlive) {
      clearInterval(this._keepAlive);
      this._keepAlive = null;
    }

    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;
    }

    if (this._connectionStatusTimeout) {
      this.homey.clearTimeout(this._connectionStatusTimeout);
      this._connectionStatusTimeout = null;
    }

    /* Bounding-box för hela kanalområdet för datainsamling */
    const BOX = [
      [COLLECTION_ZONE.north.lat, COLLECTION_ZONE.south.lon],
      [COLLECTION_ZONE.south.lat, COLLECTION_ZONE.north.lon],
    ];

    try {
      // Create new WebSocket connection
      this._ws = new WS(WS_URL);

      const subscribe = () => {
        try {
          if (this._ws && this._ws.readyState === WS.OPEN) {
            this._ws.send(
              JSON.stringify({ Apikey: key, BoundingBoxes: [BOX] })
            );
          }
        } catch (err) {
          this.error("Failed to send subscription:", err);
        }
      };

      this._ws.on("open", () => {
        this.log("WSS ansluten ✅ – box:", BOX);

        // Setup keepalive
        subscribe();
        this._keepAlive = setInterval(subscribe, KEEPALIVE_MS);

        // Wait a bit before marking as connected and resetting counter
        this._connectionStatusTimeout = this.homey.setTimeout(() => {
          if (this._ws && this._ws.readyState === WS.OPEN) {
            // Only reset counter if connection has been stable for 5 seconds
            this._connectionAttempts = 0;
            this._updateConnectionStatus(true);
            this.log("Connection stable - resetting attempt counter");
          }
        }, 5000); // Wait 5 seconds before marking as connected
      });

      this._ws.on("message", (buf) => {
        this.dbg("[RX]", buf.toString("utf8", 0, 120));

        // First message received = successful connection
        if (!this._isConnected) {
          this._connectionAttempts = 0; // Reset counter on successful data
          this._updateConnectionStatus(true);
          this.log("First message received - connection established");
          this._isConnected = true;
        }

        let msg;
        try {
          msg = JSON.parse(buf.toString());
        } catch {
          return;
        }

        if (
          ![
            "PositionReport",
            "StandardClassBPositionReport",
            "ExtendedClassBPositionReport",
          ].includes(msg.MessageType)
        )
          return;

        const meta = msg.Metadata || msg.MetaData || {};
        const body = Object.values(msg.Message || {})[0] || {};

        const lat = meta.Latitude ?? body.Latitude;
        const lon = meta.Longitude ?? body.Longitude;
        const sog = meta.SOG ?? meta.Sog ?? body.SOG ?? body.Sog ?? 0;
        const cog = meta.COG ?? meta.Cog ?? body.COG ?? body.Cog;
        const mmsi = body.MMSI ?? meta.MMSI;
        if (!lat || !lon || !mmsi || sog < MIN_KTS) return;

        /* Inom radien för någon bro? */
        const hits = [];
        for (const [id, B] of Object.entries(BRIDGES)) {
          const d = haversine(lat, lon, B.lat, B.lon);
          if (d <= (B.radius ?? DEFAULT_RADIUS)) hits.push({ id, B, d });
        }
        if (!hits.length) return;

        /* Välj bro framför/närmast */
        hits.sort((a, b) => a.d - b.d);
        const ahead = hits.filter((h) =>
          cog > 90 && cog < 270 ? h.B.lat <= lat : h.B.lat >= lat
        );
        const { id: bid, B, d } = ahead[0] || hits[0];

        // IMPROVED DIRECTION CALCULATION
        // Calculate bearing between vessel and bridge
        const bearing = this._calculateBearing(lat, lon, B.lat, B.lon);

        // Determine if vessel is approaching the bridge
        const headingDiff = Math.abs(((cog - bearing + 180) % 360) - 180);
        const towards = headingDiff < 90; // Vessel heading within 90° of bearing = approaching

        // Get direction name
        const dir = cog > 90 && cog < 270 ? "Göteborg" : "Vänersborg";

        /* Uppdatera minnet med förbättrad datastruktur */
        for (const per of Object.values(this._lastSeen)) delete per[mmsi];
        const existingData = this._lastSeen[bid]?.[mmsi];
        (this._lastSeen[bid] ??= {})[mmsi] = {
          ts: now(),
          lat, // Lägg till lat/lon för smart approach
          lon,
          dist: d,
          dir,
          towards,
          sog,
          maxRecentSog: this._updateMaxRecentSog(existingData, sog),
          speedHistory: this._updateSpeedHistory(
            existingData?.speedHistory || [],
            sog
          ),
          lastActiveTime:
            sog > ACTIVE_SPEED_THRESHOLD ? now() : existingData?.lastActiveTime,
          mmsi,
        };

        /* LIGHT-logg */
        const name =
          (body.Name ?? meta.ShipName ?? "").trim() || "(namn saknas)";
        this.ldbg(
          `BOAT ${name} (${mmsi}) ${Math.round(d)} m från ${B.name}, dir=${dir}`
        );

        /* Token */
        try {
          this._updateActiveBridgesTag("vessel_update");
        } catch (err) {
          this.error("Error in _updateActiveBridgesTag from WebSocket:", err);
        }

        /* Trigger-kortet -------------------------------- */
        const tokens = {
          bridge_name: B.name,
          vessel_name: name,
          direction: dir,
        };

        /* 1) specifik bro */
        const state1 = { bridge: bid };
        const match1 = this._boatNearTrigger.trigger(tokens, state1);

        /* 2) wildcard ‘any’ */
        const state2 = { bridge: "any" };
        const match2 = this._boatNearTrigger.trigger(tokens, state2);

        Promise.all([match1, match2]).catch(this.error);
      });

      // Enhanced error handling with exponential backoff
      this._ws.on("error", (err) => this._handleConnectionFailure(err));
      this._ws.on("close", (code, reason) => {
        this.log(`WebSocket closed with code: ${code}, reason: ${reason}`);

        // Note: Code 1006 can indicate auth issues with AIS Stream
        // We'll handle this in _handleConnectionFailure

        this._handleConnectionFailure(`Connection closed (code: ${code})`);
      });
    } catch (err) {
      this._handleConnectionFailure(err);
    }
  }

  // New method for handling connection failures
  _handleConnectionFailure(err) {
    if (this._keepAlive) {
      clearInterval(this._keepAlive);
      this._keepAlive = null;
    }

    if (this._connectionStatusTimeout) {
      this.homey.clearTimeout(this._connectionStatusTimeout);
      this._connectionStatusTimeout = null;
    }

    if (err) {
      this.error("WSS-fel:", err.message || err);
    }

    // Check if this might be an API key issue
    const apiKey = this.homey.settings.get("ais_api_key");
    const isLikelyAuthError =
      !apiKey ||
      !this._validateApiKeyFormat(apiKey) ||
      (err &&
        (err.message?.includes("401") ||
          err.message?.includes("403") ||
          err.message?.includes("Unauthorized") ||
          err.message?.includes("1006"))) ||
      // If we keep getting 1006 errors quickly after connection, likely auth issue
      this._connectionAttempts >= 2;

    // Increment retry count
    this._connectionAttempts = (this._connectionAttempts || 0) + 1;

    this.log(
      `Connection attempt ${this._connectionAttempts}, isLikelyAuthError: ${isLikelyAuthError}`
    );

    // Stop retrying after 5 attempts if it's likely an auth error
    if (isLikelyAuthError && this._connectionAttempts >= 5) {
      this.error(
        "Slutar försöka ansluta efter 5 misslyckade försök. Kontrollera API-nyckeln."
      );
      this._updateConnectionStatus(
        false,
        "API-nyckel verkar felaktig - kontrollera inställningar"
      );
      this._apiKeyFailureMode = true; // Flag to indicate we stopped due to API key issues

      // Send notification before stopping
      if (!this._hasShownNotification) {
        this._hasShownNotification = true;
        const notificationMessage =
          "AIS Bridge: API-nyckel verkar felaktig. Kontrollera inställningar.";

        this.log("Sending notification:", notificationMessage);
        this.homey.notifications
          .createNotification({
            excerpt: notificationMessage,
          })
          .then(() => this.log("Notification sent successfully"))
          .catch((err) => this.error("Failed to create notification:", err));
      }

      return;
    }

    // Calculate backoff time with exponential increase and max limit
    const maxDelay = 5 * 60 * 1000; // 5 minutes max
    const delay = Math.min(
      RECONNECT_MS * Math.pow(1.5, this._connectionAttempts - 1),
      maxDelay
    );

    this.log(
      `Återansluter om ${Math.round(delay / 1000)} sekunder (försök ${
        this._connectionAttempts
      })...`
    );

    // Update device status to indicate connection is down
    this._updateConnectionStatus(false, err?.message || "Anslutningsfel");

    // Schedule reconnection
    this._reconnectTimeout = this.homey.setTimeout(() => {
      this._startLiveFeed(this._connectionAttempts);
    }, delay);
  }

  // New method to update devices about connection status
  _updateConnectionStatus(isConnected, errorMessage = null) {
    if (!this._devices || this._devices.size === 0) return;

    // Store connection state internally
    this._isConnected = isConnected;
    this._lastErrorMessage = errorMessage;

    for (const device of this._devices) {
      if (device) {
        try {
          // Update store value first (this doesn't require the capability to exist)
          if (device.setStoreValue) {
            device
              .setStoreValue("connection_active", isConnected)
              .catch((err) =>
                this.error("Failed to update connection store:", err)
              );

            if (errorMessage) {
              device
                .setStoreValue("connection_error", errorMessage)
                .catch((err) =>
                  this.error("Failed to store error message:", err)
                );
            }
          }

          // Only try to update the capability if it exists
          if (
            device.hasCapability &&
            device.hasCapability("connection_status")
          ) {
            const statusValue = isConnected ? "connected" : "disconnected";
            device
              .setCapabilityValue("connection_status", statusValue)
              .catch((err) => {
                if (err.statusCode !== 404) {
                  // Don't log 404 errors
                  this.error(
                    "Failed to update connection status capability:",
                    err
                  );
                }
              });
          }
        } catch (err) {
          this.error("Error in _updateConnectionStatus:", err);
        }
      }
    }
  }

  /* -------- Defended Timeout-based Cleanup System -------- */
  _scheduleVesselCleanup(mmsi, bridgeId) {
    const timeoutKey = `${bridgeId}_${mmsi}`;
    
    // Clear existing timeout
    if (this._vesselTimeouts?.[timeoutKey]) {
      this.homey.clearTimeout(this._vesselTimeouts[timeoutKey]);
    }

    // Initialize with safety checks
    if (!this._vesselTimeouts) {
      this._vesselTimeouts = {};
    }

    // SAFETY: Prevent timeout accumulation
    if (Object.keys(this._vesselTimeouts).length > 200) {
      this.error("🚨 Too many timeouts! Triggering emergency cleanup");
      this._emergencyCleanup();
      return;
    }

    const cleanupDelay = (MAX_AGE_SEC + 10) * 1000;
    this._vesselTimeouts[timeoutKey] = this.homey.setTimeout(() => {
      this._performVesselCleanup(mmsi, bridgeId, timeoutKey);
    }, cleanupDelay);

    this.ddebug(`⏲️ Scheduled cleanup for vessel ${mmsi} in ${cleanupDelay/1000}s`);
  }

  _performVesselCleanup(mmsi, bridgeId, timeoutKey) {
    try {
      this.ddebug(`⏰ Timeout-triggered cleanup for vessel ${mmsi} at ${BRIDGES[bridgeId]?.name}`);
      
      // Double-check vessel still exists and is actually expired
      if (this._lastSeen[bridgeId]?.[mmsi]) {
        const vessel = this._lastSeen[bridgeId][mmsi];
        const cutoff = now() - MAX_AGE_SEC * 1000;
        
        if (vessel.ts < cutoff) {
          delete this._lastSeen[bridgeId][mmsi];
          this.ldbg(`🧹 Timeout cleanup: removed expired vessel ${mmsi} from ${BRIDGES[bridgeId]?.name}`);
          
          // Remove bridge if no vessels left
          if (Object.keys(this._lastSeen[bridgeId]).length === 0) {
            delete this._lastSeen[bridgeId];
            this.ldbg(`🧹 Removed empty bridge ${BRIDGES[bridgeId]?.name}`);
          }
          
          // Trigger update after cleanup
          this._updateActiveBridgesTag("timeout_cleanup");
          this._lastCleanupTime = now();
        } else {
          this.ddebug(`⏰ Vessel ${mmsi} not expired yet, keeping`);
        }
      } else {
        this.ddebug(`⏰ Vessel ${mmsi} already removed`);
      }
    } catch (error) {
      this.error(`🚨 Cleanup error for vessel ${mmsi}:`, error);
    } finally {
      // ALWAYS clean up timeout reference
      delete this._vesselTimeouts?.[timeoutKey];
    }
  }

  _emergencyCleanup() {
    this.error("🚨 Emergency cleanup triggered");
    
    // Clear all timeouts
    if (this._vesselTimeouts) {
      Object.values(this._vesselTimeouts).forEach(timeout => {
        this.homey.clearTimeout(timeout);
      });
      this._vesselTimeouts = {};
    }
    
    // Manual cleanup of truly expired vessels
    const cutoff = now() - MAX_AGE_SEC * 1000;
    let cleaned = 0;
    
    for (const [bid, vessels] of Object.entries(this._lastSeen)) {
      for (const [mmsi, vessel] of Object.entries(vessels)) {
        if (vessel.ts < cutoff) {
          delete this._lastSeen[bid][mmsi];
          cleaned++;
        } else {
          // Re-schedule timeout for valid vessels
          this._scheduleVesselCleanup(mmsi, bid);
        }
      }
      
      // Clean up empty bridges
      if (Object.keys(this._lastSeen[bid]).length === 0) {
        delete this._lastSeen[bid];
      }
    }
    
    this.error(`🧹 Emergency cleanup completed: removed ${cleaned} expired vessels`);
    this._updateActiveBridgesTag("emergency_cleanup");
    this._lastCleanupTime = now();
  }

  _recoverTimeouts() {
    this.error("🔄 Recovering missing timeouts");
    let recovered = 0;
    
    for (const [bid, vessels] of Object.entries(this._lastSeen)) {
      for (const mmsi of Object.keys(vessels)) {
        const timeoutKey = `${bid}_${mmsi}`;
        if (!this._vesselTimeouts[timeoutKey]) {
          this._scheduleVesselCleanup(mmsi, bid);
          recovered++;
        }
      }
    }
    
    this.ldbg(`🔄 Recovered ${recovered} missing timeouts`);
  }

  _setupSafetyValidator() {
    // Lightweight validator - checks consistency without doing cleanup
    this._safetyInterval = this.homey.setInterval(() => {
      const vesselCount = Object.values(this._lastSeen).reduce(
        (sum, bridge) => sum + Object.keys(bridge).length, 0
      );
      const timeoutCount = Object.keys(this._vesselTimeouts || {}).length;
      
      // Detect anomalies without fixing them immediately
      if (timeoutCount > vesselCount * 2) {
        this.error(`🚨 Timeout leak detected: ${timeoutCount} timeouts for ${vesselCount} vessels`);
        this._emergencyCleanup();
      }
      
      if (vesselCount > 0 && timeoutCount === 0) {
        this.error(`🚨 Missing timeouts: ${vesselCount} vessels but no timeouts scheduled`);
        this._recoverTimeouts();
      }
      
      // Log health status at detailed level
      this.ddebug(`🏥 Health check: ${vesselCount} vessels, ${timeoutCount} timeouts, ratio: ${vesselCount > 0 ? (timeoutCount / vesselCount).toFixed(2) : 'N/A'}`);
      
      // Warn if ratio is concerning but not critical
      if (vesselCount > 0 && timeoutCount > vesselCount * 1.5) {
        this.ddebug(`⚠️ High timeout ratio detected: ${timeoutCount}/${vesselCount} = ${(timeoutCount / vesselCount).toFixed(2)}`);
      }
      
    }, 2 * 60 * 1000); // Check every 2 minutes
  }

  getSystemHealth() {
    const vesselCount = Object.values(this._lastSeen).reduce(
      (sum, bridge) => sum + Object.keys(bridge).length, 0
    );
    const timeoutCount = Object.keys(this._vesselTimeouts || {}).length;
    
    return {
      vessels: vesselCount,
      timeouts: timeoutCount,
      ratio: vesselCount > 0 ? timeoutCount / vesselCount : 0,
      healthy: timeoutCount <= vesselCount * 1.2, // Allow 20% overhead
      lastCleanup: this._lastCleanupTime || 0,
      timeSinceLastCleanup: this._lastCleanupTime ? now() - this._lastCleanupTime : null,
      bridges: Object.keys(this._lastSeen).length,
      isConnected: this._isConnected || false
    };
  }

  /* -------- Uppdatera globalt token -------- */
  _updateActiveBridgesTag(triggerReason = "unknown") {
    const cutoff = now() - MAX_AGE_SEC * 1000;
    let dataRemoved = false;

    // Get current vessel count
    const vesselCount = Object.values(this._lastSeen).reduce(
      (sum, bridge) => sum + Object.keys(bridge).length,
      0
    );

    // Only log detailed info when there are vessels or for non-scheduled reasons
    const shouldLogDetail = vesselCount > 0 || triggerReason !== "scheduled_cleanup";
    
    if (shouldLogDetail) {
      this.ddebug(`=== _updateActiveBridgesTag called (${triggerReason}) ===`);
      this.ddebug(`Before cleanup: ${vesselCount} active vessels near bridges`);
      if (vesselCount > 0) {
        this.ddebug(`_lastSeen bridges: ${Object.keys(this._lastSeen).join(", ")}`);
      }
    }

    // Skip cleanup if no vessels present
    if (vesselCount === 0) {
      // Only log for non-scheduled cleanup calls
      if (triggerReason !== "scheduled_cleanup") {
        this.ddebug("No vessels present, skipping cleanup");
      }
      return;
    }

    // Clean up expired vessels with improved memory management
    for (const [bid, perBridge] of Object.entries(this._lastSeen)) {
      for (const [mmsi, v] of Object.entries(perBridge)) {
        if (v.ts < cutoff) {
          delete perBridge[mmsi];
          dataRemoved = true;
          this.ldbg(
              `🗑️ Removed expired vessel ${mmsi} near ${BRIDGES[bid]?.name || bid} (age: ${Math.round((now() - v.ts) / 1000)}s)`
            );
        } else {
          // Cleanup old speed history even for active vessels
          if (v.speedHistory && v.speedHistory.length > 0) {
            const maxAgeMs = SPEED_HISTORY_MINUTES * 60 * 1000;
            const oldHistoryLength = v.speedHistory.length;
            v.speedHistory = v.speedHistory
              .filter((entry) => now() - entry.ts < maxAgeMs)
              .slice(-MAX_SPEED_HISTORY);

            if (v.speedHistory.length !== oldHistoryLength) {
              this.ddebug(
                  `Cleaned speed history for vessel ${mmsi}: ${oldHistoryLength} -> ${v.speedHistory.length} entries`
                );
            }
          }

          // Reset maxRecentSog if too old
          if (
            v.lastActiveTime &&
            now() - v.lastActiveTime > SPEED_HISTORY_MINUTES * 60 * 1000
          ) {
            v.maxRecentSog = v.sog;
            this.ddebug(
                `Reset maxRecentSog for vessel ${mmsi} to current SOG: ${v.sog}`
              );
          }
        }
      }

      if (Object.keys(perBridge).length === 0) {
        delete this._lastSeen[bid];
        this.ldbg(`🌉 Removed bridge ${BRIDGES[bid]?.name || bid} with no vessels`);
      }
    }

    // Generate intelligent bridge text and get relevant boats
    const relevantBoats = this._findRelevantBoats();
    const hasBoats = relevantBoats.length > 0;

    // Only log when boats are found or debug level is detailed+
    if (hasBoats) {
      this.ldbg(`🚢 Found ${relevantBoats.length} relevant boats approaching bridges`);
    } else {
      this.ddebug(`No relevant boats found (${Object.keys(this._lastSeen).length} vessels tracked)`);
    }

    let sentence;
    if (relevantBoats.length === 0) {
      sentence = "Inga båtar är i närheten av Klaffbron eller Stridsbergsbron";
    } else {
      sentence = this._generateBridgeTextFromBoats(relevantBoats);
    }

    // Only log sentence changes, not repetitive same sentences
    if (hasBoats || this._latestBridgeSentence !== sentence) {
      this.ldbg(`📝 Generated: "${sentence}"`);
    }

    // Check if the sentence has actually changed
    const hasChanged = this._latestBridgeSentence !== sentence;

    // Store in app property
    this._latestBridgeSentence = sentence;

    // Only update if something changed or data was removed
    if (hasChanged || dataRemoved) {
      // Log the sentence for debugging
      this.ldbg("Updating token and devices with:", sentence);

      // Update token
      if (this._activeBridgesTag) {
        this._activeBridgesTag
          .setValue(sentence)
          .catch((err) => this.error("Failed to update token:", err));
      }

      this.ldbg(
        `Updating devices (count: ${
          this._devices ? this._devices.size : "unknown"
        }), hasBoats:`,
        hasBoats
      );

      // ALWAYS show a debug message about which path we're taking
      if (!this._devices) {
        this.ldbg("_devices collection is not initialized");
      } else if (this._devices.size === 0) {
        this.ldbg("_devices collection is empty");
      } else {
        this.ldbg(`Found ${this._devices.size} device(s) to update`);
        this.ldbg(
          `Devices in collection: ${Array.from(this._devices)
            .map((d) => (d.getName ? d.getName() : "unnamed"))
            .join(", ")}`
        );

        try {
          for (const device of this._devices) {
            try {
              if (!device) {
                this.ldbg("Skipping undefined device in _devices collection");
                continue;
              }

              this.ldbg(
                `Updating device: ${
                  device.getName ? device.getName() : "unknown"
                }`
              );

              // Update alarm capability
              device
                .setCapabilityValue("alarm_generic", hasBoats)
                .then(() =>
                  this.ldbg(
                    `Device ${
                      device.getName ? device.getName() : "unknown"
                    } - alarm_generic set to ${hasBoats}`
                  )
                )
                .catch((err) =>
                  this.error(
                    `Failed to update device capability for ${
                      device.getName ? device.getName() : "unknown"
                    }:`,
                    err
                  )
                );

              // Update text capability with the current sentence
              device
                .setCapabilityValue("bridge_text", sentence)
                .then(() =>
                  this.ldbg(
                    `Device ${
                      device.getName ? device.getName() : "unknown"
                    } - bridge_text updated to "${sentence}"`
                  )
                )
                .catch((err) =>
                  this.error(
                    `Failed to update bridge_text capability for ${
                      device.getName ? device.getName() : "unknown"
                    }:`,
                    err
                  )
                );
            } catch (err) {
              this.error("Error processing device in update loop:", err);
            }
          }
        } catch (err) {
          this.error("Error in device update loop:", err);
        }
      }
    } else {
      this.ldbg("No changes detected, skipping device update");
    }
  }

  /* -------- Generate bridge text from boats -------- */
  _generateBridgeTextFromBoats(relevantBoats) {
    // Group boats by target bridge
    const bridgeGroups = {};
    relevantBoats.forEach((boat) => {
      const targetBridge = boat.targetBridge;
      if (!bridgeGroups[targetBridge]) {
        bridgeGroups[targetBridge] = [];
      }
      bridgeGroups[targetBridge].push(boat);
    });

    const phrases = [];

    for (const [bridgeName, boats] of Object.entries(bridgeGroups)) {
      // Validate boats array
      if (!boats || boats.length === 0) continue;

      // FIXA: Säker hantering av boats array
      if (!boats || boats.length === 0) continue;

      // Find the boat with shortest ETA
      const closestBoat = boats.reduce((min, boat) => {
        if (!min) return boat;
        if (!boat || typeof boat.etaMinutes !== "number") return min;
        if (!isFinite(boat.etaMinutes)) return min;
        if (!isFinite(min.etaMinutes)) return boat;
        return boat.etaMinutes < min.etaMinutes ? boat : min;
      }, null);

      // Validate closest boat
      if (
        !closestBoat ||
        typeof closestBoat.etaMinutes !== "number" ||
        !isFinite(closestBoat.etaMinutes)
      ) {
        this.ldbg(`Skipping bridge ${bridgeName} - no valid closest boat`);
        continue;
      }

      const count = boats.length;
      const etaMinutes = Math.max(0, Math.round(closestBoat.etaMinutes));

      // FIXA: Säker analys av smart approach för bättre meddelanden
      const highConfidenceBoats = boats.filter(
        (boat) =>
          boat && boat.smartAnalysis && boat.smartAnalysis.confidence === "high"
      );
      const preparingBoats = boats.filter(
        (boat) =>
          boat && boat.smartAnalysis && boat.smartAnalysis.action === "prepare"
      );
      const waitingBoats = boats.filter((boat) => boat && boat.isWaiting);

      let phrase;
      if (count === 1) {
        const boat = closestBoat;
        const isHighConfidence =
          boat.smartAnalysis && boat.smartAnalysis.confidence === "high";
        const isPreparing =
          boat.smartAnalysis && boat.smartAnalysis.action === "prepare";

        if (boat.isAtBridge) {
          if (boat.isWaiting || isPreparing) {
            phrase = `En båt väntar vid ${bridgeName}, beräknad broöppning ${
              etaMinutes < 1 ? "nu" : `om ${etaMinutes} minuter`
            }`;
          } else if (isHighConfidence) {
            phrase = `En båt närmar sig ${bridgeName}, beräknad broöppning ${
              etaMinutes < 1 ? "nu" : `om ${etaMinutes} minuter`
            }`;
          } else {
            phrase = `En båt nära ${bridgeName}, beräknad broöppning ${
              etaMinutes < 1 ? "nu" : `om ${etaMinutes} minuter`
            }`;
          }
        } else {
          if (boat.isWaiting || isPreparing) {
            phrase = `En båt väntar vid ${
              boat.currentBridge
            }, beräknad broöppning av ${bridgeName} ${
              etaMinutes < 1 ? "nu" : `om ${etaMinutes} minuter`
            }`;
          } else if (isHighConfidence) {
            phrase = `En båt på väg från ${
              boat.currentBridge
            } mot ${bridgeName}, beräknad broöppning ${
              etaMinutes < 1 ? "nu" : `om ${etaMinutes} minuter`
            }`;
          } else {
            phrase = `En båt vid ${
              boat.currentBridge
            }, beräknad broöppning av ${bridgeName} ${
              etaMinutes < 1 ? "nu" : `om ${etaMinutes} minuter`
            }`;
          }
        }
      } else {
        // För flera båtar, använd redan filtrerade waitingBoats

        if (preparingBoats.length > 0) {
          if (closestBoat.isAtBridge) {
            phrase = `${
              preparingBoats.length > 1 ? "Flera" : "En"
            } båt förbereder sig vid ${bridgeName}, beräknad broöppning ${
              etaMinutes < 1 ? "nu" : `om ${etaMinutes} minuter`
            }`;
          } else {
            phrase = `Flera båtar mot ${bridgeName} (några förbereder sig), beräknad broöppning ${
              etaMinutes < 1 ? "nu" : `om ${etaMinutes} minuter`
            }`;
          }
        } else if (waitingBoats.length > 0) {
          if (closestBoat.isAtBridge) {
            phrase = `Flera båtar väntar vid ${bridgeName}, beräknad broöppning ${
              etaMinutes < 1 ? "nu" : `om ${etaMinutes} minuter`
            }`;
          } else {
            phrase = `Flera båtar mot ${bridgeName} (några väntar), beräknad broöppning ${
              etaMinutes < 1 ? "nu" : `om ${etaMinutes} minuter`
            }`;
          }
        } else if (highConfidenceBoats.length > 0) {
          phrase = `Flera båtar närmar sig ${bridgeName}, beräknad broöppning ${
            etaMinutes < 1 ? "nu" : `om ${etaMinutes} minuter`
          }`;
        } else {
          if (closestBoat.isAtBridge) {
            phrase = `Flera båtar nära ${bridgeName}, beräknad broöppning ${
              etaMinutes < 1 ? "nu" : `om ${etaMinutes} minuter`
            }`;
          } else {
            phrase = `Flera båtar mot ${bridgeName}, beräknad broöppning ${
              etaMinutes < 1 ? "nu" : `om ${etaMinutes} minuter`
            }`;
          }
        }
      }

      phrases.push(phrase);
    }

    // If we have relevant boats but no valid phrases, return fallback
    if (phrases.length === 0) {
      return "Båtar upptäckta men tid kan ej beräknas";
    }

    return phrases.join("; ");
  }

  /* -------- Find boats relevant for bridge opening predictions -------- */
  _findRelevantBoats() {
    const relevantBoats = [];

    // Bridge order from south to north (lat ascending)
    const bridgeOrder = [
      "olidebron",
      "klaffbron",
      "jarnvagsbron",
      "stridsbergsbron",
      "stallbackabron",
    ];
    const userBridges = ["klaffbron", "stridsbergsbron"];

    this.ldbg(
      `=== _findRelevantBoats: Processing ${
        Object.keys(this._lastSeen).length
      } bridge(s) with smart approach analysis ===`
    );

    for (const [bid, vessels] of Object.entries(this._lastSeen)) {
      this.ldbg(
        `Processing bridge: ${bid} with ${
          Object.keys(vessels).length
        } vessel(s)`
      );

      for (const vessel of Object.values(vessels)) {
        // Validate vessel data first
        if (!vessel || typeof vessel !== "object") {
          this.ldbg(`  SKIP: Invalid vessel object`);
          continue;
        }
        if (typeof vessel.towards !== "boolean") {
          this.ldbg(`  SKIP: Invalid towards value: ${vessel.towards}`);
          continue;
        }
        if (typeof vessel.sog !== "number" || isNaN(vessel.sog)) {
          this.ldbg(`  SKIP: Invalid SOG: ${vessel.sog}`);
          continue;
        }
        if (typeof vessel.dist !== "number" || isNaN(vessel.dist)) {
          this.ldbg(`  SKIP: Invalid distance: ${vessel.dist}`);
          continue;
        }
        if (typeof vessel.dir !== "string") {
          this.ldbg(`  SKIP: Invalid direction: ${vessel.dir}`);
          continue;
        }
        if (!vessel.mmsi || (typeof vessel.mmsi !== "string" && typeof vessel.mmsi !== "number")) {
          this.ldbg(`  SKIP: Invalid MMSI: ${vessel.mmsi}`);
          continue;
        }

        // Apply smart approach analysis once for all filtering decisions
        const smartAnalysis = this._smartApproachDetection(vessel, bid);
        this.ldbg(
          `Checking vessel at ${bid}: sog=${vessel.sog}, dir=${vessel.dir}, towards=${vessel.towards}, dist=${vessel.dist}, smart: ${smartAnalysis.confidence}/${smartAnalysis.action}`
        );

        // Only consider boats that are approaching bridges OR have high confidence smart analysis
        if (!vessel.towards && smartAnalysis.confidence !== "high") {
          this.ldbg(
            `  SKIP: Boat moving away from bridge and low smart confidence`
          );
          continue;
        }

        // Skip boats with very low speed UNLESS they are waiting or have smart approach indication
        if (
          vessel.sog < MIN_KTS &&
          !this._isWaiting(vessel, bid) &&
          smartAnalysis.action !== "prepare"
        ) {
          this.ldbg(
            `  SKIP: SOG too low, not waiting, and no smart prepare indication: ${vessel.sog} < ${MIN_KTS}`
          );
          continue;
        }

        const currentBridgeIndex = bridgeOrder.indexOf(bid);
        if (currentBridgeIndex === -1) {
          this.ldbg(`  SKIP: Unknown bridge ID: ${bid}`);
          continue;
        }

        if (!BRIDGES[bid] || !BRIDGES[bid].name) {
          this.ldbg(`  SKIP: Missing bridge data for: ${bid}`);
          continue;
        }
        const currentBridgeName = BRIDGES[bid].name;
        const isGoingToVanersborg = vessel.dir === "Vänersborg";

        this.ldbg(
          `  Processing: ${currentBridgeName} (index ${currentBridgeIndex}), direction: ${vessel.dir}`
        );

        let targetBridge = null;
        let distanceToTarget = vessel.dist;
        let isAtTargetBridge = false;

        // Determine target bridge based on direction and current position
        if (userBridges.includes(bid)) {
          // Already at a user bridge
          targetBridge = currentBridgeName;
          isAtTargetBridge = true;
          this.ldbg(`  Already at user bridge: ${targetBridge}`);
        } else if (isGoingToVanersborg) {
          // Going north - find next user bridge
          this.ldbg(
            `  Going north (Vänersborg), looking for next user bridge from index ${
              currentBridgeIndex + 1
            }`
          );
          for (let i = currentBridgeIndex + 1; i < bridgeOrder.length; i++) {
            this.ldbg(
              `    Checking bridge at index ${i}: ${
                bridgeOrder[i]
              }, isUserBridge: ${userBridges.includes(bridgeOrder[i])}`
            );
            if (userBridges.includes(bridgeOrder[i])) {
              const targetBridgeId = bridgeOrder[i];
              if (!BRIDGES[targetBridgeId] || !BRIDGES[targetBridgeId].name)
                continue;
              targetBridge = BRIDGES[targetBridgeId].name;
              const extraDistance = this._calculateDistanceBetweenBridges(
                bid,
                targetBridgeId
              );
              this.ldbg(
                `    Found target: ${targetBridge}, extra distance: ${extraDistance}m`
              );
              // Guard against invalid distance calculation
              if (extraDistance > 0) {
                distanceToTarget = vessel.dist + extraDistance;
              } else {
                distanceToTarget = vessel.dist;
              }
              break;
            }
          }
        } else {
          // Going south - find previous user bridge
          this.ldbg(
            `  Going south (Göteborg), looking for previous user bridge from index ${
              currentBridgeIndex - 1
            }`
          );
          for (let i = currentBridgeIndex - 1; i >= 0; i--) {
            this.ldbg(
              `    Checking bridge at index ${i}: ${
                bridgeOrder[i]
              }, isUserBridge: ${userBridges.includes(bridgeOrder[i])}`
            );
            if (userBridges.includes(bridgeOrder[i])) {
              const targetBridgeId = bridgeOrder[i];
              if (!BRIDGES[targetBridgeId] || !BRIDGES[targetBridgeId].name)
                continue;
              targetBridge = BRIDGES[targetBridgeId].name;
              const extraDistance = this._calculateDistanceBetweenBridges(
                bid,
                targetBridgeId
              );
              this.ldbg(
                `    Found target: ${targetBridge}, extra distance: ${extraDistance}m`
              );
              // Guard against invalid distance calculation
              if (extraDistance > 0) {
                distanceToTarget = vessel.dist + extraDistance;
              } else {
                distanceToTarget = vessel.dist;
              }
              break;
            }
          }
        }

        // Skip if no relevant target bridge found
        if (!targetBridge) {
          this.ldbg(
            `  SKIP: No target bridge found for ${currentBridgeName} going ${vessel.dir}`
          );
          continue;
        }

        // Calculate ETA using improved method
        const etaMinutes = this._calculateETA(vessel, distanceToTarget, bid);
        const isWaiting = this._isWaiting(vessel, bid);

        this.ldbg(
          `  Target: ${targetBridge}, distance: ${distanceToTarget}m, speed: ${vessel.sog} knots, maxRecentSog: ${vessel.maxRecentSog}, isWaiting: ${isWaiting}`
        );
        this.ldbg(`  ETA calculation: ${etaMinutes.toFixed(1)} minutes`);

        // Guard against invalid calculations
        if (!isFinite(etaMinutes) || etaMinutes < 0) {
          this.ldbg(`  SKIP: Invalid ETA: ${etaMinutes}`);
          continue;
        }

        // Reuse smart analysis from earlier (no need to recalculate)
        // Include boats that will reach bridge within 30 minutes OR are waiting OR have high confidence smart analysis
        const shouldInclude =
          etaMinutes <= 30 ||
          isWaiting ||
          (smartAnalysis.confidence === "high" &&
            smartAnalysis.action === "prepare");

        if (shouldInclude) {
          this.ldbg(
            `  ✓ ADDED to relevantBoats: ${
              vessel.mmsi
            } -> ${targetBridge} in ${etaMinutes.toFixed(
              1
            )} min (waiting: ${isWaiting}, smart: ${smartAnalysis.confidence}/${
              smartAnalysis.action
            })`
          );
          relevantBoats.push({
            mmsi: vessel.mmsi,
            currentBridge: currentBridgeName,
            targetBridge: targetBridge,
            etaMinutes: etaMinutes,
            isAtBridge: isAtTargetBridge,
            isWaiting: isWaiting,
            sog: vessel.sog,
            maxRecentSog: vessel.maxRecentSog,
            distance: distanceToTarget,
            smartAnalysis: smartAnalysis,
          });
        } else {
          this.ldbg(
            `  SKIP: ETA too long: ${etaMinutes.toFixed(
              1
            )} minutes > 30, not waiting, and smart analysis: ${
              smartAnalysis.confidence
            }/${smartAnalysis.action}`
          );
        }
      }
    }

    const smartBoats = relevantBoats.filter(
      (boat) => boat.smartAnalysis && boat.smartAnalysis.confidence === "high"
    ).length;
    this.ldbg(
      `=== _findRelevantBoats: Returning ${relevantBoats.length} relevant boat(s) (${smartBoats} high-confidence) ===`
    );
    return relevantBoats;
  }

  /* -------- Calculate approximate distance between bridges -------- */
  _calculateDistanceBetweenBridges(bridgeId1, bridgeId2) {
    const bridge1 = BRIDGES[bridgeId1];
    const bridge2 = BRIDGES[bridgeId2];

    if (!bridge1 || !bridge2) return 0;

    return haversine(bridge1.lat, bridge1.lon, bridge2.lat, bridge2.lon);
  }

  /* -------- Helper function to calculate bearing between two coordinates -------- */
  _calculateBearing(lat1, lon1, lat2, lon2) {
    // Convert to radians
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    // Calculate bearing
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x =
      Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);

    // Convert to degrees and normalize
    return ((θ * 180) / Math.PI + 360) % 360;
  }

  /* -------- Nya hjälpfunktioner för förbättrad hastighetshantering -------- */
  _updateMaxRecentSog(existingData, currentSog) {
    if (!existingData) return currentSog;

    const timeSinceLastUpdate = now() - existingData.ts;
    const maxAgeMs = SPEED_HISTORY_MINUTES * 60 * 1000;

    // Om det gått för lång tid, använd bara nuvarande hastighet
    if (timeSinceLastUpdate > maxAgeMs) {
      return currentSog;
    }

    return Math.max(existingData.maxRecentSog || currentSog, currentSog);
  }

  _updateSpeedHistory(existingHistory, currentSog) {
    const newEntry = { sog: currentSog, ts: now() };
    const updatedHistory = [...existingHistory, newEntry];

    // Rensa gamla poster (äldre än SPEED_HISTORY_MINUTES)
    const maxAgeMs = SPEED_HISTORY_MINUTES * 60 * 1000;
    const filteredHistory = updatedHistory.filter(
      (entry) => now() - entry.ts < maxAgeMs
    );

    // Begränsa antal poster
    return filteredHistory.slice(-MAX_SPEED_HISTORY);
  }

  _isWaiting(vessel, bid) {
    const USER_BRIDGES = ["klaffbron", "stridsbergsbron"];
    const timeSinceActive = now() - (vessel.lastActiveTime || 0);
    const maxAgeMs = SPEED_HISTORY_MINUTES * 60 * 1000;

    // FIXA: Ta bort cirkulär referens - använd bara grundläggande kriterier
    const basicWaitingCriteria =
      vessel.dist < DEFAULT_RADIUS &&
      vessel.sog < WAITING_SPEED_THRESHOLD &&
      vessel.maxRecentSog > ACTIVE_SPEED_THRESHOLD &&
      timeSinceActive < maxAgeMs;

    const isRelevantForUser =
      USER_BRIDGES.includes(bid) || this._isHeadingToUserBridge(vessel, bid);

    return basicWaitingCriteria && isRelevantForUser;
  }

  _isHeadingToUserBridge(vessel, currentBridgeId) {
    const bridgeOrder = [
      "olidebron",
      "klaffbron",
      "jarnvagsbron",
      "stridsbergsbron",
      "stallbackabron",
    ];
    const userBridges = ["klaffbron", "stridsbergsbron"];
    const currentIndex = bridgeOrder.indexOf(currentBridgeId);

    if (currentIndex === -1) return false;

    const isGoingNorth = vessel.dir === "Vänersborg";

    if (isGoingNorth) {
      // Kolla om det finns en användarbro norr om nuvarande position
      for (let i = currentIndex + 1; i < bridgeOrder.length; i++) {
        if (userBridges.includes(bridgeOrder[i])) return true;
      }
    } else {
      // Kolla om det finns en användarbro söder om nuvarande position
      for (let i = currentIndex - 1; i >= 0; i--) {
        if (userBridges.includes(bridgeOrder[i])) return true;
      }
    }

    return false;
  }

  _calculateETA(vessel, distanceToTarget, bid) {
    // FIXA: Säker hantering av input
    if (
      !vessel ||
      typeof distanceToTarget !== "number" ||
      distanceToTarget < 0
    ) {
      return Infinity; // Säker fallback
    }

    // Om båten väntar, antag att den kommer att accelerera snart
    if (this._isWaiting(vessel, bid)) {
      const effectiveSpeed = Math.max(
        vessel.maxRecentSog || 0,
        ACTIVE_SPEED_THRESHOLD
      );
      const speedMs = effectiveSpeed * 0.514444;
      if (speedMs <= 0.01) return Infinity; // Undvik division med noll
      return Math.max(0, distanceToTarget / speedMs / 60);
    }

    // Annars använd nuvarande hastighet men med minimum
    const effectiveSpeed = Math.max(vessel.sog || 0, 0.5);
    const speedMs = effectiveSpeed * 0.514444;
    if (speedMs <= 0.01) return Infinity; // Undvik division med noll
    return distanceToTarget / speedMs / 60;
  }

  /* -------- Smart Approach Detection Funktioner -------- */
  _smartApproachDetection(vessel, bridgeId) {
    // FIXA: Säker hantering av input
    const bridge = BRIDGES[bridgeId];
    if (!bridge || !vessel || typeof vessel !== "object") {
      return {
        confidence: "low",
        action: "monitor",
        likelyIntention: "monitoring",
        factors: {},
      };
    }

    // Säker hantering av numeriska värden
    const vesselSog = typeof vessel.sog === "number" ? vessel.sog : 0;
    const vesselMaxSog =
      typeof vessel.maxRecentSog === "number" ? vessel.maxRecentSog : vesselSog;
    const vesselDist = typeof vessel.dist === "number" ? vessel.dist : Infinity;

    // 1. Är båten på rätt sida av bron för sin riktning?
    const isCorrectSide = this._isOnCorrectSide(vessel, bridge, vessel.dir);

    // 2. Har båten saktat ner nära bron? (planerar stopp)
    const hasSlowedNearBridge =
      vesselMaxSog > 0 && vesselSog < vesselMaxSog * SLOWDOWN_FACTOR;

    // 3. Är hastigheten konsekvent med navigering? (inte bara drifting)
    const isActivelyNavigating =
      vesselSog > MIN_NAVIGATION_SPEED || vesselMaxSog > 1.0;

    // 4. Är båten nära nog för att vara relevant?
    const isRelevantDistance = vesselDist < DEFAULT_RADIUS;

    return {
      confidence: isCorrectSide && isActivelyNavigating ? "high" : "medium",
      action: hasSlowedNearBridge && isRelevantDistance ? "prepare" : "monitor",
      likelyIntention:
        isCorrectSide && hasSlowedNearBridge ? "bridge_request" : "monitoring",
      factors: {
        correctSide: isCorrectSide,
        slowed: hasSlowedNearBridge,
        navigating: isActivelyNavigating,
        closeEnough: isRelevantDistance,
      },
    };
  }

  _isOnCorrectSide(vessel, bridge, direction) {
    // FIXA: Säker hantering av lat/lon
    if (!vessel.lat || !bridge || !bridge.lat || !direction) {
      return false; // Säker fallback
    }

    const vesselLat = vessel.lat;

    if (direction === "Vänersborg") {
      // Åker norrut - ska vara söder om bron för att vara relevant
      return vesselLat <= bridge.lat;
    } else {
      // Åker söderut - ska vara norr om bron för att vara relevant
      return vesselLat >= bridge.lat;
    }
  }

  _isLikelyAnchored(vessel) {
    // FIXA: Säker hantering av input
    if (!vessel || typeof vessel !== "object") return true;

    const vesselSog = typeof vessel.sog === "number" ? vessel.sog : 0;
    const vesselMaxSog =
      typeof vessel.maxRecentSog === "number" ? vessel.maxRecentSog : 0;
    const lastActive =
      typeof vessel.lastActiveTime === "number" ? vessel.lastActiveTime : now();

    // Detektera om en båt troligen är ankrad/förtöjd
    const hasBeenStationary =
      vesselSog < MIN_NAVIGATION_SPEED && vesselMaxSog < 1.0;
    const lowSpeedForLongTime = now() - lastActive > 5 * 60 * 1000; // 5 min

    return hasBeenStationary || lowSpeedForLongTime;
  }

  _shouldIgnoreVessel(vessel, bridgeId) {
    // FIXA: Säker hantering
    if (!vessel || typeof vessel !== "object") return true;

    // Filtrera bort båtar som uppenbart inte behöver broöppning
    const analysis = this._smartApproachDetection(vessel, bridgeId);

    // Ignorera om:
    // 1. Troligen ankrad
    // 2. På fel sida och inte närmar sig
    // 3. Låg konfidens och ingen tecken på brobehov
    return (
      this._isLikelyAnchored(vessel) ||
      (!analysis.factors?.correctSide && !analysis.factors?.slowed) ||
      (analysis.confidence === "low" && analysis.action === "monitor")
    );
  }

  /* ---------------- Uninit --------------------- */
  onUninit() {
    // Clear interval when app is unloaded
    if (this._cleanupInterval) {
      this.homey.clearInterval(this._cleanupInterval);
    }

    // Clean up websocket connection if active
    if (this._ws) {
      this._ws.close();
    }

    this.log("AIS Bridge stopped");
  }

  /* NEW METHOD: Restore saved devices from storage */
  async _restoreDevices() {
    try {
      // Get saved device IDs from storage
      const savedDeviceIds = this.homey.settings.get("saved_device_ids") || [];
      this.log(`Restoring ${savedDeviceIds.length} saved devices from storage`);

      // For each device ID, find the actual device and add it to our collection
      for (const deviceId of savedDeviceIds) {
        try {
          // Get the device by ID
          const device = await this.homey.drivers
            .getDriver("bridge_status")
            .getDevice({ id: deviceId });

          if (device) {
            this._devices.add(device);
            this.log(
              `Restored device ${device.getName() || deviceId} from storage`
            );
          }
        } catch (err) {
          this.log(`Device ${deviceId} could not be restored: ${err.message}`);
        }
      }

      this.log(`Device collection restored with ${this._devices.size} devices`);
    } catch (err) {
      this.error("Failed to restore devices from storage:", err);
    }
  }

  /* NEW METHOD: Save devices to storage */
  async _saveDevices() {
    try {
      // Extract device IDs from the device collection
      const deviceIds = Array.from(this._devices)
        .filter((device) => device && device.getData)
        .map((device) => device.getData().id);

      // Save to persistent storage
      await this.homey.settings.set("saved_device_ids", deviceIds);
      this.log(`Saved ${deviceIds.length} device IDs to persistent storage`);
    } catch (err) {
      this.error("Failed to save devices to storage:", err);
    }
  }

  /* NEW METHOD: Handle settings changes */
  async _onSettingsChange(key) {
    // Only care about API key changes
    if (key === "ais_api_key") {
      const apiKey = this.homey.settings.get("ais_api_key");
      this.log("API key changed, validating and restarting connection...");

      // Reset failure mode and notification flags
      this._apiKeyFailureMode = false;
      this._hasShownNotification = false;

      // Validate the API key format
      if (this._validateApiKeyFormat(apiKey)) {
        // Stop and restart the WebSocket connection
        this.log("API key format is valid, restarting WebSocket connection");

        // Clear any reconnect timers
        if (this._reconnectTimeout) {
          this.homey.clearTimeout(this._reconnectTimeout);
          this._reconnectTimeout = null;
        }

        // Restart connection with new key (reset retry count)
        this._connectionAttempts = 0;
        this._updateConnectionStatus(
          false,
          "Försöker ansluta med ny API-nyckel..."
        );
        this._startLiveFeed(0);
      } else {
        this.error("Invalid API key format");
        // Notify user through the connection status
        this._updateConnectionStatus(false, "Ogiltig API-nyckelformat");
      }
    }
  }

  /* NEW METHOD: Validate API key format */
  _validateApiKeyFormat(apiKey) {
    if (!apiKey) return false;

    // Log the key format (safely) for debugging
    this.log(
      `Validating API key: ${apiKey.substring(0, 4)}...${apiKey.substring(
        apiKey.length - 4
      )}`
    );

    // More flexible validation - just check if it looks like a reasonable API key
    // Accept any alphanumeric key with dashes that's around 32-40 chars
    if (apiKey.length >= 20 && /^[a-zA-Z0-9\-]+$/.test(apiKey)) {
      return true;
    }

    // For strict UUID v4 validation (comment out if causing problems)
    // const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    // return uuidV4Regex.test(apiKey);

    this.log(
      `API key validation failed: length=${
        apiKey.length
      }, format=${typeof apiKey}`
    );
    return false;
  }

  api = {
    // Connection status API endpoint
    async getConnectionStatus() {
      const key = this.homey.settings.get("ais_api_key");
      let connected = this._isConnected || false;
      let error = this._lastErrorMessage || null;

      // If no API key is set, definitely not connected
      if (!key) {
        connected = false;
        error = "API-nyckel saknas";
      } else if (!this._validateApiKeyFormat(key)) {
        connected = false;
        error = "Ogiltig API-nyckelformat";
      } else if (this._apiKeyFailureMode) {
        // If we're in API key failure mode, show specific error
        connected = false;
        error = "API-nyckel verkar felaktig - kontrollera inställningar";
      } else if (this._connectionAttempts && this._connectionAttempts >= 3) {
        // If we've had several failed attempts, indicate connection issues
        connected = false;
        error = error || "Anslutningsproblem - kontrollerar API-nyckel";
      }

      return {
        connected: connected,
        error: error,
        timestamp: new Date().toISOString(),
        attempts: this._connectionAttempts || 0,
        failureMode: this._apiKeyFailureMode || false,
      };
    },
  };
}

/* ==================================================================== */
module.exports = AISBridgeApp;
