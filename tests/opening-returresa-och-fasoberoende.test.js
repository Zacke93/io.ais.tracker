'use strict';

/**
 * K2 — konvojens medlemskap (rättningskampanjen 2026-11-04).
 *
 * B02 / U15: en båt som passerar en bro, vänder och kommer tillbaka får en
 * EGEN bridge_opening_soon för returen, även inom konvojfönstret (600 s).
 * Ingen händelse som beskriver öppningen hon redan passerat får täcka
 * returen: hennes egen, eller en vars öppning (första passage, annars
 * prognosen vid varningen) ligger inom konvojfönstret från hennes passage.
 * Returminnet är frikopplat från händelsestädningen, och returen får sin
 * egen varning även under 60 s före ankomsten (dirigentens beslut
 * 2026-11-05: U15 utan golvundantag).
 *
 * F09: regeln "en varning som gick medan båten hölls vid en tidigare bro
 * täcker inte hennes senare ankomst" får inte bero på när den halvminutsvisa
 * ticken eller en annan båts fix råkar komma. Den avgörs av båtens egna fix:
 * släpp när ett eget fix efter varningen visar henne kvar i kön, när hennes
 * nästa fix kom mer än en tick (30 s) efter varningen medan hon hölls, eller
 * när spärren löpte ut i tystnad. "Efter varningen" är bearbetningsordning,
 * så ett fix i samma millisekund får samma svar vid varje utvärdering.
 * Konvojundantaget är oförändrat från 7699cbe (se DESIGN.md, kvarvarande).
 *
 * Testerna som fäller 7699cbe (före rättningen) är markerade "7699cbe: rött"
 * i sina kommentarer; de negativa fallen låser att rättningen inte blir
 * bredare än klassen.
 */

global.__TEST_MODE__ = true;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');

const STRIDS = BRIDGES.stridsbergsbron;
const T0 = Date.parse('2026-06-16T08:20:00.000Z');

/** Position `distanceM` från bron; bäring 220° = söder, 40° = norr i farleden. */
function posAtDistance(bridge, distanceM, bearingDeg) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceM * Math.cos(rad)) / 111320;
  const dLon = (distanceM * Math.sin(rad)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180));
  return { lat: bridge.lat + dLat, lon: bridge.lon + dLon };
}

/** Fartyg på `side` ('syd'|'norr') om Stridsbergsbron, på väg `dir`. */
function vessel(mmsi, distanceM, side, dir, extra = {}) {
  const pos = posAtDistance(STRIDS, distanceM, side === 'syd' ? 220 : 40);
  const now = Date.now();
  return {
    mmsi,
    name: `K2-${mmsi.slice(-3)}`,
    lat: pos.lat,
    lon: pos.lon,
    sog: 6.5,
    cog: dir === 'north' ? 40 : 220,
    timestamp: now,
    fixTs: now,
    targetBridge: 'Stridsbergsbron',
    _routeDirection: dir,
    _finalTargetDirection: null,
    _hasMovementProof: true,
    _moored: false,
    _stationarySince: null,
    navStatus: null,
    etaMinutes: null,
    passedAt: {},
    passedBridges: [],
    ...extra,
  };
}

describe('U15 (B02): returresan får en egen öppningsvarning', () => {
  let svc;
  let warnings;
  let coverage;

  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    warnings = [];
    coverage = [];
    svc = new BridgeOpeningService({
      onWarning: (payload) => warnings.push(payload),
      onCoverage: (row) => coverage.push(row),
      targetBridges: ['Stridsbergsbron'],
      scheduleDeadlines: true,
    });
  });
  afterEach(() => {
    svc.destroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  const at = (t) => jest.setSystemTime(T0 + t * 1000);

  test('VEGA passerar norrut, vänder 880 m bortom bron och får egen varning före returen', () => {
    // 7699cbe: rött (absorberad i sin egen händelse, värld 1273).
    const VEGA = '265441711';
    svc.observeVessel(vessel(VEGA, 900, 'syd', 'north'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ leadMmsi: VEGA, direction: 'northbound' });

    at(130);
    svc.notePassage(VEGA, 'Stridsbergsbron');
    at(400);
    // Vänd och på väg tillbaka söderut, 700 m norr om bron, inom konvojfönstret
    // räknat från passagen (returen väntas ≈ 08:30, passagen var 08:22:10).
    svc.observeVessel(vessel(VEGA, 700, 'norr', 'south', { sog: 6.8 }));

    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toMatchObject({ leadMmsi: VEGA, mmsis: [VEGA], direction: 'southbound' });
    expect(warnings[1].eventId).not.toBe(warnings[0].eventId);
  });

  test('två händelser för samma öppning: varning som gick före båtens passage täcker inte returen', () => {
    // 7699cbe: rött (värld 936-mönstret).
    // B (söderut, långsam) seedar egen händelse; A (norrut) får en annan.
    // Båda passerar bron inom en halvminut — samma fysiska öppning med två
    // händelser. B vänder och kommer tillbaka norrut.
    // Deadline = avstånd / 10 kn − 180 s ledtid: B (2000 m) avfyrar vid 208 s.
    const A = '265664285';
    const B = '265664174';
    svc.observeVessel(vessel(B, 2000, 'norr', 'south', { sog: 2 }));
    at(210);
    svc.tick();
    expect(warnings.map((w) => w.leadMmsi)).toEqual([B]);

    at(220);
    svc.observeVessel(vessel(A, 900, 'syd', 'north', { sog: 6 }));
    expect(warnings.map((w) => w.leadMmsi)).toEqual([B, A]);

    at(480);
    svc.notePassage(B, 'Stridsbergsbron');
    at(500);
    svc.notePassage(A, 'Stridsbergsbron');

    // B tillbaka norrut 600 m söder om bron: ankomst ≈ 894 s, inom 600 s från
    // båda händelsernas passager — men båda varningarna gick före hennes passage.
    at(700);
    svc.observeVessel(vessel(B, 600, 'syd', 'north', { sog: 6 }));

    expect(warnings).toHaveLength(3);
    expect(warnings[2]).toMatchObject({ leadMmsi: B, mmsis: [B], direction: 'northbound' });
  });

  test('spegelbilden: en händelse som varnar EFTER passagen men korsar inom fönstret täcker inte returen', () => {
    // Granskningen 2026-11-04 (sonden b02-spegel). 7699cbe och första K2: rött.
    // A passerar norrut 150 s; B:s händelse varnar 215 s och B korsar söderut
    // 225 s, 75 s efter A — samma fysiska öppning med två händelser, men B:s
    // varning gick EFTER A:s passage. A vänder och kommer tillbaka söderut.
    const A = '265000301';
    const B = '265000302';
    svc.observeVessel(vessel(A, 900, 'syd', 'north'));
    at(5);
    svc.observeVessel(vessel(B, 2000, 'norr', 'south', { sog: 2 }));
    at(150);
    svc.notePassage(A, 'Stridsbergsbron');
    at(215);
    svc.tick();
    expect(warnings.map((w) => w.leadMmsi)).toEqual([A, B]);
    at(225);
    svc.notePassage(B, 'Stridsbergsbron');

    at(400);
    svc.observeVessel(vessel(A, 600, 'norr', 'south', { sog: 6 }));

    expect(warnings.map((w) => w.leadMmsi)).toEqual([A, B, A]);
    expect(warnings[2]).toMatchObject({ mmsis: [A], direction: 'southbound' });
  });

  test('samma öppning syns först efter returarmen: släpps när B korsar inom fönstret från A:s passage', () => {
    // 7699cbe och första K2: rött. B:s händelse varnar efter A:s passage, och
    // A:s returarm absorberas i den medan B ännu inte korsat (B:s prognos,
    // ≈ 977 s, ligger inom fönstret från A:s retur, ≈ 414 s). När B korsar
    // 150 s efter A är B:s händelse samma öppning som A redan passerat, och A
    // får sin egen varning.
    const A = '265000311';
    const B = '265000312';
    svc.observeVessel(vessel(A, 900, 'syd', 'north'));
    at(5);
    svc.observeVessel(vessel(B, 2000, 'norr', 'south', { sog: 4 }));
    at(150);
    svc.notePassage(A, 'Stridsbergsbron');
    at(215);
    svc.tick();
    expect(warnings.map((w) => w.leadMmsi)).toEqual([A, B]);

    at(220);
    svc.observeVessel(vessel(A, 600, 'norr', 'south', { sog: 6 }));
    // Varningen gick efter hennes passage och B har inte korsat: får täcka.
    expect(warnings).toHaveLength(2);
    expect(svc._arms.get(`${A}::Stridsbergsbron`).eventId).toBe(warnings[1].eventId);

    at(250);
    svc.observeVessel(vessel(B, 120, 'norr', 'south', { sog: 6 }));
    at(300);
    svc.notePassage(B, 'Stridsbergsbron');

    expect(warnings.map((w) => w.leadMmsi)).toEqual([A, B, A]);
    expect(warnings[2]).toMatchObject({ mmsis: [A], direction: 'southbound' });
    expect(warnings[2].t).toBe(T0 + 300000);
  });

  test('negativt: vändning FÖRE bron (ingen passage) ger ingen andrapåminnelse', () => {
    const MMSI = '265000101';
    svc.observeVessel(vessel(MMSI, 900, 'syd', 'north'));
    expect(warnings).toHaveLength(1);

    at(60);
    svc.observeVessel(vessel(MMSI, 700, 'syd', 'south', { targetBridge: null }));
    at(120);
    svc.observeVessel(vessel(MMSI, 650, 'syd', 'north'));

    expect(warnings).toHaveLength(1);
  });

  test('negativt: en varning som gick EFTER båtens passage får täcka returen (konvoj)', () => {
    const V = '265000201';
    const W = '265000202';
    svc.observeVessel(vessel(V, 900, 'syd', 'north'));
    at(130);
    svc.notePassage(V, 'Stridsbergsbron');

    // W söderut 2400 m ut: ankomst ≈ 928 s, mer än 600 s efter V:s passage ⇒
    // egen händelse, som avfyrar vid sin deadline (≈ 437 s) — efter passagen.
    at(150);
    svc.observeVessel(vessel(W, 2400, 'norr', 'south', { sog: 6 }));
    at(440);
    svc.tick();
    expect(warnings.map((w) => w.leadMmsi)).toEqual([V, W]);
    expect(warnings[1].t).toBeGreaterThan(T0 + 130000);

    // V vänder och kommer söderut med ankomst (≈ 660 s) i W:s fönster: absorberas.
    at(460);
    svc.observeVessel(vessel(V, 700, 'norr', 'south', { sog: 6.8 }));
    expect(warnings).toHaveLength(2);
    expect(svc._arms.get(`${V}::Stridsbergsbron`).eventId).toBe(warnings[1].eventId);
  });

  test('negativt: händelsens första passage mer än ett konvojfönster efter hennes ⇒ nästa öppning, täcker returen', () => {
    // A passerar 150 s. B:s händelse varnar ≈ 587 s och B korsar 800 s, 650 s
    // efter A — utanför konvojfönstret, alltså nästa öppning. A:s retur, som
    // absorberades i B:s händelse, ska inte få någon extra varning.
    const A = '265000321';
    const B = '265000322';
    svc.observeVessel(vessel(A, 900, 'syd', 'north'));
    at(150);
    svc.notePassage(A, 'Stridsbergsbron');
    at(300);
    svc.observeVessel(vessel(B, 2400, 'norr', 'south', { sog: 6 }));
    at(590);
    svc.tick();
    expect(warnings.map((w) => w.leadMmsi)).toEqual([A, B]);

    at(700);
    svc.observeVessel(vessel(A, 700, 'norr', 'south', { sog: 6.8 }));
    expect(svc._arms.get(`${A}::Stridsbergsbron`).eventId).toBe(warnings[1].eventId);
    at(800);
    svc.notePassage(B, 'Stridsbergsbron');
    at(830);
    svc.observeVessel(vessel(A, 150, 'norr', 'south', { sog: 6.8 }));
    svc.tick();

    expect(warnings.map((w) => w.leadMmsi)).toEqual([A, B]);
  });

  test('inget ledtidsgolv: returarm 58 s från ankomsten får egen varning direkt (U15, dirigentens beslut 2026-11-05)', () => {
    // 7699cbe: rött (absorberad i sin egen händelse). 5e273df: rött (golvet
    // höll kvar den gamla täckningen tills ett senare fix visade en ankomst
    // bortom 60 s, här 230 s).
    const V = '265000401';
    svc.observeVessel(vessel(V, 900, 'syd', 'north'));
    at(130);
    svc.notePassage(V, 'Stridsbergsbron');
    at(200);
    svc.observeVessel(vessel(V, 150, 'norr', 'south', { sog: 5 }));
    svc.tick();

    expect(warnings.map((w) => w.leadMmsi)).toEqual([V, V]);
    expect(warnings[1]).toMatchObject({ direction: 'southbound', mmsis: [V] });
    expect(warnings[1].t).toBe(T0 + 200000);

    // Hon väntar sedan vid bron i fem minuter: ingen tredje varning
    // (returen är varnad som medlem, U2 "inga andrapåminnelser").
    for (let s = 230; s <= 470; s += 30) {
      at(s);
      svc.observeVessel(vessel(V, 140, 'norr', 'south', { sog: 0.2 }));
      svc.tick();
    }
    at(500);
    svc.notePassage(V, 'Stridsbergsbron');
    expect(warnings).toHaveLength(2);
  });

  test('inget ledtidsgolv: returen upptäcks 12 s före ankomsten och får ändå egen varning', () => {
    // Värld 1918-klassen (GUNHILD, 12 s kvar). 5e273df: rött (golvet stod kvar,
    // och returen täcktes av hennes egen gamla händelse).
    const V = '265000411';
    svc.observeVessel(vessel(V, 900, 'syd', 'north'));
    at(130);
    svc.notePassage(V, 'Stridsbergsbron');
    at(225);
    svc.observeVessel(vessel(V, 31, 'norr', 'south', { sog: 5 }));
    svc.tick();
    at(240);
    svc.notePassage(V, 'Stridsbergsbron');

    expect(warnings.map((w) => w.leadMmsi)).toEqual([V, V]);
    expect(warnings[1]).toMatchObject({ direction: 'southbound', mmsis: [V] });
    expect(warnings[1].t).toBeLessThan(T0 + 240000);
  });

  // Granskarens sond b02-936-kant (omgranskningen 2026-11-05). X passerar
  // norrut 130 s i sin egen händelse (varnad 0 s). Y:s händelse varnar 287 s
  // och Y korsar söderut 630 s, 500 s efter X: samma öppning (dig9). X:s egen
  // händelse löper ut 730 s och städas vid nästa utvärdering. Returarmen
  // skapas `armS` sekunder in, 300 s före returkorsningen.
  function kantRun(armS, phaseS) {
    const X = '265000921';
    const Y = '265000922';
    const script = [
      [0, () => svc.observeVessel(vessel(X, 900, 'syd', 'north', { sog: 6.5 }))],
      [1, () => svc.observeVessel(vessel(Y, 2400, 'norr', 'south', { sog: 4 }))],
      [130, () => svc.notePassage(X, 'Stridsbergsbron')],
      [630, () => svc.notePassage(Y, 'Stridsbergsbron')],
      [armS, () => svc.observeVessel(vessel(X, 300 * 4 * 0.514444, 'norr', 'south', { sog: 4 }))],
    ];
    for (let s = phaseS; s <= armS + 299; s += 30) script.push([s, () => svc.tick()]);
    script.sort((a, b) => a[0] - b[0]);
    for (const [s, step] of script) {
      at(s);
      step();
    }
    const arm = svc._arms.get(`${X}::Stridsbergsbron`);
    return {
      warnings: warnings.map((w) => `${w.leadMmsi === X ? 'X' : 'Y'}:${w.direction}`),
      ownWarning: !!arm && arm.warnedAt !== null && arm.absorbedAt === null,
    };
  }

  test('returminnet: returarm efter att hennes egen händelse städats får ändå egen varning', () => {
    // 7699cbe och 5e273df: rött (absorberad i Y:s händelse, vars öppning hon
    // redan passerat). Deterministiskt: armen skapas 780 s, långt efter att
    // X:s egen händelse städats, medan Y:s händelse lever till 1230 s.
    const r = kantRun(780, 0.5);
    expect(r.warnings).toEqual(['X:northbound', 'Y:southbound', 'X:southbound']);
    expect(r.ownWarning).toBe(true);
  });

  test.each([732, 745, 758])(
    'returminnet: kanten kring städningen (returarm %i s) ger samma utfall i alla 30 tickfaser',
    (armS) => {
      // 5e273df: rött (2, 15 respektive 28 av 30 faser utan egen varning).
      const outcomes = new Set();
      for (let phase = 0.5; phase < 30; phase += 1) {
        svc.destroy();
        jest.setSystemTime(T0);
        warnings = [];
        svc = new BridgeOpeningService({
          onWarning: (payload) => warnings.push(payload),
          targetBridges: ['Stridsbergsbron'],
          scheduleDeadlines: true,
        });
        const r = kantRun(armS, phase);
        outcomes.add(`${r.warnings.join(',')}|${r.ownWarning}`);
      }
      expect([...outcomes]).toEqual(['X:northbound,Y:southbound,X:southbound|true']);
    },
  );

  test('returminnet bokförs även när armen saknar händelse vid passagen', () => {
    // 7699cbe och 5e273df: rött. A:s arm är lös (restartArrival, eventId null)
    // när hon passerar 10 s efter B, i samma öppning som B:s varning. Förut
    // bokfördes passagen bara på hennes händelse, så returen absorberades i
    // B:s händelse.
    const A = '265000331';
    const B = '265000332';
    svc.observeVessel(vessel(B, 900, 'syd', 'north'));
    expect(warnings.map((w) => w.leadMmsi)).toEqual([B]);
    at(5);
    svc.observeVessel(vessel(A, 950, 'syd', 'north'));
    expect(svc._arms.get(`${A}::Stridsbergsbron`).eventId).toBe(warnings[0].eventId);
    at(120);
    svc.notePassage(B, 'Stridsbergsbron');
    at(125);
    svc.restartArrival(A, 'Stridsbergsbron');
    at(130);
    svc.notePassage(A, 'Stridsbergsbron');

    at(400);
    svc.observeVessel(vessel(A, 700, 'norr', 'south', { sog: 6.8 }));
    expect(warnings.map((w) => w.leadMmsi)).toEqual([B, A]);
    expect(warnings[1]).toMatchObject({ mmsis: [A], direction: 'southbound' });
  });

  test('returminnet städas när ingen levande händelse längre beskriver öppningen', () => {
    const V = '265000341';
    svc.observeVessel(vessel(V, 900, 'syd', 'north'));
    at(130);
    svc.notePassage(V, 'Stridsbergsbron');
    expect(svc._passageMemory.size).toBe(1);
    // Händelsen lever till 130 + 600 s; minnet minst ett konvojfönster.
    at(700);
    svc.tick();
    expect(svc._passageMemory.size).toBe(1);
    at(760);
    svc.tick();
    expect(svc._passageMemory.size).toBe(0);
  });

  // Villkor (b) (omgranskningen 2026-11-05, sonden b02-senare-oppning): en
  // varning för en SENARE öppning täcker returen oavsett om den gick före
  // eller efter hennes passage. B söderut i 2 kn varnar för ankomst ≈ 2333 s;
  // A passerar 300 s, vänder och kommer söderut med ankomst ≈ 2794 s, i B:s
  // fönster. Den gamla regeln (varning före passagen spärras) gav A en tredje
  // varning när B:s varning gick 286 s, men inte när den gick efter 300 s.
  test.each([
    ['före', 200],
    ['efter', 315],
  ])('villkor (b): en varning %s hennes passage för en senare öppning täcker returen', (_label, bFirstFixS) => {
    // 5e273df: rött för "före" (tre varningar).
    const A = '265000901';
    const B = '265000902';
    at(bFirstFixS - 200);
    svc.observeVessel(vessel(B, 2400, 'norr', 'south', { sog: 2 }));
    at(100);
    svc.observeVessel(vessel(A, 700, 'syd', 'north', { sog: 6 }));
    at(300);
    svc.notePassage(A, 'Stridsbergsbron');
    at(bFirstFixS + 120);
    svc.tick();
    expect(warnings.map((w) => w.leadMmsi)).toEqual([A, B]);
    at(850);
    svc.observeVessel(vessel(A, 2000, 'norr', 'south', { sog: 2 }));
    svc.tick();

    expect(warnings.map((w) => w.leadMmsi)).toEqual([A, B]);
    expect(svc._arms.get(`${A}::Stridsbergsbron`).eventId).toBe(warnings[1].eventId);
  });
});

describe('F09: "hölls vid en tidigare bro" beror inte på tickens fas', () => {
  // Samma geometri som opening-confirmed-waiting-eta.test.js: målbro
  // Stridsbergsbron norrut, kö vid Järnvägsbron (257 m söder om målbron).
  const START = Date.parse('2026-07-10T05:44:00.000Z');
  const LEAD = '265606970';
  const FOLLOWER = '265552100';
  const boat = (mmsi, distance, extra = {}) => ({
    mmsi,
    name: mmsi === LEAD ? 'PILOT 761' : 'VIRGO',
    lat: STRIDS.lat - distance / 111320,
    lon: STRIDS.lon,
    sog: 4.2,
    cog: 0,
    targetBridge: 'Stridsbergsbron',
    _routeDirection: 'north',
    _hasMovementProof: true,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now(),
    fixFeed: 'aisstream',
    status: 'approaching',
    etaMinutes: null,
    ...extra,
  });
  // Söderut från norr om bron (för en andra, fristående händelse).
  const southbound = (mmsi, distance, extra = {}) => ({
    ...boat(mmsi, 0, extra),
    name: `SYD-${mmsi.slice(-3)}`,
    lat: STRIDS.lat + distance / 111320,
    cog: 180,
    _routeDirection: 'south',
    ...extra,
  });
  const queueEvidence = () => ({
    _bridgeQueueApproaches: { Järnvägsbron: { confirmedAt: Date.now() - 180000, direction: 'north' } },
  });
  const queued = () => {
    const v = boat(FOLLOWER, 402, { sog: 0.1, status: 'waiting' });
    return Object.assign(v, {
      _stationarySince: Date.now() - 120000,
      _stillnessAnchor: { lat: v.lat, lon: v.lon, t: Date.now() - 120000 },
      _bridgeQueueApproaches: { Järnvägsbron: { confirmedAt: Date.now() - 180000, direction: 'north' } },
    });
  };

  let svc;
  let warnings;
  let coverage;
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    warnings = [];
    coverage = [];
    svc = new BridgeOpeningService({
      onWarning: (payload) => warnings.push(payload),
      onCoverage: (row) => coverage.push(row),
      targetBridges: ['Stridsbergsbron'],
      scheduleDeadlines: true,
    });
  });
  afterEach(() => {
    svc.destroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  /**
   * Kör ett manus mot app.js 30 s-watchdog med given fas. Manuset är en lista
   * [sekund efter START, funktion]; watchdogen tickar på START + fas + n·30 s
   * (n ≥ 0) fram till `endS`. Vid samma sekund går manusets steg först.
   * Servicens egna deadlinetimrar (scheduleDeadlines) körs som i appen.
   */
  const play = (phaseS, script, endS = 120) => {
    const ticks = [];
    for (let s = phaseS; s <= endS; s += BRIDGE_OPENING.TICK_INTERVAL_MS / 1000) {
      ticks.push([s, () => svc.tick()]);
    }
    let nowS = 0;
    for (const [s, step] of [...script, ...ticks].sort((a, b) => a[0] - b[0])) {
      if (s > nowS) jest.advanceTimersByTime(Math.round((s - nowS) * 1000));
      nowS = Math.max(nowS, s);
      step();
    }
  };

  // Följaren står i kö när ledarens reservvarning går ut och lämnar kön
  // 8 s senare (VIRGO 05:44:09 → 05:44:17 i 20260710-13h).
  const leftQueueRightAfterWarning = (gapS) => [
    [0.1, () => svc.observeVessel(queued())],
    [10, () => svc.observeVessel(boat(LEAD, 150, { passedBridges: ['Järnvägsbron'] }))],
    [10 + gapS, () => svc.observeVessel(boat(FOLLOWER, 230, { passedBridges: ['Järnvägsbron'] }))],
  ];

  test.each([0.5, 3, 5, 8, 12, 15, 20, 25, 29])(
    'lämnar kön 8 s efter varningen: absorberas vid varje tickfas (fas %s s)',
    (phaseS) => {
      // 7699cbe: rött vid fas 12 och 15 s.
      play(phaseS, leftQueueRightAfterWarning(8));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ leadMmsi: LEAD });
      const arm = svc._arms.get(`${FOLLOWER}::Stridsbergsbron`);
      expect(arm.eventId).toBe(warnings[0].eventId);
      expect(arm.absorbedAt).not.toBeNull();
    },
  );

  test.each([0.5, 8, 15, 25])(
    'kvar i kön mer än en tick efter varningen: egen varning vid varje tickfas (fas %s s)',
    (phaseS) => {
      play(phaseS, leftQueueRightAfterWarning(45));
      expect(warnings.map((w) => w.leadMmsi)).toEqual([LEAD, FOLLOWER]);
    },
  );

  test.each([1, 4, 6, 7, 8, 10, 15, 20, 25, 29])(
    'tät konvoj vid nästa egna fix 33,5 s efter varningen: samma utfall vid varje tickfas (fas %s s)',
    (phaseS) => {
      // Granskningen 2026-11-04 (sonden f09-konvojfas). Första K2: rött vid fas
      // 6–8 s, där ticken landade mer än 30 s efter varningen men före hennes
      // fix och släppte händelsen. Följaren hålls av kön vid Järnvägsbron men
      // rör sig (2,1 kn) tätt bakom ledaren; hennes nästa fix visar konvojen.
      // Avgörandet ska fattas där, ur hennes egna data, i alla faser.
      play(phaseS, [
        [0, () => svc.observeVessel(boat(FOLLOWER, 500, { sog: 2.1, ...queueEvidence() }))],
        [65, () => svc.observeVessel(boat(LEAD, 200, { sog: 4, passedBridges: ['Järnvägsbron'] }))],
        [90, () => svc.observeVessel(boat(LEAD, 149, { sog: 4, passedBridges: ['Järnvägsbron'] }))],
        [98.5, () => svc.observeVessel(boat(FOLLOWER, 400, { sog: 2.1, ...queueEvidence() }))],
      ], 400);
      expect(warnings.map((w) => w.leadMmsi)).toEqual([LEAD]);
      const arm = svc._arms.get(`${FOLLOWER}::Stridsbergsbron`);
      expect(arm.eventId).toBe(warnings[0].eventId);
      expect(arm.absorbedAt).not.toBeNull();
    },
  );

  test('eget fix efter varningen visar henne kvar i kön: egen varning (AKIRA-regeln, a8d7b76)', () => {
    play(0.5, [
      [1, () => svc.observeVessel(queued())],
      [10, () => svc.observeVessel(boat(LEAD, 150, { passedBridges: ['Järnvägsbron'] }))],
      [14, () => svc.observeVessel(queued())],
      [20, () => svc.observeVessel(boat(FOLLOWER, 230, { passedBridges: ['Järnvägsbron'] }))],
    ]);
    expect(warnings.map((w) => w.leadMmsi)).toEqual([LEAD, FOLLOWER]);
  });

  test.each([0.5, 5, 9, 12, 20, 29])(
    'tystnar i kön och spärren löper ut 20 s efter varningen: egen reservvarning vid varje tickfas (fas %s s)',
    (phaseS) => {
      // 7699cbe: rött vid tre faser. Värld 2 i buggjägarens quick-körning:
      // NORDVIND tystnade i kön och spärren (5 min från hennes fix) löpte ut
      // 22 s efter WILMAs varning. Hon har aldrig visat att hon lämnat kön, så
      // varningen täcker henne inte.
      play(phaseS, [
        [0.1, () => svc.observeVessel(queued())],
        [280, () => svc.observeVessel(boat(LEAD, 150, { passedBridges: ['Järnvägsbron'] }))],
      ], 400);
      expect(warnings.map((w) => w.leadMmsi)).toEqual([LEAD, FOLLOWER]);
      expect(warnings[1]).toMatchObject({ firedBy: 'deadline', etaMinutes: null });
    },
  );

  test('radiotystnad i kön: spärren löper ut och reservvarningen går (oförändrat)', () => {
    play(0.5, [
      [1, () => svc.observeVessel(queued())],
      [10, () => svc.observeVessel(boat(LEAD, 150, { passedBridges: ['Järnvägsbron'] }))],
    ]);
    // Inga fler fix från följaren: spärren (5 min från hennes fix) släpper.
    jest.advanceTimersByTime(5 * 60000);
    expect(warnings.map((w) => w.leadMmsi)).toEqual([LEAD, FOLLOWER]);
    expect(warnings[1]).toMatchObject({ firedBy: 'deadline', etaMinutes: null });
  });

  test('absorberad i en konvoj, hålls vid en tidigare bro när en annan händelse varnar: den täcker henne inte efter RECOVER', () => {
    // 7699cbe: rött. Mönstret bakom CARAT i 20260804-17h: hon låg absorberad
    // (konvoj) när PAPOUs händelse varnade och hölls då vid Järnvägsbron.
    // När konvojtäckningen löpte ut absorberades hon förut i PAPOUs händelse
    // och fick sin varning först när DEN täckningen löpt ut. Spärren medan hon
    // var absorberad räknas nu med: hennes egna fix visar att hon stod kvar
    // mer än en tick efter den varningen, så den täcker henne inte.
    const OTHER = '265000501';
    play(0.5, [
      [0, () => svc.observeVessel(boat(FOLLOWER, 500, { sog: 2.1, ...queueEvidence() }))],
      [65, () => svc.observeVessel(boat(LEAD, 200, { sog: 4, passedBridges: ['Järnvägsbron'] }))],
      [90, () => svc.observeVessel(boat(LEAD, 149, { sog: 4, passedBridges: ['Järnvägsbron'] }))],
      [98.5, () => svc.observeVessel(boat(FOLLOWER, 400, { sog: 2.1, ...queueEvidence() }))],
      [120, () => svc.notePassage(LEAD, 'Stridsbergsbron')],
      // En båt söderut med ankomst ≈ 848 s: egen händelse, deadline ≈ 409 s.
      [200, () => svc.observeVessel(southbound(OTHER, 2000, { sog: 6 }))],
      [250, () => svc.observeVessel(boat(FOLLOWER, 390, { sog: 2.1, ...queueEvidence() }))],
      [420, () => svc.observeVessel(boat(FOLLOWER, 380, { sog: 2.1, ...queueEvidence() }))],
      // Ut ur kön 70 s efter den andra varningen, långsam slutsträcka.
      [480, () => svc.observeVessel(boat(FOLLOWER, 240, { sog: 1.5, passedBridges: ['Järnvägsbron'] }))],
      [700, () => svc.observeVessel(boat(FOLLOWER, 200, { sog: 1.5, passedBridges: ['Järnvägsbron'] }))],
    ], 760);
    const otherEvent = warnings.find((w) => w.leadMmsi === OTHER);
    expect(warnings.map((w) => w.leadMmsi)).toEqual([LEAD, OTHER, FOLLOWER]);
    expect(coverage.filter((c) => c.mmsi === FOLLOWER && c.reason === 'absorbed').map((c) => c.eventId))
      .toEqual([warnings[0].eventId]);
    expect(coverage.some((c) => c.mmsi === FOLLOWER && c.eventId === otherEvent.eventId)).toBe(false);
  });

  test('skydd: medan spärren gäller täcker bara konvojvärden, även vid en annan båts fix (som 7699cbe)', () => {
    // Grön på 7699cbe. Utan vakten i _bindLooseArms hade K2:s uppskjutna släpp
    // låtit en ANNAN båts utvärdering (ledarens fix 370 s) absorbera följaren
    // i en händelse som varnade 365 s, medan hon hölls och innan hennes eget
    // nästa fix (400 s, 35 s efter varningen) hunnit visa något.
    const EARLY = '265000601';
    const OTHER = '265000602';
    play(0.5, [
      // Konvojvärden: LEAD varnas 95 s; EARLY absorberas och korsar 100 s, så
      // händelsens referens blir 100 s och följaren (ankomst ≈ 730 s) hör inte
      // till den på prognos — men LEAD rör sig tätt framför henne.
      [95, () => svc.observeVessel(boat(LEAD, 700, { sog: 2.5 }))],
      [96, () => svc.observeVessel(boat(EARLY, 20, { sog: 4, passedBridges: ['Järnvägsbron'] }))],
      [100, () => svc.notePassage(EARLY, 'Stridsbergsbron')],
      // En båt söderut med ankomst ≈ 750 s: egen händelse, deadline ≈ 365 s.
      [140, () => svc.observeVessel(southbound(OTHER, 2083, { sog: 6.64 }))],
      // Ledarens och följarens fix 5 s isär: positionsbelagd konvoj, så
      // följarens fix 360 s släpper inte LEAD:s händelse.
      [355, () => svc.observeVessel(boat(LEAD, 330, { sog: 2.5 }))],
      [360, () => svc.observeVessel(boat(FOLLOWER, 400, { sog: 2.1, ...queueEvidence() }))],
      [370, () => svc.observeVessel(boat(LEAD, 320, { sog: 2.5 }))],
      [400, () => svc.observeVessel(boat(FOLLOWER, 230, { sog: 2.1, passedBridges: ['Järnvägsbron'] }))],
    ], 420);
    const otherWarning = warnings.find((w) => w.leadMmsi === OTHER);
    expect(otherWarning).toBeDefined();
    expect(otherWarning.t).toBeLessThan(START + 370000);
    expect(otherWarning.t).toBeGreaterThan(START + 360000);
    expect(coverage.some((c) => c.mmsi === FOLLOWER && c.eventId === otherWarning.eventId)).toBe(false);
    expect(warnings.map((w) => w.leadMmsi)).toEqual([LEAD, OTHER, FOLLOWER]);
  });

  // Samma millisekund i ett AIS-svep (K2:s sond f09-sammams). Följaren står i
  // kö; ledarens fix i samma millisekund avfyrar varningen. Hennes nästa fix
  // 20 s senare visar att hon lämnat kön. Utfallet får bero på ordningen i
  // svepet (fixet bearbetat före eller efter varningen), aldrig på tickens fas.
  const sameMsSweep = (followerFirst) => {
    const follower = () => svc.observeVessel(queued());
    const lead = () => svc.observeVessel(boat(LEAD, 150, { passedBridges: ['Järnvägsbron'] }));
    return [
      [0.1, () => svc.observeVessel(queued())],
      [10, followerFirst ? follower : lead],
      [10, followerFirst ? lead : follower],
      [30, () => svc.observeVessel(boat(FOLLOWER, 230, { passedBridges: ['Järnvägsbron'] }))],
    ];
  };

  test.each([0.5, 5, 9, 10.5, 12, 15, 20, 25, 29])(
    'samma millisekund, följarens fix före varningen: beslutet väntar på hennes nästa fix (fas %s s)',
    (phaseS) => {
      // 7699cbe och första K2: rött vid fas 10,5–29 s. En tick mellan
      // varningen och hennes nästa fix släppte varningen ("spärren gäller och
      // fixet är från samma millisekund"), annars absorberades hon.
      play(phaseS, sameMsSweep(true), 200);
      expect(warnings.map((w) => w.leadMmsi)).toEqual([LEAD]);
      const arm = svc._arms.get(`${FOLLOWER}::Stridsbergsbron`);
      expect(arm.eventId).toBe(warnings[0].eventId);
      expect(arm.absorbedAt).not.toBeNull();
    },
  );

  test.each([0.5, 9, 15, 29])(
    'samma millisekund, följarens fix efter varningen: hon syns kvar i kön ⇒ egen varning (fas %s s)',
    (phaseS) => {
      // Grönt på 7699cbe: AKIRA-regeln när fixet bearbetas efter avfyrningen.
      play(phaseS, sameMsSweep(false), 200);
      expect(warnings.map((w) => w.leadMmsi)).toEqual([LEAD, FOLLOWER]);
      expect(coverage.some((c) => c.mmsi === FOLLOWER && c.eventId === warnings[0].eventId)).toBe(false);
    },
  );

  test.each([1, 10, 21, 29])(
    'skydd: tyst i kön efter varningen, tät konvoj på senaste fixen ⇒ täckt, ingen andra varning (ZWERK, fas %s s)',
    (phaseS) => {
      // Grönt på 7699cbe och nu. Skydd mot att låta konvojundantaget vänta på
      // hennes nästa fix: i 20260702-19h löpte ZWERKs spärr ut i tystnad före
      // nästa fix, fast hon korsade Klaffbron 32 s efter CAVA och hörde till
      // CAVAs varning. Med en sådan grind släppte tystnadsvillkoret (3)
      // varningen och gav henne en andra varning för samma öppning.
      play(phaseS, [
        [0, () => svc.observeVessel(boat(FOLLOWER, 500, { sog: 2.1, ...queueEvidence() }))],
        [20, () => svc.observeVessel(boat(LEAD, 200, { sog: 4, passedBridges: ['Järnvägsbron'] }))],
      ], 400);
      expect(warnings.map((w) => w.leadMmsi)).toEqual([LEAD]);
      const arm = svc._arms.get(`${FOLLOWER}::Stridsbergsbron`);
      expect(arm.eventId).toBe(warnings[0].eventId);
      expect(arm.movingConvoyEventId).toBe(warnings[0].eventId);
    },
  );

  test('skydd: reservvarningens ledare har varit tyst i 5 min, så hans position är inget konvojbevis', () => {
    // Grönt på 7699cbe och nu. Reservvarningen går när ledarens spärr löper
    // ut, alltså exakt STALE_ETA_SOFT_MS efter hans senaste fix. Konvojprovet
    // sker vid nästa utvärdering, då positionen redan är för gammal. En
    // variant som prövade konvojen i varningsögonblicket godtog den (`<=`)
    // och absorberade ELFKUNGEN i PAX reservvarning i 20260702-2h.
    play(0.5, [
      [0, () => svc.observeVessel(boat(LEAD, 1000, { sog: 4, ...queueEvidence() }))],
      [30, () => svc.observeVessel(boat(FOLLOWER, 1250, { sog: 2.1, ...queueEvidence() }))],
    ], 400);
    expect(warnings.map((w) => w.leadMmsi)).toEqual([LEAD, FOLLOWER]);
    expect(warnings[0]).toMatchObject({ firedBy: 'deadline', t: START + 300000 });
    expect(coverage.some((c) => c.mmsi === FOLLOWER && c.eventId === warnings[0].eventId)).toBe(false);
  });
});

describe('F09 på riktig korpus: 20260710-13h ger samma öppningar MED TID i alla faser', () => {
  const replayDir = path.join(__dirname, 'replay-validation');
  const source = path.join(replayDir, 'corpora-data/ais-replay-20260710-015254.jsonl');
  let directory;
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'k2-fas-13h-'));
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  // Hela korpusen flyttas δ s (aisTimestamp, fixTs, receivedAt; typbevarande),
  // som buggjägarens M-FAS-relation. Varningarna jämförs MED TID: t − δ i hela
  // sekunder, bro, riktning, ledare och medlemmar. Före rättningen gav 15 av
  // δ ∈ {−15 … +29} en extra Klaffbron-varning för VIRGO (265552100); första
  // K2 gav PILOT 761 (265606970) varningen 11:54:15 i stället för 12:09:08
  // vid δ −9, −8, −7, +21, +22 och +23 s (granskningen 2026-11-04). Ett helt
  // halvminutsvarv i steg om 1 s täcker alla tickfaser.
  const replay = (deltaS) => new Promise((resolve, reject) => {
    const deltaMs = Math.round(deltaS * 1000);
    const rows = fs.readFileSync(source, 'utf8').split('\n').filter(Boolean).map((line) => {
      const row = JSON.parse(line);
      for (const field of ['aisTimestamp', 'fixTs', 'receivedAt']) {
        if (typeof row[field] === 'number') row[field] += deltaMs;
        else if (typeof row[field] === 'string' && row[field]) {
          row[field] = new Date(Date.parse(row[field]) + deltaMs).toISOString();
        }
      }
      return JSON.stringify(row);
    });
    const file = path.join(directory, `13h-${deltaS}.jsonl`);
    fs.writeFileSync(file, `${rows.join('\n')}\n`);
    execFile(process.execPath, [path.join(replayDir, 'replayRunner.js'), file], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, REPLAY_MONITORING: '0' },
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const result = JSON.parse(stdout.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
      resolve({
        deltaS,
        processErrors: result.processErrors,
        keys: result.openingWarnings.map((w) => `${w.bridge}|${w.direction}|${w.leadMmsi}|`
          + `${(w.mmsis || []).join(',')}|${new Date(Math.round((w.t - deltaMs) / 1000) * 1000).toISOString()}`).sort(),
      });
    });
  });

  test('δ ∈ {−15 … +14} s och −11,52 s ger samma öppningsvarningar och tider som basen', async () => {
    const deltas = [];
    for (let d = -15; d <= 14; d += 1) deltas.push(d);
    deltas.push(-11.52);
    const results = [];
    for (let i = 0; i < deltas.length; i += 4) {
      // Fyra åt gången: ett varv tar några sekunder per replay.
      results.push(...await Promise.all(deltas.slice(i, i + 4).map(replay)));
    }
    const base = results.find((r) => r.deltaS === 0);
    expect(base.keys.filter((k) => k.startsWith('Klaffbron|northbound|265552100'))).toHaveLength(0);
    for (const r of results) {
      expect(r.processErrors).toBe(0);
      expect({ deltaS: r.deltaS, keys: r.keys }).toEqual({ deltaS: r.deltaS, keys: base.keys });
    }
  }, 240000);
});
