'use strict';

jest.mock('homey');

const fs = require('fs');
const path = require('path');
const AISBridgeApp = require('../app');
const { TRIGGER_POINTS } = require('../lib/constants');

/**
 * =============================================================================
 * PAKET P8 / U10 — RETRO-NOTISERNAS TEXT (ANVÄNDARBESLUT 2026-08-09)
 * =============================================================================
 *
 * PROBLEMET. En boat_near-notis kan vara RETROAKTIV: båten upptäcks först
 * EFTER att hon passerat bron ('passage-fallback', upp till 2 294 m förbi i
 * korpus #18) eller inom 15 s efter en live-passage ('just-passed'). Fram
 * till nu bar de exakt samma tokens som en förvarning, så en Homey-flow som
 * skriver "X närmar sig Y" påstod något direkt osant.
 *
 * BESLUTET var att BEHÅLLA notiserna — C13/U7 mätte över 18 korpusar att
 * varje bortfiltrering byter notis mot täckningsmiss 1:1 — och i stället
 * ändra TEXTEN till passerad-form.
 *
 * KARTLÄGGNINGEN (P8) visade att kortet aldrig ägt någon text: appen
 * levererade fem tokens och MENINGEN skrevs av användaren. Fixen är därför
 * additiv — `message` (färdig svensk mening) + `already_passed` (boolean för
 * flows som vill grena) — medan de fem gamla tokens är byte-identiska.
 *
 * DE TRE KRAVEN som låses här:
 *   1. retro-notis  ⇒ passerad-text
 *   2. vanlig notis ⇒ OFÖRÄNDRADE tokens (facitbärarna bridge_name/direction
 *      framför allt) + förvarningstext
 *   3. dedup-nycklarna (session + persistent) IDENTISKA — notisantalet och
 *      dedupens beteende får inte flytta sig en millimeter.
 */

const CANDIDATE = (source, overrides = {}) => ({
  name: 'Klaffbron',
  id: 'klaffbron',
  distance: 250,
  source,
  ...overrides,
});

const makeApp = () => {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app._triggeredBoatNearKeys = new Set();
  app._persistentRecentTriggers = new Map();
  app._persistRecentTriggers = jest.fn();
  app._getDirectionString = jest.fn(() => 'northbound');
  app._dedupDirection = jest.fn(() => 'north');
  app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
  return app;
};

const fire = async (app, vessel, candidate) => {
  await app._triggerBoatNearFlowForBridge(vessel, candidate);
  const call = app._triggerBoatNearFlowBest.mock.calls[0];
  return { tokens: call && call[0], state: call && call[1] };
};

// =============================================================================
// 1. RETRO-NOTIS ⇒ PASSERAD-TEXT
// =============================================================================
describe('P8: retroaktiv källa ger passerad-form', () => {
  test("'passage-fallback' ⇒ 'passerade <bro> under AIS-tystnad'", async () => {
    const app = makeApp();
    const { tokens } = await fire(
      app,
      {
        mmsi: '265123456', name: 'SEEBAER III', sog: 4, etaMinutes: null,
      },
      CANDIDATE('passage-fallback', { distance: 1800 }),
    );

    expect(tokens.message).toBe('SEEBAER III passerade Klaffbron under AIS-tystnad');
    expect(tokens.already_passed).toBe(true);
  });

  test("'just-passed' ⇒ 'har precis passerat' (INTE AIS-tystnad — appen såg passagen)", async () => {
    const app = makeApp();
    const { tokens } = await fire(
      app,
      {
        mmsi: '265123457', name: 'HERA', sog: 6, etaMinutes: null,
      },
      CANDIDATE('just-passed', { distance: 120 }),
    );

    // Kandidaten läggs bara till inom PASSAGE_TRIGGER_GRACE_MS (15 s) och
    // inom notisradien — att påstå AIS-tystnad där vore osant.
    expect(tokens.message).toBe('HERA har precis passerat Klaffbron');
    expect(tokens.message).not.toMatch(/tystnad/);
    expect(tokens.already_passed).toBe(true);
  });

  test('retro-notisen påstår ALDRIG att båten närmar sig', async () => {
    const app = makeApp();
    for (const source of ['passage-fallback', 'just-passed']) {
      const fresh = makeApp();
      // eslint-disable-next-line no-await-in-loop
      const { tokens } = await fire(
        fresh,
        {
          mmsi: '265999000', name: 'DIANA', sog: 5, etaMinutes: 7,
        },
        CANDIDATE(source),
      );
      expect(tokens.message).not.toMatch(/närmar sig/);
      expect(tokens.message).toMatch(/passer/);
    }
    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
  });

  test('okänt namn ⇒ samma svenska fallback som vessel_name ("Okänd båt")', async () => {
    const app = makeApp();
    app._lookupVesselName = jest.fn(() => null);
    const { tokens } = await fire(
      app,
      {
        mmsi: '265123458', name: 'Unknown', sog: 3, etaMinutes: null,
      },
      CANDIDATE('passage-fallback'),
    );

    expect(tokens.vessel_name).toBe('Okänd båt');
    expect(tokens.message).toBe('Okänd båt passerade Klaffbron under AIS-tystnad');
  });
});

// =============================================================================
// 2. VANLIG NOTIS ⇒ OFÖRÄNDRAD
// =============================================================================
describe('P8: icke-retroaktiv notis är oförändrad', () => {
  // 900 m @ 5 kn ⇒ rå restid 5,8 min, så FP9:s ETA-tak (rå restid + 3 min)
  // inte binder och lagrad ETA 6 min når tokenen orörd. Taket är i övrigt
  // aktivt och testas av FP9-sviten — här ska texten spegla SLUTVÄRDET.
  const FAR_TARGET = CANDIDATE('target', { distance: 900 });

  test("'target' med känd ETA ⇒ förvarningstext + already_passed=false", async () => {
    const app = makeApp();
    const { tokens } = await fire(
      app,
      {
        mmsi: '265111111', name: 'MARLIN', sog: 5, etaMinutes: 6,
      },
      FAR_TARGET,
    );

    expect(tokens.already_passed).toBe(false);
    expect(tokens.message).toBe('MARLIN närmar sig Klaffbron, beräknad ankomst om 6 minuter');
  });

  test('texten speglar det ETA-tak som faktiskt gick ut i tokenen', async () => {
    // FP9-taket kapar 6 min till rå restid (250 m @ 5 kn ⇒ 1,6 min → 2).
    // Texten får ALDRIG bära ett annat tal än eta_minutes.
    const app = makeApp();
    const { tokens } = await fire(
      app,
      {
        mmsi: '265111115', name: 'MARLIN', sog: 5, etaMinutes: 6,
      },
      CANDIDATE('target'),
    );

    expect(tokens.eta_minutes).toBe(2);
    expect(tokens.message).toBe('MARLIN närmar sig Klaffbron, beräknad ankomst om 2 minuter');
  });

  test('de FEM gamla tokens är byte-identiska (facitbärarna först)', async () => {
    const app = makeApp();
    const { tokens } = await fire(
      app,
      {
        mmsi: '265111112', name: 'ALICE', sog: 5, etaMinutes: 6,
      },
      FAR_TARGET,
    );

    // bridge_name och direction läses av korpusarnas fördelnings- respektive
    // riktningsmultiset (runAllCorpora.js) — minsta värdeändring hade fällt
    // 17 låsta korpusar.
    expect(tokens.bridge_name).toBe('Klaffbron');
    expect(tokens.direction).toBe('northbound');
    expect(tokens.vessel_name).toBe('ALICE');
    expect(tokens.eta_minutes).toBe(6);
    expect(tokens.eta_available).toBe(true);
  });

  test('okänd ETA ⇒ ingen ETA-sats (-1-sentinelen blir aldrig text)', async () => {
    const app = makeApp();
    const { tokens } = await fire(
      app,
      {
        mmsi: '265111113', name: 'LYS', sog: 0, etaMinutes: null,
      },
      CANDIDATE('target'),
    );

    expect(tokens.eta_minutes).toBe(-1);
    expect(tokens.message).toBe('LYS närmar sig Klaffbron');
    expect(tokens.message).not.toMatch(/-1/);
  });

  test('mellanbro-källa ("current") behåller förvarningsform', async () => {
    const app = makeApp();
    const { tokens } = await fire(
      app,
      {
        mmsi: '265111114', name: 'JOSEPHINE', sog: 5, etaMinutes: 40,
      },
      CANDIDATE('current', { name: 'Järnvägsbron', id: 'jarnvagsbron', distance: 80 }),
    );

    expect(tokens.already_passed).toBe(false);
    expect(tokens.message).toMatch(/^JOSEPHINE närmar sig Järnvägsbron/);
  });
});

// =============================================================================
// 3. TEXTBYGGAREN — RANDFALL (direkt mot metoden, utan trigger-vägen)
// =============================================================================
describe('P8: _buildBoatNearMessage randfall', () => {
  const app = makeApp();
  const t = (eta) => ({ vessel_name: 'X', bridge_name: 'Stallbackabron', eta_minutes: eta });

  test('eta 1 ⇒ singular "minut"', () => {
    expect(app._buildBoatNearMessage(t(1), 'target'))
      .toBe('X närmar sig Stallbackabron, beräknad ankomst om 1 minut');
  });

  test('eta 2 ⇒ plural "minuter"', () => {
    expect(app._buildBoatNearMessage(t(2), 'target'))
      .toBe('X närmar sig Stallbackabron, beräknad ankomst om 2 minuter');
  });

  test('eta 0 (nåbart: 0 < eta < 0,5 avrundas till 0) ⇒ "strax", aldrig "om 0 minuter"', () => {
    const msg = app._buildBoatNearMessage(t(0), 'target');
    expect(msg).toBe('X närmar sig Stallbackabron, beräknad ankomst strax');
    expect(msg).not.toMatch(/0 minuter/);
  });

  test('eta -1 ⇒ ingen ETA-sats', () => {
    expect(app._buildBoatNearMessage(t(-1), 'target')).toBe('X närmar sig Stallbackabron');
  });

  test('texten säger ALDRIG "broöppning" (Stallbackabron öppnar aldrig, '
    + 'Kanalinfarten är ingen bro)', () => {
    for (const source of ['target', 'current', 'nearest', 'just-passed', 'passage-fallback', 'exit-fallback']) {
      expect(app._buildBoatNearMessage(t(5), source)).not.toMatch(/broöppning/);
    }
  });
});

// =============================================================================
// 4. DEDUP-NYCKLARNA ÄR IDENTISKA
// =============================================================================
describe('P8: dedup-nycklar och notisantal oförändrade', () => {
  test('sessionsnyckeln är fortfarande "mmsi:bronamn" — inte källa/text', async () => {
    const app = makeApp();
    await fire(
      app,
      {
        mmsi: '265222222', name: 'NORFJELL', sog: 4, etaMinutes: null,
      },
      CANDIDATE('passage-fallback'),
    );

    expect([...app._triggeredBoatNearKeys]).toEqual(['265222222:Klaffbron']);
    expect([...app._persistentRecentTriggers.keys()]).toEqual(['265222222:Klaffbron']);
  });

  test('retro och förvarning delar nyckel ⇒ ANDRA notisen dedupas bort (EN notis)', async () => {
    const app = makeApp();
    const vessel = {
      mmsi: '265333333', name: 'PIANO', sog: 4, etaMinutes: 5,
    };

    await app._triggerBoatNearFlowForBridge(vessel, CANDIDATE('target'));
    await app._triggerBoatNearFlowForBridge(vessel, CANDIDATE('passage-fallback'));

    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
    expect(app._triggerBoatNearFlowBest.mock.calls[0][0].already_passed).toBe(false);
    expect([...app._triggeredBoatNearKeys]).toEqual(['265333333:Klaffbron']);
  });

  test('persistent-posten bär oförändrad form {t, dir}', async () => {
    const app = makeApp();
    await fire(
      app,
      {
        mmsi: '265444444', name: 'IDUN', sog: 4, etaMinutes: null,
      },
      CANDIDATE('just-passed'),
    );

    const entry = app._persistentRecentTriggers.get('265444444:Klaffbron');
    expect(Object.keys(entry).sort()).toEqual(['dir', 't']);
    expect(entry.dir).toBe('north');
    expect(Number.isFinite(entry.t)).toBe(true);
  });

  test('state (run-listenerns matchning) är oförändrad — bara bro/mmsi/distans/källa', async () => {
    const app = makeApp();
    const { state } = await fire(
      app,
      {
        mmsi: '265555555', name: 'HERALD', sog: 4, etaMinutes: null,
      },
      CANDIDATE('passage-fallback', { distance: 1800 }),
    );

    expect(Object.keys(state).sort()).toEqual(['bridge', 'distance', 'mmsi', 'source']);
    expect(state.bridge).toBe('klaffbron');
    expect(state.source).toBe('passage-fallback');
  });
});

// =============================================================================
// 5. SSOT-PREDIKATET
// =============================================================================
describe('P8: _isRetroactiveNotificationSource är ETT ställe', () => {
  const app = makeApp();

  test('exakt de retroaktiva källorna klassas som passerade', () => {
    expect(app._isRetroactiveNotificationSource('passage-fallback')).toBe(true);
    expect(app._isRetroactiveNotificationSource('just-passed')).toBe(true);
    // F6 (2026-08-10): exit-fallbacken är retroaktiv för DEDUP/ETA/token —
    // notisen avfyras vid removal, aldrig som förvarning. Bara TEXTEN skiljer.
    expect(app._isRetroactiveNotificationSource('exit-fallback')).toBe(true);
    for (const s of ['target', 'current', 'nearest', 'trigger-point', undefined, null, '']) {
      expect(app._isRetroactiveNotificationSource(s)).toBe(false);
    }
  });

  test('inget kopierat predikat finns kvar i app.js', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');
    const copies = src.match(/source === 'passage-fallback' \|\| source === 'just-passed'/g) || [];
    // Endast SSOT-metodens egen kropp får innehålla uttrycket.
    expect(copies.length).toBe(1);
  });
});

// =============================================================================
// 6. FLOW-KONTRAKTET
// =============================================================================
describe('P8: kortet deklarerar de nya tokens (sv + en)', () => {
  const compose = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../.homeycompose/flow/triggers/boat_near.json'), 'utf8',
  ));

  test('message och already_passed finns med rätt typ', () => {
    // Object.fromEntries är utanför projektets Node-golv (>=8) — reduce i stället.
    const byName = compose.tokens.reduce((m, t) => Object.assign(m, { [t.name]: t }), {});
    expect(byName.message.type).toBe('string');
    expect(byName.already_passed.type).toBe('boolean');
    expect(byName.message.title.sv).toBeTruthy();
    expect(byName.message.title.en).toBeTruthy();
    expect(byName.already_passed.title.sv).toBeTruthy();
    expect(byName.already_passed.title.en).toBeTruthy();
  });

  test('de fem gamla tokens ligger kvar med oförändrade namn OCH ordning', () => {
    expect(compose.tokens.slice(0, 5).map((t) => t.name)).toEqual([
      'bridge_name', 'vessel_name', 'direction', 'eta_minutes', 'eta_available',
    ]);
  });
});

// =============================================================================
// 7. F6 (2026-08-10) — EXIT-FALLBACKEN LJUGER INTE OM EN PASSAGE
// =============================================================================
/**
 * FYNDET (adversariell granskning 2026-08-10). Exit-fallbacken vid
 * Kanalinfarten ärvde källsträngen 'passage-fallback' och fick därmed P8:s
 * mening "<namn> passerade Kanalinfarten under AIS-tystnad". Men exit-vägen
 * avfyrar med båtens SISTA KÄNDA POSITION NORR om punkten (gaten
 * `vessel.lat < kanalinfarten.lat` returnerar annars), Kanalinfarten bokförs
 * aldrig i passedBridges/passedAt, och ingen position söder om punkten har
 * observerats. Passagen är alltså inte inferrerad ur ett positionsbevis (som
 * i passage-fallbacken) utan helt oobserverad — och för Olidebrons kajklass
 * (~520 m norr om punkten, F5-B-bandet) direkt osann.
 *
 * FIXEN är intern: egen källsträng 'exit-fallback' + egen mening. Allt annat
 * — dedup-nycklar, notisantal, de sju tokens UTOM `message` — är
 * byte-identiskt, vilket testerna nedan låser explicit.
 */
describe('F6: exit-fallbacken har egen källa och egen mening', () => {
  const tp = TRIGGER_POINTS.kanalinfarten;

  // Samma IN-AXXI-snapshot som F5-B-sviten (faltprov-5-20260710.test.js):
  // ~546 m norr om punkten, 6,5 kn sydgående, Olidebron passerad.
  const exitSnapshot = (overrides = {}) => ({
    mmsi: '244130745',
    name: 'IN-AXXI',
    lat: 58.27213,
    lon: 12.2744,
    sog: 6.5,
    cog: 214,
    passedBridges: ['Klaffbron', 'Olidebron'],
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    _moored: false,
    _hasMovementProof: true,
    _finalTargetDirection: 'south',
    ...overrides,
  });

  const makeExitApp = () => {
    const app = makeApp();
    // _triggerBoatNearFlowFallback körs på RIKTIGT här — vi vill se hela
    // kedjan exit → fallback → flow-kortet, inte bara anropsargumenten.
    app._boatNearTrigger = { trigger: jest.fn().mockResolvedValue(undefined) };
    return app;
  };

  test('hela kedjan: exit-notisen påstår INTE en passage', async () => {
    const app = makeExitApp();
    await app._triggerExitPointFallback(exitSnapshot());

    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
    const [tokens, state] = app._triggerBoatNearFlowBest.mock.calls[0];

    expect(tokens.message)
      .toBe('IN-AXXI var på väg ut ur kanalen vid Kanalinfarten när AIS-kontakten bröts');
    // Det osanna påståendet får inte återuppstå i någon form.
    expect(tokens.message).not.toMatch(/passerade/);
    expect(tokens.message).not.toMatch(/närmar sig/);
    expect(state.source).toBe('exit-fallback');
  });

  test('övriga tokens är BYTE-IDENTISKA med den ärvda källan (bara texten skiljer)', async () => {
    const app = makeExitApp();
    await app._triggerExitPointFallback(exitSnapshot());
    const [tokens] = app._triggerBoatNearFlowBest.mock.calls[0];

    expect(tokens.bridge_name).toBe('Kanalinfarten'); // facitbärare
    expect(tokens.direction).toBe('northbound'); // mockad — värdet är oförändrat
    expect(tokens.vessel_name).toBe('IN-AXXI');
    expect(tokens.eta_minutes).toBe(-1); // retroaktiv källa ⇒ ingen ETA (E-F3/N9)
    expect(tokens.eta_available).toBe(false);
    // Tokenens funktion är "detta är ingen förvarning" — oförändrad.
    expect(tokens.already_passed).toBe(true);
  });

  test('dedup-nycklarna är oförändrade (mmsi:Kanalinfarten, form {t,dir})', async () => {
    const app = makeExitApp();
    await app._triggerExitPointFallback(exitSnapshot());

    expect([...app._triggeredBoatNearKeys]).toEqual(['244130745:Kanalinfarten']);
    const entry = app._persistentRecentTriggers.get('244130745:Kanalinfarten');
    expect(Object.keys(entry).sort()).toEqual(['dir', 't']);
  });

  test('EN notis per exit — andra anropet dedupas bort precis som förut', async () => {
    const app = makeExitApp();
    await app._triggerExitPointFallback(exitSnapshot());
    await app._triggerExitPointFallback(exitSnapshot());

    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });

  test('basradien (≤400 m) får samma mening — hela exit-vägen, inte bara F5-B', async () => {
    const app = makeExitApp();
    // ~330 m norr om punkten
    await app._triggerExitPointFallback(exitSnapshot({
      lat: tp.lat + 0.003, lon: tp.lon, sog: 1.2,
    }));

    const [tokens] = app._triggerBoatNearFlowBest.mock.calls[0];
    expect(tokens.message).toMatch(/^IN-AXXI var på väg ut ur kanalen vid Kanalinfarten/);
  });

  test('ÖVRIGA fallback-anropare är orörda — passage-fallback behåller text och källa', async () => {
    const app = makeExitApp();
    const vessel = {
      mmsi: '265777777',
      name: 'DIANA',
      lat: 58.28,
      lon: 12.29,
      sog: 5,
      timestamp: Date.now(),
      lastPositionUpdate: Date.now(),
    };

    // Samma anrop som passagesvepet gör (ingen options.source).
    await app._triggerBoatNearFlowFallback(vessel, 'Klaffbron');

    const [tokens, state] = app._triggerBoatNearFlowBest.mock.calls[0];
    expect(state.source).toBe('passage-fallback');
    expect(tokens.message).toBe('DIANA passerade Klaffbron under AIS-tystnad');
  });

  test('flow-självtestet bygger sin mening med produktionens byggare (ingen literal)', async () => {
    // F6-fyndets andra halva: självtestet hårdkodade P8-meningen och gick
    // därför grönt mot en sträng produktionen inte längre producerar om
    // _buildBoatNearMessage formuleras om. Testet nedan är BETEENDEBASERAT:
    // ändras byggaren ändras självtestets token i samma andetag.
    const app = makeApp();
    const trigger = jest.fn().mockResolvedValue(undefined);
    app._boatNearTrigger = { trigger };
    app.homey = { flow: { getConditionCard: jest.fn(() => null) } };

    await app._testTriggerFunctionality();

    expect(trigger).toHaveBeenCalledTimes(1);
    const [tokens] = trigger.mock.calls[0];
    expect(tokens.message).toBe(app._buildBoatNearMessage(tokens, 'target'));
    // Och meningen är den produktionen faktiskt bygger för dessa tokens.
    expect(tokens.message).toBe('TEST_VESSEL närmar sig Klaffbron, beräknad ankomst om 5 minuter');
  });

  test('textbyggaren direkt: exit-formen är sin egen, inte passage-formens', () => {
    const app = makeApp();
    const tokens = { vessel_name: 'MOSHE', bridge_name: 'Kanalinfarten', eta_minutes: -1 };

    expect(app._buildBoatNearMessage(tokens, 'exit-fallback'))
      .toBe('MOSHE var på väg ut ur kanalen vid Kanalinfarten när AIS-kontakten bröts');
    expect(app._buildBoatNearMessage(tokens, 'exit-fallback'))
      .not.toBe(app._buildBoatNearMessage(tokens, 'passage-fallback'));
  });
});
