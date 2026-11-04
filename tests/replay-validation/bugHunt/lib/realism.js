'use strict';

/**
 * Realismtabell för R1 (S-REALISM, BUGGJAKT.md §4.2 och sträckmål S7).
 *
 * Bara generering, ingen replay: generatorns mått per era jämförs med
 * fältets. Grinden är p50 inom ±30 % och p90 inom ±40 %. Grinden är RÖD i
 * v1, och R1-fynd redovisas därför som robusthet.
 *
 * Fältets korsningsmått finns i dag bara poolade över erorna (källparen
 * 320/83/36). Jämförelsen per era av dem är därför bara vägledande; glappen i
 * rörelse finns per era. Det är samma mätfel som syntesen påpekade för
 * prototypens AISHub-jämförelse, och raden märks "poolat".
 */

const geo = require('./geo');
const cal = require('./calib');
const { sampleWorld } = require('./families');
const { simulateWorld } = require('./world');
const { observeWorld } = require('./radio');
const { deriveTruth } = require('./truth');

const q = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};

/**
 * Mät generatorns statistik för en era.
 * @param {object} opts - {era:'aisstream'|'aishub', worlds:150, seed:5000, profile:'R1'}
 * @returns {object} tabell {era, världar, mått:[{namn, gen:{p50,p90}, fält:{p50,p90}, ok50, ok90, poolat}]}
 */
function measureRealism({
  era, worlds = 150, seed = 5000, profile = 'R1',
}) {
  const straddle = [];
  const lastBefore = [];
  const lastDist = [];
  const ivMove = [];
  const fixesPerTransit = [];
  for (let i = 0; i < worlds; i++) {
    const spec = sampleWorld(seed, i, { era });
    const sim = simulateWorld(spec);
    const { rows } = observeWorld(sim, { profile });
    const L0 = deriveTruth(sim);
    const by = new Map();
    for (const x of rows) {
      if (x.ctrl) continue;
      if (!by.has(x.mmsi)) by.set(x.mmsi, []);
      by.get(x.mmsi).push(x);
    }
    for (const [m, l] of by) {
      const b = spec.boats.find((x) => x.mmsi === m);
      if (!b || b.role !== 'transit') continue;
      fixesPerTransit.push(l.length);
      for (let k = 1; k < l.length; k++) {
        if ((l[k].sog ?? 0) >= 2 && (l[k - 1].sog ?? 0) >= 2) ivMove.push((l[k].fixTs - l[k - 1].fixTs) / 1000);
      }
    }
    for (const c of L0.crossings) {
      if (!geo.TARGETS.includes(c.bridge)) continue;
      const l = by.get(c.mmsi) || [];
      const before = [...l].reverse().find((x) => x.aisTimestamp <= c.t);
      const after = l.find((x) => x.aisTimestamp > c.t);
      if (before && after) straddle.push((after.aisTimestamp - before.aisTimestamp) / 1000);
      if (before) {
        lastBefore.push((c.t - before.aisTimestamp) / 1000);
        lastDist.push(geo.distToBridge(before.lat, before.lon, c.bridge));
      }
    }
  }
  const F = cal.SPEC['målbrokorsning'];
  const gl = era === 'aisstream' ? cal.SPEC.glapp_i_rörelse_s['aisstream | aisstream-era'] : cal.SPEC.glapp_i_rörelse_s['aishub | aishub-solo'];
  const row = (namn, arr, f, poolat) => {
    const g50 = q(arr, 0.5);
    const g90 = q(arr, 0.9);
    return {
      namn,
      n: arr.length,
      gen: { p50: Math.round(g50), p90: Math.round(g90) },
      fält: { p50: f.p50, p90: f.p90 },
      ok50: Math.abs(g50 - f.p50) / f.p50 <= 0.3,
      ok90: Math.abs(g90 - f.p90) / f.p90 <= 0.4,
      poolat,
    };
  };
  const mått = [
    row('glapp i rörelse (s)', ivMove, gl, false),
    row('korsningsglapp (s)', straddle, F.straddleGap_s, true),
    row('sista fix före korsning (s)', lastBefore, F['sistaFixFöreKorsning_s'], true),
    row('sista fix före korsning (m)', lastDist, F['sistaFixAvstånd_m'], true),
  ];
  return {
    era,
    profil: profile,
    världar: worlds,
    mått,
    fixarPerTransit: { p10: q(fixesPerTransit, 0.1), p50: q(fixesPerTransit, 0.5) },
    grön: mått.every((m) => m.ok50 && m.ok90),
  };
}

/** Realismtabellen som text (svenska). */
function formatRealism(tab) {
  const lines = [`${tab.era} (${tab.profil}, ${tab['världar']} världar): grinden ${tab['grön'] ? 'GRÖN' : 'RÖD'}`];
  for (const m of tab['mått']) {
    const g = `gen p50 ${String(m.gen.p50).padStart(5)} p90 ${String(m.gen.p90).padStart(5)}`;
    const f = `fält p50 ${String(m['fält'].p50).padStart(5)} p90 ${String(m['fält'].p90).padStart(5)}`;
    const ok = `${m.ok50 ? 'ok' : 'UTE'}/${m.ok90 ? 'ok' : 'UTE'}${m.poolat ? ' (fält poolat över erorna)' : ''}`;
    lines.push(`  ${m.namn.padEnd(28)} ${g} | ${f}  ${ok}`);
  }
  lines.push(`  fixar per transit            gen p10 ${tab.fixarPerTransit.p10} p50 ${tab.fixarPerTransit.p50} | fält (besök) p10 4 p50 15`);
  return lines.join('\n');
}

module.exports = { measureRealism, formatRealism };

if (require.main === module) {
  for (const era of ['aisstream', 'aishub']) console.log(formatRealism(measureRealism({ era })));
}
