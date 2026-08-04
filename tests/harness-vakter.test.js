'use strict';

/**
 * Harness-vakter (testauditen 2026-07-10) — tester som vaktar VALIDERINGS-
 * BATTERIETS egna tysta kopplingar. Auditens fynd: tre ställen där en
 * oskyldig omformulering i produktionen eller harnessen gjort ett skydd
 * vakuöst UTAN att något test blev rött:
 *
 *   TE15 — replayRunner fångar passage-/reset-händelser genom att regexa
 *          appens LOGGRADER. Om loggsträngen formuleras om (eller flyttas
 *          till debug-nivån) blir t.ex. INV-13:s indata tomt och invarianten
 *          tyst vakuös. Vakten låser att (a) produktionskällan fortfarande
 *          emitterar exakt de strängfragment harnessen förväntar sig och
 *          (b) harnessens regexar matchar rader byggda på det formatet.
 *   TE18 — (etapp 6, 2026-08-03) samma vakt för ÖPPNINGSLAGRETS logg-koppling:
 *          replayRunner fångar täckningsraden [OPENING_COVERAGE] med regex, och
 *          hela O1:s konvojklassificering vilar på den. Formuleras raden om,
 *          eller flyttas den till debug-nivån (som är AVSTÄNGD som standard i
 *          replayen), blir openingCoverage tomt och "täckt via konvoj" ser ut
 *          som en MISS i varje korpus.
 *   TE17 — invariants.js PROXIMITY_SOURCES måste täcka VARJE source-värde
 *          som app.js kan sätta på en notis (utom 'passage-fallback' som är
 *          medvetet undantagen från 400 m-/fartfysik-kontrollerna). En NY
 *          källa som inte läggs i settet undslipper annars INV-11/16 tyst.
 *
 * Mönster: källsvep (samma princip som projektionsvakten i
 * helgranskning-2026-07-06.test.js) — testet läser källfilerna och faller
 * när kopplingen bryts, oavsett vilken sida som ändrades.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const vdsSrc = fs.readFileSync(path.join(ROOT, 'lib/services/VesselDataService.js'), 'utf8');
const runnerSrc = fs.readFileSync(path.join(ROOT, 'tests/replay-validation/replayRunner.js'), 'utf8');
const invariantsSrc = fs.readFileSync(path.join(ROOT, 'tests/replay-validation/invariants.js'), 'utf8');

// Extrahera en regex-literal ur replayRunner-källan via dess variabelnamn.
function extractRunnerRegex(varName) {
  const m = runnerSrc.match(new RegExp(`const ${varName} = (/.+/);`));
  if (!m) throw new Error(`Hittar inte regex-definitionen "${varName}" i replayRunner.js`);
  const body = m[1].slice(1, m[1].lastIndexOf('/'));
  const flags = m[1].slice(m[1].lastIndexOf('/') + 1);
  return new RegExp(body, flags);
}

describe('TE15: replayRunners logg-regexar är i synk med produktionens loggsträngar', () => {
  test('INTERMEDIATE_PASSAGE_RECORDED: produktionen emitterar formatet och regexen fångar det', () => {
    // (a) produktionskällan innehåller exakt strängfragmentet
    expect(vdsSrc).toMatch(/\[INTERMEDIATE_PASSAGE_RECORDED\] \$\{vessel\.mmsi\}: Recorded passage of intermediate bridge /);
    // (b) harness-regexen matchar en rad byggd på det formatet
    const re = extractRunnerRegex('intermediateRe');
    const sample = '📝 [INTERMEDIATE_PASSAGE_RECORDED] 265123456: Recorded passage of intermediate bridge Järnvägsbron (gate-confirmed)';
    const m = sample.match(re);
    expect(m).not.toBeNull();
    expect(m[1]).toBe('265123456');
    expect(m[2]).toBe('Järnvägsbron');
    // (c) raden loggas på log-nivån (instrumenteringen lyssnar bara på .log)
    const logCallRe = /this\.logger\.log\(\s*\n?\s*`📝 \[INTERMEDIATE_PASSAGE_RECORDED\]/;
    expect(vdsSrc).toMatch(logCallRe);
  });

  test('TARGET_PASSAGE_RECORDED (+FINAL): format och regex i synk', () => {
    expect(vdsSrc).toMatch(/\[TARGET_PASSAGE_RECORDED\] \$\{vessel\.mmsi\}: Recorded passage of target bridge /);
    expect(vdsSrc).toMatch(/\[FINAL_TARGET_PASSAGE_RECORDED\] \$\{vessel\.mmsi\}: Recorded passage of final target bridge /);
    const re = extractRunnerRegex('passageRe');
    expect('📝 [TARGET_PASSAGE_RECORDED] 265000001: Recorded passage of target bridge Klaffbron'.match(re)[2]).toBe('Klaffbron');
    expect('📝 [FINAL_TARGET_PASSAGE_RECORDED] 265000001: Recorded passage of final target bridge Stridsbergsbron'.match(re)[2]).toBe('Stridsbergsbron');
  });

  test('journey-reset-familjen: alla fyra markörer finns i produktionen och fångas av regexen', () => {
    const re = extractRunnerRegex('journeyResetRe');
    for (const marker of ['JOURNEY_RESET', 'NEW_JOURNEY', 'REENTRY_NEW_JOURNEY', 'TARGET_RECALC']) {
      const sample = `🔁 [${marker}] 265000002: whatever`;
      expect(sample.match(re)).not.toBeNull();
      // Markören måste förekomma i produktionskoden (app.js eller VDS)
      expect(appSrc.includes(`[${marker}]`) || vdsSrc.includes(`[${marker}]`)).toBe(true);
    }
  });
});

describe('TE18: öppningslagrets logg-koppling (etapp 6)', () => {
  test('[OPENING_COVERAGE]: produktionen emitterar formatet och regexen fångar det', () => {
    // (a) produktionskällan innehåller exakt strängfragmentet
    expect(appSrc).toMatch(/\[OPENING_COVERAGE\] \$\{info\.mmsi\}: \$\{info\.bridge\} täckt av \$\{info\.eventId\} \(\$\{info\.reason\}\)/);
    // (b) harness-regexen matchar en rad byggd på det formatet
    const re = extractRunnerRegex('coverageRe');
    const sample = '🛡️ [OPENING_COVERAGE] 265576720: Klaffbron täckt av Klaffbron#6 (absorbed)';
    const m = sample.match(re);
    expect(m).not.toBeNull();
    expect(m[1]).toBe('265576720');
    expect(m[2]).toBe('Klaffbron');
    expect(m[3]).toBe('Klaffbron#6');
    expect(m[4]).toBe('absorbed');
    // (c) raden loggas på LOG-nivån — instrumenteringen lyssnar bara på .log,
    //     och debug är avstängd som standard i replayen.
    expect(appSrc).toMatch(/this\.log\(\s*\n?\s*`🛡️ \[OPENING_COVERAGE\]/);
  });

  test('replayRunner samlar öppningskortet över ALLA app-instanser (ctrl:restart)', () => {
    // Mocken skapar ett NYTT kort per app-instans. Sparas bara den första
    // instansens kort tappas varje varning efter en omstart tyst.
    expect(runnerSrc).toMatch(/openingCards\.push\(instance\._bridgeOpeningTrigger\)/);
    expect(runnerSrc).toMatch(/const openingWarnings = openingCards/);
  });
});

describe('TE17: PROXIMITY_SOURCES täcker alla notiskällor app.js kan emittera', () => {
  test('varje source-literal i app.js (utom passage-fallback) finns i invariants-settet', () => {
    // Extrahera settet ur invariants.js
    const setMatch = invariantsSrc.match(/PROXIMITY_SOURCES = new Set\(\[([^\]]+)\]\)/);
    expect(setMatch).not.toBeNull();
    const guarded = new Set(setMatch[1].match(/'([a-z-]+)'/g).map((s) => s.replace(/'/g, '')));

    // Extrahera alla källor app.js kan sätta: addCandidate(..., '<source>')
    // och inline source: '<source>'.
    const found = new Set();
    for (const m of appSrc.matchAll(/addCandidate\([^,]+,\s*'([a-z-]+)'/g)) found.add(m[1]);
    for (const m of appSrc.matchAll(/source:\s*'([a-z-]+)'/g)) found.add(m[1]);

    expect(found.size).toBeGreaterThanOrEqual(3); // sanity: svepet hittar källor
    const unguarded = [...found].filter((s) => s !== 'passage-fallback' && !guarded.has(s));
    expect(unguarded).toEqual([]);
  });
});
