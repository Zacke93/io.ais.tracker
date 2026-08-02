'use strict';

/**
 * makeFieldFusionCorpus (2026-08-02) — bygger en TVÅKÄLLIG replay-korpus ur
 * en riktig fältprovslogg, så att frågan "hade AISHub gjort appen bättre?"
 * kan besvaras EMPIRISKT i stället för teoretiskt.
 *
 * Fältprovsloggen innehåller båda källornas råmaterial:
 *   [AIS_REPLAY_SAMPLE]      — exakt vad aisstream levererade (korpusformat)
 *   [AISHUB_RESPONSE_SAMPLE] — AISHubs kompletta svarskuvert per poll
 *
 * Genom att köra aishubParser (SAMMA parser som produktionsklienten) på
 * råsvaren och tidsstämpla posterna som AISHubClient skulle ha gjort
 * (pollAt + i×EMIT_SPREAD_MS, dedup på (mmsi, fixTs)) får vi en ström som
 * är byte-trogen mot vad appen FAKTISKT hade tagit emot i 'both'-läge.
 *
 * Kör sedan replayRunner två gånger på utfilerna:
 *   A) enbart aisstream  → reproducerar det som verkligen hände
 *   B) REPLAY_FUSION=1 på den sammanslagna → vad dubbelkälla hade gett
 * Skillnaden i notiser/texter/ETA ÄR svaret.
 *
 * Användning:
 *   node makeFieldFusionCorpus.js <app-*.log> <ut-prefix>
 * Skapar <ut-prefix>-aisstream.jsonl och <ut-prefix>-fusion.jsonl.
 */

const fs = require('fs');
const path = require('path');
const aishubParser = require(path.resolve(__dirname, '../../lib/utils/aishubParser'));
const { AIS_CONFIG } = require(path.resolve(__dirname, '../../lib/constants'));

const RESPONSE_RE = /\[AISHUB_RESPONSE_SAMPLE\]\s+(\{.*\})\s*$/;
const REPLAY_RE = /\[AIS_REPLAY_SAMPLE\]\s+(\{.*\})\s*$/;

/**
 * @param {string} logPath - sökväg till app-*.log
 * @returns {{stream: object[], hub: object[], stats: object}}
 */
function extractFieldStreams(logPath) {
  const lines = fs.readFileSync(logPath, 'utf8').split('\n');
  const stream = [];
  const hubRaw = [];
  const stats = {
    responseSamples: 0, replaySamples: 0, hubRecords: 0, hubAccepted: 0, hubDupes: 0, parseFailures: 0,
  };

  for (const line of lines) {
    const rep = REPLAY_RE.exec(line);
    if (rep) {
      try {
        const s = JSON.parse(rep[1]);
        if (s && s.mmsi && Number.isFinite(s.aisTimestamp)) {
          stream.push({ ...s, feed: s.feed || 'aisstream' });
          stats.replaySamples++;
        }
      } catch (e) { stats.parseFailures++; }
      continue;
    }
    const res = RESPONSE_RE.exec(line);
    if (res) {
      try {
        const sample = JSON.parse(res[1]);
        if (sample && typeof sample.body === 'string' && Number.isFinite(sample.pollAt)) {
          hubRaw.push(sample);
          stats.responseSamples++;
        }
      } catch (e) { stats.parseFailures++; }
    }
  }

  // Kör produktionsparsern på varje svep och tidsstämpla som klienten gör.
  const dedup = new Map(); // mmsi → senaste emitterade fixTs
  const hub = [];
  const {
    NORTH, SOUTH, EAST, WEST,
  } = AIS_CONFIG.BOUNDING_BOX;
  for (const sample of hubRaw) {
    const parsed = aishubParser.parseEnvelope(sample.body);
    if (parsed.kind !== 'data') continue;
    stats.hubRecords += parsed.records.length;
    let idx = 0;
    for (const rec of parsed.records) {
      if (rec.lat < SOUTH || rec.lat > NORTH || rec.lon < WEST || rec.lon > EAST) continue;
      const last = dedup.get(rec.mmsi);
      if (Number.isFinite(last) && rec.fixTs <= last) { stats.hubDupes++; continue; }
      dedup.set(rec.mmsi, rec.fixTs);
      hub.push({
        mmsi: rec.mmsi,
        msgType: rec.msgType,
        lat: rec.lat,
        lon: rec.lon,
        sog: rec.sog,
        cog: rec.cog,
        navStatus: rec.navStatus,
        shipName: rec.shipName,
        // Mottagningstid = pollens svarstid + batchspridningen, precis som
        // AISHubClient emitterar. fixTs = AISHubs äkta TIME.
        aisTimestamp: sample.pollAt + idx * AIS_CONFIG.AISHUB.EMIT_SPREAD_MS,
        fixTs: rec.fixTs,
        feed: 'aishub',
      });
      idx++;
      stats.hubAccepted++;
    }
  }

  return { stream, hub, stats };
}

module.exports = { extractFieldStreams };

if (require.main === module) {
  const [, , logPath, outPrefix] = process.argv;
  if (!logPath || !outPrefix) {
    process.stderr.write('Usage: node makeFieldFusionCorpus.js <app-*.log> <ut-prefix>\n');
    process.exit(1);
  }
  const { stream, hub, stats } = extractFieldStreams(logPath);
  const byTs = (a, b) => (a.aisTimestamp || 0) - (b.aisTimestamp || 0);
  const streamSorted = [...stream].sort(byTs);
  const merged = [...stream, ...hub].sort(byTs);

  fs.writeFileSync(`${outPrefix}-aisstream.jsonl`, `${streamSorted.map((s) => JSON.stringify(s)).join('\n')}\n`);
  fs.writeFileSync(`${outPrefix}-fusion.jsonl`, `${merged.map((s) => JSON.stringify(s)).join('\n')}\n`);

  const span = merged.length
    ? ((merged[merged.length - 1].aisTimestamp - merged[0].aisTimestamp) / 60000).toFixed(1)
    : '0';
  process.stdout.write(
    `Fältkorpus byggd (${span} min):\n`
    + `  aisstream-sampel: ${stats.replaySamples}\n`
    + `  AISHub-svep:      ${stats.responseSamples} (${stats.hubRecords} poster)\n`
    + `  AISHub-fixar:     ${stats.hubAccepted} accepterade, ${stats.hubDupes} re-levererade\n`
    + `  → ${outPrefix}-aisstream.jsonl (${streamSorted.length} rader)\n`
    + `  → ${outPrefix}-fusion.jsonl (${merged.length} rader)\n`,
  );
}
