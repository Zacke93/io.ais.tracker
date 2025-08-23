'use strict';

/**
 * Constants for AIS Bridge app
 * Extracted from original app.js for centralized configuration
 */

// Vessel detection and filtering
const GRACE_MISSES = 3;
const GRACE_PERIOD_MS = 30000; // 30 seconds
const DIAGONAL_MOVE_THRESHOLD = 50; // meters
const HYSTERESIS_FACTOR = 0.9; // 10% closer required

// Bridge proximity and status
const APPROACHING_RADIUS = 500; // meters - triggers "närmar sig" messages
const APPROACH_RADIUS = 300; // meters - triggers "inväntar broöppning" messages
const UNDER_BRIDGE_SET_DISTANCE = 50; // meters - threshold to enter under-bridge status (spec compliance)
const UNDER_BRIDGE_CLEAR_DISTANCE = 70; // meters - threshold to exit under-bridge status (intentional hysteresis >50m spec)
const UNDER_BRIDGE_DISTANCE = UNDER_BRIDGE_SET_DISTANCE; // legacy alias - single source of truth
const PROTECTION_ZONE_RADIUS = 300; // meters - boats within this distance get extended timeout
const WAITING_SPEED_THRESHOLD = 0.20; // knots
const WAITING_TIME_THRESHOLD = 120000; // 2 minutes
const STATIONARY_FILTER_DISTANCE = 100; // meters - new stationary vessels beyond this are ignored
const MIN_APPROACH_DISTANCE = 10; // meters - minimum distance change required to qualify as approaching target bridge
const MINIMUM_MOVEMENT = 5; // meters - minimum movement to update position change time

// Connection settings
const MAX_RECONNECT_ATTEMPTS = 10; // max WebSocket reconnection attempts
const MAX_RECONNECT_DELAY = 5 * 60 * 1000; // 5 minutes max delay

// Bridge name mappings (FIX: Centralized to avoid duplication)
const BRIDGE_ID_TO_NAME = {
  olidebron: 'Olidebron',
  klaffbron: 'Klaffbron',
  jarnvagsbron: 'Järnvägsbron',
  stridsbergsbron: 'Stridsbergsbron',
  stallbackabron: 'Stallbackabron',
};

const BRIDGE_NAME_TO_ID = {
  Olidebron: 'olidebron',
  Klaffbron: 'klaffbron',
  Järnvägsbron: 'jarnvagsbron',
  Stridsbergsbron: 'stridsbergsbron',
  Stallbackabron: 'stallbackabron',
};

// Timeout settings for different zones
const TIMEOUT_SETTINGS = {
  NEAR_BRIDGE: 20 * 60 * 1000, // 20 minutes for boats <= 300m from bridge
  MEDIUM_DISTANCE: 10 * 60 * 1000, // 10 minutes for boats 300-600m from bridge
  FAR_DISTANCE: 2 * 60 * 1000, // 2 minutes for boats > 600m from bridge
  FAST_VESSEL_MIN: 5 * 60 * 1000, // Minimum 5 minutes for fast vessels (>4kn)
  WAITING_VESSEL_MIN: 20 * 60 * 1000, // Minimum 20 minutes for waiting vessels
};

// Bridge configuration
// The canal runs roughly NE-SW (bearing ~40°), bridges are perpendicular (~130°)
const BRIDGES = {
  olidebron: {
    name: 'Olidebron',
    lat: 58.272743083145855,
    lon: 12.275115821922993,
    radius: 300,
    axisBearing: 130, // Bridge orientation perpendicular to canal
  },
  klaffbron: {
    name: 'Klaffbron',
    lat: 58.28409551543077,
    lon: 12.283929525245636,
    radius: 300,
    axisBearing: 130, // Bridge orientation perpendicular to canal
  },
  jarnvagsbron: {
    name: 'Järnvägsbron',
    lat: 58.29164042152742,
    lon: 12.292025280073759,
    radius: 300,
    axisBearing: 130, // Bridge orientation perpendicular to canal
  },
  stridsbergsbron: {
    name: 'Stridsbergsbron',
    lat: 58.293524096154634,
    lon: 12.294566425158054,
    radius: 300,
    axisBearing: 130, // Bridge orientation perpendicular to canal
  },
  stallbackabron: {
    name: 'Stallbackabron',
    lat: 58.31142992293701,
    lon: 12.31456385688822,
    radius: 300,
    axisBearing: 125, // Slightly different angle at northernmost bridge
  },
};

// Target bridges (only these two can be assigned as targets)
const TARGET_BRIDGES = ['Klaffbron', 'Stridsbergsbron'];

// Intermediate bridges (never assigned as target bridges)
const INTERMEDIATE_BRIDGES = ['Olidebron', 'Järnvägsbron', 'Stallbackabron'];

// Bridge gaps for passage timing calculations (in meters)
const BRIDGE_GAPS = {
  'olidebron-klaffbron': 950,
  'klaffbron-jarnvagsbron': 960,
  'jarnvagsbron-stridsbergsbron': 420, // Shortest gap - critical
  'stridsbergsbron-stallbackabron': 530,
};

// Bridge sequence from south to north
const BRIDGE_SEQUENCE = [
  'olidebron',
  'klaffbron',
  'jarnvagsbron',
  'stridsbergsbron',
  'stallbackabron',
];

// COG direction thresholds for target bridge assignment
const COG_DIRECTIONS = {
  NORTH_MIN: 315, // 315° - 45° is considered northward
  NORTH_MAX: 45,
  // Everything else is considered southward
};

// AIS Stream configuration
const AIS_CONFIG = {
  API_KEY_FIELD: 'APIKey', // Field name for API key in subscription message
  BOUNDING_BOX: {
    NORTH: 58.32,
    SOUTH: 58.26,
    EAST: 12.32,
    WEST: 12.26,
  },
  RECONNECT_DELAYS: [1000, 2000, 5000, 10000, 30000], // Progressive delays in ms
  MESSAGE_TYPES: [1, 2, 3, 4, 5, 18, 19], // AIS message types to process
};

// Movement detection
const MOVEMENT_DETECTION = {
  MINIMUM_MOVEMENT: 5, // meters - minimum movement to update position change time
  STATIONARY_TIME_THRESHOLD: 60000, // 1 minute of no significant movement
  STATIONARY_SPEED_THRESHOLD: 0.1, // knots - below this is considered stationary
  GPS_JUMP_THRESHOLD: 500, // meters - movement above this triggers GPS jump detection
};

// Bridge text timing constants (NEW - for consistent passage windows)
const PASSAGE_TIMING = {
  JUST_PASSED_WINDOW: 60000, // 1 minute window for "precis passerat" messages
  PASSED_HOLD_MS: 60000, // 1 minute - same as JUST_PASSED_WINDOW for consistency
  FAST_VESSEL_PASSED_WINDOW: 120000, // 2 minutes for fast vessels (>5kn)
  DEFAULT_VESSEL_SPEED: 3, // knots - fallback speed for calculations
  MINIMUM_VIABLE_SPEED: 0.5, // knots - minimum speed for ETA calculations
};

// Stallbackabron special constants (NEW - from bridgeTextFormat.md)
const STALLBACKABRON_SPECIAL = {
  BRIDGE_NAME: 'Stallbackabron',
  NEVER_SHOW_WAITING: true, // Never shows "inväntar broöppning"
  USE_SPECIAL_MESSAGES: true, // Uses "åker strax under" and "passerar" messages
  ALWAYS_SHOW_TARGET_ETA: true, // Always shows ETA to target bridge
};

// Line crossing detection
const LINE_CROSSING_MIN_PROXIMITY_M = 150; // meters - min distance to bridge for valid crossing

// UI and timing constants
const UI_CONSTANTS = {
  UI_UPDATE_DEBOUNCE_MS: 100, // Debounce time for UI updates (increased from 10ms to allow timer to execute)
  BRIDGE_TEXT_CACHE_MS: 1000, // Cache time for bridge text
  MONITORING_INTERVAL_MS: 60000, // Monitoring interval (1 minute)
  STALE_DATA_TIMEOUT_STATIONARY_MS: 15 * 60 * 1000, // 15 minutes for stationary vessels
  STALE_DATA_TIMEOUT_MOVING_MS: 5 * 60 * 1000, // 5 minutes for moving vessels
  CLEANUP_EXTENSION_MS: 600000, // 10 minutes extension for protection zone
};

// Validation constants
const VALIDATION_CONSTANTS = {
  LATITUDE_MIN: -90,
  LATITUDE_MAX: 90,
  LONGITUDE_MIN: -180,
  LONGITUDE_MAX: 180,
  SOG_MAX: 100, // Maximum reasonable speed over ground
  COG_MAX: 360, // Maximum course over ground
  DISTANCE_PRECISION_DIGITS: 0, // Decimal places for distance logging
};

// Flow trigger constants
const FLOW_CONSTANTS = {
  BOAT_NEAR_DEDUPE_MINUTES: 10, // Minutes to dedupe boat_near triggers
  FLOW_TRIGGER_DISTANCE_THRESHOLD: 300, // meters - distance for flow triggers
};

// Bridge text grouping constants
const BRIDGE_TEXT_CONSTANTS = {
  DEFAULT_MESSAGE: 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron',
  PASSAGE_CLEAR_WINDOW_MS: 60 * 1000, // 60 seconds - matches "precis passerat" window
  VESSEL_DISTANCE_THRESHOLD: 400, // meters - max distance to consider for current bridge
  PASSED_HYSTERESIS_MS: 35000, // 35 seconds - stabilization period for "precis passerat" messages during GPS instability
  PASSED_WINDOW_MS: 60000, // 60 seconds - time window for "precis passerat" priority
};

// Status hysteresis constants for reducing UI pendling
const STATUS_HYSTERESIS = {
  APPROACHING_SET_DISTANCE: 450, // meters - distance to activate "närmar sig" status
  APPROACHING_CLEAR_DISTANCE: 550, // meters - distance to clear "närmar sig" status (prevents pendling)
};

module.exports = {
  GRACE_MISSES,
  APPROACHING_RADIUS,
  APPROACH_RADIUS,
  GRACE_PERIOD_MS,
  DIAGONAL_MOVE_THRESHOLD,
  HYSTERESIS_FACTOR,
  UNDER_BRIDGE_DISTANCE,
  BRIDGE_ID_TO_NAME,
  BRIDGE_NAME_TO_ID,
  UNDER_BRIDGE_SET_DISTANCE,
  UNDER_BRIDGE_CLEAR_DISTANCE,
  PROTECTION_ZONE_RADIUS,
  WAITING_SPEED_THRESHOLD,
  WAITING_TIME_THRESHOLD,
  STATIONARY_FILTER_DISTANCE,
  MIN_APPROACH_DISTANCE,
  MINIMUM_MOVEMENT,
  MAX_RECONNECT_ATTEMPTS,
  MAX_RECONNECT_DELAY,
  TIMEOUT_SETTINGS,
  BRIDGES,
  TARGET_BRIDGES,
  INTERMEDIATE_BRIDGES,
  BRIDGE_GAPS,
  BRIDGE_SEQUENCE,
  COG_DIRECTIONS,
  AIS_CONFIG,
  MOVEMENT_DETECTION,
  PASSAGE_TIMING,
  STALLBACKABRON_SPECIAL,
  LINE_CROSSING_MIN_PROXIMITY_M,
  UI_CONSTANTS,
  VALIDATION_CONSTANTS,
  FLOW_CONSTANTS,
  BRIDGE_TEXT_CONSTANTS,
  STATUS_HYSTERESIS,
};
