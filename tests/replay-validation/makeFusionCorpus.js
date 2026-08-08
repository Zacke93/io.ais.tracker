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
 * LATENSPASSET (V4, A/B-natten 2026-08-03): deliveryDelayMs skjuter fram
 * hub-postens LEVERANSTID (aisTimestamp) utan att röra fixTs — exakt den
 * asymmetri en släpande andrakälla ger i drift. Nattens latenstest visade att
 * +30 s räckte för dubbelnotiser på målbro och +60 s gav sju dubbletter,
 * varav en 152 m EFTER passagen, medan den observerade latensen samma natt
 * hade p90 62,3 s — felmoden låg alltså INOM källans egen spridning.
 *
 * Användning (CLI):
 *   node tests/replay-validation/makeFusionCorpus.js <in.jsonl> <ut.jsonl> [delayMs]
 */

const fs = require('fs');

const DEFAULTS = {
  pollIntervalMs: 65000,
  pollOffsetMs: 32500,
  spreadMs: 150,
  maxFixAgeMs: 10 * 60 * 1000,
  // V4: 0 = leverans i pollögonblicket (drift utan lagg). > 0 fördröjer
  // ENBART leveransen; fixTs behåller pollens ögonblicksbild.
  deliveryDelayMs: 0,
};

/**
 * PARENTSTRÖMMENS KÄLLTAGG (A9c, etapp 7 — 2026-08-08).
 *
 * PROBLEMET som korpus #18 blottade: konstruktionen bygger på att parenten är
 * FÖRSTAKÄLLAN och skuggan ANDRAKÄLLAN. De 15 gamla korpusarna saknar
 * `feed`-fältet helt och tolkas därför som aisstream (replayRunner:389), så
 * antagandet höll av en tillfällighet. En AISHub-era-korpus bär `feed:"aishub"`
 * på VARJE rad — och då hamnar både parent och skugga i SAMMA hink:
 *   - F1 (monoton spärr PER KÄLLA) avvisar alla 10 086 ekon som
 *     `stale_or_duplicate_fix` INNAN F6 ens prövas;
 *   - `byReason.stale_cross_fix` blir 0;
 *   - latenspassets grind (runFusionCorpora: "F6 fyrade ALDRIG") fäller
 *     korpusen — inte för att koden är trasig utan för att provet inte längre
 *     PRÖVAR något. En grön rad hade varit ett falskt kvitto, en röd rad är ett
 *     falskt larm; båda är värdelösa.
 *
 * ÅTGÄRDEN: parentens rader taggas om till förstakällan `aisstream`; skuggan
 * förblir `aishub`. Det återställer exakt den tvåkälliga geometri provet är
 * skrivet för. Mätt på #18: `stale_cross_fix` 0 → 2 361, 135 notiser och 36
 * öppningar oförändrade.
 *
 * NOLL-DIFF FÖR DE 15 GAMLA (fas A är grön): omtaggningen rör ENDAST rader som
 * HAR ett `feed`-fält skilt från 'aisstream'. En rad utan fältet lämnas orörd —
 * inget fält läggs till — så de gamla korpusarnas sammanslagna jsonl är
 * byte-identisk med före ändringen.
 *
 * ALTERNATIVET `skipFusion: true` valdes bort: det hade tagit bort provet i
 * stället för att laga det, och just AISHub-eran är den enda ström appen
 * numera faktiskt körs på.
 *
 * OBS: detta gäller den SYNTETISKA korpusen. FÄLTKORPUSEN (A/B-nattens B-arm)
 * har äkta rader från båda källorna och byggs INTE av den här funktionen —
 * dess källtaggar är observationer och får aldrig skrivas om.
 * @param {Array<object>} samples - parentens rader
 * @returns {{rows: Array<object>, retagged: number}} omtaggad parent
 */
function retagParentAsPrimary(samples) {
  let retagged = 0;
  const rows = samples.map((s) => {
    if (!s || typeof s.feed !== 'string' || s.feed === 'aisstream') return s;
    retagged++;
    return { ...s, feed: 'aisstream' };
  });
  return { rows, retagged };
}

/**
 * @param {Array<object>} samples0 - Parsade korpusrader (kronologiska)
 * @param {object} [opts] - överskrivningar av DEFAULTS
 * @returns {{merged: Array<object>, hubCount: number, retaggedParent: number}} fusionskorpus
 */
function makeFusionCorpus(samples0, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const { rows: samples, retagged: retaggedParent } = retagParentAsPrimary(samples0);
  const positional = samples.filter((s) => !s.ctrl
    && s.mmsi != null
    && Number.isFinite(s.aisTimestamp)
    && Number.isFinite(s.lat)
    && Number.isFinite(s.lon));
  if (positional.length === 0) {
    return { merged: [...samples], hubCount: 0, retaggedParent };
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
        // Mottagningstid (poll + spridning + ev. leveranslagg). Klockdomän-
        // doktrinen: DETTA fält är mottagningstid, fixTs nedan är fixtid —
        // latenspasset skjuter bara det förra.
        aisTimestamp: pollAt + idx * cfg.spreadMs + cfg.deliveryDelayMs,
        fixTs: f.fixTs ?? f.aisTimestamp, // ÄKTA fixtid = streamens stämpel
        feed: 'aishub',
      });
      idx++;
    }
  }

  const merged = [...samples, ...hubSamples]
    .sort((a, b) => (a.aisTimestamp || 0) - (b.aisTimestamp || 0));
  return { merged, hubCount: hubSamples.length, retaggedParent };
}

module.exports = { makeFusionCorpus, retagParentAsPrimary };

if (require.main === module) {
  const [, , inPath, outPath, delayArg] = process.argv;
  if (!inPath || !outPath) {
    process.stderr.write('Usage: node makeFusionCorpus.js <in.jsonl> <ut.jsonl> [delayMs]\n');
    process.exit(1);
  }
  const deliveryDelayMs = Number(delayArg) || 0;
  const samples = fs.readFileSync(inPath, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const { merged, hubCount, retaggedParent } = makeFusionCorpus(samples, { deliveryDelayMs });
  fs.writeFileSync(outPath, `${merged.map((s) => JSON.stringify(s)).join('\n')}\n`);
  process.stdout.write(`fusionskorpus: ${samples.length} original + ${hubCount} aishub-ekon `
    + `(leveranslagg ${deliveryDelayMs} ms${retaggedParent ? `, ${retaggedParent} parentrader omtaggade till aisstream` : ''}) → ${outPath}\n`);
}
