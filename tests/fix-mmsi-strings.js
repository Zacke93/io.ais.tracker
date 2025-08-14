'use strict';

/**
 * Script to fix MMSI values to be strings instead of numbers in edge case test files
 */

const fs = require('fs');
const path = require('path');

const edgeCaseDir = path.join(__dirname, 'edge-cases');
const files = [
  'extreme-values.test.js',
  'concurrent-vessels.test.js',
  'bridge-proximity.test.js',
  'data-corruption.test.js',
  'timing-scenarios.test.js',
  'network-failures.test.js',
  'state-transitions.test.js',
  'memory-stress.test.js',
];

files.forEach((filename) => {
  const filePath = path.join(edgeCaseDir, filename);

  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');

    // Fix MMSI values - convert numbers to strings
    // Match patterns like: mmsi: 999000001, 123456789, etc.
    content = content.replace(/mmsi:\s*(\d{7,12}),/g, "mmsi: '$1',");

    // Fix variable assignments like: const mmsi = 999000001;
    content = content.replace(/const mmsi = (\d{7,12});/g, "const mmsi = '$1';");
    content = content.replace(/let mmsi = (\d{7,12});/g, "let mmsi = '$1';");

    // Fix baseMMSI and similar patterns
    content = content.replace(/const (\w*[Mm][Mm][Ss][Ii]\w*) = (\d{7,12});/g, "const $1 = '$2';");
    content = content.replace(/let (\w*[Mm][Mm][Ss][Ii]\w*) = (\d{7,12});/g, "let $1 = '$2';");

    // Fix MMSI in expressions like: mmsiBase + i, duplicateMMSI + index, etc.
    // These need to be handled more carefully since we want to keep arithmetic
    // We'll convert them to template literals
    content = content.replace(/mmsi:\s*(\w+MMSI)\s*\+\s*(\w+),/g, 'mmsi: `${$1}${$2}`,');
    content = content.replace(/mmsi:\s*(\d{7,12})\s*\+\s*(\w+),/g, 'mmsi: `$1${$2}`,');

    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Fixed MMSI strings in: ${filename}`);
  } else {
    console.log(`File not found: ${filename}`);
  }
});

console.log('All edge case test files have been updated with string MMSI values!');
