'use strict';

const { APPROACH_RADIUS, APPROACHING_RADIUS } = require('../constants');
const geometry = require('../utils/geometry');

/**
 * BridgeTextService - Isolated, testable bridge text generation
 * Pure business logic for creating bridge status messages
 */
class BridgeTextService {
  constructor(bridgeRegistry, logger) {
    this.bridgeRegistry = bridgeRegistry;
    this.logger = logger;
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

      // Convert targetBridge name to bridge ID for consistent gap lookup
      const targetBridgeId = this.bridgeRegistry.findBridgeIdByName(targetBridge);
      if (!targetBridgeId) {
        this.logger.debug(
          `⚠️ [PASSAGE_TIMING] Could not find bridge ID for ${targetBridge} - using fallback`,
        );
        return speed > 5 ? 120000 : 60000;
      }

      const gap = this.bridgeRegistry.getDistanceBetweenBridges(lastPassedBridge, targetBridgeId) || 800;

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
      this.logger.warn(
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
        etaMinutes: typeof vessel.etaMinutes === 'number'
          ? vessel.etaMinutes.toFixed(1)
          : vessel.etaMinutes,
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

      const target = vessel.targetBridge;
      if (!target) {
        this.logger.debug(
          `⚠️ [BRIDGE_TEXT] Skipped vessel ${vessel.mmsi} - missing targetBridge`,
        );
        skippedVessels++;
        continue;
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
    const eta = this._formatETA(priorityVessel.etaMinutes, priorityVessel.isWaiting);

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
        this.logger.debug(`⚠️ [BRIDGE_TEXT] Skipping vessel ${vessel.mmsi} without targetBridge`);
        return false;
      }
      if (vessel.etaMinutes == null || Number.isNaN(vessel.etaMinutes) || !Number.isFinite(vessel.etaMinutes)) {
        this.logger.debug(`⚠️ [BRIDGE_TEXT] Fixing invalid ETA for vessel ${vessel.mmsi} (was: ${vessel.etaMinutes})`);
        vessel.etaMinutes = null; // Set to null for consistent handling
      }
      return true;
    });
  }

  /**
   * Find the highest priority vessel (NEW: ledande båt = närmast målbro)
   * @private
   */
  _findPriorityVessel(vessels) {
    return vessels.reduce((current, vessel) => {
      if (!current) return vessel;

      // Priority 1: "Precis passerat" status beats everything (highest priority)
      if (vessel.status === 'passed') {
        if (current.status !== 'passed') {
          this.logger.debug(
            `🔍 [PRIORITY] Vessel ${vessel.mmsi} (precis passerat) beats ${current.mmsi} (${current.status}) - HIGHEST PRIORITY`,
          );
          return vessel;
        }
      }

      // Priority 2: If current has "precis passerat", keep it
      if (current.status === 'passed' && vessel.status !== 'passed') {
        this.logger.debug(
          `🔍 [PRIORITY] Keeping ${current.mmsi} (precis passerat) over ${vessel.mmsi} (${vessel.status})`,
        );
        return current;
      }

      // Priority 3: Under-bridge beats non-passed vessels
      if (vessel.status === 'under-bridge') {
        if (current.status !== 'under-bridge' && current.status !== 'passed') {
          this.logger.debug(
            `🔍 [PRIORITY] Vessel ${vessel.mmsi} (under-bridge) beats ${current.mmsi} (${current.status})`,
          );
          return vessel;
        }
      }

      // Priority 4: If current is under-bridge (and not passed), keep it
      if (current.status === 'under-bridge' && current.status !== 'passed') {
        if (vessel.status !== 'passed') {
          this.logger.debug(
            `🔍 [PRIORITY] Keeping ${current.mmsi} (under-bridge) over ${vessel.mmsi} (${vessel.status})`,
          );
          return current;
        }
      }

      // NEW RULE: Priority 5: Among similar status vessels, choose closest to TARGET BRIDGE (not just any bridge)
      const currentDistance = this._getDistanceToTargetBridge(current);
      const vesselDistance = this._getDistanceToTargetBridge(vessel);

      if (currentDistance !== null && vesselDistance !== null) {
        const isCloser = vesselDistance < currentDistance;
        this.logger.debug(
          `🔍 [PRIORITY] Distance to target bridge - ${vessel.mmsi}: ${vesselDistance.toFixed(0)}m vs ${current.mmsi}: ${currentDistance.toFixed(0)}m -> ${isCloser ? 'closer' : 'farther'}`,
        );
        return isCloser ? vessel : current;
      }

      // Fallback: Use ETA comparison
      const isCloser = vessel.etaMinutes < current.etaMinutes;
      this.logger.debug(
        `🔍 [PRIORITY] ETA comparison - ${vessel.mmsi}: ${vessel.etaMinutes?.toFixed(1)}min vs ${current.mmsi}: ${current.etaMinutes?.toFixed(1)}min -> ${isCloser ? 'closer' : 'farther'}`,
      );
      return isCloser ? vessel : current;
    });
  }

  /**
   * Get distance to target bridge (for priority calculation)
   * @private
   */

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
        etaMinutes: typeof priorityVessel.etaMinutes === 'number'
          ? priorityVessel.etaMinutes.toFixed(1)
          : priorityVessel.etaMinutes,
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
    // NEW: Check if vessel has recently passed a bridge
    if (vessel.status === 'passed' && vessel.lastPassedBridge) {
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
    // REMOVED: 1-minute hold logic - always return false now
    return false;
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
      && vessel.distanceToCurrent <= APPROACH_RADIUS
    ) {
      // STALLBACKABRON SPECIAL: Override intermediate bridge logic with special messages
      if (vessel.currentBridge === 'Stallbackabron' && vessel.status === 'stallbacka-waiting') {
        this.logger.debug(`🌉 [STALLBACKA_SPECIAL] ${vessel.mmsi}: Overriding intermediate bridge logic for Stallbackabron`);
        const targetBridge = vessel.targetBridge || bridgeName;
        const stallbackaETA = this._formatPassedETA(vessel);
        const etaSuffix = stallbackaETA ? `, beräknad broöppning ${stallbackaETA}` : '';
        return `En båt åker strax under Stallbackabron på väg mot ${targetBridge}${etaSuffix}`;
      }

      // Check if vessel is under any intermediate bridge (including Stallbackabron)
      if (vessel.status === 'under-bridge') {
        // STALLBACKABRON SPECIAL: Different message format
        if (vessel.currentBridge === 'Stallbackabron') {
          this.logger.debug(`🌉 [STALLBACKA_SPECIAL] ${vessel.mmsi}: Under Stallbackabron bridge`);
          const targetBridge = vessel.targetBridge || bridgeName;
          const stallbackaETA = this._formatPassedETA(vessel);
          const etaSuffix = stallbackaETA ? `, beräknad broöppning ${stallbackaETA}` : '';
          return `En båt passerar Stallbackabron på väg mot ${targetBridge}${etaSuffix}`;
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
        const targetBridge = priorityVessel.targetBridge || bridgeName;
        const stallbackaETA = this._formatPassedETA(priorityVessel);
        const etaSuffix = stallbackaETA ? `, beräknad broöppning ${stallbackaETA}` : '';
        return `En båt åker strax under Stallbackabron på väg mot ${targetBridge}${etaSuffix}`;
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
        const stallbackabron = this.bridgeRegistry.getBridge('stallbackabron');
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
      const suffix = eta ? `, beräknad broöppning ${eta}` : '';
      return `En båt närmar sig ${bridgeName}${suffix}`;

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
        return `Broöppning pågår vid ${actualBridge}, ${additionalText}`;
      }
      // STALLBACKABRON SPECIAL: Different message for under-bridge
      if (actualBridge === 'Stallbackabron') {
        const targetBridge = priorityVessel.targetBridge || bridgeName;
        const stallbackaETA = this._formatPassedETA(priorityVessel);
        const etaSuffix = stallbackaETA ? `, beräknad broöppning ${stallbackaETA}` : '';
        return `En båt passerar Stallbackabron på väg mot ${targetBridge}${etaSuffix}`;
      }
      return `Broöppning pågår vid ${actualBridge}`;
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
      if (waitingCount === vessels.length) {
        // All vessels waiting
        return this._generateWaitingMessage({ count: waitingCount }, bridgeName, waitingCount > 1);
      }

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
      const targetBridge = priorityVessel.targetBridge || 'okänd målbro';
      const etaSuffix = eta ? `, beräknad broöppning ${eta}` : '';
      return `En båt inväntar broöppning av ${bridgeName} på väg mot ${targetBridge}, ${additionalText}${etaSuffix}`;

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
    const suffix = eta ? `, beräknad broöppning ${eta}` : '';
    const additionalCount = vessels.length - 1;
    const additionalText = additionalCount === 1
      ? 'ytterligare 1 båt'
      : `ytterligare ${additionalCount} båtar`;
    return `En båt närmar sig ${bridgeName}, ${additionalText} på väg${suffix}`;
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
    if (etaMinutes !== null && etaMinutes !== undefined && Number.isFinite(etaMinutes) && etaMinutes > 0) {
      return this._safeFormatETA(etaMinutes);
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
          if (!Number.isFinite(etaMinutes) || etaMinutes <= 0) {
            this.logger.debug(`⚠️ [ETA_FORMAT] ${vessel.mmsi}: Invalid calculated ETA (${etaMinutes}min)`);
            return null;
          }

          this.logger.debug(`⏰ [ETA_FORMAT] ${vessel.mmsi}: Calculated ETA - distance=${distance.toFixed(0)}m, speed=${speed.toFixed(1)}kn, ETA=${etaMinutes.toFixed(1)}min`);
          return this._safeFormatETA(etaMinutes);

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
   * Safely format ETA value with robust validation
   * @private
   */
  _safeFormatETA(etaMinutes) {
    // ROBUST VALIDATION: Ensure ETA is a finite positive number
    if (!Number.isFinite(etaMinutes) || etaMinutes <= 0) {
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
   * Format ETA for display (ROBUST V3.0 - eliminates 'undefinedmin')
   * @private
   */
  _formatETA(etaMinutes, isWaiting) {
    if (isWaiting) {
      return null; // Waiting vessels don't show ETA
    }

    // ROBUST VALIDATION: Use _safeFormatETA for consistent validation
    return this._safeFormatETA(etaMinutes);
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

    // CRITICAL FIX: Only return true if vessel is actually waiting at the SPECIFIC bridge asked about
    // Check if vessel is waiting at the current bridge (intermediate bridge case)
    if (vessel.currentBridge === bridgeName && vessel.distanceToCurrent <= APPROACH_RADIUS) {
      this.logger.debug(`🔍 [WAITING_CHECK] ${vessel.mmsi}: waiting at current bridge ${bridgeName} (${vessel.distanceToCurrent?.toFixed(0)}m)`);
      return true;
    }

    // Check if vessel is waiting at target bridge
    if (vessel.targetBridge === bridgeName) {
      const targetDistance = this._getDistanceToTargetBridge(vessel);
      if (targetDistance && targetDistance <= APPROACH_RADIUS) {
        this.logger.debug(`🔍 [WAITING_CHECK] ${vessel.mmsi}: waiting at target bridge ${bridgeName} (${targetDistance.toFixed(0)}m)`);
        return true;
      }
    }

    return false;
  }

  /**
   * Get distance to target bridge for vessel
   * @private
   */
  _getDistanceToTargetBridge(vessel) {
    if (!vessel.targetBridge) {
      return null;
    }

    const targetBridge = this.bridgeRegistry.getBridgeByName(vessel.targetBridge);
    if (!targetBridge) {
      return null;
    }

    return geometry.calculateDistance(
      vessel.lat, vessel.lon,
      targetBridge.lat, targetBridge.lon,
    );
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
    const targetBridge = vessel.targetBridge || 'okänd målbro';
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
    return phrases.join('; ');
  }

  /**
   * Calculate distance between two coordinates in meters
   * @private
   */
  _calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const dLat = this._toRadians(lat2 - lat1);
    const dLon = this._toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(this._toRadians(lat1)) * Math.cos(this._toRadians(lat2))
      * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Convert degrees to radians
   * @private
   */
  _toRadians(degrees) {
    return degrees * (Math.PI / 180);
  }
}

module.exports = BridgeTextService;
