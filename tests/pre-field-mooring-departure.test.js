'use strict';

/** Rådatafallet DORY MAN 2026-08-07: fartbrus efter bevisad kajförtöjning. */
const fs = require('fs');
const path = require('path');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

describe('Inför fältprov: en bevisad kajvistelse släpps av förflyttning', () => {
  let service;
  let now;
  let nowSpy;
  const logger = {
    debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
  };
  const mooringPoint = { lat: 58.28747, lon: 12.2855 };

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    now = Date.parse('2026-08-07T14:15:24.408Z');
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    service = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  });

  afterEach(() => {
    service.clearAllTimers();
    nowSpy.mockRestore();
    delete global.__TEST_MODE__;
  });

  function update(position, sog, minutes = 0, cog = null) {
    now += minutes * 60000;
    return service.updateVessel('211411410', {
      ...position, sog, cog, name: 'DORY MAN',
    });
  }

  function establishMooring() {
    update(mooringPoint, 0.2);
    const vessel = update({ lat: 58.28754, lon: 12.28544 }, 0.3, 3.33);
    expect(vessel._moored).toBe(true);
    return vessel;
  }

  test('rådata: 0,6 kn efter några meters kajbrus återinför inte målbron', () => {
    const samples = fs.readFileSync(path.join(__dirname,
      'replay-validation/corpora-data/ais-20260806-42h.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line))
      .filter((sample) => String(sample.mmsi) === '211411410'
        && sample.aisTimestamp >= Date.parse('2026-08-07T14:10:00Z')
        && sample.aisTimestamp <= Date.parse('2026-08-07T14:24:18Z'));
    let classified = false;
    for (const sample of samples) {
      now = sample.aisTimestamp;
      const vessel = service.updateVessel(sample.mmsi, { ...sample, name: sample.shipName });
      if (sample.aisTimestamp === Date.parse('2026-08-07T14:18:44.072Z')) {
        expect(vessel._moored).toBe(true);
        classified = true;
      }
      if (classified) {
        expect(vessel._moored).toBe(true);
        expect(vessel.targetBridge).toBeNull();
      }
    }
    expect(classified).toBe(true);
  });

  test('finit fart och minst 50 meters netto släpper direkt på första nya positionen', () => {
    establishMooring();
    const vessel = update({ lat: 58.28797, lon: 12.2855 }, 3, 1, 0);
    expect(vessel._moored).toBe(false);
    expect(vessel._stationarySince).toBeNull();
    expect(vessel.targetBridge).toBe('Stridsbergsbron');
  });

  test('positionsbevisad avgång utan fartgivare släpper också', () => {
    establishMooring();
    update(mooringPoint, null, 1);
    const vessel = update({ lat: 58.28797, lon: 12.2855 }, null, 1);
    expect(vessel._moored).toBe(false);
    expect(vessel._stationarySince).toBeNull();
  });

  test('ung farledsväntare omfattas inte av kajhållet', () => {
    const vessel = update({ lat: 58.2859, lon: 12.2866 }, 0.1);
    expect(vessel._moored).toBe(false);
    const moved = update({ lat: 58.2859, lon: 12.2866 }, 0.6, 4);
    expect(moved._stationarySince).toBeNull();
    expect(moved._moored).toBe(false);
  });
});
