'use strict';

/**
 * M2-GRIND (helkodsgranskning runda 4, 2026-08-23) — VERIFIERINGSGRINDEN
 * ÄRVDE DEN DEFEKT DEN SKULLE UPPTÄCKA.
 *
 * Produktionens kajgrind (app.js) hade ett enkelsampel-undantag som läste ETT
 * RÅTT sog-värde: ett brusigt fartvärde öppnade hela skyddet och gav en
 * bridge_opening_soon nästan tre timmar för tidigt. runOpeningGates.js — den
 * grind som ska FÅNGA sådana falska varningar — hårdkodade samma tröskel
 * (3,13 kn) och klassade kandidaten som "rörlig" på fönstrets maxfart. Följden
 * var att replay:openings var grön DELVIS FÖR ATT GRINDEN VAR BLIND:
 * strukturellt kunde den inte se felmoden.
 *
 * FIXEN: grinden speglar nu produktionen genom den DELADE modulen
 * lib/utils/quayTransitProof.js (isCorroboratedTransit), och tröskeln kommer
 * ur BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN i stället för ur en egen kopia.
 *
 * MÄTT UTFALL (isolerad körning mot HEAD:s app.js, dvs. med den falska
 * varningen kvar): EXAKT EN post byter klass över samtliga 18 korpusar —
 * 20260804-both-21h Klaffbron 2026-08-05T03:54:04Z (CARAT/211452170) går från
 * ACCEPTERAD/AVBRUTEN_APPROACH till RÖD FANTOM/KAJVOBBEL. Ingen annan varning
 * rör sig, och 265726650:s äkta varning står kvar via fail-open.
 */

const {
  classifyPhantom,
  approachEvidence,
  classifyMiss,
  stillnessStay,
  UNDERWAY_SOLO_SOG_KN,
} = require('./replay-validation/runOpeningGates');
const { BRIDGES, BRIDGE_OPENING, MOORING_DETECTION } = require('../lib/constants');

const KLAFF = BRIDGES.klaffbron;
const T0 = Date.UTC(2026, 7, 5, 4, 0, 0);
const M_PER_DEG_LAT = 111320;
const MMSI = '211452170';

/** Sampel `meters` söder om Klaffbron vid tiden t. */
function southOf(meters, t, sog) {
  return {
    mmsi: MMSI, lat: KLAFF.lat - meters / M_PER_DEG_LAT, lon: KLAFF.lon, sog, aisTimestamp: t,
  };
}

const samplesOf = (list) => new Map([[MMSI, list]]);

function warning(t, overrides = {}) {
  return {
    t,
    iso: new Date(t).toISOString(),
    bridge: 'Klaffbron',
    direction: 'northbound',
    etaMin: 5,
    vesselCount: 1,
    leadVessel: 'CARAT',
    leadMmsi: MMSI,
    mmsis: [MMSI],
    firedBy: 'fix',
    eventId: 'Klaffbron#8',
    distance: 384,
    success: true,
    ...overrides,
  };
}

describe('M2-GRIND: tröskeln är EN källa, inte en kopia', () => {
  test('grinden läser BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN', () => {
    // Hårdkodningen 3,13 i grindfilen var en andra kopia av samma mätning.
    // Två kopior kan glida isär utan att något larmar — och glider de isär
    // mäter grinden en annan regel än den produktionen kör.
    expect(UNDERWAY_SOLO_SOG_KN).toBe(BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN);
  });
});

describe('M2-GRIND: ett OKORROBORERAT fartvärde bär inte längre rörelsebeviset', () => {
  test('CARAT-klassen — kajstilla med ETT brusigt 7,4-knopsvärde är KAJVOBBEL', () => {
    // Rådataverifierat förlopp: hon låg 384 m söder om Klaffbron och flyttade
    // sig 52 m på 69 s (implicerat 1,47 kn) medan givaren rapporterade 7,4 kn.
    // FÖRE fixen dömdes hon "rörlig" på maxfarten allena och varningen
    // ACCEPTERADES som AVBRUTEN_APPROACH.
    const list = [];
    for (let i = 12; i >= 1; i--) list.push(southOf(384 + (i % 2) * 3, T0 - i * 69000, 0.1));
    list.push(southOf(384 - 52, T0 - 1000, 7.4));
    const r = classifyPhantom(warning(T0), samplesOf(list));
    expect(r.klass).toBe('KAJVOBBEL');
    expect(r.accepted).toBe(false);
  });

  test('samma förlopp men med ÄKTA förflyttning accepteras', () => {
    // Kontrollen åt andra hållet: rapporterad fart som STÄMMER med
    // förflyttningen ska fortfarande bära beviset.
    const list = [];
    for (let i = 12; i >= 1; i--) list.push(southOf(384 + (i % 2) * 3, T0 - i * 69000, 0.1));
    list.push(southOf(384 - 263, T0 - 1000, 7.4)); // 263 m på 69 s ≈ 7,4 kn
    const r = classifyPhantom(warning(T0), samplesOf(list));
    expect(r.accepted).toBe(true);
  });

  test('bevissträngen redovisar hur många av samplen som var korroborerade', () => {
    // Utan siffran går grindens beslut inte att granska i efterhand.
    const list = [];
    for (let i = 12; i >= 1; i--) list.push(southOf(384 + (i % 2) * 3, T0 - i * 69000, 0.1));
    list.push(southOf(384 - 52, T0 - 1000, 7.4));
    const r = classifyPhantom(warning(T0), samplesOf(list));
    expect(r.bevis).toMatch(/0\/1 fix ≥3\.13 kn KORROBORERADE/);
  });
});

describe('M2-GRIND: fail-open bevarar de glesa ÄKTA varningarna', () => {
  test('265726650-klassen — ETT sampel efter 70 minuters tystnad bär beviset', () => {
    // Med 70 minuters glapp säger positionsdeltat ingenting om vad båten
    // gjorde däremellan; där finns ingen inkonsistens att påstå. Utan
    // fail-open dör hennes äkta varning.
    const list = [
      southOf(1100, T0 - 70 * 60000, 0.0),
      southOf(1086, T0 - 1000, 3.8),
    ];
    const cand = approachEvidence(warning(T0), samplesOf(list));
    expect(cand.moving).toBe(true);
    expect(cand.soloProofFixes).toBe(1);
  });

  test('BRANIF-klassen — ETT ENDA fix i 4,6 kn utan föregående fix alls', () => {
    // 211112870 levererade exakt ett fix på 78 minuter. Saknas föregående fix
    // finns ingen förflyttning att mäta mot, och kortslutningen behålls.
    const r = classifyPhantom(warning(T0), samplesOf([southOf(727, T0 - 300000, 4.6)]));
    expect(r.accepted).toBe(true);
    expect(r.klass).toBe('AVBRUTEN_APPROACH');
  });
});

describe('M2-GRIND: föregående fix hämtas ur HELA serien, inte ur fönstret', () => {
  test('fönstrets FÖRSTA sampel prövas mot fixet före fönsterkanten', () => {
    // Ligger föregående fix utanför lookback-fönstret skulle en fönsterlokal
    // granne ha jämfört mot ingenting (fail-open) och släppt igenom exakt den
    // brusiga klass grinden ska fånga. Här ligger den kajstilla föregångaren
    // strax UTANFÖR fönstret och det brusiga samplet strax innanför.
    const lookback = 2 * BRIDGE_OPENING.ARM_STALE_TTL_MS;
    const inneT = T0 - lookback + 30000;
    const list = [
      southOf(384, inneT - 60000, 0.1), // utanför fönstret
      southOf(384 - 40, inneT, 7.4), // innanför, brusigt
    ];
    const cand = approachEvidence(warning(T0), samplesOf(list));
    expect(cand.soloSogFixes).toBe(1);
    expect(cand.soloProofFixes).toBe(0);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════
 * M2b (RUNDA 4, 2026-08-23) — SAMMA DEFEKT I O1:s MISSKLASSNING.
 *
 * M2 stängde enkelsampel-genvägen i produktionens kajgrind och i O2:s
 * fantomklassning, men O1:s classifyMiss läste kvar ETT RÅTT sog-värde som
 * "i rörelse". Följden var ett par självmotsägande verdikt om SAMMA sampel:
 * O2 kallade en varning på kajbruset KAJVOBBEL-fantom (rött) medan O1 kallade
 * frånvaron av samma varning OKLASSAD miss (också rött) — appen kunde inte
 * göra rätt.
 *
 * RÅDATAFALLET (20260804-both-21h, CARAT 211452170 @ Klaffbron): 40 fixar
 * 2026-08-05T00:04:32–06:48:58 inom 42,7 m av första positionen, 384–435 m
 * NORR om bron, med en givare som rapporterade 0,5–7,4 kn. Sista fixen före
 * passagen (06:48:58, 409 m, sog 0,5) ligger inne i vistelsen; nästa fix
 * (06:53:35) är redan 112 m SÖDER om bron i 3,7 kn. Avgången skedde i ett
 * rapportglapp på 4 min 37 s — ingen varning var möjlig.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Sampel `meters` norr om Klaffbron vid tiden t. */
function northOf(meters, t, sog, extra = {}) {
  return {
    mmsi: MMSI,
    lat: KLAFF.lat + meters / M_PER_DEG_LAT,
    lon: KLAFF.lon,
    sog,
    aisTimestamp: t,
    ...extra,
  };
}

const miss = (t, bridge = 'Klaffbron') => ({ t, mmsi: MMSI, bridge });
const MIN = 60000;

describe('M2b: MOVE_POS_M är appens konstant, inte en kopia', () => {
  test('positionsbeviset läser MOORING_DETECTION.MOVEMENT_PROOF_NET_M', () => {
    // Talet var hårdkodat till 50 i grindfilen. Två kopior av samma mätning
    // kan glida isär utan att något larmar.
    const stay = stillnessStay([{ s: northOf(404, T0, 0.1), d: 404, prev: null }]);
    expect(stay.established).toBe(false);
    expect(MOORING_DETECTION.MOVEMENT_PROOF_NET_M).toBe(50);
  });
});

describe('M2b: kajliggarprofilen — CARAT-klassen', () => {
  /**
   * Bygger CARAT-förloppet: en lång kajvistelse inom 43 m med brusiga
   * sog-värden, ett tätt fixpar som MOTSÄGER dem, sedan ett rapportglapp och
   * en fix på andra sidan bron.
   */
  function caratSeries(passT) {
    const list = [];
    const start = passT - 404 * MIN - 277000;
    // 00:04:32 — allra första sampel, brusigt 1,0 kn, INGEN föregående fix.
    list.push(northOf(404, start, 1.0));
    list.push(northOf(435, start + 14.7 * MIN, 1.6));
    list.push(northOf(428, start + 90 * MIN, 0.7));
    // Tätt par som motsäger bruset: 2 m på 230 s = 0,02 kn.
    list.push(northOf(413, start + 243 * MIN, 0.7));
    list.push(northOf(415, start + 243 * MIN + 230000, 7.4));
    list.push(northOf(427, start + 314 * MIN, 1.5));
    // Sista fixen före glappet — fortfarande vid kajen.
    list.push(northOf(409, start + 404 * MIN, 0.5));
    // 4 min 37 s glapp, sedan 112 m SÖDER om bron.
    list.push({
      mmsi: MMSI, lat: KLAFF.lat - 112 / M_PER_DEG_LAT, lon: KLAFF.lon, sog: 3.7, aisTimestamp: passT,
    });
    return new Map([[MMSI, list]]);
  }

  test('en 6,7-timmars kajvistelse gör sog-spikarna till jitter — RÖRELSEBEVIS_FÖR_SENT', () => {
    // FÖRE fixen: första sampel (sog 1,0) räknades som "i rörelse" 6 h 44 min
    // före passagen ⇒ OKLASSAD ⇒ hela grinden röd.
    const passT = T0 + 12 * 3600000;
    const r = classifyMiss(miss(passT), caratSeries(passT), null);
    expect(r.klass).toBe('RÖRELSEBEVIS_FÖR_SENT');
    expect(r.accepted).toBe(true);
  });

  test('bevissträngen redovisar vistelsen och motbeviset i klartext', () => {
    // Utan siffrorna går grindens beslut inte att pröva mot rådata i efterhand.
    const passT = T0 + 12 * 3600000;
    const r = classifyMiss(miss(passT), caratSeries(passT), null);
    expect(r.bevis).toMatch(/etablerad stillhetsvistelse/);
    expect(r.bevis).toMatch(/0\.02 kn/);
    expect(r.bevis).toMatch(/jitter/);
  });

  test('vistelsen släpps på FÖRSTA sampel med netto ≥ tröskeln — återkomsten är gratis', () => {
    const start = T0;
    const list = [
      northOf(404, start, 0.2),
      northOf(404, start + 40 * MIN, 0.3),
      northOf(340, start + 80 * MIN, 3.0), // 64 m netto = äkta avgång
    ];
    const stay = stillnessStay(list.map((s, i) => ({ s, d: 400, prev: i > 0 ? list[i - 1] : null })));
    // Vistelsen mäts fram till avgången, inte förbi den.
    expect(stay.spanMs).toBe(40 * MIN);
  });
});

describe('M2b: vistelsen kräver ett MÄTBART motbevis, inte en tystnad', () => {
  test('265726650-klassen — två fixar med 70 minuters tystnad är INGEN etablerad vistelse', () => {
    // 14 m netto efter 70 minuters tystnad säger ingenting om vad båten gjorde
    // däremellan; samma fail-open-riktning som quayTransitProof.
    const list = [northOf(1100, T0, 0.0), northOf(1086, T0 + 70 * MIN, 3.8)];
    const stay = stillnessStay(list.map((s, i) => ({ s, d: 1100, prev: i > 0 ? list[i - 1] : null })));
    expect(stay.spanMs).toBe(70 * MIN);
    expect(stay.contradiction).toBeNull();
    expect(stay.established).toBe(false);
  });

  test('...och hennes rörelsebevis står därför kvar — missen förblir OKLASSAD', () => {
    const passT = T0 + 100 * MIN;
    const samples = new Map([[MMSI, [northOf(1100, T0, 0.0), northOf(1086, T0 + 70 * MIN, 3.8)]]]);
    const r = classifyMiss(miss(passT), samples, null);
    expect(r.klass).toBe('OKLASSAD');
  });

  test('en KORT vistelse (köare vid bron) avfärdar inte sog-spikarna', () => {
    // 10 minuter stilla är en inbromsning, inte en kajvistelse. Utan
    // längdkravet hade grinden gömt en äkta miss.
    const start = T0;
    const list = [
      northOf(600, start, 0.2),
      northOf(600.5, start + 60000, 0.2), // tätt par, 0,5 m på 60 s
      northOf(602, start + 10 * MIN, 4.0),
    ];
    const samples = new Map([[MMSI, list]]);
    const stay = stillnessStay(list.map((s, i) => ({ s, d: 600, prev: i > 0 ? list[i - 1] : null })));
    expect(stay.established).toBe(false);
    expect(classifyMiss(miss(start + 40 * MIN), samples, null).klass).toBe('OKLASSAD');
  });
});

describe('M2b: korroboreringen gäller även i O1', () => {
  test('ett okorroborerat 7,4-knopsvärde utanför en vistelse bär inte beviset', () => {
    // Föregående fix är FÄRSK (69 s) och visar 45 m förflyttning = 1,27 kn.
    // Faktor 4 räcker inte till 7,4 kn ⇒ enkelsampel-beviset underkänns.
    const passT = T0 + 60 * MIN;
    const list = [northOf(380, T0, 0.2), northOf(425, T0 + 69000, 7.4)];
    const r = classifyMiss(miss(passT), new Map([[MMSI, list]]), null);
    expect(r.klass).toBe('RÖRELSEBEVIS_FÖR_SENT');
  });

  test('samma värde med ÄKTA förflyttning bär beviset — missen är OKLASSAD', () => {
    // 263 m på 69 s ≈ 7,4 kn: rapporten stämmer med spåret.
    const passT = T0 + 60 * MIN;
    const list = [northOf(380, T0, 0.2), northOf(600, T0 + 69000, 7.4)];
    const r = classifyMiss(miss(passT), new Map([[MMSI, list]]), null);
    expect(r.klass).toBe('OKLASSAD');
    expect(r.bevis).toMatch(/positionsdelta 220 m/);
  });

  test('föregående fix hämtas ur HELA serien, inte ur resefönstret', () => {
    // Fönstret (windowStartMs) skär bort den kajstilla föregångaren. En
    // fönsterlokal granne hade gett prevFix=null ⇒ fail-open ⇒ OKLASSAD.
    const passT = T0 + 60 * MIN;
    const list = [northOf(380, T0, 0.2), northOf(425, T0 + 69000, 7.4)];
    const r = classifyMiss(miss(passT), new Map([[MMSI, list]]), T0 + 1000);
    expect(r.klass).toBe('RÖRELSEBEVIS_FÖR_SENT');
  });
});

describe('M2b: äkta missar göms INTE', () => {
  test('gles men äkta anflygning 2 km ut i 8 kn förblir OKLASSAD', () => {
    // Regressionsskyddet åt andra hållet: grinden får inte bli så generös att
    // den slutar hitta riktiga uteblivna varningar.
    const passT = T0 + 30 * MIN;
    const list = [northOf(2400, T0 - 120000, 8.0), northOf(2000, T0, 8.0)];
    const r = classifyMiss(miss(passT), new Map([[MMSI, list]]), null);
    expect(r.klass).toBe('OKLASSAD');
  });

  test('positionsbeviset mäts mot FÖRSTA sampel, inte mot närmast föregående fix', () => {
    // En fartgivarlös båt som kryper 20 m per fix passerar aldrig tröskeln
    // fix-mot-fix, men har flyttat sig 60 m från utgångsläget vid tredje
    // fixen. Mäts beviset mot grannen i stället för mot ankaret blir en hel
    // klass äkta avgångar osynlig.
    const passT = T0 + 60 * MIN;
    const list = [
      northOf(900, T0, null),
      northOf(880, T0 + 2 * MIN, null),
      northOf(860, T0 + 4 * MIN, null),
      northOf(840, T0 + 6 * MIN, null),
    ];
    const r = classifyMiss(miss(passT), new Map([[MMSI, list]]), null);
    expect(r.klass).toBe('OKLASSAD');
    expect(r.bevis).toMatch(/positionsdelta 60 m/);
  });

  test('fartgivarlös båt (sog=null) bevisas fortfarande av positionen', () => {
    const passT = T0 + 60 * MIN;
    const list = [
      northOf(800, T0, null),
      northOf(800, T0 + 5 * MIN, null),
      northOf(730, T0 + 10 * MIN, null), // 70 m netto
    ];
    const r = classifyMiss(miss(passT), new Map([[MMSI, list]]), null);
    expect(r.klass).toBe('OKLASSAD');
    expect(r.bevis).toMatch(/positionsdelta 70 m/);
  });
});
