'use strict';

/**
 * Bekräftelse av varje minsta repro (BUGGJAKT §8; orakelkatalogen,
 * BEKRÄFTELSE).
 *
 *   1. H5: dubbelkörning i en ny process ska vara byte-identisk bortsett från
 *      heapUsedMB, och en ny simulering ur den SPARADE specen (JSON-tolkad)
 *      ska ge samma radhash. Annars INSTRUMENTFEL.
 *   2. SHIFT30: hela världen flyttad +30 s ska ge identiskt utfall efter
 *      t − 30 s (hela resultatet utom jsonl-namn, heapUsedMB och
 *      runtimeDiagnostics). Annars INSTRUMENTFEL.
 *   3. +7 s: försvinner utslaget taggas det KNIVSEGG men visas ändå.
 *   4. Ett R1-fynd körs med R0 på samma spec. Reproducerar det flyttas kortet
 *      till logikfel (ingen observerbarhetsursäkt).
 *
 * Steg 1–2 måste hålla; steg 3–4 ändrar bara taggar och prioritet. Sträckmål
 * S8 (nya radiodragningar, monitoring av och på) är inte byggt i v1.
 *
 * Modulen är ren: proven görs med den injicerade `probe`.
 */

const health = require('./oracles/health');
const project = require('./project');

const SHIFT30_MS = 30000;
const SHIFT7_MS = 7000;

const clone = (x) => JSON.parse(JSON.stringify(x));
const shifted = (spec, ms) => {
  const s = clone(spec);
  s.startMs += ms;
  return s;
};

/** Första skillnaden i compareExact som en kort rad. */
function diffText(skillnader) {
  const [k] = Object.keys(skillnader || {});
  if (!k) return 'okänd skillnad';
  const v = skillnader[k];
  return `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 240);
}

/**
 * Bekräftar en minsta repro.
 * @param {object} args - {spec, radio, monitoring, probe, holds, final, rehash}
 *   probe(spec, {radio, nocache}) → Promise<{built, utfall, fynd}>
 *   holds(fynd) → boolean (målet finns kvar)
 *   final = probe-utfallet för minsta spec
 *   rehash(specJsonText) → radhash för en ny simulering ur sparad spec
 * @returns {Promise<object>} {text, instrumentfel, knivsegg, r0Bekräftad, steg}
 */
async function confirmRepro({
  spec, radio, probe, holds, final, rehash,
}) {
  const steg = {};
  let instrumentfel = null;

  // 1. H5 — ny process, samma rader; ny simulering ur sparad spec.
  const again = await probe(spec, { radio, nocache: true });
  const sameRows = rehash(JSON.stringify(spec)) === final.built.radHash;
  let h5 = { lika: false, skillnad: 'körfel' };
  // Resultatets jsonl-fält bär provfilens namn; det jämförs inte.
  const utanNamn = (r) => ({ ...r, jsonl: null });
  if (final.utfall.ok && again.utfall.ok) h5 = health.h5(utanNamn(final.utfall.resultat), utanNamn(again.utfall.resultat));
  steg.h5 = { lika: h5.lika, skillnad: h5.skillnad, radhashLika: sameRows };
  if (!h5.lika) instrumentfel = `H5: dubbelkörningen skiljer (${h5.skillnad})`;
  else if (!sameRows) instrumentfel = 'H5: ny simulering ur den sparade specen gav en annan radhash';

  // 2. SHIFT30.
  const s30 = await probe(shifted(spec, SHIFT30_MS), { radio });
  let cmp = { lika: false, skillnader: { körfel: s30.utfall.fel } };
  if (final.utfall.ok && s30.utfall.ok) {
    cmp = project.compareExact(final.utfall.resultat, s30.utfall.resultat, { dt: SHIFT30_MS, helaResultatet: true });
  }
  steg.shift30 = { lika: cmp.lika, kvar: holds(s30.fynd), skillnad: cmp.lika ? null : diffText(cmp.skillnader) };
  if (!instrumentfel && !cmp.lika) instrumentfel = `SHIFT30: världen +30 s gav ett annat utfall (${steg.shift30.skillnad})`;

  // 3. +7 s.
  const s7 = await probe(shifted(spec, SHIFT7_MS), { radio });
  const kvar7 = holds(s7.fynd);
  steg.shift7 = { kvar: kvar7 };

  // 4. R1 → R0.
  let r0Bekräftad = radio === 'R0';
  if (radio !== 'R0') {
    const r0 = await probe(spec, { radio: 'R0' });
    r0Bekräftad = holds(r0.fynd);
    steg.r0 = { kvar: r0Bekräftad };
  }

  const delar = [
    h5.lika && sameRows ? 'deterministisk' : 'INTE deterministisk',
    cmp.lika ? '+30 s identisk' : '+30 s AVVIKER',
    kvar7 ? '+7 s kvar' : '+7 s borta (KNIVSEGG)',
  ];
  if (radio === 'R0') delar.push('R0 (ursprung)');
  else delar.push(r0Bekräftad ? 'R1 → R0: reproducerar (logikfel)' : 'R1 → R0: reproducerar inte (robusthet)');
  return {
    text: delar.join(' · '),
    instrumentfel,
    knivsegg: !kvar7,
    r0Bekräftad,
    steg,
  };
}

module.exports = {
  SHIFT30_MS, SHIFT7_MS, confirmRepro, diffText,
};
