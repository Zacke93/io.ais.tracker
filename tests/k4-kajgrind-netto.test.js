'use strict';

const AISBridgeApp = require('../app');
const constants = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

const { TRIGGER_POINTS, QUAY_DEPARTURE_GATE } = constants;
const TP = TRIGGER_POINTS.kanalinfarten;

/**
 * K4 (fältprov 10, 2026-08-19/20 — ANVÄNDARBESLUT F3): KAJGRINDENS NETTOGOLV.
 *
 * FYNDET: ben (a) i _quayDepartureNeedsProof krävde bara MIN_MOVING_FIXES
 * rörelsefixar OCH "ingen netto-reträtt" (approachM >= 0). LADYBIRD
 * (265636940, fritidsbåt) lämnade kajen väster om Kanalinfarten 06:51:21,
 * hade gått 31 m mot punkten 06:53:38 — och fick då boat_near "LADYBIRD
 * närmar sig Kanalinfarten, beräknad ankomst om 8 minuter" på 285 m. Hon kom
 * aldrig fram: närmast 230 m, vände (cog 255,5°), drev till 421 m och
 * förtöjde 423 m VÄSTER om punkten.
 *
 * FIXEN, SLUTLIG FORM (dirigentbeslut efter rådatamätning 2026-08-22):
 * grinden har EXAKT ETT nettogolv, QUAY_DEPARTURE_GATE.NET_APPROACH_M (40 m),
 * och ben (a) bär bara fallet "netto okänt". K4:s första variant lade ett
 * eget golv (MIN_NET_APPROACH_M = 70) på ben (a), men den grenen var ONÅBAR
 * som numerisk tröskel — ben (b) returnerar redan vid approachM >= 40, så ett
 * KÄNT netto kan aldrig nå den. Konstanten är borttagen; sanningsmängden är
 * BYTE-IDENTISK (se testet SUBSUMTIONEN).
 *
 * VARFÖR GOLVET INTE HÖJDES TILL 70 (mätningen som avgjorde): 14
 * grindkonsultationer i hela korpusbanken nettade 40, 42, 84, 129, 158, 159,
 * 183, 190, 192, 203, 207, 219, 249, 253 m. Exakt två ligger i bandet 40–69,
 * och BÅDA är rådataverifierade ÄKTA inseglare (gt-passages): ELFKUNGEN
 * 265573130 (40,4 m ⇒ Olidebron + MÅLBRON Klaffbron) och MONIKA 304482000
 * (42,0 m ⇒ Olidebron, Klaffbron + MÅLBRON Stridsbergsbron). Ett 70-golv
 * hade inte stoppat en enda fantom men krympt deras förvarning 262→149 m
 * respektive 249→171 m.
 *
 * Alla fixar nedan är RÅDATA ur fältkorpusen
 * (~/.ais-tracker-logs/ais-replay-20260819-081250.jsonl) respektive
 * korpusarna 20260804-both-21h och 20260806-42h — inga påhittade positioner.
 */

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

function makeApp() {
  const app = Object.create(AISBridgeApp.prototype);
  const logger = makeLogger();
  app.debug = logger.debug;
  app.log = logger.log;
  app.error = logger.error;
  app._quayStableLedger = new Map();
  app.bridgeRegistry = { getBridgeByName: jest.fn(() => null) };
  return app;
}

const proximityData = { bridges: [], nearestBridge: null };
const loggedWith = (fn, needle) => fn.mock.calls.some((c) => String(c[0]).includes(needle));
const dTP = (lat, lon) => geometry.calculateDistance(lat, lon, TP.lat, TP.lon);
const hasKanal = (app, vessel) => app._getFlowTriggerCandidates(vessel, proximityData)
  .some((c) => c.name === 'Kanalinfarten');

/** Matar en rå fix genom bokföringen och frågar om kandidaten. */
function feed(app, fix) {
  const vessel = {
    mmsi: fix.mmsi,
    lat: fix.lat,
    lon: fix.lon,
    sog: fix.sog,
    cog: fix.cog,
    targetBridge: null,
    passedBridges: [],
  };
  app._noteQuayStability(vessel);
  return { vessel, candidate: hasKanal(app, vessel) };
}

// ─── RÅDATA ────────────────────────────────────────────────────────────────
// LADYBIRD 265636940, fältdygnet 2026-08-19 (avstånden är uträknade mot
// TRIGGER_POINTS.kanalinfarten och stämmer med loggens egna tal).
const LADYBIRD = [
  {
    mmsi: '265636940', t: '06:51:21', lat: 58.26609, lon: 12.26536, sog: 0.3, cog: 137.1,
  }, // 316 m, kajankare
  {
    mmsi: '265636940', t: '06:52:28', lat: 58.26609, lon: 12.26577, sog: 1.0, cog: 92.9,
  }, // 299 m, netto 17
  {
    mmsi: '265636940', t: '06:53:38', lat: 58.26612, lon: 12.26605, sog: 1.1, cog: 74.2,
  }, // 285 m, netto 31 ⇐ FANTOMEN
  {
    mmsi: '265636940', t: '06:54:43', lat: 58.26623, lon: 12.26663, sog: 0.7, cog: 65.7,
  }, // 254 m, sog under transitgränsen
  {
    mmsi: '265636940', t: '06:56:59', lat: 58.26635, lon: 12.26700, sog: 0.6, cog: 255.5,
  }, // 230 m, vänder ⇒ sydbandet
];

// BALTIC JONGLEUR 304028000, samma dygn — ÄKTA insegling (passerade sedan
// Olidebron och fortsatte norrut genom kanalen).
const BALTIC_JONGLEUR = [
  {
    mmsi: '304028000', t: '08:46:13', lat: 58.26548, lon: 12.26338, sog: 0, cog: 59.9,
  }, // 449 m, kajankare
  {
    mmsi: '304028000', t: '08:47:18', lat: 58.26552, lon: 12.26348, sog: 0.5, cog: 62.4,
  }, // 441 m, dödbandet
  {
    mmsi: '304028000', t: '08:48:25', lat: 58.26561, lon: 12.26394, sog: 0.9, cog: 68.6,
  }, // 414 m, dödbandet
  {
    mmsi: '304028000', t: '08:49:33', lat: 58.26573, lon: 12.26450, sog: 0.9, cog: 68.0,
  }, // 381 m, dödbandet
  {
    mmsi: '304028000', t: '08:50:43', lat: 58.26590, lon: 12.26522, sog: 1.5, cog: 67.5,
  }, // 337 m, utanför zonen
  {
    mmsi: '304028000', t: '08:51:50', lat: 58.26619, lon: 12.26634, sog: 2.4, cog: 60.4,
  }, // 268 m ⇐ NOTISEN
];

// ELFKUNGEN 265573130, korpus 20260804-both-21h: kajplatsen ligger 302 m från
// punkten, dvs. PÅ 300 m-gränsen. Hennes FÖRSTA fix inne i zonen bär därför
// bara ~40 m netto — den smalaste marginalen i hela korpusbanken.
const ELFKUNGEN = [
  {
    mmsi: '265573130', t: '09:56:30', lat: 58.26624, lon: 12.26542, sog: 0, cog: 289.4,
  }, // 303 m, kajankare
  {
    mmsi: '265573130', t: '10:02:13', lat: 58.26627, lon: 12.26632, sog: 2.1, cog: 53.7,
  }, // 262 m ⇐ NOTISEN
  {
    mmsi: '265573130', t: '10:03:22', lat: 58.26691, lon: 12.26789, sog: 4.2, cog: 38.3,
  }, // 149 m — hit hade ett 70-golv flyttat notisen
];

// MONIKA 304482000, korpus 20260806-42h: bandbankens ANDRA marginalfall
// (42,0 m netto). I korpusen bokfördes ankaret via den INLÄRDA kajkartan
// (F4-L): hon krypseglade 0,5 kn — under TRANSIT_SOG_KN men inte under
// MOVEMENT_PROOF_SOG_KN — på en känd kajplats, så varje sådant sampel räknades
// som stillasample och flyttade ankaret med henne. Testet sätter samma ankare
// med ett rent stillasample i stället för att bygga hela F4-L-kartan;
// geometrin och grindutfallet är identiska.
const MONIKA = [
  {
    mmsi: '304482000', t: '19:24:02', lat: 58.26606, lon: 12.26604, sog: 0, cog: 65.3,
  }, // 291 m, kajankare (0,5 kn i korpusen — se noten ovan)
  {
    mmsi: '304482000', t: '19:25:12', lat: 58.26626, lon: 12.26670, sog: 1.9, cog: 61,
  }, // 249 m ⇐ NOTISEN, netto 42
  {
    mmsi: '304482000', t: '19:26:20', lat: 58.26674, lon: 12.26771, sog: 2.5, cog: 39.2,
  }, // 171 m — hit hade ett 70-golv flyttat notisen
];

describe('K4: kajgrindens nettogolv på ben (a)', () => {
  test('LADYBIRD-förloppet ger INGEN notiskandidat i något led (fantomen stängd)', () => {
    const app = makeApp();
    const results = LADYBIRD.map((fix) => ({ t: fix.t, ...feed(app, fix) }));

    // Ingen enda av de fem fixarna får ge en Kanalinfartskandidat.
    expect(results.map((r) => `${r.t}:${r.candidate}`)).toEqual([
      '06:51:21:false', '06:52:28:false', '06:53:38:false', '06:54:43:false', '06:56:59:false',
    ]);

    // Det avgörande ledet är 06:53:38: TVÅ rörelsefixar i rad OCH ett positivt
    // netto — exakt den kombination som öppnade grinden före K4.
    const ledger = app._quayStableLedger.get('265636940');
    expect(ledger.movingFixes).toBe(0); // 06:54:43 (0,7 kn) nollade räknaren efteråt
    expect(loggedWith(app.log, 'TRIGGER_POINT_SKIP_QUAY')).toBe(true);
  });

  test('MUTATIONSPROV: med det gamla golvet (>= 0) fyrar LADYBIRD på 06:53:38', () => {
    // Samma tre fixar, men grinden muterad tillbaka till förkravet. Testet
    // ovan är alltså RÖTT utan fixen och inte bara dekoration.
    const app = makeApp();
    const original = app._quayDepartureNeedsProof;
    app._quayDepartureNeedsProof = function mutated(vessel, tp, ledger = null) {
      const book = ledger || this._quayStableLedger;
      const entry = book.get(String(vessel.mmsi));
      if (!entry || !entry.stillAt) return null;
      const anchorDist = geometry.calculateDistance(entry.lat, entry.lon, tp.lat, tp.lon);
      const nowDist = geometry.calculateDistance(vessel.lat, vessel.lon, tp.lat, tp.lon);
      const approachM = anchorDist - nowDist;
      if (approachM >= QUAY_DEPARTURE_GATE.NET_APPROACH_M) return null;
      if (entry.movingFixes >= QUAY_DEPARTURE_GATE.MIN_MOVING_FIXES && approachM >= 0) return null;
      return { stillAgoS: 0, movingFixes: entry.movingFixes, approachM };
    };
    LADYBIRD.slice(0, 2).forEach((fix) => feed(app, fix));
    const third = feed(app, LADYBIRD[2]);
    expect(third.candidate).toBe(true); // fantomen, precis som i fält
    app._quayDepartureNeedsProof = original;
  });

  test('LADYBIRDs netto ligger under golvet — och den smala marginalen är mätt', () => {
    const anchor = LADYBIRD[0];
    const fantom = LADYBIRD[2];
    const approachM = dTP(anchor.lat, anchor.lon) - dTP(fantom.lat, fantom.lon);
    expect(Math.round(approachM)).toBe(31);
    // 31 < 40: fantomen fälls av grindens ENDA golv. Marginalen är 9 m — det
    // är den siffra en framtida sänkning av NET_APPROACH_M måste vägas mot.
    expect(approachM).toBeLessThan(QUAY_DEPARTURE_GATE.NET_APPROACH_M);
  });

  test('BALTIC JONGLEUR (äkta insegling) får sin kandidat på FÖRSTA fixen i zonen', () => {
    const app = makeApp();
    const results = BALTIC_JONGLEUR.map((fix) => ({ t: fix.t, ...feed(app, fix) }));
    // 337 m ligger utanför 300 m-zonen ⇒ ingen kandidat där, som i fält.
    expect(results.find((r) => r.t === '08:50:43').candidate).toBe(false);
    // 268 m: kandidaten går fram, och grinden har inte ens ingripit.
    expect(results.find((r) => r.t === '08:51:50').candidate).toBe(true);
    expect(loggedWith(app.log, 'TRIGGER_POINT_SKIP_QUAY')).toBe(false);
    // Hon bärs av ben (b): nettot mot punkten är 180 m, 2,6× golvet.
    const approachM = dTP(BALTIC_JONGLEUR[0].lat, BALTIC_JONGLEUR[0].lon)
      - dTP(BALTIC_JONGLEUR[5].lat, BALTIC_JONGLEUR[5].lon);
    expect(Math.round(approachM)).toBe(180);
    expect(approachM).toBeGreaterThanOrEqual(QUAY_DEPARTURE_GATE.NET_APPROACH_M);
  });

  test('ELFKUNGEN på 300 m-gränsen behåller sin notis (ben b bär henne, 40 m netto)', () => {
    const app = makeApp();
    feed(app, ELFKUNGEN[0]);
    const departure = feed(app, ELFKUNGEN[1]);
    expect(departure.candidate).toBe(true);
    expect(loggedWith(app.log, 'TRIGGER_POINT_SKIP_QUAY')).toBe(false);

    // MARGINALEN, mätt: kajplatsen ligger 303 m från punkten, första fixen i
    // zonen 262 m ⇒ 40 m netto med EN rörelsefix. Ben (a) hade inte räckt
    // (1 < MIN_MOVING_FIXES) — det är ben (b) som släpper henne, och 40,4 m
    // ligger 0,4 m över golvet. Hade fixen legat 1 m längre bort hade notisen
    // fördröjts en pollcykel (nästa fix bär 154 m netto), aldrig förlorats:
    // dedup-nyckeln sätts inte vid skip.
    const berth = dTP(ELFKUNGEN[0].lat, ELFKUNGEN[0].lon);
    const inZone = dTP(ELFKUNGEN[1].lat, ELFKUNGEN[1].lon);
    expect(Math.round(berth)).toBe(303);
    expect(Math.round(inZone)).toBe(262);
    expect(Math.round(berth - inZone)).toBe(40);
    expect(app._quayStableLedger.get('265573130').movingFixes).toBe(1);
  });

  test('MONIKA (20260806-42h) — bandbankens ANDRA marginalfall, 42 m netto', () => {
    const app = makeApp();
    feed(app, MONIKA[0]);
    const departure = feed(app, MONIKA[1]);
    expect(departure.candidate).toBe(true);
    expect(loggedWith(app.log, 'TRIGGER_POINT_SKIP_QUAY')).toBe(false);

    const anchor = dTP(MONIKA[0].lat, MONIKA[0].lon);
    const inZone = dTP(MONIKA[1].lat, MONIKA[1].lon);
    expect(Math.round(anchor)).toBe(291);
    expect(Math.round(inZone)).toBe(249);
    expect(Math.round(anchor - inZone)).toBe(42);
    expect(app._quayStableLedger.get('304482000').movingFixes).toBe(1);
  });

  test('BESLUTET: bandet 40–69 m innehåller BARA äkta inseglare ⇒ golvet stannar på 40', () => {
    // Rådatamätning 2026-08-22 (dirigentfråga efter granskningen). Grinden
    // konsulterades 14 gånger i hela korpusbanken; nettoserien var
    // 40, 42, 84, 129, 158, 159, 183, 190, 192, 203, 207, 219, 249, 253 m.
    // BARA två ligger under 70 — och båda genomförde transit enligt
    // gt-passages (rådatafacit, oberoende av appen):
    //   ELFKUNGEN 265573130  Olidebron 10:07:19 nord, Klaffbron 10:15:12 nord
    //   MONIKA    304482000  Olidebron 19:33:08, Klaffbron 19:47:17,
    //                        Stridsbergsbron 20:01:08 — alla nord
    // Ett 70-metersgolv hade alltså fällt NOLL fantomer (LADYBIRDs 31 m fälls
    // redan av 40) men försenat båda dessa notiser en pollcykel.
    const HYPOTETISKT_HOGRE_GOLV_M = 70;
    const cases = [
      { label: 'ELFKUNGEN', fixes: ELFKUNGEN, forsening: [262, 149] },
      { label: 'MONIKA', fixes: MONIKA, forsening: [249, 171] },
    ];
    for (const c of cases) {
      const netto = dTP(c.fixes[0].lat, c.fixes[0].lon) - dTP(c.fixes[1].lat, c.fixes[1].lon);
      // Släpps i dag av ben (b) …
      expect(netto).toBeGreaterThanOrEqual(QUAY_DEPARTURE_GATE.NET_APPROACH_M);
      // … men hade fällts av ett 70-metersgolv.
      expect(netto).toBeLessThan(HYPOTETISKT_HOGRE_GOLV_M);
      // Priset hade varit förvarningsavstånd: notisen flyttas till NÄSTA fix.
      expect(Math.round(dTP(c.fixes[1].lat, c.fixes[1].lon))).toBe(c.forsening[0]);
      expect(Math.round(dTP(c.fixes[2].lat, c.fixes[2].lon))).toBe(c.forsening[1]);
      // Den fixen bär ett netto långt över det hypotetiska golvet ⇒ notisen
      // hade fördröjts en pollcykel, inte förlorats.
      const nettoNasta = dTP(c.fixes[0].lat, c.fixes[0].lon) - dTP(c.fixes[2].lat, c.fixes[2].lon);
      expect(nettoNasta).toBeGreaterThan(HYPOTETISKT_HOGRE_GOLV_M);
    }
  });

  test('SUBSUMTIONEN: (b) äger allt känt netto, (a) bär "netto okänt"', () => {
    // Grindens FAKTISKA kontrakt, svart på vitt: "netto ≥ NET_APPROACH_M
    // ELLER (netto OKÄNT och MIN_MOVING_FIXES rörelsefixar)". K4:s första
    // variant skrev ett eget 70-metersgolv på ben (a), men den grenen kunde
    // aldrig utvärderas sant med ett ändligt netto (ben b hade redan
    // returnerat), så konstanten är borttagen och villkoret säger nu
    // approachM === null. Sanningsmängden är oförändrad — det är exakt det
    // punkterna (i)–(iii) nedan mäter.
    const gate = (netM, movingFixes, anchorHasPosition = true) => {
      const app = makeApp();
      const anchorDist = 250 + netM;
      app._quayStableLedger.set('265999900', {
        stillAt: Date.now() - 60 * 1000,
        lat: anchorHasPosition ? TP.lat - anchorDist / 111320 : null,
        lon: anchorHasPosition ? TP.lon : null,
        movingFixes,
      });
      const vessel = {
        mmsi: '265999900',
        lat: TP.lat - 250 / 111320,
        lon: TP.lon,
        sog: 1.2,
        cog: 100,
        targetBridge: null,
      };
      return app._quayDepartureNeedsProof(vessel, TP);
    };

    // (i) LADYBIRD-bandet: netto under (b):s tröskel + två rörelsefixar
    //     ⇒ BLOCKERAS nu (före K4 räckte rörelsefixarna).
    expect(gate(31, QUAY_DEPARTURE_GATE.MIN_MOVING_FIXES)).not.toBeNull();
    expect(gate(QUAY_DEPARTURE_GATE.NET_APPROACH_M - 1, QUAY_DEPARTURE_GATE.MIN_MOVING_FIXES))
      .not.toBeNull();
    // (ii) Ben (b) är ORÖRT: strax över tröskeln släpper utan en enda
    //      rörelsefix. (+1 m marginal: den syntetiska lat-geometrin ger
    //      39,99 m för exakt tröskelvärdet.)
    expect(gate(QUAY_DEPARTURE_GATE.NET_APPROACH_M + 1, 0)).toBeNull();
    // (iii) Ben (a):s kvarvarande egna fall: nettot är okänt.
    expect(gate(0, QUAY_DEPARTURE_GATE.MIN_MOVING_FIXES, false)).toBeNull();
    expect(gate(0, QUAY_DEPARTURE_GATE.MIN_MOVING_FIXES - 1, false)).not.toBeNull();
  });

  test('KONSTANTKONTRAKTET: EXAKT ETT nettogolv, och det är 40 m', () => {
    // Den döda MIN_NET_APPROACH_M är borttagen 2026-08-22. Kommer den
    // tillbaka ska det vara ett medvetet beslut med ny mätning — inte en
    // återinförd dekoration.
    expect(QUAY_DEPARTURE_GATE.NET_APPROACH_M).toBe(40);
    expect(QUAY_DEPARTURE_GATE.MIN_NET_APPROACH_M).toBeUndefined();
    expect(Object.keys(QUAY_DEPARTURE_GATE).filter((k) => k.includes('NET_APPROACH')))
      .toEqual(['NET_APPROACH_M']);
  });

  test('ÖPPNINGSLAGRET ärver golvet (samma predikat, ingen parallell sanning)', () => {
    // _isBridgeOpeningQuayWobbler frågar SAMMA predikat med öppningslagrets
    // egen karta och målbron som referenspunkt. Golvet måste därför följa med
    // dit — annars börjar de två lagren glida isär.
    const app = makeApp();
    const bridge = constants.BRIDGES.klaffbron;
    const openingLedger = new Map();
    openingLedger.set('265999901', {
      stillAt: Date.now() - 60 * 1000,
      bandSince: Date.now() - 60 * 1000,
      lat: bridge.lat - 331 / 111320,
      lon: bridge.lon,
      movingFixes: QUAY_DEPARTURE_GATE.MIN_MOVING_FIXES,
      moving: true,
    });
    const vessel = {
      mmsi: '265999901', lat: bridge.lat - 300 / 111320, lon: bridge.lon, sog: 0.9, cog: 30,
    };
    // 31 m netto mot MÅLBRON — LADYBIRDs tal — ⇒ kräver fortfarande bevis.
    expect(app._quayDepartureNeedsProof(vessel, bridge, openingLedger)).not.toBeNull();
    // ⚠️ ARVET GÅR ÅT BÅDA HÅLL: en framtida HÖJNING av NET_APPROACH_M följer
    // med hit och kan kosta en ÖPPNINGSvarning, vilket är dyrare än en notis.
    // Det är ett av skälen till att golvet stannade på 40.
  });
});
