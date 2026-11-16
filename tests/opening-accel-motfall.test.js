'use strict';

/**
 * MOTFALLEN TILL FARTÖKNINGSREGELN (sparr, 2026-11-16; granskningen SPARR-d2,
 * H1 och punkt 4). Granskarens scenarier (S/granskning-SPARR-d2/scen, egna
 * positioner) som permanenta fixturer i tests/fixtures/sparr-motfall/.
 *
 * Den första versionen av regeln räknade ett ensamt fix ur stillhet som avgång
 * och varnade 10–20 min för tidigt när en båt ryckte fram i en kö före
 * Järnvägsbron. Avgångsgrenen är borttagen; regeln kräver ökning i gång (två
 * föregående fix i minst 1 kn). Fixturerna låser utfallet:
 *  - krypkö 350 m före Järnvägsbron (AISHub 65 s i tre faser, klass B 180/30 s,
 *    klass A 10 s) och krypkö 250 m före: varningen högst 300 s före korsningen
 *    (basen 8c60237: 92–175 s; första versionen 547–1 241 s);
 *  - fartbrus hos en stillastående båt (0,2 → 1,6 → 0,3 kn, med och utan
 *    positionsbrus): högst 300 s (basen 173–181 s; första versionen 1 067–1 110 s);
 *  - NICOLINE (20260712-25h, oförändrade fix 0,9 → 1,9 kn 358 m före bron och
 *    sedan kö, med syntetisk historia förbi Klaffbron): högst 300 s (basen 255 s;
 *    första versionen 846 s);
 *  - ett ryck följt av vändning söderut: ingen varning för Stridsbergsbron
 *    (första versionen gav ett falsklarm);
 *  - KÄND KOSTNAD: ökning i gång 2 → 3 → 3,5 kn och sedan kö 10 min 150 m före
 *    Järnvägsbron. Den går inte att skilja från LIDAN-formen i ögonblicket, och
 *    varningen kommer 907 s före korsningen (basen 105 s). Ledtiden låses till
 *    850–960 s så att en ändring syns åt båda hållen;
 *  - LIDAN-formen: minst 150 s (basen 102 s).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BRIDGES } = require('../lib/constants');

const DIR = path.join(__dirname, 'fixtures', 'sparr-motfall');
const SB = BRIDGES.stridsbergsbron;

function replay(file) {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'replay-validation/replayRunner.js'), path.join(DIR, file)], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env, REPLAY_MONITORING: '0', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
    },
  });
  return JSON.parse(out.match(/__REPLAY_JSON__([\s\S]*?)__END__/)[1]);
}

// Sann korsning ur fixturens rader: linjär mellan sista fix söder och första norr om linjen.
function crossing(file, mmsi) {
  const rows = fs.readFileSync(path.join(DIR, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((r) => String(r.mmsi) === mmsi && Number.isFinite(r.lat))
    .sort((a, b) => a.aisTimestamp - b.aisTimestamp);
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (a.lat < SB.lat && b.lat >= SB.lat) {
      const ta = a.fixTs || a.aisTimestamp;
      const tb = b.fixTs || b.aisTimestamp;
      return ta + ((SB.lat - a.lat) / (b.lat - a.lat)) * (tb - ta);
    }
  }
  return null;
}

const firstMmsi = (file) => String(JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8').split('\n')[0]).mmsi);

const QUEUE = [
  'krypko-350-aishub65.jsonl',
  'krypko-350-aishub65-start20.jsonl',
  'krypko-350-aishub65-start40.jsonl',
  'krypko-350-klassB-180-30.jsonl',
  'krypko-350-klassA-10.jsonl',
  'krypko-250-aishub65.jsonl',
  'brus-stilla-300-utanpos.jsonl',
  'brus-stilla-300-pos15.jsonl',
  'brus-stilla-380-pos50.jsonl',
  'nicoline-historia.jsonl',
];

describe('fartökningsregelns motfall (granskningen SPARR-d2)', () => {
  test.each(QUEUE)('%s: ingen varning för Stridsbergsbron mer än 300 s före korsningen', (file) => {
    const mmsi = firstMmsi(file);
    const result = replay(file);
    const tc = crossing(file, mmsi);
    expect(tc).not.toBeNull();
    const warnings = result.openingWarnings.filter((w) => w.bridge === 'Stridsbergsbron' && w.mmsis.includes(mmsi) && w.t < tc);
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) expect(tc - w.t).toBeLessThanOrEqual(300000);
    expect(result.processErrors).toBe(0);
  }, 90000);

  test('vander-efter-kryp: ett ryck och vändning söderut ger ingen varning för Stridsbergsbron', () => {
    const file = 'vander-efter-kryp.jsonl';
    const mmsi = firstMmsi(file);
    const result = replay(file);
    expect(result.openingWarnings.filter((w) => w.bridge === 'Stridsbergsbron' && w.mmsis.includes(mmsi))).toEqual([]);
  }, 90000);

  test('KÄND KOSTNAD okning-sedan-ko-150: ökning i gång och sedan kö varnas 850–960 s före korsningen', () => {
    const file = 'okning-sedan-ko-150.jsonl';
    const mmsi = firstMmsi(file);
    const result = replay(file);
    const tc = crossing(file, mmsi);
    const [w] = result.openingWarnings.filter((x) => x.bridge === 'Stridsbergsbron' && x.mmsis.includes(mmsi));
    expect(tc - w.t).toBeGreaterThanOrEqual(850000);
    expect(tc - w.t).toBeLessThanOrEqual(960000);
  }, 90000);

  test('lidan-form-utan-dubblett: minst 150 s före korsningen', () => {
    const file = 'lidan-form-utan-dubblett.jsonl';
    const mmsi = firstMmsi(file);
    const result = replay(file);
    const tc = crossing(file, mmsi);
    const [w] = result.openingWarnings.filter((x) => x.bridge === 'Stridsbergsbron' && x.mmsis.includes(mmsi));
    expect(tc - w.t).toBeGreaterThanOrEqual(150000);
  }, 90000);
});
