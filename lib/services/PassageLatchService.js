'use strict';

/**
 * PassageLatchService - Förhindrar temporal paradoxer i bridge text
 *
 * SYFTE: Löser problemet där båtar "tidsreser" och får meddelanden som:
 * "En båt åker strax under Stallbackabron" EFTER "En båt har precis passerat Stallbackabron"
 *
 * FUNKTIONALITET:
 * - Latch per båt+bro kombination som förhindrar retrograda meddelanden
 * - Riktningsstabilisering för GPS-hopp recovery
 * - Timeout-hantering för att förhindra permanent låsning
 */

const BRIDGE_NAMES = ['Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron', 'Klaffbron', 'Olidebron'];

class PassageLatchService {
  constructor(logger) {
    this.logger = logger;

    // Map: vesselId -> Map(bridgeName -> latchData)
    this._passageLatches = new Map();

    // Timeout för automatic latch clearing (förhindrar permanent låsning)
    this._latchTimeout = 10 * 60 * 1000; // 10 minuter

    // Cleanup timer (disabled in test mode to avoid lingering intervals)
    if (process.env.NODE_ENV === 'test' || global.__TEST_MODE__) {
      this._cleanupTimer = null;
      this.logger.debug('🧪 [PASSAGE_LATCH] Test mode detected - skipping cleanup timer');
    } else {
      this._cleanupTimer = setInterval(() => {
        this._cleanupExpiredLatches();
      }, 60 * 1000); // Varje minut
    }

    this.logger.debug('🔒 [PASSAGE_LATCH] Service initialized');
  }

  /**
   * Registrera att en båt har passerat en bro
   * @param {string} vesselId - Vessel MMSI
   * @param {string} bridgeName - Name of bridge passed
   * @param {string} direction - 'north' eller 'south'
   */
  registerPassage(vesselId, bridgeName, direction) {
    if (!vesselId || !bridgeName || !BRIDGE_NAMES.includes(bridgeName)) {
      return;
    }

    // Skapa vessel entry om den inte finns
    if (!this._passageLatches.has(vesselId)) {
      this._passageLatches.set(vesselId, new Map());
    }

    const vesselLatches = this._passageLatches.get(vesselId);
    const latchData = {
      bridgeName,
      direction,
      timestamp: Date.now(),
      latchedStatuses: new Set(['approaching', 'stallbacka-waiting', 'waiting']), // Dessa statusar blockeras
      passageConfirmed: true,
    };

    vesselLatches.set(bridgeName, latchData);

    this.logger.debug(`🔒 [PASSAGE_LATCH] ${vesselId}: Registered passage of ${bridgeName} (${direction})`);
  }

  /**
   * Kontrollera om status ska blockeras för en båt+bro kombination
   * @param {string} vesselId - Vessel MMSI
   * @param {string} bridgeName - Bridge name
   * @param {string} proposedStatus - Status som föreslås
   * @returns {boolean} - true om status ska blockeras
   */
  shouldBlockStatus(vesselId, bridgeName, proposedStatus, currentCog = null) {
    if (!vesselId || !bridgeName || !proposedStatus) {
      return false;
    }

    const vesselLatches = this._passageLatches.get(vesselId);
    if (!vesselLatches) {
      return false;
    }

    const latchData = vesselLatches.get(bridgeName);
    if (!latchData) {
      return false;
    }

    // Kontrollera om latch har expired
    const age = Date.now() - latchData.timestamp;
    if (age > this._latchTimeout) {
      this.logger.debug(`🔓 [PASSAGE_LATCH] ${vesselId}: Latch for ${bridgeName} expired (${Math.round(age / 1000)}s old)`);
      vesselLatches.delete(bridgeName);
      return false;
    }

    // F13: latchen ska bara blockera RETROGRADA meddelanden i SAMMA riktning
    // som passagen. Om båten bevisligen rör sig i MOTSATT riktning (legitim
    // vändning tillbaka mot bron) ska vi INTE blockera — annars fryser
    // bridge_text och notiser uteblir vid verklig närhet i upp till ~7 min.
    // Konservativt: släpp bara igenom när nuvarande riktning är ENTYDIG och
    // skiljer sig från den lagrade. Osäker/saknad COG → behåll blockeringen
    // (ingen regress-risk).
    const currentDirection = this._directionFromCog(currentCog);
    if (currentDirection && latchData.direction && currentDirection !== latchData.direction) {
      // Helgranskning 2026-07-06 (route-latch#2): kräv TVÅ konsekutiva
      // motsatta avläsningar (spegling av Anomali 18-debouncen) — ett enda
      // brusigt COG-sampel hos en långsam båt släppte annars igenom en
      // retrograd status-tick (och kunde via dedupens motriktnings-undantag
      // öppna för dubbelnotis).
      const pending = latchData.pendingReversal;
      const PENDING_MAX_AGE_MS = 2 * 60 * 1000;
      const confirmed = pending
        && pending.dir === currentDirection
        && Number.isFinite(pending.time)
        && (Date.now() - pending.time) < PENDING_MAX_AGE_MS;
      if (!confirmed) {
        latchData.pendingReversal = { dir: currentDirection, time: Date.now() };
        this.logger.debug(
          `⏳ [PASSAGE_LATCH] ${vesselId}: Reversal → ${currentDirection} observerad för ${bridgeName} — väntar på bekräftelse`,
        );
        return latchData.latchedStatuses.has(proposedStatus);
      }
      this.logger.debug(
        `🔓 [PASSAGE_LATCH] ${vesselId}: Releasing latch for ${bridgeName} — vessel reversed `
        + `(passage ${latchData.direction}, now ${currentDirection})`,
      );
      return false;
    }
    if (latchData.pendingReversal && currentDirection && currentDirection === latchData.direction) {
      // Kursen återgick till passageriktningen — brus, nollställ kandidaten.
      latchData.pendingReversal = null;
    }

    // Kontrollera om status ska blockeras
    const shouldBlock = latchData.latchedStatuses.has(proposedStatus);

    if (shouldBlock) {
      this.logger.debug(`🚫 [PASSAGE_LATCH] ${vesselId}: Blocking retrograde status "${proposedStatus}" for ${bridgeName} (passed ${Math.round(age / 1000)}s ago)`);
    }

    return shouldBlock;
  }

  /**
   * Härled riktning ur COG med samma trösklar som VesselDataService
   * (_safeDetermineDirection). Returnerar null vid osäker/saknad COG.
   * @param {number|null} cog
   * @returns {'north'|'south'|null}
   * @private
   */
  // eslint-disable-next-line class-methods-use-this
  _directionFromCog(cog) {
    if (typeof cog !== 'number' || !Number.isFinite(cog)) {
      return null;
    }
    const normalizedCog = ((cog % 360) + 360) % 360;
    if (normalizedCog >= 315 || normalizedCog <= 45) return 'north';
    if (normalizedCog >= 135 && normalizedCog <= 225) return 'south';
    return null;
  }

  /**
   * Kontrollera om båt+bro meddelande ska blockeras (högre nivå än status)
   * @param {string} vesselId - Vessel MMSI
   * @param {string} bridgeName - Bridge name
   * @param {string} messageType - 'approaching', 'stallbacka-waiting', 'waiting', 'under-bridge'
   * @returns {boolean} - true om meddelande ska blockeras
   */
  shouldBlockMessage(vesselId, bridgeName, messageType) {
    // Särskild logik för Stallbackabron temporal paradox
    if (bridgeName === 'Stallbackabron' && (messageType === 'approaching' || messageType === 'stallbacka-waiting')) {
      return this.shouldBlockStatus(vesselId, bridgeName, messageType);
    }

    // Standard logik för andra broar
    return this.shouldBlockStatus(vesselId, bridgeName, messageType);
  }

  /**
   * Rensa latch för en specifik båt+bro (används vid valid återgång)
   * @param {string} vesselId - Vessel MMSI
   * @param {string} bridgeName - Bridge name
   */
  clearLatch(vesselId, bridgeName) {
    const vesselLatches = this._passageLatches.get(vesselId);
    if (vesselLatches && vesselLatches.has(bridgeName)) {
      vesselLatches.delete(bridgeName);
      this.logger.debug(`🔓 [PASSAGE_LATCH] ${vesselId}: Cleared latch for ${bridgeName}`);
    }
  }

  /**
   * Rensa alla latches för en vessel (används vid GPS jump recovery)
   * @param {string} vesselId - Vessel MMSI
   * @param {string} reason - Anledning till clearing
   */
  clearVesselLatches(vesselId, reason = 'unknown') {
    if (this._passageLatches.has(vesselId)) {
      const latchCount = this._passageLatches.get(vesselId).size;
      this._passageLatches.delete(vesselId);
      this.logger.debug(`🔓 [PASSAGE_LATCH] ${vesselId}: Cleared ${latchCount} latches (reason: ${reason})`);
    }
  }

  /**
   * GPS Jump hantering - kan rensa eller behålla latches beroende på hopp-typ
   * @param {string} vesselId - Vessel MMSI
   * @param {number} jumpDistance - Distance of GPS jump in meters
   * @param {object} vessel - Vessel data
   */
  handleGPSJump(vesselId, jumpDistance, vessel) {
    // För mycket stora GPS jumps (>1000m), rensa alla latches
    if (jumpDistance > 1000) {
      this.clearVesselLatches(vesselId, `large_gps_jump_${jumpDistance}m`);
      return;
    }

    // För mindre GPS jumps, behåll latches men logga
    this.logger.debug(`🔒 [PASSAGE_LATCH] ${vesselId}: GPS jump ${jumpDistance}m - maintaining latches for stability`);
  }

  /**
   * Rensa expired latches (periodisk cleanup)
   * @private
   */
  _cleanupExpiredLatches() {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [vesselId, vesselLatches] of this._passageLatches.entries()) {
      const expiredBridges = [];

      for (const [bridgeName, latchData] of vesselLatches.entries()) {
        const age = now - latchData.timestamp;
        if (age > this._latchTimeout) {
          expiredBridges.push(bridgeName);
        }
      }

      // Rensa expired latches
      for (const bridgeName of expiredBridges) {
        vesselLatches.delete(bridgeName);
        cleanedCount++;
      }

      // Rensa tomma vessel entries
      if (vesselLatches.size === 0) {
        this._passageLatches.delete(vesselId);
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`🧹 [PASSAGE_LATCH] Cleaned ${cleanedCount} expired latches`);
    }
  }

  /**
   * Få status för debugging
   */
  getStatus() {
    const vesselCount = this._passageLatches.size;
    let totalLatches = 0;

    for (const vesselLatches of this._passageLatches.values()) {
      totalLatches += vesselLatches.size;
    }

    return {
      vesselCount,
      totalLatches,
      latches: Array.from(this._passageLatches.entries()).map(([vesselId, vesselLatches]) => ({
        vesselId,
        bridges: Array.from(vesselLatches.entries()).map(([bridgeName, latchData]) => ({
          bridgeName,
          direction: latchData.direction,
          age: Date.now() - latchData.timestamp,
        })),
      })),
    };
  }

  /**
   * Cleanup vid service shutdown
   */
  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }

    this._passageLatches.clear();
    this.logger.debug('🔒 [PASSAGE_LATCH] Service destroyed');
  }
}

module.exports = PassageLatchService;
