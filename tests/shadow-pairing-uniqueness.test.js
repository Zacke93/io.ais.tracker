'use strict';

const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const { AIS_CONFIG } = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

const START = Date.parse('2026-09-17T10:17:00Z');

describe('Skuggmätningens par bygger på unika leveranser inom hela avståndsgränsen', () => {
  let mux;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    mux = new AISSourceMultiplexer({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });
  });

  afterEach(() => {
    mux.disconnect();
    jest.useRealTimers();
  });

  function sample(feed, afterMs, options = {}) {
    jest.setSystemTime(START + afterMs);
    mux._recordShadowSample(feed, {
      mmsi: '265552060',
      lat: 58.26804,
      lon: 12.26709,
      timestamp: Date.now(),
      fixTs: Date.now(),
      navStatus: 5,
      ...options,
    });
  }

  test.each(['aisstream', 'aishub'])('en %s-leverans får inte ingå i två par', (firstFeed) => {
    const secondFeed = firstFeed === 'aisstream' ? 'aishub' : 'aisstream';
    sample(firstFeed, 0);
    sample(secondFeed, 1000);
    sample(firstFeed, 2000);

    // Den andra leveransen har redan ingått i första paret. Att använda
    // den igen ger ett nytt race med motsatt tecken ur samma råsampel.
    expect(mux._shadowWindow.fixLags).toHaveLength(1);
    expect(mux._shadowWindow.races).toHaveLength(1);
    expect(mux._shadowWindow.msgs[firstFeed]).toBe(2);

    // En fjärde, oberoende leverans ska fortfarande bilda nästa par.
    sample(secondFeed, 3000);
    expect(mux._shadowWindow.fixLags).toHaveLength(2);
    expect(mux._shadowWindow.races).toHaveLength(2);
  });

  test('ett använt sampel får inte räknas om efter att rapportfönstret nollats', () => {
    sample('aisstream', 0);
    sample('aishub', 1000);
    mux._resetShadowWindow();
    sample('aisstream', 2000);
    expect(mux._shadowWindow.fixLags).toHaveLength(0);
    expect(mux._shadowWindow.races).toHaveLength(0);
  });

  test('en färsk leverans behålls när den äldre motparten faller på tidsgrinden', () => {
    sample('aisstream', 0);
    sample('aishub', AIS_CONFIG.SHADOW.PAIR_MAX_SKEW_MS + 1000);
    expect(mux._shadowWindow.fixLags).toHaveLength(0);
    sample('aisstream', AIS_CONFIG.SHADOW.PAIR_MAX_SKEW_MS + 2000);
    expect(mux._shadowWindow.fixLags).toEqual([1000]);
  });

  test.each([
    ['latitud två rutor bort', 0.0000102, 0],
    ['longitud tre rutor bort', 0, 0.0000202],
  ])('%s räknas när positionerna ligger inom 1,5 meter', (_, deltaLat, deltaLon) => {
    const first = { lat: 58.2900049, lon: 12.2900049 };
    const second = { lat: first.lat + deltaLat, lon: first.lon + deltaLon };
    expect(geometry.calculateDistance(first.lat, first.lon, second.lat, second.lon))
      .toBeLessThan(AIS_CONFIG.SHADOW.PAIR_MATCH_DIST_M);
    sample('aisstream', 0, first);
    sample('aishub', 1000, second);
    expect(mux._shadowWindow.fixLags).toHaveLength(1);
  });

  test('avståndsgrinden avvisar en förflyttning utanför radien även inom samma fartygs index', () => {
    sample('aisstream', 0);
    sample('aishub', 1000, { lon: 12.26719 });
    expect(mux._shadowWindow.fixLags).toHaveLength(0);
  });
});
