'use strict';

const geometry = require('../utils/geometry');

/**
 * FixFusionPolicy - Rena, tillståndslösa fusionsregler F1-F5 för dubbelkälla
 * (aisstream websocket-push + AISHub 65s-poll). Allt state skickas in.
 *
 * KLOCKDOMÄNSINVARIANTEN (slutplanen §3, granskningsfynd V1-C3/V2-C4):
 * aisstream-fix bär mottagningstid (fixTsQuality 'receipt'), AISHub-fix bär
 * äkta fixtid ('true-fix'). En RÅ tidsjämförelse mellan kvaliteterna är
 * odefinierad — en 40 s gammal AISHub-fix är ofta den FÄRSKASTE informationen
 * trots lägre fixTs än aisstreams senaste mottagningsstämpel, och skillnaden
 * innehåller dessutom klockoffseten mellan Homey och AISHub-servern.
 *
 * VILLKORAD KORSDOMÄNJÄMFÖRELSE (F6 + F6b, A/B-natten 2026-08-03): invarianten
 * är sedan dess INTE absolut utan VILLKORAD. F6 gör en ENSIDIG jämförelse
 * (AISHub-fix mot senast accepterade fix oavsett källa) — men först efter att
 * F6b lyft hubbens stämpel in i Homeys klockdomän. Utan F6b är F6 bara giltig
 * åt ett håll: går hubbens klocka FÖRE ser släpande fixar färska ut och
 * grinden slutar fyra (mätt: +30 s skev ⇒ dubbelnotis på målbro, +60 s ⇒ sju
 * dubbletter). aisstream jämförs ALDRIG mot en hub-stämpel — den asymmetrin
 * står kvar och är det som gör att huvudkällan aldrig kan svältas.
 *
 * Regelöversikt:
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
 *   F6  ASYMMETRISK stale-grind (A/B-natten 2026-08-03): en AISHub-fix
 *       accepteras bara om dess fixtid är STRIKT NYARE än den senast
 *       accepterade fixen för fartyget — oavsett källa. aisstream berörs
 *       ALDRIG. Se shouldAccept() för härledningen.
 *   F6b KLOCKOFFSETKOMPENSATION (granskningsrunda 2, 2026-08-03): hubbens
 *       fixTs lyfts in i Homeys klockdomän innan F6 jämför. Se
 *       observeClock() — mekanismen är en NO-OP när klockorna går rätt
 *       och kan bara göra grinden STRÄNGARE, aldrig mer tillåtande.
 */

/**
 * Nytt tomt per-MMSI-fusionsstate.
 * @returns {object}
 */
function createState() {
  return {
    lastFixTs: { aisstream: null, aishub: null },
    lastContent: null, // { scalarKey, lat, lon, ts, feed, fixTs }
    lastFeed: null,
    lastLat: null,
    lastLon: null,
    lastAcceptedTs: null,
    // F6: senast ACCEPTERADE fixtid — tvärs över källorna (den asymmetriska
    // stale-grindens referens). null tills fartyget har en accepterad fix.
    lastAcceptedFixTs: null,
  };
}

/**
 * F6b: nytt tomt KLOCKSTATE (globalt, en per mux — AISHub är EN server med EN
 * klocka, så offseten är inte per fartyg).
 * @returns {object}
 */
function createClockState() {
  return {
    hubLags: [], // {v, at} — now − fixTs (leveransbeviset)
    pairLags: [], // {v, at} — aisstream-mottagning − hub-fixTs (korskällebeviset)
    hubOffsetMs: 0, // ≤ 0: korrigering att ADDERA till hubbens fixTs
    hubAheadSamples: 0, // antal fixar som påstod sig vara nyare än sin leverans
  };
}

/**
 * Glidande fönster: tid FÖRST (en klocka som RÄTTAS ska släppa greppet inom
 * fönstret), hårt tak sedan (rent minnesskydd).
 * @private
 */
function pushClockSample(arr, v, now, cfg) {
  arr.push({ v, at: now });
  const cutoff = now - cfg.CLOCK_OFFSET_WINDOW_MS;
  while (arr.length && (arr[0].at < cutoff || arr.length > cfg.CLOCK_OFFSET_MAX_SAMPLES)) {
    arr.shift();
  }
}

/**
 * F3 + F4a (+ F6b-korrigeringen): normalisera fixTs. Muterar inte msg utom
 * clockSkew-flaggan.
 * @param {object} msg - Normaliserat AIS-meddelande (fixTs, fixFeed …)
 * @param {number} now - Date.now() hos anroparen
 * @param {object} cfg - AIS_CONFIG.FUSION
 * @param {number} [offsetMs] - F6b-korrigering (≤ 0) för den RUTADE källan
 * @returns {number} användbar fixTs (ms)
 */
function normalizeFixTs(msg, now, cfg, offsetMs = 0) {
  const corr = Number.isFinite(offsetMs) ? Math.min(0, offsetMs) : 0;
  let ts = Number.isFinite(msg.fixTs) ? msg.fixTs + corr : now; // F3 + F6b
  if (ts > now + cfg.FUTURE_CLAMP_MS) { // F4a
    ts = now;
    msg.clockSkew = true;
  }
  return ts;
}

/**
 * F2:s innehållsnyckel MINUS positionen (mmsi + fart + kurs). Positionen
 * jämförs numeriskt med epsilon i stället — se contentMatches().
 * @private
 */
function contentScalarKey(msg) {
  return `${msg.mmsi}:${msg.sog}:${msg.cog}`;
}

/**
 * F2:s innehållslikhet: samma fartyg, samma fart/kurs och praktiskt taget
 * samma position.
 *
 * FYND 16 (A/B-natten 2026-08-03): nyckeln band tidigare positionen till en
 * toFixed(5)-RUTA. Två avkodningar av SAMMA fysiska rapport hamnar i olika
 * rutor så fort de ligger på var sin sida om en rutgräns — 42 av 278 bevisade
 * samma-rapport-par (15,1 %) missades så, dvs. var sjätte äkta korskälle-
 * dubblett kunde slinka förbi F2. Positionen jämförs därför på AVSTÅND.
 * CONTENT_MATCH_DIST_M täcker hela den gamla rutans diagonal (~1,3 m), så
 * regeln är en STRIKT UTVIDGNING: allt som fångades förr fångas fortfarande.
 * @private
 */
function contentMatches(prev, msg, cfg) {
  if (!prev || prev.scalarKey !== contentScalarKey(msg)) return false;
  const dist = geometry.calculateDistance(prev.lat, prev.lon, msg.lat, msg.lon);
  return Number.isFinite(dist) && dist <= cfg.CONTENT_MATCH_DIST_M;
}

/**
 * F6b — KLOCKOFFSETKOMPENSATION (granskningsrunda 2, 2026-08-03).
 *
 * PROBLEMET: F6 jämför hubbens fixTs (AISHub-serverns klocka) mot senast
 * accepterade fix, som normalt är aisstreams MOTTAGNINGSstämpel (Homeys
 * klocka). Grindens hela marginal ÄR alltså klockoffseten mellan domänerna.
 * Går hubbens klocka FÖRE Homeys med mer än leveranslatensen ser varje
 * släpande hub-fix färsk ut och F6 slutar fyra — mätt på nattkorpusen med
 * +60 s leveranslagg: +30 s skev ⇒ 26 notiser (231907000|Klaffbron ×3, en
 * MÅLBRO), +60 s ⇒ 31 notiser och sju dubbletter, +300 s ⇒ F4a klampar allt
 * till now och grinden fyrar noll gånger. Den gamla kommentarens påstående
 * att asymmetrin var "klockskevs-säker" gällde bara det MOTSATTA tecknet.
 *
 * TVÅ OBEROENDE BEVIS används, och det STARKASTE (mest negativa) vinner:
 *
 *  A. LEVERANSBEVISET — en äkta fixtid kan aldrig postdatera sin egen
 *     leverans, så lag = now − fixTs är fysiskt ≥ 0 (nattens 1014 hub-fixar:
 *     min 414 ms, median 27,5 s, p90 62,3 s, NOLL negativa). Ett negativt lag
 *     är därför direkt bevis för skev, och fönstrets min(lag) = (minsta
 *     latens − skev). Fungerar från FÖRSTA meddelandet men bara när skeven
 *     överstiger leveranslatensen: en hub som släpar 60 s och samtidigt går
 *     60 s före ser tidsmässigt normal ut mot sin egen leverans.
 *  B. KORSKÄLLEBEVISET — när samma fysiska rapport levereras av BÅDA källorna
 *     (F2:s innehållsmatchning: samma mmsi/fart/kurs och position inom
 *     CONTENT_MATCH_DIST_M) är differensen aisstream-mottagning − hub-fixTs
 *     lika med (aisstreams pushlatens − skev). Nattens 282 sådana par:
 *     median 2,3 s, p5 1,6 s, max 3,6 s — ett anmärkningsvärt tätt kärnvärde
 *     som ÄR pushlatensen. MEDIANEN används, inte minimum: 12 av 282 par
 *     (4 %) är artefakter där en kajliggares två OLIKA rapporter delade
 *     koordinat (min −177 s), och en median tål upp till halva mängden sådan
 *     smuts. Glidande 30-minutersmedian över hela natten: lägsta värde
 *     +2,0 s, dvs. ALDRIG negativ utan skev.
 *
 *     hubOffsetMs = min(0, min(leveranslag), median(korskällepar))
 *
 * adderad till hubbens fixTs lyfter stämpeln in i Homeys klockdomän med ett
 * litet POSITIVT bias (pushlatensen, ~2 s) — inte in i en gissning.
 *
 * VARFÖR DET INTE KAN FLYTTA FACIT: korrigeringen är klampad till ≤ 0, så en
 * frisk klocka ger EXAKT 0 och koden beter sig bit-identiskt. Det gäller per
 * konstruktion för alla 15 låsta fusionskorpusar (makeFusionCorpus sätter
 * ekots aisTimestamp = pollAt + spridning + lagg ≥ fixTs, och ekots innehåll
 * är identiskt med moderfixens ⇒ pardifferensen ≥ 0) och är verifierat på
 * nattkorpusen (leveranslag min +414 ms, glidande parmedian ≥ +2,0 s).
 * Åt andra hållet — hubbens klocka EFTER Homeys — är båda bevisen positiva,
 * korrigeringen 0 och F6 blir strängare: hub-svält, vars värsta utfall är
 * dagens enkälle-beteende. Regimen syns i [FUSION_HEALTH] (hubOffsetMs +
 * hubLagMin) så en skev kan diagnostiseras i stället för att bara krympa
 * accept-andelen.
 *
 * @param {object} clock - klockstate från createClockState()
 * @param {object|null} state - per-MMSI-state (för korskällebeviset)
 * @param {object} msg - meddelandet (rå fixTs, position, sog, cog)
 * @param {string} feed - RUTAD källa ('aisstream' | 'aishub')
 * @param {number} now - Date.now() hos anroparen
 * @param {object} cfg - AIS_CONFIG.FUSION
 */
function observeClock(clock, state, msg, feed, now, cfg) {
  if (!clock || feed !== 'aishub' || !msg || !Number.isFinite(msg.fixTs)) return;
  const lag = now - msg.fixTs;
  if (lag < 0) clock.hubAheadSamples++;
  pushClockSample(clock.hubLags, lag, now, cfg); // bevis A

  // Bevis B: MEDVETET bara riktningen aisstream→aishub. lastContent.fixTs är
  // då aisstreams RÅA mottagningsstämpel; i den omvända riktningen hade den
  // varit en REDAN KORRIGERAD hub-stämpel och skattningen blivit cirkulär
  // (offseten hade dragit sig själv mot noll).
  if (state && state.lastContent
      && state.lastContent.feed === 'aisstream'
      && Number.isFinite(state.lastContent.fixTs)
      && contentMatches(state.lastContent, msg, cfg)) {
    pushClockSample(clock.pairLags, state.lastContent.fixTs - msg.fixTs, now, cfg);
  }

  let bound = 0;
  let minLag = Infinity;
  for (const s of clock.hubLags) if (s.v < minLag) minLag = s.v;
  if (Number.isFinite(minLag)) bound = Math.min(bound, minLag);
  if (clock.pairLags.length >= cfg.CLOCK_PAIR_MIN_SAMPLES) {
    const sorted = clock.pairLags.map((s) => s.v).sort((a, b) => a - b);
    bound = Math.min(bound, sorted[Math.floor(sorted.length / 2)]);
  }
  // Klampad till ≤ 0: kompensationen får BARA ta bort ett bevisat framtids-
  // försprång, aldrig göra en hub-fix färskare än den rå stämpeln påstår.
  clock.hubOffsetMs = Math.min(0, bound);
}

/**
 * F1-F6: ska fixen accepteras in i pipelinen?
 *
 * KÄLLAN KOMMER FRÅN ROUTINGEN, INTE FRÅN NYTTOLASTEN (granskningsrunda 2,
 * 2026-08-03): muxens _onChildMessage(feed, msg) VET vilket barn meddelandet
 * kom från. Tidigare läste den här funktionen msg.fixFeed, och ett tappat
 * fält (fältprov 3-regressionen — projektet har tolv dokumenterade fältlist-
 * offer) hade då tyst avväpnat både F6:s vitlista och F1:s per-källa-hink
 * (state.lastFixTs[undefined]) utan att ett enda test blev rött. ctx.feed är
 * numera sanningen; msg.fixFeed är bara en fallback för direktanropare.
 *
 * @param {object} state - Per-MMSI-state från createState()
 * @param {object} msg - Normaliserat AIS-meddelande
 * @param {number} now - Date.now() hos anroparen
 * @param {object} cfg - AIS_CONFIG.FUSION
 * @param {{feed?: string, hubOffsetMs?: number}} [ctx] - routad källa + F6b-offset
 * @returns {{accept: boolean, reason?: string, fixTs?: number, feedSwitch?: boolean}}
 */
function shouldAccept(state, msg, now, cfg, ctx) {
  const feed = (ctx && ctx.feed) || msg.fixFeed;
  // F6b: korrigeringen gäller ENBART den pollande källan (aisstreams stämpel
  // ÄR Homeys klocka och kan per definition inte ligga fel mot sig själv).
  const offsetMs = (feed === 'aishub' && ctx && Number.isFinite(ctx.hubOffsetMs))
    ? ctx.hubOffsetMs : 0;
  const fixTs = normalizeFixTs(msg, now, cfg, offsetMs);

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
  if (state.lastContent
      && state.lastContent.feed !== feed
      && contentMatches(state.lastContent, msg, cfg)) {
    const withinAcceptWindow = now - state.lastContent.ts < cfg.CROSS_FEED_DEDUP_MS;
    const isEcho = Number.isFinite(state.lastContent.fixTs)
      && Math.abs(fixTs - state.lastContent.fixTs) < (cfg.FIX_ECHO_TOLERANCE_MS ?? 0);
    if (withinAcceptWindow || isEcho) {
      return { accept: false, reason: 'cross_feed_duplicate' };
    }
  }

  // F6: ASYMMETRISK STALE-GRIND (A/B-natten 2026-08-03, fynd 6/V4). En
  // AISHub-fix släpps in ENDAST om dess fixtid är STRIKT NYARE än den senast
  // ACCEPTERADE fixen för fartyget — oavsett vilken källa den kom från.
  //
  // Rotorsaken den löser: F1:s monotoni är PER KÄLLA och F5 flaggar utan att
  // blockera, så en SLÄPANDE pollfix som landade efter en färskare aisstream-
  // fix flyttade fartyget ~200 m BAKÅT och lät det närma sig bron en gång
  // till ⇒ dubbelnotiser. Latenstestet: +30 s gav TIDAN@Klaffbron ×3, +60 s
  // sju dubbletter varav en 152 m EFTER passagen — och nattens egen
  // AISHub-latens hade p90 62 s, dvs. felet låg INOM observerad spridning.
  //
  // ASYMMETRIN ÄR MEDVETEN: aisstream jämförs ALDRIG mot en hub-stämpel — den
  // omvända grinden hade kunnat SVÄLTA huvudkällan vid klockskev. Priset: en
  // hub-fix som är någon sekund nyare än aisstreams senaste mottagning
  // avvisas — den informationen är ändå redan i huset.
  //
  // KLOCKSKEVEN ÄR INTE GRATIS (granskningsrunda 2, 2026-08-03). Jämförelsen
  // går tvärs två klockor, så grindens marginal ÄR offseten mellan dem. Går
  // hubbens klocka FÖRE Homeys upphör grinden att fyra — därför lyfts fixTs
  // först in i Homeys domän av F6b (observeClock) och därför avvisas en
  // fix vars stämpel var så orimlig att F4a fick klampa den: en klampad
  // stämpel är per konstruktion "maximalt färsk" och hade friat ovillkorligt,
  // dvs. grinden hade stängt av sig själv precis när klockan inte går att
  // lita på. Går klockan åt andra hållet (hubben EFTER) blir grinden
  // strängare ⇒ värsta utfall är dagens enkälle-beteende.
  //
  // Grinden är en EXPLICIT VITLISTA på den pollande källan, inte "allt utom
  // aisstream". Källan tas numera från ROUTINGEN (ctx.feed), så ett tappat
  // fixFeed-fält kan inte längre avväpna den tyst; en framtida tredje källa
  // måste läggas till här medvetet.
  if (feed === 'aishub') {
    if (msg.clockSkew === true) {
      return { accept: false, reason: 'hub_clock_skew' };
    }
    if (Number.isFinite(state.lastAcceptedFixTs) && fixTs <= state.lastAcceptedFixTs) {
      return { accept: false, reason: 'stale_cross_fix' };
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
 * @param {string} [routedFeed] - RUTAD källa (samma sanning som shouldAccept)
 */
function applyAccept(state, msg, fixTs, now, routedFeed) {
  const feed = routedFeed || msg.fixFeed;
  state.lastFixTs[feed] = fixTs;
  state.lastContent = {
    scalarKey: contentScalarKey(msg),
    lat: msg.lat,
    lon: msg.lon,
    ts: now,
    feed,
    fixTs,
  };
  state.lastFeed = feed;
  state.lastLat = msg.lat;
  state.lastLon = msg.lon;
  state.lastAcceptedTs = now;
  // F6:s referens. MEDVETET det senast accepterade värdet och inte ett
  // löpande max: efter ett NTP-bakhopp i aisstreams mottagningsstämpel ska
  // grinden följa med ned igen i stället för att låsa ute hubben tills
  // klockan hunnit ikapp (samma självläkning som F1 har för receipt-källan).
  state.lastAcceptedFixTs = fixTs;
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
  // Hårt tak med ÄKTA LRU (fynd 15, A/B-natten 2026-08-03): Map-ordningen är
  // INSÄTTNINGSORDNING, så keys().next() slängde det fartyg som spårats
  // LÄNGST — ofta det mest aktiva, medan en nyss insatt kajliggare fick
  // ligga kvar. Evictera i stället på senast accepterade fix (äldst först).
  // Sorteringen är stabil (V8/ES2019) ⇒ lika lastAcceptedTs faller tillbaka
  // på insättningsordning, exakt som förr.
  if (stateMap.size > cfg.STATE_MAX_ENTRIES) {
    const byAge = [...stateMap.entries()]
      .sort((a, b) => (a[1].lastAcceptedTs || 0) - (b[1].lastAcceptedTs || 0));
    let over = stateMap.size - cfg.STATE_MAX_ENTRIES;
    for (const [mmsi] of byAge) {
      if (over <= 0) break;
      stateMap.delete(mmsi);
      removed++;
      over--;
    }
  }
  return removed;
}

module.exports = {
  createState,
  createClockState,
  observeClock,
  normalizeFixTs,
  shouldAccept,
  applyAccept,
  pruneStates,
};
