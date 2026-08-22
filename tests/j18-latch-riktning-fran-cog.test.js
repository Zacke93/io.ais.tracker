'use strict';

/**
 * J18 (helkodsgranskning runda 2, 2026-08-22) — LATCHEN SKREV MED ETT BAND
 * OCH LÄSTE MED ETT ANNAT.
 *
 * FYNDET: PassageLatchService._directionFromCog läser med det BREDA sydbandet
 * (isSouthCogWide, 135–<315, GR2-6). Riktningen som LAGRAS kom däremot från
 * anroparen, och alla fyra anropsställen i VesselDataService avslutar sin
 * fallbackkedja med _safeDetermineDirection, som använder det STRIKTA bandet
 * (isSouthCogStrict, 135–225) och därför returnerar null för COG 226–314 —
 * enligt cogDirection.js NORMAL sydfärd i den NE-SV-orienterade kanalen.
 *
 * SKADAN: F13-släppet kräver truthy latchData.direction. En MÅLLÖS båt (ingen
 * målbro ⇒ inga ruttlås) som passerar en mellanbro med COG 250 utan
 * korsningsbevis lagrades alltså med direction null. Vände hon tillbaka mot
 * samma bro blockerades 'waiting'/'approaching' hela 10-minutersfönstret —
 * precis den skada F13 infördes för att förhindra — och därmed även boat_near.
 *
 * FIXEN: registerPassage tar en valfri fjärde parameter (cog) och härleder
 * riktningen med SITT EGET band när anroparen inte hade någon. Saknas båda
 * förblir direction null (det konservativa kontraktet är oförändrat).
 *
 * ANMÄRKNING OM ANROPSSIDAN: de fyra anropsställena i VesselDataService
 * (rad 3813, 4869, 5270, 5989) ägs av en annan agent i samma runda och ska
 * skicka vessel.cog som fjärde argument. Testerna nedan prövar tjänstens
 * kontrakt, som är den halva som stänger asymmetrin permanent.
 */

const PassageLatchService = require('../lib/services/PassageLatchService');
const { isSouthCogStrict, isSouthCogWide } = require('../lib/utils/cogDirection');

const makeLogger = () => ({
  log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

const MMSI = '265001234';

describe('J18: latchen härleder riktning ur COG när anroparen saknar bevis', () => {
  let svc;
  let mockNow;
  const realDateNow = Date.now;

  beforeEach(() => {
    global.__TEST_MODE__ = true;
    mockNow = new Date(2026, 7, 22, 12, 0, 0).getTime();
    Date.now = () => mockNow;
    svc = new PassageLatchService(makeLogger());
  });

  afterEach(() => {
    if (svc) svc.destroy();
    svc = null;
    delete global.__TEST_MODE__;
    Date.now = realDateNow;
  });

  test('FÖRUTSÄTTNINGEN: COG 250 är null i det strikta bandet men south i det breda', () => {
    // Detta är hela asymmetrin, uttryckt i de två predikat som ägde den.
    expect(isSouthCogStrict(250)).toBe(false); // ⇒ _safeDetermineDirection: null
    expect(isSouthCogWide(250)).toBe(true); // ⇒ latchens läsning: 'south'
  });

  test('KÄRNAN: direction null + cog 250 lagras som south', () => {
    svc.registerPassage(MMSI, 'Järnvägsbron', null, 250);
    const latch = svc._passageLatches.get(MMSI).get('Järnvägsbron');
    expect(latch.direction).toBe('south');
  });

  test('SKADAN STÄNGD: vändning med COG 20 släpper efter två sampel', () => {
    // Sydgående passage med SV-kurs, utan korsningsbevis (mållös båt).
    svc.registerPassage(MMSI, 'Järnvägsbron', null, 250);

    // Sampel 1 efter vändningen: reversalen observeras men är obekräftad ⇒
    // blockeringen står kvar (debouncen mot brusiga enstaka COG-sampel).
    expect(svc.shouldBlockStatus(MMSI, 'Järnvägsbron', 'waiting', 20, 1000)).toBe(true);

    // Sampel 2 (ANNAT sampleTs, samma riktning) ⇒ bekräftad vändning, släpp.
    mockNow += 120000;
    expect(svc.shouldBlockStatus(MMSI, 'Järnvägsbron', 'waiting', 20, 2000)).toBe(false);
    expect(svc.shouldBlockStatus(MMSI, 'Järnvägsbron', 'approaching', 20, 2000)).toBe(false);
  });

  test('KONTRAKTET BEVARAT: utan cog och utan direction blockerar latchen konservativt', () => {
    svc.registerPassage(MMSI, 'Klaffbron', null);
    const latch = svc._passageLatches.get(MMSI).get('Klaffbron');
    expect(latch.direction).toBe(null);

    // Samma påstående som det befintliga kontraktstestet i
    // passage-latch-service-unit.test.js: osäker riktning släpper aldrig.
    expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting', 180, 1000)).toBe(true);
    expect(svc.shouldBlockStatus(MMSI, 'Klaffbron', 'waiting', 10, 2000)).toBe(true);
  });

  test('ANROPARENS BEVIS VINNER: cog får aldrig skriva över en given riktning', () => {
    // Korsningsbeviset säger north; kursen pekar söderut (båten kan ha girat
    // efter passagen). Beviset är starkare och ska stå kvar.
    svc.registerPassage(MMSI, 'Klaffbron', 'north', 250);
    const latch = svc._passageLatches.get(MMSI).get('Klaffbron');
    expect(latch.direction).toBe('north');
  });

  test('OGILTIG COG ger fortsatt null — ingen riktning uppfinns ur brus', () => {
    for (const cog of [null, undefined, Number.NaN, 'söderut', 90, 134, 315]) {
      svc.registerPassage(MMSI, 'Olidebron', null, cog);
      const latch = svc._passageLatches.get(MMSI).get('Olidebron');
      // 90/134 (öst) och 315 (norrgränsen är 315–45 ⇒ 315 är north) prövas
      // separat nedan; här gäller att inget SYDVÄRDE uppfinns.
      if (cog === 315) expect(latch.direction).toBe('north');
      else expect(latch.direction).toBe(null);
      svc.clearLatch(MMSI, 'Olidebron');
    }
  });

  test('BÅDA BANDEN: hela 226–314 lagras nu som south i stället för null', () => {
    // Klassen som var helt utan riktning före fixen — 89 hela grader.
    for (let cog = 226; cog <= 314; cog += 1) {
      svc.registerPassage(MMSI, 'Stridsbergsbron', null, cog);
      const latch = svc._passageLatches.get(MMSI).get('Stridsbergsbron');
      expect(latch.direction).toBe('south');
      svc.clearLatch(MMSI, 'Stridsbergsbron');
    }
  });

  test('SYMMETRIN LÅST: skrivningen och läsningen använder samma band', () => {
    // Invarianten som gör att asymmetrin inte kan glida isär igen: för varje
    // COG ska den LAGRADE riktningen vara exakt den läsningen skulle härleda.
    for (let cog = 0; cog < 360; cog += 1) {
      svc.registerPassage(MMSI, 'Klaffbron', null, cog);
      const latch = svc._passageLatches.get(MMSI).get('Klaffbron');
      expect(latch.direction).toBe(svc._directionFromCog(cog));
      svc.clearLatch(MMSI, 'Klaffbron');
    }
  });
});
