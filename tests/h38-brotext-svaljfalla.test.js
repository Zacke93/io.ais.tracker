'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

/**
 * H38 (helkodsgranskning runda 1, 2026-08-22) — SVÄLJ-FÄLLAN i
 * generateBridgeText.
 *
 * Catchen gör ett internt fel till det aktivt FALSKA "Inga båtar": EN båt med
 * ett kastande fält raderar hela gruppen ur texten, count-validatorn kan
 * aldrig fyra (DEFAULT bär noll räkneord) och de tre DEFAULT-vakterna täcker
 * inte fallet. Utfallet behålls medvetet (facitneutralt — app.js äger
 * hold-logiken en nivå upp), men felet ska SYNAS: utan en logg som pekar ut
 * fartyget och orsaken är en fältlogg med "Inga båtar" oskiljbar från en
 * ärligt tom kanal.
 */

const makeLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });

const frisk = (mmsi, etaMinutes) => ({
  mmsi, targetBridge: 'Klaffbron', etaMinutes, passedBridges: [], status: 'en-route',
});

/** Båt vars fältläsning kastar mitt i frasbygget (H38:s utlösare). */
function kastandeBat(mmsi) {
  return {
    mmsi,
    targetBridge: 'Klaffbron',
    etaMinutes: 4,
    get passedBridges() {
      throw new TypeError('fältet exploderade');
    },
  };
}

describe('H38: svalt textfel loggas i stället för att bara bli "Inga båtar"', () => {
  let logger;
  let service;

  beforeEach(() => {
    logger = makeLogger();
    service = new BridgeTextService(null, logger);
  });

  test('EN kastande båt raderar tre friska ur texten — och det LOGGAS', () => {
    const vessels = [
      frisk('265001111', 12), frisk('265002222', 9), frisk('265003333', 6),
      kastandeBat('265009999'),
    ];

    const text = service.generateBridgeText(vessels);

    // Utfallet är OFÖRÄNDRAT (facitneutralt) …
    expect(text).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    // … men fällan syns nu i loggen, med fartygen och orsaken.
    expect(logger.error).toHaveBeenCalledTimes(1);
    const rad = logger.error.mock.calls[0].join(' ');
    expect(rad).toContain('BRIDGE_TEXT_SWALLOWED');
    expect(rad).toContain('265009999'); // den kastande båten
    expect(rad).toContain('265001111'); // …och de friska som raderades
    expect(rad).toContain('4 st'); // antalet i indatan
    expect(rad).toContain('fältet exploderade'); // orsaken
    expect(rad).toContain('TypeError');
    expect(rad).toContain('stack=');
  });

  test('loggningen kastar aldrig — inte ens när mmsi SJÄLV kastar', () => {
    const bomb = {
      targetBridge: 'Klaffbron',
      get mmsi() {
        throw new Error('mmsi-getter kastade');
      },
    };
    // Filtret läser mmsi först: hela anropet ska ändå returnera DEFAULT utan
    // att kasta, och loggraden ska skrivas trots det oläsbara fältet.
    let text;
    expect(() => {
      text = service.generateBridgeText([frisk('265001111', 5), bomb]);
    }).not.toThrow();
    expect(text).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0].join(' ')).toContain('?(kastande mmsi)');
  });

  test('ÄRLIGT tom kanal loggar INGENTING (raden får inte bli brus)', () => {
    expect(service.generateBridgeText([])).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(service.generateBridgeText(null)).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    // Båtar utan målbro är inte heller ett fel.
    expect(service.generateBridgeText([{ mmsi: '265001111', targetBridge: null }]))
      .toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('friska båtar renderas oförändrat (ingen regression i normalvägen)', () => {
    const text = service.generateBridgeText([frisk('265001111', 12), frisk('265002222', 9)]);
    expect(text).toContain('Två båtar på väg mot Klaffbron');
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('en logger som SJÄLV kastar fäller inte brotexten', () => {
    const trasig = {
      log: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(() => {
        throw new Error('loggern dog');
      }),
    };
    const s = new BridgeTextService(null, trasig);
    let text;
    expect(() => {
      text = s.generateBridgeText([frisk('265001111', 5), kastandeBat('265009999')]);
    }).not.toThrow();
    expect(text).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(trasig.error).toHaveBeenCalledTimes(1);
  });

  test('utan logger kastar tjänsten inte (Homey-loggern kan saknas i riggar)', () => {
    const utanLogger = new BridgeTextService(null, null);
    expect(() => utanLogger.generateBridgeText([kastandeBat('265009999')])).not.toThrow();
    expect(utanLogger.generateBridgeText([kastandeBat('265009999')]))
      .toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
  });
});
