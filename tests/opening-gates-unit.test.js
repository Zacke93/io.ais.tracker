'use strict';

/**
 * Enhetstester för ÖPPNINGSGRINDARNAS DOMARE (etapp 6, 2026-08-03).
 *
 * runOpeningGates.js dömer det proaktiva lagret: täckning (O1), fantomtak (O2)
 * och nattkontrakt (O3). Domarlogiken är precis lika farlig att ha otestad som
 * invarianterna var före 2026-07-06 — en klassificerare som accepterar allt
 * ser ut som "grönt över hela linjen". Varje test nedan asserterar åt BÅDA
 * hållen: att den fångar det som ska fångas OCH släpper det som är legitimt.
 *
 * Sampelformatet speglar korpusarnas jsonl: {mmsi, lat, lon, sog, aisTimestamp}.
 */

const {
  classifyMiss,
  classifyPhantom,
  analyseCoverage,
  analysePhantoms,
  analyseWarningAge,
  MIN_WARNABLE_MS,
  PHANTOM_WINDOW_MS,
  LATE_PASSAGE_WINDOW_MS,
  STALE_WARNING_AGE_MS,
  UNDERWAY_SOG_KN,
} = require('./replay-validation/runOpeningGates');
const { BRIDGES } = require('../lib/constants');

const KLAFF = BRIDGES.klaffbron;
const T0 = Date.UTC(2026, 7, 3, 10, 0, 0);
const M_PER_DEG_LAT = 111320;

/** Sampel `meters` SÖDER om Klaffbron (rakt i lat) vid tiden t. */
function southOf(meters, t, sog = 4.0) {
  return {
    mmsi: '265000111',
    lat: KLAFF.lat - meters / M_PER_DEG_LAT,
    lon: KLAFF.lon,
    sog,
    aisTimestamp: t,
  };
}

function samplesOf(list, mmsi = '265000111') {
  return new Map([[mmsi, list]]);
}

function passage(t, overrides = {}) {
  return {
    mmsi: '265000111', bridge: 'Klaffbron', t, iso: new Date(t).toISOString(), ...overrides,
  };
}

function warning(t, overrides = {}) {
  return {
    t,
    iso: new Date(t).toISOString(),
    bridge: 'Klaffbron',
    direction: 'northbound',
    etaMin: 5,
    vesselCount: 1,
    leadVessel: 'TESTBÅT',
    leadMmsi: '265000111',
    mmsis: ['265000111'],
    firedBy: 'deadline',
    eventId: 'Klaffbron#1',
    distance: 900,
    success: true,
    ...overrides,
  };
}

// ===========================================================================
// O1 — MISSKLASSNINGEN
// ===========================================================================

describe('O1 classifyMiss: en OKLASSAD miss är den enda röda utgången', () => {
  test('TYST_I_HORISONTEN — inget sampel inom beväpningshorisonten före passagen', () => {
    const s = samplesOf([southOf(6000, T0 - 3600000, 5)]);
    const r = classifyMiss(passage(T0), s, null);
    expect(r.klass).toBe('TYST_I_HORISONTEN');
    expect(r.accepted).toBe(true);
    expect(r.bevis).toMatch(/0 sampel inom 2500 m/);
  });

  test('FÖRST_SEDD_FÖR_NÄRA — första fixet inne i horisonten ligger inom garantifönstret', () => {
    // Sedd 400 m från bron 60 s före passagen: ingen varning KAN gå ut med
    // den utlovade marginalen (180 s lead + 30 s tick).
    const s = samplesOf([southOf(400, T0 - 60000, 5)]);
    const r = classifyMiss(passage(T0), s, null);
    expect(r.klass).toBe('FÖRST_SEDD_FÖR_NÄRA');
    expect(r.accepted).toBe(true);
  });

  test('RÖRELSEBEVIS_FÖR_SENT — sedd i tid men kajstilla ända fram (NANNA-klassen)', () => {
    // 40 min stillaliggande 500 m från bron, sedan passage. Rörelsebeviset
    // (appens egen MOVEMENT_PROOF_SOG_KN) uppstår aldrig i tid.
    const list = [];
    for (let i = 40; i >= 1; i--) list.push(southOf(500, T0 - i * 60000, 0.05));
    const r = classifyMiss(passage(T0), samplesOf(list), null);
    expect(r.klass).toBe('RÖRELSEBEVIS_FÖR_SENT');
    expect(r.accepted).toBe(true);
    expect(r.bevis).toMatch(/kajliggarprofil/);
  });

  test('OKLASSAD — sedd i tid OCH i rörelse i tid, men varningen uteblev (RÖTT)', () => {
    const list = [];
    for (let i = 30; i >= 1; i--) list.push(southOf(100 * i, T0 - i * 60000, 4.5));
    const r = classifyMiss(passage(T0), samplesOf(list), null);
    expect(r.klass).toBe('OKLASSAD');
    expect(r.accepted).toBe(false);
  });

  test('fartgivarlös (sog=null) får rörelsebevis ur POSITIONSDELTAT', () => {
    // Utan positionsbenet hade varje sog-lös båt klassats som "kajliggare"
    // och missen bortförklarats — den klass som fällt fyra granskningsrundor.
    const list = [];
    for (let i = 30; i >= 1; i--) list.push({ ...southOf(80 * i, T0 - i * 60000), sog: null });
    const r = classifyMiss(passage(T0), samplesOf(list), null);
    expect(r.klass).toBe('OKLASSAD');
    expect(r.bevis).toMatch(/fartgivarlös/);
  });

  test('resefönstret: sampel FÖRE föregående passage räknas inte', () => {
    // Returresa: hon var i rörelse innan sin FÖRSTA passage, men efter den
    // låg hon stilla. Andra passagen ska klassas på ANDRA resans data.
    const first = T0 - 3 * 3600000;
    const list = [];
    for (let i = 30; i >= 1; i--) list.push(southOf(100 * i, first - i * 60000, 5));
    for (let i = 40; i >= 1; i--) list.push(southOf(500, T0 - i * 60000, 0.05));
    const r = classifyMiss(passage(T0), samplesOf(list), first);
    expect(r.klass).toBe('RÖRELSEBEVIS_FÖR_SENT');
  });

  test('garantifönstret är härlett ur konfigurationen, inte hårdkodat', () => {
    expect(MIN_WARNABLE_MS).toBe(180000 + 30000);
  });
});

// ===========================================================================
// O1 — TÄCKNINGSMATCHNINGEN
// ===========================================================================

describe('O1 analyseCoverage: varje passage måste ha SIN egen varning före', () => {
  test('varning före passagen med båten som medlem = täckt', () => {
    const res = {
      targetPassages: [passage(T0)],
      openingWarnings: [warning(T0 - 600000)],
      openingCoverage: [],
    };
    const a = analyseCoverage(res, samplesOf([]));
    expect(a.misses).toHaveLength(0);
    expect(a.covered[0].leadMs).toBe(600000);
    expect(a.covered[0].via).toBe('fired');
  });

  test('KONVOJTÄCKNING: båten var inte medlem vid avfyrningen men absorberades', () => {
    const res = {
      targetPassages: [passage(T0, { mmsi: '265000222' })],
      openingWarnings: [warning(T0 - 500000)], // mmsis = [265000111]
      openingCoverage: [{
        t: T0 - 200000, mmsi: '265000222', bridge: 'Klaffbron', eventId: 'Klaffbron#1', reason: 'absorbed',
      }],
    };
    const a = analyseCoverage(res, samplesOf([]));
    expect(a.misses).toHaveLength(0);
    expect(a.covered[0].via).toBe('konvoj');
    // Ledtiden mäts från VARNINGEN, inte från absorptionen.
    expect(a.covered[0].leadMs).toBe(500000);
  });

  test('varning EFTER passagen räknas aldrig som täckning', () => {
    const res = {
      targetPassages: [passage(T0)],
      openingWarnings: [warning(T0 + 60000)],
      openingCoverage: [],
    };
    const a = analyseCoverage(res, samplesOf([southOf(6000, T0 - 3600000)]));
    expect(a.covered).toHaveLength(0);
    expect(a.misses).toHaveLength(1);
  });

  test('returresan får INTE återanvända den första resans varning', () => {
    const second = T0 + 4 * 3600000;
    const res = {
      targetPassages: [passage(T0), passage(second)],
      openingWarnings: [warning(T0 - 600000)],
      openingCoverage: [],
    };
    const a = analyseCoverage(res, samplesOf([southOf(6000, T0 - 3600000)]));
    expect(a.covered).toHaveLength(1);
    expect(a.misses).toHaveLength(1);
    expect(a.misses[0].passage.t).toBe(second);
  });

  test('en annan bros varning täcker ingenting', () => {
    const res = {
      targetPassages: [passage(T0)],
      openingWarnings: [warning(T0 - 600000, { bridge: 'Stridsbergsbron' })],
      openingCoverage: [],
    };
    const a = analyseCoverage(res, samplesOf([southOf(6000, T0 - 3600000)]));
    expect(a.misses).toHaveLength(1);
  });
});

// ===========================================================================
// O1 — VARNINGENS ÅLDER VID PASSAGEN (V1, fältprovet 2026-11-13)
// ===========================================================================

describe('O1 analyseWarningAge: varnad är inte detsamma som varnad med färsk varning', () => {
  // Fältfallet i miniatyr: PRICKBJORN varnades 08:30 och passerade 12:35 utan
  // ny varning. analyseCoverage räknar passagen som täckt (ledtid 244,9 min),
  // medan O2 kallar samma varning FANTOM eftersom passagen kom efter
  // LATE_PASSAGE_WINDOW_MS. Måttet ska skilja de två fallen åt.
  test('gränsen är O2:s eget senpassagefönster (120 min), inte ett nytt tal', () => {
    expect(STALE_WARNING_AGE_MS).toBe(LATE_PASSAGE_WINDOW_MS);
    expect(STALE_WARNING_AGE_MS).toBe(120 * 60000);
  });

  test('en 245 min gammal varning är täckning i O1 men redovisas som gammal', () => {
    const res = {
      targetPassages: [passage(T0)],
      openingWarnings: [warning(T0 - 245 * 60000)],
      openingCoverage: [],
    };
    const a = analyseCoverage(res, samplesOf([]));
    expect(a.covered).toHaveLength(1); // O1:s dom står kvar oförändrad
    const age = analyseWarningAge(a.covered);
    expect(age.total).toBe(1);
    expect(age.fresh).toBe(0);
    expect(age.stale).toHaveLength(1);
    expect(age.stale[0].ageMs).toBe(245 * 60000);
    expect(age.bands).toEqual({ 60: 1, 120: 1, 240: 1 });
  });

  test('gränsen är exklusiv: exakt 120 min är färsk, 120 min + 1 ms är gammal', () => {
    const covered = [
      { passage: passage(T0), warning: warning(T0 - 120 * 60000), leadMs: 120 * 60000 },
      { passage: passage(T0 + 1), warning: warning(T0 - 120 * 60000), leadMs: 120 * 60000 + 1 },
    ];
    const age = analyseWarningAge(covered);
    expect(age.fresh).toBe(1);
    expect(age.stale.map((c) => c.ageMs)).toEqual([120 * 60000 + 1]);
  });

  test('en sen passage som O2 godtar (45 min) är fortfarande färsk', () => {
    const res = {
      targetPassages: [passage(T0)],
      openingWarnings: [warning(T0 - 45 * 60000)],
      openingCoverage: [],
    };
    const age = analyseWarningAge(analyseCoverage(res, samplesOf([])).covered);
    expect(age.fresh).toBe(1);
    expect(age.stale).toHaveLength(0);
    expect(age.bands).toEqual({ 60: 0, 120: 0, 240: 0 });
  });

  test('inferred-passage mäts från fönstrets början: den kortaste möjliga åldern', () => {
    // Korsningen ligger någonstans i [tFrom, tTo]. Bara om även tFrom ligger
    // mer än 120 min efter varningen är varningen bevisat gammal.
    const w = warning(T0 - 150 * 60000);
    const inWindow = {
      passage: passage(T0, { inferred: true, tFrom: T0 - 40 * 60000, tTo: T0 + 60000 }), warning: w, leadMs: 150 * 60000,
    };
    const after = {
      passage: passage(T0, { inferred: true, tFrom: T0 - 20 * 60000, tTo: T0 + 60000 }), warning: w, leadMs: 150 * 60000,
    };
    const age = analyseWarningAge([inWindow, after]);
    expect(age.stale.map((c) => c.ageMs)).toEqual([130 * 60000]);
    expect(age.fresh).toBe(1);
  });

  // Revision 1 (granskningen 2026-11-14): FILOU 20260806-42h vid Klaffbron var
  // medlem i Klaffbron#28 (173 min före passagen) men absorberades i
  // Klaffbron#37 (MISTRAL leder, kortet gick 8,9 min före passagen). O1 tar
  // den säkra fired-träffen och hoppar över konvojslingan; åldersmåttet ska
  // ändå räkna den FÄRSKASTE varning som täckte henne.
  test('FILOU: gammal fired-medlemskap plus färsk konvojabsorption är en färsk varning', () => {
    const res = {
      targetPassages: [passage(T0)],
      openingWarnings: [
        warning(T0 - 173 * 60000, { eventId: 'Klaffbron#28' }),
        warning(T0 - 9 * 60000, {
          eventId: 'Klaffbron#37', leadMmsi: '219025192', leadVessel: 'MISTRAL', mmsis: ['219025192'],
        }),
      ],
      openingCoverage: [{
        t: T0 - 8 * 60000, mmsi: '265000111', bridge: 'Klaffbron', eventId: 'Klaffbron#37', reason: 'absorbed',
      }],
    };
    const a = analyseCoverage(res, samplesOf([]));
    // O1:s egen dom och ledtid är orörda.
    expect(a.covered[0].warning.eventId).toBe('Klaffbron#28');
    expect(a.covered[0].leadMs).toBe(173 * 60000);
    const age = analyseWarningAge(a.covered);
    expect(age.fresh).toBe(1);
    expect(age.stale).toHaveLength(0);
  });

  test('åt andra hållet: en annan öppnings konvojvarning räknas inte som färsk täckning', () => {
    // Absorptionen gäller en händelse vars kort gick före en ANNAN båts passage
    // mer än ett konvojfönster före hennes egen: bron har öppnat och stängt
    // emellan, så den varningen täcker inte hennes öppning.
    const res = {
      targetPassages: [passage(T0), passage(T0 - 40 * 60000, { mmsi: '265999999' })],
      openingWarnings: [
        warning(T0 - 173 * 60000, { eventId: 'Klaffbron#28' }),
        warning(T0 - 50 * 60000, {
          eventId: 'Klaffbron#30', leadMmsi: '265999999', leadVessel: 'ANNAN', mmsis: ['265999999'],
        }),
      ],
      openingCoverage: [{
        t: T0 - 45 * 60000, mmsi: '265000111', bridge: 'Klaffbron', eventId: 'Klaffbron#30', reason: 'absorbed',
      }],
    };
    const a = analyseCoverage(res, samplesOf([]));
    const mine = a.covered.filter((c) => c.passage.mmsi === '265000111');
    const age = analyseWarningAge(mine);
    expect(age.stale.map((c) => c.ageWarning.eventId)).toEqual(['Klaffbron#28']);
  });

  test('åt andra hållet: en annan båts absorption räknas inte för henne', () => {
    const res = {
      targetPassages: [passage(T0)],
      openingWarnings: [
        warning(T0 - 173 * 60000, { eventId: 'Klaffbron#28' }),
        warning(T0 - 9 * 60000, {
          eventId: 'Klaffbron#37', leadMmsi: '219025192', leadVessel: 'MISTRAL', mmsis: ['219025192'],
        }),
      ],
      openingCoverage: [{
        t: T0 - 8 * 60000, mmsi: '265999999', bridge: 'Klaffbron', eventId: 'Klaffbron#37', reason: 'absorbed',
      }],
    };
    const age = analyseWarningAge(analyseCoverage(res, samplesOf([])).covered);
    expect(age.stale).toHaveLength(1);
    expect(age.stale[0].ageMs).toBe(173 * 60000);
  });

  test('en färsk egen avfyrning efter en gammal räknas, även när O1 redan valt den senaste', () => {
    const res = {
      targetPassages: [passage(T0)],
      openingWarnings: [
        warning(T0 - 173 * 60000, { eventId: 'Klaffbron#28' }),
        warning(T0 - 5 * 60000, { eventId: 'Klaffbron#40' }),
      ],
      openingCoverage: [],
    };
    const age = analyseWarningAge(analyseCoverage(res, samplesOf([])).covered);
    expect(age.fresh).toBe(1);
  });

  // Rev 2 (omgranskningen 2026-11-14): ett kort som aldrig gick fram
  // (success=false) är ingen varning för användaren. Det får inte göra en
  // passage "färsk"; den redovisas separat som OLEVERERAD.
  test('ett olevererat kort räknas inte som färsk täckning', () => {
    const res = {
      targetPassages: [passage(T0)],
      openingWarnings: [warning(T0 - 5 * 60000, { success: false, error: 'kortet kastade' })],
      openingCoverage: [],
    };
    const a = analyseCoverage(res, samplesOf([]));
    expect(a.covered).toHaveLength(1); // O1 är orört (ärvt beteende)
    const age = analyseWarningAge(a.covered);
    expect(age.total).toBe(1);
    expect(age.fresh).toBe(0);
    expect(age.stale).toHaveLength(0);
    expect(age.undelivered).toHaveLength(1);
    expect(age.bands).toEqual({ 60: 0, 120: 0, 240: 0 });
  });

  test('en levererad äldre varning räknas när den färskare aldrig gick fram', () => {
    const res = {
      targetPassages: [passage(T0)],
      openingWarnings: [
        warning(T0 - 150 * 60000, { eventId: 'Klaffbron#1' }),
        warning(T0 - 5 * 60000, { eventId: 'Klaffbron#2', success: false, error: 'kortet kastade' }),
      ],
      openingCoverage: [],
    };
    const age = analyseWarningAge(analyseCoverage(res, samplesOf([])).covered);
    expect(age.undelivered).toHaveLength(0);
    expect(age.stale.map((c) => c.ageWarning.eventId)).toEqual(['Klaffbron#1']);
  });

  test('egen gräns kan anges för mätning (rapporten skriver ut banden 60/120/240)', () => {
    const covered = [
      { passage: passage(T0), warning: warning(T0 - 70 * 60000), leadMs: 70 * 60000 },
    ];
    expect(analyseWarningAge(covered, 60 * 60000).stale).toHaveLength(1);
    expect(analyseWarningAge(covered).stale).toHaveLength(0);
  });
});

// ===========================================================================
// O2 — FANTOMKLASSNINGEN
// ===========================================================================

describe('O2 classifyPhantom: kajvobbel är rött, avbruten approach är accepterad', () => {
  test('KAJVOBBEL — stillaliggande båt utan närmande (RÖTT)', () => {
    const list = [];
    for (let i = 30; i >= 1; i--) list.push(southOf(800 + (i % 2) * 5, T0 - i * 60000, 0.2));
    const r = classifyPhantom(warning(T0), samplesOf(list));
    expect(r.klass).toBe('KAJVOBBEL');
    expect(r.accepted).toBe(false);
  });

  test('AVBRUTEN_APPROACH — mätbart närmande, sedan ingen passage (ACCEPTERAD)', () => {
    const list = [];
    for (let i = 20; i >= 1; i--) list.push(southOf(120 * i, T0 - i * 60000, 4.5));
    const r = classifyPhantom(warning(T0), samplesOf(list));
    expect(r.klass).toBe('AVBRUTEN_APPROACH');
    expect(r.accepted).toBe(true);
  });

  test('GLESHETSFÄLLAN (BRANIF-regressionen): ETT fix i 4,6 kn är inte kajvobbel', () => {
    // 211112870 levererade EXAKT ETT fix på 78 min, i 4,6 kn, 727 m från bron.
    // Nettonärmandet blir noll av ren sampelbrist. En klassificerare som bara
    // tittar på nettonärmande dömer henne som kajvobblare — och gör därmed
    // hela O2-grinden till en lögndetektor med fel polaritet.
    const r = classifyPhantom(warning(T0), samplesOf([southOf(727, T0 - 300000, 4.6)]));
    expect(r.klass).toBe('AVBRUTEN_APPROACH');
    expect(r.accepted).toBe(true);
    expect(r.bevis).toMatch(/1 sampel/);
  });

  test('transitgränsen är appens egen (QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN)', () => {
    expect(UNDERWAY_SOG_KN).toBe(1);
    // Precis under gränsen och utan förflyttning ⇒ fortfarande kajvobbel.
    const r = classifyPhantom(warning(T0), samplesOf([southOf(727, T0 - 300000, 0.9)]));
    expect(r.klass).toBe('KAJVOBBEL');
  });

  test('INGA_SAMPEL_FÖRE — varning utan ett enda underliggande fix (RÖTT)', () => {
    const r = classifyPhantom(warning(T0), new Map());
    expect(r.klass).toBe('INGA_SAMPEL_FÖRE');
    expect(r.accepted).toBe(false);
  });
});

describe('O2 analysePhantoms: tre hinkar — bekräftad, sen passage, fantom', () => {
  const movingSamples = () => {
    const list = [];
    for (let i = 20; i >= 1; i--) list.push(southOf(120 * i, T0 - i * 60000, 4.5));
    return samplesOf(list);
  };

  test('passage inom 20 min = BEKRÄFTAD', () => {
    const res = {
      openingWarnings: [warning(T0)],
      targetPassages: [passage(T0 + 10 * 60000)],
      intermediatePassages: [],
      openingCoverage: [],
    };
    const a = analysePhantoms(res, movingSamples());
    expect(a.confirmed).toBe(1);
    expect(a.latePassages).toHaveLength(0);
    expect(a.phantoms).toHaveLength(0);
  });

  test('passage efter 45 min = SEN_PASSAGE, inte fantom', () => {
    // Varningen ligger ofta långt före passagen: stopp och köer efter
    // varningen dominerar, deadline-motorns pessimism (10 kn) bidrar mindre
    // (helgranskningen 2026-11-03: 6 kn tog bort 17 av 118 sena). Ett
    // strikt 20-minutersfönster hade dömt hälften av alla KORREKTA varningar
    // som fantomer — mätt: 83 av 236 varningar över de 16 korpusarna.
    const res = {
      openingWarnings: [warning(T0)],
      targetPassages: [passage(T0 + 45 * 60000)],
      intermediatePassages: [],
      openingCoverage: [],
    };
    const a = analysePhantoms(res, movingSamples());
    expect(a.confirmed).toBe(0);
    expect(a.latePassages).toHaveLength(1);
    expect(a.latePassages[0].delayMs).toBe(45 * 60000);
    expect(a.phantoms).toHaveLength(0);
  });

  test('ingen passage alls = FANTOM och klassas', () => {
    const res = {
      openingWarnings: [warning(T0)], targetPassages: [], intermediatePassages: [], openingCoverage: [],
    };
    const a = analysePhantoms(res, movingSamples());
    expect(a.phantoms).toHaveLength(1);
    expect(a.phantoms[0].klass).toBe('AVBRUTEN_APPROACH');
  });

  test('INTERMEDIATE-bokförd målbrokorsning räknas som en verklig öppning', () => {
    // INV-13:s klass: en mållös båts målbropassage bokförs som intermediate.
    // Räknas den inte blir designenliga förlopp falska fantomer.
    const res = {
      openingWarnings: [warning(T0)],
      targetPassages: [],
      intermediatePassages: [passage(T0 + 5 * 60000)],
      openingCoverage: [],
    };
    const a = analysePhantoms(res, movingSamples());
    expect(a.confirmed).toBe(1);
    expect(a.phantoms).toHaveLength(0);
  });

  test('konvojmedlem som anslöt EFTER avfyrningen bekräftar också öppningen', () => {
    const res = {
      openingWarnings: [warning(T0)],
      targetPassages: [passage(T0 + 8 * 60000, { mmsi: '265000222' })],
      intermediatePassages: [],
      openingCoverage: [{
        t: T0 + 60000, mmsi: '265000222', bridge: 'Klaffbron', eventId: 'Klaffbron#1', reason: 'absorbed',
      }],
    };
    const a = analysePhantoms(res, movingSamples());
    expect(a.confirmed).toBe(1);
  });

  test('kontraktsfönstret är 20 min', () => {
    expect(PHANTOM_WINDOW_MS).toBe(20 * 60 * 1000);
  });
});
