'use strict';

/**
 * U69 (dirigentens beslut, omgång 9): sändare som inte är fartyg.
 *
 * MMSI:ns första siffror anger sändarens slag enligt ITU-R M.585. Listan är
 * kontrollerad mot USCG NAVCEN:s sammanställning av M.585-9 ("AIS as
 * interpreted by IEC 62288") och Wikipedias artikel om MMSI; standardens
 * senare utgåvor ska läsas innan listan ändras. Fältprov 3 (2026-11-25)
 * visade Sjöfartsverkets räddningshelikopter (LIFEGUARD 007, anropssignal
 * SE-JRN, MMSI 111 + landskod) som "En båt på väg mot Stridsbergsbron,
 * beräknad broöppning strax" i fem minuter. Appen ignorerar därför
 * positioner från dessa klasser (app._processAISMessage, efter
 * replay-inspelningen). Släpps igenom: 98… (farkost knuten till ett
 * moderfartyg), 8… (handhållen VHF med DSC och GNSS), vanliga fartyg
 * (första siffran 2–7) och otilldelade nummer (övriga 1… och 9…).
 *
 * Landskoden (MID, 201–775) ska stå på sin plats för de klasser som bär
 * den: 111MIDxxx, 99MIDxxxx, 00MIDxxxx och 0MIDxxxxx. Ett "dummy-MMSI" som
 * en felprogrammerad fritidsbåt kan sända (111111111, 999999999,
 * 000000000) har ingen giltig landskod och släpps igenom som före U69.
 * Nödsändarna (970, 972, 974) och AMRD grupp B (979) har ingen landskod på
 * den platsen och klassas på prefixet. Sjömärken omfattar fysiska,
 * virtuella och mobila (99MID8…); ett fartyg som bär eller bogserar ett
 * mobilt sjömärke har sitt eget MMSI.
 *
 * Funktionen klassar bara ett MMSI som är exakt nio siffror (sträng, med
 * blanksteg runt tillåtna, eller tal). Kortare och längre siffersträngar,
 * tecken som inte är siffror och tal som tappat inledande nollor ger null:
 * de hör till valideringen av inflödet, och kontrollen beror inte på den.
 * Ingen nollutfyllnad görs. Båda livekällorna gör om MMSI till tal, så
 * klasserna 0… och 00… nås i praktiken bara i uppspelning och test.
 */

const MID_MIN = 201;
const MID_MAX = 775;
const validMid = (s, from) => {
  const mid = Number(s.slice(from, from + 3));
  return mid >= MID_MIN && mid <= MID_MAX;
};

// [prefix, klass, landskodens första siffra (index) eller null]
const CLASSES = [
  ['111', 'räddningsflyg', 3], // SAR-flygplan och helikopter: 111 + MID + XXX
  ['970', 'AIS-SART', null], // sök- och räddningstransponder
  ['972', 'MOB', null], // man överbord
  ['974', 'EPIRB-AIS', null], // nödradiofyr med AIS
  ['979', 'AMRD grupp B', null], // autonom radioanordning, till exempel nätboj
  ['99', 'sjömärke', 2], // AtoN, fysiskt, virtuellt eller mobilt: 99 + MID + XXXX
  ['00', 'kuststation', 2], // 00 + MID + XXXX
  ['0', 'gruppanrop', 1], // gruppanrop för fartyg: 0 + MID + XXXXX
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
  if (!hit) return null;
  const [, klass, midAt] = hit;
  if (midAt !== null && !validMid(s, midAt)) return null;
  return klass;
}

module.exports = { nonVesselMmsiClass, MID_MIN, MID_MAX };
