/* ====================================================================
   AIS Bridge – Homey-app som larmar när fartyg närmar sig broar
   ==================================================================== */
"use strict";

const Homey = require("homey");
const WS = require("ws");

/* ---------- DEBUG-FLAGGOR ---------- */
const DEBUG_MODE = false; // massor av rådata
const LIGHT_DEBUG_MODE = false; // bara “relevanta” loggar

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
const EXTRA_MARGIN = 2000; // m
const MIN_KTS = 0.2; // knop
const MAX_AGE_SEC = 3 * 60; // sek
const WS_URL = "wss://stream.aisstream.io/v0/stream";
const KEEPALIVE_MS = 60_000;
const RECONNECT_MS = 10_000;

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

const getDirection = (cog) =>
  Number(cog) > 90 && Number(cog) < 270 ? "Göteborg" : "Vänersborg";

/* ==================================================================== */
class AISBridgeApp extends Homey.App {
  dbg(...a) {
    if (DEBUG_MODE) this.log("[DEBUG]", ...a);
  }
  ldbg(...a) {
    if (DEBUG_MODE || LIGHT_DEBUG_MODE) this.log("[LIGHT]", ...a);
  }

  /* ---------------- Init --------------------- */
  async onInit() {
    this.log(
      "AIS Bridge startad 🚀  (DEBUG =",
      DEBUG_MODE,
      ", LIGHT =",
      LIGHT_DEBUG_MODE,
      ")"
    );

    this._lastSeen = {}; // { bridgeId: { mmsi: {...} } }
    this._devices = new Set(); // måste initieras först
    this._latestBridgeSentence = "Inga fartyg nära någon bro";

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
      this.ldbg("Running scheduled cleanup check");
      this._updateActiveBridgesTag();
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
  _startLiveFeed(retryCount = 0, initialDelay = RECONNECT_MS) {
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

    /* Bounding-box runt broarna + marginal */
    const lats = Object.values(BRIDGES).map((b) => b.lat);
    const lons = Object.values(BRIDGES).map((b) => b.lon);
    const maxLat = Math.max(...lats),
      minLat = Math.min(...lats);
    const maxLon = Math.max(...lons),
      minLon = Math.min(...lons);
    const marginLat = EXTRA_MARGIN / 111_000;
    const midLat = (maxLat + minLat) / 2;
    const marginLon =
      EXTRA_MARGIN / (111_000 * Math.cos((midLat * Math.PI) / 180));
    const BOX = [
      [maxLat + marginLat, minLon - marginLon],
      [minLat - marginLat, maxLon + marginLon],
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
        if (DEBUG_MODE) this.dbg("[RX]", buf.toString("utf8", 0, 120));

        // First message received = successful connection
        if (!this._isConnected) {
          this._connectionAttempts = 0; // Reset counter on successful data
          this._updateConnectionStatus(true);
          this.log("First message received - connection established");
          this._isConnected = true; // Set flag to prevent repeated logging
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

        /* Uppdatera minnet */
        for (const per of Object.values(this._lastSeen)) delete per[mmsi];
        (this._lastSeen[bid] ??= {})[mmsi] = {
          ts: now(),
          dist: d,
          dir,
          towards,
        };

        /* LIGHT-logg */
        const name =
          (body.Name ?? meta.ShipName ?? "").trim() || "(namn saknas)";
        this.ldbg(
          `BOAT ${name} (${mmsi}) ${Math.round(d)} m från ${B.name}, dir=${dir}`
        );

        /* Token */
        try {
          this.ldbg("Calling _updateActiveBridgesTag from WebSocket handler");
          this._updateActiveBridgesTag();
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

  /* -------- Uppdatera globalt token -------- */
  _updateActiveBridgesTag() {
    const cutoff = now() - MAX_AGE_SEC * 1000;
    const phrases = [];
    let dataRemoved = false;

    // Log the current state before cleanup
    if (LIGHT_DEBUG_MODE) {
      const vesselCount = Object.values(this._lastSeen).reduce(
        (sum, bridge) => sum + Object.keys(bridge).length,
        0
      );
      this.ldbg(`Before cleanup: ${vesselCount} active vessels near bridges`);
    }

    for (const [bid, perBridge] of Object.entries(this._lastSeen)) {
      let vesselRemoved = false;
      for (const [mmsi, v] of Object.entries(perBridge)) {
        if (v.ts < cutoff) {
          delete perBridge[mmsi];
          vesselRemoved = true;
          dataRemoved = true;
          if (LIGHT_DEBUG_MODE) {
            this.ldbg(
              `Removed expired vessel ${mmsi} near ${BRIDGES[bid].name}`
            );
          }
        }
      }

      const vessels = Object.values(perBridge);
      if (!vessels.length) {
        delete this._lastSeen[bid];
        if (LIGHT_DEBUG_MODE) {
          this.ldbg(`Removed bridge ${BRIDGES[bid].name} with no vessels`);
        }
        continue;
      }

      const groups = {};
      vessels.forEach((v) => {
        const k = `${v.dir}|${v.towards}`;
        (groups[k] ??= []).push(v);
      });

      for (const [k, list] of Object.entries(groups)) {
        const [dir, towardsStr] = k.split("|");
        const towards = towardsStr === "true";
        list.sort((a, b) => a.dist - b.dist);

        const bridgeName = BRIDGES[bid].name;
        const count = list.length;
        const distance = Math.round(list[0].dist);

        // Create a clear, concise message for this group
        let phrase;
        if (count === 1) {
          // Single boat
          const action = towards ? "har" : "är";
          const preposition = towards ? "kvar till" : "från";
          phrase = `En båt mot ${dir} ${action} ${distance} meter ${preposition} ${bridgeName}`;
        } else {
          // Multiple boats - use "respektive" for natural Swedish
          const action = towards ? "har" : "är";
          const preposition = towards ? "kvar till" : "från";
          const distances = list
            .map((v) => Math.round(v.dist))
            .join(" respektive ");
          phrase = `${count} båtar mot ${dir} ${action} ${distances} meter ${preposition} ${bridgeName}`;
        }

        phrases.push(phrase);
      }
    }

    let sentence = "Inga fartyg nära någon bro";
    if (phrases.length === 1) {
      sentence = phrases[0];
    } else if (phrases.length > 1) {
      // For multiple phrases, use semicolon for clarity
      sentence = phrases.join("; ");
    }

    // Reset alarm if all vessels have been removed
    if (dataRemoved && Object.keys(this._lastSeen).length === 0) {
      this.ldbg("All vessels expired, resetting to 'no boats' status");
      sentence = "Inga fartyg nära någon bro";
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

      // Update devices
      const hasBoats = sentence !== "Inga fartyg nära någon bro";
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
