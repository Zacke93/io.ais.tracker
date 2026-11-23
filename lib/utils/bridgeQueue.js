'use strict';

const {
  BRIDGES, MOORING_ZONES, MOORING_DETECTION, STATUS_HYSTERESIS, UI_CONSTANTS, AIS_CONFIG, INTERMEDIATE_TEXT_QUEUE,
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

function inMooringZone(vessel) {
  return MOORING_ZONES.some((zone) => {
    const distance = geometry.distancePointToSegmentM(vessel.lat, vessel.lon,
      zone.start.lat, zone.start.lon, zone.end.lat, zone.end.lon);
    return Number.isFinite(distance) && distance <= zone.radiusM;
  });
}

function queueBridge(vessel) {
  if (!vessel || vessel._moored || vessel._gpsJumpDetected || vessel._positionUncertain
      || !hasFreshPosition(vessel) || (!vessel.targetBridge && !vessel.passedBridges?.length)
      || MOORING_DETECTION.MOORED_NAV_STATUSES.includes(vessel.navStatus)) return null;
  if (inMooringZone(vessel)) return null;
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
  if (!bridge) return null;
  if (vessel._bridgeOpeningBridgeName === bridge.name && vessel._bridgeOpeningUntil > Date.now()) return null;
  // Positionsbelagd långsam manövrering är också kö. Det separata beviset
  // gör att fartspikar på 0,5–0,9 kn inte startar om stillhetsminuten.
  const evidence = vessel._bridgeQueueApproaches?.[bridge.name];
  if (evidence?.waitConfirmedAt && (!Number.isFinite(vessel.sog) || vessel.sog <= 1)) return bridge.name;
  if (!Number.isFinite(vessel._stationarySince)) return null;
  if (Number.isFinite(vessel.sog) && vessel.sog >= MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN) return null;
  const anchor = vessel._stillnessAnchor;
  const confirmed = vessel.timestamp || 0;
  if (!anchor || confirmed - Math.max(anchor.t, vessel._stationarySince) < 60000) return null;
  const moved = geometry.calculateDistance(anchor.lat, anchor.lon, vessel.lat, vessel.lon);
  if (!Number.isFinite(moved) || moved >= MOORING_DETECTION.NULL_SOG_STILL_RADIUS_M) return null;
  return bridge.name;
}

// U53: ligger bron mellan båten och hennes målbro i färdriktningen? Broarna
// ligger i kanalens ordning efter latitud (Olidebron söderst).
function isIntermediateBridge(bridge, target, direction) {
  if (!bridge || !target || bridge.name === target.name || bridge.name === 'Stallbackabron') return false;
  return direction === 'north' ? bridge.lat < target.lat : bridge.lat > target.lat;
}

/**
 * U53: brotextens kö vid en MELLANBRO (inte målbron) upp till
 * INTERMEDIATE_TEXT_QUEUE.MAX_DISTANCE_M från bron. Samma förutsättningar som
 * queueBridge (färsk och säker position, ingen kajzon, inte förtöjd, bekräftad
 * anflygning i resans riktning, bron opasserad och framför båten) men med
 * textstillheten (textWaitConfirmedAt, VesselDataService._noteBridgeQueueApproach)
 * och hysteresen HOLD_SOG_KN/HOLD_DISTANCE_M för en redan bekräftad väntan. Läses bara av texten (waitingBridgeForText) och
 * ETA-kedjans hållning under texten; status, notiser och öppningstjänst läser
 * waitingBridge som förut.
 * @param {Object} vessel
 * @returns {string|null} brons namn
 */
function intermediateTextQueue(vessel) {
  if (!vessel || vessel._moored || vessel._gpsJumpDetected || vessel._positionUncertain
      || !hasFreshPosition(vessel) || !vessel.targetBridge
      || MOORING_DETECTION.MOORED_NAV_STATUSES.includes(vessel.navStatus)) return null;
  const direction = vessel._routeDirection;
  const target = Object.values(BRIDGES).find((b) => b.name === vessel.targetBridge);
  if (!target || !['north', 'south'].includes(direction) || inMooringZone(vessel)) return null;
  const candidate = Object.values(BRIDGES).map((bridge) => ({
    bridge, distance: geometry.calculateDistance(vessel.lat, vessel.lon, bridge.lat, bridge.lon),
  })).filter(({ bridge, distance }) => {
    const evidence = vessel._bridgeQueueApproaches?.[bridge.name];
    return isIntermediateBridge(bridge, target, direction)
      && evidence?.confirmedAt && evidence.direction === direction
      && !vessel.passedBridges?.includes(bridge.name)
      && beforeBridge(vessel, bridge, direction)
      && Number.isFinite(distance) && distance <= (evidence.textWaitConfirmedAt
      ? INTERMEDIATE_TEXT_QUEUE.HOLD_DISTANCE_M : INTERMEDIATE_TEXT_QUEUE.MAX_DISTANCE_M);
  }).sort((a, b) => a.distance - b.distance)[0];
  if (!candidate) return null;
  const { bridge } = candidate;
  if (vessel._bridgeOpeningBridgeName === bridge.name && vessel._bridgeOpeningUntil > Date.now()) return null;
  const evidence = vessel._bridgeQueueApproaches[bridge.name];
  if (!evidence.textWaitConfirmedAt) return null;
  if (Number.isFinite(vessel.sog) && vessel.sog > INTERMEDIATE_TEXT_QUEUE.HOLD_SOG_KN) return null;
  return bridge.name;
}

/** U53: väntbron som brotexten visar — köbeviset, annars textens mellanbrokö. */
function waitingBridgeForText(vessel) {
  return waitingBridge(vessel) || intermediateTextQueue(vessel);
}

module.exports = {
  beforeBridge,
  hasFreshPosition,
  queueBridge,
  waitingBridge,
  intermediateTextQueue,
  waitingBridgeForText,
  isIntermediateBridge,
};
