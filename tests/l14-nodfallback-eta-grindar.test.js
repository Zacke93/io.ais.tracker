'use strict';

jest.mock('homey');

/**
 * L14 (helkodsgranskning RUNDA 3, 2026-08-22) — NÖDFALLBACKEN BYGGDE
 * ETA-KLAUSULEN UTAN TEXTMOTORNS EGNA GRINDAR.
 *
 * MEKANISMEN FÖRE FIXEN: BridgeTextService._buildGroupPhrase konsumerar
 * imminent-flaggan bakom TVÅ grindar — B6:s zombie-filter (målbron ligger redan
 * i passedBridges ⇒ varken flaggan eller nedräknings-ETA:n får driva klausulen)
 * och C11:s färskhetskrav (positionen får inte vara äldre än
 * STALE_ETA_HARD_THRESHOLD_MS). `_generateSafeFallbackText` byggde samma
 * klausul direkt ur fartyget utan någondera, trots att kontraktet i
 * lib/utils/etaValidation.js säger ordagrant att varje ny anropare som skickar
 * `imminent: true` MÅSTE bära samma grind.
 *
 * FELUTFALLET (reproducerat): ett fartyg 60 m norr om Klaffbron med Klaffbron
 * redan i passedBridges gav motorn "En båt på väg mot Klaffbron, ETA okänd"
 * medan fallbacken sade "En båt 60m från Klaffbron (nordgående), beräknad
 * broöppning strax". Zombie + imminent SAMMANFALLER vid varje målbropassage:
 * pending-target släpps först vid 300 m medan bron redan lagts i passedBridges,
 * och imminent sätts vid högst 300 m.
 *
 * FIXEN (minimal variant): fallbacken bär nu samma två predikat ordagrant.
 * Den delade hjälpare granskningen föreslår kräver ändring i BridgeTextService
 * (annat paketägarskap) och redovisas som förslag i stället.
 */

const AISBridgeApp = require('../app');
const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES, UI_CONSTANTS } = require('../lib/constants');

const KLAFF = Object.values(BRIDGES).find((b) => b.name === 'Klaffbron');
const STALE_HARD = UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

const riggApp = () => {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app.vesselDataService = { hasGpsJumpHold: () => false };
  app.bridgeRegistry = {
    bridges: { klaffbron: KLAFF },
    getBridgeByName: (n) => (n === 'Klaffbron' ? KLAFF : null),
  };
  // Variant1-omkallet ska INTE kunna svara här — testerna mäter den
  // beskrivande grenens ETA-klausul. Motorn ger DEFAULT ⇒ fall igenom.
  app.bridgeTextService = { generateBridgeText: () => 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron' };
  return app;
};

/** 60 m NORR om Klaffbron — exakt fältfallets geometri. */
const vesselNorthOfKlaff = (overrides = {}) => ({
  mmsi: '265788210',
  name: 'ZOMBIEN',
  targetBridge: 'Klaffbron',
  currentBridge: null,
  lat: KLAFF.lat + 60 / 111320,
  lon: KLAFF.lon,
  _routeDirection: 'north',
  etaMinutes: null,
  _isImminentAtTargetBridge: true,
  passedBridges: [],
  timestamp: Date.now(),
  lastPositionUpdate: Date.now(),
  ...overrides,
});

describe('L14 (a): zombie-grinden — målbron redan passerad', () => {
  test('FÄLTFALLET: målbron i passedBridges + imminent ⇒ INGEN "strax"-klausul', () => {
    const app = riggApp();
    const out = app._generateSafeFallbackText(
      [vesselNorthOfKlaff({ passedBridges: ['Klaffbron'] })],
      'trasig text',
    );
    expect(out).toContain('60m från Klaffbron');
    expect(out).not.toContain('broöppning strax');
    expect(out).not.toContain('broöppning');
  });

  test('zombie med FINIT nedräknings-ETA ⇒ siffran hör till den redan skedda passagen', () => {
    const app = riggApp();
    const out = app._generateSafeFallbackText([vesselNorthOfKlaff({
      passedBridges: ['Klaffbron'],
      etaMinutes: 2,
      _isImminentAtTargetBridge: false,
    })], null);
    expect(out).not.toContain('broöppning');
    expect(out).not.toContain('2 minuter');
  });

  test('SSOT-BEVIS: fallbacken är aldrig mer tvärsäker än textmotorn', () => {
    const app = riggApp();
    const zombie = vesselNorthOfKlaff({ passedBridges: ['Klaffbron'] });
    const motor = new BridgeTextService(new BridgeRegistry(), makeLogger());
    const motorText = motor.generateBridgeText([zombie]);
    const fallbackText = app._generateSafeFallbackText([zombie], null);

    // Motorn säger uttryckligen INTE "strax" för en zombie …
    expect(motorText).not.toContain('broöppning strax');
    // … och det får fallbacken inte heller göra.
    expect(fallbackText).not.toContain('broöppning strax');
  });

  test('KONTRAKTET BEVARAT: icke-zombie med imminent ger fortfarande "strax" (A3-3)', () => {
    const app = riggApp();
    const out = app._generateSafeFallbackText([vesselNorthOfKlaff()], null);
    expect(out).toContain('beräknad broöppning strax');
  });
});

describe('L14 (b): färskhetsgrinden — C11:s konsumtionsspärr', () => {
  test('position äldre än STALE_ETA_HARD ⇒ imminent konsumeras INTE', () => {
    const app = riggApp();
    const gammal = Date.now() - (STALE_HARD + 60 * 1000);
    const out = app._generateSafeFallbackText([vesselNorthOfKlaff({
      timestamp: gammal,
      lastPositionUpdate: gammal,
    })], null);
    expect(out).not.toContain('broöppning strax');
  });

  test('precis inom gränsen ⇒ klausulen står kvar (gränsen får inte glida)', () => {
    const app = riggApp();
    const nastanGammal = Date.now() - (STALE_HARD - 5 * 1000);
    const out = app._generateSafeFallbackText([vesselNorthOfKlaff({
      timestamp: nastanGammal,
      lastPositionUpdate: nastanGammal,
    })], null);
    expect(out).toContain('beräknad broöppning strax');
  });

  test('KLOCKDOMÄNEN: färsk lastPositionUpdate räddar en gammal timestamp (max av båda)', () => {
    const app = riggApp();
    const out = app._generateSafeFallbackText([vesselNorthOfKlaff({
      timestamp: Date.now() - (STALE_HARD + 60 * 1000),
      lastPositionUpdate: Date.now(),
    })], null);
    expect(out).toContain('beräknad broöppning strax');
  });

  test('FIXTURKONTRAKTET: helt utan tidsstämplar räknas positionen som färsk', () => {
    const app = riggApp();
    const utanTid = vesselNorthOfKlaff();
    delete utanTid.timestamp;
    delete utanTid.lastPositionUpdate;
    expect(app._generateSafeFallbackText([utanTid], null)).toContain('beräknad broöppning strax');
  });

  test('FINIT ETA hos en FÄRSK icke-zombie är oförändrad (grinden rör bara imminent)', () => {
    const app = riggApp();
    const out = app._generateSafeFallbackText([vesselNorthOfKlaff({
      etaMinutes: 7,
      _isImminentAtTargetBridge: false,
    })], null);
    expect(out).toContain('beräknad broöppning om 7 minuter');
  });

  test('GAMMAL position + finit ETA: siffran står kvar (C11 gatar imminent, inte lead-ETA)', () => {
    const app = riggApp();
    const gammal = Date.now() - (STALE_HARD + 60 * 1000);
    const out = app._generateSafeFallbackText([vesselNorthOfKlaff({
      etaMinutes: 7,
      _isImminentAtTargetBridge: false,
      timestamp: gammal,
      lastPositionUpdate: gammal,
    })], null);
    expect(out).toContain('beräknad broöppning om 7 minuter');
  });
});
