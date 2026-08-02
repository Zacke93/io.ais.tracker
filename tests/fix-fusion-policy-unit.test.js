'use strict';

const {
  createState, normalizeFixTs, shouldAccept, applyAccept, pruneStates,
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

  test('KRITISKT (V1-C3): aisstream-receipt avvisar ALDRIG en äldre AISHub-true-fix', () => {
    const state = createState();
    // aisstream levererar med mottagningstid = nu.
    const stream = msg({
      fixFeed: 'aisstream', fixTs: NOW, lat: 58.2901, lon: 12.2901,
    });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    expect(r1.accept).toBe(true);
    applyAccept(state, stream, r1.fixTs, NOW);

    // AISHub-pollen 5 s senare bär en 40 s gammal ÄKTA fixtid — lägre än
    // aisstreams mottagningsstämpel men fortfarande färsk information.
    // Domänblandad monotoni hade svält AISHub här (planens kärnbugg).
    const hub = msg({
      fixFeed: 'aishub', fixTs: NOW - 40000, lat: 58.2903, lon: 12.2903,
    });
    const r2 = shouldAccept(state, hub, NOW + 5000, CFG);
    expect(r2.accept).toBe(true);
  });

  test('spegelvänt: AISHub-fix först, sedan aisstream med lägre stämpel — accepteras', () => {
    const state = createState();
    const hub = msg({ fixFeed: 'aishub', fixTs: NOW, lat: 58.2901 });
    const r1 = shouldAccept(state, hub, NOW, CFG);
    applyAccept(state, hub, r1.fixTs, NOW);

    const stream = msg({
      fixFeed: 'aisstream', fixTs: NOW - 20000, lat: 58.2905, lon: 12.2905,
    });
    expect(shouldAccept(state, stream, NOW + 1000, CFG).accept).toBe(true);
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

  test('källbyte + hopp UTANFÖR 30 s-fönstret ⇒ ingen flagga', () => {
    const state = createState();
    const stream = msg({ fixFeed: 'aisstream', fixTs: NOW });
    const r1 = shouldAccept(state, stream, NOW, CFG);
    applyAccept(state, stream, r1.fixTs, NOW);

    const hub = msg({
      fixFeed: 'aishub', fixTs: NOW + 35000, lat: 58.29 + 300 / 111320, lon: 12.2902,
    });
    const r2 = shouldAccept(state, hub, NOW + 40000, CFG);
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
});
