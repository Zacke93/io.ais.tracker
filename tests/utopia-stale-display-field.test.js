'use strict';

const fs = require('fs');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const corpora = require('./replay-validation/corpora');
const { validateInvariants } = require('./replay-validation/invariants');

const MMSI = '265810170';
const LAST_RECEIVED = Date.parse('2026-08-06T08:21:35.040Z');
const DEFAULT_AT = Date.parse('2026-08-06T08:47:00.040Z');
const NEXT_RECEIVED = Date.parse('2026-08-06T08:47:18.647Z');
const RESTORED_AT = Date.parse('2026-08-06T08:47:30.040Z');
const LIMIT_MS = 25 * 60000;
const DEFAULT = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
const STRIDS = 'En båt på väg mot Stridsbergsbron, ETA okänd';
const REVIEWED_FLASH = 'DEFAULT-FLASH: 2026-08-06T08:47:00.040Z "Inga båtar" inklämd (30s) '
  + 'mellan två "En … Stridsbergsbron"-texter utan passage';

const job = corpora.find((c) => c.id === '20260806-42h');
const samples = fs.readFileSync(job.jsonl, 'utf8').trim().split('\n').map(JSON.parse)
  .filter((s) => String(s.mmsi) === MMSI);
const lastIndex = samples.findIndex((s) => s.aisTimestamp === LAST_RECEIVED);
const previous = samples[lastIndex];
const next = samples[lastIndex + 1];

// Tillståndet vid 08:46:30 i fullapp-replayen. Råposition och båda
// färskhetsklockorna läses ur korpusen; visningsfiltret körs på riktigt.
function vessel(sample) {
  return {
    mmsi: MMSI,
    name: sample.shipName,
    lat: sample.lat,
    lon: sample.lon,
    sog: sample.sog,
    cog: sample.cog,
    timestamp: sample.aisTimestamp,
    lastPositionUpdate: sample.aisTimestamp,
    fixTs: sample.fixTs,
    fixFeed: sample.feed,
    targetBridge: 'Stridsbergsbron',
    currentBridge: 'Järnvägsbron',
    status: 'waiting',
    passedBridges: ['Olidebron', 'Klaffbron'],
    _routeDirection: 'north',
    _moored: false,
    isWaiting: true,
    waitingAtBridge: 'Stridsbergsbron',
  };
}

describe('UTOPIA 42h: 25 min utan mottagen position får avsluta visningen', () => {
  let service;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(LAST_RECEIVED);
    const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    service = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    service.vessels.set(MMSI, vessel(previous));
  });

  afterEach(() => {
    service.clearAllTimers();
    jest.useRealTimers();
  });

  test('två intilliggande råposter bevisar hela leveransluckan på 25 min 43,607 s', () => {
    expect(lastIndex).toBeGreaterThanOrEqual(0);
    expect(previous).toMatchObject({
      lat: 58.29111, lon: 12.29142, sog: 0.7, feed: 'aishub',
    });
    expect(next.aisTimestamp).toBe(NEXT_RECEIVED);
    expect(NEXT_RECEIVED - LAST_RECEIVED).toBe(25 * 60000 + 43607);
    expect(samples.filter((s) => s.aisTimestamp > LAST_RECEIVED && s.aisTimestamp < NEXT_RECEIVED)).toEqual([]);
    expect(DEFAULT_AT - LAST_RECEIVED).toBe(LIMIT_MS + 25000);
  });

  test('nästa råfix kan vara mätt tidigare utan att vara tillgänglig för appen', () => {
    expect(next.fixTs).toBe(Date.parse('2026-08-06T08:46:23Z'));
    expect(next.fixTs).toBeLessThan(DEFAULT_AT);
    expect(next.aisTimestamp).toBeGreaterThan(DEFAULT_AT);
    expect(Date.parse(next.receivedAt)).toBe(NEXT_RECEIVED);
    expect(RESTORED_AT - NEXT_RECEIVED).toBe(11393);
  });

  test.each([LIMIT_MS - 1, LIMIT_MS])('riktiga visningsfiltret behåller båten vid ålder %i ms', (age) => {
    jest.setSystemTime(LAST_RECEIVED + age);
    expect(service.getVesselsForBridgeText().map((v) => v.mmsi)).toContain(MMSI);
  });

  test.each([LAST_RECEIVED + LIMIT_MS + 1, DEFAULT_AT, NEXT_RECEIVED - 1])(
    'gammal position visas inte vid %i innan nästa leverans', (now) => {
      jest.setSystemTime(now);
      expect(service.getVesselsForBridgeText()).toEqual([]);
      expect(service.getVessel(MMSI)).toBeDefined();
    },
  );

  test('nästa mottagna råposition återställer synligheten utan förlängd grace', () => {
    jest.setSystemTime(NEXT_RECEIVED - 1);
    expect(service.getVesselsForBridgeText()).toEqual([]);
    jest.setSystemTime(NEXT_RECEIVED);
    service.vessels.set(MMSI, vessel(next));
    expect(service.getVesselsForBridgeText().map((v) => v.mmsi)).toContain(MMSI);
  });

  test('den kända textheuristiken flaggar exakt denna 30 s episod trots styrkt AIS-utgång', () => {
    const row = (t, text) => ({ t, iso: new Date(t).toISOString(), text });
    const result = validateInvariants({
      bridgeTextTransitions: [row(LAST_RECEIVED + 25, STRIDS), row(DEFAULT_AT, DEFAULT), row(RESTORED_AT, STRIDS)],
      targetPassages: [],
    });
    expect(result).toEqual([REVIEWED_FLASH]);
  });
});
