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

// U2:s fönster, 600 s (dig9; appens BRIDGE_OPENING.CONVOY_WINDOW_MS).
// Verktygets eget tal (granskningen 2026-11-16, M2): ett ändrat värde i appen
// ska inte flytta konvojsemantiken med sig. Vakttestet
// __tests__/t-v1-granskning.test.js fäller om appens konstant avviker.
const U2_FÖNSTER_MS = 600 * 1000;
const CONVOY_WINDOW_MS = U2_FÖNSTER_MS;

const same = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);

/**
 * Är båten täckt av händelsen w vid tiden t? Täckt betyder medlem i
 * varningens mmsis, varningens ledare eller absorberad i händelsen
 * (openingCoverage {reason: 'absorbed', eventId: w.eventId}) senast vid t.
 * @param {object} w - levererad varning
 * @param {string} mmsi - båten
 * @param {object[]} coverage - openingCoverage
 * @param {number} t - tiden (epok-ms); absorption efter t räknas inte
 * @param {object[]|null} [korsningar] - punktkorsningarna; med dem gäller
 *   U2-fönstrets undantag från den senaste bindningen (se nedan), utan dem
 *   avslutar varje senare bindning täckningen
 * @returns {{sant: boolean, hur: string|null, t?: number}} utfall
 */
function täcktAv(w, mmsi, coverage, t, korsningar = null) {
  if (!w) return { sant: false, hur: null };
  let bindning = null;
  if ((w.mmsis || []).some((m) => same(m, mmsi))) bindning = { hur: 'medlem', t: w.t };
  else if (same(w.leadMmsi, mmsi)) bindning = { hur: 'ledare', t: w.t };
  else if (w.eventId) {
    // Absorptionerna i händelsen senast vid t: t i svaret är den första (som
    // förut), bindningen som en senare händelse kan avsluta är den senaste.
    const rader = (coverage || []).filter((c) => c && c.reason === 'absorbed' && c.eventId === w.eventId && same(c.mmsi, mmsi)
      && Number.isFinite(c.t) && (!Number.isFinite(t) || c.t <= t)).sort((a, b) => a.t - b.t);
    if (rader.length) bindning = { hur: 'absorberad', t: rader[rader.length - 1].t, först: rader[0].t };
  }
  if (!bindning) return { sant: false, hur: null };
  // Den senaste bindningen gäller (2026-11-16, nattkortet F23 r1): släpptes
  // båten ur händelsen och bands sedan till en ANNAN händelse vid samma bro
  // (en fired- eller absorbed-rad efter bindningen, senast vid t), täcker
  // händelsen henne inte längre. Förut räknades varje absorption som
  // täckning för gott, och BRISEN, som släppts ur Klaffbron#1 och fått egen
  // varning #2, blev #1:s första passage (värld 15273). En rad vid exakt
  // samma tid som bindningen räknas inte: appen släpper ur den förra
  // händelsen och binder till nästa i samma utvärdering.
  const bro = w.bridge;
  if (bro && w.eventId) {
    const senare = (coverage || []).find((c) => c && (c.reason === 'fired' || c.reason === 'absorbed') && c.eventId
      && c.eventId !== w.eventId && same(c.mmsi, mmsi) && c.bridge === bro && Number.isFinite(c.t)
      && c.t > bindning.t && (!Number.isFinite(t) || c.t <= t));
    if (senare) {
      const avslutad = { eventId: senare.eventId, t: senare.t, reason: senare.reason };
      // Undantaget (dirigentens beslut om U2, 2026-11-16, nattvärld 295:
      // HAVSORN absorberad i #1, släppt och varnad om igen i #3 28 s före
      // korsningen, 3 min efter #1:s första passage): den senare bindningen
      // avslutar täckningen genom w BARA när båtens korsning vid t ligger
      // utanför w:s fönster, [w:s tidigaste korsning; + U2_FÖNSTER_MS]. Inom
      // fönstret korsade hon i samma öppning, som w redan varnat för.
      // Förutsättningar: t är hennes egen korsning av bron, hon var medlem
      // i eller absorberad av w före den (bindningen ovan, senast vid t),
      // och w:s varning levererades före den. w:s tidigaste korsning är den
      // första korsningen vid eller efter varningen av en båt som w täcker
      // UTAN undantaget, så en släppt båt kan aldrig bli w:s första passage
      // (nattkortet F23 r1: BRISEN, släppt ur Klaffbron#1 och varnad i #2,
      // korsade 207 s före #1:s första passage och står utanför fönstret).
      // En båt som aldrig var bunden till w täcks inte (gren (ii) är
      // borttagen och kommer inte tillbaka den här vägen).
      if (!Array.isArray(korsningar) || !Number.isFinite(t) || !(w.t < t)) return { sant: false, hur: null, avslutad };
      const egen = korsningar.some((k) => k.bridge === bro && same(k.mmsi, mmsi) && Math.abs(k.t - t) < 1000);
      if (!egen) return { sant: false, hur: null, avslutad };
      const först = korsningar.filter((k) => k.bridge === bro && Number.isFinite(k.t) && k.t >= w.t)
        .sort((a, b) => a.t - b.t).find((k) => täcktAv(w, k.mmsi, coverage, k.t).sant);
      if (!först || t < först.t || t > först.t + U2_FÖNSTER_MS) return { sant: false, hur: null, avslutad };
      const svar = bindning.hur === 'absorberad' ? { sant: true, hur: 'absorberad', t: bindning.först } : { sant: true, hur: bindning.hur };
      return { ...svar, inomFönster: { avslutad, först: { mmsi: String(först.mmsi), t: först.t } } };
    }
  }
  return bindning.hur === 'absorberad' ? { sant: true, hur: 'absorberad', t: bindning.först } : { sant: true, hur: bindning.hur };
}

/**
 * Händelsens första passage: första punktkorsningen av varningens bro vid
 * eller efter varningen av en båt som då var täckt av händelsen.
 * @returns {object|null} korsningen
 */
function förstaPassage(w, korsningar, coverage) {
  return (korsningar || []).find((x) => x.bridge === w.bridge && x.t >= w.t && täcktAv(w, x.mmsi, coverage, x.t, korsningar).sant) || null;
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
function egenKorsningEfter(w, { mmsi, bro, tc }, korsningar, coverage = null) {
  return !!beskriverPasseradÖppning(w, { mmsi, bro, tc }, korsningar, coverage);
}

/**
 * U15 villkor (a)–(c) (docs/ARCHITECTURE.md, "Returresan är en egen öppning",
 * BridgeOpeningService#_describesPassedOpening): beskriver händelsen w den
 * öppning som båten redan passerat före korsningen tc? Hennes passerade
 * öppning är hennes senaste egna korsning k av bron före tc. w beskriver den
 * när (a) hon var täckt av w när hon korsade (k efter varningen), (b) w:s
 * referensankomst ligger inom CONVOY_WINDOW_MS från k: referensen är den
 * första korsningen vid eller efter varningen av en ANNAN båt som w täckte
 * då, före tc, och annars prognosen när varningen gick ut (w.t + etaMin),
 * eller (c) referensen saknas och varningen gick vid eller före k.
 * En händelse för en SENARE öppning, mer än ett konvojfönster från hennes
 * passage, täcker returen som vanligt (U2), oavsett om den gick före eller
 * efter passagen.
 *
 * Rättat 2026-11-16 (nattkorten F02 r2 och F23 r3): förut avvisades VARJE
 * händelse vars varning kom före båtens egen tidigare korsning, också den
 * som enligt U15 täcker returen (CORDELIA:s Klaffbron#4 med referensen
 * 645 s efter YRSA:s passage, värld 15932).
 * Utan coverage prövas bara den gamla regeln (egen korsning efter varningen),
 * så att äldre anrop dömer som förut.
 * @returns {{villkor: string, k: object}|null} villkoret som gällde, eller null
 */
function beskriverPasseradÖppning(w, { mmsi, bro, tc }, korsningar, coverage = null) {
  const egna = (korsningar || []).filter((k) => k.bridge === bro && same(k.mmsi, mmsi) && k.t < tc - 1000);
  if (!coverage) {
    const k0 = egna.find((k) => k.t >= w.t);
    return k0 ? { villkor: 'egen korsning efter varningen', k: k0 } : null;
  }
  const k = egna[egna.length - 1];
  if (!k) return null;
  if (k.t >= w.t && täcktAv(w, mmsi, coverage, k.t, korsningar).sant) return { villkor: '(a)', k };
  // En händelse som avfyrades EFTER hennes passage med henne som medlem
  // eller ledare är returens egen varning (returarmen), ingen händelse som
  // täcker returen (baslinjevärld 212: Klaffbron#19 för 265817494).
  if (w.t > k.t && ((w.mmsis || []).some((m) => same(m, mmsi)) || same(w.leadMmsi, mmsi))) return null;
  const ref = (korsningar || []).find((x) => x.bridge === bro && !same(x.mmsi, mmsi) && x.t >= w.t && x.t < tc
    && täcktAv(w, x.mmsi, coverage, x.t, korsningar).sant);
  let refT = ref ? ref.t : null;
  if (refT === null && Number.isFinite(w.etaMin) && w.etaMin >= 0) refT = w.t + w.etaMin * 60000;
  if (refT !== null) return Math.abs(refT - k.t) <= CONVOY_WINDOW_MS ? { villkor: '(b)', k, refT } : null;
  return w.t <= k.t ? { villkor: '(c)', k } : null;
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
    if (!täcktAv(w, mmsi, coverage, tc, korsningar).sant) {
      otäckta++;
      continue;
    }
    if (egenKorsningEfter(w, { mmsi, bro, tc }, korsningar, coverage || [])) continue;
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
    if (!täcktAv(w, mmsi, coverage, tc, korsningar).sant) continue;
    if (egenKorsningEfter(w, { mmsi, bro, tc }, korsningar, coverage || [])) continue;
    const förstaTäckta = (korsningar || []).find((k) => k.bridge === bro && k.t >= w.t && k.t < tc && !korsningenSjälv(k)
      && täcktAv(w, k.mmsi, coverage, k.t, korsningar).sant);
    if (förstaTäckta && tc > förstaTäckta.t + fönsterMs) continue;
    const x = (korsningar || []).find((k) => k.bridge === bro && k.t > w.t && k.t < tc && !same(k.mmsi, mmsi)
      && !täcktAv(w, k.mmsi, coverage, k.t, korsningar).sant);
    if (x) return { sant: true, w, x };
  }
  return { sant: false };
}

module.exports = {
  U2_FÖNSTER_MS,
  CONVOY_WINDOW_MS,
  täcktAv,
  förstaPassage,
  egenKorsningEfter,
  beskriverPasseradÖppning,
  inomHändelsefönster,
  ickeMedlemEmellan,
};
