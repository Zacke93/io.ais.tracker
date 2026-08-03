'use strict';

const AISStreamClient = require('../lib/connection/AISStreamClient');
const AISHubClient = require('../lib/connection/AISHubClient');

/**
 * V7 (A/B-natten 2026-08-03) — KÄLLKONTRAKTET för fusionsfälten.
 *
 * FYNDET: inget test asserterade att AISStreamClient sätter fixTs/fixFeed/
 * fixTsQuality på det den emitterar. Raderas de tre raderna (AISStreamClient
 * ~:579) passerar HELA batteriet, alla 15 låsta korpusar och alla syntetiska
 * scenarier — därför att replay-harnessen INJICERAR fälten själv innan
 * meddelandet matas in, och nedströmstesterna (fixts-fixfeed-plumbning) matar
 * färdiga meddelanden. Exakt så uppstod fältprov 3-regressionen: fälten
 * saknades i produktion, muxens FixFusionPolicy såg lastFeed === undefined
 * och F5:s källbytesskydd hoppades tyst över för hela riktningen
 * aisstream→AISHub — en bugg som ENBART fanns i drift.
 *
 * BEVISKRAVET är därför att gå in via klienternas RÅA yttre gräns:
 *   - AISStreamClient._onMessage(<rå ws-sträng>)  (ws.on('message')-vägen)
 *   - AISHubClient._httpGet → <rå ws.php-kropp>   (poll-vägen)
 * och läsa det som faktiskt emitteras. Ingen injektion, inga färdigbyggda
 * meddelandeobjekt — annars mäter testet harnessen i stället för koden.
 */

function makeLogger() {
  return { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

describe('V7: AISStreamClient sätter fusionsfälten på RÅ ws-väg', () => {
  // En rå aisstream-payload som den ser ut på tråden (positionen i Message-
  // kroppen, namn/tid i MetaData) — INTE ett förkonstruerat internt objekt.
  function rawPositionReport() {
    return JSON.stringify({
      MessageType: 'PositionReport',
      MetaData: {
        MMSI: 265001111,
        ShipName: 'RÅBÅT',
        // aisstream skickar med en egen tidsstämpel. Den används MEDVETET
        // inte som fixtid (se 'receipt'-kontraktet nedan).
        time_utc: '2026-08-03 06:00:00.000000000 +0000 UTC',
      },
      Message: {
        PositionReport: {
          MessageID: 1,
          UserID: 265001111,
          Latitude: 58.29,
          Longitude: 12.29,
          Sog: 5.2,
          Cog: 25,
          NavigationalStatus: 0,
          Valid: true,
        },
      },
    });
  }

  test('emitterat ais-message bär fixFeed/fixTs/fixTsQuality (raderas raderna blir batteriet RÖTT)', () => {
    const client = new AISStreamClient(makeLogger());
    const emitted = [];
    client.on('ais-message', (m) => emitted.push(m));

    const before = Date.now();
    client._onMessage(rawPositionReport());
    const after = Date.now();

    expect(emitted).toHaveLength(1);
    const msg = emitted[0];
    expect(msg.fixFeed).toBe('aisstream');
    expect(msg.fixTsQuality).toBe('receipt');
    expect(Number.isFinite(msg.fixTs)).toBe(true);
    // Klockdomänen: för en PUSHANDE källa ÄR mottagningstiden fixtiden, och
    // båda ska komma från SAMMA Date.now()-avläsning (två anrop hade gett
    // fixtids-dt ett millisekundsbrus som fysikgrindarna räknar på).
    expect(msg.fixTs).toBe(msg.timestamp);
    expect(msg.fixTs).toBeGreaterThanOrEqual(before);
    expect(msg.fixTs).toBeLessThanOrEqual(after);
  });

  test("fixTs är MOTTAGNINGSTID, inte aisstreams time_utc — 'receipt' får aldrig bli en falsk true-fix", () => {
    const client = new AISStreamClient(makeLogger());
    const emitted = [];
    client.on('ais-message', (m) => emitted.push(m));

    client._onMessage(rawPositionReport());

    // time_utc i payloaden är 2026-08-03 06:00 UTC. Skulle den någonsin
    // börja användas som fixTs vore stämpeln en 'true-fix' i förklädnad och
    // F1/F6:s klockdomänsantaganden brutna.
    expect(emitted[0].fixTs).not.toBe(Date.UTC(2026, 7, 3, 6, 0, 0));
    expect(Math.abs(emitted[0].fixTs - Date.now())).toBeLessThan(5000);
  });

  test('Class B-positionsrapport (StandardClassBPositionReport) bär samma fält', () => {
    const client = new AISStreamClient(makeLogger());
    const emitted = [];
    client.on('ais-message', (m) => emitted.push(m));

    client._onMessage(JSON.stringify({
      MessageType: 'StandardClassBPositionReport',
      MetaData: { MMSI: 265002222, ShipName: 'FRITIDSBÅT' },
      Message: {
        StandardClassBPositionReport: {
          UserID: 265002222, Latitude: 58.30, Longitude: 12.30, Sog: 3.1, Cog: 210,
        },
      },
    }));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].fixFeed).toBe('aisstream');
    expect(emitted[0].fixTsQuality).toBe('receipt');
    expect(Number.isFinite(emitted[0].fixTs)).toBe(true);
  });
});

describe('V7: AISHubClient sätter fusionsfälten på RÅ pollväg', () => {
  let client;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-03T06:01:10.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    if (client) client.disconnect();
    client = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("emitterat ais-message bär fixFeed='aishub', fixTsQuality='true-fix' och TIME som fixTs", async () => {
    // Rå ws.php-kropp: [meta, [poster]] med TIME i AISHubs eget format.
    const body = JSON.stringify([
      {
        ERROR: false, USERNAME: 'testuser', FORMAT: 'HUMAN', RECORDS: 1,
      },
      [{
        MMSI: 265001111,
        TIME: '2026-08-03 06:00:30 GMT', // 40 s FÖRE mottagningen
        LATITUDE: 58.29,
        LONGITUDE: 12.29,
        COG: 25,
        SOG: 5.2,
        NAVSTAT: 0,
        NAME: 'POLLBÅT',
      }],
    ]);
    client = new AISHubClient(makeLogger(), null);
    client._httpGet = jest.fn(async () => ({ statusCode: 200, body }));

    const emitted = [];
    client.on('ais-message', (m) => emitted.push(m));
    await client.connect('testuser');
    await jest.advanceTimersByTimeAsync(5000);

    expect(emitted).toHaveLength(1);
    const msg = emitted[0];
    expect(msg.fixFeed).toBe('aishub');
    expect(msg.fixTsQuality).toBe('true-fix');
    // KLOCKDOMÄNDOKTRINEN: fixTs = serverns TIME (fixtid), timestamp =
    // mottagningstid. Att de två SKILJER sig är hela poängen med
    // pollkällan — sammanfaller de har någon råkat stämpla om fixen.
    expect(msg.fixTs).toBe(Date.UTC(2026, 7, 3, 6, 0, 30));
    expect(msg.timestamp).toBeGreaterThan(msg.fixTs);
  });
});
