"use strict";

const Homey = require("homey");
const WS = require("ws");

/* ── Statisk konfiguration ─────────────────────────────────────────── */
const BRIDGES = {
  klaffbron: { name: "Klaffbron", lat: 58.283953, lon: 12.2847 },
  jarnvagsbron: { name: "Järnvägsbron", lat: 58.2917, lon: 12.2911 },
  stridsbergsbron: { name: "Stridsbergsbron", lat: 58.2935, lon: 12.294167 },
  stockholm_inlet: {
    name: "Stockholms inlopp (test 3 km)",
    lat: 59.4,
    lon: 18.3,
    radius: 3000, // ändra här om du vill större radie
  },
};

const MAX_DIST = 300; // m (om radius saknas ovan)
const MIN_KTS = 0.2; // fart-tröskel (knop)
const SCAN_MS = 30_000; // Homey-villkor måste svara < 30 000 ms
const WS_URL = "wss://stream.aisstream.io/v0/stream";

/* ── Hjälpfunktioner ──────────────────────────────────────────────── */
function haversine(la1, lo1, la2, lo2) {
  const R = 6_371_000;
  const φ1 = (la1 * Math.PI) / 180,
    φ2 = (la2 * Math.PI) / 180;
  const dφ = ((la2 - la1) * Math.PI) / 180,
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
function getDirection(cog) {
  const deg = Number(cog);
  if (Number.isNaN(deg)) return "okänd";
  // Vänern–Göta älv grov logik: 90°–270° ≈ söder/väst = Göteborg
  return deg > 90 && deg < 270 ? "Göteborg" : "Vänersborg";
}

/* ── Homey-app ─────────────────────────────────────────────────────── */
class AISBridgeApp extends Homey.App {
  async onInit() {
    this.log("AIS Bridge (on-demand) started");

    /* --- 1. Skapa globala app-taggar (tomma till en början) --- */
    this._tokens = {};
    for (const [id, bridge] of Object.entries(BRIDGES)) {
      const tName = await this.homey.flow.createToken(`boat_name_${id}`, {
        type: "string",
        title: `Fartygsnamn – ${bridge.name}`,
      });
      const tDir = await this.homey.flow.createToken(`boat_dir_${id}`, {
        type: "string",
        title: `Riktning – ${bridge.name}`,
      });
      this._tokens[id] = { name: tName, dir: tDir };
    }

    /* --- 2. Registrera villkorskortet --- */
    this._ongoingScans = new Map();
    this.homey.flow
      .getConditionCard("is_boat_near")
      .registerRunListener(this.onFlowConditionIsBoatNear.bind(this));
  }

  /* ----- Villkor (“Och”) ----- */
  async onFlowConditionIsBoatNear({ bridge }) {
    if (this._ongoingScans.has(bridge)) return this._ongoingScans.get(bridge);

    const p = this._scanOnce(bridge).finally(() =>
      this._ongoingScans.delete(bridge)
    );
    this._ongoingScans.set(bridge, p);
    return p;
  }

  /* ----- Engångsskanner (kallas av villkorskortet) ----- */
  async _scanOnce(bridgeId) {
    try {
      const key = this.homey.settings.get("ais_api_key");
      if (!key) {
        this.error("AIS-nyckel saknas");
        return false;
      }

      const B = BRIDGES[bridgeId];
      const radius = B.radius ?? MAX_DIST;
      const latPad = radius / 111000;
      const lonPad = radius / (111000 * Math.cos((B.lat * Math.PI) / 180));
      const bbox = [
        [B.lat + latPad, B.lon - lonPad],
        [B.lat - latPad, B.lon + lonPad],
      ];

      this.log(`Startar skanning (${radius} m) för ${B.name}`);

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
          this.log(`Timeout (${SCAN_MS} ms) – ingen båt nära ${B.name}`);
          kill();
          resolve(false);
        }, SCAN_MS);

        ws.on("open", () => {
          ws.send(JSON.stringify({ Apikey: key, BoundingBoxes: [bbox] }));
        });

        ws.on("message", (buf) => {
          let msg;
          try {
            msg = JSON.parse(buf.toString());
          } catch (e) {
            this.error("JSON-fel:", e);
            return;
          }

          /* --- typ-filter --- */
          if (
            msg.MessageType !== "PositionReport" &&
            msg.MessageType !== "StandardClassBPositionReport" &&
            msg.MessageType !== "ExtendedClassBPositionReport"
          )
            return;

          const meta = msg.Metadata || msg.MetaData || {};
          const body = Object.values(msg.Message || {})[0] || {};

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

          const dist = haversine(lat, lon, B.lat, B.lon);
          if (dist > radius) return;

          /* --- Fartyg hittat! --- */
          const name =
            (body.Name ?? meta.ShipName ?? "").trim() || "(namn saknas)";
          const cog = body.Cog ?? body.COG ?? meta.Cog ?? meta.COG ?? "–";
          const dir = getDirection(cog);

          this.log(
            `🚢 ${name} – ${dist.toFixed(0)} m, ${sog.toFixed(
              1
            )} kn, dir ${dir}`
          );

          /* Sätt app-taggarna */
          const tok = this._tokens[bridgeId];
          tok.name.setValue(name).catch(() => {});
          tok.dir.setValue(dir).catch(() => {});

          /* Nollställ taggar efter 2 min */
          setTimeout(() => {
            tok.name.setValue(null).catch(() => {});
            tok.dir.setValue(null).catch(() => {});
          }, 2 * 60 * 1000);

          clearTimeout(timer);
          kill();
          resolve(true);
        });

        ws.on("error", (e) => this.error("WSS-fel:", e.message));
        ws.on("close", () => {
          clearTimeout(timer);
          kill();
        });
      });
    } catch (err) {
      this.error("Skanning kraschade:", err.message || err);
      return false;
    }
  }
}

module.exports = AISBridgeApp;
