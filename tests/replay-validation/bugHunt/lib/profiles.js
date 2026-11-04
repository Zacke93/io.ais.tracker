'use strict';

/**
 * Körprofilerna (BUGGJAKT §10). Budgeten räknas i ANTAL världar, aldrig i tid,
 * så samma HEAD + profil + seed ger samma rapport.json (bortsett från
 * tidsblocket).
 *
 * Fälten:
 *   världar          — budget för sanningsspåret (30 % R0, 70 % R1)
 *   r0Andel          — andel idealradiovärldar
 *   fasDeltaS        — δ-mängden för M-FAS (sekunder, typbevarande skift)
 *   fasMonitoring    — M-FAS körs även med REPLAY_MONITORING=1 (egen bas)
 *   representanter   — {kluster, perKluster}: hur många kluster som får
 *                      representanter i fas 4 och hur många var
 *   ungefärligTid    — dokumentär uppskattning (för rapportens huvud)
 *
 * Nattens 13 δ-värden är valda symmetriskt runt halvminutsrutnätet:
 * ±2,5, ±5, ±7, −11,52 (fältprov 10:s fas), ±15, ±20 och ±25 s.
 */

const PROFILES = Object.freeze({
  quick: Object.freeze({
    namn: 'quick',
    världar: 300,
    r0Andel: 0.3,
    fasDeltaS: Object.freeze([7, -11.52]),
    fasMonitoring: Object.freeze([false]),
    representanter: Object.freeze({ kluster: 5, perKluster: 1 }),
    ungefärligTid: '3–5 min',
  }),
  standard: Object.freeze({
    namn: 'standard',
    världar: 2000,
    r0Andel: 0.3,
    fasDeltaS: Object.freeze([2.5, -2.5, 7, -7, -11.52, 15, -20]),
    fasMonitoring: Object.freeze([false]),
    representanter: Object.freeze({ kluster: 25, perKluster: 2 }),
    ungefärligTid: '~15 min',
  }),
  night: Object.freeze({
    namn: 'night',
    världar: 20000,
    r0Andel: 0.3,
    fasDeltaS: Object.freeze([2.5, -2.5, 5, -5, 7, -7, -11.52, 15, -15, 20, -20, 25, -25]),
    fasMonitoring: Object.freeze([false, true]),
    representanter: Object.freeze({ kluster: 40, perKluster: 3 }),
    ungefärligTid: '60–90 min',
  }),
});

/** Nivåvikter för kortpoängen (BUGGJAKT §9). */
const NIVÅVIKT = Object.freeze({
  R0: 1.0, bank: 1.0, R1: 0.6, stress: 0.3,
});

/** Multiplikator för kort som bara finns i en klockfas. */
const KNIVSEGG_FAKTOR = 0.8;

/** Högst så många kort i rapport.md; resten står i rapport.json. */
const MAX_KORT = 25;

function getProfile(name) {
  const p = PROFILES[name];
  if (!p) throw new Error(`okänd profil "${name}" (tillåtna: ${Object.keys(PROFILES).join(', ')})`);
  return p;
}

/**
 * Antal världar per radioprofil för en budget (heltal, R0 avrundas nedåt).
 * @param {number} worlds - budget
 * @param {number} r0Share - R0-andel
 * @returns {{R0: number, R1: number}} fördelning
 */
function worldSplit(worlds, r0Share) {
  const r0 = Math.floor(worlds * r0Share);
  return { R0: r0, R1: worlds - r0 };
}

module.exports = {
  PROFILES, NIVÅVIKT, KNIVSEGG_FAKTOR, MAX_KORT, getProfile, worldSplit,
};
