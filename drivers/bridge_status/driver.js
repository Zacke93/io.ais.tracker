"use strict";
const Homey = require("homey");

class BridgeStatusDriver extends Homey.Driver {
  /**
   * Enkel pairing – listar EN enhet som alltid kan läggas till.
   * Vill du tillåta flera instanser? Lägg in unik id-logik här.
   */
  async onPairListDevices() {
    return [
      {
        name: "AIS Bridge status",
        data: { id: "bridge_status_1" }, // unikt ID
      },
    ];
  }

  // Behåll även den gamla metoden för bakåtkompatibilitet
  onPair(session) {
    session.setHandler("list_devices", async () => {
      return this.onPairListDevices();
    });
  }
}

module.exports = BridgeStatusDriver;
