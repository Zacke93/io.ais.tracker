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
  constructor(logger) {
    super();
    this.logger = logger;
    this.vessels = new Map(); // Map<mmsi, VesselData>
    this.bridgeVessels = new Map(); // Map<bridgeId, Set<mmsi>>
    this.cleanupTimers = new Map(); // Map<mmsi, timeoutId>
  }

  updateVessel(mmsi, data) {
    const oldData = this.vessels.get(mmsi);
    const isNewVessel = !oldData;

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
    };

    // Nollställ graceMisses om fartyget är relevant igen
    if (data.towards || data.sog > 0.5) {
      vesselData.graceMisses = 0;
    }

    // Återställ speedBelowThresholdSince om hastigheten ökar över WAITING_SPEED_THRESHOLD
    if (data.sog > WAITING_SPEED_THRESHOLD && oldData?.speedBelowThresholdSince) {
      vesselData.speedBelowThresholdSince = null;
      this.logger.debug(
        `🏃 [WAITING_LOGIC] Fartyg ${mmsi} hastighet ökade över ${WAITING_SPEED_THRESHOLD} kn (${data.sog.toFixed(2)} kn), återställer waiting timer`,
      );
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

    this.logger.debug(
      `🗑️ [VESSEL_REMOVAL] Fartyg ${mmsi} (${vessel.name}) tas bort från systemet`,
    );

    // CRITICAL: Cancel cleanup timer first to prevent memory leak
    this._cancelCleanup(mmsi);

    // Rensa passedBridges innan borttagning
    if (vessel.passedBridges && vessel.passedBridges.length > 0) {
      this.logger.debug(
        `🌉 [VESSEL_REMOVAL] Rensar ${vessel.passedBridges.length} passerade broar för ${mmsi}`,
      );
      vessel.passedBridges = [];
    }

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
      this.cleanupTimers.delete(mmsi);
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
      // Vessel is still valid, remove timer reference
      this.cleanupTimers.delete(mmsi);
    }
  }

  _calculateTimeout(v) {
    const d = v._distanceToNearest ?? Infinity; // fallback
    
    // Hantera Infinity eller ogiltiga värden explicit
    if (d === Infinity || isNaN(d) || d < 0) {
      this.logger.debug(
        `⏱️ [TIMEOUT] Fartyg ${v.mmsi}: ogiltigt avstånd (${d}), använder default 2 min timeout`
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
    
    // Waiting-säkring enligt kravspec §4.1
    if (v.status === 'waiting') {
      base = Math.max(base, 20 * 60 * 1000); // Minst 20 min för waiting
    }

    this.logger.debug(
      `⏱️ [TIMEOUT] Fartyg ${v.mmsi}: avstånd=${d.toFixed(0)}m, status=${v.status}, timeout=${base / 60000}min`,
    );

    return base;
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

    // Schedule removal after 3 minutes
    const timerId = setTimeout(() => {
      const v = this.vessels.get(mmsi);
      if (v && v.status === 'passed' && !v.targetBridge) {
        this.logger.debug(
          `🗑️ [COMPLETION_REMOVAL] Tar bort fartyg ${mmsi} - rutt slutförd för 3 minuter sedan`,
        );
        this.removeVessel(mmsi);
      }
    }, 3 * 60 * 1000);

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

    // Validate existing targetBridge is still relevant
    if (vessel.targetBridge) {
      if (!this._validateTargetBridge(vessel)) {
        vessel.targetBridge = null;
        vessel.status = 'en-route';
        this.logger.debug(
          `🧹 [VESSEL_UPDATE] Cleared irrelevant targetBridge for ${vessel.mmsi}`,
        );
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

      // Retarget-säkring: Om båten saknar targetBridge men nu är < 1000m från en bro, initiera igen
      if (!vessel.targetBridge && distance < 1000) {
        this.logger.debug(
          `🎯 [VESSEL_UPDATE] Fartyg ${vessel.mmsi} saknar targetBridge men är nu < 1000m från ${bridge.name} - initierar målbro`,
        );
        // Emit event för TextFlowManager att hantera
        this.emit('vessel:needs-target', { vessel });
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

      // Set vessel.nearBridge if distance ≤ APPROACH_RADIUS
      if (distance <= APPROACH_RADIUS) {
        vessel.nearBridge = bridgeId;
        this.logger.debug(
          `🌉 [VESSEL_UPDATE] Fartyg ${vessel.mmsi} inom APPROACH_RADIUS (${APPROACH_RADIUS}m) för ${bridgeId}`,
        );

        // Waiting detection logic enligt kravspec §1
        const WAIT_DIST = APPROACH_RADIUS; // 300 m
        const WAIT_TIME = 120 * 1000; // 2 min kontinuerlig låg hastighet

        if (distance <= WAIT_DIST && vessel.sog < WAITING_SPEED_THRESHOLD) {
          // Track kontinuerlig låg hastighet
          if (!vessel.speedBelowThresholdSince) {
            vessel.speedBelowThresholdSince = Date.now();
            this.logger.debug(
              `🐌 [WAITING_LOGIC] Fartyg ${vessel.mmsi} började gå långsamt vid ${bridgeId} (${vessel.sog.toFixed(2)}kn < ${WAITING_SPEED_THRESHOLD}kn)`,
            );
          }

          const slowDuration = Date.now() - vessel.speedBelowThresholdSince;

          if (slowDuration > WAIT_TIME) {
            // Sätt waiting status efter 2 min kontinuerlig låg hastighet
            if (vessel.status !== 'waiting') {
              vessel.status = 'waiting';
              vessel.isWaiting = true;
              vessel.waitSince = vessel.speedBelowThresholdSince; // För bakåtkompatibilitet
              this.logger.debug(
                `⏳ [WAITING_LOGIC] Fartyg ${vessel.mmsi} väntar vid ${bridgeId} efter ${Math.round(slowDuration / 1000)}s låg hastighet`,
              );
              // Emit status change for UI update
              this.emit('vessel:status-changed', { vessel, oldStatus: 'approaching', newStatus: 'waiting' });
            }
          } else {
            // Fortfarande i approaching medan vi väntar på 2 min
            if (vessel.status !== 'approaching' && vessel.status !== 'under-bridge') {
              vessel.status = 'approaching';
            }
            this.logger.debug(
              `⏱️ [WAITING_LOGIC] Fartyg ${vessel.mmsi} långsam i ${Math.round(slowDuration / 1000)}s av ${WAIT_TIME / 1000}s`,
            );
          }
        } else {
          // Hastighet över threshold eller utanför WAIT_DIST - återställ
          if (vessel.speedBelowThresholdSince) {
            this.logger.debug(
              `🏃 [WAITING_LOGIC] Fartyg ${vessel.mmsi} inte längre långsam (${vessel.sog.toFixed(2)}kn eller ${distance.toFixed(0)}m från ${bridgeId})`,
            );
          }
          vessel.speedBelowThresholdSince = null;
          vessel.waitSince = null;
          vessel.isWaiting = false;

          // Återställ status om den var waiting
          if (vessel.status === 'waiting') {
            vessel.status = 'approaching';
            this.emit('vessel:status-changed', { vessel, oldStatus: 'waiting', newStatus: 'approaching' });
          }
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
                vessel.status = 'under-bridge';
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
              vessel.status = 'approaching';
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
                  this.logger.debug(`[TARGET_SWITCH] Ny targetBridge → ${newTarget} för ${vessel.mmsi} (lämnat under-bridge zonen)`);
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
          analysis: { confidence: 'unknown' }, // placeholder för att förhindra TypeError
        });
        this.logger.debug(
          `🌉 [BRIDGE_EVENT] bridge:approaching utlöst för ${vessel.mmsi} vid ${bridgeId}`,
        );
      } else {
        vessel.nearBridge = null;
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
              vessel.targetBridge = newTarget;
              this.logger.debug(`[TARGET_SWITCH] Ny targetBridge → ${newTarget} för ${vessel.mmsi} (COG ändring > 45°)`);
              this.emit('vessel:target-changed', { vessel });
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

          const etaMinutes = Math.round(
            targetDistance / (vessel.sog * 0.514444) / 60,
          );
          vessel.etaMinutes = etaMinutes;

          this.logger.debug(
            `🧮 [ETA_CALC] ETA för ${vessel.mmsi} till ${
              vessel.targetBridge
            }: ${etaMinutes} minuter (målbro-avstånd: ${targetDistance.toFixed(
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

      // Check for bridge passage (distance rises above 50m after being inside APPROACH_RADIUS)
      if (
        vessel.targetBridge
        && oldData?.targetBridge === vessel.targetBridge
      ) {
        const targetBridgeId = this._findBridgeIdByNameInMonitor(
          vessel.targetBridge,
        );
        if (targetBridgeId) {
          const targetBridge = this.bridges[targetBridgeId];
          const targetDistance = this._haversine(
            vessel.lat,
            vessel.lon,
            targetBridge.lat,
            targetBridge.lon,
          );

          // Track when vessel gets very close to target bridge (< 50m)
          if (targetDistance < UNDER_BRIDGE_DISTANCE && !vessel._wasInsideTarget) {
            vessel._wasInsideTarget = true;
            vessel._closestDistanceToTarget = targetDistance;
            this.logger.debug(
              `🎯 [BRIDGE_PASSAGE] Fartyg ${vessel.mmsi} mycket nära ${vessel.targetBridge} (${targetDistance.toFixed(0)}m < 50m)`,
            );
          }

          // Update closest distance if vessel is getting closer
          if (vessel._wasInsideTarget && targetDistance < (vessel._closestDistanceToTarget || Infinity)) {
            vessel._closestDistanceToTarget = targetDistance;
          }

          // Store previous distance for trend detection
          if (vessel.targetBridge) {
            vessel._previousTargetDistance = vessel._lastTargetDistance;
            vessel._lastTargetDistance = targetDistance;
          }

          // Detect passage - require multiple conditions
          if (vessel._wasInsideTarget && targetDistance > UNDER_BRIDGE_DISTANCE) {
            // Calculate bearing and COG difference
            const bearingToBridge = this._calculateBearing(
              vessel.lat,
              vessel.lon,
              targetBridge.lat,
              targetBridge.lon,
            );
            const normalizedCogDiff = this._normalizeAngleDiff(vessel.cog, bearingToBridge);

            this.logger.debug(
              `🧭 [BRIDGE_PASSAGE] COG-analys för ${vessel.mmsi}: COG=${vessel.cog.toFixed(1)}°, bearing=${bearingToBridge.toFixed(1)}°, diff=${normalizedCogDiff.toFixed(1)}°`,
            );

            // More robust passage detection:
            // 1. Distance must be increasing (currently > 50m, was < 50m)
            // 2. COG must point away from bridge (> 90 degrees difference)
            // 3. Vessel must have reasonable speed (> 0.5 knots)
            // 4. Distance must be > 100m OR increasing consistently
            const isMovingAway = normalizedCogDiff > 90;
            const hasReasonableSpeed = vessel.sog > 0.5;
            const distanceIncreasing = vessel._previousTargetDistance
              && vessel._lastTargetDistance > vessel._previousTargetDistance;
            const hasMovedSignificantly = targetDistance > 100
              || (distanceIncreasing && targetDistance > vessel._closestDistanceToTarget + 20);

            this.logger.debug(
              `🔍 [BRIDGE_PASSAGE] Passage villkor för ${vessel.mmsi}: `
              + `movingAway=${isMovingAway}, speed=${hasReasonableSpeed} (${vessel.sog.toFixed(1)}kn), `
              + `significant=${hasMovedSignificantly} (dist=${targetDistance.toFixed(0)}m, closest=${vessel._closestDistanceToTarget?.toFixed(0)}m)`,
            );

            if (isMovingAway && hasReasonableSpeed && hasMovedSignificantly) {
              // Mark as passed
              this.logger.debug(
                `🌉 [BRIDGE_PASSAGE] Fartyg ${vessel.mmsi} har passerat `
                  + `${vessel.targetBridge} (avstånd: ${targetDistance.toFixed(
                    0,
                  )}m > 50m, COG visar bort från bron)`,
              );

              // Update vessel status to 'passed'
              vessel.status = 'passed';
              vessel._wasInsideTarget = false;
              delete vessel._outCounter; // Clean up old logic
              delete vessel._closestDistanceToTarget;
              delete vessel._lastTargetDistance;
              delete vessel._previousTargetDistance;

              // Add to passedBridges if not already there
              if (!vessel.passedBridges) {
                vessel.passedBridges = [];
              }
              if (!vessel.passedBridges.includes(targetBridgeId)) {
                vessel.passedBridges.push(targetBridgeId);
              }

              // Emit bridge:passed event
              this.emit('bridge:passed', {
                vessel,
                bridgeId: targetBridgeId,
                bridge: targetBridge,
                distance: targetDistance,
              });

              this.logger.debug(
                `🌉 [BRIDGE_EVENT] bridge:passed utlöst för ${vessel.mmsi} vid ${vessel.targetBridge} (status: ${vessel.status})`,
              );

              // Predict and set next target bridge immediately
              const nextTargetBridge = this._findTargetBridge(vessel, targetBridgeId);
              if (nextTargetBridge) {
                vessel.targetBridge = nextTargetBridge;
                // IMPORTANT: Reset status to en-route when vessel gets new target
                vessel.status = 'en-route';
                this.logger.debug(
                  `🎯 [BRIDGE_PASSAGE] Ny målbro för ${vessel.mmsi}: ${nextTargetBridge} (status: ${vessel.status})`,
                );
                // Force UI update
                this.emit('vessel:eta-changed', { vessel });
              } else {
                vessel.targetBridge = null;
                this.logger.debug(
                  `🏁 [BRIDGE_PASSAGE] Ingen mer målbro för ${vessel.mmsi} - rutt slutförd`,
                );
                // Schedule removal after grace period for vessels with no more target bridges
                this.vesselManager._scheduleRemovalAfterCompletion(vessel.mmsi);
              }
            } else {
              this.logger.debug(
                `⏸️ [BRIDGE_PASSAGE] Fartyg ${vessel.mmsi} är >50m från ${vessel.targetBridge} men rör sig fortfarande mot bron (COG diff: ${normalizedCogDiff.toFixed(0)}°)`,
              );
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
          vessel.status = 'idle'; // Set status to idle only if not actively waiting/approaching
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
  }

  /**
   * Find the nearest bridge to a vessel
   */
  _findNearestBridge(vessel) {
    // Kontrollera att vessel har giltiga koordinater
    if (!vessel || vessel.lat == null || vessel.lon == null
        || Number.isNaN(vessel.lat) || Number.isNaN(vessel.lon)) {
      this.logger.warn(`⚠️ [NEAREST_BRIDGE] Ogiltiga koordinater för fartyg: lat=${vessel?.lat}, lon=${vessel?.lon}`);
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

    const isRelevant = (isApproaching || (inProtectionZone && isOnIncomingSide))
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

    // If vessel is very far and not moving, clear target
    if (distance > 800 && vessel.sog < 0.3) {
      this.logger.debug(
        `🎯 [TARGET_VALIDATION] Clearing target for ${vessel.mmsi} - too far (${distance.toFixed(0)}m) and too slow (${vessel.sog.toFixed(1)}kn)`,
      );
      return false;
    }

    // If vessel is far and heading away, clear target
    if (distance > 400 && this._isVesselHeadingAway(vessel, targetBridge)) {
      this.logger.debug(
        `🎯 [TARGET_VALIDATION] Clearing target for ${vessel.mmsi} - heading away from bridge`,
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

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
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

    // Find the boat with shortest ETA
    const closest = boats.reduce((min, boat) => {
      const isCloser = !min || boat.etaMinutes < min.etaMinutes;
      this.logger.debug(
        `🔍 [BRIDGE_TEXT] Jämför båt ${
          boat.mmsi
        } (ETA: ${boat.etaMinutes?.toFixed(1)}min) med nuvarande närmaste ${
          min?.mmsi || 'ingen'
        } (ETA: ${min?.etaMinutes?.toFixed(1) || 'N/A'}min) -> ${
          isCloser ? 'närmare' : 'längre bort'
        }`,
      );
      return isCloser ? boat : min;
    });

    if (!closest) {
      this.logger.debug(
        `❌ [BRIDGE_TEXT] Kunde inte hitta närmaste båt för ${bridgeName}`,
      );
      return null;
    }

    const count = boats.length;
    const eta = this._formatETA(closest.etaMinutes);
    const waiting = boats.filter(
      (b) => b.status === 'waiting' || b.isWaiting,
    ).length;

    this.logger.debug(`📈 [BRIDGE_TEXT] Fras-stats för ${bridgeName}:`, {
      totalBoats: count,
      waitingBoats: waiting,
      closestBoat: {
        mmsi: closest.mmsi,
        etaMinutes: typeof closest.etaMinutes === 'number' ? closest.etaMinutes.toFixed(1) : closest.etaMinutes,
        isWaiting: closest.isWaiting,
        confidence: closest.confidence,
        currentBridge: closest.currentBridge,
      },
      formattedETA: eta,
    });

    let phrase;

    // Mellanbro-fras (ledande båt)
    if (
      closest.currentBridge
      && closest.currentBridge !== bridgeName
      && closest.distanceToCurrent <= 300
    ) {
      const suffix = eta ? `, beräknad broöppning ${eta}` : '';
      phrase = `En båt vid ${closest.currentBridge} närmar sig ${bridgeName}${suffix}`;
      this.logger.debug(
        `🌉 [BRIDGE_TEXT] Mellanbro-fras: ${closest.mmsi} vid ${closest.currentBridge} mot ${bridgeName}`,
      );
      return phrase;
    }

    if (count === 1) {
      // Enhanced logic with new status types
      if (closest.status === 'waiting' || closest.isWaiting) {
        phrase = `En båt väntar vid ${closest.currentBridge || bridgeName}`;
        this.logger.debug(
          `💤 [BRIDGE_TEXT] Väntscenario: ${closest.mmsi} vid ${
            closest.currentBridge || bridgeName
          }`,
        );
      } else if (closest.status === 'under-bridge' || closest.etaMinutes === 0) {
        phrase = `Öppning pågår vid ${bridgeName}`;
        this.logger.debug(
          `🌉 [BRIDGE_TEXT] Under-bridge scenario: ${closest.mmsi} vid ${bridgeName} (status: ${closest.status}, ETA: ${closest.etaMinutes})`,
        );
      } else if (
        closest.confidence === 'high'
        || closest.status === 'approaching'
      ) {
        phrase = `En båt närmar sig ${bridgeName}, beräknad broöppning ${eta}`;
        this.logger.debug(
          `🎯 [BRIDGE_TEXT] Närmande scenario: ${closest.mmsi} -> ${bridgeName}`,
        );
      } else {
        phrase = `En båt på väg mot ${bridgeName}, beräknad broöppning ${eta}`;
        this.logger.debug(
          `📍 [BRIDGE_TEXT] En-route scenario: ${closest.mmsi} vid ${closest.currentBridge} mot ${bridgeName}`,
        );
      }
    } else if (waiting > 0) {
      // Handle scenarios with waiting boats
      const additionalCount = count - waiting; // subtract waiting boats to avoid double-counting
      if (additionalCount === 0) {
        // All boats are waiting
        const waitingText = waiting === 1 ? '1 båt' : `${waiting} båtar`;
        phrase = `${waitingText} väntar vid ${bridgeName}`;
      } else {
        // Mix of waiting and approaching boats
        const additionalText = additionalCount === 1
          ? 'ytterligare 1 båt'
          : `ytterligare ${additionalCount} båtar`;
        const waitingText = waiting === 1 ? '1 båt' : `${waiting} båtar`;
        phrase = `${waitingText} väntar vid ${bridgeName}, ${additionalText} på väg, beräknad broöppning ${eta}`;
      }
      this.logger.debug(
        `👥💤 [BRIDGE_TEXT] Plural med väntande: ${count} totalt, ${waiting} väntar`,
      );
    } else {
      // Use "En båt..." format with "ytterligare N båtar på väg"
      const additionalCount = count - 1;
      if (additionalCount === 0) {
        phrase = `En båt närmar sig ${bridgeName}, beräknad broöppning ${eta}`;
      } else {
        const additionalText = additionalCount === 1
          ? 'ytterligare 1 båt'
          : `ytterligare ${additionalCount} båtar`;
        phrase = `En båt närmar sig ${bridgeName}, ${additionalText} på väg, beräknad broöppning ${eta}`;
      }
      this.logger.debug(
        `👥🚢 [BRIDGE_TEXT] Plural närmar sig: ${count} båtar mot ${bridgeName}`,
      );
    }

    this.logger.debug(
      `✅ [BRIDGE_TEXT] Fras genererad för ${bridgeName}: "${phrase}"`,
    );

    return phrase;
  }

  _formatETA(minutes) {
    if (minutes < 1) return 'nu';
    if (minutes === 1) return 'om 1 minut';
    return `om ${Math.round(minutes)} minuter`;
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
    if (speedMs < 0.05) {
      this.logger.debug(
        `⛔ [ETA_CALC] För låg hastighet (${speedMs.toFixed(
          4,
        )}m/s) - returnerar maximal ETA`,
      );
      // Return large but reasonable ETA instead of Infinity
      return { minutes: 999, isWaiting: false };
    }

    const eta = actualDistance / speedMs / 60;

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
    this.homey.settings.on('set', (key, value) => {
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
    });

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
    this.vesselManager = new VesselStateManager(this);
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
        continue;
      }

      // Skip very slow vessels that are far away
      if (vessel.sog < 0.2 && (!vessel.nearBridge || vessel._distanceToNearest > 600)) {
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

      // Filter out vessels that are too far and moving too slowly
      // If vessel is > 1000m away and moving < 1 knot, it's not relevant
      if (distanceToTarget > 1000 && vessel.sog < 1.0) {
        this.debug(
          `⏭️ [RELEVANT_BOATS] Hoppar över fartyg ${vessel.mmsi} - för långt borta (${distanceToTarget.toFixed(0)}m) och för långsam (${vessel.sog.toFixed(1)}kn)`,
        );
        continue;
      }

      // If vessel is > 600m away and not moving, it's not relevant
      if (distanceToTarget > 600 && vessel.sog < 0.2) {
        this.debug(
          `⏭️ [RELEVANT_BOATS] Hoppar över fartyg ${vessel.mmsi} - för långt borta (${distanceToTarget.toFixed(0)}m) och står still (${vessel.sog.toFixed(1)}kn)`,
        );
        continue;
      }

      // If vessel is > 300m away and moving slowly, verify it's heading towards bridge
      if (distanceToTarget > 300 && vessel.sog < 1.0) {
        if (!this._isVesselHeadingTowardsBridge(vessel, targetBridge)) {
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

      // Use vessel.nearBridge as currentBridge if available, otherwise fallback
      let currentBridgeName = null; // no nearby bridge – let MessageGenerator handle fallback
      const distanceToCurrent = vessel.nearBridge
        ? this.bridgeMonitor._haversine(
          vessel.lat, vessel.lon,
          this.bridges[vessel.nearBridge].lat,
          this.bridges[vessel.nearBridge].lon,
        )
        : Infinity;

      if (vessel.nearBridge && this.bridges[vessel.nearBridge]) {
        currentBridgeName = this.bridges[vessel.nearBridge].name;
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

      const relevantBoat = {
        mmsi: vessel.mmsi,
        currentBridge: currentBridgeName,
        targetBridge: vessel.targetBridge,
        etaMinutes: vessel.etaMinutes || eta.minutes, // Use vessel's ETA if available
        isWaiting: vessel.status === 'waiting' || eta.isWaiting,
        confidence: vessel.status === 'approaching' ? 'high' : 'medium',
        distance: distanceToTarget,
        distanceToCurrent,
        status: vessel.status, // Include new status field
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

    // Memory-hälsa – kan slå fel i vissa container-miljöer
    this._memoryInterval = setInterval(() => {
      try {
        const mem = process.memoryUsage();
        this.debug('[MEM]', (mem.rss / 1024 / 1024).toFixed(1), 'MB RSS');
      } catch (err) {
        this.debug('[MEM] process.memoryUsage() not available:', err.message);
        clearInterval(this._memoryInterval); // sluta försöka
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
      (args, state) => args.bridge === state.bridge || args.bridge === 'any',
    );

    // Bridge passed trigger removed - was unused

    // Boat recent condition
    this._boatRecentCard = this.homey.flow.getConditionCard('boat_recent');
    this._boatRecentCard.registerRunListener((args) => {
      const cutoff = Date.now() - 10 * 60 * 1000;

      if (args.bridge === 'any') {
        return this.vesselManager.vessels.size > 0;
      }

      const vessels = this.vesselManager.getVesselsByBridge(args.bridge);
      return vessels.some((v) => v.timestamp > cutoff);
    });
  }

  /**
   * Utlöser Flow-kortet "Båt nära".
   * Om riktningen saknas får Homey alltid en sträng, aldrig undefined.
   */
  _triggerBoatNearFlow(bridgeId, bridgeName, vesselName, direction = null) {
    const dirString = direction && typeof direction === 'string' ? direction : 'okänd'; // ← fallback som uppfyller Homeys krav

    const tokens = {
      bridge_name: bridgeName,
      vessel_name: vesselName,
      direction: dirString,
    };

    // Skicka för både specifik bro och wildcard "any"
    this._boatNearTrigger
      .trigger(tokens, { bridge: bridgeId })
      .catch((err) => {
        this.error(`Failed to trigger boat_near for bridge ${bridgeId}:`, err);
      });
    this._boatNearTrigger
      .trigger(tokens, { bridge: 'any' })
      .catch((err) => {
        this.error('Failed to trigger boat_near for any bridge:', err);
      });
  }

  /**
   * Utlöser Flow-kortet "Bro passerad" för bridge:passed händelser.
   */
  // _triggerBridgePassedFlow method removed - unused flow card

  /**
   * Flow condition method for testing boat recent activity
   * Used by tests to simulate Flow card condition checks
   */
  async _onFlowConditionBoatRecent(args) {
    const cutoff = Date.now() - 10 * 60 * 1000;

    if (args.bridge === 'any') {
      // Check if any bridge has recent activity
      if (this.vesselManager && this.vesselManager.vessels.size > 0) {
        return true;
      }
      // Fallback to _lastSeen for test compatibility
      if (this._lastSeen) {
        for (const bridgeData of Object.values(this._lastSeen)) {
          if (bridgeData && typeof bridgeData === 'object') {
            for (const vesselData of Object.values(bridgeData)) {
              if (vesselData && vesselData.ts && vesselData.ts > cutoff) {
                return true;
              }
            }
          }
        }
      }
      return false;
    }

    // Check specific bridge
    if (this.vesselManager) {
      const vessels = this.vesselManager.getVesselsByBridge(args.bridge);
      if (vessels.some((v) => v.timestamp > cutoff)) {
        return true;
      }
    }

    // Fallback to _lastSeen for test compatibility
    if (this._lastSeen && this._lastSeen[args.bridge]) {
      const bridgeData = this._lastSeen[args.bridge];
      for (const vesselData of Object.values(bridgeData)) {
        if (vesselData && vesselData.ts && vesselData.ts > cutoff) {
          return true;
        }
      }
    }

    return false;
  }

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
      vessel, bridgeId, bridge, distance,
    }) => {
      this.debug(
        `🌉 [TEXT_FLOW] bridge:approaching - ${vessel.mmsi} at ${bridge.name}`,
      );
      vessel.nearBridge = bridgeId;
      this._updateBridgeText(vessel);
    };

    this._onBridgePassed = ({ vessel, bridgeId, bridge }) => {
      this.debug(
        `🌉 [TEXT_FLOW] bridge:passed - ${vessel.mmsi} passed ${bridge.name}`,
      );

      // a) Predict next bridge and set new targetBridge
      this._predictNextBridge(vessel, bridgeId);

      // b) Reset vessel.nearBridge
      vessel.nearBridge = null;

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
    this.bridgeMonitor.on('vessel:needs-target', ({ vessel }) => {
      this._initialiseTargetBridge(vessel);
    });

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
    const targetBridgePretty = vessel.targetBridge;

    let bridgeText;
    let etaText;

    // Format ETA
    if (
      vessel.etaMinutes !== null
      && vessel.etaMinutes !== undefined
      && !Number.isNaN(vessel.etaMinutes)
    ) {
      if (vessel.etaMinutes < 1) {
        etaText = 'nu';
      } else if (vessel.etaMinutes === 1) {
        etaText = '1 minut';
      } else {
        etaText = `${Math.round(vessel.etaMinutes)} minuter`;
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
        vessel.status = 'en-route';
      } else {
        vessel.status = 'idle';
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
      return {
        vessels: this.vesselManager?.vessels.size || 0,
        bridges: this.vesselManager?.bridgeVessels.size || 0,
        connected: this.aisConnection?.isConnected || false,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
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
