'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { TRIGGER_POINTS } = require('../lib/constants');

/**
 * =============================================================================
 * H16 (helkodsgranskning 2026-08-22) — REDAN-PASSERAD-VAKT FÖR TRIGGER-PUNKTEN
 * =============================================================================
 *
 * FÄLTFALLET. Kandidatpushen för trigger-punkten (_getFlowTriggerCandidates)
 * prövar avstånd och FP8/FP9-gaterna — aldrig vilken SIDA av Kanalinfarten
 * båten är på. En sydgående som redan lämnat punkten fick därför
 * FÖRVARNINGSTEXT ("närmar sig Kanalinfarten, beräknad ankomst om N minuter")
 * och en ETA räknad som avstånd/fart mot en punkt hon rör sig BORT ifrån.
 * 13 uppmätta fältinstanser över ~320 h (ATHENA, MILES2GO, PILOT 761,
 * CAPELLA, WILHELM THAM, JUNO, CALIMA m.fl.).
 *
 * ASYMMETRIN som är hela fyndet: exit-vägen (_triggerExitPointFallback) HAR
 * vakten — `if (vessel.lat < kanalinfarten.lat) return;` med kommentaren
 * "Söder om → redan passerad". Live-vägen saknade den helt.
 *
 * VAD FIXEN FÅR RÖRA (och inte):
 *   • eta ⇒ -1, already_passed ⇒ true, message ⇒ passerad-form.
 *   • KÄLLSTRÄNGEN är orörd. _isRetroactiveNotificationSource matas även till
 *     dedupen (retroactiveSource), där true kan BLOCKERA notiser, och dess
 *     värde för 'trigger-point' är låst i paket-p8-retro-notistext.
 *   • DISTANSEN är orörd — INV-11:s 400 m-gräns läser den i svepfallet.
 *
 * BEVISKRAVET är strängare än "fel sida", och det är mätdrivet: i korpusdatan
 * ligger 2 115 stillaliggande positionsrapporter (sog < 0,5) NORR om punkten
 * och 3 717 SÖDER om den, inom 300 m. Det finns liggplatser på BÅDA sidor, så
 * en kajstartare som lägger ut från den sida hon redan står på har aldrig
 * passerat något — och får inte påstås ha gjort det.
 */

const TP = TRIGGER_POINTS.kanalinfarten;
const METER = 1 / 111320; // grader latitud per meter (lokalt)

const CANDIDATE = (overrides = {}) => ({
  name: TP.name,
  id: 'kanalinfarten',
  distance: 250,
  source: 'trigger-point',
  ...overrides,
});

const makeApp = (direction = 'southbound') => {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  app._triggeredBoatNearKeys = new Set();
  app._persistentRecentTriggers = new Map();
  app._persistRecentTriggers = jest.fn();
  app._getDirectionString = jest.fn(() => direction);
  app._dedupDirection = jest.fn(() => (direction === 'southbound' ? 'south' : 'north'));
  app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
  return app;
};

const fire = async (app, vessel, candidate = CANDIDATE()) => {
  await app._triggerBoatNearFlowForBridge(vessel, candidate);
  const call = app._triggerBoatNearFlowBest.mock.calls[0];
  return { tokens: call && call[0], state: call && call[1] };
};

// Sydgående som KOM UPPIFRÅN (episodstart norr om punkten) och nu ligger
// söder om den — exakt fältfallet.
const passeradSydgaende = (overrides = {}) => ({
  mmsi: '265111001',
  name: 'ATHENA',
  sog: 5,
  cog: 190,
  lat: TP.lat - 200 * METER,
  lon: TP.lon,
  _firstSeenLat: TP.lat + 900 * METER,
  passedBridges: ['Olidebron'],
  etaMinutes: null,
  ...overrides,
});

// =============================================================================
// 1. FÄLTFALLET
// =============================================================================
describe('H16: sydgående som lämnat Kanalinfarten', () => {
  test('MUTATIONSPROVET: eta -1, already_passed true, ingen "närmar sig"', async () => {
    const app = makeApp('southbound');
    const { tokens } = await fire(app, passeradSydgaende());

    // Utan vakten: eta = 250 m / (5 kn) ≈ 1,6 min ⇒ tokenen bar 2.
    expect(tokens.eta_minutes).toBe(-1);
    expect(tokens.eta_available).toBe(false);
    expect(tokens.already_passed).toBe(true);
    expect(tokens.message).toBe('ATHENA har passerat Kanalinfarten');
    expect(tokens.message).not.toMatch(/närmar sig/);
    expect(tokens.message).not.toMatch(/beräknad ankomst/);
  });

  test('FACITBÄRARNA och källan står HELT still', async () => {
    const app = makeApp('southbound');
    const { tokens, state } = await fire(app, passeradSydgaende());

    // Fördelningsmultiseten läser bridge_name, riktningsmultiseten direction.
    expect(tokens.bridge_name).toBe('Kanalinfarten');
    expect(tokens.direction).toBe('söderut');
    // Källsträngen bär dedupens semantik och INV-11:s klassindelning.
    expect(state.source).toBe('trigger-point');
    expect(state.distance).toBe(250);
    expect(app._isRetroactiveNotificationSource('trigger-point')).toBe(false);
    // Notisen SKICKAS fortfarande — vakten byter text, den filtrerar inte.
    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
  });

  test('dedup-nycklarna är oförändrade (session + persistent)', async () => {
    const app = makeApp('southbound');
    await fire(app, passeradSydgaende());

    expect([...app._triggeredBoatNearKeys]).toEqual(['265111001:Kanalinfarten']);
    const entry = app._persistentRecentTriggers.get('265111001:Kanalinfarten');
    expect(entry).toBeTruthy();
    expect(entry.dir).toBe('south');
  });

  test('återfödd båt UTAN passerade broar men med episodstart norr om punkten', async () => {
    const app = makeApp('southbound');
    const { tokens } = await fire(app, passeradSydgaende({
      mmsi: '265111002', name: 'MILES2GO', passedBridges: [],
    }));

    expect(tokens.already_passed).toBe(true);
    expect(tokens.eta_minutes).toBe(-1);
  });

  test('återfödd båt vars episodankare hamnat SÖDER om punkten räddas av passerad bro', async () => {
    const app = makeApp('southbound');
    const { tokens } = await fire(app, passeradSydgaende({
      mmsi: '265111003',
      name: 'JUNO',
      _firstSeenLat: TP.lat - 150 * METER,
      passedBridges: ['Olidebron', 'Klaffbron'],
    }));

    expect(tokens.already_passed).toBe(true);
  });
});

// =============================================================================
// 2. SVEPGRENEN — per konstruktion efterhandsdetektion
// =============================================================================
describe('H16: segmentsvepet (FP7-3/CALIMA) är alltid redan passerad', () => {
  test('svepflaggan räcker som bevis — genomkorsningen är OBSERVERAD', async () => {
    const app = makeApp('southbound');
    // Svepet kräver crossedLatitude, dvs. sampelparet ligger på var sin sida.
    const { tokens, state } = await fire(app, passeradSydgaende({
      mmsi: '265111004',
      name: 'CALIMA',
      _firstSeenLat: null,
      passedBridges: [],
      _tpSweepCandidate: { name: TP.name, distance: 43 },
    }), CANDIDATE({ distance: 43 }));

    expect(tokens.already_passed).toBe(true);
    expect(tokens.eta_minutes).toBe(-1);
    // VARNINGEN I RAPPORTEN: distansen i svepfallet får INTE räknas om —
    // 306 m/993 m hade fällt INV-11:s 400 m-gräns för proximity-källor.
    expect(state.distance).toBe(43);
  });

  test('svepflagga för en ANNAN punkt smittar inte', async () => {
    const app = makeApp('northbound');
    const { tokens } = await fire(app, passeradSydgaende({
      mmsi: '265111005',
      name: 'ANNAN',
      lat: TP.lat - 200 * METER, // söder om punkten, på väg NORRUT ⇒ framför
      _firstSeenLat: TP.lat - 800 * METER,
      passedBridges: [],
      _tpSweepCandidate: { name: 'NågonAnnanPunkt', distance: 50 },
    }));

    expect(tokens.already_passed).toBe(false);
    expect(tokens.eta_minutes).toBeGreaterThan(0);
  });
});

// =============================================================================
// 3. VAKTEN FYRAR INTE FÖR TIDIGT
// =============================================================================
describe('H16: förvarningen är orörd när punkten ligger FRAMFÖR båten', () => {
  test('nordgående SÖDER om punkten (inkommande) ⇒ oförändrad förvarning', async () => {
    const app = makeApp('northbound');
    const { tokens } = await fire(app, {
      mmsi: '265111010',
      name: 'TIDAN',
      sog: 5,
      cog: 10,
      lat: TP.lat - 200 * METER,
      lon: TP.lon,
      _firstSeenLat: TP.lat - 2000 * METER,
      passedBridges: [],
      etaMinutes: null,
    });

    expect(tokens.already_passed).toBe(false);
    expect(tokens.eta_minutes).toBeGreaterThan(0);
    expect(tokens.message).toMatch(/närmar sig Kanalinfarten/);
  });

  test('sydgående NORR om punkten (på väg ut, ännu inte framme) ⇒ förvarning', async () => {
    const app = makeApp('southbound');
    const { tokens } = await fire(app, passeradSydgaende({
      mmsi: '265111011', name: 'WILHELM THAM', lat: TP.lat + 200 * METER,
    }));

    expect(tokens.already_passed).toBe(false);
    expect(tokens.message).toMatch(/närmar sig/);
  });

  test('KAJSTARTAREN norr om punkten: ingen passage att påstå', async () => {
    // Mätningen: 2 115 stillaliggande rapporter ligger NORR om punkten. En
    // båt som lägger ut därifrån norrut har aldrig korsat punkten.
    const app = makeApp('northbound');
    const { tokens } = await fire(app, {
      mmsi: '265111012',
      name: 'CAPELLA',
      sog: 3,
      cog: 10,
      lat: TP.lat + 150 * METER,
      lon: TP.lon,
      _firstSeenLat: TP.lat + 140 * METER, // episoden började på samma sida
      passedBridges: [],
      etaMinutes: null,
    });

    expect(tokens.already_passed).toBe(false);
    expect(tokens.message).not.toMatch(/har passerat/);
  });

  test('okänd riktning ⇒ vakten avstår (vilken sida är "bakom"?)', async () => {
    const app = makeApp('unknown');
    const { tokens } = await fire(app, passeradSydgaende({
      mmsi: '265111013', name: 'OKÄND', cog: null,
    }));

    expect(tokens.already_passed).toBe(false);
  });

  test('nordgående NORR om punkten MED sydlig episodstart ⇒ passerad (systerstället)', async () => {
    const app = makeApp('northbound');
    const { tokens } = await fire(app, {
      mmsi: '265111014',
      name: 'INKOMMANDE',
      sog: 6,
      cog: 10,
      lat: TP.lat + 150 * METER,
      lon: TP.lon,
      _firstSeenLat: TP.lat - 1200 * METER,
      passedBridges: [],
      etaMinutes: null,
    });

    expect(tokens.already_passed).toBe(true);
    expect(tokens.eta_minutes).toBe(-1);
    expect(tokens.message).toBe('INKOMMANDE har passerat Kanalinfarten');
  });
});

// =============================================================================
// 4. INGEN SMITTA PÅ BROARNA
// =============================================================================
describe('H16: vakten rör bara trigger-punkten', () => {
  test('en brokandidat (source current) påverkas inte av båtens sida', async () => {
    const app = makeApp('southbound');
    const { tokens } = await fire(app, passeradSydgaende({ mmsi: '265111020', name: 'BRO' }), {
      name: 'Klaffbron', id: 'klaffbron', distance: 250, source: 'current',
    });

    expect(tokens.already_passed).toBe(false);
    expect(tokens.eta_minutes).toBeGreaterThan(0);
    expect(tokens.message).toMatch(/närmar sig Klaffbron/);
  });

  test('predikatet självt: fel källa eller okänd punkt ⇒ false', () => {
    const app = makeApp('southbound');
    const vessel = passeradSydgaende();
    expect(app._hasPassedTriggerPoint(vessel, CANDIDATE({ source: 'current' }), 'southbound')).toBe(false);
    expect(app._hasPassedTriggerPoint(vessel, CANDIDATE({ id: 'finnsinte', name: 'Finns inte' }), 'southbound')).toBe(false);
    expect(app._hasPassedTriggerPoint(null, CANDIDATE(), 'southbound')).toBe(false);
    expect(app._hasPassedTriggerPoint(vessel, null, 'southbound')).toBe(false);
    // Namnuppslaget bär fallet där id saknas på kandidaten.
    expect(app._hasPassedTriggerPoint(vessel, { name: TP.name, source: 'trigger-point', distance: 10 }, 'southbound')).toBe(true);
  });

  test('exit-fallbackens egen mening är oförändrad', () => {
    const app = makeApp('southbound');
    const tokens = { vessel_name: 'IN-AXXI', bridge_name: 'Kanalinfarten', eta_minutes: -1 };
    expect(app._buildBoatNearMessage(tokens, 'exit-fallback'))
      .toBe('IN-AXXI var på väg ut ur kanalen vid Kanalinfarten när AIS-kontakten bröts');
  });
});

// =============================================================================
// 5. H16-RESTEN (fixrunda 1b, 2026-08-22) — granskarens två fynd mot vakten
// =============================================================================
//
// (a) MARGINALEN. Vakten jämförde RAKT mot punktens latitud medan
//     systerstället, FP8-gaten i _getFlowTriggerCandidates, kräver 0,0009°
//     (≈100 m) för exakt samma bedömning. Mätningen som motiverar
//     beviskravet visar liggplatser på BÅDA sidor om linjen, så några meters
//     GPS-brus räckte för att en kajliggare som vobblar söderut skulle få
//     already_passed=true, eta=-1 och texten "har passerat Kanalinfarten"
//     utan att ha passerat något.
//
// (b) ANKARET. Vakten läste `_firstSeenLat`, ett EPISODANKARE som skrivs en
//     gång per spårningsepisod och aldrig nollställs. En kajvändare eller
//     U-svängare i SAMMA episod bedömdes därför mot UTRESANS startpunkt.
//     Vakten läser nu RESEANKARET via VesselDataService.getJourneyOriginLat
//     (_journeyStartLat, med _firstSeenLat som fallback).

const MARGIN_M = 100; // TRIGGER_POINT_SIDE_MARGIN_DEG ≈ 100,2 m
const withVDS = (app, journeyStartLat) => {
  app.vesselDataService = {
    getJourneyOriginLat: (v) => {
      if (Number.isFinite(journeyStartLat)) return journeyStartLat;
      return Number.isFinite(v?._firstSeenLat) ? v._firstSeenLat : null;
    },
  };
  return app;
};

describe('H16-resten (a): marginalen är delad med FP8-gaten', () => {
  test('SYDBENET: ankare 50 m norr om linjen är BRUS, inte kanalhistorik', async () => {
    const app = makeApp('southbound');
    const { tokens } = await fire(app, passeradSydgaende({
      mmsi: '265111030',
      name: 'KAJVOBBLAREN',
      lat: TP.lat - 20 * METER, // vobblar precis söder om linjen
      _firstSeenLat: TP.lat + 50 * METER, // inom marginalen ⇒ ingen historik
      passedBridges: [],
    }));

    // Före fixen: startLat > entry.lat ⇒ true ⇒ falsk "har passerat".
    expect(tokens.already_passed).toBe(false);
    expect(tokens.eta_minutes).not.toBe(-1);
    expect(tokens.message).not.toMatch(/har passerat/);
  });

  test('SYDBENET: ankare 150 m norr om linjen fyrar fortfarande', async () => {
    const app = makeApp('southbound');
    const { tokens } = await fire(app, passeradSydgaende({
      mmsi: '265111031',
      name: 'ÄKTA UTFART',
      lat: TP.lat - 20 * METER,
      _firstSeenLat: TP.lat + 150 * METER,
      passedBridges: [],
    }));

    expect(tokens.already_passed).toBe(true);
    expect(tokens.eta_minutes).toBe(-1);
  });

  test('NORDBENET: ankare 50 m söder om linjen räcker inte', async () => {
    const app = makeApp('northbound');
    const { tokens } = await fire(app, {
      mmsi: '265111032',
      name: 'NORDVOBBLAREN',
      sog: 4,
      cog: 10,
      lat: TP.lat + 20 * METER,
      lon: TP.lon,
      _firstSeenLat: TP.lat - 50 * METER,
      passedBridges: [],
      etaMinutes: null,
    });

    expect(tokens.already_passed).toBe(false);
  });

  test('NORDBENET: ankare 150 m söder om linjen fyrar', async () => {
    const app = makeApp('northbound');
    const { tokens } = await fire(app, {
      mmsi: '265111033',
      name: 'NORDINKOMMANDE',
      sog: 4,
      cog: 10,
      lat: TP.lat + 20 * METER,
      lon: TP.lon,
      _firstSeenLat: TP.lat - 150 * METER,
      passedBridges: [],
      etaMinutes: null,
    });

    expect(tokens.already_passed).toBe(true);
  });

  test('BRO-BENET är orört av marginalen (en passerad bro bevisar riktningen)', async () => {
    const app = makeApp('southbound');
    const { tokens } = await fire(app, passeradSydgaende({
      mmsi: '265111034',
      name: 'BROBEVISAD',
      lat: TP.lat - 20 * METER,
      _firstSeenLat: TP.lat + 5 * METER, // långt inom marginalen
      passedBridges: ['Olidebron'],
    }));

    expect(tokens.already_passed).toBe(true);
  });
});

describe('H16-resten (b): vakten läser RESEANKARET, inte episodankaret', () => {
  test('U-SVÄNGAREN: episodankaret söder om punkten, reseankaret norr ⇒ passerad', async () => {
    // Episoden började söder om punkten (hon kom utifrån), vände inne i
    // kanalen och är nu på returbenet söderut igen. _firstSeenLat pekar på
    // UTRESANS start och skulle ensam ge "inte passerad".
    const app = withVDS(makeApp('southbound'), TP.lat + 900 * METER);
    const { tokens } = await fire(app, passeradSydgaende({
      mmsi: '265111040',
      name: 'KAJVÄNDAREN',
      _firstSeenLat: TP.lat - 800 * METER,
      _journeyStartLat: TP.lat + 900 * METER,
      passedBridges: [],
    }));

    expect(tokens.already_passed).toBe(true);
    expect(tokens.eta_minutes).toBe(-1);
  });

  test('OMVÄNT: reseankaret söder om punkten slår ut ett nordligt episodankare', async () => {
    // Ny resa ankrad SÖDER om punkten (NEW_JOURNEY vid vändningen) medan
    // episodankaret ligger kvar långt norrut. Reseankaret ska vinna, annars
    // påstås en passage som den här resan inte gjort.
    const app = withVDS(makeApp('southbound'), TP.lat - 400 * METER);
    const { tokens } = await fire(app, passeradSydgaende({
      mmsi: '265111041',
      name: 'NYSTARTAD',
      _firstSeenLat: TP.lat + 900 * METER,
      _journeyStartLat: TP.lat - 400 * METER,
      passedBridges: [],
    }));

    expect(tokens.already_passed).toBe(false);
  });

  test('FALLBACKEN: utan reseankare används episodankaret (oförändrat beteende)', async () => {
    const app = withVDS(makeApp('southbound'), null); // servicen faller tillbaka själv
    const { tokens } = await fire(app, passeradSydgaende({
      mmsi: '265111042', name: 'UTAN RESEANKARE', passedBridges: [],
    }));

    expect(tokens.already_passed).toBe(true);
  });

  test('UTAN SERVICE alls: vakten läser _firstSeenLat direkt (kastar inte)', async () => {
    const app = makeApp('southbound'); // ingen vesselDataService satt
    const { tokens } = await fire(app, passeradSydgaende({
      mmsi: '265111043', name: 'SERVICELÖS', passedBridges: [],
    }));

    expect(tokens.already_passed).toBe(true);
    expect(app.error).not.toHaveBeenCalled();
  });
});

describe('H16-resten: FP8-gaten och vakten kan inte glida isär', () => {
  const makeCandidateApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._getDirectionString = jest.fn(() => 'southbound');
    return app;
  };

  const quayStarter = (firstSeenOffsetM) => ({
    mmsi: '265111050',
    name: 'LOTSKAJEN',
    lat: TP.lat + 120 * METER,
    lon: TP.lon,
    sog: 3,
    cog: 205,
    passedBridges: [],
    targetBridge: null,
    _finalTargetBridge: null,
    _firstSeenLat: TP.lat + firstSeenOffsetM * METER,
  });

  const EMPTY_PROXIMITY = { bridges: [], nearestBridge: null };

  test('FP8: episodstart 50 m norr om punkten ger INGEN kandidat', () => {
    const app = makeCandidateApp();
    const candidates = app._getFlowTriggerCandidates(quayStarter(50), EMPTY_PROXIMITY);
    expect(candidates.filter((c) => c.source === 'trigger-point')).toHaveLength(0);
    expect(app.debug.mock.calls.some((c) => String(c[0]).includes('TRIGGER_POINT_SKIP'))).toBe(true);
  });

  test('FP8: episodstart 150 m norr om punkten ger kandidat', () => {
    const app = makeCandidateApp();
    const candidates = app._getFlowTriggerCandidates(quayStarter(150), EMPTY_PROXIMITY);
    expect(candidates.filter((c) => c.source === 'trigger-point')).toHaveLength(1);
  });

  test('KÄLLSVEP: BÅDA TRIGGER-PUNKTSSTÄLLENA delar konstanten', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');

    // Vaktens kropp: två jämförelser, båda mot konstanten.
    const guard = src.slice(
      src.indexOf('_hasPassedTriggerPoint(vessel, candidate, direction) {'),
      src.indexOf('_buildBoatNearMessage(tokens, source, passedTriggerPoint'),
    );
    expect(guard).toContain('_hasPassedTriggerPoint(vessel, candidate, direction) {');
    expect(guard.match(/TRIGGER_POINT_SIDE_MARGIN_DEG/g) || []).toHaveLength(2);
    expect(guard).not.toContain('0.0009');

    // FP8-gaten: samma konstant, ingen egen literal.
    const fp8Line = src.split('\n').find((l) => l.includes('vessel._firstSeenLat > tp.lat'));
    expect(fp8Line).toBeDefined();
    expect(fp8Line).toContain('TRIGGER_POINT_SIDE_MARGIN_DEG');

    // OMFATTNINGEN, EXAKT (granskningen 2026-08-22): svepet prövar de två
    // TRIGGER-PUNKTSSTÄLLENA — vaktens kropp och FP8-gaten. Värdet står i
    // deklarationen PLUS en MEDVETEN literal i skipped-bridges-fallbacken
    // (`hasCanalHistory` i `_checkSkippedBridgesFallback`), som mäter det
    // BEVISADE fönstrets norra ände mot slingans `bridgeLat` och besvarar en
    // ANNAN fråga: "kom båten demonstrerat från kanalsidan", inte "ligger
    // punkten bakom henne". Den lämnades därför med flit och räknas här.
    expect(src).toContain('const TRIGGER_POINT_SIDE_MARGIN_DEG = 0.0009;');
    expect((src.match(/0\.0009/g) || []).length).toBe(2);
    const canalHistoryLine = src.split('\n').find((l) => l.includes('provenNorthLat > bridgeLat'));
    expect(canalHistoryLine).toBeDefined();
    expect(canalHistoryLine).toContain('0.0009');
  });
});
