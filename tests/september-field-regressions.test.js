'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildFacit } = require('./replay-validation/makeGtPassages');

const file = path.join(__dirname, 'replay-validation/corpora-data/ais-replay-20260909-073207.jsonl');
const time = (value) => Date.parse(value);
let replay;
beforeAll(() => {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'replay-validation/replayRunner.js'), file], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env, REPLAY_MONITORING: '1', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
    },
  });
  replay = JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
}, 30000);

test('TINY får Stridsbergsvarningen när kön lämnas, inte före Klaffbron', () => {
  const warnings = replay.openingWarnings.filter((w) => w.bridge === 'Stridsbergsbron' && w.mmsis.includes('265679440'));
  expect(warnings).toHaveLength(1);
  expect(warnings[0].t).toBeGreaterThanOrEqual(time('2026-09-10T16:34:00Z'));
  expect(warnings[0].t).toBeLessThan(time('2026-09-10T16:36:21Z'));
});
test('ELFKUNGEN får en närnotis för vardera passagen av Stallbackabron', () => {
  const notices = replay.notifications.filter((n) => n.mmsi === '265573130' && n.bridge === 'Stallbackabron');
  expect(notices).toHaveLength(2);
  expect(notices[1].t).toBeGreaterThanOrEqual(time('2026-09-10T17:55:00Z'));
  expect(notices[1].t).toBeLessThan(time('2026-09-10T17:56:28Z'));
});
test('EMBLAs observerade hamnstopp blockerar inte öppningsvarningen efter avgång nästa dag', () => {
  const warnings = replay.openingWarnings.filter((w) => w.bridge === 'Klaffbron' && w.mmsis.includes('265566930'));
  expect(warnings).toHaveLength(2);
  expect(warnings[0].t).toBeGreaterThan(time('2026-09-11T16:52:00Z'));
  expect(warnings[1].t).toBeGreaterThanOrEqual(time('2026-09-12T08:20:00Z'));
  expect(warnings[1].t).toBeLessThan(time('2026-09-12T08:22:51Z'));
});
test('gamla positioner före Järnvägsbron uppgraderas inte till strax', () => {
  const texts = replay.bridgeTextTransitions.filter((x) => x.t >= time('2026-09-10T16:25:00Z')
    && x.t < time('2026-09-10T16:29:20Z'));
  expect(texts.every((x) => !x.text.includes('strax'))).toBe(true);
});
test('hela körningen behandlas och städas utan fel', () => {
  expect(replay.sampleCount).toBe(fs.readFileSync(file, 'utf8').trim().split('\n').length);
  expect(replay.processErrors).toBe(0);
  expect(replay.runtimeDiagnostics.timersAfterShutdown).toBe(0);
});
test('rådatafacit behåller Järnvägspassagen vid källbyte med leveranslagg', () => {
  const facit = buildFacit(file);
  const crossings = Array.isArray(facit) ? facit : facit.passages;
  expect(crossings.filter((p) => p.bridge === 'Järnvägsbron')).toHaveLength(4);
});
