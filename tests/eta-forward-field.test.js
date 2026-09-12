'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const corpora = require('./replay-validation/corpora');
const { validateInvariants } = require('./replay-validation/invariants');

const ROOT = path.join(__dirname, '..');
const job = corpora.find((c) => c.id === '20260804-both-21h');
const EUGENIE = '265788210';
const ANTJE = '211347380';
const LAST_EUGENIE = Date.parse('2026-08-05T07:51:14.911Z');
const NEXT_EUGENIE = Date.parse('2026-08-05T08:11:32.565Z');
const FRESH_ANTJE = Date.parse('2026-08-05T08:00:23.558Z');
const MOVING_ANTJE = Date.parse('2026-08-05T08:07:02.144Z');
const OLD_TEXT = Date.parse('2026-08-05T08:00:30.040Z');
const NEW_TEXT = Date.parse('2026-08-05T08:01:30.040Z');
const MOVING_TEXT = MOVING_ANTJE + 25;
const RETIRED_JUMP = 'ETA-SÅGTAND UPP: 2026-08-05T08:01:30.040Z Stridsbergsbron 7→15 på 66s';

// Hela fältkedjan kör riktig app. Skrivskyddad avläsning av det verkliga
// textfiltret visar vilken båt som bar prognosen före/efter överlämningen.
// Ingen ETA, medlemslista, tid eller livscykel tillförs i produktvägen.
describe('Rättad ruttdistans: utgången ETA och verklig återkomst', () => {
  let directory;
  let result;
  let snapshots;
  let raw;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-eta-forward-field-'));
    const probe = path.join(directory, 'probe.cjs');
    const captured = path.join(directory, 'snapshots.json');
    fs.writeFileSync(probe, `
      const fs = require('fs');
      const VDS = require(process.cwd() + '/lib/services/VesselDataService');
      const original = VDS.prototype.getVesselsForBridgeText;
      const rows = [];
      VDS.prototype.getVesselsForBridgeText = function (...args) {
        const vessels = original.apply(this, args);
        const now = Date.now();
        if (now >= ${OLD_TEXT} && now <= ${MOVING_TEXT + 1}) {
          rows.push({ t: now, members: vessels.filter(v => v.targetBridge === 'Stridsbergsbron').map(v => ({
            mmsi: String(v.mmsi), eta: v.etaMinutes, timestamp: v.timestamp,
            fixTs: v.fixTs, fixFeed: v.fixFeed, lat: v.lat, lon: v.lon, sog: v.sog,
            extrapolated: v._etaIsExtrapolated === true,
          })) });
        }
        return vessels;
      };
      process.on('exit', () => fs.writeFileSync(process.env.ETA_FIELD_SNAPSHOTS, JSON.stringify(rows)));
    `);
    const output = execFileSync(process.execPath, [
      '--require', probe, path.join(ROOT, 'tests/replay-validation/replayRunner.js'), job.jsonl,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        ETA_FIELD_SNAPSHOTS: captured,
        REPLAY_MONITORING: '0',
        REPLAY_FUSION: '0',
        REPLAY_VERBOSE: '',
        REPLAY_DEBUG_LEVEL: 'off',
      },
    });
    result = JSON.parse(output.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    snapshots = JSON.parse(fs.readFileSync(captured, 'utf8'));
    raw = fs.readFileSync(job.jsonl, 'utf8').trim().split('\n').map(JSON.parse);
  }, 25000);

  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  test('råfixarna skiljer EUGENIEs tystnad från ANTJEs färska låg fart och senare rörelse', () => {
    const eugenie = raw.filter((r) => String(r.mmsi) === EUGENIE);
    const index = eugenie.findIndex((r) => r.aisTimestamp === LAST_EUGENIE);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(eugenie[index]).toMatchObject({
      lat: 58.28666, lon: 12.28599, sog: 1.6, fixTs: Date.parse('2026-08-05T07:51:03Z'),
    });
    expect(eugenie[index + 1].aisTimestamp).toBe(NEXT_EUGENIE);
    expect(NEW_TEXT - LAST_EUGENIE).toBeGreaterThan(10 * 60000);
    expect(OLD_TEXT - LAST_EUGENIE).toBeLessThan(10 * 60000);
    expect(raw.find((r) => String(r.mmsi) === ANTJE && r.aisTimestamp === FRESH_ANTJE))
      .toMatchObject({
        lat: 58.28796, lon: 12.2877, sog: 0.6, fixTs: Date.parse('2026-08-05T08:00:09Z'),
      });
    const lowSpeed = raw.filter((r) => String(r.mmsi) === ANTJE
      && r.aisTimestamp >= Date.parse('2026-08-05T07:52:21.554Z') && r.aisTimestamp < MOVING_ANTJE);
    expect(lowSpeed.map((r) => r.sog)).toEqual([0.9, 0.4, 0.6, 0.7]);
    // Den första lågfartspositionen hinner bli mer än fem minuter gammal
    // innan nästa fix. Ingen rörelsefix däremellan kan släppa spärren.
    expect(lowSpeed[1].aisTimestamp - lowSpeed[0].aisTimestamp).toBeGreaterThan(5 * 60000);
  });

  test('samma två båtar består när 7 blir okänd; ANTJE tar över först med färsk rörelse', () => {
    const before = snapshots.find((s) => s.t === OLD_TEXT);
    const after = snapshots.find((s) => s.t === NEW_TEXT);
    const moving = snapshots.find((s) => s.t === MOVING_TEXT);
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(moving).toBeDefined();
    const ids = (s) => s.members.map((v) => v.mmsi).sort();
    expect(ids(before)).toEqual([ANTJE, EUGENIE].sort());
    expect(ids(after)).toEqual(ids(before));
    expect(ids(moving)).toEqual(ids(before));
    const oldLead = before.members.find((v) => v.mmsi === EUGENIE);
    expect(Math.round(oldLead.eta)).toBe(7);
    expect(oldLead.extrapolated).toBe(true);
    expect(oldLead.timestamp).toBe(LAST_EUGENIE);
    const expired = after.members.find((v) => v.mmsi === EUGENIE);
    expect(expired.eta).toBeNull();
    expect(expired.timestamp).toBe(oldLead.timestamp);
    expect(expired.fixTs).toBe(oldLead.fixTs);
    const slow = after.members.find((v) => v.mmsi === ANTJE);
    expect(slow).toMatchObject({ eta: null, sog: 0.6, timestamp: FRESH_ANTJE });
    expect(before.members.find((v) => v.mmsi === ANTJE).eta).toBeNull();

    const resumed = moving.members.find((v) => v.mmsi === ANTJE);
    const rawMovement = raw.find((r) => String(r.mmsi) === ANTJE && r.aisTimestamp === MOVING_ANTJE);
    expect(rawMovement).toMatchObject({
      lat: 58.28845, lon: 12.28779, sog: 1.9, fixTs: Date.parse('2026-08-05T08:06:10Z'),
    });
    expect(resumed).toMatchObject({
      timestamp: MOVING_ANTJE,
      fixTs: rawMovement.fixTs,
      fixFeed: 'aishub',
      lat: rawMovement.lat,
      lon: rawMovement.lon,
      sog: rawMovement.sog,
      extrapolated: false,
    });
    expect(resumed.eta).toBeGreaterThan(0);
    expect(moving.members.find((v) => v.mmsi === EUGENIE).eta).toBeNull();
    expect(result.bridgeTextTransitions.find((r) => r.t === OLD_TEXT).text)
      .toContain('Två båtar på väg mot Stridsbergsbron, beräknad broöppning om cirka 7 minuter');
    expect(result.bridgeTextTransitions.find((r) => r.t === NEW_TEXT).text)
      .toContain('Två båtar på väg mot Stridsbergsbron, ETA okänd');
    expect(result.bridgeTextTransitions.find((r) => r.t === MOVING_TEXT).text)
      .toContain(`Två båtar på väg mot Stridsbergsbron, beräknad broöppning om ${Math.round(resumed.eta)} minuter`);
    expect(result.bridgeTextTransitions.filter((r) => r.t >= NEW_TEXT && r.t < MOVING_TEXT)
      .every((r) => r.text.includes('Två båtar på väg mot Stridsbergsbron, ETA okänd'))).toBe(true);
    expect(result.processErrors).toBe(0);
    expect(result.runtimeDiagnostics.timersAfterShutdown).toBe(0);
  });

  test('35 min AIS-gap ger en ny resa med sjunkande ETA och ingen ärvd passage', () => {
    const positions = [
      [0, 58.31256727791648, 12.323485518664773],
      [1, 58.31190361121652, 12.321868514185228],
      [2, 58.31123994451657, 12.320251509705683],
      [3, 58.310576277816615, 12.318634505226138],
      [4, 58.31027762780163, 12.317906853210342],
      [39, 58.309625022213346, 12.316316798805454],
      [40, 58.30893370273422, 12.314632419139262],
      [41, 58.30825344436677, 12.312974989547728],
      [42, 58.30757318599931, 12.311317559956194],
    ];
    const start = Date.parse('2026-01-05T08:00:00Z');
    const input = path.join(directory, 'gap35.jsonl');
    const rows = positions.map(([minutes, lat, lon]) => {
      const t = start + minutes * 60000;
      return {
        mmsi: '902003001',
        shipName: 'STÄDPROV',
        msgType: 'PositionReport',
        lat,
        lon,
        sog: 4,
        cog: 215,
        navStatus: null,
        feed: 'aisstream',
        fixTs: t,
        aisTimestamp: t,
        receivedAt: new Date(t).toISOString(),
      };
    });
    fs.writeFileSync(input, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const output = execFileSync(process.execPath, [
      path.join(ROOT, 'tests/replay-validation/replayRunner.js'), input,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env, REPLAY_MONITORING: '1', REPLAY_FUSION: '0', REPLAY_VERBOSE: '',
      },
    });
    const gap = JSON.parse(output.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
    const freshTexts = gap.bridgeTextTransitions.filter((r) => r.t >= start + 39 * 60000
      && r.t < start + 43 * 60000);
    expect(freshTexts.map((r) => r.text)).toEqual([18, 17, 16, 15].map((eta) => `En båt på väg mot Stridsbergsbron, beräknad broöppning om ${eta} minuter`));
    expect(gap.targetPassages).toEqual([]);
    expect(gap.intermediatePassages).toEqual([]);
    expect(gap.processErrors).toBe(0);
    expect(gap.runtimeDiagnostics.timersAfterShutdown).toBe(0);
  }, 25000);

  test('det pensionerade 7→15-undantaget kan inte dölja ett återinfört prognoshopp', () => {
    expect(validateInvariants(result)).toEqual([]);
    const known = job.knownInvariantExceptions || [];
    expect(known).not.toContain(RETIRED_JUMP);
    const returnedJump = {
      ...result,
      bridgeTextTransitions: [
        { t: NEW_TEXT - 66000, iso: new Date(NEW_TEXT - 66000).toISOString(), text: 'Två båtar på väg mot Stridsbergsbron, beräknad broöppning om cirka 7 minuter' },
        { t: NEW_TEXT, iso: new Date(NEW_TEXT).toISOString(), text: 'Två båtar på väg mot Stridsbergsbron, beräknad broöppning om 15 minuter' },
        ...result.bridgeTextTransitions.slice(-1),
      ],
    };
    expect(validateInvariants(returnedJump)).toContain(RETIRED_JUMP);
    const accepted = (message) => known.some((exception) => message.startsWith(exception));
    expect(accepted(RETIRED_JUMP)).toBe(false);
    expect(accepted(RETIRED_JUMP.replace('7→15', '7→16'))).toBe(false);
    expect(accepted(RETIRED_JUMP.replace('08:01:30.040', '08:01:30.041'))).toBe(false);
    expect(accepted(RETIRED_JUMP.replace('Stridsbergsbron', 'Klaffbron'))).toBe(false);
    expect(accepted(RETIRED_JUMP.replace('66s', '65s'))).toBe(false);
  });
});
