'use strict';

/**
 * RADIOMODELLEN, BUGGJAKT.md §4.2: vad appen faktiskt får se av den fysiska
 * världen.
 *
 * R0 idealradio: fast intervall 30 s, klass A, aisstream, inget brus, inga
 *    namnglapp och ingen sen födelse. Ett fel som syns här har ingen
 *    observerbarhetsursäkt.
 * R1 fältlik radio (OKALIBRERAD i v1, realismgrinden är röd): kadens per era,
 *    klass och rörelse ur fältets kvantiler; AISHub-poll var 65 + U(0, 5) s
 *    med fixålder och sekundupplöst fixTs; brus på sog, cog och GPS;
 *    namnbackfill för klass B (25 % börjar som Unknown); sen födelse.
 *
 * RÖRELSETILLSTÅNDET (BUGGJAKT.md §4.2) är fysiskt och har ingen fartgräns:
 * en båt är STILLA bara när banans fart är exakt 0 (kö- eller stoppväntan,
 * kajliggare), annars I RÖRELSE, hur långsamt den än kryper. Tillståndet styr
 * allt som beror på rörelse: sog, cog, navStatus, GPS-bruset, kadensregimen
 * och AISHub-fixåldern. I rörelse är sog = |v| i knop (R1 med fartbrus) och
 * cog = rörelseriktningen längs farleden (R1 med fältets cog-fel); bara en
 * stilla båt får stillaliggarmodellen (sog 0 eller brus kring 0, slumpad
 * eller saknad cog, stillakadens). Tidigare gick gränsen vid |v| ≥ 0,25 m/s
 * (≈ 0,49 kn), så en krypande båt rapporterade sog 0 även i R0 (M02).
 *
 * Varje båt har en egen slumpström `radio-<mmsi>`, och AISHub-pollens tider
 * kommer ur en världsström som inte beror på vilka båtar som finns. Därför
 * kan krympningen ta bort en båt utan att de andras observationer ändras.
 *
 * RADION SKRIVER ALDRIG I SPECEN. Slumputfall som namnfördröjning bokförs i
 * en separat radiorealisering som returneras bredvid raderna.
 *
 * Under ctrl:disconnect levereras inga rader (appen är bortkopplad).
 * Ctrl-rader får numerisk epok-ms-aisTimestamp.
 */

const geo = require('./geo');
const cal = require('./calib');
const { stream } = require('./rng');
const { truthAt, KN } = require('./world');

const M_PER_DEG_LAT = 111320;

/** Radioprofilerna. Båtens egna fält (fixedIntervalS, noise, nameLagMin, firstHeardS) går före. */
const PROFILES = {
  R0: {
    id: 'R0', era: 'aisstream', intervalS: 30, forceClassA: true, noise: false, nameLag: false, lateBirth: false,
  },
  R1: {
    id: 'R1', era: null, intervalS: null, forceClassA: false, noise: true, nameLag: true, lateBirth: true,
  },
};

/**
 * Slå ihop profilnamn och eventuella överskrivningar.
 * @param {string|object} profile - 'R0', 'R1' eller ett profilobjekt
 * @param {object} [overrides] - fält att skriva över
 * @returns {object} profil
 */
function resolveProfile(profile, overrides = {}) {
  const base = typeof profile === 'string' ? PROFILES[profile] : profile;
  if (!base) throw new Error(`Okänd radioprofil: ${profile}`);
  return { ...base, ...overrides };
}

function noisyPos(rnd, p, sigmaM) {
  const dN = rnd.normal() * sigmaM;
  const dE = rnd.normal() * sigmaM;
  return {
    lat: p.lat + (dN / M_PER_DEG_LAT),
    lon: p.lon + (dE / (M_PER_DEG_LAT * Math.cos((p.lat * Math.PI) / 180))),
  };
}

const r1 = (x) => Math.round(x * 10) / 10;
const r5 = (x) => Math.round(x * 1e5) / 1e5;

/**
 * Det fysiska rörelsetillståndet för en banpunkt: i rörelse när |v| > 0,
 * stilla bara vid v = 0 (väntan i kö eller stopp och kajliggare sätter v
 * exakt till 0 i world.js). Ingen fartgräns: en båt som kryper i 0,1 kn är i
 * rörelse och rapporterar sin fart.
 * @param {object} p - banpunkt ur world.js
 * @returns {boolean} true om båten rör sig
 */
const inMotion = (p) => Math.abs(p.v) > 0;

/**
 * Bygg en positionsrad. Fältnamnen följer korpusarnas format; `timestamp`
 * och `fixFeed` används aldrig (runnern ignorerar dem tyst).
 *
 * I rörelse: sog = |v| i knop (R1: + N(0; 0,15) kn, aldrig under 0) och
 * cog = färdriktningen längs farleden (R1: ± fältets cog-fel mot farleden).
 * Stilla (v = 0): sog 0 (R1: fältets stillabrus 0/0,1/0,2–0,4 kn) och cog =
 * farledsriktningen (R1: slumpad, för klass B saknad i 35 %). navStatus för
 * klass A: 5 vid kaj, 0 (under gång) i rörelse, annars båtens stillastatus.
 */
function makeRow(ctx, p, tFixMs, tRecvMs, feed) {
  const {
    rnd, b, cls, noise, nameState,
  } = ctx;
  const moving = inMotion(p);
  let { lat } = p;
  let { lon } = p;
  if (noise) {
    // 1 % uteliggare på 15–40 m, annars 3,5 m i rörelse och 2 m stilla.
    let sigma = moving ? 3.5 : 2.0;
    if (rnd.chance(0.01)) sigma = rnd.range(15, 40);
    const pos = noisyPos(rnd, p, sigma);
    lat = pos.lat;
    lon = pos.lon;
  }
  let sog;
  if (moving) sog = Math.max(0, r1((Math.abs(p.v) / KN) + (noise ? rnd.normal() * 0.15 : 0)));
  else if (noise) sog = rnd.weighted([[0, 0.8], [0.1, 0.13], [r1(rnd.range(0.2, 0.4)), 0.07]]);
  else sog = 0;
  let heading = null;
  if (p.bearing !== null && p.bearing !== undefined) heading = p.dir === -1 ? (p.bearing + 180) % 360 : p.bearing;
  let cog;
  if (moving) {
    cog = noise
      ? r1((heading + ((rnd.chance(0.5) ? 1 : -1) * cal.cogErr(rnd.u())) + 360) % 360)
      : r1(heading);
  } else if (noise) {
    cog = (cls === 'B' && rnd.chance(0.35)) ? null : r1(rnd.range(0, 359.9));
  } else cog = heading === null ? 0 : r1(heading);
  let navStatus = null;
  if (cls === 'A') {
    if (b.role === 'moored') navStatus = 5;
    else if (moving) navStatus = 0;
    else navStatus = Number.isFinite(b.navStillStatus) ? b.navStillStatus : 0;
  }
  let msgType = 'AISHubPosition';
  if (feed !== 'aishub') msgType = cls === 'A' ? 'PositionReport' : 'StandardClassBPositionReport';
  return {
    mmsi: String(b.mmsi),
    msgType,
    lat: feed === 'aishub' ? r5(lat) : lat,
    lon: feed === 'aishub' ? r5(lon) : lon,
    sog,
    cog,
    navStatus,
    shipName: nameState(tFixMs),
    aisTimestamp: tRecvMs,
    fixTs: tFixMs,
    feed,
    receivedAt: new Date(tRecvMs).toISOString(),
  };
}

/** Tysta intervall [från, till) i sekunder ur världens ctrl-händelser. */
function silenceWindows(world) {
  const evs = [...(world.events || [])].sort((a, b) => a.atS - b.atS);
  const out = [];
  for (const e of evs) {
    if (e.ctrl !== 'disconnect') continue;
    const rec = evs.find((x) => x.ctrl === 'reconnect' && x.atS > e.atS);
    out.push([e.atS, rec ? rec.atS : Number.MAX_SAFE_INTEGER]);
  }
  return out;
}

/** AISHub-pollens tider (s) — en världsström, oberoende av båtarna. */
function pollTimes(radioSeed, fromS, toS) {
  const rnd = stream(radioSeed, 'aishub-poll');
  const out = [];
  let P = rnd.range(0, 65);
  while (P < fromS) P += 65 + rnd.range(0, 5);
  while (P <= toS) {
    out.push(P);
    P += 65 + rnd.range(0, 5);
  }
  return out;
}

/**
 * Observera en simulerad värld genom en radioprofil.
 * @param {{world:object, boats:object[]}} sim - simulateWorld-resultat
 * @param {object} [opts] - {profile:'R0'|'R1'|objekt, overrides, radioSeed}
 * @returns {{rows:object[], realisation:object, profile:object}} rader i
 *   leveransordning, radiorealisering per mmsi och den använda profilen
 */
function observeWorld(sim, opts = {}) {
  const { world } = sim;
  const profile = resolveProfile(opts.profile || 'R1', opts.overrides);
  const era = profile.era || world.era || 'aisstream';
  const T0 = world.startMs;
  const silences = silenceWindows(world);
  const silent = (tS) => silences.some(([a, z]) => tS >= a && tS < z);
  const baseSeed = Number.isFinite(opts.radioSeed) ? opts.radioSeed : (world.radioSeed ?? world.seed);
  const rows = [];
  const realisation = {};
  let polls = null;
  for (const bt of sim.boats) {
    const b = bt.spec;
    const tr = bt.traj;
    if (!tr.length) continue;
    const rnd = stream(baseSeed, `radio-${b.mmsi}`);
    const cls = profile.forceClassA ? 'A' : b.cls;
    const noise = profile.noise && b.noise !== false;
    // Namnbackfill (aisstream, klass B): 'Unknown' tills fördröjningen löpt ut.
    let nameKnownAtMs = -Infinity;
    if (profile.nameLag && era === 'aisstream' && cls === 'B') {
      let delayMin = null;
      if (b.nameLagMin !== undefined && b.nameLagMin !== null) delayMin = b.nameLagMin;
      else if (rnd.chance(0.25)) delayMin = rnd.chance(0.15) ? 'aldrig' : cal.nameDelayMin(rnd.u());
      if (delayMin === 'aldrig') nameKnownAtMs = Infinity;
      else if (Number.isFinite(delayMin) && delayMin > 0) nameKnownAtMs = T0 + ((tr[0].t + (delayMin * 60)) * 1000);
      if (delayMin !== null && delayMin !== 0) {
        realisation[b.mmsi] = { nameUnknownMin: delayMin === 'aldrig' ? 'aldrig' : Math.round(delayMin * 100) / 100 };
      }
    }
    const nameState = (tMs) => (tMs < nameKnownAtMs ? 'Unknown' : b.name);
    const lateBirth = profile.lateBirth && Number.isFinite(b.firstHeardS);
    const firstHeard = (p) => !lateBirth || (b.dir === 'north' ? p.s >= b.firstHeardS : p.s <= b.firstHeardS);
    let heard = false;
    const ctx = {
      rnd, b, cls, noise, nameState,
    };
    const fixedIv = Number.isFinite(b.fixedIntervalS) ? b.fixedIntervalS : profile.intervalS;
    // Kadensregimen följer rörelsetillståndet (inMotion), inte sog: fältets
    // transitkvantiler i rörelse och stillakvantilerna vid v = 0. Fältet har
    // kadens bara för transit (sog ≥ 2 kn) och stilla (sog < 0,3 kn, < 60 m
    // mellan fixarna); AIS-klassernas fartberoende sändregler (klass B
    // ≤ 2 kn var 3:e min) modelleras inte i v1 (BUGGJAKT.md §4.5).
    const interval = (feed, moving) => (Number.isFinite(fixedIv)
      ? fixedIv
      : cal.cadence[feed][cls][moving ? 'move' : 'still'](rnd.u()));
    const tEnd = tr[tr.length - 1].t;
    if (era === 'aisstream') {
      let tS = tr[0].t + (Number.isFinite(fixedIv) ? rnd.range(0, fixedIv) : rnd.range(0, 30));
      while (tS <= tEnd) {
        const p = truthAt(bt, tS);
        if (!p) break;
        const moving = inMotion(p);
        heard = heard || firstHeard(p);
        if (!heard || !geo.inRadioBox(p.lat, p.lon)) {
          tS += 10; // utanför hörhåll: avsök i stället för att slösa ett svansintervall
          continue;
        }
        if (!silent(tS)) {
          const tMs = T0 + Math.round(tS * 1000);
          rows.push(makeRow(ctx, p, tMs, tMs, 'aisstream'));
        }
        tS += Math.max(10, interval('aisstream', moving));
      }
    } else {
      // AISHub: pollkvantiserad leverans, fixålder och sekundupplöst fixTs.
      if (!polls) {
        const tMax = Math.max(...sim.boats.map((x) => (x.traj.length ? x.traj[x.traj.length - 1].t : 0)));
        polls = pollTimes(baseSeed, 0, tMax + 70);
      }
      let lastFix = -Infinity;
      let due = tr[0].t;
      for (const P of polls) {
        if (P < tr[0].t) continue;
        if (P > tEnd + 70) break;
        const pNow = truthAt(bt, Math.min(P, tEnd));
        if (!pNow) continue;
        const moving = inMotion(pNow);
        const age = moving ? cal.ageMove(rnd.u()) : cal.ageStill(rnd.u());
        const fixS = Math.floor(P - age);
        if (fixS < due - 35 || fixS <= lastFix) continue;
        const p = truthAt(bt, fixS);
        if (!p) continue;
        heard = heard || firstHeard(p);
        if (!heard || !geo.inRadioBox(p.lat, p.lon) || silent(P)) {
          due = fixS + 60;
          continue;
        }
        lastFix = fixS;
        due = fixS + interval('aishub', moving);
        const recvMs = T0 + Math.round(P * 1000) + rnd.int(0, 150);
        rows.push(makeRow(ctx, p, T0 + (fixS * 1000), recvMs, 'aishub'));
      }
    }
  }
  for (const e of world.events || []) rows.push({ ctrl: e.ctrl, aisTimestamp: T0 + Math.round(e.atS * 1000) });
  rows.sort((a, b) => (a.aisTimestamp - b.aisTimestamp)
    || ((a.ctrl ? 0 : 1) - (b.ctrl ? 0 : 1))
    || String(a.mmsi || '').localeCompare(String(b.mmsi || ''))
    || ((a.fixTs || 0) - (b.fixTs || 0)));
  return { rows, realisation, profile };
}

const CTRL = new Set(['disconnect', 'reconnect', 'restart']);
const FEEDS = new Set(['aisstream', 'aishub']);

/**
 * Generatorns eftervillkor på raderna (samma regler som BUGGJAKT.md §3 och
 * schema.js): epok-ms-aisTimestamp på alla rader, känd ctrl, 9-siffrigt mmsi
 * som sträng, ändliga lat/lon, fixTs ≤ aisTimestamp, känd feed och inga
 * fältnamn `timestamp`/`fixFeed`. Kastar med radnummer (1-baserat).
 * @param {object[]} rows - rader
 * @returns {number} antal rader
 */
function checkRows(rows) {
  rows.forEach((r, i) => {
    const where = `rad ${i + 1}`;
    if (!r || typeof r !== 'object') throw new Error(`${where}: inte ett objekt`);
    if ('timestamp' in r || 'fixFeed' in r) throw new Error(`${where}: förbjudet fältnamn timestamp/fixFeed`);
    if (typeof r.aisTimestamp !== 'number' || !Number.isFinite(r.aisTimestamp)
        || r.aisTimestamp < 1.5e12 || r.aisTimestamp > 4.1e12) {
      throw new Error(`${where}: aisTimestamp ${JSON.stringify(r.aisTimestamp)} är inte epok-ms i [1,5e12; 4,1e12]`);
    }
    if (r.ctrl !== undefined) {
      if (!CTRL.has(r.ctrl)) throw new Error(`${where}: okänd ctrl ${JSON.stringify(r.ctrl)}`);
      return;
    }
    if (typeof r.mmsi !== 'string' || !/^\d{9}$/.test(r.mmsi)) throw new Error(`${where}: mmsi ${JSON.stringify(r.mmsi)} är inte en 9-siffrig sträng`);
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) throw new Error(`${where}: lat/lon är inte ändliga`);
    if (r.fixTs !== undefined && (!Number.isFinite(r.fixTs) || r.fixTs > r.aisTimestamp)) {
      throw new Error(`${where}: fixTs ${r.fixTs} > aisTimestamp ${r.aisTimestamp}`);
    }
    if (r.feed !== undefined && !FEEDS.has(r.feed)) throw new Error(`${where}: okänd feed ${JSON.stringify(r.feed)}`);
  });
  return rows.length;
}

/** Rader som jsonl-text (en rad per objekt, avslutande radbrytning). */
const toJsonl = (rows) => `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`;

module.exports = {
  PROFILES, resolveProfile, inMotion, observeWorld, silenceWindows, pollTimes, checkRows, toJsonl,
};
