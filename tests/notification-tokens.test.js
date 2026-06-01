'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');

/**
 * Replay-validering 2026-06-01 mot historisk AIS-data avslöjade tre defekter i
 * boat_near-NOTIS-TOKENS (inte i texten användaren läser):
 *   Fix 1: ETA-token ärvde målbro-ETA för en mellanbro-notis (JOSEPHINE: 68 min
 *          medan båten var 80 m från Järnvägsbron).
 *   Fix 2: stillaliggande båt med brus-COG fick fel/'northbound' riktning.
 *   Fix 3: sydgående båt med SV-kurs (COG 226.7°) fick 'unknown'.
 * Fixarna: route-direction primärt + SOG-gate + breddat sydband; och token-ETA
 * mot den NOTIFIERADE brons avstånd för icke-target-kandidater.
 */
describe('Notis-token: riktning (_getDirectionString)', () => {
  let app;
  beforeEach(() => {
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
  });

  test('route-direction vinner över momentan COG (sydgående båt, brus-COG norrut)', () => {
    // JOSEPHINE-fall: ankrad vid mellanbro, sog≈0, AIS rapporterar nord-ish COG
    expect(app._getDirectionString({ _routeDirection: 'south', cog: 14, sog: 0 })).toBe('southbound');
    expect(app._getDirectionString({ _finalTargetDirection: 'north', cog: 200, sog: 5 })).toBe('northbound');
  });

  test('SV-kurs (COG 226.7°) på rörlig båt utan route → southbound (breddat band)', () => {
    expect(app._getDirectionString({ cog: 226.7, sog: 4.2 })).toBe('southbound');
    expect(app._getDirectionString({ cog: 270, sog: 5 })).toBe('southbound');
  });

  test('SOG-gate: stillaliggande båt utan route → unknown (COG är brus)', () => {
    expect(app._getDirectionString({ cog: 14, sog: 0 })).toBe('unknown');
    expect(app._getDirectionString({ cog: 200, sog: 0.3 })).toBe('unknown');
  });

  test('öst-kurs (90°) förblir unknown (ingen felklassning som syd)', () => {
    expect(app._getDirectionString({ cog: 90, sog: 5 })).toBe('unknown');
  });

  test('tydlig nord/syd med mätbar fart (ingen route) klassas korrekt', () => {
    expect(app._getDirectionString({ cog: 20, sog: 5 })).toBe('northbound');
    expect(app._getDirectionString({ cog: 180, sog: 5 })).toBe('southbound');
  });

  test('ogiltig COG utan route → unknown', () => {
    expect(app._getDirectionString({ cog: 400, sog: 5 })).toBe('unknown');
    expect(app._getDirectionString({ cog: null, sog: 5 })).toBe('unknown');
  });
});

describe('Notis-token: ETA mot den notifierade bron (_triggerBoatNearFlowForBridge)', () => {
  let app;
  let fired;
  beforeEach(() => {
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    fired = [];
    app._triggerBoatNearFlowBest = jest.fn((tokens) => {
      fired.push(tokens); return Promise.resolve();
    });
  });

  test('mellanbro-notis ärver INTE målbro-ETA (JOSEPHINE: 80m från Järnväg, mål 1km bort)', async () => {
    const vessel = {
      mmsi: '244870852',
      name: 'JOSEPHINE',
      sog: 0.2,
      cog: 210,
      _routeDirection: 'south',
      etaMinutes: 68, // ETA till MÅLbron Klaffbron (~1km bort, stillaliggande)
    };
    // Kandidat: Järnvägsbron (mellanbro), source 'just-passed', 80m bort
    await app._triggerBoatNearFlowForBridge(vessel, {
      name: 'Järnvägsbron', id: 'jarnvagsbron', distance: 80, source: 'just-passed',
    });
    expect(fired).toHaveLength(1);
    // ETA-token får INTE vara 68 (det orimliga ärvda målbro-värdet)
    expect(fired[0].eta_minutes).not.toBe(68);
    // Stillaliggande vid mellanbro → -1 (okänd), ärligare än 68
    expect(fired[0].eta_minutes).toBe(-1);
    expect(fired[0].direction).toBe('southbound'); // route-dir, ej brus-COG
  });

  test('målbro-notis BEHÅLLER vessel.etaMinutes (source=target)', async () => {
    const vessel = {
      mmsi: '111', name: 'X', sog: 4, cog: 200, _routeDirection: 'south', etaMinutes: 5,
    };
    await app._triggerBoatNearFlowForBridge(vessel, {
      name: 'Klaffbron', id: 'klaffbron', distance: 250, source: 'target',
    });
    expect(fired).toHaveLength(1);
    expect(fired[0].eta_minutes).toBe(5); // målbro-ETA korrekt bevarad
  });

  test('rörlig båt vid mellanbro → ETA beräknad mot den brons avstånd', async () => {
    const vessel = {
      mmsi: '222', name: 'Y', sog: 5, cog: 30, _routeDirection: 'north', etaMinutes: 40,
    };
    // 300m från Olidebron vid 5 knop (~2.57 m/s) ≈ 1.9 min, ej 40
    await app._triggerBoatNearFlowForBridge(vessel, {
      name: 'Olidebron', id: 'olidebron', distance: 300, source: 'current',
    });
    expect(fired).toHaveLength(1);
    expect(fired[0].eta_minutes).toBeLessThan(5);
    expect(fired[0].eta_minutes).toBeGreaterThanOrEqual(0);
  });
});
