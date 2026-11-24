'use strict';

/**
 * Barnprocess för tests/log-channel-u58.test.js (beslut U58, 2026-11-24).
 *
 * Startar den riktiga appen med Homey-mocken och kopplar this.log/this.error
 * till console, som Homey-SDK:n gör (console → stdout/stderr). Föräldern
 * stänger läsänden av stdout och/eller stderr, så varje loggrad misslyckas med
 * EPIPE. Barnet rapporterar sina steg på fd 3, som alltid är hel.
 *
 * Läge (argv[2]):
 *   'loggar'    – bara loggrader under livstiden
 *   'kast'      – dessutom ett ofångat fel (ett verkligt fel, inte loggkanalens)
 *   'avvisning' – dessutom ett ofångat avvisat löfte
 * Med U58_SLUT=naturligt avslutas barnet inte med process.exit(0) efter
 * onUninit utan får ta slut av sig själv.
 * Med argv[3] = 'utan-stromlyssnare' tas appens error-lyssnare på stdout och
 * stderr bort efter onInit, så att bara krockskyddets egna skydd återstår
 * (slingan måste då brytas av översvämningsspärren).
 *
 * Före U58 svälte krockskyddets loggning händelseslingan (skrivfel → ofångat
 * fel → loggning → skrivfel …), så barnet kom aldrig fram till "klar".
 */

require('./u58Vakt');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..');
const MOCK = path.join(ROOT, 'tests', '__mocks__', 'homey');
const originalRequire = Module.prototype.require;
Module.prototype.require = function requireOverride(id) {
  if (id === 'homey') return originalRequire.call(this, MOCK);
  return originalRequire.call(this, id);
};

const report = (line) => {
  try {
    fs.writeSync(3, `${line}\n`);
  } catch (e) {
    // fd 3 saknas när skriptet körs för hand; då rapporteras inget.
  }
};

const mode = process.argv[2] || 'loggar';
const nextTurn = () => new Promise((resolve) => {
  setImmediate(resolve);
});

async function main() {
  global.__TEST_MODE__ = true; // inga monitoringintervall, som i replay-harnessen
  const { __mockHomey: mockHomey } = require('homey'); // eslint-disable-line global-require
  const settings = { debug_level: 'off', ais_api_key: null }; // ingen AIS-anslutning
  mockHomey.settings = {
    get: (k) => settings[k] || null,
    set: (k, v) => {
      settings[k] = v;
    },
    on: () => {},
    off: () => {},
  };
  const AISBridgeApp = require(path.join(ROOT, 'app')); // eslint-disable-line global-require
  const app = new AISBridgeApp();
  app.homey = mockHomey;
  app.log = (...args) => console.log('[log]', ...args);
  app.error = (...args) => console.error('[err]', ...args);

  await app.onInit();
  if (process.argv[3] === 'utan-stromlyssnare') {
    process.stdout.removeListener('error', app._onStdoutError);
    process.stderr.removeListener('error', app._onStderrError);
  }
  report('init');
  for (let i = 0; i < 20; i++) {
    app.log('loggrad', i);
    app.error('felrad', i);
    await nextTurn(); // eslint-disable-line no-await-in-loop
  }
  if (mode === 'kast') {
    setImmediate(() => {
      throw new Error('U58-provfel');
    });
  }
  if (mode === 'avvisning') Promise.reject(new Error('U58-provavvisning'));
  for (let i = 0; i < 20; i++) await nextTurn(); // eslint-disable-line no-await-in-loop
  report(`loggkanalfel ${JSON.stringify(app._logChannelErrors || null)}`);
  report(`sparr ${JSON.stringify(app._fatalFlood || null)}`);
  await app.onUninit();
  report('klar');
  // Som Homey: processen tas ned direkt efter onUninit. Med
  // U58_SLUT=naturligt får processen i stället ta slut av sig själv, så att
  // den kända gränsen (skrivfel efter avregistreringen) syns.
  if (process.env.U58_SLUT === 'naturligt') return;
  process.exit(0);
}

main().catch((e) => {
  report(`fel ${e && e.message}`);
  process.exit(2);
});
