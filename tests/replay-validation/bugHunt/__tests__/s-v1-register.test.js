'use strict';

/**
 * V1 (2026-11-16): registerposterna för nattjaktens kort. Nya poster för
 * dirigentens beslut U34 och U39 (på ägarens uppdrag) och U21, och vidgade
 * predikat inom U1-C11, U6 (MÄTGRÄNS-INV10-VÄNTKEDJA), U17, U18, U19 och
 * S10 (U25:s och R2:s vidgningar togs bort efter granskningen). Varje ändring har [träff] ur nattens representant och [vakt]:
 * samma värld med det som skiljer beslutet från ett äkta fel ändrat, som
 * ska förbli KANDIDAT. Fixturen: fixtures/natt-v1-2026-11-16.json (nattV1.js).
 * Inga barnprocesser och inga timers.
 */

const { döm, register, utslag } = require('./nattV1');

const MIN = 60000;
const kopia = (x) => JSON.parse(JSON.stringify(x));
const klassa = (f, ctx) => register().classify(f, ctx, { räkna: false });
/** Fyndet och kontexten för klassen i fallet. */
const fall = (id, re, opts) => {
  const d = döm(id, opts);
  const f = utslag(d.fynd, re);
  if (!f) throw new Error(`${id}: inget utslag ${re}`);
  return { f, ctx: d.kontext };
};
const post = (f, ctx) => {
  const c = klassa(f, ctx);
  return [c.klass, c.post || null];
};

describe('LEDARBYTE-TYST-FRÄMSTA (U34): texten när den främsta båten tystnat', () => {
  test.each(['F20-r1', 'F21-r3'])('[träff] %s', (id) => {
    const { f, ctx } = fall(id, /^INV-F INV-3/);
    expect(post(f, ctx)).toEqual(['ACCEPTERAD', 'LEDARBYTE-TYST-FRÄMSTA']);
  });

  test('[vakt] F21 r1: hoppet från "strax" (U16:s studs) förklaras inte', () => {
    const { f, ctx } = fall('F21-r1', /^INV-F INV-3 ETA-SÅGTAND UPP/);
    expect(post(f, ctx)).toEqual(['KANDIDAT', null]);
  });

  test('[vakt] en färsk rad för den förra bäraren strax före hoppet: hennes tid var giltig, ledarvalet förklaras inte', () => {
    const { f, ctx } = fall('F20-r1', /^INV-F INV-3/);
    const c = kopia(ctx);
    const L1 = '265716121';
    const sista = c.rader.filter((r) => r.mmsi === L1 && r.aisTimestamp < f.t).pop();
    c.rader.push({ ...sista, aisTimestamp: f.t - 20000, fixTs: f.t - 20000 });
    c.rader.sort((a, b) => a.aisTimestamp - b.aisTimestamp);
    expect(post(f, c)).toEqual(['KANDIDAT', null]);
  });

  test('[vakt] en bekräftad vändning för den förra bäraren före hoppet: U18:s fall, inte U34', () => {
    const { f, ctx } = fall('F20-r1', /^INV-F INV-3/);
    const c = kopia(ctx);
    c.resultat.journeyResets.push({ t: f.t - 5000, mmsi: '265716121' });
    expect(post(f, c)).toEqual(['KANDIDAT', null]);
  });
});

describe('U21-RETUR-EFTER-10-MIN och U39-RETUR-EFTER-RADERING (INV-5)', () => {
  test('[träff] F14 r2: den bevisande fixen kom 752 s efter returkorsningen', () => {
    const { f, ctx } = fall('F14-r2', /^INV-F INV-5/);
    expect(post(f, ctx)).toEqual(['DESIGN', 'U21-RETUR-EFTER-10-MIN']);
  });

  test('[vakt] samma retur med en fix 5 min efter korsningen: returnotisen skulle ha släppts; KANDIDAT', () => {
    const { f, ctx } = fall('F14-r2', /^INV-F INV-5/);
    const c = kopia(ctx);
    const kors = c.sanning.crossings.filter((x) => String(x.mmsi) === String(f.mmsi) && x.bridge === f.bro).pop();
    const efter = c.rader.find((r) => r.mmsi === String(f.mmsi) && r.aisTimestamp > kors.t);
    c.rader.push({ ...efter, aisTimestamp: kors.t + 5 * MIN, fixTs: kors.t + 5 * MIN });
    c.rader.sort((a, b) => a.aisTimestamp - b.aisTimestamp);
    expect(post(f, c)).toEqual(['KANDIDAT', null]);
  });

  test('[träff] F14 r1: raderad efter nordpassagen, returen stoppad av 60-minutersregeln (U39)', () => {
    const { f, ctx } = fall('F14-r1', /^INV-F INV-5/);
    expect(post(f, ctx)).toEqual(['ACCEPTERAD', 'U39-RETUR-EFTER-RADERING']);
  });

  test('[vakt] utan radering (eller utan spärren) är den uteblivna notisen ett fel; KANDIDAT', () => {
    const { f, ctx } = fall('F14-r1', /^INV-F INV-5/);
    const c1 = kopia(ctx);
    c1.resultat.vesselRemovals = [];
    expect(post(f, c1)).toEqual(['KANDIDAT', null]);
    const c2 = kopia(ctx);
    c2.resultat.persistentDedupBlocks = [];
    expect(post(f, c2)).toEqual(['KANDIDAT', null]);
  });
});

describe('vidgade predikat inom fattade beslut', () => {
  test('[träff] U1-C11 (F05 r3): en stilla köares kurs räknas inte; [vakt] senaste rad i rörelse med kurs bort från bron', () => {
    const { f, ctx } = fall('F05-r3', /^INV-F INV-14/);
    expect(post(f, ctx)).toEqual(['DESIGN', 'U1-C11-TYST-FÖRE-DEFAULT']);
    const c = kopia(ctx);
    for (const r of c.rader) if (r.mmsi === '265390636' && Number.isFinite(r.sog) && r.sog >= 0.5) r.cog = (r.cog + 180) % 360;
    expect(post(f, c)[0]).toBe('KANDIDAT');
  });

  test('[träff] MÄTGRÄNS-INV10-VÄNTKEDJA (F18): stillheten började 475 s före bekräftelsen; [vakt] i rörelse fram till bekräftelsen', () => {
    const { f, ctx } = fall('F18-r1', /^INV-F INV-10/);
    expect(post(f, ctx)).toEqual(['MÄTGRÄNS', 'MÄTGRÄNS-INV10-VÄNTKEDJA']);
    const c = kopia(ctx);
    const { från } = f.belägg.väntan.intervall[0];
    for (const r of c.rader) if (r.mmsi === '265779755' && r.aisTimestamp < från - 1000) r.sog = 3.5;
    expect(post(f, c)).toEqual(['KANDIDAT', null]);
  });

  test('[träff] U17 (F25 r2): släppet ur den förra händelsen i samma utvärdering som absorptionen; [vakt] en bakkant i E själv', () => {
    const { f, ctx } = fall('F25-r2', /^T3 VARNING-EFTER-SANN-PASSAGE/);
    expect(post(f, ctx)).toEqual(['DESIGN', 'U17-TYST-BÅT-RECOVER']);
    const c = kopia(ctx);
    const v = c.resultat.openingCoverageVerdicts.find((x) => x.mmsi === '265431439' && x.verdict.kind === 'bakkant');
    v.eventId = 'Stridsbergsbron#2';
    expect(post(f, c)[0]).toBe('KANDIDAT');
  });

  test('[träff] U18 (F12 r3): notisen under Fix D:s debounce; [vakt] F12 r1/r2 utan målbro, och en andra omvänd fix före notisen', () => {
    const { f, ctx } = fall('F12-r3', /^T9 FEL-RIKTNING/);
    expect(post(f, ctx)).toEqual(['DESIGN', 'U18-RETUR-BEKRÄFTAD-SENT']);
    for (const id of ['F12-r1', 'F12-r2']) {
      const x = fall(id, /^T9 FEL-RIKTNING/);
      expect([id, post(x.f, x.ctx)[0]]).toEqual([id, 'KANDIDAT']);
    }
    const c = kopia(ctx);
    const omvända = c.rader.filter((r) => r.mmsi === String(f.mmsi) && r.aisTimestamp < f.t && Number.isFinite(r.sog) && r.sog >= 2
      && (r.cog >= 315 || r.cog <= 45));
    const r0 = omvända.pop();
    c.rader.push({ ...r0, aisTimestamp: r0.aisTimestamp + 30000, fixTs: r0.aisTimestamp + 30000 });
    c.rader.sort((a, b) => a.aisTimestamp - b.aisTimestamp);
    expect(post(f, c)[0]).toBe('KANDIDAT');
  });

  test('[träff] U19 (F07 r1): radion tystnade före bekräftelsen; [vakt] en rad efter flaggan som kunde ha bekräftat', () => {
    const { f, ctx } = fall('F07-r1', /^T3 FANTOM-UTAN-AVBROTT/);
    expect(post(f, ctx)).toEqual(['ACCEPTERAD', 'U19-VARNING-UNDER-VÄNTANDE-VÄNDNING']);
    const c = kopia(ctx);
    const w = c.resultat.openingWarnings.find((x) => x.eventId === f.belägg.varning.eventId);
    const sista = c.rader.filter((r) => r.mmsi === String(w.leadMmsi) && r.aisTimestamp <= w.t).pop();
    c.rader.push({
      ...sista, aisTimestamp: w.t + 2 * MIN, fixTs: w.t + 2 * MIN, sog: 4, cog: 30,
    });
    c.rader.sort((a, b) => a.aisTimestamp - b.aisTimestamp);
    expect(post(f, c)[0]).toBe('KANDIDAT');
  });

  test('[träff] S10 (F10 r1): fram och tillbaka i samma glapp; [vakt] F10 r3 och en udda korsning i glappet', () => {
    const { f, ctx } = fall('F10-r1', /^T1 NOTIS-UTEBLIVEN/);
    expect(post(f, ctx)).toEqual(['DESIGN', 'S10-VÄNDNING-BRON-BAKOM']);
    const x = fall('F10-r3', /^T1 NOTIS-UTEBLIVEN/);
    expect(post(x.f, x.ctx)[0]).toBe('KANDIDAT');
    const c = kopia(ctx);
    const egna = c.sanning.crossings.filter((k) => String(k.mmsi) === String(f.mmsi) && k.bridge === f.bro);
    // Bara utpassagen i glappet, ingen korsning tillbaka: båten ligger på andra sidan.
    const sista = egna[egna.length - 1].t;
    c.sanning.crossings = c.sanning.crossings.filter((k) => !(String(k.mmsi) === String(f.mmsi) && k.bridge === f.bro && k.t === sista));
    expect(post(f, c)[0]).toBe('KANDIDAT');
  });
});
