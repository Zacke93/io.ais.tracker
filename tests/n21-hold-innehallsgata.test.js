'use strict';

jest.mock('homey');

/**
 * N21 (helkodsgranskning RUNDA 5, 2026-08-23) — HÅLLNINGEN ÅTERSPELADE SENASTE
 * TEXTEN UTAN ATT PRÖVA ATT DEN RÖRDE DEN BÅT SOM MOTIVERADE HÅLLNINGEN.
 *
 * FÄLTBEVISET (logs/app-20260804-224222.log, verifierat rad för rad):
 * 2026-08-05T10:26:00.657Z genererade textmotorn "Inga båtar", PASSED_HOLD_UI
 * höll kvar "En båt på väg mot Stridsbergsbron, beräknad broöppning om 10
 * minuter" och släppte först 10:26:19.748 — 19,1 sekunder FEL BRO. Den enda
 * passagen i hela 150-sekundersfönstret var 219025537 vid KLAFFBRON
 * 10:23:43.765. Hållningen skyddade alltså en Klaffbro-öppning genom att visa
 * en text om Stridsbergsbron.
 *
 * MEKANISMEN: båda hållningsgrenarna (F29:s GPS-hold och C1c:s passed-hold)
 * plus nödfallbackens speglar satte bridgeText till _lastBridgeText enbart på
 * att NÅGON båt var hållen respektive låg i passed-fönstret. Ingen koppling
 * gjordes mellan den hållande båten och innehållet i texten.
 *
 * FIXEN: hållningen gatas på INNEHÅLL — passed-hold kräver att senaste texten
 * nämner lastPassedBridge för minst en båt i fönstret, GPS-hold att den nämner
 * targetBridge för minst en hållen båt. Faller villkoret går DEFAULT ut precis
 * som förut. Samma gata i nödfallbacken, så asymmetrin inte återuppstår.
 *
 * MÄTT (hela korpusbanken): samtliga 569 distinkta texter i golden-text/
 * nämner minst en målbro vid namn, och 50 av 51 hold-kluster i loggbanken
 * matchar redan — gatan rör alltså bara krockfallet.
 *
 * MUTATIONSPROV (körs manuellt): ta bort _holdTextConcernsBridge-villkoret ur
 * någon av de tre grenarna ⇒ motsvarande FÄLTFALLET-test blir rött.
 */

const AISBridgeApp = require('../app');
const { BRIDGE_TEXT_CONSTANTS, BRIDGES, PASSAGE_TIMING } = require('../lib/constants');

const DEFAULT = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
const KLAFF = Object.values(BRIDGES).find((b) => b && b.name === 'Klaffbron');
const STRIDS = Object.values(BRIDGES).find((b) => b && b.name === 'Stridsbergsbron');

// Texterna är ordagrant fältets (utom siffran, som saknar betydelse här).
const TEXT_STRIDS = 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 10 minuter';
const TEXT_KLAFF = 'En båt på väg mot Klaffbron, beräknad broöppning om 10 minuter';
const TEXT_BOTH = 'En båt på väg mot Klaffbron, beräknad broöppning om 4 minuter; '
  + 'en båt på väg mot Stridsbergsbron, beräknad broöppning om 12 minuter';

const riggApp = (heldMmsis = []) => {
  const held = new Set(heldMmsis.map(String));
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app._isConnected = true;
  app._lastConnectionLost = null;
  app._updateDeviceCapability = jest.fn();
  app._globalBridgeTextToken = null;
  app.vesselDataService = { hasGpsJumpHold: (mmsi) => held.has(String(mmsi)) };
  app.bridgeRegistry = {
    bridges: { klaffbron: KLAFF, stridsbergsbron: STRIDS },
    getBridgeByName: (n) => Object.values(BRIDGES).find((b) => b && b.name === n) || null,
  };
  app.bridgeTextService = { generateBridgeText: jest.fn(() => DEFAULT) };
  return app;
};

const makeSnapshot = (vessels) => ({
  vesselCount: vessels.length,
  relevantVessels: vessels,
  vesselsBeingRemoved: new Set(),
  timestamp: Date.now(),
});

/**
 * Båt som just passerat en målbro (targetBridge nollad av TARGET_END).
 * RIKTNINGEN ÄR OBLIGATORISK i fältfallen: DIONE (219025537) och TIM
 * (212571000) var båda SYDGÅENDE i korpus 20260804-both-21h ("Söderut, norr om
 * Stridsbergsbron → Stridsbergsbron först"), så Klaffbron var deras SISTA
 * målbro — en terminal passage utan nästa bro. Se _nextTargetBridgeAfterPassage.
 */
const passedVessel = (bridge, agoMs = 10 * 1000, over = {}) => ({
  mmsi: '219025537',
  targetBridge: null,
  lastPassedBridge: bridge,
  lastPassedBridgeTime: Date.now() - agoMs,
  _routeDirection: 'south',
  passedBridges: ['Stridsbergsbron', bridge],
  ...over,
});

/** Aktiv båt med målbro som är kortvarigt GPS-hållen. */
const heldVessel = (mmsi, bridge) => ({
  mmsi,
  targetBridge: bridge,
  lat: KLAFF.lat + 400 / 111320,
  lon: KLAFF.lon,
  etaMinutes: 4,
});

const publishedTexts = (app) => app._updateDeviceCapability.mock.calls
  .filter((c) => c[0] === 'bridge_text')
  .map((c) => String(c[1]));

describe('N21 (a): innehållsgatan som predikat', () => {
  test('_holdTextConcernsBridge kräver att bron NÄMNS', () => {
    const app = riggApp();
    expect(app._holdTextConcernsBridge(TEXT_STRIDS, ['Klaffbron'])).toBe(false);
    expect(app._holdTextConcernsBridge(TEXT_KLAFF, ['Klaffbron'])).toBe(true);
    expect(app._holdTextConcernsBridge(TEXT_BOTH, ['Klaffbron'])).toBe(true);
    expect(app._holdTextConcernsBridge(TEXT_BOTH, ['Stridsbergsbron'])).toBe(true);
    // Tomma/ogiltiga indata ⇒ ingen hållning (DEFAULT som förut).
    expect(app._holdTextConcernsBridge(TEXT_KLAFF, [])).toBe(false);
    expect(app._holdTextConcernsBridge(null, ['Klaffbron'])).toBe(false);
    expect(app._holdTextConcernsBridge('', ['Klaffbron'])).toBe(false);
  });

  test('uppräknarna svarar med BRONAMN, omslagarna med boolean (oförändrat API)', () => {
    const app = riggApp(['265111000']);
    const vessels = [passedVessel('Klaffbron'), heldVessel('265111000', 'Stridsbergsbron')];
    // Sydgående som passerat Klaffbron = TERMINAL passage ⇒ ingen nästa målbro.
    expect(app._recentTargetPassageBridges(vessels)).toEqual(['Klaffbron']);
    expect(app._gpsHeldTargetBridges(vessels)).toEqual(['Stridsbergsbron']);
    expect(app._hasRecentTargetPassage(vessels)).toBe(true);
    expect(app._hasGpsHeldTargetVessel(vessels)).toBe(true);
    expect(app._recentTargetPassageBridges(null)).toEqual([]);
    expect(app._gpsHeldTargetBridges(null)).toEqual([]);
  });

  test('_nextTargetBridgeAfterPassage härleds ur geografin, inte ur listordning', () => {
    const app = riggApp();
    const v = (bridge, passed) => ({ lastPassedBridge: bridge, passedBridges: passed });
    expect(app._nextTargetBridgeAfterPassage(v('Klaffbron', ['Olidebron', 'Klaffbron'])))
      .toBe('Stridsbergsbron');
    expect(app._nextTargetBridgeAfterPassage(v('Stridsbergsbron', ['Stallbackabron', 'Stridsbergsbron'])))
      .toBe('Klaffbron');
    // Terminala passager: ingen målbro ligger framför i färdriktningen.
    expect(app._nextTargetBridgeAfterPassage(v('Klaffbron', ['Järnvägsbron', 'Klaffbron']))).toBeNull();
    expect(app._nextTargetBridgeAfterPassage(v('Stridsbergsbron', ['Järnvägsbron', 'Stridsbergsbron'])))
      .toBeNull();
    // Redan passerad bro räknas inte som "nästa".
    expect(app._nextTargetBridgeAfterPassage(
      v('Klaffbron', ['Stridsbergsbron', 'Olidebron', 'Klaffbron']),
    )).toBeNull();
    // Utan positionsbevis och för mellanbroar ⇒ null (anroparen fail-openar).
    expect(app._nextTargetBridgeAfterPassage(v('Klaffbron', []))).toBeNull();
    expect(app._nextTargetBridgeAfterPassage(v('Olidebron', ['Klaffbron', 'Olidebron']))).toBeNull();
  });

  test('_passageDirectionFromHistory läser BARA positionsbevis (aldrig låset)', () => {
    const app = riggApp();
    // Låset säger "söderut" men de passerade broarna säger norrut — historiken
    // vinner (teleport-läxan).
    expect(app._passageDirectionFromHistory({
      passedBridges: ['Olidebron', 'Klaffbron'], _routeDirection: 'south',
    })).toBe('north');
    expect(app._passageDirectionFromHistory({
      passedBridges: ['Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron', 'Klaffbron'],
    })).toBe('south');
    // U-sväng: det SENASTE benet gäller, inte resans början.
    expect(app._passageDirectionFromHistory({
      passedBridges: ['Olidebron', 'Klaffbron', 'Olidebron'],
    })).toBe('south');
    // Utan två passager finns inget bevis — låset får INTE rädda svaret.
    expect(app._passageDirectionFromHistory({
      passedBridges: ['Klaffbron'], _routeDirection: 'north',
    })).toBeNull();
    expect(app._passageDirectionFromHistory({ passedBridges: [], _routeDirection: 'south' })).toBeNull();
    expect(app._passageDirectionFromHistory(null)).toBeNull();
  });
});

describe('N21 (b): passed-hold i _processUIUpdate', () => {
  test('FÄLTFALLET 10:26:00 — Klaffbro-passage, Stridsbergstext ⇒ DEFAULT', async () => {
    const app = riggApp();
    app._lastBridgeText = TEXT_STRIDS;

    await app._processUIUpdate(makeSnapshot([passedVessel('Klaffbron')]));

    expect(publishedTexts(app)).toContain(DEFAULT);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('PASSED_HOLD_UI_SKIP'));
  });

  test('KONTROLLEN: samma passage med RÄTT bro i texten ⇒ hållningen består', async () => {
    const app = riggApp();
    app._lastBridgeText = TEXT_KLAFF;

    await app._processUIUpdate(makeSnapshot([passedVessel('Klaffbron')]));

    expect(publishedTexts(app)).not.toContain(DEFAULT);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('PASSED_HOLD_UI'));
  });

  test('FLERBROSTEXT: en text som nämner båda broarna rör också den passerade', async () => {
    const app = riggApp();
    app._lastBridgeText = TEXT_BOTH;

    await app._processUIUpdate(makeSnapshot([
      passedVessel('Stridsbergsbron', 10 * 1000, { passedBridges: ['Stridsbergsbron'] }),
    ]));

    expect(publishedTexts(app)).not.toContain(DEFAULT);
  });

  test('NÄSTA MÅLBRO RÄKNAS: nordgående som passerat Klaffbron får hålla Stridsbergstext', async () => {
    // Syntetiska scenariot "teleport-över-Klaffbron": texten handlar om SAMMA
    // båt (hennes nästa målbro) och är sann — att avslå hållningen gav en
    // falsk "Inga båtar" i 60 s (INV-14 DEFAULT-FLASH).
    const app = riggApp();
    app._lastBridgeText = TEXT_STRIDS;

    await app._processUIUpdate(makeSnapshot([
      passedVessel('Klaffbron', 10 * 1000, { passedBridges: ['Olidebron', 'Klaffbron'] }),
    ]));

    expect(publishedTexts(app)).not.toContain(DEFAULT);
  });

  test('TELEPORT-LÄXAN: utan positionsbevis fail-openar gatan (låset får inte döma)', async () => {
    // Syntetiska scenariot "teleport-över-Klaffbron": låset säger "söderut" i
    // exakt den tick hållningen prövas (appens egen loggrad), medan hon har
    // passerat Olidebron→Klaffbron, dvs. bevisligen norrut. Läses låset blir
    // passagen "terminal" ⇒ hållningen avslås ⇒ falsk "Inga båtar" i 60 s.
    const app = riggApp();
    app._lastBridgeText = TEXT_STRIDS;

    await app._processUIUpdate(makeSnapshot([
      passedVessel('Klaffbron', 10 * 1000, {
        _routeDirection: 'south', // låset vänt av outliern
        _finalTargetDirection: null,
        // MÄTT I SCENARIOT: den falska linjekorsningen utlöser en resereset,
        // så passagelistan är TÖMD — enda överlevande fältet är
        // lastPassedBridge. Utan positionsbevis fail-openar gatan.
        passedBridges: [],
      }),
    ]));

    expect(publishedTexts(app)).not.toContain(DEFAULT);
  });

  test('OKÄND RIKTNING ⇒ FAIL-OPEN (dagens beteende, ingen ny DEFAULT-flash)', async () => {
    const app = riggApp();
    app._lastBridgeText = TEXT_STRIDS;

    await app._processUIUpdate(makeSnapshot([
      passedVessel('Klaffbron', 10 * 1000, { _routeDirection: null, passedBridges: [] }),
    ]));

    expect(publishedTexts(app)).not.toContain(DEFAULT);
  });

  test('FÖNSTRET GÄLLER FORTFARANDE: utanför PASSED_HOLD_MS ⇒ DEFAULT', async () => {
    const app = riggApp();
    app._lastBridgeText = TEXT_KLAFF;

    await app._processUIUpdate(makeSnapshot([
      passedVessel('Klaffbron', PASSAGE_TIMING.PASSED_HOLD_MS + 1000),
    ]));

    expect(publishedTexts(app)).toContain(DEFAULT);
  });
});

describe('N21 (c): GPS-hold i _processUIUpdate', () => {
  test('FÄLTFORMEN: hållen båt mot Klaffbron, text om Stridsbergsbron ⇒ DEFAULT', async () => {
    const app = riggApp(['265111000']);
    app._lastBridgeText = TEXT_STRIDS;

    await app._processUIUpdate(makeSnapshot([heldVessel('265111000', 'Klaffbron')]));

    expect(publishedTexts(app)).toContain(DEFAULT);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('GPS_HOLD_UI_SKIP'));
  });

  test('KONTROLLEN: hållen båt mot Klaffbron, text om Klaffbron ⇒ hållningen består', async () => {
    const app = riggApp(['265111000']);
    app._lastBridgeText = TEXT_KLAFF;

    await app._processUIUpdate(makeSnapshot([heldVessel('265111000', 'Klaffbron')]));

    expect(publishedTexts(app)).not.toContain(DEFAULT);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('GPS_HOLD_UI'));
  });
});

describe('N21 (d): nödfallbacken speglar gatan', () => {
  test('FÄLTFALLET i fallbacken: fel bro i texten ⇒ DEFAULT, inte hållning', () => {
    const app = riggApp();
    app._lastBridgeText = TEXT_STRIDS;

    const out = app._generateSafeFallbackText([passedVessel('Klaffbron')], null);

    expect(out).toBe(DEFAULT);
    expect(app.debug).not.toHaveBeenCalledWith(expect.stringContaining('FALLBACK_PASSED_HOLD'));
  });

  test('KONTROLLEN i fallbacken: rätt bro ⇒ senaste texten behålls', () => {
    const app = riggApp();
    app._lastBridgeText = TEXT_KLAFF;

    const out = app._generateSafeFallbackText([passedVessel('Klaffbron')], null);

    expect(out).toBe(TEXT_KLAFF);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('FALLBACK_PASSED_HOLD'));
  });

  test('GPS-grenen prövas även när passed-fönstrets text rör fel bro', () => {
    const app = riggApp(['265111000']);
    app._lastBridgeText = TEXT_STRIDS;

    // Passed-fönstret gäller Klaffbron (text-krock), men en GPS-hållen båt är
    // på väg mot Stridsbergsbron — och DEN hållningen är sann.
    const out = app._generateSafeFallbackText([
      passedVessel('Klaffbron'),
      heldVessel('265111000', 'Stridsbergsbron'),
    ], null);

    expect(out).toBe(TEXT_STRIDS);
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('FALLBACK_GPS_HOLD'));
  });
});
