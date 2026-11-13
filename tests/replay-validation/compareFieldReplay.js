'use strict';

/**
 * Hel-loggsrapport: node compareFieldReplay.js <app.log> <ais.jsonl> [utkatalog]
 *
 * Informativ jämförelse, inget nytt facit och ingen omlåsning. Både fältets
 * lyckade kortanrop och replayns kortanrop jämförs på tid, text, ETA, källa
 * och riktning. Försök utan leverans räknas separat. Efterspel efter loggens
 * sista tidsstämpel redovisas separat: det är inte fältets observerade utfall.
 * Jsonl från AIS_REPLAY_SAMPLE är efter fusion; REPLAY_FUSION ska vara av.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { fromUserDirection } = require('../../lib/utils/directionTokens');
const { checkPair, createTimeGapAudit } = require('./checkReplayIntegrity');
const { buildFacit } = require('./makeGtPassages');
const { validateInvariants, validateWarnInvariants } = require('./invariants');
const { analyzeCorpus, buildFairway } = require('./coverageMap');
const {
  analyseCoverage, analyseWarningAge, describeStaleWarning, describeWarningAge, loadSamples, STALE_WARNING_AGE_MS,
} = require('./runOpeningGates');
const { TARGET_BRIDGES } = require('../../lib/constants');

const ROOT = path.resolve(__dirname, '../..');
const ISO_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/;
const keyOf = (n) => `${n.mmsi}|${n.bridge}`;
const openingKeyOf = (n) => `${n.bridge}|${n.leadVessel}|${n.direction}`;

function parseFieldLog(text) {
  const tokens = new Map();
  const pending = [];
  const notifications = [];
  const openingWarnings = [];
  const bridgeTextTransitions = [];
  // V4 (2026-11-13): samma tidshålsregel som integritetsgrinden (65 s med
  // 60 s-hjärtslag, annars 180 s) i stället för en egen 180 s-kopia.
  const gapAudit = createTimeGapAudit();
  let firstMs = null;
  let stopMs = null;
  let attempts = 0;
  let textPublications = 0;
  const logLines = text.split(/\r?\n/);
  if (logLines[logLines.length - 1] === '') logLines.pop();
  const lines = logLines.length;
  let lineNumber = 0;
  for (const line of logLines) {
    lineNumber += 1;
    gapAudit.take(line, lineNumber);
    const stamp = ISO_RE.exec(line);
    if (!stamp) continue;
    const t = Date.parse(stamp[1]);
    if (!Number.isFinite(t)) throw new Error(`Ogiltig loggtid: ${stamp[1]}`);
    if (firstMs === null) firstMs = t;
    stopMs = Math.max(stopMs || t, t);
    let m = /\[FLOW_TRIGGER_SAFE_TOKENS\] (\d+): Safe tokens = (\{.*\})$/.exec(line);
    if (m) tokens.set(m[1], JSON.parse(m[2]));
    m = /\[FLOW_TRIGGER_ATTEMPT\] (\d+): bridge=(.+) \((\d+)m, source=([^)]*)\), direction=([^,]+), ETA=(-?\d+)/.exec(line);
    if (m) {
      const tok = tokens.get(m[1]);
      pending.push({
        t,
        mmsi: m[1],
        bridge: m[2],
        distance: Number(m[3]),
        source: m[4],
        direction: fromUserDirection(m[5]),
        eta: Number(m[6]),
        message: tok && tok.bridge_name === m[2] ? tok.message : null,
        alreadyPassed: tok && tok.bridge_name === m[2] ? tok.already_passed : null,
      });
      attempts++;
    }
    m = /\[FLOW_TRIGGER_SUCCESS\] (\d+): boat_near fired for (.+) \(ID=[^,]+, distance=\d+m, status=([^)]*)\)/.exec(line);
    if (m) {
      const idx = pending.findIndex((n) => n.mmsi === m[1] && n.bridge === m[2] && !n.failedAt);
      if (idx < 0) throw new Error(`Kortleverans utan läsbart försök vid ${stamp[1]}: ${m[1]} ${m[2]}`);
      notifications.push({ ...pending.splice(idx, 1)[0], successAt: t, statusAtSuccess: m[3] });
    }
    m = /\[FLOW_TRIGGER_ERROR\] (\d+): boat_near failed for (.+?) \(/.exec(line);
    if (m) {
      const n = pending.find((entry) => entry.mmsi === m[1] && entry.bridge === m[2] && !entry.failedAt);
      if (n) n.failedAt = t;
    }
    m = /\[OPENING_TRIGGER_SUCCESS\] (\S+): bridge_opening_soon avfyrad för (.+) \((\d+) båt\(ar\), ledande (.+), eta=(-?\d+ min|okänd), ([^,]+), källa (\w+)\)/.exec(line);
    if (m) {
      openingWarnings.push({
        t,
        eventId: m[1],
        bridge: m[2],
        vesselCount: Number(m[3]),
        leadVessel: m[4],
        etaMin: m[5] === 'okänd' ? -1 : Number.parseInt(m[5], 10),
        direction: fromUserDirection(m[6]),
        firedBy: m[7],
      });
    }
    m = /\[UI_UPDATE\] Bridge text updated: "(.*)"$/.exec(line);
    if (m) {
      textPublications++;
      const previous = bridgeTextTransitions[bridgeTextTransitions.length - 1];
      if (!previous || previous.text !== m[1]) bridgeTextTransitions.push({ t, text: m[1] });
    }
  }
  if (firstMs === null) throw new Error('Loggen saknar tidsstämplar');
  const gaps = gapAudit.finish().gaps.map((g) => ({
    from: g.from.t, to: g.to.t, seconds: g.ms / 1000, limitSeconds: g.limitMs / 1000, heartbeat: g.heartbeat,
  }));
  return {
    lines,
    firstMs,
    stopMs,
    gaps,
    attempts,
    notifications,
    textPublications,
    undeliveredAttempts: pending,
    openingWarnings,
    bridgeTextTransitions,
  };
}

// Bevara ordningen per identitet och para så många poster som möjligt.
// Vid bortfall/dubbletter väljs paret med minst tidsskillnad, så att en
// borttagen post inte förskjuter hela resten av jämförelsen. Inget tidstak
// får dölja en kraftigt flyttad händelse: den paras och tidsfelet redovisas.
function compareEvents(field, replay, key, fields) {
  const pairs = [];
  const unmatchedField = [];
  const unmatchedReplay = [];
  const keys = new Set([...field, ...replay].map(key));
  for (const identity of keys) {
    const a = field.filter((e) => key(e) === identity).sort((x, y) => x.t - y.t);
    const b = replay.filter((e) => key(e) === identity).sort((x, y) => x.t - y.t);
    const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1));
    for (let i = a.length; i >= 0; i--) {
      for (let j = b.length; j >= 0; j--) {
        const choices = [];
        if (i < a.length && j < b.length) {
          choices.push({
            count: dp[i + 1][j + 1].count + 1,
            cost: dp[i + 1][j + 1].cost + Math.abs(a[i].t - b[j].t),
            action: 'pair',
          });
        }
        if (i < a.length) choices.push({ ...dp[i + 1][j], action: 'field' });
        if (j < b.length) choices.push({ ...dp[i][j + 1], action: 'replay' });
        dp[i][j] = choices.sort((x, y) => y.count - x.count || x.cost - y.cost)[0]
          || { count: 0, cost: 0, action: null };
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      const { action } = dp[i][j];
      if (action === 'field') unmatchedField.push(a[i++]);
      else if (action === 'replay') unmatchedReplay.push(b[j++]);
      else {
        const f = a[i++];
        const r = b[j++];
        pairs.push({
          key: identity, deltaMs: r.t - f.t, changes: fields.filter((name) => f[name] !== r[name]), field: f, replay: r,
        });
      }
    }
  }
  pairs.sort((a, b) => a.field.t - b.field.t);
  unmatchedField.sort((a, b) => a.t - b.t);
  unmatchedReplay.sort((a, b) => a.t - b.t);
  return { pairs, unmatchedField, unmatchedReplay };
}

function splitAtStop(events, stopMs) {
  return { observed: events.filter((e) => e.t <= stopMs), afterStop: events.filter((e) => e.t > stopMs) };
}

function measureClaims(notifications, passages) {
  return notifications.filter((n) => n.eta >= 0 && n.alreadyPassed !== true).map((n) => {
    const next = passages.find((p) => p.kind === 'line' && p.mmsi === n.mmsi
      && p.bridge === n.bridge && p.tTo >= n.t
      && (n.direction === 'unknown' || p.dir === (n.direction === 'northbound' ? 'nord' : 'syd')));
    if (!next) return { notification: n, measurement: 'no-observed-crossing' };
    if (next.inferred) {
      return {
        notification: n,
        measurement: 'interval-only',
        passage: next,
        leadTimeMinutes: { from: (next.tFrom - n.t) / 60000, to: (next.tTo - n.t) / 60000 },
      };
    }
    const leadTimeMinutes = (next.t - n.t) / 60000;
    return {
      notification: n, measurement: 'point', passage: next, leadTimeMinutes, errorMinutes: n.eta - leadTimeMinutes,
    };
  });
}

/**
 * V1 (fältprovet 2026-11-13): öppningsvarningens ålder vid varje passage som
 * replayn räknar som varnad. Samma mått och gräns som replay:openings
 * (analyseWarningAge, STALE_WARNING_AGE_MS). INFORMATIVT: fältrapporten
 * ändrar aldrig exitkoden på det här. Fältfelet PRICKBJORN 12 nov hade en
 * 244,9 min gammal varning och syntes inte i någon grind.
 * @param {object} replay - replay-resultatet
 * @param {object[]} gtPassages - rådatafacit (buildFacit().passages)
 * @param {Map} samples - rå sampel per mmsi (för O1:s missklassning)
 * @returns {{limitMinutes:number, app:object, groundTruth:object}} åldersmåttet per serie
 */
function measureOpeningWarningAge(replay, gtPassages, samples) {
  const gtTarget = (gtPassages || [])
    .filter((g) => g.kind !== 'zone' && TARGET_BRIDGES.includes(g.bridge))
    .map((g) => ({
      t: g.t,
      iso: g.iso || new Date(Math.round(g.t)).toISOString(),
      mmsi: String(g.mmsi),
      bridge: g.bridge,
      inferred: g.inferred === true,
      dir: g.dir || null,
      tFrom: g.tFrom ?? null,
      tTo: g.tTo ?? null,
      source: 'gt',
    }))
    .sort((a, b) => a.t - b.t);
  const series = (covered) => {
    const age = analyseWarningAge(covered);
    return {
      total: age.total,
      fresh: age.fresh,
      bands: age.bands,
      summary: describeWarningAge(age),
      stale: age.stale.map((c) => ({
        mmsi: String(c.passage.mmsi),
        bridge: c.passage.bridge,
        passage: c.passage.iso,
        warning: new Date(c.ageWarning.t).toISOString(),
        eventId: c.ageWarning.eventId || null,
        ageMinutes: Math.round(c.ageMs / 6000) / 10,
        text: describeStaleWarning(c),
      })),
    };
  };
  return {
    limitMinutes: STALE_WARNING_AGE_MS / 60000,
    app: series(analyseCoverage(replay, samples).covered),
    groundTruth: series(analyseCoverage(replay, samples, gtTarget).covered),
  };
}

/**
 * INTEGRITETSBANNERN (V4 rev 1, granskningen 2026-11-14). Rapporten kastade
 * förr när integritetsgrinden inte var OK, så de körningar som behövde den mest
 * (fältprovet: k1 och k2 är FEL) gav ingen rapport alls. En fälld körning får
 * analyseras som fältbevis men aldrig bli facit (VALIDATION.md §Fältprov):
 * rapporten skrivs därför ändå, med verdiktet som första rad i både txt och
 * json, och kommandot behåller felkoden (samma skala som checkReplayIntegrity:
 * 1 = FEL, 3 = OKÄNT) så att ingen kan ta en fälld körning för godkänd.
 * ANROPSFEL (filerna går inte att läsa) kastar fortfarande.
 */
const INTEGRITY_EXIT = {
  OK: 0, DELVIS: 0, FEL: 1, OKÄNT: 3,
};

function integrityBanner(integrity) {
  if (integrity.verdict === 'OK') return null;
  return `🚨 LOGG-INTEGRITET: ${integrity.verdict} — FÄLTBEVIS, ALDRIG FACIT (korpuslåsning EJ tillåten). `
    + `${integrity.problems.length} problem, se nedan och "integrity" i field-report.json.`;
}

function makeReport(logPath, jsonlPath, replay) {
  const integrity = checkPair(jsonlPath, logPath, {});
  if (integrity.verdict === 'ANROPSFEL') throw new Error(`Replay-integritet ANROPSFEL: ${integrity.problems.join('; ')}`);
  const banner = integrityBanner(integrity);
  const field = parseFieldLog(fs.readFileSync(logPath, 'utf8'));
  const gt = buildFacit(jsonlPath);
  const coverage = analyzeCorpus({ id: path.basename(jsonlPath), jsonl: jsonlPath }, buildFairway());
  const notis = splitAtStop(replay.notifications, field.stopMs);
  const openings = splitAtStop(replay.openingWarnings, field.stopMs);
  const texts = splitAtStop(replay.bridgeTextTransitions, field.stopMs);
  return {
    // Första nyckeln med flit: det första en läsare av json:en ser.
    integrityBanner: banner,
    log: path.resolve(logPath),
    jsonl: path.resolve(jsonlPath),
    integrity,
    field: { ...field, firstIso: new Date(field.firstMs).toISOString(), stopIso: new Date(field.stopMs).toISOString() },
    replay: {
      sampleCount: replay.sampleCount,
      initialState: replay.initialState || { source: 'unknown' },
      processErrors: replay.processErrors,
      runtimeDiagnostics: replay.runtimeDiagnostics || null,
      targetPassages: replay.targetPassages,
      leakDiagnostics: replay.leakDiagnostics,
      invariantFailures: validateInvariants(replay),
      invariantWarnings: validateWarnInvariants(replay, gt.passages),
      suppressedTokenTimeouts: replay.suppressedTokenTimeouts,
    },
    notificationComparison: compareEvents(field.notifications, notis.observed.map((n) => ({
      ...n, distance: Number.isFinite(n.distance) ? Math.round(n.distance) : null,
    })), keyOf,
    ['direction', 'eta', 'message', 'alreadyPassed', 'source', 'distance']),
    openingComparison: compareEvents(field.openingWarnings, openings.observed, openingKeyOf,
      ['leadVessel', 'direction', 'etaMin', 'firedBy', 'vesselCount']),
    openingWarningAge: measureOpeningWarningAge(replay, gt.passages, loadSamples(jsonlPath)),
    textCounts: { field: field.bridgeTextTransitions.length, replayBeforeStop: texts.observed.length, replayTotal: replay.bridgeTextTransitions.length },
    afterStop: { notifications: notis.afterStop, openingWarnings: openings.afterStop, bridgeTextTransitions: texts.afterStop },
    groundTruth: gt,
    coverage: {
      samplesByFeed: integrity.feeds.reduce((counts, [feed, count]) => ({ ...counts, [feed]: count }), {}),
      fixLatencySeconds: coverage.latency,
      blackoutsByView: coverage.blackouts.reduce((counts, b) => ({
        ...counts, [b.source]: (counts[b.source] || 0) + 1,
      }), {}),
      worstBlackouts: [...coverage.blackouts].sort((a, b) => b.gapSec - a.gapSec).slice(0, 10),
      vessels: coverage.vessels,
      outOfCorridor: coverage.outOfCorridor,
    },
    etaClaims: measureClaims(field.notifications, gt.passages),
    limitations: [
      'Informativ rapport: fältlikhet är inte bevis för korrekt produktbeteende.',
      'Notistid mäts vid försök att avfyra; successAt är separat leveranskvittens. Rådatatider ligger i mottagningsdomänen.',
      'Efterspel är hypotetisk fortsatt körning utan fler AIS-fixar. Det ingår i läckagekontrollen, inte i fältjämförelsen.',
      'Jsonl är efter fusion: avvisade fixar och vessel-seen-livstecken återspelas inte.',
      replay.initialState?.source === 'recorded'
        ? 'Inspelat, icke-hemligt startminne återställs. Detta återger inte nätkontakt eller telefonleverans.'
        : 'Inspelat startminne saknas: tidigare inlärda kajplatser och notisminnen kan skilja sig från fältet.',
      replay.runtimeDiagnostics?.monitoringEnabled
        ? 'Monitoring/stale-svepet körs. Källorna är oanslutna testklienter; nätkontakt och källhälsa simuleras inte.'
        : 'Monitoring/stale-svepet är avstängt i denna replay (kan prövas separat med REPLAY_MONITORING=1).',
      'AISStreams fixtid är mottagningstid: rapportens nollatens är inte uppmätt radiolatens. Blackouts räknas per källvy; samma glapp kan finnas i flera vyer.',
      'Fältstopp är sista loggtiden. Logg och jsonl kan ha tappat samma svans före lagring utan att integritetsgrinden ser det.',
      'Poster paras i ordning per fartyg+bro, öppningar per bro+ledarnamn+riktning. Ändrat namn eller konvojledning kan ge oparade poster som kräver manuell granskning.',
    ],
  };
}

/** Textraderna för åldersmåttet (WARN, informativt). */
function formatOpeningWarningAge(age) {
  if (!age) return [];
  return [
    `Öppningsvarningens ålder vid passage (WARN, informativ, gräns ${age.limitMinutes} min = O2:s senpassagefönster): `
      + `appserien ${age.app.summary}; rådataserien ${age.groundTruth.summary}.`,
    ...age.app.stale.map((s) => `  ⚠️ GAMMAL VARNING (appserien): ${s.text}`),
    ...age.groundTruth.stale.map((s) => `  ⚠️ GAMMAL VARNING (rådataserien): ${s.text}`),
  ];
}

function summarize(r) {
  const n = r.notificationComparison;
  const o = r.openingComparison;
  const maxDelta = n.pairs.length ? Math.max(...n.pairs.map((p) => Math.abs(p.deltaMs))) / 1000 : null;
  return [
    ...(r.integrityBanner ? [r.integrityBanner, ...r.integrity.problems.map((v) => `  ✗ ${v}`), ''] : []),
    `Fält ${r.field.firstIso} → ${r.field.stopIso}: ${r.field.lines} loggrader, ${r.integrity.jsonlComplete} kompletta AIS-sampel.`,
    `Integritet: ${r.integrity.verdict}; tidshål: ${r.field.gaps.length} (gräns 65 s med 60 s-hjärtslag, annars 180 s).`,
    `Notiser: ${n.pairs.length} parade, ${n.pairs.filter((p) => p.changes.length).length} innehållsändrade, `
      + `${n.unmatchedField.length} saknas i replay, ${n.unmatchedReplay.length} extra; max tidsskillnad ${maxDelta}s.`,
    `Öppningar före fältstopp: ${o.pairs.length} parade, ${o.pairs.filter((p) => p.changes.length).length} innehållsändrade; `
      + `${o.unmatchedField.length} saknas, ${o.unmatchedReplay.length} extra. Efter stopp: ${r.afterStop.openingWarnings.length}.`,
    `Brotexter: ${r.textCounts.field} fält, ${r.textCounts.replayBeforeStop} replay före stopp, ${r.textCounts.replayTotal} inklusive efterspel.`,
    ...formatOpeningWarningAge(r.openingWarningAge),
    `Replay: ${r.replay.targetPassages.length} målbropassager, ${r.replay.processErrors} processfel, `
      + `${r.replay.invariantFailures.length} fatala invariantutslag, ${r.replay.invariantWarnings.length} WARN.`,
    ...r.replay.invariantFailures.map((v) => `  INVARIANT: ${v}`),
    `Rådatafacit: ${r.groundTruth.stats.crossings} korsningar/zonbesök, ${r.groundTruth.stats.inferred} tidsintervall.`,
    ...r.limitations.map((v) => `Begränsning: ${v}`),
  ].join('\n');
}

function main(argv) {
  const [logPath, jsonlPath, out = path.join(os.tmpdir(), 'ais-field-report')] = argv;
  if (!logPath || !jsonlPath || argv.length > 3) throw new Error('Användning: compareFieldReplay.js <app.log> <ais.jsonl> [utkatalog]');
  const run = spawnSync(process.execPath, [path.join(__dirname, 'replayRunner.js'), path.resolve(jsonlPath)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env, REPLAY_FUSION: '0', REPLAY_VERBOSE: '', REPLAY_DEBUG_LEVEL: 'off',
    },
  });
  if (run.error || run.status !== 0) throw new Error(`Replay misslyckades: ${run.error ? run.error.message : run.stderr || run.stdout}`);
  const match = /__REPLAY_JSON__(.*)__END__/s.exec(run.stdout);
  if (!match) throw new Error('Replay-utdata saknar kompletta JSON-markörer');
  const report = makeReport(logPath, jsonlPath, JSON.parse(match[1]));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'field-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'field-report.txt'), `${summarize(report)}\n`);
  fs.writeFileSync(path.join(out, 'replay-stderr.log'), run.stderr);
  console.log(`${summarize(report)}\nRapport: ${path.resolve(out)}`);
  // Felkoden står kvar för en fälld körning (se integrityBanner).
  return INTEGRITY_EXIT[report.integrity.verdict] ?? 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

module.exports = {
  parseFieldLog,
  compareEvents,
  openingKeyOf,
  splitAtStop,
  measureClaims,
  measureOpeningWarningAge,
  formatOpeningWarningAge,
  integrityBanner,
  makeReport,
  summarize,
};
