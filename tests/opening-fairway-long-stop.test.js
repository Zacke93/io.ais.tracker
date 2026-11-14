'use strict';

jest.mock('homey');
const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const { BRIDGES, MOORING_DETECTION, MOORING_ZONES } = require('../lib/constants');

/**
 * Fältprovet 2026-11-12 (körning 1, familj A): en båt varnades för
 * Stridsbergsbron, stannade sedan 460 m norr om bron i farleden, utanför de
 * ritade kajzonerna, och låg helt stilla i nästan fyra timmar. Målbron tappades
 * efter 20 min (U27), 2 h-backstoppen förtöjde henne, och när hon till slut
 * lade ut och korsade bron spärrade ankomstspärren den nya varningen: ett stopp
 * innanför DISARM_MOORED_MIN_DISTANCE_M (600 m) registrerades aldrig, så den
 * fyra timmar gamla varningen räknades som samma ankomst.
 *
 * Rättningen (med revision 1 efter granskningen): innanför 600 m utanför
 * kajzonerna registreras ett farledsstopp med egen ålder från första stilla
 * fix. Det bekräftas när det är minst MAX_STATIONARY_WAIT_MS gammalt och
 * klassningen inte håller båten som köare mot kortets bro (förtöjd eller utan
 * kortets bro som målbro), och åldern överlever fartbrus, AIS-glapp och
 * omstart så länge båten ligger inom 50 m (M1, M2). Avgången kräver två
 * avgångsfix i följd, så ett ensamt GPS-hopp inte ger ett falskt kort (H1).
 * Köaren som appen håller kvar, ett kort stopp, U27-bandet under 2 h och
 * navstatus under 2 h är samma ankomst som förut. Positionerna ligger på en
 * egen, rak linje längs kanalens riktning norr om bron (45°), inte på fältets
 * spår.
 */
const MMSI = '265000901';
const KEY = `Stridsbergsbron|${MMSI}|southbound`;
const BRIDGE = BRIDGES.stridsbergsbron;
const AXIS_DEG = 45;
const START = Date.parse('2026-11-12T08:20:00Z');
const MIN = 60000;

// Punkten `meters` m från bron längs kanalens axel (negativt = söder om bron).
function along(meters) {
  const rad = (AXIS_DEG * Math.PI) / 180;
  return {
    lat: BRIDGE.lat + (meters * Math.cos(rad)) / 111320,
    lon: BRIDGE.lon + (meters * Math.sin(rad)) / (111320 * Math.cos((BRIDGE.lat * Math.PI) / 180)),
  };
}

describe('Långt stopp i farleden innanför 600 m: avgången efter 2 h är en ny ankomst', () => {
  let app;
  let store;
  let savedEnv;
  let savedMode;
  let cards;

  async function boot() {
    global.__TEST_MODE__ = true;
    app = new App();
    app.homey = {
      ...mockHomey,
      settings: {
        get: (key) => store[key] ?? null,
        set: (key, value) => {
          store[key] = JSON.parse(JSON.stringify(value));
        },
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    app.log = jest.fn(); app.error = jest.fn(); app.debug = jest.fn();
    await app.onInit();
    app._isConnected = true;
    app._lastConnectionLost = null;
    app._bridgeOpeningTrigger.clearTriggerCalls();
    cards.push(app._bridgeOpeningTrigger);
    global.__TEST_MODE__ = false;
  }

  beforeEach(async () => {
    jest.useFakeTimers({ now: START });
    savedEnv = process.env.NODE_ENV;
    savedMode = global.__TEST_MODE__;
    process.env.NODE_ENV = 'production';
    store = {};
    cards = [];
    await boot();
  });
  afterEach(async () => {
    await app.onUninit();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
    process.env.NODE_ENV = savedEnv;
    global.__TEST_MODE__ = savedMode;
    jest.useRealTimers();
  });

  async function fix(meters, sog, { dt = MIN, navStatus = 0, cog = 215 } = {}) {
    await jest.advanceTimersByTimeAsync(dt);
    app._processAISMessage({
      mmsi: MMSI,
      shipName: 'SYNT-FARLED',
      ...along(meters),
      sog,
      cog,
      navStatus,
      fixTs: Date.now(),
      fixFeed: 'aisstream',
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return app.vesselDataService.getVessel(MMSI);
  }

  async function restart() {
    await app.onUninit();
    await boot();
  }

  const warnings = () => cards.flatMap((card) => card.getTriggerCalls())
    .filter((call) => call.tokens.bridge_name === 'Stridsbergsbron');
  // Servicens nya kort som ankomstspärren tystade (samma ankomst). Visar att
  // motfallen faktiskt prövar spärren och inte bara saknar en ny avfyrning.
  const sameArrival = () => app.log.mock.calls
    .filter(([line]) => String(line).includes('[OPENING_DEDUP_PERSIST] Stridsbergsbron')).length;
  const stopOf = () => app._persistentOpeningWarnings.get(KEY)?.quayStop || null;

  // Söderut i 6 kn från 1,3 km, varning, inbromsning till stoppet.
  async function warnedArrival(stopAt) {
    for (const d of [1300, 1115, 930, 745]) await fix(d, 6);
    for (let d = 600; d > stopAt; d -= 70) await fix(d, 3);
    await fix(stopAt, 0.4);
    expect(warnings()).toHaveLength(1);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
    const { lat, lon } = along(stopAt);
    expect(app.vesselDataService.isNearMooringZone(lat, lon)).toBe(false);
  }

  // Helt stilla på samma plats, en rapport var tredje minut.
  async function lieStill(at, ms, opts = {}) {
    let vessel = null;
    for (let elapsed = 0; elapsed < ms; elapsed += 3 * MIN) vessel = await fix(at, 0, { dt: 3 * MIN, ...opts });
    return vessel;
  }

  // Avgång mot bron i 3 kn (45 m per halvminut) förbi bron. Returnerar den
  // sanna korsningen, interpolerad mellan sista fixen norr och första söder om
  // bron (bron ligger i punkten 0 på axeln).
  async function departAndPass(from) {
    let crossingMs = null;
    let prev = { d: from, t: Date.now() };
    for (let d = from - 45; d > -150; d -= 45) {
      // eslint-disable-next-line no-await-in-loop
      await fix(d, 3, { dt: 30000, cog: 225 });
      if (crossingMs === null && d < 0) crossingMs = prev.t + (prev.d / (prev.d - d)) * (Date.now() - prev.t);
      prev = { d, t: Date.now() };
    }
    return crossingMs;
  }

  // Två kort, det andra minst 60 s före den sanna korsningen (samma golv som
  // buggjägarens T2-orakel och openingLeadS).
  function expectNewWarningBefore(crossingMs) {
    expect(warnings()).toHaveLength(2);
    const leadS = (crossingMs - Date.parse(warnings()[1].timestamp)) / 1000;
    expect(leadS).toBeGreaterThanOrEqual(60);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(false);
    expect(app.error).not.toHaveBeenCalled();
  }

  test('fältfallet: 3 h 54 min still 460 m norr om bron, sedan avgång ⇒ ny varning före passagen', async () => {
    await warnedArrival(460);
    // 20 min: målbron tappas (U27). 2 h: backstoppen förtöjer henne.
    const vessel = await lieStill(460, 234 * MIN);
    expect(vessel.targetBridge).toBeNull();
    expect(vessel._moored).toBe(true);
    expect(stopOf()).toMatchObject({ fairway: true, confirmed: true });
    expectNewWarningBefore(await departAndPass(460));
  });

  // H1 (granskningen, revision 1): ett ensamt fix ≥ 50 m mot bron i ≥ 0,5 kn
  // hos den förtöjda båten släppte förtöjningen och räknades som avgång. Målbro
  // och arm kom på samma fix, deadlinen hade redan passerat innanför ca 925 m,
  // och kortet gick direkt; den verkliga avgången 40 min senare spärrades.
  test.each([
    ['70 m mot bron i 0,6 kn (A5-värden)', 70, 0.6, 225],
    ['120 m mot bron i 3 kn', 120, 3.0, 200],
  ])('H1: ett GPS-hopp %s efter backstoppen ger inget kort; den verkliga avgången får kort', async (_, off, sog, cog) => {
    await warnedArrival(460);
    await lieStill(460, 150 * MIN);
    expect(stopOf()).toMatchObject({ fairway: true, confirmed: true });
    await fix(460 - off, sog, { dt: 3 * MIN, cog });
    expect(warnings()).toHaveLength(1);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
    await lieStill(460, 40 * MIN);
    expect(stopOf().departFixTs).toBeUndefined();
    expectNewWarningBefore(await departAndPass(460));
  });

  // N3 (omgranskningen, revision 2): H1:s klass i två former till. Drift över
  // två fix på samma förskjutning, och en utliggare följd av 20 min tystnad och
  // en ny utliggare. Det andra avgångsfixet ska komma inom 10 min och längre
  // från stoppet än det första.
  test('N3: drift två fix i rad på samma förskjutning (70 m, 0,6 kn) ger inget kort; den verkliga avgången får kort', async () => {
    await warnedArrival(460);
    await lieStill(460, 150 * MIN);
    await fix(390, 0.6, { dt: 3 * MIN, cog: 225 });
    await fix(390, 0.6, { dt: 3 * MIN, cog: 225 });
    expect(warnings()).toHaveLength(1);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
    await lieStill(460, 40 * MIN);
    expectNewWarningBefore(await departAndPass(460));
  });

  // Den andra utliggaren ligger längre bort än den första, så det är
  // tidsgränsen (inte kravet på fortsatt förflyttning) som prövas.
  test('N3: utliggare, 20 min tystnad, ny utliggare längre bort ger inget kort; den verkliga avgången får kort', async () => {
    await warnedArrival(460);
    await lieStill(460, 150 * MIN);
    await fix(390, 0.6, { dt: 3 * MIN, cog: 225 });
    await jest.advanceTimersByTimeAsync(20 * MIN);
    await fix(370, 0.6, { cog: 225 });
    expect(warnings()).toHaveLength(1);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
    await lieStill(460, 40 * MIN);
    expectNewWarningBefore(await departAndPass(460));
  });

  // N5 (omgranskningen): omförtöjning i krypfart (under 0,5 kn, alltså ingen
  // avgång) ≥ 50 m från ett bekräftat stopp. Det nya stoppet ärver
  // bekräftelsen efter 30 s, så avgången därifrån inom 2 h är en ny ankomst.
  test('N5: omförtöjning 80 m i krypfart efter ett bekräftat stopp, avgång 30 min senare ⇒ ny varning', async () => {
    await warnedArrival(460);
    await lieStill(460, 150 * MIN);
    expect(stopOf()).toMatchObject({ fairway: true, confirmed: true });
    for (const d of [440, 420, 400, 380]) await fix(d, 0.3, { dt: 3 * MIN, cog: 225 });
    expect(stopOf()).toMatchObject({ fairway: true, confirmed: true, afterConfirmedStop: true });
    await lieStill(380, 30 * MIN);
    expectNewWarningBefore(await departAndPass(380));
  });

  // M1 (granskningen): ett glapp på 15 min tog bort den mållösa båten; hon
  // återföddes utan stillhetsankare, och fältets fartbrus (0,3, 0,5, 1,4 kn på
  // samma plats) nollade klassningens klocka, så backstoppen hann aldrig.
  // Farledsstoppets egen ålder räknas på läget, inte på klockan.
  test('M1: AIS-glapp 15 min och fartbrus som i fältet under stoppet ⇒ ny varning före passagen', async () => {
    await warnedArrival(460);
    await lieStill(460, 60 * MIN);
    await fix(460, 0, { dt: 15 * MIN });
    await lieStill(460, 6 * MIN);
    await fix(460, 0.3);
    await fix(460, 0.3);
    await fix(460, 0.5);
    await lieStill(460, 27 * MIN);
    await fix(460, 1.4);
    await lieStill(460, 234 * MIN - (60 + 15 + 6 + 3 + 27 + 1) * MIN);
    expect(stopOf()).toMatchObject({ fairway: true, confirmed: true });
    expectNewWarningBefore(await departAndPass(460));
  });

  // L2 (granskningen): förut låste testet att omstarten nollade 2 h-klockan.
  // Stoppet överlever nu omstarten med sin egen ålder.
  test('M1: omstart efter 90 min, still 100 min till ⇒ stoppet är 3 h gammalt, ny varning vid avgången', async () => {
    await warnedArrival(460);
    await lieStill(460, 90 * MIN);
    await restart();
    const vessel = await lieStill(460, 100 * MIN);
    expect(vessel._moored).toBe(false);
    expect(stopOf()).toMatchObject({ fairway: true, confirmed: true });
    expectNewWarningBefore(await departAndPass(460));
  });

  test('motfall: omstart efter 60 min, still 40 min till (100 min totalt) ⇒ samma ankomst', async () => {
    await warnedArrival(460);
    await lieStill(460, 60 * MIN);
    await restart();
    await lieStill(460, 40 * MIN);
    expect(stopOf()).toMatchObject({ fairway: true, confirmed: false });
    await departAndPass(460);
    expect(warnings()).toHaveLength(1);
    expect(sameArrival()).toBe(1);
  });

  // Följd av M1, som Kajens övernattning: tystnad på samma plats räknas in i
  // stoppets ålder. Båten var stilla före tystnaden och är kvar inom 50 m efter.
  test('AIS av 3 h under stoppet, tillbaka på samma plats ⇒ stoppet är äldre än 2 h, ny varning vid avgången', async () => {
    await warnedArrival(460);
    await lieStill(460, 20 * MIN);
    await jest.advanceTimersByTimeAsync(180 * MIN);
    await fix(460, 0);
    await fix(460, 0);
    expect(stopOf()).toMatchObject({ fairway: true, confirmed: true });
    expectNewWarningBefore(await departAndPass(460));
  });

  // M2 (granskningen): i bandet 300–350 m tar U27 målbron, men en båt som
  // passerat en bro har färsk brokö, så backstoppen förtöjer henne aldrig.
  // Utan kortets bro som målbro håller appen henne inte längre som köare.
  test('M2: 320 m från bron i 4 h efter passerad Stallbackabron, målbron tappad ⇒ ny varning före passagen', async () => {
    await warnedArrival(320);
    const v0 = app.vesselDataService.getVessel(MMSI);
    if (!v0.passedBridges?.includes('Stallbackabron')) v0.passedBridges = [...(v0.passedBridges || []), 'Stallbackabron'];
    const vessel = await lieStill(320, 240 * MIN);
    expect(vessel.targetBridge).toBeNull();
    expect(vessel._moored).toBe(false);
    expect(stopOf()).toMatchObject({ fairway: true, confirmed: true });
    expectNewWarningBefore(await departAndPass(320));
  });

  test('motfall: 100 min still 460 m från bron (U27-bandet, under 2 h) ⇒ samma ankomst', async () => {
    await warnedArrival(460);
    const vessel = await lieStill(460, 100 * MIN);
    expect(vessel.targetBridge).toBeNull();
    expect(vessel._moored).toBe(false);
    expect(stopOf()).toMatchObject({ fairway: true, confirmed: false });
    await departAndPass(460);
    expect(warnings()).toHaveLength(1);
    expect(sameArrival()).toBe(1);
  });

  // Köaren som appen håller (målbron kvar, texten visar henne) får inget
  // andra kort hur länge hon än väntar (användarvalet 2026-09-06). Bankens
  // ANDREA låg 129 min på 145 m och MOKENDEIST 142 min på 114 m.
  test.each([
    ['250 m i 3 h', 250, 180],
    ['145 m i 130 min (ANDREA i banken)', 145, 130],
  ])('motfall: köaren i väntzonen som appen håller kvar, %s ⇒ inget andra kort', async (_, at, stillMin) => {
    await warnedArrival(at);
    const vessel = await lieStill(at, stillMin * MIN);
    expect(vessel._moored).toBe(false);
    expect(vessel.targetBridge).toBe('Stridsbergsbron');
    expect(stopOf()?.confirmed).not.toBe(true);
    await departAndPass(at);
    expect(warnings()).toHaveLength(1);
  });

  test('motfall: kort stopp (10 min) i farleden ⇒ samma ankomst', async () => {
    await warnedArrival(460);
    await lieStill(460, 10 * MIN);
    expect(stopOf()?.confirmed).not.toBe(true);
    await departAndPass(460);
    expect(warnings()).toHaveLength(1);
  });

  test('motfall: navstatus 5 under 2 h stillhet innanför 600 m ⇒ samma ankomst', async () => {
    await warnedArrival(460);
    await lieStill(460, 10 * MIN);
    const vessel = await lieStill(460, 60 * MIN, { navStatus: 5 });
    expect(vessel._moored).toBe(true);
    expect(Date.now() - vessel._stationarySince).toBeLessThan(MOORING_DETECTION.MAX_STATIONARY_WAIT_MS);
    expect(stopOf()?.confirmed).not.toBe(true);
    await departAndPass(460);
    expect(warnings()).toHaveLength(1);
    expect(sameArrival()).toBe(1);
  });
});

// Gränsen i ankomstspärren själv, med klassningens fält satta direkt (samma
// form som opening-queue-quay-stop.test.js). 460 m från Stridsbergsbron,
// utanför kajzonerna.
describe('Ankomstspärren i farleden innanför 600 m: farledsstoppets ålder och avgång', () => {
  let app;
  let savedMode;
  let store;
  const STOP = along(460);
  const DEPARTED = along(380);
  const FURTHER = along(320);
  const RELEASED = { _moored: false, targetBridge: null };

  async function boot() {
    app = new App();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: (name) => store[name] ?? null,
        set: (name, value) => {
          store[name] = JSON.parse(JSON.stringify(value));
        },
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    await app.onInit();
    jest.spyOn(app.bridgeOpeningService, 'restartArrival');
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(START));
    savedMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    store = {};
    await boot();
    app._persistentOpeningWarnings.set(KEY, { arrivalActive: true, firedAt: Date.now() - 5 * MIN });
  });

  afterEach(async () => {
    await app.onUninit();
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedMode;
  });

  const fix = (pos, sog, state) => ({
    mmsi: MMSI,
    lat: pos.lat,
    lon: pos.lon,
    sog,
    navStatus: 0,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now(),
    ...state,
  });
  const observe = (pos, sog, state, dt = 30000) => {
    jest.setSystemTime(Date.now() + dt);
    app._observeOpeningArrivals(fix(pos, sog, state));
  };
  function stillAt(ms, state) {
    for (let elapsed = 0; elapsed < ms; elapsed += 30000) observe(STOP, 0, state);
  }
  const stop = () => app._persistentOpeningWarnings.get(KEY)?.quayStop;

  test('stilla 2 h utan kortets bro som målbro ⇒ stoppet bekräftas; avgången kräver två fix i följd', () => {
    stillAt(2 * 60 * MIN + 30000, RELEASED);
    expect(stop()).toMatchObject({ fairway: true, confirmed: true });
    observe(DEPARTED, 3, RELEASED, 60000);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
    expect(app.bridgeOpeningService.restartArrival).not.toHaveBeenCalled();
    observe(FURTHER, 3, RELEASED, 60000);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(false);
    expect(app.bridgeOpeningService.restartArrival).toHaveBeenCalledWith(MMSI, 'Stridsbergsbron');
  });

  test('H1: ett avgångsfix följt av ett fix tillbaka vid stoppet nollar kravet', () => {
    stillAt(2 * 60 * MIN + 30000, RELEASED);
    observe(DEPARTED, 0.6, RELEASED);
    expect(stop().departFixTs).toBeDefined();
    observe(STOP, 0, RELEASED);
    expect(stop().departFixTs).toBeUndefined();
    observe(DEPARTED, 0.6, RELEASED);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
    expect(app.bridgeOpeningService.restartArrival).not.toHaveBeenCalled();
  });

  test('stilla 3 h med kortets bro som målbro och inte förtöjd (köaren appen håller) ⇒ inget bekräftat stopp', () => {
    stillAt(3 * 60 * MIN, { _moored: false, targetBridge: 'Stridsbergsbron' });
    expect(stop()).toMatchObject({ fairway: true, confirmed: false });
    observe(DEPARTED, 3, { _moored: false, targetBridge: 'Stridsbergsbron' }, 60000);
    observe(FURTHER, 3, { _moored: false, targetBridge: 'Stridsbergsbron' }, 60000);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
  });

  test('förtöjd (navstatus) men stoppet och klockan under 2 h ⇒ inget bekräftat stopp', () => {
    const since = Date.now();
    stillAt(100 * MIN, {
      _moored: true, _stationarySince: since, navStatus: 5, targetBridge: null,
    });
    expect(stop().confirmed).toBe(false);
  });

  test('klassningens klocka ≥ 2 h räcker även när stoppet är nytt (30 s-regeln, två fix)', () => {
    const since = Date.now() - MOORING_DETECTION.MAX_STATIONARY_WAIT_MS;
    observe(STOP, 0, { _moored: true, _stationarySince: since, targetBridge: null });
    expect(stop().confirmed).toBe(false);
    observe(STOP, 0, { _moored: true, _stationarySince: since, targetBridge: null });
    expect(stop().confirmed).toBe(true);
  });

  test('N5: ett fix i rörelse 80 m från ett obekräftat stopp startar inget nytt stopp', () => {
    observe(STOP, 0, RELEASED);
    expect(stop()).toMatchObject({ fairway: true, confirmed: false });
    observe(DEPARTED, 3, RELEASED);
    expect(stop()).toBeUndefined();
  });

  test('N5: utan fart räknas klassningens stillhet, annars inget stopp', () => {
    observe(STOP, null, RELEASED);
    expect(stop()).toBeUndefined();
    observe(STOP, null, { ...RELEASED, _stationarySince: Date.now() - 5 * MIN });
    expect(stop()).toMatchObject({ fairway: true, confirmed: false });
  });

  test('N3: andra avgångsfixet mer än 10 min efter det första, eller inte längre bort, räknas som ett nytt första', () => {
    stillAt(2 * 60 * MIN + 30000, RELEASED);
    observe(DEPARTED, 3, RELEASED, 60000);
    observe(FURTHER, 3, RELEASED, 11 * MIN);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
    observe(FURTHER, 3, RELEASED, 60000);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
    observe(along(250), 3, RELEASED, 60000);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(false);
  });

  test('fartbrus på samma plats nollar inte stoppets ålder; 50 m bort startar ett nytt', () => {
    observe(STOP, 0, RELEASED);
    const first = stop().firstFixTs;
    observe(STOP, 1.4, RELEASED);
    expect(stop().firstFixTs).toBe(first);
    observe(DEPARTED, 0, RELEASED);
    expect(stop().firstFixTs).toBeGreaterThan(first);
  });

  test('stoppets ålder och det första avgångsfixet överlever omstart', async () => {
    stillAt(2 * 60 * MIN + 30000, RELEASED);
    observe(DEPARTED, 3, RELEASED, 60000);
    app._persistOpeningWarnings();
    await app.onUninit();
    await boot();
    expect(stop()).toMatchObject({ fairway: true, confirmed: true });
    expect(stop().departFixTs).toBeDefined();
    observe(FURTHER, 3, RELEASED, 60000);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(false);
  });

  // Släppet gäller bara farleden: i en ritad kajzon gäller kajgrenens egna
  // regler oförändrade (där räknas t.ex. okänd fart aldrig som stillhet).
  test('kajzonen rörs inte: förtöjd ≥ 2 h vid Kajen med okänd fart registrerar inget stopp', () => {
    const KAJEN = MOORING_ZONES.find((zone) => zone.name === 'Kajen norr om Klaffbron');
    const kajKey = `Klaffbron|${MMSI}|southbound`;
    app._persistentOpeningWarnings.set(kajKey, { arrivalActive: true, firedAt: Date.now() - 5 * MIN });
    const at = { lat: (KAJEN.start.lat + KAJEN.end.lat) / 2, lon: (KAJEN.start.lon + KAJEN.end.lon) / 2 };
    const since = Date.now() - MOORING_DETECTION.MAX_STATIONARY_WAIT_MS;
    for (let i = 0; i < 3; i++) observe(at, null, { _moored: true, _stationarySince: since, targetBridge: null });
    expect(app._persistentOpeningWarnings.get(kajKey).quayStop).toBeUndefined();
  });
});
