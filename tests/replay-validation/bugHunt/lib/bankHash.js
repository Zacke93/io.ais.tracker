'use strict';

/**
 * Bankens fingeravtryck: SHA-256 över de 24 låsta jsonl- och state-filerna i
 * corpora.js-ordning (byggplanens steg 7). Används av freezeCalibration.js
 * när kalibreringen fryses och av självtestet för att varna om banken ändrats
 * sedan dess. Läser bara.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Formatet per korpus är `<id>\n<sha256(jsonl)>\n<sha256(state)|->\n`, och
 * totalhashen tas över den sammanfogade texten.
 * @param {object[]} [corpora] - korpuslistan (standard: corpora.js)
 * @returns {{sha256:string, filer:object[]}} totalhash och per-fil-hashar
 */
function computeBankHash(corpora = require('../../corpora')) { // eslint-disable-line global-require
  const filer = [];
  const total = crypto.createHash('sha256');
  for (const c of corpora) {
    const jsonlSha = sha256File(c.jsonl);
    const statePath = c.jsonl.replace(/\.jsonl$/, '.state.json');
    const stateSha = fs.existsSync(statePath) ? sha256File(statePath) : null;
    filer.push({
      id: c.id,
      jsonl: path.basename(c.jsonl),
      sha256: jsonlSha,
      state: stateSha ? path.basename(statePath) : null,
      stateSha256: stateSha,
    });
    total.update(`${c.id}\n${jsonlSha}\n${stateSha || '-'}\n`);
  }
  return { sha256: total.digest('hex'), filer };
}

module.exports = { computeBankHash, sha256File };
