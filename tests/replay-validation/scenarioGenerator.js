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
 * @param {number} [opts.stopReportIntervalS] - glesare rapportintervall UNDER
 *   stoppet (NO LIMIT-klassen: ankrade båtar hörs var 12–18:e minut)
 * @param {number} [opts.uTurnAtFraction] - vänd vid given andel av rutten
 * @param {number} [opts.jitterM=3] - GPS-brus (± meter, uniform)
 * @param {{atFraction:number,offsetM:number}} [opts.gpsJump] - transient teleport en sample
 * @param {{lat:number,lon:number,durationS:number,navStatus:number|null}} [opts.moorAt]
 *   - ligg still på fast punkt (utanför rutten) i durationS innan ev. rutt körs
 * @param {number[]} [opts.navStatusPattern] - cykliskt navStatus-mönster under stop-fasen
 *   (t.ex. [0,5] = flappar var annan sample) — testar förtöjningslager 3-hysteres
 * @param {{fromFraction:number,toFraction:number,speedKn:number,afterUTurnOnly?:boolean}} [opts.slowZone]
 *   - sänkt fart i ett ruttintervall (RC3-klassen: sog-kollaps vid bron).
 *     afterUTurnOnly: zonen gäller bara returbenet efter U-svängen (R1: en
 *     långsam återkorsning utan att utresans rutnät flyttas)
 * @param {{atFraction:number,backM:number}} [opts.staleEcho] - EN fördröjd
 *   gammal position (backM bakom aktuell) mitt i resan — out-of-order-leverans
 * @param {number} [opts.duplicateEvery] - emittera varje N:e sample dubbelt
 * @param {number} [opts.nameFromS] - namnbackfill (B1/VALEN-klassen):
 *   shipName är "Unknown" tills resetid ≥ nameFromS sekunder — som aisstreams
 *   sena MetaData-backfill för Class B. Testar namncachen + notistokens.
 * @param {boolean} [opts.sogNull] - Class B utan fartgivare (helgranskningen
 *   2026-07-06): sog är null i VARJE rapport ("ej tillgänglig" enligt spec).
 *   Rörelsebevis/målbro/notiser ska bäras helt av positionsdeltan.
 * @param {Function} rnd - seedad PRNG
 * @returns {Array<Object>} samples (jsonl-rader)
 */
function generateJourney(opts, rnd) {
  if (Array.isArray(opts.legs)) return generateLegJourney(opts, rnd);
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
    // Namnbackfill (B1): före nameFromS är namnet "Unknown" — aisstream
    // backfyller Class B-namn sent (VALEN: 36 min).
    const realName = opts.name || `SYNT-${opts.mmsi.slice(-4)}`;
    const shipName = Number.isFinite(opts.nameFromS) && tS < opts.nameFromS
      ? 'Unknown'
      : realName;
    samples.push({
      mmsi: opts.mmsi,
      msgType: 'PositionReport',
      lat: lat + j.dLat,
      lon: lon + j.dLon,
      sog: opts.sogNull ? null : Math.max(0, sog + (rnd() * 0.2 - 0.1)),
      cog: (cog + (rnd() * 6 - 3) + 360) % 360,
      navStatus: opts.navStatusOverride != null ? opts.navStatusOverride : navStatus,
      shipName,
      aisTimestamp: ts,
      receivedAt: new Date(ts).toISOString(),
    });
  };

  // Ev. förtöjningsfas på fast punkt först
  if (opts.moorAt) {
    const moorEnd = tS + opts.moorAt.durationS;
    let moorIdx = 0;
    while (tS < moorEnd) {
      const navSt = Array.isArray(opts.navStatusPattern) && opts.navStatusPattern.length > 0
        ? opts.navStatusPattern[moorIdx % opts.navStatusPattern.length]
        : (opts.moorAt.navStatus ?? null);
      push(opts.moorAt.lat, opts.moorAt.lon, 0.05, rnd() * 360, navSt);
      tS += interval;
      moorIdx++;
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
  let stopIdx = 0;
  let echoDone = false;

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

    // Sänkt fart i zon (RC3-klassen: inbromsning genom bropassagen)
    const inSlowZone = opts.slowZone
      && (!opts.slowZone.afterUTurnOnly || uTurned)
      && frac >= opts.slowZone.fromFraction && frac <= opts.slowZone.toFraction;
    const cruiseKn = inSlowZone ? opts.slowZone.speedKn : opts.speedKn;
    const cruiseMs = cruiseKn * 0.5144;

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
      let navSt = null;
      if (stopRemaining > 0 && Array.isArray(opts.navStatusPattern) && opts.navStatusPattern.length > 0) {
        navSt = opts.navStatusPattern[stopIdx % opts.navStatusPattern.length];
        stopIdx++;
      }
      push(lat, lon, stopRemaining > 0 ? 0.1 : cruiseKn, cog, navSt);
      if (opts.duplicateEvery && samples.length % opts.duplicateEvery === 0) {
        samples.push({ ...samples[samples.length - 1] }); // exakt dubblett
      }
      // Out-of-order-leverans: EN fördröjd gammal position (bakom aktuell).
      // Mottagningstiden stämplas +1 s efter ordinarie samplet — precis som
      // produktionens receipt-stämpling gör att sen leverans ser ut som ett
      // spatialt BAKLÄNGES-hopp, inte som tidsskev.
      if (opts.staleEcho && !echoDone && frac >= opts.staleEcho.atFraction) {
        const backS = Math.max(0, Math.min(metrics.total, s - dir * opts.staleEcho.backM));
        const bp = pointAt(path, metrics, backS);
        tS += 1;
        push(bp.lat, bp.lon, cruiseKn, cog, null);
        tS -= 1;
        echoDone = true;
      }
    }

    const stepInterval = stopRemaining > 0 && Number.isFinite(opts.stopReportIntervalS)
      ? opts.stopReportIntervalS
      : interval;
    tS += stepInterval;
    if (stopRemaining > 0) {
      stopRemaining = Math.max(0, stopRemaining - stepInterval);
    } else {
      s += dir * cruiseMs * interval;
    }
    if (uTurned && ((goingNorth && s <= 0) || (!goingNorth && s >= metrics.total))) break;
    if (samples.length > 1200) break; // säkerhetsspärr
  }

  return samples;
}

/**
 * U14-revisionen (granskningen 2026-11-04): resa i BEN längs kanalens
 * centrumlinje, för förlopp som den enkla modellen (en vändning, ett stopp)
 * inte kan uttrycka: vända bortom en bro, gå tillbaka mot linjen, vänta där
 * med slumpad kurs och sedan fortsätta. Varje ben går från föregående läge
 * till `toS` (meter längs rutten) i `speedKn`, rapporterar var `intervalS`:e
 * sekund och kan ha ett AIS-glapp (`gapFromS`–`gapToS`, båten fortsätter).
 * Ett ben med `stopS` ligger still i så många sekunder och rapporterar var
 * `stopIntervalS`:e sekund, med sog 0,1 (eller `stopSog`) och, med
 * `stopCogRandom`, slumpad kurs. Brus, tidsbas och jsonl-format är desamma
 * som i generateJourney.
 *
 * Omgranskning 2 (2026-11-07): `stopSog` låter en väntande båts AIS
 * rapportera fart (fältet visar 0,5–1 kn hos båtar som ligger och väntar vid
 * en bro). Utan fältet blir farten 0,1 som förut, med samma slumptal.
 * Scenarier utan `legs` påverkas inte.
 *
 * Omgranskningen 2026-11-05: `intervalJitterS` lägger 0–J s slumpad extra tid
 * på varje rapportintervall i ett gående ben (Class B med jitter, AISHub).
 * Ben utan fältet drar inga extra slumptal, så äldre scenarier genereras
 * byte för byte som förut.
 *
 * Varv 2 (familj A, 2026-11-09): SANNA BANAN. Varje steg i benen lämnar en
 * punkt {tS, s} (sekunder från BASE_TIME_MS, meter längs rutten) i
 * `samples.truthPath`, en egenskap på den returnerade arrayen som aldrig når
 * jsonl-raderna. Banan är linjär mellan punkterna, precis som stegningen
 * flyttar båten, även genom AIS-glapp. generateScenario samlar den per MMSI
 * så att scenariosviten kan mäta ledtiden mot den SANNA korsningen
 * (förväntan openingLeadS) och inte mot appens bokföring, som vid gles AIS
 * kommer ett fix efter korsningen. Inga slumptal dras, så raderna är
 * byte för byte desamma som förut.
 *
 * Varv 2, familj C (M3): `cogDeg` ger ett gående ben en fast rapporterad kurs
 * (med samma ±3° brus) i stället för farledens bäring, till exempel en kurs i
 * dödbandet 46–134° eller 226–314° fast båten går längs kanalen. Fältet drar
 * inga extra slumptal; ben utan det genereras byte för byte som förut.
 *
 * Fältprovet 10–13 november (familj B): `stopCogDeg` ger ett stoppben en fast
 * rapporterad kurs (±3° brus), till exempel de omvända fixen i en vändning
 * på stället där båten bara flyttat några meter men rapporterar fart och ny
 * kurs. `fixLagS` gör benets rader till AISHub-fix: fixtiden ligger så många
 * sekunder före mottagningen (`fixTs`, `feed: 'aishub'`), som i fältet där
 * AISHub levererar fixen 20–40 s gamla. Inga av fälten drar slumptal, och
 * ben utan dem genereras byte för byte som förut.
 * @param {Object} opts - {mmsi, name, startS, legs, jitterM?, startOffsetS?}
 * @param {Function} rnd - seedad PRNG
 * @returns {Array<Object>} samples (jsonl-rader), med `truthPath`
 */
function generateLegJourney(opts, rnd) {
  const path = buildPath();
  const metrics = pathMetrics(path);
  const jitter = opts.jitterM != null ? opts.jitterM : 3;
  const samples = [];
  let tS = opts.startOffsetS || 0;
  let s = opts.startS;
  const truthPath = [{ tS, s }];
  const push = (sNow, sog, dir, cogOverride, fixLagS) => {
    const p = pointAt(path, metrics, sNow);
    const dLat = ((rnd() * 2 - 1) * jitter) / M_PER_DEG_LAT;
    const dLon = ((rnd() * 2 - 1) * jitter) / mPerDegLon(p.lat);
    let cog = Number.isFinite(cogOverride) ? cogOverride : p.bearing;
    if (!Number.isFinite(cogOverride) && dir < 0) cog = (p.bearing + 180) % 360;
    const ts = BASE_TIME_MS + Math.round(tS * 1000);
    const sample = {
      mmsi: opts.mmsi,
      msgType: 'PositionReport',
      lat: p.lat + dLat,
      lon: p.lon + dLon,
      sog: Math.max(0, sog + (rnd() * 0.2 - 0.1)),
      cog: (cog + (rnd() * 6 - 3) + 360) % 360,
      navStatus: null,
      shipName: opts.name || `SYNT-${opts.mmsi.slice(-4)}`,
      aisTimestamp: ts,
      receivedAt: new Date(ts).toISOString(),
    };
    // AISHub-fix (fixLagS): samma rad, men fixtiden ligger före mottagningen.
    // Utan fältet får raden inga nya nycklar (byte för byte som förut).
    if (Number.isFinite(fixLagS) && fixLagS > 0) {
      sample.msgType = 'AISHubPosition';
      sample.fixTs = ts - Math.round(fixLagS * 1000);
      sample.feed = 'aishub';
    }
    samples.push(sample);
  };
  for (const leg of opts.legs) {
    const interval = leg.intervalS || 60;
    if (leg.stopS) {
      const end = tS + leg.stopS;
      const stopInterval = leg.stopIntervalS || interval;
      while (tS < end) {
        const stopCog = leg.stopCogRandom ? rnd() * 360 : leg.stopCogDeg;
        push(s, Number.isFinite(leg.stopSog) ? leg.stopSog : 0.1, 1, stopCog, leg.fixLagS);
        tS += stopInterval;
      }
      truthPath.push({ tS, s });
      continue;
    }
    const dir = leg.toS >= s ? 1 : -1;
    const inGap = (x) => Number.isFinite(leg.gapFromS) && Number.isFinite(leg.gapToS)
      && x >= Math.min(leg.gapFromS, leg.gapToS) && x <= Math.max(leg.gapFromS, leg.gapToS);
    while ((dir > 0 && s < leg.toS) || (dir < 0 && s > leg.toS)) {
      if (!inGap(s)) push(s, leg.speedKn, dir, leg.cogDeg, leg.fixLagS);
      const dt = interval + (leg.intervalJitterS ? rnd() * leg.intervalJitterS : 0);
      tS += dt;
      s += dir * leg.speedKn * 0.5144 * dt;
      // Sista steget slutar vid benets mål (s klipps nedan), inte bortom det.
      truthPath.push({ tS, s: (dir > 0 ? Math.min(s, leg.toS) : Math.max(s, leg.toS)) });
    }
    s = leg.toS;
  }
  Object.defineProperty(samples, 'truthPath', { value: truthPath, enumerable: false });
  return samples;
}

/**
 * Varv 2 (familj A): tiderna (sekunder från BASE_TIME_MS) då en sann bana
 * ur generateLegJourney korsar meterpositionen sTarget, med riktning
 * ('north' när s ökar, annars 'south'). Linjär interpolation mellan banans
 * punkter.
 * @param {Array<{tS:number, s:number}>} truthPath
 * @param {number} sTarget - meter längs rutten (t.ex. pathMetrics(...).cum[2])
 * @returns {Array<{tS:number, dir:string}>}
 */
function truthCrossings(truthPath, sTarget) {
  const out = [];
  for (let i = 1; i < (truthPath || []).length; i++) {
    const a = truthPath[i - 1];
    const b = truthPath[i];
    if ((a.s - sTarget) * (b.s - sTarget) >= 0 && !(a.s !== sTarget && b.s === sTarget)) continue;
    if (b.s === a.s) continue;
    const f = (sTarget - a.s) / (b.s - a.s);
    out.push({ tS: a.tS + f * (b.tS - a.tS), dir: b.s > a.s ? 'north' : 'south' });
  }
  return out;
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
  // Varv 2 (familj A): benresornas sanna banor per MMSI (se generateLegJourney).
  const truthPaths = {};
  for (const v of scenario.vessels) {
    const samples = generateJourney({ ...v }, rnd);
    if (samples.truthPath) truthPaths[v.mmsi] = samples.truthPath;
    all.push(...samples);
  }
  // Anslutningshändelser (2026-07-01): ctrl-rader (disconnect/reconnect)
  // konsumeras av replayRunner och simulerar avbrott mitt i korpusen.
  for (const ev of scenario.events || []) {
    all.push({ ctrl: ev.ctrl, aisTimestamp: BASE_TIME_MS + Math.round(ev.atOffsetS * 1000) });
  }
  all.sort((a, b) => a.aisTimestamp - b.aisTimestamp);
  Object.defineProperty(all, 'truthPaths', { value: truthPaths, enumerable: false });
  return all;
}

module.exports = {
  generateScenario, buildPath, pathMetrics, pointAt, truthCrossings, BASE_TIME_MS,
};
