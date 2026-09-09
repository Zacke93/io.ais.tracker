'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Kör sidans verkliga skript med asynkrona Homey-callbackar. Inget nätverk
// eller DOM-bibliotek behövs för att pröva att lagrade värden inte skrivs bort.
function makePage(stored = {}) {
  const elements = {};
  const reads = new Map();
  const writes = [];
  const homey = {
    __: (key) => key,
    ready: jest.fn(),
    get: (key, callback) => reads.set(key, callback),
    set: jest.fn((key, value, callback) => writes.push({ key, value, callback })),
  };
  const document = {
    getElementById: (id) => {
      if (!elements[id]) {
        elements[id] = {
          value: '',
          style: {},
          disabled: false,
          addEventListener(event, callback) {
            this[event] = callback;
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
  return {
    elements,
    homey,
    writes,
    load(failedKey) {
      for (const [key, callback] of reads) {
        callback(key === failedKey ? new Error('offline') : null, stored[key] ?? null);
      }
    },
    finishWrite(error = null) {
      const write = writes.shift();
      if (!write) throw new Error('Ingen väntande skrivning');
      write.callback(error);
      return write;
    },
  };
}

describe('Inställningssidan: laddningsfel och samtidiga sparningar', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test.each(['ais_api_key', 'aishub_username', 'ais_source', 'debug_level'])(
    'läsfel för %s blockerar samtliga skrivningar och visar ett bestående fel',
    (failedKey) => {
      const page = makePage({ ais_source: 'both', aishub_username: 'hub-user' });
      page.load(failedKey);
      expect(page.elements.save.disabled).toBe(true);
      page.elements.debug_level.value = 'full';
      page.elements.save.click();
      expect(page.homey.set).not.toHaveBeenCalled();
      jest.advanceTimersByTime(60_000);
      expect(page.elements.status.textContent).toBe('settings.status_load_error');
      expect(page.elements.status.style.display).toBe('block');
    },
  );

  test('en andra sparning får inte starta innan hela första kedjan avslutats', () => {
    const page = makePage();
    page.load();
    page.elements.aishub_username.value = 'hub-user';
    page.elements.ais_source.value = 'both';
    page.elements.ais_api_key.value = 'a'.repeat(24);
    page.elements.save.click();
    expect(page.elements.save.disabled).toBe(true);
    expect(page.elements.ais_source.disabled).toBe(true);
    expect(page.homey.set.mock.calls.map(([key]) => key)).toEqual(['aishub_username']);

    page.elements.save.click();
    expect(page.homey.set).toHaveBeenCalledTimes(1);
    page.finishWrite();
    page.elements.save.click();
    expect(page.homey.set).toHaveBeenCalledTimes(2);
    page.finishWrite();
    page.finishWrite();
    expect(page.elements.save.disabled).toBe(false);
    expect(page.elements.ais_source.disabled).toBe(false);
    expect(page.homey.set.mock.calls.map(([key]) => key))
      .toEqual(['aishub_username', 'ais_source', 'ais_api_key']);
  });

  test('en delvis misslyckad sparning kan återupptas utan att skriva om redan sparade värden', () => {
    const page = makePage();
    page.load();
    page.elements.aishub_username.value = 'hub-user';
    page.elements.ais_source.value = 'aishub';
    page.elements.save.click();
    page.finishWrite();
    page.finishWrite(new Error('offline'));
    expect(page.elements.save.disabled).toBe(false);
    expect(page.elements.status.textContent).toBe('settings.status_save_error');

    page.elements.save.click();
    expect(page.writes.map(({ key }) => key)).toEqual(['ais_source']);
    // Det föregående felets timer får inte dölja den nya sparningens status.
    jest.advanceTimersByTime(5000);
    expect(page.elements.status.style.display).toBe('block');
    expect(page.elements.status.textContent).toBe('settings.status_saving');
    page.finishWrite();
    expect(page.elements.status.textContent).toBe('settings.status_saved_connecting');
  });

  test('oförändrade värden ger inga settings-skrivningar', () => {
    const page = makePage({ debug_level: 'full', ais_source: 'aishub', aishub_username: 'hub-user' });
    page.load();
    page.elements.save.click();
    expect(page.homey.set).not.toHaveBeenCalled();
    expect(page.elements.save.disabled).toBe(false);
    expect(page.elements.status.textContent).toBe('settings.status_saved');
  });
});
