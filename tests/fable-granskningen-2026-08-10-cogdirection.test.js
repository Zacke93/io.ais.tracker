'use strict';

jest.mock('homey');

const fs = require('fs');
const path = require('path');

const {
  isNorthCog, isSouthCogStrict, isSouthCogWide, isSouthCogToken, COG_BANDS,
} = require('../lib/utils/cogDirection');
const { COG_DIRECTIONS } = require('../lib/constants');

const AISBridgeApp = require('../app');
const PassageLatchService = require('../lib/services/PassageLatchService');
const RouteOrderValidator = require('../lib/services/RouteOrderValidator');
const VesselDataService = require('../lib/services/VesselDataService');
const VesselLifecycleManager = require('../lib/services/VesselLifecycleManager');

/**
 * Fable-granskningen 2026-08-10 (FG-DIR) — RIKTNING-UR-COG SOM PREDIKATFAMILJ.
 *
 * FÖRE: 26 jämförelseuttryck på ~14 ställen i app.js + lib/services jämförde
 * cog mot hårdkodade gradtal. FYRA olika band förekom, och skillnaderna var
 * MEDVETNA (P5-beslutet i lib/constants.js, FP8-snävningen i
 * _getDirectionString, GR2-6-harmoniseringen i latch/validator,
 * ELFKUNGEN-motivet i _dedupDirection) — men avsikten stod bara i löpande
 * kommentarer bredvid siffrorna. Ett `135`-tal såg likadant ut oavsett om det
 * var höginsatsbandet eller token-fallbacken.
 *
 * EFTER: lib/utils/cogDirection.js med fyra namngivna predikat. Refaktorn är
 * REN — inget ställe ändrar utfall.
 *
 * Den här sviten låser TRE saker:
 *   (A) EXAKTA GRÄNSER per predikat, inklusivitet och allt (44/45/46,
 *       134/135, 225/226, 270/271, 314/315 …). Ett band som glider ska fälla
 *       ett test, inte upptäckas i ett fältprov.
 *   (B) ATT BANDEN ÄR OLIKA. Anti-harmoniseringsvakt: cog 250 och 300 måste
 *       ge OLIKA svar i de tre sydpredikaten. Den som "städar" ihop dem för
 *       konsekvensens skull ska mötas av ett rött test med motiveringen i.
 *   (C) BYTE-IDENTITET. Varje ren riktningsfunktion körs mot en REFERENS-
 *       implementation av de GAMLA literaluttrycken över hela kursvarvet —
 *       inklusive token-bandets bortstädade redundanta klausuler.
 * Plus (D): en källskanning som håller gradliteralerna borta i framtiden.
 */

// Sveptäckning: hela varvet i halvgradssteg + varje kritisk gräns med
// grannvärden på båda sidor (heltal OCH decimal — COG rapporteras i tiondels
// grader av AIS, JOSEPHINEs 226,7° är facit på att decimalerna spelar roll).
const SWEEP = (() => {
  const values = [];
  for (let c = 0; c < 360; c += 0.5) values.push(c);
  values.push(
    0, 0.1, 44, 44.9, 45, 45.1, 46,
    134, 134.9, 135, 135.1, 136,
    224, 224.9, 225, 225.1, 226, 226.7,
    269, 269.9, 270, 270.1, 271,
    313, 314, 314.7, 314.9, 315, 315.1, 316,
    359, 359.9,
  );
  return values;
})();

// REFERENSIMPLEMENTATIONER — ordagrant de uttryck som stod i koden före FG-DIR.
// De får ALDRIG ändras: de är facit för att refaktorn var ren.
const OLD = {
  north: (c) => c >= 315 || c <= 45,
  southStrict: (c) => c >= 135 && c <= 225,
  southWide: (c) => c >= 135 && c < 315,
  // Token-bandets ORIGINALFORM, med de två klausuler som FG-DIR visade var
  // bevisligt redundanta (135 > 45 och 270 < 315). De står kvar HÄR just för
  // att bevisa att borttagningen inte ändrade sanningsmängden.
  southToken: (c) => c > 45 && c < 315 && c >= 135 && c <= 270,
};

const normalize = (cog) => ((cog % 360) + 360) % 360;

// Facit-uttryckta i den GAMLA formen, en per anropsställes bandval.
function oldWideVerdict(cog) {
  if (OLD.north(cog)) return 'north';
  return OLD.southWide(cog) ? 'south' : null;
}

function oldStrictVerdict(cog) {
  if (OLD.north(cog)) return 'north';
  return OLD.southStrict(cog) ? 'south' : null;
}

function oldTokenVerdict(cog) {
  if (OLD.north(cog)) return 'northbound';
  return OLD.southToken(cog) ? 'southbound' : 'unknown';
}

describe('FG-DIR (A): exakta bandgränser per predikat', () => {
  describe('isNorthCog — 315–45 via 0°, båda gränser inklusiva', () => {
    test.each([
      [0, true], [0.1, true], [30, true], [44, true], [44.9, true], [45, true],
      [45.1, false], [46, false], [90, false], [180, false], [270, false],
      [313, false], [314, false], [314.9, false],
      [315, true], [315.1, true], [316, true], [359, true], [359.9, true],
    ])('cog %p → %p', (cog, expected) => {
      expect(isNorthCog(cog)).toBe(expected);
    });

    test('gränserna LÄSES ur COG_DIRECTIONS — ingen kopia av 315/45', () => {
      expect(COG_BANDS.NORTH_MIN).toBe(COG_DIRECTIONS.NORTH_MIN);
      expect(COG_BANDS.NORTH_MAX).toBe(COG_DIRECTIONS.NORTH_MAX);
      // Identitetslås mot dagens värden (P5-beslutet).
      expect(COG_DIRECTIONS.NORTH_MIN).toBe(315);
      expect(COG_DIRECTIONS.NORTH_MAX).toBe(45);
    });
  });

  describe('isSouthCogStrict — 135–225, BÅDA gränser inklusiva (P5 punkt 1)', () => {
    test.each([
      [44, false], [45, false], [46, false], [90, false],
      [134, false], [134.9, false], [135, true], [135.1, true], [136, true],
      [180, true],
      [224, true], [224.9, true], [225, true], [225.1, false], [226, false],
      [226.7, false], [250, false], [270, false], [300, false], [314, false],
      [315, false],
    ])('cog %p → %p', (cog, expected) => {
      expect(isSouthCogStrict(cog)).toBe(expected);
    });
  });

  describe('isSouthCogWide — 135 till <315, toppen EXKLUSIV (GR2-6/ELFKUNGEN)', () => {
    test.each([
      [45, false], [46, false], [134, false], [134.9, false],
      [135, true], [180, true], [225, true], [225.1, true], [226.7, true],
      [250, true], [270, true], [270.1, true], [271, true], [300, true],
      [313, true], [314, true], [314.7, true], [314.9, true],
      [315, false], [315.1, false], [316, false],
    ])('cog %p → %p', (cog, expected) => {
      expect(isSouthCogWide(cog)).toBe(expected);
    });

    test('toppen HÄRLEDS ur nordbandets start — banden får inte glida isär', () => {
      expect(COG_BANDS.SOUTH_WIDE_MAX_EXCLUSIVE).toBe(COG_DIRECTIONS.NORTH_MIN);
    });
  });

  describe('isSouthCogToken — 135–270, båda gränser inklusiva (FP8)', () => {
    test.each([
      [45, false], [46, false], [134, false], [134.9, false],
      [135, true], [180, true], [225, true], [226.7, true], [250, true],
      [269, true], [269.9, true], [270, true],
      [270.1, false], [271, false], [300, false], [314, false], [314.7, false],
      [315, false],
    ])('cog %p → %p', (cog, expected) => {
      expect(isSouthCogToken(cog)).toBe(expected);
    });
  });

  test('bandkonstanterna har de dokumenterade värdena', () => {
    expect(COG_BANDS.SOUTH_MIN).toBe(135);
    expect(COG_BANDS.SOUTH_STRICT_MAX).toBe(225);
    expect(COG_BANDS.SOUTH_TOKEN_MAX).toBe(270);
    expect(COG_BANDS.SOUTH_WIDE_MAX_EXCLUSIVE).toBe(315);
  });
});

describe('FG-DIR (B): banden är MEDVETET olika — anti-harmoniseringsvakt', () => {
  test('cog 250° (SV): tvetydig för målbrolåset, sydgående för token/dedup', () => {
    // Om detta test blir "alla tre true" har någon breddat höginsatsbandet:
    // P5 punkt 1 säger att fel målbro är dyrare än ingen målbro.
    expect(isSouthCogStrict(250)).toBe(false);
    expect(isSouthCogToken(250)).toBe(true);
    expect(isSouthCogWide(250)).toBe(true);
  });

  test('cog 300° (V/VNV): sydgående ENDAST i det breda bandet (FP8-snävningen)', () => {
    // Blir token true här har FP8-snävningen 314→270 rullats tillbaka;
    // blir wide false har dedup-/latch-bandet krympts utan HALIFAX/ELFKUNGEN-bevis.
    expect(isSouthCogStrict(300)).toBe(false);
    expect(isSouthCogToken(300)).toBe(false);
    expect(isSouthCogWide(300)).toBe(true);
  });

  test('JOSEPHINE 226,7° — sydgående i token-bandet, tvetydig i det strikta', () => {
    expect(isSouthCogToken(226.7)).toBe(true);
    expect(isSouthCogStrict(226.7)).toBe(false);
  });

  test('FP8 314,7° — INTE token-syd (0,3° från nordbandet), men wide-syd', () => {
    expect(isSouthCogToken(314.7)).toBe(false);
    expect(isSouthCogWide(314.7)).toBe(true);
    expect(isNorthCog(314.7)).toBe(false);
  });

  test('strikt ⊂ token ⊂ brett över hela varvet, och inget syd är nord', () => {
    for (const c of SWEEP) {
      if (isSouthCogStrict(c)) expect(isSouthCogToken(c)).toBe(true);
      if (isSouthCogToken(c)) expect(isSouthCogWide(c)).toBe(true);
      expect(isNorthCog(c) && isSouthCogWide(c)).toBe(false);
    }
    // Inklusionerna är ÄKTA (strikta delmängder), inte tre namn på samma band.
    expect(SWEEP.some((c) => isSouthCogToken(c) && !isSouthCogStrict(c))).toBe(true);
    expect(SWEEP.some((c) => isSouthCogWide(c) && !isSouthCogToken(c))).toBe(true);
  });
});

describe('FG-DIR (C): kontrakt — icke-finit och ingen normalisering', () => {
  test.each([null, undefined, NaN, Infinity, -Infinity, '180', {}, []])(
    'icke-finit indata %p ⇒ false i hela familjen (ingen null<=45-fälla)',
    (bad) => {
      expect(isNorthCog(bad)).toBe(false);
      expect(isSouthCogStrict(bad)).toBe(false);
      expect(isSouthCogWide(bad)).toBe(false);
      expect(isSouthCogToken(bad)).toBe(false);
    },
  );

  test('predikaten normaliserar INTE — anroparen äger ((cog%360)+360)%360', () => {
    // 495° normaliserat är 135 (syd), men predikatet ser 495 och svarar false.
    // De tre anropsställen som normaliserar gör det på sin egen sida; skulle
    // predikatet normalisera hade de ~11 som INTE gör det tyst ändrat utfall.
    expect(isSouthCogWide(495)).toBe(false);
    expect(isSouthCogWide(normalize(495))).toBe(true);
    expect(isSouthCogStrict(-225)).toBe(false);
    expect(isSouthCogStrict(normalize(-225))).toBe(true);
  });
});

describe('FG-DIR (D): byte-identitet mot de gamla literaluttrycken', () => {
  test('predikaten ⇔ referensimplementationerna över hela kursvarvet', () => {
    for (const c of SWEEP) {
      expect(isNorthCog(c)).toBe(OLD.north(c));
      expect(isSouthCogStrict(c)).toBe(OLD.southStrict(c));
      expect(isSouthCogWide(c)).toBe(OLD.southWide(c));
      // Bevis för att de två bortstädade klausulerna i _getDirectionString var
      // redundanta: originalformen och predikatet är ekvivalenta överallt.
      expect(isSouthCogToken(c)).toBe(OLD.southToken(c));
    }
  });

  test('app._dedupDirection: oförändrat utfall (nord | brett syd | null)', () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    for (const c of SWEEP) {
      const expected = oldWideVerdict(c);
      expect(app._dedupDirection({ cog: c, sog: 5 })).toBe(expected);
    }
    // Icke-finit COG ger fortfarande null (gaten ligger kvar på anropsstället).
    expect(app._dedupDirection({ cog: null, sog: 5 })).toBeNull();
    expect(app._dedupDirection({ cog: NaN, sog: 5 })).toBeNull();
  });

  test('app._getDirectionString: oförändrat utfall (token-bandet)', () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    for (const c of SWEEP) {
      const expected = oldTokenVerdict(c);
      expect(app._getDirectionString({ cog: c, sog: 5 })).toBe(expected);
    }
    // Validitets-/SOG-gaterna är orörda av FG-DIR.
    expect(app._getDirectionString({ cog: 360, sog: 5 })).toBe('unknown');
    expect(app._getDirectionString({ cog: -1, sog: 5 })).toBe('unknown');
    expect(app._getDirectionString({ cog: null, sog: 5 })).toBe('unknown');
    expect(app._getDirectionString({ cog: 200, sog: 0 })).toBe('unknown');
  });

  test('PassageLatchService._directionFromCog: oförändrat (brett syd + normalisering)', () => {
    const fn = PassageLatchService.prototype._directionFromCog;
    for (const c of SWEEP) {
      const n = normalize(c);
      const expected = oldWideVerdict(n);
      expect(fn.call(null, c)).toBe(expected);
    }
    expect(fn.call(null, null)).toBeNull();
    expect(fn.call(null, NaN)).toBeNull();
    // Normaliseringen lever kvar HÄR (predikatet normaliserar inte).
    expect(fn.call(null, 495)).toBe('south');
    expect(fn.call(null, -20)).toBe('north');
  });

  test('RouteOrderValidator._determineDirection: oförändrat (brett syd + normalisering)', () => {
    const fn = RouteOrderValidator.prototype._determineDirection;
    for (const c of SWEEP) {
      const n = normalize(c);
      const expected = oldWideVerdict(n);
      expect(fn.call(null, c)).toBe(expected);
    }
    expect(fn.call(null, null)).toBeNull();
    expect(fn.call(null, 495)).toBe('south');
  });

  test('VesselDataService._determineDirection: oförändrat (STRIKT syd + normalisering)', () => {
    const fn = VesselDataService.prototype._determineDirection;
    for (const c of SWEEP) {
      const n = normalize(c);
      const expected = oldStrictVerdict(n);
      expect(fn.call(null, c)).toBe(expected);
    }
    // P5 punkt 1: SV-kurs är MEDVETET tvetydig här (jfr latchen ovan: 'south').
    expect(fn.call(null, 250)).toBeNull();
    expect(fn.call(null, null)).toBeNull();
  });

  test('VesselDataService._safeDetermineDirection: båda vägarna oförändrade', () => {
    const safe = VesselDataService.prototype._safeDetermineDirection;
    const delegating = { _determineDirection: VesselDataService.prototype._determineDirection };
    for (const c of SWEEP) {
      const n = normalize(c);
      const expected = oldStrictVerdict(n);
      // Väg 1: prototypmetoden finns (normalfallet).
      expect(safe.call(delegating, c)).toBe(expected);
      // Väg 2: inbyggda fallbacken (paketerade builds utan prototypmetod).
      expect(safe.call({}, c)).toBe(expected);
    }
    expect(safe.call({}, null)).toBeNull();
  });

  test('VesselLifecycleManager._isNorthbound: oförändrat (binärt nordband)', () => {
    const fn = VesselLifecycleManager.prototype._isNorthbound;
    for (const c of SWEEP) {
      expect(fn.call(null, c)).toBe(OLD.north(c));
    }
    // Den historiska coercion-fällan förblir stängd: utan kurs ⇒ söderut.
    expect(fn.call(null, null)).toBe(false);
    expect(fn.call(null, undefined)).toBe(false);
    expect(fn.call(null, NaN)).toBe(false);
  });
});

describe('FG-DIR (E): inga gradliterals kvar utanför cogDirection.js', () => {
  // De inline-ställen som bor mitt i stora metoder (NEW_JOURNEY-blocket, Fix D,
  // portgissningen, exit-fallbacken, terminalbro-grenarna) kan inte anropas
  // isolerat. Den här skanningen är deras regressionsvakt: skulle någon skriva
  // tillbaka ett gradtal går det inte obemärkt förbi.
  const OWNED = [
    'app.js',
    'lib/services/VesselDataService.js',
    'lib/services/PassageLatchService.js',
    'lib/services/RouteOrderValidator.js',
    'lib/services/VesselLifecycleManager.js',
  ];

  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');

  test.each(OWNED)('%s jämför inte cog mot gradtal', (rel) => {
    const src = stripComments(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
    // Riktningsbanden — validitetsgaterna (0/360) är en ANNAN familj och rörs inte.
    const bandLiteral = /cog\s*(?:>=|<=|>|<)\s*(?:45|135|225|270|314|315)\b/i;
    const viaConstants = /cog\s*(?:>=|<=|>|<)\s*(?:constants\.)?COG_DIRECTIONS\./i;
    expect(src).not.toMatch(bandLiteral);
    expect(src).not.toMatch(viaConstants);
  });
});
