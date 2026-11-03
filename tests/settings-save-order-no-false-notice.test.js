'use strict';

jest.mock('homey');

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const AISBridgeApp = require('../app');

/**
 * Helgranskningen 2026-11-03: inställningssidan skriver nycklarna en i taget
 * och appen omkonfigurerar källorna efter VARJE AIS-nyckel. Med den gamla
 * ordningen (användarnamn → källval → nyckel) syntes ogiltiga mellanlägen:
 * "Båda" + ny nyckel gav notisen "ingen AISstream-nyckel är konfigurerad",
 * och byte till AISstream med tömt användarnamn gav "källvalet kräver ett
 * AISHub-användarnamn". Notisernas 24 h-spärr tystade sedan en äkta notis.
 *
 * Testet kör sidans RIKTIGA skript (som settings-page-recovery.test.js) mot
 * appens RIKTIGA _applyAisSourceConfig och prövar varje övergång mellan
 * kombinationer av källa, nyckel och användarnamn som sidan godkänner.
 * Kontraktet: en sparning får bara ge de notiser som slutläget självt ger.
 */
const KEY_A = 'a'.repeat(24);
const KEY_B = 'b'.repeat(24);
const SOURCES = ['aisstream', 'shadow', 'both', 'aishub'];
const KEYS = ['', KEY_A, KEY_B];
const USERS = ['', 'hub-user', 'other-user'];

function makeApp(store) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  app.debug = jest.fn();
  app.homey = {
    settings: {
      get: (k) => (k in store ? store[k] : null),
      set: (k, v) => {
        store[k] = v;
      },
      on: jest.fn(),
    },
    notifications: { createNotification: jest.fn().mockResolvedValue(undefined) },
  };
  app.aisClient = { applySourceConfig: jest.fn() };
  app._notifyConnectionIssue = jest.fn();
  return app;
}

// Notiserna som ett givet läge i sig ger (appens egen regel, inte en kopia).
function noticesFor(state) {
  const app = makeApp({ ...state });
  app._applyAisSourceConfig();
  return new Set(app._notifyConnectionIssue.mock.calls.map(([, key]) => key));
}

function runSave(from, to) {
  const store = { debug_level: 'basic', ...from };
  const app = makeApp(store);
  app._setupSettingsListener();
  const notices = new Set();
  app._notifyConnectionIssue.mockImplementation((msg, key) => {
    notices.add(key);
  });
  const configs = [];
  app.aisClient.applySourceConfig.mockImplementation((cfg) => {
    configs.push({ ...cfg });
  });
  const writes = [];
  const elements = {};
  const homey = {
    __: (key) => key,
    ready: jest.fn(),
    get: (key, callback) => callback(null, store[key] ?? null),
    set: (key, value, callback) => {
      writes.push(key);
      store[key] = value;
      app._onSettingsChanged(key, value);
      callback(null);
    },
  };
  const document = {
    getElementById: (id) => {
      if (!elements[id]) {
        elements[id] = {
          value: '',
          style: {},
          disabled: false,
          addEventListener(event, cb) {
            this[event] = cb;
          },
        };
      }
      return elements[id];
    },
  };
  const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
  const source = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const context = vm.createContext({ document, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  context.onHomeyReady(homey);
  elements.ais_api_key.value = to.ais_api_key;
  elements.aishub_username.value = to.aishub_username;
  elements.ais_source.value = to.ais_source;
  elements.debug_level.value = 'basic';
  elements.save.click();
  return {
    notices, writes, store, configs, status: elements.status.textContent,
  };
}

// Vilka källor muxen kör för ett läge: AISstream behöver nyckel, AISHub
// (även skuggmätningen) behöver användarnamn.
function activeSources(cfg) {
  const src = cfg.source || cfg.ais_source;
  const key = cfg.apiKey ?? cfg.ais_api_key ?? '';
  const user = cfg.aishubUsername ?? cfg.aishub_username ?? '';
  const active = new Set();
  if (['aisstream', 'both', 'shadow'].includes(src) && key !== '') active.add('aisstream');
  if (['aishub', 'both', 'shadow'].includes(src) && user !== '') active.add('aishub');
  return active;
}

describe('Inställningssidan: skrivordningen ger inga falska källnotiser', () => {
  const states = [];
  for (const source of SOURCES) {
    for (const key of KEYS) {
      for (const user of USERS) {
        states.push({ ais_source: source, ais_api_key: key, aishub_username: user });
      }
    }
  }
  // Sidan godkänner inte andra källor än AISstream utan användarnamn.
  const accepted = states.filter((s) => s.ais_source === 'aisstream' || s.aishub_username !== '');

  test('varje godkänd övergång ger högst slutlägets egna notiser och når slutläget', () => {
    let checked = 0;
    const offenders = [];
    // Utgångsläget är ett som sidan själv kan ha sparat. Ett läge sidan
    // vägrar (t.ex. skuggläge utan användarnamn) är redan ogiltigt och har
    // redan gett sin notis när det uppstod — den hör inte till ordningen.
    for (const from of accepted) {
      for (const to of accepted) {
        const result = runSave(from, to);
        expect(result.store.ais_source).toBe(to.ais_source);
        expect(result.store.ais_api_key || '').toBe(to.ais_api_key);
        expect(result.store.aishub_username || '').toBe(to.aishub_username);
        const allowed = noticesFor(to);
        const extra = [...result.notices].filter((key) => !allowed.has(key));
        if (extra.length) {
          offenders.push({
            from, to, extra, writes: result.writes,
          });
        }
        // Inget mellanläge får starta en källa som varken start- eller
        // slutläget använder (en onödig AISHub-poll eller AISstream-anslutning).
        const allowedSources = new Set([...activeSources(from), ...activeSources(to)]);
        for (const cfg of result.configs) {
          const blink = [...activeSources(cfg)].filter((feed) => !allowedSources.has(feed));
          if (blink.length) {
            offenders.push({
              from, to, blink, writes: result.writes,
            });
          }
        }
        checked++;
      }
    }
    expect(checked).toBe(accepted.length * accepted.length);
    expect(offenders).toEqual([]);
  });

  test('ny nyckel + "Båda" för första gången: inget falskt besked om saknad nyckel', () => {
    const result = runSave(
      { ais_source: 'aishub', ais_api_key: '', aishub_username: 'hub-user' },
      { ais_source: 'both', ais_api_key: KEY_A, aishub_username: 'hub-user' },
    );
    expect([...result.notices]).toEqual([]);
    expect(result.writes).toEqual(['ais_api_key', 'ais_source']);
  });

  test('nyinstallation med skuggläge + användarnamn + nyckel: inget besked om att appen saknar båtdata', () => {
    const result = runSave(
      { ais_source: 'aisstream', ais_api_key: '', aishub_username: '' },
      { ais_source: 'shadow', ais_api_key: KEY_A, aishub_username: 'hub-user' },
    );
    expect([...result.notices]).toEqual([]);
    expect(result.writes).toEqual(['ais_api_key', 'aishub_username', 'ais_source']);
  });

  test('byte till AISstream med tömt användarnamn: inget falskt besked om saknat användarnamn', () => {
    const result = runSave(
      { ais_source: 'aishub', ais_api_key: KEY_A, aishub_username: 'hub-user' },
      { ais_source: 'aisstream', ais_api_key: KEY_A, aishub_username: '' },
    );
    expect([...result.notices]).toEqual([]);
    expect(result.writes).toEqual(['ais_source', 'aishub_username']);
  });
});
