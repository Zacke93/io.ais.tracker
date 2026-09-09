'use strict';

// Endast beteendetillstånd. API-nycklar, konton och övriga inställningar
// får aldrig följa med fältlogg eller testkorpus.
const KEYS = Object.freeze([
  'learned_mooring_spots', 'known_vessel_names', 'quay_stable_ledger',
  'opening_quay_ledger', 'last_known_positions', 'persistent_recent_triggers',
  'trigger_point_visits', 'persistent_opening_warnings',
]);

function selectSettings(get) {
  const settings = {};
  for (const key of KEYS) {
    const value = get(key);
    if (value !== undefined && value !== null) settings[key] = value;
  }
  // Kopiera före init/persistens så starttillståndet inte muteras i efterhand.
  return JSON.parse(JSON.stringify(settings));
}

function loadState(record) {
  if (!record || record.version !== 1 || !Number.isFinite(record.capturedAt)
      || !record.settings || typeof record.settings !== 'object') throw new Error('Ogiltigt replay-starttillstånd');
  return selectSettings((key) => record.settings[key]);
}

module.exports = { KEYS, selectSettings, loadState };
