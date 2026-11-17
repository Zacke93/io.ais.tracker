'use strict';

/**
 * U51 (dirigentens beslut 2026-11-17, ägarfrågan F8 alternativ (c)): en båt som
 * legat förtöjd minst 2 h vid en ytterpunkt får ett nytt besök när hon lägger
 * ut. Förtöjningen ska vara belagd fix för fix (stilla enligt appens
 * förtöjningsmått, inom 40 m från ankaret, glapp högst 60 min) och avgången
 * belagd (i transitfart högst 50 m från punktens linje eller förbi den, minst
 * 50 m mot linjen från ankaret, rörelse i två fixar). Motfallen låser att
 * väntan, kajbyte, brus och tystnad inte släpper besöket.
 *
 * ELFKUNGEN- och PRICKBJORN-positionerna är rådata (20260806-42h och k2, UTC).
 */

const TriggerPointVisitTracker = require('../lib/services/TriggerPointVisitTracker');
const { BRIDGES, TRIGGER_POINTS } = require('../lib/constants');

const KANAL = TRIGGER_POINTS.kanalinfarten;
const KLAFF = BRIDGES.klaffbron;
const MMSI = '265012090';
const M_LAT = 6371000 * Math.PI / 180;
const MIN = 60 * 1000;
const ELF_KAJ = { lat: 58.26624, lon: 12.26544 }; // ELFKUNGENs kaj, 291 m ut från linjen
const LOTSKAJ = { lat: 58.2673, lon: 12.26687 }; // PRICKBJORNs plats, 149 m ut

/** Position `m` meter längs kanalaxeln från punkten (+ = nordöstra sidan). */
function along(point, m) {
  const normal = (((point.axisBearing || 125) - 90) * Math.PI) / 180;
  return {
    lat: point.lat + (m * Math.cos(normal)) / M_LAT,
    lon: point.lon + (m * Math.sin(normal)) / (M_LAT * Math.cos((point.lat * Math.PI) / 180)),
  };
}

/**
 * Position `m` meter längs kanalaxeln och `side` meter i sidled (längs punktens
 * linje, axisBearing; negativt mot kajraden väster om Kanalinfarten).
 */
function at2(point, m, side) {
  const base = along(point, m);
  const dir = ((point.axisBearing || 125) * Math.PI) / 180;
  return {
    lat: base.lat + (side * Math.cos(dir)) / M_LAT,
    lon: base.lon + (side * Math.sin(dir)) / (M_LAT * Math.cos((point.lat * Math.PI) / 180)),
  };
}

describe('U51: förtöjd minst 2 h vid en ytterpunkt, ny notis vid avgången', () => {
  let now;
  let tracker;

  beforeEach(() => {
    now = Date.parse('2026-11-12T19:00:00Z');
    tracker = new TriggerPointVisitTracker({ now: () => now });
  });

  function fix(pos, overrides = {}) {
    return {
      mmsi: MMSI, ...pos, timestamp: now, lastPositionUpdate: now, fixTs: now, ...overrides,
    };
  }
  function step(ms, pos, overrides = {}, t = tracker, point = KANAL) {
    now += ms;
    return t.observe(fix(pos, overrides), point.name);
  }
  /** Förtöjd vid `pos` i `minutes` minuter med en stilla fix var `every`:e minut. */
  function moor(pos, minutes, every = 3, t = tracker, point = KANAL, overrides = {}) {
    for (let m = 0; m < minutes; m += every) step(every * MIN, pos, { sog: 0, cog: 172, ...overrides }, t, point);
  }
  const holds = (t = tracker, point = KANAL) => t.holds(MMSI, point.name);
  /** PRICKBJORNs avgång från lotskajen 13/11 06:47:43–06:48:47 (rådata). */
  function lotskajDeparture(t = tracker) {
    step(80000, { lat: 58.2673, lon: 12.26714 }, { sog: 2.4, cog: 99.7 }, t);
    return step(64000, { lat: 58.26771, lon: 12.2691 }, { sog: 4.6, cog: 35.2 }, t);
  }

  describe('avgången efter en belagd förtöjning släpper besöket', () => {
    test('PRICKBJORN (k2 13/11): 11 h vid lotskajen, avgång 36 m från linjen i 4,6 kn', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      step(60000, along(KANAL, -200), { sog: 3, cog: 300 });
      moor(LOTSKAJ, 11 * 60);
      expect(holds()).toBe(true);
      expect(lotskajDeparture()).toEqual({ changed: true, reentered: true, pastLine: false });
      expect(holds()).toBe(false);
    });

    test('ELFKUNGEN (20260806-42h): ankomst söderut, 21 h vid kajen med glapp upp till 45 min, avgång norrut', () => {
      now = Date.parse('2026-08-06T12:40:02Z');
      const elf = (lat, lon, sog, cog) => [{ lat, lon }, { sog, cog }];
      tracker.reserve(fix({ lat: 58.27007, lon: 12.27188 }, { sog: 6, cog: 212.8 }));
      step(60000, ...elf(58.26864, 12.27024, 6, 212.3));
      step(90000, ...elf(58.26667, 12.26793, 4.5, 223.7));
      step(60000, ...elf(58.26611, 12.2663, 2.7, 279.1));
      step(60000, ...elf(58.26623, 12.26549, 0.8, 280.7));
      for (const gap of [1, 6, 9, 27, 45, 15, 33, 45, 12, 30, 42, 20, 45, 3, 18, 40, 25, 45, 30, 44, 35, 36, 45, 30, 40]) {
        step(gap * MIN, ELF_KAJ, { sog: 0, cog: 275.4 });
      }
      step(9 * MIN, ...elf(58.2663, 12.26631, 2.1, 55.1));
      // 69 m från punkten men 69 m ut från linjen: inte i avgångsbandet.
      expect(step(85000, ...elf(58.2675, 12.26868, 6, 32.9)).reentered).toBe(false);
      // Förbi linjen, 203 m in i kanalen: passagen är gjord (granskningen H1).
      expect(step(90000, ...elf(58.26957, 12.27116, 5.8, 32.2))).toEqual({ changed: true, reentered: true, pastLine: true });
    });

    test('M2-gränsen åt andra hållet: 45 m före linjen och 65 m från punkten släpps (ingen kajplats ligger närmare än 123 m)', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(LOTSKAJ, 180);
      const side = -Math.sqrt(65 * 65 - 45 * 45);
      step(60000, at2(KANAL, -100, side), { sog: 2.5, cog: 35 });
      expect(step(40000, at2(KANAL, -45, side), { sog: 3, cog: 35 })).toEqual({ changed: true, reentered: true, pastLine: false });
    });

    test('omstart under förtöjningen: belägget sparas, och en förtöjning före beviset fortsätter efter omstarten', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(LOTSKAJ, 70);
      const mid = new TriggerPointVisitTracker({ now: () => now });
      expect(mid.loadSnapshot(JSON.parse(JSON.stringify(tracker.exportSnapshot())))).toBe(1);
      moor(LOTSKAJ, 70, 3, mid);
      const restored = new TriggerPointVisitTracker({ now: () => now });
      restored.loadSnapshot(JSON.parse(JSON.stringify(mid.exportSnapshot())));
      expect(restored.exportSnapshot().entries[`${MMSI}:${KANAL.name}`].moorProven).toBe(true);
      expect(lotskajDeparture(restored).reentered).toBe(true);
    });

    test('byter kajplats efter beviset och lägger ut därifrån: avgången räknas', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(ELF_KAJ, 180);
      step(60000, along(KANAL, -230), { sog: 2.5, cog: 40 });
      step(60000, along(KANAL, -150), { sog: 2.5, cog: 40 });
      moor(along(KANAL, -150), 30);
      expect(holds()).toBe(true);
      step(60000, along(KANAL, -100), { sog: 3, cog: 35 });
      expect(step(40000, along(KANAL, -20), { sog: 5, cog: 35 }).reentered).toBe(true);
    });

    test('lotsbåten ut och in samma dag: en avgångsnotis per avgång efter minst 2 h, ingen efter 1 h', () => {
      let releases = 0;
      const depart = () => {
        step(60000, along(KANAL, -120), { sog: 2.5, cog: 35 });
        const r = step(60000, along(KANAL, -20), { sog: 5, cog: 35 });
        if (r.reentered) releases++;
        return r.reentered;
      };
      const trip = () => {
        // Appen notifierar avgången (nytt besök), båten går in i kanalen och
        // kommer tillbaka (två fixar över 350 m, återkomst), och notifieras igen.
        tracker.reserve(fix(along(KANAL, 60), { sog: 5, cog: 35 }));
        step(60000, along(KANAL, 400), { sog: 6, cog: 35 });
        step(60000, along(KANAL, 600), { sog: 6, cog: 35 });
        step(40 * MIN, along(KANAL, 200), { sog: 6, cog: 215 });
        tracker.reserve(fix(along(KANAL, 150), { sog: 6, cog: 215 }));
        step(60000, along(KANAL, -100), { sog: 3, cog: 215 });
      };
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(LOTSKAJ, 180);
      expect(depart()).toBe(true);
      trip();
      moor(LOTSKAJ, 60);
      expect(depart()).toBe(false);
      expect(holds()).toBe(true);
      // Fortfarande samma besök; tillbaka till kajen och 2,5 h till.
      moor(LOTSKAJ, 150);
      expect(depart()).toBe(true);
      expect(releases).toBe(2);
    });
  });

  describe('motfall: besöket står kvar', () => {
    test('väntar eller guppar i zonen i 1 h 50 min och går sedan in i kanalen', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(LOTSKAJ, 110);
      expect(lotskajDeparture().reentered).toBe(false);
      expect(holds()).toBe(true);
    });

    test('guppar i 3 h med 0,3–1,5 kn inom 40 m: ingen stilla fix räcker till ett belägg', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      for (let i = 0; i < 60; i++) step(3 * MIN, LOTSKAJ, { sog: 0.3 + (i % 5) * 0.3, cog: (i * 73) % 360 });
      expect(lotskajDeparture().reentered).toBe(false);
    });

    test('byter kajplats inom zonen efter 3 h (ELFKUNGENs kaj → lotskajen): ingen ny notis', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(ELF_KAJ, 180);
      step(60000, along(KANAL, -230), { sog: 2.5, cog: 40 });
      expect(step(60000, along(KANAL, -150), { sog: 3, cog: 40 }).reentered).toBe(false);
      moor(along(KANAL, -150), 60);
      expect(holds()).toBe(true);
    });

    test('förtöjd i 3 h med en ensam brusposition i fart i avgångsbandet', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(LOTSKAJ, 180);
      expect(step(60000, along(KANAL, -20), { sog: 3.5, cog: 35 }).reentered).toBe(false);
      step(60000, LOTSKAJ, { sog: 0 });
      expect(holds()).toBe(true);
    });

    test('tyst i 2 h utan belagd förtöjning: rörelse före tystnaden, eller ett glapp över 60 min mellan stilla fixar', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      step(60000, LOTSKAJ, { sog: 1.0, cog: 90 });
      step(130 * MIN, LOTSKAJ, { sog: 0 });
      expect(lotskajDeparture().reentered).toBe(false);
      const t = new TriggerPointVisitTracker({ now: () => now });
      t.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(LOTSKAJ, 30, 3, t);
      step(61 * MIN, LOTSKAJ, { sog: 0 }, t);
      moor(LOTSKAJ, 60, 3, t);
      expect(lotskajDeparture(t).reentered).toBe(false);
    });

    test('lägger ut efter 3 h, får sin notis och lägger genast till igen: nästa avgång efter 30 min släpps inte', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(LOTSKAJ, 180);
      expect(lotskajDeparture().reentered).toBe(true);
      tracker.reserve(fix(along(KANAL, -36), { sog: 4.6, cog: 35 }));
      step(60000, along(KANAL, -100), { sog: 2, cog: 215 });
      moor(LOTSKAJ, 30);
      expect(lotskajDeparture().reentered).toBe(false);
      expect(holds()).toBe(true);
    });

    test('förtöjd i 3 h och går ut ur kanalen söderut (bort från linjen): ingen release (FP8 orörd)', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(LOTSKAJ, 180);
      step(60000, along(KANAL, -200), { sog: 3, cog: 215 });
      expect(step(60000, along(KANAL, -280), { sog: 4, cog: 215 }).reentered).toBe(false);
    });

    test('glesa fixar: avgången som bara antas ur ett glapp över 10 min släpps inte (U21)', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(LOTSKAJ, 180);
      step(60000, LOTSKAJ, { sog: 1.0, cog: 35 });
      expect(step(11 * MIN, along(KANAL, -20), { sog: 5, cog: 35 }).reentered).toBe(false);
    });

    // Granskningen av U51 (M1): varje kärnvillkor i avgången fäller ett eget fall.
    test('förtöjd 3 h i bandet (30 m före linjen, 50 m från punkten) och rör sig i sidled i 3 kn: under 50 m mot linjen, inget släpp', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      const kaj = at2(KANAL, -30, -40);
      step(60000, kaj, { sog: 0 });
      moor(kaj, 180);
      step(60000, at2(KANAL, -25, 0), { sog: 3, cog: 125 });
      expect(step(40000, at2(KANAL, -20, 30), { sog: 3, cog: 125 }).reentered).toBe(false);
      expect(holds()).toBe(true);
    });

    test('fix i bandet i 3 kn efter en fix i fart, men kursen tillbaka mot kajen: inget släpp', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(LOTSKAJ, 180);
      step(60000, along(KANAL, -100), { sog: 2.5, cog: 35 });
      expect(step(40000, along(KANAL, -20), { sog: 3, cog: 215 }).reentered).toBe(false);
      expect(holds()).toBe(true);
    });

    test('ett hopp in i bandet på 100 m på 10 s (10 m/s mot rapporterade 3 kn) efter en fix i fart: inget släpp', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(LOTSKAJ, 180);
      step(60000, along(KANAL, -120), { sog: 2.5, cog: 35 });
      expect(step(10000, along(KANAL, -20), { sog: 3, cog: 35 }).reentered).toBe(false);
      expect(holds()).toBe(true);
    });

    test('förhalning genom bandet i 1,5 kn (under 2 kn): inget släpp', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(LOTSKAJ, 180);
      step(100000, along(KANAL, -100), { sog: 1.5, cog: 35 });
      expect(step(100000, along(KANAL, -20), { sog: 1.5, cog: 35 }).reentered).toBe(false);
      expect(holds()).toBe(true);
    });

    // Granskningen av U51 (M2): före linjen högst 70 m från punkten. B1 slutade
    // 48 m före linjen och 114 m från punkten; grannarna 90 och 75 m.
    test.each([114, 90, 75])('förhalning i sidled från lotskajen till 45 m före linjen, %i m från punkten: inget släpp', (dist) => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(LOTSKAJ, 180);
      const side = -Math.sqrt(dist * dist - 45 * 45);
      step(60000, at2(KANAL, -100, side), { sog: 2.2, cog: 35 });
      expect(step(40000, at2(KANAL, -45, side), { sog: 2.2, cog: 35 }).reentered).toBe(false);
      expect(holds()).toBe(true);
    });

    test('andra broar än ytterpunkterna berörs inte (Klaffbron)', () => {
      const pos = along(KLAFF, -150);
      tracker.reserve(fix(along(KLAFF, -250), { sog: 5, cog: 40 }), KLAFF.name);
      moor(pos, 180, 3, tracker, KLAFF);
      step(60000, along(KLAFF, -100), { sog: 3, cog: 40 }, tracker, KLAFF);
      expect(step(40000, along(KLAFF, -20), { sog: 5, cog: 40 }, tracker, KLAFF).reentered).toBe(false);
      expect(holds(tracker, KLAFF)).toBe(true);
    });

    test('ögonblicksbilder: skadade förtöjningsfält ger inget belägg', () => {
      tracker.reserve(fix(along(KANAL, -250), { sog: 5, cog: 35 }));
      moor(LOTSKAJ, 180);
      const key = `${MMSI}:${KANAL.name}`;
      const snap = tracker.exportSnapshot();
      for (const patch of [{ moorSince: 'x' }, { moorLastTs: snap.entries[key].lastFixTs + 1000 },
        { moorSince: snap.entries[key].moorLastTs - 60 * MIN }, { moorLat: null }]) {
        const copy = JSON.parse(JSON.stringify(snap));
        Object.assign(copy.entries[key], patch);
        const restored = new TriggerPointVisitTracker({ now: () => now });
        restored.loadSnapshot(copy);
        expect(restored.exportSnapshot().entries[key].moorProven ?? false).toBe(false);
      }
    });
  });
});
