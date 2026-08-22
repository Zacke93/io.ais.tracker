'use strict';

jest.mock('homey');

/**
 * =============================================================================
 * J15 (helkodsgranskning runda 2, 2026-08-22)
 * =============================================================================
 * ÖPPNINGSVARNINGENS PERSISTENTA DEDUP-FÖNSTER VAR KORTARE ÄN FÖRVARNINGEN.
 *
 * _OPENING_PERSIST_WINDOW_MS var CONVOY_WINDOW_MS (10 min) och posten
 * stämplades vid VARNINGEN. Men det som ska dedupas är hela ÅTERSTÅENDE
 * anflygningen fram till omstartens nya varning, och kortets egen hint (mätt
 * över ~240 h) anger förvarningen till MEDIAN 17 min. En Homey-appuppdatering
 * 11 min efter varningen gav därför ETT ANDRA "öppnar snart" för SAMMA
 * öppning — precis det hål guarden infördes för att stänga.
 *
 * FIXEN: posten bär UTGÅNGSTID (avfyrning + konvojfönstret + förväntad ETA,
 * med ett tak), speglad i BÅDE _loadPersistentOpeningWarnings,
 * _persistOpeningWarnings och läsningen i _onBridgeOpeningWarning. Speglingen
 * är obligatorisk: prunar boot eller skrivningen enligt gamla regeln är fixen
 * neutraliserad utan att ett enda test rodnar. Dessutom NOLLAS nyckeln vid
 * bekräftad passage, så en äkta ny öppning aldrig kan tystas av den gamla.
 *
 * ⚠️ UPPDATERAD I FIXRUNDA 2b (2026-08-22): den utgången är OMSTARTSSKYDDET
 * och gäller bara poster som lästs in VID BOOT. En post som DEN LEVANDE
 * sessionen skrev läses med enbart konvojfönstret — annars tystas den
 * legitima omvarningen efter lång radiotystnad (gap-35min-scenariot, HERA II i
 * 20260707-14h). Postens form är därför {firedAt, expiresAt, bootLoaded} och
 * settings-bloben bär {firedAt, expiresAt}. Sessionsmedvetenheten och dess
 * gränsfall låses i tests/j15b-sessionsmedveten-oppningsdedup.test.js; den här
 * sviten låser omstartshalvan, formen och speglingen.
 *
 * ORDNINGEN ÄR INTE KOSMETISK: 'homey' måste hämtas FÖRE '../app' (annars
 * automockar jest kortet och appen bootar utan flow-kort).
 */
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const { BRIDGE_OPENING } = require('../lib/constants');

const MIN = 60 * 1000;

/** Full appstart via produktionsvägen (samma dans som replay-harnessen). */
const bootApp = async () => {
  const app = new AISBridgeApp();
  app.homey = mockHomey;
  mockHomey.app.settings = { debug_level: 'off', ais_api_key: null };
  mockHomey.settings = {
    get: (key) => (key in mockHomey.app.settings ? mockHomey.app.settings[key] : null),
    set: (key, value) => {
      mockHomey.app.settings[key] = value;
    },
    on: () => {},
    off: () => {},
  };
  global.__TEST_MODE__ = true;
  await app.onInit();
  // Loggkanalerna fångas EFTER boot: sviten mäter bara det vägarna nedan
  // skriver, och app.error ska vara tyst i alla scenarier här.
  app.log = jest.fn();
  app.error = jest.fn();
  return app;
};

/**
 * Kringgå testgrinden i _onBridgeOpeningWarning och kör EXAKT produktionens
 * väg (samma teknik som replayRunner: NODE_ENV='production' + TEST_MODE av).
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

const payloadFor = (overrides = {}) => ({
  t: Date.now(),
  eventId: 'Klaffbron#1',
  bridge: 'Klaffbron',
  direction: 'northbound',
  etaMinutes: 15,
  vesselCount: 1,
  leadVessel: 'JUNO',
  leadMmsi: '111',
  firedBy: 'deadline',
  mmsis: ['111'],
  distanceM: 1500,
  ...overrides,
});

describe('J15: öppningsdedupens post bär UTGÅNGSTID, inte avfyrningstid', () => {
  let app = null;
  let nowMs = 0;

  beforeEach(() => {
    nowMs = 1767225600000; // fast utgångspunkt — testet får aldrig bero på klockan
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(async () => {
    if (app) await app.onUninit();
    app = null;
    Date.now.mockRestore();
    delete global.__TEST_MODE__;
  });

  /** Simulera en Homey-appuppdatering: bara settings-lagret överlever. */
  const restart = (instance) => {
    instance._firedOpeningEvents.clear();
    instance._persistentOpeningWarnings = new Map();
    instance._loadPersistentOpeningWarnings();
  };

  test('KÄRNFALLET: varning med eta 15 min + omstart efter 11 min ⇒ INGEN andra varning', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ etaMinutes: 15 }));
      await Promise.resolve();
    });
    expect(card.getTriggerCalls()).toHaveLength(1);

    // 11 min senare uppdaterar Homey appen. Med det GAMLA 10-minutersfönstret
    // hade posten redan fallit ur och användaren fått kort nummer två.
    nowMs += 11 * MIN;
    restart(app);

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ eventId: 'Klaffbron#7', etaMinutes: 4 }));
      await Promise.resolve();
    });
    expect(card.getTriggerCalls()).toHaveLength(1);
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('OPENING_DEDUP_PERSIST'))).toBe(true);
  });

  test('DEDUPEN ÄR INTE EVIG: efter utgången (10 + 15 min) varnar en ny öppning', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ etaMinutes: 15 }));
      await Promise.resolve();
    });

    nowMs += 26 * MIN; // 10 (konvojfönster) + 15 (eta) + 1 marginal
    restart(app);

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ eventId: 'Klaffbron#9' }));
      await Promise.resolve();
    });
    expect(card.getTriggerCalls()).toHaveLength(2);
  });

  test('UTGÅNGEN ÄR SKRIVEN, INTE BARA BERÄKNAD: settings-bloben bär framtidstiden', async () => {
    app = await bootApp();
    app._bridgeOpeningTrigger.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ etaMinutes: 15 }));
      await Promise.resolve();
    });

    const blob = mockHomey.settings.get('persistent_opening_warnings');
    const värden = Object.values(blob);
    expect(värden).toHaveLength(1);
    // 10 min konvojfönster + 15 min förväntad ankomst. Formen är
    // {firedAt, expiresAt} (fixrunda 2b): firedAt behövs för att den LEVANDE
    // sessionen ska kunna läsa posten med sitt smalare fönster, expiresAt är
    // lagringstiden OCH omstartens fönster.
    expect(värden[0].expiresAt).toBe(nowMs + BRIDGE_OPENING.CONVOY_WINDOW_MS + 15 * MIN);
    expect(värden[0].firedAt).toBe(nowMs);
  });

  test('OKÄND ETA (-1-sentinelen) ⇒ ren CONVOY_WINDOW_MS, dvs. dagens beteende', async () => {
    app = await bootApp();
    app._bridgeOpeningTrigger.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ etaMinutes: null }));
      await Promise.resolve();
    });

    const värden = Object.values(mockHomey.settings.get('persistent_opening_warnings'));
    expect(värden[0].expiresAt).toBe(nowMs + BRIDGE_OPENING.CONVOY_WINDOW_MS);
  });

  test('SÄKERHETSTAKET binder en orimlig ETA (600 min ⇒ högst 1 h)', async () => {
    app = await bootApp();
    app._bridgeOpeningTrigger.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ etaMinutes: 600 }));
      await Promise.resolve();
    });

    const värden = Object.values(mockHomey.settings.get('persistent_opening_warnings'));
    expect(värden[0].expiresAt).toBe(nowMs + app._OPENING_DEDUP_TTL_MS);
  });

  test('PASSAGEN NOLLAR NYCKELN: en äkta ny öppning kan aldrig tystas av den gamla', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ etaMinutes: 20 }));
      await Promise.resolve();
    });
    expect(app._persistentOpeningWarnings.size).toBe(1);

    // Båten passerar bron 3 min senare — svepet i _observeBridgeOpening läser
    // vessel.passedAt (samma 2000 ms-fönster som notePassage använder).
    nowMs += 3 * MIN;
    app._observeBridgeOpening({
      mmsi: '111', lat: 58.28, lon: 12.28, targetBridge: 'Stridsbergsbron', passedAt: { Klaffbron: nowMs },
    });
    expect(app._persistentOpeningWarnings.size).toBe(0);
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('OPENING_DEDUP_PASSED'))).toBe(true);

    // Ny öppning för samma båt och bro (U-svängaren är tillbaka) släpps.
    nowMs += 2 * MIN;
    restart(app);
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ eventId: 'Klaffbron#12' }));
      await Promise.resolve();
    });
    expect(card.getTriggerCalls()).toHaveLength(2);
  });

  test('GAMLA POSTER (avfyrningstid) degraderar SÄKERT — läses som utgångna', async () => {
    // En post skriven av en tidigare version är ett tal i det FÖRFLUTNA. Den
    // får inte krascha och inte blockera: en missad dedup ger på sin höjd
    // dagens dubbelvarning, en felaktig dedup TYSTAR en öppning.
    mockHomey.app = mockHomey.app || {};
    app = await bootApp();
    mockHomey.settings.set('persistent_opening_warnings', {
      'Klaffbron|111|northbound': nowMs - 2 * MIN, // gammal form: avfyrningstid
      'Klaffbron|222|northbound': 'skräp', // och något som inte ens är ett tal
    });
    app._bridgeOpeningTrigger.clearTriggerCalls();

    restart(app);
    expect(app._persistentOpeningWarnings.size).toBe(0);

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor());
      await Promise.resolve();
    });
    expect(app._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(1);
    expect(app.error).not.toHaveBeenCalled();
  });

  test('SPEGLINGEN: en skrivning mitt i fönstret får INTE pruna bort den levande posten', async () => {
    // Fällan fixen kan falla i: om _persistOpeningWarnings prunar enligt gamla
    // regeln ("äldre än 10 min") försvinner posten vid NÄSTA skrivning och
    // omstartsdubbletten är tillbaka — utan att kärntestet ovan rodnar,
    // eftersom det bara skriver en gång.
    // FIXRUNDA 2b gör provet skarpare: vid +12 min har postens LÄSfönster
    // (konvojfönstret) redan gått ut för den levande sessionen, och bara
    // LAGRINGSTIDEN (expiresAt) håller den kvar. Prunas den på läsfönstret
    // finns ingenting att ladda när omstarten kommer.
    app = await bootApp();
    app._bridgeOpeningTrigger.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ etaMinutes: 15 }));
      await Promise.resolve();
    });

    nowMs += 12 * MIN; // bortom gamla 10-minutersgränsen, innanför den nya
    await withRealFlowGate(async () => {
      // en ANNAN båt varnas för samma bro ⇒ skrivningen körs om
      app._onBridgeOpeningWarning(payloadFor({
        eventId: 'Klaffbron#3', leadMmsi: '999', mmsis: ['999'],
      }));
      await Promise.resolve();
    });

    const blob = mockHomey.settings.get('persistent_opening_warnings');
    expect(Object.keys(blob)).toContain('Klaffbron|111|northbound');
    expect(app._persistentOpeningWarnings.has('Klaffbron|111|northbound')).toBe(true);
  });

  test('SPEGLINGEN, ANDRA HALVAN: en UTGÅNGEN post städas ur både kartan och bloben', async () => {
    // Prune-reglerna i _loadPersistentOpeningWarnings och
    // _persistOpeningWarnings måste tolka värdet LIKADANT som läsningen. En
    // kvarglömd regel av gammal form ("äldre än 10 min") mäter åldern på ett
    // värde som numera ligger i FRAMTIDEN och håller därför kvar poster i upp
    // till tio minuter EFTER utgången — dedupen lever längre än den öppning
    // den beskriver, och en legitim andra varning kan tystas.
    app = await bootApp();
    app._bridgeOpeningTrigger.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ etaMinutes: 0 })); // utgång = +10 min
      await Promise.resolve();
    });
    expect(app._persistentOpeningWarnings.has('Klaffbron|111|northbound')).toBe(true);

    nowMs += 11 * MIN; // posten gick ut för en minut sedan
    await withRealFlowGate(async () => {
      // valfri skrivning kör prunen
      app._onBridgeOpeningWarning(payloadFor({
        eventId: 'Klaffbron#5', leadMmsi: '888', mmsis: ['888'],
      }));
      await Promise.resolve();
    });

    expect(app._persistentOpeningWarnings.has('Klaffbron|111|northbound')).toBe(false);
    expect(Object.keys(mockHomey.settings.get('persistent_opening_warnings')))
      .not.toContain('Klaffbron|111|northbound');
  });

  test('RETURPASSAGEN (motsatt riktning) är en äkta ny öppning och släpps alltid', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ etaMinutes: 20 }));
      await Promise.resolve();
    });

    nowMs += 5 * MIN;
    restart(app);
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({
        eventId: 'Klaffbron#4', direction: 'southbound',
      }));
      await Promise.resolve();
    });

    expect(card.getTriggerCalls()).toHaveLength(2);
    expect(card.getTriggerCalls()[1].tokens.direction).toBe('söderut');
  });
});

/**
 * =============================================================================
 * J22-INJEKTIONEN (helkodsgranskning runda 2, 2026-08-22)
 * =============================================================================
 * SAMMA LEDNINGSDRAGNING SOM J15 RÖR, därför i samma fil: appens koppling till
 * BridgeOpeningService.
 *
 * VesselDataService.hasArmingMovementEvidence (C6, etapp 7 fas C) var skriven,
 * MÄTT (den tar bort tre rådataverifierade enkelsampelsfantomer mot 22 äkta
 * förvarningar) och dokumenterad för öppningsbeväpningen — men hade NOLL
 * anropare i hela trädet. Grinden var alltså aldrig frågad, och
 * BridgeOpeningService._canArm gatade bara på _hasMovementProof (ett enda
 * sampel räcker). Här låses APPENS halva: predikatet når servicen, och det är
 * VesselDataService som svarar (ingen parallell sanning i servicen).
 * BESLUTET om hur servicen använder det ligger i BridgeOpeningService.
 */
describe('J22: beväpningsbeviset är INJICERAT, inte duplicerat', () => {
  let app = null;

  afterEach(async () => {
    if (app) await app.onUninit();
    app = null;
    delete global.__TEST_MODE__;
  });

  test('servicen får ett predikat som delegerar till VesselDataService', async () => {
    app = await bootApp();
    const svc = app.bridgeOpeningService;

    expect(typeof svc._hasArmingMovementEvidence).toBe('function');

    const spion = jest.spyOn(app.vesselDataService, 'hasArmingMovementEvidence');
    // C6:s egen semantik: korroborerad rörelse ELLER ett rimligt rörelsesampel.
    expect(svc._hasArmingMovementEvidence({ _hasCorroboratedMovement: true })).toBe(true);
    expect(svc._hasArmingMovementEvidence({ _plausibleMovementSeen: true })).toBe(true);
    // ENKELSAMPELSFANTOMEN (M3-klassen, mmsi 211488728): ett enda sampel utan
    // rörelsebevis ⇒ predikatet säger nej.
    expect(svc._hasArmingMovementEvidence({ _hasMovementProof: true })).toBe(false);
    expect(spion).toHaveBeenCalledTimes(3);
    spion.mockRestore();
  });

  test('FAIL-OPEN: utan VesselDataService släpper predikatet igenom', async () => {
    // Produktprincipen är att en MISSAD öppning är värre än ett falsklarm —
    // en trasig grind ska släppa igenom, precis som kajvobbel-predikatets
    // catch gör.
    app = await bootApp();
    const svc = app.bridgeOpeningService;
    const sparad = app.vesselDataService;
    app.vesselDataService = null;

    expect(svc._hasArmingMovementEvidence({})).toBe(true);

    app.vesselDataService = sparad;
  });
});
