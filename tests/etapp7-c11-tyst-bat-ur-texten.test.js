'use strict';

jest.mock('homey');

/**
 * Etapp 7 fas C — C11/C11b/H-3 (U1: "en båt som slutar skicka aktiva
 * AIS-signaler ska tas bort ur texten").
 *
 * TRE SEPARATA KONTRAKT, MED SINA MÄTTA VERKNINGSGRADER:
 *
 * C11 — imminent-flaggans KONSUMTION grindas på positionsålder.
 *   Mätt över 18 korpusar (~320 h): 0 av 10 087 imminent-konsumtioner hade en
 *   position äldre än STALE_ETA_HARD, eftersom app-lagret redan sätter flaggan
 *   bakom samma grind. Gaten är alltså LATENT — ett djupförsvar mot
 *   omvärderingsloopens per-fartygs-catch, inte en verkanshöjare. Den bevisas
 *   därför av enhetstest, inte av korpusdiff.
 *
 * C11b — staleDisplayLimit-trappans PROXIMITETSGRENAR får bara förlängas av en
 *   bro fartyget INTE redan passerat (VALKYRIA-blackouten).
 *   Mätt: 13 extra fartygsepisoder ur texten i 18 korpusar, 48,78
 *   väggklockeminuter, 0 notiser och 0 öppningsvarningar rörda.
 *
 * H-3 — det döda `inväntar broöppning`-alternativet ur INV-1:s grammatik.
 *   Mätt före borttagningen: 0 av 2 150 publicerade texter innehöll strängen.
 *
 * BT-4 — samma trappas MITT-I-PASSAGE-nivå kräver att bron ligger FRAMFÖR
 *   fartyget (utanför under-bridge-bandet). C11b:s passage-BOKFÖRING räcker
 *   inte: AKLEJA hade en enda fix och hann aldrig bli bokförd som passerad.
 *   Mätt: EN textdiff i 18 korpusar (SABETH, 20260610-19h), 0 notiser rörda.
 */

const BridgeTextService = require('../lib/services/BridgeTextService');
const VesselDataService = require('../lib/services/VesselDataService');
const geometry = require('../lib/utils/geometry');
const { UI_CONSTANTS, BRIDGES, UNDER_BRIDGE_CLEAR_DISTANCE } = require('../lib/constants');
const { formatETABroOpeningClause } = require('../lib/utils/etaValidation');
const { validateInvariants } = require('./replay-validation/invariants');

const makeLogger = () => ({ log: jest.fn(), debug: jest.fn(), error: jest.fn() });
const HARD = UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS;

// ---------------------------------------------------------------------------
// C11 — imminent får inte konsumeras av en tyst båt
// ---------------------------------------------------------------------------
describe('C11: imminent-flaggan kräver FÄRSK position vid konsumtionen', () => {
  const svc = () => new BridgeTextService(null, makeLogger());

  const vessel = (over) => ({
    mmsi: '275049245',
    targetBridge: 'Klaffbron',
    etaMinutes: null,
    passedBridges: [],
    _isImminentAtTargetBridge: true,
    ...over,
  });

  test('färsk position (1 min) → imminent ger "strax" (oförändrat beteende)', () => {
    const text = svc().generateBridgeText([vessel({ timestamp: Date.now() - 60 * 1000 })]);
    expect(text).toBe('En båt på väg mot Klaffbron, beräknad broöppning strax');
  });

  test('tyst båt (11 min) → "strax" faller till ärlig "ETA okänd"', () => {
    const text = svc().generateBridgeText([vessel({ timestamp: Date.now() - 11 * 60 * 1000 })]);
    expect(text).toBe('En båt på väg mot Klaffbron, ETA okänd');
    expect(text).not.toContain('strax');
  });

  test('gränsen ÄR STALE_ETA_HARD — exakt på gränsen färsk, 1 ms över stale', () => {
    // Mutationsbevis: flyttas grinden ens en millisekund byter båda raderna
    // svar. Talet härleds ur UI_CONSTANTS, aldrig ur en lokal kopia.
    const at = svc().generateBridgeText([vessel({ timestamp: Date.now() - HARD })]);
    const over = svc().generateBridgeText([vessel({ timestamp: Date.now() - HARD - 1000 })]);
    expect(at).toContain('strax');
    expect(over).toContain('ETA okänd');
  });

  test('lastPositionUpdate räknas också (F4-E:s bekräftade-position-klocka)', () => {
    // En väntande båt som sänder OFÖRÄNDRAD position är färsk — samma klocka
    // som app.js `_lastConfirmedPositionMs` (max av de två fälten).
    const text = svc().generateBridgeText([vessel({
      timestamp: Date.now() - 30 * 60 * 1000,
      lastPositionUpdate: Date.now() - 60 * 1000,
    })]);
    expect(text).toContain('strax');
  });

  test('gruppsemantiken består: EN färsk imminent båt räcker för hela gruppen', () => {
    // F45-kontraktet får inte rivas av C11 — grinden är per fartyg, inte per
    // grupp. Tyst båt A + färsk imminent båt B ⇒ gruppen är fortfarande imminent.
    const text = svc().generateBridgeText([
      vessel({ mmsi: '1', timestamp: Date.now() - 20 * 60 * 1000, etaMinutes: 9 }),
      vessel({ mmsi: '2', timestamp: Date.now() - 60 * 1000 }),
    ]);
    expect(text).toContain('Två båtar på väg mot Klaffbron');
    expect(text).toContain('strax');
  });

  test('ALLA imminenta båtar tysta ⇒ gruppen tappar "strax"', () => {
    const text = svc().generateBridgeText([
      vessel({ mmsi: '1', timestamp: Date.now() - 20 * 60 * 1000, etaMinutes: 9 }),
      vessel({ mmsi: '2', timestamp: Date.now() - 20 * 60 * 1000 }),
    ]);
    expect(text).toBe('Två båtar på väg mot Klaffbron, beräknad broöppning om 9 minuter');
  });

  test('fixtur helt utan tidsstämplar behandlas som färsk (bakåtkompatibilitet)', () => {
    const text = svc().generateBridgeText([vessel({})]);
    expect(text).toContain('strax');
  });

  test('SSOT-hjälparen är oförändrad — grinden ligger MEDVETET hos anroparen', () => {
    // C11 flyttar ingen semantik in i formatETABroOpeningClause: `imminent` är
    // en grupp-OR utan egen positionsålder. Kontraktet dokumenteras i
    // etaValidation och LÅSES här så en framtida "förenkling" inte tar bort
    // övertrumfningen (som uttömd extrapolering är beroende av).
    expect(formatETABroOpeningClause(null, { imminent: true })).toBe('beräknad broöppning strax');
    expect(formatETABroOpeningClause(null, {})).toBe('ETA okänd');
  });
});

// ---------------------------------------------------------------------------
// C11b — staleDisplayLimit-trappan
// ---------------------------------------------------------------------------
describe('C11b: en PASSERAD bro får inte förlänga visningstiden', () => {
  // Riktigt broregister (geometri = produktionens) via en minimal mock som
  // bär exakt det API trappan konsumerar.
  function makeVDS() {
    const svc = Object.create(VesselDataService.prototype);
    svc.logger = makeLogger();
    svc.vessels = new Map();
    svc._logDebounce = new Map();
    svc._logRepeatCount = new Map();
    svc.bridgeRegistry = {
      isValidTargetBridge: (n) => ['Klaffbron', 'Stridsbergsbron'].includes(n),
      getAllBridgeIds: () => Object.keys(BRIDGES),
      getBridge: (id) => BRIDGES[id],
      getBridgeByName: (n) => Object.values(BRIDGES).find((b) => b.name === n) || null,
    };
    svc._isVesselNearStallbackabron = () => false;
    svc._isVesselSuitableForBridgeText = () => true;
    return svc;
  }

  const show = (vessel) => {
    const svc = makeVDS();
    svc.vessels.set(vessel.mmsi, vessel);
    return svc.getVesselsForBridgeText().map((v) => v.mmsi);
  };

  const ageMin = (m) => ({ timestamp: Date.now() - m * 60 * 1000, lastPositionUpdate: Date.now() - m * 60 * 1000 });

  // RÅDATA (korpus #18, ais-20260806-42h.jsonl): sista sampel någonsin
  // 2026-08-07T15:19:13.221Z lat 58.27451 lon 12.27816 sog 5,5 cog 38,7.
  // 265 m N om Olidebron (passerad), 1 118 m från målbron Klaffbron.
  const VALKYRIA = (over) => ({
    mmsi: '275049245',
    name: 'VALKYRIA',
    lat: 58.27451,
    lon: 12.27816,
    sog: 5.5,
    targetBridge: 'Klaffbron',
    status: 'en-route',
    passedBridges: ['Olidebron'],
    ...over,
  });

  test('VALKYRIA-fallet: 16 min tyst bakom passerad Olidebron ⇒ UR texten', () => {
    expect(show(VALKYRIA(ageMin(16)))).toHaveLength(0);
  });

  test('samma båt inom 15 min visas fortfarande (målbro-nivån är orörd)', () => {
    // C11b sänker henne 20 → 15 min, inte 20 → 10. Aktiv transit med gles
    // Class B-kadens (6–13 min) får alltså fortfarande sitt fönster.
    expect(show(VALKYRIA(ageMin(14)))).toContain('275049245');
  });

  test('MUTATIONSBEVIS: utan Olidebron i passedBridges behålls hon i 20 min', () => {
    // Exakt samma position och ålder — enda skillnaden är passage-bokföringen.
    // Raden faller om `skipPassed` tas bort ur trappan, för då blir de två
    // fallen identiska.
    expect(show(VALKYRIA({ ...ageMin(16), passedBridges: [] }))).toContain('275049245');
  });

  test('F4-I/BELUGA-klassen består: tyst UNDER en OPASSERAD mellanbro visas i 20 min', () => {
    // BELUGA tystnade under Järnvägsbron med målbro Klaffbron 1+ km bort och
    // 4+ kn (kö-klassen missar henne). Släpptes hon vid 15 min föll texten
    // "Fyra båtar"→"Tre båtar" mitt i bevisad transit.
    const beluga = {
      mmsi: '111111111',
      name: 'BELUGA',
      lat: BRIDGES.jarnvagsbron.lat,
      lon: BRIDGES.jarnvagsbron.lon,
      sog: 4.5,
      targetBridge: 'Klaffbron',
      status: 'en-route',
      passedBridges: ['Stridsbergsbron'],
      ...ageMin(18),
    };
    expect(show(beluga)).toContain('111111111');
  });

  test('kö-klassen består när en OPASSERAD bro också ligger inom 600 m (IN-AXXI)', () => {
    // IN-AXXI låg 42 m från en passerad bro — men 215 m från en opasserad.
    // Kö-nivån (25 min) ska då stå kvar oförändrad.
    const inaxxi = {
      mmsi: '244130745',
      name: 'IN-AXXI',
      lat: BRIDGES.stridsbergsbron.lat - 0.0019, // ~211 m S om Stridsbergsbron
      lon: BRIDGES.stridsbergsbron.lon,
      sog: 2.4,
      targetBridge: 'Klaffbron',
      status: 'en-route',
      passedBridges: ['Stridsbergsbron'],
      ...ageMin(22),
    };
    expect(show(inaxxi)).toContain('244130745');
  });

  test('NO LIMIT-grenen (sog < 1,5) är OFÖRÄNDRAD — även bakom passerade broar', () => {
    // Stillhetsgrenen har ingen geometri och rörs INTE av C11b. Mätt
    // alternativ (V2: kräv opasserad bro inom 600 m även här) gav 10 min i
    // 320 h — försumbart mot risken att riva ankrade glesa sändares skydd.
    const noLimit = {
      mmsi: '211380900',
      name: 'NO LIMIT',
      lat: 58.27451,
      lon: 12.27816,
      sog: 1.2,
      targetBridge: 'Klaffbron',
      status: 'en-route',
      passedBridges: ['Olidebron'],
      ...ageMin(22),
    };
    expect(show(noLimit)).toContain('211380900');
  });

  test('_distanceToNearestRegistryBridge: skipPassed hoppar passerade broar', () => {
    const svc = makeVDS();
    const v = VALKYRIA({});
    const dAll = svc._distanceToNearestRegistryBridge(v);
    const dUnpassed = svc._distanceToNearestRegistryBridge(v, { skipPassed: true });
    expect(Math.round(dAll)).toBe(265); // Olidebron
    expect(Math.round(dUnpassed)).toBe(1118); // Klaffbron
  });

  test('_distanceToNearestRegistryBridge: null när ALLA broar är passerade', () => {
    const svc = makeVDS();
    const v = VALKYRIA({ passedBridges: Object.values(BRIDGES).map((b) => b.name) });
    expect(svc._distanceToNearestRegistryBridge(v, { skipPassed: true })).toBeNull();
    expect(svc._distanceToNearestRegistryBridge(v)).not.toBeNull();
  });

  test('saknad/ogiltig passedBridges kraschar inte och beter sig som "inget passerat"', () => {
    const svc = makeVDS();
    const v = VALKYRIA({ passedBridges: undefined });
    expect(Math.round(svc._distanceToNearestRegistryBridge(v, { skipPassed: true }))).toBe(265);
  });

  // -------------------------------------------------------------------------
  // BT-4 — bäringsvillkoret på mitt-i-passage-nivån
  // -------------------------------------------------------------------------
  describe('BT-4: 20-min-nivån kräver en bro FRAMFÖR båten (eller under henne)', () => {
    // Punkt `meters` meter från `from` längs axeln `from`→`to`. Kanalen är rak
    // nog mellan grannbroar att den linjära interpolationen ger < 1 % fel —
    // varje fixtur asserterar sitt faktiska avstånd nedan.
    const along = (from, to, meters) => {
      const total = geometry.calculateDistance(from.lat, from.lon, to.lat, to.lon);
      const f = meters / total;
      return { lat: from.lat + f * (to.lat - from.lat), lon: from.lon + f * (to.lon - from.lon) };
    };
    const distTo = (v, b) => geometry.calculateDistance(v.lat, v.lon, b.lat, b.lon);

    // (i) AKLEJA-fallet. RÅDATA (söndagsfältet 2026-08-09, 265533390): EN enda
    // fix i hela körningen — 4,3 kn, 220 m NNO om Olidebron (alltså redan
    // förbi den), målbro Klaffbron ~1,1 km bort. passedBridges är TOM: appen
    // såg aldrig passagen, så C11b:s `skipPassed` biter inte.
    const aklejaPos = along(BRIDGES.olidebron, BRIDGES.klaffbron, 220);
    const AKLEJA = (over) => ({
      mmsi: '265533390',
      name: 'AKLEJA',
      lat: aklejaPos.lat,
      lon: aklejaPos.lon,
      sog: 4.3,
      targetBridge: 'Klaffbron',
      status: 'en-route',
      passedBridges: [],
      _routeDirection: 'north',
      ...over,
    });

    test('GEOMETRIN i AKLEJA-fixturen är fältets (220 m från Olidebron, målbron långt bort)', () => {
      const v = AKLEJA({});
      expect(Math.round(distTo(v, BRIDGES.olidebron))).toBe(220);
      expect(Math.round(distTo(v, BRIDGES.klaffbron))).toBeGreaterThan(300);
      expect(v.lat).toBeGreaterThan(BRIDGES.olidebron.lat); // norr om = bakom en nordgående
    });

    test('rörlig båt NORR om (= förbi) Olidebron nordgående ⇒ 15-min-nivån, inte 20', () => {
      expect(show(AKLEJA(ageMin(16)))).toHaveLength(0);
      expect(show(AKLEJA(ageMin(14)))).toContain('265533390'); // målbro-nivån orörd
    });

    test('SPEGELBEVIS: samma båt SÖDER om Olidebron (bron framför) behåller 20 min', () => {
      // Enda skillnaden mot raden ovan är vilken sida av bron fixen ligger på.
      // Faller raden är det bäringen — inte farten, inte avståndet — som styr.
      const pos = along(BRIDGES.olidebron, BRIDGES.klaffbron, -220);
      const v = AKLEJA({ ...ageMin(16), lat: pos.lat, lon: pos.lon });
      expect(Math.round(distTo(v, BRIDGES.olidebron))).toBe(220);
      expect(show(v)).toContain('265533390');
    });

    test('BAKÅTKOMPATIBILITET: utan känd ruttriktning behålls 20-minutersnivån', () => {
      // Konservativ fallback — BT-4 får bara skära bort fall där riktningen ÄR
      // känd. (Det är också varför C11b-raderna ovan är oförändrade.)
      expect(show(AKLEJA({ ...ageMin(16), _routeDirection: undefined }))).toContain('265533390');
    });

    // (ii) PAX — nivåns dokumenterade grundfall (INV-14/korpus #7): 182 m
    // FRAMFÖR sin målbro Stridsbergsbron, 5,4 kn. Ett rent farttak (variant B)
    // fällde henne; bäringsvillkoret får inte göra om det misstaget.
    const paxPos = along(BRIDGES.stridsbergsbron, BRIDGES.jarnvagsbron, 182);
    const PAX = (over) => ({
      mmsi: '265515160',
      name: 'PAX',
      lat: paxPos.lat,
      lon: paxPos.lon,
      sog: 5.4,
      targetBridge: 'Stridsbergsbron',
      status: 'approaching',
      passedBridges: ['Klaffbron', 'Järnvägsbron'],
      _routeDirection: 'north',
      ...over,
    });

    test('PAX-fallet: 182 m framför OPASSERAD målbro ⇒ 20-min-nivån KVAR', () => {
      const v = PAX(ageMin(18));
      expect(Math.round(distTo(v, BRIDGES.stridsbergsbron))).toBe(182);
      expect(v.lat).toBeLessThan(BRIDGES.stridsbergsbron.lat); // bron framför
      expect(show(v)).toContain('265515160');
    });

    test('PAX-nivån är FARTOBEROENDE — 5,4 och 12 kn ger samma svar', () => {
      // Direkt motbevis mot variant B: farten diskriminerar inte insegling.
      expect(show(PAX(ageMin(18)))).toContain('265515160');
      expect(show(PAX({ ...ageMin(18), sog: 12 }))).toContain('265515160');
    });

    // (iii)+(iv) F4-I/BELUGA — under-bridge-bandet. Sydgående med målbro
    // Klaffbron ~900 m bort; Järnvägsbron ligger BAKOM henne i färdriktningen,
    // så bara bandundantaget kan hålla henne kvar.
    const BELUGA = (meters, over) => {
      const pos = along(BRIDGES.jarnvagsbron, BRIDGES.klaffbron, meters);
      return {
        mmsi: '111111111',
        name: 'BELUGA',
        lat: pos.lat,
        lon: pos.lon,
        sog: 4.5,
        targetBridge: 'Klaffbron',
        status: 'en-route',
        passedBridges: ['Stridsbergsbron'],
        _routeDirection: 'south',
        ...ageMin(18),
        ...over,
      };
    };

    test('BELUGA: 4,5 kn INOM 70 m (bron bakom) ⇒ 20-min-nivån KVAR', () => {
      const v = BELUGA(UNDER_BRIDGE_CLEAR_DISTANCE);
      expect(distTo(v, BRIDGES.jarnvagsbron)).toBeLessThanOrEqual(UNDER_BRIDGE_CLEAR_DISTANCE);
      expect(v.lat).toBeLessThan(BRIDGES.jarnvagsbron.lat); // sydgående ⇒ bron bakom
      expect(Math.round(distTo(v, BRIDGES.klaffbron))).toBeGreaterThan(300); // målbron kvalar inte
      expect(show(v)).toContain('111111111');
    });

    test('GRÄNSEN ÄR UNDER_BRIDGE_CLEAR_DISTANCE: 70 m kvar, 71 m ur texten', () => {
      // Mutationsbevis: flyttas bandet byter de två raderna svar. Talet
      // härleds ur constants, aldrig ur en lokal kopia.
      const inside = BELUGA(UNDER_BRIDGE_CLEAR_DISTANCE);
      const outside = BELUGA(UNDER_BRIDGE_CLEAR_DISTANCE + 1);
      expect(distTo(outside, BRIDGES.jarnvagsbron)).toBeGreaterThan(UNDER_BRIDGE_CLEAR_DISTANCE);
      expect(show(inside)).toContain('111111111');
      expect(show(outside)).toHaveLength(0);
    });

    test('utanför bandet räddas hon ändå om bron ligger FRAMFÖR (norr om, sydgående)', () => {
      // 100 m norr om Järnvägsbron på sydlig kurs = insegling ⇒ nivån gäller,
      // trots att hon är utanför under-bridge-bandet.
      const v = BELUGA(-100);
      expect(v.lat).toBeGreaterThan(BRIDGES.jarnvagsbron.lat);
      expect(show(v)).toContain('111111111');
    });
  });

  test('PELARE 3 ORÖRD: borttagningen är ENBART presentation — fartyget lever kvar internt', () => {
    // C11×C8-paret: en tyst båt ska lämna TEXTEN men får inte försvinna ur
    // det tillstånd öppningsmotorn läser (tystnadsgarantin). Filtret är per
    // konstruktion en projektion av `this.vessels` — objektet ligger kvar och
    // dedup/failsafe/armar överlever. Replay-belägget: öppningsvarningarna är
    // BYTE-IDENTISKA i samtliga 18 korpusar före och efter C11b.
    const svc = makeVDS();
    const v = VALKYRIA(ageMin(16));
    svc.vessels.set(v.mmsi, v);
    expect(svc.getVesselsForBridgeText()).toHaveLength(0);
    expect(svc.vessels.get('275049245')).toBe(v);
    expect(svc.getAllVessels().map((x) => x.mmsi)).toContain('275049245');
  });
});

// ---------------------------------------------------------------------------
// H-3 — död alternering ur INV-1:s grammatik
// ---------------------------------------------------------------------------
describe('H-3: "inväntar broöppning" är borta ur INV-1:s grammatik', () => {
  const t = (text) => ({ iso: '2026-08-09T00:00:00.000Z', t: 0, text });

  test('frasen fälls nu som OKÄND KLAUSUL', () => {
    const v = validateInvariants({ bridgeTextTransitions: [t('En båt på väg mot Klaffbron, inväntar broöppning')] });
    expect(v.some((x) => x.includes('OKÄND KLAUSUL'))).toBe(true);
  });

  test('SSOT:n kan aldrig producera frasen — svep över hela värdemängden', () => {
    const values = [null, undefined, NaN, Infinity, -5, 0, 0.4, 1, 2.9, 3, 4.5, 30, 120, 1439, 1440, 1441];
    const flags = [{}, { imminent: true }, { extrapolated: true }, { imminent: true, extrapolated: true }];
    for (const v of values) {
      for (const f of flags) {
        expect(formatETABroOpeningClause(v, f)).not.toContain('inväntar');
      }
    }
  });

  test('POSITIV KOPPLING: varje klausul SSOT:n kan ge accepteras av grammatiken', () => {
    // Skyddar mot att H-3 (eller en framtida skärpning) gör grammatiken
    // SNÄVARE än produktionen — då hade grinden fällt äkta texter.
    const values = [null, 0.4, 1, 2.9, 3, 4.5, 30, 120, 999];
    const flags = [{}, { imminent: true }, { extrapolated: true }];
    const texts = [];
    for (const v of values) {
      for (const f of flags) {
        texts.push(t(`En båt på väg mot Klaffbron, ${formatETABroOpeningClause(v, f)}`));
        texts.push(t(`Tre båtar på väg mot Stridsbergsbron, ${formatETABroOpeningClause(v, f)}`));
      }
    }
    const v = validateInvariants({ bridgeTextTransitions: texts });
    expect(v.filter((x) => x.includes('OKÄND KLAUSUL'))).toEqual([]);
  });
});
