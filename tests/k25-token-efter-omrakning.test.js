'use strict';

/**
 * K25 (fältprov 10, 2026-08-19 — röda etappen 2026-08-22):
 * NOTIS-TOKENEN BAR FÖRRA POLLCYKELNS ETA.
 *
 * StatusService.analyzeVesselStatus emittar 'status:changed' INIFRÅN sig själv.
 * app.js _onVesselStatusChanged körde då sin boat_near-notis synkront — alltså
 * FÖRE anroparen hunnit både skriva vessel.status (STEG 7) och räkna om ETA:n
 * för det nya fixet. Tokenen läste därför vessel.etaMinutes från föregående
 * tick.
 *
 * FÄLTBEVIS (NAVEN 231920000, 2026-08-19T15:54:28, huvudloggen):
 *   .827  STATUS_CHANGE approaching → waiting
 *   .828  Safe tokens … "eta_minutes":4     ← beräknat 70 s / 339 m tidigare
 *   .835  ETA_RAW 1.8min → EMA-smooth 3.0min ← DETTA fix, 7 ms EFTER tokenen
 *   verklig passage 2,24 min senare ⇒ tokenen låg ~79 % för högt.
 * 6 av dygnets 10 målbronotiser bar samma fördröjning.
 *
 * FIXEN: notisen köas när emitten kommer inifrån meddelandevägens analys och
 * avfyras av _flushDeferredStatusBoatNear direkt efter ETA-blocket.
 *
 * FACIT: notismultiseten är nycklad på (mmsi, bro) resp. (mmsi, bro, riktning)
 * — eta_minutes ingår inte (tests/replay-validation/runAllCorpora.js), och
 * varken antalet notiser eller dedup-nycklarna påverkas. Testerna nedan låser
 * BÅDA sakerna: rätt ETA i tokenen OCH exakt en notis per anrop.
 */

jest.mock('homey');

const EventEmitter = require('events');
const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES } = require('../lib/constants');

const REAL_DATE_NOW = Date.now;
const T0 = 1_700_000_000_000;

/** NAVEN:s verkliga geometri: 200 m söder om Klaffbron, 3,9 kn, kurs 12°. */
const southOf = (bridge, meters) => ({
  lat: bridge.lat - meters / 111320,
  lon: bridge.lon,
});

describe('K25 — notis-tokenens ETA byggs EFTER omräkningen för samma fix', () => {
  let now;
  let app;
  let seenEtaAtTrigger;

  const advance = (ms) => {
    now += ms;
  };

  const makeApp = () => {
    const a = new AISBridgeApp();
    a.log = jest.fn();
    a.debug = jest.fn();
    a.error = jest.fn();
    a.bridgeRegistry = new BridgeRegistry();
    a._etaSettlingMmsi = null;
    a._deferredStatusBoatNear = [];
    // Fält som onInit normalt sätter (testerna kör inte onInit). UI-vägen
    // stubbas: STEG 4 i _onVesselStatusChanged är oförändrad av K25 och skulle
    // annars lämna en 150 ms-timer efter sig.
    a._triggeredBoatNearKeys = new Set();
    a._persistentRecentTriggers = new Map();
    a._updateUI = jest.fn();
    // Fånga vilken ETA notisvägen SÅG när den kallades — det är hela fyndet.
    seenEtaAtTrigger = [];
    a._triggerBoatNearFlow = jest.fn(async (v) => {
      seenEtaAtTrigger.push(v.etaMinutes);
    });
    return a;
  };

  const makeVessel = (overrides = {}) => {
    const pos = southOf(BRIDGES.klaffbron, 200);
    return {
      mmsi: '231920000',
      name: 'NAVEN',
      lat: pos.lat,
      lon: pos.lon,
      sog: 3.9,
      cog: 12,
      status: 'approaching',
      targetBridge: 'Klaffbron',
      etaMinutes: 3.8, // FÖRRA tickets värde (339 m / 70 s tidigare)
      _etaPublishedValue: 3.8,
      _etaPublishTarget: 'Klaffbron',
      timestamp: now,
      lastPositionUpdate: now,
      _hasMovementProof: true,
      ...overrides,
    };
  };

  beforeEach(() => {
    now = T0;
    Date.now = () => now;
    global.__TEST_MODE__ = true;
    app = makeApp();
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  // ---------------------------------------------------------------------
  // 1. KÖ-MEKANIKEN ISOLERAD
  // ---------------------------------------------------------------------
  describe('kö och flush', () => {
    test('emit under ETA-omräkningen ⇒ notisen köas, inte avfyras', async () => {
      const vessel = makeVessel();
      app._etaSettlingMmsi = '231920000';

      const pending = app._onVesselStatusChanged({
        vessel, oldStatus: 'approaching', newStatus: 'waiting', reason: 'vessel_waiting_at_bridge',
      });

      await Promise.resolve(); // låt handlern köra fram till sin await
      expect(app._triggerBoatNearFlow).not.toHaveBeenCalled();
      expect(app._deferredStatusBoatNear).toHaveLength(1);

      // ETA-blocket skriver det färska värdet, precis som app.js gör
      vessel.etaMinutes = 3.0;
      app._etaSettlingMmsi = null;
      app._flushDeferredStatusBoatNear();
      await pending;

      expect(app._triggerBoatNearFlow).toHaveBeenCalledTimes(1);
      expect(seenEtaAtTrigger).toEqual([3.0]); // FÄRSKT, inte 3.8
      expect(app._deferredStatusBoatNear).toHaveLength(0);
    });

    test('MUTATIONSPROV: utan markören avfyras notisen direkt med FÖRRA tickets ETA', async () => {
      const vessel = makeVessel();
      app._etaSettlingMmsi = null; // ← beteendet FÖRE K25-fixen

      await app._onVesselStatusChanged({
        vessel, oldStatus: 'approaching', newStatus: 'waiting', reason: 'vessel_waiting_at_bridge',
      });

      expect(app._triggerBoatNearFlow).toHaveBeenCalledTimes(1);
      expect(seenEtaAtTrigger).toEqual([3.8]); // det gamla, för höga värdet
    });

    test('snapshot-vägen (annan/ingen markör) kör OFÖRÄNDRAT direkt', async () => {
      const vessel = makeVessel();
      app._etaSettlingMmsi = '999999999'; // ett ANNAT fartyg settlar

      await app._onVesselStatusChanged({
        vessel, oldStatus: 'approaching', newStatus: 'stallbacka-waiting', reason: 'x',
      });

      expect(app._triggerBoatNearFlow).toHaveBeenCalledTimes(1);
      expect(app._deferredStatusBoatNear).toHaveLength(0);
    });

    test('endast waiting-/stallbacka-waiting-övergångar berörs (STEG 1:s villkor orört)', async () => {
      const vessel = makeVessel();
      app._etaSettlingMmsi = '231920000';

      await app._onVesselStatusChanged({
        vessel, oldStatus: 'waiting', newStatus: 'en-route', reason: 'passed',
      });

      expect(app._triggerBoatNearFlow).not.toHaveBeenCalled();
      expect(app._deferredStatusBoatNear).toHaveLength(0); // inget köades heller
    });

    test('flush utan kö är en no-op (och kraschar inte på oinitierat fält)', () => {
      app._deferredStatusBoatNear = undefined;
      expect(() => app._flushDeferredStatusBoatNear()).not.toThrow();
      expect(app._triggerBoatNearFlow).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // 2. HELA MEDDELANDEVÄGEN — NAVEN-SEKVENSEN
  // ---------------------------------------------------------------------
  describe('integration: _analyzeVesselPosition', () => {
    /**
     * Bygg en app med precis de beroenden _analyzeVesselPosition rör, och en
     * statusService som (som den riktiga) emittar 'status:changed' INIFRÅN
     * analyzeVesselStatus — det är den ordningen hela fyndet handlar om.
     */
    const wireApp = (freshEta) => {
      const statusService = new EventEmitter();
      statusService.analyzeVesselStatus = jest.fn((vessel) => {
        statusService.emit('status:changed', {
          vessel,
          oldStatus: 'approaching',
          newStatus: 'waiting',
          reason: 'vessel_waiting_at_bridge',
          stabilized: false,
        });
        return {
          status: 'waiting', isWaiting: true, isApproaching: false, statusChanged: true,
        };
      });
      statusService.calculateETA = jest.fn(() => freshEta);
      app.statusService = statusService;
      app.statusService.on('status:changed', (e) => app._onVesselStatusChanged(e)
        .catch((err) => app.error('[STATUS_CHANGED]', err)));

      app.proximityService = {
        analyzeVesselProximity: () => ({
          nearestBridge: { id: 'klaffbron', name: 'Klaffbron' },
          nearestDistance: 200,
          bridgeDistances: {},
        }),
        calculateProximityTimeout: () => 60000,
      };
      app.vesselDataService = {
        scheduleCleanup: jest.fn(),
        setGpsJumpHold: jest.fn(),
        _handleTargetBridgeTransition: jest.fn(),
      };
      app.passageLatchService = { handleGPSJump: jest.fn() };
      app.routeOrderValidator = { clearVesselHistory: jest.fn() };
      app.gpsJumpGateService = { confirmStableCandidates: jest.fn(() => []), clearGate: jest.fn() };
      app._observeBridgeOpening = jest.fn();
      app._updateUI = jest.fn();
    };

    test('NAVEN: tokenvägen ser 3,0 min (fixets ETA) — inte 3,8 från förra ticket', async () => {
      wireApp(1.8); // rå 1,8 → _reconcilePublishedETA släpper igenom under 3 min
      const vessel = makeVessel();

      await app._analyzeVesselPosition(vessel);

      expect(app.statusService.calculateETA).toHaveBeenCalledTimes(1);
      expect(app._triggerBoatNearFlow).toHaveBeenCalledTimes(1);
      // Notisen såg EXAKT det värde brotexten kommer att visa.
      expect(seenEtaAtTrigger[0]).toBe(vessel.etaMinutes);
      expect(seenEtaAtTrigger[0]).not.toBe(3.8);
      expect(vessel.status).toBe('waiting'); // STEG 7 hann före notisen
    });

    test('notisen avfyras EN gång och FÖRE cleanup-schemaläggningen (ordningen bevarad)', async () => {
      wireApp(1.8);
      const order = [];
      app._triggerBoatNearFlow = jest.fn(async () => {
        order.push('notis');
      });
      app.vesselDataService.scheduleCleanup = jest.fn(() => {
        order.push('cleanup');
      });

      await app._analyzeVesselPosition(makeVessel());

      expect(order).toEqual(['notis', 'cleanup']);
    });

    test('markören nollställs efter analysen (nästa emit köar inte av misstag)', async () => {
      wireApp(1.8);
      await app._analyzeVesselPosition(makeVessel());
      expect(app._etaSettlingMmsi).toBeNull();
      expect(app._deferredStatusBoatNear).toHaveLength(0);
    });

    test('kastar analysen EFTER emitten går notisen ändå ut (inget hängande löfte)', async () => {
      wireApp(1.8);
      // Låt STEG 7-vägen spränga direkt efter emitten.
      app.statusService.calculateETA = jest.fn(() => {
        throw new Error('sprängd');
      });

      await app._analyzeVesselPosition(makeVessel());

      expect(app._triggerBoatNearFlow).toHaveBeenCalledTimes(1); // finally-grenen
      expect(app._deferredStatusBoatNear).toHaveLength(0);
      expect(app._etaSettlingMmsi).toBeNull();
      expect(app.error).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // 3. TOKENVÄRDET
  // ---------------------------------------------------------------------
  describe('tokenens eta_minutes', () => {
    let fired;
    beforeEach(() => {
      app._triggeredBoatNearKeys = new Set();
      app._persistentRecentTriggers = new Map();
      fired = [];
      app._triggerBoatNearFlowBest = jest.fn((tokens) => {
        fired.push(tokens); return Promise.resolve();
      });
    });

    test('source=target: tokenen speglar vessel.etaMinutes för DET AKTUELLA fixet', async () => {
      // NAVEN efter fixen: etaMinutes = 3,0 ⇒ token 3 (förr 4 från 3,8).
      const vessel = makeVessel({ etaMinutes: 3.0, _routeDirection: 'north' });
      await app._triggerBoatNearFlowForBridge(vessel, {
        name: 'Klaffbron', id: 'klaffbron', distance: 200, source: 'target',
      });

      expect(fired).toHaveLength(1);
      expect(fired[0].eta_minutes).toBe(3);
      expect(fired[0].eta_available).toBe(true);
      expect(fired[0].bridge_name).toBe('Klaffbron'); // facitbärande fält orört
      expect(fired[0].direction).toBe('norrut'); // facitbärande fält orört
    });

    test('kontrast: samma notis med förra tickets 3,8 hade gett 4', async () => {
      const vessel = makeVessel({ etaMinutes: 3.8, _routeDirection: 'north' });
      await app._triggerBoatNearFlowForBridge(vessel, {
        name: 'Klaffbron', id: 'klaffbron', distance: 200, source: 'target',
      });

      expect(fired[0].eta_minutes).toBe(4);
      // Samma bro och riktning ⇒ facitnyckeln är identisk oavsett ETA.
      expect(fired[0].bridge_name).toBe('Klaffbron');
      expect(fired[0].direction).toBe('norrut');
    });
  });
});
