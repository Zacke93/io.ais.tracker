'use strict';

/**
 * M (rättningskampanjen 2026-11-04): mål och text — krypfartens målbroflapp
 * (buggjägarens F05, värld 933 och 757 i r1-standard-a).
 *
 * FELET. Tvåprovsvalideringen (2-READINGS i _shouldAssignTargetBridge) krävde
 * MIN_APPROACH_DISTANCE (10 m) närmande PER FIX mot målbron. Det är ett
 * kadensberoende krav: vid 30 s kadens underkändes varje båt under ≈ 0,65 kn,
 * vid 10 s varje båt under ≈ 1,9 kn. Retentionen prövar 2-READINGS, men
 * tilldelningen (ACCELERATED) gör det inte och godkänner samma båt inom 300 m
 * från NÄRMASTE bro (PROTECTION_ACTIVE). En krypare strax förbi en passerad
 * bro (F21 häver skyddszonen där) tappade därför målbron efter nådafristen och
 * fick den tillbaka nästa fix. Brotexten föll till "Inga båtar" mellan två
 * likadana texter (INV-14 DEFAULT-FLASH).
 *
 * RÄTTNINGEN har två speglade delar med SAMMA bevis (_targetApproachEvidence):
 * ≥ 10 m närmande mot målbron, räknat från förra fixen ELLER fönstrets start
 * (det största närmandet gäller), inom ett fönster lika långt som nådafristen.
 *  1. Retentionen (2-READINGS): fönstret är nådafristens start
 *     (vessel._graceApproachRef). Det största närmandet gör att fönstret bara
 *     kan lägga till godkännanden (granskningen 2026-11-04: med bara fristens
 *     start underkändes en båt som gled bort och sedan vände mot målbron).
 *  2. Återinträdet (ACCELERATED): tog retentionen nyss bort målbron för att
 *     beviset saknades, läggs SAMMA bro tillbaka först när samma bevis finns
 *     (vessel._reentryApproachRef, fönstret glider med nådafristens längd).
 *     Retentionens undantag gäller även här: målbron inom 300 m, skyddszonen
 *     kring en opasserad bro och kö-zonen. Det stänger syskonen där
 *     ANCHOR_BLOCK inte gäller: båtar som inte passerat någon bro och båtar
 *     utan fartgivare (sog=null).
 *
 * Revision 3 (omgranskningen 2026-11-05, dirigentens beslut "väg 1"):
 *  3. Återinträdets FARTPROV (vessel._reentrySpeedProof): föll borttagningen på
 *     fartgrinden (0,7 kn > 500 m / 0,1 kn 300–500 m från närmaste bro,
 *     _targetSpeedGate) läggs samma bro tillbaka först när grinden HÅLLIT
 *     oavbrutet i mer än nådafristen — samma tidsbedömning som retentionen
 *     använder när den tar bort. Förut räckte ett enda fartprov över 0,7 kn
 *     (granskarens klasser G och H).
 *  4. Närmandebeviset beväpnas bara vid OTILLRÄCKLIG rörelse, inte vid en
 *     tydlig bortrörelse (≥ 10 m bort, MOVING_AWAY). Granskarens slinga-C:
 *     "Inga båtar" stod 150 s i stället för 30 s för en båt på väg mot målbron.
 *
 * Testen fäller 7699cbe: kryparna tappar målbron (riggen), syskonen flappar,
 * etiketten säger emot beslutet och fixturen ger DEFAULT-FLASH 17:19:30.
 * Vändningstestet fäller i stället den första prototypen (9c802ed), och
 * slinga-C-testet revision 1 (c6a765d). Fartgrindstesten fäller både 7699cbe
 * och c6a765d. Kontrollerna (stilla, bortglidande, stoppad, avgång, skyddszon)
 * visar att rättningen varken håller kvar mål utan närmande eller fördröjer en
 * äkta avgång i minst 2,0 kn. De ACCEPTERADE testen låser rättningens kända pris:
 * en avgång under 2,0 kn kan få målbron en till tre fixar senare än på 7699cbe.
 *
 * Fixturerna: buggjägarens minsta repro för F05 (värld 933, R0, 112 rader),
 * granskarens klass H (0,65 kn 560–1650 m söder om Stallbackabron, seed 1)
 * och granskarens slinga-C (bortglidning och vändning norr om Klaffbron).
 */

jest.mock('homey');

const path = require('path');
const { execFileSync } = require('child_process');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { BRIDGES, MIN_APPROACH_DISTANCE } = require('../lib/constants');
const { validateInvariants } = require('./replay-validation/invariants');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const KLAFF = BRIDGES.klaffbron;
const M_PER_DEG_LAT = 111320;
const KN = 0.5144; // m/s per knop

// Riggen går längs linjen Klaffbron → Stridsbergsbron (bäring ≈ 30,7°), så att
// varje steg är ett fullt närmande mot målbron. s < 0 = söder om Klaffbron.
const BEARING_RAD = (30.7 * Math.PI) / 180;
const along = (s) => {
  const lat = KLAFF.lat + (s * Math.cos(BEARING_RAD)) / M_PER_DEG_LAT;
  const lon = KLAFF.lon + (s * Math.sin(BEARING_RAD)) / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  return { lat, lon };
};

const logger = {
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
};
const liveServices = [];
let NOW = 0;
let nowSpy = null;

function makeVDS() {
  const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  svc.app = {
    gpsJumpGateService: null, passageLatchService: null, routeOrderValidator: null, debug: jest.fn(), log: jest.fn(), error: jest.fn(),
  };
  liveServices.push(svc);
  return svc;
}

/**
 * Kör en båt genom RIKTIGA pipelinen (bara updateVessel, inga interna fält):
 * norrut i 5 kn förbi Klaffbron (målbron byts till Stridsbergsbron), sedan
 * `fas2` — en lista av {ds, sog, dtS} som läggs på efter passagen.
 * @returns {{svc: object, mmsi: string, efter: Array<{s:number, target:(string|null)}>}} utfall
 */
function korForbiKlaffbron(mmsi, fas2) {
  const svc = makeVDS();
  const send = (s, sog, dtS, cog = 30.7) => {
    NOW += dtS * 1000;
    const p = along(s);
    svc.updateVessel(mmsi, {
      mmsi, lat: p.lat, lon: p.lon, sog, cog, name: 'KRYPARE', timestamp: NOW,
    });
    return svc.vessels.get(mmsi);
  };
  let s = -620;
  send(s, 5, 0);
  while (s < -40) {
    s += 77; // 5 kn i 30 s
    send(s, 5, 30);
  }
  const passerat = svc.vessels.get(mmsi);
  const efter = [];
  for (const steg of fas2) {
    s += steg.ds;
    const v = send(s, steg.sog, steg.dtS, steg.cog);
    efter.push({ s: Math.round(s), target: v.targetBridge || null });
  }
  return {
    svc, mmsi, passerat, efter,
  };
}

const krypning = (kn, dtS, antal) => Array.from({ length: antal }, () => ({ ds: kn * KN * dtS, sog: kn, dtS }));

/**
 * Generell rigg längs linjen mellan två broar (s = meter från `fran` mot
 * `till`, negativt = bortom `fran`). Samma verkliga pipeline: bara updateVessel.
 * @returns {{svc: object, spar: Array<{s:number, target:(string|null)}>}} utfall per fix
 */
function korLangsLinje(mmsi, fran, till, s0, steg) {
  const A = BRIDGES[fran];
  const B = BRIDGES[till];
  const dLat = (B.lat - A.lat) * M_PER_DEG_LAT;
  const dLon = (B.lon - A.lon) * M_PER_DEG_LAT * Math.cos((A.lat * Math.PI) / 180);
  const L = Math.hypot(dLat, dLon);
  const bearing = ((Math.atan2(dLon / L, dLat / L) * 180) / Math.PI + 360) % 360;
  const at = (s) => ({
    lat: A.lat + ((s * dLat) / L) / M_PER_DEG_LAT,
    lon: A.lon + ((s * dLon) / L) / (M_PER_DEG_LAT * Math.cos((A.lat * Math.PI) / 180)),
  });
  const svc = makeVDS();
  let s = s0;
  const spar = [];
  const skicka = (sog, dtS, cog) => {
    NOW += dtS * 1000;
    const p = at(s);
    svc.updateVessel(mmsi, {
      mmsi, lat: p.lat, lon: p.lon, sog, cog: cog ?? bearing, name: 'RIGG', timestamp: NOW,
    });
    const v = svc.vessels.get(mmsi);
    spar.push({ s: Math.round(s), target: v ? (v.targetBridge || null) : 'BORTA' });
  };
  skicka(5, 0);
  for (const x of steg) {
    s += x.ds;
    skicka(x.sog, x.dtS ?? 30, x.cog);
  }
  return { svc, spar };
}

/** Antal gånger målbron `bro` kommer TILLBAKA efter att ha tagits bort. */
const aterkomster = (spar, bro) => spar.filter((x, i) => i > 0 && x.target === bro && spar[i - 1].target !== bro
  && spar.slice(0, i).some((y) => y.target === bro)).length;

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

describe('F05: krypfart förbi en passerad bro behåller målbron', () => {
  test('RIGGEN: passagen av Klaffbron ger målbro Stridsbergsbron, och kryparens steg ligger under 10 m', () => {
    const { passerat } = korForbiKlaffbron('265000501', []);
    expect(passerat.targetBridge).toBe('Stridsbergsbron');
    expect(passerat.passedBridges).toContain('Klaffbron');
    // Klassdefinitionen: 0,5 kn i 30 s kadens är 7,7 m per fix, under kravet.
    expect(0.5 * KN * 30).toBeLessThan(MIN_APPROACH_DISTANCE);
  });

  test.each([
    ['0,5 kn i 30 s kadens (kortets fall, 12 min)', 0.5, 30, 24],
    ['0,8 kn i 10 s kadens (4,1 m per fix, 5 min)', 0.8, 10, 30],
    ['0,35 kn i 30 s kadens (strax över ANCHOR_BLOCK, 12 min)', 0.35, 30, 24],
  ])('KRYPAREN %s tappar aldrig Stridsbergsbron', (_namn, kn, dtS, antal) => {
    const { efter } = korForbiKlaffbron('265000502', krypning(kn, dtS, antal));
    const tappade = efter.filter((e) => e.target !== 'Stridsbergsbron');
    expect(tappade).toEqual([]);
  });

  test('KONTROLL: stilla med positionsbrus (±3 m, 0,4 kn) tappar målbron efter nådafristen som förut', () => {
    // Ingen nettorörelse mot målbron: fönstret från fristens start når aldrig
    // 10 m, så 2-READINGS underkänner som på 7699cbe.
    const jitter = [0, 3, -3, 2, -2, 3, -3, 1, -1, 3, -3, 2];
    const fas2 = [{ ds: 40, sog: 0.4, dtS: 30 }];
    let pos = 0;
    for (const j of jitter) {
      fas2.push({ ds: j - pos, sog: 0.4, dtS: 30 });
      pos = j;
    }
    const { efter } = korForbiKlaffbron('265000503', fas2);
    expect(efter.some((e) => e.target === null)).toBe(true);
  });

  test('KONTROLL: en båt som glider BORT från målbron tappar den som förut', () => {
    // Efter passagen: 0,5 kn tillbaka mot Klaffbron (avståndet till
    // Stridsbergsbron ökar). Fönstret ger negativt närmande ⇒ underkänt.
    const fas2 = [{ ds: 120, sog: 2, dtS: 60 }];
    for (let i = 0; i < 10; i++) fas2.push({ ds: -7.7, sog: 0.5, dtS: 30 });
    const { efter } = korForbiKlaffbron('265000504', fas2);
    expect(efter.some((e) => e.target === null)).toBe(true);
  });

  test('KONTROLL: en båt som STANNAR efter passagen tappar målbron via ANCHOR_BLOCK (FIX B orörd)', () => {
    const fas2 = [{ ds: 60, sog: 2, dtS: 30 }, ...krypning(0.5, 30, 2)];
    for (let i = 0; i < 8; i++) fas2.push({ ds: 0, sog: 0, dtS: 30 });
    const { efter } = korForbiKlaffbron('265000505', fas2);
    expect(efter[efter.length - 1].target).toBeNull();
  });
});

describe('F05: nådafristens referensposition', () => {
  test('referensen sätts när fristen föds och gäller bara medan fristen lever', () => {
    const { svc, mmsi } = korForbiKlaffbron('265000506', krypning(0.5, 30, 6));
    const v = svc.vessels.get(mmsi);
    expect(v._graceApproachRef).toEqual(expect.objectContaining({ bridge: 'Stridsbergsbron' }));
    // Utan levande frist är referensen verkningslös (förra fixen gäller).
    svc._targetRemovalGrace = new Map();
    expect(svc._graceApproachReference(v, 'Stridsbergsbron')).toBeNull();
    // Med frist för SAMMA målbro gäller den; för en annan bro inte.
    svc._targetRemovalGrace.set(`${mmsi}:Stridsbergsbron`, NOW);
    expect(svc._graceApproachReference(v, 'Stridsbergsbron')).toBe(v._graceApproachRef);
    expect(svc._graceApproachReference(v, 'Klaffbron')).toBeNull();
  });

  test('_touchTargetGrace svarar om en post stämplades om (M6-kontraktet i övrigt orört)', () => {
    const svc = makeVDS();
    expect(svc._touchTargetGrace('123456789', 'Klaffbron')).toBe(false);
    svc._targetRemovalGrace = new Map([['123456789:Klaffbron', NOW - 999000]]);
    expect(svc._touchTargetGrace('123456789', 'Klaffbron')).toBe(true);
    expect(svc._targetRemovalGrace.get('123456789:Klaffbron')).toBe(NOW);
    expect(svc._touchTargetGrace('123456789', 'Stridsbergsbron')).toBe(false);
    expect([...svc._targetRemovalGrace.keys()]).toEqual(['123456789:Klaffbron']);
  });
});

describe('F05 (granskningen): beviset är det största närmandet — fönstret tar aldrig bort ett godkännande', () => {
  test('VÄNDNING: en båt som glider bort under nådafristen och vänder mot målbron behåller den', () => {
    // Granskarens slingsvep (n5=10, k=3, 1,5 kn): förbi Klaffbron i 5 kn,
    // sedan en sväng som först för båten 61 m BORT från Stridsbergsbron
    // och därefter 23 m per fix tillbaka. Den första prototypen mätte bara
    // från fristens start, där båten ännu var närmare, och tappade målbron
    // trots 23 m närmande per fix (ACCELERATED lade tillbaka den 30 s
    // senare). 7699cbe godkände fixen per fix — det gör rättningen också.
    const v = 23; // 1,5 kn i 30 s
    const ds = [10, 0, -15, -v, -v, -v, -15, 0, 15, ...Array(10).fill(v)];
    const cogs = [70, 110, 150, 210, 210, 210, 250, 290, 330, 10, ...Array(9).fill(30.7)];
    const steg = [];
    for (let i = 0; i < 10; i++) steg.push({ ds: 77, sog: 5 });
    for (let i = 0; i < 3; i++) steg.push({ ds: v, sog: 1.5 });
    ds.forEach((d, i) => steg.push({ ds: d, sog: 1.5, cog: cogs[i] }));
    const { spar } = korLangsLinje('265000511', 'klaffbron', 'stridsbergsbron', -620, steg);
    const efterPassagen = spar.slice(spar.findIndex((x) => x.target === 'Stridsbergsbron'));
    expect(efterPassagen.length).toBeGreaterThan(20);
    expect(efterPassagen.filter((x) => x.target !== 'Stridsbergsbron')).toEqual([]);
  });

  test('_targetApproachEvidence väljer referensen med störst närmande och säger vilken', () => {
    const svc = makeVDS();
    const strids = BRIDGES.stridsbergsbron;
    const p = (s) => along(s);
    // Förra fixen 30 m längre från målbron än nu, fönstrets start 6 m längre.
    const ev1 = svc._targetApproachEvidence(p(400), p(370), p(394), strids);
    expect(ev1.source).toBe('fix');
    expect(ev1.change).toBeCloseTo(30, 0);
    const ev2 = svc._targetApproachEvidence(p(400), p(397), p(388), strids);
    expect(ev2.source).toBe('window');
    expect(ev2.change).toBeCloseTo(12, 0);
    // Utan fönster gäller förra fixen, som före F05.
    const ev3 = svc._targetApproachEvidence(p(400), p(397), null, strids);
    expect(ev3.source).toBe('fix');
    expect(ev3.change).toBeCloseTo(3, 0);
  });

  test('ETIKETTEN mäter med samma bevis som beslutet (_getTargetRemovalReason)', () => {
    // Per fix glider båten 3 m BORT, men sedan fristens start har hon närmat
    // sig 6 m. Beslutet (största närmandet: +6 m, under 10 m) underkänner för
    // otillräckligt närmande — då ska etiketten säga INSUFFICIENT_MOVEMENT,
    // inte MOVING_AWAY som en egen per-fix-kopia gjorde.
    const svc = makeVDS();
    const mmsi = '265000512';
    const nu = along(400);
    const forra = along(403); // 3 m NÄRMARE målbron än nu: per fix glider hon bort
    const fristStart = along(394); // 6 m längre bort: sedan fristens start +6 m
    svc._targetRemovalGrace = new Map([[`${mmsi}:Stridsbergsbron`, NOW - 90000]]);
    const vessel = {
      mmsi,
      lat: nu.lat,
      lon: nu.lon,
      sog: 0.8,
      cog: 30.7,
      targetBridge: 'Stridsbergsbron',
      _graceApproachRef: { bridge: 'Stridsbergsbron', lat: fristStart.lat, lon: fristStart.lon },
    };
    const oldVessel = {
      mmsi, lat: forra.lat, lon: forra.lon, sog: 0.8, cog: 30.7, targetBridge: 'Stridsbergsbron',
    };
    expect(svc._getTargetRemovalReason(vessel, oldVessel)).toBe('INSUFFICIENT_MOVEMENT');
  });
});

describe('F05 (granskningen): återinträdesbeviset stänger syskonen där ANCHOR_BLOCK inte gäller', () => {
  test('SYSKON (a): krypare 0,15 kn 300–500 m söder om Olidebron (ingen bro passerad) får inte tillbaka Klaffbron utan närmande', () => {
    // 0,15 kn i 30 s kadens = 2,3 m per fix, 6,9 m per nådafrist. Retentionen
    // tar bort Klaffbron (1,8 km bort, 2-READINGS); Olidebron ligger 300–500 m
    // bort, så tilldelningen krävde bara 0,1 kn — och ANCHOR_BLOCK gäller inte
    // en båt som inte passerat någon bro. Förut: tillbaka nästa fix, flapp.
    const steg = [];
    for (let i = 0; i < 8; i++) steg.push({ ds: 77, sog: 5 });
    for (let i = 0; i < 50; i++) steg.push({ ds: 0.15 * KN * 30, sog: 0.15 });
    const { spar } = korLangsLinje('265000513', 'olidebron', 'klaffbron', -1100, steg);
    expect(spar.some((x) => x.target === 'Klaffbron')).toBe(true);
    const krypet = spar.slice(9);
    expect(krypet[0].s).toBeLessThan(-300);
    expect(krypet[krypet.length - 1].s).toBeLessThan(-300);
    expect(krypet.some((x) => x.target === null)).toBe(true);
    expect(aterkomster(spar, 'Klaffbron')).toBe(0);
  });

  test('SYSKON (b): sog=null-båt som stannar 60 m norr om passerade Klaffbron får inte tillbaka Stridsbergsbron under stoppet', () => {
    // Med känd fart tar ANCHOR_BLOCK hand om stoppet; utan fartgivare gäller
    // den inte (helgranskningen 2026-07-06), och PROTECTION_ACTIVE (≤ 300 m från
    // närmaste bro) lade tillbaka målbron nästa fix. Positionsbrus ±2 m.
    const brus = [0, 2, -1, 1, -2, 2, 0, -1, 1, -2];
    const fas2 = [{ ds: 100, sog: 2, dtS: 30 }]; // passagen med känd fart, sedan tyst givare
    let pos = 0;
    for (let i = 0; i < 40; i++) {
      const j = brus[i % brus.length];
      fas2.push({ ds: j - pos, sog: null, dtS: 30 });
      pos = j;
    }
    const { efter } = korForbiKlaffbron('265000514', fas2);
    const spar = efter.map((e) => ({ s: e.s, target: e.target }));
    expect(spar.some((x) => x.target === null)).toBe(true);
    expect(aterkomster(spar, 'Stridsbergsbron')).toBe(0);
  });

  test("SYSKON (b'): sog=null-krypare 0,15 kn efter passerade Klaffbron flappar inte", () => {
    const fas2 = [{ ds: 100, sog: 2, dtS: 30 }];
    for (let i = 0; i < 40; i++) fas2.push({ ds: 0.15 * KN * 30, sog: null, dtS: 30 });
    const { efter } = korForbiKlaffbron('265000515', fas2);
    const spar = efter.map((e) => ({ s: e.s, target: e.target }));
    expect(spar.some((x) => x.target === null)).toBe(true);
    expect(aterkomster(spar, 'Stridsbergsbron')).toBe(0);
  });

  test('KONTROLL med svaj som når 10 m: stilla båt (0,4 kn fartbrus) vid passerad bro tappar målbron EN gång och får den inte tillbaka', () => {
    // Svaj ±5 m längs leden med period 8 fixar: topp till dal 10 m, men inget
    // fönster på 90 s ger 10 m närmande. Ett för generöst fönster (äldre
    // referens än fristens eller återinträdets start) skulle hålla kvar eller
    // lägga tillbaka målbron. På 7699cbe lade ACCELERATED tillbaka den.
    const fas2 = [{ ds: 100, sog: 2, dtS: 30 }];
    let pos = 0;
    for (let i = 0; i < 40; i++) {
      const svaj = 5 * Math.sin((2 * Math.PI * i) / 8);
      fas2.push({ ds: svaj - pos, sog: 0.4, dtS: 30 });
      pos = svaj;
    }
    const { efter } = korForbiKlaffbron('265000516', fas2);
    const spar = efter.map((e) => ({ s: e.s, target: e.target }));
    expect(spar.some((x) => x.target === null)).toBe(true);
    expect(aterkomster(spar, 'Stridsbergsbron')).toBe(0);
  });

  test('KONTROLL: en avgång med KÄND fart får målbron tillbaka direkt, även när första fixen ännu inte flyttat sig', () => {
    // Stopp i 0 kn 100 m norr om passerade Klaffbron tills målbron tagits
    // bort (ANCHOR_BLOCK), sedan avgång i 3 kn. Första avgångsfixen har full
    // fart men samma position (som 72 h-soakens avgångar: 4,7 kn och 0 m).
    // Känd fart ≥ FIX_D_MIN_SOG (2,0 kn) är rörelsebevis i sig, så rättningen
    // fördröjer inte avgången jämfört med 7699cbe.
    const fas2 = [{ ds: 100, sog: 2, dtS: 30 }];
    for (let i = 0; i < 12; i++) fas2.push({ ds: 0, sog: 0, dtS: 30 });
    fas2.push({ ds: 0, sog: 3, dtS: 30 });
    for (let i = 0; i < 3; i++) fas2.push({ ds: 3 * KN * 30, sog: 3, dtS: 30 });
    const { efter } = korForbiKlaffbron('265000517', fas2);
    expect(efter.slice(1, 13).some((e) => e.target === null)).toBe(true);
    expect(efter.slice(13).map((e) => e.target)).toEqual(Array(4).fill('Stridsbergsbron'));
  });

  test('KONTROLL: en avgång UTAN fartgivare får målbron på första fixen med ≥ 10 m närmande', () => {
    // Samma stopp med sog=null: här finns bara positionen, och den första
    // avgångsfixen har flyttat sig 46 m (3 kn i 30 s), så beviset finns direkt.
    const fas2 = [{ ds: 100, sog: 2, dtS: 30 }];
    for (let i = 0; i < 12; i++) fas2.push({ ds: 0, sog: null, dtS: 30 });
    for (let i = 0; i < 4; i++) fas2.push({ ds: 3 * KN * 30, sog: null, dtS: 30 });
    const { efter } = korForbiKlaffbron('265000521', fas2);
    expect(efter.slice(1, 13).some((e) => e.target === null)).toBe(true);
    expect(efter.slice(13).map((e) => e.target)).toEqual(Array(4).fill('Stridsbergsbron'));
  });

  test('KONTROLL: retentionens skyddszon gäller även återinträdet — kryparen får Klaffbron när hon når 300 m från opasserade Olidebron', () => {
    // 0,15 kn (2,3 m per fix) från 330 m söder om Olidebron: målbron tas bort
    // strax utanför skyddszonen. Inne i zonen kring den OPASSERADE Olidebron
    // hade retentionen behållit Klaffbron (PROTECTION_ZONE_SAVE), så där får
    // återinträdet inte heller vänta på närmandebeviset.
    const steg = [];
    for (let i = 0; i < 10; i++) steg.push({ ds: 77, sog: 5 });
    for (let i = 0; i < 30; i++) steg.push({ ds: 2.3, sog: 0.15 });
    const { spar } = korLangsLinje('265000518', 'olidebron', 'klaffbron', -1100, steg);
    const forstaNull = spar.findIndex((x) => x.target === null);
    expect(forstaNull).toBeGreaterThan(0);
    expect(spar[forstaNull].s).toBeLessThan(-300);
    const inomZonen = spar.findIndex((x, i) => i > forstaNull && x.s > -299);
    expect(inomZonen).toBeGreaterThan(forstaNull);
    expect(spar.slice(inomZonen).map((x) => x.target)).toEqual(Array(spar.length - inomZonen).fill('Klaffbron'));
  });
});

describe('F05 (granskningen): återinträdesbevisets livscykel', () => {
  test('beväpnas bara när borttagningen föll på närmandet, förbrukas med en målbro och glider efter nådafristens längd', () => {
    const svc = makeVDS();
    const p0 = along(400);
    const vessel = {
      mmsi: '265000519', lat: p0.lat, lon: p0.lon, sog: 0.2, targetBridge: 'Stridsbergsbron',
    };
    // Beviset fanns (12 m närmande per fix) → ingen beväpning.
    svc._armReentryApproachProof(vessel, { ...vessel, ...along(388) }, NOW);
    expect(vessel._reentryApproachRef).toBeUndefined();
    // Beviset saknades (2 m) → beväpnas på borttagningens position och tid.
    svc._armReentryApproachProof(vessel, { ...vessel, ...along(398) }, NOW);
    expect(vessel._reentryApproachRef).toEqual(expect.objectContaining({ bridge: 'Stridsbergsbron', t: NOW }));
    // Med en målbro (oavsett väg) är posten förbrukad.
    svc._maintainReentryApproachProof(vessel, NOW + 1000);
    expect(vessel._reentryApproachRef).toBeNull();
    // Mållös: fönstret står still till och med 60 s, glider därefter.
    vessel.targetBridge = null;
    vessel._reentryApproachRef = {
      bridge: 'Stridsbergsbron', lat: p0.lat, lon: p0.lon, t: NOW,
    };
    svc._maintainReentryApproachProof(vessel, NOW + 60000);
    expect(vessel._reentryApproachRef.t).toBe(NOW);
    const p1 = along(404);
    vessel.lat = p1.lat;
    vessel.lon = p1.lon;
    vessel._gpsJumpDetected = true;
    svc._maintainReentryApproachProof(vessel, NOW + 90000);
    expect(vessel._reentryApproachRef.t).toBe(NOW); // aldrig en GPS-misstänkt start
    vessel._gpsJumpDetected = false;
    svc._maintainReentryApproachProof(vessel, NOW + 90000);
    expect(vessel._reentryApproachRef).toEqual({
      bridge: 'Stridsbergsbron', lat: p1.lat, lon: p1.lon, t: NOW + 90000,
    });
  });

  test('_isInTargetQueueZone är kö-zonsvaktens predikat ordagrant', () => {
    const svc = makeVDS();
    const naraKlaff = along(-400); // 400 m söder om Klaffbron
    const bas = {
      mmsi: '265000520', lat: naraKlaff.lat, lon: naraKlaff.lon, lastActiveTime: NOW - 60000, _hasMovementProof: true, _moored: false,
    };
    expect(svc._isInTargetQueueZone(bas, 'Klaffbron', NOW)).toBe(true);
    expect(svc._isInTargetQueueZone({ ...bas, lastActiveTime: NOW - 21 * 60000 }, 'Klaffbron', NOW)).toBe(false);
    expect(svc._isInTargetQueueZone({ ...bas, _hasMovementProof: false }, 'Klaffbron', NOW)).toBe(false);
    expect(svc._isInTargetQueueZone({ ...bas, _moored: true }, 'Klaffbron', NOW)).toBe(false);
    expect(svc._isInTargetQueueZone(bas, 'Stridsbergsbron', NOW)).toBe(false); // > 600 m
  });
});

/** Kör en fixtur genom hela appen (replayRunner) och returnerar resultat-JSON. */
function korHelaAppen(fixtur) {
  const env = { ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '' };
  delete env.REPLAY_MONITORING;
  const out = execFileSync(process.execPath, [
    path.join(ROOT, 'tests/replay-validation/replayRunner.js'),
    path.join(FIXTURES, fixtur),
  ], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
  });
  return JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
}

/** Sekunder med "Inga båtar" i texten mellan tidpunkterna t0 och t1 (ms). */
function ingaBatarSekunder(result, t0, t1) {
  const tr = result.bridgeTextTransitions;
  let ms = 0;
  for (let i = 0; i < tr.length; i++) {
    if (!/^Inga båtar/.test(tr[i].text)) continue;
    const a = Math.max(tr[i].t, t0);
    const b = Math.min(i + 1 < tr.length ? tr[i + 1].t : t1, t1);
    if (b > a) ms += b - a;
  }
  return ms / 1000;
}

describe('F05 rev 3 (omgranskningen): fartgrindens tidsbedömning gäller även återinträdet', () => {
  // Granskarens klass H i riggen: förbi Stallbackabron söderut, sedan 11 m per
  // 30 s (≈ 0,71 kn verklig fart, så närmandebeviset finns) 600–1150 m söder om
  // Stallbackabron — mer än 500 m från varje bro, alltså 0,7 kn-grinden. Den
  // rapporterade farten brusar kring 0,65 kn och går över 0,7 kn två gånger per
  // tio fixar. Retentionen tar bort målbron först när grinden fallerat i mer än
  // nådafristen (fyra fixar i rad); ACCELERATED lade tillbaka den på nästa
  // enstaka prov över 0,7 kn — samma flapp som F05.
  const FARTBRUS = [0.65, 0.62, 0.68, 0.74, 0.63, 0.66, 0.6, 0.72, 0.64, 0.67];
  const kryparSoderOmStallbacka = (mmsi, farter) => {
    const steg = [];
    for (let i = 0; i < 18; i++) steg.push({ ds: 77, sog: 5 });
    farter.forEach((sog) => steg.push({ ds: 11, sog }));
    return korLangsLinje(mmsi, 'stallbackabron', 'stridsbergsbron', -800, steg);
  };

  test('KLASS H: en krypare kring 0,7 kn mer än 500 m från broar får inte tillbaka målbron på ett enstaka fartprov', () => {
    const farter = Array.from({ length: 50 }, (_, i) => FARTBRUS[i % FARTBRUS.length]);
    const { spar } = kryparSoderOmStallbacka('265000531', farter);
    const krypet = spar.slice(19);
    expect(krypet[0].s).toBeGreaterThan(500);
    expect(krypet[krypet.length - 1].s).toBeLessThan(2226 - 500);
    expect(spar.some((x) => x.target === 'Stridsbergsbron')).toBe(true);
    expect(krypet.some((x) => x.target === null)).toBe(true);
    expect(aterkomster(spar, 'Stridsbergsbron')).toBe(0);
  });

  test('KONTROLL: håller fartgrinden i mer än en nådafrist läggs samma bro tillbaka (spegeln av borttagningen)', () => {
    // Samma krypare, men efter 20 fixar ligger farten stadigt på 0,8 kn. Grinden
    // håller då oavbrutet; efter mer än 60 s (fyra fixar i 30 s kadens: 0, 30,
    // 60 och 90 s) får båten tillbaka målbron, precis som retentionen tar bort
    // den först efter fyra fallerade fixar.
    const farter = [
      ...Array.from({ length: 20 }, (_, i) => FARTBRUS[i % FARTBRUS.length]),
      ...Array(10).fill(0.8),
    ];
    const { spar } = kryparSoderOmStallbacka('265000532', farter);
    const krypet = spar.slice(19);
    expect(krypet.slice(0, 20).some((x) => x.target === null)).toBe(true);
    expect(krypet.slice(20).map((x) => x.target)).toEqual([
      null, null, null, ...Array(7).fill('Stridsbergsbron'),
    ]);
  });

  test('_targetSpeedGate är fartgrindarna ordagrant (bara känd fart, närmaste bro i registret)', () => {
    const svc = makeVDS();
    const strids = BRIDGES.stridsbergsbron;
    const stall = BRIDGES.stallbackabron;
    const mitt = { lat: (strids.lat + stall.lat) / 2, lon: (strids.lon + stall.lon) / 2 }; // ≈ 1,1 km från båda
    expect(svc._targetSpeedGate({ ...mitt, sog: 0.65 })).toEqual(expect.objectContaining({
      minSpeed: 0.7, context: 'far from bridges', blocked: true,
    }));
    expect(svc._targetSpeedGate({ ...mitt, sog: 0.71 }).blocked).toBe(false);
    expect(svc._targetSpeedGate({ ...mitt, sog: null }).blocked).toBe(false); // okänd fart blockerar inte
    const p400 = along(-400); // 400 m söder om Klaffbron
    expect(svc._targetSpeedGate({ ...p400, sog: 0.1 })).toEqual(expect.objectContaining({ minSpeed: 0.1, blocked: true }));
    expect(svc._targetSpeedGate({ ...p400, sog: 0.11 }).blocked).toBe(false);
    const p100 = along(100);
    expect(svc._targetSpeedGate({ ...p100, sog: 0 })).toEqual(expect.objectContaining({
      minSpeed: null, blocked: false, nearestBridge: 'Klaffbron',
    }));
  });

  test('fartprovets livscykel: beväpnas bara på fartgrinden (inte ANCHOR_BLOCK), loppet bryts av ett fallerat prov och posten förbrukas med en målbro', () => {
    const svc = makeVDS();
    const strids = BRIDGES.stridsbergsbron;
    const stall = BRIDGES.stallbackabron;
    const mitt = { lat: (strids.lat + stall.lat) / 2, lon: (strids.lon + stall.lon) / 2 };
    // Grinden håller (0,8 kn) → ingen beväpning.
    const v = {
      mmsi: '265000533', ...mitt, sog: 0.8, targetBridge: 'Stridsbergsbron', passedBridges: [],
    };
    svc._armReentrySpeedProof(v, NOW);
    expect(v._reentrySpeedProof).toBeUndefined();
    // ANCHOR_BLOCK fällde samma prov (passerad bro och < 0,3 kn) → FIX B:s, ingen beväpning.
    const ankrad = { ...v, sog: 0.2, passedBridges: ['Stallbackabron'] };
    svc._armReentrySpeedProof(ankrad, NOW);
    expect(ankrad._reentrySpeedProof).toBeUndefined();
    // Fartgrinden fällde (0,6 kn, ingen passerad bro) → beväpnas.
    v.sog = 0.6;
    svc._armReentrySpeedProof(v, NOW);
    expect(v._reentrySpeedProof).toEqual({ bridge: 'Stridsbergsbron', t: NOW, holdsSince: null });
    v.targetBridge = null;
    // Loppet startar på första prov där grinden håller …
    v.sog = 0.8;
    svc._maintainReentrySpeedProof(v, NOW + 30000);
    expect(v._reentrySpeedProof.holdsSince).toBe(NOW + 30000);
    svc._maintainReentrySpeedProof(v, NOW + 60000);
    expect(v._reentrySpeedProof.holdsSince).toBe(NOW + 30000);
    expect(svc._reentryNeedsProof(v, null, 'Stridsbergsbron', strids, NOW + 90000)).toBe(true); // 60 s: inte > 60 s
    expect(svc._reentryNeedsProof(v, null, 'Stridsbergsbron', strids, NOW + 90001)).toBe(false);
    expect(svc._reentryNeedsProof(v, null, 'Klaffbron', BRIDGES.klaffbron, NOW + 30000)).toBe(false); // annan bro
    // … ett fallerat prov eller en GPS-misstänkt position bryter det.
    v.sog = 0.7;
    svc._maintainReentrySpeedProof(v, NOW + 90000);
    expect(v._reentrySpeedProof.holdsSince).toBeNull();
    v.sog = 0.8;
    v._gpsJumpDetected = true;
    svc._maintainReentrySpeedProof(v, NOW + 120000);
    expect(v._reentrySpeedProof.holdsSince).toBeNull();
    v._gpsJumpDetected = false;
    // Med en målbro (oavsett väg) är posten förbrukad.
    v.targetBridge = 'Stridsbergsbron';
    svc._maintainReentrySpeedProof(v, NOW + 150000);
    expect(v._reentrySpeedProof).toBeNull();
  });

  describe('i hela appen: granskarens klass H (0,65 kn, seed 1)', () => {
    let result;
    beforeAll(() => {
      result = korHelaAppen('m-f05-fartgrind-0.65kn-soder-om-stallbackabron.jsonl');
    });

    test('ingen DEFAULT-FLASH (7699cbe: 9, revision 1: 10)', () => {
      const flash = validateInvariants(result).filter((x) => String(x).includes('DEFAULT-FLASH'));
      expect(flash).toEqual([]);
    });

    test('notiser, öppningsvarningar och målbropassager är desamma som på 7699cbe', () => {
      expect(result.notifications.map((n) => n.bridge)).toEqual(
        ['Stallbackabron', 'Stridsbergsbron', 'Järnvägsbron', 'Klaffbron', 'Olidebron', 'Kanalinfarten'],
      );
      expect(result.openingWarnings.map((w) => `${w.bridge}:${w.direction}`)).toEqual(
        ['Stridsbergsbron:southbound', 'Klaffbron:southbound'],
      );
      expect(result.targetPassages.map((p) => p.bridge)).toEqual(['Stridsbergsbron', 'Klaffbron']);
    });
  });
});

describe('F05 rev 3 (omgranskningen): en tydlig bortrörelse beväpnar inte närmandebeviset (slinga-C)', () => {
  let result;
  beforeAll(() => {
    result = korHelaAppen('m-f05-slinga-c-bortglidning-och-vandning.jsonl');
  });

  test('"Inga båtar" står högst 30 s mellan Klaffbron- och Stridsbergsbron-passagen, som på 7699cbe (revision 1: 150 s)', () => {
    // Rådata: båten glider 15–23 m per fix BORT 17:05:30–17:07:30 och närmar
    // sig från 17:08:30. Korsningarna (U13): Klaffbron 17:00, Stridsbergsbron
    // 17:17, ingen återkorsning — hon var på väg mot målbron hela tiden.
    const p = (bro) => result.targetPassages.find((x) => x.mmsi === '265999001' && x.bridge === bro);
    expect(p('Klaffbron')).toBeDefined();
    expect(p('Stridsbergsbron')).toBeDefined();
    expect(ingaBatarSekunder(result, p('Klaffbron').t, p('Stridsbergsbron').t)).toBeLessThanOrEqual(30);
  });

  test('notiser och öppningsvarningar är desamma som på 7699cbe', () => {
    expect(result.notifications.map((n) => n.bridge)).toEqual(
      ['Olidebron', 'Kanalinfarten', 'Klaffbron', 'Järnvägsbron', 'Stridsbergsbron', 'Stallbackabron'],
    );
    expect(result.openingWarnings.map((w) => `${w.bridge}:${w.direction}`)).toEqual(
      ['Klaffbron:northbound', 'Stridsbergsbron:northbound'],
    );
  });

  test('_armReentryApproachProof beväpnar vid otillräcklig rörelse men inte vid ≥ 10 m bortrörelse', () => {
    const svc = makeVDS();
    const p0 = along(400);
    const vessel = {
      mmsi: '265000534', lat: p0.lat, lon: p0.lon, sog: 1.5, targetBridge: 'Stridsbergsbron',
    };
    svc._armReentryApproachProof(vessel, { ...vessel, ...along(415) }, NOW); // 15 m bort
    expect(vessel._reentryApproachRef).toBeUndefined();
    svc._armReentryApproachProof(vessel, { ...vessel, ...along(404) }, NOW); // 4 m bort: otillräckligt
    expect(vessel._reentryApproachRef).toEqual(expect.objectContaining({ bridge: 'Stridsbergsbron', t: NOW }));
  });
});

describe('F05: rättningens accepterade pris — avgångar under 2,0 kn (FIX_D_MIN_SOG)', () => {
  test('ACCEPTERAT (närmandebeviset): en avgång i 1,5 kn vars första fix inte flyttat sig får målbron en fix senare', () => {
    // Stopp 500 m norr om passerade Klaffbron tills målbron tagits bort, sedan
    // avgång i 1,5 kn. Första avgångsfixen har farten men samma position
    // (granskarens dep-at500-v1.5-sog). 7699cbe lade tillbaka målbron på den
    // fixen; nu krävs 10 m närmande, som kommer med nästa fix (23 m). Under
    // 2,0 kn räknas farten inte som rörelsebevis i sig.
    const fas2 = [];
    for (let i = 0; i < 6; i++) fas2.push({ ds: 77, sog: 5, dtS: 30 });
    fas2.push({ ds: 40, sog: 2, dtS: 30 });
    for (let i = 0; i < 30; i++) fas2.push({ ds: 0, sog: 0, dtS: 30 });
    fas2.push({ ds: 0, sog: 1.5, dtS: 30 });
    for (let i = 0; i < 4; i++) fas2.push({ ds: 1.5 * KN * 30, sog: 1.5, dtS: 30 });
    const { efter } = korForbiKlaffbron('265000535', fas2);
    expect(efter[6].s).toBeGreaterThan(480);
    expect(efter.slice(7, 37).some((e) => e.target === null)).toBe(true);
    expect(efter.slice(37).map((e) => e.target)).toEqual([null, ...Array(4).fill('Stridsbergsbron')]);
  });

  test('ACCEPTERAT (fartprovet): en avgång i 1,5 kn från stopp mer än 500 m från broar får målbron när grinden hållit i mer än en nådafrist; i 2,5 kn direkt', () => {
    // Ingen bro passerad (ANCHOR_BLOCK gäller inte): stopp ≈ 570 m söder om
    // Olidebron, där 0,7 kn-grinden tar bort Klaffbron. Avgången i 1,5 kn får
    // tillbaka målbron på fjärde fixen (grinden har då hållit 90 s), som
    // retentionen tar bort den först på fjärde fallerade fixen. Från 2,0 kn
    // räknas meddelandets egen fart som rörelsebevis och avgången fördröjs inte.
    const avgang = (mmsi, kn) => {
      const steg = [];
      for (let i = 0; i < 12; i++) steg.push({ ds: 77, sog: 5 });
      for (let i = 0; i < 30; i++) steg.push({ ds: 0, sog: 0 });
      for (let i = 0; i < 6; i++) steg.push({ ds: kn * KN * 30, sog: kn });
      return korLangsLinje(mmsi, 'olidebron', 'klaffbron', -1500, steg).spar;
    };
    const lang = avgang('265000536', 1.5);
    expect(lang[12].s).toBeLessThan(-500);
    expect(lang.slice(13, 43).some((x) => x.target === null)).toBe(true);
    expect(lang.slice(43).map((x) => x.target)).toEqual([null, null, null, 'Klaffbron', 'Klaffbron', 'Klaffbron']);
    const snabb = avgang('265000537', 2.5);
    expect(snabb.slice(43).map((x) => x.target)).toEqual(Array(6).fill('Klaffbron'));
  });
});

describe('F05 i hela appen: buggjägarens minsta repro (WILMA, värld 933)', () => {
  let result;
  beforeAll(() => {
    result = korHelaAppen('m-f05-wilma-krypfart-norr-om-klaffbron.jsonl');
  });

  test('ingen DEFAULT-FLASH (INV-14)', () => {
    const flash = validateInvariants(result).filter((v) => String(v).includes('DEFAULT-FLASH'));
    expect(flash).toEqual([]);
  });

  test('"Inga båtar" visas aldrig mellan Klaffbron- och Stridsbergsbron-passagen', () => {
    const p = (bro) => result.targetPassages.find((x) => x.mmsi === '265340152' && x.bridge === bro);
    const klaff = p('Klaffbron');
    const strids = p('Stridsbergsbron');
    expect(klaff).toBeDefined();
    expect(strids).toBeDefined();
    const mellan = result.bridgeTextTransitions.filter((t) => t.t > klaff.t && t.t < strids.t);
    expect(mellan.length).toBeGreaterThan(0);
    expect(mellan.filter((t) => /^Inga båtar/.test(t.text))).toEqual([]);
    expect(mellan.every((t) => /Stridsbergsbron/.test(t.text))).toBe(true);
  });

  test('notiser och öppningsvarningar är desamma som på 7699cbe', () => {
    expect(result.notifications.map((n) => n.bridge)).toEqual(
      ['Kanalinfarten', 'Olidebron', 'Klaffbron', 'Järnvägsbron', 'Stridsbergsbron', 'Stallbackabron'],
    );
    expect(result.openingWarnings.map((w) => `${w.bridge}:${w.direction}`)).toEqual(
      ['Klaffbron:northbound', 'Stridsbergsbron:northbound'],
    );
  });
});
