'use strict';

/**
 * J17 — KARAKTERISERINGSTEST AV ETT KÄNT FEL SOM STÅR KVAR MEDVETET.
 *
 * FILNAMNET SÄGER VAD TESTET LÅSER: passage-grenen i
 * ProximityService.calculateProximityTimeout är ett TAK på 65 s — inte ett golv.
 *
 * (L37, helkodsgranskning runda 3, 2026-08-22: den här headern påstod tidigare
 * att filnamnet var kvar från den ÅTERKALLADE fixen och att testet låste
 * MOTSATSEN till sitt namn. Bådadera var sant om det GAMLA namnet
 * "j17-passage-golv-inte-tak", men filen döptes om i runda 2c och namn och
 * innehåll säger sedan dess samma sak. Samma runda rättade den kvarvarande
 * pekaren till det gamla namnet i lib/services/ProximityService.js — den
 * pekade på en fil som aldrig funnits i git, vilket är precis den klass av
 * falsk pekare som gav AKIRA-regressionen i fixrunda 2b.)
 *
 * FELET (obestritt): `Math.max(remainingTime, 65000)` med
 * `remainingTime = 65000 − timeSincePassed` är KONSTANT 65 000 ms, och den
 * tidiga returen ligger FÖRE alla golv (närhetsklass, waiting, fast,
 * ACTIVE_JOURNEY_MIN, moored) och överskriver dem. K18-basnivån blir därmed
 * 65 000 ms = AISHUB_POLL_INTERVAL_MS, så ett livstecken kan inte bära
 * fartyget över ett pollglapp.
 *
 * VARFÖR DET ÄNDÅ STÅR KVAR: taket är i dag den mekanism som håller SR2-3
 * (låst 2026-07-11). Flyttas raden sist som ett äkta golv återuppstår
 * AKIRA-spöket i 20260707-14h (idx 25: "Fyra båtar…" i st.f. facits "Tre
 * båtar … strax") och samma klass i 20260804-17h (MISTY). En framtida fix
 * kräver en KLASSREGEL för passerat-och-stannat (retention + staleDisplay),
 * mätt mot 14h och 17h med SR2-3 intakt — se kommentaren vid grenen.
 *
 * DETTA TEST SKA DÄRFÖR FALLA om någon flyttar/mjukar upp grenen utan att
 * först landa klassregeln och mäta om korpusarna.
 */

const ProximityService = require('../lib/services/ProximityService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { TIMEOUT_SETTINGS, AIS_CONFIG } = require('../lib/constants');

const logger = {
  log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
};
const prox = () => new ProximityService(new BridgeRegistry(), logger);

describe('J17 (känt fel, låst): passage-grenen är ett TAK på 65 s', () => {
  test('inom fönstret returneras 65 000 ms i ALLA 32 klasskombinationer', () => {
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
            expect(passerad).toBe(65000); // TAKET: klassen spelar ingen roll
            n += 1;
          }
        }
      }
    }
    expect(n).toBe(32);
  });

  test('taket ligger UNDER närhetsklassen det överskriver (och på pollperioden)', () => {
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
    expect(passerad).toBeLessThan(enRoute); // detta ÄR felet, dokumenterat
    expect(passerad).toBe(AIS_CONFIG.AISHUB.POLL_INTERVAL_MS); // livstecknet bär inte
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
