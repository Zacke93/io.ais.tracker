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
 * Design rules (finalised after ghost-vessel investigation 2026-04-18):
 *   - Invalid/null/NaN ETA → "ETA okänd" (honest failure signal).
 *     In normal operation this branch should never trigger; if it does,
 *     it indicates a bug in the ETA calculation pipeline.
 *   - ETA < 1 min                → "beräknad broöppning strax"
 *   - ETA = 1 min (rounded)      → "beräknad broöppning om 1 minut"
 *   - ETA ≥ 2 min                → "beräknad broöppning om N minuter"
 *
 * No upper cap: large ETA values (40, 80, 120 min) are shown verbatim.
 * After Bug #3/#6 fixes the ETA pipeline is trustworthy, so extreme values
 * accurately describe slow/stationary vessels. Showing the true number is
 * more honest than clamping to a phrase that implies the vessel is at the
 * bridge ("inväntar broöppning") or promises an imminent opening ("strax").
 *
 * @param {number|null|undefined} etaMinutes
 * @returns {string} Swedish clause without trailing punctuation
 */
function formatETABroOpeningClause(etaMinutes) {
  if (!isValidETA(etaMinutes)) {
    return 'ETA okänd';
  }
  if (etaMinutes < 1) {
    return 'beräknad broöppning strax';
  }
  const rounded = Math.round(etaMinutes);
  if (rounded <= 0) {
    return 'beräknad broöppning strax';
  }
  if (rounded === 1) {
    return 'beräknad broöppning om 1 minut';
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
