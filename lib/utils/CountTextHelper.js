'use strict';

/**
 * CountTextHelper - Shared utility for Swedish number-to-text conversion
 * Eliminates duplication between StallbackabronHelper and MessageBuilder
 *
 * REFACTORING: Single source of truth for count text
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

  /**
   * Build "ytterligare X båtar" text with correct Swedish style
   * @param {number} additionalCount - Number of additional vessels
   * @returns {string} Formatted additional text, or empty string if 0
   */
  static buildAdditionalText(additionalCount) {
    if (additionalCount === 0) return '';
    if (additionalCount === 1) return ', ytterligare 1 båt på väg';

    // Use lowercase for numbers after comma (Swedish style)
    return `, ytterligare ${this.getCountText(additionalCount, { lowercase: true })} båtar på väg`;
  }
}

module.exports = CountTextHelper;
