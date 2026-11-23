'use strict';

/**
 * RYCK I KÖN VID JÄRNVÄGSBRON GER INGEN VARNING FÖR STRIDSBERGSBRON (känd gräns,
 * beslut U56, återtaget 2026-11-24; docs/ARCHITECTURE.md vid fartökningsregeln).
 *
 * Varningen för Stridsbergsbron norrut efter väntan vid Järnvägsbron kommer sent
 * (fältprov 2: 37–218 s före passagen). En regel som släpper varningen på första
 * fixet i minst 2,0 kn efter appens köbelägg (U56) prövades och avstods: ett ryck i
 * kön går inte att skilja från avgången i det ögonblicket. Med regeln fick båtarna
 * nedan kortet "om 3" 12–35 min för tidigt och inget kort vid den verkliga avgången,
 * och ryck följt av vändning gav ett falsklarm. Testen låser dagens utfall (basen
 * 7633653): ingen varning vid rycket, varningen först vid den verkliga avgången, och
 * ingen varning alls när båten vänder.
 *
 * Fixturerna i tests/fixtures/ko-ryck/ är syntetiska (egna positioner längs farleden,
 * egna namn och MMSI; AISHub-takt 65–70 s om inget annat sägs, kö 250–310 m före
 * Järnvägsbron, båt med historik norrut). Ledtiden mäts mot korsningen ur raderna.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BRIDGES } = require('../lib/constants');

const DIR = path.join(__dirname, 'fixtures', 'ko-ryck');
const SB = 'Stridsbergsbron';
const STRID = BRIDGES.stridsbergsbron;

const cache = new Map();
function replay(file) {
  if (!cache.has(file)) {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'replay-validation/replayRunner.js'), path.join(DIR, file)], {
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env, REPLAY_MONITORING: '0', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
      },
    });
    cache.set(file, JSON.parse(out.match(/__REPLAY_JSON__([\s\S]*?)__END__/)[1]));
  }
  return cache.get(file);
}

// Sann korsning (fixtid) ur fixturens rader: linjärt mellan fixen på var sida om brons latitud.
function crossing(file, mmsi) {
  const rows = fs.readFileSync(path.join(DIR, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((r) => String(r.mmsi) === mmsi && Number.isFinite(r.lat))
    .sort((a, b) => a.aisTimestamp - b.aisTimestamp);
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (a.lat < STRID.lat && b.lat >= STRID.lat) {
      return a.fixTs + ((STRID.lat - a.lat) / (b.lat - a.lat)) * (b.fixTs - a.fixTs);
    }
  }
  return null;
}

const warningsFor = (result, mmsi) => result.openingWarnings.filter((w) => w.bridge === SB && w.mmsis.includes(mmsi));

describe('Ryck i kön vid Järnvägsbron: ingen varning för Stridsbergsbron vid rycket', () => {
  test.each([
    // [fixtur, mmsi, beskrivning; ledtid på basen 7633653; med den avstådda regeln]
    ['ryck-gor-plats-30m-21kn.jsonl', '958100001', 'flyttar 30 m i 2,1 kn och står 12 min', 'basen 63 s; regeln 994 s'],
    ['ryck-60m-23kn-star30.jsonl', '958100002', 'går 60 m i 2,3 kn och står 30 min', 'basen 75 s; regeln 2 085 s'],
    ['utliggare-35m-23kn.jsonl', '958100003', 'stilla, ett felaktigt fix 35 m norrut med 2,3 kn', 'basen 92 s; regeln 1 038 s'],
    ['drift-30m-rapport20kn.jsonl', '958100004', 'driver 30 m på 6 min med rapporterad fart 2,0 kn', 'basen 127 s; regeln 932 s'],
    ['klassA-ryck-25m-22kn.jsonl', '958100005', 'klass A (10 s), ryck 25 m i 2,2 kn, ny kö 8 min', 'basen 148 s; regeln 741 s'],
    ['ryck-under-2kn.jsonl', '956000004', 'ryck 60 m i 1,8 kn och ny kö 6 min', 'basen 100 s'],
  ])('%s (%s: %s; %s): ett kort, vid den verkliga avgången', (file, mmsi) => {
    const result = replay(file);
    expect(result.processErrors).toBe(0);
    const tc = crossing(file, mmsi);
    expect(tc).not.toBeNull();
    const ws = warningsFor(result, mmsi);
    expect(ws).toHaveLength(1);
    const leadS = (tc - ws[0].t) / 1000;
    // Rycket ligger 12–35 min före korsningen; varningen ska komma efter det.
    expect(leadS).toBeGreaterThan(30);
    expect(leadS).toBeLessThanOrEqual(300);
  }, 90000);

  test.each([
    ['ryck-25m-vander.jsonl', '958100006', 'går 25 m norrut i 2,1 kn och vänder söderut'],
    ['ryck-35m-vander.jsonl', '958100007', 'går 35 m norrut i 2,5 kn och vänder söderut'],
    ['gasthamnen.jsonl', '956000006', 'köbelägg 330 m före och sedan in mot Gästhamnen'],
  ])('%s (%s: %s): ingen varning för Stridsbergsbron', (file, mmsi) => {
    const result = replay(file);
    expect(result.processErrors).toBe(0);
    expect(crossing(file, mmsi)).toBeNull();
    expect(warningsFor(result, mmsi)).toEqual([]);
  }, 90000);

  test('två båtar i kö, den främsta avgår först: var sitt kort, båda vid sin avgång', () => {
    const file = 'tva-i-ko.jsonl';
    const result = replay(file);
    expect(result.processErrors).toBe(0);
    const front = warningsFor(result, '956000010');
    const rear = warningsFor(result, '956000011');
    expect(front).toHaveLength(1);
    expect(rear).toHaveLength(1);
    expect(front[0].eventId).not.toBe(rear[0].eventId);
    for (const [w, mmsi] of [[front[0], '956000010'], [rear[0], '956000011']]) {
      const leadS = (crossing(file, mmsi) - w.t) / 1000;
      expect(leadS).toBeGreaterThan(30);
      expect(leadS).toBeLessThanOrEqual(300);
    }
  }, 90000);
});
