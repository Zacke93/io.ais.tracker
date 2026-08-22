'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { TRIGGER_POINTS } = require('../lib/constants');

/**
 * =============================================================================
 * J29 (helkodsgranskning runda 2, 2026-08-22)
 * =============================================================================
 * EXPIRED-SLÄPPET RADERADE SESSIONSNYCKELN UTAN P2R2-4-SKYDDET.
 *
 * Flip-grenen (oppositeDirection) frågar _persistentDedupCheck INNAN
 * sessionsnyckeln raderas — just för att en förlorad nyckel med kvarvarande
 * post öppnar PILOT-fantomen igen (P2R2-4, R2 2026-07-11). Expired-grenen
 * (ingen färsk post + expiredRelease) raderade nyckeln OVILLKORLIGT och lät
 * först DÄREFTER F34-blocket fråga. Blockerade F34 då via 6h-gaten
 * (PERSISTENT_DEDUP_SAME_DIR_LATE) försvann sessionsnyckeln medan POSTEN levde
 * kvar — och med nyckeln försvann även #44-skyddet alreadyPassedThisJourney
 * för alla senare försök. Efter 6h-retentionen fanns INGEN av de två spärrarna
 * kvar.
 *
 * Sviten låser BÅDA riktningarna: att nyckeln behålls när gaten blockerar, OCH
 * att släppet fortfarande SLÄPPER när den inte gör det (kostnadssidan — runda
 * 1:s läxa var att h29/h30-sviten bara mätte nyttan).
 */

const MIN = 60 * 1000;
const H = 60 * MIN;
const MMSI = '265900018';
const NYCKEL = `${MMSI}:Klaffbron`;

function makeFlowApp() {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app._triggeredBoatNearKeys = new Set();
  app._persistentRecentTriggers = new Map();
  app._persistRecentTriggers = jest.fn();
  app._getDirectionString = jest.fn(() => 'southbound');
  app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
  return app;
}

/**
 * SÖDERGÅENDE I RÖRELSE — uppfyller expired-släppets alla krav:
 * curDir != null (riktig _dedupDirection ur cog 200 @ 4 kn), movingNow (≥2 kn),
 * ingen pending reversal och bron INTE i passedBridges.
 */
const slappkandidat = (overrides = {}) => ({
  mmsi: MMSI,
  name: 'SLÄPPKANDIDATEN',
  sog: 4,
  cog: 200,
  lat: 58.2820,
  lon: 12.2830,
  passedBridges: [],
  etaMinutes: null,
  ...overrides,
});

const KANDIDAT = (source) => ({
  name: 'Klaffbron', id: 'klaffbron', distance: 250, source,
});

const rows = (app, tag) => app.log.mock.calls
  .map((c) => String(c[0]))
  .filter((l) => l.includes(tag));

describe('J29: expired-släppet kör persistentgaten FÖRE raderingen', () => {
  test('FELFALLET: retroaktiv källa + 3h gammal post i samma riktning ⇒ nyckeln BEHÅLLS', async () => {
    const app = makeFlowApp();
    app._triggeredBoatNearKeys.add(NYCKEL);
    // Posten är bortom 2h-fönstret (⇒ persisted=null ⇒ expiredRelease) men
    // innanför 6h-retentionen, samma riktning ⇒ F34 blockerar nedströms.
    app._persistentRecentTriggers.set(NYCKEL, { t: Date.now() - 3 * H, dir: 'south' });

    await app._triggerBoatNearFlowForBridge(slappkandidat(), KANDIDAT('passage-fallback'));

    // Ingen notis (oförändrat), MEN nyckeln lever — den bär #44-skyddet.
    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
    expect(app._triggeredBoatNearKeys.has(NYCKEL)).toBe(true);
    const blockRader = rows(app, 'FLOW_TRIGGER_DEDUPE');
    expect(blockRader.some((l) => l.includes('expired release') && l.includes('keeping session key'))).toBe(true);
    // Släppraden får INTE ha skrivits — nyckeln raderades aldrig.
    expect(rows(app, 'FLOW_TRIGGER_DEDUPE_DIRECTION')).toHaveLength(0);
  });

  test('FÖLJDSKYDDET LEVER: nästa försök når #44-gaten i stället för att notifiera', async () => {
    const app = makeFlowApp();
    app._triggeredBoatNearKeys.add(NYCKEL);
    app._persistentRecentTriggers.set(NYCKEL, { t: Date.now() - 3 * H, dir: 'south' });

    await app._triggerBoatNearFlowForBridge(slappkandidat(), KANDIDAT('passage-fallback'));

    // Posten prunas av 6h-retentionen (monitoring-cleanupen) — FÖRE fixen var
    // både post och nyckel borta här, och båten kunde få en notis utan att
    // "bron redan passerad denna resa" någonsin utvärderades.
    app._persistentRecentTriggers.clear();
    await app._triggerBoatNearFlowForBridge(
      slappkandidat({ passedBridges: ['Klaffbron'] }),
      KANDIDAT('passage-fallback'),
    );

    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
    expect(rows(app, 'FLOW_TRIGGER_DEDUPE_EXPIRED_HOLD')
      .some((l) => l.includes('bridge already passed this journey'))).toBe(true);
  });

  test('KOSTNADSSIDAN 1: utan post alls släpper expired-grenen som förut', async () => {
    const app = makeFlowApp();
    app._triggeredBoatNearKeys.add(NYCKEL);

    await app._triggerBoatNearFlowForBridge(slappkandidat(), KANDIDAT('passage-fallback'));

    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
    expect(rows(app, 'FLOW_TRIGGER_DEDUPE_DIRECTION')
      .some((l) => l.includes('no persistent entry (expired)'))).toBe(true);
  });

  test('KOSTNADSSIDAN 2: LIVE-källa (source=current) blockeras inte av 6h-gaten', async () => {
    // PERSISTENT_DEDUP_SAME_DIR_LATE gäller bara retroaktiva källor. En äkta
    // ny transit notifieras alltid via proximity — den vägen får fixen inte
    // röra.
    const app = makeFlowApp();
    app._triggeredBoatNearKeys.add(NYCKEL);
    app._persistentRecentTriggers.set(NYCKEL, { t: Date.now() - 3 * H, dir: 'south' });

    await app._triggerBoatNearFlowForBridge(slappkandidat(), KANDIDAT('current'));

    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
    expect(app._triggeredBoatNearKeys.has(NYCKEL)).toBe(true); // sätts om vid notis
  });

  test('KOSTNADSSIDAN 3: post äldre än 6h-retentionen släpper igenom retroaktivt', async () => {
    const app = makeFlowApp();
    app._triggeredBoatNearKeys.add(NYCKEL);
    app._persistentRecentTriggers.set(NYCKEL, { t: Date.now() - 7 * H, dir: 'south' });

    await app._triggerBoatNearFlowForBridge(slappkandidat(), KANDIDAT('passage-fallback'));

    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });

  test('KOSTNADSSIDAN 4: MOTSATT riktning i posten släpper retroaktivt (äkta returpassage)', async () => {
    const app = makeFlowApp();
    app._triggeredBoatNearKeys.add(NYCKEL);
    app._persistentRecentTriggers.set(NYCKEL, { t: Date.now() - 3 * H, dir: 'north' });

    await app._triggerBoatNearFlowForBridge(slappkandidat(), KANDIDAT('passage-fallback'));

    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });

  test('P2R2-4 STÅR KVAR: flip-grenen behåller nyckeln när gaten blockerar', async () => {
    // Regressionsvakt för den gren fixen flyttade koden UR. Posten är färsk
    // (30 min) med motsatt riktning ⇒ flip; retroaktiv källa + <60 min ⇒
    // PERSISTENT_DEDUP_RECENT blockerar.
    const app = makeFlowApp();
    app._triggeredBoatNearKeys.add(NYCKEL);
    app._persistentRecentTriggers.set(NYCKEL, { t: Date.now() - 30 * MIN, dir: 'north' });

    await app._triggerBoatNearFlowForBridge(slappkandidat(), KANDIDAT('just-passed'));

    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
    expect(app._triggeredBoatNearKeys.has(NYCKEL)).toBe(true);
    expect(rows(app, 'FLOW_TRIGGER_DEDUPE')
      .some((l) => l.includes('flip') && l.includes('keeping session key'))).toBe(true);
  });

  test('STILLALIGGAREN (F5-A) är orörd: inget rörelsebevis ⇒ EXPIRED_HOLD, ingen notis', async () => {
    const app = makeFlowApp();
    app._triggeredBoatNearKeys.add(NYCKEL);

    await app._triggerBoatNearFlowForBridge(
      slappkandidat({ sog: 0.2 }),
      KANDIDAT('passage-fallback'),
    );

    expect(app._triggerBoatNearFlowBest).not.toHaveBeenCalled();
    expect(rows(app, 'FLOW_TRIGGER_DEDUPE_EXPIRED_HOLD')
      .some((l) => l.includes('no movement evidence'))).toBe(true);
  });
});

/**
 * =============================================================================
 * J29:s SYSTERSTÄLLE — EXIT-VÄGEN (_triggerExitPointFallback)
 * =============================================================================
 * Runda 1:s läxa var att 7 av 12 fixar lämnade ett syskon orört. Svepet efter
 * mönstret "radera sessionsnyckeln och låt en persistentgrind nedströms svara"
 * gav EN träff till, i samma fil: exit-vägens dedupgren bar ordagrant samma
 * konstruktion (P2R2-4-spegeln inuti `if (oppositeDirection)`, ovillkorlig
 * radering därefter) och har sin egen persistentgrind nedanför
 * (EXIT_TRIGGER_PERSISTENT_DEDUPE, alltid retroactiveSource: true).
 * Konsekvensen var identisk: nyckeln borta, posten kvar.
 */
describe('J29-spegeln: exit-vägen behåller också nyckeln när gaten blockerar', () => {
  const KANAL = TRIGGER_POINTS.kanalinfarten;
  const EXIT_NYCKEL = '265900020:Kanalinfarten';

  function makeExitApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._triggerBoatNearFlowFallback = jest.fn().mockResolvedValue(undefined);
    return app;
  }

  // 330 m NORR om punkten (basradien), i rörelse söderut — uppfyller
  // expired-släppets alla krav.
  const utgaende = (overrides = {}) => ({
    mmsi: '265900020',
    name: 'UTGÅENDE',
    lat: KANAL.lat + 330 / 111320,
    lon: KANAL.lon,
    sog: 4,
    cog: 205,
    passedBridges: ['Olidebron'],
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    _lastSeen: Date.now(),
    _moored: false,
    _hasMovementProof: true,
    ...overrides,
  });

  test('FELFALLET: 3h gammal sydpost ⇒ ingen notis OCH nyckeln behålls', async () => {
    const app = makeExitApp();
    app._triggeredBoatNearKeys.add(EXIT_NYCKEL);
    app._persistentRecentTriggers.set(EXIT_NYCKEL, { t: Date.now() - 3 * H, dir: 'south' });

    await app._triggerExitPointFallback(utgaende());

    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
    expect(app._triggeredBoatNearKeys.has(EXIT_NYCKEL)).toBe(true);
    expect(app.debug.mock.calls
      .map((c) => String(c[0]))
      .some((l) => l.includes('EXIT_TRIGGER_DEDUPE') && l.includes('expired release') && l.includes('keeping session key')))
      .toBe(true);
  });

  test('KOSTNADSSIDAN: utan post släpper exit-vägens expired-gren som förut', async () => {
    const app = makeExitApp();
    app._triggeredBoatNearKeys.add(EXIT_NYCKEL);

    await app._triggerExitPointFallback(utgaende());

    expect(app._triggerBoatNearFlowFallback).toHaveBeenCalledTimes(1);
    expect(app.log.mock.calls
      .map((c) => String(c[0]))
      .some((l) => l.includes('EXIT_TRIGGER_DEDUPE_DIRECTION'))).toBe(true);
  });

  test('P2R2-4-SPEGELN STÅR KVAR: flip-grenen behåller nyckeln vid blockering', async () => {
    const app = makeExitApp();
    app._triggeredBoatNearKeys.add(EXIT_NYCKEL);
    app._persistentRecentTriggers.set(EXIT_NYCKEL, { t: Date.now() - 5 * MIN, dir: 'north' });

    await app._triggerExitPointFallback(utgaende());

    expect(app._triggerBoatNearFlowFallback).not.toHaveBeenCalled();
    expect(app._triggeredBoatNearKeys.has(EXIT_NYCKEL)).toBe(true);
  });
});
