/* ====================================================================
   AIS Bridge – Homey-app som larmar när fartyg närmar sig broar
   ==================================================================== */
"use strict";

const Homey = require("homey");
const WS = require("ws");

/* ---------- PARAMETRAR ---------- */
const DEBUG_MODE = false; // ← sätt true för debug
const TOKEN_ID = "active_bridges";

/* ---------- Bro-koordinater ---------- */
const BRIDGES = {
  olidebron: {
    name: "Olidebron",
    lat: 58.272778,
    lon: 12.275,
    radius: 600,
  },
  klaffbron: {
    name: "Klaffbron",
    lat: 58.283953,
    lon: 12.2847,
    radius: 600,
  },
  jarnvagsbron: {
    name: "Järnvägsbron",
    lat: 58.2917,
    lon: 12.2911,
    radius: 600,
  },
  stridsbergsbron: {
    name: "Stridsbergsbron",
    lat: 58.2935,
    lon: 12.294167,
    radius: 600,
  },
  stallbackabron: {
    name: "Stallbackabron",
    lat: 58.3177,
    lon: 12.3032,
    radius: 600,
  },
};

/* ---------- Konstanter ---------- */
const DEFAULT_RADIUS = 600;
const EXTRA_MARGIN = 5_000; // m
const MIN_KTS = 0.2;
const MAX_AGE_SEC = 3 * 60;
const WS_URL = "wss://stream.aisstream.io/v0/stream";
const KEEPALIVE_MS = 60_000;
const RECONNECT_MS = 10_000;

/* ---------- Hjälpfunktioner ---------- */
const now = () => Date.now();
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000,
    φ1 = (lat1 * Math.PI) / 180,
    φ2 = (lat2 * Math.PI) / 180;
  const dφ = ((lat2 - lat1) * Math.PI) / 180,
    dλ = ((lon2 - lon1) * Math.PI) / 180;
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

  dbg(...a) {
    if (DEBUG_MODE) this.log("[DEBUG]", ...a);
  }

  async onInit() {
    this.log("AIS Bridge startad 🚀 (debug =", DEBUG_MODE, ")");
    this._lastSeen = {};

    await this._initGlobalToken();

    this._boatNearTrigger = this.homey.flow.getTriggerCard("boat_near");
    this._boatRecentCard = this.homey.flow.getConditionCard("boat_recent");
    this._boatRecentCard.registerRunListener(
      this._onFlowConditionBoatRecent.bind(this)
    );

    this._startLiveFeed();
  }

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

  async _onFlowConditionBoatRecent({ bridge }) {
    const cutoff = now() - MAX_AGE_SEC * 1000;
    if (bridge === "any")
      return Object.values(this._lastSeen).some((p) =>
        Object.values(p).some((v) => v.ts > cutoff)
      );
    const per = this._lastSeen[bridge];
    return per && Object.values(per).some((v) => v.ts > cutoff);
  }

  _startLiveFeed() {
    const key = this.homey.settings.get("ais_api_key");
    if (!key) {
      this.error("AIS-nyckel saknas!");
      return;
    }

    /* bounding-box */
    const lats = Object.values(BRIDGES).map((b) => b.lat);
    const lons = Object.values(BRIDGES).map((b) => b.lon);
    const maxLat = Math.max(...lats),
      minLat = Math.min(...lats);
    const maxLon = Math.max(...lons),
      minLon = Math.min(...lons);
    const marginLat = EXTRA_MARGIN / 111000;
    const midLat = (maxLat + minLat) / 2;
    const marginLon =
      EXTRA_MARGIN / (111000 * Math.cos((midLat * Math.PI) / 180));
    const BOX = [
      [maxLat + marginLat, minLon - marginLon],
      [minLat - marginLat, maxLon + marginLon],
    ];

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
      if (DEBUG_MODE) this.dbg("[RX]", buf.toString("utf8", 0, 120));
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

      /* distans-test */
      const hits = [];
      for (const [id, B] of Object.entries(BRIDGES)) {
        const d = haversine(lat, lon, B.lat, B.lon);
        if (d <= (B.radius ?? DEFAULT_RADIUS)) hits.push({ id, B, d });
      }
      if (!hits.length) return;

      /* välj bro */
      const dir = getDirection(cog);
      const down = dir === "Göteborg";
      hits.sort((a, b) => a.d - b.d);
      const ahead = hits.filter((h) =>
        down ? h.B.lat <= lat : h.B.lat >= lat
      );
      const { id: bid, B, d } = ahead[0] || hits[0];
      const towards = dir === "Göteborg" ? lat > B.lat : lat < B.lat;

      /* spara state */
      for (const per of Object.values(this._lastSeen)) delete per[mmsi];
      (this._lastSeen[bid] ??= {})[mmsi] = { ts: now(), dist: d, dir, towards };

      this._updateActiveBridgesTag();

      const name = (body.Name ?? meta.ShipName ?? "").trim() || "(namn saknas)";
      const tokens = { bridge: B.name, vessel_name: name, direction: dir };
      this._boatNearTrigger.trigger(tokens, { bridge: bid }).catch(this.error);
    });

    const restart = (err) => {
      if (keepAlive) clearInterval(keepAlive);
      if (err) this.error("WSS-fel:", err.message || err);
      setTimeout(() => this._startLiveFeed(), RECONNECT_MS);
    };
    ws.on("error", restart);
    ws.on("close", () => restart());
  }

  _updateActiveBridgesTag() {
    const cutoff = now() - MAX_AGE_SEC * 1000;
    const phrases = [];

    for (const [bid, perBridge] of Object.entries(this._lastSeen)) {
      for (const [mmsi, v] of Object.entries(perBridge))
        if (v.ts < cutoff) delete perBridge[mmsi];
      const vessels = Object.values(perBridge);
      if (!vessels.length) {
        delete this._lastSeen[bid];
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
        const dists = list.map((v) => Math.round(v.dist));
        let distStr =
          dists.length === 1
            ? `${dists[0]}`
            : dists.length === 2
            ? `${dists[0]} respektive ${dists[1]}`
            : dists.slice(0, -1).join(", ") + " respektive " + dists.slice(-1);
        const countStr = list.length === 1 ? "En båt" : `${list.length} båtar`;
        const verb = towards ? "har" : "är";
        const suffix = towards ? "kvar till" : "från";
        phrases.push(
          `${countStr} med riktning mot ${dir} ${verb} ${distStr} meter ${suffix} ${BRIDGES[bid].name}`
        );
      }
    }

    let sentence = "inga fartyg nära någon bro";
    if (phrases.length === 1) sentence = phrases[0];
    else if (phrases.length === 2) sentence = phrases.join(" och ");
    else if (phrases.length > 2)
      sentence = phrases.slice(0, -1).join(", ") + " och " + phrases.slice(-1);

    this._activeBridgesTag.setValue(sentence).catch(this.error);
    this.dbg("Token →", sentence);
  }
}

module.exports = AISBridgeApp;
