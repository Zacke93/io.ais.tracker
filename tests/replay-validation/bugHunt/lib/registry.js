'use strict';

/**
 * Beslutsregistret (BUGGJAKT §7).
 *
 * beslutsregister.json är en maskinläsbar SPEGEL av ägarbesluten; källan är
 * alltid docs/ eller koden. Motorn ändrar aldrig registret. Ett utslag
 * omklassas bara när orakel, klass (klassRegex) och predikat alla matchar;
 * ett fatalt invariantutslag (INV-F) omklassas dessutom bara av en post som
 * NAMNGER INV-id:t i gäller.inv (säkerhetsregeln). Allt som inte matchar är
 * KANDIDAT.
 *
 * Predikaten är data med parametrar, inte kod per post. De läser produktens
 * konstanter (lib/constants.js, och de få gränser som är lokala i en
 * produktfil läses ur källtexten med appKonstant) men anropar inga
 * produktfunktioner som avgör samma sak som oraklet. Varje predikat
 * returnerar {sant, skäl}; skälet visas i rapportens registerrad ("närmast
 * …, predikatet falskt: …").
 *
 * Poster med "verkan": "tagg" omklassar inte — de lägger bara till postens id
 * som tagg och klassningen fortsätter (STRESS-TÄTHET: stressvärldar redovisas
 * i egen sektion men är fortfarande kandidater). Eftersom en taggpost aldrig
 * omklassar gäller säkerhetsregeln inte den: med orakel '*' når den även
 * INV-F-fynd utan att namnge något INV-id (rättat 2026-11-04, runda 2 E7;
 * förut saknade stressvärldarnas INV-F-fynd taggen).
 *
 * Poster med "verkan": "iOraklet" speglar ett beslut som oraklet själv
 * tillämpar som förutsättning eller del av sin regel (fältet `orakelvakt`
 * pekar ut var). De kan aldrig matcha ett utslag, så klassningen hoppar över
 * dem: de blir aldrig "närmast", räknas inte som oanvända och redovisas för
 * sig i rapporten (M12, 2026-11-04).
 *
 * Kontexten (andra argumentet till classify) kan innehålla:
 *   rader      världens/korpusens/variantens rader (positioner + ctrl)
 *   resultat   appens replayresultat (eventId namnrymdade)
 *   bas        basens resultat (bankvarianter)
 *   korpus     korpusposten ur corpora.js (knownInvariantExceptions)
 *   gt         L1-punktfacit i gt-passages-format (inferred utesluts)
 *   sanning    L0 ur sanningsspåret {crossings, uturns, stops, …} (valfri)
 *   radio      'R0' | 'R1' | null,  profil  'quick' | 'standard' | 'night'
 *   täthet     {stress: boolean, …} (sanningsspåret)
 * Saknas underlaget för ett predikat blir det falskt med skälet "saknar …".
 */

const fs = require('fs');
const path = require('path');
const constants = require('../../../../lib/constants');
const platser = require('./platser');
const signature = require('./signature');
const hygiene = require('./hygiene');
const konvoj = require('./konvoj');
const { fromEntries } = require('./util');

const REGISTER_PATH = path.join(__dirname, '..', 'beslutsregister.json');

const ENTRY_CLASSES = Object.freeze(['DESIGN', 'ACCEPTERAD', 'KÄND_ÖPPEN', 'KONFLIKT', 'KOSTNAD', 'MÄTGRÄNS', 'INSTRUMENTFEL']);
const VERKAN = Object.freeze(['omklassa', 'tagg', 'iOraklet']);
const KANDIDAT = 'KANDIDAT';
const MIN = 60 * 1000;

/**
 * En numerisk konstant ur appens källtext, för de få gränser som är lokala i
 * en produktfil och inte exporteras ur lib/constants.js. Deklarationen
 * `const NAMN = tal;` måste stå exakt en gång i filen. Annars blir värdet
 * null, registrets laddning varnar och predikatet som behöver värdet blir
 * falskt: ingen amnesti på en gissad gräns.
 * @param {string} relFil - filen relativt repots rot
 * @param {string} namn - konstantens namn
 * @param {string} [root] - repots rot
 * @returns {number|null} värdet
 */
function appKonstant(relFil, namn, root = hygiene.REPO_ROOT) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, relFil), 'utf8');
  } catch (err) {
    return null;
  }
  const träffar = [...text.matchAll(new RegExp(`\\bconst\\s+${namn}\\s*=\\s*(\\d+(?:\\.\\d+)?)\\s*;`, 'g'))];
  return träffar.length === 1 ? Number(träffar[0][1]) : null;
}

// Fix D:s fartgräns är lokal i VesselDataService.js (`const FIX_D_MIN_SOG =
// 2.0;`, :380 och villkoret :389). Bara en fix med minst den farten sätter
// pending-flaggan som S10-vakten kräver, och en andra omvänd fix med minst
// den farten bekräftar reversalen (:446–470). Se reversalAwayFromBridge.
const APPKONSTANTER = Object.freeze([
  {
    namn: 'FIX_D_MIN_SOG', fil: 'lib/services/VesselDataService.js', predikat: 'reversalAwayFromBridge', parameter: 'fixDMinSogKn',
  },
].map((k) => Object.freeze({ ...k, värde: appKonstant(k.fil, k.namn) })));
const FIX_D_MIN_SOG = APPKONSTANTER.find((k) => k.namn === 'FIX_D_MIN_SOG').värde;

// ---------------------------------------------------------------------------
// Hjälpare för predikaten
// ---------------------------------------------------------------------------

const ok = (skäl) => ({ sant: true, skäl });
const nej = (skäl) => ({ sant: false, skäl });
const fmtT = (t) => (Number.isFinite(t) ? new Date(Math.round(t)).toISOString().slice(11, 19) : '?');

/** Världens positionsrader per mmsi (sorterade på tid), cachade i kontexten. */
function perFartyg(ctx) {
  if (!ctx || !Array.isArray(ctx.rader)) return new Map();
  if (!ctx.__perMmsi) Object.defineProperty(ctx, '__perMmsi', { value: platser.rowsByMmsi(ctx.rader), enumerable: false });
  return ctx.__perMmsi;
}

function rowsOf(ctx, mmsi) {
  if (!ctx || !Array.isArray(ctx.rader) || !mmsi) return [];
  return perFartyg(ctx).get(String(mmsi)) || [];
}

// Harnessens klocka (replayRunner.js:122–126 och 501–622). Raderna matas i
// aisTimestamp-ordning (stabil sortering). Före en rad stegas klockan fram
// till radens tid, om den inte redan har passerat den, och dräneras. Efter
// varje AIS-rad tickar harnessen 60 ms (clock.tick(60)); styrraderna
// disconnect, reconnect och restart tickar inte.
const HARNESS_STYRRADER = Object.freeze(new Set(['disconnect', 'reconnect', 'restart']));
const HARNESS_TICK_EFTER_RAD_MS = 60;

/**
 * Harnessens bearbetningstid för varje rad, cachad i kontexten. En rad
 * bearbetas vid max(radens tid, förra AIS-radens bearbetningstid + 60 ms),
 * och appen stämplar positionen då (vessel.timestamp = Date.now(),
 * VesselDataService.js:5291). Dräneringen före bearbetningen sker vid samma
 * fejkade tid, så en text som publiceras där bygger på läget före raden.
 * Infört 2026-11-04 (efterrättning R3b) för f40StudsVidNästaFix.
 * @param {object} ctx - kontexten (rader, med styrraderna)
 * @returns {Map<object, number>} rad → bearbetningstid (epok-ms)
 */
function harnessTider(ctx) {
  if (!ctx || !Array.isArray(ctx.rader)) return new Map();
  if (!ctx.__harnessTider) {
    const ordning = ctx.rader.filter(Boolean).sort((a, b) => (a.aisTimestamp || 0) - (b.aisTimestamp || 0));
    const tider = new Map();
    let nu = -Infinity;
    for (const r of ordning) {
      if (r.aisTimestamp > nu) nu = r.aisTimestamp;
      tider.set(r, nu);
      if (!HARNESS_STYRRADER.has(r.ctrl)) nu += HARNESS_TICK_EFTER_RAD_MS;
    }
    Object.defineProperty(ctx, '__harnessTider', { value: tider, enumerable: false });
  }
  return ctx.__harnessTider;
}

function deliveredNotes(ctx, mmsi, bro) {
  const notes = (ctx && ctx.resultat && ctx.resultat.notifications) || [];
  return notes
    .filter((n) => n.success !== false && String(n.mmsi) === String(mmsi) && (!bro || n.bridge === bro) && Number.isFinite(n.t))
    .sort((a, b) => a.t - b.t);
}

function deliveredWarnings(ctx, bro) {
  const ws = (ctx && ctx.resultat && ctx.resultat.openingWarnings) || [];
  return ws.filter((w) => w.success !== false && (!bro || w.bridge === bro) && Number.isFinite(w.t)).sort((a, b) => a.t - b.t);
}

function restartsOf(ctx) {
  return ((ctx && ctx.rader) || []).filter((r) => r && r.ctrl === 'restart').map((r) => r.aisTimestamp).sort((a, b) => a - b);
}

/** Punktobserverbara korsningar (L1-gt, inferred utesluts). */
function pointCrossings(ctx, bro) {
  const gt = (ctx && Array.isArray(ctx.gt)) ? ctx.gt : [];
  return gt.filter((g) => g && g.kind !== 'zone' && g.inferred !== true && (!bro || g.bridge === bro) && Number.isFinite(g.t))
    .sort((a, b) => a.t - b.t);
}

/** L0-korsningar ur sanningen (om den finns). */
function truthCrossings(ctx, bro) {
  const s = ctx && ctx.sanning;
  const list = (s && (s.crossings || s.korsningar)) || [];
  return list.filter((c) => c && (!bro || c.bridge === bro) && Number.isFinite(c.t)).sort((a, b) => a.t - b.t);
}

/**
 * Underlaget för konvojsemantiken (lib/konvoj.js), samma indata som
 * T2-oraklet: levererade varningar, punktkorsningar och openingCoverage vid
 * bron. Saknar kontexten punktfacit för bron används appens registrerade
 * målbropassager (bara i fixturer utan facit; T2 dömer aldrig en bro utan
 * punktkorsningar).
 */
function convoyData(ctx, bro) {
  let korsningar = pointCrossings(ctx, bro);
  if (!korsningar.length) {
    korsningar = ((ctx && ctx.resultat && ctx.resultat.targetPassages) || [])
      .filter((x) => x && x.bridge === bro && Number.isFinite(x.t))
      .sort((a, b) => a.t - b.t);
  }
  return {
    varningar: deliveredWarnings(ctx, bro),
    korsningar,
    coverage: (ctx && ctx.resultat && ctx.resultat.openingCoverage) || [],
  };
}

/** Korsningstiden för fyndet: belägg.korsningT, annars fyndets t. */
function crossingTimeOf(f) {
  const b = f.belägg || {};
  if (Number.isFinite(b.korsningT)) return b.korsningT;
  return f.t;
}

/**
 * Hittar ett utfärdsbevis: minst `fixar` konsekutiva observerade fixar längre
 * än `utfärdM` från punkten i (tA, tB).
 */
function exitProof(list, bro, tA, tB, utfärdM, fixar) {
  let run = 0;
  for (const r of list) {
    if (r.aisTimestamp <= tA || r.aisTimestamp >= tB) continue;
    if (platser.distanceToPoint(r, bro) > utfärdM) {
      run++;
      if (run >= fixar) return r;
    } else {
      run = 0;
    }
  }
  return null;
}

/** Besöksfönstret (tA, tB) för sameVisit/boxEdgeExit. */
function visitWindow(f, ctx) {
  const b = f.belägg || {};
  if (f.inv === 'INV-5' || f.inv === 'INV-7') {
    const passages = ((ctx.resultat && ctx.resultat.targetPassages) || [])
      .filter((p) => String(p.mmsi) === String(f.mmsi) && p.bridge === f.bro)
      .sort((a, b2) => a.t - b2.t);
    const notes = deliveredNotes(ctx, f.mmsi, f.bro);
    if (passages.length < 2) return { fel: 'färre än två registrerade målbropassager' };
    if (!notes.length) return { fel: 'ingen notis alls för nyckeln' };
    return { tA: Math.min(notes[0].t, passages[0].t), tB: passages[passages.length - 1].t, ankare: notes[0] };
  }
  const tB = Number.isFinite(b.tFörstaFix) ? b.tFörstaFix : f.t;
  if (!Number.isFinite(tB)) return { fel: 'fyndet saknar tid' };
  const prev = deliveredNotes(ctx, f.mmsi, f.bro).filter((n) => n.t < tB).pop();
  if (!prev) {
    // Ett besök som var ÖPPET i korpusens starttillstånd (trigger_point_visits
    // utan exitedAt) fick sin notis före korpusen: besöket pågår från första
    // raden (TriggerPointVisitTracker återställs ur state).
    const open = ctx && ctx.öppnaBesök && typeof ctx.öppnaBesök.has === 'function' && ctx.öppnaBesök.has(`${f.mmsi}:${f.bro}`);
    if (open) {
      return {
        tA: -Infinity, tB, ankare: null, starttillstånd: true,
      };
    }
    return { fel: 'ingen tidigare notis för nyckeln' };
  }
  return { tA: prev.t, tB, ankare: prev };
}

/** Sidledsfria farledskoordinater (s) för en båts fixar i ett fönster. */
function sSeries(list, t0, t1) {
  return list.filter((r) => r.aisTimestamp >= t0 && r.aisTimestamp <= t1).map((r) => ({ t: r.aisTimestamp, s: platser.project(r).s }));
}

/** Vändpunkter med tröskel minM (zigzag) — returnerar vändningarnas tider. */
function reversals(series, minM) {
  const out = [];
  if (series.length < 3) return out;
  let dir = 0;
  let pivot = series[0];
  for (const p of series.slice(1)) {
    const d = p.s - pivot.s;
    if (dir === 0) {
      // Första rörelsen ≥ minM bestämmer riktningen.
      if (Math.abs(d) >= minM) {
        dir = Math.sign(d);
        pivot = p;
      }
    } else if (Math.sign(d) === dir) {
      pivot = p; // fortsätter åt samma håll — flytta extremen
    } else if (Math.abs(d) >= minM) {
      out.push(pivot.t);
      dir = -dir;
      pivot = p;
    }
  }
  return out;
}

/**
 * Första halvminutsticken vars textgenerering kan falla strikt inne i
 * glappet (a, b): ticken T = k · tickMs (absoluta halvminuter i epok-ms, som
 * UI-klockan) genererar sin text i [T; T + fördröjningMs], och det fönstret
 * ska skära (a, b). Annars null.
 * @param {number} a - glappets början (epok-ms)
 * @param {number} b - glappets slut (epok-ms)
 * @param {number} tickMs - tickavståndet (30 000 ms)
 * @param {number} fördröjningMs - mikrograce efter ticken (40 ms)
 * @returns {number|null} tickens tid
 */
function halvminutstickInne(a, b, tickMs, fördröjningMs) {
  if (!(b > a)) return null;
  const t = (Math.floor((a - fördröjningMs) / tickMs) + 1) * tickMs;
  return t < b ? t : null;
}

/**
 * Fasvariantens förskjutning δ i ms för ett M-FAS-fynd, 0 för andra fynd och
 * null när δ är tvetydigt. Ett M-FAS-fynds tider, rader och övergångar
 * ligger i basens tidsram (relations.comparePhase), men varianten kördes med
 * raderna δ förskjutna, så UI-klockan slog på variantens halvminuter.
 * @param {object} f - fyndet
 * @returns {number|null} δ i ms
 */
function fasförskjutningMs(f) {
  const u = (f && f.ursprung) || {};
  if (u.relation !== 'M-FAS') return 0;
  const d = Array.isArray(u.deltaS) && u.deltaS.length === 1 ? Number(u.deltaS[0]) : NaN;
  return Number.isFinite(d) ? Math.round(d * 1000) : null;
}

/**
 * halvminutstickInne i en fasvariants klocka: glappet (a, b) ligger i basens
 * tidsram, ticken räknas på variantens absoluta halvminuter (basens tid +
 * δ) och returneras i basens tidsram.
 * @param {number} a - glappets början (basens epok-ms)
 * @param {number} b - glappets slut (basens epok-ms)
 * @param {number} tickMs - tickavståndet
 * @param {number} fördröjningMs - mikrograce efter ticken
 * @param {number} fasMs - δ i ms (0 utanför M-FAS)
 * @returns {number|null} tickens tid i basens tidsram
 */
function halvminutstickFas(a, b, tickMs, fördröjningMs, fasMs) {
  const t = halvminutstickInne(a + fasMs, b + fasMs, tickMs, fördröjningMs);
  return t === null ? null : t - fasMs;
}

// En klausul med ETA för en målbro, i harnessens textformat (samma grammatik
// som INV-1 och INV-3 läser, invariants.js:58–106): 'strax' eller "om (cirka)
// N minuter". "ETA okänd" och väntklausuler bär ingen ETA och hoppas över,
// som i INV-3.
const ETA_KLAUSUL_RE = /på väg mot (Klaffbron|Stridsbergsbron), beräknad broöppning (?:(strax)|om (?:cirka )?(\d+) minuter)/;

/**
 * ETA-serien för en bro ur brotextövergångarna, som INV-3 bygger den
 * (invariants.js:273–284): en post per publicerad text med en ETA-klausul för
 * bron.
 * @param {object[]} övergångar - resultatets bridgeTextTransitions ({t, text})
 * @param {string} bro - målbron
 * @returns {{t: number, strax: boolean, eta: number}[]} serien i tidsordning
 */
function etaSerie(övergångar, bro) {
  const ut = [];
  for (const x of övergångar || []) {
    if (!x || !Number.isFinite(x.t) || typeof x.text !== 'string') continue;
    for (const klausul of x.text.split('; ')) {
      const m = ETA_KLAUSUL_RE.exec(klausul);
      if (m && m[1] === bro) ut.push({ t: x.t, strax: Boolean(m[2]), eta: m[2] ? 0.5 : Number(m[3]) });
    }
  }
  return ut;
}

/**
 * Samma episodnyckel för KIE-PER-KORPUS: samma klass, samma broar och samma
 * fartyg när undantaget namnger ett.
 */
function sammaEpisodnyckel(k, msg) {
  if (signature.classOf(k) !== signature.classOf(msg)) return false;
  if (signature.bridgesOf(k).join(',') !== signature.bridgesOf(msg).join(',')) return false;
  const km = signature.mmsisOf(k);
  return !km.length || km.join(',') === signature.mmsisOf(msg).join(',');
}

/**
 * Klasser vars ISO-tid är episodens SLUT, med markören för hur länge
 * episoden pågick dessförinnan: ETA-SÅGTAND UPP "på Ns" är tiden från förra
 * publiceringen till språnget (invariants.js:321) och ETA-OSCILLATION
 * "inom Ns" spannet X→Y→X′ (invariants.js:351). DEFAULT-FLASH:s ISO-tid är
 * i stället STARTEN av "Inga båtar" och "(Ns)" hur länge texten stod
 * (invariants.js:170–180, :438), så dess längd flyttar inte episodens tid.
 */
const SLUTTIDSKLASSER = Object.freeze({
  'ETA-SÅGTAND UPP': /\bpå (\d+(?:[.,]\d+)?)s\b/,
  'ETA-OSCILLATION': /\binom (\d+(?:[.,]\d+)?)s\b/,
});

/**
 * Episodens längd i ms ur ett invariantmeddelande, bara för klasser vars tid
 * är episodens slut (SLUTTIDSKLASSER); annars 0.
 * @param {string} msg - meddelandet
 * @returns {number} längden i ms
 */
function episodLängdMs(msg) {
  const re = SLUTTIDSKLASSER[signature.classOf(msg)];
  const m = re ? re.exec(String(msg || '')) : null;
  return m ? Number(m[1].replace(',', '.')) * 1000 : 0;
}

/**
 * Kurs och fart som appen ser dem. En rad utan finit cog eller sog får
 * fartygets senast kända värde: _createVesselObject sätter
 * `Number.isFinite(data.sog) ? data.sog : (oldVessel?.sog ?? data.sog)`, och
 * samma för cog (VesselDataService.js:5286–5287). Fix D-blockets yttre
 * villkor (:384–392) och S10-vaktens krav 3 (app.js:9745,
 * _fixDReversalContradictsNotification) prövar sedan vessel.cog och
 * vessel.sog, alltså det framförda värdet. Saknar alla tidigare rader ett
 * finit värde förblir det icke-finit, som i appen. Varje ny rad bär
 * `cogFrån` och `sogFrån`: tiden för raden som värdet fördes fram från, eller
 * null när raden har ett eget värde. Rader som redan bär fälten behåller dem,
 * så att en andra framföring inte tappar ursprunget. Framföringen antar, som
 * spelaFixD i övrigt, att fartyget inte tas bort och skapas om mellan raderna
 * (då är oldVessel null och inget förs fram).
 * Rättat 2026-11-04 (runda 3, L1): förut hoppade spelaFixD över raden och
 * zonkontrollerna dömde den som saknad kurs eller fart.
 * @param {object[]} fixar - fartygets fixar i tidsordning (aisTimestamp, cog, sog)
 * @returns {object[]} nya radobjekt med framförda cog och sog
 */
function medFramfördKursOchFart(fixar) {
  let cog = null;
  let cogT = null;
  let sog = null;
  let sogT = null;
  return fixar.map((r) => {
    const egenCog = Number.isFinite(r.cog);
    const egenSog = Number.isFinite(r.sog);
    const ut = { ...r };
    if (egenCog) {
      cog = r.cog;
      cogT = Number.isFinite(r.cogFrån) ? r.cogFrån : r.aisTimestamp;
      ut.cogFrån = Number.isFinite(r.cogFrån) ? r.cogFrån : null;
    } else {
      ut.cog = cog === null ? r.cog : cog;
      ut.cogFrån = cog === null ? null : cogT;
    }
    if (egenSog) {
      sog = r.sog;
      sogT = Number.isFinite(r.sogFrån) ? r.sogFrån : r.aisTimestamp;
      ut.sogFrån = Number.isFinite(r.sogFrån) ? r.sogFrån : null;
    } else {
      ut.sog = sog === null ? r.sog : sog;
      ut.sogFrån = sog === null ? null : sogT;
    }
    return ut;
  });
}

/**
 * Fix D:s pending-logik (VesselDataService.js:380–476) spelad över ett
 * fartygs fixar i tidsordning, för S10-predikatet. Harnessen stegar klockan
 * till varje rads aisTimestamp innan raden matas in (replayRunner.js:512–521),
 * så appens Date.now() är radens tid.
 *  - En rad utan finit kurs eller fart prövas med fartygets senast kända
 *    värde (medFramfördKursOchFart, VesselDataService.js:5286–5287). Saknas
 *    ett sådant värde, eller är sog < minSogKn, klarar fixen inte Fix
 *    D-blockets yttre villkor (:384–392) och rör varken flaggan eller låset.
 *    Rättat 2026-11-04 (runda 3, L1): förut hoppades varje rad utan finit
 *    kurs eller fart över, fast appen kör blocket på det framförda värdet
 *    (granskarens s10h i värld 581: en omvänd rad utan kurs på 2,2 kn
 *    10:03:51 sätter flaggan med kursen 216° från raden före, och appen
 *    notifierar 10:06:16).
 *  - En fix vars kurs är omvänd mot riktningslåset (lås norr: det breda
 *    sydbandet, lås söder: nordbandet; :395–407) sätter flaggan. Finns redan
 *    en flagga i samma riktning som är yngre än maxÅlderMs bekräftar fixen i
 *    stället reversalen (:446–470, _confirmDirectionReversal): låset byts och
 *    flaggan nollas.
 *  - En fix som inte är omvänd nollar flaggan (:473–476).
 * Spelet antar att blockets övriga villkor (målbro, inte nytt fartyg,
 * shouldRecalc) håller. En flagga eller bekräftelse som appen inte gjorde
 * ger då ett konservativt nej i predikatet. En nollning som appen inte
 * gjorde kan däremot dölja en flagga; det kräver att blocket inte körs på en
 * fix i det gamla bandet (till exempel utan målbro) men körs på zonens
 * första fix, och det har inte setts i sonderna.
 * @param {object[]} fixar - fartygets fixar i tidsordning (aisTimestamp, cog, sog)
 * @param {{lås: string, minSogKn: number, maxÅlderMs: number, band: Function}} o -
 *   lås är riktningslåset när spelet börjar ('norr' | 'söder'), band(cog) ger
 *   'norr', 'söder' eller null
 * @returns {{lås: string, flagga: ?{riktning: string, t: number}, bekräftad: ?{till: string, t: number, flaggad: number}}}
 *   tillståndet efter sista fixen; bekräftad är den senast bekräftade reversalen
 */
function spelaFixD(fixar, {
  lås, minSogKn, maxÅlderMs, band,
}) {
  let nu = lås;
  let flagga = null;
  let bekräftad = null;
  for (const r of medFramfördKursOchFart(fixar)) {
    if (!Number.isFinite(r.cog) || !Number.isFinite(r.sog) || r.sog < minSogKn) continue;
    const b = band(r.cog);
    const omvänd = nu === 'norr' ? b === 'söder' : b === 'norr';
    if (!omvänd) {
      flagga = null;
    } else if (flagga && flagga.riktning === b && r.aisTimestamp - flagga.t < maxÅlderMs) {
      bekräftad = { till: b, t: r.aisTimestamp, flaggad: flagga.t };
      nu = b;
      flagga = null;
    } else {
      flagga = { riktning: b, t: r.aisTimestamp };
    }
  }
  return { lås: nu, flagga, bekräftad };
}

// ---------------------------------------------------------------------------
// Predikaten: namn → {parametrar: {namn: standardvärde}, fn(fynd, kontext, p)}
// ---------------------------------------------------------------------------

const C = constants;
const PREDICATES = {
  alltid: {
    parametrar: {},
    fn: () => ok('klassRegex räcker'),
  },
  aldrig: {
    parametrar: {},
    fn: () => nej('omätbar i v1'),
  },

  sameVisit: {
    parametrar: { utfärdM: 350, fixar: 2, radieM: C.PROTECTION_ZONE_RADIUS },
    fn(f, ctx, p) {
      if (!f.mmsi || !f.bro) return nej('fyndet saknar mmsi eller bro');
      if (!Array.isArray(ctx.rader)) return nej('saknar rader');
      const w = visitWindow(f, ctx);
      if (w.fel) return nej(w.fel);
      const proof = exitProof(rowsOf(ctx, f.mmsi), f.bro, w.tA, w.tB, p.utfärdM, p.fixar);
      if (proof) return nej(`utfärd bevisad ${fmtT(proof.aisTimestamp)} (${p.fixar} fixar > ${p.utfärdM} m)`);
      const sedan = w.starttillstånd ? 'starttillståndet (besöket var öppet i state)' : fmtT(w.tA);
      return ok(`samma besök sedan ${sedan}: inga ${p.fixar} konsekutiva fixar > ${p.utfärdM} m från ${f.bro} (återkomstradie ${p.radieM} m)`);
    },
  },

  boxEdgeExit: {
    parametrar: {
      punkter: ['Kanalinfarten', 'Stallbackabron'], utfärdM: 350, fixar: 2, minGlappS: 600,
    },
    fn(f, ctx, p) {
      if (!p.punkter.includes(f.bro)) return nej(`${f.bro || 'bron'} är ingen ytterpunkt`);
      if (!Array.isArray(ctx.rader)) return nej('saknar rader');
      const w = visitWindow(f, ctx);
      if (w.fel) return nej(w.fel);
      const list = rowsOf(ctx, f.mmsi);
      if (exitProof(list, f.bro, w.tA, w.tB, p.utfärdM, p.fixar)) return nej('utfärden är bevisad med två fixar');
      const inside = list.filter((r) => r.aisTimestamp >= w.tA && r.aisTimestamp <= w.tB);
      let maxGap = 0;
      for (let i = 1; i < inside.length; i++) maxGap = Math.max(maxGap, inside[i].aisTimestamp - inside[i - 1].aisTimestamp);
      if (inside.length && w.tB - inside[inside.length - 1].aisTimestamp > maxGap) maxGap = w.tB - inside[inside.length - 1].aisTimestamp;
      if (maxGap < p.minGlappS * 1000) return nej(`inget glapp ≥ ${p.minGlappS} s — båten lämnade inte boxen`);
      return ok(`utfart vid ${f.bro} utan två fixar > ${p.utfärdM} m och glapp ${Math.round(maxGap / 1000)} s`);
    },
  },

  inferenceAge: {
    parametrar: { minÅlderMin: 17 },
    fn(f, ctx, p) {
      const tc = crossingTimeOf(f);
      if (!Number.isFinite(tc)) return nej('saknar korsningstid');
      const after = rowsOf(ctx, f.mmsi).find((r) => r.aisTimestamp > tc);
      if (!after) return nej('ingen fix efter korsningen');
      const ageMin = (after.aisTimestamp - tc) / MIN;
      if (ageMin > p.minÅlderMin) return ok(`slutsatsen ${ageMin.toFixed(1)} min gammal vid första fixen efter glappet`);
      return nej(`slutsatsen bara ${ageMin.toFixed(1)} min gammal`);
    },
  },

  dedup2h: {
    parametrar: { fönsterMin: 120 },
    fn(f, ctx, p) {
      if (!f.mmsi || !f.bro) return nej('fyndet saknar mmsi eller bro');
      const dir = (f.belägg && f.belägg.förväntadRiktning) || f.riktning;
      if (!dir) return nej('fyndet saknar riktning');
      const { t } = f;
      const hit = deliveredNotes(ctx, f.mmsi, f.bro).find((n) => n.direction === dir && n.t < t && t - n.t <= p.fönsterMin * MIN);
      return hit ? ok(`samma ${f.mmsi}:${f.bro} ${dir} notifierad ${fmtT(hit.t)} (< ${p.fönsterMin} min)`) : nej('ingen notis i samma riktning inom fönstret');
    },
  },

  fixBeyondLine: {
    parametrar: { maxM: C.UNDER_BRIDGE_CLEAR_DISTANCE },
    fn(f, ctx, p) {
      const b = f.belägg || {};
      if (Number.isFinite(b.bortomLinjenM)) {
        return b.bortomLinjenM <= p.maxM ? ok(`fix ${Math.round(b.bortomLinjenM)} m bortom linjen ≤ ${p.maxM} m`) : nej(`fix ${Math.round(b.bortomLinjenM)} m bortom linjen`);
      }
      const tc = crossingTimeOf(f);
      const sB = platser.stationS(f.bro);
      if (!Number.isFinite(tc) || sB === null) return nej('saknar korsningstid eller station');
      const until = Number.isFinite(f.t) && f.t > tc ? f.t : tc + 10 * MIN;
      const list = rowsOf(ctx, f.mmsi).filter((r) => r.aisTimestamp > tc && r.aisTimestamp <= until);
      if (!list.length) return nej('ingen fix efter korsningen');
      const before = rowsOf(ctx, f.mmsi).filter((r) => r.aisTimestamp <= tc).pop();
      const side = before ? Math.sign(platser.project(before).s - sB) : 0;
      const beyond = Math.max(...list.map((r) => {
        const d = platser.project(r).s - sB;
        return side === 0 ? Math.abs(d) : Math.max(0, -side * d);
      }));
      return beyond <= p.maxM ? ok(`längst ${Math.round(beyond)} m bortom linjen ≤ ${p.maxM} m`) : nej(`fix ${Math.round(beyond)} m bortom linjen`);
    },
  },

  noMovementProof: {
    parametrar: { minSogKn: C.QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN, föreMin: 10 },
    fn(f, ctx, p) {
      if (!f.mmsi || !Array.isArray(ctx.rader)) return nej('saknar mmsi eller rader');
      const b = f.belägg || {};
      const tIn = Number.isFinite(b.tIn) ? b.tIn : f.t;
      const tOut = Number.isFinite(b.tOut) ? b.tOut : f.t;
      if (!Number.isFinite(tIn)) return nej('fyndet saknar tid');
      const list = rowsOf(ctx, f.mmsi).filter((r) => r.aisTimestamp >= tIn - p.föreMin * MIN && r.aisTimestamp <= tOut);
      const moving = list.find((r) => Number.isFinite(r.sog) && r.sog >= p.minSogKn);
      return moving ? nej(`rörelsebevis ${fmtT(moving.aisTimestamp)} (${moving.sog} kn)`) : ok(`ingen fix ≥ ${p.minSogKn} kn i fönstret (${list.length} fixar)`);
    },
  },

  // De tre konvojpredikaten (U2-VS-DEADLINE, J13-J14-KONVOJSEMANTIK och
  // U2-RETURRESA) använder lib/konvoj.js, samma definitioner av "täckt av
  // händelsen", "händelsens första passage" och "returresa" som T2-oraklets
  // förklaringar. Rättat 2026-11-04 (M04, triagens T-2), se konvoj.js.
  crossingWithinEventWindow: {
    parametrar: { fönsterMs: C.BRIDGE_OPENING.CONVOY_WINDOW_MS },
    fn(f, ctx, p) {
      const tc = crossingTimeOf(f);
      if (!Number.isFinite(tc) || !f.bro || !f.mmsi) return nej('saknar korsningstid, bro eller mmsi');
      const d = convoyData(ctx, f.bro);
      if (!d.varningar.some((x) => x.t <= tc)) return nej('ingen levererad varning före korsningen');
      // Garantin förfaller bara medan båten är TÄCKT (etapp7-plan C-IV), och
      // båtens egen korsning — utresan före en U-sväng eller korsningen
      // själv — är aldrig händelsens första passage. Utan den vakten
      // förklarade posten bort konvojfönstrets bakkant och U-svängsreturer.
      const r = konvoj.inomHändelsefönster({ mmsi: f.mmsi, bro: f.bro, tc }, { ...d, fönsterMs: p.fönsterMs });
      if (r.sant) {
        return ok(`korsningen ${fmtT(tc)} ligger inom händelsens (${r.w.eventId || fmtT(r.w.t)}) första passage ${fmtT(r.first.t)} + ${p.fönsterMs / 1000} s, och båten var täckt av händelsen`);
      }
      if (!r.närmast) {
        return nej(r.otäckta
          ? 'båten var inte täckt av någon äldre händelse vid bron (medlem, ledare eller absorberad före korsningen)'
          : 'ingen äldre händelse med en annan båts första passage före korsningen');
      }
      const dt = Math.round((tc - r.närmast.first.t) / 1000);
      return nej(`korsningen ${fmtT(tc)} ligger ${dt} s efter händelsens (${r.närmast.w.eventId || fmtT(r.närmast.w.t)}) första passage ${fmtT(r.närmast.first.t)}, utanför +${p.fönsterMs / 1000} s`);
    },
  },

  nonMemberCrossingBetween: {
    parametrar: {},
    fn(f, ctx) {
      const tc = crossingTimeOf(f);
      if (!Number.isFinite(tc) || !f.bro || !f.mmsi) return nej('saknar korsningstid, bro eller mmsi');
      const d = convoyData(ctx, f.bro);
      if (!d.varningar.some((x) => x.t < tc)) return nej('ingen levererad varning före korsningen');
      const r = konvoj.ickeMedlemEmellan({ mmsi: f.mmsi, bro: f.bro, tc }, d);
      if (r.sant) return ok(`icke-medlemmen ${r.x.mmsi} korsade ${fmtT(r.x.t)} mellan varningen ${r.w.eventId || ''} (${fmtT(r.w.t)}) och passagen`);
      return nej('ingen båt utanför en händelse som täckte båten korsade emellan medan händelsen var öppen (ingen täckt båt passerade mer än 600 s före)');
    },
  },

  // Namnet är historiskt: returresan omfattar sedan 2026-11-04 (M04) både en
  // retur som absorberats i båtens egen äldre händelse och en retur i en
  // händelse där båten var medlem, och kräver att returen ligger inom
  // händelsens konvojfönster (konvoj.returresa).
  uturnReturnAbsorbed: {
    parametrar: { fönsterMs: C.BRIDGE_OPENING.CONVOY_WINDOW_MS },
    fn(f, ctx, p) {
      const tc = crossingTimeOf(f);
      if (!Number.isFinite(tc) || !f.bro || !f.mmsi) return nej('saknar korsningstid, bro eller mmsi');
      const d = convoyData(ctx, f.bro);
      const r = konvoj.returresa({ mmsi: f.mmsi, bro: f.bro, tc }, { ...d, fönsterMs: p.fönsterMs });
      if (r.sant) {
        return ok(`returen ${fmtT(tc)} hör till båtens egen äldre händelse ${r.w.eventId || fmtT(r.w.t)} (varning ${fmtT(r.w.t)}, `
          + `${r.hur} vid utresan ${fmtT(r.q.t)}) inom första passagen ${fmtT(r.first.t)} + ${p.fönsterMs / 1000} s`);
      }
      if (r.närmast) {
        const dt = Math.round((tc - r.närmast.first.t) / 1000);
        const händelse = r.närmast.w.eventId || fmtT(r.närmast.w.t);
        return nej(`returen ${fmtT(tc)} ligger ${dt} s efter den egna händelsens (${händelse}) första passage ${fmtT(r.närmast.first.t)}, utanför +${p.fönsterMs / 1000} s`);
      }
      return nej(r.skäl);
    },
  },

  holdPattern: {
    parametrar: { minVändningar: 2, minM: 150, fönsterMin: 60 },
    fn(f, ctx, p) {
      if (!f.mmsi || !Number.isFinite(f.t)) return nej('saknar mmsi eller tid');
      const series = sSeries(rowsOf(ctx, f.mmsi), f.t - p.fönsterMin * MIN, f.t + p.fönsterMin * MIN);
      const rev = reversals(series, p.minM);
      for (let i = 0; i + p.minVändningar - 1 < rev.length; i++) {
        if (rev[i + p.minVändningar - 1] - rev[i] <= p.fönsterMin * MIN) return ok(`${p.minVändningar} vändningar ≥ ${p.minM} m inom ${p.fönsterMin} min (${rev.map(fmtT).join(', ')})`);
      }
      return nej(`${rev.length} vändning(ar) ≥ ${p.minM} m kring ${fmtT(f.t)}`);
    },
  },

  // D4: unknown är aldrig en felaktig riktning. Predikatet gäller bara ett
  // riktningsbyte vars NYA riktning är unknown (belägg.nyRiktning, satt av
  // M-FAS-jämförelsen för NOTISRIKTNING BYTT och ÖPPNINGSRIKTNING BYTT).
  // Rättat 2026-11-04 (M05): förut föll predikatet tillbaka på fyndets
  // riktning, så en tappad, tillagd eller förskjuten notis med riktningen
  // unknown blev DESIGN, fast förlusten inte har med riktningen att göra.
  directionUnknown: {
    parametrar: {},
    fn(f) {
      const b = f.belägg || {};
      if (b.nyRiktning === undefined || b.nyRiktning === null) return nej('fyndet är inget riktningsbyte (belägg.nyRiktning saknas)');
      return b.nyRiktning === 'unknown' ? ok('den nya riktningen är unknown') : nej(`den nya riktningen är ${b.nyRiktning}`);
    },
  },

  leaderOnlyChange: {
    parametrar: { maxSpridningMs: 150, sökfönsterMin: 10 },
    fn(f, ctx, p) {
      const par = f.belägg && f.belägg.par;
      if (!par || !par.bas || !par.variant) return nej('inget parat kortbyte (tillagda eller tappade varningar omfattas inte)');
      if (par.bas.bridge !== par.variant.bridge) return nej('olika broar');
      const a = String(par.bas.leadMmsi || '');
      const b = String(par.variant.leadMmsi || '');
      if (!a || !b || a === b) return nej('samma ledare — inget ledarval');
      if (!Array.isArray(ctx.rader)) return nej('saknar rader');
      const t1 = Math.max(par.bas.t || 0, par.variant.t || 0);
      const t0 = t1 - p.sökfönsterMin * MIN;
      const pick = (m) => rowsOf(ctx, m).filter((r) => r.feed === 'aishub' && r.aisTimestamp >= t0 && r.aisTimestamp <= t1);
      const ra = pick(a);
      const rb = pick(b);
      for (const x of ra) {
        const y = rb.find((r) => Math.abs(r.aisTimestamp - x.aisTimestamp) <= p.maxSpridningMs);
        if (y) return ok(`ledarna ${a} och ${b} i samma AISHub-pollkluster (${Math.abs(y.aisTimestamp - x.aisTimestamp)} ms)`);
      }
      return nej(`ledarna ${a} och ${b} delar inget AISHub-pollkluster ≤ ${p.maxSpridningMs} ms`);
    },
  },

  // KIE-PER-KORPUS. Korpusens rådataverifierade undantag gäller fas- och
  // mutantvarianter av SAMMA episod. Episoden identifieras av klassen,
  // broarna, fartyget när undantaget namnger ett, och tiden: utslagets
  // ISO-tid ska ligga högst |δ| + L + en tick från undantagets, där |δ| är
  // fyndets största fasförskjutning och L UNDANTAGETS längd för klasser vars
  // tid är episodens slut (ETA-SÅGTAND "på Ns", ETA-OSCILLATION "inom Ns";
  // SLUTTIDSKLASSER), annars 0. En tick är UI-klockans halvminut:
  // 42h-flashen börjar i varianterna med δ −7, −11,52 och −20 s en tick före
  // undantaget (30 s isär), och med δ +7 och +15 s på samma tid.
  // Ett undantag förklarar dessutom högst EN träff per variant, den närmaste:
  // har varianten ett annat utslag av samma episodnyckel närmare undantaget
  // (belägg.syskon, relations.comparePhase) är det här en annan episod.
  // Rättat 2026-11-04 i tre steg. M03: förut saknades tidsvillkoret, och
  // eftersom inget av bankens tre undantag namnger ett fartyg amnestierades
  // varje ny episod av samma klass vid samma bro. Efterrättning D: toleransen
  // |δ| + 5 min godtog en separat flash upp till 5 min efter den kända, och
  // ett undantag kunde amnestiera hur många träffar som helst i en variant.
  // Runda 2 (E3): L var den längre av undantagets och UTSLAGETS längd, även
  // för DEFAULT-FLASH, vars tid är episodens start. En separat lång flash
  // vidgade då sitt eget fönster och godtogs upp till |δ| + 330 s efter den
  // kända (granskarens kiewindow2). Nu ger utslaget aldrig sitt eget fönster,
  // och DEFAULT-FLASH jämförs start mot start: |δ| + en tick.
  // På den låsta banken (relation BAS) gäller runAllCorpora:s exakta
  // prefixmatch (runAllCorpora.js:252–262) och ingen registeramnesti: där
  // är en ny episod den starkaste regressionssignalen.
  kiePrefix: {
    parametrar: { tickS: 30 },
    fn(f, ctx, p) {
      const list = (ctx.korpus && Array.isArray(ctx.korpus.knownInvariantExceptions)) ? ctx.korpus.knownInvariantExceptions : [];
      if (!list.length) return nej('korpusen saknar knownInvariantExceptions');
      const msgs = [f.detalj, ...((f.belägg && f.belägg.meddelanden) || [])].filter(Boolean).map(String);
      const u = f.ursprung || {};
      if (u.relation === 'BAS') {
        const exakt = list.find((k) => msgs.some((m) => m.startsWith(k)));
        if (exakt) return ok(`exakt prefixmatch mot korpusens undantag "${exakt.slice(0, 60)}…" (runAllCorpora FP9)`);
        return nej('låst bank: bara runAllCorpora:s exakta prefixmatch gäller, ingen registeramnesti för en ny episod');
      }
      const maxDeltaMs = Math.max(0, ...(u.deltaS || []).map((d) => Math.abs(Number(d)) * 1000).filter(Number.isFinite));
      const syskon = Array.isArray(f.belägg && f.belägg.syskon) ? f.belägg.syskon.map(String) : null;
      const sek = (ms) => String(Math.round(ms / 100) / 10).replace('.', ',');
      let utanför = null;
      let närmare = null;
      for (const msg of msgs) {
        for (const k of list) {
          if (!sammaEpisodnyckel(k, msg)) continue;
          const km = signature.mmsisOf(k);
          const tk = signature.timeOf(k);
          if (!Number.isFinite(tk)) {
            // Utan tid identifierar bara fartyget episoden.
            if (km.length) return ok(`prefix ${signature.classOf(k)} + samma fartyg och bro som korpusens undantag "${k.slice(0, 60)}…"`);
            continue;
          }
          const tm = signature.timeOf(msg);
          if (!Number.isFinite(tm)) continue;
          // Bara undantagets egen längd, och bara när tiden är episodens slut.
          const längdMs = episodLängdMs(k);
          const fönsterMs = maxDeltaMs + längdMs + p.tickS * 1000;
          const fönsterText = `|δ| ${sek(maxDeltaMs)} s${längdMs ? ` + undantagets längd ${sek(längdMs)} s` : ''} + en tick ${p.tickS} s`;
          const dt = Math.abs(tm - tk);
          if (dt > fönsterMs) {
            if (!utanför || dt < utanför.dt) utanför = { k, dt, fönsterText };
            continue;
          }
          // En till en: ett närmare syskon av samma episod tar undantaget.
          const konkurrent = (syskon || [])
            .filter((s) => s !== msg && sammaEpisodnyckel(k, s) && Number.isFinite(signature.timeOf(s)))
            .map((s) => ({ s, d: Math.abs(signature.timeOf(s) - tk) }))
            .find((x) => x.d < dt || (x.d === dt && x.s < msg));
          if (konkurrent) {
            if (!närmare) närmare = { k, dt, ...konkurrent };
            continue;
          }
          const vad = `${signature.classOf(k)} vid samma bro${km.length ? ' och fartyg' : ''}`;
          return ok(`samma episod som korpusens undantag "${k.slice(0, 60)}…": ${vad}, ${Math.round(dt / 1000)} s isär (≤ ${fönsterText})`);
        }
      }
      if (närmare) {
        return nej(`undantaget "${närmare.k.slice(0, 60)}…" förklarar variantens närmare utslag "${närmare.s.slice(0, 60)}…" `
          + `(${Math.round(närmare.d / 1000)} s från undantaget mot ${Math.round(närmare.dt / 1000)} s; ett undantag förklarar högst en träff per variant)`);
      }
      if (utanför) {
        const isär = utanför.dt < 2 * 3600000 ? `${Math.round(utanför.dt / 1000)} s` : `${String(Math.round(utanför.dt / 360000) / 10).replace('.', ',')} h`;
        return nej(`samma klass och bro som undantaget "${utanför.k.slice(0, 60)}…" men ${isär} isär, utanför ${utanför.fönsterText} (en annan episod)`);
      }
      return nej('inget undantag med samma prefix, fartyg och bro');
    },
  },

  restartWithin: {
    parametrar: { föreMin: 10, efterMin: 0 },
    fn(f, ctx, p) {
      if (!Number.isFinite(f.t)) return nej('fyndet saknar tid');
      const r = restartsOf(ctx).find((x) => x >= f.t - p.föreMin * MIN && x <= f.t + p.efterMin * MIN);
      return r ? ok(`ctrl:restart ${fmtT(r)}`) : nej(`ingen omstart i [−${p.föreMin}; +${p.efterMin}] min`);
    },
  },

  defaultUntilFirstFixAfterRestart: {
    parametrar: { maxS: 60 },
    fn(f, ctx, p) {
      if (!Number.isFinite(f.t)) return nej('fyndet saknar tid');
      const r = restartsOf(ctx).filter((x) => x <= f.t + 1000).pop();
      if (r === undefined) return nej('ingen omstart före utslaget');
      const firstFix = ((ctx.rader || []).filter((x) => !x.ctrl && x.aisTimestamp >= r).sort((a, b) => a.aisTimestamp - b.aisTimestamp)[0]);
      if (!firstFix) return nej('ingen fix efter omstarten');
      if (f.t > firstFix.aisTimestamp) return nej('DEFAULT började efter första fixen');
      const trans = (ctx.resultat && ctx.resultat.bridgeTextTransitions) || [];
      const next = trans.find((x) => x.t > f.t);
      const end = next ? next.t : Infinity;
      if (end <= firstFix.aisTimestamp + p.maxS * 1000) return ok(`DEFAULT från omstarten ${fmtT(r)} till ${fmtT(end)} (≤ ${p.maxS} s efter första fixen ${fmtT(firstFix.aisTimestamp)})`);
      return nej(`DEFAULT varade till ${fmtT(end)}, mer än ${p.maxS} s efter första fixen`);
    },
  },

  mooringCapsuleStationary: {
    parametrar: { minStillaMin: 3, minAvståndM: C.BRIDGE_OPENING.DISARM_MOORED_MIN_DISTANCE_M, stillaSogKn: C.MOORING_DETECTION.STATIONARY_SOG_KN },
    fn(f, ctx, p) {
      if (!Number.isFinite(f.t) || !f.bro || !Array.isArray(ctx.rader)) return nej('saknar tid, bro eller rader');
      const per = ctx.__perMmsi || platser.rowsByMmsi(ctx.rader);
      for (const [mmsi, list] of per) {
        const before = list.filter((r) => r.aisTimestamp <= f.t);
        if (!before.length) continue;
        const last = before[before.length - 1];
        const zone = platser.capsuleOf(last);
        if (!zone) continue;
        const still = (r) => !Number.isFinite(r.sog) || r.sog < p.stillaSogKn;
        let k = before.length - 1;
        while (k > 0 && platser.capsuleOf(before[k - 1]) === zone && still(before[k - 1])) k--;
        if (!still(last)) continue;
        const stillMs = f.t - before[k].aisTimestamp;
        const dist = platser.capsuleDistanceToPoint(zone, f.bro);
        if (stillMs >= p.minStillaMin * MIN && dist > p.minAvståndM) {
          return ok(`${mmsi} stilla ${Math.round(stillMs / 1000)} s i "${zone.name}", ${Math.round(dist)} m från ${f.bro}`);
        }
      }
      return nej(`ingen båt stilla ≥ ${p.minStillaMin} min i en kajkapsel > ${p.minAvståndM} m från ${f.bro}`);
    },
  },

  profileIs: {
    parametrar: { profiler: [] },
    fn(f, ctx, p) {
      const have = [ctx.radio, ctx.profil, f.nivå].filter(Boolean);
      const hit = have.find((x) => p.profiler.includes(x));
      return hit ? ok(`profilen är ${hit}`) : nej(`profilen är ${have.join('/') || 'okänd'}`);
    },
  },

  stderrSignature: {
    parametrar: { regex: '' },
    fn(f, ctx, p) {
      const re = new RegExp(p.regex);
      const sig = (f.belägg && f.belägg.signatur) || f.klass;
      return re.test(sig) ? ok(`signaturen matchar /${p.regex}/`) : nej(`signaturen matchar inte /${p.regex}/`);
    },
  },

  lateralOffset: {
    parametrar: { minM: 250, fönsterMin: 30 },
    fn(f, ctx, p) {
      if (!f.mmsi || !Array.isArray(ctx.rader)) return nej('saknar mmsi eller rader');
      const list = rowsOf(ctx, f.mmsi).filter((r) => !Number.isFinite(f.t) || Math.abs(r.aisTimestamp - f.t) <= p.fönsterMin * MIN);
      const far = list.map((r) => ({ r, off: platser.project(r).offsetM })).sort((a, b) => b.off - a.off)[0];
      if (far && far.off > p.minM) return ok(`fix ${Math.round(far.off)} m från farleden ${fmtT(far.r.aisTimestamp)}`);
      return nej(`ingen fix > ${p.minM} m från farleden`);
    },
  },

  stressDensity: {
    parametrar: { kedja: 6, glappMin: 10, maxSamtidiga: 9 },
    fn(f, ctx, p) {
      if (ctx.täthet && typeof ctx.täthet.stress === 'boolean') return ctx.täthet.stress ? ok('världen är uppmätt stress') : nej('världen är uppmätt realistisk');
      const cross = truthCrossings(ctx).length ? truthCrossings(ctx) : pointCrossings(ctx);
      if (!cross.length) return nej('saknar korsningar');
      const groups = new Map();
      for (const c of cross) {
        const k = `${c.bridge}|${c.dir || c.direction || ''}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c.t);
      }
      for (const [k, ts] of groups) {
        let run = 1;
        for (let i = 1; i < ts.length; i++) {
          run = ts[i] - ts[i - 1] <= p.glappMin * MIN ? run + 1 : 1;
          if (run >= p.kedja) return ok(`kedja med ${run} korsningar (${k}) med ≤ ${p.glappMin} min mellanrum`);
        }
      }
      const peak = ctx.täthet && Number.isFinite(ctx.täthet.maxSamtidiga) ? ctx.täthet.maxSamtidiga : null;
      if (peak !== null && peak > p.maxSamtidiga) return ok(`${peak} samtidigt rörliga båtar`);
      return nej('tätheten ligger inom fältets fördelning');
    },
  },

  passedForm: {
    parametrar: {},
    fn(f) {
      const n = (f.belägg && f.belägg.notis) || null;
      if (!n) return nej('fyndet saknar notis i belägg');
      return n.alreadyPassed === true && n.eta === -1 ? ok('passerad form (already_passed, eta −1)') : nej('förvarningsform');
    },
  },

  l0Interruption: {
    parametrar: { minStoppMin: 10, horisontMin: 120 },
    fn(f, ctx, p) {
      const s = ctx.sanning;
      if (!s) return nej('saknar L0');
      const w = (f.belägg && f.belägg.varning) || {};
      const members = (w.mmsis && w.mmsis.length ? w.mmsis : [w.leadMmsi || f.mmsi]).filter(Boolean).map(String);
      const t0 = Number.isFinite(w.t) ? w.t : f.t;
      const t1 = t0 + p.horisontMin * MIN;
      const u = (s.uturns || []).find((x) => members.includes(String(x.mmsi)) && x.t >= t0 && x.t <= t1);
      if (u) return ok(`L0: U-sväng ${fmtT(u.t)}`);
      const st = (s.stops || []).find((x) => members.includes(String(x.mmsi)) && x.tIn >= t0 && x.tIn <= t1 && (x.tOut - x.tIn) >= p.minStoppMin * MIN);
      if (st) return ok(`L0: stopp ${Math.round((st.tOut - st.tIn) / MIN)} min från ${fmtT(st.tIn)}`);
      return nej('L0 visar inget avbrott');
    },
  },

  effectiveSpeedBelow: {
    parametrar: { maxKn: C.BRIDGE_OPENING.DEADLINE_MAX_SPEED_KN },
    fn(f, ctx, p) {
      const v = f.belägg && f.belägg.veffKn;
      if (!Number.isFinite(v)) return nej('saknar effektiv fart');
      return v < p.maxKn ? ok(`veff ${v.toFixed(2)} kn < ${p.maxKn} kn`) : nej(`veff ${v.toFixed(2)} kn ≥ ${p.maxKn} kn`);
    },
  },

  stillNearBridge: {
    parametrar: { minM: C.STATUS_HYSTERESIS.WAITING_SET_DISTANCE, maxM: C.STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE, maxSogKn: 0.5 },
    fn(f, ctx, p) {
      if (!f.mmsi || !f.bro || !Number.isFinite(f.t)) return nej('saknar mmsi, bro eller tid');
      const last = rowsOf(ctx, f.mmsi).filter((r) => r.aisTimestamp <= f.t).pop();
      if (!last) return nej('ingen fix före utslaget');
      const d = platser.distanceToPoint(last, f.bro);
      const still = !Number.isFinite(last.sog) || last.sog <= p.maxSogKn;
      if (still && d >= p.minM && d <= p.maxM) return ok(`stilla ${Math.round(d)} m före ${f.bro}`);
      return nej(`${Math.round(d)} m från ${f.bro}, sog ${last.sog}`);
    },
  },

  // Missklassningen (runOpeningGates.classifyMiss på världens egna rader) är
  // en accepterad informationsförlust: antingen bär klassen namnet, eller så
  // har oraklet prövat båtens varningsbarhet och fått en accepterad klass
  // (T2 LEDTID<60s, T3 VARNING-EFTER-SANN-PASSAGE).
  missklassAccepterad: {
    parametrar: { klasser: ['TYST_I_HORISONTEN', 'FÖRST_SEDD_FÖR_NÄRA', 'SNABBARE_ÄN_DEADLINE_TAKET', 'RÖRELSEBEVIS_FÖR_SENT', 'RIKTNINGSBEVIS_FÖR_SENT'] },
    fn(f, ctx, p) {
      const named = p.klasser.find((k) => String(f.klass).includes(k));
      if (named) return ok(`missklassen ${named} är accepterad`);
      const b = f.belägg || {};
      const prov = [b.varningsbarhet, b.missklass].find((k) => p.klasser.includes(k));
      if (prov) return ok(`båten var inte varningsbar: ${prov} (classifyMiss på världens rader)`);
      return nej(`varningsbarheten är ${b.varningsbarhet || b.missklass || 'okänd'} — ingen accepterad missklass`);
    },
  },

  // FP8-sydgrinden vid Kanalinfarten: sydgående kräver kanalrelevans, dvs.
  // en passerad bro eller episodstart norr om punkten med marginalen
  // TRIGGER_POINT_SIDE_MARGIN_DEG (app.js, 0,0009° ≈ 100 m).
  sydgrindUtanKanalrelevans: {
    parametrar: {
      punkt: 'Kanalinfarten', marginalDeg: 0.0009, cogFrån: 135, cogTill: 225, radieM: C.PROTECTION_ZONE_RADIUS,
    },
    fn(f, ctx, p) {
      if (f.bro !== p.punkt) return nej(`${f.bro || 'punkten'} är inte ${p.punkt}`);
      if (!f.mmsi || !Array.isArray(ctx.rader)) return nej('saknar mmsi eller rader');
      const list = rowsOf(ctx, f.mmsi);
      if (!list.length) return nej('inga fixar för båten');
      const b = f.belägg || {};
      const tFirst = Number.isFinite(b.tFörstaFix) ? b.tFörstaFix : f.t;
      if (!Number.isFinite(tFirst)) return nej('fyndet saknar tid');
      const tIn = Number.isFinite(b.tIn) ? b.tIn : tFirst;
      const tOut = Number.isFinite(b.tOut) ? b.tOut : tFirst;
      const inside = list.filter((r) => r.aisTimestamp >= tIn - 2 * MIN && r.aisTimestamp <= tOut + 2 * MIN
        && platser.distanceToPoint(r, p.punkt) <= p.radieM);
      const southCog = (c) => Number.isFinite(c) && c >= p.cogFrån && c <= p.cogTill;
      const withCog = inside.filter((r) => Number.isFinite(r.cog));
      const south = f.riktning === 'southbound' || (withCog.length > 0 && withCog.every((r) => southCog(r.cog)));
      if (!south) return nej('besöket är inte sydgående');
      const passedBefore = [
        ...pointCrossings(ctx).filter((g) => String(g.mmsi) === String(f.mmsi)),
        ...((ctx.gt || []).filter((g) => g && g.inferred === true && String(g.mmsi) === String(f.mmsi))),
        ...(((ctx.resultat && ctx.resultat.targetPassages) || []).filter((x) => String(x.mmsi) === String(f.mmsi))),
        ...(((ctx.resultat && ctx.resultat.intermediatePassages) || []).filter((x) => String(x.mmsi) === String(f.mmsi))),
      ].find((x) => Number.isFinite(x.t) && x.t < tFirst);
      if (passedBefore) return nej(`båten passerade ${passedBefore.bridge} ${fmtT(passedBefore.t)} före besöket (kanalrelevans)`);
      const point = platser.POINTS[p.punkt];
      if (list[0].lat > point.lat + p.marginalDeg) return nej('episoden började norr om punkten (kanalrelevans)');
      return ok(`sydgående vid ${p.punkt} utan passerad bro och med episodstart ${fmtT(list[0].aisTimestamp)} inte norr om punkten`);
    },
  },

  // MÄTGRÄNS-INV10-VÄNTKEDJA (triagens T-1, F18). INV-10 godtar bara ETT
  // bekräftat väntintervall som täcker fram till nästa övergång
  // (invariants.js:476–503). Harnessen bryter intervallet när nästa
  // textgenerering kommer efter `until` (replayRunner.js:291–306), det vill
  // säga vid ett fixglapp, och halvminutstickens text byts upp till en tick
  // efter sista `until`. Predikatet godtar en KEDJA av intervall för bron
  // med högst maxGlappS mellan angränsande intervall, som börjar senast
  // startMin efter strax-övergången (INV-10:s eget villkor) och slutar högst
  // maxSvansS före nästa övergång. Underlaget är belägg.väntan (existing.js).
  //
  // Inget glapp i kedjan får innehålla en halvminutstick. UI-klockan slår på
  // absoluta halvminuter (app.js:13089–13096, `30000 − (Date.now() % 30000)`)
  // och tickens text genereras inom mikrograce, högst 40 ms senare
  // (app.js:5513–5520). Vid en tick inne i glappet är positionen inte färsk,
  // så 'strax' spärras av hasFreshPosition (BridgeTextService.js:304–308) och
  // en korrekt app byter text där. Står 'strax' kvar över en sådan tick är
  // det just det INV-10 vaktar, inte en mätgräns. Svansen efter kedjans sista intervall
  // (högst maxSvansS, den första ticken efter `until`) behålls. Rättat
  // 2026-11-04 (runda 2, E2): förut godtogs varje glapp ≤ 30 s, även ett
  // över ticken 09:00:00 (granskarens inv10tick-b: 'högst 25 s').
  chainedConfirmedWait: {
    parametrar: {
      maxGlappS: 30, maxSvansS: 30, startMin: 10, tickS: 30, tickFördröjningMs: 40,
    },
    fn(f, ctx, p) {
      const v = f.belägg && f.belägg.väntan;
      if (!v || !Number.isFinite(v.från) || !Number.isFinite(v.till) || !Array.isArray(v.intervall)) return nej('fyndet saknar väntintervallen (belägg.väntan)');
      const list = v.intervall.filter((x) => x && Number.isFinite(x.från) && Number.isFinite(x.till))
        .sort((a, b) => (a.från - b.från) || (a.till - b.till));
      const start = list.findIndex((x) => x.från <= v.från + p.startMin * MIN && x.till >= v.från);
      if (start < 0) return nej(`inget bekräftat väntintervall vid ${v.bro} börjar senast ${p.startMin} min efter strax-övergången ${fmtT(v.från)}`);
      let slut = list[start].till;
      let störstGlapp = 0;
      for (let i = start + 1; i < list.length && slut < v.till; i++) {
        // Ett intervall som börjar vid eller efter övergången är ingen länk:
        // där avgör svansen.
        if (list[i].från >= v.till) break;
        const glapp = list[i].från - slut;
        if (glapp > p.maxGlappS * 1000) break;
        const tick = halvminutstickInne(slut, list[i].från, p.tickS * 1000, p.tickFördröjningMs);
        if (tick !== null) {
          return nej(`glappet ${fmtT(slut)}–${fmtT(list[i].från)} mellan de bekräftade intervallen vid ${v.bro} innehåller halvminutsticken `
            + `${fmtT(tick)}, där en korrekt app byter text ('strax' kräver färsk position)`);
        }
        störstGlapp = Math.max(störstGlapp, glapp);
        slut = Math.max(slut, list[i].till);
      }
      const svans = v.till - slut;
      if (svans <= p.maxSvansS * 1000) {
        return ok(`bekräftad väntan vid ${v.bro} ${fmtT(list[start].från)}–${fmtT(slut)} med högst ${Math.round(störstGlapp / 1000)} s mellan intervallen `
          + `(ingen halvminutstick i glappen) och ${Math.max(0, Math.round(svans / 1000))} s före övergången ${fmtT(v.till)} (högst en tick)`);
      }
      return nej(`den bekräftade väntan vid ${v.bro} slutar ${fmtT(slut)}, ${Math.round(svans / 1000)} s före övergången ${fmtT(v.till)} `
        + `(svans högst ${p.maxSvansS} s; ett glapp över ${p.maxGlappS} s bryter kedjan)`);
    },
  },

  // U16-F40-STRAX-STUDS (användarbeslut U16 2026-11-04, F18/F19 i
  // s1-standard-a). Appen visar aldrig 'strax' på en position som är äldre
  // än STALE_ETA_HARD (600 s): imminent-grinden kräver
  // dataIsFreshEnough (app.js:7107–7113, "F40 medvetet EJ ändrat"; U1/C11).
  // När en köande båts enda 'strax'-bärande fix blir för gammal lånar
  // klausulen nästa båts ETA, och 'strax' kommer tillbaka med båtens nästa
  // fix. INV-3:s studsdiskriminator (invariants.js:302–319) tolkar studsen
  // som falsk degradering. Ägaren valde att behålla beteendet (U16).
  //
  // Klassen är MÄTGRÄNS (efterrättning R3c, BUGGJAKT §7 rad 21): hoppet vid
  // båtens nästa rad är en uppskjuten svans i harnessen. Harnessen kör
  // appens asynkrona UI-arbete först vid sin nästa dränering, en enda
  // verklig setImmediate efter varje clock.tick (replayRunner.js:86–88 och
  // 512–521). I värld 1608 räknade UI-cykeln från halvminuten 09:42:00 först
  // vid dräneringen 09:42:09,998 (ålder 599,7 s, IMMINENT_SET), och dess
  // omkörning (setImmediate, app.js:6857–6862) kördes först vid dräneringen
  // före MASEN 2:s rad 09:42:15,101 ("AIS too old (605s > 600s)"). I fält
  // hade omkörningen gått vid halvminuten med åldern cirka 590 s, och nästa
  // cykel 09:42:30 hade kommit efter hennes färska rad. Åldern 604,8 s är
  // harnessens tid.
  //
  // Predikatet är medvetet smalt och bundet till den båt som kan ha burit
  // 'strax'. Det godtar bara studsen vid båtens nästa rad. När klockan når
  // raden dränerar harnessen väntande UI-arbete före sampelbearbetningen
  // (replayRunner.js:512–521), och texten som publiceras där bygger på läget
  // före raden: hoppet (i fullvärlden 1608 IMMINENT_SKIP "AIS too old (605s
  // > 600s)"). Texten efter sampelbearbetningen bär 'strax' igen:
  // återgången. Radernas bearbetningstider ger harnessTider. Kraven:
  //  1. nivån före hoppet och återgången är 'strax' i brons ETA-serie
  //     (etaSerie, som INV-3 bygger den); för ETA-OSCILLATION är utslagets
  //     tid återgången, för ETA-SÅGTAND UPP hoppet;
  //  2. hoppet publicerades exakt när harnessen bearbetade en båts rad,
  //     högst fönsterMs efter radens tid; bara den båten kan förklara hoppet
  //     med sin ålder;
  //  3. båtens föregående fix bearbetades mer än minÅlderS före hoppet: appens
  //     ålder (Date.now() − vessel.timestamp, VesselDataService.js:5291) mot
  //     STALE_ETA_HARD, med samma jämförelse som dataIsFreshEnough;
  //  4. båda fixarna ligger inom radieM från bron (imminent-hysteresens yttre
  //     gräns, app.js:7210–7212, WAITING_CLEAR_DISTANCE);
  //  5. ingen belagd textgenerering mellan att åldern passerade minÅlderS
  //     och hoppet: ingen publicerad brotext och ingen halvminutstick (i
  //     variantens fas för M-FAS, med textens mikrograce; vakthunden kör en
  //     UI-cykel vid varje halvminut när det finns båtar). Bar båten 'strax'
  //     ensam, hade appen tappat det redan där. En annan båts rad däremot
  //     genererar text bara när uppdateringen är betydande
  //     (_updateUIIfNeeded), så den räknas inte: i ett AISHub-kluster
  //     bearbetas ofta andra rader strax före båtens;
  //  6. ingen av fixarna ligger i en kajkapsel (MOORING_ZONES). En förtöjd
  //     båt sänder glest, och hennes rad kan sammanfalla med en studs med en
  //     annan orsak. Appen kan räkna en stillaliggare vid kajen norr om
  //     Klaffbron som köare i upp till 15 min (queueGraceMs), så en äkta
  //     studs med bäraren där blir KANDIDAT;
  //  7. återgången kom efter radens bearbetning och högst fönsterMs efter
  //     radens tid, och ingen annan båts rad inom straxRadieM från bron
  //     bearbetades emellan: den hade kunnat bära 'strax' tillbaka. 500 m är
  //     den vidaste radie där appen sätter 'strax' (den uttömda grenen,
  //     app.js:7239). Fönstret räknas från radens tid, inte från
  //     bearbetningen, så att posten aldrig blir bredare än i rundans första
  //     försök;
  //  8. ingen styrrad (avbrott, återanslutning, omstart) bearbetades mellan
  //     båtens förra fix och återgången;
  //  9. båten kunde bära 'strax' vid sin förra fix: fixen ligger inom
  //     imminentRadieM (imminent SET, app.js:7210–7212), eller inom radieM
  //     efter en tidigare fix inom väntRadieM (väntläget, WAITING_SET, som
  //     ger gränsen 350 m) utan att båten lämnat radieM emellan;
  // 10. ingen annan båt kunde bära 'strax' vid hoppet: ingen annan båt har
  //     sin senaste fix före hoppet inom straxRadieM, högst minÅlderS gammal
  //     (appens klocka), utanför kajkapslarna och på väg mot bron (kursen
  //     inom ±90° från bäringen till bron, eller saknad kurs inom radieM).
  //     Den uttömda grenen sätter 'strax' inom 500 m (app.js:7239).
  // Rättat 2026-11-05 (efterrättning R3c, granskarens slutvarv): förut tog
  // posten radens båt som bärare utan krav 9 och 10. En B4-studs (ULLA:s
  // uttömda 'strax' 452 m från Klaffbron, 90 s-taket) med en annan båt Y,
  // tyst i 605 s på 320 m och aldrig 'strax' i appen, blev då DESIGN, medan
  // samma körning med Y tyst i 590 s (bitlik apputdata) blev KANDIDAT
  // (granskarens ce-b och ce-b590).
  // I minsta repro för F18 kom återgången 25 ms efter raden. I fullvärlden
  // 1608 kom den 246 ms efter, när tre AISHub-rader 66–109 ms senare, alla
  // mer än 1 km från bron, hade bearbetats. Rättat 2026-11-04 (efterrättning
  // R3b, granskarens varv r3): förut räckte vilken båt som helst inom 350 m
  // med en fix äldre än 600 s, räknad på radtider, och en rad högst 1 s från
  // hoppet. En förtöjd båt vid kajen norr om Klaffbron, tyst i 605 eller
  // 720 s och med en rad 35 ms före ULLA:s, gjorde då B4-studsen i F21:s
  // minsta repro till DESIGN (granskarens u16e2e), och ett hopp 0,8 s efter
  // båtens färska rad godtogs. Tick-varianten, ETA-hoppet vid 600 s utan
  // 'strax' och B4:s 90 s-tak på uttömt 'strax' (app.js:257; positionen är
  // då yngre än 600 s) omfattas inte (BUGGJAKT §7 och §16). På den låsta
  // banken gäller ingen registeramnesti.
  f40StudsVidNästaFix: {
    parametrar: {
      minÅlderS: C.UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS / 1000,
      fönsterMs: 1000,
      radieM: C.STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE,
      imminentRadieM: 300,
      väntRadieM: C.STATUS_HYSTERESIS.WAITING_SET_DISTANCE,
      straxRadieM: 500,
      tickS: 30,
      tickFördröjningMs: 40,
    },
    fn(f, ctx, p) {
      if ((f.ursprung || {}).relation === 'BAS') return nej('låst bank: bara runAllCorpora:s exakta prefixmatch gäller, ingen registeramnesti');
      if (!f.bro || !Number.isFinite(f.t)) return nej('fyndet saknar bro eller tid');
      const övergångar = ctx && ctx.resultat && ctx.resultat.bridgeTextTransitions;
      if (!Array.isArray(övergångar) || !övergångar.length) return nej('saknar brotextövergångarna');
      if (!Array.isArray(ctx.rader)) return nej('saknar rader');
      const fas = fasförskjutningMs(f);
      if (fas === null) return nej('fasvariantens δ är tvetydigt');
      const fmtMs = (t) => new Date(Math.round(t)).toISOString().slice(11, 23);
      const s1 = (ms) => (ms / 1000).toFixed(1);
      const tid = (ms) => (Math.abs(ms) < 1000 ? `${Math.round(ms)} ms` : `${s1(ms)} s`);
      const nivå = (x) => (x.strax ? 'strax' : `${x.eta} min`);
      const serie = etaSerie(övergångar, f.bro);
      const vid = serie.filter((x) => x.t === f.t);
      if (vid.length !== 1) {
        return nej(vid.length ? `${vid.length} ETA-klausuler för ${f.bro} vid ${fmtMs(f.t)}; utslagets övergång är tvetydig`
          : `utslagets övergång ${fmtMs(f.t)} finns inte i ETA-serien för ${f.bro}`);
      }
      const k = serie.indexOf(vid[0]);
      // ETA-OSCILLATION: utslagets tid är återgången, och X→Y→X′ är tre
      // poster i följd (invariants.js:337–351). ETA-SÅGTAND UPP: utslagets
      // tid är hoppet, och återgången är nästa post med en annan nivå (en
      // text som bara ändras i en annan klausul upprepar hoppets nivå).
      const osc = /ETA-OSCILLATION/.test(f.klass);
      const före = osc ? serie[k - 2] : serie[k - 1];
      const hopp = osc ? serie[k - 1] : serie[k];
      const åter = osc ? serie[k] : serie.slice(k + 1).find((x) => x.strax !== hopp.strax || x.eta !== hopp.eta);
      if (!före || !hopp || !åter) return nej('ETA-serien saknar nivån före hoppet eller nivån efter');
      if (!före.strax) return nej(`hoppet ${fmtMs(hopp.t)} går från ${nivå(före)} till ${nivå(hopp)}, inte från strax`);
      if (hopp.strax) return nej(`nivån ${fmtMs(hopp.t)} är strax; inget hopp bort från strax`);
      if (!åter.strax) return nej(`nivån efter hoppet ${fmtMs(hopp.t)} (${nivå(hopp)}) är ${nivå(åter)} ${fmtMs(åter.t)}, ingen återgång till strax`);
      const ålderMs = p.minÅlderS * 1000;
      const tider = harnessTider(ctx);
      const per = perFartyg(ctx);
      const mmsis = [...per.keys()].sort();
      const avstånd = (r) => platser.distanceToPoint(r, f.bro);
      // En fix med avstånd, och bearbetningstiden när harnessen bearbetade den senare än radens tid.
      const fixText = (m, r) => `${m}:s fix ${fmtMs(r.aisTimestamp)} (${Math.round(avstånd(r))} m från ${f.bro}`
        + `${tider.get(r) !== r.aisTimestamp ? `, bearbetad ${fmtMs(tider.get(r))}` : ''})`;
      // Krav 2: båten vars rad bearbetades när hoppet publicerades. Två
      // AIS-rader bearbetas aldrig vid samma tid (60 ms mellan dem).
      let bärare = null;
      for (const m of mmsis) {
        const list = per.get(m);
        const i = list.findIndex((r) => tider.get(r) === hopp.t);
        if (i >= 0) {
          bärare = { mmsi: m, förra: i > 0 ? list[i - 1] : null, nästa: list[i] };
          break;
        }
      }
      // För skälet: en annan båt inom radieM vars senaste fix före hoppet var
      // äldre än minÅlderS, med hennes nästa rad närmast hoppet först.
      const gammalNära = () => {
        const g = [];
        for (const m of mmsis) {
          if (bärare && m === bärare.mmsi) continue;
          const list = per.get(m);
          const i = list.findIndex((r) => tider.get(r) > hopp.t);
          const senast = i < 0 ? list[list.length - 1] : list[i - 1];
          if (!senast || !(tider.get(senast) < hopp.t) || avstånd(senast) > p.radieM) continue;
          const å = hopp.t - tider.get(senast);
          if (å > ålderMs) {
            g.push({
              mmsi: m, förra: senast, nästa: i < 0 ? null : list[i], ålder: å,
            });
          }
        }
        const sen = (c) => (c.nästa ? tider.get(c.nästa) - hopp.t : Infinity);
        const c = g.sort((a, b) => (sen(a) - sen(b)) || (a.mmsi < b.mmsi ? -1 : 1))[0];
        if (!c) return '';
        return `${fixText(c.mmsi, c.förra)} var ${s1(c.ålder)} s gammal, men `
          + `${c.nästa ? `hennes nästa rad ${fmtMs(c.nästa.aisTimestamp)} bearbetades ${tid(sen(c))} efter hoppet` : 'hon fick ingen ny rad'}`;
      };
      if (!bärare) {
        const g = gammalNära();
        if (g) return nej(`hoppet ${fmtMs(hopp.t)} publicerades inte när harnessen bearbetade en båts rad: ${g} (studsen ska ligga på båtens nästa rad)`);
        let äldst = null;
        for (const m of mmsis) {
          const senast = per.get(m).filter((r) => tider.get(r) < hopp.t).pop();
          if (senast && avstånd(senast) <= p.radieM && (!äldst || hopp.t - tider.get(senast) > äldst.ålder)) äldst = { mmsi: m, ålder: hopp.t - tider.get(senast) };
        }
        return nej(`hoppet ${fmtMs(hopp.t)} publicerades inte när harnessen bearbetade en båts rad, och ingen båt inom ${p.radieM} m från ${f.bro} `
          + `hade en fix äldre än ${p.minÅlderS} s${äldst ? ` (äldst var ${äldst.mmsi}:s, ${tid(äldst.ålder)})` : ''}`);
      }
      const { mmsi, förra, nästa } = bärare;
      const vidRad = `hoppet ${fmtMs(hopp.t)} publicerades när harnessen bearbetade ${mmsi}:s rad ${fmtMs(nästa.aisTimestamp)}`;
      if (!förra) return nej(`${vidRad}, båtens första rad`);
      if (hopp.t - nästa.aisTimestamp > p.fönsterMs) return nej(`${vidRad}, ${tid(hopp.t - nästa.aisTimestamp)} efter radens tid (högst ${p.fönsterMs} ms)`);
      // Krav 3: appens ålder, från när fixen bearbetades.
      const stämpel = tider.get(förra);
      const ålder = hopp.t - stämpel;
      const dFörra = avstånd(förra);
      const dNästa = avstånd(nästa);
      const fix = fixText(mmsi, förra);
      if (!(ålder > ålderMs)) {
        const g = gammalNära();
        return nej(`${vidRad}, men ${fix} var ${s1(ålder)} s gammal (högst ${p.minÅlderS} s: färsk i appen)${g ? `; ${g}` : ''}`);
      }
      const gammal = `${fix} var ${s1(ålder)} s gammal vid hoppet ${fmtMs(hopp.t)}, när hennes nästa rad ${fmtMs(nästa.aisTimestamp)} bearbetades`;
      // Krav 4.
      if (dFörra > p.radieM) return nej(`${gammal}, men fixen ligger ${Math.round(dFörra)} m från bron (> ${p.radieM} m)`);
      if (dNästa > p.radieM) return nej(`${gammal}, men hennes nästa rad ligger ${Math.round(dNästa)} m från bron (> ${p.radieM} m)`);
      // Krav 5: hoppet är den första textgenereringen efter 600 s-gränsen.
      const gräns = stämpel + ålderMs;
      const text = övergångar.find((x) => x && Number.isFinite(x.t) && x.t > gräns && x.t < hopp.t);
      if (text) {
        return nej(`${gammal}, men åldern passerade ${p.minÅlderS} s ${fmtMs(gräns)}, och brotexten publicerades ${fmtMs(text.t)}, före hoppet: `
          + 'bar båten \'strax\' hade appen tappat det där');
      }
      const tick = halvminutstickFas(gräns, hopp.t - p.tickFördröjningMs, p.tickS * 1000, p.tickFördröjningMs, fas);
      if (tick !== null) {
        return nej(`${gammal}, men åldern passerade ${p.minÅlderS} s ${fmtMs(gräns)}, före halvminutsticken ${fmtMs(tick)}${fas ? ' (variantens fas)' : ''}: `
          + 'bar båten \'strax\' hade appen tappat det vid ticken');
      }
      // Krav 6.
      const kaj = platser.capsuleOf(förra) || platser.capsuleOf(nästa);
      if (kaj) return nej(`${gammal}, men båten ligger i kajkapseln '${kaj.name}' (MOORING_ZONES), och en förtöjd båts glesa rader beläggs inte som 'strax'-bärare`);
      // Krav 7: återgången hör till båtens rad.
      if (!(åter.t > hopp.t) || åter.t - nästa.aisTimestamp > p.fönsterMs) {
        return nej(`${gammal}, men återgången till strax ${fmtMs(åter.t)} kom ${tid(åter.t - hopp.t)} efter radens bearbetning `
          + `(efter den och högst ${p.fönsterMs} ms efter radens tid)`);
      }
      const emellan = [];
      for (const m of mmsis) {
        if (m === mmsi) continue;
        for (const r of per.get(m)) {
          const t = tider.get(r);
          if (t > hopp.t && t <= åter.t && avstånd(r) <= p.straxRadieM) emellan.push({ m, r, t });
        }
      }
      const annan = emellan.sort((a, b) => (a.t - b.t) || (a.m < b.m ? -1 : 1))[0];
      if (annan) {
        return nej(`${gammal}, men ${annan.m}:s rad ${fmtMs(annan.r.aisTimestamp)} (${Math.round(avstånd(annan.r))} m från ${f.bro}) bearbetades ${fmtMs(annan.t)}, `
          + `mellan båtens rad och återgången till strax ${fmtMs(åter.t)}: återgången kan inte tillskrivas båten`);
      }
      // Krav 8.
      const styr = ctx.rader.filter((r) => r && HARNESS_STYRRADER.has(r.ctrl) && tider.get(r) >= stämpel && tider.get(r) <= åter.t)
        .sort((a, b) => tider.get(a) - tider.get(b))[0];
      if (styr) return nej(`${gammal}, men styrraden ${styr.ctrl} ${fmtMs(styr.aisTimestamp)} bearbetades mellan båtens förra fix och återgången`);
      // Krav 9: båten kunde bära 'strax' vid sin förra fix.
      const egna = per.get(mmsi);
      let kunde = dFörra <= p.imminentRadieM;
      for (let j = egna.indexOf(förra) - 1; !kunde && j >= 0; j--) {
        const d = avstånd(egna[j]);
        if (!(d <= p.radieM)) break;
        if (d <= p.väntRadieM) kunde = true;
      }
      if (!kunde) {
        return nej(`${gammal}, men fixen ligger ${Math.round(dFörra)} m från bron, utanför imminent-radien ${p.imminentRadieM} m, utan någon tidigare fix `
          + `inom ${p.väntRadieM} m (väntläget) sedan båten senast var längre bort än ${p.radieM} m: båten kunde inte bära 'strax'`);
      }
      // Krav 10: ingen annan båt kunde bära 'strax' vid hoppet.
      const P = platser.POINTS[f.bro];
      const möjliga = [];
      for (const m of mmsis) {
        if (m === mmsi) continue;
        const sen = per.get(m).filter((r) => tider.get(r) < hopp.t).pop();
        if (!sen || platser.capsuleOf(sen)) continue;
        const d = avstånd(sen);
        const å = hopp.t - tider.get(sen);
        if (!(d <= p.straxRadieM) || å > ålderMs) continue;
        const dn = (P.lat - sen.lat) * 111320;
        const de = (P.lon - sen.lon) * 111320 * Math.cos((sen.lat * Math.PI) / 180);
        const bäring = ((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360;
        const mot = Number.isFinite(sen.cog) ? Math.cos(((sen.cog - bäring) * Math.PI) / 180) > 0 : d <= p.radieM;
        if (mot) {
          möjliga.push({
            m, sen, d, å, bäring,
          });
        }
      }
      const möjlig = möjliga.sort((a, b) => (a.d - b.d) || (a.m < b.m ? -1 : 1))[0];
      if (möjlig) {
        const { m, sen, å } = möjlig;
        const kurs = Number.isFinite(sen.cog) ? `kurs ${sen.cog}° mot bäringen ${Math.round(möjlig.bäring)}° till bron` : `utan kurs inom ${p.radieM} m`;
        return nej(`${gammal}, men ${fixText(m, sen)} var ${s1(å)} s gammal vid hoppet, utanför kajkapslarna och på väg mot bron (${kurs}): `
          + `hon kunde också bära 'strax' (inom ${p.straxRadieM} m, högst ${p.minÅlderS} s)`);
      }
      return ok(`${fix} var ${s1(ålder)} s gammal vid hoppet ${fmtMs(hopp.t)} (strax → ${nivå(hopp)}; > ${p.minÅlderS} s, STALE_ETA_HARD), som publicerades `
        + `när harnessen bearbetade hennes nästa rad ${fmtMs(nästa.aisTimestamp)} (${Math.round(dNästa)} m), utan textgenerering sedan åldern passerade `
        + `${p.minÅlderS} s ${fmtMs(gräns)}; återgången till strax ${fmtMs(åter.t)} kom ${Math.round(åter.t - hopp.t)} ms efter raden, utan någon annan båts rad `
        + `inom ${p.straxRadieM} m emellan, och ingen annan båt kunde bära strax vid hoppet: F40-studsen i harnessens uppskjutna UI-arbete (U16)`);
    },
  },

  // S10-VÄNDNING-BRON-BAKOM (triagens T-3, F15). Appens S10-vakt
  // (app.js:9745, _fixDReversalContradictsNotification) avstår från notisen
  // när Fix D:s färska pending-reversal motsäger tokenriktningen och bron
  // ligger bakom fartyget på levande kurs, och loggar
  // FLOW_TRIGGER_SKIP_PENDING_REVERSAL (app.js:10293). Replayresultatet bär
  // inte loggraden, så predikatet prövar vaktens villkor på raderna: fixen
  // före besöket låg i det motsatta kursbandet (det gamla riktningslåset),
  // och alla fixar inom radien under besöket har kurs i det nya bandet, fart
  // ≥ MIN_VIABLE_SPEED, bron bakom sig och ligger inom
  // FIX_D_PENDING_MAX_AGE_MS från den första. Båten korsar inte bron i
  // besöket. Kursbanden är appens: nord [315°; 45°], syd (brett) [135°; 315°).
  //
  // Fix D:s pending-flagga (VesselDataService.js:383–470) sätts bara av en
  // omvänd fix med sog ≥ FIX_D_MIN_SOG (2,0 kn, läst ur appens källtext), och
  // nästa omvända fix med minst den farten inom TTL bekräftar reversalen
  // (_confirmDirectionReversal), varpå notisen går ut. Därför krävs att
  // zonens FÖRSTA fix har sog ≥ FIX_D_MIN_SOG och att ingen senare zonfix
  // har det. Rättat 2026-11-04 (runda 2, E1): förut räckte MIN_VIABLE_SPEED
  // på varje zonfix och hur många zonfixar som helst inom 15 min, så en
  // borttagen notis blev DESIGN fast appen notifierar (granskarens s10sog:
  // zonfix 0,6/1,0/1,9 kn; s10two: en andra zonfix med 2,2 kn).
  //
  // Zonens första fix sätter flaggan bara om ingen färsk flagga redan finns
  // och låset fortfarande är det gamla. Därför spelas Fix D över fartygets
  // alla fixar före zonen (spelaFixD), med det gamla bandet som lås: en färsk
  // flagga gör att zonens första fix bekräftar reversalen, och en reversal
  // som redan bekräftats före zonen gör att den inte är omvänd. I båda
  // fallen sätter den ingen flagga och S10-vakten avstår inte. Rättat
  // 2026-11-04 (runda 2, efterrättning H): förut antogs att zonens första fix
  // satte flaggan, så granskarens s10x i värld 581 (en omvänd fix på 2,2 kn
  // 10:03:51 och 1,9 kn i det gamla bandet 10:05:18, som inte nollar
  // flaggan) gav DESIGN fast appen bekräftar reversalen 10:06:16 och
  // notifierar.
  //
  // Kurs och fart prövas som appen ser dem: en rad utan finit cog eller sog
  // får fartygets senast kända värde (medFramfördKursOchFart,
  // VesselDataService.js:5286–5287). Det gäller spelet före zonen, fixen före
  // besöket och zonkontrollerna, eftersom både Fix D-blocket och S10-vaktens
  // krav 3 läser vessel.cog och vessel.sog. Ett framfört värde redovisas i
  // skälet med tiden det kom från. Rättat 2026-11-04 (runda 3, L1): förut
  // hoppade spelet över raden och zonkontrollerna dömde den som saknad kurs
  // eller fart, så granskarens s10h i värld 581 (10:03:51 utan kurs eller
  // utan fart, med 216° och 2,2 kn från raden före) gav DESIGN fast appen
  // sätter flaggan där, bekräftar reversalen 10:06:16 och notifierar.
  reversalAwayFromBridge: {
    parametrar: {
      radieM: C.PROTECTION_ZONE_RADIUS,
      minSogKn: C.PASSAGE_TIMING.MINIMUM_VIABLE_SPEED,
      fixDMinSogKn: FIX_D_MIN_SOG,
      maxÅlderMin: C.FIX_D_PENDING_MAX_AGE_MS / MIN,
      nordFrån: C.COG_DIRECTIONS.NORTH_MIN,
      nordTill: C.COG_DIRECTIONS.NORTH_MAX,
      sydFrån: 135,
      marginalMin: 2,
    },
    fn(f, ctx, p) {
      if (!f.mmsi || !f.bro || !Array.isArray(ctx.rader)) return nej('saknar mmsi, bro eller rader');
      if (!Number.isFinite(p.fixDMinSogKn)) return nej('FIX_D_MIN_SOG kunde inte läsas ur lib/services/VesselDataService.js');
      const punkt = platser.POINTS[f.bro];
      if (!punkt) return nej(`${f.bro} är ingen notispunkt`);
      const b = f.belägg || {};
      if (Number.isFinite(b.korsningT) || b.korsning) return nej('båten korsade bron under besöket');
      const tFörsta = Number.isFinite(b.tFörstaFix) ? b.tFörstaFix : f.t;
      if (!Number.isFinite(tFörsta)) return nej('fyndet saknar tid');
      const tUt = Number.isFinite(b.tOut) ? Math.max(b.tOut, tFörsta) : tFörsta;
      // Appens kurs och fart: rader utan värde får det senast kända (L1).
      const list = medFramfördKursOchFart(rowsOf(ctx, f.mmsi));
      const i0 = list.findIndex((r) => r.aisTimestamp >= tFörsta);
      if (i0 <= 0) return nej('ingen fix före besöket');
      const före = list[i0 - 1];
      const fördFrån = (t) => (Number.isFinite(t) ? ` förd fram från ${fmtT(t)}` : '');
      const kurs = (r) => (Number.isFinite(r.cog) ? `${r.cog}°${fördFrån(r.cogFrån)}` : 'saknas');
      const fart = (r) => `${r.sog} kn${fördFrån(r.sogFrån)}`;
      const zon = list.filter((r, i) => i >= i0 && r.aisTimestamp <= tUt + p.marginalMin * MIN && platser.distanceToPoint(r, f.bro) <= p.radieM);
      if (!zon.length) return nej(`inga fixar inom ${p.radieM} m`);
      const band = (cog) => {
        if (!Number.isFinite(cog)) return null;
        if (cog >= p.nordFrån || cog <= p.nordTill) return 'norr';
        if (cog >= p.sydFrån && cog < p.nordFrån) return 'söder';
        return null;
      };
      const [z0] = zon;
      const ny = band(z0.cog);
      const gammal = band(före.cog);
      if (!ny || !gammal || ny === gammal) {
        return nej(`ingen vändning före zonen: kurs ${kurs(före)} ${fmtT(före.aisTimestamp)}, `
          + `${kurs(z0)} ${fmtT(z0.aisTimestamp)}`);
      }
      // Fix D:s tillstånd när zonens första fix kommer: pending-logiken
      // spelad över fartygets alla fixar före den, med det gamla bandet som lås.
      const maxÅlderMs = p.maxÅlderMin * MIN;
      const fd = spelaFixD(list.slice(0, list.indexOf(z0)), {
        lås: gammal, minSogKn: p.fixDMinSogKn, maxÅlderMs, band,
      });
      const färsk = fd.lås === gammal && fd.flagga && fd.flagga.riktning === ny
        && z0.aisTimestamp - fd.flagga.t < maxÅlderMs ? fd.flagga : null;
      // Fix D sätter pending-flaggan bara på en fix med sog ≥ FIX_D_MIN_SOG;
      // utan flaggan avstår S10-vakten inte, och notisen går ut. En färsk
      // flagga från före zonen kan ge vakten underlag även här, men
      // predikatet godtar bara den flagga som zonens första fix sätter
      // (medvetet konservativt).
      if (!Number.isFinite(z0.sog) || z0.sog < p.fixDMinSogKn) {
        const långsam = `zonens första fix ${fmtT(z0.aisTimestamp)} har fart ${fart(z0)} (< FIX_D_MIN_SOG ${p.fixDMinSogKn} kn)`;
        if (färsk) {
          return nej(`${långsam} och sätter ingen egen pending-flagga; flaggan från ${fmtT(färsk.t)} sattes före zonen, `
            + 'och predikatet godtar bara en flagga som zonens första fix sätter');
        }
        return nej(`${långsam}: Fix D sätter ingen pending-flagga, så S10-vakten avstår inte`);
      }
      // Reversalen bekräftades redan före zonen: låset är det nya bandet, så
      // zonens första fix är inte omvänd och sätter ingen flagga.
      if (fd.lås !== gammal) {
        return nej(`Fix D bekräftade reversalen ${fd.lås}ut redan ${fmtT(fd.bekräftad.t)} (flaggad ${fmtT(fd.bekräftad.flaggad)}), före zonen: `
          + `låset är ${fd.lås}ut, så zonens första fix sätter ingen pending-flagga och S10-vakten avstår inte`);
      }
      // En färsk flagga från före zonen: zonens första fix bekräftar
      // reversalen i stället för att sätta flaggan, och notisen går ut.
      if (färsk) {
        return nej(`zonens första fix ${fmtT(z0.aisTimestamp)} (${fart(z0)} ≥ FIX_D_MIN_SOG ${p.fixDMinSogKn} kn) bekräftar reversalen som flaggades `
          + `${fmtT(färsk.t)}, ${Math.round((z0.aisTimestamp - färsk.t) / 1000)} s tidigare (inom ${p.maxÅlderMin} min); notisen går ut`);
      }
      for (const z of zon) {
        if (band(z.cog) !== ny) return nej(`fixen ${fmtT(z.aisTimestamp)} inom radien har kurs ${kurs(z)} (inte ${ny}ut)`);
        if (!Number.isFinite(z.sog) || z.sog < p.minSogKn) return nej(`fixen ${fmtT(z.aisTimestamp)} inom radien har fart ${fart(z)} (< ${p.minSogKn} kn)`);
        if ((ny === 'norr') === (punkt.lat > z.lat)) return nej(`${f.bro} ligger inte bakom fartyget vid ${fmtT(z.aisTimestamp)}`);
        if (z.aisTimestamp - z0.aisTimestamp >= p.maxÅlderMin * MIN) return nej(`fixen ${fmtT(z.aisTimestamp)} ligger ${p.maxÅlderMin} min eller mer efter vändningens första fix`);
        // En senare omvänd fix med sog ≥ FIX_D_MIN_SOG inom TTL bekräftar
        // reversalen, och då går notisen ut (s10two: 10:06:36).
        if (z !== z0 && z.sog >= p.fixDMinSogKn) {
          return nej(`zonfixen ${fmtT(z.aisTimestamp)} (${fart(z)} ≥ FIX_D_MIN_SOG ${p.fixDMinSogKn} kn, ${ny}ut) inom ${p.maxÅlderMin} min `
            + 'bekräftar reversalen, och då går notisen ut');
        }
      }
      const senare = zon.length > 1 ? `; ${zon.length - 1} senare zonfix(ar) under ${p.fixDMinSogKn} kn bekräftar inte reversalen` : '';
      return ok(`vändning mellan ${fmtT(före.aisTimestamp)} (kurs ${kurs(före)}) och ${fmtT(z0.aisTimestamp)} (kurs ${kurs(z0)}, ${fart(z0)} ≥ FIX_D_MIN_SOG ${p.fixDMinSogKn} kn); `
        + `alla ${zon.length} fix(ar) inom ${p.radieM} m går ${ny}ut med ${f.bro} bakom sig${senare}, så S10-vakten avstår (FLOW_TRIGGER_SKIP_PENDING_REVERSAL)`);
    },
  },
};

// ---------------------------------------------------------------------------
// Laddning och validering
// ---------------------------------------------------------------------------

// En hänvisning i källa eller orakelvakt: en sökväg i repot, följd av
// `#symbol` (en funktion, konstant eller egenskap som definieras i filen)
// eller `:rad` / `:rad–rad`.
const SOURCE_REF_RE = /\b((?:docs|lib|tests|drivers)\/[^\s,;:()#]+|app\.js)(?:#([A-Za-z_$][\w$]*)|:(\d+(?:[–-]\d+)?))?/g;
const MOTORNS_FILER = 'tests/replay-validation/bugHunt/';

/** Hänvisningarna i en källa eller orakelvakt: [{fil, symbol, rader}]. */
function sourceRefs(text) {
  return [...String(text || '').matchAll(SOURCE_REF_RE)].map((m) => ({
    fil: m[1].replace(/[.:]+$/, ''), symbol: m[2] || null, rader: m[3] || null,
  }));
}

// Ord som kan stå direkt före ett reguljärt uttryck (efter dem är '/' inte
// division).
const ORD_FÖRE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * Källtexten utan kommentarer. Block- och radkommentarer blir blanksteg, och
 * radbrytningarna behålls, så att radankrade mönster och radnummer står
 * kvar. Strängar, mallsträngar (även nästlade `${…}`) och reguljära uttryck
 * läses som kod, så att ett '//' eller '/*' i dem inte tas för en kommentar.
 * Om '/' inleder ett reguljärt uttryck avgörs av tecknet eller ordet före,
 * som i en vanlig JavaScript-lexer. Infört 2026-11-04 (runda 3, L2) för
 * definesSymbol.
 * @param {string} text - källtexten
 * @returns {string} samma text med kommentarerna utblankade
 */
function utanKommentarer(text) {
  const s = String(text || '');
  const n = s.length;
  const delar = [];
  // Stacken håller mallsträngarnas nästling: 'mall' är en mallsträngs
  // textdel, ett tal klammerdjupet i ett `${…}`-uttryck.
  const stack = [];
  // Det senaste icke-blanka kodtecknet och ordet som slutar där avgör om ett
  // '/' inleder ett reguljärt uttryck. Kommentarer syns inte.
  let sist = '';
  let ord = '';
  const notera = (a, b) => {
    let k = b - 1;
    while (k >= a && /\s/.test(s[k])) k--;
    if (k < a) return;
    sist = s[k];
    let m = k + 1;
    while (m > a && /[\w$]/.test(s[m - 1])) m--;
    ord = s.slice(m, k + 1);
  };
  const KOD = /[/"'`{}]/g;
  const MALL = /[\\`$]/g;
  let i = 0;
  while (i < n) {
    const topp = stack[stack.length - 1];
    const re = topp === 'mall' ? MALL : KOD;
    re.lastIndex = i;
    const m = re.exec(s);
    const j = m ? m.index : n;
    if (j > i) {
      delar.push(s.slice(i, j));
      if (topp !== 'mall') notera(i, j);
      i = j;
    }
    if (!m) break;
    const c = s[j];
    let k = j + 1;
    if (topp === 'mall') {
      if (c === '\\') k = Math.min(n, j + 2);
      else if (c === '`') {
        stack.pop();
        sist = '`';
        ord = '';
      } else if (s[j + 1] === '{') {
        stack.push(0);
        k = j + 2;
        sist = '{';
        ord = '';
      }
      delar.push(s.slice(j, k));
    } else if (c === '/' && (s[j + 1] === '/' || s[j + 1] === '*')) {
      const slut = s[j + 1] === '/' ? s.indexOf('\n', j) : s.indexOf('*/', j + 2);
      k = slut < 0 ? n : slut + (s[j + 1] === '/' ? 0 : 2);
      delar.push(s.slice(j, k).replace(/[^\n]/g, ' '));
    } else if (c === '"' || c === "'") {
      while (k < n && s[k] !== c && s[k] !== '\n') k += s[k] === '\\' ? 2 : 1;
      k = Math.min(n, k + 1);
      delar.push(s.slice(j, k));
      sist = c;
      ord = '';
    } else if (c === '`') {
      stack.push('mall');
      delar.push(c);
    } else if (c === '/') {
      if (!sist || /[(,=:[!&|?{};+\-*%<>~^]/.test(sist) || (/[\w$]/.test(sist) && ORD_FÖRE_REGEX.has(ord))) {
        let klass = false;
        while (k < n && s[k] !== '\n' && (klass || s[k] !== '/')) {
          if (s[k] === '\\') k++;
          else if (s[k] === '[') klass = true;
          else if (s[k] === ']') klass = false;
          k++;
        }
        k = Math.min(n, k + 1);
        while (k < n && /[a-z]/i.test(s[k])) k++;
        sist = ')';
      } else {
        sist = '/';
      }
      ord = '';
      delar.push(s.slice(j, k));
    } else {
      // '{' eller '}': klammerdjupet i ett `${…}`-uttryck; '}' på djup 0
      // återgår till mallsträngen.
      if (typeof topp === 'number') {
        if (c === '{') stack[stack.length - 1]++;
        else if (topp === 0) stack.pop();
        else stack[stack.length - 1]--;
      }
      sist = c;
      ord = '';
      delar.push(c);
    }
    i = k;
  }
  return delar.join('');
}

// En import binder bara ett namn som definieras i en annan fil:
// `const x = require(…)`, `const { a, b: c } = require(…)` (även över flera
// rader), `= await import(…)`, `import … from '…'` och `export … from '…'`.
// En objektegenskap vars värde är en import (`namn: require(…).namn,`, även
// med värdet på nästa rad, eller `namn: await import(…),`) eller bara ett
// annat namn (`namn: namn,`, `namn: a.b,`, även med värdet på nästa rad)
// definierar inte heller egenskapen: den återexporterar något som definieras
// på annat håll, och definieras namnet i filen hittar de andra mönstren det.
// Rättat 2026-11-04 (efterrättning R3b, granskarens varv r3, nytt problem 2):
// förut räknades `judgeT1: require("./t1Notice").judgeT1,` och
// `judgeT1: judgeT1,` i ett module.exports-objekt som definition. Rättat
// 2026-11-05 (efterrättning R3c): aliaset med värdet på nästa rad
// (`judgeT1:\n    judgeImpl,`) räknades som definition.
const IMPORT_RES = Object.freeze([
  /\b(?:const|let|var)\s+(?:\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:require|import)\s*\(/g,
  /\bimport\s+(?:[\w$*\s{},]+?\s+from\s+)?(['"])[^'"\n]*\1/g,
  /\bexport\s+(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s*from\s*(['"])[^'"\n]*\1/g,
  /^[ \t]*[A-Za-z_$][\w$]*\s*:\s*(?:await\s+)?(?:require|import)\s*\(/gm,
  /^[ \t]*[A-Za-z_$][\w$]*[ \t]*:\s*[A-Za-z_$][\w$]*(?:[ \t]*\.[ \t]*[A-Za-z_$][\w$]*)*[ \t]*(?=,|\}|$)/gm,
]);

/**
 * Definierar källtexten symbolen? En funktionsdeklaration, en
 * const/let/var/class-deklaration (även inre, som `const judgePhantom =`),
 * en metod eller en objektegenskap (`stressDensity: {`). Ett omnämnande i en
 * kommentar räcker inte: block- och radkommentarer tas bort innan
 * matchningen (utanKommentarer), så en bortkommenterad deklaration eller ett
 * JSDoc-exempel räknas inte. En import räknas inte heller (IMPORT_RES):
 * `const judgeT1 = require('./t1Notice').judgeT1;` binder namnet men
 * definierar det inte i filen, och en egenskap vars värde är en import eller
 * bara ett annat namn (`judgeT1: judgeT1,`) återexporterar det. Rättat 2026-11-04 (runda 3, L2): förut
 * matchades den råa källtexten, så granskarens fyra fall
 * (`// const decisiveFixAfter = null;`, `/* function judgeT1(ctx) { … } *\/`,
 * en rad `judgeT1: …` i en blockkommentar utan asterisk och en require) gav
 * sant.
 * @param {string} text - filens innehåll
 * @param {string} symbol - identifieraren
 * @returns {boolean} sant om symbolen definieras
 */
function definesSymbol(text, symbol) {
  return definierar(kodFörMatchning(text), symbol);
}

/** Källtexten som definitionerna matchas mot: utan kommentarer och importer. */
function kodFörMatchning(text) {
  let kod = utanKommentarer(text);
  for (const re of IMPORT_RES) kod = kod.replace(re, (m) => m.replace(/[^\n]/g, ' '));
  return kod;
}

/** Definitionsmönstren i definesSymbol, på redan rensad källtext. */
function definierar(kod, symbol) {
  const s = symbol.replace(/\$/g, '\\$');
  return new RegExp(`(?:\\bfunction\\s*\\*?\\s*${s}\\s*\\(|\\b(?:const|let|var|class)\\s+${s}\\b|^[ \\t]*(?:async\\s+)?${s}\\s*(?:\\([^)\\n]*\\)\\s*\\{|:))`, 'm')
    .test(kod);
}

// Rensad källtext per fil för hänvisningskontrollen, cachad på sökväg,
// storlek och ändringstid: registret laddas många gånger per körning och
// process, och bara filer som citeras med #symbol lexas (i dag motorns tre
// orakelfiler och runOpeningGates.js, 110 kB). Utfallet beror bara på
// filens innehåll.
const RENSAD_KÄLLTEXT = new Map();
function rensadFil(abs) {
  const st = fs.statSync(abs);
  if (!st.isFile()) return '';
  const c = RENSAD_KÄLLTEXT.get(abs);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.kod;
  const kod = kodFörMatchning(fs.readFileSync(abs, 'utf8'));
  RENSAD_KÄLLTEXT.set(abs, { mtimeMs: st.mtimeMs, size: st.size, kod });
  return kod;
}

/**
 * Kontrollerar hänvisningarna i ett fält: filen ska finnas, en citerad
 * symbol ska definieras i filen, och en hänvisning till motorns egna filer
 * ska peka på en symbol, inte på rader, så att den inte glider när filen
 * ändras (runda 2, E5: UNDER-BRO-BANDET-70M citerade t10Passage.js:57–60,
 * som efter en ändring i filhuvudet var JSDoc i stället för
 * decisiveFixAfter). Bristerna blir registervarningar.
 */
function checkRefs(e, refs, vad, root, warnings, läst) {
  for (const r of refs) {
    const abs = path.join(root, r.fil);
    if (!fs.existsSync(abs)) {
      warnings.push(`${e.id}: ${vad} ${r.fil} finns inte`);
      continue;
    }
    if (r.symbol) {
      if (!läst.has(abs)) läst.set(abs, rensadFil(abs));
      if (!definierar(läst.get(abs), r.symbol)) warnings.push(`${e.id}: ${vad} ${r.fil} definierar inte ${r.symbol}`);
    } else if (r.rader && r.fil.startsWith(MOTORNS_FILER)) {
      warnings.push(`${e.id}: ${vad} ${r.fil} citeras med rader (${r.rader}); peka på en symbol i motorns egen fil (fil.js#namn), så att hänvisningen inte glider`);
    }
  }
}

function validateEntry(e, i, ids, problems, warnings, root, läst = new Map()) {
  const at = `post ${i + 1}${e && e.id ? ` (${e.id})` : ''}`;
  if (!e || typeof e !== 'object') {
    problems.push(`${at}: ingen post`);
    return;
  }
  if (!e.id || typeof e.id !== 'string') problems.push(`${at}: saknar id`);
  else if (ids.has(e.id)) problems.push(`${at}: dubblerat id`);
  else ids.add(e.id);
  if (!ENTRY_CLASSES.includes(e.klass)) problems.push(`${at}: okänd klass ${e.klass}`);
  if (!e.datum || !/^\d{4}-\d\d-\d\d$/.test(e.datum)) problems.push(`${at}: saknar datum (ÅÅÅÅ-MM-DD)`);
  if (!e.källa || typeof e.källa !== 'string' || !e.källa.trim()) problems.push(`${at}: saknar källa`);
  else {
    const refs = sourceRefs(e.källa);
    if (!refs.length) problems.push(`${at}: källan pekar inte på docs/ eller koden`);
    checkRefs(e, refs, 'källfilen', root, warnings, läst);
  }
  if (!e.regel || typeof e.regel !== 'string') problems.push(`${at}: saknar regel`);
  const g = e.gäller;
  if (!g || !Array.isArray(g.orakel) || !g.orakel.length) problems.push(`${at}: gäller.orakel saknas`);
  if (g && g.klassRegex !== undefined) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(g.klassRegex);
    } catch (err) {
      problems.push(`${at}: ogiltig klassRegex (${err.message})`);
    }
  }
  if (g && Array.isArray(g.orakel) && g.orakel.includes('INV-F') && (!Array.isArray(g.inv) || !g.inv.length)) {
    problems.push(`${at}: en post som gäller INV-F måste namnge INV-id i gäller.inv`);
  }
  const pred = e.predikat;
  if (!pred || !pred.namn) problems.push(`${at}: saknar predikat`);
  else if (!PREDICATES[pred.namn]) problems.push(`${at}: okänt predikat ${pred.namn}`);
  else {
    const allowed = PREDICATES[pred.namn].parametrar;
    for (const k of Object.keys(pred.parametrar || {})) {
      if (!(k in allowed)) problems.push(`${at}: okänd parameter ${k} för ${pred.namn}`);
    }
    if (pred.namn === 'stderrSignature') {
      try {
        // eslint-disable-next-line no-new
        new RegExp((pred.parametrar || {}).regex || '');
      } catch (err) {
        problems.push(`${at}: ogiltigt regex (${err.message})`);
      }
    }
  }
  if (e.klass === 'KONFLIKT') {
    if (!e.fråga) problems.push(`${at}: en KONFLIKT måste ha en fråga till ägaren`);
    if (!Array.isArray(e.doktriner) || e.doktriner.length < 2) problems.push(`${at}: en KONFLIKT måste citera båda doktrinerna`);
  }
  if (e.klass === 'KÄND_ÖPPEN' && !e.fråga) warnings.push(`${e.id}: KÄND_ÖPPEN utan fråga`);
  if (e.verkan !== undefined && !VERKAN.includes(e.verkan)) problems.push(`${at}: okänd verkan ${e.verkan}`);
  if (e.verkan === 'iOraklet') {
    // Oraklet tillämpar regeln som förutsättning eller del av sin regel, så
    // posten kan aldrig matcha ett utslag. Den måste peka ut var.
    const refs = typeof e.orakelvakt === 'string' ? sourceRefs(e.orakelvakt) : [];
    if (!refs.length) problems.push(`${at}: en post med verkan iOraklet måste ange orakelvakt (fil#symbol där oraklet tillämpar regeln)`);
    checkRefs(e, refs, 'orakelvaktens fil', root, warnings, läst);
  }
}

/**
 * Laddar och validerar ett register. Kastar REGISTERFEL vid laddfel.
 * @param {object|string} [src] - registerobjekt eller sökväg (standard: beslutsregister.json)
 * @param {{root?: string}} [opts] - repots rot för källkontrollen
 * @returns {Registry} registret
 */
function loadRegistry(src = REGISTER_PATH, { root = hygiene.REPO_ROOT } = {}) {
  const data = typeof src === 'string' ? JSON.parse(fs.readFileSync(src, 'utf8')) : src;
  const problems = [];
  const warnings = [];
  if (!data || !Array.isArray(data.poster)) problems.push('registret saknar listan poster');
  const ids = new Set();
  const läst = new Map();
  (data && data.poster ? data.poster : []).forEach((e, i) => validateEntry(e, i, ids, problems, warnings, root, läst));
  // En appkonstant som inte kunde läsas gör sitt predikat falskt; det ska synas.
  for (const k of APPKONSTANTER.filter((x) => x.värde === null)) {
    const användare = (data && data.poster ? data.poster : []).filter((e) => e && e.predikat && e.predikat.namn === k.predikat
      && !(e.predikat.parametrar && Number.isFinite(e.predikat.parametrar[k.parameter])));
    for (const e of användare) warnings.push(`${e.id}: appkonstanten ${k.namn} kunde inte läsas ur ${k.fil}; predikatet ${k.predikat} är falskt`);
  }
  if (problems.length) {
    const err = new Error(`laddfel i beslutsregistret: ${problems.join('; ')}`);
    err.code = 'REGISTERFEL';
    err.problem = problems;
    throw err;
  }
  return new Registry(data, warnings);
}

class Registry {
  constructor(data, warnings = []) {
    this.version = data.version || 1;
    this.poster = data.poster.map((e) => ({
      ...e,
      verkan: e.verkan || 'omklassa',
      _re: new RegExp(e.gäller.klassRegex === undefined ? '.*' : e.gäller.klassRegex),
      _params: { ...PREDICATES[e.predikat.namn].parametrar, ...(e.predikat.parametrar || {}) },
    }));
    this.varningar = warnings;
    // Poster med verkan iOraklet prövas aldrig och har därför ingen användning.
    this.användning = fromEntries(this.poster.filter((e) => e.verkan !== 'iOraklet').map((e) => [e.id, 0]));
  }

  /**
   * Gäller posten fyndets orakel och klass (och INV-id för INV-F)?
   *
   * Säkerhetsregeln: en post som omklassar ett fatalt invariantutslag måste
   * namnge dess INV-id i gäller.inv, även med orakel '*'. En taggpost
   * omklassar aldrig, så utan inv-lista når den alla INV-F-fynd; med en
   * inv-lista bara de namngivna. Rättat 2026-11-04 (runda 2, E7): förut
   * krävdes inv även för taggposter, och STRESS-TÄTHET (orakel '*', inget
   * inv) nådde aldrig stressvärldarnas INV-F-fynd.
   */
  static applies(e, f) {
    const oracleOk = e.gäller.orakel.includes('*') || e.gäller.orakel.includes(f.orakel);
    if (!oracleOk || !e._re.test(f.klass)) return { gäller: false, skäl: oracleOk ? 'klassen matchar inte' : 'annat orakel' };
    if (f.orakel === 'INV-F') {
      const inv = Array.isArray(e.gäller.inv) && e.gäller.inv.length ? e.gäller.inv : null;
      const taggUtanInv = !inv && e.verkan === 'tagg';
      if (!taggUtanInv && !(inv && inv.includes(f.inv))) return { gäller: false, skäl: `posten namnger inte ${f.inv || 'INV-id'}` };
    }
    return { gäller: true, skäl: '' };
  }

  /**
   * Klassar ett utslag.
   * @param {object} f - fynd
   * @param {object} [ctx] - kontext (se modulhuvudet)
   * @param {{räkna?: boolean}} [opts] - räkna=false: användningen bokförs inte
   *   (krympningens och bekräftelsens prov ska inte blåsa upp "Kända utfall")
   * @returns {{klass: string, post: string|null, närmast: object|null, skäl: string, taggar: string[]}} klassning
   */
  classify(f, ctx = {}, { räkna = true } = {}) {
    let närmast = null;
    const taggar = [];
    const prövade = [];
    for (const e of this.poster) {
      // Oraklet tillämpar redan regeln (M12): posten kan inte matcha och får
      // aldrig vara "närmast" eller stå bland de prövade.
      if (e.verkan === 'iOraklet') continue;
      const a = Registry.applies(e, f);
      if (!a.gäller) {
        if (!närmast && a.skäl !== 'annat orakel' && e.gäller.orakel.includes(f.orakel)) {
          närmast = {
            post: e.id, klass: e.klass, skäl: a.skäl, källa: e.källa,
          };
        }
        continue;
      }
      let res;
      try {
        res = PREDICATES[e.predikat.namn].fn(f, ctx, e._params);
      } catch (err) {
        res = nej(`predikatet kastade: ${err.message}`);
      }
      if (!res.sant) {
        if (e.verkan === 'tagg') continue; // taggposter är aldrig "närmast"
        prövade.push({ post: e.id, skäl: res.skäl });
        if (!närmast || närmast.skäl === 'klassen matchar inte' || /^posten namnger/.test(närmast.skäl)) {
          närmast = {
            post: e.id, klass: e.klass, skäl: `predikatet falskt: ${res.skäl}`, källa: e.källa,
          };
        }
        continue;
      }
      if (räkna) this.användning[e.id]++;
      if (e.verkan === 'tagg') {
        taggar.push(e.id);
        continue;
      }
      return {
        klass: e.klass, post: e.id, närmast: null, skäl: res.skäl, taggar, prövade,
      };
    }
    return {
      klass: KANDIDAT, post: null, närmast, skäl: '', taggar, prövade,
    };
  }

  /**
   * Poster som inte matchat något utslag i körningen. Poster med verkan
   * iOraklet räknas inte: de kan aldrig matcha och vore permanent brus i
   * listan som ska avslöja kvarlämnade amnestier.
   */
  unused() {
    return this.poster.filter((e) => e.verkan !== 'iOraklet' && this.användning[e.id] === 0).map((e) => ({
      id: e.id, klass: e.klass, omätbar: e.predikat.namn === 'aldrig', gäller: e.gäller.orakel,
    }));
  }

  /** Poster som oraklen tillämpar själva (verkan iOraklet), med orakelvakten. */
  iOraklet() {
    return this.poster.filter((e) => e.verkan === 'iOraklet').map((e) => ({
      id: e.id, klass: e.klass, gäller: e.gäller.orakel, orakelvakt: e.orakelvakt,
    }));
  }

  /** Antalet poster som registret prövar (alla utom verkan iOraklet). */
  prövbara() {
    return this.poster.filter((e) => e.verkan !== 'iOraklet').length;
  }

  /** Posten med id. */
  entry(id) {
    return this.poster.find((e) => e.id === id) || null;
  }
}

module.exports = {
  REGISTER_PATH,
  ENTRY_CLASSES,
  VERKAN,
  KANDIDAT,
  PREDICATES,
  APPKONSTANTER,
  loadRegistry,
  Registry,
  reversals,
  appKonstant,
  episodLängdMs,
  halvminutstickInne,
  spelaFixD,
  medFramfördKursOchFart,
  harnessTider,
  halvminutstickFas,
  sourceRefs,
  definesSymbol,
  utanKommentarer,
};
