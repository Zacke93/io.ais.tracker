'use strict';

jest.mock('homey');

/**
 * M9 (helkodsgranskning RUNDA 4, 2026-08-23) — idle-decayns golv fabricerade
 * "strax" utanför imminent-radien.
 * M9b (fixrunda 4b, 2026-08-23) — GOLVETS PREDIKAT ÄR FLAGGAN, INTE EN KOPIA.
 *
 * FYNDET: _applyIdleDecay tvingar ned ETA:n med upp till 3 min per cykel enbart
 * på VÄGGTID för status waiting/approaching/stallbacka-waiting, utan att fråga
 * om båten rört sig. Enda spärren är E-F7:s distansgolv
 * `currentDistance / 123,5 m·min⁻¹`. Det golvet ligger UNDER strax-tröskeln
 * (3 min) för allt närmare än ~370 m, så tillsammans med wait-clampen blev
 * ETA:n en enkelriktad ratchet ned i strax-bandet — utan att imminent-flaggan
 * någonsin godkänt det.
 * Fältbevis: FARUREJ 261005370 publicerar "strax" på 354–357 m och passerar
 * aldrig; KAIKO 244820633 (20260610-19h) och CYGNUS 265822250 (20260804-17h)
 * står 7 respektive 8 min i bandet med sann tid till passage 20–28 min.
 *
 * FIXENS FÖRSTA VERSION jämförde rått avstånd mot en LOKAL kopia av
 * imminent-radien (300 m). Den kopian saknade hysteresen som den riktiga
 * flaggan bär — app.js sätter `_isImminentAtTargetBridge` vid ≤ 300 m men
 * släpper den först över 350 m (P1-3, införd exakt för att en hård gräns fick
 * en ködrivande båt att flappa "strax" ↔ "om N minuter" per tick). Kopian
 * återinförde alltså flappningen en nivå ned: 299 m gav "strax", 301 m gav
 * "om 3 minuter".
 *
 * M9b: golvet läser FLAGGAN. Den bär hysteresen OCH är det semantiskt rätta
 * predikatet — när flaggan är sann äger imminent-grenen i
 * formatETABroOpeningClause "strax"-klausulen oavsett ETA (Fix H), så golvet
 * kan ändå aldrig ändra vad användaren läser. Är flaggan falsk är "strax" en
 * ren ETA-utsaga, och det är precis då den tvingade decayn inte får fabricera
 * den.
 *
 * MÄTT (ON/OFF i två isolerade träd, alla 18 korpusar): replay:all,
 * runOpeningGates, runSyntheticScenarios, runFusionCorpora och measure:eta är
 * BYTE-IDENTISKA mellan rådistans- och flaggversionen, liksom fassvepen på
 * 20260702-2h (25 avvikelser) och 20260610-19h (59). Predikaten skiljer sig i
 * exakt TVÅ av 179 anrop över hela underlaget, och båda ligger där flaggan
 * äger texten ändå: LYS 211321210 på 336 m med flaggan HÅLLEN av hysteresen,
 * och ANYA ELAN 380 265705550 på 66 m med flaggan släckt av en skyddsgrind.
 *
 * Sviten låser: flaggan som predikat, hysteresbandets knivsegg (och att den
 * gamla rådistansregeln HADE flappat där), att fysikgolvet fortfarande vinner
 * längre bort, att stallbacka-fallet (ER2-1) är oförändrat, att ändringen
 * aldrig lyfter en siffra över den ETA beräkningen själv gav — samt att
 * radiekopian inte kan återuppstå i filen.
 *
 * 4c (2026-08-23) — FÄLTLISTVAKTEN, sist i filen. M9b gjorde golvet beroende
 * av ett FARTYGSFÄLT, och granskaren mätte att hela jest-sviten (3199 tester)
 * förblev grön när fältet ströks ur VesselDataService `_createVesselObject` —
 * bara replay:all fällde mutanten. Vakten kör den riktiga vägen
 * (`updateVessel` → objektbygget) och kräver att fältet överlever, plus att
 * kalkylatorn läser det överlevande värdet.
 */

const fs = require('fs');
const path = require('path');
const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const VesselDataService = require('../lib/services/VesselDataService');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { formatETABroOpeningClause } = require('../lib/utils/etaValidation');
const { BRIDGES } = require('../lib/constants');

global.__TEST_MODE__ = true;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

const PHYSICS_FLOOR_M_PER_MIN = 4 * 0.5144 * 60; // ≈123,5 m/min (E-F7:s rask kanalfart)

/**
 * Bygg det scenario fyndet beskriver: en STILLALIGGARE i väntläge vars förra
 * publicerade ETA var `prevETA`, en cykel sedan, på `distanceM` från målbron.
 * Rå-ETA:n in är densamma som förra värdet (fartgolvet 0,5 kn fabricerar ett
 * stabilt tal) — det är den TVINGADE decayn som sänker.
 * Cykeln är 3 min så `expectedDecay` når sitt tak 3 min/cykel och 4 − 3 = 1
 * hamnar UNDER golvet: då är det golvet ensamt som avgör utfallet, vilket är
 * precis det fyndet gäller.
 *
 * `imminent` speglar app.js `_isImminentAtTargetBridge` — undefined betyder
 * "fältet aldrig satt", vilket är samma sak som falskt för grinden.
 */
function idleDecayAt(calc, distanceM, {
  prevETA = 4, etaIn = 4, status = 'waiting', ageMs = 3 * 60 * 1000, sog = 0.1,
  imminent, mmsi,
} = {}) {
  const key = mmsi || `26100${Math.round(distanceM)}`;
  calc._recordETAHistory(key, {
    rawETA: prevETA,
    protectedETA: prevETA,
    processedETA: prevETA,
    timestamp: Date.now() - ageMs,
    targetBridge: 'Klaffbron',
    nearestBridge: null,
    vesselSpeed: sog,
    distance: distanceM,
    distanceToTarget: distanceM,
    vesselStatus: status,
  });
  const vessel = { mmsi: key, status, sog };
  if (imminent !== undefined) vessel._isImminentAtTargetBridge = imminent;
  return calc._applyIdleDecay(vessel, etaIn, calc._etaHistory.get(key), Date.now(), distanceM);
}

describe('M9/M9b: idle-decayns golv lovar inte "strax" utan imminent-flaggan', () => {
  let calc;

  beforeEach(() => {
    calc = new ProgressiveETACalculator(makeLogger(), new BridgeRegistry());
  });

  afterEach(() => calc.destroy());

  test('SSOT-koppling: 3 minuter renderas INTE som "strax", 2,9 gör det', () => {
    // Golvet i M9 är värdelöst om renderaren flyttar sin gräns. Den här raden
    // är kopplingen mellan de två filerna, inte en tautologi.
    expect(formatETABroOpeningClause(2.9)).toBe('beräknad broöppning strax');
    expect(formatETABroOpeningClause(3)).toBe('beräknad broöppning om 3 minuter');
  });

  test('FARUREJ-bandet 354 m UTAN flagga: decayn stannar på strax-tröskeln i stället för 2,87', () => {
    const r = idleDecayAt(calc, 354, { imminent: false });
    // Fysikgolvet ensamt: 354 / 123,456 ≈ 2,87 min ⇒ "strax".
    expect(354 / PHYSICS_FLOOR_M_PER_MIN).toBeLessThan(3);
    expect(r).toBeCloseTo(3, 5);
    expect(formatETABroOpeningClause(r)).toBe('beräknad broöppning om 3 minuter');
  });

  test('SAKNAT FÄLT räknas som "inte imminent" (flaggan sätts först i app.js)', () => {
    // Ett fartygsobjekt som ännu inte passerat _reevaluateVesselStatuses bär
    // inget fält alls. Golvet MÅSTE gälla där — annars är fixen avstängd för
    // varje båts första beräkningscykel.
    const r = idleDecayAt(calc, 354, { imminent: undefined });
    expect(r).toBeCloseTo(3, 5);
  });

  test('M9b: FLAGGAN ÄGER KLAUSULEN — 354 m MED flaggan satt ⇒ golvet lyfts inte', () => {
    // Uppmätt klass: LYS 211321210 stod på 336 m med flaggan hållen av
    // hysteresen. Där äger imminent-grenen texten oavsett siffra, så golvet
    // har ingenting att skydda mot.
    const r = idleDecayAt(calc, 354, { imminent: true });
    expect(r).toBeCloseTo(354 / PHYSICS_FLOOR_M_PER_MIN, 5);
    expect(r).toBeLessThan(3);
    expect(formatETABroOpeningClause(r, { imminent: true })).toBe('beräknad broöppning strax');
  });

  test('M9b: HYSTERESBANDET — 299/301/336 m med hållen flagga ger IDENTISKT utfall', () => {
    // KNIVSEGGEN. app.js sätter flaggan vid ≤300 m och släpper den först över
    // 350 m; en båt som driver i bandet bär alltså flaggan hela vägen. Med
    // flaggan som predikat är utfallet detsamma på båda sidor om 300.
    const held = [299, 301, 336].map((d) => idleDecayAt(calc, d, {
      imminent: true, mmsi: `2110000${d}`,
    }));
    held.forEach((r, i) => {
      expect(r).toBeCloseTo([299, 301, 336][i] / PHYSICS_FLOOR_M_PER_MIN, 5);
      expect(r).toBeLessThan(3);
    });
    // FALSIFIERING AV DEN GAMLA REGELN: rådistanskopian (>= 300 ⇒ golv 3)
    // hade gett 2,42 på 299 m men 3,0 på 301 och 336 — alltså en textväxling
    // "strax" ↔ "om 3 minuter" mitt i bandet. Det är fyndets hela mekanism.
    const oldRule = (d) => Math.max(d / PHYSICS_FLOOR_M_PER_MIN, d >= 300 ? 3 : 0);
    expect(formatETABroOpeningClause(oldRule(299)))
      .not.toBe(formatETABroOpeningClause(oldRule(301)));
  });

  test('M9b: flaggan SLÄCKT innanför 300 m ⇒ golvet gäller ändå', () => {
    // Uppmätt klass: ANYA ELAN 380 (265705550) på 66 m med flaggan släckt av
    // en av app.js skyddsgrindar (gammal AIS, GPS-hold, ogiltig målbro). Då är
    // "strax" en ren ETA-utsaga igen och den tvingade decayn får inte lova den.
    const r = idleDecayAt(calc, 66, { imminent: false });
    expect(r).toBeCloseTo(3, 5);
    expect(66 / PHYSICS_FLOOR_M_PER_MIN).toBeLessThan(1);
  });

  test('bandets övre kant 400 m: fysikgolvet vinner fortfarande', () => {
    const r = idleDecayAt(calc, 400, { imminent: false });
    expect(r).toBeCloseTo(400 / PHYSICS_FLOOR_M_PER_MIN, 5);
    expect(r).toBeGreaterThan(3);
  });

  test('ER2-1 står kvar: stallbacka-waiting på 2400 m golvas av fysiken (~19,5)', () => {
    const r = idleDecayAt(calc, 2400, {
      prevETA: 21, etaIn: 21, status: 'stallbacka-waiting', sog: 0.4, imminent: false,
    });
    expect(r).toBeGreaterThan(15);
  });

  test('golvet lyfter aldrig ÖVER den ETA beräkningen själv gav', () => {
    // eta in ligger redan under strax-tröskeln: decayn ska lämna den ifred,
    // inte lyfta den till 3. (Golvet HÖJER visserligen en decayad siffra upp
    // TILL tröskeln — det är den uppmätta facitrörelsen — men aldrig förbi
    // `eta`, eftersom raden bara tillämpas när `decayedETA < eta`.)
    const r = idleDecayAt(calc, 354, { prevETA: 4, etaIn: 2.5, imminent: false });
    expect(r).toBe(2.5);
  });

  test('äkta nedräkning bevaras: 12 min på 354 m sjunker fortfarande (till 9)', () => {
    // TIM-klassen (212571000, sog 0 på 303 m i 6 min och passerar sedan) ska
    // fortsätta räkna ner — fixen stoppar bara sista biten in i strax-bandet.
    const r = idleDecayAt(calc, 354, { prevETA: 12, etaIn: 12, imminent: false });
    expect(r).toBeCloseTo(9, 5);
  });

  test('approaching-status omfattas också', () => {
    const r = idleDecayAt(calc, 330, { status: 'approaching', imminent: false });
    expect(r).toBeCloseTo(3, 5);
  });

  test('SSOT-VAKT: filen bär ingen egen kopia av imminent-radien', () => {
    // Regressionslås mot att någon skriver tillbaka `IMMINENT_RADIUS_M = 300`
    // (eller hysteresens 350). Radien, hysteresen och skyddsgrindarna ägs av
    // app.js `_reevaluateVesselStatuses`; den här filen konsumerar BESLUTET.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'lib', 'services', 'ProgressiveETACalculator.js'),
      'utf8',
    );
    const code = src.split('\n')
      .map((line) => line.replace(/\s*\/\/.*$/, ''))
      .filter((line) => !/^\s*\*/.test(line) && !/^\s*\/\*/.test(line))
      .join('\n');
    expect(code).not.toMatch(/\b3[05]0\b/);
    expect(code).toContain('_isImminentAtTargetBridge');
  });
});

describe('M9b FÄLTLISTVAKT: flaggan måste överleva VesselDataService objektbygge', () => {
  // FYNDET (granskare 4b, mätt): M9b gjorde golvet beroende av FARTYGSFÄLTET
  // `_isImminentAtTargetBridge`. Granskaren strök raden som kopierar fältet i
  // `_createVesselObject` — och HELA jest-sviten (198 sviter, 3199 tester)
  // förblev grön. Först replay:all fällde mutanten. Effekten i produktion:
  // fältet blir `undefined` på VARJE nytt AIS-meddelande, villkoret
  // `!== true` blir sant för alla fartyg, och golvet lyfts alltid till
  // strax-tröskeln — dvs. varje idle-decayad ETA fastnar på minst 3 minuter,
  // också för de båtar M9b uttryckligen skulle lämna ifred.
  //
  // Projektet har felklassen bokförd som ÅTERKOMMANDE (fältlistoffer 8 och 9,
  // helgranskningen 2026-07-06; echo-scenariot 2026-07-02b är just den här
  // radens ursprung). Den befintliga fältlistvakten täcker en ANNAN lista
  // (brotextprojektionen), och sviten ovan bygger sina fartyg som objekt-
  // literaler — därför kan ingen av dem se bortfallet.
  //
  // VAKTEN GÅR DEN RIKTIGA VÄGEN: `updateVessel` → `_createVesselObject`,
  // samma väg som ett AIS-meddelande, och kräver dels att fältet överlever
  // ombyggnaden, dels att kalkylatorn faktiskt läser det överlevande värdet.
  const QUAY_N_KLAFF = {
    lat: BRIDGES.klaffbron.lat + 350 / 111320, // ~350 m norr om Klaffbron
    lon: BRIDGES.klaffbron.lon,
  };
  const MMSI = '265111222';

  let svc;
  let calc;

  beforeEach(() => {
    svc = new VesselDataService(makeLogger(), new BridgeRegistry(), new SystemCoordinator(makeLogger()));
    svc.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    calc = new ProgressiveETACalculator(makeLogger(), new BridgeRegistry());
  });

  afterEach(() => {
    try {
      svc.clearAllTimers();
    } catch (_) { /* tomt */ }
    calc.destroy();
  });

  function send(tsOffsetMs, extra2 = {}) {
    svc.updateVessel(MMSI, {
      mmsi: MMSI,
      lat: QUAY_N_KLAFF.lat,
      lon: QUAY_N_KLAFF.lon,
      sog: 0.2,
      cog: 180,
      name: 'FÄLTVAKT',
      timestamp: Date.now() + tsOffsetMs,
      ...extra2,
    });
    return svc.vessels.get(MMSI);
  }

  test('objektbygget är verkligt: nytt meddelande ger ett NYTT fartygsobjekt', () => {
    // Utan den här raden vore hela vakten en tautologi — den skulle passera
    // även om `updateVessel` muterade samma objekt i stället för att bygga om.
    const v1 = send(0);
    const v2 = send(10000);
    expect(v1).toBeTruthy();
    expect(v2).not.toBe(v1);
  });

  test('imminent-flaggan överlever ombyggnaden (fältlistan i _createVesselObject)', () => {
    send(0);
    // app.js `_reevaluateVesselStatuses` äger skrivningen — här speglas den.
    svc.vessels.get(MMSI)._isImminentAtTargetBridge = true;
    const v2 = send(10000);
    expect(v2._isImminentAtTargetBridge).toBe(true);
    // Och den nollställs INTE av ett tredje meddelande heller.
    expect(send(20000)._isImminentAtTargetBridge).toBe(true);
  });

  test('KOPPLINGEN TILL M9b: golvet läser det ÖVERLEVANDE värdet, inte undefined', () => {
    send(0);
    svc.vessels.get(MMSI)._isImminentAtTargetBridge = true;
    const vessel = send(10000);
    // Samma scenario som FARUREJ-testet ovan, men fartyget kommer nu ur
    // VesselDataService riktiga väg i stället för en objektliteral.
    calc._recordETAHistory(MMSI, {
      rawETA: 4,
      protectedETA: 4,
      processedETA: 4,
      timestamp: Date.now() - 3 * 60 * 1000,
      targetBridge: 'Klaffbron',
      nearestBridge: null,
      vesselSpeed: 0.2,
      distance: 354,
      distanceToTarget: 354,
      vesselStatus: 'waiting',
    });
    // Statusen sätts på DET RIKTIGA objektet — ingen spread-kopia, så det är
    // VesselDataService egen fältlista som matas in i kalkylatorn.
    vessel.status = 'waiting';
    const r = calc._applyIdleDecay(
      vessel, 4, calc._etaHistory.get(MMSI), Date.now(), 354,
    );
    // Med flaggan i behåll gäller fysikgolvet (~2,87) — INTE strax-tröskeln.
    // Stryks fältet ur fältlistan blir det undefined och r blir exakt 3.
    expect(r).toBeCloseTo(354 / PHYSICS_FLOOR_M_PER_MIN, 5);
    expect(r).toBeLessThan(3);
  });

  test('SSOT-VAKT: fältlistan i VesselDataService bär raden som ärver flaggan', () => {
    // Bältet till hängslet ovan: en läsbar, direkt peka-ut-vakt så att nästa
    // läsare ser VARFÖR raden finns när mutanten annars bara ger ett kryptiskt
    // ETA-tal. Kommentarer strippas så att en bortkommenterad rad inte räknas.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'lib', 'services', 'VesselDataService.js'),
      'utf8',
    );
    const code = src.split('\n')
      .map((line) => line.replace(/\s*\/\/.*$/, ''))
      .filter((line) => !/^\s*\*/.test(line) && !/^\s*\/\*/.test(line))
      .join('\n');
    expect(code).toMatch(/_isImminentAtTargetBridge:\s*oldVessel\?\._isImminentAtTargetBridge/);
  });
});
