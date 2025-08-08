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
const APPROACHING_RADIUS = 500; // meters - NEW: triggers "närmar sig" messages
const APPROACH_RADIUS = 300; // meters - triggers "inväntar broöppning" messages
const UNDER_BRIDGE_DISTANCE = 50; // meters (DEPRECATED - use UNDER_BRIDGE_SET_DISTANCE)
const UNDER_BRIDGE_SET_DISTANCE = 50; // meters - threshold to enter under-bridge status
const UNDER_BRIDGE_CLEAR_DISTANCE = 70; // meters - threshold to exit under-bridge status (hysteresis)
const PROTECTION_ZONE_RADIUS = 300; // meters - boats within this distance get extended timeout
const WAITING_SPEED_THRESHOLD = 0.20; // knots
const WAITING_TIME_THRESHOLD = 120000; // 2 minutes
const STATIONARY_FILTER_DISTANCE = 100; // meters - new stationary vessels beyond this are ignored

// Connection settings
const MAX_RECONNECT_ATTEMPTS = 10; // max WebSocket reconnection attempts
const MAX_RECONNECT_DELAY = 5 * 60 * 1000; // 5 minutes max delay

// Timeout settings for different zones
const TIMEOUT_SETTINGS = {
  NEAR_BRIDGE: 20 * 60 * 1000, // 20 minutes for boats <= 300m from bridge
  MEDIUM_DISTANCE: 10 * 60 * 1000, // 10 minutes for boats 300-600m from bridge
  FAR_DISTANCE: 2 * 60 * 1000, // 2 minutes for boats > 600m from bridge
  FAST_VESSEL_MIN: 5 * 60 * 1000, // Minimum 5 minutes for fast vessels (>4kn)
  WAITING_VESSEL_MIN: 20 * 60 * 1000, // Minimum 20 minutes for waiting vessels
};

// Bridge configuration
const BRIDGES = {
  olidebron: {
    name: 'Olidebron',
    lat: 58.272743083145855,
    lon: 12.275115821922993,
    radius: 300,
  },
  klaffbron: {
    name: 'Klaffbron',
    lat: 58.28409551543077,
    lon: 12.283929525245636,
    radius: 300,
  },
  jarnvagsbron: {
    name: 'Järnvägsbron',
    lat: 58.29164042152742,
    lon: 12.292025280073759,
    radius: 300,
  },
  stridsbergsbron: {
    name: 'Stridsbergsbron',
    lat: 58.293524096154634,
    lon: 12.294566425158054,
    radius: 300,
  },
  stallbackabron: {
    name: 'Stallbackabron',
    lat: 58.31142992293701,
    lon: 12.31456385688822,
    radius: 300,
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

// Line crossing detection constants
const LINE_CROSSING_MIN_PROXIMITY_M = 150; // meters - min distance to bridge for valid crossing
const FEATURE_LINE_CROSSING = true; // Enable line crossing detection

// Boat near trigger dedupe
const BOAT_NEAR_DEDUPE_MINUTES = 10; // minutes - prevent duplicate triggers

module.exports = {
  GRACE_MISSES,
  APPROACHING_RADIUS,
  APPROACH_RADIUS,
  GRACE_PERIOD_MS,
  DIAGONAL_MOVE_THRESHOLD,
  HYSTERESIS_FACTOR,
  UNDER_BRIDGE_DISTANCE,
  UNDER_BRIDGE_SET_DISTANCE,
  UNDER_BRIDGE_CLEAR_DISTANCE,
  PROTECTION_ZONE_RADIUS,
  WAITING_SPEED_THRESHOLD,
  WAITING_TIME_THRESHOLD,
  STATIONARY_FILTER_DISTANCE,
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
  FEATURE_LINE_CROSSING,
  BOAT_NEAR_DEDUPE_MINUTES,
};
