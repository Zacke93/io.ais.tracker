'use strict';

jest.mock('homey');

const AISStreamClient = require('../lib/connection/AISStreamClient');
const GPSJumpGateService = require('../lib/services/GPSJumpGateService');
const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');
const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const VesselDataService = require('../lib/services/VesselDataService');
const AISBridgeApp = require('../app');

const makeLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });

/**
 * Regressionstester för helkodsgranskningen 2026-07-01 (fynd C1/C2, S-F1,
 * S-F4, S-F7, E-F1, E-F7, N1, BT-F6). Varje test låser en verifierad fix —
 * se docs/helkodsgranskning-2026-07-01.md för fyndens fullständiga analys.
 */

describe('C1: servergraceful close (kod 1000) måste ge reconnect', () => {
  test('_onClose(1000) schemalägger reconnect (annars permanent död feed)', () => {
    const client = new AISStreamClient(makeLogger());
    client._scheduleReconnect = jest.fn();

    client._onClose(1000, 'server going away');

    // Feed-watchdogen är gated på isConnected — utan denna reconnect finns
    // INGEN annan väg tillbaka efter en servergraceful close (deploy/omstart).
    expect(client._scheduleReconnect).toHaveBeenCalledTimes(1);
  });

  test('avsiktlig disconnect ger fortfarande INGEN reconnect', () => {
    const client = new AISStreamClient(makeLogger());
    client._scheduleReconnect = jest.fn();
    client._intentionalClose = true;

    client._onClose(1000, 'intentional');

    expect(client._scheduleReconnect).not.toHaveBeenCalled();
  });
});

describe('C2: disconnect() under backoff (ws=null) läcker inte avsiktsflaggan', () => {
  test('_intentionalClose är false efter disconnect utan socket', () => {
    const client = new AISStreamClient(makeLogger());
    client.ws = null; // mitt i backoff — ingen aktiv socket

    client.disconnect();

    // Gamla koden nollställde flaggan bara inne i if (this.ws)-blocket →
    // nästa misslyckade handshake efter nyckelbyte konsumerades som
    // "avsiktlig" → ingen reconnect någonsin.
    expect(client._intentionalClose).toBe(false);
  });
});

describe('S-F1: GPS-gatens tvåstegsbekräftelse använder sog (inte vessel.speed)', () => {
  test('stabil kandidat BEKRÄFTAS efter confirmationPeriod', () => {
    const gate = new GPSJumpGateService(makeLogger());
    const vessel = {
      lat: 58.284, lon: 12.285, cog: 20, sog: 4.0,
    };
    gate.registerCandidatePassage('265000001', 'Klaffbron', { passed: true }, vessel);

    // Spola förbi bekräftelseperioden
    const candidates = gate._candidatePassages.get('265000001');
    candidates[0].timestamp -= gate._confirmationPeriod + 1000;

    const confirmed = gate.confirmStableCandidates('265000001', {
      lat: 58.2841, lon: 12.2851, cog: 22, sog: 4.2,
    });

    // Gamla koden lagrade vessel.speed (=undefined) → NaN i jämförelsen →
    // isStable ALLTID false → bekräftelsen kunde aldrig lyckas och gate:ade
    // passager övergavs tyst (fryst bridge_text + missad notis).
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].bridgeName).toBe('Klaffbron');
  });

  test('saknad sog fäller inte bekräftelsen (NaN-säkert)', () => {
    const gate = new GPSJumpGateService(makeLogger());
    const vessel = {
      lat: 58.284, lon: 12.285, cog: 20, sog: undefined,
    };
    gate.registerCandidatePassage('265000002', 'Klaffbron', { passed: true }, vessel);
    gate._candidatePassages.get('265000002')[0].timestamp -= gate._confirmationPeriod + 1000;

    const confirmed = gate.confirmStableCandidates('265000002', {
      lat: 58.2841, lon: 12.2851, cog: 22, sog: undefined,
    });

    expect(confirmed).toHaveLength(1);
  });
});

describe('S-F4: mellanstora GPS-hopp med orimlig fart flaggas', () => {
  test('250m-hopp hos stillaliggande båt → accept_with_caution', () => {
    const analyzer = new GPSJumpAnalyzer(makeLogger());
    const oldVessel = { timestamp: Date.now() - 60000, sog: 0.1, cog: 10 };
    const result = analyzer.analyzeMovement(
      '265000003',
      { lat: 58.2865, lon: 12.285 }, // ~250m norr
      { lat: 58.2843, lon: 12.285 },
      { sog: 0.2, cog: 12 },
      oldVessel,
    );
    // 250 m på 60 s med sog ~0,2 kn är fysiskt orimligt (multipath-outlier)
    // — accepterades tidigare BLINT → falsk linjekorsningspassage över bron.
    expect(result.action).toBe('accept_with_caution');
  });

  test('normalt Class B-gap klarar gatan (3 min @ 5 kn ≈ 460 m)', () => {
    const analyzer = new GPSJumpAnalyzer(makeLogger());
    const oldVessel = { timestamp: Date.now() - 180000, sog: 5.0, cog: 20 };
    const result = analyzer.analyzeMovement(
      '265000004',
      { lat: 58.2884, lon: 12.285 },
      { lat: 58.2843, lon: 12.285 },
      { sog: 5.0, cog: 20 },
      oldVessel,
    );
    expect(result.action).toBe('accept');
  });
});

describe('S-F7: förtöjd-klassningen släpper inte på ett brusprov', () => {
  function makeVDS() {
    const svc = Object.create(VesselDataService.prototype);
    svc.logger = makeLogger();
    return svc;
  }

  test('ETT sog-jitterprov (0.4kn) avklassar INTE en förtöjd båt', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265000005',
      lat: 58.28604,
      lon: 12.28571,
      sog: 0.4, // gråzonen STATIONARY(0.3)..MOVEMENT_PROOF(0.5)
      navStatus: null,
      _moored: true,
      _stationarySince: Date.now() - 20 * 60 * 1000,
      _mooredReleasePending: 0,
      _hasMovementProof: true,
      _firstSeenLat: 58.28604,
      _firstSeenLon: 12.28571,
    };

    svc._updateMooringEvidence(vessel);

    expect(vessel._moored).toBe(true); // hysteres: ett prov räcker inte
    expect(vessel._stationarySince).not.toBeNull(); // backstop-klockan intakt
  });

  test('TVÅ konsekutiva gråzonsprov släpper klassningen', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265000006',
      lat: 58.28604,
      lon: 12.28571,
      sog: 0.4,
      navStatus: null,
      _moored: true,
      _stationarySince: Date.now() - 20 * 60 * 1000,
      _mooredReleasePending: 0,
      _hasMovementProof: true,
      _firstSeenLat: 58.28604,
      _firstSeenLon: 12.28571,
    };
    svc._updateMooringEvidence(vessel);
    svc._updateMooringEvidence(vessel);

    expect(vessel._moored).toBe(false);
  });

  test('sog=null (okänd) behåller klassningen orörd', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265000007',
      lat: 58.28604,
      lon: 12.28571,
      sog: null,
      navStatus: 5,
      _moored: true,
      _stationarySince: Date.now() - 10 * 60 * 1000,
      _hasMovementProof: true,
      _firstSeenLat: 58.28604,
      _firstSeenLon: 12.28571,
    };
    const stationaryBefore = vessel._stationarySince;

    svc._updateMooringEvidence(vessel);

    expect(vessel._moored).toBe(true);
    expect(vessel._stationarySince).toBe(stationaryBefore);
  });

  test('navStatus-flap (5→0) hos stillaliggande båt släpper INTE klassningen', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265000008',
      lat: 58.28604,
      lon: 12.28571,
      sog: 0.1, // fortsatt still
      navStatus: 0, // flappade från 5
      _moored: true,
      _stationarySince: Date.now() - 10 * 60 * 1000,
      _mooredReleasePending: 0,
      _hasMovementProof: true,
      _firstSeenLat: 58.28604,
      _firstSeenLon: 12.28571,
    };

    svc._updateMooringEvidence(vessel);

    expect(vessel._moored).toBe(true); // ligger kvar vid kajen = förtöjd
  });

  test('äkta avgång (sog ≥ 0.5) släpper direkt', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265000009',
      lat: 58.28604,
      lon: 12.28571,
      sog: 2.5,
      navStatus: null,
      _moored: true,
      _stationarySince: Date.now() - 10 * 60 * 1000,
      _mooredReleasePending: 0,
      _hasMovementProof: true,
      _firstSeenLat: 58.28604,
      _firstSeenLon: 12.28571,
    };

    svc._updateMooringEvidence(vessel);

    expect(vessel._moored).toBe(false);
  });
});

describe('S-F5: GPS-flaggade prover förgiftar inte rörelsebeviset', () => {
  test('nettoförflyttning under _positionUncertain ger INGET bevis', () => {
    const svc = Object.create(VesselDataService.prototype);
    svc.logger = makeLogger();
    const vessel = {
      mmsi: '265000010',
      lat: 58.2870, // ~150m från firstSeen
      lon: 12.2857,
      sog: 0.1,
      navStatus: null,
      _positionUncertain: true, // outlier-flaggat prov
      _hasMovementProof: false,
      _movementProofPending: false,
      _firstSeenLat: 58.28560,
      _firstSeenLon: 12.28570,
    };

    svc._updateMooringEvidence(vessel);

    expect(vessel._hasMovementProof).toBe(false);
  });

  test('äkta nettoförflyttning kräver TVÅ konsekutiva prover', () => {
    const svc = Object.create(VesselDataService.prototype);
    svc.logger = makeLogger();
    const vessel = {
      mmsi: '265000011',
      lat: 58.2870,
      lon: 12.2857,
      sog: 0.1,
      navStatus: null,
      _positionUncertain: false,
      _hasMovementProof: false,
      _movementProofPending: false,
      _firstSeenLat: 58.28560,
      _firstSeenLon: 12.28570,
    };

    svc._updateMooringEvidence(vessel);
    expect(vessel._hasMovementProof).toBe(false); // första provet: pending

    svc._updateMooringEvidence(vessel);
    expect(vessel._hasMovementProof).toBe(true); // andra provet: bevis
  });
});

describe('E-F1: ETA-gap-reset tömmer även hastighetsbufferten', () => {
  test('förgapsfarter medlas inte in i första post-gap-ETA:n', () => {
    const calc = new ProgressiveETACalculator(makeLogger(), { getBridgeByName: () => null });
    const mmsi = '265000012';
    // Varm buffert med höga farter + gammal historik (>3 min)
    calc._speedBuffers.set(mmsi, [5.0, 5.0, 5.0]);
    calc._speedBufferSampleKeys = new Map([[mmsi, 'gammal']]);
    calc._etaHistory.set(mmsi, [{ timestamp: Date.now() - 10 * 60 * 1000, processedETA: 8, rawETA: 8 }]);

    // Kör skyddskedjan — gap-resetten ska tömma BÅDE historik och buffert
    calc._processETAWithProtection({
      mmsi, sog: 0.2, lat: 58.28, lon: 12.28,
    }, 12, {});

    expect(calc._speedBuffers.has(mmsi)).toBe(false);
    expect((calc._etaHistory.get(mmsi) || []).length).toBeLessThanOrEqual(1);
  });
});

describe('N1: bekräftad U-sväng mitt i resan emittar journey-reset', () => {
  test('Fix D-bekräftelse nollar passedBridges och emittar vessel:journey-reset (PRODUKTIONSVÄGEN)', () => {
    // Helgranskning 2026-07-06 (t-korningar#1): tidigare emittade testet
    // eventet SJÄLVT (låste bara formen). Nu drivs HELA Fix D-flödet genom
    // updateVessel: äkta måltilldelning + riktningslås, två konsekutiva
    // syd-observationer (Anomali 18-debouncen), bekräftelse → reset + emit.
    global.__TEST_MODE__ = true;
    try {
      const BridgeRegistry = require('../lib/models/BridgeRegistry');
      const SystemCoordinator = require('../lib/services/SystemCoordinator');
      const { BRIDGES } = require('../lib/constants');
      const svc = new VesselDataService(makeLogger(), new BridgeRegistry(), new SystemCoordinator(makeLogger()));
      svc.app = {
        gpsJumpGateService: null,
        passageLatchService: null,
        routeOrderValidator: null,
        debug: jest.fn(),
        log: jest.fn(),
        error: jest.fn(),
      };
      const events = [];
      svc.on('vessel:journey-reset', (e) => events.push(e));
      const MMSI = '265000013';
      const KLAFF = BRIDGES.klaffbron;

      // 1. Etablerad nordgående resa: äkta måltilldelning låser riktningen.
      svc.updateVessel(MMSI, {
        lat: KLAFF.lat - 0.0054, lon: KLAFF.lon, sog: 4.2, cog: 25, name: 'N1-TEST',
      });
      const v1 = svc.vessels.get(MMSI);
      expect(v1.targetBridge).toBe('Klaffbron');
      expect(v1._routeDirection).toBe('north');
      // Aktiv resa: en bro redan passerad (sätts på det LEVANDE objektet;
      // passedBridges bärs av fältlistan över kommande meddelanden).
      v1.passedBridges = ['Olidebron'];

      // 2. Första syd-observationen (target >500 m framför ⇒ shouldRecalc
      //    via dist-triggern) — debouncen armeras, INGEN reset än.
      svc.updateVessel(MMSI, {
        lat: KLAFF.lat - 0.0056, lon: KLAFF.lon, sog: 4.2, cog: 190, name: 'N1-TEST',
      });
      expect(events).toHaveLength(0);

      // 3. Andra konsekutiva syd-observationen — bekräftad U-sväng.
      svc.updateVessel(MMSI, {
        lat: KLAFF.lat - 0.0058, lon: KLAFF.lon, sog: 4.2, cog: 192, name: 'N1-TEST',
      });

      expect(events).toHaveLength(1);
      expect(events[0].mmsi).toBe(MMSI);
      expect(events[0].direction).toBe('south');
      expect(events[0].vessel).toBeTruthy();
      const after = svc.vessels.get(MMSI);
      expect(after.passedBridges).toEqual([]);
      expect(after._routeDirection).toBe('south');
      svc.clearAllTimers();
    } finally {
      delete global.__TEST_MODE__;
    }
  });

  test('app-lagret rensar dedup-nycklar (session+persistent) vid journey-reset', () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app._triggeredBoatNearKeys = new Set(['265000014:Klaffbron', '265000014:any', '999:Klaffbron']);
    app._persistentRecentTriggers = new Map([
      ['265000014:Klaffbron', Date.now()],
      ['999:Klaffbron', Date.now()],
    ]);
    app._persistRecentTriggers = jest.fn();

    app._clearBoatNearTriggers({ mmsi: '265000014' }, true);

    expect(app._triggeredBoatNearKeys.has('265000014:Klaffbron')).toBe(false);
    expect(app._triggeredBoatNearKeys.has('265000014:any')).toBe(false);
    expect(app._persistentRecentTriggers.has('265000014:Klaffbron')).toBe(false);
    expect(app._triggeredBoatNearKeys.has('999:Klaffbron')).toBe(true); // andra fartyg orörda
    expect(app._persistentRecentTriggers.has('999:Klaffbron')).toBe(true);
  });
});

describe('BT-F6: räkneords-regexen matchar Åtta', () => {
  test('"Åtta båtar" räknas som 8', () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    // Gamla \b-gränsen misslyckades före "Å" (icke-\w) → åtta räknades aldrig.
    expect(app._extractVesselCounts('Åtta båtar på väg mot Klaffbron, beräknad broöppning strax').totalMentioned).toBe(8);
  });
});
