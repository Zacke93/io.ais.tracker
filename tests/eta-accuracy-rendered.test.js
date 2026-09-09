'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const M = require('./replay-validation/measureEtaAccuracy');
const BridgeTextService = require('../lib/services/BridgeTextService');
const corpora = require('./replay-validation/corpora');

const ROOT = path.join(__dirname, '..');
const EUGENIE = '265788210';
const ANTJE = '211347380';
const T = Date.parse('2026-08-05T08:00:23.583Z');
const TARGET = 'Stridsbergsbron';

describe('ETA-mätaren läser textmotorns verkliga val utan omräkning', () => {
  let restore;
  let captures;
  let service;

  beforeEach(() => {
    captures = [];
    jest.spyOn(Date, 'now').mockReturnValue(T);
    restore = M.installBridgeTextCapture(BridgeTextService, (r) => captures.push(r));
    service = new BridgeTextService(null, null);
  });

  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });

  const vessel = (mmsi, eta, extra = {}) => ({
    mmsi, targetBridge: TARGET, etaMinutes: eta, timestamp: T, ...extra,
  });
  const attribute = (text, rows = captures, t = T) => M.attributeRenderedClaim(
    rows, { text, t }, M.parseBridgeTextClaims(text)[0],
  );

  test('extrapolerade EUGENIE bär sjuan före färska ANTJE och objekten förblir orörda', () => {
    const vessels = [
      vessel(ANTJE, 15.1341838316),
      vessel(EUGENIE, 7.46082670035, { _etaIsExtrapolated: true, timestamp: T - 549000 }),
    ];
    const before = JSON.parse(JSON.stringify(vessels));
    const text = service.generateBridgeText(vessels);
    expect(text).toContain('om cirka 7 minuter');
    expect(attribute(text)).toMatchObject({
      mmsi: EUGENIE, confidence: 'renderad-ledare', candidates: 2, eta: 7.46082670035,
    });
    expect(captures).toHaveLength(1);
    expect(vessels).toEqual(before);
  });

  test('lika ETA följer textmotorns verkliga ordning, inte en ny MMSI-sortering', () => {
    const text = service.generateBridgeText([vessel('999', 5), vessel('111', 5)]);
    expect(attribute(text).mmsi).toBe('999');
  });

  test('en redan passerad båt räknas men kan inte bli minutfrasens ledare', () => {
    const text = service.generateBridgeText([
      vessel('111', 1, { passedBridges: [TARGET] }), vessel('222', 5),
    ]);
    expect(attribute(text)).toMatchObject({ mmsi: '222', eta: 5, candidates: 2 });
  });

  test('en verklig väntkö ingår inte i den rörliga gruppens ETA-val', () => {
    const queue = vessel('333', 1, {
      lat: 58.290535,
      lon: 12.2909967,
      sog: 0,
      _routeDirection: 'north',
      _stationarySince: T - 3 * 3600000,
      _stillnessAnchor: { lat: 58.290535, lon: 12.2909967, t: T - 3 * 3600000 },
      _bridgeQueueApproaches: { Järnvägsbron: { confirmedAt: T - 3 * 3600000, direction: 'north' } },
    });
    const text = service.generateBridgeText([queue, vessel('111', 8), vessel('222', 5)]);
    expect(text).toContain('En båt väntar vid Järnvägsbron');
    expect(text).toContain('Två båtar på väg mot Stridsbergsbron');
    expect(attribute(text)).toMatchObject({ mmsi: '222', eta: 5, candidates: 2 });
    expect(captures[0].groups[0].members).toEqual(['111', '222']);
  });

  test('gruppdominant strax tillskrivs inte fel båt med lägsta ETA', () => {
    const text = service.generateBridgeText([
      vessel('111', 5), vessel('222', 8, { _isImminentAtTargetBridge: true }),
    ]);
    expect(text).toContain('broöppning strax');
    expect(attribute(text)).toMatchObject({ mmsi: null, confidence: 'renderad-gruppdominans' });
  });

  test('en ensam nära båt och strax från numerisk ETA har entydig proveniens', () => {
    const lone = service.generateBridgeText([vessel('111', null, { _isImminentAtTargetBridge: true })]);
    expect(attribute(lone).mmsi).toBe('111');
    const numeric = service.generateBridgeText([vessel('111', 2), vessel('222', 5)]);
    expect(attribute(numeric).mmsi).toBe('111');
  });

  test('ett övergivet renderingsförslag och en äldre lika text är inte publiceringsbevis', () => {
    const text = service.generateBridgeText([vessel('111', 5)]);
    expect(attribute(text, captures, T + 1)).toMatchObject({ mmsi: null, confidence: 'rendering-saknas' });
    expect(attribute(text.replace('5 minuter', '6 minuter')))
      .toMatchObject({ mmsi: null, confidence: 'rendering-saknas' });
  });

  test('olika ledare bakom samma text och tid hålls uttryckligen tvetydiga', () => {
    const text = service.generateBridgeText([vessel('111', 5)]);
    service.generateBridgeText([vessel('222', 5)]);
    expect(attribute(text)).toMatchObject({ mmsi: null, confidence: 'rendering-tvetydig' });
  });

  test('två lika renderingsanrop ger samma bevis och ingen dubbel mätning', () => {
    const text = service.generateBridgeText([vessel('111', 5)]);
    service.generateBridgeText([vessel('111', 5)]);
    expect(attribute(text)).toMatchObject({ mmsi: '111', confidence: 'renderad-ledare' });
  });

  test('saknade medlemmar eller fel antal i beviset får ingen gissad ledare', () => {
    const text = service.generateBridgeText([vessel('111', 5)]);
    for (const members of [null, [], ['111', '222']]) {
      const broken = [{ ...captures[0], groups: [{ ...captures[0].groups[0], members }] }];
      expect(attribute(text, broken)).toMatchObject({ mmsi: null, confidence: 'rendering-saknas' });
    }
  });

  test('brogruppernas ledare hålls åtskilda inom samma publicerade text', () => {
    const text = service.generateBridgeText([
      vessel('111', 5), vessel('222', 8, { targetBridge: 'Klaffbron' }),
    ]);
    const claims = M.parseBridgeTextClaims(text);
    expect(claims.map((p) => M.attributeRenderedClaim(captures, { text, t: T }, p).mmsi))
      .toEqual(['222', '111']);
  });

  test('renderingspostens egen klocka används även utan stderr-stämpel', () => {
    service.generateBridgeText([vessel('111', 5)]);
    const collector = M.makeStderrCollector();
    collector.line('[ETA_MEASURE_CAPTURE_READY]');
    collector.line(`[ETA_MEASURE_RENDER] ${JSON.stringify(captures[0])}`);
    expect(collector.result()).toMatchObject({ renderCapture: true, renderings: captures });
  });

  test('en kastande mätmottagare ändrar inte appens text eller fortsatta anrop', () => {
    restore();
    restore = M.installBridgeTextCapture(BridgeTextService, () => {
      throw new Error('mätfel');
    });
    expect(service.generateBridgeText([vessel('111', 5)])).toContain('om 5 minuter');
    expect(service.generateBridgeText([vessel('111', 8)])).toContain('om 8 minuter');
  });
});

// Hela fältet och oförändrat replayresultat är den oberoende kontrollen:
// mätfångsten får varken byta ledare, lägga till timerpass eller ändra text.
describe('Verkliga EUGENIE/ANTJE-fältet attribueras till rätt publicerande båt', () => {
  let plain;
  let measured;
  let claims;
  let legacyClaims;
  const job = corpora.find((c) => c.id === '20260804-both-21h');

  beforeAll(() => {
    const runner = path.join(ROOT, 'tests/replay-validation/replayRunner.js');
    const preload = path.join(ROOT, 'tests/replay-validation/measureEtaAccuracy.js');
    const run = (capture) => {
      const child = spawnSync(process.execPath, [
        ...(capture ? ['--require', preload] : []), runner, job.jsonl,
      ], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 25000,
        maxBuffer: 96 * 1024 * 1024,
        env: {
          ...process.env,
          ETA_MEASURE_STAMP: capture ? '1' : '0',
          ETA_MEASURE_CAPTURE: capture ? '1' : '0',
          REPLAY_MONITORING: '0',
          REPLAY_FUSION: '0',
          REPLAY_VERBOSE: capture ? '1' : '',
          REPLAY_DEBUG_LEVEL: capture ? 'full' : 'off',
        },
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      const replay = JSON.parse(child.stdout.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
      const collector = M.makeStderrCollector();
      for (const line of child.stderr.split('\n')) collector.line(line);
      return { replay, debug: collector.result() };
    };
    plain = run(false);
    measured = run(true);
    const passages = JSON.parse(fs.readFileSync(path.join(
      ROOT, 'tests/replay-validation/gt-passages', `${job.id}.json`,
    ), 'utf8'));
    const index = new Map();
    for (const passage of passages) {
      const key = `${passage.mmsi}|${passage.bridge}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(passage);
    }
    for (const rows of index.values()) rows.sort((a, b) => a.t - b.t);
    claims = M.collectClaims(job, measured, { index }).claims;
    legacyClaims = M.collectClaims(job, {
      ...measured, debug: { ...measured.debug, renderCapture: false },
    }, { index }).claims;
  }, 60000);

  test('alla deterministiska replayfält är exakt lika med och utan mätfångsten', () => {
    // Processens heap beror på GC och diagnostikmängd även mellan två vanliga
    // körningar. Endast detta icke-deterministiska mätvärde tas bort.
    const comparable = (replay) => {
      const copy = JSON.parse(JSON.stringify(replay));
      delete copy.leakDiagnostics.heapUsedMB;
      return copy;
    };
    expect(comparable(measured.replay)).toEqual(comparable(plain.replay));
    expect(measured.replay.processErrors).toBe(0);
    expect(measured.replay.runtimeDiagnostics.timersAfterShutdown).toBe(0);
  });

  test('den historiska gissningen väljer ANTJE men verkliga sjuan bärs av EUGENIE', () => {
    const find = (rows) => rows.find((c) => c.kind === 'brotext' && c.t === T && c.bridge === TARGET);
    expect(find(legacyClaims)).toMatchObject({
      published: 7, mmsi: ANTJE, attribution: 'grupp-ledare', leadEta: 15.3,
    });
    expect(find(claims)).toMatchObject({
      published: 7, mmsi: EUGENIE, attribution: 'renderad-ledare', leadEta: 7.46, approx: true,
    });
    const replacement = claims.find((c) => c.kind === 'brotext'
      && c.t === Date.parse('2026-08-05T08:01:30.040Z') && c.bridge === TARGET);
    expect(replacement).toMatchObject({
      published: 15, mmsi: ANTJE, attribution: 'renderad-ledare', leadEta: 15.13, approx: false,
    });
    expect(find(claims).truth).not.toBe(find(legacyClaims).truth);
  });

  test('alla numeriska textpåståenden i fältet har direkt renderingsbevis', () => {
    const texts = claims.filter((c) => c.kind === 'brotext');
    expect(texts.length).toBeGreaterThan(300);
    expect(new Set(texts.map((c) => c.attribution))).toEqual(new Set(['renderad-ledare']));
  });

  test('saknad fångst vid publicering får ingen gissad sanning', () => {
    const missing = M.collectClaims(job, {
      replay: { bridgeTextTransitions: measured.replay.bridgeTextTransitions.filter((tr) => tr.t === T) },
      debug: { ...measured.debug, renderings: [] },
    }, { index: new Map() }).claims;
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ mmsi: null, attribution: 'rendering-saknas', status: 'oattribuerad' });
  });
});
