'use strict';

/**
 * Invariant-validator (2026-06-11) — FACIT-OBEROENDE sanningskontroller på
 * replay-utdata. Detta är svaret på facit-fällan: en jämförelse mot prod-
 * utfall kan aldrig fånga buggar som prod också hade (RC1–RC3 låg osynliga i
 * tre korpusar). Invarianterna uttrycker vad som MÅSTE gälla oavsett facit.
 *
 * Körs av runAllCorpora på varje korpus; brott på låst korpus = regression.
 */

const COUNT_WORDS = '(En|Två|Tre|Fyra|Fem|Sex|Sju|Åtta|Nio|Tio|[2-9]\\d?)';
const TARGET = '(Klaffbron|Stridsbergsbron)';
const ETA_CLAUSE = '(beräknad broöppning (strax|om (cirka )?([1-9]\\d{0,2}) minuter)|ETA okänd|inväntar broöppning)';
const CLAUSE_RES = [
  new RegExp('^Inga båtar är i närheten av Klaffbron eller Stridsbergsbron$'),
  new RegExp(`^En båt på väg mot ${TARGET}, ${ETA_CLAUSE}$`),
  new RegExp(`^${COUNT_WORDS} båtar på väg mot ${TARGET}, ${ETA_CLAUSE}$`),
  new RegExp(`^${COUNT_WORDS} båtar? är i närheten av (broarna|${TARGET})$`),
  new RegExp('^En båt \\d+m från .+$'), // beskrivande nödfallback
];
const ALL_BRIDGES = ['Klaffbron', 'Stridsbergsbron', 'Järnvägsbron', 'Olidebron', 'Stallbackabron', 'Kanalinfarten'];

/** Extrahera {bridge, eta} ur en klausul ("strax" → 0.5, "okänd" → null). */
function parseClause(clause) {
  const m = clause.match(new RegExp(`på väg mot ${TARGET}, ${ETA_CLAUSE}`));
  if (!m) return null;
  const bridge = m[1];
  if (/strax/.test(m[2])) return { bridge, eta: 0.5 };
  const num = m[2].match(/(\d+) minuter/);
  return { bridge, eta: num ? Number(num[1]) : null };
}

function validateInvariants(result) {
  const violations = [];
  const transitions = result.bridgeTextTransitions || [];
  const notifications = result.notifications || [];

  // INV-1: varje text matchar grammatiken; inga trasiga tokens
  for (const t of transitions) {
    if (/undefined|NaN|object Object/.test(t.text)) {
      violations.push(`TRASIG TEXT: ${t.iso} "${t.text}"`);
      continue;
    }
    for (const clause of t.text.split('; ')) {
      if (!CLAUSE_RES.some((re) => re.test(clause))) {
        violations.push(`OKÄND KLAUSUL: ${t.iso} "${clause}"`);
      }
    }
  }

  // INV-2: notistokens giltiga + inga (mmsi,bro)-dubbletter
  const seen = new Map();
  for (const n of notifications) {
    if (!n.mmsi || !/^\d+$/.test(String(n.mmsi))) violations.push(`NOTIS ogiltig mmsi: ${JSON.stringify(n)}`);
    if (!ALL_BRIDGES.includes(n.bridge)) violations.push(`NOTIS okänd bro: ${JSON.stringify(n)}`);
    if (!['northbound', 'southbound', 'unknown'].includes(n.direction)) violations.push(`NOTIS ogiltig riktning: ${JSON.stringify(n)}`);
    if (!Number.isInteger(n.eta) || n.eta < -1 || n.eta > 180) violations.push(`NOTIS ogiltig ETA: ${JSON.stringify(n)}`);
    if (n.success !== true) violations.push(`NOTIS misslyckad: ${JSON.stringify(n)}`);
    const k = `${n.mmsi}:${n.bridge}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  for (const [k, c] of seen) {
    if (c > 1) violations.push(`NOTIS-DUBBLETT: ${k} × ${c}`);
  }

  // INV-3: ETA-sågtand. Textnivån kan inte se VILKEN båt som bär klausulen
  // (ledarbåtsbyten ger legitima hopp även med samma antal-ord), så checken
  // riktas mot de två otvetydigt användarfientliga signaturerna:
  //  (a) upp-hopp ≥6 min inom ≤120 s i det operativa bandet (prev ≤ 20 min)
  //      — bilförare agerar på små ETA; 4→9 på sekunder är sågtanden.
  //  (b) oscillation X→Y→X′ (tillbaka inom ±1 av X efter ett ≥3-hopp) inom
  //      240 s — den definitiva fladdersignaturen oavsett nivå.
  const clauseSeries = new Map(); // bridge → [{t, iso, eta, count}]
  for (const t of transitions) {
    for (const clause of t.text.split('; ')) {
      const parsed = parseClause(clause);
      if (!parsed || parsed.eta === null) continue;
      if (!clauseSeries.has(parsed.bridge)) clauseSeries.set(parsed.bridge, []);
      clauseSeries.get(parsed.bridge).push({
        t: t.t, iso: t.iso, eta: parsed.eta, count: clause.split(' ')[0],
      });
    }
  }
  for (const [bridge, series] of clauseSeries) {
    for (let i = 1; i < series.length; i++) {
      const dt = (series[i].t - series[i - 1].t) / 1000;
      const delta = series[i].eta - series[i - 1].eta;
      if (dt <= 120 && delta >= 6 && series[i - 1].eta <= 20
          && series[i].count === series[i - 1].count) {
        violations.push(`ETA-SÅGTAND UPP: ${series[i].iso} ${bridge} ${series[i - 1].eta}→${series[i].eta} på ${Math.round(dt)}s`);
      }
      // Oscillation: leta X→Y→X′
      if (i >= 2) {
        const x = series[i - 2];
        const y = series[i - 1];
        const x2 = series[i];
        const span = (x2.t - x.t) / 1000;
        if (span <= 240 && Math.abs(y.eta - x.eta) >= 3 && Math.abs(x2.eta - x.eta) <= 1
            && x.count === y.count && y.count === x2.count) {
          violations.push(`ETA-OSCILLATION: ${x2.iso} ${bridge} ${x.eta}→${y.eta}→${x2.eta} inom ${Math.round(span)}s`);
        }
      }
    }
  }

  // INV-5 (2026-06-11): JOURNEY-invarianten — varje DETEKTERAD målbro-passage
  // måste ha minst en boat_near-notis för samma fartyg+bro någonstans i
  // körningen. Detta är invarianten som hade fångat AURANA-missen (20260525)
  // proaktivt: prod detekterade passagen men failsafen ströps → 0 notiser.
  // OBS: passager som aldrig DETEKTERAS (SABETH-klassen, totalt AIS-mörker)
  // genererar ingen passagehändelse och omfattas därmed inte — korrekt, ty
  // utan data är notis omöjlig.
  const notifiedKeys = new Set(notifications.map((n) => `${n.mmsi}:${n.bridge}`));
  for (const p of (result.targetPassages || [])) {
    if (!notifiedKeys.has(`${p.mmsi}:${p.bridge}`)) {
      violations.push(`MISSAD MÅLBRO-NOTIS: ${p.iso} ${p.mmsi} passerade ${p.bridge} utan notis`);
    }
  }

  // INV-4: count-degradering — generisk "är i närheten av"-text inklämd
  // mellan två detaljerade texter inom 90 s = transient valideringsmiss.
  for (let i = 1; i < transitions.length - 1; i++) {
    const isGeneric = /båtar? är i närheten av (broarna|Klaffbron|Stridsbergsbron)$/.test(transitions[i].text)
      && !/^Inga/.test(transitions[i].text);
    if (!isGeneric) continue;
    const prevDetailed = /på väg mot/.test(transitions[i - 1].text);
    const nextDetailed = /på väg mot/.test(transitions[i + 1].text);
    const span = (transitions[i + 1].t - transitions[i - 1].t) / 1000;
    if (prevDetailed && nextDetailed && span <= 90) {
      violations.push(`COUNT-DEGRADERING: ${transitions[i].iso} "${transitions[i].text}" inklämd (${Math.round(span)}s)`);
    }
  }

  return violations;
}

module.exports = { validateInvariants };
