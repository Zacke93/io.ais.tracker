'use strict';

/**
 * U53 (2026-11-23): brotextens kö vid en MELLANBRO upp till 800 m, med
 * textstillheten i VesselDataService och hysteresen 1,5 kn / 850 m.
 * Enhetsprov för gränserna; hela förloppen prövas i de syntetiska scenarierna
 * (runSyntheticScenarios.js, "U53").
 */

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const {
  BRIDGES, MOORING_ZONES, INTERMEDIATE_TEXT_QUEUE,
} = require('../lib/constants');
const { intermediateTextQueue, waitingBridgeForText, waitingBridge } = require('../lib/utils/bridgeQueue');
const geometry = require('../lib/utils/geometry');

const NOW = Date.parse('2026-11-23T20:40:00Z');

// En punkt `meters` från `from` på linjen mot `toward` (kanalens riktning).
function along(from, toward, meters) {
  const d = geometry.calculateDistance(from.lat, from.lon, toward.lat, toward.lon);
  const f = meters / d;
  return { lat: from.lat + (toward.lat - from.lat) * f, lon: from.lon + (toward.lon - from.lon) * f };
}
const southOfJvb = (m) => along(BRIDGES.jarnvagsbron, BRIDGES.klaffbron, m);

function vesselAt(pos, extra = {}) {
  return {
    mmsi: '905399001',
    ...pos,
    sog: 0.8,
    timestamp: NOW,
    lastPositionUpdate: NOW,
    fixTs: NOW,
    targetBridge: 'Stridsbergsbron',
    _routeDirection: 'north',
    passedBridges: ['Olidebron', 'Klaffbron'],
    _bridgeQueueApproaches: {
      Järnvägsbron: {
        bridge: 'Järnvägsbron', direction: 'north', confirmedAt: NOW - 600000, textWaitConfirmedAt: NOW - 60000,
      },
    },
    ...extra,
  };
}

describe('U53: intermediateTextQueue', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => NOW);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('bekräftad textstillhet 600 m före Järnvägsbron ger kö vid Järnvägsbron i texten', () => {
    const v = vesselAt(southOfJvb(600));
    expect(intermediateTextQueue(v)).toBe('Järnvägsbron');
    expect(waitingBridgeForText(v)).toBe('Järnvägsbron');
    // Köbeviset för status, notiser och öppningstjänst är oförändrat (350 m).
    expect(waitingBridge(v)).toBeNull();
  });

  test('utan textstillhet, utan bekräftad anflygning eller i fel riktning: ingen kö', () => {
    expect(intermediateTextQueue(vesselAt(southOfJvb(600), {
      _bridgeQueueApproaches: { Järnvägsbron: { direction: 'north', confirmedAt: NOW, textWaitConfirmedAt: null } },
    }))).toBeNull();
    expect(intermediateTextQueue(vesselAt(southOfJvb(600), {
      _bridgeQueueApproaches: { Järnvägsbron: { direction: 'north', confirmedAt: null, textWaitConfirmedAt: NOW } },
    }))).toBeNull();
    expect(intermediateTextQueue(vesselAt(southOfJvb(600), {
      _bridgeQueueApproaches: { Järnvägsbron: { direction: 'south', confirmedAt: NOW, textWaitConfirmedAt: NOW } },
    }))).toBeNull();
  });

  test('aldrig målbron: kö före Klaffbron med Klaffbron som mål ger ingen textkö', () => {
    const v = vesselAt(along(BRIDGES.klaffbron, BRIDGES.olidebron, 600), {
      targetBridge: 'Klaffbron',
      passedBridges: ['Olidebron'],
      _bridgeQueueApproaches: {
        Klaffbron: {
          direction: 'north', confirmedAt: NOW - 600000, textWaitConfirmedAt: NOW - 60000,
        },
      },
    });
    expect(intermediateTextQueue(v)).toBeNull();
  });

  test('söderut: Järnvägsbron bortom målbron Stridsbergsbron är ingen mellanbro', () => {
    const v = vesselAt(along(BRIDGES.stridsbergsbron, BRIDGES.stallbackabron, 450), {
      _routeDirection: 'south',
      passedBridges: ['Stallbackabron'],
      _bridgeQueueApproaches: {
        Järnvägsbron: {
          direction: 'south', confirmedAt: NOW - 600000, textWaitConfirmedAt: NOW - 60000,
        },
      },
    });
    expect(intermediateTextQueue(v)).toBeNull();
  });

  test('hysteresen: bekräftad kö står kvar upp till 1,5 kn och 850 m', () => {
    expect(intermediateTextQueue(vesselAt(southOfJvb(600), { sog: 1.4 }))).toBe('Järnvägsbron');
    expect(intermediateTextQueue(vesselAt(southOfJvb(600), { sog: 1.6 }))).toBeNull();
    expect(intermediateTextQueue(vesselAt(southOfJvb(830)))).toBe('Järnvägsbron');
    expect(intermediateTextQueue(vesselAt(southOfJvb(870)))).toBeNull();
    expect(INTERMEDIATE_TEXT_QUEUE.MAX_DISTANCE_M).toBe(800);
  });

  test('gammal position, förtöjd eller i en kajzon (Gästhamnen): ingen kö', () => {
    expect(intermediateTextQueue(vesselAt(southOfJvb(600), {
      timestamp: NOW - 11 * 60000, lastPositionUpdate: NOW - 11 * 60000, fixTs: NOW - 11 * 60000,
    }))).toBeNull();
    expect(intermediateTextQueue(vesselAt(southOfJvb(600), { _moored: true }))).toBeNull();
    const zone = MOORING_ZONES.find((z) => z.name.startsWith('Gästhamnen'));
    const inZone = { lat: (zone.start.lat + zone.end.lat) / 2, lon: (zone.start.lon + zone.end.lon) / 2 };
    expect(geometry.calculateDistance(inZone.lat, inZone.lon, BRIDGES.jarnvagsbron.lat, BRIDGES.jarnvagsbron.lon))
      .toBeLessThan(800);
    expect(intermediateTextQueue(vesselAt(inZone))).toBeNull();
  });

  test('brons öppningsfönster släpper textkön', () => {
    const v = vesselAt(southOfJvb(600), {
      _bridgeOpeningBridgeName: 'Järnvägsbron', _bridgeOpeningUntil: NOW + 60000,
    });
    expect(intermediateTextQueue(v)).toBeNull();
  });
});

describe('U53: textstillheten (VesselDataService._noteIntermediateTextWait)', () => {
  let service;
  beforeEach(() => {
    global.__TEST_MODE__ = true;
    jest.spyOn(Date, 'now').mockImplementation(() => NOW);
    const logger = {
      debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(),
    };
    service = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  });
  afterEach(() => {
    service.clearAllTimers();
    jest.restoreAllMocks();
    delete global.__TEST_MODE__;
  });

  // Kör en följd fixar [avstånd, sog] med 65 s mellanrum genom regeln.
  function run(steps, entry) {
    let old = null;
    const out = [];
    steps.forEach(([m, sog], i) => {
      const pos = southOfJvb(m);
      const v = {
        ...pos, sog, fixTs: NOW + i * 65000, timestamp: NOW + i * 65000,
      };
      if (old) {
        const moved = geometry.calculateDistance(old.lat, old.lon, v.lat, v.lon);
        const distance = geometry.calculateDistance(v.lat, v.lon, BRIDGES.jarnvagsbron.lat, BRIDGES.jarnvagsbron.lon);
        service._noteIntermediateTextWait(v, old, entry, distance, moved);
      }
      out.push(!!entry.textWaitConfirmedAt);
      old = v;
    });
    return out;
  }

  test('kryp 0,8 kn från 600 m bekräftas efter 60 s utan kravet sog ≤ 0,5', () => {
    const entry = { confirmedAt: NOW - 600000 };
    expect(run([[600, 0.8], [580, 0.8], [560, 0.9], [540, 0.7]], entry)).toEqual([false, false, true, true]);
  });

  test('över 1 kn bekräftas inte; en bekräftad väntan hålls till 1,5 kn och släpps över', () => {
    expect(run([[600, 1.2], [560, 1.2], [520, 1.2]], { confirmedAt: NOW })).toEqual([false, false, false]);
    const entry = { confirmedAt: NOW };
    expect(run([[600, 0.8], [580, 0.8], [560, 0.7], [520, 1.4], [490, 0.8], [440, 1.6]], entry))
      .toEqual([false, false, true, true, true, false]);
  });

  test('avståndet: bekräftas inom 800 m, hålls till 850 m, släpps utanför', () => {
    const entry = { confirmedAt: NOW };
    expect(run([[820, 0.5], [795, 0.5], [790, 0.5], [830, 0.6], [845, 0.4], [870, 0.4]], entry))
      .toEqual([false, false, true, true, true, false]);
  });

  test('utan bekräftad anflygning blir det ingen textstillhet', () => {
    expect(run([[600, 0.5], [590, 0.5], [580, 0.5]], { confirmedAt: null })).toEqual([false, false, false]);
  });
});

// Granskningen av U53, M1: en punkt `offM` meter vinkelrätt från mitten av
// kajzonen "Kajen norr om Klaffbron" (radie 30 m), österut mot farleden.
function offKajen(offM) {
  const zone = MOORING_ZONES.find((z) => z.name.startsWith('Kajen'));
  const mid = { lat: (zone.start.lat + zone.end.lat) / 2, lon: (zone.start.lon + zone.end.lon) / 2 };
  const dLat = zone.end.lat - zone.start.lat;
  const dLon = (zone.end.lon - zone.start.lon) * Math.cos((mid.lat * Math.PI) / 180);
  const len = Math.hypot(dLat, dLon);
  // Normalen (öster om segmentet), i meter omräknat till grader.
  const nLat = -dLon / len; const nLon = dLat / len;
  return {
    lat: mid.lat + (nLat * offM) / 111320,
    lon: mid.lon + (nLon * offM) / (111320 * Math.cos((mid.lat * Math.PI) / 180)),
  };
}

describe('U53: kajzonens kantmarginal för en bekräftad textväntan (granskningens M1)', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => NOW);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('bekräftad väntan står kvar 25 m från Kajens mittlinje (inom radien, utanför marginalen)', () => {
    const edge = offKajen(25);
    const zone = MOORING_ZONES.find((z) => z.name.startsWith('Kajen'));
    expect(geometry.distancePointToSegmentM(edge.lat, edge.lon, zone.start.lat, zone.start.lon, zone.end.lat, zone.end.lon))
      .toBeLessThan(zone.radiusM);
    expect(intermediateTextQueue(vesselAt(edge))).toBe('Järnvägsbron');
  });

  test('djupt inne i zonen, eller obekräftad vid kanten: ingen textkö', () => {
    expect(intermediateTextQueue(vesselAt(offKajen(8)))).toBeNull();
    expect(intermediateTextQueue(vesselAt(offKajen(25), {
      _bridgeQueueApproaches: {
        Järnvägsbron: { direction: 'north', confirmedAt: NOW - 600000, textWaitConfirmedAt: null },
      },
    }))).toBeNull();
  });
});

// Granskningen av U53, L4: U30:s köundantag läser också textens mellanbrokö.
// En båt som ligger still i textkö 560 m före Järnvägsbron (756 m från målbron,
// alltså utanför U30:s 350 m) går inte in i "ETA okänd"; utan textkön gör hon det.
describe('U53: U30 går inte in för en båt i textens mellanbrokö', () => {
  const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
  let now;
  beforeEach(() => {
    now = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function stillStates(withTextQueue) {
    const calc = new ProgressiveETACalculator(
      { debug: jest.fn(), log: jest.fn(), error: jest.fn() },
      new BridgeRegistry(),
    );
    const pos = southOfJvb(560);
    const states = [];
    for (let m = 0; m <= 7; m++) {
      now = NOW + m * 60000;
      const v = vesselAt(pos, {
        sog: 0.1,
        status: 'approaching',
        _stationarySince: NOW,
        timestamp: now,
        lastPositionUpdate: now,
        fixTs: now,
        fixFeed: 'aisstream',
        _bridgeQueueApproaches: {
          Järnvägsbron: {
            bridge: 'Järnvägsbron',
            direction: 'north',
            confirmedAt: NOW - 600000,
            textWaitConfirmedAt: withTextQueue ? NOW - 60000 : null,
          },
        },
      });
      calc._updateStillUnknown(v, 10);
      states.push(calc.isStillUnknown(v.mmsi));
    }
    return states;
  }

  test('i textkö: inget "ETA okänd" efter sju minuters stillhet', () => {
    expect(stillStates(true).some(Boolean)).toBe(false);
  });

  test('motfallet utan textkö: läget går in efter fem minuter', () => {
    expect(stillStates(false)[7]).toBe(true);
  });
});
