'use strict';

jest.mock('homey');

const App = require('../app');
const { parseFieldLog, compareEvents, openingKeyOf } = require('./replay-validation/compareFieldReplay');

const STAMP = '2026-09-09T08:00:00.000Z';
const line = (message) => `${STAMP} [log] [AISBridgeApp] ${message}`;

describe('Fältrapporten läser öppningskortets riktiga leveranslogg', () => {
  test.each([-1, 0, 19])('levererad ETA %s finns med i jämförelsen även när loggen säger okänd', async (eta) => {
    const logs = [];
    const app = {
      _bridgeOpeningTrigger: { trigger: jest.fn().mockResolvedValue(undefined) },
      log: (message) => logs.push(line(message)),
    };
    const tokens = {
      bridge_name: 'Stridsbergsbron',
      vessel_name: 'ANTJE',
      vessel_count: 1,
      direction: 'norrut',
      eta_minutes: eta,
    };
    const state = { eventId: 'Stridsbergsbron#11', firedBy: 'fix' };

    await App.prototype._triggerBridgeOpeningFlow.call(app, tokens, state);

    expect(app._bridgeOpeningTrigger.trigger).toHaveBeenCalledWith(tokens, state);
    const field = parseFieldLog(logs.join('\n')).openingWarnings;
    const expected = [{
      t: Date.parse(STAMP),
      eventId: state.eventId,
      bridge: 'Stridsbergsbron',
      vesselCount: 1,
      leadVessel: 'ANTJE',
      etaMin: eta,
      direction: 'northbound',
      firedBy: 'fix',
    }];
    expect(field).toEqual(expected);
    const comparison = compareEvents(field, expected, openingKeyOf, ['etaMin', 'vesselCount']);
    expect(comparison.pairs).toHaveLength(1);
    expect(comparison.pairs[0].changes).toEqual([]);
    expect(comparison.unmatchedReplay).toEqual([]);
    expect(comparison.unmatchedField).toEqual([]);
  });

  test('äldre loggars numeriska -1-sentinel fortsätter fungera', () => {
    const report = parseFieldLog(line('[OPENING_TRIGGER_SUCCESS] Stridsbergsbron#1: '
      + 'bridge_opening_soon avfyrad för Stridsbergsbron '
      + '(1 båt(ar), ledande KNIGHT OWL, eta=-1 min, norrut, källa deadline)'));
    expect(report.openingWarnings).toEqual([expect.objectContaining({
      leadVessel: 'KNIGHT OWL', etaMin: -1, firedBy: 'deadline',
    })]);
  });

  test('nekad leverans skriver ingen framgångsrad som rapporten kan räkna', async () => {
    const logs = [line('Start')];
    const app = {
      _bridgeOpeningTrigger: { trigger: jest.fn().mockRejectedValue(new Error('nekad')) },
      log: (message) => logs.push(line(message)),
    };
    await expect(App.prototype._triggerBridgeOpeningFlow.call(app, {}, {})).rejects.toThrow('nekad');
    expect(parseFieldLog(logs.join('\n')).openingWarnings).toEqual([]);
  });
});
