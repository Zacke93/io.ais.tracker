'use strict';

/**
 * Runda 3 av motorrättningen 2026-11-04 (rättare R3).
 *  - L1: S10-VÄNDNING-BRON-BAKOM prövar en rad utan kurs eller fart med
 *    fartygets senast kända värde, som appen gör (_createVesselObject,
 *    VesselDataService.js:5286–5287). Förut hoppade spelaFixD över raden och
 *    zonkontrollerna dömde den som saknad kurs eller fart.
 *  - L2: definesSymbol tar bort block- och radkommentarer och räknar inte en
 *    import som definition.
 *  - U16: posten U16-F40-STRAX-STUDS (användarbeslut U16) registrerar
 *    F40-studsen som DESIGN, men bara när hoppet bort från 'strax' och
 *    återgången sammanfaller med den 'strax'-bärande båtens nästa fix.
 *  - Efterrättningen R3b (granskarens varv r3): U16-posten är bunden till
 *    den båt som kan ha burit 'strax' (hoppet när harnessen bearbetar hennes
 *    rad, appens ålder från bearbetningen, ingen textgenerering efter
 *    600 s-gränsen, ingen kajkapsel, ingen annan båts rad före återgången,
 *    ingen styrrad), och en egenskap vars värde är en import eller ett annat
 *    namn räknas inte som definition.
 *  - Efterrättningen R3c (granskarens slutvarv): U16-posten kräver att båten
 *    kunde bära 'strax' vid sin förra fix och att ingen annan båt kunde bära
 *    det vid hoppet, och klassen är MÄTGRÄNS. Ett alias med värdet på nästa
 *    rad räknas inte som definition.
 *
 * [rättning]-fallen fälls av motorn före rundan (F/pre3, läget efter runda
 * 2). [vakt]-fallen håller i båda. [nytt] prövar nya hjälpare.
 * [efterrättning]-fallen fälls av rundans första försök (C före
 * efterrättningen R3b, det läge granskaren prövade) och klaras nu; de som
 * hör till R3c fälls av läget efter R3b. L2-fallet
 * fälls också av F/pre3; U16-fallen klarar F/pre3, som saknar posten. Varje
 * L1-utfall är prövat mot appen med sonden s10h (granskarens, i värld 581
 * med notisen borttagen; utfallen redovisas i rundans svar): där appen
 * notifierar ska fallet ge KANDIDAT, och där appen avstår DESIGN. U16-fallen
 * bygger på F18:s minsta repro (värld 1608, s1-standard-a) och på F21:s
 * minsta repro i R3-standard (värld 1907, B4) med granskarens kajbåt, vars
 * texter är appens egna (u16e2e), och med granskarens båt Y söder om
 * Klaffbron (u16ce, körningarna ce-b och ce-b590). Inga barnprocesser och
 * inga timers.
 */

const { loadRegistry } = require('../lib/registry');
const existing = require('../lib/oracles/existing');

const klassa = (reg, f, ctx) => reg.classify(f, ctx, { räkna: false });

// ---------------------------------------------------------------------------
// L1: rader utan kurs eller fart får fartygets senast kända värde
// ---------------------------------------------------------------------------

describe('L1 S10-VÄNDNING-BRON-BAKOM: en rad utan kurs eller fart prövas med det senast kända värdet', () => {
  const S10 = 'S10-VÄNDNING-BRON-BAKOM';
  const rad = (mmsi) => ([lat, lon, sog, cog, t]) => ({
    mmsi, lat, lon, sog, cog, aisTimestamp: t,
  });
  // Värld 581 (F15, samma rader som h-efterratt.test.js): MASEN vänder före
  // Järnvägsbron 10:06:16.
  const V581 = {
    mmsi: '265684897',
    bro: 'Järnvägsbron',
    tIn: 1789380293000,
    tOut: 1789380405000,
    tFörstaFix: 1789380376803,
    rader: [
      [58.27103504735231, 12.273163581786593, 3.5, 45.8, 1789378883268], [58.28743339955223, 12.287003042870909, 2.2, 33.6, 1789380086515],
      [58.2897022216311, 12.289841031108827, 2.2, 216, 1789380376803], [58.2884860159511, 12.288249332674942, 3.6, 209.9, 1789380472949],
    ].map(rad('265684897')),
  };
  const besök = (v) => ({
    orakel: 'T1',
    klass: 'NOTIS-UTEBLIVEN',
    allvar: 5,
    mmsi: v.mmsi,
    bro: v.bro,
    riktning: null,
    t: v.tFörstaFix,
    belägg: {
      tIn: v.tIn, tOut: v.tOut, tFörstaFix: v.tFörstaFix, korsning: null,
    },
  });
  const ctx = (rader) => ({ rader, resultat: { notifications: [] } });
  const sätt = (rader, t, fält) => rader.map((r) => (r.aisTimestamp === t ? { ...r, ...fält } : r));
  const s10skäl = (c) => (c.post === S10 ? c.skäl : (c.prövade.find((p) => p.post === S10) || {}).skäl);
  const zon = V581.rader[2];
  const förra = V581.rader[1];
  const nästa = V581.rader[3];
  /** Som sondens negativa andel: på linjen från zonens första fix mot 10:01:26. */
  const före = (fr, sog, cog) => ({
    ...zon,
    lat: zon.lat + fr * (förra.lat - zon.lat),
    lon: zon.lon + fr * (förra.lon - zon.lon),
    sog,
    cog,
    aisTimestamp: Math.round(zon.aisTimestamp + fr * (förra.aisTimestamp - zon.aisTimestamp)),
  });
  /** Som sondens positiva andel: på linjen från zonens första fix mot 10:07:52. */
  const efter = (fr, sog, cog) => ({
    ...zon,
    lat: zon.lat + fr * (nästa.lat - zon.lat),
    lon: zon.lon + fr * (nästa.lon - zon.lon),
    sog,
    cog,
    aisTimestamp: Math.round(zon.aisTimestamp + fr * (nästa.aisTimestamp - zon.aisTimestamp)),
  });
  const med = (...extra) => [...V581.rader, ...extra].sort((a, b) => a.aisTimestamp - b.aisTimestamp);
  const BEKRÄFTAR = /^zonens första fix 10:06:16 \(2\.2 kn ≥ FIX_D_MIN_SOG 2 kn\) bekräftar reversalen som flaggades 10:03:51, 145 s tidigare \(inom 15 min\); notisen går ut$/;

  test('[rättning] granskarens sond: en omvänd rad utan kurs 10:03:51 sätter flaggan med kursen från raden före, och appen notifierar', () => {
    const reg = loadRegistry();
    // 10:02:53 (216°, 1,0 kn), 10:03:51 (kurs saknas, 2,2 kn), 10:05:18 (30°,
    // 1,0 kn). Appen: TARGET_RECALC_PENDING (cog=216°) och notis söderut
    // 10:06:16.803. Förut: DESIGN, alltså amnesti.
    for (const saknas of [null, NaN]) {
      const c = klassa(reg, besök(V581), ctx(med(före(0.7, 1.0, 216), före(0.5, 2.2, saknas), före(0.2, 1.0, 30))));
      expect([saknas, c.klass]).toEqual([saknas, 'KANDIDAT']);
      expect(s10skäl(c)).toMatch(BEKRÄFTAR);
    }
  });

  test('[rättning] granskarens sond: en omvänd rad utan fart 10:03:51 sätter flaggan med farten från raden före, och appen notifierar', () => {
    const reg = loadRegistry();
    // 10:02:53 (30°, 2,2 kn), 10:03:51 (216°, fart saknas), 10:05:18 (30°,
    // 1,0 kn). Appen notifierar söderut 10:06:16.803.
    for (const saknas of [null, NaN]) {
      const c = klassa(reg, besök(V581), ctx(med(före(0.7, 2.2, 30), före(0.5, saknas, 216), före(0.2, 1.0, 30))));
      expect([saknas, c.klass]).toEqual([saknas, 'KANDIDAT']);
      expect(s10skäl(c)).toMatch(BEKRÄFTAR);
    }
  });

  test('[rättning] en rad utan kurs med minst FIX_D_MIN_SOG får kursen i det gamla bandet och nollar flaggan: appen avstår', () => {
    const reg = loadRegistry();
    // 10:02:24 omvänd på 2,2 kn (flaggan), 10:03:22 i det gamla bandet på
    // 1,0 kn (rör inget), 10:04:20 utan kurs på 2,2 kn: kursen 30° från
    // 10:03:22 nollar flaggan, och zonens första fix sätter en ny. Appen
    // loggar TARGET_RECALC_PENDING två gånger och avstår
    // (FLOW_TRIGGER_SKIP_PENDING_REVERSAL, ingen notis). Förut: KANDIDAT med
    // skälet att flaggan från 10:02:24 bekräftades.
    const c = klassa(reg, besök(V581), ctx(med(före(0.8, 2.2, 216), före(0.6, 1.0, 30), före(0.4, 2.2, null), före(0.2, 1.0, 30))));
    expect(c).toMatchObject({ klass: 'DESIGN', post: S10 });
    expect(c.skäl).toMatch(/^vändning mellan 10:05:18 \(kurs 30°\) och 10:06:16 \(kurs 216°, 2\.2 kn ≥ FIX_D_MIN_SOG 2 kn\)/);
  });

  test('[rättning] zonens första fix utan fart får 2,2 kn från fixen före besöket och sätter flaggan: appen avstår', () => {
    const reg = loadRegistry();
    const c = klassa(reg, besök(V581), ctx(sätt(V581.rader, zon.aisTimestamp, { sog: null })));
    expect(c).toMatchObject({ klass: 'DESIGN', post: S10 });
    expect(c.skäl).toMatch(/\(kurs 216°, 2\.2 kn förd fram från 10:01:26 ≥ FIX_D_MIN_SOG 2 kn\)/);
  });

  test('[rättning] fixen före besöket utan kurs får kursen 30° från raden före: appen avstår', () => {
    const reg = loadRegistry();
    // 10:03:22 (30°, 2,2 kn) och 10:04:49 (kurs saknas, 1,0 kn). Förut:
    // KANDIDAT, "kurs saknas 10:04:49".
    const c = klassa(reg, besök(V581), ctx(med(före(0.6, 2.2, 30), före(0.3, 1.0, null))));
    expect(c).toMatchObject({ klass: 'DESIGN', post: S10 });
    expect(c.skäl).toMatch(/^vändning mellan 10:04:49 \(kurs 30° förd fram från 10:03:22\) och 10:06:16/);
  });

  test('[rättning] en senare zonfix utan kurs på 1,0 kn får kursen 216° och bekräftar inte: appen avstår', () => {
    const reg = loadRegistry();
    // 10:06:36, 283 m från bron. Appen: S10-vakten avstår även där
    // (cog=216°, sog=1). Förut: KANDIDAT, "kurs NaN°".
    const c = klassa(reg, besök(V581), ctx(med(efter(0.2, 1.0, null))));
    expect(c).toMatchObject({ klass: 'DESIGN', post: S10 });
    expect(c.skäl).toMatch(/alla 2 fix\(ar\) inom 300 m går söderut .*1 senare zonfix\(ar\) under 2 kn bekräftar inte reversalen/);
  });

  test('[rättning] en senare zonfix utan fart får 2,2 kn och bekräftar reversalen: appen notifierar 10:06:36, och skälet säger det', () => {
    const reg = loadRegistry();
    // Förut var utfallet också KANDIDAT, men med skälet "fart null kn".
    const c = klassa(reg, besök(V581), ctx(med(efter(0.2, null, 216))));
    expect(c.klass).toBe('KANDIDAT');
    expect(s10skäl(c)).toMatch(/^zonfixen 10:06:36 \(2\.2 kn förd fram från 10:06:16 ≥ FIX_D_MIN_SOG 2 kn, söderut\) inom 15 min bekräftar reversalen/);
  });

  test('[vakt] F15:s värld 581 utan saknade värden är oförändrad', () => {
    const c = klassa(loadRegistry(), besök(V581), ctx(V581.rader));
    expect(c).toMatchObject({ klass: 'DESIGN', post: S10 });
    expect(c.skäl).toMatch(/^vändning mellan 10:01:26 \(kurs 33\.6°\) och 10:06:16 \(kurs 216°, 2\.2 kn ≥ FIX_D_MIN_SOG 2 kn\); alla 1 fix\(ar\)/);
  });

  test('[nytt] medFramfördKursOchFart: värde och ursprung förs fram, utan tidigare värde förblir raden icke-finit, och en andra framföring behåller ursprunget', () => {
    const { medFramfördKursOchFart } = require('../lib/registry');
    const f = (t, cog, sog) => ({ aisTimestamp: t * 1000, cog, sog });
    const ut = medFramfördKursOchFart([f(0, null, 3), f(10, 200, null), f(20, NaN, NaN), f(30, 30, 1)]);
    expect(ut.map((r) => [r.cog, r.sog, r.cogFrån, r.sogFrån])).toEqual([
      [null, 3, null, null], [200, 3, null, 0], [200, 3, 10000, 0], [30, 1, null, null],
    ]);
    expect(medFramfördKursOchFart(ut)).toEqual(ut);
  });
});

// ---------------------------------------------------------------------------
// L2: definesSymbol utan kommentarer och importer
// ---------------------------------------------------------------------------

describe('L2 definesSymbol: en kommentar eller en import definierar inte symbolen', () => {
  const { definesSymbol } = require('../lib/registry');

  test('[rättning] granskarens fyra fall ger falskt', () => {
    expect(definesSymbol('// const decisiveFixAfter = null;', 'decisiveFixAfter')).toBe(false);
    expect(definesSymbol('/* function judgeT1(ctx) { gammal version } */', 'judgeT1')).toBe(false);
    expect(definesSymbol('/*\n   judgeT1: gammal regel\n*/', 'judgeT1')).toBe(false);
    expect(definesSymbol('const judgeT1 = require("./t1Notice").judgeT1;', 'judgeT1')).toBe(false);
  });

  test('[rättning] JSDoc-exempel och importer i andra former räknas inte', () => {
    expect(definesSymbol('/**\n * Exempel:\n *   function decisiveFixAfter(list) { … }\n */\nmodule.exports = {};', 'decisiveFixAfter')).toBe(false);
    expect(definesSymbol('const {\n  judgeT1: domare,\n  judgePhantom,\n} = require("./t1Notice");', 'judgeT1')).toBe(false);
    expect(definesSymbol('const judgeT1 = await import("./t1Notice.js");', 'judgeT1')).toBe(false);
    expect(definesSymbol("import { judgeT1 } from './t1Notice';\nimport judgePhantom from './t2Opening';", 'judgeT1')).toBe(false);
  });

  // Efterrättningen R3b (granskarens varv r3, nytt problem 2): en egenskap
  // vars värde är en import eller bara ett annat namn återexporterar det.
  test('[efterrättning] en egenskap vars värde är en import eller ett annat namn räknas inte som definition', () => {
    expect(definesSymbol('module.exports = {\n  judgeT1: require("./t1Notice").judgeT1,\n};', 'judgeT1')).toBe(false);
    expect(definesSymbol('const { judgeT1 } = require("./t1Notice");\nmodule.exports = {\n  judgeT1: judgeT1,\n};', 'judgeT1')).toBe(false);
    expect(definesSymbol('module.exports = {\n  judgeT1:\n    require("./t1Notice").judgeT1,\n};', 'judgeT1')).toBe(false);
    expect(definesSymbol('module.exports = {\n  judgeT1: await import("./t1Notice.js"),\n};', 'judgeT1')).toBe(false);
    expect(definesSymbol('module.exports = {\n  judgeT1: oracles.t1.judgeT1 };', 'judgeT1')).toBe(false);
    // Efterrättningen R3c (granskarens slutvarv, sonden l2extra): aliaset med
    // värdet på nästa rad.
    expect(definesSymbol('module.exports = {\n  judgeT1:\n    judgeImpl,\n};', 'judgeT1')).toBe(false);
  });

  test('[vakt] en egenskap med ett eget värde definierar, och ett namn som definieras i filen hittas även när en egenskap pekar på det', () => {
    expect(definesSymbol('function judgeT1() {}\nmodule.exports = { judgeT1: judgeT1 };', 'judgeT1')).toBe(true);
    expect(definesSymbol('const P = {\n  stressDensity: {\n    fn() {},\n  },\n};', 'stressDensity')).toBe(true);
    expect(definesSymbol('const P = {\n  judgePhantom: (p) => p,\n};', 'judgePhantom')).toBe(true);
    expect(definesSymbol('const P = {\n  judgeT1: function (ctx) { return ctx; },\n};', 'judgeT1')).toBe(true);
    expect(definesSymbol('const P = {\n  judgeT1: async (ctx) => ctx,\n};', 'judgeT1')).toBe(true);
    expect(definesSymbol('module.exports = {\n  judgeT1:\n    function (ctx) { return ctx; },\n};', 'judgeT1')).toBe(true);
  });

  test('[vakt] definitioner hittas, också bredvid strängar, reguljära uttryck och mallsträngar som innehåller // och /*', () => {
    const text = [
      "const url = 'http://exempel.se/*'; function judgeT1(ctx) {",
      '  const re = /[/*]/; const judgePhantom = (p) => p;',
      '  const t = `a ${`b // c`} /* d */ ${x / 2}`; // tick() {',
      '  tick() {',
      '  stressDensity: {',
      '  const delat = a / b / c; const decisiveFixAfter = 1;',
    ].join('\n');
    for (const s of ['judgeT1', 'judgePhantom', 'tick', 'stressDensity', 'decisiveFixAfter']) expect([s, definesSymbol(text, s)]).toEqual([s, true]);
    // En require bredvid en egen definition: definitionen räknas.
    expect(definesSymbol('const x = require("./x");\nfunction judgeT1() {}', 'judgeT1')).toBe(true);
  });

  test('[vakt] registret laddar utan varningar, och dess symbolhänvisningar definieras fortfarande', () => {
    expect(loadRegistry().varningar).toEqual([]);
  });

  test('[nytt] utanKommentarer behåller längden och radbrytningarna och rör inte strängarna', () => {
    const { utanKommentarer } = require('../lib/registry');
    const text = 'a(); // x\n/* y\n z */ b("// inte kommentar", `/* inte heller */`);\nconst r = /\\/\\//g; // slut';
    const ut = utanKommentarer(text);
    expect(ut).toHaveLength(text.length);
    expect(ut.split('\n')).toHaveLength(text.split('\n').length);
    expect(ut).toBe('a();     \n    \n      b("// inte kommentar", `/* inte heller */`);\nconst r = /\\/\\//g;        ');
  });
});

// ---------------------------------------------------------------------------
// U16: F40-studsen vid den 'strax'-bärande båtens nästa rad är DESIGN
// ---------------------------------------------------------------------------

describe('U16 U16-F40-STRAX-STUDS: studsen vid den strax-bärande båtens nästa rad', () => {
  const U16 = 'U16-F40-STRAX-STUDS';
  const at = (hms) => Date.parse(`2026-06-13T${hms}Z`);
  const iso = (t) => new Date(t).toISOString();
  const rad = (mmsi, hms, lat, lon, sog, cog) => ({
    mmsi, lat, lon, sog, cog, aisTimestamp: typeof hms === 'number' ? hms : at(hms),
  });
  const MASEN = '265855691';
  // F18:s minsta repro (värld 1608): MASEN 2 köar 82–85 m norr om
  // Stridsbergsbron. Hon är tyst 09:32:10,242–09:42:15,101 (604,9 s). YRSA
  // och PELLE är de andra båtarna.
  const MASEN_RADER = [
    rad(MASEN, '09:29:54.515', 58.29545, 12.29744, 5.7, 211),
    rad(MASEN, '09:31:03.658', 58.29404, 12.2955, 0.6, 226),
    rad(MASEN, '09:32:10.242', 58.29403, 12.29559, 0, null),
    rad(MASEN, '09:42:15.101', 58.29399, 12.29572, 0.1, 238.9),
    rad(MASEN, '09:46:49.437', 58.29398, 12.29568, 0, 251.7),
  ];
  const ANDRA = [
    rad('265855485', '09:40:01.932', 58.30381, 12.3073, 5.7, 216),
    rad('265855485', '09:41:09.805', 58.30319, 12.30645, 5.7, 216),
    rad('265855485', '09:42:15.173', 58.30092, 12.30355, 5.7, 210.8),
    rad('265855485', '09:43:24.810', 58.29999, 12.3025, 5.7, 210.8),
    rad('265855773', '09:40:01.997', 58.28451, 12.28434, 5, 198.3),
    rad('265855773', '09:41:09.847', 58.2833, 12.28372, 5.6, 193.2),
  ];
  // En annan båt Y, 273 m från Stridsbergsbron och utanför kajkapslarna
  // (granskarens u16motex, varv r3).
  const Y = '265000001';
  const yRad = (hms) => rad(Y, hms, 58.29532, 12.29775, 0, null);
  const TVÅ = (eta) => `Två båtar på väg mot Stridsbergsbron, beräknad broöppning ${eta}`;
  const KLAFF = (text) => `En båt på väg mot Klaffbron, beräknad broöppning om 9 minuter; ${text}`;
  const TEXTER = [
    ['09:33:17.859', 'Tre båtar på väg mot Stridsbergsbron, beräknad broöppning strax'],
    ['09:41:09.890', TVÅ('strax')],
    ['09:42:15.101', TVÅ('om 8 minuter')],
    ['09:42:15.126', TVÅ('strax')],
    ['09:47:55.901', 'En båt på väg mot Stridsbergsbron, beräknad broöppning strax'],
  ];
  const resultat = (texter, tid = at) => ({
    bridgeTextTransitions: texter.map(([hms, text]) => ({ t: tid(hms), iso: iso(tid(hms)), text })),
    notifications: [],
    targetPassages: [],
    confirmedTargetWaits: [],
  });
  /** INV-3-fynden ur harnessens egen domare, klassade med registret. */
  const domar = (texter, rader = [...MASEN_RADER, ...ANDRA], extra = {}, tid = at) => {
    const res = resultat(texter, tid);
    const fynd = existing.judgeExisting({ result: res, rows: rader, gt: null }).fynd.filter((x) => x.inv === 'INV-3');
    const reg = loadRegistry();
    return fynd.map((f) => {
      const g = { ...f, ...extra };
      const c = klassa(reg, g, { rader, resultat: res });
      return {
        f: g, c, skäl: c.post === U16 ? c.skäl : (c.prövade.find((p) => p.post === U16) || {}).skäl,
      };
    });
  };
  const klasser = (d) => d.map((x) => `${x.f.klass} ${x.c.klass}`).sort();
  const BÅDA = (klass) => [`INV-3 ETA-OSCILLATION ${klass}`, `INV-3 ETA-SÅGTAND UPP ${klass}`];
  const masenUtan = (...tider) => MASEN_RADER.filter((r) => !tider.map(at).includes(r.aisTimestamp));
  const tHopp = at('09:42:15.101');

  // F20/F21:s minsta repro i R3-standard (värld 1907, B4-varianten): ULLA:s
  // uttömda 'strax', hennes fix 407 s gammal. Texterna med och utan kajbåten
  // är appens egna ur granskarens u16e2e (varv r3), körd om i efterrättningen
  // R3b: med en båt Y vars rad kommer 35 ms före ULLA:s kommer hoppet vid
  // Y:s rad 11:01:40,950 och återgången 11:01:41,035.
  const atK = (hms) => Date.parse(`2026-09-18T${hms}Z`);
  const radK = (mmsi, hms, lat, lon, sog, cog) => ({
    mmsi, lat, lon, sog, cog, aisTimestamp: atK(hms),
  });
  const ULLA = '265182731';
  const KLAFF_RADER = [
    radK(ULLA, '10:54:53.804', 58.28013527002986, 12.282203129535052, 5.3, 19.1),
    radK('265182787', '10:59:56.858', 58.27649, 12.27982, 3.9, 23.8),
    radK('265182787', '11:00:56.858', 58.2775, 12.28059, 3.9, 18.3),
    radK('265182687', '11:01:11.618', 58.30832, 12.31453, 6.2, 36.5),
    radK(ULLA, '11:01:40.985', 58.28277082107979, 12.283530607519701, 1.1, 15),
    radK('265182787', '11:01:56.858', 58.27854, 12.28124, 3.9, 18.3),
    radK('265182687', '11:02:11.936', 58.30962, 12.31636, 5.9, 35),
  ];
  const TVÅ_K = (eta) => `Två båtar på väg mot Klaffbron, beräknad broöppning ${eta}`;
  const KLAFF_TEXTER = (hopp, åter) => [
    ['10:59:56.883', `${TVÅ_K('strax')}; En båt på väg mot Stridsbergsbron, ETA okänd`],
    ['11:01:11.643', TVÅ_K('strax')],
    [hopp, TVÅ_K('om 7 minuter')],
    [åter, TVÅ_K('strax')],
  ];
  // Y vid kajen norr om Klaffbron (i kapseln, 240 m från bron) eller 45 m
  // öster om den (utanför kapseln, 262 m), med en rad 35 ms före ULLA:s.
  const KAJ = '265999001';
  const kajRader = (förstaHms, lon = 12.285651) => [
    ...KLAFF_RADER,
    radK(KAJ, förstaHms, 58.2860595, lon, 0, null),
    radK(KAJ, '11:01:40.950', 58.2860595, lon, 0, null),
  ];
  const klaff = (texter, rader) => domar(texter, rader, {}, atK);

  test('[rättning] F18/F19: hoppet när harnessen bearbetar MASEN 2:s nästa rad och återgången 25 ms senare blir MÄTGRÄNS', () => {
    const d = domar(TEXTER);
    expect(klasser(d)).toEqual(BÅDA('MÄTGRÄNS'));
    for (const x of d) {
      expect(x.c.post).toBe(U16);
      expect(x.c.skäl).toMatch(new RegExp('^265855691:s fix 09:32:10\\.242 \\(82 m från Stridsbergsbron\\) var 604\\.9 s gammal vid hoppet 09:42:15\\.101 '
        + '\\(strax → 8 min; > 600 s, STALE_ETA_HARD\\), som publicerades när harnessen bearbetade hennes nästa rad 09:42:15\\.101 \\(85 m\\), '
        + 'utan textgenerering sedan åldern passerade 600 s 09:42:10\\.242; återgången till strax 09:42:15\\.126 kom 25 ms efter raden, '
        + 'utan någon annan båts rad inom 500 m emellan, och ingen annan båt kunde bära strax vid hoppet: '
        + 'F40-studsen i harnessens uppskjutna UI-arbete \\(U16\\)$'));
    }
  });

  test('[rättning] ETA-SÅGTAND UPP med en upprepad nivå mellan hoppet och återgången (en annan klausul ändras) blir MÄTGRÄNS', () => {
    const texter = [...TEXTER.slice(0, 3), ['09:42:15.110', KLAFF(TVÅ('om 8 minuter'))], ['09:42:15.126', KLAFF(TVÅ('strax'))]];
    const d = domar(texter);
    expect(klasser(d)).toEqual(['INV-3 ETA-SÅGTAND UPP MÄTGRÄNS']);
    expect(d[0].c.skäl).toMatch(/återgången till strax 09:42:15\.126 kom 25 ms efter raden/);
  });

  test('[rättning] en fix 600 001 ms gammal vid hoppet räcker (appens ålder > STALE_ETA_HARD)', () => {
    const rader = [...masenUtan('09:32:10.242'), rad(MASEN, tHopp - 600001, 58.29403, 12.29559, 0, null), ...ANDRA];
    expect(klasser(domar(TEXTER, rader))).toEqual(BÅDA('MÄTGRÄNS'));
  });

  test('[rättning] en rad som harnessen bearbetar 30 ms efter sin tid (YRSA:s rad före i samma pollkluster): hoppet vid bearbetningen blir MÄTGRÄNS', () => {
    const rader = [...MASEN_RADER, ...ANDRA, rad('265855485', '09:42:15.071', 58.30101, 12.30362, 5.7, 210.8)];
    const texter = [...TEXTER.slice(0, 2), ['09:42:15.131', TVÅ('om 8 minuter')], ['09:42:15.156', TVÅ('strax')], TEXTER[4]];
    const d = domar(texter, rader);
    expect(klasser(d)).toEqual(BÅDA('MÄTGRÄNS'));
    expect(d[0].c.skäl).toMatch(/som publicerades när harnessen bearbetade hennes nästa rad 09:42:15\.101 \(85 m\).*återgången till strax 09:42:15\.156 kom 25 ms efter raden/);
  });

  // Efterrättningen R3c: förut DESIGN. ULLA:s fix 10:54:53,804 (452 m, 407 s,
  // kurs 19°) kunde bära 'strax' vid hoppet (B4-studsen), och Y ligger still.
  test('[vakt] Klaffbron: en båt utanför kajkapseln, tyst i 605 s, vars rad bär studsen utan någon annan rad emellan ger KANDIDAT när ULLA:s 407 s gamla fix kunde bära strax', () => {
    const rader = kajRader('10:51:35.950', 12.28642).filter((r) => !(r.mmsi === ULLA && r.aisTimestamp === atK('11:01:40.985')));
    const d = klaff(KLAFF_TEXTER('11:01:40.950', '11:01:41.035'), rader);
    expect(klasser(d)).toEqual(BÅDA('KANDIDAT'));
    for (const x of d) {
      expect(x.skäl).toMatch(new RegExp('^265999001:s fix 10:51:35\\.950 \\(262 m från Klaffbron\\) var 605\\.0 s gammal vid hoppet 11:01:40\\.950, .*, '
        + 'men 265182731:s fix 10:54:53\\.804 \\(452 m från Klaffbron\\) var 407\\.1 s gammal vid hoppet, utanför kajkapslarna och på väg mot bron '
        + '\\(kurs 19\\.1° mot bäringen \\d+° till bron\\): hon kunde också bära \'strax\' \\(inom 500 m, högst 600 s\\)$'));
    }
  });

  // Granskarens motexempel ce-b (slutvarvet, u16ce genom appen): F21:s
  // B4-studs och en båt Y som närmar sig söderifrån, 320 m från Klaffbron
  // (utanför imminent-radien 300 m och väntzonen 270 m) och sedan 260 m.
  // Appens logg: IMMINENT_SKIP för Y på 320 m, så Y bar aldrig 'strax';
  // hoppet kommer vid Y:s rad och återgången 25 ms senare, före ULLA:s
  // bearbetning 11:01:41,010. Med Y tyst i 590 s är apputdatan bitlik.
  const Y_SYD = '265999002';
  const CE_TEXTER = [
    ['10:59:20.164', 'Tre båtar på väg mot Klaffbron, beräknad broöppning strax'],
    ['11:01:40.950', 'Tre båtar på väg mot Klaffbron, beräknad broöppning om 7 minuter'],
    ['11:01:40.975', 'Tre båtar på väg mot Klaffbron, beräknad broöppning strax'],
  ];
  const ceRader = (förstaHms) => [
    ...KLAFF_RADER,
    radK(Y_SYD, förstaHms, 58.281434060231426, 12.281863247645838, 0.6, 22),
    radK(Y_SYD, '11:01:40.950', 58.2819330830813, 12.2822506746958, 0.6, 22),
  ];

  test('[efterrättning] granskarens ce-b: B4-studsen vid raden från en båt tyst i 605 s på 320 m, som aldrig bar strax, ger KANDIDAT', () => {
    const d = klaff(CE_TEXTER, ceRader('10:51:35.950'));
    expect(klasser(d)).toEqual(['INV-3 ETA-OSCILLATION KANDIDAT']);
    expect(d[0].skäl).toMatch(new RegExp('^265999002:s fix 10:51:35\\.950 \\(320 m från Klaffbron\\) var 605\\.0 s gammal vid hoppet 11:01:40\\.950, .*, '
      + 'men fixen ligger 320 m från bron, utanför imminent-radien 300 m, utan någon tidigare fix inom 270 m \\(väntläget\\) sedan båten senast '
      + 'var längre bort än 350 m: båten kunde inte bära \'strax\'$'));
  });

  test('[vakt] granskarens ce-b590: samma körning med båten tyst i 590 s ger KANDIDAT (färsk i appen)', () => {
    const d = klaff(CE_TEXTER, ceRader('10:51:50.950'));
    expect(klasser(d)).toEqual(['INV-3 ETA-OSCILLATION KANDIDAT']);
    expect(d[0].skäl).toMatch(/^hoppet 11:01:40\.950 publicerades när harnessen bearbetade 265999002:s rad 11:01:40\.950, men 265999002:s fix 10:51:50\.950 .* var 590\.0 s gammal \(högst 600 s/);
  });

  // Granskarens motexempel (varv r3) och efterrättningens egna. Varje fall gav
  // DESIGN i rundans första försök (posten godtog vilken båt som helst inom
  // 350 m med en gammal fix och en rad högst 1 s från hoppet) och ger nu
  // KANDIDAT. Motorn före rundan saknar posten och ger KANDIDAT.
  const BINDNING = {
    // Granskarens u16e2e genom appen: B4-studsen i F21:s minsta repro och en
    // kajbåt tyst i 720 s. Åldern passerade 600 s 10:59:40,985, och appen
    // publicerade 'strax' 10:59:56,883 och 11:01:11,643 efter det.
    kajbåt720: {
      klaff: [KLAFF_TEXTER('11:01:40.950', '11:01:41.035'), kajRader('10:49:40.985')],
      skäl: new RegExp('^265999001:s fix 10:49:40\\.985 \\(240 m från Klaffbron\\) var 720\\.0 s gammal vid hoppet 11:01:40\\.950, när hennes nästa rad '
        + '11:01:40\\.950 bearbetades, men åldern passerade 600 s 10:59:40\\.985, och brotexten publicerades 10:59:56\\.883, före hoppet'),
    },
    // Samma med kajbåten tyst i 605 s: ingen text eller tick efter 600 s-gränsen.
    kajbåt605: {
      klaff: [KLAFF_TEXTER('11:01:40.950', '11:01:41.035'), kajRader('10:51:35.950')],
      skäl: /^265999001:s fix 10:51:35\.950 \(240 m från Klaffbron\) var 605\.0 s gammal .*, men båten ligger i kajkapseln 'Kajen norr om Klaffbron' \(MOORING_ZONES\)/,
    },
    // Samma båt 45 m öster om kapseln (appen ger samma texter): ULLA:s rad
    // bearbetas 11:01:41,010, mellan Y:s rad och återgången.
    farled605: {
      klaff: [KLAFF_TEXTER('11:01:40.950', '11:01:41.035'), kajRader('10:51:35.950', 12.28642)],
      skäl: new RegExp('^265999001:s fix 10:51:35\\.950 \\(262 m från Klaffbron\\) var 605\\.0 s gammal .*, men 265182731:s rad 11:01:40\\.985 '
        + '\\(149 m från Klaffbron\\) bearbetades 11:01:41\\.010, mellan båtens rad och återgången till strax 11:01:41\\.035: återgången kan inte tillskrivas båten$'),
    },
    // Granskarens u16motex: B4 för MASEN 2 och Y, tyst i 735 s, med en rad
    // 41 ms före hoppet. MASEN 2:s rad bearbetas 09:42:15,120, efter Y:s.
    b4MedY: {
      texter: TEXTER,
      rader: [...masenUtan('09:32:10.242'), rad(MASEN, tHopp - 407100, 58.29403, 12.29559, 0, null), ...ANDRA, yRad('09:30:00.000'), yRad('09:42:15.060')],
      skäl: /^hoppet 09:42:15\.101 publicerades inte när harnessen bearbetade en båts rad, och ingen båt inom 350 m från Stridsbergsbron hade en fix äldre än 600 s/,
    },
    // Studsen vid YRSA:s rad medan MASEN 2 är tyst, med Y tyst i 735 s och en
    // rad 23 ms före. YRSA:s rad bearbetas 09:42:15,210.
    annanBåtsRadY: {
      texter: [...TEXTER.slice(0, 2), ['09:42:15.173', TVÅ('om 8 minuter')], ['09:42:15.198', TVÅ('strax')], TEXTER[4]],
      rader: [...masenUtan('09:42:15.101'), ...ANDRA, yRad('09:30:00.000'), yRad('09:42:15.150')],
      skäl: /^hoppet 09:42:15\.173 publicerades inte när harnessen bearbetade en båts rad: 265855691:s fix 09:32:10\.242 .* bearbetades 274\.3 s efter hoppet/,
    },
    // MASEN 2 färsk (60 s) och Y tyst i 735 s i samma kluster.
    färskMedY: {
      texter: TEXTER,
      rader: [...masenUtan('09:32:10.242'), rad(MASEN, tHopp - 60000, 58.29403, 12.29559, 0, null), ...ANDRA, yRad('09:30:00.000'), yRad('09:42:15.101')],
      skäl: /^hoppet 09:42:15\.101 publicerades när harnessen bearbetade 265855691:s rad 09:42:15\.101, men 265855691:s fix 09:41:15\.101 .* var 60\.0 s gammal \(högst 600 s: färsk i appen\)/,
    },
    // Hoppet 0,8 s efter MASEN 2:s färska rad.
    hoppEfterFärskRad: {
      texter: TEXTER,
      rader: [...masenUtan('09:42:15.101'), rad(MASEN, '09:42:14.300', 58.29399, 12.29572, 0.1, 238.9), ...ANDRA],
      skäl: /^hoppet 09:42:15\.101 publicerades inte när harnessen bearbetade en båts rad, och ingen båt inom 350 m .* \(äldst var 265855691:s, 801 ms\)$/,
    },
    // Hoppet 0,9 s före MASEN 2:s nästa rad (förut godtaget åt båda hållen).
    hoppFöreRaden: {
      texter: [...TEXTER.slice(0, 2), ['09:42:14.201', TVÅ('om 8 minuter')], ['09:42:15.126', TVÅ('strax')], TEXTER[4]],
      skäl: /^hoppet 09:42:14\.201 publicerades inte när harnessen bearbetade en båts rad: 265855691:s fix .* bearbetades 900 ms efter hoppet/,
    },
    // Hoppet vid radens tid, men harnessen bearbetade raden 30 ms senare
    // (YRSA:s rad före i klustret): hoppet byggde inte på dräneringen före raden.
    hoppFöreBearbetningen: {
      texter: TEXTER,
      rader: [...MASEN_RADER, ...ANDRA, rad('265855485', '09:42:15.071', 58.30101, 12.30362, 5.7, 210.8)],
      skäl: /^hoppet 09:42:15\.101 publicerades inte när harnessen bearbetade en båts rad: 265855691:s fix .* bearbetades 30 ms efter hoppet/,
    },
    // Y tyst i 620 s vid hoppet, men 600 s-gränsen 09:41:55 ligger före
    // halvminutsticken 09:42:00: där hade appen tappat 'strax' om Y bar det.
    tickEfterGränsen: {
      texter: TEXTER,
      rader: [...masenUtan('09:42:15.101'), ...ANDRA, yRad('09:31:55.000'), yRad('09:42:15.101')],
      skäl: new RegExp('^265000001:s fix 09:31:55\\.000 \\(273 m från Stridsbergsbron\\) var 620\\.1 s gammal .*, men åldern passerade 600 s 09:41:55\\.000, '
        + 'före halvminutsticken 09:42:00\\.000: bar båten \'strax\' hade appen tappat det vid ticken$'),
    },
    // Radåldern 600,030 s, men harnessen bearbetade fixen 30 ms efter sin tid
    // (PELLE:s rad före), så appens ålder är exakt 600 s: färsk.
    appensÅlder: {
      texter: TEXTER,
      rader: [...masenUtan('09:32:10.242'), rad('265855773', tHopp - 600060, 58.28451, 12.28434, 5, 198.3),
        rad(MASEN, tHopp - 600030, 58.29403, 12.29559, 0, null), ...ANDRA],
      skäl: /^hoppet 09:42:15\.101 .*, men 265855691:s fix 09:32:15\.071 \(82 m från Stridsbergsbron, bearbetad 09:32:15\.101\) var 600\.0 s gammal \(högst 600 s: färsk i appen\)$/,
    },
    // En omstart mellan MASEN 2:s förra fix och återgången.
    omstart: {
      texter: TEXTER,
      rader: [...MASEN_RADER, ...ANDRA, { ctrl: 'restart', aisTimestamp: at('09:40:00.000') }],
      skäl: /, men styrraden restart 09:40:00\.000 bearbetades mellan båtens förra fix och återgången$/,
    },
  };
  const bindning = (namn) => {
    const x = BINDNING[namn];
    return x.klaff ? klaff(...x.klaff) : domar(x.texter, x.rader);
  };

  test('[efterrättning] granskarens kajbåt genom appen (tyst i 720 s och 605 s) och samma båt utanför kapseln ger KANDIDAT', () => {
    for (const namn of ['kajbåt720', 'kajbåt605', 'farled605']) expect([namn, klasser(bindning(namn))]).toEqual([namn, BÅDA('KANDIDAT')]);
  });

  test('[efterrättning] granskarens enhetsfall (en annan tyst båt inom 350 m, en färsk MASEN 2, hoppet 0,8 s efter hennes rad) ger KANDIDAT', () => {
    for (const namn of ['b4MedY', 'annanBåtsRadY', 'färskMedY', 'hoppEfterFärskRad']) expect([namn, klasser(bindning(namn))]).toEqual([namn, BÅDA('KANDIDAT')]);
  });

  test('[efterrättning] hoppet ska ligga på radens bearbetning: 0,9 s före raden och vid radens tid när raden bearbetades 30 ms senare ger KANDIDAT', () => {
    for (const namn of ['hoppFöreRaden', 'hoppFöreBearbetningen']) expect([namn, klasser(bindning(namn))]).toEqual([namn, BÅDA('KANDIDAT')]);
  });

  test('[efterrättning] en halvminutstick efter 600 s-gränsen, appens ålder från bearbetningen och en omstart ger KANDIDAT', () => {
    for (const namn of ['tickEfterGränsen', 'appensÅlder', 'omstart']) expect([namn, klasser(bindning(namn))]).toEqual([namn, BÅDA('KANDIDAT')]);
  });

  test('[nytt] efterrättningens skäl pekar ut villkoret som fattas', () => {
    for (const [namn, x] of Object.entries(BINDNING)) {
      for (const d of bindning(namn)) expect([namn, d.f.klass, d.skäl]).toEqual([namn, d.f.klass, expect.stringMatching(x.skäl)]);
    }
  });

  // Fall där posten inte ska gälla, oförändrade sedan rundans första försök.
  // Varje fall ger KANDIDAT i alla motorer ([vakt]); skälen prövas för sig.
  const FALL = {
    // Studsen 5 min efter MASEN 2:s nästa fix: då är hennes fix 300 s gammal.
    femMinSenare: {
      texter: [
        ...TEXTER.slice(0, 2),
        ['09:46:30.040', KLAFF(TVÅ('strax'))],
        ['09:47:15.101', KLAFF(TVÅ('om 8 minuter'))],
        ['09:47:15.126', KLAFF(TVÅ('strax'))],
      ],
      rader: [...masenUtan('09:46:49.437'), ...ANDRA],
      skäl: new RegExp('^hoppet 09:47:15\\.101 publicerades inte när harnessen bearbetade en båts rad, och ingen båt inom 350 m från Stridsbergsbron '
        + 'hade en fix äldre än 600 s \\(äldst var 265855691:s, 300\\.0 s\\)$'),
    },
    // Studsen när hon är tyst, och hennes nästa fix 5 min senare.
    nästaFixFemMinEfter: {
      texter: TEXTER,
      rader: [...masenUtan('09:42:15.101', '09:46:49.437'), rad(MASEN, '09:47:15.101', 58.29399, 12.29572, 0.1, 238.9), ...ANDRA],
      skäl: new RegExp('^hoppet 09:42:15\\.101 publicerades inte när harnessen bearbetade en båts rad: 265855691:s fix 09:32:10\\.242 \\(82 m från Stridsbergsbron\\) '
        + 'var 604\\.9 s gammal, men hennes nästa rad 09:47:15\\.101 bearbetades 300\\.0 s efter hoppet \\(studsen ska ligga på båtens nästa rad\\)$'),
    },
    // Studsen vid YRSA:s rad 09:42:15,173 medan MASEN 2 är tyst (nästa fix
    // 09:46:49). YRSA:s förra fix är 65 s gammal.
    annanBåtsRad: {
      texter: [...TEXTER.slice(0, 2), ['09:42:15.173', TVÅ('om 8 minuter')], ['09:42:15.198', TVÅ('strax')], TEXTER[4]],
      rader: [...masenUtan('09:42:15.101'), ...ANDRA],
      skäl: new RegExp('^hoppet 09:42:15\\.173 publicerades när harnessen bearbetade 265855485:s rad 09:42:15\\.173, men 265855485:s fix 09:41:09\\.805 .* '
        + 'var 65\\.4 s gammal \\(högst 600 s: färsk i appen\\); 265855691:s fix 09:32:10\\.242 .* bearbetades 274\\.3 s efter hoppet$'),
    },
    // Exakt 600 000 ms: färsk i appen (dataIsFreshEnough, ålder ≤ 600 s).
    ålder600000: {
      texter: TEXTER,
      rader: [...masenUtan('09:32:10.242'), rad(MASEN, tHopp - 600000, 58.29403, 12.29559, 0, null), ...ANDRA],
      skäl: /^hoppet 09:42:15\.101 publicerades när harnessen bearbetade 265855691:s rad 09:42:15\.101, men 265855691:s fix 09:32:15\.101 .* var 600\.0 s gammal \(högst 600 s: färsk i appen\)$/,
    },
    // B4-varianten: fixen 407 s gammal (r2 i F18/F19, värld 1907).
    b4: {
      texter: TEXTER,
      rader: [...masenUtan('09:32:10.242'), rad(MASEN, tHopp - 407100, 58.29403, 12.29559, 0, null), ...ANDRA],
      skäl: /^hoppet 09:42:15\.101 publicerades när harnessen bearbetade 265855691:s rad 09:42:15\.101, men 265855691:s fix 09:35:28\.001 .* var 407\.1 s gammal \(högst 600 s: färsk i appen\)$/,
    },
    // F21:s minsta repro utan kajbåten: ULLA:s fix 407 s gammal (B4).
    b4Klaffbron: {
      klaff: [KLAFF_TEXTER('11:01:40.985', '11:01:41.010'), KLAFF_RADER],
      skäl: /^hoppet 11:01:40\.985 publicerades när harnessen bearbetade 265182731:s rad 11:01:40\.985, men 265182731:s fix 10:54:53\.804 \(452 m från Klaffbron\) var 407\.2 s gammal/,
    },
    // Båten 1,3 km från bron.
    långt: {
      texter: TEXTER,
      rader: [...MASEN_RADER.map((r) => ({ ...r, lat: 58.2833, lon: 12.28372 })), ...ANDRA],
      skäl: /^265855691:s fix 09:32:10\.242 \(1\d{3} m från Stridsbergsbron\) var 604\.9 s gammal .*, men fixen ligger 1\d{3} m från bron \(> 350 m\)$/,
    },
    // Återgången går till 1 min, inte till strax.
    enMinut: {
      texter: [...TEXTER.slice(0, 3), ['09:42:15.126', TVÅ('om 1 minuter')]],
      skäl: /^nivån efter hoppet 09:42:15\.101 \(8 min\) är 1 min 09:42:15\.126, ingen återgång till strax$/,
    },
    // Den låsta banken.
    låstBank: {
      texter: TEXTER,
      extra: { ursprung: { korpus: 'X', relation: 'BAS' } },
      skäl: /^låst bank: bara runAllCorpora:s exakta prefixmatch gäller, ingen registeramnesti$/,
    },
    // Hoppet 1,2 s före MASEN 2:s nästa rad, till exempel vid en tick strax före raden.
    hoppFöreFönstret: {
      texter: [...TEXTER.slice(0, 2), ['09:42:13.901', TVÅ('om 8 minuter')], ['09:42:15.126', TVÅ('strax')], TEXTER[4]],
      skäl: new RegExp('^hoppet 09:42:13\\.901 publicerades inte när harnessen bearbetade en båts rad: 265855691:s fix 09:32:10\\.242 .* var 603\\.7 s gammal, '
        + 'men hennes nästa rad 09:42:15\\.101 bearbetades 1\\.2 s efter hoppet'),
    },
    // Återgången 1,125 s efter raden.
    // Fönstret räknas från radens tid: MASEN 2:s rad bearbetas 60 ms sent
    // (två rader före i klustret), och återgången kommer 950 ms efter
    // bearbetningen, 1,01 s efter radens tid.
    återgångFrånRadensTid: {
      texter: [...TEXTER.slice(0, 2), ['09:42:15.161', TVÅ('om 8 minuter')], ['09:42:16.111', TVÅ('strax')], TEXTER[4]],
      rader: [...MASEN_RADER, ...ANDRA, rad('265855485', '09:42:15.041', 58.30101, 12.30362, 5.7, 210.8),
        rad('265855773', '09:42:15.071', 58.28141, 12.28263, 5.6, 168.2)],
      skäl: /, men återgången till strax 09:42:16\.111 kom 950 ms efter radens bearbetning \(efter den och högst 1000 ms efter radens tid\)$/,
    },
    återgångEfterFönstret: {
      texter: [...TEXTER.slice(0, 3), ['09:42:16.226', TVÅ('strax')], TEXTER[4]],
      skäl: /^265855691:s fix 09:32:10\.242 .* var 604\.9 s gammal vid hoppet 09:42:15\.101, .*, men återgången till strax 09:42:16\.226 kom 1\.1 s efter radens bearbetning/,
    },
  };
  const fall = (namn) => {
    const x = FALL[namn];
    return x.klaff ? klaff(...x.klaff) : domar(x.texter, x.rader, x.extra);
  };

  test('[vakt] en studs 5 min efter båtens nästa fix ger KANDIDAT, liksom båtens nästa fix 5 min efter studsen', () => {
    expect(klasser(fall('femMinSenare'))).toEqual(BÅDA('KANDIDAT'));
    expect(klasser(fall('nästaFixFemMinEfter'))).toEqual(BÅDA('KANDIDAT'));
  });

  test('[vakt] en studs vid en annan båts rad (YRSA 09:42:15,173) medan MASEN 2 är tyst ger KANDIDAT', () => {
    expect(klasser(fall('annanBåtsRad'))).toEqual(BÅDA('KANDIDAT'));
  });

  test('[vakt] exakt 600 000 ms, B4-varianten (407 s, också i F21:s minsta repro), en båt långt från bron, en återgång till 1 min och den låsta banken ger KANDIDAT', () => {
    for (const namn of ['ålder600000', 'b4', 'b4Klaffbron', 'långt', 'enMinut', 'låstBank']) expect([namn, klasser(fall(namn))]).toEqual([namn, BÅDA('KANDIDAT')]);
  });

  test('[vakt] ett hopp 1,2 s före båtens nästa rad, en återgång 1,1 s efter den och en återgång 1,01 s efter en sent bearbetad rads tid ger KANDIDAT', () => {
    for (const namn of ['hoppFöreFönstret', 'återgångEfterFönstret', 'återgångFrånRadensTid']) expect([namn, klasser(fall(namn))]).toEqual([namn, BÅDA('KANDIDAT')]);
  });

  test('[nytt] skälen pekar ut villkoret som fattas', () => {
    for (const [namn, x] of Object.entries(FALL)) {
      for (const d of fall(namn)) expect([namn, d.f.klass, d.skäl]).toEqual([namn, d.f.klass, expect.stringMatching(x.skäl)]);
    }
  });

  // En fasvariant: fyndets tid, raderna och övergångarna ligger i basens
  // tidsram (relations.comparePhase), men UI-klockan slog på variantens
  // halvminuter.
  const fasvariant = (dt) => {
    const { shiftEpochDeep } = require('../lib/bankOps');
    const V = resultat(TEXTER.map(([hms, text]) => [iso(at(hms) + dt).slice(11, 23), text]));
    const fynd = existing.judgeExisting({ result: V, rows: [], gt: null }).fynd.filter((x) => x.inv === 'INV-3');
    expect(fynd).toHaveLength(2);
    const reg = loadRegistry();
    return fynd.map((f) => klassa(reg, { ...f, t: f.t - dt, ursprung: { korpus: 'X', relation: 'M-FAS', deltaS: [dt / 1000] } },
      { rader: [...MASEN_RADER, ...ANDRA], resultat: shiftEpochDeep(V, -dt) }));
  };

  test('[rättning] i en fasvariant (δ +7 s) läses fyndets tid, raderna och övergångarna i basens tidsram', () => {
    for (const c of fasvariant(7000)) expect(c).toMatchObject({ klass: 'MÄTGRÄNS', post: U16 });
  });

  test('[efterrättning] i en fasvariant räknas halvminutsticken i variantens fas: vid δ −11,52 s ligger ticken 09:42:00 (09:42:11,520 i basen) efter 600 s-gränsen', () => {
    for (const c of fasvariant(-11520)) expect(c.klass).toBe('KANDIDAT');
  });

  test('[nytt] skälet i fasvarianten δ −11,52 s pekar ut variantens halvminutstick i basens tid', () => {
    for (const c of fasvariant(-11520)) {
      expect(c.prövade.find((p) => p.post === U16).skäl).toMatch(/, men åldern passerade 600 s 09:42:10\.242, före halvminutsticken 09:42:11\.520 \(variantens fas\)/);
    }
  });

  test('[nytt] harnessTider: en rad bearbetas vid max(radens tid, förra AIS-radens + 60 ms) i stabil tidsordning, och styrraderna tickar inte', () => {
    const { harnessTider } = require('../lib/registry');
    const r = [rad('2', 2000, 0, 0), rad('1', 1000, 0, 0), rad('3', 2000, 0, 0), rad('4', 2030, 0, 0), { ctrl: 'reconnect', aisTimestamp: 2050 },
      rad('5', 2100, 0, 0), rad('6', 9000, 0, 0)];
    const t = harnessTider({ rader: r });
    expect(r.map((x) => t.get(x))).toEqual([2000, 1000, 2060, 2120, 2180, 2180, 9000]);
  });

  test('[nytt] halvminutstickFas räknar ticken i variantens klocka och svarar i basens', () => {
    const { halvminutstickFas } = require('../lib/registry');
    expect(halvminutstickFas(at('09:42:10.242'), at('09:42:15.061'), 30000, 40, -11520)).toBe(at('09:42:11.520'));
    expect(halvminutstickFas(at('09:42:10.242'), at('09:42:15.061'), 30000, 40, 7000)).toBeNull();
    expect(halvminutstickFas(at('09:41:55.000'), at('09:42:15.061'), 30000, 40, 0)).toBe(at('09:42:00.000'));
  });

  test('[nytt] posten är registrerad efter KIE-PER-KORPUS, namnger INV-3 och citerar U16 och F40-avvägningen', () => {
    const reg = loadRegistry();
    const ids = reg.poster.map((e) => e.id);
    expect(ids.indexOf(U16)).toBe(ids.indexOf('KIE-PER-KORPUS') + 1);
    const e = reg.entry(U16);
    expect(e).toMatchObject({ klass: 'MÄTGRÄNS', gäller: { orakel: ['INV-F'], inv: ['INV-3'] } });
    expect(e.källa).toMatch(/docs\/BUGGJAKT\.md §7 \(användarbeslut U16 2026-11-04/);
    expect(e.källa).toMatch(/docs\/helgranskning-2026-07-06\.md:271–274/);
    expect(e.källa).toMatch(/docs\/etapp7-plan-2026-08-08\.md:8 \(U1\), :15 \(U6\) och :267 \(C11/);
    expect(e._params).toMatchObject({
      minÅlderS: 600, fönsterMs: 1000, radieM: 350, imminentRadieM: 300, väntRadieM: 270, straxRadieM: 500, tickS: 30, tickFördröjningMs: 40,
    });
    // Raderna gäller aa71099, där U14 sköt dräneringen 30 rader nedåt (BUGGJAKT §7, rad 36).
    expect(e.källa).toMatch(/tests\/replay-validation\/replayRunner\.js:86–88 och :542–551/);
    // Ett INV-3-fynd utan brotextövergångar (som bankens kort i övriga
    // sviter) ger KANDIDAT med KIE-PER-KORPUS som närmast, som förut.
    const c = klassa(reg, {
      orakel: 'INV-F', inv: 'INV-3', klass: 'INV-3 ETA-OSCILLATION', bro: 'Klaffbron', t: at('09:42:15.126'), detalj: 'x',
    }, { rader: [], resultat: {} });
    expect(c).toMatchObject({ klass: 'KANDIDAT', närmast: { post: 'KIE-PER-KORPUS' } });
    expect(c.prövade.map((p) => p.post)).toEqual(['KIE-PER-KORPUS', U16]);
  });
});
