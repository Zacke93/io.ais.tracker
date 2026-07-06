'use strict';

const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES, BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

const DEFAULT = BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE;

const makeLogger = () => ({
  debug: jest.fn(),
  error: jest.fn(),
  log: jest.fn(),
});

const makeService = (vesselDataService = null) => {
  const registry = new BridgeRegistry(BRIDGES);
  return new BridgeTextService(registry, makeLogger(), null, vesselDataService, null);
};

const mkVessel = (overrides = {}) => ({
  mmsi: '111111111',
  name: 'TEST',
  targetBridge: 'Klaffbron',
  etaMinutes: 5,
  cog: 20,
  ...overrides,
});

describe('BridgeTextService — Variant-1 format contract', () => {
  describe('Empty / invalid input', () => {
    test('null input → default', () => {
      expect(makeService().generateBridgeText(null)).toBe(DEFAULT);
    });

    test('undefined input → default', () => {
      expect(makeService().generateBridgeText(undefined)).toBe(DEFAULT);
    });

    test('empty array → default', () => {
      expect(makeService().generateBridgeText([])).toBe(DEFAULT);
    });

    test('non-array input → default', () => {
      expect(makeService().generateBridgeText('not an array')).toBe(DEFAULT);
    });

    test('vessel without mmsi → default', () => {
      const v = mkVessel({ mmsi: null });
      expect(makeService().generateBridgeText([v])).toBe(DEFAULT);
    });

    test('vessel without targetBridge → default', () => {
      const v = mkVessel({ targetBridge: null });
      expect(makeService().generateBridgeText([v])).toBe(DEFAULT);
    });

    test('vessel with intermediate bridge as target → filtered → default', () => {
      const cases = ['Olidebron', 'Järnvägsbron', 'Stallbackabron', 'Kanalinfarten'];
      for (const bridge of cases) {
        const v = mkVessel({ targetBridge: bridge });
        expect(makeService().generateBridgeText([v])).toBe(DEFAULT);
      }
    });

    test('GPS-hold vessel is filtered → default', () => {
      const vds = { hasGpsJumpHold: (mmsi) => mmsi === '111111111' };
      const v = mkVessel();
      expect(makeService(vds).generateBridgeText([v])).toBe(DEFAULT);
    });
  });

  describe('Single vessel — ETA clause', () => {
    test('ETA = 5 min → "om 5 minuter"', () => {
      const v = mkVessel({ etaMinutes: 5 });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter',
      );
    });

    // Fix 6: strax-tröskeln höjdes från <1 min till <3 min så Class B AIS
    // (30s intervall) hinner fånga zonen för i princip alla båtar. Tester
    // för 1-2 min uppdaterade till "strax".
    test('ETA = 1 min → "strax" (Fix 6: <3 min ger strax)', () => {
      const v = mkVessel({ etaMinutes: 1 });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, beräknad broöppning strax',
      );
    });

    test('ETA = 1.4 min → "strax"', () => {
      const v = mkVessel({ etaMinutes: 1.4 });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, beräknad broöppning strax',
      );
    });

    test('ETA = 1.5 min → "strax"', () => {
      const v = mkVessel({ etaMinutes: 1.5 });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, beräknad broöppning strax',
      );
    });

    test('ETA = 2.99 min → "strax" (just under threshold)', () => {
      const v = mkVessel({ etaMinutes: 2.99 });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, beräknad broöppning strax',
      );
    });

    test('ETA = 3 min → "om 3 minuter" (boundary, no longer strax)', () => {
      const v = mkVessel({ etaMinutes: 3 });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, beräknad broöppning om 3 minuter',
      );
    });

    test('ETA = 0.5 min → "strax"', () => {
      const v = mkVessel({ etaMinutes: 0.5 });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, beräknad broöppning strax',
      );
    });

    test('ETA = 0.99 min → "strax"', () => {
      const v = mkVessel({ etaMinutes: 0.99 });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, beräknad broöppning strax',
      );
    });

    // Invalid / out-of-range ETA values → "ETA okänd" (honest failure signal).
    // This should never trigger in normal operation; if it does, it indicates
    // a bug in the ETA pipeline. Previously these rendered as "strax", which
    // falsely promised an imminent bridge opening.
    test('ETA = null → "ETA okänd"', () => {
      const v = mkVessel({ etaMinutes: null });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, ETA okänd',
      );
    });

    test('ETA = undefined → "ETA okänd"', () => {
      const v = mkVessel({ etaMinutes: undefined });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, ETA okänd',
      );
    });

    test('ETA = NaN → "ETA okänd"', () => {
      const v = mkVessel({ etaMinutes: NaN });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, ETA okänd',
      );
    });

    test('ETA = 0 → "ETA okänd" (not > 0, treated as invalid)', () => {
      const v = mkVessel({ etaMinutes: 0 });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, ETA okänd',
      );
    });

    test('ETA = -5 → "ETA okänd"', () => {
      const v = mkVessel({ etaMinutes: -5 });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, ETA okänd',
      );
    });

    test('ETA = Infinity → "ETA okänd"', () => {
      const v = mkVessel({ etaMinutes: Infinity });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, ETA okänd',
      );
    });

    test('ETA = 30 min → "om 30 minuter"', () => {
      const v = mkVessel({ etaMinutes: 30 });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, beräknad broöppning om 30 minuter',
      );
    });

    test('ETA = 59 min → "om 59 minuter" (no upper cap)', () => {
      // Post-fix ETA pipeline is trustworthy — show large values verbatim
      // rather than clamping to a phrase that implies the vessel is at the bridge.
      const v = mkVessel({ etaMinutes: 59 });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, beräknad broöppning om 59 minuter',
      );
    });

    test('ETA = 120 min → "om 120 minuter" (no upper cap)', () => {
      const v = mkVessel({ etaMinutes: 120 });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, beräknad broöppning om 120 minuter',
      );
    });
  });

  describe('Single vessel — target bridge', () => {
    test('Klaffbron target produces Klaffbron phrase', () => {
      const v = mkVessel({ targetBridge: 'Klaffbron', etaMinutes: 7 });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Klaffbron, beräknad broöppning om 7 minuter',
      );
    });

    test('Stridsbergsbron target produces Stridsbergsbron phrase', () => {
      const v = mkVessel({ targetBridge: 'Stridsbergsbron', etaMinutes: 12 });
      expect(makeService().generateBridgeText([v])).toBe(
        'En båt på väg mot Stridsbergsbron, beräknad broöppning om 12 minuter',
      );
    });
  });

  describe('Multi-vessel — single target', () => {
    test('2 vessels toward Klaffbron — uses closest ETA', () => {
      const vessels = [
        mkVessel({ mmsi: '111', etaMinutes: 8 }),
        mkVessel({ mmsi: '222', etaMinutes: 3 }),
      ];
      expect(makeService().generateBridgeText(vessels)).toBe(
        'Två båtar på väg mot Klaffbron, beräknad broöppning om 3 minuter',
      );
    });

    test('3 vessels toward Klaffbron — count word "Tre"', () => {
      const vessels = [
        mkVessel({ mmsi: '111', etaMinutes: 10 }),
        mkVessel({ mmsi: '222', etaMinutes: 5 }),
        mkVessel({ mmsi: '333', etaMinutes: 2 }),
      ];
      // Lead vessel ETA=2 → < 3 min → "strax" (Fix 6)
      expect(makeService().generateBridgeText(vessels)).toBe(
        'Tre båtar på väg mot Klaffbron, beräknad broöppning strax',
      );
    });

    test('10 vessels toward Klaffbron — count word "Tio"', () => {
      const vessels = Array.from({ length: 10 }, (_, i) => mkVessel({
        mmsi: `${100 + i}`,
        etaMinutes: 10 - i,
      }));
      // Lead is i=9 → ETA=1 → < 3 min → "strax" (Fix 6)
      expect(makeService().generateBridgeText(vessels)).toBe(
        'Tio båtar på väg mot Klaffbron, beräknad broöppning strax',
      );
    });

    test('11 vessels — numeric fallback from CountTextHelper', () => {
      const vessels = Array.from({ length: 11 }, (_, i) => mkVessel({
        mmsi: `${100 + i}`,
        etaMinutes: 11 - i,
      }));
      // Lead is i=10 → ETA=1 → < 3 min → "strax" (Fix 6)
      expect(makeService().generateBridgeText(vessels)).toBe(
        '11 båtar på väg mot Klaffbron, beräknad broöppning strax',
      );
    });

    test('group ETA falls back to distanceToCurrent when no valid ETA', () => {
      const vessels = [
        mkVessel({ mmsi: '111', etaMinutes: null, distanceToCurrent: 500 }),
        mkVessel({ mmsi: '222', etaMinutes: null, distanceToCurrent: 200 }),
      ];
      // Both have ETA=null → lead selection falls back to distance ordering,
      // but the lead's etaMinutes is still null → "ETA okänd" clause.
      // In normal operation vessels with null ETA should not be in the relevant
      // set; this test guards the grammatical output for the edge case.
      expect(makeService().generateBridgeText(vessels)).toBe(
        'Två båtar på väg mot Klaffbron, ETA okänd',
      );
    });
  });

  describe('Multi-target — semicolon separator', () => {
    test('Klaffbron + Stridsbergsbron yields two phrases joined by "; "', () => {
      const vessels = [
        mkVessel({ mmsi: '111', targetBridge: 'Klaffbron', etaMinutes: 3 }),
        mkVessel({ mmsi: '222', targetBridge: 'Stridsbergsbron', etaMinutes: 8 }),
      ];
      expect(makeService().generateBridgeText(vessels)).toBe(
        'En båt på väg mot Klaffbron, beräknad broöppning om 3 minuter; '
        + 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter',
      );
    });

    test('Klaffbron phrase precedes Stridsbergsbron even when input is reversed', () => {
      const vessels = [
        mkVessel({ mmsi: '222', targetBridge: 'Stridsbergsbron', etaMinutes: 8 }),
        mkVessel({ mmsi: '111', targetBridge: 'Klaffbron', etaMinutes: 3 }),
      ];
      const text = makeService().generateBridgeText(vessels);
      expect(text.indexOf('Klaffbron')).toBeLessThan(text.indexOf('Stridsbergsbron'));
    });

    test('multi-vessel in both groups', () => {
      const vessels = [
        mkVessel({ mmsi: '111', targetBridge: 'Klaffbron', etaMinutes: 5 }),
        mkVessel({ mmsi: '222', targetBridge: 'Klaffbron', etaMinutes: 3 }),
        mkVessel({ mmsi: '333', targetBridge: 'Stridsbergsbron', etaMinutes: 10 }),
      ];
      expect(makeService().generateBridgeText(vessels)).toBe(
        'Två båtar på väg mot Klaffbron, beräknad broöppning om 3 minuter; '
        + 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 10 minuter',
      );
    });

    test('only Stridsbergsbron group present — no leading semicolon', () => {
      const v = mkVessel({ targetBridge: 'Stridsbergsbron', etaMinutes: 4 });
      const text = makeService().generateBridgeText([v]);
      expect(text).toBe('En båt på väg mot Stridsbergsbron, beräknad broöppning om 4 minuter');
      expect(text).not.toContain(';');
    });
  });

  describe('Input order stability', () => {
    test('Reversing vessel order yields identical text', () => {
      const vessels = [
        mkVessel({ mmsi: '111', targetBridge: 'Klaffbron', etaMinutes: 5 }),
        mkVessel({ mmsi: '222', targetBridge: 'Stridsbergsbron', etaMinutes: 8 }),
      ];
      const svc = makeService();
      const original = svc.generateBridgeText(vessels);
      const reversed = svc.generateBridgeText([...vessels].reverse());
      expect(original).toBe(reversed);
    });
  });
});

describe('BridgeTextService — API compatibility', () => {
  test('Constructor accepts full 5-arg signature', () => {
    const registry = new BridgeRegistry(BRIDGES);
    const svc = new BridgeTextService(registry, makeLogger(), {}, {}, {});
    expect(svc).toBeDefined();
  });

  test('Constructor with minimal 2-arg signature works', () => {
    const registry = new BridgeRegistry(BRIDGES);
    const svc = new BridgeTextService(registry, makeLogger());
    expect(svc.generateBridgeText([])).toBe(DEFAULT);
  });

  test('clearVesselPhaseTracking is a no-op (does not throw)', () => {
    const svc = makeService();
    expect(() => svc.clearVesselPhaseTracking('111')).not.toThrow();
    expect(() => svc.clearVesselPhaseTracking(null)).not.toThrow();
    expect(() => svc.clearVesselPhaseTracking(undefined)).not.toThrow();
  });

  test('resetPhaseTracking is a no-op (does not throw)', () => {
    const svc = makeService();
    expect(() => svc.resetPhaseTracking()).not.toThrow();
  });

  test('getCountText delegates to CountTextHelper', () => {
    const svc = makeService();
    expect(svc.getCountText(1)).toBe('En');
    expect(svc.getCountText(2)).toBe('Två');
    expect(svc.getCountText(10)).toBe('Tio');
    expect(svc.getCountText(11)).toBe('11');
  });
});

describe('BridgeTextService — Invariants', () => {
  const intermediateBridges = ['Olidebron', 'Järnvägsbron', 'Stallbackabron', 'Kanalinfarten'];
  const legacyPhrases = [
    'inväntar broöppning',
    'Broöppning pågår',
    'precis passerat',
    'åker strax',
    'passerar strax',
    'm från',
  ];

  const scenarios = [
    [{ mmsi: '111', targetBridge: 'Klaffbron', etaMinutes: 5 }],
    [{ mmsi: '111', targetBridge: 'Stridsbergsbron', etaMinutes: 1 }],
    [{ mmsi: '111', targetBridge: 'Klaffbron', etaMinutes: 0.3 }],
    // etaMinutes:null scenario removed — now renders "ETA okänd" which is
    // covered by dedicated tests above. Invariants below (no "ETA " uppercase,
    // must contain "beräknad broöppning") only hold for valid-ETA scenarios.
    [
      { mmsi: '111', targetBridge: 'Klaffbron', etaMinutes: 3 },
      { mmsi: '222', targetBridge: 'Stridsbergsbron', etaMinutes: 10 },
    ],
  ];

  test('Output never mentions intermediate bridges', () => {
    for (const vessels of scenarios) {
      const text = makeService().generateBridgeText(vessels);
      for (const bridge of intermediateBridges) {
        expect(text).not.toContain(bridge);
      }
    }
  });

  test('Output never contains legacy phase phrases', () => {
    for (const vessels of scenarios) {
      const text = makeService().generateBridgeText(vessels);
      for (const phrase of legacyPhrases) {
        expect(text).not.toContain(phrase);
      }
    }
  });

  test('Output never contains uppercase "ETA " — utom legitima "ETA okänd"', () => {
    // Helgranskning 2026-07-06 (t-bridge-text#4): "ETA okänd" är en LEGITIM
    // klausul (formatETABroOpeningClause vid ogiltig ETA) — den gamla
    // blanka förbudsregeln var fel som invariant även om scenarierna aldrig
    // råkade producera frasen. Förbjuds: alla ANDRA "ETA "-förekomster
    // (versal-ETA hörde till legacy-textmodellen).
    for (const vessels of scenarios) {
      const text = makeService().generateBridgeText(vessels);
      expect(text.replace(/ETA okänd/g, '')).not.toContain('ETA ');
    }
  });

  test('Non-default output always contains "på väg mot " och en ETA-klausul', () => {
    // Helgranskning 2026-07-06 (t-bridge-text#4): "beräknad broöppning" är
    // inte den enda legitima klausulen — "ETA okänd" är kontraktsenlig vid
    // ogiltig ETA. Invarianterna speglar nu formatETABroOpeningClause.
    for (const vessels of scenarios) {
      const text = makeService().generateBridgeText(vessels);
      if (text !== DEFAULT) {
        expect(text).toContain('på väg mot ');
        expect(/beräknad broöppning|ETA okänd/.test(text)).toBe(true);
      }
    }
  });

  test('Multi-target output always contains exactly one "; "', () => {
    const vessels = [
      mkVessel({ mmsi: '111', targetBridge: 'Klaffbron', etaMinutes: 3 }),
      mkVessel({ mmsi: '222', targetBridge: 'Stridsbergsbron', etaMinutes: 10 }),
    ];
    const text = makeService().generateBridgeText(vessels);
    const matches = text.match(/; /g) || [];
    expect(matches.length).toBe(1);
  });

  test('Single-target output never contains "; "', () => {
    const vessels = [mkVessel({ etaMinutes: 5 })];
    const text = makeService().generateBridgeText(vessels);
    expect(text).not.toContain(';');
  });
});
