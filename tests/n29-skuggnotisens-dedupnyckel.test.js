'use strict';

jest.mock('homey');

/**
 * N29 (helkodsgranskning RUNDA 5, 2026-08-23) — M37:s SKUGGNOTIS DELADE
 * DEDUPNYCKEL MED BOTH-GRENENS MOTSATTA BESKED.
 *
 * MEKANISMEN FÖRE FIXEN: _notifyConnectionIssue släpper igenom EXAKT EN text
 * per nyckel per dygn. Den nya skuggnotisen använde samma nyckel
 * ('aisstream:nokey') som boot-vägens "ingen API-nyckel är konfigurerad" och
 * 'both'-grenens "appen kör enbart AISHub" — och texterna säger MOTSATTA
 * saker: den ena lovar att AISHub bär appen, den andra att INGEN källa matar
 * brotext eller notiser.
 *
 * NÅBARHETEN ÄR HÖG: redan första boot utan nyckel bränner nyckeln. Användaren
 * som därefter fyller i AISHub-username och väljer skuggläge — inställnings-
 * sidans EGEN rekommendation — får då aldrig veta att appen blivit blind.
 * Inget skyddsnät finns: hälsomonitorns relevantlista är tom i skuggläge
 * (samma rot som N10).
 *
 * FIXEN: skuggläget får en EGEN nyckel (SHADOW_NOKEY_NOTICE_KEY), delad mellan
 * skugglägets två avsändare (_applyAisSourceConfig och _startConnection) så
 * användaren fortfarande får EN timeline-rad per dygn, inte två.
 *
 * SVITEN KÖR RIKTIGA _notifyConnectionIssue mot en notiskanal-mock — det är
 * dedupkartan som är själva defekten, så den får inte stubbas bort.
 *
 * MUTATIONSPROV (körs manuellt): sätt tillbaka 'aisstream:nokey' på skugg-
 * ställena ⇒ "FIXEN"-testet blir rött (och kontrollarmen grön).
 */

const AISBridgeApp = require('../app');

const BOOT_NOKEY_TEXT = 'AIS Tracker: ingen API-nyckel är konfigurerad — appen tar inte emot '
  + 'båtdata. Lägg in din AISstream.io-nyckel i appens inställningar.';

function makeApp(settings = {}) {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.error = jest.fn();
  app.debug = jest.fn();
  app._updateDeviceCapability = jest.fn();
  const store = { ...settings };
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
  app.aisClient = { applySourceConfig: jest.fn(), connect: jest.fn().mockResolvedValue(undefined) };
  return app;
}

const sentTexts = (app) => app.homey.notifications.createNotification.mock.calls
  .map((c) => String(c[0].excerpt));

describe('N29: skuggläget måste ha egen dedupnyckel', () => {
  test('FIXEN: boot-notisen bränner inte skuggbeskedet', async () => {
    const app = makeApp({ aishub_username: 'hubuser', ais_source: 'shadow' });
    // Steg 1 — första boot utan någon källa: dagens nokey-text går ut.
    await app._notifyConnectionIssue(BOOT_NOKEY_TEXT, 'aisstream:nokey');
    // Steg 2 — användaren fyller i username och väljer skuggläge.
    app._applyAisSourceConfig();
    await Promise.resolve();

    const texts = sentTexts(app);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('skuggläge');
    expect(texts[1]).toContain('utan båtdata');
  });

  test('KONTROLLEN (HEAD): samma sekvens på delad nyckel ⇒ användaren får aldrig veta', async () => {
    const app = makeApp({ aishub_username: 'hubuser', ais_source: 'shadow' });
    await app._notifyConnectionIssue(BOOT_NOKEY_TEXT, 'aisstream:nokey');
    // HEAD skickade skuggtexten på SAMMA nyckel:
    await app._notifyConnectionIssue('AIS Tracker: skuggläge utan AISstream-nyckel …', 'aisstream:nokey');

    expect(sentTexts(app)).toHaveLength(1);
    expect(sentTexts(app)[0]).not.toContain('skuggläge');
  });

  test('EN RAD PER DYGN: skugglägets två avsändare delar nyckel', async () => {
    const app = makeApp({ aishub_username: 'hubuser', ais_source: 'shadow' });
    const savedEnv = process.env.NODE_ENV;
    const savedTestMode = global.__TEST_MODE__;
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = undefined;
    try {
      app._applyAisSourceConfig(); // avsändare 1
      await Promise.resolve();
      await app._startConnection(); // avsändare 2 (samma besked)
      await Promise.resolve();
    } finally {
      process.env.NODE_ENV = savedEnv;
      global.__TEST_MODE__ = savedTestMode;
    }

    const shadowRows = sentTexts(app).filter((t) => t.includes('skuggläge'));
    expect(shadowRows).toHaveLength(1);
  });

  test('OBEROENDE ÅT BÅDA HÅLL: skuggnyckeln bränner inte den vanliga', async () => {
    const app = makeApp({ aishub_username: 'hubuser', ais_source: 'shadow' });
    app._applyAisSourceConfig();
    await Promise.resolve();
    await app._notifyConnectionIssue(BOOT_NOKEY_TEXT, 'aisstream:nokey');

    const texts = sentTexts(app);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('skuggläge');
    expect(texts[1]).toContain('ingen API-nyckel');
  });

  test('DEDUPEN LEVER: två skuggbesked inom dygnet ger fortfarande EN rad', async () => {
    const app = makeApp({ aishub_username: 'hubuser', ais_source: 'shadow' });
    app._applyAisSourceConfig();
    await Promise.resolve();
    app._applyAisSourceConfig();
    await Promise.resolve();

    expect(sentTexts(app)).toHaveLength(1);
  });
});

/**
 * N29b (fixrunda 5b, 2026-08-23) — SAMMA MEKANISM FÖR BOTH-GRENEN. Granskaren
 * i runda 5/5b: 'both' utan aisstream-nyckel ger ett LUGNANDE besked ("kör
 * enbart AISHub") som delade nyckel med de två ALARMERANDE "tar inte emot
 * båtdata"-avsändarna. Boot i both + AISHub-namnet tas bort inom ett dygn ⇒
 * det alarmerande beskedet tystades. Egen nyckel (BOTH_NOKEY_NOTICE_KEY).
 *
 * MUTATIONSPROV (körs manuellt): sätt tillbaka 'aisstream:nokey' i both-grenen
 * ⇒ "FIXEN"-testet nedan blir rött.
 */
describe('N29b: both-grenens lugnande besked har egen dedupnyckel', () => {
  test('FIXEN: both-beskedet bränner inte det alarmerande nokey-beskedet', async () => {
    const app = makeApp({ aishub_username: 'hubuser', ais_source: 'both' });
    // Steg 1 — boot i both utan aisstream-nyckel: det lugnande beskedet går ut.
    app._applyAisSourceConfig();
    await Promise.resolve();
    expect(sentTexts(app)).toHaveLength(1);
    expect(sentTexts(app)[0]).toContain('enbart AISHub');
    // Steg 2 — inom dygnet: ingen källa alls ⇒ det alarmerande beskedet MÅSTE nå fram.
    await app._notifyConnectionIssue(BOOT_NOKEY_TEXT, 'aisstream:nokey');
    const texts = sentTexts(app);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('tar inte emot');
  });

  test('DEDUPEN LEVER: två both-besked inom dygnet ger fortfarande EN rad', async () => {
    const app = makeApp({ aishub_username: 'hubuser', ais_source: 'both' });
    app._applyAisSourceConfig();
    await Promise.resolve();
    app._applyAisSourceConfig();
    await Promise.resolve();
    expect(sentTexts(app)).toHaveLength(1);
  });

  test('OBEROENDE: both-nyckeln delar inte fönster med skuggnyckeln', async () => {
    const app = makeApp({ aishub_username: 'hubuser', ais_source: 'both' });
    app._applyAisSourceConfig();
    await Promise.resolve();
    await app._notifyConnectionIssue('AIS Tracker: skuggläge utan AISstream-nyckel …', 'aisstream:nokey:shadow');
    expect(sentTexts(app)).toHaveLength(2);
  });
});
