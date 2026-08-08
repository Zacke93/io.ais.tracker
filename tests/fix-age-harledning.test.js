'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AIS_CONFIG, BRIDGE_OPENING } = require('../lib/constants');

/**
 * ETAPP 7, B4 STEG 1 — HÄRLEDNINGSREFAKTORN (2026-08-08).
 *
 * Fyra ställen i lib/constants.js bar var sin hårdkodad kopia av
 * `10 * 60000 + 120000` (= 12 min):
 *
 *   1. AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS       — hubbens ingångsgrind
 *   2. AIS_CONFIG.FUSION.MAX_FIX_AGE_MS       — F4b, fusionens enda hårda åldersgrind
 *   3. AIS_CONFIG.FUSION.STATE_TTL_MS         — samma tal + 60 s prunemarginal
 *   4. BRIDGE_OPENING.MAX_FIX_ANCHOR_AGE_MS   — deadline-ankarets klampning
 *
 * Kopplingen till AISHubs `interval=`-parameter (datafönstret) stod BARA i
 * kommentarerna. Fältprovet 2026-08-08 visade vad det kostar: en flipp av
 * INTERVAL_MINUTES 10 → 3 hade lämnat alla fyra grindarna på 12 min mot ett
 * 3-minutersfönster, tyst. Refaktorn inför EN källkonstant
 * (FIX_AGE_HARD_LIMIT_MS) och låter de fyra referera den.
 *
 * Den här sviten låser TVÅ saker:
 *   (a) IDENTITET — refaktorn ändrade inget värde (720 000 ms, precis som före);
 *   (b) LIVE HÄRLEDNING — kopplingen är mekanisk, inte en kommentar: när
 *       INTERVAL_MINUTES ändras i KÄLLAN följer alla fyra platserna med.
 *
 * (b) är hela poängen. Ett test som bara jämför tal mot tal hade varit grönt
 * även med fyra hårdkodade kopior kvar — dvs. blint för exakt den bugg
 * refaktorn eliminerar. Därför laddas källfilen om med muterat intervall.
 */

// Värdet FÖRE refaktorn, avläst ur git-historiken: 10 * 60000 + 120000.
// Hårdkodat MED FLIT här — det är facit som identitetskravet mäts mot, och
// ett facit som räknas ur samma konstant det ska bevaka bevisar ingenting.
const FIX_AGE_BEFORE_REFACTOR_MS = 720000;

const CONSTANTS_PATH = path.join(__dirname, '..', 'lib', 'constants.js');

/**
 * Laddar lib/constants.js i en FRISK modulinstans med
 * `const AISHUB_INTERVAL_MINUTES = <minutes>;` utbytt i källan.
 *
 * Filen har noll `require` (ren datamodul, verifierat av ett eget test
 * nedan), så en kopia i tmp är en fullvärdig laddning — inga relativa
 * beroenden kan gå sönder av flytten.
 */
function loadWithInterval(minutes) {
  const src = fs.readFileSync(CONSTANTS_PATH, 'utf8');
  const needle = 'const AISHUB_INTERVAL_MINUTES = 10;';
  // Vaktar mot att testet tyst blir en no-op om konstanten döps om.
  expect(src).toContain(needle);
  const mutated = src.replace(needle, `const AISHUB_INTERVAL_MINUTES = ${minutes};`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-const-'));
  const file = path.join(dir, 'constants.js');
  fs.writeFileSync(file, mutated);
  try {
    // eslint-disable-next-line global-require
    return require(file);
  } finally {
    delete require.cache[require.resolve(file)];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('B4 steg 1 (a): identitet — refaktorn ändrade inget värde', () => {
  test('AISHUB.MAX_FIX_AGE_MS är oförändrad 12 min', () => {
    expect(AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS).toBe(FIX_AGE_BEFORE_REFACTOR_MS);
  });

  test('FUSION.MAX_FIX_AGE_MS (F4b) är oförändrad 12 min', () => {
    expect(AIS_CONFIG.FUSION.MAX_FIX_AGE_MS).toBe(FIX_AGE_BEFORE_REFACTOR_MS);
  });

  test('BRIDGE_OPENING.MAX_FIX_ANCHOR_AGE_MS är oförändrad 12 min', () => {
    expect(BRIDGE_OPENING.MAX_FIX_ANCHOR_AGE_MS).toBe(FIX_AGE_BEFORE_REFACTOR_MS);
  });

  test('FUSION.STATE_TTL_MS är oförändrad 13 min (grind + 60 s prunemarginal)', () => {
    expect(AIS_CONFIG.FUSION.STATE_TTL_MS).toBe(FIX_AGE_BEFORE_REFACTOR_MS + 60000);
  });

  test('AISHUB.INTERVAL_MINUTES är oförändrad 10 (B4 steg 2 är INTE gjord)', () => {
    // Steg 2 nedprioriterades 2026-08-08: fältet visade att datafönstret aldrig
    // band i praktiken (max accepterad fixålder 96,7 s). Skulle någon ändå
    // flippa det ska DEN ändringen vara ett medvetet beslut med egen mätning —
    // inte något som glider in som sidoeffekt av en städning.
    expect(AIS_CONFIG.AISHUB.INTERVAL_MINUTES).toBe(10);
  });

  test('de tre åldersgrindarna är EXAKT samma tal', () => {
    const gates = [
      AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS,
      AIS_CONFIG.FUSION.MAX_FIX_AGE_MS,
      BRIDGE_OPENING.MAX_FIX_ANCHOR_AGE_MS,
    ];
    expect(new Set(gates).size).toBe(1);
  });

  test('grinden är datafönstret + 2 min klockskev', () => {
    const KLOCKSKEV_MS = 120000;
    expect(AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS)
      .toBe(AIS_CONFIG.AISHUB.INTERVAL_MINUTES * 60000 + KLOCKSKEV_MS);
  });
});

describe('B4 steg 1 (b): härledningen är LIVE, inte en kommentar', () => {
  test('lib/constants.js har noll require — kopian i tmp är en fullvärdig laddning', () => {
    const src = fs.readFileSync(CONSTANTS_PATH, 'utf8');
    expect(src).not.toMatch(/\brequire\s*\(/);
  });

  test('kontrollprov: omladdning med OFÖRÄNDRAT intervall ger dagens värden', () => {
    // Utan detta kan ett grönt mutationsprov nedan bero på att laddningsvägen
    // i sig ger andra tal (t.ex. en misslyckad ersättning som ändå "råkar" ge
    // rätt riktning). Kontrollprovet binder laddningsvägen till sanningen.
    const C = loadWithInterval(10);
    expect(C.AIS_CONFIG.AISHUB.INTERVAL_MINUTES).toBe(10);
    expect(C.AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS).toBe(FIX_AGE_BEFORE_REFACTOR_MS);
    expect(C.AIS_CONFIG.FUSION.MAX_FIX_AGE_MS).toBe(FIX_AGE_BEFORE_REFACTOR_MS);
    expect(C.BRIDGE_OPENING.MAX_FIX_ANCHOR_AGE_MS).toBe(FIX_AGE_BEFORE_REFACTOR_MS);
    expect(C.AIS_CONFIG.FUSION.STATE_TTL_MS).toBe(FIX_AGE_BEFORE_REFACTOR_MS + 60000);
  });

  test('INTERVAL_MINUTES 10 → 3 flyttar SAMTLIGA fyra platserna med', () => {
    // Precis den flipp B4 steg 2 skulle ha gjort. Grindarna ska bli
    // 3 min + 2 min klockskev = 5 min, aldrig stå kvar på 12.
    const C = loadWithInterval(3);
    const vantad = 3 * 60000 + 120000;

    expect(C.AIS_CONFIG.AISHUB.INTERVAL_MINUTES).toBe(3);
    expect(C.AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS).toBe(vantad);
    expect(C.AIS_CONFIG.FUSION.MAX_FIX_AGE_MS).toBe(vantad);
    expect(C.BRIDGE_OPENING.MAX_FIX_ANCHOR_AGE_MS).toBe(vantad);
    expect(C.AIS_CONFIG.FUSION.STATE_TTL_MS).toBe(vantad + 60000);

    // Det gamla felläget, uttryckt som ett explicit förbud: ingen av
    // grindarna får ligga kvar på 12-minutersvärdet.
    expect(C.AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS).not.toBe(FIX_AGE_BEFORE_REFACTOR_MS);
    expect(C.AIS_CONFIG.FUSION.MAX_FIX_AGE_MS).not.toBe(FIX_AGE_BEFORE_REFACTOR_MS);
    expect(C.BRIDGE_OPENING.MAX_FIX_ANCHOR_AGE_MS).not.toBe(FIX_AGE_BEFORE_REFACTOR_MS);
  });

  test('statens TTL överlever åldersgrinden vid VARJE intervall', () => {
    // Invarianten bakom STATE_TTL_MS: prunas fusionsstaten medan ett fix
    // fortfarande kan accepteras tappar F1:s monotonspärr sitt minne och ett
    // gammalt eko blir godtagbart. Måste gälla oavsett datafönster.
    for (const minuter of [1, 3, 5, 10, 30]) {
      const C = loadWithInterval(minuter);
      expect(C.AIS_CONFIG.FUSION.STATE_TTL_MS)
        .toBeGreaterThan(C.AIS_CONFIG.FUSION.MAX_FIX_AGE_MS);
      expect(C.AIS_CONFIG.FUSION.STATE_TTL_MS)
        .toBe(C.AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS + 60000);
    }
  });

  test('inga hårdkodade 12-minuterskopior är kvar i koden', () => {
    const src = fs.readFileSync(CONSTANTS_PATH, 'utf8');
    const kodrader = src.split('\n').filter((rad) => !rad.trim().startsWith('//'));
    const kvar = kodrader.filter((rad) => rad.includes('10 * 60000 + 120000'));
    expect(kvar).toEqual([]);
  });
});
