'use strict';

jest.mock('homey');

/**
 * N10 (helkodsgranskning RUNDA 5, 2026-08-23) — AISHUB-VAKTENS BÅDA GRENAR VAR
 * STRUKTURELLT OÅTKOMLIGA I SKUGGLÄGE.
 *
 * MEKANISMEN FÖRE FIXEN: _checkAISFeedHealth returnerade när MUXAGGREGATETS
 * isConnected var falskt. Aggregatet kräver att hubben matar PIPELINEN
 * (_hubFeedsPipeline: bara 'both'/'aishub'), så i skuggläge utan
 * aisstream-nyckel är aggregatet permanent frånkopplat — och då kördes
 * _checkAishubFeedHealth ALDRIG. M12:s andra försvarslinje (kedjedödskicken
 * som väcker en poll-kedja vars timer dött) var alltså död i exakt det läge
 * M37 nyss gjorde förstklassigt. Skadan är utebliven självläkning av
 * MÄTNINGEN — skuggläget matar varken brotext eller notiser — men mätningen är
 * underlaget för källbesluten.
 *
 * FIXEN: hubbgrenen körs även i den frånkopplade grenen. Den har sina EGNA
 * grindar (configured, auth-cooldown, och isConnected för tystnadsbenet) och
 * ingriper bara via forceReschedule, som ovillkorligt respekterar den
 * persisterade 61-sekundersspärren. AISSTREAM-grenen ligger kvar bakom
 * aggregatgrinden: där äger klientens egen flank/backoff återanslutningen.
 *
 * MUTATIONSPROV (körs manuellt): ta bort _checkAishubFeedHealth-anropet ur den
 * frånkopplade grenen ⇒ "SKUGGLÄGE: kedjedöd väcks" blir röd. Flytta även
 * aisstream-grenen dit ⇒ "aisstream rörs inte i frånkopplat läge" blir röd.
 */

const AISBridgeApp = require('../app');
const { AIS_CONFIG } = require('../lib/constants');

const MIN = 60 * 1000;
const CHAIN_DEAD_MS = 2 * AIS_CONFIG.AISHUB.BACKOFF_MAX_MS + 60 * 1000; // 11 min

function makeApp({ aggregateConnected }) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  app.debug = jest.fn();
  app.homey = {
    settings: {
      // Skuggläge utan aisstream-nyckel = fallet där aggregatet aldrig blir
      // uppkopplat (muxen räknar inte hubben som matande i 'shadow').
      get: (key) => ({ ais_source: 'shadow', aishub_username: 'z', ais_api_key: '' }[key] ?? null),
      set: jest.fn(),
      on: jest.fn(),
    },
  };
  app.aisClient = {
    isConnected: aggregateConnected,
    kickAishub: jest.fn(),
    reconnectWithKey: jest.fn().mockResolvedValue(undefined),
    getConnectionStats: jest.fn(() => ({
      perFeed: {
        aisstream: {
          configured: false, isConnected: false, timeSinceLastMessage: null, uptime: 0,
        },
        aishub: {
          configured: true,
          isConnected: true,
          // Kedjan har inte startat en poll på 45 min = död timer.
          lastPollStartedAt: Date.now() - 45 * MIN,
          lastOkResponseAt: Date.now() - 45 * MIN,
          lastMessageTime: Date.now() - 45 * MIN,
        },
      },
    })),
  };
  return app;
}

describe('N10: hubbgrenen är inte aggregatets', () => {
  test('SKUGGLÄGE (aggregat frånkopplat): död kedja väcks ändå', () => {
    const app = makeApp({ aggregateConnected: false });

    app._checkAISFeedHealth();

    expect(app.aisClient.kickAishub).toHaveBeenCalledTimes(1);
    expect(app.log).toHaveBeenCalledWith(expect.stringContaining('kedjan verkar död'));
  });

  test('BOTH-LÄGE (aggregat uppkopplat): oförändrat beteende, samma kick', () => {
    const app = makeApp({ aggregateConnected: true });

    app._checkAISFeedHealth();

    expect(app.aisClient.kickAishub).toHaveBeenCalledTimes(1);
  });

  test('AISSTREAM-GRENEN rörs inte i frånkopplat läge (klientens backoff äger)', () => {
    const app = makeApp({ aggregateConnected: false });

    app._checkAISFeedHealth();

    expect(app.aisClient.reconnectWithKey).not.toHaveBeenCalled();
  });

  test('HUBBENS EGNA GRINDAR gäller fortfarande: okonfigurerad ⇒ ingen kick', () => {
    const app = makeApp({ aggregateConnected: false });
    app.aisClient.getConnectionStats = jest.fn(() => ({
      perFeed: {
        aisstream: { configured: false, isConnected: false },
        aishub: { configured: false, isConnected: false },
      },
    }));

    app._checkAISFeedHealth();

    expect(app.aisClient.kickAishub).not.toHaveBeenCalled();
  });

  test('AUTH-PAUSEN respekteras även i den frånkopplade grenen', () => {
    const app = makeApp({ aggregateConnected: false });
    const stats = app.aisClient.getConnectionStats();
    stats.perFeed.aishub.authCooldownMsLeft = 30 * MIN;
    app.aisClient.getConnectionStats = jest.fn(() => stats);

    app._checkAISFeedHealth();

    expect(app.aisClient.kickAishub).not.toHaveBeenCalled();
  });

  test('FÄRSK KEDJA i skuggläge ⇒ ingen kick (tröskeln är oförändrad)', () => {
    const app = makeApp({ aggregateConnected: false });
    const stats = app.aisClient.getConnectionStats();
    stats.perFeed.aishub.lastPollStartedAt = Date.now() - (CHAIN_DEAD_MS - 60 * 1000);
    stats.perFeed.aishub.lastOkResponseAt = Date.now() - 30 * 1000;
    app.aisClient.getConnectionStats = jest.fn(() => stats);

    app._checkAISFeedHealth();

    expect(app.aisClient.kickAishub).not.toHaveBeenCalled();
  });
});
