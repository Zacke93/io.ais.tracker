'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const GPSJumpGateService = require('../lib/services/GPSJumpGateService');

/**
 * F12/F16 (rättningskampanjen 2026-11-04): GPS-grindens dubbelbokföring.
 *
 * JOLLY (klass B, värld 254 i buggjägarens standardkörning) korsar
 * Stridsbergsbron söderut 16:01:52 under ett 9 minuters glapp och ligger
 * sedan i kö 126 m söder om bron. Fixen 16:03:34 är GPS-osäker, så grinden
 * registrerar en kandidat för bron. I samma tick bokför glappvägen passagen
 * (GAP_TARGET_INFERRED, målet flyttas till Klaffbron). Kandidaten släpptes
 * aldrig: 795 s senare bekräftades den och bokförde Stridsbergsbron en gång
 * till, nu som mellanbro (INV-13 och T10 FANTOMPASSAGE). Rättningen släpper
 * den bokförda brons kandidat vid bokföringen; andra broars kandidater ligger
 * kvar.
 */
const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'r2-jolly-grindkandidat.jsonl');
const JOLLY = '265841261';

function replay(jsonl) {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tests/replay-validation/replayRunner.js'), jsonl], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '', REPLAY_MONITORING: '',
    },
  });
  return JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
}

describe('GPS-grinden släpper en bokförd bros kandidat', () => {
  const logger = { debug: jest.fn(), log: jest.fn(), error: jest.fn() };
  const vessel = (extra = {}) => ({
    mmsi: JOLLY, lat: 58.2926, lon: 12.2934, sog: 0, cog: 184.5, timestamp: Date.now(), ...extra,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-22T16:03:34.941Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('bara den bokförda bron släpps, och den bekräftas aldrig senare', () => {
    const gate = new GPSJumpGateService(logger, null);
    gate.registerCandidatePassage(JOLLY, 'Stridsbergsbron', { passed: true }, vessel());
    gate.registerCandidatePassage(JOLLY, 'Järnvägsbron', { passed: true }, vessel());

    expect(gate.releaseCandidate(JOLLY, 'Stridsbergsbron')).toBe(true);
    expect(gate.releaseCandidate(JOLLY, 'Stridsbergsbron')).toBe(false);
    expect(gate.releaseCandidate('000000000', 'Järnvägsbron')).toBe(false);

    jest.advanceTimersByTime(795 * 1000);
    const confirmed = gate.confirmStableCandidates(JOLLY, vessel({ timestamp: Date.now() }));
    expect(confirmed.map((c) => c.bridgeName)).toEqual(['Järnvägsbron']);
    gate.destroy();
  });

  /**
   * Varje bokföringsväg som lägger bron i passedBridges släpper sin bros
   * kandidat (granskningen 2026-11-04: bara målbrotransitionen var låst, av
   * JOLLY nedan). En kandidat för en annan bro ligger kvar och bekräftas, så
   * testet visar också att den bokförda brons kandidat annars hade bekräftats.
   */
  describe('varje bokföringsväg släpper sin bros kandidat', () => {
    const MMSI = '265000001';
    const { BRIDGES } = require('../lib/constants');
    const VesselDataService = require('../lib/services/VesselDataService');
    const BridgeRegistry = require('../lib/models/BridgeRegistry');
    const SystemCoordinator = require('../lib/services/SystemCoordinator');
    const mToDeg = (m) => m / 111320;
    const fix = (bridge, northM, t, extra) => ({
      mmsi: MMSI,
      lat: bridge.lat + mToDeg(northM),
      lon: bridge.lon + mToDeg(northM * 0.6),
      sog: 5.5,
      _rawPositionSog: 5.5,
      cog: 200,
      timestamp: t,
      fixTs: t,
      lastPositionUpdate: t,
      fixFeed: 'aisstream',
      passedBridges: [],
      passedAt: {},
      _routeDirection: 'south',
      _hasMovementProof: true,
      ...extra,
    });
    let svc;
    let gate;

    beforeEach(() => {
      global.__TEST_MODE__ = true;
      svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
      gate = new GPSJumpGateService(logger, null);
      svc.app = {
        gpsJumpGateService: gate, passageLatchService: null, routeOrderValidator: null,
      };
    });

    afterEach(() => {
      svc.clearAllTimers();
      gate.destroy();
    });

    test.each([
      ['målbropassagen i _hasPassedTargetBridge', BRIDGES.klaffbron, 'Klaffbron', (v, old) => {
        expect(svc._hasPassedTargetBridge(v, old)).toBe(true);
      }],
      ['den grindbekräftade mellanbron (registerConfirmedIntermediatePassage)', BRIDGES.jarnvagsbron, null, (v, old) => {
        svc.registerConfirmedIntermediatePassage(v, old, 'Järnvägsbron', Date.now());
      }],
      ['den ordinarie mellanbropassagen (_handleIntermediateBridgePassage)', BRIDGES.jarnvagsbron, 'Klaffbron', (v, old) => {
        svc._handleIntermediateBridgePassage(v, old);
      }],
    ])('%s', (_label, bridge, targetBridge, book) => {
      const t = Date.now();
      const atBridge = fix(bridge, 0, t);
      gate.registerCandidatePassage(MMSI, bridge.name, { passed: true }, atBridge);
      gate.registerCandidatePassage(MMSI, 'Olidebron', { passed: true }, atBridge);
      const old = fix(bridge, 60, t - 30000, { targetBridge });
      const v = fix(bridge, -70, t, { targetBridge });

      book(v, old);

      expect(v.passedBridges).toContain(bridge.name);
      jest.advanceTimersByTime(60 * 1000);
      const confirmed = gate.confirmStableCandidates(MMSI, { ...atBridge, timestamp: Date.now() });
      expect(confirmed.map((c) => c.bridgeName)).toEqual(['Olidebron']);
    });
  });

  test('JOLLY: Stridsbergsbron bokförs en gång, som målbro', () => {
    const result = replay(FIXTURE);
    const target = result.targetPassages.filter((p) => p.mmsi === JOLLY && p.bridge === 'Stridsbergsbron');
    const intermediate = result.intermediatePassages
      .filter((p) => p.mmsi === JOLLY && p.bridge === 'Stridsbergsbron');
    expect(target.map((p) => p.iso)).toEqual(['2026-07-22T16:03:34.941Z']);
    // Före rättningen: en andra bokföring 16:16:49.875 (gate-confirmed).
    expect(intermediate).toEqual([]);
    // Övriga passager står kvar; Järnvägsbron bokförs när kön släpper.
    expect(result.intermediatePassages.filter((p) => p.mmsi === JOLLY).map((p) => [p.bridge, p.iso]))
      .toEqual([
        ['Stallbackabron', '2026-07-22T15:52:25.060Z'],
        ['Järnvägsbron', '2026-07-22T16:25:04.468Z'],
      ]);
  }, 60000);
});
