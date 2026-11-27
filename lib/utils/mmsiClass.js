'use strict';

/**
 * U69 (dirigentens beslut, omgång 9): sändare som inte är fartyg.
 *
 * MMSI:ns första siffror anger sändarens slag (ITU-R M.585-9, Annex 1–2).
 * Fältprov 3 (2026-11-25) visade ett räddningsflyg (111 + landskod) som
 * "En båt på väg mot Stridsbergsbron, beräknad broöppning strax" i fem
 * minuter. Appen ignorerar därför positioner från dessa klasser helt
 * (app._processAISMessage). Släpps igenom: 98… (farkost knuten till ett
 * moderfartyg), 8… (handhållen VHF med DSC och GNSS) och vanliga fartyg
 * (första siffran 2–7). M.585-9 har också 979… för autonoma radioanordningar
 * (AMRD grupp B); den klassen ingår inte i U69.
 *
 * Funktionen klassar bara ett MMSI som är exakt nio siffror (sträng, med
 * blanksteg runt tillåtna, eller tal). Felformade MMSI (fel längd, tecken
 * som inte är siffror, ett tal som tappat inledande nollor) ger null: de
 * hör till valideringen av inflödet, och kontrollen här ska inte bero på den.
 */

const CLASSES = [
  ['111', 'räddningsflyg'], // SAR-flygplan och helikopter: 111 + MID + XXX
  ['970', 'AIS-SART'], // sök- och räddningstransponder
  ['972', 'MOB'], // man överbord
  ['974', 'EPIRB-AIS'], // nödradiofyr med AIS
  ['99', 'sjömärke'], // AtoN, fysiskt eller virtuellt: 99 + MID + XXXX
  ['00', 'kuststation'], // 00 + MID + XXXX
  ['0', 'gruppanrop'], // gruppanrop för fartyg: 0 + MID + XXXXX
];

/**
 * @param {string|number} mmsi
 * @returns {string|null} klassens namn för en sändare som inte är ett fartyg, annars null
 */
function nonVesselMmsiClass(mmsi) {
  let s = null;
  if (typeof mmsi === 'string') s = mmsi.trim();
  else if (typeof mmsi === 'number' && Number.isInteger(mmsi)) s = String(mmsi);
  if (!s || !/^\d{9}$/.test(s)) return null;
  const hit = CLASSES.find(([prefix]) => s.startsWith(prefix));
  return hit ? hit[1] : null;
}

module.exports = { nonVesselMmsiClass };
