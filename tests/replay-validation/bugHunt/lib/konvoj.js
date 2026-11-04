'use strict';

/**
 * Konvojsemantiken för T2 (BUGGJAKT §6 och §7): EN definition av "täckt av
 * händelsen", "händelsens första passage", "öppen enligt medlemskravet" och
 * "returresa" som både
 * registrets predikat (U2-RETURRESA, U2-VS-DEADLINE, J13-J14-KONVOJSEMANTIK)
 * och T2-oraklets förklaringar använder.
 *
 * Rättat 2026-11-04 (motorgranskningens M04, triagens T-2). Förut gick
 * definitionerna isär:
 *   - U2-VS-DEADLINE krävde inte att båten var täckt av händelsen och kunde
 *     räkna båtens egen utresa som händelsens första passage;
 *   - registrets U2-RETURRESA krävde en absorbed-rad, oraklets inte;
 *   - registrets J13 såg bara den sista varningen och w.mmsis, oraklet alla
 *     täckningsrader för händelsen.
 * Därför bar 13 instanser i standardens två T2-kandidatkluster en
 * orakelförklaring som registret avvisade.
 *
 * Indata är desamma i registret och oraklet:
 *   varningar   levererade öppningsvarningar (success ≠ false), tidsordnade
 *   korsningar  punktkorsningar (L1, inferred utesluts), tidsordnade
 *   coverage    openingCoverage med eventId i namnrymd (instances.js)
 * Tider är epok-ms. Funktionerna filtrerar själva på bron.
 */

const C = require('../../../../lib/constants');

const { CONVOY_WINDOW_MS } = C.BRIDGE_OPENING; // 600 s

const same = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);

/**
 * Är båten täckt av händelsen w vid tiden t? Täckt betyder medlem i
 * varningens mmsis, varningens ledare eller absorberad i händelsen
 * (openingCoverage {reason: 'absorbed', eventId: w.eventId}) senast vid t.
 * @param {object} w - levererad varning
 * @param {string} mmsi - båten
 * @param {object[]} coverage - openingCoverage
 * @param {number} t - tiden (epok-ms); absorption efter t räknas inte
 * @returns {{sant: boolean, hur: string|null, t?: number}} utfall
 */
function täcktAv(w, mmsi, coverage, t) {
  if (!w) return { sant: false, hur: null };
  if ((w.mmsis || []).some((m) => same(m, mmsi))) return { sant: true, hur: 'medlem' };
  if (same(w.leadMmsi, mmsi)) return { sant: true, hur: 'ledare' };
  if (!w.eventId) return { sant: false, hur: null };
  const rad = (coverage || []).find((c) => c && c.reason === 'absorbed' && c.eventId === w.eventId && same(c.mmsi, mmsi)
    && Number.isFinite(c.t) && (!Number.isFinite(t) || c.t <= t));
  return rad ? { sant: true, hur: 'absorberad', t: rad.t } : { sant: false, hur: null };
}

/**
 * Händelsens första passage: första punktkorsningen av varningens bro vid
 * eller efter varningen av en båt som då var täckt av händelsen.
 * @returns {object|null} korsningen
 */
function förstaPassage(w, korsningar, coverage) {
  return (korsningar || []).find((x) => x.bridge === w.bridge && x.t >= w.t && täcktAv(w, x.mmsi, coverage, x.t).sant) || null;
}

const vid = (varningar, bro, villkor) => (varningar || []).filter((w) => w.bridge === bro && villkor(w));

/**
 * U2 mot deadline-garantin (U2-VS-DEADLINE): korsningen tc ligger inom
 * [händelsens första passage; + fönsterMs] för en äldre händelse som täckte
 * båten vid tc, och den första passagen är en ANNAN båts. Båtens egen
 * korsning (utresan före en U-sväng, eller korsningen själv) är aldrig
 * händelsens första passage. Händelserna prövas från den senaste bakåt.
 * @param {{mmsi: string, bro: string, tc: number}} k - korsningen som döms
 * @param {{varningar: object[], korsningar: object[], coverage: object[], fönsterMs?: number}} d - underlaget
 * @returns {{sant: boolean, w?: object, first?: object, närmast?: object|null, otäckta?: number}} utfall
 */
function inomHändelsefönster({ mmsi, bro, tc }, {
  varningar, korsningar, coverage, fönsterMs = CONVOY_WINDOW_MS,
}) {
  let närmast = null;
  let otäckta = 0;
  for (const w of vid(varningar, bro, (x) => x.t <= tc).reverse()) {
    if (!täcktAv(w, mmsi, coverage, tc).sant) {
      otäckta++;
      continue;
    }
    const first = förstaPassage(w, korsningar, coverage);
    if (!first || same(first.mmsi, mmsi)) continue;
    if (tc >= first.t && tc <= first.t + fönsterMs) return { sant: true, w, first };
    if (!närmast) närmast = { w, first };
  }
  return {
    sant: false, närmast, otäckta,
  };
}

/**
 * J13/J14 (J13-J14-KONVOJSEMANTIK): i en äldre händelse som täckte båten
 * vid tc korsade en båt som INTE var täckt av händelsen bron mellan
 * varningen och båtens passage, och händelsen var fortfarande öppen vid tc
 * enligt medlemskravet (J14: en händelse stängs av sina medlemmars
 * passager). Öppen betyder att ingen täckt båt, inte heller båten själv vid
 * en tidigare korsning, passerade bron mer än fönsterMs före tc. Hade en
 * medlem redan passerat längre tillbaka hade appens täckning löpt ut, och då
 * förklarar valet mellan medlemskrav och första faktiska passage inte den
 * uteblivna varningen (konvojfönstrets bakkant, en kandidat).
 * Händelserna prövas från den senaste bakåt.
 * @returns {{sant: boolean, w?: object, x?: object}} utfall
 */
function ickeMedlemEmellan({ mmsi, bro, tc }, {
  varningar, korsningar, coverage, fönsterMs = CONVOY_WINDOW_MS,
}) {
  const korsningenSjälv = (k) => same(k.mmsi, mmsi) && Math.abs(k.t - tc) < 1000;
  for (const w of vid(varningar, bro, (x) => x.t < tc).reverse()) {
    if (!täcktAv(w, mmsi, coverage, tc).sant) continue;
    const förstaTäckta = (korsningar || []).find((k) => k.bridge === bro && k.t >= w.t && k.t < tc && !korsningenSjälv(k)
      && täcktAv(w, k.mmsi, coverage, k.t).sant);
    if (förstaTäckta && tc > förstaTäckta.t + fönsterMs) continue;
    const x = (korsningar || []).find((k) => k.bridge === bro && k.t > w.t && k.t < tc && !same(k.mmsi, mmsi)
      && !täcktAv(w, k.mmsi, coverage, k.t).sant);
    if (x) return { sant: true, w, x };
  }
  return { sant: false };
}

/**
 * Returresa (U2-RETURRESA): båten korsade bron tidigare (utresan q) i en
 * egen äldre händelse w — varningen kom före utresan och båten var täckt av
 * w vid utresan (medlem, ledare eller absorberad senast då) — och korsningen
 * tc ligger inom händelsens konvojfönster [första passage; + fönsterMs].
 * Medlemskap gäller utan tidsgräns, så en båt som var täckt vid utresan är
 * det också vid returen. Utanför fönstret är doktrinerna överens om att
 * returen är en ny öppning, och då är en utebliven varning ingen konflikt.
 * @returns {{sant: boolean, w?: object, q?: object, first?: object, hur?: string, närmast?: object|null, skäl?: string}} utfall
 */
function returresa({ mmsi, bro, tc }, {
  varningar, korsningar, coverage, fönsterMs = CONVOY_WINDOW_MS,
}) {
  const egna = (korsningar || []).filter((q) => q.bridge === bro && same(q.mmsi, mmsi) && q.t < tc - 1000);
  if (!egna.length) {
    return { sant: false, närmast: null, skäl: 'ingen tidigare egen korsning av bron' };
  }
  let närmast = null;
  for (const w of vid(varningar, bro, (x) => x.t < tc).reverse()) {
    const q = egna.find((k) => k.t > w.t);
    if (!q) continue;
    const täckt = täcktAv(w, mmsi, coverage, q.t);
    if (!täckt.sant) continue;
    const first = förstaPassage(w, korsningar, coverage) || q;
    if (tc <= first.t + fönsterMs) {
      return {
        sant: true, w, q, first, hur: täckt.hur,
      };
    }
    if (!närmast) närmast = { w, q, first };
  }
  return {
    sant: false, närmast, skäl: närmast ? 'returen ligger utanför händelsens konvojfönster' : 'ingen egen äldre händelse före utresan',
  };
}

module.exports = {
  CONVOY_WINDOW_MS, täcktAv, förstaPassage, inomHändelsefönster, ickeMedlemEmellan, returresa,
};
