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
  MIN_WARNABLE_MS,
  PHANTOM_WINDOW_MS,
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
    // Deadline-motorns pessimism (10 kn mot uppmätt median 3,13 kn) gör att
    // varningen normalt ligger 3× längre före passagen än ledtiden. Ett
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
