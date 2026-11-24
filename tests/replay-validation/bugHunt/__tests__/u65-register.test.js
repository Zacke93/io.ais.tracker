'use strict';

/**
 * U65 (ägarens beslut 2026-11-24): köbeviset vid målbron ger vänttexten
 * "väntar vid <bro>" och bär aldrig "strax". Två registerposter byggde på att
 * en köare vid målbron bar "strax":
 *  - MÄTGRÄNS-INV10-VÄNTKEDJA förklarar en lång "strax" bara med väntor som
 *    kan bära det, alltså köaren vid Kajen (harnessens confirmedQuayWaits);
 *  - U16-F40-STRAX-STUDS binder inte studsen till en båt som enligt
 *    ETA-bärarna stod i kön vid bron (krav 9b).
 * Resultat utan de nya fälten dömer som förut (övriga sviter).
 */

const { loadRegistry } = require('../lib/registry');
const existing = require('../lib/oracles/existing');

const klassa = (reg, f, ctx) => reg.classify(f, ctx, { räkna: false });

describe('U65 MÄTGRÄNS-INV10-VÄNTKEDJA: bara väntor som kan bära strax', () => {
  const at = (hms) => Date.parse(`2026-08-04T${hms}Z`);
  const STRAX = 'En båt på väg mot Klaffbron, beräknad broöppning strax';
  const INGA = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
  const WAITS = [['08:49:44.879', '08:59:44.854'], ['08:59:57.860', '09:27:04.278']];
  const resultat = (quay) => ({
    bridgeTextTransitions: [
      ['08:45:00.040', INGA], ['08:49:44.879', STRAX], ['09:27:30.040', 'En båt på väg mot Klaffbron, ETA okänd'], ['09:29:50.523', INGA],
    ].map(([hms, text]) => ({ t: at(hms), iso: `2026-08-04T${hms}Z`, text })),
    confirmedTargetWaits: WAITS.map(([a, b]) => ({ bridge: 'Klaffbron', from: at(a), until: at(b) })),
    confirmedQuayWaits: quay.map(([a, b]) => ({ bridge: 'Klaffbron', from: at(a), until: at(b) })),
    targetPassages: [],
    notifications: [],
  });
  const domen = (quay) => {
    const res = resultat(quay);
    const f = existing.judgeExisting({ result: res, rows: [], gt: null }).fynd.find((x) => x.inv === 'INV-10');
    return { f, c: klassa(loadRegistry(), f, { rader: [], resultat: res }) };
  };

  test('köaren vid Kajen bär strax genom kedjan: MÄTGRÄNS (värld 129:s fall)', () => {
    const { f, c } = domen(WAITS);
    expect(f.belägg.väntan.kajIntervall).toHaveLength(2);
    expect(c).toMatchObject({ klass: 'MÄTGRÄNS', post: 'MÄTGRÄNS-INV10-VÄNTKEDJA' });
  });

  test('bara köbevis vid målbron (vänttext sedan U65) förklarar inte en lång strax: KANDIDAT', () => {
    const { f, c } = domen([]);
    expect(f.belägg.väntan.intervall).toHaveLength(2);
    expect(f.belägg.väntan.kajIntervall).toEqual([]);
    expect(c.klass).toBe('KANDIDAT');
    expect(c.närmast).toMatchObject({ post: 'MÄTGRÄNS-INV10-VÄNTKEDJA' });
    expect(c.närmast.skäl).toMatch(/bara köbevis, som sedan U65 ger vänttexten/);
  });
});

describe('U65 U16-F40-STRAX-STUDS: en båt i kön vid målbron bär inte studsen', () => {
  const U16 = 'U16-F40-STRAX-STUDS';
  const at = (hms) => Date.parse(`2026-06-13T${hms}Z`);
  const iso = (t) => new Date(t).toISOString();
  const rad = (mmsi, hms, lat, lon, sog, cog) => ({
    mmsi, lat, lon, sog, cog, aisTimestamp: at(hms),
  });
  // F18:s minsta repro (värld 1608, samma rader som i-runda3).
  const MASEN = '265855691';
  const RADER = [
    rad(MASEN, '09:29:54.515', 58.29545, 12.29744, 5.7, 211),
    rad(MASEN, '09:31:03.658', 58.29404, 12.2955, 0.6, 226),
    rad(MASEN, '09:32:10.242', 58.29403, 12.29559, 0, null),
    rad(MASEN, '09:42:15.101', 58.29399, 12.29572, 0.1, 238.9),
    rad(MASEN, '09:46:49.437', 58.29398, 12.29568, 0, 251.7),
    rad('265855485', '09:40:01.932', 58.30381, 12.3073, 5.7, 216),
    rad('265855485', '09:41:09.805', 58.30319, 12.30645, 5.7, 216),
    rad('265855485', '09:42:15.173', 58.30092, 12.30355, 5.7, 210.8),
    rad('265855485', '09:43:24.810', 58.29999, 12.3025, 5.7, 210.8),
    rad('265855773', '09:40:01.997', 58.28451, 12.28434, 5, 198.3),
    rad('265855773', '09:41:09.847', 58.2833, 12.28372, 5.6, 193.2),
  ];
  const TVÅ = (eta) => `Två båtar på väg mot Stridsbergsbron, beräknad broöppning ${eta}`;
  const TEXTER = [
    ['09:33:17.859', 'Tre båtar på väg mot Stridsbergsbron, beräknad broöppning strax'],
    ['09:41:09.890', TVÅ('strax')],
    ['09:42:15.101', TVÅ('om 8 minuter')],
    ['09:42:15.126', TVÅ('strax')],
    ['09:47:55.901', 'En båt på väg mot Stridsbergsbron, beräknad broöppning strax'],
  ];
  // Efter U65 står köaren i målbrons vänttext, och gruppen under gång har en
  // båt färre (samma studs i dess klausul).
  const KÖTEXTER = [
    ['09:33:17.859', `En båt väntar vid Stridsbergsbron; ${TVÅ('strax')}`],
    ['09:41:09.890', 'En båt väntar vid Stridsbergsbron; En båt på väg mot Stridsbergsbron, beräknad broöppning strax'],
    ['09:42:15.101', 'En båt väntar vid Stridsbergsbron; En båt på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter'],
    ['09:42:15.126', 'En båt väntar vid Stridsbergsbron; En båt på väg mot Stridsbergsbron, beräknad broöppning strax'],
    ['09:47:55.901', 'En båt väntar vid Stridsbergsbron; En båt på väg mot Stridsbergsbron, beräknad broöppning strax'],
  ];
  const domar = (masenIKö, texter = masenIKö ? KÖTEXTER : TEXTER) => {
    const leads = texter.map(([hms, text]) => ({
      t: at(hms),
      text,
      leads: [{ bridge: 'Stridsbergsbron', mmsi: '265855485' }],
      vessels: [
        {
          mmsi: MASEN, targetBridge: 'Stridsbergsbron', waitingAt: masenIKö ? 'Stridsbergsbron' : null, imminent: true,
        },
        {
          mmsi: '265855485', targetBridge: 'Stridsbergsbron', waitingAt: null, imminent: false,
        },
      ],
    }));
    const res = {
      bridgeTextTransitions: texter.map(([hms, text]) => ({ t: at(hms), iso: iso(at(hms)), text })),
      bridgeTextLeads: leads,
      notifications: [],
      targetPassages: [],
      confirmedTargetWaits: [],
    };
    const reg = loadRegistry();
    return existing.judgeExisting({ result: res, rows: RADER, gt: null }).fynd.filter((x) => x.inv === 'INV-3')
      .map((f) => {
        const c = klassa(reg, f, { rader: RADER, resultat: res });
        return { f, c, skäl: c.post === U16 ? c.skäl : (c.prövade.find((p) => p.post === U16) || {}).skäl };
      });
  };

  test('båten utanför kön (ETA-bärarna utan väntplats) bär studsen som förut: MÄTGRÄNS', () => {
    const d = domar(false);
    expect(d.map((x) => `${x.f.klass} ${x.c.klass}`).sort())
      .toEqual(['INV-3 ETA-OSCILLATION MÄTGRÄNS', 'INV-3 ETA-SÅGTAND UPP MÄTGRÄNS']);
  });

  test('före U65 (ingen vänttext vid målbron) bar köaren strax: samma ETA-bärare med waitingAt ger MÄTGRÄNS som förut', () => {
    const d = domar(true, TEXTER);
    expect(d.map((x) => `${x.f.klass} ${x.c.klass}`).sort())
      .toEqual(['INV-3 ETA-OSCILLATION MÄTGRÄNS', 'INV-3 ETA-SÅGTAND UPP MÄTGRÄNS']);
  });

  test('båten i kön vid målbron ("väntar vid", U65) kan inte ha burit strax: posten gäller inte', () => {
    const d = domar(true);
    expect(d).toHaveLength(2);
    for (const x of d) {
      expect(x.c.post).not.toBe(U16);
      expect(x.skäl).toMatch(/stod i kön vid Stridsbergsbron \("väntar vid", U65\) vid nivån före hoppet 09:41:09\.890/);
    }
  });
});
