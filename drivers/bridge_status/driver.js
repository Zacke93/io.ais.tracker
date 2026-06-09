'use strict';

const Homey = require('homey');

class BridgeStatusDriver extends Homey.Driver {
  async onInit() {
    this.log('BridgeStatusDriver init');
  }

  /**
   * Enkel pairing – listar EN enhet som alltid kan läggas till.
   * Vill du tillåta flera instanser? Lägg in unik id-logik här.
   */
  async onPairListDevices() {
    this.log('onPairListDevices called');
    return [
      {
        name: 'AIS Bridge status',
        data: { id: 'bridge_status_1' }, // unikt ID
        // A5-fix (2026-06-09): connection_status saknades här men finns i
        // app.json och sätts av device.js → håll listan komplett.
        capabilities: ['alarm_generic', 'bridge_text', 'connection_status'],
      },
    ];
  }

  onPair(session) {
    this.log('onPair session started');

    session.setHandler('list_devices', async () => {
      this.log('list_devices handler called');
      const devices = await this.onPairListDevices();
      this.log('Returning devices:', JSON.stringify(devices));
      return devices;
    });

    session.setHandler('add_device', async (data) => {
      this.log('add_device handler called with:', JSON.stringify(data || {}));

      // Make sure app instance is ready to receive devices
      if (this.homey.app) {
        this.log('App instance is available');

        // Initialize _devices collection if needed
        if (!this.homey.app._devices) {
          this.log('Creating _devices collection in app during pairing');
          this.homey.app._devices = new Set();
        }

        // Force an update of the sentence after a short delay to ensure device is ready
        // A5-fix (2026-06-09): _updateActiveBridgesTag fanns aldrig i app.js —
        // använd appens ordinarie UI-pipeline. homey.setTimeout (typad i SDK3)
        // disposas automatiskt om appen stängs ner.
        this.homey.setTimeout(() => {
          this.log('Triggering update after device creation');
          if (typeof this.homey.app?._updateUI === 'function') {
            try {
              this.homey.app._updateUI('critical', 'device-added');
            } catch (err) {
              this.error('Post-pairing UI update failed:', err);
            }
          }
        }, 2000);
      }

      this.log('Device will be added to Homey - returning true');
      return true;
    });
  }
}

module.exports = BridgeStatusDriver;
