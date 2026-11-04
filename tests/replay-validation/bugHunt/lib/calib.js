'use strict';

/**
 * Fryst kalibrering för sanningsspåret (BUGGJAKT.md §4, byggplanens steg 7).
 *
 * Läser BARA tests/replay-validation/bugHunt/calibration.json, som skrivs av
 * tools/freezeCalibration.js med --write. Ingen mätning sker här, och inget
 * skrivs. Självtestet jämför bankens SHA-256 (de 24 låsta jsonl- och
 * state-filerna i corpora.js-ordning) med värdet i filen och varnar om banken
 * har ändrats sedan frysningen.
 *
 * Samplarna är styckvis linjära invers-CDF:er över fältets kvantiltabeller.
 * Översta hinken log-interpoleras, eftersom fältets svans är tunn men lång.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { computeBankHash } = require('./bankHash');

const CALIBRATION_FILE = path.join(__dirname, '..', 'calibration.json');
// eslint-disable-next-line import/no-dynamic-require
const CAL = require(CALIBRATION_FILE);

const SPEC = CAL['fält'];
const QUAYS = CAL.kajplatser;

const QKEYS = [['p10', 0.10], ['p25', 0.25], ['p50', 0.50], ['p75', 0.75], ['p90', 0.90], ['p95', 0.95], ['p99', 0.99]];

/**
 * Invers-CDF ur en kvantiltabell {p10, p25, p50, p75, p90, p95, p99, max}.
 * @param {object} q - kvantiltabell
 * @param {object} [opts] - {floor, tail}
 * @param {number|null} [opts.floor] - lägsta värde (p0); annars extrapolerat
 * @param {'max'|'p99'} [opts.tail] - 'max' tar med hela svansen, 'p99' klipper
 * @returns {function(number): number} u ∈ [0, 1] → värde
 */
function quantileSampler(q, { floor = null, tail = 'max' } = {}) {
  const pts = [];
  const lo = floor !== null ? floor : Math.max(0, q.p10 - (q.p25 - q.p10));
  pts.push([0, lo]);
  for (const [k, p] of QKEYS) if (Number.isFinite(q[k])) pts.push([p, q[k]]);
  pts.push([1, tail === 'max' && Number.isFinite(q.max) ? q.max : q.p99]);
  for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[i - 1][1]) pts[i][1] = pts[i - 1][1];
  return (u) => {
    for (let i = 1; i < pts.length; i++) {
      if (u <= pts[i][0]) {
        const [p0, v0] = pts[i - 1];
        const [p1, v1] = pts[i];
        const f = (u - p0) / ((p1 - p0) || 1);
        if (i === pts.length - 1 && v0 > 0 && v1 > v0) return v0 * ((v1 / v0) ** f);
        return v0 + ((v1 - v0) * f);
      }
    }
    return pts[pts.length - 1][1];
  };
}

const R = SPEC.rapportintervall_s;
/** Rapportintervall (s) per era, klass och rörelse. */
const cadence = {
  aisstream: {
    A: { move: quantileSampler(R.aisstream_eran.A_transit, { floor: 10 }), still: quantileSampler(R.aisstream_eran.A_stilla, { floor: 170 }) },
    B: { move: quantileSampler(R.aisstream_eran.B_transit, { floor: 30 }), still: quantileSampler(R.aisstream_eran.B_stilla, { floor: 170 }) },
  },
  aishub: {
    A: { move: quantileSampler(R.aishub_solo.A_transit, { floor: 58 }), still: quantileSampler(R.aishub_solo.A_stilla, { floor: 175 }) },
    B: { move: quantileSampler(R.aishub_solo.B_transit, { floor: 55 }), still: quantileSampler(R.aishub_solo.B_stilla, { floor: 170 }) },
  },
};

const F = SPEC.fart_kn;
/** Marschfart (kn) per klass, svansen klippt vid p99. */
const cruise = {
  A: quantileSampler(F['marschPerSpår'].A, { tail: 'p99' }),
  B: quantileSampler(F['marschPerSpår'].B, { tail: 'p99' }),
};

/** Sektormedian (kn) per "sektor|nord/syd". */
const sectorMedian = {};
for (const [k, v] of Object.entries(F.perSektorRiktning)) {
  const [sec, dir] = k.split(' | ');
  sectorMedian[`${sec}|${dir}`] = v.p50;
}

const KOE = SPEC['kö'];
/** Kölängd (min) ur fältets äkta köer (≤ 120 min, ej gästhamn): p50 15, p90 39. */
const queueDurMin = quantileSampler(KOE['äktaKöer'].durationMin, { floor: 2, tail: 'p99' });
/** AISHub-fixålder (s) i rörelse respektive stilla. */
const ageMove = quantileSampler(SPEC.aishub['ålder_s']['låsta | rörelse'], { floor: 0, tail: 'p99' });
const ageStill = quantileSampler(SPEC.aishub['ålder_s']['låsta | stilla'], { floor: 0, tail: 'p99' });
/** Namnbackfill (min) för klass B i aisstream-eran. */
const nameDelayMin = quantileSampler(SPEC['fältkvalitet'].namnBackfill.delayMin, { floor: 1, tail: 'p99' });
/** cog-fel mot farleden (grader). */
const cogErr = quantileSampler(SPEC.gps.cogFelMotFarled_grader, { floor: 0, tail: 'p99' });

/** Köplatser per bro och riktning (fältets avstånd före bron, m). */
const QUEUE_SITES = CAL['köplatser'];
/** Klaffbronkorsningar per lokal timme (täthetsnivå "realistisk"). */
const hourRate = CAL.dygnstakt;
/** Klassmix för transitspår: andel klass A dagtid (natt: bara klass A). */
const KM = SPEC.klassmixTransitspår;
const classAShareDay = KM['A | dag'] / (KM['A | dag'] + KM['B | dag']);

/**
 * Jämför bankens aktuella hash med den frysta. Kastar aldrig; självtestet
 * avgör om en avvikelse ska varna.
 * @param {object[]} [corpora] - korpuslistan (standard: corpora.js)
 * @returns {{ok:boolean, fryst:string, aktuell:string, ändrade:string[]}} utfall
 */
function checkBankHash(corpora) {
  const now = computeBankHash(corpora);
  const frozen = CAL.bank || {};
  const byId = new Map((frozen.filer || []).map((f) => [f.id, f]));
  const ändrade = now.filer
    .filter((f) => {
      const old = byId.get(f.id);
      return !old || old.sha256 !== f.sha256 || old.stateSha256 !== f.stateSha256;
    })
    .map((f) => f.id);
  for (const id of byId.keys()) if (!now.filer.some((f) => f.id === id)) ändrade.push(id);
  return {
    ok: now.sha256 === frozen.sha256, fryst: frozen.sha256 || null, aktuell: now.sha256, ändrade,
  };
}

/** Kalibreringens innehållshash (för körnings-id:t, BUGGJAKT.md §3). */
const calibrationHash = crypto.createHash('sha256').update(fs.readFileSync(CALIBRATION_FILE)).digest('hex');

module.exports = {
  CAL,
  CALIBRATION_FILE,
  calibrationHash,
  SPEC,
  QUAYS,
  quantileSampler,
  cadence,
  cruise,
  sectorMedian,
  queueDurMin,
  ageMove,
  ageStill,
  nameDelayMin,
  cogErr,
  QUEUE_SITES,
  hourRate,
  classAShareDay,
  computeBankHash,
  checkBankHash,
};
