'use strict';

const EventEmitter = require('events');

/**
 * SystemCoordinator - Coordinates between GPS analysis, status stabilization, and user experience
 * Ensures smooth operation when GPS events occur and prevents rapid status/text changes
 */
class SystemCoordinator extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;

    // Coordination state tracking
    this.vesselCoordinationState = new Map(); // Map<mmsi, CoordinationState>
    this.bridgeTextDebounce = new Map(); // Map<bridgeId, DebounceData>
    this.globalSystemState = {
      unstableGPSCount: 0,
      lastStabilityEvent: null,
      coordinationActive: false,
      // C4 (2026-07-01): räkna DISTINKTA fartyg med färska hopp i stället
      // för råa händelser — ett ensamt ankrat multipath-fartyg kunde annars
      // driva räknaren obegränsat (∼360/h) och aktivera system_wide-
      // koordination som blockerade passage-detektering för ALLA fartyg,
      // med timmar av stegvis decay efteråt.
      recentJumpers: new Map(), // Map<mmsi, lastJumpTs>
    };

    // Configuration
    this.config = {
      bridgeTextDebounceMs: 2000, // 2 seconds
      gpsEventCooldownMs: 5000, // 5 seconds
      maxConcurrentGPSEvents: 3,
      stabilizationCoordinationMs: 10000, // 10 seconds
    };
  }

  /**
   * Get summarized coordination info for a vessel (used by GPSJumpGateService)
   * @param {string|number} mmsi - Vessel MMSI
   * @returns {Object|null} Coordination summary
   */
  getCoordination(mmsi) {
    try {
      const id = mmsi?.toString();
      if (!id) return null;

      const state = this.vesselCoordinationState.get(id);
      if (!state) {
        return {
          level: this.globalSystemState?.coordinationActive ? 'system_wide' : 'normal',
          protection: !!this.globalSystemState?.coordinationActive,
          coordinationActive: !!this.globalSystemState?.coordinationActive,
          reason: this.globalSystemState?.coordinationActive ? 'system_wide_coordination' : 'none',
        };
      }

      // Produktionsredo (2026-07-03): tidsbasera aktiv-bedömningen HÄR.
      // coordinationActive-flaggan släpps annars bara av
      // coordinateStatusStabilization — som StatusService enbart anropar
      // medan GPS-flaggorna är satta. När flaggorna släppte förblev
      // coordinationActive=true för evigt och GPSJumpGateService gate:ade
      // all passage-detektering för fartyget resten av dess livstid
      // (missade notiser). Koordinationsfönstret ÄR stabilizationCoordinationMs.
      const withinWindow = Number.isFinite(state.coordinationStartTime)
        && (Date.now() - state.coordinationStartTime) <= this.config.stabilizationCoordinationMs;
      const selfActive = !!state.coordinationActive && withinWindow;

      // Map internal coordinationType to a public level
      // gps_jump -> enhanced, uncertain_position -> moderate, large_movement -> light
      let level = 'normal';
      if (selfActive && state.coordinationType === 'gps_jump') level = 'enhanced';
      else if (selfActive && state.coordinationType === 'uncertain_position') level = 'moderate';
      else if (selfActive && state.coordinationType === 'large_movement') level = 'light';
      else if (this.globalSystemState?.coordinationActive) level = 'system_wide';

      const active = selfActive || !!this.globalSystemState?.coordinationActive;
      return {
        level,
        protection: active, // expose as boolean used by callers
        coordinationActive: active,
        reason: state.coordinationType || (this.globalSystemState?.coordinationActive ? 'system_wide' : 'none'),
        lastUpdateTime: state.lastUpdateTime || null,
      };
    } catch (_) {
      return null;
    }
  }

  /**
   * Coordinate vessel position update with GPS analysis and stabilization
   * @param {string} mmsi - Vessel MMSI
   * @param {Object} gpsAnalysis - GPS jump analysis result
   * @param {Object} vessel - Vessel data
   * @param {Object} oldVessel - Previous vessel data
   * @returns {Object} Coordination recommendation
   */
  coordinatePositionUpdate(mmsi, gpsAnalysis, vessel, oldVessel) {
    const coordinationState = this._getOrCreateCoordinationState(mmsi);
    const currentTime = Date.now();

    // Update coordination state with GPS analysis
    coordinationState.lastGPSAnalysis = gpsAnalysis;
    coordinationState.lastUpdateTime = currentTime;

    const recommendation = {
      shouldProceed: true,
      shouldActivateProtection: false,
      shouldDebounceText: false,
      stabilizationLevel: 'normal',
      reason: 'normal_operation',
      coordinationActive: false,
    };

    // Handle GPS jump events
    if (gpsAnalysis.isGPSJump) {
      this._handleGPSJumpEvent(mmsi, coordinationState, recommendation, currentTime);
    } else if (gpsAnalysis.action === 'accept_with_caution') {
      this._handleUncertainPosition(mmsi, coordinationState, recommendation, currentTime);
    } else if (gpsAnalysis.movementDistance > 300) {
      this._handleLargeMovement(mmsi, coordinationState, recommendation, currentTime);
    }

    // F10: decay FÖRST, sedan stabilitetsbedömning. Tidigare kördes
    // _assessSystemStability först och stämplade om lastStabilityEvent varje
    // tick (när count >= tröskel), vilket blockerade tids-decayen nedan för
    // evigt → system-wide-koordination fastnade permanent och gatade ALL
    // passage-detektion (fryst bridge_text globalt). Sedan C4 (2026-07-01)
    // är decayen fönsterbaserad: recentJumpers (Map<mmsi, lastJumpTs>) rensas
    // på poster äldre än 3× cooldown och räknaren speglar mängdens storlek.
    this._updateGlobalCoordinationState(gpsAnalysis, currentTime);

    // Check for system-wide instability
    this._assessSystemStability(recommendation, currentTime);

    this.logger.debug(
      `🎮 [COORDINATION] ${mmsi}: ${recommendation.reason} `
      + `(proceed: ${recommendation.shouldProceed}, protection: ${recommendation.shouldActivateProtection}, `
      + `debounce: ${recommendation.shouldDebounceText}, level: ${recommendation.stabilizationLevel})`,
    );

    return recommendation;
  }

  /**
   * Coordinate status stabilization with protection systems
   * @param {string} mmsi - Vessel MMSI
   * @param {Object} statusResult - Status analysis result
   * @param {Object} positionAnalysis - Position analysis data
   * @returns {Object} Enhanced stabilization recommendation
   */
  coordinateStatusStabilization(mmsi, statusResult, positionAnalysis) {
    const coordinationState = this._getOrCreateCoordinationState(mmsi);
    const currentTime = Date.now();

    const enhancedResult = {
      ...statusResult,
      coordinationApplied: false,
      extendedStabilization: false,
      bridgeTextDebounced: false,
    };

    // Apply enhanced stabilization during active coordination
    if (coordinationState.coordinationActive) {
      this._applyEnhancedStabilization(mmsi, coordinationState, enhancedResult, currentTime);
    }

    // Check if bridge text should be debounced
    if (statusResult.statusChanged || statusResult.stabilized) {
      const shouldDebounce = this._shouldDebounceBridgeText(coordinationState);
      if (shouldDebounce) {
        enhancedResult.bridgeTextDebounced = true;
        this._activateBridgeTextDebounce(mmsi, currentTime);
      }
    }

    return enhancedResult;
  }

  /**
   * Handle GPS jump event with enhanced coordination
   * @private
   */
  _handleGPSJumpEvent(mmsi, coordinationState, recommendation, currentTime) {
    // C4 (2026-07-01): en jumper räknas EN gång oavsett hur många hopp den
    // producerar — system_wide kräver ≥3 DISTINKTA fartyg inom fönstret.
    this.globalSystemState.recentJumpers.set(String(mmsi), currentTime);
    this.globalSystemState.unstableGPSCount = this.globalSystemState.recentJumpers.size;
    // lastJumpTime: tidpunkten för senaste faktiska GPS-hoppet. Sedan C4
    // (2026-07-01) läses den INTE av decayen (den är fönsterbaserad via
    // recentJumpers-tidsstämplarna) — fältet behålls enbart för observability
    // i getCoordinationStatus().
    this.globalSystemState.lastJumpTime = currentTime;

    // Activate strong coordination for GPS jumps
    coordinationState.coordinationActive = true;
    coordinationState.coordinationStartTime = currentTime;
    coordinationState.coordinationType = 'gps_jump';

    recommendation.shouldActivateProtection = true;
    recommendation.shouldDebounceText = true;
    recommendation.stabilizationLevel = 'enhanced';
    recommendation.reason = 'gps_jump_coordination';
    recommendation.coordinationActive = true;

    this.logger.log(
      `🚨 [GPS_JUMP_COORDINATION] ${mmsi}: Activating enhanced coordination for GPS jump `
      + `(distance: ${coordinationState.lastGPSAnalysis?.movementDistance?.toFixed(0)}m)`,
    );

    // Emit coordination event
    this.emit('coordination:gps_jump', {
      mmsi,
      distance: coordinationState.lastGPSAnalysis?.movementDistance,
      coordinationDuration: this.config.stabilizationCoordinationMs,
    });
  }

  /**
   * Handle uncertain position with moderate coordination
   * @private
   */
  _handleUncertainPosition(mmsi, coordinationState, recommendation, currentTime) {
    coordinationState.coordinationActive = true;
    coordinationState.coordinationStartTime = currentTime;
    coordinationState.coordinationType = 'uncertain_position';

    recommendation.shouldActivateProtection = true;
    recommendation.shouldDebounceText = true;
    recommendation.stabilizationLevel = 'moderate';
    recommendation.reason = 'uncertain_position_coordination';
    recommendation.coordinationActive = true;

    this.logger.debug(
      `⚠️ [UNCERTAIN_COORDINATION] ${mmsi}: Activating moderate coordination for uncertain position`,
    );
  }

  /**
   * Handle large movement with light coordination
   * @private
   */
  _handleLargeMovement(mmsi, coordinationState, recommendation, currentTime) {
    // For large but legitimate movements, apply light coordination
    coordinationState.coordinationActive = true;
    coordinationState.coordinationStartTime = currentTime;
    coordinationState.coordinationType = 'large_movement';

    recommendation.shouldDebounceText = true;
    recommendation.stabilizationLevel = 'light';
    recommendation.reason = 'large_movement_coordination';
    recommendation.coordinationActive = true;

    this.logger.debug(
      `🔄 [LARGE_MOVEMENT_COORDINATION] ${mmsi}: Applying light coordination for large movement `
      + `(${coordinationState.lastGPSAnalysis?.movementDistance?.toFixed(0)}m)`,
    );
  }

  /**
   * Apply enhanced stabilization during coordination
   * @private
   */
  _applyEnhancedStabilization(mmsi, coordinationState, enhancedResult, currentTime) {
    const coordinationDuration = currentTime - coordinationState.coordinationStartTime;
    const remainingTime = this.config.stabilizationCoordinationMs - coordinationDuration;

    if (remainingTime > 0) {
      enhancedResult.extendedStabilization = true;
      enhancedResult.coordinationApplied = true;

      this.logger.debug(
        `🛡️ [ENHANCED_STABILIZATION] ${mmsi}: Extended stabilization active `
        + `(${coordinationState.coordinationType}, remaining: ${(remainingTime / 1000).toFixed(1)}s)`,
      );
    } else {
      // End coordination period
      coordinationState.coordinationActive = false;
      this.logger.debug(`✅ [COORDINATION_END] ${mmsi}: Coordination period ended`);
    }
  }

  /**
   * Check if bridge text should be debounced for specific vessel
   * @private
   */
  _shouldDebounceBridgeText(coordinationState) {
    // (Städat 2026-07-05: den tidigare cooldown-grenen på lastGPSEventTime
    // var död — fältet skrevs aldrig, så tidsjämförelsen kunde aldrig slå.)
    // Always debounce during active coordination
    if (coordinationState.coordinationActive) {
      return true;
    }

    // Check global system stability
    if (this.globalSystemState.coordinationActive) {
      return true;
    }

    return false;
  }

  /**
   * Activate bridge text debounce
   * @private
   */
  _activateBridgeTextDebounce(mmsi, currentTime) {
    // Check for existing debounce and clear any associated timer
    const existing = this.bridgeTextDebounce.get(mmsi);
    if (existing && existing.timer) {
      clearTimeout(existing.timer);
    }

    // Create new debounce entry with auto-cleanup timer
    const debounceData = {
      startTime: currentTime,
      endTime: currentTime + this.config.bridgeTextDebounceMs,
      reason: 'coordination_active',
      timer: null,
    };

    // Set auto-cleanup timer to prevent memory leak
    debounceData.timer = setTimeout(() => {
      // Clean up after debounce period
      if (this.bridgeTextDebounce.get(mmsi) === debounceData) {
        this.bridgeTextDebounce.delete(mmsi);
      }
    }, this.config.bridgeTextDebounceMs);

    // Atomic set operation
    this.bridgeTextDebounce.set(mmsi, debounceData);

    this.logger.debug(
      `⏸️ [BRIDGE_TEXT_DEBOUNCE] ${mmsi}: Debouncing bridge text updates for ${this.config.bridgeTextDebounceMs}ms`,
    );
  }

  /**
   * Assess overall system stability
   * @private
   */
  _assessSystemStability(recommendation, currentTime) {
    const unstableThreshold = this.config.maxConcurrentGPSEvents;

    if (this.globalSystemState.unstableGPSCount >= unstableThreshold) {
      recommendation.stabilizationLevel = 'system_wide';
      recommendation.shouldDebounceText = true;

      this.globalSystemState.coordinationActive = true;
      this.globalSystemState.lastStabilityEvent = currentTime;

      this.logger.log(
        '🌊 [SYSTEM_STABILITY] System-wide coordination activated '
        + `(${this.globalSystemState.unstableGPSCount} concurrent GPS events)`,
      );
    }
  }

  /**
   * Update global coordination state
   * @private
   */
  _updateGlobalCoordinationState(gpsAnalysis, currentTime) {
    // F10 (historik): decayen fick inte baseras på lastStabilityEvent, som
    // _assessSystemStability stämplar om varje tick (→ blockerade decay för
    // evigt → permanent stuck koordination). Den mellanliggande lösningen
    // (stegvis decay på lastJumpTime) ersattes helt av C4 nedan.
    // C4 (2026-07-01): fönsterbaserad utrensning — en jumper vars senaste
    // hopp är äldre än 3× cooldown faller ur mängden. Räknaren återspeglar
    // alltid ANTALET DISTINKTA färska jumpers, så en lugn period släpper
    // koordinationen inom sekunder (inte timmar av stegvis decay).
    const windowMs = this.config.gpsEventCooldownMs * 3;
    for (const [jumperMmsi, ts] of this.globalSystemState.recentJumpers) {
      if (currentTime - ts > windowMs) {
        this.globalSystemState.recentJumpers.delete(jumperMmsi);
      }
    }
    this.globalSystemState.unstableGPSCount = this.globalSystemState.recentJumpers.size;
    // Produktionsredo (2026-07-03): släpp när antalet faller UNDER
    // aktiveringströskeln — kravet på exakt 0 lät en ENSAM ihållande
    // multipath-jumper (t.ex. dåligt monterad transponder vid kajen) hålla
    // HELA systemets koordination aktiv på obestämd tid, vilket gate:ade
    // passage-detektering för alla fartyg (missade notiser).
    if (this.globalSystemState.unstableGPSCount < this.config.maxConcurrentGPSEvents) {
      this.globalSystemState.coordinationActive = false;
    }
  }

  /**
   * Get or create coordination state for vessel
   * @private
   */
  _getOrCreateCoordinationState(mmsi) {
    if (!this.vesselCoordinationState.has(mmsi)) {
      this.vesselCoordinationState.set(mmsi, {
        coordinationActive: false,
        coordinationStartTime: null,
        coordinationType: null,
        lastGPSAnalysis: null,
        lastUpdateTime: null,
        stabilizationHistory: [],
      });
    }
    return this.vesselCoordinationState.get(mmsi);
  }

  /**
   * Clean up old coordination state
   */
  cleanup() {
    const currentTime = Date.now();
    const oneHourAgo = currentTime - (60 * 60 * 1000);

    // Clean vessel coordination state (tillståndet bär inga timers —
    // debounce-timers lever i bridgeTextDebounce och rensas nedan)
    for (const [mmsi, state] of this.vesselCoordinationState.entries()) {
      if (!state.lastUpdateTime || state.lastUpdateTime < oneHourAgo) {
        this.vesselCoordinationState.delete(mmsi);
      }
    }

    // Clean bridge text debounces and clear associated timers
    for (const [mmsi, debounceData] of this.bridgeTextDebounce.entries()) {
      if (debounceData.endTime < currentTime) {
        if (debounceData.timer) {
          clearTimeout(debounceData.timer);
        }
        this.bridgeTextDebounce.delete(mmsi);
      }
    }

    this.logger.debug('🧹 [COORDINATION_CLEANUP] Cleaned old coordination state and timers');
  }

  /**
   * Remove vessel from coordination tracking
   */
  removeVessel(mmsi) {
    // Produktionsredo (2026-07-03): normalisera nyckeln — tillstånd skapas
    // med det mmsi (oftast sträng) som gavs till coordinatePositionUpdate;
    // ett numeriskt mmsi här missade posten → långsam tillståndsläcka över
    // månader. Rensa även debounce-timern (inkonsekvens mot cleanup()).
    const key = mmsi?.toString?.() ?? mmsi;
    const debounce = this.bridgeTextDebounce.get(key);
    if (debounce && debounce.timer) clearTimeout(debounce.timer);
    this.vesselCoordinationState.delete(key);
    this.bridgeTextDebounce.delete(key);
    // Även rå nyckel om någon anropare hunnit skapa en (defensivt).
    if (key !== mmsi) {
      this.vesselCoordinationState.delete(mmsi);
      this.bridgeTextDebounce.delete(mmsi);
    }
  }

  /**
   * Get coordination status for debugging
   */
  getCoordinationStatus() {
    return {
      globalState: { ...this.globalSystemState },
      activeCoordinations: this.vesselCoordinationState.size,
      activeDebounces: this.bridgeTextDebounce.size,
      config: { ...this.config },
    };
  }
}

module.exports = SystemCoordinator;
