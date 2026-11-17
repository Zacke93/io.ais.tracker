'use strict';

/**
 * U45: EN ANNAN BÅTS PASSAGE ANVÄNDER DEN VARNADE ÖPPNINGEN (omgång 4)
 * =============================================================================
 * Situationen (korpusen 20260707-14h): Klaffbron#15 varnar för BEAUTYFIELD
 * 11:01:34 medan hon ligger 1,4 km norr om bron i 0,5–1,8 kn. HELGE, som har
 * en egen händelse, går igenom Klaffbron norrut 11:18:08. BEAUTYFIELD går
 * igenom 11:35:10 utan ny varning: förut stängdes en händelse bara av en egen
 * medlems passage (J14), och en varnad medlem hade ingen släppväg (H29).
 *
 * Rättningen: den första bokförda passagen av en båt som inte hör till
 * händelsen, efter varningen och medan händelsen saknar egen passage,
 * startar händelsens fönster (foreignPassageAt). En båt som enligt ett färskt
 * fix i rörelse utanför väntzonen kommer mer än CONVOY_WINDOW_MS efter den
 * passagen släpps och får en egen varning. firstPassageAt, referensen och
 * täckningsslutet rörs inte.
 *
 * Geometri: Klaffbron. Norrgående båtar närmar sig söderifrån (bäring 220),
 * sydgående norrifrån (bäring 40). Fix var 60:e sekund.
 *
 * Test märkta [FÄLLER] är röda på 6fad291 (beteendet). [NY] prövar de nya
 * fälten och domen direkt och kan inte köras på 6fad291. Övriga är motfall
 * som låser dagens beteende och är gröna både före och efter rättningen.
 */

global.__TEST_MODE__ = true;

const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');

const T0 = 1_700_000_000_000;
const KLAFF = BRIDGES.klaffbron;
const S = 1000;
const W = BRIDGE_OPENING.CONVOY_WINDOW_MS;
const KN = 0.514444;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

function posAtDistance(bridge, distanceM, bearingDeg) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceM * Math.cos(rad)) / 111320;
  const dLon = (distanceM * Math.sin(rad)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180));
  return { lat: bridge.lat + dLat, lon: bridge.lon + dLon };
}

/**
 * Båt mot Klaffbron. dir 'north' närmar sig söderifrån, 'south' norrifrån.
 * beyond = true lägger henne bortom bron.
 */
function boat(mmsi, dir, distanceM, sog, { beyond = false, extra = {} } = {}) {
  const approach = dir === 'north' ? 220 : 40;
  const pos = posAtDistance(KLAFF, distanceM, beyond ? (approach + 180) % 360 : approach);
  const now = Date.now();
  return {
    mmsi,
    name: mmsi,
    lat: pos.lat,
    lon: pos.lon,
    sog,
    cog: dir === 'north' ? 40 : 220,
    timestamp: now,
    fixTs: now,
    lastPositionUpdate: now,
    targetBridge: 'Klaffbron',
    _routeDirection: dir,
    _finalTargetDirection: null,
    _hasMovementProof: true,
    _moored: false,
    _stationarySince: null,
    navStatus: null,
    etaMinutes: null,
    passedAt: {},
    passedBridges: [],
    ...extra,
  };
}

describe('U45: en annan båts passage startar den varnade öppningens fönster', () => {
  let logger;
  let warnings;
  let svc;
  let tickTimer;

  const advanceTo = (t) => {
    if (t > Date.now()) jest.advanceTimersByTime(t - Date.now());
  };
  const at = (s, fn) => {
    advanceTo(T0 + s * S); fn();
  };
  const obs = (...args) => svc.observeVessel(boat(...args));
  const ownWarnings = (mmsi) => warnings.filter((w) => w.bridge === 'Klaffbron'
    && (w.mmsis || []).map(String).includes(mmsi));
  const armOf = (mmsi) => svc._arms.get(`${mmsi}::Klaffbron`);
  const events = () => svc._events.get('Klaffbron') || [];
  const debugLines = (tag) => logger.debug.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(tag));

  /**
   * Den andra båten H (sydgående, egen händelse): hörs 900 m norr om bron vid
   * startS i 5 kn, korsar vid startS + 900/(5 kn) ≈ startS + 350 s och hörs
   * bortom bron 60 s senare. Returnerar korsningstiden i sekunder.
   */
  const passerH = (startS) => {
    const v = 5 * KN;
    const crossS = startS + 900 / v;
    at(startS, () => obs('H', 'south', 900, 5));
    at(startS + 180, () => obs('H', 'south', 900 - 180 * v, 5));
    at(crossS + 60, () => obs('H', 'south', 60 * v, 5, { beyond: true }));
    return crossS;
  };

  /**
   * M (norrgående) i fart `kn` från `d0` vid `fromS` var 60:e s till `toS`.
   * Returnerar avståndet vid toS.
   */
  const track = (mmsi, d0, kn, fromS, toS) => {
    const v = kn * KN;
    let d = d0;
    for (let t = fromS; t <= toS; t += 60) {
      d = d0 - (t - fromS) * v;
      if (d <= 0) break;
      const dd = d;
      at(t, () => obs(mmsi, 'north', dd, kn));
    }
    return d;
  };

  /** Korsa bron: ett fix bortom bron 30 s efter korsningen i farten kn. */
  const cross = (mmsi, crossS, kn) => {
    at(crossS + 30, () => obs(mmsi, 'north', 30 * kn * KN, kn, { beyond: true }));
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    logger = makeLogger();
    warnings = [];
    svc = new BridgeOpeningService({
      logger,
      onWarning: (payload) => warnings.push(payload),
      targetBridges: ['Klaffbron'],
    });
    tickTimer = setInterval(() => svc.tick(), BRIDGE_OPENING.TICK_INTERVAL_MS);
  });

  afterEach(() => {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (svc) svc.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('[FÄLLER] huvudfallet: varnad medlem som kommer långt efter den andra båtens passage får en egen varning', () => {
    // M varnas långt ute i låg fart (som BEAUTYFIELD 1,4 km ute i 1,2 kn).
    track('M', 1100, 1.2, 0, 180);
    expect(ownWarnings('M')).toHaveLength(1);
    const first = ownWarnings('M')[0];
    // H går igenom bron efter varningen.
    const hCross = passerH(200);
    // M fortsätter i låg fart, ökar sedan och korsar mer än 600 s efter H.
    // Fortsatt krypfart (0,6 kn) tills fönstret har gått, sedan 5 kn: hon
    // släpps på sitt första egna fix i rörelse efter fönstrets slut.
    const dAt = track('M', 1100 - 240 * 1.2 * KN, 0.6, 240, 1140);
    const mCross = 1140 + 30 + dAt / (5 * KN);
    track('M', dAt, 5, 1170, Math.floor(mCross) - 1);
    cross('M', mCross, 5);
    expect(mCross - hCross).toBeGreaterThan(W / S);

    const mine = ownWarnings('M');
    expect(mine).toHaveLength(2);
    const second = mine[1];
    expect(second.eventId).not.toBe(first.eventId);
    // Varningen kommer efter H:s passage och i god tid före hennes korsning.
    expect((second.t - T0) / S).toBeGreaterThan(hCross);
    expect(mCross - (second.t - T0) / S).toBeGreaterThan(2 * BRIDGE_OPENING.TICK_INTERVAL_MS / S);
    // Appen ombeds släppa den gamla ankomstens dedupspärr för henne.
    expect(second.reopenedMmsis).toEqual(['M']);
    expect(debugLines('[OPENING_FOREIGN_RELEASE]')).toHaveLength(1);
    expect(debugLines('[OPENING_FOREIGN_PASSAGE]').length).toBeGreaterThanOrEqual(1);
  });

  test('[NY] firstPassageAt, referensen och täckningen rörs inte av den andra båtens passage', () => {
    track('M', 1100, 1.2, 0, 180);
    const e = events().find((x) => x.firedAt !== null && armOf('M').eventId === x.id);
    const refBefore = e.referenceArrivalMs;
    passerH(200);
    expect(e.firstPassageAt).toBeNull();
    expect(e.firstPassageRegisteredAt).toBeNull();
    expect(e.lastPassageAt).toBeNull();
    expect(e.referenceArrivalMs).toBe(refBefore);
    expect(Number.isFinite(e.foreignPassageAt)).toBe(true);
    expect(e.foreignPassageMmsi).toBe('H');
  });

  test('motfall: medlemmen korsar inom 600 s efter den andra båtens passage (samma öppning) — ingen andra varning', () => {
    // M i jämn fart 5 kn: varnas på sin deadline och korsar strax efter H.
    const v = 5 * KN;
    track('M', 1500, 5, 300, 300);
    const hCross = passerH(200);
    const mCross = 300 + 1500 / v;
    track('M', 1500 - 60 * v, 5, 360, Math.floor(mCross) - 1);
    cross('M', mCross, 5);
    expect(mCross - hCross).toBeLessThan(W / S);
    expect(ownWarnings('M')).toHaveLength(1);
    expect(debugLines('[OPENING_FOREIGN_RELEASE]')).toHaveLength(0);
  });

  test('motfall: medlem som kryper och sedan ökar och korsar inom 600 s efter den andra båten — ingen andra varning', () => {
    // Hennes prognos i 1,2 kn ligger långt bortom fönstret när H passerar,
    // men hon ökar till 5 kn och går in i samma öppning. Släppet väntar tills
    // fönstret har gått (U45-svepet i omgång 4: 134 sådana lägen utan villkoret).
    track('M', 1100, 1.2, 0, 180);
    const hCross = passerH(200);
    const dAt = track('M', 1100 - 240 * 1.2 * KN, 1.2, 240, 600);
    const mCross = 600 + 30 + dAt / (5 * KN);
    track('M', dAt, 5, 630, Math.floor(mCross) - 1);
    cross('M', mCross, 5);
    expect(mCross - hCross).toBeLessThan(W / S);
    expect(mCross - hCross).toBeGreaterThan(300);
    expect(ownWarnings('M')).toHaveLength(1);
  });

  test('motfall: en passage FÖRE varningen påverkar inte händelsen', () => {
    // H korsar först; M hörs långt ute senare och varnas efter H:s passage.
    const hCross = passerH(0);
    track('M', 1100, 1.2, Math.ceil(hCross) + 120, Math.ceil(hCross) + 300);
    expect(ownWarnings('M')).toHaveLength(1);
    const e = events().find((x) => x.id === armOf('M').eventId);
    expect(e.foreignPassageAt ?? null).toBeNull();
  });

  test('motfall: medlem som väntar i väntzonen släpps inte (U24:s kögrind)', () => {
    track('M', 1100, 1.2, 0, 180);
    passerH(200);
    // M kryper inom väntzonen (≤ 350 m) långt efter fönstrets slut.
    for (let t = 600; t <= 1500; t += 60) at(t, () => obs('M', 'north', 300, 0.8));
    expect(ownWarnings('M')).toHaveLength(1);
  });

  test('[FÄLLER] stilla medlem släpps inte förrän hon rör sig, och varnas då', () => {
    track('M', 1100, 1.2, 0, 180);
    const hCross = passerH(200);
    // Stilla 1,3 km ute (sog 0) långt efter fönstrets slut: ingen ny varning.
    for (let t = 600; t <= 1500; t += 60) at(t, () => obs('M', 'north', 1000, 0));
    expect(ownWarnings('M')).toHaveLength(1);
    expect(debugLines('[OPENING_FOREIGN_RELEASE]')).toHaveLength(0);
    // Hon börjar gå i 4 kn: släpps på första fixet i rörelse och varnas.
    const v = 4 * KN;
    at(1560, () => obs('M', 'north', 1000 - 60 * v, 4));
    advanceTo(T0 + 1620 * S);
    expect(ownWarnings('M')).toHaveLength(2);
    expect((ownWarnings('M')[1].t - T0) / S).toBeGreaterThan(hCross + W / S);
  });

  test('motfall: tyst medlem (inget fix efter passagen) står kvar som förut', () => {
    track('M', 1100, 1.2, 0, 180);
    passerH(200);
    advanceTo(T0 + 1500 * S);
    expect(ownWarnings('M')).toHaveLength(1);
    expect(armOf('M').warnedAt).not.toBeNull();
  });

  test('motfall: händelsen fick sin egen passage först — en andra båts passage ändrar inget (H29 som förut)', () => {
    // A och M varnas tillsammans (samma ankomst); A korsar, M stannar 600 m
    // ute och kryper; H passerar långt senare. M får ingen andra varning.
    const v = 5 * KN;
    at(0, () => {
      obs('A', 'north', 1000, 5); obs('M', 'north', 1100, 5);
    });
    advanceTo(T0 + 40 * S);
    const shared = ownWarnings('A')[0];
    expect(shared.mmsis).toEqual(expect.arrayContaining(['A', 'M']));
    at(60, () => {
      obs('A', 'north', 1000 - 60 * v, 5); obs('M', 'north', 1100 - 60 * v, 5);
    });
    const aCross = 1000 / v;
    at(aCross + 30, () => obs('A', 'north', 30 * v, 5, { beyond: true }));
    for (let t = 480; t <= 1500; t += 60) at(t, () => obs('M', 'north', 600, 1));
    passerH(1100);
    const e = events().find((x) => x.id === shared.eventId);
    expect(e.firstPassageAt).not.toBeNull();
    expect(e.foreignPassageAt ?? null).toBeNull();
    for (let t = 1560; t <= 2100; t += 60) at(t, () => obs('M', 'north', 600, 1));
    expect(ownWarnings('M')).toHaveLength(1);
  });

  test('[NY] egen passage som bokförs efter den andra båtens men korsade före: den egna gäller som förut', () => {
    // E för A (korsar ≈ 389 s, tyst, bokförs först 1200 s). H (egen händelse,
    // utanför E:s fönster) korsar ≈ 1050 s och bokförs ≈ 1110 s, alltså före A.
    const vA = 5 * KN;
    at(0, () => obs('A', 'north', 1000, 5));
    at(60, () => obs('A', 'north', 1000 - 60 * vA, 5));
    const e = events().find((x) => x.id === armOf('A').eventId);
    expect(e.firedAt).not.toBeNull();
    const aCross = 1000 / vA;
    const hCross = passerH(700);
    expect(armOf('H')).toBeUndefined();
    expect(hCross).toBeGreaterThan(aCross);
    expect(Number.isFinite(e.foreignPassageAt)).toBe(true);
    at(1200, () => obs('A', 'north', (1200 - aCross) * vA, 5, { beyond: true }));
    expect(e.firstPassageRegisteredAt).toBe(T0 + 1200 * S);
    expect(e.firstPassageAt).toBeLessThan(e.foreignPassageAt);
    // Referensen är A:s korsning, som på 6fad291 (ingen flytt), och den andra
    // båtens passage läses inte längre när den egna finns.
    expect(e.referenceArrivalMs).toBe(e.firstPassageAt);
    expect(svc._foreignPassageVerdict({ lastSeenAt: Date.now() }, e, Date.now())).toBeNull();
  });

  test('[FÄLLER] absorberad båt: bakkanten dömer henne mot den andra båtens passage', () => {
    // M varnas långt ute; C absorberas i hennes händelse; H passerar; C:s
    // färska prognos ligger efter fönstret kring H:s passage.
    track('M', 1100, 1.2, 0, 180);
    const eId = armOf('M').eventId;
    at(190, () => obs('C', 'north', 1900, 3));
    expect(armOf('C').eventId).toBe(eId);
    expect(armOf('C').absorbedAt).not.toBeNull();
    const hCross = passerH(200);
    const v = 3 * KN;
    let d = 1900;
    for (let t = 250; t <= 1300 && d > 400; t += 60) {
      d = 1900 - (t - 190) * v;
      const dd = d;
      at(t, () => obs('C', 'north', dd, 3));
    }
    const cWarn = warnings.filter((w) => w.leadMmsi === 'C' || (w.mmsis || []).includes('C'));
    expect(cWarn).toHaveLength(1);
    expect((cWarn[0].t - T0) / S).toBeGreaterThan(hCross);
    const rec = logger.debug.mock.calls.map((x) => String(x[0]))
      .filter((l) => l.includes('[OPENING_RECOVER]') && l.includes('C (') && l.includes('U45'));
    expect(rec).toHaveLength(1);
  });

  test('[FÄLLER] ny båt som kommer mer än 600 s efter den andra båtens passage binds inte till händelsen', () => {
    // M:s händelse har prognosen långt fram (1,2 kn, 1400 m ⇒ ca 38 min).
    track('M', 1100, 1.2, 0, 180);
    const eId = armOf('M').eventId;
    const hCross = passerH(200);
    // N hörs efter H:s passage med ankomst långt efter hCross + 600 s men inom
    // 600 s från M:s prognos.
    const e = events().find((x) => x.id === eId);
    const tN = Math.ceil(hCross) + 120;
    const v = 1.5 * KN;
    const arrival = (e.referenceArrivalMs - T0) / S - 300;
    const dN = (arrival - tN) * v;
    at(tN, () => obs('N', 'north', dN, 1.5));
    expect(armOf('N').eventId).not.toBe(eId);
    advanceTo(T0 + (tN + 60) * S);
    expect(ownWarnings('N')).toHaveLength(1);
  });

  test('motfall: ny båt inom 600 s efter den andra båtens passage binds som förut när hon hör till händelsen', () => {
    track('M', 1100, 1.2, 0, 180);
    const eId = armOf('M').eventId;
    const e = events().find((x) => x.id === eId);
    // Gör referensen nära: en ny båt med ankomst nära både referensen och H:s passage.
    e.referenceArrivalMs = T0 + 700 * S;
    const hCross = passerH(200);
    const tN = Math.ceil(hCross) + 30;
    const v = 5 * KN;
    at(tN, () => obs('N', 'north', 250 * v, 5));
    expect(armOf('N').eventId).toBe(eId);
    expect(armOf('N').absorbedAt).not.toBeNull();
  });

  test('motfall: en händelse vars kort inte gick ut får ingen sådan passage', () => {
    track('M', 1100, 1.2, 0, 180);
    const e = events().find((x) => x.id === armOf('M').eventId);
    e.deliveryUnavailable = true;
    passerH(200);
    expect(e.foreignPassageAt ?? null).toBeNull();
  });

  describe('varv 2: släppet döms bara på hennes eget fix efter fönstrets slut', () => {
    // Gemensamt: M varnas 1100 m ute; H korsar ≈ 550 s; fönstret slutar ≈ 1150 s.
    const setup = () => {
      track('M', 1100, 1.2, 0, 180);
      return passerH(200);
    };

    test('tick utan nytt fix släpper aldrig (gammalt fix i rörelse, fönstret har gått)', () => {
      setup();
      // Sista fixet före fönstrets slut: 900 m ute i 5 kn. Sedan tyst.
      at(1100, () => obs('M', 'north', 900, 5));
      advanceTo(T0 + 1500 * S);
      expect(ownWarnings('M')).toHaveLength(1);
      expect(debugLines('[OPENING_FOREIGN_RELEASE]')).toHaveLength(0);
    });

    test('en annan båts fix efter fönstrets slut släpper inte på hennes gamla fix', () => {
      setup();
      at(1100, () => obs('M', 'north', 900, 5));
      // N hörs vid bron efter fönstrets slut och utvärderar Klaffbron.
      for (let t = 1200; t <= 1500; t += 60) at(t, () => obs('N', 'north', 2000, 5));
      expect(ownWarnings('M')).toHaveLength(1);
      expect(debugLines('[OPENING_FOREIGN_RELEASE]')).toHaveLength(0);
    });

    test('under 2 kn släpps hon inte; på första egna fixet i minst 2 kn släpps hon', () => {
      setup();
      for (let t = 1200; t <= 1500; t += 60) at(t, () => obs('M', 'north', 1000 - (t - 1200) * 1.5 * KN, 1.5));
      expect(ownWarnings('M')).toHaveLength(1);
      at(1560, () => obs('M', 'north', 780, 2.5));
      advanceTo(T0 + 1620 * S);
      expect(ownWarnings('M')).toHaveLength(2);
      expect(ownWarnings('M')[1].reopenedMmsis).toEqual(['M']);
    });

    test('spärrad av en tidigare bro släpps hon inte; efter spärren släpps hon på eget fix', () => {
      setup();
      // Söder om Olidebron (opasserad bro emellan) i 3 kn efter fönstrets slut.
      const hist = { extra: { passedBridges: ['Kanalinfarten'] } };
      for (let t = 1200; t <= 1380; t += 60) at(t, () => svc.observeVessel(boat('M', 'north', 2000 - (t - 1200) * 3 * KN, 3, hist)));
      expect(armOf('M').earlierBridge).toBe('Olidebron');
      expect(debugLines('[OPENING_FOREIGN_RELEASE]')).toHaveLength(0);
      expect(ownWarnings('M')).toHaveLength(1);
      // Förbi Olidebron, 1 000 m kvar: spärren är borta och hon släpps.
      at(1440, () => svc.observeVessel(boat('M', 'north', 1000, 3, { extra: { passedBridges: ['Kanalinfarten', 'Olidebron'] } })));
      expect(armOf('M').earlierBridge).toBeNull();
      expect(debugLines('[OPENING_FOREIGN_RELEASE]')).toHaveLength(1);
    });

    test('egna fix efter fönstrets slut i rörelse: släpps på första fixet', () => {
      setup();
      at(1200, () => obs('M', 'north', 900, 5));
      expect(debugLines('[OPENING_FOREIGN_RELEASE]')).toHaveLength(1);
      advanceTo(T0 + 1260 * S);
      expect(ownWarnings('M')).toHaveLength(2);
    });
  });

  describe('varv 3: flaggans livscykel och passagens villkor', () => {
    // M1 och M2 varnas tillsammans; H passerar; båda släpps på egna fix efter
    // fönstret; M2 absorberas i M1:s nya händelse och är tyst över bron.
    const chain = () => {
      const v5 = 5 * KN;
      at(0, () => {
        obs('M1', 'north', 1100, 1.2); obs('M2', 'north', 1120, 1.2);
      });
      at(60, () => {
        obs('M1', 'north', 1063, 1.2); obs('M2', 'north', 1083, 1.2);
      });
      passerH(200);
      at(1200, () => obs('M1', 'north', 900, 5));
      at(1210, () => obs('M2', 'north', 960, 5));
      at(1560, () => obs('M1', 'north', 900 - 360 * v5, 5));
      at(1600, () => obs('M1', 'north', 40 * v5, 5, { beyond: true }));
    };

    test('[FÄLLER] flaggan nollas i _fire och vid täckningsslutet; U17-varningen ber inte om återöppning', () => {
      chain();
      expect(armOf('M1')).toBeUndefined(); // M1 har passerat
      const m1New = warnings.find((w) => w.mmsis.includes('M1') && w.reopenedMmsis);
      expect(m1New.reopenedMmsis).toEqual(['M1']);
      const m2 = armOf('M2');
      expect(m2.absorbedAt).not.toBeNull();
      expect(m2.eventId).toBe(m1New.eventId);
      expect(typeof m2.foreignReleasedFrom).toBe('string'); // följer med genom absorptionen
      advanceTo(T0 + 2700 * S);
      const late = warnings.filter((w) => w.mmsis.includes('M2')).pop();
      expect(late.mmsis).toEqual(['M2']);
      expect(late.reopenedMmsis).toBeUndefined();
      expect(armOf('M2').foreignReleasedFrom).toBeNull();
    });

    test('låser (mutation): flaggan nollas av _fire för den som varnas', () => {
      const v5 = 5 * KN;
      at(0, () => {
        obs('M1', 'north', 1100, 1.2); obs('M2', 'north', 1120, 1.2);
      });
      at(60, () => {
        obs('M1', 'north', 1063, 1.2); obs('M2', 'north', 1083, 1.2);
      });
      passerH(200);
      at(1200, () => obs('M1', 'north', 900, 5));
      advanceTo(T0 + 1240 * S);
      const own = warnings.filter((w) => w.mmsis.includes('M1')).pop();
      expect(own.reopenedMmsis).toEqual(['M1']);
      expect(armOf('M1').warnedAt).toBe(own.t);
      expect(armOf('M1').foreignReleasedFrom).toBeNull();
      expect(900 - 40 * v5).toBeGreaterThan(350);
    });

    test('låser (mutation): en korsning FÖRE varningen som bokförs EFTER den startar inget fönster', () => {
      // M varnas ≈ 90 s; H korsar osedd ≈ 39 s och bokförs först 400 s.
      at(0, () => {
        obs('M', 'north', 1250, 1.2); obs('H', 'south', 100, 5);
      });
      advanceTo(T0 + 120 * S);
      const e = events().find((x) => x.id === armOf('M').eventId);
      expect(e.firedAt).toBeGreaterThan(T0 + 39 * S);
      at(400, () => obs('H', 'south', (400 - 39) * 5 * KN, 5, { beyond: true }));
      expect(e.foreignPassageAt).toBeNull();
    });

    test('låser (mutation): en andra främmande passage flyttar inte fönstret', () => {
      track('M', 1100, 1.2, 0, 180);
      const hCross = passerH(200);
      const e = events().find((x) => x.id === armOf('M').eventId);
      const first = e.foreignPassageAt;
      expect(first).toBeCloseTo(T0 + hCross * S, -4);
      const v = 5 * KN;
      at(800, () => obs('K', 'south', 900, 5));
      at(980, () => obs('K', 'south', 900 - 180 * v, 5));
      at(800 + 900 / v + 60, () => obs('K', 'south', 60 * v, 5, { beyond: true }));
      expect(e.foreignPassageAt).toBe(first);
      expect(e.foreignPassageMmsi).toBe('H');
    });
  });

  describe('[NY] domens grindar, en i taget', () => {
    const base = () => {
      const now = T0 + 2000 * S;
      const event = {
        id: 'Klaffbron#9', firedAt: T0, firstPassageAt: null, foreignPassageAt: T0 + 300 * S, foreignPassageMmsi: 'H',
      };
      const p = posAtDistance(KLAFF, 1000, 220);
      const arm = {
        mmsi: 'M',
        bridge: 'Klaffbron',
        lastSeenAt: now,
        lastFixClean: true,
        lastObservedAt: null,
        lat: p.lat,
        lon: p.lon,
        routeDirection: 'north',
        waitingAtBridge: null,
        distanceM: 1000,
        sog: 2,
        cog: 40,
        physicsArrivalMs: now + 970 * S,
        expectedArrivalMs: now + 970 * S,
        crawlFixes: 0,
        crawlFromCruise: false,
        absorbedAt: null,
        coverUntilMs: null,
      };
      return { now, event, arm };
    };

    test('alla villkor uppfyllda ⇒ bakkant', () => {
      const { now, event, arm } = base();
      expect(svc._foreignPassageVerdict(arm, event, now)).toMatchObject({ kind: 'bakkant', windowEndMs: T0 + 900 * S });
    });
    test.each([
      ['färsk', (b) => {
        b.arm.lastSeenAt = b.event.foreignPassageAt;
      }],
      ['orent', (b) => {
        b.arm.lastFixClean = false;
      }],
      ['bakom', (b) => {
        const p = posAtDistance(KLAFF, 200, 40); b.arm.lat = p.lat; b.arm.lon = p.lon;
      }],
      ['kö', (b) => {
        b.arm.distanceM = 340;
      }],
      ['kö', (b) => {
        b.arm.waitingAtBridge = 'Klaffbron';
      }],
      ['under-2-kn', (b) => {
        b.arm.physicsArrivalMs = null;
      }],
      ['under-2-kn', (b) => {
        b.arm.sog = 1.9;
      }],
      ['spärr', (b) => {
        b.arm.earlierBridge = 'Olidebron'; b.arm.earlierBridgeUntilMs = b.now + 60 * S;
      }],
      ['eget-fix', (b) => {
        b.arm.lastSeenAt = b.now - 1;
      }],
      ['inom-fönstret', (b) => {
        b.arm.expectedArrivalMs = T0 + 900 * S; b.arm.physicsArrivalMs = T0 + 900 * S;
      }],
      ['golv', (b) => {
        b.arm.expectedArrivalMs = b.now + 59 * S;
      }],
      ['kurs', (b) => {
        b.arm.cog = 220;
      }],
      ['fönstret-pågår', (b) => {
        b.event.foreignPassageAt = b.now - 9 * 60 * S;
      }],
      ['fönstret-pågår', (b) => {
        b.event.foreignPassageAt = b.now - W; // exakt vid fönstrets slut
      }],
    ])('grinden %s håller henne', (gate, mutate) => {
      const b = base();
      mutate(b);
      expect(svc._foreignPassageVerdict(b.arm, b.event, b.now)).toMatchObject({ kind: 'covered', gate });
    });
    test('golvet: exakt två tick kvar släpper', () => {
      const b = base();
      b.arm.expectedArrivalMs = b.now + 2 * BRIDGE_OPENING.TICK_INTERVAL_MS;
      b.arm.physicsArrivalMs = b.arm.expectedArrivalMs;
      b.event.foreignPassageAt = b.now - 20 * 60 * S;
      expect(svc._foreignPassageVerdict(b.arm, b.event, b.now).kind).toBe('bakkant');
    });
    test('absorberad arm mäts mot det som slutar först av täckningen och fönstret', () => {
      const b = base();
      b.arm.absorbedAt = T0 + 100 * S;
      b.arm.coverUntilMs = T0 + 800 * S;
      expect(svc._foreignPassageVerdict(b.arm, b.event, b.now)).toMatchObject({ kind: 'bakkant', windowEndMs: T0 + 800 * S });
    });
    test('null när händelsen har egen passage eller ingen annan båts passage', () => {
      const b = base();
      expect(svc._foreignPassageVerdict(b.arm, { ...b.event, firstPassageAt: T0 + 100 * S }, b.now)).toBeNull();
      expect(svc._foreignPassageVerdict(b.arm, { ...b.event, foreignPassageAt: null }, b.now)).toBeNull();
      expect(svc._foreignPassageVerdict(b.arm, { ...b.event, firedAt: null }, b.now)).toBeNull();
    });
  });
});
