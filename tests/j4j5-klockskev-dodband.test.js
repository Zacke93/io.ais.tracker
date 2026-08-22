'use strict';

jest.mock('homey');

const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const { AIS_CONFIG } = require('../lib/constants');

/**
 * J4 + J5 (helkodsgranskning runda 2, 2026-08-22) — H24 ÖPPNADE TVÅ NYA VÄGAR
 * TILL TOTAL AISHUB-BLACKOUT, tvärtemot sitt eget docblock.
 *
 * J4 (magnitudklampen): clockOffsetMaxMagnitude kapar kompensationen vid
 * MAX_FIX_AGE_MS/2. Restskeven som taket lämnade kvar klampades av F4a, F4a
 * satte clockSkew, och F6:s skevgrind avvisade därför VARJE hubbfix i
 * skevbandet ca 480-720 s (över 720 s stoppas posten redan av AISHubClients
 * futureJunk-grind). Docblocket lovade motsatsen: "hubben fortsätter flöda,
 * värsta utfall en dubbelnotis".
 *
 * J5 (minimiurvalet): estimateHubLagBound returnerade null under
 * CLOCK_LAG_MIN_VESSELS distinkta MMSI ⇒ offset 0 ⇒ en hubbklocka mer än
 * FUTURE_CLAMP_MS före gav samma totalavslag. Bevis B kan inte täcka upp
 * (pairLags fylls bara aisstream→aishub och är tom när aisstream är nere).
 * Fältmätt på 1,7-2,7 % av pollarna, längst 25-37 min i sträck.
 *
 * Testerna kör den RIKTIGA muxen i 'both'-läge — samma väg som REPLAY_FUSION
 * — och matar ENBART aishub, vilket är exakt produktionsläget sedan
 * aisstream-serverdöden: konfigurationen säger 'both', men bara hubben
 * levererar.
 */

const CFG = AIS_CONFIG.FUSION;
const FULLT_TAK = Math.floor(CFG.MAX_FIX_AGE_MS / 2); // 360 s
const TUNT_TAK = CFG.FUTURE_CLAMP_MS + 30000; // 150 s, se CLOCK_THIN_SAMPLE_MARGIN_MS

function makeLogger() {
  return { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function makeStore() {
  const data = {};
  return {
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => {
      data[k] = v;
    },
  };
}

/** Hubbpost i pipelinens normaliserade form (samma fabrik som H24-testet). */
function hubMsg(mmsi, fixTs, now, latOffset = 0) {
  return {
    mmsi,
    msgType: 'AISHubPosition',
    lat: 58.29 + latOffset,
    lon: 12.29,
    sog: 5,
    cog: 25,
    navStatus: null,
    shipName: `BAT_${mmsi}`,
    timestamp: now,
    fixTs,
    fixFeed: 'aishub',
    fixTsQuality: 'true-fix',
  };
}

const FRISKA = ['265001111', '265002222', '265003333'];
const LEVERANSLAGG_MS = 30 * 1000; // nattens medianlagg (27,5 s avrundat)

/**
 * Kör N pollar där hubbens klocka ligger `skevMs` FÖRE Homeys.
 * Hubben stämplar fixen med sin egen klocka: fixTs = now − lagg + skev.
 * @returns {{mux: object, mottagna: Array}}
 */
function koerSkevSvit({
  skevMs, laggMs = LEVERANSLAGG_MS, fartyg = FRISKA, pollar = 20,
}) {
  const mux = new AISSourceMultiplexer(makeLogger(), makeStore());
  mux._config.source = 'both';
  const mottagna = [];
  mux.on('ais-message', (e) => mottagna.push(e));
  const t0 = Date.now();
  for (let i = 0; i < pollar; i++) {
    const now = t0 + i * 65000; // AISHubs pollkadens
    jest.setSystemTime(now);
    fartyg.forEach((mmsi, k) => {
      mux._ingestFromFeed('aishub', hubMsg(
        mmsi, now - laggMs + skevMs, now, 0.0001 * i + 0.001 * k,
      ));
    });
  }
  return { mux, mottagna };
}

/**
 * J4:s undantag är observerbart PER BESLUT på shouldAccepts verdikt — och
 * ingen annanstans. Den livstidsräknare fixen först bar (clockSkewCapBypasses
 * i klockstatet) togs bort i granskningen av runda 2 eftersom den skrevs men
 * aldrig lästes: både [FUSION_HEALTH] och getConnectionStats bor i muxen och
 * renderade den inte. Hjälparen kör därför policyns RIKTIGA beslutsväg på en
 * färsk hubbfix med muxens LEVANDE offset — samma två funktioner som muxen
 * själv anropar.
 * @returns {boolean} true när artefaktundantaget släppte igenom fixen
 */
function undantagetFyrar(mux, skevMs, laggMs = LEVERANSLAGG_MS) {
  const { createState, shouldAccept } = require('../lib/connection/FixFusionPolicy');
  const now = Date.now();
  const prov = hubMsg('265009999', now - laggMs + skevMs, now, 0.02);
  const verdikt = shouldAccept(createState(), prov, now, CFG, {
    feed: 'aishub', hubOffsetMs: mux._fusionClock.hubOffsetMs,
  });
  return verdikt.clockSkewCapBypass === true;
}

describe('J4: magnitudklampens dödband — hubben måste överleva sin egen skyddsklamp', () => {
  let mux;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
  });

  afterEach(() => {
    if (mux) mux.disconnect();
    mux = null;
    jest.useRealTimers();
  });

  test('DÖDBANDET: skev 630 s ⇒ hubbfixar accepteras igen (före fixen 0 av 60)', () => {
    const svit = koerSkevSvit({ skevMs: 630 * 1000, pollar: 20 });
    mux = svit.mux;

    // FÖRE J4: 0 accepterade — offseten kapades vid 360 s, restskeven 240 s
    // klampades av F4a och hub_clock_skew fälldes på varje enskild post.
    expect(svit.mottagna.length).toBeGreaterThan(0);
    const { fusion } = mux.getConnectionStats();
    expect(fusion.byReason.hub_clock_skew || 0).toBeLessThan(FRISKA.length * 20);
    // Kompensationen står på det FULLA taket ⇒ skattningen var korroborerad.
    expect(mux._fusionClock.hubOffsetMs).toBe(-FULLT_TAK);
    // Undantaget är det som släpper igenom fixen — läses på verdiktet.
    expect(undantagetFyrar(mux, 630 * 1000)).toBe(true);
    // Exakt bokföring: de två FÖRSTA posterna faller fortfarande, eftersom
    // urvalet då bara har ett respektive två fartyg (tunt tak ⇒ inget
    // undantag). Från det tredje fartyget och framåt flödar källan.
    expect(svit.mottagna).toHaveLength(FRISKA.length * 20 - 2);
    expect(fusion.byReason.hub_clock_skew).toBe(2);
  });

  test('UNDER dödbandet är beteendet oförändrat: skev 300 s ⇒ full kompensation, inget undantag', () => {
    const svit = koerSkevSvit({ skevMs: 300 * 1000, pollar: 5 });
    mux = svit.mux;

    // 300 − 30 = 270 s < taket 360 s ⇒ klampen binder aldrig och F4a fyrar
    // aldrig. Ingen post ska behöva artefaktundantaget.
    expect(mux._fusionClock.hubOffsetMs).toBe(-(300 * 1000 - LEVERANSLAGG_MS));
    expect(undantagetFyrar(mux, 300 * 1000)).toBe(false);
    expect(svit.mottagna).toHaveLength(FRISKA.length * 5 - 2);
  });

  test('GRÄNSEN mäts exakt: restskev 120 s klampas inte, 120 s + 1 ms gör det', () => {
    // Restskev = (skev − lagg) − fulla taket. F4a fyrar först STRIKT över
    // FUTURE_CLAMP_MS, så gränsskeven är lagg + taket + FUTURE_CLAMP_MS.
    const gransSkev = LEVERANSLAGG_MS + FULLT_TAK + CFG.FUTURE_CLAMP_MS;

    const pa = koerSkevSvit({ skevMs: gransSkev, pollar: 2 });
    expect(undantagetFyrar(pa.mux, gransSkev)).toBe(false); // exakt på gränsen
    expect(pa.mottagna).toHaveLength(FRISKA.length * 2 - 2);
    pa.mux.disconnect();

    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    const over = koerSkevSvit({ skevMs: gransSkev + 1, pollar: 2 });
    mux = over.mux;
    expect(undantagetFyrar(over.mux, gransSkev + 1)).toBe(true);
    expect(over.mottagna).toHaveLength(FRISKA.length * 2 - 2);
  });

  test('INVARIANTEN accept ⇔ shouldAccept håller genom undantaget (classifyAll speglar det)', () => {
    const {
      createState, createClockState, observeClock, shouldAccept, classifyAll,
    } = require('../lib/connection/FixFusionPolicy');
    const now = Date.now();
    // Sveper skevar rakt genom och förbi dödbandet.
    for (const skev of [0, 100, 300, 480, 481, 510, 630, 700].map((s) => s * 1000)) {
      const clock = createClockState();
      const state = createState();
      const msgs = FRISKA.map((mmsi) => hubMsg(mmsi, now - LEVERANSLAGG_MS + skev, now));
      msgs.forEach((m) => observeClock(clock, null, m, 'aishub', now, CFG));
      const ctx = { feed: 'aishub', hubOffsetMs: clock.hubOffsetMs };
      const prov = hubMsg('265009999', now - LEVERANSLAGG_MS + skev, now, 0.01);
      const alla = classifyAll(state, { ...prov }, now, CFG, ctx);
      const ett = shouldAccept(state, { ...prov }, now, CFG, ctx);
      expect(alla.accept).toBe(ett.accept);
      if (ett.accept && ett.clockSkewCapBypass) {
        // Undantaget fyrade ⇒ skevorsaken får INTE finnas i profilen.
        expect(alla.reasons).not.toContain('hub_clock_skew');
      }
    }
  });

  /**
   * J4:s DOCBLOCK, RÄTTAT (granskningen av runda 2, 2026-08-22). Predikatet
   * offsetStandsAtMaxMagnitude påstod förut att en offset på det fulla taket
   * ENTYDIGT betydde "bevis A korroborerat av minst CLOCK_LAG_MIN_VESSELS
   * fartyg". Det är fel: bevis B (medianen över korskälleparen, bakom
   * CLOCK_PAIR_MIN_SAMPLES) går rakt in i bound utan att passera det tunna
   * taket. Det predikatet FAKTISKT bevisar är "inte det tunna urvalet" — och
   * båda de kvarvarande vägarna bär sitt eget minimiurval. De två testerna
   * nedan låser exakt de två halvorna av den meningen.
   */
  test('TUNT URVAL NÅR ALDRIG FULLA TAKET — oavsett hur galen skräpklockan är', () => {
    // Ett enda fartyg ⇒ bevis A är okorroborerat hela vägen. Svepet går långt
    // förbi både dödbandet och F4b:s budget.
    for (const skev of [200, 400, 630, 1200, 5000].map((sek) => sek * 1000)) {
      jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
      const svit = koerSkevSvit({
        skevMs: skev, laggMs: 20 * 1000, fartyg: ['265001111'], pollar: 4,
      });
      expect(svit.mux._fusionClock.hubOffsetMs).not.toBe(-FULLT_TAK);
      expect(svit.mux._fusionClock.hubOffsetMs).toBeGreaterThanOrEqual(-TUNT_TAK);
      expect(undantagetFyrar(svit.mux, skev, 20 * 1000)).toBe(false);
      svit.mux.disconnect();
    }
  });

  test('BEVIS B ÄR DEN ANDRA VÄGEN TILL TAKET — takad av CLOCK_PAIR_MAX_SKEW_MS i dag', () => {
    const {
      createState, createClockState, observeClock, applyAccept, shouldAccept,
    } = require('../lib/connection/FixFusionPolicy');
    const now = Date.now();
    const SKEV = 580 * 1000; // hubbklockan 580 s före Homeys
    const HUB_FIX = now - LEVERANSLAGG_MS + SKEV; // = now + 550 s

    /**
     * Fyller pairLags via den RIKTIGA bokföringen: applyAccept skriver
     * lastContent för aisstream, observeClock läser den. ETT fartyg, så
     * bevis A förblir okorroborerat och kan aldrig ensamt nå fulla taket.
     */
    function koerParbevis(cfg) {
      const clock = createClockState();
      const state = createState();
      const gemensam = {
        mmsi: '265004444', lat: 58.29, lon: 12.29, sog: 5, cog: 25,
      };
      for (let i = 0; i < CFG.CLOCK_PAIR_MIN_SAMPLES + 2; i++) {
        applyAccept(state, { ...gemensam, fixTs: now }, now, now, 'aisstream');
        observeClock(clock, state, { ...gemensam, fixTs: HUB_FIX }, 'aishub', now, cfg);
      }
      return clock;
    }

    // ARM 1 — dagens konstanter: pargrinden (90 s) kastar varje par, så bevis
    // B bidrar inte alls och offseten stannar på det TUNNA taket.
    const idag = koerParbevis(CFG);
    expect(idag.pairLags).toHaveLength(0);
    expect(idag.pairsDroppedStale).toBeGreaterThan(0);
    expect(idag.hubOffsetMs).toBe(-TUNT_TAK);

    // ARM 2 — samma indata med en HÖGRE pargrind: nu bildas paren, medianen
    // (−550 s) drar bound förbi fulla taket och offseten står på -FULLT_TAK
    // UTAN att bevis A är korroborerat. Det är precis det fall ordet
    // "entydigt" i det gamla docblocket uteslöt.
    const bredPargrind = { ...CFG, CLOCK_PAIR_MAX_SKEW_MS: 700 * 1000 };
    const hojd = koerParbevis(bredPargrind);
    expect(hojd.pairLags.length).toBeGreaterThanOrEqual(CFG.CLOCK_PAIR_MIN_SAMPLES);
    expect(hojd.hubOffsetMs).toBe(-FULLT_TAK);

    // … och undantaget fyrar då, drivet av bevis B ensamt.
    const prov = hubMsg('265009999', HUB_FIX, now, 0.02);
    const verdikt = shouldAccept(createState(), prov, now, bredPargrind, {
      feed: 'aishub', hubOffsetMs: hojd.hubOffsetMs,
    });
    expect(verdikt.accept).toBe(true);
    expect(verdikt.clockSkewCapBypass).toBe(true);

    // Kontroll: med dagens grind avvisas samma prov av skevgrinden, eftersom
    // offseten då står på det TUNNA taket och undantaget inte gäller där.
    const kontroll = shouldAccept(createState(), hubMsg('265009999', HUB_FIX, now, 0.02), now, CFG, {
      feed: 'aishub', hubOffsetMs: idag.hubOffsetMs,
    });
    expect(kontroll.accept).toBe(false);
    expect(kontroll.reason).toBe('hub_clock_skew');
  });
});

describe('J5: minimiurvalet styr STORLEKEN, inte existensen', () => {
  let mux;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
  });

  afterEach(() => {
    if (mux) mux.disconnect();
    mux = null;
    jest.useRealTimers();
  });

  test('LÅGTRAFIKFALLET: ETT fartyg, hubbklocka +180 s ⇒ 12 av 12 pollar accepteras (före fixen 0)', () => {
    const svit = koerSkevSvit({
      skevMs: 180 * 1000, laggMs: 20 * 1000, fartyg: ['265001111'], pollar: 12,
    });
    mux = svit.mux;

    // FÖRE J5: offset 0 ⇒ stämpeln låg 160 s fram ⇒ F4a klampade ⇒
    // hub_clock_skew på varje poll ⇒ appen datalös i hela lågtrafikfönstret.
    expect(svit.mottagna).toHaveLength(12);
    expect(mux.getConnectionStats().fusion.byReason.hub_clock_skew || 0).toBe(0);
    // Räddningskompensationen står på det TUNNA taket …
    expect(mux._fusionClock.hubOffsetMs).toBe(-TUNT_TAK);
    // … och behövde INTE artefaktundantaget: 160 − 150 = 10 s < 120 s ⇒
    // stämpeln landar innanför F4a helt utan klamp.
    expect(undantagetFyrar(mux, 180 * 1000, 20 * 1000)).toBe(false);
  });

  test('TAKET HÅLLER: ETT fartyg med +2000 s skräpklocka kan inte åldra bort källan', () => {
    const svit = koerSkevSvit({
      skevMs: 2000 * 1000, laggMs: 20 * 1000, fartyg: ['265999999'], pollar: 3,
    });
    mux = svit.mux;

    expect(mux._fusionClock.hubOffsetMs).toBe(-TUNT_TAK);
    expect(mux._fusionClock.hubOffsetMs).toBeGreaterThanOrEqual(-(CFG.FUTURE_CLAMP_MS + 30000));
    // H24:s garanti står kvar: den ensamma avvikaren fälls av skevgrinden
    // SJÄLV (undantaget gäller bara det fulla, korroborerade taket) …
    expect(svit.mottagna).toHaveLength(0);
    expect(mux.getConnectionStats().fusion.byReason.hub_clock_skew).toBe(3);
    // … och kan aldrig göra F4b till blackout: 150 s är långt under 720 s.
    expect(mux.getConnectionStats().fusion.byReason.fix_too_old || 0).toBe(0);
  });

  test('H24 ORÖRD UNDER KLAMPEN: en ensam post 45 s fram driver fortfarande NOLL kompensation', () => {
    const svit = koerSkevSvit({
      skevMs: 45 * 1000 + LEVERANSLAGG_MS, fartyg: ['265001111'], pollar: 1,
    });
    mux = svit.mux;
    // Skattningen är −45 s, alltså INNANFÖR FUTURE_CLAMP_MS: det finns ingen
    // grind att rädda från, och då gäller H24:s regel oförändrat.
    expect(mux._fusionClock.hubOffsetMs).toBe(0);
    expect(mux._fusionClock.hubAheadSamples).toBe(1); // syns ändå i diagnostiken
    expect(svit.mottagna).toHaveLength(1); // 45 s < 120 s ⇒ ingen klamp
  });

  test('KORROBORERING SLÄPPER TAKET: samma skev med tre fartyg ger fulla magnituden', () => {
    const SKEV = 400 * 1000;
    const en = koerSkevSvit({ skevMs: SKEV, fartyg: ['265001111'], pollar: 1 });
    expect(en.mux._fusionClock.hubOffsetMs).toBe(-TUNT_TAK);
    en.mux.disconnect();

    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    const tre = koerSkevSvit({ skevMs: SKEV, fartyg: FRISKA, pollar: 1 });
    mux = tre.mux;
    // 400 − 30 = 370 s > fulla taket 360 s ⇒ taket binder, men på RÄTT nivå.
    expect(tre.mux._fusionClock.hubOffsetMs).toBe(-FULLT_TAK);
    expect(FULLT_TAK).toBeGreaterThan(TUNT_TAK); // regimerna kan skiljas åt
  });
});

/**
 * L21 (helkodsgranskning runda 3, 2026-08-22) — PARFÖNSTRET MÅSTE ÅLDRAS ÄVEN
 * NÄR AISSTREAM ÄR TYST.
 *
 * Åldrandet låg bara i pushClockSample, alltså bara på det som PUSHAS.
 * hubLags pushas per hubbmeddelande och självprunade därför; pairLags pushas
 * ENBART när ett korskällepar bildas, vilket kräver att aisstream levererar.
 * När aisstream tystnar — fältläget sedan serverdöden ~2026-08-05 — frös
 * parfönstret fast och en NEGATIV parmedian fortsatte styra hubOffsetMs långt
 * utanför CLOCK_OFFSET_WINDOW_MS (30 min).
 *
 * Testerna kör den RIKTIGA muxen i 'both' och den riktiga bokföringen
 * (applyAccept skriver lastContent för aisstream, observeClock läser den) —
 * inga handsatta klockstate.
 */
describe('L21: pairLags åldras oberoende av om nya par bildas', () => {
  // Fönstret som löftena vilar på: lib/constants.js CLOCK_OFFSET_WINDOW_MS.
  const FONSTER_MS = CFG.CLOCK_OFFSET_WINDOW_MS;
  // Parmedianen som fryser fast. −60 s ligger innanför pargrinden (90 s) så
  // paren bokförs, och är samtidigt grundare än FUTURE_CLAMP_MS (120 s) —
  // alltså kan BEVIS A inte ensamt förklara offseten i det här scenariot.
  const PARLAGG_MS = -60 * 1000;
  const MMSI = '265004444';

  /** Samma fysiska rapport, sedd av aisstream (mottagningsstämplad). */
  function streamMsg(now) {
    return {
      mmsi: MMSI,
      msgType: 'PositionReport',
      lat: 58.29,
      lon: 12.29,
      sog: 5,
      cog: 25,
      navStatus: null,
      shipName: 'PARBEVIS',
      timestamp: now,
      fixTs: now,
      fixFeed: 'aisstream',
      fixTsQuality: 'receipt',
    };
  }

  /** Hubbens eko av EXAKT samma rapport, med hubbklockans egen stämpel. */
  function hubEko(now, fixTs) {
    return {
      ...streamMsg(now), msgType: 'AISHubPosition', fixTs, fixFeed: 'aishub', fixTsQuality: 'true-fix',
    };
  }

  let mux;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
  });

  afterEach(() => {
    if (mux) mux.disconnect();
    mux = null;
    jest.useRealTimers();
  });

  /**
   * Fyller parfönstret med CLOCK_PAIR_MIN_SAMPLES + 2 par à PARLAGG_MS genom
   * hela muxen, och lämnar tillbaka den (aisstream tystnar sedan).
   */
  function fyllParfonstret() {
    const m = new AISSourceMultiplexer(makeLogger(), makeStore());
    m._config.source = 'both';
    const t0 = Date.now();
    for (let i = 0; i < CFG.CLOCK_PAIR_MIN_SAMPLES + 2; i++) {
      const now = t0 + i * 60000;
      jest.setSystemTime(now);
      m._ingestFromFeed('aisstream', streamMsg(now));
      // pairLag = aisstreams mottagning − hubbens fixTs.
      m._ingestFromFeed('aishub', hubEko(now, now - PARLAGG_MS));
    }
    return m;
  }

  test('FRYSNINGEN: par 3 h gamla styr inte längre offseten när aisstream tystnat', () => {
    mux = fyllParfonstret();
    // Utgångsläget (oförändrat av fixen): medianen −60 s äger offseten.
    expect(mux._fusionClock.pairLags.length)
      .toBeGreaterThanOrEqual(CFG.CLOCK_PAIR_MIN_SAMPLES);
    expect(mux._fusionClock.hubOffsetMs).toBe(PARLAGG_MS);

    // TRE TIMMAR SENARE, aisstream nere: bara hubben levererar, helt normala
    // fixar (30 s leveranslagg). Sex gånger fönstret har passerat.
    const senare = Date.now() + 3 * 3600000; // 6× CLOCK_OFFSET_WINDOW_MS
    jest.setSystemTime(senare);
    mux._ingestFromFeed('aishub', {
      ...hubEko(senare, senare - LEVERANSLAGG_MS), mmsi: '265007777', lat: 58.3,
    });

    // FÖRE FIXEN: pairLags hade kvar alla 12 (äldsta 180 min = 6× fönstret)
    // och hubOffsetMs stod kvar på −60 000.
    expect(mux._fusionClock.pairLags).toHaveLength(0);
    expect(mux._fusionClock.hubOffsetMs).toBe(0);
  });

  test('UPPMÄTT SKADA: en laglig 700 s gammal hubbfix avvisades fix_too_old', () => {
    const { createState, shouldAccept } = require('../lib/connection/FixFusionPolicy');
    mux = fyllParfonstret();
    const senare = Date.now() + 3 * 3600000;
    jest.setSystemTime(senare);
    mux._ingestFromFeed('aishub', {
      ...hubEko(senare, senare - LEVERANSLAGG_MS), mmsi: '265007777', lat: 58.3,
    });

    // 700 s < F4b:s budget MAX_FIX_AGE_MS (720 s) ⇒ fixen ÄR laglig.
    const gammal = { ...hubEko(senare, senare - 700000), mmsi: '265008888', lat: 58.31 };
    const verdikt = shouldAccept(createState(), gammal, senare, CFG, {
      feed: 'aishub', hubOffsetMs: mux._fusionClock.hubOffsetMs,
    });
    expect(verdikt.accept).toBe(true);
    // …och den emitteras med sin EGNA stämpel, inte backdaterad 60 s.
    expect(verdikt.fixTs).toBe(senare - 700000);

    // KONTRAST: med den frysta offseten (som HEAD behöll) åldras samma fix
    // 60 s extra ⇒ 760 s > 720 s ⇒ hela hubbkällan tystnar.
    const medFrusen = shouldAccept(createState(), gammal, senare, CFG, {
      feed: 'aishub', hubOffsetMs: PARLAGG_MS,
    });
    expect(medFrusen.accept).toBe(false);
    expect(medFrusen.reason).toBe('fix_too_old');
  });

  test('EXAKT GRÄNS: ett par precis inom fönstret överlever, ett millisekund utanför gör det inte', () => {
    const {
      createClockState, createState, observeClock, applyAccept,
    } = require('../lib/connection/FixFusionPolicy');
    const t0 = Date.now();

    /** @returns {number} antal par kvar efter att `dt` ms förflutit utan ny push */
    const kvarEfter = (dt) => {
      const clock = createClockState();
      const state = createState();
      for (let i = 0; i < CFG.CLOCK_PAIR_MIN_SAMPLES + 2; i++) {
        applyAccept(state, streamMsg(t0), t0, t0, 'aisstream');
        observeClock(clock, state, hubEko(t0, t0 - PARLAGG_MS), 'aishub', t0, CFG);
      }
      const antalFore = clock.pairLags.length;
      // Ett hubbmeddelande UTAN matchande aisstream-innehåll ⇒ ingen ny push.
      observeClock(clock, createState(), hubEko(t0 + dt, t0 + dt - LEVERANSLAGG_MS),
        'aishub', t0 + dt, CFG);
      return { antalFore, antalEfter: clock.pairLags.length, offset: clock.hubOffsetMs };
    };

    const inom = kvarEfter(FONSTER_MS);
    expect(inom.antalFore).toBe(CFG.CLOCK_PAIR_MIN_SAMPLES + 2);
    // `at < cutoff` är STRIKT: exakt på fönsterkanten sparas posten.
    expect(inom.antalEfter).toBe(inom.antalFore);
    expect(inom.offset).toBe(PARLAGG_MS);

    const utanfor = kvarEfter(FONSTER_MS + 1);
    expect(utanfor.antalEfter).toBe(0);
    expect(utanfor.offset).toBe(0);
  });

  test('SEMANTISKT NEUTRALT när par bildas normalt: samma fönster, samma offset', () => {
    // Pruningen är idempotent och körs med SAMMA `now` som pushen, så
    // prune→push→prune ger exakt samma fönster som push→prune. Ett sammanhållet
    // parflöde ska alltså vara bit-identiskt med HEAD.
    mux = fyllParfonstret();
    expect(mux._fusionClock.pairLags).toHaveLength(CFG.CLOCK_PAIR_MIN_SAMPLES + 2);
    expect(mux._fusionClock.pairLags.every((s) => s.v === PARLAGG_MS)).toBe(true);
    expect(mux._fusionClock.hubOffsetMs).toBe(PARLAGG_MS);
    // hubLags åldras precis som förut (den självprunade redan via pushen).
    expect(mux._fusionClock.hubLags).toHaveLength(CFG.CLOCK_PAIR_MIN_SAMPLES + 2);
  });

  test('BEVIS A rörs inte: hubLags prunas fortfarande på exakt samma villkor', () => {
    const { createClockState, observeClock } = require('../lib/connection/FixFusionPolicy');
    const t0 = Date.now();
    const clock = createClockState();
    for (let i = 0; i < 5; i++) {
      const now = t0 + i * 60000;
      observeClock(clock, null, hubEko(now, now - LEVERANSLAGG_MS), 'aishub', now, CFG);
    }
    expect(clock.hubLags).toHaveLength(5);
    // Ett meddelande så långt efter att ÄVEN det yngsta gamla samplet
    // (t0 + 4 × 60 s) faller utanför fönstret ⇒ bara det egna står kvar.
    const langtSenare = t0 + 4 * 60000 + FONSTER_MS + 1;
    observeClock(clock, null, hubEko(langtSenare, langtSenare - LEVERANSLAGG_MS),
      'aishub', langtSenare, CFG);
    expect(clock.hubLags).toHaveLength(1);
  });
});
