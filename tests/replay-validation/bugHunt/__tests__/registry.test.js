'use strict';

/**
 * Buggjägaren steg 3: beslutsregistret och predikaten. Varje predikat prövas
 * åt båda hållen. U-svängsfixturen är ett verkligt replayresultat; övriga
 * fixturer är små rader byggda på farledens verkliga geometri. Inga
 * barnprocesser och inga timers.
 */

const path = require('path');
const usvang = require('./fixtures/usvang.json');

const MIN = 60000;
const T0 = Date.parse('2026-07-01T10:00:00.000Z');

function load() {
  return {
    reg: require('../lib/registry'),
    platser: require('../lib/platser'),
    constants: require('../../../../lib/constants'),
  };
}

/** Position på farleden vid s (m), med sidledsförskjutning i meter. */
function pointAtS(platser, s, lateralM = 0) {
  const { legs } = platser.FAIRWAY;
  const leg = legs.find((l) => s >= l.cum && s <= l.cum + l.len) || legs[legs.length - 1];
  const u = (s - leg.cum) / leg.len;
  const lat = leg.a.lat + u * (leg.b.lat - leg.a.lat);
  const lon = leg.a.lon + u * (leg.b.lon - leg.a.lon);
  const mLat = 111320;
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const dx = (leg.b.lon - leg.a.lon) * mLon;
  const dy = (leg.b.lat - leg.a.lat) * mLat;
  const n = Math.hypot(dx, dy) || 1;
  return { lat: lat + ((dx / n) * lateralM) / mLat, lon: lon - ((dy / n) * lateralM) / mLon };
}

function row(platser, mmsi, t, s, extra = {}) {
  return {
    mmsi, msgType: 'PositionReport', ...pointAtS(platser, s, extra.lateralM || 0), sog: 4, cog: 30, shipName: 'TEST', aisTimestamp: t, ...extra,
  };
}

const pred = (reg, name) => {
  const p = reg.PREDICATES[name];
  return (f, ctx, params = {}) => p.fn(f, ctx || {}, { ...p.parametrar, ...params });
};

describe('buggjägaren: beslutsregistret', () => {
  test('registret laddar: poster med källa, datum och kända predikat', () => {
    const { reg } = load();
    const r = reg.loadRegistry();
    expect(r.poster.length).toBeGreaterThanOrEqual(28);
    for (const e of r.poster) {
      expect(e.källa).toBeTruthy();
      expect(e.datum).toMatch(/^\d{4}-\d\d-\d\d$/);
      expect(reg.PREDICATES[e.predikat.namn]).toBeDefined();
    }
    expect(Object.keys(reg.PREDICATES).length).toBeGreaterThanOrEqual(20);
  });

  test('en post utan källa ger laddfel, liksom okänt predikat och INV-F utan INV-id', () => {
    const { reg } = load();
    const base = {
      id: 'X', klass: 'DESIGN', datum: '2026-11-04', källa: 'docs/VALIDATION.md', regel: 'r', gäller: { orakel: ['T1'], klassRegex: '.*' }, predikat: { namn: 'alltid', parametrar: {} },
    };
    expect(() => reg.loadRegistry({ poster: [base] })).not.toThrow();
    expect(() => reg.loadRegistry({ poster: [{ ...base, källa: '' }] })).toThrow(/saknar källa/);
    expect(() => reg.loadRegistry({ poster: [{ ...base, datum: undefined }] })).toThrow(/saknar datum/);
    expect(() => reg.loadRegistry({ poster: [{ ...base, predikat: { namn: 'finnsInte' } }] })).toThrow(/okänt predikat/);
    expect(() => reg.loadRegistry({ poster: [{ ...base, gäller: { orakel: ['INV-F'], klassRegex: '.*' } }] })).toThrow(/namnge INV-id/);
    expect(() => reg.loadRegistry({ poster: [{ ...base, klass: 'KONFLIKT' }] })).toThrow(/fråga/);
  });

  test('ett INV-14-utslag utan matchande predikat förblir KANDIDAT; oanvända poster rapporteras', () => {
    const { reg } = load();
    const r = reg.loadRegistry();
    const f = {
      orakel: 'INV-F',
      klass: 'INV-14 DEFAULT-FLASH',
      inv: 'INV-14',
      allvar: 4,
      t: T0,
      bro: 'Stridsbergsbron',
      detalj: `DEFAULT-FLASH: ${new Date(T0).toISOString()} "Inga båtar" inklämd (40s) mellan två "En … Stridsbergsbron"-texter utan passage`,
    };
    const c = r.classify(f, { rader: [], resultat: { bridgeTextTransitions: [] }, korpus: { id: 'x' } });
    expect(c.klass).toBe('KANDIDAT');
    expect(c.post).toBeNull();
    expect(c.närmast).toMatchObject({ post: 'KIE-PER-KORPUS' });
    let unused = r.unused().map((u) => u.id);
    expect(unused).toContain('BN1-BOXKANT');
    expect(unused).toContain('KIE-PER-KORPUS');
    expect(unused).toContain('GPS_JUMP-DIAGNOSTIK');
    // En post som matchar försvinner ur listan; P8-L6 märks omätbar.
    r.classify({ orakel: 'H3', klass: '[APP ERROR] 🚨 [GPS_JUMP] M: GPS jump detected Nm' }, {});
    unused = r.unused();
    expect(unused.map((u) => u.id)).not.toContain('GPS_JUMP-DIAGNOSTIK');
    expect(unused.find((u) => u.id === 'P8-L6-SPÖKTEXT').omätbar).toBe(true);
  });

  test('INV5-VS-BESÖKSREGEL är borttagen (U14, aa71099): U-svängsfixturens INV-5-utslag blir KANDIDAT, och besöksregeln för T1 står kvar', () => {
    // U14 gjorde INV-5/7 till kontrakt (en notis per verklig passage, även
    // returpassagen), och konflikten är avgjord. Fixturen är ett äldre
    // appresultat med två målbropassager och en notis; i dag är det ett
    // appfel, och inget i registret får förklara det (BUGGJAKT §7, rad 35).
    const { reg } = load();
    const r = reg.loadRegistry();
    expect(r.poster.map((e) => e.id)).not.toContain('INV5-VS-BESÖKSREGEL');
    expect(r.poster.filter((e) => (e.gäller.inv || []).some((x) => x === 'INV-5' || x === 'INV-7'))).toEqual([]);
    const existing = require('../lib/oracles/existing');
    const inv5 = existing.judgeExisting({ result: usvang.resultat, rows: usvang.rader, gt: [] }).fynd.find((f) => f.inv === 'INV-5');
    const c = r.classify(inv5, { rader: usvang.rader, resultat: usvang.resultat });
    expect(c).toMatchObject({ klass: 'KANDIDAT', post: null });
    expect(r.entry('BESÖKSREGEL-2026-09-07').predikat.namn).toBe('sameVisit');
  });

  describe('varje predikat åt båda hållen', () => {
    test('sameVisit (T1): tidigare notis utan utfärd ⇒ sant; med utfärd ⇒ falskt', () => {
      const { reg, platser } = load();
      const p = pred(reg, 'sameVisit');
      const sK = platser.stationS('Klaffbron');
      const res = {
        notifications: [{
          mmsi: '211000001', bridge: 'Klaffbron', direction: 'northbound', t: T0, success: true,
        }],
      };
      const f = {
        orakel: 'T1', klass: 'NOTIS-UTEBLIVEN', mmsi: '211000001', bro: 'Klaffbron', t: T0 + 40 * MIN,
      };
      const stay = [10, 20, 30].map((m) => row(platser, '211000001', T0 + m * MIN, sK + 200));
      expect(p(f, { rader: stay, resultat: res }).sant).toBe(true);
      const exit = [...stay, row(platser, '211000001', T0 + 31 * MIN, sK + 500), row(platser, '211000001', T0 + 32 * MIN, sK + 520)]
        .sort((a, b) => a.aisTimestamp - b.aisTimestamp);
      expect(p(f, { rader: exit, resultat: res }).sant).toBe(false);
      expect(p(f, { rader: stay, resultat: { notifications: [] } }).sant).toBe(false);
    });

    test('boxEdgeExit: utfart vid Kanalinfarten med glapp ⇒ sant; utfärd bevisad eller vanlig bro ⇒ falskt', () => {
      const { reg, platser } = load();
      const p = pred(reg, 'boxEdgeExit');
      const K = platser.POINTS.Kanalinfarten;
      const near = (t) => ({
        mmsi: '211000002', lat: K.lat + 0.0012, lon: K.lon, sog: 5, aisTimestamp: t,
      });
      const res = {
        notifications: [{
          mmsi: '211000002', bridge: 'Kanalinfarten', direction: 'southbound', t: T0, success: true,
        }],
      };
      const f = {
        orakel: 'T1', klass: 'NOTIS-UTEBLIVEN', mmsi: '211000002', bro: 'Kanalinfarten', t: T0 + 60 * MIN,
      };
      const rows = [near(T0), near(T0 + MIN), near(T0 + 60 * MIN)];
      expect(p(f, { rader: rows, resultat: res }).sant).toBe(true);
      const far = (t) => ({ ...near(t), lat: K.lat - 0.008 });
      const proven = [...rows, far(T0 + 2 * MIN), far(T0 + 3 * MIN)].sort((a, b) => a.aisTimestamp - b.aisTimestamp);
      expect(p(f, { rader: proven, resultat: res }).sant).toBe(false);
      expect(p({ ...f, bro: 'Klaffbron' }, { rader: rows, resultat: res }).sant).toBe(false);
    });

    test('inferenceAge: första fix 20 min efter korsningen ⇒ sant; 5 min ⇒ falskt', () => {
      const { reg, platser } = load();
      const p = pred(reg, 'inferenceAge');
      const sK = platser.stationS('Klaffbron');
      const f = {
        orakel: 'T1', klass: 'NOTIS-UTEBLIVEN', mmsi: '211000003', bro: 'Klaffbron', t: T0, belägg: { korsningT: T0 },
      };
      expect(p(f, { rader: [row(platser, '211000003', T0 + 20 * MIN, sK + 900)] }).sant).toBe(true);
      expect(p(f, { rader: [row(platser, '211000003', T0 + 5 * MIN, sK + 900)] }).sant).toBe(false);
    });

    test('dedup2h: samma riktning inom 2 h ⇒ sant; motsatt riktning ⇒ falskt', () => {
      const { reg } = load();
      const p = pred(reg, 'dedup2h');
      const f = {
        orakel: 'T1', klass: 'NOTIS-UTEBLIVEN', mmsi: '211000004', bro: 'Olidebron', riktning: 'northbound', t: T0 + 90 * MIN,
      };
      const note = (direction) => ({
        resultat: {
          notifications: [{
            mmsi: '211000004', bridge: 'Olidebron', direction, t: T0, success: true,
          }],
        },
      });
      expect(p(f, note('northbound')).sant).toBe(true);
      expect(p(f, note('southbound')).sant).toBe(false);
      expect(p({ ...f, t: T0 + 130 * MIN }, note('northbound')).sant).toBe(false);
    });

    test('fixBeyondLine: 40 m bortom linjen ⇒ sant; 120 m ⇒ falskt (belägg och rader)', () => {
      const { reg, platser } = load();
      const p = pred(reg, 'fixBeyondLine');
      expect(p({ belägg: { bortomLinjenM: 40 } }).sant).toBe(true);
      expect(p({ belägg: { bortomLinjenM: 120 } }).sant).toBe(false);
      const sK = platser.stationS('Klaffbron');
      const f = {
        orakel: 'T10', klass: 'MISS', mmsi: '211000005', bro: 'Klaffbron', t: T0 + 2 * MIN, belägg: { korsningT: T0 },
      };
      const before = row(platser, '211000005', T0 - MIN, sK - 150);
      expect(p(f, { rader: [before, row(platser, '211000005', T0 + MIN, sK + 40)] }).sant).toBe(true);
      expect(p(f, { rader: [before, row(platser, '211000005', T0 + MIN, sK + 120)] }).sant).toBe(false);
    });

    test('noMovementProof: bara stilla fixar ⇒ sant; en fix ≥ 1,0 kn ⇒ falskt', () => {
      const { reg, platser } = load();
      const p = pred(reg, 'noMovementProof');
      const f = {
        orakel: 'T1', klass: 'NOTIS-UTEBLIVEN', mmsi: '211000006', bro: 'Klaffbron', t: T0, belägg: { tIn: T0, tOut: T0 + 5 * MIN },
      };
      const still = [row(platser, '211000006', T0 - 5 * MIN, 2100, { sog: 0.2 }), row(platser, '211000006', T0 + MIN, 2100, { sog: 0.1 })];
      expect(p(f, { rader: still }).sant).toBe(true);
      expect(p(f, { rader: [...still, row(platser, '211000006', T0 + 2 * MIN, 2120, { sog: 3 })] }).sant).toBe(false);
    });

    // absorberade = [[mmsi, dt]]: täckningsrader {reason: 'absorbed'} i Stridsbergsbron#1.
    const warnCtx = (crossings, absorberade = []) => ({
      resultat: {
        openingWarnings: [{
          bridge: 'Stridsbergsbron', t: T0, mmsis: ['211000010'], leadMmsi: '211000010', eventId: 'Stridsbergsbron#1', success: true,
        }],
        openingCoverage: absorberade.map(([mmsi, dt]) => ({
          mmsi, bridge: 'Stridsbergsbron', eventId: 'Stridsbergsbron#1', reason: 'absorbed', t: T0 + dt * 1000,
        })),
      },
      gt: crossings.map(([mmsi, dt]) => ({
        mmsi, bridge: 'Stridsbergsbron', kind: 'line', inferred: false, t: T0 + dt * 1000,
      })),
    });

    test('crossingWithinEventWindow: täckt båt 300 s efter första passagen ⇒ sant; 800 s eller otäckt ⇒ falskt', () => {
      const { reg } = load();
      const p = pred(reg, 'crossingWithinEventWindow');
      const f = (dt) => ({
        orakel: 'T2', klass: 'LEDTID<60s', mmsi: '211000011', bro: 'Stridsbergsbron', t: T0 + dt * 1000,
      });
      expect(p(f(400), warnCtx([['211000010', 100], ['211000011', 400]], [['211000011', 50]])).sant).toBe(true);
      expect(p(f(900), warnCtx([['211000010', 100], ['211000011', 900]], [['211000011', 50]])).sant).toBe(false);
      // M04: garantin förfaller bara medan båten är täckt av händelsen.
      expect(p(f(400), warnCtx([['211000010', 100], ['211000011', 400]])).sant).toBe(false);
    });

    test('crossingWithinEventWindow: båtens egen korsning är aldrig händelsens första passage (konvojbakkanten)', () => {
      const { reg } = load();
      const p = pred(reg, 'crossingWithinEventWindow');
      // A (…010) i Stridsbergsbron#1, korsar 100 s; B (…011) absorberas i #1
      // men får egen varning #3 640 s efter A:s korsning och korsar 20 s
      // senare: utanför U2-fönstret.
      const ctx = warnCtx([['211000010', 100], ['211000011', 760]], [['211000011', 60]]);
      ctx.resultat.openingWarnings.push({
        bridge: 'Stridsbergsbron', t: T0 + 740000, mmsis: ['211000011'], leadMmsi: '211000011', eventId: 'Stridsbergsbron#3', success: true,
      });
      const f = {
        orakel: 'T2', klass: 'LEDTID<60s', mmsi: '211000011', bro: 'Stridsbergsbron', t: T0 + 760000,
      };
      const r = p(f, ctx);
      expect(r.sant).toBe(false);
      expect(r.skäl).toMatch(/660 s efter/);
    });

    test('nonMemberCrossingBetween: icke-medlem korsar emellan ⇒ sant; ingen ⇒ falskt', () => {
      const { reg } = load();
      const p = pred(reg, 'nonMemberCrossingBetween');
      const f = {
        orakel: 'T2', klass: 'OKLASSAD', mmsi: '211000010', bro: 'Stridsbergsbron', t: T0 + 500000,
      };
      expect(p(f, warnCtx([['211000099', 200], ['211000010', 500]])).sant).toBe(true);
      expect(p(f, warnCtx([['211000010', 500]])).sant).toBe(false);
    });

    test('uturnReturnAbsorbed är borttaget (U15): U-svängarens retur i egen äldre händelse är KANDIDAT', () => {
      const { reg } = load();
      expect(reg.PREDICATES.uturnReturnAbsorbed).toBeUndefined();
      const [, p2] = usvang.resultat.targetPassages;
      const f = {
        orakel: 'T2', klass: 'ÖPPNING-MISS:OKLASSAD', mmsi: '265025978', bro: 'Klaffbron', t: p2.t,
      };
      const ctx = { rader: usvang.rader, resultat: usvang.resultat };
      const c = reg.loadRegistry().classify(f, ctx, { räkna: false });
      expect(c.klass).toBe('KANDIDAT');
      expect(c.post).toBeNull();
    });

    test('holdPattern: två vändningar ≥ 150 m inom 60 min ⇒ sant; rak transit ⇒ falskt', () => {
      const { reg, platser } = load();
      const p = pred(reg, 'holdPattern');
      const f = {
        orakel: 'T3', klass: 'FANTOM', mmsi: '211000012', t: T0 + 30 * MIN,
      };
      const ss = [3000, 3150, 3300, 3150, 3000, 3150, 3300];
      const loop = ss.map((s, i) => row(platser, '211000012', T0 + i * 6 * MIN, s));
      expect(p(f, { rader: loop }).sant).toBe(true);
      const straight = ss.map((s, i) => row(platser, '211000012', T0 + i * 6 * MIN, 2500 + i * 150));
      expect(p(f, { rader: straight }).sant).toBe(false);
    });

    test('directionUnknown: riktningsbyte till unknown ⇒ sant; bestämd ny riktning eller inget byte ⇒ falskt', () => {
      const { reg } = load();
      const p = pred(reg, 'directionUnknown');
      expect(p({ riktning: 'northbound', belägg: { nyRiktning: 'unknown' } }).sant).toBe(true);
      expect(p({ riktning: 'unknown', belägg: { nyRiktning: 'southbound' } }).sant).toBe(false);
      // M05: inget återfall på fyndets riktning (en tappad notis är inget byte).
      expect(p({ riktning: 'unknown' }).sant).toBe(false);
    });

    test('leaderOnlyChange: alternativ ledare i samma AISHub-poll ⇒ sant; 2 s isär eller tillagd varning ⇒ falskt', () => {
      const { reg } = load();
      const p = pred(reg, 'leaderOnlyChange');
      const par = {
        bas: {
          bridge: 'Klaffbron', leadMmsi: '211000020', t: T0, direction: 'southbound',
        },
        variant: {
          bridge: 'Klaffbron', leadMmsi: '211000021', t: T0 + 10000, direction: 'northbound',
        },
      };
      const f = { orakel: 'M-FAS', klass: 'ÖPPNINGSRIKTNING BYTT', belägg: { par } };
      const aishub = (mmsi, t) => ({
        mmsi, lat: 58.28, lon: 12.28, aisTimestamp: t, fixTs: t - 20000, feed: 'aishub',
      });
      expect(p(f, { rader: [aishub('211000020', T0 - 30000), aishub('211000021', T0 - 29900)] }).sant).toBe(true);
      expect(p(f, { rader: [aishub('211000020', T0 - 30000), aishub('211000021', T0 - 28000)] }).sant).toBe(false);
      expect(p({ ...f, belägg: {} }, { rader: [] }).sant).toBe(false);
    });

    test('kiePrefix: 42h-flashens fasvariant ⇒ sant; korpus utan undantag eller annan bro ⇒ falskt', () => {
      const { reg } = load();
      const p = pred(reg, 'kiePrefix');
      const corpora = require(path.join('..', '..', 'corpora'));
      const k42 = corpora.find((c) => c.id === '20260806-42h');
      const k21 = corpora.find((c) => c.id === '20260708-21h');
      const msg = 'DEFAULT-FLASH: 2026-08-06T08:47:07.040Z "Inga båtar" inklämd (56s) mellan två "En … Stridsbergsbron"-texter utan passage';
      const f = {
        orakel: 'INV-F', klass: 'INV-14 DEFAULT-FLASH', inv: 'INV-14', detalj: msg,
      };
      expect(p(f, { korpus: k42 }).sant).toBe(true);
      expect(p(f, { korpus: k21 }).sant).toBe(false);
      expect(p({ ...f, detalj: msg.replace('Stridsbergsbron', 'Klaffbron') }, { korpus: k42 }).sant).toBe(false);
    });

    test('restartWithin: omstart 5 min före ⇒ sant; 20 min före ⇒ falskt', () => {
      const { reg } = load();
      const p = pred(reg, 'restartWithin');
      const f = { t: T0 };
      expect(p(f, { rader: [{ ctrl: 'restart', aisTimestamp: T0 - 5 * MIN }] }).sant).toBe(true);
      expect(p(f, { rader: [{ ctrl: 'restart', aisTimestamp: T0 - 20 * MIN }] }).sant).toBe(false);
    });

    test('defaultUntilFirstFixAfterRestart: DEFAULT ≤ 60 s efter första fixen ⇒ sant; längre ⇒ falskt', () => {
      const { reg, platser } = load();
      const p = pred(reg, 'defaultUntilFirstFixAfterRestart');
      const rows = [{ ctrl: 'restart', aisTimestamp: T0 }, row(platser, '211000030', T0 + 40000, 2000)];
      const trans = (endDt) => ({
        bridgeTextTransitions: [
          { t: T0, text: 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron' },
          { t: T0 + endDt, text: 'En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter' },
        ],
      });
      const f = { orakel: 'INV-F', inv: 'INV-14', t: T0 };
      expect(p(f, { rader: rows, resultat: trans(70000) }).sant).toBe(true);
      expect(p(f, { rader: rows, resultat: trans(200000) }).sant).toBe(false);
    });

    test('mooringCapsuleStationary: stilla 5 min i Kajens kapsel och målbron > 600 m bort ⇒ sant; Klaffbron nära ⇒ falskt', () => {
      const { reg, constants } = load();
      const p = pred(reg, 'mooringCapsuleStationary');
      const z = constants.MOORING_ZONES[0];
      const mid = { lat: (z.start.lat + z.end.lat) / 2, lon: (z.start.lon + z.end.lon) / 2 };
      const rows = [0, 2, 4, 5].map((m) => ({
        mmsi: '211000040', ...mid, sog: 0, aisTimestamp: T0 + m * MIN,
      }));
      const f = (bro) => ({
        orakel: 'INV-F', inv: 'INV-14', bro, t: T0 + 5 * MIN,
      });
      expect(p(f('Stridsbergsbron'), { rader: rows }).sant).toBe(true);
      expect(p(f('Klaffbron'), { rader: rows }).sant).toBe(false);
    });

    test('profileIs: R0 ⇒ sant; R1 ⇒ falskt', () => {
      const { reg } = load();
      const p = pred(reg, 'profileIs');
      expect(p({}, { radio: 'R0' }, { profiler: ['R0'] }).sant).toBe(true);
      expect(p({}, { radio: 'R1' }, { profiler: ['R0'] }).sant).toBe(false);
    });

    test('stderrSignature: GPS_JUMP-signaturen ⇒ sant; annan signatur ⇒ falskt', () => {
      const { reg } = load();
      const p = pred(reg, 'stderrSignature');
      const re = '\\[GPS_JUMP(_DETECTED)?\\]';
      expect(p({ klass: '[APP ERROR] 🚨 [GPS_JUMP] M: GPS jump detected Nm' }, {}, { regex: re }).sant).toBe(true);
      expect(p({ klass: '[APP ERROR] TypeError: x' }, {}, { regex: re }).sant).toBe(false);
    });

    test('lateralOffset: fix 400 m från farleden ⇒ sant; på farleden ⇒ falskt', () => {
      const { reg, platser } = load();
      const p = pred(reg, 'lateralOffset');
      const f = { mmsi: '211000050', t: T0 };
      expect(p(f, { rader: [row(platser, '211000050', T0, 3000, { lateralM: 400 })] }).sant).toBe(true);
      expect(p(f, { rader: [row(platser, '211000050', T0, 3000)] }).sant).toBe(false);
    });

    test('stressDensity: kedja med 6 korsningar ⇒ sant; tre ⇒ falskt; uppmätt täthet vinner', () => {
      const { reg } = load();
      const p = pred(reg, 'stressDensity');
      const chain = (n) => Array.from({ length: n }, (_, i) => ({
        mmsi: String(211000060 + i), bridge: 'Klaffbron', dir: 'nord', kind: 'line', inferred: false, t: T0 + i * 8 * MIN,
      }));
      expect(p({}, { gt: chain(6) }).sant).toBe(true);
      expect(p({}, { gt: chain(3) }).sant).toBe(false);
      expect(p({}, { täthet: { stress: true }, gt: chain(1) }).sant).toBe(true);
      expect(p({}, { täthet: { stress: false }, gt: chain(6) }).sant).toBe(false);
    });

    test('passedForm: already_passed + eta −1 ⇒ sant; förvarningsform ⇒ falskt', () => {
      const { reg } = load();
      const p = pred(reg, 'passedForm');
      expect(p({ belägg: { notis: { alreadyPassed: true, eta: -1 } } }).sant).toBe(true);
      expect(p({ belägg: { notis: { alreadyPassed: false, eta: 3 } } }).sant).toBe(false);
    });

    test('l0Interruption: L0-U-sväng efter varningen ⇒ sant; inget avbrott ⇒ falskt', () => {
      const { reg } = load();
      const p = pred(reg, 'l0Interruption');
      const f = { mmsi: '211000070', t: T0, belägg: { varning: { t: T0, mmsis: ['211000070'] } } };
      expect(p(f, { sanning: { uturns: [{ mmsi: '211000070', t: T0 + 10 * MIN }], stops: [] } }).sant).toBe(true);
      expect(p(f, { sanning: { uturns: [], stops: [{ mmsi: '211000070', tIn: T0 + MIN, tOut: T0 + 3 * MIN }] } }).sant).toBe(false);
      expect(p(f, {}).sant).toBe(false);
    });

    test('effectiveSpeedBelow: 6 kn ⇒ sant; 12 kn ⇒ falskt', () => {
      const { reg } = load();
      const p = pred(reg, 'effectiveSpeedBelow');
      expect(p({ belägg: { veffKn: 6 } }).sant).toBe(true);
      expect(p({ belägg: { veffKn: 12 } }).sant).toBe(false);
    });

    test('stillNearBridge: stilla 300 m före Klaffbron ⇒ sant; 500 m ⇒ falskt', () => {
      const { reg, platser } = load();
      const p = pred(reg, 'stillNearBridge');
      const sK = platser.stationS('Klaffbron');
      const f = { mmsi: '211000080', bro: 'Klaffbron', t: T0 };
      expect(p(f, { rader: [row(platser, '211000080', T0 - MIN, sK - 300, { sog: 0 })] }).sant).toBe(true);
      expect(p(f, { rader: [row(platser, '211000080', T0 - MIN, sK - 500, { sog: 0 })] }).sant).toBe(false);
    });

    test('alltid och aldrig', () => {
      const { reg } = load();
      expect(pred(reg, 'alltid')({}).sant).toBe(true);
      expect(pred(reg, 'aldrig')({}).sant).toBe(false);
    });
  });

  test('klassningen: GPS_JUMP-signatur är DESIGN, KIE-varianten ACCEPTERAD och taggposten taggar', () => {
    const { reg } = load();
    const r = reg.loadRegistry();
    const corpora = require(path.join('..', '..', 'corpora'));
    const gps = r.classify({ orakel: 'H3', klass: '[APP ERROR] 🚨 [GPS_JUMP] M: GPS jump detected Nm - COG: N°, Speed mismatch: true' }, {});
    expect(gps).toMatchObject({ klass: 'DESIGN', post: 'GPS_JUMP-DIAGNOSTIK' });
    const msg = 'DEFAULT-FLASH: 2026-08-06T08:47:07.040Z "Inga båtar" inklämd (56s) mellan två "En … Stridsbergsbron"-texter utan passage';
    const kie = r.classify({
      orakel: 'INV-F', klass: 'INV-14 DEFAULT-FLASH', inv: 'INV-14', detalj: msg, t: Date.parse('2026-08-06T08:47:07.040Z'), bro: 'Stridsbergsbron',
    }, { korpus: corpora.find((c) => c.id === '20260806-42h'), rader: [], resultat: {} });
    expect(kie).toMatchObject({ klass: 'ACCEPTERAD', post: 'KIE-PER-KORPUS' });
    const stress = r.classify({ orakel: 'T2', klass: 'LEDTID<60s', t: T0 }, { täthet: { stress: true } });
    expect(stress.klass).toBe('KANDIDAT');
    expect(stress.taggar).toEqual(['STRESS-TÄTHET']);
    expect(r.användning['GPS_JUMP-DIAGNOSTIK']).toBe(1);
  });
});
