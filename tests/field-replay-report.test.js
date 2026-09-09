'use strict';

const {
  parseFieldLog, compareEvents, openingKeyOf, splitAtStop, measureClaims,
} = require('./replay-validation/compareFieldReplay');
const { crossingsForVessel, BRIDGE_STATIONS } = require('./replay-validation/makeGtPassages');

const stamp = '2026-08-24T14:22:13.959Z';
const line = (message) => `${stamp} [log] [AISBridgeApp] ${message}`;
const safe = (eta) => line(`[FLOW_TRIGGER_SAFE_TOKENS] 276015380: Safe tokens = ${JSON.stringify({
  bridge_name: 'Stridsbergsbron', message: `PHOENIX inväntar broöppning ${eta}`, already_passed: false,
})}`);
const attempt = (eta) => line(`[FLOW_TRIGGER_ATTEMPT] 276015380: bridge=Stridsbergsbron (227m, source=target), direction=söderut, ETA=${eta}`);
const success = line('[FLOW_TRIGGER_SUCCESS] 276015380: boat_near fired for Stridsbergsbron (ID=stridsbergsbron, distance=227m, status=waiting)');

describe('Fältrapporten mäter leverans, innehåll och fältstopp', () => {
  test('misslyckat försök räknas separat och lånar inte en senare lyckad leverans', () => {
    const report = parseFieldLog([
      safe(3), attempt(3),
      line('[FLOW_TRIGGER_ERROR] 276015380: boat_near failed for Stridsbergsbron (timeout)'),
      safe(4), attempt(4), success,
    ].join('\n'));
    expect(report.attempts).toBe(2);
    expect(report.undeliveredAttempts).toHaveLength(1);
    expect(report.undeliveredAttempts[0].failedAt).toBe(Date.parse(stamp));
    expect(report.notifications).toEqual([expect.objectContaining({
      eta: 4,
      message: 'PHOENIX inväntar broöppning 4',
      source: 'target',
      direction: 'southbound',
      alreadyPassed: false,
      statusAtSuccess: 'waiting',
    })]);
  });

  test('lyckad notis utan parsad försöksrad får aldrig bli tyst tom mätning', () => {
    expect(() => parseFieldLog(success)).toThrow('Kortleverans utan läsbart försök');
  });

  test('samma nyckelantal döljer inte flyttad tid, fel text/ETA/källa eller riktning', () => {
    const field = [{
      t: 1000, mmsi: '1', bridge: 'Klaffbron', message: 'väntar', eta: -1, source: 'target', direction: 'northbound',
    }];
    const replay = [{
      ...field[0], t: 99000, message: 'närmar sig', eta: 3, source: 'current', direction: 'southbound',
    }];
    const result = compareEvents(field, replay, (n) => `${n.mmsi}|${n.bridge}`, ['message', 'eta', 'source', 'direction']);
    expect(result.pairs[0].deltaMs).toBe(98000);
    expect(result.pairs[0].changes).toEqual(['message', 'eta', 'source', 'direction']);
  });

  test('ett annat fartyg får inte paras med en saknad notis och extra efterspel syns separat', () => {
    const a = { t: 1000, mmsi: '1', bridge: 'Klaffbron' };
    const b = { t: 1000, mmsi: '2', bridge: 'Klaffbron' };
    const c = { ...a, t: 1001 };
    const compared = compareEvents([a], [b], (n) => `${n.mmsi}|${n.bridge}`, []);
    expect(compared.pairs).toHaveLength(0);
    expect(compared.unmatchedField).toEqual([a]);
    expect(compared.unmatchedReplay).toEqual([b]);
    expect(splitAtStop([a, c], 1000)).toEqual({ observed: [a], afterStop: [c] });
  });

  test.each([0, 1, 2])('borttagen post %s förskjuter inte följande händelser med samma identitet', (removed) => {
    const field = [1000, 61000, 181000].map((t) => ({ t, mmsi: '1', bridge: 'Klaffbron' }));
    const replay = field.filter((e, i) => i !== removed).map((e) => ({ ...e, t: e.t + 100 }));
    const key = (n) => `${n.mmsi}|${n.bridge}`;
    const result = compareEvents(field, replay, key, []);
    expect(result.pairs.map((p) => p.deltaMs)).toEqual([100, 100]);
    expect(result.unmatchedField).toEqual([field[removed]]);
    expect(result.unmatchedReplay).toEqual([]);
    const reverse = compareEvents(replay, field, key, []);
    expect(reverse.pairs.map((p) => p.deltaMs)).toEqual([-100, -100]);
    expect(reverse.unmatchedReplay).toEqual([field[removed]]);
  });

  test('ELFKUNGENs borttagna dubbelvarning blir inte en saknad OLA-varning', () => {
    const first = {
      t: 1000, bridge: 'Stridsbergsbron', leadVessel: 'ELFKUNGEN', direction: 'northbound',
    };
    const duplicate = { ...first, t: 3601000 };
    const south = { ...first, t: 7201000, direction: 'southbound' };
    const ola = { ...first, t: 10801000, leadVessel: 'OLA' };
    const result = compareEvents([first, duplicate, south, ola], [first, south, ola], openingKeyOf, ['leadVessel', 'direction']);
    expect(result.pairs).toHaveLength(3);
    expect(result.pairs.every((p) => p.changes.length === 0 && p.deltaMs === 0)).toBe(true);
    expect(result.unmatchedField).toEqual([duplicate]);
    expect(result.unmatchedReplay).toEqual([]);
  });

  test('inferred-korsning publicerar bara felgränser, aldrig ett exakt ETA-fel', () => {
    const n = {
      t: 100000, mmsi: '1', bridge: 'Stridsbergsbron', direction: 'southbound', eta: 3,
    };
    const p = {
      mmsi: '1', bridge: 'Stridsbergsbron', kind: 'line', dir: 'syd', inferred: true, t: 400000, tFrom: 300000, tTo: 900000,
    };
    const [r] = measureClaims([n], [p]);
    expect(r.measurement).toBe('interval-only');
    expect(r.errorMinutes).toBeUndefined();
    expect(r.leadTimeMinutes).toEqual({ from: 200000 / 60000, to: 800000 / 60000 });
  });
});

describe('P9: gles korsning med stillhet har fönster som facit', () => {
  const station = BRIDGE_STATIONS.find((b) => b.name === 'Stridsbergsbron');
  function cross(gapS, sogP, sogQ) {
    const t = Date.parse('2026-08-24T14:50:18.000Z');
    const p = {
      mmsi: '276015380', name: 'PHOENIX', s: station.s + 85, lat: 58.29415, lon: 12.29556, sog: sogP, t, tFix: t, offsetM: 0, feed: 'aisstream',
    };
    const q = {
      ...p, s: station.s - 236, lat: 58.29125, sog: sogQ, t: t + gapS * 1000, tFix: t + gapS * 1000,
    };
    return crossingsForVessel([p, q]).find((x) => x.bridge === station.name);
  }

  test('PHOENIX-klassen behåller korsningen och hela 721-sekundersfönstret', () => {
    const r = cross(721, 0, 6);
    expect(r.inferred).toBe(true);
    expect(r.inferredReason).toBe('sparse-stopped-endpoint');
    expect(r.tTo - r.tFrom).toBe(721000);
    expect(r.dir).toBe('syd');
  });

  test('stopp i andra ändpunkten ger samma osäkerhet; båten kan ha väntat efter bron', () => {
    expect(cross(721, 6, 0).inferred).toBe(true);
  });

  test('tätt nollfartsfix ändrar inte punktfacit; exakt tidsgräns är 120 s', () => {
    expect(cross(120, 0, 6).inferred).toBe(false);
    expect(cross(120.001, 0, 6).inferred).toBe(true);
  });

  test('rörelse i båda ändar, saknad SOG och exakt 0,5 kn fabricerar inte stillhet', () => {
    expect(cross(721, 4, 6).inferred).toBe(false);
    expect(cross(721, null, 6).inferred).toBe(false);
    expect(cross(721, 0.5, 6).inferred).toBe(false);
    expect(cross(721, -1, 6).inferred).toBe(false);
  });

  test('gamla regeln över 900 s fungerar även utan stillhetsbevis', () => {
    expect(cross(901, 4, 6).inferred).toBe(true);
  });
});
