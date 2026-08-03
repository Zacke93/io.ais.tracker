'use strict';

/**
 * shiftFeedDelivery (V4, A/B-natten 2026-08-03) — latensvariant av en VERKLIG
 * fusionskorpus.
 *
 * makeFusionCorpus kan generera lagg i en SYNTETISK skuggström; det här
 * verktyget gör samma sak på en inspelad korpus där hub-raderna redan finns
 * (t.ex. nattens `night-fusion.jsonl`). Endast LEVERANSTIDEN (`aisTimestamp`)
 * för rader från den valda källan skjuts framåt — `fixTs` står still, och
 * raderna sorteras om på den nya leveransordningen. Det är exakt asymmetrin en
 * släpande andrakälla ger i drift, och den felmod nattens latenstest fällde
 * koden på (+30 s ⇒ dubbelnotiser på målbro, +60 s ⇒ sju dubbletter varav en
 * 152 m EFTER passagen; källans egen latens hade p90 62,3 s).
 *
 * KLOCKDOMÄNDOKTRINEN: `aisTimestamp` ÄR mottagningstid i korpusformatet
 * (replayRunner stegar fake-klockan till den), `fixTs` är fixtid. Verktyget
 * rör aldrig det senare — gör det någon är hela experimentet meningslöst.
 *
 * Användning:
 *   node tests/replay-validation/shiftFeedDelivery.js <in.jsonl> <ut.jsonl> <delayMs> [feed=aishub]
 */

const fs = require('fs');

/**
 * @param {Array<object>} samples - Parsade korpusrader
 * @param {number} delayMs - Leveransfördröjning att lägga på
 * @param {string} [feed] - Källa att fördröja (default 'aishub')
 * @returns {{rows: Array<object>, shifted: number}}
 */
function shiftFeedDelivery(samples, delayMs, feed = 'aishub') {
  let shifted = 0;
  const rows = samples.map((s) => {
    if (s.feed !== feed || !Number.isFinite(s.aisTimestamp)) return s;
    shifted++;
    return { ...s, aisTimestamp: s.aisTimestamp + delayMs };
  });
  // Stabil omsortering på den NYA leveransordningen (ctrl-rader utan
  // aisTimestamp behåller sin relativa plats via 0-fallbacken, som i
  // makeFusionCorpus).
  rows.sort((a, b) => (a.aisTimestamp || 0) - (b.aisTimestamp || 0));
  return { rows, shifted };
}

module.exports = { shiftFeedDelivery };

if (require.main === module) {
  const [, , inPath, outPath, delayArg, feedArg] = process.argv;
  if (!inPath || !outPath || delayArg === undefined) {
    process.stderr.write('Usage: node shiftFeedDelivery.js <in.jsonl> <ut.jsonl> <delayMs> [feed=aishub]\n');
    process.exit(1);
  }
  const delayMs = Number(delayArg);
  if (!Number.isFinite(delayMs)) {
    process.stderr.write('delayMs måste vara ett tal (ms)\n');
    process.exit(1);
  }
  const samples = fs.readFileSync(inPath, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const { rows, shifted } = shiftFeedDelivery(samples, delayMs, feedArg || 'aishub');
  fs.writeFileSync(outPath, `${rows.map((s) => JSON.stringify(s)).join('\n')}\n`);
  process.stdout.write(`latensvariant: ${shifted}/${rows.length} rader (${feedArg || 'aishub'}) fördröjda ${delayMs} ms → ${outPath}\n`);
}
