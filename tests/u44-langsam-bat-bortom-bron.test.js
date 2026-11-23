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
 * mot bron (giltig kurs mot bron OCH minst 30 m närmare linjen än spärrens
 * ankare: läget längst från linjen som båten nått med två positioner i rad
 * medan förvarningen hållits inne på samma sida, vid första försöket
 * föregående position). Då är det ruttlåset som pekar fel. Ett ensamt kursvärde mot bron
 * utan förflyttning (brus i krypfart) räcker inte. Omgång 5: i varv 2 mättes
 * förflyttningen sedan föregående position (10 m), vilket aldrig släppte vid
 * tät rapportering i krypfart och släppte på GPS-brus (granskarens två fel).
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
    // Omgång 5: undantaget jämför med spärrens ankare (läget längst från
    // linjen som båten nått med två positioner i rad medan förvarningen
    // hållits inne; vid första försöket föregående position), inte med
    // föregående position som i varv 2.
    const MMSI = '940047001';
    const kryp = (d, extra = {}) => vessel(at(KLAFF, d), {
      mmsi: MMSI, name: 'KRYPBRUS', sog: 1.0, cog: 210, _routeDirection: 'north', ...extra,
    });
    // Första inhållna positionen: kursen bort från bron (det omvända värdet).
    const ankare = async (app, d) => {
      expect(await notify(app, KLAFF, kryp(d, { cog: 30 }))).toEqual([]);
      jest.advanceTimersByTime(60000);
    };
    /** Kör positionerna i tur och ordning; ger indexet för den första som gav en notis, annars -1. */
    const serie = async (app, avstand, extra = {}, stegMs = 10000) => {
      let prev = null;
      for (const [i, d] of avstand.entries()) {
        // eslint-disable-next-line no-await-in-loop
        const sent = await notify(app, KLAFF, kryp(d, { lastPosition: prev, ...extra }));
        if (sent.length > 0) return i;
        prev = at(KLAFF, d);
        jest.advanceTimersByTime(stegMs);
      }
      return -1;
    };

    test('kursen mot bron och 30 m närmare linjen än ankaret: förvarningen går ut', async () => {
      const app = await boot();
      await ankare(app, 260);
      const v = kryp(229, { lastPosition: at(KLAFF, 260) });
      expect(app._getNotificationDirection(v, cand(KLAFF, v))).toBe('northbound');
      const sent = await notify(app, KLAFF, v);
      expect(sent).toHaveLength(1);
      expect(sent[0].message).toMatch(/^KRYPBRUS närmar sig Klaffbron/);
    });

    test('första försöket utan föregående position hålls inne och sätter ankaret', async () => {
      const app = await boot();
      expect(await notify(app, KLAFF, kryp(230))).toEqual([]);
      expect(app._slowBridgeBehindHolds.get(MMSI).get('Klaffbron')).toEqual({ side: 1, anchorM: expect.closeTo(230, 0) });
    });

    test('första försöket: föregående position 32 m längre bort och kursen mot bron släpper', async () => {
      // Järnvägsbron och Stridsbergsbron ligger 257 m isär; den andra bron blir
      // ofta kandidat först när båten redan är på väg mot den.
      const app = await boot();
      expect(await notify(app, KLAFF, kryp(230, { lastPosition: at(KLAFF, 262) }))).toHaveLength(1);
    });

    test('första försöket: föregående position 25 m längre bort hålls inne; ankaret blir positionens eget avstånd', async () => {
      const app = await boot();
      expect(await notify(app, KLAFF, kryp(230, { lastPosition: at(KLAFF, 255) }))).toEqual([]);
      expect(app._slowBridgeBehindHolds.get(MMSI).get('Klaffbron').anchorM).toBeCloseTo(230, 0);
      jest.advanceTimersByTime(30000);
      expect(await notify(app, KLAFF, kryp(205, { lastPosition: at(KLAFF, 230) }))).toEqual([]);
      jest.advanceTimersByTime(30000);
      expect(await notify(app, KLAFF, kryp(199, { lastPosition: at(KLAFF, 205) }))).toHaveLength(1);
    });

    test('föregående position på andra sidan av linjen räknas inte till ankaret', async () => {
      const app = await boot();
      expect(await notify(app, KLAFF, kryp(230, { lastPosition: at(KLAFF, -40) }))).toEqual([]);
      expect(app._slowBridgeBehindHolds.get(MMSI).get('Klaffbron').anchorM).toBeCloseTo(230, 0);
    });

    test('granskarens fel 1: tät rapportering i krypfart utan brus (1 kn, 10 s, 5 m per position) släpper vid 30 m', async () => {
      const app = await boot();
      await ankare(app, 230);
      // 225, 220, … 195: första positionen minst 30 m närmare än 230 är 200 (index 5).
      expect(await serie(app, [225, 220, 215, 210, 205, 200, 195])).toBe(5);
    });

    test('granskarens fel 1: sakta krypfart på glesare kadens (0,3 kn, 60 s, 9 m per position) släpper vid 30 m', async () => {
      const app = await boot();
      await ankare(app, 250);
      expect(await serie(app, [241, 232, 223, 214, 205], { sog: 0.6 }, 60000)).toBe(3);
    });

    test('granskarens fel 2: stilla bortom bron med ±12 m brus och kursen mot bron: hålls inne', async () => {
      const app = await boot();
      await ankare(app, 150);
      // Hopp om 19–24 m mellan två fixar mot bron, men aldrig 30 m närmare än det
      // längsta läget (162 m).
      expect(await serie(app, [161, 140, 159, 138, 162, 141, 160, 139], { sog: 0.6 }, 30000)).toBe(-1);
    });

    test('gränsen: 29 m närmare ankaret hålls inne, 30 m släpper', async () => {
      const app = await boot();
      await ankare(app, 260);
      expect(await notify(app, KLAFF, kryp(231, { lastPosition: at(KLAFF, 260) }))).toEqual([]);
      jest.advanceTimersByTime(30000);
      expect(await notify(app, KLAFF, kryp(229.5, { lastPosition: at(KLAFF, 231) }))).toHaveLength(1);
    });

    test('ankaret följer en båt som glider bort (två positioner i rad): 25 m närmare hålls inne, 31 m släpper', async () => {
      const app = await boot();
      await ankare(app, 230);
      // Glider bort till 280 och 282 m (inhållen, kursen bort): ankaret flyttas
      // först när två positioner i rad har nått längre bort, till det kortare (280).
      expect(await notify(app, KLAFF, kryp(280, { cog: 30, lastPosition: at(KLAFF, 230) }))).toEqual([]);
      expect(app._slowBridgeBehindHolds.get(MMSI).get('Klaffbron').anchorM).toBeCloseTo(230, 0);
      jest.advanceTimersByTime(60000);
      expect(await notify(app, KLAFF, kryp(282, { cog: 30, lastPosition: at(KLAFF, 280) }))).toEqual([]);
      expect(app._slowBridgeBehindHolds.get(MMSI).get('Klaffbron').anchorM).toBeCloseTo(280, 0);
      jest.advanceTimersByTime(60000);
      expect(await notify(app, KLAFF, kryp(255, { lastPosition: at(KLAFF, 282) }))).toEqual([]);
      jest.advanceTimersByTime(60000);
      expect(await notify(app, KLAFF, kryp(249, { lastPosition: at(KLAFF, 255) }))).toHaveLength(1);
    });

    test('en ensam utliggare längre bort flyttar inte ankaret: nästa vanliga position med kursen mot bron hålls inne', async () => {
      const app = await boot();
      await ankare(app, 150);
      // En brusfix 100 m längre bort (inhållen, kursen bort) och sedan tillbaka vid 148 m.
      expect(await notify(app, KLAFF, kryp(250, { cog: 30, lastPosition: at(KLAFF, 150) }))).toEqual([]);
      jest.advanceTimersByTime(30000);
      expect(await notify(app, KLAFF, kryp(148, { sog: 0.6, lastPosition: at(KLAFF, 250) }))).toEqual([]);
      expect(app._slowBridgeBehindHolds.get(MMSI).get('Klaffbron').anchorM).toBeCloseTo(150, 0);
    });

    test('förflyttning mot bron men kursen bort från bron: hålls inne', async () => {
      const app = await boot();
      await ankare(app, 260);
      expect(await notify(app, KLAFF, kryp(220, { cog: 30, lastPosition: at(KLAFF, 260) }))).toEqual([]);
    });

    test('(iii) kursen saknas: hålls inne', async () => {
      const app = await boot();
      await ankare(app, 260);
      expect(await notify(app, KLAFF, kryp(220, { cog: null, lastPosition: at(KLAFF, 260) }))).toEqual([]);
    });

    test('(iii) kursen ogiltig (fart under 0,5 kn): hålls inne', async () => {
      const app = await boot();
      await ankare(app, 260);
      expect(await notify(app, KLAFF, kryp(220, { sog: 0.4, lastPosition: at(KLAFF, 260) }))).toEqual([]);
    });

    test('ankaret på andra sidan gäller inte: på nya sidan sätts ett nytt ankare', async () => {
      const app = await boot();
      await ankare(app, 260);
      // Nu söder om bron med låset söder; kursen norrut mot bron, 230 m från det gamla
      // ankaret räknat längs linjen men på andra sidan: första positionen här hålls inne.
      const syd = (d, extra) => kryp(d, { _routeDirection: 'south', cog: 30, ...extra });
      expect(await notify(app, KLAFF, syd(-200))).toEqual([]);
      expect(app._slowBridgeBehindHolds.get(MMSI).get('Klaffbron')).toEqual({ side: -1, anchorM: expect.closeTo(200, 0) });
      jest.advanceTimersByTime(60000);
      expect(await notify(app, KLAFF, syd(-169, { lastPosition: at(KLAFF, -200) }))).toHaveLength(1);
    });

    test('ankaret städas när notisen för bron har gått ut', async () => {
      const app = await boot();
      await ankare(app, 260);
      expect(await notify(app, KLAFF, kryp(229, { lastPosition: at(KLAFF, 260) }))).toHaveLength(1);
      expect(app._slowBridgeBehindHolds.has(MMSI)).toBe(false);
    });

    test('omstart: den nya instansen har inget ankare, och första positionen efter omstarten hålls inne', async () => {
      const app = await boot();
      await ankare(app, 260);
      await app.onUninit();
      const app2 = await boot();
      // Efter en omstart byggs båten upp på nytt: ingen föregående position.
      expect(await notify(app2, KLAFF, kryp(229))).toEqual([]);
      jest.advanceTimersByTime(60000);
      expect(await notify(app2, KLAFF, kryp(199, { lastPosition: at(KLAFF, 229) }))).toHaveLength(1);
    });

    test('stilla nu men två positioner i rad minst 30 m närmare ankaret (närmade sig mellan två glesa positioner): förvarningen går ut vid andra stilla positionen', async () => {
      const app = await boot();
      await ankare(app, 175);
      // Klass B under 2 kn: var tredje minut. Kursen mot bron i 1,8 kn vid 175 m, sedan still vid 46 och 40 m.
      expect(await notify(app, KLAFF, kryp(176, { sog: 1.8, lastPosition: at(KLAFF, 175) }))).toEqual([]);
      jest.advanceTimersByTime(150000);
      expect(await notify(app, KLAFF, kryp(46, { sog: 0.2, cog: 189, lastPosition: at(KLAFF, 176) }))).toEqual([]);
      jest.advanceTimersByTime(60000);
      expect(await notify(app, KLAFF, kryp(40, { sog: 0.2, cog: 32, lastPosition: at(KLAFF, 46) }))).toHaveLength(1);
    });

    test('stilla: en ensam utliggare 60 m närmare bron släpper inte', async () => {
      const app = await boot();
      await ankare(app, 180);
      expect(await notify(app, KLAFF, kryp(178, { sog: 0.2, cog: 100, lastPosition: at(KLAFF, 180) }))).toEqual([]);
      jest.advanceTimersByTime(30000);
      expect(await notify(app, KLAFF, kryp(118, { sog: 0.2, cog: 316, lastPosition: at(KLAFF, 178) }))).toEqual([]);
      jest.advanceTimersByTime(30000);
      expect(await notify(app, KLAFF, kryp(177, { sog: 0.2, cog: 242, lastPosition: at(KLAFF, 118) }))).toEqual([]);
    });

    test('(b) flyttar ankaret: hålls inne medan hon går bort i 3 kn, och kryper sedan tillbaka 32 m från det nya ankaret: förvarningen går ut', async () => {
      const app = await boot();
      await ankare(app, 150);
      // (b): fart bort med kursen i låsets riktning, två positioner längre bort (200, 230 m).
      expect(await notify(app, KLAFF, kryp(200, { sog: 3, cog: 30, lastPosition: at(KLAFF, 150) }))).toEqual([]);
      jest.advanceTimersByTime(30000);
      expect(await notify(app, KLAFF, kryp(230, { sog: 3, cog: 30, lastPosition: at(KLAFF, 200) }))).toEqual([]);
      jest.advanceTimersByTime(60000);
      // Ankaret står nu på 200 m; 168 m med kursen mot bron är 32 m närmare.
      expect(await notify(app, KLAFF, kryp(168, { lastPosition: at(KLAFF, 230) }))).toHaveLength(1);
    });

    test('(c) flyttar ankaret: glider bort med okänd riktning, kryper sedan tillbaka 32 m från det nya ankaret: förvarningen går ut', async () => {
      const app = await boot();
      await ankare(app, 150);
      // (c): okänd riktning (inget lås, under 0,5 kn), två positioner längre bort.
      const okand = (d, prev) => kryp(d, {
        _routeDirection: null, sog: 0.3, cog: 200, lastPosition: at(KLAFF, prev),
      });
      expect(app._getNotificationDirection(okand(200, 150), cand(KLAFF, okand(200, 150)))).toBe('unknown');
      expect(await notify(app, KLAFF, okand(200, 150))).toEqual([]);
      jest.advanceTimersByTime(60000);
      expect(await notify(app, KLAFF, okand(210, 200))).toEqual([]);
      jest.advanceTimersByTime(60000);
      expect(await notify(app, KLAFF, kryp(168, { lastPosition: at(KLAFF, 210) }))).toHaveLength(1);
    });

    test('när notisen gått ut gäller inte det gamla ankaret om bron blir aktuell igen', async () => {
      const app = await boot();
      await ankare(app, 260);
      expect(await notify(app, KLAFF, kryp(229, { lastPosition: at(KLAFF, 260) }))).toHaveLength(1);
      // Dedupen släpps (som vid en ny resa); samma läge prövas på nytt utan föregående position.
      app._triggeredBoatNearKeys.delete(`${MMSI}:Klaffbron`);
      app._persistentRecentTriggers?.delete(`${MMSI}:Klaffbron`);
      app._triggerPointVisits._entries.delete(`${MMSI}:Klaffbron`);
      jest.advanceTimersByTime(60000);
      expect(await notify(app, KLAFF, kryp(229))).toEqual([]);
      // Det nya ankaret (229 m) släpper först 30 m närmare: notiser går alltså att få.
      jest.advanceTimersByTime(60000);
      expect(await notify(app, KLAFF, kryp(198, { lastPosition: at(KLAFF, 229) }))).toHaveLength(1);
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
    expect(app._slowBridgeBehindHolds.get('228086830').get('Olidebron')).toEqual({ side: -1, anchorM: expect.closeTo(194, 0) });
    await app._onVesselRemoved({ mmsi: '228086830', vessel: v, reason: 'test' });
    expect(app._slowBridgeBehindHolds.has('228086830')).toBe(false);
  });
});
