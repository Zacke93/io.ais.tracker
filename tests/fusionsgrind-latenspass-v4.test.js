'use strict';

const fs = require('fs');
const path = require('path');
const { makeFusionCorpus } = require('./replay-validation/makeFusionCorpus');

/**
 * V4 (A/B-natten 2026-08-03) — LATENSPASSETS harness-vakt.
 *
 * Fusionsgrinden kör sedan nu två pass: normal leverans och +60 s
 * LEVERANSLAGG på den syntetiska hub-strömmen. Passet är hela beviset för att
 * en släpande andrakälla inte kan köpa en extra notis (nattens latenstest:
 * +30 s gav TIDAN@Klaffbron ×3, +60 s sju dubbletter varav en 152 m EFTER
 * passagen — och källans egen latens hade p90 62,3 s).
 *
 * Två sätt kan göra passet TYST VAKUÖST utan att någon körning blir röd:
 *   1. deliveryDelayMs slutar tillämpas (eller börjar av misstag flytta fixTs
 *      också — då försvinner asymmetrin som ÄR felmoden).
 *   2. andra passet plockas bort ur runFusionCorpora.js.
 * Vakten nedan låser båda. Den kör INTE replayen (det gör npm run
 * replay:fusion) — den låser kopplingen, i samma anda som harness-vakterna.
 */

const ROOT = path.resolve(__dirname, '..');
const gateSrc = fs.readFileSync(path.join(ROOT, 'tests/replay-validation/runFusionCorpora.js'), 'utf8');

// Ett litet konstgjort korpusutdrag: två fartyg, fixar var 30:e sekund över
// 10 minuter (tätt nog att generera flera pollar i skuggströmmen).
function makeSamples() {
  const t0 = Date.UTC(2026, 7, 3, 6, 0, 0);
  const out = [];
  for (let i = 0; i < 20; i++) {
    out.push({
      mmsi: '265001111',
      msgType: 'PositionReport',
      lat: 58.28 + i * 0.0005,
      lon: 12.29,
      sog: 5,
      cog: 25,
      shipName: 'LAGGBÅT',
      aisTimestamp: t0 + i * 30000,
      feed: 'aisstream',
    });
  }
  return out;
}

const hubOf = (merged) => merged
  .filter((s) => s.feed === 'aishub')
  .sort((a, b) => a.fixTs - b.fixTs || a.aisTimestamp - b.aisTimestamp);

describe('V4: latenspasset flyttar LEVERANSTID — aldrig fixtid', () => {
  const samples = makeSamples();
  const base = makeFusionCorpus(samples, { deliveryDelayMs: 0 });
  const lagged = makeFusionCorpus(samples, { deliveryDelayMs: 60000 });

  test('skuggströmmen genereras överhuvudtaget (annars prövar passet ingenting)', () => {
    expect(base.hubCount).toBeGreaterThan(0);
    expect(lagged.hubCount).toBe(base.hubCount);
  });

  test('varje hub-posts aisTimestamp skjuts exakt lagget — och fixTs står HELT still', () => {
    const a = hubOf(base.merged);
    const b = hubOf(lagged.merged);
    expect(b).toHaveLength(a.length);
    for (let i = 0; i < a.length; i++) {
      // Klockdomändoktrinen: aisTimestamp = mottagningstid, fixTs = fixtid.
      expect(b[i].aisTimestamp - a[i].aisTimestamp).toBe(60000);
      expect(b[i].fixTs).toBe(a[i].fixTs);
      // Asymmetrin ÄR felmoden: efter lagget är fixen bevisligen äldre än sin
      // leverans, vilket är precis vad F6 ska svälja.
      expect(b[i].aisTimestamp - b[i].fixTs).toBeGreaterThanOrEqual(60000);
    }
  });

  test('aisstream-raderna är orörda av lagget (bara andrakällan släpar)', () => {
    const streamOf = (m) => m.filter((s) => s.feed !== 'aishub')
      .map((s) => `${s.mmsi}:${s.aisTimestamp}:${s.lat}`);
    expect(streamOf(lagged.merged)).toEqual(streamOf(base.merged));
  });

  test('utan lagg är hub-posten samtidig med sin poll (negativ kontroll)', () => {
    // Ekot levereras i pollögonblicket + batchspridning (< 1 s), alltså aldrig
    // 60 s efter. Utan denna kontroll hade ett hårdkodat lagg i generatorn
    // gjort BÅDA passen till latenspass.
    const a = hubOf(base.merged);
    const spread = a.map((s) => s.aisTimestamp - s.fixTs);
    expect(Math.min(...spread)).toBeLessThan(60000);
  });
});

describe('V4: fusionsgrinden kör BÅDA passen', () => {
  test('runFusionCorpora deklarerar både normal- och latenspasset', () => {
    expect(gateSrc).toMatch(/id:\s*'normal'/);
    expect(gateSrc).toMatch(/id:\s*'latency'/);
    // Latenspasset måste ha ett faktiskt lagg (inte deliveryDelayMs: 0).
    const m = gateSrc.match(/LATENCY_PASS_DELAY_MS\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(60000);
    // …och båda ska köras när ingen FUSION_PASS-variabel är satt.
    expect(gateSrc).toMatch(/only\s*\?\s*ALL_PASSES\.filter[\s\S]*?:\s*ALL_PASSES/);
  });

  test('latenspasset kräver att F6 faktiskt fyrade (stale_cross_fix > 0)', () => {
    // Utan den kontrollen kunde passet bli grönt av att lagget aldrig
    // tillämpades — mätt offline släpper +60 s in 9-624 släpande hub-fixar
    // per korpus när F6 tas bort, så noll träffar betyder trasig grind.
    expect(gateSrc).toMatch(/stale_cross_fix/);
  });
});
