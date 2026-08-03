'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const https = require('https');
const { URL } = require('url');
const { AIS_CONFIG } = require('../constants');
const aishubParser = require('../utils/aishubParser');

/**
 * AISHubClient - Pollande klient mot AISHubs webservice (ws.php).
 *
 * Emittar SAMMA nio-eventytor som AISStreamClient så att muxen/app-lagret
 * kan behandla källorna likvärdigt:
 *   'ais-message'   {mmsi,msgType,lat,lon,sog,cog,navStatus,shipName,
 *                    timestamp, fixTs, fixFeed:'aishub', fixTsQuality:'true-fix'}
 *   'static-name'   {mmsi, shipName}   (emitteras FÖRE positionen)
 *   'connected'     på FÖRSTA välformade svaret (ERROR:false — även tom kanal
 *                   räknas som kontakt; Bug#12-motivet: solo-AISHub får aldrig
 *                   visa "AIS-anslutning saknas" medan data flödar)
 *   'disconnected'  {code, reason} när senaste lyckade svar är > SILENT_FEED_MS
 *                   gammalt ELLER efter ERROR_STREAK_DISCONNECT raka fel
 *   'auth-error'    HTTP 401/403 eller access-klassad ERROR_MESSAGE
 *   'server-error'  övriga serverfel (felkuvert, formatbyte, TIME-larm)
 *   'error'         nätverksfel (transport)
 *
 * RATE-LIMIT-DISCIPLIN (V2-C1/V2-C2 — planens hårdaste krav):
 *  - EN setTimeout-kedja (aldrig setInterval), exakt ett timerhandtag
 *    (_pollTimer), alltid clearTimeout före setTimeout.
 *  - Single-flight (_inFlight) — en poll i taget, punkt.
 *  - Schemaläggning sker i finally — INGEN kodväg får lämna _poll utan att
 *    nästa poll är bokad (en missad ombokning = permanent död kedja).
 *  - Spärren persisteras (settings 'aishub_last_poll_at') FÖRE requesten och
 *    respekteras vid omstart — appomstart 5 s efter en poll får inte ge en
 *    ny poll 5 s senare.
 *  - Backoff går ALDRIG nedåt vid fel: 65 → 130 → 260 → tak 300 s. Ett
 *    välformat svar (ERROR:false, även tom kanal) återställer basen —
 *    minsta-avståndet 61 s gäller OVILLKORLIGT oavsett backoff-läge.
 *  - reconnectWithKey() är en NO-OP: det finns ingen anslutning att
 *    återupprätta i en pollkälla, och aisstream-nyckeln är en annan
 *    credential. Username-byte hanteras av muxens applySourceConfig som
 *    river klienten (disconnect) och skapar en ny.
 *  - AUTH-COOLDOWN (V6, A/B-natten 2026-08-03): upprepade 401/403 PAUSAR
 *    kedjan i AUTH_COOLDOWN_MS — de dödar den aldrig. Enda vägen till
 *    _stopped = true är disconnect() (muxens teardown/onUninit).
 */
class AISHubClient extends EventEmitter {
  /**
   * @param {object} logger - App-instansen (log/debug/error)
   * @param {object|null} settingsStore - {get(k), set(k,v)} — homey.settings
   *        i produktion; null ger in-memory-spärr (enhetstester).
   */
  constructor(logger, settingsStore = null) {
    super();
    this.logger = logger;
    this._settings = settingsStore;
    this._cfg = AIS_CONFIG.AISHUB;

    this.username = null;
    this.isConnected = false;
    this.openedAt = null;
    this.lastMessageTime = null;

    this._stopped = true;
    this._inFlight = false;
    this._pollTimer = null;
    this._emitTimers = new Set();
    this._backoffMs = null; // null = ingen backoff (bas-kadens)
    this._failStreak = 0;
    this._authFailCount = 0;
    // V6: auth-cooldownens slut (0 = ingen paus) + engångsnotisens flagga.
    // Båda nollställs av ett välformat svar — en ny episod ska kunna notifiera.
    this._authCooldownUntil = 0;
    this._authNotified = false;
    this._lastOkResponseAt = null;
    this._memLastPollAt = 0; // fallback när settingsStore saknas
    this._timeParseFailStreak = 0;
    this._timeParseAlarmed = false;
    this._seenErrorTexts = new Set(); // första förekomsten av varje feltext loggas alltid
    this._dedup = new Map(); // mmsi → senaste emitterade fixTs

    this._counters = {
      polls: 0,
      emptyResponses: 0,
      errorRecords: 0,
      formatMismatch: 0,
      recordCountMismatch: 0,
      parseErrors: 0,
      envelopeErrors: 0,
      emptySweeps: 0,
      authFail: 0,
      netErrors: 0,
      httpErrors: 0,
      timeParseFail: 0,
      sentinelPos: 0,
      invalidMmsi: 0,
      outOfBox: 0,
      dupes: 0,
      accepted: 0,
    };
  }

  /**
   * Starta pollandet mot AISHub med givet username.
   * @param {string} username - AISHub-medlemskapets användarnamn
   * @returns {Promise<void>} (async för AISStreamClient-paritet)
   */
  async connect(username) {
    const trimmed = String(username || '').trim();
    if (!trimmed) {
      this.logger.log('🚫 [AISHUB_CLIENT] connect utan username — startar inte');
      return;
    }
    if (!this._stopped) {
      this.logger.debug('🌐 [AISHUB_CLIENT] Redan startad');
      return;
    }
    this.username = trimmed;
    this._stopped = false;

    // Första pollens fördröjning: respektera persisterad spärr + startjitter
    // (0-15 s) så en omstart aldrig kan ge < 61 s mellan två poll-starter.
    const last = this._readLastPollAt();
    const sinceLast = Date.now() - last;
    const spacingLeft = Math.max(0, this._cfg.MIN_POLL_SPACING_MS - sinceLast);
    const startDelay = spacingLeft + Math.floor(Math.random() * this._cfg.START_JITTER_MAX_MS);
    this.logger.log(
      `🌐 [AISHUB_CLIENT] Startar poll-kedja (username ${this._maskedUser()}), `
      + `första poll om ${(startDelay / 1000).toFixed(1)}s`,
    );
    this._scheduleNext(startDelay);
  }

  /**
   * Stoppa pollandet och rensa alla timers. Emittar 'disconnected' på
   * flanken (paritet med AISStreamClient.disconnect).
   */
  disconnect() {
    this.logger.log('🛑 [AISHUB_CLIENT] Stoppar poll-kedjan');
    this._stopped = true;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    for (const t of this._emitTimers) clearTimeout(t);
    this._emitTimers.clear();
    const wasConnected = this.isConnected;
    this.isConnected = false;
    this.openedAt = null;
    if (wasConnected) {
      this.emit('disconnected', { code: 1000, reason: 'intentional disconnect' });
    }
  }

  /**
   * NO-OP på AISHub-grenen (se klasskommentaren). Behålls för att muxens
   * fan-out ska kunna anropa båda barnen symmetriskt utan särkodning.
   * @returns {Promise<void>}
   */
  async reconnectWithKey() {
    this.logger.debug('🔧 [AISHUB_CLIENT] reconnectWithKey är en no-op för pollkällan');
  }

  /**
   * Feed-vaktens kick (etapp 2): boka en poll snarast. HELT säkert mot
   * kadensbrott — _poll() kontrollerar OVILLKORLIGT den persisterade
   * 61s-spärren och bokar om sig själv om den är för tidig. Enda äkta
   * effekten är att en DÖD kedja (tappad timer) återupplivas.
   */
  forceReschedule() {
    if (this._stopped) return;
    // V6: en auth-paus får inte kickas bort av feed-vakten — servern har
    // uttryckligen avvisat oss, och en kick var 20:e minut vore precis den
    // spam mot ws.php som cooldownen finns för att undvika.
    const cooldownLeft = this._authCooldownUntil - Date.now();
    if (cooldownLeft > 0) {
      this.logger.debug(`🐕 [AISHUB_CLIENT] forceReschedule ignorerad — auth-cooldown ${(cooldownLeft / 60000).toFixed(0)} min kvar`);
      return;
    }
    this.logger.log('🐕 [AISHUB_CLIENT] forceReschedule — bokar nästa poll (spärren respekteras)');
    this._scheduleNext(1000);
  }

  /**
   * @returns {boolean} true om källan levererat välformat svar nyligen
   */
  getConnectionStatus() {
    return this.isConnected;
  }

  /**
   * Anslutningsstatistik — samma basfält som AISStreamClient plus
   * pollspecifika räknare (dedupSize krävs av soakens leakDiagnostics:
   * ALLTID tal, aldrig null).
   * @returns {object}
   */
  getConnectionStats() {
    return {
      isConnected: this.isConnected,
      reconnectAttempts: this._failStreak,
      lastMessageTime: this.lastMessageTime,
      uptime: this.openedAt ? Date.now() - this.openedAt : 0,
      timeSinceLastMessage: this.lastMessageTime ? Date.now() - this.lastMessageTime : null,
      dedupSize: this._dedup.size,
      lastOkResponseAt: this._lastOkResponseAt,
      backoffMs: this._backoffMs ?? 0,
      // V6: auth-pausens läge måste synas i hälsoraden — annars ser en
      // sovande källa exakt ut som en tyst kanal (gamla räknare, backoffMs=0).
      authCooldownUntil: this._authCooldownUntil || null,
      authCooldownMsLeft: Math.max(0, this._authCooldownUntil - Date.now()),
      counters: { ...this._counters },
    };
  }

  // ==========================================================================
  // Poll-kedjan
  // ==========================================================================

  /** @private */
  _jitter() {
    return Math.floor(Math.random() * this._cfg.POLL_JITTER_MS);
  }

  /** @private */
  _maskedUser() {
    const u = this.username || '';
    return u.length <= 3 ? `${u}***` : `${u.slice(0, 3)}***`;
  }

  /** @private */
  _readLastPollAt() {
    if (this._settings && typeof this._settings.get === 'function') {
      const v = Number(this._settings.get(this._cfg.LAST_POLL_SETTINGS_KEY));
      return Number.isFinite(v) ? v : 0;
    }
    return this._memLastPollAt;
  }

  /** @private */
  _persistLastPollAt(ts) {
    this._memLastPollAt = ts;
    if (this._settings && typeof this._settings.set === 'function') {
      try {
        this._settings.set(this._cfg.LAST_POLL_SETTINGS_KEY, ts);
      } catch (err) {
        // Persistensen är bältet — in-memory-spärren håller ändå kadensen
        // under processens livstid.
        this.logger.debug(`🔧 [AISHUB_CLIENT] Kunde inte persistera poll-spärren: ${err.message}`);
      }
    }
  }

  /**
   * Boka nästa poll. ENDA stället som sätter _pollTimer.
   * @private
   */
  _scheduleNext(waitMs) {
    if (this._stopped) return;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = setTimeout(() => {
      this._pollTimer = null;
      this._poll().catch((err) => {
        // _poll fångar allt internt och bokar i finally — detta är bältet+
        // hängslen: kedjan får ALDRIG dö ens på en oväntad synkron bugg.
        this.logger.error('❌ [AISHUB_CLIENT] Oväntat fel i pollkedjan:', err.message || err);
        this._scheduleNext(this._cfg.POLL_INTERVAL_MS + this._jitter());
      });
    }, Math.max(0, waitMs));
  }

  /**
   * En poll. Single-flight; ombokning sker ovillkorligt i finally.
   * @private
   */
  async _poll() {
    if (this._stopped) return;
    if (this._inFlight) return; // pågående poll bokar nästa i sin finally

    const now = Date.now();
    // V6: auth-cooldownen kontrolleras HÄR, inte bara i schemaläggningen —
    // forceReschedule, en dubbelbokad timer eller en klockjustering ska aldrig
    // kunna slinka förbi pausen. Ombokning (aldrig return utan ombokning) så
    // kedjan lever vidare och återupptas av sig själv när pausen är slut.
    const cooldownLeft = this._authCooldownUntil - now;
    if (cooldownLeft > 0) {
      this.logger.debug(`⏸️ [AISHUB_CLIENT] Auth-cooldown aktiv — nästa försök om ${(cooldownLeft / 60000).toFixed(0)} min`);
      this._scheduleNext(cooldownLeft + this._jitter());
      return;
    }

    const last = this._readLastPollAt();
    const since = now - last;
    if (since < this._cfg.MIN_POLL_SPACING_MS) {
      // Spärrad (annan enhet/omstart/klockjustering): boka om — en return
      // utan ombokning dödar kedjan permanent (V2-C1).
      const wait = (this._cfg.MIN_POLL_SPACING_MS - since) + Math.floor(Math.random() * 2000);
      this.logger.debug(`⏳ [AISHUB_CLIENT] Poll-spärr aktiv — bokar om ${(wait / 1000).toFixed(1)}s`);
      this._scheduleNext(wait);
      return;
    }

    this._inFlight = true;
    this._persistLastPollAt(now); // FÖRE requesten (V2-C2)
    this._counters.polls++;
    let nextWaitMs = this._cfg.POLL_INTERVAL_MS + this._jitter();
    const httpStartedAt = Date.now();
    try {
      const res = await this._httpGet(this._buildUrl());
      nextWaitMs = this._handleHttpResult(res, Date.now() - httpStartedAt);
    } catch (err) {
      nextWaitMs = this._handleNetError(err);
    } finally {
      this._inFlight = false;
      if (!this._stopped) this._scheduleNext(nextWaitMs);
    }
  }

  /** @private */
  _buildUrl() {
    const {
      NORTH, SOUTH, EAST, WEST,
    } = AIS_CONFIG.BOUNDING_BOX;
    return `${this._cfg.BASE_URL}`
      + `?username=${encodeURIComponent(this.username)}`
      + '&format=1&output=json&compress=0'
      + `&latmin=${SOUTH}&latmax=${NORTH}&lonmin=${WEST}&lonmax=${EAST}`
      + `&interval=${this._cfg.INTERVAL_MINUTES}`;
  }

  /**
   * HTTPS GET med timeout, storlekstak och EXAKT en same-host-redirect.
   * Överskrivbar i tester (jest ersätter hela metoden).
   * @private
   * @param {string} url
   * @param {boolean} isRedirect - true på det (enda tillåtna) andra hoppet
   * @returns {Promise<{statusCode: number, body: string}>}
   */
  _httpGet(url, isRedirect = false) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        timeout: this._cfg.HTTP_TIMEOUT_MS,
        headers: { 'Accept-Encoding': 'identity' },
      }, (res) => {
        const { statusCode } = res;
        // En redirect till SAMMA host följs (en gång); cross-host avvisas —
        // credentialbärande query-strängar får inte läcka till tredje part.
        if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
          res.resume();
          if (isRedirect) {
            reject(new Error('AISHub: mer än en redirect'));
            return;
          }
          let target;
          try {
            target = new URL(res.headers.location, url);
          } catch (e) {
            reject(new Error('AISHub: oparsbar redirect-location'));
            return;
          }
          if (target.host !== new URL(url).host) {
            reject(new Error(`AISHub: cross-host-redirect avvisad (${target.host})`));
            return;
          }
          resolve(this._httpGet(target.toString(), true));
          return;
        }
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > this._cfg.MAX_BODY_BYTES) {
            req.destroy(new Error('AISHub: svar överskrider storlekstaket'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => {
        req.destroy(new Error('AISHub: HTTP-timeout'));
      });
      req.on('error', reject);
    });
  }

  // ==========================================================================
  // Svarshantering (felmatrisen, slutplanen §7)
  // ==========================================================================

  /**
   * @private
   * @returns {number} nästa väntetid (ms)
   */
  _handleHttpResult(res, httpMs) {
    const { statusCode, body } = res;

    // Poll-inspelning (etapp 3, V3-M5): rå svarsfångst för framtida
    // poll-nivåkorpusar. Gatad som replay-fångsten (debug_level='full'
    // eller env) + storlekstak — ogated hade ~2 MB/dygn spammat apploggen.
    this._capturePollSample(statusCode, body, httpMs);

    if (statusCode === 401 || statusCode === 403) {
      this._counters.authFail++;
      this._logFirstOccurrence(`HTTP ${statusCode}`);
      return this._noteAuthFailure(
        `HTTP ${statusCode}`,
        `HTTP ${statusCode} från AISHub — kontrollera AISHub-användarnamnet och din stationsstatus`,
      );
    }

    if (statusCode !== 200) {
      this._counters.httpErrors++;
      this._logFirstOccurrence(`HTTP ${statusCode}`);
      return this._failureTick('httpError', `HTTP ${statusCode}`);
    }

    const parsed = aishubParser.parseEnvelope(body);
    switch (parsed.kind) {
      case 'empty-body':
        // Rate-limit-signaturen ("will return nothing") ELLER tom felsida.
        // Backa av — ALDRIG snabbare retry.
        this._counters.emptyResponses++;
        this.logger.log('⚠️ [AISHUB_CLIENT] Tomt svar (rate-limit-signaturen?) — backar av');
        return this._failureTick('emptyResponse');

      case 'error-record': {
        this._counters.errorRecords++;
        this._logFirstOccurrence(parsed.errorMessage);
        // D1-lärdomen (AISStreamClient.js:368-mönstret): klassa på texten —
        // bara access-/kontorelaterade fel är auth-error; resten serverfel.
        const isAuth = /user(name)?|access|denied|not allowed|invalid|subscri/i.test(parsed.errorMessage);
        if (isAuth) {
          // GRANSKNINGSRUNDA 2 (2026-08-03): DETTA är AISHubs DOKUMENTERADE
          // felväg — HTTP 200 med kuvertet [{ERROR:true, ERROR_MESSAGE:…}],
          // vilket aishubParsers eget kontraktsblock slår fast. V6 härdade
          // bara 401/403-grenen, som under hela fältprovet (529 pollar, 529×
          // HTTP 200, authFail=0) aldrig exekverade en enda gång. Följden: ett
          // nekat konto pollade vidare 288 ggr/dygn i evighet och emitterade
          // auth-error vid VARJE poll — exakt den ws.php-belastning och den
          // notisspam cooldownen finns för att undvika. Access-klassade
          // error-records räknas därför i SAMMA auth-maskineri.
          this._counters.authFail++;
          return this._noteAuthFailure(
            parsed.errorMessage,
            `${parsed.errorMessage} — kontrollera AISHub-användarnamnet och din stationsstatus`,
          );
        }
        this.emit('server-error', parsed.errorMessage);
        return this._failureTick('errorRecord');
      }

      case 'format-mismatch':
        this._counters.formatMismatch++;
        // Formatbyte = varje post vore feltolkad (koordinater ×600000).
        // Logga rått meta direkt — detta ska aldrig kunna passera tyst.
        this.logger.error(`❌ [AISHUB_CLIENT] FORMAT-mismatch (väntade HUMAN): ${JSON.stringify(parsed.meta)}`);
        this.emit('server-error', `AISHub FORMAT-mismatch: ${JSON.stringify(parsed.meta)}`);
        return this._failureTick('formatMismatch');

      case 'parse-error':
        this._counters.parseErrors++;
        return this._failureTick('parseError', 'icke-JSON-svar (HTML-felsida?)');

      case 'envelope-error':
        this._counters.envelopeErrors++;
        return this._failureTick('envelopeError', 'kuvertet är inte [meta,[poster]]');

      case 'data':
      default:
        return this._handleGoodEnvelope(parsed, httpMs);
    }
  }

  /**
   * Välformat svar (ERROR:false) — även tomt fartygssvep räknas som kontakt.
   * @private
   * @returns {number} nästa väntetid (ms)
   */
  _handleGoodEnvelope(parsed, httpMs) {
    const now = Date.now();
    this._lastOkResponseAt = now;
    this._failStreak = 0;
    this._authFailCount = 0;
    // V6: accessen är tillbaka — släpp pausen och rusta engångsnotisen för en
    // eventuell NY episod (annars vore en andra riktig utestängning tyst).
    if (this._authCooldownUntil) {
      this.logger.log('✅ [AISHUB_CLIENT] Auth-cooldown upphävd — AISHub svarar igen');
      this._authCooldownUntil = 0;
    }
    this._authNotified = false;
    this._backoffMs = null; // servern mår bra — åter till baskadens
    this._flankUp();

    const { stats } = parsed;
    this._counters.timeParseFail += stats.timeParseFail;
    this._counters.sentinelPos += stats.sentinelPos;
    this._counters.invalidMmsi += stats.invalidMmsi;
    if (stats.recordCountMismatch) {
      this._counters.recordCountMismatch++;
      this.logger.log(`⚠️ [AISHUB_CLIENT] RECORDS-mismatch: deklarerat ${parsed.meta.RECORDS}, fick ${stats.records}`);
    }

    // TIME-larmet: ALLT föll 3 svep i rad ⇒ formatdrift — engångsnotis via
    // server-error (V2-M1). Larmet återställs av ett svep som parsar.
    if (stats.records > 0 && stats.timeParseFail === stats.records) {
      this._timeParseFailStreak++;
      if (this._timeParseFailStreak >= 3 && !this._timeParseAlarmed) {
        this._timeParseAlarmed = true;
        this.logger.error('❌ [AISHUB_CLIENT] TIME-parsning misslyckas för SAMTLIGA poster (3 svep i rad) — formatdrift?');
        this.emit('server-error', 'AISHub TIME-format oparsbart för samtliga poster (3 svep i rad)');
      }
    } else {
      this._timeParseFailStreak = 0;
      this._timeParseAlarmed = false;
    }

    if (stats.records === 0) {
      this._counters.emptySweeps++;
      // Tom kanal är normalt (nattetid) — lastMessageTime uppdateras INTE
      // (feed-vakterna förblir positionsdrivna, AISStreamClient-pariteten).
      this.logger.debug('🔧 [AISHUB_CLIENT] Tomt fartygssvep (ERROR:false, 0 poster)');
      return this._cfg.POLL_INTERVAL_MS + this._jitter();
    }

    // Boxfilter (bälte+hängslen — servern filtrerar redan på bbox-parametrarna)
    // + dedup (mmsi, fixTs): re-levererade fix i nästa poll släpps här.
    const {
      NORTH, SOUTH, EAST, WEST,
    } = AIS_CONFIG.BOUNDING_BOX;
    const fresh = [];
    // Fältprov 1 (2026-08-02): PER-SVEP-räknare i telemetriraden. Tidigare
    // loggades livstidsräknarna på samma rad som per-svep-talen ("records=10
    // accepted=4 dupes=39" — omöjlig att läsa), vilket gjorde dupe-kvoten —
    // halva etapp 4-kalibreringens underlag — oanvändbar. Livstidstotalerna
    // finns kvar i getConnectionStats().counters.
    let sweepDupes = 0;
    let sweepOutOfBox = 0;
    for (const rec of parsed.records) {
      if (rec.lat < SOUTH || rec.lat > NORTH || rec.lon < WEST || rec.lon > EAST) {
        this._counters.outOfBox++;
        sweepOutOfBox++;
        continue;
      }
      const lastFix = this._dedup.get(rec.mmsi);
      if (Number.isFinite(lastFix) && rec.fixTs <= lastFix) {
        this._counters.dupes++;
        sweepDupes++;
        continue;
      }
      this._dedup.set(rec.mmsi, rec.fixTs);
      fresh.push(rec);
    }
    this._pruneDedup(now);

    // Telemetri (📊 [AISHUB_POLL], slutplanen §7): fixåldrar på accepterade.
    const ages = fresh.map((r) => now - r.fixTs).sort((a, b) => a - b);
    const median = ages.length ? ages[Math.floor(ages.length / 2)] : null;
    const p90 = ages.length ? ages[Math.min(ages.length - 1, Math.floor(ages.length * 0.9))] : null;
    this.logger.log(
      `📊 [AISHUB_POLL] records=${stats.records} accepted=${fresh.length} `
      + `dupes=${sweepDupes} outOfBox=${sweepOutOfBox} httpMs=${httpMs} `
      + `medianFixAgeMs=${median ?? '-'} p90FixAgeMs=${p90 ?? '-'} `
      + `dupesTotal=${this._counters.dupes} outOfBoxTotal=${this._counters.outOfBox}`,
    );

    // Batchspridning: i*150 ms — nedströms ska aldrig se en syntetisk storm.
    fresh.forEach((rec, i) => {
      const timer = setTimeout(() => {
        this._emitTimers.delete(timer);
        if (this._stopped) return;
        this._counters.accepted++;
        // Namnet FÖRE positionen (B1-mönstret: Class B-namn får inte vänta
        // på nästa statiska rapport).
        if (rec.shipName && rec.shipName !== 'Unknown') {
          this.emit('static-name', { mmsi: rec.mmsi, shipName: rec.shipName });
        }
        this.lastMessageTime = Date.now();
        this.emit('ais-message', { ...rec, timestamp: Date.now() });
      }, i * this._cfg.EMIT_SPREAD_MS);
      this._emitTimers.add(timer);
    });

    return this._cfg.POLL_INTERVAL_MS + this._jitter();
  }

  /** @private */
  _pruneDedup(now) {
    const ttl = this._cfg.MAX_FIX_AGE_MS + 60000;
    for (const [mmsi, fixTs] of this._dedup) {
      if (now - fixTs > ttl) this._dedup.delete(mmsi);
    }
    // FYND 15 (A/B-natten 2026-08-03): taket prunade FIFO på insättnings-
    // ordning (Map.keys().next()), alltså det fartyg som spårats LÄNGST —
    // typiskt en aktiv trafikant som fortfarande levererar, medan en nyss
    // insatt engångsbekantskap fick ligga kvar. Att tappa dedup-posten för ett
    // aktivt fartyg betyder att nästa polls RE-LEVERANS av samma fix släpps
    // igenom som ny. Evictera i stället på ÄLDST KÄNDA FIX (samma ordning som
    // TTL-grenen ovan städar i): posten som ändå står näst på tur. Ofarligt
    // vid dedupSize 7 av 2000 men fel så fort bbox:en vidgas.
    // Sorteringen är stabil ⇒ lika fixTs faller tillbaka på insättningsordning.
    if (this._dedup.size > this._cfg.DEDUP_MAX_ENTRIES) {
      const byAge = [...this._dedup.entries()].sort((a, b) => a[1] - b[1]);
      let over = this._dedup.size - this._cfg.DEDUP_MAX_ENTRIES;
      for (const [mmsi] of byAge) {
        if (over <= 0) break;
        this._dedup.delete(mmsi);
        over--;
      }
    }
  }

  /**
   * @private
   * @returns {number} nästa väntetid (ms)
   */
  _handleNetError(err) {
    this._counters.netErrors++;
    this.logger.error('❌ [AISHUB_CLIENT] Nätverksfel:', err.message || err);
    this.emit('error', err);
    return this._failureTick('netError');
  }

  /**
   * V6: gemensam hantering av ETT auth-avslag, oavsett om det kom som HTTP
   * 401/403 eller som access-klassad error-record i ett HTTP 200-kuvert.
   *
   * Kontraktet: EN användarnotis per episod, och efter AUTH_FAIL_STOP avslag
   * en LÅNG paus (aldrig ett permanent stopp). Flaggan och räknaren släpps
   * först av ett välformat svar, så en NY episod notifierar på nytt.
   * @private
   * @param {string} label - kort etikett för loggen
   * @param {string} userMessage - texten som går vidare till användarnotisen
   * @returns {number} nästa väntetid (ms)
   */
  _noteAuthFailure(label, userMessage) {
    this._authFailCount++;
    if (!this._authNotified) {
      this._authNotified = true;
      this.emit('auth-error', userMessage);
    }
    if (this._authFailCount >= this._cfg.AUTH_FAIL_STOP) {
      // V6 (A/B-natten 2026-08-03): PAUS, inte död. Tidigare sattes
      // _stopped = true här och ingen kodväg återupplivade klienten utan
      // appomstart/username-byte — ett övergående 403 slog ut andrakällan
      // för processens livstid.
      const cooldownMs = this._cfg.AUTH_COOLDOWN_MS;
      this._authCooldownUntil = Date.now() + cooldownMs;
      // Räknarna nollställs så nästa fönster kräver AUTH_FAIL_STOP NYA fel
      // innan en ny paus. _failStreak MÅSTE med (granskningsrunda 2): utan
      // den nollställningen stod streaken kvar på 4 över pausen, och den
      // FÖRSTA pollen efter varje cooldown föll rakt in i _failureTick:s
      // "≥3 raka" ⇒ ett server-error per 6:e timme ⇒ minst ett per
      // 24h-dedupfönster ⇒ en VILSELEDANDE pushnotis om dygnet, för evigt
      // ("serverfel … fortsätter polla med backoff" — fel diagnos OCH
      // faktafel, kedjan är pausad).
      this._authFailCount = 0;
      this._failStreak = 0;
      this.logger.error(
        `❌ [AISHUB_CLIENT] ${label} × ${this._cfg.AUTH_FAIL_STOP} — pausar pollandet `
        + `${(cooldownMs / 3600000).toFixed(1)} h (återupptas automatiskt; kontrollera username/stationsstatus)`,
      );
      this._flankDown('auth');
      return cooldownMs;
    }
    return this._failureTick('authFail');
  }

  /**
   * Gemensam felbokföring: streak, disconnected-flank, backoff.
   * @private
   * @returns {number} nästa väntetid (ms) — alltid ≥ baskadens
   */
  _failureTick(kind, detail = null) {
    this._failStreak++;
    if (detail) {
      this.logger.log(`⚠️ [AISHUB_CLIENT] ${kind}: ${detail} (streak ${this._failStreak})`);
    }
    // AUTH har EGEN kanal (auth-error, en gång per episod) och egen paus —
    // ett generiskt "serverfel (t.ex. tillfällig överbelastning)" ovanpå det
    // är fel diagnos för användaren och dubbelnotifiering av samma händelse.
    if (this._failStreak >= 3 && kind !== 'authFail') {
      this.emit('server-error', `AISHub: ${this._failStreak} raka misslyckade pollar (${kind})`);
    }
    const now = Date.now();
    const silentTooLong = this._lastOkResponseAt !== null
      && now - this._lastOkResponseAt > this._cfg.SILENT_FEED_MS;
    if (this.isConnected
        && (this._failStreak >= this._cfg.ERROR_STREAK_DISCONNECT || silentTooLong)) {
      this._flankDown(kind);
    }
    // Backoff: fördubbla, tak 300 s. ALDRIG under baskadens.
    this._backoffMs = Math.min(
      (this._backoffMs ?? this._cfg.POLL_INTERVAL_MS) * 2,
      this._cfg.BACKOFF_MAX_MS,
    );
    return this._backoffMs;
  }

  /** @private */
  _flankUp() {
    if (this.isConnected) return;
    this.isConnected = true;
    this.openedAt = Date.now();
    this.logger.log('✅ [AISHUB_CLIENT] Kontakt med AISHub etablerad');
    this.emit('connected');
  }

  /** @private */
  _flankDown(reason) {
    if (!this.isConnected) return;
    this.isConnected = false;
    this.openedAt = null;
    this.logger.log(`🔌 [AISHUB_CLIENT] Kontakt förlorad (${reason})`);
    this.emit('disconnected', { code: 1006, reason: `aishub ${reason}` });
  }

  /**
   * Poll-inspelning för poll-nivåreplay (etapp 3, §8.6): en rad per svar,
   * '[AISHUB_RESPONSE_SAMPLE]' i apploggen (run-with-logs kan tee:a den)
   * och/eller append till AISHUB_POLL_CAPTURE_FILE. Body trunkeras till
   * 64 kB i loggraden (fil-fångsten tar hela svaret).
   * @private
   */
  _capturePollSample(statusCode, body, httpMs) {
    const captureFile = process.env.AISHUB_POLL_CAPTURE_FILE || null;
    const logEnabled = (this.logger && this.logger.debugLevel === 'full') || captureFile;
    if (!logEnabled) return;
    // Fältprov 1 (2026-08-02, KRITISKT sekretessfynd): AISHubs kuvert ekar
    // USERNAME i klartext — och usernamet ÄR autentiseringen (ws.php?username=).
    // Med debug_level=full hade rå-loggningen läckt det ~1300 ggr/dygn i
    // apploggen (som delas vid felsökning/korpusarkiv), samtidigt som
    // startraden medvetet maskerar till tre tecken. Maskera i BÅDA vägarna
    // (loggrad + fil) — poll-korpusreplay behöver aldrig usernamet.
    const masked = body
      ? body.replace(/"USERNAME"\s*:\s*"[^"]*"/g, '"USERNAME":"***"')
      : '';
    const sample = {
      pollAt: Date.now(),
      statusCode,
      httpMs,
      bodyBytes: body ? Buffer.byteLength(body, 'utf8') : 0,
      body: masked.length > 65536 ? `${masked.slice(0, 65536)}…[TRUNKERAD]` : masked,
    };
    this.logger.log('[AISHUB_RESPONSE_SAMPLE]', JSON.stringify(sample));
    if (captureFile) {
      const full = { ...sample, body: masked };
      fs.appendFile(captureFile, `${JSON.stringify(full)}\n`, (err) => {
        if (err && !this._captureErrorLogged) {
          this._captureErrorLogged = true;
          this.logger.error('⚠️ [AISHUB_CLIENT] Poll-fångsten kunde inte skrivas:', err.message);
        }
      });
    }
  }

  /**
   * Feltexter loggas ALLTID i sin helhet första gången de förekommer —
   * odokumenterade ERROR-strukturer ska aldrig kunna passera osedda (V2-M2).
   * @private
   */
  _logFirstOccurrence(text) {
    const key = String(text);
    if (this._seenErrorTexts.has(key)) return;
    this._seenErrorTexts.add(key);
    if (this._seenErrorTexts.size > 100) {
      // Bounded — behåll de första 100 distinkta texterna.
      this._seenErrorTexts.clear();
      this._seenErrorTexts.add(key);
    }
    this.logger.log(`🆕 [AISHUB_CLIENT] Ny feltext från AISHub (första förekomsten): ${key}`);
  }
}

module.exports = AISHubClient;
