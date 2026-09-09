'use strict';

const { eventFacit, eventFacitFailures } = require('./replay-validation/eventFacit');

const base = () => ({
  notifications: [{
    t: 1000, eta: 3, message: 'Båt närmar sig', source: 'target', bridge: 'Klaffbron', mmsi: '265000001',
  }],
  openingWarnings: [],
  openingSuppressions: [],
  targetPassages: [],
  intermediatePassages: [],
});
test('fulla händelser kan låsas utan att saknade dimensioner blir tomma listor', () => {
  expect(eventFacitFailures(base(), eventFacit(base()))).toEqual([]);
  expect(() => eventFacit({ ...base(), openingWarnings: undefined })).toThrow('saknas');
  expect(eventFacitFailures(base(), { version: 1 })).toHaveLength(5);
});
test.each(['t', 'eta', 'message', 'source', 'bridge', 'mmsi'])('%s-drift fälls trots identiskt notisantal', (field) => {
  const result = base();
  result.notifications[0][field] = 'ändrat';
  expect(eventFacitFailures(result, eventFacit(base()))).toHaveLength(1);
});
test('borttagen sista händelse kan inte gömmas av oförändrat prefix', () => {
  expect(eventFacitFailures({ ...base(), notifications: [] }, eventFacit(base()))).toHaveLength(1);
});
