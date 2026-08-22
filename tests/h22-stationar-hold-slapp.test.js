'use strict';

jest.mock('homey');

/**
 * H22 (helkodsgranskningen 2026-08-21/22) — stationär-holdens SLÄPP.
 *
 * MEKANISM FÖRE: _postTransitionStationaryHold prövade MOMENTAN sog mot 0,3 kn
 * på båda ställena i _getEffectiveSpeed: under tröskeln returnerades null
 * ("ETA okänd"), över den RADERADES holden permanent — innan farten ens
 * användes. Fartgolvet slår först vid 0,5 kn och filens EGEN rörelsedefinition
 * (fartgolvets allBufferedSlow) kräver 1,0 kn. Bandet 0,31–0,49 rev alltså
 * skyddet OCH publicerade golvfabrikatet i samma anrop; 0,50–0,99 rev det utan
 * att båten var rörlig ens enligt filens eget mått. Historiken är tömd av
 * transitionen, så varken EMA eller outlierfiltret hade någon baslinje att
 * kapa fabrikatet med.
 *
 * MEKANISM EFTER: samma predikat styr svaret och släppet — under
 * MOVEMENT_SOG_KNOTS (1,0) svarar holden "ETA okänd" och LEVER VIDARE; första
 * sampel med verklig rörelse (>= 1,0 kn) släpper den och numerisk ETA
 * återupptas med färsk baslinje.
 *
 * FÄLTFALLEN (rådataverifierade, båda låsta i golden-text):
 *   • AQUILA 265735370, korpus 20260601-41h (ais-replay-20260601-231305.jsonl):
 *     8,5 min AIS-glapp över Stridsbergsbron ⇒ target-transition armerar
 *     holden och tömmer baslinjen. 13:15:45 sog 0,4 ⇒ "om 71 minuter",
 *     13:16:45 sog 0,8 ⇒ "om 69 minuter", 13:17:47 sog 0,2 ⇒ "om 72 minuter".
 *     Sanning: hon låg still (13:38 och 13:43 sog 0,1 på samma position).
 *   • ELIZABETH GREENWOOD 265805640, korpus 20260713-41h: passerar Klaffbron,
 *     10:49:23 sog 0,8 ⇒ "om 33 minuter", 10:52:23 sog 0 ⇒ "om 37 minuter".
 *     Sanning: hon förtöjde på platsen (10:59:22 samma position, sog 0).
 *
 * MUTATIONSPROV: med släppet återställt till 0,3 (den gamla raden
 * `if (actualSpeed <= 0.3) { ...return null } delete(...)`) blir varje
 * "ETA okänd"-assertion i första och andra describe-blocket röd — 0,4- och
 * 0,8-samplen ger då exakt de facitlåsta talen 71 respektive 33 minuter, som
 * testerna nedan asserterar som FÖRE-värden i sina egna beräkningar.
 */

const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');

global.__TEST_MODE__ = true;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

// Broarnas riktiga koordinater (samma som i övriga sviter)
const KLAFFBRON = { name: 'Klaffbron', lat: 58.28409551543077, lon: 12.283929525245636 };
const STRIDSBERGSBRON = { name: 'Stridsbergsbron', lat: 58.29352, lon: 12.294323 };

const makeCalc = () => new ProgressiveETACalculator(makeLogger(), {
  getBridgeByName: (name) => (name === 'Stridsbergsbron' ? STRIDSBERGSBRON : KLAFFBRON),
  getBridgeById: (id) => (id === 'stridsbergsbron' ? STRIDSBERGSBRON : KLAFFBRON),
  getBridge: (id) => (id === 'stridsbergsbron' ? STRIDSBERGSBRON : KLAFFBRON),
  normalizeToId: (x) => (typeof x === 'string' ? x.toLowerCase() : x),
  getNameById: (id) => (id === 'stridsbergsbron' ? 'Stridsbergsbron' : 'Klaffbron'),
  getBridgesBetween: () => [],
  getDistanceBetweenBridges: () => 1300,
});

// AQUILA 13:15–13:17: söder om Stridsbergsbron, target Klaffbron (~1,1 km)
const aquila = (sog) => ({
  mmsi: '265735370',
  lat: 58.29264166666667,
  lon: 12.293511666666666,
  sog,
  cog: 55.5,
  targetBridge: 'Klaffbron',
});

// ELIZABETH GREENWOOD 10:49–10:52: norr om Klaffbron, target Stridsbergsbron (~0,8 km)
const elizabeth = (sog) => ({
  mmsi: '265805640',
  lat: 58.28755,
  lon: 12.28616,
  sog,
  cog: 3.7,
  targetBridge: 'Stridsbergsbron',
});

const armTransition = (calc, mmsi) => calc.clearVesselETAHistory(
  mmsi, 'target_transition_Stridsbergsbron_to_Klaffbron',
);

describe('H22: AQUILA-fabrikatet (20260601-41h, "om 71/69/72 minuter")', () => {
  let calc;

  beforeEach(() => {
    calc = makeCalc();
  });

  afterEach(() => {
    calc.destroy();
  });

  test('0,4 kn river INTE holden och publicerar inget golvfabrikat (FÖRE: "om 71 minuter")', () => {
    armTransition(calc, '265735370');

    // FÖRE-värdet, räknat ur samma geometri som fabrikatet: 0,5 kn-golvet
    // över ~1,1 km ⇒ ~71 min. Beviset att golvet SKULLE ha använts.
    expect(calc.calculateProgressiveETA(aquila(0.4), null)).toBeNull();

    // Holden lever vidare — den gamla koden raderade den här.
    expect(calc._postTransitionStationaryHold.has('265735370')).toBe(true);
  });

  test('hela sekvensen 0,4 → 0,8 → 0,2 ger "ETA okänd", inte 71/69/72 minuter', () => {
    armTransition(calc, '265735370');
    expect(calc.calculateProgressiveETA(aquila(0.4), null)).toBeNull();
    expect(calc.calculateProgressiveETA(aquila(0.8), null)).toBeNull();
    expect(calc.calculateProgressiveETA(aquila(0.2), null)).toBeNull();
    expect(calc._postTransitionStationaryHold.has('265735370')).toBe(true);
  });

  test('utan hold ger samma 0,4 kn-sampel fabrikatet ~71 min — golvet finns kvar, det är holden som skyddar', () => {
    // Kontrollen som visar att testet mäter HOLDEN och inte en ändrad geometri:
    // utan armering går samma sampel genom 0,5 kn-golvet till facitvärdet.
    const eta = calc.calculateProgressiveETA(aquila(0.4), null);
    expect(eta).not.toBeNull();
    expect(Math.round(eta)).toBe(71);
  });

  test('historiken förblir tom under holden — ingen förgiftad EMA-baslinje byggs', () => {
    armTransition(calc, '265735370');
    calc.calculateProgressiveETA(aquila(0.4), null);
    calc.calculateProgressiveETA(aquila(0.8), null);
    expect(calc._etaHistory.get('265735370')).toBeUndefined();
  });
});

describe('H22: ELIZABETH GREENWOOD-fabrikatet (20260713-41h, "om 33/37 minuter")', () => {
  let calc;

  beforeEach(() => {
    calc = makeCalc();
  });

  afterEach(() => {
    calc.destroy();
  });

  test('0,8 kn efter målbytet ger "ETA okänd" (FÖRE: "om 33 minuter")', () => {
    calc.clearVesselETAHistory('265805640', 'target_transition_Klaffbron_to_Stridsbergsbron');
    expect(calc.calculateProgressiveETA(elizabeth(0.8), null)).toBeNull();
    expect(calc.calculateProgressiveETA(elizabeth(0), null)).toBeNull();
    expect(calc._postTransitionStationaryHold.has('265805640')).toBe(true);
  });

  test('utan hold ger samma 0,8 kn-sampel facitvärdet ~33 min', () => {
    const eta = calc.calculateProgressiveETA(elizabeth(0.8), null);
    expect(eta).not.toBeNull();
    expect(Math.round(eta)).toBe(33);
  });
});

describe('H22: släppet följer filens egen rörelsedefinition (1,0 kn)', () => {
  let calc;

  beforeEach(() => {
    calc = makeCalc();
  });

  afterEach(() => {
    calc.destroy();
  });

  test.each([0.31, 0.4, 0.49, 0.5, 0.75, 0.99])(
    'sog %s kn (under rörelsedefinitionen) släpper INTE holden',
    (sog) => {
      armTransition(calc, '265735370');
      expect(calc._getEffectiveSpeed(aquila(sog))).toBeNull();
      expect(calc._postTransitionStationaryHold.has('265735370')).toBe(true);
    },
  );

  test('exakt 1,0 kn räknas som rörelse och släpper holden', () => {
    armTransition(calc, '265735370');
    expect(calc._getEffectiveSpeed(aquila(1.0))).toBeGreaterThan(0);
    expect(calc._postTransitionStationaryHold.has('265735370')).toBe(false);
  });

  test('släppt hold är verkligen släppt — efterföljande stillhet får golvet igen', () => {
    armTransition(calc, '265735370');
    expect(calc._getEffectiveSpeed(aquila(0.4))).toBeNull();
    expect(calc._getEffectiveSpeed(aquila(4.2))).toBeGreaterThan(0.5); // rörligt prov släpper
    expect(calc._getEffectiveSpeed(aquila(0.1))).not.toBeNull(); // holden är borta
  });

  test('INVARIANT: ingen sub-rörelsesekvens kan riva holden (10 sampel i bandet)', () => {
    armTransition(calc, '265735370');
    [0.4, 0.9, 0.2, 0.6, 0.35, 0.99, 0, 0.8, 0.5, 0.1].forEach((sog) => {
      expect(calc._getEffectiveSpeed(aquila(sog))).toBeNull();
    });
    expect(calc._postTransitionStationaryHold.has('265735370')).toBe(true);
  });
});

describe('H22: systerstället — armStationaryHold (eta_stale_hard) har samma släpp', () => {
  let calc;

  beforeEach(() => {
    calc = makeCalc();
  });

  afterEach(() => {
    calc.destroy();
  });

  test('hård-stale-holden överlever också sub-rörelsebandet', () => {
    calc.armStationaryHold('265735370', 'eta_stale_hard');
    expect(calc._getEffectiveSpeed(aquila(0.8))).toBeNull();
    expect(calc._postTransitionStationaryHold.has('265735370')).toBe(true);
    expect(calc._getEffectiveSpeed(aquila(3.5))).toBeGreaterThan(0.5);
    expect(calc._postTransitionStationaryHold.has('265735370')).toBe(false);
  });
});

describe('H22: bevarade grannbeteenden (får INTE ändras av fixen)', () => {
  let calc;

  beforeEach(() => {
    calc = makeCalc();
  });

  afterEach(() => {
    calc.destroy();
  });

  test('sog=null (CG2-7) svarar null FÖRE hold-blocket och rör inte holden', () => {
    armTransition(calc, '265735370');
    expect(calc._getEffectiveSpeed(aquila(null))).toBeNull();
    expect(calc._postTransitionStationaryHold.has('265735370')).toBe(true);
  });

  test('kö-/SPIKEN-klassen (none_to_X armerar aldrig) behåller sitt golv-ETA vid 0,8 kn', () => {
    calc.clearVesselETAHistory('265735370', 'target_bridge_change_none_to_Klaffbron');
    expect(calc._getEffectiveSpeed(aquila(0.8))).toBe(0.8);
    expect(calc._getEffectiveSpeed(aquila(0.1))).toBeGreaterThan(0);
  });

  test('fartgolvets rörelsedefinition är oförändrad: buffert med ett 1,0-sampel räknas som rörlig', () => {
    // Passagekontext + rörlig buffert ⇒ 2,5 kn-golvet (MIN_PASSAGE_ROUTE_SPEED)
    const v = {
      ...aquila(1.2),
      lastPassedBridge: 'Stridsbergsbron',
      lastPassedBridgeTime: Date.now() - 60 * 1000,
    };
    expect(calc._getEffectiveSpeed(v)).toBe(2.5);
  });
});
