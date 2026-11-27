'use strict';

/**
 * U71 (omgång 9): grinden för en löpnummerlogg. Loggarna byggs med appens
 * riktiga journal (tests/fixtures/journalLogSim.js) och förvanskas sedan.
 * Ett falskt godkänt är värre än ett prov som inte kan låsas, så varje
 * villkor har ett fall som ska ge FEL, och motfallen ska ge OK.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkPair } = require('./replay-validation/checkReplayIntegrity');
const { healLogFile } = require('./replay-validation/captureJournal');
const { simulateLog, cutHole, text } = require('./fixtures/journalLogSim');

const MIN = 60000;
let dir;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u71-gate-'));
});
afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
/** Skriver loggen, läker jsonl som skriptet gör och kör grinden. */
function judge(lines, opts = {}) {
  counter += 1;
  const logPath = path.join(dir, `app-${counter}.log`);
  const jsonlPath = path.join(dir, `ais-${counter}.jsonl`);
  fs.writeFileSync(logPath, typeof lines === 'string' ? lines : text(lines));
  const healed = healLogFile(logPath).healedSamples;
  const jsonl = opts.jsonl !== undefined ? opts.jsonl : healed;
  fs.writeFileSync(jsonlPath, jsonl.length ? `${jsonl.join('\n')}\n` : '');
  const r = checkPair(jsonlPath, logPath, {});
  r.healed = healed;
  return r;
}

const problemsText = (r) => r.problems.join('\n');
const healedNotes = (r) => r.notes.filter((n) => n.startsWith('TIDSHÅL LÄKT'));

const base = (extra = {}) => simulateLog({ minutes: 60, passages: [[10, 40]], ...extra });
const isResendOf = (line, seq) => line.includes('[CAPTURE_RESEND]') && line.includes(`"seq":${seq},`);
const origLineOf = (lines, seq) => lines.findIndex((l) => new RegExp(`\\] #[0-9a-z]+-\\d+:${seq} `).test(l.line));

describe('U71 grinden: hela körningar', () => {
  test('utan hål: OK, och läkt jsonl är byte-lik grep+sed av originalen', () => {
    const { lines } = base();
    const r = judge(lines);
    expect(r.verdict).toBe('OK');
    const grepSed = lines.filter((l) => l.line.includes('AIS_REPLAY_SAMPLE'))
      .map((l) => l.line.replace(/^.*AIS_REPLAY_SAMPLE\] /, ''));
    expect(r.healed).toEqual(grepSed);
    expect(r.notes).toContain('Läkta tidshål (U71): 0 av 0');
  });

  test('de nio uppmätta hålen (79–180 s, k1:s tre inom tio minuter) läks alla, jsonl byte-lik en obruten fångst', () => {
    const { lines, startMs } = simulateLog({ minutes: 420, passages: [[20, 60], [150, 190], [300, 330]] });
    const unbroken = healLogFile((() => {
      const p = path.join(dir, 'unbroken.log');
      fs.writeFileSync(p, text(lines));
      return p;
    })()).healedSamples;
    // [start i min (på en skur, +1 ms), längd i s]: samma längder och k1:s avstånd (3 och 7,25 min).
    const holes = [
      [30, 90], [33, 90], [37.25, 156], // k1 20:37:30, 20:40:30, 20:44:45
      [90, 90], [160, 88], // k2
      [200, 90], [250, 90], [310, 180], // k3
      [380, 79], // k4
    ];
    let cut = lines;
    for (const [m, s] of holes) cut = cutHole(cut, startMs + m * MIN + 1, startMs + m * MIN + 1 + s * 1000);
    const r = judge(cut);
    expect(problemsText(r)).toBe('');
    expect(r.verdict).toBe('OK');
    expect(healedNotes(r)).toHaveLength(9);
    expect(r.notes).toContain('Läkta tidshål (U71): 9 av 9');
    for (const n of healedNotes(r)) expect(n).toMatch(/[1-9]\d* post\(er\) från hålet återställda/);
    // Pollraderna i hålen saknas, och underskottet är förklarat av de läkta hålen.
    expect(r.notes.filter((n) => n.startsWith('Källbokföringens underskott inom ett läkt tidshål')).length).toBeGreaterThan(0);
    expect(r.healed).toEqual(unbroken);
  });

  test('hål på fem och nio minuter läks', () => {
    for (const minutes of [5, 9]) {
      const { lines, startMs } = base();
      const r = judge(cutHole(lines, startMs + 20 * MIN + 1, startMs + (20 + minutes) * MIN));
      expect(problemsText(r)).toBe('');
      expect(r.verdict).toBe('OK');
      expect(healedNotes(r)).toHaveLength(1);
    }
  });

  test('omstart utan hål: OK (två strömmar)', () => {
    const { lines } = base({ segments: [{ atMin: 0, kind: 'boot' }, { atMin: 30.1, kind: 'boot' }] });
    const r = judge(lines);
    expect(problemsText(r)).toBe('');
    expect(r.journal.streams).toHaveLength(2);
  });

  test('full nivå först mitt i körningen: OK (fångsten börjar där)', () => {
    const { lines } = base({ segments: [{ atMin: 0, kind: 'level-off' }, { atMin: 0, kind: 'boot' }, { atMin: 12.3, kind: 'level-on' }] });
    const r = judge(lines);
    expect(problemsText(r)).toBe('');
  });

  test('släppta poster utan hål: OK med notis', () => {
    const { lines } = base({ maxEntries: 3 });
    const r = judge(lines);
    expect(problemsText(r)).toBe('');
    expect(r.notes.join('\n')).toMatch(/släpptes ur bufferten/);
  });
});

describe('U71 grinden: förvanskade loggar ger FEL', () => {
  test('ett sampel borta och aldrig omsänt', () => {
    const { lines } = base();
    const i = origLineOf(lines, 20);
    const cut = lines.filter((l, k) => k !== i && !isResendOf(l.line, 20));
    const r = judge(cut);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/1 post\(er\) saknas och kunde inte läkas \(nummer 20\)/);
  });

  test('ett tidshål där omsändningarna också är borta', () => {
    const { lines, startMs } = base();
    let cut = cutHole(lines, startMs + 20 * MIN + 1, startMs + 21.5 * MIN);
    const lost = lines.filter((l) => l.t >= startMs + 20 * MIN + 1 && l.t < startMs + 21.5 * MIN)
      .map((l) => /:(\d+) \[AIS_REPLAY_SAMPLE\]/.exec(l.line)).filter(Boolean).map((m) => Number(m[1]));
    expect(lost.length).toBeGreaterThan(0);
    cut = cut.filter((l) => !lost.some((s) => isResendOf(l.line, s)));
    const r = judge(cut);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/TIDSHÅL I LOGGEN.*Löpnumren läker det inte/);
    expect(problemsText(r)).toMatch(/saknas och kunde inte läkas/);
  });

  test('hål längre än omsändningen täcker (12 min med sampel i)', () => {
    const { lines, startMs } = base();
    const r = judge(cutHole(lines, startMs + 15 * MIN + 1, startMs + 27 * MIN));
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/saknas och kunde inte läkas/);
    expect(problemsText(r)).toMatch(/TIDSHÅL I LOGGEN/);
  });

  test('löpnummer i fel ordning (två original bytta)', () => {
    const { lines } = base();
    const a = origLineOf(lines, 10);
    const b = origLineOf(lines, 11);
    const sw = lines.slice();
    [sw[a], sw[b]] = [sw[b], sw[a]];
    const r = judge(sw);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/fel ordning/);
  });

  test('samma nummer med olika innehåll (omsändningen ändrad)', () => {
    const { lines } = base();
    const k = lines.findIndex((l) => isResendOf(l.line, 15));
    const m = lines.slice();
    const payload = JSON.parse(m[k].line.slice(m[k].line.indexOf('{')));
    payload.b64 = Buffer.from('[AIS_REPLAY_SAMPLE] {"mmsi":"1"}').toString('base64');
    m[k] = { ...m[k], line: `${m[k].line.slice(0, m[k].line.indexOf('{'))}${JSON.stringify(payload)}` };
    const r = judge(m);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/nummer 15 förekommer med olika innehåll/);
  });

  test('samma nummer två gånger som original med olika innehåll', () => {
    const { lines } = base();
    const i = origLineOf(lines, 12);
    const m = lines.slice();
    m.splice(i + 1, 0, { t: m[i].t, line: m[i].line.replace(/"lat":[0-9.]+/, '"lat":1') });
    const r = judge(m);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/två gånger som original|olika innehåll/);
  });

  test('omstart (ny boot) mitt i ett hål', () => {
    const { lines, startMs } = base({ segments: [{ atMin: 0, kind: 'boot' }, { atMin: 30.1, kind: 'boot' }] });
    const r = judge(cutHole(lines, startMs + 29.5 * MIN + 1, startMs + 31 * MIN));
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/strömmen byttes i hålet/);
  });

  test('kontrollpunkt saknas (en rad borttagen, inget tidshål)', () => {
    const { lines } = base();
    const cps = lines.map((l, i) => (l.line.includes('[CAPTURE_SEQ]') ? i : -1)).filter((i) => i >= 0);
    const r = judge(lines.filter((_, i) => i !== cps[20]));
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/kontrollpunkt saknas/);
  });

  test('hål i slutet av körningen, före omsändningen', () => {
    const { lines, startMs } = base({ minutes: 40 });
    const r = judge(cutHole(lines, startMs + 38 * MIN + 1, startMs + 39.5 * MIN));
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/saknas och kunde inte läkas/);
  });

  // Ett "tyst" hål utan journalposter i: AISHub-pollen 695 s och 762 s efter
  // start står på var sin sida, och hålet sväljer bara skurar och ett minutslag.
  const quietHole = (lines, startMs) => cutHole(lines, startMs + 695001, startMs + 761000);

  test('motfall: ett tyst hål med kontrollpunkt efter läks', () => {
    const { lines, startMs } = simulateLog({ minutes: 30 });
    const r = judge(quietHole(lines, startMs));
    expect(problemsText(r)).toBe('');
    expect(healedNotes(r)).toHaveLength(1);
  });

  test('ingen kontrollpunkt efter hålet (strömmen slutar strax efter)', () => {
    const { lines, startMs } = simulateLog({ minutes: 30, segments: [{ atMin: 0, kind: 'boot' }, { atMin: 770 / 60, kind: 'level-off' }] });
    const r = judge(quietHole(lines, startMs));
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/Löpnumren läker det inte: ingen kontrollpunkt efter hålet/);
    expect(problemsText(r)).not.toMatch(/saknas och kunde inte läkas|kontrollpunkt saknas/);
  });

  test('släppta poster och ett hål (inget saknas, men bufferten hade släppt)', () => {
    const { lines, startMs } = simulateLog({ minutes: 30, maxEntries: 2 });
    const r = judge(quietHole(lines, startMs));
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/Löpnumren läker det inte: bufferten hade släppt/);
    expect(problemsText(r)).not.toMatch(/saknas och kunde inte läkas/);
  });

  test('släppta poster och ett hål med poster i', () => {
    const { lines, startMs } = base({ maxEntries: 3 });
    const r = judge(cutHole(lines, startMs + 20 * MIN + 1, startMs + 21.5 * MIN));
    expect(r.verdict).toBe('FEL');
  });

  test('fångsten avstängd mitt i körningen (full → basic → full)', () => {
    const { lines } = base({ segments: [{ atMin: 0, kind: 'boot' }, { atMin: 20.4, kind: 'level-off' }, { atMin: 25.4, kind: 'level-on' }] });
    const r = judge(lines);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/fångsten stängdes av/);
  });

  test('sampel utan löpnummer i en löpnummerlogg', () => {
    const { lines } = base();
    const i = origLineOf(lines, 30);
    const m = lines.slice();
    m.splice(i + 1, 0, { t: m[i].t, line: m[i].line.replace(/#[0-9a-z]+-\d+:30 /, '') });
    const r = judge(m);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/saknar löpnummer/);
  });

  test('starten saknas', () => {
    const { lines } = base();
    const i = origLineOf(lines, 1);
    const r = judge(lines.filter((l, k) => k !== i && !isResendOf(l.line, 1)));
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/starten saknas/);
  });

  test('rader efter strömmens slut', () => {
    const { lines } = base({ segments: [{ atMin: 0, kind: 'boot' }, { atMin: 50.4, kind: 'level-off' }] });
    const i = origLineOf(lines, 5);
    const m = lines.slice();
    m.push({ t: m[m.length - 1].t, line: m[i].line.replace(/:5 /, ':999 ') });
    const r = judge(m);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/efter strömmens slut/);
  });

  test('kontrollpunkt som sjunker eller ligger under ett sett original', () => {
    const { lines } = base();
    const cps = lines.map((l, i) => (l.line.includes('[CAPTURE_SEQ]') ? i : -1)).filter((i) => i >= 0);
    const m = lines.slice();
    m[cps[30]] = { ...m[cps[30]], line: m[cps[30]].line.replace(/ seq=\d+ /, ' seq=3 ') };
    const r = judge(m);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/kontrollpunkten sjönk|ligger under redan sett original/);
  });

  test('oläslig journalrad', () => {
    const { lines } = base();
    const k = lines.findIndex((l) => isResendOf(l.line, 8));
    const m = lines.slice();
    m[k] = { ...m[k], line: m[k].line.replace(/"b64":"/, '"b64":"!!') };
    const r = judge(m);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/journalrad\(er\) går inte att läsa/);
  });

  test('en förlorad pollrad utan tidshål fäller fortfarande (källbokföringen)', () => {
    const { lines } = base();
    const polls = lines.map((l, i) => (l.line.includes('[AISHUB_POLL]') ? i : -1)).filter((i) => i >= 0);
    const r = judge(lines.filter((_, i) => i !== polls[10]));
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/KÄLLOGGEN ÄR OFULLSTÄNDIG/);
  });

  test('jsonl som inte är den läkta fångsten', () => {
    const { lines, startMs } = base();
    const cut = cutHole(lines, startMs + 20 * MIN + 1, startMs + 21.5 * MIN);
    const grepSed = cut.filter((l) => l.line.includes('AIS_REPLAY_SAMPLE'))
      .map((l) => l.line.replace(/^.*AIS_REPLAY_SAMPLE\] /, ''));
    const r = judge(cut, { jsonl: grepSed });
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/SAKNAS i jsonl/);
  });
});

describe('U71 grinden: loggar utan löpnummer döms som förut', () => {
  test('ett tidshål i en gammal logg fäller med samma text som förut', () => {
    const t0 = Date.UTC(2026, 10, 20, 15, 0, 0);
    const lines = [];
    for (let s = 0; s < 600; s += 30) {
      lines.push(`${new Date(t0 + s * 1000).toISOString()} [log] [AISBridgeApp] [DEBUG] 🧹 [COORDINATION_CLEANUP] Cleaned old coordination state`);
      lines.push(`${new Date(t0 + s * 1000).toISOString()} [log] [AISBridgeApp] [AIS_REPLAY_SAMPLE] {"mmsi":"1","n":${s}}`);
    }
    const holed = lines.filter((l) => !(l.slice(0, 19) > '2026-11-20T15:03:00' && l.slice(0, 19) < '2026-11-20T15:04:40'));
    const r = judge(`${holed.join('\n')}\n`);
    expect(r.verdict).toBe('FEL');
    expect(r.journal).toBeUndefined();
    expect(problemsText(r)).toMatch(/TIDSHÅL I LOGGEN: .*Rader har tappats mellan appen och filen\.$/m);
    expect(problemsText(r)).not.toMatch(/U71|Löpnumren/);
  });
});

describe('U71: händelser och starttillstånd ur omsändningarna', () => {
  const { parseFieldLog } = require('./replay-validation/compareFieldReplay');
  const notice = [
    { atMin: 20.5, message: '[DEBUG] 🔍 [FLOW_TRIGGER_SAFE_TOKENS] 999000002: Safe tokens = {"bridge_name":"Klaffbron","message":"testnotis","already_passed":false}' },
    { atMin: 20.5, message: '🚀 [FLOW_TRIGGER_ATTEMPT] 999000002: bridge=Klaffbron (240m, source=target), direction=norrut, ETA=4' },
    { atMin: 20.51, message: '✅ [FLOW_TRIGGER_SUCCESS] 999000002: boat_near fired for Klaffbron (ID=klaffbron, distance=240m, status=waiting)' },
    { atMin: 20.6, message: '📱 [UI_UPDATE] Bridge text updated: "En båt på väg mot Klaffbron, beräknad broöppning om 4 minuter"' },
  ];

  test('en notis och ett textbyte i ett läkt hål syns i fältjämförelsen; hålet redovisas ändå', () => {
    const { lines, startMs } = base({ events: notice });
    const cut = cutHole(lines, startMs + 20 * MIN + 1, startMs + 21.5 * MIN);
    const p = path.join(dir, 'events.log');
    fs.writeFileSync(p, text(cut));
    const heal = healLogFile(p);
    const without = parseFieldLog(text(cut));
    const withRestored = parseFieldLog(text(cut), heal.restoredLines);
    expect(without.notifications).toHaveLength(0);
    expect(withRestored.notifications).toHaveLength(1);
    expect(withRestored.notifications[0]).toMatchObject({ mmsi: '999000002', bridge: 'Klaffbron', message: 'testnotis' });
    expect(withRestored.bridgeTextTransitions.map((x) => x.text)).toContain('En båt på väg mot Klaffbron, beräknad broöppning om 4 minuter');
    expect(withRestored.gaps).toHaveLength(1);
    expect(withRestored.lines).toBe(without.lines);
    const full = parseFieldLog(text(lines));
    expect(withRestored.notifications[0].t).toBe(full.notifications[0].t);
  });

  test('starttillståndet läks om originalraden försvann', () => {
    const state = '{"version":1,"capturedAt":5,"settings":{"x":1}}';
    const { lines, startMs } = base({ events: [{ atMin: 0.001, message: `[AIS_REPLAY_STATE] ${state}` }] });
    const p = path.join(dir, 'state.log');
    fs.writeFileSync(p, text(lines));
    expect(healLogFile(p).state).toBe(state);
    fs.writeFileSync(p, text(cutHole(lines, startMs + 1, startMs + 80000)));
    expect(healLogFile(p).state).toBe(state);
  });
});

// Mutationsprovet (o9/L/verktyg/mutation.js) visade villkor som bara fälldes
// tillsammans med andra. Fallen nedan prövar vart och ett för sig.
describe('U71 grinden: varje ordningsvillkor för sig', () => {
  const journalIdx = (lines) => lines.map((l, i) => (/\] #[0-9a-z]+-\d+:\d+ |\[CAPTURE_/.test(l.line) ? i : -1)).filter((i) => i >= 0);
  const seqOf = (line) => Number(/\] #[0-9a-z]+-\d+:(\d+) /.exec(line)[1]);
  const isOrig = (line) => /\] #[0-9a-z]+-\d+:\d+ /.test(line);
  const ERR = '❌ [FLOW_TRIGGER_ERROR] 999000002: boat_near failed for Klaffbron (ID=klaffbron, distance=240m, status=waiting): nekad';

  // Ett minutfönster utan AISHub-poll (pollar var 67:e s från 25 s, minutslag 60,2 s + 60 k).
  const quietWindowMin = (() => {
    for (let k = 5; k < 50; k += 1) {
      const a = 60.2 + 60 * k;
      const b = a + 60;
      let hit = false;
      for (let t = 25; t < b; t += 67) if (t > a && t < b) hit = true;
      if (!hit) return (a + 5) / 60;
    }
    throw new Error('inget tyst fönster');
  })();

  test('original efter en kontrollpunkt som redan täckte det (stdout, i stigande ordning)', () => {
    const { lines } = base();
    // Ett original där nästa journalrad (utom omsändningar) är en kontrollpunkt.
    const idx = journalIdx(lines).filter((i) => !lines[i].line.includes('[CAPTURE_RESEND]'));
    const p = idx.findIndex((i, n) => n > 50 && isOrig(lines[i].line) && !lines[i].line.includes('[err]')
      && n + 1 < idx.length && lines[idx[n + 1]].line.includes('[CAPTURE_SEQ]'));
    expect(p).toBeGreaterThan(0);
    const o = idx[p];
    const cp = idx[p + 1];
    const m = lines.slice();
    const [moved] = m.splice(o, 1);
    m.splice(cp, 0, moved); // efter kontrollpunkten (som flyttat ett steg upp)
    const r = judge(m);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/efter en kontrollpunkt som redan täckte/);
    expect(problemsText(r)).not.toMatch(/fel ordning/);
  });

  test('ett stderr-original efter sin omsändning', () => {
    const { lines } = base({ events: [{ atMin: 20.3, message: ERR, err: true }] });
    const o = lines.findIndex((l) => l.line.includes('[err]') && isOrig(l.line));
    const seq = seqOf(lines[o].line);
    const rs = lines.findIndex((l) => isResendOf(l.line, seq));
    const m = lines.slice();
    const [moved] = m.splice(o, 1);
    m.splice(rs, 0, moved);
    const r = judge(m);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(new RegExp(`original ${seq} kommer efter sin omsändning`));
  });

  test('samma stderr-original två gånger med samma innehåll', () => {
    const { lines } = base({ events: [{ atMin: 20.3, message: ERR, err: true }] });
    const o = lines.findIndex((l) => l.line.includes('[err]') && isOrig(l.line));
    const m = lines.slice();
    m.splice(o + 1, 0, { ...m[o] });
    const r = judge(m);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/förekommer två gånger som original/);
    expect(problemsText(r)).not.toMatch(/olika innehåll|fel ordning/);
  });

  test('kontrollpunkt under ett redan sett original (men inte lägre än förra)', () => {
    const { lines } = base();
    const cps = lines.map((l, i) => (l.line.includes('[CAPTURE_SEQ]') ? i : -1)).filter((i) => i >= 0);
    const val = (i) => Number(/ seq=(\d+) /.exec(lines[i].line)[1]);
    const j = cps.findIndex((c, n) => n > 0 && val(c) >= val(cps[n - 1]) + 2);
    const prev = val(cps[j - 1]);
    const m = lines.slice();
    m[cps[j]] = { ...m[cps[j]], line: m[cps[j]].line.replace(/ seq=\d+ /, ` seq=${prev + 1} `) };
    const r = judge(m);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/ligger under redan sett original/);
    expect(problemsText(r)).not.toMatch(/sjönk/);
  });

  test('kontrollpunkt som sjunker utan att ligga under ett stdout-original', () => {
    // Två stderr-poster i ett minutfönster utan sampel: förra kontrollpunkten
    // höjs till att täcka dem, nästa sänks ett steg. Bara sjunkregeln fäller.
    const at = quietWindowMin;
    const { lines } = base({ events: [{ atMin: at, message: ERR, err: true }, { atMin: at + 0.01, message: `${ERR} igen`, err: true }] });
    const errs = lines.map((l, i) => (l.line.includes('[err]') && isOrig(l.line) ? i : -1)).filter((i) => i >= 0);
    const cps = lines.map((l, i) => (l.line.includes('[CAPTURE_SEQ]') ? i : -1)).filter((i) => i >= 0);
    const before = cps.filter((i) => i < errs[0]).pop();
    const after = cps.find((i) => i > errs[1]);
    const top = seqOf(lines[errs[1]].line);
    const m = lines.slice();
    m[before] = { ...m[before], line: m[before].line.replace(/ seq=\d+ /, ` seq=${top} `) };
    m[after] = { ...m[after], line: m[after].line.replace(/ seq=\d+ /, ` seq=${top - 1} `) };
    const r = judge(m);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/kontrollpunkten sjönk/);
    expect(problemsText(r)).not.toMatch(/ligger under redan sett original|saknas och kunde inte läkas/);
  });

  test('ett hål läks inte när loggen har andra löpnummerfel (sampel utan nummer)', () => {
    const { lines, startMs } = base();
    const cut = cutHole(lines, startMs + 20 * MIN + 1, startMs + 21.5 * MIN);
    const i = origLineOf(cut, 40);
    cut.splice(i + 1, 0, { t: cut[i].t, line: cut[i].line.replace(/#[0-9a-z]+-\d+:40 /, '') });
    const r = judge(cut);
    expect(r.verdict).toBe('FEL');
    expect(healedNotes(r)).toHaveLength(0);
    expect(problemsText(r)).toMatch(/TIDSHÅL I LOGGEN.*Löpnumren läker det inte: loggen har löpnummerfel/);
  });
});
