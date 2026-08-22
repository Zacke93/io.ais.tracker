'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');

/**
 * H34 (helkodsgranskning 2026-08-22): en COG utanför 0–360 fällde HELA
 * positionsrapporten i _validateAISMessage — fartyget blev OSYNLIGT i
 * bridge_text och i notiserna trots fullt giltig position.
 *
 * Det är samma felmod som A2-2 tog för SOG-sentinelen 102.3 och som
 * 0,0-garden finns för: appen ska kasta det KORRUPTA FÄLTET, aldrig
 * positionen. Klassen är inte hypotetisk — rå AIS-COG kodas i tiondels
 * grader (0–3599) och råvärden 3601–4095 avkodas till 360,1–409,5°, alltså
 * strax utanför intervallet, från en trasig eller ofullständigt normaliserad
 * källa. Tolkningen är den konservativa: null = "kurs okänd", ett kontrakt
 * hela riktningskedjan redan bär via 360-sentinelen.
 *
 * Fältlist-fällan berörs inte: inga nya vessel-fält införs — cog fanns redan
 * och bär redan null som "okänd".
 */

function makeApp() {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  app.debug = jest.fn();
  app._replayCaptureFile = null;
  app.vesselDataService = { updateVessel: jest.fn() };
  return app;
}

const POSITION = { mmsi: '265001111', lat: 58.29, lon: 12.29 };

describe('H34: korrupt COG nollas — positionen överlever', () => {
  test.each([
    ['720 (fuzzvärde)', 720],
    ['-10 (fuzzvärde)', -10],
    ['361 (råvärde 3610)', 361],
    ['409.5 (råvärde 4095 — den odiskuterade restklassen)', 409.5],
  ])('cog %s ⇒ båten syns, kursen blir null', (_label, cog) => {
    const app = makeApp();
    app._processAISMessage({ ...POSITION, sog: 5.0, cog });

    expect(app.vesselDataService.updateVessel).toHaveBeenCalledTimes(1);
    const [mmsi, patch] = app.vesselDataService.updateVessel.mock.calls[0];
    expect(mmsi).toBe('265001111');
    expect(patch.cog).toBeNull();
    expect(patch.lat).toBe(58.29);
    expect(patch.lon).toBe(12.29);
    expect(patch.sog).toBe(5.0); // farten är oskyldig — bara kursen kastas
  });

  test('icke-numerisk cog behandlas likadant (NaN, sträng, Infinity)', () => {
    for (const cog of [NaN, 'nordost', Infinity]) {
      const app = makeApp();
      app._processAISMessage({ ...POSITION, sog: 5.0, cog });
      expect(app.vesselDataService.updateVessel).toHaveBeenCalledTimes(1);
      const [, patch] = app.vesselDataService.updateVessel.mock.calls[0];
      expect(patch.cog).toBeNull();
      expect(patch.lat).toBe(58.29);
    }
  });

  test('SENTINELEN OFÖRÄNDRAD: cog 360 ⇒ null (aldrig 0 — ingen fabricerad nordkurs)', () => {
    const app = makeApp();
    app._processAISMessage({ ...POSITION, sog: 5.0, cog: 360 });
    const [, patch] = app.vesselDataService.updateVessel.mock.calls[0];
    expect(patch.cog).toBeNull();
  });

  test('NEGATIV KONTROLL: giltig kurs passerar orörd, och 0 är en riktig nordkurs', () => {
    for (const cog of [0, 25, 359.9]) {
      const app = makeApp();
      app._processAISMessage({ ...POSITION, sog: 5.0, cog });
      const [, patch] = app.vesselDataService.updateVessel.mock.calls[0];
      expect(patch.cog).toBe(cog);
    }
  });

  test('POSITIONSGARDERNA STÅR KVAR: korrupt cog räddar inte ett ogiltigt läge', () => {
    const app = makeApp();
    app._processAISMessage({
      mmsi: '265001111', lat: 91, lon: 12.29, cog: 720,
    });
    app._processAISMessage({
      mmsi: '265001111', lat: 0, lon: 0, cog: 720,
    });
    expect(app.vesselDataService.updateVessel).not.toHaveBeenCalled();
  });

  test('_validateAISMessage muterar meddelandet i stället för att fälla det', () => {
    const app = makeApp();
    const message = { ...POSITION, cog: 4095 / 10 };
    expect(app._validateAISMessage(message)).toBe(true);
    expect(message.cog).toBeNull();
    expect(message.lat).toBe(58.29);
  });
});
