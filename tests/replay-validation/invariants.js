'use strict';

/**
 * Invariant-validator (2026-06-11, fördjupad 2026-07-01) — FACIT-OBEROENDE
 * sanningskontroller på replay-utdata. Detta är svaret på facit-fällan: en
 * jämförelse mot prod-utfall kan aldrig fånga buggar som prod också hade
 * (RC1–RC3 låg osynliga i tre korpusar). Invarianterna uttrycker vad som
 * MÅSTE gälla oavsett facit.
 *
 * Körs av runAllCorpora + runSyntheticScenarios på varje körning;
 * brott på låst korpus = regression.
 *
 * INV-1  Grammatik: varje publicerad text matchar Variant-1-grammatiken;
 *        inga trasiga tokens (undefined/NaN/null/[object Object]).
 * INV-2  Notiskvalitet: giltiga tokens; (mmsi,bro)-dubbletter är brott UTOM
 *        när en journey-reset (U-sväng/NEW_JOURNEY/re-entry) ligger mellan
 *        dem — då är det en legitim ANDRA passage av samma bro.
 * INV-3  ETA-sågtand: upp-hopp ≥6 min inom ≤120 s i operativa bandet, och
 *        oscillation X→Y→X′ inom 240 s.
 * INV-4  Count-degradering: generisk "är i närheten"-text inklämd mellan
 *        två detaljerade inom 90 s.
 * INV-5  Journey: varje DETEKTERAD målbropassage ⇒ minst en notis för samma
 *        fartyg+bro någonstans i körningen.
 * INV-6  Sluttext: när 0 fartyg återstår efter efterspelet måste sista
 *        publicerade texten vara DEFAULT — fångar spöktext/stale text.
 * INV-7  Notis-timing: varje målbropassage ska ha en notis senast 60 s efter
 *        registreringen — "klockan får inte ringa efter att tåget gått".
 * INV-9  Klausulstruktur: max EN klausul per målbro i samma text; Klaffbron
 *        före Stridsbergsbron; rimlighetstak på antal (≤15).
 * INV-10 Strax-zombie: en "strax"-text som står orörd >35 min utan att någon
 *        målbropassage sker för bron är en fastfrusen lögn.
 * INV-12 Läckage: alla per-fartygs-strukturer (utom medvetna undantag) ska
 *        vara tomma efter efterspelet — timer-/latch-läckor blir pelarbrott
 *        i 24/7-drift.
 * INV-13 Målbro-degradering: en målbro (Klaffbron/Stridsbergsbron) som
 *        registreras som INTERMEDIATE har tappat target-status i själva
 *        passagemomentet — INV-5 ser den inte, så den flaggas explicit.
 *        Undantag: journey-reset (U-sväng) kan legitimt göra en f.d. målbro
 *        till mellanbro på returresan (t.ex. Stridsbergsbron för södergående
 *        som redan passerat den norrut före vändningen).
 */

const COUNT_WORDS = '(En|Två|Tre|Fyra|Fem|Sex|Sju|Åtta|Nio|Tio|[2-9]\\d?)';
const TARGET = '(Klaffbron|Stridsbergsbron)';
const ETA_CLAUSE = '(beräknad broöppning (strax|om (cirka )?([1-9]\\d{0,2}) minuter)|ETA okänd|inväntar broöppning)';
const CLAUSE_RES = [
  new RegExp('^Inga båtar är i närheten av Klaffbron eller Stridsbergsbron$'),
  new RegExp(`^En båt på väg mot ${TARGET}, ${ETA_CLAUSE}$`),
  new RegExp(`^${COUNT_WORDS} båtar på väg mot ${TARGET}, ${ETA_CLAUSE}$`),
  new RegExp(`^${COUNT_WORDS} båtar? är i närheten av (broarna|${TARGET})$`),
  // INV-1-skärpning (2026-07-01): nödfallbacken måste peka på en KÄND bro —
  // "En båt 250m från null" passerade tidigare.
  new RegExp('^En båt \\d+m från (Klaffbron|Stridsbergsbron|Järnvägsbron|Olidebron|Stallbackabron|Kanalinfarten)$'),
  // Bug#12-guardens override vid >2 min AIS-avbrott (legitim under
  // disconnect-ctrl-scenarier).
  new RegExp('^AIS-anslutning saknas — data kan vara inaktuell$'),
];
const ALL_BRIDGES = ['Klaffbron', 'Stridsbergsbron', 'Järnvägsbron', 'Olidebron', 'Stallbackabron', 'Kanalinfarten'];
const DEFAULT_MESSAGE = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
const TARGET_BRIDGES = ['Klaffbron', 'Stridsbergsbron'];

/** Extrahera {bridge, eta} ur en klausul ("strax" → 0.5, "okänd" → null). */
function parseClause(clause) {
  const m = clause.match(new RegExp(`på väg mot ${TARGET}, ${ETA_CLAUSE}`));
  if (!m) return null;
  const bridge = m[1];
  if (/strax/.test(m[2])) return { bridge, eta: 0.5 };
  const num = m[2].match(/(\d+) minuter/);
  return { bridge, eta: num ? Number(num[1]) : null };
}

/** Summera antal båtar som nämns i en text (ordtal + siffror). */
const WORD_TO_NUM = {
  en: 1, två: 2, tre: 3, fyra: 4, fem: 5, sex: 6, sju: 7, åtta: 8, nio: 9, tio: 10,
};
function countMentioned(text) {
  let total = 0;
  const re = /(?:^|\s|;)(\d+|En|Två|Tre|Fyra|Fem|Sex|Sju|Åtta|Nio|Tio)\s+båt(?:ar)?\b/gi;
  let m = re.exec(text);
  while (m !== null) {
    const tok = m[1].toLowerCase();
    total += /^\d+$/.test(tok) ? parseInt(tok, 10) : (WORD_TO_NUM[tok] || 0);
    m = re.exec(text);
  }
  return total;
}

function validateInvariants(result) {
  const violations = [];
  const transitions = result.bridgeTextTransitions || [];
  const notifications = result.notifications || [];
  const journeyResets = result.journeyResets || [];
  const targetPassages = result.targetPassages || [];
  const intermediatePassages = result.intermediatePassages || [];

  // INV-1: varje text matchar grammatiken; inga trasiga tokens
  for (const t of transitions) {
    if (/undefined|NaN|object Object|\bnull\b/.test(t.text)) {
      violations.push(`TRASIG TEXT: ${t.iso} "${t.text}"`);
      continue;
    }
    for (const clause of t.text.split('; ')) {
      if (!CLAUSE_RES.some((re) => re.test(clause))) {
        violations.push(`OKÄND KLAUSUL: ${t.iso} "${clause}"`);
      }
    }
  }

  // INV-2: notistokens giltiga + (mmsi,bro)-dubbletter utan mellanliggande
  // journey-reset. En bekräftad U-sväng/re-entry mellan två notiser för samma
  // nyckel legitimerar den andra (fysiskt två passager av samma bro).
  const byKey = new Map();
  for (const n of notifications) {
    if (!n.mmsi || !/^\d+$/.test(String(n.mmsi))) violations.push(`NOTIS ogiltig mmsi: ${JSON.stringify(n)}`);
    if (!ALL_BRIDGES.includes(n.bridge)) violations.push(`NOTIS okänd bro: ${JSON.stringify(n)}`);
    if (!['northbound', 'southbound', 'unknown'].includes(n.direction)) violations.push(`NOTIS ogiltig riktning: ${JSON.stringify(n)}`);
    if (!Number.isInteger(n.eta) || n.eta < -1 || n.eta > 180) violations.push(`NOTIS ogiltig ETA: ${JSON.stringify(n)}`);
    if (n.success !== true) violations.push(`NOTIS misslyckad: ${JSON.stringify(n)}`);
    const k = `${n.mmsi}:${n.bridge}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(n);
  }
  for (const [k, list] of byKey) {
    if (list.length < 2) continue;
    const mmsi = k.split(':')[0];
    const sorted = [...list].sort((a, b) => (a.t || 0) - (b.t || 0));
    for (let i = 1; i < sorted.length; i++) {
      const prevT = sorted[i - 1].t || 0;
      const curT = sorted[i].t || 0;
      const resetBetween = journeyResets.some(
        (r) => r.mmsi === mmsi && r.t >= prevT && r.t <= curT,
      );
      if (!resetBetween) {
        violations.push(`NOTIS-DUBBLETT: ${k} × ${list.length} utan journey-reset emellan`);
        break;
      }
    }
  }

  // INV-3: ETA-sågtand (se huvuddoc).
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
      // Oscillation: leta X→Y→X′. Bandat till det operativa området (X ≤ 15
      // min, 2026-07-01) — bilförare agerar på små ETA; ±3-fladder på
      // 16–19-min-nivån är naturligt fartbrus för krypfartsbåtar, inte den
      // användarfientliga signaturen.
      if (i >= 2) {
        const x = series[i - 2];
        const y = series[i - 1];
        const x2 = series[i];
        const span = (x2.t - x.t) / 1000;
        if (span <= 240 && x.eta <= 15 && Math.abs(y.eta - x.eta) >= 3 && Math.abs(x2.eta - x.eta) <= 1
            && x.count === y.count && y.count === x2.count) {
          violations.push(`ETA-OSCILLATION: ${x2.iso} ${bridge} ${x.eta}→${y.eta}→${x2.eta} inom ${Math.round(span)}s`);
        }
      }
    }
  }

  // INV-5: JOURNEY-invarianten — varje DETEKTERAD målbro-passage måste ha
  // minst en boat_near-notis för samma fartyg+bro någonstans i körningen.
  // (Passager som aldrig detekteras — totalt AIS-mörker — omfattas inte:
  // utan data är notis omöjlig.)
  const notifiedKeys = new Set(notifications.map((n) => `${n.mmsi}:${n.bridge}`));
  for (const p of targetPassages) {
    if (!notifiedKeys.has(`${p.mmsi}:${p.bridge}`)) {
      violations.push(`MISSAD MÅLBRO-NOTIS: ${p.iso} ${p.mmsi} passerade ${p.bridge} utan notis`);
    }
  }

  // INV-7: notis-timing — passagens notis ska finnas senast 60 s efter
  // registreringen (proximity-notiser kommer långt FÖRE, failsafes i samma
  // tick — båda OK; en notis som dröjer minuter efter passagen är värdelös).
  for (const p of targetPassages) {
    const hasTimely = notifications.some(
      (n) => n.mmsi === p.mmsi && n.bridge === p.bridge
        && Number.isFinite(n.t) && n.t <= p.t + 60000,
    );
    const hasAny = notifiedKeys.has(`${p.mmsi}:${p.bridge}`);
    if (hasAny && !hasTimely) {
      violations.push(`SEN MÅLBRO-NOTIS: ${p.iso} ${p.mmsi}@${p.bridge} — notisen kom >60s efter registrerad passage`);
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

  // INV-6: sluttext — 0 fartyg kvar efter efterspelet ⇒ sista texten DEFAULT.
  // Fångar spöktext (texten fortsätter visa en båt som inte finns) — tidigare
  // kontrollerade ingen del av sviten själva TEXTEN vid tomt slutläge.
  const leaks = result.leakDiagnostics || {};
  if (leaks.vessels === 0 && transitions.length > 0) {
    const last = transitions[transitions.length - 1];
    if (last.text !== DEFAULT_MESSAGE) {
      violations.push(`SPÖKTEXT VID SLUT: 0 fartyg kvar men sista texten är "${last.text}"`);
    }
  }

  // INV-9: klausulstruktur — max en klausul per målbro, Klaffbron först,
  // rimlighetstak på totalantal.
  for (const t of transitions) {
    if (!/på väg mot/.test(t.text)) continue;
    const clauses = t.text.split('; ');
    const bridgesSeen = [];
    for (const clause of clauses) {
      const m = clause.match(new RegExp(`på väg mot ${TARGET}`));
      if (m) bridgesSeen.push(m[1]);
    }
    const dupBridge = bridgesSeen.find((b, i) => bridgesSeen.indexOf(b) !== i);
    if (dupBridge) {
      violations.push(`DUBBEL MÅLBRO-KLAUSUL: ${t.iso} "${t.text}"`);
    }
    if (bridgesSeen.length === 2
        && bridgesSeen[0] === 'Stridsbergsbron' && bridgesSeen[1] === 'Klaffbron') {
      violations.push(`FEL KLAUSULORDNING: ${t.iso} "${t.text}" (Klaffbron ska stå först)`);
    }
    const mentioned = countMentioned(t.text);
    if (mentioned > 15) {
      violations.push(`ORIMLIGT ANTAL: ${t.iso} "${t.text}" (${mentioned} båtar)`);
    }
  }

  // INV-10: strax-zombie — en "strax"-text som står orörd >35 min utan att
  // någon målbropassage sker för bron under fönstret är en fastfrusen lögn
  // (35 min > STALE_AIS 30 min + marginal, så legitima väntare hinner städas).
  const STRAX_ZOMBIE_MS = 35 * 60 * 1000;
  const runEnd = transitions.length > 0 ? transitions[transitions.length - 1].t : 0;
  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i];
    const straxBridges = [];
    for (const clause of t.text.split('; ')) {
      const parsed = parseClause(clause);
      if (parsed && /strax/.test(clause)) straxBridges.push(parsed.bridge);
    }
    if (straxBridges.length === 0) continue;
    const nextT = i + 1 < transitions.length ? transitions[i + 1].t : runEnd;
    const stoodMs = nextT - t.t;
    if (stoodMs <= STRAX_ZOMBIE_MS) continue;
    for (const bridge of straxBridges) {
      const passageInWindow = targetPassages.some(
        (p) => p.bridge === bridge && p.t >= t.t && p.t <= t.t + stoodMs,
      );
      if (!passageInWindow) {
        violations.push(`STRAX-ZOMBIE: ${t.iso} "${t.text}" stod ${Math.round(stoodMs / 60000)} min utan ${bridge}-passage`);
      }
    }
  }

  // INV-12: läckage — alla per-fartygs-strukturer ska vara tomma efter
  // efterspelet. Medvetna undantag: triggeredBoatNearKeys (BUG 7 bevarar
  // dedup-nycklar vid timeout-removal), persistentRecentTriggers (2h TTL
  // by design), heapUsedMB (mätvärde, ej räknare).
  const LEAK_EXCEPTIONS = new Set(['triggeredBoatNearKeys', 'persistentRecentTriggers', 'heapUsedMB']);
  for (const [field, value] of Object.entries(leaks)) {
    if (LEAK_EXCEPTIONS.has(field)) continue;
    if (Number.isFinite(value) && value !== 0) {
      violations.push(`LÄCKAGE: ${field}=${value} efter efterspel (ska vara 0)`);
    }
  }

  // INV-13: målbro registrerad som INTERMEDIATE = tyst degraderad
  // målbropassage (target-status tappad i passagemomentet) — osynlig för
  // INV-5. Undantag: (a) efter journey-reset kan en f.d. målbro legitimt
  // vara mellanbro på returresan; (b) transient degradering som RC9-
  // inferensen korrigerar i samma tick (TARGET_PASSAGE_RECORDED för samma
  // fartyg+bro inom 60 s) är självläkt — målbrostatusen återupprättades.
  for (const ip of intermediatePassages) {
    if (!TARGET_BRIDGES.includes(ip.bridge)) continue;
    const resetBefore = journeyResets.some((r) => r.mmsi === ip.mmsi && r.t <= ip.t);
    const correctedAsTarget = targetPassages.some(
      (p) => p.mmsi === ip.mmsi && p.bridge === ip.bridge && Math.abs(p.t - ip.t) <= 60000,
    );
    if (!resetBefore && !correctedAsTarget) {
      violations.push(`MÅLBRO SOM MELLANBRO: ${ip.iso} ${ip.mmsi} fick ${ip.bridge} registrerad som intermediate utan korrigering`);
    }
  }

  return violations;
}

module.exports = { validateInvariants };
