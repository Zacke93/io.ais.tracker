'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');

/**
 * Omgång 9 (spår R, dirigentens beslut): MMSI i appens gemensamma inflöde blir
 * en sträng med enbart siffror. Tal och sträng för samma båt ger samma nyckel,
 * blanksteg tas bort, och det som inte är rena siffror efter det avvisas
 * (liksom MMSI 0, som källorna redan avvisar). Ett kort men numeriskt MMSI
 * behålls. Förut blev `-1`, `1e9` och ett MMSI med blanksteg egna fartyg.
 */
describe('MMSI-normalisering i inflödet', () => {
  function makeApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._replayCaptureFile = null;
    app.vesselDataService = { updateVessel: jest.fn() };
    return app;
  }
  const base = {
    msgType: 'PositionReport', lat: 58.29, lon: 12.29, sog: 5, cog: 25, shipName: 'PROV',
  };
  const keyFor = (app, mmsi) => {
    app.vesselDataService.updateVessel.mockClear();
    app._processAISMessage({ ...base, mmsi });
    const call = app.vesselDataService.updateVessel.mock.calls[0];
    return call ? call[0] : null;
  };

  test('tal, sträng och sträng med blanksteg för samma båt ger samma nyckel', () => {
    const app = makeApp();
    expect(keyFor(app, 265099501)).toBe('265099501');
    expect(keyFor(app, '265099501')).toBe('265099501');
    expect(keyFor(app, ' 265099501 ')).toBe('265099501');
    expect(keyFor(app, '265 099 501')).toBe('265099501');
    expect(keyFor(app, '265099501\t')).toBe('265099501');
  });

  test('det som inte är rena siffror avvisas och når aldrig fartygstjänsten', () => {
    const app = makeApp();
    for (const bad of ['-1', -1, '1e9', '265099501a', '2650.99501', 265099501.5, '0', 0, '000000000', '', '   ', null, undefined, {}, [], NaN, Infinity]) {
      expect(keyFor(app, bad)).toBeNull();
    }
  });

  test('motfall: ett kort numeriskt MMSI och ett med ledande nolla behålls som de är', () => {
    const app = makeApp();
    expect(keyFor(app, '2650995')).toBe('2650995');
    expect(keyFor(app, 2650995)).toBe('2650995');
    expect(keyFor(app, '002650995')).toBe('002650995');
  });

  test('motfall: talet 1e9 är ett heltal och blir siffersträngen', () => {
    const app = makeApp();
    expect(keyFor(app, 1e9)).toBe('1000000000');
  });
});
