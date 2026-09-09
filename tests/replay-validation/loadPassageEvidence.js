'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  buildFairway, projectFix, crossingsForVessel, FAIRWAY_MAX_OFFSET_M,
} = require('./makeGtPassages');

/**
 * Separat skuggdata kan snäva ett rådatafönster utan att ändra appens indata.
 * Fartygsposterna är kopierade ur originalsvaret; mottagningstiden är aldrig
 * observationstid. Facitets frusna geometri och hoppvakt används även här.
 */
function refinePassageWindows(passages, evidence) {
  if (!evidence) return passages;
  if (evidence.version !== 1 || evidence.source?.feed !== 'aishub'
    || evidence.source?.tag !== 'AISHUB_RESPONSE_SAMPLE'
    || !/^[a-f0-9]{64}$/.test(evidence.source?.sha256 || '') || !Array.isArray(evidence.passages)) {
    throw new Error('Ogiltig proveniens för kompletterande passagebevis');
  }
  const fairway = buildFairway();
  return passages.map((p) => {
    if (!p.inferred) return p;
    const entry = evidence.passages.find((e) => String(e.mmsi) === String(p.mmsi)
      && e.bridge === p.bridge && e.dir === p.dir
      && e.originalFrom === p.tFrom && e.originalTo === p.tTo);
    if (!entry) return p;
    if (!Array.isArray(entry.observations)
      || crypto.createHash('sha256').update(JSON.stringify(entry.observations)).digest('hex') !== entry.observationsSha256) {
      throw new Error(`Ändrade källposter för passagebevis ${p.mmsi} ${p.bridge}`);
    }
    const seen = new Set();
    const samples = entry.observations.map((observation) => {
      const r = observation.record;
      const rawTime = typeof r?.TIME === 'string' ? r.TIME : '';
      const time = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/.test(rawTime)
        ? Date.parse(rawTime.replace(' ', 'T').replace(' GMT', 'Z')) : NaN;
      // Ingen fallback till pollAt, receivedAt eller ett härlett positionsdatum.
      if (!Number.isFinite(time) || !Number.isFinite(observation.pollAt) || time > observation.pollAt
        || String(r.MMSI) !== String(p.mmsi) || !Number.isFinite(r.LATITUDE) || !Number.isFinite(r.LONGITUDE)
        || Math.abs(r.LATITUDE) > 90 || Math.abs(r.LONGITUDE) > 180 || seen.has(time)) {
        throw new Error(`Ogiltig källfix för passagebevis ${p.mmsi} ${p.bridge}`);
      }
      seen.add(time);
      return {
        mmsi: String(r.MMSI),
        name: r.NAME || '',
        lat: r.LATITUDE,
        lon: r.LONGITUDE,
        sog: Number.isFinite(r.SOG) ? r.SOG : null,
        t: time,
        tFix: time,
        feed: 'aishub',
        ...projectFix(fairway, r.LATITUDE, r.LONGITUDE),
      };
    }).sort((a, b) => a.t - b.t);
    const crossings = crossingsForVessel(samples.filter((s) => s.offsetM <= FAIRWAY_MAX_OFFSET_M))
      .filter((c) => c.bridge === p.bridge);
    // Flera korsningar eller motsatt riktning kan vara en annan resa.
    if (crossings.length !== 1) return p;
    const crossing = crossings[0];
    if (crossing.dir !== p.dir || crossing.tFrom < p.tFrom || crossing.tTo > p.tTo
      || crossing.tFrom >= crossing.tTo) return p;
    return {
      ...p,
      tFrom: crossing.tFrom,
      tTo: crossing.tTo,
      // Behåll inferred och ursprungsestimatet: vi har ett snävare fönster,
      // ingen observerad sekund för själva korsningen.
      timingEvidence: {
        source: evidence.source,
        originalFrom: p.tFrom,
        originalTo: p.tTo,
        observationsSha256: entry.observationsSha256,
      },
    };
  });
}

function loadAdditionalPassageEvidence(id, passages) {
  const file = path.join(__dirname, 'passage-evidence', `${id}.json`);
  if (!fs.existsSync(file)) return passages;
  return refinePassageWindows(passages, JSON.parse(fs.readFileSync(file, 'utf8')));
}

module.exports = { refinePassageWindows, loadAdditionalPassageEvidence };
