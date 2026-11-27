'use strict';

/**
 * captureJournal (U71, omgång 9): läker fältfångsten ur appens omsändningar
 * och avgör om den är hel.
 *
 * Appens journal (lib/utils/CaptureJournal.js) skriver på full loggnivå:
 *   #<sid>:<nr> <meddelande>                     original, numrerat
 *   [CAPTURE_RESEND] {"sid","seq","at","b64"}    omsändning efter 2 och 10 min
 *   [CAPTURE_SEQ] sid=… seq=… buffered=… dropped=… errors=…   kontrollpunkt/minut
 *   [CAPTURE_END] sid=… seq=… dropped=… errors=… reason=…     strömmens slut
 * och post 1 i varje ström är `[CAPTURE_START] sid=… reason=…`.
 *
 * Grinden är medvetet sträng: ett falskt godkänt är värre än ett prov som
 * inte kan låsas. En logg UTAN journalrader döms exakt som förut
 * (checkReplayIntegrity.js rör då inte den här modulens resultat).
 *
 * Villkoren (alla måste hålla i en löpnummerlogg, annars FEL):
 *  1. varje ström har post 1 = [CAPTURE_START] med sitt eget sid;
 *  2. alla nummer 1..max finns (max över poster, kontrollpunkter och slut);
 *  3. original på stdout kommer i strikt stigande ordning, aldrig efter sin
 *     omsändning och aldrig med ett nummer som en tidigare kontrollpunkt redan
 *     täckte; kontrollpunkter sjunker aldrig och ligger aldrig under ett redan
 *     sett original; `dropped` sjunker aldrig;
 *  4. samma nummer två gånger har samma innehåll, och ett original förekommer
 *     bara en gång;
 *  5. inga rader för en ström efter dess [CAPTURE_END], och slutets nummer
 *     täcker allt som setts;
 *  6. en ström som slutade för att loggnivån sänktes följs inte av en ny
 *     ström (fångsten var då avstängd emellan);
 *  7. inga sampel utan löpnummer;
 *  8. kontrollpunkterna kommer med högst 65 s mellanrum, från strömmens
 *     start till dess slut, utom över ett tidshål;
 *  9. ett tidshål godkänns bara när samma ström är aktiv närmast före och
 *     efter hålet, en kontrollpunkt i den strömmen kommer efter hålet med
 *     dropped=0, och strömmen i övrigt är felfri.
 *
 * Användning (loggskriptet):
 *   node tests/replay-validation/captureJournal.js --jsonl <app.log>   läkt jsonl till stdout
 *   node tests/replay-validation/captureJournal.js --state <app.log>   starttillståndet (som grep -m 1)
 *   node tests/replay-validation/captureJournal.js --summary <app.log> sammanfattning (JSON)
 */

const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const { UI_CONSTANTS } = require('../../lib/constants');

const SAMPLE_MARKER = 'AIS_REPLAY_SAMPLE';
const SAMPLE_CUT = `${SAMPLE_MARKER}] `;
// Starttillståndet: samma klippning som loggskriptets sed.
const STATE_CUT = 'AIS_REPLAY_STATE] ';
const CHECKPOINT_LIMIT_MS = UI_CONSTANTS.MONITORING_INTERVAL_MS + 5000;

const STAMP_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s/;
// Loggprefixet som Homey sätter: "<tid> [log] [AISBridgeApp] ". Numret står
// direkt efter prefixet, så en båt som heter "#x-1:2" kan aldrig läsas som ett.
const ORIG_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) \[(log|err)\] \[[^\]]*\] #([0-9a-z]+-[0-9]+):([0-9]+) (.*)$/;
const RESEND_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) \[(log|err)\] \[([^\]]*)\] \[CAPTURE_RESEND\] (.*)$/;
const CHECKPOINT_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) \[(log|err)\] \[[^\]]*\] \[CAPTURE_SEQ\] sid=([0-9a-z]+-[0-9]+) seq=([0-9]+) buffered=([0-9]+) dropped=([0-9]+) errors=([0-9]+)$/;
const END_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) \[(log|err)\] \[[^\]]*\] \[CAPTURE_END\] sid=([0-9a-z]+-[0-9]+) seq=([0-9]+) dropped=([0-9]+) errors=([0-9]+) reason=(\S+)$/;
const START_MSG_RE = /^\[CAPTURE_START\] sid=([0-9a-z]+-[0-9]+) reason=(\S+)$/;
const JOURNAL_TAGS = ['[CAPTURE_START]', '[CAPTURE_SEQ]', '[CAPTURE_RESEND]', '[CAPTURE_END]'];
// En journaltagg räknas bara direkt efter appens prefix (granskningen, L4): ett
// båtnamn med texten "[CAPTURE_SEQ]" gör inte en gammal logg till en löpnummerlogg.
const TAG_AT_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[(log|err)\] \[[^\]]*\] \[CAPTURE_(START|SEQ|RESEND|END)\]/;
// Journalförda händelser (app.js _logCaptured). Utan nummer medan en ström är
// aktiv betyder det att ett anropsställe gått förbi journalen (granskningen, M2).
const EVENT_TAGS = ['[AIS_REPLAY_STATE] ', '[FLOW_TRIGGER_SAFE_TOKENS]', '[FLOW_TRIGGER_ATTEMPT]',
  '[FLOW_TRIGGER_SUCCESS]', '[FLOW_TRIGGER_ERROR]', '[OPENING_TRIGGER_SUCCESS]', '[UI_UPDATE] Bridge text updated:'];
const BOOT_MARK = 'AIS Bridge starting with modular architecture';
// Ett löpnummer kan bara hoppa så långt som ett hål sväljer poster. Ett hopp
// över det här är ett korrupt nummer: det fälls direkt i stället för att
// grinden ska räkna upp till det (granskningen, L5).
const MAX_SEQ_JUMP = 100000;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const MAX_LISTED = 5;

function sampleJson(message) {
  const cut = message.lastIndexOf(SAMPLE_CUT);
  return cut === -1 ? message : message.slice(cut + SAMPLE_CUT.length);
}

function timeOf(line) {
  const m = STAMP_RE.exec(line);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? { t, time: m[1] } : null;
}

function createJournalAudit() {
  const streams = new Map();
  const order = []; // segment: { sid } | { plain: json, line }
  const marks = []; // { line, t, sid, kind }
  const globalProblems = [];
  let journalSeen = false;
  let plainSamples = 0;
  let firstPlainLine = null;
  let firstPlainState = null;
  let lastStampLine = null;
  let malformed = 0;
  let firstMalformed = null;
  let activeSid = null;
  let plainEvents = 0;
  let firstPlainEventLine = null;

  const getStream = (sid, lineNumber, t) => {
    let s = streams.get(sid);
    if (!s) {
      s = {
        sid,
        firstLine: lineNumber,
        firstT: t,
        lastLine: lineNumber,
        lastT: t,
        entries: new Map(),
        origSeqs: new Set(),
        maxOrigSeq: 0,
        maxSeen: 0,
        checkpoints: [],
        lastCheckpointSeq: 0,
        lastDropped: 0,
        end: null,
        duplicates: 0,
        problems: [],
      };
      streams.set(sid, s);
      order.push({ sid });
    }
    s.lastLine = lineNumber;
    if (t !== null) s.lastT = t;
    return s;
  };

  const problem = (s, text) => {
    if (s.problems.length < 50) s.problems.push(text);
  };

  // Rader utan journalens kännetecken: sampel och starttillstånd utan nummer.
  const takePlain = (line, lineNumber) => {
    if (line.indexOf(BOOT_MARK) !== -1) activeSid = null;
    if (activeSid !== null && EVENT_TAGS.some((tag) => line.indexOf(tag) !== -1)) {
      plainEvents += 1;
      if (firstPlainEventLine === null) firstPlainEventLine = lineNumber;
    }
    if (firstPlainState === null && line.indexOf(STATE_CUT) !== -1) {
      firstPlainState = { line: lineNumber, json: line.slice(line.lastIndexOf(STATE_CUT) + STATE_CUT.length) };
    }
    if (line.indexOf(SAMPLE_MARKER) !== -1) {
      plainSamples += 1;
      if (firstPlainLine === null) firstPlainLine = lineNumber;
      order.push({ plain: sampleJson(line), line: lineNumber });
    }
  };

  const noteMalformed = (lineNumber) => {
    malformed += 1;
    if (firstMalformed === null) firstMalformed = lineNumber;
  };

  // L5: ett orimligt hopp i numret fälls och räknas inte som sett.
  const absurd = (s, seq, lineNumber) => {
    if (seq <= s.maxSeen + MAX_SEQ_JUMP) return false;
    problem(s, `orimligt löpnummer ${seq} efter ${s.maxSeen} (loggrad ${lineNumber}) — raden är korrupt`);
    return true;
  };

  const putEntry = (s, seq, entry, lineNumber) => {
    const prev = s.entries.get(seq);
    if (!prev) {
      s.entries.set(seq, entry);
      return;
    }
    if (prev.message !== entry.message) {
      problem(s, `nummer ${seq} förekommer med olika innehåll (loggrad ${prev.line} och ${lineNumber})`);
      return;
    }
    s.duplicates += 1;
  };

  return {
    take(line, lineNumber) {
      // Snabbväg: en fältlogg har hundratusentals rader, och bara de med
      // journalens kännetecken behöver tidsstämpel och reguljära uttryck.
      // Bara rader med tidsstämpel (granskningen, L7): en fortsättningsrad som
      // råkar börja med en siffra får inte bli loggens sista tid.
      const code = line.charCodeAt(0);
      if (code >= 48 && code <= 57 && line.charCodeAt(4) === 45 && line.charCodeAt(10) === 84) lastStampLine = line;
      if (line.indexOf('[CAPTURE_') === -1 && line.indexOf('] #') === -1) {
        takePlain(line, lineNumber);
        return;
      }
      const stamp = timeOf(line);
      const t = stamp ? stamp.t : null;
      let m = ORIG_RE.exec(line);
      if (m) {
        journalSeen = true;
        const sid = m[3];
        const seq = Number(m[4]);
        const message = m[5];
        const isErr = m[2] === 'err';
        const s = getStream(sid, lineNumber, t);
        if (absurd(s, seq, lineNumber)) return;
        if (!s.end) activeSid = sid;
        marks.push({
          line: lineNumber, t, sid, kind: 'orig',
        });
        if (s.end) problem(s, `original ${seq} efter strömmens slut (loggrad ${lineNumber})`);
        if (seq < 1) problem(s, `ogiltigt nummer ${seq} (loggrad ${lineNumber})`);
        if (s.origSeqs.has(seq)) {
          problem(s, `nummer ${seq} förekommer två gånger som original (loggrad ${lineNumber})`);
        } else if (s.entries.has(seq)) {
          problem(s, `original ${seq} kommer efter sin omsändning (loggrad ${lineNumber}) — fel ordning`);
        }
        // stderr kan i princip flätas in i annan ordning än stdout; därför
        // prövas ordningen bara för stdout-originalen. Innehåll, unikhet och
        // fullständighet gäller båda.
        if (!isErr) {
          if (seq <= s.maxOrigSeq) problem(s, `original ${seq} efter ${s.maxOrigSeq} (loggrad ${lineNumber}) — fel ordning`);
          else if (seq <= s.lastCheckpointSeq) {
            problem(s, `original ${seq} efter en kontrollpunkt som redan täckte ${s.lastCheckpointSeq} (loggrad ${lineNumber})`);
          }
          s.maxOrigSeq = Math.max(s.maxOrigSeq, seq);
        }
        s.origSeqs.add(seq);
        putEntry(s, seq, {
          message, via: 'orig', line: lineNumber, at: t, err: isErr,
        }, lineNumber);
        s.maxSeen = Math.max(s.maxSeen, seq);
        return;
      }
      m = RESEND_RE.exec(line);
      if (m) {
        journalSeen = true;
        let payload = null;
        try {
          payload = JSON.parse(m[4]);
        } catch (err) {
          payload = null;
        }
        const ok = payload && typeof payload.sid === 'string' && /^[0-9a-z]+-[0-9]+$/.test(payload.sid)
          && Number.isInteger(payload.seq) && payload.seq >= 1
          && typeof payload.b64 === 'string' && B64_RE.test(payload.b64)
          && typeof payload.at === 'string' && Number.isFinite(Date.parse(payload.at));
        if (!ok) {
          noteMalformed(lineNumber);
          return;
        }
        const message = Buffer.from(payload.b64, 'base64').toString('utf8');
        if (Buffer.from(message, 'utf8').toString('base64') !== payload.b64) {
          noteMalformed(lineNumber);
          return;
        }
        const s = getStream(payload.sid, lineNumber, t);
        if (absurd(s, payload.seq, lineNumber)) return;
        marks.push({
          line: lineNumber, t, sid: payload.sid, kind: 'resend',
        });
        if (s.end) problem(s, `omsändning av ${payload.seq} efter strömmens slut (loggrad ${lineNumber})`);
        putEntry(s, payload.seq, {
          message, via: 'resend', line: lineNumber, at: Date.parse(payload.at), err: payload.e === 1, app: m[3],
        }, lineNumber);
        s.maxSeen = Math.max(s.maxSeen, payload.seq);
        return;
      }
      m = CHECKPOINT_RE.exec(line);
      if (m) {
        journalSeen = true;
        const sid = m[3];
        const seq = Number(m[4]);
        const dropped = Number(m[6]);
        const errors = Number(m[7]);
        const s = getStream(sid, lineNumber, t);
        if (absurd(s, seq, lineNumber)) return;
        if (!s.end) activeSid = sid;
        marks.push({
          line: lineNumber, t, sid, kind: 'checkpoint',
        });
        if (s.end) problem(s, `kontrollpunkt efter strömmens slut (loggrad ${lineNumber})`);
        if (seq < s.lastCheckpointSeq) problem(s, `kontrollpunkten sjönk från ${s.lastCheckpointSeq} till ${seq} (loggrad ${lineNumber})`);
        if (seq < s.maxOrigSeq) problem(s, `kontrollpunkten ${seq} ligger under redan sett original ${s.maxOrigSeq} (loggrad ${lineNumber})`);
        if (dropped < s.lastDropped) problem(s, `räknaren för släppta poster sjönk (loggrad ${lineNumber})`);
        s.checkpoints.push({
          line: lineNumber, t, seq, dropped, errors,
        });
        s.lastCheckpointSeq = Math.max(s.lastCheckpointSeq, seq);
        s.lastDropped = Math.max(s.lastDropped, dropped);
        s.maxSeen = Math.max(s.maxSeen, seq);
        return;
      }
      m = END_RE.exec(line);
      if (m) {
        journalSeen = true;
        const sid = m[3];
        const seq = Number(m[4]);
        const s = getStream(sid, lineNumber, t);
        if (absurd(s, seq, lineNumber)) return;
        if (activeSid === sid) activeSid = null;
        marks.push({
          line: lineNumber, t, sid, kind: 'end',
        });
        if (s.end) problem(s, `strömmen avslutas två gånger (loggrad ${lineNumber})`);
        if (seq < s.maxSeen) problem(s, `slutets nummer ${seq} ligger under redan sett ${s.maxSeen} (loggrad ${lineNumber})`);
        if (Number(m[5]) < s.lastDropped) problem(s, `räknaren för släppta poster sjönk i slutet (loggrad ${lineNumber})`);
        s.end = {
          line: lineNumber, t, seq, dropped: Number(m[5]), errors: Number(m[6]), reason: m[7],
        };
        s.lastDropped = Math.max(s.lastDropped, Number(m[5]));
        s.maxSeen = Math.max(s.maxSeen, seq);
        return;
      }
      if (TAG_AT_PREFIX_RE.test(line)) {
        // En journaltagg direkt efter prefixet som inte går att läsa är aldrig "ingenting".
        journalSeen = true;
        noteMalformed(lineNumber);
        return;
      }
      takePlain(line, lineNumber);
    },

    /**
     * @param {Array} gaps - tidshål från createTimeGapAudit (from/to med t och line)
     * @param {Object} [opts]
     * @param {number} [opts.stopTime] - när loggskriptet började stoppa körningen (ms).
     *   Utan den bevisas inte svansen efter sista kontrollpunkten (granskningen, L1).
     */
    finish(gaps = [], opts = {}) {
      const stopTime = Number.isFinite(opts.stopTime) ? opts.stopTime : null;
      const result = {
        journal: journalSeen,
        streams: [],
        problems: [],
        notes: [],
        healedSamples: [],
        restoredEntries: 0,
        restoredLines: [],
        state: null,
        holes: [],
        tail: null,
      };
      const lastStamp = lastStampLine === null ? null : timeOf(lastStampLine);
      const lastT = lastStamp ? lastStamp.t : null;
      if (!journalSeen) {
        for (const seg of order) if (seg.plain !== undefined) result.healedSamples.push(seg.plain);
        result.state = firstPlainState ? firstPlainState.json : null;
        return result;
      }
      if (malformed > 0) {
        globalProblems.push(`${malformed} journalrad(er) går inte att läsa (första loggrad ${firstMalformed})`);
      }
      if (plainSamples > 0) {
        globalProblems.push(`${plainSamples} sampel saknar löpnummer i en löpnummerlogg (första loggrad ${firstPlainLine})`);
      }
      if (plainEvents > 0) {
        globalProblems.push(`${plainEvents} journalförd(a) händelse(r) (notis, varning, textbyte eller starttillstånd) `
          + `saknar löpnummer medan en ström var aktiv (första loggrad ${firstPlainEventLine})`);
      }

      const streamList = order.filter((seg) => seg.sid).map((seg) => streams.get(seg.sid));
      // Villkor 6: en avstängd fångst mitt i loggen.
      streamList.forEach((s, i) => {
        if (s.end && s.end.reason === 'level' && i + 1 < streamList.length) {
          problem(s, `fångsten stängdes av (loggnivån sänktes) ${new Date(s.end.t).toISOString()} och startade igen `
            + `${new Date(streamList[i + 1].firstT).toISOString()} — sampel däremellan loggades inte`);
        }
      });

      for (let i = 0; i < streamList.length; i += 1) {
        const s = streamList[i];
        // Villkor 1.
        const first = s.entries.get(1);
        const startMatch = first ? START_MSG_RE.exec(first.message) : null;
        if (!startMatch || startMatch[1] !== s.sid) {
          problem(s, 'post 1 är inte strömmens [CAPTURE_START] — starten saknas');
        }
        // Villkor 2. Saknade nummer räknas utan att alla lagras (L5).
        const missing = [];
        let missingCount = 0;
        let restored = 0;
        for (let k = 1; k <= s.maxSeen; k += 1) {
          const e = s.entries.get(k);
          if (!e) {
            missingCount += 1;
            if (missing.length < MAX_LISTED) missing.push(k);
          } else if (e.via === 'resend') restored += 1;
        }
        if (missingCount > 0) {
          problem(s, `${missingCount} post(er) saknas och kunde inte läkas (nummer ${missing.join(', ')}`
            + `${missingCount > MAX_LISTED ? ', …' : ''})`);
        }
        // Svansen (L1): den sista strömmen utan [CAPTURE_END] var aktiv när
        // körningen stoppades. Allt fram till sista kontrollpunkten är bevisat;
        // därefter bara om kontrollpunkten ligger högst 65 s före stoppet.
        if (i === streamList.length - 1 && !s.end) {
          const lastCheckpoint = s.checkpoints[s.checkpoints.length - 1] || null;
          const cpT = lastCheckpoint ? lastCheckpoint.t : null;
          result.tail = {
            sid: s.sid, lastCheckpointT: cpT, stopTime, proven: false,
          };
          if (stopTime === null) {
            result.notes.push('SVANSEN OBEVISAD (U71): stopptid saknas. Fångsten är bevisad fram till sista kontrollpunkten '
              + `${cpT === null ? '(ingen)' : new Date(cpT).toISOString()}; poster efter den kan saknas utan att grinden ser det.`);
          } else if (cpT === null || stopTime - cpT > CHECKPOINT_LIMIT_MS) {
            problem(s, `svansen är obevisad: sista kontrollpunkten ${cpT === null ? 'saknas' : new Date(cpT).toISOString()}, `
              + `körningen stoppades ${new Date(stopTime).toISOString()}`
              + `${cpT === null ? '' : ` (${Math.round((stopTime - cpT) / 100) / 10} s, gräns ${CHECKPOINT_LIMIT_MS / 1000} s)`}`
              + ' — ett hål kan ha nått stoppet');
          } else {
            result.tail.proven = true;
          }
        }
        // Villkor 8: kontrollpunkternas takt.
        let endT = s.lastT;
        if (s.end) endT = s.end.t;
        else if (i + 1 < streamList.length) endT = streamList[i + 1].firstT;
        else if (lastT !== null) endT = lastT;
        const points = [s.firstT, ...s.checkpoints.map((c) => c.t)];
        if (endT !== null) points.push(endT);
        for (let p = 1; p < points.length; p += 1) {
          const a = points[p - 1];
          const b = points[p];
          if (a === null || b === null || b - a <= CHECKPOINT_LIMIT_MS) continue;
          const covered = gaps.some((g) => g.from.t >= a && g.to.t <= b);
          if (!covered) {
            problem(s, `kontrollpunkt saknas mellan ${new Date(a).toISOString()} och ${new Date(b).toISOString()} `
              + `(${Math.round((b - a) / 100) / 10} s, gräns ${CHECKPOINT_LIMIT_MS / 1000} s)`);
          }
        }
        const lastCp = s.checkpoints[s.checkpoints.length - 1];
        const dropped = Math.max(s.lastDropped, s.end ? s.end.dropped : 0);
        const errors = Math.max(lastCp ? lastCp.errors : 0, s.end ? s.end.errors : 0);
        if (dropped > 0) result.notes.push(`ström ${s.sid}: ${dropped} post(er) släpptes ur bufferten före sin sista omsändning`);
        if (errors > 0) result.notes.push(`ström ${s.sid}: journalen räknade ${errors} skrivfel`);
        result.restoredEntries += restored;
        result.streams.push({
          sid: s.sid,
          firstLine: s.firstLine,
          lastLine: s.lastLine,
          entries: s.entries.size,
          maxSeq: s.maxSeen,
          restored,
          duplicates: s.duplicates,
          checkpoints: s.checkpoints.length,
          dropped,
          errors,
          end: s.end ? s.end.reason : null,
          problems: s.problems.slice(),
        });
        for (const p of s.problems) result.problems.push(`LÖPNUMMER (U71) ström ${s.sid}: ${p}`);
      }
      result.problems.unshift(...globalProblems.map((p) => `LÖPNUMMER (U71): ${p}`));

      // Villkor 9: tidshålen.
      const markLines = marks.map((mk) => mk.line);
      const lastMarkAtOrBefore = (line) => {
        let lo = 0;
        let hi = markLines.length - 1;
        let ans = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (markLines[mid] <= line) {
            ans = mid; lo = mid + 1;
          } else hi = mid - 1;
        }
        return ans;
      };
      for (const g of gaps) {
        const hole = {
          from: g.from, to: g.to, ms: g.ms, excused: false, reason: null, restored: 0,
        };
        const bi = lastMarkAtOrBefore(g.from.line);
        // Första journalraden på eller efter hålets slutrad.
        const beforeEnd = lastMarkAtOrBefore(g.to.line - 1);
        const ai = beforeEnd + 1 < marks.length ? beforeEnd + 1 : -1;
        const before = bi >= 0 ? marks[bi] : null;
        const after = ai >= 0 ? marks[ai] : null;
        const s = before ? streams.get(before.sid) : null;
        if (!before || !after) hole.reason = 'ingen journalrad före eller efter hålet';
        else if (before.sid !== after.sid) hole.reason = `strömmen byttes i hålet (${before.sid} → ${after.sid})`;
        else if (before.kind === 'end') hole.reason = 'strömmen hade redan avslutats före hålet';
        else if (s.problems.length > 0) hole.reason = 'strömmen har andra löpnummerfel';
        else {
          const cp = s.checkpoints.find((c) => c.line >= g.to.line);
          if (!cp) hole.reason = 'ingen kontrollpunkt efter hålet';
          else if (cp.dropped > 0) hole.reason = `bufferten hade släppt ${cp.dropped} post(er) när hålet täcktes`;
          else {
            hole.excused = true;
            for (const e of s.entries.values()) {
              if (e.via === 'resend' && e.at > g.from.t && e.at < g.to.t) hole.restored += 1;
            }
          }
        }
        result.holes.push(hole);
      }
      if (globalProblems.length > 0) {
        for (const h of result.holes) {
          if (h.excused) {
            h.excused = false; h.reason = 'loggen har löpnummerfel'; h.restored = 0;
          }
        }
      }

      for (const s of streamList) {
        for (let k = 1; k <= s.maxSeen; k += 1) {
          const e = s.entries.get(k);
          if (e && e.message.indexOf(SAMPLE_MARKER) !== -1) result.healedSamples.push(sampleJson(e.message));
        }
        // Sampel utan nummer läggs där de stod (de fäller ändå körningen).
      }
      if (plainSamples > 0) {
        // Bevara loggordningen mellan strömmar och sampel utan nummer.
        const healed = [];
        for (const seg of order) {
          if (seg.plain !== undefined) healed.push(seg.plain);
          else {
            const s = streams.get(seg.sid);
            for (let k = 1; k <= s.maxSeen; k += 1) {
              const e = s.entries.get(k);
              if (e && e.message.indexOf(SAMPLE_MARKER) !== -1) healed.push(sampleJson(e.message));
            }
          }
        }
        result.healedSamples = healed;
      }

      // Starttillståndet: det första i loggordning (som skriptets grep -m 1),
      // ur en ström i nummerordning eller en rad utan nummer.
      for (const s of streamList) {
        if (firstPlainState && firstPlainState.line < s.firstLine) break;
        for (let k = 1; k <= s.maxSeen && result.state === null; k += 1) {
          const e = s.entries.get(k);
          if (e && e.message.indexOf(STATE_CUT) !== -1) {
            result.state = e.message.slice(e.message.lastIndexOf(STATE_CUT) + STATE_CUT.length);
          }
        }
        if (result.state !== null) break;
      }
      if (result.state === null && firstPlainState) result.state = firstPlainState.json;

      // Återställda rader i loggens format, för fältjämförelsen (notiser,
      // varningar och textbyten som annars hade saknats i hålen).
      for (const s of streamList) {
        for (const [seq, e] of s.entries) {
          if (e.via !== 'resend') continue;
          result.restoredLines.push({
            t: e.at,
            line: `${new Date(e.at).toISOString()} [${e.err ? 'err' : 'log'}] [${e.app}] #${s.sid}:${seq} ${e.message}`,
          });
        }
      }
      result.restoredLines.sort((a, b) => a.t - b.t);
      return result;
    },
  };
}

/** Strömmar en fil rad för rad (tillståndsbärande UTF-8, som checkReplayIntegrity). */
function forEachLine(filePath, cb) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(4 * 1024 * 1024);
  const decoder = new StringDecoder('utf8');
  let rest = '';
  let n = 0;
  const take = (raw) => {
    n += 1;
    cb(raw.endsWith('\r') ? raw.slice(0, -1) : raw, n);
  };
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read <= 0) break;
      const chunk = rest + decoder.write(buf.subarray(0, read));
      const parts = chunk.split('\n');
      rest = parts.pop();
      for (const raw of parts) take(raw);
    }
    rest += decoder.end();
    if (rest !== '') take(rest);
  } finally {
    fs.closeSync(fd);
  }
}

/** Hela läkningen av en loggfil (utan tidshålsregeln; den ägs av grinden). */
function healLogFile(filePath, gaps) {
  const audit = createJournalAudit();
  forEachLine(filePath, (line, n) => audit.take(line, n));
  return audit.finish(gaps || []);
}

function main(argv) {
  const args = argv.slice(2);
  const mode = args[0];
  const file = args[1];
  if (!['--jsonl', '--state', '--summary'].includes(mode) || !file) {
    process.stderr.write('Användning: node captureJournal.js --jsonl|--state|--summary <app.log>\n');
    return 2;
  }
  let res;
  try {
    res = healLogFile(file);
  } catch (err) {
    process.stderr.write(`kan inte läsa loggen: ${err.message}\n`);
    return 2;
  }
  if (mode === '--state') {
    // Tomt utdata = inget starttillstånd (skriptet behåller då ingen fil).
    if (res.state !== null) process.stdout.write(`${res.state}\n`);
    return 0;
  }
  if (mode === '--jsonl') {
    const out = res.healedSamples.length > 0 ? `${res.healedSamples.join('\n')}\n` : '';
    process.stdout.write(out);
    return 0;
  }
  process.stdout.write(`${JSON.stringify({
    journal: res.journal,
    samples: res.healedSamples.length,
    restoredEntries: res.restoredEntries,
    streams: res.streams,
    problems: res.problems,
  }, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = {
  createJournalAudit,
  healLogFile,
  forEachLine,
  CHECKPOINT_LIMIT_MS,
  JOURNAL_TAGS,
};
