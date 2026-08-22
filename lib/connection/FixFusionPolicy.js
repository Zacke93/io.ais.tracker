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
    // A12/F-22: par som föll på samma-rapport-grinden (kajliggarartefakter).
    // Räknas för att grinden ska vara MÄTBAR i fält — noll här betyder
    // "inga artefakter", inte "grinden finns inte".
    pairsDroppedStale: 0,
  };
}

/**
 * A12 (F-22, fältprovet 2026-08-08) — SAMMA-RAPPORT-GRIND på korskällebeviset.
 *
 * Skuggmätaren har grinden sedan fältprov 2 (AIS_CONFIG.SHADOW.PAIR_MAX_SKEW_MS);
 * F6b:s parskattning saknade den. Värdet är MEDVETET samma 90 s: bägge mäter
 * exakt samma storhet (aisstream-mottagning − hub-fixTs) på exakt samma
 * innehållsmatchning, och två olika gränser för samma fysik hade garanterat
 * drivit isär.
 *
 * Konstanten bor här och inte i AIS_CONFIG.FUSION eftersom etapp 7 fas A kör
 * med filägarskap (lib/constants.js ägs av ett annat spår). cfg-värdet vinner
 * om det någon gång flyttas dit — då räcker det att radera den här raden.
 * @private
 */
const CLOCK_PAIR_MAX_SKEW_MS = 90 * 1000;

/**
 * H24 (helkodsgranskning runda 1, 2026-08-22) — MINIMIURVAL OCH KORROBORERING
 * FÖR BEVIS A.
 *
 * Bevis A skattades förut som REN MIN över hela fönstret: inget minimiurval,
 * ingen per-MMSI-korroborering, ingen magnitudklamp. EN enda framtidsdaterad
 * hubbpost (bruten transponder eller fel epok — AISHubClient släpper medvetet
 * igenom poster som ligger framåt) satte därför den GLOBALA offseten till
 * hela sitt eget försprång, och eftersom offseten ÅLDRAR varje hub-fix innan
 * F4b prövar den blev följden HUBBLACKOUT: reproducerat genom hela muxen —
 * en post 700 s framåt gav NOLL accepterade hubbfixar på 30 minuter medan
 * aisstream var nere (utan giftposten: 22 accepterade, den första efter
 * 130 s). Bevis B fick exakt den här härdningen redan i A12/F-22 (median plus
 * minimiurval); bevis A fick ingenting — samma systerställe-asymmetri som
 * granskningen fann på sex andra ställen i appen.
 *
 * KRAVET ÄR KORROBORERING, INTE STRÄNGHET: en ÄKTA serverskev gör ALLA poster
 * negativa (varje fartyg, varje poll), en trasig sändare bara sina egna.
 * Skattningen tas därför PER MMSI (fartygets minsta lagg i fönstret = dess
 * minsta leveranslatens − skeven) och sedan som MEDIAN ÖVER FARTYGEN.
 *
 * VARFÖR MEDIAN AV PER-FARTYGS-MINIMUM och inte median av alla sampel:
 * bevisets storhet ÄR (minsta leveranslatens − skev), och latensen varierar
 * med pollfasen (nattens 1014 hub-fixar: min 414 ms, median 27,5 s, p90
 * 62,3 s). En median över RÅA sampel hade underskattat skeven med hela
 * medianlatensen (~27 s) och gjort bevis A trubbigt; per-fartygs-minimum
 * bevarar min-semantiken, och medianen tas bara TVÄRS fartygen där den enda
 * variationen är vilken pollfas respektive fartyg råkade träffa.
 *
 * VARFÖR 3: medianen (övre vid jämnt antal) tål floor(n/2) förgiftade
 * sändare, så redan n = 2 skulle stå emot EN — men då vilar hela skattningen
 * på ETT friskt fartyg. Vid n = 3 måste minst två fartyg vara överens om att
 * klockan ligger före (medianvärdet har ett fartyg på var sida), vilket ÄR
 * den korroborering granskningen kräver. Priset är att en NY skev är
 * okompenserad tills tre fartyg setts i fönstret; nattens takt var ~7 fartyg
 * per poll och fönstret rymmer ~28 pollar, så villkoret är i praktiken
 * uppfyllt redan i den första pollen. cfg-värdet vinner om konstanten någon
 * gång flyttas till AIS_CONFIG.FUSION (lib/constants.js ägs av ett annat
 * spår — samma villkor som CLOCK_PAIR_MAX_SKEW_MS ovan).
 * @private
 */
const CLOCK_LAG_MIN_VESSELS = 3;

/**
 * J5 (helkodsgranskning runda 2, 2026-08-22) — MARGINALEN I DET TUNNA
 * URVALETS RÄDDNINGSKOMPENSATION.
 *
 * H24 lät minimiurvalet styra bevis A:s EXISTENS: under CLOCK_LAG_MIN_VESSELS
 * distinkta MMSI avstod skattningen helt och hubOffsetMs blev 0. Bevis B kan
 * inte täcka upp (pairLags fylls bara i riktningen aisstream→aishub och är
 * tom när aisstream är nere), så en hubbklocka mer än FUTURE_CLAMP_MS före
 * gav F4a-klamp ⇒ hub_clock_skew på VARJE hubbfix — total blackout, samma
 * failover-tystnad H24 skrevs för att stoppa, via en annan grind. Fältmätt
 * på 1,7-2,7 % av pollarna (< 3 MMSI i fönstret), längsta sammanhängande
 * period 25-37 min, även mitt på dagen.
 *
 * MINIMIURVALET STYR NUMERA STORLEKEN, INTE EXISTENSEN — men det tunna
 * urvalets kompensation är MEDVETET inte en klockrättning utan en RÄDDNING
 * av exakt en grind:
 *
 *  • Under FUTURE_CLAMP_MS används den INTE ALLS. Ligger den okorroborerade
 *    skattningen inom klampfönstret finns ingen grind att rädda från, och då
 *    står H24:s regel kvar orörd: EN framtidsdaterad post är inget skevbevis.
 *  • Över FUTURE_CLAMP_MS används den, men magnituden kapas vid
 *    FUTURE_CLAMP_MS + den här marginalen. Taket måste ligga STRIKT ÖVER
 *    FUTURE_CLAMP_MS för att göra någon nytta alls: en korrigering på exakt
 *    klampgränsen flyttar bara stämpeln till gränsen, och F4a fyrar igen.
 *  • Marginalen är ETT leveranslaggsteg. Nattens 1014 hubbfixar hade median
 *    27,5 s, p90 62,3 s och max 220,9 s; 30 s är medianen avrundad uppåt och
 *    alltså MEDVETET under p90. En okorroborerad skattning ska täcka den
 *    TYPISKA leveranslaggen, inte svansen — svansen (och varje större skev)
 *    fångas i stället av korroboreringen så fort ett tredje fartyg syns,
 *    vilket vid nattens takt (~7 fartyg per poll) sker redan i nästa poll.
 *
 * SKADEGRÄNSEN: 120 + 30 = 150 s mot F4b:s budget MAX_FIX_AGE_MS (720 s)
 * lämnar 570 s åt den ÄKTA leveranslaggen, vars värsta observerade värde är
 * 220,9 s — 2,6× marginal. EN förgiftad sändare kan alltså aldrig återskapa
 * H24:s blackout, och den kan inte heller smyga förbi skevgrinden: J4:s
 * artefaktundantag gäller ENBART det fulla (korroborerade) taket, aldrig det
 * här. cfg-värdet vinner om konstanten någon gång flyttas till
 * AIS_CONFIG.FUSION (samma villkor som CLOCK_PAIR_MAX_SKEW_MS ovan).
 * @private
 */
const CLOCK_THIN_SAMPLE_MARGIN_MS = 30 * 1000;

/**
 * Glidande fönster: tid FÖRST (en klocka som RÄTTAS ska släppa greppet inom
 * fönstret), hårt tak sedan (rent minnesskydd).
 *
 * L21 (helkodsgranskning runda 3, 2026-08-22) — ÅLDRANDET ÄR UTBRUTET HIT.
 * OBS (granskning 3): prunen körs efter observeClocks tidiga retur, dvs. på
 * HUBBMEDDELANDEN — tystnar båda källorna står hubOffsetMs kvar tills första
 * nya hubbmeddelandet (ofarligt: ingen hubbfix prövas då). Muxens hälsorapport
 * läser hubLags OFILTRERAT och kan visa sampel utanför fönstret.
 * Prunen satt förut BARA i pushClockSample, alltså bara på det som PUSHAS.
 * hubLags självprunar därför per hubbmeddelande, men pairLags pushas enbart
 * när ett korskällepar faktiskt bildas — vilket kräver att aisstream
 * levererar. Stannar parbildningen fryser fönstret fast: reproducerat genom
 * hela muxen med 12 par à −60 s ⇒ hubOffsetMs −60 000; tre timmar senare med
 * aisstream nere hade hubLags prunat till 1 friskt sampel medan pairLags
 * hade kvar alla 12 (äldsta 180 min, SEX gånger fönstret) och offseten stod
 * kvar. observeClock anropar därför hjälparen för BÅDA fönstren innan
 * skattningen — se anropsstället för vad den frysningen kostade.
 * @private
 */
function pruneClockSamples(arr, now, cfg) {
  const cutoff = now - cfg.CLOCK_OFFSET_WINDOW_MS;
  while (arr.length && (arr[0].at < cutoff || arr.length > cfg.CLOCK_OFFSET_MAX_SAMPLES)) {
    arr.shift();
  }
}

/** @private */
function pushClockSample(arr, v, now, cfg, mmsi = null) {
  // H24: hubLags bär AVSÄNDAREN så bevis A kan korroborera över fartyg.
  // pairLags skickar ingen (fältet blir null) — parbeviset korroboreras redan
  // av sitt minimiurval, och en andra nyckel där hade bara varit brus.
  arr.push({ v, at: now, mmsi });
  pruneClockSamples(arr, now, cfg);
}

/**
 * F3 + F4a (+ F6b-korrigeringen) UTAN sidoeffekt (A4): samma räkning som
 * normalizeFixTs, men klampningen rapporteras i returvärdet i stället för att
 * skrivas på msg. EN källa till sanningen för båda ingångarna.
 * @private
 * @returns {{fixTs: number, clamped: boolean}}
 */
function normalizeFixTsPure(msg, now, cfg, offsetMs = 0) {
  const corr = Number.isFinite(offsetMs) ? Math.min(0, offsetMs) : 0;
  const ts = Number.isFinite(msg.fixTs) ? msg.fixTs + corr : now; // F3 + F6b
  if (ts > now + cfg.FUTURE_CLAMP_MS) { // F4a
    return { fixTs: now, clamped: true };
  }
  return { fixTs: ts, clamped: false };
}

/**
 * F3 + F4a (+ F6b-korrigeringen): normalisera fixTs. Muterar inte msg utom
 * clockSkew-flaggan.
 *
 * ENDA KVARVARANDE ANROPAREN ÄR TESTSVITEN (granskningen av runda 2): J4
 * flyttade beslutsvägen till normalizeFixTsPure ovan, som behåller
 * klamputfallet i returen. Wrappern står kvar som den EXPORTERADE
 * kontraktsytan för F3/F4a (tests/fix-fusion-policy-unit.test.js låser den)
 * — den är inte död kod utan modulens dokumenterade sidoeffektsvariant, och
 * behålls medvetet så att en framtida anropare inte återuppfinner den.
 * @param {object} msg - Normaliserat AIS-meddelande (fixTs, fixFeed …)
 * @param {number} now - Date.now() hos anroparen
 * @param {object} cfg - AIS_CONFIG.FUSION
 * @param {number} [offsetMs] - F6b-korrigering (≤ 0) för den RUTADE källan
 * @returns {number} användbar fixTs (ms)
 */
function normalizeFixTs(msg, now, cfg, offsetMs = 0) {
  const { fixTs, clamped } = normalizeFixTsPure(msg, now, cfg, offsetMs);
  if (clamped) msg.clockSkew = true;
  return fixTs;
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
 * H24 — bevis A:s robusta skattning: per-MMSI-minimum, sedan MEDIAN över
 * fartygen. J5 (runda 2): minimiurvalet returnerar inte längre null utan
 * rapporteras som ett KORROBORERINGSBESKED, så anroparen kan låta urvalet
 * styra kompensationens STORLEK i stället för dess existens (se
 * CLOCK_THIN_SAMPLE_MARGIN_MS för varför "ingen kompensation alls" var en
 * väg till hubblackout). null betyder numera BARA "fönstret är tomt".
 * @private
 * @param {Array<{v: number, mmsi: string|null}>} hubLags
 * @param {object} cfg - AIS_CONFIG.FUSION
 * @returns {{value: number, corroborated: boolean}|null}
 */
function estimateHubLagBound(hubLags, cfg) {
  const minVessels = Number.isFinite(cfg.CLOCK_LAG_MIN_VESSELS)
    ? cfg.CLOCK_LAG_MIN_VESSELS : CLOCK_LAG_MIN_VESSELS;
  const perVessel = new Map();
  for (const s of hubLags) {
    // Saknad mmsi hamnar i EN gemensam hink: en avsändarlös post får aldrig
    // se ut som flera fartyg och korroborera sig själv.
    const key = s.mmsi == null ? '?' : s.mmsi;
    const prev = perVessel.get(key);
    if (prev === undefined || s.v < prev) perVessel.set(key, s.v);
  }
  if (perVessel.size === 0) return null;
  const mins = Array.from(perVessel.values()).sort((a, b) => a - b);
  return {
    value: mins[Math.floor(mins.length / 2)],
    corroborated: perVessel.size >= minVessels,
  };
}

/**
 * H24 — HÅRD MAGNITUDKLAMP (skyddsnät UNDER F4b).
 *
 * Offseten åldrar varje hub-fix med |offset| innan F4b:s åldersgrind prövar
 * den. Når magnituden MAX_FIX_AGE_MS avvisas därför VARJE hub-fix som
 * fix_too_old hur färsk den än är — total hubblackout, och just den
 * failover-tystnaden är fusionens värsta utfall. Halva åldersbudgeten
 * reserveras därför åt den ÄKTA leveranslatensen: nattens 1014 hub-fixar
 * hade median 27,5 s, p90 62,3 s och max 220,9 s, så 360 s lämnar 1,6×
 * marginal även mot det värsta observerade.
 *
 * En äkta skev STÖRRE än taket kompenseras bara delvis: F6 blir då lika
 * tillåtande som före F6b (värsta utfall en dubbelnotis) — aldrig blind, och
 * hubben fortsätter flöda. Medvetet byte: hellre det gamla enkälle-felet än
 * en tyst dödad källa. Klampen syns i [FUSION_HEALTH] genom att hubOffsetMs
 * står EXAKT på taket. Saknas MAX_FIX_AGE_MS i cfg klampas inget alls
 * (Infinity) — en trasig konfiguration får inte i sig strypa kompensationen.
 *
 * J4 (helkodsgranskning runda 2, 2026-08-22): LÖFTET OVAN VAR FALSKT ÄNDA
 * TILLS NU. Restskeven som taket lämnade kvar klampades av F4a, F4a satte
 * clockSkew, och F6:s skevgrind avvisade därför VARJE hubbfix i bandet
 * ca 480-720 s skev (under 480 s räcker kompensationen, över 720 s stoppar
 * AISHubClients futureJunk-grind posten redan vid ingressen). Taket var
 * alltså inte ett skyddsnät utan ett dödband — precis den hubblackout H24
 * skrevs för att stoppa, via en annan grind. Undantaget som stänger det
 * ligger i offsetStandsAtMaxMagnitude() nedan.
 * @private
 * @param {object} cfg - AIS_CONFIG.FUSION
 * @returns {number} maximal |hubOffsetMs|
 */
function clockOffsetMaxMagnitude(cfg) {
  return Number.isFinite(cfg.MAX_FIX_AGE_MS) ? Math.floor(cfg.MAX_FIX_AGE_MS / 2) : Infinity;
}

/**
 * J5 — magnitudtaket för det TUNNA (okorroborerade) urvalets
 * räddningskompensation. Alltid <= det fulla taket, så de två regimerna kan
 * skiljas åt på offsetens värde ensamt (se offsetStandsAtMaxMagnitude).
 * @private
 * @param {object} cfg - AIS_CONFIG.FUSION
 * @returns {number} maximal |hubOffsetMs| vid tunt urval
 */
function thinSampleMaxMagnitude(cfg) {
  const margin = Number.isFinite(cfg.CLOCK_THIN_SAMPLE_MARGIN_MS)
    ? cfg.CLOCK_THIN_SAMPLE_MARGIN_MS : CLOCK_THIN_SAMPLE_MARGIN_MS;
  const clamp = Number.isFinite(cfg.FUTURE_CLAMP_MS) ? cfg.FUTURE_CLAMP_MS : 0;
  return Math.min(clockOffsetMaxMagnitude(cfg), clamp + margin);
}

/**
 * J4 — STÅR OFFSETEN EXAKT PÅ DET FULLA MAGNITUDTAKET?
 *
 * Predikatet är hela artefaktundantagets bevisföring, och det vilar på att
 * de två regimerna har OLIKA tak: det tunna urvalets tak är per konstruktion
 * <= det fulla (thinSampleMaxMagnitude klampar mot det), och de sammanfaller
 * bara i en konfiguration där FUTURE_CLAMP_MS + marginalen >= MAX_FIX_AGE_MS/2
 * — dvs. aldrig i den här appen (150 s mot 360 s).
 *
 * VAD ETT UTSLAG BETYDER — PRECIST (granskningen av runda 2, 2026-08-22; den
 * tidigare formuleringen "entydigt korroborerad av minst
 * CLOCK_LAG_MIN_VESSELS fartyg" var FEL och kunde vilseleda nästa läsare om
 * undantagets räckvidd): att offseten står exakt på -MAX_FIX_AGE_MS/2 betyder
 * att NÅGON AV DE TVÅ KORROBORERADE BEVISVÄGARNA drev skattningen förbi
 * taket —
 *   • bevis A bakom sitt minimiurval CLOCK_LAG_MIN_VESSELS (medianen över
 *     fartygens minsta leveranslagg), eller
 *   • bevis B bakom sitt minimiurval CLOCK_PAIR_MIN_SAMPLES (medianen över
 *     korskälleparen), som går rakt in i bound utan att passera det tunna
 *     taket.
 * Det TUNNA urvalet kan per konstruktion ALDRIG nå dit: dess bidrag klampas
 * av thinSampleMaxMagnitude, som är strikt mindre. Det är den skillnaden —
 * inte att bevis A skulle vara enda vägen — som gör predikatet till ett
 * giltigt bevis, och båda de kvarvarande vägarna bär sitt eget minimiurval.
 *
 * MED DAGENS KONSTANTER är det ändå alltid bevis A som når taket: B:s sampel
 * passerar samma-rapport-grinden CLOCK_PAIR_MAX_SKEW_MS (90 s) innan de läggs
 * i pairLags, så B:s median ligger i [-90 s, +90 s] och kan inte ensam nå
 * 360 s. Predikatets korrekthet vilar dock INTE på den siffran: höjs
 * pargrinden bär B taket lika gärna, och undantaget är då fortfarande rätt.
 * Det är KORROBORERINGEN, inte vilket bevis som gav den, som gör klampen till
 * en artefakt av vårt eget skyddsnät. (Låst i
 * tests/j4j5-klockskev-dodband.test.js — både tunt-tak-svepet och
 * B-når-taket-fallet.)
 *
 * Fyrar F4a när predikatet är sant är klampen alltså takets eget verk, inte
 * ett bevis för att stämpeln är opålitlig, och att avvisa på den grunden vore
 * att låta skyddsnätet döda källan.
 *
 * VARFÖR UNDANTAGET INTE GÄLLER DET TUNNA TAKET: där vilar skattningen på
 * FÄRRE än CLOCK_LAG_MIN_VESSELS fartyg och kan alltså vara EN trasig
 * sändare. H24:s testfall — en ensam post 700 s framåt — ska fortsätta fällas
 * av skevgrinden, och görs det just för att dess offset står på det TUNNA
 * taket. Priset är ett kvarvarande dödband: skev över ungefär
 * (tunna taket + FUTURE_CLAMP_MS + leveranslagg) ~ 270 s SAMTIDIGT med
 * färre än tre fartyg i 30-minutersfönstret ger fortsatt hub_clock_skew.
 * Det är medvetet — konjunktionen kräver både en extrem skev och tunn
 * trafik, och den upplöses så fort ett tredje fartyg syns (nattens takt:
 * ~7 fartyg per poll).
 * @private
 * @param {number} offsetMs - F6b-korrigeringen som gällde för beslutet
 * @param {object} cfg - AIS_CONFIG.FUSION
 * @returns {boolean}
 */
function offsetStandsAtMaxMagnitude(offsetMs, cfg) {
  const cap = clockOffsetMaxMagnitude(cfg);
  return Number.isFinite(cap) && offsetMs === -cap;
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
 *     H24 (2026-08-22): minimum tas numera PER MMSI och skattningen som
 *     MEDIAN över fartygen (CLOCK_LAG_MIN_VESSELS) — en ensam
 *     framtidsdaterad post är inte längre ett skevbevis, bara ett
 *     hubAheadSamples-utslag. Se konstantens docblock för härledningen.
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
 *     A12/F-22 (2026-08-08): medianens smutstålighet räckte inte som ENDA
 *     skydd — på både-dygn 1 var 19,3 % av paren artefakter och den värsta
 *     30-minutersandelen 40,0 % mot brytpunkten 50 %. Artefakterna filtreras
 *     numera bort FÖRE medianen av samma-rapport-grinden nedan
 *     (CLOCK_PAIR_MAX_SKEW_MS), så medianens marginal är intakt igen.
 *
 *     hubOffsetMs = klampa(min(0, medianFartyg(min leveranslag),
 *                            median(korskällepar)), CLOCK_OFFSET_MAX_MAGNITUDE)
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

  // L21 (helkodsgranskning runda 3, 2026-08-22) — ÅLDRA BÅDA FÖNSTREN FÖRE
  // SKATTNINGEN, inte bara det som råkar pushas i det här anropet.
  //
  // FELET: pruningen låg bara i pushClockSample. hubLags pushas per
  // hubbmeddelande och självprunade därför, men pairLags pushas ENBART när
  // ett korskällepar bildas — vilket kräver att aisstream levererar. När
  // aisstream tystnar (fältläget sedan serverdöden ~2026-08-05) frös alltså
  // pairLags-fönstret fast, och en NEGATIV parmedian fortsatte styra
  // hubOffsetMs långt utanför CLOCK_OFFSET_WINDOW_MS. Fyra dokumenterade
  // löften motsades: pushClockSamples eget docblock ("tid FÖRST"),
  // lib/constants.js (en NTP-rättning ska släppa greppet inom en halvtimme),
  // ARCHITECTURE ("återhämtningsbar") och J5:s docblock ("pairLags är tom när
  // aisstream är nere").
  //
  // UPPMÄTT SKADA AV FRYSNINGEN: en laglig 700 s gammal hubbfix avvisades
  // fix_too_old (AISHubClient har ingen bakåtåldersgrind vid ingressen),
  // varje hubbfix emitterades backdaterad 60 s, och
  // BridgeOpeningService._refreshArm ankrade öppningsdeadlinen upp till 90 s
  // för tidigt.
  //
  // SEMANTISKT NEUTRALT NÄR PAR BILDAS NORMALT: pruningen är idempotent och
  // körs med SAMMA `now` som pushen strax nedan, så prune→push→prune ger
  // exakt samma fönster som push→prune. Det enda som ändras är att fönstret
  // också åldras de anrop där ingen push sker.
  pruneClockSamples(clock.hubLags, now, cfg);
  pruneClockSamples(clock.pairLags, now, cfg);

  const lag = now - msg.fixTs;
  if (lag < 0) clock.hubAheadSamples++;
  // H24: avsändaren följer med — bevis A korroboreras över fartyg.
  pushClockSample(clock.hubLags, lag, now, cfg,
    msg.mmsi == null ? null : String(msg.mmsi)); // bevis A

  // Bevis B: MEDVETET bara riktningen aisstream→aishub. lastContent.fixTs är
  // då aisstreams RÅA mottagningsstämpel; i den omvända riktningen hade den
  // varit en REDAN KORRIGERAD hub-stämpel och skattningen blivit cirkulär
  // (offseten hade dragit sig själv mot noll).
  if (state && state.lastContent
      && state.lastContent.feed === 'aisstream'
      && Number.isFinite(state.lastContent.fixTs)
      && contentMatches(state.lastContent, msg, cfg)) {
    const pairLag = state.lastContent.fixTs - msg.fixTs;
    // A12/F-22: SAMMA-RAPPORT-BEVIS. Innehållsmatchningen ensam räcker inte —
    // en kajliggare återvänder till samma koordinat med samma fart och kurs
    // rapport efter rapport, så paret kan vara TVÅ OLIKA fysiska rapporter.
    // Mätt på både-dygn 1: 113 av 586 par (19,3 %) var sådana artefakter och
    // SAMTLIGA negativa — precis den riktning som gör kompensationen större
    // och kan SVÄLTA hubben. Marginalen var 1,25×, inte 2,6×: medianen tas
    // över det LEVANDE 30-minutersfönstret och högsta observerade
    // artefaktandel i ett fönster var 40,0 % mot brytpunkten 50 %. Värsta
    // utfall är inte fördröjd failover utan TOTAL hubblackout — vid
    // |hubOffsetMs| > MAX_FIX_AGE_MS avvisas varje hub-fix som fix_too_old.
    //
    // GRINDEN KAN INTE BLINDA F6b FÖR EN ÄKTA SKEV: ett äkta par har
    // |pairLag| = |pushlatens − skev| (pushlatensen mättes till 1,6–3,6 s),
    // så grinden kan först falla ut när skeven själv närmar sig 90 s. I exakt
    // det området bär LEVERANSBEVISET (A) hela skattningen — min(now − fixTs)
    // = (minsta leveranslatens − skev), och minsta latensen i ett
    // 30-minutersfönster var 414 ms (p10 3,9 s). Vid 90 s skev ger A ≈ −86 s
    // mot parbevisets ≈ −88 s: bevisen överlappar där grinden biter.
    const maxSkew = Number.isFinite(cfg.CLOCK_PAIR_MAX_SKEW_MS)
      ? cfg.CLOCK_PAIR_MAX_SKEW_MS : CLOCK_PAIR_MAX_SKEW_MS;
    if (Math.abs(pairLag) <= maxSkew) {
      pushClockSample(clock.pairLags, pairLag, now, cfg);
    } else {
      clock.pairsDroppedStale = (clock.pairsDroppedStale || 0) + 1;
    }
  }

  let bound = 0;
  // H24: bevis A skattas robust (per-MMSI-minimum → median över fartygen,
  // bakom minimiurval) i stället för som ren min över fönstret. En ensam
  // framtidsdaterad post kan därför inte längre sätta den GLOBALA offseten
  // och svälta hubben vid failover.
  //
  // J5 (runda 2): minimiurvalet styr numera STORLEKEN, inte existensen.
  //  • KORROBORERAT urval (>= CLOCK_LAG_MIN_VESSELS fartyg): skattningen
  //    används rakt av, klampad bara av det fulla magnitudtaket nedan.
  //  • TUNT urval: skattningen används ENBART som räddning av F4a, dvs.
  //    först när den är mer negativ än FUTURE_CLAMP_MS (annars finns ingen
  //    grind att rädda från och H24:s regel står orörd), och då med det
  //    snävare taket. Se CLOCK_THIN_SAMPLE_MARGIN_MS för härledningen.
  const lagEst = estimateHubLagBound(clock.hubLags, cfg); // bevis A
  if (lagEst !== null) {
    if (lagEst.corroborated) {
      bound = Math.min(bound, lagEst.value);
    } else {
      const rescueThreshold = Number.isFinite(cfg.FUTURE_CLAMP_MS)
        ? -cfg.FUTURE_CLAMP_MS : -Infinity;
      if (lagEst.value < rescueThreshold) {
        bound = Math.min(bound, Math.max(-thinSampleMaxMagnitude(cfg), lagEst.value));
      }
    }
  }
  if (clock.pairLags.length >= cfg.CLOCK_PAIR_MIN_SAMPLES) {
    const sorted = clock.pairLags.map((s) => s.v).sort((a, b) => a - b);
    bound = Math.min(bound, sorted[Math.floor(sorted.length / 2)]);
  }
  // Klampad till ≤ 0: kompensationen får BARA ta bort ett bevisat framtids-
  // försprång, aldrig göra en hub-fix färskare än den rå stämpeln påstår.
  // H24: och nedåt till ett magnitudtak, så ingen skattning — hur den än
  // uppstått — kan åldra bort hela hubbkällan (se clockOffsetMaxMagnitude).
  clock.hubOffsetMs = Math.max(-clockOffsetMaxMagnitude(cfg), Math.min(0, bound));

  // J4 HAR MEDVETET INGEN RÄKNARE HÄR (granskningen av runda 2, 2026-08-22).
  // Fixen bar först clock.clockSkewCapBypasses, tickad på exakt det här
  // stället. Den SKREVS men LÄSTES aldrig: både [FUSION_HEALTH]-raden och
  // getConnectionStats() bor i AISSourceMultiplexer, och ingen av dem
  // renderade fältet — alltså samma klass av död mätning som J22 (ett mätt
  // villkor ingen frågar efter) i samma runda. Den är borttagen i stället för
  // att stå kvar och se verifierad ut.
  //
  // OBSERVERBARHETEN I DAG: verdiktfältet clockSkewCapBypass är en TESTKROK
  // (granskning 2c: muxen läser bara accept/reason/fixTs/feedSwitch ur
  // verdiktet, så fältet har noll produktionskonsumenter). I fält ses
  // undantaget INDIREKT på att [FUSION_HEALTH]
  // samtidigt visar hubOffsetMs EXAKT på -MAX_FIX_AGE_MS/2 och
  // byReason.hub_clock_skew nära noll medan hubbfixar fortsätter accepteras.
  // Vill man ha den skarpa livstidsräknaren krävs TVÅ rader i muxen (en i
  // klockstatet här, en i renderingen där hubAheadSamples och
  // hubPairsDroppedStale redan står) — de hör ihop och ska landa i samma
  // ändring, inte var för sig.
}

/**
 * GRINDPREDIKATEN (A4, etapp 7). Utbrutna så att shouldAccept() och
 * classifyAll() prövar EXAKT samma villkor — två kopior av samma regel hade
 * garanterat drivit isär (projektets fältlist-fälla i annan form), och
 * classifyAll ska kunna läsas som "vad hade de ÖVRIGA grindarna sagt?".
 * Predikaten är rena: de läser state/msg, skriver ingenting.
 * @private
 */
function violatesMaxAge(fixTs, now, cfg) { // F4b
  return now - fixTs > cfg.MAX_FIX_AGE_MS;
}

/** @private */
function violatesMonotonic(state, msg, feed, fixTs) { // F1
  if (msg.fixTsQuality !== 'true-fix') return false;
  const prev = state.lastFixTs[feed];
  return prev != null && fixTs <= prev;
}

/** @private */
function violatesCrossFeedContent(state, msg, feed, fixTs, now, cfg) { // F2 + F2b
  if (!state.lastContent
      || state.lastContent.feed === feed
      || !contentMatches(state.lastContent, msg, cfg)) {
    return false;
  }
  const withinAcceptWindow = now - state.lastContent.ts < cfg.CROSS_FEED_DEDUP_MS;
  const isEcho = Number.isFinite(state.lastContent.fixTs)
    && Math.abs(fixTs - state.lastContent.fixTs) < (cfg.FIX_ECHO_TOLERANCE_MS ?? 0);
  return withinAcceptWindow || isEcho;
}

/** @private */
function violatesStaleCross(state, fixTs) { // F6 (endast den pollande källan)
  return Number.isFinite(state.lastAcceptedFixTs) && fixTs <= state.lastAcceptedFixTs;
}

/**
 * A4 (etapp 7, fas A) — HELA avslagsprofilen, utan sidoeffekter.
 *
 * shouldAccept() returnerar på FÖRSTA regel som avvisar (F4b→F1→F2→F6), så
 * _fusionStats.byReason mäter "vilken grind hann först", inte "vilka grindar
 * höll". Skillnaden är avgörande vid felsökning av en svält: en hubklocka som
 * gått isär yttrar sig som fix_too_old på ALLT, och att stale_cross_fix
 * samtidigt hade fyrat på 100 % av samma meddelanden är det som skiljer
 * "källan levererar gammalt" från "vår klockskattning har spårat ur".
 *
 * SIDOEFFEKTSFRI PÅ RIKTIGT: normalizeFixTsPure skriver ingen clockSkew-flagga
 * på msg (den vägen ägs av shouldAccept), och inget state muteras. Funktionen
 * kan därför köras EFTER shouldAccept på samma meddelande utan att flytta ett
 * enda beslut.
 *
 * INVARIANT: accept === true ⇔ shouldAccept accepterar. Muxen räknar därför
 * byReasonAll enbart i reject-grenen — en accepterad fix har per konstruktion
 * tom reasons-lista.
 *
 * @param {object} state - Per-MMSI-state från createState()
 * @param {object} msg - Normaliserat AIS-meddelande
 * @param {number} now - Date.now() hos anroparen
 * @param {object} cfg - AIS_CONFIG.FUSION
 * @param {{feed?: string, hubOffsetMs?: number}} [ctx] - routad källa + F6b-offset
 * @returns {{accept: boolean, reasons: string[], fixTs: number}}
 */
function classifyAll(state, msg, now, cfg, ctx) {
  const feed = (ctx && ctx.feed) || msg.fixFeed;
  const offsetMs = (feed === 'aishub' && ctx && Number.isFinite(ctx.hubOffsetMs))
    ? ctx.hubOffsetMs : 0;
  const { fixTs, clamped } = normalizeFixTsPure(msg, now, cfg, offsetMs);
  // Samma sanning som shouldAccept ser: flaggan kan vara satt av parsern ELLER
  // av F4a-klampen i den här normaliseringen.
  const clockSkew = clamped || msg.clockSkew === true;
  // J4: artefaktundantaget MÅSTE prövas här också. Bryts symmetrin bryts
  // invarianten "accept === true ⇔ shouldAccept accepterar", och muxens
  // byReasonAll skulle räkna en grind som aldrig fällde beslutet.
  const capArtifact = clamped && offsetStandsAtMaxMagnitude(offsetMs, cfg);

  const reasons = [];
  if (violatesMaxAge(fixTs, now, cfg)) reasons.push('fix_too_old');
  if (violatesMonotonic(state, msg, feed, fixTs)) reasons.push('stale_or_duplicate_fix');
  if (violatesCrossFeedContent(state, msg, feed, fixTs, now, cfg)) reasons.push('cross_feed_duplicate');
  if (feed === 'aishub') {
    if (clockSkew && !capArtifact) reasons.push('hub_clock_skew');
    if (violatesStaleCross(state, fixTs)) reasons.push('stale_cross_fix');
  }
  return { accept: reasons.length === 0, reasons, fixTs };
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
  // Samma räkning som normalizeFixTs, men klamputfallet behålls: J4:s
  // artefaktundantag måste kunna skilja "F4a fyrade" från "flaggan var redan
  // satt". Sidoeffekten (msg.clockSkew) är oförändrad — den ägs fortfarande
  // av den här vägen och aldrig av classifyAll.
  const { fixTs, clamped } = normalizeFixTsPure(msg, now, cfg, offsetMs);
  if (clamped) msg.clockSkew = true; // F4a

  // F4b: enda hårda åldersgrinden.
  if (violatesMaxAge(fixTs, now, cfg)) {
    return { accept: false, reason: 'fix_too_old' };
  }

  // F1: monoton spärr PER KÄLLA — aldrig korskälla (domänrenhet), och
  // ENDAST för äkta fixtider ('true-fix'). Receipt-stämplar (aisstream) har
  // inga re-leveranser att fånga: två äkta meddelanden kan dela millisekund
  // och ett NTP-bakhopp får ALDRIG tysta källan tills klockan hunnit ikapp
  // — aisstream genom both-läget måste bete sig exakt som i pass-through.
  if (violatesMonotonic(state, msg, feed, fixTs)) {
    return { accept: false, reason: 'stale_or_duplicate_fix' };
  }

  // F2: korskälle-suppression på INNEHÅLL, inte tid. Kräver ANNAN källa —
  // samma källas identiska innehåll med ny fixTs är aisstreams legitima
  // kajupprepning och håller fartyget vid liv (grupp B/C).
  // F2b (etapp 3): eko-grenen — identiskt innehåll vars fixTs ligger inom
  // FIX_ECHO_TOLERANCE_MS från det senast accepterade innehålls-fixet är en
  // re-leverans av SAMMA fysiska rapport (oavsett hur gammal accepten är)
  // och får aldrig refresha fartygets livstecken. En äkta ny rapport med
  // samma position bär nytt fixTs utanför toleransen och accepteras.
  if (violatesCrossFeedContent(state, msg, feed, fixTs, now, cfg)) {
    return { accept: false, reason: 'cross_feed_duplicate' };
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
  //
  // J4 (helkodsgranskning runda 2, 2026-08-22) — ARTEFAKTUNDANTAGET. Sedan
  // H24 klampas kompensationen till MAX_FIX_AGE_MS/2, och den restskev taket
  // lämnade kvar fick F4a att klampa stämpeln — varpå den här grinden
  // avvisade VARJE hubbfix i skevbandet ca 480-720 s. Grinden ska fånga en
  // stämpel som är så orimlig att den inte går att lita på, inte en stämpel
  // som VÅR EGEN skyddsklamp lämnade i framtiden. Står offseten exakt på det
  // fulla (korroborerade) taket är klampen alltså takets eget verk och avslaget
  // hoppas över; se offsetStandsAtMaxMagnitude för varför det tunna urvalets
  // tak MEDVETET inte får samma undantag.
  let clockSkewCapBypass = false;
  if (feed === 'aishub') {
    if (msg.clockSkew === true) {
      if (clamped && offsetStandsAtMaxMagnitude(offsetMs, cfg)) {
        clockSkewCapBypass = true;
      } else {
        return { accept: false, reason: 'hub_clock_skew' };
      }
    }
    if (violatesStaleCross(state, fixTs)) {
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

  // Fältet SÄTTS BARA när undantaget fyrade: en ovillkorlig nyckel hade
  // ändrat formen på varje accept-verdikt (och därmed muxens/testernas
  // objektjämförelser) för en händelse som är sällsynt per konstruktion.
  if (clockSkewCapBypass) {
    return {
      accept: true, fixTs, feedSwitch, clockSkewCapBypass: true,
    };
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
  classifyAll,
  applyAccept,
  pruneStates,
};
