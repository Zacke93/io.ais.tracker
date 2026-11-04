'use strict';

/**
 * Runda 2 av motorrättningen 2026-11-04, efterrättningen (rättare H):
 * S10-VÄNDNING-BRON-BAKOM spelar Fix D:s pending-logik över fartygets fixar
 * före zonen (granskarens varv s0, nytt problem 1). Zonens första fix sätter
 * flaggan bara om ingen färsk flagga redan finns och riktningslåset
 * fortfarande är det gamla; annars bekräftar den reversalen eller är inte
 * omvänd, och S10-vakten avstår inte.
 *
 * Varje rad- och utfallsuppgift nedan är prövad mot appen med sonden s10h
 * (granskarens s10x utvidgad; värld 581 och 1818 i standardkörningen, seed
 * 1; utfallen och appens Fix D-loggrader redovisas i efterrättningens svar):
 * där appen notifierar ska fallet, med notisen borttagen, ge KANDIDAT, och
 * där appen avstår ska det ge DESIGN.
 * [rättning]-fallen fälls av motorn före efterrättningen (F/pre2 och läget
 * efter rättare E), som antog att zonens första fix satte flaggan.
 * [vakt]-fallen håller i båda. [regel]-fallet håller fast ett medvetet
 * konservativt val och dess skäl. [nytt] prövar hjälparen spelaFixD.
 *
 * Det sista blocket (nytt problem 3) prövar att registrets _om bara
 * hänvisar till rader som finns i listan över registerändringar i BUGGJAKT
 * §7. Det fäller läget efter rättare E (rad 15 saknades) och F/pre2, vars
 * _om inte hänvisade till några rader. Inga barnprocesser och inga timers.
 */

const MIN = 60000;
const { loadRegistry } = require('../lib/registry');

const klassa = (reg, f, ctx) => reg.classify(f, ctx, { räkna: false });
const S10 = 'S10-VÄNDNING-BRON-BAKOM';

describe('H S10-VÄNDNING-BRON-BAKOM: Fix D:s pending-flagga och riktningslås före zonen', () => {
  const rad = (mmsi) => ([lat, lon, sog, cog, t]) => ({
    mmsi, lat, lon, sog, cog, aisTimestamp: t,
  });
  // F15:s tre världar (samma rader som e-runda2.test.js, ur
  // core.materialize(sampleWorld(1, i)) med standardprofilens radio).
  const V215 = {
    mmsi: '265245022',
    bro: 'Klaffbron',
    tIn: 1786192304000,
    tOut: 1786192444000,
    tFörstaFix: 1786192435835,
    rader: [
      [58.2747, 12.27798, 4.5, 27.2, 1786191959744], [58.2758, 12.27934, 4.5, 25.1, 1786192026041],
      [58.27692, 12.28025, 4.6, 23.8, 1786192095820], [58.27799, 12.28079, 4.4, 19.5, 1786192164559],
      [58.27934, 12.28184, 4.6, 11.9, 1786192233448], [58.28131, 12.28267, 4.3, 14.8, 1786192302925],
      [58.28208, 12.28308, 3.6, 195.3, 1786192435835], [58.28056, 12.28252, 4.8, 199.9, 1786192503073],
      [58.27901, 12.28151, 5, 218.9, 1786192570972],
    ].map(rad('265245022')),
  };
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
  const V1818 = {
    mmsi: '265412496',
    bro: 'Klaffbron',
    tIn: 1783476986000,
    tOut: 1783477046000,
    tFörstaFix: 1783477047135,
    rader: [
      [58.28988, 12.28966, 3.7, 216.8, 1783476777427], [58.28777, 12.28707, 3.9, 212.3, 1783476910580],
      [58.28689, 12.28618, 3.7, 200.2, 1783476980145], [58.28659, 12.28586, 2.4, 25.8, 1783477047135],
      [58.28709, 12.28626, 2.5, 30.1, 1783477114679], [58.28786, 12.28733, 2.5, 38, 1783477180831],
    ].map(rad('265412496')),
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
  /** S10-postens skäl bland de prövade posterna. */
  const s10skäl = (c) => (c.prövade.find((p) => p.post === S10) || {}).skäl;
  /**
   * Extra fix som i granskarens s10x: på linjen från zonens första fix mot
   * fixen före besöket, andelen fr av vägen (fr > 1 ligger före den fixen),
   * med given fart och kurs.
   */
  const påLinjen = (v, fr, sog, cog) => {
    const zon = v.rader.find((r) => r.aisTimestamp === v.tFörstaFix);
    const före = v.rader.filter((r) => r.aisTimestamp < v.tFörstaFix).pop();
    return {
      ...zon,
      lat: zon.lat + fr * (före.lat - zon.lat),
      lon: zon.lon + fr * (före.lon - zon.lon),
      sog,
      cog,
      aisTimestamp: Math.round(zon.aisTimestamp + fr * (före.aisTimestamp - zon.aisTimestamp)),
    };
  };
  /** Samma linje, men exakt ms före zonens första fix. */
  const exakt = (v, ms, sog, cog) => {
    const före = v.rader.filter((r) => r.aisTimestamp < v.tFörstaFix).pop();
    return { ...påLinjen(v, ms / (v.tFörstaFix - före.aisTimestamp), sog, cog), aisTimestamp: v.tFörstaFix - ms };
  };
  const med = (v, ...extra) => [...v.rader, ...extra].sort((a, b) => a.aisTimestamp - b.aisTimestamp);
  const T_1001 = V581.rader[1].aisTimestamp; // fixen före besöket i värld 581, 10:01:26

  test('[rättning] en flagga satt före zonen och inte nollad: zonens första fix bekräftar reversalen och notisen går ut (granskarens s10x)', () => {
    const reg = loadRegistry();
    // 10:03:51 omvänd på 2,2 kn (flaggan sätts), 10:05:18 i det gamla bandet
    // på 1,9 respektive 1,0 kn (under FIX_D_MIN_SOG: rör inte flaggan). Appen
    // bekräftar reversalen 10:06:16 och notifierar söderut.
    for (const sog of [1.9, 1.0]) {
      const rader = med(V581, påLinjen(V581, 0.5, 2.2, 216), påLinjen(V581, 0.2, sog, 30));
      const c = klassa(reg, besök(V581), ctx(rader));
      expect([sog, c.klass]).toEqual([sog, 'KANDIDAT']);
      expect(s10skäl(c)).toMatch(/^zonens första fix 10:06:16 \(2\.2 kn ≥ FIX_D_MIN_SOG 2 kn\) bekräftar reversalen som flaggades 10:03:51, 145 s tidigare \(inom 15 min\); notisen går ut$/);
    }
    // Samma mönster i den nordvända världen 1818 (låset söderut): 02:15:46
    // omvänd norrut på 2,4 kn, fixen före besöket 02:16:20 på 1,9 kn. Appen
    // notifierar norrut 02:17:27.
    const rader = sätt(med(V1818, påLinjen(V1818, 1.5, 2.4, 25)), 1783476980145, { sog: 1.9 });
    const c = klassa(reg, besök(V1818), ctx(rader));
    expect(c.klass).toBe('KANDIDAT');
    expect(s10skäl(c)).toMatch(/bekräftar reversalen som flaggades 02:15:46, 100 s tidigare/);
  });

  test('[vakt] en fix med minst FIX_D_MIN_SOG i det gamla bandet nollar flaggan: DESIGN, liksom F15:s tre världar', () => {
    const reg = loadRegistry();
    // 10:05:18 på 2,2 kn nollar flaggan, zonens första fix sätter en ny, och
    // appen avstår (FLOW_TRIGGER_SKIP_PENDING_REVERSAL, ingen notis).
    const rader = med(V581, påLinjen(V581, 0.5, 2.2, 216), påLinjen(V581, 0.2, 2.2, 30));
    expect(klassa(reg, besök(V581), ctx(rader))).toMatchObject({ klass: 'DESIGN', post: S10 });
    // I 1818 med fixen före besöket kvar på 3,7 kn: appen avstår.
    expect(klassa(reg, besök(V1818), ctx(med(V1818, påLinjen(V1818, 1.5, 2.4, 25))))).toMatchObject({ klass: 'DESIGN', post: S10 });
    // F15: inget i fartygens spår före zonen rör flaggan; skälen är oförändrade.
    for (const v of [V215, V581, V1818]) {
      const c = klassa(reg, besök(v), ctx(v.rader));
      expect([v.mmsi, c.klass, c.post]).toEqual([v.mmsi, 'DESIGN', S10]);
      expect(c.skäl).toMatch(/^vändning mellan .* så S10-vakten avstår \(FLOW_TRIGGER_SKIP_PENDING_REVERSAL\)$/);
    }
  });

  test('[rättning] en reversal som bekräftats redan före zonen: zonens första fix är inte omvänd och sätter ingen flagga', () => {
    const reg = loadRegistry();
    // 10:02:53 och 10:03:51 omvända på 2,2 kn: appen bekräftar söderut
    // 10:03:51. 10:05:18 (30°, 2,2 kn) är då omvänd mot det nya låset och
    // flaggar norrut, och zonens första fix nollar den. Appen notifierar
    // söderut 10:06:16. Granskarens förslag (sätt och nolla
    // utan lås) hade gett DESIGN här.
    const rader = med(V581, påLinjen(V581, 0.7, 2.2, 216), påLinjen(V581, 0.5, 2.2, 216), påLinjen(V581, 0.2, 2.2, 30));
    const c = klassa(reg, besök(V581), ctx(rader));
    expect(c.klass).toBe('KANDIDAT');
    expect(s10skäl(c)).toMatch(/^Fix D bekräftade reversalen söderut redan 10:03:51 \(flaggad 10:02:53\), före zonen: låset är söderut/);
    // [vakt] Två fixar till i det gamla bandet (10:04:49 och 10:05:18)
    // bekräftar tillbaka norrut; zonens första fix flaggar, och appen avstår.
    const tillbaka = med(V581, påLinjen(V581, 0.7, 2.2, 216), påLinjen(V581, 0.5, 2.2, 216), påLinjen(V581, 0.3, 2.2, 30), påLinjen(V581, 0.2, 2.2, 30));
    expect(klassa(reg, besök(V581), ctx(tillbaka))).toMatchObject({ klass: 'DESIGN', post: S10 });
  });

  test('[rättning] flaggans ålder räknas som appens: yngre än FIX_D_PENDING_MAX_AGE_MS bekräftar, exakt 15 min är inaktuell', () => {
    const reg = loadRegistry();
    // En omvänd fix på 2,2 kn exakt 899 999 respektive 900 000 ms före
    // zonens första fix, och fixen 10:01:26 på 1,0 kn (rör inte flaggan).
    // Appen bekräftar och notifierar i det första fallet men inte i det
    // andra (`< PENDING_MAX_AGE_MS`, VesselDataService.js:448–452).
    const fall = (ms) => sätt(med(V581, exakt(V581, ms, 2.2, 216)), T_1001, { sog: 1.0 });
    const c = klassa(reg, besök(V581), ctx(fall(15 * MIN - 1)));
    expect(c.klass).toBe('KANDIDAT');
    expect(s10skäl(c)).toMatch(/bekräftar reversalen som flaggades 09:51:16, 900 s tidigare/);
    expect(klassa(reg, besök(V581), ctx(fall(15 * MIN)))).toMatchObject({ klass: 'DESIGN', post: S10 });
  });

  test('[regel] en långsam zonfix med en färsk flagga från före zonen ger KANDIDAT, med skälet att flaggan sattes före zonen', () => {
    const reg = loadRegistry();
    // Appen avstår här (vakten läser flaggan från 10:03:51 vid zonfixen på
    // 1,0 kn), men predikatet godtar bara en flagga som zonens
    // första fix själv sätter: ett konservativt KANDIDAT, ingen amnesti.
    // F/pre2 gav DESIGN (den saknade E1:s fartkrav), och läget efter rättare
    // E gav skälet "S10-vakten avstår inte", som inte stämmer här.
    const rader = sätt(med(V581, påLinjen(V581, 0.5, 2.2, 216), påLinjen(V581, 0.2, 1.9, 30)), V581.tFörstaFix, { sog: 1.0 });
    const c = klassa(reg, besök(V581), ctx(rader));
    expect(c.klass).toBe('KANDIDAT');
    expect(s10skäl(c)).toMatch(/^zonens första fix 10:06:16 har fart 1 kn \(< FIX_D_MIN_SOG 2 kn\) och sätter ingen egen pending-flagga; flaggan från 10:03:51 sattes före zonen/);
    // Utan flagga före zonen är skälet oförändrat (e-runda2, E1).
    const utan = klassa(reg, besök(V581), ctx(sätt(V581.rader, V581.tFörstaFix, { sog: 1.0 })));
    expect(s10skäl(utan)).toMatch(/< FIX_D_MIN_SOG 2 kn\): Fix D sätter ingen pending-flagga, så S10-vakten avstår inte$/);
  });

  test('[nytt] spelaFixD följer Fix D-blocket: fartgräns, omvänd mot låset, bekräftelse inom åldern, nollning', () => {
    const { spelaFixD } = require('../lib/registry');
    const band = (cog) => {
      if (cog >= 315 || cog <= 45) return 'norr';
      if (cog >= 135 && cog < 315) return 'söder';
      return null;
    };
    const o = (lås) => ({
      lås, minSogKn: 2, maxÅlderMs: 15 * MIN, band,
    });
    const f = (t, cog, sog) => ({ aisTimestamp: t * 1000, cog, sog });
    // Långsamma fixar och fixar utan kurs rör ingenting.
    expect(spelaFixD([f(0, 200, 1.9), f(10, NaN, 3), f(20, 200, null)], o('norr'))).toEqual({ lås: 'norr', flagga: null, bekräftad: null });
    // Omvänd mot låset sätter flaggan; nästa omvända inom åldern bekräftar.
    expect(spelaFixD([f(0, 200, 2)], o('norr'))).toEqual({ lås: 'norr', flagga: { riktning: 'söder', t: 0 }, bekräftad: null });
    expect(spelaFixD([f(0, 200, 2), f(60, 250, 2.5)], o('norr'))).toEqual({ lås: 'söder', flagga: null, bekräftad: { till: 'söder', t: 60000, flaggad: 0 } });
    // En inaktuell flagga ersätts i stället för att bekräftas.
    expect(spelaFixD([f(0, 200, 2), f(900, 200, 2)], o('norr')).flagga).toEqual({ riktning: 'söder', t: 900000 });
    // Det gamla bandet och glappet 45°–135° är inte omvända och nollar flaggan.
    expect(spelaFixD([f(0, 200, 2), f(30, 30, 2)], o('norr')).flagga).toBeNull();
    expect(spelaFixD([f(0, 200, 2), f(30, 90, 2)], o('norr')).flagga).toBeNull();
    // Med låset söderut är bara nordbandet omvänt (det breda sydbandet och glappet nollar).
    expect(spelaFixD([f(0, 20, 2)], o('söder')).flagga).toEqual({ riktning: 'norr', t: 0 });
    expect(spelaFixD([f(0, 20, 2), f(30, 300, 2)], o('söder')).flagga).toBeNull();
    // Efter en bekräftelse gäller det nya låset: det gamla bandet flaggar tillbaka.
    expect(spelaFixD([f(0, 200, 2), f(60, 200, 2), f(120, 30, 2)], o('norr'))).toMatchObject({ lås: 'söder', flagga: { riktning: 'norr', t: 120000 } });
  });
});

// ---------------------------------------------------------------------------
// Registrets _om och listan över registerändringar (granskarens varv s0, nytt
// problem 3): _om hänvisade till "BUGGJAKT §7, rad 10–15" när listan bara
// hade rad 1–14. Ägaren granskar registerändringarna via listan, så varje
// radhänvisning i _om ska peka på en rad som finns.
// ---------------------------------------------------------------------------

describe('H registrets _om hänvisar bara till rader som finns i BUGGJAKT §7', () => {
  test('[rättning] varje "rad N" och "rad A–B" i _om finns i listan över registerändringar', () => {
    const fs = require('fs');
    const path = require('path');
    const reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'beslutsregister.json'), 'utf8'));
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'docs', 'BUGGJAKT.md'), 'utf8');
    const start = doc.indexOf('### Registerändringar att granska');
    expect(start).toBeGreaterThan(0);
    const lista = doc.slice(start, doc.indexOf('\n## 8.', start));
    const rader = new Set([...lista.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1])));
    const hänvisade = [];
    for (const m of reg._om.matchAll(/\brad (\d+)(?:–(\d+))?/g)) {
      for (let n = Number(m[1]); n <= Number(m[2] || m[1]); n++) hänvisade.push(n);
    }
    // Inte tomt: _om ska hänvisa till rundornas rader (sedan runda 2).
    expect(hänvisade.length).toBeGreaterThan(0);
    expect(hänvisade.filter((n) => !rader.has(n))).toEqual([]);
  });
});
