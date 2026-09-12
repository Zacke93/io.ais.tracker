'use strict';

const TriggerPointVisitTracker = require('../lib/services/TriggerPointVisitTracker');
const { BRIDGES, TRIGGER_POINTS, AIS_CONFIG } = require('../lib/constants');

const MMSI = '265576710';
const POINT = TRIGGER_POINTS.kanalinfarten;
const KANAL_KEY = `${MMSI}:Kanalinfarten`;
const METRES_PER_LAT_DEGREE = 6371000 * Math.PI / 180;

describe('Broar och Kanalinfarten: ett notifierat besök tills verklig utfärd och återkomst', () => {
  let now;
  let tracker;
  let logger;

  beforeEach(() => {
    now = Date.parse('2026-09-07T08:00:00Z');
    logger = { warn: jest.fn() };
    tracker = new TriggerPointVisitTracker({ logger, now: () => now });
  });

  function fix(distance = 200, overrides = {}) {
    return {
      mmsi: MMSI,
      lat: POINT.lat + distance / METRES_PER_LAT_DEGREE,
      lon: POINT.lon,
      timestamp: now,
      lastPositionUpdate: now,
      fixTs: now,
      fixFeed: 'aishub',
      ...overrides,
    };
  }

  function observe(distance, overrides = {}) {
    now += 60000;
    return tracker.observe(fix(distance, overrides));
  }

  function pointFix(point, distance, overrides = {}) {
    return fix(0, {
      lat: point.lat + distance / METRES_PER_LAT_DEGREE, lon: point.lon, ...overrides,
    });
  }

  function depart() {
    expect(observe(400)).toEqual({ changed: true, reentered: false });
    expect(observe(420)).toEqual({ changed: true, reentered: false });
  }

  test.each(Object.values(BRIDGES))('%s: passage, fortsatt utfärd och retur efter AIS-glapp ger nytt besök', (point) => {
    tracker.reserve(pointFix(point, -115), point.name);
    now += 60000;
    tracker.observe(pointFix(point, 314, { passedBridges: [point.name] }), point.name);
    now += 60000;
    tracker.observe(pointFix(point, 424, { passedBridges: [point.name] }), point.name);
    const restored = new TriggerPointVisitTracker({ now: () => now });
    restored.loadSnapshot(tracker.exportSnapshot());
    now += 67 * 60000;
    expect(restored.observe(pointFix(point, 214, { _routeDirection: 'south', sog: 8 }), point.name).reentered).toBe(true);
    expect(restored.reserve(pointFix(point, 214), point.name)).not.toBeNull();
  });

  test.each([
    ['utan passage', -115, {}],
    ['väntan på samma sida trots gammal passagebokföring', 115, { passedBridges: ['Stallbackabron'] }],
    ['osäkert utfärdsprov', -115, { passedBridges: ['Stallbackabron'], _positionUncertain: true }],
  ])('%s kan inte låsa upp besöket efter bara en yttre fix', (_label, start, extra) => {
    const point = BRIDGES.stallbackabron;
    tracker.reserve(pointFix(point, start), point.name);
    now += 60000;
    tracker.observe(pointFix(point, 314, extra), point.name);
    now += 60000;
    tracker.observe(pointFix(point, 424, extra), point.name);
    now += 67 * 60000;
    expect(tracker.observe(pointFix(point, 214), point.name).reentered).toBe(false);
    expect(tracker.holds(MMSI, point.name)).toBe(true);
  });

  test('långt hamnstopp och rörelse inom området behåller samma besök', () => {
    const own = tracker.reserve(fix());
    expect(own).not.toBeNull();
    expect(tracker.reserve(fix())).toBeNull();
    now += 8 * 60 * 60 * 1000;
    expect(observe(120, { _moored: true, sog: 0 })).toEqual({ changed: false, reentered: false });
    expect(observe(20, { _moored: false, sog: 4, _routeDirection: 'north' })).toEqual({ changed: false, reentered: false });
    expect(tracker.holds(MMSI)).toBe(true);
    expect(tracker.exportSnapshot().entries[KANAL_KEY].startedAt).toBe(own.startedAt);
  });

  test.each([...Object.values(BRIDGES), POINT].map((point) => [point.name, point]))(
    '%s: långstopp, omstart och U-sväng inom zonen hålls; verklig utfärd och återkomst släpps',
    (name, point) => {
      expect(tracker.reserve(pointFix(point, 200), name)).not.toBeNull();
      now += 8 * 60 * 60 * 1000;
      const restored = new TriggerPointVisitTracker({ now: () => now });
      expect(restored.loadSnapshot(tracker.exportSnapshot())).toBe(1);
      expect(restored.observe(pointFix(point, -200, { _routeDirection: 'south', passedBridges: [name] }), name))
        .toEqual({ changed: false, reentered: false });
      expect(restored.holds(MMSI, name)).toBe(true);
      now += 60000;
      expect(restored.observe(pointFix(point, 400), name)).toEqual({ changed: true, reentered: false });
      now += 60000;
      expect(restored.observe(pointFix(point, 420), name)).toEqual({ changed: true, reentered: false });
      expect(restored.holds(MMSI, name)).toBe(true);
      now += 60000;
      expect(restored.observe(pointFix(point, 200), name)).toEqual({ changed: true, reentered: true });
      expect(restored.holds(MMSI, name)).toBe(false);
      expect(restored.reserve(pointFix(point, 200), name)).not.toBeNull();
    },
  );

  test('överlappande Järn-/Stridsområden och olika båtar har oberoende besök', () => {
    const jarn = BRIDGES.jarnvagsbron;
    const strids = BRIDGES.stridsbergsbron;
    const midpoint = fix(0, { lat: (jarn.lat + strids.lat) / 2, lon: (jarn.lon + strids.lon) / 2 });
    tracker.reserve(midpoint, jarn.name);
    tracker.reserve(midpoint, strids.name);
    const other = tracker.reserve({ ...midpoint, mmsi: '276015380' }, jarn.name);
    for (const distance of [400, 420]) {
      now += 60000;
      const vessel = pointFix(jarn, distance);
      tracker.observe(vessel, jarn.name);
      tracker.observe(vessel, strids.name);
    }
    now += 60000;
    const returned = pointFix(jarn, 0);
    expect(tracker.observe(returned, jarn.name).reentered).toBe(true);
    expect(tracker.observe(returned, strids.name).reentered).toBe(false);
    expect(tracker.holds(MMSI, jarn.name)).toBe(false);
    expect(tracker.holds(MMSI, strids.name)).toBe(true);
    expect(tracker.rollback('276015380', other, strids.name)).toBe(false);
    expect(tracker.holds('276015380', jarn.name)).toBe(true);
    expect(tracker.rollback('276015380', other, jarn.name)).toBe(true);
  });

  test('v1 migrerar endast verkligt Kanalbesök; v2 återställer separata brobesök', () => {
    tracker.reserve(fix());
    const kanal = tracker.exportSnapshot().entries[KANAL_KEY];
    expect(tracker.loadSnapshot({ version: 1, entries: { [MMSI]: kanal } })).toBe(1);
    expect(tracker.holds(MMSI)).toBe(true);
    expect(tracker.holds(MMSI, 'Klaffbron')).toBe(false);
    tracker.reserve(pointFix(BRIDGES.klaffbron, 100), 'Klaffbron');
    const snapshot = tracker.exportSnapshot();
    expect(snapshot.version).toBe(2);
    expect(Object.keys(snapshot.entries).sort()).toEqual([KANAL_KEY, `${MMSI}:Klaffbron`].sort());
    const restored = new TriggerPointVisitTracker({ now: () => now });
    expect(restored.loadSnapshot(snapshot)).toBe(2);
    expect(restored.holds(MMSI)).toBe(true);
    expect(restored.holds(MMSI, 'Klaffbron')).toBe(true);
    expect(restored.holds(MMSI, 'Olidebron')).toBe(false);
  });

  test('okända områden och felaktiga v2-nycklar kan inte skapa eller frigöra besök', () => {
    const entry = tracker.reserve(fix());
    expect(tracker.holds(MMSI, 'constructor')).toBe(false);
    expect(tracker.reserve(fix(), 'saknas')).toBeNull();
    expect(tracker.observe(fix(), 'saknas')).toEqual({ changed: false, reentered: false });
    expect(tracker.rollback(MMSI, entry, 'saknas')).toBe(false);
    expect(tracker.holds(MMSI)).toBe(true);
    const bad = {
      [MMSI]: entry,
      [`${MMSI}:saknas`]: entry,
      [`${MMSI}:Klaffbron:extra`]: entry,
      [`${MMSI}:Klaffbron`]: entry,
    };
    expect(tracker.loadSnapshot({ version: 2, entries: bad })).toBe(1);
    expect(tracker.holds(MMSI, 'Klaffbron')).toBe(true);
  });

  test('två utfärdsfixar öppnar inte för retroaktiv notis; först återkomst gör det', () => {
    tracker.reserve(fix());
    depart();
    expect(tracker.holds(MMSI)).toBe(true);
    expect(observe(320)).toEqual({ changed: false, reentered: false });
    expect(tracker.holds(MMSI)).toBe(true);
    expect(observe(299.9)).toEqual({ changed: true, reentered: true });
    expect(tracker.holds(MMSI)).toBe(false);
    expect(tracker.reserve(fix(200))).not.toBeNull();
  });

  test('hysteres och återgång efter ett ensamt utanförfix nollar utfärdsförsöket', () => {
    tracker.reserve(fix(299));
    observe(350.1);
    observe(349.9);
    expect(observe(400)).toEqual({ changed: true, reentered: false });
    expect(observe(200)).toEqual({ changed: true, reentered: false });
    expect(tracker.holds(MMSI)).toBe(true);
    depart();
    expect(observe(300.1).reentered).toBe(false);
    expect(observe(299.9).reentered).toBe(true);
  });

  test.each([
    ['GPS-hopp', () => ({ _gpsJumpDetected: true })],
    ['osäker position', () => ({ _positionUncertain: true })],
    ['gammal positionsklocka med färskt livstecken', () => ({ timestamp: now - 11 * 60000, lastPositionUpdate: now - 11 * 60000, _lastSeen: now })],
    ['gammalt hubfix med färsk mottagning', () => ({ fixTs: now - AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS - 1 })],
    ['gammalt streamfix med färsk mottagning', () => ({ fixFeed: 'aisstream', fixTs: now - AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS - 1 })],
    ['framtida fix', () => ({ fixTs: now + AIS_CONFIG.AISHUB.SEEN_MAX_FUTURE_SKEW_MS + 1 })],
    ['hubfix utan fixtid', () => ({ fixTs: undefined })],
    ['ogiltig position', () => ({ lat: null })],
  ])('%s räknas inte som utfärdsbevis', (label, overrides) => {
    tracker.reserve(fix());
    now += 60000;
    expect(tracker.observe(fix(450, overrides()))).toEqual({ changed: false, reentered: false });
    expect(observe(460)).toEqual({ changed: true, reentered: false });
    expect(observe(200).reentered).toBe(false);
    expect(tracker.holds(MMSI)).toBe(true);
  });

  test('identisk och bakåtgående fixtid över källbyte kan varken bekräfta exit eller återkomst', () => {
    tracker.reserve(fix());
    observe(400);
    const outsideTs = now;
    expect(observe(410, { fixTs: outsideTs })).toEqual({ changed: false, reentered: false });
    expect(observe(420, { fixTs: outsideTs - 1, fixFeed: 'aisstream' })).toEqual({ changed: false, reentered: false });
    expect(observe(430)).toEqual({ changed: true, reentered: false });
    const exitTs = now;
    expect(observe(200, { fixTs: exitTs }).reentered).toBe(false);
    expect(observe(200).reentered).toBe(true);
  });

  test('fartgivarlös rörelse och äldre streamformat kan bevisa verklig utfärd', () => {
    tracker.reserve(fix(200, { fixFeed: 'aisstream', fixTs: undefined, sog: null }));
    expect(observe(400, { fixFeed: 'aisstream', fixTs: undefined, sog: null }).changed).toBe(true);
    expect(observe(400, { fixFeed: 'aisstream', fixTs: undefined, sog: null }).changed).toBe(true);
    expect(observe(200, { fixFeed: 'aisstream', fixTs: undefined, sog: null }).reentered).toBe(true);
  });

  test('reservation kräver en färsk faktisk position inom 350 m', () => {
    expect(tracker.reserve(fix(350.1))).toBeNull();
    expect(tracker.reserve(fix(200, { _gpsJumpDetected: true }))).toBeNull();
    expect(tracker.reserve(fix(200, { mmsi: '__proto__' }))).toBeNull();
    expect(tracker.reserve(fix(349.9))).not.toBeNull();
  });

  test('rollback tar bara bort det egna försöket och kan inte radera ett nytt besök', () => {
    const first = tracker.reserve(fix());
    expect(tracker.rollback(MMSI, { ...first })).toBe(false);
    expect(tracker.rollback(MMSI, first)).toBe(true);
    const second = tracker.reserve(fix());
    depart();
    observe(200);
    const third = tracker.reserve(fix());
    expect(tracker.rollback(MMSI, second)).toBe(false);
    expect(tracker.holds(MMSI)).toBe(true);
    expect(tracker.rollback(MMSI, third)).toBe(true);
  });

  test('omstart, lång AIS-tystnad och externa mutationer kan inte öppna ett pågående besök', () => {
    tracker.reserve(fix());
    observe(400);
    const snapshot = tracker.exportSnapshot();
    now += 30 * 24 * 60 * 60 * 1000;
    const restored = new TriggerPointVisitTracker({ now: () => now });
    expect(restored.loadSnapshot(snapshot)).toBe(1);
    snapshot.entries[KANAL_KEY].exitedAt = now;
    expect(restored.exportSnapshot().entries[KANAL_KEY].exitedAt).toBeNull();
    expect(restored.holds(MMSI)).toBe(true);
    expect(restored.observe(fix(200))).toEqual({ changed: true, reentered: false });
    const exported = restored.exportSnapshot();
    exported.entries[KANAL_KEY].outsideFixTs = now;
    expect(restored.exportSnapshot().entries[KANAL_KEY].outsideFixTs).toBeNull();
  });

  test('en sparad utfärd och dess fixtid överlever omstart', () => {
    tracker.reserve(fix());
    depart();
    const snapshot = tracker.exportSnapshot();
    const restored = new TriggerPointVisitTracker({ now: () => now });
    expect(restored.loadSnapshot(snapshot)).toBe(1);
    expect(restored.observe(fix(200)).reentered).toBe(false);
    now += 60000;
    expect(restored.observe(fix(200)).reentered).toBe(true);
  });

  test('ELFKUNGENs verkliga retur genom zonen efter 43 min glapp fungerar även efter omstart', () => {
    const rawFix = (time, lat, lon) => {
      now = Date.parse(`2026-08-04T${time}Z`);
      return fix(0, {
        mmsi: '265573130', lat, lon, fixFeed: 'aisstream',
      });
    };
    tracker.reserve(rawFix('10:03:05.579', 58.26748833333333, 12.268783333333333));
    tracker.observe(rawFix('10:06:06.645', 58.271496666666664, 12.273465));
    tracker.observe(rawFix('10:11:35.255', 58.278958333333335, 12.28154));
    tracker.observe(rawFix('12:00:23.237', 58.294325, 12.295821666666665));
    const restored = new TriggerPointVisitTracker({ now: () => now });
    restored.loadSnapshot(tracker.exportSnapshot());
    // Slutpunkten ligger 301,6 m bort, men det faktiska segmentet passerar
    // 102,9 m från punkten. Ingen vidgning av notisradien behövs.
    expect(restored.observe(rawFix('12:43:34.756', 58.266245, 12.265438333333332)))
      .toEqual({ changed: true, reentered: true });
    expect(restored.holds('265573130')).toBe(false);
  });

  test.each([false, true])('ELFKUNGEN 14/7: andra utanförfixen bevisar retur endast efter ren första fix (GPS-osäker=%s)', (uncertain) => {
    const point = BRIDGES.stallbackabron;
    const rawFix = (time, lat, lon, extra = {}) => {
      now = Date.parse(`2026-07-14T${time}Z`);
      return fix(0, {
        mmsi: '265573130', lat, lon, fixFeed: 'aisstream', ...extra,
      });
    };
    tracker.reserve(rawFix('10:41:21.190', 58.30903166666667, 12.315893333333333), point.name);
    tracker.observe(rawFix('10:43:20.028', 58.31209166666667, 12.318808333333333), point.name);
    tracker.observe(rawFix('12:42:22.241', 58.313586666666666, 12.319473333333333, { _positionUncertain: uncertain }), point.name);
    const result = tracker.observe(rawFix('12:51:23.149', 58.29694666666667, 12.299408333333334), point.name);
    expect(result.reentered).toBe(!uncertain);
    expect(tracker.holds('265573130', point.name)).toBe(uncertain);
  });

  test('två rena utanförfixar på samma sida bekräftar bara utfärd, ingen återkomst', () => {
    const point = BRIDGES.stallbackabron;
    tracker.reserve(pointFix(point, 100), point.name);
    now += 60000;
    tracker.observe(pointFix(point, 450), point.name);
    now += 60000;
    expect(tracker.observe(pointFix(point, 1700), point.name)).toEqual({ changed: true, reentered: false });
    expect(tracker.holds(MMSI, point.name)).toBe(true);
    expect(tracker.exportSnapshot().entries[`${MMSI}:${point.name}`].exitedAt).toBe(now);
  });

  test('latitudbyte utanför zonen är inte återkomst när segmentet missar cirkeln', () => {
    tracker.reserve(fix());
    depart();
    observe(400, { lon: POINT.lon + 0.02 });
    expect(observe(-400, { lon: POINT.lon + 0.02 })).toEqual({ changed: false, reentered: false });
    expect(tracker.holds(MMSI)).toBe(true);
  });

  test('GPS-misstänkt retur och mer än sex timmar gammalt segment får inte bevisa återkomst', () => {
    tracker.reserve(fix());
    depart();
    expect(observe(-400, { _positionUncertain: true })).toEqual({ changed: false, reentered: false });
    now += 6 * 60 * 60 * 1000;
    expect(observe(-400).reentered).toBe(false);
  });

  test('både påbörjad och återtagen utfärd sparas direkt och överlever en krasch', () => {
    tracker.reserve(fix());
    expect(observe(400).changed).toBe(true);
    let snapshot = tracker.exportSnapshot();
    tracker = new TriggerPointVisitTracker({ now: () => now });
    tracker.loadSnapshot(snapshot);
    expect(observe(200).changed).toBe(true);
    snapshot = tracker.exportSnapshot();
    tracker = new TriggerPointVisitTracker({ now: () => now });
    tracker.loadSnapshot(snapshot);
    expect(observe(400)).toEqual({ changed: true, reentered: false });
    expect(tracker.exportSnapshot().entries[KANAL_KEY].exitedAt).toBeNull();
  });

  test('bara avslutade besök prunas efter sex timmar', () => {
    tracker.reserve(fix());
    depart();
    tracker.reserve(fix(200, { mmsi: '265070060' }));
    now += 6 * 60 * 60 * 1000 + 1;
    expect(Object.keys(tracker.exportSnapshot().entries)).toEqual(['265070060:Kanalinfarten']);
  });

  test('skadade, framtida och inkonsekventa snapshotposter avvisas', () => {
    const valid = {
      startedAt: now, lastFixTs: now, outsideFixTs: null, exitedAt: null,
    };
    expect(tracker.loadSnapshot({ version: 2, entries: { [MMSI]: valid } })).toBe(0);
    expect(tracker.loadSnapshot({
      version: 1,
      entries: {
        [MMSI]: valid,
        265070060: { ...valid, startedAt: Infinity },
        230693000: { ...valid, exitedAt: now },
        276015380: { ...valid, outsideFixTs: now + 1 },
        211231860: { ...valid, lastFixTs: now + 24 * 60 * 60 * 1000 },
        bad: valid,
      },
    })).toBe(1);
  });

  test('2048-taket gäller både läsning och skrivning; avslutade poster släpps först', () => {
    const entries = {};
    for (let i = 0; i < 4096; i++) {
      entries[String(200000000 + i)] = {
        startedAt: now - 60000, lastFixTs: now - 1000, outsideFixTs: null, exitedAt: null,
      };
    }
    entries['200000001'] = {
      startedAt: now - 60000, lastFixTs: now - 1000, outsideFixTs: now - 2000, exitedAt: now - 500,
    };
    expect(tracker.loadSnapshot({ version: 1, entries })).toBe(2048);
    tracker.reserve(fix());
    expect(tracker.holds('200000001')).toBe(false);
    expect(tracker.holds('200000000')).toBe(true);
    expect(Object.keys(tracker.exportSnapshot().entries)).toHaveLength(2048);
    for (let i = 0; i < 10; i++) tracker.reserve(fix(200, { mmsi: String(300000000 + i) }));
    expect(Object.keys(tracker.exportSnapshot().entries)).toHaveLength(2048);
    expect(tracker.holds('200000000')).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('2048 aktiva besök'));
  });
});
