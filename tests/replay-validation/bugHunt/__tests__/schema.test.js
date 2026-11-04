'use strict';

/**
 * Buggjägaren steg 1: schemavalideringen (lib/schema.js). Rena funktioner —
 * inga barnprocesser, inga timers.
 */

const fs = require('fs');
const path = require('path');
const schema = require('../lib/schema');

const DATA = path.join(__dirname, '..', '..', 'corpora-data');
const firstRows = (file, n) => fs.readFileSync(path.join(DATA, file), 'utf8')
  .split('\n').filter(Boolean).slice(0, n)
  .map((l) => JSON.parse(l));

const POS = {
  mmsi: '265552100', msgType: 'PositionReport', lat: 58.2851, lon: 12.2843, sog: 4.2, cog: 12, shipName: 'TEST', aisTimestamp: 1780000000000,
};

describe('buggjägaren: schemavalidering av replayrader', () => {
  test('godkänner korpusformade rader (aisstream- och AISHub-eran) och ctrl-rader', () => {
    const legacy = firstRows('ais-replay-20260525-231934.jsonl', 20);
    const aishub = firstRows('ais-20260806-42h.jsonl', 20);
    const ctrl = [
      { ctrl: 'disconnect', aisTimestamp: 1780000001000 },
      { ctrl: 'reconnect', aisTimestamp: 1780000002000 },
      { ctrl: 'restart', aisTimestamp: 1780000003000 },
    ];
    const res = schema.validateRows([...legacy, ...aishub, ...ctrl, POS]);
    expect(res.fel).toEqual([]);
    expect(res.ok).toBe(true);
  });

  test.each([
    ['ctrl utan aisTimestamp', { ctrl: 'restart' }, /aisTimestamp saknas/],
    ['aisTimestamp i sekunder', { ...POS, aisTimestamp: 1.78e9 }, /sekunder/],
    ['aisTimestamp som ISO-sträng', { ...POS, aisTimestamp: '2026-06-01T10:00:00Z' }, /sträng/],
    ['aisTimestamp NaN', { ...POS, aisTimestamp: NaN }, /aisTimestamp NaN/],
    ['fixTs efter aisTimestamp', { ...POS, fixTs: POS.aisTimestamp + 1 }, /fixTs .* ligger efter aisTimestamp/],
    ['okänd ctrl', { ctrl: 'pause', aisTimestamp: 1780000000000 }, /okänd ctrl/],
    ['fältnamnet timestamp', { ...POS, timestamp: POS.aisTimestamp }, /timestamp ignoreras/],
    ['fältnamnet fixFeed', { ...POS, fixFeed: 'aishub' }, /fixFeed ignoreras/],
    ['mmsi som tal', { ...POS, mmsi: 265552100 }, /9-siffrig sträng/],
    ['okänd feed', { ...POS, feed: 'udp' }, /feed/],
  ])('avvisar %s och anger radnumret', (namn, bad, re) => {
    const res = schema.validateRows([POS, POS, bad]);
    expect(res.ok).toBe(false);
    expect(res.fel.some((f) => f.startsWith('rad 3:') && re.test(f))).toBe(true);
  });

  test('assertValidRows kastar SCHEMAFEL med radnummer', () => {
    expect(() => schema.assertValidRows([POS, { ctrl: 'restart' }], 'x.jsonl')).toThrow(/schemafel i x\.jsonl: rad 2:/);
  });

  test('parseJsonl rapporterar trasig JSON med radnummer', () => {
    const res = schema.parseJsonl(`${JSON.stringify(POS)}\n{trasig\n\n${JSON.stringify(POS)}\n`);
    expect(res.rader).toHaveLength(2);
    expect(res.fel).toEqual([expect.stringMatching(/^rad 2: ogiltig JSON/)]);
  });
});
