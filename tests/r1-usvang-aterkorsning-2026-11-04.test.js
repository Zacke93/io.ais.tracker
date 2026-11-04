'use strict';

/**
 * R1 (rättningskampanjen 2026-11-04): riktning och vändning.
 *
 * (1) U-SVÄNGENS ÅTERKORSNING BOKFÖRS ALDRIG (buggjägarens F10, W750 och
 * U-svängsreturerna i F01). Fix D:s 2-fixdebounce (Anomali 18) bekräftar
 * vändningen ofta först på fixen BORTOM den bro båten just korsat tillbaka.
 * N1-resetten i _confirmDirectionReversal räknade "framför" från det läget,
 * så den nyss återkorsade bron låg kvar i passedBridges. Samma tick hade då
 * redan låst om _routeDirection, och RE_CROSS_EVIDENCED i
 * _handleIntermediateBridgePassage (som annars bokför en återkorsning) såg
 * ingen motsatt riktning. Ingen väg bokförde passagen. Rättningen: Fix D-
 * och positionsbevisgrenarna skickar bekräftelsesegmentet till resetten, och
 * en bro som segmentet korsar i den nya riktningen släpps som en bro framför.
 * Korsningsbevisvägarna (AKIRA) behåller sin bro som förut.
 *
 * Granskningen 2026-11-04 (medel): en LÅNGSAM återkorsning mellan Fix D:s
 * väntande fix och bekräftelsen bokfördes fortfarande aldrig. Fixet som
 * avslutar korsningssegmentet ligger under 2 kn, så Fix D och fartkravet i
 * RE_CROSS_EVIDENCED hoppade över ticken, och bekräftelsesegmentet innehöll
 * inte bron. Omgranskningen 2026-11-04 (medel) visade att den första regeln
 * ("en färsk väntan och 100 m räcker") vände en VÄNTANDE båt på ett enda
 * GPS-sprang. Regeln kräver nu att väntan sattes på segmentets startfix, att
 * korsningsfixet självt går i minst 1 kn, att segmentet är minst 100 m och
 * att segmentets nettofart når 2 kn (VesselDataService._slowReCrossEvidence).
 *
 * (2) SVEPETS RIKTNINGSLÅS OMPRÖVAS ALDRIG (F15, IRMA). En återfödd båt utan
 * ruttlås fick svepets nettoriktning som lås, även när hon vänt i glappet och
 * den rörelsebevisade levande kursen sa motsatsen. Låset bär nu svepets egna
 * notiser (glappassagen gick åt svepets håll) och släpps efter svepet.
 *
 * Fixturerna är buggjägarens minsta repro (r1-standard-a): F10 (värld 353),
 * F10/r2 (värld 1731, monitoring) och F15 (värld 451, monitoring), samt
 * granskarens varianter av dem (se respektive test).
 */

jest.mock('homey');

const path = require('path');
const { execFileSync } = require('child_process');
const { __mockHomey: mockHomey } = require('homey');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const AISBridgeApp = require('../app');
const { BRIDGES, FIX_D_PENDING_MAX_AGE_MS } = require('../lib/constants');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const KLAFF = BRIDGES.klaffbron;
const northOf = (bridge, metres) => ({ lat: bridge.lat + metres / 111320, lon: bridge.lon });

const logger = {
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
};
const liveServices = [];

function makeVDS() {
  const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  svc.app = {
    gpsJumpGateService: null, passageLatchService: null, routeOrderValidator: null, debug: jest.fn(), log: jest.fn(), error: jest.fn(),
  };
  liveServices.push(svc);
  return svc;
}

function replay(fixture, { monitoring = false } = {}) {
  const env = { ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '' };
  if (monitoring) env.REPLAY_MONITORING = '1';
  else delete env.REPLAY_MONITORING;
  const out = execFileSync(process.execPath, [
    path.join(ROOT, 'tests/replay-validation/replayRunner.js'), path.join(FIXTURES, fixture),
  ], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
  });
  return JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
}

const passagesOf = (result, mmsi) => [
  ...result.targetPassages.map((p) => ({ ...p, slag: 'target' })),
  ...result.intermediatePassages.map((p) => ({ ...p, slag: 'intermediate' })),
].filter((p) => p.mmsi === mmsi).sort((a, b) => a.t - b.t);

describe('N1-resetten släpper en bro som bekräftelsesegmentet korsade i nya riktningen', () => {
  beforeAll(() => {
    global.__TEST_MODE__ = true;
  });
  afterAll(() => {
    delete global.__TEST_MODE__;
  });
  afterEach(() => {
    while (liveServices.length > 0) {
      try {
        liveServices.pop().clearAllTimers();
      } catch (_) { /* tomt */ }
    }
    jest.clearAllMocks();
  });

  // HAVSORN-geometrin: utresan norrut bokförde Olidebron och Klaffbron; den
  // väntande fixen ligger 400 m norr om Klaffbron, bekräftelsefixen 500 m söder.
  const reversedVessel = () => ({
    mmsi: '265196010',
    ...northOf(KLAFF, -500),
    sog: 5.1,
    cog: 192,
    targetBridge: 'Stridsbergsbron',
    passedBridges: ['Olidebron', 'Klaffbron'],
    _routeDirection: 'north',
  });
  const pendingFix = (vessel) => ({ ...vessel, ...northOf(KLAFF, 400), cog: 228 });

  test('Fix D-segmentet över Klaffbron: Klaffbron släpps tillsammans med bron framför', () => {
    const svc = makeVDS();
    const vessel = reversedVessel();
    const resetSpy = jest.fn();
    svc.on('vessel:journey-reset', resetSpy);

    svc._confirmDirectionReversal(vessel, 'south', 'dist=1733m > 500', {
      reCrossSegmentStart: pendingFix(vessel),
    });

    expect(vessel.passedBridges).toEqual([]);
    expect(resetSpy).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'south', bridges: ['Olidebron', 'Klaffbron'],
    }));
  });

  test('utan segment (korsningsbevisvägarna) behålls bron bakom, som förut', () => {
    const svc = makeVDS();
    const vessel = reversedVessel();
    const resetSpy = jest.fn();
    svc.on('vessel:journey-reset', resetSpy);

    svc._confirmDirectionReversal(vessel, 'south', 'bridge-crossing Klaffbron evidenced south');

    expect(vessel.passedBridges).toEqual(['Klaffbron']);
    expect(resetSpy).toHaveBeenCalledWith(expect.objectContaining({ bridges: ['Olidebron'] }));
  });

  test('en bro bakom som segmentet INTE korsar stannar kvar (smal regel)', () => {
    const svc = makeVDS();
    const vessel = reversedVessel();
    // Båda fixarna söder om Klaffbron: återkorsningen skedde tidigare.
    const start = { ...vessel, ...northOf(KLAFF, -200) };

    svc._confirmDirectionReversal(vessel, 'south', 'dist=1733m > 500', { reCrossSegmentStart: start });

    expect(vessel.passedBridges).toEqual(['Klaffbron']);
  });

  test('ett segment som korsar bron i GAMLA riktningen släpper den inte', () => {
    const svc = makeVDS();
    const vessel = { ...reversedVessel(), ...northOf(KLAFF, 300) };
    const start = { ...vessel, ...northOf(KLAFF, -300) }; // segmentet går norrut över bron

    svc._confirmDirectionReversal(vessel, 'south', 'target behind vessel', { reCrossSegmentStart: start });

    // Klaffbron ligger framför (söder om båten) och släpps ändå av den vanliga
    // regeln; Olidebron likaså. Inget släpps på grund av segmentet.
    expect(vessel.passedBridges).toEqual([]);
    const [line] = logger.log.mock.calls.map(([l]) => l).filter((l) => l.includes('[JOURNEY_RESET]'));
    expect(line).not.toMatch(/re-crossed/);
  });

  test('GPS-flaggade fix ger inget segment', () => {
    const svc = makeVDS();
    const vessel = reversedVessel();
    expect(svc._cleanReCrossSegmentStart({ ...vessel, _gpsJumpDetected: true }, pendingFix(vessel))).toBeNull();
    expect(svc._cleanReCrossSegmentStart({ ...vessel, _positionUncertain: true }, pendingFix(vessel))).toBeNull();
    expect(svc._cleanReCrossSegmentStart(vessel, null)).toBeNull();
    expect(svc._cleanReCrossSegmentStart(vessel, pendingFix(vessel))).toMatchObject({ lat: northOf(KLAFF, 400).lat });
  });

  test('positionsbevisets två ben skickar också segmentet', () => {
    const svc = makeVDS();
    const spy = jest.spyOn(svc, '_confirmDirectionReversal');
    // Låg fart (< 2 kn), två rena ben söderut över Klaffbron, ruttlås norrut
    // och målbron Stridsbergsbron framför i den gamla riktningen.
    const t0 = Date.now() - 4 * 60 * 1000;
    const first = {
      mmsi: '265000001',
      ...northOf(KLAFF, 150),
      sog: 1.5,
      cog: 200,
      fixTs: t0 + 2 * 60 * 1000,
      timestamp: t0 + 2 * 60 * 1000,
      lastPositionUpdate: t0 + 2 * 60 * 1000,
      _hasMovementProof: true,
      _routeDirection: 'north',
      targetBridge: 'Stridsbergsbron',
      passedBridges: ['Olidebron', 'Klaffbron'],
      _positionDirectionEvidence: {
        direction: 'south', lastFixTs: t0 + 2 * 60 * 1000, legs: 1, ...{ originLat: northOf(KLAFF, 260).lat, originLon: KLAFF.lon },
      },
    };
    const second = {
      ...first,
      ...northOf(KLAFF, -80),
      fixTs: t0 + 4 * 60 * 1000,
      timestamp: t0 + 4 * 60 * 1000,
      lastPositionUpdate: t0 + 4 * 60 * 1000,
      _positionDirectionEvidence: null,
    };
    jest.spyOn(svc, '_isQueuePositionFresh').mockReturnValue(true);

    const dir = svc._updatePositionDirectionEvidence(second, first);

    expect(dir).toBe('south');
    expect(spy).toHaveBeenCalledWith(second, 'south', expect.any(String), expect.objectContaining({
      reCrossSegmentStart: expect.objectContaining({ lat: first.lat }),
    }));
    expect(second.passedBridges).toEqual([]);
  });
});

describe('RE_CROSS_EVIDENCED: långsam återkorsning direkt efter Fix D:s väntande fix', () => {
  beforeAll(() => {
    global.__TEST_MODE__ = true;
  });
  afterAll(() => {
    delete global.__TEST_MODE__;
  });
  afterEach(() => {
    while (liveServices.length > 0) {
      try {
        liveServices.pop().clearAllTimers();
      } catch (_) { /* tomt */ }
    }
    jest.clearAllMocks();
  });

  // HAVSORN-geometrin i granskarens variant: väntande fix 630 m norr om
  // Klaffbron (3,1 kn, cog 228°), nästa fix 150 m söder om bron i 1,5 kn,
  // 300 s senare (780 m, nettofart 5,1 kn). Väntan sattes som standard PÅ
  // startfixet: pendingAtS är väntans tid i sekunder relativt startfixets.
  const pendingAgo = (ms, dir = 'south') => ({ dir, time: Date.now() - ms });
  const segment = ({
    fromM = 630, toM = -150, sog = 1.5, dtS = 300, pendingAtS = 0, pending, previousExtra = {}, extra = {},
  } = {}) => {
    const now = Date.now();
    const previous = {
      mmsi: '265196010',
      ...northOf(KLAFF, fromM),
      sog: 3.1,
      cog: 228,
      targetBridge: 'Stridsbergsbron',
      passedBridges: ['Olidebron', 'Klaffbron'],
      _routeDirection: 'north',
      timestamp: now - dtS * 1000,
      ...previousExtra,
    };
    const vessel = {
      ...previous,
      ...northOf(KLAFF, toM),
      sog,
      cog: 200,
      timestamp: now,
      _gpsJumpDetected: false,
      _positionUncertain: false,
      _fixDPendingReversal: pending !== undefined
        ? pending
        : { dir: 'south', time: previous.timestamp + pendingAtS * 1000 },
      ...extra,
    };
    return { previous, vessel };
  };
  const reCrossLines = () => logger.log.mock.calls.map(([l]) => l).filter((l) => l.includes('[RE_CROSS_EVIDENCED]'));
  const expectNoReversal = (vessel) => {
    expect(vessel._routeDirection).toBe('north');
    expect(vessel.passedBridges).toEqual(['Olidebron', 'Klaffbron']);
  };

  test('väntan på startfixet, korsningsfix i 1,5 kn och 780 m på 300 s ⇒ vändningen bekräftas och returen bokförs', () => {
    const svc = makeVDS();
    const { previous, vessel } = segment();
    svc._handleIntermediateBridgePassage(vessel, previous);

    expect(vessel._routeDirection).toBe('south');
    expect(vessel.targetBridge).toBeNull();
    expect(vessel.passedBridges).toEqual(['Klaffbron']);
    expect(vessel.lastPassedBridge).toBe('Klaffbron');
    const [line] = reCrossLines();
    expect(line).toMatch(
      /rörelsebevis: Fix D-väntan south på segmentets startfix, korsningsfixet 1\.5 kn, nettofart 5\.\d kn över 7\d\d m/,
    );
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(
      /INTERMEDIATE_PASSAGE_RECORDED.*Klaffbron.*no-target/,
    ));
  });

  test('utan väntan reverserar en långsam korsning inte (som förut)', () => {
    const svc = makeVDS();
    const { previous, vessel } = segment({ pending: null });
    svc._handleIntermediateBridgePassage(vessel, previous);

    expectNoReversal(vessel);
    expect(reCrossLines()).toHaveLength(0);
  });

  test('väntan i fel riktning, väntan äldre än FIX_D_PENDING_MAX_AGE_MS eller GPS-flagga ⇒ ingen reversal', () => {
    const cases = [
      segment({ pending: pendingAgo(60 * 1000, 'north') }),
      // Väntan på startfixet men 16 min gammal (1 050 m på 960 s, 2,1 kn
      // netto; båda fixarna mellan Olidebron och Järnvägsbron).
      segment({ fromM: 750, toM: -300, dtS: 960 }),
      segment({ extra: { _positionUncertain: true } }),
    ];
    for (const { previous, vessel } of cases) {
      const svc = makeVDS();
      svc._handleIntermediateBridgePassage(vessel, previous);
      expectNoReversal(vessel);
    }
    expect(reCrossLines()).toHaveLength(0);
  });

  test('vobbelskyddet: segment under 100 m reverserar inte, fast övriga villkor håller', () => {
    // 80 m på 60 s (2,6 kn netto), korsningsfix i 1,5 kn, väntan på startfixet.
    const svc = makeVDS();
    const { previous, vessel } = segment({ fromM: 40, toM: -40, dtS: 60 });
    svc._handleIntermediateBridgePassage(vessel, previous);

    expectNoReversal(vessel);
    expect(reCrossLines()).toHaveLength(0);
  });

  // Omgranskningen 2026-11-04 (medel): en väntande båt fick en falsk reversal
  // på ett enda GPS-sprang. Vart och ett av villkoren nedan stoppar ensamt.
  test('väntan satt före startfixet (AQUILA: fixar emellan under 2 kn) ⇒ ingen reversal', () => {
    const svc = makeVDS();
    const { previous, vessel } = segment({ pendingAtS: -90 });
    svc._handleIntermediateBridgePassage(vessel, previous);

    expectNoReversal(vessel);
    expect(reCrossLines()).toHaveLength(0);
  });

  test('korsningsfixet under 1 kn (en outlier bär den stillaliggande båtens fart) ⇒ ingen reversal', () => {
    for (const sog of [0.1, 0.5, 0.9]) {
      const svc = makeVDS();
      const { previous, vessel } = segment({ sog });
      svc._handleIntermediateBridgePassage(vessel, previous);
      expectNoReversal(vessel);
    }
    expect(reCrossLines()).toHaveLength(0);
  });

  test('korsningsfixet utan egen fart: det framförda sog-värdet räcker inte', () => {
    // _createVesselObject för fram förra fixets sog när raden saknar fart;
    // råfältet är då null.
    const svc = makeVDS();
    const { previous, vessel } = segment({ extra: { _rawPositionSog: null } });
    svc._handleIntermediateBridgePassage(vessel, previous);

    expectNoReversal(vessel);
    expect(reCrossLines()).toHaveLength(0);
  });

  test('nettofart under 2 kn (båten cirklade i stället för att göra väg) ⇒ ingen reversal', () => {
    // 150 m på 300 s = 1,0 kn netto.
    const svc = makeVDS();
    const { previous, vessel } = segment({ fromM: 30, toM: -120 });
    svc._handleIntermediateBridgePassage(vessel, previous);

    expectNoReversal(vessel);
    expect(reCrossLines()).toHaveLength(0);
  });

  test('segmentet börjar i en GPS-återhämtning, inte i förra fixet ⇒ ingen reversal', () => {
    // Förra fixet är ett GPS-hopp; segmentet mäts då från den senaste rena
    // positionen (passageSegmentStart), och väntans fix är inte startfixet.
    const svc = makeVDS();
    const now = Date.now();
    const clean = {
      ...northOf(KLAFF, 630), timestamp: now - 300 * 1000, sog: 3.1, cog: 228,
    };
    const { previous, vessel } = segment({
      fromM: 700,
      previousExtra: { _gpsJumpDetected: true, _passageRecoveryPosition: clean },
    });
    svc._handleIntermediateBridgePassage(vessel, previous);

    expectNoReversal(vessel);
    expect(reCrossLines()).toHaveLength(0);
  });

  test('Fix D och RE_CROSS läser samma väntepredikat', () => {
    const svc = makeVDS();
    const v = { _fixDPendingReversal: pendingAgo(60 * 1000) };
    expect(svc._hasFreshFixDPending(v, 'south')).toBe(true);
    expect(svc._hasFreshFixDPending(v, 'north')).toBe(false);
    expect(svc._hasFreshFixDPending(v, null)).toBe(false);
    expect(svc._hasFreshFixDPending({ _fixDPendingReversal: pendingAgo(FIX_D_PENDING_MAX_AGE_MS) }, 'south')).toBe(false);
    expect(svc._hasFreshFixDPending({}, 'south')).toBe(false);
  });
});

describe('svepets riktningslås mot rörelsebevisad levande kurs (F15)', () => {
  let apps;
  let savedTestMode;
  const MMSI = '265899297';

  const boot = async () => {
    const store = {};
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: (key) => (store[key] === undefined ? undefined : JSON.parse(JSON.stringify(store[key]))),
        set: jest.fn((key, value) => {
          store[key] = JSON.parse(JSON.stringify(value));
        }),
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    await app.onInit();
    apps.push(app);
    // Fångar riktningen som svepets EGNA notiser bygger sin token på.
    app.__sweepTokens = [];
    jest.spyOn(app, '_triggerBoatNearFlowFallback').mockImplementation(async (vessel, bridgeName) => {
      app.__sweepTokens.push([bridgeName, app._getDirectionString(vessel)]);
    });
    return app;
  };

  // IRMA återföds 465 m söder om Klaffbron; sist kända läge låg 43 min tidigare
  // 830 m längre söderut (nordgående) — nettot säger norr, kursen säger söder.
  const reborn = (extra = {}) => ({
    mmsi: MMSI,
    name: 'IRMA',
    lat: 58.28003,
    lon: 12.28207,
    sog: 4.9,
    cog: 193.5,
    targetBridge: null,
    passedBridges: [],
    _routeDirection: null,
    _firstSeenLat: 58.28003,
    _firstSeenLon: 12.28207,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    ...extra,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-20T12:05:03.466Z'));
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    apps = [];
  });

  afterEach(async () => {
    for (const app of apps) {
      // eslint-disable-next-line no-await-in-loop
      if (!app._shuttingDown) await app.onUninit();
    }
    await jest.advanceTimersByTimeAsync(0);
    global.__TEST_MODE__ = savedTestMode;
    jest.useRealTimers();
  });

  const lastKnown = (app) => app._lastKnownPositions.set(MMSI, {
    lat: 58.27257, lon: 12.27504, t: Date.now() - 13 * 60 * 1000, posT: Date.now() - 43 * 60 * 1000,
  });

  test('vänd i glappet: svepets egen notis bär norr, därefter inget lås och söderut', async () => {
    const app = await boot();
    lastKnown(app);
    const vessel = reborn();
    await app._checkSkippedBridgesFallback(vessel, null);
    // Glappassagen av Olidebron gick norrut (svepets nettoriktning).
    expect(app.__sweepTokens).toEqual([['Olidebron', 'northbound']]);
    expect(vessel._routeDirection).toBeNull();
    expect(app.log).toHaveBeenCalledWith(expect.stringContaining('[SKIPPED_BRIDGES_DIRECTION_LOCK_RELEASED]'));
    expect(app._getDirectionString(vessel)).toBe('southbound');
  });

  test('kurs 290° (Fix D:s sydband, tokenbandets dödband): svepets notis bär norr, sedan okänd token', async () => {
    const app = await boot();
    lastKnown(app);
    const vessel = reborn({ cog: 290 });
    await app._checkSkippedBridgesFallback(vessel, null);
    // SISU-garantin: svepets egen notis blir aldrig 'unknown' när svepet vet riktningen.
    expect(app.__sweepTokens).toEqual([['Olidebron', 'northbound']]);
    expect(vessel._routeDirection).toBeNull();
    // Valt beteende: senare notiser bär den levande kursens ärliga token tills
    // kursen är entydig (FP8: 271–314° är tvetydigt i kanalen).
    expect(app._getDirectionString(vessel)).toBe('unknown');
  });

  test('ett lås som någon annan satt under svepet släpps inte', async () => {
    const app = await boot();
    lastKnown(app);
    const vessel = reborn();
    app._triggerBoatNearFlowFallback.mockImplementation(async (v) => {
      v._routeDirection = 'south'; // t.ex. en reversal i VDS under svepet
    });
    await app._checkSkippedBridgesFallback(vessel, null);
    expect(vessel._routeDirection).toBe('south');
    expect(app.log).not.toHaveBeenCalledWith(expect.stringContaining('[SKIPPED_BRIDGES_DIRECTION_LOCK_RELEASED]'));
  });

  test('osäker kurs (SISU-skälet) låser som förut', async () => {
    const app = await boot();
    lastKnown(app);
    const vessel = reborn({ cog: 80 }); // östbandet säger inget om nord/syd
    await app._checkSkippedBridgesFallback(vessel, null);
    expect(app.__sweepTokens).toEqual([['Olidebron', 'northbound']]);
    expect(vessel._routeDirection).toBe('north');
  });

  test('kursen motsäger men farten är under 2 kn ⇒ låser som förut', async () => {
    const app = await boot();
    lastKnown(app);
    const vessel = reborn({ sog: 1.2 });
    await app._checkSkippedBridgesFallback(vessel, null);
    expect(vessel._routeDirection).toBe('north');
  });

  test('kursen håller med svepet ⇒ låser som förut', async () => {
    const app = await boot();
    lastKnown(app);
    const vessel = reborn({ cog: 20 });
    await app._checkSkippedBridgesFallback(vessel, null);
    expect(vessel._routeDirection).toBe('north');
  });
});

describe('hela appen på buggjägarens minsta repro', () => {
  test('F10 (HAVSORN): returen söderut över Klaffbron bokförs på bekräftelsefixen', () => {
    const result = replay('r1-f10-havsorn-usvang.jsonl');
    const klaff = passagesOf(result, '265196010').filter((p) => p.bridge === 'Klaffbron');
    // Utresan norrut (målbropassage) och returen söderut (mållös mellanbropassage).
    expect(klaff.map((p) => [p.slag, p.iso])).toEqual([
      ['target', '2026-06-25T09:12:03.728Z'],
      ['intermediate', '2026-06-25T09:26:25.420Z'],
    ]);
    expect(result.intermediatePassages.find((p) => p.bridge === 'Klaffbron').noTarget).toBe(true);
    // Sann korsning 09:23:15.951; bokföringen ligger inom T10:s kopplingsfönster.
    expect(klaff[1].t).toBeGreaterThan(Date.parse('2026-06-25T09:23:15.951Z'));
    // Returens notis (passerad form) är oförändrad och ensam.
    const south = result.notifications.filter((n) => n.bridge === 'Klaffbron' && n.direction === 'southbound');
    expect(south).toHaveLength(1);
    expect(south[0]).toMatchObject({ eta: -1, alreadyPassed: true });
  }, 120000);

  test('F10/r2 (KAJSA): Järnvägsbron och Stridsbergsbron bokförs i färdordning, notisen i passerad form', () => {
    const result = replay('r1-f10r2-kajsa-usvang.jsonl', { monitoring: true });
    const back = passagesOf(result, '265781143').filter((p) => p.t >= Date.parse('2026-08-14T11:00:00Z'));
    expect(back.map((p) => [p.bridge, p.slag, p.iso])).toEqual([
      ['Järnvägsbron', 'intermediate', '2026-08-14T11:05:53.613Z'],
      ['Stridsbergsbron', 'intermediate', '2026-08-14T11:05:53.613Z'],
    ]);
    // Förut: "närmar sig Stridsbergsbron, beräknad ankomst om 2 minuter" 11:06:36,
    // 99 s efter den sanna korsningen 11:04:57 (buggjägarens F13/r2).
    const strids = result.notifications.filter((n) => n.bridge === 'Stridsbergsbron' && n.direction === 'northbound');
    expect(strids).toHaveLength(1);
    expect(strids[0]).toMatchObject({ eta: -1, alreadyPassed: true });
  }, 120000);

  test('F15 (IRMA): notiserna efter återfödelsen bär söderut', () => {
    const result = replay('r1-f15-irma-svepriktning.jsonl', { monitoring: true });
    const after = result.notifications.filter((n) => n.t >= Date.parse('2026-08-20T12:05:00Z'));
    expect(after.map((n) => [n.bridge, n.direction])).toEqual([
      ['Olidebron', 'southbound'],
      ['Kanalinfarten', 'southbound'],
    ]);
  }, 120000);

  // Granskarens variant av F10: ett fix 09:24:00 150 m söder om Klaffbron i
  // 1,5 kn mellan den väntande fixen 09:18:24 och bekräftelsefixen 09:26:25.
  test('F10, långsam återkorsning: returen bokförs i korsningsticken, notisen i passerad form', () => {
    const result = replay('r1-f10-havsorn-langsam-aterkorsning.jsonl');
    const klaff = passagesOf(result, '265196010').filter((p) => p.bridge === 'Klaffbron');
    expect(klaff.map((p) => [p.slag, p.iso])).toEqual([
      ['target', '2026-06-25T09:12:03.728Z'],
      ['intermediate', '2026-06-25T09:24:00.000Z'],
    ]);
    const south = result.notifications.filter((n) => n.bridge === 'Klaffbron' && n.direction === 'southbound');
    expect(south).toHaveLength(1);
    expect(south[0]).toMatchObject({ eta: -1, alreadyPassed: true });
    expect(south[0].t).toBe(Date.parse('2026-06-25T09:24:00.000Z'));
  }, 120000);

  // Granskarens varianter av F15 (utan fixarna nära Olidebron före glappet):
  // återfödelsens kurs 193,5° respektive 290°. Glappassagen av Olidebron gick
  // norrut; returpassagen 12:11 söderut.
  test.each([
    ['r1-f15b-irma-svepnotis.jsonl'],
    ['r1-f15c-irma-kurs290.jsonl'],
  ])('F15-variant %s: svepets notis bär svepets riktning, returen söderut', (fixture) => {
    const result = replay(fixture, { monitoring: true });
    const after = result.notifications.filter((n) => n.t >= Date.parse('2026-08-20T12:05:00Z'));
    expect(after.map((n) => [n.bridge, n.direction, n.source])).toEqual([
      ['Olidebron', 'northbound', 'passage-fallback'],
      ['Olidebron', 'southbound', 'current'],
      ['Kanalinfarten', 'southbound', 'trigger-point'],
    ]);
  }, 120000);
});

/**
 * OMGRANSKNINGEN 2026-11-04 (medel): en VÄNTANDE båt får aldrig vändas av ett
 * enda GPS-sprang över en bro hon redan passerat. Revisionen 9ea8de8 lät en
 * Fix D-väntan upp till 15 min gammal bära rörelsebeviset för en långsam
 * återkorsning och vände båten i alla tre fixturerna; 7699cbe och den
 * avsmalnade regeln gör det inte. Fixturerna är granskarens.
 */
describe('hela appen: en väntande båt vänds inte av ett GPS-sprang (omgranskningen)', () => {
  const iso = (p) => p.iso.slice(11, 19);
  const DEFAULT_TEXT = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';

  test('AQUILA (verklig väntan i 20260601-41h, en inlagd outlier 13:42:40): ingen vändning, målet Klaffbron står kvar', () => {
    // AQUILA passerade Stridsbergsbron söderut 13:14:51 (gt-passages) och låg
    // sedan 51–89 m söder om bron i 0–0,1 kn. Rapporten 13:37:08 (2,8 kn,
    // kurs 44,6°) satte en äkta Fix D-väntan norrut. Outliern ligger 59 m
    // norr om bron i 0,1 kn, 118 m från förra fixet.
    const result = replay('r1-omgr-aquila-gps-sprang.jsonl');
    expect(passagesOf(result, '265735370').map((p) => [p.bridge, p.slag, iso(p)])).toEqual([
      ['Stallbackabron', 'intermediate', '13:02:16'],
      ['Stridsbergsbron', 'target', '13:15:45'],
      ['Järnvägsbron', 'intermediate', '13:52:35'],
      ['Klaffbron', 'target', '13:55:37'],
      ['Olidebron', 'intermediate', '14:06:37'],
    ]);
    // 9ea8de8: "Inga båtar …" 13:42:40–13:54:07 i stället för väntan och ETA
    // mot Klaffbron (DEFAULT-sandwich, WARN INV-14W).
    const window = result.bridgeTextTransitions.filter((b) => b.iso >= '2026-06-02T13:40:00' && b.iso < '2026-06-02T13:55:00');
    expect(window.map((b) => b.text)).not.toContain(DEFAULT_TEXT);
    expect(window.find((b) => b.iso.startsWith('2026-06-02T13:42:40')).text)
      .toBe('En båt på väg mot Klaffbron, beräknad broöppning om 11 minuter');
  }, 120000);

  // En nordgående båt väntar 90 m norr om Järnvägsbron på Stridsbergsbron.
  // EN manöverrapport i 2,3 kn med kurs 200° (Fix D-väntan söderut) och ett
  // sprang 170 m söderut över Järnvägsbron i 0,5 kn, sedan tillbaka. I den
  // andra fixturen är kadensen 180 s och ett vanligt fix ligger emellan.
  test.each([
    ['r1-omgr-vantlage-sprang.jsonl', '10:35:00', '10:50:00'],
    ['r1-omgr-vantlage-sprang-180s.jsonl', '10:47:00', '11:02:00'],
  ])('%s: ingen vändning, Stridsbergsbron bokförs som målbro och ingen varning söderut', (fixture, stridsT, stallT) => {
    const result = replay(fixture);
    expect(passagesOf(result, '265000777').map((p) => [p.bridge, p.slag, iso(p)])).toEqual([
      ['Olidebron', 'intermediate', '10:02:00'],
      ['Klaffbron', 'target', '10:10:00'],
      ['Järnvägsbron', 'intermediate', '10:17:00'],
      ['Stridsbergsbron', 'target', stridsT],
      ['Stallbackabron', 'intermediate', stallT],
    ]);
    // 9ea8de8 avfyrade en falsk bridge_opening_soon för Klaffbron söderut
    // (Klaffbron#4 10:35:58) i den första fixturen.
    expect(result.openingWarnings.filter((w) => w.direction !== 'northbound')).toEqual([]);
  }, 120000);
});

/**
 * KÄNDA LUCKOR (egna kort, se K/R1/DESIGN.md §7.3). Testerna visar DAGENS
 * beteende så att luckan syns; den som rättar ett fall vänder förväntan.
 * Bara bokföringen låses, inte notiserna (de är N-familjens kontrakt).
 */
describe('kända luckor i samma klass (dagens beteende)', () => {
  test('KÄND LUCKA: två återkorsade broar i samma segment, RE_CROSS bokför bara den första', () => {
    // Granskarens variant av F10/r2 (KAJSA) utan fixet 11:01:04: segmentet
    // 10:50:16 → 11:05:53 korsar Järnvägsbron och Stridsbergsbron norrut.
    const result = replay('r1-kand-lucka-tva-broar-i-segmentet.jsonl', { monitoring: true });
    const back = passagesOf(result, '265781143').filter((p) => p.t >= Date.parse('2026-08-14T11:00:00Z'));
    expect(back.map((p) => [p.bridge, p.slag])).toEqual([
      ['Stridsbergsbron', 'intermediate'],
    ]);
  }, 120000);

  test('KÄND LUCKA: tät långsam återkorsning (segment < 100 m) efter Fix D-väntan bokförs inte', () => {
    // Härledd ur F10 (HAVSORN): EN omvänd fix i 4 kn (väntan), sedan 1,5 kn
    // med fix var 30:e sekund över Klaffbron, 5 kn först 120 m söder om bron.
    const result = replay('r1-kand-lucka-tat-langsam-aterkorsning.jsonl');
    const klaff = passagesOf(result, '265196010').filter((p) => p.bridge === 'Klaffbron');
    expect(klaff.map((p) => p.slag)).toEqual(['target']);
  }, 120000);

  test('KÄND LUCKA: långsam vändning vid bron utan fix i 2 kn före korsningen bokförs inte', () => {
    // Härledd ur F10 (HAVSORN): vänder i 1,2 kn 250 m norr om Klaffbron, korsar
    // tillbaka i ett glest ben på 390 m i 1,4 kn och accelererar först söder om
    // bron. Ingen Fix D-väntan finns när korsningen sker.
    const result = replay('r1-kand-lucka-gles-langsam-vandning.jsonl');
    const klaff = passagesOf(result, '265196010').filter((p) => p.bridge === 'Klaffbron');
    expect(klaff.map((p) => p.slag)).toEqual(['target']);
  }, 120000);
});
