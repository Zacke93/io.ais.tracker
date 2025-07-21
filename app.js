/* ====================================================================
   AIS Bridge – Robust och skalbar arkitektur
   ==================================================================== */

/* eslint-disable max-classes-per-file */

'use strict';

const Homey = require('homey');
const EventEmitter = require('events');

// Constants
const GRACE_MISSES = 3;
const APPROACH_RADIUS = 300; // when "near bridge" triggers
const GRACE_PERIOD_MS = 30000; // 30 seconds
const DIAGONAL_MOVE_THRESHOLD = 50; // meters
const HYSTERESIS_FACTOR = 0.9; // 10% closer required
const UNDER_BRIDGE_DISTANCE = 50; // meters
const WAITING_SPEED_THRESHOLD = 0.20; // knots
const WAITING_TIME_THRESHOLD = 120000; // 2 minutes
const MAX_RECONNECT_ATTEMPTS = 10; // max WebSocket reconnection attempts
const MAX_RECONNECT_DELAY = 5 * 60 * 1000; // 5 minutes max delay

// ============= MODUL 1: VESSEL STATE MANAGER =============
class VesselStateManager extends EventEmitter {
  constructor(logger, bridges = null) {
    super();
    this.logger = logger;
    this.bridges = bridges;
    this.vessels = new Map(); // Map<mmsi, VesselData>
    this.bridgeVessels = new Map(); // Map<bridgeId, Set<mmsi>>
    this.cleanupTimers = new Map(); // Map<mmsi, timeoutId>
    this.triggeredFlows = new Map(); // Map<"mmsi-bridgeId", true> för att spåra triggade flows per session
  }

  // Debug helper method
  debug(message) {
    if (this.logger && this.logger.debug) {
      this.logger.debug(message);
    }
  }

  // Bridge lookup helper method
  _findBridgeIdByName(name) {
    for (const [id, bridge] of Object.entries(this.bridges)) {
      if (bridge.name === name) return id;
    }
    return null;
  }

  updateVessel(mmsi, data) {
    const oldData = this.vessels.get(mmsi);
    const isNewVessel = !oldData;

    // Initial filtering for new vessels with speed 0.0
    if (isNewVessel && data.sog === 0 && this.bridges) {
      // Check distance to nearest bridge
      let nearestDistance = Infinity;
      for (const bridge of Object.values(this.bridges)) {
        const distance = this._calculateDistance(data.lat, data.lon, bridge.lat, bridge.lon);
        if (distance < nearestDistance) {
          nearestDistance = distance;
        }
      }

      // Don't register stationary vessels >100m from any bridge
      if (nearestDistance > 100) {
        this.logger.debug(
          `🚫 [VESSEL_FILTER] Ignorerar stillastående fartyg ${mmsi} - ${nearestDistance.toFixed(0)}m från närmaste bro`,
        );
        return null;
      }
    }

    // 🚨 ENHANCED POSITION TRACKING: Robust movement detection and tracking

    // Calculate actual position change for better tracking
    const currentPosition = { lat: data.lat, lon: data.lon };
    const previousPosition = oldData ? { lat: oldData.lat, lon: oldData.lon } : null;

    // Determine if vessel has moved significantly (>5m) since last update
    let positionChangeTime = Date.now();
    if (oldData && previousPosition) {
      const actualMovement = this._calculateDistance(
        previousPosition.lat, previousPosition.lon,
        currentPosition.lat, currentPosition.lon,
      );

      // Only update position change time if movement is significant
      if (actualMovement <= 5) {
        positionChangeTime = oldData.lastPositionChange || Date.now();
      }

      this.logger.debug(
        `📍 [POSITION_TRACKING] ${mmsi}: rörelse ${actualMovement.toFixed(1)}m, `
        + `uppdaterar change time: ${actualMovement > 5 ? 'JA' : 'NEJ'}`,
      );
    }

    const vesselData = {
      mmsi,
      lat: data.lat,
      lon: data.lon,
      sog: data.sog,
      cog: data.cog,
      dirString: data.dirString || 'okänd', // 🆕 så Flow-korten får riktning
      timestamp: Date.now(),
      name: data.name || 'Unknown',
      speedHistory: this._updateSpeedHistory(oldData?.speedHistory, data.sog),
      maxRecentSpeed: this._calculateMaxRecentSpeed(oldData, data.sog),
      lastActiveTime:
        data.sog > 2.0 ? Date.now() : oldData?.lastActiveTime || Date.now(),
      passedBridges: oldData?.passedBridges || [],
      gracePeriod: false,
      towards: data.towards ?? null, // 🆕 om du vill använda det i timeout-logiken
      graceMisses: oldData?.graceMisses || 0, // Track consecutive irrelevant detections
      status: oldData?.status || 'en-route', // 🆕 förbättrad statusspårning
      targetBridge: oldData?.targetBridge || null, // 🆕 målbro
      nearBridge: oldData?.nearBridge || null, // 🆕 närmaste bro
      etaMinutes: oldData?.etaMinutes || null, // 🆕 ETA till målbro
      waitSince: oldData?.waitSince || null, // 🆕 väntdetektor
      speedBelowThresholdSince: oldData?.speedBelowThresholdSince || null, // 🆕 kontinuerlig låg hastighet tracking
      lastPassedBridgeTime: oldData?.lastPassedBridgeTime || null, // 🆕 tidsstämpel för "precis passerat" meddelanden
      lastPosition: previousPosition, // 🚨 ENHANCED: Store actual previous position
      lastPositionChange: positionChangeTime, // 🚨 ENHANCED: Accurate position change tracking
      // Initialize flags based on status for consistency
      isApproaching: (oldData?.status === 'approaching') || oldData?.isApproaching || false,
      isWaiting: (oldData?.status === 'waiting') || oldData?.isWaiting || false,
      _targetAssignmentAttempts: oldData?._targetAssignmentAttempts || 0, // 🆕 Track assignment attempts for debugging
    };

    // 🚨 CRITICAL TARGET BRIDGE FIX: Proactive Early Assignment for New Vessels
    if (isNewVessel && !vesselData.targetBridge && this.bridges) {
      const earlyTarget = this._proactiveTargetBridgeAssignment(vesselData);
      if (earlyTarget) {
        vesselData.targetBridge = earlyTarget;
        vesselData._targetAssignmentAttempts = 1;
        this.logger.debug(
          `🎯 [PROACTIVE_TARGET] Ny båt ${mmsi} fick målbro: ${earlyTarget} (COG: ${data.cog?.toFixed(1)}°, hastighet: ${data.sog?.toFixed(1)}kn)`,
        );
      } else {
        vesselData._targetAssignmentAttempts = 0;
        this.logger.debug(
          `⏳ [PROACTIVE_TARGET] Ny båt ${mmsi} väntar på målbro-tilldelning (COG: ${data.cog?.toFixed(1)}°, hastighet: ${data.sog?.toFixed(1)}kn)`,
        );
      }
    }

    // Nollställ graceMisses om fartyget är relevant igen
    if (data.towards || data.sog > 0.5) {
      vesselData.graceMisses = 0;
    }

    // 🚨 DEFENSIVE: Återställ speedBelowThresholdSince med hysteresis mot GPS-brus
    try {
      const speedResetThreshold = WAITING_SPEED_THRESHOLD + 0.1; // Add 0.1kn hysteresis to prevent GPS noise
      if (typeof data.sog === 'number' && data.sog > speedResetThreshold && oldData?.speedBelowThresholdSince) {
        // Add additional protection: only reset if speed has been consistently high
        if (!vesselData._waitingResetWarning || Date.now() - vesselData._waitingResetWarning > 30000) {
          vesselData._waitingResetWarning = Date.now();
          vesselData.speedBelowThresholdSince = null;
          this.logger.debug(
            `🏃 [WAITING_LOGIC] Fartyg ${mmsi} hastighet ökade över ${speedResetThreshold} kn (${data.sog.toFixed(2)} kn), återställer waiting timer med hysteresis`,
          );
        }
      }
    } catch (speedResetError) {
      this.logger.warn(`⚠️ [WAITING_LOGIC] Defensive: Speed threshold reset failed for ${mmsi}:`, speedResetError.message);
    }

    // Rensa lastPassedBridgeTime efter smart tidsfönster
    if (oldData?.lastPassedBridgeTime) {
      const timeWindow = this._calculatePassageWindow(vesselData);
      const timeSincePassed = Date.now() - oldData.lastPassedBridgeTime;

      if (timeSincePassed > timeWindow) {
        vesselData.lastPassedBridgeTime = null;
        this.logger.debug(
          `⏰ [TIMESTAMP_CLEANUP] Rensar lastPassedBridgeTime för ${mmsi} - tidsfönster (${timeWindow / 1000}s) har passerat`,
        );
      }
    }

    // Nollställ miss-räknare när fart sjunker kraftigt (från > 0.5 till < 0.2 kn utanför brozon)
    if (oldData && oldData.sog > 0.5 && data.sog < 0.2) {
      vesselData.graceMisses = 0;
      this.logger.debug(
        `🔄 [MISS_RESET] Nollställer miss-räknare för ${mmsi} - hastighet sjönk från ${oldData.sog.toFixed(2)} till ${data.sog.toFixed(2)} kn`,
      );
    }

    this.vessels.set(mmsi, vesselData);
    // Sätt ett preliminärt avstånd tills BridgeMonitor hunnit fylla på
    vesselData._distanceToNearest = oldData?._distanceToNearest ?? APPROACH_RADIUS + 1;
    this._scheduleCleanup(mmsi);

    // 🚨 CRITICAL TARGET BRIDGE FIX: Continuous Health Monitoring
    if (!vesselData.targetBridge && !isNewVessel) {
      vesselData._targetAssignmentAttempts = (vesselData._targetAssignmentAttempts || 0) + 1;

      // Try backup assignment for existing vessels without targetBridge
      if (vesselData._targetAssignmentAttempts <= 3 && vesselData.sog > 0.5) {
        const backupTarget = this._proactiveTargetBridgeAssignment(vesselData);
        if (backupTarget) {
          vesselData.targetBridge = backupTarget;
          this.logger.debug(
            `🔄 [BACKUP_TARGET] Båt ${mmsi} fick backup målbro: ${backupTarget} (försök ${vesselData._targetAssignmentAttempts})`,
          );
        } else {
          this.logger.debug(
            `⏳ [BACKUP_TARGET] Båt ${mmsi} väntar fortfarande på målbro (försök ${vesselData._targetAssignmentAttempts})`,
          );
        }
      } else if (vesselData._targetAssignmentAttempts > 3) {
        this.logger.debug(
          `⚠️ [TARGET_HEALTH] Båt ${mmsi} har ${vesselData._targetAssignmentAttempts} misslyckade målbro-försök`,
        );
      }
    }

    // Reset assignment attempts when targetBridge is successfully set
    if (vesselData.targetBridge && vesselData._targetAssignmentAttempts > 0) {
      vesselData._targetAssignmentAttempts = 0;
    }

    // Emit vessel:entered event for new vessels
    if (isNewVessel) {
      this.logger.debug(
        `🚢 [VESSEL_ENTRY] Nytt fartyg upptäckt: ${mmsi} (${vesselData.name})`,
      );
      this.emit('vessel:entered', { mmsi, data: vesselData });
    }

    this.emit('vessel:updated', { mmsi, data: vesselData, oldData });
    return vesselData;
  }

  removeVessel(mmsi) {
    const vessel = this.vessels.get(mmsi);
    if (!vessel) return;

    // NYTT: Kontrollera protectedUntil för väntande båtar
    if (vessel.protectedUntil && Date.now() < vessel.protectedUntil) {
      this.logger.warn(`⚠️ [WAITING_PROTECTION] Försöker ta bort skyddad väntande båt ${mmsi} - AVBRYTER (skyddat till ${new Date(vessel.protectedUntil).toLocaleTimeString()})`);
      return;
    }

    // NYTT: Kontrollera om båten är inom 300m från någon bro
    for (const bridge of Object.values(this.bridges)) {
      const distance = this._calculateDistance(
        vessel.lat, vessel.lon, bridge.lat, bridge.lon,
      );
      if (distance <= 300) {
        this.logger.warn(`⚠️ [PROTECTION_ZONE] Försöker ta bort båt ${mmsi} inom 300m från ${bridge.name} (${distance.toFixed(0)}m) - AVBRYTER`);
        return; // Avbryt borttagning
      }
    }

    this.logger.debug(
      `🗑️ [VESSEL_REMOVAL] Fartyg ${mmsi} (${vessel.name}) tas bort från systemet`,
    );

    // CRITICAL: Cancel cleanup timer first to prevent memory leak
    this._cancelCleanup(mmsi);

    // Rensa trigger-historik för fartyget
    this.clearTriggerHistory(mmsi);

    // Rensa passedBridges innan borttagning
    if (vessel.passedBridges && vessel.passedBridges.length > 0) {
      this.logger.debug(
        `🌉 [VESSEL_REMOVAL] Rensar ${vessel.passedBridges.length} passerade broar för ${mmsi}`,
      );
      vessel.passedBridges = [];
    }

    // Rensa lastPassedBridgeTime för att förhindra minnesproblem
    if (vessel.lastPassedBridgeTime) {
      this.logger.debug(
        `⏰ [VESSEL_REMOVAL] Rensar lastPassedBridgeTime för ${mmsi}`,
      );
      delete vessel.lastPassedBridgeTime;
    }

    // Rensa alla temporära variabler för att förhindra minnesläckor
    const tempVars = [
      '_lockNearBridge', '_wasInsideBridge', '_wasInsideTarget', '_wasInsideNear',
      '_approachBearing', '_targetApproachBearing', '_nearApproachBearing',
      '_targetApproachTime', '_nearApproachTime', '_nearBridgeId',
      '_bridgeApproachId', '_closestBridgeDistance',
      '_lastBridgeDistance', '_previousBridgeDistance', '_targetClearAttempts',
      '_cogChangeCount', '_proposedTarget', '_detectedTargetBridge',
      '_minDistanceToBridge', '_minDistanceTime', // 🆕 nya variabler för avståndsspårning
    ];

    tempVars.forEach((key) => {
      if (vessel[key] !== undefined) {
        this.logger.debug(`🧹 [VESSEL_REMOVAL] Rensar ${key} för ${mmsi}`);
        delete vessel[key];
      }
    });

    this.vessels.delete(mmsi);

    // Remove from all bridge associations - säker radering under iteration
    const affected = [];
    for (const [bridgeId, vessels] of this.bridgeVessels) {
      if (vessels.delete(mmsi) && vessels.size === 0) {
        affected.push(bridgeId);
      }
    }
    affected.forEach((id) => this.bridgeVessels.delete(id));

    this.emit('vessel:removed', { mmsi, vessel });
  }

  associateVesselWithBridge(mmsi, bridgeId, distance) {
    if (!this.vessels.has(mmsi)) return;

    if (!this.bridgeVessels.has(bridgeId)) {
      this.bridgeVessels.set(bridgeId, new Set());
    }

    const wasNew = !this.bridgeVessels.get(bridgeId).has(mmsi);
    this.bridgeVessels.get(bridgeId).add(mmsi);

    if (wasNew) {
      this.emit('bridge:vessel-added', { bridgeId, mmsi, distance });
    }
  }

  disassociateVesselFromBridge(mmsi, bridgeId) {
    const vessels = this.bridgeVessels.get(bridgeId);
    if (!vessels) return;

    const wasRemoved = vessels.delete(mmsi);
    if (wasRemoved) {
      if (vessels.size === 0) {
        this.bridgeVessels.delete(bridgeId);
      }
      this.emit('bridge:vessel-removed', { bridgeId, mmsi });
    }
  }

  getVesselsByBridge(bridgeId) {
    const vesselSet = this.bridgeVessels.get(bridgeId);
    if (!vesselSet) return [];

    return Array.from(vesselSet)
      .map((mmsi) => this.vessels.get(mmsi))
      .filter((vessel) => vessel !== undefined);
  }

  _calculateDistance(lat1, lon1, lat2, lon2) {
    // 🚨 DEFENSIVE: Simple distance calculation for initial filtering with error protection
    try {
      // Validate inputs
      if (typeof lat1 !== 'number' || typeof lon1 !== 'number'
          || typeof lat2 !== 'number' || typeof lon2 !== 'number') {
        this.logger.warn(`⚠️ [DISTANCE_CALC] Defensive: Invalid coordinates - lat1:${lat1}, lon1:${lon1}, lat2:${lat2}, lon2:${lon2}`);
        return Infinity; // Return safe distance for filtering logic
      }

      // Check for NaN or infinite values
      if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
        this.logger.warn('⚠️ [DISTANCE_CALC] Defensive: Non-finite coordinates - returning Infinity');
        return Infinity;
      }

      const R = 6371000; // Earth radius in meters
      const dLat = ((lat2 - lat1) * Math.PI) / 180;
      const dLon = ((lon2 - lon1) * Math.PI) / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
        + Math.cos((lat1 * Math.PI) / 180)
          * Math.cos((lat2 * Math.PI) / 180)
          * Math.sin(dLon / 2)
          * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distance = R * c;

      // Validate result
      if (!Number.isFinite(distance) || distance < 0) {
        this.logger.warn(`⚠️ [DISTANCE_CALC] Defensive: Invalid result ${distance} - returning Infinity`);
        return Infinity;
      }

      return distance;
    } catch (distanceError) {
      this.logger.error('🚨 [DISTANCE_CALC] Defensive: Distance calculation failed:', distanceError.message);
      return Infinity; // Safe fallback for distance filtering
    }
  }

  _scheduleCleanup(mmsi) {
    this._cancelCleanup(mmsi);

    const vessel = this.vessels.get(mmsi);
    if (!vessel) return;

    const timeout = this._calculateTimeout(vessel);
    const timerId = setTimeout(() => {
      this._performCleanup(mmsi);
    }, timeout);

    this.cleanupTimers.set(mmsi, timerId);
  }

  _cancelCleanup(mmsi) {
    const timerId = this.cleanupTimers.get(mmsi);
    if (timerId) {
      clearTimeout(timerId);
      this.cleanupTimers.delete(mmsi);
    }
  }

  _performCleanup(mmsi) {
    const vessel = this.vessels.get(mmsi);
    if (!vessel) {
      // Vessel was removed by other means, clean up timer reference
      this._cancelCleanup(mmsi);
      return;
    }

    const age = Date.now() - vessel.timestamp;
    const timeout = this._calculateTimeout(vessel);

    if (age > timeout && vessel.status !== 'waiting') {
      if (!vessel.gracePeriod) {
        vessel.gracePeriod = true;
        vessel.graceStartTime = Date.now();
        this._scheduleCleanup(mmsi); // Re-schedule for grace period
        this.emit('vessel:grace-period', { mmsi, vessel });
      } else if (Date.now() - vessel.graceStartTime > GRACE_PERIOD_MS) {
        this.removeVessel(mmsi);
      }
    } else {
      // Vessel is still valid, properly cancel the timer
      this._cancelCleanup(mmsi);
    }
  }

  /**
   * Detekterar vilka broar som fartyg troligen passerat under GPS-hopp
   */
  _detectBridgePassageDuringJump(vessel, oldPosition, newPosition) {
    const passedBridges = [];

    if (!oldPosition.lat || !oldPosition.lon || !newPosition.lat || !newPosition.lon) {
      return passedBridges;
    }

    // Kolla alla broar för att se vilka som ligger mellan gammal och ny position
    for (const [bridgeId, bridge] of Object.entries(this.bridges)) {
      // Skippa broar som redan passerats
      if (vessel.passedBridges && vessel.passedBridges.includes(bridgeId)) {
        continue;
      }

      // Kolla om bron ligger på linjen mellan gammal och ny position
      const distanceFromLineToPoint = this._distanceFromLineToPoint(
        { lat: oldPosition.lat, lon: oldPosition.lon },
        { lat: newPosition.lat, lon: newPosition.lon },
        { lat: bridge.lat, lon: bridge.lon },
      );

      // Om bron är inom 200m från resans linje, anses den passerad
      if (distanceFromLineToPoint < 200) {
        // Extra kontroll: båten ska ha rört sig förbi bron (inte bara förbi linjen)
        const oldDistanceToBridge = this._calculateDistance(
          oldPosition.lat, oldPosition.lon,
          bridge.lat, bridge.lon,
        );
        const newDistanceToBridge = this._calculateDistance(
          newPosition.lat, newPosition.lon,
          bridge.lat, bridge.lon,
        );

        // Om nya positionen är på andra sidan bron (distans först minskar sedan ökar)
        if (oldDistanceToBridge > 300 && newDistanceToBridge > 300) {
          passedBridges.push(bridgeId);
          this.logger.debug(
            `🌉 [JUMP_DETECTION] Bro ${bridge.name} troligen passerad - ${distanceFromLineToPoint.toFixed(0)}m från rutt-linje`,
          );
        }
      }
    }

    return passedBridges;
  }

  /**
   * Beräknar avståndet från en punkt till en linje (geometrisk formel)
   */
  _distanceFromLineToPoint(lineStart, lineEnd, point) {
    // Konvertera till kartesiska koordinater (approximativ för korta avstånd)
    const x1 = lineStart.lon;
    const y1 = lineStart.lat;
    const x2 = lineEnd.lon;
    const y2 = lineEnd.lat;
    const x0 = point.lon;
    const y0 = point.lat;

    // Formel för avstånd från punkt till linje
    const A = y2 - y1;
    const B = x1 - x2;
    const C = x2 * y1 - x1 * y2;

    const distance = Math.abs(A * x0 + B * y0 + C) / Math.sqrt(A * A + B * B);

    // Konvertera tillbaka till meter (ungefärlig konvertering för Sverige)
    return distance * 111320; // 1 grad ≈ 111320 meter
  }

  /**
   * ENHANCED: Förbättrad movement detection med multiple criteria
   * Kontrollerar om fartyg har rört sig signifikant sedan förra uppdateringen
   */
  _hasVesselMoved(oldData, newData) {
    if (!oldData.lat || !oldData.lon) return true;

    const distance = this._calculateDistance(
      oldData.lat, oldData.lon,
      newData.lat, newData.lon,
    );

    // Enhanced movement criteria:
    // 1. Position change >5m = definite movement
    // 2. Speed increase >0.5kn = starting to move
    // 3. Course change >15° + speed >0.2kn = maneuvering
    const positionMoved = distance > 5;
    const speedIncreased = (newData.sog || 0) - (oldData.sog || 0) > 0.5;
    const courseChanged = oldData.cog && newData.cog
      && Math.abs(newData.cog - oldData.cog) > 15 && newData.sog > 0.2;

    const hasMoved = positionMoved || speedIncreased || courseChanged;

    if (hasMoved) {
      this.debug(
        `🚢 [MOVEMENT_CHECK] ${newData.mmsi || oldData.mmsi}: avstånd=${distance.toFixed(1)}m, `
        + `hastighet=${(oldData.sog || 0).toFixed(1)}→${(newData.sog || 0).toFixed(1)}kn, `
        + `kurs=${oldData.cog?.toFixed(0) || 'N/A'}→${newData.cog?.toFixed(0) || 'N/A'}°`,
      );
    }

    return hasMoved;
  }

  /**
   * Kontrollerar om ett fartyg är verkligt stillastående (ingen rörelse på 30s)
   */
  _isVesselStationary(vessel) {
    if (!vessel.lastPosition || !vessel.lat || !vessel.lon) {
      return false; // Inte tillräckligt med data
    }

    // Kontrollera om båten har samma position i minst 45 sekunder (längre tid för mer confidence)
    const timeSinceLastMove = Date.now() - (vessel.lastPositionChange || vessel._lastSeen);
    const hasntMovedFor45s = timeSinceLastMove > 45 * 1000;

    // Kontrollera om nuvarande position är samma som förra
    const currentPos = { lat: vessel.lat, lon: vessel.lon };
    const lastPos = vessel.lastPosition;
    const positionDistance = this._calculateDistance(
      currentPos.lat, currentPos.lon,
      lastPos.lat, lastPos.lon,
    );

    // Båten är stillastående om den inte rört sig mer än 8m på 45s
    // Striktare kriterier för att undvika att filtrera bort långsamma men rörliga båtar
    const isStationary = hasntMovedFor45s && positionDistance < 8;

    // Additional check: Very low speed (≤0.1kn) for extended period indicates anchoring
    const isVerySlowForLongTime = vessel.sog <= 0.1 && timeSinceLastMove > 60 * 1000;

    const finalStationary = isStationary || isVerySlowForLongTime;

    if (finalStationary) {
      this.debug(
        `⚓ [STATIONARY_CHECK] Båt ${vessel.mmsi} stillastående - ${Math.round(timeSinceLastMove / 1000)}s, `
        + `${positionDistance.toFixed(1)}m rörelse, ${vessel.sog?.toFixed(2)}kn hastighet`,
      );
    }

    return finalStationary;
  }

  /**
   * ENHANCED: Kontrollerar om fartyg har en aktiv rutt mot målbro med förbättrad logik
   */
  _hasActiveTargetRoute(vessel) {
    if (!vessel.targetBridge) return false;

    // Om båten är nära sin målbro (inom 500m), anses den ha aktiv rutt
    const targetBridgeId = this._findBridgeIdByName(vessel.targetBridge);
    if (targetBridgeId && this.bridges[targetBridgeId]) {
      const targetBridge = this.bridges[targetBridgeId];
      const distanceToTarget = this._calculateDistance(
        vessel.lat, vessel.lon,
        targetBridge.lat, targetBridge.lon,
      );

      // Enhanced criteria for active route detection
      const isCloseToTarget = distanceToTarget <= 500;
      const hasRecentMovement = vessel.lastPositionChange
        && (Date.now() - vessel.lastPositionChange) < 180 * 1000; // 3 minutes
      const isApproaching = vessel.status === 'approaching';
      const isUnderBridge = vessel.status === 'under-bridge';
      const isWaiting = vessel.status === 'waiting' || vessel.isWaiting;

      // Active route if:
      // 1. Close to target bridge (<500m), OR
      // 2. Approaching status with recent movement, OR
      // 3. Currently under bridge or waiting at bridge
      const hasActiveRoute = isCloseToTarget
        || (isApproaching && hasRecentMovement)
        || isUnderBridge || isWaiting;

      if (hasActiveRoute) {
        this.debug(
          `🎯 [ACTIVE_ROUTE] Båt ${vessel.mmsi} har aktiv rutt - ${distanceToTarget.toFixed(0)}m från målbro ${vessel.targetBridge}, `
          + `status: ${vessel.status}, rörelse: ${hasRecentMovement ? 'JA' : 'NEJ'}`,
        );
        return true;
      }
    }

    return false;
  }

  _calculateTimeout(v) {
    const d = v._distanceToNearest ?? Infinity; // fallback

    // Hantera Infinity eller ogiltiga värden explicit
    if (d === Infinity || Number.isNaN(d) || d < 0) {
      this.logger.debug(
        `⏱️ [TIMEOUT] Fartyg ${v.mmsi}: ogiltigt avstånd (${d}), använder default 2 min timeout`,
      );
      return 2 * 60 * 1000; // Default 2 min för okända avstånd
    }

    // Timeout-zoner enligt kravspec §4.1
    let base;
    if (d <= APPROACH_RADIUS) {
      // Brozon: ≤300m = 20 min
      base = 20 * 60 * 1000;
    } else if (d <= 600) {
      // När-zon: 300-600m = 10 min
      base = 10 * 60 * 1000;
    } else {
      // Övrigt: >600m = 2 min
      base = 2 * 60 * 1000;
    }

    // Speed-villkorad timeout: snabba båtar (> 4 kn) får minst 5 min timeout
    if (v.sog > 4) {
      base = Math.max(base, 5 * 60 * 1000);
    }

    // FIX 5: Enhanced protection - all boats near any bridge get extended timeout
    // This prevents boats from disappearing while waiting at intermediate bridges
    const isNearAnyBridge = this._isWithin300mOfAnyBridge(v);
    // Waiting-säkring enligt kravspec §4.1 - now applies to all bridges
    if (v.status === 'waiting' || (isNearAnyBridge && v.sog < 1.0)) {
      base = Math.max(base, 20 * 60 * 1000); // Minst 20 min för waiting eller nära alla broar
      this.logger.debug(
        `🛡️ [TIMEOUT] Extended protection för ${v.mmsi}: nära bro=${isNearAnyBridge}, waiting=${v.status === 'waiting'}, slow=${v.sog < 1.0}`,
      );
    }

    this.logger.debug(
      `⏱️ [TIMEOUT] Fartyg ${v.mmsi}: avstånd=${d.toFixed(0)}m, status=${v.status}, timeout=${base / 60000}min`,
    );

    return base;
  }

  // FIX 5: Helper function to check if vessel is within 300m of any bridge
  _isWithin300mOfAnyBridge(vessel) {
    if (!this.bridges || !vessel.lat || !vessel.lon) {
      return false;
    }

    for (const bridge of Object.values(this.bridges)) {
      const distance = this._calculateDistance(
        vessel.lat, vessel.lon,
        bridge.lat, bridge.lon,
      );
      if (distance <= APPROACH_RADIUS) { // 300m
        this.logger.debug(
          `🛡️ [BRIDGE_PROXIMITY] Fartyg ${vessel.mmsi} inom 300m av ${bridge.name} (${distance.toFixed(0)}m)`,
        );
        return true;
      }
    }
    return false;
  }

  _updateSpeedHistory(history = [], currentSpeed) {
    const MAX_HISTORY = 10;
    const MAX_AGE = 10 * 60 * 1000;

    const now = Date.now();
    const filtered = history
      .filter((entry) => {
        // Handle corrupted entries
        if (!entry || typeof entry !== 'object' || !entry.timestamp) {
          return false;
        }
        return now - entry.timestamp < MAX_AGE;
      })
      .slice(-MAX_HISTORY + 1);

    filtered.push({ speed: currentSpeed, timestamp: now });
    return filtered;
  }

  _calculateMaxRecentSpeed(oldData, currentSpeed) {
    if (!oldData) return currentSpeed;
    const maxAge = 10 * 60 * 1000;
    const age = Date.now() - oldData.timestamp;

    if (age > maxAge) return currentSpeed;
    return Math.max(oldData.maxRecentSpeed || currentSpeed, currentSpeed);
  }

  // Kontrollera om en båt/bro-kombination redan har triggats
  hasRecentlyTriggered(mmsi, bridgeId) {
    const key = `${mmsi}-${bridgeId}`;
    const hasTriggered = this.triggeredFlows.has(key);

    if (hasTriggered) {
      this.logger.debug(
        `🚫 [TRIGGER_SPAM] Blockerar trigger för ${mmsi} vid ${bridgeId} - redan triggat denna session`,
      );
    }

    return hasTriggered;
  }

  // Markera att en trigger har skett
  markTriggered(mmsi, bridgeId) {
    const key = `${mmsi}-${bridgeId}`;
    this.triggeredFlows.set(key, true);
    this.logger.debug(
      `✅ [TRIGGER_MARK] Markerat trigger för ${mmsi} vid ${bridgeId}`,
    );
  }

  // Rensa trigger-historik för en båt
  clearTriggerHistory(mmsi) {
    const keysToDelete = [];
    for (const key of this.triggeredFlows.keys()) {
      if (key.startsWith(`${mmsi}-`)) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach((key) => this.triggeredFlows.delete(key));

    if (keysToDelete.length > 0) {
      this.logger.debug(
        `🧹 [TRIGGER_CLEAR] Rensat ${keysToDelete.length} trigger-poster för ${mmsi}`,
      );
    }
  }

  markIrrelevant(mmsi) {
    const vessel = this.vessels.get(mmsi);
    if (!vessel) return;

    if (vessel.status === 'passed' || vessel.status === 'idle') {
      vessel.graceMisses = (vessel.graceMisses || 0) + 1;
    }

    this.logger.debug(
      `⚠️ [GRACE_LOGIC] Fartyg ${mmsi} markerat som irrelevant (graceMisses: ${vessel.graceMisses}/${GRACE_MISSES})`,
    );

    // Får bara tas bort om graceMisses är uppnådda OCH status==='passed' ELLER status==='idle'
    if (
      vessel.graceMisses >= GRACE_MISSES
      && (vessel.status === 'passed' || vessel.status === 'idle')
    ) {
      this.logger.debug(
        `🗑️ [GRACE_LOGIC] Fartyg ${mmsi} (${vessel.name}) tas bort efter ${GRACE_MISSES} irrelevanta analyser (status: ${vessel.status})`,
      );
      this.removeVessel(mmsi);
    } else if (vessel.graceMisses >= GRACE_MISSES) {
      this.logger.debug(
        `⏳ [GRACE_LOGIC] Fartyg ${mmsi} har ${GRACE_MISSES} misses men status=${
          vessel.status || 'unknown'
        } - behålls`,
      );
    }
  }

  _scheduleRemovalAfterCompletion(mmsi) {
    const vessel = this.vessels.get(mmsi);
    if (!vessel) return;

    this.logger.debug(
      `🏁 [COMPLETION_REMOVAL] Schemalägger borttagning av ${mmsi} efter 3 minuter (ingen målbro kvar)`,
    );

    // Cancel any existing cleanup timer
    this._cancelCleanup(mmsi);

    // FALLBACK MECHANISM: Schedule vessel removal after 3 minutes
    // This is a safety fallback in case:
    // 1. Passage detection failed to remove the vessel
    // 2. Vessel has status 'passed' but wasn't cleaned up properly
    // 3. Something went wrong in the normal cleanup flow
    // Normal flow: Vessels are removed immediately when they pass their last target bridge
    const FALLBACK_CLEANUP_DELAY = 3 * 60 * 1000; // 3 minutes

    const timerId = setTimeout(() => {
      const v = this.vessels.get(mmsi);
      if (v && v.status === 'passed' && !v.targetBridge) {
        this.logger.debug(
          `🗑️ [COMPLETION_REMOVAL] FALLBACK: Tar bort fartyg ${mmsi} - rutt slutförd för 3 minuter sedan`,
        );
        this.removeVessel(mmsi);
      }
    }, FALLBACK_CLEANUP_DELAY);

    this.cleanupTimers.set(mmsi, timerId);
  }

  destroy() {
    // Clean up all timers
    for (const timerId of this.cleanupTimers.values()) {
      clearTimeout(timerId);
    }
    this.cleanupTimers.clear();
    this.vessels.clear();
    this.bridgeVessels.clear();
    this.removeAllListeners();
  }

  /**
   * 🚨 CRITICAL TARGET BRIDGE FIX: Proactive Target Bridge Assignment
   * Assigns targetBridge to new vessels based on position, COG, and bridge sequence
   * This ensures boats never start with targetBridge: undefined
   */
  _proactiveTargetBridgeAssignment(vessel) {
    if (!vessel.cog || vessel.sog < 0.5) {
      this.logger.debug(
        `⏭️ [PROACTIVE_TARGET] Skippar båt ${vessel.mmsi} - ingen COG (${vessel.cog}) eller för långsam (${vessel.sog}kn)`,
      );
      return null;
    }

    // Check for anchored boats - if very slow and far from bridges, likely anchored
    let nearestDistanceQuick = Infinity;
    for (const bridge of Object.values(this.bridges)) {
      const distance = this._calculateDistance(
        vessel.lat, vessel.lon, bridge.lat, bridge.lon,
      );
      if (distance < nearestDistanceQuick) {
        nearestDistanceQuick = distance;
      }
    }

    if (vessel.sog < 0.5 && nearestDistanceQuick > 200) {
      this.logger.debug(
        `⚓ [PROACTIVE_TARGET] Ankrad båt ${vessel.mmsi} - ${vessel.sog}kn och ${nearestDistanceQuick.toFixed(0)}m från närmaste bro - ingen targetBridge`,
      );
      return null;
    }

    // Find nearest bridge to vessel
    let nearestBridge = null;
    let nearestDistance = Infinity;

    for (const [bridgeId, bridge] of Object.entries(this.bridges)) {
      const distance = this._calculateDistance(
        vessel.lat, vessel.lon,
        bridge.lat, bridge.lon,
      );

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestBridge = { bridgeId, bridge, distance };
      }
    }

    if (!nearestBridge || nearestDistance > 3000) {
      this.logger.debug(
        `❌ [PROACTIVE_TARGET] Båt ${vessel.mmsi} för långt från broar (${nearestDistance?.toFixed(0)}m)`,
      );
      return null;
    }

    // Determine direction based on COG
    const cog = Number(vessel.cog) || 0;
    const isHeadingNorth = cog >= 315 || cog === 0 || cog <= 45;

    this.logger.debug(
      `🧭 [PROACTIVE_TARGET] Båt ${vessel.mmsi}: närmaste bro ${nearestBridge.bridge.name} (${nearestDistance.toFixed(0)}m), COG: ${cog}° (${isHeadingNorth ? 'norr' : 'söder'})`,
    );

    // User bridge names for targeting
    const userBridgeNames = ['Klaffbron', 'Stridsbergsbron'];

    // Bridge order south to north
    const bridgeOrder = ['olidebron', 'klaffbron', 'jarnvagsbron', 'stridsbergsbron', 'stallbackabron'];
    const currentBridgeIndex = bridgeOrder.indexOf(nearestBridge.bridgeId);

    if (currentBridgeIndex === -1) {
      this.logger.debug(
        `❌ [PROACTIVE_TARGET] Okänd bro ${nearestBridge.bridgeId} i bridgeOrder`,
      );
      return null;
    }

    // If nearest bridge is already a user bridge and vessel is heading towards it
    if (userBridgeNames.includes(nearestBridge.bridge.name)) {
      const bearingToBridge = this._calculateBearing(
        vessel.lat, vessel.lon,
        nearestBridge.bridge.lat, nearestBridge.bridge.lon,
      );
      const cogDiff = Math.abs(((vessel.cog - bearingToBridge + 180) % 360) - 180);

      if (cogDiff < 90) {
        this.logger.debug(
          `🎯 [PROACTIVE_TARGET] Båt ${vessel.mmsi} siktar mot användarbro ${nearestBridge.bridge.name} (COG diff: ${cogDiff.toFixed(1)}°)`,
        );
        return nearestBridge.bridge.name;
      }
    }

    // Look for user bridges in vessel's direction
    if (isHeadingNorth) {
      // Search north from current position
      for (let i = currentBridgeIndex + 1; i < bridgeOrder.length; i++) {
        const bridgeId = bridgeOrder[i];
        const bridge = this.bridges[bridgeId];
        if (bridge && userBridgeNames.includes(bridge.name)) {
          this.logger.debug(
            `🎯 [PROACTIVE_TARGET] Båt ${vessel.mmsi} norrut mot ${bridge.name}`,
          );
          return bridge.name;
        }
      }
    } else {
      // Search south from current position
      for (let i = currentBridgeIndex - 1; i >= 0; i--) {
        const bridgeId = bridgeOrder[i];
        const bridge = this.bridges[bridgeId];
        if (bridge && userBridgeNames.includes(bridge.name)) {
          this.logger.debug(
            `🎯 [PROACTIVE_TARGET] Båt ${vessel.mmsi} söderut mot ${bridge.name}`,
          );
          return bridge.name;
        }
      }
    }

    this.logger.debug(
      `❌ [PROACTIVE_TARGET] Ingen användarbro hittad för båt ${vessel.mmsi} i riktning ${isHeadingNorth ? 'norr' : 'söder'} från ${nearestBridge.bridge.name}`,
    );
    return null;
  }

  /**
   * Calculate bearing from point1 to point2 in degrees
   */
  _calculateBearing(lat1, lon1, lat2, lon2) {
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const lat1Rad = (lat1 * Math.PI) / 180;
    const lat2Rad = (lat2 * Math.PI) / 180;

    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

    const bearing = Math.atan2(y, x) * (180 / Math.PI);
    return (bearing + 360) % 360; // Normalize to 0-360
  }
}

// ============= MODUL 2: BRIDGE MONITOR =============
class BridgeMonitor extends EventEmitter {
  constructor(bridges, vesselManager, logger) {
    super();
    this.bridges = bridges;
    this.vesselManager = vesselManager;
    this.logger = logger;
    this.userBridges = ['klaffbron', 'stridsbergsbron'];
    this.bridgeOrder = [
      'olidebron',
      'klaffbron',
      'jarnvagsbron',
      'stridsbergsbron',
      'stallbackabron',
    ];
    this.bridgeGaps = {
      olidebron_klaffbron: 950,
      klaffbron_jarnvagsbron: 960,
      jarnvagsbron_stridsbergsbron: 420,
      stridsbergsbron_stallbackabron: 530,
    };

    // Listen for vessel updates to handle Near-Bridge & ETA feature
    this.vesselManager.on('vessel:updated', ({ mmsi, data, oldData }) => {
      this._handleVesselUpdate(data, oldData);
    });
  }

  /**
   * Handle vessel:updated events for Near-Bridge & ETA feature
   */
  _handleVesselUpdate(vessel, oldData) {
    this.logger.debug(
      `🗺️ [VESSEL_UPDATE] Analyserar fartyg ${vessel.mmsi} för närhet till broar`,
    );

    // 🚨 CRITICAL TARGET BRIDGE FIX: Enhanced Bulletproof Validation Logic
    if (vessel.targetBridge) {
      const isValidTarget = this._validateTargetBridge(vessel);
      const isNearUserBridge = this._isNearUserBridge(vessel);

      if (!isValidTarget && !isNearUserBridge) {
        // Add hysteresis to prevent oscillation - more conservative clearing
        if (!vessel._targetClearAttempts) {
          vessel._targetClearAttempts = 1;
        } else {
          vessel._targetClearAttempts++;
        }

        // More conservative clearing - require 5 consecutive invalid checks unless clearly heading away
        const isHeadingAway = this._isVesselClearlyHeadingAway(vessel);
        const clearThreshold = isHeadingAway ? 3 : 5;

        if (vessel._targetClearAttempts >= clearThreshold) {
          this.logger.debug(
            `🚨 [TARGET_VALIDATION] Clearing targetBridge for ${vessel.mmsi} after ${vessel._targetClearAttempts} attempts (heading away: ${isHeadingAway})`,
          );

          // Try to assign a new target immediately instead of just clearing
          const newTarget = this.vesselManager._proactiveTargetBridgeAssignment(vessel);
          if (newTarget) {
            vessel.targetBridge = newTarget;
            this.logger.debug(
              `🔄 [TARGET_VALIDATION] Reassigned new targetBridge: ${newTarget} for ${vessel.mmsi}`,
            );
          } else {
            vessel.targetBridge = null;
            // Ensure consistency when targetBridge is cleared
            vessel.isApproaching = false;
            vessel.isWaiting = false;
            vessel.etaMinutes = null;
            this.logger.debug(
              `🧹 [TARGET_VALIDATION] No alternative target found - cleared targetBridge and flags for ${vessel.mmsi}`,
            );
          }

          this._syncStatusAndFlags(vessel, 'en-route');
          delete vessel._targetClearAttempts;
        } else {
          this.logger.debug(
            `⚠️ [TARGET_VALIDATION] targetBridge questionable for ${vessel.mmsi} (attempt ${vessel._targetClearAttempts}/${clearThreshold})`,
          );
        }
      } else if (vessel._targetClearAttempts > 0) {
        // Reset counter if target is valid
        this.logger.debug(
          `✅ [TARGET_VALIDATION] targetBridge validated for ${vessel.mmsi} - resetting attempts`,
        );
        delete vessel._targetClearAttempts;
      }
    }

    // Check for GPS jump (vessel moved >500m in one update)
    if (oldData && oldData.lat && oldData.lon) {
      const jumpDistance = this._haversine(
        oldData.lat,
        oldData.lon,
        vessel.lat,
        vessel.lon,
      );

      if (jumpDistance > 500) {
        // Validate that the jump is in a reasonable direction relative to vessel's course
        const jumpBearing = this._calculateBearing(
          oldData.lat, oldData.lon, vessel.lat, vessel.lon,
        );
        const cogDiff = Math.abs(jumpBearing - vessel.cog);
        const normalizedCogDiff = cogDiff > 180 ? 360 - cogDiff : cogDiff;

        if (normalizedCogDiff > 90) {
          this.logger.warn(
            `⚠️ [GPS_JUMP] Fartyg ${vessel.mmsi} GPS-hopp i motsatt riktning `
            + `(bearing: ${jumpBearing.toFixed(1)}°, COG: ${vessel.cog.toFixed(1)}°, `
            + `diff: ${normalizedCogDiff.toFixed(1)}°) - behåller gamla position`,
          );
          // Keep old position for now
          vessel.lat = oldData.lat;
          vessel.lon = oldData.lon;
          return vessel;
        }

        this.logger.debug(
          `⚠️ [GPS_JUMP] Fartyg ${vessel.mmsi} hoppade ${jumpDistance.toFixed(0)}m - validerat (bearing: ${jumpBearing.toFixed(1)}°, COG: ${vessel.cog.toFixed(1)}°)`,
        );

        // Check if vessel jumped past any bridges during GPS gap
        const bridgesPassed = this.vesselManager._detectBridgePassageDuringJump(vessel, oldData, vessel);
        if (bridgesPassed.length > 0) {
          this.logger.debug(
            `🌉 [GPS_JUMP_PASSAGE] Fartyg ${vessel.mmsi} troligen passerat ${bridgesPassed.length} broar under GPS-hopp: ${bridgesPassed.join(', ')}`,
          );

          // Add passed bridges and update target
          for (const bridgeId of bridgesPassed) {
            if (!vessel.passedBridges) {
              vessel.passedBridges = [];
            }
            if (!vessel.passedBridges.includes(bridgeId)) {
              vessel.passedBridges.push(bridgeId);
              vessel.lastPassedBridgeTime = Date.now();
            }
          }

          // Update target bridge based on new position
          const lastPassedBridge = bridgesPassed[bridgesPassed.length - 1];
          const newTarget = this._findTargetBridge(vessel, lastPassedBridge);
          if (newTarget) {
            vessel.targetBridge = newTarget;
            this.logger.debug(`🎯 [GPS_JUMP_PASSAGE] Ny målbro efter GPS-hopp: ${newTarget}`);
          }
        }

        // Clean up all approach data due to unreliable position
        delete vessel._wasInsideTarget;
        delete vessel._wasInsideNear;
        delete vessel._targetApproachBearing;
        delete vessel._nearApproachBearing;
        delete vessel._targetApproachTime;
        delete vessel._nearApproachTime;
        delete vessel._nearBridgeId;
        delete vessel._closestBridgeDistance;
        delete vessel._lastBridgeDistance;
        delete vessel._previousBridgeDistance;
        delete vessel._minDistanceToBridge;
        delete vessel._minDistanceTime;
      }
    }

    // Find nearest bridge and its distance
    const nearestBridge = this._findNearestBridge(vessel);

    if (nearestBridge) {
      const { bridge } = nearestBridge;
      let { bridgeId, distance } = nearestBridge;

      this.logger.debug(
        `🧮 [VESSEL_UPDATE] Närmaste bro för ${
          vessel.mmsi
        }: ${bridgeId} på ${distance.toFixed(0)}m avstånd`,
      );

      // 🚨 CRITICAL TARGET BRIDGE FIX: Enhanced Proactive Target Assignment
      if (!vessel.targetBridge) {
        // More proactive distance threshold - start assignment earlier
        const proactiveDistance = distance < 2000 ? 2000 : 1000;

        if (distance < proactiveDistance && vessel.sog > 0.5) {
          this.logger.debug(
            `🎯 [VESSEL_UPDATE] Fartyg ${vessel.mmsi} saknar targetBridge men är nu < ${proactiveDistance}m från ${bridge.name} - initierar målbro`,
          );
          // Emit event för TextFlowManager att hantera
          this.emit('vessel:needs-target', { vessel });
        } else if (vessel._targetAssignmentAttempts > 2) {
          // Emergency assignment for boats that have been struggling
          this.logger.debug(
            `🚨 [VESSEL_UPDATE] NÖDSITUATION: Fartyg ${vessel.mmsi} har ${vessel._targetAssignmentAttempts} misslyckade försök - forcerar målbro-tilldelning`,
          );
          this.emit('vessel:needs-target', { vessel });
        }
      }

      /* Hysteresis-regel enligt kravspec §1
         – Byt bro direkt om det är samma som vessel.targetBridge
         – Annars krävs att nya bron är ≥10% närmare */
      const last = vessel.nearBridge;
      if (last && last !== bridgeId && this.bridges[last]) {
        const lastDist = this._haversine(
          vessel.lat,
          vessel.lon,
          this.bridges[last].lat,
          this.bridges[last].lon,
        );
        const isTarget = bridgeId === this._findBridgeIdByNameInMonitor(vessel.targetBridge);

        // Special cases for bridge switching
        const isMovingAway = lastDist < 100 && distance > lastDist * 1.5; // Moving away from last bridge
        const isDiagonalMove = Math.abs(distance - lastDist) < DIAGONAL_MOVE_THRESHOLD; // Similar distances, likely diagonal movement

        // Om det är targetBridge, byt direkt. Annars måste nya bron vara minst 10% närmare
        if (!isTarget && !isMovingAway && distance > lastDist * HYSTERESIS_FACTOR) {
          // Nya bron är inte minst 10% närmare, behåll gamla
          // Men om det är diagonal rörelse, kolla COG för att avgöra
          if (isDiagonalMove) {
            const bearingToNew = this._calculateBearing(vessel.lat, vessel.lon, this.bridges[bridgeId].lat, this.bridges[bridgeId].lon);
            const bearingToOld = this._calculateBearing(vessel.lat, vessel.lon, this.bridges[last].lat, this.bridges[last].lon);
            const normalizedCogDiffNew = this._normalizeAngleDiff(vessel.cog, bearingToNew);
            const normalizedCogDiffOld = this._normalizeAngleDiff(vessel.cog, bearingToOld);

            if (normalizedCogDiffNew < normalizedCogDiffOld - 10) {
              // Vessel is heading more towards new bridge
              this.logger.debug(
                `🔄 [HYSTERESIS] Diagonal rörelse - byter till ${bridgeId} (COG diff: ${normalizedCogDiffNew.toFixed(0)}° vs ${normalizedCogDiffOld.toFixed(0)}°)`,
              );
            } else {
              bridgeId = last;
              distance = lastDist;
              this.logger.debug(
                `🔄 [HYSTERESIS] Diagonal rörelse - behåller ${last} (COG diff: ${normalizedCogDiffOld.toFixed(0)}° vs ${normalizedCogDiffNew.toFixed(0)}°)`,
              );
            }
          } else {
            bridgeId = last;
            distance = lastDist;
            this.logger.debug(
              `🔄 [HYSTERESIS] Behåller ${last} som nearBridge (${lastDist.toFixed(0)}m) - ${bridgeId} är bara ${((1 - distance / lastDist) * 100).toFixed(1)}% närmare`,
            );
          }
        } else if (!isTarget) {
          this.logger.debug(
            `🔄 [HYSTERESIS] Byter till ${bridgeId} som nearBridge (${distance.toFixed(0)}m) - är ${((1 - distance / lastDist) * 100).toFixed(1)}% närmare än ${last}`,
          );
        }
      }

      // Check if nearBridge is locked due to being very close to a bridge
      if (vessel._lockNearBridge && vessel.nearBridge) {
        const lockedDistance = this._haversine(
          vessel.lat,
          vessel.lon,
          this.bridges[vessel.nearBridge].lat,
          this.bridges[vessel.nearBridge].lon,
        );

        // Keep lock if still within APPROACH_RADIUS to prevent oscillation
        if (lockedDistance <= APPROACH_RADIUS) {
          this.logger.debug(
            `🔒 [NEARBRIDGE_LOCK] Behåller ${vessel.nearBridge} för ${vessel.mmsi} - låst pga närhet (${lockedDistance.toFixed(0)}m)`,
          );
          bridgeId = vessel.nearBridge;
          distance = lockedDistance;
        } else {
          // Release lock when far enough away
          delete vessel._lockNearBridge;
          this.logger.debug(
            `🔓 [NEARBRIDGE_LOCK] Släpper lås för ${vessel.mmsi} - nu ${lockedDistance.toFixed(0)}m från ${vessel.nearBridge}`,
          );
        }
      }

      // Set vessel.nearBridge if distance ≤ APPROACH_RADIUS
      if (distance <= APPROACH_RADIUS) {
        // Lock nearBridge if very close
        if (distance < UNDER_BRIDGE_DISTANCE && !vessel._lockNearBridge) {
          vessel._lockNearBridge = true;
          this.logger.debug(
            `🔒 [NEARBRIDGE_LOCK] Låser nearBridge=${bridgeId} för ${vessel.mmsi} - mycket nära (${distance.toFixed(0)}m < ${UNDER_BRIDGE_DISTANCE}m)`,
          );
        }

        vessel.nearBridge = bridgeId;
        // Also set currentBridge for _findRelevantBoats to reduce fallback usage
        vessel.currentBridge = bridgeId;
        this.logger.debug(
          `🌉 [VESSEL_UPDATE] Fartyg ${vessel.mmsi} inom APPROACH_RADIUS (${APPROACH_RADIUS}m) för ${bridgeId}`,
        );

        // FIX 3: Simplified waiting detection - ≤300m from target bridge = waiting
        // This provides immediate user feedback and eliminates GPS noise issues
        try {
          // Defensive checks - ensure vessel has required properties
          if (typeof vessel.sog !== 'number' || typeof distance !== 'number' || !vessel.mmsi) {
            this.logger.warn(`⚠️ [WAITING_LOGIC] Defensive: Invalid vessel properties for ${vessel.mmsi} - skipping waiting detection`);
          } else if (distance <= APPROACH_RADIUS && vessel.targetBridge) {
            // FIX 3: Simple and robust - any boat ≤300m from its target bridge is "waiting"
            if (vessel.status !== 'waiting') {
              this._syncStatusAndFlags(vessel, 'waiting');
              vessel.waitSince = Date.now(); // Mark when waiting started
              this.logger.debug(
                `⏳ [WAITING_LOGIC] Fartyg ${vessel.mmsi} väntar vid ${bridgeId} - inom 300m från målbro (${distance.toFixed(0)}m, ${vessel.sog.toFixed(1)}kn)`,
              );
              // Defensive emit - ensure error in status change doesn't break waiting detection
              try {
                this.emit('vessel:status-changed', { vessel, oldStatus: vessel.status || 'approaching', newStatus: 'waiting' });
              } catch (emitError) {
                this.logger.warn(`⚠️ [WAITING_LOGIC] Defensive: Status change emit failed for ${vessel.mmsi}:`, emitError.message);
              }

              // Enhanced protection for waiting boats
              try {
                vessel.protectedUntil = Date.now() + 30 * 60 * 1000; // 30 min skydd
                if (this.vesselManager && this.vesselManager._cancelCleanup) {
                  this.vesselManager._cancelCleanup(vessel.mmsi);
                }
                this.logger.debug(
                  `🛡️ [WAITING_PROTECTION] Skyddar väntande fartyg ${vessel.mmsi} inom 300m från ${bridgeId} i 30 min`,
                );
              } catch (protectionError) {
                this.logger.warn(`⚠️ [WAITING_LOGIC] Defensive: Protection setup failed for ${vessel.mmsi}:`, protectionError.message);
              }
            }
          } else if (distance > APPROACH_RADIUS && vessel.status === 'waiting') {
            // FIX 3: Reset waiting status when boat moves away from bridge
            this._syncStatusAndFlags(vessel, 'approaching');
            vessel.waitSince = null;
            this.logger.debug(
              `🏃 [WAITING_LOGIC] Fartyg ${vessel.mmsi} lämnar väntområde - återgår till approaching (${distance.toFixed(0)}m från bro)`,
            );
            try {
              this.emit('vessel:status-changed', { vessel, oldStatus: 'waiting', newStatus: 'approaching' });
            } catch (emitError) {
              this.logger.warn(`⚠️ [WAITING_LOGIC] Defensive: Status reset emit failed for ${vessel.mmsi}:`, emitError.message);
            }
          }
        } catch (waitingError) {
          // 🚨 CRITICAL: Ensure waiting detection errors don't interrupt other processing
          this.logger.error(`🚨 [WAITING_LOGIC] Defensive: Waiting detection failed for ${vessel.mmsi}:`, waitingError.message);
        }

        // Check if vessel is very close to its target bridge (<50m) and set under-bridge status
        if (vessel.targetBridge) {
          const targetId = this._findBridgeIdByNameInMonitor(vessel.targetBridge);
          if (targetId && this.bridges[targetId]) {
            const targetDistance = this._haversine(
              vessel.lat,
              vessel.lon,
              this.bridges[targetId].lat,
              this.bridges[targetId].lon,
            );

            // Under-bridge när targetDistance < 50m enligt kravspec §5
            if (targetDistance < UNDER_BRIDGE_DISTANCE) {
              if (vessel.status !== 'under-bridge') {
                const oldStatus = vessel.status;
                this._syncStatusAndFlags(vessel, 'under-bridge');
                vessel.etaMinutes = 0; // ETA = 0 visar "nu" i UI
                this.logger.debug(
                  `🌉 [UNDER_BRIDGE] Fartyg ${vessel.mmsi} under ${
                    vessel.targetBridge
                  } (${targetDistance.toFixed(0)}m < ${UNDER_BRIDGE_DISTANCE}m)`,
                );
                // Emit status change for UI update
                this.emit('vessel:status-changed', { vessel, oldStatus, newStatus: 'under-bridge' });
              }
            } else if (vessel.status === 'under-bridge' && targetDistance >= UNDER_BRIDGE_DISTANCE) {
              // Återställ från under-bridge när avståndet ökar
              this._syncStatusAndFlags(vessel, 'approaching');
              this.logger.debug(
                `🌉 [UNDER_BRIDGE] Fartyg ${vessel.mmsi} lämnat under-bridge status (${targetDistance.toFixed(0)}m >= 50m)`,
              );
              this.emit('vessel:status-changed', { vessel, oldStatus: 'under-bridge', newStatus: 'approaching' });

              // Bridge-switch: dynamiskt byte av targetBridge efter under-bridge
              const wasUnder = oldData?.status === 'under-bridge';
              const nowOutOfUnder = wasUnder && targetDistance > 60; // litet säkerhets-slack

              if (nowOutOfUnder) {
                const newTarget = this._findTargetBridge(vessel, bridgeId);
                if (newTarget && newTarget !== vessel.targetBridge) {
                  vessel.targetBridge = newTarget;
                  // FIX 4: Reset ETA when target bridge changes to prevent old ETA being used
                  vessel.etaMinutes = null;
                  vessel.isApproaching = false;
                  this.logger.debug(`[TARGET_SWITCH] Ny targetBridge → ${newTarget} för ${vessel.mmsi} (lämnat under-bridge zonen), ETA nollställd`);
                  this.emit('vessel:target-changed', { vessel });
                }
              }
            }
          }
        }

        // Emit bridge:approaching event - inkludera analysis placeholder
        this.emit('bridge:approaching', {
          vessel,
          bridgeId,
          bridge,
          distance,
          analysis: {
            confidence: 'unknown',
            isApproaching: true,
            isWaiting: false,
            isRelevant: true,
          }, // placeholder för att förhindra TypeError
        });
        this.logger.debug(
          `🌉 [BRIDGE_EVENT] bridge:approaching utlöst för ${vessel.mmsi} vid ${bridgeId}`,
        );
      } else {
        // Check if vessel is still close enough (500m) to set currentBridge for "mellan broar" scenario
        const nearestBridge = this._findNearestBridge(vessel);
        if (nearestBridge && nearestBridge.distance <= 500) {
          vessel.currentBridge = nearestBridge.bridgeId;
          // Also maintain nearBridge if within APPROACH_RADIUS to reduce fallback usage
          if (nearestBridge.distance <= APPROACH_RADIUS) {
            vessel.nearBridge = nearestBridge.bridgeId;
            this.logger.debug(
              `🌉 [SYNC_BRIDGES] Fartyg ${vessel.mmsi} - sätter både currentBridge och nearBridge till ${nearestBridge.bridgeId} (${nearestBridge.distance.toFixed(0)}m)`,
            );
          } else {
            vessel.nearBridge = null;
            this.logger.debug(
              `🌉 [CURRENT_BRIDGE] Fartyg ${vessel.mmsi} mellan broar - sätter currentBridge till ${nearestBridge.bridgeId} (${nearestBridge.distance.toFixed(0)}m)`,
            );
          }
        } else {
          vessel.currentBridge = null;
          vessel.nearBridge = null;
        }
        this.logger.debug(
          `🗺️ [VESSEL_UPDATE] Fartyg ${vessel.mmsi} utanför APPROACH_RADIUS för alla broar`,
        );
      }

      // Bridge-switch: kontrollera COG-ändring > 45°
      if (oldData?.cog != null && vessel.targetBridge) {
        const headingChanged = Math.abs(((vessel.cog - oldData.cog + 180) % 360) - 180) > 45;

        if (headingChanged) {
          const currentBridgeId = vessel.nearBridge || this._findNearestBridge(vessel)?.bridgeId;
          if (currentBridgeId) {
            const newTarget = this._findTargetBridge(vessel, currentBridgeId);
            if (newTarget && newTarget !== vessel.targetBridge) {
              // Add hysteresis for COG-based changes
              if (!vessel._cogChangeCount) {
                vessel._cogChangeCount = 1;
                vessel._proposedTarget = newTarget;
              } else if (vessel._proposedTarget === newTarget) {
                vessel._cogChangeCount++;
              } else {
                // Different target proposed, reset
                vessel._cogChangeCount = 1;
                vessel._proposedTarget = newTarget;
              }

              // Only change after 2 consecutive detections
              if (vessel._cogChangeCount >= 2) {
                const oldTarget = vessel.targetBridge;
                vessel.targetBridge = newTarget;
                // FIX 4: Reset ETA when target bridge changes
                vessel.etaMinutes = null;
                vessel.isApproaching = false;
                delete vessel._cogChangeCount;
                delete vessel._proposedTarget;

                // Clean up old target approach data
                if (oldTarget !== newTarget) {
                  delete vessel._wasInsideTarget;
                  delete vessel._targetApproachBearing;
                  delete vessel._targetApproachTime;
                  this.logger.debug(`🧹 [TARGET_SWITCH] Rensade approach-data för gamla target ${oldTarget}`);
                }

                this.logger.debug(`[TARGET_SWITCH] Ny targetBridge → ${newTarget} för ${vessel.mmsi} (COG ändring > 45°, bekräftad)`);
                this.emit('vessel:target-changed', { vessel });
              }
            } else {
              // Reset if no change needed
              delete vessel._cogChangeCount;
              delete vessel._proposedTarget;
            }
          }
        }
      }

      // Calculate ETA if vessel has targetBridge and sufficient speed
      if (vessel.targetBridge && vessel.sog > 0.25) {
        // Beräkna avstånd till targetBridge baserat på dess lat/lon istället för närmaste bro
        const targetId = this._findBridgeIdByNameInMonitor(vessel.targetBridge);
        if (targetId && this.bridges[targetId]) {
          const targetBridge = this.bridges[targetId];
          const targetDistance = this._haversine(
            vessel.lat,
            vessel.lon,
            targetBridge.lat,
            targetBridge.lon,
          );

          // Track distance to target for trend analysis
          vessel.distanceToTarget = targetDistance;

          // Use standardized ETA calculation with proper validation
          if (this.etaCalculator) {
            const eta = this.etaCalculator.calculateETA(
              vessel,
              targetDistance,
              vessel.nearBridge || targetId,
              targetId,
            );
            vessel.etaMinutes = eta.minutes;
            vessel.isWaiting = eta.isWaiting;
          } else if (vessel.sog > 0.1) {
            // Fallback calculation with null safety
            vessel.etaMinutes = Math.round(targetDistance / (vessel.sog * 0.514444) / 60);
          } else {
            vessel.etaMinutes = 999; // Large value for very slow vessels
          }

          this.logger.debug(
            `🧮 [ETA_CALC] ETA för ${vessel.mmsi} till ${
              vessel.targetBridge
            }: ${vessel.etaMinutes} minuter (målbro-avstånd: ${targetDistance.toFixed(
              0,
            )}m, hastighet: ${vessel.sog.toFixed(1)}kn)`,
          );
        } else {
          vessel.etaMinutes = null;
          this.logger.debug(
            `❌ [ETA_CALC] Målbro ${vessel.targetBridge} hittades inte för ${vessel.mmsi}`,
          );
        }
      } else {
        vessel.etaMinutes = null;
        if (vessel.targetBridge) {
          this.logger.debug(
            `🧮 [ETA_CALC] Ingen ETA beräknad för ${
              vessel.mmsi
            } - för låg hastighet (${vessel.sog?.toFixed(1) || 0}kn ≤ 0.25kn)`,
          );
        }
      }

      // NEW: Distance-based target bridge validation as fallback to bearing-based passage detection
      if (vessel.targetBridge) {
        const shouldUpdateTargetBridge = this._validateAndUpdateTargetBridge(vessel);
        if (shouldUpdateTargetBridge) {
          this.logger.debug(
            `🎯 [TARGET_VALIDATION] Målbro uppdaterad för ${vessel.mmsi}: ${vessel.targetBridge}`,
          );
          this.emit('vessel:target-changed', { vessel });
        }

        // Check if ETA needs recalculation due to significant position/speed changes
        if (vessel.targetBridge && vessel.etaMinutes != null && this.etaCalculator) {
          const oldDistance = vessel._previousTargetDistance || 0;
          const currentDistance = vessel.distanceToTarget || 0;
          const oldSpeed = vessel._previousSpeed || vessel.sog;

          const distanceChange = oldDistance > 0 ? Math.abs(oldDistance - currentDistance) / oldDistance : 1;
          const speedChange = oldSpeed > 0 ? Math.abs(oldSpeed - vessel.sog) / oldSpeed : 0;

          // Recalculate ETA if 10% distance change or 20% speed change
          if (distanceChange > 0.1 || speedChange > 0.2) {
            const targetId = this._findBridgeIdByNameInMonitor(vessel.targetBridge);
            if (targetId) {
              const eta = this.etaCalculator.calculateETA(
                vessel,
                currentDistance,
                vessel.nearBridge || targetId,
                targetId,
              );
              vessel.etaMinutes = eta.minutes;
              vessel.isWaiting = eta.isWaiting;
              this.logger.debug(
                `🔄 [ETA_UPDATE] Uppdaterad ETA för ${vessel.mmsi}: ${vessel.etaMinutes}min (distanceChange: ${(distanceChange * 100).toFixed(1)}%, speedChange: ${(speedChange * 100).toFixed(1)}%)`,
              );
            }
          }

          // Store current values for next comparison
          vessel._previousTargetDistance = currentDistance;
          vessel._previousSpeed = vessel.sog;
        }
      }

      // Check for bridge passage (distance rises above 50m after being inside APPROACH_RADIUS)
      // Använd nearBridge om targetBridge saknas för att fånga passage detection
      const bridgeToCheck = vessel.targetBridge || (vessel.nearBridge && this._isUserBridge(vessel.nearBridge) ? this.bridges[vessel.nearBridge].name : null);

      if (bridgeToCheck) {
        const bridgeId = vessel.targetBridge
          ? this._findBridgeIdByNameInMonitor(vessel.targetBridge)
          : vessel.nearBridge;

        if (bridgeId && this.bridges[bridgeId]) {
          const bridge = this.bridges[bridgeId];
          const distance = this._haversine(
            vessel.lat,
            vessel.lon,
            bridge.lat,
            bridge.lon,
          );

          // Track when vessel gets very close to bridge (< 50m)
          if (distance < UNDER_BRIDGE_DISTANCE) {
            // Track for targetBridge
            if (vessel.targetBridge && bridgeToCheck === vessel.targetBridge && !vessel._wasInsideTarget) {
              vessel._wasInsideTarget = true;
              try {
                vessel._targetApproachBearing = this._calculateBearing(
                  bridge.lat,
                  bridge.lon,
                  vessel.lat,
                  vessel.lon,
                );

                if (Number.isNaN(vessel._targetApproachBearing)) {
                  this.logger.error(`❌ [BEARING_ERROR] NaN bearing för ${vessel.mmsi} target approach`);
                  vessel._targetApproachBearing = 0;
                }
              } catch (err) {
                this.logger.error(`❌ [BEARING_ERROR] Fel vid bearing-beräkning för ${vessel.mmsi}: ${err.message}`);
                vessel._targetApproachBearing = 0;
              }
              vessel._targetApproachTime = Date.now();
              this.logger.debug(
                `📍 [UNDER_BRIDGE] Fartyg ${vessel.mmsi} närmar sig TARGET ${vessel.targetBridge} från bearing ${vessel._targetApproachBearing.toFixed(0)}°`,
              );
            }

            // Track for nearBridge
            if (!vessel._wasInsideNear || vessel._nearBridgeId !== bridgeId) {
              vessel._wasInsideNear = true;
              vessel._nearBridgeId = bridgeId;
              try {
                vessel._nearApproachBearing = this._calculateBearing(
                  bridge.lat,
                  bridge.lon,
                  vessel.lat,
                  vessel.lon,
                );

                if (Number.isNaN(vessel._nearApproachBearing)) {
                  this.logger.error(`❌ [BEARING_ERROR] NaN bearing för ${vessel.mmsi} near approach`);
                  vessel._nearApproachBearing = 0;
                }
              } catch (err) {
                this.logger.error(`❌ [BEARING_ERROR] Fel vid bearing-beräkning för ${vessel.mmsi}: ${err.message}`);
                vessel._nearApproachBearing = 0;
              }
              vessel._nearApproachTime = Date.now();
              this.logger.debug(
                `📍 [UNDER_BRIDGE] Fartyg ${vessel.mmsi} närmar sig NEAR ${this.bridges[bridgeId].name} från bearing ${vessel._nearApproachBearing.toFixed(0)}°`,
              );
            }

            // Common tracking
            vessel._closestBridgeDistance = distance;
            vessel._bridgeApproachId = bridgeId;
          }

          // Update closest distance if vessel is getting closer
          if ((vessel._wasInsideTarget || vessel._wasInsideNear) && distance < (vessel._closestBridgeDistance || Infinity)) {
            vessel._closestBridgeDistance = distance;
          }

          // Store previous distance for trend detection
          if (bridgeToCheck) {
            vessel._previousBridgeDistance = vessel._lastBridgeDistance;
            vessel._lastBridgeDistance = distance;
          }

          // Detect passage - vessel has crossed to "other side" of bridge
          const wasInside = (vessel._wasInsideTarget && bridgeToCheck === vessel.targetBridge)
                           || (vessel._wasInsideNear && vessel._nearBridgeId === bridgeId);

          if (wasInside && distance > UNDER_BRIDGE_DISTANCE) {
            // Calculate bearing from bridge to vessel
            const bearingFromBridge = this._calculateBearing(
              bridge.lat,
              bridge.lon,
              vessel.lat,
              vessel.lon,
            );

            // Get the appropriate approach bearing
            const approachBearing = (vessel._wasInsideTarget && bridgeToCheck === vessel.targetBridge)
              ? vessel._targetApproachBearing
              : vessel._nearApproachBearing;

            // Check if vessel has "crossed" the bridge (bearing changed significantly)
            if (approachBearing !== undefined) {
              const bearingDiff = Math.abs(this._normalizeAngleDiff(bearingFromBridge, approachBearing));

              this.logger.debug(
                `🧭 [BRIDGE_PASSAGE] Bearing-analys för ${vessel.mmsi}: `
                + `approach=${approachBearing.toFixed(0)}°, current=${bearingFromBridge.toFixed(0)}°, `
                + `diff=${bearingDiff.toFixed(0)}°`,
              );

              // Vessel has crossed when bearing difference > 150 degrees (nearly opposite side)
              if (bearingDiff > 150) {
                // Mark as passed
                this.logger.debug(
                  `🌉 [BRIDGE_PASSAGE] Fartyg ${vessel.mmsi} har korsat ${this.bridges[bridgeId].name} `
                  + `(bearing ändrat ${bearingDiff.toFixed(0)}° från approach)`,
                );

                // Update vessel status to 'passed'
                this._syncStatusAndFlags(vessel, 'passed');

                // Clean up all approach tracking variables
                delete vessel._wasInsideTarget;
                delete vessel._wasInsideNear;
                delete vessel._targetApproachBearing;
                delete vessel._nearApproachBearing;
                delete vessel._targetApproachTime;
                delete vessel._nearApproachTime;
                delete vessel._nearBridgeId;
                delete vessel._closestBridgeDistance;
                delete vessel._lastBridgeDistance;
                delete vessel._previousBridgeDistance;
                delete vessel._bridgeApproachId;
                delete vessel._minDistanceToBridge;
                delete vessel._minDistanceTime;

                // Only clear nearBridge if vessel has moved outside APPROACH_RADIUS
                const currentDistance = this._haversine(
                  vessel.lat,
                  vessel.lon,
                  this.bridges[bridgeId].lat,
                  this.bridges[bridgeId].lon,
                );
                if (currentDistance > APPROACH_RADIUS) {
                  vessel.nearBridge = null;
                  this.logger.debug(`🌉 [TARGET_PASSAGE] Clearing nearBridge för ${vessel.mmsi} - utanför ${APPROACH_RADIUS}m (${currentDistance.toFixed(0)}m)`);
                } else {
                  this.logger.debug(`🌉 [TARGET_PASSAGE] Behåller nearBridge för ${vessel.mmsi} - fortfarande inom ${APPROACH_RADIUS}m (${currentDistance.toFixed(0)}m)`);
                }
                vessel.etaMinutes = null;
                delete vessel._lockNearBridge; // Release any nearBridge lock

                // Add to passedBridges if not already there
                if (!vessel.passedBridges) {
                  vessel.passedBridges = [];
                }
                if (!vessel.passedBridges.includes(bridgeId)) {
                  vessel.passedBridges.push(bridgeId);
                  vessel.lastPassedBridgeTime = Date.now(); // Spara tidsstämpel för "precis passerat" meddelanden
                }

                // Emit bridge:passed event
                this.emit('bridge:passed', {
                  vessel,
                  bridgeId,
                  bridge,
                  distance,
                });

                this.logger.debug(
                  `🌉 [BRIDGE_EVENT] bridge:passed utlöst för ${vessel.mmsi} vid ${this.bridges[bridgeId].name} (status: ${vessel.status})`,
                );

                // Predict and set next target bridge immediately
                const nextTargetBridge = this._findTargetBridge(vessel, bridgeId);
                if (nextTargetBridge) {
                  vessel.targetBridge = nextTargetBridge;
                  // IMPORTANT: Reset status to en-route when vessel gets new target
                  this._syncStatusAndFlags(vessel, 'en-route');
                  this.logger.debug(
                    `🎯 [BRIDGE_PASSAGE] Ny målbro för ${vessel.mmsi}: ${nextTargetBridge} (status: ${vessel.status})`,
                  );
                  // Force UI update
                  this.emit('vessel:eta-changed', { vessel });
                } else {
                  vessel.targetBridge = null;
                  this.logger.debug(
                    `🏁 [BRIDGE_PASSAGE] Ingen mer målbro för ${vessel.mmsi} - rutt slutförd, tar bort direkt`,
                  );
                  // Remove vessel immediately as it has passed its last user bridge
                  this.vesselManager.removeVessel(vessel.mmsi);
                }
              } else {
                // Bearing difference not enough for passage
                this.logger.debug(
                  `⏸️ [BRIDGE_PASSAGE] Fartyg ${vessel.mmsi} är >50m från ${this.bridges[bridgeId].name} men har inte korsat bron (bearing diff: ${bearingDiff.toFixed(0)}°)`,
                );
              }
            } else if (distance > 150) {
              // Fallback: Om ingen approach bearing finns men båten var under bron och är nu långt borta
              this.logger.debug(
                `🌉 [BRIDGE_PASSAGE] Fallback detection: Fartyg ${vessel.mmsi} troligen passerat ${this.bridges[bridgeId].name} (nu ${distance.toFixed(0)}m bort)`,
              );

              // Markera som passerad
              this._syncStatusAndFlags(vessel, 'passed');

              // Clean up all approach tracking variables
              delete vessel._wasInsideTarget;
              delete vessel._wasInsideNear;
              delete vessel._targetApproachBearing;
              delete vessel._nearApproachBearing;
              delete vessel._targetApproachTime;
              delete vessel._nearApproachTime;
              delete vessel._nearBridgeId;
              delete vessel._closestBridgeDistance;
              delete vessel._lastBridgeDistance;
              delete vessel._previousBridgeDistance;
              delete vessel._bridgeApproachId;
              delete vessel._minDistanceToBridge;
              delete vessel._minDistanceTime;

              // Only clear nearBridge if vessel has moved outside APPROACH_RADIUS
              const currentDistance = this._haversine(
                vessel.lat,
                vessel.lon,
                this.bridges[bridgeId].lat,
                this.bridges[bridgeId].lon,
              );
              if (currentDistance > APPROACH_RADIUS) {
                vessel.nearBridge = null;
                this.logger.debug(`🌉 [PASSAGE] Clearing nearBridge för ${vessel.mmsi} - utanför ${APPROACH_RADIUS}m (${currentDistance.toFixed(0)}m)`);
              } else {
                this.logger.debug(`🌉 [PASSAGE] Behåller nearBridge för ${vessel.mmsi} - fortfarande inom ${APPROACH_RADIUS}m (${currentDistance.toFixed(0)}m)`);
              }
              vessel.etaMinutes = null;
              delete vessel._lockNearBridge; // Release any nearBridge lock

              // Lägg till i passedBridges
              if (!vessel.passedBridges) {
                vessel.passedBridges = [];
              }
              if (!vessel.passedBridges.includes(bridgeId)) {
                vessel.passedBridges.push(bridgeId);
                vessel.lastPassedBridgeTime = Date.now();
              }

              // Emit event och hitta nästa bro
              this.emit('bridge:passed', {
                vessel, bridgeId, bridge, distance,
              });

              const nextTargetBridge = this._findTargetBridge(vessel, bridgeId);
              if (nextTargetBridge) {
                vessel.targetBridge = nextTargetBridge;
                this._syncStatusAndFlags(vessel, 'en-route');
                this.logger.debug(`🎯 [BRIDGE_PASSAGE] Ny målbro för ${vessel.mmsi}: ${nextTargetBridge}`);
                this.emit('vessel:eta-changed', { vessel });
              }
            }
          }

          // Enhanced passage detection for distant vessels based on movement patterns
          // This catches vessels that bypass bridges without getting within 50m
          if (vessel.targetBridge) {
            const targetId = this._findBridgeIdByNameInMonitor(vessel.targetBridge);
            if (targetId && this.bridges[targetId]) {
              const targetBridge = this.bridges[targetId];
              const currentDistance = this._calculateDistance(
                vessel.lat,
                vessel.lon,
                targetBridge.lat,
                targetBridge.lon,
              );

              // Track minimum distance to bridge for movement pattern analysis
              if (!vessel._minDistanceToBridge || currentDistance < vessel._minDistanceToBridge) {
                vessel._minDistanceToBridge = currentDistance;
                vessel._minDistanceTime = Date.now();
              }

              // Enhanced passage detection based on movement patterns
              const wasCloserBefore = vessel._minDistanceToBridge && vessel._minDistanceToBridge < currentDistance;
              const hasMovementHistory = vessel._previousBridgeDistance !== undefined;
              const isMovingAway = hasMovementHistory && vessel._previousBridgeDistance < currentDistance;
              const significantDistanceIncrease = hasMovementHistory
                && (currentDistance - vessel._previousBridgeDistance) > 100; // >100m increase

              // Check if vessel was approaching but is now clearly moving away
              const wasApproaching = vessel._minDistanceToBridge && vessel._minDistanceToBridge <= 800; // Was within 800m
              const isNowFarAway = currentDistance > 400; // Now >400m away
              const hasPassedMinimumDistance = wasCloserBefore && isNowFarAway;

              // Movement pattern passage detection
              if (!vessel._wasInsideTarget && !vessel._wasInsideNear && hasPassedMinimumDistance) {
                const timeSinceClosest = Date.now() - (vessel._minDistanceTime || 0);
                const trackingDuration = Date.now() - vessel._lastSeen;

                // Detect passage if:
                // 1. Vessel was closer before (minimum distance tracking)
                // 2. Now moving away significantly
                // 3. Has been tracked long enough to establish pattern
                // 4. Moved away from closest approach for reasonable time
                if (wasApproaching && isMovingAway && significantDistanceIncrease
                    && trackingDuration > 60 * 1000 && timeSinceClosest > 30 * 1000) {

                  this.logger.debug(
                    `🌉 [MOVEMENT_PASSAGE] Fartyg ${vessel.mmsi} troligen passerat ${vessel.targetBridge} - `
                    + `min avstånd: ${vessel._minDistanceToBridge.toFixed(0)}m, nu: ${currentDistance.toFixed(0)}m, `
                    + `ökning: ${(currentDistance - vessel._previousBridgeDistance).toFixed(0)}m`,
                  );

                  // Mark as passed and clean up
                  this._syncStatusAndFlags(vessel, 'passed');
                  vessel.nearBridge = null;
                  vessel.etaMinutes = null;

                  // Add to passedBridges
                  if (!vessel.passedBridges) {
                    vessel.passedBridges = [];
                  }
                  if (!vessel.passedBridges.includes(targetId)) {
                    vessel.passedBridges.push(targetId);
                    vessel.lastPassedBridgeTime = Date.now();
                  }

                  // Emit bridge:passed event for "precis passerat" messages
                  this.emit('bridge:passed', {
                    vessel,
                    bridgeId: targetId,
                    bridge: targetBridge,
                    distance: currentDistance,
                  });

                  this.logger.debug(
                    `🌉 [BRIDGE_EVENT] bridge:passed utlöst för ${vessel.mmsi} vid ${targetBridge.name} (movement pattern detection)`,
                  );

                  // Find next target or remove vessel
                  const nextTargetBridge = this._findTargetBridge(vessel, targetId);
                  if (nextTargetBridge) {
                    vessel.targetBridge = nextTargetBridge;
                    this._syncStatusAndFlags(vessel, 'en-route');
                    this.logger.debug(`🎯 [MOVEMENT_PASSAGE] Ny målbro för ${vessel.mmsi}: ${nextTargetBridge}`);
                    this.emit('vessel:eta-changed', { vessel });

                    // Reset tracking variables for new target
                    delete vessel._minDistanceToBridge;
                    delete vessel._minDistanceTime;
                  } else {
                    vessel.targetBridge = null;
                    this.logger.debug(
                      `🏁 [MOVEMENT_PASSAGE] Ingen mer målbro för ${vessel.mmsi} - tar bort`,
                    );
                    this.vesselManager.removeVessel(vessel.mmsi);
                  }

                  // Movement pattern passage was detected and handled
                  // The original backup detection logic will be skipped due to vessel state changes
                }
              }
            }
          }

          // Original backup passage detection for vessels that never got close enough
          // Check if vessel has been moving away from target bridge for significant distance
          if (vessel.targetBridge && !vessel._wasInsideTarget && !vessel._wasInsideNear) {
            const targetId = this._findBridgeIdByNameInMonitor(vessel.targetBridge);
            if (targetId && this.bridges[targetId]) {
              const targetBridge = this.bridges[targetId];
              const distanceToTarget = this._calculateDistance(
                vessel.lat,
                vessel.lon,
                targetBridge.lat,
                targetBridge.lon,
              );

              // If vessel is >500m from target bridge and has been tracked for >2 minutes,
              // assume it passed the bridge on the side
              const trackingDuration = Date.now() - vessel._lastSeen;
              if (distanceToTarget > 500 && trackingDuration > 2 * 60 * 1000) {
                this.logger.debug(
                  `🌉 [DISTANCE_PASSAGE] Fartyg ${vessel.mmsi} troligen passerat ${vessel.targetBridge} på sidan - `
                  + `${distanceToTarget.toFixed(0)}m bort efter ${Math.round(trackingDuration / 60000)}min`,
                );

                // Mark as passed and clean up
                this._syncStatusAndFlags(vessel, 'passed');
                vessel.nearBridge = null;
                vessel.etaMinutes = null;

                // Add to passedBridges
                if (!vessel.passedBridges) {
                  vessel.passedBridges = [];
                }
                if (!vessel.passedBridges.includes(targetId)) {
                  vessel.passedBridges.push(targetId);
                  vessel.lastPassedBridgeTime = Date.now();
                }

                // Find next target or remove vessel
                const nextTargetBridge = this._findTargetBridge(vessel, targetId);
                if (nextTargetBridge) {
                  vessel.targetBridge = nextTargetBridge;
                  this._syncStatusAndFlags(vessel, 'en-route');
                  this.logger.debug(`🎯 [DISTANCE_PASSAGE] Ny målbro för ${vessel.mmsi}: ${nextTargetBridge}`);
                  this.emit('vessel:eta-changed', { vessel });
                } else {
                  vessel.targetBridge = null;
                  this.logger.debug(
                    `🏁 [DISTANCE_PASSAGE] Ingen mer målbro för ${vessel.mmsi} - tar bort`,
                  );
                  this.vesselManager.removeVessel(vessel.mmsi);
                }
              }
            }
          }
        }
      }
    } else {
      vessel.nearBridge = null;
      vessel.etaMinutes = null;
      this.logger.debug(
        `🗺️ [VESSEL_UPDATE] Fartyg ${vessel.mmsi} inte i närheten av någon bro`,
      );
    }

    // Irrelevant detection enligt kravspec §4.2
    // Flagga irrelevant när alla villkor är sanna:
    // 1. nearBridge === null
    // 2. sog < 0.20 kn kontinuerligt ≥ 2 min
    // 3. distance > 300 m
    const { nearBridge } = vessel;
    const tooSlow = vessel.sog < 0.20; // < 0.20 kn
    const outsideBridgeZone = !nearestBridge || nearestBridge.distance > APPROACH_RADIUS;

    if (!nearBridge && tooSlow && outsideBridgeZone) {
      // Track kontinuerlig låg hastighet utanför brozon
      if (!vessel._inactiveSince) {
        vessel._inactiveSince = Date.now();
        vessel._inactiveSpeed = vessel.sog;
        this.logger.debug(
          `💤 [VESSEL_IRRELEVANT] Fartyg ${vessel.mmsi} började vara inaktivt (${vessel.sog.toFixed(2)}kn < 0.20kn, ${nearestBridge?.distance.toFixed(0) || '∞'}m > 300m)`,
        );
      }

      const inactiveDuration = Date.now() - vessel._inactiveSince;

      if (inactiveDuration > WAITING_TIME_THRESHOLD) { // 2 minuter kontinuerlig inaktivitet
        if (vessel.status !== 'waiting' && vessel.status !== 'under-bridge' && vessel.status !== 'approaching') {
          this._syncStatusAndFlags(vessel, 'idle'); // Set status to idle only if not actively waiting/approaching
          // Clear targetBridge for idle vessels
          if (vessel.targetBridge) {
            this.logger.debug(
              `🧹 [VESSEL_IRRELEVANT] Rensar targetBridge för inaktivt fartyg ${vessel.mmsi}`,
            );
            vessel.targetBridge = null;
          }
        }
        this.logger.debug(
          `🗑️ [VESSEL_IRRELEVANT] Fartyg ${vessel.mmsi} inaktivt i ${Math.round(inactiveDuration / 1000)}s - markerar som irrelevant`,
        );
        this.emit('vessel:irrelevant', { vessel });
      } else {
        this.logger.debug(
          `⏳ [VESSEL_IRRELEVANT] Fartyg ${vessel.mmsi} inaktivt i ${Math.round(inactiveDuration / 1000)}s av 120s`,
        );
      }
    } else if (vessel._inactiveSince) {
      // Återställ om något villkor inte längre uppfylls
      this.logger.debug(
        `🏃 [VESSEL_IRRELEVANT] Fartyg ${vessel.mmsi} inte längre inaktivt (nearBridge=${nearBridge}, sog=${vessel.sog.toFixed(2)}kn, distance=${nearestBridge?.distance.toFixed(0) || '∞'}m)`,
      );
      delete vessel._inactiveSince;
      delete vessel._inactiveSpeed;
    }

    // Emit ETA change event for continuous UI updates
    if (oldData?.etaMinutes !== vessel.etaMinutes) {
      this.logger.debug(
        `📈 [UI] ETA changed för ${vessel.mmsi}: ${
          oldData?.etaMinutes || 'N/A'
        } -> ${vessel.etaMinutes || 'N/A'} min - forcerar UI-update`,
      );
      this.emit('vessel:eta-changed', { vessel });
    }

    // UI push vid första waiting och under-bridge
    if (oldData?.status !== vessel.status
        && (vessel.status === 'waiting' || vessel.status === 'under-bridge')) {
      this.emit('vessel:eta-changed', { vessel });
    }

    // Spara distansen på vesseln för cleanup-logik
    const nearestBridgeForDistance = this._findNearestBridge(vessel);
    vessel._distanceToNearest = nearestBridgeForDistance
      ? nearestBridgeForDistance.distance
      : Infinity;

    return vessel;
  }

  /**
   * Find the nearest bridge to a vessel
   */
  _findNearestBridge(vessel) {
    // Kontrollera att vessel finns
    if (!vessel) {
      this.logger.warn('⚠️ [NEAREST_BRIDGE] Vessel är null eller undefined');
      return null;
    }
    // Kontrollera att vessel har giltiga koordinater
    if (vessel.lat == null || vessel.lon == null
        || Number.isNaN(vessel.lat) || Number.isNaN(vessel.lon)) {
      this.logger.warn(`⚠️ [NEAREST_BRIDGE] Ogiltiga koordinater för fartyg: lat=${vessel.lat}, lon=${vessel.lon}`);
      return null;
    }

    let nearestBridge = null;
    let nearestDistance = Infinity;

    for (const [bridgeId, bridge] of Object.entries(this.bridges)) {
      const distance = this._haversine(
        vessel.lat,
        vessel.lon,
        bridge.lat,
        bridge.lon,
      );

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestBridge = { bridge, bridgeId, distance };
      }
    }

    return nearestBridge;
  }

  /**
   * Find bridge ID by bridge name (BridgeMonitor version)
   */
  _findBridgeIdByNameInMonitor(name) {
    for (const [id, bridge] of Object.entries(this.bridges)) {
      if (bridge.name === name) return id;
    }
    return null;
  }

  /**
   * Calculate bearing between two points
   */
  _calculateBearing(lat1, lon1, lat2, lon2) {
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos((lat2 * Math.PI) / 180);
    const x = Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180)
      - Math.sin((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.cos(dLon);
    const bearing = (Math.atan2(y, x) * 180) / Math.PI;
    return (bearing + 360) % 360;
  }

  /**
   * Calculate normalized angular difference between two angles (0-360)
   * Handles the 0°/360° boundary correctly
   * @param {number} angle1 - First angle in degrees
   * @param {number} angle2 - Second angle in degrees
   * @returns {number} - Normalized difference (0-180)
   */
  _normalizeAngleDiff(angle1, angle2) {
    // Kontrollera för null/undefined
    if (angle1 == null || angle2 == null || Number.isNaN(angle1) || Number.isNaN(angle2)) {
      this.logger.warn(`⚠️ [ANGLE_DIFF] Ogiltiga vinklar: angle1=${angle1}, angle2=${angle2}`);
      return 180; // Returnera max diff som säker fallback
    }

    let diff = Math.abs(angle1 - angle2);
    if (diff > 180) {
      diff = 360 - diff;
    }
    return diff;
  }

  checkVesselPosition(vessel) {
    this.logger.debug(
      `🗺️ [POSITION_CHECK] Kontrollerar position för fartyg ${
        vessel.mmsi
      } (${vessel.lat?.toFixed(6)}, ${vessel.lon?.toFixed(6)})`,
    );

    const nearbyBridges = this._findNearbyBridges(vessel);

    this.logger.debug(
      `🌉 [POSITION_CHECK] Hittade ${nearbyBridges.length} broar i närheten:`,
      nearbyBridges.map((b) => ({
        bridge: b.bridgeId,
        distance: `${b.distance.toFixed(0)}m`,
      })),
    );

    for (const { bridgeId, bridge, distance } of nearbyBridges) {
      const analysis = this._analyzeApproach(vessel, bridge, distance);

      this.logger.debug(
        `🔍 [POSITION_CHECK] Analys för ${vessel.mmsi} vid ${bridgeId}:`,
        {
          distance: `${distance.toFixed(0)}m`,
          isRelevant: analysis.isRelevant,
          isApproaching: analysis.isApproaching,
          confidence: analysis.confidence,
          isWaiting: analysis.isWaiting,
        },
      );

      if (analysis.isRelevant) {
        this.logger.debug(
          `✅ [POSITION_CHECK] Fartyg ${vessel.mmsi} är relevant för ${bridgeId} - associerar`,
        );

        this.vesselManager.associateVesselWithBridge(
          vessel.mmsi,
          bridgeId,
          distance,
        );

        if (this._isApproachingUserBridge(vessel, bridgeId, analysis)) {
          const targetBridge = this._findTargetBridge(vessel, bridgeId);

          this.logger.debug(
            `🎯 [POSITION_CHECK] Närmar sig användarbro! Utlöser bridge:approaching för ${vessel.mmsi} -> ${targetBridge}`,
          );

          this.emit('bridge:approaching', {
            vessel,
            bridgeId,
            bridge,
            distance,
            analysis,
            targetBridge,
          });
        } else {
          this.logger.debug(
            `ℹ️ [POSITION_CHECK] ${vessel.mmsi} vid ${bridgeId} närmar sig inte användarbro`,
          );
        }
      } else {
        this.logger.debug(
          `❌ [POSITION_CHECK] Fartyg ${vessel.mmsi} inte relevant för ${bridgeId} - avassocierar`,
        );
        this.vesselManager.disassociateVesselFromBridge(vessel.mmsi, bridgeId);
      }
    }
  }

  _findNearbyBridges(vessel) {
    const nearby = [];

    for (const [bridgeId, bridge] of Object.entries(this.bridges)) {
      const distance = this._haversine(
        vessel.lat,
        vessel.lon,
        bridge.lat,
        bridge.lon,
      );
      if (distance <= (bridge.radius || 300)) {
        nearby.push({ bridgeId, bridge, distance });
      }
    }

    return nearby.sort((a, b) => a.distance - b.distance);
  }

  _analyzeApproach(vessel, bridge, distance) {
    const bearing = this._calculateBearing(
      vessel.lat,
      vessel.lon,
      bridge.lat,
      bridge.lon,
    );
    const headingDiff = this._normalizeAngleDiff(vessel.cog, bearing);
    const isApproaching = headingDiff < 90;

    // Protection zone logic
    const inProtectionZone = distance <= 300;
    const isOnIncomingSide = this._isOnIncomingSide(vessel, bridge);

    // Speed thresholds based on distance
    const speedThreshold = distance < 100 ? 0.05 : 0.2;
    const hasMinimumSpeed = vessel.sog >= speedThreshold;

    // Smart approach detection
    const isSlowing = vessel.maxRecentSpeed > 0 && vessel.sog < vessel.maxRecentSpeed * 0.7;
    const isWaiting = distance < 100 && vessel.sog < 0.2 && vessel.maxRecentSpeed > 2.0; // threshold just 0.2kn for consistency

    const confidence = this._calculateConfidence(
      vessel,
      bridge,
      distance,
      isApproaching,
      isSlowing,
    );

    const isRelevant = (isApproaching
                   || vessel.status === 'waiting'
                   || vessel.status === 'under-bridge'
                   || (inProtectionZone && (isOnIncomingSide || vessel.sog < 0.5)))
      && hasMinimumSpeed;

    this.logger.debug(
      `🧮 [APPROACH_ANALYSIS] Detaljerad analys för ${vessel.mmsi}:`,
      {
        bearing: `${bearing.toFixed(1)}°`,
        vesselCOG: `${vessel.cog?.toFixed(1)}°`,
        headingDiff: `${headingDiff.toFixed(1)}°`,
        isApproaching: isApproaching ? '✅' : '❌',
        inProtectionZone: inProtectionZone ? '✅' : '❌',
        isOnIncomingSide: isOnIncomingSide ? '✅' : '❌',
        speedThreshold: `${speedThreshold.toFixed(2)}kn`,
        vesselSpeed: `${vessel.sog?.toFixed(2)}kn`,
        hasMinimumSpeed: hasMinimumSpeed ? '✅' : '❌',
        isSlowing: isSlowing ? '✅' : '❌',
        isWaiting: isWaiting ? '✅' : '❌',
        confidence,
        isRelevant: isRelevant ? '✅' : '❌',
      },
    );

    return {
      isRelevant,
      isApproaching,
      isWaiting,
      isSlowing,
      confidence,
    };
  }

  _calculateConfidence(vessel, bridge, distance, isApproaching, isSlowing) {
    let score = 0;

    if (isApproaching) score += 30;
    if (distance < 500) score += 20;
    if (isSlowing && distance < 300) score += 25;
    if (vessel.sog > 0.3) score += 15;
    if (this._isOnCorrectSide(vessel, bridge)) score += 10;

    if (score >= 70) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }

  _isApproachingUserBridge(vessel, bridgeId, analysis) {
    this.logger.debug(
      `🎯 [USER_BRIDGE_CHECK] Kontrollerar om ${vessel.mmsi} närmar sig användarbro (${bridgeId})`,
    );

    // Check if this is directly a user bridge
    if (this.userBridges.includes(bridgeId)) {
      const result = analysis.isRelevant && analysis.confidence !== 'low';
      this.logger.debug(
        `🏁 [USER_BRIDGE_CHECK] Direkt användarbro ${bridgeId}: relevant=${
          analysis.isRelevant
        }, confidence=${analysis.confidence} -> ${result ? '✅' : '❌'}`,
      );
      return result;
    }

    // Check if vessel is on route to a user bridge
    const targetBridge = this._findTargetBridge(vessel, bridgeId);
    const result = targetBridge !== null
      && analysis.isRelevant
      && analysis.confidence !== 'low';

    this.logger.debug(
      `🏤 [USER_BRIDGE_CHECK] Indirekt rutt till användarbro: targetBridge=${targetBridge}, relevant=${
        analysis.isRelevant
      }, confidence=${analysis.confidence} -> ${result ? '✅' : '❌'}`,
    );

    return result;
  }

  _findTargetBridge(vessel, currentBridgeId) {
    this.logger.debug(
      `🎯 [TARGET_BRIDGE] Söker målbro för ${vessel.mmsi} vid ${currentBridgeId}`,
    );

    // Check if boat has already passed this bridge
    if (vessel.passedBridges && vessel.passedBridges.includes(currentBridgeId)) {
      this.logger.debug(
        `⏭️ [TARGET_BRIDGE] Fartyg ${vessel.mmsi} har redan passerat ${currentBridgeId}, letar efter nästa bro`,
      );
      // Continue to find next bridge
    } else if (this.userBridges.includes(currentBridgeId)) {
      const bridgeName = this.bridges[currentBridgeId].name;
      this.logger.debug(
        `🏁 [TARGET_BRIDGE] ${currentBridgeId} är redan användarbro -> ${bridgeName}`,
      );
      return bridgeName;
    }

    const currentIndex = this.bridgeOrder.indexOf(currentBridgeId);
    // Använd bredare nordlig sektor för att avgöra generell riktning
    const isGoingNorth = this._isVesselGenerallyNorthbound(vessel);

    this.logger.debug('🧮 [TARGET_BRIDGE] Brosekvens-analys:', {
      currentBridgeId,
      currentIndex,
      isGoingNorth,
      vesselCOG: `${vessel.cog?.toFixed(1)}°`,
      bridgeOrder: this.bridgeOrder,
      userBridges: this.userBridges,
    });

    if (isGoingNorth) {
      this.logger.debug(
        `⬆️ [TARGET_BRIDGE] Går norrut - letar från index ${
          currentIndex + 1
        } till ${this.bridgeOrder.length - 1}`,
      );
      for (let i = currentIndex + 1; i < this.bridgeOrder.length; i++) {
        const bridgeId = this.bridgeOrder[i];
        this.logger.debug(
          `🔍 [TARGET_BRIDGE] Kontrollerar ${bridgeId} (index ${i}): ${
            this.userBridges.includes(bridgeId)
              ? 'användarbro ✅'
              : 'inte användarbro ❌'
          }`,
        );
        if (this.userBridges.includes(bridgeId)) {
          // Skip if already passed
          if (vessel.passedBridges && vessel.passedBridges.includes(bridgeId)) {
            this.logger.debug(
              `⏭️ [TARGET_BRIDGE] Hoppar över redan passerad bro: ${bridgeId}`,
            );
            continue;
          }
          const bridgeName = this.bridges[bridgeId].name;
          this.logger.debug(
            `✅ [TARGET_BRIDGE] Hittade nästa användarbro norrut: ${bridgeId} (${bridgeName})`,
          );
          return bridgeName;
        }
      }
    } else {
      this.logger.debug(
        `⬇️ [TARGET_BRIDGE] Går söderut - letar från index ${
          currentIndex - 1
        } till 0`,
      );
      for (let i = currentIndex - 1; i >= 0; i--) {
        const bridgeId = this.bridgeOrder[i];
        this.logger.debug(
          `🔍 [TARGET_BRIDGE] Kontrollerar ${bridgeId} (index ${i}): ${
            this.userBridges.includes(bridgeId)
              ? 'användarbro ✅'
              : 'inte användarbro ❌'
          }`,
        );
        if (this.userBridges.includes(bridgeId)) {
          // Skip if already passed
          if (vessel.passedBridges && vessel.passedBridges.includes(bridgeId)) {
            this.logger.debug(
              `⏭️ [TARGET_BRIDGE] Hoppar över redan passerad bro: ${bridgeId}`,
            );
            continue;
          }
          const bridgeName = this.bridges[bridgeId].name;
          this.logger.debug(
            `✅ [TARGET_BRIDGE] Hittade nästa användarbro söderut: ${bridgeId} (${bridgeName})`,
          );
          return bridgeName;
        }
      }
    }

    this.logger.debug(
      `❌ [TARGET_BRIDGE] Ingen användarbro hittad i riktning ${
        isGoingNorth ? 'norrut' : 'söderut'
      } från ${currentBridgeId}`,
    );
    return null;
  }

  /**
   * Validate and update target bridge based on vessel position and bridge sequence
   * This is a fallback mechanism when bearing-based passage detection fails
   */
  _validateAndUpdateTargetBridge(vessel) {
    if (!vessel.targetBridge) return false;

    const currentTargetId = this._findBridgeIdByNameInMonitor(vessel.targetBridge);
    if (!currentTargetId) return false;

    // Get vessel's current position relative to bridges
    const nearestBridge = this._findNearestBridge(vessel);
    if (!nearestBridge) return false;

    const currentBridge = this.bridges[currentTargetId];
    const distanceToCurrentTarget = this._haversine(
      vessel.lat, vessel.lon, currentBridge.lat, currentBridge.lon,
    );

    // If vessel is very close to current target bridge, don't change
    if (distanceToCurrentTarget < 150) {
      return false;
    }

    // Check if vessel has bypassed its current target bridge based on bridge sequence logic
    const currentTargetIndex = this.bridgeOrder.indexOf(currentTargetId);
    const nearestBridgeIndex = this.bridgeOrder.indexOf(nearestBridge.bridgeId);
    const isGoingNorth = this._isVesselGenerallyNorthbound(vessel);

    this.logger.debug(
      `🔍 [TARGET_VALIDATION] Kontrollerar målbro för ${vessel.mmsi}: `
      + `current=${vessel.targetBridge}(idx:${currentTargetIndex}), `
      + `nearest=${nearestBridge.bridgeId}(idx:${nearestBridgeIndex}), `
      + `direction=${isGoingNorth ? 'N' : 'S'}, distance=${distanceToCurrentTarget.toFixed(0)}m`,
    );

    let needsUpdate = false;
    let reason = '';

    if (isGoingNorth) {
      // Going north: if vessel is at a bridge AFTER the current target, update target
      if (nearestBridgeIndex > currentTargetIndex) {
        needsUpdate = true;
        reason = `Båten har passerat målbron (vid index ${nearestBridgeIndex} > ${currentTargetIndex})`;
      }
    } else if (nearestBridgeIndex < currentTargetIndex) {
      // Going south: if vessel is at a bridge BEFORE the current target, update target
      needsUpdate = true;
      reason = `Båten har passerat målbron (vid index ${nearestBridgeIndex} < ${currentTargetIndex})`;
    }

    // Add hysteresis: only update if this condition has been true for multiple updates
    const validationKey = `${currentTargetId}_bypass`;
    if (needsUpdate) {
      if (!vessel._targetValidationCount) vessel._targetValidationCount = {};

      vessel._targetValidationCount[validationKey] = (vessel._targetValidationCount[validationKey] || 0) + 1;

      // Require 3 consecutive validations to prevent oscillation
      if (vessel._targetValidationCount[validationKey] >= 3) {
        const newTarget = this._findTargetBridge(vessel, nearestBridge.bridgeId);
        if (newTarget && newTarget !== vessel.targetBridge) {
          // Mark the bypassed bridge as passed if it's a user bridge
          if (this.userBridges.includes(currentTargetId)) {
            if (!vessel.passedBridges) vessel.passedBridges = [];
            if (!vessel.passedBridges.includes(currentTargetId)) {
              vessel.passedBridges.push(currentTargetId);
              vessel.lastPassedBridgeTime = Date.now();
              this.logger.debug(
                `🌉 [TARGET_VALIDATION] Markerar ${vessel.targetBridge} som passerad (distance-based validation)`,
              );
            }
          }

          vessel.targetBridge = newTarget;
          // FIX 4: Reset ETA when target bridge changes
          vessel.etaMinutes = null;
          vessel.isApproaching = false;
          vessel._targetValidationCount = {}; // Reset all counters

          this.logger.debug(
            `🎯 [TARGET_VALIDATION] Uppdaterat målbro för ${vessel.mmsi}: ${newTarget} (${reason})`,
          );
          return true;
        }
      } else {
        this.logger.debug(
          `🔄 [TARGET_VALIDATION] Målbro-validering ${vessel._targetValidationCount[validationKey]}/3 för ${vessel.mmsi} (${reason})`,
        );
      }
    } else if (vessel._targetValidationCount) {
      // Reset validation counter if condition is no longer true
      delete vessel._targetValidationCount[validationKey];
    }

    return false;
  }

  _predictNextBridge(vessel, passedBridgeId) {
    const nextBridge = this._findTargetBridge(vessel, passedBridgeId);
    if (nextBridge) {
      this.emit('bridge:next-predicted', {
        vessel,
        passedBridgeId,
        nextBridge,
      });
    }
  }

  /* ---------- HJÄLP-METODER (en version var!) ---------- */
  _isVesselHeadingNorth(vessel) {
    // Heading 315°–45° = norrut (inkludera exakt 0°/360° som norr)
    const cog = Number(vessel.cog) || 0;
    return cog >= 315 || cog === 0 || cog <= 45;
  }

  /**
   * Avgör om fartyget generellt går i nordlig riktning (bredare sektor)
   * Används för att bestämma om fartyget går norr eller söder i broordningen
   * @param {Object} vessel - Fartygsobjekt med COG
   * @returns {boolean} - True om fartyget går generellt norrut (270°-90° via norr)
   */
  _isVesselGenerallyNorthbound(vessel) {
    const cog = Number(vessel.cog) || 0;
    // Bredare sektor: Allt från väst till öst via norr räknas som "northbound"
    // Detta inkluderar NV, N, NE plus väst och öst
    return cog >= 270 || cog <= 90;
  }

  _isOnCorrectSide(vessel, bridge) {
    return this._isVesselHeadingNorth(vessel)
      ? vessel.lat <= bridge.lat // på väg norrut
      : vessel.lat >= bridge.lat; // på väg söderut
  }

  _isOnIncomingSide(vessel, bridge) {
    const bearing = this._calculateBearing(
      vessel.lat,
      vessel.lon,
      bridge.lat,
      bridge.lon,
    );
    const diff = this._normalizeAngleDiff(vessel.cog, bearing);
    return diff <= 90;
  }

  /**
   * Synchronize vessel status with corresponding boolean flags
   * This ensures consistency across all status changes
   */
  _syncStatusAndFlags(vessel, newStatus) {
    vessel.status = newStatus;
    switch (newStatus) {
      case 'waiting':
        vessel.isWaiting = true;
        vessel.isApproaching = false;
        break;
      case 'approaching':
        vessel.isApproaching = true;
        vessel.isWaiting = false;
        break;
      case 'under-bridge':
        vessel.isApproaching = false;
        vessel.isWaiting = false;
        break;
      case 'en-route':
      case 'passed':
      case 'idle':
      case 'irrelevant':
        vessel.isApproaching = false;
        vessel.isWaiting = false;
        break;
      default:
        // Keep existing flags for unknown status
        this.logger.warn(`⚠️ [STATUS_SYNC] Unknown status: ${newStatus} for vessel ${vessel.mmsi}`);
        break;
    }
    this.logger.debug(`📊 [STATUS_SYNC] ${vessel.mmsi}: ${newStatus} (isApproaching: ${vessel.isApproaching}, isWaiting: ${vessel.isWaiting})`);
  }

  _haversine(lat1, lon1, lat2, lon2) {
    // Kontrollera för ogiltiga koordinater
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null
        || Number.isNaN(lat1) || Number.isNaN(lon1) || Number.isNaN(lat2) || Number.isNaN(lon2)) {
      this.logger.warn(`⚠️ [HAVERSINE] Ogiltiga koordinater: lat1=${lat1}, lon1=${lon1}, lat2=${lat2}, lon2=${lon2}`);
      return Infinity; // Returnera oändligt avstånd som säker fallback
    }

    const R = 6371000; // m
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a = Math.sin(Δφ / 2) ** 2
      + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  _isInsideBoundingBox(lat, lon) {
    // _isInsideBoundingBox removed – bounding-box filtering is handled by AISConnectionManager.
    return true;
  }

  /**
   * Validate if current targetBridge is still relevant for vessel
   * @param {Object} vessel - The vessel object
   * @returns {boolean} - True if targetBridge should be kept
   */
  _validateTargetBridge(vessel) {
    if (!vessel.targetBridge) return true;

    // Find target bridge
    const targetBridgeId = this._findBridgeIdByNameInMonitor(vessel.targetBridge);
    if (!targetBridgeId || !this.bridges[targetBridgeId]) {
      return false; // Bridge not found
    }

    const targetBridge = this.bridges[targetBridgeId];
    const distance = this._haversine(
      vessel.lat,
      vessel.lon,
      targetBridge.lat,
      targetBridge.lon,
    );

    // More lenient validation for boats that have passed bridges (i.e., between bridges)
    const hasPassed = vessel.passedBridges && vessel.passedBridges.length > 0;

    // If vessel is very far and not moving, clear target (but be more lenient for boats between bridges)
    const distanceThreshold = hasPassed ? 1500 : 800; // Allow more distance for boats between bridges
    if (distance > distanceThreshold && vessel.sog < 0.3) {
      this.logger.debug(
        `🎯 [TARGET_VALIDATION] Clearing target for ${vessel.mmsi} - too far (${distance.toFixed(0)}m > ${distanceThreshold}m) and too slow (${vessel.sog.toFixed(1)}kn)`,
      );
      return false;
    }

    // If vessel is far and heading away, clear target (but be more lenient for boats between bridges)
    const farDistanceThreshold = hasPassed ? 1000 : 400; // Allow more distance before checking heading
    if (distance > farDistanceThreshold && this._isVesselHeadingAway(vessel, targetBridge)) {
      this.logger.debug(
        `🎯 [TARGET_VALIDATION] Clearing target for ${vessel.mmsi} - heading away from bridge (distance: ${distance.toFixed(0)}m > ${farDistanceThreshold}m)`,
      );
      return false;
    }

    return true;
  }

  /**
   * Check if vessel is heading away from bridge
   * @param {Object} vessel - The vessel object
   * @param {Object} bridge - The bridge object
   * @returns {boolean} - True if vessel is heading away
   */
  _isVesselHeadingAway(vessel, bridge) {
    const bearing = this._calculateBearing(
      vessel.lat,
      vessel.lon,
      bridge.lat,
      bridge.lon,
    );
    const normalizedCogDiff = this._normalizeAngleDiff(vessel.cog, bearing);

    // If COG differs by more than 90 degrees, vessel is heading away
    return normalizedCogDiff > 90;
  }

  _isUserBridge(bridgeId) {
    // Check if bridge is a user bridge (target bridge for notifications)
    return this.userBridges.includes(bridgeId);
  }

  /**
   * 🚨 CRITICAL TARGET BRIDGE FIX: Check if vessel is near any user bridge
   * This helps prevent premature targetBridge clearing when vessel is still relevant
   */
  _isNearUserBridge(vessel) {
    const userBridgeNames = ['Klaffbron', 'Stridsbergsbron'];
    const nearThreshold = 1500; // More generous threshold for user bridge proximity

    for (const [, bridge] of Object.entries(this.bridges)) {
      if (userBridgeNames.includes(bridge.name)) {
        const distance = this._haversine(
          vessel.lat, vessel.lon,
          bridge.lat, bridge.lon,
        );

        if (distance < nearThreshold) {
          this.logger.debug(
            `🏗️ [USER_BRIDGE_PROXIMITY] Båt ${vessel.mmsi} är nära användarbro ${bridge.name} (${distance.toFixed(0)}m)`,
          );
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 🚨 CRITICAL TARGET BRIDGE FIX: Check if vessel is clearly heading away from all user bridges
   * More conservative than simple targetBridge validation - prevents false positives
   */
  _isVesselClearlyHeadingAway(vessel) {
    if (!vessel.cog || vessel.sog < 1.0) {
      // Don't consider slow or stationary boats as "heading away"
      return false;
    }

    const userBridgeNames = ['Klaffbron', 'Stridsbergsbron'];
    let headingAwayFromAll = true;

    for (const [, bridge] of Object.entries(this.bridges)) {
      if (userBridgeNames.includes(bridge.name)) {
        const distance = this._haversine(
          vessel.lat, vessel.lon,
          bridge.lat, bridge.lon,
        );

        // Only consider "heading away" if boat is distant enough and moving away
        if (distance < 2000) {
          headingAwayFromAll = false;
          break;
        }

        const bearing = this._calculateBearing(
          vessel.lat, vessel.lon,
          bridge.lat, bridge.lon,
        );
        const cogDiff = this._normalizeAngleDiff(vessel.cog, bearing);

        // If heading towards any user bridge, not "clearly heading away"
        if (cogDiff < 120) {
          headingAwayFromAll = false;
          break;
        }
      }
    }

    if (headingAwayFromAll) {
      this.logger.debug(
        `🚶 [HEADING_AWAY] Båt ${vessel.mmsi} är klart på väg bort från alla användarbroar (COG: ${vessel.cog?.toFixed(1)}°)`,
      );
    }

    return headingAwayFromAll;
  }

  _calculateDistance(lat1, lon1, lat2, lon2) {
    // 🚨 DEFENSIVE: Simple distance calculation for initial filtering with error protection
    try {
      // Validate inputs
      if (typeof lat1 !== 'number' || typeof lon1 !== 'number'
          || typeof lat2 !== 'number' || typeof lon2 !== 'number') {
        this.logger.warn(`⚠️ [DISTANCE_CALC] Defensive: Invalid coordinates - lat1:${lat1}, lon1:${lon1}, lat2:${lat2}, lon2:${lon2}`);
        return Infinity; // Return safe distance for filtering logic
      }

      // Check for NaN or infinite values
      if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
        this.logger.warn('⚠️ [DISTANCE_CALC] Defensive: Non-finite coordinates - returning Infinity');
        return Infinity;
      }

      const R = 6371000; // Earth radius in meters
      const dLat = ((lat2 - lat1) * Math.PI) / 180;
      const dLon = ((lon2 - lon1) * Math.PI) / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
        + Math.cos((lat1 * Math.PI) / 180)
          * Math.cos((lat2 * Math.PI) / 180)
          * Math.sin(dLon / 2)
          * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distance = R * c;

      // Validate result
      if (!Number.isFinite(distance) || distance < 0) {
        this.logger.warn(`⚠️ [DISTANCE_CALC] Defensive: Invalid result ${distance} - returning Infinity`);
        return Infinity;
      }

      return distance;
    } catch (distanceError) {
      this.logger.error('🚨 [DISTANCE_CALC] Defensive: Distance calculation failed:', distanceError.message);
      return Infinity; // Safe fallback for distance filtering
    }
  }

  // Smart bridge-specific timing calculation for "precis passerat" messages
  _calculatePassageWindow(vessel) {
    try {
      // Bridge gap distances (in meters)
      const bridgeGaps = {
        'jarnvagsbron-stridsbergsbron': 420, // Shortest gap - critical
        'stridsbergsbron-stallbackabron': 530,
        'olidebron-klaffbron': 950,
        'klaffbron-jarnvagsbron': 960,
      };

      const speed = vessel.sog || 3; // Default to 3kn if no speed data
      const [lastPassedBridge] = vessel.passedBridges?.slice(-1) || [];
      const { targetBridge } = vessel;

      if (!lastPassedBridge || !targetBridge) {
        // Fallback to old system
        return speed > 5 ? 120000 : 60000; // 2min fast, 1min slow
      }

      // FIX 1: Convert targetBridge name to bridge ID for consistent gap lookup
      const targetBridgeId = this._findBridgeIdByName(targetBridge);
      if (!targetBridgeId) {
        this.logger.debug(`⚠️ [PASSAGE_TIMING] VesselStateManager: Kunde inte hitta bridge ID för ${targetBridge} - använder fallback`);
        return speed > 5 ? 120000 : 60000;
      }

      const gapKey = `${lastPassedBridge}-${targetBridgeId}`;
      const gap = bridgeGaps[gapKey] || 800; // Default gap if not found

      // Calculate realistic travel time + safety margin
      const speedMps = (speed * 1852) / 3600; // Convert knots to m/s
      const travelTimeMs = (gap / speedMps) * 1000; // Travel time in milliseconds
      const timeWindow = travelTimeMs * 1.5; // Add 50% safety margin

      // Enforce reasonable bounds: minimum 90s (1.5min), maximum 300s (5min)
      const boundedWindow = Math.min(Math.max(timeWindow, 90000), 300000);

      this.logger.debug(
        `🕒 [PASSAGE_TIMING] ${vessel.mmsi}: ${gapKey} gap=${gap}m, speed=${speed.toFixed(1)}kn, `
        + `window=${(boundedWindow / 1000).toFixed(1)}s`,
      );

      return boundedWindow;
    } catch (timingError) {
      this.logger.warn(`⚠️ [PASSAGE_TIMING] Calculation failed for ${vessel.mmsi}:`, timingError.message);
      // Fallback to old system
      return vessel.sog > 5 ? 120000 : 60000;
    }
  }

  destroy() {
    this.removeAllListeners();
  }
}

// ============= MODUL 3: AIS CONNECTION MANAGER =============
class AISConnectionManager extends EventEmitter {
  constructor(apiKey, logger, bridges = {}) {
    super();
    this.apiKey = apiKey;
    this.logger = logger;
    this.bridges = bridges;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.isConnected = false;
    this.keepAliveInterval = null;
    this.reconnectTimeout = null;
    this.boundingBox = [
      [58.320786584215874, 12.269025682200194],
      [58.268138604819576, 12.323830097692591],
    ];
  }

  async connect() {
    if (!this._validateApiKey()) {
      this.emit('error', new Error('Invalid API key'));
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      try {
        // eslint-disable-next-line global-require
        const WS = require('ws');
        this.ws = new WS('wss://stream.aisstream.io/v0/stream');

        this.ws.on('open', () => {
          this.logger.log('WebSocket connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this._subscribe();
          this._startKeepAlive();
          this.emit('connected');
          resolve(true);
        });

        this.ws.on('message', (data) => {
          this._handleMessage(data);
        });

        this.ws.on('error', (error) => {
          this.logger.error('WebSocket error:', error);
          this.emit('error', error);
        });

        this.ws.on('close', (code, reason) => {
          this.logger.log(`WebSocket closed: ${code} ${reason}`);
          this.isConnected = false;
          this._stopKeepAlive();
          this.emit('disconnected', { code, reason });
          this._scheduleReconnect();
        });
      } catch (error) {
        this.logger.error('Connection failed:', error);
        this.emit('error', error);
        resolve(false);
      }
    });
  }

  disconnect() {
    this._stopKeepAlive();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        this.logger.debug(
          'WebSocket close error (expected in some environments):',
          error.message,
        );
      }
      this.ws = null;
    }

    this.isConnected = false;
  }

  _subscribe() {
    if (!this.ws || this.ws.readyState !== 1) return;

    const message = {
      Apikey: this.apiKey,
      BoundingBoxes: [this.boundingBox],
    };

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      this.logger.error('Subscribe error:', error);
    }
  }

  _startKeepAlive() {
    this._stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      this._subscribe();
    }, 60000);
  }

  _stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  _handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());

      if (!this._isPositionReport(message.MessageType)) {
        return;
      }

      const vesselData = this._extractVesselData(message);
      if (vesselData && this._validateVesselData(vesselData)) {
        this.emit('vessel:position', vesselData);
      }
    } catch (error) {
      this.logger.error('Message parsing error:', error);
    }
  }

  _isPositionReport(messageType) {
    return [
      'PositionReport',
      'StandardClassBPositionReport',
      'ExtendedClassBPositionReport',
    ].includes(messageType);
  }

  /**
   * Plockar ut de fält vi behöver ur ett inkommande AIS-meddelande
   * och garanterar att dirString ALDRIG blir undefined.
   */
  _extractVesselData(message) {
    const meta = message.Metadata || message.MetaData || {};
    const body = Object.values(message.Message || {})[0] || {};

    // 1) Råvärde för riktningen – ta TrueHeading i första hand, annars COG
    const dirRaw = meta.TrueHeading
      ?? body.TrueHeading
      ?? meta.COG
      ?? meta.Cog
      ?? body.COG
      ?? body.Cog;

    // 0–180° ≈ östlig kurs, 180–360° ≈ västlig kurs – anpassa om du vill!
    let towards = null;
    if (typeof dirRaw === 'number') {
      if (dirRaw >= 315 || (dirRaw > 0 && dirRaw <= 45)) towards = 'north';
      else if (dirRaw >= 135 && dirRaw <= 225) towards = 'south';
    }

    // 2) Returnera vessel-objektet
    return {
      mmsi: body.MMSI ?? meta.MMSI,
      lat: meta.Latitude ?? body.Latitude,
      lon: meta.Longitude ?? body.Longitude,
      sog: meta.SOG ?? meta.Sog ?? body.SOG ?? body.Sog ?? 0,
      cog: meta.COG ?? meta.Cog ?? body.COG ?? body.Cog ?? 0,
      name: (body.Name ?? meta.ShipName ?? '').trim() || 'Unknown',
      timestamp: Date.now(),

      /* ---------------- NYTT FÄLT ---------------- */
      dirString:
        typeof dirRaw === 'number' && !Number.isNaN(dirRaw)
          ? dirRaw.toString() // t.ex. "273"
          : 'okänd', // fallback som Flow-kortet accepterar
      towards, // t.ex. "north", "south" eller null
    };
  }

  _isWithinAnyBridgeZone(lat, lon) {
    return Object.values(this.bridges || {}).some((bridge) => {
      const distance = this._haversine(lat, lon, bridge.lat, bridge.lon);
      return distance <= APPROACH_RADIUS; // 300 m
    });
  }

  _haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos((lat1 * Math.PI) / 180)
        * Math.cos((lat2 * Math.PI) / 180)
        * Math.sin(dLon / 2)
        * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  _validateVesselData(data) {
    const inBridgeZone = this._isWithinAnyBridgeZone(data.lat, data.lon);
    const speedOk = inBridgeZone ? true : data.sog >= 0.2; // Inom 300m: alla hastigheter OK, utanför: minst 0.2 kn

    return (
      data.mmsi
      && data.lat !== undefined
      && Math.abs(data.lat) <= 90
      && data.lon !== undefined
      && Math.abs(data.lon) <= 180
      && speedOk
      && this._isInsideBoundingBox(data.lat, data.lon)
    );
  }

  _scheduleReconnect() {
    // Double-check to prevent race condition
    if (this.reconnectTimeout) return;

    // Check if we've exceeded max reconnect attempts
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(
        `Maximum reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Stopping reconnection.`,
      );
      this.emit('error', new Error('Maximum reconnection attempts exceeded'));
      return;
    }

    const delay = Math.min(10000 * 1.5 ** this.reconnectAttempts, MAX_RECONNECT_DELAY);

    this.reconnectAttempts++;
    this.logger.log(
      `Reconnecting in ${delay / 1000} seconds (attempt ${
        this.reconnectAttempts
      }/${MAX_RECONNECT_ATTEMPTS})`,
    );

    // Set timeout immediately to prevent race condition
    this.reconnectTimeout = setTimeout(() => {
      // Clear timeout reference before reconnection attempt to prevent race conditions
      const currentTimeout = this.reconnectTimeout;
      this.reconnectTimeout = null;

      // Verify we're still the active timeout to prevent race conditions
      if (currentTimeout) {
        this.connect();
      }
    }, delay);
  }

  _validateApiKey() {
    return (
      this.apiKey
      && this.apiKey.length >= 20
      && /^[a-zA-Z0-9-]+$/.test(this.apiKey)
    );
  }

  destroy() {
    this.disconnect();
    this.removeAllListeners();
  }

  /**
   * Kontroll om lat/lon befinner sig inom den bounding box som används för prenumerationen.
   * Returnerar true om ingen boundingBox är definierad.
   */
  _isInsideBoundingBox(lat, lon) {
    if (!this.boundingBox) return true;

    const [[lat1, lon1], [lat2, lon2]] = this.boundingBox;
    const minLat = Math.min(lat1, lat2);
    const maxLat = Math.max(lat1, lat2);
    const minLon = Math.min(lon1, lon2);
    const maxLon = Math.max(lon1, lon2);

    return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
  }
}

// ============= MODUL 4: MESSAGE GENERATOR =============
class MessageGenerator {
  constructor(bridges, logger) {
    this.bridges = bridges;
    this.logger = logger;
  }

  // Helper method to find bridge ID by name (for Fix 1: Mellanbroar precis passerat)
  _findBridgeIdByName(name) {
    for (const [id, bridge] of Object.entries(this.bridges)) {
      if (bridge.name === name) return id;
    }
    return null;
  }

  // Smart bridge-specific timing calculation for "precis passerat" messages
  _calculatePassageWindow(vessel) {
    try {
      // Bridge gap distances (in meters)
      const bridgeGaps = {
        'jarnvagsbron-stridsbergsbron': 420, // Shortest gap - critical
        'stridsbergsbron-stallbackabron': 530,
        'olidebron-klaffbron': 950,
        'klaffbron-jarnvagsbron': 960,
      };

      const speed = vessel.sog || 3; // Default to 3kn if no speed data
      const [lastPassedBridge] = vessel.passedBridges?.slice(-1) || [];
      const { targetBridge } = vessel;

      if (!lastPassedBridge || !targetBridge) {
        // Fallback to old system
        return speed > 5 ? 120000 : 60000; // 2min fast, 1min slow
      }

      // FIX 1: Convert targetBridge name to bridge ID for consistent gap lookup
      const targetBridgeId = this._findBridgeIdByName(targetBridge);
      if (!targetBridgeId) {
        this.logger.debug(`⚠️ [PASSAGE_TIMING] MessageGenerator: Kunde inte hitta bridge ID för ${targetBridge} - använder fallback`);
        return speed > 5 ? 120000 : 60000;
      }

      const gapKey = `${lastPassedBridge}-${targetBridgeId}`;
      const gap = bridgeGaps[gapKey] || 800; // Default gap if not found

      // Calculate realistic travel time + safety margin
      const speedMps = (speed * 1852) / 3600; // Convert knots to m/s
      const travelTimeMs = (gap / speedMps) * 1000; // Travel time in milliseconds
      const timeWindow = travelTimeMs * 1.5; // Add 50% safety margin

      // Enforce reasonable bounds: minimum 90s (1.5min), maximum 300s (5min)
      const boundedWindow = Math.min(Math.max(timeWindow, 90000), 300000);

      this.logger.debug(
        `🕒 [PASSAGE_TIMING] ${vessel.mmsi}: ${gapKey} gap=${gap}m, speed=${speed.toFixed(1)}kn, `
        + `window=${(boundedWindow / 1000).toFixed(1)}s`,
      );

      return boundedWindow;
    } catch (timingError) {
      this.logger.warn(`⚠️ [PASSAGE_TIMING] Calculation failed for ${vessel.mmsi}:`, timingError.message);
      // Fallback to old system
      return vessel.sog > 5 ? 120000 : 60000;
    }
  }

  generateBridgeText(relevantBoats) {
    this.logger.debug(
      `🎯 [BRIDGE_TEXT] Genererar bridge_text för ${
        relevantBoats?.length || 0
      } båtar`,
    );

    if (!relevantBoats || relevantBoats.length === 0) {
      this.logger.debug(
        '❌ [BRIDGE_TEXT] Inga relevanta båtar - returnerar standardmeddelande',
      );
      return 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
    }

    // Filter out any null/undefined entries that might have slipped through
    const validBoats = relevantBoats.filter((boat) => boat != null);
    if (validBoats.length === 0) {
      this.logger.debug(
        '❌ [BRIDGE_TEXT] Alla båtar var null/undefined - returnerar standardmeddelande',
      );
      return 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
    }

    // Log detailed boat information
    validBoats.forEach((boat, index) => {
      this.logger.debug(
        `🚢 [BRIDGE_TEXT] Båt ${index + 1}/${validBoats.length}:`,
        {
          mmsi: boat.mmsi,
          currentBridge: boat.currentBridge,
          targetBridge: boat.targetBridge,
          etaMinutes: typeof boat.etaMinutes === 'number' ? boat.etaMinutes.toFixed(1) : boat.etaMinutes,
          isWaiting: boat.isWaiting,
          confidence: boat.confidence,
          distance: typeof boat.distance === 'number' ? `${boat.distance.toFixed(0)}m` : boat.distance,
        },
      );
    });

    const groups = this._groupByTargetBridge(validBoats);
    const phrases = [];

    this.logger.debug(
      `🏗️ [BRIDGE_TEXT] Grupperade båtar i ${
        Object.keys(groups).length
      } målbroar:`,
      Object.keys(groups),
    );

    for (const [bridgeName, boats] of Object.entries(groups)) {
      // Defensive: Validate bridgeName
      if (!bridgeName || bridgeName === 'undefined' || bridgeName === 'null') {
        this.logger.debug(`⚠️ [BRIDGE_TEXT] Hoppar över ogiltig bridgeName: ${bridgeName}`);
        continue;
      }

      this.logger.debug(
        `🔨 [BRIDGE_TEXT] Skapar fras för ${bridgeName} med ${boats.length} båtar`,
      );
      const phrase = this._generatePhraseForBridge(bridgeName, boats);
      if (phrase) {
        this.logger.debug(`✅ [BRIDGE_TEXT] Fras skapad: "${phrase}"`);
        phrases.push(phrase);
      } else {
        this.logger.debug(
          `❌ [BRIDGE_TEXT] Ingen fras skapad för ${bridgeName}`,
        );
      }
    }

    const finalText = this._combinePhrases(phrases, groups);
    this.logger.debug(`🎯 [BRIDGE_TEXT] Slutligt meddelande: "${finalText}"`);

    return finalText;
  }

  _groupByTargetBridge(boats) {
    const groups = {};
    let skippedBoats = 0;

    for (const boat of boats) {
      // Skip null/undefined boats
      if (!boat) {
        skippedBoats++;
        continue;
      }

      const target = boat.targetBridge;
      if (!target) {
        this.logger.debug(
          `⚠️ [BRIDGE_TEXT] Hoppade över båt ${boat.mmsi} - saknar targetBridge`,
        );
        skippedBoats++;
        continue;
      }

      if (!groups[target]) {
        groups[target] = [];
        this.logger.debug(
          `🆕 [BRIDGE_TEXT] Skapade ny grupp för målbro: ${target}`,
        );
      }
      groups[target].push(boat);
    }

    this.logger.debug('📊 [BRIDGE_TEXT] Gruppering klar:', {
      totalBoats: boats.length,
      skippedBoats,
      groups: Object.keys(groups).map((bridge) => ({
        bridge,
        boatCount: groups[bridge].length,
        mmsis: groups[bridge].map((b) => b.mmsi),
      })),
    });

    return groups;
  }

  _generatePhraseForBridge(bridgeName, boats) {
    this.logger.debug(
      `🏗️ [BRIDGE_TEXT] Genererar fras för ${bridgeName} med ${
        boats?.length || 0
      } båtar`,
    );

    if (!boats || boats.length === 0) {
      this.logger.debug(
        `❌ [BRIDGE_TEXT] Inga båtar för ${bridgeName} - returnerar null`,
      );
      return null;
    }

    // Defensive: Validate and sanitize boat data
    const validBoats = boats.filter((boat) => {
      if (!boat || !boat.mmsi) {
        this.logger.debug('⚠️ [BRIDGE_TEXT] Hoppar över båt utan MMSI eller null boat');
        return false;
      }
      if (!boat.targetBridge) {
        this.logger.debug(`⚠️ [BRIDGE_TEXT] Hoppar över båt ${boat.mmsi} utan targetBridge`);
        return false;
      }
      if (boat.etaMinutes == null || Number.isNaN(boat.etaMinutes)) {
        this.logger.debug(`⚠️ [BRIDGE_TEXT] Fixar null/NaN ETA för båt ${boat.mmsi}`);
        boat.etaMinutes = 0; // Default to 0 if invalid
      }
      return true;
    });

    if (validBoats.length === 0) {
      this.logger.debug(
        `❌ [BRIDGE_TEXT] Alla båtar var ogiltiga för ${bridgeName} - returnerar null`,
      );
      return null;
    }

    // Find the highest priority boat: under-bridge > waiting > closest ETA
    const closest = validBoats.reduce((current, boat) => {
      if (!current) return boat;

      // Priority 1: Under-bridge beats everything
      if (boat.status === 'under-bridge' || boat.etaMinutes === 0) {
        if (current.status !== 'under-bridge' && current.etaMinutes !== 0) {
          this.logger.debug(
            `🔍 [BRIDGE_TEXT] Båt ${boat.mmsi} (under-bridge) beats ${current.mmsi} (${current.status}) - HIGHEST PRIORITY`,
          );
          return boat;
        }
      }

      // Priority 2: If current is under-bridge, keep it
      if (current.status === 'under-bridge' || current.etaMinutes === 0) {
        this.logger.debug(
          `🔍 [BRIDGE_TEXT] Keeping ${current.mmsi} (under-bridge) over ${boat.mmsi} (${boat.status})`,
        );
        return current;
      }

      // Priority 3: Among non-under-bridge boats, prefer shortest ETA
      const isCloser = boat.etaMinutes < current.etaMinutes;
      this.logger.debug(
        `🔍 [BRIDGE_TEXT] Jämför båt ${boat.mmsi} (ETA: ${boat.etaMinutes?.toFixed(1)}min, ${boat.status}) `
        + `med ${current.mmsi} (ETA: ${current.etaMinutes?.toFixed(1)}min, ${current.status}) -> ${isCloser ? 'närmare' : 'längre bort'}`,
      );
      return isCloser ? boat : current;
    });

    if (!closest) {
      this.logger.debug(
        `❌ [BRIDGE_TEXT] Kunde inte hitta närmaste båt för ${bridgeName}`,
      );
      return null;
    }

    const count = validBoats.length;
    const eta = this._formatETA(closest.etaMinutes, closest.isWaiting);
    const waiting = validBoats.filter(
      (b) => b.status === 'waiting' || b.isWaiting,
    ).length;
    const underBridge = validBoats.filter(
      (b) => b.status === 'under-bridge' || b.etaMinutes === 0,
    ).length;

    this.logger.debug(`📈 [BRIDGE_TEXT] Fras-stats för ${bridgeName}:`, {
      totalBoats: count,
      waitingBoats: waiting,
      underBridgeBoats: underBridge,
      priorityBoat: {
        mmsi: closest.mmsi,
        status: closest.status,
        etaMinutes: typeof closest.etaMinutes === 'number' ? closest.etaMinutes.toFixed(1) : closest.etaMinutes,
        isWaiting: closest.isWaiting,
        confidence: closest.confidence,
        currentBridge: closest.currentBridge,
      },
      formattedETA: eta,
    });

    let phrase;

    // Kolla om båt precis passerat en bro (smart bridge-specific tidsfönster)
    const timeWindow = this._calculatePassageWindow(closest);

    if (closest.lastPassedBridgeTime
        && (Date.now() - closest.lastPassedBridgeTime) < timeWindow
        && Array.isArray(closest.passedBridges) && closest.passedBridges.length > 0
        && closest.targetBridge) {
      const lastPassedId = closest.passedBridges[closest.passedBridges.length - 1];
      const lastPassedName = this.bridges[lastPassedId]?.name;

      // Kontrollera att det inte är samma bro vi är på väg till
      if (lastPassedName && lastPassedName !== bridgeName) {
        const suffix = eta ? `, beräknad broöppning ${eta}` : '';

        // Inkludera information om ytterligare båtar
        if (count === 1) {
          phrase = `En båt som precis passerat ${lastPassedName} närmar sig ${bridgeName}${suffix}`;
        } else {
          const additionalCount = count - 1;
          const additionalText = additionalCount === 1
            ? 'ytterligare 1 båt'
            : `ytterligare ${additionalCount} båtar`;
          phrase = `En båt som precis passerat ${lastPassedName} närmar sig ${bridgeName}, ${additionalText} på väg${suffix}`;
          this.logger.debug(
            `📊 [BRIDGE_TEXT] Precis-passerat count: ${count} totalt, 1 main + ${additionalCount} ytterligare`,
          );
        }

        this.logger.debug(
          `🌉✅ [BRIDGE_TEXT] Precis-passerat-fras: ${closest.mmsi} från ${lastPassedName} mot ${bridgeName} (${count} båtar totalt)`,
        );
        return phrase;
      }
    }

    // Mellanbro-fras (ledande båt)
    // Allow mellanbro message if:
    // 1. Has currentBridge different from target
    // 2. Close to current bridge (<=300m using APPROACH_RADIUS)
    if (
      closest.currentBridge
      && closest.currentBridge !== bridgeName
      && closest.distanceToCurrent <= APPROACH_RADIUS
    ) {
      // Avoid duplicate "inväntar broöppning" when eta already contains it
      let suffix = '';
      if (eta) {
        if (eta.includes('inväntar')) {
          suffix = `, ${eta}`;
        } else {
          suffix = `, beräknad broöppning ${eta}`;
        }
      }

      // Inkludera information om ytterligare båtar även för mellanbroar
      if (count === 1) {
        phrase = `En båt vid ${closest.currentBridge} närmar sig ${bridgeName}${suffix}`;
      } else {
        const additionalCount = count - 1;
        const additionalText = additionalCount === 1
          ? 'ytterligare 1 båt'
          : `ytterligare ${additionalCount} båtar`;
        phrase = `En båt vid ${closest.currentBridge} närmar sig ${bridgeName}, ${additionalText} på väg${suffix}`;
        this.logger.debug(
          `📊 [BRIDGE_TEXT] Mellanbro count: ${count} totalt, 1 main + ${additionalCount} ytterligare`,
        );
      }

      this.logger.debug(
        `🌉 [BRIDGE_TEXT] Mellanbro-fras: ${closest.mmsi} vid ${closest.currentBridge} mot ${bridgeName} (${count} båtar totalt)`,
      );
      return phrase;
    }

    if (count === 1) {
      // Enhanced logic with new status types - CHECK UNDER-BRIDGE FIRST (highest priority)
      if (closest.status === 'under-bridge' || closest.etaMinutes === 0) {
        // Show actual bridge where opening is happening, not target bridge
        const actualBridge = closest.currentBridge || bridgeName;
        phrase = `Broöppning pågår vid ${actualBridge}`;
        this.logger.debug(
          `🌉 [BRIDGE_TEXT] Under-bridge scenario: ${closest.mmsi} vid ${actualBridge} (status: ${closest.status}, ETA: ${closest.etaMinutes})`,
        );
      } else if (closest.status === 'waiting' || closest.isWaiting) {
        phrase = `En båt väntar vid ${closest.currentBridge || bridgeName}, inväntar broöppning`;
        this.logger.debug(
          `💤 [BRIDGE_TEXT] Väntscenario: ${closest.mmsi} vid ${
            closest.currentBridge || bridgeName
          }`,
        );
      } else if (
        (closest.confidence === 'high'
        || closest.status === 'approaching')
        && closest.distance <= APPROACH_RADIUS
      ) {
        phrase = `En båt närmar sig ${bridgeName}, beräknad broöppning ${eta}`;
        this.logger.debug(
          `🎯 [BRIDGE_TEXT] Närmande scenario: ${closest.mmsi} -> ${bridgeName} (${closest.distance.toFixed(0)}m)`,
        );
      } else {
        phrase = `En båt på väg mot ${bridgeName}, beräknad broöppning ${eta}`;
        this.logger.debug(
          `📍 [BRIDGE_TEXT] En-route scenario: ${closest.mmsi} vid ${closest.currentBridge || 'okänt läge'} mot ${bridgeName}`,
        );
      }
    } else if (underBridge > 0) {
      // HIGHEST PRIORITY: Under-bridge scenario - prioritize over waiting boats
      // Show actual bridge where opening is happening, not target bridge
      const actualBridge = closest.currentBridge || bridgeName;
      phrase = `Broöppning pågår vid ${actualBridge}`;
      this.logger.debug(
        `🌉 [BRIDGE_TEXT] Multi-boat under-bridge scenario (HIGHEST PRIORITY): ${closest.mmsi} vid ${actualBridge} (${count} båtar totalt, ${underBridge} under-bridge)`,
      );
    } else if (waiting > 0 && (closest.status === 'waiting' || closest.isWaiting)) {
      // SECOND PRIORITY: Waiting boats (only when no under-bridge boats)
      const additionalCount = count - waiting; // subtract waiting boats to avoid double-counting
      if (additionalCount === 0) {
        // All boats are waiting
        const waitingText = waiting === 1 ? '1 båt' : `${waiting} båtar`;
        phrase = `${waitingText} väntar vid ${bridgeName}, inväntar broöppning`;
      } else {
        // Mix of waiting and approaching boats
        const additionalText = additionalCount === 1
          ? 'ytterligare 1 båt'
          : `ytterligare ${additionalCount} båtar`;
        const waitingText = waiting === 1 ? '1 båt' : `${waiting} båtar`;
        phrase = `${waitingText} väntar vid ${bridgeName}, ${additionalText} på väg, inväntar broöppning`;
      }
      this.logger.debug(
        `👥💤 [BRIDGE_TEXT] Multi-boat waiting priority (SECOND PRIORITY): ${count} totalt, ${waiting} väntar`,
      );
    } else if (closest.distance <= APPROACH_RADIUS) {
      // Use "En båt..." format with "ytterligare N båtar på väg" - only if closest boat within 300m
      const additionalCount = count - 1;
      if (additionalCount === 0) {
        phrase = `En båt närmar sig ${bridgeName}, beräknad broöppning ${eta}`;
      } else {
        const additionalText = additionalCount === 1
          ? 'ytterligare 1 båt'
          : `ytterligare ${additionalCount} båtar`;
        phrase = `En båt närmar sig ${bridgeName}, ${additionalText} på väg, beräknad broöppning ${eta}`;
        this.logger.debug(
          `📊 [BRIDGE_TEXT] Standard count: ${count} totalt, 1 main + ${additionalCount} ytterligare`,
        );
      }
    } else {
      // Fallback when closest boat is outside 300m
      phrase = `En båt på väg mot ${bridgeName}, beräknad broöppning ${eta}`;
      this.logger.debug(
        `📍 [BRIDGE_TEXT] Distant approach: ${closest.mmsi} -> ${bridgeName} (${closest.distance.toFixed(0)}m)`,
      );
      this.logger.debug(
        `👥🚢 [BRIDGE_TEXT] Plural närmar sig: ${count} båtar mot ${bridgeName}`,
      );
    }

    this.logger.debug(
      `✅ [BRIDGE_TEXT] Fras genererad för ${bridgeName}: "${phrase}"`,
    );

    return phrase;
  }

  _formatETA(minutes, isWaiting = false) {
    // Defensive: Handle null/undefined/NaN minutes
    if (minutes == null || Number.isNaN(minutes)) {
      this.logger.debug(`⚠️ [FORMAT_ETA] Invalid minutes (${minutes}), returning fallback`);
      return 'beräknas';
    }

    if (isWaiting) return 'inväntar broöppning';
    if (minutes < 1) return 'nu';
    if (minutes === 1) return 'om 1 minut';
    const roundedMinutes = Math.round(minutes);
    if (roundedMinutes === 1) return 'om 1 minut';

    // Defensive: Handle very large ETAs
    if (roundedMinutes > 999) {
      this.logger.debug(`⚠️ [FORMAT_ETA] Very large ETA (${roundedMinutes}), capping at 999`);
      return 'om 999+ minuter';
    }

    return `om ${roundedMinutes} minuter`;
  }

  _combinePhrases(phrases, groups) {
    this.logger.debug(`🔗 [BRIDGE_TEXT] Kombinerar ${phrases.length} fraser`);

    if (phrases.length === 0) {
      this.logger.debug(
        '❌ [BRIDGE_TEXT] Inga fraser att kombinera - returnerar fallback-meddelande',
      );
      return 'Båtar upptäckta men tid kan ej beräknas';
    }

    if (phrases.length === 1) {
      this.logger.debug(
        `✅ [BRIDGE_TEXT] En fras - returnerar direkt: "${phrases[0]}"`,
      );
      return phrases[0];
    }

    // Check if same vessel triggers multiple bridges
    const vessels = new Set();
    const vesselBridgeMap = {};

    for (const [bridgeName, boats] of Object.entries(groups)) {
      boats.forEach((boat) => {
        vessels.add(boat.mmsi);
        if (!vesselBridgeMap[boat.mmsi]) {
          vesselBridgeMap[boat.mmsi] = [];
        }
        vesselBridgeMap[boat.mmsi].push(bridgeName);
      });
    }

    this.logger.debug('🔍 [BRIDGE_TEXT] Analys av fartyg över broar:', {
      uniqueVessels: vessels.size,
      totalPhrases: phrases.length,
      vesselBridgeMapping: vesselBridgeMap,
      duplicateVessels: Object.entries(vesselBridgeMap)
        .filter(([mmsi, bridges]) => bridges.length > 1)
        .map(([mmsi, bridges]) => ({ mmsi, bridges })),
    });

    if (vessels.size === 1) {
      // Same vessel - return most urgent
      const sortedPhrases = phrases.sort((a, b) => {
        const aTime = this._extractMinutes(a);
        const bTime = this._extractMinutes(b);
        this.logger.debug(
          `⏱️ [BRIDGE_TEXT] Jämför ETA: "${a}" (${aTime}min) vs "${b}" (${bTime}min)`,
        );
        return aTime - bTime;
      });

      const selectedPhrase = sortedPhrases[0];
      this.logger.debug(
        `🎯 [BRIDGE_TEXT] Samma fartyg vid flera broar - väljer mest brådskande: "${selectedPhrase}"`,
      );
      return selectedPhrase;
    }

    const combinedPhrase = phrases.join('; ');
    this.logger.debug(
      `🔗 [BRIDGE_TEXT] Olika fartyg - kombinerar alla fraser: "${combinedPhrase}"`,
    );

    return combinedPhrase;
  }

  _extractMinutes(phrase) {
    if (phrase.includes('nu')) return 0;
    const match = phrase.match(/om (\d+) minuter?/);
    return match ? parseInt(match[1], 10) : 999;
  }
}

// ============= MODUL 5: ETA CALCULATOR =============
class ETACalculator {
  constructor(bridgeGaps, logger) {
    this.bridgeGaps = bridgeGaps || {};
    this.logger = logger || {
      debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    };
  }

  calculateETA(vessel, targetDistance, bridgeId, targetBridgeId) {
    this.logger.debug(`⏱️ [ETA_CALC] Beräknar ETA för fartyg ${vessel.mmsi}:`, {
      targetDistance: `${targetDistance?.toFixed(0)}m`,
      bridgeId,
      targetBridgeId,
      vesselSpeed: `${vessel.sog?.toFixed(1)}kn`,
      maxRecentSpeed: `${vessel.maxRecentSpeed?.toFixed(1)}kn`,
    });

    // Distance-based rules
    if (targetDistance < UNDER_BRIDGE_DISTANCE) {
      this.logger.debug(
        `🏁 [ETA_CALC] Mycket nära (${targetDistance.toFixed(
          0,
        )}m < ${UNDER_BRIDGE_DISTANCE}m) - väntar vid bro`,
      );
      return { minutes: 0, isWaiting: true };
    }

    if (targetDistance < 100 && vessel.sog < 1.0) {
      this.logger.debug(
        `🐌 [ETA_CALC] Nära och långsam (${targetDistance.toFixed(
          0,
        )}m < 100m, ${vessel.sog?.toFixed(1)}kn < 1.0kn) - väntar vid bro`,
      );
      return { minutes: 0, isWaiting: true };
    }

    // Use bridge gaps if available
    const gapKey = `${bridgeId}_${targetBridgeId}`;
    const actualDistance = this.bridgeGaps[gapKey] || targetDistance || 0;

    this.logger.debug(
      `📏 [ETA_CALC] Avstånd: ${gapKey} -> ${actualDistance.toFixed(0)}m ${
        this.bridgeGaps[gapKey] ? '(från bridge_gaps)' : '(från målposition)'
      }`,
    );

    // Calculate effective speed enligt kravspec §6
    let effectiveSpeed = vessel.sog || 0;
    let speedReason = 'aktuell hastighet';

    if (vessel.isWaiting || vessel.status === 'waiting') {
      // Waiting: max(maxRecentSpeed, 2 kn)
      effectiveSpeed = Math.max(vessel.maxRecentSpeed || 0, 2.0);
      speedReason = `waiting - max(${vessel.maxRecentSpeed?.toFixed(1) || '0'}kn, 2.0kn)`;
    } else if (actualDistance < 200) {
      // < 200m: minst 0.5 kn
      effectiveSpeed = Math.max(vessel.sog || 0, 0.5);
      speedReason = 'nära (<200m) - minst 0.5kn';
    } else if (actualDistance >= 200 && actualDistance <= 500) {
      // 200-500m: minst 1.5 kn
      effectiveSpeed = Math.max(vessel.sog || 0, 1.5);
      speedReason = 'medeldistans (200-500m) - minst 1.5kn';
    } else {
      // > 500m: minst 2 kn
      effectiveSpeed = Math.max(vessel.sog || 0, 2.0);
      speedReason = 'långt avstånd (>500m) - minst 2.0kn';
    }

    this.logger.debug(
      `🚤 [ETA_CALC] Effektiv hastighet: ${effectiveSpeed.toFixed(
        1,
      )}kn (${speedReason})`,
    );

    const speedMs = effectiveSpeed * 0.514444;

    // Enhanced protection against division by zero and very small numbers
    if (speedMs < 0.1 || !Number.isFinite(speedMs)) {
      this.logger.debug(
        `⛔ [ETA_CALC] För låg eller ogiltig hastighet (${speedMs.toFixed(
          4,
        )}m/s) - returnerar maximal ETA`,
      );
      // Return large but reasonable ETA instead of Infinity
      return { minutes: 999, isWaiting: false };
    }

    const eta = actualDistance / speedMs / 60;

    // Additional safety check for the result
    if (!Number.isFinite(eta) || eta < 0) {
      this.logger.debug(
        `⛔ [ETA_CALC] Ogiltig ETA beräkning (${eta}) - returnerar fallback`,
      );
      return { minutes: 999, isWaiting: false };
    }

    this.logger.debug(
      `🧮 [ETA_CALC] Grundläggande ETA: ${eta.toFixed(
        1,
      )}min (${actualDistance.toFixed(0)}m ÷ ${speedMs.toFixed(2)}m/s ÷ 60s)`,
    );

    this.logger.debug(
      `✅ [ETA_CALC] Slutlig ETA: ${eta.toFixed(1)}min (isWaiting: false)`,
    );

    return { minutes: eta, isWaiting: false };
  }
}

// ============= HUVUDAPP =============
class AISBridgeApp extends Homey.App {
  async onInit() {
    this.log('AIS Bridge starting with robust architecture');

    // Initialize debug level
    this.debugLevel = this.homey.settings.get('debug_level') || 'basic';

    // Lyssna på ändringar i settings
    this._onSettingsChanged = (key, value) => {
      if (key === 'debug_level') {
        const newLevel = this.homey.settings.get('debug_level');
        this.log(
          `🔧 Raw value received: "${newLevel}" (type: ${typeof newLevel})`,
        );

        const allowed = ['off', 'basic', 'detailed', 'full'];
        if (allowed.includes(newLevel)) {
          this.debugLevel = newLevel;
          this.log(`🎛️ Debug-nivå ändrad till: ${this.debugLevel}`);
        } else {
          this.log(`⚠️ Ignoring invalid debug_level value: ${newLevel}`);
        }
      }
    };
    this.homey.settings.on('set', this._onSettingsChanged);

    /** Senaste anslutningsstatus så nya enheter kan få rätt värde direkt */
    this._isConnected = false;

    /** Initialize _lastSeen structure for test compatibility */
    this._lastSeen = {};

    /** Cache för UI-text och alarm för att undvika onödiga skrivningar */
    this._lastBridgeText = this._lastBridgeText || '';
    this._lastBridgeAlarm = this._lastBridgeAlarm ?? false;

    // Bridge definitions
    this.bridges = {
      olidebron: {
        name: 'Olidebron',
        lat: 58.272743083145855,
        lon: 12.275115821922993,
        radius: 300,
      },
      klaffbron: {
        name: 'Klaffbron',
        lat: 58.28409551543077,
        lon: 12.283929525245636,
        radius: 300,
      },
      jarnvagsbron: {
        name: 'Järnvägsbron',
        lat: 58.29164042152742,
        lon: 12.292025280073759,
        radius: 300,
      },
      stridsbergsbron: {
        name: 'Stridsbergsbron',
        lat: 58.293524096154634,
        lon: 12.294566425158054,
        radius: 300,
      },
      stallbackabron: {
        name: 'Stallbackabron',
        lat: 58.31142992293701,
        lon: 12.31456385688822,
        radius: 300,
      },
    };

    // Initialize modules
    this.vesselManager = new VesselStateManager(this, this.bridges);
    this.bridgeMonitor = new BridgeMonitor(
      this.bridges,
      this.vesselManager,
      this,
    );
    this.messageGenerator = new MessageGenerator(this.bridges, this);
    this.etaCalculator = new ETACalculator(
      {
        olidebron_klaffbron: 950,
        klaffbron_jarnvagsbron: 960,
        jarnvagsbron_stridsbergsbron: 420,
        stridsbergsbron_stallbackabron: 530,
      },
      this,
    );

    // Initialize device management
    this._devices = new Set();

    // Initialize global token
    await this._initGlobalToken();

    // Setup flow cards
    await this._setupFlowCards();

    // Start AIS connection
    await this._startConnection(); // denna kopplar events internt

    // Setup "Text & Flow" event listeners
    this._setupTextAndFlowListeners();

    // Setup monitoring
    this._setupMonitoring();

    this.log('AIS Bridge initialized successfully');
  }

  _connectModuleEvents() {
    if (this._eventsHooked) return; // 🆕 skydd
    this._eventsHooked = true;

    // Save references to vessel listeners for cleanup
    this._onVesselUpdated = ({ mmsi, data }) => {
      this.bridgeMonitor.checkVesselPosition(data);
    };

    this._onVesselRemoved = async ({ mmsi }) => {
      this.log(`Vessel ${mmsi} removed from tracking`);
      await this._clearBridgeText(mmsi);
      this._updateUI(); // Fire and forget
    };

    // Save bridge event handlers for cleanup
    this._onBridgeApproaching = (event) => {
      this._handleBridgeApproaching(event);
    };

    this._onBridgePassed = (event) => {
      this._handleBridgePassed(event);
    };

    this._onVesselEtaChanged = () => {
      this.debug('[UI] ETA changed - uppdaterar UI');
      this._updateUI();
    };

    this._onUserBridgePassed = () => {
      this.debug('[UI] User bridge passed - uppdaterar UI omedelbart');
      this._updateUI();
    };

    // Vessel updates
    this.vesselManager.on('vessel:updated', this._onVesselUpdated);
    this.vesselManager.on('vessel:removed', this._onVesselRemoved);

    // Bridge events
    this.bridgeMonitor.on('bridge:approaching', this._onBridgeApproaching);
    this.bridgeMonitor.on('bridge:passed', this._onBridgePassed);
    this.bridgeMonitor.on('vessel:eta-changed', this._onVesselEtaChanged);
    this.bridgeMonitor.on('vessel:user-bridge-passed', this._onUserBridgePassed);

    // AIS-connection-händelser (kontrollera att anslutningen finns)
    if (this.aisConnection) {
      // Spara referenser till listeners för att kunna avregistrera dem
      this._onVesselPosition = (data) => this.vesselManager.updateVessel(data.mmsi, data);
      this._onConnected = () => this._updateConnectionStatus(true);
      this._onDisconnected = () => this._updateConnectionStatus(false);
      this._onError = (err) => {
        this.error('AIS connection error:', err);
        this._updateConnectionStatus(false, err.message);
      };

      this.aisConnection.on('vessel:position', this._onVesselPosition);
      this.aisConnection.on('connected', this._onConnected);
      this.aisConnection.on('disconnected', this._onDisconnected);
      this.aisConnection.on('error', this._onError);
    }
  }

  _disconnectModuleEvents() {
    if (!this._eventsHooked) return;

    // Remove vessel listeners
    if (this._onVesselUpdated) {
      this.vesselManager.off('vessel:updated', this._onVesselUpdated);
    }
    if (this._onVesselRemoved) {
      this.vesselManager.off('vessel:removed', this._onVesselRemoved);
    }

    // Remove bridge listeners
    if (this._onBridgeApproaching) {
      this.bridgeMonitor.off('bridge:approaching', this._onBridgeApproaching);
    }
    if (this._onBridgePassed) {
      this.bridgeMonitor.off('bridge:passed', this._onBridgePassed);
    }
    if (this._onVesselEtaChanged) {
      this.bridgeMonitor.off('vessel:eta-changed', this._onVesselEtaChanged);
    }
    if (this._onUserBridgePassed) {
      this.bridgeMonitor.off('vessel:user-bridge-passed', this._onUserBridgePassed);
    }

    // Remove AIS connection listeners
    if (this.aisConnection) {
      if (this._onVesselPosition) {
        this.aisConnection.off('vessel:position', this._onVesselPosition);
      }
      if (this._onConnected) {
        this.aisConnection.off('connected', this._onConnected);
      }
      if (this._onDisconnected) {
        this.aisConnection.off('disconnected', this._onDisconnected);
      }
      if (this._onError) {
        this.aisConnection.off('error', this._onError);
      }
    }

    this._eventsHooked = false;
  }

  async _startConnection() {
    const apiKey = this.homey.settings.get('ais_api_key');
    if (!apiKey) {
      this.error('No API key configured');
      this._updateConnectionStatus(false, 'API-nyckel saknas');
      return;
    }

    // Reset event hooking flag before creating new connection
    this._eventsHooked = false;

    this.aisConnection = new AISConnectionManager(apiKey, this, this.bridges);
    // Connect module events (before connection to catch all events)
    this._connectModuleEvents();
    await this.aisConnection.connect();

    // Bounding-box already handled by AISConnectionManager – no call needed here.
  }

  _handleBridgeApproaching(event) {
    const {
      vessel,
      bridgeId,
      bridge,
      distance,
      analysis = {
        confidence: 'unknown',
        isApproaching: true,
        isWaiting: false,
      },
      targetBridge,
    } = event;

    this.debug(
      `🌉 [APPROACH] Fartyg ${vessel.mmsi} närmar sig ${bridge.name}:`,
      {
        distance: `${distance?.toFixed(0)}m`,
        targetBridge,
        confidence: analysis.confidence,
        isApproaching: analysis.isApproaching,
        isWaiting: analysis.isWaiting,
        vesselSpeed: `${vessel.sog?.toFixed(1)}kn`,
      },
    );

    if (!targetBridge) {
      this.debug(
        `❌ [APPROACH] Ingen målbro identifierad för ${vessel.mmsi} vid ${bridge.name} - hoppar över`,
      );
      return;
    }

    if (!this.bridgeMonitor.userBridges.includes(bridgeId)) {
      this.debug(
        `ℹ️ [APPROACH] ${bridge.name} är inte en användarbro - hoppar över (målbro: ${targetBridge})`,
      );
      return; // Only interested in user bridges
    }

    this.debug(
      `✅ [APPROACH] ${bridge.name} är användarbro - fortsätter med ETA-beräkning`,
    );

    // Calculate ETA
    const targetBridgeId = this._findBridgeIdByName(targetBridge);
    this.debug(`🎯 [APPROACH] Målbro-ID: ${targetBridge} -> ${targetBridgeId}`);

    const eta = this.etaCalculator.calculateETA(
      vessel,
      distance,
      bridgeId,
      targetBridgeId,
    );

    // Create relevant boat data
    const relevantBoat = {
      mmsi: vessel.mmsi,
      currentBridge: bridge.name,
      targetBridge,
      etaMinutes: eta.minutes,
      isWaiting: eta.isWaiting,
      confidence: analysis.confidence,
      distance,
    };

    this.debug('📋 [APPROACH] Skapad relevant båt-data:', relevantBoat);

    // Update UI with central system
    this.debug(`🔄 [APPROACH] Uppdaterar UI för ${vessel.mmsi}...`);
    this._updateUI();

    // Trigger flow
    this.debug(
      `🔔 [APPROACH] Utlöser flow för ${vessel.mmsi} vid ${bridge.name}...`,
    );
    this._triggerBoatNearFlow(
      vessel.mmsi,
      bridgeId,
      bridge.name,
      vessel.name,
      vessel.dirString,
    );

    this.debug(
      `✅ [APPROACH] Behandling klar för ${vessel.mmsi} vid ${bridge.name}`,
    );
  }

  _handleBridgePassed(event) {
    const { vessel, bridgeId, bridge } = event;
    this.log(`Vessel ${vessel.mmsi} passed ${bridge.name}`);

    // Rensa trigger-historik för den passerade bron
    const key = `${vessel.mmsi}-${bridgeId}`;
    if (this.vesselManager.triggeredFlows.has(key)) {
      this.vesselManager.triggeredFlows.delete(key);
      this.debug(
        `🧹 [TRIGGER_CLEAR] Rensat trigger-historik för ${vessel.mmsi} vid ${bridgeId} efter passage`,
      );
    }

    // Predict next bridge
    const nextTarget = this.bridgeMonitor._findTargetBridge(vessel, bridgeId);
    if (nextTarget) {
      this.log(`Predicting vessel ${vessel.mmsi} will approach ${nextTarget}`);
    }
  }

  async _updateUI() {
    const relevantBoats = this._findRelevantBoats();
    await this._updateUIWithRelevantBoats(relevantBoats);
  }

  _findRelevantBoats() {
    this.debug(
      `🔍 [RELEVANT_BOATS] Söker relevanta båtar för användarbror: ${this.bridgeMonitor.userBridges.join(
        ', ',
      )}`,
    );

    const relevantBoats = [];
    const userBridgeNames = ['Klaffbron', 'Stridsbergsbron'];

    // Iterate through ALL vessels in the system, not just those near user bridges
    for (const vessel of this.vesselManager.vessels.values()) {
      // Skip null/undefined vessels
      if (!vessel) {
        this.debug('⚠️ [RELEVANT_BOATS] Hoppade över null/undefined vessel');
        continue;
      }

      // Early filtering - skip vessels that are definitely not relevant
      if (vessel.status === 'passed' || vessel.status === 'irrelevant' || vessel.status === 'idle') {
        continue;
      }

      // Only include vessels with targetBridge matching user bridges
      if (!userBridgeNames.includes(vessel.targetBridge)) {
        // If vessel has undefined targetBridge but is near a user bridge, try to recover
        if (!vessel.targetBridge && vessel.nearBridge) {
          const nearBridgeName = this.bridges[vessel.nearBridge]?.name;
          if (userBridgeNames.includes(nearBridgeName)) {
            // Vessel is at a user bridge but has no target - set it as target
            vessel.targetBridge = nearBridgeName;
            // FIX 4: Reset ETA when target bridge is restored/assigned
            vessel.etaMinutes = null;
            vessel.isApproaching = false;
            this.debug(
              `🔄 [RELEVANT_BOATS] Återställer targetBridge för ${vessel.mmsi}: ${nearBridgeName} (var vid användarbro utan målbro), ETA nollställd`,
            );
          } else {
            // Try to find a target bridge from current position
            const targetBridge = this.bridgeMonitor._findTargetBridge(vessel, vessel.nearBridge);
            if (targetBridge && userBridgeNames.includes(targetBridge)) {
              vessel.targetBridge = targetBridge;
              // FIX 4: Reset ETA when target bridge is computed/assigned
              vessel.etaMinutes = null;
              vessel.isApproaching = false;
              this.debug(
                `🔄 [RELEVANT_BOATS] Återställer targetBridge för ${vessel.mmsi}: ${targetBridge} (beräknad från ${vessel.nearBridge}), ETA nollställd`,
              );
            } else {
              continue; // Still no valid target bridge
            }
          }
        } else {
          continue; // No target bridge and not near any bridge
        }
      }

      // NEW: Apply target bridge validation to ensure correct targeting
      if (vessel.targetBridge) {
        this.bridgeMonitor._validateAndUpdateTargetBridge(vessel);
      }

      // FIX 2: Enhanced stationary and ghost boat detection with tighter edge case filtering
      // This prevents "spökbåtar" from being counted in "ytterligare X båtar"
      const isLowSpeed = vessel.sog <= 0.25; // Tighter threshold (was 0.3)
      const isStationary = this.vesselManager._isVesselStationary(vessel);
      const hasActiveRoute = this.vesselManager._hasActiveTargetRoute(vessel);

      // Enhanced stationary detection with multiple criteria
      const timeSinceLastMove = Date.now() - (vessel.lastPositionChange || vessel._lastSeen);
      const hasntMovedFor60s = timeSinceLastMove > 60 * 1000; // Longer window for more confidence
      const isVeryLowSpeed = vessel.sog <= 0.15; // More restrictive (was 0.2)
      const hasntMovedFor3min = timeSinceLastMove > 180 * 1000; // FIX 2: Longer period for truly stationary boats

      // Skip stationary boats that are clearly anchored or not making meaningful progress
      if ((isLowSpeed && isStationary && !hasActiveRoute)
          || (isVeryLowSpeed && hasntMovedFor60s)
          || (vessel.sog <= 0.3 && hasntMovedFor3min)) { // FIX 2: Catch slow-moving non-active boats
        this.debug(
          `🚫 [RELEVANT_BOATS] Hoppar över stillastående/ankrad båt ${vessel.mmsi} - ${vessel.sog}kn, `
          + `${Math.round(timeSinceLastMove / 1000)}s utan rörelse, ${vessel._distanceToNearest?.toFixed(0)}m från bro, `
          + `aktiv rutt: ${hasActiveRoute}`,
        );
        continue;
      }

      // FIX 2: Stricter anchored boat filtering
      if (vessel.sog <= 0.15 && vessel._distanceToNearest > 350) { // Tighter thresholds
        this.debug(
          `🚫 [RELEVANT_BOATS] Hoppar över troligen ankrad båt ${vessel.mmsi} - ${vessel.sog}kn och ${vessel._distanceToNearest?.toFixed(0)}m från närmaste bro`,
        );
        continue;
      }

      // FIX 2: Enhanced confidence-based filtering for low-confidence boats
      if (vessel.confidence === 'low' || vessel.confidence === 'very-low') {
        // Low confidence boats need higher speed or closer distance to be counted
        if (vessel.sog < 0.5 && vessel._distanceToNearest > 500) {
          this.debug(
            `🚫 [RELEVANT_BOATS] Hoppar över låg-konfidens båt ${vessel.mmsi} - confidence: ${vessel.confidence}, ${vessel.sog}kn, ${vessel._distanceToNearest?.toFixed(0)}m`,
          );
          continue;
        }
      }

      // Final check: Skip boats with minimal movement over extended time periods
      if (vessel.sog <= 0.4 && vessel.lastPositionChange
          && (Date.now() - vessel.lastPositionChange) > 120 * 1000) { // 2 minutes without movement
        this.debug(
          `🚫 [RELEVANT_BOATS] Hoppar över båt utan rörelse ${vessel.mmsi} - ${vessel.sog}kn, ${Math.round((Date.now() - vessel.lastPositionChange) / 1000)}s utan positionsförändring`,
        );
        continue;
      }

      this.debug(
        `🎯 [RELEVANT_BOATS] Analyserar fartyg ${vessel.mmsi} med målbro ${vessel.targetBridge}`,
      );

      // Calculate distance to target bridge (not current bridge)
      const targetBridgeId = this._findBridgeIdByName(vessel.targetBridge);
      if (!targetBridgeId || !this.bridges[targetBridgeId]) {
        this.debug(
          `❌ [RELEVANT_BOATS] Målbro ${vessel.targetBridge} hittades inte för ${vessel.mmsi}`,
        );
        continue;
      }

      const targetBridge = this.bridges[targetBridgeId];

      // Use cached distance if available and recent
      let distanceToTarget;
      if (vessel.distanceToTarget && vessel.targetBridge === vessel._lastTargetBridge) {
        distanceToTarget = vessel.distanceToTarget;
      } else {
        distanceToTarget = this.bridgeMonitor._haversine(
          vessel.lat,
          vessel.lon,
          targetBridge.lat,
          targetBridge.lon,
        );
        vessel.distanceToTarget = distanceToTarget;
        vessel._lastTargetBridge = vessel.targetBridge;
      }

      // FIX 2: Enhanced distance and speed filtering to reduce ghost boats
      // If vessel is > 800m away and moving < 1.2 knot, it's not relevant (tighter than 1000m/1kn)
      if (distanceToTarget > 800 && vessel.sog < 1.2) {
        this.debug(
          `⏭️ [RELEVANT_BOATS] Hoppar över fartyg ${vessel.mmsi} - för långt borta (${distanceToTarget.toFixed(0)}m) och för långsam (${vessel.sog.toFixed(1)}kn)`,
        );
        continue;
      }

      // If vessel is > 500m away and barely moving, it's not relevant (tighter than 600m/0.2kn)
      if (distanceToTarget > 500 && vessel.sog < 0.25) {
        this.debug(
          `⏭️ [RELEVANT_BOATS] Hoppar över fartyg ${vessel.mmsi} - för långt borta (${distanceToTarget.toFixed(0)}m) och står still (${vessel.sog.toFixed(1)}kn)`,
        );
        continue;
      }

      // FIX 2: Enhanced heading verification - stricter for distant boats
      if (distanceToTarget > 300) {
        const isHeadingTowards = this._isVesselHeadingTowardsBridge(vessel, targetBridge);
        // For boats >1km away, require stronger heading evidence and minimum speed
        if (distanceToTarget > 1000 && (!isHeadingTowards || vessel.sog < 1.5)) {
          this.debug(
            `⏭️ [RELEVANT_BOATS] Hoppar över avlägset fartyg ${vessel.mmsi} - ${distanceToTarget.toFixed(0)}m, heading: ${isHeadingTowards}, speed: ${vessel.sog.toFixed(1)}kn`,
          );
          continue;
        }
        // For boats 300-1000m, require heading towards bridge if slow
        if (vessel.sog < 1.0 && !isHeadingTowards) {
          this.debug(
            `⏭️ [RELEVANT_BOATS] Hoppar över fartyg ${vessel.mmsi} - för långt borta (${distanceToTarget.toFixed(0)}m) och inte på väg mot bron`,
          );
          continue;
        }
      }

      // Filter out vessels with status 'irrelevant'
      if (vessel.status === 'irrelevant') {
        this.debug(
          `⏭️ [RELEVANT_BOATS] Hoppar över fartyg ${vessel.mmsi} - status: irrelevant`,
        );
        continue;
      }

      // Enhanced currentBridge logic to prevent "vid null" messages
      let currentBridgeName = null;
      let distanceToCurrent = Infinity;

      if (vessel.nearBridge && this.bridges[vessel.nearBridge]) {
        // Priority 1: Boat is currently near a bridge (≤300m)
        currentBridgeName = this.bridges[vessel.nearBridge].name;
        distanceToCurrent = this.bridgeMonitor._haversine(
          vessel.lat, vessel.lon,
          this.bridges[vessel.nearBridge].lat,
          this.bridges[vessel.nearBridge].lon,
        );
        this.debug(
          `🌉 [RELEVANT_BOATS] Fartyg ${vessel.mmsi} har nearBridge: ${currentBridgeName} (${distanceToCurrent.toFixed(0)}m)`,
        );
      } else if (Array.isArray(vessel.passedBridges) && vessel.passedBridges.length > 0) {
        // Priority 2: Boat is between bridges - use the last passed bridge as currentBridge
        const lastPassedBridgeId = vessel.passedBridges[vessel.passedBridges.length - 1];
        if (this.bridges[lastPassedBridgeId]) {
          currentBridgeName = this.bridges[lastPassedBridgeId].name;
          distanceToCurrent = this.bridgeMonitor._haversine(
            vessel.lat, vessel.lon,
            this.bridges[lastPassedBridgeId].lat,
            this.bridges[lastPassedBridgeId].lon,
          );
          this.debug(
            `🔄 [RELEVANT_BOATS] Fartyg ${vessel.mmsi} mellan broar - använder senaste passerade bro: ${currentBridgeName} (${distanceToCurrent.toFixed(0)}m)`,
          );
        }
      } else {
        // Priority 3: Fallback - find nearest bridge even if >300m away to prevent "vid null"
        let nearestBridge = null;
        let nearestDistance = Infinity;

        const bridgeEntries = Object.entries(this.bridges);
        if (bridgeEntries.length > 20) {
          this.logger.warn(`⚠️ [BRIDGE_SAFETY] Unusually large bridge count: ${bridgeEntries.length} - limiting to prevent infinite loops`);
        }

        for (const [bridgeId, bridge] of bridgeEntries.slice(0, 20)) { // Safety limit
          const distance = this.bridgeMonitor._haversine(
            vessel.lat, vessel.lon,
            bridge.lat, bridge.lon,
          );
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestBridge = { id: bridgeId, name: bridge.name, distance };
          }
        }

        if (nearestBridge && nearestDistance <= 300) { // Max 300m for fallback (aligned with APPROACH_RADIUS)
          currentBridgeName = nearestBridge.name;
          distanceToCurrent = nearestDistance;
          this.debug(
            `📍 [RELEVANT_BOATS] Fartyg ${vessel.mmsi} fallback currentBridge: ${currentBridgeName} (${distanceToCurrent.toFixed(0)}m) - förhindrar "vid null"`,
          );
        } else if (vessel.targetBridge) {
          // Priority 4: Last resort - use target bridge context if available
          currentBridgeName = vessel.targetBridge;
          distanceToCurrent = distanceToTarget;
          this.debug(
            `🎯 [RELEVANT_BOATS] Fartyg ${vessel.mmsi} använder targetBridge som currentBridge: ${currentBridgeName} (${distanceToCurrent.toFixed(0)}m) - sista utväg`,
          );
        } else {
          this.debug(
            `⚠️ [RELEVANT_BOATS] Fartyg ${vessel.mmsi} kunde inte bestämma currentBridge - för långt från alla broar (${nearestDistance?.toFixed(0) || '∞'}m)`,
          );
        }
      }

      this.debug(
        `📐 [RELEVANT_BOATS] Fartyg ${vessel.mmsi}: ${distanceToTarget.toFixed(
          0,
        )}m från målbro ${vessel.targetBridge}`,
      );

      // Calculate ETA to target bridge
      const eta = this.etaCalculator.calculateETA(
        vessel,
        distanceToTarget,
        vessel.nearBridge || targetBridgeId, // current bridge for route calculation
        targetBridgeId, // target bridge
      );

      // Ensure etaMinutes is never null/undefined/NaN with explicit null checking
      let finalEtaMinutes = (vessel.etaMinutes !== null && vessel.etaMinutes !== undefined)
        ? vessel.etaMinutes
        : eta.minutes;
      if (finalEtaMinutes == null || Number.isNaN(finalEtaMinutes)) {
        finalEtaMinutes = 0; // Default to 0 if no valid ETA available
        this.debug(
          `⚠️ [RELEVANT_BOATS] ETA var null/undefined/NaN för ${vessel.mmsi}, sätter till 0`,
        );
      }

      // Ensure all critical fields are defined to prevent data quality issues
      const relevantBoat = {
        mmsi: vessel.mmsi,
        currentBridge: currentBridgeName || 'Unknown',
        targetBridge: vessel.targetBridge || 'Unknown',
        etaMinutes: finalEtaMinutes,
        isWaiting: Boolean(vessel.status === 'waiting' || eta?.isWaiting || vessel.isWaiting),
        isApproaching: Boolean(vessel.status === 'approaching' || vessel.isApproaching),
        confidence: vessel.status === 'approaching' ? 'high' : 'medium',
        distance: distanceToTarget,
        distanceToCurrent,
        status: vessel.status || 'unknown', // Include new status field with fallback
      };

      this.debug(`➕ [RELEVANT_BOATS] Lade till fartyg ${vessel.mmsi}:`, {
        currentBridge: currentBridgeName,
        targetBridge: vessel.targetBridge,
        eta: `${relevantBoat.etaMinutes?.toFixed(1) || 'N/A'}min`,
        waiting: relevantBoat.isWaiting,
        distance: `${distanceToTarget.toFixed(0)}m`,
        status: vessel.status,
      });

      relevantBoats.push(relevantBoat);
    }

    this.debug(
      `📊 [RELEVANT_BOATS] Hittade totalt ${relevantBoats.length} relevanta båtar från hela bounding-boxen`,
    );

    return relevantBoats;
  }

  async _updateUIWithRelevantBoats(relevantBoats) {
    this.debug(
      `🖥️ [UI_UPDATE] Uppdaterar UI med ${relevantBoats.length} relevanta båtar`,
    );

    // Log relevant boats summary
    if (relevantBoats.length > 0) {
      this.debug(
        '📋 [UI_UPDATE] Relevanta båtar sammanfattning:',
        relevantBoats.map((boat) => ({
          mmsi: boat.mmsi,
          target: boat.targetBridge,
          eta: `${boat.etaMinutes?.toFixed(1)}min`,
          waiting: boat.isWaiting ? '✅' : '❌',
          confidence: boat.confidence,
        })),
      );
    }

    const text = this.messageGenerator.generateBridgeText(relevantBoats);
    const hasBoats = relevantBoats.length > 0;

    // Check cache to avoid unnecessary writes
    if (text === this._lastBridgeText && hasBoats === this._lastBridgeAlarm) {
      this.debug('[UI] Ingen ändring – skippar skrivning');
      return;
    }

    this.debug(
      `📝 [UI_UPDATE] Genererat bridge_text: "${text}" (alarm: ${
        hasBoats ? 'PÅ' : 'AV'
      })`,
    );

    // Update global token
    if (this._activeBridgesTag) {
      this.debug('🏷️ [UI_UPDATE] Uppdaterar global token...');
      this._activeBridgesTag
        .setValue(text)
        .then(() => this.debug('✅ [UI_UPDATE] Global token uppdaterad'))
        .catch((err) => this.error('❌ [UI_UPDATE] Failed to update token:', err));
    } else {
      this.debug('⚠️ [UI_UPDATE] Global token saknas - kan inte uppdatera');
    }

    // Update devices using centralized capability updater
    await this._updateDeviceCapabilities(text, hasBoats);

    // Update cache after successful write
    this._lastBridgeText = text;
    this._lastBridgeAlarm = hasBoats;

    this.debug(
      `🎯 [UI_UPDATE] UI-uppdatering klar - ${this._devices.size} enheter behandlade`,
    );
  }

  _setupMonitoring() {
    // Periodic health check
    this._healthInterval = setInterval(() => {
      const health = {
        vessels: this.vesselManager.vessels.size,
        bridges: this.vesselManager.bridgeVessels.size,
        connected: this.aisConnection?.isConnected || false,
        uptime: process.uptime(),
      };

      this.log('System health:', health);
    }, 60000);

    // Memory-hälsa – kan slå fel i vissa container-miljöer som Homey
    this._memoryInterval = setInterval(() => {
      try {
        const mem = process.memoryUsage();
        this.debug('[MEM]', (mem.rss / 1024 / 1024).toFixed(1), 'MB RSS');
      } catch (err) {
        // Gracefully handle environments where memory monitoring is not available
        this.debug('[MEM] Memory monitoring not available in this environment - disabled');
        clearInterval(this._memoryInterval); // stop trying
        this._memoryInterval = null; // Clear reference
      }
    }, 60 * 1000);
  }

  async _initGlobalToken() {
    const TOKEN_ID = 'active_bridges';
    try {
      this._activeBridgesTag = await this.homey.flow.createToken(TOKEN_ID, {
        type: 'string',
        title: 'Aktiva broar',
      });
    } catch (err) {
      if (err.message.includes('already')) {
        this._activeBridgesTag = await this.homey.flow.getToken(TOKEN_ID);
      } else {
        throw err;
      }
    }
  }

  async _setupFlowCards() {
    // Boat near trigger (bridge:approaching)
    this._boatNearTrigger = this.homey.flow.getTriggerCard('boat_near');
    this._boatNearTrigger.registerRunListener(
      (args, state) => {
        this.debug(
          `🔍 [FLOW_LISTENER] boat_near check: args.bridge="${args.bridge}", state.bridge="${state.bridge}"`,
        );
        const result = args.bridge === state.bridge || args.bridge === 'any';
        this.debug(
          `🔍 [FLOW_LISTENER] boat_near result: ${result} (match: ${args.bridge === state.bridge}, any: ${args.bridge === 'any'})`,
        );
        return result;
      },
    );

    // Bridge passed trigger removed - was unused

    // Boat at bridge condition
    this._boatAtBridgeCard = this.homey.flow.getConditionCard('boat_at_bridge');
    this._boatAtBridgeCard.registerRunListener((args) => {
      this.debug(
        `🔍 [CONDITION] boat_at_bridge check: bridge="${args.bridge}"`,
      );

      if (args.bridge === 'any') {
        // Kolla om någon båt är vid någon bro
        for (const vessel of this.vesselManager.vessels.values()) {
          if (vessel.nearBridge) {
            this.debug(
              `✅ [CONDITION] Båt ${vessel.mmsi} är vid ${vessel.nearBridge}`,
            );
            return true;
          }
        }
        return false;
      }

      // Kolla specifik bro
      const vessels = this.vesselManager.getVesselsByBridge(args.bridge);
      const hasBoat = vessels.length > 0;

      this.debug(
        `🔍 [CONDITION] ${hasBoat ? '✅' : '❌'} ${vessels.length} båtar vid ${args.bridge}`,
      );

      return hasBoat;
    });
  }

  /**
   * Utlöser Flow-kortet "Båt nära".
   * Om riktningen saknas får Homey alltid en sträng, aldrig undefined.
   */
  _triggerBoatNearFlow(mmsi, bridgeId, bridgeName, vesselName, direction = null) {
    // Kontrollera om denna kombination redan har triggats nyligen
    if (this.vesselManager.hasRecentlyTriggered(mmsi, bridgeId)) {
      return; // Hoppa över trigger om den nyligen har aktiverats
    }

    const dirString = direction && typeof direction === 'string' ? direction : 'okänd'; // ← fallback som uppfyller Homeys krav

    const tokens = {
      bridge_name: bridgeName,
      vessel_name: vesselName,
      direction: dirString,
    };

    // Debug-logga vad som skickas
    this.debug(
      `🎯 [TRIGGER] Skickar trigger för ${mmsi} vid ${bridgeId}: tokens=${JSON.stringify(tokens)}, state={bridge: "${bridgeId}"}`,
    );

    // Markera att trigger har skett
    this.vesselManager.markTriggered(mmsi, bridgeId);

    // Skicka för specifik bro
    this._boatNearTrigger
      .trigger(tokens, { bridge: bridgeId })
      .then(() => {
        this.debug(`✅ [TRIGGER] boat_near trigger lyckades för ${bridgeId}`);
      })
      .catch((err) => {
        this.error(`Failed to trigger boat_near for bridge ${bridgeId}:`, err);
      });

    // Skicka för wildcard "any"
    this._boatNearTrigger
      .trigger(tokens, { bridge: 'any' })
      .then(() => {
        this.debug('✅ [TRIGGER] boat_near trigger lyckades för \'any\'');
      })
      .catch((err) => {
        this.error('Failed to trigger boat_near for any bridge:', err);
      });
  }

  /**
   * Utlöser Flow-kortet "Bro passerad" för bridge:passed händelser.
   */
  // _triggerBridgePassedFlow method removed - unused flow card

  _updateConnectionStatus(isConnected, errorMessage = null) {
    // Spara så att nya enheter kan fråga direkt
    this._isConnected = isConnected;

    for (const device of this._devices) {
      if (!device) continue;

      // Store-värden (kräver inte capability)
      device.setStoreValue('connection_active', isConnected).catch(() => {});
      if (errorMessage) {
        device.setStoreValue('connection_error', errorMessage).catch(() => {});
      }

      // Capability   (finns i BridgeStatus-drivern)
      if (device.hasCapability?.('connection_status')) {
        const value = isConnected ? 'connected' : 'disconnected';
        device
          .setCapabilityValue('connection_status', value)
          .catch((err) => this.error('Failed to update connection_status', err));
      }
    }
  }

  async _saveDevices() {
    try {
      // Extract device IDs from the device collection
      const deviceIds = Array.from(this._devices)
        .filter((device) => device && device.getData)
        .map((device) => device.getData().id);

      // Save to persistent storage
      await this.homey.settings.set('saved_device_ids', deviceIds);
      this.log(`Saved ${deviceIds.length} device IDs to persistent storage`);
    } catch (err) {
      this.error('Failed to save devices to storage:', err);
    }
  }

  _findBridgeIdByName(name) {
    for (const [id, bridge] of Object.entries(this.bridges)) {
      if (bridge.name === name) return id;
    }
    return null;
  }

  /**
   * Setup "Text & Flow" event listeners as specified in requirements
   */
  _setupTextAndFlowListeners() {
    this.debug('🎯 [TEXT_FLOW] Setting up Text & Flow event listeners');

    // Save references to listeners for cleanup
    this._onVesselEntered = ({ mmsi, data }) => {
      this.debug(`🚢 [TEXT_FLOW] vessel:entered - ${mmsi}`);
      this._initialiseTargetBridge(data);
    };

    this._onBridgeApproaching = ({
      vessel, bridgeId, bridge, distance, targetBridge,
    }) => {
      this.debug(
        `🌉 [TEXT_FLOW] bridge:approaching - ${vessel.mmsi} at ${bridge.name}`,
      );
      vessel.nearBridge = bridgeId;

      // Synkronisera detekterad målbro med vessel.targetBridge
      if (targetBridge && targetBridge !== vessel.targetBridge) {
        const previousTarget = vessel.targetBridge;
        vessel._detectedTargetBridge = targetBridge;
        vessel.targetBridge = targetBridge; // Synkronisera huvudmålbron
        this.debug(
          `🎯 [TEXT_FLOW] Uppdaterad målbro för ${vessel.mmsi}: ${vessel.targetBridge} (tidigare: ${previousTarget})`,
        );
      }

      this._updateBridgeText(vessel);
    };

    this._onBridgePassed = ({ vessel, bridgeId, bridge }) => {
      this.debug(
        `🌉 [TEXT_FLOW] bridge:passed - ${vessel.mmsi} passed ${bridge.name}`,
      );

      // a) Predict next bridge and set new targetBridge
      this._predictNextBridge(vessel, bridgeId);

      // b) Reset vessel.nearBridge and temporary target
      vessel.nearBridge = null;
      delete vessel._detectedTargetBridge;

      // c) Update bridge text again
      this._updateBridgeText(vessel);

      // d) Bridge passed flow removed - unused
    };

    this._onVesselIrrelevant = ({ vessel }) => {
      this.debug(`🗑️ [TEXT_FLOW] vessel:irrelevant - ${vessel.mmsi}`);
      this.vesselManager.markIrrelevant(vessel.mmsi);
    };

    // Register listeners
    this.vesselManager.on('vessel:entered', this._onVesselEntered);
    this.bridgeMonitor.on('bridge:approaching', this._onBridgeApproaching);
    this.bridgeMonitor.on('bridge:passed', this._onBridgePassed);
    this.bridgeMonitor.on('vessel:irrelevant', this._onVesselIrrelevant);
    this._onVesselNeedsTarget = ({ vessel }) => {
      this._initialiseTargetBridge(vessel);
    };
    this.bridgeMonitor.on('vessel:needs-target', this._onVesselNeedsTarget);

    this.debug('✅ [TEXT_FLOW] Text & Flow event listeners setup complete');
  }

  /**
   * Check if vessel is heading towards a specific bridge based on COG
   * @param {Object} vessel - The vessel object
   * @param {Object} bridge - The bridge object with lat/lon
   * @returns {boolean} - True if vessel is heading towards bridge
   */
  _isVesselHeadingTowardsBridge(vessel, bridge) {
    // Skip check for very slow vessels as COG may be unreliable
    if (vessel.sog < 0.5) {
      return true; // Give benefit of doubt for slow vessels
    }

    const bearingToBridge = this.bridgeMonitor._calculateBearing(
      vessel.lat,
      vessel.lon,
      bridge.lat,
      bridge.lon,
    );

    const normalizedCogDiff = this.bridgeMonitor._normalizeAngleDiff(vessel.cog, bearingToBridge);

    // Vessel is heading towards bridge if COG difference is < 90 degrees
    const isHeadingTowards = normalizedCogDiff < 90;

    this.debug(
      `🧭 [HEADING_CHECK] Vessel ${vessel.mmsi}: COG=${vessel.cog.toFixed(1)}°, `
      + `bearing to bridge=${bearingToBridge.toFixed(1)}°, diff=${normalizedCogDiff.toFixed(1)}°, `
      + `heading towards=${isHeadingTowards}`,
    );

    return isHeadingTowards;
  }

  /**
   * Calculate first target bridge based on COG N↔︎S direction
   */
  _initialiseTargetBridge(vessel) {
    this.debug(
      `🧭 [INIT_TARGET] Initialising target bridge for vessel ${vessel.mmsi}`,
    );
    this.debug(
      `🧭 [INIT_TARGET] Vessel COG: ${
        vessel.cog
      }°, position: ${vessel.lat?.toFixed(6)}, ${vessel.lon?.toFixed(6)}`,
    );

    // Determine direction based on COG (Course Over Ground)
    const cog = Number(vessel.cog) || 0;
    const isHeadingNorth = cog >= 315 || cog === 0 || cog <= 45;

    this.debug(
      `🧭 [INIT_TARGET] Direction analysis: COG ${cog}° = ${
        isHeadingNorth ? 'North' : 'South'
      }`,
    );

    // Find nearest bridge first
    let nearestBridge = null;
    let nearestDistance = Infinity;

    for (const [bridgeId, bridge] of Object.entries(this.bridges)) {
      const distance = this.bridgeMonitor._haversine(
        vessel.lat,
        vessel.lon,
        bridge.lat,
        bridge.lon,
      );

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestBridge = { bridgeId, bridge, distance };
      }
    }

    if (!nearestBridge) {
      this.debug(
        `❌ [INIT_TARGET] No nearest bridge found for vessel ${vessel.mmsi}`,
      );
      return;
    }

    this.debug(
      `📍 [INIT_TARGET] Nearest bridge: ${
        nearestBridge.bridge.name
      } at ${nearestBridge.distance.toFixed(0)}m`,
    );

    // Only validation: Verify vessel is actually heading towards the bridge
    if (!this._isVesselHeadingTowardsBridge(vessel, nearestBridge.bridge)) {
      this.debug(
        `⏭️ [INIT_TARGET] Skippar målbro för ${vessel.mmsi} - inte på väg mot bron`,
      );
      return;
    }

    // Use BridgeMonitor's existing logic to find target bridge
    const targetBridgeName = this.bridgeMonitor._findTargetBridge(
      vessel,
      nearestBridge.bridgeId,
    );

    if (targetBridgeName) {
      vessel.targetBridge = targetBridgeName;
      this.debug(
        `🎯 [INIT_TARGET] Set target bridge for ${vessel.mmsi}: ${targetBridgeName}`,
      );
    } else {
      this.debug(
        `❌ [INIT_TARGET] No target bridge found for ${vessel.mmsi} from ${nearestBridge.bridge.name}`,
      );
    }
  }

  /**
   * Update bridge text for vessel - builds strings with specific format
   */
  _updateBridgeText(vessel) {
    this.debug(
      `📝 [UPDATE_TEXT] Updating bridge text for vessel ${vessel.mmsi}`,
    );
    this.debug('📝 [UPDATE_TEXT] Vessel state:', {
      nearBridge: vessel.nearBridge,
      targetBridge: vessel.targetBridge,
      etaMinutes: vessel.etaMinutes,
      name: vessel.name,
    });

    if (!vessel.targetBridge) {
      this.debug(
        `❌ [UPDATE_TEXT] No target bridge for ${vessel.mmsi} - skipping text update`,
      );
      return;
    }

    // Get bridge pretty names
    const nearBridgePretty = vessel.nearBridge
      ? this.bridges[vessel.nearBridge]?.name
      : null;
    // Använd detekterad målbro om den finns, annars befintlig
    const targetBridgePretty = vessel._detectedTargetBridge || vessel.targetBridge;

    let bridgeText;
    let etaText;

    // Format ETA - calculate if missing
    let finalEtaMinutes = vessel.etaMinutes;

    // If ETA is null/undefined/NaN, try to calculate it
    if (finalEtaMinutes == null || Number.isNaN(finalEtaMinutes)) {
      this.debug(`⚠️ [UPDATE_TEXT] ETA missing för ${vessel.mmsi}, försöker beräkna...`);

      if (vessel.targetBridge && vessel.nearBridge) {
        const targetBridgeId = this._findBridgeIdByName(vessel.targetBridge);
        if (targetBridgeId && this.bridges[targetBridgeId]) {
          const targetBridge = this.bridges[targetBridgeId];
          const distance = this.bridgeMonitor._calculateDistance(
            vessel.lat,
            vessel.lon,
            targetBridge.lat,
            targetBridge.lon,
          );

          const eta = this.etaCalculator.calculateETA(
            vessel,
            distance,
            vessel.nearBridge,
            targetBridgeId,
          );

          finalEtaMinutes = eta.minutes;
          vessel.etaMinutes = finalEtaMinutes; // Update vessel ETA
          this.debug(`✅ [UPDATE_TEXT] Beräknad ETA för ${vessel.mmsi}: ${finalEtaMinutes.toFixed(1)}min`);
        }
      }
    }

    if (
      finalEtaMinutes !== null
      && finalEtaMinutes !== undefined
      && !Number.isNaN(finalEtaMinutes)
    ) {
      if (finalEtaMinutes < 1) {
        etaText = 'nu';
      } else if (finalEtaMinutes === 1) {
        etaText = '1 minut';
      } else {
        etaText = `${Math.round(finalEtaMinutes)} minuter`;
      }
    } else {
      etaText = 'okänd tid';
    }

    // Build text based on nearBridge == targetBridge condition
    if (vessel.nearBridge && nearBridgePretty === targetBridgePretty) {
      // If nearBridge == targetBridge → use text "närmar sig <targetBridge>"
      bridgeText = `🚢 ${vessel.name} närmar sig ${targetBridgePretty}, beräknad broöppning om ${etaText}`;
    } else if (nearBridgePretty) {
      // Normal case with nearBridge and targetBridge
      bridgeText = `🚢 ${vessel.name} vid ${nearBridgePretty} är på väg mot ${targetBridgePretty}, beräknad broöppning om ${etaText}`;
    } else {
      // Fallback case
      bridgeText = `🚢 ${vessel.name} är på väg mot ${targetBridgePretty}, beräknad broöppning om ${etaText}`;
    }

    this.debug(`📝 [UPDATE_TEXT] Generated text: "${bridgeText}"`);

    // Store generated text on vessel for UI system to use
    vessel.generatedBridgeText = bridgeText;

    this.debug(
      `✅ [UPDATE_TEXT] Bridge text generated for vessel ${vessel.mmsi}`,
    );
  }

  /**
   * Predict next bridge and set new targetBridge after bridge passage
   */
  async _predictNextBridge(vessel, passedBridgeId) {
    this.debug(
      `🔮 [PREDICT_NEXT] Predicting next bridge for vessel ${vessel.mmsi} after passing ${passedBridgeId}`,
    );

    // Use BridgeMonitor's existing logic to find next target bridge
    const nextTargetBridge = this.bridgeMonitor._findTargetBridge(
      vessel,
      passedBridgeId,
    );

    if (nextTargetBridge) {
      vessel.targetBridge = nextTargetBridge;
      this.debug(
        `🎯 [PREDICT_NEXT] Set new target bridge for ${vessel.mmsi}: ${nextTargetBridge}`,
      );
    } else {
      vessel.targetBridge = null;

      // Set status based on vessel speed when no target bridge remains
      if (vessel.sog > 0.5) {
        this._syncStatusAndFlags(vessel, 'en-route');
      } else {
        this._syncStatusAndFlags(vessel, 'idle');
      }

      this.debug(
        `❌ [PREDICT_NEXT] No next target bridge found for ${vessel.mmsi}, status set to ${vessel.status}`,
      );
      // Clear bridge text when vessel has passed the last user bridge
      await this._clearBridgeText(vessel.mmsi);
    }
  }

  /**
   * Clear bridge text when no relevant boats remain
   */
  async _clearBridgeText(mmsi = null) {
    const txt = 'Inga båtar i närheten av Klaffbron eller Stridsbergsbron';
    await this._updateDeviceCapabilities(txt, false); // false = stäng av alarm
    this.log(`🧹 [CLEAR_TEXT] Rensar UI-text${mmsi ? ` (MMSI ${mmsi})` : ''}`);
  }

  /**
   * Update device capabilities with bridge text and alarm
   */
  async _updateDeviceCapabilities(bridgeText, hasAlarm) {
    // Update all devices
    for (const device of this._devices) {
      if (!device) continue;

      // Update bridge_text capability (defensiv check)
      if (device.hasCapability && device.hasCapability('bridge_text')) {
        try {
          const currentText = await device.getCapabilityValue('bridge_text');
          if (bridgeText !== currentText) {
            await device.setCapabilityValue('bridge_text', bridgeText);
            this.debug('✅ [DEVICE_UPDATE] Device bridge_text updated');
          }
        } catch (err) {
          this.error('❌ [DEVICE_UPDATE] Failed to update bridge_text:', err);
        }
      } else {
        this.debug('⚠️ [DEVICE_UPDATE] Device missing bridge_text capability');
      }

      // Update alarm_generic capability (defensiv check)
      if (device.hasCapability && device.hasCapability('alarm_generic')) {
        try {
          const currentAlarm = await device.getCapabilityValue('alarm_generic');
          if (hasAlarm !== currentAlarm) {
            await device.setCapabilityValue('alarm_generic', hasAlarm);
            this.debug(
              `🔕 [DEVICE_UPDATE] Device alarm updated: ${
                hasAlarm ? 'PÅ' : 'AV'
              }`,
            );
          }
        } catch (err) {
          this.error('❌ [DEVICE_UPDATE] Failed to update alarm:', err);
        }
      } else {
        this.debug(
          '⚠️ [DEVICE_UPDATE] Device missing alarm_generic capability',
        );
      }
    }
  }

  // Logging helpers
  log(...args) {
    if (this.debugLevel !== 'off') {
      super.log(...args);
    }
  }

  debug(...args) {
    if (this.debugLevel === 'detailed' || this.debugLevel === 'full') {
      super.log('[DEBUG]', ...args);
    }
  }

  error(...args) {
    super.error(...args);
  }

  async onUninit() {
    // Clean up intervals
    if (this._healthInterval) clearInterval(this._healthInterval);
    if (this._memoryInterval) clearInterval(this._memoryInterval);

    // Disconnect module events first
    this._disconnectModuleEvents();

    // Avregistrera alla interna listeners för att förhindra minnesläckage
    if (this.vesselManager) {
      if (this._onVesselUpdated) {
        this.vesselManager.off('vessel:updated', this._onVesselUpdated);
      }
      if (this._onVesselRemoved) {
        this.vesselManager.off('vessel:removed', this._onVesselRemoved);
      }
      if (this._onVesselEntered) {
        this.vesselManager.off('vessel:entered', this._onVesselEntered);
      }
    }

    if (this.bridgeMonitor) {
      if (this._onBridgeApproaching) {
        this.bridgeMonitor.off('bridge:approaching', this._onBridgeApproaching);
      }
      if (this._onBridgePassed) {
        this.bridgeMonitor.off('bridge:passed', this._onBridgePassed);
      }
      if (this._onVesselIrrelevant) {
        this.bridgeMonitor.off('vessel:irrelevant', this._onVesselIrrelevant);
      }
      if (this._onVesselNeedsTarget) {
        this.bridgeMonitor.off('vessel:needs-target', this._onVesselNeedsTarget);
      }
    }

    // Avregistrera AIS connection listeners
    if (this.aisConnection) {
      if (this._onVesselPosition) {
        this.aisConnection.off('vessel:position', this._onVesselPosition);
      }
      if (this._onConnected) {
        this.aisConnection.off('connected', this._onConnected);
      }
      if (this._onDisconnected) {
        this.aisConnection.off('disconnected', this._onDisconnected);
      }
      if (this._onError) this.aisConnection.off('error', this._onError);
    }

    // Remove settings listener to prevent memory leaks
    if (this._onSettingsChanged) {
      this.homey.settings.off('set', this._onSettingsChanged);
    }

    // Destroy modules
    if (this.aisConnection) this.aisConnection.destroy();
    if (this.bridgeMonitor) this.bridgeMonitor.destroy();
    if (this.vesselManager) this.vesselManager.destroy();

    this.log('AIS Bridge stopped');
  }

  // Public API
  api = {
    async getConnectionStatus() {
      return {
        connected: this.aisConnection?.isConnected || false,
        error: null,
        timestamp: new Date().toISOString(),
      };
    },

    async getSystemHealth() {
      let memoryInfo = null;
      try {
        memoryInfo = process.memoryUsage();
      } catch (err) {
        // Silently skip memory info in environments where it's not available (like Homey)
        memoryInfo = { error: 'Not available in this environment' };
      }

      return {
        vessels: this.vesselManager?.vessels.size || 0,
        bridges: this.vesselManager?.bridgeVessels.size || 0,
        connected: this.aisConnection?.isConnected || false,
        uptime: process.uptime(),
        memory: memoryInfo,
      };
    },
  };
}

module.exports = AISBridgeApp;

// Exportera klasser för testning
module.exports.VesselStateManager = VesselStateManager;
module.exports.BridgeMonitor = BridgeMonitor;
module.exports.AISConnectionManager = AISConnectionManager;
module.exports.MessageGenerator = MessageGenerator;
module.exports.ETACalculator = ETACalculator;

// Exportera konstanter för testning
module.exports.CONSTANTS = {
  GRACE_MISSES,
  APPROACH_RADIUS,
};
