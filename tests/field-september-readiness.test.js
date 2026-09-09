'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');

const input = path.join(__dirname, 'replay-validation/corpora-data/ais-replay-20260907-022832.jsonl');
const at = (iso) => Date.parse(`2026-09-07T${iso}Z`);
const lastText = (r, t) => r.bridgeTextTransitions.filter((e) => e.t <= t).at(-1)?.text;

describe('Septemberfältet: brotexter, faktisk kö och avstängd AIS genom hela appen', () => {
  let tmp;
  let field;
  let extended;
  const queueEnd = at('15:28:21.529');
  const lastSyntheticFix = queueEnd + 4 * 3600000;
  function replay(file, env = {}) {
    const stdout = execFileSync(process.execPath, [path.join(__dirname, 'replay-validation/replayRunner.js'), file], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 12 * 1024 * 1024,
      env: {
        ...process.env, REPLAY_MONITORING: '1', REPLAY_FUSION: '0', REPLAY_DEBUG_LEVEL: 'off', ...env,
      },
    });
    return JSON.parse(/__REPLAY_JSON__(.*)__END__/s.exec(stdout)[1]);
  }
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-september-'));
    field = replay(input);
    // Oförändrat verkligt förlopp fram till ELFKUNGENs tredje stoppfix.
    // Därefter uttryckligen SYNTETISKT: samma läge, nya fix var tredje minut.
    const rows = fs.readFileSync(input, 'utf8').trim().split('\n').map(JSON.parse)
      .filter((s) => s.aisTimestamp <= queueEnd);
    const stopped = rows.filter((s) => String(s.mmsi) === '265573130').at(-1);
    expect(stopped.sog).toBeLessThan(0.3);
    for (let t = queueEnd + 3 * 60000; t <= lastSyntheticFix; t += 3 * 60000) {
      rows.push({
        ...stopped, aisTimestamp: t, fixTs: t, receivedAt: new Date(t).toISOString(),
      });
    }
    const longInput = path.join(tmp, 'overlapping-queue.jsonl');
    fs.writeFileSync(longInput, rows.map(JSON.stringify).join('\n'));
    extended = replay(longInput);
  }, 65000);
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('alla fyra resor notifierar alla sex punkter en gång i rätt riktning', () => {
    const { eventFacitFailures } = require('./replay-validation/eventFacit');
    expect(eventFacitFailures(field, require('./replay-validation/golden-events/20260907-31h.json'))).toEqual([]);
    expect(field.notifications).toHaveLength(24);
    for (const [mmsi, direction] of [
      ['275491000', 'southbound'], ['265573130', 'northbound'],
      ['265573130', 'southbound'], ['265031670', 'northbound'],
    ]) {
      expect(field.notifications.filter((n) => n.mmsi === mmsi && n.direction === direction)
        .map((n) => n.bridge).sort()).toEqual([
        'Kanalinfarten', 'Olidebron', 'Klaffbron', 'Järnvägsbron', 'Stridsbergsbron', 'Stallbackabron',
      ].sort());
    }
  });

  test('båtarna under gång får inga falska väntnotiser', () => {
    expect(field.notifications.filter((n) => /inväntar/.test(n.message))).toHaveLength(0);
    expect(field.notifications.every((n) => n.success)).toBe(true);
  });

  test('ELFKUNGEN väntar vid bron framför henne och OLA får ingen gissad minutprognos', () => {
    expect(lastText(field, at('15:28:25'))).toBe('En båt väntar vid Järnvägsbron på väg mot Klaffbron');
    for (const time of ['18:39:00', '18:43:00', '18:48:00']) {
      expect(lastText(field, at(time))).toBe('En båt väntar vid Järnvägsbron på väg mot Stridsbergsbron');
    }
    expect(lastText(field, at('18:50:15'))).not.toContain('väntar');
  });

  test('färsk kö framför Järnvägsbron ligger kvar fyra timmar trots passerad Stridsbergsbro bakom', () => {
    for (const hours of [1, 2, 3, 4]) {
      expect(lastText(extended, queueEnd + hours * 3600000))
        .toBe('En båt väntar vid Järnvägsbron på väg mot Klaffbron');
    }
    expect(extended.targetPassages.filter((p) => p.mmsi === '265573130' && p.bridge === 'Klaffbron'
      && p.t > queueEnd)).toHaveLength(0);
  });

  test('samma långa kö försvinner när nya AIS-positioner upphör', () => {
    expect(extended.bridgeTextTransitions.at(-1).text).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    expect(extended.bridgeTextTransitions.at(-1).t - lastSyntheticFix).toBeLessThanOrEqual(31 * 60000);
    expect(extended.leakDiagnostics.vessels).toBe(0);
  });

  test('samma ankomst ger åtta öppningsvarningar; ELFKUNGENs långa AIS-glapp ger ingen dubblett', () => {
    expect(field.openingWarnings).toHaveLength(8);
    expect(field.openingWarnings.filter((w) => w.bridge === 'Stridsbergsbron'
      && w.mmsis.includes('265573130') && w.direction === 'northbound')).toHaveLength(1);
  });

  test('terminal passage tar bort brotexten direkt, utan efterhängande strax', () => {
    const terminalPassages = [1, 3, 5, 7].map((i) => field.targetPassages[i]);
    expect(terminalPassages).toHaveLength(4);
    for (const p of terminalPassages) {
      expect(lastText(field, p.t + 1000)).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    }
    expect(field.targetPassages).toHaveLength(8);
  });

  test('ordinarie stale-borttagning och ren avstängning består', () => {
    expect(lastText(field, at('13:00:00'))).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    for (const r of [field, extended]) {
      expect(r.processErrors).toBe(0);
      expect(r.runtimeDiagnostics.shutdownErrors).toBe(0);
      expect(r.runtimeDiagnostics.timersAfterShutdown).toBe(0);
    }
  });
});
