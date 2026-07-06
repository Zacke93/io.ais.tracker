'use strict';

const geometry = require('./geometry');

/**
 * GPSJumpAnalyzer - Sophisticated GPS jump detection with direction change analysis
 * Distinguishes between real GPS errors and legitimate large movements (U-turns, direction changes)
 */
class GPSJumpAnalyzer {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Analyze movement to determine if it's a GPS jump or legitimate movement
   * @param {string} mmsi - Vessel MMSI
   * @param {Object} currentPosition - Current position {lat, lon}
   * @param {Object} previousPosition - Previous position {lat, lon}
   * @param {Object} currentVessel - Current vessel data (including COG, SOG)
   * @param {Object} oldVessel - Previous vessel data
   * @returns {Object} Analysis result with recommended action
   */
  analyzeMovement(mmsi, currentPosition, previousPosition, currentVessel, oldVessel) {
    if (!previousPosition || !oldVessel) {
      return {
        action: 'accept',
        reason: 'no_previous_data',
        isGPSJump: false,
        isLegitimateMovement: true,
        movementDistance: 0,
      };
    }

    // Calculate movement distance
    const movementDistance = geometry.calculateDistance(
      previousPosition.lat, previousPosition.lon,
      currentPosition.lat, currentPosition.lon,
    );

    const result = {
      movementDistance,
      action: 'accept',
      reason: 'normal_movement',
      isGPSJump: false,
      isLegitimateMovement: true,
      confidence: 'high',
      analysis: {},
    };

    // Small movements - always accept
    if (movementDistance <= 100) {
      return result;
    }

    // Large movements - analyze further
    if (movementDistance > 500) {
      return this._analyzeLargeMovement(mmsi, currentPosition, previousPosition, currentVessel, oldVessel, result);
    }

    // Medium movements (100-500m) - accept with caution
    // S-F4 (2026-07-01): mellanintervallet accepterades tidigare BLINT — en
    // enda multipath-outlier på 100–500 m hos en (nära) stillaliggande båt
    // gav falsk linjekorsningspassage över bron och förgiftade det klistrande
    // rörelsebeviset. Fysikgata: överskrider förflyttningen vad rapporterad
    // sog rimligen medger (2× marginal, 1 kn-golv för still/långsam) →
    // accept_with_caution (⇒ positionUncertain i pipelinen). Normala Class
    // B-gap klarar gatan med god marginal (3 min @ 5 kn ⇒ tak ~926 m).
    // Helgranskning 2026-07-06 (gpsjump#2): samma klockbakhoppsklamp som
    // stora-rörelse-grenen (rad ~98) — negativt delta (NTP-korrigering) gav
    // annars ett mikroskopiskt tillåtet avstånd → falsk accept_with_caution.
    let medTimeElapsedMs = Date.now() - (oldVessel.timestamp || Date.now());
    if (medTimeElapsedMs < 0) {
      medTimeElapsedMs = 60 * 1000;
    }
    const medTimeElapsedHours = Math.max(medTimeElapsedMs / 3600000, 0.001);
    // Helgranskning 2026-07-06 (scenario 'fartgivarlös-genomresa' avslöjade
    // detta): med sog=null på BÅDA samples (Class B utan fartgivare) gav
    // `sog || 0` maxfart = 1 kn-golvet → tillåtet ~62 m/min medan båten
    // legitimt går 140 m/min → VARJE sample dömdes "osäker" → måltilldelning
    // avvisad → båten permanent osynlig (P1+P2). Okänd fart kan inte
    // fysikgatas strikt: anta kanal-realistisk maxfart (5 kn, samma golv som
    // storgrenens) — 100–300 m-outliers på stilla båtar släpps då för denna
    // klass, men 1 kn-golvet gäller oförändrat när farten ÄR känd.
    const medCurrentSog = Number.isFinite(currentVessel.sog) ? currentVessel.sog : null;
    const medOldSog = Number.isFinite(oldVessel.sog) ? oldVessel.sog : null;
    const medMaxSpeedKn = (medCurrentSog === null && medOldSog === null)
      ? 5
      : Math.max(medCurrentSog ?? 0, medOldSog ?? 0, 1);
    const medRealisticM = medMaxSpeedKn * medTimeElapsedHours * 2.0 * 1852;
    if (movementDistance > medRealisticM) {
      result.action = 'accept_with_caution';
      result.reason = 'medium_movement_speed_mismatch';
      result.confidence = 'low';
      this.logger.debug(
        `⚠️ [GPS_MEDIUM_SUSPECT] ${mmsi}: ${movementDistance.toFixed(0)}m on `
        + `${(medTimeElapsedMs / 1000).toFixed(0)}s exceeds realistic `
        + `${medRealisticM.toFixed(0)}m (sog ${medMaxSpeedKn.toFixed(1)}kn) — position uncertain`,
      );
      return result;
    }
    result.reason = 'medium_movement';
    result.confidence = 'medium';
    return result;
  }

  /**
   * Analyze large movements (>500m) to determine if GPS jump or legitimate movement
   * @private
   */
  _analyzeLargeMovement(mmsi, currentPosition, previousPosition, currentVessel, oldVessel, result) {
    let timeElapsedMs = Date.now() - (oldVessel.timestamp || Date.now());
    // Produktionsredo (2026-07-03): ett klockBAKhopp (NTP-korrigering) gav
    // negativt delta som golvades till ~0 h — maxRealisticDistance kollapsade
    // och normal förflyttning dömdes som GPS-hopp en tick. Vid bakhopp är
    // tiden okänd: anta ett typiskt rapportintervall i stället.
    if (timeElapsedMs < 0) {
      timeElapsedMs = 60 * 1000;
    }
    const timeElapsedHours = Math.max(timeElapsedMs / (1000 * 60 * 60), 0.001); // Avoid division by zero

    result.analysis = {
      movementDistance: result.movementDistance,
      timeElapsed: timeElapsedMs,
      cogChange: this._calculateCOGChange(currentVessel.cog, oldVessel.cog),
      sogChange: Math.abs((currentVessel.sog || 0) - (oldVessel.sog || 0)),
      bearingConsistency: this._checkBearingConsistency(currentPosition, previousPosition, currentVessel.cog),
      speedConsistency: this._checkSpeedConsistency(result.movementDistance, currentVessel.sog, oldVessel),
    };

    // IMPROVED: Calculate maximum realistic distance based on vessel speed
    // 2.0x margin accounts for: AIS speed being a snapshot (not average),
    // deceleration/acceleration during gap, and canal current assistance
    const maxSpeed = Math.max(currentVessel.sog || 0, oldVessel.sog || 0, 5); // Min 5 knots
    const maxRealisticDistanceNM = maxSpeed * timeElapsedHours * 2.0; // 100% margin
    const maxRealisticDistanceM = maxRealisticDistanceNM * 1852;

    // Evidence of legitimate movement
    const legitimacyScore = this._calculateLegitimacyScore(result.analysis);

    // IMPROVED LOGIC: Better detection of turns vs GPS jumps
    // F64: the deterministic physics gate previously required >800m, so a
    // physically-impossible 500-800m jump with no supporting course change fell
    // through to the legitimacy score (+0.5 baseline) and could be ACCEPTED —
    // injecting a wrong position/ETA/bridge for one tick. Apply the physics gate
    // from >300m, but ONLY when there is no clear turn (cogChange null or ≤45°),
    // so legitimate U-turns/maneuvers (cogChange>45) still fall through to the
    // turn/legitimacy branches below and are not mislabelled as GPS jumps.
    const noClearTurn = result.analysis.cogChange === null || result.analysis.cogChange <= 45;
    if (result.movementDistance > maxRealisticDistanceM
        && result.movementDistance > 300
        && noClearTurn) {
      // Physically impossible - definite GPS jump
      result.action = 'gps_jump_detected';
      result.reason = 'physically_impossible_movement';
      result.isLegitimateMovement = false;
      result.isGPSJump = true;
      result.confidence = 'high';
      this.logger.debug(
        `🚨 [GPS_PHYSICS] ${mmsi}: ${result.movementDistance.toFixed(0)}m exceeds max `
        + `${maxRealisticDistanceM.toFixed(0)}m (${maxSpeed}kn for ${(timeElapsedMs / 1000).toFixed(1)}s)`,
      );
    } else if (result.analysis.cogChange > 45 && legitimacyScore >= 0.4) {
      // Large COG change = turning/maneuvering
      result.action = 'accept';
      result.reason = 'vessel_turning';
      result.isLegitimateMovement = true;
      result.isGPSJump = false;
      result.confidence = result.analysis.cogChange > 90 ? 'high' : 'medium';
    } else if (legitimacyScore >= 0.7) {
      result.action = 'accept';
      result.reason = 'legitimate_direction_change';
      result.isLegitimateMovement = true;
      result.isGPSJump = false;
      result.confidence = 'high';
    } else if (legitimacyScore >= 0.4) {
      result.action = 'accept_with_caution';
      result.reason = 'uncertain_movement';
      result.isLegitimateMovement = true;
      result.isGPSJump = false;
      result.confidence = 'medium';
    } else {
      result.action = 'gps_jump_detected';
      result.reason = 'likely_gps_error';
      result.isLegitimateMovement = false;
      result.isGPSJump = true;
      result.confidence = 'high';
    }

    this._logAnalysis(mmsi, result);
    return result;
  }

  /**
   * Calculate COG change with proper angle wrapping
   * @private
   */
  _calculateCOGChange(currentCOG, previousCOG) {
    if (!Number.isFinite(currentCOG) || !Number.isFinite(previousCOG)) {
      return null;
    }

    let cogChange = Math.abs(currentCOG - previousCOG);
    if (cogChange > 180) {
      cogChange = 360 - cogChange;
    }
    return cogChange;
  }

  /**
   * Check if movement bearing is consistent with reported COG
   * @private
   */
  _checkBearingConsistency(currentPos, prevPos, cog) {
    if (!Number.isFinite(cog)) {
      return null;
    }

    // B5-fix (2026-06-09): calculateBearing KASTAR vid ogiltiga koordinater
    // (till skillnad från calculateDistance som returnerar null) — utan
    // try/catch skulle ett korrupt AIS-meddelande krascha hela jump-analysen.
    let actualBearing;
    try {
      actualBearing = geometry.calculateBearing(
        prevPos.lat, prevPos.lon,
        currentPos.lat, currentPos.lon,
      );
    } catch (error) {
      return null; // ogiltiga koordinater → ingen bearing-bedömning möjlig
    }
    if (!Number.isFinite(actualBearing)) {
      return null;
    }

    const bearingDiff = geometry.normalizeAngleDiff(actualBearing, cog);
    return {
      actualBearing,
      reportedCOG: cog,
      difference: bearingDiff,
      isConsistent: bearingDiff <= 45, // Within 45 degrees is considered consistent
    };
  }

  /**
   * Check if movement distance is consistent with reported speed
   * @private
   */
  _checkSpeedConsistency(movementDistance, currentSOG, oldVessel) {
    const timeElapsedMs = Date.now() - (oldVessel.timestamp || Date.now());
    const timeElapsedHours = timeElapsedMs / (1000 * 60 * 60);

    if (timeElapsedHours <= 0) {
      return null;
    }

    // Convert distance to nautical miles and calculate implied speed
    const movementNM = movementDistance / 1852;
    const impliedSpeed = movementNM / timeElapsedHours;

    const reportedSpeed = currentSOG || 0;
    const speedDiff = Math.abs(impliedSpeed - reportedSpeed);

    return {
      impliedSpeed,
      reportedSpeed,
      speedDiff,
      timeElapsed: timeElapsedHours,
      isConsistent: speedDiff <= Math.max(5, reportedSpeed * 0.5), // Within 50% or 5kn
    };
  }

  /**
   * Calculate legitimacy score (0-1) based on all factors
   * @private
   */
  _calculateLegitimacyScore(analysis) {
    let score = 0;
    let factors = 0;

    // COG change factor - large changes indicate direction changes (legitimate)
    if (analysis.cogChange !== null) {
      if (analysis.cogChange > 90) {
        score += 0.4; // Strong evidence of direction change
      } else if (analysis.cogChange > 45) {
        score += 0.2; // Moderate evidence
      }
      factors++;
    }

    // Bearing consistency factor
    if (analysis.bearingConsistency !== null) {
      if (analysis.bearingConsistency.isConsistent) {
        score += 0.3; // Movement matches reported COG
      } else {
        score -= 0.2; // Movement doesn't match COG - suspicious
      }
      factors++;
    }

    // Speed consistency factor
    if (analysis.speedConsistency !== null) {
      if (analysis.speedConsistency.isConsistent) {
        score += 0.3; // Movement matches reported speed
      } else {
        score -= 0.3; // Movement doesn't match speed - very suspicious
      }
      factors++;
    }

    // SOG change factor - rapid speed changes are common during direction changes
    if (analysis.sogChange > 2) {
      score += 0.1; // Evidence of maneuvering
    }

    return factors > 0 ? Math.max(0, Math.min(1, score / factors + 0.5)) : 0.5;
  }

  /**
   * Log detailed analysis for debugging
   * @private
   */
  _logAnalysis(mmsi, result) {
    const {
      analysis, action, reason, confidence,
    } = result;

    this.logger.debug(
      `🔍 [GPS_ANALYSIS] ${mmsi}: ${action} (${reason}, confidence: ${confidence})\n`
      + `   Distance: ${result.movementDistance.toFixed(0)}m\n`
      + `   COG Change: ${analysis.cogChange?.toFixed(0) || 'N/A'}°\n`
      + `   SOG Change: ${analysis.sogChange?.toFixed(1) || 'N/A'}kn\n`
      + `   Bearing Consistent: ${analysis.bearingConsistency?.isConsistent || 'N/A'}\n`
      + `   Speed Consistent: ${analysis.speedConsistency?.isConsistent || 'N/A'}`,
    );

    if (result.isGPSJump) {
      this.logger.error(
        `🚨 [GPS_JUMP] ${mmsi}: GPS jump detected ${result.movementDistance.toFixed(0)}m - `
        + `COG: ${analysis.cogChange?.toFixed(0) || 'N/A'}°, Speed mismatch: ${!analysis.speedConsistency?.isConsistent}`,
      );
    } else if (result.movementDistance > 500) {
      this.logger.log(
        `🔄 [DIRECTION_CHANGE] ${mmsi}: Large legitimate movement ${result.movementDistance.toFixed(0)}m - `
        + `COG change: ${analysis.cogChange?.toFixed(0) || 'N/A'}°`,
      );
    }
  }
}

module.exports = GPSJumpAnalyzer;
