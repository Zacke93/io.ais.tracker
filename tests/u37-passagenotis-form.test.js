'use strict';

/**
 * U37 del 2 (dirigentens beslut 2026-11-16 på ägarens uppdrag, fråga F25):
 * EN FORMREGEL FÖR ALLA PASSAGENOTISER (lib/utils/passageNoticeForm.js).
 *
 * "passerade … under AIS-tystnad" när det var tyst i mer än 130 s kring
 * korsningen och notisen kommer mer än 60 s efter den, annars "har precis
 * passerat". Förut följde formen notisvägen: S4 sa alltid "har precis
 * passerat" (också efter 800 s tystnad och en korsning fyra minuter före
 * notisen, granskningen av K1, L1), glappvägen och failsafen alltid "under
 * AIS-tystnad" (också för en korsning sekunder före fixen), och retursläppet
 * mätte bara korsningssegmentet (nattjaktens F08 r1: 67 s, sedan 135 s tyst,
 * notisen 174 s efter korsningen och 531 m bort med "har precis passerat").
 */

jest.mock('homey');

const path = require('path');
const { execFileSync } = require('child_process');
const {
  passageNoticeForm, segmentPassageForm, fixLatenessMs, lineOffsetM, PASSAGE_SILENCE_MS, PASSAGE_LATE_MS,
  MOVING_SOG_KN,
} = require('../lib/utils/passageNoticeForm');
const TriggerPointVisitTracker = require('../lib/services/TriggerPointVisitTracker');
const { BRIDGES, TRIGGER_POINTS } = require('../lib/constants');
const { validateInvariants } = require('./replay-validation/invariants');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const KLAFF = BRIDGES.klaffbron;
const posAt = (bridge, offsetM) => {
  const normal = (((bridge.axisBearing || 125) - 90) * Math.PI) / 180;
  return {
    lat: bridge.lat + (offsetM * Math.cos(normal)) / 111320,
    lon: bridge.lon + (offsetM * Math.sin(normal)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180)),
  };
};

describe('Regeln', () => {
  test('gränserna: mer än 130 s tystnad OCH mer än 60 s dröjsmål', () => {
    expect(PASSAGE_SILENCE_MS).toBe(130000);
    expect(PASSAGE_LATE_MS).toBe(60000);
    expect(passageNoticeForm({ silenceMs: 130001, latenessMs: 60001 })).toBe('silence');
    expect(passageNoticeForm({ silenceMs: 130000, latenessMs: 600000 })).toBe('live');
    expect(passageNoticeForm({ silenceMs: 3600000, latenessMs: 60000 })).toBe('live');
    expect(passageNoticeForm({ silenceMs: 30000, latenessMs: 300000 })).toBe('live');
    // Okänt dröjsmål efter tystnad: tystnadsformen; utan tystnad "har precis passerat".
    expect(passageNoticeForm({ silenceMs: 300000, latenessMs: null })).toBe('silence');
    expect(passageNoticeForm({ silenceMs: 60000, latenessMs: null })).toBe('live');
    expect(passageNoticeForm({ silenceMs: NaN, latenessMs: 300000 })).toBeNull();
    expect(passageNoticeForm({})).toBeNull();
  });

  test('dröjsmålet ur fixen: avståndet delat med farten, från 0,5 kn', () => {
    expect(MOVING_SOG_KN).toBe(0.5);
    const now = 1000000;
    expect(Math.round(fixLatenessMs({
      now, fixT: now - 10000, offsetM: -51.4444, sogKn: 10,
    }) / 1000)).toBe(20);
    expect(fixLatenessMs({
      now, fixT: now, offsetM: 20, sogKn: 0.4,
    })).toBeNull();
    expect(fixLatenessMs({
      now, fixT: now, offsetM: NaN, sogKn: 5,
    })).toBeNull();
  });

  test('Kanalinfarten saknar broaxel och prövas mot sin latitud', () => {
    const tp = TRIGGER_POINTS.kanalinfarten;
    expect(lineOffsetM({ lat: tp.lat + 0.001, lon: tp.lon + 0.01 }, tp)).toBeCloseTo(111.32, 1);
    expect(lineOffsetM(posAt(KLAFF, 40), KLAFF)).toBeCloseTo(40, 6);
  });
});

describe('Segmentet fram till notisens fix', () => {
  const T0 = Date.parse('2026-08-06T10:00:00Z');
  const seg = (fromOff, toOff, gapS, sogKn, noticeAfterS = 0, travel = 1) => segmentPassageForm(
    { ...posAt(KLAFF, fromOff), t: T0 },
    { ...posAt(KLAFF, toOff), t: T0 + gapS * 1000 },
    KLAFF,
    travel,
    T0 + (gapS + noticeAfterS) * 1000,
    sogKn,
  );

  test('233 s tystnad över bron, fixen 200 m bortom i 5 kn: korsningen 78 s före, tystnadsform', () => {
    const r = seg(-400, 200, 233, 5);
    expect(r.inSegment).toBe(true);
    expect(Math.round(r.latenessMs / 1000)).toBe(78);
    expect(r.form).toBe('silence');
  });

  test('HEY JOE-läget: 180 s tystnad, fixen 11 m bortom i 7 kn, korsningen 3 s före: har precis passerat', () => {
    expect(seg(494, -11, 180, 7, 0, -1).form).toBe('live');
  });

  test('kö före bron och sedan igenom: 1 135 s tystnad, 54 m bortom i 5,3 kn (PAX): har precis passerat', () => {
    // Linjär interpolation över glappet hade lagt korsningen 125 s före fixen.
    const r = seg(438, -54, 1135, 5.3, 0, -1);
    expect(Math.round(r.latenessMs / 1000)).toBe(20);
    expect(r.form).toBe('live');
  });

  test('farten gäller aldrig före segmentets början', () => {
    // 300 m bortom i 1 kn ger 583 s; segmentet är bara 200 s.
    expect(Math.round(seg(-100, 300, 200, 1, 10).latenessMs / 1000)).toBe(210);
  });

  test('stilla båt (K1:s stopp, sog 0) efter 233 s tystnad: korsningstiden okänd, tystnadsform', () => {
    const r = seg(-400, 30, 233, 0);
    expect(r.latenessMs).toBeNull();
    expect(r.form).toBe('silence');
    expect(seg(-400, 30, 233, null).form).toBe('silence');
  });

  test('AISHub-kadens: 120 s mellan fixarna: har precis passerat, oavsett fart', () => {
    expect(seg(-129, 180, 120, 5).form).toBe('live');
    expect(seg(-129, 180, 120, 0).form).toBe('live');
  });

  test('bokföringen kom en fix efter korsningen: undre gränser avgör bara tystnadsformen', () => {
    // Båda ändar bortom linjen i färdriktningen: korsningen senast vid förra fixen.
    expect(seg(30, 320, 140, 5).form).toBe('silence');
    expect(seg(30, 120, 40, 5).form).toBeNull();
    // Färdriktningen okänd eller båten på tillfartssidan: ingen slutsats.
    expect(seg(30, 320, 140, 5, 0, 0).form).toBeNull();
    expect(seg(-320, -30, 140, 5).form).toBeNull();
  });

  test('saknade eller omvända tider ger ingen slutsats', () => {
    expect(segmentPassageForm(null, { lat: 1, lon: 1, t: 1 }, KLAFF, 1, 2).form).toBeNull();
    expect(segmentPassageForm({ ...posAt(KLAFF, -50), t: T0 }, { ...posAt(KLAFF, 50), t: T0 }, KLAFF, 1, T0).form)
      .toBeNull();
  });
});

describe('Retursläppet mäter tystnaden fram till släppets fix', () => {
  test('F08 r1-mönstret: korsningssegment 67 s, sedan 135 s tyst: silenceMs 135 s', () => {
    let now = Date.parse('2026-07-25T15:30:00Z');
    const tracker = new TriggerPointVisitTracker({ now: () => now });
    const bridge = BRIDGES.jarnvagsbron;
    const at = (offsetM, extra = {}) => ({
      mmsi: '265884859',
      ...posAt(bridge, offsetM),
      sog: 5,
      cog: 40,
      _routeDirection: 'north',
      timestamp: now,
      lastPositionUpdate: now,
      fixTs: now,
      fixFeed: 'aisstream',
      ...extra,
    });
    const step = (s, offsetM, extra) => {
      now += s * 1000;
      const v = at(offsetM, typeof extra === 'function' ? extra() : extra);
      tracker.observe(v, bridge.name);
      return v;
    };
    // Förvarning söderut vid +235 m; utpassagen och bortre sidan (söder).
    expect(tracker.reserve(at(235, { _routeDirection: 'south', cog: 220 }), bridge.name)).not.toBeNull();
    const out = { lastPassedBridge: bridge.name, lastPassedBridgeTime: now, passedBridges: [bridge.name] };
    step(60, 98, { _routeDirection: 'south', cog: 220, ...out });
    step(1549, -308, out);
    step(135, -78, out);
    step(67, 32, out);
    const release = step(135, 531, () => ({ lastPassedBridge: bridge.name, lastPassedBridgeTime: now }));
    const result = tracker.releaseReturnPassage(release, bridge.name, {
      maxBookingAgeMs: Infinity, maxLatenessMs: 600000, sparseFixGapMs: 30000,
    });
    expect(result).toMatchObject({ crossingGapMs: 67000, silenceMs: 135000, sogKn: 5 });
    expect(Math.round(result.offsetM)).toBe(531);
    const latenessMs = fixLatenessMs({
      now, fixT: result.fixTs, offsetM: result.offsetM, sogKn: result.sogKn, earliestT: result.segmentStartTs,
    });
    // 531 m i 5 kn: korsningen ligger vid segmentets början (67 + 135 s före).
    expect(Math.round(latenessMs / 1000)).toBe(202);
    expect(passageNoticeForm({ silenceMs: result.silenceMs, latenessMs })).toBe('silence');
  });
});

describe('Hela appen på nattjaktens F08 r1 (replay)', () => {
  test('TROLLA: returen över Järnvägsbron 174 s efter korsningen säger "under AIS-tystnad"', () => {
    const env = { ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '' };
    delete env.REPLAY_MONITORING;
    const out = execFileSync(process.execPath, [
      path.join(ROOT, 'tests/replay-validation/replayRunner.js'),
      path.join(FIXTURES, 'n2-f08-trolla-sen-retur-jarnvagsbron.jsonl'),
    ], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
    });
    const result = JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    const iso = (t) => new Date(t).toISOString().slice(11, 19);
    const late = result.notifications.filter((n) => iso(n.t) === '15:42:15');
    expect(late.map((n) => n.message)).toEqual([
      'TROLLA passerade Stridsbergsbron under AIS-tystnad',
      'TROLLA passerade Järnvägsbron under AIS-tystnad',
    ]);
    expect(result.visitReturnReleases.map((r) => [r.bridge, r.verdict])).toEqual([
      ['Stridsbergsbron', 'ankomst'], ['Järnvägsbron', 'ankomst'],
    ]);
    expect(validateInvariants(result).filter((v) => /NOTIS-DUBBLETT|RETURSLÄPP/.test(v))).toEqual([]);
    expect(result.processErrors).toBe(0);
  });
});
