'use strict';

const PassageLatchService = require('../lib/services/PassageLatchService');

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

/**
 * F13: passage-latchen var riktnings-agnostisk → blockerade legitim ÅTERGÅNG
 * (vändning tillbaka mot bron) i upp till ~7 min → fryst bridge_text, uteblivna
 * notiser vid verklig närhet. Latchen släpper nu igenom när båten bevisligen rör
 * sig i MOTSATT riktning mot passagen, men behåller blockeringen i samma riktning
 * och vid osäker/saknad COG (konservativt).
 */
describe('F13: riktningskänslig passage-latch', () => {
  let svc;
  const mmsi = '265727030';
  const bridge = 'Klaffbron';

  beforeEach(() => {
    svc = new PassageLatchService(makeLogger());
    // Båten passerade Klaffbron norrut
    svc.registerPassage(mmsi, bridge, 'north');
  });

  test('blockerar retrograd "waiting" i SAMMA riktning (norrut, COG 10°)', () => {
    // Fortsätter norrut → retrograd waiting ska fortfarande blockeras
    expect(svc.shouldBlockStatus(mmsi, bridge, 'waiting', 10)).toBe(true);
  });

  test('SLÄPPER IGENOM vid bevisad vändning (söderut, COG 180°) — efter två konsekutiva samples', () => {
    // Helgranskning 2026-07-06 (route-latch#2): releasen kräver numera TVÅ
    // konsekutiva motsatta avläsningar (Anomali 18-spegling) — ett enda
    // brusigt sampel hos en långsam båt ska INTE släppa latchen.
    expect(svc.shouldBlockStatus(mmsi, bridge, 'waiting', 180)).toBe(true); // 1:a: pending
    expect(svc.shouldBlockStatus(mmsi, bridge, 'waiting', 180)).toBe(false); // 2:a: släpp
  });

  test('behåller blockering vid OSÄKER COG (öster 90°) — ingen regress-risk', () => {
    expect(svc.shouldBlockStatus(mmsi, bridge, 'waiting', 90)).toBe(true);
  });

  test('behåller blockering när COG saknas (null) — bakåtkompatibelt', () => {
    expect(svc.shouldBlockStatus(mmsi, bridge, 'waiting')).toBe(true);
    expect(svc.shouldBlockStatus(mmsi, bridge, 'waiting', null)).toBe(true);
  });

  test('icke-latchad status påverkas inte (under-bridge ej i latchedStatuses)', () => {
    expect(svc.shouldBlockStatus(mmsi, bridge, 'under-bridge', 10)).toBe(false);
  });

  test('annan bro utan latch → blockeras aldrig', () => {
    expect(svc.shouldBlockStatus(mmsi, 'Stridsbergsbron', 'waiting', 10)).toBe(false);
  });
});
