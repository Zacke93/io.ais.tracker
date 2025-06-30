"use strict";
const Homey = require("homey");

class BridgeStatusDevice extends Homey.Device {
  async onInit() {
    // Registrera denna instans i appen så appen kan uppdatera capabilityn
    this.homey.app._devices.add(this);

    // Sätt initialt värde om appen redan hunnit skapa token-strängen
    const currentText =
      this.homey.app._latestBridgeSentence || "inga fartyg nära någon bro";
    const hasBoats = currentText !== "inga fartyg nära någon bro";

    await this.setCapabilityValue("alarm_generic", hasBoats);
    this.store.lastSentence = currentText; // Spara texten i enhets-lagringen
  }

  async onDeleted() {
    this.homey.app._devices.delete(this);
  }
}

module.exports = BridgeStatusDevice;
