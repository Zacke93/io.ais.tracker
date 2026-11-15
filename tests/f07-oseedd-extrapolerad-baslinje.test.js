'use strict';

jest.mock('homey');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES } = require('../lib/constants');
const corpora = require('./replay-validation/corpora');
const { validateInvariants } = require('./replay-validation/invariants');

/**
 * F07 (buggjägarens kort F03, standardkörningen 2026-11-14; ETA-etappen under
 * ägarbeslutet U28): en extrapolerad baslinje som aldrig visades försvaras
 * inte mot en lägre färsk beräkning.
 *
 * 20260708-21h, fasvarianten δ −11,52 s (buggjägarens M-FAS): AVALON
 * (219009353) mätte 30,3 min på sitt första fix medan JAATTEN II ledde
 * Klaffbrongruppen. Fix G räknade ned det osedda värdet till 25,3 och
 * registrerade det som publicerad baslinje; hennes färska 13,4 och 11,9 min
 * klampades till 18,9. När JAATTEN:s position blev 600 s gammal tog AVALON
 * över texten: "om cirka 13" → "om 19 minuter" (INV-3 ETA-SÅGTAND UPP), mot
 * sanningen 4,5 min. Se app.js _reconcilePublishedETA och _anotherLeadsTarget.
 */
const ROOT = path.resolve(__dirname, '..');

describe('F07: klampen och en extrapolerad baslinje (enhet)', () => {
  let app;
  let now;
  let others;

  beforeEach(() => {
    now = Date.parse('2026-07-08T07:07:02.344Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    app = new AISBridgeApp();
    app.debug = jest.fn();
    app.bridgeRegistry = new BridgeRegistry();
    others = [];
    app.vesselDataService = { getVesselsForBridgeText: () => others };
  });

  afterEach(() => jest.restoreAllMocks());

  // Den bakre båten: Fix G har just registrerat sin extrapolering (25,3) som
  // publicerad baslinje, 1,2 km söder om Klaffbron.
  function rear(overrides = {}) {
    return {
      mmsi: '219009353',
      targetBridge: 'Klaffbron',
      lat: BRIDGES.klaffbron.lat - 0.011,
      lon: BRIDGES.klaffbron.lon,
      timestamp: now,
      lastPositionUpdate: now,
      etaMinutes: 25.26,
      _etaIsExtrapolated: true,
      _etaPublishTarget: 'Klaffbron',
      _etaPublishedValue: 25.26,
      _etaPublishedAtMs: now - 2300,
      ...overrides,
    };
  }

  function other(overrides = {}) {
    return {
      mmsi: '257919970',
      targetBridge: 'Klaffbron',
      lat: BRIDGES.klaffbron.lat - 0.008,
      lon: BRIDGES.klaffbron.lon,
      timestamp: now - 350000,
      lastPositionUpdate: now - 350000,
      etaMinutes: 17.0,
      _etaIsExtrapolated: true,
      ...overrides,
    };
  }

  test('en annan båt ledde gruppen: den osedda extrapoleringen släpps, färska värdet publiceras', () => {
    others = [other()];
    const v = rear();
    expect(app._reconcilePublishedETA(v, 13.39)).toBe(13.39);
    expect(v._etaPublishedValue).toBe(13.39);
    // Samma fix i nästa pass (snapshot-vägen) håller sig till det färska.
    expect(app._reconcilePublishedETA(v, 11.94)).toBe(11.94);
  });

  test.each([
    ['ensam båt (hennes extrapolering var gruppens klausul)', () => []],
    ['hon själv ledde (den andra hade högre ETA)', () => [other({ etaMinutes: 30 })]],
    ['den andra är en zombie (målbron redan passerad)', () => [other({ passedBridges: ['Klaffbron'] })]],
    ['den andra har en annan målbro', () => [other({ targetBridge: 'Stridsbergsbron' })]],
    ['den andra saknar giltig ETA', () => [other({ etaMinutes: null })]],
  ])('%s: baslinjen försvaras som förut', (_label, make) => {
    others = make();
    const v = rear();
    const out = app._reconcilePublishedETA(v, 13.39);
    // maxDelta = max(3, glapp + 0,25 · 25,26) ≈ 6,35 ⇒ 18,9
    expect(out).toBeGreaterThan(18.5);
    expect(out).toBeLessThan(19.5);
  });

  test('bara nedåt: en högre färsk beräkning dämpas som förut', () => {
    others = [other({ etaMinutes: 10 })];
    const v = rear();
    const out = app._reconcilePublishedETA(v, 40);
    expect(out).toBeLessThan(32.5);
    expect(out).toBeGreaterThan(31);
  });

  test('en uppmätt (inte extrapolerad) baslinje försvaras som förut', () => {
    others = [other()];
    const v = rear({ _etaIsExtrapolated: false });
    const out = app._reconcilePublishedETA(v, 13.39);
    expect(out).toBeGreaterThan(18.5);
  });
});

/**
 * Hela kedjan genom appen: korpusen flyttas δ (aisTimestamp, fixTs och
 * receivedAt typbevarande), precis som buggjägarens M-FAS. Korpusen saknar
 * starttillstånd. Varianten −11,52 s är bitlik med kortet F03:s variant.jsonl.
 */
describe('F07: 20260708-21h i fasvarianten δ −11,52 s', () => {
  const corpus = corpora.find((c) => c.id === '20260708-21h');
  let dir;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f07-21h-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeVariant = (deltaS) => {
    const d = Math.round(deltaS * 1000);
    const rows = fs.readFileSync(corpus.jsonl, 'utf8').trim().split('\n').map((l) => {
      const r = JSON.parse(l);
      if (Number.isFinite(r.aisTimestamp)) r.aisTimestamp += d;
      if (Number.isFinite(r.fixTs)) r.fixTs += d;
      if (typeof r.receivedAt === 'string' && Number.isFinite(Date.parse(r.receivedAt))) {
        r.receivedAt = new Date(Date.parse(r.receivedAt) + d).toISOString();
      }
      return JSON.stringify(r);
    });
    const jsonl = path.join(dir, `fas${deltaS}.jsonl`);
    fs.writeFileSync(jsonl, `${rows.join('\n')}\n`);
    return jsonl;
  };

  const replay = (jsonl) => new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'tests/replay-validation/replayRunner.js'), jsonl], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '', REPLAY_MONITORING: '',
      },
    }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(JSON.parse(stdout.match(/__REPLAY_JSON__(.*?)__END__/s)[1]));
    });
  });

  test('AVALON visas aldrig med den klampade gissningen, och INV-3 håller', async () => {
    const result = await replay(writeVariant(-11.52));
    const from = Date.parse('2026-07-08T07:06:00Z');
    const to = Date.parse('2026-07-08T07:13:00Z');
    const klaff = result.bridgeTextTransitions
      .filter((t) => t.t >= from && t.t <= to)
      .map((t) => (t.text.match(/på väg mot Klaffbron, beräknad broöppning (om (?:cirka )?\d+ minuter|strax)/) || [])[1])
      .filter(Boolean);
    expect(klaff.length).toBeGreaterThan(0);
    // 7eb350d: "om 19 minuter" 07:11:30. Nu "om 12" från 07:07 (färska 11,9).
    expect(klaff).not.toContain('om 19 minuter');
    expect(klaff).not.toContain('om 18 minuter');
    expect(klaff).toContain('om 12 minuter');
    const sawtooth = validateInvariants(result).filter((v) => /ETA-SÅGTAND UPP: 2026-07-08T07:1\d:\S+ Klaffbron/.test(v));
    expect(sawtooth).toEqual([]);
  }, 120000);
});
