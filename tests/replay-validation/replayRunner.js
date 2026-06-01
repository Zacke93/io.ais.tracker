'use strict';

/**
 * Replay-runner för validering mot historisk AIS-data.
 *
 * Kör den RIKTIGA appen (app.onInit + alla services) mot en ais-replay-*.jsonl
 * och fångar, per fartyg/resa:
 *   - varje bridge_text-övergång (med tidsstämpel + fartygs-state)
 *   - varje boat_near-notis (tokens: bro, riktning, ETA, success)
 *
 * Tidssemantik: AIS-samples spelas upp med sina HISTORISKA aisTimestamp, men
 * appens egna tidsberoenden (stale-ETA, dedupe-fönster, cleanup) använder
 * Date.now(). För att replayen ska efterlikna verklig drift skjuts en virtuell
 * klocka fram till varje samples aisTimestamp innan det matas in (via en
 * injicerad nowFn där appen stödjer det) OCH vi processar i kronologisk ordning.
 *
 * Output: ett JSON-objekt på stdout (mellan markörer) som workflowet läser.
 *
 * Körs som: node tests/replay-validation/replayRunner.js <jsonl-path> [mmsiFilter]
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

// ---- Mocka 'homey' och 'ws' precis som RealAppTestRunner ----
function WSStub() {
  this.readyState = WSStub.OPEN;
  this._handlers = {};
}
WSStub.prototype.on = function on(evt, cb) {
  this._handlers[evt] = cb;
};
WSStub.prototype.send = function send() {};
WSStub.prototype.ping = function ping() {};
WSStub.prototype.terminate = function terminate() {};
WSStub.prototype.removeAllListeners = function removeAllListeners() {};
WSStub.prototype.close = function close() {
  if (this._handlers.close) this._handlers.close(1000, 'replay_close');
};
WSStub.OPEN = 1;

const ROOT = path.resolve(__dirname, '..', '..');
const originalRequire = Module.prototype.require;
Module.prototype.require = function requireOverride(id) {
  if (id === 'homey') {
    return require(path.join(ROOT, 'tests', '__mocks__', 'homey')); // eslint-disable-line global-require
  }
  if (id === 'ws') return WSStub;
  return originalRequire.call(this, id);
};

const mockHomeyModule = require(path.join(ROOT, 'tests', '__mocks__', 'homey'));
const mockHomey = mockHomeyModule.__mockHomey;
const AISBridgeApp = require(path.join(ROOT, 'app'));

async function main() {
  const jsonlPath = process.argv[2];
  const mmsiFilter = process.argv[3] || null;
  if (!jsonlPath) {
    process.stderr.write('Usage: node replayRunner.js <jsonl> [mmsi]\n');
    process.exit(1);
  }

  let samples = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  // Kronologisk ordning (säkerställ)
  samples.sort((a, b) => (a.aisTimestamp || 0) - (b.aisTimestamp || 0));
  if (mmsiFilter) samples = samples.filter((s) => String(s.mmsi) === String(mmsiFilter));
  if (samples.length === 0) {
    process.stdout.write(`__REPLAY_JSON__${JSON.stringify({ error: 'no samples', mmsiFilter })}__END__\n`);
    return;
  }

  // ---- Virtuell klocka: appens Date.now() följer AIS-tidsstämplarna ----
  const realNow = Date.now;
  let virtualNow = samples[0].aisTimestamp;
  // eslint-disable-next-line no-global-assign
  Date.now = () => virtualNow;

  // ---- Init app ----
  global.__TEST_MODE__ = true; // hindrar monitoring-intervall...
  const app = new AISBridgeApp();
  app.homey = mockHomey;
  // ais_api_key=null → onInit ansluter INTE AIS (annars startar ws-ping ett
  // setInterval som håller event-loopen vid liv för evigt). Vi matar AIS
  // manuellt via _processAISMessage nedan.
  mockHomey.app.settings = { debug_level: 'off', ais_api_key: null };
  mockHomey.settings = {
    get: (k) => mockHomey.app.settings[k] || null, on: () => {}, off: () => {},
  };

  // Tysta console-spam under replay (vi vill bara ha vår JSON)
  const origLog = console.log;
  console.log = () => {};

  await app.onInit();

  // KRITISKT för 1:1-trohet: notiser måste få avfyras precis som i produktion.
  // _triggerBoatNearFlow skippar tyst vid __TEST_MODE__ (app.js:2801). Notiserna
  // avfyras dessutom i ICKE-AWAITADE async-lyssnare (vessel:updated /
  // status:changed, app.js:418), så de körs i en senare microtask EFTER att
  // _processAISMessage returnerat.
  //
  // Tidigare bugg: vi nollade __TEST_MODE__ synkront PER meddelande och
  // återställde det direkt — då hann lyssnar-microtasken se flaggan återställd
  // och svalde notisen (fångade 14 av 29). Fix: stäng av TEST_MODE för HELA
  // uppspelningen och DRÄNERA async-lyssnarna (await setImmediate) efter varje
  // sample så de hinner köra klart innan nästa.
  const savedTestMode = global.__TEST_MODE__;
  const savedNodeEnv = process.env.NODE_ENV;
  global.__TEST_MODE__ = undefined;
  process.env.NODE_ENV = 'production';

  // Notiser fångas av MockFlowCard.triggerCalls på boat_near-kortet.
  const boatNearCard = app._boatNearTrigger;
  const drain = () => new Promise((resolve) => setImmediate(resolve));

  // ---- Fånga bridge_text-övergångar ----
  const bridgeTextLog = [];
  const origUpdateCap = app._updateDeviceCapability.bind(app);
  let lastBridgeText = null;
  app._updateDeviceCapability = (capability, value) => {
    if (capability === 'bridge_text' && value !== lastBridgeText) {
      bridgeTextLog.push({ t: virtualNow, iso: new Date(virtualNow).toISOString(), text: value });
      lastBridgeText = value;
    }
    return origUpdateCap(capability, value);
  };

  // Hjälp: generera och fånga bridge text "som UI:t skulle visa nu"
  function captureBridgeText() {
    try {
      const relevant = app._findRelevantBoatsForBridgeText();
      const text = app.bridgeTextService.generateBridgeText(relevant);
      if (text !== lastBridgeText) {
        bridgeTextLog.push({ t: virtualNow, iso: new Date(virtualNow).toISOString(), text });
        lastBridgeText = text;
      }
    } catch (e) {
      bridgeTextLog.push({ t: virtualNow, iso: new Date(virtualNow).toISOString(), text: `__ERROR__:${e.message}` });
    }
  }

  // ---- Spela upp samples kronologiskt ----
  let processErrors = 0;
  for (const s of samples) {
    virtualNow = s.aisTimestamp;
    const aisMessage = {
      mmsi: String(s.mmsi),
      msgType: s.msgType || 'PositionReport',
      lat: s.lat,
      lon: s.lon,
      sog: s.sog,
      cog: s.cog,
      shipName: s.shipName || 'Unknown',
      timestamp: virtualNow,
    };
    try {
      app._processAISMessage(aisMessage);
      // Dränera de icke-awaitade event-lyssnarna (vessel:entered/updated,
      // status:changed) så notiser hinner avfyras innan nästa sample — 1:1 med
      // hur Homeys event-loop bearbetar mellan inkommande AIS-meddelanden.
      // eslint-disable-next-line no-await-in-loop
      await drain();
      // eslint-disable-next-line no-await-in-loop
      await drain();
    } catch (e) {
      processErrors++;
      bridgeTextLog.push({ t: virtualNow, iso: new Date(virtualNow).toISOString(), text: `__PROCESS_ERROR__:${e.message}` });
    }
    captureBridgeText();
  }

  // Återställ globala flaggor efter uppspelning
  global.__TEST_MODE__ = savedTestMode;
  process.env.NODE_ENV = savedNodeEnv;

  // ---- Slutstädning: simulera att tiden går (cleanup-timers) ----
  // Hoppa fram klockan rejält så att eventuella kvarvarande båtar
  // (post-resa) hinner rensas, och fånga slut-texten.
  virtualNow += 40 * 60 * 1000; // +40 min
  captureBridgeText();

  // ---- Samla notiser ----
  const notifications = (boatNearCard && boatNearCard.triggerCalls ? boatNearCard.triggerCalls : [])
    .map((c) => ({
      bridge: c.tokens && c.tokens.bridge_name,
      direction: c.tokens && c.tokens.direction,
      eta: c.tokens && c.tokens.eta_minutes,
      stateBridge: c.state && c.state.bridge,
      mmsi: c.state && c.state.mmsi,
      success: c.success,
      error: c.error || null,
    }));

  // Återställ
  console.log = origLog;
  Date.now = realNow;

  const result = {
    jsonl: path.basename(jsonlPath),
    mmsiFilter,
    sampleCount: samples.length,
    vessels: [...new Set(samples.map((s) => `${s.mmsi}:${s.shipName}`))],
    processErrors,
    bridgeTextTransitions: bridgeTextLog,
    notifications,
    notificationCount: notifications.length,
  };

  process.stdout.write(`__REPLAY_JSON__${JSON.stringify(result)}__END__\n`);

  // Städa ned appen och tvinga avslut (appen kan ha kvarvarande timers).
  try {
    await app.onUninit();
  } catch (_) { /* ignore */ }
  process.exit(0);
}

main().catch((e) => {
  process.stdout.write(`__REPLAY_JSON__${JSON.stringify({ fatal: e.message, stack: e.stack })}__END__\n`);
  process.exit(1);
});
