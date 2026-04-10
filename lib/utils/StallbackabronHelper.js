'use strict';

/**
 * StallbackabronHelper - Minimal helper (kept for backward compatibility)
 * All Stallbackabron logic is now handled inline by BridgeTextService.
 */
class StallbackabronHelper {
  static isStallbackabron(name) {
    return name === 'Stallbackabron';
  }
}

module.exports = StallbackabronHelper;
