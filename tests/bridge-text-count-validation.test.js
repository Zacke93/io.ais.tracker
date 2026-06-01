'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

/**
 * F16 (KRITISK): _extractVesselCounts matchade tidigare bara ASCII-siffror
 * (/(\d+)\s*(båt|vessel)/), men Variant-1 skriver svenska ordtal ("Två/Tre
 * båtar"). Korrekt flerbåtstext underkändes som kritisk count-mismatch och
 * degraderades till fallback. Dessa tester låser den språkmedvetna räkningen.
 */
describe('F16: språkmedveten fartygsräkning i bridge_text-validering', () => {
  let app;

  beforeEach(() => {
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
  });

  test('_extractVesselCounts räknar svenska ordtal (1-10)', () => {
    expect(app._extractVesselCounts('En båt på väg mot Klaffbron, beräknad broöppning strax').totalMentioned).toBe(1);
    expect(app._extractVesselCounts('Tre båtar på väg mot Klaffbron, beräknad broöppning om 5 minuter').totalMentioned).toBe(3);
    expect(app._extractVesselCounts('Tio båtar på väg mot Stridsbergsbron, beräknad broöppning strax').totalMentioned).toBe(10);
  });

  test('_extractVesselCounts summerar flergruppstext', () => {
    const text = 'En båt på väg mot Klaffbron, beräknad broöppning strax; '
      + 'Tre båtar på väg mot Stridsbergsbron, beräknad broöppning om 6 minuter';
    expect(app._extractVesselCounts(text).totalMentioned).toBe(4);
  });

  test('_extractVesselCounts hanterar siffror >10', () => {
    expect(app._extractVesselCounts('11 båtar på väg mot Klaffbron, beräknad broöppning strax').totalMentioned).toBe(11);
  });

  test('ETA-siffror räknas INTE som båtar', () => {
    // "om 5 minuter" får inte tolkas som 5 båtar
    expect(app._extractVesselCounts('En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter').totalMentioned).toBe(1);
  });

  test('default-meddelandet ger 0 (ingen falsk räkning)', () => {
    expect(app._extractVesselCounts(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE).totalMentioned).toBe(0);
  });

  test('REGRESSION F16: korrekt flergruppstext underkänns INTE längre', () => {
    const text = 'En båt på väg mot Klaffbron, beräknad broöppning strax; '
      + 'Tre båtar på väg mot Stridsbergsbron, beräknad broöppning om 6 minuter';
    const vessels = [
      { mmsi: '1', targetBridge: 'Klaffbron' },
      { mmsi: '2', targetBridge: 'Stridsbergsbron' },
      { mmsi: '3', targetBridge: 'Stridsbergsbron' },
      { mmsi: '4', targetBridge: 'Stridsbergsbron' },
    ];
    const result = app._validateVesselCounts(text, vessels);
    expect(result.passed).toBe(true);
  });

  test('genuint missförhållande fångas fortfarande (1 nämnd, 4 faktiska)', () => {
    const text = 'En båt på väg mot Klaffbron, beräknad broöppning strax';
    const vessels = [{ mmsi: '1' }, { mmsi: '2' }, { mmsi: '3' }, { mmsi: '4' }];
    const result = app._validateVesselCounts(text, vessels);
    expect(result.passed).toBe(false);
    expect(result.severity).toBe('critical');
  });
});
