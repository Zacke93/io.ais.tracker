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
  return R * c;
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
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const lat1Rad = lat1 * (Math.PI / 180);
  const lat2Rad = lat2 * (Math.PI / 180);

  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x = (Math.cos(lat1Rad) * Math.sin(lat2Rad))
           - (Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon));

  const bearing = Math.atan2(y, x) * (180 / Math.PI);
  return (bearing + 360) % 360; // Normalize to 0-360
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
  return distance <= radius;
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
 * @param {Object} prevPos - Previous position {lat, lon}
 * @param {Object} currPos - Current position {lat, lon}
 * @param {Object} bridge - Bridge object with {lat, lon}
 * @param {Object} opts - Options
 * @param {number} opts.minProximityM - Min distance to bridge for valid crossing (default 150m)
 * @returns {boolean} True if vessel crossed the bridge line
 */
function hasCrossedBridgeLine(prevPos, currPos, bridge, opts = {}) {
  const minProximityM = opts.minProximityM || 150;

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

  // Safety check: at least one position must be within proximity threshold
  if (Math.min(prevDist, currDist) > minProximityM) {
    return false;
  }

  // The canal in Trollhättan runs roughly NE-SW (bearing ~35-40°)
  // Bridges are perpendicular to the canal, so they run roughly NW-SE (bearing ~125-130°)
  // We'll use a perpendicular line to the canal's bearing for crossing detection

  // Define the bridge line orientation (perpendicular to canal)
  // Canal bearing is approximately 35° (NE), so bridge bearing is 35° + 90° = 125° (SE)
  const bridgeBearing = bridge.axisBearing || 125; // degrees, can be overridden per bridge

  // Convert to radians (not used directly but kept for clarity)
  // const bearingRad = (bridgeBearing * Math.PI) / 180;

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

  // Check if the vessel crossed the bridge line (projection changes sign)
  const crossedLine = (projPrev < 0 && projCurr > 0) || (projPrev > 0 && projCurr < 0);

  return crossedLine;
}

module.exports = {
  calculateDistance,
  calculateBearing,
  normalizeAngleDiff,
  isWithinRadius,
  isHeadingTowards,
  findNearestBridge,
  hasCrossedBridgeLine,
};
