'use strict';

/**
 * M24 (helkodsgranskning runda 4, 2026-08-23) — INV-14 GICK TYST NÄR EN FALSK
 * "Inga båtar"-EPISOD VÄXTE.
 *
 * DEFEKTEN: INV-14 lämnade loopen INNAN signaturkontrollen så snart den
 * inklämda DEFAULT-episoden var längre än 300 s. Det egentliga beviset är
 * SIGNATUREN (samma målbro + samma antal-ord före och efter, ingen passage
 * emellan); tidstaket ströp bara de allvarligaste fallen. Följden var att
 * grinden rapporterade FÄRRE brott när en regression FÖRLÄNGDE en falsk
 * episod — mätvärdet förbättrades medan pelare 1 försämrades. Uppmätt på
 * HEAD 0b72310: 60/200/299 s gav 1 brott, 301/360/900/3600 s gav 0.
 *
 * FIXEN: taket är kvar som gräns för den FÄLLANDE klassen (violation-facit
 * och samtliga golden-filer står orörda) men längre spann tystas inte längre
 * — de rapporteras av INV-14W i WARN-lagret, som aldrig fäller.
 *
 * INV-14 hade före det här paketet NOLL direkt enhetstäckning, vilket är en
 * del av förklaringen till att inversionen kunde ligga kvar. Testerna nedan
 * täcker BÅDA klasserna och framför allt ÖVERGÅNGEN mellan dem: det är exakt
 * där defekten bodde.
 */

const { validateInvariants, validateWarnInvariants } = require('./replay-validation/invariants');

const T0 = new Date('2026-08-23T10:00:00Z').getTime();
const DEFAULT_MESSAGE = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';
const KLAFF = 'En båt på väg mot Klaffbron, beräknad broöppning om 6 minuter';
const STRIDS = 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 9 minuter';

const rad = (tOffsetS, text) => ({
  t: T0 + tOffsetS * 1000,
  iso: new Date(T0 + tOffsetS * 1000).toISOString(),
  text,
});

function baseResult(overrides = {}) {
  return {
    bridgeTextTransitions: [],
    notifications: [],
    targetPassages: [],
    journeyResets: [],
    firstNameSeen: {},
    ...overrides,
  };
}

/**
 * En falsk "Inga båtar"-episod: samma signatur före och efter, ingen passage
 * emellan. `spanS` är DEFAULT-textens egen varaktighet — den storhet både
 * INV-14 och INV-14W mäter.
 */
function sandwich(spanS, { text = KLAFF, targetPassages = [] } = {}) {
  return baseResult({
    bridgeTextTransitions: [rad(0, text), rad(60, DEFAULT_MESSAGE), rad(60 + spanS, text)],
    targetPassages,
  });
}

const fatala = (r) => validateInvariants(r).filter((x) => x.startsWith('DEFAULT-FLASH'));
const varnande = (r) => validateWarnInvariants(r).filter((x) => x.includes('INV-14W'));

describe('M24: INV-14 fäller korta falska DEFAULT-episoder (oförändrat facit)', () => {
  // Taket är MEDVETET orört — hela poängen med M24 är att INGEN omlåsning
  // krävs. Skulle någon av de här sifforna ändras rör sig violation-facit och
  // golden-filerna med dem.
  test.each([30, 60, 200, 299, 300])('%i s inklämd DEFAULT är ett BROTT', (spanS) => {
    const hits = fatala(sandwich(spanS));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/Klaffbron/);
    expect(hits[0]).toMatch(new RegExp(`\\(${spanS}s\\)`));
  });

  test('en registrerad målbropassage emellan gör episoden legitim', () => {
    const r = sandwich(120, {
      targetPassages: [{
        mmsi: '265000001', bridge: 'Klaffbron', t: T0 + 90000, iso: new Date(T0 + 90000).toISOString(),
      }],
    });
    expect(fatala(r)).toEqual([]);
    expect(varnande(r)).toEqual([]);
  });

  test('OLIKA signatur före och efter är inte en flash', () => {
    const r = baseResult({
      bridgeTextTransitions: [rad(0, KLAFF), rad(60, DEFAULT_MESSAGE), rad(120, STRIDS)],
    });
    expect(fatala(r)).toEqual([]);
    expect(varnande(r)).toEqual([]);
  });
});

describe('M24: grinden går INTE tyst när episoden växer förbi taket', () => {
  // MUTATIONSPROVET. På HEAD gav den här serien 1 → 0 utslag: att förlänga
  // den falska episoden FÖRBÄTTRADE mätvärdet. Efter fixen finns episoden
  // alltid kvar i rapporten, den byter bara klass vid taket.
  test.each([60, 200, 299, 300, 301, 360, 611, 900, 3506, 3600, 16241])(
    'en %i s falsk episod syns i EXAKT en av klasserna — aldrig i ingen',
    (spanS) => {
      const r = sandwich(spanS);
      const antalUtslag = fatala(r).length + varnande(r).length;
      expect(antalUtslag).toBe(1);
    },
  );

  test('övergången vid taket flyttar utslaget från fatal till WARN — inte till tystnad', () => {
    const straxUnder = sandwich(300);
    const straxOver = sandwich(301);
    expect(fatala(straxUnder)).toHaveLength(1);
    expect(varnande(straxUnder)).toEqual([]);
    expect(fatala(straxOver)).toEqual([]);
    expect(varnande(straxOver)).toHaveLength(1);
  });

  test('WARN-raden bär spannlängd och bro så en granskare kan triagera', () => {
    // Ett spann strax över taket är misstänkt; ett spann på timmar är normalt
    // tomt vatten. Utan siffran i raden går de inte att skilja åt.
    const hits = varnande(sandwich(3506, { text: KLAFF }));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/3506s/);
    expect(hits[0]).toMatch(/58\.4 min/);
    expect(hits[0]).toMatch(/Klaffbron/);
  });

  test('INV-14W fäller aldrig — den ligger i WARN-lagret, inte bland violations', () => {
    const r = sandwich(3600);
    expect(validateInvariants(r)).toEqual([]);
    expect(varnande(r)).toHaveLength(1);
  });
});

describe('M24: identitetsbindningen mot rådatafacit', () => {
  // Den riktiga diskriminatorn vore MMSI, men bridgeTextTransitions bär bara
  // {t, iso, text}. Bindningen sker därför mot rådatafacit precis som INV-21:
  // en VERKLIG passage av bron i glappet betyder att den tidigare resan
  // avslutades där, och klausulen efteråt tillhör ett annat fartyg.
  const gt = (tOffsetS, overrides = {}) => ([{
    mmsi: '265000001',
    bridge: 'Klaffbron',
    t: T0 + tOffsetS * 1000,
    iso: new Date(T0 + tOffsetS * 1000).toISOString(),
    ...overrides,
  }]);

  test('rådatapassage i glappet tystar WARN (annan båt efteråt)', () => {
    const r = sandwich(3506);
    expect(validateWarnInvariants(r, gt(1200)).filter((x) => x.includes('INV-14W'))).toEqual([]);
  });

  test('rådatapassage av ANNAN bro tystar inte', () => {
    const r = sandwich(3506);
    const hits = validateWarnInvariants(r, gt(1200, { bridge: 'Stridsbergsbron' }))
      .filter((x) => x.includes('INV-14W'));
    expect(hits).toHaveLength(1);
  });

  test('rådatapassage UTANFÖR glappet tystar inte', () => {
    const r = sandwich(3506);
    const hits = validateWarnInvariants(r, gt(99999)).filter((x) => x.includes('INV-14W'));
    expect(hits).toHaveLength(1);
  });

  test('`inferred`- och `zone`-poster duger inte som bevis (tid utan precision)', () => {
    // Samma uteslutning som INV-21 gör: en inferred-post är ett FÖNSTER, inte
    // en tidpunkt, och en zonpost är ingen brokorsning.
    const r = sandwich(3506);
    for (const bad of [gt(1200, { inferred: true }), gt(1200, { kind: 'zone' })]) {
      expect(validateWarnInvariants(r, bad).filter((x) => x.includes('INV-14W'))).toHaveLength(1);
    }
  });

  test('utan rådatafacit rapporteras spannet ändå, med markering', () => {
    // WARN fäller aldrig, så priset för en falsk varnare är noll — men
    // granskaren måste se att bindningen inte kördes.
    const hits = varnande(sandwich(3506));
    expect(hits[0]).toMatch(/identitetsbindning ej körd/);
  });
});
