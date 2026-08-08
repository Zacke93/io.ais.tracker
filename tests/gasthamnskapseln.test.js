'use strict';

/**
 * B3 (etapp 7, 2026-08-05): gästhamnskapseln — MOORING_ZONES-posten
 * 'Gästhamnen norr om Klaffbron'.
 *
 * Bakgrund (both-dygn 1): gästhamnen ~520 m N om Klaffbron var dygnets
 * dominerande falsklarmskälla (68 % av all felaktig brotext, flertalet
 * fantomvarningar; 7 fartyg, 1 842 min stilltid, navStatus null/15 hos alla
 * — navstatuslagret blint). GO-rapportens varning: kapseln får INTE bygga på
 * ren geometri, eftersom äkta Klaffbron-passager går nära — skyddet är
 * stillhetskravet i konsumtionslagren. Testerna låser därför BÅDA benen:
 *   1. GEOMETRIN (datahärledd ur fältdygnen 2026-08-04/05, riktiga koordinater):
 *      stillhetsklustret inne, farledens transitspår (≥5 kn, ≥40 m väster) ute.
 *   2. KONSUMTIONEN: stationär i kapseln ⇒ moored + aldrig målbro (LAGER 1);
 *      rörlig genom kapseln (in-/utgångsmanöver 2–3 kn) ⇒ ALDRIG moored,
 *      behåller målbro.
 */

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const geometry = require('../lib/utils/geometry');
const { MOORING_ZONES, BRIDGES } = require('../lib/constants');

const ZONE = MOORING_ZONES.find((z) => z.name === 'Gästhamnen norr om Klaffbron');
const KAJZON = MOORING_ZONES.find((z) => z.name === 'Kajen norr om Klaffbron');

// Kapselns centroid — referenspunkt för B3×C0b-interaktionstestet (de äkta
// transiterna gick 27–32 m från centrumlinjen, alltså väl inom 60 m av mitten).
const KAPSEL_CENTROID = {
  lat: (ZONE.start.lat + ZONE.end.lat) / 2,
  lon: (ZONE.start.lon + ZONE.end.lon) / 2,
};

// Riktiga fältsampel (both-dygn 1 + GO-dygnet):
const STILLA_TRUNTEN = { lat: 58.28715, lon: 12.28554 }; // sog 0, 219031577
const STILLA_CENTER = { lat: 58.28740, lon: 12.285705 }; // klustrets mitt
const FARLED_CARAT_74KN = { lat: 58.2875, lon: 12.28499 }; // sog 7,4 — transit väster om hamnen
const MANOVER_27KN = { lat: 58.28766, lon: 12.28571 }; // sog 2,7 — utgångsmanöver genom kapseln

const segDist = (p) => geometry.distancePointToSegmentM(
  p.lat, p.lon, ZONE.start.lat, ZONE.start.lon, ZONE.end.lat, ZONE.end.lon,
);

describe('B3: gästhamnskapselns geometri (datahärledd)', () => {
  test('zonen finns med kapselkontraktets fyra fält', () => {
    expect(ZONE).toBeDefined();
    expect(Number.isFinite(ZONE.start.lat) && Number.isFinite(ZONE.end.lon)).toBe(true);
    expect(ZONE.radiusM).toBe(35);
  });

  test('stillhetsklustrets sampel ligger INNE i kapseln', () => {
    expect(segDist(STILLA_TRUNTEN)).toBeLessThanOrEqual(ZONE.radiusM);
    expect(segDist(STILLA_CENTER)).toBeLessThanOrEqual(ZONE.radiusM);
  });

  test('farledens transitspår (7,4 kn) ligger UTANFÖR kapseln med marginal', () => {
    expect(segDist(FARLED_CARAT_74KN)).toBeGreaterThan(ZONE.radiusM + 5);
  });

  test('kapseln når inte Klaffbrons väntzon — SANN marginal 19,5 m (F-8b)', () => {
    // F-8b (etapp 7 fas C, 2026-08-08): raden hårdkodade tidigare Klaffbron
    // till 58.28248/12.28331 — **183,3 m söder om** brons verkliga läge. Felet
    // blåste upp den mätta marginalen till 501,7 m och gjorde assertionen
    // (">300 + 100 m") strukturellt OFÄLLBAR: kapseln hade kunnat få radie
    // 200 m eller flyttas 150 m söderut utan att testet sa ifrån. Koordinaten
    // läses nu ur BRIDGES (samma källa som produktionskoden), och marginalen
    // assertas mot sitt SANNA värde.
    const K = BRIDGES.klaffbron;

    // Väntzonen = brons detektionsradie. Härleds, hårdkodas inte — samma tal
    // som skyddszonen och C0b:s köundantag mäter mot.
    const WAIT_ZONE_M = K.radius; // 300 m

    // Kapselns NÄRMASTE punkt till bron = vinkelrätt avstånd bro→centrumlinje
    // minus halvbredden. Exakt samma segmentmått som _findMooringZone använder,
    // så testet mäter den geometri produktionen faktiskt konsumerar.
    const dCentreline = segDist(K); // 354,5 m
    const nearestCapsulePointM = dCentreline - ZONE.radiusM; // 319,5 m

    // HÅRDA egenskapen: ingen punkt i kapseln ligger inne i väntzonen, alltså
    // kan ingen båt som väntar på Klaffbron demoteras av kapseln.
    expect(nearestCapsulePointM).toBeGreaterThan(WAIT_ZONE_M);

    // SANNA marginalen: 354,5 − 35 − 300 = 19,5 m. Bandet är avsiktligt SMALT
    // och kalibrerat mot dagens geometri. Det är hela poängen: marginalen är
    // 19,5 m — inte >100 — och därför får varken kapselns halvbredd, dess
    // centrumlinje eller brons radie röras utan att talet räknas om ur rådata.
    // En C0b-fix som i stället breddar kapseln (eller drar den söderut för att
    // svälja fler stillaliggare) fäller den här raden direkt.
    const marginToWaitZoneM = nearestCapsulePointM - WAIT_ZONE_M;
    expect(marginToWaitZoneM).toBeGreaterThan(15);
    expect(marginToWaitZoneM).toBeLessThan(25);
  });

  test('C0b: köundantaget bärs av zonposterna, inte av en global avståndsgrind', () => {
    // Kontraktet C0b inför: `queueGraceMs` på MOORING_ZONES-posten. Kajzonen
    // (inne i väntzonen) behåller sina 15 min; gästhamnen (utanför väntzonen)
    // har inget undantag alls och faller tillbaka på baskravet 3 min.
    expect(KAJZON.queueGraceMs).toBe(15 * 60 * 1000);
    expect(ZONE.queueGraceMs).toBeFalsy();

    // Varje zon som BÄR grace måste också ligga i en väntzon — annars är
    // undantaget per definition felriktat. Regeln uttrycks som en egenskap
    // över hela listan så en framtida zon inte kan smyga in ett undantag.
    for (const z of MOORING_ZONES) {
      if (!z.queueGraceMs) continue;
      const nearest = Math.min(...Object.values(BRIDGES)
        .filter((b) => Number.isFinite(b.radius))
        .map((b) => geometry.distancePointToSegmentM(
          b.lat, b.lon, z.start.lat, z.start.lon, z.end.lat, z.end.lon,
        ) - z.radiusM - b.radius));
      expect(nearest).toBeLessThan(0); // zonen skär minst en bros väntzon
    }
  });

  test('kajzonen ligger däremot MITT i väntzonen — motiverar C0b:s zon-lokala grepp', () => {
    // Kontrasten som förklarar varför köundantaget inte kan grindas på ren
    // distans: kajzonen (som DELADE köundantag med gästhamnen före C0b) ligger
    // 161–290 m från Klaffbron, alltså helt inne i väntzonen, medan
    // gästhamnskapseln ligger 19,5 m utanför.
    const K = BRIDGES.klaffbron;
    const kajNearest = geometry.distancePointToSegmentM(
      K.lat, K.lon, KAJZON.start.lat, KAJZON.start.lon, KAJZON.end.lat, KAJZON.end.lon,
    ) - KAJZON.radiusM;
    expect(kajNearest).toBeLessThan(K.radius); // inne i väntzonen
    expect(kajNearest).toBeGreaterThan(150); // 161,1 m — inte under bron
  });

  test('C0b: zonernas broavståndsintervall ÖVERLAPPAR — ingen tröskel kan skilja dem', () => {
    // Den hårda anledningen till att C0b MÅSTE vara zon-lokal och inte en
    // trubbig tröskeländring (t.ex. 600 → 300 m). Kapslarna är utsträckta
    // kroppar, inte punkter: mätt över HELA kapseln (samma segmentmått som
    // _findMooringZone) spänner kajzonen 161,0–320,2 m från Klaffbron och
    // gästhamnen 319,1–445,7 m. Intervallen överlappar med ~1,1 m. En
    // avståndsgrind som ger kajzonen grace men nekar gästhamnen den finns
    // alltså inte — oavsett vilket tal man väljer träffar den fel zon.
    const K = BRIDGES.klaffbron;
    const span = (z) => {
      // Tät svepning över kapselns inre ⇒ exakt min/max broavstånd.
      let mn = Infinity; let mx = -Infinity;
      const cLat = (z.start.lat + z.end.lat) / 2;
      const cLon = (z.start.lon + z.end.lon) / 2;
      for (let i = -240; i <= 240; i++) {
        for (let j = -240; j <= 240; j++) {
          const lat = cLat + i * 0.0000085;
          const lon = cLon + j * 0.0000150;
          const d = geometry.distancePointToSegmentM(
            lat, lon, z.start.lat, z.start.lon, z.end.lat, z.end.lon,
          );
          if (!(d <= z.radiusM)) continue;
          const dk = geometry.calculateDistance(lat, lon, K.lat, K.lon);
          if (dk < mn) mn = dk;
          if (dk > mx) mx = dk;
        }
      }
      return [mn, mx];
    };
    const [kajMin, kajMax] = span(KAJZON);
    const [hamnMin, hamnMax] = span(ZONE);
    expect(kajMin).toBeLessThan(200); // 161,0 m
    expect(hamnMax).toBeGreaterThan(440); // 445,7 m
    // ÖVERLAPPET är påståendet: kajzonens yttersta punkt ligger LÄNGRE bort
    // från bron än gästhamnens närmaste. Faller den här raden har geometrin
    // ändrats och C0b:s motivering måste räknas om ur rådata.
    expect(kajMax).toBeGreaterThan(hamnMin);
  });
});

describe('B3: konsumtionen — stillhet krävs, rörelse skyddar', () => {
  let svc;
  let mockNow;
  const realDateNow = Date.now;
  const logger = {
    debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.__TEST_MODE__ = true;
    mockNow = new Date(2026, 7, 5, 10, 0, 0).getTime();
    Date.now = () => mockNow;

    const bridgeRegistry = new BridgeRegistry();
    const systemCoordinator = new SystemCoordinator(logger);
    svc = new VesselDataService(logger, bridgeRegistry, systemCoordinator);
    svc.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
  });

  afterEach(() => {
    svc.clearAllTimers();
    delete global.__TEST_MODE__;
    Date.now = realDateNow;
  });

  function tick(minutes = 1) {
    mockNow += minutes * 60 * 1000;
  }

  test('_findMooringZone träffar gästhamnen för klustrets position', () => {
    const zone = svc._findMooringZone({ lat: STILLA_CENTER.lat, lon: STILLA_CENTER.lon });
    expect(zone && zone.name).toBe('Gästhamnen norr om Klaffbron');
  });

  test('LAGER 1: gästhamnsliggare (CARAT-klassen) får ALDRIG målbro och klassas moored', () => {
    // Both-dygn 1: CARAT låg här med navStatus null och fick 97,6 min falsk
    // "på väg mot Klaffbron"-text. Med kapseln: stationär + i zonen ⇒ moored.
    let vessel;
    for (let i = 0; i < 5; i++) {
      vessel = svc.updateVessel('211452170', {
        lat: STILLA_TRUNTEN.lat, lon: STILLA_TRUNTEN.lon, sog: 0.0, cog: 128, name: 'CARAT',
      });
      tick(3);
    }
    expect(vessel._moored).toBe(true);
    expect(vessel.targetBridge).toBeNull();
  });

  test('rörlig båt SÖDERUT genom kapseln (utgångsmanöver) klassas ALDRIG moored', () => {
    // Avgång ur gästhamnen: 2–3 kn genom kapseln på väg mot Klaffbron.
    // Stillhetskravet skyddar — geometrisk träff räcker inte.
    const path = [
      { lat: 58.28790, lon: 12.28575, sog: 2.2 }, // norr om kapseln
      { lat: MANOVER_27KN.lat, lon: MANOVER_27KN.lon, sog: 2.7 }, // inne i kapseln
      { lat: 58.28730, lon: 12.28568, sog: 3.1 }, // fortfarande inne, på väg syd
      { lat: 58.28640, lon: 12.28540, sog: 3.8 }, // ute ur kapseln, mot bron
    ];
    let vessel;
    for (const p of path) {
      vessel = svc.updateVessel('265788210', {
        lat: p.lat, lon: p.lon, sog: p.sog, cog: 195, name: 'EUGENIE',
      });
      tick(1);
    }
    expect(vessel._moored).not.toBe(true);
    expect(vessel.targetBridge).toBe('Klaffbron');
  });

  test('C0b: DORY MAN-klassen — gästhamnsliggare med målbro klassas efter 3 min, inte 15', () => {
    // 42h-fältprovet 2026-08-07: DORY MAN (211411410) och FARUREJ (261005370)
    // gick in i gästhamnen med Klaffbron som målbro, lade till och TYSTNADE på
    // AIS efter 5,6 min stillhet. Det gamla avståndsgrindade köundantaget
    // krävde 15 min ⇒ ingen [MOORED]-rad någonsin ⇒ Homey visade "på väg mot
    // Klaffbron" tills båten timeoutade (27,6 / 39,6 / 32,0 min per fartyg),
    // och den utlovade öppningen klättrade 4 → 5 → 10 → 13 → 18 → 25 min.
    // Med zon-lokal grace faller hon på baskravet 3 min — inom den 5,6 min
    // långa observationsfönstret som fältdatan faktiskt gav oss.
    const ANFLYGNING = [
      { lat: 58.28810, lon: 12.28578, sog: 3.4 }, // norr om kapseln
      { lat: 58.28786, lon: 12.28572, sog: 3.0 }, // nära nordkanten
      { lat: 58.28760, lon: 12.28571, sog: 2.6 }, // inne i kapseln, saktar in
    ];
    let vessel;
    for (const p of ANFLYGNING) {
      vessel = svc.updateVessel('211411410', {
        lat: p.lat, lon: p.lon, sog: p.sog, cog: 195, name: 'DORY MAN',
      });
      tick(1);
    }
    // Förutsättningarna för det GAMLA undantaget är uppfyllda: målbro tilldelad,
    // rörelsebevis satt, och hamnen ligger 354–411 m från Klaffbron (≤600 m).
    expect(vessel.targetBridge).toBe('Klaffbron');
    expect(vessel._hasMovementProof).toBe(true);
    const dTarget = geometry.calculateDistance(
      vessel.lat, vessel.lon, BRIDGES.klaffbron.lat, BRIDGES.klaffbron.lon,
    );
    expect(dTarget).toBeLessThanOrEqual(600);

    // Förtöjer: stillhetsklockan startar vid första sog=0-samplet.
    vessel = svc.updateVessel('211411410', {
      lat: STILLA_CENTER.lat, lon: STILLA_CENTER.lon, sog: 0.0, cog: 195, name: 'DORY MAN',
    });
    expect(vessel._moored).toBe(false); // ännu ingen stilltid ackumulerad

    // Under 3 min gäller fortfarande oskuldspresumtionen (kapseln får inte
    // demotera på ETT sampel — det var hela poängen med stillhetskravet).
    tick(2);
    vessel = svc.updateVessel('211411410', {
      lat: STILLA_CENTER.lat, lon: STILLA_CENTER.lon, sog: 0.0, cog: 195, name: 'DORY MAN',
    });
    expect(vessel._moored).toBe(false);
    expect(vessel.targetBridge).toBe('Klaffbron');

    // Vid 3 min biter kapseln — DETTA är C0b. Före fixen krävdes 15 min och
    // fältets båtar tystnade vid 5,6 min, alltså aldrig.
    tick(1.5);
    vessel = svc.updateVessel('211411410', {
      lat: STILLA_CENTER.lat, lon: STILLA_CENTER.lon, sog: 0.0, cog: 195, name: 'DORY MAN',
    });
    expect(vessel._moored).toBe(true);
    expect(vessel.targetBridge).toBeNull();

    // ...och det ska ha skett INOM fältets observationsfönster (5,6 min).
    expect((Date.now() - vessel._stationarySince) / 60000).toBeLessThan(5.6);
  });

  test('C0b: mekanismen är FÄLTET, inte zonnamnet (grace återinförd ⇒ 15 min igen)', () => {
    // Vakt mot en fix som hårdkodar "gästhamnen får aldrig grace" i koden i
    // stället för att läsa zonposten. Sätts fältet tillbaka på gästhamnen ska
    // det GAMLA beteendet återuppstå exakt — då vet vi att koden är datastyrd
    // och att kajzonens 15 min kommer från dess egen post.
    const original = ZONE.queueGraceMs;
    try {
      ZONE.queueGraceMs = 15 * 60 * 1000;
      const path = [
        { lat: 58.28810, lon: 12.28578, sog: 3.4 },
        { lat: 58.28786, lon: 12.28572, sog: 3.0 },
        { lat: 58.28760, lon: 12.28571, sog: 2.6 },
      ];
      let vessel;
      for (const p of path) {
        vessel = svc.updateVessel('261005370', {
          lat: p.lat, lon: p.lon, sog: p.sog, cog: 195, name: 'FARUREJ',
        });
        tick(1);
      }
      expect(vessel.targetBridge).toBe('Klaffbron');
      for (let min = 0; min <= 5; min++) {
        vessel = svc.updateVessel('261005370', {
          lat: STILLA_CENTER.lat, lon: STILLA_CENTER.lon, sog: 0.0, cog: 195, name: 'FARUREJ',
        });
        expect(vessel._moored).toBe(false); // 15-minutersgrenen aktiv igen
        tick(1);
      }
    } finally {
      ZONE.queueGraceMs = original;
    }
  });

  test('B3×C0b: äkta transit inom 60 m av kapselcentroiden klassas fortfarande ALDRIG', () => {
    // Interaktionsparet B3 × C0b. Fältets äkta Klaffbron-passager gick rakt
    // genom kapseln (MS JUTLAND 7,2 kn på 27 m från centrumlinjen, SKYBIRD
    // 2,9 kn på 32 m) och behöll 6/6 notiser vardera. C0b sänker tröskeln för
    // STILLASTÅENDE båtar — rörliga får inte röras, oavsett hur nära mitten de
    // går. Skyddet är stillhetskravet, inte graceperioden: en båt i fart når
    // aldrig zonlagret, så tröskelvärdet är irrelevant för henne.
    const spar = [
      { lat: 58.28800, lon: 12.28560, sog: 7.2 },
      { lat: 58.28767, lon: 12.28563, sog: 7.2 },
      { lat: KAPSEL_CENTROID.lat, lon: 12.28567, sog: 6.8 }, // rakt över centroiden
      { lat: 58.28714, lon: 12.28572, sog: 6.4 },
      { lat: 58.28660, lon: 12.28550, sog: 6.0 },
    ];
    let vessel;
    for (const p of spar) {
      vessel = svc.updateVessel('219000606', {
        lat: p.lat, lon: p.lon, sog: p.sog, cog: 195, name: 'MS JUTLAND',
      });
      // Minsta avstånd till centroiden längs spåret ska verkligen vara <60 m,
      // annars provar testet inte det den påstår.
      const dc = geometry.calculateDistance(
        p.lat, p.lon, KAPSEL_CENTROID.lat, KAPSEL_CENTROID.lon,
      );
      if (p.sog === 6.8) expect(dc).toBeLessThan(60);
      tick(1);
    }
    expect(vessel._moored).not.toBe(true);
    expect(vessel.targetBridge).toBe('Klaffbron');
    // Ingen [MOORED]-rad får ha loggats för henne under hela transiten.
    const mooredRader = logger.log.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('[MOORED]') && s.includes('219000606'));
    expect(mooredRader).toEqual([]);
  });

  test('KÖUNDANTAGET I KAJZONEN: 15-minutersgrenen håller, 3-minutersgrenen gör det inte', () => {
    // F-8b/C0b-vakt (2026-08-08): köundantaget (VesselDataService._classifyMooring,
    // zoneMinStillMs 3 → 15 min när target + rörelsebevis + ≤600 m) skrevs för
    // ELFKUNGEN-fallet i KAJZONEN — en köande båt 161–290 m från Klaffbron fick
    // annars ETT stillasample att demotera henne 4,5 min före passagen.
    // C0b ska göra undantaget ZON-LOKALT (gästhamnen tappar det), men kajzonens
    // grace ska stå kvar EXAKT som i dag. Raden fäller varje C0b-variant som
    // river undantaget brett i stället för per zon.
    const KAJ_MITT = { lat: 58.286060, lon: 12.285651 }; // 240,5 m N Klaffbron
    const anflygning = [
      { lat: 58.28760, lon: 12.28600, sog: 3.4 },
      { lat: 58.28700, lon: 12.28585, sog: 3.6 },
      { lat: 58.28650, lon: 12.28572, sog: 3.2 },
      { lat: KAJ_MITT.lat, lon: KAJ_MITT.lon, sog: 2.4 },
    ];
    let vessel;
    for (const p of anflygning) {
      vessel = svc.updateVessel('999000111', {
        lat: p.lat, lon: p.lon, sog: p.sog, cog: 195, name: 'KOARE',
      });
      tick(1);
    }
    expect(vessel.targetBridge).toBe('Klaffbron');
    expect(vessel._hasMovementProof).toBe(true);

    // Stillhet i kajzonen: 3-minutersgrenen får INTE bita på en köare.
    for (let min = 1; min <= 14; min++) {
      vessel = svc.updateVessel('999000111', {
        lat: KAJ_MITT.lat, lon: KAJ_MITT.lon, sog: 0.0, cog: 195, name: 'KOARE',
      });
      expect(vessel._moored).toBe(false);
      expect(vessel.targetBridge).toBe('Klaffbron');
      tick(1);
    }

    // ...men graceperioden är ändlig: efter 15 min klassas hon som förtöjd.
    // (Låser även övre änden så en fix inte gör undantaget oändligt.)
    for (let min = 15; min <= 17; min++) {
      vessel = svc.updateVessel('999000111', {
        lat: KAJ_MITT.lat, lon: KAJ_MITT.lon, sog: 0.0, cog: 195, name: 'KOARE',
      });
      tick(1);
    }
    expect(vessel._moored).toBe(true);
    expect(vessel.targetBridge).toBeNull();
  });

  test('KAJZONENS NORRA SPETS: graceperioden gäller HELA kapseln (fäller 600→300 m)', () => {
    // Den trubbiga varianten "byt bara 600 → 300 m" ser ut att fungera för
    // zonernas mittpunkter men river köskyddet i kajzonens norra ände: den
    // sträcker sig till 320,2 m från Klaffbron, alltså UTANFÖR en 300 m-grind.
    // En båt som köar där skulle demoteras av ett stillasample — exakt
    // ELFKUNGEN-regressionen som undantaget en gång skrevs för.
    const KAJ_NORD = { lat: 58.286620, lon: 12.286379 }; // 315,1 m N Klaffbron
    expect(geometry.distancePointToSegmentM(
      KAJ_NORD.lat, KAJ_NORD.lon,
      KAJZON.start.lat, KAJZON.start.lon, KAJZON.end.lat, KAJZON.end.lon,
    )).toBeLessThanOrEqual(KAJZON.radiusM); // inne i kajzonen
    const dK = geometry.calculateDistance(
      KAJ_NORD.lat, KAJ_NORD.lon, BRIDGES.klaffbron.lat, BRIDGES.klaffbron.lon,
    );
    expect(dK).toBeGreaterThan(300); // ...men utanför en 300 m-grind
    expect(dK).toBeLessThan(600); // ...och innanför den nuvarande 600 m-grinden

    const anflygning = [
      { lat: 58.28760, lon: 12.28640, sog: 3.4 },
      { lat: 58.28710, lon: 12.28650, sog: 3.6 },
      { lat: 58.28680, lon: 12.28645, sog: 3.2 },
      { lat: KAJ_NORD.lat, lon: KAJ_NORD.lon, sog: 2.4 },
    ];
    let vessel;
    for (const p of anflygning) {
      vessel = svc.updateVessel('999000222', {
        lat: p.lat, lon: p.lon, sog: p.sog, cog: 195, name: 'NORDKOARE',
      });
      tick(1);
    }
    expect(vessel.targetBridge).toBe('Klaffbron');
    expect(vessel._hasMovementProof).toBe(true);

    // Köar still i 10 min — får INTE demoteras (grace gäller hela kapseln).
    for (let min = 1; min <= 10; min++) {
      vessel = svc.updateVessel('999000222', {
        lat: KAJ_NORD.lat, lon: KAJ_NORD.lon, sog: 0.0, cog: 195, name: 'NORDKOARE',
      });
      expect(vessel._moored).toBe(false);
      expect(vessel.targetBridge).toBe('Klaffbron');
      tick(1);
    }
  });
});
