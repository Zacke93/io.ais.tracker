'use strict';

/**
 * M1 (helkodsgranskning RUNDA 4, 2026-08-23, critical) — C9b:s
 * 30-MINUTERSGRIND VAR SJÄLVUPPHÄVANDE.
 *
 * MEKANISMEN. Jitterhållet `_stillnessJitterHolds` kräver (villkor 2) att
 * stillhetsankaret är minst BRIDGE_OPENING.ARM_STALE_TTL_MS (30 min) gammalt.
 * Men ankaret sattes BARA i blocket där stillhetsklockan startar, och nollades
 * i SAMMA gren som klockan (sog ≥ MOVEMENT_PROOF_SOG_KN ⇒ båda null). Ankarets
 * ålder var därför per konstruktion IDENTISK med klockans, och villkoret kunde
 * bara uppfyllas av en båt som legat 30 minuter utan ett enda prov över 0,5 kn.
 * Precis den population hållet skrevs för — kajliggare med BRUSIG fartgivare —
 * var alltså utestängd, och förtöjningsklassningen styrdes av AIS-glapp i
 * stället för av båtens faktiska tillstånd.
 *
 * FÄLTFALLET (CARAT 211452170, korpus 20260804-both-21h): kaj 401–420 m norr om
 * Klaffbron 00:04–07:28 med sog-brus 0,1–7,4 kn och max ~26 m nettoförflyttning.
 * Vartannat prov låg över 0,5 kn, så klockan hann aldrig nå kajzonens
 * 3-minuterskrav. Resultat: 74 minuters falsk "En båt på väg mot Klaffbron,
 * beräknad broöppning om N minuter" (04:29–05:43) för en båt som låg still.
 *
 * FIXEN skiljer klocka från ankare: klockan nollas av varje obesvarat
 * rörelsesampel som förr, medan ankaret — den PLATS vistelsen mäts ifrån —
 * kastas i EXAKT TVÅ fall: när det saknas (eller är omätbart) och när nettot
 * från det når MOVEMENT_PROOF_NET_M (äkta avgång). Se
 * `_stillnessAnchorInvalidated`, som numera tar ETT argument.
 *
 * ⚠️ RÄTTAT 2026-08-23 (N25, RUNDA 5). Stycket ovan hade ett TREDJE led —
 * "eller vid ett GPS-flaggat prov" — och det stämmer inte längre: N25 tog bort
 * både ledet och predikatets gpsSuspect-parameter. Ledet skyddade ingenting
 * (villkor (1) i `_stillnessJitterHolds` nollar ändå klockan på ett flaggat
 * prov, så ingen målbro kan demoteras av det) men kostade 30 minuters
 * ommognad per flaggat prov, eftersom ankaret sedan M1 bär VISTELSENS ålder
 * och inte klockans — uppmätt i pipelinen: förtöjd efter 34 min blev 70 min.
 * Filens EGEN omlåsta assertion (~:442/453) låser numera motsatsen: ett
 * flaggat prov VID ankaret (netto 0 m) BEHÅLLER ankaret, och ~:468 vaktar att
 * signaturen inte får tillbaka en andra parameter. Pipelinebeviset ligger i
 * n25-gps-flaggat-stillhetsankare.test.js.
 *
 * GRÅZONEN 0,3–0,5 kn rörde M1 inte. N7 (RUNDA 5, 2026-08-23) gjorde det:
 * grenen frågar numera _stillnessJitterHolds innan den nollar KLOCKAN — men
 * skriver fortfarande aldrig ankaret, vilket karakteriseringstestet nedan
 * ("GRÅZONEN … ankaret rörs aldrig") låser. Se n7-grazonens-jitterhall.test.js.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const constants = require('../lib/constants');

const KLAFF = { lat: 58.28409551543077, lon: 12.283929525245636 };
// CARAT:s faktiska kajläge: inne i kapseln "Gästhamnen norr om Klaffbron"
// (radie 35 m), ~412 m norr om Klaffbron. Zonen har queueGraceMs 0, så
// stillhetskravet är baskravet 3 min.
const QUAY = { lat: 58.28767, lon: 12.285705 };
const M_PER_DEG_LAT = 111320; // meridiangraden
const ZON_MIN_STILL_MS = 3 * 60 * 1000; // _classifyMooring:s baskrav för zonlagret
const { ARM_STALE_TTL_MS } = constants.BRIDGE_OPENING;
const NET_M = constants.MOORING_DETECTION.MOVEMENT_PROOF_NET_M;

// KÖ-ZONEN — M1:s NYA BETEENDEGRÄNS (granskarfynd runda 4, korrekthetslinsen).
// "Kajen norr om Klaffbron" är den ENDA zon som bär kö-nåd (queueGraceMs
// 15 min, se constants.MOORING_ZONES). Punkten nedan är kapsellinjens
// mittpunkt: uppmätt 235 m från Klaffbron, alltså INNE i väntzonen (≤300 m)
// och långt inom kö-undantagets 600 m-villkor. Zonen är därför den plats där
// ankarmognaden (30 min) och kö-nåden (15 min) staplas på varandra.
const KO_ZON = constants.MOORING_ZONES.find((z) => z.name === 'Kajen norr om Klaffbron');
const KO = { lat: 58.286060, lon: 12.285651 };
const KO_KADENS_MS = 2 * 60 * 1000; // CARAT:s egen sampelkadens

const logger = {
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

const liveServices = [];
let NOW = 0;
let nowSpy = null;

function makeVDS() {
  const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  svc.app = {
    gpsJumpGateService: null,
    passageLatchService: null,
    routeOrderValidator: null,
    debug: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
  };
  liveServices.push(svc);
  return svc;
}

/**
 * KÖ I KAJZONEN GENOM RIKTIGA PIPELINEN. Anflygning söderut i 2,5 kn (78 m per
 * 60 s) ger målbro Klaffbron + rörelsebevis — båda är villkor för att zonens
 * kö-nåd alls ska gälla — och därefter kö på kapsellinjen med angiven
 * sog-profil och ±6 m positionsjitter. Inga interna fält injiceras: allt går
 * via updateVessel.
 * @param {string} mmsi
 * @param {number[]} sogCykel - sog-profil som upprepas
 * @param {number} minuter - hur länge hon ligger kvar i kön
 * @returns {Object} mätvärden (mooredAtMs = ms från köns början till förtöjd)
 */
function koaIKajzonen(mmsi, sogCykel, minuter) {
  const svc = makeVDS();
  const send = (lat, lon, sog, dt) => {
    NOW += dt;
    svc.updateVessel(mmsi, {
      mmsi, lat, lon, sog, cog: 200, name: 'KOARE', timestamp: NOW,
    });
    return svc.vessels.get(mmsi);
  };
  for (let i = 0; i < 6; i++) {
    send(58.2895 - (i * 0.0007), KO.lon, 2.5, i === 0 ? 0 : 60000);
  }
  const efterAnflygning = svc.vessels.get(mmsi);
  const t0 = NOW;
  const ut = {
    zon: svc._findMooringZone({ lat: KO.lat, lon: KO.lon })?.name ?? null,
    target: efterAnflygning.targetBridge,
    rorelsebevis: efterAnflygning._hasMovementProof,
    mooredAtMs: null,
    ankarAlderMs: null,
    klockAlderMs: null,
    targetEfter: null,
  };
  for (let i = 0; i * KO_KADENS_MS < minuter * 60000; i++) {
    const v = send(
      KO.lat + (((i % 3) - 1) * 6) / M_PER_DEG_LAT,
      KO.lon,
      sogCykel[i % sogCykel.length],
      KO_KADENS_MS,
    );
    if (v._moored && ut.mooredAtMs === null) {
      ut.mooredAtMs = NOW - t0;
      ut.ankarAlderMs = v._stillnessAnchor ? NOW - v._stillnessAnchor.t : null;
      ut.klockAlderMs = v._stationarySince ? NOW - v._stationarySince : null;
    }
  }
  ut.targetEfter = svc.vessels.get(mmsi).targetBridge ?? null;
  return ut;
}

beforeAll(() => {
  global.__TEST_MODE__ = true;
});

afterAll(() => {
  delete global.__TEST_MODE__;
});

beforeEach(() => {
  NOW = 1754000000000;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => NOW);
});

afterEach(() => {
  while (liveServices.length > 0) {
    const svc = liveServices.pop();
    try {
      svc.clearAllTimers();
    } catch (_) { /* tomt */ }
  }
  if (nowSpy) nowSpy.mockRestore();
  jest.clearAllMocks();
});

describe('M1: ihållande stillhetsankare', () => {
  test('CARAT-KLASSEN blir förtöjd — brusig fartgivare låser inte längre ut hållet', () => {
    const svc = makeVDS();
    const mmsi = '211452170';
    const t0 = NOW;
    let mooredAt = null;
    // 2 minuters kadens, vartannat prov över MOVEMENT_PROOF_SOG_KN — CARAT:s
    // egen profil. Positionen jitterar ±6 m, alltså långt under NET_M.
    const sogCykel = [0.1, 0.8, 0.2, 1.2, 0.1, 0.6, 0.2, 1.5, 0.1, 0.7];
    for (let i = 0; i < 25; i++) {
      NOW += 2 * 60 * 1000;
      svc.updateVessel(mmsi, {
        mmsi,
        lat: QUAY.lat + ((i % 3) - 1) * 6 / M_PER_DEG_LAT,
        lon: QUAY.lon,
        sog: sogCykel[i % sogCykel.length],
        cog: 10,
        name: 'CARAT',
        timestamp: NOW,
      });
      const v = svc.vessels.get(mmsi);
      if (v._moored && mooredAt === null) mooredAt = NOW;
    }
    expect(mooredAt).not.toBeNull();
    // Hållet är AVSIKTLIGT stängt de första 30 minuterna (C9b:s villkor 2 —
    // en köare får inte smygas in i förtöjningsklassningen av sin egen
    // inbromsning). Klassningen ska därför komma EFTER ankarmognaden, men
    // inom två stillhetskrav därefter — inte "aldrig", som på HEAD.
    expect(mooredAt - t0).toBeGreaterThanOrEqual(ARM_STALE_TTL_MS);
    expect(mooredAt - t0).toBeLessThanOrEqual(ARM_STALE_TTL_MS + 2 * ZON_MIN_STILL_MS);
    // Ankaret står kvar där vistelsen började — det får aldrig krypa med
    // kajvobbeln (då nollas netto-benet gång på gång).
    const v = svc.vessels.get(mmsi);
    expect(v._stillnessAnchor).not.toBeNull();
    expect(v._stillnessAnchor.t).toBeLessThanOrEqual(t0 + 2 * 60 * 1000);
  });

  test('ÄKTA AVGÅNG släpper omedelbart — på samma sampel som nettot passerar 50 m', () => {
    const svc = makeVDS();
    const mmsi = '211452171';
    const sogCykel = [0.1, 0.8, 0.2, 1.2, 0.1, 0.6, 0.2, 1.5, 0.1, 0.7];
    for (let i = 0; i < 25; i++) {
      NOW += 2 * 60 * 1000;
      svc.updateVessel(mmsi, {
        mmsi,
        lat: QUAY.lat + ((i % 3) - 1) * 6 / M_PER_DEG_LAT,
        lon: QUAY.lon,
        sog: sogCykel[i % sogCykel.length],
        cog: 10,
        name: 'AVGANG',
        timestamp: NOW,
      });
    }
    expect(svc.vessels.get(mmsi)._moored).toBe(true);

    // CARAT:s verkliga avgång: 520 m på 277 s (≈3,6 kn, förenligt med sog 3,7).
    NOW += 277000;
    svc.updateVessel(mmsi, {
      mmsi,
      lat: QUAY.lat - 520 / M_PER_DEG_LAT,
      lon: QUAY.lon,
      sog: 3.7,
      cog: 200,
      name: 'AVGANG',
      timestamp: NOW,
    });
    const v = svc.vessels.get(mmsi);
    expect(v._moored).toBe(false);
    expect(v._stationarySince).toBeNull();
    // Ankaret kastas OCKSÅ vid äkta avgång — annars hade nästa stillastående
    // läge mätts mot en plats hon lämnat.
    expect(v._stillnessAnchor).toBeNull();
  });

  test('KÖAREN inom 30 min beter sig EXAKT som före fixen (C9b:s villkor 2 orört)', () => {
    const svc = makeVDS();
    const mmsi = '265900001';
    // Kryp-köare som pausar i kajkapseln i 20 minuter med samma brusprofil.
    const sogCykel = [0.1, 0.8, 0.2, 1.2, 0.1];
    for (let i = 0; i < 10; i++) {
      NOW += 2 * 60 * 1000;
      svc.updateVessel(mmsi, {
        mmsi,
        lat: QUAY.lat + ((i % 3) - 1) * 6 / M_PER_DEG_LAT,
        lon: QUAY.lon,
        sog: sogCykel[i % sogCykel.length],
        cog: 10,
        name: 'KOARE',
        timestamp: NOW,
      });
      // Under ankarmognaden nollas klockan av varje brusprov, precis som förr.
      expect(svc.vessels.get(mmsi)._moored).toBe(false);
    }
  });

  test('KÖ-ZONENS GRÄNS: brusig köare förtöjs först efter ankarmognad + kö-nåd — ren givare gör det redan på HEAD', () => {
    // GRANSKARFYND RUNDA 4 (korrekthetslinsen): M1 förflyttar en beteendegräns
    // som ingen svit låste. Karakteriseringstestet ovan slutar vid 20 minuter,
    // alltså EXAKT innan det nya beteendet börjar, så ARM_STALE_TTL_MS eller
    // zonens kö-nåd kunde ändras utan att något föll.
    //
    // UPPMÄTT 2026-08-23 i TVÅ isolerade träd (HEAD 0b72310 byggt med
    // git archive, arbetsträdet som rsync-kopia), samma rigg som nedan:
    //   brusig givare (vartannat prov ≥0,5 kn): HEAD ALDRIG förtöjd (120 min
    //     utan klassning, målbron kvar) → arbetsträdet förtöjd efter 46 min.
    //   ren givare (alla prov <0,3 kn): 18 min i BÅDA armarna, målbron släpps
    //     i båda.
    // LÅSNINGEN DOKUMENTERAR ALLTSÅ KONVERGENS, INTE NY RISK: den brusiga
    // klassen rör sig från "aldrig" mot det beteende en REN givare redan har på
    // HEAD, och är fortfarande 2,5 gånger mer generös (46 mot 18 min). Att
    // göra något åt den skillnaden är ett DESIGNBESLUT, inte en bugg — men det
    // får inte längre ske av våda.
    //
    // HÄRLEDNINGEN (varför just 46 min vid 2 min kadens): ankaret sätts vid
    // första stillasamplet t0+2 min och ÖVERLEVER brusproven (M1). Villkor (2)
    // i _stillnessJitterHolds mognar alltså vid t0+32 min; först då slutar
    // brusproven nolla klockan, som står från föregående stillasampel
    // (t0+30 min). Zonens kö-nåd är 15 min ⇒ förtöjd på samplet t0+46 min.
    expect(KO_ZON).toBeDefined();
    // KONSTANTVAKT — de två talen gränsen är byggd av. Ändras något av dem
    // faller raderna nedan MED FLIT: mät om gränsen i två isolerade träd och
    // skriv in det nya talet här, i stället för att låta den glida tyst.
    expect(ARM_STALE_TTL_MS).toBe(30 * 60 * 1000);
    expect(KO_ZON.queueGraceMs).toBe(15 * 60 * 1000);

    const brusig = koaIKajzonen('265900005', [0.1, 0.8, 0.2, 1.2, 0.1, 0.6, 0.2, 1.5, 0.1, 0.7], 60);
    // Riggen måste vara det den utger sig för: rätt zon, målbro och rörelsebevis —
    // utan alla tre gäller baskravet 3 min och gränsen vore en annan.
    expect(brusig.zon).toBe('Kajen norr om Klaffbron');
    expect(brusig.target).toBe('Klaffbron');
    expect(brusig.rorelsebevis).toBe(true);

    // SIDA 1 — INTE FÖRE gränsen. C9b:s villkor (2) är avsiktligt stängt under
    // ankarmognaden, och zonens kö-nåd löper först därefter.
    const GRANS_MS = ARM_STALE_TTL_MS + KO_ZON.queueGraceMs; // 45 min
    expect(brusig.mooredAtMs).not.toBeNull();
    expect(brusig.mooredAtMs).toBeGreaterThanOrEqual(GRANS_MS);
    // SIDA 2 — MEN DIREKT DÄREFTER (inom ett kadenssteg), inte "aldrig".
    expect(brusig.mooredAtMs).toBeLessThanOrEqual(GRANS_MS + KO_KADENS_MS);
    // Det exakta talet låses också: en ändring av NÅGON av de två konstanterna
    // flyttar det, även om båda banden ovan skulle följa med.
    expect(brusig.mooredAtMs).toBe(46 * 60 * 1000);

    // MEKANISMEN som bär gränsen: vid klassningen är ANKARET moget men KLOCKAN
    // yngre än så. På HEAD var de två åldrarna identiska per konstruktion — det
    // är hela M1.
    expect(brusig.ankarAlderMs).toBeGreaterThanOrEqual(ARM_STALE_TTL_MS);
    expect(brusig.klockAlderMs).toBeLessThan(brusig.ankarAlderMs);
    // Följden av klassningen: målbron släpps (demotering). Samma sak som händer
    // den rena givaren redan på HEAD.
    expect(brusig.targetEfter).toBeNull();

    // KONTROLLMÄTNINGEN — ren givare, samma zon, samma rigg. Talet 18 min är
    // HEAD:s eget och är OFÖRÄNDRAT av M1 (uppmätt i båda armarna). Den här
    // raden är inte en låsning av M1 utan referensen som gör 46 min tolkbart.
    const ren = koaIKajzonen('265900006', [0.1, 0.2, 0.1, 0.15], 60);
    expect(ren.zon).toBe('Kajen norr om Klaffbron');
    expect(ren.mooredAtMs).toBe(18 * 60 * 1000);
    expect(ren.targetEfter).toBeNull();
    // Konvergens, inte likhet: den brusiga klassen är fortfarande drygt 2,5
    // gånger mer generöst behandlad än den rena.
    expect(brusig.mooredAtMs).toBeGreaterThan(ren.mooredAtMs * 2);
  });

  test('KRYPANDE KÖARE (TIM-klassen) passerar bron — förtöjningen bryter inte passagen', () => {
    const svc = makeVDS();
    const mmsi = '265900002';
    const step = (dNorthM, sog, dt) => {
      NOW += dt;
      svc.updateVessel(mmsi, {
        mmsi,
        lat: KLAFF.lat + dNorthM / M_PER_DEG_LAT,
        lon: KLAFF.lon,
        sog,
        cog: 200, // sydgående
        name: 'TIM',
        timestamp: NOW,
      });
      return svc.vessels.get(mmsi);
    };
    // Anflygning norrifrån i 3 kn ⇒ målbro + rörelsebevis.
    step(700, 3.0, 0);
    step(560, 3.0, 90000);
    step(420, 3.0, 90000);
    expect(svc.vessels.get(mmsi).targetBridge).toBe('Klaffbron');
    // KÖN: 303 m från bron, sog 0 i 6 minuter (TIM-profilen).
    step(303, 0, 90000);
    for (let i = 0; i < 6; i++) step(303, 0, 60000);
    // Öppningen kommer: hon fortsätter och passerar.
    step(150, 2.5, 60000);
    step(20, 3.0, 60000);
    step(-90, 3.5, 60000);
    const v = step(-260, 3.5, 60000);
    expect(v.passedBridges).toContain('Klaffbron');
    expect(v._moored).toBe(false);
  });

  test('BLANDSÄNDARE: null-sog-vägens klockstart får inte stämpla om ett giltigt ankare', () => {
    const svc = makeVDS();
    const mmsi = '265900004';
    const t0 = NOW;
    // (1) Finita prover: ankaret sätts vid första stillasamplet och överlever
    //     brusprovet (M1) — klockan nollas.
    NOW += 60000;
    svc.updateVessel(mmsi, {
      mmsi, lat: QUAY.lat, lon: QUAY.lon, sog: 0.1, cog: 10, name: 'BLAND', timestamp: NOW,
    });
    const ank0 = svc.vessels.get(mmsi)._stillnessAnchor;
    expect(ank0.t).toBeLessThanOrEqual(t0 + 60000);
    NOW += 60000;
    svc.updateVessel(mmsi, {
      mmsi, lat: QUAY.lat, lon: QUAY.lon, sog: 1.2, cog: 10, name: 'BLAND', timestamp: NOW,
    });
    expect(svc.vessels.get(mmsi)._stationarySince).toBeNull();

    // (2) Lång tystnad i fartgivaren: två sog=null-prov inom jitterradien
    //     startar klockan igen via positionsvägen — 40 minuter senare.
    NOW += 40 * 60 * 1000;
    svc.updateVessel(mmsi, {
      mmsi, lat: QUAY.lat, lon: QUAY.lon, sog: null, cog: 10, name: 'BLAND', timestamp: NOW,
    });
    NOW += 60000;
    svc.updateVessel(mmsi, {
      mmsi, lat: QUAY.lat, lon: QUAY.lon, sog: null, cog: 10, name: 'BLAND', timestamp: NOW,
    });
    const v = svc.vessels.get(mmsi);
    expect(Number.isFinite(v._stationarySince)).toBe(true);
    // KÄRNAN: fönsterankaret är fortfarande det GAMLA. Stämplades det om till
    // null-sog-ankarets färska tid vore ankaråldern åter lika med klockåldern
    // för hela blandsändarklassen och M1 vore verkningslös för dem.
    expect(v._stillnessAnchor.t).toBe(ank0.t);
  });

  test('GRÅZONEN 0,3–0,5 kn med UNGT ankare: två prover nollar klockan, ankaret rörs aldrig', () => {
    // N7 (RUNDA 5, 2026-08-23) lade till ett jitterhåll i den här grenen, men
    // hållet kräver ett ankare som är minst ARM_STALE_TTL_MS (30 min) gammalt.
    // Ankaret nedan är 1–2 minuter gammalt, så grenen beter sig EXAKT som före
    // N7 — det är den halvan det här testet låser. Den mogna halvan låses i
    // n7-grazonens-jitterhall.test.js. Ankaret skrivs aldrig i grenen, varken
    // före eller efter N7.
    const svc = makeVDS();
    const mmsi = '265900003';
    NOW += 60000;
    svc.updateVessel(mmsi, {
      mmsi, lat: QUAY.lat, lon: QUAY.lon, sog: 0.1, cog: 10, name: 'GRAZON', timestamp: NOW,
    });
    const start = svc.vessels.get(mmsi)._stationarySince;
    const ank = svc.vessels.get(mmsi)._stillnessAnchor;
    expect(Number.isFinite(start)).toBe(true);
    expect(ank).not.toBeNull();
    // Ett gråzonsprov: klockan lever (hysteresen kräver två) …
    NOW += 60000;
    svc.updateVessel(mmsi, {
      mmsi, lat: QUAY.lat, lon: QUAY.lon, sog: 0.4, cog: 10, name: 'GRAZON', timestamp: NOW,
    });
    expect(svc.vessels.get(mmsi)._stationarySince).toBe(start);
    expect(svc.vessels.get(mmsi)._stillnessAnchor).toEqual(ank);
    // … två i rad nollar klockan, men ALDRIG ankaret (varken före eller efter M1).
    NOW += 60000;
    svc.updateVessel(mmsi, {
      mmsi, lat: QUAY.lat, lon: QUAY.lon, sog: 0.4, cog: 10, name: 'GRAZON', timestamp: NOW,
    });
    expect(svc.vessels.get(mmsi)._stationarySince).toBeNull();
    expect(svc.vessels.get(mmsi)._stillnessAnchor).toEqual(ank);
  });

  test('_stillnessAnchorInvalidated: saknat ankare och 50 m kastar — jitter och GPS-flagga gör det inte', () => {
    const svc = makeVDS();
    const v = { lat: QUAY.lat, lon: QUAY.lon, _stillnessAnchor: null };
    expect(svc._stillnessAnchorInvalidated(v)).toBe(true); // saknat
    v._stillnessAnchor = { lat: QUAY.lat, lon: QUAY.lon, t: NOW - 60 * 60 * 1000 };
    // OMLÅST RAD (N7/N8/N25-leveransen, RUNDA 5, 2026-08-23). Raden löd
    // `expect(svc._stillnessAnchorInvalidated(v, true)).toBe(true); // GPS-flaggat`
    // och låste M1:s tredje led. N25 tog bort ledet: efter M1 bär ankaret
    // VISTELSENS ålder, så ett enda GPS-flaggat prov kostade 30 minuters
    // ommognad (uppmätt i pipelinen: förtöjd 34 min → 70 min) medan
    // skyddsvärdet var NOLL — _stillnessJitterHolds returnerar redan falskt på
    // sitt eget villkor (1) för samma prov, så klockan nollas ändå och ingen
    // målbro kan demoteras av ett flaggat prov. Predikatet tar därför ingen
    // gpsSuspect-parameter längre; raden nedan prövar att ett flaggat prov VID
    // ankaret (netto 0 m) numera behåller ankaret. Se n25-gps-flaggat-
    // stillhetsankare.test.js för pipelinebeviset.
    expect(svc._stillnessAnchorInvalidated(v)).toBe(false); // 0 m jitter, flagga eller ej
    // Strax UNDER tröskeln behålls, PÅ tröskeln kastas (samma gräns som
    // villkor 3 i _stillnessJitterHolds och som rörelsebeviset).
    v.lat = QUAY.lat + (NET_M - 5) / M_PER_DEG_LAT;
    expect(svc._stillnessAnchorInvalidated(v)).toBe(false);
    v.lat = QUAY.lat + (NET_M + 5) / M_PER_DEG_LAT;
    expect(svc._stillnessAnchorInvalidated(v)).toBe(true);
    // Ogiltig position ⇒ omätbart netto ⇒ konservativt kast.
    v.lat = null;
    expect(svc._stillnessAnchorInvalidated(v)).toBe(true);
    // SIGNATURVAKT: en kvarglömd andra parameter får inte kunna smyga tillbaka
    // gpsSuspect-ledet. Anropas predikatet med flaggan sann ska svaret bero på
    // GEOMETRIN, inte på flaggan.
    v.lat = QUAY.lat;
    expect(svc._stillnessAnchorInvalidated(v, true)).toBe(false);
    expect(svc._stillnessAnchorInvalidated.length).toBe(1);
  });
});
