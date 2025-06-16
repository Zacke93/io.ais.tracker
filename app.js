/* ====================================================================
   AIS Bridge – Homey-app som larmar när fartyg närmar sig broar
   ==================================================================== */
"use strict";

const Homey = require("homey");
const WS = require("ws");

/* ---------- PARAMETRAR ---------- */
const DEBUG_MODE = false; // ← växla här
const TOKEN_ID = "active_bridges";

/* ---------- Bro-koordinater ---------- */
const BRIDGES = {
  klaffbron: { name: "Klaffbron", lat: 58.283953, lon: 12.2847 },
  jarnvagsbron: { name: "Järnvägsbron", lat: 58.2917, lon: 12.2911 },
  stridsbergsbron: { name: "Stridsbergsbron", lat: 58.2935, lon: 12.294167 },
  stallbackabron: { name: "Stallbackabron", lat: 58.3177, lon: 12.3032 },
};

/* ---------- Konstanter ---------- */
const MAX_DIST = 4_000; // m – larmradie bro
const EXTRA_MARGIN = 200_000; // m – storlek på prenumerationsruta
const MIN_KTS = 0.0; // ignorera helt stilla
const MAX_AGE_SEC = 3 * 60; // fönster för "nyligen"
const WS_URL = "wss://stream.aisstream.io/v0/stream";
const KEEPALIVE_MS = 60_000;
const RECONNECT_MS = 10_000;

/* ---------- Hjälpfunktioner ---------- */
const now = () => Date.now();
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const φ1 = (lat1 * Math.PI) / 180,
    φ2 = (lat2 * Math.PI) / 180;
  const dφ = ((lat2 - lat1) * Math.PI) / 180;
  const dλ = ((lon2 - lon1) * Math.PI) / 180;
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
const getDirection = (cog) =>
  Number(cog) > 90 && Number(cog) < 270 ? "Göteborg" : "Vänersborg";

/* ==================================================================== */
class AISBridgeApp extends Homey.App {
  /* ==================================================================== */

  /* ---------- Smidig debug-utskrift ---------- */
  dbg(...args) {
    if (DEBUG_MODE) this.log("[DEBUG]", ...args);
  }

  /* ===================== LIVSCYKEL ===================== */
  async onInit() {
    this.log("AIS Bridge startad 🚀  (debug =", DEBUG_MODE, ")");
    this._lastSeen = {}; // { bridgeId: { MMSI: ts } }

    await this._initGlobalToken();
    this._boatNearTrigger = this.homey.flow.getTriggerCard("boat_near");
    this._boatRecentCard = this.homey.flow.getConditionCard("boat_recent");
    this._boatRecentCard.registerRunListener(
      this._onFlowConditionBoatRecent.bind(this)
    );

    this._startLiveFeed();
  }

  /* ---------------- Global token ---------------- */
  async _initGlobalToken() {
    try {
      this._activeBridgesTag = await this.homey.flow.createToken(
        TOKEN_ID,
        "string",
        "Aktiva broar",
        { title: { en: "Active bridges", sv: "Aktiva broar" } }
      );
      this.dbg("Token skapad:", TOKEN_ID);
    } catch (err) {
      if (String(err).includes("already exists")) {
        this._activeBridgesTag = await this.homey.flow.getToken(TOKEN_ID);
        this.dbg("Token fanns redan, hämtad");
      } else {
        this.error("Token-fel:", err);
        throw err;
      }
    }
    await this._activeBridgesTag.setValue("inga fartyg nära någon bro");
    this.dbg("Token init-värde satt");
  }

  /* ---------------- Condition-kort ---------------- */
  async _onFlowConditionBoatRecent({ bridge }) {
    const cutoff = now() - MAX_AGE_SEC * 1000;
    if (bridge === "any") {
      return Object.values(this._lastSeen).some((perBridge) =>
        Object.values(perBridge).some((ts) => ts > cutoff)
      );
    }
    const perBridge = this._lastSeen[bridge];
    return perBridge && Object.values(perBridge).some((ts) => ts > cutoff);
  }

  /* ===================== WEBSOCKET ===================== */
  _startLiveFeed() {
    const key = this.homey.settings.get("ais_api_key");
    if (!key) {
      this.error("AIS-nyckel saknas!");
      return;
    }

    /* ---- bounding-box ---- */
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
    this.dbg("Bounding box [lat,lon]:", BOX);

    /* ---- WebSocket ---- */
    const ws = new WS(WS_URL);
    const subscribe = () =>
      ws.send(JSON.stringify({ Apikey: key, BoundingBoxes: [BOX] }));
    let keepAlive;

    ws.on("open", () => {
      this.log("WSS ansluten ✅");
      subscribe();
      keepAlive = setInterval(subscribe, KEEPALIVE_MS);
    });

    ws.on("message", (buf) => {
      /* – rå-debug – */
      if (DEBUG_MODE) {
        const head = buf.toString("utf8", 0, 120);
        this.log("[RX]", head.replace(/\s+/g, " "));
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
      const sog = meta.Sog ?? meta.SOG ?? body.Sog ?? body.SOG ?? 0;
      const mmsi = body.MMSI ?? meta.MMSI;
      if (!lat || !lon || !mmsi || sog < MIN_KTS) return;

      /* --- distans till broar --- */
      const hits = [];
      for (const [id, B] of Object.entries(BRIDGES)) {
        const d = haversine(lat, lon, B.lat, B.lon);
        if (DEBUG_MODE && d < 10_000)
          this.dbg(`⋯ ${mmsi} ${d.toFixed()} m från ${B.name}`);
        if (d <= (B.radius ?? MAX_DIST)) hits.push({ id, B, d });
      }
      if (!hits.length) return;

      /* --- välj bro --- */
      const dir = getDirection(body.Cog ?? meta.Cog);
      const down = dir === "Göteborg";
      hits.sort((a, b) => a.d - b.d);
      const ahead = hits.filter((h) =>
        down ? h.B.lat <= lat : h.B.lat >= lat
      );
      const { id: chosenId, B: chosenB } = ahead[0] || hits[0];

      /* --- uppdatera intern state --- */
      for (const list of Object.values(this._lastSeen)) delete list[mmsi];
      (this._lastSeen[chosenId] ??= {})[mmsi] = now();

      /* --- token & logg --- */
      this._updateActiveBridgesTag();
      const name = (body.Name ?? meta.ShipName ?? "").trim() || "(namn saknas)";
      this.log(`🚢 ${name} (${mmsi}) vid ${chosenB.name} ${dir}`);

      /* --- trigga Flow --- */
      const tokens = {
        bridge: chosenB.name,
        vessel_name: name,
        direction: dir,
      };
      this._boatNearTrigger
        .trigger(tokens, { bridge: chosenId })
        .catch(this.error);
      this._boatNearTrigger
        .trigger(tokens, { bridge: "any" })
        .catch(this.error);
    });

    const restart = (err) => {
      if (keepAlive) clearInterval(keepAlive);
      if (err) this.error("WSS-fel:", err.message || err);
      setTimeout(() => this._startLiveFeed(), RECONNECT_MS);
    };
    ws.on("error", restart);
    ws.on("close", () => restart());
  }

  /* ---------------- Token-uppdatering ---------------- */
  _updateActiveBridgesTag() {
    const cutoff = now() - MAX_AGE_SEC * 1000;
    const parts = [];

    for (const [id, perBridge] of Object.entries(this._lastSeen)) {
      for (const [mmsi, ts] of Object.entries(perBridge))
        if (ts < cutoff) delete perBridge[mmsi];

      const count = Object.keys(perBridge).length;
      if (!count) {
        delete this._lastSeen[id];
        continue;
      }

      const bro = BRIDGES[id].name;
      parts.push(
        count === 1 ? `en båt nära ${bro}` : `${count} båtar nära ${bro}`
      );
    }

    let phrase = "inga fartyg nära någon bro";
    if (parts.length === 1) phrase = parts[0];
    else if (parts.length === 2) phrase = parts.join(" och ");
    else if (parts.length > 2)
      phrase = parts.slice(0, -1).join(", ") + " och " + parts.slice(-1);

    this._activeBridgesTag.setValue(phrase).catch(this.error);
    this.dbg("Token uppdaterad →", phrase);
  }
}

module.exports = AISBridgeApp;
