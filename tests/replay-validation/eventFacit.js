'use strict';

// Fullständiga händelser låser även tid, ETA, text, källa och medlemmar.
// Samma totalsumma eller brofördelning får inte dölja ett ändrat kortanrop.
const DIMENSIONS = ['notifications', 'openingWarnings', 'openingSuppressions', 'targetPassages', 'intermediatePassages'];

function eventFacit(result) {
  const facit = { version: 1 };
  for (const key of DIMENSIONS) {
    if (!Array.isArray(result[key])) throw new Error(`Händelsedimension saknas: ${key}`);
    facit[key] = result[key];
  }
  return facit;
}

function eventFacitFailures(result, expected) {
  if (expected?.version !== 1) return ['GOLDEN-EVENTS: ogiltigt facit'];
  const failures = [];
  for (const key of DIMENSIONS) {
    if (!Array.isArray(result[key]) || !Array.isArray(expected[key])) {
      failures.push(`GOLDEN-EVENTS: dimension saknas: ${key}`);
    } else if (JSON.stringify(result[key]) !== JSON.stringify(expected[key])) {
      const firstDiff = result[key].findIndex((entry, i) => JSON.stringify(entry) !== JSON.stringify(expected[key][i]));
      failures.push(`GOLDEN-EVENTS: ${key} skiljer sig vid post ${firstDiff < 0 ? result[key].length : firstDiff}`);
    }
  }
  return failures;
}

module.exports = { eventFacit, eventFacitFailures };
