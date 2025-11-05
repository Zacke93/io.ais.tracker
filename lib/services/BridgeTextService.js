'use strict';

const {
  APPROACH_RADIUS, APPROACHING_RADIUS, UNDER_BRIDGE_SET_DISTANCE,
  BRIDGE_TEXT_CONSTANTS, BRIDGE_SEQUENCE, TARGET_BRIDGES, INTERMEDIATE_BRIDGES, PASSAGE_TIMING,
} = require('../constants');
const geometry = require('../utils/geometry');
const StallbackabronHelper = require('../utils/StallbackabronHelper');
const MessageBuilder = require('../utils/MessageBuilder');
const ETAFormatter = require('../utils/ETAFormatter');
const CountTextHelper = require('../utils/CountTextHelper');
const {
  isInvalidETA, etaDisplay,
  isValidVesselCoordinates,
} = require('../utils/etaValidation');
const PassageWindowManager = require('../utils/PassageWindowManager');

/**
 * BridgeTextService - Isolated, testable bridge text generation
 * Pure business logic for creating bridge status messages
 */
class BridgeTextService {
  constructor(bridgeRegistry, logger, systemCoordinator = null, vesselDataService = null, passageLatchService = null) {
    this.bridgeRegistry = bridgeRegistry;
    this.logger = logger;

    // REFACTORED: Initialize helper classes for modular message generation
    this.stallbackabronHelper = new StallbackabronHelper(bridgeRegistry, logger);
    this.messageBuilder = new MessageBuilder(logger);
    this.etaFormatter = new ETAFormatter(bridgeRegistry, logger);

    this.systemCoordinator = systemCoordinator;
    this.vesselDataService = vesselDataService;
    this.passageLatchService = passageLatchService;
    this.passageWindowManager = new PassageWindowManager(logger, bridgeRegistry);
    this.lastBridgeText = '';
    this.lastBridgeTextTime = 0;
    this.lastNonDefaultText = '';
    this.lastNonDefaultTextTime = 0;

    // GPS-hopp hysteresis for "precis passerat" messages
    this.lastPassedMessage = null;
    this.lastPassedMessageTime = 0;
  }

  /**
   * Convert number to Swedish text representation
   * REFACTORED: Delegates to CountTextHelper for consistency
   * @param {number} count - Number to convert (1-10 supported, others return string)
   * @returns {string} Swedish text representation of the number
   * @example
   * getCountText(1) // returns "En"
   * getCountText(5) // returns "Fem"
   * getCountText(11) // returns "11"
   */
  getCountText(count) {
    return CountTextHelper.getCountText(count);
  }

  /**
   * Check if vessel is in GPS-hopp coordination state
   * ENHANCED: Robust coordinator guard with type safety and error handling
   * @private
   * @param {Object} vessel - Vessel object
   * @returns {boolean} True if vessel has active GPS coordination
   */
  _isGpsHoppCoordinating(vessel) {
    try {
      // Enhanced type-safe coordinator check
      if (!this.systemCoordinator
          || typeof this.systemCoordinator.hasActiveCoordination !== 'function'
          || !vessel
          || !vessel.mmsi) {
        return false;
      }

      return this.systemCoordinator.hasActiveCoordination(vessel.mmsi);
    } catch (error) {
      this.logger.error(`❌ [COORDINATOR_GUARD] Error checking GPS coordination for ${vessel?.mmsi || 'unknown'}:`, error.message);
      return false; // Fail-safe fallback
    }
  }

  /**
   * Check if "precis passerat" message should be delayed due to GPS-hopp hysteresis
   * @private
   * @param {string} newMessage - New message to check
   * @param {Object} vessel - Vessel object
   * @returns {boolean} True if message should be delayed
   */
  _shouldDelayPassedMessage(newMessage, vessel) {
    if (!this.lastPassedMessage || !this.lastPassedMessageTime) {
      return false;
    }

    const timeSinceLastPassed = Date.now() - this.lastPassedMessageTime;
    const withinHysteresisWindow = timeSinceLastPassed < BRIDGE_TEXT_CONSTANTS.PASSED_HYSTERESIS_MS;
    const isGpsCoordinating = this._isGpsHoppCoordinating(vessel);

    // Only delay if:
    // 1. Within hysteresis window (35s)
    // 2. GPS coordination is active (indicating potential instability)
    // 3. Message is different from last one (indicating a bridge change)
    const shouldDelay = withinHysteresisWindow && isGpsCoordinating && newMessage !== this.lastPassedMessage;

    if (shouldDelay) {
      this.logger.debug(
        `🛡️ [PASSED_HYSTERESIS] ${vessel.mmsi}: Delaying passed message due to GPS-hopp (${(timeSinceLastPassed / 1000).toFixed(1)}s ago, gps=${isGpsCoordinating})`,
      );
    }

    return shouldDelay;
  }

  /**
   * Generate bridge text from vessel data
   * @param {Object[]} vessels - Array of relevant vessel objects
   * @returns {string} Human-readable bridge status message
   */
  generateBridgeText(vessels) {
    try {
      this.logger.debug(
        `🎯 [BRIDGE_TEXT] Generating bridge text for ${vessels?.length || 0} vessels`,
      );

      // GPS JUMP HOLD: Filter out vessels with active GPS jump hold but continue with others
      let gpsHoldActive = false;
      if (this.vesselDataService && vessels && vessels.length > 0) {
        const originalVesselCount = vessels.length;
        vessels = vessels.filter((vessel) => vessel && vessel.mmsi && !this.vesselDataService.hasGpsJumpHold(vessel.mmsi));
        const heldVesselCount = originalVesselCount - vessels.length;

        if (heldVesselCount > 0) {
          gpsHoldActive = true;
          this.logger.debug(
            `🛡️ [GPS_JUMP_HOLD] Excluded ${heldVesselCount} vessels with active GPS jump hold, proceeding with ${vessels.length} vessels`,
          );
        }
      }

      // ENHANCED: Log debouncing but ALWAYS generate correct bridge text
      if (this.systemCoordinator) {
        const debounceCheck = this.systemCoordinator.shouldDebounceBridgeText(vessels || []);
        if (debounceCheck.shouldDebounce) {
          this.logger.debug(
            `⏸️ [BRIDGE_TEXT_DEBOUNCED] Debouncing active - ${debounceCheck.reason} `
            + `(remaining: ${(debounceCheck.remainingTime / 1000).toFixed(1)}s) - but still generating correct text`,
          );
          // Continue processing - debouncing only affects publishing, not generation
        }
      }

      if (!vessels || vessels.length === 0) {
        // GPS HOLD UI BLINK PREVENTION: If vessels were filtered due to GPS hold, return last bridge text
        if (gpsHoldActive && this.lastBridgeText) {
          this.logger.debug('🛡️ [GPS_HOLD_UI_PROTECTION] No vessels after GPS filtering - returning last bridge text to prevent UI blink');
          // Optional preview to ease debugging without flooding logs
          try {
            const preview = (this.lastBridgeText || '').slice(0, 120);
            this.logger.debug(`🛡️ [GPS_HOLD_UI_PREVIEW] ${preview}`);
          } catch (e) { /* noop */ }
          return this.lastBridgeText;
        }

        return this._getNoVesselMessage(gpsHoldActive ? 'gps-hold' : 'empty-input');
      }

      // Filter out null/undefined entries AND vessels with critical missing data
      const validVessels = vessels.filter((vessel) => {
        if (!vessel) return false;
        // CRITICAL: Ensure vessel has minimum required properties
        if (!vessel.mmsi || !vessel.name) {
          this.logger.debug(
            '⚠️ [BRIDGE_TEXT] Skipping vessel with missing critical data: '
            + `mmsi=${vessel.mmsi}, name=${vessel.name}, status=${vessel.status}, `
            + `currentBridge=${vessel.currentBridge}, targetBridge=${vessel.targetBridge}`,
          );
          return false;
        }
        return true;
      });

      // STALLBACKABRON FIX: Enhanced debugging for empty vessels
      if (validVessels.length === 0) {
        this.logger.debug('❌ [BRIDGE_TEXT] All vessels were invalid - detailed analysis:');
        vessels.forEach((vessel, i) => {
          this.logger.debug(`  Vessel ${i}: mmsi=${vessel?.mmsi}, name=${vessel?.name}, status=${vessel?.status}, currentBridge=${vessel?.currentBridge}, targetBridge=${vessel?.targetBridge}`);
        });

        // Check if any vessels were near Stallbackabron
        const stallbackabronVessels = vessels.filter((v) => v?.currentBridge === 'Stallbackabron' || v?.status === 'stallbacka-waiting');
        if (stallbackabronVessels.length > 0) {
          this.logger.debug(`🚨 [STALLBACKABRON_DEBUG] Found ${stallbackabronVessels.length} Stallbackabron vessels but they were filtered out!`);
          stallbackabronVessels.forEach((v) => {
            this.logger.debug(`  Stallbackabron vessel: mmsi=${v?.mmsi}, name=${v?.name}, missing: ${!v?.mmsi ? 'mmsi ' : ''}${!v?.name ? 'name' : ''}`);
          });
        }

        return this._getNoVesselMessage('invalid-vessels');
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

      // Compact summary to reduce burst logs while keeping key context
      try {
        const targets = Object.keys(groups);
        const counts = targets.map((t) => groups[t].length).reduce((a, b) => a + b, 0);
        // choose a lead vessel for quick reference
        const lead = targets.length > 0 && groups[targets[0]] && groups[targets[0]][0]
          ? groups[targets[0]][0]
          : null;
        const leadId = lead ? `${lead.mmsi}${lead.name ? `/${lead.name}` : ''}` : 'n/a';
        this.logger.debug(`📋 [BRIDGE_TEXT_SUMMARY] total=${counts}, targets=[${targets.join(', ')}], lead=${leadId}`);
      } catch (_) { /* best-effort summary */ }

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

      let finalText = this._combinePhrases(phrases, groups);

      if (finalText === BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE && validVessels.length > 0) {
        const leadVessel = validVessels[0];
        const inferredBridge = leadVessel?.targetBridge
          || leadVessel?.currentBridge
          || leadVessel?.lastPassedBridge
          || 'kanalen';
        const emergencyFallback = `En båt är aktiv vid ${inferredBridge}`;
        const fallbackText = this.lastNonDefaultText
          || this.lastBridgeText
          || emergencyFallback;

        this.logger.debug(
          `🛟 [BRIDGE_TEXT_FALLBACK] Generated default text despite ${validVessels.length} vessel(s) `
          + `— falling back to "${fallbackText}"`,
        );

        finalText = fallbackText;
      }

      this.logger.debug(`🎯 [BRIDGE_TEXT] Final message: "${finalText}"`);

      // Store the final text for debouncing
      this._updateLastBridgeText(finalText);

      return finalText;

    } catch (error) {
      this.logger.error('[BRIDGE_TEXT] CRITICAL ERROR during bridge text generation:', error);
      // Return safe fallback to prevent app crash
      const safeText = this.lastBridgeText || BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
      this.logger.debug(`🚨 [BRIDGE_TEXT] Returning safe fallback: "${safeText}"`);
      return safeText;
    }
  }

  /**
   * Calculate passage window for "just passed" messages
   * @deprecated Use PassageWindowManager instead
   * @param {Object} vessel - Vessel object
   * @returns {number} Window in milliseconds
   */
  calculatePassageWindow(vessel) {
    // Delegate to PassageWindowManager for dynamic calculation
    const [lastPassedBridge] = vessel.passedBridges?.slice(-1) || [];
    const { targetBridge } = vessel;
    return this.passageWindowManager.getDynamicPassageWindow(vessel, lastPassedBridge, targetBridge);
  }

  /**
   * Log detailed vessel information
   * @private
   */
  _logVesselDetails(vessels) {
    vessels.forEach((vessel, index) => {
      this.logger.debug(`🚢 [BRIDGE_TEXT] Vessel ${index + 1}/${vessels.length}:`, {
        mmsi: vessel.mmsi,
        name: vessel.name,
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

      let target = vessel.targetBridge || vessel._bridgeTextDerivedTarget;

      // CRITICAL FIX: ONLY use currentBridge for vessels that truly have NO targetBridge
      // Vessels WITH targetBridge should ALWAYS group by targetBridge to maintain ";" separation
      if (!target && ['under-bridge', 'waiting', 'approaching', 'passed', 'stallbacka-waiting'].includes(vessel.status) && vessel.currentBridge) {
        // IMPORTANT: Only for vessels that completely lack targetBridge
        target = vessel.currentBridge;
        this.logger.debug(
          `🌉 [BRIDGE_TEXT] Intermediate bridge vessel ${vessel.mmsi} (${vessel.status}) without targetBridge - using currentBridge: ${target}`,
        );
      }

      if (!target) {
        // CRITICAL FIX: More robust fallback logic with validation

        // Fallback 1: Use currentBridge if available and valid
        if (vessel.currentBridge && typeof vessel.currentBridge === 'string') {
          target = vessel.currentBridge;
          this.logger.debug(
            `🔄 [BRIDGE_TEXT_FALLBACK] ${vessel.mmsi}: Using currentBridge fallback -> ${target}`,
          );
        } else if (vessel.lastPassedBridge && vessel.status === 'passed' && typeof vessel.lastPassedBridge === 'string') {
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

      // CRITICAL FIX: Validate bridge name before creating groups
      // FIX: More robust validation - check for all falsy values and string literals
      if (!target || typeof target !== 'string' || target.trim() === ''
          || target === 'undefined' || target === 'null' || target === 'NaN'
          || target === 'Infinity' || target === '-Infinity') {
        this.logger.debug(`⚠️ [BRIDGE_TEXT] Invalid target bridge name: '${target}' for vessel ${vessel.mmsi}`);
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
    // CRITICAL FIX: Ensure eta is never undefined to prevent "undefinedmin"
    // Always return null instead of undefined for consistency
    const rawEta = this._formatETA(priorityVessel.etaMinutes, priorityVessel.isWaiting);
    // FIX: Simplified check - if rawEta is falsy or a string literal, use null
    const eta = (rawEta && typeof rawEta === 'string' && rawEta !== 'undefined' && rawEta !== 'null') ? rawEta : null;

    this._logPhraseStats(bridgeName, validVessels, priorityVessel, eta);

    // Try different phrase types in order of priority
    let phrase;

    // 1. HIGHEST PRIORITY: Recently passed another bridge (1 minute window)
    phrase = this._tryRecentlyPassedPhrase(priorityVessel, bridgeName, count, eta);
    if (phrase) {
      this.logger.debug(`🏆 [BRIDGE_TEXT] Using "precis passerat" phrase: "${phrase}"`);
      return phrase;
    }

    // CRITICAL FIX: If vessel has recently passed but no new target, return null (no fallback)
    if (this._hasRecentlyPassed(priorityVessel)) {
      this.logger.debug(`🚫 [BRIDGE_TEXT] Vessel ${priorityVessel.mmsi} recently passed but no new target - suppressing message`);
      return null;
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
        // Only log for truly unexpected invalid ETAs (not for null which can be intentional)
        if (vessel.etaMinutes !== null && vessel.etaMinutes !== undefined) {
          this.logger.debug(`⚠️ [BRIDGE_TEXT] Fixing invalid ETA for vessel ${vessel.mmsi} (was: ${vessel.etaMinutes})`);
        }
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
      // Validate vessel data using helper function
      if (!isValidVesselCoordinates(vessel)) {
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

      // Validate distance result - handle null return from geometry.calculateDistance
      if (distance === null || distance === undefined || !Number.isFinite(distance) || distance < 0) {
        this.logger.debug(
          `⚠️ [DISTANCE_CALC] ${vessel.mmsi}: Invalid distance calculation result (${distance})`,
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
   * ENHANCED: ChatGPT's robust approach with 60s window and targetBridge independence
   * @private
   */
  _tryRecentlyPassedPhrase(vessel, bridgeName, count, eta) {
    try {
      // ENHANCED: Check both status=passed AND time window independently (ChatGPT's approach)
      const hasPassedStatus = vessel.status === 'passed';
      const withinTimeWindow = vessel.lastPassedBridge && vessel.lastPassedBridgeTime
        && (Date.now() - vessel.lastPassedBridgeTime) < BRIDGE_TEXT_CONSTANTS.PASSED_WINDOW_MS;
      const withinGraceWindow = this.passageWindowManager.isWithinInternalGracePeriod(vessel);

      this.logger.debug(
        `🔍 [PASSED_CHECK] ${vessel.mmsi}: status=${vessel.status}, hasTime=${!!vessel.lastPassedBridgeTime}, `
        + `window=${withinTimeWindow}, grace=${withinGraceWindow}`,
      );

      if (hasPassedStatus || withinTimeWindow || withinGraceWindow) {
        const lastPassedBridge = this._getLastPassedBridge(vessel);
        if (lastPassedBridge) {
          // CRITICAL: Calculate next bridge independently of current targetBridge (may be 300m-blocked)
          let nextTargetBridge = vessel.targetBridge;

          // If no targetBridge or same as lastPassed, calculate next bridge using helper
          if (!nextTargetBridge || nextTargetBridge === lastPassedBridge) {
            nextTargetBridge = this.getNextBridgeAfter(lastPassedBridge, vessel.cog || 0);
            this.logger.debug(`🎯 [PASSED_NEXT] ${vessel.mmsi}: Calculated next target: ${nextTargetBridge}`);
          }

          if (nextTargetBridge) {
            return this._generatePassedMessage(vessel, lastPassedBridge, nextTargetBridge, count, eta);
          }
        }
      }
      return null;
    } catch (error) {
      this.logger.error(`❌ [PASSED_PHRASE_ERROR] ${vessel?.mmsi || 'unknown'}: Failed to generate passed phrase:`, error.message);
      return null; // Fail-safe fallback
    }
  }

  /**
   * Check if vessel has recently passed a bridge (1 minute window)
   * @private
   */
  _hasRecentlyPassed(vessel) {
    // Use centralized PassageWindowManager for consistent 60s display window
    return this.passageWindowManager.shouldShowRecentlyPassed(vessel);
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
   * Resolve fallback target bridge when vessel.targetBridge is temporarily unavailable.
   * @private
   */
  _resolveFallbackTargetBridge(vessel, lastPassedBridge) {
    if (!lastPassedBridge || !vessel) {
      return null;
    }
    const fallback = this.getNextBridgeAfter(lastPassedBridge, vessel.cog || 0);
    if (fallback) {
      this.logger.debug(
        `🎯 [PASSED_FALLBACK] ${vessel.mmsi}: Using fallback target ${fallback} for ${lastPassedBridge}`,
      );
    }
    return fallback;
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
    const resolvedTargetBridge = targetBridge || vessel.targetBridge || this._resolveFallbackTargetBridge(vessel, lastPassedBridge);

    // FIXED: Use specialized ETA for all "precis passerat" messages
    const passedETA = this._formatPassedETA(vessel);
    const etaSuffix = passedETA ? `, beräknad broöppning ${passedETA}` : '';

    let phrase;
    if (count === 1) {
    if (isLastPassedTargetBridge) {
      if (resolvedTargetBridge && resolvedTargetBridge !== lastPassedBridge) {
        phrase = `En båt har precis passerat ${lastPassedBridge} på väg mot ${resolvedTargetBridge}${etaSuffix}`;
      } else {
        phrase = `En båt har precis passerat ${lastPassedBridge}${etaSuffix}`;
      }
    } else {
      phrase = resolvedTargetBridge
        ? `En båt har precis passerat ${lastPassedBridge} på väg mot ${resolvedTargetBridge}${etaSuffix}`
        : `En båt har precis passerat ${lastPassedBridge}${etaSuffix}`;
    }
    } else {
      // Multiple vessels - leading boat passed, others following
      const additionalCount = count - 1;
      const additionalText = additionalCount === 1
        ? 'ytterligare 1 båt på väg'
        : `ytterligare ${this.getCountText(additionalCount)} båtar på väg`;

      phrase = resolvedTargetBridge
        ? `En båt har precis passerat ${lastPassedBridge} på väg mot ${resolvedTargetBridge}, ${additionalText}${etaSuffix}`
        : `En båt har precis passerat ${lastPassedBridge}, ${additionalText}${etaSuffix}`;
    }

    // GPS-hopp hysteresis: Check if we should delay this message
    if (phrase && this._shouldDelayPassedMessage(phrase, vessel)) {
      this.logger.debug(`🛡️ [PASSED_HYSTERESIS] ${vessel.mmsi}: Using last passed message instead of new one due to GPS instability`);
      return this.lastPassedMessage; // Return previous stable message
    }

    // Store this message for future hysteresis checks
    if (phrase) {
      this.lastPassedMessage = phrase;
      this.lastPassedMessageTime = Date.now();
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
        this.logger.debug(`🌉 [STALLBACKA_SPECIAL] ${vessel.mmsi}: Using centralized Stallbackabron helper`);
        return this._getStallbackabronMessage(vessel, count);
      }

      // Check if vessel is under any intermediate bridge (including Stallbackabron)
      if (vessel.status === 'under-bridge') {
        // STALLBACKABRON SPECIAL: Different message format
        if (vessel.currentBridge === 'Stallbackabron') {
          this.logger.debug(`🌉 [STALLBACKA_SPECIAL] ${vessel.mmsi}: Using centralized Stallbackabron helper`);
          return this._getStallbackabronMessage(vessel, count);
        }

        // STANDARD INTERMEDIATE BRIDGE: Show "Broöppning pågår vid [intermediate bridge]" with ETA to target bridge
        this.logger.debug(`🌉 [INTERMEDIATE_UNDER] ${vessel.mmsi}: Under intermediate bridge ${vessel.currentBridge}`);
        const intermediateETA = this._formatPassedETA(vessel);
        const targetBridge = vessel.targetBridge || bridgeName;
        const etaSuffix = intermediateETA ? `, beräknad broöppning av ${targetBridge} ${intermediateETA}` : '';
        return `Broöppning pågår vid ${vessel.currentBridge}${etaSuffix}`;
      }

      // PRIORITY FIX: Check if vessel should show waiting at target bridge instead
      if (this._shouldShowWaiting(vessel, bridgeName, this._getEffectiveStatus(vessel, bridgeName))) {
        this.logger.debug(`🔄 [PRIORITY_FIX] Vessel ${vessel.mmsi} waiting at target ${bridgeName}, overriding intermediate bridge logic`);
        return this._generateWaitingMessage(vessel, bridgeName, count > 1);
      }

      // CRITICAL FIX: Always provide ETA for intermediate bridge messages, but avoid recalculating
      // massive ETAs when the vessel is waiting (use ProgressiveETA instead).
      let intermediateETA = null;
      if (eta) {
        intermediateETA = eta;
      } else if (vessel.status === 'waiting') {
        intermediateETA = this.etaFormatter.formatETAWithContext(
          { etaMinutes: vessel.etaMinutes, isWaiting: true },
          {
            allowWaiting: true,
            calculateIfMissing: false,
            contextName: 'INTERMEDIATE_WAIT',
          },
        );
      } else {
        intermediateETA = this._formatPassedETA(vessel);
      }
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
        } else if (vessel.currentBridge === 'Stallbackabron') {
          // STALLBACKABRON REFACTORED: Use centralized helper
          return this._getStallbackabronMessage(vessel, count);
        } else if (this._isIntermediateBridge(vessel.currentBridge) && vessel.status === 'waiting') {
          // Only true intermediate bridges (Olidebron, Järnvägsbron) use "vid [bridge]" format while waiting
          phrase = `En båt vid ${vessel.currentBridge} på väg mot ${bridgeName}${suffix}`;
        } else {
          // For target bridges as currentBridge, use standard "på väg mot" format
          phrase = `En båt på väg mot ${bridgeName}${suffix}`;
        }
      } else {
        const additionalCount = count - 1;
        const additionalText = additionalCount === 1
          ? 'ytterligare 1 båt'
          : `ytterligare ${this.getCountText(additionalCount)} båtar`;

        if (vessel.status === 'waiting') {
          phrase = `En båt inväntar broöppning av ${vessel.currentBridge} på väg mot ${bridgeName}, ${additionalText} på väg${suffix}`;
        } else if (vessel.status === 'passed') {
          // CRITICAL FIX: Recently passed vessels should show standard "på väg mot" message
          phrase = `En båt på väg mot ${bridgeName}, ${additionalText} på väg${suffix}`;
        } else if (vessel.currentBridge === 'Stallbackabron') {
          // STALLBACKABRON REFACTORED: Use centralized helper
          return this._getStallbackabronMessage(vessel, count, additionalCount);
        } else if (this._isIntermediateBridge(vessel.currentBridge) && vessel.status === 'waiting') {
          // Only true intermediate bridges (Olidebron, Järnvägsbron) use "vid [bridge]" format while waiting
          phrase = `En båt vid ${vessel.currentBridge} på väg mot ${bridgeName}, ${additionalText} på väg${suffix}`;
        } else {
          // For target bridges as currentBridge, use standard "på väg mot" format
          phrase = `En båt på väg mot ${bridgeName}, ${additionalText} på väg${suffix}`;
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
    const statusForMessage = this._getEffectiveStatus(priorityVessel, bridgeName);

    if (count === 1) {
      // Single vessel - NEW PRIORITY ORDER:
      // 1. "Broöppning pågår" (≤50m) - Highest priority
      if (statusForMessage === 'under-bridge') {
        const prioritizedTarget = priorityVessel.targetBridge || priorityVessel._bridgeTextDerivedTarget;
        const prefersTarget = prioritizedTarget === bridgeName
          || this._isTargetBridge(bridgeName);
        const actualBridge = prefersTarget
          ? bridgeName
          : (priorityVessel.currentBridge || bridgeName);
        // STALLBACKABRON REFACTORED: Use centralized helper
        if (actualBridge === 'Stallbackabron') {
          return this._getStallbackabronMessage(priorityVessel, count);
        }
        // CRITICAL FIX: Handle target vs intermediate bridge for under-bridge status
        if (this._isTargetBridge(actualBridge)) {
          return `Broöppning pågår vid ${actualBridge}`;
        }
        // Intermediate bridge: show ETA to target bridge
        const targetBridge = priorityVessel.targetBridge || bridgeName;
        const intermediateETA = this._formatPassedETA(priorityVessel);
        // CRITICAL: Always show target bridge, even if ETA is missing
        const etaSuffix = intermediateETA
          ? `, beräknad broöppning av ${targetBridge} ${intermediateETA}`
          : `, beräknad broöppning av ${targetBridge}`;
        return `Broöppning pågår vid ${actualBridge}${etaSuffix}`;
      }

      // 1.5. STALLBACKABRON REFACTORED: Use centralized helper
      if (priorityVessel.status === 'stallbacka-waiting') {
        return this._getStallbackabronMessage(priorityVessel, count);
      }

      // 2. "Inväntar broöppning" (≤300m) - Second priority
      if (this._shouldShowWaiting(priorityVessel, bridgeName, statusForMessage)) {
        return this._generateWaitingMessage(priorityVessel, bridgeName, false);
      }

      // 3. "På väg mot" (en-route båtar med målbro) - NYTT!
      const priorityTarget = priorityVessel.targetBridge || priorityVessel._bridgeTextDerivedTarget;
    if (statusForMessage === 'en-route' && priorityTarget === bridgeName) {
        const intermediatePhrase = this._getIntermediateApproachPhrase(priorityVessel, bridgeName, eta);
        if (intermediatePhrase) {
          return intermediatePhrase;
        }
        // For en-route vessels, always try to calculate ETA even if null
        const enRouteETA = eta || this._formatPassedETA(priorityVessel);
        const etaSuffix = enRouteETA ? `, beräknad broöppning ${enRouteETA}` : '';
        return `En båt på väg mot ${bridgeName}${etaSuffix}`;
      }

      // 3.5. STALLBACKABRON REFACTORED: Detect approaching Stallbackabron as intermediate bridge
      // CRITICAL: This must come BEFORE standard fallback to override target bridge messages
      if (statusForMessage === 'approaching') {
        const intermediatePhrase = this._getIntermediateApproachPhrase(priorityVessel, bridgeName, eta);
        if (intermediatePhrase) {
          return intermediatePhrase;
        }

        const stallbackabron = this.bridgeRegistry.getBridgeByName('Stallbackabron');
        if (stallbackabron) {
          const distanceToStallbacka = geometry.calculateDistance(
            priorityVessel.lat, priorityVessel.lon,
            stallbackabron.lat, stallbackabron.lon,
          );
          if (distanceToStallbacka <= APPROACHING_RADIUS && distanceToStallbacka > APPROACH_RADIUS) {
            this.logger.debug(`🌉 [STALLBACKA_APPROACHING_TEXT] ${priorityVessel.mmsi}: ${distanceToStallbacka.toFixed(0)}m from Stallbackabron -> using centralized helper`);
            return this._getStallbackabronMessage(priorityVessel, count);
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
   * Build a phrase for approaching an intermediate bridge before the target bridge
   * @private
   */
  _getIntermediateApproachPhrase(vessel, targetBridge, eta) {
    const approachingIntermediate = this._findApproachingIntermediateBridge(vessel, targetBridge);
    if (!approachingIntermediate) {
      return null;
    }

    const formattedETA = eta || this._formatPassedETA(vessel);
    const etaSuffix = formattedETA ? `, beräknad broöppning ${formattedETA}` : '';

    this.logger.debug(
      `🌉 [INTERMEDIATE_APPROACH] ${vessel.mmsi}: ${approachingIntermediate.name} (${approachingIntermediate.distance.toFixed(0)}m) before ${targetBridge}`,
    );

    return `En båt närmar sig ${approachingIntermediate.name} på väg mot ${targetBridge}${etaSuffix}`;
  }

  _findApproachingIntermediateBridge(vessel, targetBridge) {
    if (!vessel || !Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
      return null;
    }

    const target = this.bridgeRegistry.getBridgeByName(targetBridge);
    if (!target) {
      return null;
    }

    const targetDistance = geometry.calculateDistance(
      vessel.lat,
      vessel.lon,
      target.lat,
      target.lon,
    );

    if (!Number.isFinite(targetDistance)) {
      return null;
    }

    const isNorthbound = this._isNorthboundCourse(vessel);

    let bestCandidate = null;

    for (const name of INTERMEDIATE_BRIDGES) {
      if (name === targetBridge) continue;
      if (name === 'Stallbackabron') continue;
      if (vessel.lastPassedBridge === name) continue;

      const bridge = this.bridgeRegistry.getBridgeByName(name);
      if (!bridge) continue;

      const distance = geometry.calculateDistance(
        vessel.lat,
        vessel.lon,
        bridge.lat,
        bridge.lon,
      );

      if (!Number.isFinite(distance)) continue;

      if (distance > APPROACHING_RADIUS * 1.2) continue;
      if (distance <= APPROACH_RADIUS) continue;
      if (!this._isBridgeAheadInRoute(bridge, target, isNorthbound)) continue;

      if (!bestCandidate || distance < bestCandidate.distance) {
        bestCandidate = { name, distance };
      }
    }

    return bestCandidate;
  }

  _isNorthboundCourse(vessel) {
    if (!Number.isFinite(vessel.cog)) {
      return vessel.lat <= this.bridgeRegistry.getBridgeByName('Stridsbergsbron')?.lat;
    }
    return vessel.cog >= 315 || vessel.cog <= 45;
  }

  _isBridgeAheadInRoute(intermediateBridge, targetBridge, isNorthbound) {
    const intermediateId = this.bridgeRegistry.findBridgeIdByName(intermediateBridge.name);
    const targetId = this.bridgeRegistry.findBridgeIdByName(targetBridge.name);

    if (!intermediateId || !targetId) {
      return false;
    }

    const intermediateIndex = this.bridgeRegistry.getBridgeSequenceIndex(intermediateId);
    const targetIndex = this.bridgeRegistry.getBridgeSequenceIndex(targetId);

    if (intermediateIndex === -1 || targetIndex === -1) {
      return false;
    }

    if (isNorthbound) {
      return intermediateIndex <= targetIndex;
    }

    return intermediateIndex >= targetIndex;
  }

  _getDistanceToBridgeByName(vessel, bridgeName) {
    if (!vessel || !Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) {
      return null;
    }

    const bridge = this.bridgeRegistry.getBridgeByName(bridgeName);
    if (!bridge || !Number.isFinite(bridge.lat) || !Number.isFinite(bridge.lon)) {
      return null;
    }

    const distance = geometry.calculateDistance(
      vessel.lat,
      vessel.lon,
      bridge.lat,
      bridge.lon,
    );

    return Number.isFinite(distance) ? distance : null;
  }

  _getEffectiveStatus(vessel, bridgeName) {
    if (!vessel) {
      return undefined;
    }

    let status = vessel.status;

    const isTarget = this._isTargetBridge(bridgeName) && vessel.targetBridge === bridgeName;

    if (isTarget && status === 'waiting') {
      const distance = this._getDistanceToBridgeByName(vessel, bridgeName);
      if (Number.isFinite(distance) && distance <= UNDER_BRIDGE_SET_DISTANCE) {
        return 'under-bridge';
      }
    }

    if (
      isTarget
      && status === 'passed'
      && vessel.lastPassedBridge
      && vessel.lastPassedBridge !== bridgeName
    ) {
      const distance = this._getDistanceToBridgeByName(vessel, bridgeName);
      if (Number.isFinite(distance)) {
        if (distance <= UNDER_BRIDGE_SET_DISTANCE) {
          status = 'under-bridge';
        } else if (distance <= APPROACH_RADIUS) {
          status = 'waiting';
        } else if (distance <= APPROACHING_RADIUS) {
          status = 'approaching';
        }
      }
    }

    return status;
  }

  /**
   * Generate phrase for multiple vessels
   * @private
   */
  _generateMultiVesselPhrase(bridgeName, vessels, priorityVessel, eta) {
    // NEW RULE: Count vessels that should show "inväntar broöppning" (≤300m)
    const waitingCount = vessels.filter((v) => this._shouldShowWaiting(v, bridgeName, this._getEffectiveStatus(v, bridgeName))).length;
    const underBridgeCount = vessels.filter((v) => v.status === 'under-bridge').length;
    // STALLBACKABRON SPECIAL: Count vessels with "åker strax under" status
    const stallbackaWaitingCount = vessels.filter((v) => v.status === 'stallbacka-waiting').length;

    // Priority 1: Under-bridge (highest priority)
    if (underBridgeCount > 0) {
      const actualBridge = priorityVessel.currentBridge || bridgeName;
      if (underBridgeCount === 1 && vessels.length > 1) {
        const additionalCount = vessels.length - 1;
        const additionalText = additionalCount === 1
          ? 'ytterligare 1 båt på väg'
          : `ytterligare ${this.getCountText(additionalCount)} båtar på väg`;
        // STALLBACKABRON REFACTORED: Use centralized helper
        if (actualBridge === 'Stallbackabron') {
          return this._getStallbackabronMessage(priorityVessel, vessels.length, additionalCount);
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
      // STALLBACKABRON REFACTORED: Use centralized helper
      if (actualBridge === 'Stallbackabron') {
        return this._getStallbackabronMessage(priorityVessel, vessels.length);
      }
      // CRITICAL FIX: Follow bridgeTextFormat.md rules for single under-bridge
      if (this._isTargetBridge(actualBridge)) {
        return `Broöppning pågår vid ${actualBridge}`;
      }
      // Intermediate bridge: show ETA to target bridge
      const targetBridge = priorityVessel.targetBridge || bridgeName;
      const intermediateETA = this._formatPassedETA(priorityVessel);
      const etaSuffix = intermediateETA ? `, beräknad broöppning av ${targetBridge} ${intermediateETA}` : '';
      return `Broöppning pågår vid ${actualBridge}${etaSuffix}`;

    }

    // Priority 1.5: STALLBACKABRON SPECIAL "åker strax under" (≤300m)
    if (stallbackaWaitingCount > 0) {
      if (stallbackaWaitingCount === vessels.length) {
        // All vessels are "åker strax under" Stallbackabron - use centralized helper
        if (stallbackaWaitingCount === 1) {
          // STALLBACKABRON REFACTORED: Single vessel
          return this._getStallbackabronMessage(priorityVessel, 1);
        }
        // STALLBACKABRON REFACTORED: Multiple vessels (all same status)
        const additionalCount = stallbackaWaitingCount - 1;
        return this._getStallbackabronMessage(priorityVessel, stallbackaWaitingCount, additionalCount);

      }
      // STALLBACKABRON REFACTORED: Mixed statuses - show leading vessel with others
      const additionalCount = vessels.length - 1;
      return this._getStallbackabronMessage(priorityVessel, vessels.length, additionalCount);
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
          : `ytterligare ${this.getCountText(additionalCount)} båtar på väg`;

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
        const countText = enRouteCount === 1 ? 'En båt' : `${this.getCountText(enRouteCount)} båtar`;
        return `${countText} på väg mot ${bridgeName}, beräknad broöppning ${eta}`;
      }
      // Mixed statuses - show leading en-route vessel
      const additionalCount = vessels.length - 1;
      const additionalText = additionalCount === 1
        ? 'ytterligare 1 båt på väg'
        : `ytterligare ${this.getCountText(additionalCount)} båtar på väg`;
      return `En båt på väg mot ${bridgeName}, ${additionalText}, beräknad broöppning ${eta}`;

    }

    // Priority 4: All approaching/moving (fallback)
    // CRITICAL FIX: Follow bridgeTextFormat.md rules for multi-vessel approaching
    const additionalCount = vessels.length - 1;
    const additionalText = additionalCount === 1
      ? 'ytterligare 1 båt'
      : `ytterligare ${this.getCountText(additionalCount)} båtar`;

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
   * Format ETA for Stallbackabron/passed messages (REFACTORED - delegates to ETAFormatter)
   * @private
   */
  _formatPassedETA(vessel) {
    // REFACTORED: Delegate to unified ETAFormatter with passed message context
    return this.etaFormatter.formatForPassedMessage(vessel, vessel.targetBridge);
  }

  /**
   * Format ETA for display (REFACTORED - delegates to ETAFormatter)
   * @private
   */
  _formatETA(etaMinutes, isWaiting) {
    // REFACTORED: Delegate to unified ETAFormatter
    return this.etaFormatter.formatETAWithContext(
      { etaMinutes, isWaiting },
      { allowWaiting: false, contextName: 'LEGACY_FORMAT_ETA' },
    );
  }

  /**
   * Generate Stallbackabron message using centralized helper
   * REFACTORED: Eliminates 18+ duplicated inline messages
   * @private
   * @param {Object} vessel - Vessel object
   * @param {number} count - Total vessel count (default: 1)
   * @param {number} additionalCount - Additional vessels (default: 0)
   * @returns {string|null} Stallbackabron message
   */
  _getStallbackabronMessage(vessel, count = 1, additionalCount = 0) {
    const stallbacka = this.bridgeRegistry.getBridgeByName('Stallbackabron');
    let distance = Number.isFinite(vessel?.distanceToCurrent) ? vessel.distanceToCurrent : null;
    if ((!distance || !Number.isFinite(distance)) && stallbacka && Number.isFinite(vessel?.lat) && Number.isFinite(vessel?.lon)) {
      distance = geometry.calculateDistance(
        vessel.lat, vessel.lon,
        stallbacka.lat, stallbacka.lon,
      );
    }

    const messageType = this.stallbackabronHelper.getMessageType(vessel, distance || Infinity);

    // If helper determined the vessel has fully passed the bridge, reflect that in status
    if (messageType === 'passed' && vessel.status !== 'passed') {
      vessel.status = 'passed';
    }

    // Get ETA (always show for Stallbackabron per bridgeTextFormat.md)
    const etaText = this._formatPassedETA(vessel);

    // Delegate to centralized helper
    return this.stallbackabronHelper.generateMessage(vessel, messageType, etaText, {
      count,
      additionalCount,
    });
  }

  /**
   * Check if vessel should show "inväntar broöppning" message
   * @private
   */
  _shouldShowWaiting(vessel, bridgeName, statusOverride = undefined) {
    // NEW RULE: ≤300m from bridge triggers "inväntar broöppning"
    // EXCEPT for Stallbackabron (high bridge, no opening)

    if (bridgeName === 'Stallbackabron') {
      return false; // Stallbackabron NEVER shows "inväntar broöppning"
    }

    const status = statusOverride !== undefined
      ? statusOverride
      : this._getEffectiveStatus(vessel, bridgeName);

    // Must have waiting status to show "inväntar broöppning"
    if (status !== 'waiting') {
      return false;
    }

    // CRITICAL FIX: Check if vessel is waiting at target bridge FIRST (higher priority)
    const vesselTarget = vessel.targetBridge || vessel._bridgeTextDerivedTarget;
    if (vesselTarget === bridgeName) {
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

    this.logger.debug(`🔍 [WAITING_CHECK] ${vessel.mmsi}: NOT waiting at ${bridgeName} - targetBridge: ${vesselTarget}, currentBridge: ${vessel.currentBridge}, status: ${status}`);
    return false;
  }

  /**
   * Generate waiting message based on bridge type
   * @private
   */
  _generateWaitingMessage(vessel, bridgeName, isMultiple = false) {
    // Check if this is a target bridge (Klaffbron/Stridsbergsbron)
    const isTargetBridge = bridgeName === 'Klaffbron' || bridgeName === 'Stridsbergsbron';

    if (isTargetBridge) {
      // Target bridge: Support both single and multiple vessels
      if (isMultiple && vessel.count > 1) {
        // Multi-vessel format: "Två båtar inväntar broöppning vid [målbro]"
        const countText = this.getCountText(vessel.count);
        return `${countText} båtar inväntar broöppning vid ${bridgeName}`;
      }
      // Single vessel format
      return `En båt inväntar broöppning vid ${bridgeName}`;

    }
    // Intermediate bridge: "En båt inväntar broöppning av [mellanbro] på väg mot [målbro], beräknad broöppning om X"
    const targetBridge = this._deriveTargetBridge(vessel, bridgeName);
    const eta = this._formatETA(vessel.etaMinutes, false); // ETA to target bridge
    const etaSuffix = eta ? `, beräknad broöppning ${eta}` : '';

    if (isMultiple && vessel.count > 1) {
      // Multi-vessel format for intermediate bridges
      const countText = this.getCountText(vessel.count);
      return `${countText} båtar inväntar broöppning av ${bridgeName} på väg mot ${targetBridge}${etaSuffix}`;
    }
    return `En båt inväntar broöppning av ${bridgeName} på väg mot ${targetBridge}${etaSuffix}`;

  }

  /**
   * Combine phrases into final message
   * @private
   */
  _combinePhrases(phrases, groups) {
    if (phrases.length === 0) {
      // FIX: Return standard message when all vessels were filtered out
      return BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
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
   * Check if bridge is an intermediate bridge (Olidebron/Järnvägsbron only)
   * According to bridgeTextFormat.md, only these bridges should use "vid [bridge] närmar sig" format
   * @private
   */
  _isIntermediateBridge(bridgeName) {
    return bridgeName === 'Olidebron' || bridgeName === 'Järnvägsbron';
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

  /**
   * Get the next bridge after the given bridge based on course direction
   * Helper function for "precis passerat" messages when targetBridge is blocked by 300m protection
   * @param {string} lastPassedBridge - Name of the bridge that was just passed
   * @param {number} course - COG of the vessel
   * @returns {string|null} Name of the next bridge in the sequence, or null if none
   */
  getNextBridgeAfter(lastPassedBridge, course) {
    if (!lastPassedBridge || typeof course !== 'number') {
      return null;
    }

    const bridgeIndex = BRIDGE_SEQUENCE.indexOf(lastPassedBridge.toLowerCase());
    if (bridgeIndex === -1) {
      this.logger.debug(`⚠️ [NEXT_BRIDGE] Unknown bridge: ${lastPassedBridge}`);
      return null;
    }

    // Determine direction based on COG (same logic as VesselDataService)
    const isNorthbound = (course >= 315 || course <= 45);

    const step = isNorthbound ? 1 : -1;
    let nextIndex = bridgeIndex + step;

    while (nextIndex >= 0 && nextIndex < BRIDGE_SEQUENCE.length) {
      const nextBridgeId = BRIDGE_SEQUENCE[nextIndex];
      const nextBridgeName = this.bridgeRegistry.getBridgeById(nextBridgeId)?.name;

      if (nextBridgeName && TARGET_BRIDGES.includes(nextBridgeName)) {
        this.logger.debug(`🎯 [NEXT_BRIDGE] ${lastPassedBridge} → ${nextBridgeName} (${isNorthbound ? 'north' : 'south'}bound)`);
        return nextBridgeName;
      }

      nextIndex += step;
    }

    return null; // No further target bridges in this direction
  }

  /**
   * Update last bridge text for debouncing
   * @private
   */
  _updateLastBridgeText(text) {
    this.lastBridgeText = text;
    this.lastBridgeTextTime = Date.now();

    if (text && text !== BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE) {
      this.lastNonDefaultText = text;
      this.lastNonDefaultTextTime = this.lastBridgeTextTime;
    }
  }

  /**
   * Provide a graceful fallback message when no vessels are available
   * @private
   * @param {string} reason - Reason for the fallback (for logging)
   * @returns {string} Fallback bridge text
   */
  _getNoVesselMessage(reason) {
    const now = Date.now();
    const holdWindow = PASSAGE_TIMING?.PASSED_HOLD_MS || 60000;

    const allowHold = reason === 'gps-hold' || reason === 'invalid-vessels';

    if (allowHold && this.lastNonDefaultText && (now - this.lastNonDefaultTextTime) <= holdWindow) {
      this.logger.debug(
        `🕒 [BRIDGE_TEXT_HOLD] Reusing last non-default text (${reason}) `
        + `(${((now - this.lastNonDefaultTextTime) / 1000).toFixed(1)}s old)`,
      );
      return this.lastNonDefaultText;
    }

    this.logger.debug(`ℹ️ [BRIDGE_TEXT_DEFAULT] ${reason} -> using default message`);
    const defaultText = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
    this._updateLastBridgeText(defaultText);
    return defaultText;
  }
}

module.exports = BridgeTextService;
