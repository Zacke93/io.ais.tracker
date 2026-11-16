'use strict';

/**
 * V1 (2026-11-16): oraklen lär sig besluten bakom nattjaktens kort, utan att
 * bli blinda för de äkta felen. Varje uppmjukning har [träff] (kortet känns
 * igen) och [vakt] (det äkta fel som oraklet finns för fälls fortfarande),
 * byggda ur samma världar (fixtures/natt-v1-2026-11-16.json, se nattV1.js)
 * eller ur små konstruerade fall. Inga barnprocesser och inga timers.
 */

const { validateInvariants } = require('../../invariants');
const konvoj = require('../lib/konvoj');
const gates = require('../../runOpeningGates');
const {
  F, kopia, döm, sammanfattning, utslag,
} = require('./nattV1');

const MIN = 60000;
const iso = (s) => Date.parse(s);
const res = (id) => kopia(F[id].utfall.resultat);

// ---------------------------------------------------------------------------
// INV-3: bärarbyte efter bekräftad vändning
// ---------------------------------------------------------------------------

describe('INV-3: ny bärare efter den förra bärarens bekräftade vändning (F01, F05)', () => {
  const sågtand = (r) => validateInvariants(r).filter((v) => /^ETA-SÅGTAND UPP/.test(v));
  const osc = (r) => validateInvariants(r).filter((v) => /^ETA-OSCILLATION/.test(v));

  test('[träff] F01 r2 (BRISEN "om 6" vänder, JOLLY "om 12") och F05 r1 (9 → 35): ingen sågtand', () => {
    expect(sågtand(res('F01-r2'))).toEqual([]);
    expect(sågtand(res('F05-r1'))).toEqual([]);
  });

  test('[vakt] utan journeyReset för den förra bäraren är det sågtand som förut', () => {
    const r = res('F01-r2');
    r.journeyResets = r.journeyResets.filter((x) => x.mmsi !== '265447235');
    expect(sågtand(r)).toEqual([expect.stringMatching(/Klaffbron 6→12 på 75s/)]);
  });

  test('[vakt] reset men den förra bäraren bär fortfarande målbron i nya texten: sågtand', () => {
    const r = res('F01-r2');
    const t = iso('2026-09-13T10:19:58.414Z');
    for (const x of r.bridgeTextLeads.filter((y) => y.t === t)) {
      x.vessels = x.vessels.map((v) => (v.mmsi === '265447235' ? { ...v, targetBridge: 'Klaffbron' } : v));
    }
    expect(sågtand(r)).toHaveLength(1);
  });

  test('[vakt] spiken på nya nivån (12 följt av 5 inom 120 s för samma båt) fälls (M1)', () => {
    const r = res('F01-r2');
    const t = iso('2026-09-13T10:20:58.000Z');
    const spik = { t, iso: new Date(t).toISOString(), text: 'En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter; En båt på väg mot Stridsbergsbron, beräknad broöppning om 4 minuter' };
    const i = r.bridgeTextTransitions.findIndex((x) => x.t > t);
    r.bridgeTextTransitions.splice(i, 0, spik);
    r.bridgeTextLeads.push({
      t, text: spik.text, leads: [{ bridge: 'Klaffbron', mmsi: '265447211' }, { bridge: 'Stridsbergsbron', mmsi: '265447235' }], vessels: [],
    });
    expect(sågtand(r)).toEqual([expect.stringMatching(/Klaffbron 6→12/)]);
  });

  test('[träff] F05 r2 "13→17→12": X′ är en annan båts tid efter vändningen; [vakt] utan reset fälls oscillationen', () => {
    expect(osc(res('F05-r2'))).toEqual([]);
    const r = res('F05-r2');
    r.journeyResets = r.journeyResets.filter((x) => x.mmsi !== '265964392');
    expect(osc(r)).toEqual([expect.stringMatching(/13→17→12/)]);
  });
});

// ---------------------------------------------------------------------------
// INV-14: samma bärare
// ---------------------------------------------------------------------------

describe('INV-14: "Inga båtar" mellan två texter om olika båtar är ingen dold båt (F05 r1/r2)', () => {
  const flash = (r) => validateInvariants(r).filter((v) => /^DEFAULT-FLASH/.test(v));

  test('[träff] F05 r1 (VEGA vänder, ALVA) och r2 (392 vänder, 625)', () => {
    expect(flash(res('F05-r1'))).toEqual([]);
    expect(flash(res('F05-r2'))).toEqual([]);
  });

  test('[vakt] samma båt på båda sidor (den dolda båten kommer tillbaka) fälls', () => {
    const r = res('F05-r1');
    const efter = iso('2026-07-30T16:35:46.580Z');
    for (const x of r.bridgeTextLeads.filter((y) => y.t === efter)) {
      x.vessels = [...x.vessels, { mmsi: '265793460', targetBridge: 'Klaffbron', waitingAt: null }];
    }
    expect(flash(r)).toEqual([expect.stringMatching(/"Inga båtar" inklämd \(30s\)/)]);
  });

  test('[vakt] utan bärarunderlag (äldre resultat) dömer regeln som förut', () => {
    const r = res('F05-r1');
    delete r.bridgeTextLeads;
    expect(flash(r)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// INV-11 och INV-7 mot U21
// ---------------------------------------------------------------------------

describe('INV-11 och INV-7: returpassagesläppet prövas mot U21:s 10 min (F08, F15)', () => {
  const inv = (r, re) => validateInvariants(r).filter((v) => re.test(v));

  test('[träff] F08 r1 (Järnvägsbron 531 m) och F15 (Klaffbron 1 243 m, 7 min efter korsningen)', () => {
    expect(inv(res('F08-r1'), /^INV-11/)).toEqual([]);
    expect(inv(res('F15-r1'), /^INV-11|^SEN MÅLBRO-NOTIS/)).toEqual([]);
  });

  test('[vakt] samma notiser utan returpassagesläpp fälls av INV-11 och INV-7', () => {
    const r = res('F15-r1');
    r.visitReturnReleases = [];
    expect(inv(r, /^INV-11 DISTANS: 265181647@Klaffbron @1243m/)).toHaveLength(1);
    expect(inv(r, /^SEN MÅLBRO-NOTIS: .* 265181647:Klaffbron/)).toHaveLength(1);
  });

  test('[vakt] ett släpp mer än 10 min efter korsningen, eller med domen bortre, fälls', () => {
    const r = res('F15-r1');
    r.visitReturnReleases = r.visitReturnReleases.map((x) => ({ ...x, crossedAt: x.crossedAt - 4 * MIN }));
    expect(inv(r, /^INV-11 DISTANS/)).toHaveLength(1);
    const r2 = res('F08-r1');
    r2.visitReturnReleases = r2.visitReturnReleases.map((x) => ({ ...x, verdict: 'bortre' }));
    expect(inv(r2, /^INV-11 DISTANS: 265884859@Järnvägsbron/)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Konvojsemantiken: senaste bindningen och U15 (den fysiska öppningen togs
// bort efter granskningen, se t-v1-granskning.test.js)
// ---------------------------------------------------------------------------

describe('konvoj: senaste bindningen och U15 (a)–(c)', () => {
  const T = Date.UTC(2026, 6, 1, 10, 0, 0);
  const w1 = {
    eventId: 'K#1', bridge: 'Klaffbron', t: T, mmsis: ['265000001'], leadMmsi: '265000001', etaMin: 8,
  };
  const w2 = {
    eventId: 'K#2', bridge: 'Klaffbron', t: T + 5 * MIN, mmsis: ['265000002'], leadMmsi: '265000002', etaMin: 6,
  };
  const cov = [
    {
      eventId: 'K#1', mmsi: '265000002', bridge: 'Klaffbron', reason: 'absorbed', t: T + 2 * MIN,
    },
    {
      eventId: 'K#2', mmsi: '265000002', bridge: 'Klaffbron', reason: 'fired', t: T + 5 * MIN,
    },
  ];

  test('[träff] täcktAv: en senare egen varning vid samma bro avslutar bindningen (F23 r1); [vakt] före den, och i samma utvärdering, står den', () => {
    expect(konvoj.täcktAv(w1, '265000002', cov, T + 4 * MIN).sant).toBe(true);
    expect(konvoj.täcktAv(w1, '265000002', cov, T + 6 * MIN)).toMatchObject({ sant: false, avslutad: { eventId: 'K#2' } });
    const sammaTid = [cov[0], { ...cov[1], t: T + 2 * MIN }];
    expect(konvoj.täcktAv(w1, '265000002', sammaTid, T + 6 * MIN).sant).toBe(true);
    // En rad vid en annan bro avslutar inget.
    expect(konvoj.täcktAv(w1, '265000002', [cov[0], { ...cov[1], bridge: 'Stridsbergsbron' }], T + 6 * MIN).sant).toBe(true);
  });

  test('U15: (a) täckt vid passagen, (b) referensen inom fönstret, (c) varningen före passagen utan referens; en senare öppning beskriver inte', () => {
    const X = '265000009';
    const k = (mmsi, min) => ({ mmsi, bridge: 'Klaffbron', t: T + min * MIN });
    const covX = [{
      eventId: 'K#1', mmsi: X, bridge: 'Klaffbron', reason: 'absorbed', t: T + MIN,
    }];
    // (a): X korsade 4 min, täckt av K#1.
    expect(konvoj.beskriverPasseradÖppning(w1, { mmsi: X, bro: 'Klaffbron', tc: T + 20 * MIN }, [k(X, 4)], covX)).toMatchObject({ villkor: '(a)' });
    // (b): ej täckt, prognosen T + 8 min, 4 min från hennes passage.
    expect(konvoj.beskriverPasseradÖppning(w1, { mmsi: X, bro: 'Klaffbron', tc: T + 20 * MIN }, [k(X, 4)], [])).toMatchObject({ villkor: '(b)' });
    // En senare öppning: prognosen 11 min efter hennes passage.
    const sen = { ...w1, etaMin: 15 };
    expect(konvoj.beskriverPasseradÖppning(sen, { mmsi: X, bro: 'Klaffbron', tc: T + 20 * MIN }, [k(X, 4)], [])).toBeNull();
    // (c): ingen referens och varningen före passagen.
    const utan = { ...w1, etaMin: null };
    expect(konvoj.beskriverPasseradÖppning(utan, { mmsi: X, bro: 'Klaffbron', tc: T + 20 * MIN }, [k(X, 4)], [])).toMatchObject({ villkor: '(c)' });
    // Returens egen händelse (avfyrad efter passagen med henne som medlem) beskriver inte.
    const egen = {
      eventId: 'K#3', bridge: 'Klaffbron', t: T + 6 * MIN, mmsis: [X], leadMmsi: X, etaMin: 1,
    };
    expect(konvoj.beskriverPasseradÖppning(egen, { mmsi: X, bro: 'Klaffbron', tc: T + 8 * MIN }, [k(X, 4)], [])).toBeNull();
  });

  test('[vakt] de äkta felen F02 r3 och F23 r2 (fönstret ankrat i fel passage) står kvar som KANDIDAT', () => {
    expect(sammanfattning(döm('F02-r3').fynd)).toEqual([['T2 ÖPPNING-MISS:OKLASSAD', 'KANDIDAT', null]]);
    expect(sammanfattning(döm('F23-r2').fynd)).toEqual([['T2 ÖPPNING-MISS:OKLASSAD', 'KANDIDAT', null]]);
  });

  test('[träff] F23 r1 (senaste bindningen) och F23 r3 (U15 b: referensen 609 s från passagen) är U2-VS-DEADLINE', () => {
    expect(sammanfattning(döm('F23-r1').fynd)).toEqual([['T2 ÖPPNING-MISS:OKLASSAD', 'KÄND_ÖPPEN', 'U2-VS-DEADLINE']]);
    expect(utslag(döm('F23-r3').fynd, /^T2/).register).toMatchObject({ klass: 'KÄND_ÖPPEN', post: 'U2-VS-DEADLINE' });
  });
});

// ---------------------------------------------------------------------------
// T3: bakåtblicken till täckningsslutet, frusen fix och KAJVOBBEL
// ---------------------------------------------------------------------------

describe('T3: U17-släppet efter passagen, frusen fix och KAJVOBBEL', () => {
  test('[träff] F07 r2 och F24 r3: varningen 13 respektive 13 min efter passagen är VARNING-EFTER-SANN-PASSAGE och U17', () => {
    expect(sammanfattning(döm('F07-r2').fynd)).toEqual([['T3 VARNING-EFTER-SANN-PASSAGE', 'DESIGN', 'U17-TYST-BÅT-RECOVER']]);
    const f24 = döm('F24-r3').fynd;
    expect(utslag(f24, /VARNING-EFTER-SANN-PASSAGE/).register.post).toBe('U17-TYST-BÅT-RECOVER');
    expect(utslag(f24, /VARNING-EFTER-SANN-PASSAGE/).belägg.bakåtblick).toBe('täckningsslut');
  });

  test('[vakt] utan täckande händelse vid korsningen är en varning 13 min efter passagen FANTOM-UTAN-AVBROTT', () => {
    const { fynd } = döm('F07-r2', {
      mutera: (r) => {
        r.openingCoverage = r.openingCoverage.filter((c) => !(c.mmsi === '265852684' && c.eventId === 'Klaffbron#2'));
      },
    });
    expect(utslag(fynd, /^T3 FANTOM-UTAN-AVBROTT/).register.klass).toBe('KANDIDAT');
  });

  test('[vakt] en varning mer än en tick efter händelsens fönsterslut fälls som fantom', () => {
    const { fynd } = döm('F07-r2', {
      mutera: (r) => {
        for (const v of r.openingCoverageVerdicts) if (v.event && v.event.id === 'Klaffbron#2' && v.event.firstPassageRegisteredAt) v.event.firstPassageRegisteredAt -= 3 * MIN;
      },
    });
    expect(utslag(fynd, /^T3 FANTOM-UTAN-AVBROTT/)).toBeDefined();
  });

  test('[träff] F11 r1: en köande båt varnad på 20 min gammal fix som korsar 620 s senare ger inget utslag', () => {
    expect(sammanfattning(döm('F11-r1').fynd)).toEqual([]);
  });

  test('[vakt] samma varning när båten korsar först efter 20 min, eller inom 60 s, fälls', () => {
    const flytta = (dt) => döm('F11-r1', {
      mutera: (r, b) => {
        const w = r.openingWarnings.find((x) => x.eventId === 'Stridsbergsbron#6');
        for (const c of b.truth.L0.crossings) if (c.mmsi === '265011954' && c.bridge === 'Stridsbergsbron' && c.t > w.t) c.t = w.t + dt;
      },
    }).fynd;
    expect(utslag(flytta(21 * MIN), /VARNING-PÅ-FRUSET-FIX/).register.klass).toBe('KANDIDAT');
    expect(utslag(flytta(30000), /VARNING-PÅ-FRUSET-FIX/).register.klass).toBe('KANDIDAT');
  });

  test('[träff] F19: varningen för en köande båt (L0: kö, sedan vändning) är ingen KAJVOBBEL', () => {
    expect(utslag(döm('F19-r1').fynd, /KAJVOBBEL/)).toBeUndefined();
  });

  test('[vakt] samma båt förtöjd enligt L0, eller i kö utan korsning och vändning: FANTOM:KAJVOBBEL', () => {
    const förtöjd = döm('F19-r1', {
      mutera: (r, b) => {
        for (const s of b.truth.L0.stops) s.kind = 'moor';
      },
    }).fynd;
    expect(utslag(förtöjd, /KAJVOBBEL/).register.klass).toBe('KANDIDAT');
    const ingen = döm('F19-r1', {
      mutera: (r, b) => {
        b.truth.L0.uturns.length = 0;
        b.truth.L0.crossings = b.truth.L0.crossings.filter((c) => !(c.mmsi === '265012524' && c.bridge === 'Klaffbron'));
      },
    }).fynd;
    expect(utslag(ingen, /KAJVOBBEL/)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// classifyMiss: stilla i kö, avgången osedd (U38)
// ---------------------------------------------------------------------------

describe('classifyMiss: STILLA_KÖ_AVGÅNG_OSEDD (F02 r1, U38)', () => {
  const samples = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!Number.isFinite(r.lat)) continue;
      if (!m.has(String(r.mmsi))) m.set(String(r.mmsi), []);
      m.get(String(r.mmsi)).push(r);
    }
    return m;
  };
  const passage = {
    t: iso('2026-07-02T13:39:04Z'), mmsi: '265544386', bridge: 'Stridsbergsbron', dir: 'nord', inferred: false,
  };

  test('[träff] VEGA stilla i kö 195 m före Järnvägsbron i 31 min, avgår i avbrottet: accepterad', () => {
    const { built } = require('./nattV1').bygg('F02-r1');
    expect(gates.classifyMiss(passage, samples(built.rows), null)).toMatchObject({ klass: 'STILLA_KÖ_AVGÅNG_OSEDD', accepted: true });
    expect(sammanfattning(döm('F02-r1').fynd)).toEqual([['T3 VARNING-EFTER-SANN-PASSAGE', 'ACCEPTERAD', 'O1-ACCEPTERADE-MISSKLASSER']]);
  });

  test('[vakt] en passage efter reserven + full ledtid, eller en sista fix i rörelse, är OKLASSAD', () => {
    const { built } = require('./nattV1').bygg('F02-r1');
    const sista = built.rows.filter((r) => r.mmsi === passage.mmsi && r.aisTimestamp <= passage.t).pop();
    const sen = { ...passage, t: sista.aisTimestamp + 5 * MIN + 3.6 * MIN };
    expect(gates.classifyMiss(sen, samples(built.rows), null).klass).toBe('OKLASSAD');
    const rader = built.rows.map((r) => (r === sista ? { ...r, sog: 3.5 } : r));
    expect(gates.classifyMiss(passage, samples(rader), null).klass).not.toBe('STILLA_KÖ_AVGÅNG_OSEDD');
  });

  test('[vakt] en reserv som kom senare än sista fixen + 5 min + en tick är KANDIDAT (spärren höll för länge)', () => {
    const { fynd } = döm('F02-r1', {
      mutera: (r) => {
        for (const w of r.openingWarnings.filter((x) => x.eventId === 'Stridsbergsbron#3')) w.t += 2 * MIN;
      },
    });
    const f = utslag(fynd, /VARNING-EFTER-SANN-PASSAGE/);
    expect(f.register.klass).toBe('KANDIDAT');
    expect(f.register.prövade.find((x) => x.post === 'O1-ACCEPTERADE-MISSKLASSER').skäl).toMatch(/spärren höll för länge/);
  });
});

// ---------------------------------------------------------------------------
// De äkta felen ur triagen står kvar
// ---------------------------------------------------------------------------

describe('de äkta felen ur nattens triage är fortfarande kandidater', () => {
  test.each([
    ['F02-r3', 'T2 ÖPPNING-MISS:OKLASSAD'],
    ['F23-r2', 'T2 ÖPPNING-MISS:OKLASSAD'],
    ['F04-r1', 'T2 LEDTID<60s'],
    ['F12-r1', 'T9 FEL-RIKTNING'],
    ['F12-r2', 'T9 FEL-RIKTNING'],
    ['F10-r3', 'T1 NOTIS-UTEBLIVEN'],
  ])('%s: %s är KANDIDAT', (id, klass) => {
    const f = döm(id).fynd.find((x) => `${x.orakel} ${x.klass}` === klass);
    expect(f.register.klass).toBe('KANDIDAT');
  });
});
