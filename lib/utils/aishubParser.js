'use strict';

/**
 * aishubParser - Ren, sidoeffektsfri parsning av AISHubs webservice-svar
 * (https://data.aishub.net/ws.php, format=1 "human readable", output=json).
 *
 * KONTRAKT (verifierat mot https://www.aishub.net/api, etapp 1 2026-08-02):
 *   Lyckat svar:  [ {ERROR:false, USERNAME:"...", FORMAT:"HUMAN", RECORDS:n},
 *                   [ {MMSI,TIME,LATITUDE,LONGITUDE,COG,SOG,HEADING,NAVSTAT,
 *                      IMO,NAME,CALLSIGN,TYPE,A,B,C,D,DRAUGHT,DEST,ETA}, … ] ]
 *   Felsvar:      [ {ERROR:true, ERROR_MESSAGE:"..."} ]
 *   Rate-limit:   tom body (hanteras av klienten FÖRE parsning)
 *
 * DESIGNREGLER (slutplanen §5 + granskningsfynd V2-M1/M2/M6, V1-m1/m2):
 *  - ERROR-grenen kontrolleras FÖRE formkontrollen — ett felkuvert har inte
 *    formen [meta,[poster]] och får aldrig klassas som envelope-error.
 *  - ERROR-sanningsvärdet normaliseras: servern kan leverera boolean, "true",
 *    0/1 eller sträng — allt som inte uttryckligen är falskt räknas som fel.
 *  - Aldrig .map() på roten — kuvertet är [meta, lista], inte en postlista.
 *  - Numerisk koercion (Number()) på LATITUDE/LONGITUDE/SOG/COG/NAVSTAT —
 *    utan den faller varje strängserverad post tyst på appvalideringen.
 *  - Sentinelparitet med AISStreamClient (osynliga-båtar-klassen):
 *    SOG >= 102.15 → null, COG === 360 → null, NAVSTAT utanför 0-14 → null
 *    (15 är AIS-spec "undefined" och får ALDRIG skriva över ett känt 1/5),
 *    HEADING kastas, lat 91/lon 181 = positionssentinel → posten släpps,
 *    0,0 = Guineabukten-artefakten → posten släpps (AISStreamClient.js-
 *    pariteten), MMSI valideras NUMERISKT före strängifiering (MMSI 0 får
 *    inte bli strängen "0" som passerar appens MMSI-kontroll).
 *  - TIME → fixTs (ms epoch): tolerant regex + unix-sekundsfallback, aldrig
 *    new Date(str) (implementationsberoende). Oparsbar TIME ⇒ posten släpps
 *    och räknas (timeParseFail) — klienten larmar när ALLT faller 3 svep i rad.
 *
 * Parsern använder ALDRIG Date.now() — mottagningstid stämplas av klienten
 * vid emission (klockdomänsinvarianten: fixTs är domän F, timestamp domän M).
 */

// Tolerant: "YYYY-MM-DD HH:MM:SS" med valfritt T-separator och GMT/UTC/Z-suffix.
const TIME_RE = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*(?:GMT|UTC|Z)?\s*$/;
const UNIX_SECONDS_RE = /^\d{9,10}$/;

/**
 * ERROR-flaggan i AISHub-kuvertet, normaliserad. Endast uttryckligen falska
 * värden (false, "false", 0, "0", null/undefined) räknas som "inget fel".
 * @param {*} v - Råvärdet av meta.ERROR
 * @returns {boolean} true om kuvertet signalerar fel
 */
function isErrorFlagSet(v) {
  return !(v === false || v === 'false' || v === 0 || v === '0' || v == null);
}

/**
 * TIME-fältet → ms epoch, eller null om oparsbart.
 * @param {*} raw - TIME-värdet (sträng "YYYY-MM-DD HH:MM:SS GMT", unix-sekunder
 *                  som sträng, eller tal)
 * @returns {number|null}
 */
function parseTimeToMs(raw) {
  if (Number.isFinite(raw)) {
    // Servern kan teoretiskt leverera tal: tolka som unix-SEKUNDER när
    // magnituden stämmer (9-10 siffror ≈ 2001-2286), annars oparsbart.
    if (raw >= 1e9 && raw < 1e11) return raw * 1000;
    return null;
  }
  if (typeof raw !== 'string') return null;
  const m = TIME_RE.exec(raw);
  if (m) {
    const ms = Date.UTC(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6]),
    );
    return Number.isFinite(ms) ? ms : null;
  }
  const trimmed = raw.trim();
  if (UNIX_SECONDS_RE.test(trimmed)) return Number(trimmed) * 1000;
  return null;
}

/**
 * Normalisera en råpost till exakt samma form som AISStreamClient emittar
 * (plus fixTs/fixFeed/fixTsQuality). Returnerar { record } eller { drop }.
 * @private
 */
function normalizeRecord(raw, stats) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    stats.invalidRecord++;
    return null;
  }

  // MMSI: numeriskt och >= 1 FÖRE strängifiering (V2-M6).
  const mmsiNum = Number(raw.MMSI);
  if (!Number.isInteger(mmsiNum) || mmsiNum < 1) {
    stats.invalidMmsi++;
    return null;
  }

  // Null-fällan: Number(null) === 0 — en post UTAN fält får ALDRIG tolkas
  // som värdet 0 (sog 0 = "verklig nollfart", navstatus 0 = "under way",
  // lat 0 = ekvatorn). Saknat fält ⇒ NaN ⇒ null/drop.
  const num = (v) => (v == null ? NaN : Number(v));

  const lat = num(raw.LATITUDE);
  const lon = num(raw.LONGITUDE);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)
      || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    stats.invalidPosition++;
    return null;
  }
  // Positionssentineler: lat 91/lon 181 täcks av intervallkontrollen ovan;
  // 0,0 är "GPS saknas"-artefakten (samma avvisning som AISStreamClient).
  if (lat === 0 && lon === 0) {
    stats.sentinelPos++;
    return null;
  }

  const fixTs = parseTimeToMs(raw.TIME);
  if (fixTs === null) {
    stats.timeParseFail++;
    return null;
  }

  // SOG-sentinel: 102.4 = "ej tillgänglig" (format=1-skalan). Samma gräns
  // >= 102.15 som AISStreamClient (täcker även 102.2 "eller mer").
  const sogNum = num(raw.SOG);
  let sog = Number.isFinite(sogNum) ? sogNum : null;
  if (sog !== null && sog >= 102.15) sog = null;

  // COG-sentinel: 360 = "kurs ej tillgänglig" (aldrig fabricerad nordkurs).
  const cogNum = num(raw.COG);
  let cog = Number.isFinite(cogNum) ? cogNum : null;
  if (cog === 360) cog = null;

  // NAVSTAT: 0-14 är semantiska statusar; 15 = "undefined" (AIS-spec) och
  // allt utanför intervallet → null så ett känt 1/5 aldrig skrivs över.
  const navNum = num(raw.NAVSTAT);
  const navStatus = Number.isInteger(navNum) && navNum >= 0 && navNum <= 14
    ? navNum
    : null;

  // NAME max 20 tecken, @-fyllnad förekommer i rå AIS — trimma defensivt.
  const shipName = String(raw.NAME ?? '').replace(/@/g, ' ').trim() || 'Unknown';

  return {
    mmsi: String(mmsiNum),
    msgType: 'AISHubPosition',
    lat,
    lon,
    sog,
    cog,
    navStatus,
    shipName,
    fixTs,
    fixFeed: 'aishub',
    fixTsQuality: 'true-fix',
    // OBS: ingen timestamp här — mottagningstid (domän M) stämplas av
    // klienten vid emission, aldrig av parsern (ren funktion).
  };
}

/**
 * Parsa ett komplett AISHub-svar (rå bodysträng).
 *
 * @param {string} body - Råsvaret från ws.php
 * @returns {{
 *   kind: 'data'|'empty-body'|'error-record'|'format-mismatch'|'envelope-error'|'parse-error',
 *   ok: boolean,
 *   errorMessage: string|null,
 *   meta: object|null,
 *   records: Array<object>,
 *   stats: object,
 * }}
 */
function parseEnvelope(body) {
  const stats = {
    records: 0,
    accepted: 0,
    timeParseFail: 0,
    sentinelPos: 0,
    invalidMmsi: 0,
    invalidPosition: 0,
    invalidRecord: 0,
    recordCountMismatch: false,
  };
  const result = (kind, extra = {}) => ({
    kind,
    ok: kind === 'data',
    errorMessage: null,
    meta: null,
    records: [],
    stats,
    ...extra,
  });

  if (typeof body !== 'string' || body.trim() === '') {
    // Rate-limit-signaturen: webservicen "will return nothing" vid för täta
    // anrop. Klienten skiljer denna från nätfel via sin backoff-bokföring.
    return result('empty-body');
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    // HTML-felsida, trunkerat svar, proxy-injektion … aldrig data.
    return result('parse-error');
  }

  // ERROR-grenen FÖRE formkontrollen: felkuvertet är [ {ERROR:true, …} ]
  // (ingen postlista) och får inte klassas som trasigt kuvert.
  const meta = Array.isArray(parsed) ? parsed[0] : parsed;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)
      && isErrorFlagSet(meta.ERROR)) {
    const msg = meta.ERROR_MESSAGE != null ? String(meta.ERROR_MESSAGE) : 'unknown AISHub error';
    return result('error-record', { errorMessage: msg, meta });
  }

  // Formkontroll: [meta, [poster]] — aldrig .map() på roten.
  if (!Array.isArray(parsed)
      || !parsed[0] || typeof parsed[0] !== 'object' || Array.isArray(parsed[0])
      || !Array.isArray(parsed[1])) {
    return result('envelope-error', { meta: meta && typeof meta === 'object' ? meta : null });
  }

  // FORMAT-assertion: vi begär format=1 ⇒ "HUMAN". Byter servern semantik
  // (format=0: koordinater ×600000, SOG-sentinel 1024) vore varje post tyst
  // giftig — hellre noll data + larm än 100 % feltolkade positioner.
  if (meta.FORMAT !== undefined && String(meta.FORMAT).toUpperCase() !== 'HUMAN') {
    return result('format-mismatch', { meta });
  }

  const rawRecords = parsed[1];
  stats.records = rawRecords.length;

  // RECORDS-assertion: mismatch är informativ (data behålls) — kan indikera
  // trunkerat svar; klienten loggar och räknar.
  const declared = Number(meta.RECORDS);
  if (Number.isFinite(declared) && declared !== rawRecords.length) {
    stats.recordCountMismatch = true;
  }

  const records = [];
  for (const raw of rawRecords) {
    const rec = normalizeRecord(raw, stats);
    if (rec) records.push(rec);
  }
  stats.accepted = records.length;

  return result('data', { meta, records });
}

module.exports = {
  parseEnvelope,
  parseTimeToMs,
  isErrorFlagSet,
};
