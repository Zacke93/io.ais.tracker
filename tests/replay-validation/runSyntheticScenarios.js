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
  generateScenario, buildPath, pathMetrics, BASE_TIME_MS,
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
 */
const SCENARIOS = [
  {
    name: 'ren-nord-normal',
    seed: 11,
    vessels: [{ mmsi: '901000001', direction: 'north', speedKn: 4.5 }],
    expect: { minTargetPassages: 2, minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron'] },
  },
  {
    name: 'ren-syd-normal',
    seed: 12,
    vessels: [{ mmsi: '901000002', direction: 'south', speedKn: 4.5 }],
    expect: { minTargetPassages: 2, minNotifiedBridges: ['Klaffbron', 'Stridsbergsbron'] },
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
    expect: { minTargetPassages: 2 },
  },
  {
    name: 'glapp-över-målbro (SILJA-klassen)',
    seed: 15,
    vessels: [{
      mmsi: '901000005', direction: 'north', speedKn: 4.5, gap: { atFraction: 0.36, durationS: 480 },
    }],
    expect: { minNotifiedBridges: ['Klaffbron'] }, // failsafen ska rädda notisen trots glapp
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
    expect: { minTargetPassages: 2 }, // ren stillhet får ALDRIG demotera
  },
  {
    name: 'kajliggare-40min (kajbuggen)',
    seed: 18,
    vessels: [{
      mmsi: '901000008', direction: 'north', speedKn: 0, jitterM: 2, moorAt: { ...QUAY, durationS: 2400, navStatus: null },
    }],
    expect: { zeroNotifications: true, noVesselText: true },
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
    expect: { minTargetPassages: 4 },
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
    expect: { zeroNotifications: true, noVesselText: true },
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
    expect: { minTargetPassages: 2 },
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
    expect: { minTargetPassages: 2 },
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
    expect: { zeroNotifications: true, noVesselText: true },
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
  // B1-kontrakt (2026-07-03): token-fallbacken är "Okänd båt" — den råa
  // aisstream-platshållaren "Unknown" får ALDRIG nå en notis.
  if (e.noUnknownTokens) {
    const raw = notifications.filter((n) => n.name === 'Unknown');
    if (raw.length > 0) problems.push(`"Unknown" läckte till ${raw.length} notistokens`);
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
      outcome = `✅ ${scenario.name.padEnd(38)} samples=${sampleCount}, passager=${(result.targetPassages || []).length}, notiser=${result.notificationCount}`;
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
