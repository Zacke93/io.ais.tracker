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

  let roundedETA = Math.round(etaMinutes);

  // CRITICAL FIX: Validate rounded result
  if (!Number.isFinite(roundedETA) || roundedETA <= 0) {
    return 'nu';
  } if (roundedETA === 1) {
    return 'om 1 minut';
  } if (roundedETA < 60) {
    return `om ${roundedETA} minuter`;
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
    return hours === 1 ? 'om 1 timme' : `om ${hours} timmar`;
  }
  return `om ${hours}h ${minutes}min`;

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

module.exports = {
  isValidETA,
  isInvalidETA,
  formatETA,
  etaDisplay,
  isValidVesselCoordinates,
  isValidSpeed,
  safeDivision,
  isValidDistance,
};
