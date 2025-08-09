'use strict';

const { APPROACH_RADIUS, APPROACHING_RADIUS } = require('../constants');
const geometry = require('../utils/geometry');
const StallbackabronHelper = require('../utils/StallbackabronHelper');
const {
  isValidETA, isInvalidETA, formatETA, etaDisplay,
} = require('../utils/etaValidation');

/**
 * BridgeTextService - Isolated, testable bridge text generation
 * Pure business logic for creating bridge status messages
 */
class BridgeTextService {
  constructor(bridgeRegistry, logger) {
    this.bridgeRegistry = bridgeRegistry;
    this.logger = logger;
    this.stallbackabronHelper = new StallbackabronHelper(bridgeRegistry, logger);
  }

  /**
   * Generate bridge text from vessel data
   * @param {Object[]} vessels - Array of relevant vessel objects
   * @returns {string} Human-readable bridge status message
   */
  generateBridgeText(vessels) {
    this.logger.debug(
      `🎯 [BRIDGE_TEXT] Generating bridge text for ${vessels?.length || 0} vessels`,
    );

    if (!vessels || vessels.length === 0) {
      this.logger.debug('❌ [BRIDGE_TEXT] No relevant vessels - returning default message');
      return 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
    }

    // Filter out null/undefined entries
    const validVessels = vessels.filter((vessel) => vessel != null);
    if (validVessels.length === 0) {
      this.logger.debug('❌ [BRIDGE_TEXT] All vessels were null/undefined - returning default message');
      return 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
    }

    // Log vessel information
    this._logVesselDetails(validVessels);

    // Group vessels by target bridge
    const groups = this._groupByTargetBridge(validVessels);
    const phrases = [];

    this.logger.debug(
      `🏗️ [BRIDGE_TEXT] Grouped vessels into ${Object.keys(groups).length} target bridges:`,
      Object.keys(groups),
    );

    // Generate phrase for each bridge group
    for (const [bridgeName, groupVessels] of Object.entries(groups)) {
      if (!bridgeName || bridgeName === 'undefined' || bridgeName === 'null') {
        this.logger.debug(`⚠️ [BRIDGE_TEXT] Skipping invalid bridgeName: ${bridgeName}`);
        continue;
      }

      this.logger.debug(
        `🔨 [BRIDGE_TEXT] Creating phrase for ${bridgeName} with ${groupVessels.length} vessels`,
      );

      const phrase = this._generatePhraseForBridge(bridgeName, groupVessels);
      if (phrase) {
        this.logger.debug(`✅ [BRIDGE_TEXT] Phrase created: "${phrase}"`);
        phrases.push(phrase);
      } else {
        this.logger.debug(`❌ [BRIDGE_TEXT] No phrase created for ${bridgeName}`);
      }
    }

    const finalText = this._combinePhrases(phrases, groups);
    this.logger.debug(`🎯 [BRIDGE_TEXT] Final message: "${finalText}"`);

    return finalText;
  }

  /**
   * Calculate passage window for "just passed" messages
   * @param {Object} vessel - Vessel object
   * @returns {number} Window in milliseconds
   */
  calculatePassageWindow(vessel) {
    try {
      const speed = vessel.sog || 3; // Default to 3kn if no speed data
      const [lastPassedBridge] = vessel.passedBridges?.slice(-1) || [];
      const { targetBridge } = vessel;

      if (!lastPassedBridge || !targetBridge) {
        // Fallback to old system
        return speed > 5 ? 120000 : 60000; // 2min fast, 1min slow
      }

      // Convert both bridge names to IDs for consistent gap lookup
      const targetBridgeId = this.bridgeRegistry.findBridgeIdByName(targetBridge);
      const lastPassedBridgeId = this.bridgeRegistry.findBridgeIdByName(lastPassedBridge);

      if (!targetBridgeId || !lastPassedBridgeId) {
        this.logger.debug(
          `⚠️ [PASSAGE_TIMING] Could not find bridge IDs - target: ${targetBridge}/${targetBridgeId}, passed: ${lastPassedBridge}/${lastPassedBridgeId} - using fallback`,
        );
        return speed > 5 ? 120000 : 60000;
      }

      const gap = this.bridgeRegistry.getDistanceBetweenBridges(lastPassedBridgeId, targetBridgeId) || 800;

      // Calculate realistic travel time + safety margin
      const speedMps = (speed * 1852) / 3600; // Convert knots to m/s
      const travelTimeMs = (gap / speedMps) * 1000; // Travel time in milliseconds
      const timeWindow = travelTimeMs * 1.5; // Add 50% safety margin

      // Enforce reasonable bounds: minimum 90s (1.5min), maximum 300s (5min)
      const boundedWindow = Math.min(Math.max(timeWindow, 90000), 300000);

      this.logger.debug(
        `🕒 [PASSAGE_TIMING] ${vessel.mmsi}: ${lastPassedBridge}-${targetBridgeId} gap=${gap}m, `
        + `speed=${speed.toFixed(1)}kn, window=${(boundedWindow / 1000).toFixed(1)}s`,
      );

      return boundedWindow;
    } catch (timingError) {
      this.logger.error(
        `⚠️ [PASSAGE_TIMING] Calculation failed for ${vessel.mmsi}:`,
        timingError.message,
      );
      return vessel.sog > 5 ? 120000 : 60000;
    }
  }

  /**
   * Log detailed vessel information
   * @private
   */
  _logVesselDetails(vessels) {
    vessels.forEach((vessel, index) => {
      this.logger.debug(`🚢 [BRIDGE_TEXT] Vessel ${index + 1}/${vessels.length}:`, {
        mmsi: vessel.mmsi,
        currentBridge: vessel.currentBridge,
        targetBridge: vessel.targetBridge,
        etaMinutes: etaDisplay(vessel.etaMinutes),
        isWaiting: vessel.isWaiting,
        confidence: vessel.confidence,
        distance: typeof vessel.distance === 'number'
          ? `${vessel.distance.toFixed(0)}m`
          : vessel.distance,
        status: vessel.status,
      });
    });
  }

  /**
   * Group vessels by target bridge
   * @private
   */
  _groupByTargetBridge(vessels) {
    const groups = {};
    let skippedVessels = 0;

    for (const vessel of vessels) {
      if (!vessel) {
        skippedVessels++;
        continue;
      }

      let target = vessel.targetBridge;

      // CRITICAL FIX: Under-bridge vessels without targetBridge should use currentBridge
      if (!target && vessel.status === 'under-bridge' && vessel.currentBridge) {
        target = vessel.currentBridge;
        this.logger.debug(
          `🌉 [BRIDGE_TEXT] Under-bridge vessel ${vessel.mmsi} without targetBridge - using currentBridge: ${target}`,
        );
      }

      if (!target) {
        // BUGFIX: Fallback logic to prevent vessel count mismatches

        // Fallback 1: Use currentBridge if available
        if (vessel.currentBridge) {
          target = vessel.currentBridge;
          this.logger.debug(
            `🔄 [BRIDGE_TEXT_FALLBACK] ${vessel.mmsi}: Using currentBridge fallback -> ${target}`,
          );
        } else if (vessel.lastPassedBridge && vessel.status === 'passed') {
        // Fallback 2: Use lastPassedBridge for recently passed vessels
          target = vessel.lastPassedBridge;
          this.logger.debug(
            `🔄 [BRIDGE_TEXT_FALLBACK] ${vessel.mmsi}: Using lastPassedBridge fallback -> ${target}`,
          );
        } else {
          // No fallback available - skip vessel
          this.logger.debug(
            `⚠️ [BRIDGE_TEXT] Skipped vessel ${vessel.mmsi} - no bridge context available `
            + `(targetBridge: ${vessel.targetBridge}, currentBridge: ${vessel.currentBridge}, `
            + `lastPassedBridge: ${vessel.lastPassedBridge})`,
          );
          skippedVessels++;
          continue;
        }
      }

      if (!groups[target]) {
        groups[target] = [];
        this.logger.debug(`🆕 [BRIDGE_TEXT] Created new group for target bridge: ${target}`);
      }
      groups[target].push(vessel);
    }

    this.logger.debug('📊 [BRIDGE_TEXT] Grouping complete:', {
      totalVessels: vessels.length,
      skippedVessels,
      groups: Object.keys(groups).map((bridge) => ({
        bridge,
        vesselCount: groups[bridge].length,
        mmsis: groups[bridge].map((v) => v.mmsi),
      })),
    });

    return groups;
  }

  /**
   * Generate phrase for a specific bridge
   * @private
   */
  _generatePhraseForBridge(bridgeName, vessels) {
    this.logger.debug(
      `🏗️ [BRIDGE_TEXT] Generating phrase for ${bridgeName} with ${vessels?.length || 0} vessels`,
    );

    if (!vessels || vessels.length === 0) {
      this.logger.debug(`❌ [BRIDGE_TEXT] No vessels for ${bridgeName} - returning null`);
      return null;
    }

    // Validate and sanitize vessel data
    const validVessels = this._validateVessels(vessels);
    if (validVessels.length === 0) {
      this.logger.debug(
        `❌ [BRIDGE_TEXT] All vessels were invalid for ${bridgeName} - returning null`,
      );
      return null;
    }

    // Find the highest priority vessel
    const priorityVessel = this._findPriorityVessel(validVessels);
    if (!priorityVessel) {
      this.logger.debug(`❌ [BRIDGE_TEXT] Could not find priority vessel for ${bridgeName}`);
      return null;
    }

    const count = validVessels.length;
    // CRITICAL FIX: Ensure eta is never undefined to prevent "undefinedmin"
    const eta = this._formatETA(priorityVessel.etaMinutes, priorityVessel.isWaiting) || null;

    this._logPhraseStats(bridgeName, validVessels, priorityVessel, eta);

    // Try different phrase types in order of priority
    let phrase;

    // 1. HIGHEST PRIORITY: Recently passed another bridge (1 minute window)
    phrase = this._tryRecentlyPassedPhrase(priorityVessel, bridgeName, count, eta);
    if (phrase) {
      this.logger.debug(`🏆 [BRIDGE_TEXT] Using "precis passerat" phrase: "${phrase}"`);
      return phrase;
    }

    // 2. At intermediate bridge (waiting at non-target bridge)
    phrase = this._tryIntermediateBridgePhrase(priorityVessel, bridgeName, count, eta);
    if (phrase) {
      this.logger.debug(`🌉 [BRIDGE_TEXT] Using intermediate bridge phrase: "${phrase}"`);
      return phrase;
    }

    // 3. Standard single/multiple vessel phrases (approaching, waiting, under-bridge)
    const standardPhrase = this._generateStandardPhrase(bridgeName, validVessels, priorityVessel, count, eta);
    this.logger.debug(`⚓ [BRIDGE_TEXT] Using standard phrase: "${standardPhrase}"`);
    return standardPhrase;
  }

  /**
   * Validate vessels and fix common issues
   * @private
   */
  _validateVessels(vessels) {
    return vessels.filter((vessel) => {
      if (!vessel || !vessel.mmsi) {
        this.logger.debug('⚠️ [BRIDGE_TEXT] Skipping vessel without MMSI or null vessel');
        return false;
      }
      if (!vessel.targetBridge) {
        // BUGFIX: Apply same fallback logic as in grouping
        if (vessel.currentBridge || (vessel.lastPassedBridge && vessel.status === 'passed')) {
          this.logger.debug(`🔄 [BRIDGE_TEXT_VALIDATION] ${vessel.mmsi}: Allowing vessel with fallback bridge context`);
          // Allow vessel to continue - fallback bridge available
        } else {
          this.logger.debug(`⚠️ [BRIDGE_TEXT] Skipping vessel ${vessel.mmsi} without targetBridge or fallback context`);
          return false;
        }
      }
      if (isInvalidETA(vessel.etaMinutes)) {
        this.logger.debug(`⚠️ [BRIDGE_TEXT] Fixing invalid ETA for vessel ${vessel.mmsi} (was: ${vessel.etaMinutes})`);
        vessel.etaMinutes = null; // Set to null for consistent handling
      }
      return true;
    });
  }

  /**
   * Find the highest priority vessel (ledande båt = närmast målbro)
   * Enhanced priority resolution according to bridgeTextFormat.md V2.0
   * @private
   */
  _findPriorityVessel(vessels) {
    return vessels.reduce((current, vessel) => {
      if (!current) return vessel;

      // Status-based priority according to bridgeTextFormat.md V2.0
      const statusPriority = {
        passed: 6, // 1. Passed (precis passerat) - HÖGSTA PRIORITET
        'under-bridge': 5, // 2. Under-bridge (<50m) - broöppning pågår
        waiting: 4, // 3. Waiting (<300m) - inväntar broöppning
        'stallbacka-waiting': 3, // 4. Stallbacka-waiting (<300m) - åker strax under
        approaching: 2, // 5. Approaching (<500m) - närmar sig
        'en-route': 1, // 6. En-route (>500m) - på väg mot (lägsta prioritet)
      };

      const currentPriority = statusPriority[current.status] || 0;
      const vesselPriority = statusPriority[vessel.status] || 0;

      // ENHANCED: Log priority comparison for debugging
      this.logger.debug(
        `🔍 [PRIORITY_ENHANCED] ${vessel.mmsi} (${vessel.status}, p=${vesselPriority}) vs ${current.mmsi} (${current.status}, p=${currentPriority})`,
      );

      // Priority by status first
      if (vesselPriority !== currentPriority) {
        const winner = vesselPriority > currentPriority ? vessel : current;
        this.logger.debug(
          `✅ [PRIORITY_WINNER] ${winner.mmsi} wins on status priority (${winner.status})`,
        );
        return winner;
      }

      // Among similar status vessels, choose closest to target bridge
      const currentDistance = this._getDistanceToTargetBridge(current);
      const vesselDistance = this._getDistanceToTargetBridge(vessel);

      if (currentDistance !== null && vesselDistance !== null) {
        const winner = vesselDistance < currentDistance ? vessel : current;
        this.logger.debug(
          `✅ [PRIORITY_WINNER] ${winner.mmsi} wins on distance (${winner === vessel ? vesselDistance.toFixed(0) : currentDistance.toFixed(0)}m)`,
        );
        return winner;
      }

      // Fallback: Use ETA comparison if available
      if (vessel.etaMinutes != null && current.etaMinutes != null) {
        const winner = vessel.etaMinutes < current.etaMinutes ? vessel : current;
        this.logger.debug(
          `✅ [PRIORITY_WINNER] ${winner.mmsi} wins on ETA (${winner.etaMinutes?.toFixed(1)}min)`,
        );
        return winner;
      }

      this.logger.debug(`✅ [PRIORITY_WINNER] ${current.mmsi} wins by default (no comparison possible)`);
      return current;
    });
  }

  /**
   * Get distance to target bridge (for priority calculation)
   * Uses geometry utility for consistent distance calculations
   * @private
   * @param {Object} vessel - Vessel object with lat, lon, targetBridge
   * @returns {number|null} Distance in meters to target bridge, or null if cannot calculate
   */
  _getDistanceToTargetBridge(vessel) {
    try {
      // Validate vessel data (use Number.isFinite to properly handle lat/lon=0)
      if (!vessel || !Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
        this.logger.debug(
          `⚠️ [DISTANCE_CALC] ${vessel?.mmsi || 'unknown'}: Missing or invalid vessel position data`,
        );
        return null;
      }

      // BUGFIX: Use fallback bridge if no targetBridge
      let bridgeName = vessel.targetBridge;
      if (!bridgeName) {
        if (vessel.currentBridge) {
          bridgeName = vessel.currentBridge;
          this.logger.debug(`🔄 [DISTANCE_CALC] ${vessel.mmsi}: Using currentBridge fallback for distance: ${bridgeName}`);
        } else if (vessel.lastPassedBridge && vessel.status === 'passed') {
          bridgeName = vessel.lastPassedBridge;
          this.logger.debug(`🔄 [DISTANCE_CALC] ${vessel.mmsi}: Using lastPassedBridge fallback for distance: ${bridgeName}`);
        } else {
          this.logger.debug(`⚠️ [DISTANCE_CALC] ${vessel.mmsi}: No bridge context available for distance calculation`);
          return null;
        }
      }

      // Validate coordinates are numbers
      if (!Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
        this.logger.debug(
          `⚠️ [DISTANCE_CALC] ${vessel.mmsi}: Invalid vessel coordinates`,
        );
        return null;
      }

      // Get bridge from registry (using fallback bridgeName)
      const targetBridge = this.bridgeRegistry.getBridgeByName(bridgeName);
      if (!targetBridge) {
        this.logger.debug(
          `⚠️ [DISTANCE_CALC] ${vessel.mmsi}: Bridge '${bridgeName}' not found in registry`,
        );
        return null;
      }

      // Use consistent geometry utility for distance calculation
      const distance = geometry.calculateDistance(
        vessel.lat, vessel.lon,
        targetBridge.lat, targetBridge.lon,
      );

      // Validate distance result
      if (!Number.isFinite(distance) || distance < 0) {
        this.logger.debug(
          `⚠️ [DISTANCE_CALC] ${vessel.mmsi}: Invalid distance calculation result`,
        );
        return null;
      }

      this.logger.debug(
        `📏 [DISTANCE_CALC] ${vessel.mmsi}: Distance to ${bridgeName} = ${distance.toFixed(0)}m`,
      );

      return distance;
    } catch (error) {
      this.logger.error(
        `❌ [DISTANCE_CALC] ${vessel?.mmsi || 'unknown'}: Distance calculation failed:`,
        error.message,
      );
      return null;
    }
  }

  /**
   * Log phrase statistics
   * @private
   */
  _logPhraseStats(bridgeName, vessels, priorityVessel, eta) {
    const waiting = vessels.filter((v) => v.status === 'waiting' || v.isWaiting).length;
    const underBridge = vessels.filter((v) => v.status === 'under-bridge').length;

    this.logger.debug(`📈 [BRIDGE_TEXT] Phrase stats for ${bridgeName}:`, {
      totalVessels: vessels.length,
      waitingVessels: waiting,
      underBridgeVessels: underBridge,
      priorityVessel: {
        mmsi: priorityVessel.mmsi,
        status: priorityVessel.status,
        etaMinutes: etaDisplay(priorityVessel.etaMinutes),
        isWaiting: priorityVessel.isWaiting,
        confidence: priorityVessel.confidence,
        currentBridge: priorityVessel.currentBridge,
      },
      formattedETA: eta,
    });
  }

  /**
   * Try to create a "recently passed" phrase
   * @private
   */
  _tryRecentlyPassedPhrase(vessel, bridgeName, count, eta) {
    // Check if vessel has recently passed a bridge within 1 minute window
    if (vessel.status === 'passed' && vessel.lastPassedBridge && this._hasRecentlyPassed(vessel)) {
      const lastPassedBridge = this._getLastPassedBridge(vessel);
      if (lastPassedBridge) {
        return this._generatePassedMessage(vessel, lastPassedBridge, bridgeName, count, eta);
      }
    }
    return null;
  }

  /**
   * Check if vessel has recently passed a bridge (1 minute window)
   * @private
   */
  _hasRecentlyPassed(vessel) {
    // Check if vessel passed within 60 seconds
    if (!vessel.lastPassedBridgeTime) {
      return false;
    }

    const timeSincePassed = Date.now() - vessel.lastPassedBridgeTime;
    const oneMinute = 60000; // 60 seconds

    return timeSincePassed <= oneMinute;
  }

  /**
   * Get name of last passed bridge
   * @private
   */
  _getLastPassedBridge(vessel) {
    // Use the direct lastPassedBridge property set by VesselDataService
    return vessel.lastPassedBridge || null;
  }

  /**
   * Generate "precis passerat" message according to new rules
   * @private
   */
  _generatePassedMessage(vessel, lastPassedBridge, targetBridge, count, eta) {
    // NEW RULES:
    // Målbro: "En båt har precis passerat [målbro] på väg mot [nästa målbro], beräknad broöppning om X"
    // Mellanbro: "En båt har precis passerat [mellanbro] på väg mot [målbro], beräknad broöppning om X"
    // ALL bridges now use the same format with robust ETA calculation

    const isLastPassedTargetBridge = (lastPassedBridge === 'Klaffbron' || lastPassedBridge === 'Stridsbergsbron');

    // FIXED: Use specialized ETA for all "precis passerat" messages
    const passedETA = this._formatPassedETA(vessel);
    const etaSuffix = passedETA ? `, beräknad broöppning ${passedETA}` : '';

    let phrase;
    if (count === 1) {
      if (isLastPassedTargetBridge) {
        // Passed target bridge: only show if vessel gets new target bridge
        if (vessel.targetBridge && vessel.targetBridge !== lastPassedBridge) {
          phrase = `En båt har precis passerat ${lastPassedBridge} på väg mot ${vessel.targetBridge}${etaSuffix}`;
        } else {
          // No new target bridge = disappears from message (return null)
          return null;
        }
      } else {
        // Passed intermediate bridge (including Stallbackabron)
        phrase = `En båt har precis passerat ${lastPassedBridge} på väg mot ${vessel.targetBridge}${etaSuffix}`;
      }
    } else {
      // Multiple vessels - leading boat passed, others following
      const additionalCount = count - 1;
      const additionalText = additionalCount === 1
        ? 'ytterligare 1 båt på väg'
        : `ytterligare ${additionalCount} båtar på väg`;

      phrase = `En båt har precis passerat ${lastPassedBridge} på väg mot ${vessel.targetBridge}, ${additionalText}${etaSuffix}`;
    }

    this.logger.debug(
      `🚢✨ [BRIDGE_TEXT] Precis passerat: ${vessel.mmsi} from ${lastPassedBridge} to ${targetBridge} (${count} vessels total) ${lastPassedBridge === 'Stallbackabron' ? '[STALLBACKA_SPECIAL]' : ''}`,
    );

    return phrase;
  }

  /**
   * Try to create an "intermediate bridge" phrase
   * @private
   */
  _tryIntermediateBridgePhrase(vessel, bridgeName, count, eta) {
    if (
      vessel.currentBridge
      && vessel.currentBridge !== bridgeName
      && Number.isFinite(vessel.distanceToCurrent) && vessel.distanceToCurrent <= APPROACH_RADIUS
    ) {
      // STALLBACKABRON SPECIAL: Override intermediate bridge logic with special messages
      if (vessel.currentBridge === 'Stallbackabron' && vessel.status === 'stallbacka-waiting') {
        this.logger.debug(`🌉 [STALLBACKA_SPECIAL] ${vessel.mmsi}: Overriding intermediate bridge logic for Stallbackabron`);

        // CRITICAL FIX: Only show "på väg mot" if vessel has valid target bridge
        if (vessel.targetBridge && this.bridgeRegistry.isValidTargetBridge(vessel.targetBridge)) {
          const stallbackaETA = this._formatPassedETA(vessel);
          const etaSuffix = stallbackaETA ? `, beräknad broöppning ${stallbackaETA}` : '';
          return `En båt åker strax under Stallbackabron på väg mot ${vessel.targetBridge}${etaSuffix}`;
        }
        // No target bridge - vessel leaving canal
        return 'En båt åker strax under Stallbackabron';

      }

      // Check if vessel is under any intermediate bridge (including Stallbackabron)
      if (vessel.status === 'under-bridge') {
        // STALLBACKABRON SPECIAL: Different message format
        if (vessel.currentBridge === 'Stallbackabron') {
          this.logger.debug(`🌉 [STALLBACKA_SPECIAL] ${vessel.mmsi}: Under Stallbackabron bridge`);

          // CRITICAL FIX: Only show "på väg mot" if vessel has valid target bridge
          if (vessel.targetBridge && this.bridgeRegistry.isValidTargetBridge(vessel.targetBridge)) {
            const stallbackaETA = this._formatPassedETA(vessel);
            const etaSuffix = stallbackaETA ? `, beräknad broöppning ${stallbackaETA}` : '';
            return `En båt passerar Stallbackabron på väg mot ${vessel.targetBridge}${etaSuffix}`;
          }
          // No target bridge - vessel leaving canal
          return 'En båt passerar Stallbackabron';

        }

        // STANDARD INTERMEDIATE BRIDGE: Show "Broöppning pågår vid [intermediate bridge]" with ETA
        this.logger.debug(`🌉 [INTERMEDIATE_UNDER] ${vessel.mmsi}: Under intermediate bridge ${vessel.currentBridge}`);
        const intermediateETA = this._formatPassedETA(vessel);
        const etaSuffix = intermediateETA ? `, beräknad broöppning ${intermediateETA}` : '';
        return `Broöppning pågår vid ${vessel.currentBridge}${etaSuffix}`;
      }

      // PRIORITY FIX: Check if vessel should show waiting at target bridge instead
      if (this._shouldShowWaiting(vessel, bridgeName)) {
        this.logger.debug(`🔄 [PRIORITY_FIX] Vessel ${vessel.mmsi} waiting at target ${bridgeName}, overriding intermediate bridge logic`);
        return this._generateWaitingMessage(vessel, bridgeName, count > 1);
      }

      // CRITICAL FIX: Always calculate ETA for intermediate bridge messages
      // For intermediate bridges, we need ETA to target bridge even if standard eta is null
      const intermediateETA = eta || this._formatPassedETA(vessel);
      let suffix = '';
      if (intermediateETA) {
        if (intermediateETA.includes('inväntar')) {
          suffix = `, ${intermediateETA}`;
        } else {
          suffix = `, beräknad broöppning ${intermediateETA}`;
        }
      }

      let phrase;
      if (count === 1) {
        // Use "inväntar broöppning av" for intermediate bridges when vessel is waiting
        if (vessel.status === 'waiting') {
          phrase = `En båt inväntar broöppning av ${vessel.currentBridge} på väg mot ${bridgeName}${suffix}`;
        } else if (vessel.status === 'passed') {
          // CRITICAL FIX: Recently passed vessels should show standard "på väg mot" message
          phrase = `En båt på väg mot ${bridgeName}${suffix}`;
        } else {
          phrase = `En båt vid ${vessel.currentBridge} närmar sig ${bridgeName}${suffix}`;
        }
      } else {
        const additionalCount = count - 1;
        const additionalText = additionalCount === 1
          ? 'ytterligare 1 båt'
          : `ytterligare ${additionalCount} båtar`;

        if (vessel.status === 'waiting') {
          phrase = `En båt inväntar broöppning av ${vessel.currentBridge} på väg mot ${bridgeName}, ${additionalText} på väg${suffix}`;
        } else if (vessel.status === 'passed') {
          // CRITICAL FIX: Recently passed vessels should show standard "på väg mot" message
          phrase = `En båt på väg mot ${bridgeName}, ${additionalText} på väg${suffix}`;
        } else {
          phrase = `En båt vid ${vessel.currentBridge} närmar sig ${bridgeName}, ${additionalText} på väg${suffix}`;
        }

        this.logger.debug(
          `📊 [BRIDGE_TEXT] Intermediate bridge count: ${count} total, 1 main + ${additionalCount} additional`,
        );
      }

      this.logger.debug(
        `🌉 [BRIDGE_TEXT] Intermediate bridge phrase: ${vessel.mmsi} at ${vessel.currentBridge} to ${bridgeName} (${count} vessels total)`,
      );
      return phrase;
    }

    return null;
  }

  /**
   * Generate standard phrase (single or multiple vessels)
   * @private
   */
  _generateStandardPhrase(bridgeName, vessels, priorityVessel, count, eta) {
    if (count === 1) {
      // Single vessel - NEW PRIORITY ORDER:
      // 1. "Broöppning pågår" (≤50m) - Highest priority
      if (priorityVessel.status === 'under-bridge') {
        const actualBridge = priorityVessel.currentBridge || bridgeName;
        // STALLBACKABRON SPECIAL: Different message for under-bridge
        if (actualBridge === 'Stallbackabron') {
          const targetBridge = priorityVessel.targetBridge || bridgeName;
          const stallbackaETA = this._formatPassedETA(priorityVessel);
          const etaSuffix = stallbackaETA ? `, beräknad broöppning ${stallbackaETA}` : '';
          return `En båt passerar Stallbackabron på väg mot ${targetBridge}${etaSuffix}`;
        }
        return `Broöppning pågår vid ${actualBridge}`;
      }

      // 1.5. STALLBACKABRON SPECIAL: "Åker strax under" (≤300m) - Special priority
      if (priorityVessel.status === 'stallbacka-waiting') {
        // CRITICAL FIX: Only show "på väg mot" if vessel has valid target bridge
        if (priorityVessel.targetBridge && this.bridgeRegistry.isValidTargetBridge(priorityVessel.targetBridge)) {
          const stallbackaETA = this._formatPassedETA(priorityVessel);
          const etaSuffix = stallbackaETA ? `, beräknad broöppning ${stallbackaETA}` : '';
          return `En båt åker strax under Stallbackabron på väg mot ${priorityVessel.targetBridge}${etaSuffix}`;
        }
        // No target bridge - vessel leaving canal
        return 'En båt åker strax under Stallbackabron';

      }

      // 2. "Inväntar broöppning" (≤300m) - Second priority
      if (this._shouldShowWaiting(priorityVessel, bridgeName)) {
        return this._generateWaitingMessage(priorityVessel, bridgeName, false);
      }

      // 3. "På väg mot" (en-route båtar med målbro) - NYTT!
      if (priorityVessel.status === 'en-route' && priorityVessel.targetBridge === bridgeName) {
        // For en-route vessels, always try to calculate ETA even if null
        const enRouteETA = eta || this._formatPassedETA(priorityVessel);
        const etaSuffix = enRouteETA ? `, beräknad broöppning ${enRouteETA}` : '';
        return `En båt på väg mot ${bridgeName}${etaSuffix}`;
      }

      // 3.5. STALLBACKABRON SPECIAL: Detect approaching Stallbackabron as intermediate bridge
      // CRITICAL: This must come BEFORE standard fallback to override target bridge messages
      if (priorityVessel.status === 'approaching') {
        const stallbackabron = this.bridgeRegistry.getBridgeByName('Stallbackabron');
        if (stallbackabron) {
          const distanceToStallbacka = geometry.calculateDistance(
            priorityVessel.lat, priorityVessel.lon,
            stallbackabron.lat, stallbackabron.lon,
          );
          if (distanceToStallbacka <= APPROACHING_RADIUS && distanceToStallbacka > APPROACH_RADIUS) {
            this.logger.debug(`🌉 [STALLBACKA_APPROACHING_TEXT] ${priorityVessel.mmsi}: ${distanceToStallbacka.toFixed(0)}m from Stallbackabron -> showing Stallbackabron message`);
            const targetBridge = priorityVessel.targetBridge || bridgeName;
            const stallbackaETA = this._formatPassedETA(priorityVessel);
            const etaSuffix = stallbackaETA ? `, beräknad broöppning ${stallbackaETA}` : '';
            return `En båt närmar sig Stallbackabron på väg mot ${targetBridge}${etaSuffix}`;
          }
        }
      }

      // 4. "Närmar sig" (standard fallback) - Default
      // CRITICAL FIX: Follow bridgeTextFormat.md rules for approaching messages
      if (this._isTargetBridge(bridgeName)) {
        // Target bridges MUST always show ETA for approaching
        const targetETA = eta || this._formatPassedETA(priorityVessel);
        const etaSuffix = targetETA ? `, beräknad broöppning ${targetETA}` : '';
        return `En båt närmar sig ${bridgeName}${etaSuffix}`;
      }
      // Intermediate bridges: show "på väg mot [målbro]" format
      const targetBridge = priorityVessel.targetBridge || 'okänd målbro';
      const intermediateETA = eta || this._formatPassedETA(priorityVessel);
      const etaSuffix = intermediateETA ? `, beräknad broöppning ${intermediateETA}` : '';
      return `En båt närmar sig ${bridgeName} på väg mot ${targetBridge}${etaSuffix}`;

    }
    // Multiple vessels
    return this._generateMultiVesselPhrase(bridgeName, vessels, priorityVessel, eta);

  }

  /**
   * Generate phrase for multiple vessels
   * @private
   */
  _generateMultiVesselPhrase(bridgeName, vessels, priorityVessel, eta) {
    // NEW RULE: Count vessels that should show "inväntar broöppning" (≤300m)
    const waitingCount = vessels.filter((v) => this._shouldShowWaiting(v, bridgeName)).length;
    const underBridgeCount = vessels.filter((v) => v.status === 'under-bridge').length;
    // STALLBACKABRON SPECIAL: Count vessels with "åker strax under" status
    const stallbackaWaitingCount = vessels.filter((v) => v.status === 'stallbacka-waiting').length;
    // const movingCount = vessels.length - waitingCount - underBridgeCount - stallbackaWaitingCount;

    // Priority 1: Under-bridge (highest priority)
    if (underBridgeCount > 0) {
      const actualBridge = priorityVessel.currentBridge || bridgeName;
      if (underBridgeCount === 1 && vessels.length > 1) {
        const additionalCount = vessels.length - 1;
        const additionalText = additionalCount === 1
          ? 'ytterligare 1 båt på väg'
          : `ytterligare ${additionalCount} båtar på väg`;
        // STALLBACKABRON SPECIAL: Different message for under-bridge
        if (actualBridge === 'Stallbackabron') {
          const targetBridge = priorityVessel.targetBridge || bridgeName;
          const stallbackaETA = this._formatPassedETA(priorityVessel);
          const etaSuffix = stallbackaETA ? `, beräknad broöppning ${stallbackaETA}` : '';
          return `En båt passerar Stallbackabron på väg mot ${targetBridge}, ${additionalText}${etaSuffix}`;
        }
        // CRITICAL FIX: Follow bridgeTextFormat.md rules for under-bridge intermediate bridges
        if (this._isTargetBridge(actualBridge)) {
          return `Broöppning pågår vid ${actualBridge}, ${additionalText}`;
        }
        // Intermediate bridge: show ETA to target bridge
        const targetBridge = priorityVessel.targetBridge || bridgeName;
        const intermediateETA = this._formatPassedETA(priorityVessel);
        const etaSuffix = intermediateETA ? `, beräknad broöppning av ${targetBridge} ${intermediateETA}` : '';
        return `Broöppning pågår vid ${actualBridge}, ${additionalText}${etaSuffix}`;

      }
      // STALLBACKABRON SPECIAL: Different message for under-bridge
      if (actualBridge === 'Stallbackabron') {
        const targetBridge = priorityVessel.targetBridge || bridgeName;
        const stallbackaETA = this._formatPassedETA(priorityVessel);
        const etaSuffix = stallbackaETA ? `, beräknad broöppning ${stallbackaETA}` : '';
        return `En båt passerar Stallbackabron på väg mot ${targetBridge}${etaSuffix}`;
      }
      // CRITICAL FIX: Follow bridgeTextFormat.md rules for single under-bridge
      this.logger.debug(`🔍 [TARGET_CHECK_DEBUG] actualBridge="${actualBridge}", _isTargetBridge=${this._isTargetBridge(actualBridge)}`);
      if (this._isTargetBridge(actualBridge)) {
        this.logger.debug(`🔍 [TARGET_BRIDGE_NO_ETA] Returning "Broöppning pågår vid ${actualBridge}" without ETA`);
        return `Broöppning pågår vid ${actualBridge}`;
      }
      // Intermediate bridge: show ETA to target bridge
      const targetBridge = priorityVessel.targetBridge || bridgeName;
      const intermediateETA = this._formatPassedETA(priorityVessel);
      const etaSuffix = intermediateETA ? `, beräknad broöppning av ${targetBridge} ${intermediateETA}` : '';
      this.logger.debug(`🔍 [INTERMEDIATE_BRIDGE_ETA] Returning "Broöppning pågår vid ${actualBridge}${etaSuffix}"`);
      return `Broöppning pågår vid ${actualBridge}${etaSuffix}`;

    }

    // Priority 1.5: STALLBACKABRON SPECIAL "åker strax under" (≤300m)
    if (stallbackaWaitingCount > 0) {
      if (stallbackaWaitingCount === vessels.length) {
        // All vessels are "åker strax under" Stallbackabron
        const countText = stallbackaWaitingCount === 1 ? 'En båt' : `${stallbackaWaitingCount} båtar`;
        const targetBridge = priorityVessel.targetBridge || bridgeName;
        const stallbackaETA = this._formatPassedETA(priorityVessel);
        const etaSuffix = stallbackaETA ? `, beräknad broöppning ${stallbackaETA}` : '';
        return `${countText} åker strax under Stallbackabron på väg mot ${targetBridge}${etaSuffix}`;
      }
      // Mixed statuses - show leading vessel with others
      const additionalCount = vessels.length - 1;
      const additionalText = additionalCount === 1
        ? 'ytterligare 1 båt på väg'
        : `ytterligare ${additionalCount} båtar på väg`;
      const targetBridge = priorityVessel.targetBridge || bridgeName;
      const stallbackaETA = this._formatPassedETA(priorityVessel);
      const etaSuffix = stallbackaETA ? `, beräknad broöppning ${stallbackaETA}` : '';
      return `En båt åker strax under Stallbackabron på väg mot ${targetBridge}, ${additionalText}${etaSuffix}`;
    }

    // Priority 2: Waiting vessels (≤300m from bridge)
    if (waitingCount > 0) {
      // STALLBACKABRON FIX: Never show "inväntar broöppning" for Stallbackabron
      if (bridgeName === 'Stallbackabron') {
        // Skip waiting messages for Stallbackabron
        // Fall through to approaching/en-route messages
      } else if (waitingCount === vessels.length) {
        // All vessels waiting
        // FIX: Include priorityVessel data for target bridge derivation
        return this._generateWaitingMessage({ ...priorityVessel, count: waitingCount }, bridgeName, waitingCount > 1);
      } else if (bridgeName !== 'Stallbackabron') {
      // STALLBACKABRON FIX: Skip waiting messages for Stallbackabron
        // Some waiting, some moving - NEW RULE: "En båt inväntar broöppning vid [målbro], ytterligare X båtar på väg"
        const additionalCount = vessels.length - 1;
        const additionalText = additionalCount === 1
          ? 'ytterligare 1 båt på väg'
          : `ytterligare ${additionalCount} båtar på väg`;

        const isTargetBridge = bridgeName === 'Klaffbron' || bridgeName === 'Stridsbergsbron';

        if (isTargetBridge) {
          // Target bridge: no ETA shown
          return `En båt inväntar broöppning vid ${bridgeName}, ${additionalText}`;
        }
        // Intermediate bridge: show ETA to target bridge
        const targetBridge = this._deriveTargetBridge(priorityVessel, bridgeName);
        const etaSuffix = eta ? `, beräknad broöppning ${eta}` : '';
        return `En båt inväntar broöppning av ${bridgeName} på väg mot ${targetBridge}, ${additionalText}${etaSuffix}`;
      }

    }

    // Priority 3: En-route vessels (NYTT!)
    const enRouteCount = vessels.filter((v) => v.status === 'en-route' && v.targetBridge === bridgeName).length;
    if (enRouteCount > 0 && eta) {
      if (enRouteCount === vessels.length) {
        // All vessels are en-route
        const countText = enRouteCount === 1 ? 'En båt' : `${enRouteCount} båtar`;
        return `${countText} på väg mot ${bridgeName}, beräknad broöppning ${eta}`;
      }
      // Mixed statuses - show leading en-route vessel
      const additionalCount = vessels.length - 1;
      const additionalText = additionalCount === 1
        ? 'ytterligare 1 båt på väg'
        : `ytterligare ${additionalCount} båtar på väg`;
      return `En båt på väg mot ${bridgeName}, ${additionalText}, beräknad broöppning ${eta}`;

    }

    // Priority 4: All approaching/moving (fallback)
    // CRITICAL FIX: Follow bridgeTextFormat.md rules for multi-vessel approaching
    const additionalCount = vessels.length - 1;
    const additionalText = additionalCount === 1
      ? 'ytterligare 1 båt'
      : `ytterligare ${additionalCount} båtar`;

    if (this._isTargetBridge(bridgeName)) {
      // Target bridges MUST always show ETA for approaching
      const targetETA = eta || this._formatPassedETA(priorityVessel);
      const etaSuffix = targetETA ? `, beräknad broöppning ${targetETA}` : '';
      return `En båt närmar sig ${bridgeName}, ${additionalText} på väg${etaSuffix}`;
    }
    // Intermediate bridges: show "på väg mot [målbro]" format
    const targetBridge = priorityVessel.targetBridge || 'okänd målbro';
    const intermediateETA = eta || this._formatPassedETA(priorityVessel);
    const etaSuffix = intermediateETA ? `, beräknad broöppning ${intermediateETA}` : '';
    return `En båt närmar sig ${bridgeName} på väg mot ${targetBridge}, ${additionalText}${etaSuffix}`;

  }

  /**
   * Format ETA for Stallbackabron messages (ROBUST V3.0 - eliminates 'undefinedmin')
   * @private
   */
  _formatPassedETA(vessel) {
    // For "precis passerat" messages, we want to show ETA even for under-bridge/passed status
    // Try to use existing ETA, or calculate based on position if needed
    let { etaMinutes } = vessel;

    // ROBUST VALIDATION: Check if existing ETA is valid number
    if (isValidETA(etaMinutes)) {
      return formatETA(etaMinutes);
    }

    // If no valid ETA available, try to calculate rough ETA to target bridge
    if (vessel.targetBridge && vessel.lat && vessel.lon) {
      // ROBUST VALIDATION: Ensure all coordinates are valid numbers
      if (!Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
        this.logger.debug(`⚠️ [ETA_FORMAT] ${vessel.mmsi}: Invalid vessel coordinates - lat=${vessel.lat}, lon=${vessel.lon}`);
        return null;
      }

      // Calculate distance to target bridge
      const targetBridge = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
      if (targetBridge && Number.isFinite(targetBridge.lat) && Number.isFinite(targetBridge.lon)) {
        try {
          const distance = geometry.calculateDistance(
            vessel.lat, vessel.lon,
            targetBridge.lat, targetBridge.lon,
          );

          // ROBUST VALIDATION: Ensure distance calculation is valid
          if (!Number.isFinite(distance) || distance <= 0) {
            this.logger.debug(`⚠️ [ETA_FORMAT] ${vessel.mmsi}: Invalid distance calculation (${distance}m)`);
            return null;
          }

          // Use minimum viable speed to avoid division by zero
          const speed = Math.max(vessel.sog || 4, 0.5); // Minimum 0.5 knots, default 4 knots
          const speedMps = (speed * 1852) / 3600; // Convert knots to m/s

          if (speedMps <= 0) {
            this.logger.debug(`⚠️ [ETA_FORMAT] ${vessel.mmsi}: Invalid speed (${speed}kn)`);
            return null;
          }

          const timeSeconds = distance / speedMps;
          etaMinutes = timeSeconds / 60; // Convert to minutes

          // ROBUST VALIDATION: Final check of calculated ETA
          if (!isValidETA(etaMinutes)) {
            this.logger.debug(`⚠️ [ETA_FORMAT] ${vessel.mmsi}: Invalid calculated ETA (${etaMinutes}min)`);
            return null;
          }

          this.logger.debug(`⏰ [ETA_FORMAT] ${vessel.mmsi}: Calculated ETA - distance=${distance.toFixed(0)}m, speed=${speed.toFixed(1)}kn, ETA=${etaMinutes.toFixed(1)}min`);
          return formatETA(etaMinutes);

        } catch (error) {
          this.logger.error(`❌ [ETA_FORMAT] ${vessel.mmsi}: Distance calculation failed:`, error.message);
          return null;
        }
      } else {
        this.logger.debug(`⚠️ [ETA_FORMAT] ${vessel.mmsi}: Target bridge '${vessel.targetBridge}' not found or invalid coordinates`);
      }
    } else {
      this.logger.debug(`⚠️ [ETA_FORMAT] ${vessel.mmsi}: Missing target bridge or vessel coordinates`);
    }

    return null; // Return null if still no valid ETA
  }

  /**
   * Format ETA for display (ROBUST V3.0 - eliminates 'undefinedmin')
   * @private
   */
  _formatETA(etaMinutes, isWaiting) {
    if (isWaiting) {
      return null; // Waiting vessels don't show ETA
    }

    // CRITICAL FIX: Extra safety check to prevent "undefinedmin" issues
    if (etaMinutes === undefined || etaMinutes === null || Number.isNaN(etaMinutes)) {
      this.logger.debug(`⚠️ [ETA_FORMAT_SAFETY] Blocked invalid ETA value: ${etaMinutes}`);
      return null;
    }

    // Use centralized ETA validation utility
    return formatETA(etaMinutes);
  }

  /**
   * Check if vessel should show "inväntar broöppning" message
   * @private
   */
  _shouldShowWaiting(vessel, bridgeName) {
    // NEW RULE: ≤300m from bridge triggers "inväntar broöppning"
    // EXCEPT for Stallbackabron (high bridge, no opening)

    if (bridgeName === 'Stallbackabron') {
      return false; // Stallbackabron NEVER shows "inväntar broöppning"
    }

    // Must have waiting status to show "inväntar broöppning"
    if (vessel.status !== 'waiting') {
      return false;
    }

    // CRITICAL FIX: Check if vessel is waiting at target bridge FIRST (higher priority)
    if (vessel.targetBridge === bridgeName) {
      const targetDistance = this._getDistanceToTargetBridge(vessel);
      if (targetDistance !== null && targetDistance <= APPROACH_RADIUS) {
        this.logger.debug(`🔍 [WAITING_CHECK] ${vessel.mmsi}: waiting at target bridge ${bridgeName} (${targetDistance.toFixed(0)}m)`);
        return true;
      }
    }

    // CRITICAL FIX: Only return true if vessel is actually waiting at the SPECIFIC bridge asked about
    // Check if vessel is waiting at the current bridge (intermediate bridge case)
    if (vessel.currentBridge === bridgeName && Number.isFinite(vessel.distanceToCurrent) && vessel.distanceToCurrent <= APPROACH_RADIUS) {
      this.logger.debug(`🔍 [WAITING_CHECK] ${vessel.mmsi}: waiting at current bridge ${bridgeName} (${vessel.distanceToCurrent?.toFixed(0)}m)`);
      return true;
    }

    this.logger.debug(`🔍 [WAITING_CHECK] ${vessel.mmsi}: NOT waiting at ${bridgeName} - targetBridge: ${vessel.targetBridge}, currentBridge: ${vessel.currentBridge}, status: ${vessel.status}`);
    return false;
  }

  /**
   * Generate waiting message based on bridge type
   * @private
   */
  _generateWaitingMessage(vessel, bridgeName, isMultiple = false) {
    const count = isMultiple ? 'båtar' : 'båt';
    const verb = isMultiple ? 'inväntar' : 'inväntar';

    // Check if this is a target bridge (Klaffbron/Stridsbergsbron)
    const isTargetBridge = bridgeName === 'Klaffbron' || bridgeName === 'Stridsbergsbron';

    if (isTargetBridge) {
      // Target bridge: "En båt inväntar broöppning vid [målbro]" (no ETA)
      const number = isMultiple ? (vessel.count || 'Flera') : 'En';
      return `${number} ${count} ${verb} broöppning vid ${bridgeName}`;
    }
    // Intermediate bridge: "En båt inväntar broöppning av [mellanbro] på väg mot [målbro], beräknad broöppning om X"
    const targetBridge = this._deriveTargetBridge(vessel, bridgeName);
    const eta = this._formatETA(vessel.etaMinutes, false); // ETA to target bridge
    const etaSuffix = eta ? `, beräknad broöppning ${eta}` : '';
    const number = isMultiple ? (vessel.count || 'Flera') : 'En';

    return `${number} ${count} ${verb} broöppning av ${bridgeName} på väg mot ${targetBridge}${etaSuffix}`;

  }

  /**
   * Combine phrases into final message
   * @private
   */
  _combinePhrases(phrases, groups) {
    if (phrases.length === 0) {
      return 'Båtar upptäckta men tid kan ej beräknas';
    }

    if (phrases.length === 1) {
      return phrases[0];
    }

    // NEW RULE: Multiple target bridges separated by semicolon
    // Format: "[Klaffbron-meddelande]; [Stridsbergsbron-meddelande]"
    // Sort deterministically: Klaffbron first, then Stridsbergsbron, then others alphabetically
    const sortedPhrases = phrases.sort((a, b) => {
      let aPriority = 2; // Default priority
      if (a.includes('Klaffbron')) {
        aPriority = 0;
      } else if (a.includes('Stridsbergsbron')) {
        aPriority = 1;
      }

      let bPriority = 2; // Default priority
      if (b.includes('Klaffbron')) {
        bPriority = 0;
      } else if (b.includes('Stridsbergsbron')) {
        bPriority = 1;
      }

      if (aPriority !== bPriority) return aPriority - bPriority;
      return a.localeCompare(b); // Alphabetic for same priority
    });
    return sortedPhrases.join('; ');
  }

  /**
   * Check if bridge is a target bridge (Klaffbron/Stridsbergsbron)
   * @private
   */
  _isTargetBridge(bridgeName) {
    return bridgeName === 'Klaffbron' || bridgeName === 'Stridsbergsbron';
  }

  /**
   * Derive target bridge for vessel when targetBridge is missing
   * @private
   */
  _deriveTargetBridge(vessel, currentBridgeName) {
    // If vessel has targetBridge, use it
    if (vessel.targetBridge) {
      return vessel.targetBridge;
    }

    // Try to derive based on direction and current position
    if (vessel.currentBridge && vessel.cog !== undefined) {
      const currentBridgeId = this.bridgeRegistry.findBridgeIdByName(vessel.currentBridge);
      if (!currentBridgeId) {
        return 'okänd målbro';
      }

      // Determine direction: North (315°-45°) or South (46°-314°)
      const isNorthbound = vessel.cog >= 315 || vessel.cog <= 45;

      if (isNorthbound) {
        // Going north - find next target bridge north
        const nextBridge = this.bridgeRegistry.getNextBridge(currentBridgeId);
        if (nextBridge) {
          const nextBridgeName = this.bridgeRegistry.getNameById(nextBridge);
          if (this._isTargetBridge(nextBridgeName)) {
            return nextBridgeName;
          }
          // Continue looking north for target bridge
          const secondNext = this.bridgeRegistry.getNextBridge(nextBridge);
          if (secondNext) {
            const secondNextName = this.bridgeRegistry.getNameById(secondNext);
            if (this._isTargetBridge(secondNextName)) {
              return secondNextName;
            }
          }
        }
      } else {
        // Going south - find next target bridge south
        const prevBridge = this.bridgeRegistry.getPreviousBridge(currentBridgeId);
        if (prevBridge) {
          const prevBridgeName = this.bridgeRegistry.getNameById(prevBridge);
          if (this._isTargetBridge(prevBridgeName)) {
            return prevBridgeName;
          }
          // Continue looking south for target bridge
          const secondPrev = this.bridgeRegistry.getPreviousBridge(prevBridge);
          if (secondPrev) {
            const secondPrevName = this.bridgeRegistry.getNameById(secondPrev);
            if (this._isTargetBridge(secondPrevName)) {
              return secondPrevName;
            }
          }
        }
      }
    }

    // Fallback
    return 'okänd målbro';
  }

}

module.exports = BridgeTextService;
