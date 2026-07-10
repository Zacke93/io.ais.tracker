'use strict';

const Homey = require('homey');
const { BRIDGE_TEXT_CONSTANTS } = require('../../lib/constants');

class BridgeStatusDevice extends Homey.Device {
  /* ---------------------------------------------------
   *  DEVICE INIT
   * --------------------------------------------------- */
  async onInit() {
    this.log('BridgeStatusDevice initializing…');

    try {
      // 1) Vänta tills appen är redo
      await this._ensureAppReady();

      // 2) Capability-migrering: enheter parade innan en capability lades
      // till i driver.compose.json (t.ex. connection_status, tillagd
      // 2026-06-09) saknar den annars för alltid och varje
      // setCapabilityValue-anrop kastar. Standard Homey-mönster: lägg till
      // saknade capabilities i onInit. Listan speglar driver.compose.json.
      const requiredCapabilities = ['alarm_generic', 'bridge_text', 'connection_status'];
      for (const capabilityId of requiredCapabilities) {
        if (!this.hasCapability(capabilityId)) {
          try {
            this.log(`Migrating device: adding missing capability '${capabilityId}'`);
            await this.addCapability(capabilityId);
          } catch (err) {
            this.error(`Failed to add missing capability '${capabilityId}':`, err);
          }
        }
      }

      // 3) Lägg in den här instansen i appens Set
      this.log('Adding device to app._devices collection');
      this.homey.app.addDevice(this);

      /* ---------------- Primär text & alarm ---------------- */
      // A5-fix (2026-06-09): läste tidigare _latestBridgeSentence som aldrig
      // funnits i app.js → enheten visade ALLTID default-texten. Rätt
      // egenskap är _lastBridgeText. Default hämtas från constants så den
      // inte kan glida isär från appens.
      const defaultTxt = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
      const currentText = this.homey.app._lastBridgeText || defaultTxt;

      // A5-fix: _findRelevantBoats fanns inte heller (rätt namn är
      // _findRelevantBoatsForBridgeText) → fallbacken användes alltid.
      let hasBoats = false;
      if (typeof this.homey.app._findRelevantBoatsForBridgeText === 'function') {
        try {
          const boats = this.homey.app._findRelevantBoatsForBridgeText();
          hasBoats = Array.isArray(boats) && boats.length > 0;
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
      await this.setStoreValue('lastSentence', currentText);

      this.log('Device initialization complete');

      /* --------- Tvinga en uppdatering efter 1 s ----------- */
      // A5-fix: _updateActiveBridgesTag fanns inte i app.js — rätt väg är
      // appens ordinarie UI-pipeline (_updateUI). Timern spåras så
      // onDeleted kan rensa den om enheten tas bort inom sekunden.
      this._initUpdateTimeout = setTimeout(() => {
        this._initUpdateTimeout = null;
        if (typeof this.homey.app?._updateUI === 'function') {
          this.log('Forcing UI update after device creation');
          try {
            this.homey.app._updateUI('critical', 'device-init');
          } catch (err) {
            this.error('Post-init UI update failed:', err);
          }
        }
      }, 1000);
    } catch (err) {
      this.error('Failed to initialize device:', err);
      // ChatGPT-granskningen 2026-07-10 (I1): synliggör felet i stället för
      // att tyst registrera en halvinitierad enhet. Flaggan låter appens
      // nästa lyckade capability-skrivning (_updateDeviceCapability i
      // app.js) återställa tillgängligheten automatiskt — enheten fastnar
      // aldrig i unavailable när push-pipelinen bevisligen fungerar igen.
      this._initFailed = true;
      // Skärpt i andra granskningsrundan: ett fel FÖRE addDevice-steget
      // lämnade enheten utanför push-Set:en — då når självläkningen den
      // aldrig. Registrera i catchen också (Set.add är idempotent, så
      // dubbelregistrering vid fel EFTER addDevice är ofarlig).
      try {
        if (this.homey && this.homey.app && typeof this.homey.app.addDevice === 'function') {
          this.homey.app.addDevice(this);
        }
      } catch (addErr) {
        this.error('Failed to register device for recovery:', addErr);
      }
      if (typeof this.setUnavailable === 'function') {
        this.setUnavailable('Initialization failed — recovering automatically').catch(() => {});
      }
    }
  }

  /* ---------------------------------------------------
   *  DEVICE DELETED
   * --------------------------------------------------- */
  async onDeleted() {
    this.log('Device being deleted');
    if (this._initUpdateTimeout) {
      clearTimeout(this._initUpdateTimeout);
      this._initUpdateTimeout = null;
    }
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
