'use strict';

/**
 * U58 (2026-11-24): en trasig loggkanal får inte hålla appen i en evig slinga.
 *
 * Före rättningen: ett skrivfel på stdout/stderr (EPIPE när mottagaren är
 * borta) blev ett ofångat fel, krockskyddet loggade det, den loggningen
 * misslyckades på samma sätt, och så vidare. Kedjan gick i tick-kön och svälte
 * händelseslingan: full processorlast, inga notiser, inget avslut.
 *
 * Del 1 kör appen i en barnprocess med stängd stdout/stderr och kräver att den
 * går klart. Del 2 låser krockskyddets beteende och lyssnarstädningen (F54).
 */

jest.mock('homey');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const CHILD = path.join(__dirname, 'fixtures', 'logChannelChild.js');
const VAKT = path.join(__dirname, 'fixtures', 'u58Vakt.js');
// Barnet går på under en sekund på en ledig maskin. Gränsen är generös så att
// testet håller under last; en slinga snurrar ändå tills den dödas.
const CHILD_LIMIT_MS = 30000;

// Alla barn som lever dödas efter varje test, också när ett påstående faller.
const liveChildren = new Set();
afterEach(() => {
  for (const child of liveChildren) child.kill('SIGKILL');
  liveChildren.clear();
});

/**
 * Startar ett barn och väntar tills det har avslutats och alla dess strömmar
 * är stängda. Vid tidsgränsen dödas det.
 */
function spawnAndWait(args, { closed = [], stdio = ['ignore', 'pipe', 'pipe', 'pipe'], env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.join(__dirname, '..'),
      stdio,
      env: { ...process.env, ...env },
    });
    liveChildren.add(child);
    const out = { stdout: '', stderr: '', report: '' };
    for (const name of ['stdout', 'stderr']) {
      if (closed.includes(name)) child[name].destroy();
      else {
        child[name].on('data', (d) => {
          out[name] += d;
        });
      }
    }
    if (child.stdio[3]) {
      child.stdio[3].on('data', (d) => {
        out.report += d;
      });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CHILD_LIMIT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      resolve({
        ...out, code, signal, timedOut,
      });
    });
  });
}

const runChild = (mode, closed, extra = []) => spawnAndWait([CHILD, mode, ...extra], { closed, env: { REPLAY_VERBOSE: '' } });

describe('U58 del 1: appen går klart med trasig loggkanal (barnprocess)', () => {
  jest.setTimeout(CHILD_LIMIT_MS * 2);

  test.each([
    ['stderr', ['stderr']],
    ['stdout', ['stdout']],
    ['stdout och stderr', ['stdout', 'stderr']],
  ])('stängd %s: ingen slinga, appen stängs ned i ordning', async (_label, closed) => {
    const r = await runChild('loggar', closed);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.report).toMatch(/^init$/m);
    expect(r.report).toMatch(/^klar$/m);
    if (!closed.includes('stderr')) {
      // Den hela kanalen bär appens vanliga rader men inga [FATAL] om den trasiga.
      expect(r.stderr).toMatch(/\[err\] felrad 19/);
      expect(r.stderr).not.toMatch(/FATAL/);
    }
    // Felen sväljs men räknas.
    const counts = JSON.parse(r.report.match(/^loggkanalfel (.*)$/m)[1]);
    for (const name of closed) expect(counts[name]).toBeGreaterThan(0);
  });

  test.each(['kast', 'avvisning'])('stängd stderr och ett ofångat fel (%s): ingen slinga', async (mode) => {
    const r = await runChild(mode, ['stderr']);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.report).toMatch(/^klar$/m);
  });

  test('hel loggkanal: ett ofångat fel loggas med [FATAL] som förut och appen lever vidare', async () => {
    const r = await runChild('kast', []);
    expect(r.code).toBe(0);
    expect(r.report).toMatch(/^klar$/m);
    expect(r.stderr).toMatch(/\[err\] \[FATAL\] Uncaught exception: Error: U58-provfel/);
    expect(r.stderr.match(/\[FATAL\]/g)).toHaveLength(1);
  });

  test('hel loggkanal: ett avvisat löfte loggas med [FATAL] som förut', async () => {
    const r = await runChild('avvisning', []);
    expect(r.code).toBe(0);
    expect(r.report).toMatch(/^klar$/m);
    expect(r.stderr).toMatch(/\[err\] \[FATAL\] Unhandled rejection at: Promise \{[\s\S]*reason: Error: U58-provavvisning/);
    expect(r.stderr.match(/\[FATAL\]/g)).toHaveLength(1);
  });

  test('utan strömlyssnarna bryter översvämningsspärren slingan (en annan väg in)', async () => {
    // Appens error-lyssnare tas bort i barnet: skrivfelen blir åter ofångade
    // fel, och bara krockskyddets egna skydd står mellan appen och slingan.
    const r = await runChild('loggar', ['stdout', 'stderr'], ['utan-stromlyssnare']);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.report).toMatch(/^klar$/m);
    const flood = JSON.parse(r.report.match(/^sparr (.*)$/m)[1]);
    expect(flood.logged).toBe(10);
    expect(flood.suppressed).toBeGreaterThan(0);
  });

  test('ett spärrat fel med 64 MB meddelande håller inte kvar den stora strängen', async () => {
    const r = await spawnAndWait(['--expose-gc', CHILD, 'minne'], { closed: [], env: { REPLAY_VERBOSE: '' } });
    expect(r.code).toBe(0);
    const kvar = Number(r.report.match(/^minne (-?\d+)$/m)[1]);
    expect(kvar).toBeLessThan(16);
  });

  // KÄND GRÄNS (låst som den är, se ARCHITECTURE om krockskyddet): sista raden
  // i onUninit skrivs efter att lyssnarna tagits bort. Är stdout trasig kommer
  // skrivfelet när ingen lyssnare finns kvar, och processen avslutas med ett
  // ofångat fel (slutkod 1), ordnat och utan slinga. Ändras det här utfallet
  // ska gränsen och dokumentationen ses över.
  test('känd gräns: trasig stdout vid nedstängning avslutar processen med slutkod 1, utan slinga', async () => {
    const r = await spawnAndWait([CHILD, 'loggar'], { closed: ['stdout'], env: { REPLAY_VERBOSE: '', U58_SLUT: 'naturligt' } });
    expect(r.timedOut).toBe(false);
    expect(r.report).toMatch(/^klar$/m);
    expect(r.code).toBe(1);
  });

  test('motfall till gränsen: trasig stderr eller hel kanal vid nedstängning ger slutkod 0', async () => {
    for (const closed of [['stderr'], []]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await spawnAndWait([CHILD, 'loggar'], { closed, env: { REPLAY_VERBOSE: '', U58_SLUT: 'naturligt' } });
      expect(r.timedOut).toBe(false);
      expect(r.report).toMatch(/^klar$/m);
      expect(r.code).toBe(0);
    }
  });
});

describe('U58 del 3: en kvarglömd verbos replay går klart med stängd stderr', () => {
  jest.setTimeout(CHILD_LIMIT_MS * 2);
  const fs = require('fs');
  const os = require('os');

  test('verbos replay med omstart mitt i: slutkod 0 och fullständigt resultat', async () => {
    // Omstarten prövar harnessens egna skrivningar utanför appens livstid.
    const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'f02-inom300.jsonl'), 'utf8').trim().split('\n');
    const restartAt = JSON.parse(lines[4]).aisTimestamp + 1000;
    lines.splice(5, 0, JSON.stringify({ ctrl: 'restart', aisTimestamp: restartAt }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u58-'));
    const file = path.join(dir, 'omstart.jsonl');
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    try {
      const r = await spawnAndWait(['-r', VAKT, path.join(__dirname, 'replay-validation', 'replayRunner.js'), file], {
        closed: ['stderr'], stdio: ['ignore', 'pipe', 'pipe'], env: { REPLAY_VERBOSE: '1' },
      });
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout.match(/__REPLAY_JSON__(.*)__END__/)[1]);
      expect(json.fatal).toBeUndefined();
      expect(json.processErrors).toBe(0);
      expect(json.runtimeDiagnostics.timersAfterRestartShutdown).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('U58 del 2: krockskyddet och lyssnarstädningen', () => {
  let app;
  let savedMode;
  const { __mockHomey: mockHomey } = require('homey');
  const AISBridgeApp = require('../app');

  const snapshot = () => ({
    uncaught: process.listeners('uncaughtException'),
    rejection: process.listeners('unhandledRejection'),
    stdout: process.stdout.listeners('error'),
    stderr: process.stderr.listeners('error'),
  });

  const makeApp = () => {
    const a = new AISBridgeApp();
    const settings = new EventEmitter();
    const stored = {};
    settings.get = (key) => stored[key] ?? null;
    settings.set = (key, value) => {
      stored[key] = value;
    };
    a.homey = { ...mockHomey, settings, flow: { ...mockHomey.flow } };
    a.log = jest.fn();
    a.error = jest.fn();
    a.debug = jest.fn();
    return a;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-24T10:00:00Z'));
    savedMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    app = makeApp();
  });

  afterEach(async () => {
    if (!app._shuttingDown) await app.onUninit();
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedMode;
  });

  test('vanligt ofångat fel och avvisat löfte loggas exakt som förut', async () => {
    await app.onInit();
    app.error.mockClear();
    const err = new Error('verkligt fel');
    app._onUncaughtException(err);
    const promise = Promise.resolve();
    const reason = new Error('verklig avvisning');
    app._onUnhandledRejection(reason, promise);
    expect(app.error.mock.calls).toEqual([
      ['[FATAL] Uncaught exception:', err],
      ['[FATAL] Unhandled rejection at:', promise, 'reason:', reason],
    ]);
  });

  test('ett EPIPE från något annat än loggkanalen tystas inte', async () => {
    await app.onInit();
    app.error.mockClear();
    const socketErr = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' });
    app._onUncaughtException(socketErr);
    expect(app.error).toHaveBeenCalledWith('[FATAL] Uncaught exception:', socketErr);
  });

  test('skrivfel på stdout och stderr sväljs och räknas, de loggas aldrig', async () => {
    await app.onInit();
    app.error.mockClear();
    app.log.mockClear();
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => process.stderr.emit('error', epipe)).not.toThrow();
    expect(() => process.stdout.emit('error', epipe)).not.toThrow();
    expect(() => process.stderr.emit('error', epipe)).not.toThrow();
    expect(app._logChannelErrors).toEqual({ stdout: 1, stderr: 2 });
    expect(app.error).not.toHaveBeenCalled();
    expect(app.log).not.toHaveBeenCalled();
  });

  test('en logg som kastar synkront kan inte kasta ut ur krockskyddet', async () => {
    await app.onInit();
    app.error = jest.fn(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });
    expect(() => app._onUncaughtException(new Error('x'))).not.toThrow();
    expect(() => app._onUnhandledRejection(new Error('y'), Promise.resolve())).not.toThrow();
    expect(app._fatalLogFailures).toBe(2);
  });

  test('översvämningsspärren: tio rader per minut, resten räknas och summeras', async () => {
    await app.onInit();
    app.error.mockClear();
    for (let i = 0; i < 25; i++) app._onUncaughtException(new Error(`fel ${i}`));
    expect(app.error).toHaveBeenCalledTimes(10);
    expect(app.error.mock.calls[9][1].message).toBe('fel 9');

    jest.setSystemTime(Date.now() + 61 * 1000);
    app.error.mockClear();
    const next = new Error('nästa');
    app._onUncaughtException(next);
    expect(app.error.mock.calls).toEqual([
      [expect.stringMatching(/^\[FATAL\] Översvämningsspärren höll inne 15 rader/)],
      ['[FATAL] Uncaught exception:', next],
    ]);
  });

  test('summeringen namnger skredet också när de tio loggade raderna var andra fel', async () => {
    await app.onInit();
    app.error.mockClear();
    for (let i = 0; i < 10; i++) app._onUncaughtException(new Error(`annat fel ${i}`));
    jest.setSystemTime(Date.now() + 2000);
    for (let i = 0; i < 19; i++) {
      app._onUncaughtException(new Error(`SKRED nr ${i + 11}`));
      jest.setSystemTime(Date.now() + 1000);
    }
    expect(app.error).toHaveBeenCalledTimes(10);
    jest.setSystemTime(new Date('2026-11-24T10:01:30Z'));
    app.error.mockClear();
    app._onUncaughtException(new Error('senare'));
    const summary = app.error.mock.calls[0][0];
    expect(summary).toBe('[FATAL] Översvämningsspärren höll inne 19 rader '
      + '2026-11-24T10:00:02.000Z–2026-11-24T10:00:20.000Z (högst 10 per 60 s); '
      + 'första spärrade: ofångat fel Error: SKRED nr 11');
    expect(summary).not.toMatch(/står ovan/);
  });

  test('ovanliga kastade värden ger en kort rad och kastar aldrig ut ur krockskyddet', async () => {
    await app.onInit();
    const badMessage = new Error('x');
    Object.defineProperty(badMessage, 'message', {
      get() {
        throw new Error('getter kastar');
      },
    });
    const badTag = {
      get [Symbol.toStringTag]() {
        throw new Error('tagg kastar');
      },
    };
    const cases = [
      ['uncaught', new Error(), 'ofångat fel Error'],
      ['uncaught', 'sträng', 'ofångat fel sträng'],
      ['uncaught', null, 'ofångat fel null'],
      ['uncaught', undefined, 'ofångat fel undefined'],
      ['uncaught', { a: 1 }, 'ofångat fel [object Object]'],
      ['uncaught', badMessage, 'ofångat fel (felet gick inte att beskriva)'],
      ['uncaught', badTag, 'ofångat fel (felet gick inte att beskriva)'],
      ['uncaught', new TypeError(`rad ett\nrad två ${'x'.repeat(300)}`), `ofångat fel TypeError: rad ett rad två ${'x'.repeat(300)}`.slice(0, 12 + 200)],
      ['rejection', 'sträng', 'avvisat löfte sträng'],
      ['rejection', null, 'avvisat löfte null'],
      ['rejection', badMessage, 'avvisat löfte (felet gick inte att beskriva)'],
    ];
    for (const [kind, cause, expected] of cases) {
      jest.setSystemTime(Date.now() + 61 * 1000);
      for (let i = 0; i < 10; i++) app._onUncaughtException(new Error(`fyll ${i}`));
      const fire = kind === 'uncaught'
        ? () => app._onUncaughtException(cause)
        : () => app._onUnhandledRejection(cause, Promise.resolve());
      expect(fire).not.toThrow();
      jest.setSystemTime(Date.now() + 61 * 1000);
      app.error.mockClear();
      expect(() => app._onUncaughtException(new Error('nästa'))).not.toThrow();
      const summary = app.error.mock.calls[0][0];
      expect(summary.endsWith(`första spärrade: ${expected}`)).toBe(true);
      expect(summary).not.toMatch(/\n/);
    }
  });

  test('enstaka fel: inga summeringsrader och inga sparade fel', async () => {
    await app.onInit();
    app.error.mockClear();
    for (let i = 0; i < 10; i++) app._onUncaughtException(new Error(`fel ${i}`));
    jest.setSystemTime(Date.now() + 61 * 1000);
    app._onUncaughtException(new Error('fel 10'));
    expect(app.error).toHaveBeenCalledTimes(11);
    expect(app.error.mock.calls.every((c) => c[0] === '[FATAL] Uncaught exception:')).toBe(true);
    expect(app._fatalFlood.firstText).toBeNull();
  });

  test('undertryckta rader summeras vid onUninit när loggkanalen är hel', async () => {
    await app.onInit();
    for (let i = 0; i < 12; i++) app._onUncaughtException(new Error(`fel ${i}`));
    app.error.mockClear();
    await app.onUninit();
    expect(app.error).toHaveBeenCalledWith(expect.stringMatching(/^\[FATAL\] Översvämningsspärren höll inne 2 rader/));
  });

  test('efter onUninit finns exakt samma lyssnare kvar som före onInit, också efter två starter', async () => {
    const foreignBefore = () => {};
    const foreignAfter = () => {};
    process.stdout.on('error', foreignBefore);
    process.on('uncaughtException', foreignBefore);
    try {
      const before = snapshot();
      await app.onInit();
      const during = snapshot();
      expect(during.uncaught.length).toBe(before.uncaught.length + 1);
      expect(during.rejection.length).toBe(before.rejection.length + 1);
      expect(during.stdout.length).toBe(before.stdout.length + 1);
      expect(during.stderr.length).toBe(before.stderr.length + 1);
      process.stderr.on('error', foreignAfter);
      await app.onUninit();
      expect(snapshot()).toEqual({ ...before, stderr: [...before.stderr, foreignAfter] });

      // Samma instans startas om i samma process (F54), och en ny instans.
      await app.onInit();
      await app.onUninit();
      const second = makeApp();
      await second.onInit();
      await second.onUninit();
      expect(snapshot()).toEqual({ ...before, stderr: [...before.stderr, foreignAfter] });
    } finally {
      process.stdout.removeListener('error', foreignBefore);
      process.removeListener('uncaughtException', foreignBefore);
      process.stderr.removeListener('error', foreignAfter);
    }
  });

  test('två onInit i rad utan onUninit lämnar inte dubbla lyssnare', async () => {
    const before = snapshot();
    await app.onInit();
    await app.onInit();
    const during = snapshot();
    expect(during.uncaught.length).toBe(before.uncaught.length + 1);
    expect(during.stderr.length).toBe(before.stderr.length + 1);
    await app.onUninit();
    expect(snapshot()).toEqual(before);
  });
});
