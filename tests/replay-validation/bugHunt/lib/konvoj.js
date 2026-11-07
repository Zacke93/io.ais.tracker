'use strict';

/**
 * Konvojsemantiken för T2 (BUGGJAKT §6 och §7): EN definition av "täckt av
 * händelsen", "händelsens första passage" och "öppen enligt medlemskravet"
 * som både registrets predikat (U2-VS-DEADLINE, J13-J14-KONVOJSEMANTIK och
 * U17:s tystRecoverSammaÖppning) och T2-oraklets förklaringar använder.
 * Returresan (U2-RETURRESA) togs bort 2026-11-07: U15 besvarade postens
 * fråga, och en retur utan egen varning är en kandidat.
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
 * Korsade båten själv bron efter varningen w och före korsningen tc? Då är
 * tc en returresa, och enligt U15 (användarbeslut 2026-11-04, INV-21 är
 * kontraktet) är returen en egen öppning: händelsen w förklarar den inte.
 * Infört 2026-11-07 när U2-RETURRESA togs bort. Förut prövades returen mot
 * U2-RETURRESA först, och U2-VS-DEADLINE och J13 fick aldrig se den; utan
 * vakten hade J13 räknat båtens egen utresa som händelsens öppna passage
 * (standardvärld 1316).
 * @returns {boolean} båten har en egen tidigare korsning i (w.t; tc − 1 s)
 */
function egenKorsningEfter(w, { mmsi, bro, tc }, korsningar) {
  return (korsningar || []).some((k) => k.bridge === bro && same(k.mmsi, mmsi) && k.t >= w.t && k.t < tc - 1000);
}

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
    if (egenKorsningEfter(w, { mmsi, bro, tc }, korsningar)) continue;
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
    if (egenKorsningEfter(w, { mmsi, bro, tc }, korsningar)) continue;
    const förstaTäckta = (korsningar || []).find((k) => k.bridge === bro && k.t >= w.t && k.t < tc && !korsningenSjälv(k)
      && täcktAv(w, k.mmsi, coverage, k.t).sant);
    if (förstaTäckta && tc > förstaTäckta.t + fönsterMs) continue;
    const x = (korsningar || []).find((k) => k.bridge === bro && k.t > w.t && k.t < tc && !same(k.mmsi, mmsi)
      && !täcktAv(w, k.mmsi, coverage, k.t).sant);
    if (x) return { sant: true, w, x };
  }
  return { sant: false };
}

module.exports = {
  CONVOY_WINDOW_MS, täcktAv, förstaPassage, egenKorsningEfter, inomHändelsefönster, ickeMedlemEmellan,
};
