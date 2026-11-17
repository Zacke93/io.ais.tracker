'use strict';

/**
 * N6 (granskningen av N2, sidofyndet vid Järnvägsbron; ägarfråga F9): EN
 * FÖRVARNING PÅ EN POSITION SOM REDAN LIGGER BORTOM BRON.
 *
 * (b) Besökets bortre sida. En förvarning ("närmar sig …") reserverar brobesöket
 * med bortre sidan MOTSATT positionens sida: passagen antogs ligga framför
 * båten. Med glesa positioner kan förvarningen gå ut på en position som redan
 * ligger entydigt bortom linjen i färdriktningen (granskarens bana: 120 s
 * kadens söderut, fixen 22 m söder om Järnvägsbron). Besöket vändes då, och
 * - en ensam brusposition på andra sidan följd av en fix söderut gav en falsk
 *   "har precis passerat Järnvägsbron" 12 min efter den verkliga passagen;
 * - en verklig retur norrut genom bron gav ingen notis alls (48 av 48 banor).
 * Granskningen av N6 (H1, U44): bron räknas som bakom båten bara när det är
 * belagt i nuet (minst 2 kn, eller föregående position på andra sidan linjen).
 * Annars fick en båt som driver bort från bron på tillfartssidan och sedan går
 * igenom två notiser för en passage (granskarens driftsvep 44 av 60; HALIFAX).
 *
 * (a) Formen för en ny båt. Svepets portgissning (scenario A) notifierar en ny
 * båts broar bakom henne som passerade, men närhetsnotisen går först och tar
 * den närmaste i förvarningsform: "NEST närmar sig Stallbackabron, beräknad
 * ankomst om 1 minut" 248 m efter bron (nio sådana i banken, 74–252 m). BN2
 * prövar nu också portgissningen; inom 70 m (vid bron) står förvarningen kvar.
 */

jest.mock('homey');

const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const TriggerPointVisitTracker = require('../lib/services/TriggerPointVisitTracker');
const geometry = require('../lib/utils/geometry');
const { BRIDGES } = require('../lib/constants');
const { generateScenario, buildPath, pathMetrics } = require('./replay-validation/scenarioGenerator');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'tests/replay-validation/replayRunner.js');
const JVB = BRIDGES.jarnvagsbron;
const MMSI = '265799290';
const LIMITS = { maxBookingAgeMs: Infinity, maxLatenessMs: 10 * 60 * 1000, sparseFixGapMs: 30000 };
const NORTH_COG = 40;
const SOUTH_COG = 220;

/** Position d m från brolinjen längs kanalaxeln (+ = nordöstra sidan), L m i sidled. */
const at = (bridge, d, L = 0) => {
  const pe = ((bridge.axisBearing - 90) * Math.PI) / 180;
  const ax = (bridge.axisBearing * Math.PI) / 180;
  const n = d * Math.cos(pe) + L * Math.cos(ax);
  const e = d * Math.sin(pe) + L * Math.sin(ax);
  return { lat: bridge.lat + n / 111320, lon: bridge.lon + e / (111320 * Math.cos((bridge.lat * Math.PI) / 180)) };
};

describe('N6 (b): besökets bortre sida när förvarningen går ut bortom linjen', () => {
  let now;
  let tracker;
  // Föregående position (vessel.lastPosition), som appen alltid har för en
  // båt som setts förut; step() för den vidare.
  let prev;

  beforeEach(() => {
    now = Date.parse('2026-11-16T10:00:00Z');
    tracker = new TriggerPointVisitTracker({ now: () => now });
    prev = null;
  });

  const fix = (d, extra = {}) => ({
    mmsi: MMSI,
    ...at(JVB, d),
    sog: 5,
    cog: SOUTH_COG,
    _routeDirection: 'south',
    lastPosition: prev,
    timestamp: now,
    lastPositionUpdate: now,
    fixTs: now,
    fixFeed: 'aisstream',
    ...extra,
  });
  // Reservationens fix: föregående position anges uttryckligen.
  const first = (d, lastD, extra = {}) => {
    const vessel = fix(d, { lastPosition: lastD === null ? null : at(JVB, lastD), ...extra });
    prev = { lat: vessel.lat, lon: vessel.lon };
    return vessel;
  };
  const step = (d, extra = {}, seconds = 120) => {
    now += seconds * 1000;
    const vessel = fix(d, typeof extra === 'function' ? extra() : extra);
    tracker.observe(vessel, JVB.name);
    prev = { lat: vessel.lat, lon: vessel.lon };
    return vessel;
  };
  const farSign = () => tracker.exportSnapshot().entries[`${MMSI}:${JVB.name}`].farSign;
  const release = (vessel) => tracker.releaseReturnPassage(vessel, JVB.name, LIMITS);

  /** Granskarens bana: förvarningen på fixen 22 m söder om linjen, sedan utpassagens bokföring 176 m söderut. */
  function noticeBeyondThenOutbound() {
    // Föregående fix 279 m norr om linjen (granskarens bana).
    expect(tracker.reserve(first(-22, 279), JVB.name, { passageBehind: false, travelSign: -1 })).not.toBeNull();
    const outAt = now + 120000;
    step(-176, () => ({ lastPassedBridge: JVB.name, lastPassedBridgeTime: outAt, passedBridges: [JVB.name] }));
    return outAt;
  }

  test('förvarningen 22 m söder om linjen söderut: bortre sidan är söder (förut norr)', () => {
    noticeBeyondThenOutbound();
    expect(farSign()).toBe(-1);
  });

  test('vänder, väntar 4 m söder om linjen, en brusfix 14 m norr om den och sedan 248 m söderut: ingen falsk retur', () => {
    const outAt = noticeBeyondThenOutbound();
    const turned = {
      _routeDirection: 'south', sog: 0.1, cog: 300, lastPassedBridge: JVB.name, lastPassedBridgeTime: outAt,
    };
    expect(release(step(-4, turned))).toBeFalsy();
    // Brusfixen: farten är inflygningens (3,5 kn) och utpassagens bokföring står kvar.
    expect(release(step(14, { ...turned, sog: 3.5, cog: NORTH_COG }))).toBeFalsy();
    const away = step(-248, {
      _routeDirection: 'south', sog: 4, cog: SOUTH_COG, lastPassedBridge: JVB.name, lastPassedBridgeTime: outAt,
    });
    expect(release(away)).toBeFalsy();
    expect(tracker.holds(MMSI, JVB.name)).toBe(true);
  });

  test('verklig retur norrut genom bron: besöket släpps (förut ingen notis)', () => {
    noticeBeyondThenOutbound();
    step(-60, { _routeDirection: 'north', sog: 4, cog: NORTH_COG });
    const back = step(60, () => ({
      _routeDirection: 'north', sog: 4, cog: NORTH_COG, lastPassedBridge: JVB.name, lastPassedBridgeTime: now,
    }));
    expect(release(back)).toMatchObject({ farSign: -1, evidence: 'ankomstsidan' });
  });

  test('motfall: förvarning före linjen ger bortre sidan framför båten som förut', () => {
    tracker.reserve(first(200, 500), JVB.name, { travelSign: -1 });
    expect(farSign()).toBe(-1);
  });

  test('motfall: kursen pekar tillbaka mot bron (ruttlåset ännu inte vänt): bortre sidan som förut', () => {
    tracker.reserve(first(-22, 279, { cog: NORTH_COG }), JVB.name, { travelSign: -1 });
    expect(farSign()).toBe(1);
  });

  test('motfall: okänd färdriktning ger bortre sidan som förut', () => {
    tracker.reserve(first(-22, 279, { _routeDirection: null }), JVB.name, { travelSign: 0 });
    expect(farSign()).toBe(1);
  });

  test('motfall: på linjen (±10 m) följer bortre sidan ruttriktningen som förut', () => {
    tracker.reserve(first(-6, 279), JVB.name, { travelSign: -1 });
    expect(farSign()).toBe(-1);
  });

  test('utan travelSign gäller ruttlåset (äldre anrop)', () => {
    tracker.reserve(first(-22, 279), JVB.name);
    expect(farSign()).toBe(-1);
  });

  // H1-vakten, ben 1: farten bär beviset när föregående position saknas eller
  // också låg bortom linjen.
  test('farten bär: 25 m bortom linjen i 5 kn utan föregående position, bortre sidan söder', () => {
    tracker.reserve(first(-25, null), JVB.name, { travelSign: -1 });
    expect(farSign()).toBe(-1);
  });

  test('farten bär: föregående position också bortom linjen, i 5 kn', () => {
    tracker.reserve(first(-120, -60), JVB.name, { travelSign: -1 });
    expect(farSign()).toBe(-1);
  });

  describe('H1 (granskningen av N6): driver bort från bron på tillfartssidan och går sedan igenom', () => {
    // Båten ligger söder om Järnvägsbron och ska norrut genom den. Hon driver
    // söderut, bort från bron, i 1 kn; kursen och ruttlåset (som driften satt)
    // säger söderut, så förvarningen (söderut) går ut på en position "bortom"
    // linjen. Hon har inte passerat bron, och hennes passage norrut är den
    // enda: ingen andra notis. Med (b) utan vakten fick hon bortre sidan söder,
    // och passagen blev ett retursläpp (granskarens driftsvep: 44 av 60).
    const drifting = { _routeDirection: 'south', sog: 1.0, cog: SOUTH_COG };
    const north = { _routeDirection: 'north', sog: 4, cog: NORTH_COG };

    test('tät kadens (30 s): bortre sidan norr som förut, passagen ger inget retursläpp', () => {
      tracker.reserve(first(-200, -180, drifting), JVB.name, { travelSign: -1 });
      expect(farSign()).toBe(1);
      for (const d of [-215, -230, -228, -231]) step(d, { ...drifting, sog: 0.6, cog: 120 }, 30);
      for (const d of [-170, -110, -50]) expect(release(step(d, north, 30))).toBeFalsy();
      const booked = () => ({
        ...north, lastPassedBridge: JVB.name, lastPassedBridgeTime: now, passedBridges: [JVB.name],
      });
      expect(release(step(10, booked, 30))).toBeFalsy();
      expect(release(step(70, north, 30))).toBeFalsy();
      expect(tracker.holds(MMSI, JVB.name)).toBe(true);
    });

    test('gles kadens (120 s): nästa position redan norr om bron, inget retursläpp', () => {
      tracker.reserve(first(-200, -170, drifting), JVB.name, { travelSign: -1 });
      expect(farSign()).toBe(1);
      const booked = () => ({
        ...north, lastPassedBridge: JVB.name, lastPassedBridgeTime: now, passedBridges: [JVB.name],
      });
      expect(release(step(150, booked, 120))).toBeFalsy();
      expect(release(step(400, north, 120))).toBeFalsy();
      expect(tracker.holds(MMSI, JVB.name)).toBe(true);
    });
  });

  // Alla fem broarna åt båda hållen: förvarningen 25 m bortom linjen ger bortre
  // sidan där båten ligger, och en verklig retur släpps.
  const BOTH = [];
  for (const key of ['olidebron', 'klaffbron', 'jarnvagsbron', 'stridsbergsbron', 'stallbackabron']) {
    BOTH.push([BRIDGES[key].name, 'south'], [BRIDGES[key].name, 'north']);
  }
  test.each(BOTH)('%s %s: förvarning 25 m bortom linjen, sedan verklig retur', (name, travel) => {
    const b = Object.values(BRIDGES).find((x) => x.name === name);
    const sign = travel === 'north' ? 1 : -1;
    const ahead = { _routeDirection: travel, cog: travel === 'north' ? NORTH_COG : SOUTH_COG, sog: 5 };
    const back = { _routeDirection: travel === 'north' ? 'south' : 'north', cog: travel === 'north' ? SOUTH_COG : NORTH_COG, sog: 4 };
    const v = (d, extra) => ({
      mmsi: MMSI, ...at(b, sign * d), timestamp: now, lastPositionUpdate: now, fixTs: now, fixFeed: 'aisstream', ...extra,
    });
    // Föregående position 200 m före linjen: korsningen skedde i segmentet.
    expect(tracker.reserve(v(25, { ...ahead, lastPosition: at(b, -sign * 200) }), name, { travelSign: sign })).not.toBeNull();
    expect(tracker.exportSnapshot().entries[`${MMSI}:${name}`].farSign).toBe(sign);
    now += 60000;
    tracker.observe(v(200, { ...ahead, lastPassedBridge: name, lastPassedBridgeTime: now }), name);
    now += 60000;
    tracker.observe(v(60, back), name);
    now += 60000;
    const ret = v(-60, { ...back, lastPassedBridge: name, lastPassedBridgeTime: now });
    tracker.observe(ret, name);
    expect(tracker.releaseReturnPassage(ret, name, LIMITS)).toMatchObject({ farSign: sign, evidence: 'ankomstsidan' });
  });

  describe('motfall: väntar strax FÖRE bron, förvarningen gick ut på en brusposition bortom linjen', () => {
    // Båten går söderut och väntar 14–18 m norr om linjen (entydigt på
    // tillfartssidan); förvarningen gick ut på en brusfix 13 m söder om den,
    // med föregående position 16 m norr om linjen (H1-vaktens ben 2: korsningen
    // i segmentet). Besöket får bortre sidan söder men noterar den inte som sedd.
    function waitWithNoise() {
      expect(tracker.reserve(first(-13, 16, { sog: 0.3, cog: 200 }), JVB.name, { travelSign: -1 })).not.toBeNull();
      for (const d of [16, 14, 18, 15]) step(d, { sog: 0.2, cog: 90 }, 30);
    }

    test('bortre sidan är söder, men den är inte sedd', () => {
      waitWithNoise();
      expect(farSign()).toBe(-1);
      expect(tracker.exportSnapshot().entries[`${MMSI}:${JVB.name}`].farSideSeenAt).toBeNull();
    });

    test('vänder och åker norrut igen med en falsk bokföring vid linjen: ingen retur', () => {
      waitWithNoise();
      const booked = () => ({
        _routeDirection: 'north', sog: 3.5, cog: NORTH_COG, lastPassedBridge: JVB.name, lastPassedBridgeTime: now,
      });
      expect(release(step(5, booked, 30))).toBeFalsy();
      expect(release(step(60, booked, 30))).toBeFalsy();
      expect(release(step(150, { _routeDirection: 'north', sog: 4, cog: NORTH_COG }, 30))).toBeFalsy();
    });

    // Förut (bortre sidan norr) gav den verkliga passagen ett retursläpp: en
    // andra notis, "har precis passerat", för samma passage.
    test('passerar söderut när bron öppnar: ingen andra notis för samma passage', () => {
      waitWithNoise();
      const booked = () => ({
        sog: 4, lastPassedBridge: JVB.name, lastPassedBridgeTime: now, passedBridges: [JVB.name],
      });
      expect(release(step(-40, booked, 30))).toBeFalsy();
      expect(release(step(-160, { sog: 4 }, 30))).toBeFalsy();
      expect(tracker.holds(MMSI, JVB.name)).toBe(true);
    });
  });
});

describe('N6 (a): BN2 prövar också svepets portgissning för en ny båt', () => {
  let apps;
  let savedTestMode;

  const boot = async () => {
    const store = {};
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: (key) => (store[key] === undefined ? undefined : JSON.parse(JSON.stringify(store[key]))),
        set: jest.fn((key, value) => {
          store[key] = JSON.parse(JSON.stringify(value));
        }),
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    await app.onInit();
    apps.push(app);
    jest.spyOn(app._boatNearTrigger, 'trigger');
    return app;
  };

  // Första fixen för en båt som aldrig setts: ingen föregående fix, ingen sist känd position.
  const newVessel = (pos, travel, extra = {}) => ({
    mmsi: '261435000',
    name: 'NEST',
    ...pos,
    lastPosition: null,
    _firstSeenLat: pos.lat,
    _firstSeenLon: pos.lon,
    sog: 5.6,
    cog: travel === 'north' ? 40 : 222.4,
    _routeDirection: null,
    targetBridge: null,
    status: 'en-route',
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    ...extra,
  });
  const cand = (bridge, pos, source = 'current') => ({
    name: bridge.name,
    id: Object.keys(BRIDGES).find((k) => BRIDGES[k] === bridge),
    distance: geometry.calculateDistance(pos.lat, pos.lon, bridge.lat, bridge.lon),
    source,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-13T09:51:58.000Z'));
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    apps = [];
  });

  afterEach(async () => {
    for (const app of apps) {
      // eslint-disable-next-line no-await-in-loop
      if (!app._shuttingDown) await app.onUninit();
    }
    await jest.advanceTimersByTimeAsync(0);
    global.__TEST_MODE__ = savedTestMode;
    jest.useRealTimers();
  });

  test('NEST-fallet: ny båt 248 m söder om Stallbackabron söderut får passerad form', async () => {
    const app = await boot();
    const stall = BRIDGES.stallbackabron;
    // Fältets position (20260713-41h 09:51:58).
    const pos = { lat: 58.308121666666665, lon: 12.313858333333334 };
    expect(geometry.bridgeLineOffsetM(pos, stall)).toBeLessThan(-200);
    const v = newVessel(pos, 'south');
    const candidate = cand(stall, pos);
    expect(app._hasGapCrossedNotifiedBridge(v, candidate, 'current')).toBe(true);
    await app._triggerBoatNearFlowForBridge(v, candidate);
    const [[tokens]] = app._boatNearTrigger.trigger.mock.calls;
    expect(tokens.already_passed).toBe(true);
    expect(tokens.eta_minutes).toBe(-1);
    expect(tokens.message).toBe('NEST passerade Stallbackabron under AIS-tystnad');
  });

  // [bro, färd, d m bortom linjen i färdriktningen, väntat]
  const CASES = [];
  for (const key of ['olidebron', 'klaffbron', 'jarnvagsbron', 'stridsbergsbron', 'stallbackabron']) {
    const b = BRIDGES[key];
    CASES.push(
      // 120 m norr om Klaffbron ligger kajen (kajvakten avstår, som svepet).
      [b.name, 'north', 120, key !== 'klaffbron'],
      [b.name, 'south', 120, true],
      // Vid bron (inom 70 m): förvarningen står kvar.
      [b.name, 'north', 40, false],
      [b.name, 'south', 40, false],
      // Före linjen: bron ligger framför.
      [b.name, 'north', -120, false],
      [b.name, 'south', -120, false],
    );
  }
  test.each(CASES)('%s %s %s m bortom linjen: %s', async (name, travel, d, expected) => {
    const app = await boot();
    const b = Object.values(BRIDGES).find((x) => x.name === name);
    const pos = at(b, travel === 'north' ? d : -d);
    expect(app._hasGapCrossedNotifiedBridge(newVessel(pos, travel), cand(b, pos), 'current')).toBe(expected);
  });

  test.each([
    ['långsam båt (1,1 kn, HALIFAX)', { sog: 1.1 }],
    ['kurs i östbandet', { cog: 90 }],
    ['kurs saknas', { cog: null }],
    ['ruttlåset säger motsatt håll', { _routeDirection: 'north' }],
    ['målbron är den här bron (flow-trigger-bridges: 110 m söder om Klaffbron, kurs söderut)', { targetBridge: 'Stallbackabron' }],
    ['GPS-hopp hålls', { _gpsJumpDetected: true }],
  ])('motfall: %s ger förvarningen som förut', async (_label, extra) => {
    const app = await boot();
    const stall = BRIDGES.stallbackabron;
    const pos = at(stall, -150);
    const v = newVessel(pos, 'south', extra);
    if (extra._gpsJumpDetected) jest.spyOn(app.vesselDataService, 'hasGpsJumpHold').mockReturnValue(true);
    expect(app._hasGapCrossedNotifiedBridge(v, cand(stall, pos), 'current')).toBe(false);
  });

  test('motfall: första positionen vid en kajplats (kajvakten) ger förvarningen som förut', async () => {
    const app = await boot();
    const klaff = BRIDGES.klaffbron;
    const pos = at(klaff, 150);
    jest.spyOn(app.vesselDataService, 'isNearMooringZone').mockReturnValue(true);
    expect(app._hasGapCrossedNotifiedBridge(newVessel(pos, 'north'), cand(klaff, pos), 'current')).toBe(false);
  });

  test('motfall: båt med föregående fix (EUGENIE, ingen ny båt) ger förvarningen som förut', async () => {
    const app = await boot();
    const klaff = BRIDGES.klaffbron;
    const pos = at(klaff, 268);
    const v = newVessel(pos, 'north', { lastPosition: at(klaff, 232), sog: 1.9 });
    expect(app._hasGapCrossedNotifiedBridge(v, cand(klaff, pos), 'current')).toBe(false);
  });

  test('motfall: återfödd båt med sist känd position nära (under 100 m) prövas inte som ny', async () => {
    const app = await boot();
    const stall = BRIDGES.stallbackabron;
    const pos = at(stall, -150);
    app._lastKnownPositions.set('261435000', { ...at(stall, -100), t: Date.now() - 5 * 60 * 1000 });
    expect(app._hasGapCrossedNotifiedBridge(newVessel(pos, 'south'), cand(stall, pos), 'current')).toBe(false);
  });
});

describe('N6: granskarens bana i replay (120 s kadens, Järnvägsbron söderut)', () => {
  const P = buildPath();
  const M = pathMetrics(P);
  const b = M.cum[3];

  // Svepets bana: söderut i 5 kn förbi bron, till 176 m bortom, tillbaka till
  // 4 m bortom i 3,5 kn, stopp 300 s, sedan bort söderut eller tillbaka norrut.
  function run(efter, seed, outlierX = null) {
    const legs = [
      { toS: b - 176, speedKn: 5, intervalS: 120 },
      { toS: b - 4, speedKn: 3.5, intervalS: 120 },
      { stopS: 300, stopIntervalS: 120, stopCogRandom: true },
      efter === 'bort' ? { toS: b - 900, speedKn: 4, intervalS: 120 } : { toS: b + 900, speedKn: 4, intervalS: 120 },
    ];
    const samples = generateScenario({
      name: 'N6',
      seed,
      vessels: [{
        mmsi: `94${String(seed).padStart(7, '0')}`, name: 'GRSVEP', jitterM: 3, startS: b + 900, legs,
      }],
    });
    if (outlierX !== null) {
      // Brusfixen: den inflygningsfix som ligger närmast stoppunkten flyttas X m norr om bron.
      const { pointAt } = require('./replay-validation/scenarioGenerator');
      const stop = pointAt(P, M, b - 4);
      let best = -1;
      let bd = Infinity;
      samples.forEach((s, i) => {
        if (s.sog > 1) {
          const d = Math.hypot((s.lat - stop.lat) * 111320, (s.lon - stop.lon) * 111320 * Math.cos((s.lat * Math.PI) / 180));
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      });
      const q = pointAt(P, M, b + outlierX);
      samples[best].lat = q.lat;
      samples[best].lon = q.lon;
      samples[best].sog = 3.5;
    }
    const tmp = path.join(os.tmpdir(), `n6-${process.pid}-${seed}.jsonl`);
    fs.writeFileSync(tmp, samples.map((s) => JSON.stringify(s)).join('\n'));
    try {
      const out = execFileSync('node', [RUNNER, tmp], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
      const r = JSON.parse(out.match(/__REPLAY_JSON__([\s\S]*?)__END__/)[1]);
      return r.notifications.filter((x) => x.bridge === JVB.name).map((x) => x.message);
    } finally {
      fs.unlinkSync(tmp);
    }
  }

  test('bort med brusfix 14 m norr om bron: en notis, ingen sen falsk "har precis passerat"', () => {
    const msgs = run('bort', 73265, 14);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/närmar sig Järnvägsbron/);
  }, 120000);

  test('passerar tillbaka norrut, utan brusfix: returen får sin notis', () => {
    const msgs = run('passerar', 73316);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatch(/har precis passerat Järnvägsbron|passerade Järnvägsbron under AIS-tystnad/);
  }, 120000);
});
