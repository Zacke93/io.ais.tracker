'use strict';

/**
 * De befintliga domarna som orakel (BUGGJAKT §6: INV-F, INV-W, LEV).
 *
 * Oraklen kopierar inga regler — de kör harnessens egna domare:
 *   INV-F  validateInvariants(resultat)            (fatala, INV-1–14 och 16)
 *   INV-W  validateWarnInvariants(resultat, gt)    (WARN, alltid räknare i v1)
 *   LEV    openingDeliveryFailures(resultat)       (öppningsleveransen)
 *
 * gt skickas ALLTID explicit. validateWarnInvariants faller annars tyst
 * tillbaka på result.jsonl → gt-passages/index.json, och för en korpus som
 * körs från corpora-data hittar den då korpusens facit även när anroparen
 * menade "inget facit". null blir därför [] här, och undefined är ett
 * programmeringsfel som kastar.
 *
 * eventId namnrymdas per app-instans (instances.js) innan LEV joinar på det.
 * Domarna anropas via modulobjekten så att jest kan spionera på anropen.
 */

const invariants = require('../../../invariants');
const delivery = require('../../../openingDelivery');
const { namespaceEventIds } = require('../instances');
const signature = require('../signature');
const { makeFinding } = require('../finding');

/** Allvar per INV-id (orakelkatalogen, INV-F). */
const INV_SEVERITY = Object.freeze({
  'INV-2': 6, 'INV-11': 6, 'INV-13': 6, 'INV-5': 5, 'INV-7': 5, 'INV-3': 4, 'INV-4': 4, 'INV-10': 4, 'INV-14': 4,
});
const LEV_SEVERITY = 6;

function severityOfInv(invId) {
  return INV_SEVERITY[invId] || 3;
}

/** Högst så många väntintervall per INV-10-utslag i beläggen. */
const VÄNTAN_MAX = 40;

/** INV-10:s svans: `… stod N min utan <bro>-passage` (invariants.js:498). */
const STRAX_ZOMBIE_BRO_RE = /\bstod \d+ min utan (\S+?)-passage\s*$/;

/**
 * Bron som ett INV-10-utslag (STRAX-ZOMBIE) gäller: den i "utan <bro>-passage",
 * inte den första bron i den citerade bryggtexten. INV-9 kräver att Klaffbron
 * står först, så i en text med strax vid båda målbroarna är första bron
 * alltid Klaffbron, medan INV-10 fäller en gång per bro. Utan svansen (ett
 * annat meddelande) gäller första bron i texten.
 * @param {string} message - utslaget
 * @returns {string|null} bron
 */
function straxBridgeOf(message) {
  const m = STRAX_ZOMBIE_BRO_RE.exec(String(message || ''));
  if (m && signature.BRIDGE_NAMES.includes(m[1])) return m[1];
  return signature.bridgeOf(message);
}

/**
 * Underlaget som INV-10 (STRAX-ZOMBIE) dömde på, ur samma resultat:
 * strax-övergången (från), nästa övergång (till; körningens sista övergång
 * om ingen följer, som i invariants.js) och de bekräftade väntintervallen för
 * bron som överlappar [från; till]. Registrets MÄTGRÄNS-INV10-VÄNTKEDJA läser
 * dem (triagens T-1). Tiderna är epok-ms i resultatets tidsram.
 *
 * Bron är utslagets egen (straxBridgeOf), så att väntan vid den andra
 * målbron i texten aldrig förklarar en zombie vid den här. Rättat 2026-11-04
 * (efterrättning D): förut togs första bron i texten, och en text med strax
 * vid båda målbroarna prövades alltid mot Klaffbrons väntan.
 * @param {string} message - INV-10-utslaget
 * @param {object} result - resultatet som utslaget kom ur
 * @returns {object|null} {bro, från, till, intervall: [{från, till}]}
 */
function straxEvidence(message, result) {
  const bro = straxBridgeOf(message);
  const t = signature.timeOf(message);
  const trans = (result && result.bridgeTextTransitions) || [];
  if (!bro || !Number.isFinite(t) || !trans.length) return null;
  const i = trans.findIndex((x) => x && x.t === t);
  if (i < 0) return null;
  const till = i + 1 < trans.length ? trans[i + 1].t : trans[trans.length - 1].t;
  const intervall = ((result && result.confirmedTargetWaits) || [])
    .filter((w) => w && w.bridge === bro && Number.isFinite(w.from) && Number.isFinite(w.until) && w.until >= t && w.from <= till)
    .map((w) => ({ från: w.from, till: w.until }))
    .sort((a, b) => (a.från - b.från) || (a.till - b.till))
    .slice(0, VÄNTAN_MAX);
  return {
    bro, från: t, till, intervall,
  };
}

/**
 * Ett invariantmeddelande → fynd.
 * @param {string} message - utslaget
 * @param {'INV-F'|'INV-W'} orakel - skikt
 * @param {{resultat?: object}} [opts] - resultatet som utslaget kom ur; ger
 *   INV-10-utslag deras väntintervall i belägg.väntan
 * @returns {object} fynd
 */
function fromInvariant(message, orakel, { resultat = null } = {}) {
  const inv = signature.invIdOf(message);
  const belägg = { meddelande: message, instans: signature.instanceKey(message) };
  if (inv === 'INV-10' && resultat) {
    const väntan = straxEvidence(message, resultat);
    if (väntan) belägg.väntan = väntan;
  }
  return makeFinding({
    orakel,
    klass: signature.invariantClass(message),
    inv,
    allvar: orakel === 'INV-F' ? severityOfInv(inv) : 0,
    räknare: orakel === 'INV-W',
    mmsi: signature.mmsiOf(message),
    // INV-10 fäller en gång per bro i texten; fyndets bro är zombiens.
    bro: inv === 'INV-10' ? straxBridgeOf(message) : signature.bridgeOf(message),
    riktning: signature.directionOf(message),
    t: signature.timeOf(message),
    detalj: message,
    belägg,
  });
}

/** Ett leveransfel → fynd. */
function fromDelivery(message) {
  return makeFinding({
    orakel: 'LEV',
    klass: signature.classOf(message),
    allvar: LEV_SEVERITY,
    mmsi: signature.mmsiOf(message),
    bro: signature.bridgeOf(message),
    detalj: message,
    belägg: { meddelande: message, instans: signature.instanceKey(message) },
  });
}

/**
 * Kör de befintliga domarna på ett resultat.
 * @param {{result: object, rows?: object[], gt: object[]|null}} args - gt måste anges (null = inget facit)
 * @returns {{fynd: object[], fatala: string[], warn: string[], leverans: string[]}} utfall
 */
function judgeExisting({ result, rows = [], gt }) {
  if (gt === undefined) throw new Error('judgeExisting: gt måste skickas explicit (null betyder "inget facit")');
  const ns = namespaceEventIds(result, rows);
  const gtArg = Array.isArray(gt) ? gt : [];
  const fatala = invariants.validateInvariants(ns);
  const warn = invariants.validateWarnInvariants(ns, gtArg);
  const leverans = delivery.openingDeliveryFailures(ns);
  const fynd = [
    ...fatala.map((v) => fromInvariant(v, 'INV-F', { resultat: ns })),
    ...warn.map((v) => fromInvariant(v, 'INV-W')),
    ...leverans.map((v) => fromDelivery(v)),
  ];
  return {
    fynd, fatala, warn, leverans,
  };
}

module.exports = {
  INV_SEVERITY, LEV_SEVERITY, severityOfInv, straxBridgeOf, straxEvidence, fromInvariant, fromDelivery, judgeExisting,
};
