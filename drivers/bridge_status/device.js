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

      // R2 2026-07-11 (SYSR2-1): raderas enheten MEDAN onInit awaitar
      // (kallstartens _ensureAppReady kan sova sekunder) hann onDeleted
      // köra removeDevice som no-op — och rad addDevice nedan registrerade
      // sedan zombien permanent (varje skrivning rejectar → hash-null varje
      // cykel → error-storm tills appomstart). SYS-1-flaggan täckte bara
      // catch-vägen; try-vägen behöver samma spärr.
      if (this._deleted) {
        this.log('Device deleted during init — aborting initialization');
        return;
      }

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
      // Fable-granskningen 2026-08-10 (FG-E5): SYSR2-1-spärren ovan täckte bara
      // FÖRSTA await-punkten (_ensureAppReady). Capability-migreringen mellan
      // den och hit awaitar en gång per saknad capability — raderas enheten där
      // hann onDeleted köra removeDevice som no-op, och raden nedan
      // återregistrerade zombien permanent (exakt SYS-1-klassen: varje
      // skrivning rejectar → hash-null varje cykel → error-storm tills
      // appomstart). Spärren måste därför upprepas omedelbart före varje
      // sidoeffekt som lämnar spår utanför instansen.
      if (this._deleted) {
        this.log('Device deleted during capability migration — aborting initialization');
        return;
      }

      this.log('Adding device to app._devices collection');
      this.homey.app.addDevice(this);

      /* ---------------- Primär text & alarm ---------------- */
      // A5-fix (2026-06-09): läste tidigare _latestBridgeSentence som aldrig
      // funnits i app.js → enheten visade ALLTID default-texten. Rätt
      // egenskap är _lastBridgeText. Default hämtas från constants så den
      // inte kan glida isär från appens.
      const defaultTxt = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
      const currentText = this.homey.app._lastBridgeText || defaultTxt;

      // Fable-granskningen 2026-07-10b (A2-4/SYS-4): spegla APPENS larmcache
      // i stället för att räkna rå-projektionen — appen övergav rålistans
      // semantik 2026-07-06 (app-4#2: larm ⇔ text; rålistan innehåller
      // orenderbara båtar) och appens värde-dedup (`!==`) korrigerar aldrig
      // en avvikande initialskrivning förrän nästa äkta larmväxling. En
      // enhet parad i BUG 11-fönstret kunde annars lysa larm mot "Inga
      // båtar"-text i timmar.
      const appAlarm = this.homey.app._lastBridgeAlarm;
      const hasBoats = typeof appAlarm === 'boolean'
        ? appAlarm
        : currentText !== defaultTxt;

      this.log('Setting initial capability values');
      await this.setCapabilityValue('alarm_generic', hasBoats);
      await this.setCapabilityValue('bridge_text', currentText);

      // Synka direkt med appens nuvarande status
      // B2c (etapp 7, 2026-08-08): tre lägen — en enhet som paras medan halva
      // källparet är dött ska inte visa "Uppkopplad" tills nästa flank. Samma
      // uttryck som appens _updateUI-flank (frånkoppling vinner över degraderat).
      // P3 (2026-08-09): uttrycket bor numera i appen (connectionStatusValue),
      // som också bär STARTGRINDEN — en enhet som paras innan någon AIS-källa
      // svarat (öppnad socket / välformat AISHub-svar / accepterad position)
      // ska inte visa "Uppkopplad". F1 (2026-08-10): grinden mäter KÄLLSVAR,
      // inte trafik — en tom kanal ger "Uppkopplad", en död kedja gör det inte.
      // Fallbacken behålls för appstubbar utan metoden (äldre tester/mockar).
      const connectedValue = this.homey.app._connectionFeedDegraded ? 'degraded' : 'connected';
      const fallbackStatus = this.homey.app._isConnected ? connectedValue : 'disconnected';
      const statusValue = typeof this.homey.app.connectionStatusValue === 'function'
        ? this.homey.app.connectionStatusValue()
        : fallbackStatus;
      await this.setCapabilityValue('connection_status', statusValue);
      this.log(`Initial connection status: ${statusValue}`);

      /* ---------------- Persistens ------------------------- */
      await this.setStoreValue('lastSentence', currentText);

      this.log('Device initialization complete');

      /* --------- Tvinga en uppdatering efter 1 s ----------- */
      // A5-fix: _updateActiveBridgesTag fanns inte i app.js — rätt väg är
      // appens ordinarie UI-pipeline (_updateUI). Timern spåras så
      // onDeleted kan rensa den om enheten tas bort inom sekunden.
      // Fable-granskningen 2026-08-10 (FG-E5): onDeletes städning bygger på att
      // fältet redan BÄR timern. Raderas enheten under någon av awaitarna
      // ovan (setCapabilityValue ×3, setStoreValue) läste onDeleted ett null
      // fält och skapades timern EFTERÅT — en föräldralös timer som nollar
      // appens dedup-cacher och kör _updateUI för en enhet som inte längre
      // finns. Skapa den aldrig efter raderingen.
      if (this._deleted) {
        this.log('Device deleted during init writes — skipping post-init UI timer');
        return;
      }

      this._initUpdateTimeout = setTimeout(() => {
        // FG-E5: stänger fönstret MELLAN skapandet och onDeleteds clearTimeout —
        // en redan schemalagd callback får aldrig röra appens dedup-cacher för
        // en raderad enhet.
        if (this._deleted) return;
        this._initUpdateTimeout = null;
        if (typeof this.homey.app?._updateUI === 'function') {
          this.log('Forcing UI update after device creation');
          try {
            // Fable-granskningen 2026-07-10b (SYS-3/P1-5): init-skrivningarna
            // ovan går UTANFÖR appens serialiserade skrivkedja och kan lägga
            // en stale text OVANPÅ en nyare push (pariringsrace) — och
            // hash-/värde-dedupen skrev då aldrig om. Nolla dedup-cacherna
            // före den forcerade cykeln så den ordinarie kedjan garanterat
            // skriver om text + larm med FÄRSKT värde till alla enheter.
            // R2 2026-07-11 (SYSR2-3): även connection_status — den tredje
            // kanalen skrevs också direkt (rad ~69) och en stale
            // direktskrivning frös annars tills nästa äkta transition.
            this.homey.app._lastBridgeTextHash = null;
            this.homey.app._lastBridgeAlarm = null;
            this.homey.app._lastConnectionStatus = null;
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
        // Fable-granskningen 2026-07-10b (SYS-1): raderas enheten MEDAN
        // onInit awaitar kastar de kvarvarande skrivningarna in hit EFTER
        // att onDeleted hunnit köra removeDevice — den ovillkorliga
        // återregistreringen gjorde enheten till permanent zombie i
        // push-Set:et (varje skrivning rejectar → hash-null varje cykel →
        // error-storm tills appomstart). Registrera aldrig en raderad enhet.
        if (!this._deleted && this.homey && this.homey.app && typeof this.homey.app.addDevice === 'function') {
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
    this._deleted = true; // SYS-1: spärra onInit-catchens återregistrering
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
