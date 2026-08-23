'use strict';

jest.mock('homey');

/**
 * =============================================================================
 * S11 (systerställesrundan 2026-08-23) — ÖPPNINGSDEDUPENS NYCKEL BAR LEDARENS
 * RIKTNING FÖR SAMTLIGA MEDLEMMAR
 * =============================================================================
 *
 * MEKANISMEN FÖRE FIXEN. Den persistenta nyckeln är bro|mmsi|riktning, och
 * riktningsledet togs ur `payload.direction` — LEDANDE båtens token, dvs.
 * båten närmast bron (BridgeOpeningService `_leadOf`). I en MÖTANDE konvoj
 * (eventDirection 'mixed') fick därför minst en medlem en nyckel som motsäger
 * hennes egen låsta ruttriktning. Riktningsledet finns just för att en
 * U-svängares RETURPASSAGE ska kunna varnas — pekar det åt fel håll slår
 * felet åt båda hållen:
 *   (a) MISSAD DEDUP: efter en omstart är närmaste båt en annan, ledarens
 *       token byter håll, och SAMMA öppning ger ett andra kort.
 *   (b) FALSK DEDUP: medlemmens äkta returresa åt andra hållet tystas av en
 *       nyckel hon aldrig borde ha fått.
 * Frekvens i facit: 6 mixed-poster av 286 avfyrningar (2,1 %).
 *
 * FIXEN ÄR ADDITIV OCH TVÅDELAD. BridgeOpeningService lägger `memberDirections`
 * (mmsi → 'northbound'/'southbound'/null) i payloaden, byggd ur EXAKT samma
 * källa som `_eventDirection` (den låsta ruttriktningen). app.js slår upp
 * medlemmens egen riktning och FALLER TILLBAKA på ledarens när uppgift saknas
 * — nyckeln blir då bevisligen identisk med dagens, vilket är det som gör
 * uppgraderingen från en äldre version ofarlig för enkelriktade poster.
 *
 * PRODUKTIONSVÄGEN: riktig app.onInit mot settings-mock, NODE_ENV='production'
 * och __TEST_MODE__ av, så testgrinden i _onBridgeOpeningWarning kringgås och
 * skrivloopen körs — exakt som replayRunner och k13b/j15b gör.
 *
 * MUTATIONSPROV (körda i isolerat träd, se rapporten):
 *  M1 = HEAD (openKey läser warnDir för alla)  ⇒ nyckel-, missad- och
 *       falsk-dedup-testerna röda
 *  M2 = fallbacken borttagen (null ⇒ 'unknown') ⇒ "medlem utan låst riktning"
 *       rött
 *  M3 = _memberDirections läser cog i stället för ruttlåset ⇒ "samma källa som
 *       eventDirection" rött
 */

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');

const MIN = 60 * 1000;
const LEDARE = '211495920'; // TONGA, söderut — närmast bron
const MEDLEM = '304028000'; // BALTIC JONGLEUR, norrut

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
  app.log = jest.fn();
  app.error = jest.fn();
  return app;
};

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

/** Fältets blandriktade händelse: Stridsbergsbron#2 2026-08-19 09:12:03. */
const mixadPayload = (overrides = {}) => ({
  t: Date.now(),
  eventId: 'Stridsbergsbron#2',
  bridge: 'Stridsbergsbron',
  direction: 'southbound', // LEDARENS token (TONGA)
  eventDirection: 'mixed',
  memberDirections: { [LEDARE]: 'southbound', [MEDLEM]: 'northbound' },
  etaMinutes: 6,
  vesselCount: 2,
  leadVessel: 'TONGA',
  leadMmsi: LEDARE,
  firedBy: 'fix',
  mmsis: [LEDARE, MEDLEM],
  distanceM: 1165,
  ...overrides,
});

let app = null;
let nowMs = 0;

beforeEach(() => {
  nowMs = 1787000000000;
  jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
});

afterEach(async () => {
  if (app) await app.onUninit();
  app = null;
  Date.now.mockRestore();
  delete global.__TEST_MODE__;
});

const avfyra = async (instans, payload) => {
  instans._bridgeOpeningTrigger.clearTriggerCalls();
  await withRealFlowGate(async () => {
    instans._onBridgeOpeningWarning(payload);
    await Promise.resolve();
  });
  return instans._bridgeOpeningTrigger.getTriggerCalls();
};

describe('S11: nyckeln bär medlemmens EGEN riktning', () => {
  test('NYCKELBEVISET: mixed-payload ger EN nyckel per riktning, inte två söderut', async () => {
    app = await bootApp();
    await avfyra(app, mixadPayload());

    const nycklar = [...app._persistentOpeningWarnings.keys()].sort();
    expect(nycklar).toEqual([
      `Stridsbergsbron|${MEDLEM}|northbound`,
      `Stridsbergsbron|${LEDARE}|southbound`,
    ].sort());
    // Regressionen: medlemmen får ALDRIG ledarens riktning.
    expect(nycklar).not.toContain(`Stridsbergsbron|${MEDLEM}|southbound`);
  });

  test('NYCKELN FÖRBLIR INTERN (ARCHITECTURE §9 — den lever i settings)', async () => {
    app = await bootApp();
    await avfyra(app, mixadPayload({ eventId: 'Stridsbergsbron#5' }));

    for (const key of app._persistentOpeningWarnings.keys()) {
      expect(key).not.toMatch(/norrut|söderut|okänd|båda/);
    }
  });

  test('FALLBACK: payload UTAN memberDirections ger EXAKT dagens nycklar', async () => {
    app = await bootApp();
    const utan = mixadPayload({ eventId: 'Stridsbergsbron#6' });
    delete utan.memberDirections;
    await avfyra(app, utan);

    const nycklar = [...app._persistentOpeningWarnings.keys()].sort();
    expect(nycklar).toEqual([
      `Stridsbergsbron|${LEDARE}|southbound`,
      `Stridsbergsbron|${MEDLEM}|southbound`,
    ].sort());
  });

  test('MEDLEM UTAN LÅST RIKTNING (null) faller tillbaka på ledarens token', async () => {
    app = await bootApp();
    await avfyra(app, mixadPayload({
      eventId: 'Stridsbergsbron#7',
      memberDirections: { [LEDARE]: 'southbound', [MEDLEM]: null },
    }));

    expect([...app._persistentOpeningWarnings.keys()])
      .toContain(`Stridsbergsbron|${MEDLEM}|southbound`);
  });

  test('UPPSLAGET GÅR ALDRIG VIA PROTOTYPKEDJAN', async () => {
    app = await bootApp();
    // En mmsi som råkar heta 'constructor' hade med ett rått uppslag gett
    // funktionen Object som riktningsled (samma fotgevär som F5-vakten i
    // directionTokens stänger).
    //
    // MÄTT: två spärrar i serie stänger detta — hasOwnProperty-uppslaget OCH
    // den strikta värdekontrollen (`own === 'northbound' || own ===
    // 'southbound'`). Mutationsprovet visar att den SENARE ensam räcker: byts
    // hasOwnProperty mot ett rått uppslag blir utfallet identiskt, eftersom
    // funktionen Object inte är någon av de två strängarna. Mutanten är alltså
    // EKVIVALENT och redovisas som sådan — hasOwnProperty står kvar som
    // försvar på djupet ifall värdekontrollen någon gång luckras upp.
    await avfyra(app, mixadPayload({
      eventId: 'Stridsbergsbron#8',
      mmsis: ['constructor'],
      leadMmsi: 'constructor',
      memberDirections: {},
    }));

    expect([...app._persistentOpeningWarnings.keys()])
      .toEqual(['Stridsbergsbron|constructor|southbound']);
  });
});

describe('S11: de två fältskadorna', () => {
  test('(a) MISSAD DEDUP: ledarbyte efter omstart ger INTE ett andra kort', async () => {
    app = await bootApp();
    await avfyra(app, mixadPayload());
    await app.onUninit();
    app = null;

    // Homey uppdaterar appen 2 min senare. Nu är MEDLEM närmast bron, så
    // ledarens token är 'northbound' — men medlemsuppgifterna är desamma.
    nowMs += 2 * MIN;
    app = await bootApp({ behållSettings: true });
    const kort = await avfyra(app, mixadPayload({
      eventId: 'Stridsbergsbron#3',
      direction: 'northbound',
      leadVessel: 'BALTIC JONGLEUR',
      leadMmsi: MEDLEM,
      mmsis: [MEDLEM, LEDARE],
    }));

    expect(kort).toHaveLength(0);
  });

  test('(b) FALSK DEDUP: medlemmens EGNA returresa åt andra hållet varnas', async () => {
    app = await bootApp();
    await avfyra(app, mixadPayload());

    // 5 min senare gör MEDLEM sin returresa SÖDERUT, ensam — en äkta ny
    // öppning. Med ledarnyckeln bar hon redan 'southbound' och tystades.
    nowMs += 5 * MIN;
    const kort = await avfyra(app, mixadPayload({
      eventId: 'Stridsbergsbron#4',
      direction: 'southbound',
      eventDirection: 'southbound',
      memberDirections: { [MEDLEM]: 'southbound' },
      vesselCount: 1,
      leadVessel: 'BALTIC JONGLEUR',
      leadMmsi: MEDLEM,
      mmsis: [MEDLEM],
    }));

    expect(kort).toHaveLength(1);
  });

  test('KONTROLLARM: enkelriktad konvoj dedupas som förut över omstart', async () => {
    app = await bootApp();
    const enkel = mixadPayload({
      eventId: 'Klaffbron#1',
      bridge: 'Klaffbron',
      eventDirection: 'southbound',
      memberDirections: { [LEDARE]: 'southbound', [MEDLEM]: 'southbound' },
    });
    await avfyra(app, enkel);
    await app.onUninit();
    app = null;

    nowMs += 2 * MIN;
    app = await bootApp({ behållSettings: true });
    const kort = await avfyra(app, { ...enkel, eventId: 'Klaffbron#2' });

    expect(kort).toHaveLength(0);
  });
});
