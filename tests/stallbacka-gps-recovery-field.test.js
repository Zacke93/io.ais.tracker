'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { BRIDGES } = require(path.join(ROOT, 'lib/constants'));
const BRIDGE = BRIDGES.stallbackabron;
const START = Date.parse('2026-01-05T08:00:00.000Z');

// Syntetiskt, fysiskt uttryckligt motprov till SOAK-RESA-20-fixen.
// Båten närmar sig brolinjen från en sida. En omöjlig 172 m-förflyttning
// på en sekund markeras av appens RIKTIGA GPS-analys som osäker. Därefter
// återkommer båten till samma ursprungssida och åker bort. Varken det
// osäkra fixet eller återhämtningsbenet får bli ett korsningsankare.
describe('Stallbacka: GPS-återhämtning är ingen passage', () => {
  let directory;
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-stallbacka-recovery-'));
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  function rowsFor(sign, gapMinutes = null) {
    const points = [
      [0, -500], [60, -380], [120, -260], [180, -140], [210, -86],
      [211, 86], [241, -32], [301, -157], [361, -280], [421, -403],
    ];
    const axis = (BRIDGE.axisBearing - 90) * Math.PI / 180;
    return points.map(([seconds, offset], i) => {
      const metres = offset * sign * (gapMinutes !== null && i >= 6 ? -1 : 1);
      const previousMetres = (points[i - 1]?.[1] ?? offset - 1) * sign;
      const t = gapMinutes !== null && i >= 6
        ? START + (210 + gapMinutes * 60 + (i - 6) * 60) * 1000
        : START + seconds * 1000;
      return {
        mmsi: '902003001',
        shipName: 'GPS-ÅTERHÄMTNING',
        msgType: 'PositionReport',
        lat: BRIDGE.lat + metres * Math.cos(axis) / 111320,
        lon: BRIDGE.lon + metres * Math.sin(axis) / (111320 * Math.cos(BRIDGE.lat * Math.PI / 180)),
        sog: 4,
        cog: metres < previousMetres ? 215 : 35,
        navStatus: null,
        feed: 'aisstream',
        fixTs: t,
        aisTimestamp: t,
        receivedAt: new Date(t).toISOString(),
      };
    });
  }

  function replay(name, rows) {
    const input = path.join(directory, `${name}.jsonl`);
    fs.writeFileSync(input, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const stdout = execFileSync(process.execPath, [path.join(ROOT, 'tests/replay-validation/replayRunner.js'), input], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        REPLAY_MONITORING: '1',
        REPLAY_FUSION: '0',
        REPLAY_DEBUG_LEVEL: 'off',
        REPLAY_VERBOSE: '',
      },
    });
    const result = JSON.parse(stdout.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    expect(result.processErrors).toBe(0);
    expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
    return result;
  }

  test.each([1, -1])('en osäker punkt får inte bli passagebevis på återvägen, sida %i', (sign) => {
    const result = replay(`recovery-${sign}`, rowsFor(sign));
    expect(result.intermediatePassages.filter((p) => p.bridge === BRIDGE.name)).toEqual([]);
    expect(result.targetPassages).toEqual([]);
  }, 25000);

  // Här ligger nästa rena punkt på ANDRA sidan. Sidbytet under gapet är
  // observerat, men dess klockslag är okänt. Den delade Status-vägen får
  // inte återuppliva ett äldre återhämtningsankare när VDS/GPS-kandidaten
  // redan avvisat det enligt sitt befintliga 20-minutersfönster.
  test.each([[1, 19, 1], [-1, 19, 1], [1, 21, 0], [-1, 21, 0]])(
    'återhämtning från sida %i efter %i min ger %i godtagna Stallbackapassager',
    (sign, minutes, expected) => {
      const result = replay(`gap-${sign}-${minutes}`, rowsFor(sign, minutes));
      expect(result.intermediatePassages.filter((p) => p.bridge === BRIDGE.name)).toHaveLength(expected);
    },
    25000,
  );

  // Ett redan rent sidbyte är bevisat före tystnaden. METHOD 1 bokför
  // först när den nya utgångsfixen bekräftar motsatt sida; tidsstämpeln är
  // bekräftelsetid, inte en uppskattning av råpassagen under inträdesbenet.
  // Vanlig 30-minutersutgång ska däremot kasta hela den gamla episoden.
  test.each([[21, 1], [31, 0]])(
    'rent skapat bevis efter %i min ger %i utgångsbekräftelser',
    (gapMinutes, expected) => {
      const points = [
        [0, -500], [60, -380], [120, -260], [180, -140], [210, -86],
        [270, 32], [270 + gapMinutes * 60, 157],
        [330 + gapMinutes * 60, 280],
      ];
      const axis = (BRIDGE.axisBearing - 90) * Math.PI / 180;
      const template = rowsFor(1)[0];
      const rows = points.map(([seconds, metres]) => {
        const t = START + seconds * 1000;
        return {
          ...template,
          lat: BRIDGE.lat + metres * Math.cos(axis) / 111320,
          lon: BRIDGE.lon + metres * Math.sin(axis)
            / (111320 * Math.cos(BRIDGE.lat * Math.PI / 180)),
          cog: 35,
          fixTs: t,
          aisTimestamp: t,
          receivedAt: new Date(t).toISOString(),
        };
      });
      const result = replay(`proven-entry-gap-${gapMinutes}`, rows);
      const passages = result.intermediatePassages.filter((p) => p.bridge === BRIDGE.name);
      expect(passages).toHaveLength(expected);
      if (expected) expect(passages[0].t).toBe(START + (270 + gapMinutes * 60) * 1000);
    },
    25000,
  );

  test('en verklig Järnvägskö med nya identiska fixar i 3 h får sedan passera', () => {
    const confirmed = Date.parse('2026-07-13T08:21:19.872Z');
    const raw = fs.readFileSync(path.join(ROOT, 'tests/replay-validation/corpora-data',
      'ais-replay-20260712-174434.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const base = raw.find((row) => String(row.mmsi) === '265761140' && row.aisTimestamp === confirmed);
    expect(base).toBeDefined();
    const rows = raw.filter((row) => row.aisTimestamp <= confirmed);
    for (let minutes = 5; minutes <= 180; minutes += 5) {
      const t = confirmed + minutes * 60000;
      rows.push({
        ...base, aisTimestamp: t, fixTs: t, receivedAt: new Date(t).toISOString(),
      });
    }
    const bridge = BRIDGES.jarnvagsbron;
    const axis = (bridge.axisBearing - 90) * Math.PI / 180;
    for (const [minutes, metres] of [[181, 32], [182, 157]]) {
      const t = confirmed + minutes * 60000;
      rows.push({
        ...base,
        lat: bridge.lat + metres * Math.cos(axis) / 111320,
        lon: bridge.lon + metres * Math.sin(axis) / (111320 * Math.cos(bridge.lat * Math.PI / 180)),
        sog: 4.5,
        cog: 35,
        aisTimestamp: t,
        fixTs: t,
        receivedAt: new Date(t).toISOString(),
      });
    }
    const result = replay('idun-fresh-identical-queue', rows);
    const finalWait = result.bridgeTextTransitions
      .filter((entry) => entry.t <= confirmed + 180 * 60000 + 30000).pop();
    expect(finalWait.text).toBe('En båt väntar vid Järnvägsbron på väg mot Stridsbergsbron');
    expect(result.intermediatePassages).toContainEqual({
      t: confirmed + 182 * 60000,
      iso: new Date(confirmed + 182 * 60000).toISOString(),
      mmsi: '265761140',
      bridge: 'Järnvägsbron',
      noTarget: false,
    });
  }, 25000);

});
