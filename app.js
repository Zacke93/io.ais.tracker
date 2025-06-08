"use strict";

const Homey = require("homey");
const WS = require("ws");

// ── Statisk konfiguration ────────────────────────────────────────────────
/**
 * Broar som övervakas (WGS-84, decimala grader)
 */
const BRIDGES = {
  klaffbron: { name: "Klaffbron", lat: 58.283953, lon: 12.2847 },
  jarnvagsbron: { name: "Järnvägsbron", lat: 58.2917, lon: 12.2911 }, // ← justerad 👍
  stridsbergsbron: { name: "Stridsbergsbron", lat: 58.2935, lon: 12.294167 },
};

const MAX_DIST = 300; // meter – räckvidd som räknas som “nära”
const MIN_KTS = 1.0; // filtrera bort stillaliggande båtar
const SCAN_MS = 8_000; // lyssna max så här länge per förfrågan
const BOX_PAD = 0.01; // ± grader runt bron för AIS-prenumerationen
const WS_URL = "wss://stream.aisstream.io/v0/stream";

/**
 * Homey-app som on-demand lyssnar på AISstream och slår till
 * Flow-villkoret om ett fartyg kommer inom {@link MAX_DIST}.
 */
class AISBridgeApp extends Homey.App {
  async onInit() {
    this.log("AIS Bridge (on-demand) started");

    /** Cache per bro så vi inte öppnar flera sockets samtidigt */
    this._ongoingScans = new Map();

    // Koppla Flow-kortet
    this.homey.flow
      .getConditionCard("is_boat_near")
      .registerRunListener(this.onFlowConditionIsBoatNear.bind(this));
  }

  // ── Flow-villkorets kör-lyssnare ────────────────────────────────────────
  /**
   * @param {{bridge: keyof typeof BRIDGES}} args
   * @returns {Promise<boolean>}
   */
  async onFlowConditionIsBoatNear(args) {
    const bridgeId = args.bridge;

    // Enbart en skanning per bro åt gången för att undvika rate-limits
    if (this._ongoingScans.has(bridgeId)) {
      this.log(`Scan pågår redan för ${bridgeId} – återanvänder löftet`);
      return this._ongoingScans.get(bridgeId);
    }

    const promise = this._scanOnce(bridgeId).finally(() =>
      this._ongoingScans.delete(bridgeId)
    );

    this._ongoingScans.set(bridgeId, promise);
    return promise;
  }

  // ── Engångsskanner ─────────────────────────────────────────────────────
  /**
   * @param {keyof typeof BRIDGES} bridgeId
   * @returns {Promise<boolean>}
   */
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
      this.log(`Startar skanning för ${b.name} (${bridgeId})`);

      const bbox = [
        [b.lat + BOX_PAD, b.lon - BOX_PAD],
        [b.lat - BOX_PAD, b.lon + BOX_PAD],
      ];

      return await new Promise((resolve) => {
        let resolved = false;
        let timer;

        // Anslut
        const ws = new WS(WS_URL);

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

        // Timeout-vakt
        timer = setTimeout(() => {
          this.log(`Timeout för ${b.name} efter ${SCAN_MS} ms`);
          finish(false);
        }, SCAN_MS);

        ws.on("open", () => {
          this.log(`WSS öppnad för ${b.name} – prenumererar på området`);
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

            const d = this._haversine(lat, lon, b.lat, b.lon);
            if (d <= MAX_DIST) {
              this.log(
                `🚢 BÅT UPPTÄCKT vid ${b.name}! ` +
                  `${m.ShipName || m.MMSI} @ ${d.toFixed(0)} m, ` +
                  `${sog.toFixed(1)} kn`
              );
              finish(true);
            }
          } catch (e) {
            this.error(`JSON-fel för ${b.name}:`, e);
          }
        });

        ws.on("error", (err) => {
          this.error(`WSS-fel för ${b.name}:`, err.message);
          finish(false);
        });
        ws.on("close", () => {
          this.log(`WSS stängd för ${b.name}`);
          if (!resolved) finish(false);
        });
      });
    } catch (err) {
      this.error(`Skanning misslyckades för ${bridgeId}:`, err.message || err);
      return false;
    }
  }

  // ── Hjälpfunktioner ────────────────────────────────────────────────────
  /**
   * Storcirkelavstånd (haversine)
   * @private
   */
  _haversine(la1, lo1, la2, lo2) {
    const R = 6_371_000;
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
