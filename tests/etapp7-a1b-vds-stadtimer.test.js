'use strict';

/**
 * Etapp 7, A1b (F-21) — VesselDataService städtimer.
 *
 * BAKGRUND: konstruktorn nollar `_cleanupValidationTimer` i testläge
 * (`NODE_ENV==='test' || global.__TEST_MODE__`), och den timern är ENDA
 * produktionsanroparen av `_validateCleanupIntegrity()` — som äger
 * `_completedJourneys`-TTL:n (15 min), `_passageDetectionCache`-purgen och
 * `_logDebounce`/`_logRepeatCount`-purgen. Replay-harnessen initierar appen
 * under `__TEST_MODE__` ⇒ timern skapas aldrig där heller. Fält (42 h): 500
 * [CLEANUP_VALIDATION] + 12 [COMPLETED_JOURNEY_CLEANUP]; samma replay: 0 + 0.
 *
 * Denna svit låser A1b:s EXTRAKTION (grön, noll beteendediff):
 *   1. setInterval-grenen anropar den extraherade metoden — kadens EXAKT 10 min.
 *   2. `_runCleanupValidation()` är en ren genomsläppning (ordningskontrakt).
 *   3. Metoden är anropbar i testläge trots att timern är null, och åldrar då
 *      alla tre kartorna — det är den ingång harnessen SKA kunna driva.
 *   4. Svälj-fällan: ett kastande internt steg måste synas som logger.error,
 *      och får inte fälla anroparen (timer-/tick-säkerhet).
 */

const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const VesselDataService = require('../lib/services/VesselDataService');

const TEN_MIN_MS = 10 * 60 * 1000;

const makeLogger = () => ({
  log: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
});

const makeService = (logger) => new VesselDataService(
  logger,
  new BridgeRegistry(),
  new SystemCoordinator(logger),
);

describe('A1b: VesselDataService städtimer — extraktionen', () => {
  let savedEnv;
  let service;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-08T12:00:00.000Z'));
    savedEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (service && service._cleanupValidationTimer) {
      clearInterval(service._cleanupValidationTimer);
      service._cleanupValidationTimer = null;
    }
    service = null;
    process.env.NODE_ENV = savedEnv;
    global.__TEST_MODE__ = undefined;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('produktionsläge: intervallet anropar _runCleanupValidation på EXAKT 10 min', () => {
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = undefined;

    const spy = jest.spyOn(VesselDataService.prototype, '_runCleanupValidation');
    const logger = makeLogger();
    service = makeService(logger);

    expect(service._cleanupValidationTimer).toBeTruthy();

    // Kadensen är ett kontrakt: en millisekund före ska INGET ha hänt.
    jest.advanceTimersByTime(TEN_MIN_MS - 1);
    expect(spy).toHaveBeenCalledTimes(0);

    jest.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);

    // ...och den fortsätter i samma takt (setInterval, inte setTimeout).
    jest.advanceTimersByTime(2 * TEN_MIN_MS);
    expect(spy).toHaveBeenCalledTimes(3);

    // Timerkroppen anropar metoden utan argument (ren extraktion).
    expect(spy.mock.calls.every((args) => args.length === 0)).toBe(true);
  });

  test('produktionsläge: kedjan timer → _runCleanupValidation → _validateCleanupIntegrity är intakt', () => {
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = undefined;

    const inner = jest.spyOn(VesselDataService.prototype, '_validateCleanupIntegrity');
    const logger = makeLogger();
    service = makeService(logger);

    jest.advanceTimersByTime(TEN_MIN_MS);
    expect(inner).toHaveBeenCalledTimes(1);
    // Svälj-fällan: den normala vägen får inte logga fel.
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('ordningskontrakt: _runCleanupValidation är en REN genomsläppning (ett anrop, inga argument)', () => {
    const logger = makeLogger();
    service = makeService(logger); // NODE_ENV==='test' under jest ⇒ ingen timer
    const inner = jest.spyOn(service, '_validateCleanupIntegrity').mockImplementation(() => {});

    service._runCleanupValidation();

    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0]).toHaveLength(0);
    expect(service._runCleanupValidation()).toBeUndefined(); // ingen returkontrakt
    expect(inner).toHaveBeenCalledTimes(2);
  });

  test('F-21: testläge lämnar timern null — men den extraherade metoden är driv-bar', () => {
    const logger = makeLogger();
    service = makeService(logger);

    // Hålet som A1b dokumenterar: ingen timer ⇒ ingen produktionsanropare.
    expect(service._cleanupValidationTimer).toBeNull();
    expect(typeof service._runCleanupValidation).toBe('function');

    const now = Date.now();
    // Utgångna poster (över respektive TTL) + färska som MÅSTE överleva.
    service._completedJourneys.set('265001001', { completedAt: now - 16 * 60 * 1000, direction: 'north' });
    service._completedJourneys.set('265001002', { completedAt: now - 5 * 60 * 1000, direction: 'south' });
    service._passageDetectionCache.set('265001001:Klaffbron', { timestamp: now - 61 * 1000, result: true });
    service._passageDetectionCache.set('265001002:Klaffbron', { timestamp: now - 10 * 1000, result: true });
    service._logDebounce.set('gammal-nyckel', now - 11 * 60 * 1000);
    service._logRepeatCount.set('gammal-nyckel', 7);
    service._logDebounce.set('färsk-nyckel', now - 60 * 1000);

    service._runCleanupValidation();

    expect(service._completedJourneys.has('265001001')).toBe(false);
    expect(service._completedJourneys.has('265001002')).toBe(true);
    expect(service._passageDetectionCache.has('265001001:Klaffbron')).toBe(false);
    expect(service._passageDetectionCache.has('265001002:Klaffbron')).toBe(true);
    expect(service._logDebounce.has('gammal-nyckel')).toBe(false);
    expect(service._logRepeatCount.has('gammal-nyckel')).toBe(false);
    expect(service._logDebounce.has('färsk-nyckel')).toBe(true);
    expect(service._memoryLeakStats.lastCleanupValidation).toBe(now);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('svälj-fällan: kastande internt steg loggas som fel och fäller inte anroparen', () => {
    const logger = makeLogger();
    service = makeService(logger);

    // Föräldralös cleanup-timer utan fartyg ⇒ [MEMORY_LEAK_DETECTED] +
    // _performOrphanedResourceCleanup(), som vi låter kasta.
    const orphan = setTimeout(() => {}, 60 * 1000);
    service.cleanupTimers.set('265001003', orphan);
    jest.spyOn(service, '_performOrphanedResourceCleanup').mockImplementation(() => {
      throw new Error('simulerat städfel');
    });

    expect(() => service._runCleanupValidation()).not.toThrow();

    const errors = logger.error.mock.calls.map((args) => String(args[0]));
    expect(errors.some((line) => line.includes('MEMORY_LEAK_DETECTED'))).toBe(true);
    expect(errors.some((line) => line.includes('VALIDATION_ERROR'))).toBe(true);

    clearTimeout(orphan);
  });
});
