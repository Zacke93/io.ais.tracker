'use strict';

/**
 * U71 (omgång 9): fångstjournalen i lib/utils/CaptureJournal.js.
 * Numrering, omsändning efter 2 och 10 min, tak med räknare, och att inget fel
 * i loggvägen kastar in i appen eller ger fler loggförsök (U58).
 */

const {
  CaptureJournal, RESEND_AFTER_MS, MAX_ENTRIES,
} = require('../lib/utils/CaptureJournal');

const MIN = 60 * 1000;

function makeJournal(extra = {}) {
  const lines = [];
  const clock = { t: Date.UTC(2026, 10, 25, 20, 0, 0) };
  const journal = new CaptureJournal({
    log: (l) => lines.push(['log', l]),
    error: (l) => lines.push(['err', l]),
    now: () => clock.t,
    bootMs: clock.t,
    epoch: 1,
    ...extra,
  });
  return { journal, lines, clock };
}

const resends = (lines) => lines.filter(([, l]) => String(l).startsWith('[CAPTURE_RESEND] '))
  .map(([, l]) => JSON.parse(l.slice('[CAPTURE_RESEND] '.length)));

describe('U71 CaptureJournal: numrering och omsändning', () => {
  test('post 1 är starten, originalen bär #sid:nr före meddelandet', () => {
    const { journal, lines, clock } = makeJournal();
    journal.start('boot');
    journal.record('[AIS_REPLAY_SAMPLE] {"mmsi":"1"}');
    journal.record('❌ [FLOW_TRIGGER_ERROR] x', 'err');
    const sid = `${clock.t.toString(36)}-1`;
    expect(journal.sid).toBe(sid);
    expect(lines).toEqual([
      ['log', `#${sid}:1 [CAPTURE_START] sid=${sid} reason=boot`],
      ['log', `#${sid}:2 [AIS_REPLAY_SAMPLE] {"mmsi":"1"}`],
      ['err', `#${sid}:3 ❌ [FLOW_TRIGGER_ERROR] x`],
    ]);
  });

  test('omsändning vid 2 och 10 minuters ålder, sedan släpps posten; kontrollpunkt varje slag', () => {
    const { journal, lines, clock } = makeJournal();
    journal.start('boot');
    journal.record('A');
    expect(RESEND_AFTER_MS).toEqual([2 * MIN, 10 * MIN]);
    const seen = [];
    for (let m = 1; m <= 12; m += 1) {
      clock.t += MIN;
      const before = lines.length;
      journal.tick();
      seen.push(resends(lines.slice(before)).map((r) => r.seq));
      expect(lines[lines.length - 1][1]).toMatch(/^\[CAPTURE_SEQ\] sid=\S+ seq=2 buffered=\d+ dropped=0 errors=0$/);
    }
    // minut 2: första omsändningen, minut 10: den sista; inget annat.
    expect(seen).toEqual([[], [1, 2], [], [], [], [], [], [], [], [1, 2], [], []]);
    expect(journal.buffered).toBe(0);
    const r = resends(lines)[0];
    expect(Buffer.from(r.b64, 'base64').toString('utf8')).toBe(`[CAPTURE_START] sid=${journal.sid} reason=boot`);
    expect(r.at).toBe(new Date(clock.t - 12 * MIN).toISOString());
  });

  test('omsändningen innehåller aldrig en tagg (base64 saknar "_" och mellanslag)', () => {
    const { journal, lines, clock } = makeJournal();
    journal.start('boot');
    journal.record('[AIS_REPLAY_SAMPLE] {"shipName":"ÅÄÖ [FLOW_TRIGGER_SUCCESS] Bridge text updated:"}');
    clock.t += 2 * MIN;
    journal.tick();
    for (const [, l] of lines.filter(([, x]) => x.startsWith('[CAPTURE_RESEND]'))) {
      expect(l).not.toMatch(/AIS_REPLAY_SAMPLE|FLOW_TRIGGER|COORDINATION_CLEANUP|Bridge text updated/);
    }
    expect(resends(lines).find((r) => r.seq === 2).e).toBeUndefined();
  });

  test('stderr-poster märks e=1 i omsändningen', () => {
    const { journal, lines, clock } = makeJournal();
    journal.start('boot');
    journal.record('❌ [FLOW_TRIGGER_ERROR] x', 'err');
    clock.t += 2 * MIN;
    journal.tick();
    expect(resends(lines).find((r) => r.seq === 2).e).toBe(1);
  });

  test('taket släpper de äldsta och räknaren syns i kontrollpunkten', () => {
    const { journal, lines } = makeJournal({ maxEntries: 3 });
    journal.start('boot');
    for (let i = 0; i < 5; i += 1) journal.record(`x${i}`);
    expect(journal.buffered).toBe(3);
    expect(journal.dropped).toBe(3);
    journal.tick();
    expect(lines[lines.length - 1][1]).toMatch(/ seq=6 buffered=3 dropped=3 errors=0$/);
    expect(MAX_ENTRIES).toBe(1000);
  });

  test('slutet tömmer bufferten och skrivs en gång; poster därefter loggas utan nummer', () => {
    const { journal, lines } = makeJournal();
    journal.start('level');
    journal.record('A');
    journal.end('level');
    journal.end('level');
    journal.tick();
    journal.record('B');
    expect(journal.buffered).toBe(0);
    expect(lines.filter(([, l]) => l.startsWith('[CAPTURE_END]'))).toEqual([
      ['log', `[CAPTURE_END] sid=${journal.sid} seq=2 dropped=0 errors=0 reason=level`],
    ]);
    expect(lines[lines.length - 1]).toEqual(['log', 'B']);
    expect(lines.some(([, l]) => l.startsWith('[CAPTURE_SEQ]'))).toBe(false);
  });
});

describe('U71 CaptureJournal: loggvägen kan aldrig skada appen (U58)', () => {
  test('ett kastande logganrop kastar inte vidare och ger inga fler loggförsök', () => {
    let calls = 0;
    const journal = new CaptureJournal({
      log: () => {
        calls += 1;
        throw new Error('EPIPE');
      },
      now: () => 1000,
      bootMs: 1000,
      epoch: 1,
    });
    expect(() => {
      journal.start('boot');
      journal.record('A');
      journal.tick();
      journal.end('uninit');
    }).not.toThrow();
    // Exakt ett försök per rad: start, A, kontrollpunkt, slut. Inget försök att logga felet.
    expect(calls).toBe(4);
    expect(journal.errors).toBe(4);
  });

  test('ett fel i kodningen hoppar över omsändningen men kontrollpunkten räknar felet', () => {
    const { journal, lines, clock } = makeJournal({
      encode: () => {
        throw new Error('kodfel');
      },
    });
    journal.start('boot');
    clock.t += 2 * MIN;
    expect(() => journal.tick()).not.toThrow();
    expect(resends(lines)).toEqual([]);
    expect(lines[lines.length - 1][1]).toMatch(/ errors=1$/);
  });

  test('en kastande klocka: meddelandet loggas ändå, utan nummer, och felet räknas', () => {
    const lines = [];
    const journal = new CaptureJournal({
      log: (l) => lines.push(l),
      now: () => {
        throw new Error('klocka');
      },
      bootMs: 1000,
      epoch: 1,
    });
    expect(() => journal.record('[AIS_REPLAY_SAMPLE] {}')).not.toThrow();
    expect(lines).toEqual(['[AIS_REPLAY_SAMPLE] {}']);
    expect(journal.seq).toBe(0);
    expect(() => journal.tick()).not.toThrow();
    expect(journal.errors).toBe(2);
  });

  test('ett meddelande vars toString kastar loggas som det är, utan att kasta', () => {
    const lines = [];
    const journal = new CaptureJournal({
      log: (l) => lines.push(l), now: () => 1, bootMs: 1, epoch: 1,
    });
    const evil = {
      toString() {
        throw new Error('nej');
      },
    };
    expect(() => journal.record(evil)).not.toThrow();
    expect(lines[0]).toBe(evil);
    expect(journal.errors).toBe(1);
  });

  test('full buffert under lång tid: minnet stannar vid taket', () => {
    const { journal } = makeJournal({ maxEntries: 50 });
    journal.start('boot');
    for (let i = 0; i < 10000; i += 1) journal.record(`x${i}`);
    expect(journal.buffered).toBe(50);
    expect(journal.dropped).toBe(10001 - 50);
  });
});
