'use strict';

/**
 * Signaturer och normalisering (BUGGJAKT §8).
 *
 * Tre nivåer, från grövst till finast:
 *   normalize()      — ISO-tid → T, 9-siffrigt mmsi → M, övriga tal → N.
 *                      INV-id (INV-14, INV-14W …) behålls. Används för
 *                      mekanismnyckeln och stderr-signaturerna (H3).
 *   instanceKey()    — ISO-tid → T och mmsi → M, men TALEN BEHÅLLS. Används i
 *                      differentiella bankjämförelser: att ett känt utslag
 *                      byter längd (42h-flashen 30 s → 56 s) ÄR en ändring av
 *                      utfallet och ska synas, även om mekanismen är densamma.
 *   mechanismKey()   — orakel | normaliserad klass. Klusteridentiteten; bro,
 *                      riktning, era, profil, familj och taggar är metadata.
 *
 * Normaliseringen är idempotent: normalize(normalize(x)) === normalize(x).
 */

const ISO_RE = /\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?/g;
const MMSI_RE = /(?<!\d)\d{9}(?!\d)/g;
const INV_ID_RE = /INV-\d+[A-Z]?/g;
const NUM_RE = /\d+(?:[.,]\d+)?/g;

const BRIDGE_NAMES = ['Klaffbron', 'Stridsbergsbron', 'Olidebron', 'Järnvägsbron', 'Stallbackabron', 'Kanalinfarten'];
const BRIDGE_RE = new RegExp(`(${BRIDGE_NAMES.join('|')})`);
const DIRECTION_RE = /\b(northbound|southbound|unknown)\b/;

/** H3: stderr-rader som räknas som appfel. */
const H3_MARKERS = ['[APP ERROR]', '[FATAL]', 'Unhandled'];
const STDERR_SIGNATURE_MAX = 140;

// Platshållaren får inte innehålla siffror (då skulle talregeln äta den):
// tecken ur Unicodes privata område, ett per skyddat id.
const PLACEHOLDER_BASE = 0xE100;
function protectInvIds(text, fn) {
  const ids = [];
  const masked = text.replace(INV_ID_RE, (m) => {
    ids.push(m);
    return `${String.fromCharCode(PLACEHOLDER_BASE + ids.length - 1)}`;
  });
  return fn(masked).replace(/([-])/g, (m, c) => ids[c.charCodeAt(0) - PLACEHOLDER_BASE]);
}

/**
 * ISO → T, mmsi → M, övriga tal → N; INV-id behålls.
 * @param {string} text - meddelande
 * @returns {string} normaliserad text
 */
function normalize(text) {
  if (text === null || text === undefined) return '';
  return protectInvIds(String(text), (s) => s
    .replace(ISO_RE, 'T')
    .replace(MMSI_RE, 'M')
    .replace(NUM_RE, 'N'));
}

/**
 * ISO → T och mmsi → M, tal behålls (finare än normalize).
 * @param {string} text - meddelande
 * @returns {string} instansnyckel
 */
function instanceKey(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(ISO_RE, 'T').replace(MMSI_RE, 'M');
}

/** Texten före första kolon (klassen), trimmad. */
function classOf(message) {
  const s = String(message || '');
  const i = s.indexOf(':');
  return (i < 0 ? s : s.slice(0, i)).trim();
}

/**
 * Invariantklass → INV-id för de fatala utslag som saknar explicit id i
 * texten (invariants.js validateInvariants). WARN-skiktet bär alltid sitt id.
 */
const INV_ID_BY_CLASS = Object.freeze([
  [/^TRASIG TEXT$|^OKÄND KLAUSUL$/, 'INV-1'],
  [/^NOTIS ogiltig |^NOTIS okänd bro$|^NOTIS misslyckad$|^NOTIS-DUBBLETT$/, 'INV-2'],
  [/^ETA-SÅGTAND UPP$|^ETA-OSCILLATION$/, 'INV-3'],
  [/^COUNT-DEGRADERING$/, 'INV-4'],
  [/^MISSAD MÅLBRO-NOTIS$/, 'INV-5'],
  [/^SPÖKTEXT VID SLUT$/, 'INV-6'],
  [/^SEN MÅLBRO-NOTIS$/, 'INV-7'],
  [/^DUBBEL MÅLBRO-KLAUSUL$|^FEL KLAUSULORDNING$|^ORIMLIGT ANTAL$/, 'INV-9'],
  [/^STRAX-ZOMBIE$/, 'INV-10'],
  [/^BESÖKSMINNE$|^LÄCKAGE$/, 'INV-12'],
  [/^MÅLBRO SOM MELLANBRO$/, 'INV-13'],
  [/^DEFAULT-FLASH$/, 'INV-14'],
]);

/**
 * INV-id för ett invariantmeddelande (explicit prefix eller via klassen).
 * @param {string} message - utslaget
 * @returns {string|null} t.ex. 'INV-14'
 */
function invIdOf(message) {
  const cls = classOf(message);
  const explicit = /^(INV-\d+[A-Z]?)\b/.exec(cls);
  if (explicit) return explicit[1];
  for (const [re, id] of INV_ID_BY_CLASS) if (re.test(cls)) return id;
  return null;
}

/**
 * Visningsklass för ett invariantutslag: INV-id + klass, utan dubblering
 * ('INV-8 NAMN' förblir 'INV-8 NAMN', 'DEFAULT-FLASH' blir 'INV-14 DEFAULT-FLASH').
 * @param {string} message - utslaget
 * @returns {string} klass
 */
function invariantClass(message) {
  const cls = classOf(message);
  const id = invIdOf(message);
  if (!id || cls.startsWith(id)) return cls;
  return `${id} ${cls}`;
}

/** Mekanismnyckeln: orakel | normaliserad klass. */
function mechanismKey(finding) {
  return `${finding.orakel}|${normalize(finding.klass)}`;
}

/** Första bro/punkt som nämns i texten. */
function bridgeOf(text) {
  const m = BRIDGE_RE.exec(String(text || ''));
  return m ? m[1] : null;
}

/** Alla broar/punkter som nämns i texten (i ordning, unika). */
function bridgesOf(text) {
  const out = [];
  for (const m of String(text || '').matchAll(new RegExp(BRIDGE_RE.source, 'g'))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Första interna riktningsord i texten. */
function directionOf(text) {
  const m = DIRECTION_RE.exec(String(text || ''));
  return m ? m[1] : null;
}

/** Första 9-siffriga mmsi i texten (ISO-tider räknas inte). */
function mmsiOf(text) {
  const s = String(text || '').replace(ISO_RE, 'T');
  const m = /(?<!\d)(\d{9})(?!\d)/.exec(s);
  return m ? m[1] : null;
}

/** Alla mmsi i texten. */
function mmsisOf(text) {
  const s = String(text || '').replace(ISO_RE, 'T');
  return [...new Set(s.match(MMSI_RE) || [])];
}

/** Första ISO-tid i texten som epok-ms (null om ingen). */
function timeOf(text) {
  const m = String(text || '').match(ISO_RE);
  if (!m) return null;
  const t = Date.parse(m[0]);
  return Number.isFinite(t) ? t : null;
}

/** Räknas stderr-raden som appfel (H3)? */
function isH3Line(line) {
  return H3_MARKERS.some((mark) => String(line).includes(mark));
}

/** stderr-signatur: normaliserad och kapad efter 140 tecken. */
function stderrSignature(line) {
  return normalize(String(line).trim()).slice(0, STDERR_SIGNATURE_MAX);
}

module.exports = {
  BRIDGE_NAMES,
  H3_MARKERS,
  STDERR_SIGNATURE_MAX,
  INV_ID_BY_CLASS,
  normalize,
  instanceKey,
  classOf,
  invIdOf,
  invariantClass,
  mechanismKey,
  bridgeOf,
  bridgesOf,
  directionOf,
  mmsiOf,
  mmsisOf,
  timeOf,
  isH3Line,
  stderrSignature,
};
