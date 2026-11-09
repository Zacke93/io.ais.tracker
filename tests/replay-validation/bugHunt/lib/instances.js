'use strict';

/**
 * Instansnamnrymd för eventId (BUGGJAKT §6, LEV-orakelns falsklarmsvakt).
 *
 * BridgeOpeningService börjar om _eventSeq i varje ny app-instans. Efter en
 * ctrl:restart återkommer därför samma eventId (Klaffbron#4 före och efter
 * omstarten i 42h-omstartsvarianten). Innan något joinas på eventId skrivs det
 * om till `i<n>:<id>`, där n är antalet ctrl:restart med tid ≤ t.
 *
 * Utan omstarter lämnas resultatet orört (samma objekt), så bankkörningarna
 * jämförs exakt som harnessen själv ser dem. Händelser exakt på omstartens
 * tidpunkt räknas till den nya instansen (runnern kör omstarten före nästa
 * rad, och alla kortanrop i den millisekunden kommer från den nya instansen).
 */

// openingCoverageVerdicts: släppvägens domspår (varv 2, M1), som registret
// joinar på eventId mot openingWarnings och openingCoverage.
const FIELDS = ['openingWarnings', 'openingCoverage', 'openingSuppressions', 'openingCoverageVerdicts'];

function restartTimes(rows) {
  return (rows || [])
    .filter((r) => r && r.ctrl === 'restart' && Number.isFinite(r.aisTimestamp))
    .map((r) => r.aisTimestamp)
    .sort((a, b) => a - b);
}

/**
 * Instansindex för tiden t: antalet omstarter med tid ≤ t.
 * @param {number[]} restarts - sorterade omstartstider
 * @param {number} t - tid
 * @returns {number} index
 */
function instanceAt(restarts, t) {
  let n = 0;
  for (const r of restarts) {
    if (r <= t) n++;
    else break;
  }
  return n;
}

/**
 * Returnerar en kopia av resultatet med namnrymdade eventId.
 * @param {object} result - replayresultatet
 * @param {object[]} rows - världens/korpusens rader (ctrl:restart behövs)
 * @returns {object} resultat (samma objekt om inga omstarter finns)
 */
function namespaceEventIds(result, rows) {
  const restarts = restartTimes(rows);
  if (!restarts.length || !result) return result;
  const tag = (x) => (x && x.eventId && Number.isFinite(x.t)
    ? { ...x, eventId: `i${instanceAt(restarts, x.t)}:${x.eventId}` }
    : x);
  const out = { ...result };
  for (const f of FIELDS) out[f] = (result[f] || []).map(tag);
  return out;
}

module.exports = { namespaceEventIds, restartTimes, instanceAt };
