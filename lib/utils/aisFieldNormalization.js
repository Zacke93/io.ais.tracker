'use strict';

/**
 * aisFieldNormalization — DELAD sanering av AIS-skalärfälten SOG, COG och
 * NAVSTAT.
 *
 * VARFÖR EN DELAD MODUL OCH INTE TVÅ KOPIOR (J6 + J35, helkodsgranskning
 * runda 2, 2026-08-22): appen har TVÅ ingångar för samma fysiska AIS-rapport
 * — lib/utils/aishubParser.js (poll) och lib/connection/AISStreamClient.js
 * (push). Reglerna var skrivna två gånger och hade GLIDIT ISÄR: hubbsidan
 * mappade COG utanför 0–<360 och NAVSTAT 15 till null (H34 respektive
 * AIS-specen), strömsidan skickade båda RÅTT vidare.
 *
 * Följden var inte kosmetisk. FixFusionPolicy.contentScalarKey är
 * `mmsi:sog:cog`, och muxen bokför fixen via applyAccept FÖRE appens
 * validering — så samma rapport bar `360` från aisstream och `null` från
 * hubben, F2:s korskälle-dedup matchade aldrig, och F6b:s parbevis bildade
 * aldrig par för HELA klassen kurslösa fartyg (förtöjda, Class B utan
 * kompass; 837 sentinelträffar i fältloggarna). Regeln bor därför på ETT
 * ställe som båda ingångarna anropar.
 *
 * DOKTRINEN ÄR H34:s: kasta det KORRUPTA FÄLTET, aldrig positionen. Ett
 * fält utanför sitt kodade intervall bär ingen information, och att räkna
 * fram ett värde ur det (modulo, avrundning) FABRICERAR precis det som
 * normaliseringen 360 → 0 en gång togs bort för att stoppa.
 *
 * KOERCIONEN — OCH FINITKRAVET — ÄGS AV ANROPAREN, INTE AV MODULEN:
 * funktionerna tar ett REDAN numeriskt värde. AISHubs ws.php serverar fälten
 * som strängar och parsern koercerar därför med sin egen num()-hjälpare
 * (`'5'` → 5 är en del av det wire-kontraktet och är låst i
 * tests/aishub-parser-unit.test.js), medan aisstream levererar typad JSON där
 * en sträng är ren korruption. Att lyfta in koercionen här hade alltså gjort
 * strömsidan MER tillåtande än den är i dag — motsatsen till vad
 * paritetsfixen ska åstadkomma. Av exakt samma skäl bor num()-grenens
 * FINITKRAV kvar hos parsern (num(null) är NaN, Number(null) är 0 — en
 * saknad fart får aldrig bli "verklig nollfart"): strömsidan har inget
 * sådant behov och ska enligt det dementerade J3 fortsätta släppa igenom ett
 * icke-finit värde orört. Se normalizeSog nedan för hela härledningen.
 */

/**
 * SOG-sentinel: rå AIS-SOG 1023 = "ej tillgänglig" avkodas till 102,3 knop
 * (samma /10-mönster som COG-sentinelen 3600 → 360). Gränsen är ≥ 102,15 och
 * inte === 102,3 därför att 102,2 betyder "102,2 knop eller mer" — fysiskt
 * nonsens i Trollhätte kanal ⇒ okänd fart. Värdet stod förut som en naken
 * literal i BÅDA ingångarna (aishubParser + AISStreamClient); det är exakt
 * den sortens duplicerad konstant som glider isär.
 */
const SOG_NOT_AVAILABLE_KN = 102.15;

/**
 * COG-intervallet enligt ITU-R M.1371: 0–359,9 grader är kurs, 360 är
 * sentinelen "kurs ej tillgänglig". Rå COG 3601–4095 avkodas till
 * 360,1–409,5 och ligger alltså också utanför — H34:s poäng var just att en
 * grind på ENBART exakt 360 släppte igenom hela det bandet.
 */
const COG_MAX_EXCLUSIVE_DEG = 360;

/**
 * NAVSTAT 0–14 är semantiska statusar; 15 = "undefined" i AIS-specen.
 * 15 måste bli null eftersom VesselDataService slår ihop med nullish-
 * operatorn (data.navStatus ?? oldVessel.navStatus) — ett 15 hade annars
 * SKRIVIT ÖVER ett känt 1 (at anchor) eller 5 (moored), MOORED_NAV_STATUSES
 * slutat matcha och den kajförtöjda båten räknats som väntande tills
 * kajzonslagret (≥ 3 min stillhet) hann ikapp.
 */
const NAV_STATUS_MAX = 14;

/**
 * Normalisera fart över grund — ENBART SENTINELEN.
 *
 * ICKE-FINITA VÄRDEN PASSERAR ORÖRDA, och det är ett medvetet val (granskningen
 * av runda 2, 2026-08-22). Funktionen bar en kort stund en finitgrind som
 * gjorde NaN/Infinity/sträng till null. Den var en beteendeutvidgning mot fynd
 * J3 — "icke-finit eller negativ SOG fäller HELA positionsrapporten" — och J3
 * är DEMENTERAT: AIS-SOG är ett TECKENLÖST 10-bitarsfält (0–102,3 kn), så
 * ingen konform avkodare kan producera negativt eller icke-finit; hubbsidan
 * koercerar dessutom bort fallet i sin egen ingång, och ett strängtypat
 * aisstream-flöde faller på LATITUD långt före farten. Mätningen bakom
 * dementin: loggraden AIS_VALIDATION_REJECT förekommer 0 gånger i 102
 * fältloggar (281 MB) medan 837 COG-normaliseringar loggats ur SAMMA funktion
 * — kanalen var öppen och felmoden syntes ändå aldrig.
 *
 * VARFÖR GRINDEN INTE ÄR HARMLÖS: den ändrar semantik. Ett meddelande med
 * icke-finit sog föll FÖRE grinden bort i app.js _validateAISMessage, men hade
 * MED grinden levererats vidare med sog null — alltså som den FARTGIVARLÖSA
 * klassen, som förtöjningsdetekteringens rörelsebevis och GPS-gaten båda
 * behandlar särskilt. Ändringen var därtill per konstruktion OMÄTBAR:
 * replayharnessen anropar aldrig AISStreamClient._extractAISData, så inget
 * facit kunde se den. Funktionen gör därför EXAKT det HEAD gjorde — kapar
 * sentinelen, rör inget annat — och FINITKRAVET ÄGS AV ANROPAREN precis som
 * koercionen (aishubParser har sitt eget; se modulens docblock ovan).
 * @param {*} value - REDAN numeriskt värde (anroparen koercerar vid behov)
 * @returns {number|null} null vid sentinelen, annars värdet ORÖRT
 */
function normalizeSog(value) {
  return (Number.isFinite(value) && value >= SOG_NOT_AVAILABLE_KN) ? null : value;
}

/**
 * Normalisera kurs över grund. POSITIONEN BERÖRS ALDRIG av ett kasserat
 * COG-fält — det är hela skillnaden mot att avvisa rapporten.
 * @param {*} value - REDAN numeriskt värde (anroparen koercerar vid behov)
 * @returns {number|null} grader 0–<360, eller null när kursen är okänd/korrupt
 */
function normalizeCog(value) {
  if (!Number.isFinite(value)) return null;
  return (value >= 0 && value < COG_MAX_EXCLUSIVE_DEG) ? value : null;
}

/**
 * Normalisera navigationsstatus.
 * @param {*} value - REDAN numeriskt värde (anroparen koercerar vid behov)
 * @returns {number|null} heltal 0–14, eller null när statusen är okänd
 */
function normalizeNavStatus(value) {
  return (Number.isInteger(value) && value >= 0 && value <= NAV_STATUS_MAX)
    ? value
    : null;
}

module.exports = {
  normalizeSog,
  normalizeCog,
  normalizeNavStatus,
  SOG_NOT_AVAILABLE_KN,
  COG_MAX_EXCLUSIVE_DEG,
  NAV_STATUS_MAX,
};
