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
 * INV-8  Namnkvalitet (skärpt 2026-07-03): notis med platshållarnamn trots
 *        att riktigt namn förekommit i strömmen före notisögonblicket.
 * INV-9  Klausulstruktur: max EN klausul per målbro i samma text; Klaffbron
 *        före Stridsbergsbron; rimlighetstak på antal (≤15).
 * INV-10 Strax-zombie: en "strax"-text som står orörd >35 min utan att någon
 *        målbropassage sker för bron är en fastfrusen lögn.
 * INV-11 Distansrimlighet (skärpt 2026-07-03): proximity-notiser ≤400 m;
 *        fallback-/inferensnotiser ≤10 km-sanity.
 * INV-12 Läckage: alla per-fartygs-strukturer (utom medvetna undantag) ska
 *        vara tomma efter efterspelet — timer-/latch-läckor blir pelarbrott
 *        i 24/7-drift.
 * INV-13 Målbro-degradering: en målbro (Klaffbron/Stridsbergsbron) som
 *        registreras som INTERMEDIATE har tappat target-status i själva
 *        passagemomentet — INV-5 ser den inte, så den flaggas explicit.
 *        Undantag: journey-reset (U-sväng) kan legitimt göra en f.d. målbro
 *        till mellanbro på returresan (t.ex. Stridsbergsbron för södergående
 *        som redan passerat den norrut före vändningen), samt no-target-
 *        markerade passager (mållös båt har inget target att transitera).
 * INV-16 ETA-fysik (skärpt 2026-07-03): implicerad fart distans/ETA < 30 kn
 *        för proximity-notiser.
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
      // Riktningsmedvetenhet (2026-07-02b): två notiser för samma nyckel i
      // MOTSATT riktning är en fysisk RETURPASSAGE (per-bro-semantiken:
      // varje transit ska notifiera) — legitim även utan reset-event, för
      // Fix D bekräftar inte alla U-svängar (t.ex. vändning FÖRE målbron
      // där ruttriktningen hinner låsas om av annan mekanism). Dubblett-
      // skyddet består i SAMMA riktning: där krävs journey-reset.
      const prevDir = sorted[i - 1].direction;
      const curDir = sorted[i].direction;
      const oppositeDirections = prevDir && curDir
        && prevDir !== 'unknown' && curDir !== 'unknown'
        && prevDir !== curDir;
      if (!resetBetween && !oppositeDirections) {
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
      // Oscillation: leta X→Y→X′. RELATIV tröskel (2026-07-02): hoppet måste
      // vara ≥ max(3, 30 % av nivån) — ±3-fladder på 12–19-min-nivån är
      // naturligt fartbrus för krypfartsbåtar, medan 4→9→5 i det låga bandet
      // (där bilförare agerar) är den äkta användarfientliga signaturen.
      if (i >= 2) {
        const x = series[i - 2];
        const y = series[i - 1];
        const x2 = series[i];
        const span = (x2.t - x.t) / 1000;
        const oscThreshold = Math.max(3, 0.3 * x.eta);
        if (span <= 240 && Math.abs(y.eta - x.eta) >= oscThreshold && Math.abs(x2.eta - x.eta) <= 1
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

  // INV-14 (2026-07-02): DEFAULT-flash — texten faller till "Inga båtar" och
  // återkommer inom 5 min med SAMMA signatur (samma målbro + samma antal-ord)
  // utan att någon målbropassage skett = ett fartyg doldes felaktigt.
  // NO LIMIT-klassen (11h-körningen 2026-07-02): stillaliggande båt med gles
  // mottagning gömdes av RC7-presentationsfiltret var 10:e minut → texten
  // flappade "på väg mot Klaffbron"↔"Inga båtar". INV-4 ser bara
  // 90 s-sandwichar med generisk text — den här klassen är längre och går
  // hela vägen till DEFAULT.
  for (let i = 1; i < transitions.length - 1; i++) {
    if (transitions[i].text !== DEFAULT_MESSAGE) continue;
    const prev = transitions[i - 1];
    const next = transitions[i + 1];
    // Mät DEFAULT-textens egen varaktighet — en "Inga båtar" som ersätts av
    // samma signatur inom 5 min var retroaktivt onödig (fartyget fanns kvar).
    const flashSpan = (next.t - transitions[i].t) / 1000;
    if (flashSpan > 300) continue;
    const clauseSig = (text) => {
      const m = new Map();
      for (const clause of text.split('; ')) {
        const p = clause.match(new RegExp(`^(\\S+) båt(?:ar)? på väg mot ${TARGET}`));
        if (p) m.set(p[2], p[1]);
      }
      return m;
    };
    const before = clauseSig(prev.text);
    const after = clauseSig(next.text);
    for (const [bridge, count] of before) {
      if (after.get(bridge) !== count) continue;
      const passageBetween = targetPassages.some(
        (p) => p.bridge === bridge && p.t >= prev.t && p.t <= next.t,
      );
      if (!passageBetween) {
        violations.push(`DEFAULT-FLASH: ${transitions[i].iso} "Inga båtar" inklämd (${Math.round(flashSpan)}s) mellan två "${count} … ${bridge}"-texter utan passage`);
      }
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

  // INV-8/INV-11/INV-16 (2026-07-03, SKÄRPTA från WARN i fas 6 — noll utslag
  // över 8 korpusar + 32 syntetiska efter B1/B2-fixarna):
  const PROXIMITY_SOURCES = new Set(['target', 'current', 'nearest', 'trigger-point']);
  const PLACEHOLDER_NAMES = new Set(['Unknown', 'Okänd båt']);
  const firstNameSeen = result.firstNameSeen || {};
  for (const n of notifications) {
    // INV-8 Namnkvalitet: notis med platshållarnamn trots att ett riktigt
    // namn för mmsi:t förekommit i strömmen FÖRE notisögonblicket — fångar
    // snapshot-/stickiness-brott (fältlist-fällans namnvariant).
    const knownSince = firstNameSeen[String(n.mmsi)];
    if ((!n.name || PLACEHOLDER_NAMES.has(n.name))
        && Number.isFinite(knownSince) && Number.isFinite(n.t) && knownSince <= n.t) {
      violations.push(`INV-8 NAMN: ${n.mmsi}@${n.bridge} fick "${n.name}" trots känt namn sedan ${new Date(knownSince).toISOString()}`);
    }
    // INV-11 Distansrimlighet: proximity-källor inom triggerradien (+marginal);
    // fallback-/inferenskällor får vara sena men aldrig bortom 10 km-sanity.
    if (Number.isFinite(n.distance)) {
      if (PROXIMITY_SOURCES.has(n.source) && n.distance > 400) {
        violations.push(`INV-11 DISTANS: ${n.mmsi}@${n.bridge} @${n.distance}m via source=${n.source} (proximity-källa >400 m)`);
      } else if (n.distance > 10000) {
        violations.push(`INV-11 DISTANS: ${n.mmsi}@${n.bridge} @${n.distance}m via source=${n.source} (bortom 10 km-sanity)`);
      }
    }
    // INV-16 ETA-vs-distans-fysik: implicerad fart < 30 kn för proximity-källor.
    if (PROXIMITY_SOURCES.has(n.source) && Number.isFinite(n.distance)
        && Number.isInteger(n.eta) && n.eta > 0) {
      const impliedMs = n.distance / (n.eta * 60);
      if (impliedMs > 15.4) {
        violations.push(`INV-16 ETA-FYSIK: ${n.mmsi}@${n.bridge} ${n.distance}m på ${n.eta} min ⇒ ${(impliedMs * 1.944).toFixed(0)} kn`);
      }
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
    // no-target-undantag (2026-07-03, NO LIMIT): en MÅLLÖS båts passage av en
    // målbro är korrekt intermediate-bokförd — kajavgångens rörelsebeviskrav
    // håller target tills rörelse setts, och det finns inget target att
    // transitera. Notispelaren vaktas separat av INV-5/notisfångsten.
    if (ip.noTarget === true) continue;
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

/**
 * WARN-invarianter (2026-07-03, fas 0.4) — sanningskontroller i VARNINGSLÄGE.
 * INV-8/11/16 SKÄRPTES till fatala (validateInvariants) i fas 6 efter noll
 * utslag över 8 korpusar + 32 syntetiska. Kvar som WARN (kända, dokumenterade
 * heuristikbrister — omprövas per körning):
 *
 * INV-15 Riktning-vs-geografi: notisens direction ska stämma med fartygets
 *        faktiska lat-rörelse runt notisögonblicket. WARN pga legitima
 *        momentana backningar (kö-drift vid väntan: PHILULA@Jvb −120 m) och
 *        scenario-artefakter (teleport/stale-echo rör sig bakåt per design).
 * INV-17 Textflapp-budget: ≥5 textbyten inom 60 s eller >40 byten/timme.
 *        WARN tills budgeten kalibrerats per samtidig båtmängd (flertrafik-
 *        scenariot ger legitimt 66/h med tre båtar i rörelse).
 * INV-18 Mjuk ETA-monotoni: obruten stigande ETA-serie (+≥8 min inom ≤15 min,
 *        samma antal-ord, ingen passage). WARN pga legitim fysik: en båt som
 *        SAKTAR IN får stigande ETA (krypfart-scenariot 19→42 min är sant).
 */
function validateWarnInvariants(result) {
  const warnings = [];
  const notifications = result.notifications || [];
  const transitions = result.bridgeTextTransitions || [];
  const targetPassages = result.targetPassages || [];

  for (const n of notifications) {
    // INV-15: riktning-vs-geografi (0.0005° lat ≈ 55 m — under det är trenden brus)
    if (Number.isFinite(n.vesselLat) && Number.isFinite(n.vesselLatNext)
        && (n.direction === 'northbound' || n.direction === 'southbound')) {
      const dLat = n.vesselLatNext - n.vesselLat;
      if (Math.abs(dLat) > 0.0005) {
        const geoDir = dLat > 0 ? 'northbound' : 'southbound';
        if (geoDir !== n.direction) {
          warnings.push(`INV-15 RIKTNING: ${n.mmsi}@${n.bridge} direction=${n.direction} men lat rör sig ${geoDir === 'northbound' ? 'norrut' : 'söderut'} (Δ${dLat.toFixed(5)})`);
        }
      }
    }
  }

  // INV-17: textflapp-budget
  for (let i = 0; i + 4 < transitions.length; i++) {
    const span = (transitions[i + 4].t - transitions[i].t) / 1000;
    if (span <= 60) {
      warnings.push(`INV-17 FLAPP: 5 textbyten inom ${Math.round(span)}s vid ${transitions[i].iso}`);
      i += 4; // rapportera klustret en gång
    }
  }
  if (transitions.length >= 2) {
    const hours = (transitions[transitions.length - 1].t - transitions[0].t) / 3600000;
    if (hours >= 1 && transitions.length / hours > 40) {
      warnings.push(`INV-17 FLAPP: ${(transitions.length / hours).toFixed(0)} textbyten/timme över ${hours.toFixed(1)}h`);
    }
  }

  // INV-18: mjuk ETA-monotoni — obruten stigande serie utan passage
  const softSeries = new Map(); // bridge → [{t, iso, eta, count}]
  for (const t of transitions) {
    for (const clause of t.text.split('; ')) {
      const parsed = parseClause(clause);
      if (!parsed || parsed.eta === null) continue;
      if (!softSeries.has(parsed.bridge)) softSeries.set(parsed.bridge, []);
      softSeries.get(parsed.bridge).push({
        t: t.t, iso: t.iso, eta: parsed.eta, count: clause.split(' ')[0],
      });
    }
  }
  for (const [bridge, series] of softSeries) {
    let runStart = 0;
    for (let i = 1; i <= series.length; i++) {
      const rising = i < series.length
        && series[i].eta > series[i - 1].eta
        && series[i].count === series[i - 1].count
        && (series[i].t - series[i - 1].t) <= 5 * 60 * 1000;
      if (rising) continue;
      const first = series[runStart];
      const last = series[i - 1];
      const riseMin = last.eta - first.eta;
      const spanMs = last.t - first.t;
      if (riseMin >= 8 && spanMs <= 15 * 60 * 1000 && i - 1 > runStart) {
        const passageInWindow = targetPassages.some(
          (p) => p.bridge === bridge && p.t >= first.t && p.t <= last.t,
        );
        if (!passageInWindow) {
          warnings.push(`INV-18 ETA-STIGNING: ${first.iso} ${bridge} ${first.eta}→${last.eta} min över ${Math.round(spanMs / 60000)} min utan passage`);
        }
      }
      runStart = i;
    }
  }

  return warnings;
}

module.exports = { validateInvariants, validateWarnInvariants };
