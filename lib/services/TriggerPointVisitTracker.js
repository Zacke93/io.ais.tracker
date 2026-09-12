'use strict';

const {
  BRIDGES, TRIGGER_POINTS, UI_CONSTANTS, AIS_CONFIG,
} = require('../constants');
const geometry = require('../utils/geometry');

const POINTS = new Map([...Object.values(BRIDGES), ...Object.values(TRIGGER_POINTS)].map((point) => [point.name, point]));
const DEPARTED_RETENTION_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 2048;

/**
 * Ett notifierat besök vid en bro eller Kanalinfarten varar tills faktisk utfärd och
 * återkomst observerats. Tystnad, förtöjning och ny resa är inga utfärdsbevis.
 * Två rena fixar över 350 m bekräftar utfärd; återkomst kräver högst 300 m.
 * Ingen timer eller extern livscykel äger kartan. Appen persisterar fasbyten
 * och slutligen hela snapshoten, inklusive en ännu obekräftad utfärdsfix.
 */
class TriggerPointVisitTracker {
  constructor({ logger = null, now = () => Date.now() } = {}) {
    this._logger = logger;
    this._now = now;
    this._entries = new Map();
  }

  _key(mmsi, pointName = 'Kanalinfarten') {
    if ((typeof mmsi !== 'string' && typeof mmsi !== 'number') || !POINTS.has(pointName)) return null;
    const id = String(mmsi);
    return /^\d{9}$/.test(id) ? `${id}:${pointName}` : null;
  }

  _sample(vessel, point) {
    if (!point || !vessel || vessel._gpsJumpDetected || vessel._positionUncertain) return null;
    const distance = geometry.calculateDistance(vessel.lat, vessel.lon, point.lat, point.lon);
    if (!Number.isFinite(distance)) return null;
    const positionTs = Math.max(
      Number.isFinite(vessel.timestamp) ? vessel.timestamp : 0,
      Number.isFinite(vessel.lastPositionUpdate) ? vessel.lastPositionUpdate : 0,
    );
    const now = this._now();
    const futureMargin = AIS_CONFIG.AISHUB.SEEN_MAX_FUTURE_SKEW_MS;
    if (positionTs <= 0 || now - positionTs > UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS
        || positionTs - now > futureMargin) return null;
    const fixTs = Number.isFinite(vessel.fixTs) ? vessel.fixTs : positionTs;
    if (fixTs < 0 || fixTs - now > futureMargin || now - fixTs > AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS) return null;
    if (vessel.fixFeed === 'aishub'
        && (!Number.isFinite(vessel.fixTs) || now - fixTs > AIS_CONFIG.AISHUB.MAX_FIX_AGE_MS)) return null;
    return { distance, fixTs, positionTs };
  }

  holds(mmsi, pointName = 'Kanalinfarten') {
    const key = this._key(mmsi, pointName);
    return key !== null && this._entries.has(key);
  }

  _crossedPoint(entry, vessel, sample, point) {
    // Samma sex timmars historik som appens lastKnown-baserade passage-
    // fallback. Ankaret var rent/färskt när det observerades, men ska inte
    // förväxlas med aktuell AIS-hälsa. ELFKUNGENs 43 min radiogap slutar
    // 302 m bort; båda ändpunkterna är utanför, segmentet går 103 m från
    // punkten. Radien för själva återkomsten är fortfarande exakt 300 m.
    if (!Number.isFinite(entry.lastPositionTs)
        || this._now() - entry.lastPositionTs > DEPARTED_RETENTION_MS
        || !Number.isFinite(entry.lastLat) || !Number.isFinite(entry.lastLon)
        || sample.distance <= point.radius
        || (entry.lastLat - point.lat) * (vessel.lat - point.lat) >= 0) return false;
    const previousDistance = geometry.calculateDistance(entry.lastLat, entry.lastLon, point.lat, point.lon);
    return Number.isFinite(previousDistance) && previousDistance > point.radius
      && geometry.distancePointToSegmentM(
        point.lat, point.lon, entry.lastLat, entry.lastLon, vessel.lat, vessel.lon,
      ) <= point.radius;
  }

  observe(vessel, pointName = 'Kanalinfarten') {
    const point = POINTS.get(pointName);
    const key = this._key(vessel?.mmsi, pointName);
    const entry = key === null ? null : this._entries.get(key);
    const sample = entry && this._sample(vessel, point);
    if (!sample || sample.fixTs <= entry.lastFixTs) return { changed: false, reentered: false };
    const crossedPoint = (entry.exitedAt !== null || entry.outsideFixTs !== null)
      && this._crossedPoint(entry, vessel, sample, point);
    // Efter en belagd passage räcker två tydliga positioner på bortre sidan:
    // båda utanför området, den senare även utanför hysteresen och minst
    // 50 m längre bort. Då tappas inte en verklig retur efter gles AIS.
    const previousDistance = geometry.calculateDistance(entry.lastLat, entry.lastLon, point.lat, point.lon);
    const departedAfterPassage = entry.exitedAt === null
      && vessel.passedBridges?.includes(pointName)
      && sample.fixTs - entry.lastFixTs <= UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS
      && sample.distance > point.radius + 50 && previousDistance > point.radius
      && sample.distance >= previousDistance + 50
      && geometry.isDecisivelyOppositeBridgeSide(
        { lat: entry.arrivalLat, lon: entry.arrivalLon }, { lat: entry.lastLat, lon: entry.lastLon }, point,
      )
      && geometry.isDecisivelyOppositeBridgeSide(
        { lat: entry.arrivalLat, lon: entry.arrivalLon }, vessel, point,
      );
    entry.lastFixTs = sample.fixTs;
    entry.lastLat = vessel.lat;
    entry.lastLon = vessel.lon;
    entry.lastPositionTs = sample.positionTs;
    // Andra rena utanförfixen kan samtidigt bevisa återkomst genom zonen.
    // ELFKUNGEN vid Stallbackabron: 450 m norr → 1752 m söder. Att först
    // bara markera utfärd skulle blockera den redan observerade returen.
    if (crossedPoint) {
      this._entries.delete(key);
      return { changed: true, reentered: true };
    }
    if (departedAfterPassage) {
      entry.outsideFixTs = sample.fixTs;
      entry.exitedAt = this._now();
      return { changed: true, reentered: false };
    }
    if (entry.exitedAt !== null) {
      if (sample.distance <= point.radius) {
        this._entries.delete(key);
        return { changed: true, reentered: true };
      }
      if (this._now() - entry.exitedAt > DEPARTED_RETENTION_MS) {
        this._entries.delete(key);
        return { changed: true, reentered: false };
      }
    } else if (sample.distance > point.radius + 50) {
      if (entry.outsideFixTs !== null) {
        entry.exitedAt = this._now();
        return { changed: true, reentered: false };
      }
      entry.outsideFixTs = sample.fixTs;
      return { changed: true, reentered: false };
    } else if (entry.outsideFixTs !== null) {
      entry.outsideFixTs = null;
      return { changed: true, reentered: false };
    }
    return { changed: false, reentered: false };
  }

  /**
   * Reserveras före async Flow-anrop; null innebär att ingen ny post ägs.
   * En historisk passage-fallback långt utanför området bevisar ingen
   * pågående vistelse där. Den behåller appens äldre passage-dedup.
   */
  reserve(vessel, pointName = 'Kanalinfarten') {
    const point = POINTS.get(pointName);
    const key = this._key(vessel?.mmsi, pointName);
    const sample = key !== null && this._sample(vessel, point);
    if (!sample || sample.distance > point.radius + 50 || this._entries.has(key)) return null;
    this._pruneDeparted();
    this._makeRoom();
    const entry = {
      startedAt: this._now(),
      lastFixTs: sample.fixTs,
      outsideFixTs: null,
      exitedAt: null,
      lastLat: vessel.lat,
      lastLon: vessel.lon,
      lastPositionTs: sample.positionTs,
      arrivalLat: vessel.lat,
      arrivalLon: vessel.lon,
    };
    this._entries.set(key, entry);
    return entry;
  }

  rollback(mmsi, entry, pointName = 'Kanalinfarten') {
    const key = this._key(mmsi, pointName);
    if (!entry || key === null || this._entries.get(key) !== entry) return false;
    return this._entries.delete(key);
  }

  _pruneDeparted() {
    const now = this._now();
    for (const [key, entry] of this._entries) {
      if (entry.exitedAt !== null && now - entry.exitedAt > DEPARTED_RETENTION_MS) this._entries.delete(key);
    }
  }

  _warn(message) {
    const log = this._logger?.warn || this._logger?.log;
    if (typeof log === 'function') log.call(this._logger, `[TRIGGER_POINT_VISIT_CAP] ${message}`);
  }

  _makeRoom() {
    if (this._entries.size < MAX_ENTRIES) return;
    let oldest = null;
    for (const pair of this._entries) {
      const entry = pair[1];
      if (!oldest
          || (entry.exitedAt !== null && oldest[1].exitedAt === null)
          || ((entry.exitedAt !== null) === (oldest[1].exitedAt !== null)
            && (entry.exitedAt ?? entry.startedAt) < (oldest[1].exitedAt ?? oldest[1].startedAt))) oldest = pair;
    }
    this._entries.delete(oldest[0]);
    if (oldest[1].exitedAt === null) {
      // Säkerhetstaket går före obegränsad minnestillväxt. Endast när ALLA
      // 2048 poster saknar utfärdsbevis förloras skyddet för äldsta besöket;
      // det kan ge en ny notis efter återkomst, och får därför aldrig döljas.
      this._warn(`2048 aktiva besök: äldsta posten ${oldest[0]} släppt; dubbleringsskyddet för den båten förloras`);
    }
  }

  exportSnapshot() {
    this._pruneDeparted();
    const entries = {};
    for (const [key, entry] of this._entries) entries[key] = { ...entry };
    return { version: 2, entries };
  }

  loadSnapshot(snapshot) {
    this._entries.clear();
    if (!snapshot || ![1, 2].includes(snapshot.version) || !snapshot.entries
        || typeof snapshot.entries !== 'object' || Array.isArray(snapshot.entries)) return 0;
    const now = this._now();
    const latestAllowed = now + AIS_CONFIG.AISHUB.SEEN_MAX_FUTURE_SKEW_MS;
    const validTime = (value) => Number.isFinite(value) && value >= 0 && value <= latestAllowed;
    let examined = 0;
    // Även läsningen har ett tak: en skadad inställning får inte bygga en
    // tillfällig Object.entries-array eller en obegränsad genomgång.
    // eslint-disable-next-line no-restricted-syntax
    for (const storedKey in snapshot.entries) {
      if (!Object.prototype.hasOwnProperty.call(snapshot.entries, storedKey)) continue;
      if (examined >= MAX_ENTRIES) {
        this._warn('snapshot innehåller fler än 2048 poster; överskjutande poster läses inte');
        break;
      }
      examined++;
      // V1 sparade verkliga Kanalinfartsbesök under bara MMSI. Migrationen
      // behåller dem där; ingen gammal tidsstämpel blir ny brohistorik.
      const parts = snapshot.version === 1 ? [storedKey, 'Kanalinfarten'] : storedKey.split(':');
      const key = parts.length === 2 ? this._key(parts[0], parts[1]) : null;
      const point = POINTS.get(parts[1]);
      const entry = snapshot.entries[storedKey];
      if (key === null || !entry || typeof entry !== 'object' || Array.isArray(entry)
          || !validTime(entry.startedAt) || !validTime(entry.lastFixTs)
          || (entry.outsideFixTs !== null && (!validTime(entry.outsideFixTs) || entry.outsideFixTs > entry.lastFixTs))
          || (entry.exitedAt !== null && (!validTime(entry.exitedAt) || entry.exitedAt < entry.startedAt
            || entry.outsideFixTs === null))) continue;
      // Äldre version-1-poster utan koordinater får behålla sitt besök men
      // kan inte bevisa ett segment förrän en riktig ny position observerats.
      const hasPosition = entry.lastLat != null || entry.lastLon != null || entry.lastPositionTs != null;
      if (hasPosition && (!validTime(entry.lastPositionTs)
          || !Number.isFinite(geometry.calculateDistance(entry.lastLat, entry.lastLon, point.lat, point.lon)))) continue;
      if (entry.exitedAt !== null && now - entry.exitedAt > DEPARTED_RETENTION_MS) continue;
      const hasArrival = Number.isFinite(geometry.calculateDistance(entry.arrivalLat, entry.arrivalLon, point.lat, point.lon));
      this._entries.set(key, {
        startedAt: entry.startedAt,
        lastFixTs: entry.lastFixTs,
        outsideFixTs: entry.outsideFixTs,
        exitedAt: entry.exitedAt,
        lastLat: hasPosition ? entry.lastLat : null,
        lastLon: hasPosition ? entry.lastLon : null,
        lastPositionTs: hasPosition ? entry.lastPositionTs : null,
        arrivalLat: hasArrival ? entry.arrivalLat : null,
        arrivalLon: hasArrival ? entry.arrivalLon : null,
      });
    }
    return this._entries.size;
  }
}

module.exports = TriggerPointVisitTracker;
