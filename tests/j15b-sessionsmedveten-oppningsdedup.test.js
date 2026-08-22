'use strict';

jest.mock('homey');

/**
 * =============================================================================
 * J15b (helkodsgranskning runda 2, FIXRUNDA 2b, 2026-08-22)
 * =============================================================================
 * ÖPPNINGSDEDUPEN ÄR SESSIONSMEDVETEN — ETT FÖNSTER PER URSPRUNG.
 *
 * REGRESSIONEN som den här sviten låser: fixrunda 2 gav den persistenta
 * öppningsdedupen ett ETA-förlängt fönster (avfyrning + konvojfönstret +
 * förväntad ETA) för att stänga omstartshålet. Men kartan konsulteras vid
 * VARJE varning, inte bara efter en omstart — så det bredare fönstret dödade
 * också den LEGITIMA omvarningen i SAMMA session efter lång radiotystnad:
 *
 *  - syntetiska scenariot gap-35min-över-Klaffbron: varning 06:38 med ETA
 *    ~45 min, 35 min radiotystnad, omvarning 07:09 på ett FÄRSKT fix 14 min
 *    före passagen — släcktes (ÖPPNINGSLEVERANS 3≠2).
 *  - 20260707-14h: HERA II (258177180) 33 min tystnad, omvarningen 09:15:08
 *    på 374 m från Klaffbron släcktes ⇒ 23 → 22 varningar mot facit.
 *
 * BESLUTET (dirigent): posten VET var den kommer ifrån.
 *  - BOOT-LADDAD post (skriven av en TIDIGARE session) = omstartsskydd ⇒
 *    det förlängda fönstret, kapat av _OPENING_PERSIST_MAX_MS.
 *  - IN-SESSION-post ⇒ EXAKT konvojfönstret, som före J15. BridgeOpeningService
 *    lever och äger händelsemodellen; kartan är bara hängslen.
 *
 * LAGRINGSTIDEN är expiresAt för båda — annars finns in-session-posten inte
 * kvar att ladda när omstarten kommer 11 min senare, och omstartshålet är
 * tillbaka. Sviten prövar därför BÅDA halvorna, och skillnaden mellan dem.
 *
 * ORDNINGEN ÄR INTE KOSMETISK: 'homey' måste hämtas FÖRE '../app' (annars
 * automockar jest kortet och appen bootar utan flow-kort).
 */
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const { BRIDGE_OPENING } = require('../lib/constants');
const { normalizeNavStatus } = require('../lib/utils/aisFieldNormalization');

const MIN = 60 * 1000;

/**
 * Full appstart via produktionsvägen (samma dans som replay-harnessen).
 * `behållSettings` ger EN äkta omstart: den nya instansen möter samma
 * settings-store som den gamla lämnade efter sig — exakt vad ctrl:'restart'
 * i replayRunner och en Homey-appuppdatering gör.
 */
const bootApp = async ({ behållSettings = false } = {}) => {
  const app = new AISBridgeApp();
  app.homey = mockHomey;
  if (!behållSettings) {
    mockHomey.app.settings = { debug_level: 'off', ais_api_key: null };
  }
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
  etaMinutes: 45,
  vesselCount: 1,
  leadVessel: 'HERA II',
  leadMmsi: '258177180',
  firedBy: 'fix',
  mmsis: ['258177180'],
  distanceM: 1454,
  ...overrides,
});

const NYCKEL = 'Klaffbron|258177180|northbound';

describe('J15b: IN-SESSION-fönstret är konvojfönstret — omvarningen efter radiotystnad släpps', () => {
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

  test('KÄRNFALLET (gap-35min/HERA II): varning eta 45 → 35 min tystnad → omvarning SLÄPPS', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ etaMinutes: 45 }));
      await Promise.resolve();
    });
    expect(card.getTriggerCalls()).toHaveLength(1);

    // 35 minuters radiotystnad. INGEN omstart — servicen lever, armen lever,
    // och nästa färska fix ger en ny, avsiktlig varning 14 min före passagen.
    // Med det ETA-förlängda fönstret (10 + 45 = 55 min) hade den släckts.
    nowMs += 35 * MIN;
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ eventId: 'Klaffbron#7', etaMinutes: 14, distanceM: 374 }));
      await Promise.resolve();
    });

    expect(card.getTriggerCalls()).toHaveLength(2);
    expect(card.getTriggerCalls()[1].state.eventId).toBe('Klaffbron#7');
    expect(app.log.mock.calls.some((c) => String(c[0]).includes('OPENING_DEDUP_PERSIST'))).toBe(false);
  });

  test('HÄNGSLENA STÅR KVAR: en återanropning INOM konvojfönstret dedupas fortfarande', async () => {
    // Kartans ursprungliga uppgift i den levande sessionen är att göra
    // avfyrningsvägen idempotent. Den får inte tappas bort när fönstret smalnas.
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor());
      await Promise.resolve();
    });

    nowMs += 5 * MIN; // innanför CONVOY_WINDOW_MS (10 min)
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ eventId: 'Klaffbron#2' }));
      await Promise.resolve();
    });

    expect(card.getTriggerCalls()).toHaveLength(1);
    // Loggraden ska säga VILKET fönster som spärrade — "omstartsdubblett" vore
    // osant här: appen har inte startat om, det är konvojfönstrets hängslen.
    const rad = app.log.mock.calls.map((c) => String(c[0])).find((s) => s.includes('OPENING_DEDUP_PERSIST'));
    expect(rad).toContain('(konvojfönstret)');
  });

  test('GRÄNSEN ÄR KONVOJFÖNSTRET, INTE ETA: sista millisekunden spärrar, nästa släpper', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ etaMinutes: 45 }));
      await Promise.resolve();
    });

    nowMs += BRIDGE_OPENING.CONVOY_WINDOW_MS - 1;
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ eventId: 'Klaffbron#2' }));
      await Promise.resolve();
    });
    expect(card.getTriggerCalls()).toHaveLength(1);

    nowMs += 2; // ett ögonblick bortom fönstret
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ eventId: 'Klaffbron#3' }));
      await Promise.resolve();
    });
    expect(card.getTriggerCalls()).toHaveLength(2);
  });

  test('LAGRINGSTIDEN är den FÖRLÄNGDA utgången även för en in-session-post', async () => {
    // Skillnaden mellan läsfönster och lagringstid ÄR fixen. Skrivs bara
    // konvojfönstret till settings finns posten inte kvar när omstarten kommer.
    app = await bootApp();
    app._bridgeOpeningTrigger.clearTriggerCalls();

    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({ etaMinutes: 15 }));
      await Promise.resolve();
    });

    const post = app._persistentOpeningWarnings.get(NYCKEL);
    expect(post.bootLoaded).toBe(false);
    expect(post.firedAt).toBe(nowMs);
    expect(post.expiresAt).toBe(nowMs + BRIDGE_OPENING.CONVOY_WINDOW_MS + 15 * MIN);

    const blob = mockHomey.settings.get('persistent_opening_warnings');
    expect(blob[NYCKEL]).toEqual({
      firedAt: nowMs, expiresAt: nowMs + BRIDGE_OPENING.CONVOY_WINDOW_MS + 15 * MIN,
    });
  });
});

describe('J15b: ÄKTA OMSTART — den boot-laddade posten bär det förlängda fönstret', () => {
  let appEtta = null;
  let appTvaa = null;
  let nowMs = 0;

  beforeEach(() => {
    nowMs = 1767225600000;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(async () => {
    if (appEtta) await appEtta.onUninit();
    if (appTvaa) await appTvaa.onUninit();
    appEtta = null;
    appTvaa = null;
    Date.now.mockRestore();
    delete global.__TEST_MODE__;
  });

  /** Varna en gång i session 1 och riv appen — bara settings överlever. */
  const varnaOchStängAv = async (etaMinutes) => {
    appEtta = await bootApp();
    appEtta._bridgeOpeningTrigger.clearTriggerCalls();
    await withRealFlowGate(async () => {
      appEtta._onBridgeOpeningWarning(payloadFor({ etaMinutes }));
      await Promise.resolve();
    });
    expect(appEtta._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(1);
    await appEtta.onUninit();
    appEtta = null;
  };

  test('KÄRNFALLET: eta 15 → NY INSTANS 11 min senare ⇒ INGEN andra varning', async () => {
    await varnaOchStängAv(15);

    // Homey uppdaterar appen 11 min efter varningen. Den nya instansen har
    // eget kort och tomt händelseminne — bara settings bär vidare. Med
    // in-session-fönstret (10 min) hade posten varit ur fönstret och
    // användaren fått kort nummer två för SAMMA öppning.
    nowMs += 11 * MIN;
    appTvaa = await bootApp({ behållSettings: true });
    appTvaa._bridgeOpeningTrigger.clearTriggerCalls();

    const post = appTvaa._persistentOpeningWarnings.get(NYCKEL);
    expect(post.bootLoaded).toBe(true);

    await withRealFlowGate(async () => {
      appTvaa._onBridgeOpeningWarning(payloadFor({ eventId: 'Klaffbron#7', etaMinutes: 4 }));
      await Promise.resolve();
    });

    expect(appTvaa._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(0);
    const rad = appTvaa.log.mock.calls.map((c) => String(c[0])).find((s) => s.includes('OPENING_DEDUP_PERSIST'));
    expect(rad).toContain('(omstartsskydd)'); // fältloggen ska kunna skilja de två fönstren
  });

  test('DEDUPEN ÄR INTE EVIG: efter utgången (10 + 15 min) varnar den nya instansen', async () => {
    await varnaOchStängAv(15);

    nowMs += 26 * MIN; // 10 (konvojfönster) + 15 (eta) + 1 marginal
    appTvaa = await bootApp({ behållSettings: true });
    appTvaa._bridgeOpeningTrigger.clearTriggerCalls();
    expect(appTvaa._persistentOpeningWarnings.size).toBe(0);

    await withRealFlowGate(async () => {
      appTvaa._onBridgeOpeningWarning(payloadFor({ eventId: 'Klaffbron#9' }));
      await Promise.resolve();
    });
    expect(appTvaa._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(1);
  });

  test('PASSAGEN NOLLAR ÄVEN EN BOOT-LADDAD POST', async () => {
    // En post som överlever sin egen passage kan tysta nästa äkta öppning för
    // samma bro och båt (U-svängaren som vänder om och kommer tillbaka).
    await varnaOchStängAv(45);

    nowMs += 5 * MIN;
    appTvaa = await bootApp({ behållSettings: true });
    appTvaa._bridgeOpeningTrigger.clearTriggerCalls();
    expect(appTvaa._persistentOpeningWarnings.get(NYCKEL).bootLoaded).toBe(true);

    appTvaa._observeBridgeOpening({
      mmsi: '258177180',
      lat: 58.28,
      lon: 12.28,
      targetBridge: 'Stridsbergsbron',
      passedAt: { Klaffbron: nowMs },
    });
    expect(appTvaa._persistentOpeningWarnings.size).toBe(0);
    expect(appTvaa.log.mock.calls.some((c) => String(c[0]).includes('OPENING_DEDUP_PASSED'))).toBe(true);

    // ...och returpassagen (samma riktning, ny öppning) släpps direkt.
    nowMs += 2 * MIN;
    await withRealFlowGate(async () => {
      appTvaa._onBridgeOpeningWarning(payloadFor({ eventId: 'Klaffbron#12' }));
      await Promise.resolve();
    });
    expect(appTvaa._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(1);
  });

  test('GAMMAL POSTFORM (rent tal) läses som utgångstid och behandlas som boot-laddad', async () => {
    // Degraderingen måste vara entydig ÅT BÅDA HÅLLEN: ett tal i FRAMTIDEN är
    // fixrunda 2:s utgångstid och spärrar, ett tal i det FÖRFLUTNA är antingen
    // utgånget eller den ännu äldre avfyrningstiden och spärrar inget. Ingen
    // form får krascha inläsningen.
    appTvaa = await bootApp();
    mockHomey.settings.set('persistent_opening_warnings', {
      [NYCKEL]: nowMs + 20 * MIN, // gammal form, ännu giltig
      'Klaffbron|999|northbound': nowMs - 2 * MIN, // gammal form, förbrukad
      'Klaffbron|888|northbound': 'skräp',
    });
    appTvaa._persistentOpeningWarnings = new Map();
    appTvaa._loadPersistentOpeningWarnings();
    appTvaa._bridgeOpeningTrigger.clearTriggerCalls();

    expect(appTvaa._persistentOpeningWarnings.size).toBe(1);
    expect(appTvaa._persistentOpeningWarnings.get(NYCKEL).bootLoaded).toBe(true);

    await withRealFlowGate(async () => {
      appTvaa._onBridgeOpeningWarning(payloadFor());
      await Promise.resolve();
    });
    expect(appTvaa._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(0);

    // Den förbrukade nyckeln spärrar inget — varningen går fram.
    await withRealFlowGate(async () => {
      appTvaa._onBridgeOpeningWarning(payloadFor({
        eventId: 'Klaffbron#3', leadMmsi: '999', mmsis: ['999'],
      }));
      await Promise.resolve();
    });
    expect(appTvaa._bridgeOpeningTrigger.getTriggerCalls()).toHaveLength(1);
    expect(appTvaa.error).not.toHaveBeenCalled();
  });
});

/**
 * =============================================================================
 * J35-APP SSOT (granskaranmärkning, samma runda)
 * =============================================================================
 * BETEENDET är redan låst i tests/h34-cog-normalisering.test.js (15 ⇒ null,
 * 0–14 orörda, skräp ⇒ null, källparitet mot hubbparsern). Det som saknades
 * var en låsning av att app.js DELEGERAR i stället för att bära en fjärde
 * kopia av gränsen: granskaren fann talet 14 utskrivet i app.js medan den nya
 * modulen lib/utils/aisFieldNormalization.js redan ägde regeln, och
 * kommentaren pekade dessutom på fel filer.
 *
 * Testet bor här och inte i h34-filen därför att h34-sviten ägs av en annan
 * agent i den här fixrundan; sambandet är dokumenterat i båda riktningarna.
 */
describe('J35-APP: appens navStatus-sanering ÄR den delade modulens', () => {
  const makeApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._replayCaptureFile = null;
    app.vesselDataService = { updateVessel: jest.fn() };
    return app;
  };
  const POSITION = { mmsi: '265001111', lat: 58.29, lon: 12.29 };

  test.each([0, 1, 5, 8, 14, 15, 16, -1, 3.5, NaN, null, undefined, 'moored'])(
    'navStatus %p ger EXAKT normalizeNavStatus värde genom _processAISMessage',
    (navStatus) => {
      const app = makeApp();
      app._processAISMessage({
        ...POSITION, sog: 0.1, cog: 90, navStatus,
      });
      const [, patch] = app.vesselDataService.updateVessel.mock.calls[0];
      // Jämförelsen görs mot MODULEN, inte mot en literal: det var glidningen
      // mellan två kopior av samma tal som var själva felet.
      expect(patch.navStatus).toBe(normalizeNavStatus(navStatus));
    },
  );

  test('POSITIONEN ÖVERLEVER ett kasserat navStatus (H34:s doktrin)', () => {
    const app = makeApp();
    app._processAISMessage({
      ...POSITION, sog: 0.1, cog: 90, navStatus: 15,
    });
    const [, patch] = app.vesselDataService.updateVessel.mock.calls[0];
    expect(patch.navStatus).toBeNull();
    expect(patch.lat).toBe(58.29);
    expect(patch.lon).toBe(12.29);
  });
});
