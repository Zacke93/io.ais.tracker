'use strict';

// =============================================================================
// RIKTNINGSTOKENS PÅ SVENSKA — EN SANNING FÖR ÖVERSÄTTNINGEN INTERNT ↔ ANVÄNDARE
// ANVÄNDARBESLUT F5/A3 (2026-08-21, se ATERUPPTAGNING-grona-paketet §3)
// =============================================================================
//
// VARFÖR modulen finns: appens riktningsvärden har levt i EN vokabulär hela
// vägen från beslutslogik till Homey-flödet — 'northbound'/'southbound'/
// 'unknown' stod alltså som råtext i användarens Flow-villkor. Användaren vill
// läsa svenska ('norrut'/'söderut'/'okänd', plus 'båda' för en blandriktad
// öppningskonvoj). Bytet får BARA ske i TOKEN-GRÄNSSNITTET; varenda intern
// jämförelse (app.js:6907 `=== 'southbound'`, dedupens {t,dir}-poster,
// öppningsvarningarnas persistenta nyckel `bro|mmsi|riktning`) måste behålla
// de interna orden. Två vokabulärer utan EN översättningspunkt är exakt den
// sortens glidning som fällde K13b:s eventDirection i gula batch 1 ('north'
// mot 'northbound' — två fält som båda hette riktning men aldrig kunde
// jämföras med ===). Därför bor bytet här, på ett enda ställe, och ingen
// annanstans i kodbasen får det finnas en riktningssträng på svenska.
//
// VOKABULÄRERNA (fyra värden vardera, exakt parvis):
//   internt      | användare | var
//   -------------|-----------|-----------------------------------------------
//   'northbound' | 'norrut'  | boat_near + bridge_opening_soon
//   'southbound' | 'söderut' | boat_near + bridge_opening_soon
//   'unknown'    | 'okänd'   | boat_near (bridge_opening_soon når det via
//                            |   payloadens direction-fallback)
//   'mixed'      | 'båda'    | ENDAST bridge_opening_soon (mötande konvoj,
//                            |   K13b:s eventDirection)
//
// ⚠️ ASYMMETRIN I FALLBACKARNA ÄR MEDVETEN — ändra den inte "för symmetrins
// skull":
//   • toUserDirection matar en ANVÄNDARSYNLIG token. Ett okänt indatavärde får
//     ALDRIG läcka ut som engelsk råtext i någons Flow ⇒ 'okänd' är den
//     ärliga och säkra utgången.
//   • fromUserDirection matar replay-harnessens FACITNYCKLAR. Där är ett tyst
//     'unknown' skadligt: invarianten INV-2 (invariants.js:139) fäller en
//     ogiltig riktning, och den grinden ska fortsätta se skräpet i stället för
//     att få det bortstädat på vägen ⇒ okänd indata returneras ORÖRD.
//
// ⚠️ SVÄLJNINGEN HAR EN VAKT (granskarfynd 2026-08-21). Asymmetrin ovan
// betyder att skräp som uppstår INNE i app.js:s riktningskedja (en framtida
// stavfelsretur 'northboud' ur _getDirectionString/_getNotificationDirection)
// blir tyst 'okänd' → adaptern gör 'unknown' → INV-2 godkänner det. Före
// språkbytet hade samma typo fällt INV-2 i varje korpus. Skyddsnätet ligger
// därför i anroparen: app.js:_assertInternalDirection prövar värdet mot
// INTERNAL_TO_USER (hasOwnProperty) och skriver this.error('[DIR_TOKEN] …')
// innan översättningen. Tokenvärdet är oförändrat ('okänd') — vakten LOGGAR,
// den ändrar inget. Flytta aldrig fallbacken hit i tron att den saknar skydd.
//
// BÅDA funktionerna är IDEMPOTENTA (ett värde som redan står i målvokabulären
// returneras oförändrat). Det är inte slapphet utan ett krav: token-vägen i
// app.js bygger `tokens.direction` en gång och kopierar den till `safeTokens`
// en andra gång, och en icke-idempotent översättning hade slagit sönder
// värdet i det andra steget.

/** Interna riktningsvärden (koden) → användarens svenska token. */
const INTERNAL_TO_USER = Object.freeze({
  northbound: 'norrut',
  southbound: 'söderut',
  mixed: 'båda',
  unknown: 'okänd',
});

/** Användarens svenska token → internt riktningsvärde (exakt invers). */
const USER_TO_INTERNAL = Object.freeze({
  norrut: 'northbound',
  söderut: 'southbound',
  båda: 'mixed',
  okänd: 'unknown',
});

/**
 * Uppslag som ALDRIG går via prototypkedjan (granskarfynd 2026-08-21).
 *
 * Kartorna ovan är objektliteraler och ärver därför Object.prototype:
 * `INTERNAL_TO_USER['constructor']` är funktionen Object, `['toString']` en
 * funktion — båda sanningsvärde true. Med ett `if (KARTA[värde])`-uppslag
 * hade `toUserDirection('constructor')` returnerat en FUNKTION som token, och
 * `fromUserDirection('constructor')` hade gjort detsamma med facitnyckeln.
 * Ofarligt i dag (safeTokens gör ett andra pass och homey-mocken kastar på
 * icke-strängar), men det är precis den sortens fälla den här modulen finns
 * för att stänga. hasOwnProperty.call ser bara de fyra äkta nycklarna.
 *
 * @param {Object} map - INTERNAL_TO_USER eller USER_TO_INTERNAL
 * @param {string} key - Kandidatvärdet
 * @returns {boolean} True bara för modulens egna nycklar
 */
const hasKey = (map, key) => Object.prototype.hasOwnProperty.call(map, key);

/**
 * Den svenska tokenen för "ingen uppgift". Exporteras som namngiven konstant
 * så att anropare kan skriva fallbacks utan att kopiera strängen.
 */
const USER_DIRECTION_UNKNOWN = INTERNAL_TO_USER.unknown;

/**
 * Internt riktningsvärde → användarens svenska token.
 *
 * @param {string|null|undefined} internal - 'northbound' | 'southbound' |
 *   'mixed' | 'unknown' (eller ett redan översatt svenskt värde).
 * @returns {string} 'norrut' | 'söderut' | 'båda' | 'okänd'. Okänd/saknad
 *   indata ⇒ 'okänd' (aldrig ett engelskt ord i en användarsynlig token).
 */
function toUserDirection(internal) {
  if (typeof internal !== 'string') return USER_DIRECTION_UNKNOWN;
  if (hasKey(INTERNAL_TO_USER, internal)) return INTERNAL_TO_USER[internal];
  // Idempotens: värdet står redan i användarvokabulären.
  if (hasKey(USER_TO_INTERNAL, internal)) return internal;
  return USER_DIRECTION_UNKNOWN;
}

/**
 * Användarens svenska token → internt riktningsvärde.
 *
 * Används av replay-harnessen för att hålla facitnycklarna interna trots
 * språkbytet i tokenen — facitfilerna ska INTE skrivas om av ett språkval.
 *
 * @param {string|null|undefined} user - 'norrut' | 'söderut' | 'båda' |
 *   'okänd' (eller ett redan internt värde).
 * @returns {string|null|undefined} Internt värde. Ett värde som varken är
 *   svenskt eller internt returneras ORÖRT så att harnessens invarianter
 *   fortfarande kan fälla det (se modulhuvudet).
 */
function fromUserDirection(user) {
  if (typeof user !== 'string') return user;
  if (hasKey(USER_TO_INTERNAL, user)) return USER_TO_INTERNAL[user];
  return user;
}

module.exports = {
  toUserDirection,
  fromUserDirection,
  USER_DIRECTION_UNKNOWN,
  INTERNAL_TO_USER,
  USER_TO_INTERNAL,
};
