'use strict';

/**
 * M16 — PRÖVAD OCH ÅTERKALLAD (helkodsgranskning runda 4, 2026-08-23).
 * KARAKTERISERINGSTEST AV DET BEVARADE HEAD-BETEENDET.
 *
 * VAD M16 VAR. Fältlistan i `_createVesselObject` stämplar `lastActiveTime` så
 * snart `data.sog > 2.0`, och ger ett HELT NYTT fartyg stämpeln "nu". M16
 * krävde i stället positionskorroborering: sog > 2,0 OCH minst
 * MOVEMENT_PROOF_NET_M (50 m) netto mot ett ackumulerande aktivitetsankare,
 * samt null för nytt fartyg. Motivet var CARAT-klassen — en kajliggare vars
 * brusiga fartgivare förlängde sin egen falska målbro.
 *
 * VARFÖR DEN ÅTERKALLADES. `lastActiveTime` har EN konsument: `recentlyActive`
 * i kö-zonsvakten (VesselDataService ~:541). Vakten HÅLLER KVAR målbron för en
 * nyss aktiv, rörelsebevisad båt som pausar inom 600 m från målbron — en KÖARE
 * inför broöppningen, inte en ankrare. Fartklassen 0,5–2,0 kn når ALDRIG
 * M16:s sog-tröskel, så `lastActiveTime` förblev null hela resan och vakten
 * dog för just den klassen. Finit-vägens systerstämpel (~:2886) räddar inte
 * saken: den mäter mot FÖREGÅENDE prov, och vid 1,5 kn och tät kadens blir
 * steget 7–46 m — under samma 50-meterströskel.
 *
 * MÄTNINGEN (riktiga pipelinen, två isolerade träd, sonden nedan):
 *   kadens 10 s: HEAD håller målbron 870 s — med M16 tappas den efter 10 s
 *   kadens 30 s: HEAD 870 s — med M16 150 s
 *   kadens 60 s: HEAD 960 s — med M16 240 s
 * Granskarens egen sond gav 600 s mot 120 s. M16 gav samtidigt NOLL
 * facitrörelse över alla 18 korpusar — korpusarna mäter inte mekanismen.
 *
 * VAD TESTET LÅSER: att en äkta köare i 1,5 kn som pausar ~437 m från
 * Klaffbron behåller målbron i minst 600 s via TARGET_QUEUE_ZONE, och att
 * vakten är TIDSBEGRÄNSAD (20-minutersfönstret klingar av). Återinförs M16:s
 * grind faller de här testerna — det är mutationsprovet.
 *
 * OBS: fyndet M16 skrevs för (kajbrus som förlänger falsk målbro) är därmed
 * ÖPPET igen. Rätt väg enligt granskaren är att ge BÅDA stämplarna ett
 * ackumulerande ankare samtidigt, inte bara fältlistans.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const constants = require('../lib/constants');

const KLAFF = constants.BRIDGES.klaffbron;
const M_PER_DEG_LAT = 111320; // meridiangraden

// Kö-zonsvaktens egna villkor, som riggen måste hamna innanför:
const KO_ZON_MAX_M = 600; // vaktens avståndsvillkor (literal i VDS ~:543)
const AKTIVITETSFONSTER_MS = 20 * 60 * 1000; // vaktens tidsvillkor (VDS ~:542)
const HALL_KRAV_MS = 600 * 1000; // uppdragets krav: minst 600 s

// Sonden: pausläge 437 m NORR om Klaffbron, rakt i farleden. Punkten ligger
// medvetet UTANFÖR båda kajkapslarna (närmaste, "Kajen norr om Klaffbron",
// är >200 m bort) så förtöjningslagren inte blandar sig i mätningen.
const PAUS_M = 437;
const START_M = 700;
const KO_SOG = 1.5; // mitt i klassen 0,5–2,0 kn: över MOVEMENT_PROOF_SOG_KN
const KO_MPS = 0.7717; // 1,5 kn i m/s

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
 * KÖAREN GENOM RIKTIGA PIPELINEN. Inga interna fält injiceras: allt går via
 * updateVessel, och både målbro och rörelsebevis uppstår av färden själv.
 *
 * FAS 1 — anflygning söderut i 1,5 kn från 700 m till ~437 m från Klaffbron.
 * Ger målbro Klaffbron och `_hasMovementProof` (1,5 ≥ MOVEMENT_PROOF_SOG_KN).
 * FAS 2 — pausen: hon ligger kvar på ~437 m med ±3 m positionsjitter men
 * rapporterar fortfarande 1,5 kn (ström/manöverbrus). Jittret är mindre än
 * MIN_APPROACH_DISTANCE, så tvåprovsvalideringen underkänner varje sampel och
 * nådafristen startar — det är där kö-zonsvakten avgör saken.
 * @param {string} mmsi - fartygets mmsi
 * @param {number} kadensMs - sampelkadens
 * @param {number} pausMinuter - hur länge pausen får pågå
 * @returns {Object} mätvärden från sonden
 */
function koarePausar(mmsi, kadensMs, pausMinuter) {
  const svc = makeVDS();
  const send = (nordM, sog, dt) => {
    NOW += dt;
    svc.updateVessel(mmsi, {
      mmsi,
      lat: KLAFF.lat + nordM / M_PER_DEG_LAT,
      lon: KLAFF.lon,
      sog,
      cog: 180,
      name: 'KOARE',
      timestamp: NOW,
    });
    return svc.vessels.get(mmsi);
  };

  const steg = KO_MPS * (kadensMs / 1000);
  let nordM = START_M;
  let forsta = null;
  let i = 0;
  while (nordM > PAUS_M + steg / 2) {
    const v = send(nordM, KO_SOG, i === 0 ? 0 : kadensMs);
    if (i === 0) forsta = { lastActiveTime: v.lastActiveTime };
    nordM -= steg;
    i += 1;
  }

  const efterAnflygning = svc.vessels.get(mmsi);
  const t0 = NOW;
  const ut = {
    forstaSampletsLastActiveTime: forsta.lastActiveTime,
    target: efterAnflygning.targetBridge,
    rorelsebevis: efterAnflygning._hasMovementProof,
    moored: efterAnflygning._moored,
    lastActiveTimeFinitHelaTiden: Number.isFinite(efterAnflygning.lastActiveTime),
    tappadEfterMs: null,
    queueZoneTraffar: 0,
    maxDistToTargetM: 0,
  };

  const antal = Math.ceil((pausMinuter * 60000) / kadensMs);
  for (let k = 0; k < antal; k += 1) {
    const jit = ((k % 3) - 1) * 3;
    const v = send(PAUS_M + jit, KO_SOG, kadensMs);
    if (!Number.isFinite(v.lastActiveTime)) ut.lastActiveTimeFinitHelaTiden = false;
    ut.maxDistToTargetM = Math.max(ut.maxDistToTargetM, PAUS_M + Math.abs(jit));
    if (v._moored) ut.moored = true;
    if (!v.targetBridge && ut.tappadEfterMs === null) {
      ut.tappadEfterMs = NOW - t0;
      break;
    }
  }
  ut.queueZoneTraffar = logger.debug.mock.calls
    .filter((c) => String(c[0]).includes('[TARGET_QUEUE_ZONE]') && String(c[0]).includes(mmsi))
    .length;
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

describe('M16 återkallad: kö-zonsvakten lever för fartklassen 0,5–2,0 kn', () => {
  test('RIGGEN uppfyller vaktens egna villkor (annars mäter testet fel sak)', () => {
    const ut = koarePausar('265000437', 30000, 3);
    expect(ut.target).toBe('Klaffbron');
    expect(ut.rorelsebevis).toBe(true);
    expect(ut.moored).toBeFalsy();
    expect(ut.maxDistToTargetM).toBeLessThanOrEqual(KO_ZON_MAX_M);
    // Klassdefinitionen: 1,5 kn ligger över rörelsebeviströskeln men under
    // fältlistans råa 2,0-gräns. Flyttas MOVEMENT_PROOF_SOG_KN faller detta.
    expect(constants.MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN).toBeLessThan(KO_SOG);
    expect(KO_SOG).toBeLessThan(2.0);
  });

  test.each([10000, 30000, 60000])(
    'KÖAREN BEHÅLLER MÅLBRON minst 600 s vid %i ms kadens (TARGET_QUEUE_ZONE)',
    (kadensMs) => {
      const ut = koarePausar('265000437', kadensMs, 10);
      // 10 minuters paus utan att målbron tappas.
      expect(ut.tappadEfterMs).toBeNull();
      expect(ut.target).toBe('Klaffbron');
      // MEKANISMASSERTION: det är kö-zonsvakten som håller kvar målet, inte
      // någon annan gren som råkar ge samma utfall.
      expect(ut.queueZoneTraffar).toBeGreaterThan(0);
      // KONSTANTVAKT (båda leden är testkonstanter): dokumenterar att riggens
      // paus (10 min) täcker hållkravet — hållkravet självt låses av att
      // tappadEfterMs förblir null ovan, inte av den här raden (granskning 4c).
      expect(10 * 60000).toBeGreaterThanOrEqual(HALL_KRAV_MS);
    },
  );

  test('MEKANISMEN: nytt fartyg får finit lastActiveTime och behåller den i 1,5 kn', () => {
    const ut = koarePausar('265000437', 30000, 5);
    // M16 satte null här — det var hela regressionens rot.
    expect(Number.isFinite(ut.forstaSampletsLastActiveTime)).toBe(true);
    // Och den överlever hela färden trots att sog aldrig passerar 2,0 kn.
    expect(ut.lastActiveTimeFinitHelaTiden).toBe(true);
  });

  test('VAKTEN ÄR TIDSBEGRÄNSAD: målbron släpps när aktivitetsfönstret runnit ut', () => {
    const ut = koarePausar('265000437', 30000, 40);
    expect(ut.tappadEfterMs).not.toBeNull();
    expect(ut.tappadEfterMs).toBeGreaterThanOrEqual(HALL_KRAV_MS);
    // Hela vistelsen (anflygning + paus) ryms i 20-minutersfönstret plus en
    // kadens: vakten är alltså inte ett evighetsskydd.
    expect(ut.tappadEfterMs).toBeLessThan(AKTIVITETSFONSTER_MS);
  });
});
