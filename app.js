"use strict";

const Homey = require("homey");
const WS = require("ws");

// ── Statisk konfiguration ────────────────────────────────────────────────
const BRIDGES = {
  klaffbron: { name: "Klaffbron", lat: 58.283953, lon: 12.2847 },
  jarnvagsbron: { name: "Järnvägsbron", lat: 58.2917, lon: 12.2911 },
  stridsbergsbron: { name: "Stridsbergsbron", lat: 58.2935, lon: 12.294167 },
  stockholm_inlet: {
    name: "Stockholms inlopp (test 3 km)",
    lat: 59.4,
    lon: 18.3,
    radius: 3000,
  },
};

const MAX_DIST = 300; // default-radie (m) om ingen radius finns i BRIDGES
const MIN_KTS = 1.0; // ignorera i princip stillaliggande fartyg
const SCAN_MS = 30_000; // lyssna så här länge per förfrågan
const WS_URL = "wss://stream.aisstream.io/v0/stream";

// ── Homey-app ────────────────────────────────────────────────────────────
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
      const radius = b.radius ?? MAX_DIST; // m
      const latPad = radius / 111000; // ° lat
      const lonPad = radius / (111000 * Math.cos((b.lat * Math.PI) / 180));

      const bbox = [
        [b.lat + latPad, b.lon - lonPad],
        [b.lat - latPad, b.lon + lonPad],
      ];

      this.log(`Startar skanning (${radius} m) för ${b.name}`);

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
          // Enklare prenumeration: bara api-nyckel + bbox
          ws.send(
            JSON.stringify({
              Apikey: key,
              BoundingBoxes: [bbox],
            })
          );
        });

        ws.on("message", (buf) => {
          try {
            const msg = JSON.parse(buf);

            // Ta bara meddelanden som faktiskt innehåller positionsfält
            if (
              msg.MessageType !== "PositionReport" &&
              msg.MessageType !== "StandardClassBPositionReport" &&
              msg.MessageType !== "ExtendedClassBPositionReport"
            )
              return;

            const meta = msg.Metadata || msg.MetaData || {};
            const body =
              msg.Message?.PositionReport ||
              msg.Message?.StandardClassBPositionReport ||
              msg.Message?.ExtendedClassBPositionReport ||
              {};

            const lat =
              meta.Latitude ?? meta.latitude ?? body.Latitude ?? body.latitude;
            const lon =
              meta.Longitude ??
              meta.longitude ??
              body.Longitude ??
              body.longitude;
            const sog =
              meta.Sog ??
              meta.SOG ??
              meta.speedOverGround ??
              body.Sog ??
              body.SOG ??
              body.speedOverGround ??
              0;
            if (lat == null || lon == null || sog < MIN_KTS) return;

            const d = this._haversine(lat, lon, b.lat, b.lon);
            if (d <= radius) {
              // Mer läsvänlig logg
              const mmsi = body.MMSI ?? meta.MMSI ?? "–";
              const name =
                (body.Name ?? meta.ShipName ?? "").trim() || "(namn saknas)";
              const cog = body.Cog ?? body.COG ?? meta.Cog ?? meta.COG ?? "–";
              this.log(
                `🚢 ${name} (MMSI ${mmsi}) – ${d.toFixed(0)} m, ${sog.toFixed(
                  1
                )} kn, COG ${cog}`
              );

              clearTimeout(timer);
              kill();
              resolve(true);
            }
          } catch (e) {
            this.error(`JSON-fel (${b.name}):`, e);
          }
        });

        ws.on("error", (err) => this.error(`WSS-fel:`, err.message));
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
