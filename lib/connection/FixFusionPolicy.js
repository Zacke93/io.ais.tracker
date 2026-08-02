'use strict';

const geometry = require('../utils/geometry');

/**
 * FixFusionPolicy - Rena, tillståndslösa fusionsregler F1-F5 för dubbelkälla
 * (aisstream websocket-push + AISHub 65s-poll). Allt state skickas in.
 *
 * KLOCKDOMÄNSINVARIANTEN (slutplanen §3, granskningsfynd V1-C3/V2-C4):
 * aisstream-fix bär mottagningstid (fixTsQuality 'receipt'), AISHub-fix bär
 * äkta fixtid ('true-fix'). En tidsjämförelse MELLAN kvaliteterna är
 * odefinierad — en 40 s gammal AISHub-fix är ofta den FÄRSKASTE informationen
 * trots lägre fixTs än aisstreams senaste mottagningsstämpel. Därför:
 *
 *   F1  Monoton spärr PER KÄLLA — aldrig korskälla, och enbart för
 *       fixTsQuality 'true-fix'. Fångar exakt den dubblettkategori som är
 *       NY med AISHub: samma fix re-levererad i flera pollar (identisk
 *       TIME). Receipt-stämplade meddelanden (aisstream) passerar alltid —
 *       de har inga re-leveranser, och spärren hade annars tystat källan
 *       vid millisekundsdelade meddelanden eller NTP-bakhopp.
 *   F2  Korskälle-suppression på INNEHÅLL (mmsi+position+sog+cog), inte tid.
 *       Samma källa berörs ALDRIG — aisstreams legitima 3-minuters-
 *       upprepningar från kaj måste fortsätta flöda (grupp B, V2-M5).
 *   F3  Fix utan användbar fixTs får mottagningstid (defensivt).
 *   F4a Framtida fix (> FUTURE_CLAMP_MS) klampas till now + clockSkew-flagga
 *       (GO-kriterium för etapp 3: clockSkew === 0).
 *   F4b Enda hårda åldersgrinden: MAX_FIX_AGE_MS, härledd ur interval-
 *       parameterns serverkontrakt (+2 min skevmarginal).
 *   F5  Källbyte med positionshopp > FEED_SWITCH_DIST_M inom
 *       FEED_SWITCH_WINDOW_MS ⇒ feedSwitch-flagga. Flaggan undantar den
 *       GLOBALA jump-tallyn (SystemCoordinator) men behåller per-fartygs-
 *       koordinationen — två källors olika GPS-vy är inte en trasig sändare.
 */

/**
 * Nytt tomt per-MMSI-fusionsstate.
 * @returns {object}
 */
function createState() {
  return {
    lastFixTs: { aisstream: null, aishub: null },
    lastContent: null, // { key, ts, feed }
    lastFeed: null,
    lastLat: null,
    lastLon: null,
    lastAcceptedTs: null,
  };
}

/**
 * F3 + F4a: normalisera fixTs. Muterar inte msg utom clockSkew-flaggan.
 * @param {object} msg - Normaliserat AIS-meddelande (fixTs, fixFeed …)
 * @param {number} now - Date.now() hos anroparen
 * @param {object} cfg - AIS_CONFIG.FUSION
 * @returns {number} användbar fixTs (ms)
 */
function normalizeFixTs(msg, now, cfg) {
  let ts = Number.isFinite(msg.fixTs) ? msg.fixTs : now; // F3
  if (ts > now + cfg.FUTURE_CLAMP_MS) { // F4a
    ts = now;
    msg.clockSkew = true;
  }
  return ts;
}

/**
 * Innehållsnyckeln för F2 (position på 5 decimaler ≈ 1,1 m — GPS-identiskt).
 * @private
 */
function contentKey(msg) {
  return `${msg.mmsi}:${msg.lat.toFixed(5)}:${msg.lon.toFixed(5)}:${msg.sog}:${msg.cog}`;
}

/**
 * F1-F5: ska fixen accepteras in i pipelinen?
 *
 * @param {object} state - Per-MMSI-state från createState()
 * @param {object} msg - Normaliserat AIS-meddelande
 * @param {number} now - Date.now() hos anroparen
 * @param {object} cfg - AIS_CONFIG.FUSION
 * @returns {{accept: boolean, reason?: string, fixTs?: number, feedSwitch?: boolean}}
 */
function shouldAccept(state, msg, now, cfg) {
  const feed = msg.fixFeed;
  const fixTs = normalizeFixTs(msg, now, cfg);

  // F4b: enda hårda åldersgrinden.
  if (now - fixTs > cfg.MAX_FIX_AGE_MS) {
    return { accept: false, reason: 'fix_too_old' };
  }

  // F1: monoton spärr PER KÄLLA — aldrig korskälla (domänrenhet), och
  // ENDAST för äkta fixtider ('true-fix'). Receipt-stämplar (aisstream) har
  // inga re-leveranser att fånga: två äkta meddelanden kan dela millisekund
  // och ett NTP-bakhopp får ALDRIG tysta källan tills klockan hunnit ikapp
  // — aisstream genom both-läget måste bete sig exakt som i pass-through.
  if (msg.fixTsQuality === 'true-fix') {
    const prev = state.lastFixTs[feed];
    if (prev != null && fixTs <= prev) {
      return { accept: false, reason: 'stale_or_duplicate_fix' };
    }
  }

  // F2: korskälle-suppression på INNEHÅLL, inte tid. Kräver ANNAN källa —
  // samma källas identiska innehåll med ny fixTs är aisstreams legitima
  // kajupprepning och håller fartyget vid liv (grupp B/C).
  // F2b (etapp 3): eko-grenen — identiskt innehåll vars fixTs ligger inom
  // FIX_ECHO_TOLERANCE_MS från det senast accepterade innehålls-fixet är en
  // re-leverans av SAMMA fysiska rapport (oavsett hur gammal accepten är)
  // och får aldrig refresha fartygets livstecken. En äkta ny rapport med
  // samma position bär nytt fixTs utanför toleransen och accepteras.
  const key = contentKey(msg);
  if (state.lastContent
      && state.lastContent.key === key
      && state.lastContent.feed !== feed) {
    const withinAcceptWindow = now - state.lastContent.ts < cfg.CROSS_FEED_DEDUP_MS;
    const isEcho = Number.isFinite(state.lastContent.fixTs)
      && Math.abs(fixTs - state.lastContent.fixTs) < (cfg.FIX_ECHO_TOLERANCE_MS ?? 0);
    if (withinAcceptWindow || isEcho) {
      return { accept: false, reason: 'cross_feed_duplicate' };
    }
  }

  // F5: källbytesskydd — flagga, aldrig blockering.
  let feedSwitch = false;
  if (state.lastFeed && state.lastFeed !== feed
      && Number.isFinite(state.lastLat) && Number.isFinite(state.lastLon)
      && state.lastAcceptedTs !== null
      && now - state.lastAcceptedTs < cfg.FEED_SWITCH_WINDOW_MS) {
    const dist = geometry.calculateDistance(msg.lat, msg.lon, state.lastLat, state.lastLon);
    if (Number.isFinite(dist) && dist > cfg.FEED_SWITCH_DIST_M) {
      feedSwitch = true;
    }
  }

  return { accept: true, fixTs, feedSwitch };
}

/**
 * Bokför en accepterad fix i statet (anropas EFTER shouldAccept ⇒ accept).
 * @param {object} state - Per-MMSI-state
 * @param {object} msg - Meddelandet som accepterades
 * @param {number} fixTs - Normaliserad fixTs från shouldAccept
 * @param {number} now - Date.now() hos anroparen
 */
function applyAccept(state, msg, fixTs, now) {
  state.lastFixTs[msg.fixFeed] = fixTs;
  state.lastContent = {
    key: contentKey(msg), ts: now, feed: msg.fixFeed, fixTs,
  };
  state.lastFeed = msg.fixFeed;
  state.lastLat = msg.lat;
  state.lastLon = msg.lon;
  state.lastAcceptedTs = now;
}

/**
 * TTL- + LRU-prune av fusionsstate-kartan (körs i monitoring-takt).
 * @param {Map<string, object>} stateMap - mmsi → state
 * @param {number} now - Date.now() hos anroparen
 * @param {object} cfg - AIS_CONFIG.FUSION
 * @returns {number} antal borttagna poster
 */
function pruneStates(stateMap, now, cfg) {
  let removed = 0;
  for (const [mmsi, st] of stateMap) {
    if (st.lastAcceptedTs === null || now - st.lastAcceptedTs > cfg.STATE_TTL_MS) {
      stateMap.delete(mmsi);
      removed++;
    }
  }
  // Hårt tak med LRU (Map bevarar insättningsordning; äldst först).
  while (stateMap.size > cfg.STATE_MAX_ENTRIES) {
    const oldest = stateMap.keys().next().value;
    stateMap.delete(oldest);
    removed++;
  }
  return removed;
}

module.exports = {
  createState,
  normalizeFixTs,
  shouldAccept,
  applyAccept,
  pruneStates,
};
