'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const { extractFieldStreams } = require('./replay-validation/makeFieldFusionCorpus');

const T0 = Date.UTC(2026, 8, 8, 10);
const MARKER = '[AIS_SOURCE_REJECT_SAMPLE]';
const message = (overrides = {}) => ({
  mmsi: '265000111',
  lat: 58.29,
  lon: 12.29,
  sog: 5,
  cog: 25,
  timestamp: T0,
  fixTs: T0,
  shipName: 'TEST',
  ...overrides,
});

describe('Avvisade stream-fixar sparas separat som diagnostik vid full debug', () => {
  let logger;
  let mux;
  let forwarded;
  let seen;
  const captures = () => logger.log.mock.calls.filter((args) => args[0] === MARKER);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    logger = {
      debugLevel: 'full', log: jest.fn(), debug: jest.fn(), error: jest.fn(),
    };
    mux = new AISSourceMultiplexer(logger);
    mux._config.source = 'both';
    forwarded = jest.fn();
    seen = jest.fn();
    mux.on('ais-message', forwarded);
    mux.on('vessel:seen', seen);
  });

  afterEach(() => {
    mux.disconnect();
    jest.useRealTimers();
  });

  function reject(overrides = {}, feed = 'aisstream') {
    // Två källor ekar samma position. AISstream använder mottagningstid som
    // fixtid, så en ny stream-leverans är inte en dubblett inom samma källa.
    mux._ingestFromFeed(feed === 'aisstream' ? 'aishub' : 'aisstream', message());
    jest.setSystemTime(T0 + 1000);
    mux._ingestFromFeed(feed, message({ timestamp: T0 + 900, fixTs: T0 + 900, ...overrides }));
  }

  test('fångar ursprungsposition/tider och avslag, utan extra fält från meddelandet', () => {
    reject({ apiKey: 'PRIVATE-KEY', username: 'PRIVATE-USER', arbitraryPayload: { secret: 'PRIVATE-PAYLOAD' } });
    expect(captures()).toHaveLength(1);
    const payload = JSON.parse(captures()[0][1]);
    expect(payload).toEqual({
      mmsi: '265000111',
      feed: 'aisstream',
      lat: 58.29,
      lon: 12.29,
      sog: 5,
      cog: 25,
      fixTs: T0 + 900,
      fixTsQuality: 'receipt',
      receivedAt: T0 + 900,
      capturedAt: T0 + 1000,
      reasons: ['cross_feed_duplicate'],
    });
    expect(captures()[0][1]).not.toContain('PRIVATE');
  });

  test.each(['off', 'basic', 'detailed', undefined])('nivå %s sparar inga extra källfixar', (level) => {
    logger.debugLevel = level;
    reject();
    expect(captures()).toHaveLength(0);
    expect(mux.getConnectionStats().fusion.rejected).toBe(1);
  });

  test('accepterad position går till appen en gång och dubbelloggas inte', () => {
    mux._ingestFromFeed('aisstream', message());
    expect(captures()).toHaveLength(0);
    expect(forwarded).toHaveBeenCalledTimes(1);
  });

  test('avvisad position eller livstecken återförs aldrig till appen', () => {
    reject();
    expect(forwarded).toHaveBeenCalledTimes(1);
    expect(seen).not.toHaveBeenCalled();
    expect(mux.getConnectionStats().fusion.accepted).toBe(1);
    expect(mux.getConnectionStats().fusion.rejected).toBe(1);
  });

  test('AISHubs avslag dubbelloggas inte: dess råsvar finns redan före urvalet', () => {
    reject({}, 'aishub');
    expect(captures()).toHaveLength(0);
    expect(mux.getConnectionStats().fusion.rejected).toBe(1);
  });

  test('alla avvisade observationer bevaras även när den mänskliga sammanfattningen stryps', () => {
    reject();
    jest.setSystemTime(T0 + 2000);
    mux._ingestFromFeed('aisstream', message({ timestamp: T0 + 2000, lat: 58.29001 }));
    expect(captures()).toHaveLength(2);
    expect(JSON.parse(captures()[1][1]).lat).toBe(58.29001);
    expect(logger.debug.mock.calls.filter((args) => args[0].includes('[FUSION_REJECT]'))).toHaveLength(1);
  });

  test('avstängning av full debug slår igenom utan omstart', () => {
    reject();
    logger.debugLevel = 'basic';
    mux._ingestFromFeed('aisstream', message());
    expect(captures()).toHaveLength(1);
    expect(mux.getConnectionStats().fusion.rejected).toBe(2);
  });

  test('fältloggens extraktor läser aldrig diagnostiken som replayindata', () => {
    reject();
    expect(captures()).toHaveLength(1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-rejected-source-'));
    const file = path.join(dir, 'app.log');
    try {
      fs.writeFileSync(file, `${captures().map((args) => args.join(' ')).join('\n')}\n`);
      const parsed = extractFieldStreams(file);
      expect(parsed.stream).toEqual([]);
      expect(parsed.hub).toEqual([]);
      expect(parsed.stats.replaySamples).toBe(0);
    } finally {
      fs.unlinkSync(file);
      fs.rmdirSync(dir);
    }
  });
});
