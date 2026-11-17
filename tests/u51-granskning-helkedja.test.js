'use strict';

/**
 * U51, granskningen av D6 (2026-11-17): tre byggda fall genom hela appen.
 *  - H1: en förtöjd båt som släpps på en fix förbi Kanalinfartens linje ska få
 *    passerad form ("har passerat Kanalinfarten"), aldrig "närmar sig … om N
 *    minuter". Lotskajen ligger inom formregelns latitudmarginal, så utan
 *    avgångsbeviset gav notisvägen förvarningsform för en båt 135 m in i kanalen.
 *  - M2: en förhalning i sidled som slutar 48 m före linjen men 114 m från
 *    punkten ger ingen ny notis. (Ett GPS-hopp från kajen till 30 m före linjen
 *    i 2,5 kn efter en fix i 0,6 kn ger fortfarande en falsk notis; känd gräns,
 *    0 av 18 050 kajfixar i data, se docs/ARCHITECTURE.md.)
 * Fixturerna beskrivs i tests/replay-validation/fixtures/README.md.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const FIX = path.join(__dirname, 'replay-validation/fixtures');

function replay(file) {
  const stdout = execFileSync(process.execPath, [
    path.join(__dirname, 'replay-validation/replayRunner.js'), path.join(FIX, file),
  ], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env, REPLAY_MONITORING: '', REPLAY_FUSION: '0', REPLAY_VERBOSE: '', REPLAY_DEBUG_LEVEL: 'off',
    },
  });
  const match = /__REPLAY_JSON__(.*)__END__/s.exec(stdout);
  expect(match).not.toBeNull();
  return JSON.parse(match[1]);
}
const kanal = (r) => r.notifications.filter((n) => n.bridge === 'Kanalinfarten').sort((a, b) => a.t - b.t);

describe('U51 genom hela appen (granskningen av D6)', () => {
  test('H1: avgång från lotskajen med 60 s fixtakt, första fixen i bandet 135 m in i kanalen: passerad form', () => {
    const notices = kanal(replay('u51-lotskaj-avgang-60s.jsonl'));
    expect(notices).toHaveLength(2);
    expect(notices[1].direction).toBe('northbound');
    expect(notices[1].message).toBe('TESTLOTS har passerat Kanalinfarten');
    expect(notices[1].alreadyPassed).toBe(true);
    expect(notices[1].eta).toBe(-1);
  }, 30000);

  test('M2: förhalning i sidled till 48 m före linjen men 114 m från punkten: ingen ny notis', () => {
    expect(kanal(replay('u51-forhalning-i-sidled.jsonl'))).toHaveLength(1);
  }, 30000);
});
