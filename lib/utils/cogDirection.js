'use strict';

const { COG_DIRECTIONS } = require('../constants');

// =============================================================================
// COG-RIKTNINGSPREDIKAT — EN NAMNGIVEN FAMILJ FÖR FYRA MEDVETET OLIKA BAND
// Fable-granskningen 2026-08-10 (FG-DIR)
// =============================================================================
//
// VARFÖR modulen finns: riktning-ur-COG låg utspridd som hårdkodade gradtal på
// ~14 ställen (26 jämförelseuttryck) i app.js och lib/services/*. Talen SER
// slarviga ut men är det inte — fyra av dem är olika av MEDVETNA, dokumenterade
// skäl, och den enda platsen skillnaden stod förklarad var i löpande kommentarer
// bredvid siffrorna. En läsare som såg `cog >= 135 && cog <= 225` på ett ställe
// och `cog >= 135 && cog < 315` på nästa hade ingen chans att avgöra om det var
// en bugg eller ett beslut utan att läsa fem kommentarsblock. Efter refaktorn
// står AVSIKTEN i funktionsnamnet (`isSouthCogStrict` vs `isSouthCogWide` vs
// `isSouthCogToken`) och besluten bor på ETT ställe: här.
//
// ⚠️ BANDEN ÄR MEDVETET OLIKA — HARMONISERA DEM INTE "FÖR KONSEKVENSENS SKULL".
// Varje sydband har sin egen riskprofil och sin egen facit-/replay-förankring.
// Att slå ihop två av dem är en BETEENDEÄNDRING som måste bevisas mot de
// korpusar bandet låstes av, inte antas ur symmetri. Se P5-beslutet i
// lib/constants.js (COG_DIRECTIONS) för grundresonemanget.
//
// SEMANTISKA FAMILJER (fyra predikat, inte ett):
//   isNorthCog        315–45  (via 0°)   — ETT nordband, identiskt överallt
//   isSouthCogStrict  135–225 inklusivt  — målbro-/route-låsning (P5, hög insats)
//   isSouthCogWide    135–<315           — dedup/latch/validator (ELFKUNGEN, GR2-6)
//   isSouthCogToken   135–270 inklusivt  — notis-token-fallback (FP8)
//
// KONTRAKT (gäller alla predikat i familjen):
//  - INGEN NORMALISERING. Predikaten jämför värdet som det kommer in. De tre
//    anropsställen som normaliserar (`((cog % 360) + 360) % 360`) gör det kvar
//    på sin egen sida och skickar in det normaliserade värdet — precis som före
//    refaktorn. Att normalisera här hade tyst ändrat utfallet för de ~11 ställen
//    som INTE normaliserar.
//  - DEFENSIVA MOT ICKE-FINIT: `isNorthCog(null)` är false, inte true. Det är
//    ett rent skyddsnät, INTE en beteendeändring: samtliga anropsställen gatar
//    redan `Number.isFinite(cog)` före anropet (verifierat ställe för ställe i
//    FG-DIR-inventeringen), så ingen nuvarande null-/NaN-utgång flyttar sig.
//    Guarden finns för att den historiska fällan är dokumenterad och dyr:
//    `null <= 45` är true i JS (⇒ "norrut") medan `undefined <= 45` är false
//    (⇒ "söderut") — se VesselLifecycleManager._isNorthbound. Anropsställenas
//    egna finit-gater är därför medvetet KVAR; de bär sin egen semantik (t.ex.
//    "returnera null/'unknown' vid okänd kurs"), som ett booleskt predikat
//    omöjligt kan uttrycka.
//  - Predikaten är rena och sidoeffektfria.

/**
 * Sydbandens gemensamma nedre gräns, inklusiv. Alla tre sydvarianterna börjar
 * på 135° (SO) — det är BARA toppen som skiljer dem åt.
 */
const SOUTH_MIN = 135;

/**
 * Strikta sydbandets topp, INKLUSIV (`<= 225`). 225° = SV.
 */
const SOUTH_STRICT_MAX = 225;

/**
 * Notis-tokenbandets topp, INKLUSIV (`<= 270`). 270° = V.
 */
const SOUTH_TOKEN_MAX = 270;

/**
 * Breda sydbandets topp, EXKLUSIV (`< 315`). Talet är inte ett eget beslut:
 * bandet är definierat som "allt från 135° upp till där nordbandet börjar", så
 * gränsen HÄRLEDS ur COG_DIRECTIONS.NORTH_MIN i stället för att kopiera 315.
 * Nord och bred syd är komplementära på den sidan — de får inte kunna glida isär.
 */
const SOUTH_WIDE_MAX_EXCLUSIVE = COG_DIRECTIONS.NORTH_MIN;

/**
 * Nordlig kurs: 315°–45° via 0° (NV → N → NO).
 *
 * VARFÖR ett enda nordpredikat: till skillnad från syd finns bara EN
 * nordtolkning i hela kodbasen — samtliga 13 nordställen hade exakt formen
 * `cog >= 315 || cog <= 45`, hälften via COG_DIRECTIONS-konstanterna och
 * hälften som rå literal. Här läses alltid konstanterna (P5-beslutet i
 * lib/constants.js äger talen); ingen kopia av 315/45 finns kvar i koden.
 *
 * Båda gränserna är INKLUSIVA: 315 → true, 45 → true, 46 → false, 314 → false.
 *
 * @param {number} cog - Course Over Ground i grader. Icke-finit ⇒ false.
 * @returns {boolean} True om kursen ligger i nordbandet.
 */
function isNorthCog(cog) {
  if (!Number.isFinite(cog)) return false;
  return cog >= COG_DIRECTIONS.NORTH_MIN || cog <= COG_DIRECTIONS.NORTH_MAX;
}

/**
 * Sydlig kurs, STRIKT band: 135°–225° inklusivt (SO → S → SV).
 *
 * VARFÖR strikt: detta är HÖGINSATSBANDET (P5-beslutet, punkt 1) — riktningen
 * som väljer MÅLBRO och låser rutten. 46–134° och 226–314° lämnas MEDVETET
 * tvetydiga: en tvärställd/drivande båt ska inte få en gissad målbro, för fel
 * målbro driver fel bridge_text OCH fel notis-bro (Anomali 16/F18, DAPHNE
 * 219022098: sog 0,6 kn, cog 73,2° ⇒ felaktig target + ETA 79 min). Priset är
 * att SV-kurs 226–314° inte låser någon riktning alls här — det är avsiktligt,
 * "ingen låsning" är billigare än "fel låsning".
 *
 * ⚠️ Detta är INTE samma band som isSouthCogWide/isSouthCogToken. cog 250°:
 * false här, true i båda de andra.
 *
 * Båda gränserna INKLUSIVA: 134 → false, 135 → true, 225 → true, 226 → false.
 *
 * @param {number} cog - Course Over Ground i grader. Icke-finit ⇒ false.
 * @returns {boolean} True om kursen ligger i det strikta sydbandet.
 */
function isSouthCogStrict(cog) {
  if (!Number.isFinite(cog)) return false;
  return cog >= SOUTH_MIN && cog <= SOUTH_STRICT_MAX;
}

/**
 * Sydlig kurs, BRETT band: 135° till <315° (SO → S → SV → V → VNV).
 *
 * VARFÖR brett: LÅGINSATSBANDET. Här är kostnaden för ett felaktigt 'south'
 * liten (en latch släpper tidigt, en dedup-nyckel rensas) medan kostnaden för
 * 'okänd' är stor (hela klasser av returresor blir onotifierade). I den
 * NE–SV-orienterade kanalen är SV-/V-kurs (226–314°) NORMAL sydfärd, inte
 * drift. Bandet infördes/harmoniserades i tre steg med var sitt facit:
 *  - 2026-07-03 (ELFKUNGEN/HALIFAX): det smala bandet lagrade dir=null för
 *    SV-kurs → ELFKUNGEN-undantaget (motsatt riktning släpper dedup) slog
 *    aldrig för returresor.
 *  - Helgranskning 2026-07-10 (A1-1): NEW_JOURNEY + Fix D — en nordlåst båt
 *    som U-svängde med cog 250° fick aldrig ny resa (PRICKBJORN-klassen).
 *  - R2 2026-07-11 (GR2-6): latch + RouteOrderValidator — F13-releasen och
 *    riktningsbytesundantaget var döda för klassen.
 *
 * ⚠️ Toppen är EXKLUSIV (`< 315`) medan de andra sydbanden har inklusiv topp.
 * Det är inte slarv: bandet slutar exakt där nordbandet börjar, se
 * SOUTH_WIDE_MAX_EXCLUSIVE. 314 → true, 315 → false (315 är nord).
 *
 * ⚠️ Bandet är facit-låst mot HALIFAX/ELFKUNGEN-serierna och ska INTE
 * harmoniseras ned till token-bandets 270 utan att prövas mot dem — den
 * snävningen (FP8) gjordes på token-empiri, som inte gäller här.
 *
 * @param {number} cog - Course Over Ground i grader. Icke-finit ⇒ false.
 * @returns {boolean} True om kursen ligger i det breda sydbandet.
 */
function isSouthCogWide(cog) {
  if (!Number.isFinite(cog)) return false;
  return cog >= SOUTH_MIN && cog < SOUTH_WIDE_MAX_EXCLUSIVE;
}

/**
 * Sydlig kurs, NOTIS-TOKENBANDET: 135°–270° inklusivt (SO → S → SV → V).
 *
 * VARFÖR ett eget band: P5-beslutets punkt 2 — token-FALLBACKEN i
 * _getDirectionString, som bara körs för fartyg UTAN låst ruttriktning.
 * Bandet är brett nedtill av samma skäl som isSouthCogWide (replay-bevis:
 * JOSEPHINE, bevisligen sydgående med COG 226,7°, fick 'unknown' med det
 * strikta bandet), men snävades i toppen av FP8 (2026-07-13, 219034975):
 * COG 314,7° — 0,3° från nordbandet — gav token 'southbound' för en båt vid
 * Kanalinfarten som sannolikt var på väg IN. Empiri över tre körningar
 * (136+ h): äkta nordgående in vid infarten har COG 28–33°, äkta sydgående
 * 135–245°; INGEN legitim kanalfärd använder 270–314°. VNV–NV (271–314°) är
 * tvetydigt ⇒ 'unknown' är den ärliga tokenen.
 *
 * ⚠️ FP8-snävningen 314→270 gjordes UTAN att röra dedup-/latch-bandet
 * (isSouthCogWide) — funktionerna är alltså MEDVETET isär tills motsatsen
 * bevisats. 271 → false här men true i isSouthCogWide.
 *
 * Båda gränserna INKLUSIVA: 270 → true, 271 → false.
 *
 * @param {number} cog - Course Over Ground i grader. Icke-finit ⇒ false.
 * @returns {boolean} True om kursen ligger i notis-tokenbandet.
 */
function isSouthCogToken(cog) {
  if (!Number.isFinite(cog)) return false;
  return cog >= SOUTH_MIN && cog <= SOUTH_TOKEN_MAX;
}

/**
 * Bandgränserna exponerade för test/diagnostik. Produktionskod ska anropa
 * PREDIKATEN, inte läsa talen — hela poängen med FG-DIR är att inga
 * gradjämförelser bor utanför den här filen.
 */
const COG_BANDS = Object.freeze({
  NORTH_MIN: COG_DIRECTIONS.NORTH_MIN,
  NORTH_MAX: COG_DIRECTIONS.NORTH_MAX,
  SOUTH_MIN,
  SOUTH_STRICT_MAX,
  SOUTH_TOKEN_MAX,
  SOUTH_WIDE_MAX_EXCLUSIVE,
});

module.exports = {
  isNorthCog,
  isSouthCogStrict,
  isSouthCogWide,
  isSouthCogToken,
  COG_BANDS,
};
