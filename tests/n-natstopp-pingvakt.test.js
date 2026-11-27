'use strict';

/**
 * Spår N (omgång 10, U78): vad AISStreamClient gör när nätet står still.
 *
 * Låser det beteende utredningen mätte; inget av proven ändrar koden. Den riktiga
 * klienten och det riktiga `ws`-biblioteket ansluter till en lokal ws-server på
 * 127.0.0.1 bakom en TCP-proxy som kan frysa trafiken åt båda hållen (bytes hålls
 * kvar och släpps vid återkomsten, som TCP gör efter ett avbrott där anslutningen
 * består). Bara adressen styrs om; inget går utanför datorn.
 *
 * Pingvakten (30 s) river socketen vid en kontroll där förra pingen saknar pong och
 * inget meddelande kommit sedan förra kontrollen. Ett stopp som börjar strax efter
 * en kontroll överlevs därför till kontrollen efter nästa (knappt 60 s); då kommer
 * stoppets meddelanden i en klump, med samma mottagningstid. Ett längre stopp river
 * socketen, och stoppets meddelanden kommer aldrig: klienten ansluter på nytt och
 * får bara det servern skickar därefter.
 *
 * Klientens timrar (pingvakt, återanslutning, deadlines) går på jests låtsade
 * klocka; socketar, setImmediate och Date är äkta.
 */

jest.mock('ws', () => {
  const Real = jest.requireActual('ws');
  // Bara klientens adress styrs om till proxyn; allt annat är ws som det är.
  class Omstyrd extends Real {
    constructor(url, opts) {
      super(global.__N_NATSTOPP_MAL__ || url, opts);
    }
  }
  return Omstyrd;
});

const net = require('net');

const MMSI = 265000101;

// Väntar på äkta I/O (Date är äkta) tills villkoret håller, högst maxMs.
async function vantaPa(villkor, maxMs = 5000) {
  const slut = Date.now() + maxMs;
  while (!villkor()) {
    if (Date.now() > slut) throw new Error('väntan löpte ut');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setImmediate(r);
    });
  }
}
async function vantaReal(ms) {
  const slut = Date.now() + ms;
  while (Date.now() < slut) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setImmediate(r);
    });
  }
}

function positionsrapport(n) {
  return JSON.stringify({
    MessageType: 'PositionReport',
    MetaData: { MMSI, ShipName: 'NATSTOPP', time_utc: new Date().toISOString() },
    Message: {
      PositionReport: {
        UserID: MMSI, Latitude: 58.28 + n * 0.0005, Longitude: 12.28, Sog: 5, Cog: 20, NavigationalStatus: 0, Valid: true,
      },
    },
  });
}

describe('N: nätstopp genom den riktiga klienten', () => {
  let Real;
  let server;
  let proxy;
  let serverSockets;
  let proxySockets;
  let fryst;
  let ko;
  let client;
  let loggrader;
  let mottagna;
  let nedkopplingar;

  const frys = () => {
    fryst = true;
  };
  const slapp = () => {
    fryst = false;
    for (const [till, b] of ko.splice(0)) if (!till.destroyed) till.write(b);
  };
  const senasteServerSocket = () => serverSockets[serverSockets.length - 1];

  beforeEach(async () => {
    Real = jest.requireActual('ws');
    serverSockets = [];
    proxySockets = [];
    fryst = false;
    ko = [];
    loggrader = [];
    mottagna = [];
    nedkopplingar = 0;

    server = new Real.Server({ port: 0, host: '127.0.0.1' });
    server.on('connection', (sock) => {
      sock.prenumererad = false;
      sock.on('message', () => {
        sock.prenumererad = true;
      });
      serverSockets.push(sock);
    });
    await new Promise((r) => {
      server.on('listening', r);
    });

    proxy = net.createServer((c) => {
      const u = net.connect(server.address().port, '127.0.0.1');
      proxySockets.push(c, u);
      const vidare = (fran, till) => fran.on('data', (b) => {
        if (fryst) ko.push([till, b]); else if (!till.destroyed) till.write(b);
      });
      vidare(c, u);
      vidare(u, c);
      const stang = () => {
        c.destroy(); u.destroy();
      };
      c.on('close', stang);
      u.on('close', stang);
      c.on('error', () => {});
      u.on('error', () => {});
    });
    await new Promise((r) => {
      proxy.listen(0, '127.0.0.1', r);
    });
    global.__N_NATSTOPP_MAL__ = `ws://127.0.0.1:${proxy.address().port}`;

    jest.useFakeTimers({
      doNotFake: ['Date', 'nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'hrtime', 'performance'],
    });
    jest.spyOn(Math, 'random').mockReturnValue(0);

    const AISStreamClient = require('../lib/connection/AISStreamClient');
    const logger = {
      log: (...a) => loggrader.push(a.join(' ')),
      debug: () => {},
      error: (...a) => loggrader.push(a.map(String).join(' ')),
    };
    client = new AISStreamClient(logger);
    client.on('error', () => {}); // muxen lyssnar i appen
    client.on('ais-message', (m) => mottagna.push(m));
    client.on('disconnected', () => {
      nedkopplingar++;
    });
    client.connect('nyckel');
    await vantaPa(() => client.isConnected && serverSockets.length === 1 && senasteServerSocket().prenumererad);
  });

  afterEach(async () => {
    client.disconnect();
    slapp();
    for (const s of server.clients) s.terminate();
    for (const s of proxySockets) s.destroy();
    await new Promise((r) => {
      proxy.close(r);
    });
    await new Promise((r) => {
      server.close(r);
    });
    await vantaReal(20); // låt socketarnas close-händelser gå klart
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete global.__N_NATSTOPP_MAL__;
  });

  // Första pingvaktskontrollen (30 s efter öppningen) och dess pong: stoppet börjar
  // alltså strax efter en kontroll, det läge som överlevs längst.
  async function forstaKontrollenMedPong() {
    jest.advanceTimersByTime(30000);
    await vantaPa(() => client.lastPongAt !== null);
  }

  test('ett stopp på 59 s strax efter en kontroll överlevs: meddelandena kommer i en klump med samma mottagningstid', async () => {
    await forstaKontrollenMedPong();
    frys();
    // Tre positioner för samma båt under stoppet, med tid emellan.
    for (let i = 0; i < 3; i++) {
      senasteServerSocket().send(positionsrapport(i));
      jest.advanceTimersByTime(14000); // 30 + 14 + 14 + 14 s: kontrollen vid 60 s pingar in i stoppet
      // eslint-disable-next-line no-await-in-loop
      await vantaReal(20);
    }
    jest.advanceTimersByTime(17000); // 89 s efter öppningen, strax före kontrollen vid 90 s
    await vantaReal(50);
    expect(mottagna).toHaveLength(0);
    expect(client.isConnected).toBe(true);

    slapp();
    await vantaPa(() => mottagna.length === 3);
    const tider = mottagna.map((m) => m.timestamp);
    expect(Math.max(...tider) - Math.min(...tider)).toBeLessThanOrEqual(5);
    expect(mottagna.map((m) => m.fixTs)).toEqual(tider); // fixtid = mottagningstid
    expect(mottagna.map((m) => m.lat)).toEqual([58.28, 58.2805, 58.281]); // ordningen står kvar

    // Pongen från kontrollen vid 60 s kom med klumpen: kontrollen vid 90 s river inte.
    jest.advanceTimersByTime(1000);
    await vantaReal(20);
    expect(client.isConnected).toBe(true);
    expect(nedkopplingar).toBe(0);
    expect(loggrader.some((l) => l.includes('No pong since last ping'))).toBe(false);
    expect(serverSockets).toHaveLength(1);
  });

  test('ett stopp som når kontrollen efter nästa river socketen; stoppets meddelanden kommer aldrig, klienten ansluter på nytt', async () => {
    await forstaKontrollenMedPong();
    frys();
    senasteServerSocket().send(positionsrapport(0));
    jest.advanceTimersByTime(30000); // kontrollen vid 60 s: ping in i stoppet
    senasteServerSocket().send(positionsrapport(1));
    await vantaReal(20);
    jest.advanceTimersByTime(30000); // kontrollen vid 90 s: ingen pong, inget meddelande
    await vantaPa(() => nedkopplingar === 1);
    expect(loggrader.some((l) => l.includes('No pong since last ping'))).toBe(true);
    expect(client.isConnected).toBe(false);

    // Nätet kommer tillbaka: det som hölls kvar når aldrig klienten.
    slapp();
    await vantaReal(100);
    expect(mottagna).toHaveLength(0);

    // Återanslutningen (snabbfasens första steg, 1 s med jittret satt till 0).
    jest.advanceTimersByTime(1000);
    await vantaPa(() => client.isConnected && serverSockets.length === 2 && senasteServerSocket().prenumererad);
    senasteServerSocket().send(positionsrapport(2));
    await vantaPa(() => mottagna.length === 1);
    expect(mottagna[0].lat).toBe(58.281); // bara det som skickades efter återanslutningen
  });
});
