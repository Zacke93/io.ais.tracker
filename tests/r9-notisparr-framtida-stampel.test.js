'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { AIS_CONFIG } = require('../lib/constants');

/**
 * Omgång 9, spår R (felinjektion i sparat tillstånd och klocka): den sparade
 * notisspärren (persistent_recent_triggers) med en stämpel i framtiden. Det
 * uppstår när klockan gick fel framåt när notisen skickades och sedan rättades,
 * eller när inställningen är skadad. Före rättningen laddades posten (negativ
 * ålder är "färsk"), minutstädningen tog aldrig bort den, och båt+bro var
 * spärrad tills stämpeln passerats. En post utan riktning spärrade båda hållen.
 * Besöksminnet och öppningsdedupen avvisade redan framtida stämplar.
 * Rättningen: en stämpel mer än SEEN_MAX_FUTURE_SKEW_MS fram sätts till "nu",
 * så spärren gäller som för en notis skickad nyss.
 */
const HOUR = 60 * 60 * 1000;
const SKEW = AIS_CONFIG.AISHUB.SEEN_MAX_FUTURE_SKEW_MS;
const KEY = '265099201:Klaffbron';

describe('Notisspärren med framtida stämplar', () => {
  let store;
  const now = Date.parse('2026-11-26T12:00:00Z');

  function makeApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app.homey = {
      settings: {
        get: (k) => (k in store ? store[k] : null),
        set: (k, v) => {
          store[k] = JSON.parse(JSON.stringify(v));
        },
        on: jest.fn(),
      },
    };
    app._persistentRecentTriggers = new Map();
    app._triggeredBoatNearKeys = new Set();
    app._PERSISTENT_DEDUP_WINDOW_MS = 2 * HOUR;
    app._PERSISTENT_DEDUP_RETENTION_MS = 6 * HOUR;
    app.vesselDataService = { getAllVessels: () => [] };
    return app;
  }

  // Båten passerar norrut med rörelsebevis (riktningen spelar in i spärren).
  const vessel = {
    mmsi: '265099201', sog: 5, cog: 25, _routeDirection: 'north',
  };

  beforeEach(() => {
    store = {};
    jest.useFakeTimers({ now });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('laddning: en stämpel ett år fram sätts till nu och spärren går ut efter 2 h', () => {
    store.persistent_recent_triggers = { [KEY]: { t: now + 365 * 24 * HOUR, dir: 'north' } };
    const app = makeApp();
    app._loadPersistentTriggers();
    expect(app._persistentRecentTriggers.get(KEY)).toEqual({ t: now, dir: 'north' });
    // Granskningen L2: klampningen skrivs tillbaka, så en omstart förnyar inte spärren.
    expect(store.persistent_recent_triggers[KEY]).toEqual({ t: now, dir: 'north' });
    expect(app._persistentDedupCheck(KEY, vessel).blocked).toBe(true);
    jest.setSystemTime(now + 2 * HOUR + 1000);
    expect(app._persistentDedupCheck(KEY, vessel).blocked).toBe(false);
  });

  test('laddning: en post utan riktning spärrar inte båda hållen för evigt', () => {
    store.persistent_recent_triggers = { [KEY]: { t: now + 30 * 24 * HOUR, dir: null } };
    const app = makeApp();
    app._loadPersistentTriggers();
    jest.setSystemTime(now + 2 * HOUR + 1000);
    expect(app._persistentDedupCheck(KEY, vessel).blocked).toBe(false);
    expect(app._persistentDedupCheck(KEY, { ...vessel, _routeDirection: 'south', cog: 205 }).blocked).toBe(false);
  });

  test('laddning: äldre format (rent tal) i framtiden behandlas likadant', () => {
    store.persistent_recent_triggers = { [KEY]: now + 10 * 24 * HOUR };
    const app = makeApp();
    app._loadPersistentTriggers();
    expect(app._persistentRecentTriggers.get(KEY)).toEqual({ t: now, dir: null });
  });

  test('minutstädningen: en post som hamnat i framtiden efter ett klocksteg bakåt sätts till nu och sparas', () => {
    const app = makeApp();
    app._persistentRecentTriggers.set(KEY, { t: now + 3 * HOUR, dir: 'north' });
    app._pruneDedupCaches();
    expect(app._persistentRecentTriggers.get(KEY)).toEqual({ t: now, dir: 'north' });
    expect(store.persistent_recent_triggers[KEY]).toEqual({ t: now, dir: 'north' });
    jest.setSystemTime(now + 2 * HOUR + 1000);
    expect(app._persistentDedupCheck(KEY, vessel).blocked).toBe(false);
  });

  test('motfall: en stämpel inom klockmarginalen och en vanlig post lämnas orörda', () => {
    store.persistent_recent_triggers = {
      [KEY]: { t: now + SKEW - 1000, dir: 'north' },
      '265099202:Stridsbergsbron': { t: now - HOUR, dir: 'south' },
    };
    const app = makeApp();
    app._loadPersistentTriggers();
    expect(app._persistentRecentTriggers.get(KEY)).toEqual({ t: now + SKEW - 1000, dir: 'north' });
    expect(app._persistentRecentTriggers.get('265099202:Stridsbergsbron')).toEqual({ t: now - HOUR, dir: 'south' });
    const setSpy = jest.spyOn(app.homey.settings, 'set');
    app._pruneDedupCaches();
    expect(app._persistentRecentTriggers.get(KEY).t).toBe(now + SKEW - 1000);
    expect(setSpy).not.toHaveBeenCalled();
  });

  test('motfall: en färsk spärr blockerar fortfarande samma riktning i 2 h', () => {
    store.persistent_recent_triggers = { [KEY]: { t: now - 10 * 60 * 1000, dir: 'north' } };
    const app = makeApp();
    app._loadPersistentTriggers();
    expect(app._persistentDedupCheck(KEY, vessel).blocked).toBe(true);
  });

  // Granskningen L3: systerkartan last_known_positions hade samma ensidiga
  // tidsfilter. En position med framtida stämpel räknades som färsk, och en båt
  // som kom tillbaka på en ny resa fick "har passerat"-notiser ur den gamla
  // positionen. Den släpps nu vid laddning och i städningen.
  describe('sista kända positioner med framtida stämpel', () => {
    const POS = '265099202';
    function withPositions() {
      const app = makeApp();
      app._lastKnownPositions = new Map();
      app._LAST_KNOWN_POSITION_TTL_MS = 6 * HOUR;
      return app;
    }

    test('laddning: posten läses inte och lagringen skrivs om utan den', () => {
      store.last_known_positions = {
        [POS]: { lat: 58.27, lon: 12.27, t: now + 30 * 24 * HOUR },
        265099203: { lat: 58.28, lon: 12.28, t: now - HOUR },
      };
      const app = withPositions();
      app._loadLastKnownPositions();
      expect(app._lastKnownPositions.has(POS)).toBe(false);
      expect(app._lastKnownPositions.has('265099203')).toBe(true);
      expect(store.last_known_positions[POS]).toBeUndefined();
      expect(store.last_known_positions['265099203']).toBeDefined();
    });

    test('städningen tar bort en post som hamnat i framtiden', () => {
      const app = withPositions();
      app._lastKnownPositions.set(POS, { lat: 58.27, lon: 12.27, t: now + 3 * HOUR });
      app._lastKnownPositions.set('265099203', { lat: 58.28, lon: 12.28, t: now - HOUR });
      app._pruneLastKnownPositionsTtl();
      expect(app._lastKnownPositions.has(POS)).toBe(false);
      expect(app._lastKnownPositions.has('265099203')).toBe(true);
    });

    test('motfall: en stämpel inom klockmarginalen behålls', () => {
      store.last_known_positions = { [POS]: { lat: 58.27, lon: 12.27, t: now + SKEW - 1000 } };
      const app = withPositions();
      app._loadLastKnownPositions();
      expect(app._lastKnownPositions.has(POS)).toBe(true);
    });
  });
});
