"use strict";

const Homey = require("homey");
const WS = require("ws");

// ── Statisk konfiguration ────────────────────────────────────────────────
const BRIDGES = {
  klaffbron: { name: "Klaffbron", lat: 58.283953, lon: 12.2847 },
  jarnvagsbron: { name: "Järnvägsbron", lat: 58.2917, lon: 12.2911 },
  stridsbergsbron: { name: "Stridsbergsbron", lat: 58.2935, lon: 12.294167 },
};

const MAX_DIST = 300; // meter räckvidd
const MIN_KTS = 1.0; // ignorera båtar som (nästan) står still
const SCAN_MS = 8_000; // lyssna max så här länge
const BOX_PAD = 0.01; // ±grader runt bron
const WS_URL = "wss://stream.aisstream.io/v0/stream";

class AISBridgeApp extends Homey.App {
  async onInit() {
    this.log("AIS Bridge (on-demand) started");
    this._ongoingScans = new Map();

    this.homey.flow
      .getConditionCard("is_boat_near")
      .registerRunListener(this.onFlowConditionIsBoatNear.bind(this));
  }

  /* ---------- Flow-villkor ---------- */
  async onFlowConditionIsBoatNear({ bridge: bridgeId }) {
    if (this._ongoingScans.has(bridgeId)) {
      this.log(`Scan pågår redan för ${bridgeId} – återanvänder löftet`);
      return this._ongoingScans.get(bridgeId);
    }

    const p = this._scanOnce(bridgeId).finally(() =>
      this._ongoingScans.delete(bridgeId)
    );
    this._ongoingScans.set(bridgeId, p);
    return p;
  }

  /* ---------- Engångsskanner ---------- */
  async _scanOnce(bridgeId) {
    try {
      const key = this.homey.settings.get("ais_api_key");
      if (!key) {
        this.error(
          "AIS API-nyckel saknas – ställ in den i app-inställningarna"
        );
        return false;
      }

      const b = BRIDGES[bridgeId];
      const bbox = [
        [b.lat + BOX_PAD, b.lon - BOX_PAD],
        [b.lat - BOX_PAD, b.lon + BOX_PAD],
      ];

      this.log(`Startar skanning för ${b.name}`);

      return await new Promise((resolve) => {
        let done = false;
        const ws = new WS(WS_URL);
        const kill = () => {
          if (!done) {
            done = true;
            ws.close();
          }
        };

        const timer = setTimeout(() => {
          this.log(`Timeout (${SCAN_MS} ms) – ingen båt nära ${b.name}`);
          kill();
          resolve(false);
        }, SCAN_MS);

        ws.on("open", () => {
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

            /* === RÄTT STAVNING HÄR! === */
            const meta = msg.Metadata || msg.MetaData || {};
            const body = msg.Message?.PositionReport || {};

            const lat = meta.Latitude ?? meta.latitude ?? body.Latitude;
            const lon = meta.Longitude ?? meta.longitude ?? body.Longitude;
            const sog = meta.SOG ?? meta.speedOverGround ?? body.SOG ?? 0;

            if (lat == null || lon == null || sog < MIN_KTS) return;

            const d = this._haversine(lat, lon, b.lat, b.lon);
            if (d <= MAX_DIST) {
              this.log(
                `🚢 ${body.ShipName || body.UserID || "Fartyg"} ` +
                  `vid ${b.name} – ${d.toFixed(0)} m, ${sog.toFixed(1)} kn`
              );
              clearTimeout(timer);
              kill();
              resolve(true);
            }
          } catch (e) {
            this.error(`JSON-fel (${b.name}):`, e);
          }
        });

        ws.on("error", (err) => {
          this.error(`WSS-fel:`, err.message);
        });
        ws.on("close", () => {
          clearTimeout(timer);
          kill();
        });
      });
    } catch (err) {
      this.error(`Skanning kraschade:`, err.message || err);
      return false;
    }
  }

  /* ---------- Hjälpare ---------- */
  _haversine(la1, lo1, la2, lo2) {
    const R = 6_371_000;
    const φ1 = (la1 * Math.PI) / 180,
      φ2 = (la2 * Math.PI) / 180,
      dφ = ((la2 - la1) * Math.PI) / 180,
      dλ = ((lo2 - lo1) * Math.PI) / 180;

    return (
      2 *
      R *
      Math.asin(
        Math.sqrt(
          Math.sin(dφ / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
        )
      )
    );
  }
}

module.exports = AISBridgeApp;
