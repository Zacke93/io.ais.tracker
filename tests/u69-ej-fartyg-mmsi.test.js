'use strict';

jest.mock('homey');

/**
 * U69 (dirigentens beslut, omgång 9): positioner från sändare som inte är
 * fartyg ignoreras helt. Fältprov 3 (k4 2026-11-25) visade ett räddningsflyg
 * (MMSI 111 + landskod) som "En båt på väg mot Stridsbergsbron, beräknad
 * broöppning strax" i fem minuter. Klasserna följer ITU-R M.585: 111
 * räddningsflyg, 970/972/974 nödsändare, 99 sjömärken, 00 kuststationer och
 * övriga 0 (gruppanrop). 98 (farkost knuten till ett moderfartyg), 8
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
    ['992191001', 'sjömärke'],
    ['002191000', 'kuststation'],
    ['021910001', 'gruppanrop'],
    [111219001, 'räddningsflyg'],
    [992191001, 'sjömärke'],
  ])('%p är %s', (mmsi, klass) => {
    expect(nonVesselMmsiClass(mmsi)).toBe(klass);
  });

  test.each([
    '982191001', // farkost knuten till ett moderfartyg
    '821910001', // handhållen VHF med DSC och GNSS
    '219000001', '265012345', '305000001', '412000001', '538000001', '636000001', '710000001',
    '112219001', // 11 men inte 111
    '971219001', '973219001', '975219001', '979219001', // grannar till nödsändarna
  ])('%s släpps igenom', (mmsi) => {
    expect(nonVesselMmsiClass(mmsi)).toBeNull();
  });

  test.each([
    [null], [undefined], [''], ['0'], [0], ['11121900'], ['1112190011'], ['111a19001'],
    [2655000], // tal som tappat inledande nollor: formfel, inte en klass
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
    app._captureAISReplaySample = jest.fn();
    return app;
  }
  const pos = (mmsi, extra = {}) => ({
    mmsi, lat: 58.2975, lon: 12.2985, sog: 14, cog: 215, shipName: 'SYNT-U69', timestamp: Date.now(), ...extra,
  });

  test.each(['111219001', '970219001', '972219001', '974219001', '992191001', '002191000', '021910001'])(
    '%s skapar inget fartyg, ingen namnpost och ingen inspelningsrad',
    (mmsi) => {
      const app = makeApp();
      app._processAISMessage(pos(mmsi));
      expect(app.vesselDataService.updateVessel).not.toHaveBeenCalled();
      expect(app._rememberVesselName).not.toHaveBeenCalled();
      expect(app._captureAISReplaySample).not.toHaveBeenCalled();
    },
  );

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
    for (let i = 0; i < 2000; i++) app._processAISMessage(pos(`111${String(i).padStart(6, '0')}`));
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
