'use strict';

/**
 * Nattjaktens F04 med blandad källa (granskningen av N5, andra varvet).
 *
 * I fält levererar AISHub samma fix som AISStream, ofta 20–40 s senare. Utan
 * fusion (replayns förbikoppling) når ekot appen som en ny position ur
 * ordning: den ligger längre från bron än förra positionen, så kedjan mot
 * brolinjen bryts varje gång och återvändaren släpps aldrig (basens utfall).
 * Produktionens väg ('both', REPLAY_FUSION=1) går genom FixFusionPolicy, som
 * sorterar bort ett eko som inte är nyare än senast accepterade fix. Där ska
 * släppet fungera som med en källa.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  generateScenario, buildPath, pathMetrics, truthCrossings, BASE_TIME_MS,
} = require('./replay-validation/scenarioGenerator');

jest.setTimeout(120000);

const M = pathMetrics(buildPath());
const MMSI = '907400301';
const SCENARIO = {
  seed: 7403,
  vessels: [{
    mmsi: MMSI,
    name: 'RET6-FUSION',
    startS: M.cum[2] + 300,
    legs: [
      { toS: M.cum[5] + 150, speedKn: 9.5, intervalS: 30 },
      {
        toS: M.cum[5] + 300, speedKn: 8, intervalS: 30, lateralM: -50,
      },
      {
        toS: M.cum[5] + 430, speedKn: 4, intervalS: 30, lateralM: -110,
      },
      {
        stopS: 30, stopIntervalS: 30, stopSog: 1.4, stopCogDeg: 195, lateralM: -110,
      },
      {
        toS: M.cum[5] + 150, speedKn: 6, intervalS: 30, lateralM: -110,
      },
      { toS: M.cum[2] - 300, speedKn: 6, intervalS: 30 },
    ],
  }],
};

// Varje fix kommer från AISStream och 35 s senare som AISHub-eko av samma fix.
function withHubEcho(samples) {
  const out = [];
  for (const r of samples) {
    const t = r.aisTimestamp;
    out.push({ ...r, fixTs: t, feed: 'aisstream' });
    out.push({
      ...r,
      msgType: 'AISHubPosition',
      fixTs: t,
      feed: 'aishub',
      aisTimestamp: t + 35000,
      receivedAt: new Date(t + 35000).toISOString(),
    });
  }
  return out.sort((a, b) => a.aisTimestamp - b.aisTimestamp);
}

describe('F04: återvändaren med AISStream och AISHub-eko', () => {
  let directory;
  let samples;
  let southCrossingStridsberg;
  let southCrossingStallbacka;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-f04-fusion-'));
    const generated = generateScenario(SCENARIO);
    const truth = generated.truthPaths[MMSI];
    southCrossingStridsberg = BASE_TIME_MS + 1000 * truthCrossings(truth, M.cum[4])
      .filter((c) => c.dir === 'south')[0].tS;
    southCrossingStallbacka = BASE_TIME_MS + 1000 * truthCrossings(truth, M.cum[5])
      .filter((c) => c.dir === 'south')[0].tS;
    samples = withHubEcho(generated);
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  const replay = (fusion) => {
    const file = path.join(directory, `fusion-${fusion}.jsonl`);
    fs.writeFileSync(file, `${samples.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const output = execFileSync(process.execPath, [path.join(__dirname, 'replay-validation', 'replayRunner.js'), file], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env, REPLAY_FUSION: fusion, REPLAY_VERBOSE: '', REPLAY_MONITORING: '',
      },
    });
    const result = JSON.parse(output.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    expect(result.processErrors).toBe(0);
    return result;
  };
  const southWarning = (result) => result.openingWarnings
    .filter((w) => w.bridge === 'Stridsbergsbron' && w.direction === 'southbound')
    .sort((a, b) => a.t - b.t)[0];
  const southStallbackaNotice = (result) => result.notifications
    .filter((n) => n.bridge === 'Stallbackabron' && n.direction === 'southbound')
    .sort((a, b) => a.t - b.t)[0];

  test('med fusionen (produktionens väg) släpps hon: förvarning och varning i god tid', () => {
    const result = replay('1');
    const warning = southWarning(result);
    expect(warning).toBeDefined();
    expect(southCrossingStridsberg - warning.t).toBeGreaterThanOrEqual(180 * 1000);
    const notice = southStallbackaNotice(result);
    expect(notice).toBeDefined();
    expect(notice.alreadyPassed).toBe(false);
    expect(notice.t).toBeLessThan(southCrossingStallbacka);
  });

  test('utan fusionen bryter ekona kedjan: förvarningen kommer först efter korsningen, som i basen', () => {
    const result = replay('0');
    const notice = southStallbackaNotice(result);
    expect(notice).toBeDefined();
    expect(notice.t).toBeGreaterThan(southCrossingStallbacka);
  });
});
