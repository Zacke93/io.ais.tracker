'use strict';

/**
 * Skriver canaries/kanarier.json ur families.canarySpec (S-KANARIE,
 * orakelkatalogen). Utan --write skrivs ingenting; verktyget jämför då filen
 * med vad det skulle skriva (exit 0 om lika, 3 annars).
 *
 *   node tests/replay-validation/bugHunt/tools/writeCanaries.js [--write]
 *
 * De fem kanarierna är R0-världar med exakt känt facit. Kraven prövas i
 * lib/selftestSynth.js (checkCanary); listorna här är dokumentation av samma krav.
 */

const fs = require('fs');
const path = require('path');
const { canarySpec } = require('../lib/families');

const OUT = path.join(__dirname, '..', 'canaries', 'kanarier.json');

const INSTRUMENTKRAV = [
  'notiser > 0',
  'minst 2 målbropassager per transit',
  'mellanbropassager > 0',
  'minst 1 öppningsvarning',
  'minst 1 openingCoverage med reason absorbed (bara konvojparet)',
  'textövergångar > 0',
];
const FÖRVÄNTNINGAR = [
  'exakt en notis per punkt och transit (6 st)',
  '2 målbropassager per transit',
  'en varning per målbro; alla målbrokorsningar täckta med ledtid över kanariegolvet max(60 s; WARNING_LEAD_MS − TICK_INTERVAL_MS − kadens − 10 s)',
  'DEFAULT inom 120 s efter sista målbrokorsningen (uppmätt 21–54 s)',
];

const CANARIES = [
  {
    id: 'K1-norr-5kn-A30',
    beskrivning: 'norrut, 5 kn, klass A, 30 s',
    p: {
      dir: 'north', kn: 5, cls: 'A', intervalS: 30,
    },
  },
  {
    id: 'K2-syd-5kn-A30',
    beskrivning: 'söderut, 5 kn, klass A, 30 s',
    p: {
      dir: 'south', kn: 5, cls: 'A', intervalS: 30,
    },
  },
  {
    id: 'K3-norr-8kn-A30',
    beskrivning: 'norrut, 8 kn, klass A, 30 s',
    p: {
      dir: 'north', kn: 8, cls: 'A', intervalS: 30,
    },
  },
  {
    id: 'K4-norr-5kn-B60',
    beskrivning: 'norrut, 5 kn, klass B, 60 s',
    p: {
      dir: 'north', kn: 5, cls: 'B', intervalS: 60,
    },
    overrides: { forceClassA: false },
  },
  {
    id: 'K5-konvoj-norr-3min',
    beskrivning: 'konvojpar norrut, 5 kn, klass A, 30 s, 3 min mellanrum',
    p: {
      dir: 'north', kn: 5, cls: 'A', intervalS: 30, pairGapS: 180,
    },
  },
];

function build() {
  return {
    _om: {
      beskrivning: 'S-KANARIE: fem R0-världar med exakt känt facit. Instrumentkrav stoppar körningen (INSTRUMENT BLINT, exit 2); produktförväntningar ger kortet KANARIE överst i rapporten.',
      verktyg: 'tests/replay-validation/bugHunt/tools/writeCanaries.js --write',
      källa: 'orakelkatalogen S-KANARIE (buggjägarens designunderlag 2026-11-04)',
    },
    kanarier: CANARIES.map((c) => ({
      id: c.id,
      beskrivning: c.beskrivning,
      radio: { profil: 'R0', overrides: c.overrides || {}, intervalS: c.p.intervalS },
      instrumentkrav: INSTRUMENTKRAV.filter((k) => c.p.pairGapS || !k.includes('konvojparet')),
      förväntningar: FÖRVÄNTNINGAR,
      spec: canarySpec({ id: c.id, ...c.p }),
    })),
  };
}

const text = `${JSON.stringify(build(), null, 1)}\n`;
if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`Skrev ${OUT}`);
} else {
  const same = fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === text;
  console.log(same ? 'kanarier.json är aktuell.' : 'kanarier.json avviker från generatorn (kör med --write).');
  process.exit(same ? 0 : 3);
}
