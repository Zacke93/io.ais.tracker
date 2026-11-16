'use strict';

/**
 * U16:s B4-variant (2026-11-15): 90 s-taket på ett uttömt "strax".
 *
 * Ägarbeslutet U16 (2026-11-04) täcker F40-studsen så som triagens
 * beslutsfråga 3 (a) beskrev den: hoppet vid åldersgränsen ELLER när B4:s 90
 * s-tak släpper ett uttömt "strax", och återgången med samma båts nästa fix
 * (docs/BUGGJAKT.md §16). Registerposten U16-F40-STRAX-STUDS nådde bara
 * åldersgränsen. Buggjägarens kort F04 och F05 (standardvärld 1907, ULLA
 * 265182731 vid Klaffbron) är B4-varianten: ULLA bär "strax" på en uttömd
 * extrapolering (stämplad 11:00:00,040, 452 m från bron), taket löser ut,
 * texten lånar JOLLY:s ETA ("om 7 minuter") och "strax" kommer tillbaka på
 * ULLA:s nästa fix. Uttömningen syns inte i raderna; replayRunner bokför
 * appens läge vid varje publicerad text (bridgeTextLeads).
 *
 * Fixturen fixtures/u16-b4-2026-11-15.json är byggd ur standardkörningen
 * (basSeed 1) på 17a9881 med harnessens nya bokföring, trimmad och
 * kontrollerad mot hela världen:
 *  - w1907: B4-varianten (F04 och F05);
 *  - w1608: huvudvarianten (positionen 604,8 s gammal), som förut;
 *  - w192: kort F02, XENIA som bromsar nära bron ("strax → om 4 → strax"),
 *    ett äkta appfel som ska förbli KANDIDAT.
 * [träff] ska klassas av posten, [vakt] ska förbli KANDIDAT. Inga
 * barnprocesser och inga timers.
 */

const { loadRegistry, PREDICATES } = require('../lib/registry');
const F = require('./fixtures/u16-b4-2026-11-15.json');

const U16 = 'U16-F40-STRAX-STUDS';
const kopia = (x) => JSON.parse(JSON.stringify(x));
const fall = (k, klass) => ({ fynd: kopia(F[k].fynd[klass]), ctx: kopia(F[k].ctx) });
const klassa = (reg, f, ctx) => reg.classify(f, ctx, { räkna: false });
const pred = (extra = {}) => (f, ctx) => PREDICATES.f40StudsVidNästaFix.fn(f, ctx, { ...PREDICATES.f40StudsVidNästaFix.parametrar, ...extra });
const p16 = pred();
const SÅG = 'INV-3 ETA-SÅGTAND UPP';
const OSC = 'INV-3 ETA-OSCILLATION';
const ULLA = '265182731';
const JOLLY = '265182787';
const iso = (hh) => Date.parse(`2026-09-18T${hh}Z`);
const FÖRE = iso('11:00:20.306');
const HOPP = iso('11:01:40.985');
const ÅTER = iso('11:02:03.042');
const vid = (ctx, t) => ctx.resultat.bridgeTextLeads.filter((x) => x.t === t).pop();
const hon = (ctx, t, mmsi = ULLA) => vid(ctx, t).vessels.find((v) => v.mmsi === mmsi);

let reg;
beforeAll(() => {
  reg = loadRegistry();
});

describe('U16 B4: 90 s-taket på uttömt strax (standardvärld 1907, korten F04 och F05)', () => {
  test.each([SÅG, OSC])('[träff] %s blir MÄTGRÄNS U16 med B4-skälet', (klass) => {
    const { fynd, ctx } = fall('w1907', klass);
    expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'MÄTGRÄNS', post: U16 });
    const { skäl } = p16(fynd, ctx);
    expect(skäl).toMatch(/265182731:s fix 10:54:53.804 \(452 m från Klaffbron\) var 407.2 s gammal/);
    expect(skäl).toMatch(/hennes 'strax' bars av en uttömd extrapolering \(stämplad 11:00:00.040\).*lånade 265182787:s ETA \(7 min\).*B4-varianten/);
  });

  test('[träff] huvudvarianten (värld 1608, positionen 604,8 s gammal) klassas som förut', () => {
    for (const klass of [SÅG, OSC]) {
      const { fynd, ctx } = fall('w1608', klass);
      expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'MÄTGRÄNS', post: U16 });
      expect(p16(fynd, ctx).skäl).toMatch(/var 604.8 s gammal vid hoppet 09:42:15.101/);
    }
  });

  test('[vakt] F02 (värld 192, XENIA bromsar): inte ett hopp från uttömt strax; KANDIDAT', () => {
    const { fynd, ctx } = fall('w192', OSC);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    expect(p16(fynd, ctx).sant).toBe(false);
  });

  test('[vakt] utan ETA-bärarna (äldre resultat) går uttömningen inte att belägga; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1907', SÅG);
    delete ctx.resultat.bridgeTextLeads;
    expect(p16(fynd, ctx).skäl).toMatch(/färsk i appen.*inte heller B4-varianten: resultatet saknar ETA-bärarna/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] (a) "strax" före hoppet bars inte av en uttömd extrapolering, eller inte av henne ensam; KANDIDAT', () => {
    const a = fall('w1907', SÅG);
    hon(a.ctx, FÖRE).fromExhausted = false;
    expect(p16(a.fynd, a.ctx).skäl).toMatch(/bar båten inte 'strax' på en uttömd extrapolering/);
    expect(klassa(reg, a.fynd, a.ctx).klass).toBe('KANDIDAT');
    const b = fall('w1907', SÅG);
    hon(b.ctx, FÖRE, JOLLY).imminent = true;
    expect(p16(b.fynd, b.ctx).skäl).toMatch(/var också 265182787 imminent/);
    expect(klassa(reg, b.fynd, b.ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] (b) flaggan inte släppt, taket inte utlöst eller ingen lånad ETA vid hoppet; KANDIDAT', () => {
    const a = fall('w1907', SÅG);
    hon(a.ctx, HOPP).imminent = true;
    expect(p16(a.fynd, a.ctx).skäl).toMatch(/imminent-flagga inte släppt/);
    const b = fall('w1907', SÅG);
    hon(b.ctx, FÖRE).exhaustedAt = HOPP - 60000;
    expect(p16(b.fynd, b.ctx).skäl).toMatch(/kom 60 s efter uttömningen, inte efter taket 90 s/);
    const c = fall('w1907', SÅG);
    vid(c.ctx, HOPP).leads.find((l) => l.bridge === 'Klaffbron').mmsi = ULLA;
    expect(p16(c.fynd, c.ctx).skäl).toMatch(/visade klausulen båtens egen ETA, inte en annan båts/);
    for (const x of [a, b, c]) expect(klassa(reg, x.fynd, x.ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] (c) återgången bars inte av en färsk fix; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1907', SÅG);
    hon(ctx, ÅTER).fromExhausted = true;
    expect(p16(fynd, ctx).skäl).toMatch(/vid återgången 11:02:03.042 bar båten inte 'strax' på en färsk fix/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] en publicerad text mellan taket och hoppet: appen hade tappat strax där; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1907', SÅG);
    const t = iso('11:01:35');
    const text = 'Två båtar på väg mot Klaffbron, beräknad broöppning strax; Tre båtar på väg mot Stridsbergsbron, beräknad broöppning om 9 minuter';
    ctx.resultat.bridgeTextTransitions.push({ t, iso: new Date(t).toISOString(), text });
    ctx.resultat.bridgeTextTransitions.sort((x, y) => x.t - y.t);
    ctx.resultat.bridgeTextLeads.push({ ...kopia(vid(ctx, FÖRE)), t, text });
    ctx.resultat.bridgeTextLeads.sort((x, y) => x.t - y.t);
    expect(p16(fynd, ctx).skäl).toMatch(/90 s-taket på uttömt 'strax' löste ut 11:01:30.040, och brotexten publicerades 11:01:35.000, före hoppet/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] återgången kom inte vid första dräneringen efter hennes rad; KANDIDAT', () => {
    // En annan båts rad långt från bron bearbetas före återgången.
    const a = fall('w1907', SÅG);
    const mall = a.ctx.rader.find((r) => String(r.mmsi) === JOLLY && r.aisTimestamp === ÅTER);
    a.ctx.rader.push({ ...mall, aisTimestamp: iso('11:01:50'), fixTs: iso('11:01:50') });
    a.ctx.rader.sort((x, y) => x.aisTimestamp - y.aisTimestamp);
    expect(p16(a.fynd, a.ctx).skäl).toMatch(/kom inte vid första dräneringen efter hennes rad \(efter nästa rad 11:01:50/);
    expect(klassa(reg, a.fynd, a.ctx).klass).toBe('KANDIDAT');
    // En text emellan.
    const b = fall('w1907', SÅG);
    const t = iso('11:01:55');
    const text = 'Två båtar på väg mot Klaffbron, beräknad broöppning om 7 minuter; En båt på väg mot Stridsbergsbron, beräknad broöppning om 9 minuter';
    b.ctx.resultat.bridgeTextTransitions.push({ t, iso: new Date(t).toISOString(), text });
    b.ctx.resultat.bridgeTextTransitions.sort((x, y) => x.t - y.t);
    expect(p16(b.fynd, b.ctx).skäl).toMatch(/kom inte vid första dräneringen efter hennes rad \(brotext 11:01:55/);
  });

  // Granskningen 2026-11-16 (L5): harnessen dränerar efter varje klocksteg om
  // högst 30 s, också i ett glapp utan rader. Återgången ska komma vid den
  // första dräneringen efter hennes rad; förut godtogs den fram till nästa
  // rad av vilken båt som helst, och i en gles värld kunde avbrottet bli minuter.
  describe('återgången senast ett klocksteg (30 s) efter hennes rad', () => {
    const glesare = (nyÅter) => {
      const { fynd, ctx } = fall('w1907', SÅG);
      // Inga rader mellan hoppet och den nya återgången; texten vid
      // återgången flyttas dit.
      ctx.rader = ctx.rader.filter((r) => !(r.aisTimestamp > HOPP && r.aisTimestamp <= nyÅter));
      for (const x of [...ctx.resultat.bridgeTextTransitions, ...ctx.resultat.bridgeTextLeads]) {
        if (x.t === ÅTER) {
          x.t = nyÅter;
          if ('iso' in x) x.iso = new Date(nyÅter).toISOString();
        }
      }
      if (fynd.klass === OSC || fynd.t === ÅTER) fynd.t = nyÅter;
      return { fynd, ctx };
    };

    test('[träff] 1907: återgången 22,1 s efter hennes rad, inom steget; U16', () => {
      expect(PREDICATES.f40StudsVidNästaFix.parametrar.dräneringMs).toBe(30000);
      const { fynd, ctx } = glesare(iso('11:02:10.985'));
      expect(klassa(reg, fynd, ctx)).toMatchObject({ klass: 'MÄTGRÄNS', post: U16 });
    });

    test('[vakt] gles värld: återgången 30,1 s efter hennes rad, efter första dräneringen; KANDIDAT', () => {
      const { fynd, ctx } = glesare(iso('11:02:11.085'));
      expect(p16(fynd, ctx).skäl).toMatch(/kom inte vid första dräneringen efter hennes rad \(30\.1 s efter hennes rad, mer än ett klocksteg \(30 s\)\)/);
      expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    });

    test('[vakt] ett långt avbrott (3 min) sväljs inte; KANDIDAT', () => {
      // Fixturens senare texter tas bort, så att bara stegets gräns fäller.
      const { fynd, ctx } = glesare(HOPP + 3 * 60000);
      const nyÅter = HOPP + 3 * 60000;
      ctx.resultat.bridgeTextTransitions = ctx.resultat.bridgeTextTransitions.filter((x) => !(x.t > HOPP && x.t < nyÅter));
      expect(p16(fynd, ctx).skäl).toMatch(/180\.0 s efter hennes rad, mer än ett klocksteg/);
      expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
    });
  });

  test('[vakt] en annan båts rad inom 500 m mellan hoppet och återgången; KANDIDAT', () => {
    const { fynd, ctx } = fall('w1907', SÅG);
    const mall = ctx.rader.find((r) => String(r.mmsi) === ULLA && r.aisTimestamp === HOPP);
    ctx.rader.push({
      ...mall, mmsi: JOLLY, aisTimestamp: ÅTER, fixTs: ÅTER,
    });
    ctx.rader = ctx.rader.filter((r) => !(String(r.mmsi) === JOLLY && r.aisTimestamp === ÅTER && r.lat !== mall.lat));
    ctx.rader.sort((x, y) => x.aisTimestamp - y.aisTimestamp);
    expect(p16(fynd, ctx).skäl).toMatch(/265182787:s rad 11:02:03.042 \(149 m från Klaffbron\).*återgången kan inte tillskrivas båten/);
    expect(klassa(reg, fynd, ctx).klass).toBe('KANDIDAT');
  });

  test('[vakt] fixen utanför 500 m, där den uttömda grenen inte sätter strax; KANDIDAT', () => {
    expect(pred({ straxRadieM: 400 })(...Object.values(fall('w1907', SÅG))).skäl).toMatch(/fixen ligger 452 m från bron \(> 400 m\)/);
  });

  test('[vakt] taket kunde inte läsas ur app.js: B4 blir falsk i stället för att gissa', () => {
    expect(pred({ uttömdTakMs: null })(...Object.values(fall('w1907', SÅG))).skäl).toMatch(/taket IMMINENT_EXHAUSTED_MAX_AGE_MS kunde inte läsas/);
    expect(PREDICATES.f40StudsVidNästaFix.parametrar.uttömdTakMs).toBe(90000);
  });
});
