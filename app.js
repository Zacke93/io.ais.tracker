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
const MAX_AGE_SEC = 3 * 60;
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
  /* Loggnivåer rättade ------------------------------ */
  dbg(...a) {
    if (DEBUG_MODE) this.log("[DEBUG]", ...a);
  }
  ldbg(...a) {
    if (DEBUG_MODE || LIGHT_DEBUG_MODE) this.log("[LIGHT]", ...a);
  }

  async onInit() {
    this.log(
      "AIS Bridge startad 🚀  (DEBUG =",
      DEBUG_MODE,
      ", LIGHT =",
      LIGHT_DEBUG_MODE,
      ")"
    );

    this._lastSeen = {};
    await this._initGlobalToken();

    /* Flow-kort ------------------------------------ */
    this._boatNearTrigger = this.homey.flow.getTriggerCard("boat_near");

    this._boatNearTrigger.registerRunListener(
      async (args, state) =>
        args.bridge === "any" || args.bridge === state.bridge
    );

    /* Condition-kort -------------------------------- */
    this._boatRecentCard = this.homey.flow.getConditionCard("boat_recent");
    this._boatRecentCard.registerRunListener(
      this._onFlowConditionBoatRecent.bind(this)
    );

    this._startLiveFeed();
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
    await this._activeBridgesTag.setValue("inga fartyg nära någon bro");
  }

  /* ---- Flow-condition ‘boat_recent’ ---- */
  async _onFlowConditionBoatRecent({ bridge }) {
    const cutoff = now() - MAX_AGE_SEC * 1000;
    if (bridge === "any")
      return Object.values(this._lastSeen).some((per) =>
        Object.values(per).some((v) => v.ts > cutoff)
      );

    const per = this._lastSeen[bridge];
    return per && Object.values(per).some((v) => v.ts > cutoff);
  }

  /* -------- WebSocket-ström -------- */
  _startLiveFeed() {
    const key = this.homey.settings.get("ais_api_key");
    if (!key) {
      this.error("AIS-API-nyckel saknas!");
      return;
    }

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

    const ws = new WS(WS_URL);
    const subscribe = () =>
      ws.send(JSON.stringify({ Apikey: key, BoundingBoxes: [BOX] }));
    let keepAlive;

    ws.on("open", () => {
      this.ldbg("WSS ansluten ✅ – box:", BOX);
      subscribe();
      keepAlive = setInterval(subscribe, KEEPALIVE_MS);
    });

    ws.on("message", (buf) => {
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

      const hits = [];
      for (const [id, B] of Object.entries(BRIDGES)) {
        const d = haversine(lat, lon, B.lat, B.lon);
        if (d <= (B.radius ?? DEFAULT_RADIUS)) hits.push({ id, B, d });
      }
      if (!hits.length) return;

      const dir = getDirection(cog);
      const down = dir === "Göteborg";
      hits.sort((a, b) => a.d - b.d);
      const ahead = hits.filter((h) =>
        down ? h.B.lat <= lat : h.B.lat >= lat
      );
      const { id: bid, B, d } = ahead[0] || hits[0];

      for (const per of Object.values(this._lastSeen)) delete per[mmsi];
      (this._lastSeen[bid] ??= {})[mmsi] = { ts: now(), dist: d, dir };

      const name = (body.Name ?? meta.ShipName ?? "").trim() || "(namn saknas)";
      this.ldbg(
        `BOAT ${name} (${mmsi}) ${Math.round(d)} m från ${B.name}, dir=${dir}`
      );

      this._updateActiveBridgesTag();

      const tokens = { bridge_name: B.name, vessel_name: name, direction: dir };
      const state = { bridge: bid };
      this._boatNearTrigger.trigger(tokens, state).catch(this.error);
    });

    const restart = (err) => {
      if (keepAlive) clearInterval(keepAlive);
      if (err) this.error("WSS-fel:", err.message || err);
      setTimeout(() => this._startLiveFeed(), RECONNECT_MS);
    };
    ws.on("error", restart);
    ws.on("close", restart);
  }

  /* -------- Uppdatera globalt token -------- */
  _updateActiveBridgesTag() {
    const cutoff = now() - MAX_AGE_SEC * 1000;
    const phrases = [];

    for (const [bid, perBridge] of Object.entries(this._lastSeen)) {
      for (const [mmsi, v] of Object.entries(perBridge))
        if (v.ts < cutoff) delete perBridge[mmsi];

      const list = Object.values(perBridge);
      if (!list.length) {
        delete this._lastSeen[bid];
        continue;
      }

      const groups = {};
      list.forEach((v) => {
        const k = v.dir;
        (groups[k] ??= []).push(v);
      });

      for (const [dir, arr] of Object.entries(groups)) {
        arr.sort((a, b) => a.dist - b.dist);
        const dists = arr.map((v) => Math.round(v.dist));
        const distStr =
          dists.length === 1
            ? dists[0]
            : dists.length === 2
            ? `${dists[0]} & ${dists[1]}`
            : `${dists.slice(0, -1).join(", ")} & ${dists.slice(-1)}`;

        const countStr = arr.length === 1 ? "En båt" : `${arr.length} båtar`;
        phrases.push(
          `${countStr} mot ${dir} är ${distStr} m från ${BRIDGES[bid].name}`
        );
      }
    }

    const sentence = !phrases.length
      ? "inga fartyg nära någon bro"
      : phrases.length === 1
      ? phrases[0]
      : phrases.slice(0, -1).join("; ") + " och " + phrases.slice(-1);

    this._activeBridgesTag
      .setValue(sentence)
      .then(() => this.ldbg("Token →", sentence))
      .catch(this.error);
  }
}

/* ==================================================================== */
module.exports = AISBridgeApp;
