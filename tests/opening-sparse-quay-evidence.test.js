'use strict';

const corpora = require('./replay-validation/corpora');
const {
  approachEvidence, classifyPhantom, analysePhantoms, loadSamples, gtTargetPassages,
} = require('./replay-validation/runOpeningGates');
const { BRIDGES, QUAY_DEPARTURE_GATE } = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

const CARAT = '211452170';
const WARN_AT = Date.parse('2026-08-05T00:19:14.283Z');
const CARAT_CORPUS = corpora.find((c) => c.id === '20260804-both-21h');
const ALL_SAMPLES = loadSamples(CARAT_CORPUS.jsonl);
const CARAT_RAW = ALL_SAMPLES.get(CARAT);
const CARAT_PREFIX = CARAT_RAW.filter((s) => s.aisTimestamp <= WARN_AT);
const caratWarning = {
  t: WARN_AT,
  iso: new Date(WARN_AT).toISOString(),
  bridge: 'Stridsbergsbron',
  direction: 'northbound',
  leadMmsi: CARAT,
  mmsis: [CARAT],
  leadVessel: 'CARAT',
  eventId: 'Stridsbergsbron#5',
  distance: 814,
  etaMin: 33,
};

const samplesOf = (list) => new Map([[CARAT, list]]);
const north = (sample, meters, t = WARN_AT) => ({
  ...sample,
  lat: sample.lat + (meters / 6371000) * (180 / Math.PI),
  aisTimestamp: t,
  fixTs: t,
});

describe('O2: CARATs första falska Stridskort fångas från rådata', () => {
  test('korpushändelsen bär exakt två svaga fartfixar och bara 32 m förflyttning', () => {
    // JSONL-rader 303/367; originalets AIS_REPLAY_SAMPLE-rader 57699/69885.
    expect(CARAT_PREFIX).toHaveLength(2);
    expect(CARAT_PREFIX.map((s) => s.sog)).toEqual([1, 1.6]);
    expect(CARAT_PREFIX[1].aisTimestamp - CARAT_PREFIX[0].aisTimestamp).toBe(881810);
    const e = approachEvidence(caratWarning, ALL_SAMPLES);
    expect(e.maxMove).toBeCloseTo(32.294, 2);
    expect(e.net).toBeCloseTo(23.952, 2);
    expect(e.maxSog).toBe(1.6);
    expect(e.soloProofFixes).toBe(0);
    expect(e.moving).toBe(false);
  });

  test('kajplatsen känns igen vid Klaffbron även när varningen gäller Stridsbergsbron', () => {
    const e = approachEvidence(caratWarning, ALL_SAMPLES);
    expect(e.maxD).toBeGreaterThan(QUAY_DEPARTURE_GATE.LEDGER_RADIUS_M);
    expect(e.quayBridge).toBe('Klaffbron');
    expect(e.atQuay).toBe(true);
    const judged = classifyPhantom(caratWarning, ALL_SAMPLES);
    expect(judged).toMatchObject({ klass: 'KAJVOBBEL', accepted: false });
    expect(judged.bevis).toContain('kajbandet 500 m vid Klaffbron');
  });

  test('senare råfixar behövs inte för att underkänna det svaga avgångsbeviset', () => {
    expect(classifyPhantom(caratWarning, samplesOf(CARAT_PREFIX)))
      .toEqual(classifyPhantom(caratWarning, ALL_SAMPLES));
  });

  test('hela råspåret visar kajvistelse följd av södergående Klaffpassage, ingen Stridspassage', () => {
    const lastQuayAt = Date.parse('2026-08-05T06:48:58.821Z');
    const quay = CARAT_RAW.filter((s) => s.aisTimestamp <= lastQuayAt);
    const origin = quay[0];
    expect(quay.length).toBeGreaterThan(30);
    const net = quay.map((s) => geometry.calculateDistance(origin.lat, origin.lon, s.lat, s.lon));
    expect(Math.max(...net)).toBeLessThan(50);
    const gt = gtTargetPassages(CARAT_CORPUS).filter((p) => String(p.mmsi) === CARAT);
    expect(gt.some((p) => p.bridge === 'Klaffbron' && p.dir === 'syd')).toBe(true);
    expect(gt.some((p) => p.bridge === 'Stridsbergsbron')).toBe(false);
    const analysis = analysePhantoms({ openingWarnings: [caratWarning] }, ALL_SAMPLES, gt);
    expect(analysis.phantoms).toHaveLength(1);
    expect(analysis.phantoms[0]).toMatchObject({ klass: 'KAJVOBBEL', accepted: false });
  });
});

describe('O2: brusgolvet stoppar kajrörelse men tillåter verklig avgång', () => {
  test.each([
    [QUAY_DEPARTURE_GATE.NET_APPROACH_M - 1, false],
    [QUAY_DEPARTURE_GATE.NET_APPROACH_M + 1, true],
  ])('två låga fartvärden med %s m nettoavgång: rörelsebevis=%s', (meters, moving) => {
    const list = [CARAT_PREFIX[0], north(CARAT_PREFIX[0], meters)];
    list[1].sog = 1.6;
    const e = approachEvidence(caratWarning, samplesOf(list));
    expect(e.atQuay).toBe(true);
    expect(e.underwayFixes).toBe(2);
    expect(e.moving).toBe(moving);
    expect(classifyPhantom(caratWarning, samplesOf(list)).accepted).toBe(moving);
  });

  test('samma brusprofil är röd också när själva kajbron varnas', () => {
    expect(classifyPhantom({ ...caratWarning, bridge: 'Klaffbron' }, samplesOf(CARAT_PREFIX)))
      .toMatchObject({ klass: 'KAJVOBBEL', accepted: false });
  });

  test('200 m verkligt närmande bevaras även utan fartgivare', () => {
    const list = [
      { ...CARAT_PREFIX[0], sog: null },
      { ...north(CARAT_PREFIX[0], 230), sog: null },
    ];
    expect(classifyPhantom(caratWarning, samplesOf(list)))
      .toMatchObject({ klass: 'AVBRUTEN_APPROACH', accepted: true });
  });

  test('en färsk hög fart motsagd av positionerna får inte rädda kajvobblaren', () => {
    const list = [
      { ...CARAT_PREFIX[0], aisTimestamp: WARN_AT - 120000, fixTs: WARN_AT - 120000 },
      { ...north(CARAT_PREFIX[0], 2), sog: 7.4 },
    ];
    expect(classifyPhantom(caratWarning, samplesOf(list)))
      .toMatchObject({ klass: 'KAJVOBBEL', accepted: false });
  });

  test('två svaga fixer ute i farleden får fortfarande den försiktiga gleshetsklassningen', () => {
    const first = {
      ...CARAT_PREFIX[0], lat: BRIDGES.klaffbron.lat - 1500 / 111320, lon: BRIDGES.klaffbron.lon,
    };
    const list = [first, { ...north(first, 10), sog: 1.6 }];
    const judged = classifyPhantom({ ...caratWarning, bridge: 'Klaffbron' }, samplesOf(list));
    expect(judged).toMatchObject({ klass: 'GLES_ANFLYGNING', accepted: true });
  });

  test('riktig medtrafik gör öppningen giltig även när en medlem saknar avgångsbevis', () => {
    const other = '265999123';
    const samples = new Map(samplesOf(CARAT_PREFIX));
    samples.set(other, [
      { ...CARAT_PREFIX[0], mmsi: other },
      { ...north(CARAT_PREFIX[0], 230), mmsi: other },
    ]);
    for (const mmsis of [[CARAT, other], [other, CARAT]]) {
      expect(classifyPhantom({ ...caratWarning, mmsis }, samples).accepted).toBe(true);
    }
  });
});

describe('O2: verkliga glesa rådataprofiler behåller sin klassning', () => {
  test.each([
    ['20260601-41h', '211112870', 'Stridsbergsbron', '2026-06-02T10:22:25.239Z', 'AVBRUTEN_APPROACH'],
    ['20260702-19h', '265687350', 'Klaffbron', '2026-07-03T11:00:31.213Z', 'GLES_ANFLYGNING'],
    ['20260712-25h', '265761140', 'Klaffbron', '2026-07-13T07:07:49.967Z', 'GLES_ANFLYGNING'],
    ['20260713-41h', '211291340', 'Klaffbron', '2026-07-14T07:23:36.322Z', 'GLES_ANFLYGNING'],
  ])('%s / %s', (corpusId, mmsi, bridge, at, klass) => {
    // BRANIFs solofix samt DIAMOND, IDUN och LAMANTIJNs glesa anflygningar.
    const corpus = corpora.find((c) => c.id === corpusId);
    const samples = loadSamples(corpus.jsonl);
    const warning = {
      t: Date.parse(at), bridge, leadMmsi: mmsi, mmsis: [mmsi],
    };
    expect(classifyPhantom(warning, samples)).toMatchObject({ klass, accepted: true });
  });
});
