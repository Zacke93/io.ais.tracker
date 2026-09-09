'use strict';

// Dedup är förväntad bara när varje undertryckt medlem kan bindas till ett
// tidigare faktiskt kortanrop. En räknare eller loggrad ensam får inte
// ursäkta att en ny öppning försvann mellan service och Homey-kort.
function openingDeliveryFailures(result) {
  const warnings = result.openingWarnings || [];
  const suppressed = result.openingSuppressions || [];
  const failures = [];
  if (warnings.some((w) => w.success === false)) failures.push('ÖPPNINGSLEVERANS: misslyckat kortanrop');
  if (result.openingServiceFires !== warnings.length + suppressed.length) {
    failures.push(`ÖPPNINGSLEVERANS: ${result.openingServiceFires} avfyrningar, ${warnings.length} kort, ${suppressed.length} redovisade dubbletter`);
  }
  for (const entry of suppressed) {
    const previouslyRecorded = (member) => result.initialState?.source === 'recorded'
      && result.initialState.capturedAt <= entry.t
      && (result.openingWarningsAtStartup || []).some((w) => w.key === member.key && w.firedAt === member.firedAt);
    if (entry.suppressed !== 'same-arrival' || !entry.members?.length
        || entry.members.some((member) => !previouslyRecorded(member) && !warnings.some((w) => w.success !== false
          && w.bridge === entry.bridge && w.mmsis.includes(member.mmsi)
          && w.t === member.firedAt && w.t <= entry.t))) {
      failures.push(`OBELAGD ÖPPNINGSDEDUP: ${entry.eventId}`);
    }
  }
  // Ett undertryckt event får aldrig tysta en nytillkommen konvojmedlem.
  // Eventnummer återanvänds efter omstart: en senare suppression bryter
  // därför kopplingen även om samma ID har ett gammalt faktiskt kort.
  for (const entry of result.openingCoverage || []) {
    if (entry.reason !== 'absorbed') continue;
    const delivered = warnings.some((warning) => warning.eventId === entry.eventId
      && warning.bridge === entry.bridge && warning.success !== false && warning.t <= entry.t
      && !suppressed.some((duplicate) => duplicate.eventId === entry.eventId
        && duplicate.bridge === entry.bridge && duplicate.t >= warning.t && duplicate.t <= entry.t));
    if (!delivered) failures.push(`OBELAGD KONVOJTÄCKNING: ${entry.eventId} för ${entry.mmsi}`);
  }
  return failures;
}

module.exports = { openingDeliveryFailures };
