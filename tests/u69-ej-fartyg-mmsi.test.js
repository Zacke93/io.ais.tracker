'use strict';

jest.mock('homey');

/**
 * U69 (dirigentens beslut, omgång 9): positioner från sändare som inte är
 * fartyg ignoreras helt. Fältprov 3 (k4 2026-11-25) visade ett räddningsflyg
 * (MMSI 111 + landskod) som "En båt på väg mot Stridsbergsbron, beräknad
 * broöppning strax" i fem minuter. Klasserna följer ITU-R M.585: 111
 * räddningsflyg, 970/972/974 nödsändare, 979 autonoma radioanordningar (AMRD
 * grupp B), 99 sjömärken, 00 kuststationer och övriga 0 (gruppanrop).
 * Positionen spelas in i replay-fångsten som rå indata och ignoreras därefter. 98 (farkost knuten till ett moderfartyg), 8
 * (handhållen VHF) och vanliga fartyg 2–7 släpps igenom. Felformade MMSI hör
 * till valideringen och klassas inte här.
 */

const AISBridgeApp = require('../app');
const { nonVesselMmsiClass } = require('../lib/utils/mmsiClass');

describe('U69: nonVesselMmsiClass', () => {
  test.each([
    ['111219001', 'räddningsflyg'],
    ['970219001', 'AIS-SART'],
    ['972219001', 'MOB'],
    ['974219001', 'EPIRB-AIS'],
    ['979219001', 'AMRD grupp B'],
    ['992191001', 'sjömärke'],
    ['002191000', 'kuststation'],
    ['021910001', 'gruppanrop'],
    [111219001, 'räddningsflyg'],
    [992191001, 'sjömärke'],
    // Landskodens gränser (201–775) för klasserna som bär den.
    ['111201001', 'räddningsflyg'], ['111775001', 'räddningsflyg'],
    ['992010001', 'sjömärke'], ['997750001', 'sjömärke'],
    ['992658001', 'sjömärke'], // mobilt sjömärke (99MID8…)
    ['002010000', 'kuststation'], ['007750000', 'kuststation'],
    ['020100001', 'gruppanrop'], ['077500001', 'gruppanrop'],
  ])('%p är %s', (mmsi, klass) => {
    expect(nonVesselMmsiClass(mmsi)).toBe(klass);
  });

  test.each([
    '982191001', // farkost knuten till ett moderfartyg
    '821910001', // handhållen VHF med DSC och GNSS
    '219000001', '265012345', '305000001', '412000001', '538000001', '636000001', '710000001',
    '112219001', // 11 men inte 111
    '971219001', '973219001', '975219001', '978219001', // grannar till nödsändarna och AMRD
    // Dummy-MMSI från felprogrammerade sändare: ingen giltig landskod, släpps som före U69.
    '111111111', '999999999', '000000000',
    // Landskod utanför 201–775 på sin plats.
    '111200001', '111776001', '992000001', '997760001', '002000000', '007760000', '020000001', '077600001',
  ])('%s släpps igenom', (mmsi) => {
    expect(nonVesselMmsiClass(mmsi)).toBeNull();
  });

  test.each([
    [null], [undefined], [''], ['0'], [0], ['11121900'], ['1112190011'], ['111a19001'],
    [2655000], // tal som tappat inledande nollor: formfel, inte en klass
    ['2655000'], ['02655000'], // korta siffersträngar fylls aldrig ut med nollor
    ['0026550000'], ['1112650011'], // längre än nio siffror
    [{}],
  ])('felformat %p klassas inte (valideringens sak)', (mmsi) => {
    expect(nonVesselMmsiClass(mmsi)).toBeNull();
  });

  test('blanksteg runt en sträng tolereras', () => {
    expect(nonVesselMmsiClass(' 111219001 ')).toBe('räddningsflyg');
  });
});

describe('U69: app._processAISMessage ignorerar sändare som inte är fartyg', () => {
  function makeApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._replayCaptureFile = null;
    app.vesselDataService = { updateVessel: jest.fn() };
    app._rememberVesselName = jest.fn();
    app._lookupVesselName = jest.fn(() => null);
    app._captureAISReplaySample = jest.fn();
    return app;
  }
  const pos = (mmsi, extra = {}) => ({
    mmsi, lat: 58.2975, lon: 12.2985, sog: 14, cog: 215, shipName: 'SYNT-U69', timestamp: Date.now(), ...extra,
  });

  test.each(['111219001', '970219001', '972219001', '974219001', '979219001', '992191001', '002191000', '021910001'])(
    '%s spelas in som rå indata men skapar inget fartyg och rör inte namncachen',
    (mmsi) => {
      const app = makeApp();
      app._processAISMessage(pos(mmsi));
      expect(app.vesselDataService.updateVessel).not.toHaveBeenCalled();
      expect(app._rememberVesselName).not.toHaveBeenCalled();
      expect(app._lookupVesselName).not.toHaveBeenCalled();
      expect(app._captureAISReplaySample).toHaveBeenCalledTimes(1);
      const rad = app._captureAISReplaySample.mock.calls[0][0];
      expect(rad.mmsi).toBe(mmsi);
      expect(rad.lat).toBe(58.2975);
      expect(rad.sog).toBe(14);
      expect(rad.shipName).toBe('SYNT-U69');
    },
  );

  test.each([['Unknown'], [''], [undefined]])(
    'utan riktigt namn (%p) läses namncachen inte, och raden spelas in som "Unknown"',
    (shipName) => {
      const app = makeApp();
      app._lookupVesselName = jest.fn(() => 'CACHAT NAMN');
      app._processAISMessage(pos('111219001', { shipName }));
      expect(app._lookupVesselName).not.toHaveBeenCalled();
      expect(app._rememberVesselName).not.toHaveBeenCalled();
      expect(app._captureAISReplaySample.mock.calls[0][0].shipName).toBe('Unknown');
      expect(app.vesselDataService.updateVessel).not.toHaveBeenCalled();
    },
  );

  test('ett fartyg utan riktigt namn får fortfarande namnet ur cachen (motfall)', () => {
    const app = makeApp();
    app._lookupVesselName = jest.fn(() => 'CACHAT NAMN');
    app._processAISMessage(pos('265012345', { shipName: 'Unknown' }));
    expect(app._lookupVesselName).toHaveBeenCalledWith('265012345');
    expect(app._captureAISReplaySample.mock.calls[0][0].shipName).toBe('CACHAT NAMN');
  });

  test.each(['111111111', '999999999'])('dummy-MMSI %s behandlas som ett fartyg, som före U69', (mmsi) => {
    const app = makeApp();
    app._processAISMessage(pos(mmsi));
    expect(app.vesselDataService.updateVessel).toHaveBeenCalledTimes(1);
  });

  test('den inspelade raden ger uppspelad genom samma ingång inget fartyg och ingen ny inspelning av fartyg', () => {
    const inspelning = makeApp();
    inspelning._processAISMessage(pos('111219001', { fixTs: Date.now() - 10000, fixFeed: 'aishub' }));
    const rad = inspelning._captureAISReplaySample.mock.calls[0][0];
    // replayRunner matar raden som meddelande med aisTimestamp som timestamp.
    const uppspelning = makeApp();
    uppspelning._processAISMessage({ ...rad, timestamp: rad.aisTimestamp, fixFeed: rad.feed });
    expect(uppspelning.vesselDataService.updateVessel).not.toHaveBeenCalled();
    expect(uppspelning._rememberVesselName).not.toHaveBeenCalled();
    expect(uppspelning._captureAISReplaySample).toHaveBeenCalledTimes(1);
    expect(uppspelning._captureAISReplaySample.mock.calls[0][0].mmsi).toBe('111219001');
  });

  test.each(['982191001', '821910001', '265012345', '219000001', '710000001'])('%s behandlas som förut', (mmsi) => {
    const app = makeApp();
    app._processAISMessage(pos(mmsi));
    expect(app.vesselDataService.updateVessel).toHaveBeenCalledTimes(1);
    expect(app.vesselDataService.updateVessel.mock.calls[0][0]).toBe(mmsi);
  });

  test('MMSI som tal klassas likadant', () => {
    const app = makeApp();
    app._processAISMessage(pos(111219001));
    expect(app.vesselDataService.updateVessel).not.toHaveBeenCalled();
  });

  test('en felsökningsrad med klassen, högst en gång per sändare och 30 min', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-11-27T10:00:00Z'));
      const app = makeApp();
      const rader = () => app.debug.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('[NON_VESSEL_IGNORED]'));
      app._processAISMessage(pos('111219001'));
      app._processAISMessage(pos('111219001'));
      expect(rader()).toHaveLength(1);
      expect(rader()[0]).toContain('111219001');
      expect(rader()[0]).toContain('räddningsflyg');
      app._processAISMessage(pos('970219001'));
      expect(rader()).toHaveLength(2);
      jest.setSystemTime(new Date('2026-11-27T10:29:00Z'));
      app._processAISMessage(pos('111219001'));
      expect(rader()).toHaveLength(2);
      jest.setSystemTime(new Date('2026-11-27T10:31:00Z'));
      app._processAISMessage(pos('111219001'));
      expect(rader()).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test('loggminnet växer inte utan gräns', () => {
    const app = makeApp();
    for (let i = 0; i < 2000; i++) app._processAISMessage(pos(`111${201 + (i % 575)}${String(Math.floor(i / 575)).padStart(3, '0')}`));
    expect(app._nonVesselLogTimes.size).toBeLessThanOrEqual(500);
    expect(app.vesselDataService.updateVessel).not.toHaveBeenCalled();
  });

  test('ett namn ur en statisk rapport från räddningsflyg hamnar inte i namncachen', () => {
    const app = makeApp();
    app._onStaticName({ mmsi: '111219001', shipName: 'SYNT-U69' });
    expect(app._rememberVesselName).not.toHaveBeenCalled();
    app._onStaticName({ mmsi: '265012345', shipName: 'SYNT-BAT' });
    expect(app._rememberVesselName).toHaveBeenCalledWith('265012345', 'SYNT-BAT');
  });
});
