'use strict';

/**
 * U37 del 2 (dirigentens beslut 2026-11-16 på ägarens uppdrag, fråga F25):
 * EN FORMREGEL FÖR ALLA PASSAGENOTISER.
 *
 * En notis om en passage som redan skett säger antingen "har precis passerat"
 * eller "passerade … under AIS-tystnad". Regeln är U14 revision 3:s, nu för
 * alla notisvägar (retursläppen, S4, just-passed, BN2, failsafen och svepet):
 *  - "passerade … under AIS-tystnad" när det var tyst i mer än två
 *    AISHub-pollar (2 × AIS_CONFIG.AISHUB.POLL_INTERVAL_MS, 130 s) kring
 *    korsningen OCH notisen kommer mer än "precis passerat"-fönstret
 *    (PASSAGE_CLEAR_WINDOW_MS, 60 s) efter den;
 *  - annars "har precis passerat".
 * "Tyst kring korsningen" är det längsta leveransintervallet från sista fixen
 * före korsningen till fixen som ger notisen.
 *
 * ASYMMETRIN SOM BÄR REGELN. "passerade … under AIS-tystnad" är sant så snart
 * korsningen låg i ett glapp över 130 s, medan "har precis passerat" kräver
 * belägg för att korsningen var nyss. Vid osäkerhet väljs därför
 * tystnadsformen.
 *
 * NÄR KORSADE BÅTEN? Ur fixen efter korsningen: avståndet bortom linjen delat
 * med den rapporterade farten, när båten rör sig (minst MOVING_SOG_KN,
 * 0,5 kn, appens rörelsebevis MOVEMENT_PROOF_SOG_KN och returbevisets
 * RETURN_MIN_SOG_KN), dock aldrig före segmentets början och aldrig efter
 * första positionen bortom linjen. En båt som saktat in efter bron får ett för
 * stort dröjsmål, alltså tystnadsformen. KÄND GRÄNS (granskningen A5): en båt
 * som stannat efter bron och sedan gått vidare, med en tystnad som täcker både
 * korsningen och stoppet, får ett för litet dröjsmål och kan få "har precis
 * passerat" om en gammal passage (i banken stannar 18 av 1 006 korsningar inom
 * 300 m efter linjen och går vidare, nästan alla vid Stridsbergsbron; i 3 hade
 * det sammansatta läget gett fel form). Linjär interpolation över hela glappet
 * (U21:s mått för retursläppets tidsgräns) lägger korsningen för tidigt för en
 * båt som väntat i kö före bron och sedan gått igenom: i banken låg tolv
 * båtar 18–56 s efter korsningen enligt farten men 62–148 s enligt
 * interpolationen (PAX 54 m bortom Järnvägsbron i 5,3 kn efter 1 135 s
 * tystnad). Ligger båten still är korsningstiden okänd; efter en
 * tystnad över 130 s blir formen då tystnadens ("har precis passerat" kräver
 * belägg för att korsningen var nyss).
 *
 * Före U37 låg regeln i _returnPassageForm, medan meningen för de andra
 * vägarna följde källan: failsafen, svepet och BN2 sa alltid "under
 * AIS-tystnad" (också efter 120 s vid AISHub-kadens), och S4 sa alltid "har
 * precis passerat" (också efter ett glapp på 800 s och en korsning fyra
 * minuter före notisen, granskningen av K1, L1).
 */

const { AIS_CONFIG, BRIDGE_TEXT_CONSTANTS, MOORING_DETECTION } = require('../constants');
const geometry = require('./geometry');

// Mer än två AISHub-pollar utan ny fix: minst en utebliven rapport även från
// appens glesaste ordinarie flöde (AISHub, 65 s). Class B 30 s och AISHub 65 s
// är vanlig kadens, ingen tystnad.
const PASSAGE_SILENCE_MS = 2 * AIS_CONFIG.AISHUB.POLL_INTERVAL_MS;
// Appens "precis passerat"-fönster.
const PASSAGE_LATE_MS = BRIDGE_TEXT_CONSTANTS.PASSAGE_CLEAR_WINDOW_MS;
const M_PER_DEG_LAT = 111320;
// Rörelse: appens rörelsebevis (0,5 kn). Under den ligger båten still, och
// avståndet bortom linjen säger inget om när hon korsade.
const MOVING_SOG_KN = MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN;
const KN_TO_MS = 0.514444;

/**
 * Regeln. Utan tystnad (högst 130 s) är formen "har precis passerat"; efter en
 * tystnad avgör dröjsmålet, och ett okänt dröjsmål (null) ger tystnadsformen.
 * `silenceMs = Infinity` betyder att appen aldrig hört båten före fixen (en ny
 * båt, N6 och dirigentens beslut U44): tystnaden räknas som tystnad och
 * dröjsmålet avgör.
 * @param {{silenceMs: number, latenessMs: (number|null)}} evidence
 * @returns {'silence'|'live'|null} null när tystnaden inte är känd
 */
function passageNoticeForm({ silenceMs, latenessMs } = {}) {
  if (typeof silenceMs !== 'number' || Number.isNaN(silenceMs)) return null;
  if (silenceMs <= PASSAGE_SILENCE_MS) return 'live';
  if (!Number.isFinite(latenessMs)) return 'silence';
  return latenessMs > PASSAGE_LATE_MS ? 'silence' : 'live';
}

/**
 * Hur länge sedan korsningen var vid `now`, ur en fix bortom linjen: avståndet
 * till linjen delat med farten, dock aldrig före `earliestT` (segmentets
 * början) och aldrig efter `latestT` (första positionen bortom linjen). null
 * när båten ligger still (under MOVING_SOG_KN) eller ett mått saknas.
 * @param {{now: number, fixT: number, offsetM: number, sogKn: number, earliestT?: number,
 *   latestT?: number}} fix
 * @returns {number|null}
 */
function fixLatenessMs({
  now, fixT, offsetM, sogKn, earliestT, latestT,
} = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(fixT) || !Number.isFinite(offsetM)
      || !Number.isFinite(sogKn) || sogKn < MOVING_SOG_KN) return null;
  let crossedAt = fixT - (Math.abs(offsetM) / (sogKn * KN_TO_MS)) * 1000;
  if (Number.isFinite(earliestT)) crossedAt = Math.max(crossedAt, earliestT);
  // Aldrig efter fixen, och aldrig efter första positionen bortom linjen
  // (latestT; granskningen A3: en båt som saktat in släpps ibland en fix senare).
  crossedAt = Math.min(crossedAt, fixT);
  if (Number.isFinite(latestT)) crossedAt = Math.min(crossedAt, latestT);
  return now - crossedAt;
}

/**
 * Signerat avstånd till punktens linje längs kanalaxeln (+ = nordöstra
 * sidan). En bro har en linje (geometry.bridgeLineOffsetM); en punkt utan
 * broaxel (Kanalinfarten) prövas mot sin latitud, som svepet gör.
 * @param {{lat: number, lon: number}} pos
 * @param {{lat: number, lon: number, axisBearing?: number}} point
 * @returns {number}
 */
function lineOffsetM(pos, point) {
  if (!pos || !point || !Number.isFinite(pos.lat) || !Number.isFinite(point.lat)) return NaN;
  if (Number.isFinite(point.axisBearing)) return geometry.bridgeLineOffsetM(pos, point);
  return (pos.lat - point.lat) * M_PER_DEG_LAT;
}

/**
 * Formen ur ett observerat segment fram till notisens fix.
 *
 * Ligger linjen mellan segmentets ändar är tystnaden segmentets längd och
 * dröjsmålet tiden från korsningen (fixLatenessMs) till `now`. Ligger båda ändarna redan på bortre sidan i färdriktningen (bokföringen
 * kom en fix efter korsningen) skedde korsningen senast vid segmentets början:
 * då är dröjsmålet minst `now − from.t` och tystnaden minst segmentet. Räcker
 * de undre gränserna till tystnadsform gäller den; annars är formen okänd
 * (null) och notisvägen behåller sin egen. Okänd är den också när färdriktning
 * eller tider saknas, eller när båten ligger på tillfartssidan.
 * @param {{lat: number, lon: number, t: number}} from - föregående position
 * @param {{lat: number, lon: number, t: number}} to - notisens position
 * @param {Object} point - bron eller punkten
 * @param {number} travelSign - +1 norrut, −1 söderut, 0 okänd
 * @param {number} now - notisens tid
 * @param {number|null} sogKn - rapporterad fart i notisens fix
 * @returns {{form: ('silence'|'live'|null), silenceMs: (number|null),
 *   latenessMs: (number|null), inSegment: boolean}}
 */
function segmentPassageForm(from, to, point, travelSign, now, sogKn = null) {
  const none = {
    form: null, silenceMs: null, latenessMs: null, inSegment: false,
  };
  if (!from || !to || !Number.isFinite(from.t) || !Number.isFinite(to.t) || !(to.t > from.t)) return none;
  const offFrom = lineOffsetM(from, point);
  const offTo = lineOffsetM(to, point);
  if (!Number.isFinite(offFrom) || !Number.isFinite(offTo)) return none;
  const gapMs = to.t - from.t;
  if (offFrom !== 0 && Math.sign(offFrom) !== Math.sign(offTo)) {
    const latenessMs = fixLatenessMs({
      now, fixT: to.t, offsetM: offTo, sogKn, earliestT: from.t,
    });
    return {
      form: passageNoticeForm({ silenceMs: gapMs, latenessMs }),
      silenceMs: gapMs,
      latenessMs,
      inSegment: true,
    };
  }
  if (!travelSign || Math.sign(offFrom) !== travelSign || Math.sign(offTo) !== travelSign) return none;
  const lower = passageNoticeForm({ silenceMs: gapMs, latenessMs: now - from.t });
  return {
    form: lower === 'silence' ? 'silence' : null,
    silenceMs: gapMs,
    latenessMs: now - from.t,
    inSegment: false,
  };
}

module.exports = {
  passageNoticeForm,
  fixLatenessMs,
  MOVING_SOG_KN,
  segmentPassageForm,
  lineOffsetM,
  PASSAGE_SILENCE_MS,
  PASSAGE_LATE_MS,
};
