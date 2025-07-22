'use strict';

const Homey = require('homey');

class BridgeStatusDevice extends Homey.Device {
  /* ---------------------------------------------------
   *  DEVICE INIT
   * --------------------------------------------------- */
  async onInit() {
    this.log('BridgeStatusDevice initializing…');

    try {
      // 1) Vänta tills appen är redo
      await this._ensureAppReady();

      // 2) Lägg in den här instansen i appens Set
      this.log('Adding device to app._devices collection');
      this.homey.app.addDevice(this);

      /* ---------------- Primär text & alarm ---------------- */
      const defaultTxt = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
      const currentText = this.homey.app._latestBridgeSentence || defaultTxt;

      let hasBoats = false;
      if (typeof this.homey.app._findRelevantBoats === 'function') {
        try {
          const boats = this.homey.app._findRelevantBoats();
          hasBoats = boats.length > 0;
        } catch (err) {
          this.error('Error checking relevant boats, fallback:', err);
          hasBoats = currentText !== defaultTxt;
        }
      } else {
        hasBoats = currentText !== defaultTxt;
      }

      this.log('Setting initial capability values');
      await this.setCapabilityValue('alarm_generic', hasBoats);
      await this.setCapabilityValue('bridge_text', currentText);

      // Synka direkt med appens nuvarande status
      const statusValue = this.homey.app._isConnected
        ? 'connected'
        : 'disconnected';
      await this.setCapabilityValue('connection_status', statusValue);
      this.log(`Initial connection status: ${statusValue}`);

      /* ---------------- Persistens ------------------------- */
      if (!this.getStore()) {
        await this.setStoreValue('lastSentence', currentText);
      } else {
        await this.setStoreValue('lastSentence', currentText);
      }

      this.log('Device initialization complete');

      /* --------- Tvinga en uppdatering efter 1 s ----------- */
      setTimeout(() => {
        if (this.homey.app?._updateActiveBridgesTag) {
          this.log('Forcing update after device creation');
          this.homey.app._updateActiveBridgesTag('device_init');
        }
      }, 1000);
    } catch (err) {
      this.error('Failed to initialize device:', err);
    }
  }

  /* ---------------------------------------------------
   *  DEVICE DELETED
   * --------------------------------------------------- */
  async onDeleted() {
    this.log('Device being deleted');
    if (this.homey.app) {
      this.homey.app.removeDevice(this);
      this.log('Removed from app._devices collection');
    } else {
      this.error('Could not remove from app – not available');
    }
  }

  /* ---------------------------------------------------
   *  PRIVATE: Wait until app exposes _devices Set
   * --------------------------------------------------- */
  async _ensureAppReady() {
    for (let i = 0; i < 10; i++) {
      if (this.homey.app && this.homey.app._devices) return true;
      this.log(`Waiting for app to be ready (attempt ${i + 1})`);
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error('App not ready after multiple attempts');
  }
}

module.exports = BridgeStatusDevice;
