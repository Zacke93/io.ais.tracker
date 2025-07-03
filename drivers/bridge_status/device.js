"use strict";
const Homey = require("homey");

class BridgeStatusDevice extends Homey.Device {
  async onInit() {
    this.log("BridgeStatusDevice initializing...");

    try {
      // Wait to ensure app is fully initialized
      await this._ensureAppReady();

      // Registrera denna instans i appen så appen kan uppdatera capabilityn
      this.log("Adding device to app._devices collection");
      this.homey.app._devices.add(this);
      await this.homey.app._saveDevices();

      // Sätt initialt värde om appen redan hunnit skapa token-strängen
      const currentText =
        this.homey.app._latestBridgeSentence || "Inga båtar är i närheten av Klaffbron eller Stridsbergsbron";
      
      // Use the same logic as the app to determine hasBoats
      let hasBoats = false;
      if (this.homey.app._findRelevantBoats) {
        try {
          const relevantBoats = this.homey.app._findRelevantBoats();
          hasBoats = relevantBoats.length > 0;
        } catch (err) {
          this.error("Error checking relevant boats, falling back to text comparison:", err);
          hasBoats = currentText !== "Inga båtar är i närheten av Klaffbron eller Stridsbergsbron";
        }
      } else {
        hasBoats = currentText !== "Inga båtar är i närheten av Klaffbron eller Stridsbergsbron";
      }

      this.log("Setting initial capability values");
      this.log(`Current text: "${currentText}", hasBoats: ${hasBoats}`);
      await this.setCapabilityValue("alarm_generic", hasBoats);
      await this.setCapabilityValue("bridge_text", currentText);

      // Check if we have the connection_status capability, add it if not
      if (!this.hasCapability("connection_status")) {
        this.log("Adding connection_status capability");
        await this.addCapability("connection_status");
      }
      
      // Set initial connection status based on app state
      const isConnected = this.homey.app._isConnected || false;
      const statusValue = isConnected ? "connected" : "disconnected";
      await this.setCapabilityValue("connection_status", statusValue);
      this.log(`Set initial connection status to: ${statusValue}`);

      // Initialize this.store if needed
      if (!this.getStore()) {
        this.log("Initializing device store");
        await this.setStoreValue("lastSentence", currentText);
      } else {
        this.log("Store exists, updating lastSentence");
        await this.setStoreValue("lastSentence", currentText);
      }

      this.log("Device initialization complete");
      
      // Force an update after device creation to ensure correct values
      setTimeout(() => {
        if (this.homey.app && this.homey.app._updateActiveBridgesTag) {
          this.log("Forcing update after device creation");
          this.homey.app._updateActiveBridgesTag();
        }
      }, 1000);
    } catch (err) {
      this.error("Failed to initialize device:", err);
    }
  }

  // Helper method to wait for app to be ready
  async _ensureAppReady() {
    // Try up to 10 times with 500ms intervals
    for (let i = 0; i < 10; i++) {
      if (this.homey.app && this.homey.app._devices instanceof Set) {
        return true;
      }
      this.log(`Waiting for app to be ready (attempt ${i + 1})`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("App not ready after multiple attempts");
  }

  async onDeleted() {
    this.log("Device being deleted");
    if (this.homey.app && this.homey.app._devices) {
      this.homey.app._devices.delete(this);
      this.log("Removed from app._devices collection");
      await this.homey.app._saveDevices();
    } else {
      this.error("Could not remove from app._devices - not available");
    }
  }
}

module.exports = BridgeStatusDevice;
