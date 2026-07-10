'use strict';

/**
 * CountTextHelper - Shared utility for Swedish number-to-text conversion
 * Single source of truth for count text (used by BridgeTextService)
 */
class CountTextHelper {
  /**
   * Convert number to Swedish text representation
   * @param {number} count - Number to convert (1-10 supported)
   * @param {Object} options - Formatting options
   * @param {boolean} options.lowercase - Return lowercase text (default: false)
   * @returns {string} Swedish text representation
   */
  static getCountText(count, options = {}) {
    const { lowercase = false } = options;

    // Defensiv null-guard: null/undefined/NaN kraschade tidigare på
    // count.toString(). Returnera '0' som säkert fallback (ingen loggning —
    // statisk helper utan logger).
    if (count === null || count === undefined
        || (typeof count === 'number' && !Number.isFinite(count))) {
      return '0';
    }

    const textNumbers = {
      1: 'En',
      2: 'Två',
      3: 'Tre',
      4: 'Fyra',
      5: 'Fem',
      6: 'Sex',
      7: 'Sju',
      8: 'Åtta',
      9: 'Nio',
      10: 'Tio',
    };

    let text = textNumbers[count] || count.toString();

    if (lowercase && typeof text === 'string') {
      text = text.toLowerCase();
    }

    return text;
  }

  // Helgranskning 2026-07-10: buildAdditionalText raderad — noll anrop
  // (legacy-frasen "ytterligare X båtar" PARSAS bara bakåtkompatibelt i
  // app.js:_extractVesselCounts, byggs aldrig längre).
}

module.exports = CountTextHelper;
