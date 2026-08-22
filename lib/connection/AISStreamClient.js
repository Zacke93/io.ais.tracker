'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');
const { AIS_CONFIG, MAX_RECONNECT_ATTEMPTS, MAX_RECONNECT_DELAY } = require('../constants');
const {
  normalizeSog, normalizeCog, normalizeNavStatus,
} = require('../utils/aisFieldNormalization');

// ---------------------------------------------------------------------------
// Återanslutningsfasernas grundfördröjningar. Låg tidigare som lokala const i
// _scheduleReconnect; hoistade (F2-2, 2026-08-10) därför att rate-limit-grenen
// numera måste kunna LÄSA dem — en cooldown ska vara ett GOLV, aldrig ett TAK
// (se _phaseBaseDelay). Talen är oförändrade, bara flyttade.
// ---------------------------------------------------------------------------
const MEDIUM_RECONNECT_INTERVAL = 5 * 60 * 1000; // 5 min (försök 11-22)
const MEDIUM_RECONNECT_MAX = 22; // försök 11-22 = 12 × 5 min ≈ 1 h
const SLOW_RECONNECT_INTERVAL = 60 * 60 * 1000; // 60 min, i evighet

/**
 * AISStreamClient - Handles WebSocket connection to AISstream.io
 * Manages connection lifecycle, reconnection, and message filtering
 */
class AISStreamClient extends EventEmitter {
  /**
   * Connection must survive this long before reconnect counter resets.
   * RC-S1 (2026-06-12): höjd 30s→120s. Under 503-stormen 2026-06-11 levde
   * anslutningarna 30-50 s mellan dropparna — 30s-tröskeln nollställde
   * backoff-räknaren varje gång och gav två extra snabb-rundor (22 försök
   * på 22 min mot en överbelastad server). Med 120 s eskalerar en flappande
   * server till 5-minutersfasen efter ~10 försök; korta enstaka blippar
   * återhämtar sig fortfarande inom 2 min stabil drift.
   */
  static STABLE_CONNECTION_MS = 120_000;

  /**
   * En anslutning som LEVERERAR data räknas som stabil redan här — utan att
   * behöva överleva STABLE_CONNECTION_MS (KX-4, fältprovet 2026-08-09).
   *
   * Bakgrund: ping-vakten (_startPing) dödar en socket som inte pongar efter
   * exakt två tick = 60 s, medan stabilitetströskeln ligger på 120 s. De två
   * talen kan per konstruktion ALDRIG mötas: en källa bakom en proxy/LB som
   * sväljer ping-frames men vidarebefordrar AIS-meddelanden eskaleras
   * obönhörligt 1→10 (snabbfas) →22 (5 min) → en gång i timmen, trots att
   * den levererar. Fältet 2026-08-09 bekräftade mekanismen: fyra av fyra
   * pingade sockets dog på 60,0 s och räknaren gick 1→15 utan en enda
   * nollställning ("Connection stable" saknas helt i loggen).
   *
   * 55 s är valt i det ENDA fönster som finns:
   *  - strikt ÖVER RC-S1:s dokumenterade flappband (503-stormen 2026-06-11:
   *    anslutningarna levde 30-50 s — de får ALDRIG nollställa räknaren, det
   *    var hela motivet till att tröskeln höjdes 30→120 s), och
   *  - strikt UNDER ping-vaktens dödsgräns 60 s (2 × 30 s-tick), annars
   *    hinner vägen aldrig köra för just det fall den finns till för.
   * Vägen kräver DESSUTOM att socketen levererat minst en accepterad
   * position — uptid ensam räcker inte, det är data som är beviset.
   */
  static STABLE_DELIVERING_MS = 55_000;

  /**
   * IMF-fixdate, den enda datumform Retry-After får bära i praktiken
   * (RFC 9110 §5.6.7 / RFC 1123): "Sun, 06 Nov 1994 08:49:37 GMT".
   * Regexen körs FÖRE Date.parse — se _parseRetryAfter (F2-3). Whitespace
   * tillåts i pluralform mot slarviga proxyservrar; strukturen är ändå så
   * hård att inget av fältets skräpvärden ('-5', '120.5') kan passera.
   */
  static RETRY_AFTER_HTTP_DATE_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT$/;

  constructor(logger) {
    super();
    this.logger = logger;
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastMessageTime = null;
    this.apiKey = null; // Store API key for subscription
    this.openedAt = null; // Track connection open time for uptime
    this._intentionalClose = false; // F3: true while a deliberate disconnect is in flight
    this._awaitingPong = false; // F1: true after a ping until its pong arrives
    // F2-1: leveransräkning vid förra ping-ticket + engångsflagga för
    // diagnosraden. Se _startPing — ett leveransbevis avväpnar pong-vakten.
    this._pingTickMessages = 0;
    this._ponglessDeliveryLogged = false;
    // Observabilitet (2026-06-11, SABETH-utredningen): avvisade meddelanden
    // var tidigare osynliga på info-nivå → omöjligt att i efterhand skilja
    // "transpondern tyst" från "meddelanden kom men avvisades". Rate-limited
    // info-logg (1/fartyg/5 min) gör frågan avgörbar i prodloggar.
    this._rejectLogTimes = new Map(); // mmsi → senaste logg-ts
    // KX-2/KX-7/KX-8 (fältprovet 2026-08-09): handskakningens UTFALL måste
    // överleva fram till _scheduleReconnect. Utan det kan varken 429
    // särbehandlas eller loggtexten säga sanningen om vad som gick fel —
    // fältet skrev "Server unreachable" på anslutningar som bevisligen
    // öppnade och prenumererade.
    this._lastHandshakeStatus = null; // HTTP-status ur 'unexpected-response'
    this._lastRetryAfterMs = null; // Retry-After-headern (ms) om servern satt den
    this._socketOpened = false; // öppnade SENASTE försöket socketen?
    this._messagesThisSocket = 0; // accepterade positioner på nuvarande socket
    // V6-paritet (AISHubClient._authCooldownUntil): rate-limit-pausens slut
    // (0 = ingen paus). Egen orsak, egen text — men samma struktur: en PAUS,
    // aldrig ett stopp, och ett lyckat svar (här: 'open') upphäver den.
    this._rateLimitedUntil = 0;
    this._rateLimitCount = 0; // antal cooldowns i pågående episod (observabilitet)
  }

  /**
   * Rate-limited info-logg för avvisade meddelanden (1 per fartyg per 5 min).
   * @private
   */
  _logRejectedMessage(mmsi, reason) {
    const key = String(mmsi || 'unknown');
    const now = Date.now();
    const last = this._rejectLogTimes.get(key) || 0;
    if (now - last < 5 * 60 * 1000) return;
    this._rejectLogTimes.set(key, now);
    if (this._rejectLogTimes.size > 200) {
      for (const [k, ts] of this._rejectLogTimes) {
        if (now - ts > 30 * 60 * 1000) this._rejectLogTimes.delete(k);
      }
    }
    this.logger.log(`🚮 [AIS_REJECT] ${key}: message dropped (${reason})`);
  }

  /**
   * Connect to AIS stream
   * @param {string} apiKey - API key for AISstream.io
   * @returns {Promise<void>}
   */
  async connect(apiKey) {
    if (this.isConnected || this.ws) {
      this.logger.debug('🌐 [AIS_CLIENT] Already connected or connecting');
      return;
    }

    // KX-2: rate-limit-cooldownen kontrolleras HÄR, inte bara i
    // schemaläggningen — exakt samma motiv som V6 gav AISHubClient._poll:
    // annars kör app-lagrets egna omanslutningsvägar (reconnect-needed,
    // nyckelbyte, muxens _reconcile) rakt igenom en pågående paus och gör
    // cooldownen verkningslös. Kedjan får ALDRIG brytas här: timern bokas
    // ovillkorligt om på återstoden, så en missad ombokning är omöjlig.
    const cooldownLeft = this._rateLimitedUntil - Date.now();
    if (cooldownLeft > 0) {
      if (apiKey) this.apiKey = apiKey; // en ny nyckel får sparas ändå
      this.logger.log(
        `⏸️ [AIS_CLIENT] Rate-limit-cooldown aktiv — nästa handskakning om ${(cooldownLeft / 60000).toFixed(1)} min`,
      );
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.apiKey && !this.isConnected && !this.ws) {
          this.connect(this.apiKey).catch((err) => {
            this.logger.error('❌ [AIS_CLIENT] Reconnection after rate-limit cooldown failed:', err);
            this.emit('reconnect-needed');
          });
        } else {
          this.emit('reconnect-needed');
        }
      }, cooldownLeft);
      return;
    }

    // F2-8: cooldownen har löpt ut (cooldownLeft <= 0) — städa fältet HÄR.
    // Före fixen nollställdes _rateLimitedUntil bara av en lyckad handskakning
    // ('open'); misslyckades nästa försök i stället med ett rent nätfel
    // (ECONNREFUSED, ingen HTTP-status) låg ett passerat värde kvar resten av
    // processens liv, och getConnectionStats() rapporterade rateLimitedUntil
    // ≠ null för en källa som inte var spärrad — en fältanalytiker som
    // greppade fältet fick fel diagnos.
    if (this._rateLimitedUntil) {
      const sinceExpiry = Date.now() - this._rateLimitedUntil;
      this._rateLimitedUntil = 0;
      // Episodräknaren ("nr N i episoden") lever vidare så länge spärrarna
      // kommer tätt; en tyst period längre än RATE_LIMIT_EPISODE_RESET_MS
      // avslutar episoden så räknaren inte summerar orelaterade händelser.
      if (sinceExpiry > AIS_CONFIG.RATE_LIMIT_EPISODE_RESET_MS) this._rateLimitCount = 0;
    }

    // CRITICAL FIX: Clear any pending reconnect timer to prevent race condition
    // If we're connecting now, any scheduled reconnect is redundant
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.logger.debug('🔧 [AIS_CLIENT] Cleared pending reconnect timer');
    }

    try {
      this.logger.log('🌐 [AIS_CLIENT] Connecting to AISstream.io...');

      // Store API key for subscription
      this.apiKey = apiKey;

      // KX-7: nytt försök ⇒ nollställ utfallsspåret. Loggtexten "Server
      // unreachable" får bara skrivas när DET HÄR försöket aldrig öppnade
      // socketen, och 429-cooldownen får aldrig ärvas av nästa handskakning.
      this._lastHandshakeStatus = null;
      this._lastRetryAfterMs = null;
      this._socketOpened = false;
      this._messagesThisSocket = 0;

      // CRITICAL FIX: Connect to WebSocket endpoint without API key in URL
      // API key is sent via subscription message after connection opens
      // CONNECTING-deadlock-fix (2026-06-13, helkodsgranskningen): utan
      // handshakeTimeout kan en peer som fullbordar TCP/TLS men aldrig
      // svarar på HTTP-upgraden (blackholande LB, död backend) lämna
      // socketen i CONNECTING för alltid — inga open/error/close-event →
      // connect()-guarden (this.ws satt) vägrar nya försök och feed-
      // watchdogen är gated på isConnected → appen blir PERMANENT döv
      // tills omstart. handshakeTimeout → abortHandshake → 'error'+'close'
      // → ordinarie reconnect-väg.
      this.ws = new WebSocket('wss://stream.aisstream.io/v0/stream', { handshakeTimeout: 15000 });
      this._setupWebSocketHandlers();

      // Bälte+hängslen: absolut connect-deadline. Skyddar mot varje annan
      // väg där socketen fastnar före 'open' (60 s >> handshakeTimeout).
      if (this._connectDeadlineTimer) clearTimeout(this._connectDeadlineTimer);
      this._connectDeadlineTimer = setTimeout(() => {
        this._connectDeadlineTimer = null;
        if (!this.isConnected && this.ws) {
          this.logger.log('⏱️ [AIS_CLIENT] Connect deadline (60s) hit while still CONNECTING — terminating socket');
          try {
            this.ws.terminate();
          } catch (err) {
            this.logger.debug(`🔧 [AIS_CLIENT] deadline terminate failed: ${err.message}`);
          }
        }
      }, 60000);

    } catch (error) {
      this.logger.error('❌ [AIS_CLIENT] Connection failed:', error);
      this.emit('error', error);
      this._scheduleReconnect();
    }
  }

  /**
   * Disconnect from AIS stream
   */
  disconnect() {
    this.logger.log('🛑 [AIS_CLIENT] Disconnecting...');

    // F3: mark this as intentional so _onClose does NOT schedule a reconnect.
    // ws.close() yields close code 1005/1006 (never 1000), so the old
    // `code !== 1000` check would otherwise schedule a zombie reconnect that
    // reopens the socket after onUninit/shutdown.
    this._intentionalClose = true;
    this.isConnected = false;
    // F3: clear ALL timers (reconnect/stable/ping), not just ping — onUninit()
    // calls disconnect(), and a surviving reconnectTimer would fire post-shutdown.
    this._clearTimers();

    if (this.ws) {
      // Race-fix (2026-06-13, helkodsgranskningen): koppla av lyssnarna INNAN
      // close (samma härdade mönster som reconnectWithKey). Annars kan den
      // gamla socketens sena 'close'-event konsumera _intentionalClose och
      // riva en NY anslutnings timers/referens om connect() hunnit köra
      // emellan (stale-watchdogens reconnect, nyckelbyte osv.).
      try {
        this.ws.removeAllListeners();
        this.ws.on('error', () => {}); // error-sink — EventEmitter kastar annars
      } catch (err) {
        this.logger.debug(`🔧 [AIS_CLIENT] disconnect detach failed: ${err.message}`);
      }
      try {
        this.ws.close();
      } catch (err) {
        this.logger.debug(`🔧 [AIS_CLIENT] disconnect close failed: ${err.message}`);
      }
      this.ws = null;
      // Lyssnarna är avkopplade → emit:a disconnected själv så app-lagret
      // (connection_status, Bug#12-guard) får sin signal.
      this.emit('disconnected', { code: 1000, reason: 'intentional disconnect' });
    }
    // Helkodsgranskning 2026-07-01 (C2): nollställ avsiktsflaggan OVILLKORLIGT.
    // Tidigare låg återställningen inne i if (this.ws)-blocket — disconnect()
    // under backoff (ws=null) lämnade flaggan true, och nästa misslyckade
    // handshake efter reconnectWithKey konsumerades som "avsiktlig" i _onClose
    // → ingen reconnect någonsin → permanent död feed.
    this._intentionalClose = false; // ingen close-handler kvar som konsumerar
  }

  /**
   * Reconnect with a (possibly new) API key. Safe across any current state
   * (connected / connecting / backing off): clears pending timers and detaches
   * the previous socket's listeners BEFORE opening a new one, so a delayed
   * 'close' from the old socket can't null out or desubscribe the new socket
   * (which would otherwise open but never subscribe → silent dead feed).
   *
   * A7(b) (fältprovet 2026-08-08): metoden är återanvänd av feed-watchdogen
   * som sin ENDA ingripandeväg, men loggraden påstod undantagslöst att en
   * nyckel hade uppdaterats. Fältet: 21 rader "Reconnecting with updated API
   * key" mot NOLL [SETTINGS]-rader — varenda en var ett watchdog-ingripande,
   * och den som läste loggen fick leta efter ett nyckelbyte som aldrig fanns.
   * Orsaken skickas därför in av anroparen; defaultet är den historiska
   * betydelsen så en anropare som inte hunnit uppdateras aldrig ljuger MER än
   * i dag.
   * @param {string} apiKey - New API key for AISstream.io
   * @param {'key-update'|'watchdog'} [reason] - why the socket is being cycled
   * @returns {Promise<void>}
   */
  reconnectWithKey(apiKey, reason = 'key-update') {
    this.logger.log(`🔑 [AIS_CLIENT] Reconnecting socket (reason=${reason})`);

    // F2-4: ett AKTIVT ANVÄNDARINGREPP bryter rate-limit-cooldownen. En 429 är
    // IP-/kvotbunden och har inget med nyckeln att göra — men användaren VET
    // inte det: hen ser att appen står still, skapar en ny nyckel och klistrar
    // in den. Före fixen sparades nyckeln, försöket sköts upp i upp till 20 min
    // och den enda signalen var en debugrad; användaren drog rimligen
    // slutsatsen att även den nya nyckeln var trasig. Efter ett användaringrepp
    // är det inte längre klientens egen takt som håller spärren vid liv — en ny
    // nyckel är dessutom potentiellt en ny kvot. Watchdog-/automatvägarna
    // (reason='watchdog') behåller cooldownen: de är precis den maskinella takt
    // cooldownen finns till för att strypa.
    if (reason === 'key-update') this.clearRateLimitCooldown('key-update');

    // Cancel any pending reconnect/stable/ping timers from the previous attempt.
    this._clearTimers();

    // Detach and close the previous socket. removeAllListeners() is critical:
    // without it the old socket's async 'close' event would fire _onClose AFTER
    // connect() installs the new socket, nulling this.ws and scheduling a
    // zombie reconnect with the OLD key.
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        // Error-sink-fix (2026-06-13): ws emittar garanterat 'error' på en
        // övergiven socket i flera lägen (abort under CONNECTING, receiver-
        // fel under CLOSING-fönstret). Utan lyssnare KASTAR EventEmitter →
        // uncaughtException. Samma mönster som ws använder internt (NOOP).
        this.ws.on('error', () => {});
      } catch (err) {
        this.logger.debug(`🔧 [AIS_CLIENT] removeAllListeners failed: ${err.message}`);
      }
      try {
        this.ws.close();
      } catch (err) {
        this.logger.debug(`🔧 [AIS_CLIENT] close failed: ${err.message}`);
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.openedAt = null;
    this.reconnectAttempts = 0; // fresh intent → allow fast retries

    return this.connect(apiKey);
  }

  /**
   * F2-4: upphäv en pågående rate-limit-cooldown efter ett AKTIVT
   * användaringrepp (nyckelbyte via inställningarna, ändrad källkonfiguration).
   * Cooldownen finns för att strypa APPENS EGEN takt mot en spärrad server;
   * när användaren själv agerat är väntan inte längre klientens beslut, och
   * tystnaden är obegriplig för den som just bytt nyckel.
   *
   * Anropas ALDRIG från automatvägar (watchdog, schemalagd reconnect) — de
   * måste fortsätta respektera pausen, annars är cooldownen verkningslös.
   * @param {'key-update'|'source-config'|'user-action'} [reason]
   * @returns {boolean} true om en PÅGÅENDE cooldown faktiskt upphävdes
   */
  clearRateLimitCooldown(reason = 'user-action') {
    if (!this._rateLimitedUntil) return false;
    const left = this._rateLimitedUntil - Date.now();
    this._rateLimitedUntil = 0;
    this._rateLimitCount = 0; // användaringreppet avslutar episoden
    if (left <= 0) return false; // fältet var bara en passerad rest (F2-8)
    this.logger.log(
      `🔓 [AIS_CLIENT] Rate-limit-cooldown upphävd av användaringrepp (${reason}) — `
      + `${(left / 60000).toFixed(1)} min återstod`,
    );
    return true;
  }

  /**
   * Get connection status
   * @returns {boolean} True if connected
   */
  getConnectionStatus() {
    return this.isConnected;
  }

  /**
   * Get connection statistics
   * @returns {Object} Connection stats
   */
  getConnectionStats() {
    return {
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      lastMessageTime: this.lastMessageTime,
      uptime: this.openedAt ? Date.now() - this.openedAt : 0,
      timeSinceLastMessage: this.lastMessageTime ? Date.now() - this.lastMessageTime : null,
      // KX-2/KX-8: rate-limit-pausen måste synas utifrån — annars ser en
      // hälsorad exakt likadan ut för "väntar på cooldown" och "hamrar
      // förgäves". Samma fältnamnsmönster som AISHubs authCooldown*.
      rateLimitedUntil: this._rateLimitedUntil || null,
      rateLimitMsLeft: Math.max(0, this._rateLimitedUntil - Date.now()),
      lastHandshakeStatus: this._lastHandshakeStatus,
      messagesThisSocket: this._messagesThisSocket,
    };
  }

  /**
   * Send subscription message with API key and bounding box
   * @private
   */
  _subscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.apiKey) {
      this.logger.debug('🚫 [AIS_CLIENT] Cannot subscribe - WebSocket not ready or no API key');
      return;
    }

    // ChatGPT-granskningen 2026-07-10 (F1): prenumerationen läser nu
    // constants.AIS_CONFIG.BOUNDING_BOX (SSOT) i stället för en hårdkodad
    // kopia med sydgräns 58.2681. Den gamla gränsen låg ~315 m NORR om
    // VesselLifecycleManagers KANALINFARTEN_EXIT_LAT (58.2653), vilket
    // gjorde sydgående journey-completion-grenen onåbar via livedata —
    // sydresor avslutades alltid via timeout-vägen. Med SOUTH=58.26 får
    // exit-grenen data och Kanalinfarten-zonen full täckning söderut.
    // (Replay matar _processAISMessage direkt och berörs inte av boxen.)
    const {
      NORTH, SOUTH, EAST, WEST,
    } = AIS_CONFIG.BOUNDING_BOX;
    const boundingBox = [
      [NORTH, WEST], // North-West corner
      [SOUTH, EAST], // South-East corner
    ];

    // Use API key field name from constants for consistency
    const subscriptionMessage = {
      [AIS_CONFIG.API_KEY_FIELD]: this.apiKey, // Uses 'APIKey' from constants
      BoundingBoxes: [boundingBox],
    };

    try {
      this.ws.send(JSON.stringify(subscriptionMessage));
      this.logger.log('📡 [AIS_CLIENT] Subscription message sent');
    } catch (error) {
      this.logger.error('❌ [AIS_CLIENT] Failed to send subscription:', error);
      // B1-fix (2026-06-09): utan subscription är anslutningen "uppkopplad men
      // döv" — servern skickar aldrig data och inget i flödet märker det.
      // terminate() tvingar fram 'close' → ordinarie reconnect-väg kör om
      // hela connect+subscribe-sekvensen.
      try {
        this.ws.terminate();
      } catch (terminateError) {
        this.logger.debug(`🔧 [AIS_CLIENT] terminate after failed subscribe failed: ${terminateError.message}`);
      }
    }
  }

  /**
   * Setup WebSocket event handlers
   * @private
   */
  _setupWebSocketHandlers() {
    this.ws.on('open', this._onOpen.bind(this));
    this.ws.on('message', this._onMessage.bind(this));
    this.ws.on('close', this._onClose.bind(this));
    this.ws.on('error', this._onError.bind(this));
    this.ws.on('ping', this._onPing.bind(this));
    this.ws.on('pong', this._onPong.bind(this));
    // KX-2/KX-8: HTTP-svaret på en AVVISAD handskakning (429/401/403/503)
    // finns BARA i det här eventet. Utan lyssnare degraderar ws till ett
    // 'error' med fritexten "Unexpected server response: N" — statuskoden
    // blir oläsbar för kod och Retry-After-headern går förlorad helt.
    // Socketen fångas i closuren: en sen callback får aldrig röra en NY
    // socket (samma härdade mönster som detach-vägarna i den här filen).
    const socket = this.ws;
    socket.on('unexpected-response', (req, res) => this._onUnexpectedResponse(socket, req, res));
  }

  /**
   * Handskakningen avvisades med ett HTTP-svar (ws emittar 'unexpected-response').
   *
   * VIKTIGT: ws kör sin inbyggda abortHandshake ENDAST när ingen lyssnare
   * finns (`!websocket.emit('unexpected-response', req, res)` i
   * ws/lib/websocket.js). Med den här lyssnaren registrerad MÅSTE vi själva
   * riva handskakningen — annars uteblir både 'error' och 'close', ingen
   * _scheduleReconnect körs och socketen ligger kvar i CONNECTING tills
   * 60 s-deadlinen. terminate() under CONNECTING är exakt ws:s egen
   * abortHandshake-väg och ger garanterat 'error' + 'close'.
   * @private
   */
  _onUnexpectedResponse(socket, req, res) {
    // F2-5 (adversariell granskning 2026-08-10): SOCKETGENERATIONSVAKT.
    // Closuren skyddade bara terminate() — statusfälten nedan är KLIENT-
    // globala. En sen 429-callback från en ÖVERGIVEN socket kunde därför
    // stämpla _lastHandshakeStatus/_lastRetryAfterMs på klienten efter att
    // connect() nollställt dem och en NY socket öppnat och levererat; nästa
    // _scheduleReconnect klassade då läget som rate-limit och lade en
    // 15-minuterscooldown över en helt frisk anslutning. Samma vaktmönster
    // som detach-vägarna (disconnect/reconnectWithKey) redan använder: bara
    // den AKTUELLA socketen får röra klienttillstånd.
    if (socket !== this.ws) {
      // Den gamla socketen måste ändå rivas: ws:s inbyggda abortHandshake kör
      // ENDAST när ingen lyssnare finns, så utan detta ligger den kvar i
      // CONNECTING (och svarskroppen odränerad).
      try {
        if (res && typeof res.resume === 'function') res.resume();
      } catch (err) {
        this.logger.debug(`🔧 [AIS_CLIENT] resume of stale rejected response failed: ${err.message}`);
      }
      try {
        if (socket && typeof socket.terminate === 'function') socket.terminate();
      } catch (err) {
        this.logger.debug(`🔧 [AIS_CLIENT] terminate of stale socket failed: ${err.message}`);
      }
      this.logger.debug(
        `🔧 [AIS_CLIENT] unexpected-response (HTTP ${(res && res.statusCode) || '?'}) `
        + 'från en övergiven socket — ignorerad (rör inte den aktiva anslutningens status)',
      );
      return;
    }

    const status = (res && res.statusCode) || null;
    const retryAfterRaw = res && res.headers ? res.headers['retry-after'] : null;
    const retryAfterMs = this._parseRetryAfter(retryAfterRaw);

    this._lastHandshakeStatus = status;
    this._lastRetryAfterMs = retryAfterMs;

    const retryText = retryAfterMs === null ? '' : `, Retry-After ${(retryAfterMs / 1000).toFixed(0)} s`;
    this.logger.log(`🚦 [AIS_CLIENT] Handskakningen avvisad av servern: HTTP ${status}${retryText}`);

    try {
      if (res && typeof res.resume === 'function') res.resume(); // dränera svarskroppen
    } catch (err) {
      this.logger.debug(`🔧 [AIS_CLIENT] resume of rejected response failed: ${err.message}`);
    }
    try {
      socket.terminate();
    } catch (err) {
      this.logger.debug(`🔧 [AIS_CLIENT] terminate after rejected handshake failed: ${err.message}`);
    }
  }

  /**
   * Tolka Retry-After-headern. RFC 9110 tillåter två former: delta-sekunder
   * ("120") och ett HTTP-datum. Båda stöds; allt annat ger null så att
   * basvärdet i konstanterna gäller.
   *
   * F2-3 (adversariell granskning 2026-08-10): den gamla Date.parse-
   * fallbacken var INTE så strikt som kommentaren påstod. V8:s legacy-parser
   * accepterar långt mer än HTTP-datum — verifierat i node:
   * Date.parse('-5') = 2001-05-01 och Date.parse('120.5') = år 120. Båda
   * ligger i det förflutna ⇒ gamla Math.max(0, …) gav 0 ms, vilket är
   * !== null ⇒ _rateLimitDelay tog Retry-After-grenen och klampade till
   * 60 s-golvet i stället för att falla tillbaka på 15 min + jitter. En
   * server/proxy med en trasig header fick alltså appen att komma tillbaka
   * 15 gånger snabbare än designat — precis när servern bett oss backa.
   * Därför: DATUMFORMEN VALIDERAS MED REGEX FÖRE Date.parse, och ett datum
   * som inte pekar framåt betyder "headern bär ingen information" ⇒ null.
   * @private
   * @returns {number|null} millisekunder, eller null om headern saknas/är skräp
   */
  _parseRetryAfter(raw) {
    if (raw === null || raw === undefined) return null;
    const text = String(raw).trim();
    if (!text) return null;
    // Form 1: delta-sekunder. ENDAST rena siffror — '-5', '120.5', '1e3' och
    // '2 minutes' är inte delta-seconds enligt RFC 9110 §10.2.3.
    if (/^[0-9]+$/.test(text)) {
      const seconds = Number(text);
      return Number.isFinite(seconds) ? seconds * 1000 : null;
    }
    // Form 2: IMF-fixdate (RFC 1123/RFC 9110 §5.6.7), t.ex.
    // "Sun, 06 Nov 1994 08:49:37 GMT". Strukturen valideras INNAN Date.parse
    // så den leniata legacy-parsern aldrig får tolka skräp som ett datum.
    if (!AISStreamClient.RETRY_AFTER_HTTP_DATE_RE.test(text)) return null;
    const at = Date.parse(text);
    if (Number.isNaN(at)) return null;
    const ms = at - Date.now();
    // Ett datum i nuet/det förflutna säger ingenting om när servern vill ha
    // oss tillbaka ⇒ basvärdet (15 min + jitter) gäller, inte 60 s-golvet.
    return ms > 0 ? ms : null;
  }

  /**
   * Handle WebSocket open event
   * @private
   */
  _onOpen() {
    this.logger.log('✅ [AIS_CLIENT] Connected to AISstream.io');

    // Anslutningen öppnade — connect-deadlinen har gjort sitt
    if (this._connectDeadlineTimer) {
      clearTimeout(this._connectDeadlineTimer);
      this._connectDeadlineTimer = null;
    }

    this.isConnected = true;
    this.openedAt = Date.now(); // Track when connection opened
    this._intentionalClose = false; // fresh connection — clear any stale intent
    this._awaitingPong = false; // reset liveness watchdog state
    this._socketOpened = true; // KX-7: den här anslutningen var bevisligen NÅBAR
    this._messagesThisSocket = 0; // KX-8: leveransräknare per socket

    // V6-paritet: en accepterad handskakning bevisar att spärren är borta —
    // släpp cooldownen (och episodräknaren) precis som AISHubs "välformat
    // svar" upphäver auth-pausen.
    if (this._rateLimitedUntil) {
      this.logger.log('✅ [AIS_CLIENT] Rate-limit-cooldown upphävd — servern accepterar handskakningen igen');
      this._rateLimitedUntil = 0;
      this._rateLimitCount = 0;
    }

    // Don't reset reconnectAttempts immediately — wait until the connection
    // has been stable for STABLE_CONNECTION_MS. This prevents infinite rapid
    // reconnect loops when the server accepts then drops connections quickly.
    if (this._stableTimer) clearTimeout(this._stableTimer);
    this._stableTimer = setTimeout(() => {
      this._stableTimer = null;
      if (this.isConnected) {
        this.reconnectAttempts = 0;
        this.logger.debug('🔧 [AIS_CLIENT] Connection stable — reset reconnect counter');
      }
    }, AISStreamClient.STABLE_CONNECTION_MS);

    // KX-4: andra vägen till "stabil" — en anslutning som LEVERERAR. Den
    // ovanstående uptidsvägen är per konstruktion onåbar för en källa som
    // aldrig pongar (ping-vakten dödar vid 60 s < 120 s), så en levererande
    // men pong-tyst källa eskalerades obönhörligt till timtakt. Kravet på
    // faktisk data gör att RC-S1:s flappande-men-tomma anslutningar inte
    // berörs — och tröskeln ligger över deras 30-50 s livslängd.
    if (this._deliveringTimer) clearTimeout(this._deliveringTimer);
    this._deliveringTimer = setTimeout(() => {
      this._deliveringTimer = null;
      if (this.isConnected && this._messagesThisSocket > 0) {
        this.reconnectAttempts = 0;
        this.logger.debug(
          `🔧 [AIS_CLIENT] Connection delivering (${this._messagesThisSocket} meddelanden) — reset reconnect counter`,
        );
      }
    }, AISStreamClient.STABLE_DELIVERING_MS);

    // CRITICAL FIX: Clear any pending reconnect timer on successful connection
    // This prevents race condition where delayed reconnect callback fires after connection succeeds
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.logger.debug('🔧 [AIS_CLIENT] Cleared pending reconnect timer on successful connection');
    }

    // Send subscription message with API key and bounding box
    this._subscribe();

    // Start WebSocket ping to keep connection alive
    this._startPing();

    this.emit('connected');
  }

  /**
   * Handle WebSocket message event
   * @private
   */
  _onMessage(data) {
    try {
      const message = JSON.parse(data);

      // F55: surface server-side errors (e.g. invalid API key). AISstream.io
      // returns an error payload instead of a position report; previously the
      // message-type filter dropped it silently, so a bad key looked exactly
      // like "no traffic" and the user got no signal at all.
      if (message && (message.MessageType === 'Error' || message.error || message.Error)) {
        const detail = message.error || message.Error || 'unknown error';
        const detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail);
        this.logger.error(`❌ [AIS_CLIENT] Server error message: ${detailStr}`);
        // ChatGPT-granskningen 2026-07-10 (D1): aisstream använder samma
        // {"error"}-format för nyckelfel, throttling och andra serverfel.
        // Tidigare emittades ALLT som auth-error → användarnotisen "API-
        // nyckeln är troligen ogiltig" var vilseledande vid throttling.
        // Klassificera: bara nyckelrelaterade strängar är auth-error.
        // Skärpt i andra granskningsrundan: fristående "not valid" togs
        // bort — "Bounding Box Is Not Valid" är ett serverfel, inte ett
        // nyckelfel. Auth-klassningen kräver nu key-/auth-begrepp.
        // ("Api Key Is Not Valid" matchar via api\s*key.)
        const isAuthError = /api\s*key|invalid\s*key|unauthori[sz]|forbidden/i.test(detailStr);
        this.emit(isAuthError ? 'auth-error' : 'server-error', detail);
        // Härdning (samma mönster som misslyckad-subscribe-vägen ovan):
        // riv socketen så ordinarie close→reconnect-väg äger tillstånds-
        // övergången — eliminerar varje "grön men döv"-fönster oavsett om
        // servern själv stänger efter felet (den gör det vid nyckelfel,
        // kod 1006, men kontraktet för övriga fel är odokumenterat).
        // if-gaten krävs: enhetstester anropar _onMessage utan live socket.
        if (this.ws) {
          try {
            this.ws.terminate();
          } catch (terminateError) {
            this.logger.debug(`🔧 [AIS_CLIENT] terminate after server error failed: ${terminateError.message}`);
          }
        }
        return;
      }

      // B1 (2026-07-03): statiska rapporter är kanalen där Class B-fartyg
      // faktiskt sänder sitt namn (typ 24 del A; typ 5 för Class A) — de
      // saknar position och åkte tidigare rakt i papperskorgen, så appen
      // var helt beroende av att aisstream hann backfylla MetaData.ShipName
      // (VALEN: 36 min utan namn). Fånga namnet här, FÖRE positionsfiltret
      // och koordinatvalideringen, och emit:a separat. Skapar ALDRIG vessel
      // och rör inte lastMessageTime (feed-watchdogen förblir positionsdriven).
      if (message.MessageType === 'ShipStaticData' || message.MessageType === 'StaticDataReport') {
        const staticMeta = message.Metadata || message.MetaData || {};
        const staticBody = Object.values(message.Message || {})[0] || {};
        const staticMmsi = staticBody.MMSI ?? staticMeta.MMSI;
        const staticName = String(
          staticBody.Name
          ?? (staticBody.ReportA && staticBody.ReportA.Name)
          ?? staticMeta.ShipName
          ?? '',
        ).trim();
        if (staticMmsi && staticName && staticName !== 'Unknown') {
          this.emit('static-name', { mmsi: staticMmsi.toString(), shipName: staticName });
        }
        return;
      }

      // CRITICAL FIX: Use string message types like old working version
      const validMessageTypes = [
        'PositionReport',
        'StandardClassBPositionReport',
        'ExtendedClassBPositionReport',
      ];

      if (!validMessageTypes.includes(message.MessageType)) {
        return;
      }

      // Extract AIS data
      const aisData = this._extractAISData(message);
      if (aisData) {
        this.lastMessageTime = Date.now(); // Update last message time
        this._messagesThisSocket++; // KX-4/KX-8: leveransbevis för DEN HÄR socketen
        this.emit('ais-message', aisData);
        // Removed debug spam - AIS messages are processed frequently
      }

    } catch (error) {
      this.logger.log('⚠️ [AIS_CLIENT] Error parsing message:', error.message);
    }
  }

  /**
   * Handle WebSocket close event
   * @private
   */
  _onClose(code, reason) {
    // KX-8 (fältprovet 2026-08-09): 0,53-sekundersanslutningen 09:33:55 gick
    // inte att förklara i efterhand — samtliga 16 stängningar loggades som
    // "1006 - " med tom reason och utan livslängd eller leveransräkning. Nu
    // bär raden allt som skiljer felklasserna åt: hur länge socketen levde,
    // hur mycket den hann leverera och vilken HTTP-status handskakningen fick.
    const lifetimeMs = this.openedAt ? Date.now() - this.openedAt : null;
    const reasonText = reason === undefined || reason === null || String(reason) === ''
      ? '(tom reason)'
      : String(reason);
    const lifeText = lifetimeMs === null
      ? 'öppnade aldrig'
      : `öppen ${(lifetimeMs / 1000).toFixed(2)} s, ${this._messagesThisSocket} meddelanden`;
    const statusText = this._lastHandshakeStatus ? `, HTTP ${this._lastHandshakeStatus}` : '';
    this.logger.log(`🔌 [AIS_CLIENT] Connection closed: ${code} - ${reasonText} (${lifeText}${statusText})`);

    this.isConnected = false;
    this._clearTimers();

    // Clear WebSocket reference to allow reconnection
    this.ws = null;
    this.openedAt = null; // Reset connection time

    this.emit('disconnected', { code, reason });

    // Reconnect-beslut: både disconnect() och reconnectWithKey() detachar
    // lyssnarna FÖRE close, och C2-fixen (2026-07-01) nollställer dessutom
    // _intentionalClose ovillkorligt i disconnect() — så varje close som når
    // hit är i praktiken oavsiktlig och wasIntentional är alltid false.
    // Flaggkontrollen behålls enbart som defensiv backstop ifall en framtida
    // kodväg stänger utan att detacha. En servergraceful close med kod 1000
    // (deploy/omstart) måste också ge reconnect, annars är feeden permanent
    // död (watchdogen är gated på isConnected) — därför gatas ALDRIG på koden.
    const wasIntentional = this._intentionalClose;
    this._intentionalClose = false;
    if (!wasIntentional) {
      this._scheduleReconnect();
    }
  }

  /**
   * Handle WebSocket error event
   * @private
   */
  _onError(error) {
    const message = (error && error.message) || String(error);
    // KX-8: err.code/errno är det som skiljer ECONNRESET från EPROTO från
    // ETIMEDOUT. Utan dem går 1006-stängningarna inte att diagnostisera i
    // efterhand — fältloggens 110 [err]-rader bar bara en fritextsträng.
    const codePart = error && (error.code || error.errno) ? ` [${error.code || error.errno}]` : '';
    const statusPart = this._lastHandshakeStatus ? ` (HTTP ${this._lastHandshakeStatus})` : '';
    this.logger.error(`❌ [AIS_CLIENT] WebSocket error${codePart}${statusPart}:`, message);

    // Backstop för 429-klassificeringen: om 'unexpected-response'-vägen av
    // någon anledning inte kört (framtida ws-version, annan kodväg) bär ws:s
    // egen felsträng ändå statuskoden — plocka den så en rate-limit aldrig
    // kan passera oupptäckt och landa i snabbtrappan.
    if (!this._lastHandshakeStatus && typeof message === 'string') {
      const match = /Unexpected server response:\s*(\d{3})/.exec(message);
      if (match) this._lastHandshakeStatus = Number(match[1]);
    }

    this.emit('error', error);
  }

  /**
   * Handle WebSocket ping event
   * @private
   */
  _onPing() {
    // Removed debug spam - ping/pong happens frequently
  }

  /**
   * Handle WebSocket pong event
   * @private
   */
  _onPong() {
    // F1: pong arrived → connection is alive; clear the watchdog flag.
    this._awaitingPong = false;
  }

  /**
   * Extract AIS data from stream message (based on old working version)
   * @private
   */
  _extractAISData(message) {
    // CRITICAL FIX: Use same data extraction as old working version
    const meta = message.Metadata || message.MetaData || {};
    const body = Object.values(message.Message || {})[0] || {};

    // Validate required fields (using old version field names)
    const mmsi = body.MMSI ?? meta.MMSI;
    const lat = meta.Latitude ?? body.Latitude;
    const lon = meta.Longitude ?? body.Longitude;

    // Check for missing MMSI
    if (!mmsi) {
      this._logRejectedMessage(null, 'missing MMSI');
      return null;
    }

    // ChatGPT-granskningen 2026-07-10 (E1): aisstreams positionsrapporter
    // bär ett required Valid-fält (go-ais-dekodern sätter false endast vid
    // misslyckad avkodning — i praktiken emitteras sådana aldrig, men
    // kontraktet finns). Defense-in-depth: avvisa explicit Valid === false.
    // STRIKT === false — meddelanden UTAN fältet (undefined, t.ex. alla
    // replay-sampel som saknar fältet helt) får ALDRIG tappas.
    if (body.Valid === false) {
      this._logRejectedMessage(mmsi, 'decoder flagged Valid=false');
      return null;
    }

    // Check for missing coordinates (use explicit undefined/null checks to allow 0 values)
    if (lat === undefined || lat === null || lon === undefined || lon === null) {
      this._logRejectedMessage(mmsi, 'missing coordinates (GPS fix lost?)');
      return null;
    }

    // CRITICAL FIX: Reject lat=0, lon=0 coordinates (Gulf of Guinea intersection)
    // This is ~6000km from Trollhättan and indicates invalid/missing GPS data
    if (lat === 0 && lon === 0) {
      this._logRejectedMessage(mmsi, '0,0 coordinates (missing GPS fix)');
      return null;
    }

    // Förtöjningsdetektering lager 3 (2026-06-10): Class A-fartyg deklarerar
    // navigationsstatus (1=at anchor, 5=moored) i PositionReport — semantiskt
    // exakt signal som tidigare slängdes bort. Class B saknar fältet → null.
    //
    // J35 (helkodsgranskning runda 2, 2026-08-22) — ÖVRE GRÄNSEN ÄR 14, INTE
    // 15. AIS-specen definierar 0-14 som semantiska statusar; 15 betyder
    // "undefined". lib/utils/aishubParser.js mappade redan 15 till null
    // uttryckligen för att ett "undefined" ALDRIG ska skriva över ett känt
    // 1 (at anchor) eller 5 (moored) — VesselDataService slår ihop med
    // nullish-operatorn (data.navStatus ?? oldVessel.navStatus), så ett 15
    // ERSATTE det kända värdet, MOORED_NAV_STATUSES slutade matcha och lager
    // 3 föll bort. Den kajförtöjda båten fick då vänta på kajzonslagret
    // (>= 3 min stillhet) eller 2h-backstoppen, och under fönstret räknades
    // hon som väntande — samma felmod som falsk "inväntar broöppning".
    // Regeln delas numera med parsern (aisFieldNormalization) så de två
    // ingångarna inte kan glida isär igen.
    const rawNavStatus = body.NavigationalStatus ?? meta.NavigationalStatus;
    const navStatus = normalizeNavStatus(rawNavStatus);

    // Helgranskning 2026-07-06: SOG-sentinelen. ITU-R M.1371 rå-SOG 1023 =
    // "ej tillgänglig" avkodas av aisstream till 102.3 kn (samma /10-mönster
    // som COG-sentinelen 3600→360 som redan räddas i app-valideringen).
    // Utan normalisering föll 102.3 på SOG_MAX=100 i _isValidAISMessage och
    // HELA positionsrapporten avvisades — en båt utan fartgivare blev osynlig
    // (samma buggklass som det fixade sog=null-avvisandet). ≥102.15 täcker
    // även 102.2 ("102.2 kn eller mer") — fysiskt nonsens i kanalen ⇒ okänd.
    // J6/J35 (runda 2): sentinelgränsen bor numera i
    // lib/utils/aisFieldNormalization.js tillsammans med COG- och
    // NAVSTAT-reglerna — den stod som naken literal i BÅDA ingångarna.
    //
    // NÅGON FINITGRIND FINNS MEDVETET INTE (granskningen av runda 2): ett
    // icke-finit sog skickas vidare RÅTT precis som före hjälparen, och
    // faller då i app.js _validateAISMessage. En grind här hade varit en fix
    // på det DEMENTERADE fyndet J3 — AIS-SOG är ett teckenlöst 10-bitarsfält
    // (0–102,3 kn), så ingen konform avkodare kan producera icke-finit, och
    // AIS_VALIDATION_REJECT loggas 0 gånger i 102 fältloggar (281 MB). Den
    // hade dessutom ÄNDRAT semantik utan mätning: meddelandet hade levererats
    // med sog null, dvs. som den FARTGIVARLÖSA klassen, och replayharnessen
    // anropar aldrig _extractAISData så inget facit hade sett det.
    // KONTRASTEN MOT COG NEDAN ÄR HELA SKÄLET: en korrupt COG nollas av
    // appvalideringen och rapporten LEVER vidare, medan en korrupt SOG får
    // samma validering att returnera false och fälla HELA rapporten — därför
    // är COG-grinden ren paritet men SOG-grinden en ny fartygsklass.
    const rawSog = meta.SOG ?? meta.Sog ?? body.SOG ?? body.Sog ?? null;
    const sog = normalizeSog(rawSog);

    // J6 (helkodsgranskning runda 2, 2026-08-22) — COG-PARITETEN. Strömsidan
    // skickade kursen HELT RÅTT: varken sentinelen 360 eller det avkodade
    // skräpbandet 360,1-409,5 (rå COG 3601-4095) nollades, medan
    // aishubParser gjort exakt det sedan H34. Nedströms fångar visserligen
    // appens _validateAISMessage värdet — men muxen bokför fixen via
    // FixFusionPolicy.applyAccept FÖRE appvalideringen, och F2:s
    // korskällenyckel ÄR mmsi:sog:cog. Samma fysiska rapport bar därför 360
    // från aisstream och null från hubben: F2 matchade aldrig, den extra
    // fixen förnyade vessel.timestamp och matade fysikgrindens dt, och
    // F6b:s parbevis (observeClock) fick pairLags = 0 för HELA klassen
    // kurslösa fartyg (förtöjda och Class B utan kompass — 837
    // sentinelträffar i fältloggarna). POSITIONEN BEHÅLLS, bara kursen
    // kasseras; se aisFieldNormalization för varför null och inte modulo.
    const cog = normalizeCog(meta.COG ?? meta.Cog ?? body.COG ?? body.Cog ?? null);

    // EN stämpel för både mottagningstid och fixtid — de är samma sak för
    // en pushande källa, och två Date.now()-anrop hade gett dem olika värden.
    const now = Date.now();

    return {
      mmsi: mmsi.toString(),
      msgType: message.MessageType,
      lat,
      lon,
      sog,
      cog,
      navStatus,
      // Produktionsredo (2026-07-03): String()-wrap — ett icke-sträng-Name
      // (nummer/objekt från trasig sändare) kastade på .trim() och slängde
      // HELA positionsrapporten.
      shipName: String(body.Name ?? meta.ShipName ?? '').trim() || 'Unknown',
      timestamp: now,
      // Fältprov 3 (2026-08-02): fusionsfälten sätts VID KÄLLAN. Tidigare
      // saknades de här och fylldes på först i app.js — men muxens
      // FixFusionPolicy körs FÖRE det, så state.lastFeed blev undefined
      // efter varje aisstream-fix och F5:s källbytesskydd hoppades tyst
      // över för HELA riktningen aisstream→AISHub (~halva källbytena).
      // Replay-harnessen injicerar fälten själv, vilket maskerade defekten
      // i hela testbatteriet — en bugg som bara fanns i produktion.
      // aisstream bär ingen äkta fixtid: mottagningsstämpeln ÄR tiden, och
      // 'receipt' markerar att den aldrig får jämföras med en 'true-fix'.
      fixTs: now,
      fixFeed: 'aisstream',
      fixTsQuality: 'receipt',
    };
  }

  /**
   * KX-7: sant BARA när det senaste försöket varken öppnade socketen eller
   * fick ett HTTP-svar — det enda läge där ordet "unreachable" är sant.
   * Fältet 2026-08-09: raden skrevs fyra gånger på anslutningar som öppnade
   * OCH prenumererade, och en gång 3 ms efter ett HTTP 429 (en statuskod
   * BEVISAR att servern var nåbar). En fältanalytiker som greppar på
   * "unreachable" fick därmed fel diagnos: "nät/DNS/brandvägg" i stället för
   * "öppnar men levererar inget".
   * @private
   */
  _neverReachedServer() {
    return !this._socketOpened && this._lastHandshakeStatus === null;
  }

  /**
   * KX-7: kort beskrivning av vad som FAKTISKT hände med senaste försöket.
   * @private
   */
  _lastAttemptOutcome() {
    if (this._lastHandshakeStatus !== null) {
      return `avvisad med HTTP ${this._lastHandshakeStatus}`;
    }
    if (this._socketOpened) {
      return this._messagesThisSocket > 0
        ? `öppnade och levererade ${this._messagesThisSocket} meddelanden innan den stängde`
        : 'öppnade men levererade ingenting';
    }
    return 'nådde aldrig fram';
  }

  /**
   * KX-2: ska nästa återförsök vara en rate-limit-cooldown i stället för ett
   * steg i snabbtrappan?
   *
   * 429 räknas alltid. 503 räknas bara när servern satt Retry-After — då är
   * det ett explicit besked om när den vill ha oss tillbaka; ett 503 UTAN
   * header är ett vanligt serverfel och ska ha den ordinarie trappan (så
   * 503-stormen 2026-06-11 beter sig exakt som förut).
   * @private
   * @returns {{delay:number,status:number,source:string}|null}
   */
  _rateLimitDelay() {
    const status = this._lastHandshakeStatus;
    const retryAfterMs = this._lastRetryAfterMs;
    const isRateLimited = status === 429 || (status === 503 && retryAfterMs !== null);
    if (!isRateLimited) return null;

    if (retryAfterMs !== null) {
      // F2-6: golvet är STATUSBEROENDE. 60 s är motiverat för en 429 (under
      // det är cooldownen inte skiljbar från snabbtrappan och spärren hålls
      // vid liv av vår egen takt), men en 503 med "Retry-After: 2" är en
      // rullande omstart — serverns egen begäran ska då respekteras, inte
      // klampas UPP 30×. Fasgolvet i _scheduleReconnect ser ändå till att en
      // flappande server inte kan hamras: max(cooldown, fasens delay).
      const floor = status === 429
        ? AIS_CONFIG.RATE_LIMIT_RETRY_AFTER_MIN_MS
        : AIS_CONFIG.RATE_LIMIT_RETRY_AFTER_MIN_503_MS;
      const clamped = Math.min(
        Math.max(retryAfterMs, floor),
        AIS_CONFIG.RATE_LIMIT_RETRY_AFTER_MAX_MS,
      );
      const clampNote = clamped === retryAfterMs ? '' : ' klampad';
      return {
        delay: clamped,
        status,
        source: `Retry-After ${(retryAfterMs / 1000).toFixed(0)} s${clampNote}`,
      };
    }
    return {
      delay: AIS_CONFIG.RATE_LIMIT_COOLDOWN_MS
        + Math.random() * AIS_CONFIG.RATE_LIMIT_COOLDOWN_JITTER_MS,
      status,
      source: 'ingen Retry-After',
    };
  }

  /**
   * F2-2: den ordinarie fasens GRUNDfördröjning för nuvarande
   * reconnectAttempts — sidoeffektsfri och utan jitter (jittret är
   * thundering-herd-spridning, inte en del av takten). Används som GOLV av
   * rate-limit-grenen: en spärr får aldrig FÖRKORTA en redan eskalerad
   * backoff. Speglar exakt fasgränserna i _scheduleReconnect.
   * @private
   * @returns {number} millisekunder
   */
  _phaseBaseDelay() {
    if (this.reconnectAttempts >= MEDIUM_RECONNECT_MAX) return SLOW_RECONNECT_INTERVAL;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return MEDIUM_RECONNECT_INTERVAL;
    const delays = AIS_CONFIG.RECONNECT_DELAYS;
    const delayIndex = Math.min(this.reconnectAttempts, delays.length - 1);
    return Math.min(delays[delayIndex], MAX_RECONNECT_DELAY);
  }

  /**
   * Schedule reconnection attempt
   * @private
   */
  _scheduleReconnect() {
    let delay;

    // KX-2: en rate-limit är inte ett serverfel utan ett EXPLICIT "backa av".
    // Den får därför en egen, platt cooldown FÖRE alla faser — och lämnar
    // stegräknaren orörd, så en spärr aldrig kan knuffa en frisk källa ned i
    // 5-minuters- eller timfasen.
    const rateLimit = this._rateLimitDelay();
    if (rateLimit) {
      // F2-2: cooldownen är ett GOLV, inte ett tak. Före fixen skrev den
      // platta 15-minuterscooldownen över en redan eskalerad backoff: en
      // server som varit onåbar i över en timme (timfasen, 1 handskakning/h)
      // och sedan börjar svara 429 fick 4 handskakningar/h — tvärtemot både
      // avsikten i kommentaren ovan och serverns uttryckliga besked.
      const phaseFloor = this._phaseBaseDelay();
      delay = Math.max(rateLimit.delay, phaseFloor);
      this._rateLimitedUntil = Date.now() + delay;
      this._rateLimitCount++;
      const floorNote = delay > rateLimit.delay
        ? ` [golv: fasens ${(phaseFloor / 60000).toFixed(1)} min gäller]`
        : '';
      this.logger.log(
        `🚦 [AIS_CLIENT] Rate-limitad av servern (HTTP ${rateLimit.status}, ${rateLimit.source}) — `
        + `cooldown ${(delay / 60000).toFixed(1)} min${floorNote} `
        + `(nr ${this._rateLimitCount} i episoden; steget står kvar på ${this.reconnectAttempts})`,
      );
    } else if (this.reconnectAttempts >= MEDIUM_RECONNECT_MAX) {
      // Slow phase — try once per hour indefinitely
      delay = SLOW_RECONNECT_INTERVAL;
      this.reconnectAttempts++;
      this.logger.log(
        this._neverReachedServer()
          // Historisk text bevarad ORDAGRANT för det fall den faktiskt är sann.
          ? `🔄 [AIS_CLIENT] Still unreachable — switching to hourly reconnect (attempt ${this.reconnectAttempts})`
          : `🔄 [AIS_CLIENT] Mediumfasen uttömd (senaste utfall: ${this._lastAttemptOutcome()}) `
            + `— går över till timvisa försök (attempt ${this.reconnectAttempts})`,
      );
      this.emit('max-reconnects-reached');
    } else if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      // Medium phase — try every 5 minutes (after fast retries exhausted)
      delay = MEDIUM_RECONNECT_INTERVAL;
      this.reconnectAttempts++;
      this.logger.log(
        this._neverReachedServer()
          ? `🔄 [AIS_CLIENT] Server unreachable after ${MAX_RECONNECT_ATTEMPTS} fast attempts — retrying every 5 min (attempt ${this.reconnectAttempts})`
          : `🔄 [AIS_CLIENT] Snabbfasen uttömd efter ${MAX_RECONNECT_ATTEMPTS} försök `
            + `(senaste utfall: ${this._lastAttemptOutcome()}) — går över till 5-minutersförsök `
            + `(attempt ${this.reconnectAttempts})`,
      );
    } else {
      // Fast reconnect phase — progressive delay with randomization
      const delays = AIS_CONFIG.RECONNECT_DELAYS;
      const delayIndex = Math.min(this.reconnectAttempts, delays.length - 1);
      delay = delays[delayIndex];

      // Add randomization to prevent thundering herd
      delay += Math.random() * 5000;
      delay = Math.min(delay, MAX_RECONNECT_DELAY);

      this.reconnectAttempts++;
      this.logger.log(
        `🔄 [AIS_CLIENT] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
      );
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      // If we have an API key stored, try to reconnect directly
      if (this.apiKey && !this.isConnected && !this.ws) {
        this.connect(this.apiKey).catch((err) => {
          this.logger.error('❌ [AIS_CLIENT] Direct reconnection failed:', err);
          // Fallback to emitting event for app.js to handle
          this.emit('reconnect-needed');
        });
      } else {
        // Fallback to event-based reconnection
        this.emit('reconnect-needed');
      }
    }, delay);
  }

  /**
   * Start WebSocket ping to keep connection alive
   * @private
   */
  _startPing() {
    this._stopPing();
    this._awaitingPong = false;
    // F2-1: leveransräkningen vid FÖRRA ping-ticket. Baslinjen är nuläget (inte
    // 0) så att en direktanropad _startPing — enhetstester, framtida
    // återanvänd socket — aldrig ärver ett gammalt delta som falskt
    // leveransbevis.
    this._pingTickMessages = this._messagesThisSocket;
    this._ponglessDeliveryLogged = false;

    // F1: ping every 30s AND detect half-open connections. If the previous
    // ping got no pong by the next tick, the TCP socket is half-open (server
    // stopped sending, no 'close' event fires) — terminate() forces a 'close'
    // so the normal reconnect path runs. Without this, isConnected stays true
    // forever and the feed dies silently (no bridge_text, no notifications)
    // until the app is restarted.
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      // F2-1 (adversariell granskning 2026-08-10) — LEVERANSBEVIS AVVÄPNAR
      // PING-VAKTEN. Rotorsaken till 1 370-handskakningsloopen: AIS-
      // meddelanden nollställde ALDRIG _awaitingPong, så en källa bakom en
      // proxy/LB som sväljer ping-frames men vidarebefordrar data dödades av
      // appen SJÄLV var 60:e sekund — mitt i ett flöde. Ihop med KX-4:s
      // leveransreset (55 s ⇒ reconnectAttempts = 0) blev cykeln ~63 s och
      // självförnyande: ≈1 370 handskakningar/dygn, precis den takt som ger
      // HTTP 429 och därmed 15-20 minuters självförvållad blindhet.
      // Har socketen levererat sedan förra ticket är den bevisligen levande
      // på applikationsnivå — pong är då en formalitet, inte ett livstecken.
      // Vakten behålls FULLT UT för tysta sockets: deltat mäts per tick, så
      // ett flöde som TYSTNAR dödas fortfarande inom två tick (60 s) räknat
      // från sista meddelandet.
      const deliveredSinceLastTick = this._messagesThisSocket > this._pingTickMessages;
      this._pingTickMessages = this._messagesThisSocket;

      if (this._awaitingPong) {
        if (deliveredSinceLastTick) {
          this._awaitingPong = false;
          if (!this._ponglessDeliveryLogged) {
            // EN rad per socket: diagnosen ("pong-tyst men levererande") är
            // värdefull, en rad var 30:e sekund är loggspam.
            this._ponglessDeliveryLogged = true;
            this.logger.log(
              '🫀 [AIS_CLIENT] Ingen pong men data flödar — ping-vakten avväpnad av leveransbevis '
              + `(${this._messagesThisSocket} meddelanden på socketen)`,
            );
          }
        } else {
          this.logger.log('⚠️ [AIS_CLIENT] No pong since last ping — connection half-open, terminating');
          this._awaitingPong = false;
          try {
            this.ws.terminate();
          } catch (err) {
            this.logger.debug(`🔧 [AIS_CLIENT] terminate failed: ${err.message}`);
          }
          return;
        }
      }
      this._awaitingPong = true;
      try {
        this.ws.ping();
      } catch (err) {
        this.logger.debug(`🔧 [AIS_CLIENT] ping failed: ${err.message}`);
      }
    }, 30000); // 30 seconds
  }

  /**
   * Stop WebSocket ping
   * @private
   */
  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this._awaitingPong = false;
    this._pingTickMessages = 0; // F2-1: leveransdeltat hör till EN socket
    this._ponglessDeliveryLogged = false;
  }

  /**
   * Clear all timers
   * @private
   */
  _clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this._stableTimer) {
      clearTimeout(this._stableTimer);
      this._stableTimer = null;
    }
    if (this._deliveringTimer) {
      clearTimeout(this._deliveringTimer);
      this._deliveringTimer = null;
    }
    if (this._connectDeadlineTimer) {
      clearTimeout(this._connectDeadlineTimer);
      this._connectDeadlineTimer = null;
    }

    this._stopPing();
  }
}

module.exports = AISStreamClient;
