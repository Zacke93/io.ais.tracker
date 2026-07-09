'use strict';

/**
 * Regressionstester för fältprov 3 (21h-körningen 20260708-001857).
 *
 * AKIRA-fyndet: en kajliggare i kajzonen (58.2875, mellan Klaffbron och
 * Järnvägsbron) fick target=Klaffbron på sydlig avgångskurs (06:57, cog 184,
 * 1.1 kn), U-svängde norrut och korsade POSITIONSBEVISAT Stridsbergsbron
 * 07:30:09 (58.2893→58.2971) — men RC9-blocken läste den inlåsta
 * _routeDirection='south', så beyondTarget föll åt fel håll och varken
 * MISSED_TARGET_INFERRED, origin-vakten eller någon target-omvärdering kördes.
 * TARGET_PROTECTION (maneuver/gps-event) återaktiverades dessutom i samma
 * tick och höll Klaffbron. Resultat: "på väg mot Klaffbron, om 16 minuter"
 * i 5,5 min EFTER den bevisade Strids-passagen, tills Fix D:s COG-debounce
 * fick sitt andra sample 07:35:37.
 *
 * Fixen: RC9-platserna härleder korsningsriktningen ur positionsdeltat
 * (_evidencedCrossingDirection) och
 *   (1) motsatt belagd korsning ⇒ omedelbar bekräftad reversal
 *       (_confirmDirectionReversal = Fix D:s confirmed-gren, extraherad),
 *   (2) bortom-target med underkänd origin-vakt ⇒ _clearStaleTargetBeyond
 *       (targeten är inaktuell — rensa utan fantomtransition/notis).
 */

jest.mock('homey');

const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');

const logger = {
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

const liveServices = [];

function makeVDS() {
  const bridgeRegistry = new BridgeRegistry();
  const systemCoordinator = new SystemCoordinator(logger);
  const svc = new VesselDataService(logger, bridgeRegistry, systemCoordinator);
  svc.app = {
    gpsJumpGateService: null, passageLatchService: null, routeOrderValidator: null, debug: jest.fn(), log: jest.fn(), error: jest.fn(),
  };
  liveServices.push(svc);
  return svc;
}

beforeAll(() => {
  global.__TEST_MODE__ = true;
});

afterAll(() => {
  delete global.__TEST_MODE__;
});

afterEach(() => {
  while (liveServices.length > 0) {
    const svc = liveServices.pop();
    try {
      svc.clearAllTimers();
    } catch (_) { /* tomt */ }
  }
  jest.clearAllMocks();
});

describe('_evidencedCrossingDirection: korsningsriktning ur positionsdeltat', () => {
  test('bro mellan positionerna, lat ökar → north', () => {
    const svc = makeVDS();
    const dir = svc._evidencedCrossingDirection(
      { lat: 58.2971 }, { lat: 58.2893 }, { lat: 58.2935 },
    );
    expect(dir).toBe('north');
  });

  test('bro mellan positionerna, lat minskar → south', () => {
    const svc = makeVDS();
    const dir = svc._evidencedCrossingDirection(
      { lat: 58.2893 }, { lat: 58.2971 }, { lat: 58.2935 },
    );
    expect(dir).toBe('south');
  });

  test('bro INTE mellan positionerna → null (gate-bekräftelse ticks senare)', () => {
    const svc = makeVDS();
    const dir = svc._evidencedCrossingDirection(
      { lat: 58.2971 }, { lat: 58.2940 }, { lat: 58.2935 },
    );
    expect(dir).toBeNull();
  });

  test('icke-finita värden → null', () => {
    const svc = makeVDS();
    expect(svc._evidencedCrossingDirection({ lat: NaN }, { lat: 58.29 }, { lat: 58.2935 })).toBeNull();
    expect(svc._evidencedCrossingDirection({ lat: 58.29 }, null, { lat: 58.2935 })).toBeNull();
  });
});

describe('AKIRA-reversalen: belagd motsatt korsning slår COG-debouncen', () => {
  test('Strids-korsning norrut med _routeDirection=south → omedelbar reversal + journey-reset', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '257605080',
      lat: 58.2971, // norr om Stridsbergsbron (58.2935)
      lon: 12.2999,
      sog: 5,
      cog: 20.8,
      targetBridge: 'Klaffbron',
      passedBridges: [],
      _routeDirection: 'south', // inlåst från kajavgången söderut
      _firstSeenLat: 58.2875, // kajzonen — norr om Klaffbron
      passedAt: {},
    };
    const oldVessel = { ...vessel, lat: 58.2893, lon: 12.2894 }; // söder om Strids
    svc._hasPassedBridge = jest.fn((v, o, bridge) => bridge.name === 'Stridsbergsbron');
    // Protection som i produktionsloggen (gps-event+maneuver återaktiverad
    // i samma tick) — reversalen MÅSTE radera den, annars RESTORE:as Klaffbron.
    svc.targetBridgeProtection.set('257605080', {
      isActive: true, targetBridge: 'Klaffbron', reason: 'gps-event+maneuver', startTime: Date.now(),
    });
    const resetSpy = jest.fn();
    svc.on('vessel:journey-reset', resetSpy);

    svc._handleIntermediateBridgePassage(vessel, oldVessel);

    expect(vessel.targetBridge).toBeNull(); // spöktargeten rensad I SAMMA TICK
    expect(vessel._routeDirection).toBe('north'); // omlåst till belagd riktning
    expect(svc.targetBridgeProtection.has('257605080')).toBe(false);
    // RIKTNINGSRELATIV N1: Stridsbergsbron ligger BAKOM i nya riktningen
    // (nyss korsad norrut) — den BEHÅLLS och dess dedup-nyckel rensas INTE
    // (full rensning gav Jvb ×2-dubbelnotisen i 21h-replayen). Inga broar
    // framför ⇒ ingen journey-reset-emission alls.
    expect(vessel.passedBridges).toEqual(['Stridsbergsbron']);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('gate-bekräftad korsning (registerConfirmedIntermediatePassage) med motsatt bevis → samma reversal', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '257605081',
      lat: 58.2971,
      lon: 12.2999,
      sog: 5,
      cog: 20.8,
      targetBridge: 'Klaffbron',
      passedBridges: [],
      _routeDirection: 'south',
      _firstSeenLat: 58.2875,
      passedAt: {},
    };
    const oldVessel = { ...vessel, lat: 58.2893, lon: 12.2894 };

    svc.registerConfirmedIntermediatePassage(vessel, oldVessel, 'Stridsbergsbron', Date.now());

    expect(vessel.targetBridge).toBeNull();
    expect(vessel._routeDirection).toBe('north');
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('korsning i LÅST riktning påverkas inte (ingen reversal, RC9 som förut)', () => {
    const svc = makeVDS();
    // Norrgående med target=Klaffbron som korsar Järnvägsbron — klassiska
    // RC9-fallet (missad målbropassage) ska bete sig exakt som före fixen.
    const vessel = {
      mmsi: '265576700',
      lat: 58.2920,
      lon: 12.2925,
      sog: 5,
      cog: 25,
      targetBridge: 'Klaffbron',
      passedBridges: [],
      _routeDirection: 'north',
      _firstSeenLat: 58.2700, // söder om Klaffbron — origin-vakten godkänner
      passedAt: {},
    };
    const oldVessel = { ...vessel, lat: 58.2905, lon: 12.2910 };
    svc._hasPassedBridge = jest.fn((v, o, bridge) => bridge.name === 'Järnvägsbron');

    svc._handleIntermediateBridgePassage(vessel, oldVessel);

    expect(vessel.targetBridge).toBe('Stridsbergsbron'); // MISSED_TARGET_INFERRED-transition
    expect(vessel._routeDirection).toBe('north');
    expect(vessel._passageBackfills).toContain('Klaffbron'); // notis-backfillen begärd
  });
});

describe('_clearStaleTargetBeyond: bortom target i konsistent riktning utan inferrerbar passage', () => {
  test('norrgående kajstart norr om Klaffbron som korsar Strids → target rensas UTAN journey-reset', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '257605082',
      lat: 58.2971,
      lon: 12.2999,
      sog: 5,
      cog: 20.8,
      targetBridge: 'Klaffbron', // inaktuell (bakom henne) men riktningen stämmer
      passedBridges: [],
      _routeDirection: 'north',
      _firstSeenLat: 58.2875, // kajzonen — NORR om Klaffbron ⇒ origin-vakten underkänner
      passedAt: {},
    };
    const oldVessel = { ...vessel, lat: 58.2893, lon: 12.2894 };
    svc._hasPassedBridge = jest.fn((v, o, bridge) => bridge.name === 'Stridsbergsbron');
    svc.targetBridgeProtection.set('257605082', {
      isActive: true, targetBridge: 'Klaffbron', reason: 'maneuver', startTime: Date.now(),
    });
    const resetSpy = jest.fn();
    svc.on('vessel:journey-reset', resetSpy);

    svc._handleIntermediateBridgePassage(vessel, oldVessel);

    expect(vessel.targetBridge).toBeNull(); // ingen spöktext mot Klaffbron
    expect(svc.targetBridgeProtection.has('257605082')).toBe(false);
    // INGEN fantomtransition/notis: Klaffbron passerades aldrig
    expect(vessel._passageBackfills || []).not.toContain('Klaffbron');
    // Riktningen är konsistent — resan består (ingen N1-reset)
    expect(resetSpy).not.toHaveBeenCalled();
    expect(vessel.passedBridges).toContain('Stridsbergsbron');
    expect(vessel._routeDirection).toBe('north');
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('_confirmDirectionReversal: extraherad Fix D-confirmed-gren', () => {
  test('utför hela checklistan: target, lås, pending, protection, journey-reset', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '111111111',
      targetBridge: 'Stridsbergsbron',
      passedBridges: ['Olidebron', 'Klaffbron'],
      _routeDirection: 'north',
      _fixDPendingReversal: { dir: 'south', time: Date.now() },
      _finalTargetBridge: null,
      _finalTargetDirection: null,
    };
    svc.targetBridgeProtection.set('111111111', {
      isActive: true, targetBridge: 'Stridsbergsbron', reason: 'maneuver', startTime: Date.now(),
    });
    const resetSpy = jest.fn();
    svc.on('vessel:journey-reset', resetSpy);

    svc._confirmDirectionReversal(vessel, 'south', 'dist=800m > 500');

    expect(vessel.targetBridge).toBeNull();
    expect(vessel._routeDirection).toBe('south');
    expect(vessel._fixDPendingReversal).toBeNull();
    expect(svc.targetBridgeProtection.has('111111111')).toBe(false);
    expect(vessel.passedBridges).toEqual([]);
    expect(resetSpy).toHaveBeenCalledWith(expect.objectContaining({ direction: 'south' }));
  });

  test('riktningsrelativ reset: bro framför rensas (med dedup-begäran), bro bakom behålls', () => {
    const svc = makeVDS();
    // Norrgående ben passerade Jvb + Stallbacka; hon vänder söderut vid
    // lat 58.2950 (mellan Strids och Stallbacka). I nya riktningen (syd)
    // ligger Järnvägsbron FRAMFÖR (ska återpasseras → rensas + dedup-reset)
    // och Stallbackabron BAKOM (behålls — redan avfyrad, ingen ny passage).
    const vessel = {
      mmsi: '333333333',
      lat: 58.2950,
      targetBridge: 'Stridsbergsbron',
      passedBridges: ['Järnvägsbron', 'Stallbackabron'],
      _routeDirection: 'north',
    };
    const resetSpy = jest.fn();
    svc.on('vessel:journey-reset', resetSpy);

    svc._confirmDirectionReversal(vessel, 'south', 'target behind vessel');

    expect(vessel.passedBridges).toEqual(['Stallbackabron']);
    expect(resetSpy).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'south',
      bridges: ['Järnvägsbron'],
    }));
  });

  test('tom passedBridges → ingen journey-reset-emission (speglar original-grenen)', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '222222222', targetBridge: 'Klaffbron', passedBridges: [], _routeDirection: 'south',
    };
    const resetSpy = jest.fn();
    svc.on('vessel:journey-reset', resetSpy);

    svc._confirmDirectionReversal(vessel, 'north', 'target behind vessel');

    expect(vessel.targetBridge).toBeNull();
    expect(vessel._routeDirection).toBe('north');
    expect(resetSpy).not.toHaveBeenCalled();
  });
});
