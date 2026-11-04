'use strict';

/**
 * Runda 2 av motorrättningen 2026-11-04, rättare E: beslutsregistret (E1
 * S10-predikatet mot Fix D:s fartgräns, E2 väntkedjans halvminutstick, E3
 * KIE-PER-KORPUS-fönstret, E5 orakelvakternas symbolhänvisningar, E7
 * taggposter och INV-F) och hunt:repro för M-FAS-kort (E4). Varje
 * describe-block har fall som den gamla motorn (ögonblicksbilden efter runda
 * 1) fäller, och vakter som ska hålla i båda. Inga barnprocesser och inga
 * timers; hunt:repro körs med en injicerad pool.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MIN = 60000;
const REPO = path.join(__dirname, '..', '..', '..', '..');
const corpora = require(path.join('..', '..', 'corpora'));
const { loadRegistry } = require('../lib/registry');
const { makeFinding } = require('../lib/finding');
const existing = require('../lib/oracles/existing');

const klassa = (reg, f, ctx) => reg.classify(f, ctx, { räkna: false });
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------
// E1: S10-VÄNDNING-BRON-BAKOM följer appens S10-vakt och Fix D:s fartgräns
// ---------------------------------------------------------------------------

describe('E1 S10-VÄNDNING-BRON-BAKOM: Fix D:s fartgräns och den bekräftande zonfixen', () => {
  const rad = (mmsi) => ([lat, lon, sog, cog, t]) => ({
    mmsi, lat, lon, sog, cog, aisTimestamp: t,
  });
  // F15:s tre världar i standardkörningen (seed 1): raderna kring besöket ur
  // core.materialize(sampleWorld(1, i)) med standardprofilens radio. Zonens
  // enda fix har 3,6, 2,2 respektive 2,4 kn.
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
  /** S10-postens skäl bland de prövade posterna (närmast är den första prövade T1-posten). */
  const s10skäl = (c) => (c.prövade.find((p) => p.post === 'S10-VÄNDNING-BRON-BAKOM') || {}).skäl;
  /**
   * Extra zonfixar som granskarens s10two: interpolerade mellan zonfixen och
   * nästa fix (andelen fr av vägen), med zonfixens kurs och farten sog.
   */
  const mellan = (rader, tA, tB, fracs, sog) => {
    const a = rader.find((r) => r.aisTimestamp === tA);
    const b = rader.find((r) => r.aisTimestamp === tB);
    const extra = fracs.map((fr) => ({
      ...a,
      lat: a.lat + fr * (b.lat - a.lat),
      lon: a.lon + fr * (b.lon - a.lon),
      sog: sog === undefined ? a.sog : sog,
      aisTimestamp: Math.round(a.aisTimestamp + fr * (b.aisTimestamp - a.aisTimestamp)),
    }));
    return [...rader, ...extra].sort((x, y) => x.aisTimestamp - y.aisTimestamp);
  };

  test('FIX_D_MIN_SOG läses ur appens källtext (VesselDataService.js), inte hårdkodat', () => {
    const registry = require('../lib/registry');
    const text = fs.readFileSync(path.join(REPO, 'lib', 'services', 'VesselDataService.js'), 'utf8');
    const m = /\bconst FIX_D_MIN_SOG = (\d+(?:\.\d+)?);/.exec(text);
    expect(m).not.toBeNull();
    expect(registry.PREDICATES.reversalAwayFromBridge.parametrar.fixDMinSogKn).toBe(Number(m[1]));
    expect(registry.appKonstant('lib/services/VesselDataService.js', 'FIX_D_MIN_SOG')).toBe(Number(m[1]));
    // En konstant som saknas (eller står flera gånger) blir null, aldrig en gissning.
    expect(registry.appKonstant('lib/services/VesselDataService.js', 'FINNS_INTE_I_APPEN')).toBeNull();
    expect(registry.appKonstant('lib/finns-inte.js', 'FIX_D_MIN_SOG')).toBeNull();
  });

  test('F15:s tre världar (en zonfix på 3,6, 2,2 och 2,4 kn) är kvar som DESIGN', () => {
    const reg = loadRegistry();
    for (const v of [V215, V581, V1818]) {
      expect([v.mmsi, klassa(reg, besök(v), ctx(v.rader))]).toEqual([v.mmsi, expect.objectContaining({ klass: 'DESIGN', post: 'S10-VÄNDNING-BRON-BAKOM' })]);
    }
  });

  test('en zonfix under FIX_D_MIN_SOG ger KANDIDAT: appen notifierar då (granskarens s10sog, 0,6/1,0/1,9 kn)', () => {
    const reg = loadRegistry();
    for (const sog of [0.6, 1.0, 1.9]) {
      const c = klassa(reg, besök(V581), ctx(sätt(V581.rader, V581.tFörstaFix, { sog })));
      expect([sog, c.klass]).toEqual([sog, 'KANDIDAT']);
      expect(s10skäl(c)).toMatch(/< FIX_D_MIN_SOG 2 kn\): Fix D sätter ingen pending-flagga/);
    }
    // Samma i den nordvända stressvärlden 1818 (zonfix 2,4 → 1,9 kn).
    expect(klassa(reg, besök(V1818), ctx(sätt(V1818.rader, V1818.tFörstaFix, { sog: 1.9 }))).klass).toBe('KANDIDAT');
    // 2,2 kn sätter flaggan: vakten avstår (appen notifierar inte).
    expect(klassa(reg, besök(V581), ctx(sätt(V581.rader, V581.tFörstaFix, { sog: 2.2 }))).klass).toBe('DESIGN');
  });

  test('två zonfixar på 2,2 kn ger KANDIDAT: den andra bekräftar reversalen och notisen går ut (granskarens s10two)', () => {
    const reg = loadRegistry();
    const [, , zon, nästa] = V581.rader;
    const en = mellan(V581.rader, zon.aisTimestamp, nästa.aisTimestamp, [0.2]);
    const två = mellan(V581.rader, zon.aisTimestamp, nästa.aisTimestamp, [0.15, 0.3]);
    for (const rader of [en, två]) {
      const c = klassa(reg, besök(V581), ctx(rader));
      expect(c.klass).toBe('KANDIDAT');
      expect(s10skäl(c)).toMatch(/≥ FIX_D_MIN_SOG 2 kn, söderut\) inom 15 min bekräftar reversalen/);
    }
  });

  test('en senare zonfix under FIX_D_MIN_SOG bekräftar inte (DESIGN); under MIN_VIABLE_SPEED avstår vakten inte (KANDIDAT)', () => {
    const reg = loadRegistry();
    const [, , zon, nästa] = V581.rader;
    // Appen med en extra zonfix 10:06:36 på 1,5 kn: ingen notis (vakten avstår igen).
    const c = klassa(reg, besök(V581), ctx(mellan(V581.rader, zon.aisTimestamp, nästa.aisTimestamp, [0.2], 1.5)));
    expect(c).toMatchObject({ klass: 'DESIGN', post: 'S10-VÄNDNING-BRON-BAKOM' });
    expect(c.skäl).toMatch(/1 senare zonfix\(ar\) under 2 kn bekräftar inte reversalen/);
    // På 0,4 kn är kursen brus för vakten, och appen notifierar 10:06:36.
    expect(klassa(reg, besök(V581), ctx(mellan(V581.rader, zon.aisTimestamp, nästa.aisTimestamp, [0.2], 0.4))).klass).toBe('KANDIDAT');
  });
});

// ---------------------------------------------------------------------------
// E2: inget glapp i väntkedjan får innehålla en halvminutstick
// ---------------------------------------------------------------------------

describe('E2 MÄTGRÄNS-INV10-VÄNTKEDJA: inget glapp över en halvminutstick', () => {
  const at = (hms) => Date.parse(`2026-08-04T${hms}Z`);
  const STRAX = 'En båt på väg mot Stridsbergsbron, beräknad broöppning strax';
  const INGA = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
  // Värld 1228 (F18): strax 08:49:44,879, "ETA okänd" 09:27:30,040.
  const resultat = (waits) => ({
    bridgeTextTransitions: [
      ['08:45:00.040', INGA], ['08:49:44.879', STRAX], ['09:27:30.040', 'En båt på väg mot Stridsbergsbron, ETA okänd'], ['09:29:50.523', INGA],
    ].map(([hms, text]) => ({ t: at(hms), iso: `2026-08-04T${hms}Z`, text })),
    confirmedTargetWaits: waits.map(([a, b]) => ({ bridge: 'Stridsbergsbron', from: at(a), until: at(b) })),
    targetPassages: [],
    notifications: [],
  });
  const domen = (waits) => {
    const res = resultat(waits);
    const f = existing.judgeExisting({ result: res, rows: [], gt: null }).fynd.find((x) => x.inv === 'INV-10');
    return klassa(loadRegistry(), f, { rader: [], resultat: res });
  };

  test('ett glapp på 25 s över ticken 09:00:00 ger KANDIDAT (granskarens inv10tick-b)', () => {
    const c = domen([['08:49:44.879', '08:59:44.854'], ['09:00:09.854', '09:27:04.278']]);
    expect(c.klass).toBe('KANDIDAT');
    expect(c.närmast).toMatchObject({ post: 'MÄTGRÄNS-INV10-VÄNTKEDJA' });
    expect(c.närmast.skäl).toMatch(/glappet 08:59:44–09:00:09 .*innehåller halvminutsticken 09:00:00/);
    // Sondens fall: fixen flyttad till 09:00:10, ny väntan från 09:00:10,025.
    expect(domen([['08:49:44.879', '08:59:44.854'], ['09:00:10.025', '09:27:04.278']]).klass).toBe('KANDIDAT');
    // Ett glapp som börjar inne i tickens mikrograce (09:00:00,000–,040) har också ticken.
    expect(domen([['08:49:44.879', '09:00:00.020'], ['09:00:25.000', '09:27:04.278']]).klass).toBe('KANDIDAT');
  });

  test('värld 1228 (F18, glappet 08:59:44,854–08:59:57,860 utan tick) är kvar som MÄTGRÄNS, och svansen på 30 s behålls', () => {
    expect(domen([['08:49:44.879', '08:59:44.854'], ['08:59:57.860', '09:27:04.278']])).toMatchObject({ klass: 'MÄTGRÄNS', post: 'MÄTGRÄNS-INV10-VÄNTKEDJA' });
    // 29 s glapp utan tick och 30 s svans.
    expect(domen([['08:49:44.879', '08:59:31.000'], ['08:59:59.990', '09:27:00.040']]).klass).toBe('MÄTGRÄNS');
  });

  test('halvminutsticken räknas på absoluta halvminuter med textgenereringens mikrograce', () => {
    const { halvminutstickInne } = require('../lib/registry');
    const T = at('09:00:00.000');
    expect(halvminutstickInne(at('08:59:44.854'), at('08:59:57.860'), 30000, 40)).toBeNull();
    expect(halvminutstickInne(at('08:59:44.854'), at('09:00:09.854'), 30000, 40)).toBe(T);
    expect(halvminutstickInne(at('09:00:00.020'), at('09:00:25.000'), 30000, 40)).toBe(T);
    expect(halvminutstickInne(at('09:00:00.050'), at('09:00:25.000'), 30000, 40)).toBeNull();
    expect(halvminutstickInne(at('08:59:59.950'), at('09:00:00.000'), 30000, 40)).toBeNull();
    expect(halvminutstickInne(at('09:00:05.000'), at('09:00:01.000'), 30000, 40)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E3: KIE-PER-KORPUS — utslagets egen längd vidgar aldrig fönstret
// ---------------------------------------------------------------------------

describe('E3 KIE-PER-KORPUS: DEFAULT-FLASH jämförs start mot start, |δ| + en tick', () => {
  const k42 = corpora.find((c) => c.id === '20260806-42h');
  const k41 = corpora.find((c) => c.id === '20260713-41h');
  const flash = (hms, s) => `DEFAULT-FLASH: 2026-08-06T${hms}Z "Inga båtar" inklämd (${s}s) mellan två "En … Stridsbergsbron"-texter utan passage`;
  /** Ett nytt fatalt utslag i en fasvariant, som relations.comparePhase bygger det. */
  const fasFynd = (msg, deltaS, korpus = '20260806-42h', syskon = [msg]) => {
    const f = existing.fromInvariant(msg, 'INV-F');
    return makeFinding({
      ...f,
      t: f.t - deltaS * 1000,
      belägg: {
        ...f.belägg, meddelanden: [msg], syskon, ny: true, tidsram: 'variant',
      },
      spår: 'bank',
      nivå: 'bank',
      ursprung: { korpus, relation: 'M-FAS', deltaS: [deltaS] },
      taggar: ['KNIVSEGG'],
    });
  };
  const ctx42 = { korpus: k42, rader: [], resultat: {} };

  test('42h-flashen är ACCEPTERAD vid δ −20, −11,52, −7, +7 och +15 s (acceptanskriteriet)', () => {
    const reg = loadRegistry();
    const varianter = [[-20, '08:46:30.040', 59], [-11.52, '08:46:30.040', 60], [-7, '08:46:30.040', 60], [7, '08:47:00.040', 56], [15, '08:47:00.040', 60]];
    for (const [d, hms, s] of varianter) {
      expect([d, klassa(reg, fasFynd(flash(hms, s), d), ctx42)]).toEqual([d, expect.objectContaining({ klass: 'ACCEPTERAD', post: 'KIE-PER-KORPUS' })]);
    }
  });

  test('en lång separat flash ger KANDIDAT, även utan den kända flashen som syskon (granskarens kiewindow2)', () => {
    const reg = loadRegistry();
    for (const [min, s] of [[4, 240], [5, 290], [5.5, 300]]) {
      const iso = new Date(Date.parse('2026-08-06T08:47:00.040Z') + min * MIN).toISOString();
      const c = klassa(reg, fasFynd(flash(iso.slice(11, 23), s), 7), ctx42);
      expect([min, c.klass]).toEqual([min, 'KANDIDAT']);
      expect(c.närmast.skäl).toMatch(/utanför \|δ\| 7 s \+ en tick 30 s \(en annan episod\)/);
    }
  });

  test('gränsen för DEFAULT-FLASH är |δ| + en tick: vid δ +7 s är 37 s isär samma episod, 38 s inte', () => {
    const reg = loadRegistry();
    expect(klassa(reg, fasFynd(flash('08:47:37.040', 60), 7), ctx42).klass).toBe('ACCEPTERAD');
    expect(klassa(reg, fasFynd(flash('08:47:38.040', 60), 7), ctx42).klass).toBe('KANDIDAT');
    expect(klassa(reg, fasFynd(flash('08:47:38.040', 30), 7), ctx42).klass).toBe('KANDIDAT');
  });

  test('för klasser vars tid är episodens slut gäller bara undantagets längd, aldrig utslagets', () => {
    const reg = loadRegistry();
    const ctx41 = { korpus: k41, rader: [], resultat: {} };
    // 41h:s undantag saknar längd: en sågtand 100 s efter undantaget, "på 300s", är en annan episod.
    expect(klassa(reg, fasFynd('ETA-SÅGTAND UPP: 2026-07-15T08:50:31.405Z Stridsbergsbron 8→14 på 300s', 7, '20260713-41h'), ctx41).klass).toBe('KANDIDAT');
    expect(klassa(reg, fasFynd('ETA-SÅGTAND UPP: 2026-07-15T08:48:58.405Z Stridsbergsbron 8→14 på 61s', 7, '20260713-41h'), ctx41).klass).toBe('ACCEPTERAD');
    // Ett undantag med längd ("på 90s") vidgar fönstret till |δ| + 90 s + en tick.
    const kL = { id: 'x', knownInvariantExceptions: ['ETA-SÅGTAND UPP: 2026-07-15T08:48:51.405Z Stridsbergsbron 8→14 på 90s'] };
    const c = klassa(reg, fasFynd('ETA-SÅGTAND UPP: 2026-07-15T08:50:31.405Z Stridsbergsbron 8→14 på 95s', 7, 'x'), { korpus: kL, rader: [], resultat: {} });
    expect(c).toMatchObject({ klass: 'ACCEPTERAD', post: 'KIE-PER-KORPUS' });
    expect(c.skäl).toMatch(/≤ \|δ\| 7 s \+ undantagets längd 90 s \+ en tick 30 s/);
    const { episodLängdMs } = require('../lib/registry');
    expect(episodLängdMs(flash('08:47:00.040', 30))).toBe(0);
    expect(episodLängdMs('ETA-SÅGTAND UPP: 2026-07-15T08:48:51.405Z Stridsbergsbron 8→14 på 92s')).toBe(92000);
    expect(episodLängdMs('ETA-OSCILLATION: 2026-07-15T08:50:22.118Z Stridsbergsbron 8→14→9 inom 181s')).toBe(181000);
  });
});

// ---------------------------------------------------------------------------
// E4: hunt:repro för M-FAS-kort räknar bara kortets registerutfall som KVAR
// ---------------------------------------------------------------------------

describe('E4 hunt:repro för M-FAS-kort: KVAR bara för utslag med kortets registerutfall', () => {
  const at = (hms) => Date.parse(`2026-08-06T${hms}Z`);
  const INGA = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
  const en = (m) => `En båt på väg mot Stridsbergsbron, beräknad broöppning om ${m} minuter`;
  const MEK = 'INV-F|INV-14 DEFAULT-FLASH';
  const TOMT = Object.freeze({
    notifications: [],
    openingWarnings: [],
    openingCoverage: [],
    openingSuppressions: [],
    openingServiceFires: 0,
    targetPassages: [],
    intermediatePassages: [],
    bridgeTextTransitions: [],
    journeyResets: [],
    visitReentries: [],
    confirmedTargetWaits: [],
    processErrors: 0,
  });
  const varianten = (texter) => ({
    ...clone(TOMT),
    bridgeTextTransitions: texter.map(([hms, text]) => ({ t: at(hms), iso: `2026-08-06T${hms}Z`, text })),
  });
  // Variantens flash (δ +7 s) på samma tid som 42h:s undantag, 56 s lång.
  const KÄND = [['08:40:00.040', en(9)], ['08:47:00.040', INGA], ['08:47:56.040', en(8)]];
  const NY = [['09:31:00.040', INGA], ['09:32:00.040', en(7)], ['09:40:00.040', INGA]];

  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-e4-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Ett bankkort som report.writeCardDir skriver det (fynd.json, recept.json, bas och variant). */
  function kort(namn, fyndJson) {
    const dir = path.join(tmp, namn);
    fs.mkdirSync(dir);
    const k42 = corpora.find((c) => c.id === '20260806-42h');
    fs.writeFileSync(path.join(dir, 'bas.jsonl'), fs.readFileSync(k42.jsonl));
    fs.writeFileSync(path.join(dir, 'variant.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'recept.json'), `${JSON.stringify({
      korpus: '20260806-42h', relation: 'M-FAS', deltaS: 7, monitoring: false,
    })}\n`);
    fs.writeFileSync(path.join(dir, 'fynd.json'), `${JSON.stringify(fyndJson)}\n`);
    return dir;
  }

  /** Poolen ersätts: basen svarar med ett tomt resultat, varianten med V. */
  function fakePool(V) {
    return {
      jobb: 1,
      statistik: {},
      async run(job) {
        const resultat = job.etikett === 'variant' ? V : TOMT;
        return {
          etikett: job.etikett,
          jsonl: job.jsonl,
          ok: true,
          häng: false,
          fatal: null,
          fel: null,
          försök: [],
          ms: 1,
          rader: job.rader || 0,
          simTimmar: job.simTimmar || 1,
          resultat: clone(resultat),
          stderr: {
            h3: {}, övrigt: {}, rader: 0, exempel: {},
          },
        };
      },
      runAll(jobs) {
        return Promise.all(jobs.map((j) => this.run(j)));
      },
    };
  }

  async function repro(dir, V) {
    const lanes = require('../lib/lanes');
    const rader = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...a) => rader.push(a.join(' ')));
    try {
      const code = await lanes.getLane('bank').repro(dir, { pool: fakePool(V), register: loadRegistry() });
      return { code, text: rader.join('\n') };
    } finally {
      log.mockRestore();
    }
  }

  test('bara en ACCEPTERAD träff kvar ger BORTA, med träffen som information (granskarens fakebankcard)', async () => {
    const dir = kort('fake-mfas-42h', { mekanism: MEK, nyckel: `KANDIDAT|-|${MEK}`, fynd: [] });
    const { code, text } = await repro(dir, varianten(KÄND));
    expect(code).toBe(0);
    expect(text).toMatch(/utfall mot aktuell HEAD: BORTA \(0 utslag av mekanismen med registerutfallet KANDIDAT; 1 med annat registerutfall, som information — ACCEPTERAD KIE-PER-KORPUS 1;/);
    expect(text).toMatch(/- INV-F INV-14 DEFAULT-FLASH \[ACCEPTERAD KIE-PER-KORPUS\]: DEFAULT-FLASH: 2026-08-06T08:47:00\.040Z/);
  });

  test('en träff med kortets registerutfall (KANDIDAT) ger KVAR; den accepterade visas som information', async () => {
    const dir = kort('fake-mfas-42h-ny', { mekanism: MEK, nyckel: `KANDIDAT|-|${MEK}`, fynd: [] });
    const { code, text } = await repro(dir, varianten([...KÄND, ...NY]));
    expect(code).toBe(0);
    expect(text).toMatch(new RegExp('utfall mot aktuell HEAD: KVAR \\(1 utslag av mekanismen med registerutfallet KANDIDAT; '
      + '1 med annat registerutfall, som information — ACCEPTERAD KIE-PER-KORPUS 1; 2 utslag i varianten\\)'));
    expect(text).toMatch(/- INV-F INV-14 DEFAULT-FLASH \[KANDIDAT\]: DEFAULT-FLASH: 2026-08-06T09:31:00\.040Z/);
  });

  test('kortets registerutfall läses ur nyckeln i fynd.json; utan nyckel och sparade fynd: KAN INTE DÖMAS (exit 2)', async () => {
    const { kortetsRegisterutfall } = require('../lib/lanes');
    expect(kortetsRegisterutfall({ mekanism: MEK, nyckel: `KANDIDAT|-|${MEK}` })).toEqual({ klass: 'KANDIDAT', post: null });
    expect(kortetsRegisterutfall({ mekanism: 'M-FAS|ÖPPNINGSKORT BYTT', nyckel: 'KÄND_ÖPPEN|K20-FASKÄNSLIG-LEDARE|M-FAS|ÖPPNINGSKORT BYTT' }))
      .toEqual({ klass: 'KÄND_ÖPPEN', post: 'K20-FASKÄNSLIG-LEDARE' });
    // En nyckel för en annan mekanism: de sparade fyndens registerutfall gäller.
    expect(kortetsRegisterutfall({ mekanism: MEK, nyckel: 'KANDIDAT|-|M-FAS|NOTISNYCKEL TAPPAD', fynd: [{ register: { klass: 'KANDIDAT', post: null } }] }))
      .toEqual({ klass: 'KANDIDAT', post: null });
    const dir = kort('utan-nyckel', { mekanism: MEK, fynd: [] });
    const { code, text } = await repro(dir, varianten(KÄND));
    expect(code).toBe(2);
    expect(text).toMatch(/KAN INTE DÖMAS för INV-F\|INV-14 DEFAULT-FLASH — fynd\.json saknar kortets registerutfall/);
    expect(text).not.toMatch(/KVAR|BORTA/);
  });
});

// ---------------------------------------------------------------------------
// E5: orakelvakterna pekar på symboler, och laddningen kontrollerar dem
// ---------------------------------------------------------------------------

describe('E5 orakelvakterna pekar på funktionsnamn som laddningen kontrollerar', () => {
  const base = {
    id: 'X',
    klass: 'DESIGN',
    datum: '2026-11-04',
    källa: 'docs/VALIDATION.md',
    regel: 'r',
    gäller: { orakel: ['T1'], klassRegex: '.*' },
    predikat: { namn: 'alltid', parametrar: {} },
    verkan: 'iOraklet',
  };
  const T10 = 'tests/replay-validation/bugHunt/lib/oracles/t10Passage.js';

  test('registrets orakelvakter pekar på symboler som definieras i filerna, aldrig på rader i motorns egna filer', () => {
    const registry = require('../lib/registry');
    const reg = loadRegistry();
    expect(reg.varningar).toEqual([]);
    expect(reg.iOraklet()).toHaveLength(5);
    for (const e of reg.iOraklet()) {
      const refs = registry.sourceRefs(e.orakelvakt);
      expect(refs.length).toBeGreaterThan(0);
      for (const r of refs) {
        expect([e.id, r.fil, r.rader]).toEqual([e.id, r.fil, null]);
        expect([e.id, r.symbol]).toEqual([e.id, expect.stringMatching(/^[A-Za-z_$][\w$]*$/)]);
        expect([e.id, r.symbol, registry.definesSymbol(fs.readFileSync(path.join(REPO, r.fil), 'utf8'), r.symbol)]).toEqual([e.id, r.symbol, true]);
      }
    }
    // Granskarens fall: 70 m-vakten i T10 är decisiveFixAfter.
    expect(reg.iOraklet().find((e) => e.id === 'UNDER-BRO-BANDET-70M').orakelvakt).toContain(`${T10}#decisiveFixAfter`);
  });

  test('laddningen varnar när en citerad symbol saknas och när en motorfil citeras med rader', () => {
    const varningar = (orakelvakt) => loadRegistry({ poster: [{ ...base, orakelvakt }] }).varningar;
    expect(varningar(`${T10}#decisiveFixAfter (beslutsam fix)`)).toEqual([]);
    expect(varningar(`${T10}#finnsInteAlls (beslutsam fix)`)).toEqual([`X: orakelvaktens fil ${T10} definierar inte finnsInteAlls`]);
    // Förra registrets hänvisning (t10Passage.js:57–60 var efter en ändring i filhuvudet JSDoc).
    const förra = varningar('tests/replay-validation/bugHunt/lib/oracles/t1Notice.js:250–253 (FÖRVARNINGSFORM-EFTER-PASSAGE); '
      + `${T10}:57–60 (PASSAGE-EJ-REGISTRERAD)`);
    expect(förra).toHaveLength(2);
    for (const v of förra) expect(v).toMatch(/citeras med rader \([\d–]+\); peka på en symbol i motorns egen fil/);
    // Harnessens och appens filer får citeras med rader.
    expect(varningar('tests/replay-validation/runOpeningGates.js:1066–1067 (AVBRUTEN_APPROACH)')).toEqual([]);
    // Källan kontrolleras på samma sätt.
    expect(loadRegistry({ poster: [{ ...base, verkan: undefined, källa: 'tests/replay-validation/bugHunt/lib/registry.js#finnsInte' }] }).varningar)
      .toEqual(['X: källfilen tests/replay-validation/bugHunt/lib/registry.js definierar inte finnsInte']);
  });

  test('en symbol definieras av en funktion, en deklaration, en metod eller en egenskap, inte av ett omnämnande', () => {
    const { definesSymbol } = require('../lib/registry');
    const text = [
      'function judgeT1(ctx) {', '  const judgePhantom = (p) => p;', '  tick() {', '  stressDensity: {', '// omnämnd: decisiveFixAfter', 'anrop(decisiveFixAfter);', 'judgeT2();',
    ].join('\n');
    for (const s of ['judgeT1', 'judgePhantom', 'tick', 'stressDensity']) expect([s, definesSymbol(text, s)]).toEqual([s, true]);
    for (const s of ['decisiveFixAfter', 'judgeT2', 'anrop', 'judge']) expect([s, definesSymbol(text, s)]).toEqual([s, false]);
  });
});

// ---------------------------------------------------------------------------
// E7: en taggpost med orakel '*' når INV-F-fynd; säkerhetsregeln står kvar
// ---------------------------------------------------------------------------

describe('E7 taggposter når INV-F-fynd; omklassande poster kräver INV-id', () => {
  const sågtand = () => existing.fromInvariant('ETA-SÅGTAND UPP: 2026-07-08T09:42:15.000Z Stridsbergsbron 1→8 på 35s', 'INV-F');
  const base = {
    klass: 'DESIGN', datum: '2026-11-04', källa: 'docs/VALIDATION.md', regel: 'r', predikat: { namn: 'alltid', parametrar: {} },
  };

  test('STRESS-TÄTHET taggar stressvärldens INV-F-fynd, och klassningen fortsätter', () => {
    const reg = loadRegistry();
    const stress = reg.classify(sågtand(), { täthet: { stress: true }, rader: [], resultat: {} });
    expect(stress.klass).toBe('KANDIDAT');
    expect(stress.taggar).toEqual(['STRESS-TÄTHET']);
    expect(stress.närmast).toMatchObject({ post: 'KIE-PER-KORPUS' });
    expect(reg.användning['STRESS-TÄTHET']).toBe(1);
    // Även ett INV-F-fynd som en annan post prövar (INV-10) får taggen.
    const inv10 = existing.fromInvariant('STRAX-ZOMBIE: 2026-08-04T08:49:44.879Z "En båt på väg mot Stridsbergsbron, beräknad broöppning strax" stod 38 min utan Stridsbergsbron-passage', 'INV-F');
    expect(klassa(reg, inv10, { täthet: { stress: true } }).taggar).toEqual(['STRESS-TÄTHET']);
    // En uppmätt realistisk värld taggas inte.
    expect(klassa(reg, sågtand(), { täthet: { stress: false } }).taggar).toEqual([]);
  });

  test('säkerhetsregeln: en omklassande post med orakel * men utan INV-id når aldrig ett INV-F-fynd', () => {
    const r = loadRegistry({ poster: [{ ...base, id: 'ALLA', gäller: { orakel: ['*'], klassRegex: '.*' } }] });
    const c = klassa(r, sågtand(), {});
    expect(c.klass).toBe('KANDIDAT');
    expect(klassa(r, { orakel: 'T1', klass: 'NOTIS-UTEBLIVEN' }, {})).toMatchObject({ klass: 'DESIGN', post: 'ALLA' });
    // Laddningen kräver fortfarande INV-id för en post som namnger INV-F.
    expect(() => loadRegistry({ poster: [{ ...base, id: 'F', gäller: { orakel: ['INV-F'], klassRegex: '.*' } }] })).toThrow(/namnge INV-id/);
  });

  test('en taggpost med inv-lista når bara de namngivna INV-id:n', () => {
    const r = loadRegistry({
      poster: [{
        ...base, id: 'INV10-TAGG', klass: 'MÄTGRÄNS', verkan: 'tagg', gäller: { orakel: ['*'], inv: ['INV-10'], klassRegex: '.*' },
      }],
    });
    expect(klassa(r, sågtand(), {}).taggar).toEqual([]);
    const inv10 = existing.fromInvariant('STRAX-ZOMBIE: 2026-08-04T08:49:44.879Z "En båt på väg mot Stridsbergsbron, beräknad broöppning strax" stod 38 min utan Stridsbergsbron-passage', 'INV-F');
    expect(klassa(r, inv10, {})).toMatchObject({ klass: 'KANDIDAT', taggar: ['INV10-TAGG'] });
  });
});
