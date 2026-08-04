'use strict';

jest.mock('homey');

/**
 * =============================================================================
 * ÖPPNINGSVARNINGARNAS INTEGRATION I app.js (etapp 6, 2026-08-03)
 * =============================================================================
 *
 * BridgeOpeningService har sin egen svit (bridge-opening-service.test.js) som
 * täcker beväpning, deadline-fysik och motbevis. DEN HÄR sviten täcker det
 * ingen av dem kan se: LEDNINGARNA. Varje test nedan motsvarar ett sätt att
 * bygga en perfekt service som ändå aldrig levererar en varning:
 *
 *   - servicen instansieras men matas aldrig ur vessel-flödet
 *   - tick-kroken sitter EFTER watchdogens tomkanals-retur (deadline-motorn
 *     dör exakt när den behövs — båten är timeout:ad, kanalen är tom)
 *   - kortet hämtas aldrig, eller avfyras med tokens Homey vägrar
 *   - run-listenern matchar aldrig (dropdown-id ≠ state.bridge)
 *   - callbacken kastar och tar tick-loopen med sig
 *   - kajvobbel-predikatet är inkopplat mot fel referenspunkt
 */

// ORDNINGEN ÄR INTE KOSMETISK: 'homey' måste hämtas FÖRE '../app'. Görs den
// tvärtom automockar jest modulen (varje funktion blir en jest.fn som ger
// undefined) och getTriggerCard returnerar ingenting — appen bootar då UTAN
// flow-kort och testet mäter ingenting. Samma ordning som flow-condition-args
// och de övriga kortsviterna använder.
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
const { BRIDGES, QUAY_DEPARTURE_GATE, BRIDGE_OPENING } = require('../lib/constants');

const KLAFF = BRIDGES.klaffbron;

/** Full appstart via produktionsvägen (samma dans som replay-harnessen). */
const bootApp = async () => {
  const app = new AISBridgeApp();
  app.homey = mockHomey;
  mockHomey.app.settings = { debug_level: 'off', ais_api_key: null };
  mockHomey.settings = {
    get: (key) => mockHomey.app.settings[key] || null,
    set: (key, value) => {
      mockHomey.app.settings[key] = value;
    },
    on: () => {},
    off: () => {},
  };
  global.__TEST_MODE__ = true;
  await app.onInit();
  return app;
};

/** Lättviktsapp (samma mönster som F34-sviten): ingen onInit, bara det vi rör. */
const makeApp = () => {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app._firedOpeningEvents = new Map();
  app._OPENING_DEDUP_TTL_MS = 60 * 60 * 1000;
  app._quayStableLedger = new Map();
  app._openingQuayLedger = new Map();
  app._persistentOpeningWarnings = new Map();
  app._knownVesselNames = new Map();
  return app;
};

const payloadFor = (overrides = {}) => ({
  t: Date.now(),
  eventId: 'Klaffbron#1',
  bridge: 'Klaffbron',
  direction: 'northbound',
  etaMinutes: 4,
  vesselCount: 2,
  leadVessel: 'JUNO',
  leadMmsi: '111',
  firedBy: 'deadline',
  mmsis: ['111', '222'],
  distanceM: 820,
  ...overrides,
});

/**
 * Kringgå testgrinden i _onBridgeOpeningWarning och kör EXAKT produktionens
 * väg (samma teknik som replayRunner: NODE_ENV='production' + TEST_MODE av).
 * Utan den här kringgången testar man bara att grinden finns.
 */
const withRealFlowGate = async (fn) => {
  const savedEnv = process.env.NODE_ENV;
  const savedMode = global.__TEST_MODE__;
  process.env.NODE_ENV = 'production';
  global.__TEST_MODE__ = undefined;
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = savedEnv;
    global.__TEST_MODE__ = savedMode;
  }
};

describe('Etapp 6: onInit kopplar in BridgeOpeningService', () => {
  let app = null;

  afterEach(async () => {
    if (app) await app.onUninit();
    app = null;
    delete global.__TEST_MODE__;
  });

  test('servicen och flow-kortet finns efter onInit', async () => {
    app = await bootApp();
    expect(app.bridgeOpeningService).toBeInstanceOf(BridgeOpeningService);
    expect(app._bridgeOpeningTrigger).toBeTruthy();
    expect(typeof app._bridgeOpeningTrigger.trigger).toBe('function');
    // Kortet ska vara ETT EGET kort — delar det instans med boat_near hamnar
    // öppningsvarningarna i notisströmmen (och i replayens notificationCount).
    expect(app._bridgeOpeningTrigger).not.toBe(app._boatNearTrigger);
    // Run-listener registrerad, och boat_near ligger FÖRE (flera sviter läser
    // runListeners[0] på en delad mock).
    expect(app._bridgeOpeningTrigger.runListeners.length).toBeGreaterThan(0);
  });

  test('de fyra beroendena är INJICERADE, inte duplicerade', async () => {
    app = await bootApp();
    const svc = app.bridgeOpeningService;

    // getDirection → appens _getDirectionString (samma token som boat_near)
    const dirSpy = jest.spyOn(app, '_getDirectionString').mockReturnValue('southbound');
    expect(svc._directionString({ mmsi: '1', routeDirection: 'north', cog: 10 })).toBe('southbound');
    expect(dirSpy).toHaveBeenCalled();
    dirSpy.mockRestore();

    // isQuayWobbler → V1-kajbokföringen
    const quaySpy = jest.spyOn(app, '_isBridgeOpeningQuayWobbler').mockReturnValue(true);
    expect(svc._canArm({ _moored: false, _hasMovementProof: true, targetBridge: 'Klaffbron' }, 500)).toBe(false);
    expect(quaySpy).toHaveBeenCalled();
    quaySpy.mockRestore();

    // onWarning → app-metoden (ARROW, så en sen monkey-patch syns)
    const seen = [];
    app._onBridgeOpeningWarning = (p) => seen.push(p);
    svc._onWarning(payloadFor());
    expect(seen).toHaveLength(1);
  });

  test('onUninit river servicens tillstånd', async () => {
    app = await bootApp();
    const svc = app.bridgeOpeningService;
    await app.onUninit();
    expect(svc._destroyed).toBe(true);
    app = null;
  });
});

describe('Etapp 6: tick-kroken i 30 s-watchdogen', () => {
  test('tick körs ÄVEN när kanalen är tom (armen överlever sitt fartyg)', async () => {
    jest.useFakeTimers();
    let app = null;
    try {
      app = await bootApp();
      const tickSpy = jest.spyOn(app.bridgeOpeningService, 'tick');
      // Tom kanal = watchdogens tidiga retur. REGRESSIONEN: en tick placerad
      // efter den returen dör exakt i sitt designfall — båten är timeout:ad
      // ur VesselDataService medan hennes arm ska fortsätta räkna ned.
      jest.spyOn(app.vesselDataService, 'getAllVessels').mockReturnValue([]);
      app._lastBridgeTextHash = 'x';
      app._lastBridgeAlarm = false;
      app._lastConnectionStatus = 'connected';

      jest.advanceTimersByTime(30000);
      expect(tickSpy).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(60000);
      expect(tickSpy).toHaveBeenCalledTimes(3);
    } finally {
      if (app) await app.onUninit();
      delete global.__TEST_MODE__;
      jest.useRealTimers();
    }
  });

  test('en kastande tick dödar inte självläkningen (och sväljs inte tyst)', async () => {
    jest.useFakeTimers();
    let app = null;
    try {
      app = await bootApp();
      app.error = jest.fn();
      jest.spyOn(app.bridgeOpeningService, 'tick').mockImplementation(() => {
        throw new Error('boom');
      });
      const healSpy = jest.spyOn(app, '_scheduleCoalescedUpdate').mockImplementation(() => {});
      jest.spyOn(app.vesselDataService, 'getAllVessels').mockReturnValue([{ mmsi: '1' }]);

      expect(() => jest.advanceTimersByTime(30000)).not.toThrow();
      // Svälj-fällan: felet SKA synas i loggen.
      expect(app.error).toHaveBeenCalledWith('[BRIDGE_OPENING] tick misslyckades:', 'boom');
      // ...och självläkningen SKA ha kört ändå (separata try/catch).
      expect(healSpy).toHaveBeenCalled();
    } finally {
      if (app) await app.onUninit();
      delete global.__TEST_MODE__;
      jest.useRealTimers();
    }
  });
});

describe('Etapp 6: avfyrningsvägen _onBridgeOpeningWarning', () => {
  let app = null;

  afterEach(async () => {
    if (app) await app.onUninit();
    app = null;
    delete global.__TEST_MODE__;
  });

  test('tokens och state levereras i boat_near-stil', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor());
      await Promise.resolve();
    });

    const calls = card.getTriggerCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].success).toBe(true);
    expect(calls[0].tokens).toEqual({
      bridge_name: 'Klaffbron',
      vessel_name: 'JUNO',
      direction: 'northbound',
      eta_minutes: 4,
      vessel_count: 2,
    });
    // state.bridge måste vara dropdown-ID:t, annars matchar run-listenern aldrig.
    expect(calls[0].state.bridge).toBe('klaffbron');
    expect(calls[0].state.eventId).toBe('Klaffbron#1');
    expect(calls[0].state.firedBy).toBe('deadline');
    expect(calls[0].state.mmsis).toEqual(['111', '222']);
  });

  test('okänd ETA levereras som -1 (samma sentinel som boat_near)', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ etaMinutes: null, leadVessel: '', vesselCount: undefined }));
      await Promise.resolve();
    });

    const calls = card.getTriggerCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].tokens.eta_minutes).toBe(-1);
    // Namnlös båt får aldrig bli undefined — Homey kastar på fel tokentyp.
    expect(typeof calls[0].tokens.vessel_name).toBe('string');
    expect(calls[0].tokens.vessel_count).toBe(1);
  });

  test('ENGÅNGS-DEDUP: samma eventId avfyrar aldrig två gånger', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor());
      app._onBridgeOpeningWarning(payloadFor({ etaMinutes: 2 }));
      await Promise.resolve();
    });

    expect(card.getTriggerCalls()).toHaveLength(1);

    // En NY öppningshändelse vid samma bro med ANDRA båtar SKA få sin egen
    // varning. (Samma båtar inom konvojfönstret är däremot omstartsdubbletten
    // — se nästa test.)
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({
        eventId: 'Klaffbron#2', leadMmsi: '333', mmsis: ['333'],
      }));
      await Promise.resolve();
    });
    expect(card.getTriggerCalls()).toHaveLength(2);
  });

  test('OMSTARTSDUBBLETTEN: samma båtar/bro/riktning inom konvojfönstret varnas EN gång', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor());
      await Promise.resolve();
    });
    expect(card.getTriggerCalls()).toHaveLength(1);

    // OMSTARTEN: hela sessionens minne nollas (nytt eventSeq, tom
    // _firedOpeningEvents) — precis vad ctrl:'restart' och en Homey-
    // appuppdatering gör. Bara settings-lagret överlever.
    app._firedOpeningEvents.clear();
    app._persistentOpeningWarnings = new Map();
    app._loadPersistentOpeningWarnings();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ eventId: 'Klaffbron#1', etaMinutes: 9 }));
      await Promise.resolve();
    });
    expect(card.getTriggerCalls()).toHaveLength(1);

    // ...men RETURPASSAGEN (U-svängaren) är en äkta ny öppning och släpps.
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({
        eventId: 'Klaffbron#4', direction: 'southbound',
      }));
      await Promise.resolve();
    });
    expect(card.getTriggerCalls()).toHaveLength(2);
    expect(card.getTriggerCalls()[1].tokens.direction).toBe('southbound');
  });

  test('B1: platshållaren "Unknown" når ALDRIG vessel_name-tokenen', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();

    await withRealFlowGate(async () => {
      // (a) rå platshållare utan cachat namn ⇒ 'Okänd båt' (boat_near-kedjan)
      app._onBridgeOpeningWarning(payloadFor({
        eventId: 'Klaffbron#90', leadVessel: 'Unknown', leadMmsi: '901', mmsis: ['901'],
      }));
      // (b) rå platshållare MEN namnet finns i den persistenta cachen
      app._knownVesselNames.set('902', { name: 'RONJA', t: Date.now() });
      app._onBridgeOpeningWarning(payloadFor({
        eventId: 'Klaffbron#91', leadVessel: 'Unknown', leadMmsi: '902', mmsis: ['902'],
      }));
      // (c) servicen levererar null (dess egen B1-filtrering)
      app._onBridgeOpeningWarning(payloadFor({
        eventId: 'Klaffbron#92', leadVessel: null, leadMmsi: '903', mmsis: ['903'],
      }));
      await Promise.resolve();
    });

    const names = card.getTriggerCalls().map((c) => c.tokens.vessel_name);
    expect(names).toEqual(['Okänd båt', 'RONJA', 'Okänd båt']);
    expect(names).not.toContain('Unknown');
  });

  test('testgrinden blockerar under jest (NODE_ENV=test) — inga mock-tokenfel', () => {
    const light = makeApp();
    light._bridgeOpeningTrigger = { trigger: jest.fn() };
    light._onBridgeOpeningWarning(payloadFor());
    expect(light._bridgeOpeningTrigger.trigger).not.toHaveBeenCalled();
    // ...och nyckeln får INTE sättas: en skippad testkörning ska inte kunna
    // spärra en riktig varning.
    expect(light._firedOpeningEvents.size).toBe(0);
  });

  test('saknat kort loggas som fel (svälj-fällan) och kastar inte', async () => {
    const light = makeApp();
    light._bridgeOpeningTrigger = null;
    await withRealFlowGate(async () => {
      expect(() => light._onBridgeOpeningWarning(payloadFor())).not.toThrow();
    });
    expect(light.error).toHaveBeenCalledWith(
      expect.stringContaining('bridge_opening_soon-kortet saknas'),
    );
  });

  test('ett kastande kort ger ingen ohanterad rejection', async () => {
    const light = makeApp();
    light._bridgeOpeningTrigger = {
      trigger: jest.fn().mockRejectedValue(new Error('Homey nekade')),
    };
    await withRealFlowGate(async () => {
      light._onBridgeOpeningWarning(payloadFor());
      // Låt fire-and-forget-kedjan landa.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(light.error).toHaveBeenCalledWith(
      expect.stringContaining('OPENING_TRIGGER_ERROR'),
      'Homey nekade',
    );
  });

  test('trasig payload avfyrar ingenting', async () => {
    const light = makeApp();
    light._bridgeOpeningTrigger = { trigger: jest.fn() };
    await withRealFlowGate(async () => {
      light._onBridgeOpeningWarning(null);
      light._onBridgeOpeningWarning({ bridge: 'Klaffbron' }); // eventId saknas
      light._onBridgeOpeningWarning({ eventId: 'x#1' }); // bridge saknas
    });
    expect(light._bridgeOpeningTrigger.trigger).not.toHaveBeenCalled();
  });
});

describe('Etapp 6: run-listenern för bridge_opening_soon', () => {
  let app = null;
  let listener = null;

  beforeEach(async () => {
    app = await bootApp();
    [listener] = app._bridgeOpeningTrigger.runListeners;
  });

  afterEach(async () => {
    if (app) await app.onUninit();
    app = null;
    delete global.__TEST_MODE__;
  });

  test('"Alla broar" matchar allt', async () => {
    await expect(listener({ bridge: 'any' }, { bridge: 'stridsbergsbron' })).resolves.toBe(true);
  });

  test('vald bro matchar bara sin egen', async () => {
    await expect(listener({ bridge: 'klaffbron' }, { bridge: 'klaffbron' })).resolves.toBe(true);
    await expect(listener({ bridge: 'klaffbron' }, { bridge: 'stridsbergsbron' })).resolves.toBe(false);
  });

  test('dropdown-objekt (Homeys andra argumentform) normaliseras', async () => {
    await expect(listener({ bridge: { id: 'klaffbron' } }, { bridge: 'klaffbron' })).resolves.toBe(true);
  });

  test('saknad bro i args eller state avvisas (fail-safe)', async () => {
    await expect(listener({}, { bridge: 'klaffbron' })).resolves.toBe(false);
    await expect(listener({ bridge: 'klaffbron' }, {})).resolves.toBe(false);
  });
});

describe('Etapp 6: _observeBridgeOpening (matningen ur vessel-flödet)', () => {
  const makeWired = () => {
    const app = makeApp();
    app.bridgeOpeningService = {
      observeVessel: jest.fn(),
      notePassage: jest.fn(),
    };
    return app;
  };

  test('varje observation matas till servicen', () => {
    const app = makeWired();
    const vessel = { mmsi: '1', targetBridge: 'Klaffbron' };
    app._observeBridgeOpening(vessel);
    expect(app.bridgeOpeningService.observeVessel).toHaveBeenCalledWith(vessel);
  });

  test('en FÄRSK målbropassage rapporteras — observeVessel FÖRST', () => {
    const app = makeWired();
    const order = [];
    app.bridgeOpeningService.observeVessel.mockImplementation(() => order.push('observe'));
    app.bridgeOpeningService.notePassage.mockImplementation(() => order.push('passage'));

    app._observeBridgeOpening({
      mmsi: '1', targetBridge: 'Stridsbergsbron', passedAt: { Klaffbron: Date.now() },
    });

    expect(app.bridgeOpeningService.notePassage).toHaveBeenCalledWith('1', 'Klaffbron');
    // Ordningen är kontraktet: observeVessel upptäcker passagen själv och
    // spärrar återbeväpning i samma meddelande. Körs notePassage först är
    // armen borta och bron kan beväpnas om direkt efter sin egen passage.
    expect(order).toEqual(['observe', 'passage']);
  });

  test('gammal ankring och icke-målbroar rapporteras INTE', () => {
    const app = makeWired();
    app._observeBridgeOpening({
      mmsi: '1',
      passedAt: {
        Klaffbron: Date.now() - 60000, // gammal
        Olidebron: Date.now(), // mellanbro — öppnar inte
        Stallbackabron: Date.now(), // öppnar ALDRIG
      },
    });
    expect(app.bridgeOpeningService.notePassage).not.toHaveBeenCalled();
  });

  test('en kastande service stoppar aldrig notisvägen (men loggas)', () => {
    const app = makeWired();
    app.bridgeOpeningService.observeVessel.mockImplementation(() => {
      throw new Error('trasig arm');
    });
    expect(() => app._observeBridgeOpening({ mmsi: '9' })).not.toThrow();
    expect(app.error).toHaveBeenCalledWith(
      expect.stringContaining('observeVessel misslyckades för 9'),
      'trasig arm',
    );
  });

  test('utan service är anropet en ren no-op', () => {
    const app = makeApp();
    app.bridgeOpeningService = null;
    expect(() => app._observeBridgeOpening({ mmsi: '1' })).not.toThrow();
  });

  test('FÄLTLIST-FÄLLAN: servicen skriver INGA nya fält på vessel-objektet', async () => {
    // Järnregel 5 har 13 dokumenterade offer. Etapp 6 undviker fällan genom
    // att inte införa något vessel-fält alls — armarna lever i servicens egen
    // Map. Det här testet bevisar påståendet mot den RIKTIGA servicen.
    const app = makeApp();
    app.bridgeOpeningService = new BridgeOpeningService({ logger: app });
    const vessel = {
      mmsi: '1',
      name: 'TEST',
      lat: KLAFF.lat - 0.008,
      lon: KLAFF.lon,
      sog: 6,
      cog: 20,
      targetBridge: 'Klaffbron',
      _hasMovementProof: true,
      _routeDirection: 'north',
      timestamp: Date.now(),
    };
    const before = Object.keys(vessel).sort();
    app._observeBridgeOpening(vessel);
    app.bridgeOpeningService.tick();
    expect(Object.keys(vessel).sort()).toEqual(before);
  });
});

describe('Etapp 6: _isBridgeOpeningQuayWobbler återanvänder V1-kajbokföringen', () => {
  const vesselNearKlaff = (extra = {}) => ({
    mmsi: '77',
    targetBridge: 'Klaffbron',
    lat: KLAFF.lat - 0.004, // ~440 m söder om bron
    lon: KLAFF.lon,
    // Under BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN (3,13): en fix på eller
    // över medianfarten för en äkta anflygning friar båten direkt, och sviten
    // ska pröva SJÄLVA kajgrinden.
    sog: 3,
    ...extra,
  });

  // En LEDGER-post som produktionen faktiskt kan ha: bandSince ligger längre
  // bak än BRIDGE_OPENING.QUAY_STAY_MIN_MS, dvs. båten har uppehållit sig i
  // kajbandet tillräckligt länge för att grinden ska gälla.
  const quayEntry = (extra = {}) => ({
    stillAt: Date.now() - 30000,
    bandSince: Date.now() - (BRIDGE_OPENING.QUAY_STAY_MIN_MS + 60000),
    movingFixes: 0,
    ...extra,
  });

  test('ingen kajhistorik ⇒ ingen kajvobblare (transittrafik passerar)', () => {
    const app = makeApp();
    expect(app._isBridgeOpeningQuayWobbler(vesselNearKlaff())).toBe(false);
  });

  test('färsk kajstillhet utan korroborering ⇒ kajvobblare', () => {
    const app = makeApp();
    const v = vesselNearKlaff();
    app._openingQuayLedger.set('77', quayEntry({ lat: v.lat, lon: v.lon }));
    expect(app._isBridgeOpeningQuayWobbler(v)).toBe(true);
  });

  test('REFERENSPUNKTEN ÄR MÅLBRON: netto-närmande mot bron friar båten', () => {
    // Det här är hela poängen med att inte återanvända trigger-punkten som
    // referens: en äkta avgång rör sig BORT från kajen/punkten men MOT bron.
    const app = makeApp();
    const v = vesselNearKlaff();
    // Ankaret ligger 100 m längre från bron än nuvarande position
    // (> NET_APPROACH_M) ⇒ (b)-benet uppfyllt ⇒ ingen kajvobblare.
    app._openingQuayLedger.set('77', quayEntry({ lat: v.lat - 0.0011, lon: v.lon }));
    expect(QUAY_DEPARTURE_GATE.NET_APPROACH_M).toBeLessThan(100);
    expect(app._isBridgeOpeningQuayWobbler(v)).toBe(false);
  });

  test('utgången historik påverkar ingen beväpning', () => {
    const app = makeApp();
    const v = vesselNearKlaff();
    app._openingQuayLedger.set('77', quayEntry({
      stillAt: Date.now() - (QUAY_DEPARTURE_GATE.MEMORY_MS + 60000),
      lat: v.lat,
      lon: v.lon,
    }));
    expect(app._isBridgeOpeningQuayWobbler(v)).toBe(false);
  });

  test('RÄCKVIDDEN ÄR NÅBAR: _noteQuayStability bokför en båt VID målbron (AKIRA-klassen)', () => {
    // Regressionsvakt mot den fällda blindheten: V1-kartan bokför bara inom
    // 500 m från en TRIGGER-punkt, och Kanalinfarten ligger 1982 m från
    // Klaffbron. Predikatet var därför strukturellt neutralt vid målbroarna
    // och kunde INTE fällas av något test som seedade kartan för hand.
    // Här körs den RIKTIGA bokföringsvägen, med AKIRA:s uppmätta profil:
    // sog=0 vid 410 m, sedan ETT enda sampel på 1,1 kn vid 396 m.
    const app = makeApp();
    const still = {
      mmsi: '257605080',
      targetBridge: 'Klaffbron',
      lat: KLAFF.lat - 0.00368, // ~410 m söder om bron
      lon: KLAFF.lon,
      sog: 0,
    };
    app._noteQuayStability(still);
    expect(app._openingQuayLedger.has('257605080')).toBe(true);
    // V1-kartan ska stå ORÖRD (boat_near-grinden får inte ändras).
    expect(app._quayStableLedger.has('257605080')).toBe(false);
    // AKIRA:s vistelse i kajbandet var 17 minuter innan vobbeln. Klockan
    // backas explicit i stället för att sviten sover — grinden kräver
    // BRIDGE_OPENING.QUAY_STAY_MIN_MS i bandet.
    const entry = app._openingQuayLedger.get('257605080');
    entry.bandSince = Date.now() - 17 * 60 * 1000;

    const wobble = { ...still, lat: KLAFF.lat - 0.00356, sog: 1.1 }; // ~396 m
    app._noteQuayStability(wobble);
    expect(app._isBridgeOpeningQuayWobbler(wobble)).toBe(true);
    // ...men ETT KORT STOPP är ingen kajvistelse: en båt som just kommit in i
    // bandet (ELFKUNGEN-klassen, en 0,1-knopsfix mitt i en 7,8-knopsresa) får
    // aldrig spärras. Samma fix, färsk bandtid.
    entry.bandSince = Date.now();
    expect(app._isBridgeOpeningQuayWobbler(wobble)).toBe(false);
    entry.bandSince = Date.now() - 17 * 60 * 1000;

    // ...och en ÄKTA avgång friar sig DIREKT på en fix vid medianfarten för
    // en anflygning (BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN) — kajerna vid
    // målbroarna ligger så nära att en fördröjning på en fix kostar hela
    // varningen (265726650/265819940).
    const departing = { ...still, lat: KLAFF.lat - 0.00300, sog: 4.5 };
    app._noteQuayStability(departing);
    expect(app._isBridgeOpeningQuayWobbler(departing)).toBe(false);
    // ...och en LÅNGSAM men verklig avgång friar sig på netto-närmandet mot
    // bron, räknat från kajvistelsens BÖRJAN (265819940: 369→225 m i 0–1,8 kn).
    const slowLeaver = { ...still, lat: KLAFF.lat - 0.00200, sog: 1.8 };
    app._noteQuayStability(slowLeaver);
    expect(app._isBridgeOpeningQuayWobbler(slowLeaver)).toBe(false);
  });

  test('FAIL-OPEN: okänd/saknad målbro och interna fel spärrar aldrig', () => {
    const app = makeApp();
    expect(app._isBridgeOpeningQuayWobbler({ mmsi: '77' })).toBe(false);
    expect(app._isBridgeOpeningQuayWobbler({ mmsi: '77', targetBridge: 'Fantasibron' })).toBe(false);
    app._quayDepartureNeedsProof = () => {
      throw new Error('trasig bokföring');
    };
    const v = vesselNearKlaff();
    app._openingQuayLedger.set('77', quayEntry({ lat: v.lat, lon: v.lon }));
    expect(app._isBridgeOpeningQuayWobbler(v)).toBe(false);
    expect(app.error).toHaveBeenCalledWith(
      '[BRIDGE_OPENING] Kajvobbel-predikatet kastade:', 'trasig bokföring',
    );
  });
});

describe('Etapp 6: engångsnycklarna städas', () => {
  test('_pruneDedupCaches släpper nycklar äldre än TTL:n', () => {
    const app = makeApp();
    app.vesselDataService = { getAllVessels: () => [] };
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._firedOpeningEvents.set('Klaffbron#1', Date.now() - (app._OPENING_DEDUP_TTL_MS + 1000));
    app._firedOpeningEvents.set('Klaffbron#2', Date.now());

    app._pruneDedupCaches();

    expect(app._firedOpeningEvents.has('Klaffbron#1')).toBe(false);
    expect(app._firedOpeningEvents.has('Klaffbron#2')).toBe(true);
  });
});
