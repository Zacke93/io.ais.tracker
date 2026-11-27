'use strict';

/**
 * U71: bygger syntetiska fältloggar med appens RIKTIGA fångstjournal
 * (lib/utils/CaptureJournal.js), så att grinden prövas mot exakt det appen
 * skriver. Inga fältdata: båtnamn, MMSI och positioner är påhittade.
 *
 * Takten följer fältloggarna: en skur var 30:e sekund (vakthunden), ett
 * minutslag 60,2 s efter start (hjärtslaget + journalens tick), en AISHub-poll
 * var 67:e sekund och, under en passage, en AISstream-position var 20:e sekund.
 */

const { CaptureJournal } = require('../../lib/utils/CaptureJournal');

const PREFIX = '[log] [AISBridgeApp] ';
const ERR_PREFIX = '[err] [AISBridgeApp] ';
const HEARTBEAT = '[DEBUG] 🧹 [COORDINATION_CLEANUP] Cleaned old coordination state';

/**
 * @param {Object} opts
 * @param {number} opts.startMs
 * @param {number} opts.minutes
 * @param {Array} [opts.segments] - [{ atMin, kind: 'boot'|'boot-basic'|'level-on'|'level-off' }];
 *   standard: en start vid minut 0 på full nivå.
 * @param {Array} [opts.passages] - [[fromMin, toMin]] med tätare positioner
 * @param {number} [opts.maxEntries]
 * @param {string} [opts.hubName] - lotsbåtens namn (standard TESTLOTS)
 * @param {Array} [opts.events] - [{ atMin, message, err }]
 * @returns {{ lines: Array<{t:number,line:string}>, journals: CaptureJournal[] }}
 */
function simulateLog(opts) {
  const startMs = opts.startMs || Date.UTC(2026, 10, 20, 15, 0, 0);
  const endMs = startMs + opts.minutes * 60000;
  const segments = (opts.segments || [{ atMin: 0, kind: 'boot' }])
    .map((s) => ({ ...s, t: startMs + s.atMin * 60000 }));
  const passages = (opts.passages || []).map(([a, b]) => [startMs + a * 60000, startMs + b * 60000]);
  const out = [];
  const journals = [];
  let now = startMs;
  let journal = null;
  let bootMs = null;
  let epoch = 0;
  let level = 'full';
  const write = (line, err) => out.push({ t: now, line: `${new Date(now).toISOString()} ${err ? ERR_PREFIX : PREFIX}${line}` });
  const mk = () => {
    epoch += 1;
    const j = new CaptureJournal({
      log: (l) => write(l, false),
      error: (l) => write(l, true),
      now: () => now,
      bootMs,
      epoch,
      maxEntries: opts.maxEntries,
    });
    journals.push(j);
    return j;
  };

  const actions = [];
  for (const s of segments) actions.push({ t: s.t, kind: s.kind, order: 0 });
  for (let t = startMs + 30000; t < endMs; t += 30000) actions.push({ t, kind: 'burst', order: 2 });
  for (let t = startMs + 25000; t < endMs; t += 67000) actions.push({ t, kind: 'hub', order: 3 });
  // AISHub-bokföringen som grinden läser: pollraden före fixen, hälsoraden var 5:e min.
  for (let t = startMs + 300000; t < endMs; t += 300000) actions.push({ t, kind: 'health', order: 5 });
  for (const [a, b] of passages) {
    for (let t = a + 7000; t < Math.min(b, endMs); t += 20000) actions.push({ t, kind: 'stream', order: 3 });
  }
  for (const e of opts.events || []) {
    actions.push({
      t: startMs + e.atMin * 60000, kind: 'event', e, order: 4,
    });
  }
  actions.sort((x, y) => x.t - y.t || x.order - y.order);

  let n = 0;
  let hubPolls = 0;
  let hubAccepted = 0;
  const pending = actions.slice();
  // Minutslagen räknas från varje boot (60,2 s efter start), som i fältet.
  const ticks = [];
  const isBoot = (x) => x.kind === 'boot' || x.kind === 'boot-basic';
  for (const s of segments.filter(isBoot)) {
    const next = segments.find((x) => isBoot(x) && x.t > s.t);
    const stop = next ? next.t : endMs;
    for (let t = s.t + 60200; t < stop; t += 60000) ticks.push({ t, kind: 'tick', order: 1 });
  }
  const all = pending.concat(ticks).sort((x, y) => x.t - y.t || x.order - y.order);
  for (const a of all) {
    now = a.t;
    if (a.kind === 'boot-basic') level = 'basic'; // omstart där nivån inte längre är full
    if (a.kind === 'boot' || a.kind === 'boot-basic') {
      if (journal) journal = null; // processen dog utan slut (omstart)
      bootMs = now;
      epoch = 0;
      hubPolls = 0;
      hubAccepted = 0;
      write('AIS Bridge starting with modular architecture v2.0');
      // Som appen: starttillståndet utan nummer när nivån inte är full (B1).
      if (level !== 'full') write(`[AIS_REPLAY_STATE] {"version":1,"capturedAt":${now},"settings":{"debug_level":"${level}"}}`);
      if (level === 'full') {
        journal = mk();
        journal.start('boot');
      }
    } else if (a.kind === 'level-off') {
      level = 'basic';
      write('🎛️ Debug level changed to: basic');
      if (journal) {
        const j = journal;
        journal = null;
        j.end('level');
      }
    } else if (a.kind === 'level-on') {
      level = 'full';
      write('🎛️ Debug level changed to: full');
      if (!journal) {
        journal = mk();
        journal.start('level');
      }
    } else if (a.kind === 'tick') {
      if (level === 'full' || level === 'detailed') write(HEARTBEAT);
      else write('📊 [AISHUB_STATUS] syntetisk rad på basic-nivå');
      if (journal) journal.tick();
    } else if (a.kind === 'burst') {
      if (level === 'full') {
        write('[DEBUG] 🐕 [WATCHDOG] Running self-healing check (2 vessels)');
        write('[DEBUG] 📱 [UI_UPDATE] Bridge text unchanged x2 (last 60s)');
      }
    } else if (a.kind === 'health') {
      write(`📊 [AISHUB_HEALTH] polls=${hubPolls} emptyResponses=0 (0.00%) netErrors=0 accepted=${hubAccepted} dedupSize=1`);
    } else if (a.kind === 'hub' || a.kind === 'stream') {
      n += 1;
      if (a.kind === 'hub') {
        hubPolls += 1;
        hubAccepted += 1;
        write('📊 [AISHUB_POLL] records=1 accepted=1 dupes=0 seen=0 outOfBox=0 futureJunk=0 staleFixes=0 httpMs=90 dupesTotal=0');
      }
      const sample = {
        mmsi: a.kind === 'hub' ? '999000001' : '999000002',
        msgType: a.kind === 'hub' ? 'AISHubPosition' : 'PositionReport',
        lat: 58.27 + n / 100000,
        lon: 12.27,
        sog: a.kind === 'hub' ? 0 : 4.2,
        cog: 10,
        shipName: a.kind === 'hub' ? (opts.hubName || 'TESTLOTS') : 'TESTBÅT Å',
        feed: a.kind === 'hub' ? 'aishub' : 'aisstream',
        receivedAt: new Date(now).toISOString(),
      };
      if (journal) journal.record(`[AIS_REPLAY_SAMPLE] ${JSON.stringify(sample)}`);
      else if (opts.plainWhenInactive && level === 'full') write(`[AIS_REPLAY_SAMPLE] ${JSON.stringify(sample)}`);
    } else if (a.kind === 'event') {
      if (journal) journal.record(a.e.message, a.e.err ? 'err' : 'log');
      else write(a.e.message, a.e.err);
    }
  }
  return { lines: out, journals, startMs };
}

/** Tar bort alla rader med tid i [fromMs, toMs). */
function cutHole(lines, fromMs, toMs) {
  return lines.filter((l) => l.t < fromMs || l.t >= toMs);
}

const text = (lines) => `${lines.map((l) => l.line).join('\n')}\n`;

module.exports = {
  simulateLog, cutHole, text, HEARTBEAT,
};
