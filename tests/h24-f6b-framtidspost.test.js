'use strict';

jest.mock('homey');

const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');
const { AIS_CONFIG } = require('../lib/constants');

/**
 * H24 (helkodsgranskning runda 1, 2026-08-22) — F6b BEVIS A: EN
 * framtidsdaterad hubbpost förgiftade den GLOBALA klockoffseten.
 *
 * FÄLTFALLET (reproducerat genom hela muxen i 'both'-läget av granskningen):
 * en post 700 s framåt satte hubOffsetMs till −700 000 ms, och eftersom
 * offseten ÅLDRAR varje hub-fix innan F4b prövar den avvisades SAMTLIGA
 * följande hubbfixar som fix_too_old i hela offsetfönstret (30 min) —
 * noll accepterade medan aisstream var nere, mot 22 utan giftposten.
 * Bevis B hade fått median + minimiurval redan i A12/F-22; bevis A hade
 * ren min utan minimiurval, utan korroborering och utan magnitudtak.
 *
 * Testerna kör den RIKTIGA muxen (samma väg som REPLAY_FUSION), inte en
 * stub: hela kedjan observeClock → shouldAccept → emit prövas.
 */

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

/** Hubbpost i pipelinens normaliserade form. */
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

const POISON_MMSI = '265999999'; // bruten transponder / fel epok
const FRISKA = ['265001111', '265002222', '265003333'];
const GIFT_FRAMAT_MS = 700 * 1000; // granskningens reproducerade värde
const HUB_LEVERANSLAGG_MS = 30 * 1000; // nattens medianlagg (27,5 s)

describe('H24: framtidsdaterad hubbpost får inte svälta hubbkällan', () => {
  let mux;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    // Direkt config-poke (samma väg som REPLAY_FUSION och etapp 3-testerna).
    mux._config.source = 'both';
  });

  afterEach(() => {
    mux.disconnect();
    mux = null;
    jest.useRealTimers();
  });

  test('FÄLTFALLET: en giftpost dödar inte de 30 följande minuternas hubbfixar', () => {
    const received = [];
    mux.on('ais-message', (e) => received.push(e));
    const t0 = Date.now();

    // 1) Giftposten: EN post vars fixtid ligger 700 s framåt.
    mux._ingestFromFeed('aishub', hubMsg(POISON_MMSI, t0 + GIFT_FRAMAT_MS, t0, 0.01));

    // 2) aisstream är nere; hubben pollar vidare i 30 minuter (65 s kadens)
    //    med FRISKA fixar för tre andra fartyg.
    const POLLAR = Math.floor(AIS_CONFIG.FUSION.CLOCK_OFFSET_WINDOW_MS / 65000);
    for (let i = 1; i <= POLLAR; i++) {
      const now = t0 + i * 65000;
      jest.setSystemTime(now);
      FRISKA.forEach((mmsi, k) => {
        mux._ingestFromFeed('aishub', hubMsg(
          mmsi, now - HUB_LEVERANSLAGG_MS, now, 0.0001 * i + 0.001 * k,
        ));
      });
    }

    const friskaAccepterade = received.filter((m) => FRISKA.includes(m.mmsi));
    // FÖRE H24: 0 accepterade (hubOffsetMs = −700 000 ⇒ fix_too_old på allt).
    expect(friskaAccepterade).toHaveLength(FRISKA.length * POLLAR);
    const { fusion } = mux.getConnectionStats();
    expect(fusion.byReason.fix_too_old || 0).toBe(0);
    // En ensam avvikare får inte driva den globala offseten alls.
    expect(mux._fusionClock.hubOffsetMs).toBe(0);
    // …men den SYNS: livstidsräknaren är hela poängen med diagnostiken.
    expect(mux._fusionClock.hubAheadSamples).toBe(1);
  });

  test('giftposten avväpnar inte längre skevgrinden — den fälls SJÄLV', () => {
    const received = [];
    mux.on('ais-message', (e) => received.push(e));
    const t0 = Date.now();

    mux._ingestFromFeed('aishub', hubMsg(POISON_MMSI, t0 + GIFT_FRAMAT_MS, t0));

    // FÖRE H24: offseten drogs ned till −700 s FÖRE beslutet, den korrigerade
    // stämpeln landade EXAKT på now, F4a:s framtidsklamp fyrade därför aldrig
    // och hub_clock_skew-grinden (som avvisar just en klampad stämpel) släppte
    // igenom posten — skevgrinden avväpnades alltså av skeven själv.
    expect(received).toHaveLength(0);
    const { fusion } = mux.getConnectionStats();
    expect(fusion.accepted).toBe(0);
    expect(fusion.byReason.hub_clock_skew).toBe(1);
  });

  test('F6b LEVER: en äkta serverskev som flera fartyg bekräftar kompenseras', () => {
    const t0 = Date.now();
    const SKEV_MS = 45 * 1000;
    FRISKA.forEach((mmsi, k) => {
      mux._ingestFromFeed('aishub', hubMsg(mmsi, t0 + SKEV_MS, t0, 0.001 * k));
    });
    expect(mux._fusionClock.hubOffsetMs).toBe(-SKEV_MS);
  });

  test('MAGNITUDTAKET: även en korroborerad extremskev lämnar hubben levande', () => {
    const received = [];
    mux.on('ais-message', (e) => received.push(e));
    const t0 = Date.now();

    // Alla tre fartygen 700 s före ⇒ korroborerad (och därmed trovärdig)
    // skev — men magnituden får ändå inte åldra bort hela källan.
    FRISKA.forEach((mmsi, k) => {
      mux._ingestFromFeed('aishub', hubMsg(mmsi, t0 + GIFT_FRAMAT_MS, t0, 0.001 * k));
    });
    const tak = Math.floor(AIS_CONFIG.FUSION.MAX_FIX_AGE_MS / 2);
    expect(mux._fusionClock.hubOffsetMs).toBe(-tak);

    // En färsk fix från ett FJÄRDE fartyg passerar fortfarande F4b.
    const now = t0 + 65000;
    jest.setSystemTime(now);
    mux._ingestFromFeed('aishub', hubMsg('265004444', now - HUB_LEVERANSLAGG_MS, now, 0.004));
    expect(received.some((m) => m.mmsi === '265004444')).toBe(true);
    expect(mux.getConnectionStats().fusion.byReason.fix_too_old || 0).toBe(0);
  });
});
