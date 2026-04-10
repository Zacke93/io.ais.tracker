'use strict';

const fs = require('fs');
const path = require('path');
const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');

const file = path.join(__dirname, '..', '..', 'logs', 'ais-replay-20251214-214351.jsonl');
const DEFAULT_MSG = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const samples = lines.map((l) => {
  const m = l.match(/\[AIS_REPLAY_SAMPLE\]\s+({.*})/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}).filter((s) => s && Number.isFinite(s.aisTimestamp)).sort((a, b) => a.aisTimestamp - b.aisTimestamp);

(async () => {
  const runner = new RealAppTestRunner();
  runner.setWaitMultiplier(0.1);
  runner.logLevel = 'silent';
  await runner.initializeApp();

  const svc = runner.app.bridgeTextService;
  svc._recentUnderBridgeAnnouncements?.clear?.();
  svc.lastPassedMessage = null;
  svc.lastPassedMessageTime = 0;
  svc.lastBridgeText = '';
  svc.lastBridgeTextTime = 0;
  svc.lastNonDefaultText = '';
  svc.lastNonDefaultTextTime = 0;
  if (typeof svc.resetPhaseTracking === 'function') svc.resetPhaseTracking();
  const existing = runner.app.vesselDataService.getAllVessels();
  existing.forEach((v) => runner.app.vesselDataService.removeVessel(v.mmsi, 'reset'));
  runner.bridgeTextHistory = [];
  runner.lastBridgeText = DEFAULT_MSG;
  runner.stepNumber = 0;

  let idx = 0;
  let lastText = DEFAULT_MSG;
  const realNow = Date.now;

  for (const sample of samples) {
    runner.stepNumber++;
    Date.now = () => sample.aisTimestamp;
    try {
      await runner._processVesselAsAISMessage({
        mmsi: sample.mmsi,
        name: sample.shipName || `V_${sample.mmsi}`,
        lat: sample.lat,
        lon: sample.lon,
        sog: sample.sog,
        cog: sample.cog,
        timestamp: sample.aisTimestamp,
      });
      const t = runner.getCurrentBridgeText();
      if (t && t !== lastText) {
        idx++;
        const ts = new Date(sample.aisTimestamp).toLocaleTimeString('sv-SE');
        console.log(`${idx}. [${ts}] ${t}`);
        lastText = t;
      }
    } catch (e) {
      // skip
    }
  }
  Date.now = realNow;
  await runner.cleanup();
  process.exit(0);
})();
