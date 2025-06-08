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
    this.log("AIS Bridge (on‑demand) started");

    // Cache □ so we don't open several sockets at the same time by mistake
    this._ongoingScan = null;

    // Bind condition card
    const cond = this.homey.flow.getConditionCard("is_boat_near");
    cond.registerRunListener(this.onFlowConditionIsBoatNear.bind(this));
  }

  // ------------------- Flow condition ------------------------------------
  /**
   * Run‑listener for the “A boat is near bridge” AND‑card.
   * Opens a temporary WebSocket to AISstream, listens for up to SCAN_MS,
   * resolves true on first matching vessel otherwise false. 100 % clean‑up.
   *
   * @param {{bridge:string}} args
   * @returns {Promise<boolean>}
   */
  async onFlowConditionIsBoatNear(args) {
    // Map autocomplete display back to our internal id
    const bridgeId = args.bridge;

    // Run only one scan at a time to avoid rate‑limits
    if (this._ongoingScan) {
      this.log("Another scan in progress – re‑using promise");
      return this._ongoingScan;
    }

    this._ongoingScan = this._scanOnce(bridgeId).finally(() => {
      this._ongoingScan = null;
    });
    return this._ongoingScan;
  }

  // ------------------- One‑shot scanner ----------------------------------
  /**
   * Performs one short websocket session and evaluates proximity.
   * @param {'klaffbron'|'jarnvagsbron'} bridgeId
   * @returns {Promise<boolean>}
   */
  async _scanOnce(bridgeId) {
    try {
      const key = await this.homey.settings.get("ais_api_key");
      if (!key) {
        this.error("AIS API key not set");
        return false;
      }

      const b = BRIDGES[bridgeId];
      const bbox = [
        [b.lat + BOX_PAD, b.lon - BOX_PAD],
        [b.lat - BOX_PAD, b.lon + BOX_PAD],
      ];

      return await new Promise((resolve) => {
        let resolved = false;
        const finish = (result) => {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve(result);
        };

        // Timeout guard
        const timer = setTimeout(() => finish(false), SCAN_MS);

        // Connect
        const ws = new WS("wss://stream.aisstream.io/v0/stream");
        const cleanup = () => {
          clearTimeout(timer);
          try {
            ws.close();
          } catch (_) {}
        };

      ws.on("open", () => {
        this.log(`WSS opened (bridge=${b.name})`);
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
              `Match! ${m.ShipName || m.MMSI} @ ${d.toFixed(
                0
              )} m, ${sog.toFixed(1)} kn`
            );
            finish(true);
          }
        } catch (e) {
          this.error("Parse err", e);
        }
      });

      ws.on("error", (err) => {
        this.error("WSS error", err.message);
        finish(false);
      });

      ws.on("close", () => {
        if (!resolved) finish(false);
      });
    });
    } catch (err) {
      this.error("Scan failed", err.message || err);
      return false;
    }
  }

  // ------------------- Helpers -------------------------------------------
  _haversine(la1, lo1, la2, lo2) {
    const R = 6371000;
    const φ1 = (la1 * Math.PI) / 180,
      φ2 = (la2 * Math.PI) / 180;
    const dφ = ((la2 - la1) * Math.PI) / 180;
    const dλ = ((lo2 - lo1) * Math.PI) / 180;
    const a =
      Math.sin(dφ / 2) ** 2 +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
}

module.exports = AISBridgeApp;
