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
         && Number.isFinite(etaMinutes)
         && etaMinutes > 0;
}

/**
 * Check if ETA value is null, undefined, or invalid
 * @param {number|null|undefined} etaMinutes - ETA value in minutes
 * @returns {boolean} True if ETA is invalid
 */
function isInvalidETA(etaMinutes) {
  return etaMinutes == null
         || Number.isNaN(etaMinutes)
         || !Number.isFinite(etaMinutes)
         || etaMinutes <= 0;
}

/**
 * Safely format ETA value with robust validation
 * @param {number|null|undefined} etaMinutes - ETA value in minutes
 * @returns {string|null} Formatted ETA string or null if invalid
 */
function formatETA(etaMinutes) {
  if (!isValidETA(etaMinutes)) {
    return null;
  }

  const roundedETA = Math.round(etaMinutes);
  if (roundedETA <= 0) {
    return 'nu';
  } if (roundedETA === 1) {
    return 'om 1 minut';
  }
  return `om ${roundedETA} minuter`;
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
