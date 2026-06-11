'use strict';

/**
 * Syntetisk scenariogenerator (2026-06-11) — plan §E punkt 3.
 *
 * Genererar deterministiska (seedade) AIS-resor genom den RIKTIGA kanal-
 * geometrin (broarna läses ur constants) och producerar samples i exakt
 * samma jsonl-format som produktionskorpusarna. Det här är den proaktiva
 * pusselbiten: parametersvep över scenarier som ALDRIG inträffat i någon
 * korpus — fart × rapportintervall × AIS-glapp × stopp × U-svängar ×
 * GPS-brus/hopp × flertrafik — uppspelade genom samma replay-harness och
 * dömda av samma facit-oberoende invarianter.
 *
 * Determinism: mulberry32-seedad PRNG; ingen Date.now — bastid är fast.
 */

const constants = require('../../lib/constants');

const M_PER_DEG_LAT = 111320;
const BASE_TIME_MS = Date.UTC(2026, 0, 1, 6, 0, 0); // fast bastid

/** Seedad PRNG (mulberry32) — reproducerbara scenarier. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mPerDegLon(lat) {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Kanalens centrumlinje syd→nord: förlängning − brokedja − förlängning. */
function buildPath() {
  const B = constants.BRIDGES;
  const chain = ['olidebron', 'klaffbron', 'jarnvagsbron', 'stridsbergsbron', 'stallbackabron']
    .map((id) => ({ lat: B[id].lat, lon: B[id].lon, name: B[id].name }));

  // Punkt = from − riktning(from→towards) · meters (förlängning bortom kedjan)
  const extrapolate = (from, towards, meters) => {
    const dLatM = (towards.lat - from.lat) * M_PER_DEG_LAT;
    const dLonM = (towards.lon - from.lon) * mPerDegLon(from.lat);
    const len = Math.hypot(dLatM, dLonM);
    return {
      lat: from.lat - (dLatM / len) * (meters / M_PER_DEG_LAT),
      lon: from.lon - (dLonM / len) * (meters / mPerDegLon(from.lat)),
      name: 'extension',
    };
  };

  const south = extrapolate(chain[0], chain[1], 1500); // 1,5 km söder om Olidebron
  const north = extrapolate(chain[4], chain[3], 1200); // 1,2 km norr om Stallbackabron
  return [south, ...chain, north];
}

/** Kumulativa segmentlängder (meter) längs polylinjen. */
function pathMetrics(path) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    const dLatM = (path[i].lat - path[i - 1].lat) * M_PER_DEG_LAT;
    const dLonM = (path[i].lon - path[i - 1].lon) * mPerDegLon(path[i - 1].lat);
    cum.push(cum[i - 1] + Math.hypot(dLatM, dLonM));
  }
  return { cum, total: cum[cum.length - 1] };
}

/** Position + segmentbäring vid meterposition s längs polylinjen. */
function pointAt(path, metrics, s) {
  const clamped = Math.max(0, Math.min(metrics.total, s));
  let i = 1;
  while (i < metrics.cum.length - 1 && metrics.cum[i] < clamped) i++;
  const a = path[i - 1];
  const b = path[i];
  const segLen = metrics.cum[i] - metrics.cum[i - 1];
  const f = segLen > 0 ? (clamped - metrics.cum[i - 1]) / segLen : 0;
  const lat = a.lat + (b.lat - a.lat) * f;
  const lon = a.lon + (b.lon - a.lon) * f;
  const bearing = (Math.atan2(
    (b.lon - a.lon) * mPerDegLon(a.lat),
    (b.lat - a.lat) * M_PER_DEG_LAT,
  ) * 180) / Math.PI;
  return { lat, lon, bearing: (bearing + 360) % 360 };
}

/**
 * Generera en resa.
 * @param {Object} opts
 * @param {string} opts.mmsi
 * @param {string} [opts.name]
 * @param {'north'|'south'} opts.direction
 * @param {number} opts.speedKn - marschfart
 * @param {number} [opts.reportIntervalS=60] - AIS-rapportintervall
 * @param {number} [opts.startOffsetS=0] - starttid relativt scenariots bas
 * @param {{atFraction:number,durationS:number}} [opts.gap] - AIS-tystnad (båten fortsätter)
 * @param {{atFraction:number,durationS:number}} [opts.stop] - fysiskt stopp (sänder med sog≈0)
 * @param {number} [opts.uTurnAtFraction] - vänd vid given andel av rutten
 * @param {number} [opts.jitterM=3] - GPS-brus (± meter, uniform)
 * @param {{atFraction:number,offsetM:number}} [opts.gpsJump] - transient teleport en sample
 * @param {{lat:number,lon:number,durationS:number,navStatus:number|null}} [opts.moorAt]
 *   - ligg still på fast punkt (utanför rutten) i durationS innan ev. rutt körs
 * @param {Function} rnd - seedad PRNG
 * @returns {Array<Object>} samples (jsonl-rader)
 */
function generateJourney(opts, rnd) {
  const path = buildPath();
  const metrics = pathMetrics(path);
  const interval = opts.reportIntervalS || 60;
  const speedMs = opts.speedKn * 0.5144;
  const jitter = opts.jitterM != null ? opts.jitterM : 3;
  const samples = [];
  let tS = opts.startOffsetS || 0;

  const jitterDeg = (lat) => ({
    dLat: ((rnd() * 2 - 1) * jitter) / M_PER_DEG_LAT,
    dLon: ((rnd() * 2 - 1) * jitter) / mPerDegLon(lat),
  });

  const push = (lat, lon, sog, cog, navStatus) => {
    const j = jitterDeg(lat);
    const ts = BASE_TIME_MS + Math.round(tS * 1000);
    samples.push({
      mmsi: opts.mmsi,
      msgType: 'PositionReport',
      lat: lat + j.dLat,
      lon: lon + j.dLon,
      sog: Math.max(0, sog + (rnd() * 0.2 - 0.1)),
      cog: (cog + (rnd() * 6 - 3) + 360) % 360,
      navStatus: opts.navStatusOverride != null ? opts.navStatusOverride : navStatus,
      shipName: opts.name || `SYNT-${opts.mmsi.slice(-4)}`,
      aisTimestamp: ts,
      receivedAt: new Date(ts).toISOString(),
    });
  };

  // Ev. förtöjningsfas på fast punkt först
  if (opts.moorAt) {
    const moorEnd = tS + opts.moorAt.durationS;
    while (tS < moorEnd) {
      push(opts.moorAt.lat, opts.moorAt.lon, 0.05, rnd() * 360, opts.moorAt.navStatus ?? null);
      tS += interval;
    }
    if (!opts.runRouteAfterMooring) return samples;
  }

  // Ruttfas
  const goingNorth = opts.direction === 'north';
  let s;
  if (opts.moorAt && opts.runRouteAfterMooring) {
    s = nearestPathS(path, metrics, opts.moorAt);
  } else {
    s = goingNorth ? 0 : metrics.total;
  }
  let dir = goingNorth ? 1 : -1;
  const fractionToS = (f) => (goingNorth ? f * metrics.total : (1 - f) * metrics.total);
  let stopRemaining = 0;
  let stopDone = false; // stoppet får bara trigga EN gång (annars evig retrigg på samma position)
  let uTurned = false;

  while (s >= 0 && s <= metrics.total) {
    const frac = goingNorth ? s / metrics.total : 1 - s / metrics.total;

    if (!uTurned && opts.uTurnAtFraction != null && frac >= opts.uTurnAtFraction) {
      dir = -dir;
      uTurned = true;
    }
    if (opts.stop && !stopDone && stopRemaining === 0
        && Math.abs(s - fractionToS(opts.stop.atFraction)) < speedMs * interval) {
      stopRemaining = opts.stop.durationS;
      stopDone = true;
    }

    const p = pointAt(path, metrics, s);
    let { lat } = p;
    const { lon } = p;
    const cog = dir === 1 ? p.bearing : (p.bearing + 180) % 360;

    if (opts.gpsJump && Math.abs(frac - opts.gpsJump.atFraction) < (speedMs * interval) / metrics.total) {
      lat += opts.gpsJump.offsetM / M_PER_DEG_LAT; // engångs-teleport i sidled/längsled
      opts.gpsJump = null; // bara en gång
    }

    const inGap = opts.gap
      && frac >= opts.gap.atFraction
      && tS < (opts.gap._startS != null ? opts.gap._startS + opts.gap.durationS : Infinity);
    if (opts.gap && frac >= opts.gap.atFraction && opts.gap._startS == null) {
      opts.gap._startS = tS; // tystnaden börjar här
    }

    if (!inGap) {
      push(lat, lon, stopRemaining > 0 ? 0.1 : opts.speedKn, cog, null);
    }

    tS += interval;
    if (stopRemaining > 0) {
      stopRemaining = Math.max(0, stopRemaining - interval);
    } else {
      s += dir * speedMs * interval;
    }
    if (uTurned && ((goingNorth && s <= 0) || (!goingNorth && s >= metrics.total))) break;
    if (samples.length > 1000) break; // säkerhetsspärr
  }

  return samples;
}

/** Närmaste meterposition på rutten för en godtycklig punkt (för avgång från kaj). */
function nearestPathS(path, metrics, pt) {
  let best = 0;
  let bestD = Infinity;
  for (let s = 0; s <= metrics.total; s += 25) {
    const p = pointAt(path, metrics, s);
    const d = Math.hypot((p.lat - pt.lat) * M_PER_DEG_LAT, (p.lon - pt.lon) * mPerDegLon(pt.lat));
    if (d < bestD) {
      bestD = d; best = s;
    }
  }
  return best;
}

/** Bygg ett komplett scenario (flera resor) till sorterade jsonl-samples. */
function generateScenario(scenario) {
  const rnd = mulberry32(scenario.seed || 1);
  const all = [];
  for (const v of scenario.vessels) {
    all.push(...generateJourney({ ...v }, rnd));
  }
  all.sort((a, b) => a.aisTimestamp - b.aisTimestamp);
  return all;
}

module.exports = {
  generateScenario, buildPath, pathMetrics, pointAt, BASE_TIME_MS,
};
