'use strict';

/**
 * Fas 0: självtestet (BUGGJAKT §5.1 och §11).
 *
 *   S-GIT       git-vakten (före-ögonblicksbilden tas av hunt.js)
 *   banken ×2   alla korpusar körs två gånger; H5 på varje par (= ID-relationen)
 *   M-EXAKT     SHIFT30 och MMSI (relations.runExact)
 *   S-KANARIE   bankens instrumentkrav: totalerna > 0
 *   H3          stderr-baslinjen byggs ur de två bankvarven
 *   LÅST BANK   basens fatala invarianter mot korpusens knownInvariantExceptions
 *               (en ny träff är en regressionssignal och blir första kortet)
 *
 * Basresultaten cachas i körning.bas och återanvänds av M-FAS.
 *
 * Stopp (exit 2) när: banken inte är byte-identisk mellan två körningar,
 * M-EXAKT bryts, en baskörning fallerar eller ett instrumentkrav är 0.
 * Med --corpus (delmängd) blir instrumentkraven varningar.
 *
 * Kanarier, rundresa och bankkalibrering (S-KALIBRERING) hör till
 * sanningsspåret och kopplas in via körning.självtestTillägg (se lanes.js).
 */

const bankOps = require('./bankOps');
const relations = require('./relations');
const existing = require('./oracles/existing');
const health = require('./oracles/health');
const signature = require('./signature');
const { makeFinding } = require('./finding');
const gtLib = require('../../makeGtPassages');

/** Bankens instrumentkrav (S-KANARIE, banken). */
const INSTRUMENT_KRAV = Object.freeze([
  ['targetPassages', (r) => (r.targetPassages || []).length],
  ['intermediatePassages', (r) => (r.intermediatePassages || []).length],
  ['openingWarnings', (r) => (r.openingWarnings || []).length],
  ['absorberad täckning', (r) => (r.openingCoverage || []).filter((c) => c.reason === 'absorbed').length],
  ['visitReentries', (r) => (r.visitReentries || []).length],
  ['journeyResets', (r) => (r.journeyResets || []).length],
  ['confirmedTargetWaits', (r) => (r.confirmedTargetWaits || []).length],
  ['notiser med alreadyPassed', (r) => (r.notifications || []).filter((n) => n.alreadyPassed === true).length],
  ['notiser med source passage-fallback', (r) => (r.notifications || []).filter((n) => n.source === 'passage-fallback').length],
]);

function baseEntry(korpus, kc, utfall) {
  const { resultat } = utfall;
  const gt = gtLib.loadGtPassages(korpus.id) || [];
  const judged = resultat ? existing.judgeExisting({ result: resultat, rows: kc.rader, gt }) : null;
  return {
    korpus,
    kc,
    utfall,
    resultat,
    gt,
    fatala: judged ? judged.fatala : [],
    warn: judged ? judged.warn : [],
    leverans: judged ? judged.leverans : [],
  };
}

/**
 * Kör banken en gång (eller hämtar cachen) — för spår som körs utan självtest
 * och för M-FAS monitoringarm.
 * @param {object} körning - körningsobjektet
 * @param {{monitoring?: boolean}} [opts] - monitoringarm
 * @returns {Promise<Map>} korpus-id → baspost
 */
async function ensureBase(körning, { monitoring = false } = {}) {
  const key = monitoring ? 'basMonitoring' : 'bas';
  if (körning[key] && körning[key].size === körning.korpusar.length) return körning[key];
  const kcs = körning.korpusar.map((c) => ({ c, kc: bankOps.readCorpus(c) }));
  const res = await körning.pool.runAll(kcs.map(({ c, kc }) => ({
    jsonl: c.jsonl, etikett: `${c.id} bas${monitoring ? ' (monitoring)' : ''}`, monitoring, rader: kc.rader.length, simTimmar: kc.simTimmar,
  })));
  const map = new Map();
  kcs.forEach(({ c, kc }, i) => map.set(c.id, baseEntry(c, kc, res[i])));
  körning[key] = map;
  if (!monitoring && !körning.hälsa.h3Baslinje) körning.hälsa.h3Baslinje = health.buildH3Baseline(res);
  const failed = res.filter((u) => !u.ok);
  if (failed.length) {
    körning.stoppa(0, `baskörningen fallerade: ${failed.map((u) => `${u.etikett}: ${u.fel}`).join('; ')}`);
  }
  return map;
}

/**
 * Registerutfallet för en ny träff på låst bank: alltid KANDIDAT. Banken är
 * validerad, så varje ny fatal invariant, leveransfel eller processfel är en
 * regression i replay:all och ska bli första kortet. Bara runAllCorpora:s
 * exakta prefixmatch mot knownInvariantExceptions (ovan) undantar, aldrig en
 * registerpost (M03, 2026-11-04: förut amnestierade KIE-PER-KORPUS en ny
 * episod av samma klass vid samma bro, och kortet hamnade i Kända utfall).
 *
 * "Närmast" är KIE-PER-KORPUS bara för en fatal invariant av de INV-klasser
 * som posten gäller (gäller.inv, klassRegex); posten säger ingenting om ett
 * leveransfel, ett processfel eller en annan invariant, och då står ingen
 * post som närmast (efterrättning D, samma vilseledande "närmast" som M12
 * tog bort).
 * @param {object} körning - körningsobjektet (register)
 * @param {object} [f] - träffen
 * @returns {object} registerutfallet
 */
function lockedBankRegister(körning, f = null) {
  const kie = körning.register && typeof körning.register.entry === 'function' ? körning.register.entry('KIE-PER-KORPUS') : null;
  const gäller = !!(kie && f && f.orakel === 'INV-F' && kie.gäller.orakel.includes('INV-F')
    && Array.isArray(kie.gäller.inv) && kie.gäller.inv.includes(f.inv) && (!kie._re || kie._re.test(f.klass)));
  return {
    klass: 'KANDIDAT',
    post: null,
    närmast: gäller ? {
      post: kie.id, klass: kie.klass, källa: kie.källa, skäl: 'låst bank: bara runAllCorpora:s exakta prefixmatch gäller (FP9), ingen registeramnesti',
    } : null,
    skäl: '',
    prövade: [],
  };
}

/**
 * Reproduktionen för en ny träff på låst bank: den oförändrade korpusen
 * (bas.jsonl, och bas.state.json när korpusen har starttillstånd) med
 * receptet {korpus, relation: 'BAS'}. hunt:repro dömer då om kortet med
 * harnessens domare (INV-F, LEV) eller hälsooraklen (H1), utan korpusens
 * knownInvariantExceptions som registeramnesti. Gäller alla tre slagen av
 * träff (efterrättning D: förut fick bara INV-F-träffarna en repro, och ett
 * LEV- eller H1-kort svarade KAN INTE DÖMAS).
 */
function lockedBankRepro(id, b) {
  return {
    filer: [{ från: b.kc.jsonl, till: 'bas.jsonl' }, ...(b.kc.statePath ? [{ från: b.kc.statePath, till: 'bas.state.json' }] : [])],
    kommandon: ['node tests/replay-validation/replayRunner.js <fynd>/bas.jsonl', 'npm run hunt:repro -- <fynd>', `npm run replay:all  # korpus ${id}`],
    recept: { korpus: id, relation: 'BAS', operation: 'oförändrad korpus' },
    underlag: `den låsta korpusen ${id}, ${b.kc.rader.length} rader.`,
    bekräftelse: 'verklig data; basen är byte-identisk mellan två körningar.',
  };
}

/** Basens fatala invarianter mot knownInvariantExceptions (prefixmatch, som runAllCorpora). */
function lockedBankFindings(körning) {
  const fynd = [];
  const oanvända = [];
  let fatalaTotalt = 0;
  let kända = 0;
  for (const [id, b] of körning.bas) {
    const kie = Array.isArray(b.korpus.knownInvariantExceptions) ? b.korpus.knownInvariantExceptions : [];
    for (const k of kie) if (!b.fatala.some((v) => v.startsWith(k))) oanvända.push(`${id}: ${k}`);
    for (const v of b.fatala) {
      fatalaTotalt++;
      if (kie.some((k) => v.startsWith(k))) {
        kända++;
        continue;
      }
      const f = existing.fromInvariant(v, 'INV-F', { resultat: b.resultat });
      const x = makeFinding({
        ...f,
        spår: 'bank',
        nivå: 'bank',
        ursprung: {
          korpus: id, relation: 'BAS', rader: b.kc.rader.length, timmar: b.kc.simTimmar,
        },
        taggar: ['LÅST-BANK'],
        repro: lockedBankRepro(id, b),
      });
      Object.defineProperty(x, 'kontext', {
        value: {
          korpus: b.korpus, rader: b.kc.rader, resultat: b.resultat, gt: b.gt,
        },
        enumerable: false,
      });
      fynd.push(x);
    }
    for (const v of b.leverans) {
      const x = makeFinding({
        ...existing.fromDelivery(v),
        spår: 'bank',
        nivå: 'bank',
        ursprung: {
          korpus: id, relation: 'BAS', rader: b.kc.rader.length, timmar: b.kc.simTimmar,
        },
        taggar: ['LÅST-BANK'],
        repro: lockedBankRepro(id, b),
      });
      Object.defineProperty(x, 'kontext', { value: { korpus: b.korpus, rader: b.kc.rader, resultat: b.resultat }, enumerable: false });
      fynd.push(x);
    }
    for (const f of health.h1(b.utfall)) {
      const x = makeFinding({
        ...f,
        spår: 'bank',
        nivå: 'bank',
        ursprung: {
          korpus: id, relation: 'BAS', rader: b.kc.rader.length, timmar: b.kc.simTimmar,
        },
        taggar: ['LÅST-BANK'],
        repro: lockedBankRepro(id, b),
      });
      Object.defineProperty(x, 'kontext', { value: { korpus: b.korpus }, enumerable: false });
      fynd.push(x);
    }
  }
  // Fas 3 klassar inte om fynd som redan har ett registerutfall.
  for (const x of fynd) x.register = lockedBankRegister(körning, x);
  return {
    fynd, oanvända, fatalaTotalt, kända,
  };
}

/** Räknare ur basens WARN-invarianter (informativa). */
function warnCounters(körning) {
  const counts = {};
  for (const b of körning.bas.values()) {
    for (const v of b.warn) {
      const k = `INV-W ${signature.invariantClass(v)} (bank)`;
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  return counts;
}

/**
 * Kör självtestet. Fyller körning.bas, körning.hälsa och körning.fynd.
 * @param {object} körning - körningsobjektet
 * @returns {Promise<object>} självtestets sammanfattning
 */
async function runSelftest(körning) {
  const h = körning.hälsa;
  const kcs = körning.korpusar.map((c) => ({ c, kc: bankOps.readCorpus(c) }));
  const jobs = kcs.map(({ c, kc }) => ({
    jsonl: c.jsonl, etikett: `${c.id} bas`, rader: kc.rader.length, simTimmar: kc.simTimmar,
  }));
  const run1 = await körning.pool.runAll(jobs);
  const run2 = await körning.pool.runAll(jobs);
  körning.bas = new Map();
  kcs.forEach(({ c, kc }, i) => körning.bas.set(c.id, baseEntry(c, kc, run1[i])));
  h.h3Baslinje = health.buildH3Baseline([...run1, ...run2]);

  // Determinism (H5) = ID-relationen.
  const determinism = { n: kcs.length, ok: 0, avvikande: [] };
  kcs.forEach(({ c }, i) => {
    if (!run1[i].ok || !run2[i].ok) {
      determinism.avvikande.push({ korpus: c.id, skillnad: `körfel: ${run1[i].fel || run2[i].fel}` });
      return;
    }
    const r = health.h5(run1[i].resultat, run2[i].resultat);
    if (r.lika) determinism.ok++;
    else determinism.avvikande.push({ korpus: c.id, skillnad: r.skillnad });
  });
  h.determinism = determinism;
  const failedBase = run1.filter((u) => !u.ok);
  if (failedBase.length) körning.stoppa(0, `baskörningen fallerade: ${failedBase.map((u) => `${u.etikett}: ${u.fel}`).join('; ')}`);
  if (determinism.ok !== determinism.n) {
    const ex = determinism.avvikande.slice(0, 3).map((a) => `${a.korpus}: ${a.skillnad}`).join('; ');
    körning.stoppa(0, `banken är inte byte-identisk mellan två körningar (${determinism.n - determinism.ok} korpusar): ${ex}`);
  }

  // M-EXAKT (bara om basen kunde köras).
  let exakt = { SHIFT30: { n: 0, ok: 0, brott: [] }, MMSI: { n: 0, ok: 0, brott: [] } };
  if (!failedBase.length) exakt = await relations.runExact(körning);
  h.relationer = {
    ID: { n: determinism.n, ok: determinism.ok, brott: determinism.avvikande },
    SHIFT30: exakt.SHIFT30,
    MMSI: exakt.MMSI,
  };
  for (const rel of ['SHIFT30', 'MMSI']) {
    const r = exakt[rel];
    if (r.ok !== r.n) körning.stoppa(0, `M-EXAKT ${rel} bruten på ${r.n - r.ok} korpusar: ${r.brott.map((b) => b.korpus).join(', ')}`);
  }

  // Instrumentkrav i banken.
  const krav = INSTRUMENT_KRAV.map(([namn, fn]) => ({
    namn, värde: [...körning.bas.values()].reduce((s, b) => s + (b.resultat ? fn(b.resultat) : 0), 0),
  }));
  for (const k of krav) k.ok = k.värde > 0;
  h.instrument = { ok: krav.every((k) => k.ok), krav };
  for (const k of krav.filter((x) => !x.ok)) {
    if (körning.delmängd) h.varningar.push(`instrumentkravet "${k.namn}" är 0 i delmängden (inget stopp för --corpus)`);
    else körning.stoppa(0, `INSTRUMENT BLINT: bankens total för ${k.namn} är 0`);
  }

  // Låst bank.
  const låst = lockedBankFindings(körning);
  h.låstBank = {
    fatala: låst.fatalaTotalt,
    kända: låst.kända,
    nya: låst.fynd.length,
    oanvändaUndantag: låst.oanvända,
    text: `${låst.fatalaTotalt} fatala invariantutslag i basen, ${låst.kända} täckta av knownInvariantExceptions; `
      + `${låst.fynd.length} nya träffar; ${låst.oanvända.length} oanvända undantag${låst.oanvända.length ? ` (${låst.oanvända.join('; ')})` : ''}`,
  };
  körning.fynd.push(...låst.fynd);
  const kieEntry = körning.register && körning.register.entry('KIE-PER-KORPUS');
  if (kieEntry) {
    const named = new Set(kieEntry.gäller.inv || []);
    for (const b of körning.bas.values()) {
      for (const k of b.korpus.knownInvariantExceptions || []) {
        const inv = signature.invIdOf(k);
        if (inv && !named.has(inv)) h.varningar.push(`${b.korpus.id}: knownInvariantException för ${inv} som KIE-PER-KORPUS inte namnger`);
      }
    }
  }
  Object.assign(körning.täckning.räknare, warnCounters(körning));

  // Sanningsspårets självtesttillägg (kanarier, rundresa, S-KALIBRERING).
  for (const tillägg of körning.självtestTillägg || []) {
    // eslint-disable-next-line no-await-in-loop
    await tillägg(körning);
  }

  const delmängd = körning.delmängd ? ' (delmängd)' : '';
  // Spårens självtesttillägg (kanarier, rundresa) lägger egna delar i texten.
  const tillägg = (körning.självtestTexter || []).map((x) => `, ${x}`).join('');
  const text = `determinism ${determinism.ok}/${determinism.n}, SHIFT30 ${exakt.SHIFT30.ok}/${exakt.SHIFT30.n}, MMSI ${exakt.MMSI.ok}/${exakt.MMSI.n}${tillägg}${delmängd}`;
  let status = 'GRÖNT';
  if (körning.stopp.length) status = körning.flaggor.ignoreraSjälvtest ? 'RÖTT (ignorerat med --ignore-selftest)' : 'RÖTT';
  h.självtest = {
    status,
    text,
    stopp: [...körning.stopp],
    delmängd: !!körning.delmängd,
  };
  körning.täckning.rader.push(
    {
      spår: 'självtest', orakel: 'M-EXAKT ID (H5)', profil: '—', prövat: determinism.n, utslag: determinism.n - determinism.ok,
    },
    {
      spår: 'självtest', orakel: 'M-EXAKT SHIFT30', profil: '—', prövat: exakt.SHIFT30.n, utslag: exakt.SHIFT30.n - exakt.SHIFT30.ok,
    },
    {
      spår: 'självtest', orakel: 'M-EXAKT MMSI', profil: '—', prövat: exakt.MMSI.n, utslag: exakt.MMSI.n - exakt.MMSI.ok,
    },
  );
  return h.självtest;
}

module.exports = {
  INSTRUMENT_KRAV, baseEntry, ensureBase, lockedBankFindings, lockedBankRegister, lockedBankRepro, warnCounters, runSelftest,
};
