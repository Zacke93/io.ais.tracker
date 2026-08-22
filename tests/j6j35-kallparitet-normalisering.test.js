'use strict';

jest.mock('homey');

const { parseEnvelope } = require('../lib/utils/aishubParser');
const AISStreamClient = require('../lib/connection/AISStreamClient');
const AISSourceMultiplexer = require('../lib/connection/AISSourceMultiplexer');

/**
 * J6 + J35 (helkodsgranskning runda 2, 2026-08-22) — KÄLLPARITET FÖR
 * AIS-SKALÄRFÄLTEN.
 *
 * H34 gav COG hela intervallgrinden (0-<360, annars null, POSITIONEN kvar)
 * på HUBBSIDAN men lämnade strömsidan orörd; NAVSTAT 15 saneras likaså bara
 * av parsern. Reglerna var alltså skrivna två gånger och hade glidit isär.
 *
 * VARFÖR DET INTE ÄR KOSMETIK: FixFusionPolicy.contentScalarKey är
 * `mmsi:sog:cog`, och muxen bokför fixen via applyAccept FÖRE appens
 * _validateAISMessage. Samma fysiska rapport bar därför cog 360 från
 * aisstream och cog null från AISHub ⇒ F2:s korskälle-dedup matchade
 * ALDRIG för kurslösa fartyg (förtöjda, Class B utan kompass), den extra
 * fixen förnyade vessel.timestamp, och F6b:s parbevis bildade aldrig par.
 * Testerna matar därför genom de RIKTIGA ingångarna (parseEnvelope och
 * _extractAISData) och vidare genom den RIKTIGA muxen — inga handsatta fält.
 */

function makeLogger() {
  return { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function makeStore() {
  const data = {};
  return {
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => {
      data[k] = v;
    },
  };
}

/** Rå aisstream-nyttolast (samma form som go-ais-dekodern levererar). */
function streamRaw({
  mmsi = 265001111, sog = 5.2, cog = 25.5, navStatus = 0,
  lat = 58.29, lon = 12.29,
} = {}) {
  const report = { MMSI: mmsi, SOG: sog, COG: cog };
  if (navStatus !== undefined) report.NavigationalStatus = navStatus;
  return {
    MessageType: 'PositionReport',
    Message: { PositionReport: report },
    MetaData: { Latitude: lat, Longitude: lon, ShipName: 'TESTBAT' },
  };
}

/** Rå AISHub-kuvert med EN post. */
function hubRaw({
  mmsi = 265001111, sog = 5.2, cog = 25.5, navstat = 0,
  lat = 58.29, lon = 12.29, time = '2026-08-02 12:00:00 GMT',
} = {}) {
  const meta = {
    ERROR: false, USERNAME: 'testuser', FORMAT: 'HUMAN', RECORDS: 1,
  };
  const rec = {
    MMSI: mmsi,
    TIME: time,
    LATITUDE: lat,
    LONGITUDE: lon,
    COG: cog,
    SOG: sog,
    HEADING: 26,
    NAVSTAT: navstat,
    NAME: 'TESTBAT',
  };
  return JSON.stringify([meta, [rec]]);
}

function extract(raw) {
  const client = new AISStreamClient(makeLogger());
  return client._extractAISData(raw);
}

function parseOne(raw) {
  const res = parseEnvelope(raw);
  expect(res.kind).toBe('data');
  return res.records[0];
}

describe('J6: aisstream normaliserar COG med EXAKT parserns regel', () => {
  test.each([
    [360, null, 'sentinelen "kurs ej tillgänglig"'],
    [360.1, null, 'rå COG 3601 — nedre kanten av skräpbandet'],
    [409.5, null, 'rå COG 4095 — övre kanten av skräpbandet'],
    [-1, null, 'negativ kurs finns inte i kodningen'],
    [720, null, 'två varv — bär ingen riktning'],
    [NaN, null, 'icke-finit'],
    [359.9, 359.9, 'högsta GILTIGA kursen släpps orörd'],
    [0, 0, 'nordkurs 0 är ett ÄKTA värde och får aldrig nollas'],
    [25.5, 25.5, 'vanlig kurs'],
  ])('COG %p → %p (%s)', (cog, forvantad) => {
    const d = extract(streamRaw({ cog }));
    expect(d.cog).toBe(forvantad);
    // DOKTRINEN: bara FÄLTET kasseras, aldrig positionen.
    expect(d.lat).toBe(58.29);
    expect(d.lon).toBe(12.29);
  });

  test('parsern och strömmen ger IDENTISK cog för samma värde (kan inte glida isär)', () => {
    for (const cog of [0, 25.5, 359.9, 360, 360.1, 409.5, -1]) {
      expect(extract(streamRaw({ cog })).cog).toBe(parseOne(hubRaw({ cog })).cog);
    }
  });
});

describe('J35: aisstream normaliserar NAVSTAT med EXAKT parserns regel', () => {
  test.each([
    [15, null, 'AIS-spec "undefined" — får ALDRIG skriva över känt 1/5'],
    [16, null, 'utanför intervallet'],
    [-1, null, 'negativt'],
    [0, 0, 'under way using engine'],
    [1, 1, 'at anchor'],
    [5, 5, 'moored'],
    [14, 14, 'högsta semantiska statusen'],
  ])('NAVSTAT %p → %p (%s)', (navStatus, forvantad) => {
    expect(extract(streamRaw({ navStatus })).navStatus).toBe(forvantad);
  });

  test('Class B utan fältet ⇒ null (oförändrat)', () => {
    const raw = streamRaw();
    delete raw.Message.PositionReport.NavigationalStatus;
    expect(extract(raw).navStatus).toBeNull();
  });

  test('parsern och strömmen ger IDENTISK navStatus (0-14 igenom, 15 till null)', () => {
    for (const v of [0, 1, 5, 14, 15, 16]) {
      expect(extract(streamRaw({ navStatus: v })).navStatus)
        .toBe(parseOne(hubRaw({ navstat: v })).navStatus);
    }
  });
});

describe('SOG-sentinelen: samma gräns i BÅDA ingångarna — och INGEN finitgrind', () => {
  test.each([
    [102.4, null], [102.3, null], [102.15, null], [102.1, 102.1], [0, 0], [5.2, 5.2],
  ])('SOG %p → %p i BÅDA ingångarna', (sog, forvantad) => {
    expect(extract(streamRaw({ sog })).sog).toBe(forvantad);
    expect(parseOne(hubRaw({ sog })).sog).toBe(forvantad);
  });

  /**
   * J3 ÄR DEMENTERAT — och den här sviten låser att fixen INTE smugit in det.
   *
   * Hjälparen bar en kort stund en finitgrind som gjorde ett icke-finit sog
   * till null i BÅDA ingångarna. Det var en semantikändring, inte kosmetik:
   * ett sådant meddelande faller i app.js _validateAISMessage (else-grenen
   * returnerar false), men med grinden hade det levererats vidare med
   * sog null — alltså som den FARTGIVARLÖSA klassen som
   * förtöjningsdetekteringen och GPS-gaten behandlar särskilt. J3:s felmod
   * ("icke-finit SOG fäller hela rapporten") är dessutom obeprövbar i fält:
   * AIS-SOG är ett teckenlöst 10-bitarsfält och AIS_VALIDATION_REJECT loggas
   * 0 gånger i 102 fältloggar. Strömsidan ska därför bete sig EXAKT som före
   * paritetsfixen, och hubbsidans null kommer från dess EGEN num()-grind
   * (wire-kontraktet), inte från hjälparen.
   */
  test('icke-finit SOG passerar RÅTT på strömsidan (HEAD-beteendet bevarat)', () => {
    const d = extract(streamRaw({ sog: 'skräp' }));
    expect(d.sog).toBe('skräp'); // orört — appvalideringen äger avvisandet
    expect(d.lat).toBe(58.29);

    const nan = extract(streamRaw({ sog: NaN }));
    expect(Number.isNaN(nan.sog)).toBe(true);

    // Infinity är gränsfallet en naken ">= sentinel"-jämförelse hade tappat
    // (Infinity >= 102.15 är sant): finitkravet står FÖRE jämförelsen just
    // för att HEAD-beteendet ska bevaras exakt.
    const inf = extract(streamRaw({ sog: Infinity }));
    expect(inf.sog).toBe(Infinity);
  });

  test('hubbsidan mappar ändå icke-finit till null — dess EGEN num()-grind', () => {
    // Number(null) är 0: utan grinden hade en saknad fart blivit "verklig
    // nollfart". Grinden är AISHubs wire-kontrakt och bor i parsern.
    expect(parseOne(hubRaw({ sog: 'skräp' })).sog).toBeNull();
    expect(parseOne(hubRaw({ sog: null })).sog).toBeNull();
  });
});

describe('F2-PARITETEN genom den riktiga muxen: korskälle-dedupen lever för kurslösa', () => {
  let mux;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    mux = new AISSourceMultiplexer(makeLogger(), makeStore());
    mux._config.source = 'both';
  });

  afterEach(() => {
    mux.disconnect();
    mux = null;
    jest.useRealTimers();
  });

  test('samma rapport från BÅDA källorna (COG-sentinel 360) fångas av F2 — före fixen släpptes den in', () => {
    const nu = Date.now();
    const mottagna = [];
    mux.on('ais-message', (e) => mottagna.push(e));

    // 1) aisstream levererar den RIKTIGA vägen: rå nyttolast → _extractAISData.
    const stream = extract(streamRaw({ cog: 360, sog: 0 }));
    mux._ingestFromFeed('aisstream', stream);

    // 2) AISHub levererar SAMMA fysiska rapport den RIKTIGA vägen:
    //    rå kuvert → parseEnvelope. Fixtiden sätts 3 s SENARE så att F6:s
    //    stale-grind inte kan fälla posten — då är F2 den enda grind som
    //    kan avvisa den, och testet mäter alltså exakt det J6 handlar om.
    const hub = parseOne(hubRaw({ cog: 360, sog: 0 }));
    hub.timestamp = nu;
    // MEKANISMEN, uttryckligen: båda ingångarna ger nu samma skalärer, och
    // det är DE som bygger F2:s contentScalarKey (mmsi:sog:cog).
    expect(stream.cog).toBeNull();
    expect(hub.cog).toBeNull();
    expect(stream.sog).toBe(hub.sog);
    mux._ingestFromFeed('aishub', { ...hub, fixTs: nu + 3000 });

    // FÖRE J6: stream.cog === 360 och hub.cog === null ⇒ olika
    // contentScalarKey ⇒ F2 matchade aldrig ⇒ båda accepterades.
    expect(mottagna).toHaveLength(1);
    expect(mottagna[0].fixFeed).toBe('aisstream');
    const { fusion } = mux.getConnectionStats();
    expect(fusion.byReason.cross_feed_duplicate).toBe(1);
  });

  test('kontrollarm: en ÄKTA ny rapport (annan kurs) dedupas fortfarande INTE bort', () => {
    const nu = Date.now();
    const mottagna = [];
    mux.on('ais-message', (e) => mottagna.push(e));

    mux._ingestFromFeed('aisstream', extract(streamRaw({ cog: 360, sog: 0 })));
    const hub = parseOne(hubRaw({ cog: 25.5, sog: 0 }));
    hub.timestamp = nu;
    mux._ingestFromFeed('aishub', { ...hub, fixTs: nu + 3000 });

    expect(mottagna).toHaveLength(2);
    expect(mux.getConnectionStats().fusion.byReason.cross_feed_duplicate || 0).toBe(0);
  });
});
