'use strict';

/**
 * Omgång 11, spår B (U90): predikat för INV-3:s och INV-14:s kända utfall
 * (BUGGJAKT §7, "Omgång 11, spår B"). Egen fil så att verktygsspårets tre
 * rättare inte ändrar samma block i registry.js.
 *
 * Alla predikat läser appens eget läge vid varje publicerad text ur
 * replayresultatets bridgeTextLeads (harnessens bokföring,
 * replayRunner.js#bridgeTextLeads): presentationskopians etaMinutes,
 * imminent-flaggan, uttömningens stämpel, appens positionsklocka
 * (confirmedMs = _lastConfirmedPositionMs), farten och köbron framför
 * (queueBridge). En text som saknar fälten (äldre resultat) gör predikatet
 * falskt.
 *
 * Modulen är en fabrik: registry.js skickar in sina hjälpare, så att filen
 * inte behöver läsa registry.js (ingen cirkulär laddning).
 */

const path = require('path');

module.exports = function registerOmg11B(h) {
  const {
    ok, nej, fmtT, platser, rowsOf, medFramfördKursOchFart, bäringTill, appKonstant, C,
    STALE_SOFT_MS, STALE_HARD_MS, IMMINENT_EXHAUSTED_MAX_AGE_MS, defaultEpisod, klausulFör, låstBank, LÅST_BANK, FIX_D_MIN_SOG,
  } = h;

  // Harnessens upplösning för ett släpp som sker vid en halvminutstick: ticken
  // (30 s) och harnessens dränering, som kör appens uppskjutna UI-arbete först
  // vid nästa steg (högst 30 s, BUGGJAKT §7 U16 "Mekanismen"), plus textens
  // mikrograce (40 ms). Mätt på de 62 utslagen i mekanism B och de 55
  // F1-utslagen: släppet kom 0,0–31,0 s efter gränsen (se RESULTAT.md).
  const SLÄPP_UPPLÖSNING_MS = 30000 + 30000 + 40;

  const KLAUSUL_RE = /^(\S+) (?:båt|båtar) på väg mot (Klaffbron|Stridsbergsbron), (?:beräknad broöppning (?:(strax)|om (cirka )?(\d+) minuter)|ETA okänd)/;

  /** Brons ETA-serie ur bridgeTextLeads: {t, eta (0,5 = strax), cirka, antal, lead, meta}. */
  function serieMedMeta(ctx, bro) {
    const L = ctx && ctx.resultat && ctx.resultat.bridgeTextLeads;
    if (!Array.isArray(L)) return null;
    const ut = [];
    for (const x of L) {
      if (!x || !Number.isFinite(x.t) || typeof x.text !== 'string') continue;
      for (const klausul of x.text.split('; ')) {
        const m = KLAUSUL_RE.exec(klausul);
        if (!m || m[2] !== bro || (!m[3] && !m[5])) continue;
        const lead = (x.leads || []).find((l) => l && l.bridge === bro);
        ut.push({
          t: x.t, eta: m[3] ? 0.5 : Number(m[5]), cirka: !!m[4], antal: m[1], lead: lead && lead.mmsi != null ? String(lead.mmsi) : null, meta: x, text: x.text,
        });
      }
    }
    return ut;
  }
  const båt = (s, mmsi) => ((s && s.meta && s.meta.vessels) || []).find((v) => v && String(v.mmsi) === String(mmsi)) || null;
  const harFälten = (v) => !!v && 'etaMinutes' in v && 'confirmedMs' in v && 'queueAhead' in v;
  const avrundad = (eta) => Math.round(eta);

  /** Stegen i ett INV-3-utslag: [föregående, fyndets] för sågtand, [X, Y, X′] för oscillation. */
  function utslagetsTexter(f, ser) {
    const i = ser.findIndex((x) => x.t === f.t);
    if (i < 0) return null;
    if (/OSCILLATION/.test(f.klass)) return i >= 2 ? ser.slice(i - 2, i + 1) : null;
    return i >= 1 ? ser.slice(i - 1, i + 1) : null;
  }

  /** Båtens sista rad med tid högst ms (+1 s för harnessens bearbetning). */
  function egnaRader(ctx, mmsi, ms) {
    const egna = rowsOf(ctx, mmsi).filter((r) => Number.isFinite(r.lat) && r.aisTimestamp <= ms + 1000);
    return egna[egna.length - 1] || null;
  }

  /**
   * Blir båten imminent igen i en senare text (inom efterMs) utan ny bekräftad
   * position och utan en uttömning efter texten? Appen kan inte ge strax igen
   * utan nytt underlag; en flapp är ett fel. Returnerar tiden eller null.
   */
  function återImminentUtanBevis(ser, från, mmsi, v, efterMs) {
    const L = (från.meta && Array.isArray(ser)) ? ser : [];
    for (const x of L) {
      if (x.t <= från.t || x.t - från.t > efterMs) continue;
      const w = båt(x, mmsi);
      if (!w || !harFälten(w)) continue;
      if (w.confirmedMs !== v.confirmedMs) return null;
      if (w.imminent && !(Number.isFinite(w.exhaustedAt) && w.exhaustedAt > från.t)) return x.t;
    }
    return null;
  }

  /** Sanningens korsningar (L0) när de finns, annars L1-facit (gt), annars null. */
  function korsningslista(ctx) {
    if (ctx.sanning && Array.isArray(ctx.sanning.crossings)) return ctx.sanning.crossings;
    return Array.isArray(ctx.gt) ? ctx.gt : null;
  }

  /**
   * Korsar A bron före B (första korsningen efter respektive bekräftade
   * position)? Sanningens korsningar (L0) när de finns, annars L1-facit (gt).
   * Returnerar true eller skälet.
   */
  function korsarFöre(ctx, bro, A, tA, B, tB) {
    const lista = korsningslista(ctx);
    if (!lista) return 'saknar korsningar (sanning eller facit) för att belägga vem som var främst';
    const första = (m, t) => lista.filter((c) => c && String(c.mmsi) === String(m) && c.bridge === bro && Number.isFinite(c.t) && c.t > t)
      .sort((x, y) => x.t - y.t)[0] || null;
    const a = första(A, tA);
    if (!a) return `${A} korsar inte ${bro} efter sin sista position: att hon var främst kan inte beläggas`;
    const b = första(B, tB);
    if (b && b.t < a.t) return `${B} korsar ${bro} ${fmtT(b.t)} före ${A} (${fmtT(a.t)}): ${A} var inte främst, ledarvalet byggde på fel tider`;
    return true;
  }

  /**
   * Är nästa båts visade tid rimlig mot hennes verkliga korsning? Hoppet ska
   * vara bytet, inte ett räknefel i hennes tid: visad tid högst
   * RIMLIG_KVOT · sann tid + RIMLIG_MARGINAL_MIN. Mätt på spår B:s 229
   * träffar på arbetskopian: (visad − 5)/sann p95 1,56, max 2,63 (3 över 2);
   * mutanten M3 (restiden mot fel bro, +8 min för varannan båt) gav 18 av 26
   * nya träffar över 2. Sanningens korsningar (L0), annars L1-facit (gt).
   */
  const RIMLIG_KVOT = 2;
  const RIMLIG_MARGINAL_MIN = 5;
  function rimligTid(ctx, bro, mmsi, eta, t) {
    const lista = korsningslista(ctx);
    if (!lista) return 'saknar korsningar för att pröva nästa båts tid';
    const k = lista.filter((c) => c && String(c.mmsi) === String(mmsi) && c.bridge === bro && Number.isFinite(c.t) && c.t > t)
      .sort((x, y) => x.t - y.t)[0];
    if (!k) return `${mmsi} korsar inte ${bro} efter hoppet: hennes tid kan inte prövas`;
    const sann = (k.t - t) / 60000;
    if (eta > RIMLIG_KVOT * sann + RIMLIG_MARGINAL_MIN) return `${mmsi}:s tid ${eta} min mot ${sann.toFixed(1)} min till hennes korsning: hoppet är ett räknefel i hennes tid, inte bytet`;
    return true;
  }

  /**
   * Varför saknar den tysta båten v tid vid texten s? Appens grenar i
   * _reevaluateVesselStatuses räknade på appens egna värden vid texten: ålder ur
   * positionsklockan, farten och köbron framför. null om ingen gren förklarar.
   */
  function tystnadsgren(v, t, bro) {
    const ålder = t - v.confirmedMs;
    if (ålder > STALE_HARD_MS) return `(a) positionen ${Math.round(ålder / 1000)} s gammal`;
    if (ålder > STALE_SOFT_MS && (v.sog === null || v.sog < 1)) return `(b) positionen ${Math.round(ålder / 1000)} s gammal, ${v.sog === null ? 'okänd fart' : `${v.sog} kn`}`;
    if (ålder > STALE_SOFT_MS && v.queueAhead && v.queueAhead !== bro) return `(b) positionen ${Math.round(ålder / 1000)} s gammal, köbro framför ${v.queueAhead}`;
    if (ålder > STALE_SOFT_MS && Number.isFinite(v.exhaustedAt)) return `(c) positionen ${Math.round(ålder / 1000)} s gammal, nedräkningen uttömd ${fmtT(v.exhaustedAt)}`;
    return null;
  }

  return {
    // U34-luckorna A-i, A-ii, A-iii och A-v (spår B, omgång 11). Samma beslut
    // som ledarbyteTystFrämsta, men bundet till appens eget läge vid texterna.
    ledarbyteTystFrämstaB: {
      parametrar: {
        fallMin: 6, fallMs: 120000, kursFartKn: C.PASSAGE_TIMING.MINIMUM_VIABLE_SPEED, radieM: C.APPROACH_RADIUS, uttömdRadieM: 500, efterMs: 300000,
      },
      fn(f, ctx, p) {
        if (!f.bro || !Number.isFinite(f.t)) return nej('saknar bro eller tid');
        const ser = serieMedMeta(ctx, f.bro);
        if (!ser) return nej('resultatet saknar bridgeTextLeads');
        const tx = utslagetsTexter(f, ser);
        if (!tx) return nej(`hittar inte utslaget ${fmtT(f.t)} i ${f.bro}s ETA-serie`);
        // A-v: i en oscillation ligger bytet i avvikelsen X → Y när Y är högre.
        let före; let efter;
        if (tx.length === 3 && tx[1].eta > tx[0].eta) [före, efter] = [tx[0], tx[1]];
        else [före, efter] = [tx[tx.length - 2], tx[tx.length - 1]];
        const L1 = före.lead; const L2 = efter.lead;
        if (!L1 || !L2 || L1 === L2) return nej('ingen bärarbyte i hoppet');
        if (före.antal !== efter.antal) return nej(`antalet ändrades (${före.antal} → ${efter.antal})`);
        const v1F = båt(före, L1); const v1E = båt(efter, L1); const v2F = båt(före, L2); const v2E = båt(efter, L2);
        if (!harFälten(v1E) || !harFälten(v1F) || !harFälten(v2E)) return nej('harnessen bokförde inte etaMinutes, confirmedMs och queueAhead');
        if (före.eta < 1) return nej('nivån före var strax (U16)');
        if (v1E.targetBridge !== f.bro || v1E.imminent) return nej(`${L1} står inte kvar under gång mot ${f.bro} utan imminent`);
        if (v1F.etaMinutes === null) return nej(`${L1} hade ingen egen tid i texten före`);
        if (v1E.etaMinutes !== null) return nej(`${L1} hade fortfarande tid (${v1E.etaMinutes.toFixed(1)}) vid hoppet: ledarvalet förklaras inte`);
        // A-iii: tystnaden läses på appens positionsklocka, inte på radernas tider.
        if (v1E.confirmedMs !== v1F.confirmedMs) return nej(`${L1} fick en ny bekräftad position mellan texterna`);
        const gren = tystnadsgren(v1E, efter.t, f.bro);
        if (!gren) return nej(`${L1}:s tid nollades inte av en tystnadsgren (ålder ${Math.round((efter.t - v1E.confirmedMs) / 1000)} s, fart ${v1E.sog}, köbro ${v1E.queueAhead || '–'})`);
        // Appens imminent-regel hade inte gett L1 strax: positionen färsk nog
        // (högst STALE_ETA_HARD) och inom APPROACH_RADIUS, eller en nedräkning
        // som tog slut inom taket och högst uttömdRadieM bort, hade gett hela
        // gruppen strax i stället för L2:s tid (app.js#_imminentVerdict).
        const r1 = egnaRader(ctx, L1, v1E.confirmedMs);
        if (!r1) return nej(`${L1}:s sista rad saknas`);
        const d1 = platser.distanceToPoint(r1, f.bro);
        const ålder1 = efter.t - v1E.confirmedMs;
        if (ålder1 <= STALE_HARD_MS && (d1 <= p.radieM
          || (Number.isFinite(v1E.exhaustedAt) && efter.t - v1E.exhaustedAt <= IMMINENT_EXHAUSTED_MAX_AGE_MS && d1 <= p.uttömdRadieM))) {
          return nej(`${L1} låg ${Math.round(d1)} m från bron med färsk nog position: appen skulle ha gett strax`);
        }
        // Samma regel för gruppens andra båtar under gång: en båt med färsk nog
        // position inom APPROACH_RADIUS hade gett gruppen strax.
        for (const v of efter.meta.vessels || []) {
          if (!v || v.targetBridge !== f.bro || String(v.mmsi) === L1 || v.imminent || !harFälten(v)) continue;
          if (v.waitingAt && efter.text.includes(`väntar vid ${v.waitingAt}`)) continue;
          const r = egnaRader(ctx, v.mmsi, v.confirmedMs);
          if (r && efter.t - v.confirmedMs <= STALE_HARD_MS && platser.distanceToPoint(r, f.bro) <= p.radieM) {
            return nej(`${v.mmsi} låg inom ${p.radieM} m med färsk nog position utan imminent: appen skulle ha gett strax`);
          }
        }
        // L1 får inte bli imminent igen utan ny position eller ny uttömning (flapp).
        const åter = återImminentUtanBevis(ser, efter, L1, v1E, p.efterMs);
        if (åter) return nej(`${L1} blev imminent igen ${fmtT(åter)} utan ny position`);
        // L1 var verkligen främst: hon korsar bron före L2 (sanningen, annars L1-facit).
        const ordning = korsarFöre(ctx, f.bro, L1, v1F.confirmedMs, L2, v2E.confirmedMs);
        if (ordning !== true) return nej(ordning);
        // Den visade tiden är L2:s egen.
        if (v2E.etaMinutes === null || Math.abs(avrundad(v2E.etaMinutes) - efter.eta) > 1) return nej(`klausulens tid ${efter.eta} är inte ${L2}:s egen (${v2E.etaMinutes})`);
        const rimlig = rimligTid(ctx, f.bro, L2, efter.eta, efter.t);
        if (rimlig !== true) return nej(rimlig);
        // Ingen vändning (som ledarbyteTystFrämsta, villkor 5).
        const egna = rowsOf(ctx, L1).filter((r) => Number.isFinite(r.lat) && r.aisTimestamp <= efter.t);
        const bur = medFramfördKursOchFart(egna);
        const sista = bur[bur.length - 1];
        if (sista && Number.isFinite(sista.cog) && Number.isFinite(sista.sog) && sista.sog >= p.kursFartKn) {
          const diff = Math.abs(((sista.cog - bäringTill(sista, f.bro)) % 360 + 540) % 360 - 180);
          if (diff > 90) return nej(`${L1}:s sista rad har kursen bort från ${f.bro}`);
        }
        const reset = ((ctx.resultat && ctx.resultat.journeyResets) || []).find((r) => r && String(r.mmsi) === L1 && r.t >= v1E.confirmedMs && r.t <= efter.t);
        if (reset) return nej(`journeyReset för ${L1} ${fmtT(reset.t)} före hoppet (U18)`);
        // A-ii: den nya nivån håller. En lägre tid räknas inte när den är
        // gruppens strax från en annan båts imminent-flagga, eller när den kom
        // med L2:s egen nya position och den visade tiden var L2:s egen redan
        // före bytet (nivån blåstes inte upp i bytet).
        const i = ser.indexOf(efter);
        const egenFöre = v2F && v2F.etaMinutes !== null && Math.abs(avrundad(v2F.etaMinutes) - efter.eta) <= 1;
        for (const x of ser.slice(i + 1)) {
          if (x.t - efter.t > p.fallMs) break;
          if (x.lead !== L2 || x.eta > efter.eta - p.fallMin) continue;
          const annanImm = x.eta < 1 && ((x.meta.vessels || []).some((v) => String(v.mmsi) !== L2 && v.targetBridge === f.bro && v.imminent));
          const v2X = båt(x, L2);
          // L2:s egen rättning: en ny position, eller Fix G:s extrapolering som
          // börjar när hennes position passerat STALE_ETA_SOFT (texten säger
          // "cirka", ingen ny position). Båda kräver att den visade tiden var
          // hennes egen redan före bytet.
          const nyPos = v2X && harFälten(v2X) && v2X.confirmedMs > v2E.confirmedMs;
          const extrap = v2X && harFälten(v2X) && x.cirka && v2X.confirmedMs === v2E.confirmedMs && x.t - v2X.confirmedMs > STALE_SOFT_MS;
          const egenRättning = egenFöre && (nyPos || extrap);
          if (!annanImm && !egenRättning) return nej(`den nya nivån höll inte: ${fmtT(x.t)} visar ${x.eta} min`);
        }
        return ok(`U34: ${L1} bar klausulen (${före.eta} min ${fmtT(före.t)}), tyst sedan ${fmtT(v1E.confirmedMs)}, tid nollad ${gren}; `
          + `${L2} bär ${efter.eta} min ${fmtT(efter.t)} (hennes egen tid), ${L1} kvar i gruppen (${efter.antal})`);
      },
    },

    // Tickvarianten av U16 (mekanism B): "strax" släpps när bärarens position
    // passerar STALE_ETA_HARD eller när den uttömda nedräkningens 90 s-tak gått,
    // vid första texten efter gränsen, och klausulen visar en annan båts tid.
    straxSläppsVidTick: {
      parametrar: {},
      fn(f, ctx) {
        if (!f.bro || !Number.isFinite(f.t)) return nej('saknar bro eller tid');
        if (!Number.isFinite(IMMINENT_EXHAUSTED_MAX_AGE_MS)) return nej('taket IMMINENT_EXHAUSTED_MAX_AGE_MS kunde inte läsas');
        const ser = serieMedMeta(ctx, f.bro);
        if (!ser) return nej('resultatet saknar bridgeTextLeads');
        const tx = utslagetsTexter(f, ser);
        if (!tx) return nej(`hittar inte utslaget ${fmtT(f.t)} i ${f.bro}s ETA-serie`);
        let k = -1;
        for (let j = 0; j + 1 < tx.length; j++) {
          if (tx[j].eta < 1 && tx[j + 1].eta >= 1) {
            k = j; break;
          }
        }
        if (k < 0) return nej('inget steg från strax till en minuttid i utslaget');
        const a = tx[k]; const b = tx[k + 1];
        // Bärarna under gång: en båt i väntgruppen ("väntar vid", U65/U53) står inte i klausulen.
        const iVäntgrupp = (s, v) => !!v.waitingAt && s.text.includes(`väntar vid ${v.waitingAt}`);
        const bärare = (a.meta.vessels || []).filter((v) => v && v.targetBridge === f.bro && v.imminent && !iVäntgrupp(a, v));
        if (!bärare.length) return nej(`ingen båt var imminent vid strax ${fmtT(a.t)} (strax på ETA under 3)`);
        const skäl = [];
        for (const v of bärare) {
          const vB = båt(b, v.mmsi);
          if (!harFälten(v) || !harFälten(vB)) return nej('harnessen bokförde inte confirmedMs');
          if (vB.imminent) return nej(`${v.mmsi} var fortfarande imminent vid ${fmtT(b.t)}`);
          if (vB.confirmedMs !== v.confirmedMs) return nej(`${v.mmsi} fick en ny bekräftad position mellan texterna`);
          const gränser = [{ namn: 'STALE_ETA_HARD', t: v.confirmedMs + STALE_HARD_MS }];
          if (v.fromExhausted && Number.isFinite(v.exhaustedAt)) gränser.push({ namn: 'uttömningens tak', t: v.exhaustedAt + IMMINENT_EXHAUSTED_MAX_AGE_MS });
          const g = gränser.filter((x) => x.t >= a.t && x.t < b.t).sort((x, y) => x.t - y.t)[0];
          if (!g) return nej(`${v.mmsi}:s släpp ${fmtT(b.t)} föll inte på en gräns efter strax ${fmtT(a.t)} (${gränser.map((x) => `${x.namn} ${fmtT(x.t)}`).join(', ')})`);
          if (b.t - g.t > SLÄPP_UPPLÖSNING_MS) return nej(`${v.mmsi} släpptes ${Math.round((b.t - g.t) / 1000)} s efter ${g.namn}, mer än en tick och ett harnessteg`);
          // Imminent-flaggan låg inom appens gränser: hysteresens 350 m, eller
          // 500 m för en uttömd nedräkning (app.js#_imminentVerdict).
          const rV = egnaRader(ctx, v.mmsi, v.confirmedMs);
          const dV = rV ? platser.distanceToPoint(rV, f.bro) : null;
          if (dV !== null && dV > (v.fromExhausted ? 500 : 350)) return nej(`${v.mmsi} var imminent ${Math.round(dV)} m från bron vid ${fmtT(a.t)}: utanför appens gräns`);
          // Strax vid a hade underlag: hon var imminent redan i texten före med
          // samma position, eller fick en ny position eller en ny uttömning sedan
          // den senaste texten där hon inte var imminent (ingen flapp).
          const tidigare = ser.filter((x) => x.t < a.t && båt(x, v.mmsi)).pop();
          const vT = tidigare ? båt(tidigare, v.mmsi) : null;
          if (vT && harFälten(vT) && !vT.imminent && vT.confirmedMs === v.confirmedMs
            && !(Number.isFinite(v.exhaustedAt) && v.exhaustedAt > tidigare.t)) {
            return nej(`${v.mmsi} blev imminent vid ${fmtT(a.t)} utan ny position eller uttömning sedan ${fmtT(tidigare.t)}`);
          }
          const åter = återImminentUtanBevis(ser, b, v.mmsi, vB, 300000);
          if (åter) return nej(`${v.mmsi} blev imminent igen ${fmtT(åter)} utan ny position`);
          skäl.push(`${v.mmsi} vid ${g.namn} ${fmtT(g.t)} (+${Math.round((b.t - g.t) / 1000)} s)`);
        }
        if (!b.lead || bärare.some((v) => String(v.mmsi) === b.lead)) return nej(`klausulen vid ${fmtT(b.t)} visar inte en annan båts tid`);
        const rimlig = rimligTid(ctx, f.bro, b.lead, b.eta, b.t);
        if (rimlig !== true) return nej(rimlig);
        // En återgång till strax i oscillationen ska bäras av en ny position.
        if (tx.length === 3 && k === 0 && tx[2].eta < 1) {
          // Återgången bärs av en ny position (imminent eller egen tid under
          // 3 min) eller av en nedräkning som tog slut efter släppet (B4).
          const åter = (tx[2].meta.vessels || []).filter((v) => v && v.targetBridge === f.bro && harFälten(v) && !iVäntgrupp(tx[2], v));
          const bär = (v) => (v.imminent && (v.confirmedMs > b.t || (v.fromExhausted && Number.isFinite(v.exhaustedAt) && v.exhaustedAt >= b.t)))
            || (!v.imminent && v.etaMinutes !== null && v.etaMinutes < 3 && v.confirmedMs > b.t);
          if (!åter.some(bär)) return nej(`återgången till strax ${fmtT(tx[2].t)} bärs inte av en ny position eller en ny uttömning`);
        }
        return ok(`U16 (tickvarianten): strax släpptes för ${skäl.join('; ')}; klausulen visar ${b.lead}:s tid ${b.eta} min`);
      },
    },

    // U31:s kända rest (mekanism D): båten går in i strax på ETA under 3 min
    // utanför 300 m med en fix som själv lovar strax, bromsar nästa fix (tiden
    // går upp till minst 3) och får strax igen av imminent-flaggan inom 300 m.
    inbromsningEfterStrax: {
      parametrar: {
        kvot: appKonstant('lib/services/ProgressiveETACalculator.js', 'DECEL_HOLD_MIN_RATIO'),
        momentanMin: appKonstant('lib/services/ProgressiveETACalculator.js', 'DECEL_HOLD_MIN_INSTANT_ETA_MINUTES'),
        radieM: C.APPROACH_RADIUS,
        yttreM: 600,
      },
      fn(f, ctx, p) {
        if (!/OSCILLATION/.test(f.klass)) return nej('gäller bara oscillationen');
        if (!Number.isFinite(p.kvot) || !Number.isFinite(p.momentanMin)) return nej('U31:s konstanter kunde inte läsas');
        const ser = serieMedMeta(ctx, f.bro);
        if (!ser) return nej('resultatet saknar bridgeTextLeads');
        const tx = utslagetsTexter(f, ser);
        if (!tx) return nej('hittar inte utslaget');
        const [X, Y, X2] = tx;
        if (!(X.eta < 1 && Y.eta >= 3 && X2.eta < 1)) return nej('inte strax → minuttid → strax');
        const L = X.lead;
        if (!L || Y.lead !== L || X2.lead !== L) return nej('inte samma bärare genom utslaget');
        const vX = båt(X, L); const vY = båt(Y, L); const v2 = båt(X2, L);
        if (![vX, vY, v2].every(harFälten)) return nej('harnessen bokförde inte fälten');
        if (vX.imminent || !(vX.etaMinutes !== null && vX.etaMinutes < 3)) return nej('strax vid X var inte ETA under 3 utan imminent');
        if ((X.meta.vessels || []).some((v) => v.targetBridge === f.bro && v.imminent)) return nej('en båt var imminent vid X');
        if (!(vY.confirmedMs > vX.confirmedMs)) return nej('ingen ny fix mellan X och Y');
        if (vY.imminent || !(vY.etaMinutes >= 3)) return nej('tiden vid Y var inte minst 3 utan imminent');
        if (!v2.imminent) return nej('strax vid X′ bars inte av imminent-flaggan');
        const egna = rowsOf(ctx, L).filter((r) => Number.isFinite(r.lat));
        const radVid = (ms) => egna.filter((r) => r.aisTimestamp <= ms + 1000).pop() || null;
        const rX = radVid(vX.confirmedMs); const rY = radVid(vY.confirmedMs); const r2 = radVid(v2.confirmedMs);
        if (!rX || !rY || !r2) return nej('raderna saknas');
        const dX = platser.distanceToPoint(rX, f.bro); const dY = platser.distanceToPoint(rY, f.bro); const d2 = platser.distanceToPoint(r2, f.bro);
        if (!(dX > p.radieM && dX <= p.yttreM)) return nej(`X-fixen låg ${Math.round(dX)} m från bron, inte ${p.radieM}–${p.yttreM} m`);
        if (!(dY > p.radieM)) return nej(`Y-fixen låg inom ${p.radieM} m`);
        if (!(d2 <= p.radieM)) return nej(`X′-fixen låg ${Math.round(d2)} m från bron, utanför ${p.radieM} m`);
        // Inträdet vid X var ärligt: fixens egen fart lovade strax (U31 håller inte då).
        if (!(Number.isFinite(rX.sog) && rX.sog > 0)) return nej('X-fixen saknar fart');
        const momentan = dX / (rX.sog * 0.514444) / 60;
        if (!(momentan < p.momentanMin)) return nej(`X-fixens momentanfart gav ${momentan.toFixed(1)} min: U31 skulle ha hållit`);
        if (!(Number.isFinite(rY.sog) && rY.sog * p.kvot <= rX.sog)) return nej(`ingen inbromsning mellan X och Y (${rX.sog} → ${rY.sog} kn)`);
        return ok(`U31:s rest: strax på ETA ${vX.etaMinutes.toFixed(1)} vid ${Math.round(dX)} m och ${rX.sog} kn (momentant ${momentan.toFixed(1)} min), `
          + `inbromsning till ${rY.sog} kn ger ${Y.eta} min vid ${Math.round(dY)} m, imminent inom ${p.radieM} m (${Math.round(d2)} m)`);
      },
    },

    // E2: båten vände i världen (sanningens U-sväng) medan hoppet pågick.
    // Bäraren är ledaren i utslagets första eller sista text; vändningen ligger
    // mellan appens bekräftade positioner för henne i första och sista texten
    // (inbromsningen före vändningen räknas med: högst inbromsningMs före den
    // första), appen såg en position efter vändningen, och hon korsade inte
    // bron emellan.
    vändningUnderHoppet: {
      parametrar: { inbromsningMs: 60000, hysteresM: 350 },
      fn(f, ctx, p) {
        if (!f.bro || !Number.isFinite(f.t)) return nej('saknar bro eller tid');
        const { sanning } = ctx;
        if (!sanning || !Array.isArray(sanning.uturns)) return nej('saknar sanningens vändningar');
        const ser = serieMedMeta(ctx, f.bro);
        if (!ser) return nej('resultatet saknar bridgeTextLeads');
        const tx = utslagetsTexter(f, ser);
        if (!tx) return nej('hittar inte utslaget');
        const första = tx[0]; const sista = tx[tx.length - 1];
        // Hoppet slutar inte i strax (vändningen tar båten från bron), och varje
        // strax i utslaget bärs av en imminent-flagga inom imminent-hysteresens
        // yttre gräns (350 m) eller av en egen tid under 3 min.
        if (sista.eta < 1) return nej('utslaget slutar i strax: en vändning förklarar inte en återgång till strax');
        for (const x of tx.filter((y) => y.eta < 1)) {
          for (const v of (x.meta.vessels || []).filter((w) => w && w.targetBridge === f.bro && w.imminent && harFälten(w))) {
            const r = egnaRader(ctx, v.mmsi, v.confirmedMs);
            const d = r ? platser.distanceToPoint(r, f.bro) : null;
            if (d !== null && d > p.hysteresM && !v.fromExhausted) return nej(`${v.mmsi} var imminent ${Math.round(d)} m från bron vid ${fmtT(x.t)}`);
          }
        }
        const kandidater = [...new Set([första.lead, sista.lead].filter(Boolean))];
        const skäl = [];
        for (const m of kandidater) {
          const vF = båt(första, m); const vS = båt(sista, m);
          if (!harFälten(vF) || !harFälten(vS)) {
            skäl.push(`${m}: fälten saknas`); continue;
          }
          const u = sanning.uturns.find((x) => String(x.mmsi) === m && x.t > vF.confirmedMs - p.inbromsningMs && x.t < vS.confirmedMs);
          if (!u) {
            skäl.push(`${m}: ingen vändning mellan ${fmtT(vF.confirmedMs)} och ${fmtT(vS.confirmedMs)}`); continue;
          }
          if (!(vS.confirmedMs > vF.confirmedMs)) {
            skäl.push(`${m}: ingen ny position under hoppet`); continue;
          }
          const kors = (sanning.crossings || []).find((c) => String(c.mmsi) === m && c.bridge === f.bro && c.t > vF.confirmedMs && c.t <= sista.t);
          if (kors) {
            skäl.push(`${m} korsade ${f.bro} ${fmtT(kors.t)}`); continue;
          }
          return ok(`vändning i världen: ${m} vände ${fmtT(u.t)}, mellan appens positioner ${fmtT(vF.confirmedMs)} och ${fmtT(vS.confirmedMs)}, utan att korsa ${f.bro}`);
        }
        return nej(skäl.join('; ') || 'ingen bärare');
      },
    },

    // E1: samma båt lämnar en kö. Under väntan hålls tiden (ETA_WAIT_CLAMP);
    // första fixen i rörelse ger en högre tid på den låga avgångsfarten, och
    // nästa fix sänker den igen (ARCHITECTURE, U53-stycket: avgångssiffran är
    // en känd gräns).
    köavgångSammaBärare: {
      parametrar: { stillaKn: 0.5, rörelseKn: 1, stillaMs: 60000 },
      fn(f, ctx, p) {
        if (!/OSCILLATION/.test(f.klass)) return nej('gäller bara oscillationen');
        const ser = serieMedMeta(ctx, f.bro);
        if (!ser) return nej('resultatet saknar bridgeTextLeads');
        const tx = utslagetsTexter(f, ser);
        if (!tx) return nej('hittar inte utslaget');
        const [X, Y, X2] = tx;
        const L = X.lead;
        if (!L || Y.lead !== L || X2.lead !== L) return nej('inte samma bärare genom utslaget');
        if (!(Y.eta > X.eta && X.eta >= 1 && X2.eta >= 1)) return nej('inte minuttid → högre → minuttid');
        const vX = båt(X, L); const vY = båt(Y, L); const v2 = båt(X2, L);
        if (![vX, vY, v2].every(harFälten)) return nej('harnessen bokförde inte fälten');
        if (!(vY.confirmedMs > vX.confirmedMs && v2.confirmedMs > vY.confirmedMs)) return nej('Y och X′ bärs inte av var sin ny position');
        if (!(vX.sog !== null && vX.sog <= p.stillaKn)) return nej(`bäraren låg inte still vid X (${vX.sog} kn)`);
        if (!(vY.sog !== null && vY.sog >= p.rörelseKn && v2.sog !== null && v2.sog >= p.rörelseKn)) return nej('Y- och X′-fixarna är inte i rörelse');
        // Väntan: fixen bakom X låg still (raden och appens fart under
        // stillaKn), och nästa fix (avgången) kom minst stillaMs senare. En köare
        // med klass A sänder glest när hon ligger still (BUGGJAKT §4.2).
        const egna = rowsOf(ctx, L).filter((r) => Number.isFinite(r.lat) && r.aisTimestamp <= vX.confirmedMs + 1000);
        const rX = egna[egna.length - 1];
        if (!rX || !(Number.isFinite(rX.sog) && rX.sog <= p.stillaKn)) return nej('fixen bakom X låg inte still');
        if (!(vY.confirmedMs - vX.confirmedMs >= p.stillaMs)) return nej('avgången kom mindre än en minut efter den stilla fixen');
        if (vY.imminent || v2.imminent) return nej('imminent under avgången');
        return ok(`köavgång: ${L} stilla till ${fmtT(vX.confirmedMs)} (${X.eta} min hållen), första fixen i rörelse ${vY.sog} kn gav ${Y.eta} min, nästa ${v2.sog} kn ${X2.eta} min`);
      },
    },

    // U92 (F2): en båt vänder och går därifrån långsammare än Fix D:s gräns.
    // Appen rensar målbron (MOVING_AWAY: "Inga båtar"), sätter samma bro igen
    // vid nästa fix (ACCELERATED) innan vändningen bekräftats, och texten säger
    // "på väg mot" bron bakom henne. Bundet till appens egna rader
    // (targetChanges och journeyResets ur loggen) och sanningens vändning.
    vändningUtanBekräftelse: {
      parametrar: { fixDMinSogKn: FIX_D_MIN_SOG, vändningMs: 900000 },
      fn(f, ctx, p) {
        if (låstBank(f)) return nej(LÅST_BANK);
        if (!Number.isFinite(p.fixDMinSogKn)) return nej('FIX_D_MIN_SOG kunde inte läsas');
        if (!f.bro || !Number.isFinite(f.t)) return nej('saknar bro eller tid');
        const res = ctx.resultat || {};
        if (!Array.isArray(res.targetChanges)) return nej('harnessen bokförde inte appens målbrobyten (targetChanges)');
        const ep = defaultEpisod(f, ctx);
        if (!ep) return nej('hittar ingen DEFAULT-episod vid fyndets tid');
        const L = res.bridgeTextLeads || [];
        const mF = L.filter((x) => x && x.t === ep.före.t && x.text === ep.före.text).pop();
        const mE = L.filter((x) => x && x.t === ep.efter.t && x.text === ep.efter.text).pop();
        if (!mF || !mE) return nej('ETA-bärarna saknas');
        const kand = (mF.vessels || []).filter((v) => v && v.targetBridge === f.bro && !v.waitingAt);
        if (kand.length !== 1) return nej('texten före bars inte av exakt en båt med målbron');
        const m = String(kand[0].mmsi);
        if (!(mE.vessels || []).some((v) => String(v.mmsi) === m && v.targetBridge === f.bro)) return nej(`${m} har inte ${f.bro} som målbro igen efter episoden`);
        const tc = res.targetChanges.filter((x) => x && String(x.mmsi) === m);
        const rens = tc.find((x) => x.from === f.bro && x.to === 'none' && /^MOVING_AWAY/.test(x.reason) && x.t > ep.före.t && x.t <= ep.start.t + 1000);
        if (!rens) return nej(`appen rensade inte ${m}:s målbro ${f.bro} med MOVING_AWAY när episoden började`);
        const åter = tc.find((x) => x.from === 'none' && x.to === f.bro && /^ACCELERATED/.test(x.reason) && x.t > rens.t && x.t <= ep.efter.t + 1000);
        if (!åter) return nej(`appen satte inte ${f.bro} igen för ${m} före texten efter episoden`);
        if (!(Number.isFinite(åter.sog) && åter.sog < p.fixDMinSogKn)) {
          return nej(`${m} gick ${åter.sog} kn när målbron sattes igen: över Fix D:s gräns ${p.fixDMinSogKn} kn`);
        }
        const bekr = (res.journeyResets || []).find((r) => r && String(r.mmsi) === m && r.t >= rens.t && r.t <= åter.t);
        if (bekr) return nej(`vändningen bekräftades ${fmtT(bekr.t)} före omsättningen`);
        const u = ((ctx.sanning && ctx.sanning.uturns) || []).find((x) => String(x.mmsi) === m && x.t <= rens.t && rens.t - x.t <= p.vändningMs);
        if (!u) return nej(`${m} vände inte i världen inom ${p.vändningMs / 60000} min före rensningen`);
        return ok(`U92: ${m} vände ${fmtT(u.t)}; appen rensade ${f.bro} ${fmtT(rens.t)} (MOVING_AWAY) `
          + `och satte den igen ${fmtT(åter.t)} i ${åter.sog} kn, under Fix D:s ${p.fixDMinSogKn} kn, utan bekräftad vändning`);
      },
    },

    // F1-luckorna i U1/C11 (mekanism F1): bäraren läses ur appens målbro i
    // texten före episoden, och släppet får falla en tick och ett harnessteg
    // efter trappsteget. Trappans steg räknas som i tystBärareFörfallen.
    tystBärareFörfallenB: {
      parametrar: {
        målbroMin: 15, passageMin: 20, köMin: 25, stillaKn: 1.5, köKn: 3, köM: 600, passageM: 300, underBronM: C.UNDER_BRIDGE_CLEAR_DISTANCE,
      },
      fn(f, ctx, p) {
        if (låstBank(f)) return nej(LÅST_BANK);
        if (!f.bro || !Number.isFinite(f.t)) return nej('saknar bro eller tid');
        const ep = defaultEpisod(f, ctx);
        if (!ep) return nej('hittar ingen DEFAULT-episod vid fyndets tid');
        const klausul = klausulFör(ep.före.text, f.bro);
        if (klausul !== `En båt på väg mot ${f.bro}, ETA okänd`) return nej(`texten före episoden har klausulen "${klausul || '—'}"`);
        const L = (ctx.resultat && ctx.resultat.bridgeTextLeads) || [];
        const mF = L.filter((x) => x && x.t === ep.före.t && x.text === ep.före.text).pop();
        const mE = L.filter((x) => x && x.t === ep.efter.t && x.text === ep.efter.text).pop();
        if (!mF || !mE) return nej('ETA-bärarna saknas för texten före eller efter episoden');
        const kand = (mF.vessels || []).filter((v) => v && v.targetBridge === f.bro && !v.waitingAt);
        if (kand.length !== 1 || !harFälten(kand[0])) return nej('texten före bars inte av exakt en båt med målbron (eller fälten saknas)');
        const v = kand[0];
        if (v.etaMinutes !== null) return nej(`bäraren ${v.mmsi} hade tid i texten före`);
        if (!(mE.vessels || []).some((x) => String(x.mmsi) === String(v.mmsi))) return nej(`bäraren ${v.mmsi} kom inte tillbaka i texten efter`);
        const egna = rowsOf(ctx, v.mmsi).filter((r) => Number.isFinite(r.lat) && r.aisTimestamp <= v.confirmedMs + 1000);
        const sista = egna[egna.length - 1];
        if (!sista) return nej('bärarens rad saknas');
        // Ingen ny position under episoden: släppet och återkomsten är samma tystnad.
        const åter = (mE.vessels || []).find((x) => String(x.mmsi) === String(v.mmsi));
        if (!(åter.confirmedMs > ep.start.t)) return nej('bäraren kom inte tillbaka med en ny position');
        const { sog } = v;
        const res = ctx.resultat || {};
        const korsade = new Set([...(res.targetPassages || []), ...(res.intermediatePassages || [])]
          .filter((x) => String(x.mmsi) === String(v.mmsi) && x.t <= v.confirmedMs).map((x) => x.bridge));
        const broar = Object.values(C.BRIDGES).map((b) => b.name).filter((n) => platser.POINTS[n] && !korsade.has(n));
        const närmast = broar.map((b) => ({ b, d: platser.distanceToPoint(sista, b) })).sort((x, y) => x.d - y.d)[0] || null;
        let Lmin = p.målbroMin;
        if (sog !== null && sog < p.stillaKn) Lmin = p.köMin;
        else if ((sog === null || sog < p.köKn) && närmast && närmast.d <= p.köM) Lmin = p.köMin;
        else {
          // Som tystBärareFörfallen: bron (en opasserad eller X) ska ligga inom
          // passageM och framför henne, eller inom underBronM. Riktningen är
          // mot hennes målbro i texten före.
          const dX = platser.distanceToPoint(sista, f.bro);
          const norr = platser.POINTS[f.bro].lat > sista.lat;
          const q = närmast && närmast.d < dX ? närmast : { b: f.bro, d: dX };
          const qFramför = norr ? platser.POINTS[q.b].lat > sista.lat : platser.POINTS[q.b].lat < sista.lat;
          if (q.d <= p.passageM && (q.d <= p.underBronM || qFramför)) Lmin = p.passageMin;
        }
        const steg = v.confirmedMs + Lmin * 60000;
        const efterSteg = ep.start.t - steg;
        if (!(efterSteg > 0 && efterSteg <= SLÄPP_UPPLÖSNING_MS)) {
          return nej(`bäraren ${v.mmsi} tyst sedan ${fmtT(v.confirmedMs)}: episoden ${fmtT(ep.start.t)} ligger ${Math.round(efterSteg / 1000)} s från steget ${Lmin} min`);
        }
        return ok(`U1/C11: bäraren ${v.mmsi} (målbro ${f.bro} i texten före, ${sog === null ? 'okänd fart' : `${sog} kn`}) tyst sedan ${fmtT(v.confirmedMs)} `
          + `släpps vid steget ${Lmin} min (+${Math.round(efterSteg / 1000)} s) och kommer tillbaka ${fmtT(ep.efter.t)}`);
      },
    },
  };
};

module.exports.MODUL = path.basename(__filename);
