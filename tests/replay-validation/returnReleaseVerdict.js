'use strict';

/**
 * U14 (granskningen 2026-11-04): GEOMETRISK DOM över ett returpassagesläpp,
 * ur rådatan och oberoende av appens egna kriterier. replayRunner sätter
 * domen på varje post i visitReturnReleases, och INV-2 läser den.
 *
 * AVSTÅNDET. Domen är var båten först syns minst
 * PASSED_HOLD_RELEASE_BEYOND_M (100 m) från brolinjen EFTER släppet:
 * 'ankomst' (passagen tillbaka skedde), 'bortre' (hon låg kvar eller vände
 * tillbaka; släppet var falskt) eller 'okänd' (spåret når aldrig dit). 100 m
 * ligger över både UNDER_BRIDGE_CLEAR_DISTANCE och den dokumenterade
 * multipathen vid brolinjen (20–80 m), så ett enskilt brusigt sampel avgör
 * inte.
 *
 * TIDEN (omgranskningen 2026-11-05). Ett släpp är 'för tidig' när varken
 * släppets fix, nästa fix efter släppet eller något sampel inom
 * PASSAGE_CLEAR_WINDOW_MS efter släppet ligger entydigt (över 10 m) på
 * ankomstsidan. Ett släpp vid linjen som följs av en väntan på bortre sidan
 * och en sen verklig korsning hade annars dömts 'ankomst' fast notisen kom
 * minuter före passagen. Nästa fix räknas oavsett kadens: vid AISHub (65 s)
 * ligger den utanför fönstret även för en båt som var igenom på sekunder.
 *
 * ATT STANNA (omgranskning 2, 2026-11-07). Ett brussprång kan lägga själva
 * släppfixen på ankomstsidan medan båten väntar kvar på bortre sidan
 * (granskarens retur-i60+0-d3-j15-r06-s2: släppfixen −14,3 m, nästa fix
 * +5,2 m, korsningen 13 min senare). Domen blir därför också 'för tidig' när
 * färre än hälften av fixarna efter släppet, räknat över nästa fix och alla
 * sampel inom PASSAGE_CLEAR_WINDOW_MS, ligger entydigt på ankomstsidan. Vid
 * gles kadens är det bara nästa fix; vid tät kadens tål domen enstaka
 * brusiga sampel hos en båt som verkligen är på väg bort från linjen.
 */
const { BRIDGES, PASSAGE_TIMING, BRIDGE_TEXT_CONSTANTS } = require('../../lib/constants');
const geometry = require('../../lib/utils/geometry');

const BEYOND_M = PASSAGE_TIMING.PASSED_HOLD_RELEASE_BEYOND_M;
const WINDOW_MS = BRIDGE_TEXT_CONSTANTS.PASSAGE_CLEAR_WINDOW_MS;
const BRIDGE_BY_NAME = new Map(Object.values(BRIDGES).map((b) => [b.name, b]));

/**
 * @param {{t: number, mmsi: string, bridge: string, farSign: number}} release
 * @param {Array<{mmsi: string|number, aisTimestamp: number, lat: number, lon: number}>} samples
 *   jsonl-samplen i tidsordning
 * @returns {{verdict: 'ankomst'|'bortre'|'okänd'|'för tidig', verdictT: (number|undefined)}}
 */
function judgeReturnRelease(release, samples) {
  const bridge = BRIDGE_BY_NAME.get(release.bridge);
  if (!bridge || !release.farSign) return { verdict: 'okänd', verdictT: undefined };
  let verdict = 'okänd';
  let verdictT;
  let releaseFix = null;
  let timely = false;
  let nextFixSeen = false;
  let afterSamples = 0;
  let afterArrival = 0;
  for (const s of samples) {
    if (String(s.mmsi) !== String(release.mmsi)) continue;
    if (s.aisTimestamp <= release.t) {
      releaseFix = s;
      continue;
    }
    const arrivalSide = geometry.decisiveBridgeSide(s, bridge) === -release.farSign;
    const inWindow = s.aisTimestamp <= release.t + WINDOW_MS;
    // Nästa fix räknas alltid, övriga bara inom fönstret.
    if (!nextFixSeen || inWindow) {
      afterSamples += 1;
      if (arrivalSide) {
        afterArrival += 1;
        timely = true;
      }
    }
    nextFixSeen = true;
    if (verdictT === undefined) {
      const offset = geometry.bridgeLineOffsetM(s, bridge);
      if (Number.isFinite(offset) && Math.abs(offset) >= BEYOND_M) {
        verdict = Math.sign(offset) === release.farSign ? 'bortre' : 'ankomst';
        verdictT = s.aisTimestamp;
      }
    }
    // Avståndsdomen är klar och tidsfönstret passerat: inget mer att läsa.
    if (verdictT !== undefined && !inWindow) break;
  }
  if (releaseFix && geometry.decisiveBridgeSide(releaseFix, bridge) === -release.farSign) timely = true;
  // Båten stannar på ankomstsidan: minst hälften av fixarna efter släppet
  // (nästa fix och fönstret) ligger entydigt där.
  const stays = afterArrival * 2 >= afterSamples;
  if (verdict !== 'bortre' && !(timely && stays)) verdict = 'för tidig';
  return { verdict, verdictT };
}

module.exports = { judgeReturnRelease };
