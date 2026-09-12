'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const corpora = require('./replay-validation/corpora');
const rawPassages = require('./replay-validation/gt-passages/20260823-24h.json');

const INPUT = path.join(__dirname, 'replay-validation/corpora-data/ais-replay-20260823-185834.jsonl');
const unique = (keys) => [...new Set(keys)].sort();
const notificationKey = (n) => `${n.mmsi}|${n.bridge}|${n.direction}`;

// Korpusen är låst i text, öppningar och fulla händelser. Kontrakten bygger på
// råa passager och användarens beslut om en notis per Kanalinfartsbesök.
describe('Fältdygn 23–24 augusti: rådatabelagd täckning genom hela appen', () => {
  let replay;

  beforeAll(() => {
    expect(corpora.find((c) => c.id === '20260823-24h').jsonl).toBe(INPUT);
    const stdout = execFileSync(process.execPath, [
      path.join(__dirname, 'replay-validation/replayRunner.js'), INPUT,
    ], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env, REPLAY_MONITORING: '1', REPLAY_FUSION: '0', REPLAY_VERBOSE: '', REPLAY_DEBUG_LEVEL: 'off',
      },
    });
    const match = /__REPLAY_JSON__(.*)__END__/s.exec(stdout);
    expect(match).not.toBeNull();
    replay = JSON.parse(match[1]);
  }, 20000);

  test('repots 920 AIS-poster behandlas med monitoring och ren avstängning', () => {
    expect(replay.sampleCount).toBe(920);
    expect(replay.processErrors).toBe(0);
    expect(replay.runtimeDiagnostics).toMatchObject({
      monitoringEnabled: true, monitoringStarts: 1, shutdownErrors: 0, timersAfterShutdown: 0,
    });
    expect(replay.runtimeDiagnostics.staleSweeps).toBeGreaterThan(0);
    expect(replay.leakDiagnostics.vessels).toBe(0);
    expect(replay.notifications.every((n) => n.success === true)).toBe(true);
  });

  test('alla 23 unika notisnycklar motsvarar oberoende brolinjekorsningar och zonbesök', () => {
    expect(rawPassages).toHaveLength(23);
    for (const passage of rawPassages) {
      expect(['line', 'zone']).toContain(passage.kind);
    }
    const passageKey = (p) => `${p.mmsi}|${p.bridge}`;
    const expected = unique(rawPassages.map(passageKey));
    expect(expected).toHaveLength(23);
    expect(replay.notifications).toHaveLength(23);
    expect(unique(replay.notifications.map(passageKey))).toEqual(expected);
  });

  test('alla 23 unika notisnycklar har rådatabelagd färdriktning', () => {
    // TANGELAs första zonkontakt saknar föregående segment i GT (dir:null).
    // Råfixen 08:20:59: 3,7 kn/43,9°, följd av stigande latitud
    // 58.26675 → 58.26716 → 58.26763, belägger ändå nordlig färd.
    const directions = {
      211231860: 'southbound', // FREIHEIT
      276015380: 'southbound', // PHOENIX
      265070060: 'northbound', // TANGELA
      230693000: 'northbound', // PRIMA LADY
      265576710: 'northbound', // DIANA
    };
    const expected = rawPassages.map((p) => notificationKey({ ...p, direction: directions[p.mmsi] }));
    expect(unique(replay.notifications.map(notificationKey))).toEqual(unique(expected));
  });

  test('samtliga sex målpassager bokförs exakt en gång på rätt fartyg och bro', () => {
    expect(replay.targetPassages.map((p) => `${p.mmsi}|${p.bridge}`).sort()).toEqual([
      '265070060|Klaffbron', '265070060|Stridsbergsbron',
      '276015380|Stridsbergsbron', '276015380|Klaffbron',
      '230693000|Klaffbron', '230693000|Stridsbergsbron',
    ].sort());
  });

  test('DIANAs 2,5 timmar långa hamnstopp ger en Kanalinfarten-notis för samma besök', () => {
    const notices = replay.notifications.filter((n) => n.mmsi === '265576710' && n.bridge === 'Kanalinfarten');
    expect(notices).toHaveLength(1);
    expect(notices[0].direction).toBe('northbound');
  });

  test('PHOENIX åldras vid samma tid i båda startfaser, utan fasundantag', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-phoenix-phase-'));
    try {
      const { readCorpus, writePhaseVariant } = require('./replay-validation/runPhaseSweep');
      const file = path.join(tmp, 'phase.jsonl');
      writePhaseVariant(readCorpus(INPUT), -20000, file);
      const stdout = execFileSync(process.execPath, [path.join(__dirname, 'replay-validation/replayRunner.js'), file], {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env, REPLAY_MONITORING: '1', REPLAY_FUSION: '0', REPLAY_DEBUG_LEVEL: 'off',
        },
      });
      const variant = JSON.parse(/__REPLAY_JSON__(.*)__END__/s.exec(stdout)[1]);
      const unknown = 'En båt på väg mot Stridsbergsbron, ETA okänd';
      const extras = variant.bridgeTextTransitions.filter((e) => e.text === unknown);
      expect(extras).toHaveLength(3);
      expect(replay.bridgeTextTransitions.filter((e) => e.text === unknown)).toHaveLength(3);
      // Bara den första inittextens tid följer den flyttade appstarten.
      expect(variant.bridgeTextTransitions.slice(1)).toEqual(replay.bridgeTextTransitions.slice(1));
      const first = extras[0];
      const rows = fs.readFileSync(INPUT, 'utf8').trim().split('\n').map(JSON.parse)
        .filter((r) => r.mmsi === '276015380');
      const before = rows.filter((r) => r.aisTimestamp <= first.t).at(-1);
      const after = rows.find((r) => r.aisTimestamp > first.t);
      expect(first.t - before.aisTimestamp).toBeGreaterThan(10 * 60000);
      expect(after.aisTimestamp - first.t).toBeLessThan(10000);
      const next = variant.bridgeTextTransitions[variant.bridgeTextTransitions.indexOf(first) + 1];
      expect(next.text).toBe('En båt på väg mot Stridsbergsbron, beräknad broöppning strax');
      expect(next.t - first.t).toBeLessThanOrEqual(30000);
      expect(variant.notifications).toEqual(replay.notifications);
      expect(variant.targetPassages).toEqual(replay.targetPassages);
      expect(variant.openingWarnings).toEqual(replay.openingWarnings);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test.each([
    ['265070060', 'Olidebron'], ['265070060', 'Klaffbron'],
    ['276015380', 'Stridsbergsbron'], ['276015380', 'Klaffbron'], ['276015380', 'Olidebron'],
    ['230693000', 'Olidebron'], ['265576710', 'Olidebron'],
  ])('%s vid %s meddelar närmande under gång i närzonen', (mmsi, bridge) => {
    const notices = replay.notifications.filter((n) => n.mmsi === mmsi && n.bridge === bridge);
    expect(notices.length).toBeGreaterThan(0);
    for (const notice of notices) {
      expect(notice.eta).toBeGreaterThanOrEqual(0);
      expect(notice.alreadyPassed).toBe(false);
      expect(notice.message).toContain(`närmar sig ${bridge}`);
      expect(notice.message).not.toContain('inväntar');
    }
  });
});
