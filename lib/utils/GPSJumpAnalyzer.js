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
    result.reason = 'medium_movement';
    result.confidence = 'medium';
    return result;
  }

  /**
   * Analyze large movements (>500m) to determine if GPS jump or legitimate movement
   * @private
   */
  _analyzeLargeMovement(mmsi, currentPosition, previousPosition, currentVessel, oldVessel, result) {
    result.analysis = {
      movementDistance: result.movementDistance,
      timeElapsed: Date.now() - (oldVessel.timestamp || Date.now()),
      cogChange: this._calculateCOGChange(currentVessel.cog, oldVessel.cog),
      sogChange: Math.abs((currentVessel.sog || 0) - (oldVessel.sog || 0)),
      bearingConsistency: this._checkBearingConsistency(currentPosition, previousPosition, currentVessel.cog),
      speedConsistency: this._checkSpeedConsistency(result.movementDistance, currentVessel.sog, oldVessel),
    };

    // Evidence of legitimate movement
    const legitimacyScore = this._calculateLegitimacyScore(result.analysis);

    if (legitimacyScore >= 0.7) {
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

    const actualBearing = geometry.calculateBearing(
      prevPos.lat, prevPos.lon,
      currentPos.lat, currentPos.lon,
    );

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
