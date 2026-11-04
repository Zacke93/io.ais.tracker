'use strict';

/**
 * T9 — RIKTNINGSSANNING (orakelkatalogen, BUGGJAKT.md bilaga B).
 *
 * En levererad notis eller öppningsvarning med riktningen northbound eller
 * southbound jämförs med L0. För kort jämförs ledarens riktning. Utslag när
 * ALLA L0-prov med |v| > 0,25 m/s i [t − 180 s; t] har samma tecken och
 * tecknet motsäger riktningen. Allvar 4.
 *
 * Förutsättning ur L1 (domregeln, BUGGJAKT.md §4.3): radion har levererat
 * minst två fixar efter båtens senaste L0-vändning, senast 30 s (en tick)
 * före anspråket. Annars kunde appen inte veta att riktningen bytts; byggets
 * första körning gav just ett sådant fall (vändning 2 s före fönstret och
 * första fix efter vändningen 56 s EFTER varningen).
 *
 * Vakter: unknown är aldrig fel (D4-RIKTNING-UNKNOWN, reliability-spec D4
 * rev. 2026-07-02). Ingen dom när L0 vänt inom fönstret (U-sväng), för
 * blandade kort (mixed) eller utan L0 (banken). FIXD-SLINGA (KÄND_ÖPPEN)
 * vid minst två vändningar inom 60 min. INV-15 (WARN) mäter samma sak mot
 * latitud och ger bara en räknare där.
 */

const {
  fynd, deliveredNotices, deliveredWarnings, hms, iso, reversalsNear,
} = require('./truthCommon');

const WINDOW_S = 180;
const MIN_V = 0.25;
const MIN_FIXES_AFTER_TURN = 2;
const TICK_MS = 30000; // BRIDGE_OPENING.TICK_INTERVAL_MS

/**
 * Döm T9.
 * @param {object} ctx - orakelkontext (kräver truth.L0 för dom)
 * @returns {{fynd:object[], räknare:object}} utslag och räknare
 */
function judgeT9(ctx) {
  const L0 = ctx.truth.L0 || null;
  const räknare = {
    prövade: 0, unknown: 0, ingenDomVändning: 0, ingenDomStilla: 0, ingenDomOobserverad: 0, förklarade: {},
  };
  const fixes = (ctx.truth.L1 && ctx.truth.L1.fixes) || new Map();
  const out = [];
  if (!L0) return { fynd: out, räknare: { ...räknare, utanL0: 1 } };
  const claims = [
    ...deliveredNotices(ctx.result).map((n) => ({
      kind: 'notis', t: n.t, mmsi: String(n.mmsi), bro: n.bridge, riktning: n.direction, text: n.message,
    })),
    ...deliveredWarnings(ctx.result).map((w) => ({
      kind: 'varning', t: w.t, mmsi: String(w.leadMmsi), bro: w.bridge, riktning: w.direction, text: w.eventId,
    })),
  ];
  for (const c of claims) {
    if (c.riktning !== 'northbound' && c.riktning !== 'southbound') {
      räknare.unknown++;
      continue;
    }
    const bt = L0.boats.get(c.mmsi);
    if (!bt || !bt.traj.length || bt.spec.role === 'moored') continue;
    const tr = bt.traj;
    const tS = (c.t - L0.startMs) / 1000;
    const i0 = Math.max(0, Math.round(tS - WINDOW_S - tr[0].t));
    const i1 = Math.min(tr.length - 1, Math.round(tS - tr[0].t));
    if (i1 < 0 || i0 > tr.length - 1 || i1 < i0) continue;
    räknare['prövade']++;
    const signs = new Set();
    for (let i = i0; i <= i1; i++) if (Math.abs(tr[i].v) > MIN_V) signs.add(Math.sign(tr[i].v));
    if (signs.size === 0) {
      räknare['ingenDomStilla']++;
      continue;
    }
    if (signs.size > 1) {
      räknare['ingenDomVändning']++;
      continue;
    }
    const truthDir = [...signs][0] > 0 ? 'northbound' : 'southbound';
    if (truthDir === c.riktning) continue;
    // L1: hade radion visat den nya riktningen när anspråket gjordes?
    const lastTurn = L0.uturns.filter((u) => u.mmsi === c.mmsi && u.t <= c.t).reduce((m, u) => Math.max(m, u.t), -Infinity);
    const seenAfter = (fixes.get(c.mmsi) || []).filter((f) => f.fixTs > lastTurn && f.aisTimestamp <= c.t - TICK_MS).length;
    if (seenAfter < MIN_FIXES_AFTER_TURN) {
      räknare['ingenDomOobserverad']++;
      continue;
    }
    let förklaring = null;
    if (reversalsNear(L0, c.mmsi, c.t) >= 2) {
      förklaring = { post: 'FIXD-SLINGA', klass: 'KÄND_ÖPPEN', varför: 'minst två vändningar inom 60 min' };
      räknare['förklarade']['FIXD-SLINGA'] = (räknare['förklarade']['FIXD-SLINGA'] || 0) + 1;
    }
    out.push(fynd({
      orakel: 'T9',
      klass: 'FEL-RIKTNING',
      allvar: 4,
      mmsi: c.mmsi,
      bro: c.bro,
      riktning: c.riktning,
      t: c.t,
      detalj: `${c.kind} ${hms(c.t)} (${String(c.text || '').slice(0, 60)}) har riktning ${c.riktning}, men båten färdades ${truthDir} hela föregående ${WINDOW_S} s enligt L0`,
      belägg: {
        anspråk: {
          slag: c.kind, t: iso(c.t), riktning: c.riktning, text: c.text,
        },
        sannRiktning: truthDir,
        fönsterS: WINDOW_S,
        senasteVändning: Number.isFinite(lastTurn) ? iso(lastTurn) : null,
        fixarEfterVändning: seenAfter,
        förklaring,
      },
    }));
  }
  return { fynd: out, räknare };
}

module.exports = { judgeT9 };
