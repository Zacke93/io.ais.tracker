'use strict';

/**
 * Spår A, omgång 11 (U90): registerpredikat för öppningsvarningarnas kända
 * mekanismer (docs/BUGGJAKT.md §7, "Spår A, omgång 11"). Modulen exporterar
 * en fabrik som får registrets egna hjälpare (registry.js), så att
 * definitionerna av "levererad varning", "fyndets korsning" och raderna är
 * desamma som i övriga predikat.
 *
 * Grundregeln för varje predikat (U90, krav 2): utslaget känns igen på appens
 * egen bokföring i replayresultatet (openingWarnings, openingCoverage,
 * openingCoverageVerdicts, journeyResets, targetPassages) eller på appens
 * egen tidsregel räknad på samma rader, aldrig på ett brett tidsfönster.
 * Varje tolerans står vid sin parameter med skälet.
 */

const constants = require('../../../../lib/constants');
const { fromEntries } = require('./util');

const KN = 1852 / 3600;
const EARTH_R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
/** Storcirkelavstånd (m), samma formel som appens geometry.calculateDistance. */
function avstånd(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}
const BRO = Object.freeze(fromEntries(Object.values(constants.BRIDGES).map((b) => [b.name, b])));
const tillBro = (r, bro) => avstånd(r.lat, r.lon, BRO[bro].lat, BRO[bro].lon);
/** Öppningsbara broar som kan spärra (Stallbackabron räknas aldrig, BridgeOpeningService#_earlierBridgeAhead). */
const SPÄRRBROAR = Object.freeze(['Olidebron', 'Klaffbron', 'Järnvägsbron', 'Stridsbergsbron']);
/** Kursbanden (lib/utils/cogDirection.js): nord 315–45 via 0, strikt syd 135–225, bred syd 135–<315. */
const nordKurs = (c) => Number.isFinite(c) && (c >= 315 || c <= 45);
const strikSydKurs = (c) => Number.isFinite(c) && c >= 135 && c <= 225;
const bredSydKurs = (c) => Number.isFinite(c) && c >= 135 && c < 315;
const osäkerKurs = (c) => Number.isFinite(c) && !nordKurs(c) && !strikSydKurs(c);
/** Inom appens bevakningsbox (AIS_CONFIG.BOUNDING_BOX): utanför den får ingen båt målbro, vilken kurs hon än har. */
const BOX = constants.AIS_CONFIG.BOUNDING_BOX;
const iBoxen = (r) => r.lat >= BOX.SOUTH && r.lat <= BOX.NORTH && r.lon >= BOX.WEST && r.lon <= BOX.EAST;

module.exports = function predikatA11(h) {
  const {
    ok, nej, fmtT, rowsOf, deliveredWarnings, fyndetsVarning, fyndetsKorsning, senasteVändning, riktningshändelser, fixtid,
  } = h;

  const positioner = (ctx, mmsi) => rowsOf(ctx, mmsi)
    .filter((r) => r && !r.ctrl && Number.isFinite(r.lat) && Number.isFinite(r.lon) && Number.isFinite(r.aisTimestamp))
    .sort((a, b) => a.aisTimestamp - b.aisTimestamp);
  const egna = (ctx, mmsi, bro) => deliveredWarnings(ctx, bro).filter((w) => String(w.leadMmsi) === String(mmsi));
  const täckning = (ctx, mmsi, bro) => ((ctx && ctx.resultat && ctx.resultat.openingCoverage) || [])
    .filter((c) => c && String(c.mmsi) === String(mmsi) && c.bridge === bro && Number.isFinite(c.t)).sort((a, b) => a.t - b.t);
  const domar = (ctx, mmsi, bro) => ((ctx && ctx.resultat && ctx.resultat.openingCoverageVerdicts) || [])
    .filter((v) => v && String(v.mmsi) === String(mmsi) && v.bridge === bro && Number.isFinite(v.t) && v.verdict).sort((a, b) => a.t - b.t);
  // Punktkorsningarna (L1, samma underlag som konvojposterna och T2-oraklet), annars L0.
  const sannaKorsningar = (ctx, bro) => {
    const gt = ((ctx && Array.isArray(ctx.gt)) ? ctx.gt : []).filter((g) => g && g.kind !== 'zone' && g.inferred !== true);
    const lista = gt.length ? gt : ((ctx && ctx.sanning && ctx.sanning.crossings) || []);
    return lista.filter((c) => c && c.bridge === bro && Number.isFinite(c.t)).sort((a, b) => a.t - b.t);
  };
  const bokförda = (ctx, mmsi, bro) => ((ctx && ctx.resultat && ctx.resultat.targetPassages) || [])
    .filter((p) => p && String(p.mmsi) === String(mmsi) && p.bridge === bro && Number.isFinite(p.t)).sort((a, b) => a.t - b.t);

  /** Ligger en annan spärrbro mellan raden och målbron i färdriktningen (latitud, som appen)? */
  function tidigareBroEmellan(r, bro, riktning) {
    const mål = BRO[bro].lat;
    return SPÄRRBROAR.filter((n) => n !== bro).find((n) => {
      const l = BRO[n].lat;
      return riktning === 'norr' ? (r.lat < l && l < mål) : (r.lat > l && l > mål);
    }) || null;
  }

  /** Den varning som fyndet gäller: fyndets egen (LEDTID, VARNING-EFTER), annars båtens första egna efter korsningen. */
  function varningFör(f, ctx, tc, maxEfterMs) {
    const w = fyndetsVarning(f, ctx);
    if (w) return w;
    return egna(ctx, f.mmsi, f.bro).find((x) => x.t >= tc && x.t <= tc + maxEfterMs) || null;
  }

  return {
    /**
     * M1–M3. Spärren vid en tidigare bro (ARCHITECTURE "Spärren vid en tidigare bro",
     * U38, U81): båtens egen varning W gick exakt när appens spärr släppte henne,
     * räknat ur hennes sista rad F före W:
     *  (i)  rörelsegrenen: ankaret + max(0, avstånd/fart − WARNING_LEAD_MS), högst + 300 s;
     *  (ii) reserven: ankaret + STALE_ETA_SOFT (300 s);
     *  (iii) första raden Q bortom den tidigare bron, med föregående rad före den (W avfyrad av Q).
     * Ankaret är radens fixtid (appens anchor). F (eller raden före Q) ska ligga före en
     * annan öppningsbar bro i färdriktningen, och ingen annan rad får ligga mellan F och W.
     * Andra grenar (tystnadsgränsen, fartökningen) och en egen deadline som binder senare
     * ger andra tider och förblir kandidater.
     */
    a11SparrSlapp: {
      parametrar: {
        ledMs: constants.BRIDGE_OPENING.WARNING_LEAD_MS,
        reservMs: 300000,
        rörelseKn: 2,
        // Tolerans 250 ms: släppet går på appens deadlinetimer (ms-exakt) eller när harnessen
        // bearbetar raden (60 ms-steg). Mätt på de 34 utslag posten känner igen i nattjaktens
        // världar: |W − regel| median 0 ms, högst 48 ms.
        toleransMs: 250,
        maxEfterMs: 15 * 60000,
      },
      fn(f, ctx, p) {
        const k = fyndetsKorsning(f);
        if (!Number.isFinite(k.t) || !k.riktning || !BRO[f.bro]) return nej('saknar korsning, riktning eller bro');
        const w = varningFör(f, ctx, k.t, p.maxEfterMs);
        if (!w) return nej('ingen egen varning för båten');
        if (String(w.leadMmsi) !== String(f.mmsi)) return nej(`varningen ${w.eventId} leds av ${w.leadMmsi}, inte av båten själv`);
        const håll = ctx.resultat && ctx.resultat.openingHolds;
        if (!Array.isArray(håll)) return nej('resultatet saknar openingHolds (harnessens bokföring av spärren)');
        const minaHåll = håll.filter((x) => String(x.mmsi) === String(f.mmsi) && x.bridge === f.bro);
        const släpp = minaHåll.find((x) => x.typ === 'släpp' && Math.abs(x.t - w.t) <= p.toleransMs);
        if (!släpp) return nej(`appen bokförde inget släpp av spärren vid ${fmtT(w.t)}`);
        const start = minaHåll.filter((x) => x.typ === 'håll' && x.t <= släpp.t).pop();
        if (!start) return nej('appen bokförde inget håll före släppet');
        const rader = positioner(ctx, f.mmsi);
        // (iii) släpp på första raden bortom den tidigare bron
        const q = rader.find((r) => Math.abs(r.aisTimestamp - w.t) <= p.toleransMs);
        if (q && w.firedBy === 'fix') {
          if (!/ingen tidigare bro framför/.test(släpp.skäl)) return nej(`släppet bokfördes som '${släpp.skäl}', inte som raden bortom bron`);
          const före = rader.filter((r) => r.aisTimestamp < q.aisTimestamp).pop();
          const e = före && tidigareBroEmellan(före, f.bro, k.riktning);
          if (!e) return nej('varningen avfyrades av en rad, men raden före den låg inte före en tidigare bro');
          if (tidigareBroEmellan(q, f.bro, k.riktning)) return nej('raden som avfyrade varningen ligger fortfarande före en tidigare bro');
          // Spärren får inte redan ha löpt ut: släppet på raden är appens regel bara när
          // spärrens slut ur raden före (rörelsegrenen eller reserven) ligger efter raden.
          const ankP = Math.min(fixtid(före), före.aisTimestamp);
          const slutP = ankP + (Number.isFinite(före.sog) && före.sog >= p.rörelseKn
            ? Math.min(p.reservMs, Math.max(0, (tillBro(före, f.bro) / (före.sog * KN)) * 1000 - p.ledMs)) : p.reservMs);
          if (slutP < q.aisTimestamp - p.toleransMs) return nej(`spärren ur raden ${fmtT(före.aisTimestamp)} borde ha löpt ut ${fmtT(slutP)}, före raden ${fmtT(q.aisTimestamp)}`);
          return ok(`spärren vid ${e} släpptes av första raden bortom bron ${fmtT(q.aisTimestamp)} (raden före ${fmtT(före.aisTimestamp)}), varningen ${w.eventId} på samma rad`);
        }
        if (w.firedBy !== 'deadline') return nej(`varningen ${w.eventId} avfyrades av ${w.firedBy}, inte av spärrens släpp`);
        if (!/löpte ut/.test(släpp.skäl)) return nej(`släppet bokfördes som '${släpp.skäl}', inte som utlöpt spärr`);
        const F = rader.filter((r) => r.aisTimestamp < w.t - p.toleransMs).pop();
        if (!F) return nej('ingen rad före varningen');
        const e = tidigareBroEmellan(F, f.bro, k.riktning);
        if (!e) return nej(`sista raden ${fmtT(F.aisTimestamp)} före varningen låg inte före en tidigare bro`);
        const ankare = Math.min(fixtid(F), F.aisTimestamp);
        const reserv = ankare + p.reservMs;
        const kand = [{ gren: 'reserven 300 s', t: reserv }];
        if (Number.isFinite(F.sog) && F.sog >= p.rörelseKn) {
          const rörelse = ankare + Math.min(p.reservMs, Math.max(0, (tillBro(F, f.bro) / (F.sog * KN)) * 1000 - p.ledMs));
          kand.unshift({ gren: 'rörelsegrenen', t: rörelse });
        }
        const träff = kand.find((c) => Math.abs(c.t - w.t) <= p.toleransMs);
        if (!träff) {
          return nej(`varningen ${fmtT(w.t)} stämmer inte med spärrens släpp ur raden ${fmtT(F.aisTimestamp)}: ${
            kand.map((c) => `${c.gren} ${fmtT(c.t)}`).join(', ')}`);
        }
        if (start.av !== e) return nej(`appen höll vid ${start.av}, men raden ligger före ${e}`);
        return ok(`spärren vid ${e} släpptes i ${träff.gren} ${fmtT(träff.t)} ur raden ${fmtT(F.aisTimestamp)} `
          + `(${Math.round(tillBro(F, f.bro))} m, ${F.sog} kn); varningen ${w.eventId} ${fmtT(w.t)}, ingen rad emellan`);
      },
    },

    /**
     * M4. U18: returen efter en U-sväng kan inte bekräftas när båten inte sänt en enda
     * rad i den nya riktningen (Fix D:s breda band) i minst FIX_D_MIN_SOG mellan vändningen
     * och korsningen, och appen bokförde ingen riktningshändelse (journeyResets) däremellan.
     */
    a11ReturUtanOmvandFix: {
      parametrar: { vändningMs: 30 * 60000, minKn: 2 },
      fn(f, ctx, p) {
        const k = fyndetsKorsning(f);
        if (!Number.isFinite(k.t) || !k.riktning) return nej('saknar korsning eller riktning');
        const u = senasteVändning(ctx, f.mmsi, k.t, p.vändningMs);
        if (!u) return nej('ingen L0-vändning högst 30 min före korsningen');
        const rh = riktningshändelser(ctx, f.mmsi);
        if (!rh) return nej('resultatet saknar journeyResets');
        const bek = rh.find((x) => x.t > u.t && x.t <= k.t);
        if (bek) return nej(`appen bokförde en riktningshändelse ${fmtT(bek.t)} före korsningen`);
        const iRiktning = k.riktning === 'norr' ? nordKurs : bredSydKurs;
        const omvända = positioner(ctx, f.mmsi).filter((r) => fixtid(r) > u.t && r.aisTimestamp <= k.t
          && Number.isFinite(r.sog) && r.sog >= p.minKn && iRiktning(r.cog));
        if (omvända.length) return nej(`${omvända.length} rad(er) i den nya riktningen i minst ${p.minKn} kn före korsningen (första ${fmtT(omvända[0].aisTimestamp)})`);
        return ok(`vändningen ${fmtT(u.t)}: ingen rad i den nya riktningen i minst ${p.minKn} kn före korsningen ${fmtT(k.t)}, och ingen riktningshändelse; Fix D hade inget att bekräfta på (U18)`);
      },
    },

    /**
     * M5. Under-bro-vakten (VesselDataService.js#assignTargetAfterReversal): appens
     * bekräftelse (journeyResets) kom på en rad högst UNDER_BRIDGE_CLEAR_DISTANCE från
     * bron, så målbron sköts upp till nästa rad, och nästa rad kom först efter korsningen.
     */
    a11UnderBroVakt: {
      parametrar: { vändningMs: 30 * 60000, bandM: constants.UNDER_BRIDGE_CLEAR_DISTANCE, toleransMs: 1500 },
      fn(f, ctx, p) {
        const k = fyndetsKorsning(f);
        if (!Number.isFinite(k.t) || !BRO[f.bro]) return nej('saknar korsning eller bro');
        const u = senasteVändning(ctx, f.mmsi, k.t, p.vändningMs);
        if (!u) return nej('ingen L0-vändning högst 30 min före korsningen');
        const rh = riktningshändelser(ctx, f.mmsi);
        if (!rh) return nej('resultatet saknar journeyResets');
        const bek = rh.filter((x) => x.t > u.t && x.t <= k.t).pop();
        if (!bek) return nej('ingen riktningshändelse mellan vändningen och korsningen');
        const upp = ctx.resultat && ctx.resultat.reversalTargetDeferrals;
        if (!Array.isArray(upp)) return nej('resultatet saknar reversalTargetDeferrals (harnessens bokföring av under-bro-vakten)');
        const def = upp.find((x) => String(x.mmsi) === String(f.mmsi) && Math.abs(x.t - bek.t) <= p.toleransMs);
        if (!def) return nej(`appen sköt inte upp målbron vid bekräftelsen ${fmtT(bek.t)}`);
        const rader = positioner(ctx, f.mmsi);
        const r = rader.find((x) => Math.abs(x.aisTimestamp - bek.t) <= p.toleransMs);
        if (!r) return nej(`ingen rad vid riktningshändelsen ${fmtT(bek.t)}`);
        const d = tillBro(r, def.bridge);
        if (d > p.bandM) return nej(`bekräftelseraden låg ${Math.round(d)} m från ${def.bridge}, utanför under-bro-bandet ${p.bandM} m`);
        const nästa = rader.find((x) => x.aisTimestamp > r.aisTimestamp);
        if (nästa && nästa.aisTimestamp <= k.t) return nej(`nästa rad ${fmtT(nästa.aisTimestamp)} kom före korsningen`);
        return ok(`vändningen bekräftad ${fmtT(bek.t)} ${Math.round(d)} m från ${def.bridge} (appen sköt upp målbron); målbron väntar på nästa rad (${nästa ? fmtT(nästa.aisTimestamp) : 'ingen'}), efter korsningen ${fmtT(k.t)}`);
      },
    },

    /**
     * M6a. U48 (känd gräns): en båt i fart vars alla rader före korsningen har kursen i
     * det osäkra bandet får ingen målbro. Utan varning före korsningen: inga täckningsrader
     * för bron före korsningen. Med en sen varning: varningen gick på första raden med
     * kursen i ett strikt band.
     */
    a11KursbandNyBat: {
      parametrar: { minKn: 2, toleransMs: 1500, horisontMs: 60 * 60000 },
      fn(f, ctx, p) {
        const k = fyndetsKorsning(f);
        if (!Number.isFinite(k.t)) return nej('saknar korsning');
        const rader = positioner(ctx, f.mmsi).filter((r) => r.aisTimestamp < k.t && r.aisTimestamp > k.t - p.horisontMs);
        if (!rader.length) return nej('inga rader före korsningen');
        const w = fyndetsVarning(f, ctx);
        // Bara rader inom bevakningsboxen kan ge målbro (_calculateTargetBridge: Outside canal bounds).
        const fartRader = rader.filter((r) => Number.isFinite(r.sog) && r.sog >= p.minKn && iBoxen(r));
        if (w) {
          if (String(w.leadMmsi) !== String(f.mmsi) || w.firedBy !== 'fix') return nej('varningen är inte båtens egen, avfyrad av en rad');
          const q = rader.find((r) => Math.abs(r.aisTimestamp - w.t) <= p.toleransMs);
          if (!q || osäkerKurs(q.cog)) return nej('varningen gick inte på en rad med kursen i ett strikt band');
          const före = fartRader.filter((r) => r.aisTimestamp < q.aisTimestamp);
          if (!före.length || före.some((r) => !osäkerKurs(r.cog))) return nej('en tidigare rad i fart hade kursen i ett strikt band');
          return ok(`${före.length} rader i fart före ${fmtT(q.aisTimestamp)} med kursen i det osäkra bandet; varningen ${w.eventId} på första raden i strikt band (U48)`);
        }
        if (täckning(ctx, f.mmsi, f.bro).some((c) => c.t < k.t)) return nej('båten var beväpnad eller täckt vid bron före korsningen');
        if (!fartRader.length) return nej(`ingen rad i minst ${p.minKn} kn före korsningen`);
        const strikt = fartRader.find((r) => !osäkerKurs(r.cog));
        if (strikt) return nej(`raden ${fmtT(strikt.aisTimestamp)} i fart hade kursen ${strikt.cog}° i ett strikt band`);
        return ok(`alla ${fartRader.length} rader i fart före korsningen har kursen i det osäkra bandet (${fartRader.map((r) => r.cog).join(', ')}°); ingen målbro (U48)`);
      },
    },

    /**
     * M6b. D8B (fälld i omgång 4, känd gräns): appens bekräftelse av vändningen
     * (journeyResets) kom på en rad med kursen i det osäkra bandet, så målbron nekades i
     * samma tick; varningen gick på nästa rad (eller nästa rad kom efter korsningen).
     */
    a11KursbandEfterVandning: {
      parametrar: { vändningMs: 30 * 60000, toleransMs: 1500 },
      fn(f, ctx, p) {
        const k = fyndetsKorsning(f);
        if (!Number.isFinite(k.t)) return nej('saknar korsning');
        const u = senasteVändning(ctx, f.mmsi, k.t, p.vändningMs);
        if (!u) return nej('ingen L0-vändning högst 30 min före korsningen');
        const rh = riktningshändelser(ctx, f.mmsi);
        const bek = rh && rh.filter((x) => x.t > u.t && x.t <= k.t).pop();
        if (!bek) return nej('ingen riktningshändelse mellan vändningen och korsningen');
        const rader = positioner(ctx, f.mmsi);
        const r = rader.find((x) => Math.abs(x.aisTimestamp - bek.t) <= p.toleransMs);
        if (!r || !osäkerKurs(r.cog)) return nej('bekräftelseradens kurs ligger inte i det osäkra bandet');
        const nästa = rader.find((x) => x.aisTimestamp > r.aisTimestamp);
        const w = fyndetsVarning(f, ctx);
        if (w) {
          if (String(w.leadMmsi) !== String(f.mmsi) || !nästa || Math.abs(nästa.aisTimestamp - w.t) > p.toleransMs) {
            return nej('varningen gick inte på raden efter bekräftelsen');
          }
          return ok(`bekräftelsen ${fmtT(bek.t)} på kursen ${r.cog}° (osäkert band); varningen ${w.eventId} på nästa rad ${fmtT(nästa.aisTimestamp)} (D8B)`);
        }
        if (nästa && nästa.aisTimestamp <= k.t) return nej(`nästa rad ${fmtT(nästa.aisTimestamp)} kom före korsningen`);
        return ok(`bekräftelsen ${fmtT(bek.t)} på kursen ${r.cog}° (osäkert band); nästa rad efter korsningen ${fmtT(k.t)} (D8B)`);
      },
    },

    /**
     * M7. Konvojfönstrets kant (fältgranskningen 12.5, U42): båten var absorberad i E,
     * och hennes sista dom i E före korsningen var 'covered' med appens ankomst inom
     * domens fönsterslut, ett fönster av rätt längd (högst max(E:s avfyrning, skattad
     * första passage) + CONVOY_WINDOW_MS + 1 s). Den sanna korsningen kom högst toleransMs
     * efter fönstrets slut och högst toleransMs + CONVOY_WINDOW_MS efter E:s första sanna
     * passage av en annan båt. Med en sen egen varning: den är täckningsslutets släpp ur E.
     */
    a11KonvojFonsterkant: {
      parametrar: {
        fönsterMs: constants.BRIDGE_OPENING.CONVOY_WINDOW_MS,
        // Tolerans 45 s: appens skattning av första passagen låg 2–43 s från sanningen i de
        // elva nattutslagen (dirigent/omg11/A/RAPPORT.md, M7); samma gräns som omgång 4.
        toleransMs: 45000,
      },
      fn(f, ctx, p) {
        const k = fyndetsKorsning(f);
        if (!Number.isFinite(k.t)) return nej('saknar korsning');
        const abs = täckning(ctx, f.mmsi, f.bro).filter((c) => c.reason === 'absorbed' && c.t < k.t);
        if (!abs.length) return nej('båten absorberades inte i någon händelse före korsningen');
        const E = abs[abs.length - 1].eventId;
        const ds = domar(ctx, f.mmsi, f.bro).filter((v) => v.eventId === E && v.t < k.t);
        const v = ds.filter((x) => Number.isFinite(x.verdict.windowEndMs)).pop();
        if (!v) return nej(`ingen dom med fönsterslut i ${E} före korsningen`);
        if (v.verdict.kind !== 'covered') return nej(`sista domen i ${E} före korsningen var ${v.verdict.kind}`);
        const a = v.verdict.arrivalMs;
        const slut = v.verdict.windowEndMs;
        if (!Number.isFinite(a) || a > slut) return nej(`appens ankomst ${fmtT(a)} låg inte inom fönstret ${fmtT(slut)}`);
        const ev = v.event || {};
        if (!Number.isFinite(ev.firstPassageAt)) return nej(`händelsens första passage var inte känd i domen ${fmtT(v.t)}`);
        const bas = Math.max(Number.isFinite(ev.firedAt) ? ev.firedAt : -Infinity, ev.firstPassageAt,
          Number.isFinite(ev.firstPassageRegisteredAt) ? ev.firstPassageRegisteredAt : -Infinity);
        if (slut > bas + p.fönsterMs + 1000) return nej(`fönstret ${fmtT(slut)} är längre än max(avfyrning, första passage, bokföringen) + ${p.fönsterMs / 1000} s`);
        if (k.t - slut > p.toleransMs) return nej(`korsningen ${Math.round((k.t - slut) / 1000)} s efter fönstret, mer än ${p.toleransMs / 1000} s`);
        const medlemmar = new Set(((ctx.resultat && ctx.resultat.openingCoverage) || []).filter((c) => c.eventId === E).map((c) => String(c.mmsi)));
        const första = sannaKorsningar(ctx, f.bro).find((c) => medlemmar.has(String(c.mmsi)) && String(c.mmsi) !== String(f.mmsi) && c.t < k.t);
        if (!första) return nej(`ingen annan båt i ${E} korsade före henne`);
        if (k.t - första.t <= p.fönsterMs) return nej('korsningen ligger inom fönstret från händelsens första sanna passage; en annan post gäller');
        if (k.t - första.t > p.fönsterMs + p.toleransMs) return nej(`korsningen ${Math.round((k.t - första.t) / 1000)} s efter ${E}:s första passage`);
        const w = fyndetsVarning(f, ctx);
        if (w) {
          const släpp = domar(ctx, f.mmsi, f.bro).find((x) => x.eventId === E && Math.abs(x.t - w.t) <= 1500);
          if (String(w.leadMmsi) !== String(f.mmsi) || !släpp || !/täckningsslut|bakkant/.test(släpp.verdict.kind)) {
            return nej('den sena varningen är inte släppet ur händelsen vid fönstrets slut');
          }
        }
        return ok(`täckt av ${E}; sista domen ${fmtT(v.t)}: ankomst ${fmtT(a)} inom fönstret ${fmtT(slut)}; korsningen ${Math.round((k.t - slut) / 1000)} s från fönstrets slut och ${Math.round((k.t - första.t) / 1000)} s efter ${första.mmsi}:s passage`);
      },
    },

    /**
     * M10. U47 (U15-REFERENS-VID-FÖNSTERKANTEN, dirigent/omg4/BESLUT.md): returbåten
     * absorberades i E efter sin egen passage k, när E:s referens (domspåret: fönsterslut −
     * CONVOY_WINDOW_MS i hennes första dom i E) låg mer än ett fönster från k. Den andra
     * båtens passage x hamnade inom fönstret från k, och när x bokfördes släppte U15 (b)
     * henne: hennes egen varning W gick högst en tick efter bokföringen. Gäller också när
     * W kom efter hennes korsning (T3).
     */
    a11U15ReferensVidFonsterkanten: {
      parametrar: { fönsterMs: constants.BRIDGE_OPENING.CONVOY_WINDOW_MS, tickMs: constants.BRIDGE_OPENING.TICK_INTERVAL_MS, ledtidMinMs: 60000 },
      fn(f, ctx, p) {
        const kc = fyndetsKorsning(f);
        if (!Number.isFinite(kc.t)) return nej('saknar korsning');
        const egnaK = sannaKorsningar(ctx, f.bro).filter((c) => String(c.mmsi) === String(f.mmsi) && c.t < kc.t - 1000);
        const k = egnaK[egnaK.length - 1];
        if (!k) return nej('ingen egen tidigare korsning av bron');
        const abs = täckning(ctx, f.mmsi, f.bro).filter((c) => c.reason === 'absorbed' && c.t > k.t && c.t < kc.t);
        if (!abs.length) return nej('ingen absorption efter hennes passage och före returen');
        const w = fyndetsVarning(f, ctx);
        if (!w || String(w.leadMmsi) !== String(f.mmsi)) return nej('fyndets varning är inte båtens egen');
        const E = abs.map((c) => c.eventId).reverse().find((id) => id !== w.eventId);
        if (!E) return nej('ingen annan händelse än varningens');
        const eW = deliveredWarnings(ctx, f.bro).find((x) => x.eventId === E);
        if (!eW || kc.t - eW.t < p.ledtidMinMs) return nej(`${E}:s varning kom inte minst 60 s före returen`);
        const förstaDom = domar(ctx, f.mmsi, f.bro).find((v) => v.eventId === E && Number.isFinite(v.verdict.windowEndMs)
          && (!v.event || !Number.isFinite(v.event.firstPassageAt)));
        if (!förstaDom) return nej(`ingen dom i ${E} med referensen (fönsterslut före första passagen)`);
        const ref = förstaDom.verdict.windowEndMs - p.fönsterMs;
        if (Math.abs(ref - k.t) <= p.fönsterMs) return nej(`referensen ${fmtT(ref)} låg redan inom fönstret från passagen ${fmtT(k.t)}: U15 borde ha släppt henne direkt`);
        const medlemmar = new Set(((ctx.resultat && ctx.resultat.openingCoverage) || []).filter((c) => c.eventId === E).map((c) => String(c.mmsi)));
        const x = sannaKorsningar(ctx, f.bro).find((c) => medlemmar.has(String(c.mmsi)) && String(c.mmsi) !== String(f.mmsi)
          && c.t > k.t && Math.abs(c.t - k.t) <= p.fönsterMs && c.t <= kc.t + p.tickMs * 4);
        if (!x) return nej(`ingen annan båt i ${E} korsade inom fönstret från hennes passage`);
        const bok = bokförda(ctx, x.mmsi, f.bro).find((b) => b.t >= x.t - 1000);
        if (!bok) return nej(`${x.mmsi}:s passage bokfördes aldrig`);
        if (w.t < bok.t - 1000 || w.t > bok.t + p.tickMs) return nej(`varningen ${fmtT(w.t)} sammanfaller inte med bokföringen ${fmtT(bok.t)} (högst en tick efter)`);
        return ok(`retur efter passagen ${fmtT(k.t)}; ${E}:s referens ${fmtT(ref)} låg ${Math.round((ref - k.t) / 1000)} s bort, ${x.mmsi} korsade ${Math.round((x.t - k.t) / 1000)} s efter henne och bokfördes ${fmtT(bok.t)}; U15 (b) släppte henne, varningen ${w.eventId} ${fmtT(w.t)}`);
      },
    },

    /**
     * M11. U88 (känd gräns, ARCHITECTURE U49-avsnittet "systerstället vid bakkanten"):
     * bakkanten släppte båten på domen 'bakkant' där appens prognos låg efter fönstrets
     * slut men armens fysik inom, med armen i minst MOVING_SOG_KN högst maxM från bron,
     * fönstret av rätt längd, och den sanna korsningen inom fönstret.
     */
    a11BakkantPrognosVidLinjen: {
      parametrar: {
        maxM: 100, minKn: 2, fönsterMs: constants.BRIDGE_OPENING.CONVOY_WINDOW_MS, toleransMs: 1500,
      },
      fn(f, ctx, p) {
        const k = fyndetsKorsning(f);
        const w = fyndetsVarning(f, ctx);
        if (!Number.isFinite(k.t) || !w) return nej('saknar korsning eller varning');
        if (String(w.leadMmsi) !== String(f.mmsi)) return nej('varningen är inte båtens egen');
        const v = domar(ctx, f.mmsi, f.bro).find((x) => x.verdict.kind === 'bakkant' && Math.abs(x.t - w.t) <= p.toleransMs);
        if (!v) return nej('ingen bakkantsdom vid varningen');
        const { arrivalMs: a, physicsArrivalMs: fy, windowEndMs: slut } = v.verdict;
        if (!(Number.isFinite(a) && Number.isFinite(fy) && Number.isFinite(slut) && fy <= slut && a > slut)) {
          return nej('domen har inte prognosen efter och fysiken inom fönstret');
        }
        if (!(v.arm && v.arm.distanceM <= p.maxM && v.arm.sog >= p.minKn)) return nej(`armen låg inte högst ${p.maxM} m från bron i minst ${p.minKn} kn`);
        const ev = v.event || {};
        const bas = Math.max(Number.isFinite(ev.firedAt) ? ev.firedAt : -Infinity, Number.isFinite(ev.firstPassageAt) ? ev.firstPassageAt : -Infinity);
        if (!Number.isFinite(bas) || slut > bas + p.fönsterMs + 1000) return nej('fönstret är längre än max(avfyrning, första passage) + fönstret');
        if (k.t > slut) return nej('den sanna korsningen ligger efter fönstret: släppet var rätt');
        // Samma öppning också i sanningen: korsningen inom händelsens första sanna passage av en
        // annan medlem + CONVOY_WINDOW_MS (nattvärld 295:s motfall i t-v1-granskning).
        const medl = new Set(((ctx.resultat && ctx.resultat.openingCoverage) || []).filter((c) => c.eventId === v.eventId).map((c) => String(c.mmsi)));
        const första = sannaKorsningar(ctx, f.bro).find((c) => medl.has(String(c.mmsi)) && String(c.mmsi) !== String(f.mmsi) && c.t < k.t);
        if (!första || k.t - första.t > p.fönsterMs) return nej('korsningen ligger inte inom fönstret från händelsens första sanna passage');
        return ok(`bakkantsdom ${fmtT(v.t)} ${Math.round(v.arm.distanceM)} m från bron i ${v.arm.sog} kn: prognos ${fmtT(a)} efter, fysik ${fmtT(fy)} inom fönstret ${fmtT(slut)}; korsningen ${fmtT(k.t)} inom (U88)`);
      },
    },
  };
};
