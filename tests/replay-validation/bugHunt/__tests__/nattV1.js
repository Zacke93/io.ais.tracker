'use strict';

/**
 * Hjälpare för V1-testen (2026-11-16): nattjaktens representanter ur
 * fixtures/natt-v1-2026-11-16.json (världens spec och appens replayresultat
 * på f543190, där appen inte ändrats sedan). Världen byggs om ur specen
 * (ren beräkning, samma radhash som i jakten) och döms med alla orakel och
 * registret utan barnprocesser. `mutera(resultat, built)` får ändra en
 * djup kopia av resultatet och sanningen före domen, för motfallen.
 */

const core = require('../lib/synthCore');
const { loadRegistry } = require('../lib/registry');
const F = require('./fixtures/natt-v1-2026-11-16.json');

const kopia = (x) => JSON.parse(JSON.stringify(x));
let REG = null;
const register = () => {
  if (!REG) REG = loadRegistry();
  return REG;
};

/** Bygger världen och en muterbar sanning (L0 kopieras ytligt per lista). */
function bygg(id) {
  const x = kopia(F[id]);
  const b = core.materialize(x.spec.spec, { profile: x.spec.radio.profil });
  if (b.radHash !== x.radHash) throw new Error(`${id}: radhashen avviker (${b.radHash} mot ${x.radHash})`);
  const L0 = {
    ...b.truth.L0,
    crossings: b.truth.L0.crossings.map((c) => ({ ...c })),
    uturns: b.truth.L0.uturns.map((u) => ({ ...u })),
    stops: b.truth.L0.stops.map((s) => ({ ...s })),
  };
  const built = { ...b, rows: b.rows.map((r) => ({ ...r })), truth: { ...b.truth, L0 } };
  return { x, built };
}

/**
 * Dömer fallet `id`. Returnerar utslagen (inga räknare), kontexten och
 * resultatet med eventId i namnrymd.
 */
function döm(id, { mutera = null } = {}) {
  const { x, built } = bygg(id);
  if (mutera) mutera(x.utfall.resultat, built);
  const dom = core.judgeBuilt({
    built,
    utfall: x.utfall,
    jsonlPath: null,
    register: register(),
    meta: {
      index: x.värld, radio: x.spec.radio.profil, monitoring: !!x.spec.monitoring, profil: 'repro',
    },
    räkna: false,
  });
  return { fynd: dom.fynd.filter((f) => !f.räknare), kontext: dom.kontext, mål: x.mål };
}

/** Utslagen som [orakel klass, registerklass, post]. */
const sammanfattning = (fynd) => fynd.map((f) => [`${f.orakel} ${f.klass}`, f.register.klass, f.register.post || null]);

/** Utslaget av klassen (regex) eller undefined. */
const utslag = (fynd, re) => fynd.find((f) => re.test(`${f.orakel} ${f.klass}`));

module.exports = {
  F, kopia, register, bygg, döm, sammanfattning, utslag,
};
