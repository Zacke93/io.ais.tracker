'use strict';

jest.mock('homey');

/**
 * M2b (helkodsgranskning fixrunda 4b, 2026-08-23) — DEBUGRADEN FICK INTE
 * KUNNA STÄNGA AV SKYDDET DEN BESKRIVER.
 *
 * FYNDET (granskare, runda 4): `_isBridgeOpeningQuayWobbler` är FAIL-OPEN by
 * design — hela kroppen ligger i ett try vars catch returnerar `false`, och
 * `false` betyder "INTE kajvobblare", vilket i sin tur TILLÅTER beväpning.
 * Doktrinen är rätt (en missad broöppning är värre än ett falsklarm), men den
 * gör varje kast inne i try:t till ett TYST AVSLAG PÅ SKYDDET.
 * M2:s egen loggrad OPENING_QUAY_SOG_UNCORROBORATED formaterade tre mätvärden
 * ur quayTransitProof rått — bland annat `proof.impliedKn.toFixed(2)`. Modulens
 * returväg `reason: 'no_speed'` ger `corroborated: false` med ALLA tre
 * mätvärden null, och `null.toFixed` kastar TypeError. Ett kast där hade alltså
 * fällt ut i catchen, gett `false`, och tyst tillåtit exakt den beväpning M2
 * lades till för att stoppa.
 *
 * ATT VÄGEN ÄR ONÅBAR I DAG ÄR INGET FÖRSVAR: den enda anroparen kräver finit
 * sog, men "onåbar i dag" är precis den premiss som brustit förr i det här
 * projektet så fort en andra anropare tillkommit — och priset här är att
 * skyddet stängs av utan ett spår i loggen.
 *
 * FIXEN: mätvärdena formateras genom hjälparen `fmtMeasure` (finit ⇒ tal,
 * annars 'okänt'), `reason` skrivs ut eftersom den alltid är satt, och catchen
 * ligger kvar på ERROR-nivå (aldrig debug) med en kommentar som säger varför
 * fail-open behålls — strängen ägs av tests/bridge-opening-app-integration.test.js.
 *
 * SVITEN MOCKAR DEN DELADE MODULEN för att nå den returväg produktionen inte
 * kan konstruera själv — det är hela poängen med fyndet. Grindens egna
 * beteendekontrakt ligger kvar i tests/m2-kajgrind-korroborering.test.js.
 */

jest.mock('../lib/utils/quayTransitProof', () => {
  const actual = jest.requireActual('../lib/utils/quayTransitProof');
  return {
    ...actual,
    explainTransitCorroboration: jest.fn(actual.explainTransitCorroboration),
  };
});

const AISBridgeApp = require('../app');
const proofModule = require('../lib/utils/quayTransitProof');
const { BRIDGE_OPENING } = require('../lib/constants');

const REAL_DATE_NOW = Date.now;

// CARAT-geometrin ur korpus 20260804-both-21h (rådata, oförändrad).
const CARAT_QUAY = { lat: 58.28769, lon: 12.28584 }; // 415,0 m från Klaffbron
const CARAT_STILL = { lat: 58.28766, lon: 12.28583 }; // 411,6 m — sog 0,4
const CARAT_NOISE = { lat: 58.2875, lon: 12.28499 }; // 383,6 m — sog 7,4 (bruset)

const makeApp = () => {
  const app = Object.create(AISBridgeApp.prototype);
  app.debug = jest.fn();
  app.log = jest.fn();
  app.error = jest.fn();
  app._quayStableLedger = new Map();
  app._openingQuayLedger = new Map();
  return app;
};

const sample = (pos, sog, ts) => ({
  mmsi: '211452170',
  lat: pos.lat,
  lon: pos.lon,
  sog,
  cog: 250.6,
  timestamp: ts,
  fixTs: ts,
  fixFeed: 'aishub',
  targetBridge: 'Klaffbron',
});

const uncorroboratedRow = (app) => app.debug.mock.calls
  .map((c) => String(c[0]))
  .find((line) => line.includes('OPENING_QUAY_SOG_UNCORROBORATED'));

describe('M2b: loggraden i kajgrinden kan inte kasta', () => {
  let now;

  beforeEach(() => {
    jest.clearAllMocks();
    proofModule.explainTransitCorroboration.mockImplementation(
      jest.requireActual('../lib/utils/quayTransitProof').explainTransitCorroboration,
    );
    now = new Date(2026, 7, 5, 3, 40, 0).getTime();
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  /** CARAT:s kajvistelse byggd med produktionens egen bokföring. */
  const buildQuayStay = (app, stayMinutes = 40) => {
    const step = (stayMinutes * 60 * 1000) / 8;
    for (let i = 0; i < 8; i++) {
      app._noteQuayStability(sample(CARAT_QUAY, 0.2, now));
      now += step;
    }
  };

  /**
   * Rådatans sista stillasample + brusprovet 69 s senare, bokförda genom
   * produktionens egen väg. Returnerar brusprovet, redo att prövas.
   * (Föregående fix MÅSTE vara färsk — annars svarar modulen prev_fix_stale
   * och kortslutningen behålls, vilket är ett annat kontrakt än det här.)
   */
  const armCaratNoise = (app) => {
    buildQuayStay(app);
    app._noteQuayStability(sample(CARAT_STILL, 0.4, now));
    now += 68924;
    const noise = sample(CARAT_NOISE, 7.4, now);
    app._noteQuayStability(noise);
    return noise;
  };

  test('NOLLA MÄTVÄRDEN (reason no_speed): ingen exception, rätt verdikt, läsbar rad', () => {
    const app = makeApp();
    const noise = armCaratNoise(app);

    // Den returväg produktionens enda anropare inte kan konstruera.
    proofModule.explainTransitCorroboration.mockReturnValueOnce({
      corroborated: false,
      reason: 'no_speed',
      dtMs: null,
      netM: null,
      impliedKn: null,
      prevAgeMs: null,
    });

    let verdict;
    expect(() => {
      verdict = app._isBridgeOpeningQuayWobbler(noise);
    }).not.toThrow();
    // RÄTT VERDIKT: beviset underkändes ⇒ kortslutningen tas inte, kajgrinden
    // prövas som vanligt och CARAT-profilen fälls som kajvobblare.
    expect(verdict).toBe(true);
    // INGET FAIL-OPEN-AVSLAG: catchen fick aldrig något att fånga.
    expect(app.error).not.toHaveBeenCalled();

    const row = uncorroboratedRow(app);
    expect(row).toBeDefined();
    expect(row).toContain('okänt m');
    expect(row).toContain('okänt kn');
    expect(row).toContain('orsak no_speed');
    expect(row).not.toContain('NaN');
    expect(row).not.toContain('null');
  });

  test('DELVIS NOLLA MÄTVÄRDEN: finita fält skrivs ut, saknade blir "okänt"', () => {
    const app = makeApp();
    const noise = armCaratNoise(app);

    proofModule.explainTransitCorroboration.mockReturnValueOnce({
      corroborated: false,
      reason: 'speed_uncorroborated',
      dtMs: 68924,
      netM: 52.2,
      impliedKn: null,
      prevAgeMs: 122000,
    });

    expect(() => app._isBridgeOpeningQuayWobbler(noise)).not.toThrow();
    const row = uncorroboratedRow(app);
    expect(row).toContain('52 m');
    expect(row).toContain('69s');
    expect(row).toContain('okänt kn');
    expect(app.error).not.toHaveBeenCalled();
  });

  test('DEN ÄKTA RADEN ÄR OFÖRÄNDRAD I SAK: alla mätvärden finita ⇒ siffror', () => {
    const app = makeApp();
    const noise = armCaratNoise(app);

    // Ingen mock — den verkliga modulen räknar på rådatans geometri.
    expect(app._isBridgeOpeningQuayWobbler(noise)).toBe(true);
    const row = uncorroboratedRow(app);
    expect(row).toMatch(/positionen flyttade \d+ m på \d+s/);
    expect(row).toMatch(/implicerat \d+\.\d{2} kn/);
    expect(row).toContain('orsak speed_uncorroborated');
    expect(row).not.toContain('okänt');
  });

  test('FAIL-OPEN BEHÅLLS MEN ALDRIG TYST: ett kast ⇒ false + ERROR-rad', () => {
    const app = makeApp();
    const noise = armCaratNoise(app);

    proofModule.explainTransitCorroboration.mockImplementationOnce(() => {
      throw new TypeError('konstruerat kast');
    });

    // Doktrinen: ett trasigt skydd släpper igenom (beväpning tillåts)...
    expect(app._isBridgeOpeningQuayWobbler(noise)).toBe(false);
    // ...men det syns på ERROR-nivå (inte debug), med orsaken utskriven.
    // Strängen är låst av tests/bridge-opening-app-integration.test.js; här
    // låses NIVÅN och att avslaget aldrig kan bli tyst.
    expect(app.error).toHaveBeenCalledTimes(1);
    const [prefix, detail] = app.error.mock.calls[0];
    expect(String(prefix)).toContain('[BRIDGE_OPENING] Kajvobbel-predikatet kastade');
    expect(String(detail)).toContain('konstruerat kast');
    expect(app.debug.mock.calls.map((c) => String(c[0])).join(' '))
      .not.toContain('Kajvobbel-predikatet kastade');
  });

  test('TRÖSKELN OFÖRÄNDRAD: under QUAY_TRANSIT_PROOF_SOG_KN prövas inget bevis', () => {
    const app = makeApp();
    buildQuayStay(app);
    now += 60000;
    const wobble = sample(CARAT_NOISE, 1.1, now);
    app._noteQuayStability(wobble);

    expect(wobble.sog).toBeLessThan(BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN);
    expect(app._isBridgeOpeningQuayWobbler(wobble)).toBe(true);
    expect(proofModule.explainTransitCorroboration).not.toHaveBeenCalled();
    expect(uncorroboratedRow(app)).toBeUndefined();
  });
});
