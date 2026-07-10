'use strict';

const { APPROACHING_RADIUS } = require('../constants');

/**
 * CurrentBridgeManager - Robust tracking of vessel's current bridge
 * Solves the currentBridge "stuck" bug by providing automatic updates
 */
class CurrentBridgeManager {
  constructor(bridgeRegistry, logger) {
    this.bridgeRegistry = bridgeRegistry;
    this.logger = logger;

    // Hysteresis values for stability (prevent flapping)
    // FIX 3: Utökad SET_DISTANCE till 500m för att fånga "närmar sig [mellanbro]" meddelanden
    // Detta löser problemet där "närmar sig Järnvägsbron" aldrig visas
    this.SET_DISTANCE = APPROACHING_RADIUS; // 500m - when to set currentBridge (was 300m)
    this.CLEAR_DISTANCE = APPROACHING_RADIUS * 1.2; // 600m - when to clear currentBridge
  }

  /**
   * Update vessel's currentBridge based on proximity data
   * @param {Object} vessel - Vessel object to update
   * @param {Object} proximityData - Proximity analysis result
   */
  updateCurrentBridge(vessel, proximityData) {
    const oldCurrentBridge = vessel.currentBridge;
    const nearest = proximityData.nearestBridge;

    // Produktionsredo (2026-07-03, backloggens stuck-fynd): räkna ALLTID om
    // avståndet till nuvarande bro först. Regel 2 jämförde annars ett FRYST
    // lagrat värde — när en ANNAN bro blev närmast bortom SET-avståndet
    // uppdaterade ingen regel avståndet och currentBridge rensades aldrig.
    if (vessel.currentBridge) {
      const currentDist = this._distanceToBridge(vessel.currentBridge, proximityData);
      if (Number.isFinite(currentDist)) {
        vessel.distanceToCurrent = currentDist;
      }
    }

    // CRITICAL FIX: Clear currentBridge if vessel has passed this bridge
    // This prevents "ghost waiting" where vessel appears to wait at already-passed bridge
    if (vessel.currentBridge
        && vessel.lastPassedBridge === vessel.currentBridge
        && vessel.distanceToCurrent > 50) {
      this.logger.debug(
        `🚢✅ [CURRENT_BRIDGE_PASSED] ${vessel.mmsi}: Clearing ${vessel.currentBridge} (passed bridge, now ${vessel.distanceToCurrent?.toFixed(0)}m away)`,
      );
      vessel.currentBridge = null;
      vessel.distanceToCurrent = null;
      return; // Exit early after clearing passed bridge
    }

    // Rule 1: Set currentBridge if vessel is close to a bridge.
    // Backloggens flapp-fynd (2026-07-03): sätt INTE om en nyss passerad bro
    // som redan rensats av Regel 0 (>50 m bortom) — sätt/rensa oscillerade
    // annars varannan tick i 50–500 m-bandet efter passage.
    // Fable-granskningen 2026-07-10b (B-1): spärren saknade tidsgräns —
    // "nyss passerad" var i praktiken "senast passerad någonsin", så en
    // U-svängd båt på väg TILLBAKA mot samma bro nekades currentBridge i
    // hela 50–500 m-bandet. Villkora på passedBridges-medlemskap:
    // U-svängsresetten rensar listan riktningsrelativt, så returbenet
    // släpps medan det normala post-passage-flappbandet (bron kvar i
    // listan) fortsatt spärras. Saknad lista ⇒ gamla beteendet (spärra).
    const nearestIsRecentlyPassed = nearest
      && nearest.name === vessel.lastPassedBridge
      && nearest.distance > 50
      && (!Array.isArray(vessel.passedBridges)
        || vessel.passedBridges.includes(nearest.name));
    if (nearest && nearest.distance <= this.SET_DISTANCE && !nearestIsRecentlyPassed) {
      vessel.currentBridge = nearest.name;
      vessel.distanceToCurrent = nearest.distance;

      if (oldCurrentBridge !== vessel.currentBridge) {
        this.logger.debug(
          `🔄 [CURRENT_BRIDGE_SET] ${vessel.mmsi}: ${oldCurrentBridge || 'null'} -> ${vessel.currentBridge} (${nearest.distance.toFixed(0)}m)`,
        );
      }
    } else if (vessel.currentBridge && vessel.distanceToCurrent > this.CLEAR_DISTANCE) {
    // Rule 2: Clear currentBridge if vessel has moved far away (hysteresis)
      this.logger.debug(
        `🔄 [CURRENT_BRIDGE_CLEAR] ${vessel.mmsi}: ${vessel.currentBridge} -> null (${vessel.distanceToCurrent.toFixed(0)}m > ${this.CLEAR_DISTANCE}m)`,
      );

      vessel.currentBridge = null;
      vessel.distanceToCurrent = null;
    }
    // (Regel 3 — separat avståndsuppdatering — ersatt av omräkningen överst.)
  }

  /**
   * Avstånd från vessel till namngiven bro via proximityData (bridgeDistances
   * nycklas på bro-ID, currentBridge lagrar NAMN — slå upp ID:t).
   * @private
   */
  _distanceToBridge(bridgeName, proximityData) {
    if (!proximityData) return null;
    if (proximityData.nearestBridge && proximityData.nearestBridge.name === bridgeName
        && Number.isFinite(proximityData.nearestBridge.distance)) {
      return proximityData.nearestBridge.distance;
    }
    if (Array.isArray(proximityData.bridges)) {
      const hit = proximityData.bridges.find((b) => b && b.name === bridgeName);
      if (hit && Number.isFinite(hit.distance)) return hit.distance;
    }
    if (proximityData.bridgeDistances && this.bridgeRegistry && this.bridgeRegistry.bridges) {
      for (const [id, bridge] of Object.entries(this.bridgeRegistry.bridges)) {
        if (bridge.name === bridgeName && Number.isFinite(proximityData.bridgeDistances[id])) {
          return proximityData.bridgeDistances[id];
        }
      }
    }
    return null;
  }
}

module.exports = CurrentBridgeManager;
