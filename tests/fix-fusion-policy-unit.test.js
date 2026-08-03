'use strict';

const {
  createState, createClockState, observeClock,
  normalizeFixTs, shouldAccept, applyAccept, pruneStates,
} = require('../lib/connection/FixFusionPolicy');
const { AIS_CONFIG } = require('../lib/constants');

/**
 * Etapp 1 (2026-08-02): FixFusionPolicy F1-F5. Det KRITISKA fallet (V1-C3/
 * V2-C4): en aisstream-fix med mottagningstid ('receipt') får ALDRIG avvisa
 * en AISHub-fix med äkta fixtid ('true-fix') och vice versa — F1:s monotona
 * spärr är därför PER KÄLLA, och korskälle-dedup (F2) sker på INNEHÅLL.
 */

const CFG = AIS_CONFIG.FUSION;
const NOW = 1754136000000; // 2026-08-02T12:00:00Z

function msg(overrides = {}) {
  return {
    mmsi: '265001111',
    lat: 58.29,
    lon: 12.29,
    sog: 5,
    cog: 25,
    fixTs: NOW,
    fixFeed: 'aisstream',
    ...overrides,
  };
}

describe('F3/F4a: normalizeFixTs', () => {
  test('F3: saknad fixTs → mottagningstid (now)', () => {
    const m = msg({ fixTs: undefined });
    expect(normalizeFixTs(m, NOW, CFG)).toBe(NOW);
  });

  test('F4a: fix > 120 s i framtiden klampas till now + clockSkew-flagga (GO-kriteriemätaren)', () => {
    const m = msg({ fixTs: NOW + 300000 });
    expect(normalizeFixTs(m, NOW, CFG)).toBe(NOW);
    expect(m.clockSkew).toBe(true);
  });

  test('F4a: fix 60 s i framtiden (inom klampen) släpps orörd', () => {
    const m = msg({ fixTs: NOW + 60000 });
    expect(normalizeFixTs(m, NOW, CFG)).toBe(NOW + 60000);
    expect(m.clockSkew).toBeUndefined();
  });
});

describe('F4b: åldersgrinden', () => {
  test('fix äldre än MAX_FIX_AGE_MS avvisas', () => {
    const state = createState();
    const res = shouldAccept(state, msg({ fixTs: NOW - CFG.MAX_FIX_AGE_MS - 1000 }), NOW, CFG);
    expect(res).toEqual({ accept: false, reason: 'fix_too_old' });
  });

  test('fix precis inom gränsen accepteras', () => {
    const state = createState();
    const res = shouldAccept(state, msg({ fixTs: NOW - CFG.MAX_FIX_AGE_MS + 1000 }), NOW, CFG);
    expect(res.accept).toBe(true);
  });
});

describe('F1: monoton spärr PER KÄLLA — aldrig korskälla, endast true-fix', () => {
  test('samma källa (true-fix): lägre/samma fixTs avvisas (re-levererad poll-fix)', () => {
    const state = createState();
    const first = msg({ fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs: NOW - 30000 });
    const r1 = shouldAccept(state, first, NOW, CFG);
    expect(r1.accept).toBe(true);
    applyAccept(state, first, r1.fixTs, NOW);

    expect(shouldAccept(state, msg({ fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs: NOW - 30000 }), NOW + 65000, CFG))
      .toEqual({ accept: false, reason: 'stale_or_duplicate_fix' });
    expect(shouldAccept(state, msg({ fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs: NOW - 60000 }), NOW + 65000, CFG))
      .toEqual({ accept: false, reason: 'stale_or_duplicate_fix' });
  });

  test('RECEIPT-kvalitet passerar ALLTID F1 — millisekundsdelade meddelanden och NTP-bakhopp får aldrig tysta aisstream', () => {
    const state = createState();
    const first = msg({ fixFeed: 'aisstream', fixTs: NOW, lat: 58.2901 });
    const r1 = shouldAccept(state, first, NOW, CFG);
    applyAccept(state, first, r1.fixTs, NOW);

    // Samma millisekund, annan position (två äkta rapporter) ⇒ accepteras.
    const sameMs = msg({ fixFeed: 'aisstream', fixTs: NOW, lat: 58.2902 });
    expect(shouldAccept(state, sameMs, NOW, CFG).accept).toBe(true);

    // NTP-bakhopp: mottagningsstämpeln backar 20 s ⇒ accepteras ändå.
    const backstep = msg({
      fixFeed: 'aisstream', fixTs: NOW - 20000, lat: 58.2903, lon: 12.2903,
    });
    expect(shouldAccept(state, backstep, NOW + 1000, CFG).accept).toBe(true);
  });

  test('V1-C3 LEVER: F1 blockerar aldrig korskälla — när aisstream tystnat flödar hubbens äkta fixar in', () => {
    // Ursprungsgarantin (planens kärnbugg): en domänBLANDAD monotoni hade
    // svält AISHub, eftersom aisstreams mottagningsstämpel nästan alltid är
    // högre än hubbens äkta fixtid. F1 är därför per källa — och det är
    // exakt när aisstream tiger som hubben ska bära fartyget.
    const state = createState();
    const stream = msg({
      fixFeed: 'aisstream', fixTs: NOW - 300000, lat: 58.2901, lon: 12.2901,
    });
    const r1 = shouldAccept(state, stream, NOW - 300000, CFG);
    expect(r1.accept).toBe(true);
    applyAccept(state, stream, r1.fixTs, NOW - 300000);

    // 5 min senare: aisstream har inte hörts av, hubbens poll bär en 40 s
    // gammal ÄKTA fixtid — färsk information, långt nyare än allt appen har.
    const hub = msg({
      fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs: NOW - 40000, lat: 58.2903, lon: 12.2903,
    });
    expect(shouldAccept(state, hub, NOW, CFG).accept).toBe(true);
  });

  test('ASYMMETRIN: AISHub-fix först, sedan aisstream med LÄGRE stämpel — accepteras (F6 rör aldrig huvudkällan)', () => {
    // Klockskevsskyddet: hade F6 varit symmetrisk kunde en hub-stämpel från
    // en server vars klocka går före ha svält aisstream helt.
    const state = createState();
    const hub = msg({
      fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs: NOW, lat: 58.2901,
    });
    const r1 = shouldAccept(state, hub, NOW, CFG);
    applyAccept(state, hub, r1.fixTs, NOW);

    const stream = msg({
      fixFeed: 'aisstream', fixTs: NOW - 20000, lat: 58.2905, lon: 12.2905,
    });
    expect(shouldAccept(state, stream, NOW + 1000, CFG).accept).toBe(true);
  });
});

describe('F6: asymmetrisk stale-grind — en släpande hub-fix får aldrig backa fartyget', () => {
  // A/B-NATTEN 2026-08-03 (fynd 6/V4): F1:s monotoni är per källa och F5
  // flaggar utan att blockera, så en AISHub-fix som levererades EFTER en
  // färskare aisstream-fix flyttade fartyget ~200 m bakåt och lät det närma
  // sig bron en gång till. +30 s leveranslatens gav TIDAN@Klaffbron ×3 och
  // +60 s sju dubbletter, varav en 152 m EFTER passagen — samtidigt som
  // nattens egen hub-latens hade p90 62 s. F6 stänger klassen helt.
  //
  // TESTET NEDAN ERSÄTTER det gamla 'KRITISKT (V1-C3)'-fallet, som låste
  // fast precis det beteende fältmätningen fällde (hub-fix äldre än senast
  // accepterade fix ⇒ accepterad). V1-C3:s ÄKTA garanti — att F1 aldrig
  // blockerar korskälla — testas fortfarande, se F1-sviten ovan.
  test('hub-fix äldre än senast accepterade fix ⇒ stale_cross_fix', () => {
    const state = createState();
    const stream = msg({
      fixFeed: 'aisstream', fixTs: NOW, lat: 58.2901, lon: 12.2901,
    });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    const laggingHub = msg({
      fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs: NOW - 40000, lat: 58.2903, lon: 12.2903,
    });
    expect(shouldAccept(state, laggingHub, NOW + 5000, CFG))
      .toEqual({ accept: false, reason: 'stale_cross_fix' });
  });

  test('hub-fix med EXAKT samma fixtid som senast accepterade ⇒ avvisas (kravet är STRIKT nyare)', () => {
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW, lat: 58.2901 });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    const hub = msg({
      fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs: NOW, lat: 58.2907, lon: 12.2907,
    });
    expect(shouldAccept(state, hub, NOW + 5000, CFG).reason).toBe('stale_cross_fix');
  });

  test('hub-fix NYARE än senast accepterade ⇒ accepteras (täckningsvinsten är kvar)', () => {
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW, lat: 58.2901 });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    const hub = msg({
      fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs: NOW + 20000, lat: 58.2907, lon: 12.2907,
    });
    expect(shouldAccept(state, hub, NOW + 25000, CFG).accept).toBe(true);
  });

  test('LATENSSCENARIOT: en hel poll av släpande hub-fixar sväljs, den färska kedjan fortsätter', () => {
    // Rekonstruktion av +60 s-fallet: aisstream matar var 10:e sekund medan
    // hubbens poll levererar 60 s gamla ögonblicksbilder av samma resa.
    const state = createState();
    let t = NOW;
    for (let i = 0; i < 6; i++) {
      const stream = msg({
        fixFeed: 'aisstream', fixTs: t, lat: 58.2901 + i * 0.001, lon: 12.2901,
      });
      const r = shouldAccept(state, stream, t, CFG);
      expect(r.accept).toBe(true);
      applyAccept(state, stream, r.fixTs, t);
      t += 10000;
    }
    // Hubbens poll landar nu med fixar från resans BÖRJAN (bakom fartyget).
    for (let i = 0; i < 3; i++) {
      const hub = msg({
        fixFeed: 'aishub',
        fixTsQuality: 'true-fix',
        fixTs: NOW + i * 10000,
        lat: 58.2901 + i * 0.001,
        lon: 12.2901,
      });
      expect(shouldAccept(state, hub, t, CFG).accept).toBe(false);
    }
    // …men nästa ÄKTA nya hub-fix (nyare än allt vi har) släpps in.
    const fresh = msg({
      fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs: t, lat: 58.2971, lon: 12.2901,
    });
    expect(shouldAccept(state, fresh, t, CFG).accept).toBe(true);
  });

  test('GAP-FALLET (JUNO 06:05-06:25): under aisstream-tystnad accepteras hub-fix efter hub-fix', () => {
    // Nattens största vinst: aisstream tappade fartyget i 20 minuter medan
    // AISHub gav 15 fixar. F6:s ribba står stilla när aisstream tiger, så
    // varje ny poll-fix passerar — täckningen får INTE offras för V4-fixen.
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW, lat: 58.2901 });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    let accepted = 0;
    for (let i = 1; i <= 15; i++) {
      const deliveredAt = NOW + i * 65000;
      const hub = msg({
        fixFeed: 'aishub',
        fixTsQuality: 'true-fix',
        fixTs: deliveredAt - 30000, // 30 s gammal vid leverans, men alltid ny
        lat: 58.2901 + i * 0.0005,
        lon: 12.2901,
      });
      const r = shouldAccept(state, hub, deliveredAt, CFG);
      if (r.accept) {
        accepted++;
        applyAccept(state, hub, r.fixTs, deliveredAt);
      }
    }
    expect(accepted).toBe(15);
  });
});

describe('F2: korskälle-suppression på INNEHÅLL — samma källa berörs aldrig', () => {
  test('identiskt innehåll från ANDRA källan inom 90 s ⇒ cross_feed_duplicate', () => {
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    const hubEcho = msg({ fixFeed: 'aishub', fixTs: NOW - 10000 });
    expect(shouldAccept(state, hubEcho, NOW + 30000, CFG))
      .toEqual({ accept: false, reason: 'cross_feed_duplicate' });
  });

  test('identiskt innehåll från andra källan EFTER fönstret ⇒ accepteras', () => {
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    const later = NOW + CFG.CROSS_FEED_DEDUP_MS + 1000;
    const hubEcho = msg({ fixFeed: 'aishub', fixTs: NOW + 60000 });
    expect(shouldAccept(state, hubEcho, later, CFG).accept).toBe(true);
  });

  test('GRUPP B-SKYDDET (V2-M5): SAMMA källas kajupprepning (ny fixTs, identisk position) flödar', () => {
    const state = createState();
    const first = msg({ fixFeed: 'aisstream', fixTs: NOW });
    const r1 = shouldAccept(state, first, NOW, CFG);
    applyAccept(state, first, r1.fixTs, NOW);

    // aisstream 3-minutersupprepning från kaj: identiskt innehåll, ny stämpel
    // — håller fartyget vid liv (grupp C) och får ALDRIG F2-dödas.
    const repeat = msg({ fixFeed: 'aisstream', fixTs: NOW + 180000 });
    const r2 = shouldAccept(state, repeat, NOW + 180000, CFG);
    expect(r2.accept).toBe(true);
  });

  test('F2b: EKO av samma fysiska rapport suppressas oavsett accept-ålder (fixTs inom toleransen)', () => {
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    // AISHub ekar SAMMA fix 5 min senare (utanför 90s-fönstret) — identiskt
    // innehåll + fixTs inom eko-toleransen ⇒ re-leverans, aldrig refresh.
    const later = NOW + 5 * 60 * 1000;
    const hubEcho = msg({ fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs: NOW });
    expect(shouldAccept(state, hubEcho, later, CFG))
      .toEqual({ accept: false, reason: 'cross_feed_duplicate' });
  });

  test('F2b: äkta NY kajrapport via andra källan (samma position, nytt fixTs) ⇒ accepteras', () => {
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    // Kajliggaren rapporterar IGEN 3 min senare — AISHub levererar den nya
    // rapporten (identisk position, nytt fixTs långt utanför toleransen).
    // Det är täckningsvinsten: AISHub håller fartyget vid liv när aisstream
    // tystnat — får INTE ätas av eko-grenen.
    const later = NOW + 5 * 60 * 1000;
    const hubFresh = msg({ fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs: NOW + 180000 });
    expect(shouldAccept(state, hubFresh, later, CFG).accept).toBe(true);
  });

  test('olika innehåll (positionen flyttad) från andra källan ⇒ ingen suppression', () => {
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    const hubMoved = msg({ fixFeed: 'aishub', fixTs: NOW + 5000, lat: 58.2902 });
    expect(shouldAccept(state, hubMoved, NOW + 10000, CFG).accept).toBe(true);
  });

  test('FYND 16: dubblett som STRADDLAR en toFixed(5)-rutgräns fångas nu (avståndsjämförelse)', () => {
    // Den gamla strängnyckeln band positionen till en 1,11 × 0,59 m-ruta:
    // 58.290004 och 58.290006 ligger 0,22 m isär (mindre än AIS-fältets egen
    // upplösning) men avrundas till olika rutor ⇒ dubbletten slapp igenom.
    // 42 av 278 bevisade samma-rapport-par (15,1 %) missades så i A/B-natten.
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW, lat: 58.290004 });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);
    expect((58.290004).toFixed(5)).not.toBe((58.290006).toFixed(5)); // olika rutor

    const hubEcho = msg({
      fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs: NOW - 5000, lat: 58.290006,
    });
    expect(shouldAccept(state, hubEcho, NOW + 30000, CFG))
      .toEqual({ accept: false, reason: 'cross_feed_duplicate' });
  });

  test('FYND 16: marginalen sväljer aldrig en ÄKTA förflyttning (10 m ⇒ ingen suppression)', () => {
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    const hubMoved = msg({
      fixFeed: 'aishub',
      fixTsQuality: 'true-fix',
      fixTs: NOW + 5000,
      lat: 58.29 + 10 / 111320, // 10 m norrut
    });
    expect(shouldAccept(state, hubMoved, NOW + 10000, CFG).accept).toBe(true);
  });

  test('trasiga koordinater kastar inte (null-avstånd ⇒ ingen innehållsmatch)', () => {
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    const broken = msg({ fixFeed: 'aishub', fixTs: NOW + 5000, lat: undefined });
    expect(() => shouldAccept(state, broken, NOW + 10000, CFG)).not.toThrow();
  });
});

describe('F5: källbytesskydd — flagga, aldrig blockering', () => {
  test('källbyte + hopp > 150 m inom 30 s ⇒ feedSwitch=true (accepteras ändå)', () => {
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    // ~300 m norrut från andra källan, 10 s senare.
    const hub = msg({
      fixFeed: 'aishub', fixTs: NOW + 5000, lat: 58.29 + 300 / 111320, lon: 12.2902,
    });
    const r2 = shouldAccept(state, hub, NOW + 10000, CFG);
    expect(r2.accept).toBe(true);
    expect(r2.feedSwitch).toBe(true);
  });

  test('FÄLTPROV 3: källbyte 45 s senare ligger INOM fönstret ⇒ flaggas (30s-fönstret var kortare än pollkadensen)', () => {
    // Fönstret var 30 s medan AISHub pollar var 65-70:e sekund — ett
    // källbyte hann i praktiken ALDRIG ske inom fönstret, och samtliga
    // nio observerade källbyten över 150 m i fältprovet låg utanför det.
    // F5 var alltså död på riktig trafik. 90 s spänner en hel pollcykel.
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    const hub = msg({
      fixFeed: 'aishub', fixTs: NOW + 45000, lat: 58.29 + 300 / 111320, lon: 12.2902,
    });
    const r2 = shouldAccept(state, hub, NOW + 45000, CFG);
    expect(r2.accept).toBe(true);
    expect(r2.feedSwitch).toBe(true);
  });

  test('källbyte + hopp UTANFÖR fönstret (>90 s) ⇒ ingen flagga', () => {
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    const hub = msg({
      fixFeed: 'aishub', fixTs: NOW + 100000, lat: 58.29 + 300 / 111320, lon: 12.2902,
    });
    const r2 = shouldAccept(state, hub, NOW + 100000, CFG);
    expect(r2.accept).toBe(true);
    expect(r2.feedSwitch).toBe(false);
  });

  test('källbyte + litet hopp (< 150 m) ⇒ ingen flagga', () => {
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    const hub = msg({
      fixFeed: 'aishub', fixTs: NOW + 5000, lat: 58.29 + 100 / 111320, lon: 12.2901,
    });
    const r2 = shouldAccept(state, hub, NOW + 10000, CFG);
    expect(r2.accept).toBe(true);
    expect(r2.feedSwitch).toBe(false);
  });

  test('samma källa stort hopp ⇒ ingen feedSwitch (det är GPSJumpAnalyzers jobb)', () => {
    const state = createState();
    const first = msg({ fixFeed: 'aisstream', fixTs: NOW });
    const r1 = shouldAccept(state, first, NOW, CFG);
    applyAccept(state, first, r1.fixTs, NOW);

    const jump = msg({
      fixFeed: 'aisstream', fixTs: NOW + 5000, lat: 58.29 + 500 / 111320, lon: 12.2905,
    });
    const r2 = shouldAccept(state, jump, NOW + 5000, CFG);
    expect(r2.accept).toBe(true);
    expect(r2.feedSwitch).toBe(false);
  });
});

describe('state-hushållning: pruneStates (TTL + LRU-tak)', () => {
  test('TTL: state utan aktivitet längre än STATE_TTL_MS prunas', () => {
    const map = new Map();
    const s1 = createState();
    s1.lastAcceptedTs = NOW - CFG.STATE_TTL_MS - 1000;
    const s2 = createState();
    s2.lastAcceptedTs = NOW - 1000;
    map.set('a', s1);
    map.set('b', s2);
    const removed = pruneStates(map, NOW, CFG);
    expect(removed).toBe(1);
    expect(map.has('a')).toBe(false);
    expect(map.has('b')).toBe(true);
  });

  test('LRU-taket: kartan överskrider aldrig STATE_MAX_ENTRIES', () => {
    const map = new Map();
    for (let i = 0; i < CFG.STATE_MAX_ENTRIES + 50; i++) {
      const s = createState();
      s.lastAcceptedTs = NOW;
      map.set(`mmsi${i}`, s);
    }
    pruneStates(map, NOW, CFG);
    expect(map.size).toBe(CFG.STATE_MAX_ENTRIES);
    expect(map.has('mmsi0')).toBe(false); // äldst åkte först
    expect(map.has(`mmsi${CFG.STATE_MAX_ENTRIES + 49}`)).toBe(true);
  });

  test('state som aldrig accepterat något (lastAcceptedTs null) prunas', () => {
    const map = new Map([['tom', createState()]]);
    pruneStates(map, NOW, CFG);
    expect(map.size).toBe(0);
  });

  test('FYND 15: taket evicterar ÄLDST ANVÄNDA, inte först insatta', () => {
    // Buggen: Map-ordningen är insättningsordning, så keys().next() slängde
    // det fartyg som spårats LÄNGST — typiskt det mest aktiva — medan en
    // nyss insatt kajliggare fick ligga kvar.
    const map = new Map();
    for (let i = 0; i < CFG.STATE_MAX_ENTRIES + 1; i++) {
      const s = createState();
      // Först insatt = mest aktiv (senast accepterade fix), sist insatt = kall.
      s.lastAcceptedTs = i === 0 ? NOW : NOW - 1000 - i;
      map.set(`mmsi${i}`, s);
    }
    pruneStates(map, NOW, CFG);
    expect(map.size).toBe(CFG.STATE_MAX_ENTRIES);
    expect(map.has('mmsi0')).toBe(true); // den aktiva överlever
    expect(map.has(`mmsi${CFG.STATE_MAX_ENTRIES}`)).toBe(false); // kallast åkte
  });
});

describe('F6b: klockoffsetkompensation (granskningsrunda 2, 2026-08-03)', () => {
  const hub = (fixTs, extra = {}) => msg({
    fixFeed: 'aishub', fixTsQuality: 'true-fix', fixTs, ...extra,
  });

  test('frisk klocka (alla leveranslag ≥ 0) ⇒ offset EXAKT 0 — bit-identiskt beteende', () => {
    const clock = createClockState();
    for (let i = 0; i < 20; i++) {
      // Leveranslagg 30 s, som nattens median.
      observeClock(clock, null, hub(NOW - 30000 + i), 'aishub', NOW + i, CFG);
    }
    expect(clock.hubOffsetMs).toBe(0);
    expect(clock.hubAheadSamples).toBe(0);
  });

  test('LEVERANSBEVISET: en fix som postdaterar sin egen leverans är skevbevis', () => {
    const clock = createClockState();
    // Hubbens klocka går 45 s före: fixTs ligger 45 s efter mottagningen.
    observeClock(clock, null, hub(NOW + 45000), 'aishub', NOW, CFG);
    expect(clock.hubAheadSamples).toBe(1);
    expect(clock.hubOffsetMs).toBe(-45000);
  });

  test('KORSKÄLLEBEVISET: medianen av samma-rapport-par avslöjar skev som latensen döljer', () => {
    // Hubben släpar 60 s OCH går 60 s före ⇒ leveranslaggen ser normal ut
    // (60 − 60 = 0 … alltså ingen negativ lag) och bevis A ser ingenting.
    // Men aisstream-mottagningen av SAMMA rapport ligger 58 s FÖRE hubbens
    // påstådda fixtid, vilket bara en klockskev kan förklara.
    const clock = createClockState();
    const SKEW = 60000;
    for (let i = 0; i < CFG.CLOCK_PAIR_MIN_SAMPLES; i++) {
      const t = NOW + i * 1000;
      const state = createState();
      const streamMsg = msg({ fixTs: t, fixTsQuality: 'receipt' });
      applyAccept(state, streamMsg, t, t, 'aisstream');
      // Hubbens eko: samma innehåll, fixTs = emissionen + skev (2 s pushlatens).
      observeClock(clock, state, hub(t - 2000 + SKEW), 'aishub', t + 60000, CFG);
    }
    expect(clock.hubAheadSamples).toBe(0); // bevis A ser inget
    expect(clock.hubOffsetMs).toBe(-(SKEW - 2000)); // bevis B fångar det
  });

  test('för få par ⇒ korskällebeviset används inte (ingen kompensation på gissningar)', () => {
    const clock = createClockState();
    const t = NOW;
    const state = createState();
    applyAccept(state, msg({ fixTs: t }), t, t, 'aisstream');
    observeClock(clock, state, hub(t + 58000), 'aishub', t + 60000, CFG);
    expect(clock.pairLags.length).toBe(1);
    expect(clock.hubOffsetMs).toBe(0);
  });

  test('F6 fyrar igen under skev: den kompenserade stämpeln är äldre än senast accepterade', () => {
    const state = createState();
    // aisstream-fix accepterad NOW.
    const s1 = shouldAccept(state, msg({ fixTs: NOW }), NOW, CFG, { feed: 'aisstream' });
    expect(s1.accept).toBe(true);
    applyAccept(state, msg({ fixTs: NOW }), s1.fixTs, NOW, 'aisstream');
    // Släpande hub-fix (äkta fixtid 40 s FÖRE) men hubklockan går 60 s före ⇒
    // rå fixTs ser 20 s NYARE ut än aisstreams mottagning. ANNAN position så
    // F2:s innehållsdedup inte hinner före (det är F6 som prövas här).
    const stale = hub(NOW - 40000 + 60000, { lat: 58.2915 });
    const raw = shouldAccept(state, { ...stale }, NOW + 30000, CFG, { feed: 'aishub' });
    expect(raw.accept).toBe(true); // utan kompensation slinker den igenom
    const fixed = shouldAccept(state, { ...stale }, NOW + 30000, CFG, {
      feed: 'aishub', hubOffsetMs: -60000,
    });
    expect(fixed).toEqual({ accept: false, reason: 'stale_cross_fix' });
  });

  test('F4a-klampad hub-fix AVVISAS i stället för att frias (grinden stängde av sig själv)', () => {
    const state = createState();
    applyAccept(state, msg({ fixTs: NOW }), NOW, NOW, 'aisstream');
    // Utan kompensation: fixTs 5 min i framtiden ⇒ F4a klampar till now ⇒
    // per konstruktion nyare än allt ⇒ hade friat ovillkorligt.
    const v = shouldAccept(state, hub(NOW + 300000, { lat: 58.2915 }), NOW, CFG, { feed: 'aishub' });
    expect(v).toEqual({ accept: false, reason: 'hub_clock_skew' });
  });

  test('aisstream berörs ALDRIG av F6/F6b (huvudkällan kan inte svältas)', () => {
    const state = createState();
    applyAccept(state, msg({ fixTs: NOW + 60000 }), NOW + 60000, NOW, 'aisstream');
    const v = shouldAccept(state, msg({ fixTs: NOW }), NOW, CFG, {
      feed: 'aisstream', hubOffsetMs: -60000,
    });
    expect(v.accept).toBe(true);
    expect(v.fixTs).toBe(NOW); // ingen korrigering på receipt-källan
  });
});

describe('Routad källa: fixFeed i nyttolasten får inte kunna avväpna grindarna', () => {
  test('ctx.feed vinner över ett TAPPAT fixFeed — F6 fyrar ändå', () => {
    const state = createState();
    applyAccept(state, msg({ fixTs: NOW }), NOW, NOW, 'aisstream');
    const tappad = msg({ fixTs: NOW - 60000, fixTsQuality: 'true-fix', lat: 58.2915 });
    delete tappad.fixFeed;
    // Gammal semantik (härled ur nyttolasten): släpps igenom.
    expect(shouldAccept(state, { ...tappad }, NOW, CFG).accept).toBe(true);
    // Ny semantik: routingen är sanningen.
    expect(shouldAccept(state, { ...tappad }, NOW, CFG, { feed: 'aishub' }))
      .toEqual({ accept: false, reason: 'stale_cross_fix' });
  });

  test('applyAccept bokför på den ROUTADE källan (F1:s hink blir aldrig undefined)', () => {
    const state = createState();
    const tappad = msg({ fixTs: NOW });
    delete tappad.fixFeed;
    applyAccept(state, tappad, NOW, NOW, 'aishub');
    expect(state.lastFixTs.aishub).toBe(NOW);
    expect(state.lastFeed).toBe('aishub');
    expect(Object.prototype.hasOwnProperty.call(state.lastFixTs, 'undefined')).toBe(false);
  });
});
