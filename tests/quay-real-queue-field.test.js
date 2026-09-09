'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const replayDir = path.join(ROOT, 'tests/replay-validation');
const IDUN = '265761140';
const KNIGHT = '265025880';
const IDUN_CONFIRMED = Date.parse('2026-07-13T08:21:19.872Z');
const IDUN_PASSAGE = Date.parse('2026-07-13T08:28:53.460Z');
const KNIGHT_CONFIRMED = Date.parse('2026-07-12T08:23:01.404Z');
const WAIT_TEXT = 'En båt väntar vid Järnvägsbron på väg mot Stridsbergsbron';
const DEFAULT_TEXT = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';

// Råfältkedjorna är oförändrade fram till faktisk ankomst/bekräftelse.
// Bara de uttryckligt syntetiska fortsättningarna lägger till färska AIS-fixar.
// KNIGHTs råa upptakt innehåller en riktig intern timeout/återfödelse före kön.
// Vi tillför inga mål-, rörelse- eller köbevis för hand.
describe('Kajmotbevis får inte dölja verklig ankomst eller lång brokö', () => {
  let directory;
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-quay-queue-'));
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  function readRaw(file) {
    return fs.readFileSync(path.join(replayDir, 'corpora-data', file), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
  }
  function replay(name, rows) {
    const input = path.join(directory, `${name}.jsonl`);
    fs.writeFileSync(input, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const output = execFileSync(process.execPath, [path.join(replayDir, 'replayRunner.js'), input], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        REPLAY_MONITORING: '1',
        REPLAY_FUSION: '0',
        REPLAY_VERBOSE: '',
        REPLAY_DEBUG_LEVEL: 'off',
      },
    });
    const result = JSON.parse(output.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    expect(result.processErrors).toBe(0);
    expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
    return result;
  }
  function textAt(result, t) {
    const eligible = result.bridgeTextTransitions.filter((entry) => entry.t <= t);
    return eligible[eligible.length - 1]?.text;
  }

  test('IDUNs nollfix efter verklig ankomst är ingen redan belagd kajvistelse', () => {
    const raw = readRaw('ais-replay-20260712-174434.jsonl');
    const result = replay('idun-raw', raw);
    // Källrader 489 → 522 → 536 → 546: 1 256 m nordlig ankomst,
    // 3,6 m stillhetsjitter vid Järnvägsbron, därefter faktisk passage.
    // Att behålla enbart närnotisen hade missat att båten saknades i texten.
    // Den separata rörliga gruppens ledare 265806230 går söderut i 6,7 kn
    // efter Stallbacka: rättad framåtrutt ger 8 min, den gamla omvägen 13.
    expect(result.bridgeTextTransitions).toContainEqual({
      t: IDUN_CONFIRMED + 25,
      iso: new Date(IDUN_CONFIRMED + 25).toISOString(),
      text: 'Tre båtar väntar vid Järnvägsbron på väg mot Stridsbergsbron; '
        + 'Två båtar på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter',
    });
    expect(result.targetPassages).toContainEqual({
      t: IDUN_PASSAGE,
      iso: new Date(IDUN_PASSAGE).toISOString(),
      mmsi: IDUN,
      bridge: 'Stridsbergsbron',
    });
    expect(result.notifications.some((n) => n.mmsi === IDUN && n.bridge === 'Järnvägsbron')).toBe(true);
  }, 25000);

  test('IDUNs positionsbelagda ankomst efter långt AIS-gap bevarar kön över 3 h', () => {
    const raw = readRaw('ais-replay-20260712-174434.jsonl');
    const base = raw.find((row) => String(row.mmsi) === IDUN && row.aisTimestamp === IDUN_CONFIRMED);
    const rows = raw.filter((row) => row.aisTimestamp <= IDUN_CONFIRMED);
    for (let minutes = 5; minutes <= 180; minutes += 5) {
      const t = IDUN_CONFIRMED + minutes * 60000;
      rows.push({ ...base, aisTimestamp: t, receivedAt: new Date(t).toISOString() });
    }
    const result = replay('idun-long-gap-wait', rows);
    const lastFix = IDUN_CONFIRMED + 180 * 60000;
    // Övriga verkliga båtar åldras ut medan IDUN fortsätter rapportera.
    // Även efter den gamla tvåtimmarsgränsen måste JUST hennes kö återstå.
    expect(textAt(result, IDUN_CONFIRMED + 140 * 60000)).toBe(WAIT_TEXT);
    expect(textAt(result, lastFix + 30000)).toBe(WAIT_TEXT);
    const waitingTail = result.bridgeTextTransitions.filter((entry) => entry.t >= IDUN_CONFIRMED + 30 * 60000
      && entry.t <= lastFix + 30000);
    for (const entry of waitingTail) expect(entry.text).toBe(WAIT_TEXT);
    // Efter sista nya fixen gäller samma utgång som för andra AIS-tysta båtar.
    const end = result.bridgeTextTransitions[result.bridgeTextTransitions.length - 1];
    expect(end.text).toBe(DEFAULT_TEXT);
    expect(end.t).toBeGreaterThan(lastFix);
    expect(end.t - lastFix).toBeLessThanOrEqual(31 * 60000);
  }, 25000);

  test.each([5, 25])('bekräftad kö består över 3 h med nya positionsfixar var %i minut', (intervalMin) => {
    const raw = readRaw('ais-replay-20260711-232958.jsonl');
    const base = raw.find((row) => String(row.mmsi) === KNIGHT && row.aisTimestamp === KNIGHT_CONFIRMED);
    expect(base).toBeDefined();
    const rows = raw.filter((row) => row.aisTimestamp <= KNIGHT_CONFIRMED);
    const lastMinutes = Math.ceil(180 / intervalMin) * intervalMin;
    for (let minutes = intervalMin; minutes <= lastMinutes; minutes += intervalMin) {
      const t = KNIGHT_CONFIRMED + minutes * 60000;
      rows.push({ ...base, aisTimestamp: t, receivedAt: new Date(t).toISOString() });
    }
    const lastFix = KNIGHT_CONFIRMED + lastMinutes * 60000;
    const result = replay(`knight-${intervalMin}`, rows);
    expect(textAt(result, KNIGHT_CONFIRMED + 1000)).toBe(WAIT_TEXT);
    // Glesa rapporter får åldra väntstatus till ETA okänd mellan fixarna,
    // men aldrig dölja hela båten eller fabricera en minutprognos.
    const during = result.bridgeTextTransitions.filter((entry) => entry.t >= KNIGHT_CONFIRMED && entry.t <= lastFix);
    expect(during.length).toBeGreaterThan(0);
    for (const entry of during) {
      expect(entry.text).toMatch(/väntar vid Järnvägsbron|på väg mot Stridsbergsbron, ETA okänd/);
      expect(entry.text).not.toMatch(/\d+ minuter?/);
    }
    expect(textAt(result, lastFix + 30000)).toBe(WAIT_TEXT);
    expect(result.openingWarnings.filter((w) => w.mmsis.includes(KNIGHT))).toHaveLength(1);
    // När de syntetiska positionsrapporterna upphör ska vanlig åldersutgång
    // fortfarande ta bort båten. Inget 2h-platsminne får återuppliva texten.
    const end = result.bridgeTextTransitions[result.bridgeTextTransitions.length - 1];
    expect(end.text).toBe(DEFAULT_TEXT);
    expect(end.t).toBeGreaterThan(lastFix);
    expect(end.t - lastFix).toBeLessThanOrEqual(31 * 60000);
  }, 25000);
});
