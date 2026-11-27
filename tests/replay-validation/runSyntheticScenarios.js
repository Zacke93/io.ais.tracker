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
const { MOORING_ZONES, TRIGGER_POINTS, BRIDGES } = require('../../lib/constants');

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
// U46: ruttens närmaste punkt till Kanalinfarten (112 m öster om punkten).
// Söder därom ligger den yttre sidan; 300 m söderut är 310 m från punkten.
const S_KANALINFARTEN = 885;
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

// ---------------------------------------------------------------------------
// U52 (dirigentens beslut 2026-11-23): NY RESA EFTER LÅNG FÖRTÖJNING
// ---------------------------------------------------------------------------
// En båt som legat förtöjd minst 2 h börjar en ny resa när hon lägger ut; den
// förra resans passerade broar, riktning och slutmål ska inte styra notiser,
// varningar och texter. Fältfallen (fältprov 2): en lotsbåt låg 69 h vid kajen
// utanför Kanalinfarten med Olidebron kvar som passerad från resan tre dagar
// tidigare, och notisen vid Olidebron uteblev när hon lade ut norrut; en annan
// dag fick avgångsnotisen vid Kanalinfarten riktningen söderut (ruttlåset från
// ankomsten) fast hon gick norrut. Positionerna nedan är egna; bara förloppen
// är fältets. Motfallen låser det som ska stå kvar: broar BAKOM förtöjnings-
// platsen förblir passerade (ingen ny notis för en bro båten nyss passerat).
const S_OLIDEBRON = METRICS.cum[1];
const S_KLAFFBRON = METRICS.cum[2];
const S_STRIDSBERG = METRICS.cum[4];
const S_STALLBACKA = METRICS.cum[5];
const U52_SCENARIOS = [
  // Fältets 23/11-förlopp: resan söderut börjar vid en kaj mellan Olidebron och
  // Klaffbron (ingen målbro söderut, alltså inget slutmål), passerar Olidebron
  // och Kanalinfarten, förtöjd 7 h på den yttre sidan, sedan norrut genom
  // kanalen. Olidebron ska notifieras även på den nya resan. Längden spelar
  // roll: efter 6 h gallras besöksposten för Olidebron, och då släpper ingen
  // återkomst notisnyckeln; kvar står bara spärren för en passerad bro.
  {
    name: 'ny-resa-efter-7h-förtöjning-Olidebron-kvar-från-förra-resan (U52)',
    seed: 75201,
    vessels: [{
      mmsi: '975201001',
      name: 'SYNT-U52-OLIDE',
      startS: S_OLIDEBRON + 600,
      legs: [
        {
          stopS: 20 * 60, stopIntervalS: 60, stopSog: 0, stopCogDeg: 200,
        },
        { toS: S_KANALINFARTEN - 150, speedKn: 7, intervalS: 60 },
        {
          stopS: 7 * 3600, stopIntervalS: 60, stopSog: 0, stopCogDeg: 172,
        },
        { toS: S_KLAFFBRON + 600, speedKn: 6.5, intervalS: 60 },
      ],
    }],
    expect: {
      minNotifiedPerBridge: { Olidebron: 2 },
      maxNotifiedPerBridge: { Olidebron: 2, Klaffbron: 1 },
      minNotifiedBridges: ['Klaffbron'],
    },
  },
  // Samma förlopp med en omstart av appen mitt i förtöjningen. Efter omstarten
  // skapas båten på nytt utan resebokföring; U51:s förtöjningsbelägg sparas.
  {
    name: 'ny-resa-efter-7h-förtöjning-omstart-mitt-i (U52)',
    seed: 75202,
    vessels: [{
      mmsi: '975202001',
      name: 'SYNT-U52-OMSTART',
      startS: S_OLIDEBRON + 600,
      legs: [
        {
          stopS: 20 * 60, stopIntervalS: 60, stopSog: 0, stopCogDeg: 200,
        },
        { toS: S_KANALINFARTEN - 150, speedKn: 7, intervalS: 60 },
        {
          stopS: 7 * 3600, stopIntervalS: 60, stopSog: 0, stopCogDeg: 172,
        },
        { toS: S_KLAFFBRON + 600, speedKn: 6.5, intervalS: 60 },
      ],
    }],
    events: [{ ctrl: 'restart', atOffsetS: 20 * 60 + 400 + 4 * 3600 }],
    expect: {
      minNotifiedPerBridge: { Olidebron: 2 },
      maxNotifiedPerBridge: { Olidebron: 2, Klaffbron: 1, Kanalinfarten: 2 },
      minNotifiedBridges: ['Klaffbron'],
    },
  },
  // Fältets 19/11-förlopp: hel resa söderut (slutmål söderut), förtöjd 3 h på
  // den yttre sidan av Kanalinfarten, lägger ut med en fix i kurs 94° (ut från
  // kajen) och sedan norrut. Avgångsnotisen kommer på första fixen med nordlig
  // kurs, där den gamla resans ruttlås och slutmål styrde riktningen.
  {
    name: 'ny-resa-efter-3h-förtöjning-avgångsnotisens-riktning (U52)',
    seed: 75203,
    vessels: [{
      mmsi: '975203001',
      name: 'SYNT-U52-RIKTNING',
      startS: S_KLAFFBRON + 700,
      legs: [
        {
          stopS: 20 * 60, stopIntervalS: 60, stopSog: 0, stopCogDeg: 200,
        },
        { toS: S_KANALINFARTEN - 150, speedKn: 7, intervalS: 60 },
        {
          stopS: 3 * 3600, stopIntervalS: 60, stopSog: 0, stopCogDeg: 172,
        },
        // Första fixen i fart ligger kvar vid kajen med kurs ut från den (94°);
        // nästa fix, förbi linjen, har nordlig kurs.
        {
          toS: S_KANALINFARTEN + 50, speedKn: 6.5, cogDeg: 94, intervalS: 60,
        },
        { toS: S_KLAFFBRON + 700, speedKn: 6.5, intervalS: 60 },
      ],
    }],
    expect: {
      noticeDirectionVsTruth: { Kanalinfarten: { mismatches: 0 } },
      minNotifiedPerBridge: { Olidebron: 2, Klaffbron: 2 },
      maxNotifiedPerBridge: { Olidebron: 2, Klaffbron: 2 },
    },
  },
  // Motfall: förtöjd 3 h i Gästhamnen mitt i en resa norrut och fortsätter
  // norrut. Klaffbron och Olidebron ligger bakom förtöjningsplatsen och förblir
  // passerade: ingen ny notis och ingen ny öppningsvarning för Klaffbron.
  {
    name: 'förtöjd-3h-i-Gästhamnen-fortsätter-norrut (U52, motfall)',
    seed: 75204,
    vessels: [{
      mmsi: '975204001',
      name: 'SYNT-U52-GAST-N',
      startS: S_OLIDEBRON - 400,
      legs: [
        { toS: S_KLAFFBRON + 380, speedKn: 6, intervalS: 60 },
        {
          stopS: 3 * 3600, stopIntervalS: 60, stopSog: 0, stopCogDeg: 30, lateralM: 35,
        },
        { toS: S_STRIDSBERG + 800, speedKn: 6, intervalS: 60 },
      ],
    }],
    expect: {
      maxNotifiedPerBridge: { Olidebron: 1, Klaffbron: 1, Stridsbergsbron: 1 },
      minNotifiedBridges: ['Järnvägsbron', 'Stridsbergsbron'],
      expectedOpenings: ['Stridsbergsbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
    },
  },
  // Förtöjd 3 h i Gästhamnen efter en resa norrut genom Klaffbron, går sedan
  // tillbaka söderut: Klaffbron och Olidebron ligger framför förtöjnings-
  // platsen i den nya riktningen och ska notifieras och varnas på nytt.
  {
    name: 'förtöjd-3h-i-Gästhamnen-tillbaka-söderut (U52)',
    seed: 75205,
    vessels: [{
      mmsi: '975205001',
      name: 'SYNT-U52-GAST-S',
      startS: S_OLIDEBRON - 400,
      legs: [
        { toS: S_KLAFFBRON + 380, speedKn: 6, intervalS: 60 },
        {
          stopS: 3 * 3600, stopIntervalS: 60, stopSog: 0, stopCogDeg: 30, lateralM: 35,
        },
        { toS: S_KANALINFARTEN - 150, speedKn: 6, intervalS: 60 },
      ],
    }],
    expect: {
      minNotifiedPerBridge: { Olidebron: 2, Klaffbron: 2 },
      maxNotifiedPerBridge: { Olidebron: 2, Klaffbron: 2 },
      noticeDirectionVsTruth: { Klaffbron: { mismatches: 0 }, Olidebron: { mismatches: 0 } },
      // Varningen före returpassagen kommer (i dag ingen alls), men bara några
      // sekunder före korsningen: avgången bekräftas på andra fixen, 165 m från
      // bron, och kajgrinden beväpnar först fixen därpå. En båt som syns första
      // gången i Gästhamnen får målbron redan på första fixen. Känd gräns (U52).
      expectedOpenings: ['Klaffbron'],
      maxOpeningsPerBridge: { Klaffbron: 2 },
    },
  },
  // Samma retur, men första fixen i fart går norrut (ut från kajen) och får
  // målbron Stridsbergsbron; sedan söderut. Målbron från fönstret ska släppas
  // när avgången söderut är belagd, så att texten inte säger "på väg mot
  // Stridsbergsbron" för en båt på väg söderut genom Klaffbron.
  {
    name: 'förtöjd-3h-i-Gästhamnen-en-fix-norrut-sedan-söderut (U52)',
    seed: 75208,
    vessels: [{
      mmsi: '975208001',
      name: 'SYNT-U52-GAST-NS',
      startS: S_OLIDEBRON - 400,
      legs: [
        { toS: S_KLAFFBRON + 380, speedKn: 6, intervalS: 60 },
        {
          stopS: 3 * 3600, stopIntervalS: 60, stopSog: 0, stopCogDeg: 30, lateralM: 35,
        },
        { toS: S_KLAFFBRON + 470, speedKn: 3, intervalS: 60 },
        { toS: S_KANALINFARTEN - 150, speedKn: 6, intervalS: 60 },
      ],
    }],
    expect: {
      minNotifiedPerBridge: { Olidebron: 2, Klaffbron: 2 },
      maxNotifiedPerBridge: { Olidebron: 2, Klaffbron: 2, Stridsbergsbron: 0 },
      noticeDirectionVsTruth: { Klaffbron: { mismatches: 0 } },
      forbiddenOpeningBridges: ['Stridsbergsbron'],
      expectedOpenings: ['Klaffbron'],
    },
  },
  // Motfall: förtöjd 7 h vid Kajen norr om Klaffbron (inom 300 m från bron;
  // efter 6 h är besöksposten för Klaffbron gallrad), lägger ut med EN fix
  // 60 m söderut i 2,5 kn ut från kajen (så att förtöjningen släpper) och går
  // sedan norrut. Klaffbron ligger bakom: ingen ny notis och ingen ny varning
  // för den. Låser tvåfixkravet (granskningen, anm. 4): med en fix räcker
  // bekräftas en resa söderut och Klaffbron varnas.
  {
    name: 'förtöjd-7h-vid-Kajen-norr-om-Klaffbron-en-fix-söderut-sedan-norrut (U52, motfall)',
    seed: 75206,
    vessels: [{
      mmsi: '975206001',
      name: 'SYNT-U52-KAJ-N',
      startS: S_OLIDEBRON - 400,
      legs: [
        { toS: S_KLAFFBRON + 200, speedKn: 6, intervalS: 60 },
        {
          stopS: 7 * 3600, stopIntervalS: 60, stopSog: 0, stopCogDeg: 30,
        },
        { toS: S_STRIDSBERG + 800, speedKn: 6, intervalS: 60 },
      ],
    }],
    patchSamples: (samples) => {
      const still = samples.filter((r) => r.mmsi === '975206001' && r.sog < 0.5);
      const r = still[still.length - 1];
      r.sog = 2.5;
      r.cog = 200;
      r.lat -= 60 / 111320;
    },
    expect: {
      maxNotifiedPerBridge: { Olidebron: 1, Klaffbron: 1, Stridsbergsbron: 1 },
      minNotifiedBridges: ['Stridsbergsbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
    },
  },
  // Motfall (#44-klassen, PILOT-resume): parkerad 7 h 250 m bortom
  // Stallbackabron efter passagen norrut, fortsätter norrut bort från bron.
  {
    name: 'parkerad-7h-bortom-Stallbackabron-fortsätter-norrut (U52, motfall)',
    seed: 75207,
    vessels: [{
      mmsi: '975207001',
      name: 'SYNT-U52-STALL',
      startS: S_STRIDSBERG + 400,
      legs: [
        { toS: S_STALLBACKA + 250, speedKn: 6, intervalS: 60 },
        {
          stopS: 7 * 3600, stopIntervalS: 60, stopSog: 0, stopCogDeg: 30,
        },
        { toS: METRICS.total, speedKn: 6, intervalS: 60 },
      ],
    }],
    expect: { maxNotifiedPerBridge: { Stallbackabron: 1 } },
  },
  // Granskningen R-A3: retur söderut efter 3 h 400 m norr om Stridsbergsbron,
  // avgången 2,3 kn → 1,5 kn → 5 kn. Den långsamma fixen mitt i avgången får
  // inte nolla den väntande riktningen (NEW_JOURNEY gör det inte); annars kom
  // bekräftelsen och öppningsvarningen en fix senare än före U52.
  {
    name: 'förtöjd-3h-norr-om-Stridsbergsbron-retur-med-långsam-fix (U52, R-A3)',
    seed: 75209,
    vessels: [{
      mmsi: '975209001',
      name: 'SYNT-U52-STRIDS-RET',
      startS: S_KLAFFBRON - 300,
      legs: [
        { toS: S_STRIDSBERG + 400, speedKn: 6, intervalS: 60 },
        {
          stopS: 3 * 3600, stopIntervalS: 60, stopSog: 0, stopCogDeg: 30,
        },
        { toS: S_STRIDSBERG + 340, speedKn: 2.3, intervalS: 60 },
        { toS: S_STRIDSBERG + 300, speedKn: 1.5, intervalS: 60 },
        { toS: S_KLAFFBRON - 600, speedKn: 5, intervalS: 60 },
      ],
    }],
    // Före U52 (och med R-A3) kommer varningen söderut cirka 2 min före
    // korsningen; utan R-A3 en fix senare, under 1 min före.
    expect: { openingLeadS: { Stridsbergsbron: 90 } },
  },
  // Granskningen, anm. 4: förtöjd 4 h i Gästhamnen, en ensam brusposition
  // (70 m söderut, 3 kn, kurs 200°), tillbaka, sedan norrut. Ingen ny resa
  // söderut: ingen varning och ingen text för Klaffbron under stoppet.
  {
    name: 'förtöjd-4h-i-Gästhamnen-ensam-brusposition (U52, motfall)',
    seed: 75210,
    vessels: [{
      mmsi: '975210001',
      name: 'SYNT-U52-GAST-BRUS',
      startS: S_OLIDEBRON - 400,
      legs: [
        { toS: S_KLAFFBRON + 380, speedKn: 6, intervalS: 60 },
        {
          stopS: 4 * 3600, stopIntervalS: 60, stopSog: 0, stopCogDeg: 30, lateralM: 35,
        },
        { toS: S_STRIDSBERG + 800, speedKn: 6, intervalS: 60 },
      ],
    }],
    patchSamples: (samples) => {
      const still = samples.filter((r) => r.mmsi === '975210001' && r.sog < 0.5);
      const r = still[200];
      r.sog = 3;
      r.cog = 200;
      r.lat -= 70 / 111320;
    },
    expect: {
      maxOpeningsPerBridge: { Klaffbron: 1 },
      maxNotifiedPerBridge: { Klaffbron: 1 },
      textCountWindows: [{
        bridge: 'Klaffbron', fromS: 12600, toS: 15000, max: 0,
      }],
    },
  },
  // 15-minutersgränsen för den väntande riktningen (som NEW_JOURNEY): förtöjd
  // 3 h 400 m norr om Stridsbergsbron (ingen kajzon), en brusposition 60 m
  // söderut i 2,5 kn, stilla en timme utan ny förtöjningsklassning, en ny
  // brusposition söderut, sedan norrut ut ur kanalen. Två fixar en timme isär
  // är inte en avgång: ingen ny resa söderut, ingen varning för
  // Stridsbergsbron.
  {
    name: 'förtöjd-3h-norr-om-Stridsbergsbron-två-bruspositioner-en-timme-isär (U52, motfall)',
    seed: 75211,
    vessels: [{
      mmsi: '975211001',
      name: 'SYNT-U52-BRUS-TIMME',
      startS: S_KLAFFBRON - 300,
      legs: [
        { toS: S_STRIDSBERG + 400, speedKn: 6, intervalS: 60 },
        {
          stopS: 5 * 3600, stopIntervalS: 60, stopSog: 0, stopCogDeg: 30,
        },
        { toS: S_STALLBACKA + 600, speedKn: 6, intervalS: 60 },
      ],
    }],
    patchSamples: (samples) => {
      const still = samples.filter((r) => r.mmsi === '975211001' && r.sog < 0.5);
      for (const k of [190, 250]) {
        const r = still[k];
        r.sog = 2.5;
        r.cog = 205;
        r.lat -= 60 / 111320;
      }
    },
    expect: { maxOpeningsPerBridge: { Stridsbergsbron: 1 }, maxNotifiedPerBridge: { Stridsbergsbron: 1 } },
  },
];

// ---------------------------------------------------------------------------
// U70 (dirigentens beslut 2026-11-27): FELEN NÄR EN ENDA KÄLLA BÄR TRAFIKEN
// ---------------------------------------------------------------------------
// Kända gränser, inga rättningar (docs/ARCHITECTURE.md §bridge_opening_soon,
// "Känd gräns: en enda källa bär trafiken", och §Gate-kedjan). Fältkörningarna
// k1–k4 spelades upp med bara AISHub och bara AISstream; scenarierna nedan
// bygger förloppen med egna positioner och låser dagens utfall, så att en
// ändring syns. Talen i kommentarerna är uppmätta i dagens träd.
const S_JARNVAG = METRICS.cum[3];
const U70_SCENARIOS = [
  // H1: en båt ligger 3 h 460 m norr om Stridsbergsbron och lägger ut söderut i
  // AISHub-takt (var 67:e s, fixen 36 s gamla). U52 tömmer historiken, så
  // Klaffbron beväpnas utan spärr vid Järnvägsbron, och 10-knopsdeadlinen löper
  // ut före nästa fix. Hon väntar sedan 17 min vid Järnvägsbron. Varningen för
  // Klaffbron kommer därför långt före passagen (fältet: PRICKBJORN 12/11, 26,5
  // min). Prövat och avstått: vändningsmärket vid U52-avgången (P2) varnade en
  // tyst avgång i 9–10 kn bara 36–66 s före passagen.
  {
    name: 'förtöjd-3h-norr-om-Stridsbergsbron-lägger-ut-i-AISHub-takt-väntar-vid-Järnvägsbron (känd gräns, U70)',
    seed: 77001,
    vessels: [{
      mmsi: '977001001',
      name: 'SYNT-U70-H1',
      startS: S_STRIDSBERG + 460,
      legs: [
        {
          stopS: 3 * 3600, stopIntervalS: 180, stopSog: 0, stopCogDeg: 200, fixLagS: 36,
        },
        {
          toS: S_STRIDSBERG + 160,
          speedKn: 2.5,
          intervalS: 67,
          fixLagS: 36,
          gapFromS: S_STRIDSBERG + 170,
          gapToS: S_STRIDSBERG + 459,
        },
        {
          toS: S_JARNVAG + 75, speedKn: 2.0, intervalS: 67, fixLagS: 36,
        },
        {
          stopS: 17 * 60, stopIntervalS: 67, stopSog: 0.1, stopCogDeg: 220, fixLagS: 36,
        },
        {
          toS: S_KLAFFBRON - 600, speedKn: 5, intervalS: 67, fixLagS: 36,
        },
      ],
    }],
    // I dag: Stridsbergsbron på fixet 164 m före bron, Klaffbron på deadlinen
    // 52 s efter att fixet kom, 1 382 m bort (eta 20), cirka 29 min före korsningen.
    // Kravet låser att varningen kommer minst 20 min före. Blir scenariot rött
    // har mekanismen ändrats: pröva då P2:s motfall (ARCHITECTURE) och lås om
    // medvetet, inte genom att sänka kravet.
    expect: { openingLeadS: { Klaffbron: 1200, Stridsbergsbron: 90 } },
  },
  // T2: norrut i 4 kn med en position var 330:e s (AISstreams glapp) och 25 min
  // väntan vid Järnvägsbron. Spärren vid den tidigare bron släpps 300 s efter
  // sista fixet, och varningen för Stridsbergsbron går med "ETA okänd" medan
  // hon ännu är söder om Klaffbron (fältet: VISTEN 21/11, 33,1 min före).
  {
    name: 'norrut-4kn-fix-var-330s-väntar-25min-vid-Järnvägsbron-reservsläpp (känd gräns, U70)',
    seed: 77002,
    vessels: [{
      mmsi: '977002001',
      name: 'SYNT-U70-T2',
      startS: S_OLIDEBRON - 800,
      legs: [
        { toS: S_JARNVAG - 80, speedKn: 4, intervalS: 330 },
        {
          stopS: 25 * 60, stopIntervalS: 330, stopSog: 0.1, stopCogDeg: 30,
        },
        { toS: S_STRIDSBERG + 700, speedKn: 4, intervalS: 330 },
      ],
    }],
    // I dag: Klaffbron på 10-knopsdeadlinen 2 165 m bort, cirka 18 min före;
    // Stridsbergsbron på reservsläppet med "ETA okänd" 2 017 m bort, cirka 44 min
    // före korsningen. Kravet låser minst 20 min för Stridsbergsbron.
    expect: { openingLeadS: { Stridsbergsbron: 1200, Klaffbron: 60 } },
  },
  // T3 (U38): norrut i 6,6 kn mot Klaffbron, sedan stilla 700 m söder om bron i
  // 40 min med en position var 570:e s. Reservsläppet för en stilla båt ger en
  // varning för Stridsbergsbron fast hon ligger kvar (fältet: PRICKBJORN 20/11).
  // Prövat och avstått: 600 s i stället för 300 s (P1) varnade en båt som gick
  // under tystnaden efter passagen.
  {
    name: 'norrut-mot-Klaffbron-stannar-700m-före-fix-var-570s-reservsläpp-utan-passage (känd gräns, U70)',
    seed: 77003,
    vessels: [{
      mmsi: '977003001',
      name: 'SYNT-U70-T3',
      startS: S_OLIDEBRON - 600,
      legs: [
        { toS: S_KLAFFBRON - 700, speedKn: 6.6, intervalS: 120 },
        {
          stopS: 40 * 60, stopIntervalS: 570, stopSog: 0, stopCogDeg: 20,
        },
      ],
    }],
    // I dag: Klaffbron på deadlinen medan hon går (samma avbrutna anflygning som
    // med båda källorna), Stridsbergsbron på reservsläppet 1 915 m bort när hon
    // legat stilla i 5 min utan ny position. Ingen bro korsas.
    expect: {
      expectedOpenings: ['Klaffbron', 'Stridsbergsbron'],
      maxPassagesPerBridge: { Klaffbron: 0, Stridsbergsbron: 0 },
    },
  },
  // U81 (dirigentens beslut 2026-11-27, spår P omgång 10): reservsläppets andra
  // sida. En båt söderut ligger stilla 220 m norr om Stridsbergsbron (hörs var
  // 3:e minut, i bekräftad kö), lägger ut i samma ögonblick som sista
  // positionen i 6 kn och hörs inte förrän söder om Klaffbron; hon korsar
  // Klaffbron 468 s efter sista positionen (inspelat: DIANA 3/7 i sommarbanken,
  // med bara AISstream, 470 s). Med dagens 300 s kommer reservvarningen för
  // Klaffbron 168 s före korsningen. Mätt med spår P:s prototyper: spärren för
  // en stilla båt 420 s ger 48 s, dubbla mottagningsintervallet 108 s, 600 s
  // och "håll en båt i kö vid den andra målbron" ingen varning före korsningen.
  {
    name: 'söderut-stilla-220m-norr-om-Stridsbergsbron-tyst-avgång-6kn-genom-tre-broar (U81)',
    seed: 77005,
    vessels: [{
      mmsi: '977005001',
      name: 'SYNT-U81',
      startS: S_STRIDSBERG + 1800,
      legs: [
        { toS: S_STRIDSBERG + 220, speedKn: 5.5, intervalS: 60 },
        {
          stopS: 9 * 60, stopIntervalS: 180, stopSog: 0, stopCogDeg: 210,
        },
        // Sista stilla positionen i samma ögonblick som hon lägger ut.
        {
          stopS: 1, stopIntervalS: 1, stopSog: 0, stopCogDeg: 210,
        },
        {
          toS: S_KLAFFBRON - 600,
          speedKn: 6,
          intervalS: 60,
          gapFromS: S_STRIDSBERG + 220,
          gapToS: S_KLAFFBRON - 250,
        },
      ],
    }],
    // I dag: Klaffbronvarningen på reservsläppet ("ETA okänd") 300 s efter sista
    // positionen, 168 s före korsningen. Kravet: minst 120 s före. Blir
    // scenariot rött har reservsläppet för en stilla båt skjutits upp; det är
    // prövat och förkastat (U81, docs/ARCHITECTURE.md §bridge_opening_soon).
    expect: { openingLeadS: { Klaffbron: 120 } },
  },
  // N1: norrut i 6 kn genom kanalen och ut förbi Stallbackabron; AISstream hör
  // henne sista gången 600 m före bron (fältet: NORDIC SOLA och NAVEN, som
  // lämnade området norrut). Utan position i zonen kommer ingen närmar-notis,
  // och utan position bortom bron ingen passagenotis. (Ett glapp som slutar
  // bortom bron ger i stället "passerade … under AIS-tystnad" även 6 min efter
  // korsningen; det är prövat och ingår inte här.)
  {
    name: 'norrut-6kn-hörs-sista-gången-600m-före-Stallbackabron (känd gräns, U70)',
    seed: 77004,
    vessels: [{
      mmsi: '977004001',
      name: 'SYNT-U70-N1',
      startS: 200,
      legs: [{ toS: S_STALLBACKA - 600, speedKn: 6, intervalS: 60 }],
    }],
    expect: {
      minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron'],
      maxNotifiedPerBridge: { Stallbackabron: 0 },
    },
  },
];

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
 *  - approachNoticeLeadS: {bro: N} — en förvarning (already_passed=false) för
 *    varje sann korsning av bron, minst N s före korsningen (familj C, C2)
 *  - noApproachNoticeAfterCrossing: [bro] — ingen förvarning för bron mellan
 *    en sann korsning och nästa (en passerad bro får bara passerad form)
 *  - maxNoticeDelayS: {bro: N} — för varje sann korsning av bron ska båtens
 *    första notis för bron (vilken form som helst) komma senast N s efter
 *    korsningen (familj C3: ingen notis via failsafen minuter senare)
 *  - noticeDirectionVsTruth: {bro: {mismatches: N}} — exakt N av båtens notiser
 *    vid bron har ett riktningsfält som motsäger den sanna färden under steget
 *    före notisen (nattjakten F12; minst en notis måste prövas)
 *  - noticeForms: {bro: [form, …]} — notisernas form för bron i tidsordning:
 *    'närmar', 'precis' ("har precis passerat"), 'tyst' ("passerade … under
 *    AIS-tystnad") eller 'annan' (U37 del 2, formregeln)
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
 *  - minOpeningLeadS: {bro: S} — ingen varning för bron får komma under S s
 *    före båtens SANNA korsning (ur scenariots egna sampel). U23: ingen ny,
 *    sen varning när en köare lägger ut från kajen.
 *  - noDefaultWhileStopped: true — texten får aldrig vara "Inga båtar …"
 *    medan en båt ligger i sitt stopp (första till sista stillasamplet). U23
 *    och D1: en väntande båt nära målbron står kvar i texten.
 *  - textCountWindows: [{bridge, fromS, toS, min?, max?}] — under fönstret
 *    (sekunder från scenariots bastid) ska antalet båtar som texten räknar
 *    mot bron ligga inom [min, max]: texten som gäller vid fromS och varje
 *    övergång fram till toS. Antalet är summan av räkneorden i de klausuler
 *    som nämner "mot <bro>". Familj D (k1): antalet ska följa verkligheten.
 *    OBS: texten bär ingen identitet, så förväntan räknar båtar, inte vilka;
 *    ska en viss båt prövas behövs ett fönster där bara hon kan räknas.
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
 *  - ownOpeningLeadS: {bro: {mmsi: N | {minLeadS, maxAgeS}}} — EGEN VARNING
 *    (K2, nattjaktens F02 r3): båten ska vara medlem eller ledare i en
 *    levererad varning (success inte false) för bron, i hennes riktning när
 *    varningen bär en (northbound/southbound), minst minLeadS (N) s och högst
 *    maxAgeS s (standard 900) före varje sann korsning, och efter sin förra.
 *    Till skillnad från openingLeadS räknas absorption INTE: en båt som korsar
 *    mer än CONVOY_WINDOW_MS efter händelsens första korsning hör enligt U2
 *    till nästa öppning, och en absorption i den gamla händelsen är just
 *    felet. Åldersgränsen gör att medlemskap i en tidigare öppnings varning
 *    inte räknas som varning för den här korsningen (granskningen av K2).
 *    En varning med riktningen 'mixed' (mötande medlemmar, bron öppnar för
 *    båda) eller 'unknown' (ingen ledare) godtas: båten måste ändå vara
 *    medlem eller ledare.
 *
 * AVGÅNGS-ETA (fältprovet 2026-11-12, familj E; revision 1 efter
 * granskningen 2026-11-13, A5). Båda förväntningarna kräver EXAKT EN båt med
 * sann bana (`legs`) — hela brotexten tillskrivs henne, så ledarvalet i en
 * grupp prövas inte. Ett stopp är sampel under 0,5 kn och en avgång första
 * sampel ≥ 1,0 kn efter ett stopp. Texten prövas vid varje övergång och som
 * stående text var 30:e sekund; "strax" (< 3 min) prövas bara mot undre
 * gränsen. Notiser prövas inte.
 *  - departureEta: {bridge, maxOverMin, maxUnderMin, cardMaxOverMin?,
 *    cardMaxUnderMin?} — varje avgång före den
 *    sanna korsningen av bron döms: från avgången till korsningen (eller nästa
 *    avgång) får ETA-texten ligga högst maxOverMin minuter över och högst
 *    maxUnderMin minuter under den sanna restiden, och första texten efter
 *    avgången måste vara numerisk. Ingen avgång eller ingen ETA-text att döma
 *    är ett FEL, inte ett tyst godkännande. Med kortgränserna (U59) döms också
 *    varje öppningskort för bron i samma fönster, och minst ett måste finnas.
 *  - creepEta: {bridge, maxUnderMin, maxCardUnderMin} — INFORMATIV LÅSNING
 *    av en känd svaghet (kryp i kön och ny väntan, ARCHITECTURE §8 (e) "Kvar
 *    utanför klassen"). Från första avgången till den sista får ingen
 *    ETA-text vara mer än maxUnderMin och inget öppningskort för bron mer än
 *    maxCardUnderMin minuter för optimistiskt. Gränserna är dagens storlek
 *    plus marginal, inte en kvalitetsnivå.
 *  - openingNotBeforeCrossing: {bro: tidigare bro} — SPÄRREN VID EN TIDIGARE
 *    BRO (fältprovet 10–13 november, familj B). Ingen varning för bron som
 *    täcker en båt med benresa får gå innan hon på vägen dit korsat den
 *    tidigare bron (sann bana, samma riktning, efter förra korsningen av bron).
 *  STILLA BÅT UTANFÖR VÄNTZONEN (U30, 2026-11-15). Kräver EXAKT EN båt med
 *  sann bana. Ett stopp är ett intervall där den sanna banan står still
 *  (minst 60 s), oavsett rapporterad fart; avgången är när den åter rör sig. Texten prövas vid varje övergång och
 *  som stående text var 30:e sekund; bara klausuler som nämner "mot <bro>".
 *  - stillUnknown: {bridge, afterS} — från afterS sekunder in i varje stopp
 *    till stoppets sista sampel ska bron visas som "ETA okänd" (ingen frusen
 *    siffra, ingen trappa). Minst en sådan text måste finnas.
 *  - noUnknownDuringStop: {bridge, extraS, windowS?} — från stoppets början
 *    till extraS sekunder efter dess slut (eller, med windowS, till windowS
 *    sekunder efter dess början) får bron aldrig visas som "ETA okänd".
 *  - numericAfterMoveM: {bridge, moveM, graceS?} — när båten (sann bana) har
 *    flyttat sig moveM från stoppet ska bron inte längre visas som "ETA
 *    okänd" (efter graceS s, ett sampelintervall), och texten får aldrig gå
 *    direkt från "ETA okänd" till "strax".
 *  - maxFormChangesPerStop: {bridge, max} — från stoppets första sampel till
 *    3 min efter avgången (eller stoppets slut) byter brons klausul form
 *    (nedräkning, ETA okänd, vänttext, ingen) högst max gånger. Nedräkningen
 *    är siffran och "strax": att räkna ned in i strax-bandet är inget formbyte.
 *  - maxOpeningAgeS: {bro: N} — spegeln av openingLeadS (familj A, fältprovet
 *    2026-11-12): den SENASTE varningen som täcker båten före varje sann
 *    korsning får vara högst N s gammal. En varning från en anflygning timmar
 *    tidigare är ingen förvarning för korsningen. Kräver ben (sann bana) och
 *    minst en korsning per bro; prövar inte ledtiden (lägg minOpeningLeadS).
 *  NOTISEN MOT BROTEXTENS "STRAX" (U33, F20, 2026-11-16). Kräver EXAKT EN båt
 *  — texten bär ingen identitet. En förvarning är en målbronotis som inte
 *  bär passerad form; texten i ögonblicket är den senaste övergången högst
 *  1 s efter notisen (texten byggs 25 ms efter notisen på samma fix).
 *  - noticeFollowsTravelTime: [bro] — en förvarning för bron, medan texten
 *    säger "strax" för bron och båten i sin fart (avstånd/fart, farten ur
 *    båtens senaste sampel) når bron inom 3 min, säger högst restiden
 *    avrundad (minst 1). Minst en sådan förvarning ska finnas.
 *  - noticeMinEta: {bro: N} — varje förvarning för bron har eta ≥ N: en båt
 *    som i sin fart inte når bron inom 3 min behåller sin siffra (motfallet).
 *  VÄNTAN VID EN MELLANBRO (U53, 2026-11-23). Fönstren läggs på en båts SANNA
 *  bana: från första gången hon når ruttläget fromS (plus delayS sekunder) till
 *  första gången hon når toS. Texten prövas vid varje övergång och var 30:e s.
 *  (durationS i stället för toS: fönstret är så många sekunder efter fromS + delayS.)
 *  - waitTextWindows: [{mmsi, fromS, toS, delayS?, at, target?, must, count?}] —
 *    must=true: varje text i fönstret har klausulen "<antal> väntar vid <at>
 *    [på väg mot <target>]" (count: exakt antal; at = target: U65); must=false:
 *    ingen text i fönstret har en vänttext vid <at>.
 *  - textCountAlong: [{mmsi, fromS, toS, delayS?, bridge, min?, max?}] — som
 *    textCountWindows, men fönstret ligger på båtens sanna bana.
 *  - etaNotRaisedOverWait: {bridge, at} — för varje period med vänttext vid
 *    <at> mot <bridge>: första siffran för bron efter perioden är högst den
 *    sista före perioden (den dolda tiden har inte stigit under väntan). Minst
 *    en period måste kunna dömas. Kräver en ensam båt mot bron.
 *  - maxWaitToggles: {at, max} — vänttexten vid <at> kommer och går högst max
 *    gånger sammanlagt över hela körningen (flimmerprovet).
 *  RESTID ÖVER 60 MIN (U54) OCH U30 I FLER STATUSAR (U55).
 *  - etaNeverAbove: {bridge, max} — ingen text visar "om N minuter" för bron
 *    med N > max.
 *  - etaSeenAtLeast: {bridge, min} — minst en text visar "om N minuter" för
 *    bron med N ≥ min (motfallet: en sann lång restid visas).
 *  - unknownSeen: [bro] — minst en text visar "ETA okänd" för bron.
 *  RESTIDEN MOT DEN SANNA KORSNINGEN (U59, 2026-11-24).
 *  - etaTruthAlong: [{mmsi, fromS, toS?, durationS?, delayS?, bridge, maxUnderMin,
 *    maxOverMin?, cardMaxUnderMin?, cardMaxOverMin?}] — i fönstret på båtens
 *    sanna bana (som waitTextWindows) prövas brons ETA-text mot båtens nästa
 *    sanna korsning av bron, vid varje övergång och som stående text var 30:e
 *    s ("strax" bara mot undre gränsen): högst maxUnderMin minuter för låg och,
 *    med maxOverMin, högst så mycket för hög. Med kortgränserna prövas också
 *    varje öppningskort för bron i fönstret. Minst en text (och, med
 *    kortgränser, ett kort) måste kunna dömas. Kräver en ensam båt mot bron:
 *    hela texten tillskrivs henne. Med minErrMin (KÄND GRÄNS, U60 avstått)
 *    måste minst en text i fönstret ligga minst så många minuter för HÖGT:
 *    dagens fel låses, så att en regel som rättar det låses om medvetet.
 */
/**
 * U57 (2026-11-23): transit i 5,2 kn mot bron `B` i riktningen `dir` ('S'/'N'),
 * glapp 200 s från 560 m före bron (båten passerar under glappet), en stillafix
 * `D` m bortom (sog 0, kurs framåt; osäker, S1 håller passagen) och direkt
 * tillbaka genom bron i `retKn` var 60:e sekund. `utanFart` tar bort farten på
 * returraderna (stillafixen behåller sin). Låser att den verkliga returen
 * bokförs (D1-granskningens U-svängsband; se U57 i ARCHITECTURE).
 */
function u57Vandning(seed, mmsi, name, B, dir, D, retKn, expect, { utanFart = false } = {}) {
  const sgn = dir === 'S' ? -1 : 1;
  const step = 5.2 * 0.5144 * 60;
  const brgFwd = pointAt(PATH, METRICS, B + sgn * D).bearing;
  return {
    name,
    seed,
    vessels: [{
      mmsi,
      name: 'SYNT-U57-VAND',
      startS: B - sgn * (560 + 11 * step),
      legs: [
        {
          toS: B + sgn * D, speedKn: 5.2, intervalS: 60, gapFromS: B - sgn * 559, gapToS: B + sgn * (D - 1),
        },
        {
          stopS: 60, stopIntervalS: 60, stopSog: 0, stopCogDeg: dir === 'N' ? brgFwd : (brgFwd + 180) % 360,
        },
        { toS: B - sgn * 1200, speedKn: retKn, intervalS: 60 },
      ],
    }],
    patchSamples: (samples) => {
      const own = samples.filter((r) => r.mmsi === mmsi);
      const iStop = own.findIndex((r) => r.sog < 0.5);
      // Glappet blir 200 s (generatorns steg ger 240 s).
      own[iStop].aisTimestamp -= 40000;
      own[iStop].receivedAt = new Date(own[iStop].aisTimestamp).toISOString();
      // Generatorns första returrad ligger kvar på stoppets plats; i
      // granskarens bana ligger nästa fix redan tillbaka över linjen.
      samples.splice(samples.indexOf(own[iStop + 1]), 1);
      if (utanFart) for (const r of own.slice(iStop + 2)) r.sog = null;
    },
    expect,
  };
}

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
  // === Fältprovet 10–13 november (familj B): KEDJEARMENS SPÄRR DIREKT EFTER EN
  // VÄNDNING. En båt som vänt norr om Stridsbergsbron har Stridsbergsbron som
  // målbro och Klaffbron som kedjearm (ARM_NEXT_TARGET). Vändningen tömmer
  // passedBridges och köposterna, och köposterna skapas först på fixet EFTER
  // första målbrofixet. Spärren vid en tidigare bro räknade därför ingen bro
  // emellan på första målbrofixet, och kedjearmen fick 10-knopsdeadlinen. Nu
  // räknas, efter en BEKRÄFTAD vändning (vändningsmärket), varje opasserad bro
  // mellan båten och kedjearmens bro. Båda scenarierna fäller e51c7b6;
  // placeringen ÄR testet.
  {
    // k1 11 nov, PILOT 761 (265606970): låg 30 min 222 m norr om
    // Stridsbergsbron och vände med två omvända fix i 2,7–2,8 kn nästan på
    // stället (5 och 9 m från ankaret). NEW_JOURNEY bekräftade, men kajprovet
    // (_slowInitialQuayApproachNeedsProof) stoppade samma-tick-målbron. Målbron
    // kom på nästa fix, ett AISHub-fix 27 s gammalt, 61 m söderut i 1,7 kn.
    // Kedjearmens deadline (fixtid + 1376 m / 10 kn − 180 s) föll 61 s efter
    // mottagningen, före nästa poll 70 s senare, och Klaffbronvarningen gick
    // 50 min före passagen. Hon låg sedan 34 min i kön 75 m norr om
    // Järnvägsbron. Stoppet, vändningen på stället och AISHub-fixets ålder är
    // fältets; positionerna är generatorns.
    name: 'vänder-på-stället-norr-om-Stridsbergsbron-kö-vid-Järnvägsbron (fältprovet, PILOT 761)',
    seed: 1111,
    vessels: [{
      mmsi: '901111761',
      name: 'SYNT-LOTS',
      startS: METRICS.cum[1] - 600,
      legs: [
        { toS: METRICS.cum[4] + 220, speedKn: 8.5, intervalS: 67 },
        {
          stopS: 30 * 60, stopIntervalS: 67, stopSog: 0, stopCogRandom: true,
        },
        // Vändningen: två omvända fix i 2,8 kn på stoppets plats (U18).
        {
          stopS: 122, stopIntervalS: 61, stopSog: 2.8, stopCogDeg: 215,
        },
        // Söderut i 1,7 kn som AISHub-fix 27 s gamla. Glappet stryker benets
        // första rad (stoppets plats), så första fixet ligger 61 m söderut
        // (+159 m) och nästa på +98 m. Sedan 5 kn genom Stridsbergsbron till
        // kön, som i fältet (5,5 kn 30 m före bron).
        {
          toS: METRICS.cum[4] + 90,
          speedKn: 1.7,
          intervalS: 70,
          fixLagS: 27,
          gapFromS: METRICS.cum[4] + 219,
          gapToS: METRICS.cum[4] + 221,
        },
        {
          toS: METRICS.cum[3] + 75, speedKn: 5, intervalS: 68, fixLagS: 27,
        },
        {
          stopS: 34 * 60, stopIntervalS: 67, stopSog: 0, stopCogRandom: true,
        },
        { toS: METRICS.cum[2] - 900, speedKn: 4.5, intervalS: 67 },
      ],
    }],
    expect: {
      openingLeadS: { Klaffbron: 60, Stridsbergsbron: 60 },
      openingNotBeforeCrossing: { Klaffbron: 'Järnvägsbron' },
    },
  },
  {
    // Samma vändning utan stopp, så samma-tick-målbron (811c723) sätts i
    // bekräftelseticken, 222 m norr om Stridsbergsbron. Därefter hörs hon som
    // en klass B-sändare under 2 kn: nästa fix kommer 240 s senare. På e51c7b6
    // beväpnades kedjearmen Klaffbron i bekräftelseticken utan spärr
    // (köposterna tömdes av NEW_JOURNEY), och deadlinen 100 s senare kom före
    // nästa fix. ARCHITECTURE:s "spärren gäller från fixet efter vändningen"
    // höll alltså bara när nästa fix hann före deadlinen. Scenariot fäller
    // också alternativet att låta samma-tick-tilldelningen hoppa över kajprovet.
    name: 'vänder-norr-om-Stridsbergsbron-klass-B-tystnad-efter-bekräftelsen',
    seed: 1112,
    vessels: [{
      mmsi: '901111762',
      name: 'SYNT-VAND-B',
      startS: METRICS.cum[1] - 600,
      legs: [
        { toS: METRICS.cum[4] + 300, speedKn: 6, intervalS: 60 },
        // Två omvända fix i 2,5 kn: +300 m (väntar) och +223 m (bekräftar).
        { toS: METRICS.cum[4] + 200, speedKn: 2.5, intervalS: 60 },
        // 1,8 kn med klass B-kadens; glappet stryker raden på +200 m.
        {
          toS: METRICS.cum[3] + 75,
          speedKn: 1.8,
          intervalS: 180,
          gapFromS: METRICS.cum[4] + 199,
          gapToS: METRICS.cum[4] + 201,
        },
        {
          stopS: 15 * 60, stopIntervalS: 180, stopSog: 0, stopCogRandom: true,
        },
        { toS: METRICS.cum[2] - 900, speedKn: 4.5, intervalS: 30 },
      ],
    }],
    expect: {
      openingLeadS: { Klaffbron: 60, Stridsbergsbron: 60 },
      openingNotBeforeCrossing: { Klaffbron: 'Järnvägsbron' },
    },
  },
  // Granskningen av familj B (H1): regeln får bara gälla efter en BEKRÄFTAD
  // vändning. För en båt utan historik och utan vändning håller spärren en arm
  // som saknar kadens, och tystnadsregeln (två intervall) kan inte skydda den.
  // Båda motexemplen gav kort ledtid eller ingen varning med regeln för alla
  // båtar utan historik (c21ca8e) och minst 181 s i basen.
  {
    // Förstakontakt 250 m söder om Klaffbron i 2,5 kn, sedan 8 kn norrut utan
    // fix i 358 s. Med den breda regeln hölls kedjearmen Stridsbergsbron 300 s
    // från första fixet, och varningen kom 58 s före korsningen; basen 253 s.
    name: 'förstakontakt-2,5kn-sedan-8kn-norrut-i-tystnad (granskningen av familj B, H1)',
    seed: 1114,
    vessels: [{
      mmsi: '901111764',
      name: 'SYNT-FORST-SNABB',
      startS: METRICS.cum[2] - 250,
      legs: [
        { toS: METRICS.cum[2] - 249, speedKn: 2.5, intervalS: 1 },
        {
          toS: METRICS.cum[5] - 200,
          speedKn: 8,
          intervalS: 360,
          gapFromS: METRICS.cum[2] - 250,
          gapToS: METRICS.cum[2] - 250 + 8 * 0.5144 * 358,
        },
      ],
    }],
    expect: { openingLeadS: { Stridsbergsbron: 150 } },
  },
  {
    // Söderut i 10 kn med en position var 6:e minut, appomstart 120 m före
    // Stridsbergsbron. Öppningsarmarna sparas inte, så efter omstarten saknar
    // båten historik. Med den breda regeln hölls kedjearmen Klaffbron, och
    // passagen blev helt ovarnad; basen varnade 307 s före.
    name: 'omstart-120m-före-Stridsbergsbron-10kn-gles (granskningen av familj B, H1)',
    seed: 1115,
    vessels: [{
      mmsi: '901111765',
      name: 'SYNT-OMSTART-B',
      startS: METRICS.cum[5] + 800,
      legs: [{ toS: METRICS.cum[1] + 200, speedKn: 10, intervalS: 360 }],
    }],
    events: [{
      ctrl: 'restart',
      atOffsetS: (METRICS.cum[5] + 800 - (METRICS.cum[4] + 120)) / (10 * 0.5144),
    }],
    // Efter omstarten beväpnas Stridsbergsbron på nytt och avfyrar; den
    // persistenta dedupen tystar kortet (samma kontrakt som
    // omstart-mitt-i-passage). Det är omstartens, inte spärrens, sak.
    expect: { openingLeadS: { Klaffbron: 150 }, suppressedOpeningFires: 1 },
  },
  {
    // M3 (granskningen av familj B): varningen ska komma I TID efter en
    // vändning, inte bara inte för tidigt. Samma vändning som ovan, sedan 6 kn
    // söderut och nästa fix efter 360 s, när hon redan passerat Järnvägsbron.
    // Spärren efter vändningen håller kedjearmen Klaffbron högst 300 s från
    // bekräftelsen; en spärr som väntade på nästa fix hade gett under 100 s.
    name: 'vänder-norr-om-Stridsbergsbron-6kn-söderut-fix-var-6-min (M3, i tid)',
    seed: 1116,
    vessels: [{
      mmsi: '901111766',
      name: 'SYNT-VAND-6KN',
      startS: METRICS.cum[1] - 600,
      legs: [
        { toS: METRICS.cum[4] + 300, speedKn: 6, intervalS: 60 },
        { toS: METRICS.cum[4] + 200, speedKn: 2.5, intervalS: 60 },
        {
          toS: METRICS.cum[1] + 200,
          speedKn: 6,
          intervalS: 360,
          gapFromS: METRICS.cum[4] + 199,
          gapToS: METRICS.cum[4] + 201,
        },
      ],
    }],
    expect: { openingLeadS: { Klaffbron: 150, Stridsbergsbron: 60 } },
  },
  {
    // KÄND GRÄNS efter vändning (granskningen av familj B; ägarfråga i
    // docs/ARCHITECTURE.md): som M3-scenariot men 8 kn och nästa fix efter
    // 240 s. Två omvända fix i 2,5 kn och sedan 8 kn i tystnad går inte att
    // skilja från familjens scenario med 1,8 kn och kö, som inte får varnas
    // före Järnvägsbron. Spärren håller 300 s, och varningen kommer 105 s före
    // korsningen; basen gav 306 s. Kravet 90 s låser gränsen nära dagens värde,
    // så att en försämring syns (omgranskningen av familj B, O2).
    name: 'vänder-norr-om-Stridsbergsbron-8kn-söderut-i-tystnad (känd gräns)',
    seed: 1113,
    vessels: [{
      mmsi: '901111763',
      name: 'SYNT-VAND-SNABB',
      startS: METRICS.cum[1] - 600,
      legs: [
        { toS: METRICS.cum[4] + 300, speedKn: 6, intervalS: 60 },
        { toS: METRICS.cum[4] + 200, speedKn: 2.5, intervalS: 60 },
        {
          toS: METRICS.cum[1] + 200,
          speedKn: 8,
          intervalS: 240,
          gapFromS: METRICS.cum[4] + 199,
          gapToS: METRICS.cum[4] + 201,
        },
      ],
    }],
    expect: { openingLeadS: { Klaffbron: 90, Stridsbergsbron: 60 } },
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
  // F08 (nattjakten 2026-11-16, värld 16517, BRISEN): BN2 jämförde brons
  // LATITUD, men Stallbackabrons linje går snett (axel 142°). Ett hopp på
  // 760 m (198 s glapp i 7,4 kn) landar 8 m före bron längs farleden och 18 m
  // åt babord, alltså 13 m FÖRE brolinjen men 4 m norr om brons latitud, som
  // fältfallets fix (−13,3 m, sidled −18 m). Nästa fix kommer 200 s senare,
  // 750 m bortom bron. Positionerna är exakta (jitterM 0); placeringen ÄR
  // testet. Räkna om om generatorn, rutten eller brons koordinat ändras.
  {
    // Norrut: på 03ec89b fick fixen före linjen "passerade … under
    // AIS-tystnad", besöket fick fel bortre sida och den riktiga korsningen gav
    // en returnotis 200 s senare (två notiser för en passage).
    name: 'hopp-till-kilen-före-Stallbackabrons-linje (F08, värld 16517)',
    seed: 16517,
    vessels: [{
      mmsi: '901016517',
      name: 'SYNT-BRISEN',
      startS: METRICS.cum[4] + 300,
      jitterM: 0,
      legs: [
        { toS: METRICS.cum[5] - 768.2, speedKn: 7.4, intervalS: 60 },
        { toS: METRICS.cum[5] - 8.2, speedKn: 7.4, intervalS: 760 / (7.4 * 0.5144) },
        {
          toS: METRICS.cum[5] + 751.8, speedKn: 7.4, intervalS: 760 / (7.4 * 0.5144), lateralM: -18,
        },
        { toS: METRICS.cum[6] - 10, speedKn: 7.4, intervalS: 60 },
      ],
    }],
    expect: {
      minNotifiedBridges: ['Stallbackabron'],
      maxNotifiedPerBridge: { Stallbackabron: 1 },
    },
  },
  {
    // Spegelfallet söderut: samma fix ligger då 13 m FÖRBI linjen men norr om
    // latituden. På 03ec89b fick båten "närmar sig Stallbackabron, beräknad
    // ankomst strax" för en bro hon redan passerat; nu passerad form.
    name: 'hopp-till-kilen-förbi-Stallbackabrons-linje (F08-spegel)',
    seed: 16518,
    vessels: [{
      mmsi: '901016518',
      name: 'SYNT-SPEGEL',
      startS: METRICS.cum[6] - 10,
      jitterM: 0,
      legs: [
        { toS: METRICS.cum[5] + 751.8, speedKn: 7.4, intervalS: 60 },
        { toS: METRICS.cum[5] - 8.2, speedKn: 7.4, intervalS: 760 / (7.4 * 0.5144) },
        {
          toS: METRICS.cum[5] - 768.2, speedKn: 7.4, intervalS: 760 / (7.4 * 0.5144), lateralM: -18,
        },
        { toS: METRICS.cum[4] - 300, speedKn: 7.4, intervalS: 60 },
      ],
    }],
    expect: {
      minNotifiedBridges: ['Stallbackabron'],
      maxNotifiedPerBridge: { Stallbackabron: 1 },
      noApproachNoticeAfterCrossing: ['Stallbackabron'],
    },
  },
  {
    // F08-systerstället (_checkSkippedBridgesFallback, latitudfönstret): ett
    // hopp på 800 m landar i kilen 15 m FÖRE Klaffbrons linje (8 m före bron
    // längs farleden, 25 m åt babord, 2 m norr om brons latitud), och båten
    // väntar där i 15 min innan hon går igenom. På 03ec89b bokfördes Klaffbron
    // som passerad i hoppticken, notisen blev "passerade Klaffbron under
    // AIS-tystnad", texten bytte till Stridsbergsbron och sedan till "Inga
    // båtar" medan hon låg och väntade. Nu en förvarning, texten står kvar på
    // Klaffbron och passagen bokförs efter den verkliga korsningen. Sidledet
    // 25 m ligger mellan bankens p1 och p10 vid Klaffbrons linje; placeringen
    // ÄR testet.
    name: 'hopp-till-kilen-och-väntan-före-Klaffbrons-linje (F08-systerstället)',
    seed: 16519,
    vessels: [{
      mmsi: '901016519',
      name: 'SYNT-VANTAR',
      startS: METRICS.cum[1] + 400,
      jitterM: 0,
      legs: [
        { toS: METRICS.cum[2] - 808, speedKn: 6, intervalS: 60 },
        { toS: METRICS.cum[2] - 8, speedKn: 6, intervalS: 800 / (6 * 0.5144) },
        {
          stopS: 900, stopIntervalS: 60, stopSog: 0.1, lateralM: -25,
        },
        {
          toS: METRICS.cum[3] - 200, speedKn: 4, intervalS: 60, lateralM: -25,
        },
      ],
    }],
    expect: {
      maxNotifiedPerBridge: { Klaffbron: 1 },
      approachNoticeLeadS: { Klaffbron: 60 },
      noDefaultWhileStopped: true,
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
  {
    // ÄGARBESLUT U23 (2026-11-09): en båt på väg mot Klaffbron som stannar vid
    // "Kajen norr om Klaffbron" behandlas som i resten av väntområdet. Rutten
    // går genom Kajens kapsel 190–300 m norr om bron (16–24 m från kapsel-
    // linjen, radie 30 m), så stoppet 250 m norr om bron ligger i kapseln —
    // placeringen ÄR testet. Stoppet läggs med ben (exakt läge); `stop` utlöses
    // upp till ett rapportsteg före sitt mål och hade hamnat 343 m från bron,
    // utanför kapseln. På c14938f klassades hon förtöjd efter 15 min (zonens
    // köundantag): texten blev "Inga båtar …" medan hon väntade, och vid
    // avgången gav ankomstspärren (OPENING_QUAY_DEPARTURE) en ny varning strax
    // före passagen (värld 313 i buggjägaren: 32 s). Nu gäller den första
    // varningen hela kön.
    name: 'kö-25min-i-Kajens-kapsel (U23)',
    seed: 57,
    vessels: [{
      mmsi: '901000057',
      name: 'SYNT-KAJKO',
      startS: METRICS.total,
      legs: [
        { toS: METRICS.cum[2] + 600, speedKn: 4.5, intervalS: 60 },
        { toS: METRICS.cum[2] + 250, speedKn: 3, intervalS: 60 },
        { stopS: 1500, stopIntervalS: 60, stopCogRandom: true },
        { toS: 0, speedKn: 4.5, intervalS: 60 },
      ],
    }],
    expect: {
      minTargetPassages: 2,
      expectedOpenings: ['Stridsbergsbron', 'Klaffbron'],
      maxOpeningsPerBridge: { Klaffbron: 1, Stridsbergsbron: 1 },
      minOpeningLeadS: { Klaffbron: 60 },
      noDefaultWhileStopped: true,
    },
  },
  {
    // U23 och INV-10 (granskningen av familj F, 2026-11-09): samma kö vid Kajen
    // men i 60 min, och en senare båt söderut kommer in i texten 39 min efter
    // att köaren fick "strax". Den första strax-texten slutar alltså utan
    // passage efter mer än INV-10:s 35 min. Texten är sanktionerad (U6) och
    // densamma som för en köare i farleden, så harnessen måste räkna Kajens
    // köare som bekräftad väntan (replayRunner.js, holdsQuayQueue). Utan den
    // regeln fälls scenariot av INV-10 STRAX-ZOMBIE; på c14938f av "Inga båtar"
    // under kön och en sen andra varning vid avgången.
    name: 'kö-60min-i-Kajens-kapsel-med-annan-trafik (U23, INV-10)',
    seed: 58,
    vessels: [
      {
        mmsi: '901000058',
        name: 'SYNT-KAJKO-LANG',
        startS: METRICS.total,
        legs: [
          { toS: METRICS.cum[2] + 600, speedKn: 4.5, intervalS: 60 },
          { toS: METRICS.cum[2] + 250, speedKn: 3, intervalS: 60 },
          { stopS: 3600, stopIntervalS: 60, stopCogRandom: true },
          { toS: 0, speedKn: 4.5, intervalS: 60 },
        ],
      },
      {
        mmsi: '901000059', name: 'SYNT-SENARE', direction: 'south', speedKn: 5.0, startOffsetS: 4300,
      },
    ],
    expect: {
      minTargetPassages: 4,
      expectedOpenings: ['Stridsbergsbron', 'Klaffbron'],
      openingBeforeEachPassage: ['Klaffbron'],
      maxOpeningsPerBridge: { Klaffbron: 2, Stridsbergsbron: 2 },
      minOpeningLeadS: { Klaffbron: 60 },
      noDefaultWhileStopped: true,
    },
  },
  {
    // KÄND GRÄNS (U75, omgång 9): RETUR FRÅN KAJEN. Båten går norrut genom
    // Klaffbron (målbron blir Stridsbergsbron), ligger 15 min vid Kajen norr om
    // Klaffbron, 220 m från bron (kapseln, se scenarierna ovan), och går söderut
    // genom bron igen. AISHub-takt: fixen är 20 s gamla, stillheten rapporteras
    // var 3:e minut, och mellan kajen och bron hörs hon EN gång (glappet stryker
    // benets första rad på kajplatsen; fixet ligger 65 m norr om bron, nästa 90 m
    // söder). Förtöjd i kajzonen har hon ingen målbro, Klaffbron är passerad på
    // resan, och vändningen bekräftas först av återkorsningen (U18: två
    // positioner). Ingen öppningsvarning för returen; den enda Klaffbronvarningen
    // är uppresans. Passagenotisen för returen kommer. Efterbildar ELFKUNGEN
    // 2026-08-07 (20260806-42h); positionerna är generatorns.
    name: 'retur-från-Kajen-220m-norr-om-Klaffbron-en-fix-före-bron (känd gräns, U75)',
    seed: 7501,
    vessels: [{
      mmsi: '907501001',
      name: 'SYNT-U75-KAJRETUR',
      startS: S_OLIDEBRON - 400,
      legs: [
        {
          toS: S_KLAFFBRON + 220, speedKn: 5, intervalS: 67, fixLagS: 20,
        },
        {
          stopS: 900, stopIntervalS: 180, stopSog: 0, stopCogDeg: 48, fixLagS: 20,
        },
        {
          toS: S_OLIDEBRON - 400,
          speedKn: 4.5,
          intervalS: 67,
          fixLagS: 20,
          gapFromS: S_KLAFFBRON + 219,
          gapToS: S_KLAFFBRON + 221,
        },
      ],
    }],
    // Låser dagens utfall: en Klaffbronvarning (uppresans), båda passagerna
    // bokförda, och notiserna "närmar sig" (upp) och "har precis passerat"
    // (returen, högst 120 s efter den sanna korsningen, riktning söderut). En
    // rättning som ger returen en varning fäller maxOpeningsPerBridge och ska
    // prövas mot U18 och U75 (docs/ARCHITECTURE.md), inte låsas om i tysthet.
    expect: {
      expectedOpenings: ['Klaffbron'],
      maxOpeningsPerBridge: { Klaffbron: 1 },
      minPassagesPerBridge: { Klaffbron: 2 },
      noticeForms: { Klaffbron: ['närmar', 'precis'] },
      maxNoticeDelayS: { Klaffbron: 120 },
      noticeDirectionVsTruth: { Klaffbron: { mismatches: 0 } },
    },
  },
  {
    // Fältprovet 2026-11-12 (körning 1, familj E): avgång ur väntan vid en
    // mellanbro direkt efter en målbroövergång. Efterbildar PRICKBJORN
    // 265012090: passerar Stridsbergsbron söderut (målbytet till Klaffbron
    // armerar stationär-holden och tömmer fartbufferten), väntar 17 min
    // ~175 m norr om Järnvägsbron och lägger ut i 1,1 → 3,7 → 6,5 kn.
    // Holden svarade null innan fartbufferten matades, så avgångsgolvet
    // (familj E, F04) armades aldrig och ETA:n räknades på 1,1 kn: "om 31,
    // 23, 20 minuter" mot sanningen 6,6, 5,9, 4,9 (fältet: 32, 33, 25 mot 6,7,
    // 6,1, 5,0). Med holdens stillhetsbevis räknas första texten på golvet
    // (dubbla igångsättningsfarten, 2,2 kn): "om 16, 11, 9, 6, 4".
    // GRÄNSEN +12 min ligger mellan golvets medvetet försiktiga första
    // prognos för en så långsam igångsättning (+9,4) och igångsättningsfartens
    // (+24,4). Den fäller alltså en avgång som inte känns igen, men låter en
    // framtida ETA-etapp komma närmare sanningen. Gränsen −3 min fäller ett
    // golv som lovar för tidigt.
    // Glappet i första avgångsbenet gör att 1,1 kn-samplet hörs 23 m från
    // stoppet (som i fältet, 36 m) i stället för på stoppets position.
    // Benens slut ligger ett helt steg efter senaste sampel, så nästa bens
    // första sampel ligger där båten verkligen är.
    name: 'avgång-ur-väntan-vid-mellanbro-efter-målbyte (fältprov k1, PRICKBJORN)',
    seed: 53001,
    vessels: [{
      mmsi: '901053001',
      name: 'SYNT-PRICKAVG',
      startS: METRICS.cum[4] + 900,
      legs: [
        { toS: METRICS.cum[3] + 175, speedKn: 4.0, intervalS: 60 },
        { stopS: 1020, stopIntervalS: 65 },
        {
          toS: METRICS.cum[3] + 175 - 2 * (1.1 * 0.5144 * 40) + 0.01,
          speedKn: 1.1,
          intervalS: 40,
          gapFromS: METRICS.cum[3] + 175,
          gapToS: METRICS.cum[3] + 174,
        },
        {
          toS: METRICS.cum[3] + 175 - 2 * (1.1 * 0.5144 * 40) + 0.01 - 3.7 * 0.5144 * 60 + 0.01,
          speedKn: 3.7,
          intervalS: 60,
        },
        { toS: 0, speedKn: 6.5, intervalS: 60 },
      ],
    }],
    expect: {
      minTargetPassages: 2,
      departureEta: { bridge: 'Klaffbron', maxOverMin: 12, maxUnderMin: 3 },
    },
  },
  {
    // Familj E, revision 1 (granskningen 2026-11-13, A3): KRYP I KÖN EFTER
    // MÅLBYTET OCH NY VÄNTAN — en INFORMATIV låsning av en känd svaghet, inte
    // ett påstående att beteendet är rätt. Samma början som scenariot ovan
    // (Stridsbergsbron söderut, målbytet armerar holden, 17 min väntan 175 m
    // norr om Järnvägsbron), sedan kryp i 2,0 kn i tre steg på 60 s (185 m;
    // de två första hörs i 2,0 kn, det tredje när hon redan stannat 10 m
    // söder om Järnvägsbron), 10 min ny väntan och verklig avgång 1,1 → 3,7 →
    // 6,5 kn. Krypsamplet kan inte skiljas från en avgång: holdens bevis
    // armerar golvet (2 × 2,0 kn, högst 4 kn) och prognosen blir för låg,
    // precis som i buffertvägen utan målbyte. Dagens utfall (efter 272f16b):
    // "om 9, om 8" mot sann restid 19,1 och 18,1 min (fel −10,1), "om 8" står
    // kvar 12,5 min under den nya väntan, och öppningskortet Klaffbron#3
    // (deadline 06:28:25) har eta 8 mot sann restid 17,0 (fel −9,0). Före
    // rättningen gav samma rörelse "om 18, 17, 21" och eta 19. GRÄNSERNA
    // (−11 för texten, −10 för kortet) är dagens värden plus marginal: en
    // ändring som gör klassen större blir röd här. Att göra klassen mindre
    // hör till ETA-etappen (U20/U22).
    name: 'kryp-i-kön-efter-målbyte-och-ny-väntan (informativ, granskning A3)',
    seed: 53002,
    vessels: [{
      mmsi: '901053002',
      name: 'SYNT-KOKRYP',
      startS: METRICS.cum[4] + 900,
      legs: [
        { toS: METRICS.cum[3] + 175, speedKn: 4.0, intervalS: 60 },
        { stopS: 1020, stopIntervalS: 65 },
        {
          toS: METRICS.cum[3] + 175 - 3 * (2.0 * 0.5144 * 60) + 0.01,
          speedKn: 2.0,
          intervalS: 60,
          gapFromS: METRICS.cum[3] + 175,
          gapToS: METRICS.cum[3] + 174,
        },
        { stopS: 600, stopIntervalS: 65 },
        {
          toS: METRICS.cum[3] + 175 - 3 * (2.0 * 0.5144 * 60) + 0.01 - 2 * (1.1 * 0.5144 * 40) + 0.01,
          speedKn: 1.1,
          intervalS: 40,
          gapFromS: METRICS.cum[3] + 175 - 3 * (2.0 * 0.5144 * 60) + 0.01,
          gapToS: METRICS.cum[3] + 175 - 3 * (2.0 * 0.5144 * 60) + 0.01 - 1,
        },
        {
          toS: METRICS.cum[3] + 175 - 3 * (2.0 * 0.5144 * 60) + 0.01 - 2 * (1.1 * 0.5144 * 40) + 0.01
            - 3.7 * 0.5144 * 60 + 0.01,
          speedKn: 3.7,
          intervalS: 60,
        },
        { toS: 0, speedKn: 6.5, intervalS: 60 },
      ],
    }],
    expect: {
      minTargetPassages: 2,
      creepEta: { bridge: 'Klaffbron', maxUnderMin: 11, maxCardUnderMin: 10 },
    },
  },
  {
    // Fältprovet 2026-11-13 (familj C, C2): ASPEN/WILSON ALSTER/NORDIC SOLA.
    // Söderut i 10 kn med 70 s mellan fixarna: 290 m norr om Stridsbergsbron,
    // sedan 70 m söder om den (187 m norr om Järnvägsbron). Den fixen bokför
    // Stridsbergsbron och ligger redan i Järnvägsbrons zon. Förut höll
    // broöppningsfönstret (30 s) notisen tills vakthunden tvingade väntan på
    // den gamla fixen, högst 6 s före korsningen (36 s efter fixen). Nu går
    // notisen på fixen, 36 s före korsningen.
    name: 'järnvägsbron-söderut-notis-på-passagefixen (C2)',
    seed: 8201,
    vessels: [
      {
        mmsi: '908200001',
        name: 'SYNT-JVB-TIDIG',
        startS: METRICS.cum[4] + 290 + 8 * 10 * 0.5144 * 70,
        legs: [{ toS: 0, speedKn: 10, intervalS: 70 }],
      },
    ],
    expect: {
      minTargetPassages: 2,
      approachNoticeLeadS: { Järnvägsbron: 20 },
      noApproachNoticeAfterCrossing: ['Järnvägsbron', 'Stridsbergsbron'],
    },
  },
  {
    // Fältprovet 2026-11-13 (familj C, C2): PRICKBJORN 13:56. Fixen efter
    // Stridsbergsbron ligger 20 m BORTOM Järnvägsbron (77 m norr om
    // Stridsbergsbron → 354 m på 70 s). Ingen fix låg inom 300 m på
    // ankomstsidan, så någon förvarning finns inte att ge. Förut tvingade
    // vakthunden väntan vid den passerade bron och notisen blev "närmar sig
    // Järnvägsbron, beräknad ankomst strax". Nästa fix (AISStream, 45 s)
    // bokför passagen och ger "har precis passerat".
    name: 'järnvägsbron-söderut-passagefix-bortom-linjen (C2)',
    seed: 8202,
    vessels: [
      {
        mmsi: '908200002',
        name: 'SYNT-JVB-BORTOM',
        startS: METRICS.cum[4] + 77 + 8 * 10 * 0.5144 * 70,
        legs: [
          // Benet slutar 1 m norr om fixen 20 m söder om Järnvägsbron, så att
          // nästa ben börjar exakt där (sista steget klipps till benets mål).
          { toS: METRICS.cum[3] - 19, speedKn: 10, intervalS: 70 },
          { toS: 0, speedKn: 10, intervalS: 45 },
        ],
      },
    ],
    expect: {
      minTargetPassages: 2,
      minNotifiedBridges: ['Järnvägsbron'],
      noApproachNoticeAfterCrossing: ['Järnvägsbron', 'Stridsbergsbron'],
    },
  },
  {
    // Buggjägaren efter sammanslagningen (2026-11-14, familj C3): FREJA 2 och
    // BRISEN (w1458015545-383-R1, w2090169785-1226-R1). Båten ligger redan
    // under Stridsbergsbron (40 m) och nästa glesa fix, 173 s senare, ligger
    // 14 m bortom Järnvägsbron. Passagen av Stridsbergsbron bokförs utan
    // broöppningsfönster (samma bro var redan låst), så FIX U konsumeras i
    // fixens eget pass. Basen gav där "närmar sig Järnvägsbron, beräknad
    // ankomst strax" ~8 s efter korsningen; C2 rensade väntan 10 m bortom
    // linjen och notisen kom via failsafen vid nästa fix, ~180 s efter.
    name: 'järnvägsbron-söderut-glest-passagefix-under-bron (C3)',
    seed: 8203,
    vessels: [
      {
        mmsi: '908200003',
        name: 'SYNT-JVB-UNDER',
        startS: METRICS.cum[5] + 200,
        legs: [
          { toS: METRICS.cum[4] + 40, speedKn: 5, intervalS: 60 },
          // 173 s i 3,5 kn = 311 m: från 40 m norr om Stridsbergsbron till
          // 14 m söder om Järnvägsbron (paret ligger 257 m isär).
          { toS: 0, speedKn: 3.5, intervalS: 173 },
        ],
      },
    ],
    expect: {
      minTargetPassages: 2,
      minNotifiedBridges: ['Järnvägsbron'],
      maxNoticeDelayS: { Järnvägsbron: 60 },
    },
  },
  {
    // Fältprovet 2026-11-12 (körning 1, PRICKBJORN; familj A): varnad för
    // Stridsbergsbron på väg söderut, sedan helt stilla 460 m norr om bron i
    // farleden, utanför de ritade kajzonerna, i 3 h 54 min. Målbron tappas
    // efter 20 min (U27) och 2 h-backstoppen förtöjer henne; hon lägger ut
    // och korsar bron. På e51c7b6 registrerade ankomstspärren aldrig stoppet
    // innanför 600 m, så den nya varningen vid avgången spärrades av den fyra
    // timmar gamla (servicen avfyrade, kortet tystades). Nu bekräftar
    // klassningens 2 h-släpp stoppet, och avgången är en ny ankomst.
    // Placeringen ÄR testet: 460 m ligger i bandet 300–600 m där varken
    // kajzonens regler eller KINNE-grenen (> 600 m) gäller.
    name: 'stopp-4h-460m-norr-om-Stridsbergsbron-i-farleden (fält 2026-11-12)',
    seed: 1112,
    vessels: [{
      mmsi: '901001112',
      name: 'SYNT-FARLEDSSTOPP',
      startS: METRICS.cum[4] + 1500,
      legs: [
        { toS: METRICS.cum[4] + 460, speedKn: 6, intervalS: 65 },
        { stopS: 234 * 60, stopIntervalS: 68, stopCogRandom: true },
        { toS: METRICS.cum[2] - 400, speedKn: 3.5, intervalS: 60 },
      ],
    }],
    expect: {
      minTargetPassages: 2,
      expectedOpenings: ['Stridsbergsbron', 'Klaffbron'],
      // Den första varningen vid anflygningen och en ny vid avgången.
      maxOpeningsPerBridge: { Stridsbergsbron: 2, Klaffbron: 1 },
      // Den senaste varningen före korsningen får inte vara den från
      // anflygningen fyra timmar tidigare, och den nya ska ge förvarning
      // (granskningen, L1: maxOpeningAgeS prövar inte ledtiden).
      maxOpeningAgeS: { Stridsbergsbron: 900 },
      minOpeningLeadS: { Stridsbergsbron: 60 },
      // Revision 1 (H1): farledsstoppets avgång kräver två avgångsfix i följd.
      // Servicen avfyrar redan på det första (deadlinen har passerat), och
      // spärren håller det kortet; på det andra släpper restartArrival armen
      // och kortet går 60 s senare. Exakt en tystad avfyrning.
      suppressedOpeningFires: 1,
    },
  },
  // Fältprov k1 (2026-11-11, PRICKBJORN-klassen; familj D i rättnings-
  // kampanjen): MANÖVERSKYDDETS KURSBEN VID STILLHET. En arbetsbåt lägger ut
  // söder om Kanalinfarten, går norrut i 6 kn (får målbro Klaffbron), svänger
  // in mot en kaj och ligger sedan still med fladdrande kurs, 2 km från bron.
  // Samtidigt går en annan båt norrut mot Klaffbron. Före rättningen
  // återaktiverade varje kurshopp > 45° manöverskyddet (fart 0, någon meter
  // förflyttning) och höll kvar kajbåtens målbro: texten sa "Två båtar på väg
  // mot Klaffbron" under hela kajvistelsen. Positionerna är egna och nedkortade
  // (micro-ben om 1 m med omväxlande rapporterad kurs 150°/290°, fart 0,05 ±
  // 0,1 kn), inte fältets.
  //
  // Första fönstret börjar 5 min efter svängen (skyddets maxtid, så att den
  // verkliga manöverns skydd hunnit släppa) och slutar 2 min före den andra
  // båtens korsning av Klaffbron; där ska texten räkna EN båt mot Klaffbron.
  // Förväntan räknar båtar, inte vilka, så det fönstret skiljer inte "kajbåten
  // borta" från "den gående båten borta, kajbåten kvar". Det andra fönstret gör
  // det: efter att den gående båten passerat Klaffbron (hon går då mot
  // Stridsbergsbron) ligger kajbåten kvar vid kajen till 2 080 s, och texten får
  // inte räkna någon båt mot Klaffbron. Kajen ligger söder om
  // Kanalinfarten-punkten, där rättningen gäller (FP9-H′:s område).
  {
    name: 'kajbyte-med-kursbrus-långt-från-målbron (k1 PRICKBJORN)',
    seed: 4401,
    vessels: [
      {
        mmsi: '904401001',
        name: 'SYNT-KAJBYTE',
        startS: 450,
        legs: [
          { toS: 800, speedKn: 6, intervalS: 65 },
          // Svängen in mot kajen: verklig manöver (kurs 22° → 255°, 6 → 1,1 kn).
          {
            toS: 820, speedKn: 1.1, intervalS: 65, cogDeg: 255,
          },
          // Kajen: 30 sampel (195–2 080 s), fart på brusnivå, kursen hoppar
          // 140° per sampel.
          ...Array.from({ length: 30 }, (_, i) => ({
            toS: 821 + i, speedKn: 0.05, intervalS: 65, cogDeg: i % 2 === 0 ? 150 : 290,
          })),
        ],
      },
      {
        mmsi: '904401002',
        name: 'SYNT-MOT-KLAFF',
        startS: 100,
        startOffsetS: 120,
        legs: [{ toS: METRICS.cum[2] + 400, speedKn: 4, intervalS: 60 }],
      },
    ],
    // Svängen kommer 130 s; den andra båten korsar Klaffbron ~1 464 s
    // (2 765 m i 4 kn från 120 s). Fönstren: 430–1 340 s och 1 600–2 050 s.
    expect: {
      textCountWindows: [
        {
          bridge: 'Klaffbron', fromS: 430, toS: 1340, min: 1, max: 1,
        },
        {
          bridge: 'Klaffbron', fromS: 1600, toS: 2050, max: 0,
        },
      ],
    },
  },
  // Motfallet till scenariot ovan (familj D): en VERKLIG manöver i låg fart
  // ska fortfarande hålla målbron. Båten går norrut genom Klaffbron (målbro
  // Stridsbergsbron) och stannar upp 435 m norr om Klaffbron, ~786 m från
  // målbron — utanför målbroskyddets 300 m, kö-zonens 600 m och alla broars
  // skyddszon, så bara manöverskyddet kan hålla målet. Där vrider hon kursen
  // drygt 80° i 0,45 kn (gråzonen 0,3–0,5 kn, nästan utan förflyttning, som
  // ANYA ELAN i both-21h 08:19:25) och lägger sedan ut igen. Fristen startar på
  // stoppet; utan manöverskydd tas målet bort 65 s senare och texten blir
  // "Inga båtar" mitt i manövern. Scenariot fäller en grind som stänger
  // kursbenet helt eller redan under 0,5 kn (MOVEMENT_PROOF_SOG_KN).
  //
  // Tider (sekunder från bastiden): 1 035 m i 4 kn med 30 s kadens ger 17
  // sampel, ankomstfixet kommer 510 s, stoppet 540 s (fristen startar),
  // manöversamplen 570, 605 och 640 s. Avgångsbenets första sampel skulle
  // ligga på samma punkt som det sista manöversamplet och stryks därför med
  // ett glapp på en meter; nästa sampel (705 s) har 62 m närmande.
  {
    name: 'låg-fart-manöver-utanför-kö-zonen-behåller-målbron (motfall k1)',
    seed: 4402,
    vessels: [{
      mmsi: '904402001',
      name: 'SYNT-MANÖVER',
      startS: METRICS.cum[2] - 600,
      legs: [
        { toS: METRICS.cum[2] + 435, speedKn: 4, intervalS: 30 },
        // Framme: samma position, 4 kn rapporterad (ankomstfixet).
        { stopS: 30, stopIntervalS: 30, stopSog: 4 },
        // Stannar upp: ingen förflyttning, 2,2 kn (Δ 1,8 kn < 2, ingen manöver)
        // ⇒ närmandet uteblir och nådafristen startar.
        { stopS: 30, stopIntervalS: 30, stopSog: 2.2 },
        // Manövern: kursen vrids från farledens ~30° till 112° i 0,45 kn.
        ...[112, 114, 116].map((cogDeg, i) => ({
          toS: METRICS.cum[2] + 436 + i, speedKn: 0.45, intervalS: 35, cogDeg,
        })),
        {
          toS: METRICS.cum[4] + 400,
          speedKn: 4,
          intervalS: 30,
          gapFromS: METRICS.cum[2] + 438,
          gapToS: METRICS.cum[2] + 439,
        },
      ],
    }],
    expect: {
      minTargetPassages: 2,
      textCountWindows: [{
        bridge: 'Stridsbergsbron', fromS: 540, toS: 700, min: 1,
      }],
    },
  },
  // Familj D, revision 1 (granskningens M1): FARTBRUS VID KAJEN I FRISTEN.
  // Samma kajbyte som ovan, men andra kajsamplet (260 s, mitt i nådafristen)
  // rapporterar 2,5 kn på samma punkt — fartbruset som FP9-H′ dokumenterar vid
  // kajerna söder om Kanalinfarten (HEY JOE 0,8–7,5 kn). Granskaren visade att
  // ett sådant prov i PRICKBJORNs 13:28:15-sampel återställer fältfelet: både
  // fartbenet (Δ 2,5 kn) och kursbenet (kurshopp i "2,5 kn") återaktiverar
  // skyddet. Med rättningen släpps målet vid fristens slut (260 s); utan
  // fartregeln först 390 s, utan någon rättning långt senare. Fönstret
  // 330–900 s får inte räkna någon båt mot Klaffbron.
  {
    name: 'kajbyte-med-fartbrus-i-fristen (k1 PRICKBJORN, M1)',
    seed: 4405,
    vessels: [{
      mmsi: '904405001',
      name: 'SYNT-KAJBRUS',
      startS: 450,
      legs: [
        { toS: 800, speedKn: 6, intervalS: 65 },
        {
          toS: 820, speedKn: 1.1, intervalS: 65, cogDeg: 255,
        },
        {
          toS: 821, speedKn: 0.05, intervalS: 65, cogDeg: 150,
        },
        // Fartbruset: 2,5 kn på samma punkt, kurs = farledens (~22°).
        { stopS: 65, stopIntervalS: 65, stopSog: 2.5 },
        ...Array.from({ length: 10 }, (_, i) => ({
          toS: 822 + i, speedKn: 0.05, intervalS: 65, cogDeg: i % 2 === 0 ? 290 : 150,
        })),
      ],
    }],
    expect: {
      textCountWindows: [{
        bridge: 'Klaffbron', fromS: 330, toS: 900, max: 0,
      }],
    },
  },
  // Familj D, revision 2 (omgranskningens R1-M1): KAJRADEN NORR OM PUNKTENS
  // LATITUD. Kajraden vid Kanalinfarten ligger på båda sidor om punktens
  // latitud (CAPELLA 2 m norr, PRICKBJORN 9–10 m norr den 12 november). Samma
  // kajbyte som ovan, men svängen kommer 9 m söder om linjen (s = 920) och kajen
  // ligger 9–17 m NORR om den (s = 940–949, micro-ben om 0,3 m). Gränsen ligger
  // 40 m norr om linjen, så kajen ingår. Med gränsen på linjen (revision 1) kom
  // fältfelet tillbaka: svängsamplet söder, kajsamplet norr ⇒ kursbruset höll
  // målet. Fönstret 330–2 000 s får inte räkna någon båt mot Klaffbron.
  {
    name: 'kajbyte-9-m-norr-om-punktens-latitud (k1 PRICKBJORN, R1-M1)',
    seed: 4406,
    vessels: [{
      mmsi: '904406001',
      name: 'SYNT-KAJ-NORR',
      startS: 600,
      legs: [
        { toS: 920, speedKn: 6, intervalS: 65 },
        {
          toS: 940, speedKn: 1.1, intervalS: 65, cogDeg: 255,
        },
        ...Array.from({ length: 30 }, (_, i) => ({
          toS: 940.3 + 0.3 * i, speedKn: 0.05, intervalS: 65, cogDeg: i % 2 === 0 ? 150 : 290,
        })),
      ],
    }],
    expect: {
      textCountWindows: [{
        bridge: 'Klaffbron', fromS: 330, toS: 2000, max: 0,
      }],
    },
  },
  // Familj D, revision 1 (granskningens L2): 40 m-VILLKORET SÖDER OM PUNKTEN.
  // Grinden spärrar kursbenet bara när BÅDE farten (< 0,3 kn) och positionen
  // (< 40 m sedan förra fixen) säger stilla. Här kryper en båt in mot kanalen
  // söder om Kanalinfarten-punkten med en fartgivare som släpar: hon rapporterar
  // 0,0–0,2 kn men flyttar sig 60 m per 3 min norrut (0,31 m/s, över FP9-H′:s
  // 0,25 m/s) och kursen vänder mellan fixarna. Fartgrinden (0,7 kn > 500 m från
  // broarna) underkänner henne, så bara manöverskyddet håller målet — och det
  // ska det göra, för hon har bevisligen rört sig. Om grinden spärrade på farten
  // ensam släpptes målet vid tredje krypfixen (540 s) och texten blev "Inga
  // båtar" tills hon gick vidare (660 s).
  //
  // Placering: insegling i 4 kn till s = 450, därefter tre fixar 60 m isär med
  // 180 s mellanrum (mellanfixarna stryks med glapp på benen i 1 kn) och kurs
  // 22°/200°/22°; avgångsbenets första fix stryks också (samma punkt som sista
  // krypfixen), nästa kommer 660 s med 124 m förflyttning.
  {
    name: 'krypande-insegling-med-släpande-fart-söder-om-Kanalinfarten (familj D, L2)',
    seed: 4404,
    vessels: [{
      mmsi: '904404001',
      name: 'SYNT-KRYP',
      startS: 150,
      legs: [
        { toS: 450, speedKn: 4, intervalS: 60 },
        // Krypfix 1 (180 s): s = 450, kurs 22°.
        {
          toS: 451, speedKn: 0.1, intervalS: 60, cogDeg: 22,
        },
        {
          toS: 510, speedKn: 1, intervalS: 60, gapFromS: 450.5, gapToS: 509.9,
        },
        // Krypfix 2 (360 s): s = 510, 60 m, kurs 200°.
        {
          toS: 511, speedKn: 0.1, intervalS: 60, cogDeg: 200,
        },
        {
          toS: 570, speedKn: 1, intervalS: 60, gapFromS: 510.5, gapToS: 569.9,
        },
        // Krypfix 3 (540 s): s = 570, 60 m, kurs 22°.
        {
          toS: 571, speedKn: 0.1, intervalS: 60, cogDeg: 22,
        },
        {
          toS: METRICS.cum[2] + 300,
          speedKn: 4,
          intervalS: 60,
          gapFromS: 570.5,
          gapToS: 571.5,
        },
      ],
    }],
    expect: {
      textCountWindows: [{
        bridge: 'Klaffbron', fromS: 180, toS: 650, min: 1,
      }],
    },
  },
  // Granskning D (2026-11-13): MOTFALL TILL KURSBENETS STILLHETSGRIND. En
  // verklig köare mot Stridsbergsbron ligger stilla i farleden mellan
  // Klaffbron och Järnvägsbron, 420 m norr om Klaffbron (~800 m från
  // målbron): utanför kö-zonens 600 m, och Klaffbrons skyddszon är upphävd
  // (F21, passerad bro). Hon rapporterar fart på brusnivå (0,0–0,2 kn) och en
  // kurs som hoppar mellan fixarna (Class B vid stillhet), väntar 15 min och
  // går sedan vidare genom Stridsbergsbron. Texten ska räkna henne hela
  // väntan; "Inga båtar" mitt i kön är felbilden manöverskyddet finns för.
  {
    name: 'stilla-köare-i-luckan-med-kursbrus (granskning D)',
    seed: 4403,
    vessels: [{
      mmsi: '904403001',
      name: 'SYNT-LUCKKÖ',
      startS: METRICS.cum[2] - 900,
      legs: [
        { toS: METRICS.cum[2] + 420, speedKn: 4, intervalS: 30 },
        {
          stopS: 900, stopIntervalS: 60, stopSog: 0.1, stopCogRandom: true,
        },
        { toS: METRICS.cum[4] + 500, speedKn: 4, intervalS: 30 },
      ],
    }],
    expect: {
      minTargetPassages: 2,
      noDefaultWhileStopped: true,
    },
  },
  // U30 (2026-11-15): STILLA BÅT UTANFÖR VÄNTZONEN. Fältfallet (körning 1,
  // 12 nov 08:30–08:54Z): en båt söderut saktade in och låg stilla 460 m norr
  // om Stridsbergsbron med färsk AIS; texten frös på "om 4 minuter" i 12,7 min
  // och räknade sedan upp till 28 innan målbron släpptes (U27). Här: söderut
  // i 5 kn, inbromsning i 2 kn, stopp 460 m norr om bron med AIS var 60:e s
  // i 25 min, och båten går aldrig. Efter fem minuters stillhet ska bron visas
  // som "ETA okänd" tills hon släpps — ingen frusen siffra, ingen trappa.
  {
    name: 'stilla-460m-från-målbron-ETA-okänd (fältprovet k1, U30)',
    seed: 4450,
    vessels: [{
      mmsi: '904450101',
      name: 'SYNT-STILLA',
      startS: METRICS.cum[4] + 1700,
      legs: [
        { toS: METRICS.cum[4] + 610, speedKn: 5, intervalS: 30 },
        { toS: METRICS.cum[4] + 460, speedKn: 2, intervalS: 30 },
        {
          stopS: 1500, stopIntervalS: 60, stopSog: 0.1, stopCogRandom: true,
        },
      ],
    }],
    expect: {
      stillUnknown: { bridge: 'Stridsbergsbron', afterS: 420 },
      maxFormChangesPerStop: { bridge: 'Stridsbergsbron', max: 2 },
    },
  },
  // U30, motfall: samma stopp i 8 min, sedan går hon. Under stoppet "ETA
  // okänd", och nedräkningen kommer tillbaka direkt när hon rör sig, utan
  // att texten blinkar (högst två formbyten: siffra → okänd → siffra).
  {
    name: 'stilla-460m-och-går-igen (motfall U30)',
    seed: 4451,
    vessels: [{
      mmsi: '904451101',
      name: 'SYNT-GÅR-IGEN',
      startS: METRICS.cum[4] + 1700,
      legs: [
        { toS: METRICS.cum[4] + 610, speedKn: 5, intervalS: 30 },
        { toS: METRICS.cum[4] + 460, speedKn: 2, intervalS: 30 },
        {
          stopS: 480, stopIntervalS: 60, stopSog: 0.1, stopCogRandom: true,
        },
        { toS: METRICS.cum[4] - 400, speedKn: 4, intervalS: 30 },
      ],
    }],
    expect: {
      minTargetPassages: 1,
      stillUnknown: { bridge: 'Stridsbergsbron', afterS: 420 },
      maxFormChangesPerStop: { bridge: 'Stridsbergsbron', max: 2 },
      departureEta: { bridge: 'Stridsbergsbron', maxOverMin: 3, maxUnderMin: 2 },
    },
  },
  // U30, motfall: ett kort stopp under fem minuter ändras inte.
  {
    name: 'kort-stopp-460m-under-fem-minuter (motfall U30)',
    seed: 4452,
    vessels: [{
      mmsi: '904452101',
      name: 'SYNT-KORT',
      startS: METRICS.cum[4] + 1700,
      legs: [
        { toS: METRICS.cum[4] + 610, speedKn: 5, intervalS: 30 },
        { toS: METRICS.cum[4] + 460, speedKn: 2, intervalS: 30 },
        {
          stopS: 240, stopIntervalS: 60, stopSog: 0.1, stopCogRandom: true,
        },
        { toS: METRICS.cum[4] - 400, speedKn: 4, intervalS: 30 },
      ],
    }],
    expect: {
      minTargetPassages: 1,
      noUnknownDuringStop: { bridge: 'Stridsbergsbron', extraS: 60 },
    },
  },
  // U30, motfall: stilla 310 m från bron (TIM-klassen, innanför 350 m) ändras inte.
  {
    name: 'stilla-310m-från-målbron-oförändrad (motfall U30)',
    seed: 4453,
    vessels: [{
      mmsi: '904453101',
      name: 'SYNT-310',
      startS: METRICS.cum[4] + 1700,
      legs: [
        { toS: METRICS.cum[4] + 460, speedKn: 5, intervalS: 30 },
        { toS: METRICS.cum[4] + 310, speedKn: 2, intervalS: 30 },
        {
          stopS: 600, stopIntervalS: 60, stopSog: 0.1, stopCogRandom: true,
        },
        { toS: METRICS.cum[4] - 400, speedKn: 4, intervalS: 30 },
      ],
    }],
    expect: {
      minTargetPassages: 1,
      noUnknownDuringStop: { bridge: 'Stridsbergsbron', extraS: 60 },
    },
  },
  // U30, motfall: köaren i väntzonen (200 m) behåller vänttexten.
  {
    name: 'köare-i-väntzonen-200m-oförändrad (motfall U30)',
    seed: 4454,
    vessels: [{
      mmsi: '904454101',
      name: 'SYNT-VÄNT',
      startS: METRICS.cum[4] + 1700,
      legs: [
        { toS: METRICS.cum[4] + 350, speedKn: 5, intervalS: 30 },
        { toS: METRICS.cum[4] + 200, speedKn: 2, intervalS: 30 },
        {
          stopS: 600, stopIntervalS: 60, stopSog: 0.1, stopCogRandom: true,
        },
        { toS: METRICS.cum[4] - 400, speedKn: 4, intervalS: 30 },
      ],
    }],
    expect: {
      minTargetPassages: 1,
      noUnknownDuringStop: { bridge: 'Stridsbergsbron', extraS: 60 },
    },
  },
  // U30, motfall: GAMMAL POSITION. Stopp 460 m från bron i 4 min, sedan AIS-
  // tystnad i 15 min medan hon ligger kvar, och hon går när hon hörs igen.
  // Utan färsk position går läget aldrig in: de första 8 minuterna av stoppet
  // (före åldersreglernas egen "ETA okänd", som räknas från senaste
  // positionsändringen) får ingen "ETA okänd" komma från den nya regeln.
  {
    name: 'stilla-460m-med-gammal-position-oförändrad (motfall U30)',
    seed: 4455,
    vessels: [{
      mmsi: '904455101',
      name: 'SYNT-GAMMAL',
      startS: METRICS.cum[4] + 1700,
      legs: [
        { toS: METRICS.cum[4] + 610, speedKn: 5, intervalS: 30 },
        { toS: METRICS.cum[4] + 460, speedKn: 2, intervalS: 30 },
        {
          stopS: 240, stopIntervalS: 60, stopSog: 0.1, stopCogRandom: true,
        },
        {
          stopS: 900, stopIntervalS: 900, stopSog: 0.1, stopCogRandom: true,
        },
        { toS: METRICS.cum[4] - 400, speedKn: 4, intervalS: 30 },
      ],
    }],
    expect: {
      noUnknownDuringStop: { bridge: 'Stridsbergsbron', windowS: 480 },
    },
  },
  // U30-revisionen (granskningen 2026-11-15, H2/M1): FARTSPIKAR UTAN
  // FÖRFLYTTNING på en stilla båt med MOGET stillhetsankare (35 min stilla, då
  // överlever VDS:s stillhetsklocka spikarna). 1,5 kn varannan minut i 12 min,
  // sedan går hon. Läget får inte lämnas av ett fartsampel: högst två
  // formbyten (siffra → okänd → siffra vid avgången).
  {
    name: 'stilla-460m-spikar-med-moget-ankare (U30-revisionen)',
    seed: 4456,
    vessels: [{
      mmsi: '904456101',
      name: 'SYNT-SPIKAR',
      startS: METRICS.cum[4] + 1700,
      legs: [
        { toS: METRICS.cum[4] + 610, speedKn: 5, intervalS: 30 },
        { toS: METRICS.cum[4] + 460, speedKn: 2, intervalS: 30 },
        {
          stopS: 2100, stopIntervalS: 60, stopSog: 0.1, stopCogRandom: true,
        },
        ...Array.from({ length: 6 }, () => [
          {
            stopS: 60, stopIntervalS: 60, stopSog: 1.5, stopCogRandom: true,
          },
          {
            stopS: 60, stopIntervalS: 60, stopSog: 0.1, stopCogRandom: true,
          },
        ]).flat(),
        { toS: METRICS.cum[4] - 400, speedKn: 4, intervalS: 30 },
      ],
    }],
    expect: {
      stillUnknown: { bridge: 'Stridsbergsbron', afterS: 420 },
      maxFormChangesPerStop: { bridge: 'Stridsbergsbron', max: 2 },
    },
  },
  // U30-revisionen (H1): KRYPAREN. Stilla 6 min 460 m från bron, sedan kryp i
  // 0,7 kn in mot och genom bron. När hon flyttat sig 60 m (lägets tröskel 50 m
  // plus ett sampel) ska en siffra vara tillbaka, och texten får aldrig gå
  // direkt från "ETA okänd" till "strax".
  {
    name: 'stilla-460m-sedan-kryp-0,7kn-genom-bron (U30-revisionen)',
    seed: 4457,
    vessels: [{
      mmsi: '904457101',
      name: 'SYNT-KRYP',
      startS: METRICS.cum[4] + 1700,
      legs: [
        { toS: METRICS.cum[4] + 610, speedKn: 5, intervalS: 30 },
        { toS: METRICS.cum[4] + 460, speedKn: 2, intervalS: 30 },
        {
          stopS: 360, stopIntervalS: 60, stopSog: 0.1, stopCogRandom: true,
        },
        { toS: METRICS.cum[4] - 400, speedKn: 0.7, intervalS: 30 },
      ],
    }],
    expect: {
      minTargetPassages: 1,
      stillUnknown: { bridge: 'Stridsbergsbron', afterS: 330 },
      numericAfterMoveM: { bridge: 'Stridsbergsbron', moveM: 60, graceS: 30 },
      maxFormChangesPerStop: { bridge: 'Stridsbergsbron', max: 2 },
    },
  },
  // U30-revisionen (M1, färskheten): stilla 460 m i 10 min, men varje fix är en
  // AISHub-fix som levereras 13 min gammal (äldre än AISHUB.MAX_FIX_AGE_MS).
  // Positionen är inte färsk enligt hasFreshPosition, så läget får inte gås in i.
  {
    name: 'stilla-460m-med-gamla-aishub-fix-oförändrad (U30-revisionen)',
    seed: 4458,
    vessels: [{
      mmsi: '904458101',
      name: 'SYNT-GAMLA-FIX',
      startS: METRICS.cum[4] + 1700,
      legs: [
        { toS: METRICS.cum[4] + 610, speedKn: 5, intervalS: 30 },
        { toS: METRICS.cum[4] + 460, speedKn: 2, intervalS: 30 },
        {
          stopS: 600, stopIntervalS: 60, stopSog: 0.1, stopCogRandom: true, fixLagS: 780,
        },
        { toS: METRICS.cum[4] - 400, speedKn: 4, intervalS: 30 },
      ],
    }],
    expect: {
      noUnknownDuringStop: { bridge: 'Stridsbergsbron', extraS: 60 },
    },
  },
  // U30, motfall (omgranskningen 2026-11-16, M-A): KÖ VID EN TIDIGARE BRO.
  // Norrut mot Stridsbergsbron, kö 300 m söder om Järnvägsbron (557 m från
  // Stridsbergsbron) i 10 min, sedan 4 respektive 2 kn. Stillheten är belagd,
  // men vid en kö vid en tidigare bro ska läget inte gå in (kövillkoret,
  // queueBridge): utan villkoret visades "ETA okänd" vid avgången (sanning
  // 4,5/9,0 min) där basen visar en siffra (granskarens prob kö.js).
  ...[
    ['4 kn', 4459, 4],
    ['2 kn', 4460, 2],
  ].map(([label, seed, go]) => ({
    name: `kö-300m-söder-om-järnvägsbron-oförändrad, sedan ${label} (motfall U30)`,
    seed,
    vessels: [{
      mmsi: String(904400000 + seed),
      name: `SYNT-KÖ-${seed}`,
      startS: METRICS.cum[2] - 700,
      legs: [
        { toS: METRICS.cum[3] - 300 - 150, speedKn: 5, intervalS: 30 },
        { toS: METRICS.cum[3] - 300, speedKn: 2, intervalS: 30 },
        {
          stopS: 600, stopIntervalS: 60, stopSog: 0.1, stopCogRandom: true,
        },
        { toS: METRICS.cum[4] + 600, speedKn: go, intervalS: 30 },
      ],
    }],
    expect: {
      noUnknownDuringStop: { bridge: 'Stridsbergsbron', extraS: 60 },
    },
  })),
  // K1 (rättningsomgång 3, 2026-11-16; nattjaktens F16/F17, värld 9530):
  // STOPP STRAX BORTOM MÅLBRON EFTER ETT GLAPP. Båten går i 4,1 kn (AIS säger
  // 5,2) med fast rapporterad kurs, tystnar 400 m före bron och hörs igen
  // först när hon stannat i kön 165 m BORTOM bron: sog 0 och en stillakurs
  // ~44° från den gamla, ~51° fel mot förflyttningen. 589 m på 300 s blir
  // `uncertain_movement`, och stillagrinden (S1) spärrade passagen tills nästa
  // fix 16 min senare: "närmar sig" efter passagen och brotexten pekade på
  // den passerade bron hela kön. PLACERINGEN ÄR TESTET: förflyttningen ska
  // vara över 500 m (annars mellangrenen, ingen osäkerhet) men latitudhoppet
  // under LARGE_JUMP_LAT_DEG (0,005°), annars bokför glappvägen (scenario B)
  // passagen i samma tick och felet syns inte. Kursvärdena hör till seedet
  // (generatorns brus är ±3°); byts seedet ska kursändringen (≤ 45°) och
  // bäringsavvikelsen (> 45°) mätas om.
  ...[
    {
      label: 'söderut genom Stridsbergsbron',
      seed: 9530,
      mmsi: '909530001',
      bro: 'Stridsbergsbron',
      startS: METRICS.cum[4] + 2200,
      broS: METRICS.cum[4],
      dir: -1,
      legCog: 207,
      stopCog: 166.8,
      slutS: METRICS.cum[2] - 400,
    },
    {
      label: 'norrut genom Klaffbron',
      seed: 9531,
      mmsi: '909531001',
      bro: 'Klaffbron',
      startS: METRICS.cum[2] - 2200,
      broS: METRICS.cum[2],
      dir: 1,
      legCog: 25,
      stopCog: 69.6,
      slutS: METRICS.cum[4] + 600,
    },
  ].map((k) => ({
    name: `stopp-165m-bortom-${k.bro}-efter-glapp, ${k.label} (nattjakten F16/F17, K1)`,
    seed: k.seed,
    vessels: [{
      mmsi: k.mmsi,
      name: `SYNT-KÖSTOPP-${k.seed}`,
      startS: k.startS,
      legs: [
        {
          toS: k.broS + k.dir * 165,
          speedKn: 4.1,
          reportSogKn: 5.2,
          cogDeg: k.legCog,
          intervalS: 60,
          gapFromS: k.broS - k.dir * 400,
          gapToS: k.broS + k.dir * 165,
        },
        // En stillafix, nästa fix först 16 min senare (klass B i kö)
        {
          stopS: 960, stopIntervalS: 960, stopSog: 0, stopCogDeg: k.stopCog,
        },
        { toS: k.slutS, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: {
      minTargetPassages: 2,
      noApproachNoticeAfterCrossing: [k.bro],
      // Stillafixen kommer 1 140 s in i resan, nästa fix 2 100 s.
      textCountWindows: [{
        bridge: k.bro, fromS: 1145, toS: 2050, max: 0,
      }],
    },
  })),
  // ---------------------------------------------------------------------
  // FARTÖKNING FÖRE EN NÄRA BRO EMELLAN (sparr, 2026-11-15; F7). Spärren vid
  // Järnvägsbron räknade restiden till Stridsbergsbron i fixets fart, och en
  // båt som tog upp farten efter släppberäkningen fick varningen under 150 s
  // (fältet: NORDIC SOLA 107 s, LIDAN 138 s, LIANNE 157 s, NAVEN 150 s). Ett
  // nytt fix högst 400 m före Järnvägsbron som visar ökning i gång över två fix
  // räknar nu restiden i minst 5 kn (BridgeOpeningService#_accelBeforeNearEarlier).
  // Benen slutar på hela rapportsteg (67 s), så varje fart rapporteras på det
  // fix där den börjar, och AISHub-fixen är 30 s gamla som i fältet. (i) och
  // (ii) fäller basen 6c74eac (138 och 145 s); (v) och (vi) låser skyddet åt
  // andra hållet och är bitlika med basen. Den första versionens (iii)
  // inbromsning och (iv) söderut prövade aldrig regeln (granskningen SPARR-d2,
  // M1) och är borttagna; köerna och vändningen prövas i jest-sviten
  // opening-accel-motfall och varje villkor i opening-accel-rule-villkor.
  {
    // (i) LIDAN-formen: gång utan kö, 3,7 → 2,5 → 3,0 → 3,5 kn mot
    // Järnvägsbron, fixet 500 m före Stridsbergsbron i 3,5 kn, sedan 5,6 kn.
    // Basen släppte på restiden i 3,5 kn: 138 s före korsningen.
    name: 'gång-med-fartökning-före-Järnvägsbron (LIDAN-formen, F7)',
    seed: 5142,
    vessels: [{
      mmsi: '905142001',
      name: 'SYNT-OKNING',
      startS: METRICS.cum[2] - 500,
      legs: (() => {
        const st = (v) => v * 0.5144 * 67;
        const b3 = METRICS.cum[4] - 500;
        const b2 = b3 - st(3.0);
        const A = { intervalS: 67, fixLagS: 30 };
        return [
          { toS: b2 - 3 * st(2.5), speedKn: 3.7, ...A },
          { toS: b2, speedKn: 2.5, ...A },
          { toS: b3, speedKn: 3.0, ...A },
          { toS: b3 + st(3.5), speedKn: 3.5, ...A },
          { toS: METRICS.cum[4] + 400, speedKn: 5.6, ...A },
        ];
      })(),
    }],
    expect: { openingLeadS: { Klaffbron: 150, Stridsbergsbron: 150 } },
  },
  {
    // (ii) NAVEN-formen: kryp i 1,6 kn mot Järnvägsbron, ett fix i 3,8 kn
    // 200 m före bron, sedan 5,5 kn. Basen: 145 s.
    name: 'kryp-med-fartökning-före-Järnvägsbron (NAVEN-formen, F7)',
    seed: 5122,
    vessels: [{
      mmsi: '905122001',
      name: 'SYNT-KRYPOKNING',
      startS: METRICS.cum[2] - 500,
      legs: [
        {
          toS: METRICS.cum[3] - 700, speedKn: 4.0, intervalS: 67, fixLagS: 20,
        },
        {
          toS: METRICS.cum[3] - 200, speedKn: 1.6, intervalS: 67, fixLagS: 20,
        },
        {
          toS: METRICS.cum[3] - 70, speedKn: 3.8, intervalS: 67, fixLagS: 20,
        },
        {
          toS: METRICS.cum[4] + 400, speedKn: 5.5, intervalS: 67, fixLagS: 20,
        },
      ],
    }],
    expect: { openingLeadS: { Klaffbron: 150, Stridsbergsbron: 150 } },
  },
  {
    // (v) Motfall: ett ensamt fix 0,5 kn över marschfarten (3,0 → 3,5 kn,
    // radiobrus som i buggjägarens värld 1068075178-824) 330 m före
    // Järnvägsbron, sedan inbromsning och kö i 9 min. Ökningen syns inte över
    // två fix, så regeln utlöses inte och kön väntas ut som förut.
    name: 'ensamt-fartbrus-före-kö-vid-Järnvägsbron-utlöser-inte (F7, motfall)',
    seed: 5105,
    vessels: [{
      mmsi: '905105001',
      name: 'SYNT-BRUS',
      startS: METRICS.cum[2] - 500,
      legs: [
        {
          toS: METRICS.cum[3] - 330, speedKn: 3.0, intervalS: 67, fixLagS: 20,
        },
        {
          toS: METRICS.cum[3] - 220, speedKn: 3.5, intervalS: 67, fixLagS: 20,
        },
        {
          toS: METRICS.cum[3] - 125, speedKn: 1.6, intervalS: 67, fixLagS: 20,
        },
        {
          stopS: 540, stopIntervalS: 67, stopSog: 0, fixLagS: 20,
        },
        {
          toS: METRICS.cum[4] + 400, speedKn: 4.5, intervalS: 67, fixLagS: 20,
        },
      ],
    }],
    expect: { openingLeadS: { Stridsbergsbron: 150 }, maxOpeningAgeS: { Stridsbergsbron: 400 } },
  },
  {
    // (vi) Låsning av konvojkostnaden: två båtar köar 120 och 160 m före
    // Järnvägsbron och avgår 15 s isär. Följaren får eget kort med minst
    // 150 s (dagens utfall, 180 s). I buggjägaren gav regeln 6 sådana extra
    // kort på 2 000 världar; växer delningen syns det här (fler kort eller
    // kortare ledtid).
    name: 'konvoj-ur-kön-vid-Järnvägsbron-följaren-eget-kort (F7, låsning)',
    seed: 5131,
    vessels: [
      {
        mmsi: '905131001',
        name: 'SYNT-KONVOJ-A',
        startS: METRICS.cum[2] - 300,
        legs: [
          {
            toS: METRICS.cum[3] - 120, speedKn: 3.5, intervalS: 67, fixLagS: 20,
          },
          {
            stopS: 600, stopIntervalS: 67, stopSog: 0, fixLagS: 20,
          },
          {
            toS: METRICS.cum[4] + 400, speedKn: 4.5, intervalS: 67, fixLagS: 20,
          },
        ],
      },
      {
        mmsi: '905131002',
        name: 'SYNT-KONVOJ-B',
        startS: METRICS.cum[2] - 340,
        legs: [
          {
            toS: METRICS.cum[3] - 160, speedKn: 3.5, intervalS: 67, fixLagS: 20,
          },
          {
            stopS: 615, stopIntervalS: 67, stopSog: 0, fixLagS: 20,
          },
          {
            toS: METRICS.cum[4] + 400, speedKn: 4.5, intervalS: 67, fixLagS: 20,
          },
        ],
      },
    ],
    expect: {
      openingLeadS: { Stridsbergsbron: 150 },
      maxOpeningsPerBridge: { Stridsbergsbron: 2 },
    },
  },
  // FÖNSTRET ANKRAS I DEN TIDIGASTE KORSNINGEN (nattjaktens F02 r3, värld
  // 11777, och F23 r2, värld 3603; triagen 2026-11-16 avsnitt 1b). Båda
  // startar norr om Olidebron och varnas tillsammans för Klaffbron: A 1250 m
  // före bron i 5 kn (korsar t ≈ 486 s), B 1300 m före i 4 kn (korsar
  // t ≈ 632 s). A är osedd från 250 m före till 650 m bortom bron, B från
  // 200 m före till 100 m bortom. B hörs bortom bron först (t = 690 s) och
  // bokförs FÖRE A (t = 750 s). C hörs första gången t = 765 s (avbrottet i
  // F02 r3) och korsar 700 s efter A, alltså nästa öppning enligt U2. Förut
  // räknades hon mot B:s korsning (fönstret till ≈ 1232 s) och absorberades
  // utan egen varning; nu prövas hon som ny båt också mot A:s korsning
  // (≈ 1086 s) och får en egen. Motfallet: C korsar 540 s efter A, samma
  // öppning, ingen andra varning. Placeringen ÄR testet.
  ...[
    // [etikett, seed, C:s korsning efter A (s), förväntan]
    ['C 700 s efter A, egen varning', 11777, 700, { ownOpeningLeadS: { Klaffbron: { 911777003: 120 } } }],
    ['C 540 s efter A, samma öppning (motfall)', 11778, 540, { maxOpeningsPerBridge: { Klaffbron: 1 } }],
  ].map(([label, seed, cAfterA, expect]) => {
    const klaff = METRICS.cum[2];
    const v5 = 5 * 0.5144;
    const crossA = 1250 / v5;
    const cStartOffsetS = 765;
    return {
      name: `omvänd-bokföring-efter-avbrott-vid-Klaffbron: ${label} (F02 r3)`,
      seed,
      vessels: [
        {
          mmsi: `9${seed}001`,
          name: 'SYNT-A',
          startS: klaff - 1250,
          legs: [{
            toS: klaff + 1700, speedKn: 5, intervalS: 30, gapFromS: klaff - 250, gapToS: klaff + 650,
          }],
        },
        {
          mmsi: `9${seed}002`,
          name: 'SYNT-B',
          startS: klaff - 1300,
          legs: [{
            toS: klaff + 1700, speedKn: 4, intervalS: 30, gapFromS: klaff - 200, gapToS: klaff + 100,
          }],
        },
        {
          mmsi: `9${seed}003`,
          name: 'SYNT-C',
          startOffsetS: cStartOffsetS,
          startS: klaff - (crossA + cAfterA - cStartOffsetS) * v5,
          legs: [{ toS: klaff + 1700, speedKn: 5, intervalS: 30 }],
        },
      ],
      expect,
    };
  }),
  // U45 (omgång 4): EN ANNAN BÅTS PASSAGE ANVÄNDER DEN VARNADE ÖPPNINGEN.
  // Som BEAUTYFIELD i 20260707-14h: M (söderut) ligger 1 420 m norr om
  // Klaffbron, strax norr om Stridsbergsbron, i 0,8 kn med fix var 6:e minut.
  // Spärren vid Stridsbergsbron löper ut mellan fixen, och Klaffbron varnas för
  // henne långt i förväg. H (norrut) går igenom Klaffbron vid t ≈ 767 s. M
  // ligger kvar och går sedan i 4,5 kn genom alla tre broarna. I huvudfallet
  // korsar hon Klaffbron mer än 600 s efter H och ska få en egen varning i tid
  // (förut ingen: bara en egen medlems passage stängde händelsen och en varnad
  // medlem hade ingen släppväg). I motfallet korsar hon inom 600 s efter H
  // (samma öppning) och får ingen andra varning. Placeringen ÄR testet.
  ...[
    // [etikett, seed, M:s stopp (s), förväntan]
    // Huvudfallet: varningen ska komma efter H:s passage. M ligger kvar i
    // ytterligare cirka 10 min efter släppet, och spärren vid Stridsbergsbron
    // löper ut mellan hennes glesa fix, så den nya varningen kommer cirka
    // 17 min före hennes korsning (maxAgeS 1200). Basens enda varning kom
    // 29 min före.
    ['M korsar långt efter H, egen varning', 4501, 1200,
      { ownOpeningLeadS: { Klaffbron: { 904501001: { minLeadS: 120, maxAgeS: 1200 } } } }],
    ['M korsar inom 600 s efter H, samma öppning (motfall)', 4502, 280, { maxOpeningsPerBridge: { Klaffbron: 2 } }],
  ].map(([label, seed, stopS, expect]) => {
    const klaff = METRICS.cum[2];
    return {
      name: `annan-båts-passage-använder-den-varnade-öppningen-vid-Klaffbron: ${label} (U45)`,
      seed,
      vessels: [
        {
          mmsi: `90${seed}001`,
          name: 'SYNT-M',
          startS: klaff + 1500,
          legs: [
            { toS: klaff + 1420, speedKn: 3, intervalS: 60 },
            {
              stopS, stopIntervalS: 360, stopSog: 0.8,
            },
            { toS: klaff - 700, speedKn: 4.5, intervalS: 60 },
          ],
        },
        {
          mmsi: `90${seed}002`,
          name: 'SYNT-H',
          startOffsetS: 300,
          startS: klaff - 1200,
          legs: [{ toS: klaff + 500, speedKn: 5, intervalS: 30 }],
        },
      ],
      expect,
    };
  }),
  // Nattjakten F12 (rättningsomgång 3, 2026-11-16; värld 2931, HAVSORN):
  // RIKTNINGSFÄLTET EFTER EN U-SVÄNG NÄR MÅLBRON FÖRSVANN I VÄNTANS FIX.
  // Söderut genom Stridsbergsbron och Järnvägsbron, vändning 450 m norr om
  // Klaffbron. Den första omvända fixen (39°) sätter Fix D:s väntan, två fixar
  // i dödbandet (68° och 70°) bryter den, och manöverskyddet håller målbron
  // till 150 s efter vändningen. Fixen 70° (efter skyddet) startar fristen,
  // fixen 35° sätter väntan igen och tar bort målbron (MOVING_AWAY, 70 s), och
  // fixen 27° är den andra omvända observationen i följd, 190 m före
  // Järnvägsbron. Förut prövades den aldrig (Fix D kräver målbro): låset stod
  // kvar söderut till återkorsningen, notisen "närmar sig Järnvägsbron" fick
  // riktningen söderut och Stridsbergsbrons returvarning kom först vid
  // återkorsningen av Järnvägsbron. PLACERINGEN ÄR TESTET: fristen måste
  // starta efter skyddet och löpa ut på fixen 35°, och fixen 27° måste ligga
  // inom 300 m från Järnvägsbron. Ändras skyddets längd eller fristen ska
  // tiderna räknas om, inte förväntan tas bort.
  // Motfallet (U18): en fix till i dödbandet mellan 35° och 27° bryter kedjan,
  // och notisen bär det gamla låsets riktning som förut (känd gräns).
  ...[
    { label: 'andra omvända fixen i följd', seed: 2931, mismatches: 0 },
    { label: 'dödbandsfix emellan, U18 oförändrad', seed: 2932, mismatches: 1 },
  ].map((k) => ({
    name: `u-sväng-målbron-borta-i-väntans-fix, ${k.label} (nattjakten F12)`,
    seed: k.seed,
    vessels: [{
      mmsi: String(902900000 + k.seed),
      name: `SYNT-F12-${k.seed}`,
      startS: METRICS.cum[4] + 900,
      legs: [
        { toS: METRICS.cum[2] + 450, speedKn: 5, intervalS: 65 },
        {
          toS: METRICS.cum[2] + 470, speedKn: 3.1, intervalS: 70, cogDeg: 39,
        },
        {
          toS: METRICS.cum[2] + 560, speedKn: 1.5, reportSogKn: 3.8, intervalS: 120, cogDeg: 68,
        },
        {
          toS: METRICS.cum[2] + 650, speedKn: 2.6, reportSogKn: 3.6, intervalS: 70, cogDeg: 70,
        },
        {
          toS: METRICS.cum[2] + 770, speedKn: 3.5, intervalS: 70, cogDeg: 35,
        },
        ...(k.mismatches === 0 ? [] : [{
          toS: METRICS.cum[2] + 810, speedKn: 3.6, intervalS: 25, cogDeg: 70,
        }]),
        {
          toS: METRICS.cum[2] + (k.mismatches === 0 ? 890 : 930), speedKn: 3.6, intervalS: 70, cogDeg: 27,
        },
        { toS: METRICS.cum[4] + 800, speedKn: 5, intervalS: 65 },
      ],
    }],
    expect: {
      minNotifiedPerBridge: { Järnvägsbron: 2 },
      noticeDirectionVsTruth: { Järnvägsbron: { mismatches: k.mismatches } },
      ...(k.mismatches === 0 ? { openingLeadS: { Stridsbergsbron: 120 } } : {}),
    },
  })),
  // U33 (F20, fältkörning 3: NINA BRES, LIDAN, SYLVIA): notisen byggs på
  // fixets första beräkning och texten på den andra 25 ms senare. I 3,5–4,5 kn
  // gav nästan varje enbåtsresa "om 3" (söderut vid Stridsbergsbron "om 4")
  // i notisen i samma ögonblick som texten bytte till "strax" vid 300 m.
  // Notisen säger nu restiden i båtens fart när den är under 3 min (söderut
  // vid Stridsbergsbron 297 m i 3,5 kn: "om 3", sanningen 2,8).
  {
    name: 'notis-följer-strax-nord (U33)',
    seed: 3301,
    vessels: [{
      mmsi: '901033001', direction: 'north', speedKn: 4, reportIntervalS: 60,
    }],
    expect: {
      minTargetPassages: 2,
      noticeFollowsTravelTime: ['Klaffbron', 'Stridsbergsbron'],
    },
  },
  {
    name: 'notis-följer-strax-syd (U33)',
    seed: 3302,
    vessels: [{
      mmsi: '901033002', direction: 'south', speedKn: 3.5, reportIntervalS: 60,
    }],
    expect: {
      minTargetPassages: 2,
      noticeFollowsTravelTime: ['Klaffbron', 'Stridsbergsbron'],
    },
  },
  // Motfallet: i 2 kn tar de sista 300 m över 4 min. Texten säger "strax"
  // inom 300 m, men notisen behåller sin siffra (beslutets fartvillkor).
  {
    name: 'notis-behåller-siffran-långsam (U33)',
    seed: 3303,
    vessels: [{
      mmsi: '901033003', direction: 'south', speedKn: 2, reportIntervalS: 60,
    }],
    expect: {
      minTargetPassages: 2,
      noticeMinEta: { Klaffbron: 3, Stridsbergsbron: 3 },
    },
  },
  // U37 del 1 (rättningsomgång 3, 2026-11-16; nattjaktens F15, värld 16704):
  // RETUR VID TÄT KADENS, KORSNINGSFIXEN INOM 30 m OCH SEDAN TYSTNAD. Båten
  // passerar bron, vänder 176 m bortom och går tillbaka i 5,8 kn med 15–20 s
  // kadens. Fixen före korsningen ligger 35 m på bortre sidan, korsningsfixen
  // 20 s senare ~25 m ut på ankomstsidan, och nästa fix kommer först ~410 s
  // senare, 1,2 km bort. U14 krävde 30 m ut vid tät kadens: returnotisen kom
  // vid nästa fix, ~7 min sent. PLACERINGEN ÄR TESTET: korsningsfixen ska
  // ligga entydigt (> 10 m) men under 30 m ut, och tystnaden börja direkt
  // efter den. Benen startar vid bortre-sidans fix, så rutnätet är fast.
  // Fältmotsvarigheten är aisstream klass A (fältets p97–98 för 421 s).
  ...[
    {
      label: 'norrut ut, söderut tillbaka genom Klaffbron',
      seed: 16704,
      bro: 'Klaffbron',
      broS: METRICS.cum[2],
      dir: 1,
    },
    {
      label: 'söderut ut, norrut tillbaka genom Stridsbergsbron',
      seed: 16705,
      bro: 'Stridsbergsbron',
      broS: METRICS.cum[4],
      dir: -1,
    },
  ].map((k) => ({
    name: `retur-tät-kadens-korsningsfix-25m-sedan-tystnad, ${k.label} (nattjakten F15, U37)`,
    seed: k.seed,
    vessels: [{
      mmsi: `9${k.seed}001`,
      name: `SYNT-RETUR-${k.seed}`,
      startS: k.broS - k.dir * 1500,
      legs: [
        { toS: k.broS + k.dir * 176, speedKn: 5.8, intervalS: 15 },
        { toS: k.broS + k.dir * 35, speedKn: 5.8, intervalS: 15 },
        {
          toS: k.broS - k.dir * 1300,
          speedKn: 5.8,
          intervalS: 20,
          gapFromS: k.broS - k.dir * 40,
          gapToS: k.broS - k.dir * 1240,
        },
      ],
    }],
    expect: {
      minPassagesPerBridge: { [k.bro]: 2 },
      minNotifiedPerBridge: { [k.bro]: 2 },
      maxNotifiedPerBridge: { [k.bro]: 2 },
      maxNoticeDelayS: { [k.bro]: 60 },
    },
  })),
  // U37 del 2 (rättningsomgång 3, 2026-11-16; granskningen av K1, L1): FORMEN
  // PÅ EN SEN PASSAGENOTIS. Båten går norrut i 5 kn med 30 s kadens, tystnar
  // 400 m före Klaffbron och hörs igen 200 m bortom bron: tystnad ~233 s,
  // korsningen ~78 s före fixen. Bron bokförs i den fixen (S4), och notisen
  // sa "har precis passerat" om en korsning över en minut tidigare. Formregeln
  // (U14 rev. 3, nu för alla vägar) säger "passerade … under AIS-tystnad".
  {
    name: 'glapp-233s-över-Klaffbron-sen-passagenotis (U37 del 2)',
    seed: 16707,
    vessels: [{
      mmsi: '916707001',
      name: 'SYNT-SENFORM',
      startS: METRICS.cum[2] - 1500,
      legs: [{
        toS: METRICS.cum[2] + 900,
        speedKn: 5,
        intervalS: 30,
        gapFromS: METRICS.cum[2] - 400,
        gapToS: METRICS.cum[2] + 190,
      }],
    }],
    expect: { minTargetPassages: 1, noticeForms: { Klaffbron: ['tyst'] } },
  },
  // U37 del 2, spegeln: glapp på 180 s som slutar ~11 m bortom
  // Stallbackabron i 10 kn (latitudhoppet över 0,005°; mellanbron bokförs inte
  // i fixen, så glappvägen BN2 ger formen). Korsningen ligger några sekunder före fixen, så
  // formregeln säger "har precis passerat"; förut gav glappvägen alltid
  // "passerade … under AIS-tystnad" (HEY JOE i 20260713-41h: 180 s, fixen 11 m
  // bortom Stallbackabron, korsningen 4 s före). Benet börjar vid fixen före
  // glappet, så rutnätet ger fixen bortom bron 180 s senare.
  {
    name: 'glapp-180s-slutar-11m-bortom-Stallbackabron (U37 del 2)',
    seed: 16708,
    vessels: [{
      mmsi: '916708001',
      name: 'SYNT-PRECISFORM',
      startS: METRICS.cum[5] + 2000,
      legs: [
        { toS: METRICS.cum[5] + 915, speedKn: 10, intervalS: 30 },
        {
          toS: METRICS.cum[5] - 1300,
          speedKn: 10,
          intervalS: 30,
          gapFromS: METRICS.cum[5] + 900,
          gapToS: METRICS.cum[5] - 5,
        },
      ],
    }],
    expect: { noticeForms: { Stallbackabron: ['precis'] } },
  },
  // U37 del 1, motfall: VÄNDER, GÅR TILLBAKA I 5,8 kn OCH STANNAR PÅ LINJEN
  // vid tät kadens (10 s) med ±10 m brus, ligger där i 10 min och vänder sedan
  // bort igen. Sanningen är EN passage. Inbromsningen sker i benet före
  // stoppet, så stillafixarna rapporterar 0,1 kn och slumpad kurs: korsningsfixen
  // i transitfart (U37 del 1) får aldrig uppstå. Passagelogikens falska
  // bokföring vid linjen ger INV-5 som i U14-vakterna ovan.
  {
    name: 'vänder-och-stannar-på-Klaffbrons-linje-tät-AIS-efter-5,8kn (U37-vakt)',
    seed: 16706,
    vessels: [{
      mmsi: '916706001',
      name: 'SYNT-LINJESTOPP',
      jitterM: 10,
      startS: METRICS.cum[2] - 900,
      legs: [
        { toS: METRICS.cum[2] + 176, speedKn: 5.8, intervalS: 10 },
        { toS: METRICS.cum[2] + 40, speedKn: 5.8, intervalS: 10 },
        { toS: METRICS.cum[2], speedKn: 1.5, intervalS: 10 },
        { stopS: 600, stopIntervalS: 10, stopCogRandom: true },
        { toS: METRICS.cum[2] + 900, speedKn: 5, intervalS: 10 },
      ],
    }],
    expect: {
      minNotifiedBridges: ['Klaffbron'],
      maxNotifiedPerBridge: { Klaffbron: 1 },
      toleratedInvariants: [/^MISSAD MÅLBRO-NOTIS: \d{9}:Klaffbron — /],
    },
  },
  // U40 (N4, 2026-11-16): SAMMA STOPP, MEN ANALYSEN DÖMDE GPS-HOPP. Båten går
  // i 6,5 kn och tystnar 400 m före bron; första fixen kommer när hon stannat
  // 165 m bortom bron, med sog 0 och en stillakurs ~42° från den gamla och
  // ~50° fel mot förflyttningen. 757 m på 240 s är 6,3 kn i snitt: både
  // bäringen och snittfarten (> 5 kn mot sog 0) ser "fel" ut, poängen hamnar
  // under 0,4 och fixen dömdes som GPS-hopp (`likely_gps_error`), så K1:s
  // undantag nåddes aldrig. Passagen kom först med nästa fix 16 min senare och
  // brotexten pekade på den passerade bron hela kön. Kursvärdena hör till
  // seedet (brus ±3°); byts seedet ska kursändringen (≤ 45°) och
  // bäringsavvikelsen (> 45°) mätas om.
  ...[
    {
      label: 'söderut genom Stridsbergsbron',
      seed: 9540,
      mmsi: '909540001',
      bro: 'Stridsbergsbron',
      startS: METRICS.cum[4] + 2200,
      broS: METRICS.cum[4],
      dir: -1,
      legCog: 207,
      stopCog: 165.8,
      slutS: METRICS.cum[2] - 400,
    },
    {
      label: 'norrut genom Klaffbron',
      seed: 9541,
      mmsi: '909541001',
      bro: 'Klaffbron',
      startS: METRICS.cum[2] - 2200,
      broS: METRICS.cum[2],
      dir: 1,
      legCog: 30,
      stopCog: 72.8,
      slutS: METRICS.cum[4] + 600,
    },
  ].map((k) => ({
    name: `stopp-165m-bortom-${k.bro}-efter-glapp-i-6,5-kn, ${k.label} (U40, N4)`,
    seed: k.seed,
    vessels: [{
      mmsi: k.mmsi,
      name: `SYNT-HOPPSTOPP-${k.seed}`,
      startS: k.startS,
      legs: [
        {
          toS: k.broS + k.dir * 165,
          speedKn: 6.5,
          cogDeg: k.legCog,
          intervalS: 60,
          gapFromS: k.broS - k.dir * 400,
          gapToS: k.broS + k.dir * 165,
        },
        // En stillafix, nästa fix först 16 min senare (klass B i kö)
        {
          stopS: 960, stopIntervalS: 960, stopSog: 0, stopCogDeg: k.stopCog,
        },
        { toS: k.slutS, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: {
      minTargetPassages: 2,
      noApproachNoticeAfterCrossing: [k.bro],
      // Första notisen för bron senast 120 s efter den sanna korsningen
      // (stillafixen kommer ~25 s efter korsningen; förut 16 min).
      maxNoticeDelayS: { [k.bro]: 120 },
      // Stillafixen kommer 720 s in i resan, nästa fix 1 680 s.
      textCountWindows: [{
        bridge: k.bro, fromS: 725, toS: 1630, max: 0,
      }],
    },
  })),
  // F04 (rättningsomgång 3, 2026-11-16; nattjaktens värld 19721): BÅTEN SOM
  // LÄMNAR KANALEN OCH VÄNDER TILLBAKA. Hon går ut norrut genom
  // Stallbackabron i 9,5 kn, saktar in och vänder 430 m bortom bron och kommer
  // tillbaka i 4,5–8,8 kn. Återinträdesspärren (10 min efter avslutad resa)
  // kastade varje position: varningen för Stridsbergsbron kom 136 s före
  // korsningen och Stallbackabron fick bara en sen "passerade … under
  // AIS-tystnad". PLACERINGEN ÄR TESTET: resan avslutas cirka 300 m bortom
  // bron (STALLBACKABRON_EXIT_LAT), så vändningen måste ligga längre ut än så,
  // och rutten norr om bron (en rak förlängning) lämnar boxen österut efter
  // cirka 330 m. Fixarna bortom bron ligger därför 50–110 m västerut i sidled
  // (lateralM); sidledet går nästan längs broaxeln och flyttar inte sidan om
  // brolinjen.
  {
    name: 'återvändare-bortom-Stallbackabron (nattjakten F04)',
    seed: 19721,
    vessels: [{
      mmsi: '901972101',
      name: 'SYNT-ÅTERVÄNDARE-N',
      startS: METRICS.cum[1] - 300,
      legs: [
        { toS: METRICS.cum[5] + 150, speedKn: 9.5, intervalS: 30 },
        {
          toS: METRICS.cum[5] + 300, speedKn: 8, intervalS: 30, lateralM: -50,
        },
        {
          toS: METRICS.cum[5] + 430, speedKn: 4, intervalS: 30, lateralM: -110,
        },
        {
          stopS: 30, stopIntervalS: 30, stopSog: 1.4, stopCogDeg: 195, lateralM: -110,
        },
        {
          toS: METRICS.cum[5] + 310, speedKn: 4.5, intervalS: 30, lateralM: -110,
        },
        {
          toS: METRICS.cum[5] + 150, speedKn: 8.5, intervalS: 30, lateralM: -50,
        },
        { toS: METRICS.cum[2] - 300, speedKn: 8.8, intervalS: 30 },
      ],
    }],
    expect: {
      openingLeadS: { Stridsbergsbron: 180 },
      approachNoticeLeadS: { Stallbackabron: 30 },
    },
  },
  // F04, söderut: samma mekanism vid Olidebron. Resan söderut avslutas först
  // söder om KANALINFARTEN_EXIT_LAT (~830 m bortom Olidebron), och vägen
  // tillbaka till Klaffbron är så kort att spärren åt upp notiserna för
  // Kanalinfarten och Olidebron och varningen för Klaffbron (5 s före
  // korsningen). Utfarten går västsydväst, så "mot bron" mäts mot brolinjen,
  // inte mot ett kompassband.
  {
    name: 'återvändare-söder-om-Olidebron (nattjakten F04, söderut)',
    seed: 19722,
    vessels: [{
      mmsi: '901972201',
      name: 'SYNT-ÅTERVÄNDARE-S',
      startS: METRICS.cum[5] + 250,
      legs: [
        { toS: METRICS.cum[1] - 1000, speedKn: 8, intervalS: 30 },
        {
          stopS: 30, stopIntervalS: 30, stopSog: 1.4, stopCogDeg: 120,
        },
        { toS: METRICS.cum[4] + 400, speedKn: 8, intervalS: 30 },
      ],
    }],
    expect: {
      openingLeadS: { Klaffbron: 180 },
      approachNoticeLeadS: { Olidebron: 30 },
    },
  },
  // Motfall F04: båten vänder bortom Stallbackabron men ligger sedan och
  // vobblar (0,6 kn, slumpad kurs) i 15 min innan hon går vidare norrut.
  // Ingen position går mot bron i 2 kn, så spärren står kvar som förut: ingen
  // ny notis för Stallbackabron och ingen båt mot Stridsbergsbron i texten
  // medan spärren gäller (resan avslutas cirka 1 100 s in). När spärren löpt
  // ut (1 830 s) skapas hon som förut, med "om 120 minuter"; det är dagens
  // beteende för en stilla båt bortom bron och inte prövat här.
  {
    name: 'utfart-norrut-ligger-still-bortom-Stallbackabron (motfall F04)',
    seed: 19723,
    vessels: [{
      mmsi: '901972301',
      name: 'SYNT-UTFART-STILLA',
      startS: METRICS.cum[1] - 300,
      legs: [
        { toS: METRICS.cum[5] + 150, speedKn: 9.5, intervalS: 30 },
        {
          toS: METRICS.cum[5] + 300, speedKn: 8, intervalS: 30, lateralM: -50,
        },
        {
          toS: METRICS.cum[5] + 430, speedKn: 4, intervalS: 30, lateralM: -110,
        },
        {
          stopS: 900, stopIntervalS: 30, stopSog: 0.6, stopCogRandom: true, lateralM: -110,
        },
        {
          toS: METRICS.cum[5] + 900, speedKn: 6, intervalS: 30, lateralM: -110,
        },
      ],
    }],
    expect: {
      maxNotifiedPerBridge: { Stallbackabron: 1 },
      textCountWindows: [{
        bridge: 'Stridsbergsbron', fromS: 1150, toS: 1800, max: 0,
      }],
    },
  },
  // Motfall F04 (granskarens D): båten vänder bortom Stallbackabron, går
  // tillbaka mot bron i 3 kn (rapporterat 2,9–3,1) i drygt en minut (130 m)
  // och vänder sedan ut igen. Med 2 kn och 50 m släpptes hon och stod 90 s i
  // texten "på väg mot Stridsbergsbron"; med 3 kn och 100 m netto släpps hon
  // inte, och utfallet är basens.
  {
    name: 'utfart-norrut-vänder-in-och-ut-igen (motfall F04)',
    seed: 19724,
    vessels: [{
      mmsi: '901972401',
      name: 'SYNT-UTFART-VÄNDER-IGEN',
      startS: METRICS.cum[1] - 300,
      legs: [
        { toS: METRICS.cum[5] + 150, speedKn: 9.5, intervalS: 30 },
        {
          toS: METRICS.cum[5] + 300, speedKn: 8, intervalS: 30, lateralM: -50,
        },
        {
          toS: METRICS.cum[5] + 430, speedKn: 4, intervalS: 30, lateralM: -110,
        },
        {
          stopS: 30, stopIntervalS: 30, stopSog: 1.4, stopCogDeg: 195, lateralM: -110,
        },
        {
          toS: METRICS.cum[5] + 300, speedKn: 3, intervalS: 30, lateralM: -110,
        },
        {
          stopS: 30, stopIntervalS: 30, stopSog: 1.0, stopCogDeg: 20, lateralM: -110,
        },
        {
          toS: METRICS.cum[5] + 900, speedKn: 6, intervalS: 30, lateralM: -110,
        },
      ],
    }],
    expect: {
      maxNotifiedPerBridge: { Stallbackabron: 1 },
      textCountWindows: [{
        bridge: 'Stridsbergsbron', fromS: 1440, toS: 1700, max: 0,
      }],
    },
  },
  // === Granskningen av N5 (2026-11-16): motfall till F04-släppet ===
  // Alla börjar med en vanlig utfart norrut genom Stallbackabron och vänder
  // 430 m bortom bron (sidled som i återvändarscenariot ovan). Ingen av dem
  // korsar bron tillbaka. Med 2 kn och 50 m släpptes E, E2, H, J och K och
  // gav falska notiser och spöktext; med 3 kn och 100 m netto är utfallet
  // basens. F är den kända gränsen.
  ...[
    {
      tag: 'E', seed: 7101, mmsi: '907100101', till: 250, fran: 900, tillS: 1130,
    },
    {
      tag: 'E2', seed: 7102, mmsi: '907100201', till: 150, fran: 900, tillS: 1220,
    },
  ].map((k) => ({
    name: `driver-i-2,2kn-mot-Stallbackabron-till-${k.till}m-och-ut (motfall F04, granskningens ${k.tag})`,
    seed: k.seed,
    vessels: [{
      mmsi: k.mmsi,
      name: `DRIV-${k.tag}`,
      startS: METRICS.cum[2] + 300,
      legs: [
        { toS: METRICS.cum[5] + 150, speedKn: 9.5, intervalS: 30 },
        {
          toS: METRICS.cum[5] + 300, speedKn: 8, intervalS: 30, lateralM: -50,
        },
        {
          toS: METRICS.cum[5] + 430, speedKn: 4, intervalS: 30, lateralM: -110,
        },
        {
          stopS: 30, stopIntervalS: 30, stopSog: 0.5, stopCogDeg: 215, lateralM: -110,
        },
        {
          toS: METRICS.cum[5] + k.till, speedKn: 2.2, intervalS: 30, lateralM: -110,
        },
        {
          stopS: 60, stopIntervalS: 30, stopSog: 0.3, stopCogRandom: true, lateralM: -110,
        },
        {
          toS: METRICS.cum[5] + 900, speedKn: 6, intervalS: 30, lateralM: -110,
        },
      ],
    }],
    expect: {
      maxNotifiedPerBridge: { Stallbackabron: 1 },
      textCountWindows: [{
        bridge: 'Stridsbergsbron', fromS: k.fran, toS: k.tillS, max: 0,
      }],
    },
  })),
  {
    // Granskningens H: ut söderut genom Olidebron, manövrerar 200 m tillbaka
    // mot bron i 2,5 kn till en kaj och ligger still.
    name: 'kajmanöver-2,5kn-söder-om-Olidebron (motfall F04, granskningens H)',
    seed: 7106,
    vessels: [{
      mmsi: '907100601',
      name: 'KAJ-H',
      startS: METRICS.cum[2] + 300,
      legs: [
        { toS: METRICS.cum[0] + 300, speedKn: 7, intervalS: 30 },
        {
          stopS: 60, stopIntervalS: 30, stopSog: 0.3, stopCogRandom: true,
        },
        { toS: METRICS.cum[0] + 500, speedKn: 2.5, intervalS: 30 },
        {
          stopS: 1500, stopIntervalS: 60, stopSog: 0.1, stopCogRandom: true,
        },
      ],
    }],
    expect: {
      maxNotifiedPerBridge: { Olidebron: 1 },
      textCountWindows: [{
        bridge: 'Klaffbron', fromS: 930, toS: 1160, max: 0,
      }],
    },
  },
  {
    // Granskningens J: ankrad 430 m bortom Stallbackabron (0,3 kn) med ETT
    // brusigt positionspar mitt i stoppet: sog 2,1, kurs mot bron och den
    // andra positionen 60 m närmare linjen. Med 2 kn och 50 m släpptes hon
    // och stod 7 min i texten "på väg mot Stridsbergsbron, om 36–43 minuter".
    name: 'ankrad-bortom-Stallbackabron-ett-brusigt-positionspar (motfall F04, granskningens J)',
    seed: 7202,
    vessels: [{
      mmsi: '907200201',
      name: 'HOPP-J',
      startS: METRICS.cum[2] + 300,
      legs: [
        { toS: METRICS.cum[5] + 150, speedKn: 9.5, intervalS: 30 },
        {
          toS: METRICS.cum[5] + 300, speedKn: 8, intervalS: 30, lateralM: -50,
        },
        {
          toS: METRICS.cum[5] + 430, speedKn: 4, intervalS: 30, lateralM: -110,
        },
        {
          stopS: 600, stopIntervalS: 30, stopSog: 0.3, stopCogRandom: true, lateralM: -110,
        },
        {
          toS: METRICS.cum[5] + 900, speedKn: 6, intervalS: 30, lateralM: -110,
        },
      ],
    }],
    patchSamples: (samples) => {
      const stop = samples.filter((r) => r.mmsi === '907200201' && r.lat > 58.3125 && r.sog < 1);
      const a = stop[6];
      const b = stop[7];
      a.sog = 2.1;
      a.cog = 215;
      b.sog = 2.1;
      b.cog = 215;
      const brg = (35.6 * Math.PI) / 180;
      b.lat = a.lat - (60 * Math.cos(brg)) / 111320;
      b.lon = a.lon - (60 * Math.sin(brg)) / (111320 * Math.cos((a.lat * Math.PI) / 180));
    },
    expect: {
      maxNotifiedPerBridge: { Stallbackabron: 1 },
      textCountWindows: [{
        bridge: 'Stridsbergsbron', fromS: 1000, toS: 1460, max: 0,
      }],
    },
  },
  {
    // Granskningens K: som E (drift i 2,2 kn mot bron till 200 m) plus en
    // riktig båt söderut mot Stridsbergsbron. Den riktiga båtens notiser och
    // varningar ska stå kvar, och texten ska bara räkna henne.
    name: 'drift-mot-Stallbackabron-och-en-riktig-båt-söderut (motfall F04, granskningens K)',
    seed: 7203,
    vessels: [
      {
        mmsi: '907200301',
        name: 'DRIV-K',
        startS: METRICS.cum[2] + 300,
        legs: [
          { toS: METRICS.cum[5] + 150, speedKn: 9.5, intervalS: 30 },
          {
            toS: METRICS.cum[5] + 300, speedKn: 8, intervalS: 30, lateralM: -50,
          },
          {
            toS: METRICS.cum[5] + 430, speedKn: 4, intervalS: 30, lateralM: -110,
          },
          {
            stopS: 30, stopIntervalS: 30, stopSog: 0.5, stopCogDeg: 215, lateralM: -110,
          },
          {
            toS: METRICS.cum[5] + 200, speedKn: 2.2, intervalS: 30, lateralM: -110,
          },
          {
            stopS: 60, stopIntervalS: 30, stopSog: 0.3, stopCogRandom: true, lateralM: -110,
          },
          {
            toS: METRICS.cum[5] + 900, speedKn: 6, intervalS: 30, lateralM: -110,
          },
        ],
      },
      {
        mmsi: '907200302',
        name: 'ANNAN-K',
        startS: METRICS.cum[5] - 200,
        startOffsetS: 700,
        legs: [{ toS: METRICS.cum[2] - 300, speedKn: 6, intervalS: 30 }],
      },
    ],
    expect: {
      // DRIV-K:s utfart och ANNAN-K:s passage söderut (som i basen).
      maxNotifiedPerBridge: { Stallbackabron: 2 },
      expectedOpenings: ['Stridsbergsbron'],
      textCountWindows: [{
        bridge: 'Stridsbergsbron', fromS: 920, toS: 1160, max: 1,
      }],
    },
  },
  {
    // Granskningens F: båten vänder bortom Stallbackabron, går mot bron i
    // 3,5 kn in till 180 m och vänder ut igen. Med golvet 3 kn släpptes hon och
    // fick "VAND-F närmar sig Stallbackabron, beräknad ankomst om 3 minuter";
    // med 4,5 kn är utfallet basens.
    name: 'vänder-in-till-180m-i-3,5kn-och-ut-igen (motfall F04, granskningens F)',
    seed: 7103,
    vessels: [{
      mmsi: '907100301',
      name: 'VAND-F',
      startS: METRICS.cum[2] + 300,
      legs: [
        { toS: METRICS.cum[5] + 150, speedKn: 9.5, intervalS: 30 },
        {
          toS: METRICS.cum[5] + 300, speedKn: 8, intervalS: 30, lateralM: -50,
        },
        {
          toS: METRICS.cum[5] + 430, speedKn: 4, intervalS: 30, lateralM: -110,
        },
        {
          stopS: 30, stopIntervalS: 30, stopSog: 1.4, stopCogDeg: 195, lateralM: -110,
        },
        {
          toS: METRICS.cum[5] + 180, speedKn: 3.5, intervalS: 30, lateralM: -110,
        },
        {
          stopS: 30, stopIntervalS: 30, stopSog: 1.0, stopCogDeg: 20, lateralM: -110,
        },
        {
          toS: METRICS.cum[5] + 900, speedKn: 6, intervalS: 30, lateralM: -110,
        },
      ],
    }],
    expect: {
      maxNotifiedPerBridge: { Stallbackabron: 1 },
      textCountWindows: [{
        bridge: 'Stridsbergsbron', fromS: 880, toS: 1400, max: 0,
      }],
    },
  },
  // Granskningens andra varv (N1, N1b, N2): båtar strax över golvet 3 kn som
  // släpptes utan att korsa. Med 4,5 kn är utfallet basens.
  ...[
    {
      tag: 'N1', seed: 7301, mmsi: '907300101', till: 280, tillS: 1100,
    },
    {
      tag: 'N1b', seed: 7302, mmsi: '907300201', till: 150, tillS: 1160,
    },
  ].map((k) => ({
    // N1 fick "DRIV31-A närmar sig Stallbackabron, beräknad ankomst om 35
    // minuter" 300 m från bron (ETA:n var den till Stridsbergsbron), N1b
    // "… om 3 minuter", och båda stod 2–3 min i texten.
    name: `driver-i-3,1kn-mot-Stallbackabron-till-${k.till}m-och-ut (motfall F04, granskningens ${k.tag})`,
    seed: k.seed,
    vessels: [{
      mmsi: k.mmsi,
      name: `DRIV31-${k.tag}`,
      startS: METRICS.cum[2] + 300,
      legs: [
        { toS: METRICS.cum[5] + 150, speedKn: 9.5, intervalS: 30 },
        {
          toS: METRICS.cum[5] + 300, speedKn: 8, intervalS: 30, lateralM: -50,
        },
        {
          toS: METRICS.cum[5] + 430, speedKn: 4, intervalS: 30, lateralM: -110,
        },
        {
          stopS: 30, stopIntervalS: 30, stopSog: 0.5, stopCogDeg: 215, lateralM: -110,
        },
        {
          toS: METRICS.cum[5] + k.till, speedKn: 3.1, intervalS: 30, lateralM: -110,
        },
        {
          stopS: 60, stopIntervalS: 30, stopSog: 0.3, stopCogRandom: true, lateralM: -110,
        },
        {
          toS: METRICS.cum[5] + 900, speedKn: 6, intervalS: 30, lateralM: -110,
        },
      ],
    }],
    expect: {
      maxNotifiedPerBridge: { Stallbackabron: 1 },
      textCountWindows: [{
        bridge: 'Stridsbergsbron', fromS: 940, toS: k.tillS, max: 0,
      }],
    },
  })),
  {
    // N2: ankrad 430 m bortom bron med TRE brusiga positioner i rad (3,2 kn,
    // kurs mot bron, 55 m var). Med golvet 3 kn släpptes hon och stod 4,5 min
    // i texten "på väg mot Stridsbergsbron, om 26 minuter".
    name: 'ankrad-bortom-Stallbackabron-tre-brusiga-positioner (motfall F04, granskningens N2)',
    seed: 7304,
    vessels: [{
      mmsi: '907300401',
      name: 'ANKAR3',
      startS: METRICS.cum[2] + 300,
      legs: [
        { toS: METRICS.cum[5] + 150, speedKn: 9.5, intervalS: 30 },
        {
          toS: METRICS.cum[5] + 300, speedKn: 8, intervalS: 30, lateralM: -50,
        },
        {
          toS: METRICS.cum[5] + 430, speedKn: 4, intervalS: 30, lateralM: -110,
        },
        {
          stopS: 600, stopIntervalS: 30, stopSog: 0.3, stopCogRandom: true, lateralM: -110,
        },
        {
          toS: METRICS.cum[5] + 900, speedKn: 6, intervalS: 30, lateralM: -110,
        },
      ],
    }],
    patchSamples: (samples) => {
      const stop = samples.filter((r) => r.mmsi === '907300401' && r.lat > 58.3125 && r.sog < 1);
      const base = stop[6];
      const brg = (35.6 * Math.PI) / 180;
      for (let k = 0; k < 3; k++) {
        const r = stop[6 + k];
        r.sog = 3.2;
        r.cog = 215;
        r.lat = base.lat - (55 * k * Math.cos(brg)) / 111320;
        r.lon = base.lon - (55 * k * Math.sin(brg)) / (111320 * Math.cos((base.lat * Math.PI) / 180));
      }
    },
    expect: {
      maxNotifiedPerBridge: { Stallbackabron: 1 },
      textCountWindows: [{
        bridge: 'Stridsbergsbron', fromS: 1000, toS: 1400, max: 0,
      }],
    },
  },
  // KÄND GRÄNS (docs/ARCHITECTURE.md, återinträdesspärren): en båt som
  // verkligen går mot bron i 5 kn från 430 till 250 m bortom Stallbackabron
  // släpps (kedjan når 100 m netto) och får notisen "VAND5 närmar sig
  // Stallbackabron, beräknad ankomst om 2 minuter", fast hon sedan vänder ut
  // (VAND5) eller stannar (STOPP5). Det är samma slags utfall som för en ny
  // båt som kommer norrifrån och stannar 250 m före bron (basen: samma notis,
  // texten i 40 min och en varning för Stridsbergsbron på deadline; varningens
  // eta och tiden till "ETA okänd" skiljer). Låset: en enda
  // extra notis för Stallbackabron, och för VAND5 ingen båt i texten efter
  // att hon vänt ut.
  ...[
    {
      tag: 'VAND5',
      seed: 7501,
      mmsi: '907500101',
      slut: [
        {
          stopS: 30, stopIntervalS: 30, stopSog: 1.0, stopCogDeg: 20, lateralM: -110,
        },
        {
          toS: METRICS.cum[5] + 900, speedKn: 6, intervalS: 30, lateralM: -110,
        },
      ],
      fonster: [{
        bridge: 'Stridsbergsbron', fromS: 1030, toS: 1300, max: 0,
      }],
      // När hon vänder ut stiger ETA:n i texten 16 → 22 min på 30 s (INV-3
      // ETA-SÅGTAND UPP). Texten följer båten; det är en del av den kända
      // gränsen, inte en egen fråga här.
      tolerera: [/^ETA-SÅGTAND UPP: \S+ Stridsbergsbron 16→22 på \d+s$/],
    },
    {
      tag: 'STOPP5',
      seed: 7502,
      mmsi: '907500201',
      slut: [{
        stopS: 900, stopIntervalS: 60, stopSog: 0.1, stopCogRandom: true, lateralM: -110,
      }],
      fonster: [],
      tolerera: [],
    },
  ].map((k) => ({
    name: `går-mot-Stallbackabron-i-5kn-till-250m-${k.tag === 'VAND5' ? 'och-vänder-ut' : 'och-stannar'} (känd gräns F04)`,
    seed: k.seed,
    vessels: [{
      mmsi: k.mmsi,
      name: k.tag,
      startS: METRICS.cum[2] + 300,
      legs: [
        { toS: METRICS.cum[5] + 150, speedKn: 9.5, intervalS: 30 },
        {
          toS: METRICS.cum[5] + 300, speedKn: 8, intervalS: 30, lateralM: -50,
        },
        {
          toS: METRICS.cum[5] + 430, speedKn: 4, intervalS: 30, lateralM: -110,
        },
        {
          stopS: 30, stopIntervalS: 30, stopSog: 1.4, stopCogDeg: 195, lateralM: -110,
        },
        {
          toS: METRICS.cum[5] + 250, speedKn: 5, intervalS: 30, lateralM: -110,
        },
        ...k.slut,
      ],
    }],
    expect: {
      maxNotifiedPerBridge: { Stallbackabron: 2 },
      textCountWindows: k.fonster,
      toleratedInvariants: k.tolerera,
    },
  })),
  // N6 (granskningen av N2, sidofyndet): FÖRVARNINGEN PÅ EN POSITION BORTOM
  // BRON VÄNDE BROBESÖKET. Granskarens bana: söderut i 5 kn med 120 s kadens,
  // fixarna ~280 m norr om Järnvägsbron och sedan ~25 m söder om den, där
  // förvarningen går ut ("beräknad ankomst strax", vid bron, står kvar). Båten
  // fortsätter 176 m söderut, vänder, ligger 4 m söder om linjen i 300 s och
  // går sedan tillbaka norrut genom bron. Besöket fick bortre sidan norr (fel),
  // och den verkliga returen gav ingen notis. PLACERINGEN ÄR TESTET: benen och
  // kadensen ger förvarningsfixen bortom linjen (granskarens svep, 48 av 48).
  {
    name: 'förvarning-25m-bortom-Järnvägsbron-120s-sedan-retur-norrut (N6)',
    seed: 73316,
    vessels: [{
      mmsi: '973316001',
      name: 'SYNT-N6-RETUR',
      startS: METRICS.cum[3] + 900,
      legs: [
        { toS: METRICS.cum[3] - 176, speedKn: 5, intervalS: 120 },
        { toS: METRICS.cum[3] - 4, speedKn: 3.5, intervalS: 120 },
        { stopS: 300, stopIntervalS: 120, stopCogRandom: true },
        { toS: METRICS.cum[3] + 900, speedKn: 4, intervalS: 120 },
      ],
    }],
    expect: {
      minNotifiedPerBridge: { Järnvägsbron: 2 },
      maxNotifiedPerBridge: { Järnvägsbron: 2 },
      noticeForms: { Järnvägsbron: ['närmar', 'precis'] },
    },
  },
  // N6 (ägarfråga F9): EN NY BÅT SOM SYNS FÖRST 150 m EFTER STALLBACKABRON på
  // väg söderut i 6 kn. Svepets portgissning notifierar bron som passerad, men
  // närhetsnotisen gick först i förvarningsform ("närmar sig Stallbackabron,
  // beräknad ankomst om 1 minut"; NEST i 20260713-41h, 248 m efter bron). Nu
  // passerad form, och meningen följer U37 del 2 med okänd tystnad räknad som
  // tystnad (U44): 150 m i 6 kn är ~49 s efter korsningen, "har precis passerat".
  {
    name: 'ny-båt-först-sedd-150m-efter-Stallbackabron-söderut (N6)',
    seed: 73401,
    vessels: [{
      mmsi: '973401001',
      name: 'SYNT-N6-NY',
      startS: METRICS.cum[5] - 150,
      legs: [{ toS: METRICS.cum[4] + 800, speedKn: 6, intervalS: 30 }],
    }],
    expect: { noticeForms: { Stallbackabron: ['precis'] } },
  },
  // Samma båt först sedd 250 m efter bron: ~81 s efter korsningen, mer än
  // "precis passerat"-fönstret, alltså "passerade … under AIS-tystnad".
  {
    name: 'ny-båt-först-sedd-250m-efter-Stallbackabron-söderut (N6)',
    seed: 73405,
    vessels: [{
      mmsi: '973405001',
      name: 'SYNT-N6-NY250',
      startS: METRICS.cum[5] - 250,
      legs: [{ toS: METRICS.cum[4] + 800, speedKn: 6, intervalS: 30 }],
    }],
    expect: { noticeForms: { Stallbackabron: ['tyst'] } },
  },
  // N6, granskningens H1 (U44), motfall: EN BÅT SOM DRIVER BORT FRÅN BRON PÅ
  // TILLFARTSSIDAN OCH SEDAN GÅR IGENOM. Ny båt 140 m söder om Olidebron driver
  // söderut till 230 m i 0,8 kn (kursen och ruttlåset säger söderut), väntar
  // 240 s och går sedan norrut genom bron i 4 kn. Sanningen är EN passage.
  // Utan vakten fick besöket bortre sidan söder och passagen blev ett
  // retursläpp: två notiser (granskarens driftsvep 44 av 60). Tät kadens.
  {
    name: 'driver-bort-söder-om-Olidebron-sedan-genom-30s (N6-H1, motfall)',
    seed: 73403,
    vessels: [{
      mmsi: '973403001',
      name: 'SYNT-N6-DRIFT',
      startS: METRICS.cum[1] - 140,
      legs: [
        { toS: METRICS.cum[1] - 230, speedKn: 0.8, intervalS: 30 },
        {
          stopS: 240, stopIntervalS: 30, stopSog: 0.6, stopCogRandom: true,
        },
        { toS: METRICS.cum[1] + 700, speedKn: 4, intervalS: 30 },
      ],
    }],
    expect: { maxNotifiedPerBridge: { Olidebron: 1 } },
  },
  // Samma vid gles kadens: driver 1 kn bort från Klaffbron och korsar sedan
  // utan någon position i fart före bron (120 s), granskarens "hopp"-svep
  // (16 av 20 med två notiser utan vakten).
  {
    name: 'driver-bort-söder-om-Klaffbron-sedan-genom-120s (N6-H1, motfall)',
    seed: 73404,
    vessels: [{
      mmsi: '973404001',
      name: 'SYNT-N6-HOPP',
      startS: METRICS.cum[2] - 140,
      legs: [
        { toS: METRICS.cum[2] - 200, speedKn: 1, intervalS: 60 },
        { toS: METRICS.cum[2] + 900, speedKn: 4, intervalS: 120 },
      ],
    }],
    expect: { maxNotifiedPerBridge: { Klaffbron: 1 } },
  },
  // N6, motfall: samma båt först sedd 30 m efter bron. Inom appens gräns för
  // "vid bron" (70 m) betyder "beräknad ankomst strax" i praktiken nu, och
  // förvarningen står kvar (JOY i 20260713-41h, 15 m).
  {
    name: 'ny-båt-först-sedd-30m-efter-Stallbackabron-vid-bron (N6, motfall)',
    seed: 73402,
    vessels: [{
      mmsi: '973402001',
      name: 'SYNT-N6-VIDBRON',
      startS: METRICS.cum[5] - 30,
      legs: [{ toS: METRICS.cum[4] + 800, speedKn: 6, intervalS: 30 }],
    }],
    expect: { noticeForms: { Stallbackabron: ['närmar'] } },
  },
  // U46 (dirigentens beslut 2026-11-17, BN1-BOXKANT): EN BÅT SOM LÄMNAR KANALEN
  // UTÅT VID EN YTTERPUNKT UTAN TVÅ FIXAR ÖVER 350 m har avslutat sitt besök.
  // PRICKBJORN i fältet 13/11: norrut genom Stallbackabron i 10 kn, sista fixen
  // 288 m norr om bron, tyst i 6,5 h, tillbaka söderut utan förvarning (besöket
  // stod öppet; U14:s retursläpp gav "har precis passerat" först efter bron).
  // Här lämnar banan boxens östkant (12,32) cirka 330 m norr om bron. Nu
  // stänger utåtbeviset följt av tystnad besöket, och återkomsten får sin
  // förvarning vid första fixen inom 300 m.
  {
    name: 'utfärd-norr-om-Stallbackabron-tyst-6h-åter-söderut (U46)',
    seed: 74601,
    vessels: [{
      mmsi: '274601001',
      name: 'SYNT-U46-STALL',
      startS: METRICS.cum[5] - 1500,
      legs: [
        { toS: METRICS.cum[5] + 300, speedKn: 10, intervalS: 65 },
        {
          toS: METRICS.cum[5] + 1150, speedKn: 0.08, gapFromS: METRICS.cum[5] + 300, gapToS: METRICS.cum[5] + 1150,
        },
        // Boxens östkant korsar rutten cirka 330 m norr om bron: inga fixar utanför.
        {
          toS: METRICS.cum[5] - 1500, speedKn: 10, intervalS: 65, gapFromS: METRICS.cum[5] + 1150, gapToS: METRICS.cum[5] + 330,
        },
      ],
    }],
    expect: {
      minNotifiedPerBridge: { Stallbackabron: 2 },
      maxNotifiedPerBridge: { Stallbackabron: 2 },
      noticeForms: { Stallbackabron: ['närmar', 'närmar'] },
    },
  },
  // U46, Kanalinfarten (S/V REBEL i 20260806-42h): söderut ut förbi punkten i
  // 4,5 kn, sista fixen på den yttre sidan, tyst i 6 h, tillbaka norrut. Före
  // U46 stod besöket öppet och återkomsten fick ingen Kanalinfartsnotis.
  {
    name: 'utfärd-söder-om-Kanalinfarten-tyst-6h-åter-norrut (U46)',
    seed: 74602,
    vessels: [{
      mmsi: '274602001',
      name: 'SYNT-U46-KANAL',
      startS: METRICS.cum[1] + 400,
      legs: [
        { toS: S_KANALINFARTEN - 300, speedKn: 4.5, intervalS: 60 },
        {
          toS: 0, speedKn: 0.05, gapFromS: S_KANALINFARTEN - 300, gapToS: 0,
        },
        {
          toS: METRICS.cum[1] + 400, speedKn: 5, intervalS: 60, gapFromS: 0, gapToS: S_KANALINFARTEN - 450,
        },
      ],
    }],
    expect: {
      minNotifiedPerBridge: { Kanalinfarten: 2 },
      maxNotifiedPerBridge: { Kanalinfarten: 2 },
    },
  },
  // U46, motfall (ELFKUNGEN i 20260806-42h och 20260909-80h): ut förbi
  // Kanalinfarten och in till en kaj strax utanför zonkanten, förtöjd i 90 min
  // med en fix var 3:e minut, sedan norrut genom zonen. Hon hörs i zonen direkt
  // efter utåtparet, så besöket står kvar (besöksregeln 2026-09-07: förtöjning
  // är ingen utfärd). Utan tystnadsvillkoret gav utåtparet en andra notis vid
  // kajen ("har passerat Kanalinfarten"), mätt i 42h: elva båtar.
  {
    name: 'ut-förbi-Kanalinfarten-och-förtöjd-vid-zonkanten (U46, motfall)',
    seed: 74603,
    vessels: [{
      mmsi: '274603001',
      name: 'SYNT-U46-KAJ',
      startS: METRICS.cum[1] + 400,
      legs: [
        { toS: S_KANALINFARTEN - 270, speedKn: 4.5, intervalS: 60 },
        // 90 min: under U51:s 2 h, så att motfallet prövar tilläggningen efter
        // utåtparet och inte en förtöjd avgång (se U51-scenarierna nedan).
        {
          stopS: 90 * 60, stopIntervalS: 180, stopSog: 0, stopCogDeg: 275,
        },
        { toS: METRICS.cum[1] + 400, speedKn: 5, intervalS: 60 },
      ],
    }],
    expect: { maxNotifiedPerBridge: { Kanalinfarten: 1 } },
  },
  // U46, motfall: samma tilläggning, men AIS är tyst i 12 min direkt efter
  // utåtparet (glesa AISHub-fixar vid kajen; ELFKUNGEN hade glapp på upp till
  // 45 min där). Hon hörs igen stilla på samma plats: det är ingen återkomst.
  {
    name: 'ut-förbi-Kanalinfarten-förtöjd-tyst-12min-direkt (U46, motfall)',
    seed: 74605,
    vessels: [{
      mmsi: '274605001',
      name: 'SYNT-U46-KAJTYST',
      startS: METRICS.cum[1] + 400,
      legs: [
        { toS: S_KANALINFARTEN - 270, speedKn: 4.5, intervalS: 60 },
        // 90 min: under U51:s 2 h, så att motfallet prövar tilläggningen efter
        // utåtparet och inte en förtöjd avgång (se U51-scenarierna nedan).
        {
          stopS: 90 * 60, stopIntervalS: 180, stopSog: 0, stopCogDeg: 275,
        },
        { toS: METRICS.cum[1] + 400, speedKn: 5, intervalS: 60 },
      ],
    }],
    // De fyra första kajfixarna (12 min) försvinner.
    patchSamples(samples) {
      const first = samples.findIndex((x) => x.sog < 0.5);
      samples.splice(first, 4);
    },
    expect: { maxNotifiedPerBridge: { Kanalinfarten: 1 } },
  },
  // U46, motfall (granskningen M1): en nordgående båt INNE I KANALEN på väg mot
  // Stallbackabron går utåt längs axeln i 5 kn men ligger på den inre sidan
  // (söder om bron). AIS är tyst i 14 min 112 m före bron, och hon hörs igen
  // 40 m före den. Utan kravet på den yttre sidan blev det ett utåtbevis, tystnaden
  // en utfärd och fixen på inre sidan en återkomst: en andra förvarning för
  // samma passage. (Vid Kanalinfarten stoppar FP8:s sydgrind den andra notisen
  // för en återfödd båt, så fallet prövas vid Stallbackabron.)
  {
    name: 'norrut-mot-Stallbackabron-tyst-14min-på-inre-sidan (U46, motfall)',
    seed: 74606,
    vessels: [{
      mmsi: '274606001',
      name: 'SYNT-U46-INRE',
      startS: METRICS.cum[5] - 1500,
      legs: [
        // Notisen 266 m före bron, sista fixen före tystnaden 112 m före bron.
        { toS: METRICS.cum[5] - 100, speedKn: 5, intervalS: 60 },
        {
          toS: METRICS.cum[5] - 40, speedKn: 0.15, gapFromS: METRICS.cum[5] - 100, gapToS: METRICS.cum[5] - 40,
        },
        // Boxens östkant korsar rutten cirka 330 m norr om bron.
        { toS: METRICS.cum[5] + 300, speedKn: 5, intervalS: 60 },
      ],
    }],
    expect: { maxNotifiedPerBridge: { Stallbackabron: 1 } },
  },
  // U46, motfall (granskningen M1): som `utfärd-söder-om-Kanalinfarten-…` men
  // de sista fixarna på den yttre sidan rapporterar kurs 30° (inåt) fast båten
  // går utåt. En kurs mot kanalen är inget utåtbevis: besöket står kvar, och
  // återkomsten 6 h senare får ingen ny notis (som före U46).
  {
    name: 'ut-söder-om-Kanalinfarten-med-kurs-inåt-tyst-6h (U46, motfall)',
    seed: 74607,
    vessels: [{
      mmsi: '274607001',
      name: 'SYNT-U46-KURS',
      startS: METRICS.cum[1] + 400,
      legs: [
        { toS: S_KANALINFARTEN - 60, speedKn: 4.5, intervalS: 60 },
        {
          toS: S_KANALINFARTEN - 300, speedKn: 4.5, intervalS: 60, cogDeg: 30,
        },
        {
          toS: 0, speedKn: 0.05, gapFromS: S_KANALINFARTEN - 300, gapToS: 0,
        },
        {
          toS: METRICS.cum[1] + 400, speedKn: 5, intervalS: 60, gapFromS: 0, gapToS: S_KANALINFARTEN - 450,
        },
      ],
    }],
    expect: { maxNotifiedPerBridge: { Kanalinfarten: 1 } },
  },
  // U46, motfall (granskningen M1): ut på den yttre sidan i 37 m per fix
  // (1,2 kn, AIS rapporterar 2,5 kn), tyst 6 h, tillbaka. Under 50 m utåt mellan
  // två fixar är inget utåtbevis.
  {
    name: 'ut-söder-om-Kanalinfarten-37m-per-fix-tyst-6h (U46, motfall)',
    seed: 74608,
    vessels: [{
      mmsi: '274608001',
      name: 'SYNT-U46-SAKTA',
      startS: METRICS.cum[1] + 400,
      legs: [
        { toS: S_KANALINFARTEN - 60, speedKn: 4.5, intervalS: 60 },
        {
          toS: S_KANALINFARTEN - 300, speedKn: 1.2, reportSogKn: 2.5, intervalS: 60,
        },
        {
          toS: 0, speedKn: 0.05, gapFromS: S_KANALINFARTEN - 300, gapToS: 0,
        },
        {
          toS: METRICS.cum[1] + 400, speedKn: 5, intervalS: 60, gapFromS: 0, gapToS: S_KANALINFARTEN - 450,
        },
      ],
    }],
    expect: { maxNotifiedPerBridge: { Kanalinfarten: 1 } },
  },
  // U46, motfall: vänder strax utanför Kanalinfarten och går tillbaka in medan
  // hon hörs. Besöksregeln gäller oförändrad: ingen ny notis.
  {
    name: 'vänder-strax-utanför-Kanalinfarten (U46, motfall)',
    seed: 74604,
    vessels: [{
      mmsi: '274604001',
      name: 'SYNT-U46-VAND',
      startS: METRICS.cum[1] + 400,
      legs: [
        { toS: S_KANALINFARTEN - 260, speedKn: 4.5, intervalS: 60 },
        { toS: METRICS.cum[1] + 400, speedKn: 4.5, intervalS: 60 },
      ],
    }],
    expect: { maxNotifiedPerBridge: { Kanalinfarten: 1 } },
  },
  // U51 (dirigentens beslut 2026-11-17, F8 alternativ (c)): EN BÅT SOM LEGAT
  // FÖRTÖJD MINST 2 h VID EN YTTERPUNKT FÅR EN NY NOTIS NÄR HON LÄGGER UT.
  // PRICKBJORN i fältet 13/11: förtöjd vid lotskajen 166 m från Kanalinfarten
  // sedan kvällen före, lade ut norrut 06:47 och fick ingen notis (besöket från
  // ankomsten stod öppet). Här som ELFKUNGEN: ut söderut förbi Kanalinfarten,
  // förtöjd 3 h på den yttre sidan med en fix var 3:e minut, sedan norrut in i
  // kanalen.
  {
    name: 'förtöjd-3h-vid-Kanalinfarten-avgång-norrut (U51)',
    seed: 75101,
    vessels: [{
      mmsi: '975101001',
      name: 'SYNT-U51-KAJ3H',
      startS: METRICS.cum[1] + 400,
      legs: [
        { toS: S_KANALINFARTEN - 150, speedKn: 5, intervalS: 60 },
        {
          stopS: 3 * 3600, stopIntervalS: 180, stopSog: 0, stopCogDeg: 172,
        },
        { toS: METRICS.cum[1] + 400, speedKn: 5, intervalS: 60 },
      ],
    }],
    expect: {
      minNotifiedPerBridge: { Kanalinfarten: 2 },
      maxNotifiedPerBridge: { Kanalinfarten: 2 },
    },
  },
  // U51, motfall: samma båt förtöjd 1 h 30 min. Under 2 h är det väntan, inte
  // förtöjning: ingen ny notis (besöksregeln 2026-09-07).
  {
    name: 'förtöjd-1h30-vid-Kanalinfarten-avgång-norrut (U51, motfall)',
    seed: 75102,
    vessels: [{
      mmsi: '975102001',
      name: 'SYNT-U51-KAJ90',
      startS: METRICS.cum[1] + 400,
      legs: [
        { toS: S_KANALINFARTEN - 150, speedKn: 5, intervalS: 60 },
        {
          stopS: 90 * 60, stopIntervalS: 180, stopSog: 0, stopCogDeg: 172,
        },
        { toS: METRICS.cum[1] + 400, speedKn: 5, intervalS: 60 },
      ],
    }],
    expect: { maxNotifiedPerBridge: { Kanalinfarten: 1 } },
  },
  // U51, motfall: förtöjd 3 h långt ut, byter kajplats 120 m mot punkten i
  // 2,5 kn, ligger 1 h och går sedan ut ur kanalen söderut. Kajbytet når inte
  // avgångsbandet (50 m från linjen): ingen ny notis.
  {
    name: 'förtöjd-3h-byter-kajplats-och-går-söderut (U51, motfall)',
    seed: 75103,
    vessels: [{
      mmsi: '975103001',
      name: 'SYNT-U51-KAJBYTE',
      startS: METRICS.cum[1] + 400,
      legs: [
        // Kajerna ligger norr om utfartslatituden (58,2653) och inom zonen;
        // längre söderut stänger en borttagning med fullbordad resa besöket.
        { toS: S_KANALINFARTEN - 230, speedKn: 5, intervalS: 60 },
        {
          stopS: 3 * 3600, stopIntervalS: 180, stopSog: 0, stopCogDeg: 172,
        },
        { toS: S_KANALINFARTEN - 110, speedKn: 2.5, intervalS: 60 },
        {
          stopS: 3600, stopIntervalS: 180, stopSog: 0, stopCogDeg: 172,
        },
        { toS: 0, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: { maxNotifiedPerBridge: { Kanalinfarten: 1 } },
  },
  // U44 punkt 3 (omgång 4): EN LÅNGSAM BÅT SOM FÖRST HÖRS BORTOM EN BRO i
  // notisens riktning får ingen förvarning om den bron förrän riktningen är
  // belagd. HALIFAX (20260708-21h): första position 194 m söder om Olidebron i
  // 1,1 kn med kursen söderut, 265 m i 0,7 kn, sedan tyst i åtta minuter och
  // 160 m söder om bron norrut i 4,2 kn. Förut "närmar sig Olidebron, beräknad
  // ankomst om 6 minuter" söderut vid första positionen; nu en förvarning
  // norrut när hon går mot bron. PLACERINGEN ÄR TESTET: driften ligger på
  // tillfartssidan och kursen pekar bort från bron.
  {
    name: 'driver-bort-söder-om-Olidebron-tyst-sedan-norrut-genom (U44:3, HALIFAX)',
    seed: 74401,
    vessels: [{
      mmsi: '274401001',
      name: 'SYNT-U44-HALIFAX',
      startS: METRICS.cum[1] - 194,
      legs: [
        { toS: METRICS.cum[1] - 265, speedKn: 0.9, intervalS: 150 },
        {
          toS: METRICS.cum[1] - 170, speedKn: 0.25, intervalS: 60, gapFromS: METRICS.cum[1] - 266, gapToS: METRICS.cum[1] - 171,
        },
        { toS: METRICS.cum[1] + 700, speedKn: 4.2, intervalS: 60 },
      ],
    }],
    expect: {
      maxNotifiedPerBridge: { Olidebron: 1 },
      noticeForms: { Olidebron: ['närmar'] },
      noticeDirections: { Olidebron: ['northbound'] },
    },
  },
  // Samma båt, men hon korsar bron i ett glapp: driften bort i 0,8 kn, sedan
  // ingen position förrän 150 m norr om bron i 4,5 kn. Ingen position i fart
  // före bron. Hon ska få passagenotisen enligt U37 del 2 (glappet är längre
  // än 130 s och notisen kommer mer än 60 s efter korsningen: tystnadsformen),
  // inte tystnad och inte förvarningen söderut som förut.
  {
    name: 'driver-bort-söder-om-Olidebron-korsar-i-glapp (U44:3)',
    seed: 74402,
    vessels: [{
      mmsi: '274402001',
      name: 'SYNT-U44-GLAPP',
      startS: METRICS.cum[1] - 150,
      legs: [
        { toS: METRICS.cum[1] - 210, speedKn: 0.8, intervalS: 60 },
        {
          toS: METRICS.cum[1] + 900, speedKn: 4.5, intervalS: 30, gapFromS: METRICS.cum[1] - 215, gapToS: METRICS.cum[1] + 145,
        },
      ],
    }],
    expect: { noticeForms: { Olidebron: ['tyst'] } },
  },
  // EUGENIE (20260804-both-21h): hörs först 230 m norr om Klaffbron och glider
  // norrut i krypfart ut ur notisradien. Hon korsade aldrig Klaffbron; förut
  // "närmar sig Klaffbron, beräknad ankomst om 5 minuter".
  {
    name: 'hörs-först-norr-om-Klaffbron-krypfart-norrut-korsar-aldrig (U44:3, EUGENIE)',
    seed: 74403,
    vessels: [{
      mmsi: '274403001',
      name: 'SYNT-U44-EUGENIE',
      startS: METRICS.cum[2] + 230,
      legs: [{ toS: METRICS.cum[2] + 340, speedKn: 1.5, intervalS: 60 }],
    }],
    expect: { forbiddenNotifiedBridges: ['Klaffbron'] },
  },
  // Samma, men hon sätter fart norrut medan Klaffbron ännu ligger inom 300 m:
  // riktningen blir belagd och bron ligger bakom henne. Utan regelns andra
  // del kom samma osanna förvarning en position senare.
  {
    name: 'hörs-först-norr-om-Klaffbron-krypfart-sedan-fart-norrut (U44:3)',
    seed: 74404,
    vessels: [{
      mmsi: '274404001',
      name: 'SYNT-U44-ACCEL',
      startS: METRICS.cum[2] + 90,
      legs: [
        { toS: METRICS.cum[2] + 120, speedKn: 1.0, intervalS: 60 },
        { toS: METRICS.cum[3] - 300, speedKn: 5, intervalS: 30 },
      ],
    }],
    expect: { forbiddenNotifiedBridges: ['Klaffbron'] },
  },
  // Motfall: kryper fram i kö mot Klaffbron på rätt sida i 1 kn, väntar 70 m
  // före bron och går sedan igenom. Förvarningen norrut kommer som förut.
  {
    name: 'kryper-i-kö-mot-Klaffbron-norrut-väntar-går-igenom (U44:3, motfall)',
    seed: 74405,
    vessels: [{
      mmsi: '274405001',
      name: 'SYNT-U44-KO',
      startS: METRICS.cum[2] - 280,
      legs: [
        { toS: METRICS.cum[2] - 70, speedKn: 1.0, intervalS: 60 },
        {
          stopS: 300, stopIntervalS: 60, stopSog: 0.3, stopCogRandom: true,
        },
        { toS: METRICS.cum[2] + 700, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: {
      maxNotifiedPerBridge: { Klaffbron: 1 },
      noticeForms: { Klaffbron: ['närmar'] },
      noticeDirections: { Klaffbron: ['northbound'] },
    },
  },
  // Granskningen av D3 (H1): FEL RUTTLÅS FÖR EN BÅT SOM VERKLIGEN NÄRMAR SIG.
  // Båten kryper i 1,5 kn söderut mot Klaffbron från 290 m norr om bron. Första
  // positionen rapporterar kursen 30° (brus i krypfart) och ger ruttlåset
  // norrut; resten ~210°. Hon väntar 60 m före bron och går igenom i 4 kn.
  // Låset vänder först i fart, så notisens riktning säger norrut och bron
  // ligger "bakom" henne: regel (a) höll inne förvarningen under hela
  // inflygningen och väntan och släppte den först i fart, under en minut före
  // korsningen (granskarens värld i 1 kn: 29 s). Nu går den ut när kursen och
  // förflyttningen båda visar att hon rör sig mot bron (riktningen är låsets,
  // som förut). PLACERINGEN ÄR TESTET: tillfartssidan, ett omvänt kursvärde
  // först.
  {
    name: 'kryper-mot-Klaffbron-söderut-fel-ruttlås-ur-första-kursen (U44:3, H1)',
    seed: 74406,
    vessels: [{
      mmsi: '274406001',
      name: 'SYNT-U44-FELLAS',
      startS: METRICS.cum[2] + 290,
      legs: [
        {
          toS: METRICS.cum[2] + 260, speedKn: 1.5, intervalS: 60, cogDeg: 30,
        },
        { toS: METRICS.cum[2] + 60, speedKn: 1.5, intervalS: 60 },
        {
          stopS: 240, stopIntervalS: 60, stopSog: 0.3, stopCogRandom: true,
        },
        { toS: METRICS.cum[2] - 700, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: {
      maxNotifiedPerBridge: { Klaffbron: 1 },
      noticeLeadS: { Klaffbron: 300 },
    },
  },
  // Omgång 5 (granskningen av D3 varv 2, fel 1): SAMMA FEL LÅS VID TÄT
  // RAPPORTERING I KRYPFART. Som scenariot ovan, men en position var 12:e
  // sekund och utan GPS-brus: 9 m per position i 1,5 kn. Varv 2 krävde 10 m
  // närmare linjen sedan föregående position; undantaget släppte aldrig och
  // förvarningen kom 29 s före korsningen. Nu jämförs med spärrens ankare, och
  // förvarningen går ut när hon ligger 30 m närmare än det. PLACERINGEN ÄR
  // TESTET: kadensen och jitterM 0. Ingen dubblettgräns: med fel lås kan
  // vändningen vid passagen ge en andra förvarning (riktningsflippen), också på
  // `7633653`; det är inte den här mekanismen. (1 kn på 10 s gav textflapp-WARN
  // och 0,9 kn på 20 s ETA-WARN ur det felaktiga låset, på alla kodrötter.)
  {
    name: 'kryper-mot-Klaffbron-söderut-fel-ruttlås-tät-kadens-utan-brus (U44:3, varv 2 fel 1)',
    seed: 81001,
    vessels: [{
      mmsi: '274407001',
      name: 'SYNT-U44-TATKRYP',
      jitterM: 0,
      startS: METRICS.cum[2] + 290,
      legs: [
        {
          toS: METRICS.cum[2] + 285, speedKn: 1.5, intervalS: 12, cogDeg: 30,
        },
        { toS: METRICS.cum[2] + 60, speedKn: 1.5, intervalS: 12 },
        {
          stopS: 240, stopIntervalS: 30, stopSog: 0.3, stopCogRandom: true,
        },
        { toS: METRICS.cum[2] - 700, speedKn: 4, intervalS: 30 },
      ],
    }],
    expect: { noticeLeadS: { Klaffbron: 300 } },
  },
  // Omgång 5 (granskningen av D3 varv 2, fel 2): EN STILLA BÅT BORTOM BRON
  // MED GPS-BRUS OCH KURSEN MOT BRON. Båten hörs 120 m norr om Klaffbron på
  // väg bort i 0,8 kn (ruttlåset norrut), ligger sedan i 10 minuter 150 m norr
  // om bron i 0,6 kn med kursen mot bron och ±8 m brus, och går därefter bort
  // norrut. Hon korsar aldrig Klaffbron. Varv 2 släppte förvarningen när två
  // brusfixar råkade ligga 10 m isär mot bron; på `7633653` kommer den falska
  // notisen direkt. Nu släpper bruset inte 30 m närmare än ankaret. (Med 10–15 m
  // brus ger den stilla båten en ETA-WARN ur låset på alla kodrötter; ±12 m
  // prövas i jest-testet.)
  {
    name: 'ligger-still-norr-om-Klaffbron-kursen-mot-bron-gps-brus (U44:3, varv 2 fel 2)',
    seed: 81206,
    vessels: [{
      mmsi: '274408001',
      name: 'SYNT-U44-BRUSSTILL',
      jitterM: 8,
      startS: METRICS.cum[2] + 120,
      legs: [
        { toS: METRICS.cum[2] + 150, speedKn: 0.8, intervalS: 30 },
        {
          stopS: 600, stopIntervalS: 30, stopSog: 0.6, stopCogDeg: 209,
        },
        { toS: METRICS.cum[2] + 900, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: { forbiddenNotifiedBridges: ['Klaffbron'] },
  },
  // U57 (2026-11-23, D1 förs inte in): VERKLIGA RETURER STRAX BORTOM BRON
  // BOKFÖRS. Båten passerar under ett glapp, ligger 15 m bortom Järnvägsbron
  // söderut med sog 0 (osäker, S1 håller passagen) och vänder norrut i 1,5 kn.
  // Bron är inte bokförd, så återkorsningsvägen nås inte, och under 2 kn
  // bekräftar Fix D inte vändningen. En regel som stoppade passagen på
  // returfixen tog bort "har precis passerat Järnvägsbron", "närmar sig
  // Stridsbergsbron" och öppningsvarningen.
  // Vid Järnvägsbron väntas bara passagenotisen: positionen 15 m BORTOM bron
  // med sog 0 gav förut dessutom "närmar sig Järnvägsbron" söderut, en falsk
  // förvarning för en bro hon redan hade bakom sig. U44 punkt 3 håller inne
  // den (en långsam båt bortom en bro får ingen förvarning förrän riktningen
  // är belagd); allt annat i scenariot är oförändrat.
  u57Vandning(74105, '274105001', 'u-sväng-15m-bortom-Järnvägsbron-söderut-retur-1,5kn (U57)',
    METRICS.cum[3], 'S', 15, 1.5, { noticeForms: { Järnvägsbron: ['precis'], Stridsbergsbron: ['tyst', 'närmar'] } }),
  // Stopp 15 m bortom Klaffbron söderut, retur norrut i 1,5 kn: samma regel gav
  // en falsk "ÖPPNINGSVARNING Klaffbron eta 0" när båten redan var på väg bort.
  u57Vandning(74106, '274106001', 'u-sväng-15m-bortom-Klaffbron-söderut-retur-1,5kn (U57)',
    METRICS.cum[2], 'S', 15, 1.5, { maxOpeningsPerBridge: { Klaffbron: 1 } }),
  // Fartlös retur i 3 kn från 25 m bortom Järnvägsbron söderut (93 m segment):
  // med "under 100 m utan fart = stilla" uteblev "närmar sig Stridsbergsbron".
  u57Vandning(74107, '274107001', 'u-sväng-25m-bortom-Järnvägsbron-söderut-fartlös-retur-3kn (U57)',
    METRICS.cum[3], 'S', 25, 3, { noticeForms: { Stridsbergsbron: ['tyst', 'närmar'] } }, { utanFart: true }),
  // U49 (rättningsomgång 4, nattjaktens värld 8814): UNDER-BRO-HÅLLET MÄTER
  // ANKOMSTEN MED FYSIKEN. VEGA varnas för Stridsbergsbron söderut och tystnar
  // 420 m före bron, så ingen passage bokförs och täckningen räknas från hennes
  // referensankomst (06:20:32). BRISEN absorberas, och hennes sista fix
  // (AISHub, 39 s gammalt) ligger 45 m före bron i 4,5 kn. Appens ETA nära bron
  // (1,3–1,4 min) lägger prognosen efter täckningsslutet, avstånd genom fart
  // lägger ankomsten före. Hon korsar 06:20:21 osedd och hörs nästa gång
  // bortom bron. Förut släpptes hon vid täckningsslutet och varnades 12 s
  // efter passagen; nu hålls hon till nästa fix (passagen). PLACERINGEN ÄR
  // TESTET: fixet måste ligga mellan täckningsslutet minus appens ETA och
  // täckningsslutet minus restiden. Ändras ETA-kedjan nära bron eller
  // täckningens längd ska tiderna räknas om, inte förväntan tas bort.
  // Motfallen (dagens beteende står kvar, och båda fäller ett håll utan
  // täckningskrav): (i) en krypare i 0,8 kn vars sista fix före slutet ligger
  // 34 m före bron och som korsar 78 s efter slutet får sin egen varning vid
  // täckningsslutet; (ii) en båt som stannar 40 m före bron och väntar i 600 s
  // med brusfart 0,8 kn och slumpad kurs släpps på första fixet efter slutet
  // och varnas minuter före korsningen.
  ...[
    {
      label: 'i 4,5 kn, tyst över bron: ingen varning efter passagen',
      seed: 88141,
      fOff: 264,
      fStart: 2214.3,
      legs: (strid) => [{
        toS: strid - 1200, speedKn: 4.5, intervalS: 67, fixLagS: 39, gapFromS: strid + 42, gapToS: strid - 160,
      }],
      expect: { maxOpeningsPerBridge: { Stridsbergsbron: 1 } },
    },
    {
      label: 'krypare i 0,8 kn korsar efter täckningen: egen varning (motfall)',
      seed: 88142,
      fOff: 221,
      fStart: 1521.7,
      legs: (strid) => [
        {
          toS: strid + 200, speedKn: 4.5, intervalS: 67, fixLagS: 39,
        },
        {
          toS: strid - 1200, speedKn: 0.8, intervalS: 67, fixLagS: 39,
        },
      ],
      expect: { ownOpeningLeadS: { Stridsbergsbron: { 988142002: 60 } } },
    },
    {
      label: 'väntar 40 m före bron med brusfart: egen varning (motfall)',
      seed: 88143,
      fOff: 200,
      fStart: 1961,
      legs: (strid) => [
        {
          toS: strid + 40, speedKn: 4.5, intervalS: 67, fixLagS: 39,
        },
        {
          stopS: 600, stopIntervalS: 67, stopSog: 0.8, stopCogRandom: true, fixLagS: 39,
        },
        {
          toS: strid - 1200, speedKn: 4.5, intervalS: 67, fixLagS: 39,
        },
      ],
      expect: { ownOpeningLeadS: { Stridsbergsbron: { 988143002: 180 } } },
    },
  ].map((k) => {
    const strid = METRICS.cum[4];
    return {
      name: `vid-brolinjen-när-täckningen-löper-ut-söderut: ${k.label} (U49, nattjakten 8814)`,
      seed: k.seed,
      vessels: [
        {
          mmsi: `9${k.seed}001`,
          name: 'SYNT-VEGA',
          startS: strid + 1500,
          legs: [{
            toS: strid + 200, speedKn: 5, intervalS: 60, gapFromS: strid + 420, gapToS: strid + 100,
          }],
        },
        {
          mmsi: `9${k.seed}002`,
          name: 'SYNT-BRISEN',
          startOffsetS: k.fOff,
          startS: strid + k.fStart,
          legs: k.legs(strid),
        },
      ],
      expect: k.expect,
    };
  }),
  ...U52_SCENARIOS,
  ...U70_SCENARIOS,
  // ---------------------------------------------------------------------------
  // U53 (2026-11-23, spår C omgång 5): VÄNTAN VID EN MELLANBRO I TEXTEN.
  // Fältprov 2: båtar norrut kröp 0,5–1 kn från 550–800 m söder om Järnvägsbron
  // i 8–29 min; texten räknade uppåt och sa "väntar" först innanför 350 m.
  // Egna positioner och tider (samma geometri som fältets fall).
  // ---------------------------------------------------------------------------
  // KINNE-formen: 1,5 kn från 800 m, kryp 0,8 kn från 560 m till 330 m, kort
  // stopp, sedan igenom.
  // "Väntar vid Järnvägsbron" ska stå från fyra minuter in i krypet, och första
  // siffran efter väntan får inte vara högre än den sista före (dold tid hålls).
  {
    name: 'kryp-0,8kn-från-560m-söder-om-Järnvägsbron (U53, KINNE-formen)',
    seed: 5301,
    vessels: [{
      mmsi: '905301001',
      name: 'SYNT-U53-KRYP',
      startS: METRICS.cum[2] - 700,
      legs: [
        { toS: METRICS.cum[3] - 800, speedKn: 4, intervalS: 60 },
        { toS: METRICS.cum[3] - 560, speedKn: 1.5, intervalS: 65 },
        { toS: METRICS.cum[3] - 330, speedKn: 0.8, intervalS: 65 },
        { stopS: 240, stopIntervalS: 65, stopSog: 0.4 },
        { toS: METRICS.cum[4] + 700, speedKn: 4.5, intervalS: 60 },
      ],
    }],
    expect: {
      minTargetPassages: 2,
      waitTextWindows: [{
        mmsi: '905301001',
        fromS: METRICS.cum[3] - 560,
        delayS: 240,
        toS: METRICS.cum[3] - 335,
        at: 'Järnvägsbron',
        target: 'Stridsbergsbron',
        must: true,
        count: 1,
      }],
      etaNotRaisedOverWait: { bridge: 'Stridsbergsbron', at: 'Järnvägsbron' },
    },
  },
  // VISTEN-formen: samma kryp från 680 m, men var tredje fix rapporterar 1,3 kn
  // (fartbrus). Hysteresen (1,5 kn när väntan är bekräftad) håller texten.
  {
    name: 'kryp-med-fartbrus-1,3kn-söder-om-Järnvägsbron (U53, VISTEN-formen)',
    seed: 5302,
    vessels: [{
      mmsi: '905302001',
      name: 'SYNT-U53-BRUS',
      startS: METRICS.cum[2] - 700,
      legs: [
        { toS: METRICS.cum[3] - 680, speedKn: 4, intervalS: 60 },
        ...Array.from({ length: 6 }, (_, i) => [
          { toS: METRICS.cum[3] - 680 + 66 * i + 44, speedKn: 0.6, intervalS: 65 },
          {
            toS: METRICS.cum[3] - 680 + 66 * i + 66, speedKn: 0.6, intervalS: 65, reportSogKn: 1.3,
          },
        ]).flat(),
        { stopS: 180, stopIntervalS: 65, stopSog: 0.3 },
        { toS: METRICS.cum[4] + 700, speedKn: 4.5, intervalS: 60 },
      ],
    }],
    expect: {
      minTargetPassages: 2,
      waitTextWindows: [{
        mmsi: '905302001',
        fromS: METRICS.cum[3] - 680,
        delayS: 420,
        toS: METRICS.cum[3] - 300,
        at: 'Järnvägsbron',
        target: 'Stridsbergsbron',
        must: true,
        count: 1,
      }],
      maxWaitToggles: { at: 'Järnvägsbron', max: 2 },
    },
  },
  // Motfall: båten saktar in till 0,8 kn i en halv minut 600 m före Järnvägsbron
  // och går sedan vidare. Ingen vänttext.
  {
    name: 'kort-inbromsning-600m-före-Järnvägsbron (motfall U53)',
    seed: 5303,
    vessels: [{
      mmsi: '905303001',
      name: 'SYNT-U53-KORT',
      startS: METRICS.cum[2] - 700,
      legs: [
        { toS: METRICS.cum[3] - 620, speedKn: 4, intervalS: 30 },
        { toS: METRICS.cum[3] - 600, speedKn: 0.8, intervalS: 30 },
        { toS: METRICS.cum[4] + 700, speedKn: 4, intervalS: 30 },
      ],
    }],
    expect: { minTargetPassages: 2, maxWaitToggles: { at: 'Järnvägsbron', max: 0 } },
  },
  // Motfall: marschfart förbi Klaffbron och Järnvägsbron, 700 m och närmare.
  {
    name: 'marschfart-förbi-Järnvägsbron (motfall U53)',
    seed: 5304,
    vessels: [{
      mmsi: '905304001',
      name: 'SYNT-U53-MARSCH',
      startS: METRICS.cum[2] - 700,
      legs: [{ toS: METRICS.cum[4] + 700, speedKn: 4.5, intervalS: 60 }],
    }],
    expect: { minTargetPassages: 2, maxWaitToggles: { at: 'Järnvägsbron', max: 0 } },
  },
  // Motfall: just förbi Klaffbron går båten 1,2–1,4 kn ända fram till 150 m
  // före Järnvägsbron utan att stanna (800 m-gränsen når nästan Klaffbron).
  {
    name: 'sakta-1,3kn-efter-Klaffbron-utan-väntan (motfall U53)',
    seed: 5305,
    vessels: [{
      mmsi: '905305001',
      name: 'SYNT-U53-SAKTA',
      startS: METRICS.cum[2] - 700,
      legs: [
        { toS: METRICS.cum[2] + 60, speedKn: 4, intervalS: 60 },
        { toS: METRICS.cum[3] - 150, speedKn: 1.3, intervalS: 60 },
        { toS: METRICS.cum[4] + 700, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: { minTargetPassages: 2, maxWaitToggles: { at: 'Järnvägsbron', max: 0 } },
  },
  // Motfall: båten lägger till i Gästhamnen norr om Klaffbron (600 m från
  // Järnvägsbron, kajzon) i 30 min och går sedan norrut. Ingen vänttext.
  {
    name: 'lägger-till-i-Gästhamnen-600m-före-Järnvägsbron (motfall U53)',
    seed: 5306,
    vessels: [{
      mmsi: '905306001',
      name: 'SYNT-U53-GASTHAMN',
      startS: METRICS.cum[2] - 700,
      legs: [
        { toS: 3200, speedKn: 4, intervalS: 60 },
        {
          toS: 3232, speedKn: 1, intervalS: 60, lateralM: -50,
        },
        {
          toS: 3238, speedKn: 0.5, intervalS: 60, lateralM: -90,
        },
        {
          stopS: 1800, stopIntervalS: 180, stopSog: 0, lateralM: -90,
        },
        { toS: METRICS.cum[4] + 700, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: { maxWaitToggles: { at: 'Järnvägsbron', max: 0 } },
  },
  // Motfall: kö 450 m före MÅLBRON Klaffbron norrut. U53 gäller aldrig målbron;
  // U30 ger "ETA okänd" som förut.
  {
    name: 'stilla-450m-före-målbron-Klaffbron (motfall U53)',
    seed: 5307,
    vessels: [{
      mmsi: '905307001',
      name: 'SYNT-U53-MALBRO',
      startS: METRICS.cum[1] - 600,
      legs: [
        { toS: METRICS.cum[2] - 450, speedKn: 4, intervalS: 60 },
        { stopS: 600, stopIntervalS: 60, stopSog: 0.1 },
        { toS: METRICS.cum[2] + 300, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: {
      maxWaitToggles: { at: 'Klaffbron', max: 0 },
      stillUnknown: { bridge: 'Klaffbron', afterS: 330 },
    },
  },
  // U65 (ägarens beslut 2026-11-24): köbeviset vid MÅLBRON ger vänttexten
  // "En båt väntar vid <målbro>" (förut "på väg mot <målbro>, beräknad
  // broöppning strax"). Söderut, still 150 m norr om Stridsbergsbron i 10 min,
  // sedan igenom. Vänttexten ska stå från tre minuter in i stoppet och komma
  // och gå en gång var (inget flimmer i en ren väntan).
  {
    name: 'kö-150m-norr-om-målbron-Stridsbergsbron (U65)',
    seed: 6501,
    vessels: [{
      mmsi: '906501001',
      name: 'SYNT-U65-STRIDS',
      startS: METRICS.cum[4] + 900,
      legs: [
        { toS: METRICS.cum[4] + 150, speedKn: 4, intervalS: 60 },
        { stopS: 600, stopIntervalS: 60, stopSog: 0.1 },
        { toS: METRICS.cum[3] - 300, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: {
      waitTextWindows: [{
        mmsi: '906501001',
        fromS: METRICS.cum[4] + 150,
        delayS: 180,
        durationS: 360,
        at: 'Stridsbergsbron',
        target: 'Stridsbergsbron',
        must: true,
        count: 1,
      }],
      maxWaitToggles: { at: 'Stridsbergsbron', max: 2 },
    },
  },
  // U65, norrut mot Klaffbron: still 150 m söder om bron i 10 min, sedan igenom.
  {
    name: 'kö-150m-söder-om-målbron-Klaffbron (U65)',
    seed: 6502,
    vessels: [{
      mmsi: '906502001',
      name: 'SYNT-U65-KLAFF',
      startS: METRICS.cum[1] + 300,
      legs: [
        { toS: METRICS.cum[2] - 150, speedKn: 4, intervalS: 60 },
        { stopS: 600, stopIntervalS: 60, stopSog: 0.1 },
        { toS: METRICS.cum[2] + 600, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: {
      waitTextWindows: [{
        mmsi: '906502001',
        fromS: METRICS.cum[2] - 150,
        delayS: 180,
        durationS: 360,
        at: 'Klaffbron',
        target: 'Klaffbron',
        must: true,
        count: 1,
      }],
      maxWaitToggles: { at: 'Klaffbron', max: 2 },
    },
  },
  // Söderut, kö mellan Stridsbergsbron och Järnvägsbron (150 m före Järnvägsbron,
  // målbro Klaffbron). Fungerade redan med köbeviset; ska stå kvar.
  {
    name: 'kö-söderut-150m-före-Järnvägsbron (U53, söderut)',
    seed: 5308,
    vessels: [{
      mmsi: '905308001',
      name: 'SYNT-U53-SYD',
      startS: METRICS.cum[4] + 900,
      legs: [
        { toS: METRICS.cum[3] + 150, speedKn: 4, intervalS: 60 },
        { stopS: 600, stopIntervalS: 60, stopSog: 0.1 },
        { toS: METRICS.cum[2] - 600, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: {
      waitTextWindows: [{
        mmsi: '905308001',
        fromS: METRICS.cum[3] + 150,
        delayS: 180,
        durationS: 360,
        at: 'Järnvägsbron',
        target: 'Klaffbron',
        must: true,
        count: 1,
      }],
    },
  },
  // Motfall söderut: stilla 450 m norr om MÅLBRON Stridsbergsbron. Järnvägsbron
  // ligger bortom målbron och är ingen mellanbro; ingen vänttext.
  {
    name: 'stilla-450m-norr-om-målbron-Stridsbergsbron (motfall U53, söderut)',
    seed: 5309,
    vessels: [{
      mmsi: '905309001',
      name: 'SYNT-U53-SYDMAL',
      startS: METRICS.cum[4] + 1400,
      legs: [
        { toS: METRICS.cum[4] + 450, speedKn: 4, intervalS: 60 },
        { stopS: 600, stopIntervalS: 60, stopSog: 0.1 },
        { toS: METRICS.cum[3] - 300, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: {
      maxWaitToggles: { at: 'Järnvägsbron', max: 0 },
      stillUnknown: { bridge: 'Stridsbergsbron', afterS: 330 },
    },
  },
  // Olidebron: kryp 0,7 kn från 600 m till 350 m söder om Olidebron (målbro
  // Klaffbron) och kort stopp. Samma regel som vid Järnvägsbron. Fönstret är
  // kort: bandet ligger vid Kanalinfarten, där basen redan tar bort en båt som
  // kryper (borttagning 'timeout' cirka fem minuter in i krypet, före och efter
  // U53); den frågan hör inte till U53.
  {
    name: 'kryp-0,7kn-från-600m-söder-om-Olidebron (U53, Olidebron)',
    seed: 5310,
    vessels: [{
      mmsi: '905310001',
      name: 'SYNT-U53-OLIDE',
      startS: 100,
      legs: [
        { toS: METRICS.cum[1] - 600, speedKn: 4, intervalS: 60 },
        { toS: METRICS.cum[1] - 350, speedKn: 0.7, intervalS: 65 },
        { stopS: 180, stopIntervalS: 65, stopSog: 0.3 },
        { toS: METRICS.cum[2] + 300, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: {
      waitTextWindows: [{
        mmsi: '905310001',
        fromS: METRICS.cum[1] - 600,
        delayS: 150,
        durationS: 45,
        at: 'Olidebron',
        target: 'Klaffbron',
        must: true,
        count: 1,
      }],
      // Basen (7633653) ger samma två "Inga båtar"-blinkningar i det här
      // scenariot (borttagningen vid Kanalinfarten ovan); de hör inte till U53.
      toleratedInvariants: [/DEFAULT-FLASH/],
    },
  },
  // Två båtar: den ena kryper före Järnvägsbron (KINNE-formen), den andra kommer
  // i marschfart och passerar. Texten ska räkna en väntande och två mot bron.
  {
    name: 'en-väntar-en-kommer-i-marschfart (U53, två båtar)',
    seed: 5311,
    vessels: [{
      mmsi: '905311001',
      name: 'SYNT-U53-VANTAR',
      startS: METRICS.cum[2] - 700,
      legs: [
        { toS: METRICS.cum[3] - 560, speedKn: 4, intervalS: 60 },
        { toS: METRICS.cum[3] - 330, speedKn: 0.7, intervalS: 65 },
        { stopS: 240, stopIntervalS: 65, stopSog: 0.4 },
        { toS: METRICS.cum[4] + 700, speedKn: 4.5, intervalS: 60 },
      ],
    }, {
      mmsi: '905311002',
      name: 'SYNT-U53-KOMMER',
      startS: METRICS.cum[2] - 700,
      startOffsetS: 600,
      legs: [{ toS: METRICS.cum[4] + 700, speedKn: 4.5, intervalS: 60 }],
    }],
    expect: {
      waitTextWindows: [{
        mmsi: '905311001',
        fromS: METRICS.cum[3] - 560,
        delayS: 240,
        toS: METRICS.cum[3] - 335,
        at: 'Järnvägsbron',
        target: 'Stridsbergsbron',
        must: true,
        count: 1,
      }],
      textCountAlong: [{
        mmsi: '905311002',
        fromS: METRICS.cum[2] + 150,
        toS: METRICS.cum[3] - 600,
        bridge: 'Stridsbergsbron',
        min: 2,
        max: 2,
      }],
    },
  },
  // Flimmer: väntan bekräftas (0,6 kn), sedan pendlar farten 1,4/1,6 kn. Texten
  // får komma och gå högst en gång var.
  {
    name: 'fart-pendlar-kring-1,5kn-i-kön (flimmerprov U53)',
    seed: 5312,
    vessels: [{
      mmsi: '905312001',
      name: 'SYNT-U53-PENDEL',
      startS: METRICS.cum[2] - 700,
      legs: [
        { toS: METRICS.cum[3] - 700, speedKn: 4, intervalS: 60 },
        { toS: METRICS.cum[3] - 640, speedKn: 0.6, intervalS: 65 },
        ...Array.from({ length: 5 }, (_, i) => [
          { toS: METRICS.cum[3] - 640 + 98 * i + 47, speedKn: 1.4, intervalS: 65 },
          { toS: METRICS.cum[3] - 640 + 98 * i + 98, speedKn: 1.6, intervalS: 65 },
        ]).flat(),
        { toS: METRICS.cum[4] + 700, speedKn: 4.5, intervalS: 60 },
      ],
    }],
    expect: { minTargetPassages: 2, maxWaitToggles: { at: 'Järnvägsbron', max: 2 } },
  },
  // Motfall: båten ligger still 800 m söder om Järnvägsbron med 15 m GPS-brus.
  // Platsen är Kajen norr om Klaffbron (kajzon, 30–80 m bort): hon klassas
  // förtöjd som förut och får ingen vänttext. (Avståndshysteresen 800/850 m
  // prövas i tests/u53-mellanbro-textko.test.js.)
  {
    name: 'stilla-vid-Kajen-800m-från-Järnvägsbron-med-brus (motfall U53)',
    seed: 5313,
    vessels: [{
      mmsi: '905313001',
      name: 'SYNT-U53-GRANS',
      startS: METRICS.cum[2] - 700,
      jitterM: 15,
      legs: [
        { toS: METRICS.cum[3] - 800, speedKn: 4, intervalS: 60 },
        { stopS: 900, stopIntervalS: 60, stopSog: 0.2 },
        { toS: METRICS.cum[4] + 700, speedKn: 4.5, intervalS: 60 },
      ],
    }],
    expect: { maxWaitToggles: { at: 'Järnvägsbron', max: 0 } },
  },
  // Granskningen av U53 (M1): kajzonen "Kajen norr om Klaffbron" täcker farleden
  // 644–788 m söder om Järnvägsbron. En köare som ligger vid zonkanten (645 m)
  // med 12 m GPS-brus ska inte växla mellan "väntar" och "om N" (granskarens
  // värld F7, seed 9217: före rättningen fyra växlingar på nio minuter).
  {
    name: 'kö-vid-Kajens-zonkant-645m-med-brus (U53, granskningens M1)',
    seed: 9217,
    vessels: [{
      mmsi: '905314001',
      name: 'SYNT-U53-ZONKANT',
      startS: METRICS.cum[2] - 700,
      jitterM: 12,
      legs: [
        { toS: METRICS.cum[3] - 660, speedKn: 4, intervalS: 60 },
        { toS: METRICS.cum[3] - 645, speedKn: 0.5, intervalS: 60 },
        { stopS: 900, stopIntervalS: 60, stopSog: 0.6 },
        { toS: METRICS.cum[4] + 600, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: { maxWaitToggles: { at: 'Järnvägsbron', max: 2 } },
  },
  // Motfall: båten lägger till vid Kajen (inne i zonen, 20 m väster om
  // farledens mitt, ~720 m söder om Järnvägsbron) i 12 min och går sedan norrut.
  // Ingen vänttext: kantmarginalen gäller bara zonens kant.
  {
    name: 'lägger-till-vid-Kajen-720m-före-Järnvägsbron (motfall U53, M1)',
    seed: 5315,
    vessels: [{
      mmsi: '905315001',
      name: 'SYNT-U53-KAJEN',
      startS: METRICS.cum[2] - 700,
      legs: [
        { toS: 3080, speedKn: 4, intervalS: 60 },
        {
          toS: 3106, speedKn: 0.8, intervalS: 60, lateralM: -20,
        },
        {
          stopS: 720, stopIntervalS: 60, stopSog: 0.1, lateralM: -20,
        },
        { toS: METRICS.cum[4] + 600, speedKn: 4, intervalS: 60 },
      ],
    }],
    expect: { maxWaitToggles: { at: 'Järnvägsbron', max: 0 } },
  },
  // ---------------------------------------------------------------------------
  // U54 (2026-11-23): en restid över 60 min visas som "ETA okänd".
  // ---------------------------------------------------------------------------
  // En båt söderut kryper 0,6 kn norr om Stallbackabron, drygt 2 km från
  // Stridsbergsbron: restiden är långt över 60 min. Ingen siffra över 60.
  {
    name: 'kryp-0,6kn-2km-norr-om-Stridsbergsbron-restid-över-60 (U54)',
    seed: 5401,
    vessels: [{
      mmsi: '905401001',
      name: 'SYNT-U54-LANG',
      startS: METRICS.cum[5] + 600,
      legs: [
        { toS: METRICS.cum[5] + 300, speedKn: 4, intervalS: 60 },
        { toS: METRICS.cum[5] - 300, speedKn: 0.6, intervalS: 60 },
        { toS: METRICS.cum[4] - 400, speedKn: 5, intervalS: 60 },
      ],
    }],
    expect: {
      etaNeverAbove: { bridge: 'Stridsbergsbron', max: 60 },
      unknownSeen: ['Stridsbergsbron'],
    },
  },
  // Motfall: samma sträcka i 1,3 kn — restiden 40–55 min visas som siffra.
  {
    name: 'sakta-1,3kn-norr-om-Stridsbergsbron-restid-40–55-visas (motfall U54)',
    seed: 5402,
    vessels: [{
      mmsi: '905402001',
      name: 'SYNT-U54-SAKTA',
      startS: METRICS.cum[5] + 600,
      legs: [
        { toS: METRICS.cum[5] + 300, speedKn: 4, intervalS: 60 },
        { toS: METRICS.cum[4] + 400, speedKn: 1.3, intervalS: 60 },
        { toS: METRICS.cum[4] - 400, speedKn: 5, intervalS: 60 },
      ],
    }],
    expect: {
      etaSeenAtLeast: { bridge: 'Stridsbergsbron', min: 40 },
      etaNeverAbove: { bridge: 'Stridsbergsbron', max: 60 },
    },
  },
  // ---------------------------------------------------------------------------
  // U55 (2026-11-23): U30 ("ETA okänd" efter fem minuters stillhet) också i
  // status stallbacka-waiting och en-route.
  // ---------------------------------------------------------------------------
  // PRICKBJORN-formen: söderut, stannar 30 m norr om Stallbackabron (status
  // stallbacka-waiting, 2,2 km från Stridsbergsbron) i 20 min och går sedan.
  {
    name: 'stilla-20min-vid-Stallbackabron (U55, PRICKBJORN-formen)',
    seed: 5501,
    vessels: [{
      mmsi: '905501001',
      name: 'SYNT-U55-STALLB',
      startS: METRICS.cum[5] + 900,
      legs: [
        { toS: METRICS.cum[5] + 30, speedKn: 4, intervalS: 65 },
        { stopS: 1200, stopIntervalS: 65, stopSog: 0 },
        { toS: METRICS.cum[4] - 300, speedKn: 4.5, intervalS: 65 },
      ],
    }],
    // Efter avgången stod ETA-kedjans dolda värde högt (fartgolvet 0,5 kn under
    // stoppet) och visades över 60 min som "ETA okänd" (U54) tills det sjunkit;
    // sedan U59 släpps det vid avgången (scenarierna "… (U59)" nedan).
    expect: {
      stillUnknown: { bridge: 'Stridsbergsbron', afterS: 330 },
      etaNeverAbove: { bridge: 'Stridsbergsbron', max: 60 },
    },
  },
  // Motfall: samma plats men bara 4 min stilla — tiden visas hela stoppet.
  {
    name: 'stilla-4min-vid-Stallbackabron (motfall U55)',
    seed: 5502,
    vessels: [{
      mmsi: '905502001',
      name: 'SYNT-U55-KORT',
      startS: METRICS.cum[5] + 900,
      legs: [
        { toS: METRICS.cum[5] + 30, speedKn: 4, intervalS: 65 },
        { stopS: 240, stopIntervalS: 65, stopSog: 0 },
        { toS: METRICS.cum[4] - 300, speedKn: 4.5, intervalS: 65 },
      ],
    }],
    expect: { noUnknownDuringStop: { bridge: 'Stridsbergsbron', extraS: 60 } },
  },
  // ---------------------------------------------------------------------------
  // U59 (2026-11-24): efter ett långt stopp räknas restiden om från avgången.
  // En båt söderut ligger still 30 m norr om Stallbackabron och går sedan i
  // 5 kn mot Stridsbergsbron (sann restid 14,6 min). Basen visade "ETA okänd"
  // i sju minuter och sedan "om 59" (20 min stopp), "om 59 → 51 → 41" (45 min),
  // och kortet "om 53" respektive "om 45" när knappt sju minuter återstod. Fröna
  // är valda så att stoppet har en beräkningslucka över 3 min (gap-reseten och
  // fartgolvets 120 min); utan luckan klarade basen sig. KÄND GRÄNS (1): i 6 av 80
  // körningar (frö 5900–5939, 20 och 45 min) släpps baslinjen på U30-beviset medan
  // fartbufferten bär stillheten, och den första siffran blir upp till 25 min för
  // hög i två minuter; gränsen +8 nedan fäller U59 i de fröna (5908 och 5910 vid
  // 20 min, 5901, 5910, 5913 och 5927 vid 45 min). Fröna här klarar den.
  // ---------------------------------------------------------------------------
  ...[[5902, 20], [5919, 45]].map(([seed, min]) => ({
    name: `stilla-${min}min-vid-Stallbackabron-sedan-5kn (U59)`,
    seed,
    vessels: [{
      mmsi: `9059${String(min).padStart(2, '0')}001`,
      name: `SYNT-U59-STOPP${min}`,
      startS: METRICS.cum[5] + 900,
      legs: [
        { toS: METRICS.cum[5] + 30, speedKn: 5, intervalS: 30 },
        { stopS: min * 60, stopIntervalS: 60, stopSog: 0 },
        { toS: METRICS.cum[4] - 400, speedKn: 5, intervalS: 30 },
      ],
    }],
    // Första siffran kan ligga upp till 8 min för högt i en minut: efter luckan
    // har fartbufferten bara ett stillasampel, så familj E känner inte igen
    // avgången och det första snittet bär stoppet (känd gräns, ARCHITECTURE §8 e;
    // samma nivå som basen efter ett kort stopp, se motfallen nedan).
    expect: {
      stillUnknown: { bridge: 'Stridsbergsbron', afterS: 330 },
      departureEta: {
        bridge: 'Stridsbergsbron', maxOverMin: 8, maxUnderMin: 2, cardMaxOverMin: 2, cardMaxUnderMin: 2,
      },
    },
  })),
  // Motfall U59: en båt som bara saktar in (0,6, 1 och 2 kn i 8–10 min norr om
  // Stallbackabron) har inget stillhetsbevis och ska aldrig få en för låg siffra.
  ...[[5904, 0.6, 480], [5905, 1, 600], [5906, 2, 600]].map(([seed, kn, slowS]) => ({
    name: `saktar-in-${String(kn).replace('.', ',')}kn-norr-om-Stallbackabron (motfall U59)`,
    seed,
    vessels: [{
      mmsi: `9${seed}0001`,
      name: `SYNT-U59-SAKTA${seed % 10}`,
      startS: METRICS.cum[5] + 1200,
      legs: [
        { toS: METRICS.cum[5] + 600, speedKn: 5, intervalS: 30 },
        { toS: METRICS.cum[5] + 600 - kn * 0.5144 * slowS, speedKn: kn, intervalS: 30 },
        { toS: METRICS.cum[4] - 400, speedKn: 5, intervalS: 30 },
      ],
    }],
    expect: {
      etaTruthAlong: [{
        mmsi: `9${seed}0001`, fromS: METRICS.cum[5] + 600, toS: METRICS.cum[4], bridge: 'Stridsbergsbron', maxUnderMin: 2,
      }],
    },
  })),
  // Motfall U59: ett kort stopp (2 och 5 min) — samma beteende som förut. Den
  // första minuten efter avgången bär fartbufferten stoppets sampel och visar
  // "om 20–21" mot sanningen 14 (basens nivå; gränsen låser att den inte växer).
  ...[[5907, 2], [5908, 5]].map(([seed, min]) => ({
    name: `stilla-${min}min-vid-Stallbackabron (motfall U59, kort stopp)`,
    seed,
    vessels: [{
      mmsi: `9${seed}0001`,
      name: `SYNT-U59-KORT${min}`,
      startS: METRICS.cum[5] + 900,
      legs: [
        { toS: METRICS.cum[5] + 30, speedKn: 5, intervalS: 30 },
        { stopS: min * 60, stopIntervalS: 60, stopSog: 0 },
        { toS: METRICS.cum[4] - 400, speedKn: 5, intervalS: 30 },
      ],
    }],
    expect: {
      noUnknownDuringStop: { bridge: 'Stridsbergsbron', extraS: 60 },
      departureEta: { bridge: 'Stridsbergsbron', maxOverMin: 8, maxUnderMin: 2 },
    },
  })),
  // Motfall U59: AIS-tystnad över avgången (330 m, drygt 2 min). Bara U30-beviset
  // och tom historik efter gap-reseten: inget släpp, basens nedräkning står kvar.
  {
    name: 'stilla-20min-vid-Stallbackabron-tystnad-över-avgången (motfall U59)',
    seed: 5910,
    vessels: [{
      mmsi: '905910001',
      name: 'SYNT-U59-TYST',
      startS: METRICS.cum[5] + 900,
      legs: [
        { toS: METRICS.cum[5] + 30, speedKn: 5, intervalS: 30 },
        { stopS: 1200, stopIntervalS: 60, stopSog: 0 },
        {
          toS: METRICS.cum[4] - 400, speedKn: 5, intervalS: 30, gapFromS: METRICS.cum[5] + 30, gapToS: METRICS.cum[5] - 300,
        },
      ],
    }],
    expect: {
      departureEta: { bridge: 'Stridsbergsbron', maxOverMin: 9, maxUnderMin: 2 },
      // Från andra fixen efter tystnaden: i dag "om 15" mot 11,6 (+3,4, högst
      // +4,1). Släpptes klampen på U30-beviset med tom historik hade första
      // fixens för höga rå-ETA blivit ny bas och gett "om 18" (+6,4).
      etaTruthAlong: [{
        mmsi: '905910001', fromS: METRICS.cum[5] - 434, toS: METRICS.cum[4], bridge: 'Stridsbergsbron', maxUnderMin: 2, maxOverMin: 5,
      }],
    },
  },
  // KÄND GRÄNS (U59): utan stillhetsbevis rör U59 inte baslinjen. En båt som
  // saktar in till 1 kn i 10 min norr om Stallbackabron och sedan går i 5 kn
  // visar som före U59 "om 57 → 47 → 40 → 33" där 14 → 13 återstår (+42,7). En
  // regel som släppte baslinjen utan stillhetsbevis hade sänkt siffran; minErrMin
  // låser att den inte gör det, så att en sådan ändring prövas medvetet.
  {
    name: 'saktar-in-1kn-10min-sedan-5kn-utan-stillhetsbevis (känd gräns, U59)',
    seed: 5916,
    vessels: [{
      mmsi: '959160001',
      name: 'SYNT-U59-INBROMS',
      startS: METRICS.cum[5] + 1200,
      legs: [
        { toS: METRICS.cum[5] + 600, speedKn: 5, intervalS: 30 },
        { toS: METRICS.cum[5] + 600 - 0.5144 * 600, speedKn: 1, intervalS: 30 },
        { toS: METRICS.cum[4] - 400, speedKn: 5, intervalS: 30 },
      ],
    }],
    expect: {
      etaTruthAlong: [{
        mmsi: '959160001',
        fromS: METRICS.cum[5] + 600 - 0.5144 * 600 - 1,
        toS: METRICS.cum[4],
        bridge: 'Stridsbergsbron',
        maxUnderMin: 2,
        maxOverMin: 45,
        minErrMin: 20,
      }],
    },
  },
  // Motfall U59: omstart av appen mitt i stoppet (efter 9 min). Den nya
  // instansen har ingen baslinje från stillheten och inget bevis; båten syns
  // igen först när hon går (basens beteende, en INV-14W-WARN på alla kodrötter),
  // och avgången räknas som för en ny båt. Med REPLAY_MONITORING=1 likadant.
  {
    name: 'stilla-20min-vid-Stallbackabron-omstart-mitt-i-stoppet (U59)',
    seed: 5913,
    vessels: [{
      mmsi: '905913001',
      name: 'SYNT-U59-OMSTART',
      startS: METRICS.cum[5] + 900,
      legs: [
        { toS: METRICS.cum[5] + 30, speedKn: 5, intervalS: 30 },
        { stopS: 1200, stopIntervalS: 60, stopSog: 0 },
        { toS: METRICS.cum[4] - 400, speedKn: 5, intervalS: 30 },
      ],
    }],
    events: [{ ctrl: 'restart', atOffsetS: 900 }],
    expect: { departureEta: { bridge: 'Stridsbergsbron', maxOverMin: 2, maxUnderMin: 2 } },
  },
  // ---------------------------------------------------------------------------
  // KÄND GRÄNS (U59): priset vid ryck i kön och vid en enda felaktig fix.
  // Familj E-beviset och U30-beviset finns också för en båt som ligger i kö: ett
  // ryck i minst 2 kn, eller en enda fix med fart utan förflyttning, släpper
  // baslinjen, och siffran under den nya väntan blir lika låg som efter en
  // verklig avgång (ARCHITECTURE §8 e, U59, känd gräns 3). Scenarierna låser
  // priset i dagens storlek: blir text eller kort lägre, eller kortet tidigare,
  // fälls de.
  // ---------------------------------------------------------------------------
  // (a) Kö 250 m söder om Järnvägsbron norrut i 25 min, ryck 120 m i 6 kn, ny
  // väntan 30 min. Kortet för Stridsbergsbron avfyras vid rycket (samma tid som
  // före U59) med minuten 3 där 34 återstår (före U59: 21), och texten säger
  // "strax" där 33,5 återstår (före U59: "om 19").
  {
    name: 'kö-250m-söder-om-Järnvägsbron-ryck-120m-6kn-och-ny-väntan (känd gräns, U59)',
    seed: 20180,
    vessels: [{
      mmsi: '959180001',
      name: 'SYNT-U59-RYCK',
      startS: METRICS.cum[3] - 250 - 1400,
      legs: [
        { toS: METRICS.cum[3] - 250 - 150, speedKn: 5.5, intervalS: 30 },
        { toS: METRICS.cum[3] - 250, speedKn: 1.2, intervalS: 30 },
        { stopS: 1500, stopIntervalS: 60, stopSog: 0.4 },
        { toS: METRICS.cum[3] - 130, speedKn: 6, intervalS: 30 },
        { stopS: 1800, stopIntervalS: 60, stopSog: 0.4 },
        { toS: METRICS.cum[3] - 90, speedKn: 2.2, intervalS: 30 },
        { toS: METRICS.cum[4] + 500, speedKn: 5.5, intervalS: 30 },
      ],
    }],
    expect: {
      maxOpeningsPerBridge: { Stridsbergsbron: 1 },
      // Kortet vid rycket är 2 043 s gammalt vid den verkliga korsningen; ett
      // tidigare kort fäller scenariot.
      maxOpeningAgeS: { Stridsbergsbron: 2100 },
      // Från 10 s före rycket genom den nya väntan: i dag "strax" (−31,0) och
      // kortet 3 mot 34,0 (−31,0). Lägre text eller kortminut fäller scenariot.
      etaTruthAlong: [{
        mmsi: '959180001',
        fromS: METRICS.cum[3] - 250,
        delayS: 1490,
        durationS: 1830,
        bridge: 'Stridsbergsbron',
        maxUnderMin: 31.5,
        cardMaxUnderMin: 31.5,
      }],
    },
  },
  // (b) En enda fartspik: söderut, väntan 30 + 10 min 600 m norr om Klaffbron,
  // AIS var 60:e s; en fix 9 min in i väntan rapporterar 3 kn utan förflyttning.
  // Före U59 "om 32" (sanningen 35) och sedan "om 27"; med U59 "om 5" från spiken
  // i nästan 20 minuter (avbrutet av en minut utan båt i texten), där 35 → 16 återstod.
  // Gränsen 31 min för låg är dagens nivå ("om 5" mot 35,3).
  {
    name: 'en-fartspik-i-30min-väntan-600m-norr-om-Klaffbron (känd gräns, U59)',
    seed: 20554,
    vessels: [{
      mmsi: '959554001',
      name: 'SYNT-U59-SPIK',
      startS: METRICS.cum[2] + 600 + 1400,
      legs: [
        { toS: METRICS.cum[2] + 600 + 150, speedKn: 5.5, intervalS: 30 },
        { toS: METRICS.cum[2] + 600, speedKn: 1.2, intervalS: 60 },
        { stopS: 1800, stopIntervalS: 60, stopSog: 0.4 },
        { stopS: 600, stopIntervalS: 60, stopSog: 0.4 },
        { toS: METRICS.cum[2] + 560, speedKn: 2.2, intervalS: 60 },
        { toS: METRICS.cum[2] - 500, speedKn: 5.5, intervalS: 60 },
      ],
    }],
    patchSamples: (samples) => {
      const sStop = METRICS.cum[2] + 600;
      const tp = samples.truthPaths['959554001'];
      const t0 = BASE_TIME_MS + 1000 * tp.find((x) => Math.abs(x.s - sStop) < 1).tS;
      const target = t0 + 0.3 * 1800 * 1000;
      const own = samples.filter((r) => r.mmsi === '959554001'
        && r.aisTimestamp > t0 + 30000 && r.aisTimestamp < t0 + 1770000);
      const spike = own.reduce((best, r) => (!best
        || Math.abs(r.aisTimestamp - target) < Math.abs(best.aisTimestamp - target) ? r : best), null);
      spike.sog = 3;
    },
    expect: {
      etaTruthAlong: [{
        mmsi: '959554001', fromS: METRICS.cum[2] + 600, delayS: 540, durationS: 1500, bridge: 'Klaffbron', maxUnderMin: 31,
      }],
      // "Inga båtar" i 180 och 60 s under väntan finns på samma sätt utan U59
      // (båten tappar texten medan hon ligger still); det hör inte hit.
      toleratedInvariants: [/^DEFAULT-FLASH: \S+ "Inga båtar" inklämd \(\d+s\) mellan två "En … Klaffbron"-texter/],
    },
  },
  // ---------------------------------------------------------------------------
  // KÄND GRÄNS (U60 avstått 2026-11-24): ingen avgång ur kryp. KINNE-formen:
  // norrut kryp 0,7 kn från 600 till 320 m söder om Järnvägsbron, sedan 2,1, 3,7
  // och 5 kn (respektive direkt 4,5 kn). Familj E kräver buffrade sampel under
  // 0,5 kn, så första siffran efter krypet räknas på buffertens snitt och blir
  // för hög: i dag "om 13" respektive "om 10" när 4,7 och 4,1 återstod, kortet
  // 7 och 8 när 2,7 och 3,1 återstod. minErrMin låser att felet finns (minst
  // 4 min för högt); övre gränserna låser att det inte växer. En regel som
  // känner igen avgången ur kryp fäller scenarierna och ska låsa om dem medvetet,
  // efter rycksvepet (ARCHITECTURE §8 e, "Känd gräns: ingen avgång ur kryp").
  // ---------------------------------------------------------------------------
  ...[[6001, 'stegvis'], [6002, 'direkt']].map(([seed, how]) => ({
    name: `kryp-0,7kn-i-kön-söder-om-Järnvägsbron-avgång-${how} (känd gräns, U60 avstått)`,
    seed,
    vessels: [{
      mmsi: `9${seed}0001`,
      name: `SYNT-U60-${how === 'direkt' ? 'DIR' : 'KRYP'}`,
      startS: METRICS.cum[2] - 600,
      legs: [
        { toS: METRICS.cum[3] - 900, speedKn: 3.9, intervalS: 60 },
        { toS: METRICS.cum[3] - 600, speedKn: 1.3, intervalS: 65 },
        { toS: METRICS.cum[3] - 320, speedKn: 0.7, intervalS: 65 },
        ...(how === 'direkt' ? [{ toS: METRICS.cum[4] + 400, speedKn: 4.5, intervalS: 60 }] : [
          { toS: METRICS.cum[3] - 270, speedKn: 2.1, intervalS: 60 },
          { toS: METRICS.cum[3] - 160, speedKn: 3.7, intervalS: 60 },
          { toS: METRICS.cum[4] + 400, speedKn: 5, intervalS: 60 },
        ]),
      ],
    }],
    expect: {
      etaTruthAlong: [{
        mmsi: `9${seed}0001`,
        fromS: METRICS.cum[3] - 319,
        toS: METRICS.cum[4],
        bridge: 'Stridsbergsbron',
        maxUnderMin: 2,
        maxOverMin: 10,
        minErrMin: 4,
        cardMaxUnderMin: 2,
        cardMaxOverMin: 6,
      }],
    },
  })),
  // Motfallet som fällde U60 (U56:s lärdom): ryck i kön och ny väntan. Kryp
  // 0,7 kn, ryck 60 m i 2,5 kn och tio minuter ny väntan. I dag visar texten
  // under rycket "om 12 → 10" mot sanningen 16 (högst 5,2 min för låg). Gränsen
  // 6 min låser dagens nivå; U60:s krypregel gav "om 5 → 6 → 7" (11,2 min för låg).
  {
    name: 'kryp-0,7kn-ryck-60m-och-ny-väntan (känd gräns, U60 avstått)',
    seed: 6003,
    vessels: [{
      mmsi: '960030001',
      name: 'SYNT-U60-RYCK',
      startS: METRICS.cum[2] - 600,
      legs: [
        { toS: METRICS.cum[3] - 900, speedKn: 3.9, intervalS: 60 },
        { toS: METRICS.cum[3] - 600, speedKn: 1.3, intervalS: 65 },
        { toS: METRICS.cum[3] - 380, speedKn: 0.7, intervalS: 65 },
        { toS: METRICS.cum[3] - 320, speedKn: 2.5, intervalS: 30 },
        { stopS: 600, stopIntervalS: 65, stopSog: 0.7 },
        { toS: METRICS.cum[3] - 270, speedKn: 2.1, intervalS: 60 },
        { toS: METRICS.cum[4] + 400, speedKn: 5, intervalS: 60 },
      ],
    }],
    expect: {
      etaTruthAlong: [{
        mmsi: '960030001', fromS: METRICS.cum[3] - 380, toS: METRICS.cum[3] - 300, bridge: 'Stridsbergsbron', maxUnderMin: 6,
      }],
    },
  },
  // ---------------------------------------------------------------------------
  // KÄND GRÄNS (U79, omgång 10): sen varning för Stridsbergsbron efter väntan vid
  // Järnvägsbron, med kön på det verkliga avståndet. Inspelade köer ligger 120–160 m
  // före Järnvägsbron; köryckfixturerna (opening-queue-jerk) ligger 250–310 m före
  // och kan därför inte fälla en regel som bara verkar närmare bron. Båten väntar
  // 15 min 140 m före bron, rycker 35 m i 1,4 kn och står 10 min till, och går
  // sedan igenom. I dag kommer ingen varning på rycket och ett enda kort vid den
  // verkliga avgången, 143 s före passagen med "om 2" (ARCHITECTURE, "Känd gräns:
  // sen varning efter väntan vid Järnvägsbron"). En regel som varnar på första
  // raden i rörelse efter kön (spår J:s alternativ A2: 1 kn, 20 m, högst 200 m
  // före bron) ger kortet på rycket 878 s före och fäller scenariot. MMSI i
  // serien 970–979 (nödsändare) duger inte här: appen ger dem ingen målbro.
  // ---------------------------------------------------------------------------
  {
    name: 'kö-140m-söder-om-Järnvägsbron-ryck-35m-och-ny-väntan (känd gräns, U79)',
    seed: 7901,
    vessels: [{
      mmsi: '957900001',
      name: 'SYNT-U79-KO',
      startS: METRICS.cum[3] - 140 - 1300,
      legs: [
        { toS: METRICS.cum[3] - 140 - 250, speedKn: 4.5, intervalS: 65 },
        { toS: METRICS.cum[3] - 140, speedKn: 1.5, intervalS: 65 },
        { stopS: 900, stopIntervalS: 65, stopSog: 0.1 },
        { toS: METRICS.cum[3] - 105, speedKn: 1.4, intervalS: 20 },
        { stopS: 600, stopIntervalS: 65, stopSog: 0.1 },
        { toS: METRICS.cum[3] - 75, speedKn: 1.8, intervalS: 65 },
        { toS: METRICS.cum[4] + 500, speedKn: 4.5, intervalS: 65 },
      ],
    }],
    expect: {
      // Ett enda kort för Stridsbergsbron, och det kommer vid den verkliga
      // avgången: minst 100 s och högst 160 s före den sanna korsningen.
      maxOpeningsPerBridge: { Stridsbergsbron: 1 },
      openingLeadS: { Stridsbergsbron: 100 },
      maxOpeningAgeS: { Stridsbergsbron: 160 },
    },
  },
  // ---------------------------------------------------------------------------
  // KÄND GRÄNS (U68, omgång 9): vad texten säger om en båt medan hon är tyst.
  // Mätningen över banken och fältkörningarna (ARCHITECTURE §5, "Tysta båtar")
  // hittade ingen regel som gör fler minuter sanna utan att ta bort sann text,
  // och dirigenten lät beteendet stå. Scenarierna låser dagens förlopp minut för
  // minut (clauseWindows, räknat från båtens egen rad), så att en ändring av
  // gränserna (fryst ETA i 5 min, "strax" till 10 min enligt U16, visningstrappan
  // 15/20 min) syns och låses om medvetet.
  // ---------------------------------------------------------------------------
  // (a) En riktig båt (vanligt fartygs-MMSI) som hörs en enda gång. Fallet som
  // startade mätningen, LIFEGUARD 007, var räddningsflyg och ignoreras sedan
  // U69 (scenariot "räddningsflyg-111-…" nedan); för en båt gäller detta.
  // En enda AISHub-position i 14 kn och kurs 210°, drygt
  // 500 m nordväst om Stridsbergsbron och lika långt från kanalens farledslinje
  // (alltså inte i farleden mot bron), och aldrig mer. Appen ger henne målbron
  // ur avstånd och kurs. ETA:n (cirka 1,2 min) står fryst i 5 min och ger
  // "strax"; sedan extrapoleras den till noll, och utanför 500 m blir det "ETA
  // okänd" i stället för uttömd "strax". Målbroklassens 15 min tar henne ur
  // texten. Ingen notis (Stallbackabron ligger över 2 km bort) och ingen
  // öppningsvarning (hon var aldrig inom 300 m). Positionen sätts med
  // patchSamples, eftersom scenariobanan följer farleden.
  {
    name: 'en-enda-position-14kn-utanför-farleden-vid-Stridsbergsbron-aldrig-mer (känd gräns, U68)',
    seed: 6801,
    vessels: [{
      mmsi: '265681001',
      name: 'SYNT-U68-SNABB',
      startS: METRICS.cum[4] + 560,
      legs: [{
        toS: METRICS.cum[4] + 559, speedKn: 14, intervalS: 30, fixLagS: 10,
      }],
    }],
    patchSamples: (samples) => {
      for (const x of samples) {
        if (x.mmsi !== '265681001') continue;
        x.lat = 58.29691;
        x.lon = 12.28864;
        x.cog = 210;
        x.sog = 14;
      }
    },
    expect: {
      zeroNotifications: true,
      zeroOpeningWarnings: true,
      clauseWindows: [{
        mmsi: '265681001',
        anchor: 'first',
        bridge: 'Stridsbergsbron',
        windows: [[1, 285, 'strax'], [330, 885, 'okänd'], [930, 2400, 'ingen']],
      }],
    },
  },
  // (b) En båt i 6 kn söderut tystnar 200 m norr om Stridsbergsbron, går igenom
  // Stridsbergsbron, Järnvägsbron och Klaffbron i glappet, lägger sig 400 m
  // söder om Klaffbron och hörs igen först 40 min efter sista positionen.
  // Imminent-flaggan håller "strax" tills positionen är 10 min gammal (U16),
  // sedan "ETA okänd" tills mitt-i-passage-nivån (20 min) tar henne ur texten.
  // När hon hörs igen är hon raderad (30 min) och ny för appen, stilla bortom
  // den sista bron, och kommer inte tillbaka i texten. Passagesvepet ger då
  // "passerade … under AIS-tystnad" för Järnvägsbron och Klaffbron; för
  // Stridsbergsbron gick "närmar sig" före glappet, och besöksdedupen spärrar
  // en andra notis. Notisen för Stallbackabron är förstakontaktens (U44).
  // Varningen för Klaffbron går under glappet (U17).
  {
    name: 'tystnar-200m-före-Stridsbergsbron-6kn-passerar-i-glappet-hörs-efter-40min (känd gräns, U68)',
    seed: 6802,
    vessels: [{
      mmsi: '968020001',
      name: 'SYNT-U68-GLAPP',
      startS: METRICS.cum[4] + 1500,
      legs: [
        { toS: METRICS.cum[4] + 200, speedKn: 6, intervalS: 30 },
        {
          toS: METRICS.cum[2] - 400, speedKn: 6, intervalS: 30, gapFromS: METRICS.cum[4] + 200, gapToS: METRICS.cum[2] - 400,
        },
        { stopS: 2700, stopIntervalS: 60, stopSog: 0 },
      ],
    }],
    // Stoppets rader under de första 40 min efter sista positionen tas bort, så
    // att tystnaden blir 40 min (ett gående ben kan inte vara så långt i kanalen).
    patchSamples: (samples) => {
      const own = samples.filter((x) => x.mmsi === '968020001');
      let t0 = null;
      for (let i = 0; i + 1 < own.length; i++) {
        if (own[i + 1].aisTimestamp - own[i].aisTimestamp > 120000) {
          t0 = own[i].aisTimestamp; break;
        }
      }
      for (let i = samples.length - 1; i >= 0; i--) {
        const x = samples[i];
        if (x.mmsi === '968020001' && x.aisTimestamp > t0 && x.aisTimestamp < t0 + 2400 * 1000) samples.splice(i, 1);
      }
    },
    expect: {
      clauseWindows: [{
        mmsi: '968020001',
        anchor: 'largestGap',
        bridge: 'Stridsbergsbron',
        windows: [[1, 585, 'strax'], [630, 1185, 'okänd'], [1230, 3000, 'ingen']],
      }],
      noticeForms: {
        Stallbackabron: ['tyst'], Stridsbergsbron: ['närmar'], Järnvägsbron: ['tyst'], Klaffbron: ['tyst'], Olidebron: [],
      },
      expectedOpenings: ['Stridsbergsbron', 'Klaffbron'],
      maxOpeningsPerBridge: { Stridsbergsbron: 1, Klaffbron: 1 },
    },
  },
  // U69 (omgång 9): en sändare som inte är ett fartyg ignoreras helt. Ett
  // räddningsflyg (MMSI 111 + landskod) flyger längs farleden söderut i 14 kn
  // och passerar Stridsbergsbron; före U69 blev det "En båt på väg mot
  // Stridsbergsbron, beräknad broöppning strax", notiser och en
  // öppningsvarning. Nu: ingen text, ingen notis, ingen varning. (Scenariot
  // "en-enda-position-14kn-… (känd gräns, U68)" ovan är en riktig båt och står
  // kvar.) Scenarierna för U44:3, U46 och U57 hade MMSI 974… (EPIRB-AIS enligt
  // ITU-R M.585) och bytte vid U69 till 274… med samma sista siffror.
  {
    name: 'räddningsflyg-111-längs-farleden-över-Stridsbergsbron-ignoreras (U69)',
    seed: 6901,
    vessels: [{
      mmsi: '111219001',
      name: 'SYNT-U69-SAR',
      startS: METRICS.cum[4] + 1200,
      legs: [{ toS: METRICS.cum[3] - 600, speedKn: 14, intervalS: 30 }],
    }],
    expect: { noVesselText: true, zeroNotifications: true, zeroOpeningWarnings: true },
  },
  // U69, motfall: en felprogrammerad fritidsbåt med "dummy-MMSI" 111111111 har
  // ingen giltig landskod (111 är ingen MID) och behandlas som ett fartyg, som
  // före U69: samma bana som räddningsflyget ovan ger text och notiser.
  {
    name: 'dummy-mmsi-111111111-längs-farleden-över-Stridsbergsbron-syns (U69, motfall)',
    seed: 6902,
    vessels: [{
      mmsi: '111111111',
      name: 'SYNT-U69-DUMMY',
      startS: METRICS.cum[4] + 1200,
      legs: [{ toS: METRICS.cum[3] - 600, speedKn: 14, intervalS: 30 }],
    }],
    expect: {
      minNotifiedBridges: ['Stridsbergsbron'],
      textCountWindows: [{
        bridge: 'Stridsbergsbron', fromS: 30, toS: 120, min: 1,
      }],
    },
  },
];

function runScenario(scenario) {
  const samples = generateScenario(scenario);
  // Ett scenario kan ändra enstaka genererade rader på plats (t.ex. ett
  // GPS-hopp mitt i ett stopp, granskarens F04-J). Sanna banan rörs inte.
  if (typeof scenario.patchSamples === 'function') scenario.patchSamples(samples);
  const { truthPaths } = samples;
  const tmpFile = path.join(os.tmpdir(), `synthetic-${scenario.seed}.jsonl`);
  fs.writeFileSync(tmpFile, samples.map((s) => JSON.stringify(s)).join('\n'));
  try {
    const stdout = execFileSync('node', [RUNNER, tmpFile], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000,
    });
    const m = stdout.match(/__REPLAY_JSON__([\s\S]*?)__END__/);
    if (!m) throw new Error('Ingen JSON-markör i replay-output');
    return {
      result: JSON.parse(m[1]), sampleCount: samples.length, truthPaths, samples,
    };
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

// Kedjeindex i PATH per bro (se METRICS ovan): ledtidskravets sanna korsningar.
const PATH_INDEX = {
  Olidebron: 1, Klaffbron: 2, Järnvägsbron: 3, Stridsbergsbron: 4, Stallbackabron: 5,
};

/**
 * Sann korsning av en bros latitud för en båt, interpolerad mellan de två
 * sampel som ligger på var sin sida (rutten går genom brons koordinat).
 * @returns {number|null} tid i ms för första korsningen, eller null
 */
function sampleCrossingMs(samples, mmsi, bridge) {
  const own = (samples || []).filter((x) => x.mmsi === mmsi && Number.isFinite(x.lat))
    .sort((a, b) => a.aisTimestamp - b.aisTimestamp);
  for (let i = 1; i < own.length; i++) {
    const a = own[i - 1].lat - bridge.lat;
    const b = own[i].lat - bridge.lat;
    if (a !== 0 && Math.sign(a) !== Math.sign(b)) {
      const f = a / (a - b);
      return own[i - 1].aisTimestamp + f * (own[i].aisTimestamp - own[i - 1].aisTimestamp);
    }
  }
  return null;
}

/**
 * Familj E (departureEta och creepEta): brotextens ETA-klausul för en bro.
 * Grupp 1 är minuttalet; saknas den är klausulen "strax".
 */
function etaClauseFor(bridge) {
  return new RegExp(`på väg mot ${bridge}, beräknad broöppning (?:om (?:cirka )?(\\d+) minuter?|strax)`);
}

/**
 * Familj E: ETA-texten för en bro prövad mot den sanna restiden i fönstret
 * [fromMs, toMs): vid varje textövergång OCH som stående text var 30:e
 * sekund, så att ett värde som står kvar prövas medan sanningen rör sig.
 * "strax" lovar under 3 min och får felet min(0, 3 − sanning): det kan bara
 * vara för optimistiskt. Texter utan ETA-klausul för bron hoppas över.
 * BEGRÄNSNING: hela texten tillskrivs scenariots enda båt (singleJourney);
 * ledarvalet i en grupp prövas inte.
 * @returns {Array<{t:number, label:string, truthMin:number, err:number}>}
 */
function etaTextPoints(transitions, bridge, fromMs, toMs, crossingMs) {
  const list = (transitions || []).filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
  const times = list.filter((x) => x.t >= fromMs && x.t < toMs).map((x) => x.t);
  for (let t = fromMs; t < toMs; t += 30000) times.push(t);
  const re = etaClauseFor(bridge);
  const out = [];
  for (const t of [...new Set(times)].sort((a, b) => a - b)) {
    const standing = list.filter((x) => x.t <= t).pop();
    const m = standing ? re.exec(standing.text) : null;
    if (!m) continue;
    const truthMin = (crossingMs - t) / 60000;
    const err = m[1] === undefined ? Math.min(0, 3 - truthMin) : Number(m[1]) - truthMin;
    out.push({
      t, label: m[1] === undefined ? 'strax' : `om ${m[1]} minuter`, truthMin, err,
    });
  }
  return out;
}

/**
 * Familj E: resan för departureEta/creepEta. Förväntningarna förutsätter EN
 * båt med sann bana (`legs`); annars är det ett fel i scenariot. Ett stopp är
 * sampel under 0,5 kn (projektets rörelsebevis, samma gräns som
 * avgångsigenkänningen), och en avgång är första sampel ≥ 1,0 kn efter ett
 * stopp. crossingAfter ger den sanna korsningen av bron efter en tid.
 */
function singleJourney(scenario, truthPaths, samples, bridge, tag, problems) {
  const paths = Object.entries(truthPaths || {});
  if ((scenario.vessels || []).length !== 1 || paths.length !== 1) {
    problems.push(`${tag}: förväntan kräver exakt en båt med sann bana (legs), scenariot har `
      + `${(scenario.vessels || []).length} båtar och ${paths.length} banor`);
    return null;
  }
  const [mmsi, truthPath] = paths[0];
  const own = (samples || []).filter((x) => x.mmsi === mmsi && Number.isFinite(x.sog))
    .sort((a, b) => a.aisTimestamp - b.aisTimestamp);
  const stopEnds = own.filter((x, i) => i > 0 && x.sog >= 1.0 && own[i - 1].sog < 0.5);
  const sBridge = METRICS.cum[PATH_INDEX[bridge]];
  const crossings = truthCrossings(truthPath, sBridge).map((c) => BASE_TIME_MS + c.tS * 1000);
  return { stopEnds, crossingAfter: (t) => crossings.find((c) => c > t) };
}

/**
 * U30: stoppen i scenariots enda båtresa, ur generatorns SANNA bana: ett
 * stopp är ett intervall där båten inte flyttar sig (minst 60 s). Rapporterad
 * fart spelar ingen roll, så fartspikar på en stilla båt delar inte stoppet
 * (granskningen av b9c581a, H2). departure är tiden då båten åter flyttar sig
 * (null om hon aldrig gör det); sStop är stoppets position längs rutten.
 * @returns {Array<{t0:number, tEnd:number, departure:number|null, sStop:number}>|null}
 */
function journeyStops(scenario, truthPaths, samples, tag, problems) {
  const paths = Object.entries(truthPaths || {});
  if ((scenario.vessels || []).length !== 1 || paths.length !== 1) {
    problems.push(`${tag}: förväntan kräver exakt en båt med sann bana (legs)`);
    return null;
  }
  const tp = paths[0][1];
  const stops = [];
  let cur = null;
  for (let i = 1; i < tp.length; i++) {
    const still = Math.abs(tp[i].s - tp[i - 1].s) < 0.01 && tp[i].tS > tp[i - 1].tS;
    if (still) {
      if (!cur) cur = { t0: BASE_TIME_MS + tp[i - 1].tS * 1000, sStop: tp[i].s };
      cur.tEnd = BASE_TIME_MS + tp[i].tS * 1000;
    } else if (cur) {
      cur.departure = cur.tEnd;
      if (cur.tEnd - cur.t0 >= 60000) stops.push(cur);
      cur = null;
    }
  }
  if (cur && cur.tEnd - cur.t0 >= 60000) stops.push({ ...cur, departure: null });
  if (stops.length === 0) problems.push(`${tag}: scenariot har inget stopp att döma`);
  return stops;
}

/**
 * U30: tiden då båten (sann bana) först är minst moveM från stoppets position
 * efter stoppet, eller null.
 */
function movedFromStopMs(truthPaths, st, moveM) {
  const tp = Object.values(truthPaths || {})[0] || [];
  for (let i = 1; i < tp.length; i++) {
    const t = BASE_TIME_MS + tp[i].tS * 1000;
    if (t <= st.tEnd) continue;
    if (Math.abs(tp[i].s - st.sStop) >= moveM) {
      const a = tp[i - 1]; const b = tp[i];
      const f = (moveM - Math.abs(a.s - st.sStop)) / Math.abs(b.s - a.s || 1);
      return BASE_TIME_MS + (a.tS + Math.max(0, Math.min(1, f)) * (b.tS - a.tS)) * 1000;
    }
  }
  return null;
}

/**
 * U30: brons klausul i en text: 'num', 'strax', 'okänd', 'vänt' eller 'ingen'.
 */
function bridgeClauseForm(text, bridge) {
  const clause = String(text || '').split('; ').find((c) => c.includes(`mot ${bridge}`));
  if (!clause) return 'ingen';
  if (/väntar/.test(clause)) return 'vänt';
  if (clause.includes('ETA okänd')) return 'okänd';
  if (clause.includes('broöppning strax')) return 'strax';
  return /om (?:cirka )?\d+ minut/.test(clause) ? 'num' : 'ingen';
}

/** U30: stående text vid varje övergång och var 30:e s i [fromMs, toMs]. */
function standingTexts(transitions, fromMs, toMs) {
  const list = (transitions || []).filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
  const times = list.filter((x) => x.t >= fromMs && x.t <= toMs).map((x) => x.t);
  for (let t = fromMs; t <= toMs; t += 30000) times.push(t);
  return [...new Set(times)].sort((a, b) => a - b)
    .map((t) => ({ t, text: (list.filter((x) => x.t <= t).pop() || {}).text || '' }));
}

// Räkneorden i docs/bridgeTextFormat.md (1–10 i ord, ≥ 11 som siffra).
const COUNT_WORDS = {
  en: 1, två: 2, tre: 3, fyra: 4, fem: 5, sex: 6, sju: 7, åtta: 8, nio: 9, tio: 10,
};

/**
 * Hur många båtar räknar brotexten mot bron? Summan av klausulernas räkneord
 * för de klausuler som nämner "mot <bro>" (gång- och väntklausuler). "Inga
 * båtar …" och andra texter utan sådan klausul ger 0.
 * @param {string} text
 * @param {string} bridge
 * @returns {number}
 */
function vesselCountInText(text, bridge) {
  return String(text || '').split('; ')
    .filter((clause) => clause.includes(`mot ${bridge}`))
    .reduce((sum, clause) => {
      const word = clause.split(' ')[0].toLowerCase();
      const n = /^\d+$/.test(word) ? Number(word) : COUNT_WORDS[word];
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
}

/** U53: första tidpunkten (ms) då båtens sanna bana når ruttläget sTarget. */
function truthReachMs(truthPaths, mmsi, sTarget) {
  const tp = (truthPaths || {})[mmsi] || [];
  if (tp.length && tp[0].s === sTarget) return BASE_TIME_MS + tp[0].tS * 1000;
  for (let i = 1; i < tp.length; i++) {
    const a = tp[i - 1]; const b = tp[i];
    if (b.s === sTarget) return BASE_TIME_MS + b.tS * 1000;
    if (a.s !== b.s && (a.s - sTarget) * (b.s - sTarget) < 0) {
      const f = (sTarget - a.s) / (b.s - a.s);
      return BASE_TIME_MS + (a.tS + f * (b.tS - a.tS)) * 1000;
    }
  }
  return null;
}

/** U53: antal båtar i textens vänttext vid <at> (mot <target>), 0 om ingen. */
function waitClauseCount(text, at, target) {
  for (const clause of String(text || '').split('; ')) {
    const m = clause.match(/^(\S+) (?:båt|båtar) väntar vid (\S+?)(?: på väg mot (\S+))?$/);
    if (!m || m[2] !== at) continue;
    if (target && (m[3] || m[2]) !== target) continue;
    return COUNT_WORDS[m[1].toLowerCase()] || Number(m[1]) || 0;
  }
  return 0;
}

/** U54: siffran i brons klausul "om [cirka] N minuter", annars null. */
function etaMinutesFor(text, bridge) {
  for (const clause of String(text || '').split('; ')) {
    if (!clause.includes(`på väg mot ${bridge},`)) continue;
    const m = clause.match(/om (?:cirka )?(\d+) minut/);
    if (m) return Number(m[1]);
  }
  return null;
}

function checkExpectations(scenario, result, truthPaths = {}, samples = []) {
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
  // U44 punkt 3 (D3): spärrens minne städas när båten raderas.
  if (result.leakDiagnostics && result.leakDiagnostics.vessels === 0
      && (result.leakDiagnostics.slowBridgeBehindHolds || result.leakDiagnostics.slowBridgeBehindLogged)) {
    problems.push(`spärrens minne kvar efter efterspel (${result.leakDiagnostics.slowBridgeBehindHolds}/`
      + `${result.leakDiagnostics.slowBridgeBehindLogged})`);
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
  // U33: notisen mot brotextens "strax" (se förklaringen överst).
  if (e.noticeFollowsTravelTime || e.noticeMinEta) {
    const transitions = [...(result.bridgeTextTransitions || [])].sort((a, b) => a.t - b.t);
    const textAt = (t) => {
      let cur = null;
      for (const x of transitions) {
        if (x.t <= t + 1000) cur = x;
        else break;
      }
      return cur ? cur.text : '';
    };
    const notices = (bridge) => notifications.filter((n) => n.bridge === bridge && !n.alreadyPassed);
    const sogAt = (mmsi, t) => {
      const own = (samples || []).filter((x) => String(x.mmsi) === String(mmsi)
        && Number.isFinite(x.aisTimestamp) && x.aisTimestamp <= t + 100);
      return own.length ? own[own.length - 1].sog : null;
    };
    for (const bridge of e.noticeFollowsTravelTime || []) {
      let tried = 0;
      for (const n of notices(bridge)) {
        const sog = sogAt(n.mmsi, n.t);
        const travelMin = Number.isFinite(sog) && sog > 0 ? n.distance / (sog * 0.5144) / 60 : Infinity;
        if (travelMin >= 3 || !textAt(n.t).includes(`mot ${bridge}, beräknad broöppning strax`)) continue;
        tried += 1;
        const maxEta = Math.max(1, Math.round(travelMin));
        if (!(Number.isFinite(n.eta) && n.eta >= 0 && n.eta <= maxEta)) {
          problems.push(`U33: notisen för ${bridge} säger "om ${n.eta} minuter" när texten säger strax och restiden är ${travelMin.toFixed(2)} min (${n.distance} m)`);
        }
      }
      if (tried === 0) problems.push(`U33: ingen förvarning för ${bridge} att pröva`);
    }
    for (const [bridge, minEta] of Object.entries(e.noticeMinEta || {})) {
      const own = notices(bridge);
      if (own.length === 0) problems.push(`U33: ingen förvarning för ${bridge} att pröva`);
      for (const n of own) {
        if (!(Number.isFinite(n.eta) && n.eta >= minEta)) {
          problems.push(`U33: notisen för ${bridge} har eta ${n.eta} < ${minEta} (${n.distance} m)`);
        }
      }
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
  // U37 del 2: notisernas form per bro, i tidsordning.
  if (e.noticeForms) {
    const formOf = (m) => {
      if (/under AIS-tystnad/.test(m || '')) return 'tyst';
      if (/har precis passerat/.test(m || '')) return 'precis';
      if (/närmar sig/.test(m || '')) return 'närmar';
      return 'annan';
    };
    for (const [bridge, forms] of Object.entries(e.noticeForms)) {
      const got = notifications.filter((n) => n.bridge === bridge).sort((x, y) => x.t - y.t)
        .map((n) => formOf(n.message));
      if (JSON.stringify(got) !== JSON.stringify(forms)) {
        const texts = notifications.filter((n) => n.bridge === bridge).map((n) => `"${n.message}"`).join(', ');
        problems.push(`NOTISFORM vid ${bridge}: [${got.join(', ')}] ≠ [${forms.join(', ')}] (${texts})`);
      }
    }
  }
  // U44 punkt 3 (omgång 4): notisernas riktningsfält per bro, i tidsordning
  // (internt värde: northbound/southbound/unknown).
  if (e.noticeDirections) {
    for (const [bridge, dirs] of Object.entries(e.noticeDirections)) {
      const got = notifications.filter((n) => n.bridge === bridge).sort((x, y) => x.t - y.t)
        .map((n) => n.direction);
      if (JSON.stringify(got) !== JSON.stringify(dirs)) {
        problems.push(`NOTISRIKTNING vid ${bridge}: [${got.join(', ')}] ≠ [${dirs.join(', ')}]`);
      }
    }
  }
  // U44 punkt 3, granskningen av D3 (H1): förvarningens ledtid mot den SANNA
  // korsningen (generatorns truthPath). Första notisen för bron före båtens
  // första korsning ska vara en förvarning minst N s före korsningen.
  if (e.noticeLeadS) {
    for (const [bridge, minLeadS] of Object.entries(e.noticeLeadS)) {
      const sBridge = METRICS.cum[PATH_INDEX[bridge]];
      for (const [mmsi, truthPath] of Object.entries(truthPaths || {})) {
        const [first] = truthCrossings(truthPath, sBridge);
        if (!first) continue;
        const crossingMs = BASE_TIME_MS + first.tS * 1000;
        const own = notifications.filter((n) => n.bridge === bridge && String(n.mmsi) === mmsi)
          .sort((x, y) => x.t - y.t);
        const n = own[0];
        const leadS = n ? (crossingMs - n.t) / 1000 : null;
        if (!n || n.alreadyPassed || leadS < minLeadS) {
          problems.push(`FÖRVARNINGENS LEDTID vid ${bridge} (${mmsi}): ${n ? `${Math.round(leadS)} s` : 'ingen notis'} före sann korsning, krav minst ${minLeadS} s`);
        }
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
  // U23 (2026-11-09): ingen varning för bron under S s före båtens sanna
  // korsning. Korsningen räknas ur scenariots egna sampel, inte ur appens
  // bokförda passage (som kommer ett fix efter korsningen).
  if (e.minOpeningLeadS) {
    for (const [bridgeName, minLeadS] of Object.entries(e.minOpeningLeadS)) {
      const bridge = Object.values(BRIDGES).find((b) => b.name === bridgeName);
      for (const w of openings.filter((x) => x.bridge === bridgeName && Number.isFinite(x.t))) {
        for (const mmsi of (w.mmsis || [w.leadMmsi]).map(String)) {
          const crossMs = sampleCrossingMs(samples, mmsi, bridge);
          if (crossMs === null || crossMs < w.t) continue;
          const leadS = (crossMs - w.t) / 1000;
          if (leadS < minLeadS) {
            problems.push(`SEN ÖPPNINGSVARNING: ${bridgeName} ${w.eventId} ${w.iso} (${w.firedBy}) bara `
              + `${Math.round(leadS)} s före ${mmsi}:s korsning (minst ${minLeadS} s)`);
          }
        }
      }
    }
  }
  // U23/D1: en båt som ligger i sitt stopp ska stå kvar i texten.
  if (e.noDefaultWhileStopped) {
    const transitions = result.bridgeTextTransitions || [];
    const textAt = (t) => transitions.filter((x) => x.t <= t).pop()?.text || '';
    for (const v of scenario.vessels || []) {
      const still = (samples || []).filter((x) => x.mmsi === v.mmsi && Number.isFinite(x.sog) && x.sog < 0.3)
        .map((x) => x.aisTimestamp);
      if (still.length === 0) continue;
      const from = Math.min(...still);
      const to = Math.max(...still);
      const flips = [from, ...transitions.filter((x) => x.t > from && x.t <= to).map((x) => x.t)];
      const def = flips.find((t) => textAt(t).startsWith('Inga båtar'));
      if (def !== undefined) {
        problems.push(`"Inga båtar" ${new Date(def).toISOString()} medan ${v.mmsi} låg i sitt stopp `
          + `(${new Date(from).toISOString()}–${new Date(to).toISOString()})`);
      }
    }
  }
  // Familj D (k1, 2026-11-11): antalet båtar mot en bro i ett tidsfönster.
  if (e.textCountWindows) {
    const transitions = result.bridgeTextTransitions || [];
    for (const w of e.textCountWindows) {
      const fromMs = BASE_TIME_MS + w.fromS * 1000;
      const toMs = BASE_TIME_MS + w.toS * 1000;
      const atStart = transitions.filter((x) => x.t <= fromMs).pop();
      const inWindow = [...(atStart ? [atStart] : []), ...transitions.filter((x) => x.t > fromMs && x.t <= toMs)];
      if (inWindow.length === 0) inWindow.push({ t: fromMs, text: '' });
      for (const x of inWindow) {
        const n = vesselCountInText(x.text, w.bridge);
        if ((Number.isFinite(w.min) && n < w.min) || (Number.isFinite(w.max) && n > w.max)) {
          problems.push(`ANTAL I TEXTEN: ${n} mot ${w.bridge} ${new Date(Math.max(x.t, fromMs)).toISOString()} `
            + `("${x.text}"), förväntat ${w.min ?? 0}–${w.max ?? '∞'} under ${w.fromS}–${w.toS} s`);
          break;
        }
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
  // K2 (nattjaktens F02 r3): egen varning, absorption räknas inte (se huvudet).
  if (e.ownOpeningLeadS) {
    for (const [bridge, perVessel] of Object.entries(e.ownOpeningLeadS)) {
      const sBridge = METRICS.cum[PATH_INDEX[bridge]];
      for (const [mmsi, spec] of Object.entries(perVessel)) {
        const minLeadS = typeof spec === 'number' ? spec : spec.minLeadS;
        const maxAgeS = typeof spec === 'number' || !Number.isFinite(spec.maxAgeS) ? 900 : spec.maxAgeS;
        const truthPath = (truthPaths || {})[mmsi];
        const crossings = truthPath ? truthCrossings(truthPath, sBridge) : [];
        if (crossings.length === 0) {
          problems.push(`EGEN VARNING: ${mmsi} har ingen sann korsning av ${bridge} att pröva`);
          continue;
        }
        let previousMs = -Infinity;
        for (const c of crossings) {
          const crossingMs = BASE_TIME_MS + c.tS * 1000;
          const wantDir = c.dir === 'north' ? 'northbound' : 'southbound';
          const own = openings.filter((w) => w.bridge === bridge && Number.isFinite(w.t) && w.success !== false
            && w.t > previousMs && w.t < crossingMs && crossingMs - w.t <= maxAgeS * 1000
            && (!['northbound', 'southbound'].includes(w.direction) || w.direction === wantDir)
            && ((w.mmsis || []).map(String).includes(mmsi) || String(w.leadMmsi) === mmsi));
          const best = own.length ? Math.max(...own.map((w) => (crossingMs - w.t) / 1000)) : null;
          if (best === null || best < minLeadS) {
            problems.push(`EGEN VARNING SAKNAS vid ${bridge} ${new Date(crossingMs).toISOString()} (${mmsi}): `
              + `${best === null ? 'ingen varning där båten är medlem' : `bästa egna varningen ${Math.round(best)} s`} `
              + `före den sanna korsningen (krav ${minLeadS}–${maxAgeS} s, levererad, rätt riktning; absorption räknas inte)`);
          }
          previousMs = crossingMs;
        }
      }
    }
  }
  // Familj E (fältprovet 2026-11-12): ETA-löftet efter avgång ur väntan,
  // mätt mot den SANNA korsningen (generatorns bana), inte mot appens
  // bokförda passage. Revision 1 (granskningen 2026-11-13, A5): varje stopp
  // före korsningen ger en avgång att döma, den stående texten prövas var
  // 30:e sekund och inte bara vid övergångarna, och en förväntan som inte
  // hittar någon avgång eller någon ETA-text att döma är ett FEL.
  if (e.departureEta) {
    const { bridge, maxOverMin, maxUnderMin } = e.departureEta;
    const journey = singleJourney(scenario, truthPaths, samples, bridge, 'AVGÅNGS-ETA', problems);
    if (journey) {
      const { stopEnds, crossingAfter } = journey;
      let judged = 0;
      let points = 0;
      stopEnds.forEach((departure, i) => {
        const crossing = crossingAfter(departure.aisTimestamp);
        // Ett stopp efter korsningen har ingen korsning att döma mot.
        if (!Number.isFinite(crossing)) return;
        const end = Math.min(crossing, i + 1 < stopEnds.length ? stopEnds[i + 1].aisTimestamp : Infinity);
        judged += 1;
        const first = (result.bridgeTextTransitions || []).find((x) => x.t >= departure.aisTimestamp && x.t < end);
        const firstMatch = first ? etaClauseFor(bridge).exec(first.text) : null;
        if (!firstMatch || firstMatch[1] === undefined) {
          problems.push(`AVGÅNGS-ETA: ingen numerisk ETA-text för ${bridge} vid avgången `
            + `${new Date(departure.aisTimestamp).toISOString()} (${first ? `"${first.text}"` : 'ingen text'})`);
        }
        for (const p of etaTextPoints(result.bridgeTextTransitions, bridge, departure.aisTimestamp, end, crossing)) {
          points += 1;
          if (p.err > maxOverMin || p.err < -maxUnderMin) {
            problems.push(`AVGÅNGS-ETA: ${new Date(p.t).toISOString()} "${p.label}" mot sann restid `
              + `${p.truthMin.toFixed(1)} min (fel ${p.err >= 0 ? '+' : ''}${p.err.toFixed(1)}, tillåtet `
              + `−${maxUnderMin} till +${maxOverMin})`);
          }
        }
      });
      if (judged === 0) problems.push(`AVGÅNGS-ETA: ingen avgång före korsningen av ${bridge} att döma`);
      else if (points === 0) problems.push(`AVGÅNGS-ETA: ingen ETA-text för ${bridge} att döma efter avgången`);
      // U59: öppningskortets minut i samma fönster (avgång till korsning).
      const { cardMaxOverMin, cardMaxUnderMin } = e.departureEta;
      if (Number.isFinite(cardMaxOverMin) || Number.isFinite(cardMaxUnderMin)) {
        let cards = 0;
        stopEnds.forEach((departure, i) => {
          const crossing = crossingAfter(departure.aisTimestamp);
          if (!Number.isFinite(crossing)) return;
          const end = Math.min(crossing, i + 1 < stopEnds.length ? stopEnds[i + 1].aisTimestamp : Infinity);
          for (const w of openings.filter((x) => x.bridge === bridge && x.t >= departure.aisTimestamp && x.t < end)) {
            cards += 1;
            const err = w.etaMin - (crossing - w.t) / 60000;
            if ((Number.isFinite(cardMaxOverMin) && err > cardMaxOverMin)
                || (Number.isFinite(cardMaxUnderMin) && err < -cardMaxUnderMin)) {
              problems.push(`AVGÅNGS-ETA: öppningskortet ${w.eventId} ${w.iso} eta ${w.etaMin} mot sann restid `
                + `${((crossing - w.t) / 60000).toFixed(1)} min (fel ${err >= 0 ? '+' : ''}${err.toFixed(1)}, tillåtet `
                + `−${cardMaxUnderMin ?? '∞'} till +${cardMaxOverMin ?? '∞'})`);
            }
          }
        });
        if (cards === 0) problems.push(`AVGÅNGS-ETA: inget öppningskort för ${bridge} efter avgången att döma`);
      }
    }
  }
  // U53 (2026-11-23): textens kö vid en mellanbro.
  const transitionsU53 = (result.bridgeTextTransitions || []).filter((x) => Number.isFinite(x.t));
  const alongWindow = (w, tag) => {
    const from = truthReachMs(truthPaths, w.mmsi, w.fromS);
    const to = Number.isFinite(w.durationS) ? from + ((w.delayS || 0) + w.durationS) * 1000
      : truthReachMs(truthPaths, w.mmsi, w.toS);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      problems.push(`${tag}: ${w.mmsi} når aldrig ${!Number.isFinite(from) ? w.fromS : w.toS} på sin sanna bana`);
      return null;
    }
    return [from + (w.delayS || 0) * 1000, to];
  };
  for (const w of e.waitTextWindows || []) {
    const win = alongWindow(w, 'VÄNTTEXT');
    if (!win) continue;
    const pts = standingTexts(transitionsU53, win[0], win[1]);
    if (pts.length === 0) problems.push(`VÄNTTEXT: tomt fönster för ${w.mmsi}`);
    for (const x of pts) {
      const n = waitClauseCount(x.text, w.at, w.target);
      const bad = w.must ? (n === 0 || (Number.isFinite(w.count) && n !== w.count)) : waitClauseCount(x.text, w.at) > 0;
      if (bad) {
        problems.push(`VÄNTTEXT: ${new Date(x.t).toISOString()} "${x.text}" — ${w.must
          // U65: vid målbron (at === target) har vänttexten inget "på väg mot".
          ? `ska säga ${w.count ? `${w.count} ` : ''}väntar vid ${w.at}${w.target && w.target !== w.at ? ` på väg mot ${w.target}` : ''}`
          : `får inte säga väntar vid ${w.at}`}`);
        break;
      }
    }
  }
  for (const w of e.textCountAlong || []) {
    const win = alongWindow(w, 'ANTAL LÄNGS BANAN');
    if (!win) continue;
    for (const x of standingTexts(transitionsU53, win[0], win[1])) {
      const n = vesselCountInText(x.text, w.bridge);
      if ((Number.isFinite(w.min) && n < w.min) || (Number.isFinite(w.max) && n > w.max)) {
        problems.push(`ANTAL LÄNGS BANAN: ${n} mot ${w.bridge} ${new Date(x.t).toISOString()} ("${x.text}"), `
          + `förväntat ${w.min ?? 0}–${w.max ?? '∞'}`);
        break;
      }
    }
  }
  if (e.etaNotRaisedOverWait) {
    const { bridge, at } = e.etaNotRaisedOverWait;
    let judged = 0;
    let lastNum = null;
    let inWait = false;
    let before = null;
    for (const x of transitionsU53) {
      const waiting = waitClauseCount(x.text, at, bridge) > 0;
      const n = etaMinutesFor(x.text, bridge);
      if (waiting && !inWait) {
        inWait = true; before = lastNum;
      }
      if (!waiting && inWait) {
        inWait = false;
        if (before !== null && n !== null) {
          judged += 1;
          if (n > before) {
            problems.push(`TIDEN STEG UNDER VÄNTAN: "om ${before}" före vänttexten vid ${at}, `
              + `"om ${n}" efter (${new Date(x.t).toISOString()})`);
          }
        }
      }
      if (n !== null) lastNum = n;
    }
    if (judged === 0) problems.push(`TIDEN UNDER VÄNTAN: ingen vänttext vid ${at} med siffra före och efter att döma`);
  }
  if (e.maxWaitToggles) {
    const { at, max } = e.maxWaitToggles;
    let toggles = 0;
    let prev = false;
    for (const x of transitionsU53) {
      const now = waitClauseCount(x.text, at) > 0;
      if (now !== prev) toggles += 1;
      prev = now;
    }
    if (toggles > max) problems.push(`FLIMMER: vänttexten vid ${at} kom och gick ${toggles} gånger (högst ${max})`);
  }
  // U54 (2026-11-23): restid över 60 min visas som "ETA okänd".
  if (e.etaNeverAbove) {
    const { bridge, max } = e.etaNeverAbove;
    const bad = transitionsU53.find((x) => (etaMinutesFor(x.text, bridge) ?? 0) > max);
    if (bad) problems.push(`RESTID ÖVER ${max}: ${new Date(bad.t).toISOString()} "${bad.text}"`);
  }
  if (e.etaSeenAtLeast) {
    const { bridge, min } = e.etaSeenAtLeast;
    if (!transitionsU53.some((x) => (etaMinutesFor(x.text, bridge) ?? -1) >= min)) {
      problems.push(`RESTID: ingen text visar minst "om ${min} minuter" för ${bridge}`);
    }
  }
  // U68 (omgång 9, känd gräns): brotextens klausul för en bro i fönster som
  // räknas i sekunder från en av båtens egna rader: 'first' (första raden) eller
  // 'largestGap' (sista raden före hennes längsta glapp). Formerna är
  // bridgeClauseForm:s (strax, okänd, num, vänt, ingen); varje stående text i
  // fönstret (övergångar och var 30:e s) ska ha formen.
  for (const w of e.clauseWindows || []) {
    const own = (samples || []).filter((x) => x.mmsi === w.mmsi && Number.isFinite(x.aisTimestamp))
      .map((x) => x.aisTimestamp).sort((a, b) => a - b);
    let anchor = own.length ? own[0] : null;
    if (w.anchor === 'largestGap') {
      let best = -1;
      for (let i = 0; i + 1 < own.length; i++) {
        if (own[i + 1] - own[i] > best) {
          best = own[i + 1] - own[i]; anchor = own[i];
        }
      }
      if (best < 0) anchor = null;
    }
    if (!Number.isFinite(anchor)) {
      problems.push(`KLAUSUL: ${w.mmsi} saknar rader att räkna fönstren från`);
      continue;
    }
    for (const [fromS, toS, form] of w.windows) {
      const pts = standingTexts(transitionsU53, anchor + fromS * 1000, anchor + toS * 1000);
      const bad = pts.find((x) => bridgeClauseForm(x.text, w.bridge) !== form);
      if (bad) {
        problems.push(`KLAUSUL: ${new Date(bad.t).toISOString()} (${Math.round((bad.t - anchor) / 1000)} s efter `
          + `${w.mmsi}:s rad) "${bad.text}" — ${w.bridge} ska vara "${form}" under ${fromS}–${toS} s; `
          + 'beteendet har ändrats, lås om medvetet (ARCHITECTURE §5, U68)');
      }
    }
  }
  for (const bridge of e.unknownSeen || []) {
    if (!transitionsU53.some((x) => bridgeClauseForm(x.text, bridge) === 'okänd')) {
      problems.push(`ETA OKÄND: ingen text visar "ETA okänd" för ${bridge}`);
    }
  }
  // U59 (2026-11-24): restiden mot den sanna korsningen i ett fönster på banan.
  for (const w of e.etaTruthAlong || []) {
    const win = alongWindow(w, 'RESTID LÄNGS BANAN');
    if (!win) continue;
    const sBridge = METRICS.cum[PATH_INDEX[w.bridge]];
    const crossing = truthCrossings((truthPaths || {})[w.mmsi] || [], sBridge)
      .map((c) => BASE_TIME_MS + c.tS * 1000).find((t) => t > win[0]);
    if (!Number.isFinite(crossing)) {
      problems.push(`RESTID LÄNGS BANAN: ${w.mmsi} korsar aldrig ${w.bridge} efter fönstrets början`);
      continue;
    }
    const pts = etaTextPoints(result.bridgeTextTransitions, w.bridge, win[0], Math.min(win[1], crossing), crossing);
    if (pts.length === 0) problems.push(`RESTID LÄNGS BANAN: ingen ETA-text för ${w.bridge} att döma i fönstret`);
    if (Number.isFinite(w.minErrMin) && pts.length > 0 && !pts.some((p) => p.err >= w.minErrMin)) {
      problems.push(`RESTID LÄNGS BANAN (KÄND GRÄNS): ingen text för ${w.bridge} i fönstret ligger minst `
        + `${w.minErrMin} min för högt — beteendet har ändrats; lås om medvetet (ARCHITECTURE §8 e)`);
    }
    for (const p of pts) {
      if (p.err < -w.maxUnderMin || (Number.isFinite(w.maxOverMin) && p.err > w.maxOverMin)) {
        problems.push(`RESTID LÄNGS BANAN: ${new Date(p.t).toISOString()} "${p.label}" mot sann restid `
          + `${p.truthMin.toFixed(1)} min (fel ${p.err >= 0 ? '+' : ''}${p.err.toFixed(1)}, tillåtet `
          + `−${w.maxUnderMin} till +${w.maxOverMin ?? '∞'})`);
      }
    }
    if (Number.isFinite(w.cardMaxOverMin) || Number.isFinite(w.cardMaxUnderMin)) {
      const cards = openings.filter((x) => x.bridge === w.bridge && x.t >= win[0] && x.t < Math.min(win[1], crossing));
      if (cards.length === 0) problems.push(`RESTID LÄNGS BANAN: inget öppningskort för ${w.bridge} i fönstret`);
      for (const c of cards) {
        const err = c.etaMin - (crossing - c.t) / 60000;
        if ((Number.isFinite(w.cardMaxOverMin) && err > w.cardMaxOverMin)
            || (Number.isFinite(w.cardMaxUnderMin) && err < -w.cardMaxUnderMin)) {
          problems.push(`RESTID LÄNGS BANAN: öppningskortet ${c.eventId} ${c.iso} eta ${c.etaMin} mot sann restid `
            + `${((crossing - c.t) / 60000).toFixed(1)} min (fel ${err >= 0 ? '+' : ''}${err.toFixed(1)})`);
        }
      }
    }
  }
  // U30 (2026-11-15): stilla båt utanför väntzonen och gränserna runt den.
  if (e.stillUnknown) {
    const { bridge, afterS } = e.stillUnknown;
    const stops = journeyStops(scenario, truthPaths, samples, 'STILLA-OKÄND', problems) || [];
    let unknownSeen = 0;
    for (const st of stops) {
      for (const x of standingTexts(result.bridgeTextTransitions, st.t0 + afterS * 1000, st.tEnd)) {
        const f = bridgeClauseForm(x.text, bridge);
        if (f === 'okänd') unknownSeen += 1;
        else if (f !== 'ingen') {
          problems.push(`STILLA-OKÄND: ${new Date(x.t).toISOString()} "${x.text}" — ${bridge} ska vara "ETA okänd" `
            + `${afterS} s in i stoppet`);
        }
      }
    }
    if (stops.length && unknownSeen === 0) problems.push(`STILLA-OKÄND: ingen "ETA okänd" för ${bridge} under stoppet`);
  }
  if (e.noUnknownDuringStop) {
    const { bridge, extraS, windowS } = e.noUnknownDuringStop;
    const stops = journeyStops(scenario, truthPaths, samples, 'INGEN-OKÄND', problems) || [];
    for (const st of stops) {
      const end = Number.isFinite(windowS) ? st.t0 + windowS * 1000 : st.tEnd + (extraS || 0) * 1000;
      for (const x of standingTexts(result.bridgeTextTransitions, st.t0, end)) {
        if (bridgeClauseForm(x.text, bridge) === 'okänd') {
          problems.push(`INGEN-OKÄND: ${new Date(x.t).toISOString()} "${x.text}" — ${bridge} får inte vara "ETA okänd" här`);
          break;
        }
      }
    }
  }
  if (e.numericAfterMoveM) {
    const { bridge, moveM, graceS } = e.numericAfterMoveM;
    const stops = journeyStops(scenario, truthPaths, samples, 'SIFFRA-EFTER-RÖRELSE', problems) || [];
    for (const st of stops) {
      const movedMs = movedFromStopMs(truthPaths, st, moveM);
      if (!Number.isFinite(movedMs)) continue;
      const end = st.tEnd + 30 * 60000;
      const pts = standingTexts(result.bridgeTextTransitions, movedMs + (graceS || 0) * 1000, end);
      const bad = pts.find((x) => bridgeClauseForm(x.text, bridge) === 'okänd');
      if (bad) {
        problems.push(`SIFFRA-EFTER-RÖRELSE: ${new Date(bad.t).toISOString()} "${bad.text}" — båten har flyttat sig `
          + `${moveM} m sedan ${new Date(movedMs).toISOString()}`);
      }
      // Aldrig "ETA okänd" direkt till "strax" för en båt som rört sig.
      const list = (result.bridgeTextTransitions || []).filter((x) => x.t >= st.t0 && x.t <= end);
      for (let i = 1; i < list.length; i++) {
        const before = bridgeClauseForm(list[i - 1].text, bridge);
        const nowForm = bridgeClauseForm(list[i].text, bridge);
        if (before === 'okänd' && nowForm === 'strax') {
          problems.push(`SIFFRA-EFTER-RÖRELSE: ${list[i].iso} "ETA okänd" direkt till "strax"`);
        }
      }
    }
  }
  if (e.maxFormChangesPerStop) {
    const { bridge, max } = e.maxFormChangesPerStop;
    const stops = journeyStops(scenario, truthPaths, samples, 'FORMBYTEN', problems) || [];
    for (const st of stops) {
      const end = Number.isFinite(st.departure) ? st.departure + 180000 : st.tEnd;
      const forms = standingTexts(result.bridgeTextTransitions, st.t0, end)
        .map((x) => bridgeClauseForm(x.text, bridge))
        .map((f) => (f === 'strax' ? 'num' : f));
      const changes = forms.filter((f, i) => i > 0 && f !== forms[i - 1]).length;
      if (changes > max) {
        problems.push(`FORMBYTEN: ${bridge} byter form ${changes} gånger kring stoppet ${new Date(st.t0).toISOString()} `
          + `(högst ${max}): ${forms.filter((f, i) => i === 0 || f !== forms[i - 1]).join(' → ')}`);
      }
    }
  }
  // Familj E, revision 1 (granskningen 2026-11-13, A3): KRYP I KÖN OCH NY
  // VÄNTAN. Informativ förväntan: den påstår INTE att beteendet är rätt, bara
  // att det inte får bli mer optimistiskt än i dag. Från första avgången ur
  // det första stoppet till den sista avgången (den verkliga) får ingen
  // ETA-text för bron ligga mer än maxUnderMin minuter under den sanna
  // restiden, och inget öppningskort för bron mer än maxCardUnderMin minuter.
  if (e.creepEta) {
    const { bridge, maxUnderMin, maxCardUnderMin } = e.creepEta;
    const journey = singleJourney(scenario, truthPaths, samples, bridge, 'KRYP-ETA', problems);
    if (journey) {
      const { stopEnds, crossingAfter } = journey;
      if (stopEnds.length < 2) {
        problems.push(`KRYP-ETA: ${stopEnds.length} avgång(ar) ur stopp, minst två krävs (krypet och den verkliga)`);
      } else {
        const from = stopEnds[0].aisTimestamp;
        const to = stopEnds[stopEnds.length - 1].aisTimestamp;
        const crossing = crossingAfter(from);
        const pts = Number.isFinite(crossing)
          ? etaTextPoints(result.bridgeTextTransitions, bridge, from, to, crossing) : [];
        if (pts.length === 0) problems.push(`KRYP-ETA: ingen ETA-text för ${bridge} att döma under krypet och väntan`);
        for (const p of pts) {
          if (p.err < -maxUnderMin) {
            problems.push(`KRYP-ETA: ${new Date(p.t).toISOString()} "${p.label}" mot sann restid `
              + `${p.truthMin.toFixed(1)} min (fel ${p.err.toFixed(1)}, dagens gräns −${maxUnderMin})`);
          }
        }
        for (const w of openings.filter((x) => x.bridge === bridge && x.t >= from && x.t < to)) {
          if (!Number.isFinite(w.etaMin) || !Number.isFinite(crossing)) continue;
          const err = w.etaMin - (crossing - w.t) / 60000;
          if (err < -maxCardUnderMin) {
            problems.push(`KRYP-ETA: öppningskortet ${w.eventId} ${w.iso} eta ${w.etaMin} mot sann restid `
              + `${((crossing - w.t) / 60000).toFixed(1)} min (fel ${err.toFixed(1)}, dagens gräns −${maxCardUnderMin})`);
          }
        }
      }
    }
  }
  // Fältprovet 2026-11-13 (familj C, C2): NOTISENS LEDTID OCH SIDA MOT DEN
  // SANNA KORSNINGEN. En förvarning ("närmar sig", already_passed=false) för
  // båtens korsning av bron ska komma minst N s före korsningen och efter
  // båtens förra korsning av samma bro. Korsningen kommer ur generatorns sanna
  // bana, inte ur appens bokföring.
  if (e.approachNoticeLeadS) {
    for (const [bridge, minLeadS] of Object.entries(e.approachNoticeLeadS)) {
      const sBridge = METRICS.cum[PATH_INDEX[bridge]];
      for (const [mmsi, truthPath] of Object.entries(truthPaths || {})) {
        let previousMs = -Infinity;
        for (const c of truthCrossings(truthPath, sBridge)) {
          const crossingMs = BASE_TIME_MS + c.tS * 1000;
          const leads = notifications
            .filter((n) => String(n.mmsi) === mmsi && n.bridge === bridge && n.alreadyPassed === false
              && Number.isFinite(n.t) && n.t > previousMs && n.t < crossingMs)
            .map((n) => (crossingMs - n.t) / 1000);
          const best = leads.length ? Math.max(...leads) : null;
          if (best === null || best < minLeadS) {
            problems.push(`SEN FÖRVARNING vid ${bridge} ${new Date(crossingMs).toISOString()} (${mmsi}, ${c.dir}): `
              + `${best === null ? 'ingen förvarning före korsningen' : `bästa förvarningen ${Math.round(best)} s`} `
              + `före den sanna korsningen (krav ≥ ${minLeadS} s)`);
          }
          previousMs = crossingMs;
        }
      }
    }
  }
  // Spegeln: ingen förvarning för en bro som båten redan har passerat (efter
  // en sann korsning och före nästa). Passerad form (already_passed) är
  // tillåten.
  if (e.noApproachNoticeAfterCrossing) {
    for (const bridge of e.noApproachNoticeAfterCrossing) {
      const sBridge = METRICS.cum[PATH_INDEX[bridge]];
      for (const [mmsi, truthPath] of Object.entries(truthPaths || {})) {
        const crossings = truthCrossings(truthPath, sBridge).map((c) => BASE_TIME_MS + c.tS * 1000);
        crossings.forEach((crossingMs, i) => {
          const nextMs = i + 1 < crossings.length ? crossings[i + 1] : Infinity;
          for (const n of notifications.filter((x) => String(x.mmsi) === mmsi && x.bridge === bridge
            && x.alreadyPassed === false && Number.isFinite(x.t) && x.t > crossingMs && x.t < nextMs)) {
            problems.push(`FÖRVARNING EFTER PASSAGEN: ${bridge} ${n.iso || new Date(n.t).toISOString()} (${mmsi}) `
              + `"${n.message}" ${Math.round((n.t - crossingMs) / 1000)} s efter den sanna korsningen`);
          }
        });
      }
    }
  }
  // Familj C3 (2026-11-14): NOTISEN FÅR INTE KOMMA MINUTER EFTER PASSAGEN.
  // För varje sann korsning ska båtens första notis för bron (efter förra
  // korsningen) komma senast N s efter den, i vilken form som helst.
  if (e.maxNoticeDelayS) {
    for (const [bridge, maxS] of Object.entries(e.maxNoticeDelayS)) {
      const sBridge = METRICS.cum[PATH_INDEX[bridge]];
      // Granskningen av C3: utan en enda sann korsning prövas ingenting, och
      // förväntan fick då inte bli grön (samma krav som maxOpeningAgeS).
      let tested = 0;
      for (const [mmsi, truthPath] of Object.entries(truthPaths || {})) {
        let previousMs = -Infinity;
        for (const c of truthCrossings(truthPath, sBridge)) {
          tested++;
          const crossingMs = BASE_TIME_MS + c.tS * 1000;
          const first = notifications
            .filter((n) => String(n.mmsi) === mmsi && n.bridge === bridge && Number.isFinite(n.t) && n.t > previousMs)
            .sort((x, y) => x.t - y.t)[0];
          if (!first || first.t > crossingMs + maxS * 1000) {
            problems.push(`SEN NOTIS vid ${bridge} ${new Date(crossingMs).toISOString()} (${mmsi}, ${c.dir}): `
              + `${first ? `första notisen ${Math.round((first.t - crossingMs) / 1000)} s efter korsningen ("${first.message}")` : 'ingen notis'} `
              + `(krav ≤ ${maxS} s)`);
          }
          previousMs = crossingMs;
        }
      }
      if (tested === 0) {
        problems.push(`maxNoticeDelayS: ingen sann korsning av ${bridge} att pröva — förväntan mäter ingenting`);
      }
    }
  }
  // Nattjakten F12 (2026-11-16): NOTISENS RIKTNINGSFÄLT MOT DEN SANNA BANAN.
  // Riktningen är båtens färd under steget fram till notisen (sann bana, s
  // växer = norrut; ett stillastående steg ärver föregående rörliga). Antalet
  // notiser vid bron med fel riktning ska vara exakt `mismatches`: 0 i
  // rättningens fall, 1 i U18-motfallet där den kända gränsen låses.
  if (e.noticeDirectionVsTruth) {
    for (const [bridge, { mismatches }] of Object.entries(e.noticeDirectionVsTruth)) {
      let tested = 0;
      const wrong = [];
      for (const [mmsi, truthPath] of Object.entries(truthPaths || {})) {
        for (const n of notifications.filter((x) => String(x.mmsi) === mmsi && x.bridge === bridge && Number.isFinite(x.t))) {
          const tS = (n.t - BASE_TIME_MS) / 1000;
          let i = truthPath.findIndex((p, k) => k > 0 && truthPath[k - 1].tS < tS && p.tS >= tS);
          while (i > 0 && truthPath[i].s === truthPath[i - 1].s) i--;
          if (i <= 0) continue;
          tested++;
          const truthDir = truthPath[i].s > truthPath[i - 1].s ? 'northbound' : 'southbound';
          if (n.direction !== truthDir) wrong.push(`${n.iso || new Date(n.t).toISOString()} "${n.message}" ${n.direction} (sant ${truthDir})`);
        }
      }
      if (tested === 0) problems.push(`noticeDirectionVsTruth: ingen notis vid ${bridge} att pröva`);
      if (wrong.length !== mismatches) {
        problems.push(`RIKTNINGSFÄLT vid ${bridge}: ${wrong.length} notiser med fel riktning (förväntat ${mismatches})`
          + `${wrong.length ? `: ${wrong.join('; ')}` : ''}`);
      }
    }
  }
  // Fältprovet 10–13 november (familj B): SPÄRREN VID EN TIDIGARE BRO mot den
  // sanna banan. En varning för `bro` som täcker båten får inte gå innan hon
  // korsat `tidigare bro` på vägen dit: för varje sann korsning av bron ska
  // varje täckande varning efter förra korsningen av bron ligga efter båtens
  // senaste sanna korsning av den tidigare bron i samma riktning. Täckning
  // räknas som i openingLeadS (medlem, ledare eller absorption).
  if (e.openingNotBeforeCrossing) {
    const coverage = result.openingCoverage || [];
    for (const [bridge, earlier] of Object.entries(e.openingNotBeforeCrossing)) {
      const sBridge = METRICS.cum[PATH_INDEX[bridge]];
      const sEarlier = METRICS.cum[PATH_INDEX[earlier]];
      for (const [mmsi, truthPath] of Object.entries(truthPaths || {})) {
        let previousMs = -Infinity;
        for (const c of truthCrossings(truthPath, sBridge)) {
          const crossingMs = BASE_TIME_MS + c.tS * 1000;
          const earlierMs = truthCrossings(truthPath, sEarlier)
            .filter((x) => x.dir === c.dir)
            .map((x) => BASE_TIME_MS + x.tS * 1000)
            .filter((t) => t > previousMs && t < crossingMs)
            .pop();
          if (Number.isFinite(earlierMs)) {
            for (const w of openings.filter((x) => x.bridge === bridge && Number.isFinite(x.t)
              && x.t > previousMs && x.t < crossingMs)) {
              const member = (w.mmsis || []).map(String).includes(mmsi) || String(w.leadMmsi) === mmsi;
              const cov = coverage.find((x) => x.bridge === bridge && String(x.mmsi) === mmsi
                && x.eventId === w.eventId && x.t > previousMs && x.t < crossingMs);
              let coveredAt = null;
              if (member) coveredAt = w.t;
              else if (cov) coveredAt = Math.max(w.t, cov.t);
              if (coveredAt !== null && coveredAt < earlierMs) {
                problems.push(`FÖR TIDIG ÖPPNINGSVARNING: ${bridge} ${w.eventId} ${w.iso} (${w.firedBy}) täcker ${mmsi} `
                  + `${Math.round((earlierMs - coveredAt) / 1000)} s innan hon korsat ${earlier} `
                  + `(${new Date(earlierMs).toISOString()}); korsningen av ${bridge} ${new Date(crossingMs).toISOString()}`);
              }
            }
          }
          previousMs = crossingMs;
        }
      }
    }
  }
  // Familj A (fältprovet 2026-11-12): spegeln av openingLeadS. Den SENASTE
  // täckande varningen före varje sann korsning får vara högst N s gammal —
  // en varning från en anflygning timmar tidigare räknas inte som förvarning
  // för korsningen (openingLeadS och openingBeforeEachPassage godtar den).
  if (e.maxOpeningAgeS) {
    const coverage = result.openingCoverage || [];
    for (const [bridge, maxAgeS] of Object.entries(e.maxOpeningAgeS)) {
      const sBridge = METRICS.cum[PATH_INDEX[bridge]];
      // Granskningen (L1): utan prövade korsningar (scenario utan ben eller
      // utan korsning av bron) hade förväntan passerat tyst.
      let tested = 0;
      for (const [mmsi, truthPath] of Object.entries(truthPaths || {})) {
        let previousMs = -Infinity;
        for (const c of truthCrossings(truthPath, sBridge)) {
          tested++;
          const crossingMs = BASE_TIME_MS + c.tS * 1000;
          // Samma täckningstid som openingLeadS: varningens tid för medlem och
          // ledare, absorptionens för en båt som anslöt till händelsen.
          const coveredAt = (w) => {
            if ((w.mmsis || []).map(String).includes(mmsi) || String(w.leadMmsi) === mmsi) return w.t;
            const cov = coverage.find((x) => x.bridge === bridge && String(x.mmsi) === mmsi
              && x.eventId === w.eventId && x.t > previousMs && x.t < crossingMs);
            return cov ? Math.max(w.t, cov.t) : null;
          };
          const ages = openings
            .filter((w) => w.bridge === bridge && Number.isFinite(w.t) && w.t > previousMs && w.t < crossingMs)
            .map(coveredAt)
            .filter((t) => Number.isFinite(t))
            .map((t) => (crossingMs - t) / 1000);
          const newestS = ages.length ? Math.min(...ages) : null;
          if (newestS === null || newestS > maxAgeS) {
            problems.push(`GAMMAL FÖRVARNING vid ${bridge} ${new Date(crossingMs).toISOString()} (${mmsi}, ${c.dir}): `
              + `${newestS === null ? 'ingen täckande varning' : `senaste varningen ${Math.round(newestS)} s`} före den `
              + `sanna korsningen (högst ${maxAgeS} s)`);
          }
          previousMs = crossingMs;
        }
      }
      if (tested === 0) problems.push(`maxOpeningAgeS: ingen sann korsning av ${bridge} att pröva`);
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
// SYNTH_FILTER=<text>: kör bara scenarier vars namn innehåller texten (felsökning).
const SELECTED = process.env.SYNTH_FILTER
  ? SCENARIOS.filter((x) => x.name.includes(process.env.SYNTH_FILTER)) : SCENARIOS;
console.log('\n=== SYNTETISK SCENARIOSVIT ===');
console.log(`${SELECTED.length} scenarier (seedade, deterministiska)\n`);

for (const scenario of SELECTED) {
  let outcome;
  try {
    const {
      result, sampleCount, truthPaths, samples,
    } = runScenario(scenario);
    const problems = checkExpectations(scenario, result, truthPaths, samples);
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
