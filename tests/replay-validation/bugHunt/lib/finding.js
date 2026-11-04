'use strict';

/**
 * Fyndobjektet — kontraktet mellan spår, register, klustring och rapport.
 *
 * Varje orakel (befintliga domare, hälsa, relationer och sanningsorakel)
 * lämnar fynd i EXAKT det här formatet. Fälten:
 *
 *   orakel     'INV-F' | 'INV-W' | 'LEV' | 'H1' | 'H2' | 'H3' | 'M-FAS' | 'T1' …
 *   klass      klassen, t.ex. 'INV-14 DEFAULT-FLASH' eller 'ÖPPNINGSNYCKEL TILLAGD'
 *   inv        INV-id för invariantutslag (annars null)
 *   allvar     heltal 0–10; 0 = räknare (blir aldrig kort)
 *   räknare    true = informativ räknare (INV-W, T4, SEN-NOTIS …)
 *   mmsi       sträng eller null
 *   bro        bro/punkt eller null
 *   riktning   'northbound' | 'southbound' | 'unknown' | null
 *   t          epok-ms (i basens tidsram för bankvarianter) eller null
 *   detalj     en rad svensk text (råmeddelandet för befintliga domare)
 *   belägg     fritt JSON-objekt med oraklets underlag
 *   spår       'bank' | 'synt' | 'självtest'
 *   nivå       'bank' | 'R0' | 'R1' | 'stress'
 *   ursprung   {korpus?, värld?, relation?, deltaS?, monitoring?, radio?, era?, familj?}
 *   taggar     t.ex. ['KNIVSEGG'] eller ['LÅST-BANK']
 *   repro      {filer: [{från, till}], kommandon: [...], recept?, tidslinje?: [...]}
 *   register   fylls i fas 3: {klass, post, närmast}
 *
 * Mekanismnyckeln (klusteridentiteten) är `orakel | normalize(klass)`; allt
 * annat är metadata.
 */

const signature = require('./signature');

const FIELD_ORDER = ['orakel', 'klass', 'inv', 'allvar', 'räknare', 'mmsi', 'bro', 'riktning', 't', 'detalj', 'belägg',
  'spår', 'nivå', 'ursprung', 'taggar', 'repro', 'register'];

/**
 * Skapar ett fynd med standardvärden och kontrollerade typer.
 * @param {object} f - fältvärden
 * @returns {object} fynd
 */
function makeFinding(f) {
  if (!f || !f.orakel || !f.klass) throw new Error('ett fynd kräver orakel och klass');
  const out = {
    orakel: String(f.orakel),
    klass: String(f.klass),
    inv: f.inv || null,
    allvar: Number.isFinite(f.allvar) ? f.allvar : 0,
    räknare: !!f.räknare,
    mmsi: f.mmsi === undefined || f.mmsi === null ? null : String(f.mmsi),
    bro: f.bro || null,
    riktning: f.riktning || null,
    t: Number.isFinite(f.t) ? f.t : null,
    detalj: f.detalj ? String(f.detalj) : '',
    belägg: f.belägg || {},
    spår: f.spår || null,
    nivå: f.nivå || null,
    ursprung: f.ursprung || {},
    taggar: [...new Set(f.taggar || [])].sort(),
    repro: f.repro || null,
    register: f.register || null,
  };
  if (out.räknare) out.allvar = 0;
  return out;
}

/** Mekanismnyckeln för ett fynd. */
function mechanismOf(f) {
  return signature.mechanismKey(f);
}

/** Lägger till spårets metadata på en lista fynd (ny lista). */
function withOrigin(findings, {
  spår, nivå, ursprung = {}, taggar = [],
}) {
  return findings.map((f) => makeFinding({
    ...f,
    spår: f.spår || spår,
    nivå: f.nivå || nivå,
    ursprung: { ...ursprung, ...(f.ursprung || {}) },
    taggar: [...(f.taggar || []), ...taggar],
  }));
}

/**
 * Deterministisk sorteringsnyckel för fynd (ordning oberoende av insamling).
 * @param {object} f - fynd
 * @returns {string} nyckel
 */
function sortKeyOf(f) {
  const u = f.ursprung || {};
  return [
    mechanismOf(f),
    u.korpus || '', u.värld === undefined ? '' : String(u.värld).padStart(8, '0'),
    String(Number.isFinite(f.t) ? f.t : 0).padStart(15, '0'),
    f.bro || '', f.riktning || '', f.mmsi || '', f.detalj,
  ].join('\u0001');
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const ka = sortKeyOf(a);
    const kb = sortKeyOf(b);
    if (ka < kb) return -1;
    return ka > kb ? 1 : 0;
  });
}

module.exports = {
  FIELD_ORDER, makeFinding, mechanismOf, withOrigin, sortKeyOf, sortFindings,
};
