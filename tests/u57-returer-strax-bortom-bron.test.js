'use strict';

/**
 * U57 (2026-11-23) — VERKLIGA RETURER STRAX BORTOM EN BRO EFTER ETT GLAPP
 * BOKFÖRS. Låser dagens beteende; ingen regel.
 *
 * BAKGRUND. Rättningen D1 (rättningsomgång 4 och 5) försökte stoppa en falsk
 * passage bakåt över brolinjen efter en brusposition: en båt stannar strax
 * före en bro efter ett AIS-glapp, första stillafixen är brus bortom linjen
 * (osäker, stillagrinden S1 håller passagen), och nästa fix före bron bokförde
 * passagen. Varje variant av regeln stoppade också verkliga returer, där
 * båten passerat under glappet, ligger strax bortom bron med sog 0 och vänder
 * tillbaka. Bron är då inte bokförd (S1 höll den som kandidat), så
 * återkorsningsvägen nås inte, och under 2 kn bekräftar Fix D inte
 * vändningen: det enda som bokför korsningen är den vanliga passagevägen på
 * returfixen. Stoppas den försvinner passagenotisen och nästa
 * öppningsvarning, eller en falsk varning kommer. Beslut U57: felet står kvar
 * som känd gräns (docs/ARCHITECTURE.md, GPSJumpGateService), och de här
 * returerna låses så att samma regel inte byggs igen.
 *
 * Sviten kör den RIKTIGA pipelinen (VesselDataService.updateVessel med riktig
 * SystemCoordinator, GPSJumpAnalyzer och GPSJumpGateService) på den
 * syntetiska generatorns kanalbana. Granskarens band från D1 varv 2: sex
 * bro/riktningar, stopp 15 eller 25 m bortom, returer i 0,8–1,9 kn med
 * rapporterad fart och i 1,5–3 kn utan fart. Returfixen ska bokföra bron.
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const GPSJumpGateService = require('../lib/services/GPSJumpGateService');
const { buildPath, pathMetrics, pointAt } = require('./replay-validation/scenarioGenerator');

const REAL_DATE_NOW = Date.now;
const KN = 0.5144;
const PATH = buildPath();
const MET = pathMetrics(PATH);
// Broarnas läge längs banan (meter från banans södra ände).
const BRO = {
  Klaffbron: MET.cum[2],
  Järnvägsbron: MET.cum[3],
  Stridsbergsbron: MET.cum[4],
};

const makeLogger = () => ({
  log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
});

describe('U57: verkliga returer strax bortom bron efter ett glapp (riktiga pipelinen)', () => {
  const liveServices = [];
  let nu;
  const T0 = 1_788_872_088_328;

  const bygg = () => {
    const logger = makeLogger();
    const coordinator = new SystemCoordinator(logger);
    const gate = new GPSJumpGateService(logger, coordinator);
    const svc = new VesselDataService(logger, new BridgeRegistry(), coordinator);
    svc.app = {
      gpsJumpGateService: gate,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    liveServices.push(svc);
    return { svc, gate, logger };
  };

  beforeEach(() => {
    nu = T0;
    Date.now = () => nu;
    global.__TEST_MODE__ = true;
  });

  afterEach(() => {
    while (liveServices.length > 0) {
      const svc = liveServices.pop();
      try {
        svc.clearAllTimers();
      } catch (_) { /* tomt */ }
    }
    Date.now = REAL_DATE_NOW;
    delete global.__TEST_MODE__;
    jest.clearAllMocks();
  });

  const fix = (svc, mmsi, f) => {
    nu = T0 + f.t * 1000;
    svc.updateVessel(mmsi, {
      mmsi,
      lat: f.lat,
      lon: f.lon,
      sog: f.sog,
      cog: f.cog,
      name: 'U57-PROV',
      fixFeed: 'aisstream',
      fixTs: nu,
    });
    return svc.vessels.get(mmsi);
  };

  // En fix längs banan med egen kurs; `riktning` är 'N', 'S' eller null.
  const rad = (t, s, sog, riktning) => {
    const p = pointAt(PATH, MET, s);
    let cog = null;
    if (riktning === 'N') cog = p.bearing;
    else if (riktning === 'S') cog = (p.bearing + 180) % 360;
    return {
      t, lat: p.lat, lon: p.lon, sog, cog,
    };
  };

  /**
   * Transit i 5,2 kn till 560 m före bron, glapp 200 s (båten passerar under
   * glappet), första fixen `D` m bortom med sog 0 och kurs framåt (osäker, S1
   * håller passagen), sedan tillbaka genom bron i `retKn` var `kadensS`:e
   * sekund, med eller utan rapporterad fart.
   */
  const uSvang = ({
    bro, dir, D, retKn, kadensS, utanFart,
  }) => {
    const B = BRO[bro];
    const tecken = dir === 'S' ? -1 : 1;
    const bak = dir === 'S' ? 'N' : 'S';
    const fixar = [];
    let t = 0;
    for (let m = 2600; m > 560 + 1e-6; m -= 5.2 * KN * 60) {
      fixar.push(rad(t, B - tecken * m, 5.2, dir));
      t += 60;
    }
    fixar.push(rad(t, B - tecken * 560, 5.2, dir));
    t += 200;
    fixar.push(rad(t, B + tecken * D, 0, dir));
    const tRetur = t + kadensS;
    const steg = retKn * KN * kadensS;
    for (let m = D - steg, tt = tRetur; m > -600; m -= steg, tt += kadensS) {
      fixar.push(rad(tt, B + tecken * m, utanFart ? null : retKn, bak));
    }
    return { fixar, tRetur };
  };

  const RETURER = [];
  for (const [bro, dir] of [['Järnvägsbron', 'S'], ['Järnvägsbron', 'N'], ['Klaffbron', 'S'],
    ['Klaffbron', 'N'], ['Stridsbergsbron', 'S'], ['Stridsbergsbron', 'N']]) {
    RETURER.push(
      {
        bro, dir, D: 15, retKn: 0.8, kadensS: 120, utanFart: false,
      },
      {
        bro, dir, D: 25, retKn: 1.5, kadensS: 60, utanFart: false,
      },
      {
        bro, dir, D: 15, retKn: 1.9, kadensS: 60, utanFart: false,
      },
      {
        bro, dir, D: 15, retKn: 1.5, kadensS: 120, utanFart: true,
      },
      {
        bro, dir, D: 25, retKn: 3, kadensS: 60, utanFart: true,
      },
      {
        bro, dir, D: 15, retKn: 2, kadensS: 60, utanFart: true,
      },
    );
  }

  test.each(RETURER.map((r) => [
    `${r.bro} ${r.dir === 'S' ? 'söderut' : 'norrut'}, stopp ${r.D} m bortom, retur ${r.retKn} kn `
      + `${r.utanFart ? 'utan fart' : 'med fart'} var ${r.kadensS}:e s`, r]))('%s ⇒ returfixen bokför bron', (_namn, r) => {
    const { svc } = bygg();
    const MMSI = `2659105${String(RETURER.indexOf(r)).padStart(2, '0')}`;
    const { fixar, tRetur } = uSvang(r);
    let osaker = null;
    let vid = null;
    for (const f of fixar) {
      const v = fix(svc, MMSI, f);
      if (f.t === tRetur - r.kadensS) osaker = { unc: v._positionUncertain === true, passed: [...(v.passedBridges || [])] };
      if (f.t === tRetur) vid = [...(v.passedBridges || [])];
    }
    // Förutsättningen: stillafixen bortom bron är osäker och S1 höll passagen
    expect(osaker.unc).toBe(true);
    expect(osaker.passed).not.toContain(r.bro);
    // Returfixen ligger entydigt före linjen: korsningen bokförs
    expect(vid).toContain(r.bro);
  });
});
