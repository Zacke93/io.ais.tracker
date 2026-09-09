'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { FIX_D_PENDING_MAX_AGE_MS } = require('../lib/constants');

describe('Två rena positionsben får rätta befintlig felriktning vid låg fart', () => {
  let service;
  let now;
  beforeEach(() => {
    now = Date.parse('2026-09-08T08:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    service = Object.create(VesselDataService.prototype);
    service.bridgeRegistry = new BridgeRegistry();
    service._confirmDirectionReversal = jest.fn();
  });
  afterEach(() => jest.restoreAllMocks());
  const make = (lat, t, extra = {}) => ({
    mmsi: '257605080',
    lat,
    lon: 12.288,
    sog: 1,
    fixTs: t,
    timestamp: t,
    targetBridge: 'Klaffbron',
    _routeDirection: 'south',
    _hasMovementProof: true,
    _moored: false,
    _positionUncertain: false,
    _gpsJumpDetected: false,
    ...extra,
  });
  function segment(previous, lat, extra = {}, gap = 60000) {
    now += gap;
    const current = make(lat, now, extra);
    const direction = service._updatePositionDirectionEvidence(current, previous);
    return { current, direction };
  }
  test('två riktiga nordben rättar sydlåset trots låg fart', () => {
    const first = make(58.2875, now);
    const second = segment(first, 58.2885);
    expect(second.direction).toBeNull();
    const third = segment(second.current, 58.2895);
    expect(third.direction).toBe('north');
    expect(service._confirmDirectionReversal).toHaveBeenCalledTimes(1);
  });
  test('symmetriskt för sydben med Stridsbergsbron bakom båten', () => {
    const extra = { targetBridge: 'Stridsbergsbron', _routeDirection: 'north' };
    const second = segment(make(58.2895, now, extra), 58.2885, extra);
    expect(segment(second.current, 58.2875, extra).direction).toBe('south');
  });
  test('ett enda stort hopp är aldrig två ben', () => {
    expect(segment(make(58.2875, now), 58.2905).direction).toBeNull();
    expect(service._confirmDirectionReversal).not.toHaveBeenCalled();
  });
  test('pendling tillbaka bryter riktningen i stället för att summera sträckan', () => {
    const second = segment(make(58.2875, now), 58.2895);
    expect(segment(second.current, 58.2885).direction).toBeNull();
  });
  test('två ben under 200 m totalt räcker inte', () => {
    const second = segment(make(58.2875, now), 58.2881);
    expect(segment(second.current, 58.2887).direction).toBeNull();
  });
  test.each([
    ['aktuell GPS-osäkerhet', { _positionUncertain: true }],
    ['aktuellt GPS-hopp', { _gpsJumpDetected: true }],
    ['förtöjd', { _moored: true }],
    ['utan rörelsebevis', { _hasMovementProof: false }],
    ['utan ruttlås', { _routeDirection: null }],
    ['utan målbro', { targetBridge: null }],
    ['stillastående', { sog: 0 }],
    ['okänd fart', { sog: null }],
    ['normal hög fart behåller COG-debounce', { sog: 3 }],
  ])('%s ger ingen ny positionsreversal', (_label, extra) => {
    const second = segment(make(58.2875, now), 58.2885);
    expect(segment(second.current, 58.2895, extra).direction).toBeNull();
    expect(service._confirmDirectionReversal).not.toHaveBeenCalled();
  });
  test.each(['_positionUncertain', '_gpsJumpDetected'])('rent återhopp från %s räknas inte', (flag) => {
    const second = segment(make(58.2875, now), 58.2885);
    second.current[flag] = true;
    expect(segment(second.current, 58.2895).direction).toBeNull();
  });
  test('oförändrad fixtid bryter kedjan', () => {
    const second = segment(make(58.2875, now), 58.2885);
    expect(segment(second.current, 58.2895, { fixTs: second.current.fixTs }).direction).toBeNull();
  });
  test('källtystnad över riktningsfristen bryter kedjan', () => {
    const second = segment(make(58.2875, now), 58.2885);
    expect(segment(second.current, 58.2895, {}, FIX_D_PENDING_MAX_AGE_MS + 1).direction).toBeNull();
  });
  test('gammal hubposition räknas inte som färskt tredje ben', () => {
    const second = segment(make(58.2875, now), 58.2885);
    expect(segment(second.current, 58.2895, {
      fixFeed: 'aishub', fixTs: now - 13 * 60000,
    }).direction).toBeNull();
  });
  test('ruttlås som redan stämmer påverkas inte', () => {
    const extra = { targetBridge: 'Stridsbergsbron', _routeDirection: 'north' };
    const second = segment(make(58.2875, now, extra), 58.2885, extra);
    expect(segment(second.current, 58.2895, extra).direction).toBeNull();
  });
});

test('AKIRA:s rådata ger norrgående Järnvägsnotis och Strids-mål före verklig passage', () => {
  const replayDir = path.join(__dirname, 'replay-validation');
  const jsonl = path.join(replayDir, 'corpora-data/ais-replay-20260708-001857.jsonl');
  const out = execFileSync(process.execPath, [path.join(replayDir, 'replayRunner.js'), jsonl], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  const result = JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
  const at = Date.parse('2026-07-08T07:20:09.222Z');
  const near = result.notifications.find((n) => n.mmsi === '257605080' && n.bridge === 'Järnvägsbron');
  expect(near).toMatchObject({ t: at, direction: 'northbound', alreadyPassed: false });
  expect(result.bridgeTextTransitions.find((x) => x.t === at + 25).text).toContain('mot Stridsbergsbron');
  expect(result.openingWarnings.some((w) => w.bridge === 'Klaffbron' && w.mmsis.includes('257605080'))).toBe(false);
  const cover = result.openingCoverage.find((c) => c.mmsi === '257605080' && c.bridge === 'Stridsbergsbron');
  const warning = result.openingWarnings.find((w) => w.eventId === cover.eventId);
  const gt = JSON.parse(fs.readFileSync(path.join(replayDir, 'gt-passages/20260708-21h.json'), 'utf8'))
    .find((g) => g.mmsi === '257605080' && g.bridge === 'Stridsbergsbron');
  expect(warning.t).toBeLessThan(gt.t);
  expect(result.processErrors).toBe(0);
});
