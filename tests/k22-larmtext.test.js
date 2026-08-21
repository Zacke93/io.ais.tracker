'use strict';

/**
 * K22 (fältprov 10, 2026-08-19) — LARMNOTISENS TEXT och DYGNSSTEGET.
 *
 * FYNDET: tystnadsnotisen är den enda kanal som når en användare UTAN
 * loggåtkomst, och den ljög i två riktningar samtidigt.
 *   (1) TEXTEN. Loggraden interpolerade den MÄTTA tystnaden medan notisen
 *       hårdkodade korstystnadsFÖNSTRET: fältet skrev "[FEED_SILENT] aisstream
 *       har inte levererat på 16 min" 06:30:00.940Z och 26 ms senare gick
 *       notisen "…på 15 min". Systerloggen 2026-08-11 är det grova beviset:
 *       mätt 1456 min → notis "15 min" 24 ms senare, utan mellanliggande
 *       omstart — en underskattning med faktor ~97. Det bryter kodens EGEN
 *       BT-12-princip, som står skriven tre rader ovanför hårdkodningen.
 *   (2) TRAPPAN. ESCALATION_STEPS slutade vid 4 h. 19/8 gick dygnets sista
 *       notis 10:15:03 och därefter kördes 10 h 51 min på halverad redundans
 *       utan en enda ny signal medan tystnaden växte till 886 min — ett
 *       fyratimmarsavbrott och ett femtontimmarsavbrott var OSKILJBARA på
 *       enheten, vilket är precis det trappan finns för att förhindra.
 *
 * SKÄRPT 2026-08-21 (granskningen av K22:s första version, dirigentbeslut):
 *   (a) _formatSilence GOLVAR alla tre skalorna. Symmetrisk avrundning bröt
 *       BT-12 åt det grova hållet — 90 min blev "2 h", 36 h blev "2 dygn"
 *       (+12 h som aldrig mätts) i texter som säger "i över". Med golv är
 *       varje siffra en SANN UNDRE GRÄNS.
 *   (b) Eskaleringstexterna bär den UPPMÄTTA tystnaden, inte stegets tröskel.
 *       Ett 25-timmarsavbrott som upptäcktes sent sa "i över 1 h" — samma
 *       underskattningsklass som (1) ovan, bara 24× i stället för 97×.
 *       Dedup-NYCKELN bär fortfarande etiketten ('…:1h'/'…:4h'/'…:1 dygn').
 *   (c) K33-raden heter "Bridge text oförändrad": den engelska frasen är
 *       upptagen av 📱 [UI_UPDATE] Bridge text unchanged xN (last 60s), en
 *       HELT annan händelse (ingen skrivning alls).
 *
 * Filen låser fixen i fyra block:
 *   A. _formatSilence — EN formaterare, med sina GRÄNSER (59/60 min,
 *      23/24 h, 1/2 dygn), sitt GOLV (BT-12-invarianten) och sentinelskyddet.
 *   B. Basnotiserna bär den MÄTTA tystnaden, inte fönstret/tröskeln — alla
 *      fyra vägarna (feeds:silent, feeds:empty:4h, aisstream, aishub).
 *   C. Dygnssteget fyrar I SEKVENS efter 4h-steget (egen nyckel ⇒ 24h-dedupen
 *      kan inte äta det), upprepas inte inom dygnet, och trappans TEXTER bär
 *      mätningen medan NYCKLARNA bär etiketten.
 *   D. K33 — [SNAPSHOT_PROCESS] påstår inte längre "Bridge text changed" när
 *      hashen är identisk. FREKVENSEN ÄR ORÖRD; bara raden är villkorad.
 */

process.env.NODE_ENV = 'test';
global.__TEST_MODE__ = true;

const AISBridgeApp = require('../app');
const {
  CONNECTION_ALERT,
  FEED_SILENCE,
  BRIDGE_TEXT_CONSTANTS,
  BRIDGES,
} = require('../lib/constants');

const MIN = 60 * 1000;
const H = 60 * MIN;
const DYGN = 24 * H;

const flush = () => new Promise((resolve) => {
  setImmediate(resolve);
});

/** App-rigg för hälsovägen (samma form som kalldodslarm-eskalering.test.js). */
function makeHealthApp({ source = 'both', aishubUsername = 'station' } = {}) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  app.debug = jest.fn();
  const store = new Map([
    ['ais_api_key', 'KEY'],
    ['ais_source', source],
    ['aishub_username', aishubUsername],
  ]);
  app.homey = {
    settings: {
      get: (k) => (store.has(k) ? store.get(k) : null),
      set: jest.fn((k, v) => store.set(k, v)),
      on: jest.fn(),
    },
    notifications: { createNotification: jest.fn().mockResolvedValue(undefined) },
  };
  app._updateDeviceCapability = jest.fn();
  app._isConnected = true;
  app._sourceEverResponded = true;
  app.aisClient = {
    isConnected: true,
    getConnectionStats: jest.fn(),
    reconnectWithKey: jest.fn().mockResolvedValue(undefined),
    kickAishub: jest.fn(),
  };
  return app;
}

/**
 * perFeed-post. `uptimeMs` sätter OBSERVATIONSANKARET (_anchorFeedObservation):
 * observerad tystnad kan aldrig bli längre än vi bevakat källan, så ett prov
 * på 25 h tystnad kräver ett fönster som är vidare än så.
 */
const perFeed = ({
  streamSilentMs = 20 * MIN,
  streamConnected = true,
  hubDeliveredMsAgo = 3 * MIN,
  hubOkAgeMs = 10 * 1000,
  uptimeMs = 30 * H,
} = {}) => {
  const now = Date.now();
  return {
    aisstream: {
      configured: true,
      isConnected: streamConnected,
      lastMessageTime: now - streamSilentMs,
      timeSinceLastMessage: streamSilentMs,
      uptime: uptimeMs,
    },
    aishub: {
      configured: true,
      isConnected: true,
      lastMessageTime: hubDeliveredMsAgo === null ? null : now - hubDeliveredMsAgo,
      timeSinceLastMessage: hubDeliveredMsAgo,
      uptime: uptimeMs,
      lastOkResponseAt: hubOkAgeMs === null ? null : now - hubOkAgeMs,
    },
  };
};

const sentKeys = (app) => [...(app._connectionIssueNotifiedAt || new Map()).keys()];
const notisTexter = (app) => app.homey.notifications.createNotification.mock.calls
  .map((c) => c[0].excerpt);
const notisCount = (app) => app.homey.notifications.createNotification.mock.calls.length;

// =============================================================================
// A. _formatSilence — formateringens GRÄNSER
// =============================================================================
describe('K22-A: _formatSilence ger EN läsbar tidsfras med skarpa gränser', () => {
  const fmt = (ms) => makeHealthApp()._formatSilence(ms);

  test('MINUTSKALAN: under en HEL timme skrivs minuter', () => {
    // GOLV, inte avrundning: siffran är alltid en SANN UNDRE GRÄNS, så
    // prepositionerna i notistexterna ("på N", "i över N") är sanna i
    // bokstavlig mening (BT-12). Se _formatSilence:s JSDoc för härledningen.
    expect(fmt(0)).toBe('0 min');
    expect(fmt(59 * 1000)).toBe('0 min'); // < 1 min ⇒ "0 min", medvetet val
    expect(fmt(15 * MIN)).toBe('15 min');
    expect(fmt(16 * MIN)).toBe('16 min'); // fältets rad 2613
    expect(fmt(16 * MIN + 59 * 1000)).toBe('16 min'); // golvas ned, aldrig upp
    expect(fmt(59 * MIN)).toBe('59 min');
  });

  test('GRÄNSEN 59/60 min: "60 min" kan aldrig skrivas ut', () => {
    // Enhetsvalet görs på det GOLVADE värdet — "60 min" är en enhet som inte
    // finns i skalan och kan därför inte uppstå från något håll.
    expect(fmt(59 * MIN + 36 * 1000)).toBe('59 min'); // med Math.round blev detta "1 h"
    expect(fmt(59 * MIN + 59 * 1000 + 999)).toBe('59 min');
    expect(fmt(60 * MIN)).toBe('1 h');
    expect(fmt(60 * MIN + 1)).toBe('1 h');
  });

  test('TIMSKALAN: GOLVAS till hel timme, korrekt svenska utan plural-s', () => {
    // DIRIGENTBESLUT 2026-08-21: BÅDE 89 och 90 min ⇒ "1 h". Med symmetrisk
    // avrundning blev 90 min "2 h" — en överskattning på 33 % i en text som
    // säger "i över", alltså ett falskt påstående i bokstavlig mening.
    expect(fmt(89 * MIN)).toBe('1 h');
    expect(fmt(90 * MIN)).toBe('1 h');
    expect(fmt(119 * MIN)).toBe('1 h');
    expect(fmt(3 * H)).toBe('3 h');
    expect(fmt(4 * H)).toBe('4 h'); // trappans mellansteg
    expect(fmt(23 * H)).toBe('23 h');
    expect(fmt(23 * H + 59 * MIN)).toBe('23 h');
  });

  test('GRÄNSEN 23/24 h: "24 h" kan aldrig skrivas ut', () => {
    expect(fmt(23 * H + 40 * MIN)).toBe('23 h'); // golv (med Math.round: "1 dygn")
    expect(fmt(DYGN - 1)).toBe('23 h');
    expect(fmt(DYGN)).toBe('1 dygn');
    expect(fmt(DYGN + 1)).toBe('1 dygn');
  });

  test('DYGNSSKALAN: GOLVAS, och "dygn" har samma form i singular och plural', () => {
    expect(fmt(DYGN)).toBe('1 dygn');
    expect(fmt(36 * H)).toBe('1 dygn'); // 1,5 dygn golvas (med Math.round: "2 dygn", +12 h)
    expect(fmt(47 * H + 59 * MIN)).toBe('1 dygn');
    expect(fmt(2 * DYGN)).toBe('2 dygn');
    expect(fmt(7 * DYGN)).toBe('7 dygn');
    // FÄLTFALLET (systerloggen 2026-08-11): 1456 min mättes, "15 min"
    // notiserades. Nu blir samma mätning läsbar i stället för falsk.
    expect(fmt(1456 * MIN)).toBe('1 dygn');
    // "0 dygn" är strukturellt omöjligt: grenen nås först när hours >= 24,
    // vilket är varför golvet INTE behöver en Math.max(1, …)-korrigering.
    for (let ms = DYGN; ms <= DYGN + 3 * H; ms += 7 * MIN) {
      expect(fmt(ms)).not.toBe('0 dygn');
    }
  });

  test('BT-12-INVARIANTEN: siffran är ALLTID en sann undre gräns (och inom en enhet)', () => {
    // Hela motiveringen till golvet, prövad som invariant i stället för som
    // stickprov: texten får aldrig påstå MER än mätningen bär, och aldrig
    // underdriva med en HEL enhet (då hade enhetsvalet varit fel).
    const app = makeHealthApp();
    const enhet = { min: MIN, h: H, dygn: DYGN };
    const brott = [];
    for (let ms = 0; ms <= 9 * DYGN; ms += 61 * 1000 + 137) {
      const ut = app._formatSilence(ms);
      const m = ut.match(/^(\d+) (min|h|dygn)$/);
      if (!m) {
        brott.push(`${ms} ⇒ "${ut}" (fel form)`);
        continue;
      }
      const pastatt = Number(m[1]) * enhet[m[2]];
      // aldrig MER än mätningen bär, och aldrig en HEL enhet mindre
      if (pastatt > ms) brott.push(`${ms} ⇒ "${ut}" påstår ${pastatt} ms (för mycket)`);
      if (ms - pastatt >= enhet[m[2]]) brott.push(`${ms} ⇒ "${ut}" underdriver en hel enhet`);
    }
    expect(brott).toEqual([]);
  });

  test('SENTINELVAKTEN: ingen användartext kan bli "NaN min" eller "Infinity min"', () => {
    // Fältprovet 2026-08-08 skrev "Infinity min" i 153 loggrader innan
    // observationsankaret infördes. Formateraren är andra linjen.
    expect(fmt(Infinity)).toBe('okänd tid');
    expect(fmt(NaN)).toBe('okänd tid');
    expect(fmt(null)).toBe('okänd tid');
    expect(fmt(undefined)).toBe('okänd tid');
    expect(fmt('20 min')).toBe('okänd tid');
    expect(fmt(-1)).toBe('okänd tid');
  });

  test('FORMSVEP: varje utdata är antingen "N enhet" eller sentinelfrasen', () => {
    const app = makeHealthApp();
    for (let ms = 0; ms <= 3 * DYGN; ms += 137 * 1000) {
      const ut = app._formatSilence(ms);
      expect(ut).toMatch(/^(\d+ (min|h|dygn)|okänd tid)$/);
      expect(ut).not.toBe('60 min');
      expect(ut).not.toBe('24 h');
    }
  });
});

// =============================================================================
// B. Basnotiserna bär den MÄTTA tystnaden — inte fönstret, inte tröskeln
// =============================================================================
describe('K22-B: basnotiserna interpolerar mätningen (BT-12)', () => {
  test('aisstream:silent — 47 min mätt ⇒ "på 47 min", aldrig "på 15 min"', async () => {
    const app = makeHealthApp();
    app._checkCrossFeedSilence(perFeed({ streamSilentMs: 47 * MIN }));
    await flush();

    expect(sentKeys(app)).toContain('aisstream:silent');
    const bas = notisTexter(app).find((t) => t.includes('AISstream har inte levererat'));
    expect(bas).toContain('på 47 min');
    expect(bas).not.toContain('på 15 min');
    // Loggraden och notisen ska ge SAMMA siffra — det var hela fyndet.
    const logg = app.log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logg).toContain('aisstream har inte levererat på 47 min');
  });

  test('FÄLTFALLET: 1456 min mätt ⇒ notisen säger "1 dygn", inte "15 min" (~97x fel)', async () => {
    const app = makeHealthApp();
    app._checkCrossFeedSilence(perFeed({ streamSilentMs: 1456 * MIN, uptimeMs: 40 * H }));
    await flush();

    const bas = notisTexter(app).find((t) => t.includes('AISstream har inte levererat'));
    expect(bas).toContain('på 1 dygn');
    expect(bas).not.toContain('15 min');
  });

  test('aishub:silent — 3 h mätt ⇒ "på 3 h"', async () => {
    const app = makeHealthApp();
    // Spegelvänt läge: hubben tyst, aisstream färsk (< FRESH_MS).
    app._checkCrossFeedSilence(perFeed({
      streamSilentMs: 30 * 1000,
      hubDeliveredMsAgo: 3 * H,
    }));
    await flush();

    expect(sentKeys(app)).toContain('aishub:silent');
    const bas = notisTexter(app).find((t) => t.includes('AISHub har inte levererat'));
    expect(bas).toContain('på 3 h');
    expect(bas).not.toContain('på 15 min');
  });

  test('feeds:silent (äkta blindhet) — 20 min mätt ⇒ "på 20 min", inte "på 15 minuter"', async () => {
    const app = makeHealthApp();
    // Ingen källa SVARAR: socketen nere och pollklockan ofärsk.
    app._checkCrossFeedSilence(perFeed({
      streamSilentMs: 20 * MIN,
      streamConnected: false,
      hubDeliveredMsAgo: 20 * MIN,
      hubOkAgeMs: 20 * MIN,
    }));
    await flush();

    expect(sentKeys(app)).toContain('feeds:silent');
    const bas = notisTexter(app).find((t) => t.includes('ingen AIS-källa har levererat'));
    expect(bas).toContain('på 20 min');
    expect(bas).not.toContain('på 15 minuter');
  });

  test('feeds:empty:4h (tom kanal) — 12 h mätt ⇒ "på 12 h", inte tröskelns "4 timmar"', async () => {
    const app = makeHealthApp();
    // Alla källor SVARAR (socket öppen, pollklockan färsk) men ingen levererar.
    app._checkCrossFeedSilence(perFeed({
      streamSilentMs: 12 * H,
      hubDeliveredMsAgo: 12 * H,
    }));
    await flush();

    expect(sentKeys(app)).toEqual(['feeds:empty:4h']);
    expect(notisTexter(app)[0]).toContain('ingen båtdata på 12 h');
    expect(notisTexter(app)[0]).not.toContain('på 4 timmar');
  });

  test('TRÖSKELN SJÄLV är oförändrad: 4h-nätet är en NIVÅ, texten bara en spegel', async () => {
    // Beteendeneutralitet: K22 rör texten, aldrig när larmet fyrar.
    const strax = makeHealthApp();
    strax._checkCrossFeedSilence(perFeed({
      streamSilentMs: 4 * H - MIN, hubDeliveredMsAgo: 4 * H - MIN,
    }));
    await flush();
    expect(sentKeys(strax)).toHaveLength(0);

    const precis = makeHealthApp();
    precis._checkCrossFeedSilence(perFeed({
      streamSilentMs: FEED_SILENCE.EMPTY_CHANNEL_ALERT_MS,
      hubDeliveredMsAgo: FEED_SILENCE.EMPTY_CHANNEL_ALERT_MS,
    }));
    await flush();
    expect(sentKeys(precis)).toEqual(['feeds:empty:4h']);
  });
});

// =============================================================================
// C. Dygnssteget — trappan slutar inte längre vid 4 h
// =============================================================================
describe('K22-C: dygnssteget fyrar i sekvens efter 4h-steget', () => {
  test('TRAPPANS FORM: stigande steg, unika etiketter, dygnssteget överst', () => {
    const steg = CONNECTION_ALERT.ESCALATION_STEPS;
    expect(steg.map((s) => s.label)).toEqual(['1h', '4h', '1 dygn']);
    // Etiketten är dedup-nyckelns suffix ⇒ den MÅSTE vara unik, annars kan ett
    // grövre steg tystas av ett finare inom samma 24h-fönster.
    expect(new Set(steg.map((s) => s.label)).size).toBe(steg.length);
    for (let i = 1; i < steg.length; i++) {
      expect(steg[i].ms).toBeGreaterThan(steg[i - 1].ms);
    }
    // HÄRLEDNINGEN: dygnssteget är exakt lika långt som dedupfönstret, så det
    // kan fyra HÖGST en gång per dygn av oavbrutet avbrott.
    expect(steg[steg.length - 1].ms).toBe(DYGN);
  });

  test('SEKVENSEN: 5 h ⇒ bas+1h+4h, sedan 25 h ⇒ dygnssteget fyrar ENDÅ (egen nyckel)', async () => {
    const app = makeHealthApp();

    // Steg 1 — fem timmars halvdöd aisstream med levererande hubb.
    app._checkCrossFeedSilence(perFeed({ streamSilentMs: 5 * H }));
    await flush();
    expect(sentKeys(app)).toEqual([
      'aisstream:silent', 'aisstream:silent:1h', 'aisstream:silent:4h',
    ]);
    expect(notisCount(app)).toBe(3);

    // Steg 2 — samma oavbrutna avbrott, nu 25 h. Bas/1h/4h är DEDUPADE
    // (24h-fönstret löper), men dygnssteget har en EGEN nyckel och måste
    // därför bryta igenom. Det var exakt det som saknades 19/8: efter
    // 4h-notisen 10:15:03 gick 10 h 51 min utan en enda ny signal.
    app._checkCrossFeedSilence(perFeed({ streamSilentMs: 25 * H, uptimeMs: 40 * H }));
    await flush();

    expect(sentKeys(app)).toEqual([
      'aisstream:silent', 'aisstream:silent:1h', 'aisstream:silent:4h',
      'aisstream:silent:1 dygn',
    ]);
    expect(notisCount(app)).toBe(4); // exakt EN ny notis, inte tre
    expect(notisTexter(app)[3]).toContain('har varit tyst i över 1 dygn');
  });

  test('PÅMINNELSE, INTE SERIE: dygnssteget upprepas inte inom dedupfönstret', async () => {
    const app = makeHealthApp();
    app._checkCrossFeedSilence(perFeed({ streamSilentMs: 25 * H, uptimeMs: 40 * H }));
    await flush();
    const efterForsta = notisCount(app);
    expect(sentKeys(app)).toContain('aisstream:silent:1 dygn');

    for (let i = 0; i < 5; i++) {
      app._checkCrossFeedSilence(perFeed({ streamSilentMs: 30 * H, uptimeMs: 40 * H }));
      await flush();
    }
    expect(notisCount(app)).toBe(efterForsta);
  });

  test('TEXTERNA: nyckeln bär etiketten, texten bär den UPPMÄTTA tystnaden', async () => {
    const app = makeHealthApp();
    app._checkCrossFeedSilence(perFeed({ streamSilentMs: 25 * H, uptimeMs: 40 * H }));
    await flush();

    const eskalering = notisTexter(app).filter((t) => t.includes('har varit tyst i över'));
    expect(eskalering).toHaveLength(3);
    // DIRIGENTBESLUT 2026-08-21: trappan formaterade tidigare STEGETS tröskel,
    // så ett 25-timmarsavbrott som upptäcktes sent påstod "i över 1 h" — samma
    // underskattningsklass som K22 rättar för basnotiserna, bara 24× i stället
    // för 97×. Nu bär ALLA nivåer mätningen; nivåerna skiljs av NYCKELN.
    for (const text of eskalering) expect(text).toContain('tyst i över 1 dygn');
    expect(notisTexter(app).join('\n')).not.toContain('tyst i över 1 h');
    expect(notisTexter(app).join('\n')).not.toContain('tyst i över 4 h');
    // Etikettformen '1h' hör hemma i dedup-nyckeln, aldrig i en mening.
    expect(notisTexter(app).join('\n')).not.toMatch(/i över \d+h/);
    // NYCKLARNA är alltjämt unika per nivå — det är de, inte texten, som gör
    // att varje nivå bryter igenom 24h-dedupen för sig.
    expect(sentKeys(app)).toEqual([
      'aisstream:silent', 'aisstream:silent:1h', 'aisstream:silent:4h',
      'aisstream:silent:1 dygn',
    ]);
  });

  test('MÄTNINGEN STYR, INTE TRÖSKELN: samma steg, två olika uppmätta tider', async () => {
    // 65 min: bara 1h-steget är uppnått och mätningen ligger nära steget.
    const tidigt = makeHealthApp();
    tidigt._checkCrossFeedSilence(perFeed({ streamSilentMs: 65 * MIN }));
    await flush();
    expect(sentKeys(tidigt)).toEqual(['aisstream:silent', 'aisstream:silent:1h']);
    expect(notisTexter(tidigt).find((t) => t.includes('har varit tyst i över')))
      .toContain('tyst i över 1 h');

    // SAMMA steg (1h) men 25 h mätt — t.ex. ett avbrott som upptäcks först
    // efter en omstart. Texten måste följa mätningen, annars är den falsk.
    const sent = makeHealthApp();
    sent._checkCrossFeedSilence(perFeed({ streamSilentMs: 25 * H, uptimeMs: 40 * H }));
    await flush();
    const forsta = notisTexter(sent).find((t) => t.includes('har varit tyst i över'));
    expect(forsta).toContain('tyst i över 1 dygn');
    expect(forsta).not.toContain('tyst i över 1 h');
  });

  test('BLINDHETSVÄGEN har samma trappa och samma svenska ("efter 1 dygn")', async () => {
    const app = makeHealthApp();
    app._checkCrossFeedSilence(perFeed({
      streamSilentMs: 25 * H,
      streamConnected: false,
      hubDeliveredMsAgo: 25 * H,
      hubOkAgeMs: 25 * H,
      uptimeMs: 40 * H,
    }));
    await flush();

    expect(sentKeys(app)).toContain('feeds:silent:1 dygn');
    const dygn = notisTexter(app).find((t) => t.includes('efter 1 dygn'));
    expect(dygn).toContain('fortfarande INGEN AIS-data efter 1 dygn');
    // Alla tre nivåerna bär samma UPPMÄTTA tid (se TEXTERNA ovan) — här är
    // poängen svenskan: "efter 1 dygn", aldrig etikettens "efter 1h".
    const trappan = notisTexter(app).filter((t) => t.includes('fortfarande INGEN AIS-data'));
    expect(trappan).toHaveLength(3);
    for (const text of trappan) expect(text).toContain('efter 1 dygn');
  });

  test('SENTINELVAKTEN i trappan är kvar: ogiltigt mått ⇒ ingen notis, ett fel', () => {
    const app = makeHealthApp();
    app._escalateSilenceNotices('aisstream:silent', Infinity, (tidsfras) => `x ${tidsfras}`);
    expect(notisCount(app)).toBe(0);
    expect(app.error).toHaveBeenCalledWith(expect.stringContaining('ogiltigt tystnadsmått'));
  });
});

// =============================================================================
// D. K33 — [SNAPSHOT_PROCESS] ljuger inte längre om oförändrad text
// =============================================================================
describe('K33: "Bridge text changed" kräver faktisk skillnad', () => {
  const KLAFF = Object.values(BRIDGES).find((b) => b.name === 'Klaffbron');
  const TEXT = 'En båt på väg mot Klaffbron, beräknad broöppning om 16 minuter';

  const riggUiApp = () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._isConnected = true;
    app._lastConnectionLost = null;
    app._updateDeviceCapability = jest.fn();
    app._globalBridgeTextToken = null;
    app.vesselDataService = { hasGpsJumpHold: () => false };
    app.bridgeRegistry = {
      bridges: { klaffbron: KLAFF },
      getBridgeByName: (n) => (n === 'Klaffbron' ? KLAFF : null),
    };
    app.bridgeTextService = { generateBridgeText: jest.fn(() => TEXT) };
    return app;
  };

  const snapshot = () => ({
    vesselCount: 1,
    relevantVessels: [{
      mmsi: '265636940',
      targetBridge: 'Klaffbron',
      status: 'en-route',
      etaMinutes: 16,
    }],
    vesselsBeingRemoved: new Set(),
    timestamp: Date.now(),
  });

  const debugRader = (app) => app.debug.mock.calls.map((c) => String(c[0])).join('\n');

  test('IDENTISK HASH + minutforcering ⇒ "oförändrad", ALDRIG "Bridge text changed"', async () => {
    const app = riggUiApp();
    // Fältets läge (rad 89409/89411): samma text, samma hash 406317646, och
    // minutforceringen öppnar skrivblocket ändå.
    app._lastBridgeText = TEXT;
    app._lastBridgeTextHash = app._hashString(TEXT);
    app._lastBridgeTextUpdate = Date.now() - 61 * 1000;

    await app._processUIUpdate(snapshot());

    expect(debugRader(app)).toContain('[SNAPSHOT_PROCESS] Bridge text oförändrad');
    expect(debugRader(app)).not.toContain('Bridge text changed');
  });

  test('FREKVENSEN ÄR ORÖRD: enheten skrivs fortfarande vid minutforcering', async () => {
    // C3a-läxan: varje churn-reducerande ändring flyttar golden-text, och C3a
    // reverterades av just det skälet. K33 rör BARA loggraden.
    const app = riggUiApp();
    app._lastBridgeText = TEXT;
    app._lastBridgeTextHash = app._hashString(TEXT);
    app._lastBridgeTextUpdate = Date.now() - 61 * 1000;

    await app._processUIUpdate(snapshot());

    const skrivna = app._updateDeviceCapability.mock.calls
      .filter((c) => c[0] === 'bridge_text').map((c) => c[1]);
    expect(skrivna).toEqual([TEXT]);
    // …och [UI_REFRESH] (keepalive), inte [UI_UPDATE] (äkta ändring).
    const loggat = app.log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(loggat).toContain('[UI_REFRESH]');
    expect(loggat).not.toContain('[UI_UPDATE]');
  });

  test('ÄKTA ÄNDRING ⇒ "Bridge text changed", aldrig "oförändrad"', async () => {
    const app = riggUiApp();
    app._lastBridgeText = 'En båt på väg mot Klaffbron, beräknad broöppning om 21 minuter';
    app._lastBridgeTextHash = app._hashString(app._lastBridgeText);
    app._lastBridgeTextUpdate = Date.now();

    await app._processUIUpdate(snapshot());

    expect(debugRader(app)).toContain('✅ [SNAPSHOT_PROCESS] Bridge text changed');
    expect(debugRader(app)).not.toContain('Bridge text oförändrad');
    const loggat = app.log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(loggat).toContain('[UI_UPDATE]');
  });

  test('NULL-SENTINELEN (hash rensad, text kvar) räknas som ÄNDRING, som förut', async () => {
    // CG2-15: hash=null + samma sträng måste fortsätta tvinga omskrivning
    // efter timeout/fel — K33 får inte klassa om den vägen till "unchanged".
    const app = riggUiApp();
    app._lastBridgeText = TEXT;
    app._lastBridgeTextHash = null;
    app._lastBridgeTextUpdate = Date.now();

    await app._processUIUpdate(snapshot());

    expect(debugRader(app)).toContain('Bridge text changed');
    expect(debugRader(app)).not.toContain('Bridge text oförändrad');
  });

  test('FÖRSTA TEXTEN (tom cache) är en ändring, inte en tomgångsskrivning', async () => {
    const app = riggUiApp();
    app._lastBridgeText = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;
    app._lastBridgeTextHash = app._hashString(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    app._lastBridgeTextUpdate = 0;

    await app._processUIUpdate(snapshot());

    expect(debugRader(app)).toContain('Bridge text changed');
  });

  test('FRASKOLLISIONEN: de två "oförändrad"-raderna är GREPBART skilda', async () => {
    // Granskningen 2026-08-21: K33-raden hette "Bridge text unchanged", precis
    // som 📱 [UI_UPDATE] Bridge text unchanged xN (last 60s) — två HELT olika
    // händelser (enheten SKRIVS med samma text vs INGEN skrivning alls). En
    // fältanalys som greppade frasen dubbelräknade dem. Svenskan separerar
    // dem utan att röra den befintliga, greppade [UI_UPDATE]-taggen.
    const skriven = riggUiApp();
    skriven._lastBridgeText = TEXT;
    skriven._lastBridgeTextHash = skriven._hashString(TEXT);
    skriven._lastBridgeTextUpdate = Date.now() - 61 * 1000; // minutforcering
    await skriven._processUIUpdate(snapshot());
    expect(debugRader(skriven)).toContain('[SNAPSHOT_PROCESS] Bridge text oförändrad');
    expect(debugRader(skriven)).not.toContain('Bridge text unchanged');

    // Den ANDRA händelsen: ingen skrivning alls (ingen minutforcering) ⇒
    // aggregeringsraden, som behåller sin engelska frasering och sin tagg.
    const oskriven = riggUiApp();
    oskriven._lastBridgeText = TEXT;
    oskriven._lastBridgeTextHash = oskriven._hashString(TEXT);
    oskriven._lastBridgeTextUpdate = Date.now(); // fönstret öppnar inte
    oskriven._unchangedCount = 3;
    oskriven._unchangedWindowStart = Date.now() - 61 * 1000;
    await oskriven._processUIUpdate(snapshot());
    expect(debugRader(oskriven)).toContain('[UI_UPDATE] Bridge text unchanged x4 (last 60s)');
    expect(debugRader(oskriven)).not.toContain('Bridge text oförändrad');
    // …och ingen enhetsskrivning skedde i den grenen (det är hela skillnaden).
    expect(oskriven._updateDeviceCapability.mock.calls
      .filter((c) => c[0] === 'bridge_text')).toHaveLength(0);
  });
});
