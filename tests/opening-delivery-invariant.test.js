'use strict';

const { openingDeliveryFailures } = require('./replay-validation/openingDelivery');

const key = 'Klaffbron|265000001|northbound';
const warning = {
  t: 1000, eventId: 'Klaffbron#1', bridge: 'Klaffbron', mmsis: ['265000001'], success: true,
};
const duplicate = {
  t: 6000,
  bridge: 'Klaffbron',
  eventId: 'Klaffbron#2',
  suppressed: 'same-arrival',
  members: [{ mmsi: '265000001', key, firedAt: 1000 }],
};
const result = (overrides = {}) => ({
  openingServiceFires: 2, openingWarnings: [warning], openingSuppressions: [duplicate], ...overrides,
});

test('en levererad varning och en belagd dubblett balanserar service och kort', () => {
  expect(openingDeliveryFailures(result())).toEqual([]);
});
test.each([
  { openingServiceFires: 3 },
  { openingWarnings: [{ ...warning, success: false }] },
  { openingWarnings: [{ ...warning, t: 7000 }] },
  { openingWarnings: [{ ...warning, bridge: 'Stridsbergsbron' }] },
  { openingWarnings: [{ ...warning, mmsis: ['265000002'] }] },
  { openingSuppressions: [{ ...duplicate, members: [] }] },
  { openingSuppressions: [{ ...duplicate, members: [...duplicate.members, { mmsi: '265000002', firedAt: 1000 }] }] },
])('tappad eller obelagd varning gör grinden röd: %j', (overrides) => {
  expect(openingDeliveryFailures(result(overrides)).length).toBeGreaterThan(0);
});
test('varning före inspelningen kräver ett faktiskt återställt och matchande startminne', () => {
  const restored = result({
    openingServiceFires: 1,
    openingWarnings: [],
    initialState: { source: 'recorded', capturedAt: 5000 },
    openingWarningsAtStartup: [{ key, firedAt: 1000 }],
  });
  expect(openingDeliveryFailures(restored)).toEqual([]);
  expect(openingDeliveryFailures({ ...restored, openingWarningsAtStartup: [] })).not.toEqual([]);
  expect(openingDeliveryFailures({ ...restored, initialState: { source: 'empty' } })).not.toEqual([]);
});

const absorbed = {
  t: 7000, bridge: 'Klaffbron', eventId: 'Klaffbron#1', mmsi: '265000002', reason: 'absorbed',
};
test('ny konvojmedlem kan täckas av ett faktiskt tidigare kort för samma event', () => {
  expect(openingDeliveryFailures(result({ openingCoverage: [absorbed] }))).toEqual([]);
});
test.each([
  { ...absorbed, eventId: 'Klaffbron#2' },
  { ...absorbed, bridge: 'Stridsbergsbron' },
  { ...absorbed, t: 500 },
])('en konvojkoppling utan rätt tidigare kort gör grinden röd: %j', (entry) => {
  expect(openingDeliveryFailures(result({ openingCoverage: [entry] })))
    .toContain(`OBELAGD KONVOJTÄCKNING: ${entry.eventId} för ${entry.mmsi}`);
});
test('ett gammalt levererat eventnummer kan inte dölja ny suppression efter omstart', () => {
  const restarted = result({
    openingCoverage: [absorbed],
    openingSuppressions: [{ ...duplicate, eventId: warning.eventId }],
  });
  expect(openingDeliveryFailures(restarted)).toContain('OBELAGD KONVOJTÄCKNING: Klaffbron#1 för 265000002');
});
