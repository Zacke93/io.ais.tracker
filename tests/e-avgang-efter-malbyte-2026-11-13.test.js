'use strict';

/**
 * Familj E (fältprovet 10–13 nov 2026): AVGÅNGSGOLVET EFTER EN MÅLBROÖVERGÅNG.
 *
 * Situationen (körning 1, 12 nov, PRICKBJORN 265012090): passerar
 * Stridsbergsbron söderut 12:35:22. Målbytet till Klaffbron 12:36:04 tömmer
 * ETA-historik och fartbuffert och armerar stationär-holden. Hon ligger stilla
 * 160–175 m norr om Järnvägsbron (sog 0,0–0,4) till 12:53:33 och lägger ut i
 * 1,1 → 1,0 → 3,7 → 6,9 kn. Texterna blev "om 32, 33, 25 minuter" mot
 * sanningen 6,7, 6,1 och 5,0 min (korsning 13:00:16).
 *
 * Mekanismen: holden svarar null i _getEffectiveSpeed INNAN fartbufferten
 * matas, och fartbufferten är det enda ställe där avgångskontexten
 * (familj E, F04) ser stillheten. Vid första rörliga samplet var bufferten tom:
 * ingen avgång kändes igen, och rå-ETA:n räknades på 1,1 kn.
 *
 * Rättningen: holdens sampel bokförs som stillhetsbevis (_holdStillness) med
 * buffertens definition, och avgångsigenkänningen i samplet som släpper holden
 * prövar det beviset med samma krav (minst två sampel, alla under 0,5 kn,
 * avgången högst 200 m från stillheten och närmare målbron). Beviset samlas
 * BARA i en hold som ett målbyte armerade (där är bufferten tom), och det rör
 * aldrig fartbufferten: en släppt hold utan igenkänd avgång ger samma
 * beräkning som förut.
 *
 * TESTENS FORM (granskningen 2026-11-13, A4): varje gränstest är PARAT. En
 * positiv kontroll (en annan båt som väntar och lägger ut på samma sätt men
 * uppfyller kraven) ska få avgångsgolvet, och den prövade båten ska inte få
 * det. Den positiva kontrollen fäller koden före rättningen på BETEENDE
 * (1,1 kn i stället för 2,2), och vakten fäller en mutation som tar bort
 * kravet. Testen läser inget internt tillstånd som bara finns efter
 * rättningen. Mutationsproven står i S/familj-E/RESULTAT.md, "Revision 1".
 */

const BridgeRegistry = require('../lib/models/BridgeRegistry');
const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const { BRIDGES } = require('../lib/constants');

const KLAFF = BRIDGES.klaffbron;
const M_PER_DEG_LAT = 111320;
const KN_M_PER_MIN = 1852 / 60;
const MMSI = '265012090';
// Den positiva kontrollen i de parade testen.
const CONTROL = '265012091';

const logger = {
  log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

// Rakt norr om Klaffbron: färre meter = närmare målbron.
function vesselAt(metres, sog, mmsi = MMSI) {
  return {
    mmsi,
    targetBridge: 'Klaffbron',
    status: 'waiting',
    lat: KLAFF.lat + metres / M_PER_DEG_LAT,
    lon: KLAFF.lon,
    sog,
    cog: 211,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
  };
}

describe('avgångsgolvet efter en målbroövergång (stationär-holdens stillhetsbevis)', () => {
  let calc;

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-12T12:36:04Z') });
    calc = new ProgressiveETACalculator(logger, new BridgeRegistry());
  });

  afterEach(() => {
    calc.destroy();
    jest.useRealTimers();
  });

  // Ett sampel, två pass som i appen (K6: meddelandevägen + snapshot-vägen).
  function sample(metres, sog, { dtS = 65, mmsi = MMSI } = {}) {
    jest.advanceTimersByTime(dtS * 1000);
    const v = vesselAt(metres, sog, mmsi);
    return { first: calc._getEffectiveSpeed(v), second: calc._getEffectiveSpeed(v) };
  }

  function eta(metres, sog, { dtS = 65 } = {}) {
    jest.advanceTimersByTime(dtS * 1000);
    const v = vesselAt(metres, sog);
    return { pass1: calc.calculateProgressiveETA(v, null), pass2: calc.calculateProgressiveETA(v, null) };
  }

  function transition(mmsi = MMSI) {
    calc.clearVesselETAHistory(mmsi, 'target_transition_Stridsbergsbron_to_Klaffbron');
    calc.clearVesselETAHistory(mmsi, 'target_bridge_change_Stridsbergsbron_to_Klaffbron');
  }

  // PRICKBJORNs väntan: ETA okänd under holden, fart 0,0–0,4.
  function waitInHold(metres, mmsi = MMSI) {
    expect(sample(metres, 0.4, { mmsi }).first).toBeNull();
    expect(sample(metres - 1, 0.1, { mmsi }).first).toBeNull();
    expect(sample(metres - 2, 0.0, { mmsi }).first).toBeNull();
    expect(sample(metres - 3, 0.1, { mmsi }).first).toBeNull();
  }

  // Positiv kontroll: samma väntan och en avgång 33 m närmare ⇒ golvet 2,2 kn.
  function expectControlDeparts() {
    transition(CONTROL);
    waitInHold(1135, CONTROL);
    expect(sample(1099, 1.1, { mmsi: CONTROL }).first).toBeCloseTo(2.2, 5);
  }

  test('fältfallet: första rörliga sampel efter väntan i holden räknas på avgångsgolvet, inte på 1,1 kn', () => {
    transition();
    waitInHold(1135);
    const { first, second } = sample(1099, 1.1, { dtS: 8 * 60 });
    expect(first).toBeCloseTo(2.2, 5); // dubbla igångsättningsfarten (F04)
    expect(second).toBeCloseTo(2.2, 5); // dubbelkörningen ger samma svar
    expect(calc.hasStationaryHold(MMSI)).toBe(false);
    expect(calc._departures.get(MMSI).floorKn).toBeCloseTo(2.2, 5);
    // Holdens sampel har aldrig medlats in: bufferten bär bara avgångssamplet.
    expect(calc._speedBuffers.get(MMSI)).toEqual([1.1]);
  });

  test('fältfallet, hel beräkning: första texten är restiden på 2,2 kn (16 min), inte på 1,1 kn (32 min)', () => {
    transition();
    waitInHold(1135);
    const { pass1, pass2 } = eta(1099, 1.1, { dtS: 8 * 60 });
    const onFloor = 1099 / (2.2 * KN_M_PER_MIN); // 16,2 min
    expect(pass1).toBeCloseTo(onFloor, 1);
    expect(pass2).toBeCloseTo(onFloor, 1);
    expect(pass1).toBeLessThan(1099 / (1.1 * KN_M_PER_MIN) - 10); // inte 32 min
  });

  test('ett ensamt stillasampel i holden är ingen belagd stillhet', () => {
    expectControlDeparts();
    transition();
    expect(sample(1135, 0.1).first).toBeNull();
    expect(sample(1110, 1.1).first).toBeCloseTo(1.1, 5);
    expect(calc._departures.has(MMSI)).toBe(false);
    expect(calc._speedBuffers.get(MMSI)).toEqual([1.1]);
  });

  test('krypfart sist i fönstret: senaste samplet är ingen stillhet', () => {
    expectControlDeparts();
    transition();
    expect(sample(1140, 0.1).first).toBeNull();
    expect(sample(1135, 0.6).first).toBeNull();
    expect(sample(1130, 0.7).first).toBeNull();
    expect(sample(1110, 1.4).first).toBeCloseTo(1.4, 5);
    expect(calc._departures.has(MMSI)).toBe(false);
  });

  // Granskningen 2026-11-13 (A4): testet ovan fälls inte om fartkravet
  // "alla under 0,5 kn" tas bort, eftersom det sista krypsamplet redan nollar
  // stillhetens position. Här ligger krypet FÖRST i fönstret och positionen
  // är ett äkta stillasampel; bara fartkravet hindrar avgången. Som i
  // bufferten krävs tre stillasampel efter kryp.
  test('krypsampel FÖRST i fönstret [0,7, 0,1, 0,2]: ingen belagd stillhet', () => {
    expectControlDeparts();
    transition();
    expect(sample(1150, 0.7).first).toBeNull();
    expect(sample(1140, 0.1).first).toBeNull();
    expect(sample(1139, 0.2).first).toBeNull();
    expect(sample(1120, 1.4).first).toBeCloseTo(1.4, 5);
    expect(calc._departures.has(MMSI)).toBe(false);
  });

  test('avgången måste synas på plats: 250 m från sista stillasamplet räknas på uppmätt fart, som förut', () => {
    expectControlDeparts();
    transition();
    waitInHold(1400);
    const { first } = sample(1147, 3.8, { dtS: 11 * 60 });
    expect(first).toBeCloseTo(3.8, 5);
    expect(calc._departures.has(MMSI)).toBe(false);
    expect(calc._speedBuffers.get(MMSI)).toEqual([3.8]);
  });

  test('en båt som lägger ut bort från målbron får ingen avgångskontext', () => {
    expectControlDeparts();
    transition();
    waitInHold(1135);
    expect(sample(1160, 1.6).first).toBeCloseTo(1.6, 5);
    expect(calc._departures.has(MMSI)).toBe(false);
  });

  test('beviset bärs inte över ett nytt målbyte', () => {
    expectControlDeparts();
    transition();
    waitInHold(1135);
    transition(); // nytt målbyte: beviset börjar om från noll
    expect(sample(1131, 0.1).first).toBeNull(); // ett stillasampel efter bytet
    expect(sample(1110, 1.1).first).toBeCloseTo(1.1, 5);
    expect(calc._departures.has(MMSI)).toBe(false);
  });

  test('samma sampel räknas en gång även när holden frågas flera gånger (K6, ruttens två fartanrop)', () => {
    expectControlDeparts();
    transition();
    jest.advanceTimersByTime(65000);
    const v = vesselAt(1135, 0.1);
    expect(calc._getEffectiveSpeed(v)).toBeNull();
    expect(calc._getEffectiveSpeed(v)).toBeNull();
    expect(calc._getEffectiveSpeed(v)).toBeNull();
    // Ett ensamt sampel räcker alltså inte, hur många gånger det än räknas.
    expect(sample(1110, 1.1).first).toBeCloseTo(1.1, 5);
    expect(calc._departures.has(MMSI)).toBe(false);
  });

  test('en hold som ETA_STALE_HARD armerade samlar inget bevis och lämnar bufferten som förut', () => {
    expectControlDeparts();
    // Båten rörde sig in mot stoppet, bufferten bär [0,9, 0,5, 0,1].
    sample(1300, 0.9);
    sample(1250, 0.5);
    sample(1235, 0.1);
    calc.armStationaryHold(MMSI, 'eta_stale_hard');
    expect(sample(1234, 0.3).first).toBeNull();
    expect(sample(1233, 0.4).first).toBeNull();
    // Släppet: snittet av bufferten som förut, ingen avgång (LA FEMME-klassen).
    const { first } = sample(1120, 4.5);
    expect(first).toBeCloseTo((0.5 + 0.1 + 4.5) / 3, 5);
    expect(calc._departures.has(MMSI)).toBe(false);
  });

  test('en annan rensning (båten borttagen) tar bort beviset', () => {
    expectControlDeparts();
    transition();
    waitInHold(1135);
    calc.clearVesselETAHistory(MMSI, 'vessel_removed');
    expect(sample(1099, 1.1).first).toBeCloseTo(1.1, 5);
    expect(calc._departures.has(MMSI)).toBe(false);
  });

  // Granskningen 2026-11-13 (A4): förbrukningen prövad på beteende. Släpps
  // holden utan igenkänd avgång får ett senare sampel inte läsa beviset.
  test('förbrukningen: släpps holden utan igenkänd avgång läser nästa sampel inte det gamla beviset', () => {
    expectControlDeparts();
    transition();
    expect(sample(1140, 0.1).first).toBeNull();
    expect(sample(1139, 0.1).first).toBeNull();
    // Släppsamplet ligger LÄNGRE från bron än stillheten: ingen avgång.
    expect(sample(1145, 1.1).first).toBeCloseTo(1.1, 5);
    expect(calc._departures.has(MMSI)).toBe(false);
    // Nästa sampel 40 m närmare än stillheten: bufferten bär [1,1], inget bevis kvar.
    sample(1100, 1.3);
    expect(calc._departures.has(MMSI)).toBe(false);
  });
});
