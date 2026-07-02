'use strict';

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');

const makeLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });

/**
 * Regressionstester för 11h-valideringskörningens fynd (2026-07-02):
 * - NO LIMIT-klassen: RC7-presentationsfiltret dolde STILLALIGGANDE båtar
 *   med gles mottagning → "Inga båtar"-flapp var 10:e minut.
 * - (MOSHE-klassen — målbrolös linjekorsningsdetektering — och kö-zonsvakten
 *   täcks av replay-nivån: korpus 20260702-11h, 41h-korpusens
 *   211112870@Stallbackabron samt scenarierna 'återfödd-utflygare-söderut',
 *   'ankrad-gles-sändare' och 'väntare-12min' + INV-14.)
 */
describe('RC7-undantag: stillaliggande båt med gles mottagning döljs inte', () => {
  function makeVDS() {
    const svc = Object.create(VesselDataService.prototype);
    svc.logger = makeLogger();
    svc.vessels = new Map();
    svc._logDebounce = new Map();
    svc._logRepeatCount = new Map();
    svc.bridgeRegistry = { isValidTargetBridge: (n) => ['Klaffbron', 'Stridsbergsbron'].includes(n) };
    svc._isVesselNearStallbackabron = () => false;
    svc._isVesselSuitableForBridgeText = () => true;
    return svc;
  }

  const baseVessel = (over) => ({
    mmsi: '211380900',
    name: 'NO LIMIT',
    lat: 58.2944,
    lon: 12.2966,
    targetBridge: 'Klaffbron',
    status: 'en-route',
    passedBridges: [],
    ...over,
  });

  test('stillaliggande (sog 0) med 15 min gammal data VISAS (upp till 25 min)', () => {
    const svc = makeVDS();
    const vessel = baseVessel({
      sog: 0,
      timestamp: Date.now() - 15 * 60 * 1000,
      lastPositionUpdate: Date.now() - 15 * 60 * 1000,
      // status måste vara relevant — sätts av statuslogiken i drift
      status: 'en-route',
    });
    svc.vessels.set(vessel.mmsi, vessel);

    const shown = svc.getVesselsForBridgeText();

    // Gamla RC7-filtret dolde henne vid 10 min → texten flappade
    // "på väg mot Klaffbron"↔"Inga båtar" för ankrade glesa sändare.
    expect(shown.map((v) => v.mmsi)).toContain('211380900');
  });

  test('långsam köare (sog 1.2, NO LIMIT-fallet) med 12 min gammal data VISAS', () => {
    const svc = makeVDS();
    const vessel = baseVessel({
      sog: 1.2,
      timestamp: Date.now() - 12 * 60 * 1000,
      lastPositionUpdate: Date.now() - 12 * 60 * 1000,
    });
    svc.vessels.set(vessel.mmsi, vessel);

    expect(svc.getVesselsForBridgeText().map((v) => v.mmsi)).toContain('211380900');
  });

  test('stillaliggande med >25 min gammal data döljs (removal-fönstret stänger)', () => {
    const svc = makeVDS();
    const vessel = baseVessel({
      sog: 0,
      timestamp: Date.now() - 27 * 60 * 1000,
      lastPositionUpdate: Date.now() - 27 * 60 * 1000,
    });
    svc.vessels.set(vessel.mmsi, vessel);

    expect(svc.getVesselsForBridgeText()).toHaveLength(0);
  });

  test('SABETH-klassen oförändrad: båt I RÖRELSE (sog 4.4) döljs vid >10 min', () => {
    const svc = makeVDS();
    const vessel = baseVessel({
      mmsi: '265571760',
      name: 'MARLIN',
      sog: 4.4,
      timestamp: Date.now() - 12 * 60 * 1000,
      lastPositionUpdate: Date.now() - 12 * 60 * 1000,
    });
    svc.vessels.set(vessel.mmsi, vessel);

    // En rörlig båts 12 min gamla position är en LÖGN (SABETH passerade
    // fyra broar efter att transpondern dog) — hide-designen består.
    expect(svc.getVesselsForBridgeText()).toHaveLength(0);
  });
});
