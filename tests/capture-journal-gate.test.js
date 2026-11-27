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
  // Stopptiden (L1): som loggskriptet, strax efter loggens sista rad, om inte
  // testet säger annat (opts.stop = null betyder att den saknas).
  // Tystnaden (N1) som datorn mäter: med lika klockor tiden från loggens sista
  // rad till stoppet, om inte testet anger den (opts.quiet i sekunder).
  let stopTime = opts.stop;
  if (stopTime === undefined && typeof lines !== 'string') stopTime = lines[lines.length - 1].t + 1000;
  let quietS = opts.quiet;
  if (quietS === undefined && typeof stopTime === 'number' && typeof lines !== 'string') {
    quietS = Math.max(0, Math.round((stopTime - lines[lines.length - 1].t) / 1000));
  }
  const r = checkPair(jsonlPath, logPath, {
    stopTime: stopTime === undefined ? null : stopTime, quietS: quietS === undefined ? null : quietS,
  });
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

  // Spärren (efter granskningens fjärde varv): en omstart gör körningen till
  // som bäst DELVIS, också när inget fattas.
  test('omstart utan hål: inga fel, men DELVIS (två appstarter, två strömmar)', () => {
    const { lines } = base({ segments: [{ atMin: 0, kind: 'boot' }, { atMin: 30.1, kind: 'boot' }] });
    const r = judge(lines);
    expect(problemsText(r)).toBe('');
    expect(r.verdict).toBe('DELVIS');
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
    // Pollraden i det oläkta hålet: underskottet står kvar som fel, inte som notis (G10).
    expect(problemsText(r)).toMatch(/KÄLLOGGEN ÄR OFULLSTÄNDIG/);
    expect(r.notes.join('\n')).not.toMatch(/Källbokföringens underskott inom ett läkt tidshål/);
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

// Granskningens fall F1–F5 (o9/granskning-L/verktyg/mutantfall.js), körda som
// granskaren körde dem: utan stopptid. Alla ska ge FEL; varje fall skiljer
// grinden från en mutant som annars gav ett falskt OK (G1–G3, G8, G9, G11).
describe('U71 grinden: granskningens fall F1–F5', () => {
  const noStop = { stop: null };

  test('F1: originalet med kontrollpunktens nummer borta, loggen slutar efter kontrollpunkten', () => {
    const { lines } = simulateLog({ minutes: 30, passages: [[5, 30]] });
    const cps = lines.map((l, i) => (l.line.includes('[CAPTURE_SEQ]') ? i : -1)).filter((i) => i >= 0);
    const cpIdx = cps[cps.length - 3];
    const cpSeq = Number(/seq=(\d+)/.exec(lines[cpIdx].line)[1]);
    const kept = lines.slice(0, cpIdx + 1).filter((l) => !(origLineOf([l], cpSeq) === 0));
    const r = judge(kept, noStop);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(new RegExp(`1 post\\(er\\) saknas och kunde inte läkas \\(nummer ${cpSeq}\\)`));
  });

  test('F2: sista sampel före [CAPTURE_END] borta (slutet säger seq=N)', () => {
    const { lines, journals } = simulateLog({ minutes: 30, passages: [[5, 30]] });
    const last = lines[lines.length - 1];
    const j = journals[journals.length - 1];
    const t = last.t + 1000;
    const out = lines.concat([{ t: t + 10, line: `${new Date(t + 10).toISOString()} [log] [AISBridgeApp] [CAPTURE_END] sid=${j.sid} seq=${j.seq + 1} dropped=0 errors=0 reason=uninit` }]);
    const r = judge(out, noStop);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(new RegExp(`saknas och kunde inte läkas \\(nummer ${j.seq + 1}\\)`));
  });

  test('F3: journalens rader upphör 10 min före loggens slut', () => {
    const { lines, startMs } = simulateLog({ minutes: 40, passages: [[5, 40]] });
    const stop = startMs + 30 * MIN;
    const isJ = (l) => l.line.includes('[CAPTURE_SEQ]') || l.line.includes('[CAPTURE_RESEND]') || /\] #[0-9a-z]+-\d+:\d+ /.test(l.line);
    const out = lines.filter((l) => l.t < stop || !isJ(l));
    const r = judge(out, noStop);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/kontrollpunkt saknas mellan 2026-11-20T15:29/);
  });

  test('F3 med en sista rad som börjar med en siffra men saknar tidsstämpel (L7)', () => {
    const { lines, startMs } = simulateLog({ minutes: 40, passages: [[5, 40]] });
    const stop = startMs + 30 * MIN;
    const isJ = (l) => l.line.includes('[CAPTURE_SEQ]') || l.line.includes('[CAPTURE_RESEND]') || /\] #[0-9a-z]+-\d+:\d+ /.test(l.line);
    const out = lines.filter((l) => l.t < stop || !isJ(l));
    const r = judge(`${text(out)}12 vessels (fortsättningsrad)\n`);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/kontrollpunkt saknas mellan 2026-11-20T15:29.* och 2026-11-20T15:39/);
  });

  test('F4: en kontrollpunkt borta vid 11 min (inget tidshål där) och ett läkt hål vid 40 min', () => {
    const { lines, startMs } = simulateLog({ minutes: 60, passages: [[5, 50]] });
    let out = cutHole(lines, startMs + 40 * MIN + 1, startMs + 40 * MIN + 91000);
    const cps = out.map((l, i) => (l.line.includes('[CAPTURE_SEQ]') ? i : -1)).filter((i) => i >= 0);
    out = out.filter((_, i) => i !== cps[10]);
    const r = judge(out, noStop);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/kontrollpunkt saknas mellan 2026-11-20T15:10/);
  });

  test('F5: två tidshål, det första läkbart, det andra i slutet utan kontrollpunkt efter', () => {
    const { lines, startMs } = simulateLog({ minutes: 60, passages: [[5, 30]] });
    let out = cutHole(lines, startMs + 20 * MIN + 1, startMs + 20 * MIN + 91000);
    out = cutHole(out, startMs + 2973500, startMs + 3039900).filter((l) => l.t <= startMs + 3040000);
    const r = judge(out, noStop);
    expect(r.verdict).toBe('FEL');
    const gapProblems = r.problems.filter((p) => p.startsWith('TIDSHÅL I LOGGEN'));
    expect(gapProblems).toHaveLength(1);
    expect(gapProblems[0]).toMatch(/2026-11-20T15:49.*Löpnumren läker det inte/);
    expect(healedNotes(r)).toHaveLength(1);
    expect(healedNotes(r)[0]).toMatch(/2026-11-20T15:20/);
  });
});

describe('U71 grinden: svansen mot stopptiden (L1)', () => {
  test('ett hål som når stoppet fäller', () => {
    const { lines, startMs } = base({ minutes: 50 });
    const cut = lines.filter((l) => l.t < startMs + 45 * MIN + 1);
    const r = judge(cut, { stop: startMs + 50 * MIN });
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/svansen är obevisad: sista kontrollpunkten 2026-11-20T15:44:00.200Z, loggens sista rad 2026-11-20T15:45:00.000Z, loggfilen tyst 300 s vid stoppet/);
  });

  test('utan stopptid: DELVIS, och utskriften säger vad som inte är bevisat', () => {
    const { lines } = base();
    const r = judge(lines, { stop: null });
    expect(r.verdict).toBe('DELVIS');
    expect(r.notes.join('\n')).toMatch(/SVANSEN OBEVISAD \(U71\): stopptid saknas\. Fångsten är bevisad fram till sista kontrollpunkten 2026-11-20T15:59:00\.200Z; poster efter den kan saknas/);
  });

  test('med stopptid strax efter sista kontrollpunkten: OK och "Svansen bevisad"', () => {
    const { lines } = base();
    const r = judge(lines);
    expect(r.verdict).toBe('OK');
    expect(r.notes.join('\n')).toMatch(/Svansen bevisad \(U71\)/);
  });

  test('gränsen: 65 s från sista kontrollpunkten godkänns, 66 s fäller', () => {
    const { lines, startMs } = base({ minutes: 50 });
    const cps = lines.filter((l) => l.line.includes('[CAPTURE_SEQ]'));
    const lastCp = cps[cps.length - 1].t;
    expect(judge(lines, { stop: lastCp + 65000 }).verdict).toBe('OK');
    expect(judge(lines, { stop: lastCp + 66000 }).verdict).toBe('FEL');
    expect(startMs).toBeLessThan(lastCp);
  });

  test('stopptiden läses från <jsonl>.stop när den inte anges', () => {
    const { lines } = base({ minutes: 20 });
    const logPath = path.join(dir, 'stopfil.log');
    const jsonlPath = path.join(dir, 'ais-stopfil.jsonl');
    fs.writeFileSync(logPath, text(lines));
    fs.writeFileSync(jsonlPath, `${healLogFile(logPath).healedSamples.join('\n')}\n`);
    fs.writeFileSync(path.join(dir, 'ais-stopfil.stop'), `${new Date(lines[lines.length - 1].t + 1000).toISOString()}\nquiet_s=1\n`);
    expect(checkPair(jsonlPath, logPath, {}).verdict).toBe('OK');
    // Bara stopptiden, utan tystnaden: svansen obevisad.
    fs.writeFileSync(path.join(dir, 'ais-stopfil.stop'), `${new Date(lines[lines.length - 1].t + 1000).toISOString()}\n`);
    const r = checkPair(jsonlPath, logPath, {});
    expect(r.verdict).toBe('DELVIS');
    expect(r.notes.join('\n')).toMatch(/SVANSEN OBEVISAD \(U71\): loggfilens tystnad vid stoppet saknas/);
  });
});

describe('U71 grinden: övriga skärpningar efter granskningen', () => {
  test('M2: en journalförd händelse utan nummer medan strömmen är aktiv fäller', () => {
    const { lines } = base();
    const i = origLineOf(lines, 30);
    const m = lines.slice();
    m.splice(i + 1, 0, { t: m[i].t, line: `${new Date(m[i].t).toISOString()} [log] [AISBridgeApp] 📱 [UI_UPDATE] Bridge text updated: "En båt"` });
    const r = judge(m);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/1 journalförd\(a\) händelse\(r\).*saknar löpnummer medan en ström var aktiv/);
  });

  test('M2 motfall: händelser utan nummer före första strömmen (basic vid start) är tillåtna', () => {
    const { lines, startMs } = base({ segments: [{ atMin: 0, kind: 'level-off' }, { atMin: 0, kind: 'boot' }, { atMin: 12.3, kind: 'level-on' }] });
    const m = lines.slice();
    const at = startMs + 5 * MIN;
    const k = m.findIndex((l) => l.t > at);
    m.splice(k, 0, { t: at, line: `${new Date(at).toISOString()} [log] [AISBridgeApp] 📱 [UI_UPDATE] Bridge text updated: "Inga båtar"` });
    expect(problemsText(judge(m))).toBe('');
  });

  test('L4: en gammal logg med "[CAPTURE_SEQ]" i ett båtnamn döms som förut', () => {
    const t0 = Date.UTC(2026, 10, 20, 15, 0, 0);
    const mk = (name) => {
      const out = [];
      for (let s = 0; s < 600; s += 30) {
        const ts = new Date(t0 + s * 1000).toISOString();
        out.push(`${ts} [log] [AISBridgeApp] [DEBUG] 🧹 [COORDINATION_CLEANUP] Cleaned old coordination state`);
        out.push(`${ts} [log] [AISBridgeApp] [AIS_REPLAY_SAMPLE] {"mmsi":"1","shipName":"${name}","n":${s}}`);
      }
      return `${out.join('\n')}\n`;
    };
    const plain = judge(mk('VANLIG'));
    const odd = judge(mk('[CAPTURE_SEQ] sid=x-1 seq=1'));
    expect(odd.verdict).toBe(plain.verdict);
    expect(odd.verdict).toBe('OK');
    expect(odd.journal).toBeUndefined();
  });

  test('L4: i en löpnummerlogg är ett båtnamn med en journaltagg ingen oläslig journalrad', () => {
    const { lines } = base({ hubName: '[CAPTURE_SEQ] sid=x-1 seq=1' });
    expect(lines.some((l) => l.line.includes('"shipName":"[CAPTURE_SEQ] sid=x-1 seq=1"'))).toBe(true);
    expect(problemsText(judge(lines))).toBe('');
  });

  test('L5: ett korrupt jättelöpnummer ger ett snabbt FEL', () => {
    const { lines } = base();
    const i = origLineOf(lines, 30);
    const m = lines.slice();
    m.splice(i + 1, 0, { t: m[i].t, line: m[i].line.replace(/:30 /, ':1000000000 ') });
    const t0 = Date.now();
    const r = judge(m);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/orimligt löpnummer 1000000000/);
  });

  test('G26: räknaren för släppta poster som sjunker fäller', () => {
    const { lines } = base({ maxEntries: 3 });
    const cps = lines.map((l, i) => (l.line.includes('[CAPTURE_SEQ]') ? i : -1)).filter((i) => i >= 0);
    const m = lines.slice();
    m[cps[30]] = { ...m[cps[30]], line: m[cps[30]].line.replace(/dropped=\d+/, 'dropped=0') };
    const r = judge(m);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/räknaren för släppta poster sjönk/);
  });

  test('G4: en omsändning i icke-kanonisk base64 (utan utfyllnad) är oläslig', () => {
    const { lines } = base();
    const k = lines.findIndex((l) => l.line.includes('[CAPTURE_RESEND]') && /"b64":"[^"]*="/.test(l.line));
    const m = lines.slice();
    m[k] = { ...m[k], line: m[k].line.replace(/=+"/, '"') };
    const r = judge(m);
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/journalrad\(er\) går inte att läsa/);
  });
});

// Granskningens andra varv, N1: stopptiden prövas mot loggen, och svansen
// bevisas med loggfilens tystnad (datorns klocka) och loggens egna tider (appens
// klocka), utan att blanda dem.
describe('U71 grinden: stopptidens rimlighet och svansen oberoende av Homeys klocka (N1)', () => {
  const healthy = () => base({ minutes: 50 });
  const lastT = (lines) => lines[lines.length - 1].t;

  test('frisk körning med rätt stopptid och kort tystnad: OK', () => {
    const { lines } = healthy();
    const r = judge(lines, { stop: lastT(lines) + 2000, quiet: 2 });
    expect(r.verdict).toBe('OK');
    expect(r.notes.join('\n')).toMatch(/Svansen bevisad \(U71\): .*loggfilen tyst 2 s/);
  });

  test('stoppfil 20 min för tidig: FEL', () => {
    const { lines, startMs } = healthy();
    const r = judge(lines, { stop: startMs + 30 * MIN, quiet: 2 });
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/stopptiden 2026-11-20T15:30:00.000Z ligger mer än 5 min före loggens sista rad/);
  });

  test('stopptid före loggens början: FEL', () => {
    const { lines, startMs } = healthy();
    const r = judge(lines, { stop: startMs - 3600000, quiet: 2 });
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/ligger mer än 5 min före loggens sista rad/);
  });

  test('stopptid mer än ett dygn efter loggens slut: FEL', () => {
    const { lines } = healthy();
    const r = judge(lines, { stop: lastT(lines) + 25 * 3600000, quiet: 2 });
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/hör inte till körningen/);
  });

  test('stopptid utan tidszon avvisas, också när den lokala tolkningen hade varit rimlig', () => {
    const { lines } = healthy();
    const t = lastT(lines) + 2000;
    // Väggklockan i maskinens egen tidszon: utan tidszonskontrollen tolkas den exakt rätt.
    const local = new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    const r = judge(lines, { stop: local, quiet: 2 });
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/ingen ISO-tid med tidszon \(Z eller ±hh:mm krävs\)/);
    expect(judge(lines, { stop: `${new Date(t).toISOString().slice(0, 19)}+00:00`, quiet: 2 }).verdict).toBe('OK');
  });

  test('ett hål som når stoppet med Homeys klocka 120 s före datorns: FEL (tystnaden fäller)', () => {
    const { lines, startMs } = base({ minutes: 50, passages: [[40, 50]] });
    // Hålet börjar 48:00 i Homeys tid; stoppet är 50:00 i Homeys tid = 48:00 i
    // datorns. Datorn har sett en tyst loggfil i 120 s.
    const cut = cutHole(lines, startMs + 48 * MIN, startMs + 51 * MIN);
    const r = judge(cut, { stop: startMs + 48 * MIN, quiet: 120 });
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/svansen är obevisad: .*loggfilen tyst 120 s vid stoppet/);
  });

  // B3: beviset bärs av tystnaden, så en vanlig klockskillnad fäller inte en
  // frisk körning; marginalen åt det hållet är 5 min.
  test.each([60, 120, 295])('en frisk körning med Homeys klocka %i s före datorns: OK', (aheadS) => {
    const { lines } = healthy();
    expect(judge(lines, { stop: lastT(lines) - aheadS * 1000 + 2000, quiet: 2 }).verdict).toBe('OK');
  });

  test('en frisk körning med Homeys klocka 6 min före datorns: falskt FEL (aldrig falskt OK)', () => {
    const { lines } = healthy();
    const r = judge(lines, { stop: lastT(lines) - 360000 + 2000, quiet: 2 });
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/ligger mer än 5 min före loggens sista rad/);
  });

  test('en frisk körning med Homeys klocka 120 s efter datorns: OK (tystnaden är klockoberoende)', () => {
    const { lines } = healthy();
    expect(judge(lines, { stop: lastT(lines) + 122000, quiet: 2 }).verdict).toBe('OK');
  });

  test('tystnad som inte är ett antal sekunder: FEL', () => {
    const { lines } = healthy();
    const r = judge(lines, { stop: lastT(lines) + 2000, quiet: 'mycket' });
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/stopptiden går inte att använda: tystnaden "mycket"/);
  });
});

// Granskningens andra varv, N2: regeln att en ström blir inaktiv efter
// [CAPTURE_END] och efter en ny boot-rad.
describe('U71 grinden: händelser utan nummer efter att strömmen slutat (N2)', () => {
  const plain = (t) => ({ t, line: `${new Date(t).toISOString()} [log] [AISBridgeApp] 📱 [UI_UPDATE] Bridge text updated: "Inga båtar"` });
  const insert = (lines, ev) => {
    const k = lines.findIndex((l) => l.t > ev.t);
    const m = lines.slice();
    m.splice(k < 0 ? m.length : k, 0, ev);
    return m;
  };

  test('full → basic 5 min före stoppet, textbyte utan nummer efteråt: OK', () => {
    const { lines, startMs } = base({ minutes: 50, segments: [{ atMin: 0, kind: 'boot' }, { atMin: 45.05, kind: 'level-off' }] });
    const r = judge(insert(lines, plain(startMs + 47 * MIN)));
    expect(problemsText(r)).toBe('');
    expect(r.verdict).toBe('OK');
  });

  test('omstart till basic efter en full ström, textbyte utan nummer efteråt: inga fel, DELVIS (spärren)', () => {
    const { lines, startMs } = base({ minutes: 50, segments: [{ atMin: 0, kind: 'boot' }, { atMin: 45.05, kind: 'boot-basic' }] });
    expect(lines.some((l) => l.t > startMs + 45.1 * MIN && /\] #[0-9a-z]+-\d+:\d+ /.test(l.line))).toBe(false);
    const r = judge(insert(lines, plain(startMs + 47 * MIN)));
    expect(problemsText(r)).toBe('');
    expect(r.verdict).toBe('DELVIS');
  });
});

// Granskningens tredje varv, B1: en omstart nära slutet stänger inte av
// svanskravet. Svansen prövas från boot-raden, utom när starttillståndet efter
// omstarten (utan nummer) visar en annan loggnivå än full.
describe('U71 grinden: svansen efter en omstart (B1)', () => {
  test('omstart vid 45 min på full nivå, allt efter boot-raden borta till stoppet: FEL', () => {
    const { lines, startMs } = base({ minutes: 50, passages: [[40, 50]], segments: [{ atMin: 0, kind: 'boot' }, { atMin: 45, kind: 'boot' }] });
    const bootIdx = lines.findIndex((l) => l.t >= startMs + 45 * MIN && l.line.includes('AIS Bridge starting'));
    const lost = lines.slice(bootIdx + 1).filter((l) => /\] #[0-9a-z]+-\d+:\d+ \[AIS_REPLAY_SAMPLE\]/.test(l.line)).length;
    expect(lost).toBeGreaterThan(10);
    const r = judge(lines.slice(0, bootIdx + 1), { stop: startMs + 50 * MIN });
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/svansen är obevisad: omstarten 2026-11-20T15:45:00.000Z, .*loggfilen tyst 300 s vid stoppet/);
  });

  test('omstart på full nivå där den nya strömmen kommer fram: inga fel, DELVIS (spärren)', () => {
    const { lines } = base({ minutes: 50, passages: [[40, 50]], segments: [{ atMin: 0, kind: 'boot' }, { atMin: 45, kind: 'boot' }] });
    const r = judge(lines);
    expect(problemsText(r)).toBe('');
    expect(r.verdict).toBe('DELVIS');
    expect(r.journal.streams).toHaveLength(2);
  });

  test('omstart till basic: starttillståndet visar basic, ingen svans att bevisa (inga fel, DELVIS: spärren)', () => {
    const { lines, startMs } = base({ minutes: 50, segments: [{ atMin: 0, kind: 'boot' }, { atMin: 45.05, kind: 'boot-basic' }] });
    expect(lines.some((l) => l.t >= startMs + 45 * MIN && l.line.includes('"debug_level":"basic"'))).toBe(true);
    const r = judge(lines, { stop: startMs + 50 * MIN, quiet: 2 });
    expect(problemsText(r)).toBe('');
    expect(r.verdict).toBe('DELVIS');
  });

  test('omstart till basic men starttillståndet försvann: svansen prövas från omstarten (FEL)', () => {
    const { lines, startMs } = base({ minutes: 50, segments: [{ atMin: 0, kind: 'boot' }, { atMin: 45.05, kind: 'boot-basic' }] });
    const cut = lines.filter((l) => !l.line.includes('"debug_level":"basic"'));
    const r = judge(cut, { stop: startMs + 50 * MIN, quiet: 2 });
    expect(r.verdict).toBe('FEL');
    expect(problemsText(r)).toMatch(/svansen är obevisad: omstarten/);
  });
});

// Dirigentens beslut efter granskningens fjärde varv: grinden kan bara ge OK för
// den enkla körningen (exakt en appstart och exakt en fångstström). Granskarens
// omstartsfall ska aldrig bli OK.
describe('U71 grinden: spärren för omstarter och byten av ström', () => {
  const bootIdx = (lines, k) => lines.map((l, i) => (l.line.includes('AIS Bridge starting') ? i : -1)).filter((i) => i >= 0)[k];
  const samplesBetween = (lines, a, b) => lines.slice(a, b).filter((l) => /\] #.*AIS_REPLAY_SAMPLE/.test(l.line)).length;
  const notOk = (r) => expect(['FEL', 'DELVIS']).toContain(r.verdict);

  test('K1 (V4): omstart 40 på full, den mellersta processen borta i 150 s, omstart 42,5 på basic', () => {
    const segments = [{ atMin: 0, kind: 'boot' }, { atMin: 40, kind: 'boot' }, { atMin: 42.49, kind: 'level-off' }, { atMin: 42.5, kind: 'boot' }];
    const { lines, startMs } = simulateLog({ minutes: 50, passages: [[30, 50]], segments });
    const b1 = bootIdx(lines, 1);
    const b2 = bootIdx(lines, 2);
    expect(samplesBetween(lines, b1 + 1, b2)).toBeGreaterThan(5);
    const r = judge(lines.filter((l, i) => i <= b1 || i >= b2), { stop: startMs + 50 * MIN, quiet: 2 });
    notOk(r);
    expect(r.notes.join('\n')).toMatch(/ENKEL KÖRNING KRÄVS \(U71\): loggen har 3 appstart\(er\)/);
  });

  test('K1 (V4b): krasch-slinga på full nivå, den mellersta processen borta, ström C syns', () => {
    const { lines, startMs } = simulateLog({ minutes: 50, passages: [[30, 50]], segments: [{ atMin: 0, kind: 'boot' }, { atMin: 40, kind: 'boot' }, { atMin: 42.5, kind: 'boot' }] });
    const b1 = bootIdx(lines, 1);
    const b2 = bootIdx(lines, 2);
    const r = judge(lines.filter((l, i) => i <= b1 || i >= b2), { stop: startMs + 50 * MIN });
    notOk(r);
    expect(r.notes.join('\n')).toMatch(/omstart eller byte av loggnivå i körningen: fångsten kan inte bevisas hel/i);
    expect(r.partialNote || '').toMatch(/omstart eller byte av loggnivå/);
  });

  test('K2 (V5): omstart till basic 45, full 47, allt efter nivåbytet borta till stoppet', () => {
    const segments = [{ atMin: 0, kind: 'boot' }, { atMin: 44.9, kind: 'level-off' }, { atMin: 45, kind: 'boot' }, { atMin: 47, kind: 'level-on' }];
    const { lines, startMs } = simulateLog({ minutes: 50, passages: [[30, 50]], segments });
    const on = lines.findIndex((l) => l.line.includes('Debug level changed to: full'));
    expect(samplesBetween(lines, on + 1)).toBeGreaterThan(5);
    notOk(judge(lines.slice(0, on + 1), { stop: startMs + 50 * MIN }));
  });

  test('B1: omstart vid 45 på full, allt efter boot-raden borta: aldrig OK', () => {
    const { lines, startMs } = simulateLog({ minutes: 50, passages: [[40, 50]], segments: [{ atMin: 0, kind: 'boot' }, { atMin: 45, kind: 'boot' }] });
    const b = bootIdx(lines, 1);
    notOk(judge(lines.slice(0, b + 1), { stop: startMs + 50 * MIN }));
  });

  test('en appstart men två strömmar (den andra boot-raden försvann): DELVIS', () => {
    const { lines } = base({ minutes: 50, segments: [{ atMin: 0, kind: 'boot' }, { atMin: 30.1, kind: 'boot' }] });
    const b = bootIdx(lines, 1);
    const r = judge(lines.filter((_, i) => i !== b));
    expect(problemsText(r)).toBe('');
    expect(r.verdict).toBe('DELVIS');
    expect(r.notes.join('\n')).toMatch(/1 appstart\(er\) och 2 fångstström\(mar\)/);
  });

  test('den enkla körningen: frisk ger OK, ett läkt hål ger OK med hålet redovisat', () => {
    const { lines, startMs } = base();
    expect(judge(lines).verdict).toBe('OK');
    const r = judge(cutHole(lines, startMs + 20 * MIN + 1, startMs + 21.5 * MIN));
    expect(r.verdict).toBe('OK');
    expect(healedNotes(r)).toHaveLength(1);
    expect(r.notes.join('\n')).not.toMatch(/ENKEL KÖRNING KRÄVS/);
  });
});
