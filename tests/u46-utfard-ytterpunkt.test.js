'use strict';

/**
 * U46 (dirigentens beslut 2026-11-17, registerposten BN1-BOXKANT): en båt som
 * lämnar kanalen utåt vid en ytterpunkt (Kanalinfarten, Stallbackabron) utan
 * två fixar över 350 m har avslutat sitt besök. Utåtbeviset (yttre sidan,
 * minst 50 m längre bort, minst 2 kn, rimligt segment) stänger besöket först
 * när nästa rena fix kommer minst 10 min senare. Motfallen låser att en båt
 * som hörs igen i zonen (lägger till, vänder, guppar) behåller sitt besök.
 *
 * Positionerna i ELFKUNGEN-fallet är rådata ur korpusen 20260806-42h (UTC).
 */

const TriggerPointVisitTracker = require('../lib/services/TriggerPointVisitTracker');
const { BRIDGES, TRIGGER_POINTS } = require('../lib/constants');

const MMSI = '265012090';
const KANAL = TRIGGER_POINTS.kanalinfarten;
const STALL = BRIDGES.stallbackabron;
const KLAFF = BRIDGES.klaffbron;
const M_LAT = 6371000 * Math.PI / 180;
const MIN = 60 * 1000;

/** Position `m` meter längs kanalaxeln från punkten (+ = nordöstra sidan). */
function along(point, m) {
  const normal = (((point.axisBearing || 125) - 90) * Math.PI) / 180;
  return {
    lat: point.lat + (m * Math.cos(normal)) / M_LAT,
    lon: point.lon + (m * Math.sin(normal)) / (M_LAT * Math.cos((point.lat * Math.PI) / 180)),
  };
}

describe('U46: utfärd vid ytterpunkterna', () => {
  let now;
  let tracker;

  beforeEach(() => {
    now = Date.parse('2026-11-13T07:12:32Z');
    tracker = new TriggerPointVisitTracker({ now: () => now });
  });

  function vessel(pos, overrides = {}) {
    return {
      mmsi: MMSI, ...pos, timestamp: now, lastPositionUpdate: now, fixTs: now, ...overrides,
    };
  }
  const at = (point, m, overrides) => vessel(along(point, m), overrides);
  // Utåtbeviset i den sparade posten (null när det saknas, även före U46).
  const proof = (t, mmsi, point) => t.exportSnapshot().entries[`${mmsi}:${point.name}`]?.outwardFixTs ?? null;
  function step(ms, point, v, t = tracker) {
    now += ms;
    return t.observe({
      ...v, timestamp: now, lastPositionUpdate: now, fixTs: now,
    }, point.name);
  }

  describe('utfärden släpper besöket när båten kommer tillbaka', () => {
    test('VISTEN-klassen vid Stallbackabron: 46 m → 267 m norr i 7 kn, tyst, åter efter 3 h', () => {
      expect(tracker.reserve(at(STALL, -150, { sog: 7, cog: 37, _routeDirection: 'north' }), STALL.name)).not.toBeNull();
      step(60000, STALL, at(STALL, 46, { sog: 7.0, cog: 31 }));
      step(69000, STALL, at(STALL, 267, { sog: 7.6, cog: 16 }));
      expect(tracker.holds(MMSI, STALL.name)).toBe(true);
      expect(tracker.exportSnapshot().entries[`${MMSI}:${STALL.name}`].outwardFixTs).toBe(now);
      expect(step(3 * 60 * MIN, STALL, at(STALL, 250, { sog: 7, cog: 210, _routeDirection: 'south' })))
        .toEqual({ changed: true, reentered: true });
      expect(tracker.holds(MMSI, STALL.name)).toBe(false);
    });

    test('PRICKBJORN (fältet 13/11): en enda fix norr om bron i 10 kn, tyst i 6,5 h, åter söderut', () => {
      tracker.reserve(at(STALL, -56, { sog: 10.1, cog: 40, _routeDirection: 'north' }), STALL.name);
      step(64000, STALL, at(STALL, 288, { sog: 10.1, cog: 18 }));
      // Första fixen efter tystnaden ligger utanför zonen: utfärden bekräftas,
      // återkomsten väntar på en fix inom 300 m.
      expect(step(6.5 * 60 * MIN, STALL, at(STALL, 486, { sog: 10.2, cog: 190 })))
        .toEqual({ changed: true, reentered: false });
      expect(tracker.holds(MMSI, STALL.name)).toBe(true);
      expect(step(47000, STALL, at(STALL, 329, { sog: 10.1, cog: 199 })).reentered).toBe(false);
      expect(step(68000, STALL, at(STALL, 8, { sog: 10.2, cog: 216 })))
        .toEqual({ changed: true, reentered: true });
      expect(tracker.holds(MMSI, STALL.name)).toBe(false);
    });

    test('korsar Stallbackabron mellan två fixar (164 m söder → 171 m norr): utåt längs axeln, inte avståndet', () => {
      tracker.reserve(at(STALL, -164, { sog: 10, cog: 37 }), STALL.name);
      step(65000, STALL, at(STALL, 171, { sog: 10, cog: 37 }));
      expect(proof(tracker, MMSI, STALL)).toBe(now);
      expect(step(6 * 60 * MIN, STALL, at(STALL, 148, { sog: 10, cog: 213 })).reentered).toBe(true);
    });

    test('S/V REBEL-klassen vid Kanalinfarten: 29 → 263 → 378 m sydväst i 4,5–3 kn, åter norrut efter 5 h', () => {
      tracker.reserve(at(KANAL, 241, { sog: 5.8, cog: 212, _routeDirection: 'south' }), KANAL.name);
      step(66000, KANAL, at(KANAL, -29, { sog: 5.8, cog: 211 }));
      step(90000, KANAL, at(KANAL, -263, { sog: 4.5, cog: 239 }));
      step(60000, KANAL, at(KANAL, -378, { sog: 3.0, cog: 243 }));
      expect(tracker.holds(MMSI, KANAL.name)).toBe(true);
      expect(step(5 * 60 * MIN, KANAL, at(KANAL, -250, { sog: 4, cog: 35, _routeDirection: 'north' })).reentered)
        .toBe(true);
      expect(tracker.holds(MMSI, KANAL.name)).toBe(false);
    });

    test('omstart mellan utfärden och återkomsten: utåtbeviset sparas i trigger_point_visits', () => {
      tracker.reserve(at(STALL, -150, { sog: 7, cog: 37 }), STALL.name);
      step(60000, STALL, at(STALL, 46, { sog: 7.0, cog: 31 }));
      expect(step(69000, STALL, at(STALL, 267, { sog: 7.6, cog: 16 })).changed).toBe(true);
      const restored = new TriggerPointVisitTracker({ now: () => now });
      expect(restored.loadSnapshot(JSON.parse(JSON.stringify(tracker.exportSnapshot())))).toBe(1);
      expect(restored.holds(MMSI, STALL.name)).toBe(true);
      expect(step(2 * 60 * MIN, STALL, at(STALL, 200, { sog: 7, cog: 210 }), restored).reentered).toBe(true);
    });

    test('en gammal sista utåtposition (åter dagen efter) räknas, och tystnaden mäts på fixklockan', () => {
      tracker.reserve(at(KANAL, 150, { sog: 6, cog: 212 }), KANAL.name);
      step(60000, KANAL, at(KANAL, -40, { sog: 6, cog: 212 }));
      step(60000, KANAL, at(KANAL, -260, { sog: 5, cog: 215 }));
      expect(step(26 * 60 * MIN, KANAL, at(KANAL, -200, { sog: 5, cog: 35 })).reentered).toBe(true);
    });

    test('ELFKUNGENs utåtpar 170 → 276 m (4,5/2,7 kn) ger beviset; nästa fix 60 s senare på 300 m stryker det', () => {
      now = Date.parse('2026-08-06T12:40:02Z');
      const elf = (lat, lon, sog, cog) => vessel({ lat, lon }, { sog, cog, mmsi: '265573130' });
      tracker.reserve(elf(58.27007, 12.27188, 6, 212.8), KANAL.name);
      step(60000, KANAL, elf(58.26864, 12.27024, 6, 212.3));
      step(90000, KANAL, elf(58.26667, 12.26793, 4.5, 223.7));
      step(60000, KANAL, elf(58.26611, 12.2663, 2.7, 279.1));
      expect(proof(tracker, '265573130', KANAL)).toBe(now);
      expect(step(60000, KANAL, elf(58.26623, 12.26549, 0.8, 280.7)).changed).toBe(true);
      expect(proof(tracker, '265573130', KANAL)).toBeNull();
    });

    test('gränsen: nästa fix 10 min efter utåtfixen släpper, 9 min 59 s gör det inte', () => {
      const run = (silenceMs) => {
        const t = new TriggerPointVisitTracker({ now: () => now });
        t.reserve(at(KANAL, 150, { sog: 6, cog: 212 }), KANAL.name);
        step(60000, KANAL, at(KANAL, -40, { sog: 6, cog: 212 }), t);
        step(60000, KANAL, at(KANAL, -260, { sog: 5, cog: 215 }), t);
        return step(silenceMs, KANAL, at(KANAL, -280, { sog: 4, cog: 35 }), t).reentered;
      };
      expect(run(10 * MIN - 1000)).toBe(false);
      expect(run(10 * MIN)).toBe(true);
    });
  });

  describe('motfall: besöket står kvar', () => {
    // Rådata, ELFKUNGEN 265573130 i 20260806-42h: notis söderut 12:40:21, ut
    // förbi punkten och in till kajen 297–305 m sydväst om Kanalinfarten, 21 h
    // förtöjd med fixar var 1–45:e minut, avgång norrut 10:03:58.
    test('ELFKUNGEN lägger till vid kajen strax utanför Kanalinfarten och ligger kvar i 21 h', () => {
      now = Date.parse('2026-08-06T12:40:02Z');
      const raw = (lat, lon, sog, cog) => vessel({ lat, lon }, { sog, cog, mmsi: '265573130' });
      const elf = (lat, lon, sog, cog) => ({ ...raw(lat, lon, sog, cog) });
      tracker.reserve(raw(58.27007, 12.27188, 6, 212.8), KANAL.name);
      const obs = (ms, lat, lon, sog, cog) => step(ms, KANAL, elf(lat, lon, sog, cog));
      obs(60000, 58.26864, 12.27024, 6, 212.3);
      obs(90000, 58.26667, 12.26793, 4.5, 223.7);
      obs(60000, 58.26611, 12.2663, 2.7, 279.1);
      // Utåtparet 170 → 276 m i 4,5/2,7 kn ger beviset (prövas i första
      // blocket), men hon hörs 60 s senare på 300 m och det stryks.
      obs(60000, 58.26623, 12.26549, 0.8, 280.7);
      expect(proof(tracker, '265573130', KANAL)).toBeNull();
      for (const gapMin of [1, 6, 9, 27, 45, 15, 33, 45, 12]) {
        obs(gapMin * MIN, 58.26624, 12.26544, 0, 275.4);
        expect(tracker.holds('265573130', KANAL.name)).toBe(true);
      }
      obs(9 * MIN, 58.2663, 12.26631, 2.1, 55.1);
      obs(85000, 58.2675, 12.26868, 6, 32.9);
      expect(tracker.holds('265573130', KANAL.name)).toBe(true);
    });

    test('lägger till direkt efter utåtparet och AIS är tyst i 12 min: hörd stilla på samma plats är ingen återkomst', () => {
      tracker.reserve(at(KANAL, 150, { sog: 5, cog: 212 }), KANAL.name);
      step(60000, KANAL, at(KANAL, -40, { sog: 4.5, cog: 212 }));
      step(60000, KANAL, at(KANAL, -260, { sog: 4.5, cog: 215 }));
      expect(step(12 * MIN, KANAL, at(KANAL, -290, { sog: 0, cog: 275 })).reentered).toBe(false);
      expect(proof(tracker, MMSI, KANAL)).toBeNull();
      for (let i = 0; i < 20; i++) step(3 * MIN, KANAL, at(KANAL, -290, { sog: 0, cog: 275 }));
      // Avgången inåt hör till samma besök (förtöjning är ingen utfärd).
      step(3 * MIN, KANAL, at(KANAL, -200, { sog: 3, cog: 35 }));
      expect(step(60000, KANAL, at(KANAL, -60, { sog: 5, cog: 35 })).reentered).toBe(false);
      expect(tracker.holds(MMSI, KANAL.name)).toBe(true);
    });

    test('vänder strax utanför och kommer tillbaka inom minuter medan hon hörs: inget nytt besök (besöksregeln)', () => {
      tracker.reserve(at(KANAL, 150, { sog: 5, cog: 212 }), KANAL.name);
      step(60000, KANAL, at(KANAL, -60, { sog: 5, cog: 212 }));
      step(60000, KANAL, at(KANAL, -230, { sog: 4, cog: 215 }));
      step(70000, KANAL, at(KANAL, -200, { sog: 3, cog: 35 }));
      // Tyst en halvtimme, sedan hörd igen inne i zonen: beviset är redan strukket.
      expect(step(30 * MIN, KANAL, at(KANAL, -100, { sog: 3, cog: 35 })).reentered).toBe(false);
      expect(tracker.holds(MMSI, KANAL.name)).toBe(true);
    });

    test('båt som guppar eller väntar vid ytterpunkten (0,3–1,5 kn, ±25 m) ger aldrig beviset', () => {
      for (const point of [KANAL, STALL]) {
        const t = new TriggerPointVisitTracker({ now: () => now });
        const outer = point === STALL ? 1 : -1;
        t.reserve(at(point, outer * 120, { sog: 0.5, cog: 0 }), point.name);
        let sign = 1;
        for (let i = 0; i < 40; i++) {
          sign = -sign;
          step(60000, point, at(point, outer * (120 + sign * 25), { sog: 0.3 + (i % 5) * 0.3, cog: (i * 73) % 360 }), t);
        }
        expect(proof(t, MMSI, point)).toBeNull();
        expect(step(60 * MIN, point, at(point, outer * 120, { sog: 0.4 }), t).reentered).toBe(false);
        expect(t.holds(MMSI, point.name)).toBe(true);
      }
    });

    test('en enda brusposition utåt i över 2 kn: stryks av nästa fix, och ett orimligt hopp räknas inte alls', () => {
      // (1) Väntar 120 m ut, en position 140 m längre ut med 2,5 kn, nästa fix tillbaka.
      tracker.reserve(at(KANAL, -120, { sog: 0.2 }), KANAL.name);
      step(60000, KANAL, at(KANAL, -260, { sog: 2.5, cog: 215 }));
      step(60000, KANAL, at(KANAL, -120, { sog: 0.2 }));
      expect(step(40 * MIN, KANAL, at(KANAL, -120, { sog: 0.2 })).reentered).toBe(false);
      // (2) Ett hopp på 200 m på 10 s (20 m/s) med rapporterade 2,5 kn följt av tystnad.
      const t = new TriggerPointVisitTracker({ now: () => now });
      t.reserve(at(KANAL, -100, { sog: 0.2 }), KANAL.name);
      step(10000, KANAL, at(KANAL, -300, { sog: 2.5, cog: 215 }), t);
      expect(proof(t, MMSI, KANAL)).toBeNull();
      expect(step(40 * MIN, KANAL, at(KANAL, -120, { sog: 0.2 }), t).reentered).toBe(false);
      expect(t.holds(MMSI, KANAL.name)).toBe(true);
    });

    test.each([
      ['Kanalinfarten norrut in i kanalen', KANAL, -150, [100, 260], 1],
      ['Stallbackabron söderut in i kanalen', STALL, 150, [-100, -260], -1],
    ])('%s (inre sidan) ger inget bevis; tyst och åter som förut', (_l, point, start, path, dir) => {
      tracker.reserve(at(point, start, { sog: 5, cog: dir > 0 ? 35 : 215 }), point.name);
      for (const m of path) step(60000, point, at(point, m, { sog: 5, cog: dir > 0 ? 35 : 215 }));
      expect(step(40 * MIN, point, at(point, path[1] - dir * 60, { sog: 5, cog: dir > 0 ? 215 : 35 })).reentered)
        .toBe(false);
      expect(tracker.holds(MMSI, point.name)).toBe(true);
    });

    test('utan fart i AIS-rapporten, eller med kursen inåt, ges inget bevis', () => {
      for (const extra of [{}, { sog: 4, cog: 30 }]) {
        const t = new TriggerPointVisitTracker({ now: () => now });
        t.reserve(at(KANAL, 150, { sog: 5, cog: 212 }), KANAL.name);
        step(60000, KANAL, at(KANAL, -40, { sog: 5, cog: 212 }), t);
        step(60000, KANAL, at(KANAL, -260, extra), t);
        expect(step(60 * MIN, KANAL, at(KANAL, -200, { sog: 4, cog: 35 }), t).reentered).toBe(false);
      }
    });

    test('andra broar än ytterpunkterna berörs inte (Klaffbron)', () => {
      tracker.reserve(at(KLAFF, -150, { sog: 6, cog: 40, _routeDirection: 'north' }), KLAFF.name);
      step(60000, KLAFF, at(KLAFF, 46, { sog: 6, cog: 40 }));
      step(60000, KLAFF, at(KLAFF, 267, { sog: 6, cog: 40 }));
      expect(step(3 * 60 * MIN, KLAFF, at(KLAFF, 200, { sog: 6, cog: 220 })).reentered).toBe(false);
      expect(tracker.holds(MMSI, KLAFF.name)).toBe(true);
    });

    test('ögonblicksbilder: äldre poster och skadade värden ger inget bevis', () => {
      tracker.reserve(at(STALL, -150, { sog: 7, cog: 37 }), STALL.name);
      step(60000, STALL, at(STALL, 46, { sog: 7.0, cog: 31 }));
      step(69000, STALL, at(STALL, 267, { sog: 7.6, cog: 16 }));
      const snap = tracker.exportSnapshot();
      const key = `${MMSI}:${STALL.name}`;
      for (const bad of [undefined, 'x', snap.entries[key].lastFixTs - 1000, -1]) {
        const copy = JSON.parse(JSON.stringify(snap));
        if (bad === undefined) delete copy.entries[key].outwardFixTs; else copy.entries[key].outwardFixTs = bad;
        const restored = new TriggerPointVisitTracker({ now: () => now });
        restored.loadSnapshot(copy);
        expect(proof(restored, MMSI, STALL)).toBeNull();
      }
    });
  });
});
