'use strict';

/**
 * Replay-runner för validering mot historisk AIS-data (v2 — fake-timers).
 *
 * Kör den RIKTIGA appen (app.onInit + alla services) mot en ais-replay-*.jsonl
 * och fångar, per fartyg/resa:
 *   - varje bridge_text-övergång (via den RIKTIGA publiceringsvägen
 *     _updateDeviceCapability — inkl. coalescing/stale-guard)
 *   - varje boat_near-notis (tokens: bro, riktning, ETA, success)
 *
 * TIDSMODELL (v2, åtgärdar fidelitetsbristen i v1):
 * En @sinonjs/fake-timers-klocka driver BÅDE Date.now OCH setTimeout/setInterval.
 * Mellan två samples stegas klockan fram till nästa samples aisTimestamp med
 * clock.tick(gap) — då fyrar appens RIKTIGA cleanup-/STALE_AIS-/protection-/
 * monitoring-timrar precis som i drift. I v1 mockades bara Date.now medan
 * setTimeout var äkta och aldrig hann lösa ut → fartyg städades aldrig → replayen
 * ÖVER-producerade fantomnotiser för fartyg som produktion korrekt tagit bort.
 *
 * setImmediate hålls ÄKTA (ej fejkad) så att mock-homey och microtask-dränering
 * fungerar; de icke-awaitade async-lyssnarna (vessel:updated/status:changed)
 * dräneras med `await new Promise(setImmediate)` efter varje steg.
 *
 * Körs som: node tests/replay-validation/replayRunner.js <jsonl-path> [mmsiFilter]
 * Skriver ett JSON-objekt på stdout mellan markörer (__REPLAY_JSON__...__END__).
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
// eslint-disable-next-line node/no-unpublished-require
const FakeTimers = require('@sinonjs/fake-timers'); // dev-only: replay-harness, ej publicerad app-kod

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

// Äkta setImmediate (sparas innan klockan installeras) för microtask-dränering.
const realSetImmediate = setImmediate;
const drain = () => new Promise((resolve) => realSetImmediate(resolve));

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
  samples.sort((a, b) => (a.aisTimestamp || 0) - (b.aisTimestamp || 0));
  if (mmsiFilter) samples = samples.filter((s) => String(s.mmsi) === String(mmsiFilter));
  if (samples.length === 0) {
    process.stdout.write(`__REPLAY_JSON__${JSON.stringify({ error: 'no samples', mmsiFilter })}__END__\n`);
    return;
  }

  // ---- Fake-klocka: driver BÅDE Date OCH setTimeout/setInterval ----
  // setImmediate hålls äkta (draineras manuellt). nextTick lämnas äkta.
  const clock = FakeTimers.install({
    now: samples[0].aisTimestamp,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });

  // ---- Init app ----
  global.__TEST_MODE__ = true; // hindrar monitoring-intervall under init
  let app = new AISBridgeApp();
  app.homey = mockHomey;
  // ais_api_key=null → onInit ansluter INTE AIS (annars startar ws-ping ett
  // setInterval som håller event-loopen vid liv). Vi matar AIS manuellt nedan.
  // set (2026-07-03): persistensvägarna (_persistRecentTriggers/
  // _persistVesselNames) skriver på riktigt så ctrl:'restart' kan testa
  // load/save-cykeln i helkedjan — tidigare no-op:ade de tyst (ingen set).
  mockHomey.app.settings = { debug_level: 'off', ais_api_key: null };
  mockHomey.settings = {
    get: (k) => mockHomey.app.settings[k] || null,
    set: (k, v) => {
      mockHomey.app.settings[k] = v;
    },
    on: () => {},
    off: () => {},
  };

  // Tysta console-spam under replay (vi vill bara ha vår JSON på stdout).
  // REPLAY_VERBOSE=1 behåller loggarna på stderr — felsökningsläge.
  const origLog = console.log;
  console.log = process.env.REPLAY_VERBOSE
    ? (...args) => process.stderr.write(`${args.join(' ')}\n`)
    : () => {};

  // Notiser måste få avfyras precis som i produktion. _triggerBoatNearFlow
  // skippar tyst vid __TEST_MODE__, och notiserna avfyras i ICKE-AWAITADE
  // async-lyssnare. VIKTIGT (regression 2026-07-03, scenario 34): onInit
  // MÅSTE köras under __TEST_MODE__=true (hoppar över monitoring-intervall
  // m.m. — harnessens etablerade initläge); TEST_MODE stängs av EFTER init,
  // före uppspelningen. Samma dans görs vid ctrl:'restart'.
  const savedTestMode = global.__TEST_MODE__;
  const savedNodeEnv = process.env.NODE_ENV;

  // ctrl:'restart' (2026-07-03) skapar en NY app-instans mitt i körningen —
  // notiser samlas över ALLA kortinstanser (mocken skapar nytt kort per app).
  const boatNearCards = [];

  // ---- Fånga bridge_text-övergångar via RIKTIGA publiceringsvägen ----
  const bridgeTextLog = [];
  let lastBridgeText = null;

  // ---- Fånga MÅLBRO-passager för journey-invarianten (2026-06-11) ----
  // INV-5 ("varje detekterad målbro-passage ⇒ minst en notis för den bron")
  // är den invariant som hade fångat AURANA-missen proaktivt. Passagerna
  // fångas ur appens egna loggrader (TARGET/FINAL_TARGET_PASSAGE_RECORDED).
  const targetPassages = [];
  const passageRe = /\[(?:FINAL_)?TARGET_PASSAGE_RECORDED\] (\d+): Recorded passage of (?:final )?target bridge (\S+)/;
  // Harness-fördjupning (2026-07-01): fånga även journey-resets (U-sväng/
  // NEW_JOURNEY/re-entry — legitimerar en ANDRA notis för samma mmsi:bro) och
  // mellanbro-registreringar (INV-13: en målbro som loggas som INTERMEDIATE
  // är en tyst degraderad målbropassage — osynlig för INV-5:s regex).
  const journeyResets = [];
  const journeyResetRe = /\[(?:JOURNEY_RESET|NEW_JOURNEY|REENTRY_NEW_JOURNEY)\] (\d+):/;
  const intermediatePassages = [];
  const intermediateRe = /\[INTERMEDIATE_PASSAGE_RECORDED\] (\d+): Recorded passage of intermediate bridge (\S+)/;

  // ---- Instrumentera en app-instans (körs igen efter ctrl:'restart') ----
  const instrumentApp = (instance) => {
    // KRITISKT: replayen ska spegla en ANSLUTEN drift. Utan detta är
    // stale-guarden armad från första samplet och _processUIUpdate skulle
    // override:a texten till "AIS saknas".
    instance._isConnected = true;
    instance._lastConnectionLost = null;
    instance._lastConnectionStatus = 'connected';
    boatNearCards.push(instance._boatNearTrigger);

    const origUpdateCap = instance._updateDeviceCapability.bind(instance);
    instance._updateDeviceCapability = (capability, value) => {
      if (capability === 'bridge_text' && value !== lastBridgeText) {
        const t = Date.now();
        bridgeTextLog.push({ t, iso: new Date(t).toISOString(), text: value });
        lastBridgeText = value;
      }
      return origUpdateCap(capability, value);
    };

    const origAppLog = instance.log.bind(instance);
    instance.log = (...args) => {
      const line = args.join(' ');
      const pm = line.match(passageRe);
      if (pm) {
        targetPassages.push({
          t: Date.now(), iso: new Date(Date.now()).toISOString(), mmsi: pm[1], bridge: pm[2],
        });
      }
      const jm = line.match(journeyResetRe);
      if (jm) {
        journeyResets.push({ t: Date.now(), iso: new Date(Date.now()).toISOString(), mmsi: jm[1] });
      }
      const im = line.match(intermediateRe);
      if (im) {
        intermediatePassages.push({
          t: Date.now(),
          iso: new Date(Date.now()).toISOString(),
          mmsi: im[1],
          bridge: im[2],
          // no-target-markören (2026-07-03): en mållös båts målbropassage är
          // korrekt intermediate-bokförd — INV-13 undantar dem.
          noTarget: line.includes('no-target'),
        });
      }
      return origAppLog(...args);
    };
  };

  await app.onInit();
  await drain();
  instrumentApp(app);

  // Init klar — nu släpps TEST_MODE så notiserna avfyras som i produktion.
  global.__TEST_MODE__ = undefined;
  process.env.NODE_ENV = 'production';

  // ---- Spela upp samples kronologiskt med fake-klockan ----
  let processErrors = 0;
  for (const s of samples) {
    // 1) Stega klockan fram till samplets tid → fyrar cleanup/STALE_AIS/
    //    protection/monitoring-timrar som förfaller i gapet (precis som drift).
    const gap = s.aisTimestamp - Date.now();
    if (gap > 0) clock.tick(gap);
    // eslint-disable-next-line no-await-in-loop
    await drain(); // flush microtasks/async-lyssnare från ev. timer-callbacks

    // 1b) Anslutningshändelser (2026-07-01): ctrl-samples simulerar avbrott/
    //     återanslutning mitt i korpusen — testar stale-guarden ("AIS-
    //     anslutning saknas"-overriden), alarm-släckning och reconnect-
    //     refreshen (P8) i helkedjan, vilket tidigare var OMÖJLIGT i replay
    //     (app._isConnected forcerades true en gång för hela körningen).
    if (s.ctrl === 'disconnect') {
      app._isConnected = false;
      app._lastConnectionLost = Date.now();
      app._lastConnectionStatus = 'disconnected';
      continue;
    }
    if (s.ctrl === 'reconnect') {
      app._isConnected = true;
      app._lastConnectionLost = null;
      app._lastConnectionStatus = 'connected';
      try {
        if (typeof app._onAISConnected === 'function') app._onAISConnected();
      } catch (e) { /* reconnect-refresh är best-effort i replay */ }
      // eslint-disable-next-line no-await-in-loop
      await drain();
      continue;
    }
    // ctrl:'restart' (2026-07-03, fas 7): ÄKTA processomstart mitt i replayen
    // — gamla instansen städas ned, en NY AISBridgeApp skapas mot SAMMA
    // settings-store (persistent 2h-dedup + namncache laddas om på riktigt).
    // Testar load/save-cykeln i helkedjan, vilket tidigare bara fanns på
    // enhetsnivå (p2-sviterna).
    if (s.ctrl === 'restart') {
      try {
        // eslint-disable-next-line no-await-in-loop
        await app.onUninit();
      } catch (e) { /* nedstängning är best-effort i replay */ }
      // eslint-disable-next-line no-await-in-loop
      await drain();
      // Samma initdans som vid start: onInit under __TEST_MODE__=true.
      global.__TEST_MODE__ = true;
      app = new AISBridgeApp();
      app.homey = mockHomey;
      // eslint-disable-next-line no-await-in-loop
      await app.onInit();
      // eslint-disable-next-line no-await-in-loop
      await drain();
      instrumentApp(app);
      global.__TEST_MODE__ = undefined;
      continue;
    }

    // 2) Mata in AIS-meddelandet vid denna (fejkade) tid.
    const aisMessage = {
      mmsi: String(s.mmsi),
      msgType: s.msgType || 'PositionReport',
      lat: s.lat,
      lon: s.lon,
      sog: s.sog,
      cog: s.cog,
      navStatus: s.navStatus, // syntetiska scenarier kan sätta den; korpusar saknar fältet → null
      shipName: s.shipName || 'Unknown',
      timestamp: s.aisTimestamp,
    };
    try {
      app._processAISMessage(aisMessage);
      // eslint-disable-next-line no-await-in-loop
      await drain();
      // Fyra ev. coalescing-timrar (grace-period setTimeout) som schemalagts av
      // denna update, och dränera deras lyssnare.
      clock.tick(60);
      // eslint-disable-next-line no-await-in-loop
      await drain();
      // eslint-disable-next-line no-await-in-loop
      await drain();
    } catch (e) {
      processErrors++;
      const t = Date.now();
      bridgeTextLog.push({ t, iso: new Date(t).toISOString(), text: `__PROCESS_ERROR__:${e.message}` });
    }
  }

  // ---- Slutstädning: stega fram klockan rejält så att kvarvarande
  //      cleanup-/grace-timrar löser ut (post-resa) och slut-texten fångas.
  clock.tick(40 * 60 * 1000); // +40 min
  await drain();
  await drain();

  // Återställ globala flaggor
  global.__TEST_MODE__ = savedTestMode;
  process.env.NODE_ENV = savedNodeEnv;

  // ---- Samla notiser (över ALLA app-instanser vid ctrl:'restart') ----
  const notifications = boatNearCards
    .flatMap((card) => (card && card.triggerCalls ? card.triggerCalls : []))
    .map((c) => ({
      // Harness-fördjupning (2026-07-01): tidsstämpeln (fake-klockan är
      // deterministisk) möjliggör tids-invarianter — notis-före-passage
      // (INV-7) och journey-reset-medveten dubbletthantering (INV-2).
      t: c.timestamp ? Date.parse(c.timestamp) : null,
      bridge: c.tokens && c.tokens.bridge_name,
      direction: c.tokens && c.tokens.direction,
      eta: c.tokens && c.tokens.eta_minutes,
      // Harness-fördjupning (2026-07-03): namn + distans + källa fångas för
      // invarianterna INV-8 (namnkvalitet) och INV-11 (distansrimlighet, där
      // source särskiljer inferens-/fallbacknotiser från proximity).
      name: c.tokens && c.tokens.vessel_name,
      distance: c.state && Number.isFinite(c.state.distance) ? c.state.distance : null,
      source: (c.state && c.state.source) || null,
      stateBridge: c.state && c.state.bridge,
      mmsi: c.state && c.state.mmsi,
      success: c.success,
      error: c.error || null,
    }));

  // ---- Berika notiser med fartygets position (2026-07-03) ----
  // Närmast föregående + nästa sample för samma mmsi (fake-klockan lägger
  // notis-t och aisTimestamp på samma tidslinje). Ger INV-11 (distans-
  // rimlighet) och INV-15 (riktning-vs-geografi) något att räkna på.
  const posByMmsi = new Map();
  for (const s of samples) {
    if (s.ctrl || typeof s.lat !== 'number') continue;
    const key = String(s.mmsi);
    if (!posByMmsi.has(key)) posByMmsi.set(key, []);
    posByMmsi.get(key).push(s);
  }
  for (const n of notifications) {
    let before = null;
    let after = null;
    if (Number.isFinite(n.t)) {
      for (const s of posByMmsi.get(String(n.mmsi)) || []) {
        if (s.aisTimestamp <= n.t) before = s;
        else {
          after = s; break;
        }
      }
    }
    n.vesselLat = before ? before.lat : null;
    n.vesselLon = before ? before.lon : null;
    n.vesselLatNext = after ? after.lat : null;
  }

  // Första tidpunkt per mmsi där ett riktigt namn (≠Unknown) förekom i
  // strömmen — INV-8 (namnkvalitet) jämför notisnamnen mot detta.
  const firstNameSeen = {};
  for (const s of samples) {
    if (s.ctrl) continue;
    const nm = (s.shipName || '').trim();
    if (nm && nm !== 'Unknown' && !(String(s.mmsi) in firstNameSeen)) {
      firstNameSeen[String(s.mmsi)] = s.aisTimestamp;
    }
  }

  // Återställ
  console.log = origLog;

  // ---- Läckagediagnostik (soak-kontroll, tillagd 2026-06-09) ----
  // Efter hela korpusen + 40 min efterspel ska alla per-fartygs-strukturer
  // vara (nära) tomma. Växande värden här = långtidsläcka i 24/7-drift.
  // Undantag by design: _persistentRecentTriggers håller poster i 2h (dedupe).
  const vds = app.vesselDataService || {};
  const sizeOf = (x) => (x && typeof x.size === 'number' ? x.size : null);
  const leakDiagnostics = {
    vessels: sizeOf(vds.vessels),
    bridgeVesselAssociations: vds.bridgeVessels
      ? [...vds.bridgeVessels.values()].reduce((s, set) => s + set.size, 0)
      : null,
    cleanupTimers: sizeOf(vds.cleanupTimers),
    protectionTimers: sizeOf(vds.protectionTimers),
    targetBridgeProtection: sizeOf(vds.targetBridgeProtection),
    processedPassages: sizeOf(vds.processedPassages),
    passageCleanupTimers: sizeOf(vds._passageCleanupTimers),
    passageDetectionCache: sizeOf(vds._passageDetectionCache),
    logDebounce: sizeOf(vds._logDebounce),
    logRepeatCount: sizeOf(vds._logRepeatCount),
    triggeredBoatNearKeys: sizeOf(app._triggeredBoatNearKeys),
    persistentRecentTriggers: sizeOf(app._persistentRecentTriggers),
    vesselRemovalTimers: sizeOf(app._vesselRemovalTimers),
    processingRemoval: sizeOf(app._processingRemoval),
    gpsGateGatedVessels: app.gpsJumpGateService
      ? sizeOf(app.gpsJumpGateService._gatedVessels) : null,
    gpsGateCandidates: app.gpsJumpGateService
      ? sizeOf(app.gpsJumpGateService._candidatePassages) : null,
    passageLatches: app.passageLatchService
      ? sizeOf(app.passageLatchService._passageLatches) : null,
    routeOrderHistory: app.routeOrderValidator
      ? sizeOf(app.routeOrderValidator._vesselPassageHistory) : null,
    statusStabilizerHistory: app.statusService && app.statusService.statusStabilizer
      ? sizeOf(app.statusService.statusStabilizer.statusHistory) : null,
    heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  };

  const result = {
    jsonl: path.basename(jsonlPath),
    mmsiFilter,
    sampleCount: samples.length,
    vessels: [...new Set(samples.map((s) => `${s.mmsi}:${s.shipName}`))],
    processErrors,
    bridgeTextTransitions: bridgeTextLog,
    notifications,
    notificationCount: notifications.length,
    firstNameSeen,
    firstSampleMs: samples.length > 0 ? samples[0].aisTimestamp : null,
    targetPassages,
    journeyResets,
    intermediatePassages,
    leakDiagnostics,
  };

  process.stdout.write(`__REPLAY_JSON__${JSON.stringify(result)}__END__\n`);

  // Städa ned appen och tvinga avslut.
  try {
    await app.onUninit();
  } catch (_) { /* ignore */ }
  clock.uninstall();
  process.exit(0);
}

main().catch((e) => {
  process.stdout.write(`__REPLAY_JSON__${JSON.stringify({ fatal: e.message, stack: e.stack })}__END__\n`);
  process.exit(1);
});
