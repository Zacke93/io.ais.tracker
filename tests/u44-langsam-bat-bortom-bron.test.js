'use strict';

/**
 * U44 punkt 3 (omgång 4): EN LÅNGSAM BÅT BORTOM EN BRO FÅR INGEN FÖRVARNING OM
 * DEN BRON FÖRRÄN RIKTNINGEN ÄR BELAGD.
 *
 * HALIFAX (20260708-21h) hördes först 194 m söder om Olidebron i 1,1 kn med
 * kursen 205°. Notisens riktning blev söderut, bron låg bakom henne i den
 * riktningen, och hon fick "närmar sig Olidebron, beräknad ankomst om 6
 * minuter". Hon drev på tillfartssidan och gick norrut genom bron elva minuter
 * senare. EUGENIE (20260804-both-21h) låg 268 m norr om Klaffbron i 1,9 kn med
 * kursen norrut, fick "närmar sig Klaffbron" och korsade aldrig bron. Under
 * 2 kn är kursen inget belägg för riktningen.
 *
 * Regeln (_isSlowVesselPastNotifiedBridge): positionen entydigt bortom
 * brolinjen i notisens riktning och (a) under 2 kn, eller (b) båten har redan
 * hållits inne för samma bro på samma sida och går nu bort i minst 2 kn med
 * kursen i notisens riktning, eller (c) har redan hållits inne och riktningen
 * är okänd. Ingen nyckel och inget besök skrivs. Passagenotiser går ut.
 *
 * Granskningen av D3 (H1): i (a) hålls inget inne när båten belagt rör sig
 * mot bron (giltig kurs mot bron OCH minst 10 m närmare linjen sedan
 * föregående position). Då är det ruttlåset som pekar fel. Ett ensamt
 * kursvärde mot bron utan förflyttning (brus i krypfart) räcker inte.
 */

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const geometry = require('../lib/utils/geometry');
const { BRIDGES } = require('../lib/constants');

/** Position d m från brolinjen längs kanalaxeln (+ = nordöstra sidan). */
const at = (bridge, d) => {
  const pe = ((bridge.axisBearing - 90) * Math.PI) / 180;
  const n = d * Math.cos(pe);
  const e = d * Math.sin(pe);
  return { lat: bridge.lat + n / 111320, lon: bridge.lon + e / (111320 * Math.cos((bridge.lat * Math.PI) / 180)) };
};

describe('U44 punkt 3: förvarning om en bro bakom en långsam båt', () => {
  let apps;
  let savedTestMode;
  const OLIDE = BRIDGES.olidebron;
  const KLAFF = BRIDGES.klaffbron;

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
    jest.spyOn(app._boatNearTrigger, 'trigger');
    return app;
  };

  const vessel = (pos, extra = {}) => ({
    mmsi: '228086830',
    name: 'HALIFAX',
    ...pos,
    lastPosition: null,
    _firstSeenLat: pos.lat,
    _firstSeenLon: pos.lon,
    sog: 1.1,
    cog: 205.3,
    _routeDirection: null,
    targetBridge: null,
    status: 'en-route',
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now(),
    ...extra,
  });
  const cand = (bridge, pos, source = 'current') => ({
    name: bridge.name,
    id: Object.keys(BRIDGES).find((k) => BRIDGES[k] === bridge),
    distance: geometry.calculateDistance(pos.lat, pos.lon, bridge.lat, bridge.lon),
    source,
  });
  const notify = async (app, bridge, v) => {
    app._boatNearTrigger.trigger.mockClear();
    await app._triggerBoatNearFlowForBridge(v, cand(bridge, v));
    return app._boatNearTrigger.trigger.mock.calls.map(([tokens]) => tokens);
  };
  const untouched = (app, mmsi, bridge) => {
    expect(app._triggeredBoatNearKeys.has(`${mmsi}:${bridge.name}`)).toBe(false);
    expect(app._triggerPointVisits.holds(mmsi, bridge.name)).toBe(false);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-08T08:29:04.000Z'));
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

  test('HALIFAX: 194 m söder om Olidebron i 1,1 kn söderut ger ingen notis, och inget skrivs', async () => {
    const app = await boot();
    const v = vessel(at(OLIDE, -194));
    expect(app._getNotificationDirection(v, cand(OLIDE, v))).toBe('southbound');
    expect(await notify(app, OLIDE, v)).toEqual([]);
    untouched(app, '228086830', OLIDE);
  });

  test('HALIFAX: när hon går mot bron (160 m söder, 4,2 kn norrut) kommer förvarningen norrut', async () => {
    const app = await boot();
    const first = vessel(at(OLIDE, -194));
    await notify(app, OLIDE, first);
    jest.setSystemTime(new Date('2026-07-08T08:39:34.000Z'));
    const v = vessel(at(OLIDE, -160), {
      sog: 4.2, cog: 33.7, lastPosition: { lat: first.lat, lon: first.lon },
    });
    const sent = await notify(app, OLIDE, v);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ direction: 'norrut', already_passed: false, eta_minutes: 1 });
    expect(sent[0].message).toBe('HALIFAX närmar sig Olidebron, beräknad ankomst om 1 minut');
  });

  test('EUGENIE: 268 m norr om Klaffbron i 1,9 kn norrut (med föregående position) ger ingen notis', async () => {
    const app = await boot();
    const v = vessel(at(KLAFF, 268), {
      mmsi: '265788210', name: 'EUGENIE', sog: 1.9, cog: 37.7, lastPosition: at(KLAFF, 232),
    });
    expect(await notify(app, KLAFF, v)).toEqual([]);
    untouched(app, '265788210', KLAFF);
  });

  test('gränsen: samma position i 2,0 kn ger förvarningen som förut (U44 punkt 1 och 4 börjar där)', async () => {
    const app = await boot();
    const v = vessel(at(KLAFF, 268), {
      mmsi: '265788210', name: 'EUGENIE', sog: 2.0, cog: 37.7, lastPosition: at(KLAFF, 232),
    });
    const sent = await notify(app, KLAFF, v);
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toMatch(/^EUGENIE närmar sig Klaffbron/);
  });

  test('(b) hålls inne i krypfart 90 m bortom bron och sätter sedan fart bort: ingen notis', async () => {
    const app = await boot();
    const first = vessel(at(KLAFF, 90), {
      mmsi: '265000001', name: 'ACCEL', sog: 1.0, cog: 30,
    });
    expect(await notify(app, KLAFF, first)).toEqual([]);
    jest.advanceTimersByTime(60000);
    const v = vessel(at(KLAFF, 121), {
      mmsi: '265000001', name: 'ACCEL', sog: 5, cog: 30, lastPosition: at(KLAFF, 90),
    });
    expect(await notify(app, KLAFF, v)).toEqual([]);
    untouched(app, '265000001', KLAFF);
  });

  test('(b) motfall: utan tidigare spärr ger samma position i 5 kn förvarningen som förut', async () => {
    const app = await boot();
    const v = vessel(at(KLAFF, 121), {
      mmsi: '265000002', name: 'FART', sog: 5, cog: 30, lastPosition: at(KLAFF, 90),
    });
    expect(await notify(app, KLAFF, v)).toHaveLength(1);
  });

  test('(b) motfall: hon vänder mot bron i 3 kn medan ruttlåset ännu säger norr: förvarningen går ut', async () => {
    const app = await boot();
    const first = vessel(at(KLAFF, 90), {
      mmsi: '265000003', name: 'VANDER', sog: 1.0, cog: 30, _routeDirection: 'north',
    });
    expect(await notify(app, KLAFF, first)).toEqual([]);
    jest.advanceTimersByTime(60000);
    const v = vessel(at(KLAFF, 85), {
      mmsi: '265000003', name: 'VANDER', sog: 3, cog: 210, _routeDirection: 'north', lastPosition: at(KLAFF, 90),
    });
    expect(await notify(app, KLAFF, v)).toHaveLength(1);
  });

  test('(c) hålls inne och ligger sedan still med okänd riktning: ingen notis', async () => {
    const app = await boot();
    const first = vessel(at(OLIDE, -194));
    expect(await notify(app, OLIDE, first)).toEqual([]);
    jest.advanceTimersByTime(60000);
    const v = vessel(at(OLIDE, -230), { sog: 0.2, cog: 123, lastPosition: at(OLIDE, -194) });
    expect(app._getNotificationDirection(v, cand(OLIDE, v))).toBe('unknown');
    expect(await notify(app, OLIDE, v)).toEqual([]);
    untouched(app, '228086830', OLIDE);
  });

  test('(c) motfall: hålls inne söder om bron, ligger sedan på linjen med okänd riktning: notisen som förut', async () => {
    const app = await boot();
    expect(await notify(app, OLIDE, vessel(at(OLIDE, -194)))).toEqual([]);
    jest.advanceTimersByTime(600000);
    const v = vessel(at(OLIDE, -5), { sog: 0.2, cog: 123, lastPosition: at(OLIDE, -194) });
    expect(await notify(app, OLIDE, v)).toHaveLength(1);
  });

  test('(c) motfall: okänd riktning utan tidigare spärr ger notisen som förut', async () => {
    const app = await boot();
    const v = vessel(at(OLIDE, -230), { sog: 0.2, cog: 123 });
    expect(await notify(app, OLIDE, v)).toHaveLength(1);
  });

  test('spärren gäller bara på sin sida: hålls inne söder om Olidebron, syns sedan norr om bron i 5 kn norrut', async () => {
    const app = await boot();
    expect(await notify(app, OLIDE, vessel(at(OLIDE, -194)))).toEqual([]);
    jest.advanceTimersByTime(300000);
    // Hon har korsat linjen: spärren (söder) gäller inte längre. Formen är
    // S4:s och BN2:s sak; här är ingen passage bokförd.
    const v = vessel(at(OLIDE, 120), { sog: 5, cog: 40, lastPosition: at(OLIDE, -194) });
    expect(await notify(app, OLIDE, v)).toHaveLength(1);
  });

  test('en passagenotis går ut även för en långsam båt bortom bron (S4: bron nyss bokförd)', async () => {
    const app = await boot();
    const v = vessel(at(KLAFF, 40), {
      mmsi: '265000006',
      name: 'LANGSAM',
      sog: 1.2,
      cog: 30,
      lastPosition: at(KLAFF, -20),
      lastPassedBridge: 'Klaffbron',
      lastPassedBridgeTime: Date.now() - 5000,
    });
    const sent = await notify(app, KLAFF, v);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ already_passed: true, eta_minutes: -1 });
    expect(sent[0].message).toBe('LANGSAM har precis passerat Klaffbron');
  });

  test('motfall: hålls inne söderut, vänder och kryper norrut mot bron i 1 kn: förvarningen norrut', async () => {
    const app = await boot();
    await notify(app, OLIDE, vessel(at(OLIDE, -194)));
    jest.advanceTimersByTime(120000);
    const v = vessel(at(OLIDE, -150), { sog: 1.0, cog: 35, lastPosition: at(OLIDE, -194) });
    const sent = await notify(app, OLIDE, v);
    expect(sent).toHaveLength(1);
    expect(sent[0].direction).toBe('norrut');
  });

  test('motfall: kryper i kö mot Klaffbron på rätt sida (200 m söder, 1 kn norrut): förvarningen som förut', async () => {
    const app = await boot();
    const v = vessel(at(KLAFF, -200), {
      mmsi: '265000004', name: 'KO', sog: 1.0, cog: 30, targetBridge: 'Klaffbron',
    });
    const sent = await notify(app, KLAFF, v);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ direction: 'norrut', already_passed: false });
  });

  test('motfall: på linjen (±10 m) gäller inte regeln', async () => {
    const app = await boot();
    const v = vessel(at(KLAFF, 8), {
      mmsi: '265000005', name: 'LINJE', sog: 1.0, cog: 30,
    });
    expect(await notify(app, KLAFF, v)).toHaveLength(1);
  });

  test('motfall: en ny båt i minst 2 kn mer än 70 m bortom bron får passagenotisen (U44 punkt 1)', async () => {
    const app = await boot();
    const v = vessel(at(OLIDE, 88), {
      mmsi: '211478350', name: 'SABETH', sog: 5.5, cog: 44.5,
    });
    const sent = await notify(app, OLIDE, v);
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toBe('SABETH har precis passerat Olidebron');
  });

  describe('H1 (granskningen av D3): fel ruttlås för en båt som verkligen närmar sig', () => {
    // Kryper söderut mot Klaffbron norrifrån; låset norr (ur ett omvänt första
    // kursvärde), så bron ligger "bakom" henne i notisens riktning.
    const kryp = (d, extra = {}) => vessel(at(KLAFF, d), {
      mmsi: '940047001', name: 'KRYPBRUS', sog: 1.0, cog: 210, _routeDirection: 'north', ...extra,
    });

    test('kursen mot bron och 30 m närmare linjen: förvarningen går ut', async () => {
      const app = await boot();
      const v = kryp(230, { lastPosition: at(KLAFF, 260) });
      expect(app._getNotificationDirection(v, cand(KLAFF, v))).toBe('northbound');
      const sent = await notify(app, KLAFF, v);
      expect(sent).toHaveLength(1);
      expect(sent[0].message).toMatch(/^KRYPBRUS närmar sig Klaffbron/);
    });

    test('efter en spärr: när hon sedan kryper mot bron går förvarningen ut', async () => {
      const app = await boot();
      expect(await notify(app, KLAFF, kryp(260, { cog: 30, lastPosition: at(KLAFF, 262) }))).toEqual([]);
      jest.advanceTimersByTime(60000);
      expect(await notify(app, KLAFF, kryp(229, { lastPosition: at(KLAFF, 260) }))).toHaveLength(1);
    });

    test('(ii) kursen mot bron men ingen förflyttning (brus i krypfart bortom bron): hålls inne', async () => {
      const app = await boot();
      expect(await notify(app, KLAFF, kryp(230, { sog: 0.6, lastPosition: at(KLAFF, 233) }))).toEqual([]);
    });

    test('(ii) kursen mot bron men båten glider bort från bron: hålls inne', async () => {
      const app = await boot();
      expect(await notify(app, KLAFF, kryp(250, { lastPosition: at(KLAFF, 220) }))).toEqual([]);
    });

    test('förflyttning mot bron men kursen bort från bron: hålls inne', async () => {
      const app = await boot();
      expect(await notify(app, KLAFF, kryp(230, { cog: 30, lastPosition: at(KLAFF, 260) }))).toEqual([]);
    });

    test('(iii) kursen saknas: hålls inne', async () => {
      const app = await boot();
      expect(await notify(app, KLAFF, kryp(230, { cog: null, lastPosition: at(KLAFF, 260) }))).toEqual([]);
    });

    test('(iii) kursen ogiltig (fart under 0,5 kn): hålls inne', async () => {
      const app = await boot();
      expect(await notify(app, KLAFF, kryp(230, { sog: 0.4, lastPosition: at(KLAFF, 260) }))).toEqual([]);
    });

    test('ingen föregående position: hålls inne', async () => {
      const app = await boot();
      expect(await notify(app, KLAFF, kryp(230))).toEqual([]);
    });

    test('HALIFAX hålls inne som förut (kursen 205° söder om bron pekar bort från den)', async () => {
      const app = await boot();
      const v = vessel(at(OLIDE, -194), { lastPosition: at(OLIDE, -180) });
      expect(await notify(app, OLIDE, v)).toEqual([]);
    });
  });

  describe('M1 (granskningen av D3): (b) och (c) med fällande test', () => {
    test('(b) hålls inne norr om Klaffbron och går sedan norrut i 3 kn 150 m bortom: ingen notis', async () => {
      const app = await boot();
      expect(await notify(app, KLAFF, vessel(at(KLAFF, 90), {
        mmsi: '265000011', name: 'B2', sog: 1.0, cog: 30,
      }))).toEqual([]);
      jest.advanceTimersByTime(120000);
      const v = vessel(at(KLAFF, 150), {
        mmsi: '265000011', name: 'B2', sog: 3, cog: 32, lastPosition: at(KLAFF, 120),
      });
      expect(await notify(app, KLAFF, v)).toEqual([]);
    });

    test('(b) kursen i östra dödbandet (inte belagd norr) efter spärren: förvarningen går ut', async () => {
      const app = await boot();
      expect(await notify(app, KLAFF, vessel(at(KLAFF, 90), {
        mmsi: '265000012', name: 'B3', sog: 1.0, cog: 30, _routeDirection: 'north',
      }))).toEqual([]);
      jest.advanceTimersByTime(60000);
      const v = vessel(at(KLAFF, 121), {
        mmsi: '265000012', name: 'B3', sog: 5, cog: 90, _routeDirection: 'north', lastPosition: at(KLAFF, 90),
      });
      expect(await notify(app, KLAFF, v)).toHaveLength(1);
    });

    test('(b) spärren norr om bron gäller inte söder om den: söderut i 4 kn 120 m söder om bron ger notisen', async () => {
      const app = await boot();
      expect(await notify(app, KLAFF, vessel(at(KLAFF, 90), {
        mmsi: '265000013', name: 'B4', sog: 1.0, cog: 30,
      }))).toEqual([]);
      jest.advanceTimersByTime(600000);
      const v = vessel(at(KLAFF, -120), {
        mmsi: '265000013', name: 'B4', sog: 4, cog: 212, lastPosition: at(KLAFF, -60),
      });
      expect(await notify(app, KLAFF, v)).toHaveLength(1);
    });

    test('(c) hålls inne och ligger senare på annan plats på samma sida, okänd riktning: ingen notis', async () => {
      const app = await boot();
      expect(await notify(app, KLAFF, vessel(at(KLAFF, 90), {
        mmsi: '265000014', name: 'C2', sog: 1.0, cog: 30,
      }))).toEqual([]);
      jest.advanceTimersByTime(300000);
      const v = vessel(at(KLAFF, 160), {
        mmsi: '265000014', name: 'C2', sog: 0.3, cog: 200, lastPosition: at(KLAFF, 150),
      });
      expect(app._getNotificationDirection(v, cand(KLAFF, v))).toBe('unknown');
      expect(await notify(app, KLAFF, v)).toEqual([]);
    });

    test('(c) hålls inne söder om Olidebron, ligger sedan 15 m norr om bron i 0,3 kn med okänd riktning: notisen går ut', async () => {
      const app = await boot();
      expect(await notify(app, OLIDE, vessel(at(OLIDE, -194)))).toEqual([]);
      jest.advanceTimersByTime(600000);
      const v = vessel(at(OLIDE, 15), { sog: 0.3, cog: 123, lastPosition: at(OLIDE, 10) });
      expect(app._getNotificationDirection(v, cand(OLIDE, v))).toBe('unknown');
      expect(await notify(app, OLIDE, v)).toHaveLength(1);
    });

    test('(c) hålls inne norr om Klaffbron, ligger sedan 40 m söder om bron i 0,2 kn med okänd riktning: notisen går ut', async () => {
      const app = await boot();
      expect(await notify(app, KLAFF, vessel(at(KLAFF, 90), {
        mmsi: '265000015', name: 'C3', sog: 1.0, cog: 30,
      }))).toEqual([]);
      jest.advanceTimersByTime(600000);
      const v = vessel(at(KLAFF, -40), {
        mmsi: '265000015', name: 'C3', sog: 0.2, cog: 300, lastPosition: at(KLAFF, -38),
      });
      expect(app._getNotificationDirection(v, cand(KLAFF, v))).toBe('unknown');
      expect(await notify(app, KLAFF, v)).toHaveLength(1);
    });
  });

  test('fältloggen får raden första gången per båt och bro, därefter debug', async () => {
    const app = await boot();
    await notify(app, OLIDE, vessel(at(OLIDE, -194)));
    jest.advanceTimersByTime(60000);
    await notify(app, OLIDE, vessel(at(OLIDE, -230), { sog: 0.9, lastPosition: at(OLIDE, -194) }));
    const rader = (fn) => fn.mock.calls.filter(([m]) => String(m).includes('FLOW_TRIGGER_SLOW_BRIDGE_BEHIND')).length;
    expect(rader(app.log)).toBe(1);
    expect(rader(app.debug)).toBe(1);
  });

  test('spärren städas när båten raderas', async () => {
    const app = await boot();
    const v = vessel(at(OLIDE, -194));
    await notify(app, OLIDE, v);
    expect(app._slowBridgeBehindHolds.get('228086830').get('Olidebron')).toBe(-1);
    await app._onVesselRemoved({ mmsi: '228086830', vessel: v, reason: 'test' });
    expect(app._slowBridgeBehindHolds.has('228086830')).toBe(false);
  });
});
