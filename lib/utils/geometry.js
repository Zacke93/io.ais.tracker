'use strict';

/**
 * Geometry utilities for AIS Bridge app
 * Consolidates all distance and bearing calculations from the original app.js
 */

/**
 * Calculate the distance between two points using the Haversine formula
 * @param {number} lat1 - Latitude of first point
 * @param {number} lon1 - Longitude of first point
 * @param {number} lat2 - Latitude of second point
 * @param {number} lon2 - Longitude of second point
 * @returns {number} Distance in meters
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  // CRITICAL FIX: Validate all coordinates are finite numbers
  // FIX: Return null instead of throwing to prevent crashes
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
    // Silent fail - invalid coordinates are expected and handled by caller
    return null;
  }

  // CRITICAL FIX: Validate latitude and longitude ranges
  if (Math.abs(lat1) > 90 || Math.abs(lat2) > 90) {
    // Silent fail - invalid latitude
    return null;
  }
  if (Math.abs(lon1) > 180 || Math.abs(lon2) > 180) {
    // Silent fail - invalid longitude
    return null;
  }

  if (lat1 === lat2 && lon1 === lon2) {
    return 0;
  }

  const R = 6371000; // Earth's radius in meters
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = (Math.sin(dLat / 2) * Math.sin(dLat / 2))
    + (Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)))
    * (Math.sin(dLon / 2) * Math.sin(dLon / 2));
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const result = R * c;

  // CRITICAL FIX: Validate result is finite
  // FIX: Return null instead of throwing
  if (!Number.isFinite(result) || result < 0) {
    // Silent fail - calculation error
    return null;
  }

  return result;
}

/**
 * Calculate bearing from point 1 to point 2
 * @param {number} lat1 - Latitude of starting point
 * @param {number} lon1 - Longitude of starting point
 * @param {number} lat2 - Latitude of ending point
 * @param {number} lon2 - Longitude of ending point
 * @returns {number} Bearing in degrees (0-360)
 */
function calculateBearing(lat1, lon1, lat2, lon2) {
  // CRITICAL FIX: Validate all coordinates are finite numbers
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
    throw new Error(`Invalid coordinates for bearing calculation: lat1=${lat1}, lon1=${lon1}, lat2=${lat2}, lon2=${lon2}`);
  }

  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const lat1Rad = lat1 * (Math.PI / 180);
  const lat2Rad = lat2 * (Math.PI / 180);

  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x = (Math.cos(lat1Rad) * Math.sin(lat2Rad))
           - (Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon));

  const bearing = Math.atan2(y, x) * (180 / Math.PI);
  const result = (bearing + 360) % 360; // Normalize to 0-360

  // CRITICAL FIX: Validate result is finite and in valid range
  if (!Number.isFinite(result) || result < 0 || result >= 360) {
    throw new Error(`Invalid bearing calculation result: ${result}`);
  }

  return result;
}

/**
 * Normalize the difference between two angles
 * @param {number} angle1 - First angle in degrees
 * @param {number} angle2 - Second angle in degrees
 * @returns {number} Normalized angle difference (0-180)
 */
function normalizeAngleDiff(angle1, angle2) {
  let diff = Math.abs(angle1 - angle2);
  if (diff > 180) {
    diff = 360 - diff;
  }
  return diff;
}

/**
 * Check if vessel is within specified radius of a bridge
 * @param {Object} vessel - Vessel object with lat/lon
 * @param {Object} bridge - Bridge object with lat/lon
 * @param {number} radius - Radius in meters
 * @returns {boolean} True if vessel is within radius
 */
function isWithinRadius(vessel, bridge, radius) {
  const distance = calculateDistance(vessel.lat, vessel.lon, bridge.lat, bridge.lon);

  // CRITICAL FIX: Validate distance is a finite number before comparison
  // calculateDistance() can return null/NaN for invalid coordinates
  // Without this check, null <= radius evaluates to true (null coerces to 0)
  return Number.isFinite(distance) && distance <= radius;
}

/**
 * Check if vessel is heading towards a bridge based on Course Over Ground (COG)
 * @param {Object} vessel - Vessel object with lat/lon/cog/sog
 * @param {Object} bridge - Bridge object with lat/lon
 * @param {number} maxAngleDiff - Maximum angle difference in degrees (default: 90)
 * @returns {boolean} True if vessel is heading towards bridge
 */
function isHeadingTowards(vessel, bridge, maxAngleDiff = 90) {
  // Skip check for very slow vessels as COG may be unreliable
  if (vessel.sog < 0.5) {
    return true; // Give benefit of doubt for slow vessels
  }

  const bearingToBridge = calculateBearing(vessel.lat, vessel.lon, bridge.lat, bridge.lon);
  const cogDiff = normalizeAngleDiff(vessel.cog, bearingToBridge);

  return cogDiff < maxAngleDiff;
}

/**
 * Calculate the shortest distance from a point to a line segment (trajectory)
 * This is the mathematical foundation for trajectory-based passage detection.
 *
 * ALGORITHM: Point-to-line-segment distance
 * Given a point P (bridge) and a line segment from A (prev) to B (curr),
 * find the shortest distance from P to any point on the segment AB.
 *
 * @param {Object} point - The point (bridge position) {lat, lon}
 * @param {Object} lineStart - Start of trajectory (previous position) {lat, lon}
 * @param {Object} lineEnd - End of trajectory (current position) {lat, lon}
 * @returns {number|null} Distance in meters, or null if invalid input
 */
function pointToTrajectoryDistance(point, lineStart, lineEnd) {
  // Validate inputs
  if (!point || !lineStart || !lineEnd) {
    return null;
  }

  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)
      || !Number.isFinite(lineStart.lat) || !Number.isFinite(lineStart.lon)
      || !Number.isFinite(lineEnd.lat) || !Number.isFinite(lineEnd.lon)) {
    return null;
  }

  // Convert to meters using local approximation at bridge latitude
  const latScale = 111320; // meters per degree latitude
  const lonScale = 111320 * Math.cos((point.lat * Math.PI) / 180);

  // Convert all points to metric coordinates relative to bridge (point)
  // Bridge is at origin (0, 0)
  const px = 0;
  const py = 0;
  const ax = (lineStart.lon - point.lon) * lonScale;
  const ay = (lineStart.lat - point.lat) * latScale;
  const bx = (lineEnd.lon - point.lon) * lonScale;
  const by = (lineEnd.lat - point.lat) * latScale;

  // Vector from A to B
  const abx = bx - ax;
  const aby = by - ay;

  // Length squared of AB
  const abLenSquared = abx * abx + aby * aby;

  // Handle degenerate case: A and B are the same point
  if (abLenSquared < 0.0001) {
    // Return distance from bridge to point A
    return Math.sqrt(ax * ax + ay * ay);
  }

  // Calculate projection parameter t
  // t represents where the closest point on line AB is:
  // t=0 means closest to A, t=1 means closest to B, 0<t<1 means between A and B
  const apx = px - ax;
  const apy = py - ay;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSquared));

  // Calculate the closest point on the line segment
  const closestX = ax + t * abx;
  const closestY = ay + t * aby;

  // Calculate distance from bridge (origin) to closest point
  const distance = Math.sqrt(closestX * closestX + closestY * closestY);

  return Number.isFinite(distance) ? distance : null;
}

/**
 * Check if vessel trajectory crossed the bridge line
 * TRAJECTORY-BASED VERSION: Uses point-to-line distance instead of proximity threshold
 *
 * This solves the fundamental problem of sparse AIS data by asking:
 * "Did the vessel's PATH pass near the bridge?" instead of
 * "Was the vessel POSITION near the bridge?"
 *
 * @param {Object} prevPos - Previous position {lat, lon}
 * @param {Object} currPos - Current position {lat, lon}
 * @param {Object} bridge - Bridge object {lat, lon, axisBearing}
 * @param {Object} opts - Options
 * @param {number} opts.maxTrajectoryDistance - Max distance from bridge to trajectory (default 120m)
 * @returns {boolean} True if vessel crossed the bridge line
 */
function hasCrossedBridgeLineTrajectory(prevPos, currPos, bridge, opts = {}) {
  // Maximum distance from bridge to trajectory for valid crossing
  // Canal is ~50-80m wide, so 120m allows for some GPS error margin
  const maxTrajectoryDistance = opts.maxTrajectoryDistance || 120;

  // Validate inputs
  if (!prevPos || !currPos || !bridge) {
    return false;
  }

  if (typeof prevPos.lat !== 'number' || typeof prevPos.lon !== 'number'
      || typeof currPos.lat !== 'number' || typeof currPos.lon !== 'number'
      || typeof bridge.lat !== 'number' || typeof bridge.lon !== 'number') {
    return false;
  }

  // STEP 1: Calculate shortest distance from bridge to vessel trajectory
  const trajectoryDistance = pointToTrajectoryDistance(bridge, prevPos, currPos);

  if (trajectoryDistance === null || trajectoryDistance > maxTrajectoryDistance) {
    return false; // Vessel's path did not pass near enough to the bridge
  }

  // STEP 2: Verify vessel actually CROSSED the bridge line (changed sides)
  const bridgeBearing = bridge.axisBearing || 125;
  const perpBearing = ((bridgeBearing - 90) * Math.PI) / 180;

  const latScale = 111320;
  const lonScale = 111320 * Math.cos((bridge.lat * Math.PI) / 180);

  // Convert positions to metric offsets from bridge
  const dLatPrev = (prevPos.lat - bridge.lat) * latScale;
  const dLonPrev = (prevPos.lon - bridge.lon) * lonScale;
  const dLatCurr = (currPos.lat - bridge.lat) * latScale;
  const dLonCurr = (currPos.lon - bridge.lon) * lonScale;

  // Project positions onto the canal axis (perpendicular to bridge)
  const projPrev = dLatPrev * Math.cos(perpBearing) + dLonPrev * Math.sin(perpBearing);
  const projCurr = dLatCurr * Math.cos(perpBearing) + dLonCurr * Math.sin(perpBearing);

  // Validate projections
  if (!Number.isFinite(projPrev) || !Number.isFinite(projCurr)) {
    return false;
  }

  // Check if vessel crossed the bridge line (projection changes sign)
  const crossedLine = (projPrev < 0 && projCurr > 0) || (projPrev > 0 && projCurr < 0);

  return crossedLine;
}

/**
 * Find the nearest bridge to a vessel
 * @param {Object} vessel - Vessel object with lat/lon
 * @param {Object} bridges - Bridge registry object
 * @returns {Object|null} Nearest bridge info with distance, or null
 */
function findNearestBridge(vessel, bridges) {
  let nearestBridge = null;
  let nearestDistance = Infinity;
  let nearestBridgeId = null;

  for (const [bridgeId, bridge] of Object.entries(bridges)) {
    const distance = calculateDistance(vessel.lat, vessel.lon, bridge.lat, bridge.lon);
    if (distance === null) continue;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestBridge = bridge;
      nearestBridgeId = bridgeId;
    }
  }

  return nearestBridge ? {
    bridge: nearestBridge,
    bridgeId: nearestBridgeId,
    distance: nearestDistance,
  } : null;
}

/**
 * Check if a vessel has crossed a bridge line based on two positions
 * ENHANCED VERSION: More robust detection for maneuvering vessels
 * @param {Object} prevPos - Previous position {lat, lon}
 * @param {Object} currPos - Current position {lat, lon}
 * @param {Object} bridge - Bridge object with {lat, lon}
 * @param {Object} opts - Options
 * @param {number} opts.minProximityM - Min distance to bridge for valid crossing (default 250m - increased for sparse AIS)
 * @param {number} opts.maxDistanceM - Max distance for either position (default 400m)
 * @param {boolean} opts.relaxedMode - Allow more lenient crossing detection (default false)
 * @returns {boolean} True if vessel crossed the bridge line
 */
function hasCrossedBridgeLine(prevPos, currPos, bridge, opts = {}) {
  const minProximityM = opts.minProximityM || 250; // Increased from 200m for better sparse AIS handling
  const maxDistanceM = opts.maxDistanceM || 400; // Increased from 300m
  const relaxedMode = opts.relaxedMode || false;

  // Validate inputs
  if (!prevPos || !currPos || !bridge) {
    return false;
  }

  if (typeof prevPos.lat !== 'number' || typeof prevPos.lon !== 'number'
      || typeof currPos.lat !== 'number' || typeof currPos.lon !== 'number'
      || typeof bridge.lat !== 'number' || typeof bridge.lon !== 'number') {
    return false;
  }

  // Calculate distances to bridge using existing function
  const prevDist = calculateDistance(prevPos.lat, prevPos.lon, bridge.lat, bridge.lon);
  const currDist = calculateDistance(currPos.lat, currPos.lon, bridge.lat, bridge.lon);
  if (prevDist === null || currDist === null) return false;

  // ENHANCED: Multiple validation modes
  let proximityValid = false;

  if (relaxedMode) {
    // Relaxed mode: Either position within proximity OR reasonable distance change
    proximityValid = Math.min(prevDist, currDist) <= minProximityM
                    || (Math.max(prevDist, currDist) <= maxDistanceM && Math.abs(prevDist - currDist) > 50);
  } else {
    // Standard mode: At least one position must be within proximity threshold
    proximityValid = Math.min(prevDist, currDist) <= minProximityM;
  }

  if (!proximityValid) {
    return false;
  }

  // The canal in Trollhättan runs roughly NE-SW (bearing ~35-40°)
  // Bridges are perpendicular to the canal, so they run roughly NW-SE (bearing ~125-130°)
  // We'll use a perpendicular line to the canal's bearing for crossing detection

  // Define the bridge line orientation (perpendicular to canal)
  // Canal bearing is approximately 35° (NE), so bridge bearing is 35° + 90° = 125° (SE)
  const bridgeBearing = bridge.axisBearing || 125; // degrees, can be overridden per bridge

  // Create a vector perpendicular to the bridge line for projection
  // The perpendicular to bearing 125° is bearing 35° (canal direction)
  const perpBearing = ((bridgeBearing - 90) * Math.PI) / 180;

  // FIX: Scale lat/lon to meters before projection (accounting for latitude)
  const latScale = 111320; // meters per degree latitude
  const lonScale = 111320 * Math.cos((bridge.lat * Math.PI) / 180); // meters per degree longitude at bridge latitude

  // Convert positions to metric offsets from bridge
  const dLatPrev = (prevPos.lat - bridge.lat) * latScale;
  const dLonPrev = (prevPos.lon - bridge.lon) * lonScale;
  const dLatCurr = (currPos.lat - bridge.lat) * latScale;
  const dLonCurr = (currPos.lon - bridge.lon) * lonScale;

  // Project vessel positions onto the perpendicular axis (along canal) using metric coordinates
  const projPrev = dLatPrev * Math.cos(perpBearing) + dLonPrev * Math.sin(perpBearing);
  const projCurr = dLatCurr * Math.cos(perpBearing) + dLonCurr * Math.sin(perpBearing);

  // Validate projections are valid numbers before checking crossing
  if (!Number.isFinite(projPrev) || !Number.isFinite(projCurr)) {
    return false; // Invalid projection, cannot determine crossing
  }

  // Check if the vessel crossed the bridge line (projection changes sign)
  const crossedLine = (projPrev < 0 && projCurr > 0) || (projPrev > 0 && projCurr < 0);

  return crossedLine;
}

/**
 * Enhanced passage detection that combines multiple methods
 * @param {Object} vessel - Current vessel position and data
 * @param {Object} oldVessel - Previous vessel position and data
 * @param {Object} bridge - Bridge object with {lat, lon, name}
 * @param {Object} opts - Options for detection sensitivity
 * @returns {Object} Detection result with method used and confidence
 */
function detectBridgePassage(vessel, oldVessel, bridge, opts = {}) {
  // Validate inputs
  if (!vessel || !oldVessel || !bridge) {
    return { passed: false, method: 'invalid_input', confidence: 0 };
  }

  if (!Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)
      || !Number.isFinite(oldVessel.lat) || !Number.isFinite(oldVessel.lon)) {
    return { passed: false, method: 'invalid_coordinates', confidence: 0 };
  }

  // Calculate distances
  const currentDistance = calculateDistance(vessel.lat, vessel.lon, bridge.lat, bridge.lon);
  const previousDistance = calculateDistance(oldVessel.lat, oldVessel.lon, bridge.lat, bridge.lon);
  const movementDistance = calculateDistance(vessel.lat, vessel.lon, oldVessel.lat, oldVessel.lon);

  // Prepare position objects for line crossing checks
  const prevPos = { lat: oldVessel.lat, lon: oldVessel.lon };
  const currPos = { lat: vessel.lat, lon: vessel.lon };

  // METHOD 1: Traditional close passage detection (highest confidence)
  const wasVeryClose = previousDistance <= 50;
  const isNowFarther = currentDistance > previousDistance;
  const isNowReasonablyFar = currentDistance > 60;
  const traditionalPassed = wasVeryClose && isNowFarther && isNowReasonablyFar;

  if (traditionalPassed) {
    return {
      passed: true,
      method: 'traditional_close_passage',
      confidence: 0.95,
      details: { previousDistance, currentDistance },
    };
  }

  // METHOD 2: TRAJECTORY-BASED PASSAGE DETECTION (NEW - solves sparse AIS problem)
  // This method asks "did the vessel's PATH pass near the bridge?" instead of
  // "was the vessel's POSITION near the bridge?"
  // This is mathematically correct and handles sparse AIS data perfectly.
  const trajectoryDistance = pointToTrajectoryDistance(bridge, prevPos, currPos);

  if (trajectoryDistance !== null) {
    // Use trajectory-based detection with appropriate threshold
    // Canal is ~50-80m wide, 120m allows for GPS error margin
    const maxTrajectoryDist = 120;

    if (trajectoryDistance <= maxTrajectoryDist) {
      // Trajectory passed near bridge - now verify it actually CROSSED the bridge line
      const trajectoryCrossed = hasCrossedBridgeLineTrajectory(prevPos, currPos, bridge, {
        maxTrajectoryDistance: maxTrajectoryDist,
      });

      if (trajectoryCrossed) {
        // Additional validation: ensure vessel is moving away (not towards)
        // This prevents false positives from vessels approaching the bridge
        const isMovingAway = currentDistance >= previousDistance - 20;

        if (isMovingAway) {
          return {
            passed: true,
            method: 'trajectory_based_passage',
            confidence: 0.92,
            details: {
              previousDistance,
              currentDistance,
              trajectoryDistance,
              movementDistance,
            },
          };
        }
      }
    }
  }

  // METHOD 3: Enhanced line crossing with relaxed mode for maneuvering boats
  // Try standard line crossing first with improved thresholds
  let lineCrossed = hasCrossedBridgeLine(prevPos, currPos, bridge, {
    minProximityM: 250, // Increased for sparse AIS
    maxDistanceM: 400,
  });

  // If standard fails, try relaxed mode for maneuvering vessels
  if (!lineCrossed && movementDistance > 100) {
    lineCrossed = hasCrossedBridgeLine(prevPos, currPos, bridge, {
      minProximityM: 300, // Even more relaxed
      maxDistanceM: 500,
      relaxedMode: true,
    });
  }

  if (lineCrossed) {
    // Additional validation: ensure vessel is generally moving away from bridge area
    // Be more lenient with movement validation for maneuvering vessels
    const isGenerallyMovingAway = currentDistance > Math.min(previousDistance - 30, previousDistance * 0.7);
    const isReasonableDistance = currentDistance > 40; // Must be some distance from bridge

    if (isGenerallyMovingAway || isReasonableDistance) {
      return {
        passed: true,
        method: 'enhanced_line_crossing',
        confidence: 0.85,
        details: { previousDistance, currentDistance, movementDistance },
      };
    }
  }

  // METHOD 4: Progressive distance detection for moderate passages
  const wasNear = previousDistance <= 200; // Increased threshold
  const isProgressingAway = currentDistance > previousDistance + 10; // Reduced requirement
  const isFarEnough = currentDistance > 80; // Reduced threshold
  const moderatePassed = wasNear && isProgressingAway && isFarEnough;

  if (moderatePassed) {
    return {
      passed: true,
      method: 'progressive_distance',
      confidence: 0.75,
      details: { previousDistance, currentDistance },
    };
  }

  // METHOD 5: Direction-based passage for vessels that change course near bridges
  // FIX 6+BUG2: Require minimum SOG and actual movement to prevent stationary/drifting vessels from triggering false passages
  if (vessel.cog !== undefined && oldVessel.cog !== undefined
      && vessel.sog > 1.5 && oldVessel.sog > 1.0 && movementDistance > 30) {
    const cogChange = Math.abs(normalizeAngleDiff(vessel.cog, oldVessel.cog));
    const wasModeratelyClose = previousDistance <= 250; // Increased threshold
    const hasSignificantCogChange = cogChange > 60; // Reduced requirement
    const isMovingAway = currentDistance > previousDistance - 10; // More lenient

    if (wasModeratelyClose && hasSignificantCogChange && isMovingAway && currentDistance > 60) {
      return {
        passed: true,
        method: 'direction_change_passage',
        confidence: 0.70,
        details: {
          previousDistance, currentDistance, cogChange, movementDistance,
        },
      };
    }
  }

  // METHOD 6: Stallbackabron special case - higher bridge, different pattern
  if (bridge.name === 'Stallbackabron') {
    const wasNearStallbacka = previousDistance <= 120; // Increased threshold
    const isAwayFromStallbacka = currentDistance > previousDistance - 5 && currentDistance > 50; // More lenient

    if (wasNearStallbacka && isAwayFromStallbacka) {
      return {
        passed: true,
        method: 'stallbacka_special',
        confidence: 0.80,
        details: { previousDistance, currentDistance },
      };
    }
  }

  // Return detailed info about why passage was NOT detected - crucial for debugging
  // when Stridsbergsbron/Järnvägsbron passages are missed
  return {
    passed: false,
    method: 'no_passage_detected',
    confidence: 0,
    details: {
      previousDistance,
      currentDistance,
      movementDistance,
      trajectoryDistance: trajectoryDistance !== null ? trajectoryDistance : 'N/A',
      lineCrossResult: lineCrossed ? 'crossed' : 'not_crossed',
      wasVeryClose: previousDistance <= 50,
      wasNear: previousDistance <= 200,
      isMovingAway: currentDistance > previousDistance,
    },
  };
}

module.exports = {
  calculateDistance,
  calculateBearing,
  normalizeAngleDiff,
  isWithinRadius,
  isHeadingTowards,
  findNearestBridge,
  hasCrossedBridgeLine,
  hasCrossedBridgeLineTrajectory,
  pointToTrajectoryDistance,
  detectBridgePassage,
};
