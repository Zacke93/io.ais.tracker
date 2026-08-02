'use strict';

/**
 * makeFusionCorpus (etapp 3, 2026-08-02) — genererar en syntetisk AISHub-
 * skuggström ur en LÅST korpus och sammanfogar den med originalet.
 *
 * Modellen speglar den riktiga AISHubClient-leveransen exakt:
 *  - Poll var 65:e sekund (offset en halv period från korpusstart så
 *    pollarna aldrig råkar sammanfalla med streamens tidsstämplar).
 *  - Varje poll levererar SENAST KÄNDA fix per fartyg (tillståndssnapshot),
 *    max 10 min gammalt (interval=10-filtret på serversidan).
 *  - Samma fix återkommer i flera pollar tills ett nyare finns
 *    (re-leveranserna som F1/F2b ska svälja).
 *  - Posterna i en poll sprids 150 ms isär (batchspridningen).
 *
 * GRINDENS KONTRAKT (slutplanen §8.7): eftersom skuggströmmen enbart EKAR
 * information som streamen redan levererat ska fusionskörningen ge EXAKT
 * samma notiser, (mmsi,bro)-multiset och riktningsmultiset som originalet —
 * varje avvikelse betyder att F-reglerna läcker (ekon som refreshar
 * livstecken, dubbletter som når pipelinen, källbyten som stör tallyn).
 *
 * Användning (CLI):
 *   node tests/replay-validation/makeFusionCorpus.js <in.jsonl> <ut.jsonl>
 */

const fs = require('fs');

const DEFAULTS = {
  pollIntervalMs: 65000,
  pollOffsetMs: 32500,
  spreadMs: 150,
  maxFixAgeMs: 10 * 60 * 1000,
};

/**
 * @param {Array<object>} samples - Parsade korpusrader (kronologiska)
 * @param {object} [opts]
 * @returns {{merged: Array<object>, hubCount: number}}
 */
function makeFusionCorpus(samples, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const positional = samples.filter((s) => !s.ctrl
    && s.mmsi != null
    && Number.isFinite(s.aisTimestamp)
    && Number.isFinite(s.lat)
    && Number.isFinite(s.lon));
  if (positional.length === 0) {
    return { merged: [...samples], hubCount: 0 };
  }

  const firstTs = positional[0].aisTimestamp;
  const lastTs = positional[positional.length - 1].aisTimestamp;

  // Kronologisk svepning: lastFix per mmsi vid varje polltillfälle.
  const lastFix = new Map(); // mmsi → sample
  const hubSamples = [];
  let cursor = 0;

  for (let pollAt = firstTs + cfg.pollOffsetMs; pollAt <= lastTs; pollAt += cfg.pollIntervalMs) {
    while (cursor < positional.length && positional[cursor].aisTimestamp <= pollAt) {
      const s = positional[cursor];
      lastFix.set(String(s.mmsi), s);
      cursor++;
    }
    let idx = 0;
    for (const [mmsi, f] of lastFix) {
      const age = pollAt - f.aisTimestamp;
      if (age < 0 || age > cfg.maxFixAgeMs) continue;
      hubSamples.push({
        mmsi,
        msgType: 'AISHubPosition',
        lat: f.lat,
        lon: f.lon,
        sog: f.sog,
        cog: f.cog,
        navStatus: f.navStatus,
        shipName: f.shipName || 'Unknown',
        aisTimestamp: pollAt + idx * cfg.spreadMs, // mottagningstid (poll + spridning)
        fixTs: f.fixTs ?? f.aisTimestamp, // ÄKTA fixtid = streamens stämpel
        feed: 'aishub',
      });
      idx++;
    }
  }

  const merged = [...samples, ...hubSamples]
    .sort((a, b) => (a.aisTimestamp || 0) - (b.aisTimestamp || 0));
  return { merged, hubCount: hubSamples.length };
}

module.exports = { makeFusionCorpus };

if (require.main === module) {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    process.stderr.write('Usage: node makeFusionCorpus.js <in.jsonl> <ut.jsonl>\n');
    process.exit(1);
  }
  const samples = fs.readFileSync(inPath, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const { merged, hubCount } = makeFusionCorpus(samples);
  fs.writeFileSync(outPath, `${merged.map((s) => JSON.stringify(s)).join('\n')}\n`);
  process.stdout.write(`fusionskorpus: ${samples.length} original + ${hubCount} aishub-ekon → ${outPath}\n`);
}
