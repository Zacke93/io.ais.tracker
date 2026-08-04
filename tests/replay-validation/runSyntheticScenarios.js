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
const {
  generateScenario, buildPath, pathMetrics, pointAt, BASE_TIME_MS,
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

/**
 * Kurerad scenariomatris. Förväntningar:
 *  - minTargetPassages: minst N detekterade målbro-passager (detektering + INV-5 ⇒ notiser)
 *  - noTargetPassages: inga målbro-passager får detekteras
 *  - zeroNotifications: inga notiser alls
 *  - noVesselText: ingen "på väg mot"-text får publiceras
 *  - minNotifiedBridges: dessa broar MÅSTE ha fått notis
 *  - forbiddenNotifiedBridges: dessa broar får INTE ha fått notis
 *  - maxNotifiedPerBridge: {bro: N} — max antal notiser per bro (dubblettvakt)
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
    name: 'u-sväng-efter-Klaffbron',
    seed: 25,
    vessels: [{
      mmsi: '901000018', direction: 'north', speedKn: 4.5, uTurnAtFraction: 0.45,
    }],
    expect: { minTargetPassages: 2, minNotifiedBridges: ['Klaffbron'] },
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
    expect: { minTargetPassages: 1, minNotifiedBridges: ['Stridsbergsbron'] },
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
    expect: { minTargetPassages: 1, minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron'] },
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
    // skapar en NY instans mot samma settings-store mitt i resan (strax efter
    // Klaffbron-passagen). Testar load/save-cykeln i HELKEDJAN: den
    // persistenta 2h-dedupen laddas om och måste blockera återfödelse-
    // inferensens omnotiser för redan notifierade broar (Kanalinfarten/
    // Olidebron/Klaffbron ligger bakom den återfödda båten) — dubbletter
    // fälls av fatala INV-2. Post-restart-broarna (Jvb/Strids/Stallbacka)
    // ska notifieras normalt.
    name: 'omstart-mitt-i-passage',
    seed: 45,
    vessels: [{
      mmsi: '901000045',
      name: 'SYNT-OMSTART',
      direction: 'north',
      speedKn: 5.0,
    }],
    events: [{
      ctrl: 'restart',
      // ~200 m norr om Klaffbron: restid = distans / (5,0 kn × 0,5144 m/s)
      atOffsetS: Math.round((METRICS.cum[2] + 200) / (5.0 * 0.5144)),
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
];

function runScenario(scenario) {
  const samples = generateScenario(scenario);
  const tmpFile = path.join(os.tmpdir(), `synthetic-${scenario.seed}.jsonl`);
  fs.writeFileSync(tmpFile, samples.map((s) => JSON.stringify(s)).join('\n'));
  try {
    const stdout = execFileSync('node', [RUNNER, tmpFile], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000,
    });
    const m = stdout.match(/__REPLAY_JSON__([\s\S]*?)__END__/);
    if (!m) throw new Error('Ingen JSON-markör i replay-output');
    return { result: JSON.parse(m[1]), sampleCount: samples.length };
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function checkExpectations(scenario, result) {
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
  // ---------------------------------------------------------------------
  // ÖPPNINGSVARNINGAR (etapp 6, 2026-08-03) — additiv dimension
  // ---------------------------------------------------------------------
  const openings = result.openingWarnings || [];
  // Servicen kan avfyra utan att kortet nås (dedup som spärrar fel, saknat
  // kort, kastande tokenbygge). Skillnaden är alltid en bugg i leveransvägen.
  if (Number.isFinite(result.openingServiceFires)
      && result.openingServiceFires !== openings.length) {
    problems.push(`ÖPPNINGSLEVERANS: servicen avfyrade ${result.openingServiceFires} men kortet fick ${openings.length}`);
  }
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

  const invariantViolations = validateInvariants(result);
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
    const { result, sampleCount } = runScenario(scenario);
    const problems = checkExpectations(scenario, result);
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
