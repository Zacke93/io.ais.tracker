'use strict';

/**
 * Gemensamma hjälpare för sanningsoraklen T1, T2/T3/T4, T9 och T10
 * (BUGGJAKT.md §6, bilaga B).
 *
 * KONTEXTEN som varje orakel tar:
 *   {
 *     result,     replayresultatet (__REPLAY_JSON__)
 *     rows,       världens eller korpusens rader (samma som jsonl:en)
 *     truth,      {L1, L0?}: L1 krävs, L0 saknas på banken
 *     world?,     världens spec (taggar, ctrl-händelser)
 *     jsonlPath?, används för runOpeningGates.loadSamples när den finns
 *     namespaceEventIds?, instances.namespaceEventIds (annars intern variant)
 *     opts?       orakelspecifika trösklar
 *   }
 * och returnerar {fynd: [...], räknare: {...}}.
 *
 * FYNDFORMATET är motorns gemensamma:
 *   {orakel, klass, allvar, mmsi, bro, riktning, t, detalj, belägg}
 * `belägg.förklaring` = {post, klass, varför} när en falsklarmsvakt ur
 * orakelkatalogen träffar (t.ex. BESÖKSREGEL-2026-09-07 → DESIGN). Det är
 * oraklets förslag; beslutsregistret har sista ordet. Saknas förklaring är
 * utslaget en KANDIDAT.
 */

const geo = require('../geo');

const iso = (t) => (Number.isFinite(t) ? new Date(Math.round(t)).toISOString() : null);
const hms = (t) => (Number.isFinite(t) ? new Date(Math.round(t)).toISOString().slice(11, 19) : '?');

/** Intern riktning ur L0/facit ('nord'/'syd') i appens vokabulär. */
const toAppDir = (dir) => {
  if (dir === 'nord' || dir === 'north') return 'northbound';
  if (dir === 'syd' || dir === 'south') return 'southbound';
  return null;
};

/**
 * Ett fynd i motorns format. Tomma fält blir null, aldrig undefined.
 * @param {object} f - {orakel, klass, allvar, mmsi, bro, riktning, t, detalj, belägg}
 * @returns {object} fynd
 */
function fynd(f) {
  return {
    orakel: f.orakel,
    klass: f.klass,
    allvar: f.allvar,
    mmsi: f.mmsi === undefined || f.mmsi === null ? null : String(f.mmsi),
    bro: f.bro || null,
    riktning: f.riktning || null,
    t: Number.isFinite(f.t) ? Math.round(f.t) : null,
    detalj: f.detalj || '',
    belägg: f['belägg'] || {},
  };
}

/** Levererade notiser (success ≠ false), tidsordnade. */
function deliveredNotices(result) {
  return (result.notifications || [])
    .filter((n) => n && n.success !== false && Number.isFinite(n.t))
    .sort((a, b) => a.t - b.t);
}

/**
 * Hade appen fått fixen när notisen gick ut? (E6, kortet F21)
 *
 * Harnessen matar raderna i tidsordning. Före varje rad stegas klockan fram
 * till radens tid i 30 s-bitar med dränering i bitens slut
 * (replayRunner.js:512–521), så en notis från en timer eller en asynkron
 * omkörning kan gå ut på exakt nästa rads tid innan raden matats in. En fix
 * strikt före notisen hade appen fått. En tidslik fix räknas bara när
 * notisens frysta position (vesselLat/vesselLon, replayRunner.js:749–769)
 * är just den fixen, alltså när notisen byggdes på den. Annars väntade raden
 * på inmatning, och då är den harnessens nästa ännu inte inmatade rad
 * (vesselLatNext; se tiedAtNotice).
 * Uppmätt 2026-11-04 på standardens 2 000 världar och bankens bas (41 832
 * levererade notiser): regeln ger exakt harnessens gräns i varje notis.
 * @param {object} f - fix {aisTimestamp, lat, lon}
 * @param {object} n - levererad notis {t, vesselLat, vesselLon}
 * @returns {boolean} true om appen hade fått fixen
 */
function noticeHadFix(f, n) {
  if (f.aisTimestamp !== n.t) return f.aisTimestamp < n.t;
  return n.vesselLat === f.lat && n.vesselLon === f.lon;
}

/**
 * En tidslik fix som notisen INTE byggdes på: 'ej-inmatad' när harnessens
 * nästa ännu inte inmatade rad (vesselLatNext) är just den fixen, annars
 * 'oklar' (raden var inmatad men appens position är en annan, eller
 * fälten saknas). null när fixen inte är tidslik eller notisen byggdes på
 * den. noticeHadFix räknar ingen av dem; 'oklar' redovisas i räknarna.
 * @param {object} f - fix {aisTimestamp, lat, lon}
 * @param {object} n - levererad notis {t, vesselLat, vesselLon, vesselLatNext}
 * @returns {'ej-inmatad'|'oklar'|null} slaget
 */
function tiedAtNotice(f, n) {
  if (f.aisTimestamp !== n.t || noticeHadFix(f, n)) return null;
  return n.vesselLatNext === f.lat ? 'ej-inmatad' : 'oklar';
}

/** Levererade öppningsvarningar (success ≠ false), tidsordnade. */
function deliveredWarnings(result) {
  return (result.openingWarnings || [])
    .filter((w) => w && w.success !== false && Number.isFinite(w.t))
    .sort((a, b) => a.t - b.t);
}

/**
 * Namnrymd för eventId per app-instans (i<n>:id, n = antal ctrl:restart ≤ t).
 * Samma semantik som instances.namespaceEventIds; används bara när
 * kontexten inte skickar in den riktiga.
 */
function namespaceEventIdsFallback(result, rows) {
  const restarts = rows.filter((r) => r.ctrl === 'restart').map((r) => r.aisTimestamp).sort((a, b) => a - b);
  if (!restarts.length) return result;
  const inst = (t) => restarts.filter((r) => r <= t).length;
  const tag = (x) => (x && x.eventId ? { ...x, eventId: `i${inst(x.t)}:${x.eventId}` } : x);
  return {
    ...result,
    openingWarnings: (result.openingWarnings || []).map(tag),
    openingCoverage: (result.openingCoverage || []).map(tag),
    openingSuppressions: (result.openingSuppressions || []).map(tag),
  };
}

/** Resultatet med eventId i namnrymd (bara om raderna har ctrl:restart). */
function namespaced(ctx) {
  const fn = typeof ctx.namespaceEventIds === 'function' ? ctx.namespaceEventIds : namespaceEventIdsFallback;
  return fn(ctx.result, ctx.rows || []);
}

/**
 * Positionsrader per mmsi i samma form som runOpeningGates.loadSamples
 * (hela radobjekten, tidsordnade på aisTimestamp). Används när kontexten
 * saknar jsonlPath, t.ex. i jest-fixturer.
 */
function samplesFromRows(rows) {
  const by = new Map();
  for (const s of rows) {
    if (s.ctrl || typeof s.lat !== 'number' || typeof s.lon !== 'number') continue;
    const k = String(s.mmsi);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(s);
  }
  for (const list of by.values()) list.sort((a, b) => a.aisTimestamp - b.aisTimestamp);
  return by;
}

/** Samplen för öppningsgrindarna: loadSamples(jsonlPath) eller ur raderna. */
function samplesFor(ctx) {
  if (ctx.jsonlPath) {
    // eslint-disable-next-line global-require
    const gates = require('../../../runOpeningGates');
    return gates.loadSamples(ctx.jsonlPath);
  }
  return samplesFromRows(ctx.rows || []);
}

/** Tysta fönster [från, till) i ms ur radernas ctrl:disconnect/reconnect. */
function silenceWindowsMs(rows) {
  const ctrl = (rows || []).filter((r) => r.ctrl === 'disconnect' || r.ctrl === 'reconnect')
    .sort((a, b) => a.aisTimestamp - b.aisTimestamp);
  const out = [];
  let open = null;
  for (const r of ctrl) {
    if (r.ctrl === 'disconnect' && open === null) open = r.aisTimestamp;
    else if (r.ctrl === 'reconnect' && open !== null) {
      out.push([open, r.aisTimestamp]);
      open = null;
    }
  }
  if (open !== null) out.push([open, Infinity]);
  return out;
}

/** ctrl:restart-tider (ms). */
const restartTimes = (rows) => (rows || []).filter((r) => r.ctrl === 'restart').map((r) => r.aisTimestamp).sort((a, b) => a - b);

/** Farledskoordinat relativt bron i färdriktningen (+ = bortom bron). */
function beyondLineM(fix, bridge, dir) {
  const sB = geo.stationByName[bridge].s;
  const sign = dir === 'nord' || dir === 'north' || dir === 'northbound' ? 1 : -1;
  return (fix.s - sB) * sign;
}

/**
 * Antal U-svängar (riktningsbyten i L0) inom ett fönster för en båt — för
 * FIXD-SLINGA-vakten (≥ 2 vändningar inom 60 min).
 */
function reversalsNear(L0, mmsi, t, windowMs = 60 * 60000) {
  if (!L0) return 0;
  return L0.uturns.filter((u) => u.mmsi === String(mmsi) && Math.abs(u.t - t) <= windowMs).length;
}

/** Sammanslagning av räknare (för körningens totaler). */
function addCounters(into, from) {
  for (const [k, v] of Object.entries(from || {})) {
    if (typeof v === 'number') into[k] = (into[k] || 0) + v;
    else if (v && typeof v === 'object') {
      if (!into[k] || typeof into[k] !== 'object') into[k] = {};
      addCounters(into[k], v);
    }
  }
  return into;
}

module.exports = {
  iso,
  hms,
  toAppDir,
  fynd,
  deliveredNotices,
  noticeHadFix,
  tiedAtNotice,
  deliveredWarnings,
  namespaceEventIdsFallback,
  namespaced,
  samplesFromRows,
  samplesFor,
  silenceWindowsMs,
  restartTimes,
  beyondLineM,
  reversalsNear,
  addCounters,
};
