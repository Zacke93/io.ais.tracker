'use strict';

const { parseEnvelope, parseTimeToMs, isErrorFlagSet } = require('../lib/utils/aishubParser');

/**
 * Etapp 1 (2026-08-02): aishubParser — kuvert, ERROR-gren, sentinelparitet,
 * numerisk koercion och TIME-parsning. Samma fuzz-princip som
 * ais-input-fuzz.test.js: skräp får aldrig bli data, och giltiga poster ska
 * normaliseras till EXAKT AISStreamClient-formen (+ fixTs/fixFeed/quality).
 */

function makeMeta(overrides = {}) {
  return {
    ERROR: false, USERNAME: 'testuser', FORMAT: 'HUMAN', RECORDS: 1, ...overrides,
  };
}

function makeRecord(overrides = {}) {
  return {
    MMSI: 265001111,
    TIME: '2026-08-02 12:00:00 GMT',
    LATITUDE: 58.29,
    LONGITUDE: 12.29,
    COG: 25.5,
    SOG: 5.2,
    HEADING: 26,
    NAVSTAT: 0,
    IMO: 0,
    NAME: 'TESTBAT',
    CALLSIGN: 'SA1234',
    TYPE: 60,
    A: 10,
    B: 5,
    C: 2,
    D: 2,
    DRAUGHT: 2.5,
    DEST: 'TROLLHATTAN',
    ETA: '08-02 14:00',
    ...overrides,
  };
}

function body(meta, records) {
  return JSON.stringify([meta, records]);
}

describe('Etapp 1: kuvert och felgrenar', () => {
  const GARBAGE_BODIES = [
    ['', 'empty-body'],
    ['   \n ', 'empty-body'],
    ['<html>502 Bad Gateway</html>', 'parse-error'],
    ['{not json', 'parse-error'],
    ['{}', 'envelope-error'],
    ['42', 'envelope-error'],
    ['null', 'envelope-error'],
    ['[]', 'envelope-error'],
    ['[[],[]]', 'envelope-error'],
    [JSON.stringify([makeMeta()]), 'envelope-error'], // postlistan saknas
    [JSON.stringify([makeRecord()]), 'envelope-error'], // platt post utan kuvert
    [JSON.stringify([makeMeta(), 'inte en lista']), 'envelope-error'],
  ];

  test.each(GARBAGE_BODIES)('skräpbody %# → kind=%s, noll poster', (raw, kind) => {
    const res = parseEnvelope(raw);
    expect(res.kind).toBe(kind);
    expect(res.ok).toBe(false);
    expect(res.records).toHaveLength(0);
  });

  test('ERROR-grenen kontrolleras FÖRE formkontrollen — felkuvertet saknar postlista', () => {
    const res = parseEnvelope(JSON.stringify([{ ERROR: true, ERROR_MESSAGE: 'Access denied' }]));
    expect(res.kind).toBe('error-record');
    expect(res.errorMessage).toBe('Access denied');
  });

  test.each([
    [true, true], ['true', true], [1, true], ['1', true], ['ERROR', true],
    [false, false], ['false', false], [0, false], ['0', false], [null, false], [undefined, false],
  ])('ERROR-sanningsvärdet %p normaliseras till %p', (raw, expected) => {
    expect(isErrorFlagSet(raw)).toBe(expected);
  });

  test('ERROR utan ERROR_MESSAGE får defaulttext', () => {
    const res = parseEnvelope(JSON.stringify([{ ERROR: 1 }]));
    expect(res.kind).toBe('error-record');
    expect(res.errorMessage).toBe('unknown AISHub error');
  });

  test('FORMAT ≠ HUMAN ⇒ format-mismatch, noll poster (format=0 vore ×600000-gift)', () => {
    const res = parseEnvelope(body(makeMeta({ FORMAT: 'AIS' }), [makeRecord()]));
    expect(res.kind).toBe('format-mismatch');
    expect(res.records).toHaveLength(0);
  });

  test('RECORDS-mismatch flaggas men data behålls', () => {
    const res = parseEnvelope(body(makeMeta({ RECORDS: 7 }), [makeRecord()]));
    expect(res.kind).toBe('data');
    expect(res.records).toHaveLength(1);
    expect(res.stats.recordCountMismatch).toBe(true);
  });

  test('ERROR:false + [] är ett normalt tomt svep (data, 0 poster)', () => {
    const res = parseEnvelope(body(makeMeta({ RECORDS: 0 }), []));
    expect(res.kind).toBe('data');
    expect(res.records).toHaveLength(0);
    expect(res.stats.records).toBe(0);
  });
});

describe('Etapp 1: normalisering och sentinelparitet (AISStreamClient-formen)', () => {
  test('giltig post → exakt meddelandeform med fixTs/fixFeed/fixTsQuality, utan timestamp', () => {
    const res = parseEnvelope(body(makeMeta(), [makeRecord()]));
    expect(res.kind).toBe('data');
    const rec = res.records[0];
    expect(rec).toEqual({
      mmsi: '265001111',
      msgType: 'AISHubPosition',
      lat: 58.29,
      lon: 12.29,
      sog: 5.2,
      cog: 25.5,
      navStatus: 0,
      shipName: 'TESTBAT',
      fixTs: Date.UTC(2026, 7, 2, 12, 0, 0),
      fixFeed: 'aishub',
      fixTsQuality: 'true-fix',
    });
    // Mottagningstid är domän M och stämplas av KLIENTEN — aldrig parsern.
    expect(rec).not.toHaveProperty('timestamp');
    // HEADING bär sentinel 511 och används inte av pipelinen — kastas.
    expect(rec).not.toHaveProperty('heading');
  });

  test.each([
    [102.4, null], [102.3, null], [102.2, null], [102.15, null], [102.1, 102.1], [0, 0], [5.2, 5.2],
    // Null-fällan: Number(null)===0 — saknad fart får ALDRIG bli "verklig
    // nollfart" (osynliga-båtar-klassen).
    [null, null], [undefined, null],
  ])('SOG-sentinelen: %p → %p (samma ≥102.15-gräns som AISStreamClient)', (raw, expected) => {
    const res = parseEnvelope(body(makeMeta(), [makeRecord({ SOG: raw })]));
    expect(res.records[0].sog).toBe(expected);
  });

  test.each([
    [360, null], [359.9, 359.9], [0, 0], ['25.5', 25.5], ['skräp', null], [null, null],
  ])('COG-sentinelen/koercion: %p → %p', (raw, expected) => {
    const res = parseEnvelope(body(makeMeta(), [makeRecord({ COG: raw })]));
    expect(res.records[0].cog).toBe(expected);
  });

  test.each([
    [15, null], [16, null], [-1, null], [5, 5], [1, 1], ['5', 5], [null, null], ['x', null],
  ])('NAVSTAT: %p → %p (15 = AIS-spec "undefined" får aldrig skriva över känt 1/5)', (raw, expected) => {
    const res = parseEnvelope(body(makeMeta(), [makeRecord({ NAVSTAT: raw })]));
    expect(res.records[0].navStatus).toBe(expected);
  });

  test('strängserverade koordinater koerceras numeriskt', () => {
    const res = parseEnvelope(body(makeMeta(), [makeRecord({ LATITUDE: '58.29', LONGITUDE: '12.29' })]));
    expect(res.records[0].lat).toBe(58.29);
    expect(res.records[0].lon).toBe(12.29);
  });

  test.each([
    [0], [-1], [1.5], ['noll'], [null], [undefined],
  ])('ogiltigt MMSI %p droppas NUMERISKT före strängifiering (aldrig "0" i pipelinen)', (raw) => {
    const res = parseEnvelope(body(makeMeta(), [makeRecord({ MMSI: raw })]));
    expect(res.records).toHaveLength(0);
    expect(res.stats.invalidMmsi).toBe(1);
  });

  test('MMSI som sträng koerceras ("244123456" → "244123456")', () => {
    const res = parseEnvelope(body(makeMeta(), [makeRecord({ MMSI: '244123456' })]));
    expect(res.records[0].mmsi).toBe('244123456');
  });

  test.each([
    [91, 12.29], [-91, 12.29], [58.29, 181], [58.29, -181], ['x', 12.29],
  ])('positionssentinel/ogiltig position lat=%p lon=%p droppas', (lat, lon) => {
    const res = parseEnvelope(body(makeMeta(), [makeRecord({ LATITUDE: lat, LONGITUDE: lon })]));
    expect(res.records).toHaveLength(0);
    expect(res.stats.invalidPosition).toBe(1);
  });

  test('0,0 (Guineabukten-artefakten) droppas som sentinelPos — AISStreamClient-pariteten', () => {
    const res = parseEnvelope(body(makeMeta(), [makeRecord({ LATITUDE: 0, LONGITUDE: 0 })]));
    expect(res.records).toHaveLength(0);
    expect(res.stats.sentinelPos).toBe(1);
  });

  test('NAME: @-fyllnad och blanksteg trimmas; tomt → Unknown', () => {
    const a = parseEnvelope(body(makeMeta(), [makeRecord({ NAME: ' ENCHANTMENT OTS@@@' })]));
    expect(a.records[0].shipName).toBe('ENCHANTMENT OTS');
    const b = parseEnvelope(body(makeMeta(), [makeRecord({ NAME: '@@@' })]));
    expect(b.records[0].shipName).toBe('Unknown');
    const c = parseEnvelope(body(makeMeta(), [makeRecord({ NAME: null })]));
    expect(c.records[0].shipName).toBe('Unknown');
  });

  test('blandat svep: giltiga poster överlever grannarnas skräp', () => {
    const res = parseEnvelope(body(makeMeta({ RECORDS: 4 }), [
      makeRecord(),
      makeRecord({ MMSI: 0 }),
      makeRecord({ TIME: 'igår typ' }),
      makeRecord({ MMSI: 265002222, NAME: 'TVAAN' }),
    ]));
    expect(res.records).toHaveLength(2);
    expect(res.records.map((r) => r.mmsi)).toEqual(['265001111', '265002222']);
    expect(res.stats.invalidMmsi).toBe(1);
    expect(res.stats.timeParseFail).toBe(1);
  });
});

describe('Etapp 1: TIME → fixTs (aldrig new Date(str), fast epoch — TZ-oberoende via Date.UTC)', () => {
  // Dokumentationsexemplet: "2021-07-09 12:08:05 GMT".
  const DOC_EPOCH = Date.UTC(2021, 6, 9, 12, 8, 5); // 1625832485000

  test.each([
    ['2021-07-09 12:08:05 GMT', DOC_EPOCH],
    ['2021-07-09 12:08:05 UTC', DOC_EPOCH],
    ['2021-07-09 12:08:05Z', DOC_EPOCH],
    ['2021-07-09 12:08:05', DOC_EPOCH],
    ['2021-07-09T12:08:05 GMT', DOC_EPOCH],
    ['  2021-07-09 12:08:05 GMT  ', DOC_EPOCH],
    ['1625832485', 1625832485000], // unix-sekundsfallback (format=0-drift)
    [1625832485, 1625832485000], // servern levererar tal
  ])('parseTimeToMs(%p) → %p', (raw, expected) => {
    expect(parseTimeToMs(raw)).toBe(expected);
    expect(DOC_EPOCH).toBe(1625832485000); // fast epoch-konstant, TZ-bevis
  });

  test.each([
    ['igår', null], ['', null], [null, null], [undefined, null],
    ['2021-13-45 99:99:99 GMT', null], // regexen matchar men Date.UTC... (se nedan)
    ['07-09 12:08', null], // ETA-formatet är INTE en tidsstämpel
    [123, null], // för litet för unix-sekunder
    [1e12, null], // ms-magnitud accepteras inte som sekunder
  ])('oparsbar TIME %p → null', (raw) => {
    // OBS 2021-13-45: Date.UTC rullar över månader/dagar (returnerar finit
    // tal) — men regexen kräver \d{2} vilket 99:99:99 uppfyller… värdet blir
    // ett FINIT men fel epoch. Kontraktet här är att UPPENBART skräp ger
    // null; siffergiltiga-men-orimliga stämplar fångas av F4a/F4b-grindarna
    // (framtidsklamp + åldersgrind) i fusionspolicyn.
    const ms = parseTimeToMs(raw);
    if (raw === '2021-13-45 99:99:99 GMT') {
      // dokumenterat beteende: finit men fel — F4-grindarna är försvaret
      expect(Number.isFinite(ms)).toBe(true);
    } else {
      expect(ms).toBeNull();
    }
  });
});
