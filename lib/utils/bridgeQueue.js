'use strict';

const {
  BRIDGES, MOORING_ZONES, MOORING_DETECTION, STATUS_HYSTERESIS, UI_CONSTANTS, AIS_CONFIG,
} = require('../constants');
const geometry = require('./geometry');

// Köbevis hör till bron framför båten, oberoende av närmaste bro och av
// statusnamnet "waiting" (som också används för båtar under gång i närzonen).
function beforeBridge(vessel, bridge, direction) {
  if (!bridge || !['north', 'south'].includes(direction)) return false;
  const bridges = Object.values(BRIDGES).filter((b) => b.name !== bridge.name)
    .sort((a, b) => Math.abs(a.lat - bridge.lat) - Math.abs(b.lat - bridge.lat));
  let next = bridges.find((b) => (direction === 'north' ? b.lat > bridge.lat : b.lat < bridge.lat));
  if (!next && bridges[0]) {
    next = { lat: 2 * bridge.lat - bridges[0].lat, lon: 2 * bridge.lon - bridges[0].lon };
  }
  return !!next && geometry.isDecisivelyOppositeBridgeSide(vessel, next, bridge);
}

function hasFreshPosition(vessel, now = Date.now()) {
  if (!vessel) return false;
  const confirmed = Math.max(vessel.timestamp || 0, vessel.lastPositionUpdate || 0);
  if (!(confirmed > 0) || now - confirmed > UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS
      || confirmed - now > AIS_CONFIG.AISHUB.SEEN_MAX_FUTURE_SKEW_MS) return false;
  if (vessel.fixFeed === 'aishub') {
    const age = now - vessel.fixTs;
    if (!Number.isFinite(vessel.fixTs) || age > AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS
        || age < -AIS_CONFIG.AISHUB.SEEN_MAX_FUTURE_SKEW_MS) return false;
  }
  return true;
}

function queueBridge(vessel) {
  if (!vessel || vessel._moored || vessel._gpsJumpDetected || vessel._positionUncertain
      || !hasFreshPosition(vessel) || (!vessel.targetBridge && !vessel.passedBridges?.length)
      || MOORING_DETECTION.MOORED_NAV_STATUSES.includes(vessel.navStatus)) return null;
  const atQuay = MOORING_ZONES.some((zone) => {
    const distance = geometry.distancePointToSegmentM(vessel.lat, vessel.lon,
      zone.start.lat, zone.start.lon, zone.end.lat, zone.end.lon);
    return Number.isFinite(distance) && distance <= zone.radiusM;
  });
  if (atQuay) return null;
  return Object.values(BRIDGES).map((bridge) => ({
    bridge,
    distance: geometry.calculateDistance(vessel.lat, vessel.lon, bridge.lat, bridge.lon),
  })).filter(({ bridge, distance }) => {
    const evidence = vessel._bridgeQueueApproaches?.[bridge.name];
    return bridge.name !== 'Stallbackabron' && evidence?.confirmedAt
      && evidence.direction === vessel._routeDirection
      && !vessel.passedBridges?.includes(bridge.name)
      && beforeBridge(vessel, bridge, vessel._routeDirection)
      && Number.isFinite(distance) && distance <= STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE;
  }).sort((a, b) => a.distance - b.distance)[0]?.bridge || null;
}

// Minst två färska positionsrapporter över en minut styrker stillhet.
// Klocktick och AIS-livstecken kan aldrig förvandla en ensam fix till väntan.
function waitingBridge(vessel) {
  const bridge = queueBridge(vessel);
  if (!bridge || !Number.isFinite(vessel._stationarySince)) return null;
  if (Number.isFinite(vessel.sog) && vessel.sog >= MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN) return null;
  const anchor = vessel._stillnessAnchor;
  const confirmed = vessel.timestamp || 0;
  if (!anchor || confirmed - Math.max(anchor.t, vessel._stationarySince) < 60000) return null;
  const moved = geometry.calculateDistance(anchor.lat, anchor.lon, vessel.lat, vessel.lon);
  if (!Number.isFinite(moved) || moved >= MOORING_DETECTION.NULL_SOG_STILL_RADIUS_M) return null;
  if (vessel._bridgeOpeningBridgeName === bridge.name && vessel._bridgeOpeningUntil > Date.now()) return null;
  return bridge.name;
}

module.exports = {
  beforeBridge, hasFreshPosition, queueBridge, waitingBridge,
};
