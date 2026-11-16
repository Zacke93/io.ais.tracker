'use strict';

/**
 * Rättningsrundan 2026-11-04, rättare B: beslutsregistret och T2-oraklets
 * konvojsemantik (motorgranskningens M03, M04, M05 och M12, triagens T-1,
 * T-2 och T-3). Varje describe-block har fall som den gamla motorn
 * (ögonblicksbilden före rundan) fäller. Inga barnprocesser och inga timers.
 */

const path = require('path');

const MIN = 60000;
const corpora = require(path.join('..', '..', 'corpora'));
const { loadRegistry } = require('../lib/registry');
const { makeFinding } = require('../lib/finding');
const existing = require('../lib/oracles/existing');

const klassa = (reg, f, ctx) => reg.classify(f, ctx, { räkna: false });

// ---------------------------------------------------------------------------
// M03: KIE-PER-KORPUS gäller samma episod och aldrig låst bank
// ---------------------------------------------------------------------------

describe('M03 KIE-PER-KORPUS: samma episod, aldrig registeramnesti på låst bank', () => {
  const k42 = corpora.find((c) => c.id === '20260806-42h');
  const k41 = corpora.find((c) => c.id === '20260713-41h');
  const ctx42 = { korpus: k42, rader: [], resultat: {} };
  const flash = (hms, s) => `DEFAULT-FLASH: 2026-08-06T${hms}Z "Inga båtar" inklämd (${s}s) mellan två "En … Stridsbergsbron"-texter utan passage`;
  // Ett nytt fatalt utslag i en fasvariant, som relations.comparePhase bygger det.
  const fasFynd = (msg, deltaS, korpus = '20260806-42h') => {
    const f = existing.fromInvariant(msg, 'INV-F');
    return makeFinding({
      ...f,
      t: f.t - deltaS * 1000,
      belägg: {
        ...f.belägg, meddelanden: [msg], ny: true, tidsram: 'variant',
      },
      spår: 'bank',
      nivå: 'bank',
      ursprung: { korpus, relation: 'M-FAS', deltaS: [deltaS] },
      taggar: ['KNIVSEGG'],
    });
  };

  test('42h-flashens fasvariant är ACCEPTERAD vid δ −20, −11,52, −7, +7 och +15 s (acceptanskriteriet)', () => {
    const reg = loadRegistry();
    // Variantens klocka och längd per δ, ur första standardrapporten.
    const varianter = [[-20, '08:46:30.040', 59], [-11.52, '08:46:30.040', 60], [-7, '08:46:30.040', 60], [7, '08:47:00.040', 56], [15, '08:47:00.040', 60]];
    for (const [d, hms, s] of varianter) {
      expect(klassa(reg, fasFynd(flash(hms, s), d), ctx42)).toMatchObject({ klass: 'ACCEPTERAD', post: 'KIE-PER-KORPUS' });
    }
  });

  test('en ny episod vid samma bro i samma korpus, vid en annan tid, amnestieras inte', () => {
    const reg = loadRegistry();
    // Granskarens regprobe: en annan DEFAULT-FLASH i 42h sju timmar senare.
    const ny = klassa(reg, fasFynd(flash('15:52:00.040', 240), 7), ctx42);
    expect(ny.klass).toBe('KANDIDAT');
    expect(ny.närmast).toMatchObject({ post: 'KIE-PER-KORPUS' });
    expect(ny.närmast.skäl).toMatch(/en annan episod/);
    // Gränsen för DEFAULT-FLASH är |δ| + en tick (runda 2, E3; efterrättning D:
    // |δ| + episodens längd + en tick; förut |δ| + 5 min): vid δ +7 s och en
    // 60 s lång flash är 37 s isär samma episod, 38 s är det inte.
    expect(klassa(reg, fasFynd(flash('08:47:37.040', 60), 7), ctx42).klass).toBe('ACCEPTERAD');
    expect(klassa(reg, fasFynd(flash('08:47:38.040', 60), 7), ctx42).klass).toBe('KANDIDAT');
    // En ETA-sågtand i 41h ett dygn före undantaget.
    const sågtand = fasFynd('ETA-SÅGTAND UPP: 2026-07-14T03:10:00.000Z Stridsbergsbron 2→17 på 30s', 7, '20260713-41h');
    expect(klassa(reg, sågtand, { korpus: k41, rader: [], resultat: {} }).klass).toBe('KANDIDAT');
  });

  test('en ny DEFAULT-FLASH på låst bank hamnar under "Nya träffar på låst bank"', () => {
    const selftest = require('../lib/selftest');
    const clusterLib = require('../lib/cluster');
    const report = require('../lib/report');
    const reg = loadRegistry();
    // Granskarens kieprobe: korpusens kända flash och en ny episod nästa dag.
    const ny = 'DEFAULT-FLASH: 2026-08-07T14:12:30.040Z "Inga båtar" inklämd (210s) mellan två "En … Stridsbergsbron"-texter utan passage';
    const körning = {
      register: reg,
      bas: new Map([[k42.id, {
        korpus: k42,
        kc: {
          rader: [], simTimmar: 42, jsonl: k42.jsonl, statePath: null,
        },
        resultat: {},
        gt: [],
        utfall: { ok: true, resultat: {} },
        fatala: [k42.knownInvariantExceptions[0], ny],
        leverans: [],
      }]]),
    };
    const låst = selftest.lockedBankFindings(körning);
    expect(låst.kända).toBe(1);
    expect(låst.fynd).toHaveLength(1);
    const [f] = låst.fynd;
    // Registret amnestierar inte heller när fyndet klassas om (fas 3 eller hunt:repro).
    const c = klassa(reg, f, f.kontext);
    expect(c.klass).toBe('KANDIDAT');
    if (!f.register) f.register = { klass: c.klass, post: c.post, närmast: c.närmast };
    expect(f.register.klass).toBe('KANDIDAT');
    const urval = report.assignCards(clusterLib.clusterFindings(låst.fynd));
    expect(urval.låst).toHaveLength(1);
    expect(urval.kort[0].kluster.låstBank).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M04 och T-2: en definition av "täckt av händelsen" och "returresa"
// ---------------------------------------------------------------------------

describe('M04 och T-2: konvojsemantiken är densamma i registret och T2-oraklet', () => {
  const T = Date.UTC(2026, 6, 1, 10, 0, 0);
  const X = '265100001'; // U-svängaren, medlem i Klaffbron#5
  const Y = '265100002'; // aldrig medlem eller absorberad
  const Z = '265100003'; // absorberas i Klaffbron#5
  const V = '265100004'; // ytterligare en båt utan täckning
  const linje = (mmsi, dtMin) => ({
    mmsi, bridge: 'Klaffbron', t: T + dtMin * MIN, kind: 'line', inferred: false,
  });
  const ctxOf = (gt, coverage = []) => ({
    rader: [],
    resultat: {
      openingWarnings: [{
        eventId: 'Klaffbron#5', bridge: 'Klaffbron', t: T, success: true, leadMmsi: X, mmsis: [X], direction: 'northbound',
      }],
      openingCoverage: [{
        eventId: 'Klaffbron#5', mmsi: X, bridge: 'Klaffbron', reason: 'fired', t: T,
      }, ...coverage.map(([mmsi, dtMin]) => ({
        eventId: 'Klaffbron#5', mmsi, bridge: 'Klaffbron', reason: 'absorbed', t: T + dtMin * MIN,
      }))],
      targetPassages: [],
    },
    gt: [...gt].sort((a, b) => a.t - b.t),
  });
  // T2-fyndet som synthCore bygger det (belägg.korsningT = sann korsning).
  const t2 = (mmsi, dtMin, klass = 'ÖPPNING-MISS:OKLASSAD', belägg = {}) => makeFinding({
    orakel: 'T2', klass, allvar: 5, mmsi, bro: 'Klaffbron', riktning: 'southbound', t: T + dtMin * MIN, belägg: { korsningT: T + dtMin * MIN, ...belägg }, spår: 'synth', nivå: 'R0',
  });

  test('granskarens u2probe efter U15: egen retur 7 min efter utresan är KANDIDAT (returen är en egen öppning); en båt som aldrig täcktes är KANDIDAT', () => {
    // Registret 2026-11-07 (BUGGJAKT §7 rad 23): U2-RETURRESA är borttagen,
    // och U2-VS-DEADLINE och J13 räknar aldrig båtens egen äldre händelse
    // när hon själv korsat bron efter varningen (konvoj.egenKorsningEfter).
    const reg = loadRegistry();
    const ctx = ctxOf([linje(X, 4), linje(Y, 9), linje(X, 11)]);
    const retur = klassa(reg, t2(X, 11), ctx);
    expect(retur.klass).toBe('KANDIDAT');
    expect(reg.entry('U2-RETURRESA')).toBeNull();
    expect(klassa(reg, t2(Y, 9), ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] U15: en retur förklaras inte heller av U2-VS-DEADLINE eller J13 via båtens egen äldre händelse', () => {
    const reg = loadRegistry();
    const konvoj = require('../lib/konvoj');
    // Y (utanför händelsen) korsade 5 min, X utresa 6 min och retur 9 min:
    // utan vakten hade J13 räknat Klaffbron#5 som öppen (X:s utresa inom 600 s).
    const ctx = ctxOf([linje(Y, 5), linje(X, 6), linje(X, 9)]);
    expect(klassa(reg, t2(X, 9), ctx).klass).toBe('KANDIDAT');
    const w = ctx.resultat.openingWarnings[0];
    expect(konvoj.egenKorsningEfter(w, { mmsi: X, bro: 'Klaffbron', tc: T + 9 * MIN }, ctx.gt)).toBe(true);
    // Motexempel: utan egen tidigare korsning förklarar J13 som förut.
    expect(klassa(reg, t2(X, 9), ctxOf([linje(Y, 5), linje(X, 9)]))).toMatchObject({ post: 'J13-J14-KONVOJSEMANTIK' });
  });

  test('U2-VS-DEADLINE kräver att båten var täckt: absorberad båt inom fönstret är KÄND_ÖPPEN, otäckt är KANDIDAT', () => {
    const reg = loadRegistry();
    const gt = [linje(X, 4), linje(Z, 9)];
    expect(klassa(reg, t2(Z, 9), ctxOf(gt, [[Z, 2]]))).toMatchObject({ klass: 'KÄND_ÖPPEN', post: 'U2-VS-DEADLINE' });
    // Absorptionen räknas bara om den skedde före korsningen.
    expect(klassa(reg, t2(Z, 9), ctxOf(gt, [[Z, 10]])).klass).toBe('KANDIDAT');
    expect(klassa(reg, t2(Z, 9), ctxOf(gt)).klass).toBe('KANDIDAT');
  });

  test('en retur som appen absorberade i båtens egen äldre händelse är KANDIDAT, även utanför konvojfönstret', () => {
    const reg = loadRegistry();
    // X:s utresa 4 min, returen 20 min (16 min senare); X absorberas på nytt 19 min.
    const c = klassa(reg, t2(X, 20), ctxOf([linje(X, 4), linje(X, 20)], [[X, 19]]));
    expect(c.klass).toBe('KANDIDAT');
    expect(c.närmast).toMatchObject({ post: 'U2-VS-DEADLINE' });
  });

  test('J13 gäller bara en händelse som täckte båten och fortfarande var öppen enligt medlemskravet', () => {
    const reg = loadRegistry();
    // X (medlem) korsar först 9 min; Y (utanför händelsen) korsade 5 min.
    expect(klassa(reg, t2(X, 9), ctxOf([linje(Y, 5), linje(X, 9)]))).toMatchObject({ klass: 'KÄND_ÖPPEN', post: 'J13-J14-KONVOJSEMANTIK' });
    // V täcktes aldrig av Klaffbron#5: varken U2-VS-DEADLINE eller J13 förklarar V:s miss.
    expect(klassa(reg, t2(V, 12), ctxOf([linje(X, 4), linje(Y, 9), linje(V, 12)])).klass).toBe('KANDIDAT');
    // Z absorberad, medlemmen X passerade 12 min före Z: täckningen hade löpt ut
    // (konvojfönstrets bakkant), så Y:s korsning emellan förklarar inget.
    const bakkant = klassa(reg, t2(Z, 16), ctxOf([linje(X, 4), linje(Y, 8), linje(Z, 16)], [[Z, 2]]));
    expect(bakkant.klass).toBe('KANDIDAT');
    expect(bakkant.närmast).toMatchObject({ post: 'U2-VS-DEADLINE' });
  });

  test('oraklets förklaring (explainT2) och registrets klass är desamma', () => {
    const reg = loadRegistry();
    const { explainT2 } = require('../lib/oracles/t2Opening');
    const data = (ctx) => ({
      varningar: ctx.resultat.openingWarnings, korsningar: ctx.gt, coverage: ctx.resultat.openingCoverage,
    });
    const tidig = { accepted: true, klass: 'FÖRST_SEDD_FÖR_NÄRA', bevis: 'först sedd 150 s före' };
    const fall = [
      [ctxOf([linje(X, 4), linje(Y, 9), linje(X, 11)]), X, 11, null],
      [ctxOf([linje(X, 4), linje(Y, 9), linje(X, 11)]), Y, 9, null],
      [ctxOf([linje(X, 4), linje(Z, 9)], [[Z, 2]]), Z, 9, null],
      [ctxOf([linje(X, 4), linje(Z, 9)]), Z, 9, null],
      [ctxOf([linje(Y, 5), linje(X, 9)]), X, 9, null],
      [ctxOf([linje(X, 4), linje(Y, 8), linje(Z, 16)], [[Z, 2]]), Z, 16, null],
      [ctxOf([linje(X, 4), linje(X, 20)], [[X, 19]]), X, 20, null],
      // LEDTID: U2-VS-DEADLINE och J13 före O1, som i registret.
      [ctxOf([linje(X, 4), linje(Z, 9)], [[Z, 2]]), Z, 9, tidig],
      [ctxOf([linje(Y, 5), linje(X, 9)]), X, 9, tidig],
      [ctxOf([linje(X, 4)]), X, 4, tidig],
      [ctxOf([linje(X, 4)]), X, 4, { accepted: false, klass: 'OKLASSAD', bevis: '' }],
    ];
    for (const [ctx, mmsi, dtMin, warnable] of fall) {
      const ledtid = !!warnable;
      const f = ledtid
        ? t2(mmsi, dtMin, 'LEDTID<60s', { varningsbarhet: warnable.klass })
        : t2(mmsi, dtMin);
      const e = explainT2({ mmsi, bridge: 'Klaffbron', t: T + dtMin * MIN }, data(ctx), { ledtid, warnable });
      const c = klassa(reg, f, ctx);
      expect([f.klass, mmsi, dtMin, e ? e.post : null]).toEqual([f.klass, mmsi, dtMin, c.post]);
    }
  });
});

// ---------------------------------------------------------------------------
// M05: D4 gäller bara riktningsbyten vars nya riktning är unknown
// ---------------------------------------------------------------------------

describe('M05 D4-RIKTNING-UNKNOWN: bara M-FAS-riktningsbyten till unknown', () => {
  const T = 1783000000000;
  const notis = {
    mmsi: '265552100', bridge: 'Klaffbron', direction: 'unknown', t: T,
  };
  const fas = (klass, belägg, riktning = 'unknown') => makeFinding({
    orakel: 'M-FAS',
    klass,
    allvar: 4,
    mmsi: '265552100',
    bro: 'Klaffbron',
    riktning,
    t: T,
    belägg,
    spår: 'bank',
    nivå: 'bank',
    ursprung: { korpus: '20260710-13h', relation: 'M-FAS', deltaS: [7] },
  });
  const ctx = { rader: [], resultat: { notifications: [] } };

  test('en tappad, tillagd eller förskjuten notis med riktningen unknown är KANDIDAT (granskarens regprobe)', () => {
    const reg = loadRegistry();
    expect(klassa(reg, fas('NOTISNYCKEL TAPPAD', { notis, par: null }), ctx).klass).toBe('KANDIDAT');
    expect(klassa(reg, fas('NOTISNYCKEL TILLAGD', { notis, par: null }), ctx).klass).toBe('KANDIDAT');
    expect(klassa(reg, fas('NOTISDRIFT>30s', { driftMs: 45000 }), ctx).klass).toBe('KANDIDAT');
  });

  test('ett riktningsbyte till unknown är DESIGN; ett byte till en bestämd riktning är det inte', () => {
    const reg = loadRegistry();
    const bas = { ...notis, direction: 'northbound' };
    expect(klassa(reg, fas('NOTISRIKTNING BYTT', { notis, par: { bas, variant: notis }, nyRiktning: 'unknown' }), ctx))
      .toMatchObject({ klass: 'DESIGN', post: 'D4-RIKTNING-UNKNOWN' });
    const kort = (direction) => ({
      bridge: 'Klaffbron', direction, leadMmsi: '265552100', t: T, mmsis: ['265552100'],
    });
    expect(klassa(reg, fas('ÖPPNINGSRIKTNING BYTT', { kort: kort('unknown'), par: { bas: kort('northbound'), variant: kort('unknown') }, nyRiktning: 'unknown' }), ctx))
      .toMatchObject({ klass: 'DESIGN', post: 'D4-RIKTNING-UNKNOWN' });
    const söder = { ...notis, direction: 'southbound' };
    expect(klassa(reg, fas('NOTISRIKTNING BYTT', { notis: söder, par: { bas, variant: söder }, nyRiktning: 'southbound' }, 'southbound'), ctx).klass)
      .toBe('KANDIDAT');
  });
});

// ---------------------------------------------------------------------------
// M12: poster som oraklen tillämpar själva (verkan iOraklet)
// ---------------------------------------------------------------------------

describe('M12: poster som oraklen tillämpar själva', () => {
  const FEM = ['DEADLINE-10KN-GARANTIPRIS', 'FALSKLARM-AVBRUTEN-GLES', 'KAJGRIND-UTAN-RÖRELSEBEVIS', 'U10-BN2-PASSERAD-FORM', 'UNDER-BRO-BANDET-70M'];
  const T0 = Date.parse('2026-07-01T10:00:00.000Z');

  test('de fem posterna har verkan iOraklet och en orakelvakt som pekar på koden; laddningen kräver vakten', () => {
    const reg = loadRegistry();
    expect(reg.iOraklet().map((e) => e.id).sort()).toEqual(FEM);
    // Sedan runda 2 (E5) pekar orakelvakten på en symbol (fil.js#namn), inte på rader.
    for (const e of reg.iOraklet()) expect(e.orakelvakt).toMatch(/tests\/replay-validation\/(bugHunt\/lib\/oracles\/\w+|runOpeningGates)\.js#\w+/);
    expect(reg.varningar).toEqual([]);
    const base = {
      id: 'X', klass: 'DESIGN', datum: '2026-11-04', källa: 'docs/VALIDATION.md', regel: 'r', gäller: { orakel: ['T1'], klassRegex: '.*' }, predikat: { namn: 'alltid', parametrar: {} },
    };
    expect(() => loadRegistry({ poster: [{ ...base, verkan: 'iOraklet' }] })).toThrow(/orakelvakt/);
    expect(() => loadRegistry({ poster: [{ ...base, verkan: 'iOraklet', orakelvakt: 'tests/replay-validation/bugHunt/lib/oracles/t1Notice.js#judgeT1' }] })).not.toThrow();
    // En post med verkan iOraklet matchar aldrig, inte ens med predikatet alltid.
    const r = loadRegistry({ poster: [{ ...base, verkan: 'iOraklet', orakelvakt: 'tests/replay-validation/bugHunt/lib/oracles/t1Notice.js#judgeT1' }] });
    expect(r.varningar).toEqual([]);
    expect(r.classify({ orakel: 'T1', klass: 'NOTIS-UTEBLIVEN' }, {}).klass).toBe('KANDIDAT');
  });

  test('de blir aldrig "närmast", står inte bland de prövade och räknas inte som oanvända', () => {
    const reg = loadRegistry();
    const fall = [
      ['T1', 'FÖRVARNINGSFORM-EFTER-PASSAGE', { notis: { alreadyPassed: false, eta: 3 }, korsningT: T0 }],
      ['T1', 'NOTIS-UTEBLIVEN', { tIn: T0, tOut: T0 + MIN, tFörstaFix: T0 }],
      ['T10', 'PASSAGE-EJ-REGISTRERAD', { korsningT: T0 }],
      ['T3', 'VARNING-PÅ-FRUSET-FIX', {}],
      ['T3', 'SEN:OFÖRKLARAD_TIDIGHET', {}],
      ['T3', 'FANTOM-UTAN-AVBROTT', { varning: { t: T0, mmsis: ['265000001'] } }],
    ];
    for (const [orakel, klass, belägg] of fall) {
      const c = klassa(reg, {
        orakel, klass, mmsi: '265000001', bro: 'Klaffbron', t: T0, belägg,
      }, { rader: [], resultat: { notifications: [] } });
      expect([klass, c.klass]).toEqual([klass, 'KANDIDAT']);
      expect(FEM).not.toContain(c.närmast && c.närmast.post);
      for (const p of c.prövade) expect(FEM).not.toContain(p.post);
    }
    const oanvända = reg.unused().map((u) => u.id);
    for (const id of FEM) {
      expect(oanvända).not.toContain(id);
      expect(reg.användning).not.toHaveProperty(id);
    }
  });

  test('rapporten redovisar dem för sig och räknar dem inte bland de oanvända posterna', () => {
    const report = require('../lib/report');
    const { clusterFindings } = require('../lib/cluster');
    const { getProfile } = require('../lib/profiles');
    const reg = loadRegistry();
    const f = makeFinding({
      orakel: 'T1',
      klass: 'NOTIS-UTEBLIVEN',
      allvar: 5,
      mmsi: '265000001',
      bro: 'Klaffbron',
      t: T0,
      spår: 'synth',
      nivå: 'R0',
      ursprung: { värld: 1 },
      register: { klass: 'KANDIDAT', post: null, närmast: null },
    });
    const körning = {
      motorversion: 'test',
      git: {
        före: {
          finns: false, sha: null, sha7: 'nogit', ändrat: null,
        },
      },
      profil: getProfile('quick'),
      seed: 1,
      spår: ['selftest'],
      korpusar: [],
      körningsId: 'abc',
      hälsa: { självtest: { status: 'GRÖNT', text: 'determinism 24/24' } },
      sammanfattning: ['rad 1', 'rad 2', 'rad 3'],
      kluster: clusterFindings([f]),
      register: reg,
      täckning: { rader: [] },
      tid: {},
    };
    const urval = report.assignCards(körning.kluster);
    const md = report.renderReportMd(körning, urval);
    const rad = md.split('\n').find((l) => l.startsWith('Oanvända poster ('));
    expect(rad).toMatch(new RegExp(`\\(\\d+ av ${reg.poster.length - FEM.length};`));
    for (const id of FEM) expect(rad).not.toContain(id);
    expect(md).toMatch(/Poster som oraklen tillämpar själva \(verkan iOraklet[^\n]*UNDER-BRO-BANDET-70M \(T1, T10\)/);
    const json = report.buildReportJson(körning, urval);
    expect(json.register.iOraklet.map((e) => e.id).sort()).toEqual(FEM);
    expect(json.register.oanvända.map((e) => e.id)).not.toContain('U10-BN2-PASSERAD-FORM');
  });
});

// ---------------------------------------------------------------------------
// T-1: INV-10:s granularitet (F18) är en mätgräns med smalt predikat
// ---------------------------------------------------------------------------

describe('T-1 MÄTGRÄNS-INV10-VÄNTKEDJA: angränsande väntintervall och en tick-svans', () => {
  const at = (hms) => Date.parse(`2026-08-04T${hms}Z`);
  const STRAX = 'En båt på väg mot Stridsbergsbron, beräknad broöppning strax';
  const INGA = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
  // F18 i första standardrapporten (värld 1228, R1): strax 08:49:44,879, "ETA okänd" 09:27:30,040.
  const resultat = (waits, nästa = '09:27:30.040') => ({
    bridgeTextTransitions: [
      ['08:45:00.040', INGA], ['08:49:44.879', STRAX], [nästa, 'En båt på väg mot Stridsbergsbron, ETA okänd'], ['09:29:50.523', INGA],
    ].map(([hms, text]) => ({ t: at(hms), iso: `2026-08-04T${hms}Z`, text })),
    confirmedTargetWaits: waits.map(([a, b]) => ({ bridge: 'Stridsbergsbron', from: at(a), until: at(b) })),
    targetPassages: [],
    notifications: [],
  });
  const domen = (waits) => {
    const res = resultat(waits);
    const f = existing.judgeExisting({ result: res, rows: [], gt: null }).fynd.find((x) => x.inv === 'INV-10');
    return { f, c: f ? klassa(loadRegistry(), f, { rader: [], resultat: res }) : null };
  };

  test('F18: två intervall med 13 s fixglapp och 26 s svans före övergången är MÄTGRÄNS', () => {
    const { f, c } = domen([['08:49:44.879', '08:59:44.854'], ['08:59:57.860', '09:27:04.278']]);
    expect(f.klass).toBe('INV-10 STRAX-ZOMBIE');
    expect(f.belägg.väntan).toMatchObject({ bro: 'Stridsbergsbron', från: at('08:49:44.879'), till: at('09:27:30.040') });
    expect(f.belägg.väntan.intervall).toHaveLength(2);
    expect(c).toMatchObject({ klass: 'MÄTGRÄNS', post: 'MÄTGRÄNS-INV10-VÄNTKEDJA' });
  });

  test('ett strax som står 5 min utan väntan omfattas inte (svans eller glapp)', () => {
    expect(domen([['08:49:44.879', '08:59:44.854'], ['08:59:57.860', '09:22:30.040']]).c.klass).toBe('KANDIDAT');
    expect(domen([['08:49:44.879', '08:59:44.854'], ['09:04:44.854', '09:27:20.040']]).c.klass).toBe('KANDIDAT');
  });

  test('gränsen är en tick: ett glapp utan halvminutstick och 30 s svans omfattas; ett glapp över ticken och 31 s svans gör det inte', () => {
    // 29 s glapp som slutar på ticken 09:00:00 (väntan bekräftad igen före tickens text) och 30 s svans.
    expect(domen([['08:49:44.879', '08:59:31.000'], ['09:00:00.000', '09:27:00.040']]).c.klass).toBe('MÄTGRÄNS');
    // Ett glapp på 30 s innehåller alltid en halvminutstick (runda 2, E2; förut MÄTGRÄNS).
    expect(domen([['08:49:44.879', '08:59:44.854'], ['09:00:14.854', '09:27:00.040']]).c.klass).toBe('KANDIDAT');
    expect(domen([['08:49:44.879', '08:59:44.854'], ['09:00:15.854', '09:27:20.040']]).c.klass).toBe('KANDIDAT');
    expect(domen([['08:49:44.879', '08:59:44.854'], ['08:59:57.860', '09:26:59.040']]).c.klass).toBe('KANDIDAT');
    // Ett enda intervall till övergången: INV-10 fäller inte alls.
    expect(domen([['08:49:44.879', '09:27:30.040']]).f).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T-3: S10-vakten (användargodkänd) för T1 NOTIS-UTEBLIVEN (F15)
// ---------------------------------------------------------------------------

describe('T-3 S10-VÄNDNING-BRON-BAKOM: zonens enda fixar går bort från bron efter en vändning', () => {
  // F15:s två representanter i första standardrapporten (värld 215 och 581).
  const HAVSORN = [
    [58.2758, 12.27934, 4.5, 25.1, 1786192026041], [58.27692, 12.28025, 4.6, 23.8, 1786192095820],
    [58.27798, 12.28088, 4.4, 19.5, 1786192164559], [58.27934, 12.28185, 4.6, 11.9, 1786192233448],
    [58.2813, 12.28271, 4.3, 14.8, 1786192302925], [58.28208, 12.28308, 3.6, 195.3, 1786192435835],
    [58.28057, 12.28246, 4.8, 199.9, 1786192503073], [58.27901, 12.2815, 5, 218.9, 1786192570972],
  ].map(([lat, lon, sog, cog, t]) => ({
    mmsi: '265245022', lat, lon, sog, cog, aisTimestamp: t,
  }));
  const MASEN = [
    [58.27103504735231, 12.273163581786593, 3.5, 45.8, 1789378883268], [58.28743339955223, 12.287003042870909, 2.2, 33.6, 1789380086515],
    [58.2897022216311, 12.289841031108827, 2.2, 216, 1789380376803], [58.2884860159511, 12.288249332674942, 3.6, 209.9, 1789380472949],
  ].map(([lat, lon, sog, cog, t]) => ({
    mmsi: '265684897', lat, lon, sog, cog, aisTimestamp: t,
  }));
  const besök = (mmsi, bro, tIn, tOut, tFörstaFix, extra = {}) => ({
    orakel: 'T1',
    klass: 'NOTIS-UTEBLIVEN',
    allvar: 5,
    mmsi,
    bro,
    riktning: null,
    t: tFörstaFix,
    belägg: {
      tIn, tOut, tFörstaFix, korsning: null, ...extra,
    },
  });
  const havsorn = (extra) => besök('265245022', 'Klaffbron', 1786192304000, 1786192444000, 1786192435835, extra);
  const ctx = (rader) => ({ rader, resultat: { notifications: [] } });
  const ändra = (rader, t, fält) => rader.map((r) => (r.aisTimestamp === t ? { ...r, ...fält } : r));

  test('F15: vändningen 230 m före Klaffbron och 250 m före Järnvägsbron är DESIGN via S10', () => {
    const reg = loadRegistry();
    expect(klassa(reg, havsorn(), ctx(HAVSORN))).toMatchObject({ klass: 'DESIGN', post: 'S10-VÄNDNING-BRON-BAKOM' });
    const masen = besök('265684897', 'Järnvägsbron', 1789380293000, 1789380405000, 1789380376803);
    expect(klassa(reg, masen, ctx(MASEN))).toMatchObject({ klass: 'DESIGN', post: 'S10-VÄNDNING-BRON-BAKOM' });
  });

  test('utan vändning, med långsam fix, med korsning eller med en sen andra zonfix är det KANDIDAT', () => {
    const reg = loadRegistry();
    // Ingen vändning: fixen före besöket går redan söderut.
    expect(klassa(reg, havsorn(), ctx(ändra(HAVSORN, 1786192302925, { cog: 190 }))).klass).toBe('KANDIDAT');
    // Fart under MIN_VIABLE_SPEED (0,5 kn): kursen är brus.
    expect(klassa(reg, havsorn(), ctx(ändra(HAVSORN, 1786192435835, { sog: 0.3 }))).klass).toBe('KANDIDAT');
    // Båten korsade bron i besöket: ingen vändning före bron.
    expect(klassa(reg, havsorn({ korsning: { t: '2026-08-08T12:33:00.000Z', dir: 'nord' }, korsningT: 1786192380000 }), ctx(HAVSORN)).klass).toBe('KANDIDAT');
    // En andra fix inom radien 16 min efter den första: Fix D:s pending-flagga är inte längre färsk.
    const sen = { ...HAVSORN[5], aisTimestamp: HAVSORN[5].aisTimestamp + 16 * MIN };
    const långt = havsorn({ tOut: sen.aisTimestamp });
    expect(klassa(reg, långt, ctx([...HAVSORN, sen].sort((a, b) => a.aisTimestamp - b.aisTimestamp))).klass).toBe('KANDIDAT');
    // En zonfix som går mot bron igen.
    const mot = { ...HAVSORN[5], aisTimestamp: HAVSORN[5].aisTimestamp + 30000, cog: 20 };
    expect(klassa(reg, havsorn(), ctx([...HAVSORN, mot].sort((a, b) => a.aisTimestamp - b.aisTimestamp))).klass).toBe('KANDIDAT');
  });
});
