'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const StatusService = require('../lib/services/StatusService');

/**
 * =============================================================================
 * J32 (helkodsgranskning runda 2/2b, dirigentbeslut 2026-08-22)
 * =============================================================================
 * VAD MICRO-GRACE ÄR: en 200 ms PAUS före publicering, inte kvarhållning av
 * text. _actuallyUpdateUI läser _shouldApplyMicroGrace; blir den sann sover
 * appen 200 ms, tar en FÄRSK snapshot och publicerar den i stället (se
 * [MICRO_GRACE]-loggraden). Blir den falsk publiceras uppdateringen OPAUSAT.
 *
 * VAD FÖNSTRET GÖR: `timeLimit = hasCriticalTransitions ? 3000 : 5000` avgör
 * hur nära förra brotextskrivningen en uppdatering måste ligga för att pausen
 * ska vara berättigad. Kritiska övergångar (åker strax under / under bron) har
 * alltså ett KORTARE fönster än vanliga — vilket betyder att de från 3 s och
 * framåt publiceras UTAN paus, snabbare än vanliga uppdateringar. Det är
 * avsiktligt: en båt som just gått under bron ska synas nu.
 *
 * VARFÖR TESTET SKREVS OM: fixrunda 2 läste den gamla engelska kommentaren
 * ("Allow longer micro-grace for critical transitions") som ett löfte om ett
 * LÄNGRE fönster, ändrade koden till symmetriska 5 000 ms och låste det med
 * en tidigare version av den här filen. Diagnosen i runda 2b: KOMMENTAREN var
 * felet, inte koden. Omskrivningen gav kritiska övergångar 200 ms EXTRA paus i
 * bandet 3–5 s — att stabilisera en kritisk övergång genom att FÖRDRÖJA den —
 * och i replay-harnessen (60 ms klocksteg per sampel) rastrerades pausen till
 * +30 s, vilket drev in harnessartefakter i fyra goldens och en knivseggsrad i
 * 20260712-25h. Koden är därför återställd till HEAD utan en enda kodrads
 * ändring, och den här filen låser HEAD-SEMANTIKEN i stället.
 *
 * MUTATIONSPROV: byt raden till `const timeLimit = 5000;` ⇒ fallen "kritisk
 * vid 4,2 s" och "kritisk vid 3 001 ms" faller. Byt till `const timeLimit =
 * 3000;` ⇒ fallen "vanlig vid 4,2 s" och "vanlig vid 4 999 ms" faller.
 * Asymmetrin är alltså låst från BÅDA håll.
 */

/**
 * Riggen kör de RIKTIGA predikaten: StatusService.hasActiveCriticalTransition
 * läser fältet _criticalTransitionHoldUntil på det LEVANDE fartygsobjektet
 * (app-5#1: relevantVessels är BridgeText-projektionen och saknar fältet — så
 * uppslaget via vesselDataService.getVessel måste finnas för att micro-grace
 * ska kunna se en kritisk övergång alls).
 */
function makeApp({ criticalHoldMs = null } = {}) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();

  const live = { mmsi: '265001111' };
  if (criticalHoldMs !== null) live._criticalTransitionHoldUntil = Date.now() + criticalHoldMs;

  app.vesselDataService = {
    getVessel: (mmsi) => (mmsi === live.mmsi ? live : null),
    getAllVessels: () => [live], // inga GPS-hopp: lastCoordinationLevel saknas
  };
  app.statusService = {
    hasActiveCriticalTransition: StatusService.prototype.hasActiveCriticalTransition.bind({ logger: app }),
    getHighestPriorityTransition: () => null,
  };
  return app;
}

/** BridgeText-projektionen som micro-grace faktiskt får se. */
const snapshotMed = (antal) => ({
  vesselCount: antal,
  relevantVessels: antal > 0 ? [{ mmsi: '265001111' }] : [],
});

/**
 * KRITISKT LÄGE: kritisk övergång aktiv, antalet OFÖRÄNDRAT och inga GPS-hopp.
 * Enda term som kan göra returuttrycket sant är hasCriticalTransitions, så
 * utfallet mäter exakt det kritiska fönstret och inget annat.
 */
function kritiskVid(alderMs) {
  const app = makeApp({ criticalHoldMs: 10000 });
  app._lastBridgeTextUpdate = Date.now() - alderMs;
  app._lastVesselCount = 1;
  return app;
}

/**
 * VANLIGT LÄGE: ingen kritisk övergång, men tom → en båt (transitionFromEmpty).
 * Mäter det vanliga 5 000 ms-fönstret.
 */
function vanligVid(alderMs) {
  const app = makeApp();
  app._lastBridgeTextUpdate = Date.now() - alderMs;
  app._lastVesselCount = 0;
  return app;
}

describe('J32: micro-grace-fönstret är AVSIKTLIGT kortare för kritiska övergångar', () => {
  test('KRITISK VID 4,2 s ⇒ INGEN paus (publiceras direkt)', () => {
    // Kärnan i dirigentbeslutet: en under-bro-övergång 4,2 s efter förra
    // skrivningen ligger UTANFÖR det kritiska 3 s-fönstret och ska därför
    // publiceras opausad. Med det symmetriska 5 000 ms som runda 2 införde
    // fick samma tick i stället 200 ms extra fördröjning.
    expect(kritiskVid(4200)._shouldApplyMicroGrace(snapshotMed(1))).toBe(false);
  });

  test('VANLIG tom→icke-tom VID 4,2 s ⇒ PAUS (5 000 ms-fönstret gäller)', () => {
    // Samma ålder, ingen kritisk övergång: här ÄR pausen berättigad. Det är
    // asymmetrin — och den pekar åt andra hållet än runda 2 trodde.
    expect(vanligVid(4200)._shouldApplyMicroGrace(snapshotMed(1))).toBe(true);
  });

  test('KRITISK VID 2,5 s ⇒ PAUS (inne i 3 s-fönstret)', () => {
    // Under 3 s pausas kritiska övergångar fortfarande: flimmerskyddet finns
    // kvar precis intill förra skrivningen. Här är hasCriticalTransitions den
    // ENDA sanna termen — antalet är oförändrat och inga GPS-hopp finns — så
    // debugraden bevisar att predikatet verkligen såg övergången.
    const app = kritiskVid(2500);
    expect(app._shouldApplyMicroGrace(snapshotMed(1))).toBe(true);
    expect(app.debug.mock.calls.some((c) => String(c[0]).includes('CRITICAL_TRANSITION_DETECTED'))).toBe(true);
  });

  test('KRITISKA GRÄNSEN 3 000 ms: 2 999 pausar, 3 001 pausar inte', () => {
    expect(kritiskVid(2999)._shouldApplyMicroGrace(snapshotMed(1))).toBe(true);
    expect(kritiskVid(3001)._shouldApplyMicroGrace(snapshotMed(1))).toBe(false);
  });

  test('VANLIGA GRÄNSEN 5 000 ms: 4 999 pausar, 5 001 pausar inte', () => {
    expect(vanligVid(4999)._shouldApplyMicroGrace(snapshotMed(1))).toBe(true);
    expect(vanligVid(5001)._shouldApplyMicroGrace(snapshotMed(1))).toBe(false);
  });

  test('BANDET 3–5 s: kritisk publiceras opausad, vanlig pausas — hela vägen', () => {
    // Egenskapen i stället för en punkt: i HELA mellanbandet ska kritisk vara
    // false och vanlig true. Vilken symmetrisk gräns som helst (3000 eller
    // 5000 för båda) kollapsar den här skillnaden och fäller testet.
    for (const alder of [3100, 3500, 4000, 4500, 4900]) {
      expect(kritiskVid(alder)._shouldApplyMicroGrace(snapshotMed(1))).toBe(false);
      expect(vanligVid(alder)._shouldApplyMicroGrace(snapshotMed(1))).toBe(true);
    }
  });

  test('BORTOM BÅDA FÖNSTREN: 5,5 s ger ingen paus, kritisk eller ej', () => {
    expect(kritiskVid(5500)._shouldApplyMicroGrace(snapshotMed(1))).toBe(false);
    expect(vanligVid(5500)._shouldApplyMicroGrace(snapshotMed(1))).toBe(false);
  });

  test('1 000 ms-regeln för ren antalsändring är orörd', () => {
    // 2 → 1 båtar, varken tom→ eller →tom, ingen kritisk övergång: villkoret
    // (vesselCountChanged && timeSinceLastUpdate < 1000) är enda vägen till
    // paus, så 0,5 s pausar och 4,2 s gör det inte.
    const snabb = makeApp();
    snabb._lastBridgeTextUpdate = Date.now() - 500;
    snabb._lastVesselCount = 2;
    expect(snabb._shouldApplyMicroGrace(snapshotMed(1))).toBe(true);

    const sen = makeApp();
    sen._lastBridgeTextUpdate = Date.now() - 4200;
    sen._lastVesselCount = 2;
    expect(sen._shouldApplyMicroGrace(snapshotMed(1))).toBe(false);
  });
});
