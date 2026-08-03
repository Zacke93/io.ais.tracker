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

// SEGMENTBEVIS FÖR UNDER-BRO-ZONEN (V2, A/B-nattkörningen 2026-08-03)
// Vid TÄT sampling (dubbelkälla, ~68 s kadens) kan det fix som landar inne i
// under-bro-zonen redan ligga BORTOM brolinjen: ingångs- och utgångssidan blir
// då densamma och entry↔exit-jämförelsen läste en äkta passage som kö-drift
// (TIM 2026-08-02: Olidebron -98 m → +16 m → +123 m, Järnvägsbron -68 → +16 →
// +105; båda mellanbropassagerna åts upp och Klaffbron-ETA:n klättrade
// 12→17 min i progressive_route). Zonbesöket bär därför ett SEGMENTBEVIS:
// korsar ett konsekutivfix-segment brolinjen KORRIGERAS inträdesankaret till
// segmentets startpunkt, varefter den befintliga entry↔exit-vakten avgör som
// vanligt (nettosidbyte — U-svängar och kö-drift ger fortfarande ingen
// ankring). Taket skiljer tät sampling från AIS-glapp — ett segment
// längre än så är ett glapp (400 m ≈ 2 min i 6,5 knop) och hanteras av
// gap-/inferensvägarna (_checkSkippedBridgesFallback, inferred passages) som
// har egna dedup-vakter. U-svängar berörs inte: utan sidbyte i något segment
// finns inget bevis och beteendet är oförändrat (AKIRA-låset).
const UNDER_BRIDGE_CROSS_SEGMENT_MAX_M = 400; // meter

// KÄLLGRIND FÖR SEGMENTBEVISET (batterirunda 1, 2026-08-03)
// Rotorsaken är KÄLLNEUTRAL — samma signatur finns i enkelkälleläget. Mätning
// över alla 15 låsta korpusar (~240 h) mot nattens B-arm (~10 h):
//   enkelkälla  5 träffar / 240 h  ≈ 0,02/h  (NORDIC SOLA, ORANESS, CATHARINA,
//                                             ALICE, EXCALIBUR — samtliga
//                                             Olidebron, samtliga äkta)
//   dubbelkälla 2 träffar /  10 h  ≈ 0,2/h   (TIM: Olidebron + Järnvägsbron)
// alltså 10× högre frekvens när andrakällan förtätar kadensen — precis det
// "latenta kodhål som blev aktivt för att datan blev tätare" som A/B-verdiktet
// beskriver. Dimensionerna är i övrigt OSKILJBARA (korsande segment 85-165 m,
// inträdesfixens projektion +12…+32 m, fart 3,3-5,7 kn, dt 29-330 s): ingen
// geometrisk eller temporal tröskel kan skilja nattens fall från korpusarnas.
//
// BREDDAT 2026-08-03 (användarbeslut, samma dag som etapp 5): beviset gäller
// i ALLA lägen (null). De fem enkelkällefallen är äkta, tidigare tappade
// passager (rådataverifierade: rak COG, monoton genomgång, ingen U-sväng) och
// deras återvinning ändrade ENBART golden-text i fyra låsta korpusar —
// omlåsta med REGEN_DISTRIBUTIONS=1 samma dag; notis-, fördelnings- och
// riktningsfacit var byte-identiska före och efter. Källnärvaromaskineriet
// (_secondSourceFixAt + TTL nedan) står kvar som ÅTERSTÄLLNINGSSPAK:
// sätt 'aishub' för att återgå till dubbelkälle-gatad utrullning.
const UNDER_BRIDGE_CROSS_PROOF_REQUIRED_FEED = null;

// Grinden frågar om KÄLLNÄRVARO, inte om vilken källa som råkade leverera just
// segmentets två fix (granskningsrunda 2, 2026-08-03). Den ursprungliga
// segmentformuleringen gjorde fixen LATENSBEROENDE: med källans egen p90-latens
// (62 s) sväljer fusionens F6-grind just de släpande hub-fixar som annars stod
// i segmentet, och mätningen visade att TIM@Järnvägsbron tappades igen vid
// +30 s och både TIM och TIDAN vid +60 s — trots att geometrin var oförändrat
// giltig och att rotorsaken är källneutral. 15 min = 13 pollcykler: en
// konfigurerad och levererande andrakälla är närvarande hela zonbesöket, medan
// en källa som faktiskt tystnat (auth-paus, nätfel) faller ur inom ett kvart
// och beteendet återgår till enkelkälleläget.
const UNDER_BRIDGE_CROSS_PROOF_FEED_TTL_MS = 15 * 60 * 1000;

// CG2-1-SPEGELN för segmentbeviset: bevisat stillaliggande i BÅDA ändarna och
// jitter-liten rörelse ⇒ inget bevis. Samma trösklar som geometry CG2-1
// (sog < 0,3 kn finit i båda samplen, rörelse < 60 m) därför att det är samma
// fysik: en båt som ligger still intill brolinjen får Class B-multipath på
// 20–80 m, ibland på MOTSATT sida. sog = null lämnar vakten inaktiv —
// fartgivarlösa båtar får aldrig gate:as på okänd fart (S-F7-semantiken).
const UNDER_BRIDGE_CROSS_PROOF_MIN_SOG_KN = 0.3;
const UNDER_BRIDGE_CROSS_PROOF_JITTER_M = 60;

// PROTECTION ZONE (300m): Båtar inom detta avstånd får längre timeout
// Detta förhindrar att båtar tas bort för tidigt när de väntar vid bro
const PROTECTION_ZONE_RADIUS = 300; // meter

// WAITING SPEED: Under denna hastighet anses båt "vänta"
const WAITING_SPEED_THRESHOLD = 0.20; // knop

// WAITING TIME: Hur länge båt måste ha låg hastighet för att räknas som waiting
const WAITING_TIME_THRESHOLD = 120000; // 2 minuter

// WAITING ETA LIMIT: Max ETA to display while vessel is in waiting zone
const WAITING_STATUS_MAX_ETA_MINUTES = 12; // minuter

// MINIMUM SPEED FLOOR used for ETA immediately after a passage (prevents 30-50min spikes)
const MIN_PASSAGE_ROUTE_SPEED_KNOTS = 2.5;

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
  kanalinfarten: 'Kanalinfarten',
  olidebron: 'Olidebron',
  klaffbron: 'Klaffbron',
  jarnvagsbron: 'Järnvägsbron',
  stridsbergsbron: 'Stridsbergsbron',
  stallbackabron: 'Stallbackabron',
};

const BRIDGE_NAME_TO_ID = {
  Kanalinfarten: 'kanalinfarten',
  Olidebron: 'olidebron',
  Klaffbron: 'klaffbron',
  Järnvägsbron: 'jarnvagsbron',
  Stridsbergsbron: 'stridsbergsbron',
  Stallbackabron: 'stallbackabron',
};

// TRIGGER POINTS: Geografiska triggerpunkter för Flow-kort (ingår INTE i brotext-systemet)
// Dessa triggar boat_near Flow men påverkar inte brostatus eller brotext.
const TRIGGER_POINTS = {
  kanalinfarten: {
    name: 'Kanalinfarten',
    lat: 58.26800304269953,
    lon: 12.26936457556289,
    radius: 300, // Detektionsradie (meter)
  },
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
  // RC8-fix (2026-06-11): fartyg med aktiv resa (targetBridge) — observerade
  // leveransglapp 10-18 min får inte radera resan. Texten skyddas separat av
  // 10-min stale-exklusionen (RC7); detta är endast den INTERNA livslängden.
  ACTIVE_JOURNEY_MIN: 30 * 60 * 1000, // 30 minuter minimum vid aktiv resa
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
// FÖRTÖJNINGSDETEKTERING (2026-06-10)
// =============================================================================
// Prod-bugg dag 1: båt förtöjd vid kajen norr om Klaffbron (inom 280m-vänt-
// zonen) tolkades som "inväntar broöppning" på obestämd tid. Fem lager
// skiljer "förtöjd/ankrad" från "inväntar öppning" — INGET lager triggar på
// väntans LÄNGD under tid då bron varit stängd, så äkta väntare (även >1h
// vid rusningsspärr) påverkas inte:
//   1. Rörelsebevis: inget målbro förrän fartyget setts röra sig
//   2. Demotering i stället för borttagning (ingen re-entry-churn)
//   3. AIS NavigationalStatus: 1=at anchor, 5=moored (Class A; kräver även
//      stillaliggande så en avgående båt med glömd status inte missas)
//   4. Förtöjningszon: stationär inom känd kaj → förtöjd
//   5. Backstop: stationär > 2h (bortom alla rimliga öppningsfönster)

const MOORING_DETECTION = {
  STATIONARY_SOG_KN: 0.3, // under detta = stillaliggande (GPS-brusnivå)
  MOVEMENT_PROOF_SOG_KN: 0.5, // ≥ detta någon gång = bevisad rörelse
  MOVEMENT_PROOF_NET_M: 50, // nettoförflyttning från första position = bevis
  MOORED_NAV_STATUSES: [1, 5], // AIS navstatus: 1=at anchor, 5=moored
  MAX_STATIONARY_WAIT_MS: 2 * 60 * 60 * 1000, // lager 5-backstop
  // Helgranskning 2026-07-10 (V2-1): positionshärledd stillhet för
  // FARTGIVARLÖSA båtar (sog=null i alla prover) — inom denna radie från
  // stillhetsankaret räknas provet som stillaliggande (GPS-jitter hos en
  // förtöjd båt är ~5–30 m; en köare/driftare nettar snabbt förbi). Hålls
  // under MOVEMENT_PROOF_NET_M (50) så stillhet aldrig är tvetydig mot
  // rörelsebeviset.
  NULL_SOG_STILL_RADIUS_M: 40,
};

// Kända förtöjningsplatser: kapsel = centrumlinje (start→end) + halvbredd.
// En STATIONÄR båt inom kapseln klassas som förtöjd. Rörliga båtar påverkas
// aldrig (regeln kräver sog < STATIONARY_SOG_KN), så zonen kan ligga kant i
// kant med farleden utan att störa passerande/väntande trafik.
const MOORING_ZONES = [
  {
    // Kajen norr om Klaffbron, västra stranden (användarverifierad 2026-06-10):
    // två kajsegment längs ~100 m, 190–295 m från bron — mitt i väntzonen.
    // Centrumlinjen går mellan segmentens mittpunkter; 30 m halvbredd täcker
    // kajsegmenten + GPS-jitter men når inte farledens mitt (~50 m öster ut).
    name: 'Kajen norr om Klaffbron',
    start: { lat: 58.285685, lon: 12.285164 },
    end: { lat: 58.286434, lon: 12.286138 },
    radiusM: 30,
  },
];

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

// Helgranskning 2026-07-06: semantiken är RÄT fågelvägssträcka bro-till-bro
// (haversine mellan BRIDGES-koordinaterna) — två gap matchade redan haversine
// exakt (960≈963, 2310≈2309) men två var datafel: olide–klaff 950 låg UNDER
// den fysiskt minsta räta linjen (enbart latitudseparationen är ~1264 m) och
// järnväg–strids 420 var 63 % för högt. Felen matade _calculateCumulativeTime
// → fler-bro-ETA i bridge_text fel med ±1–3 min vid låga farter.
const BRIDGE_GAPS = {
  'olidebron-klaffbron': 1363, // meter (haversine; KORRIGERAT från 950 — fysiskt omöjligt)
  'klaffbron-jarnvagsbron': 960, // meter
  'jarnvagsbron-stridsbergsbron': 257, // KORTASTE gap - kritiskt för timing (KORRIGERAT från 420)
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
  //
  // P5-beslut (2026-06-09): två MEDVETET olika sydtolkningar finns:
  //  1. Riktningshärledning för målbro/route-lås (_safeDetermineDirection):
  //     strikt 135-225° = syd; 46-134° och 226-314° = tvetydigt → ingen
  //     låsning. Hög insats (fel målbro) ⇒ konservativt band.
  //  2. Notis-token-FALLBACK (_getDirectionString i app.js, endast för olåsta
  //     fartyg): breddat 135-314° = southbound. I den NE-SV-orienterade
  //     kanalen är SV-/V-kurser normal sydfärd — replay-bevis: JOSEPHINE,
  //     bevisligen sydgående med COG 226,7°, fick felaktigt 'unknown' med det
  //     strikta bandet. Test-låst i notification-tokens.test.js.
  // Detta är alltså INTE en inkonsekvens-bugg — banden har olika riskprofil.
};

// =============================================================================
// AIS STREAM CONFIGURATION - AISSTREAM.IO INSTÄLLNINGAR
// =============================================================================

const AIS_CONFIG = {
  API_KEY_FIELD: 'APIKey', // Fältnamn för API-nyckel i subscription message

  // BOUNDING BOX: Geografisk låda som filtrerar AIS-data.
  // SSOT (ChatGPT-granskningen 2026-07-10, F1): detta är boxen appen
  // PRENUMERERAR på hos AISstream.io (AISStreamClient._subscribe) OCH
  // inmatningsfiltret i VesselDataService. SOUTH=58.26 ligger medvetet
  // söder om KANALINFARTEN_EXIT_LAT (58.2653) så sydgående journey-
  // completion kan bevisas med livedata (gamla hårdkodade sydgränsen
  // 58.2681 gjorde den grenen onåbar — sydresor avslutades via timeout).
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

  // ==========================================================================
  // AISHUB — pollande andrakälla (etapp 1, 2026-08-02)
  // ==========================================================================
  // AISHubs webservice har HÅRD gräns: max 1 request/minut per username —
  // oftare ⇒ tomt svar (och risk för indragen access). Varje konstant här
  // är vald för att göra ett kadensbrott OMÖJLIGT snarare än osannolikt:
  // spärren persisteras över omstarter, backoff går bara UPPÅT, och
  // schemaläggningen sker i finally (en missad ombokning = död kedja).
  AISHUB: {
    BASE_URL: 'https://data.aishub.net/ws.php',
    // 65 s bas + 0-5 s jitter ⇒ aldrig under 60 s ens vid klockdrift.
    POLL_INTERVAL_MS: 65000,
    POLL_JITTER_MS: 5000,
    // Absolut minsta avstånd mellan två poll-STARTER (kontraktet är 60 s;
    // 61 s ger marginal för Homeys klockgranularitet).
    MIN_POLL_SPACING_MS: 61000,
    // Startjitter 0-15 s: undviker att appomstart + persisterad spärr ger
    // synkroniserade pollar exakt på minutgränsen.
    START_JITTER_MAX_MS: 15000,
    // interval-parametern (max positionsålder i minuter) — MEDVETET generös:
    // Class A förtöjd/ankrad sänder var 180:e s och AISHub-nätet får
    // downsampla till 60 s + 10 s fördröjning; ett snävt filter skär bort
    // exakt den snapshot-data som är hela värdet. Kalibrering sker NEDÅT
    // i etapp 4, från skuggmätningens p90(fixålder).
    INTERVAL_MINUTES: 10,
    HTTP_TIMEOUT_MS: 20000,
    MAX_BODY_BYTES: 2 * 1024 * 1024,
    // Backoff vid tomt svar/nätfel: 65 → 130 → 260 → tak 300 s. Aldrig
    // snabbare retry — ett fel får ALDRIG korta kadensen.
    BACKOFF_MAX_MS: 300000,
    // Anslutningssemantik för en pollkälla: 'connected' på FÖRSTA välformade
    // svaret (även tom kanal räknas som kontakt med servern), 'disconnected'
    // när senaste lyckade svar är äldre än detta ELLER efter 3 raka fel.
    SILENT_FEED_MS: 200000,
    ERROR_STREAK_DISCONNECT: 3,
    // Auth-fel (HTTP 401/403): efter 5 pausas pollandet + EN användarnotis.
    AUTH_FAIL_STOP: 5,
    // V6 (A/B-natten 2026-08-03): tidigare satte det femte auth-felet
    // _stopped = true PERMANENT — ingen kodväg återupplivade klienten utan
    // appomstart eller username-byte (forceReschedule returnerar direkt på
    // _stopped, och muxens _reconcile skapar bara nya barn vid cred-/lägesbyte).
    // Ett ÖVERGÅENDE 403 (AISHubs stationskrav mäts löpande: ≥10 fartyg/7 dygn,
    // ≥90 % upptid — en station som ligger nere ett dygn kan tappa access och
    // få tillbaka den) slog alltså ut andrakällan för processens livstid i ett
    // läge som ska gå månader utan omstart. Permanent stopp ersatt av en LÅNG
    // cooldown: pollandet återupptas automatiskt efter denna, och en poll som
    // lyckas nollställer allt.
    // 6 h är valt som "fyra försök per dygn": tillräckligt glest för att aldrig
    // kunna läsas som spam mot ws.php (kadensspärren 61 s gäller ändå
    // OVILLKORLIGT ovanpå), tillräckligt tätt för att en access som kommer
    // tillbaka över natten ska plockas upp samma dygn. Cooldownen är MEDVETET
    // in-memory: en appomstart följer nästan alltid på att användaren rättat
    // inställningen, och 61s-spärren (som ÄR persisterad) skyddar kadensen.
    AUTH_COOLDOWN_MS: 6 * 3600 * 1000,
    // Hård åldersgrind för fix, härledd ur serverkontraktet:
    // INTERVAL_MINUTES * 60000 + 120000 klockskevsmarginal (10 min ⇒ 12 min).
    MAX_FIX_AGE_MS: 10 * 60000 + 120000,
    // Dedup-kartan (mmsi → senaste fixTs): TTL = MAX_FIX_AGE_MS + 60 s,
    // hårt tak med LRU-prune på senast kända fix (fynd 15 — se _pruneDedup).
    DEDUP_MAX_ENTRIES: 2000,
    // Batchspridning: poll-batchens poster emitteras i*150 ms isär så
    // nedströms hinner processa utan att SystemCoordinators globala
    // jump-tally ser en syntetisk storm.
    EMIT_SPREAD_MS: 150,
    LAST_POLL_SETTINGS_KEY: 'aishub_last_poll_at',
  },

  // ==========================================================================
  // SKUGGMÄTNINGEN — SHADOW_COMPARE (kalibrerad efter fältprov 2, 2026-08-02)
  // ==========================================================================
  // Skuggläget är HELA beslutsunderlaget för att aktivera dubbelkälla, så
  // mätinstrumentet måste vara minst lika tillförlitligt som beslutet.
  // Fältprov 2 avslöjade att positionsindexet saknade åldersgräns: en
  // förtöjd båt återvänder till samma avrundade koordinat var 3:e minut
  // (AIS rapportslot 180 s), så färska AISHub-fixar parades mot timmegamla
  // aisstream-mottagningar. 32 % av samplen var sådana artefakter och tre
  // av tretton rapporterade medianer var rena skräpvärden.
  SHADOW: {
    POS_INDEX_TTL_MS: 5 * 60 * 1000, // indexpost äldre än så är värdelös
    // Ett par godtas ENDAST när aisstream-mottagningen och AISHub-fixen
    // ligger inom detta av varandra. Bortom det är det med överväldigande
    // sannolikhet två OLIKA fysiska rapporter från samma stillaliggande båt.
    PAIR_MAX_SKEW_MS: 90 * 1000,
    POS_INDEX_MAX_ENTRIES: 500,
    MAX_SAMPLES_PER_WINDOW: 2000,
    // Parningens positionslikhet i METER (fynd 16, A/B-natten 2026-08-03) —
    // samma härledning som FUSION.CONTENT_MATCH_DIST_M: den avrundade
    // rutnyckeln tappade 15,1 % av de äkta paren på rutgränser, så
    // uppslaget svepar grannrutorna och avgör på avstånd.
    PAIR_MATCH_DIST_M: 1.5,
    // SAMMA-RAPPORT-BEVIS för RACE-metriken (granskningsrunda 2, 2026-08-03).
    // Parningen matchar på POSITION, och en stillaliggande båt återvänder till
    // samma koordinat rapport efter rapport — så ett par kan mycket väl vara
    // två OLIKA fysiska rapporter. För fixLag spelar det mindre roll, men för
    // RACE ("vem levererade först") blir det ett falskt övertag åt den källa
    // vars post råkade vara äldst. Mätt på nattkorpusen: efter att mätningen
    // gjorts tvåsidig (fynd 12) var 9 av 13 positiva race artefakter med
    // fixLag 21-62 s, medan de FYRA äkta låg på 1,8-2,5 s — aisstreams
    // pushlatens. 10 s är ~4× den latensen och en tredjedel av avståndet upp
    // till närmaste artefakt: separationen i data är mycket större än
    // osäkerheten i gränsen.
    PAIR_SAME_REPORT_MS: 10 * 1000,
    // Percentiler över för få sampel bär ingen information — p90 skrivs som
    // '-' under denna gräns i stället för att spegla maxvärdet.
    MIN_SAMPLES_FOR_P90: 10,
    // Kontinuitetsmätningen (fältprov 2: det är HÄR AISHub faktiskt vinner —
    // aisstreams tystnadsglapp nådde 1800 s mot AISHubs 1082 s): per-MMSI
    // senast-sedd per källa, överlever fönsterbyten.
    //
    // FYND 13 (A/B-natten 2026-08-03): TTL:n var 60 min och CENSURERADE
    // mätningen — nattens två 120-minutersglapp (KNIGHT OWL, S/Y NANNA)
    // rapporterades aldrig, eftersom posten hann prunas innan fartyget kom
    // tillbaka. Censuren slog ENSIDIGT mot aisstream (sant 120,0 min mot
    // AISHubs 41,9; loggat 54,0 mot 41,9) och instrumentet UNDERSKATTADE
    // alltså AISHubs enda tydliga övertag — precis fel håll för ett GO-beslut.
    // 4 h = 2× nattens värsta observerade glapp; minnet hålls i schack av det
    // hårda entry-taket (500 poster × ~40 B ≈ 20 kB per källa), och varje
    // post som ändå prunas bort räknas som censurerad i SHADOW_COMPARE så
    // maxSilence aldrig kan läsas som ett tak utan att det syns.
    LAST_SEEN_TTL_MS: 4 * 60 * 60 * 1000,
    LAST_SEEN_MAX_ENTRIES: 500,
  },

  // ==========================================================================
  // FUSION — F1-F5-regler för dubbelkälla (FixFusionPolicy, etapp 1)
  // ==========================================================================
  FUSION: {
    // F4a: fix mer än så här i FRAMTIDEN klampas till now + flaggas clockSkew.
    FUTURE_CLAMP_MS: 120000,
    // F4b: enda hårda åldersgrinden (samma härledning som AISHUB.MAX_FIX_AGE_MS).
    MAX_FIX_AGE_MS: 10 * 60000 + 120000,
    // F2: korsfeed-suppression på INNEHÅLL (samma mmsi+position+sog+cog från
    // ANDRA källan inom fönstret ⇒ dubblett). Samma källa berörs ALDRIG av
    // F2 — aisstreams legitima 3-minutersupprepningar från kaj måste flöda.
    CROSS_FEED_DEDUP_MS: 90000,
    // F2b (etapp 3): eko-tolerans — ett korskälle-meddelande med IDENTISKT
    // innehåll vars fixTs ligger inom toleransen från senast accepterade
    // innehålls-fix är en RE-LEVERANS av samma fysiska rapport (AISHub ekar
    // aisstreams fix, eller omvänt) oavsett hur länge sedan accepten var —
    // ett eko tillför noll ny information och får ALDRIG refresha
    // vessel.timestamp (grupp C: "bara äkta nya fixar förnyar"). En äkta NY
    // rapport med samma position (kajliggare via andra källan) har nytt
    // fixTs långt utanför toleransen och accepteras.
    FIX_ECHO_TOLERANCE_MS: 60000,
    // F2 (fynd 16, A/B-natten 2026-08-03): positionslikheten mäts i METER,
    // inte som en avrundad strängnyckel. Den gamla toFixed(5)-rutan är
    // 1,11 m (lat) × 0,59 m (lon vid 58,3°N) ⇒ diagonal ~1,26 m, och två
    // avkodningar av samma fysiska rapport som råkade hamna på var sin sida
    // om en rutgräns sågs som olika innehåll — 15,1 % av alla bevisade
    // samma-rapport-par missades så. 1,5 m täcker hela den gamla diagonalen
    // (⇒ strikt utvidgning, inget som fångades förr slipper igenom) plus
    // parsrarnas avrundning; AIS-fältets egen upplösning är ~0,19 m, så
    // marginalen kan aldrig svälja en ÄKTA förflyttning.
    CONTENT_MATCH_DIST_M: 1.5,
    // F5: källbyte med positionshopp > 150 m inom fönstret efter senast
    // accepterade fix ⇒ feedSwitch-flagga (undantar den globala jump-tallyn).
    // Fältprov 3 (2026-08-02): fönstret var 30 s — KORTARE än AISHubs
    // pollkadens (65-70 s), så ett källbyte hann i praktiken aldrig ske
    // inom fönstret. Samtliga 9 observerade källbyten över 150 m låg
    // utanför det, och F5 kunde alltså aldrig fyra på riktig trafik.
    // 90 s spänner en hel pollcykel med marginal.
    FEED_SWITCH_DIST_M: 150,
    FEED_SWITCH_WINDOW_MS: 90000,
    // Per-MMSI-fusionsstate: TTL + hårt tak (LRU på senast accepterade fix,
    // fynd 15) — prunas i monitoring-takt.
    STATE_TTL_MS: 10 * 60000 + 120000 + 60000,
    STATE_MAX_ENTRIES: 500,
    // F6b KLOCKOFFSETFÖNSTER (granskningsrunda 2, 2026-08-03). Offseten
    // skattas ur två bevis — min(now − fixTs) och medianen av korskällepar;
    // se FixFusionPolicy.observeClock för hela härledningen.
    // 30 min ≈ 28 pollcykler (65 s kadens): långt nog att fånga en fix med
    // liten latens (nattens minsta var 414 ms och p10 3,9 s, så ett fönster
    // på tiotals pollar innehåller nästan säkert ett lågt värde ⇒ skattningen
    // biasas bara med den latensen), kort nog att en klocka som RÄTTAS
    // (NTP-sync) släpper kompensationen inom en halvtimme i stället för att
    // svälta hubben resten av dygnet. Taket 500 sampel är rent minnesskydd
    // (≈ 12 kB) och binder först vid ~17 fartyg per poll — långt över
    // nattens 7.
    CLOCK_OFFSET_WINDOW_MS: 30 * 60000,
    CLOCK_OFFSET_MAX_SAMPLES: 500,
    // Korskällebeviset kräver ett minimiantal par innan medianen används.
    // Nattens takt var ~28 par/h ⇒ 10 par ≈ 20 min, alltså inom det första
    // 30-minutersfönstret. Under den tiden bär leveransbeviset ensamt (det
    // fungerar från första meddelandet men bara när skeven överstiger
    // leveranslatensen) — en NY skev är alltså delvis oskyddad i högst en
    // fönsterlängd, vilket är priset för att aldrig kompensera på gissningar.
    CLOCK_PAIR_MIN_SAMPLES: 10,
    // V8 (A/B-nattkörningen 2026-08-03): minsta KORSKÄLLE-fixseparation som
    // bär fysikinformation. Nedströms (GPSJumpAnalyzer.fixDtMs) räknas dt
    // numera på fixtid även när de två samplen kommer från OLIKA källor —
    // båda källornas fixTs approximerar emissionstid, medan mottagningstiden
    // bär hubbens pollfördröjning. Men separationen får inte fabriceras:
    // AISHubs TIME-fält har SEKUNDupplösning, så allt under en sekund ligger
    // inuti hubbens egen kvantisering och kan inte skilja "0,1 s isär" från
    // "samma sekund". Under gränsen (och vid icke-framåt separation, som
    // uppstår när en släpande hub-fix landar efter en färsk aisstream-fix)
    // saknas användbar fixseparation → anroparen behåller dagens
    // mottagningstidsuttryck i stället för att öppna ett mikroskopiskt
    // fysikfönster som dömer legitim rörelse som osäker.
    //
    // RÄTTAD HÄRLEDNING (granskningsrunda 2, 2026-08-03): den tidigare
    // kommentaren påstod att "samtliga par under 5 s låg under 6 m
    // förflyttning" och att gränsen därför var inert. Det är FALSKT och
    // motbevisas av samma natts data — TIDAN 231907000 23:56:56→23:57:05 har
    // korskälleseparation 2491 ms och 14,7 m förflyttning, dvs. 9,7–11,5 kn
    // implicerat mot rapporterade 5,1. Golvet är alltså INTE ensamt
    // tillräckligt; det som stänger den klassen är vidgningskravet nedan
    // (paret krymper fönstret 2491 ms mot 9000 ms mottagning ⇒ förkastas).
    // Golvet står kvar för det det faktiskt gör: skydda mot AISHubs
    // SEKUNDupplösta TIME-fält, där allt under en sekund ligger inuti
    // kvantiseringen.
    CROSS_FEED_MIN_FIX_DT_MS: 1000,
    // Största tillåtna VIDGNING av mottagningsseparationen för ett
    // korskällepar (se GPSJumpAnalyzer.fixDtMs). Vidgningen ÄR hubbens egen
    // leveranslagg: nattens 1014 fixar hade median 27,5 s, p90 62,3 s och max
    // 220,9 s. 300 s ≈ 1,4× det observerade maxvärdet och en fjärdedel av
    // åldersgrinden AISHUB.MAX_FIX_AGE_MS (12 min) — bortom det är
    // separationen inte en pollfördröjning utan en klock-/dataanomali, och
    // ett uppblåst fysikfönster gör grindarna godtyckligt tillåtande
    // (allowedPositionChangeM växer linjärt med dt).
    CROSS_FEED_MAX_FIX_DT_EXCESS_MS: 300000,
  },
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
  JUST_PASSED_WINDOW: 30000, // 30 sek - "precis passerat" fas (Phase 4)
  PASSED_HOLD_MS: 150000, // 2.5 min — total visningsfönster (30s opening + 120s passed)
  BRIDGE_OPENING_DURATION: 30000, // 30 sek - "broöppning pågår" fas (Phase 3)
  FAST_VESSEL_PASSED_WINDOW: 180000, // 3 minuter för snabba båtar (>5 knop)
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
// Fable-granskningen 2026-07-10b (GEO-4): LINE_CROSSING_MIN_PROXIMITY_M
// (150) raderad — konstanten användes ingenstans och dess dokumenterade
// regel motsade de verkliga trösklarna (120/250/300 m, hårdkodade i
// geometry.js) — en ren underhållsfälla för den som "justerade" den.

// =============================================================================
// UI AND TIMING CONSTANTS - UI-UPPDATERING OCH TIMING
// =============================================================================

const UI_CONSTANTS = {
  UI_UPDATE_DEBOUNCE_MS: 100, // Debounce för UI-uppdateringar
  BRIDGE_TEXT_CACHE_MS: 1000, // Cache-tid för bridge text
  MONITORING_INTERVAL_MS: 60000, // Monitoring loop (1 minut)
  STALE_DATA_TIMEOUT_STATIONARY_MS: 15 * 60 * 1000, // 15 min för stillastående
  STALE_DATA_TIMEOUT_MOVING_MS: 5 * 60 * 1000, // 5 min för rörliga båtar
  // B2-fix (2026-06-09): stale-FEED-watchdog. Om anslutningen är uppe men inga
  // AIS-meddelanden alls kommit på denna tid → tvinga omanslutning + ompren-
  // umeration. Fångar "ansluten men döv" (tappad subscription, serverfel) som
  // ping/pong-watchdogen inte ser. OBS: kanalen kan vara legitimt tom nattetid
  // — tröskeln är därför hög och en onödig omanslutning är billig.
  STALE_FEED_RECONNECT_MS: 20 * 60 * 1000, // 20 min utan meddelanden
  CLEANUP_EXTENSION_MS: 600000, // 10 min extension i protection zone
  // ETA staleness-trösklar (uppdaterade 2026-04-28 efter användarfeedback):
  //   0–SOFT  : visa beräknad ETA som vanligt
  //   SOFT–HARD: extrapolera ned senaste ETA med tiden som gått, visa
  //              "om cirka N minuter" (BridgeTextService prefixar "cirka")
  //   >HARD   : nullify ETA → "ETA okänd" (data för gammal att lita på)
  // Klass B AIS-glapp 5–8 min är vanligt → extrapolation gör att bilförare
  // får användbar info istället för "okänd" under den vanliga tystnaden.
  // Risk: om båt vänt under glappet är extrapolationen fel — men nästa AIS
  // (max ~10 min) rättar det automatiskt.
  STALE_ETA_SOFT_THRESHOLD_MS: 5 * 60 * 1000, // 5 min: börja extrapolera
  STALE_ETA_HARD_THRESHOLD_MS: 10 * 60 * 1000, // 10 min: ge upp helt → "okänd"
  // Bakåtkompatibel alias (fas ut när alla refs uppdaterats — används av
  // legacy-tester som validerar exakta tröskelvärdet).
  STALE_ETA_THRESHOLD_MS: 5 * 60 * 1000,
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
// KAJAVGÅNGSKORROBORERING (V1, A/B-nattkörningen 2026-08-03)
// =============================================================================
// FP9-grenen (trigger-punkt, riktning nord/okänd) släppte notisen på ETT
// momentant sog ≥ 1,0 kn. Kring Kanalinfarten ligger fem kajliggare PERMANENT
// inne i 300 m-zonen (119/132/148/211/242 m) — för dem är den tröskeln inget
// transitbevis utan ett brusprov. Nattens fantom: PRICKBJORN 07:19:11, sog
// EXAKT 1,0, cog 128,7° (östbandet ⇒ 'unknown'), 3 m förflyttning; båten gick
// sedan BORT (119→143→179→297→387→401 m). Appen skrev själv "quay wobble,
// blocking target assignment" sex rader tidigare, och de tre NÄSTA fixarna
// blockerades korrekt av FP8 (då hade cog hunnit in i sydbandet). Fönstret där
// BÅDA villkoren höll var ≤ 66 s brett — glesa aisstream missade det, tät
// dubbelkälla träffar det.
//
// Kravet gäller ENDAST fartyg med FÄRSK kajstabil historik (bokförd i app.js)
// och ENDAST sog-benet; targetBridge-benet är orört (målbrotilldelningen har
// egna förtöjnings-/rörelsebevis-/kajvobbelvakter). Fartyg i transit utan
// kajhistorik (TIM/TIDAN/JUNO-klassen) berörs inte alls.
const QUAY_DEPARTURE_GATE = {
  // FP9:s befintliga tröskel, nu namngiven (oförändrat värde).
  TRANSIT_SOG_KN: 1.0,
  // Hur länge "nyss kajstabil" gäller efter senaste stillasample.
  // GRANSKNINGSRUNDA 2 (2026-08-03): 15 min var KORTARE än rapportintervallet
  // för exakt den fartygsklass grinden skyddar mot. Mätt på nattens rådata i
  // rent aisstream-läge (appens LEVERERADE standardläge): PRICKBJORN hade 11
  // glapp > 15 min (max 30,0), VIRGO 12, S/Y ENYA 14 (max 72 min), KNIGHT OWL
  // 15 (max 120 min), NANNA 7 (max 120 min). Bokföringen hann alltså rutin-
  // mässigt löpa ut mellan två fixar från samma kajliggare och grinden slutade
  // skydda. (I 'both'-läget var samma kajliggares värsta glapp 3,5 min.)
  // 2 h = nattens värsta observerade glapp. Kostnaden för en FÖR lång minnes-
  // tid är låg: grinden avvisar aldrig en notis, den FÖRDRÖJER den till nästa
  // fix (dedup-nyckeln sätts inte vid skip), och en äkta insegling uppfyller
  // båda korroboreringsbenen direkt.
  MEMORY_MS: 120 * 60 * 1000,
  // Bokföringen sker bara i trigger-punkternas närområde: riskytan är kajerna
  // runt punkten (nattens kajliggare 119–242 m). 500 m täcker gästhamn +
  // lotskaj + GPS-drift utan att bokföra genomgående kanaltrafik.
  LEDGER_RADIUS_M: 500,
  // Korroborering (a): två PÅ VARANDRA FÖLJANDE rörelsefixar. Ett enstaka
  // brusprov räcker aldrig; ett stillasample nollställer räknaren.
  MIN_MOVING_FIXES: 2,
  // Skrivtakt för den persisterade bokföringen (settings-blob). 15 min ⇒ 96
  // skrivningar/dygn TOTALT oavsett antal fartyg — samma flash-slitagehänsyn
  // som F4-L:s dygnsgranulära TTL-förnyelse. Inaktualiteten är ofarlig mot ett
  // minnesfönster på två timmar, och onUninit skriver alltid direkt.
  PERSIST_INTERVAL_MS: 15 * 60 * 1000,
  // Korroborering (b): netto-närmande mot punkten sedan kajläget. 40 m är
  // samma jitterskala som MOORING_DETECTION.NULL_SOG_STILL_RADIUS_M (en
  // förtöjd båts GPS-jitter är ~5–30 m) — PRICKBJORN nettade 3 m, en äkta
  // insegling i 4 knop nettar ~130 m per pollcykel.
  NET_APPROACH_M: 40,
};

// =============================================================================
// BRIDGE TEXT CONSTANTS - BRIDGE TEXT MEDDELANDE-REGLER
// =============================================================================

const BRIDGE_TEXT_CONSTANTS = {
  DEFAULT_MESSAGE: 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron',
  PASSAGE_CLEAR_WINDOW_MS: 60 * 1000, // 60 sek - "precis passerat" fönster
  VESSEL_DISTANCE_THRESHOLD: 400, // meter - max avstånd för currentBridge
  PASSED_HYSTERESIS_MS: 35000, // 35 sek - stabilisering vid GPS-instabilitet
  PASSED_WINDOW_MS: 180000, // 180 sek - "precis passerat" prioritet (långa AIS-intervall)
  UNDER_BRIDGE_SEQUENCE_TTL_MS: 240 * 1000, // 240 sek - sekvensminne för "broöppning pågår"
  IMMINENT_ETA_THRESHOLD_MINUTES: 3, // ETA ≤ 3 min → Phase 2 (imminent)
};

// =============================================================================
// STATUS HYSTERESIS - FÖRHINDRA UI-PENDLING
// =============================================================================
// Olika trösklar för att SÄTTA och RENSA status förhindrar fladder

const STATUS_HYSTERESIS = {
  // FIX F: Bredare hysteresis-trösklar för att förhindra oscillation
  // APPROACHING ZONE (500m nominal)
  APPROACHING_SET_DISTANCE: 480, // meter - aktiverar "närmar sig" (var 450)
  APPROACHING_CLEAR_DISTANCE: 580, // meter - avaktiverar "närmar sig" (var 550)

  // WAITING ZONE (300m nominal)
  WAITING_SET_DISTANCE: 270, // meter - aktiverar "inväntar broöppning" (var 280)
  WAITING_CLEAR_DISTANCE: 350, // meter - avaktiverar "inväntar broöppning" (var 320)

  // UNDER-BRIDGE ZONE
  // UNDER_BRIDGE_SET_DISTANCE: 50m, UNDER_BRIDGE_CLEAR_DISTANCE: 70m (definierat ovan)

  // ZONE TRANSITION TIMINGS
  CRITICAL_TRANSITION_HOLD_MS: 3000, // 3 sek - håll kritiska övergångar
  ZONE_TRANSITION_GRACE_MS: 1500, // 1.5 sek - grace vid zongränser
};

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
  UNDER_BRIDGE_CROSS_SEGMENT_MAX_M,
  UNDER_BRIDGE_CROSS_PROOF_REQUIRED_FEED,
  UNDER_BRIDGE_CROSS_PROOF_FEED_TTL_MS,
  UNDER_BRIDGE_CROSS_PROOF_MIN_SOG_KN,
  UNDER_BRIDGE_CROSS_PROOF_JITTER_M,
  PROTECTION_ZONE_RADIUS,
  INTERMEDIATE_PASSAGE_COOLDOWN_MS,
  WAITING_SPEED_THRESHOLD,
  WAITING_TIME_THRESHOLD,
  WAITING_STATUS_MAX_ETA_MINUTES,
  MIN_PASSAGE_ROUTE_SPEED_KNOTS,
  STATIONARY_FILTER_DISTANCE,
  MIN_APPROACH_DISTANCE,
  MINIMUM_MOVEMENT,
  MAX_RECONNECT_ATTEMPTS,
  MAX_RECONNECT_DELAY,
  TIMEOUT_SETTINGS,
  BRIDGES,
  TARGET_BRIDGES,
  INTERMEDIATE_BRIDGES,
  MOORING_DETECTION,
  MOORING_ZONES,
  TRIGGER_POINTS,
  BRIDGE_GAPS,
  BRIDGE_SEQUENCE,
  COG_DIRECTIONS,
  AIS_CONFIG,
  MOVEMENT_DETECTION,
  PASSAGE_TIMING,
  STALLBACKABRON_SPECIAL,
  UI_CONSTANTS,
  VALIDATION_CONSTANTS,
  FLOW_CONSTANTS,
  QUAY_DEPARTURE_GATE,
  BRIDGE_TEXT_CONSTANTS,
  STATUS_HYSTERESIS,
};
