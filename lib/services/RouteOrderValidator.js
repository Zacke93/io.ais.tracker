'use strict';

/**
 * RouteOrderValidator - Förhindrar fysiskt omöjliga broordningar
 *
 * SYFTE: Löser problemet där båtar verkar passera broar i fel ordning:
 * - Exempel: Järnvägsbron (00:36) FÖRE Stridsbergsbron (00:37) för söderut-trafik
 * - Blockerar passage-sekvenser som är fysiskt omöjliga
 * - Använder BridgeRegistry för faktiska avstånd och sekvenser
 *
 * FUNKTIONALITET:
 * - Validerar passage-ordning baserat på riktning och brogeografi
 * - Tillåter legitima specialfall (rundningar, vändningar)
 * - Integrerad med GPS-jump gating för robusthet
 */

// const { BRIDGE_GAPS } = require('../constants'); // Currently unused

class RouteOrderValidator {
  constructor(logger, bridgeRegistry) {
    this.logger = logger;
    this.bridgeRegistry = bridgeRegistry;

    // Definiera korrekt broordning för varje riktning
    this._routeSequences = {
      // Söderut: Norr till söder
      south: [
        'Stallbackabron', // Nordligaste
        'Stridsbergsbron',
        'Järnvägsbron',
        'Klaffbron',
        'Olidebron', // Sydligaste
      ],

      // Norrut: Söder till norr
      north: [
        'Olidebron', // Sydligaste
        'Klaffbron',
        'Järnvägsbron',
        'Stridsbergsbron',
        'Stallbackabron', // Nordligaste
      ],
    };

    // Map: vesselId -> passage history
    this._vesselPassageHistory = new Map();

    // Cleanup timer (disabled in test mode to avoid lingering intervals)
    if (process.env.NODE_ENV === 'test' || global.__TEST_MODE__) {
      this._cleanupTimer = null;
      this.logger.debug('🧪 [ROUTE_VALIDATOR] Test mode detected - skipping cleanup timer');
    } else {
      this._cleanupTimer = setInterval(() => {
        this._cleanupOldHistory();
      }, 5 * 60 * 1000); // Var 5:e minut
    }

    this.logger.debug('🗺️ [ROUTE_VALIDATOR] Service initialized');
  }

  /**
   * Validera om en passage är logisk baserat på tidigare passages
   * @param {string} vesselId - Vessel MMSI
   * @param {string} bridgeName - Bridge name som ska passeras
   * @param {object} vessel - Vessel data
   * @returns {object} - Validation result
   */
  validatePassageOrder(vesselId, bridgeName, vessel) {
    const direction = this._determineDirection(vessel.cog);
    const passageHistory = this._getPassageHistory(vesselId);

    // För första passage eller okänd riktning - tillåt alltid
    if (passageHistory.length === 0 || !direction) {
      return {
        valid: true,
        reason: 'first_passage_or_unknown_direction',
        confidence: 1.0,
      };
    }

    const expectedSequence = this._routeSequences[direction];
    if (!expectedSequence) {
      return {
        valid: true,
        reason: 'unknown_direction_sequence',
        confidence: 0.5,
      };
    }

    // Kontrollera om denna passage följer logisk ordning
    const validationResult = this._validateSequenceOrder(
      passageHistory,
      bridgeName,
      expectedSequence,
      vessel,
    );

    // Logga resultatet
    if (validationResult.valid) {
      this.logger.debug(`✅ [ROUTE_VALIDATOR] ${vesselId}: Passage of ${bridgeName} is valid (${validationResult.reason})`);
    } else {
      this.logger.debug(`❌ [ROUTE_VALIDATOR] ${vesselId}: Passage of ${bridgeName} BLOCKED (${validationResult.reason})`);
    }

    return validationResult;
  }

  /**
   * Registrera en bekräftad passage
   * @param {string} vesselId - Vessel MMSI
   * @param {string} bridgeName - Bridge name
   * @param {object} vessel - Vessel data
   */
  registerPassage(vesselId, bridgeName, vessel, evidencedDir = null) {
    if (!this._vesselPassageHistory.has(vesselId)) {
      this._vesselPassageHistory.set(vesselId, []);
    }

    const history = this._vesselPassageHistory.get(vesselId);
    const passageData = {
      bridgeName,
      timestamp: Date.now(),
      // Fable-granskningen 2026-07-10b (G-5): föredra resans låsta riktning —
      // momentan cog i de tvetydiga banden (46–134/226–314°) gav
      // direction=null i historiken, och _hasDirectionChanged kräver truthy
      // lagrad riktning; en äkta sammabro-retur (AKIRA-klassen) föll då till
      // 'sequence_too_far_forward' och blockerades. Samma fallbackkedja som
      // passage-latchen fick i route-latch#1.
      // R2 2026-07-11 (GR2-5): KORSNINGSBEVISET överst — låsen är stale vid
      // U-sväng-i-gap; fel lagrad riktning inverterade vändningsundantaget.
      direction: evidencedDir
        || vessel._finalTargetDirection
        || vessel._routeDirection
        || this._determineDirection(vessel.cog),
      position: {
        lat: vessel.lat,
        lon: vessel.lon,
      },
      // Fixat 2026-07-05: fältet heter sog — vessel.speed finns inte på
      // vessel-objekten (samma fältfälla som S-F1). Värdet läses inte
      // nedströms i dag; lagras för loggning/felsökning av historiken.
      sog: vessel.sog,
    };

    history.push(passageData);

    // Begränsa historik-längd
    if (history.length > 10) {
      history.shift(); // Ta bort äldsta
    }

    this.logger.debug(`📝 [ROUTE_VALIDATOR] ${vesselId}: Registered passage of ${bridgeName} (${history.length} total passages)`);
  }

  /**
   * Rensa passage-historik för vessel (vid stora GPS-hopp eller reset)
   * @param {string} vesselId - Vessel MMSI
   * @param {string} reason - Anledning för clearing
   */
  clearVesselHistory(vesselId, reason = 'unknown') {
    if (this._vesselPassageHistory.has(vesselId)) {
      const historyCount = this._vesselPassageHistory.get(vesselId).length;
      this._vesselPassageHistory.delete(vesselId);
      this.logger.debug(`🧹 [ROUTE_VALIDATOR] ${vesselId}: Cleared ${historyCount} passage entries (reason: ${reason})`);
    }
  }

  /**
   * Validera sekvens-ordning
   * @private
   */
  _validateSequenceOrder(passageHistory, newBridgeName, expectedSequence, vessel) {
    if (passageHistory.length === 0) {
      return { valid: true, reason: 'no_history', confidence: 1.0 };
    }

    // Hitta senaste passage
    const lastPassage = passageHistory[passageHistory.length - 1];
    const lastBridgeIndex = expectedSequence.indexOf(lastPassage.bridgeName);
    const newBridgeIndex = expectedSequence.indexOf(newBridgeName);

    // Om någon bro inte finns i sekvensen - tillåt (eventuellt ny bro)
    if (lastBridgeIndex === -1 || newBridgeIndex === -1) {
      return {
        valid: true,
        reason: 'bridge_not_in_sequence',
        confidence: 0.7,
      };
    }

    // Kontrollera om ny bro är nästa i sekvensen
    const isNextInSequence = newBridgeIndex === lastBridgeIndex + 1;
    // Helgranskning 2026-07-10 (G-1): taket höjt +3 → +4 så hela brokedjan
    // (5 broar, index 0–4) täcks av ETT Class B-glapp. Med +3 blockerades en
    // äkta Olidebron(0) → Stallbackabron(4)-detektering (tre mellanbroar
    // missade i samma glapp) som "sequence_too_far_forward" om båten var
    // snabbare än 30-min-undantaget — en ren pelare 2-missrisk.
    // detectBridgePassage kräver fortfarande äkta linjekorsningsbevis.
    const isValidSkip = newBridgeIndex > lastBridgeIndex + 1 && newBridgeIndex <= lastBridgeIndex + 4;
    const isSameBridge = newBridgeName === lastPassage.bridgeName;

    // Specialfall: Tillåt återgång om mycket tid har passerat (möjlig vändning)
    const timeSinceLastPassage = Date.now() - lastPassage.timestamp;
    const isLongTimeSinceLastPassage = timeSinceLastPassage > 30 * 60 * 1000; // 30 minuter

    // Specialfall: Tillåt om riktning har ändrats drastiskt (möjlig vändning)
    const directionChanged = this._hasDirectionChanged(lastPassage, vessel);

    if (isNextInSequence) {
      return { valid: true, reason: 'next_in_sequence', confidence: 1.0 };
    }

    if (isValidSkip) {
      return { valid: true, reason: 'valid_sequence_skip', confidence: 0.8 };
    }

    if (isSameBridge && timeSinceLastPassage < 60 * 1000) {
      return { valid: false, reason: 'duplicate_passage_too_soon', confidence: 0.9 };
    }

    if (isLongTimeSinceLastPassage) {
      return { valid: true, reason: 'long_time_elapsed_possible_return', confidence: 0.6 };
    }

    if (directionChanged) {
      return { valid: true, reason: 'direction_change_detected', confidence: 0.7 };
    }

    // Backwards i sekvensen - troligen fel
    if (newBridgeIndex < lastBridgeIndex) {
      return {
        valid: false,
        reason: `backwards_sequence_${lastPassage.bridgeName}_to_${newBridgeName}`,
        confidence: 0.9,
      };
    }

    // För långt hopp framåt i sekvensen
    return {
      valid: false,
      reason: 'sequence_too_far_forward',
      confidence: 0.8,
    };
  }

  /**
   * Kontrollera om riktning har ändrats drastiskt
   * @private
   */
  _hasDirectionChanged(lastPassage, currentVessel) {
    // Fixat 2026-07-05: `!currentVessel.cog` behandlade COG exakt 0° (rakt
    // norrut) som saknad kurs — en vändning till nordlig kurs missades och
    // passagen blockerades som bakåtpassage. Number.isFinite släpper igenom 0.
    if (!lastPassage.direction || !Number.isFinite(currentVessel.cog)) {
      return false;
    }

    // FIX: lastPassage.direction är redan 'north'/'south' (string) från registerPassage()
    // Inget behov av att konvertera igen - det skulle returnera null
    const lastDirection = lastPassage.direction;
    const currentDirection = this._determineDirection(currentVessel.cog);

    // Helgranskning 2026-07-10 (G-2): okänd aktuell riktning (null i de
    // tvetydiga COG-banden) är INTE en riktningsändring — tidigare blev
    // 'north' !== null sant och vändningsundantaget godkände passagen INNAN
    // backwards-/too-far-forward-spärrarna hann köra, dvs. säkerhetsnätet
    // var avstängt exakt när riktningen var osäker.
    if (currentDirection === null) {
      return false;
    }
    return lastDirection !== currentDirection;
  }

  /**
   * Bestäm riktning baserat på COG
   * @private
   */
  _determineDirection(cog) {
    if (typeof cog !== 'number' || !Number.isFinite(cog)) {
      return null;
    }

    // Normalisera COG till [0, 360)
    const normalizedCog = ((cog % 360) + 360) % 360;

    // Norrut: 315° till 45° (via 360°/0°)
    if (normalizedCog >= 315 || normalizedCog <= 45) {
      return 'north';
    }

    // Söderut: 135° till <315° — R2 2026-07-11 (GR2-6): A1-1-harmoniserat
    // (SV-kurs 226–314° är NORMAL sydfärd i den NE–SV-orienterade kanalen);
    // det smala 135–225-bandet gav 'okänd' → riktningsbytesundantaget dött
    // för klassen.
    if (normalizedCog >= 135 && normalizedCog < 315) {
      return 'south';
    }

    // Oklart - mellan norrut och söderut
    return null;
  }

  /**
   * Hämta passage-historik för vessel
   * @private
   */
  _getPassageHistory(vesselId) {
    return this._vesselPassageHistory.get(vesselId) || [];
  }

  /**
   * Rensa gammal passage-historik
   * @private
   */
  _cleanupOldHistory() {
    const maxAge = 2 * 60 * 60 * 1000; // 2 timmar
    const now = Date.now();
    let cleanedVessels = 0;
    let cleanedPassages = 0;

    for (const [vesselId, history] of this._vesselPassageHistory.entries()) {
      // Filtrera bort gamla passages
      const validPassages = history.filter((passage) => (now - passage.timestamp) < maxAge);

      if (validPassages.length !== history.length) {
        cleanedPassages += history.length - validPassages.length;

        if (validPassages.length > 0) {
          this._vesselPassageHistory.set(vesselId, validPassages);
        } else {
          this._vesselPassageHistory.delete(vesselId);
          cleanedVessels++;
        }
      }
    }

    if (cleanedVessels > 0 || cleanedPassages > 0) {
      this.logger.debug(`🧹 [ROUTE_VALIDATOR] Cleaned ${cleanedVessels} vessels, ${cleanedPassages} passages`);
    }
  }

  /**
   * Få status för debugging
   */
  getStatus() {
    const vesselCount = this._vesselPassageHistory.size;
    let totalPassages = 0;

    for (const history of this._vesselPassageHistory.values()) {
      totalPassages += history.length;
    }

    return {
      vesselCount,
      totalPassages,
      averagePassagesPerVessel: vesselCount > 0 ? (totalPassages / vesselCount).toFixed(1) : 0,
      vessels: Array.from(this._vesselPassageHistory.entries()).map(([vesselId, history]) => ({
        vesselId,
        passageCount: history.length,
        lastPassage: history.length > 0 ? {
          bridgeName: history[history.length - 1].bridgeName,
          age: Date.now() - history[history.length - 1].timestamp,
        } : null,
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

    this._vesselPassageHistory.clear();
    this.logger.debug('🗺️ [ROUTE_VALIDATOR] Service destroyed');
  }
}

module.exports = RouteOrderValidator;
