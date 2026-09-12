'use strict';

const { validateInvariants } = require('./replay-validation/invariants');
const { crossingsForVessel, BRIDGE_STATIONS } = require('./replay-validation/makeGtPassages');

test('lång strax kräver ett sammanhängande intervall med färskt väntbevis', () => {
  const t = Date.parse('2026-09-10T08:00:00Z');
  const bridge = 'Stridsbergsbron';
  const result = {
    notifications: [],
    targetPassages: [],
    bridgeTextTransitions: [
      { t, iso: new Date(t).toISOString(), text: `En båt på väg mot ${bridge}, beräknad broöppning strax` },
      { t: t + 3 * 3600000, iso: new Date(t + 3 * 3600000).toISOString(), text: 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron' },
    ],
  };
  const zombies = (waits) => validateInvariants({ ...result, confirmedTargetWaits: waits }).filter((v) => v.startsWith('STRAX-ZOMBIE'));
  expect(zombies([])).toHaveLength(1);
  expect(zombies([{ bridge, from: t, until: t + 10 * 60000 }])).toHaveLength(1);
  expect(zombies([{ bridge, from: t + 2 * 3600000, until: t + 3 * 3600000 }])).toHaveLength(1);
  expect(zombies([{ bridge: 'Klaffbron', from: t, until: t + 3 * 3600000 }])).toHaveLength(1);
  expect(zombies([{ bridge, from: t, until: t + 3 * 3600000 }])).toEqual([]);
});

test('GPS-rimlighet mäts i fixtid; snabb leverans får inte ta bort en äkta passage', () => {
  const station = BRIDGE_STATIONS.find((b) => b.name === 'Järnvägsbron');
  const t = Date.parse('2026-09-10T16:34:54.324Z');
  const p = {
    mmsi: '265573130',
    lat: 58.29164,
    lon: 12.29196,
    sog: 5.7,
    s: station.s - 4,
    offsetM: 0,
    t,
    tFix: Date.parse('2026-09-10T16:34:00Z'),
  };
  const q = {
    ...p,
    lat: 58.293145,
    lon: 12.29411833,
    sog: 7.2,
    s: station.s + 207,
    t: t + 7336,
    tFix: t + 7336,
  };
  const crossings = (next) => crossingsForVessel([p, next]).filter((x) => x.bridge === station.name);
  expect(crossings(q)).toHaveLength(1);
  expect(crossings(q)[0]).toMatchObject({ tFrom: t, tTo: t + 7336 });
  expect(crossings({ ...q, tFix: p.tFix + 1000 })).toEqual([]);
  expect(crossings({ ...q, tFix: p.tFix })).toEqual([]);
  expect(crossings({ ...q, tFix: p.tFix - 1000 })).toEqual([]);
});
