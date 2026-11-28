'use strict';

// Omgång 11, spår B (U90): predikaten i registerOmg11B.js och INV-3:s
// bärarbyte med passage eller väntan. Varje predikat prövas på ett konstruerat
// läge som posten ska känna igen och på närliggande lägen där appen vore fel
// (mutanternas mönster): släppet före eller efter gränsen, en båt som hörts,
// en tid som inte var bärarens egen, en inbromsning som U31 skulle ha hållit.

const { PREDICATES, loadRegistry } = require('../lib/registry');
const { validateInvariants } = require('../../invariants');

const T0 = Date.parse('2026-07-01T10:00:00Z');
const s = (sek) => T0 + sek * 1000;
const fynd = (klass, bro, t) => ({
  orakel: 'INV-F', inv: 'INV-3', klass, bro, t, detalj: '',
});
const båt = (mmsi, o) => ({
  mmsi, targetBridge: 'Klaffbron', waitingAt: null, imminent: false, fromExhausted: false, exhaustedAt: null, etaMinutes: null, confirmedMs: null, sog: 5, queueAhead: null, ...o,
});
const text = (t, klausul, leads, vessels) => ({
  t, text: klausul, leads, vessels,
});
const pred = (namn) => (f, ctx) => PREDICATES[namn].fn(f, ctx, { ...PREDICATES[namn].parametrar });

describe('registret laddar spår B:s poster', () => {
  test('sex poster med egna predikat och inga varningar', () => {
    const reg = loadRegistry();
    for (const id of ['C-BÄRARE-LÄMNADE-OMG11B', 'U34-LEDARBYTE-OMG11B', 'U16-TICK-OMG11B', 'U31-REST-OMG11B', 'U1-C11-OMG11B', 'E1-KÖAVGÅNG-OMG11B', 'U92-VÄNDNING-UTAN-BEKRÄFTELSE-OMG11B']) {
      expect(reg.entry(id)).not.toBeNull();
    }
    expect(reg.varningar).toEqual([]);
  });
});

describe('ledarbyteTystFrämstaB (U34, luckorna A-i, A-ii, A-iii, A-v)', () => {
  const p = pred('ledarbyteTystFrämstaB');
  const läge = (o = {}) => {
    const L1F = båt('1', {
      etaMinutes: 4.2, confirmedMs: s(-200), sog: 5.6, ...o.L1F,
    });
    const L1E = båt('1', {
      etaMinutes: null, confirmedMs: s(-200), sog: 5.6, queueAhead: 'Olidebron', ...o.L1E,
    });
    const L2F = båt('2', { etaMinutes: o.L2före === undefined ? 12.2 : o.L2före, confirmedMs: s(30) });
    const L2E = båt('2', { etaMinutes: 12.2, confirmedMs: s(30) });
    const L = [
      text(s(60), 'Två båtar på väg mot Klaffbron, beräknad broöppning om 4 minuter', [{ bridge: 'Klaffbron', mmsi: '1' }], [L1F, L2F]),
      text(s(110), 'Två båtar på väg mot Klaffbron, beräknad broöppning om 12 minuter', [{ bridge: 'Klaffbron', mmsi: '2' }], [L1E, L2E]),
      ...(o.senare || []),
    ];
    // L1:s sista rad 900 m söder om Klaffbron på väg norrut; L1 korsar före L2,
    // och L2 korsar 11 min efter hoppet (hennes tid 12 är rimlig).
    const rader = [{
      mmsi: '1', lat: 58.28409 - 900 / 111320, lon: 12.28393, sog: 5.6, cog: 20, aisTimestamp: s(-200),
    }];
    const sanning = { crossings: [{ mmsi: '1', bridge: 'Klaffbron', t: s(o.L1kors || 400) }, { mmsi: '2', bridge: 'Klaffbron', t: s(110 + (o.L2kors || 660)) }], uturns: [] };
    return { resultat: { bridgeTextLeads: L, journeyResets: [] }, rader, sanning };
  };
  const f = fynd('INV-3 ETA-SÅGTAND UPP', 'Klaffbron', s(110));
  test('känner igen bytet när hennes tid nollades efter 300 s med en köbro framför (A-i)', () => {
    expect(p(f, läge()).sant).toBe(true);
  });
  test('nollning före 300 s förklaras inte (mutanten M1)', () => {
    const ctx = läge({ L1F: { confirmedMs: s(-80) }, L1E: { confirmedMs: s(-80) } });
    expect(p(f, ctx).sant).toBe(false);
  });
  test('en ny bekräftad position för L1 mellan texterna är ingen tystnad (A-iii på appens klocka)', () => {
    expect(p(f, läge({ L1E: { confirmedMs: s(100) } })).sant).toBe(false);
  });
  test('L1 hade tid kvar vid hoppet: ledarvalet förklaras inte', () => {
    expect(p(f, läge({ L1E: { etaMinutes: 3.4 } })).sant).toBe(false);
  });
  test('ingen köbro och fart över 1 kn efter 300 s förklarar inte nollningen', () => {
    expect(p(f, läge({ L1E: { queueAhead: null } })).sant).toBe(false);
  });
  test('L1 korsar efter L2: hon var inte främst, och hoppet förklaras inte (räknefel i ledarvalet)', () => {
    expect(p(f, läge({ L1kors: 900 })).sant).toBe(false);
  });
  test('L2:s tid långt över hennes verkliga korsning är ett räknefel, inte bytet (mutanten M3)', () => {
    expect(p(f, läge({ L1kors: 100, L2kors: 60 })).sant).toBe(false);
  });
  test('A-ii: en lägre senare tid från L2:s egen nya position godtas när tiden var hennes före bytet', () => {
    const senare = [text(s(170), 'Två båtar på väg mot Klaffbron, beräknad broöppning om 5 minuter', [{ bridge: 'Klaffbron', mmsi: '2' }],
      [båt('1', { confirmedMs: s(-200) }), båt('2', { etaMinutes: 5.1, confirmedMs: s(170) })])];
    expect(p(f, läge({ senare })).sant).toBe(true);
  });
  test('A-ii: en uppblåst tid i bytet (L2 hade en annan tid före) och ett fall efteråt fälls (mutanten M3 i omgång 4)', () => {
    const senare = [text(s(170), 'Två båtar på väg mot Klaffbron, beräknad broöppning om 5 minuter', [{ bridge: 'Klaffbron', mmsi: '2' }],
      [båt('1', { confirmedMs: s(-200) }), båt('2', { etaMinutes: 5.1, confirmedMs: s(170) })])];
    expect(p(f, läge({ senare, L2före: 5.4 })).sant).toBe(false);
  });
  test('A-v: i en oscillation prövas avvikelsen X → Y', () => {
    const ctx = läge({
      senare: [text(s(170), 'Två båtar på väg mot Klaffbron, beräknad broöppning om 4 minuter', [{ bridge: 'Klaffbron', mmsi: '1' }],
        [båt('1', { etaMinutes: 3.9, confirmedMs: s(170) }), båt('2', { etaMinutes: 11.2, confirmedMs: s(30) })])],
    });
    expect(p(fynd('INV-3 ETA-OSCILLATION', 'Klaffbron', s(170)), ctx).sant).toBe(true);
  });
});

describe('straxSläppsVidTick (U16, tickvarianten)', () => {
  const p = pred('straxSläppsVidTick');
  const läge = (släppS, o = {}) => {
    const conf = s(0);
    const a = text(s(560), 'Två båtar på väg mot Klaffbron, beräknad broöppning strax', [{ bridge: 'Klaffbron', mmsi: '2' }],
      [båt('1', { imminent: true, confirmedMs: conf }), båt('2', { etaMinutes: 7.2, confirmedMs: s(500) })]);
    const b = text(s(släppS), 'Två båtar på väg mot Klaffbron, beräknad broöppning om 7 minuter', [{ bridge: 'Klaffbron', mmsi: '2' }],
      [båt('1', { imminent: false, confirmedMs: o.hörd ? s(släppS - 5) : conf }), båt('2', { etaMinutes: 7.0, confirmedMs: s(500) })]);
    return { resultat: { bridgeTextLeads: [a, b] }, sanning: { crossings: [{ mmsi: '2', bridge: 'Klaffbron', t: s(släppS + 400) }], uturns: [] } };
  };
  test('släppet vid första texten efter 600 s känns igen', () => {
    expect(p(fynd('INV-3 ETA-SÅGTAND UPP', 'Klaffbron', s(630)), läge(630)).sant).toBe(true);
  });
  test('släppet före gränsen (mutanten M5, 480 s) fälls', () => {
    expect(p(fynd('INV-3 ETA-SÅGTAND UPP', 'Klaffbron', s(590)), läge(590)).sant).toBe(false);
  });
  test('släppet mer än en tick och ett harnessteg efter gränsen fälls', () => {
    expect(p(fynd('INV-3 ETA-SÅGTAND UPP', 'Klaffbron', s(670)), läge(670)).sant).toBe(false);
  });
  test('en båt som hörts emellan släpps inte av tystnaden', () => {
    expect(p(fynd('INV-3 ETA-SÅGTAND UPP', 'Klaffbron', s(630)), läge(630, { hörd: true })).sant).toBe(false);
  });
});

describe('bärareLämnadeISanningen (mekanism C; INV-3 som på basen)', () => {
  // strax (båt 1) → om 4 (båt 2) → strax (båt 2 når bron): två båtar efter varandra.
  const p = pred('bärareLämnadeISanningen');
  const resultat = (passageS) => {
    const tr = [
      { t: s(0), iso: '', text: 'Två båtar på väg mot Klaffbron, beräknad broöppning strax' },
      { t: s(60), iso: '', text: 'Två båtar på väg mot Klaffbron, beräknad broöppning om 4 minuter' },
      { t: s(150), iso: '', text: 'Två båtar på väg mot Klaffbron, beräknad broöppning strax' },
    ];
    return {
      bridgeTextTransitions: tr,
      bridgeTextLeads: [
        {
          t: s(0), text: tr[0].text, leads: [{ bridge: 'Klaffbron', mmsi: '1' }], vessels: [båt('1', { imminent: true }), båt('2', { etaMinutes: 5 })],
        },
        {
          t: s(60), text: tr[1].text, leads: [{ bridge: 'Klaffbron', mmsi: '2' }], vessels: [båt('1'), båt('2', { etaMinutes: 4 })],
        },
        {
          t: s(150), text: tr[2].text, leads: [{ bridge: 'Klaffbron', mmsi: '2' }], vessels: [båt('1'), båt('2', { etaMinutes: 2.5, imminent: true })],
        },
      ],
      targetPassages: passageS === null ? [] : [{
        mmsi: '1', bridge: 'Klaffbron', t: s(passageS), iso: '',
      }],
      notifications: [{ mmsi: '1', bridge: 'Klaffbron', t: s(10) }],
      journeyResets: [],
    };
  };
  const f = {
    orakel: 'INV-F', inv: 'INV-3', klass: 'INV-3 ETA-OSCILLATION', bro: 'Klaffbron', t: s(150), detalj: '',
  };
  const ctx = (passageS, korsS) => ({ resultat: resultat(passageS), sanning: { crossings: korsS === null ? [] : [{ mmsi: '1', bridge: 'Klaffbron', t: s(korsS) }], uturns: [] } });
  test('INV-3 fäller växlingen som på basen', () => {
    expect(validateInvariants(resultat(40)).filter((v) => /ETA-OSCILLATION/.test(v)).length).toBe(1);
  });
  test('bokförd passage som motsvaras av en sann korsning känns igen', () => {
    expect(p(f, ctx(40, 30)).sant).toBe(true);
  });
  test('en för tidig bokföring (korsningen kommer mer än 30 s senare) blir kandidat', () => {
    expect(p(f, ctx(40, 120)).sant).toBe(false);
  });
  test('en falsk bokföring (ingen sann korsning) blir kandidat', () => {
    expect(p(f, ctx(40, null)).sant).toBe(false);
  });
  test('utan bokförd passage och utan väntan blir det kandidat (mutanten M6)', () => {
    expect(p(f, ctx(null, 30)).sant).toBe(false);
  });
});

describe('inbromsningEfterStrax (U31:s rest)', () => {
  const p = pred('inbromsningEfterStrax');
  // Klaffbron ligger på 58.28409 N; söderut från norr: avstånd ≈ (lat − 58.28409) · 111 320 m.
  const latVid = (m) => 58.28409 + m / 111320;
  const läge = (o = {}) => {
    const rader = [
      {
        mmsi: '1', lat: latVid(390), lon: 12.28393, sog: o.sogX || 4.8, aisTimestamp: s(0),
      },
      {
        mmsi: '1', lat: latVid(340), lon: 12.28393, sog: 1.2, aisTimestamp: s(30),
      },
      {
        mmsi: '1', lat: latVid(o.dX2 || 295), lon: 12.28393, sog: 1.0, aisTimestamp: s(90),
      },
    ];
    const v = (eta, conf, imm) => båt('1', { etaMinutes: eta, confirmedMs: conf, imminent: imm });
    const L = [
      text(s(0), 'En båt på väg mot Klaffbron, beräknad broöppning strax', [{ bridge: 'Klaffbron', mmsi: '1' }], [v(2.8, s(0), false)]),
      text(s(30), 'En båt på väg mot Klaffbron, beräknad broöppning om 4 minuter', [{ bridge: 'Klaffbron', mmsi: '1' }], [v(3.7, s(30), false)]),
      text(s(90), 'En båt på väg mot Klaffbron, beräknad broöppning strax', [{ bridge: 'Klaffbron', mmsi: '1' }], [v(3.9, s(90), true)]),
    ];
    return { resultat: { bridgeTextLeads: L }, rader };
  };
  const f = fynd('INV-3 ETA-OSCILLATION', 'Klaffbron', s(90));
  test('ärligt inträde, inbromsning och imminent inom 300 m känns igen', () => {
    expect(p(f, läge()).sant).toBe(true);
  });
  test('ett inträde som bara medelfarten lovade (U31 skulle ha hållit, mutanten M7) fälls', () => {
    expect(p(f, läge({ sogX: 2.0 })).sant).toBe(false);
  });
  test('imminent utanför 300 m (mutanten M8) fälls', () => {
    expect(p(f, läge({ dX2: 360 })).sant).toBe(false);
  });
});

describe('köavgångSammaBärare (E1)', () => {
  const p = pred('köavgångSammaBärare');
  const läge = (sogX) => {
    const v = (eta, conf, sog) => båt('1', { etaMinutes: eta, confirmedMs: conf, sog });
    const L = [
      text(s(0), 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 7 minuter', [{ bridge: 'Stridsbergsbron', mmsi: '1' }], [{ ...v(6.6, s(-300), sogX), targetBridge: 'Stridsbergsbron' }]),
      text(s(23), 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 10 minuter', [{ bridge: 'Stridsbergsbron', mmsi: '1' }], [{ ...v(9.9, s(23), 2.3), targetBridge: 'Stridsbergsbron' }]),
      text(s(87), 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 7 minuter', [{ bridge: 'Stridsbergsbron', mmsi: '1' }], [{ ...v(7.1, s(87), 2.1), targetBridge: 'Stridsbergsbron' }]),
    ];
    return {
      resultat: { bridgeTextLeads: L },
      rader: [{
        mmsi: '1', lat: 58.29, lon: 12.29, sog: sogX, aisTimestamp: s(-300),
      }],
    };
  };
  const f = { ...fynd('INV-3 ETA-OSCILLATION', 'Stridsbergsbron', s(87)) };
  test('avgång efter en stilla fix känns igen', () => {
    expect(p(f, läge(0)).sant).toBe(true);
  });
  test('en båt som inte låg still vid X är ingen köavgång', () => {
    expect(p(f, läge(2.4)).sant).toBe(false);
  });
});

describe('vändningUtanBekräftelse (U92, F2)', () => {
  const p = pred('vändningUtanBekräftelse');
  const läge = (o = {}) => {
    const tr = [
      { t: s(0), iso: '', text: 'En båt på väg mot Klaffbron, beräknad broöppning om 8 minuter' },
      { t: s(200), iso: '', text: 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron' },
      { t: s(267), iso: '', text: 'En båt på väg mot Klaffbron, beräknad broöppning om 11 minuter' },
    ];
    return {
      resultat: {
        bridgeTextTransitions: tr,
        bridgeTextLeads: [
          {
            t: s(0), text: tr[0].text, leads: [], vessels: [båt('1', { etaMinutes: 7.9 })],
          },
          {
            t: s(200), text: tr[1].text, leads: [], vessels: [],
          },
          {
            t: s(267), text: tr[2].text, leads: [], vessels: [båt('1', { etaMinutes: 10.9 })],
          },
        ],
        targetChanges: [
          {
            t: s(200), mmsi: '1', from: 'Klaffbron', to: 'none', reason: 'MOVING_AWAY', sog: 2.2,
          },
          {
            t: s(267), mmsi: '1', from: 'none', to: 'Klaffbron', reason: 'ACCELERATED', sog: o.sog || 1.9,
          },
        ],
        journeyResets: o.bekräftad ? [{ t: s(230), mmsi: '1' }] : [],
      },
      sanning: { uturns: o.ingenVändning ? [] : [{ mmsi: '1', t: s(-120) }], crossings: [] },
    };
  };
  const f = {
    orakel: 'INV-F', inv: 'INV-14', klass: 'INV-14 DEFAULT-FLASH', bro: 'Klaffbron', t: s(200), detalj: '',
  };
  test('rensning, omsättning under 2 kn utan bekräftelse efter en vändning känns igen', () => {
    expect(p(f, läge()).sant).toBe(true);
  });
  test('omsättning i 2 kn eller mer (Fix D hade kunnat bekräfta) blir kandidat', () => {
    expect(p(f, läge({ sog: 2.5 })).sant).toBe(false);
  });
  test('en bekräftad vändning före omsättningen blir kandidat', () => {
    expect(p(f, läge({ bekräftad: true })).sant).toBe(false);
  });
  test('utan vändning i världen blir rensningen kandidat', () => {
    expect(p(f, läge({ ingenVändning: true })).sant).toBe(false);
  });
});
