'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');

/**
 * =============================================================================
 * F2 (fältprovet 10–13 november 2026, körning 1) — KORSTYSTNADEN ÄR DEN TID
 * GRANNEN LEVT UNDER KÄLLANS PÅGÅENDE TYSTNAD
 * =============================================================================
 *
 * Förloppet i fält (k1 rad 24102–24262): Homey tappade nätet 02:20:48Z och
 * båda källorna var borta i 4,5 h. AISHub svarade igen 06:54:21Z. I nästa
 * monitoringtick, 06:55:09Z, gick tre tidslinjenotiser ut inom 17 ms:
 *   aisstream:silent:1h  "AISstream har varit tyst i över 4 h medan AISHub flödar"
 *   aisstream:silent:4h  samma text
 *   aisstream:silent     "… på 4 h medan AISHub flödar — anslutningen kan vara halvdöd"
 * AISHub hade flödat i 48 s. Talet var AISstreams tystnad, men påståendet
 * "medan AISHub flödar" bär mätningen bara för den tid grannen faktiskt levt
 * (BT-12: texten får inte påstå mer än mätningen bär).
 *
 * Rättningen (revision 1 efter granskningen H1): korstystnaden är den tid
 * under källans PÅGÅENDE tystnad då grannen levt, ACKUMULERAD över glapp.
 * Den första versionen nollställde vid varje glapp hos grannen över 210 s,
 * och då uteblev K22-trappan för en källa som var tyst i dygn medan grannen
 * hackade (bara basnotisen, "på 28 min" efter ett dygn). Nu drar ett glapp
 * bara av sin egen längd. Statusen (B2c) och tom-kanal-nätet (U12) läser
 * samma sorts mått (granskningen M2 och M3).
 *
 * Revision 2 (omgranskningen N1): episodens identitet tas ur lagrade
 * stämplar, inte ur now − tystnad, som flyttar sig med de millisekunder som
 * går mellan klientens statistik och vaktens now. Proven kör därför
 * förloppen med statistiken 0/1/2/50 ms före vaktens now (statsLag) och
 * genom den riktiga _checkAISFeedHealth med klockan stegad däremellan.
 */

const REAL_DATE_NOW = Date.now;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (iso) => Date.parse(iso);

const makeApp = ({ hubFeedsPipeline = true } = {}) => {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  app.debug = jest.fn();
  app.homey = {
    settings: { get: () => null, set: jest.fn(), on: jest.fn() },
    notifications: { createNotification: jest.fn().mockResolvedValue(undefined) },
  };
  app._hubFeedsPipeline = jest.fn().mockReturnValue(hubFeedsPipeline);
  // Bokför varje notis som faktiskt skickas (stämpeln sätts synkront före
  // await i _notifyConnectionIssue, så en ny stämpel = skickad).
  app._sent = [];
  const orig = app._notifyConnectionIssue.bind(app);
  app._notifyConnectionIssue = (message, key) => {
    const before = app._connectionIssueNotifiedAt ? app._connectionIssueNotifiedAt.get(key) : undefined;
    const p = orig(message, key);
    const after = app._connectionIssueNotifiedAt ? app._connectionIssueNotifiedAt.get(key) : undefined;
    if (after !== before) {
      app._sent.push({
        k: key, t: Date.now(), iso: new Date(Date.now()).toISOString(), text: message,
      });
    }
    return p;
  };
  return app;
};

const flush = () => new Promise((resolve) => {
  setImmediate(resolve);
});
const sentKeys = (app) => [...(app._connectionIssueNotifiedAt || new Map()).keys()];
const logText = (app) => app.log.mock.calls.map((c) => c.join(' ')).join('\n');

/**
 * perFeed.aisstream vid tiden t. `up` = socketen öppen sedan `openedAt`;
 * `lastMsg` = senaste levererade position (null = aldrig).
 */
/**
 * REVISION 2 (omgranskningen N1): klienterna räknar timeSinceLastMessage och
 * uptime med sin egen Date.now(), några millisekunder FÖRE korsvaktens now.
 * statsLag är den skillnaden; runTicks sätter den per tick. De absoluta
 * stämplarna (lastMessageTime, lastOkResponseAt) påverkas inte.
 */
let statsLag = 0;

function stream(t, { up, openedAt = null, lastMsg = null }) {
  const ts = t - statsLag;
  return {
    configured: true,
    isConnected: up,
    lastMessageTime: lastMsg,
    timeSinceLastMessage: lastMsg === null ? null : ts - lastMsg,
    uptime: up && openedAt !== null ? ts - openedAt : 0,
  };
}

/**
 * perFeed.aishub vid tiden t. `up` = klientens flank (Kontakt etablerad);
 * `lastOk` = senaste välformade svar; `lastMsg` = senaste levererade position.
 */
function hub(t, {
  up, openedAt = null, lastOk = null, lastMsg = null,
}) {
  const ts = t - statsLag;
  return {
    configured: true,
    isConnected: up,
    lastMessageTime: lastMsg,
    timeSinceLastMessage: lastMsg === null ? null : ts - lastMsg,
    uptime: up && openedAt !== null ? ts - openedAt : 0,
    lastOkResponseAt: lastOk,
  };
}

/** Senaste pollsvar ≤ t i en 65 s-kadens som startade vid `from`. */
const lastPoll = (t, from) => from + Math.floor((t - from) / 65000) * 65000;

/**
 * Kör monitoringtick varje minut från fromMs till toMs. Returnerar varje ny
 * notis med nyckel, tid och text (även nycklar som armas om efter 24 h).
 */
async function runTicks(app, perFeedAt, fromMs, toMs, onTick = null, lags = [0]) {
  const first = app._sent.length;
  let i = 0;
  for (let t = fromMs; t <= toMs; t += MIN) {
    Date.now = () => t;
    statsLag = lags[i % lags.length];
    i++;
    const perFeed = perFeedAt(t);
    statsLag = 0;
    app._checkCrossFeedSilence(perFeed);
    // eslint-disable-next-line no-await-in-loop
    await flush();
    if (onTick) onTick(t);
  }
  return app._sent.slice(first);
}

/** Statistiken 0, 1, 2 och 50 ms före korsvaktens now, växlande per tick. */
const SHAKY = [0, 1, 2, 50];

const iso = (ms) => new Date(ms).toISOString();
const keysOf = (sent, prefix) => sent.filter((s) => s.k.startsWith(prefix)).map((s) => s.k);

// k1:s tidsstämplar (rad 24102–24262)
const BOOT = at('2026-11-10T21:44:03Z');
const STREAM_LAST = at('2026-11-11T02:18:18Z');
const HUB_LAST_OK = at('2026-11-11T02:19:42Z');
const HUB_FLANK_DOWN = at('2026-11-11T02:27:20Z');
const HUB_BACK = at('2026-11-11T06:54:21Z');

/** k1: båda friska → nätet borta 4,5 h → hubben tillbaka, AISstream i timfasen. */
function k1PerFeed(t) {
  let s;
  if (t < at('2026-11-11T02:20:48Z')) {
    s = stream(t, { up: true, openedAt: BOOT, lastMsg: Math.min(t - 30 * SEC, STREAM_LAST) });
  } else {
    s = stream(t, { up: false, lastMsg: STREAM_LAST });
  }
  let h;
  if (t < HUB_LAST_OK) {
    const ok = lastPoll(t, BOOT);
    h = hub(t, {
      up: true, openedAt: BOOT, lastOk: ok, lastMsg: ok,
    });
  } else if (t < HUB_BACK) {
    h = hub(t, {
      up: t < HUB_FLANK_DOWN, openedAt: BOOT, lastOk: HUB_LAST_OK, lastMsg: HUB_LAST_OK,
    });
  } else {
    const ok = lastPoll(t, HUB_BACK);
    h = hub(t, {
      up: true, openedAt: HUB_BACK, lastOk: ok, lastMsg: ok,
    });
  }
  return { aisstream: s, aishub: h };
}

afterEach(() => {
  Date.now = REAL_DATE_NOW;
});

describe('F2: k1-förloppet — totalavbrott, sedan hubben tillbaka', () => {
  test('FÄLTFALLET: inga "tyst i över 4 h medan AISHub flödar"-notiser och ingen degraderad status 48 s efter hubbens återkomst', async () => {
    const app = makeApp();
    const sent = await runTicks(app, k1PerFeed, at('2026-11-11T02:00:09Z'), at('2026-11-11T06:54:09Z'));
    // Under avbrottet: blindhetslarmet (sant påstående, oförändrat).
    expect(keysOf(sent, 'feeds:silent')).toEqual(['feeds:silent', 'feeds:silent:1h', 'feeds:silent:4h']);
    expect(keysOf(sent, 'aisstream:silent')).toEqual([]);

    // 06:55:09 — ticken där fältet skickade tre notiser och skrev "degraded".
    const tick = await runTicks(app, k1PerFeed, at('2026-11-11T06:55:09Z'), at('2026-11-11T06:55:09Z'));
    expect(keysOf(tick, 'aisstream:silent')).toEqual([]);
    // M2: statusen läser samma mått som notisen (B2c) — ingen degradering än.
    expect(app._connectionFeedDegraded).toBeFalsy();
    // Loggraden behåller sitt prefix och säger hur korstystnaden räknats:
    // 02:18:18–02:23:09 med hubben levande (4 min 51 s) + 48 s sedan återkomsten.
    expect(logText(app)).toContain('aisstream har inte levererat på 277 min medan AISHub flödar');
    expect(logText(app)).toContain(
      '[korstystnad 6 min: så länge AISHub svarat under tystnaden; AISHub svarar oavbrutet sedan 06:54:21Z'
      + ' — notiserna väntar tills den passerat 15 min]',
    );
  });

  test('FÄLTFALLET: står AISstream kvar tyst kommer EN basnotis när grannen levt 15 min av tystnaden, och trappan växer därifrån', async () => {
    const app = makeApp();
    await runTicks(app, k1PerFeed, at('2026-11-11T02:00:09Z'), at('2026-11-11T06:55:09Z'));
    const sent = await runTicks(app, k1PerFeed, at('2026-11-11T06:56:09Z'), at('2026-11-11T08:00:09Z'));
    const keys = sent.filter((s) => s.k.startsWith('aisstream:silent'));
    expect(keys.map((s) => [s.k, s.iso])).toEqual([
      // 291 s före avbrottet + 48 s vid 06:55:09 + 60 s per tick ⇒ 939 s 07:05:09.
      ['aisstream:silent', '2026-11-11T07:05:09.000Z'],
      // 3 639 s 07:50:09 ⇒ 1h-steget. Före rättningen (rå tystnad) kom det 06:55:09.
      ['aisstream:silent:1h', '2026-11-11T07:50:09.000Z'],
    ]);
    expect(keys[0].text).toContain('på 15 min medan AISHub flödar');
    expect(keys[1].text).toContain('i över 1 h medan AISHub flödar');
    // M2: statusen degraderas i samma tick som basnotisen, inte före.
    expect(app._connectionFeedDegraded).toBe(true);
  });

  test('M2: statusen degraderas först i basnotisens tick', async () => {
    const app = makeApp();
    const degradedAt = [];
    await runTicks(app, k1PerFeed, at('2026-11-11T02:00:09Z'), at('2026-11-11T07:10:09Z'), (t) => {
      if (app._connectionFeedDegraded && degradedAt.length === 0) degradedAt.push(iso(t));
    });
    expect(degradedAt).toEqual(['2026-11-11T07:05:09.000Z']);
  });

  test('SPEGELFALLET: AISstream tillbaka först, AISHub förblir tyst — basnotisen efter 15 min levande granne, sedan 1h-steget, aldrig "4 h" direkt', async () => {
    const app = makeApp();
    const STREAM_BACK = at('2026-11-11T06:54:00Z');
    const HUB_LATE = at('2026-11-11T08:30:00Z');
    const perFeedAt = (t) => {
      const base = k1PerFeed(t);
      if (t >= STREAM_BACK) {
        base.aisstream = stream(t, { up: true, openedAt: STREAM_BACK, lastMsg: t - 20 * SEC });
      }
      if (t >= HUB_BACK) {
        base.aishub = t < HUB_LATE
          ? hub(t, {
            up: false, openedAt: null, lastOk: HUB_LAST_OK, lastMsg: HUB_LAST_OK,
          })
          : hub(t, {
            up: true, openedAt: HUB_LATE, lastOk: lastPoll(t, HUB_LATE), lastMsg: lastPoll(t, HUB_LATE),
          });
      }
      return base;
    };
    const sent = await runTicks(app, perFeedAt, at('2026-11-11T02:00:09Z'), at('2026-11-11T08:20:09Z'));
    const keys = sent.filter((s) => s.k.startsWith('aishub:silent'));
    // 207 s före avbrottet (latchen) + 9 s vid 06:54:09 + 60 s per tick.
    expect(keys.map((s) => [s.k, s.iso])).toEqual([
      ['aishub:silent', '2026-11-11T07:06:09.000Z'],
      ['aishub:silent:1h', '2026-11-11T07:51:09.000Z'],
    ]);
    expect(keys[0].text).toContain('på 15 min medan AISstream flödar');
    expect(keys[1].text).toContain('i över 1 h medan AISstream flödar');
    expect(keysOf(sent, 'aisstream:silent')).toEqual([]);
  });

  test('SKUGGLÄGE: skuggnotisen väntar in 15 min levande hubb, och tom-kanal-nätet räknar inte avbrottet (M3)', async () => {
    const app = makeApp({ hubFeedsPipeline: false });
    const STREAM_BACK = at('2026-11-11T06:55:30Z');
    const perFeedAt = (t) => {
      const base = k1PerFeed(t);
      if (t >= STREAM_BACK) base.aisstream = stream(t, { up: true, openedAt: STREAM_BACK, lastMsg: STREAM_LAST });
      return base;
    };
    const sent = await runTicks(app, perFeedAt, at('2026-11-11T02:00:09Z'), at('2026-11-11T07:15:09Z'));
    const shadow = sent.filter((s) => s.k === 'aisstream:silent:shadow');
    expect(shadow.map((s) => s.iso)).toEqual(['2026-11-11T07:05:09.000Z']);
    expect(shadow[0].text).toContain('på 15 min');
    // Före rättningen gick feeds:empty:4h ("svarar men ingen båtdata på 4 h")
    // i ticken efter AISstreams återkomst — då den inte svarat på 4,5 h.
    expect(sentKeys(app)).not.toContain('feeds:empty:4h');
  });

  test('M3: tom kanal efter totalavbrottet — "svarar men ingen båtdata på 4 h" först när källorna svarat i 4 h', async () => {
    // Granskarens prov E: båda borta 02:20–06:54, sedan svarar båda men
    // kanalen är tom. Före rättningen: notisen 06:55:03, 41 s efter återkomsten.
    const app = makeApp();
    const B = at('2026-11-11T00:00:03Z');
    const LAST = at('2026-11-11T02:18:18Z');
    const DOWN = at('2026-11-11T02:20:48Z');
    const BACK = at('2026-11-11T06:54:21Z');
    const perFeedAt = (t) => {
      const down = t >= DOWN && t < BACK;
      const from = t >= BACK ? BACK : B;
      const lastOk = down ? DOWN - 60 * SEC : from + Math.floor((t - from) / 65000) * 65000;
      return {
        aisstream: stream(t, { up: !down, openedAt: from, lastMsg: Math.min(t - 30 * SEC, LAST) }),
        aishub: hub(t, {
          up: !down || t < DOWN + 7 * MIN, openedAt: from, lastOk, lastMsg: Math.min(lastOk, LAST),
        }),
      };
    };
    const early = await runTicks(app, perFeedAt, B + MIN, at('2026-11-11T07:30:03Z'));
    expect(keysOf(early, 'feeds:empty')).toEqual([]);
    expect(logText(app)).toMatch(/kanalen är tom, inte appen blind \[alla källor har svarat \d+ min av tystnaden\]/);
    const late = await runTicks(app, perFeedAt, at('2026-11-11T07:31:03Z'), at('2026-11-11T11:30:03Z'));
    const empty = late.filter((s) => s.k === 'feeds:empty:4h');
    expect(empty).toHaveLength(1);
    // Källorna svarade ~5 min före avbrottet + från 06:54:21 ⇒ 4 h nås ~10:49.
    expect(empty[0].t).toBeGreaterThanOrEqual(at('2026-11-11T10:45:00Z'));
    expect(empty[0].t).toBeLessThanOrEqual(at('2026-11-11T10:55:00Z'));
    expect(empty[0].text).toContain('svarar men ingen båtdata på 4 h');
  });
});

describe('F2: ett glapp hos grannen drar bara av sin egen längd (granskningen H1)', () => {
  /** AISstream-socketen öppen och pongar men levererar inget från 02:20; hubben med ett glapp. */
  function glitchPerFeed(glitchFrom, glitchTo, { flankDown }) {
    const STREAM_SILENT_FROM = at('2026-11-11T02:20:00Z');
    return (t) => {
      let h;
      if (t >= glitchFrom && t < glitchTo) {
        h = hub(t, {
          up: !flankDown, openedAt: BOOT, lastOk: glitchFrom - 5 * SEC, lastMsg: glitchFrom - 5 * SEC,
        });
      } else {
        const from = t >= glitchTo ? glitchTo : BOOT;
        h = hub(t, {
          up: true, openedAt: flankDown ? from : BOOT, lastOk: lastPoll(t, from), lastMsg: lastPoll(t, from),
        });
      }
      return {
        aisstream: stream(t, { up: true, openedAt: BOOT, lastMsg: Math.min(t, STREAM_SILENT_FROM) }),
        aishub: h,
      };
    };
  }

  test('kort hubbglapp inom svarsfönstret (en missad poll): inget dras av', async () => {
    const app = makeApp();
    const from = at('2026-11-11T02:50:00Z');
    const sent = await runTicks(app, glitchPerFeed(from, from + 190 * SEC, { flankDown: false }),
      at('2026-11-11T02:00:09Z'), at('2026-11-11T03:30:09Z'));
    const keys = sent.filter((s) => s.k.startsWith('aisstream:silent'));
    expect(keys.map((s) => [s.k, s.iso])).toEqual([
      ['aisstream:silent', '2026-11-11T02:35:09.000Z'],
      ['aisstream:silent:1h', '2026-11-11T03:20:09.000Z'],
    ]);
    expect(logText(app)).not.toMatch(/korstystnad \d+ min/);
  });

  test('hubbens eget avbrott på 10 min: 1h-steget 03:27:09 (avbrottets egen längd dras av)', async () => {
    const app = makeApp();
    const sent = await runTicks(app, glitchPerFeed(at('2026-11-11T02:50:00Z'), at('2026-11-11T03:00:00Z'), { flankDown: true }),
      at('2026-11-11T02:00:09Z'), at('2026-11-11T03:40:09Z'));
    const keys = sent.filter((s) => s.k.startsWith('aisstream:silent'));
    // Hubben svarade inte 02:53:09–03:00:00 (6 min 51 s). Rå tystnad gav
    // 1h-steget 03:20:09; den första versionen av F2 nollställde och gav 04:00:09.
    expect(keys.map((s) => [s.k, s.iso])).toEqual([
      ['aisstream:silent', '2026-11-11T02:35:09.000Z'],
      ['aisstream:silent:1h', '2026-11-11T03:27:09.000Z'],
    ]);
    expect(keys[1].text).toContain('i över 1 h medan AISHub flödar');
  });

  test('M1 (M2h/M2c): två missade pollar UTAN nedflank — hubben räknas död trots att flanken står, och loggen säger när den svarar igen', async () => {
    // AISstream tyst från 02:20:00. Hubben: senaste OK 02:30:00, nästa OK
    // 02:37:35 (två missade pollar, backoff 130 + 260 s). Flanken står kvar
    // (streak 2 < 3), så uptime löper från BOOT. Pollklockan är äldre än
    // 210 s från 02:33:30.
    const app = makeApp();
    const G0 = at('2026-11-11T02:30:00Z');
    const G1 = G0 + 455 * SEC;
    const perFeedAt = (t) => {
      const lastOk = t >= G0 && t < G1 ? G0 : lastPoll(t, t >= G1 ? G1 : BOOT);
      return {
        aisstream: stream(t, { up: true, openedAt: BOOT, lastMsg: Math.min(t, at('2026-11-11T02:20:00Z')) }),
        aishub: hub(t, {
          up: true, openedAt: BOOT, lastOk, lastMsg: lastOk,
        }),
      };
    };
    const sent = await runTicks(app, perFeedAt, at('2026-11-11T02:00:09Z'), at('2026-11-11T02:45:09Z'));
    const base = sent.filter((s) => s.k === 'aisstream:silent');
    // Levande 02:20:00–02:33:09 (798 s), dött 02:34:09–02:37:09, tillbaka
    // 02:38:09 (+60 s) ⇒ 918 s 02:39:09. Räknas flanken som liv (M2h) blir
    // det "på 18 min" 02:38:09; nollställning hade gett 02:53.
    expect(base.map((s) => s.iso)).toEqual(['2026-11-11T02:39:09.000Z']);
    expect(base[0].text).toContain('på 15 min medan AISHub flödar');
    // Loggraden 02:38:09: hubben svarar sedan sista döda ticken, inte sedan
    // flankens gamla uppgång (M2c: upptiden har överlevt glappet).
    expect(logText(app)).toContain('AISHub svarar oavbrutet sedan 02:37:09Z');
  });

  test('M1 (M2d): AISstream med öppen socket och gles leverans räknas som levande granne', async () => {
    // AISHub svarar men levererar inget från 02:20:00. AISstream-socketen är
    // uppe och levererar var 5:e minut. Socketen är svaret; att det går mer än
    // 2 min mellan positionerna gör inte AISstream till en död granne.
    const app = makeApp();
    const HUB_SILENT_FROM = at('2026-11-11T02:20:00Z');
    const perFeedAt = (t) => {
      const lastStream = at('2026-11-11T01:00:30Z') + Math.floor((t - at('2026-11-11T01:00:30Z')) / (5 * MIN)) * 5 * MIN;
      const ok = lastPoll(t, BOOT);
      return {
        aisstream: stream(t, { up: true, openedAt: BOOT, lastMsg: lastStream }),
        aishub: hub(t, {
          up: true, openedAt: BOOT, lastOk: ok, lastMsg: Math.min(ok, HUB_SILENT_FROM),
        }),
      };
    };
    const sent = await runTicks(app, perFeedAt, at('2026-11-11T02:00:09Z'), at('2026-11-11T02:50:09Z'));
    const base = sent.filter((s) => s.k === 'aishub:silent');
    // hSilence > 15 min från 02:35:00; första tick med färsk AISstream-position
    // efter det är 02:36:09 (positionen 02:35:30).
    expect(base.map((s) => s.iso)).toEqual(['2026-11-11T02:36:09.000Z']);
  });
});

describe('F2: ackumulatorns kantfall', () => {
  const SILENT_FROM = at('2026-11-11T02:20:00Z');
  const healthy = (t) => {
    const ok = lastPoll(t, BOOT);
    return {
      aisstream: stream(t, { up: true, openedAt: BOOT, lastMsg: Math.min(t - 30 * SEC, SILENT_FROM) }),
      aishub: hub(t, {
        up: true, openedAt: BOOT, lastOk: ok, lastMsg: ok,
      }),
    };
  };

  test('väggklockan ställs 10 min bakåt: korstystnaden kläms mot den observerade tystnaden och överdriver aldrig', async () => {
    const app = makeApp();
    await runTicks(app, healthy, at('2026-11-11T02:00:09Z'), at('2026-11-11T03:15:09Z'));
    // Klockan hoppar tillbaka till 03:05:09. Ackumulatorn har räknat 55 min,
    // den observerade tystnaden är nu 45 min.
    const sent = await runTicks(app, healthy, at('2026-11-11T03:05:09Z'), at('2026-11-11T03:25:09Z'));
    const oneHour = sent.filter((s) => s.k === 'aisstream:silent:1h');
    // Utan klämning hade 1h-steget kommit 03:10:09 med 50 min observerad tystnad.
    expect(oneHour.map((s) => s.iso)).toEqual(['2026-11-11T03:20:09.000Z']);
  });

  test('stall: inga tick 02:40–03:10, grannen levde vid båda tickarna — tiden räknas som levande, som den observerade tystnaden', async () => {
    const app = makeApp();
    const before = await runTicks(app, healthy, at('2026-11-11T02:00:09Z'), at('2026-11-11T02:40:09Z'));
    const after = await runTicks(app, healthy, at('2026-11-11T03:10:09Z'), at('2026-11-11T03:25:09Z'));
    const keys = [...before, ...after].filter((s) => s.k.startsWith('aisstream:silent'));
    expect(keys.map((s) => [s.k, s.iso])).toEqual([
      ['aisstream:silent', '2026-11-11T02:35:09.000Z'],
      ['aisstream:silent:1h', '2026-11-11T03:20:09.000Z'],
    ]);
  });

  test('omstart mitt i tystnaden: en ny episod vid observationsankaret, inget bärs över eller dubbelräknas', async () => {
    const app = makeApp();
    await runTicks(app, healthy, at('2026-11-11T02:00:09Z'), at('2026-11-11T02:30:09Z'));
    // Ny process 02:31: båda källornas upptid börjar om, tystnadsbokföringen
    // (inte persisterad här) är tom.
    const RESTART = at('2026-11-11T02:31:00Z');
    const afterRestart = (t) => {
      const ok = lastPoll(t, RESTART);
      return {
        aisstream: stream(t, { up: true, openedAt: RESTART, lastMsg: null }),
        aishub: hub(t, {
          up: true, openedAt: RESTART, lastOk: ok, lastMsg: ok,
        }),
      };
    };
    const app2 = makeApp();
    const sent = await runTicks(app2, afterRestart, at('2026-11-11T02:31:09Z'), at('2026-11-11T03:35:09Z'));
    const keys = sent.filter((s) => s.k.startsWith('aisstream:silent'));
    // Observationen börjar 02:31:00 (B2e): bas efter 15 min, 1h efter 60 min.
    expect(keys.map((s) => [s.k, s.iso])).toEqual([
      ['aisstream:silent', '2026-11-11T02:46:09.000Z'],
      ['aisstream:silent:1h', '2026-11-11T03:31:09.000Z'],
    ]);
  });
});

describe('F2: fröet och episodbytet (omgranskningen N2)', () => {
  test('R11: en ny episod som börjar när grannen nyss kommit tillbaka fröas med grannens levande tid, inte hela tystnaden', async () => {
    // Ticken 02:31:09 ser hubben död. Sedan stall till 02:47:09. Under stallet
    // levererar AISstream sista gången 02:31:30 och tystnar; hubben kommer
    // tillbaka 02:46:09 (flank upp). Den nya episodens frö är 60 s, inte
    // 15 min 39 s — annars hade "på 15 min medan AISHub flödar" gått direkt.
    const app = makeApp();
    const HUB_DEAD_FROM = at('2026-11-11T02:27:00Z');
    const HUB_BACK2 = at('2026-11-11T02:46:09Z');
    const STREAM_LAST2 = at('2026-11-11T02:31:30Z');
    const perFeedAt = (t) => {
      let h;
      if (t < HUB_DEAD_FROM) {
        h = hub(t, {
          up: true, openedAt: BOOT, lastOk: lastPoll(t, BOOT), lastMsg: lastPoll(t, BOOT),
        });
      } else if (t < HUB_BACK2) {
        h = hub(t, {
          up: false, openedAt: null, lastOk: HUB_DEAD_FROM, lastMsg: HUB_DEAD_FROM,
        });
      } else {
        h = hub(t, {
          up: true, openedAt: HUB_BACK2, lastOk: lastPoll(t, HUB_BACK2), lastMsg: lastPoll(t, HUB_BACK2),
        });
      }
      return {
        aisstream: stream(t, { up: true, openedAt: BOOT, lastMsg: Math.min(t - 4 * SEC, STREAM_LAST2) }),
        aishub: h,
      };
    };
    const a = await runTicks(app, perFeedAt, at('2026-11-11T02:00:09Z'), at('2026-11-11T02:31:09Z'));
    const b = await runTicks(app, perFeedAt, at('2026-11-11T02:47:09Z'), at('2026-11-11T03:05:09Z'));
    const keys = [...a, ...b].filter((x) => x.k.startsWith('aisstream:silent'));
    // 60 s + 60 s per tick ⇒ 960 s 03:02:09.
    expect(keys.map((x) => [x.k, x.iso])).toEqual([['aisstream:silent', '2026-11-11T03:02:09.000Z']]);
    expect(keys[0].text).toContain('på 16 min medan AISHub flödar');
  });

  test('omkonfigurering av den tysta källan startar en ny episod (konfigurationsstämpeln i episodnyckeln)', async () => {
    // AISstream tyst från 02:20 med frisk hubb ⇒ degraderad 02:35:09. AISstream
    // avkonfigureras 03:00–03:10 (statusen släpps). Hubben är nere
    // 03:05–03:30 (flank ner/upp). Efter omkonfigureringen är det en NY
    // tystnad: hubben har levt sedan 03:30, så statusen degraderas 03:45:09 —
    // inte 03:30:09, som en fortsatt räkning från 02:20 hade gett.
    const app = makeApp();
    const H_DOWN = at('2026-11-11T03:05:00Z');
    const H_UP = at('2026-11-11T03:30:00Z');
    const perFeedAt = (t) => {
      let h;
      if (t >= H_DOWN && t < H_UP) {
        h = hub(t, {
          up: false, openedAt: null, lastOk: H_DOWN - 10 * SEC, lastMsg: H_DOWN - 10 * SEC,
        });
      } else {
        const from = t >= H_UP ? H_UP : BOOT;
        h = hub(t, {
          up: true, openedAt: from, lastOk: lastPoll(t, from), lastMsg: lastPoll(t, from),
        });
      }
      const deconfigured = t >= at('2026-11-11T03:00:00Z') && t < at('2026-11-11T03:10:00Z');
      const sOpen = t >= at('2026-11-11T03:10:00Z') ? at('2026-11-11T03:10:00Z') : BOOT;
      const st = stream(t, { up: !deconfigured, openedAt: sOpen, lastMsg: Math.min(t - 30 * SEC, at('2026-11-11T02:20:00Z')) });
      if (deconfigured) st.configured = false;
      return { aisstream: st, aishub: h };
    };
    const status = [];
    await runTicks(app, perFeedAt, at('2026-11-11T02:00:09Z'), at('2026-11-11T04:00:09Z'), (t) => {
      status.push([iso(t), !!app._connectionFeedDegraded]);
    }, SHAKY);
    const flips = status.filter((x, i) => i > 0 && x[1] !== status[i - 1][1]);
    expect(flips).toEqual([
      ['2026-11-11T02:35:09.000Z', true],
      ['2026-11-11T03:00:09.000Z', false],
      ['2026-11-11T03:45:09.000Z', true],
    ]);
  });

  test('R9/R11: källbyte (skugga → both) startar en ny tom-kanal-episod, fröad med tiden då ALLA nya relevanta källor svarat', async () => {
    // Tom kanal från 00:30. I skuggläge är bara AISstream relevant; hubben
    // (mätinstrument) är nere 01:00–03:00. 03:30 byter användaren till both.
    // "Alla källor svarar" har då gällt sedan 03:00, så 4 h nås ~07:00 —
    // inte 04:30, som AISstreams egen räkning sedan 00:30 hade gett.
    const B0 = at('2026-11-11T00:00:03Z');
    const LAST = at('2026-11-11T00:30:00Z');
    const H_DOWN = at('2026-11-11T01:00:00Z');
    const H_UP = at('2026-11-11T03:00:00Z');
    const SWITCH = at('2026-11-11T03:30:00Z');
    const app = makeApp({ hubFeedsPipeline: false });
    let pipeline = false;
    app._hubFeedsPipeline = jest.fn(() => pipeline);
    const perFeedAt = (t) => {
      if (t >= SWITCH) pipeline = true;
      let h;
      if (t >= H_DOWN && t < H_UP) {
        h = hub(t, {
          up: false, openedAt: null, lastOk: H_DOWN, lastMsg: LAST,
        });
      } else {
        const from = t >= H_UP ? H_UP : B0;
        h = hub(t, {
          up: true, openedAt: from, lastOk: lastPoll(t, from), lastMsg: Math.min(lastPoll(t, from), LAST),
        });
      }
      return {
        aisstream: stream(t, { up: true, openedAt: B0, lastMsg: Math.min(t - 30 * SEC, LAST) }),
        aishub: h,
      };
    };
    const sent = await runTicks(app, perFeedAt, B0 + MIN, at('2026-11-11T07:30:03Z'), null, SHAKY);
    const empty = sent.filter((x) => x.k === 'feeds:empty:4h');
    expect(empty).toHaveLength(1);
    expect(empty[0].t).toBeGreaterThanOrEqual(at('2026-11-11T06:55:00Z'));
    expect(empty[0].t).toBeLessThanOrEqual(at('2026-11-11T07:05:00Z'));
  });
});

describe('F2: granskarens förlopp — hela K22-trappan när grannen hackar (regression H1 och N1)', () => {
  const B = at('2026-11-11T00:00:03Z');
  const SILENT_FROM = at('2026-11-11T02:20:00Z');
  const DAYS = 3;

  /**
   * Hubben pollar var 65:e s och levererar, utom i glapp: två raka missade
   * pollar (OK vid gapStart, nästa OK +455 s). Flanken står kvar.
   */
  function lastOkWithGaps(t, periodMs, offsetMs) {
    if (!periodMs) return B + Math.floor((t - B) / 65000) * 65000;
    const k = Math.floor((t - B - offsetMs) / periodMs);
    const gapStart = B + offsetMs + k * periodMs;
    if (k >= 0 && t >= gapStart && t < gapStart + 455 * SEC) return gapStart;
    const from = k >= 0 && t >= gapStart + 455 * SEC ? gapStart + 455 * SEC : B;
    return from + Math.floor((t - from) / 65000) * 65000;
  }
  const hubWithGaps = (periodMs, offsetMs) => (t) => {
    const lastOk = lastOkWithGaps(t, periodMs, offsetMs);
    return hub(t, {
      up: true, openedAt: B, lastOk, lastMsg: lastOk,
    });
  };

  const UNIT = { min: MIN, h: HOUR, dygn: DAY };
  /** Övre gränsen för textens tidsfras: "på 22 h" betyder [22 h, 23 h). */
  const upperOf = (text) => {
    const m = /(?:på|i över) (\d+) (min|h|dygn)/.exec(text);
    return m ? (Number(m[1]) + 1) * UNIT[m[2]] : NaN;
  };

  /**
   * HELA trappan: bas, 1h och 4h under första dygnet, och bas, 1h, 4h och
   * dygnssteget under dygn 2 och 3. Ingen text får underskatta tystnaden
   * grovt: textens övre gräns ska nå 85 % av den råa tystnaden (grannen var
   * borta ~8 % av tiden; H1 och N1 gav "på 28 min" efter ett dygn).
   */
  function expectFullStaircase(sent, prefix) {
    const keys = sent.filter((s) => s.k.startsWith(prefix));
    const wanted = [
      [prefix, `${prefix}:1h`, `${prefix}:4h`],
      [prefix, `${prefix}:1h`, `${prefix}:4h`, `${prefix}:1 dygn`],
      [prefix, `${prefix}:1h`, `${prefix}:4h`, `${prefix}:1 dygn`],
    ];
    for (const day of [0, 1, 2]) {
      const from = SILENT_FROM + day * DAY;
      const inDay = keys.filter((s) => s.t >= from && s.t < from + DAY).map((s) => s.k);
      for (const step of wanted[day]) {
        expect({ day, step, present: inDay.includes(step) }).toEqual({ day, step, present: true });
      }
    }
    for (const s of keys) {
      const raw = s.t - SILENT_FROM;
      expect({ at: s.iso, k: s.k, ok: upperOf(s.text) >= 0.85 * raw }).toEqual({ at: s.iso, k: s.k, ok: true });
    }
    return keys;
  }

  const SCENARIOS = {
    // A: AISstream halvdöd (socket uppe, pongar, levererar inget), hubbglapp var 50:e min.
    A: (t) => ({
      aisstream: stream(t, { up: true, openedAt: B, lastMsg: Math.min(t - 30 * SEC, SILENT_FROM) }),
      aishub: hubWithGaps(50 * MIN, 10 * MIN)(t),
    }),
    // A2: som A, ett hubbglapp per 12 h.
    A2: (t) => ({
      aisstream: stream(t, { up: true, openedAt: B, lastMsg: Math.min(t - 30 * SEC, SILENT_FROM) }),
      aishub: hubWithGaps(12 * HOUR, 5 * HOUR)(t),
    }),
    // B: AISstream död på riktigt (socket nere), hubben som i A.
    B: (t) => ({
      aisstream: t < SILENT_FROM
        ? stream(t, { up: true, openedAt: B, lastMsg: t - 30 * SEC })
        : stream(t, { up: false, lastMsg: SILENT_FROM }),
      aishub: hubWithGaps(50 * MIN, 10 * MIN)(t),
    }),
    // C: spegeln — AISHub levererar inget, AISstream nere 4 min var 50:e min.
    C: (t) => {
      const period = 50 * MIN;
      const k = Math.floor((t - B - 10 * MIN) / period);
      const gapStart = B + 10 * MIN + k * period;
      const inGap = k >= 0 && t >= gapStart && t < gapStart + 4 * MIN;
      const openedAt = k >= 0 && t >= gapStart + 4 * MIN ? gapStart + 4 * MIN : B;
      const lastOk = lastOkWithGaps(t);
      return {
        aisstream: inGap
          ? stream(t, { up: false, lastMsg: gapStart - 20 * SEC })
          : stream(t, { up: true, openedAt, lastMsg: t - 20 * SEC }),
        aishub: hub(t, {
          up: true, openedAt: B, lastOk, lastMsg: Math.min(lastOk, SILENT_FROM),
        }),
      };
    },
    // S2 (M2): AISstream död, hubben med två missade pollar var 12:e min.
    S2: (t) => {
      const ok = lastOkWithGaps(t, 12 * MIN, 10 * MIN);
      return {
        aisstream: t < SILENT_FROM
          ? stream(t, { up: true, openedAt: B, lastMsg: t - 30 * SEC })
          : stream(t, { up: false, lastMsg: SILENT_FROM }),
        aishub: hub(t, {
          up: true, openedAt: B, lastOk: ok, lastMsg: ok,
        }),
      };
    },
    // T2 (M3): tom kanal från 00:30, båda svarar, hubbglapp var 3:e h.
    T2: (t) => {
      const LAST = at('2026-11-11T00:30:00Z');
      const ok = lastOkWithGaps(t, 3 * HOUR, 2 * HOUR);
      return {
        aisstream: stream(t, { up: true, openedAt: B, lastMsg: Math.min(t - 30 * SEC, LAST) }),
        aishub: hub(t, {
          up: true, openedAt: B, lastOk: ok, lastMsg: Math.min(ok, LAST),
        }),
      };
    },
  };

  /** Kör förloppet med statistiken i fas med vakten och med växlande eftersläpning. */
  async function bothWays(name, toMs) {
    const out = {};
    for (const [label, lags] of [['δ0', [0]], ['δ', SHAKY]]) {
      const app = makeApp();
      const degraded = [];
      // eslint-disable-next-line no-await-in-loop
      const sent = await runTicks(app, SCENARIOS[name], B + MIN, toMs, (t) => {
        if (app._connectionFeedDegraded && degraded.length === 0) degraded.push(iso(t));
      }, lags);
      out[label] = { sent, degraded };
    }
    // N1: notiserna, deras tider och texter samt statusen får inte bero på
    // millisekunderna mellan klientens statistik och vaktens now.
    const strip = (o) => ({ sent: o.sent.map((x) => [x.k, x.iso, x.text]), degraded: o.degraded });
    expect(strip(out['δ'])).toEqual(strip(out['δ0']));
    return out['δ'];
  }

  test('A: AISstream halvdöd i 3 dygn, hubben med två missade pollar var 50:e min — hela trappan, med och utan ms-eftersläpning', async () => {
    const { sent } = await bothWays('A', SILENT_FROM + DAYS * DAY);
    const keys = expectFullStaircase(sent, 'aisstream:silent');
    const dygn1 = keys.find((s) => s.k === 'aisstream:silent:1 dygn');
    expect(dygn1.t).toBeLessThanOrEqual(SILENT_FROM + DAY + 2.5 * HOUR);
  });

  test('A2: ett hubbglapp per 12 h — dygnssteget varje dygn, med och utan ms-eftersläpning', async () => {
    const { sent } = await bothWays('A2', SILENT_FROM + DAYS * DAY);
    const keys = expectFullStaircase(sent, 'aisstream:silent');
    const dygn = keys.filter((s) => s.k === 'aisstream:silent:1 dygn');
    expect(dygn.length).toBeGreaterThanOrEqual(2);
    expect(dygn[0].t).toBeLessThanOrEqual(SILENT_FROM + DAY + 15 * MIN);
  });

  test('B: AISstream död på riktigt — hela trappan, med och utan ms-eftersläpning', async () => {
    const { sent } = await bothWays('B', SILENT_FROM + DAYS * DAY);
    expectFullStaircase(sent, 'aisstream:silent');
  });

  test('C: spegeln — hela aishub:silent-trappan, med och utan ms-eftersläpning', async () => {
    const { sent } = await bothWays('C', SILENT_FROM + DAYS * DAY);
    expectFullStaircase(sent, 'aishub:silent');
  });

  test('S2 (M2): AISstream död, hubben flackig — "Degraderad" och notiserna kommer, med och utan ms-eftersläpning', async () => {
    const { sent, degraded } = await bothWays('S2', SILENT_FROM + 6 * HOUR);
    const keys = sent.filter((s) => s.k.startsWith('aisstream:silent'));
    // Hubben levde ~2/3 av tiden ⇒ 15 min levande granne ~02:43.
    expect(degraded).toHaveLength(1);
    expect(at(degraded[0])).toBeGreaterThanOrEqual(at('2026-11-11T02:40:00Z'));
    expect(at(degraded[0])).toBeLessThanOrEqual(at('2026-11-11T02:47:00Z'));
    expect(keys.map((s) => s.k)).toEqual(['aisstream:silent', 'aisstream:silent:1h']);
    expect(keys[0].iso).toBe(degraded[0]); // B2c: samma villkor, samma tick
  });

  test('T2 (M3): tom kanal med hubbglapp var 3:e h — feeds:empty:4h kommer, med och utan ms-eftersläpning', async () => {
    const LAST = at('2026-11-11T00:30:00Z');
    const { sent } = await bothWays('T2', LAST + 12 * HOUR);
    const empty = sent.filter((s) => s.k === 'feeds:empty:4h');
    expect(empty).toHaveLength(1);
    // Rå tystnad: 04:30. Ett glapp (~4 min) drar av sin egen längd.
    expect(empty[0].t).toBeGreaterThanOrEqual(at('2026-11-11T04:30:00Z'));
    expect(empty[0].t).toBeLessThanOrEqual(at('2026-11-11T04:40:00Z'));
    expect(empty[0].text).toContain('svarar men ingen båtdata på 4 h');
  });

  test('D: kontroll utan glapp — trappan på exakt K22:s tider', async () => {
    const app = makeApp();
    const perFeedAt = (t) => {
      const ok = lastOkWithGaps(t);
      return {
        aisstream: stream(t, { up: true, openedAt: B, lastMsg: Math.min(t - 30 * SEC, SILENT_FROM) }),
        aishub: hub(t, {
          up: true, openedAt: B, lastOk: ok, lastMsg: ok,
        }),
      };
    };
    const sent = await runTicks(app, perFeedAt, B + MIN, SILENT_FROM + DAY + 61 * MIN, null, SHAKY);
    const keys = sent.filter((s) => s.k.startsWith('aisstream:silent'));
    expect(keys.map((s) => [s.k, s.iso])).toEqual([
      ['aisstream:silent', '2026-11-11T02:35:03.000Z'],
      ['aisstream:silent:1h', '2026-11-11T03:20:03.000Z'],
      ['aisstream:silent:4h', '2026-11-11T06:20:03.000Z'],
      ['aisstream:silent:1 dygn', '2026-11-12T02:20:03.000Z'],
      ['aisstream:silent', '2026-11-12T02:35:03.000Z'],
      ['aisstream:silent:1h', '2026-11-12T03:20:03.000Z'],
    ]);
  });
});

describe('F2: hubbklienten byggs om mitt i hubbens tystnad (andra omgranskningen R2-L1)', () => {
  test('ombyggnad var 6:e h nollar klientens lastMessageTime, men bokföringens stämpel bär episoden: en episod, ingen nollställning, hela trappan', async () => {
    // Granskarens förlopp N2: AISHub tyst från 02:20 i 2 dygn, hubbklienten
    // byggs om var 6:e h (ny klient: lastMessageTime null, ingen kontakt första
    // minuten), AISstream nere 4 min var 50:e min. Varje tick som i drift:
    // _noteFeedObservation för båda källorna, sedan korsvakten, med
    // statistiken 0/1/2/50 ms före vaktens now. Utan bokföringens
    // lastMessageAt i episodnyckeln (granskarens mutant K3) blir varje
    // ombyggnad en ny episod och dygnssteget flyttas ~5 h.
    const B = at('2026-11-11T00:00:03Z');
    const SILENT_FROM = at('2026-11-11T02:20:00Z');
    const app = makeApp();
    const store = {};
    app.homey.settings = {
      get: (k) => store[k] ?? null,
      set: (k, v) => {
        store[k] = JSON.parse(JSON.stringify(v));
      },
      on: () => {},
    };
    const perFeedAt = (t) => {
      const k = Math.floor((t - B - 10 * MIN) / (50 * MIN));
      const gs = B + 10 * MIN + k * 50 * MIN;
      const sDown = k >= 0 && t >= gs && t < gs + 4 * MIN;
      const s = sDown
        ? stream(t, { up: false, lastMsg: gs - 20 * SEC })
        : stream(t, { up: true, openedAt: k >= 0 ? gs + 4 * MIN : B, lastMsg: t - 20 * SEC });
      let h;
      if (t < SILENT_FROM) {
        const ok = lastPoll(t, B);
        h = hub(t, {
          up: true, openedAt: B, lastOk: ok, lastMsg: ok,
        });
      } else {
        const r = Math.floor((t - SILENT_FROM) / (6 * HOUR));
        const rebuilt = SILENT_FROM + r * 6 * HOUR;
        if (r >= 1 && t < rebuilt + MIN) {
          h = hub(t, {
            up: false, lastOk: null, lastMsg: null,
          });
        } else {
          const from = r >= 1 ? rebuilt + MIN : B;
          h = hub(t, {
            up: true, openedAt: from, lastOk: lastPoll(t, from), lastMsg: r >= 1 ? null : SILENT_FROM,
          });
        }
      }
      return { aisstream: s, aishub: h };
    };
    const ids = new Set();
    let resets = 0;
    let prev = null;
    const first = app._sent.length;
    let i = 0;
    for (let t = B + MIN; t <= SILENT_FROM + 2 * DAY; t += MIN) {
      Date.now = () => t;
      statsLag = SHAKY[i % SHAKY.length];
      i++;
      const pf = perFeedAt(t);
      statsLag = 0;
      app._noteFeedObservation('aisstream', pf.aisstream, t);
      app._noteFeedObservation('aishub', pf.aishub, t);
      app._checkCrossFeedSilence(pf);
      // eslint-disable-next-line no-await-in-loop
      await flush();
      const acc = app._silenceAliveAccumulators.get('aishub-medan-aisstream');
      if (t > SILENT_FROM + 2 * MIN) {
        ids.add(acc.episodeId);
        if (prev !== null && acc.ms < prev - 1000) resets++;
        prev = acc.ms;
      }
    }
    expect({ episodes: ids.size, resets }).toEqual({ episodes: 1, resets: 0 });
    const keys = app._sent.slice(first).filter((x) => x.k.startsWith('aishub:silent'));
    const day1 = keys.filter((x) => x.t < SILENT_FROM + DAY).map((x) => x.k);
    expect(day1).toEqual(['aishub:silent', 'aishub:silent:1h', 'aishub:silent:4h']);
    const dygn = keys.find((x) => x.k === 'aishub:silent:1 dygn');
    // AISstream borta ~4 min per 50 min ⇒ dygnssteget strax efter 03:00 dygn 2
    // (granskarens prob: 03:20); nollställning vid ombyggnaderna gav 08:44.
    expect(dygn).toBeDefined();
    expect(dygn.t).toBeLessThanOrEqual(at('2026-11-12T03:30:00Z'));
    expect(dygn.text).toContain('i över 1 dygn medan AISstream flödar');
  });
});

describe('F2: den riktiga vägen genom _checkAISFeedHealth med klockan stegad mellan statistik och tick (N1)', () => {
  const B = at('2026-11-11T00:00:03Z');
  const SILENT_FROM = at('2026-11-11T02:20:00Z');

  /**
   * Klientstubben räknar statistiken som klienterna (relativa mått med sin
   * egen Date.now()) och stegar sedan klockan δ ms innan vakten läser sin —
   * som i drift, där getConnectionStats() körs före korsvaktens now.
   */
  async function runRealPath(lags, toMs) {
    const app = makeApp();
    const settings = { ais_api_key: 'k'.repeat(40), ais_source: 'both', aishub_username: 'u' };
    const store = {};
    app.homey.settings = {
      get: (k) => settings[k] ?? store[k] ?? null,
      set: (k, v) => {
        store[k] = JSON.parse(JSON.stringify(v));
      },
      on: () => {},
    };
    let mockNow = B + MIN;
    Date.now = () => mockNow;
    let i = 0;
    app.aisClient = {
      isConnected: true,
      reconnectWithKey: jest.fn().mockResolvedValue(undefined),
      kickAishub: jest.fn(),
      getConnectionStats() {
        const now = Date.now();
        const streamLast = Math.min(now - 30 * SEC, SILENT_FROM);
        const k = Math.floor((now - B - 10 * MIN) / (50 * MIN));
        const gapStart = B + 10 * MIN + k * 50 * MIN;
        let lastOk;
        if (k >= 0 && now >= gapStart && now < gapStart + 455 * SEC) lastOk = gapStart;
        else {
          const from = k >= 0 && now >= gapStart + 455 * SEC ? gapStart + 455 * SEC : B;
          lastOk = from + Math.floor((now - from) / 65000) * 65000;
        }
        const stats = {
          isConnected: true,
          perFeed: {
            aisstream: {
              configured: true,
              isConnected: true,
              lastMessageTime: streamLast,
              timeSinceLastMessage: now - streamLast,
              uptime: now - B,
              reconnectAttempts: 0,
            },
            aishub: {
              configured: true,
              isConnected: true,
              lastMessageTime: lastOk,
              timeSinceLastMessage: now - lastOk,
              uptime: now - B,
              lastOkResponseAt: lastOk,
              lastPollStartedAt: lastOk,
              pollChainArmedAt: B,
              authCooldownMsLeft: 0,
            },
          },
        };
        // Klockan går vidare innan vakten läser sitt now.
        mockNow += lags[i % lags.length];
        i++;
        return stats;
      },
    };
    const first = app._sent.length;
    for (let t = B + MIN; t <= toMs; t += MIN) {
      mockNow = t;
      app._checkAISFeedHealth();
      // eslint-disable-next-line no-await-in-loop
      await flush();
    }
    return app._sent.slice(first).filter((s) => s.k.startsWith('aisstream:silent')).map((s) => s.k);
  }

  test('förlopp A genom hela vakten: samma trappa med 0 ms och med 0/1/2/50 ms mellan statistik och tick', async () => {
    const to = SILENT_FROM + 1.5 * DAY;
    const steady = await runRealPath([0], to);
    const shaky = await runRealPath(SHAKY, to);
    expect(steady).toEqual([
      'aisstream:silent', 'aisstream:silent:1h', 'aisstream:silent:4h',
      'aisstream:silent', 'aisstream:silent:1h', 'aisstream:silent:1 dygn', 'aisstream:silent:4h',
    ]);
    expect(shaky).toEqual(steady);
  });
});

describe('F2: utan avbrott hos grannen är korstystnaden oförändrad (K22)', () => {
  test('AISstream dör medan hubben flödar hela tiden: bas efter 15 min, 1h och 4h i tur och ordning', async () => {
    const app = makeApp();
    const STREAM_DEAD = at('2026-11-11T02:10:00Z');
    const perFeedAt = (t) => ({
      aisstream: t < STREAM_DEAD
        ? stream(t, { up: true, openedAt: BOOT, lastMsg: t - 30 * SEC })
        : stream(t, { up: false, lastMsg: STREAM_DEAD }),
      aishub: hub(t, {
        up: true, openedAt: BOOT, lastOk: lastPoll(t, BOOT), lastMsg: lastPoll(t, BOOT),
      }),
    });
    const sent = await runTicks(app, perFeedAt, at('2026-11-11T02:00:09Z'), at('2026-11-11T06:30:09Z'));
    const keys = sent.filter((s) => s.k.startsWith('aisstream:silent'));
    expect(keys.map((s) => [s.k, s.iso])).toEqual([
      ['aisstream:silent', '2026-11-11T02:25:09.000Z'],
      ['aisstream:silent:1h', '2026-11-11T03:10:09.000Z'],
      ['aisstream:silent:4h', '2026-11-11T06:10:09.000Z'],
    ]);
    expect(logText(app)).not.toMatch(/korstystnad \d+ min/);
    // Statusen degraderas i samma tick som basnotisen (B2c).
    expect(app._connectionFeedDegraded).toBe(true);
  });

  test('en ny tystnadsepisod (källan levererar) börjar om räkningen från noll', async () => {
    // AISstream tyst 02:10–02:40 med hubben frisk ⇒ degraderad 02:25:09.
    // AISstream levererar 02:40:00 ⇒ släpps 02:40:09. Ny tystnad från 02:40:00,
    // men hubben svarar inte 02:40:20–02:50:00 (två missade pollar, flanken
    // står). Den nya episodens korstystnad är bara hubbens levande tid sedan
    // 02:40:00: 9 s + 60 s vid 02:50:09 + 60 s per tick ⇒ 909 s 03:04:09.
    // Utan omstart hade episod 1:s 30 min burits över och gett 02:55:09.
    const app = makeApp();
    const lastStream = (t) => {
      if (t < at('2026-11-11T02:10:00Z')) return t - 30 * SEC;
      if (t < at('2026-11-11T02:40:00Z')) return at('2026-11-11T02:10:00Z');
      return at('2026-11-11T02:40:00Z');
    };
    const G0 = at('2026-11-11T02:36:50Z');
    const G1 = at('2026-11-11T02:50:00Z');
    const perFeedAt = (t) => {
      const lastOk = t >= G0 && t < G1 ? G0 : lastPoll(t, t >= G1 ? G1 : BOOT);
      return {
        aisstream: stream(t, { up: true, openedAt: BOOT, lastMsg: lastStream(t) }),
        aishub: hub(t, {
          up: true, openedAt: BOOT, lastOk, lastMsg: lastOk,
        }),
      };
    };
    const status = [];
    const sent = await runTicks(app, perFeedAt, at('2026-11-11T02:00:09Z'), at('2026-11-11T03:10:09Z'), (t) => {
      status.push([iso(t), !!app._connectionFeedDegraded]);
    });
    const flips = status.filter((x, i) => i > 0 && x[1] !== status[i - 1][1]);
    expect(flips).toEqual([
      ['2026-11-11T02:25:09.000Z', true],
      ['2026-11-11T02:40:09.000Z', false],
      ['2026-11-11T03:04:09.000Z', true],
    ]);
    // Basnyckeln är bränd (24 h) — bara den första episodens notis.
    expect(keysOf(sent, 'aisstream:silent')).toEqual(['aisstream:silent']);
  });
});
