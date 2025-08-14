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

  const roundedETA = Math.round(etaMinutes);

  // CRITICAL FIX: Validate rounded result
  if (!Number.isFinite(roundedETA) || roundedETA <= 0) {
    return 'nu';
  } if (roundedETA === 1) {
    return 'om 1 minut';
  } if (roundedETA < 60) {
    return `om ${roundedETA} minuter`;
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

module.exports = {
  isValidETA,
  isInvalidETA,
  formatETA,
  etaDisplay,
};
