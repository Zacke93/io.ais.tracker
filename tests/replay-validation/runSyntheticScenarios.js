'use strict';

/**
 * Syntetisk scenariosvit (2026-06-11) — den PROAKTIVA testpelaren.
 *
 * Kör kurerade syntetiska scenarier (situationer som ALDRIG förekommit i
 * någon korpus) genom den riktiga appen via replay-harnessen och dömer med
 * de facit-oberoende invarianterna + scenariospecifika förväntningar.
 *
 * Användning:  node tests/replay-validation/runSyntheticScenarios.js  (från io.ais.tracker/)
 *              npm run replay:synthetic
 * Exit-kod:    0 = alla scenarier rena, 1 annars.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openingDeliveryFailures } = require('./openingDelivery');
const {
  generateScenario, buildPath, pathMetrics, pointAt, truthCrossings, BASE_TIME_MS,
} = require('./scenarioGenerator');
const { validateInvariants, validateWarnInvariants } = require('./invariants');
const { MOORING_ZONES, TRIGGER_POINTS } = require('../../lib/constants');

const RUNNER = path.join(__dirname, 'replayRunner.js');
const QUAY = {
  lat: (MOORING_ZONES[0].start.lat + MOORING_ZONES[0].end.lat) / 2,
  lon: (MOORING_ZONES[0].start.lon + MOORING_ZONES[0].end.lon) / 2,
};

// Rutt-geometri för tidsberäkningar (möten, anslutningshändelser).
const PATH = buildPath();
const METRICS = pathMetrics(PATH);
// Kedjeindex i PATH: [0]=syd-ext, [1]=Olidebron, [2]=Klaffbron,
// [3]=Järnvägsbron, [4]=Stridsbergsbron, [5]=Stallbackabron, [6]=nord-ext.
const FRAC_KLAFFBRON = METRICS.cum[2] / METRICS.total;
const FRAC_STRIDSBERG = METRICS.cum[4] / METRICS.total;
/** Sekunder tills en norrgående båt (speedKn) når given ruttandel. */
const northSecondsToFraction = (frac, speedKn) => Math.round((frac * METRICS.total) / (speedKn * 0.5144));

// ---------------------------------------------------------------------------
// omstart-mitt-i-passage (härdad 2026-08-22, fixrunda 2b-granskningen)
// ---------------------------------------------------------------------------
// Scenariot ska pröva den PERSISTENTA öppningsdedupen över en processomstart.
// Granskaren mutationsbevisade att den gamla placeringen (~200 m norr om
// Klaffbron) gjorde grinden DÖD: Klaffbron-varningen var redan nollad av
// passagen och Stridsbergsvarningen hade inte hunnit avfyras, så det fanns
// ingen post att deduplicera — hela dedupen kunde kopplas bort utan att
// scenariot blev rött. Omstarten flyttas därför till en punkt där en LEVANDE
// post finns, och sen nog för att det är J15:s BOOT-fönster (expiresAt =
// avfyrning + konvojfönstret + ETA) som spärrar — inte det smalare
// in-session-fönstret (avfyrning + CONVOY_WINDOW_MS = 10 min).
//
// MÄTT i dagens träd (alla tider räknat från resans första sampel):
//   12,0 min  Klaffbron-varning (deadline, eta 8)
//   19,0 min  Klaffbron-passage  ⇒ dedup-nyckeln nollas
//   20,0 min  Stridsbergsbron-varning (deadline, eta 7)
//             ⇒ in-session-fönstret går ut 30,0 min, expiresAt 37,0 min
//   31,0 min  OMSTARTEN — 11 min efter varningen: EFTER in-session-fönstret,
//             FÖRE expiresAt. Den nya instansen beväpnar om och avfyrar en
//             andra gång; bara boot-fönstret kan tysta den.
//   35,0 min  Stridsbergsbron-passage ⇒ nyckeln nollas
// Marginalerna (1 min efter 30, 6 min före 37, 4 min före passagen) är
// avsiktligt tilltagna — se saktafarts-zonen nedan.
// BLIR SCENARIOT RÖTT PÅ "0 tystade": kör med REPLAY_VERBOSE=1 och läs
// OPENING_DEDUP_PERSIST-raden. Har boot-fönstret krympt (kortare publicerad
// ETA ⇒ mindre expiresAt) hamnar omstarten UTANFÖR det — då är det fönstret
// som ändrats, och tiderna ovan ska mätas om, inte tas bort.
const OMSTART_STRIDSBERG_WARNING_S = 20 * 60;
const OMSTART_RESTART_S = OMSTART_STRIDSBERG_WARNING_S + 11 * 60;
// Utan inbromsning ligger Stridsbergsbron-passagen 26,5 min in i resan, dvs.
// FÖRE en omstart 11 min efter varningen — passagen skulle då ha nollat
// nyckeln och grinden vore lika död som förut. Saktafartszonen (2,0 kn från
// 300 m norr om Klaffbron till 50 m norr om Stridsbergsbron) sträcker ut
// anflygningen till 15 min utan att båten någonsin blir stillaliggande, så
// rörelsebeviset och målbrokedjan är oförändrade.
const OMSTART_SLOW_ZONE = {
  fromFraction: FRAC_KLAFFBRON + 300 / METRICS.total,
  toFraction: FRAC_STRIDSBERG + 50 / METRICS.total,
  speedKn: 2.0,
};

/**
 * Kurerad scenariomatris. Förväntningar:
 *  - minTargetPassages: minst N detekterade målbro-passager (detektering + INV-5 ⇒ notiser)
 *  - noTargetPassages: inga målbro-passager får detekteras
 *  - zeroNotifications: inga notiser alls
 *  - noVesselText: ingen "på väg mot"-text får publiceras
 *  - minNotifiedBridges: dessa broar MÅSTE ha fått notis
 *  - minPassagesPerBridge: {bro: N} — minst N bokförda passager av bron,
 *    mål- och mellanbropassager sammantaget (R1, returpassagen)
 *  - maxPassagesPerBridge: {bro: N} — högst N bokförda passager av bron, på
 *    samma sätt (varv 2, familj A: fantompassagen efter en GPS-utliggare)
 *  - forbiddenNotifiedBridges: dessa broar får INTE ha fått notis
 *  - maxNotifiedPerBridge: {bro: N} — max antal notiser per bro (dubblettvakt)
 *  - minNotifiedPerBridge: {bro: N} — minst N notiser per bro (U14: en notis
 *    per verklig passage, även returpassagen inom samma besök)
 *  - toleratedInvariants: [RegExp] — fatala invariantrader som scenariot
 *    medvetet tål. Bara för KÄNDA fel utanför scenariots fråga, med motivering
 *    vid scenariot (U14-vakterna: passagelogikens falska bokföring vid linjen)
 *
 * ÖPPNINGSVARNINGAR (etapp 6, 2026-08-03) — egen, additiv dimension:
 *  - expectedOpenings: dessa målbroar MÅSTE ha fått minst en öppningsvarning,
 *    och varningen måste ligga FÖRE broens passage (annars är den värdelös).
 *  - forbiddenOpeningBridges: dessa broar får INTE ha varnats (fantomtaket).
 *  - zeroOpeningWarnings: inga öppningsvarningar alls får ha gått ut.
 *  - maxOpeningsPerBridge: {bro: N} — "EN varning per förestående öppning".
 *  - deadlineFiredOpenings: dessa broars varning MÅSTE ha kommit ur tick-
 *    motorn (firedBy='deadline'), inte ur ett inkommande fix — beviset för
 *    att äggklockan fungerar i radiotystnad.
 *  - suppressedOpeningFires: N — hur många av servicens avfyrningar som
 *    MÅSTE ha tystats av app-sidans dedup (openingServiceFires − kort).
 *    Standard 0: varje avfyrning ska nå kortet, allt annat är en bugg i
 *    leveransvägen. Sätts bara i scenarier där tystnaden ÄR kontraktet
 *    (omstart-mitt-i-passage), och då som ett EXAKT tal — en dedup som
 *    slutar spärra ger 0 och en som spärrar för brett ger 2.
 *  - openingLeadS: {bro: N} — LEDTID MOT DEN SANNA KORSNINGEN (varv 2,
 *    familj A). Varje sann korsning av bron, för varje båt med benresa
 *    (`legs`), ska ha en varning som täcker båten minst N s före korsningen
 *    och efter båtens förra korsning av samma bro. Korsningstiden kommer ur
 *    generatorns sanna bana (truthPath), inte ur appens bokföring, som vid
 *    gles AIS kommer ett fix efter korsningen. Samma krav som buggjägarens
 *    T2-orakel (LEDTID ≥ 60 s).
 */
const SCENARIOS = [
  {
    name: 'ren-nord-normal',
    seed: 11,
    vessels: [{ mmsi: '901000001', direction: 'north', speedKn: 4.5 }],
    // Etapp 6: normalresan är öppningslagrets referensfall — BÅDA målbroarna
    // ska förvarnas, och EXAKT en gång var ("en varning per förestående
    // öppning"). Går maxgränsen sönder har hysteresen/händelsestädningen
    // börjat generera dubbelvarningar för samma anflygning.
    expect: {
      minTargetPassages: 2,
      minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron'],
      expectedOpenings: ['Klaffbron', 'Stridsbergsbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
    },
  },
  {
    name: 'ren-syd-normal',
    seed: 12,
    vessels: [{ mmsi: '901000002', direction: 'south', speedKn: 4.5 }],
    // Spegelfallet: målbrokedjan (ARM_NEXT_TARGET) måste fungera lika bra
    // söderut som norrut — nordspegeln har fällt tidigare granskningar.
    expect: {
      minTargetPassages: 2,
      minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron'],
      expectedOpenings: ['Klaffbron', 'Stridsbergsbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
    },
  },
  {
    name: 'långsam-gles-rapportering',
    seed: 13,
    vessels: [{
      mmsi: '901000003', direction: 'north', speedKn: 1.6, reportIntervalS: 180,
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    name: 'snabb-nord',
    seed: 14,
    vessels: [{
      mmsi: '901000004', direction: 'north', speedKn: 7.5, reportIntervalS: 30,
    }],
    // 7,5 kn ligger i den snabba svansen (dig3: p99 = 6,97 kn) — det är HÄR
    // FIRE_EXPECTED_ETA-grenen ska bära, eftersom deadline-grenens ~926 m
    // bara är ~3,2 min förvarning i den farten.
    expect: {
      minTargetPassages: 2,
      expectedOpenings: ['Klaffbron', 'Stridsbergsbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
    },
  },
  {
    name: 'glapp-över-målbro (SILJA-klassen)',
    seed: 15,
    vessels: [{
      mmsi: '901000005', direction: 'north', speedKn: 4.5, gap: { atFraction: 0.36, durationS: 480 },
    }],
    // Etapp 6: 8 min radiotystnad ÖVER målbron — deadline-motorns kärnfall.
    // Varningen måste ha gått ut FÖRE passagen trots att inget fix landade
    // på slutsträckan (mätt: Klaffbron varnad 06:13, passerad 06:28).
    expect: {
      minNotifiedBridges: ['Klaffbron'], // failsafen ska rädda notisen trots glapp
      expectedOpenings: ['Klaffbron', 'Stridsbergsbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
    },
  },
  {
    name: 'glapp-15min-mitt-i (sandwich-klassen)',
    seed: 16,
    vessels: [{
      mmsi: '901000006', direction: 'north', speedKn: 3.5, gap: { atFraction: 0.25, durationS: 900 },
    }],
    expect: { minTargetPassages: 1 }, // resan ska överleva glappet internt (RC8)
  },
  {
    name: 'väntare-12min-vid-Klaffbron',
    seed: 17,
    vessels: [{
      mmsi: '901000007', direction: 'north', speedKn: 4.0, stop: { atFraction: 0.34, durationS: 720 },
    }],
    // Etapp 6, PRODUKTPRINCIPENS UNDANTAG: en båt som stannar NÄRA bron
    // VÄNTAR på öppningen — stoppet får aldrig avväpna, och det får inte
    // heller generera en ANDRA varning när hon startar igen.
    expect: {
      minTargetPassages: 2, // ren stillhet får ALDRIG demotera
      expectedOpenings: ['Klaffbron', 'Stridsbergsbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
    },
  },
  {
    name: 'kajliggare-40min (kajbuggen)',
    seed: 18,
    vessels: [{
      mmsi: '901000008', direction: 'north', speedKn: 0, jitterM: 2, moorAt: { ...QUAY, durationS: 2400, navStatus: null },
    }],
    // Etapp 6, FANTOMTAKETS golv: en kajliggare som aldrig avgår får ALDRIG
    // beväpnas (rörelsebevis + V1-kajbokföringen). Noll varningar, alltid.
    expect: { zeroNotifications: true, noVesselText: true, zeroOpeningWarnings: true },
  },
  {
    name: 'kajliggare-avgår-norrut',
    seed: 19,
    vessels: [{
      mmsi: '901000009', direction: 'north', speedKn: 4.0, jitterM: 2, moorAt: { ...QUAY, durationS: 1800, navStatus: null }, runRouteAfterMooring: true,
    }],
    expect: { minTargetPassages: 1 }, // Stridsbergsbron efter avgång
  },
  {
    name: 'u-sväng-före-Klaffbron',
    seed: 20,
    vessels: [{
      mmsi: '901000010', direction: 'north', speedKn: 4.5, uTurnAtFraction: 0.30,
    }],
    expect: { noTargetPassages: true },
  },
  {
    name: 'gps-hopp-500m',
    seed: 21,
    vessels: [{
      mmsi: '901000011', direction: 'north', speedKn: 4.5, gpsJump: { atFraction: 0.5, offsetM: 500 },
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    name: 'gps-brus-20m',
    seed: 22,
    vessels: [{
      mmsi: '901000012', direction: 'north', speedKn: 4.5, jitterM: 20,
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    name: 'flertrafik-3-båtar',
    seed: 23,
    vessels: [
      {
        mmsi: '901000013', name: 'SYNT-N1', direction: 'north', speedKn: 4.5,
      },
      {
        mmsi: '901000014', name: 'SYNT-N2', direction: 'north', speedKn: 2.5, startOffsetS: 600,
      },
      {
        mmsi: '901000015', name: 'SYNT-S1', direction: 'south', speedKn: 5.0, startOffsetS: 300,
      },
    ],
    expect: { minTargetPassages: 4 },
  },
  {
    name: 'tät-konvoj-2-båtar',
    seed: 24,
    vessels: [
      { mmsi: '901000016', direction: 'north', speedKn: 4.2 },
      {
        mmsi: '901000017', direction: 'north', speedKn: 4.2, startOffsetS: 120,
      },
    ],
    // Etapp 6, KONVOJKRAVET: två båtar i tät följd delar EN öppning per bro —
    // precis nattens 06:11:51-fall (JUNO:s data täckte SALTYX). En varning per
    // BÅT vore en dubbelvarning för samma broöppning.
    expect: {
      minTargetPassages: 4,
      expectedOpenings: ['Klaffbron', 'Stridsbergsbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
    },
  },
  // === Utökning 2026-07-01 (testaudit DEL D + N1/S-F3/S-F4/S-F7-klasserna) ===
  {
    // Äkta tur-och-retur: U-sväng EFTER Klaffbron → returpassagen av samma
    // bro är en NY passage och ska ge en ANDRA notis (journey-reset-vägen,
    // N1). INV-2:s journey-reset-medvetna dubbletthantering dömer.
    // U15 (K2, omgranskningen 2026-11-05): returpassagen ska också ha en EGEN
    // öppningsvarning. På 7699cbe absorberades returen söderut i båtens egen
    // händelse för utresan (B02), och scenariot såg det inte.
    name: 'u-sväng-efter-Klaffbron',
    seed: 25,
    vessels: [{
      mmsi: '901000018', direction: 'north', speedKn: 4.5, uTurnAtFraction: 0.45,
    }],
    expect: { minTargetPassages: 2, minNotifiedBridges: ['Klaffbron'], openingBeforeEachPassage: ['Klaffbron'] },
  },
  {
    // Helgranskningen 2026-11-03: samma tur-och-retur med GLES AIS (180 s,
    // 6 kn). Vändningen syns först i två sydliga fixar, och Fix D bekräftar den
    // ~750 m från det övergivna Stridsmålet. 2-READINGS mätte då "närmar sig"
    // mot just det målet i samma tick och underkände tilldelningen, så båten
    // blev mållös och returpassagen av Klaffbron bokfördes som en mållös
    // mellanbropassage (fältfallet ANYA ELAN 380 i both-21h). Vid 60 s-kadens
    // syns felet inte, därför fångade scenariot ovan det aldrig.
    // U15 (K2, omgranskningen 2026-11-05): returpassagen av Klaffbron ska ha
    // en egen öppningsvarning (på 7699cbe absorberad i utresans händelse).
    name: 'u-sväng-gles-ais-norr-om-Klaffbron',
    seed: 91,
    vessels: [{
      mmsi: '901000091',
      direction: 'north',
      speedKn: 6,
      reportIntervalS: 180,
      uTurnAtFraction: (METRICS.cum[2] + 600) / METRICS.total,
    }],
    expect: { minTargetPassages: 2, openingBeforeEachPassage: ['Klaffbron'] },
  },
  {
    // K2 / U15 (B02-klassen, rättningskampanjen 2026-11-04): tur-och-retur
    // genom Stridsbergsbron med vändning 880 m bortom bron. Returen kommer
    // inom konvojfönstret (600 s) räknat från utresans passage, och förut
    // absorberades båten då i sin EGEN äldre händelse och passerade tillbaka
    // utan varning (VEGA, buggjägarens värld 1273). Utfallet beror på var
    // vändningen sker (motorns gräns 735–954 m för värld 1273; i den här
    // rutten felar 600–880 m på 7699cbe), därför ett placerat scenario.
    // U15: returen får en egen bridge_opening_soon före returpassagen.
    name: 'u-sväng-bortom-Stridsbergsbron (B02-returresan)',
    seed: 93,
    vessels: [{
      mmsi: '901000093',
      direction: 'north',
      speedKn: 6.2,
      uTurnAtFraction: (METRICS.cum[4] + 880) / METRICS.total,
    }],
    expect: { minTargetPassages: 4, openingBeforeEachPassage: ['Stridsbergsbron'] },
  },
  {
    // R1 (rättningskampanjen 2026-11-04, buggjägarens F10/W750): samma glesa
    // tur-och-retur, men vändningen ligger så nära Klaffbron att Fix D:s
    // debounce bekräftar den först på fixen BORTOM bron. 7 kn och 240 s ger
    // en vändfix 592 m norr om Klaffbron (utpassagen bokförs i samma tick,
    // vändningen blir väntande) och en bekräftelsefix 273 m söder om den.
    // Förut räknade N1-resetten "framför" från bekräftelsefixen, Klaffbron
    // stannade i passedBridges och returpassagen bokfördes aldrig. Placeringen
    // är vald, inte given: samplen ligger på ett fast rutnät från ruttens
    // start, s = k · Δ med Δ = fart · intervall (här 864 m), och vändningen
    // sker på första samplet med s ≥ vändandelen. Med Klaffbron vid sK ger
    // k = ⌈sK / Δ⌉ vändfixen k · Δ − sK norr om bron och bekräftelsefixen
    // sK − (k − 1) · Δ söder om den. Vändfixen måste ligga > 500 m från
    // Klaffbron (Fix D:s distansvillkor, målet är ännu Klaffbron i den
    // ticken). Ändras generatorn eller rutten ska bandet räknas om, inte
    // förväntan tas bort.
    name: 'u-sväng-gles-ais-återkorsning-i-debouncen',
    seed: 92,
    vessels: [{
      mmsi: '901000092',
      direction: 'north',
      speedKn: 7,
      reportIntervalS: 240,
      uTurnAtFraction: (METRICS.cum[2] + 500) / METRICS.total,
    }],
    expect: { minTargetPassages: 1, minPassagesPerBridge: { Klaffbron: 2 } },
  },
  {
    // R1, granskningen 2026-11-04: som ovan, men fixet som avslutar
    // returens korsningssegment är LÅNGSAMT (1,5 kn). Fix D hoppar då över
    // ticken (< 2 kn) och bekräftar först på nästa fix, vars segment inte
    // innehåller bron; RE_CROSS_EVIDENCED krävde 2 kn. Nu räcker det att
    // Fix D:s väntan sattes på segmentets startfix (vändfixen), att
    // korsningsfixet självt går i minst 1 kn, att segmentet är minst 100 m
    // och att segmentets nettofart når 2 kn (omgranskningen 2026-11-04,
    // VesselDataService._slowReCrossEvidence).
    // Placeringen: Δ = 6,5 kn · 210 s = 702 m. Första samplet norr om
    // Klaffbron ligger på k · Δ med k = ⌈sK / Δ⌉ = 5, 646 m förbi bron längs
    // rutten (> 500 m: Fix D:s distansvillkor medan målet ännu är Klaffbron,
    // så vändfixen blir väntande i samma tick som utpassagen bokförs).
    // Returens första steg landar på 4 · Δ, 56 m före Klaffbron längs den
    // nordgående ruttkoordinaten, alltså 54 m SÖDER om bron: på den
    // sydgående returen är bron redan korsad. Samplet ligger inne i den
    // långsamma zonen som bara gäller returbenet (afterUTurnOnly). Därmed
    // är korsningssegmentet 702 m på 210 s (nettofart 6,5 kn), rörelsen
    // rimlig mot förra fixets fart (ingen GPS-flagga) och positionsbevisets
    // kedja har bara ETT ben, så ingen annan väg hinner före. Räkna om om
    // generatorn eller rutten ändras.
    name: 'u-sväng-långsam-återkorsning-efter-väntan',
    seed: 93,
    vessels: [{
      mmsi: '901000093',
      direction: 'north',
      speedKn: 6.5,
      reportIntervalS: 210,
      uTurnAtFraction: (METRICS.cum[2] + 100) / METRICS.total,
      slowZone: {
        fromFraction: (METRICS.cum[2] - 250) / METRICS.total,
        toFraction: (METRICS.cum[2] + 60) / METRICS.total,
        speedKn: 1.5,
        afterUTurnOnly: true,
      },
    }],
    expect: { minTargetPassages: 1, minPassagesPerBridge: { Klaffbron: 2 } },
  },
  // === Varv 2 (familj A, 2026-11-09): MÅLBRON I SAMMA TICK SOM VÄNDNINGEN ===
  // Buggjägarens M1 (NEW_JOURNEY i app-lagret, värld 936, 1208, 1316 och 1918)
  // och M2 (vändning inne i målbrogrenen, värld 1274 och 1317). Vändningen
  // var bekräftad på två positioner (U18), men målbron, och därmed
  // öppningsarmen, kom först vid NÄSTA fix. Med gles AIS gick returvarningen
  // 10–46 s före passagen eller inte alls. Ledtiden mäts mot den SANNA
  // korsningen (openingLeadS), eftersom appens bokföring vid gles AIS kommer
  // ett fix efter korsningen. Alla tre fäller c14938f; placeringen ÄR testet
  // (räkna om om generatorn eller rutten ändras).
  {
    // M1, värld 936: resan söderut slutar vid Klaffbron (TARGET_END). Båten
    // vänder 450 m söder om bron och går tillbaka norrut med AISHub-kadens
    // (70 s i 5 kn ⇒ 180 m per fix). NEW_JOURNEY väntar på fixet 450 m söder
    // om bron och bekräftar på fixet 270 m söder om den. På c14938f kom
    // målbron och varningen vid nästa fix, 90 m före linjen (35 s före den
    // sanna korsningen); nu i bekräftelseticken (105 s).
    name: 'retur-efter-målbroslut-gles-ais-Klaffbron (M1, värld 936)',
    seed: 936,
    vessels: [{
      mmsi: '903600936',
      name: 'RETUR-936',
      startS: METRICS.cum[2] + 700,
      legs: [
        { toS: METRICS.cum[2] - 450, speedKn: 5, intervalS: 70 },
        { toS: METRICS.cum[2] + 700, speedKn: 5, intervalS: 70 },
      ],
    }],
    expect: { openingLeadS: { Klaffbron: 60 } },
  },
  {
    // M1, värld 1208: som ovan, men efter bekräftelsefixet är båten tyst i
    // 11,7 min och passerar under tiden Klaffbron, Järnvägsbron och
    // Stridsbergsbron. På c14938f fick hon ingen målbro före tystnaden och
    // ingen varning alls; nu går Klaffbronvarningen i bekräftelseticken och
    // Stridsbergsbronvarningen ur deadline-motorn i tystnaden (nästa målbro i
    // samma färdriktning, ARM_NEXT_TARGET).
    name: 'retur-efter-målbroslut-tyst-genom-tre-broar (M1, värld 1208)',
    seed: 1208,
    vessels: [{
      mmsi: '903601208',
      name: 'RETUR-1208',
      startS: METRICS.cum[2] + 700,
      legs: [
        { toS: METRICS.cum[2] - 450, speedKn: 5, intervalS: 70 },
        {
          toS: METRICS.cum[4] + 700,
          speedKn: 5,
          intervalS: 70,
          gapFromS: METRICS.cum[2] - 200,
          gapToS: METRICS.cum[4] + 300,
        },
      ],
    }],
    expect: { openingLeadS: { Klaffbron: 60, Stridsbergsbron: 60 } },
  },
  {
    // M2, värld 1317: båten går söderut genom Stridsbergsbron och
    // Järnvägsbron (målbro Klaffbron) och vänder 260 m söder om
    // Järnvägsbron, inom brons besök (U14). Första fixet efter vändningen går
    // i 1 kn, så Fix D hoppar över det (Anomali 5). Nästa fix, 220 s senare och
    // 7 m norr om Järnvägsbron i 3 kn, är återkorsningen: RE_CROSS_EVIDENCED
    // bekräftar vändningen inne i målbrogrenen, och tickens detektering
    // bokför inte bron (fixet ligger på linjen). Nästa fix kommer först 244 m
    // norr om Stridsbergsbron. På c14938f fick båten ingen målbro i
    // återkorsningsticken och ingen returvarning för Stridsbergsbron; nu går
    // varningen där. Returnotisen vid Järnvägsbron kommer då från
    // TARGET_END:s geometriska inferens, och den kräver att reseankaret ligger
    // i återkorsningssegmentets start (B2). Utan B2 försvann notisen.
    // Placeringen: glappen stryker första fixet i ben 3 och 4, så att
    // återkorsningsfixet landar 7 m norr om bron (3 kn · 160 s = 247 m från
    // 240 m söder om den) och nästa fix 494 m längre fram (6 kn · 160 s).
    name: 'återkorsning-på-linjen-gles-ais-Järnvägsbron (M2, värld 1317)',
    seed: 1317,
    vessels: [{
      mmsi: '903601317',
      name: 'RETUR-1317',
      startS: METRICS.cum[4] + 400,
      legs: [
        { toS: METRICS.cum[3] - 260, speedKn: 5, intervalS: 60 },
        { toS: METRICS.cum[3] - 240, speedKn: 1, intervalS: 60 },
        {
          toS: METRICS.cum[3] + 7,
          speedKn: 3,
          intervalS: 160,
          gapFromS: METRICS.cum[3] - 241,
          gapToS: METRICS.cum[3] - 239,
        },
        {
          toS: METRICS.cum[4] + 700,
          speedKn: 6,
          intervalS: 160,
          gapFromS: METRICS.cum[3] + 6,
          gapToS: METRICS.cum[3] + 8,
        },
      ],
    }],
    expect: {
      openingLeadS: { Stridsbergsbron: 60 },
      minNotifiedPerBridge: { Järnvägsbron: 2, Stridsbergsbron: 2 },
    },
  },
  // Granskningen av varv 2 (2026-11-09): EN GPS-UTLIGGARE STRAX EFTER EN ÄKTA
  // PASSAGE. Båten går norrut genom Klaffbron i 4,4 kn med 10 s kadens. Ett fix
  // 40 m efter linjen flyttas 100 respektive 60 m söderut i latitud
  // (generatorns gpsJump; fart och kurs orörda). RE_CROSS_EVIDENCED vänder då
  // båten söderut på utliggaren. I samma tick valde kursen (norr, ≥ 2 kn slår
  // låset) bron hon nyss passerat, eftersom utliggaren ligger söder om den i
  // latitud. Sanningen är en passage och en varning. Båda scenarierna tål
  // en DEFAULT-FLASH ("Inga båtar" 10–20 s mellan två Stridsbergsbrontexter).
  // Den kommer likadant på c14938f: vändningen på utliggaren lämnar båten
  // mållös till nästa fix, och det är det beteende båda skydden återställer.
  // Att vändningen tros på en utliggare är passagelogikens sak (RE_CROSS:s
  // GPS-grind), inte måltilldelningens.
  {
    // H1: utliggaren hamnar 74 m från Klaffbron, alltså strax bortom
    // under-bro-vakten. Utan riktningskontrollen i assignTargetAfterReversal gav
    // fixet en andra Klaffbronvarning (74 m) och "på väg mot Klaffbron" i 4,7
    // min. c14938f lät nästa fix avgöra och gav en varning.
    name: 'gps-utliggare-74m-bakom-Klaffbron-efter-passage (M2-riktningskontrollen)',
    seed: 9715,
    vessels: [{
      mmsi: '909000015',
      name: 'HOPP15',
      direction: 'north',
      speedKn: 4.4,
      reportIntervalS: 10,
      jitterM: 3,
      gpsJump: { atFraction: FRAC_KLAFFBRON + 40 / METRICS.total, offsetM: -100 },
    }],
    expect: {
      maxOpeningsPerBridge: { Klaffbron: 1 },
      maxPassagesPerBridge: { Klaffbron: 1 },
      toleratedInvariants: [/^DEFAULT-FLASH: \S+ "Inga båtar" inklämd \(\d+s\) mellan två "En … Stridsbergsbron"-texter/],
    },
  },
  {
    // Negativtest för vaktens M2-del: samma utliggare 60 m bakåt hamnar inom
    // under-bro-bandet. Utan både riktningskontrollen och under-bro-vakten gav
    // den två varningar och två passager av Klaffbron. Med något av skydden,
    // och på c14938f, blir det en av vardera.
    name: 'gps-utliggare-inom-under-bro-bandet-efter-passage (M2-vakten)',
    seed: 9713,
    vessels: [{
      mmsi: '909000013',
      name: 'HOPP13',
      direction: 'north',
      speedKn: 4.4,
      reportIntervalS: 10,
      jitterM: 3,
      gpsJump: { atFraction: FRAC_KLAFFBRON + 40 / METRICS.total, offsetM: -60 },
    }],
    expect: {
      maxOpeningsPerBridge: { Klaffbron: 1 },
      maxPassagesPerBridge: { Klaffbron: 1 },
      toleratedInvariants: [/^DEFAULT-FLASH: \S+ "Inga båtar" inklämd \(\d+s\) mellan två "En … Stridsbergsbron"-texter/],
    },
  },
  {
    // U14 (användarbeslut 2026-11-04, kort B01): tur och retur INOM besöket.
    // Vändningen 200 m bortom Klaffbron ligger innanför besökets utfärdsgräns
    // (två fixar över 350 m), så besöket stängdes aldrig och returpassagen fick
    // ingen notis: två bokförda målbropassager men en notis (INV-5). Placeringen
    // ÄR testet. Buggjägarens gräns för felet var 125–308 m; bortom 350 m tar
    // utfärdsregeln fallet (scenariot ovan vänder 517 m bortom bron).
    name: 'u-sväng-inom-besöket-vid-Klaffbron (B01)',
    seed: 92,
    vessels: [{
      mmsi: '901000092',
      name: 'SYNT-RETUR',
      direction: 'north',
      speedKn: 4.5,
      uTurnAtFraction: (METRICS.cum[2] + 200) / METRICS.total,
    }],
    expect: {
      minTargetPassages: 2,
      minNotifiedPerBridge: { Klaffbron: 2 },
      maxNotifiedPerBridge: { Klaffbron: 2 },
    },
  },
  {
    // U14-vakten: en båt som ligger och guppar PÅ brolinjen i 40 min ska
    // fortfarande ha EN Klaffbronotis. Stoppet hamnar vid linjen och GPS-bruset
    // (±30 m) lägger fixarna på båda sidor: mätt −33 till +42 m längs
    // kanalaxeln, 14 fixar entydigt på ankomstsidan och 27 på bortre sidan.
    // Varken en bokförd returpassage eller en vänd ruttriktning uppstår, så
    // besöket ska inte släppas. Scenariot ger en INV-14W-varning (lång
    // DEFAULT-sandwich medan båten står still vid bron). Den är ett känt
    // textbeteende för stillaliggare och kommer likadant på 7699cbe; U14 rör
    // ingen text.
    name: 'guppar-på-Klaffbrons-linje (U14-vakt)',
    seed: 93,
    vessels: [{
      mmsi: '901000093',
      name: 'SYNT-GUPP',
      direction: 'north',
      speedKn: 4.5,
      reportIntervalS: 10,
      jitterM: 30,
      stop: { atFraction: (METRICS.cum[2] + 10) / METRICS.total, durationS: 2400 },
      stopReportIntervalS: 30,
    }],
    expect: {
      minNotifiedBridges: ['Klaffbron'],
      maxNotifiedPerBridge: { Klaffbron: 1 },
    },
  },
  // U14-revisionen (granskningen 2026-11-04): VÄND OCH VÄNTA VID LINJEN.
  // Båten passerar Klaffbron norrut och får sin notis, vänder 150 m bortom
  // bron, går tillbaka till D m norr om linjen, ligger där i 30 min med
  // slumpad kurs och GPS-brus ±J m och kör sedan vidare norrut. Sanningen är
  // EN passage. Passagelogiken bokför ibland en falsk passage när bruset för
  // positionen till linjen (distance_fallback). Den förra U14-prototypen
  // gjorde den bokföringen till en andra eller tredje notis; regeln kräver nu
  // att båten är tydligt ute på ankomstsidan och under gång dit. Den falska
  // bokföringen ger INV-5 ("2 registrerade passager men 1 notis") exakt som
  // på 7699cbe. Felet ligger i passagelogiken och tolereras här så att
  // vakten bara prövar notisen. Granskarens svep 2026-11-04 (seed = 100 +
  // D + J) med samma frön.
  ...[
    [10, 10, 120], [5, 20, 125], [5, 30, 135], [20, 30, 150], [30, 20, 150],
  ].map(([D, J, seed]) => ({
    name: `vänder-och-väntar-${D}m-från-Klaffbron-brus-${J}m (U14-vakt)`,
    seed,
    vessels: [{
      mmsi: `9010${String(D).padStart(2, '0')}${String(J).padStart(2, '0')}1`,
      name: `SVEP-D${D}-J${J}`,
      jitterM: J,
      startS: METRICS.cum[2] - 700,
      legs: [
        { toS: METRICS.cum[2] + 150, speedKn: 4.5, intervalS: 10 },
        { toS: METRICS.cum[2] + D, speedKn: 3, intervalS: 10 },
        { stopS: 1800, stopIntervalS: 30, stopCogRandom: true },
        { toS: METRICS.cum[2] + 800, speedKn: 4.5, intervalS: 10 },
      ],
    }],
    expect: {
      minNotifiedBridges: ['Klaffbron'],
      maxNotifiedPerBridge: { Klaffbron: 1 },
      toleratedInvariants: [/^MISSAD MÅLBRO-NOTIS: \d{9}:Klaffbron — /],
    },
  })),
  {
    // Samma vakt med gles AIS (60 s, AISHub-kadens) och ±30 m brus. Vid gles
    // kadens avgörs en bokföring vid linjen redan i bokföringsticken
    // (releaseReturnPassage, villkor 6b), så vakten prövar att fart- och
    // kurskravet fortfarande skiljer en väntande båt från en som passerar.
    name: 'vänder-och-väntar-5m-från-Klaffbron-gles-AIS (U14-vakt)',
    seed: 165,
    vessels: [{
      mmsi: '902605301',
      name: 'GLES-D5-J30',
      jitterM: 30,
      startS: METRICS.cum[2] - 700,
      legs: [
        { toS: METRICS.cum[2] + 150, speedKn: 4.5, intervalS: 60 },
        { toS: METRICS.cum[2] + 5, speedKn: 3, intervalS: 60 },
        { stopS: 1800, stopIntervalS: 60, stopCogRandom: true },
        { toS: METRICS.cum[2] + 800, speedKn: 4.5, intervalS: 60 },
      ],
    }],
    expect: {
      minNotifiedBridges: ['Klaffbron'],
      maxNotifiedPerBridge: { Klaffbron: 1 },
      toleratedInvariants: [/^MISSAD MÅLBRO-NOTIS: \d{9}:Klaffbron — /],
    },
  },
  // U14-revisionen 3 (omgranskningen 2026-11-05): VÄND, BROMSA IN OCH VÄNTA
  // VID LINJEN MED GLES AIS. Kadensen är 35 + 0–10 s eller 45 + 0–15 s
  // (Class B med jitter, AISHub). Båten passerar Klaffbron norrut, vänder
  // 150 m bortom, går tillbaka i 3 kn till 30 m, bromsar till 1 kn fram till
  // D m norr om linjen och ligger still i 15 min. Förra revisionen godtog en
  // gles fix som fortfarande låg på bortre sidan inom 10 m från linjen, och
  // passagelogiken bokför just en sådan fix. 'ge-upp': båten fortsätter sedan
  // norrut; sanningen är EN passage, förra revisionen gav en falsk andra
  // notis (FALSKT RETURSLÄPP). 'retur': båten går sedan söderut genom bron;
  // sanningen är TVÅ passager, förra revisionen gav returnotisen 16–17 min för
  // tidigt (FÖR TIDIGT RETURSLÄPP) och 7699cbe ingen alls. Passagelogikens
  // bokföring vid ankomsten till linjen ger INV-5 i 'ge-upp', som på 7699cbe.
  // I 'retur' ger 7699cbe INV-5 (MISSAD: returen får ingen notis); med U14
  // kommer notisen vid den verkliga korsningen, och INV-7 (SEN) för passage
  // nr 2 uppstår eftersom INV-7 mäter mot bokföringen, som gjordes före
  // korsningen. Felet ligger i passagelogiken, så vakterna tål just de
  // raderna och prövar notisen.
  ...[
    ['ge-upp', 35, 10, 6, 2], ['ge-upp', 45, 15, 3, 1],
    ['retur', 35, 10, 6, 2], ['retur', 45, 15, 3, 1],
  ].map(([kind, iv, ij, D, seed]) => ({
    name: `vänder-bromsar-väntar-${D}m-gles-${iv}+${ij}s-${kind} (U14-vakt)`,
    seed: 1000 + seed * 97 + D * 7 + iv,
    vessels: [{
      mmsi: `9031${String(iv).padStart(2, '0')}${String(D).padStart(2, '0')}${seed}`,
      name: `VAKT-${kind}`,
      jitterM: 5,
      startS: METRICS.cum[2] - 700,
      legs: [
        {
          toS: METRICS.cum[2] + 150, speedKn: 4.5, intervalS: iv, intervalJitterS: ij,
        },
        {
          toS: METRICS.cum[2] + 30, speedKn: 3, intervalS: iv, intervalJitterS: ij,
        },
        {
          toS: METRICS.cum[2] + D, speedKn: 1, intervalS: iv, intervalJitterS: ij,
        },
        { stopS: 900, stopIntervalS: iv },
        kind === 'retur'
          ? {
            toS: METRICS.cum[2] - 900, speedKn: 3.5, intervalS: iv, intervalJitterS: ij,
          }
          : {
            toS: METRICS.cum[2] + 900, speedKn: 4.5, intervalS: iv, intervalJitterS: ij,
          },
      ],
    }],
    expect: kind === 'retur'
      ? {
        minNotifiedPerBridge: { Klaffbron: 2 },
        maxNotifiedPerBridge: { Klaffbron: 2 },
        toleratedInvariants: [/^SEN MÅLBRO-NOTIS: \S+ \d{9}:Klaffbron — passage nr 2 /],
      }
      : {
        minNotifiedBridges: ['Klaffbron'],
        maxNotifiedPerBridge: { Klaffbron: 1 },
        toleratedInvariants: [/^MISSAD MÅLBRO-NOTIS: \d{9}:Klaffbron — /],
      },
  })),
  // U14-revisionen 4 (omgranskning 2, 2026-11-07): VÄNTAN MED RAPPORTERAD
  // FART. Som vakterna ovan, men den väntande båtens AIS rapporterar 0,6–1 kn
  // och slumpad kurs (stopSog) och bruset är ±15 m. Det räckte för att
  // revision 3 släppte på EN gles fix entydigt på ankomstsidan
  // (gles-korsning) och gav en falsk "har precis passerat" (FALSKT
  // RETURSLÄPP). Revision 4 kräver att båten rör sig i nuet (2,0 kn) för det
  // beviset. Fröna kommer ur svepet K/N/tmp/r4/scripts/guardFind4.js (G1,
  // 144 banor: revision 3 gav 2 falska släpp, revision 4 inget). 'retur'
  // prövar att en verklig retur efter samma väntan fortfarande får sin notis;
  // INV-7 (SEN) för passage nr 2 kommer av passagelogikens bokföring under
  // väntan och tolereras som ovan.
  ...[
    ['ge-upp', 35, 10, 1.0, 2807, '904000022'],
    ['ge-upp', 60, 0, 0.6, 2618, '904000062'],
    ['retur', 60, 0, 0.6, 2619, '904000158'],
  ].map(([kind, iv, ij, stopSog, seed, mmsi]) => ({
    name: `vänder-bromsar-väntar-6m-gles-${iv}+${ij}s-i-${stopSog}kn-brus-15m-${kind} (U14-vakt)`,
    seed,
    vessels: [{
      mmsi,
      name: `VAKT4-${kind}`,
      jitterM: 15,
      startS: METRICS.cum[2] - 700,
      legs: [
        {
          toS: METRICS.cum[2] + 150, speedKn: 4.5, intervalS: iv, intervalJitterS: ij,
        },
        {
          toS: METRICS.cum[2] + 30, speedKn: 3, intervalS: iv, intervalJitterS: ij,
        },
        {
          toS: METRICS.cum[2] + 6, speedKn: 1, intervalS: iv, intervalJitterS: ij,
        },
        {
          stopS: 900, stopIntervalS: iv, stopSog, stopCogRandom: true,
        },
        kind === 'retur'
          ? {
            toS: METRICS.cum[2] - 900, speedKn: 3.5, intervalS: iv, intervalJitterS: ij,
          }
          : {
            toS: METRICS.cum[2] + 900, speedKn: 4.5, intervalS: iv, intervalJitterS: ij,
          },
      ],
    }],
    expect: kind === 'retur'
      ? {
        minNotifiedPerBridge: { Klaffbron: 2 },
        maxNotifiedPerBridge: { Klaffbron: 2 },
        toleratedInvariants: [/^SEN MÅLBRO-NOTIS: \S+ \d{9}:Klaffbron — passage nr 2 /],
      }
      : {
        minNotifiedBridges: ['Klaffbron'],
        maxNotifiedPerBridge: { Klaffbron: 1 },
        toleratedInvariants: [/^MISSAD MÅLBRO-NOTIS: \d{9}:Klaffbron — /],
      },
  })),
  {
    // Revision 4, tät AIS (10 s) och ±30 m brus i 1 kn med slumpad kurs
    // (omgranskning 2:s P2). Revision 3 släppte på två fixar i rad på
    // ankomstsidan där den förra låg på linjen och kursen var slumpad.
    // Revision 4 kräver att båda fixarna ligger entydigt på ankomstsidan och
    // att båten var under gång dit även i den förra. ±30 m per koordinat
    // ligger delvis UTANFÖR appens brusmodell (två stilla fixar under 60 m
    // isär är brus), och klassen har en uppmätt rest: 2 av 24 banor i svepet
    // G2 (K/N/tmp/r4/logs/guards4.log), registrerad som känd gräns. Vakten
    // håller fast det fall som revision 4 stänger.
    // Varv 2 (familj A): också NEGATIVTESTET för under-bro-vakten i
    // VesselDataService.assignTargetAfterReversal. När båten ger upp väntan
    // bekräftar NEW_JOURNEY vändningen norrut på ett fix 16 m från Klaffbron,
    // söder om bron i latitud men 7,9 m norr om linjen längs kanalaxeln. Utan
    // vakten blev Klaffbron målbro i den ticken, nästa fix bokfördes som en
    // falsk målbropassage och en tredje Klaffbronvarning gick ut på 16 m. Två
    // varningar är de verkliga anflygningarna: norrut och tillbaka mot linjen.
    name: 'vänder-bromsar-väntar-3m-tät-10s-i-1kn-brus-30m-ge-upp (U14-vakt)',
    seed: 2956,
    vessels: [{
      mmsi: '904000088',
      name: 'VAKT4-ge-upp',
      jitterM: 30,
      startS: METRICS.cum[2] - 700,
      legs: [
        { toS: METRICS.cum[2] + 150, speedKn: 4.5, intervalS: 10 },
        { toS: METRICS.cum[2] + 30, speedKn: 3, intervalS: 10 },
        { toS: METRICS.cum[2] + 3, speedKn: 1, intervalS: 10 },
        {
          stopS: 900, stopIntervalS: 10, stopSog: 1, stopCogRandom: true,
        },
        { toS: METRICS.cum[2] + 900, speedKn: 4.5, intervalS: 10 },
      ],
    }],
    expect: {
      minNotifiedBridges: ['Klaffbron'],
      maxNotifiedPerBridge: { Klaffbron: 1 },
      maxOpeningsPerBridge: { Klaffbron: 2 },
      toleratedInvariants: [/^MISSAD MÅLBRO-NOTIS: \d{9}:Klaffbron — /],
    },
  },
  {
    // U14-revisionen 3, omgranskningens b-1.0: LÅNGSAM RETUR. Båten passerar
    // Klaffbron norrut, vänder 150 m bortom och går tillbaka söderut genom
    // bron i 1 kn med tät AIS (10 s). Passagelogiken bokför returen några
    // meter före linjen; vid 1 kn är båten 30 m ut först mer än 60 s senare.
    // Förra revisionen räknade sitt 60 s-fönster från bokföringen och missade
    // returen tyst. INV-7 (SEN) för passage nr 2 kommer av samma bokföring
    // före korsningen och tolereras som i vakterna ovan.
    name: 'långsam-retur-1kn-genom-Klaffbron (U14-vakt)',
    seed: 1311,
    vessels: [{
      mmsi: '903100101',
      name: 'VAKT-LANGSAM',
      jitterM: 3,
      startS: METRICS.cum[2] - 700,
      legs: [
        { toS: METRICS.cum[2] + 150, speedKn: 4.5, intervalS: 10 },
        { toS: METRICS.cum[2] + 40, speedKn: 3, intervalS: 10 },
        { toS: METRICS.cum[2] - 60, speedKn: 1, intervalS: 10 },
        { toS: METRICS.cum[2] - 900, speedKn: 3.5, intervalS: 10 },
      ],
    }],
    expect: {
      minNotifiedPerBridge: { Klaffbron: 2 },
      maxNotifiedPerBridge: { Klaffbron: 2 },
      toleratedInvariants: [/^SEN MÅLBRO-NOTIS: \S+ \d{9}:Klaffbron — passage nr 2 /],
    },
  },
  {
    // U14-revisionen, granskningens M1: returen över TVÅ broar i samma
    // AIS-glapp. Båten går norrut genom Stridsbergsbron, vänder 200 m bortom
    // och tystnar medan hon passerar tillbaka både Strids- och Järnvägsbron
    // (257 m isär). Båda bokförs i samma tick, och lastPassedBridge håller bara
    // den sist stämplade. Släppet läser därför även passedAt[bro]. På 7699cbe
    // får Stridsbergsbron 2 passager men 1 notis (INV-5).
    name: 'retur-över-två-broar-i-samma-glapp-Stridsbergsbron (U14-M1)',
    seed: 301,
    vessels: [{
      mmsi: '901000301',
      name: 'SYNT-M1',
      jitterM: 3,
      startS: METRICS.cum[2] - 700,
      legs: [
        { toS: METRICS.cum[4] + 200, speedKn: 4.5, intervalS: 10 },
        {
          toS: METRICS.cum[2] - 700,
          speedKn: 4.5,
          intervalS: 10,
          gapFromS: METRICS.cum[4] + 120,
          gapToS: METRICS.cum[3] - 120,
        },
      ],
    }],
    expect: { minNotifiedPerBridge: { Stridsbergsbron: 2, Järnvägsbron: 2 } },
  },
  {
    // U14-revisionen, granskningens M2: samma sak söderifrån vid Klaffbron.
    // Båten passerar Klaffbron söderut, vänder 150 m söder om bron och
    // tystnar medan hon passerar tillbaka Klaffbron och Järnvägsbron. Returen
    // bokförs ur glappet (SKIPPED_BRIDGES_CHECK) i samma tick som
    // Järnvägsbron. På 7699cbe får Klaffbron 2 passager men 1 notis (INV-5).
    name: 'retur-över-två-broar-i-samma-glapp-Klaffbron (U14-M2)',
    seed: 303,
    vessels: [{
      mmsi: '901000303',
      name: 'SYNT-M2',
      jitterM: 3,
      startS: METRICS.cum[4] + 400,
      legs: [
        { toS: METRICS.cum[2] - 150, speedKn: 4.5, intervalS: 10 },
        {
          toS: METRICS.cum[4] + 600,
          speedKn: 4,
          intervalS: 10,
          gapFromS: METRICS.cum[2] - 100,
          gapToS: METRICS.cum[3] + 100,
        },
      ],
    }],
    expect: { minNotifiedPerBridge: { Klaffbron: 2, Järnvägsbron: 2 } },
  },
  {
    // Två båtar möts VID Stridsbergsbron — grupplogik, klausulunikhet (INV-9)
    // och att båda får sina målbropassager/notiser utan korskontaminering.
    name: 'möte-vid-Stridsbergsbron',
    seed: 26,
    vessels: [
      {
        mmsi: '901000019', name: 'MÖTE-N', direction: 'north', speedKn: 4.5,
      },
      {
        mmsi: '901000020',
        name: 'MÖTE-S',
        direction: 'south',
        speedKn: 4.5,
        startOffsetS: Math.max(0, northSecondsToFraction(FRAC_STRIDSBERG, 4.5)
          - northSecondsToFraction(1 - FRAC_STRIDSBERG, 4.5)),
      },
    ],
    expect: { minTargetPassages: 4 },
  },
  {
    // navStatus-flap 0↔5 hos en ÄKTA väntare vid Klaffbron — lager 3
    // (navStatus∈{1,5} vid stillhet) får inte demotera en båt som inväntar
    // broöppning (S-F7-klassen).
    name: 'navstatus-flap-väntare',
    seed: 27,
    vessels: [{
      mmsi: '901000021',
      direction: 'north',
      speedKn: 4.0,
      stop: { atFraction: 0.34, durationS: 600 },
      navStatusPattern: [0, 5],
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    // Kajliggare med KONSTANT navStatus=5 (moored) — lager 3 ska klassa
    // henne förtöjd; inga notiser, ingen båttext. Första scenariot som
    // faktiskt exercerar navStatus-lagret (korpusarna saknar fältet).
    name: 'navstatus-5-kajliggare',
    seed: 28,
    vessels: [{
      mmsi: '901000022', direction: 'north', speedKn: 0, jitterM: 2, moorAt: { ...QUAY, durationS: 2400, navStatus: 5 },
    }],
    // Etapp 6: navStatus=5 (moored) ⇒ vessel._moored ⇒ beväpningsgrindens
    // första lager stänger. Noll öppningsvarningar.
    expect: { zeroNotifications: true, noVesselText: true, zeroOpeningWarnings: true },
  },
  {
    // GPS-outlier som TELEPORTERAR över Klaffbron (en sample, +300 m i
    // färdriktningen, sedan tillbaka på banan) — falsk linjekorsning får
    // inte ge dubbla notiser eller falsk passage (S-F4-klassen).
    name: 'teleport-över-Klaffbron',
    seed: 29,
    vessels: [{
      mmsi: '901000023',
      direction: 'north',
      speedKn: 4.5,
      gpsJump: { atFraction: Math.max(0, FRAC_KLAFFBRON - 150 / METRICS.total), offsetM: 300 },
    }],
    // Etapp 6: teleporten får inte fabricera en EXTRA öppningsvarning (falsk
    // linjekorsning ⇒ falsk passage ⇒ ny händelse). En per bro, som normalt.
    expect: {
      minTargetPassages: 2,
      expectedOpenings: ['Klaffbron', 'Stridsbergsbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
    },
  },
  {
    // RC3-klassen proaktivt: sog-kollaps till 0,6 kn genom själva
    // passagezonen — failsafens tidsskattning får inte strypa notisen.
    name: 'sog-kollaps-vid-Klaffbron',
    seed: 30,
    vessels: [{
      mmsi: '901000024',
      direction: 'north',
      speedKn: 4.5,
      slowZone: { fromFraction: FRAC_KLAFFBRON - 0.03, toFraction: FRAC_KLAFFBRON + 0.01, speedKn: 0.6 },
    }],
    expect: { minTargetPassages: 2, minNotifiedBridges: ['Klaffbron'] },
  },
  {
    // Krypfart genom hela kanalen — hastighetsgolv/ETA-rimlighet får inte
    // producera absurda texter (INV-1/9) och passagerna ska ändå detekteras.
    name: 'krypfart-0.8kn',
    seed: 31,
    vessels: [{
      mmsi: '901000025', direction: 'north', speedKn: 0.8, reportIntervalS: 300,
    }],
    // Etapp 6, KRYPFARTENS PRÖVNING: 0,8 kn i 5-minuterskadens betyder att
    // deadline-motorn måste hålla armen levande i ~50 min utan att
    // ARM_STALE_TTL:n (30 min utan OBSERVATION — inte utan rörelse) släpper
    // den, och att den långa transiten inte får generera en andra varning.
    expect: {
      minTargetPassages: 2,
      expectedOpenings: ['Klaffbron', 'Stridsbergsbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
    },
  },
  {
    // M (rättningskampanjen 2026-11-04, buggjägarens F05): krypfart FÖRBI en
    // passerad målbro mot nästa målbro långt bort. 0,45 kn i 30 s kadens ger
    // ≈ 7 m per fix, under 2-READINGS 10 m-krav, och båten ligger inom 300 m
    // från Klaffbron, som hon redan passerat (F21 häver skyddszonen där).
    // Förut tappades Stridsbergsbron efter nådafristen och kom tillbaka nästa
    // fix (PROTECTION_ACTIVE mäter mot närmaste bro): "Inga båtar" inklämt
    // mellan två likadana texter, INV-14 DEFAULT-FLASH fem gånger. Placeringen
    // är vald: zonen börjar 150 m före Klaffbron och slutar 250 m efter den,
    // alltså helt inom bypassens 300 m. Generatorns sog-brus (±0,1 kn) håller
    // farten över ANCHOR_BLOCK:s 0,3 kn, så det är tvåprovsvalideringen som
    // prövas och inte FIX B. Ändras rutten eller generatorn ska zonen räknas
    // om, inte förväntan tas bort.
    name: 'krypfart-förbi-passerad-Klaffbron',
    seed: 97,
    vessels: [{
      mmsi: '901000097',
      direction: 'north',
      speedKn: 5.9,
      reportIntervalS: 30,
      slowZone: {
        fromFraction: (METRICS.cum[2] - 150) / METRICS.total,
        toFraction: (METRICS.cum[2] + 250) / METRICS.total,
        speedKn: 0.45,
      },
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    // M, samma klass söderut: krypfart förbi Järnvägsbron mot Klaffbron
    // (963 m). Stridsbergsbron och Järnvägsbron är båda passerade när zonen
    // slutar, så ingen opasserad bro framför (C1d:s rang 1) håller skyddet.
    // Förut sex DEFAULT-FLASH mot Klaffbron. Zonen: 150 m norr om
    // Järnvägsbron till 300 m söder om den; söderut räknas andelen från
    // norra änden (1 − s / total).
    name: 'krypfart-förbi-passerad-Järnvägsbron-söderut',
    seed: 98,
    vessels: [{
      mmsi: '901000098',
      direction: 'south',
      speedKn: 5.9,
      reportIntervalS: 30,
      slowZone: {
        fromFraction: 1 - (METRICS.cum[3] + 150) / METRICS.total,
        toFraction: 1 - (METRICS.cum[3] - 300) / METRICS.total,
        speedKn: 0.45,
      },
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    // M, 300–500 m-bandet: lång krypning från 150 m före Klaffbron till
    // 250 m före Järnvägsbron. Mellan broarna finns ingen skyddszon alls, och
    // tilldelningens fartgrind kräver bara 0,1 kn 300–500 m från närmaste bro.
    // Förut tappades målbron var 2,5:e minut i en timme (16 DEFAULT-FLASH).
    name: 'lång-krypfart-Klaffbron-till-Järnvägsbron',
    seed: 99,
    vessels: [{
      mmsi: '901000099',
      direction: 'north',
      speedKn: 5.9,
      reportIntervalS: 30,
      slowZone: {
        fromFraction: (METRICS.cum[2] - 150) / METRICS.total,
        toFraction: (METRICS.cum[3] - 250) / METRICS.total,
        speedKn: 0.45,
      },
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    // M, granskningens syskon (a): krypare som INTE passerat någon bro, så
    // ANCHOR_BLOCK gäller inte. 0,12 kn i 30 s kadens, 300–500 m söder om
    // Olidebron: utanför skyddszonen och 1,8 km från Klaffbron, så retentionen
    // tar bort målbron (≈ 5,6 m närmande per nådafrist, under 10 m), medan
    // tilldelningen bara krävde 0,1 kn mot NÄRMASTE bro. Förut tillbaka nästa
    // fix: 5–7 DEFAULT-FLASH (seed 94–98). Återinträdesbeviset kräver samma
    // 10 m inom samma fönster, så båten är dold tills hon gör väg — EN lång
    // "Inga båtar"-period (INV-14W, informativ) i stället för flappen.
    // Placeringen ÄR testet: 300 m-gränsen och Kanalinfarten-punkten
    // (FP9-H') ligger strax utanför zonens ändar.
    name: 'krypfart-söder-om-Olidebron-ej-passerad',
    seed: 94,
    vessels: [{
      mmsi: '901000094',
      direction: 'north',
      speedKn: 5.9,
      reportIntervalS: 30,
      slowZone: {
        fromFraction: (METRICS.cum[1] - 500) / METRICS.total,
        toFraction: (METRICS.cum[1] - 300) / METRICS.total,
        speedKn: 0.12,
      },
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    // M, granskningens syskon (b): båt UTAN fartgivare (sog=null) som stannar
    // 60 m norr om passerade Klaffbron i 20 min. Med känd fart håller
    // ANCHOR_BLOCK henne mållös; okänd fart blockerar inte (helgranskningen
    // 2026-07-06), och PROTECTION_ACTIVE (≤ 300 m från närmaste bro) lade
    // tillbaka Stridsbergsbron nästa fix: 7 DEFAULT-FLASH (seed 94–98). Med
    // återinträdesbeviset beter hon sig som en båt med känd fart.
    name: 'sog-null-stopp-norr-om-passerade-Klaffbron',
    seed: 95,
    vessels: [{
      mmsi: '901000095',
      direction: 'north',
      speedKn: 5.9,
      reportIntervalS: 30,
      sogNull: true,
      stop: { atFraction: (METRICS.cum[2] + 60) / METRICS.total, durationS: 1200 },
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    // M rev 3 (omgranskningen 2026-11-05, granskarens klass H): FARTGRINDEN.
    // 0,65 kn söderut 560–1650 m söder om Stallbackabron, alltså mer än 500 m
    // från VARJE bro (Stridsbergsbron ligger 2,2 km bort), där tilldelningen
    // kräver > 0,7 kn. Generatorns fartbrus (±0,1 kn) lägger varannan–var
    // tredje fix över 0,7 kn. Retentionen tar bort målbron först när grinden
    // fallerat i mer än nådafristen, men ACCELERATED lade tillbaka den på
    // nästa ENSTAKA prov över 0,7 kn: 9 DEFAULT-FLASH (7–12 över seed 94–99;
    // revision 1 av rättningen gav 8, eftersom den bara speglade närmandet). Med
    // fartprovet (_reentrySpeedProof) läggs samma bro tillbaka först när
    // grinden HÅLLIT i mer än nådafristen, så båten är dold medan hon kryper
    // — EN lång "Inga båtar"-period (INV-14W, informativ). Placeringen ÄR
    // testet: inom 500 m från en bro gäller 0,1 kn-grinden i stället.
    name: 'fartgrind-krypare-söder-om-Stallbackabron',
    seed: 96,
    vessels: [{
      mmsi: '901000096',
      direction: 'south',
      speedKn: 5.9,
      reportIntervalS: 30,
      slowZone: {
        fromFraction: 1 - (METRICS.cum[5] - 560) / METRICS.total,
        toFraction: 1 - (METRICS.cum[5] - 1650) / METRICS.total,
        speedKn: 0.65,
      },
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    // Varje meddelande levereras DUBBELT (multi-mottagare/AISstream-dubbletter)
    // — utfallet ska vara identiskt med enkel leverans: inga dubbelnotiser.
    name: 'dubblettmeddelanden',
    seed: 32,
    vessels: [{
      mmsi: '901000026', direction: 'north', speedKn: 4.5, duplicateEvery: 1,
    }],
    // Etapp 6: dubbellevererade meddelanden får inte ge dubbla varningar —
    // varje sample kör observeVessel två gånger med IDENTISK fysik.
    expect: {
      minTargetPassages: 2,
      expectedOpenings: ['Klaffbron', 'Stridsbergsbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
    },
  },
  {
    // 35-min-gap i målbrozonen: fartyget stale-raderas (30 min) och återföds
    // BORTOM Klaffbron. Klaffbron-notisen är då >17 min gammal = medvetet
    // INTE notifierad (scenario A-skattningen); resten av resan ska leverera.
    name: 'gap-35min-över-Klaffbron',
    seed: 33,
    vessels: [{
      mmsi: '901000027',
      direction: 'north',
      speedKn: 1.6,
      // Gap-start 1200 m söder om Klaffbron: 2100 s @ 1,6 kn ≈ 1720 m →
      // återfödelse ~520 m norr om Klaffbron (söder om Järnvägsbron) så att
      // resten av resan (Stridsbergsbron) kan levereras normalt.
      gap: { atFraction: Math.max(0, FRAC_KLAFFBRON - 1200 / METRICS.total), durationS: 2100 },
    }],
    expect: { suppressedOpeningFires: 1, minTargetPassages: 1, minNotifiedBridges: ['Stridsbergsbron'] },
  },
  {
    // Out-of-order-leverans: EN fördröjd gammal position (400 m bakom) mitt
    // i resan — får inte ge sågtand (INV-3), falsk passage eller dubbelnotis.
    name: 'fördröjd-gammal-position',
    seed: 34,
    vessels: [{
      mmsi: '901000028', direction: 'north', speedKn: 4.5, staleEcho: { atFraction: 0.5, backM: 400 },
    }],
    expect: { minTargetPassages: 2 },
  },
  {
    // Två fartyg med SAMMA namn men olika mmsi — dedup är mmsi-nycklad och
    // får inte korskontaminera.
    name: 'samma-namn-två-mmsi',
    seed: 35,
    vessels: [
      {
        mmsi: '901000029', name: 'HAVSÖRN', direction: 'north', speedKn: 4.2,
      },
      {
        mmsi: '901000030', name: 'HAVSÖRN', direction: 'north', speedKn: 4.2, startOffsetS: 120,
      },
    ],
    expect: { minTargetPassages: 4 },
  },
  {
    // Anslutningsavbrott mitt i passage: AIS-tystnad + disconnect 5 min
    // strax före Klaffbron, reconnect när båten är bortom. Notisen får inte
    // tappas (failsafe-kedjan) och slutstädningen ska vara ren (INV-6/12).
    name: 'avbrott-mitt-i-passage',
    seed: 36,
    vessels: [{
      mmsi: '901000031',
      direction: 'north',
      speedKn: 4.5,
      gap: { atFraction: Math.max(0, FRAC_KLAFFBRON - 200 / METRICS.total), durationS: 300 },
    }],
    events: [
      { ctrl: 'disconnect', atOffsetS: northSecondsToFraction(FRAC_KLAFFBRON - 200 / METRICS.total, 4.5) + 5 },
      { ctrl: 'reconnect', atOffsetS: northSecondsToFraction(FRAC_KLAFFBRON - 200 / METRICS.total, 4.5) + 305 },
    ],
    expect: { minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron'] },
  },
  // === Utökning 2026-07-02 (11h-valideringskörningens två prod-klasser) ===
  {
    // NO LIMIT-klassen: båt MED target stannar 40 min och hörs bara var
    // 12:e minut (>10-min-RC7-fönstret). Före fixen doldes hon vid +10 min
    // och återkom vid nästa sample → "Inga båtar"-flapp (INV-14 dömer).
    // Efter fixen: stillaliggande (sog<1.5) visas upp till 25 min.
    name: 'ankrad-gles-sändare',
    seed: 37,
    vessels: [{
      mmsi: '901000032',
      direction: 'north',
      speedKn: 4.0,
      stop: { atFraction: 0.34, durationS: 2400 },
      stopReportIntervalS: 720,
    }],
    // Pelarutfallet är det som räknas: BÅDA målbroarnas notiser levereras.
    // (Klaffbron-target avregistreras KORREKT under 48-min-parkeringen 370 m
    // från bron — LOW_SPEED-grace — så bara Stridsbergsbron blir en formell
    // målbropassage; Klaffbron-notisen räddas av failsafe-kedjan vid
    // avgången. INV-14 vaktar att parkeringen inte ger DEFAULT-flappar.)
    expect: { suppressedOpeningFires: 2, minTargetPassages: 1, minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron'] },
  },
  {
    // MOSHE-klassen: södergående båt stale-raderas i 35-min-gap som spänner
    // Stridsbergsbron+Klaffbron, återföds MÅLBROLÖS söder om Klaffbron och
    // live-korsar Olidebron. Före fixen fick målbrolösa fartyg ingen
    // linjekorsningsdetektering alls → Olidebron-notisen missades.
    name: 'återfödd-utflygare-söderut',
    seed: 38,
    vessels: [{
      mmsi: '901000033',
      direction: 'south',
      speedKn: 1.6,
      gap: { atFraction: (1 - FRAC_STRIDSBERG) - 200 / METRICS.total, durationS: 2100 },
    }],
    expect: { minNotifiedBridges: ['Olidebron'] },
  },
  {
    // SY FREYJA-klassen (körning 2026-07-02b): norrgående båt tystnar i
    // 35-min-gap (krypfart genom tystnaden), stale-raderas, och återföds
    // MÅLLÖS ~200 m NORR om Stridsbergsbron på väg ut mot Vänern — hon
    // korsade Järnvägsbron OCH Stridsbergsbron i gapet. Före fixen strök
    // target-gaten (`!targetBridge && !_finalTargetBridge`) i
    // _checkSkippedBridgesFallback BÅDA failsafe-notiserna.
    name: 'återfödd-utflygare-norrut',
    seed: 39,
    vessels: [{
      mmsi: '901000034',
      direction: 'north',
      speedKn: 4.5,
      // Krypfart (0,68 kn) genom zonen [Jvb−250 m, Strids+150 m] = 657 m tar
      // ~31 min → tystnaden överskrider STALE_AIS (30 min) → borttagning +
      // återfödelse. Gap-svansen (~20 s i 4,5 kn) landar henne ~200 m norr om
      // Strids med full fart → scenario A:s tidsfönster täcker Jvb (~270 s)
      // och Strids (~85 s).
      slowZone: {
        fromFraction: (METRICS.cum[3] - 250) / METRICS.total,
        toFraction: (METRICS.cum[4] + 150) / METRICS.total,
        speedKn: 0.68,
      },
      gap: { atFraction: (METRICS.cum[3] - 250) / METRICS.total, durationS: 1900 },
    }],
    expect: { minNotifiedBridges: ['Järnvägsbron', 'Stridsbergsbron'] },
  },
  {
    // YEMANJA II-klassen (körning 2026-07-02b): målbron korsas i ett gap
    // vars ändpunkter ligger UTANFÖR geometrimetodernas gränser (prev ~1000 m
    // söder, curr ~380 m norr om Klaffbron), och båten STANNAR sedan utan att
    // korsa någon mer brolinje. Före fixen var failsafen notis-enbart —
    // target förblev den passerade bron (prod: 39 min "på väg mot Klaffbron"
    // medan båten låg still vid Järnvägsbron) och ingen målbropassage
    // registrerades. GAP_TARGET_INFERRED applicerar nu transitionen direkt.
    name: 'gap-över-målbron-utan-geometriträff',
    seed: 40,
    vessels: [{
      mmsi: '901000035',
      direction: 'north',
      speedKn: 4.8,
      // Gap 500 s ≈ 1250–1500 m (fartsjitter) → återfödelse ~250–450 m NORR
      // om Klaffbron i full fart (prev ~1000 m söder → båda ändpunkterna
      // utanför geometrimetodernas gränser). Stoppet ligger vid Jvb−110 m,
      // med god marginal BORTOM gap-landningen (annars fryser generatorn
      // henne under tystnaden och återfödelsesamplet får sog≈0 → failsafens
      // sog≥2-gate stänger). Där står hon 25 min — YEMANJA II låg still vid
      // Järnvägsbron. Diskriminatorn är minTargetPassages=2: utan
      // GAP_TARGET_INFERRED registreras Klaffbron-passagen ALDRIG (den senare
      // MISSED_TARGET_INFERRED-vägen vid Jvb-korsningen loggar ingen
      // TARGET_PASSAGE_RECORDED — verifierat empiriskt).
      gap: { atFraction: (METRICS.cum[2] - 1000) / METRICS.total, durationS: 500 },
      stop: { atFraction: (METRICS.cum[2] + 850) / METRICS.total, durationS: 1500 },
    }],
    expect: { minTargetPassages: 2, minNotifiedBridges: ['Olidebron', 'Klaffbron'] },
  },
  {
    // ELFKUNGEN-klassen (körning 2026-07-03, F2): norrgående båt tystnar i
    // 23-min-gap som spänner FYRA broar (Olide+Klaff+Jvb+Strids) och återkommer
    // norr om Stridsbergsbron — i kanalsvängen där cog legitimt är 30–55°.
    // Före fixen: (1) cog-gaten (north = cog ≤45°) kunde stryka HELA
    // kontrollen; (2) 2000 m-taket dödade Klaffbron-flushen; (3) target-
    // protection RESTORE:ade den passerade bron. Diskriminatorer:
    // minTargetPassages=2 (Klaff+Strids transiteras i kaskad i samma tick)
    // + alla fyra broarna notifierade.
    name: 'gap-över-fyra-broar-norrut',
    seed: 41,
    vessels: [{
      mmsi: '901000036',
      direction: 'north',
      speedKn: 6.5,
      // Gap 1380 s (23 min) från strax söder om Olidebron; i 6,5 kn ≈ 4,6 km
      // → återfödelse norr om Stridsbergsbron (cum[4]), som ELFKUNGEN 10:29.
      gap: { atFraction: (METRICS.cum[1] - 150) / METRICS.total, durationS: 1380 },
    }],
    expect: {
      minTargetPassages: 2,
      minNotifiedBridges: ['Olidebron', 'Klaffbron', 'Järnvägsbron', 'Stridsbergsbron'],
    },
  },
  {
    // DIANA-klassen (körning 2026-07-03, F5): södergående 14-min-gap som
    // spänner Strids+Jvb+Klaff. Före fixen flushades bara målbron —
    // Järnvägsbron @2057 m ströps av 2000 m-taket. Kräver även färdriktnings-
    // ordningen (nord→syd) i flush-loopen: annars kollapsar target-kedjan.
    name: 'gap-över-tre-broar-söderut',
    seed: 42,
    vessels: [{
      mmsi: '901000037',
      direction: 'south',
      speedKn: 5.9,
      // Sydgående rutt: fraction räknas från norr. Gap startar ~300 m norr om
      // Stridsbergsbron (dist från norr = total − cum[4] − 300) och varar
      // 840 s ≈ 2,5 km i 5,9 kn → landar söder om Klaffbron.
      gap: {
        atFraction: (METRICS.total - METRICS.cum[4] - 300) / METRICS.total,
        durationS: 840,
      },
    }],
    expect: {
      minTargetPassages: 2,
      minNotifiedBridges: ['Stridsbergsbron', 'Järnvägsbron', 'Klaffbron'],
    },
  },
  {
    // B1-namnbackfill (VALEN-klassen, körning 2026-07-03): shipName är
    // "Unknown" de första 20 minuterna — som aisstreams sena MetaData-
    // backfill för Class B. Kontrakt: (a) den råa platshållaren "Unknown"
    // läcker ALDRIG till notistokens (fallbacken är "Okänd båt");
    // (b) notiser efter backfillen bär det riktiga namnet (stickiness);
    // (c) INV-8 (fatal) vaktar att ett EN gång känt namn aldrig tappas.
    name: 'namnbackfill-unknown-20min',
    seed: 43,
    vessels: [{
      mmsi: '901000038',
      name: 'SYNT-VALEN',
      direction: 'north',
      speedKn: 5.0,
      nameFromS: 1200, // namnet anländer 20 min in — efter Kanalinfarten/Olidebron
    }],
    expect: {
      minTargetPassages: 2,
      noUnknownTokens: true,
      namedNoticesAfterS: 1500, // 5 min marginal efter backfill (rapportintervall)
      minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron'],
    },
  },
  {
    // Storgrupp (fas 7, 2026-07-03): FEM samtidiga norrgående båtar i konvoj
    // med 4-min-lucka — mer än någon korpus uppvisat (max 3). Tränar
    // grupperings-/räknelogiken ("Fem båtar på väg mot..."), INV-9:s
    // klausulstruktur och INV-1-grammatikens ordtal under verklig samtidighet.
    name: 'storgrupp-fem-båtar',
    seed: 44,
    vessels: [
      {
        mmsi: '901000040', name: 'SYNT-GRUPP1', direction: 'north', speedKn: 5.5, startOffsetS: 0,
      },
      {
        mmsi: '901000041', name: 'SYNT-GRUPP2', direction: 'north', speedKn: 5.4, startOffsetS: 240,
      },
      {
        mmsi: '901000042', name: 'SYNT-GRUPP3', direction: 'north', speedKn: 5.3, startOffsetS: 480,
      },
      {
        mmsi: '901000043', name: 'SYNT-GRUPP4', direction: 'north', speedKn: 5.2, startOffsetS: 720,
      },
      {
        mmsi: '901000044', name: 'SYNT-GRUPP5', direction: 'north', speedKn: 5.1, startOffsetS: 960,
      },
    ],
    expect: {
      minTargetPassages: 10, // 5 båtar × 2 målbroar
      noUnknownTokens: true,
      minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron'],
    },
  },
  {
    // Äkta processomstart (fas 7, 2026-07-03): ctrl:'restart' river appen och
    // skapar en NY instans mot samma settings-store mitt i resan (efter
    // Klaffbron-passagen). Testar load/save-cykeln i HELKEDJAN: den
    // persistenta 2h-dedupen laddas om och måste blockera återfödelse-
    // inferensens omnotiser för redan notifierade broar (Kanalinfarten/
    // Olidebron/Klaffbron/Järnvägsbron ligger bakom den återfödda båten) —
    // dubbletter fälls av fatala INV-2. Post-restart-broarna (Strids/
    // Stallbacka) ska notifieras normalt.
    name: 'omstart-mitt-i-passage',
    seed: 45,
    vessels: [{
      mmsi: '901000045',
      name: 'SYNT-OMSTART',
      direction: 'north',
      speedKn: 5.0,
      // Se OMSTART_SLOW_ZONE ovan: sträcker ut Stridsbergs-anflygningen så
      // att omstarten ryms EFTER in-session-fönstret men FÖRE passagen.
      slowZone: OMSTART_SLOW_ZONE,
    }],
    events: [{
      ctrl: 'restart',
      // 11 min efter Stridsbergsbron-varningen (härledningen i
      // OMSTART_RESTART_S ovan) — speglar en Homey-appuppdatering mitt i en
      // pågående anflygning.
      atOffsetS: OMSTART_RESTART_S,
    }],
    expect: {
      minTargetPassages: 2,
      noUnknownTokens: true,
      minNotifiedBridges: ['Klaffbron', 'Järnvägsbron', 'Stridsbergsbron', 'Stallbackabron'],
      // ÖPPNINGSDIMENSIONEN (etapp 6-granskningen): omstarten är det ENDA
      // scenario som prövar v1-beslutet "inga armar över omstart", och det
      // saknade taket. Reproducerat hål: den nya instansen beväpnade om och
      // varnade OM — TVÅ "Stridsbergsbron öppnar snart" fem minuter isär för
      // EN öppning. Kortkontraktet säger EN varning per förestående öppning,
      // och en Homey-app startas om vid varje appuppdatering.
      // Vakten är app.js persistenta öppningsdedup (bro|mmsi|riktning).
      expectedOpenings: ['Klaffbron', 'Stridsbergsbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
      // TVÅSIDIGT KONTRAKT (2026-08-22): den nya instansen MÅSTE försöka
      // varna igen (annars provas dedupen inte alls) och exakt EN avfyrning
      // MÅSTE tystas. maxOpeningsPerBridge ensam faller bara åt ena hållet;
      // det här talet fäller även motsatsen — en omstart som inte beväpnar
      // om ger 0 tystade och gör scenariot rött i stället för falskt grönt.
      suppressedOpeningFires: 1,
    },
  },
  // === Utökning 2026-07-06 (helgranskningens teststärkning) ===
  {
    // sog=null-klassen (helgranskningen 2026-07-06, F1): Class B-transponder
    // UTAN fartgivare — sog är null i VARJE rapport ("ej tillgänglig" enligt
    // AIS-spec, får inte avvisas). Före F1-fixarna: Number(null)=0 föll på
    // fartgrindarna (målbro först <300 m), ANCHOR_BLOCK hårdblockerade efter
    // passage (Strids-target uteblev) och waiting-timern kastade TypeError.
    // Kontraktet: hela genomresan bärs av positionsdeltan (rörelsebevis) —
    // båda målbroarna passeras formellt OCH notifieras.
    name: 'fartgivarlös-genomresa (sog=null)',
    seed: 47,
    vessels: [{
      mmsi: '901000047',
      name: 'SYNT-NOSPEED',
      direction: 'north',
      speedKn: 4.5, // styr positionsdeltan; sogNull nollar själva fältet
      sogNull: true,
    }],
    expect: {
      minTargetPassages: 2,
      noUnknownTokens: true,
      minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron'],
      // Etapp 6: den fartgivarlösa klassen har fällt fyra granskningsrundor.
      // Deadline-motorn är per konstruktion sog-oberoende (ren avståndsformel
      // med DEADLINE_MAX_SPEED_KN) — det ska synas som FULL öppningstäckning
      // här, inte som tystnad.
      expectedOpenings: ['Klaffbron', 'Stridsbergsbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
    },
  },
  {
    // Kajliggare vid KANALINFARTEN (helgranskningen 2026-07-06, app-6#R2-2):
    // förtöjd båt ~250 m NORR om trigger-punkten — inom exit-fallbackens
    // 400 m-radie och på "rätt" sida. Före fixen saknade exit-fallbacken
    // förtöjnings-/rörelsebevis-gate (och snapshotten fälten) → varje
    // removal-cykel gav en falsk Kanalinfarten-notis (persistent dedup
    // begränsade till en per 2 h — fortfarande P2-brott). Efterspelets
    // removal får INTE producera någon notis.
    name: 'kajliggare-kanalinfarten-ingen-exitnotis',
    seed: 48,
    vessels: [{
      mmsi: '901000048',
      name: 'SYNT-KAJEXIT',
      direction: 'north',
      speedKn: 0,
      jitterM: 2,
      moorAt: {
        lat: TRIGGER_POINTS.kanalinfarten.lat + 250 / 111320,
        lon: TRIGGER_POINTS.kanalinfarten.lon,
        durationS: 2700,
        navStatus: null, // Class B — förtöjningen måste bevisas av rörelselagren
      },
    }],
    // Etapp 6: den här kajliggaren ligger INOM en trigger-punkts
    // ledger-radie — det är alltså V1-kajbokföringen (inte bara
    // rörelsebeviset) som måste hålla henne obeväpnad genom hela
    // removal-cykeln. PRICKBJORN-klassen i syntetisk form.
    expect: { zeroNotifications: true, noVesselText: true, zeroOpeningWarnings: true },
  },
  {
    // GPS-hopp VID notisgränsen (helgranskningen 2026-07-06, Fix 5-gaten):
    // 500 m-teleport i EN sample precis när båten närmar sig Klaffbrons
    // 300 m-zon. Fix 5-hold:en ska blockera notis från den falska positionen;
    // den legitima notisen kommer när äkta positionen når zonen. Fatala
    // INV-11 (notisdistans, positionsberikad) fäller körningen om en notis
    // avfyras från hopp-positionen; fatala INV-2 fäller dubbletter om dedup-
    // nyckeln sätts av hoppet och blockerar den äkta.
    name: 'gps-hopp-vid-notisgränsen',
    seed: 49,
    vessels: [{
      mmsi: '901000049',
      name: 'SYNT-HOPPGRÄNS',
      direction: 'north',
      speedKn: 4.5,
      gpsJump: {
        atFraction: (METRICS.cum[2] - 350) / METRICS.total, // ~350 m söder om Klaffbron
        offsetM: 500,
      },
    }],
    expect: {
      minTargetPassages: 2,
      minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron'],
      // Etapp 6: 500 m-hoppet får varken fabricera en extra varning (falsk
      // närhet ⇒ ny händelse) eller strypa den äkta.
      expectedOpenings: ['Klaffbron', 'Stridsbergsbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
    },
  },
  {
    // HERA II-klassen (FÄLTPROV 2026-07-07, missad Järnvägsbron): sydgående
    // båt tystnar i 35-min-gap som spänner Stridsbergsbron+Järnvägsbron,
    // stale-raderas, och ÅTERFÖDS I KÖ-FART (~0,6 kn) söder om Järnvägsbron
    // på väg mot Klaffbron. Före fixen strök scenario A:s sog≥2-gate hela
    // inferensen trots att sist-kända-positionen POSITIONSBEVISADE
    // korsningarna — riktningen tas nu ur positionsdeltat i reborn-fallet.
    name: 'återfödd-i-kö (HERA-klassen)',
    seed: 50,
    vessels: [{
      mmsi: '901000050',
      name: 'SYNT-HERA',
      direction: 'south',
      speedKn: 5.0,
      // Sydgående: fraction räknas från norr. Kö-fart (0,45 kn) från 100 m
      // norr om Strids till 400 m söder om Jvb; gapet (35 min → removal vid
      // 30 min) börjar strax söder om Strids-linjen INNE i kö-zonen →
      // tystnadssträckan blir 0,45 kn × 2100 s ≈ 490 m → återfödsel ~230 m
      // söder om Järnvägsbron, fortfarande i kö-fart (<2 kn — porten-gatens
      // gamla offer). Strids notifieras live (waiting) före gapet; Jvb-
      // korsningen är POSITIONSBEVISAD av [sist kända → återfödsel].
      slowZone: {
        fromFraction: (METRICS.total - METRICS.cum[4] - 100) / METRICS.total,
        toFraction: (METRICS.total - METRICS.cum[3] + 400) / METRICS.total,
        speedKn: 0.45,
      },
      gap: {
        atFraction: (METRICS.total - METRICS.cum[4] + 30) / METRICS.total,
        durationS: 2100,
      },
    }],
    expect: {
      suppressedOpeningFires: 1,
      minNotifiedBridges: ['Stridsbergsbron', 'Järnvägsbron', 'Klaffbron'],
    },
  },
  {
    // AKIRA-klassen (FÄLTPROV 3, 2026-07-08): kajliggare i KAJZONEN (mellan
    // Klaffbron och Järnvägsbron) som avgår SÖDERUT i låg fart (target=
    // Klaffbron sätts, _routeDirection låses 'south'), U-svänger utan att
    // någonsin korsa Klaffbron och drar norrut i marschfart med gles Class B-
    // cadence (5 min) — Järnvägsbron+Stridsbergsbron korsas i ETT samplesteg.
    // Före fixen läste RC9-blocken den inlåsta _routeDirection='south' →
    // beyondTarget föll åt fel håll, TARGET_PROTECTION (maneuver/gps-event)
    // återaktiverades och höll Klaffbron ⇒ "på väg mot Klaffbron, om 16 min"
    // i 5,5 min EFTER den positionsbevisade Strids-korsningen (tills Fix D:s
    // COG-debounce fått två samples). Nu: korsningsbeviset bekräftar
    // reversalen OMEDELBART. Notisförväntningarna vaktar pelare 2 genom
    // reversal-tick:et (Jvb+Strids-flushen får inte tappas när target rensas
    // mitt i ticken) och forbiddenNotifiedBridges vaktar att ingen fantom-
    // Klaffbron-notis fabriceras (hon var aldrig söder om Klaffbron).
    name: 'kajavgång-u-sväng (AKIRA-klassen)',
    seed: 51,
    vessels: [(() => {
      const sDep = METRICS.cum[2] + 500; // kajplats ~500 m norr om Klaffbron
      const sTurn = METRICS.cum[2] + 335; // vändpunkt — närmast Klaffbron blir ~315 m (utanför 300 m-notiszonen)
      const kaj = pointAt(PATH, METRICS, sDep);
      return {
        mmsi: '901000051',
        name: 'SYNT-AKIRA',
        direction: 'south',
        speedKn: 5.0,
        reportIntervalS: 300, // gles Class B — broarna korsas mellan samples
        moorAt: {
          lat: kaj.lat, lon: kaj.lon, durationS: 900, navStatus: null,
        },
        runRouteAfterMooring: true,
        // Sydlig avgång + vändning + norrgående kryp i låg fart (AKIRA:
        // 0,9–1,5 kn — Fix D:s sog≥2-gate förblir stängd, targeten består).
        // Zonen sträcker sig FÖRBI Järnvägsbron (cum[3]+71) så att det
        // FÖRSTA snabba nordsamplet är själva korsningssamplet — precis som
        // AKIRA:s 07:30:09 där TARGET_RECALC_PENDING sattes i samma tick
        // som Strids-passagen detekterades (COG-debouncen hann alltså inte;
        // korsningsbeviset MÅSTE bekräfta reversalen). Marginalerna (±100 m
        // runt vänd-/kajpunkten) skyddar mot nearestPathS 25 m-grid.
        slowZone: {
          fromFraction: 1 - (METRICS.cum[3] + 71) / METRICS.total,
          toFraction: 1 - (sTurn - 100) / METRICS.total,
          speedKn: 1.2,
        },
        uTurnAtFraction: 1 - sTurn / METRICS.total,
      };
    })()],
    expect: {
      minNotifiedBridges: ['Järnvägsbron', 'Stridsbergsbron', 'Stallbackabron'],
      forbiddenNotifiedBridges: ['Klaffbron'],
      // ÖPPNINGSVARNINGARNA (etapp 6) — KLASSNINGSBESLUT, se rapporten:
      // Klaffbron FÅR varnas här, och det är INTE en kajvobbel. AKIRA gör en
      // ÄKTA avgång (5,0 kn) från en kajplats mitt i farleden, 500 m norr om
      // Klaffbron, med bron som målbro — exakt "båt som vänder EFTER sista
      // fixen mitt i beväpnad approach", produktprincipens ACCEPTERADE
      // falsklarmsklass. Kajgrinden ÄR verksam här sedan etapp 6-granskningen
      // (öppningslagret bokför numera också målbroarnas närområden), men den
      // släpper henne på rätt grund: 5,0 kn ligger över
      // BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN, dvs. medianfarten för en
      // ÄKTA anflygning — AKIRA-fältfallets 1,1 kn gör det inte.
      // Det som däremot ALDRIG får hända är att
      // U-svängen + krypfarten norrut genererar en ANDRA Klaffbron-varning —
      // det vore vobbeln som betalar sig. Taket är därför 1, och den
      // NOTIS-dimension som redan är låst (forbiddenNotifiedBridges) är
      // oförändrad.
      maxOpeningsPerBridge: { Klaffbron: 1 },
    },
  },
  {
    // SENTA-klassen (FÄLTPROV 4, 2026-07-09, F4-B): sydgående köar vid
    // Stridsbergsbron (waiting-notis), tystnar i långt gap, stale-removas
    // och ÅTERFÖDS ~2,3 km söderut nära Olidebron. Reborn-fönstret
    // [lastKnown → nuvarande] positionsbevisar Järnvägsbron+Klaffbron —
    // men Jvb låg 2139 m bort och ströps av 2000 m-taket medan Klaffbron
    // (1184 m) i SAMMA fönster notifierades. F4-B: fönsterbelagda
    // kandidater bär inferredFlush (position färsk + 10 km-sanity).
    name: 'reborn-fönster-bortom-2000m (SENTA-klassen)',
    seed: 52,
    vessels: [{
      mmsi: '901000052',
      name: 'SYNT-SENTA',
      direction: 'south',
      speedKn: 3.0,
      slowZone: {
        fromFraction: (METRICS.total - METRICS.cum[4] - 100) / METRICS.total,
        toFraction: (METRICS.total - METRICS.cum[4] + 150) / METRICS.total,
        speedKn: 0.5,
      },
      gap: {
        atFraction: (METRICS.total - METRICS.cum[4] + 30) / METRICS.total,
        durationS: 2400,
      },
    }],
    expect: {
      minNotifiedBridges: ['Stridsbergsbron', 'Järnvägsbron', 'Klaffbron'],
      // Etapp 6: reborn-fallet får inte varna två gånger för samma öppning.
      // Fartyget stale-raderas ur VesselDataService mitt i tystnaden — armen
      // lever kvar i servicens EGEN Map (det är hela poängen med att inte
      // hänga armarna på vessel-objektet) och återfödelsen får därför inte
      // seeda en ny händelse för en bro som redan varnats.
      expectedOpenings: ['Stridsbergsbron'],
      maxOpeningsPerBridge: { Stridsbergsbron: 1, Klaffbron: 1 },
    },
  },
  {
    // PIANO-klassen (FÄLTPROV 4, 2026-07-09, F4-C): sydgående väntar i
    // krypfart vid Olidebron (waiting-notis), COG-vobblar/U-svänger i
    // 0,5 kn utan att korsa bron. Före fixen släppte riktningsflip-
    // undantaget (session + persistent) dedup-nyckeln på vobbeln → ANDRA
    // Olidebron-notisen för samma väntläge. F4-C: flip-bedömningens nya
    // riktning kräver sog ≥ 2,0 kn. Returresan norrut (4,5 kn) ger
    // legitima nya notiser för de norra broarna (äkta riktningsbyte) —
    // Olidebron får EXAKT EN.
    name: 'väntare-vobbel-vid-bro (PIANO-klassen)',
    seed: 53,
    vessels: [{
      mmsi: '901000053',
      name: 'SYNT-PIANO',
      direction: 'south',
      speedKn: 4.5,
      slowZone: {
        fromFraction: (METRICS.total - METRICS.cum[1] - 400) / METRICS.total,
        toFraction: (METRICS.total - METRICS.cum[1] + 150) / METRICS.total,
        speedKn: 0.5,
      },
      uTurnAtFraction: (METRICS.total - (METRICS.cum[1] + 150)) / METRICS.total,
    }],
    expect: {
      minNotifiedBridges: ['Olidebron'],
      maxNotifiedPerBridge: { Olidebron: 1 },
    },
  },
  {
    // SOKERI-klassen (FÄLTPROV 4, 2026-07-09, F4-E): sydgående parkerar
    // 74 m norr om Stridsbergsbron i 35 min och SÄNDER var 3:e minut
    // (stillastående men levande — Class B-ankringskadens). Före fixen
    // mätte degraderingsgaterna positionsÄNDRINGSTID → ETA_STALE_HARD
    // dömde färskt bekräftad väntare som "615s old" → "ETA okänd"-dipp
    // mitt i kön + strax→minuter-hopp. F4-E: bekräftad-position-klockan.
    // INV-14 (DEFAULT-flash), INV-17 (textflapp) och INV-18 (ETA-stigning)
    // vaktar hela textbeteendet under väntan.
    name: 'parkerad-väntare-färsk-sändare (SOKERI-klassen)',
    seed: 54,
    vessels: [{
      mmsi: '901000054',
      name: 'SYNT-SOKERI',
      direction: 'south',
      speedKn: 4.0,
      stop: {
        atFraction: (METRICS.total - METRICS.cum[4] - 74) / METRICS.total,
        durationS: 2100,
      },
      stopReportIntervalS: 180,
    }],
    expect: {
      minNotifiedBridges: ['Stridsbergsbron'],
      // Etapp 6, VÄNTZONSUNDANTAGET i renodlad form: 35 min stillastående
      // 74 m från målbron, med FÄRSKA rapporter hela tiden. Det är
      // normalfallet för en öppning — armen får varken avväpnas (stoppet är
      // långt INNANFÖR DISARM_MOORED_MIN_DISTANCE_M = 600 m) eller varna om.
      expectedOpenings: ['Stridsbergsbron'],
      maxOpeningsPerBridge: { Stridsbergsbron: 1, Klaffbron: 1 },
    },
  },
  {
    // PILOT 761-klassen (fältprov 5, 2026-07-10, F5-A / testauditen TA3):
    // nordgående passerar hela kanalen och lägger sig still 200 m norr om
    // Stallbackabron (lots-stationen) — SÄNDANDE var 3:e minut i 2h20.
    // 2h-deduppostens fönster hinner löpa ut medan sessionsnyckeln lever
    // och båten står kvar INOM 300 m-notiszonen. Före F5-A släppte
    // expired-grenen sessionsnyckeln ovillkorligt → FANTOM-notis för
    // Stallbackabron utan ny passage (08:25-fantomen). Kontraktet låser
    // EXAKT EN notis per bro över hela förloppet — regressionsskydd för
    // expired-släppskedjan i HELKEDJA (enhetstesterna i faltprov-5- och
    // helgranskning-2026-07-10-sviterna täcker grenarna isolerat).
    name: 'stillaliggare-efter-2h-prune (PILOT-klassen)',
    seed: 55,
    vessels: [{
      mmsi: '901000055',
      name: 'SYNT-PILOT',
      direction: 'north',
      speedKn: 5.0,
      stop: {
        atFraction: (METRICS.cum[5] + 200) / METRICS.total,
        durationS: 8400,
      },
      stopReportIntervalS: 180,
    }],
    expect: {
      minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron', 'Stallbackabron'],
      maxNotifiedPerBridge: { Stallbackabron: 1, Stridsbergsbron: 1, Klaffbron: 1 },
      // Etapp 6: 2h20 stillaliggande EFTER båda målbroarna. Öppningslagret
      // ska ha gjort sitt (en varning per målbro, före passagen) och sedan
      // vara helt tyst — armarna prunas av ARM_STALE_TTL och den långa
      // stillheten får aldrig seeda en ny händelse. Stallbackabron kan per
      // konstruktion aldrig varnas (den är ingen målbro och öppnar aldrig).
      expectedOpenings: ['Klaffbron', 'Stridsbergsbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
      forbiddenOpeningBridges: ['Stallbackabron'],
    },
  },
  // === Utökning etapp 6 (2026-08-03) — deadline-motorn i HELKEDJA ===
  {
    // ÄGGKLOCKANS KÄRNFALL, användarens uttalade designkrav: sista fixet
    // långt ute, sedan TOTAL radiotystnad — varningen ska ändå gå ut, driven
    // av 30 s-watchdogen och ingenting annat.
    //
    // Geometrin är vald så att avfyrningen GARANTERAT sker under tystnaden:
    // hon tystnar 2000 m söder om Klaffbron i 3,0 kn. Deadline-fysiken ger
    // 2000 m / 10 kn = 389 s till "tidigast möjliga ankomst" och varningen
    // ska gå 180 s före den, dvs. ~209 s EFTER sista fixet — medan
    // FIRE_EXPECTED_ETA-grenen (3,0 kn ⇒ 21 min kvar) är långt ifrån att
    // lösa ut. Hade hon tystnat på 700 m hade varningen redan gått ut på
    // sitt sista fix och scenariot bevisat fel sak.
    //
    // Ingen passage detekteras (hon syns aldrig mer), så det här är också
    // fantomtakets ACCEPTERADE klass i renodlad form: en äkta beväpnad
    // anflygning som tystnar. Enhetstesterna på servicen (O4) täcker
    // grenarna isolerat; det här beviset går genom HELA kedjan — app.js
    // observeVessel, watchdogen, avfyrningsvägen och Homey-kortet.
    name: 'tyst-från-2000m (deadline i total radiotystnad)',
    seed: 56,
    vessels: [{
      mmsi: '901000056',
      name: 'SYNT-TYST',
      direction: 'north',
      speedKn: 3.0,
      gap: {
        atFraction: (METRICS.cum[2] - 2000) / METRICS.total,
        durationS: 99999, // aldrig mer — sändaren är död
      },
    }],
    expect: {
      noTargetPassages: true,
      expectedOpenings: ['Klaffbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
      deadlineFiredOpenings: ['Klaffbron'],
    },
  },
  // === Varv 2, familj C (M3 ÅTERFÖDD-DÖDBAND) ===
  // En båt hörs EN gång (ingen målbro), raderas av proximity-timeouten och
  // återföds på nästa fix med kurs i dödbandet. K1-mätningen mot sist kända
  // position bevisar färdriktningen, men på c14938f fick hon ändå ingen målbro
  // i återfödelsens tick (svepets ruttlås kom efter _observeBridgeOpening).
  // Sedan tystnar hon över målbron. Utan arm går ingen deadline, och bron
  // korsas ovarnad. Med rättningen beväpnas hon på återfödelsen och
  // äggklockan avfyrar i tystnaden. Fallet kräver gles AIS och en bestämd
  // placering och har därför inget korpusfall.
  {
    // Buggjägarens värld 756 (F05-representanten, FREJA): söderut, återfödd
    // 1888 m norr om Stridsbergsbron i 7 kn med kurs ~231° (västra dödbandet),
    // nordprogress ≈ −2,9 m/s över 420 s. Deadline 1888 m / 10 kn − 180 s ≈
    // 187 s efter återfödelsen; korsningen sker ~525 s efter. På c14938f:
    // ingen Stridsbergsbron-varning (radering efter 10 min, återfödelse söder
    // om Järnvägsbron med Klaffbron som mål).
    name: 'återfödd-i-dödbandet-söderut-tyst-över-Stridsbergsbron (M3, värld 756)',
    seed: 757,
    vessels: [{
      mmsi: '901000757',
      name: 'SYNT-FREJA',
      startS: METRICS.cum[4] + 1888 + 7 * 0.5144 * 420,
      legs: [
        {
          toS: METRICS.cum[4] + 1889, speedKn: 7, intervalS: 420, cogDeg: 231,
        },
        {
          toS: METRICS.cum[3] - 300,
          speedKn: 7,
          intervalS: 60,
          cogDeg: 231,
          gapFromS: METRICS.cum[4] + 1888,
          gapToS: METRICS.cum[3] - 299,
        },
        { toS: METRICS.cum[2] - 600, speedKn: 6, intervalS: 60 },
      ],
    }],
    expect: {
      expectedOpenings: ['Stridsbergsbron'],
      deadlineFiredOpenings: ['Stridsbergsbron'],
      maxOpeningsPerBridge: { Stridsbergsbron: 1, Klaffbron: 1 },
    },
  },
  {
    // Buggjägarens värld 1913 (HAVSORN) och 977 (PELLE): norrut från
    // Kanalinfarten, återfödd 1900 m söder om Klaffbron i 3,6 kn med kurs ~52°
    // (östra dödbandet), nordprogress ≈ +1,7 m/s över 300 s. Deadline ≈ 189 s
    // efter återfödelsen; korsningen ~1026 s efter. På c14938f: ingen
    // Klaffbron-varning (radering efter 10 min, och nästa fix norr om
    // Klaffbron ligger bortom nordprogressens 15 min).
    name: 'återfödd-i-dödbandet-norrut-tyst-över-Klaffbron (M3, värld 1913)',
    seed: 1913,
    vessels: [{
      mmsi: '901001913',
      name: 'SYNT-HAVSORN',
      startS: METRICS.cum[2] - 1900 - 3.6 * 0.5144 * 300,
      legs: [
        {
          toS: METRICS.cum[2] - 1901, speedKn: 3.6, intervalS: 300, cogDeg: 52,
        },
        {
          toS: METRICS.cum[2] + 300,
          speedKn: 3.6,
          intervalS: 60,
          cogDeg: 52,
          gapFromS: METRICS.cum[2] - 1900,
          gapToS: METRICS.cum[2] + 299,
        },
        { toS: METRICS.cum[4] + 600, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: {
      expectedOpenings: ['Klaffbron'],
      deadlineFiredOpenings: ['Klaffbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
    },
  },
];

function runScenario(scenario) {
  const samples = generateScenario(scenario);
  const { truthPaths } = samples;
  const tmpFile = path.join(os.tmpdir(), `synthetic-${scenario.seed}.jsonl`);
  fs.writeFileSync(tmpFile, samples.map((s) => JSON.stringify(s)).join('\n'));
  try {
    const stdout = execFileSync('node', [RUNNER, tmpFile], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000,
    });
    const m = stdout.match(/__REPLAY_JSON__([\s\S]*?)__END__/);
    if (!m) throw new Error('Ingen JSON-markör i replay-output');
    return { result: JSON.parse(m[1]), sampleCount: samples.length, truthPaths };
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

// Kedjeindex i PATH per bro (se METRICS ovan): ledtidskravets sanna korsningar.
const PATH_INDEX = {
  Olidebron: 1, Klaffbron: 2, Järnvägsbron: 3, Stridsbergsbron: 4, Stallbackabron: 5,
};

function checkExpectations(scenario, result, truthPaths = {}) {
  const problems = [];
  const e = scenario.expect || {};
  const passages = result.targetPassages || [];
  const notifications = result.notifications || [];

  // Harness-fix (2026-07-01): processErrors är ett TAL — gamla `.length`-
  // kontrollen var död (undefined > 0 är alltid false).
  if ((result.processErrors || 0) > 0) problems.push(`${result.processErrors} processfel`);
  if (result.leakDiagnostics && result.leakDiagnostics.vessels !== 0) {
    problems.push(`${result.leakDiagnostics.vessels} fartyg kvar efter efterspel`);
  }
  if (e.minTargetPassages != null && passages.length < e.minTargetPassages) {
    problems.push(`målbro-passager ${passages.length} < förväntade ${e.minTargetPassages}`);
  }
  if (e.noTargetPassages && passages.length > 0) {
    problems.push(`oväntade målbro-passager: ${passages.map((p) => p.bridge).join(',')}`);
  }
  // R1 (2026-11-04): bokförda passager per bro oavsett slag. En returpassage
  // efter en bekräftad U-sväng bokförs som mellanbropassage när båten redan
  // är mållös (samma utfall som RE_CROSS_EVIDENCED), så minTargetPassages
  // ensam ser den inte.
  if (e.minPassagesPerBridge) {
    const all = [...passages, ...(result.intermediatePassages || [])];
    for (const [bridge, minN] of Object.entries(e.minPassagesPerBridge)) {
      const n = all.filter((p) => p.bridge === bridge).length;
      if (n < minN) problems.push(`bokförda passager av ${bridge} ${n} < förväntade ${minN}`);
    }
  }
  // Varv 2 (familj A, granskningen): spegeln, mot fantompassager.
  if (e.maxPassagesPerBridge) {
    const all = [...passages, ...(result.intermediatePassages || [])];
    for (const [bridge, maxN] of Object.entries(e.maxPassagesPerBridge)) {
      const n = all.filter((p) => p.bridge === bridge).length;
      if (n > maxN) problems.push(`FANTOMPASSAGE: ${n} bokförda passager av ${bridge} (max ${maxN})`);
    }
  }
  if (e.zeroNotifications && notifications.length > 0) {
    problems.push(`oväntade notiser: ${notifications.map((n) => `${n.mmsi}:${n.bridge}`).join(',')}`);
  }
  if (e.noVesselText) {
    const vesselTexts = (result.bridgeTextTransitions || []).filter((t) => /på väg mot/.test(t.text));
    if (vesselTexts.length > 0) problems.push(`oväntad båttext: "${vesselTexts[0].text}"`);
  }
  if (e.minNotifiedBridges) {
    const notified = new Set(notifications.map((n) => n.bridge));
    for (const bridge of e.minNotifiedBridges) {
      if (!notified.has(bridge)) problems.push(`saknad notis för ${bridge}`);
    }
  }
  // Fältprov 3 (2026-07-08, AKIRA-klassen): broar som ALDRIG korsats får
  // inte notifieras — vaktar mot fantomnotiser från reversal-/inferenslogiken.
  if (e.forbiddenNotifiedBridges) {
    const notified = new Set(notifications.map((n) => n.bridge));
    for (const bridge of e.forbiddenNotifiedBridges) {
      if (notified.has(bridge)) problems.push(`FÖRBJUDEN notis för ${bridge} (bron korsades aldrig)`);
    }
  }
  // Fältprov 4 (2026-07-09, PIANO-klassen): max antal notiser per bro —
  // vaktar dubbletter som INV-2:s motsatt-riktnings-undantag annars släpper
  // (COG-vobbel hos väntare är inte en äkta returpassage).
  if (e.maxNotifiedPerBridge) {
    const counts = {};
    for (const n of notifications) counts[n.bridge] = (counts[n.bridge] || 0) + 1;
    for (const [bridge, maxN] of Object.entries(e.maxNotifiedPerBridge)) {
      if ((counts[bridge] || 0) > maxN) {
        problems.push(`DUBBLETT: ${bridge} fick ${counts[bridge]} notiser (max ${maxN})`);
      }
    }
  }
  // U14 (2026-11-04, B01): minsta antal notiser per bro — en verklig
  // returpassage inom samma besök ska ha sin egen notis.
  if (e.minNotifiedPerBridge) {
    const counts = {};
    for (const n of notifications) counts[n.bridge] = (counts[n.bridge] || 0) + 1;
    for (const [bridge, minN] of Object.entries(e.minNotifiedPerBridge)) {
      if ((counts[bridge] || 0) < minN) {
        problems.push(`SAKNAD RETURNOTIS: ${bridge} fick ${counts[bridge] || 0} notiser (minst ${minN})`);
      }
    }
  }
  // ---------------------------------------------------------------------
  // ÖPPNINGSVARNINGAR (etapp 6, 2026-08-03) — additiv dimension
  // ---------------------------------------------------------------------
  const openings = result.openingWarnings || [];
  // Servicen kan avfyra utan att kortet nås (dedup som spärrar fel, saknat
  // kort, kastande tokenbygge). Skillnaden är normalt en bugg i leveransvägen
  // — men i omstartsscenariot ÄR tystnaden kontraktet, och då mäts den som ett
  // exakt tal i stället för att undantas (2026-08-22, fixrunda 2b-granskningen).
  if (Number.isFinite(result.openingServiceFires)) {
    const expectedSuppressed = Number.isFinite(e.suppressedOpeningFires) ? e.suppressedOpeningFires : 0;
    const suppressed = result.openingServiceFires - openings.length;
    if (suppressed !== expectedSuppressed) {
      problems.push(expectedSuppressed === 0
        ? `ÖPPNINGSLEVERANS: servicen avfyrade ${result.openingServiceFires} men kortet fick ${openings.length}`
        : `ÖPPNINGSDEDUP: servicen avfyrade ${result.openingServiceFires}, kortet fick ${openings.length} `
          + `⇒ ${suppressed} tystade (förväntat exakt ${expectedSuppressed})`);
    }
  }
  problems.push(...openingDeliveryFailures(result));
  const failedOpenings = openings.filter((w) => w.success === false);
  if (failedOpenings.length > 0) {
    problems.push(`ÖPPNINGSVARNING KASTADE: ${failedOpenings[0].error || 'okänt fel'}`);
  }
  // Armarna får aldrig överleva efterspelet (30 min TTL < 40 min efterspel).
  const leaks = result.leakDiagnostics || {};
  if (Number.isFinite(leaks.openingArms) && leaks.openingArms !== 0) {
    problems.push(`${leaks.openingArms} öppningsarmar kvar efter efterspel`);
  }
  if (e.zeroOpeningWarnings && openings.length > 0) {
    problems.push(`oväntade öppningsvarningar: ${openings.map((w) => `${w.bridge}@${w.iso}`).join(',')}`);
  }
  if (e.forbiddenOpeningBridges) {
    const warned = new Set(openings.map((w) => w.bridge));
    for (const bridge of e.forbiddenOpeningBridges) {
      if (warned.has(bridge)) {
        const w = openings.find((x) => x.bridge === bridge);
        problems.push(`FÖRBJUDEN ÖPPNINGSVARNING för ${bridge} (${w.iso}, ledande ${w.leadVessel}, d=${w.distance} m, ${w.firedBy})`);
      }
    }
  }
  if (e.expectedOpenings) {
    for (const bridge of e.expectedOpenings) {
      const forBridge = openings.filter((w) => w.bridge === bridge);
      if (forBridge.length === 0) {
        problems.push(`SAKNAD ÖPPNINGSVARNING för ${bridge}`);
        continue;
      }
      // En varning EFTER passagen är värdelös — kravet är förvarning.
      const firstPassage = passages
        .filter((p) => p.bridge === bridge)
        .reduce((min, p) => (min === null || p.t < min ? p.t : min), null);
      if (firstPassage !== null && !forBridge.some((w) => Number.isFinite(w.t) && w.t < firstPassage)) {
        problems.push(`ÖPPNINGSVARNING FÖR SENT för ${bridge}: alla varningar ligger EFTER passagen ${new Date(firstPassage).toISOString()}`);
      }
    }
  }
  if (e.maxOpeningsPerBridge) {
    const counts = {};
    for (const w of openings) counts[w.bridge] = (counts[w.bridge] || 0) + 1;
    for (const [bridge, maxN] of Object.entries(e.maxOpeningsPerBridge)) {
      if ((counts[bridge] || 0) > maxN) {
        problems.push(`ÖPPNINGSDUBBLETT: ${bridge} fick ${counts[bridge]} varningar (max ${maxN})`);
      }
    }
  }
  // U15 (K2, 2026-11-04): VARJE passage av bron ska ha en varning efter
  // båtens förra passage av samma bro och före den här. expectedOpenings
  // prövar bara den första passagen och ser därför inte en ovarnad retur.
  // Varningen måste TÄCKA just den båten (granskningen 2026-11-04): hon är
  // medlem eller ledare i varningen, eller absorberades i dess händelse
  // (openingCoverage) efter förra passagen och före den här. Annars hade en
  // annan båts varning vid samma bro räckt i ett scenario med flera båtar.
  if (e.openingBeforeEachPassage) {
    const coverage = result.openingCoverage || [];
    for (const bridge of e.openingBeforeEachPassage) {
      const forBridge = openings.filter((w) => w.bridge === bridge && Number.isFinite(w.t));
      const own = passages.filter((p) => p.bridge === bridge).sort((a, b) => a.t - b.t);
      own.forEach((p, i) => {
        const mmsi = String(p.mmsi);
        const prev = own.slice(0, i).filter((q) => String(q.mmsi) === mmsi).pop();
        const after = prev ? prev.t : -Infinity;
        const covers = (w) => (w.mmsis || []).map(String).includes(mmsi) || String(w.leadMmsi) === mmsi
          || coverage.some((c) => c.bridge === bridge && String(c.mmsi) === mmsi && c.eventId === w.eventId
            && c.t > after && c.t < p.t);
        if (!forBridge.some((w) => w.t > after && w.t < p.t && covers(w))) {
          problems.push(`OVARNAD PASSAGE av ${bridge} ${new Date(p.t).toISOString()} (${p.mmsi}): ingen varning `
            + `som täcker båten ${prev ? `efter förra passagen ${new Date(prev.t).toISOString()} och ` : ''}före passagen`);
        }
      });
    }
  }
  // Varv 2 (familj A): ledtiden mot den SANNA korsningen. En varning täcker
  // båten när hon är medlem eller ledare i den, eller när hon absorberades i
  // dess händelse (openingCoverage); i det senare fallet räknas ledtiden från
  // absorptionen. Både varningen och täckningen ska ligga efter båtens förra
  // sanna korsning av bron, så att utresans varning inte räknas för returen.
  if (e.openingLeadS) {
    const coverage = result.openingCoverage || [];
    for (const [bridge, minLeadS] of Object.entries(e.openingLeadS)) {
      const sBridge = METRICS.cum[PATH_INDEX[bridge]];
      for (const [mmsi, truthPath] of Object.entries(truthPaths || {})) {
        let previousMs = -Infinity;
        for (const c of truthCrossings(truthPath, sBridge)) {
          const crossingMs = BASE_TIME_MS + c.tS * 1000;
          const coveredAt = (w) => {
            if ((w.mmsis || []).map(String).includes(mmsi) || String(w.leadMmsi) === mmsi) return w.t;
            const cov = coverage.find((x) => x.bridge === bridge && String(x.mmsi) === mmsi
              && x.eventId === w.eventId && x.t > previousMs && x.t < crossingMs);
            return cov ? Math.max(w.t, cov.t) : null;
          };
          const leads = openings
            .filter((w) => w.bridge === bridge && Number.isFinite(w.t) && w.t > previousMs && w.t < crossingMs)
            .map(coveredAt)
            .filter((t) => Number.isFinite(t))
            .map((t) => (crossingMs - t) / 1000);
          const best = leads.length ? Math.max(...leads) : null;
          if (best === null || best < minLeadS) {
            problems.push(`KORT LEDTID vid ${bridge} ${new Date(crossingMs).toISOString()} (${mmsi}, ${c.dir}): `
              + `${best === null ? 'ingen täckande varning' : `bästa varningen ${Math.round(best)} s`} före den sanna `
              + `korsningen (krav ≥ ${minLeadS} s)`);
          }
          previousMs = crossingMs;
        }
      }
    }
  }
  if (e.deadlineFiredOpenings) {
    for (const bridge of e.deadlineFiredOpenings) {
      const forBridge = openings.filter((w) => w.bridge === bridge);
      if (!forBridge.some((w) => w.firedBy === 'deadline')) {
        problems.push(`ÄGGKLOCKAN TYST för ${bridge}: `
          + `${forBridge.length ? forBridge.map((w) => `${w.iso}/${w.firedBy}`).join(', ') : 'ingen varning alls'} `
          + '— ingen varning kom ur tick-motorn');
      }
    }
  }

  // B1-kontrakt (2026-07-03): token-fallbacken är "Okänd båt" — den råa
  // aisstream-platshållaren "Unknown" får ALDRIG nå en notis.
  if (e.noUnknownTokens) {
    const raw = notifications.filter((n) => n.name === 'Unknown');
    if (raw.length > 0) problems.push(`"Unknown" läckte till ${raw.length} notistokens`);
    // B1 GÄLLER ALLA KORT (etapp 6-granskningen): kontraktet inspekterade bara
    // boat_near, så det nya kortets vessel_name var helt undantaget — och det
    // levererade den råa aisstream-platshållaren "Unknown" i skarpa korpusar.
    const rawOpen = (result.openingWarnings || []).filter((w) => w.leadVessel === 'Unknown');
    if (rawOpen.length > 0) {
      problems.push(`"Unknown" läckte till ${rawOpen.length} öppningsvarningars vessel_name`);
    }
  }
  // B1-namnbackfill: notiser EFTER given scenariosekund ska bära riktigt namn.
  if (e.namedNoticesAfterS != null && Number.isFinite(result.firstSampleMs)) {
    const cutoverMs = result.firstSampleMs + e.namedNoticesAfterS * 1000;
    const placeholders = notifications.filter(
      (n) => Number.isFinite(n.t) && n.t >= cutoverMs && (n.name === 'Okänd båt' || n.name === 'Unknown'),
    );
    if (placeholders.length > 0) {
      problems.push(`${placeholders.length} notiser efter namnbackfill saknar riktigt namn`);
    }
  }

  const tolerated = Array.isArray(e.toleratedInvariants) ? e.toleratedInvariants : [];
  const invariantViolations = validateInvariants(result).filter((v) => !tolerated.some((re) => re.test(v)));
  for (const v of invariantViolations.slice(0, 4)) problems.push(`INVARIANT: ${v}`);
  if (invariantViolations.length > 4) problems.push(`... +${invariantViolations.length - 4} fler invariantbrott`);

  return problems;
}

let failed = false;
console.log('\n=== SYNTETISK SCENARIOSVIT ===');
console.log(`${SCENARIOS.length} scenarier (seedade, deterministiska)\n`);

for (const scenario of SCENARIOS) {
  let outcome;
  try {
    const { result, sampleCount, truthPaths } = runScenario(scenario);
    const problems = checkExpectations(scenario, result, truthPaths);
    // WARN-invarianter (fas 0.4, 2026-07-03): informativa, fäller inte.
    const warns = validateWarnInvariants(result);
    if (warns.length > 0) {
      console.log(`  ⚠️ ${scenario.name}: ${warns.length} WARN — ${warns.slice(0, 2).join('; ')}${warns.length > 2 ? ' …' : ''}`);
    }
    if (problems.length === 0) {
      outcome = `✅ ${scenario.name.padEnd(38)} samples=${sampleCount}, `
        + `passager=${(result.targetPassages || []).length}, notiser=${result.notificationCount}, `
        + `öppningar=${result.openingWarningCount ?? 0}`;
    } else {
      failed = true;
      outcome = `❌ ${scenario.name.padEnd(38)} ${problems.join('; ')}`;
    }
  } catch (err) {
    failed = true;
    outcome = `💥 ${scenario.name.padEnd(38)} ${err.message.slice(0, 120)}`;
  }
  console.log(`  ${outcome}`);
}

console.log('');
if (failed) {
  console.log('❌ MINST ETT SYNTETISKT SCENARIO BRYTER MOT FÖRVÄNTNINGAR/INVARIANTER.');
  process.exit(1);
}
console.log('✅ Alla syntetiska scenarier rena.');
process.exit(0);
