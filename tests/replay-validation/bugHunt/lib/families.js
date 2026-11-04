'use strict';

/**
 * TRAFIKFAMILJER, BUGGJAKT.md §4.4.
 *
 * Varje värld är 2–4 h lång och har en fokal familj plus bakgrundstrafik.
 * Familjerna har fasta vikter i v1 (ingen bandit). Bakgrundens ankomster
 * följer en Poissonprocess: realistisk täthet tar takten per lokal timme ur
 * banken (Klaffbronkorsningar/h), med 34 % följare; 20 % av världarna får
 * stresstäthet (1–3 ankomster/h). Nivån som REDOVISAS bestäms av uppmätt
 * täthet (truth.densityLevel), inte av avsikten.
 *
 * Specen är deklarativ JSON utan Infinity, NaN eller undefined. Världens seed
 * härleds ur (bas-seed, 'värld-<i>'), så värld i är densamma oavsett hur
 * många världar som körs.
 */

const geo = require('./geo');
const cal = require('./calib');
const { stream, deriveSeed } = require('./rng');
const { simulateBoat, KN } = require('./world');

const FAMILIES = ['F-TRANSIT', 'F-KONVOJ', 'F-MÖTE', 'F-KÖ', 'F-KRYP', 'F-USVÄNG', 'F-KAJ', 'F-SENFÖDD', 'F-AVBROTT'];

/** Fasta vikter i v1. Konvoj och kö väger tyngre: där ligger kända gränsfall. */
const FAMILY_WEIGHTS = {
  'F-TRANSIT': 10,
  'F-KONVOJ': 15,
  'F-MÖTE': 10,
  'F-KÖ': 15,
  'F-KRYP': 10,
  'F-USVÄNG': 10,
  'F-KAJ': 10,
  'F-SENFÖDD': 10,
  'F-AVBROTT': 10,
};

/** Familjens nyckelparametrar (gränssökningen i krympningens steg E). */
const KEY_PARAMS = {
  'F-TRANSIT': ['cruiseKn'],
  'F-KONVOJ': ['deltaS'],
  'F-MÖTE': ['deltaS'],
  'F-KÖ': ['distM', 'durS'],
  'F-KRYP': ['kn', 'withinM'],
  'F-USVÄNG': ['avståndM'],
  'F-KAJ': ['kajAvståndM'],
  'F-SENFÖDD': ['hördFöreM'],
  'F-AVBROTT': ['avbrottS'],
};

const STRESS_SHARE = 0.2;
const FOLLOWER_SHARE = 0.34; // fältets andel följare inom 0,5–6 min
const SOUTH_SHARE = 0.54;
const S_START = { north: -350, south: 7150 };
const NAMES = ['ALVA', 'BRISEN', 'CORDELIA', 'DAGNY', 'ELSA MARIA', 'FREJA', 'GUNHILD', 'HAVSORN', 'IRMA', 'JOLLY',
  'KAJSA', 'LINNEA', 'MASEN', 'NORDVIND', 'ORION', 'PELLE', 'QUEST', 'RUNA', 'SALTIS', 'TROLLA', 'ULLA', 'VEGA',
  'WILMA', 'XENIA', 'YRSA', 'ZELDA'];

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

/** Poisson(λ) genom inversion (λ är litet här). */
function poisson(rnd, lambda) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  for (;;) {
    p *= rnd.u();
    if (p <= L || k > 50) return k;
    k++;
  }
}

/** Första sekund (från världens start) då båten korsar stationen, eller null. */
function crossingTimeS(boat, bridge) {
  const { traj } = simulateBoat(boat);
  const sB = geo.stationByName[bridge].s;
  for (let i = 1; i < traj.length; i++) {
    const a = traj[i - 1].s - sB;
    const c = traj[i].s - sB;
    if ((a < 0 && c >= 0) || (a > 0 && c <= 0)) return traj[i - 1].t + (a / (a - c));
  }
  return null;
}

/** Första sekund då båten har högst `beforeM` kvar till bron, eller null. */
function timeAtDistanceBefore(boat, bridge, beforeM) {
  const { traj } = simulateBoat(boat);
  const sB = geo.stationByName[bridge].s;
  const dir = boat.dir === 'north' ? 1 : -1;
  const p = traj.find((x) => (sB - x.s) * dir <= beforeM);
  return p ? p.t : null;
}

/** Uppskattad tid (s) för en hel transit inklusive plan. */
function transitNeedS(b) {
  const base = 7500 / (Math.max(1.5, b.cruiseKn) * KN * 0.85);
  const waits = (b.plan || []).reduce((s, p) => s + (p.durS || 0), 0);
  const crawls = (b.plan || []).filter((p) => p.op === 'crawl').reduce((s, p) => s + (p.withinM / (p.kn * KN)), 0);
  return Math.round(base + waits + crawls + 300);
}

/**
 * Bygg världens fabrik: mmsi-allokering och båtkonstruktörer på världens
 * slumpström. Ordningen på dragningarna är fast, så samma seed ger samma spec.
 */
function makeFactory(rnd, world) {
  let mm = 265000000 + (rnd.int(1000, 99999) * 10);
  const usedNames = new Set();
  const nextMmsi = () => {
    mm += rnd.int(7, 97);
    return String(mm);
  };
  const nextName = () => {
    let n = rnd.pick(NAMES);
    let k = 2;
    while (usedNames.has(n)) n = `${rnd.pick(NAMES)} ${k++}`;
    usedNames.add(n);
    return n;
  };
  const backgroundPlan = (dir) => {
    const plan = [];
    const tags = [];
    if (rnd.chance(0.09)) {
      const sites = cal.QUEUE_SITES.filter((q) => q.dir === dir);
      if (sites.length) {
        const site = rnd.weighted(sites.map((q) => [q, q.n]));
        plan.push({
          op: 'queue', bridge: site.bridge, distM: Math.round(rnd.range(site.distM[0], site.distM[1])), durS: Math.round(Math.min(60, cal.queueDurMin(rnd.u())) * 60),
        });
        tags.push(`kö@${site.bridge}`);
      }
    } else if (rnd.chance(0.1)) {
      const bridge = rnd.pick(geo.TARGETS);
      plan.push({
        op: 'crawl', bridge, withinM: Math.round(rnd.range(150, 400)), kn: round1(rnd.range(0.8, 1.5)),
      });
      tags.push(`kryp@${bridge}`);
    }
    if (rnd.chance(0.03)) {
      const atS = Math.round(rnd.range(2350, 3200)); // Klaff–Jvb: 8 av fältets 17 vändningar
      if ((dir === 'north' && atS > 500) || (dir === 'south' && atS < 6500)) {
        plan.push({ op: 'uturn', atS });
        tags.push('u-sväng');
      }
    }
    return { plan: orderPlan(plan, dir), tags };
  };
  /** En transit; o.plan ersätter bakgrundsplanen. */
  const transit = (o = {}) => {
    let { cls } = o;
    if (!cls) {
      if (world.night) cls = 'A';
      else cls = rnd.chance(cal.classAShareDay) ? 'A' : 'B';
    }
    const dir = o.dir || (rnd.chance(SOUTH_SHARE) ? 'south' : 'north');
    const cruiseKn = round2(Number.isFinite(o.cruiseKn) ? o.cruiseKn : clamp(cal.cruise[cls](rnd.u()), 2.5, 9));
    const bg = o.plan ? { plan: orderPlan(o.plan, dir), tags: o.tags || [] } : backgroundPlan(dir);
    const b = {
      mmsi: nextMmsi(),
      name: nextName(),
      cls,
      role: 'transit',
      dir,
      tStartS: Math.round(o.tStartS || 0),
      sStart: S_START[dir],
      sEnd: S_START[dir === 'north' ? 'south' : 'north'],
      cruiseKn,
      laneM: round1(rnd.normal() * 6),
      queueLaneM: round1(rnd.normal() * 10),
      plan: bg.plan,
      tags: [cls === 'A' ? 'klass-A' : 'klass-B', dir === 'north' ? 'norrut' : 'söderut', ...bg.tags, ...(o.extraTags || [])],
      seed: rnd.int(1, 1e9),
      fokal: !!o.fokal,
    };
    if (Number.isFinite(o.firstHeardS)) b.firstHeardS = Math.round(o.firstHeardS);
    return b;
  };
  const moored = (o = {}) => {
    const quay = o.quay || rnd.pick(cal.QUAYS);
    return {
      mmsi: nextMmsi(),
      name: nextName(),
      cls: quay.cls,
      role: 'moored',
      quay: { lat: quay.lat, lon: quay.lon },
      tStartS: 0,
      durS: o.durS,
      tags: ['kajliggare', `kaj@${quay.nearest}${quay.dist}m`, ...(o.extraTags || [])],
      seed: rnd.int(1, 1e9),
      fokal: !!o.fokal,
    };
  };
  return {
    nextMmsi, transit, moored,
  };
}

/** Planen i färdordning; element efter en U-sväng nås aldrig och tas bort. */
function orderPlan(plan, dir) {
  const posOf = (p) => (p.op === 'uturn' || p.op === 'stop' ? p.atS : geo.stationByName[p.bridge].s);
  const out = [...plan].sort((a, b) => (dir === 'north' ? posOf(a) - posOf(b) : posOf(b) - posOf(a)));
  const u = out.findIndex((p) => p.op === 'uturn');
  if (u >= 0) out.splice(u + 1);
  return out;
}

/** Fokal starttid som låter transiten bli klar inom världen. */
function focalStart(rnd, world, needS) {
  const latest = world.durS - needS;
  if (latest < 400) world.durS = Math.min(5 * 3600, needS + 900);
  return Math.round(rnd.range(300, Math.max(301, world.durS - needS)));
}

const opposite = (dir) => (dir === 'north' ? 'south' : 'north');

/** Fokala byggare per familj. Returnerar {boats, events, parametrar}. */
const BUILDERS = {
  'F-TRANSIT': (rnd, world, f) => {
    // Bara bakgrundstrafik, men en fokal transit vars marschfart ibland
    // prövas nära deadline-taket (10 kn, BRIDGE_OPENING.DEADLINE_MAX_SPEED_KN).
    const kn = rnd.chance(0.15) ? round2(rnd.range(6, 11)) : undefined;
    const b = f.transit({ cruiseKn: kn, plan: [], fokal: true });
    b.tStartS = focalStart(rnd, world, transitNeedS(b));
    return { boats: [b], parametrar: { cruiseKn: b.cruiseKn } };
  },
  'F-KONVOJ': (rnd, world, f) => {
    const lead = f.transit({ plan: [], fokal: true, extraTags: ['konvojledare'] });
    const deltaS = Math.round(rnd.range(30, 780)); // 0,5–13 min
    const fol = f.transit({
      dir: lead.dir, cls: rnd.chance(0.5) ? lead.cls : undefined, plan: [], fokal: true, extraTags: ['konvojföljare'],
    });
    fol.cruiseKn = round2(clamp(lead.cruiseKn * rnd.range(0.9, 1.1), 2.5, 9));
    const need = Math.max(transitNeedS(lead), transitNeedS(fol)) + deltaS;
    lead.tStartS = focalStart(rnd, world, need);
    fol.tStartS = lead.tStartS + deltaS;
    return { boats: [lead, fol], parametrar: { deltaS } };
  },
  'F-MÖTE': (rnd, world, f) => {
    const bridge = rnd.pick(geo.TARGETS);
    const a = f.transit({ plan: [], fokal: true, extraTags: ['möte'] });
    const b = f.transit({
      dir: opposite(a.dir), plan: [], fokal: true, extraTags: ['möte'],
    });
    const deltaS = Math.round(rnd.range(-600, 600)); // B korsar bron Δ efter A
    const need = Math.max(transitNeedS(a), transitNeedS(b)) + 900;
    a.tStartS = focalStart(rnd, world, need);
    const ta = crossingTimeS(a, bridge);
    const tb0 = crossingTimeS({ ...b, tStartS: 0 }, bridge);
    if (ta === null || tb0 === null) throw new Error(`F-MÖTE: transiten korsar inte ${bridge}`);
    let startB = Math.round(ta + deltaS - tb0);
    if (startB < 60) {
      a.tStartS += 60 - startB;
      startB = 60;
    }
    b.tStartS = startB;
    world.durS = Math.max(world.durS, Math.min(5 * 3600, Math.max(a.tStartS + transitNeedS(a), b.tStartS + transitNeedS(b)) + 300));
    return { boats: [a, b], parametrar: { deltaS, bro: bridge } };
  },
  'F-KÖ': (rnd, world, f) => {
    const dir = rnd.chance(SOUTH_SHARE) ? 'south' : 'north';
    const sites = cal.QUEUE_SITES.filter((q) => q.dir === dir);
    const site = rnd.weighted(sites.map((q) => [q, q.n]));
    const distM = Math.round(rnd.range(site.distM[0], site.distM[1]));
    const durS = Math.round(Math.min(60, cal.queueDurMin(rnd.u())) * 60);
    const b = f.transit({
      dir,
      plan: [{
        op: 'queue', bridge: site.bridge, distM, durS,
      }],
      tags: [`kö@${site.bridge}`],
      fokal: true,
    });
    b.tStartS = focalStart(rnd, world, transitNeedS(b));
    return { boats: [b], parametrar: { bro: site.bridge, distM, durS } };
  },
  'F-KRYP': (rnd, world, f) => {
    const bridge = rnd.pick(geo.TARGETS);
    const withinM = Math.round(rnd.range(150, 400));
    // 0,4–1,5 kn. Radion rapporterar farten fysiskt i hela intervallet
    // (BUGGJAKT.md §4.2); före M02 blev krypfart under 0,49 kn sog 0.
    const kn = round1(rnd.range(0.4, 1.5));
    const b = f.transit({
      plan: [{
        op: 'crawl', bridge, withinM, kn,
      }],
      tags: [`kryp@${bridge}`],
      fokal: true,
    });
    b.tStartS = focalStart(rnd, world, transitNeedS(b));
    return { boats: [b], parametrar: { bro: bridge, kn, withinM } };
  },
  'F-USVÄNG': (rnd, world, f) => {
    const dir = rnd.chance(SOUTH_SHARE) ? 'south' : 'north';
    const sign = dir === 'north' ? 1 : -1;
    let pick = null;
    for (let k = 0; k < 20 && !pick; k++) {
      const st = rnd.weighted([[geo.stationByName.Olidebron, 1], [geo.stationByName.Klaffbron, 3],
        [geo.stationByName['Järnvägsbron'], 2], [geo.stationByName.Stridsbergsbron, 3], [geo.stationByName.Stallbackabron, 1]]);
      const sida = rnd.chance(0.5) ? 'före' : 'efter';
      const dist = Math.round(rnd.range(100, 900));
      const atS = sida === 'före' ? st.s - (sign * dist) : st.s + (sign * dist);
      const nearest = geo.STATIONS.map((x) => ({ name: x.name, d: Math.abs(x.s - atS) })).sort((a, b) => a.d - b.d)[0];
      const reachable = dir === 'north' ? atS > 400 : atS < 6600;
      if (reachable && atS > 100 && atS < 6900 && nearest.d >= 100) {
        pick = {
          atS, station: st.name, sida, dist, nearest,
        };
      }
    }
    if (!pick) {
      pick = {
        atS: dir === 'north' ? 2700 : 2700, station: 'Klaffbron', sida: dir === 'north' ? 'efter' : 'före', dist: 402, nearest: { name: 'Klaffbron', d: 402 },
      };
    }
    const b = f.transit({
      dir, plan: [{ op: 'uturn', atS: pick.atS }], tags: ['u-sväng'], fokal: true,
    });
    b.tStartS = focalStart(rnd, world, transitNeedS(b));
    return {
      boats: [b],
      parametrar: {
        station: pick.station, sida: pick.sida, avståndM: pick.dist, närmasteStation: pick.nearest.name, närmasteM: Math.round(pick.nearest.d),
      },
    };
  },
  'F-KAJ': (rnd, world, f) => {
    const quay = rnd.pick(cal.QUAYS);
    const m = f.moored({ quay, durS: world.durS, fokal: true });
    const boats = [m];
    if (rnd.chance(0.5)) {
      const b = f.transit({ plan: [], extraTags: ['förbi-kaj'] });
      b.tStartS = focalStart(rnd, world, transitNeedS(b));
      boats.push(b);
    }
    return { boats, parametrar: { kaj: quay.name, närmasteBro: quay.nearest, kajAvståndM: quay.dist } };
  },
  'F-SENFÖDD': (rnd, world, f) => {
    const bridge = rnd.pick(geo.TARGETS);
    const dir = rnd.chance(SOUTH_SHARE) ? 'south' : 'north';
    const before = Math.round(rnd.range(300, 1500));
    const firstHeardS = geo.stationByName[bridge].s - ((dir === 'north' ? 1 : -1) * before);
    const b = f.transit({
      dir, plan: [], tags: [`senfödd@${bridge}`], fokal: true, firstHeardS,
    });
    b.tStartS = focalStart(rnd, world, transitNeedS(b));
    return { boats: [b], parametrar: { bro: bridge, hördFöreM: before } };
  },
  'F-AVBROTT': (rnd, world, f) => {
    const bridge = rnd.pick(geo.TARGETS);
    const b = f.transit({ plan: [], tags: [`avbrott@${bridge}`], fokal: true });
    b.tStartS = focalStart(rnd, world, transitNeedS(b));
    const beforeM = Math.round(rnd.range(300, 2500));
    const durS = Math.round(rnd.range(60, 900)); // 1–15 min
    const t0 = timeAtDistanceBefore(b, bridge, beforeM);
    const atS = Math.round(t0 !== null ? t0 : b.tStartS + 600);
    return {
      boats: [b],
      events: [{ ctrl: 'disconnect', atS }, { ctrl: 'reconnect', atS: atS + durS }],
      parametrar: { bro: bridge, föreM: beforeM, avbrottS: durS },
    };
  },
};

/**
 * Bakgrundstrafik: Poissonankomster per timme (realistisk takt per lokal
 * timme ur banken, eller 1–3/h i stressvärldar), 34 % följare.
 */
function addBackground(rnd, world, f, stress) {
  const boats = [];
  const stressRate = stress ? rnd.range(1, 3) : null;
  const lastArrival = world.durS - 3600;
  for (let h = 0; h * 3600 < lastArrival; h++) {
    const hour = (world.localHour + h) % 24;
    const rate = stress ? stressRate : cal.hourRate[hour];
    const n = poisson(rnd, rate);
    for (let k = 0; k < n; k++) {
      const t = (h * 3600) + rnd.range(0, 3600);
      if (t >= lastArrival) continue;
      const b = f.transit({ tStartS: t });
      boats.push(b);
      if (rnd.chance(FOLLOWER_SHARE)) {
        const fo = f.transit({ tStartS: t + rnd.range(30, 360), dir: b.dir, extraTags: ['konvojföljare'] });
        boats.push(fo);
      }
    }
  }
  const nMoored = rnd.weighted([[0, 0.55], [1, 0.3], [2, 0.15]]);
  for (let i = 0; i < nMoored; i++) boats.push(f.moored({ durS: world.durS }));
  return boats;
}

/**
 * Bygg världen ur ett seed (utan index-härledning).
 * @param {number} seed - världens seed
 * @param {object} [opts] - {family, families, stress, era, hours, basSeed, index}
 * @returns {object} världens spec
 */
function buildWorld(seed, opts = {}) {
  const rnd = stream(seed, 'värld');
  const families = opts.families && opts.families.length ? opts.families : FAMILIES;
  for (const fam of families) if (!BUILDERS[fam]) throw new Error(`Okänd familj: ${fam}`);
  const family = opts.family || rnd.weighted(families.map((x) => [x, FAMILY_WEIGHTS[x]]));
  if (!BUILDERS[family]) throw new Error(`Okänd familj: ${family}`);
  const stressDraw = rnd.chance(STRESS_SHARE);
  const stress = typeof opts.stress === 'boolean' ? opts.stress : stressDraw;
  const day = rnd.int(0, 120); // juni–september 2026
  const localHour = rnd.weighted(cal.hourRate.map((r, h) => [h, r + 0.02]));
  const startMs = Date.UTC(2026, 5, 1, 0, 0, 0) + (day * 86400000)
    + ((((localHour - 2) + 24) % 24) * 3600000) + (rnd.int(0, 3599) * 1000);
  const hours = Number.isFinite(opts.hours) ? opts.hours : rnd.range(2, 4);
  const eraDraw = rnd.chance(0.5) ? 'aisstream' : 'aishub';
  const world = {
    version: 1,
    generator: 'bugHunt/families v1',
    seed,
    basSeed: Number.isFinite(opts.basSeed) ? opts.basSeed : null,
    index: Number.isFinite(opts.index) ? opts.index : null,
    familj: family,
    avseddTäthet: stress ? 'stress' : 'realistisk',
    startMs,
    durS: Math.round(hours * 3600),
    era: opts.era || eraDraw,
    night: localHour >= 22 || localHour < 6,
    localHour,
    radioSeed: seed,
    fokal: null,
    boats: [],
    events: [],
  };
  const f = makeFactory(rnd, world);
  const focal = BUILDERS[family](rnd, world, f);
  const background = addBackground(rnd, world, f, stress);
  world.boats = [...focal.boats, ...background];
  // Kajliggarna ligger kvar hela världen, även om en fokal transit förlängt den.
  for (const b of world.boats) if (b.role === 'moored') b.durS = world.durS;
  world.events = focal.events || [];
  world.fokal = {
    familj: family,
    mmsis: focal.boats.filter((b) => b.fokal).map((b) => b.mmsi),
    parametrar: focal.parametrar,
    nyckel: KEY_PARAMS[family],
  };
  return world;
}

/**
 * Värld i ur bas-seed (BUGGJAKT.md §3: seed ur strömmen (bas-seed, 'värld-i')).
 * @param {number} baseSeed - körningens bas-seed
 * @param {number} index - världens index
 * @param {object} [opts] - se buildWorld
 * @returns {object} världens spec
 */
function sampleWorld(baseSeed, index, opts = {}) {
  return buildWorld(deriveSeed(baseSeed, `värld-${index}`), { ...opts, basSeed: baseSeed, index });
}

/**
 * Kanarievärld (S-KANARIE): en eller två båtar på konstant fart utan plan,
 * idealiska förhållanden. Används av canaries/kanarier.json.
 * @param {object} p - {id, dir, kn, cls, intervalS, pairGapS, startMs}
 * @returns {object} världens spec
 */
function canarySpec(p) {
  const mk = (i, tStartS) => ({
    mmsi: String(265900100 + (i * 11)),
    name: `KANARIE ${i + 1}`,
    cls: p.cls,
    role: 'transit',
    dir: p.dir,
    tStartS,
    sStart: S_START[p.dir],
    sEnd: S_START[opposite(p.dir)],
    cruiseKn: p.kn,
    v0Kn: p.kn,
    laneM: 0,
    queueLaneM: 0,
    lateralSigma: 0,
    plan: [],
    tags: [p.cls === 'A' ? 'klass-A' : 'klass-B', p.dir === 'north' ? 'norrut' : 'söderut', 'kanarie'],
    seed: 7 + i,
    fokal: true,
    fixedIntervalS: p.intervalS,
  });
  const boats = [mk(0, 60)];
  if (Number.isFinite(p.pairGapS)) boats.push(mk(1, 60 + p.pairGapS));
  return {
    version: 1,
    generator: 'bugHunt/families v1 (kanarie)',
    seed: 42,
    basSeed: null,
    index: null,
    familj: 'S-KANARIE',
    avseddTäthet: 'realistisk',
    startMs: p.startMs || Date.UTC(2026, 6, 15, 8, 0, 0),
    durS: 3 * 3600,
    era: 'aisstream',
    night: false,
    localHour: 10,
    radioSeed: 42,
    fokal: {
      familj: 'S-KANARIE', mmsis: boats.map((b) => b.mmsi), parametrar: { id: p.id }, nyckel: [],
    },
    boats,
    events: [],
  };
}

module.exports = {
  FAMILIES, FAMILY_WEIGHTS, KEY_PARAMS, BUILDERS, buildWorld, sampleWorld, canarySpec, crossingTimeS, timeAtDistanceBefore, orderPlan,
};
