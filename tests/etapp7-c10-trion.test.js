'use strict';

/**
 * Etapp 7 fas C, etapp III — C10-trion (F14 / F9 / F12).
 *
 * TRE MINI-FIXAR SOM ALLA TRIAGERADES TILL "INGEN PRODUKTÄNDRING" EFTER
 * MÄTNING. Sviten finns för att mätresultaten ska bli PERMANENTA — nästa
 * granskare som läser planraden "C10: tre mini-commits" ska hitta beviset här
 * i stället för att göra om ingreppet.
 *
 * ── F14 · brotextvarianten "3 båtar är i närheten av Stridsbergsbron" ──
 * Varianten är SANKTIONERAD av CLAUSE-invarianten: `COUNT_WORDS` i
 * tests/replay-validation/invariants.js innehåller alternativet `[2-9]\d?`
 * (siffra) sida vid sida med de svenska räkneorden, och det alternativet stod
 * i filens ALLRA FÖRSTA version (2ae66a4, 19h-auditen 2026-06-11) på samma rad
 * som klausulmönstret `^COUNT_WORDS båtar? är i närheten av …$`. INV-1 kan
 * alltså aldrig fälla formen — den skrevs in medvetet för nödfallbacken.
 *
 * Formen kommer INTE från den här filens motor utan från app.js
 * `_generateSafeFallbackText`, som interpolerar `vesselCount` rått
 * (`${vesselCount} båtar är i närheten av …`). Den skrivvägen ligger utanför
 * paketets ägarskap och rörs inte här. Det som låses nedan är att
 * BridgeTextService — huvudmotorn — aldrig driver iväg mot fallbackens form:
 * dokumentkontraktet (docs/bridgeTextFormat.md §Antal) säger svenskt räkneord
 * för 1–10 och siffra först från 11.
 *
 * ── F9 · coverage-grinden ──
 * Planens design: "gate `_emitCoverage` på att armen inte redan passerat".
 * MÄTT UTFALL: 0 av 498 täckningsrader i de 18 korpusarna (~319,5 h) och 0 av
 * 58 rader i 42h-fältprovet uppfyller villkoret. Orsaken är STRUKTURELL, inte
 * statistisk: `_emitCoverage` får aldrig fartygsobjektet, så en grind där kan
 * bara läsa vad armen kände till vid sin SENASTE observation — och exakt då
 * har `_disarmEvidence` ben (1) redan tagit bort varje arm vars fartyg
 * passerat efter beväpningen. Grinden vore per konstruktion en no-op, och en
 * bredare variant ("bron finns i passedBridges") hade i stället raderat
 * legitima returresor (4 rader i korpus, 5 i fält). Testerna nedan låser
 * garantin F9 ville ha, utan att blinda O1-instrumentet.
 *
 * ── F12 · ledararvet ──
 * Planens design: "ny ledare ärver föregåendes clamp-baslinje". Kontrafaktisk
 * mätning över alla 18 korpusar: 31 brotexter hade ändrats, 17 av dem med
 * ≥3 min och 11 med ≥5 min (störst 11 → 40 min). INGEN av dem var en sågtand —
 * de tre enda ledar-pingpongarna i hela materialet (A→B→A, oförändrad
 * medlemsmängd, ≤5 min) är alla MONOTONA i den visade siffran. Varje ändrad
 * text hade alltså bytt ut den nya ledarens SANNA siffra mot ett tal härlett
 * ur en ANNAN båt. Det är precis den visningsklamp filens egen doktrin redan
 * förkastat (BridgeTextService `_formatETAAsBroOpening`: "visningsklampar är
 * facit-fällda; beräkningsvärdet äger"). Låset nedan är statelöshet: samma
 * indata ⇒ samma text, oavsett vad som renderades innan.
 */

global.__TEST_MODE__ = true;

const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const CountTextHelper = require('../lib/utils/CountTextHelper');
const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');

const T0 = 1_700_000_000_000;
const KLAFF = BRIDGES.klaffbron;

const makeLogger = () => ({
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

/** Position `distanceM` meter från bron längs bäring `bearingDeg` (kanalen NE–SV). */
function posAtDistance(bridge, distanceM, bearingDeg = 220) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceM * Math.cos(rad)) / 111320;
  const dLon = (distanceM * Math.sin(rad)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180));
  return { lat: bridge.lat + dLat, lon: bridge.lon + dLon };
}

/** Fartygsobjekt i samma form som VesselDataService._createVesselObject ger. */
function makeVessel(overrides = {}) {
  const bridge = overrides.bridge || KLAFF;
  const distanceM = overrides.distanceM ?? 1000;
  const bearing = overrides.bearing ?? 220;
  const pos = posAtDistance(bridge, distanceM, bearing);
  const now = Date.now();
  return {
    mmsi: overrides.mmsi || '265999001',
    name: overrides.name || 'TESTBÅT',
    lat: pos.lat,
    lon: pos.lon,
    sog: overrides.sog === undefined ? 5 : overrides.sog,
    cog: overrides.cog ?? 40,
    timestamp: overrides.timestamp ?? now,
    fixTs: overrides.fixTs ?? now,
    targetBridge: overrides.targetBridge === undefined ? bridge.name : overrides.targetBridge,
    _routeDirection: overrides._routeDirection === undefined ? 'north' : overrides._routeDirection,
    _finalTargetDirection: overrides._finalTargetDirection ?? null,
    _hasMovementProof: overrides._hasMovementProof === undefined ? true : overrides._hasMovementProof,
    _moored: overrides._moored === true,
    _stationarySince: overrides._stationarySince === undefined ? null : overrides._stationarySince,
    navStatus: overrides.navStatus === undefined ? null : overrides.navStatus,
    etaMinutes: overrides.etaMinutes ?? null,
    passedAt: overrides.passedAt || {},
    passedBridges: overrides.passedBridges || [],
  };
}

// ===========================================================================
// F9 — TÄCKNINGSRADEN OCH DEN REDAN PASSERADE ARMEN
// ===========================================================================

describe('C10/F9: öppningstäckning emitteras aldrig för en arm som redan passerat', () => {
  let logger;
  let warnings;
  let coverage;
  let svc;
  let tickTimer;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    logger = makeLogger();
    warnings = [];
    coverage = [];
    svc = new BridgeOpeningService({
      logger,
      onWarning: (p) => warnings.push(p),
      onCoverage: (info) => coverage.push(info),
    });
    tickTimer = setInterval(() => svc.tick(), BRIDGE_OPENING.TICK_INTERVAL_MS);
  });

  afterEach(() => {
    clearInterval(tickTimer);
    svc.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
    // Svälj-fällan: en kastande callback hade fångats av _emitCoverage och
    // loggats — sviten skulle annars vara grön på tyst svald diagnostik.
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('passage efter beväpning ⇒ armen är borta innan någon täckning kan skrivas', () => {
    // Beväpna långt ut, ingen varning ännu (deadline ligger framåt).
    // OBS: motorn beväpnar även mot NÄSTA målbro i färdriktningen
    // (ARM_NEXT_TARGET), så alla assertioner nedan gäller Klaffbron.
    svc.observeVessel(makeVessel({ distanceM: 2200, sog: 7 }));
    expect(svc.getStats().armed).toBeGreaterThanOrEqual(1);
    expect(coverage.filter((c) => c.bridge === KLAFF.name)).toHaveLength(0);

    // Appen ankrar passagen: passedAt > armedAt är `_disarmEvidence` ben (1).
    const passedAt = Date.now() + 1000;
    jest.setSystemTime(passedAt);
    svc.observeVessel(makeVessel({
      distanceM: 120,
      sog: 6,
      passedAt: { [KLAFF.name]: passedAt },
      passedBridges: [KLAFF.name],
    }));

    expect(warnings.filter((w) => w.bridge === KLAFF.name)).toHaveLength(0);
    expect(coverage.filter((c) => c.bridge === KLAFF.name)).toHaveLength(0);

    // Deadline-vägen kan inte återuppliva henne heller.
    jest.advanceTimersByTime(30 * 60 * 1000);
    expect(coverage.filter((c) => c.bridge === KLAFF.name)).toHaveLength(0);
  });

  test('deadline-vägen: en ANNAN båts avfyrning ger ingen täckning åt den passerade', () => {
    // B seglar genom bron först; A kommer efter och får sin EGEN öppning. Poängen
    // är att A:s varning fyras av tick() — den vägen kör INTE motbevis-svepet —
    // och ändå kan B inte hamna i täckningsraderna. Det är precis det hål en
    // grind i `_emitCoverage` skulle sägas täppa till, och det finns inte.
    svc.observeVessel(makeVessel({
      mmsi: '222000222', name: 'B', distanceM: 1500, sog: 7,
    }));

    const passedAt = Date.now() + 60000;
    jest.setSystemTime(passedAt);
    svc.observeVessel(makeVessel({
      mmsi: '222000222',
      name: 'B',
      distanceM: 100,
      sog: 6,
      passedAt: { [KLAFF.name]: passedAt },
      passedBridges: [KLAFF.name],
    }));
    expect(coverage.filter((c) => c.bridge === KLAFF.name)).toHaveLength(0);

    // A dyker upp efter passagen ⇒ egen händelse (B:s är förbrukad utan att ha
    // avfyrat och får inte hålla nya armar som gisslan).
    jest.setSystemTime(passedAt + 10000);
    svc.observeVessel(makeVessel({
      mmsi: '111000111', name: 'A', distanceM: 1600, sog: 7,
    }));

    jest.advanceTimersByTime(10 * 60 * 1000);

    const atKlaff = coverage.filter((c) => c.bridge === KLAFF.name);
    expect(atKlaff.length).toBeGreaterThan(0); // A täcktes
    expect(warnings.filter((w) => w.bridge === KLAFF.name && w.firedBy === 'deadline'))
      .toHaveLength(1);
    expect(atKlaff.every((c) => c.mmsi === '111000111')).toBe(true);
    expect(atKlaff.some((c) => c.mmsi === '222000222')).toBe(false);
  });

  test('RETURRESA: passage FÖRE beväpningen ska ge täckning (bred grind vore en regression)', () => {
    // Klassen som fäller varje "har bron i passedBridges"-variant: 4 av 498
    // korpusrader och 5 av 58 fältrader är exakt det här — ELFKUNGEN och
    // systerfallen som passerar norrut, vänder och kommer tillbaka söderut.
    // Hon ligger alltså NORR om Klaffbron (bäring 40) med låst sydriktning:
    // bron ligger framför henne, inte bakom (_bridgeIsBehind läser latituden).
    const oldPassage = Date.now();
    jest.setSystemTime(oldPassage + 60 * 60 * 1000); // en timme senare: ny anflygning

    svc.observeVessel(makeVessel({
      distanceM: 1600,
      bearing: 40,
      sog: 7,
      cog: 220,
      _routeDirection: 'south',
      passedAt: { [KLAFF.name]: oldPassage },
      passedBridges: [KLAFF.name],
    }));
    expect(svc.getStats().armed).toBeGreaterThanOrEqual(1);

    jest.advanceTimersByTime(5 * 60 * 1000);

    expect(warnings.filter((w) => w.bridge === KLAFF.name)).toHaveLength(1);
    expect(coverage.filter((c) => c.bridge === KLAFF.name && c.reason === 'fired'))
      .toHaveLength(1);
  });
});

// ===========================================================================
// F14 — RÄKNEORDSKONTRAKTET I HUVUDMOTORN
// ===========================================================================

describe('C10/F14: brotextens räkneordskontrakt (docs/bridgeTextFormat.md §Antal)', () => {
  // CLAUSE-invariantens grammatik, ordagrant ur tests/replay-validation/
  // invariants.js. Kopian finns här för att en enhetstest inte ska dra in
  // harnessmodulen — regexet är låst av harness-vakter.test.js på sin sida.
  const COUNT_WORDS = '(En|Två|Tre|Fyra|Fem|Sex|Sju|Åtta|Nio|Tio|[2-9]\\d?)';
  const TARGET = '(Klaffbron|Stridsbergsbron)';
  const ETA_CLAUSE = '(beräknad broöppning (strax|om (cirka )?([1-9]\\d{0,2}) minuter)|ETA okänd|inväntar broöppning)';
  const CLAUSE_RES = [
    new RegExp(`^En båt på väg mot ${TARGET}, ${ETA_CLAUSE}$`),
    new RegExp(`^${COUNT_WORDS} båtar på väg mot ${TARGET}, ${ETA_CLAUSE}$`),
  ];

  const makeService = () => new BridgeTextService(
    new BridgeRegistry(BRIDGES), makeLogger(), null, null, null,
  );

  const group = (n, etaMinutes = 5) => Array.from({ length: n }, (_, i) => ({
    mmsi: String(265000000 + i),
    name: `BÅT${i}`,
    targetBridge: 'Klaffbron',
    etaMinutes: etaMinutes + i,
    passedBridges: [],
  }));

  test('1–10 båtar renderas med svenskt räkneord, aldrig med siffra', () => {
    const svc = makeService();
    const ord = ['En', 'Två', 'Tre', 'Fyra', 'Fem', 'Sex', 'Sju', 'Åtta', 'Nio', 'Tio'];
    for (let n = 1; n <= 10; n++) {
      const text = svc.generateBridgeText(group(n));
      expect(text.startsWith(`${ord[n - 1]} `)).toBe(true);
      // Kontraktsbrottet skulle se ut som "3 båtar …" — fallbackens form.
      expect(text).not.toMatch(/^\d+ båtar/);
    }
  });

  test('≥11 båtar renderas med siffra (kontraktets andra hälft)', () => {
    const svc = makeService();
    for (const n of [11, 12, 15]) {
      expect(svc.generateBridgeText(group(n)).startsWith(`${n} `)).toBe(true);
    }
  });

  test('SSOT: motorn använder CountTextHelper — ingen egen talöversättning', () => {
    // Låser att de två vägarna inte kan glida isär. Fallbackens defekt är
    // just att den INTE går via hjälparen.
    for (let n = 1; n <= 12; n++) {
      expect(CountTextHelper.getCountText(n)).toBe(n <= 10
        ? ['En', 'Två', 'Tre', 'Fyra', 'Fem', 'Sex', 'Sju', 'Åtta', 'Nio', 'Tio'][n - 1]
        : String(n));
    }
  });

  test('varje klausul motorn producerar ligger innanför CLAUSE-grammatiken', () => {
    const svc = makeService();
    for (let n = 1; n <= 10; n++) {
      for (const eta of [1, 5, 42, 150]) {
        const text = svc.generateBridgeText(group(n, eta));
        for (const clause of text.split('; ')) {
          expect(CLAUSE_RES.some((re) => re.test(clause))).toBe(true);
        }
      }
    }
  });

  test('DOKUMENTERAT HÅL i CLAUSE-grammatiken: sifferalternativet hoppar över 11–19', () => {
    // Fynd ur F14-triagen 2026-08-09, INTE en produktdefekt: `COUNT_WORDS`
    // slutar på `[2-9]\d?`, vilket täcker 2–9 och 20–99 men ALDRIG 11–19.
    // Renderas någon gång "11 båtar på väg mot …" fäller INV-1 den som OKÄND
    // KLAUSUL — ett falskt positivt i en fatal invariant. Klassen är latent
    // (mest observerade i 18 korpusar är sex båtar, och INV-9:s rimlighetstak
    // ligger på 15), men hålet är verkligt och ägs av harnessen
    // (tests/replay-validation/invariants.js), inte av det här paketet.
    // Testet larmar den dag hålet täpps igen ELLER blir nåbart.
    const svc = makeService();
    const eleven = svc.generateBridgeText(group(11));
    expect(eleven.startsWith('11 båtar')).toBe(true);
    expect(CLAUSE_RES.some((re) => re.test(eleven))).toBe(false);
    // 20 båtar hade däremot matchat — beviset för att det är just 11–19 som saknas.
    const twenty = svc.generateBridgeText(group(20));
    expect(CLAUSE_RES.some((re) => re.test(twenty))).toBe(true);
  });
});

// ===========================================================================
// F12 — INGEN CLAMP-BASLINJE FÅR ÄRVAS ÖVER ETT LEDARBYTE
// ===========================================================================

describe('C10/F12: ledarbytet ärver ingen ETA-baslinje (statelös motor)', () => {
  const makeService = () => new BridgeTextService(
    new BridgeRegistry(BRIDGES), makeLogger(), null, null, null,
  );

  const boat = (mmsi, etaMinutes) => ({
    mmsi, name: `B${mmsi}`, targetBridge: 'Klaffbron', etaMinutes, passedBridges: [],
  });

  test('samma indata ger samma text oavsett vad som renderades innan', () => {
    const svc = makeService();
    // Först en ledare 40 min ut, sedan ett byte till en 5 min ut. En ärvd
    // baslinje (maxDelta = max(3; 0,25·40) = 10) hade visat "om 30 minuter".
    svc.generateBridgeText([boat('111111111', 40)]);
    const after = svc.generateBridgeText([boat('222222222', 5)]);

    // Referensen: en OANVÄND instans som ser samma indata som sitt första
    // anrop. Skiljer de sig har någon smugit in ett minne mellan anropen.
    const virgin = makeService();
    expect(after).toBe(virgin.generateBridgeText([boat('222222222', 5)]));
    expect(after).toBe('En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter');
  });

  test('ledarbyte visar den NYA ledarens sanna siffra, inte den gamlas', () => {
    const svc = makeService();
    // 12:35-fallet ur 20260713-41h: ledaren 53 min ut ersätts av en båt
    // 11 min ut. Ett ärvt baslinjetak (max(3; gap + 0,25·bas)) hade visat
    // "om 40 minuter" — 29 minuter fel, i pessimistisk riktning.
    svc.generateBridgeText([boat('111111111', 53)]);
    const after = svc.generateBridgeText([boat('111111111', 53), boat('222222222', 11)]);
    expect(after).toBe('Två båtar på väg mot Klaffbron, beräknad broöppning om 11 minuter');
  });

  test('"strax" får aldrig klampas bort av en ärvd baslinje', () => {
    const svc = makeService();
    // Den farligaste riktningen: föregående ledare låg 40 min ut, den nya står
    // vid bron. Ett arv (maxDelta 10) hade visat "om 30 minuter" och därmed
    // FÖRNEKAT att en båt är framme — texten hade slutat varna för en öppning
    // som pågår. Motsvarande fall i korpus: 2026-07-10T11:43:09 @
    // Stridsbergsbron, där den kontrafaktiska mätningen gav "strax" → "om 4
    // minuter".
    expect(svc.generateBridgeText([boat('111111111', 40)]))
      .toBe('En båt på väg mot Klaffbron, beräknad broöppning om 40 minuter');
    expect(svc.generateBridgeText([boat('222222222', 1)]))
      .toBe('En båt på väg mot Klaffbron, beräknad broöppning strax');
  });
});
