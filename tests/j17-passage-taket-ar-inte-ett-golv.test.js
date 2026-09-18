'use strict';

/**
 * J17 — karakterisering av passed-klassen UTAN färska transitbevis.
 *
 * Basnivån är fortfarande 65 s under första minuten. scheduleCleanup
 * förkortar inte redan beviljade timers och skyddar passagevisningen, så
 * resultatet är inte en generell 65-sekundersgräns för fartygets livslängd.
 *
 * Sedan 2026-09-18 får en bokförd passage med rent positionssegment,
 * färsk råfart i transit och nästa målbro framför sig förnya den vanliga
 * aktiva resans livslängd. Den klassen prövas i
 * tests/j17-continuing-passage-retention.test.js med hela appens timers.
 * Objekten nedan saknar dessa bevis och behåller därför sin korta basnivå.
 *
 * Avgränsningen skyddar den historiskt uppmätta spökregressionen: att flytta
 * returen sist som ett ovillkorligt golv förlängde AKIRA 20260707-14h från
 * 6,5 till 25 minuter och gav motsvarande spöktext för MISTY 20260804-17h.
 * Båda verkliga stoppen ingår nu även i det nya integrationstestet.
 */

const ProximityService = require('../lib/services/ProximityService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { TIMEOUT_SETTINGS, AIS_CONFIG } = require('../lib/constants');

const logger = {
  log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
};
const prox = () => new ProximityService(new BridgeRegistry(), logger);

describe('J17: utan färska transitbevis har passage-grenen basnivån 65 s', () => {
  test('utan transitbevis returneras 65 000 ms i alla 32 klasskombinationer', () => {
    const p = prox();
    let n = 0;
    for (const nearestDistance of [120, 400, 800, Number.NaN]) {
      for (const targetBridge of [null, 'Klaffbron']) {
        for (const sog of [0, 5.2]) {
          for (const moored of [false, true]) {
            const bas = {
              mmsi: '1', lat: 58.2839, lon: 12.2864, sog, targetBridge, _moored: moored,
            };
            const passerad = p.calculateProximityTimeout(
              { ...bas, status: 'passed', lastPassedBridgeTime: Date.now() - 5000 },
              { nearestDistance },
            );
            expect(passerad).toBe(65000); // Enbart fart/mål bevisar ingen fortsatt transit.
            n += 1;
          }
        }
      }
    }
    expect(n).toBe(32);
  });

  test('basnivån understiger en vanlig aktiv resas nivå', () => {
    const p = prox();
    const bas = {
      mmsi: '2', lat: 58.2839, lon: 12.2864, sog: 5.2, targetBridge: 'Stridsbergsbron',
    };
    const enRoute = p.calculateProximityTimeout({ ...bas, status: 'en-route' }, { nearestDistance: 120 });
    const passerad = p.calculateProximityTimeout(
      { ...bas, status: 'passed', lastPassedBridgeTime: Date.now() - 5000 },
      { nearestDistance: 120 },
    );
    expect(enRoute).toBe(TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN);
    expect(passerad).toBeLessThan(enRoute); // transitundantaget kräver även positions- och passagebevis
    expect(passerad).toBe(AIS_CONFIG.AISHUB.POLL_INTERVAL_MS); // befintlig längre timer kan ändå bära livstecknet
  });

  test('efter fönstret (>60 s) är grenen utan verkan och golven gäller', () => {
    const p = prox();
    const t = p.calculateProximityTimeout(
      {
        mmsi: '3',
        lat: 58.2839,
        lon: 12.2864,
        sog: 5.2,
        targetBridge: 'Stridsbergsbron',
        status: 'passed',
        lastPassedBridgeTime: Date.now() - 61000,
      },
      { nearestDistance: 120 },
    );
    expect(t).toBe(TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN);
  });
});
