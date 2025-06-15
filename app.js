/* ====================================================================
   AIS Bridge – Homey-app som larmar när fartyg närmar sig broar
   ==================================================================== */
"use strict";

const Homey = require("homey");
const WS = require("ws");

/* ---------- Bro-koordinater ---------- */
const BRIDGES = {
  klaffbron: { name: "Klaffbron", lat: 58.283953, lon: 12.2847 },
  jarnvagsbron: { name: "Järnvägsbron", lat: 58.2917, lon: 12.2911 },
  stridsbergsbron: { name: "Stridsbergsbron", lat: 58.2935, lon: 12.294167 },
  stallbackabron: { name: "Stallbackabron", lat: 58.3177, lon: 12.3032 },
};

/* ---------- Konstanter ---------- */
const MAX_DIST = 600; // m – standardradie för bro
const EXTRA_MARGIN = 1_000; // m – marginal runt bounding-boxen
const MIN_KTS = 0.0; // ignorera helt stilla
const MAX_AGE_SEC = 3 * 60; // ”nyligen nära”-fönster
const WS_URL = "wss://stream.aisstream.io/v0/stream";
const KEEPALIVE_MS = 60_000; // skicka ny subscription var minut
const RECONNECT_MS = 10_000; // reconnect-försök vid fel

/* ---------- Hjälpfunktioner ---------- */
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

function getDirection(cog) {
  const deg = Number(cog);
  return !isNaN(deg) && deg > 90 && deg < 270 ? "Göteborg" : "Vänersborg";
}
const now = () => Date.now();

/* ==================================================================== */
class AISBridgeApp extends Homey.App {
  /* ==================================================================== */

  async onInit() {
    this.log("AIS Bridge startad 🚀");

    /* ------------------------------------------------------------
          _lastSeen strukturen: { broId: { MMSI: tidsstämpel, … }, … }
          ------------------------------------------------------------ */
    this._lastSeen = {};

    /* ---------- Global tagg som kan läsas upp i TTS ---------- */
    this._activeBridgesTag = await this.homey.flow.createToken(
      "active_bridges", // token-ID  {{active_bridges}}
      "string", // datatyp
      "Aktiva broar" // human-readable namn
    );
    this._updateActiveBridgesTag(); // init = tom sträng

    /* ---------- Registrera Flow-kort ---------- */
    this._boatNearTrigger = this.homey.flow.getTriggerCard("boat_near");
    this._boatRecentCard = this.homey.flow.getConditionCard("boat_recent");
    this._boatRecentCard.registerRunListener(
      this._onFlowConditionBoatRecent.bind(this)
    );

    /* ---------- Starta AIS-strömmen ---------- */
    this._startLiveFeed();
  }

  /* ============================================================
        OCH-kort: är (minst ett) fartyg nyligen nära vald bro?
        ============================================================ */
  async _onFlowConditionBoatRecent({ bridge }) {
    const cutoff = now() - MAX_AGE_SEC * 1000;

    /* ”any” = sant om någon bro har färsk observation */
    if (bridge === "any") {
      return Object.values(this._lastSeen).some((perBridge) =>
        Object.values(perBridge).some((ts) => ts > cutoff)
      );
    }

    const perBridge = this._lastSeen[bridge];
    if (!perBridge) return false;
    return Object.values(perBridge).some((ts) => ts > cutoff);
  }

  /* ============================================================
        Starta kontinuerlig AIS-ström (websocket)
        ============================================================ */
  _startLiveFeed() {
    const key = this.homey.settings.get("ais_api_key");
    if (!key) {
      this.error("AIS-nyckel saknas!");
      return;
    }

    /* ----- Beräkna EN gemensam bounding-box ----- */
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

    /* ----- Öppna websocket ----- */
    const ws = new WS(WS_URL);
    let keepAlive;
    const subscribe = () =>
      ws.send(JSON.stringify({ Apikey: key, BoundingBoxes: [BOX] }));

    ws.on("open", () => {
      this.log("WSS ansluten ✅");
      subscribe();
      keepAlive = setInterval(subscribe, KEEPALIVE_MS);
    });

    /* ----- Hantera varje inkommande AIS-paket ----- */
    ws.on("message", (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch (e) {
        return this.error("JSON-fel:", e);
      }

      if (
        msg.MessageType !== "PositionReport" &&
        msg.MessageType !== "StandardClassBPositionReport" &&
        msg.MessageType !== "ExtendedClassBPositionReport"
      )
        return; // ignorera alla andra meddelandetyper

      const meta = msg.Metadata || msg.MetaData || {};
      const body = Object.values(msg.Message || {})[0] || {};

      const lat = meta.Latitude ?? body.Latitude;
      const lon = meta.Longitude ?? body.Longitude;
      const sog = meta.Sog ?? meta.SOG ?? body.Sog ?? body.SOG ?? 0;
      const mmsi = body.MMSI ?? meta.MMSI;
      if (!lat || !lon || !mmsi || sog < MIN_KTS) return;

      /* --- 1. Vilka broar ligger vi inom radien för? --- */
      const hits = [];
      for (const [id, B] of Object.entries(BRIDGES)) {
        const d = haversine(lat, lon, B.lat, B.lon);
        if (d <= (B.radius ?? MAX_DIST)) hits.push({ id, B, dist: d });
      }
      if (!hits.length) return;

      /* --- 2. Välj EN bro (närmast & framför) --- */
      const dir = getDirection(body.Cog ?? meta.Cog);
      const down = dir === "Göteborg";
      hits.sort((a, b) => a.dist - b.dist);
      const ahead = hits.filter((h) =>
        down ? h.B.lat <= lat : h.B.lat >= lat
      );
      const { id: chosenId, B: chosenB } = ahead[0] || hits[0];

      /* --- 3. Flytta MMSI till rätt bro (unik zon) --- */
      for (const list of Object.values(this._lastSeen)) delete list[mmsi]; // rensa gamla poster

      (this._lastSeen[chosenId] ??= {})[mmsi] = now();

      /* --- 4. Uppdatera global tagg --- */
      this._updateActiveBridgesTag();

      /* --- 5. Logg + trigga Flow --- */
      const name = (body.Name ?? meta.ShipName ?? "").trim() || "(namn saknas)";
      this.log(`🚢 ${name} (${mmsi}) vid ${chosenB.name}  ${dir}`);

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

    /* ----- Reconnect-logik ----- */
    const restart = (err) => {
      if (keepAlive) clearInterval(keepAlive);
      if (err) this.error("WSS-fel:", err.message || err);
      setTimeout(() => this._startLiveFeed(), RECONNECT_MS);
    };
    ws.on("error", restart);
    ws.on("close", () => restart());
  }

  /* ============================================================
        Bygg naturlig svensk/frasevänlig text och sätt taggen
        ============================================================ */
  _updateActiveBridgesTag() {
    const cutoff = now() - MAX_AGE_SEC * 1000;
    const parts = [];

    /* -- rensa gamla poster och bygg fraser -- */
    for (const [id, perBridge] of Object.entries(this._lastSeen)) {
      for (const [mmsi, ts] of Object.entries(perBridge))
        if (ts < cutoff) delete perBridge[mmsi];

      const count = Object.keys(perBridge).length;
      if (!count) {
        delete this._lastSeen[id];
        continue;
      }

      const broNamn = BRIDGES[id].name;
      parts.push(
        count === 1
          ? `en båt nära ${broNamn}`
          : `${count} båtar nära ${broNamn}`
      );
    }

    /* -- sätt slutlig fras -- */
    let phrase = "inga fartyg nära någon bro";
    if (parts.length === 1) phrase = parts[0];
    else if (parts.length === 2) phrase = parts.join(" och ");
    else if (parts.length > 2) {
      const last = parts.pop();
      phrase = parts.join(", ") + " och " + last;
    }

    this._activeBridgesTag.setValue(phrase);
  }
}

module.exports = AISBridgeApp;
