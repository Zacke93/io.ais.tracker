'use strict';

/**
 * Hälsoorakel (BUGGJAKT §6, orakelkatalogen H1–H3 och H5).
 *
 *   H1 PROCESSFEL   fatal, processErrors, shutdownErrors, timersAfterShutdown,
 *                   timersAfterRestartShutdown — absolut i syntetiska världar,
 *                   differentiellt (> basens värde) i bankvarianter. Allvar 10.
 *   H2 HÄNG         två tidsgränser i rad i poolen. Allvar 10.
 *   H3 NY APP ERROR-SIGNATUR  stderr-signatur som saknas i baslinjen →
 *                   KANDIDAT (allvar 4); en känd signatur ≥ 10 × baslinjens
 *                   takt per simulerad timme → OBSERVATION (räknare).
 *   H5 DETERMINISM  byte-identitet efter att leakDiagnostics.heapUsedMB
 *                   strukits. En avvikelse är INSTRUMENTFEL, aldrig appfynd.
 *
 * Baslinjen för H3 injiceras (bygg den med buildH3Baseline ur självtestets
 * bankvarv); registret klassar dessutom signaturer som matchar
 * GPS_JUMP-DIAGNOSTIK.
 */

const { makeFinding } = require('../finding');

const H1_SEVERITY = 10;
const H2_SEVERITY = 10;
const H3_SEVERITY = 4;
const H3_RATE_FACTOR = 10;

/** Processfelsmåtten ur ett resultat (alla tal ≥ 0). */
function processMeasures(result) {
  const rd = (result && result.runtimeDiagnostics) || {};
  const restartTimers = Array.isArray(rd.timersAfterRestartShutdown) ? rd.timersAfterRestartShutdown : [];
  return {
    processErrors: Number(result && result.processErrors) || 0,
    shutdownErrors: Number(rd.shutdownErrors) || 0,
    timersAfterShutdown: Number(rd.timersAfterShutdown) || 0,
    timersAfterRestartShutdown: restartTimers.reduce((s, x) => s + (Number(x) || 0), 0),
  };
}

/**
 * H1 för ett poolutfall. Med `bas` dömer funktionen differentiellt.
 * @param {object} utfall - poolens utfall {ok, fatal, fel, resultat}
 * @param {{bas?: object}} [opts] - basens resultat för bankvarianter
 * @returns {object[]} fynd
 */
function h1(utfall, { bas = null } = {}) {
  const fynd = [];
  if (utfall.fatal) {
    fynd.push(makeFinding({
      orakel: 'H1', klass: 'PROCESSFEL fatal', allvar: H1_SEVERITY, detalj: `replayRunner svarade fatal: ${utfall.fatal}`, belägg: { fatal: utfall.fatal },
    }));
    return fynd;
  }
  if (!utfall.resultat) return fynd; // tolkfel och häng redovisas av anroparen (motorfel/H2)
  const m = processMeasures(utfall.resultat);
  const b = bas ? processMeasures(bas) : {
    processErrors: 0, shutdownErrors: 0, timersAfterShutdown: 0, timersAfterRestartShutdown: 0,
  };
  for (const [k, v] of Object.entries(m)) {
    if (v > b[k]) {
      fynd.push(makeFinding({
        orakel: 'H1',
        klass: `PROCESSFEL ${k}`,
        allvar: H1_SEVERITY,
        detalj: bas ? `${k} = ${v} mot basens ${b[k]}` : `${k} = ${v}`,
        belägg: { mått: k, värde: v, bas: bas ? b[k] : null },
      }));
    }
  }
  return fynd;
}

/** H2 för ett poolutfall. */
function h2(utfall) {
  if (!utfall.häng) return [];
  return [makeFinding({
    orakel: 'H2',
    klass: 'HÄNG',
    allvar: H2_SEVERITY,
    detalj: `ingen __REPLAY_JSON__-markör inom ${utfall.försök.map((f) => `${f.tidsgränsMs} ms`).join(' och ')}`,
    belägg: { försök: utfall.försök.map((f) => ({ tidsgränsMs: f.tidsgränsMs, tidsgräns: f.tidsgräns })) },
  })];
}

/**
 * Bygger H3-baslinjen ur poolutfall (självtestets två bankvarv).
 * @param {object[]} utfall - poolutfall med stderr.h3 och simTimmar
 * @returns {{signaturer: object, timmar: number}} baslinje
 */
function buildH3Baseline(utfall) {
  const signaturer = {};
  let timmar = 0;
  for (const u of utfall) {
    timmar += Number(u.simTimmar) || 0;
    for (const [sig, n] of Object.entries((u.stderr && u.stderr.h3) || {})) signaturer[sig] = (signaturer[sig] || 0) + n;
  }
  return { signaturer, timmar };
}

/**
 * H3 för ett stderr-histogram mot baslinjen.
 * @param {object} h3Hist - {signatur: antal}
 * @param {{signaturer: object, timmar: number}} baslinje - injicerad baslinje
 * @param {{simTimmar?: number, exempel?: object}} [opts] - körningens längd och exempelrader
 * @returns {object[]} fynd (KANDIDAT-utslag och OBSERVATION-räknare)
 */
function h3(h3Hist, baslinje, { simTimmar = 1, exempel = {} } = {}) {
  const fynd = [];
  const known = (baslinje && baslinje.signaturer) || {};
  const baseHours = Math.max(1e-6, (baslinje && baslinje.timmar) || 0);
  for (const [sig, n] of Object.entries(h3Hist || {})) {
    if (!(sig in known)) {
      fynd.push(makeFinding({
        orakel: 'H3',
        klass: sig,
        allvar: H3_SEVERITY,
        detalj: `ny stderr-signatur (${n} ×): ${exempel[sig] || sig}`,
        belägg: { signatur: sig, antal: n, exempel: exempel[sig] || null },
      }));
      continue;
    }
    const rate = n / Math.max(1e-6, simTimmar);
    const baseRate = known[sig] / baseHours;
    if (rate >= H3_RATE_FACTOR * baseRate) {
      fynd.push(makeFinding({
        orakel: 'H3',
        klass: `OBSERVATION ${sig}`,
        räknare: true,
        detalj: `känd signatur ${(rate / baseRate).toFixed(1)} × baslinjens takt per simulerad timme`,
        belägg: {
          signatur: sig, antal: n, takt: rate, basTakt: baseRate,
        },
      }));
    }
  }
  return fynd;
}

/** Kopia av resultatet utan leakDiagnostics.heapUsedMB (och runnerns tidsmått). */
function stripForH5(result) {
  const x = JSON.parse(JSON.stringify(result));
  if (x && x.leakDiagnostics) delete x.leakDiagnostics.heapUsedMB;
  if (x) delete x.__elapsedMs;
  return x;
}

function firstDifference(a, b, at = '') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return `${at || '(rot)'}: ${JSON.stringify(a)?.slice(0, 120)} ≠ ${JSON.stringify(b)?.slice(0, 120)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${at}: lista ≠ objekt`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${at}: längd ${a.length} ≠ ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.join('\u0001') !== kb.join('\u0001')) return `${at}: nycklar ${ka.join(',').slice(0, 120)} ≠ ${kb.join(',').slice(0, 120)}`;
  for (const k of ka) {
    const d = firstDifference(a[k], b[k], at ? `${at}.${k}` : k);
    if (d) return d;
  }
  return null;
}

/**
 * H5: är två resultat byte-identiska bortsett från heapUsedMB?
 * @param {object} a - resultat 1
 * @param {object} b - resultat 2
 * @returns {{lika: boolean, skillnad: string|null}} utfall
 */
function h5(a, b) {
  const sa = JSON.stringify(stripForH5(a));
  const sb = JSON.stringify(stripForH5(b));
  if (sa === sb) return { lika: true, skillnad: null };
  return { lika: false, skillnad: firstDifference(JSON.parse(sa), JSON.parse(sb)) || 'byteskillnad' };
}

module.exports = {
  H1_SEVERITY,
  H2_SEVERITY,
  H3_SEVERITY,
  H3_RATE_FACTOR,
  processMeasures,
  h1,
  h2,
  buildH3Baseline,
  h3,
  stripForH5,
  firstDifference,
  h5,
};
