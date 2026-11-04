'use strict';

/**
 * Schemavalidering av replayrader (buggjägaren, BUGGJAKT §3).
 *
 * Varje rad som motorn skriver valideras här FÖRE skrivningen. Valideringen
 * stänger harnessens kända hängklasser:
 *   - en ctrl-rad utan aisTimestamp (replayRunner stegar då klockan mot NaN),
 *   - tid i sekunder i stället för ms (klockan stegar 50 år i 30 s-bitar),
 *   - ISO-strängar i aisTimestamp (sorteras som NaN och kastar om strömmen).
 * Fältnamnen `timestamp` och `fixFeed` avvisas, eftersom runnern ignorerar dem
 * tyst — en rad som ser rätt ut men aldrig läses är farligare än en som kastar.
 *
 * Felmeddelandena anger radnummer räknat från 1, som i en editor.
 */

const MIN_EPOCH_MS = 1.5e12;
const MAX_EPOCH_MS = 4.1e12;
const CTRL_VALUES = new Set(['disconnect', 'reconnect', 'restart']);
const FEED_VALUES = new Set(['aisstream', 'aishub']);
const FORBIDDEN_FIELDS = {
  timestamp: 'fältet timestamp ignoreras av replayRunner (använd aisTimestamp)',
  fixFeed: 'fältet fixFeed ignoreras av replayRunner (använd feed)',
};

function isEpochMs(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= MIN_EPOCH_MS && v <= MAX_EPOCH_MS;
}

function describe(v) {
  if (typeof v === 'string') return `"${v.slice(0, 40)}" (sträng)`;
  if (typeof v === 'number') return String(v);
  return v === undefined ? 'saknas' : JSON.stringify(v);
}

/**
 * Validerar EN rad. Returnerar en lista med felmeddelanden (tom = giltig).
 * @param {object} row - raden
 * @param {number} lineNo - radnummer (1-baserat) för meddelandet
 * @returns {string[]} fel
 */
function validateRow(row, lineNo) {
  const at = `rad ${lineNo}`;
  if (!row || typeof row !== 'object' || Array.isArray(row)) return [`${at}: raden är inget objekt`];
  const errors = [];
  for (const [field, why] of Object.entries(FORBIDDEN_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(row, field)) errors.push(`${at}: ${why}`);
  }
  if (!isEpochMs(row.aisTimestamp)) {
    let hint = '';
    if (typeof row.aisTimestamp === 'number' && Number.isFinite(row.aisTimestamp) && row.aisTimestamp > 1e9 && row.aisTimestamp < 1e10) hint = ' — ser ut som sekunder, inte ms';
    errors.push(`${at}: aisTimestamp ${describe(row.aisTimestamp)} är inget epok-ms-tal i [1,5e12; 4,1e12]${hint}`);
  }
  if (row.ctrl !== undefined) {
    if (!CTRL_VALUES.has(row.ctrl)) errors.push(`${at}: okänd ctrl ${describe(row.ctrl)} (tillåtna: disconnect, reconnect, restart)`);
    return errors;
  }
  if (typeof row.mmsi !== 'string' || !/^\d{9}$/.test(row.mmsi)) errors.push(`${at}: mmsi ${describe(row.mmsi)} är ingen 9-siffrig sträng`);
  if (typeof row.lat !== 'number' || !Number.isFinite(row.lat)) errors.push(`${at}: lat ${describe(row.lat)} är inget ändligt tal`);
  if (typeof row.lon !== 'number' || !Number.isFinite(row.lon)) errors.push(`${at}: lon ${describe(row.lon)} är inget ändligt tal`);
  if (row.fixTs !== undefined) {
    if (!isEpochMs(row.fixTs)) errors.push(`${at}: fixTs ${describe(row.fixTs)} är inget epok-ms-tal`);
    else if (isEpochMs(row.aisTimestamp) && row.fixTs > row.aisTimestamp) errors.push(`${at}: fixTs ${row.fixTs} ligger efter aisTimestamp ${row.aisTimestamp}`);
  }
  if (row.feed !== undefined && !FEED_VALUES.has(row.feed)) errors.push(`${at}: feed ${describe(row.feed)} (tillåtna: aisstream, aishub eller saknas)`);
  return errors;
}

/**
 * Validerar en hel radlista.
 * @param {object[]} rows - raderna i filordning
 * @param {{max?: number}} [opts] - högst så många fel samlas
 * @returns {{ok: boolean, fel: string[], antalFel: number}} utfall
 */
function validateRows(rows, { max = 50 } = {}) {
  const fel = [];
  let antalFel = 0;
  if (!Array.isArray(rows)) return { ok: false, fel: ['raderna är ingen lista'], antalFel: 1 };
  rows.forEach((row, i) => {
    const errs = validateRow(row, i + 1);
    antalFel += errs.length;
    for (const e of errs) if (fel.length < max) fel.push(e);
  });
  return { ok: antalFel === 0, fel, antalFel };
}

/**
 * Kastar om raderna inte klarar schemat. Används före varje skrivning.
 * @param {object[]} rows - raderna
 * @param {string} label - vad som skulle skrivas (för meddelandet)
 */
function assertValidRows(rows, label) {
  const res = validateRows(rows, { max: 5 });
  if (!res.ok) {
    const err = new Error(`schemafel i ${label}: ${res.fel.join('; ')}${res.antalFel > res.fel.length ? ` (+${res.antalFel - res.fel.length} till)` : ''}`);
    err.code = 'SCHEMAFEL';
    throw err;
  }
}

/**
 * Tolkar jsonl-text till rader. Trasig JSON rapporteras med radnummer.
 * @param {string} text - filinnehållet
 * @returns {{rader: object[], fel: string[]}} rader i filordning
 */
function parseJsonl(text) {
  const rader = [];
  const fel = [];
  String(text).split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rader.push(JSON.parse(line));
    } catch (e) {
      fel.push(`rad ${i + 1}: ogiltig JSON (${e.message})`);
    }
  });
  return { rader, fel };
}

module.exports = {
  MIN_EPOCH_MS,
  MAX_EPOCH_MS,
  CTRL_VALUES,
  FEED_VALUES,
  isEpochMs,
  validateRow,
  validateRows,
  assertValidRows,
  parseJsonl,
};
