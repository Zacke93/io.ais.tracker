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
 * bridgeTextTransitions { t, iso, text }, firstNameSeen { mmsi: ts }.
 */

const { validateInvariants } = require('./replay-validation/invariants');

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
