'use strict';

/**
 * Samlad dom med sanningsoraklen (T1, T2/T3/T4, T9, T10) över en kontext.
 * Se truthCommon.js för kontextens form och fyndformatet.
 */

const { judgeT1 } = require('./t1Notice');
const { judgeT2T3 } = require('./t2Opening');
const { judgeT9 } = require('./t9Direction');
const { judgeT10 } = require('./t10Passage');

const ALL = ['T1', 'T2', 'T9', 'T10'];

/**
 * Kör de valda sanningsoraklen. 'T2' kör även T3 och T4-liggaren.
 * @param {object} ctx - orakelkontext
 * @param {object} [opts] - {oracles: ['T1','T2','T9','T10']}
 * @returns {{fynd:object[], räknare:object}} alla utslag och räknare per orakel
 */
function judgeTruth(ctx, { oracles = ALL } = {}) {
  const fynd = [];
  const räknare = {};
  if (oracles.includes('T1')) {
    const r = judgeT1(ctx);
    fynd.push(...r.fynd);
    räknare.T1 = r['räknare'];
  }
  if (oracles.includes('T2')) {
    const r = judgeT2T3(ctx);
    fynd.push(...r.fynd);
    Object.assign(räknare, r['räknare']);
  }
  if (oracles.includes('T9')) {
    const r = judgeT9(ctx);
    fynd.push(...r.fynd);
    räknare.T9 = r['räknare'];
  }
  if (oracles.includes('T10')) {
    const r = judgeT10(ctx);
    fynd.push(...r.fynd);
    räknare.T10 = r['räknare'];
  }
  return { fynd, räknare };
}

/** Fyndets förklarade klass, eller KANDIDAT. */
const statusOf = (f) => (f['belägg'] && f['belägg']['förklaring'] ? f['belägg']['förklaring'].klass : 'KANDIDAT');

module.exports = { judgeTruth, statusOf, ALL_TRUTH_ORACLES: ALL };
