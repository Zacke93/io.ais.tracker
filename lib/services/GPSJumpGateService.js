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

    // ChatGPT-verifieringen 2026-07-10 (C1): kandidaternas livstid var knuten
    // till _gateTimeout (30 s) — men produktions-cleanupen (10s-intervallet
    // nedan) raderade då varje kandidat FÖRE nästa Class B-sample (3–15 min),
    // så tvåstegsbekräftelsen kunde aldrig fullbordas i produktion för glesa
    // sändare (GJ-1-fixens kadensmedvetna stabilitet blev verkningslös där).
    // Osynligt för batteriet: test/replay startar aldrig cleanup-intervallet
    // (__TEST_MODE__ vid init). Kandidater lever nu en egen TTL som täcker
    // maxkadensen + marginal; gate-BLOCKERINGEN är fortsatt 30 s (oförändrad).
    this._candidateTtl = 20 * 60 * 1000; // 20 min

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

    // Helgranskning 2026-07-06 (gpsjump#R2-3): dedup per bro — varje gate:ad
    // tick pushade en NY kandidat för samma bro, och 5-taket (shift äldsta)
    // kunde då tränga ut en ANNAN bros kandidat innan den hann bekräftas.
    // Behåll den ÄLDSTA kandidaten per bro: bekräftelsen mäter ålder + att
    // fartyget varit konsistent sedan FÖRSTA detektionen.
    if (candidates.some((c) => c.bridgeName === bridgeName)) {
      this.logger.debug(`📋 [GPS_GATE] ${vesselId}: Candidate for ${bridgeName} already registered — keeping oldest`);
      return;
    }

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
        const isStable = this._isVesselStable(candidate.vesselState, vessel, age);

        if (isStable) {
          confirmedPassages.push({
            bridgeName: candidate.bridgeName,
            passageResult: candidate.passageResult,
            confirmedAt: now,
            // Fable-granskningen 2026-07-10b (G-1): snapshotten följer med
            // så konsumenten kan köra SIDOKONTRAKTET — fysikfönstret växer
            // med kandidatens ålder och kan inte ensamt skilja en konstant
            // hopp-offset (falsk kandidat) från äkta färd.
            vesselState: candidate.vesselState,
          });

          this.logger.debug(`✅ [GPS_GATE] ${vesselId}: Confirmed passage of ${candidate.bridgeName} after ${Math.round(age / 1000)}s stability`);
        } else if (age < this._candidateTtl) {
          // F11: gammal nog men just nu instabil → DROPPA INTE tyst. En äkta
          // passage kan annars tappas om GPS råkar vara brusig precis vid
          // 5s-kontrollen → fryst fel bro + missad notis. Behåll kandidaten så
          // en senare stabil tick kan bekräfta den, med _candidateTtl (C1,
          // 20 min — täcker Class B-maxkadens) som övre gräns (matchar
          // _cleanupExpiredGates-backstoppet).
          remainingCandidates.push(candidate);
          this.logger.debug(`⏳ [GPS_GATE] ${vesselId}: Candidate for ${candidate.bridgeName} unstable at ${Math.round(age / 1000)}s — retrying (keep until ${Math.round(this._candidateTtl / 1000)}s)`);
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
  _isVesselStable(oldState, newState, elapsedMs = null) {
    // Kontrollera att position inte har ändrats drastiskt
    const positionChange = this._calculateDistance(
      oldState.lat, oldState.lon,
      newState.lat, newState.lon,
    );

    // Kontrollera att kurs är relativt stabil. Icke-finit COG (AIS tillåter
    // "kurs ej tillgänglig") behandlas som "stabil okänd" — samma S-F1-klass
    // som sog: NaN < 30 är alltid false, så en båt utan COG kunde ALDRIG få
    // sin gate-kandidat bekräftad och äkta passager övergavs tyst efter 30 s
    // (produktionsredo-granskningen 2026-07-03).
    const oldCog = Number.isFinite(oldState.cog) ? oldState.cog : null;
    const newCog = Number.isFinite(newState.cog) ? newState.cog : null;
    const cogChange = (oldCog !== null && newCog !== null)
      ? Math.abs(this._normalizeAngle(newCog - oldCog))
      : 0;

    // Kontrollera att fart är rimlig. Icke-finita farter (sog saknas i
    // meddelandet) behandlas som "stabil okänd" — NaN får aldrig fälla
    // bekräftelsen (S-F1).
    const oldSog = Number.isFinite(oldState.sog) ? oldState.sog : null;
    const newSog = Number.isFinite(newState.sog) ? newState.sog : null;
    const speedChange = (oldSog !== null && newSog !== null) ? Math.abs(newSog - oldSog) : 0;

    // Stabilitetskrav
    // Helgranskning 2026-07-10 (GJ-1): den fasta 200 m-gränsen kunde ALDRIG
    // bekräfta en rörlig gles-kadens-båt — vid Class B-intervall (3–15 min)
    // har varje båt i färd garanterat passerat 200 m till nästa sample, och
    // eftersom age då redan överstiger _gateTimeout övergavs kandidaten vid
    // FÖRSTA bekräftelseförsöket. Den äkta passagen (detekterad under aktiv
    // gate, t.ex. multipath-hopp vid själva bron) registrerades aldrig →
    // utebliven target-transition → texten frös på passerad bro. "Stabil"
    // betyder fysikaliskt KONSISTENT rörelse, inte stillastående: tillåt
    // förflyttning upp till maxfart × förfluten tid × 2,0-marginalen (samma
    // princip som GPSJumpAnalyzers medium-gate; 5 kn-golv vid okänd fart,
    // 200 m-golvet behålls för korta intervall/GPS-brus). Utan känd
    // tidsbas (elapsedMs=null) gäller gamla 200 m-gränsen oförändrad.
    let allowedPositionChangeM = 200;
    if (Number.isFinite(elapsedMs) && elapsedMs > 0) {
      const knownMaxSog = Math.max(oldSog ?? 0, newSog ?? 0);
      // Fable-granskningen 2026-07-10b (G-2): ENSIDIG sog=null fick 1 kn-
      // golvet — exakt klassen GJ-2 rättade i analyzerns medium-gate
      // ("gammal sog 0,3, nytt sample null" = intervallets verkliga fart
      // okänd). En avgående väntare (snapshot-sog 0,5 → null-svit) sprang
      // annars permanent ifrån fönstret och kandidaten övergavs → utebliven
      // target-transition. Spegla GJ-2: okänd sida ⇒ 5 kn-golv.
      const speedFloorKn = (oldSog === null || newSog === null)
        ? Math.max(knownMaxSog, 5)
        : Math.max(knownMaxSog, 1);
      const elapsedHours = elapsedMs / 3600000;
      allowedPositionChangeM = Math.max(200, speedFloorKn * 1852 * elapsedHours * 2.0);
    }
    const isPositionStable = positionChange < allowedPositionChangeM;
    // GJ-1 (forts): kursen hinner legitimt ändras när samplen är glesa —
    // kanalen svänger (lokala bäringar 22–35° mellan broarna, mer vid
    // Stallbacka). 30° gäller täta sampel; över 60 s tillåts 60°.
    const cogToleranceDeg = (Number.isFinite(elapsedMs) && elapsedMs > 60000) ? 60 : 30;
    const isCOGStable = cogChange < cogToleranceDeg;
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

    // Rensa gamla candidates. Helkodsgranskning 2026-07-01 (C3): gränsen
    // följer F11-retryns löfte i confirmStableCandidates. ChatGPT-
    // verifieringen 2026-07-10 (C1): gränsen höjd _gateTimeout (30 s) →
    // _candidateTtl (20 min) — 30 s raderade varje gles-kadens-kandidat
    // FÖRE nästa sample, så bekräftelsen var omöjlig i produktion.
    for (const [vesselId, candidates] of this._candidatePassages.entries()) {
      const validCandidates = candidates.filter((c) => (now - c.timestamp) < this._candidateTtl);

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
