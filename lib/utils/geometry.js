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

module.exports = {
  calculateDistance,
  calculateBearing,
  normalizeAngleDiff,
  isWithinRadius,
  isHeadingTowards,
  findNearestBridge,
};
