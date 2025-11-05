'use strict';

/**
 * =============================================================================
 * CONSTANTS - CENTRALISERAD KONFIGURATION
 * =============================================================================
 *
 * SYFTE:
 * Denna fil innehåller ALLA konfigurations-konstanter för AIS Bridge appen.
 * Genom att samla allt på ett ställe blir det lättare att:
 * - Förstå hur appen är konfigurerad
 * - Ändra beteende utan att leta i kod
 * - Undvika duplicering av magic numbers
 *
 * VIKTIGT:
 * Alla mått är i meter (m) och millisekunder (ms) om inte annat anges.
 * Alla vinklar är i grader (0-360°).
 */

// =============================================================================
// VESSEL DETECTION OCH FILTERING
// =============================================================================

// GRACE MISSES: Antal AIS-meddelanden som kan missas innan vessel filtreras bort
const GRACE_MISSES = 3;

// GRACE PERIOD: Tidsperiod för grace misses (30 sekunder)
const GRACE_PERIOD_MS = 30000;

// DIAGONAL MOVE: Minsta diagonal rörelse (meter) för att räknas som verklig förflyttning
// Används för att filtrera bort GPS-instabilitet
const DIAGONAL_MOVE_THRESHOLD = 50;

// HYSTERESIS FACTOR: Faktor för att förhindra "pendling" i detektering
// 0.9 = måste vara 10% närmare för att trigga ny detektering
const HYSTERESIS_FACTOR = 0.9;

// =============================================================================
// BRIDGE PROXIMITY OCH STATUS - AVSTÅNDS-TRIGGRAR
// =============================================================================
// Dessa definierar när olika statusar och meddelanden triggas

// APPROACHING (500m): "En båt närmar sig [bro]"
const APPROACHING_RADIUS = 500; // meter

// APPROACH/WAITING (300m): "En båt inväntar broöppning vid [bro]"
const APPROACH_RADIUS = 300; // meter

// UNDER BRIDGE (50m set, 70m clear): "Broöppning pågår vid [bro]"
// HYSTERESIS: 50m för att SÄTTA status, 70m för att RENSA status
// Detta förhindrar fladder när båt är precis vid 50m gränsen
const UNDER_BRIDGE_SET_DISTANCE = 50; // meter - aktiverar status
const UNDER_BRIDGE_CLEAR_DISTANCE = 70; // meter - avaktiverar status
const UNDER_BRIDGE_DISTANCE = UNDER_BRIDGE_SET_DISTANCE; // Legacy alias för bakåtkompatibilitet

// PROTECTION ZONE (300m): Båtar inom detta avstånd får längre timeout
// Detta förhindrar att båtar tas bort för tidigt när de väntar vid bro
const PROTECTION_ZONE_RADIUS = 300; // meter

// WAITING SPEED: Under denna hastighet anses båt "vänta"
const WAITING_SPEED_THRESHOLD = 0.20; // knop

// WAITING TIME: Hur länge båt måste ha låg hastighet för att räknas som waiting
const WAITING_TIME_THRESHOLD = 120000; // 2 minuter

// WAITING ETA LIMIT: Max ETA to display while vessel is in waiting zone
const WAITING_STATUS_MAX_ETA_MINUTES = 12; // minuter

// STATIONARY FILTER: Nya stillastående båtar bortom detta avstånd ignoreras
// Förhindrar att förankrade båtar långt borta dyker upp i systemet
const STATIONARY_FILTER_DISTANCE = 100; // meter

// MIN APPROACH DISTANCE: Minsta avståndsminskning för att räknas som "approaching"
const MIN_APPROACH_DISTANCE = 10; // meter

// MINIMUM MOVEMENT: Minsta rörelse för att uppdatera position change time
const MINIMUM_MOVEMENT = 5; // meter

// =============================================================================
// CONNECTION SETTINGS - WEBSOCKET ÅTERANSLUTNING
// =============================================================================

// MAX RECONNECT ATTEMPTS: Max antal återanslutningsförsök till AISstream.io
const MAX_RECONNECT_ATTEMPTS = 10;

// MAX RECONNECT DELAY: Längsta väntetid mellan återanslutningsförsök
const MAX_RECONNECT_DELAY = 5 * 60 * 1000; // 5 minuter

// =============================================================================
// BRIDGE NAME MAPPINGS - ID ↔ NAMN KONVERTERING
// =============================================================================
// Används för att konvertera mellan Flow-kort ID och displaynamn

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

// =============================================================================
// TIMEOUT SETTINGS - CLEANUP TIMEOUTS BASERAT PÅ AVSTÅND
// =============================================================================
// Hur länge en båt får finnas kvar i systemet beroende på avstånd till bro

const TIMEOUT_SETTINGS = {
  NEAR_BRIDGE: 20 * 60 * 1000, // 20 minuter - inom 300m från bro
  MEDIUM_DISTANCE: 10 * 60 * 1000, // 10 minuter - 300-600m från bro
  FAR_DISTANCE: 2 * 60 * 1000, // 2 minuter - >600m från bro
  FAST_VESSEL_MIN: 5 * 60 * 1000, // 5 minuter minimum för snabba båtar (>4 knop)
  WAITING_VESSEL_MIN: 20 * 60 * 1000, // 20 minuter minimum för väntande båtar
};

// =============================================================================
// BRIDGE CONFIGURATION - BRO-POSITIONER OCH ORIENTERING
// =============================================================================
// GPS-koordinater och orientering för alla broar i Trollhättekanalen
//
// KANALEN: Går i riktning NE-SW (bäring ~40°)
// BROAR: Står vinkelrätt mot kanalen (bäring ~130°)

const BRIDGES = {
  olidebron: {
    name: 'Olidebron',
    lat: 58.272743083145855, // Sydligaste bron
    lon: 12.275115821922993,
    radius: 300, // Detektionsradie (meter)
    axisBearing: 130, // Bro-orientering (vinkelrätt mot kanal)
  },
  klaffbron: {
    name: 'Klaffbron', // MÅLBRO 1 (öppningsbar)
    lat: 58.28409551543077,
    lon: 12.283929525245636,
    radius: 300,
    axisBearing: 130,
  },
  jarnvagsbron: {
    name: 'Järnvägsbron',
    lat: 58.29164042152742,
    lon: 12.292025280073759,
    radius: 300,
    axisBearing: 130,
  },
  stridsbergsbron: {
    name: 'Stridsbergsbron', // MÅLBRO 2 (öppningsbar)
    lat: 58.293524096154634,
    lon: 12.294566425158054,
    radius: 300,
    axisBearing: 130,
  },
  stallbackabron: {
    name: 'Stallbackabron', // SPECIALFALL: Hög bro utan öppning
    lat: 58.31142992293701, // Nordligaste bron
    lon: 12.31456385688822,
    radius: 300,
    axisBearing: 125, // Lite annorlunda vinkel
  },
};

// =============================================================================
// TARGET OCH INTERMEDIATE BRIDGES
// =============================================================================

// TARGET BRIDGES: Endast dessa kan tilldelas som målbro (öppningsbara broar)
const TARGET_BRIDGES = ['Klaffbron', 'Stridsbergsbron'];

// INTERMEDIATE BRIDGES: Aldrig målbro, men kan passeras på vägen
const INTERMEDIATE_BRIDGES = ['Olidebron', 'Järnvägsbron', 'Stallbackabron'];

// =============================================================================
// BRIDGE GAPS - AVSTÅND MELLAN BROAR
// =============================================================================
// Används för passage timing och ETA-beräkningar

const BRIDGE_GAPS = {
  'olidebron-klaffbron': 950, // meter
  'klaffbron-jarnvagsbron': 960, // meter
  'jarnvagsbron-stridsbergsbron': 420, // KORTASTE gap - kritiskt för timing
  'stridsbergsbron-stallbackabron': 2310, // KORRIGERAT från 530m (var 335% för lågt)
};

// =============================================================================
// BRIDGE SEQUENCE - BRO-ORDNING SYD → NORD
// =============================================================================

const BRIDGE_SEQUENCE = [
  'olidebron', // Syd
  'klaffbron',
  'jarnvagsbron',
  'stridsbergsbron',
  'stallbackabron', // Nord
];

// =============================================================================
// COG DIRECTIONS - KURS-RIKTNINGAR FÖR MÅLBRO-TILLDELNING
// =============================================================================
// Course Over Ground (COG) trösklar för att avgöra färdriktning
//
// NORRUT: 315° - 45° (NW genom N till NE)
// SÖDERUT: Allt annat (46° - 314°)

const COG_DIRECTIONS = {
  NORTH_MIN: 315, // 315° och uppåt räknas som norrut
  NORTH_MAX: 45, // 0°-45° räknas också som norrut
  // Everything else (46°-314°) = söderut
};

// =============================================================================
// AIS STREAM CONFIGURATION - AISSTREAM.IO INSTÄLLNINGAR
// =============================================================================

const AIS_CONFIG = {
  API_KEY_FIELD: 'APIKey', // Fältnamn för API-nyckel i subscription message

  // BOUNDING BOX: Geografisk låda som filtrerar AIS-data
  // Endast båtar inom denna box tas emot från AISstream.io
  BOUNDING_BOX: {
    NORTH: 58.32, // Norra gräns (latitud)
    SOUTH: 58.26, // Södra gräns
    EAST: 12.32, // Östra gräns (longitud)
    WEST: 12.26, // Västra gräns
  },

  // RECONNECT DELAYS: Progressiv fördröjning vid återanslutning (ms)
  // [1s, 2s, 5s, 10s, 30s] - ökar gradvis vid upprepade misslyckanden
  RECONNECT_DELAYS: [1000, 2000, 5000, 10000, 30000],

  // MESSAGE TYPES: Vilka AIS message types som processas
  // 1-3: Position reports, 4: Base station, 5: Static data, 18-19: Class B
  MESSAGE_TYPES: [1, 2, 3, 4, 5, 18, 19],
};

// =============================================================================
// MOVEMENT DETECTION - RÖRELSE-DETEKTERING
// =============================================================================

const MOVEMENT_DETECTION = {
  MINIMUM_MOVEMENT: 5, // meter - minsta rörelse för position update
  STATIONARY_TIME_THRESHOLD: 60000, // 1 minut utan rörelse = stationary
  STATIONARY_SPEED_THRESHOLD: 0.1, // knop - under detta = stillastående
  GPS_JUMP_THRESHOLD: 500, // meter - över detta = GPS-hopp detekteras
};

// =============================================================================
// PASSAGE TIMING - BROPASSAGE TIMING
// =============================================================================

const PASSAGE_TIMING = {
  JUST_PASSED_WINDOW: 60000, // 1 minut - "precis passerat" fönster
  PASSED_HOLD_MS: 60000, // 1 minut - samma som JUST_PASSED_WINDOW
  FAST_VESSEL_PASSED_WINDOW: 120000, // 2 minuter för snabba båtar (>5 knop)
  DEFAULT_VESSEL_SPEED: 3, // knop - fallback-hastighet för beräkningar
  MINIMUM_VIABLE_SPEED: 0.5, // knop - minsta hastighet för ETA-beräkning
};

// =============================================================================
// STALLBACKABRON SPECIAL - SPECIALREGLER FÖR STALLBACKABRON
// =============================================================================
// Stallbackabron är en HÖG bro som aldrig öppnas
// Därför används speciella meddelanden istället för "inväntar broöppning"

const STALLBACKABRON_SPECIAL = {
  BRIDGE_NAME: 'Stallbackabron',
  NEVER_SHOW_WAITING: true, // Visar ALDRIG "inväntar broöppning"
  USE_SPECIAL_MESSAGES: true, // Använder "åker strax under" och "passerar"
  ALWAYS_SHOW_TARGET_ETA: true, // Visar alltid ETA till målbro
};

// =============================================================================
// LINE CROSSING DETECTION - LINJE-KORSNINGS DETEKTERING
// =============================================================================
// Används för att detektera bropassage även med gles AIS-data

// MIN PROXIMITY: Minsta avstånd till bro för att korsning ska vara giltig
// Om båt är >150m från bro när den korsar linjen, räknas det inte som passage
const LINE_CROSSING_MIN_PROXIMITY_M = 150;

// =============================================================================
// UI AND TIMING CONSTANTS - UI-UPPDATERING OCH TIMING
// =============================================================================

const UI_CONSTANTS = {
  UI_UPDATE_DEBOUNCE_MS: 100, // Debounce för UI-uppdateringar
  BRIDGE_TEXT_CACHE_MS: 1000, // Cache-tid för bridge text
  MONITORING_INTERVAL_MS: 60000, // Monitoring loop (1 minut)
  STALE_DATA_TIMEOUT_STATIONARY_MS: 15 * 60 * 1000, // 15 min för stillastående
  STALE_DATA_TIMEOUT_MOVING_MS: 5 * 60 * 1000, // 5 min för rörliga båtar
  CLEANUP_EXTENSION_MS: 600000, // 10 min extension i protection zone
};

// =============================================================================
// VALIDATION CONSTANTS - VALIDERINGS-GRÄNSER
// =============================================================================

const VALIDATION_CONSTANTS = {
  LATITUDE_MIN: -90, // Minsta latitud
  LATITUDE_MAX: 90, // Största latitud
  LONGITUDE_MIN: -180, // Minsta longitud
  LONGITUDE_MAX: 180, // Största longitud
  SOG_MAX: 100, // Max rimlig hastighet (knop)
  COG_MAX: 360, // Max kurs (grader)
  DISTANCE_PRECISION_DIGITS: 0, // Decimaler för avstånds-logging
};

// =============================================================================
// FLOW TRIGGER CONSTANTS - HOMEY FLOW-KORT KONFIGURATION
// =============================================================================

const FLOW_CONSTANTS = {
  BOAT_NEAR_DEDUPE_MINUTES: 10, // Minuter mellan boat_near triggers
  FLOW_TRIGGER_DISTANCE_THRESHOLD: 300, // meter - avstånd för flow triggers
};

// =============================================================================
// BRIDGE TEXT CONSTANTS - BRIDGE TEXT MEDDELANDE-REGLER
// =============================================================================

const BRIDGE_TEXT_CONSTANTS = {
  DEFAULT_MESSAGE: 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron',
  PASSAGE_CLEAR_WINDOW_MS: 60 * 1000, // 60 sek - "precis passerat" fönster
  VESSEL_DISTANCE_THRESHOLD: 400, // meter - max avstånd för currentBridge
  PASSED_HYSTERESIS_MS: 35000, // 35 sek - stabilisering vid GPS-instabilitet
  PASSED_WINDOW_MS: 60000, // 60 sek - "precis passerat" prioritet
};

// =============================================================================
// STATUS HYSTERESIS - FÖRHINDRA UI-PENDLING
// =============================================================================
// Olika trösklar för att SÄTTA och RENSA status förhindrar fladder

const STATUS_HYSTERESIS = {
  // APPROACHING ZONE (500m nominal)
  APPROACHING_SET_DISTANCE: 450, // meter - aktiverar "närmar sig"
  APPROACHING_CLEAR_DISTANCE: 550, // meter - avaktiverar "närmar sig"

  // WAITING ZONE (300m nominal)
  WAITING_SET_DISTANCE: 280, // meter - aktiverar "inväntar broöppning"
  WAITING_CLEAR_DISTANCE: 320, // meter - avaktiverar "inväntar broöppning"

  // UNDER-BRIDGE ZONE
  // UNDER_BRIDGE_SET_DISTANCE: 50m, UNDER_BRIDGE_CLEAR_DISTANCE: 70m (definierat ovan)

  // ZONE TRANSITION TIMINGS
  CRITICAL_TRANSITION_HOLD_MS: 3000, // 3 sek - håll kritiska övergångar
  ZONE_TRANSITION_GRACE_MS: 1500, // 1.5 sek - grace vid zongränser
  SYNTHETIC_UNDER_BRIDGE_DURATION_MS: 8000, // 8 sek - syntetisk under-bro period vid linjekorsning
};

// ROUTE DIRECTION LOCKING
const ROUTE_DIRECTION_LOCK_MS = 120000; // 2 minuter - håll färdriktningslås efter målbro-byte

// PASSAGE COOLDOWNS
const INTERMEDIATE_PASSAGE_COOLDOWN_MS = 180000; // 3 minuter - blockera väntestatus efter mellanbro

// =============================================================================
// EXPORTS - EXPORTERA ALLA KONSTANTER
// =============================================================================

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
  ROUTE_DIRECTION_LOCK_MS,
  INTERMEDIATE_PASSAGE_COOLDOWN_MS,
  WAITING_SPEED_THRESHOLD,
  WAITING_TIME_THRESHOLD,
  WAITING_STATUS_MAX_ETA_MINUTES,
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
