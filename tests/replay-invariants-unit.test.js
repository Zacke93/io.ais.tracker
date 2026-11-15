'use strict';

/**
 * Enhetstester för REPLAY-INVARIANTERNA själva (helgranskningen 2026-07-06).
 *
 * Invarianterna är batteriets domare — men domarlogiken hade NOLL direkt
 * täckning: en tyst trasig invariant (som gamla Set-baserade INV-5, blind
 * för missad returpassage) ser ut som "allt grönt". Varje test här bygger
 * ett minimalt replay-result och asserterar att domaren dömer RÄTT åt båda
 * hållen (flaggar brottet / godkänner det legitima).
 *
 * Resultformatet speglar replayRunner:s utdata: notifications bär
 * { mmsi, bridge, direction, eta, success, t, name, distance, source },
 * targetPassages { mmsi, bridge, t, iso }, journeyResets { mmsi, t },
 * visitReentries { mmsi, bridge, t } för observerad återkomst till området,
 * bridgeTextTransitions { t, iso, text }, firstNameSeen { mmsi: ts }.
 */

const { validateInvariants, validateWarnInvariants } = require('./replay-validation/invariants');

const T0 = new Date('2026-07-06T10:00:00Z').getTime();

function notis(overrides = {}) {
  return {
    mmsi: '265000001',
    bridge: 'Klaffbron',
    direction: 'northbound',
    eta: 5,
    success: true,
    t: T0,
    name: 'TESTBÅT',
    distance: 250,
    source: 'target',
    ...overrides,
  };
}

function passage(overrides = {}) {
  const t = overrides.t || T0;
  return {
    mmsi: '265000001',
    bridge: 'Klaffbron',
    t,
    iso: new Date(t).toISOString(),
    ...overrides,
  };
}

function baseResult(overrides = {}) {
  return {
    bridgeTextTransitions: [],
    notifications: [],
    targetPassages: [],
    journeyResets: [],
    firstNameSeen: {},
    ...overrides,
  };
}

describe('Invariant-domaren: grundläge', () => {
  test('tomt result ger inga violations', () => {
    expect(validateInvariants(baseResult())).toEqual([]);
  });

  test('en passage med en notis i tid är ren', () => {
    const result = baseResult({
      notifications: [notis({ t: T0 - 30000 })], // proximity-notis före passagen
      targetPassages: [passage({ t: T0 })],
    });
    expect(validateInvariants(result)).toEqual([]);
  });
});

describe('Vänttextens grammatik och struktur', () => {
  const violationsFor = (text) => validateInvariants(baseResult({
    bridgeTextTransitions: [{ t: T0, iso: new Date(T0).toISOString(), text }],
  }));
  test.each([
    'En båt väntar vid Stridsbergsbron',
    'Två båtar väntar vid Järnvägsbron på väg mot Klaffbron',
    'En båt väntar vid Järnvägsbron på väg mot Stridsbergsbron; Två båtar på väg mot Stridsbergsbron, beräknad broöppning om 5 minuter',
  ])('accepterar faktiska grupper utan dubbelräkning: %s', (text) => {
    expect(violationsFor(text)).toEqual([]);
  });
  test.each([
    'En båt väntar vid Stridsbergsbron, beräknad broöppning om 3 minuter',
    'En båt väntar vid Okändbron',
    'En båt väntar vid Stridsbergsbron; Två båtar väntar vid Stridsbergsbron',
    'En båt väntar vid Stridsbergsbron; En båt väntar vid Klaffbron',
  ])('avvisar fel text eller dubblerad grupp: %s', (text) => {
    expect(violationsFor(text).length).toBeGreaterThan(0);
  });
  test('upptäcker att en bekräftad kö felaktigt försvinner till default', () => {
    const transitions = [
      'En båt väntar vid Järnvägsbron på väg mot Stridsbergsbron',
      'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron',
      'En båt väntar vid Järnvägsbron på väg mot Stridsbergsbron',
    ].map((text, i) => ({ text, t: T0 + i * 30000, iso: new Date(T0 + i * 30000).toISOString() }));
    expect(validateInvariants(baseResult({ bridgeTextTransitions: transitions }))
      .some((v) => v.startsWith('DEFAULT-FLASH'))).toBe(true);
  });
});

describe('INV-5 räkningsbaserad (harness-core#1): missad RETURPASSAGE syns', () => {
  test('2 passager + 1 notis på samma nyckel ⇒ MISSAD MÅLBRO-NOTIS', () => {
    const result = baseResult({
      notifications: [notis({ t: T0 - 30000 })],
      targetPassages: [
        passage({ t: T0 }),
        passage({ t: T0 + 20 * 60 * 1000 }), // returpassagen — onotifierad
      ],
    });
    const v = validateInvariants(result);
    expect(v.some((x) => x.includes('MISSAD MÅLBRO-NOTIS')
      && x.includes('2 registrerade passager men 1'))).toBe(true);
  });

  test('2 passager + 2 notiser (retur i motsatt riktning) är rent', () => {
    const p2t = T0 + 20 * 60 * 1000;
    const result = baseResult({
      notifications: [
        notis({ t: T0 - 30000, direction: 'northbound' }),
        notis({ t: p2t - 30000, direction: 'southbound' }), // motriktad retur — legitim utan reset
      ],
      targetPassages: [passage({ t: T0 }), passage({ t: p2t })],
    });
    expect(validateInvariants(result)).toEqual([]);
  });
});

describe('INV-7 prefix-timing (harness-core#1): första notisen kvitterar INTE returen', () => {
  test('returpassagens notis saknas i tidsfönstret ⇒ SEN MÅLBRO-NOTIS för passage nr 2', () => {
    const p2t = T0 + 20 * 60 * 1000;
    const result = baseResult({
      notifications: [
        notis({ t: T0 - 30000, direction: 'northbound' }),
        // Returnotisen kommer 5 min EFTER returpassagen (>60 s-fönstret).
        notis({ t: p2t + 5 * 60 * 1000, direction: 'southbound' }),
      ],
      targetPassages: [passage({ t: T0 }), passage({ t: p2t })],
    });
    const v = validateInvariants(result);
    expect(v.some((x) => x.includes('SEN MÅLBRO-NOTIS') && x.includes('passage nr 2'))).toBe(true);
    // INV-5 ska däremot INTE flagga — notisantalet stämmer.
    expect(v.some((x) => x.includes('MISSAD MÅLBRO-NOTIS'))).toBe(false);
  });
});

describe('INV-2 dubblettskydd med journey-reset-undantag', () => {
  test('två samriktade notiser utan reset ⇒ NOTIS-DUBBLETT', () => {
    const result = baseResult({
      notifications: [
        notis({ t: T0 }),
        notis({ t: T0 + 10 * 60 * 1000 }),
      ],
    });
    const v = validateInvariants(result);
    expect(v.some((x) => x.includes('NOTIS-DUBBLETT'))).toBe(true);
  });

  test('journey-reset mellan notiserna legitimerar den andra', () => {
    const result = baseResult({
      notifications: [
        notis({ t: T0 }),
        notis({ t: T0 + 10 * 60 * 1000 }),
      ],
      journeyResets: [{ mmsi: '265000001', t: T0 + 5 * 60 * 1000 }],
    });
    const v = validateInvariants(result);
    expect(v.some((x) => x.includes('NOTIS-DUBBLETT'))).toBe(false);
  });
});

describe('INV-2: observerad återkomst gäller bara nästa notis för samma fartyg och område', () => {
  const noticeTimes = [T0, T0 + 10 * 60000, T0 + 20 * 60000];
  const reentry = (t, extra = {}) => ({
    mmsi: '265000001', bridge: 'Klaffbron', t, ...extra,
  });

  test('tre samriktade notiser med två mellanliggande återkomster är tre legitima besök', () => {
    const result = baseResult({
      notifications: noticeTimes.map((t) => notis({ t })),
      visitReentries: [reentry(T0 + 5 * 60000), reentry(T0 + 15 * 60000)],
    });
    expect(validateInvariants(result)).toEqual([]);
  });

  test('återkomst och efterföljande notis får ha samma tidsstämpel', () => {
    const result = baseResult({
      notifications: noticeTimes.map((t) => notis({ t })),
      visitReentries: [reentry(noticeTimes[1]), reentry(noticeTimes[2])],
    });
    expect(validateInvariants(result)).toEqual([]);
  });

  test.each([
    ['annat fartyg', reentry(T0 + 5 * 60000, { mmsi: '265000002' })],
    ['annan bro', reentry(T0 + 5 * 60000, { bridge: 'Stridsbergsbron' })],
    ['före föregående notis', reentry(T0 - 1)],
    ['samtidigt med föregående notis', reentry(T0)],
    ['efter nästa notis', reentry(noticeTimes[1] + 1)],
    ['icke-finit tid', reentry(NaN)],
  ])('återkomst för %s legitimerar inte dubbletten', (label, event) => {
    const result = baseResult({
      notifications: noticeTimes.slice(0, 2).map((t) => notis({ t })),
      visitReentries: [event],
    });
    expect(validateInvariants(result)).toEqual([
      expect.stringContaining('NOTIS-DUBBLETT'),
    ]);
  });

  test.each([
    ['en återkomst', [reentry(T0 + 5 * 60000)]],
    ['två likadana vittnen', [reentry(T0 + 5 * 60000), reentry(T0 + 5 * 60000)]],
    ['återkomst på andra notisens tidsstämpel', [reentry(noticeTimes[1])]],
  ])('%s kan inte legitimera tre notiser', (label, visitReentries) => {
    const result = baseResult({
      notifications: noticeTimes.map((t) => notis({ t })),
      visitReentries,
    });
    expect(validateInvariants(result)).toEqual([
      expect.stringContaining('NOTIS-DUBBLETT'),
    ]);
  });
});

describe('INV-8 namnkvalitet (fatal sedan 2026-07-03)', () => {
  test('platshållarnamn i notis trots tidigare känt namn ⇒ INV-8 NAMN', () => {
    const result = baseResult({
      notifications: [notis({ name: 'Unknown', t: T0 })],
      firstNameSeen: { 265000001: T0 - 60 * 60 * 1000 },
    });
    const v = validateInvariants(result);
    expect(v.some((x) => x.includes('INV-8 NAMN'))).toBe(true);
  });

  test('platshållarnamn är OK när riktigt namn ALDRIG setts', () => {
    const result = baseResult({
      notifications: [notis({ name: 'Okänd båt', t: T0 })],
    });
    expect(validateInvariants(result)
      .some((x) => x.includes('INV-8'))).toBe(false);
  });
});

describe('INV-11 distansrimlighet (fatal sedan 2026-07-03)', () => {
  test('proximity-källa >400 m ⇒ INV-11 DISTANS (gps-hopp-notis-klassen)', () => {
    const result = baseResult({
      notifications: [notis({ distance: 550, source: 'target' })],
    });
    const v = validateInvariants(result);
    expect(v.some((x) => x.includes('INV-11 DISTANS') && x.includes('proximity-källa'))).toBe(true);
  });

  test('fallback-källa får vara sen (>400 m) men aldrig bortom 10 km', () => {
    const okResult = baseResult({
      notifications: [notis({ distance: 1800, source: 'passage-fallback' })],
    });
    expect(validateInvariants(okResult)
      .some((x) => x.includes('INV-11'))).toBe(false);

    const badResult = baseResult({
      notifications: [notis({ distance: 12000, source: 'passage-fallback' })],
    });
    expect(validateInvariants(badResult)
      .some((x) => x.includes('10 km-sanity'))).toBe(true);
  });
});

describe('INV-1 textgrammatik', () => {
  test('trasiga tokens i publicerad text ⇒ TRASIG TEXT', () => {
    const result = baseResult({
      bridgeTextTransitions: [{
        t: T0, iso: new Date(T0).toISOString(), text: 'En båt på väg mot undefined, beräknad broöppning strax',
      }],
    });
    const v = validateInvariants(result);
    expect(v.some((x) => x.includes('TRASIG TEXT'))).toBe(true);
  });

  test('legitima Variant-1-texter passerar (inkl. "ETA okänd")', () => {
    const texts = [
      'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron',
      'En båt på väg mot Klaffbron, beräknad broöppning strax',
      'Två båtar på väg mot Stridsbergsbron, beräknad broöppning om cirka 7 minuter',
      'En båt på väg mot Klaffbron, ETA okänd',
    ];
    const result = baseResult({
      bridgeTextTransitions: texts.map((text, i) => ({
        t: T0 + i * 60000, iso: new Date(T0 + i * 60000).toISOString(), text,
      })),
    });
    expect(validateInvariants(result)
      .filter((x) => x.includes('TRASIG TEXT') || x.includes('OKÄND KLAUSUL'))).toEqual([]);
  });
});

describe('Notistoken-validering (INV-2:s fältkontroll)', () => {
  test('ogiltig ETA, okänd bro och misslyckad notis flaggas var för sig', () => {
    const result = baseResult({
      notifications: [
        notis({ eta: 999 }),
        notis({ mmsi: '265000002', bridge: 'Hisingsbron' }),
        notis({ mmsi: '265000003', success: false }),
      ],
    });
    const v = validateInvariants(result);
    expect(v.some((x) => x.includes('ogiltig ETA'))).toBe(true);
    expect(v.some((x) => x.includes('okänd bro'))).toBe(true);
    expect(v.some((x) => x.includes('misslyckad'))).toBe(true);
  });
});

describe('INV-3/16 FP8-kalibreringen (2026-07-13, korpus 20260712-25h)', () => {
  const trans = (offsetS, text) => ({
    t: T0 + offsetS * 1000,
    iso: new Date(T0 + offsetS * 1000).toISOString(),
    text,
  });
  const klaff = (eta, approx = false) => `En båt på väg mot Klaffbron, beräknad broöppning om ${approx ? 'cirka ' : ''}${eta} minuter`;

  test('IDUN-klassen: cirka-X → färsk Y → X±1 är Fix G-rättelsen, INTE oscillation', () => {
    const result = baseResult({
      bridgeTextTransitions: [
        trans(0, klaff(7, true)), // extrapolerad "cirka 7"
        trans(27, klaff(10)), //     färsk rättelse UPP
        trans(207, klaff(6)), //     äkta nedräkning
      ],
    });
    expect(validateInvariants(result).filter((x) => x.includes('OSCILLATION'))).toEqual([]);
  });

  test('äkta oscillation (färsk→färsk→färsk, SOKERI-klassen) fälls som förut', () => {
    const result = baseResult({
      bridgeTextTransitions: [
        trans(0, klaff(7)),
        trans(27, klaff(10)),
        trans(207, klaff(6)),
      ],
    });
    expect(validateInvariants(result).some((x) => x.includes('OSCILLATION'))).toBe(true);
  });

  test('FP9 SEEBAER-klassen: färsk X → cirka-MELLANDIPP → färsk X±1 är Fix G-rättelsens spegel, INTE oscillation', () => {
    // Korpus 20260713-41h 08:52–08:54: "6 → cirka 2 → 5" — extrapolationen
    // dippade i 6-min-gapet och färska samplet (SEEBAER III:s notistick)
    // rättade tillbaka. Mellanvärdet är approx; ytterpunkterna färska.
    const result = baseResult({
      bridgeTextTransitions: [
        trans(0, klaff(6)),
        trans(60, klaff(2, true)), // extrapolerad dipp
        trans(81, klaff(5)), //       färsk rättelse
      ],
    });
    expect(validateInvariants(result).filter((x) => x.includes('OSCILLATION'))).toEqual([]);
  });

  test('FP9: cirka-mellanvärde följt av cirka-ytterpunkt undantas INTE (bara färsk rättelse kvalar)', () => {
    const result = baseResult({
      bridgeTextTransitions: [
        trans(0, klaff(6)),
        trans(60, klaff(2, true)),
        trans(81, klaff(5, true)), // fortfarande extrapolerad — ingen färsk rättelse
      ],
    });
    expect(validateInvariants(result).some((x) => x.includes('OSCILLATION'))).toBe(true);
  });

  test('ELFKUNGEN-klassen: hopp från SOFT-zonen (4→10) med STABIL ny nivå är exhausted-ledarbytet, inte sågtand', () => {
    const result = baseResult({
      bridgeTextTransitions: [
        trans(0, klaff(4)), //   hållet värde (ledarens sändare tyst)
        trans(79, klaff(10)), // exhausted → nästa båts äkta ETA
        trans(139, klaff(10)), // stabil ny nivå — ingen studs
      ],
    });
    expect(validateInvariants(result).filter((x) => x.includes('SÅGTAND'))).toEqual([]);
  });

  test('SOFT-zonshopp som STUDSAR tillbaka fälls (falsk degradering)', () => {
    const result = baseResult({
      bridgeTextTransitions: [
        trans(0, klaff(4)),
        trans(79, klaff(10)),
        trans(139, klaff(4)), // studs = flapp/falsk klass
      ],
    });
    expect(validateInvariants(result).some((x) => x.includes('SÅGTAND'))).toBe(true);
  });

  test('hopp i 6–20-bandet fälls ovillkorligt (F4-E/SOKERI-bandet orört)', () => {
    const result = baseResult({
      bridgeTextTransitions: [
        trans(0, klaff(8)),
        trans(79, klaff(15)),
        trans(139, klaff(15)),
      ],
    });
    expect(validateInvariants(result).some((x) => x.includes('SÅGTAND'))).toBe(true);
  });

  test('strax-hoppets ursprungliga diskriminator lever (fältprov 5-klassen)', () => {
    const straxText = 'En båt på väg mot Klaffbron, beräknad broöppning strax';
    const stable = baseResult({
      bridgeTextTransitions: [
        trans(0, straxText),
        trans(60, klaff(9)),
        trans(150, klaff(9)),
      ],
    });
    expect(validateInvariants(stable).filter((x) => x.includes('SÅGTAND'))).toEqual([]);
    const flapping = baseResult({
      bridgeTextTransitions: [
        trans(0, straxText),
        trans(60, klaff(9)),
        trans(110, straxText),
      ],
    });
    expect(validateInvariants(flapping).some((x) => x.includes('SÅGTAND'))).toBe(true);
  });
});

// ===========================================================================
// INV-3 LEDARBYTE (2026-11-15, buggjägarens kort F01, standardvärld 246)
// ===========================================================================
// YRSA (Y) visas med "om 7 minuter" mot Stridsbergsbron, ställer sig i kö vid
// Järnvägsbron (väntklausul utan minuter, rätt enligt textformatet) och
// TROLLA 2 (T) tar över klausulen med "om 14 minuter". Två olika båtars
// tider: ingen sågtand. replayRunner bokför vilken båt vars ETA klausulen
// visar och båtarnas kö (bridgeTextLeads).
describe('INV-3: ledarbyte när den förra båten bevisligen slutat bära klausulen', () => {
  const Y = '265188662';
  const T = '265188962';
  const t0 = Date.parse('2026-09-21T16:54:07.997Z');
  const på = (n) => `En båt på väg mot Stridsbergsbron, beräknad broöppning om ${n} minuter`;
  const kö = 'En båt väntar vid Järnvägsbron på väg mot Stridsbergsbron';
  const texter = [
    [0, på(7)],
    [30, kö],
    [85, `${kö}; ${på(14)}`],
    [145, `${kö}; ${på(13)}`],
  ];
  const tr = (s, text) => ({ t: t0 + s * 1000, iso: new Date(t0 + s * 1000).toISOString(), text });
  const leads = (s, text, lead, vessels) => ({
    t: t0 + s * 1000, text, leads: lead ? [{ bridge: 'Stridsbergsbron', mmsi: lead }] : [], vessels,
  });
  const yKö = { mmsi: Y, targetBridge: 'Stridsbergsbron', waitingAt: 'Järnvägsbron' };
  const yRör = { mmsi: Y, targetBridge: 'Stridsbergsbron', waitingAt: null };
  const tRör = { mmsi: T, targetBridge: 'Stridsbergsbron', waitingAt: null };
  const resultat = ({
    yVid85 = yKö, ledareVid85 = T, ledareVid0 = Y, utanUnderlag = false, text85 = texter[2][1], ...rest
  } = {}) => {
    const txt = texter.map(([s, x]) => [s, s === 85 ? text85 : x]);
    return baseResult({
      bridgeTextTransitions: txt.map(([s, x]) => tr(s, x)),
      bridgeTextLeads: utanUnderlag ? undefined : [
        leads(0, txt[0][1], ledareVid0, [yRör]),
        leads(30, txt[1][1], null, [yKö]),
        leads(85, txt[2][1], ledareVid85, [yVid85, tRör]),
        leads(145, txt[3][1], ledareVid85, [yVid85, tRör]),
      ],
      ...rest,
    });
  };
  const sågtand = (r) => validateInvariants(r).filter((x) => x.includes('SÅGTAND'));

  test('värld 246: Y i kö vid Järnvägsbron, T tar över med 14 min; ingen sågtand', () => {
    expect(sågtand(resultat())).toEqual([]);
  });

  test('utan underlaget (äldre resultat) döms 7 → 14 som förut', () => {
    expect(sågtand(resultat({ utanUnderlag: true }))).toHaveLength(1);
  });

  test('samma båt som går 7 → 14 fälls som förut', () => {
    expect(sågtand(resultat({ ledareVid85: Y }))).toHaveLength(1);
  });

  test('ledarbyte utan kö: den förra båten är fortfarande i rörelse mot bron; sågtand', () => {
    expect(sågtand(resultat({ yVid85: yRör }))).toHaveLength(1);
  });

  test('kön måste synas i texten: utan "väntar vid Järnvägsbron" i texten är det ingen förklaring', () => {
    expect(sågtand(resultat({ text85: `En båt väntar vid Klaffbron på väg mot Stridsbergsbron; ${på(14)}` }))).toHaveLength(1);
  });

  test('den förra båtens passage av bron mellan texterna förklarar bytet; utanför fönstret gör den det inte', () => {
    const p = (s) => ({
      t: t0 + s * 1000, iso: '', mmsi: Y, bridge: 'Stridsbergsbron',
    });
    expect(sågtand(resultat({ yVid85: yRör, targetPassages: [p(60)] }))).toEqual([]);
    expect(sågtand(resultat({ yVid85: yRör, targetPassages: [p(-10)] }))).toHaveLength(1);
    expect(sågtand(resultat({ yVid85: yRör, targetPassages: [p(100)] }))).toHaveLength(1);
    expect(sågtand(resultat({ yVid85: yRör, targetPassages: [{ ...p(60), mmsi: T }] }))).toHaveLength(1);
    expect(sågtand(resultat({ yVid85: yRör, targetPassages: [{ ...p(60), bridge: 'Klaffbron' }] }))).toHaveLength(1);
  });

  test('från "strax" är nivån inte den förra ledarens egen tid: ledarbytet förklarar inget', () => {
    // strax → 14 → strax inom 120 s är studsklassen; "strax" kan bäras av en
    // annan båts närhet, så ledarbytet får inte undanta den.
    const r = resultat();
    const strax = 'En båt på väg mot Stridsbergsbron, beräknad broöppning strax';
    r.bridgeTextTransitions[0].text = strax;
    r.bridgeTextLeads[0].text = strax;
    r.bridgeTextTransitions[3].text = `${kö}; ${strax}`;
    r.bridgeTextLeads[3].text = `${kö}; ${strax}`;
    expect(sågtand(r)).toHaveLength(1);
    // Samma studs med minuttid före (7 → 14 → 7) undantas av kön.
    const r2 = resultat();
    r2.bridgeTextTransitions[3].text = `${kö}; ${på(7)}`;
    r2.bridgeTextLeads[3].text = `${kö}; ${på(7)}`;
    expect(sågtand(r2)).toEqual([]);
  });

  test('kryphålet: två båtar vars ETA växelvis visas, utan kö eller passage, fälls', () => {
    const t1 = Date.parse('2026-09-21T10:00:00Z');
    const text = (n) => `Två båtar på väg mot Klaffbron, beräknad broöppning om ${n} minuter`;
    const steg = [[0, 5, 'A'], [30, 12, 'B'], [60, 5, 'A'], [90, 12, 'B']];
    const båtar = [{ mmsi: 'A', targetBridge: 'Klaffbron', waitingAt: null }, { mmsi: 'B', targetBridge: 'Klaffbron', waitingAt: null }];
    const r = baseResult({
      bridgeTextTransitions: steg.map(([s, n]) => ({ t: t1 + s * 1000, iso: new Date(t1 + s * 1000).toISOString(), text: text(n) })),
      bridgeTextLeads: steg.map(([s, n, m]) => ({
        t: t1 + s * 1000, text: text(n), leads: [{ bridge: 'Klaffbron', mmsi: m }], vessels: båtar,
      })),
    });
    const v = validateInvariants(r);
    expect(v.filter((x) => x.includes('SÅGTAND')).length).toBeGreaterThan(0);
    expect(v.some((x) => x.includes('OSCILLATION'))).toBe(true);
  });
});

// ===========================================================================
// INV-21 (etapp 6, 2026-08-03) — ÖPPNINGSVARNING EFTER PASSAGE
// ===========================================================================
// Öppningsvarningen ska FÖRVARNA. Går den ut efter att en av dess egna
// medlemmar redan registrerats som passerad varnar den för en öppning som
// redan skett — användaren står vid en bro som just stängt. Regeln är den
// oberoende kontrollen av öppningshändelsens egen spärr (event.lastPassageAt).
describe('INV-21 öppningsvarning efter passage (WARN)', () => {
  const opening = (tOffsetS, overrides = {}) => ({
    t: T0 + tOffsetS * 1000,
    iso: new Date(T0 + tOffsetS * 1000).toISOString(),
    bridge: 'Klaffbron',
    direction: 'northbound',
    etaMin: 5,
    vesselCount: 1,
    leadVessel: 'TESTBÅT',
    leadMmsi: '265000001',
    mmsis: ['265000001'],
    firedBy: 'deadline',
    eventId: 'Klaffbron#1',
    ...overrides,
  });

  test('varning FÖRE passagen ger inget utslag', () => {
    const result = baseResult({
      openingWarnings: [opening(-300)],
      targetPassages: [passage({ t: T0 })],
    });
    expect(validateWarnInvariants(result).filter((x) => x.includes('INV-21'))).toEqual([]);
  });

  test('varning EFTER passagen flaggas', () => {
    const result = baseResult({
      openingWarnings: [opening(210)],
      targetPassages: [passage({ t: T0 })],
    });
    const hits = validateWarnInvariants(result).filter((x) => x.includes('INV-21'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/Klaffbron/);
    expect(hits[0]).toMatch(/265000001/);
  });

  test('en passage från en TIDIGARE resa (>30 min bakåt) flaggar inte', () => {
    // Kanalens turbåtar gör samma resa varje dag. Utan fönstret gav regeln
    // 11 falska utslag över korpusarna och ett (1) äkta.
    const result = baseResult({
      openingWarnings: [opening(3 * 3600)],
      targetPassages: [passage({ t: T0 })],
    });
    expect(validateWarnInvariants(result).filter((x) => x.includes('INV-21'))).toEqual([]);
  });

  test('en ANNAN båts passage av samma bro flaggar inte', () => {
    const result = baseResult({
      openingWarnings: [opening(210)],
      targetPassages: [passage({ t: T0, mmsi: '265999999' })],
    });
    expect(validateWarnInvariants(result).filter((x) => x.includes('INV-21'))).toEqual([]);
  });

  test('en annan BRO:s passage flaggar inte', () => {
    const result = baseResult({
      openingWarnings: [opening(210)],
      targetPassages: [passage({ t: T0, bridge: 'Stridsbergsbron' })],
    });
    expect(validateWarnInvariants(result).filter((x) => x.includes('INV-21'))).toEqual([]);
  });

  test('utan öppningsdimension är regeln tyst (bakåtkompatibel)', () => {
    const result = baseResult({ targetPassages: [passage({ t: T0 })] });
    expect(validateWarnInvariants(result).filter((x) => x.includes('INV-21'))).toEqual([]);
  });
});

// ===========================================================================
// INV-22 (V2, fältprovet 2026-11-13) — FÖRVARNINGSFORM EFTER RÅDATANS PASSAGE
// ===========================================================================
// Replay av körning 2 gav PRICKBJORN 13:57:24 "närmar sig Järnvägsbron …
// strax" fast rådatan visar att hon passerat 13:56:16: fixen 13:56:38 låg
// 23 m söder om linjen, och notisen byggdes 46 s senare av en senare
// UI-cykel på samma fix. Replay gav 0 WARN. INV-22 jämför notisens form med
// rådatans linjekorsning (gt-passages): tTo är mottagningen av första fixen
// bortom linjen.
describe('INV-22 förvarningsform efter rådatans passage (WARN)', () => {
  const tFrom = Date.parse('2026-11-13T13:55:32.306Z'); // 333 m norr om Järnvägsbron
  const tTo = Date.parse('2026-11-13T13:56:38.445Z'); // 23 m söder om linjen
  const NORTH = { lat: 58.29401, lon: 12.29551 };
  const SOUTH = { lat: 58.29147, lon: 12.29179 };
  const crossing = (overrides = {}) => ({
    mmsi: '265012090',
    bridge: 'Järnvägsbron',
    kind: 'line',
    dir: 'syd',
    t: tTo - 6000,
    iso: new Date(tTo - 6000).toISOString(),
    tFrom,
    tTo,
    inferred: false,
    ...overrides,
  });
  const approach = (t, overrides = {}) => notis({
    mmsi: '265012090',
    bridge: 'Järnvägsbron',
    direction: 'southbound',
    eta: 0,
    t,
    distance: 23,
    source: 'current',
    message: 'PRICKBJORN närmar sig Järnvägsbron, beräknad ankomst strax',
    alreadyPassed: false,
    vesselLat: SOUTH.lat,
    vesselLon: SOUTH.lon,
    ...overrides,
  });
  const inv22 = (notifications, gt = [crossing()]) => validateWarnInvariants(
    baseResult({ notifications }), gt,
  ).filter((x) => x.startsWith('INV-22'));

  test('fältfallet: "närmar sig" 46 s efter första fixen bortom linjen flaggas', () => {
    const hits = inv22([approach(Date.parse('2026-11-13T13:57:24.700Z'))]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/265012090@Järnvägsbron/);
    expect(hits[0]).toMatch(/2026-11-13T13:57:24\.700Z/);
    expect(hits[0]).toMatch(/syd-passage/);
    expect(hits[0]).toMatch(/46 s före notisen/);
  });

  test('samma bearbetningscykel (≤ 1 s efter fixen bortom linjen) flaggas inte', () => {
    expect(inv22([approach(tTo)])).toEqual([]);
    expect(inv22([approach(tTo + 150)])).toEqual([]);
    expect(inv22([approach(tTo + 1001)])).toHaveLength(1);
  });

  test('AIS-latensklassen: notis på en fix FÖRE linjen går före tTo och flaggas aldrig', () => {
    // open3: AISHub-fixen är 21–28 s gammal; båten hann korsa innan notisen
    // gick, men rådatan visade ännu ingen passage när notisen byggdes.
    expect(inv22([approach(tFrom, { vesselLat: NORTH.lat, vesselLon: NORTH.lon, distance: 333 })])).toEqual([]);
    expect(inv22([approach(tTo - 1)])).toEqual([]);
  });

  test('en försenad fix före linjen som kommer efter fixen bortom linjen flaggas inte', () => {
    const late = approach(tTo + 20000, { vesselLat: NORTH.lat, vesselLon: NORTH.lon, distance: 333 });
    expect(inv22([late])).toEqual([]);
  });

  test('notis utan fryst position döms på tiden ensam', () => {
    const noPos = approach(tTo + 30000, { vesselLat: null, vesselLon: null });
    expect(inv22([noPos])).toHaveLength(1);
  });

  test('passerad form är det rätta svaret efter passagen och flaggas inte', () => {
    const passed = approach(tTo + 46000, {
      eta: -1, message: 'PRICKBJORN har precis passerat Järnvägsbron', alreadyPassed: true,
    });
    expect(inv22([passed])).toEqual([]);
  });

  test('väntformen ("inväntar broöppning vid") påstår också att bron ligger framför', () => {
    const waiting = approach(tTo + 60000, { eta: -1, message: 'PRICKBJORN inväntar broöppning vid Järnvägsbron' });
    const hits = inv22([waiting]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/inväntar broöppning/);
  });

  test('returresan: senaste korsningen åt andra hållet är en ny anflygning', () => {
    const back = crossing({
      dir: 'nord', t: tTo + 1200000, tFrom: tTo + 1190000, tTo: tTo + 1210000,
    });
    const returnTrip = approach(tTo + 1800000, { direction: 'northbound', vesselLat: SOUTH.lat, vesselLon: SOUTH.lon });
    expect(inv22([returnTrip], [crossing(), back])).toEqual([]);
    // Men en ny sydgående förvarning efter en nordgående korsning flaggas inte heller.
    expect(inv22([approach(tTo + 1800000, { vesselLat: NORTH.lat, vesselLon: NORTH.lon })], [crossing(), back])).toEqual([]);
  });

  // Rev 2 (2026-11-15, fältgranskningen F14): buggjägarens fem utslag var
  // förvarningar inför en returkorsning 28–150 s senare (värld 134 ULLA:
  // "närmar sig Järnvägsbron, om 3 minuter" med riktning söderut, 286 m söder
  // om bron, returkorsningen norrut 150 s efter notisen). Texten stämmer för
  // returen; bara token är den gamla eftersom vändningen ännu inte är trodd.
  describe('returkorsningen (rev 2)', () => {
    const tN = Date.parse('2026-11-13T13:57:24.700Z'); // notisen, 46 s efter tTo
    const back = (dt, overrides = {}) => crossing({
      dir: 'nord', t: tN + dt, iso: new Date(tN + dt).toISOString(), tFrom: tN + dt - 20000, tTo: tN + dt + 20000, ...overrides,
    });
    const notice = approach(tN, { message: 'ULLA närmar sig Järnvägsbron, beräknad ankomst om 3 minuter', eta: 3, distance: 286 });

    test('värld 134-mönstret: korsning åt andra hållet 150 s efter notisen flaggas inte', () => {
      expect(inv22([notice], [crossing(), back(150000)])).toEqual([]);
    });

    test('fönstret är 300 s från notisen till returkorsningen: 300 s undantas, 300,001 s flaggas', () => {
      expect(inv22([notice], [crossing(), back(300000)])).toEqual([]);
      expect(inv22([notice], [crossing(), back(300001)])).toHaveLength(1);
    });

    test('utan returkorsning, eller med returen 21 min senare, flaggas notisen som förut', () => {
      expect(inv22([notice], [crossing()])).toHaveLength(1);
      expect(inv22([notice], [crossing(), back(21 * 60000)])).toHaveLength(1);
    });

    test('returkorsningen räknas på korsningens tid t, även när fixen bortom linjen kommer senare', () => {
      // Glest sänd retur: korsningen 120 s efter notisen, första fixen bortom
      // linjen först 400 s efter. Det är korsningen som visar att texten stämde.
      expect(inv22([notice], [crossing(), back(120000, { tFrom: tN + 60000, tTo: tN + 400000 })])).toEqual([]);
    });

    test('bara en korsning av samma båt och bro åt andra hållet, efter passagen, undantar', () => {
      // Samma riktning igen (ingen retur): flaggas.
      expect(inv22([notice], [crossing(), back(150000, { dir: 'syd' })])).toHaveLength(1);
      // Annan båt eller annan bro: flaggas.
      expect(inv22([notice], [crossing(), back(150000, { mmsi: '265999999' })])).toHaveLength(1);
      expect(inv22([notice], [crossing(), back(150000, { bridge: 'Stridsbergsbron' })])).toHaveLength(1);
      // En nordgående korsning FÖRE passagen är ingen retur efter den: flaggas.
      const before = crossing({
        dir: 'nord', t: tFrom - 600000, iso: new Date(tFrom - 600000).toISOString(), tFrom: tFrom - 620000, tTo: tFrom - 590000,
      });
      expect(inv22([notice], [before, crossing()])).toHaveLength(1);
      // Ett zonbesök åt andra hållet är ingen linjekorsning: flaggas.
      expect(inv22([notice], [crossing(), back(150000, { kind: 'zone' })])).toHaveLength(1);
    });
  });

  test('okänd riktning, annan båt, annan bro, zonbesök eller saknat facit: ingen dom', () => {
    const t = tTo + 46000;
    expect(inv22([approach(t, { direction: 'unknown' })])).toEqual([]);
    expect(inv22([approach(t, { mmsi: '265999999' })])).toEqual([]);
    expect(inv22([approach(t, { bridge: 'Stridsbergsbron' })])).toEqual([]);
    expect(inv22([approach(t)], [crossing({ kind: 'zone' })])).toEqual([]);
    expect(validateWarnInvariants(baseResult({ notifications: [approach(t)] }), [])
      .filter((x) => x.startsWith('INV-22'))).toEqual([]);
  });

  // Rev 1 (granskningen 2026-11-14): i buggjägarens sanningsspår är tTo den
  // sanna korsningstiden och tObs mottagningen av första fixen bortom linjen.
  // Regeln dömer mot tObs, så samma cykel undantas där precis som i banken.
  test('sanningsspårets post: samma cykel som första observationen bortom linjen flaggas inte', () => {
    const tCross = tTo - 20000;
    const truth = crossing({
      t: tCross, tFrom: tCross, tTo: tCross, tObs: tTo, source: 'truth-L1',
    });
    expect(inv22([approach(tTo + 150)], [truth])).toEqual([]);
    expect(inv22([approach(tTo + 2000)], [truth])).toHaveLength(1);
    // Utan tObs (bankens facit) gäller tTo som förut.
    expect(inv22([approach(tCross + 2000)], [crossing({ t: tCross, tFrom: tCross, tTo: tCross })])).toHaveLength(1);
  });

  test('en korsning utan tidsfönster eller riktning används inte', () => {
    const t = tTo + 46000;
    expect(inv22([approach(t)], [crossing({ tTo: null })])).toEqual([]);
    expect(inv22([approach(t)], [crossing({ dir: null })])).toEqual([]);
  });
});
