"use strict";

const Homey = require("homey");
const WS = require("ws");

// --- Static config -------------------------------------------------------
const BRIDGES = {
  klaffbron: { name: "Klaffbron", lat: 58.283953, lon: 12.2847 },
  jarnvagsbron: { name: "Järnvägsbron", lat: 58.289306, lon: 12.292789 },
};
const MAX_DIST = 300; // metre radius that counts as "near"
const MIN_KTS = 1.0; // ignore stationary / moored traffic
const SCAN_MS = 8_000; // how long we listen before giving up
const BOX_PAD = 0.01; // ± degrees around each bridge for subscription

class AISBridgeApp extends Homey.App {
  async onInit() {
    this.log("AIS Bridge (on-demand) started");

    // Cache per bridge so we don't open several sockets for the same bridge at the same time
    this._ongoingScans = new Map();

    // Bind condition card
    const cond = this.homey.flow.getConditionCard("is_boat_near");
    cond.registerRunListener(this.onFlowConditionIsBoatNear.bind(this));
  }

  // ------------------- Flow condition ------------------------------------
  /**
   * Run-listener for the "A boat is near bridge" AND-card.
   * Opens a temporary WebSocket to AISstream per bridge, listens for up to SCAN_MS,
   * resolves true on first matching vessel otherwise false. 100% clean-up.
   * Multiple bridges can be scanned simultaneously.
   *
   * @param {{bridge:string}} args
   * @returns {Promise<boolean>}
   */
  async onFlowConditionIsBoatNear(args) {
    // Map autocomplete display back to our internal id
    const bridgeId = args.bridge;

    // Run only one scan per bridge at a time to avoid rate-limits
    if (this._ongoingScans.has(bridgeId)) {
      this.log(`Another scan in progress for ${bridgeId} – re-using promise`);
      return this._ongoingScans.get(bridgeId);
    }

    const scanPromise = this._scanOnce(bridgeId).finally(() => {
      this._ongoingScans.delete(bridgeId);
    });

    this._ongoingScans.set(bridgeId, scanPromise);
    return scanPromise;
  }

  // ------------------- One-shot scanner ----------------------------------
  /**
   * Performs one short websocket session and evaluates proximity.
   * @param {'klaffbron'|'jarnvagsbron'} bridgeId
   * @returns {Promise<boolean>}
   */
  async _scanOnce(bridgeId) {
    try {
      const key = this.homey.settings.get("ais_api_key");
      if (!key) {
        this.error("AIS API key not set - please configure in app settings");
        return false;
      }

      const b = BRIDGES[bridgeId];
      this.log(`Starting scan for ${b.name} (${bridgeId})`);

      const bbox = [
        [b.lat + BOX_PAD, b.lon - BOX_PAD],
        [b.lat - BOX_PAD, b.lon + BOX_PAD],
      ];

      return await new Promise((resolve) => {
        let resolved = false;
        let timer;

        // Connect
        const ws = new WS("wss://stream.aisstream.io/v0/stream");

        // Cleanup function
        const cleanup = () => {
          clearTimeout(timer);
          try {
            ws.close();
          } catch (_) {}
        };

        const finish = (result) => {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve(result);
        };

        // Timeout guard
        timer = setTimeout(() => {
          this.log(`Scan timeout for ${b.name} after ${SCAN_MS}ms`);
          finish(false);
        }, SCAN_MS);

        ws.on("open", () => {
          this.log(`WSS opened for ${b.name} - subscribing to area`);
          ws.send(
            JSON.stringify({
              Apikey: key,
              BoundingBoxes: [bbox],
              FilterMessageTypes: ["PositionReport"],
            })
          );
        });

        ws.on("message", (buf) => {
          try {
            const msg = JSON.parse(buf);
            if (msg.MessageType !== "PositionReport") return;

            const m = msg.MetaData || {};
            const lat = m.latitude ?? m.Latitude;
            const lon = m.longitude ?? m.Longitude;
            const sog = m.SOG ?? m.speedOverGround ?? 0;
            if (lat == null || lon == null || sog < MIN_KTS) return;

            // Haversine distance
            const d = this._haversine(lat, lon, b.lat, b.lon);
            if (d <= MAX_DIST) {
              this.log(
                `🚢 BOAT DETECTED near ${b.name}! ${
                  m.ShipName || m.MMSI
                } @ ${d.toFixed(0)} m, ${sog.toFixed(1)} kn`
              );
              finish(true);
            }
          } catch (e) {
            this.error(`Parse error for ${b.name}:`, e);
          }
        });

        ws.on("error", (err) => {
          this.error(`WSS error for ${b.name}:`, err.message);
          finish(false);
        });

        ws.on("close", () => {
          this.log(`WSS connection closed for ${b.name}`);
          if (!resolved) finish(false);
        });
      });
    } catch (err) {
      this.error(`Scan failed for ${bridgeId}:`, err.message || err);
      return false;
    }
  }

  // ------------------- Helpers -------------------------------------------
  _haversine(la1, lo1, la2, lo2) {
    const R = 6371000;
    const φ1 = (la1 * Math.PI) / 180;
    const φ2 = (la2 * Math.PI) / 180;
    const dφ = ((la2 - la1) * Math.PI) / 180;
    const dλ = ((lo2 - lo1) * Math.PI) / 180;
    const a =
      Math.sin(dφ / 2) ** 2 +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
}

module.exports = AISBridgeApp;
