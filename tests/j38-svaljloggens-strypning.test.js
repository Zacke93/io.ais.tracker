'use strict';

/**
 * J38 (helkodsgranskning runda 2, 2026-08-22) — H38:S SVÄLJLOGG VAR OSTRYPT.
 *
 * FYNDET: runda 1:s H38 loggar varje svalt textfel med logger.error INKLUSIVE
 * hela error.stack, utan strypning eller dedupe. generateBridgeText anropas
 * från _actuallyUpdateUI vid varje koalescerad UI-uppdatering plus
 * 30 s-watchdogen och 60 s-tvångsuppdateringen, och utlösaren (ett kastande
 * fält på ett fartygsobjekt) är per konstruktion PERSISTENT — samma fartyg
 * kastar i varje anrop så länge det spåras, upp till RC7-filtrets 25 min.
 * I livlig trafik (1–3 UI-uppdateringar/s) blir det ~1 950 flersidiga
 * stackspår i timmen: samma logsvält som B1/F13 åtgärdade i StatusService
 * (5 945 rader per 42 h dränkte äkta diagnos), och den dränker precis den
 * diagnos H38 finns för att möjliggöra.
 *
 * FIXEN: högst en rad per minut och felsignatur (name + message), stacken bara
 * vid första förekomsten, antalet undertryckta räknat och utskrivet på nästa
 * rad som släpps igenom.
 *
 * ALLA tester nedan går genom den RIKTIGA pipelinen: ett fartygsobjekt med en
 * kastande getter matas till generateBridgeText, precis som fältfallet.
 */

const BridgeTextService = require('../lib/services/BridgeTextService');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

const makeLogger = () => ({
  log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

/** Ett fartyg vars targetBridge-läsning kastar — läses inne i filtret. */
function kastandeBat(mmsi, meddelande = 'fältet kastar') {
  const v = { mmsi };
  Object.defineProperty(v, 'targetBridge', {
    get() {
      throw new TypeError(meddelande);
    },
    enumerable: true,
  });
  return v;
}

function friskBat(mmsi, targetBridge = 'Klaffbron') {
  return {
    mmsi, targetBridge, etaMinutes: 7, status: 'en-route',
  };
}

function svaljRader(logger) {
  return logger.error.mock.calls
    .map((c) => String(c[0]))
    .filter((r) => r.includes('[BRIDGE_TEXT_SWALLOWED]'));
}

describe('J38: svälj-loggen stryps per felsignatur', () => {
  let logger;
  let svc;
  let mockNu;
  const realDateNow = Date.now;

  beforeEach(() => {
    logger = makeLogger();
    svc = new BridgeTextService(null, logger);
    mockNu = new Date(2026, 7, 22, 9, 0, 0).getTime();
    Date.now = () => mockNu;
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  test('KÄRNAN: 500 anrop med samma persistenta fel ger ≤ 2 rader, 1 med stack', () => {
    const batar = [friskBat('265000001'), kastandeBat('265000002'), friskBat('265000003')];
    for (let i = 0; i < 500; i += 1) {
      // Fältets kadens: 1–3 UI-uppdateringar per sekund.
      mockNu += 400;
      expect(svc.generateBridgeText(batar)).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    }
    const rader = svaljRader(logger);
    // EXAKT facit: 500 anrop × 400 ms spänner 200 s. Första raden skrivs på
    // anrop 1 (t=0,4 s), nästa när 60 s passerat (t=60,4 s) osv ⇒ 4 rader.
    // Ostrypt vore 500 rader med var sitt flersidigt stackspår (125× färre).
    expect(rader).toHaveLength(4);
    expect(rader[3]).toContain('undertryckta=149');
    expect(rader.filter((r) => r.includes('stack=')).length).toBe(1);
    // Första raden bär stacken.
    expect(rader[0]).toContain('stack=');
  });

  test('SAMMA MINUT: 200 anrop ger EXAKT en rad', () => {
    const batar = [kastandeBat('265000002')];
    for (let i = 0; i < 200; i += 1) {
      svc.generateBridgeText(batar);
    }
    expect(svaljRader(logger)).toHaveLength(1);
  });

  test('EFTER 61 s: ny rad, med antalet undertryckta och UTAN stack', () => {
    const batar = [kastandeBat('265000002')];
    for (let i = 0; i < 50; i += 1) svc.generateBridgeText(batar);
    expect(svaljRader(logger)).toHaveLength(1);

    mockNu += 61000;
    svc.generateBridgeText(batar);

    const rader = svaljRader(logger);
    expect(rader).toHaveLength(2);
    expect(rader[1]).toContain('undertryckta=49');
    expect(rader[1]).not.toContain('stack=');
  });

  test('NY SIGNATUR loggas direkt, med egen stack', () => {
    svc.generateBridgeText([kastandeBat('265000002', 'fel A')]);
    svc.generateBridgeText([kastandeBat('265000003', 'fel B')]);

    const rader = svaljRader(logger);
    expect(rader).toHaveLength(2);
    expect(rader[0]).toContain('fel A');
    expect(rader[1]).toContain('fel B');
    expect(rader.filter((r) => r.includes('stack=')).length).toBe(2);
  });

  test('SVÄLJKONTRAKTET ORÖRT: returvärdet är oförändrat och inget kastas ut', () => {
    const batar = [friskBat('265000001'), kastandeBat('265000002')];
    for (let i = 0; i < 5; i += 1) {
      expect(() => svc.generateBridgeText(batar)).not.toThrow();
      expect(svc.generateBridgeText(batar)).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    }
    // Friska anrop påverkas inte av strypningen.
    expect(svc.generateBridgeText([friskBat('265000009')]))
      .toContain('på väg mot Klaffbron');
  });

  test('MINNET: kartan växer inte obegränsat vid unika felmeddelanden', () => {
    for (let i = 0; i < 80; i += 1) {
      svc.generateBridgeText([kastandeBat('265000002', `unikt fel ${i}`)]);
      mockNu += 10;
    }
    expect(svc._svaljLoggTider.size).toBeLessThanOrEqual(50);
    // Alla 80 är olika signaturer ⇒ alla loggas (strypningen är per signatur).
    expect(svaljRader(logger)).toHaveLength(80);
  });

  test('ROBUSTHET: en logger som själv kastar fäller inte brotexten', () => {
    const trasig = makeLogger();
    trasig.error = jest.fn(() => {
      throw new Error('loggern är trasig');
    });
    const svc2 = new BridgeTextService(null, trasig);
    expect(svc2.generateBridgeText([kastandeBat('265000002')]))
      .toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
  });

  test('ISOLERING: två instanser delar inte strypningstillstånd', () => {
    const loggerB = makeLogger();
    const svcB = new BridgeTextService(null, loggerB);
    svc.generateBridgeText([kastandeBat('265000002')]);
    svcB.generateBridgeText([kastandeBat('265000002')]);
    expect(svaljRader(logger)).toHaveLength(1);
    expect(svaljRader(loggerB)).toHaveLength(1);
  });
});
