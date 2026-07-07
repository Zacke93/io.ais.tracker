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

  test('SABETH-klassen: målbro-riktad rörlig båt döljs vid >15 min (korpus #9-kalibrering)', () => {
    // Korpus #9 (2026-07-08): target-satta aktiva transiter får 15 min —
    // verklig Class B-täthet i kanalen är 6–13 min och 10-min-släppet gav
    // "Inga båtar"-flash mitt i transit (ELFKUNGEN 12:15 i 14h-fältprovet,
    // 07:51-fallet i 41h). SABETH-skyddet (död transponder → spökvisning)
    // består via 15-min-taket: hon döljs 5 min senare, men flappar inte.
    const svc = makeVDS();
    const vessel = baseVessel({
      mmsi: '265571760',
      name: 'MARLIN',
      sog: 4.4,
      timestamp: Date.now() - 12 * 60 * 1000,
      lastPositionUpdate: Date.now() - 12 * 60 * 1000,
    });
    svc.vessels.set(vessel.mmsi, vessel);
    // 12 min: inom target-fönstret → SYNLIG (gles Class B, ingen flapp).
    expect(svc.getVesselsForBridgeText()).toHaveLength(1);

    // 16 min: bortom fönstret → dold (spökskyddet består).
    vessel.timestamp = Date.now() - 16 * 60 * 1000;
    vessel.lastPositionUpdate = Date.now() - 16 * 60 * 1000;
    expect(svc.getVesselsForBridgeText()).toHaveLength(0);
  });
});

describe('Namnstickiness: känt namn ersätts aldrig av Unknown', () => {
  test('sample utan namn behåller tidigare känt namn', () => {
    const svc = Object.create(VesselDataService.prototype);
    svc.logger = makeLogger();
    svc.gpsJumpAnalyzer = {
      analyzeMovement: () => ({
        action: 'accept', isGPSJump: false, movementDistance: 5, analysis: {},
      }),
    };
    svc.systemCoordinator = { coordinatePositionUpdate: () => null };
    svc._updateSpeedHistory = () => [];
    svc._calculateMaxRecentSpeed = () => 0;

    const oldVessel = { name: 'MOSHE', lat: 58.28, lon: 12.28 };
    const vessel = svc._createVesselObject('211471090', {
      lat: 58.281, lon: 12.281, sog: 5, cog: 20, name: 'Unknown',
    }, oldVessel);

    // 11h-körningen: MOSHE:s första notis avfyrades som "Unknown" och
    // SOLUTION växlade Unknown↔SOLUTION — Class B skickar namnet bara i
    // vissa meddelanden. Ett känt namn ska klistra.
    expect(vessel.name).toBe('MOSHE');
  });

  test('nytt äkta namn uppdaterar (namnbyte tillåtet)', () => {
    const svc = Object.create(VesselDataService.prototype);
    svc.logger = makeLogger();
    svc.gpsJumpAnalyzer = {
      analyzeMovement: () => ({
        action: 'accept', isGPSJump: false, movementDistance: 5, analysis: {},
      }),
    };
    svc.systemCoordinator = { coordinatePositionUpdate: () => null };
    svc._updateSpeedHistory = () => [];
    svc._calculateMaxRecentSpeed = () => 0;

    const oldVessel = { name: 'Unknown', lat: 58.28, lon: 12.28 };
    const vessel = svc._createVesselObject('211471090', {
      lat: 58.281, lon: 12.281, sog: 5, cog: 20, name: 'MOSHE',
    }, oldVessel);

    expect(vessel.name).toBe('MOSHE');
  });
});

describe('Extrapolerad klausul i strax-bandet', () => {
  const { formatETABroOpeningClause } = require('../lib/utils/etaValidation');

  test('extrapolerat ETA <3 ger "om cirka 2 minuter", inte strax', () => {
    // MARLIN 09:22:27: extrapolerad nedräkning visade "strax" 730 m från
    // bron och korrigerades UPPÅT 67 s senare — strax reserveras för färsk
    // data/imminent/exhausted.
    expect(formatETABroOpeningClause(1.8, { extrapolated: true }))
      .toBe('beräknad broöppning om cirka 2 minuter');
  });

  test('färskt ETA <3 ger fortfarande strax', () => {
    expect(formatETABroOpeningClause(1.8)).toBe('beräknad broöppning strax');
  });

  test('exhausted-vägen (imminent-flaggan) behåller strax', () => {
    expect(formatETABroOpeningClause(null, { imminent: true, extrapolated: true }))
      .toBe('beräknad broöppning strax');
  });
});
