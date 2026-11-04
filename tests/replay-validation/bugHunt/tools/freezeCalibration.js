'use strict';

/**
 * Fryser sanningsspårets kalibrering till tests/replay-validation/bugHunt/
 * calibration.json (byggplanens steg 7).
 *
 * Utan --write skriver verktyget INGENTING. Det jämför då bankens SHA-256 med
 * det frysta värdet och skriver ut en sammanfattning (exit 0 om lika, 3 om
 * banken har ändrats sedan frysningen). Med --write krävs båda källorna:
 *
 *   node tests/replay-validation/bugHunt/tools/freezeCalibration.js \
 *     --write --spec=<generator-spec.json> --quays=<quays.json> [--date=ÅÅÅÅ-MM-DD] [--head=<sha7>]
 *
 * Källorna är kartläggningens mätningar över de 24 låsta korpusarna:
 * generator-spec.json (map-generation/measure.js) och quays.json (12
 * kajplatser härledda ur stillaliggare, design-truth/proto/mkQuays.js).
 * Omkalibrering ur banken (calibrate.js --check) kommer i v1.1. Motorn
 * kör aldrig det här verktyget själv.
 */

const fs = require('fs');
const path = require('path');
const { computeBankHash, sha256File } = require('../lib/bankHash');

const OUT = path.join(__dirname, '..', 'calibration.json');

function parseArgs(argv) {
  const args = { write: false };
  for (const a of argv.slice(2)) {
    if (a === '--write') args.write = true;
    else if (a.startsWith('--spec=')) args.spec = a.slice(7);
    else if (a.startsWith('--quays=')) args.quays = a.slice(8);
    else if (a.startsWith('--date=')) args.date = a.slice(7);
    else if (a.startsWith('--head=')) args.head = a.slice(7);
    else throw new Error(`Okänd flagga: ${a}`);
  }
  return args;
}

/**
 * Köplatserna i F-KÖ (BUGGJAKT.md §4.4): fältets äkta köer per bro och
 * riktning, avstånd före bron p10–p90. Bara broar där appen beslutar om
 * väntan (målbroarna och Järnvägsbron) och minst 3 köer.
 * @param {object} spec - generator-spec.json
 * @returns {object[]} köplatser
 */
function deriveQueueSites(spec) {
  const by = spec['kö']['äktaKöer'].byBridgeDir;
  const keep = new Set(['Klaffbron', 'Järnvägsbron', 'Stridsbergsbron']);
  return Object.entries(by)
    .map(([k, v]) => {
      const [bridge, dirSv] = k.split(' ');
      return {
        bridge, dir: dirSv === 'nord' ? 'north' : 'south', distM: [v.beforeP10, v.beforeP90], n: v.n,
      };
    })
    .filter((q) => keep.has(q.bridge) && q.n >= 3)
    .sort((a, b) => b.n - a.n || a.bridge.localeCompare(b.bridge));
}

function main() {
  const args = parseArgs(process.argv);
  const bank = computeBankHash();
  if (!args.write) {
    if (!fs.existsSync(OUT)) {
      console.log(`Ingen ${path.basename(OUT)} ännu. Kör med --write --spec=… --quays=… för att frysa.`);
      process.exit(3);
    }
    const cal = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const same = cal.bank && cal.bank.sha256 === bank.sha256;
    console.log(`Kalibrering fryst ${cal._om && cal._om.frystDatum} (HEAD ${cal._om && cal._om.head}).`);
    console.log(`Bankens SHA-256 nu:    ${bank.sha256}`);
    console.log(`Bankens SHA-256 fryst: ${cal.bank && cal.bank.sha256}`);
    console.log(same ? 'Banken är oförändrad sedan frysningen.' : 'VARNING: banken har ändrats sedan frysningen.');
    process.exit(same ? 0 : 3);
  }
  if (!args.spec || !args.quays) throw new Error('--write kräver både --spec=<generator-spec.json> och --quays=<quays.json>');
  const spec = JSON.parse(fs.readFileSync(args.spec, 'utf8'));
  const quays = JSON.parse(fs.readFileSync(args.quays, 'utf8'));
  if (!Array.isArray(quays) || quays.length !== 12) throw new Error(`Väntade 12 kajplatser, fick ${Array.isArray(quays) ? quays.length : typeof quays}`);
  const cal = {
    _om: {
      beskrivning: 'Fryst kalibrering för buggjägarens sanningsspår. Fältmåtten är uppmätta på de 24 låsta korpusarna. Ändras bara via tools/freezeCalibration.js --write.',
      frystDatum: args.date || new Date().toISOString().slice(0, 10),
      head: args.head || null,
      verktyg: 'tests/replay-validation/bugHunt/tools/freezeCalibration.js --write',
      källor: [
        { roll: 'fält', fil: 'map-generation/generator-spec.json (kartläggningen 2026-11-04, measure.js)', sha256: sha256File(args.spec) },
        { roll: 'kajplatser', fil: 'design-truth/proto/quays.json (mkQuays.js, stillaliggare i banken)', sha256: sha256File(args.quays) },
      ],
      not: 'R1 är okalibrerad i v1 (BUGGJAKT.md §4.2): realismgrinden är röd. calibrate.js --check, mått per era och omvägning kommer i v1.1.',
    },
    bank: { algoritm: 'sha256', ordning: 'corpora.js', ...bank },
    köplatser: deriveQueueSites(spec),
    dygnstakt: spec.dygn.ratePerCoveredHour,
    kajplatser: quays,
    fält: spec,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(cal, null, 1)}\n`);
  console.log(`Skrev ${OUT}`);
  console.log(`  bank ${bank.sha256} (${bank.filer.length} korpusar, ${bank.filer.filter((f) => f.state).length} med state)`);
  console.log(`  köplatser ${cal['köplatser'].map((q) => `${q.bridge} ${q.dir} ${q.distM.join('–')} m (n=${q.n})`).join('; ')}`);
}

try {
  main();
} catch (e) {
  console.error(`freezeCalibration: ${e.message}`);
  process.exit(1);
}
