'use strict';

/**
 * ETA Validation Utilities
 * Centralized validation logic for ETA values to prevent duplicated code
 */

/**
 * Check if ETA value is valid and finite
 * @param {number|null|undefined} etaMinutes - ETA value in minutes
 * @returns {boolean} True if ETA is valid
 */
function isValidETA(etaMinutes) {
  return etaMinutes !== null
         && etaMinutes !== undefined
         && typeof etaMinutes === 'number'
         && Number.isFinite(etaMinutes)
         && !Number.isNaN(etaMinutes)
         && etaMinutes > 0
         && etaMinutes <= 1440; // Max 24 hours
}

/**
 * Check if ETA value is null, undefined, or invalid
 * @param {number|null|undefined} etaMinutes - ETA value in minutes
 * @returns {boolean} True if ETA is invalid
 */
function isInvalidETA(etaMinutes) {
  return etaMinutes == null
         || typeof etaMinutes !== 'number'
         || Number.isNaN(etaMinutes)
         || !Number.isFinite(etaMinutes)
         || etaMinutes <= 0
         || etaMinutes > 1440; // Max 24 hours
}

/**
 * Safely format ETA value with robust validation
 * @param {number|null|undefined} etaMinutes - ETA value in minutes
 * @returns {string|null} Formatted ETA string or null if invalid
 */
function formatETA(etaMinutes) {
  // CRITICAL FIX: Enhanced validation to prevent all edge cases
  if (!isValidETA(etaMinutes) || etaMinutes === undefined || etaMinutes === null || Number.isNaN(etaMinutes)) {
    return null;
  }

  // Very close vessels (< 1 minute) → "strax"
  if (etaMinutes < 1) {
    return 'strax';
  }

  let roundedETA = Math.round(etaMinutes);

  // Safety fallback for edge cases
  if (!Number.isFinite(roundedETA) || roundedETA <= 0) {
    return 'strax';
  } if (roundedETA === 1) {
    return '1 minut';
  } if (roundedETA < 60) {
    return `${roundedETA} minuter`;
  }

  // Quantize long ETAs to avoid noisy UI updates
  const bucketSize = roundedETA >= 120 ? 10 : 5;
  roundedETA = Math.round(roundedETA / bucketSize) * bucketSize;
  if (roundedETA <= 0) {
    roundedETA = bucketSize;
  }

  // CRITICAL FIX: Handle hours and minutes for long ETAs
  const hours = Math.floor(roundedETA / 60);
  const minutes = roundedETA % 60;

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }

  if (minutes === 0) {
    return hours === 1 ? '1 timme' : `${hours} timmar`;
  }
  return `${hours}h ${minutes}min`;

}

/**
 * Create ETA display string for logging/debugging
 * @param {number|null|undefined} etaMinutes - ETA value in minutes
 * @returns {string} Human-readable ETA for logging
 */
function etaDisplay(etaMinutes) {
  if (isValidETA(etaMinutes)) {
    return `${etaMinutes.toFixed(1)}min`;
  }
  return 'null';
}

/**
 * Validate vessel coordinates are safe for distance calculations
 * @param {Object} vessel - Vessel object with lat/lon properties
 * @returns {boolean} True if coordinates are valid
 */
function isValidVesselCoordinates(vessel) {
  return vessel
    && Number.isFinite(vessel.lat)
    && Number.isFinite(vessel.lon)
    && Math.abs(vessel.lat) <= 90
    && Math.abs(vessel.lon) <= 180;
}

/**
 * Validate speed value for ETA calculations
 * @param {number} speed - Speed value in knots
 * @returns {boolean} True if speed is valid for calculations
 */
function isValidSpeed(speed) {
  return Number.isFinite(speed) && speed >= 0 && speed <= 100; // Reasonable max speed
}

/**
 * Safe division function that prevents division by zero
 * @param {number} dividend - Number to divide
 * @param {number} divisor - Number to divide by
 * @returns {number|null} Result or null if invalid
 */
function safeDivision(dividend, divisor) {
  if (!Number.isFinite(dividend) || !Number.isFinite(divisor) || divisor === 0) {
    return null;
  }

  const result = dividend / divisor;

  if (!Number.isFinite(result)) {
    return null;
  }

  return result;
}

/**
 * Validate distance calculation result
 * @param {number|null} distance - Distance in meters
 * @returns {boolean} True if distance is valid
 */
function isValidDistance(distance) {
  return distance !== null
    && distance !== undefined
    && Number.isFinite(distance)
    && distance >= 0;
}

/**
 * SSOT for the "beräknad broöppning ..." clause used in bridge_text.
 * Any path that converts an etaMinutes number into a Swedish bro-opening
 * clause must go through this helper (BridgeTextService, fallback text,
 * Flow-token formatters, etc.).
 *
 * Design rules (finalised after production analysis 2026-04-26):
 *   - Invalid/null/NaN ETA → "ETA okänd" (honest failure signal).
 *     Triggered when AIS has been silent >5 min (Fix 2) or on calculation
 *     errors. In normal active tracking this should not appear.
 *   - ETA < 3 min                → "beräknad broöppning strax"   (Fix 6)
 *   - ETA ≥ 3 min                → "beräknad broöppning om N minuter"
 *
 * Why "strax" up to 3 min: in production only 12 of 545 bridge-text
 * updates rendered "strax" (just 2 of 15 vessels). The previous <1 min
 * threshold gave a 30 m strax-zone — Class B AIS (30 s intervals) often
 * skipped over it entirely. With <3 min the strax-zone becomes ~460 m
 * at 5 knots, so virtually every passage now gets a strax-phase.
 *
 * No upper cap: large ETA values (40, 80, 120 min) are shown verbatim.
 * The ETA pipeline is trustworthy after Fix #3 and Fix #6 from earlier
 * commits, so extreme values accurately describe slow/stationary vessels.
 *
 * @param {number|null|undefined} etaMinutes
 * @returns {string} Swedish clause without trailing punctuation
 */
function formatETABroOpeningClause(etaMinutes, options = {}) {
  // Fix H (2026-04-28): imminent-override tvingar "strax" när BridgeTextService
  // signalerar att vessel är inom 300m från målbro. Fångar fall där ETA<3-zonen
  // missas (snabb passage, stillastående/saktande båt). Sätts BARA av app.js
  // efter skydd: targetBridge satt, AIS färsk, ej GPS-jump-hold.
  if (options && options.imminent === true) {
    return 'beräknad broöppning strax';
  }
  if (!isValidETA(etaMinutes)) {
    return 'ETA okänd';
  }
  if (etaMinutes < 3) {
    // 11h-körningen (2026-07-02): en EXTRAPOLERAD siffra som räknat ner in
    // i strax-bandet är en gissning från 5+ min gammal data — 09:22:27
    // visades "strax" för MARLIN 730 m från bron, som 67 s senare (färsk
    // data) korrigerades UPPÅT till "om 4 minuter". "Strax" reserveras för
    // färsk data/imminent/exhausted; extrapolationen säger ärligt "cirka".
    // (Exhausted-vägen går via imminent-flaggan ovan och behåller strax.)
    if (options && options.extrapolated === true) {
      return 'beräknad broöppning om cirka 2 minuter';
    }
    return 'beräknad broöppning strax';
  }
  const rounded = Math.round(etaMinutes);
  if (rounded <= 0) {
    // Defensive — should be unreachable since ETA<3 is handled above
    return 'beräknad broöppning strax';
  }
  // Fix G (2026-04-28): vid extrapolation från äldre AIS (5–10 min stale)
  // markeras siffran som "cirka" så bilförare förstår att den är ungefärlig.
  if (options && options.extrapolated === true) {
    return `beräknad broöppning om cirka ${rounded} minuter`;
  }
  return `beräknad broöppning om ${rounded} minuter`;
}

/**
 * Round an etaMinutes value for numeric display (Flow tokens, logs).
 * Returns null for invalid input so callers can choose their own sentinel
 * (Flow-tokens use -1 for unavailable).
 *
 * Historical note: this used to clamp values to 30 minutes to mirror the
 * 30-min upper cap in bridge_text. That cap was removed because post-fix
 * ETA values are trustworthy and users building Flow automations need
 * accurate values to make decisions (e.g. "warn me 10 min before opening").
 */
function etaMinutesForDisplay(etaMinutes) {
  if (!isValidETA(etaMinutes)) return null;
  return Math.round(etaMinutes);
}

module.exports = {
  isValidETA,
  isInvalidETA,
  formatETA,
  etaDisplay,
  isValidVesselCoordinates,
  isValidSpeed,
  safeDivision,
  isValidDistance,
  formatETABroOpeningClause,
  etaMinutesForDisplay,
};
