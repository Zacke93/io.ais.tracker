'use strict';

/**
 * GPSJumpGateService - Förhindrar felaktiga passage-detektion under GPS-hopp
 *
 * SYFTE: Löser problemet där GPS-hopp orsakar:
 * - Felaktig broordning (passage detekteras i fel ordning)
 * - "Tidsresor" där båtar återvänder till tidigare statusar
 * - Passage-detektion som är fysiskt omöjlig
 *
 * FUNKTIONALITET:
 * - Blockerar passage-detection under aktiv GPS-koordination
 * - Tvåstegsbekräftelse: candidate → confirm efter stabilitet
 * - Timeout-protection för att förhindra permanent gating
 */

class GPSJumpGateService {
  constructor(logger, systemCoordinator) {
    this.logger = logger;
    this.systemCoordinator = systemCoordinator;

    // Map: vesselId -> gateData
    this._gatedVessels = new Map();

    // Map: vesselId -> candidatePassages[]
    this._candidatePassages = new Map();

    // Gating timeout (förhindrar permanent låsning)
    this._gateTimeout = 30 * 1000; // 30 sekunder

    // Confirmation period för tvåstegsbekräftelse
    this._confirmationPeriod = 5 * 1000; // 5 sekunder stabilitet krävs

    // Cleanup timer (disabled in test mode to avoid lingering intervals)
    if (process.env.NODE_ENV === 'test' || global.__TEST_MODE__) {
      this._cleanupTimer = null;
      this.logger.debug('🧪 [GPS_GATE] Test mode detected - skipping cleanup timer');
    } else {
      this._cleanupTimer = setInterval(() => {
        this._cleanupExpiredGates();
      }, 10 * 1000); // Var 10:e sekund
    }

    this.logger.debug('🛡️ [GPS_GATE] Service initialized');
  }

  /**
   * Kontrollera om passage-detection ska blockeras för vessel
   * @param {string} vesselId - Vessel MMSI
   * @param {object} vessel - Vessel data
   * @param {string} bridgeName - Bridge name
   * @returns {boolean} - true om passage ska blockeras
   */
  shouldBlockPassageDetection(vesselId, vessel, bridgeName) {
    // Kontrollera om vessel är under aktiv GPS-koordination
    const hasActiveCoordination = this._hasActiveGPSCoordination(vessel);

    if (hasActiveCoordination) {
      this.logger.debug(`🛡️ [GPS_GATE] ${vesselId}: Blocking passage detection for ${bridgeName} - active GPS coordination`);
      return true;
    }

    // Kontrollera om vessel har aktiv gate
    const gateData = this._gatedVessels.get(vesselId);
    if (gateData) {
      const age = Date.now() - gateData.timestamp;
      if (age < this._gateTimeout) {
        this.logger.debug(`🛡️ [GPS_GATE] ${vesselId}: Blocking passage detection for ${bridgeName} - gated for ${Math.round(age / 1000)}s`);
        return true;
      }
      // Gate expired
      this._gatedVessels.delete(vesselId);
      this.logger.debug(`🔓 [GPS_GATE] ${vesselId}: Gate expired after ${Math.round(age / 1000)}s`);

    }

    return false;
  }

  /**
   * Registrera candidate passage för tvåstegsbekräftelse
   * @param {string} vesselId - Vessel MMSI
   * @param {string} bridgeName - Bridge name
   * @param {object} passageResult - Passage result från detectBridgePassage
   * @param {object} vessel - Vessel data
   */
  registerCandidatePassage(vesselId, bridgeName, passageResult, vessel) {
    if (!this._candidatePassages.has(vesselId)) {
      this._candidatePassages.set(vesselId, []);
    }

    const candidates = this._candidatePassages.get(vesselId);
    const candidateData = {
      bridgeName,
      passageResult,
      timestamp: Date.now(),
      vesselState: {
        lat: vessel.lat,
        lon: vessel.lon,
        cog: vessel.cog,
        // Helkodsgranskning 2026-07-01 (S-F1): fältet heter sog — vessel.speed
        // existerar inte. Den gamla skrivningen gav undefined → NaN i
        // _isVesselStable → isStable alltid false → tvåstegsbekräftelsen
        // kunde ALDRIG lyckas och gate:ade passager övergavs tyst.
        sog: vessel.sog,
      },
    };

    candidates.push(candidateData);

    // Begränsa antal candidates per vessel
    if (candidates.length > 5) {
      candidates.shift(); // Ta bort äldsta
    }

    this.logger.debug(`📋 [GPS_GATE] ${vesselId}: Registered candidate passage for ${bridgeName} (${candidates.length} total)`);
  }

  /**
   * Kontrollera och bekräfta candidate passages som är stabila
   * @param {string} vesselId - Vessel MMSI
   * @param {object} vessel - Current vessel data
   * @returns {Array} - Array av bekräftade passages
   */
  confirmStableCandidates(vesselId, vessel) {
    const candidates = this._candidatePassages.get(vesselId);
    if (!candidates || candidates.length === 0) {
      return [];
    }

    const now = Date.now();
    const confirmedPassages = [];
    const remainingCandidates = [];

    for (const candidate of candidates) {
      const age = now - candidate.timestamp;

      // Bekräfta om candidate är gammal nog OCH vessel är stabil
      if (age >= this._confirmationPeriod) {
        const isStable = this._isVesselStable(candidate.vesselState, vessel);

        if (isStable) {
          confirmedPassages.push({
            bridgeName: candidate.bridgeName,
            passageResult: candidate.passageResult,
            confirmedAt: now,
          });

          this.logger.debug(`✅ [GPS_GATE] ${vesselId}: Confirmed passage of ${candidate.bridgeName} after ${Math.round(age / 1000)}s stability`);
        } else if (age < this._gateTimeout) {
          // F11: gammal nog men just nu instabil → DROPPA INTE tyst. En äkta
          // passage kan annars tappas om GPS råkar vara brusig precis vid
          // 5s-kontrollen → fryst fel bro + missad notis. Behåll kandidaten så
          // en senare stabil tick kan bekräfta den, med _gateTimeout (30s) som
          // övre gräns (matchar _cleanupExpiredGates-backstoppet).
          remainingCandidates.push(candidate);
          this.logger.debug(`⏳ [GPS_GATE] ${vesselId}: Candidate for ${candidate.bridgeName} unstable at ${Math.round(age / 1000)}s — retrying (keep until ${Math.round(this._gateTimeout / 1000)}s)`);
        } else {
          // Övre gräns nådd — ge upp (logga)
          this.logger.debug(`❌ [GPS_GATE] ${vesselId}: Abandoning candidate for ${candidate.bridgeName} after ${Math.round(age / 1000)}s (max age reached)`);
        }
      } else {
        // Candidate inte gammal nog ännu, behåll
        remainingCandidates.push(candidate);
      }
    }

    // Uppdatera candidate-listan
    if (remainingCandidates.length > 0) {
      this._candidatePassages.set(vesselId, remainingCandidates);
    } else {
      this._candidatePassages.delete(vesselId);
    }

    return confirmedPassages;
  }

  /**
   * Aktivera GPS gate för vessel (blockerar passage-detection)
   * @param {string} vesselId - Vessel MMSI
   * @param {number} jumpDistance - GPS jump distance in meters
   * @param {string} reason - Anledning för gating
   */
  activateGate(vesselId, jumpDistance, reason = 'gps_jump') {
    const gateData = {
      timestamp: Date.now(),
      jumpDistance,
      reason,
    };

    this._gatedVessels.set(vesselId, gateData);

    this.logger.debug(`🛡️ [GPS_GATE] ${vesselId}: Activated gate due to ${reason} (${jumpDistance}m jump)`);
  }

  /**
   * Rensa gate för vessel (återaktivera passage-detection)
   * @param {string} vesselId - Vessel MMSI
   */
  clearGate(vesselId) {
    if (this._gatedVessels.has(vesselId)) {
      this._gatedVessels.delete(vesselId);
      this.logger.debug(`🔓 [GPS_GATE] ${vesselId}: Gate cleared manually`);
    }
  }

  /**
   * B6-fix (2026-06-09): rensa ALLT tillstånd för en vessel (gate + kandidater).
   * Anropas vid vessel-removal så stale kandidater inte kan bekräftas om samma
   * mmsi återkommer innan den tidsbaserade självstädningen hunnit köra.
   * @param {string} vesselId - Vessel MMSI
   */
  clearVessel(vesselId) {
    this.clearGate(vesselId);
    if (this._candidatePassages.has(vesselId)) {
      this._candidatePassages.delete(vesselId);
      this.logger.debug(`🧹 [GPS_GATE] ${vesselId}: Candidate passages cleared (vessel removed)`);
    }
  }

  /**
   * Kontrollera om vessel har aktiv GPS-koordination
   * @private
   */
  _hasActiveGPSCoordination(vessel) {
    // Kontrollera SystemCoordinator för aktiv koordination
    if (this.systemCoordinator && vessel.mmsi) {
      const coordination = this.systemCoordinator.getCoordination(vessel.mmsi.toString());
      return coordination
             && (coordination.level === 'enhanced' || coordination.level === 'system_wide')
             && coordination.protection === true;
    }

    // Fallback: kolla vessel properties
    return vessel.lastCoordinationLevel === 'enhanced'
           || vessel.lastCoordinationLevel === 'system_wide';
  }

  /**
   * Kontrollera om vessel är stabil mellan två tidpunkter
   * @private
   */
  _isVesselStable(oldState, newState) {
    // Kontrollera att position inte har ändrats drastiskt
    const positionChange = this._calculateDistance(
      oldState.lat, oldState.lon,
      newState.lat, newState.lon,
    );

    // Kontrollera att kurs är relativt stabil
    const cogChange = Math.abs(this._normalizeAngle(newState.cog - oldState.cog));

    // Kontrollera att fart är rimlig. Icke-finita farter (sog saknas i
    // meddelandet) behandlas som "stabil okänd" — NaN får aldrig fälla
    // bekräftelsen (S-F1).
    const oldSog = Number.isFinite(oldState.sog) ? oldState.sog : null;
    const newSog = Number.isFinite(newState.sog) ? newState.sog : null;
    const speedChange = (oldSog !== null && newSog !== null) ? Math.abs(newSog - oldSog) : 0;

    // Stabilitetskrav
    const isPositionStable = positionChange < 200; // Mindre än 200m förändring
    const isCOGStable = cogChange < 30; // Mindre än 30° kursändring
    const isSpeedStable = speedChange < 5; // Mindre än 5 knop hastighetsändring

    const isStable = isPositionStable && isCOGStable && isSpeedStable;

    if (!isStable) {
      this.logger.debug(`📊 [GPS_GATE] Instability detected: pos=${positionChange.toFixed(0)}m, cog=${cogChange.toFixed(1)}°, speed=${speedChange.toFixed(1)}kn`);
    }

    return isStable;
  }

  /**
   * Beräkna avstånd mellan två punkter
   * @private
   */
  _calculateDistance(lat1, lon1, lat2, lon2) {
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
   * Normalisera vinkel till [-180, 180] grader
   * @private
   */
  _normalizeAngle(angle) {
    while (angle > 180) angle -= 360;
    while (angle < -180) angle += 360;
    return angle;
  }

  /**
   * Rensa expired gates och candidates
   * @private
   */
  _cleanupExpiredGates() {
    const now = Date.now();
    let cleanedGates = 0;
    let cleanedCandidates = 0;

    // Rensa expired gates
    for (const [vesselId, gateData] of this._gatedVessels.entries()) {
      const age = now - gateData.timestamp;
      if (age > this._gateTimeout) {
        this._gatedVessels.delete(vesselId);
        cleanedGates++;
      }
    }

    // Rensa gamla candidates. Helkodsgranskning 2026-07-01 (C3): gränsen ska
    // vara _gateTimeout (30 s) — F11-retryn i confirmStableCandidates lovar
    // att instabila kandidater lever tills dess; den gamla gränsen
    // (_confirmationPeriod*3 = 15 s) raderade dem i förtid.
    for (const [vesselId, candidates] of this._candidatePassages.entries()) {
      const validCandidates = candidates.filter((c) => (now - c.timestamp) < this._gateTimeout);

      if (validCandidates.length !== candidates.length) {
        cleanedCandidates += candidates.length - validCandidates.length;
        if (validCandidates.length > 0) {
          this._candidatePassages.set(vesselId, validCandidates);
        } else {
          this._candidatePassages.delete(vesselId);
        }
      }
    }

    if (cleanedGates > 0 || cleanedCandidates > 0) {
      this.logger.debug(`🧹 [GPS_GATE] Cleaned ${cleanedGates} gates, ${cleanedCandidates} candidates`);
    }
  }

  /**
   * Få status för debugging
   */
  getStatus() {
    return {
      gatedVessels: this._gatedVessels.size,
      totalCandidates: Array.from(this._candidatePassages.values()).reduce((sum, arr) => sum + arr.length, 0),
      gates: Array.from(this._gatedVessels.entries()).map(([vesselId, gateData]) => ({
        vesselId,
        age: Date.now() - gateData.timestamp,
        reason: gateData.reason,
        jumpDistance: gateData.jumpDistance,
      })),
      candidates: Array.from(this._candidatePassages.entries()).map(([vesselId, candidates]) => ({
        vesselId,
        count: candidates.length,
        oldest: candidates.length > 0 ? Date.now() - Math.min(...candidates.map((c) => c.timestamp)) : 0,
      })),
    };
  }

  /**
   * Cleanup vid service shutdown
   */
  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }

    this._gatedVessels.clear();
    this._candidatePassages.clear();
    this.logger.debug('🛡️ [GPS_GATE] Service destroyed');
  }
}

module.exports = GPSJumpGateService;
