'use strict';

/**
 * FÄLTFAMILJERNA, BUGGJAKT.md §4.6 (omgång 9).
 *
 * Fyra familjer för det fältprov 2 och 3 (november 2026) visade och som de
 * nio sommarfamiljerna aldrig bygger:
 *
 *   F-LÅGSÄSONG     ett ensamt lastfartyg i 6–8 kn genom hela kanalen efter
 *                   minst en timme utan trafik, en förtöjd lotsbåt och en
 *                   arbetsbåt som flyttar sig 100–400 m längs kajen; 4–8 h
 *   F-KÄLLBORTFALL  AISstream nere hela världen, tyst i minuter till timmar,
 *                   tyst tills båten ligger mitt i sin anflygning, eller
 *                   AISHub tyst 10–15 min medan AISstream levererar
 *   F-ENGÅNG        en båt i 10–16 kn som hörs EN gång 200–700 m från en bro
 *                   och aldrig mer (hon fortsätter, vänder eller är på väg bort)
 *   F-MÅLBROVÄNTAN  kö vid målbron (U65): väntar, kryper fram till en ny
 *                   köplats, tystnar medan hon väntar eller går igenom bron
 *                   under radioglappet, och en andra båt som närmar sig kön
 *
 * Familjerna ingår INTE i families.FAMILIES och väljs därför aldrig av de
 * gamla profilerna: samma profil, seed och index ger samma värld som före
 * omgång 9. De körs med profilen `falt` (världsindex från 100 000) eller
 * med --families. Alla världar är vinterlika: startdatum i november,
 * radiomodellen 'blandad' (båda källorna samtidigt, som i fält sedan
 * fältprov 2), bakgrundstrafik med 30 % av bankens timtakt och 1–3
 * kajliggare.
 *
 * RADIOMODELLEN 'blandad' (radio.js, observeBlandad) har egna kvantiler
 * (VINTER nedan), mätta på fältprov 2 och 3 (o9/S/matt/vinterkvantiler.json,
 * 189 h, 11 483 positioner): bara aggregerade intervall och fixåldrar, inga
 * positioner, namn eller tider. Klassning som calibration.json: transit =
 * sog ≥ 2 kn i båda fixarna, stilla = sog < 0,3 kn och < 60 m.
 */

const geo = require('./geo');
const cal = require('./calib');
const { stream } = require('./rng');

const FÄLTFAMILJER = Object.freeze(['F-LÅGSÄSONG', 'F-KÄLLBORTFALL', 'F-ENGÅNG', 'F-MÅLBROVÄNTAN']);

const FÄLT_VIKTER = Object.freeze({
  'F-LÅGSÄSONG': 10,
  'F-KÄLLBORTFALL': 15,
  'F-ENGÅNG': 10,
  'F-MÅLBROVÄNTAN': 15,
});

const FÄLT_NYCKLAR = Object.freeze({
  'F-LÅGSÄSONG': ['cruiseKn'],
  'F-KÄLLBORTFALL': ['avbrottS'],
  'F-ENGÅNG': ['avståndM'],
  'F-MÅLBROVÄNTAN': ['durS', 'tystnadS'],
});

/** Bankens timtakt (dygnstakt) gånger den här faktorn: vintern har 0,12 Klaffbronkorsningar/h mot bankens 0,40. */
const VINTER_TAKTFAKTOR = 0.3;
/** Andel följare i vinterbakgrunden (fältprov 2–3: 4,5 % av målbrokorsningarna hade en annan båt inom 15 min). */
const VINTER_FÖLJARE = 0.1;

const Q = (o) => Object.freeze(o);
/** Fältprov 2 och 3 (k3 + k4), sekunder. */
const VINTER = Object.freeze({
  aisstream: Q({
    transit: Q({
      p10: 59.6, p25: 83.2, p50: 179.7, p75: 259.4, p90: 419.5, p95: 521.8, p99: 988.6,
    }),
    stilla: Q({
      p10: 85.8, p25: 180.7, p50: 489.3, p75: 910.6, p90: 1798.8, p95: 2332.9, p99: 3625.6,
    }),
  }),
  aishub: Q({
    transit: Q({
      p10: 65.7, p25: 66.4, p50: 67.7, p75: 69.2, p90: 70.1, p95: 135.6, p99: 139.7,
    }),
    stilla: Q({
      p10: 66.1, p25: 67.5, p50: 69.8, p75: 201.7, p90: 209, p95: 343.6, p99: 545.3,
    }),
  }),
  ålder: Q({
    rörelse: Q({
      p10: 4, p25: 9, p50: 17.3, p75: 24.9, p90: 30.6, p95: 35.3, p99: 39.4, max: 52.7,
    }),
    stilla: Q({
      p10: 4.4, p25: 10.6, p50: 21, p75: 31.7, p90: 51, p95: 60.1, p99: 66.9,
    }),
  }),
});

/** Samplare för radiomodellen 'blandad' (u ∈ [0, 1] → sekunder). */
const vinter = {
  aisstream: {
    move: cal.quantileSampler(VINTER.aisstream.transit, { floor: 10, tail: 'p99' }),
    still: cal.quantileSampler(VINTER.aisstream.stilla, { floor: 60, tail: 'p99' }),
  },
  aishub: {
    move: cal.quantileSampler(VINTER.aishub.transit, { floor: 58, tail: 'p99' }),
    still: cal.quantileSampler(VINTER.aishub.stilla, { floor: 60, tail: 'p99' }),
  },
  ageMove: cal.quantileSampler(VINTER.ålder.rörelse, { floor: 0, tail: 'max' }),
  ageStill: cal.quantileSampler(VINTER.ålder.stilla, { floor: 0, tail: 'p99' }),
};

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const KN = 0.514444;

/** Sidoffset (m, med tecken) för en kajplats: den sida som ger kortast avstånd till kajens position. */
function kajOffset(quay) {
  const p = geo.project(quay.lat, quay.lon);
  const plus = geo.pointAt(p.s, p.offsetM);
  const minus = geo.pointAt(p.s, -p.offsetM);
  const dp = geo.calculateDistance(plus.lat, plus.lon, quay.lat, quay.lon);
  const dm = geo.calculateDistance(minus.lat, minus.lon, quay.lat, quay.lon);
  return { s: p.s, l: round1(dp <= dm ? p.offsetM : -p.offsetM) };
}

/**
 * Kajflyttarna i banken (omgång 9, varv 3): åtta inspelade flyttar mellan två
 * stillaepisoder på minst 10 min (o9/S/verktyg/kajflytt.js), som farleds-
 * koordinat från → till (avrundad till 10 m) och högsta sog under flytten.
 * Fältproven (k1–k4) har tio till i samma områden (hamnen söder om infarten,
 * vid Klaffbron och Stallbackabron) men står inte här: fältets positioner
 * hör inte hemma i repot.
 */
const KAJFLYTTAR = Object.freeze([
  { från: 6130, till: 6420, kn: 6.8 },
  { från: 6420, till: 6130, kn: 0.5 },
  { från: 2650, till: 3130, kn: 2.3 },
  { från: -60, till: -160, kn: 2.2 },
  { från: 140, till: -40, kn: 0.2 },
  { från: 40, till: -120, kn: 1.5 },
  { från: 80, till: -100, kn: 2.6 },
  { från: 50, till: -120, kn: 0.1 },
].map((x) => Object.freeze(x)));

/**
 * Arbetsbåt vid kaj (varv 3): flyttar sig som en av bankens inspelade
 * kajflyttar (KAJFLYTTAR, ± 10 m), i 0,8–3 kn (den inspelade högsta farten,
 * klippt), och i hälften av fallen tillbaka efter 10–60 min. Sidoffseten är
 * närmaste kajplats i calibration.json (inom 300 m längs farleden), annars
 * 30 m. Förut flyttade den sig från vilken kajplats som helst, och fyra kort
 * i fältjakten kom från flyttar vid Klaffbron som inte finns i inspelad trafik.
 */
function arbetsbåt(rnd, world, f) {
  const k = rnd.pick(KAJFLYTTAR);
  const sKaj = Math.round(k.från + rnd.range(-10, 10));
  const till = Math.round(k.till + rnd.range(-10, 10));
  const kn = round1(Math.min(3, Math.max(0.8, k.kn)));
  const nära = cal.QUAYS.map((q) => ({ q, d: Math.abs(q.s - sKaj) })).sort((a, b) => a.d - b.d)[0];
  const quay = nära.q;
  const l = nära.d <= 300 ? kajOffset(quay).l : 30;
  const flyttar = [];
  let t = Math.round(rnd.range(600, Math.max(601, world.durS - 2400)));
  flyttar.push({ atS: t, tillS: till, kn });
  if (rnd.chance(0.5)) {
    t = Math.round(t + (Math.abs(till - sKaj) / (kn * KN)) + 120 + rnd.range(600, 3600));
    if (t < world.durS - 600) flyttar.push({ atS: t, tillS: sKaj, kn });
  }
  const m = f.moored({ quay, durS: world.durS, extraTags: ['arbetsbåt'] });
  return {
    mmsi: m.mmsi,
    name: m.name,
    cls: 'A',
    role: 'arbetsbåt',
    dir: till < sKaj ? 'south' : 'north',
    sKaj,
    laneM: l,
    flyttar,
    navStillStatus: 5,
    tStartS: 0,
    durS: world.durS,
    tags: ['arbetsbåt', `kajflytt ${k.från}→${k.till}`, `${flyttar.length} flytt`],
    seed: m.seed,
    fokal: true,
  };
}

// ---------------------------------------------------------------------------
// Inflygningsprofilen (omgång 9): fältets transiter saktar in, kryper mot
// bron, står nästan still, rycker fram i kön och sätter fart efter bron.
// Mätt i banken och k1–k4 (o9/S/matt/inflygning-inspelad.txt, per korsning
// i en transitresa, fönstret 1 500 m före bron):
//   Olidebron       kryp < 2 kn 40–45 %, stod 24–42 %
//   Klaffbron       kryp 17–49 %, stod 17–33 %
//   Järnvägsbron    kryp 56–70 %, stod 39–48 %, stopp p50 175–263 m före
//   Stridsbergsbron kryp 47–63 %, stod 31–40 %
//   Stallbackabron  kryp 2–7 %
//   krypfarten p50 0,7–1,0 kn; farten under 3 kn från p50 500–1 100 m före;
//   54–61 % av krypraderna ligger söder om kanalinfarten (hamnen).
// Järnvägsbron och Stridsbergsbron ligger 257 m isär och behandlas som ett
// bropar: profilen läggs före den första i färdriktningen. Krypet slutar
// 20–80 m före bron och båten sätter fart genom den: av 956 inspelade
// korsningar gick 0,6 % under 1 kn och 3,2 % under 2 kn (matt/korsfart.txt).
// ---------------------------------------------------------------------------
const INFLYGNING = Object.freeze([
  {
    broar: ['Olidebron'], pKryp: 0.35, pStopp: 0.3, stoppM: [40, 300],
  },
  {
    broar: ['Klaffbron'], pKryp: 0.3, pStopp: 0.3, stoppM: [100, 300],
  },
  {
    broar: ['Järnvägsbron', 'Stridsbergsbron'], pKryp: 0.5, pStopp: 0.35, stoppM: [60, 300],
  },
  {
    broar: ['Stallbackabron'], pKryp: 0.05, pStopp: 0.5, stoppM: [100, 300],
  },
]);
const P_HAMN = 0.7;
const lognorm = (rnd, median, sigma, lo, hi) => Math.min(hi, Math.max(lo, median * Math.exp(rnd.normal() * sigma)));

/**
 * Lägg inflygningsprofilen i en transits plan, för de broar (bropar) som
 * planen inte redan har ett element för. Planen ordnas om (orderPlan) och
 * ändrar inte de element som fanns.
 * @param {object} rnd - världens slumpström
 * @param {object} b - transitbåtens spec (ändras)
 * @param {object} h - families.js hjälpare (orderPlan)
 */
function inflygning(rnd, b, h) {
  const plan = [...(b.plan || [])];
  const harBro = new Set(plan.filter((p) => p.bridge).map((p) => p.bridge));
  const u = plan.find((p) => p.op === 'uturn');
  const sign = b.dir === 'north' ? 1 : -1;
  const nås = (bro) => !u || (geo.stationByName[bro].s - u.atS) * sign < 0;
  for (const enh of INFLYGNING) {
    const broar = b.dir === 'north' ? enh.broar : [...enh.broar].reverse();
    if (broar.some((x) => harBro.has(x)) || !nås(broar[0])) continue;
    if (!rnd.chance(enh.pKryp)) continue;
    const [först, andra] = broar;
    const kn = Math.round(lognorm(rnd, 0.8, 0.45, 0.3, 1.8) * 10) / 10;
    const fromM = Math.round(rnd.range(400, 1200));
    if (rnd.chance(enh.pStopp)) {
      let distM = Math.round(rnd.range(enh.stoppM[0], enh.stoppM[1]));
      plan.push({
        op: 'slow', bridge: först, fromM, toM: distM + 50, kn: Math.round(rnd.range(1.5, 2.5) * 10) / 10,
      });
      plan.push({
        op: 'queue', bridge: först, distM, durS: Math.round(lognorm(rnd, 300, 0.9, 60, 2700)),
      });
      // Ryck i kön: 1–2 korta stopp 20–70 m närmare.
      if (rnd.chance(0.25)) {
        const n = rnd.int(1, 2);
        for (let k = 0; k < n && distM > 40; k++) {
          distM = Math.max(20, Math.round(distM - rnd.range(20, 70)));
          plan.push({
            op: 'queue', bridge: först, distM, durS: Math.round(rnd.range(30, 240)),
          });
        }
      }
      // Efter kön kryper hon 20–60 m framåt och sätter sedan fart genom bron
      // (inspelat: 0,6 % av korsningarna under 1 kn; köerna ligger 74–575 m
      // före bron, o9/S/matt/koplats.txt). Varv 2 lät henne krypa ända fram
      // till 20–80 m före bron, vilket gav kortet F06 i varv 2:s slutkörning.
      const toM = Math.max(20, Math.round(distM - rnd.range(20, 60)));
      if (distM > toM + 10) {
        plan.push({
          op: 'slow', bridge: först, fromM: distM + 5, toM, kn,
        });
      }
    } else {
      const withinM = Math.round(rnd.range(60, 250));
      plan.push({
        op: 'slow', bridge: först, fromM: Math.max(fromM, withinM + 50), toM: withinM, kn: Math.round(rnd.range(1.5, 3) * 10) / 10,
      });
      plan.push({
        op: 'slow', bridge: först, fromM: withinM, toM: Math.round(rnd.range(20, 80)), kn,
      });
    }
    harBro.add(först);
    if (andra) harBro.add(andra);
  }
  // Hamnen söder om infarten: låg fart på in- eller utvägen.
  if (!plan.some((p) => p.op === 'slowzone') && rnd.chance(P_HAMN)) {
    const kn = Math.round(lognorm(rnd, 1.3, 0.35, 0.5, 2.5) * 10) / 10;
    if (b.dir === 'north') {
      plan.push({
        op: 'slowzone', fromS: -350, toS: 250, kn,
      });
    } else if (!u) {
      plan.push({
        op: 'slowzone', fromS: 250, toS: -350, kn,
      });
    }
  }
  b.plan = h.orderPlan(plan, b.dir);
  b.tags = [...(b.tags || []), 'inflygning'];
}

/** Vinterbakgrund: Poisson med 30 % av bankens timtakt, 10 % följare, 1–3 kajliggare. */
function vinterBakgrund(rnd, world, f, h, { transiter = true } = {}) {
  const boats = [];
  const lastArrival = world.durS - 3600;
  if (transiter) {
    for (let hr = 0; hr * 3600 < lastArrival; hr++) {
      const hour = (world.localHour + hr) % 24;
      const n = h.poisson(rnd, cal.hourRate[hour] * VINTER_TAKTFAKTOR);
      for (let k = 0; k < n; k++) {
        const t = (hr * 3600) + rnd.range(0, 3600);
        if (t >= lastArrival) continue;
        const b = f.transit({ tStartS: t, cls: rnd.chance(0.8) ? 'A' : 'B' });
        inflygning(rnd, b, h);
        boats.push(b);
        if (rnd.chance(VINTER_FÖLJARE)) {
          const fo = f.transit({ tStartS: t + rnd.range(30, 360), dir: b.dir, extraTags: ['konvojföljare'] });
          inflygning(rnd, fo, h);
          boats.push(fo);
        }
      }
    }
  }
  const nMoored = rnd.weighted([[1, 0.4], [2, 0.45], [3, 0.15]]);
  for (let i = 0; i < nMoored; i++) boats.push(f.moored({ durS: world.durS }));
  return boats;
}

/** Fokala byggare. h = families.js hjälpare (se buildFältWorld). */
const BUILDERS = {
  'F-LÅGSÄSONG': (rnd, world, f, h) => {
    const cargo = f.transit({
      cls: 'A', cruiseKn: round2(rnd.range(6, 8)), plan: [], fokal: true, extraTags: ['lastfartyg'],
    });
    inflygning(rnd, cargo, h);
    const need = h.transitNeedS(cargo);
    // Minst en timme tom kanal före lastfartyget (lågsäsongens långa tomma perioder).
    if (world.durS < need + 3600 + 900) world.durS = Math.round(need + 3600 + 900);
    cargo.tStartS = Math.round(rnd.range(3600, Math.max(3601, world.durS - need - 600)));
    const lots = f.moored({ durS: world.durS, extraTags: ['lotsbåt'] });
    lots.fokal = true;
    const arb = arbetsbåt(rnd, world, f);
    return {
      boats: [cargo, lots, arb],
      parametrar: {
        cruiseKn: cargo.cruiseKn, tomFöreMin: Math.round(cargo.tStartS / 60), flyttar: arb.flyttar.length,
      },
      utanTransitBakgrund: true,
    };
  },
  'F-KÄLLBORTFALL': (rnd, world, f, h) => {
    const bro = rnd.pick(geo.TARGETS);
    const b = f.transit({
      cls: rnd.chance(0.8) ? 'A' : 'B', plan: [], tags: [`källbortfall@${bro}`], fokal: true,
    });
    inflygning(rnd, b, h);
    b.tStartS = h.focalStart(rnd, world, h.transitNeedS(b));
    const variant = rnd.weighted([['aisstream-nere', 2], ['aisstream-tyst', 3], ['återkomst-mitt-i', 3], ['aishub-tyst', 1]]);
    const tCross = h.crossingTimeS(b, bro);
    const tc = tCross !== null ? tCross : b.tStartS + 1800;
    let fel;
    let föreM = null;
    if (variant === 'aisstream-nere') {
      fel = { källa: 'aisstream', frånS: 0, tillS: world.durS + 7200 };
    } else if (variant === 'aisstream-tyst') {
      // Log-likformig längd 2 min – 3 h, placerad över korsningen.
      const L = Math.round(120 * ((3 * 3600 / 120) ** rnd.u()));
      const från = Math.max(0, Math.round(tc - (rnd.range(0.2, 0.9) * L)));
      fel = { källa: 'aisstream', frånS: från, tillS: från + L };
    } else if (variant === 'återkomst-mitt-i') {
      föreM = Math.round(rnd.range(0, 1500));
      const tq = h.timeAtDistanceBefore(b, bro, föreM);
      const till = Math.round(tq !== null ? tq : tc);
      fel = { källa: 'aisstream', frånS: Math.max(0, Math.round(till - rnd.range(600, 7200))), tillS: till };
    } else {
      föreM = Math.round(rnd.range(300, 1500));
      const tq = h.timeAtDistanceBefore(b, bro, föreM);
      const från = Math.round(tq !== null ? tq : tc - 300);
      fel = { källa: 'aishub', frånS: från, tillS: från + Math.round(rnd.range(600, 900)) };
    }
    world.källfel = [fel];
    return {
      boats: [b],
      parametrar: {
        bro, variant, källa: fel.källa, avbrottS: Math.min(fel.tillS, world.durS) - fel.frånS, ...(föreM !== null ? { föreM } : {}),
      },
    };
  },
  'F-ENGÅNG': (rnd, world, f, h) => {
    const bro = rnd.weighted([['Stridsbergsbron', 3], ['Klaffbron', 3], ['Järnvägsbron', 1], ['Olidebron', 1], ['Stallbackabron', 1]]);
    const st = geo.stationByName[bro];
    const dir = rnd.chance(0.5) ? 'south' : 'north';
    const sign = dir === 'north' ? 1 : -1;
    const variant = rnd.weighted([['fortsätter', 2], ['vänder', 1], ['bort', 1]]);
    const avståndM = Math.round(rnd.range(200, 700));
    const fixS = variant === 'bort' ? st.s + (sign * avståndM) : st.s - (sign * avståndM);
    const plan = variant === 'vänder'
      ? [{ op: 'uturn', atS: Math.round(fixS + (sign * rnd.range(60, Math.max(61, Math.min(250, avståndM - 50))))) }]
      : [];
    const b = f.transit({
      dir, cls: rnd.chance(0.7) ? 'A' : 'B', cruiseKn: round2(rnd.range(10, 16)), plan, tags: [`engång@${bro}`, variant], fokal: true,
    });
    // Räddningsbåten i fältprov 3 gick 14,6 kn: farten hålls utan sektorfaktor.
    b.fastFart = true;
    b.v0Kn = b.cruiseKn;
    b.enfix = { s: Math.round(fixS), källa: rnd.chance(0.8) ? 'aishub' : 'aisstream' };
    b.tStartS = h.focalStart(rnd, world, h.transitNeedS(b));
    return {
      boats: [b],
      parametrar: {
        bro, variant, avståndM, källa: b.enfix.källa, kn: b.cruiseKn,
      },
    };
  },
  'F-MÅLBROVÄNTAN': (rnd, world, f, h) => {
    // Köplatserna är bankens (calibration.json): Stridsbergsbron och Klaffbron
    // söderut. Klaffbron norrut, som varv 1 och 2 antog, är borttagen i varv 3:
    // banken och k1–k4 har 0 väntor före Klaffbron norrut (o9/S/matt/koplats.txt),
    // och den köplatsen gav kortet F07 (sågtand med tre båtar i kö).
    const site = rnd.weighted([
      [{ bridge: 'Stridsbergsbron', dir: 'south', distM: [80, 193] }, 26],
      [{ bridge: 'Klaffbron', dir: 'south', distM: [221, 307] }, 3],
    ]);
    const distM = Math.round(rnd.range(site.distM[0], site.distM[1]));
    const durS = Math.round(rnd.range(300, 2400));
    const kryper = rnd.chance(0.5);
    const plan = [{
      op: 'queue', bridge: site.bridge, distM, durS,
    }];
    if (kryper) {
      plan.push({
        op: 'queue', bridge: site.bridge, distM: Math.max(20, Math.round(distM - rnd.range(30, 90))), durS: Math.round(rnd.range(120, 900)),
      });
    }
    const a = f.transit({
      dir: site.dir,
      cls: rnd.chance(0.75) ? 'A' : 'B',
      plan: [{
        op: 'slow', bridge: site.bridge, fromM: Math.round(rnd.range(400, 1200)), toM: distM + 50, kn: Math.round(rnd.range(1.5, 2.5) * 10) / 10,
      }, ...plan],
      tags: [`målbrokö@${site.bridge}`, ...(kryper ? ['kryper i kön'] : [])],
      fokal: true,
    });
    inflygning(rnd, a, h);
    a.tStartS = h.focalStart(rnd, world, h.transitNeedS(a));
    const simA = h.simulateBoat(a);
    const köer = simA.stops.filter((s) => s.kind === 'queue');
    const q0 = köer.length ? köer[0].t0 : a.tStartS + 1800;
    const dep = köer.length ? köer[köer.length - 1].t1 : q0 + durS;
    const tCross = h.crossingTimeS(a, site.bridge);
    const tystnad = rnd.weighted([['ingen', 3], ['tystnar', 4], ['genom', 4]]);
    let tystnadS = 0;
    if (tystnad === 'tystnar') {
      const från = Math.round(q0 + rnd.range(60, Math.max(61, (dep - q0) - 60)));
      tystnadS = Math.round(rnd.range(300, 1500));
      a.tystnad = [{ frånS: från, tillS: från + tystnadS }];
    } else if (tystnad === 'genom' && tCross !== null) {
      const från = Math.round(q0 + rnd.range(60, Math.max(61, (dep - q0) * 0.8)));
      const till = Math.round(tCross + rnd.range(30, 300));
      tystnadS = till - från;
      a.tystnad = [{ frånS: från, tillS: till }];
    }
    const boats = [a];
    let andraBåt = false;
    if (rnd.chance(0.5)) {
      andraBåt = true;
      const distB = distM + Math.round(rnd.range(40, 150));
      const b = f.transit({
        dir: a.dir,
        cls: rnd.chance(0.75) ? 'A' : 'B',
        plan: [{
          op: 'slow', bridge: site.bridge, fromM: Math.round(rnd.range(400, 1200)), toM: distB + 50, kn: Math.round(rnd.range(1.5, 2.5) * 10) / 10,
        }, {
          op: 'queue', bridge: site.bridge, distM: distB, durS: 60,
        }],
        tags: [`målbrokö@${site.bridge}`, 'andra i kön'],
        fokal: true,
      });
      inflygning(rnd, b, h);
      const tq = h.timeAtDistanceBefore({ ...b, tStartS: 0 }, site.bridge, distB);
      const Ta = q0 + rnd.range(60, Math.max(61, (dep - q0) + 300));
      b.tStartS = Math.max(60, Math.round(Ta - (tq !== null ? tq : 1800)));
      b.plan.find((p) => p.op === 'queue' && p.bridge === site.bridge && p.distM === distB).durS = Math.max(60, Math.round((dep + rnd.range(30, 180)) - Ta));
      boats.push(b);
      world.durS = Math.max(world.durS, Math.min(5 * 3600, b.tStartS + h.transitNeedS(b) + 300));
    }
    world.durS = Math.max(world.durS, Math.min(5 * 3600, a.tStartS + h.transitNeedS(a) + 300));
    return {
      boats,
      parametrar: {
        bro: site.bridge, riktning: site.dir, antagenKöplats: !!site.antagen, distM, durS, kryper, tystnad, tystnadS, andraBåt,
      },
    };
  },
};

/**
 * Bygg en fältvärld. Anropas av families.buildWorld när familjen är en
 * fältfamilj, med världens slumpström efter familjedragningen.
 * @param {object} rnd - världens slumpström
 * @param {string} family - fältfamiljen
 * @param {number} seed - världens seed
 * @param {object} opts - buildWorld-flaggorna
 * @param {object} h - hjälpare ur families.js
 * @returns {object} världens spec
 */
function buildFältWorld(rnd, family, seed, opts, h) {
  const day = rnd.int(0, 29); // november 2026
  const localHour = rnd.weighted(cal.hourRate.map((r, hr) => [hr, r + 0.02]));
  // Normaltid i november: lokal tid = UTC + 1 h.
  const startMs = Date.UTC(2026, 10, 1, 0, 0, 0) + (day * 86400000)
    + ((((localHour - 1) + 24) % 24) * 3600000) + (rnd.int(0, 3599) * 1000);
  let { hours } = opts;
  if (!Number.isFinite(hours)) hours = family === 'F-LÅGSÄSONG' ? rnd.range(4, 8) : rnd.range(2.5, 4.5);
  const world = {
    version: 1,
    generator: 'bugHunt/families v1 (fält)',
    seed,
    basSeed: Number.isFinite(opts.basSeed) ? opts.basSeed : null,
    index: Number.isFinite(opts.index) ? opts.index : null,
    familj: family,
    avseddTäthet: 'vinter',
    startMs,
    durS: Math.round(hours * 3600),
    era: 'blandad',
    night: localHour >= 22 || localHour < 6,
    localHour,
    radioSeed: seed,
    fokal: null,
    boats: [],
    events: [],
  };
  const f = h.makeFactory(rnd, world);
  const focal = BUILDERS[family](rnd, world, f, h);
  const background = vinterBakgrund(rnd, world, f, h, { transiter: !focal.utanTransitBakgrund });
  world.boats = [...focal.boats, ...background];
  // Inflygningsprofilen förlänger transiterna: världen räcker tills den sista
  // fokala transiten lämnat området (högst 8 h för F-LÅGSÄSONG, annars 5 h).
  const tak = (family === 'F-LÅGSÄSONG' ? 8 : 5) * 3600;
  for (const b of focal.boats) {
    if (b.role !== 'transit') continue;
    const tr = h.simulateBoat(b).traj;
    if (tr.length) world.durS = Math.max(world.durS, Math.min(tak, Math.round(tr[tr.length - 1].t + 300)));
  }
  for (const b of world.boats) if (b.role === 'moored' || b.role === 'arbetsbåt') b.durS = world.durS;
  if (!world.källfel) world.källfel = [];
  world.fokal = {
    familj: family,
    mmsis: focal.boats.filter((b) => b.fokal).map((b) => b.mmsi),
    parametrar: focal.parametrar,
    nyckel: FÄLT_NYCKLAR[family],
  };
  return world;
}

/**
 * Profilen `blandad` (omgång 9, varv 3): de nio gamla familjerna med
 * inflygningsprofilen och radiomodellen blandad. Världen byggs först exakt som
 * förut (families.buildWorld), och läggs sedan om här med en egen slumpström
 * (`inflygning`), så att resten av specen är densamma som för samma seed utan
 * läget. Täthet, datum och familjernas fokala planer behålls; varje transit
 * utan egen plan vid en bro får inflygningsprofilen, världen får båda
 * källorna och förlängs (högst 5 h) tills de fokala transiterna lämnat
 * området. Familjernas tidsberoende parametrar (konvojens Δ, mötets Δ,
 * avbrottets läge) är satta före profilen och stämmer därför bara ungefär.
 * @param {object} world - världens spec (ändras)
 * @param {number} seed - världens seed
 * @param {object} h - families.js hjälpare
 * @returns {object} världens spec
 */
function inflygningsläge(world, seed, h) {
  const rnd = stream(seed, 'inflygning');
  world.era = 'blandad';
  world.generator = `${world.generator} + inflygning`;
  world.källfel = [];
  for (const b of world.boats) if (b.role === 'transit' && !b.fastFart) inflygning(rnd, b, h);
  for (const b of world.boats) {
    if (!b.fokal || b.role !== 'transit') continue;
    const tr = h.simulateBoat(b).traj;
    if (tr.length) world.durS = Math.max(world.durS, Math.min(5 * 3600, Math.round(tr[tr.length - 1].t + 300)));
  }
  for (const b of world.boats) if (b.role === 'moored') b.durS = world.durS;
  return world;
}

module.exports = {
  FÄLTFAMILJER,
  FÄLT_VIKTER,
  FÄLT_NYCKLAR,
  VINTER,
  vinter,
  VINTER_TAKTFAKTOR,
  BUILDERS,
  buildFältWorld,
  kajOffset,
  INFLYGNING,
  inflygning,
  KAJFLYTTAR,
  inflygningsläge,
};
