'use strict';

const EventEmitter = require('events');
const AISStreamClient = require('./AISStreamClient');
const AISHubClient = require('./AISHubClient');
const FixFusionPolicy = require('./FixFusionPolicy');
const { AIS_CONFIG } = require('../constants');

/**
 * AISSourceMultiplexer - Fan-in för AIS-källor. app.js ska ALDRIG veta att
 * fler än en källa finns: muxen äger AISStreamClient (alltid) och en
 * AISHubClient (när aishub_username är konfigurerat), och emittar exakt
 * samma nio events som AISStreamClient gör idag.
 *
 * LÄGEN (ais_source, effektiv konfiguration via applySourceConfig):
 *   'aisstream' (default/frånvaro) — REN PASS-THROUGH: noll grindar, noll
 *        fusionsstate, noll timers. Befintliga användare får exakt dagens
 *        beteende (etapp 2-garantin: bit-identiska replay-facit).
 *   'shadow'  — AISHub pollar, parsas, dedupas och JÄMFÖRS (🔭
 *        [SHADOW_COMPARE] var 5:e minut) men inte en enda AISHub-fix släpps
 *        vidare till pipelinen. Beviset för responsivitetsvinsten.
 *   'both'    — dubbelkälla: varje fix passerar FixFusionPolicy F1-F5;
 *        färskaste fix per källa vinner, korskälle-dubbletter trycks undan,
 *        källbyten flaggas (feedSwitch). Failover är EMERGENT: dör en källa
 *        slutar dess fixar komma — ingen omkopplingskod, ingen flapp-risk.
 *   'aishub'  — solo-poll: aisstream-barnet kopplas ner.
 *
 * KONTRAKT MOT app.js (slutplanen §3, V1-M1):
 *   isConnected är en LEVANDE GETTER (app.js:6746 läser propertyn — en
 *   metod/stats-fält hade tyst avväpnat B2-watchdogen), och
 *   getConnectionStats() bär perFeed-uppslag så feed-watchdogen kan läsa
 *   per källa i stället för aggregatet (V1-C2: aggregatets
 *   timeSinceLastMessage=min hålls annars permanent färskt av 65s-pollen
 *   och "aisstream-socket lever men levererar noll" blir odetekterbar).
 */
class AISSourceMultiplexer extends EventEmitter {
  /**
   * @param {object} logger - App-instansen (log/debug/error)
   * @param {object|null} settingsStore - homey.settings ({get,set}) för
   *        AISHub-klientens persisterade poll-spärr; null i enkla tester.
   */
  constructor(logger, settingsStore = null) {
    super();
    this.logger = logger;
    this._settings = settingsStore;

    this._config = { source: 'aisstream', apiKey: null, aishubUsername: null };
    this._activeConfigKey = null;

    // Disposed-vakten: _reconcile är async och dess fortsättning (efter
    // await) kan landa EFTER disconnect() — utan vakten kunde en sen
    // mikrotask skapa hub-barn/skuggtimer på en redan nedstängd mux
    // (föräldralös 5-min-interval; upptäckt som testworker-häng, men samma
    // race finns i produktion: onUninit tätt efter en settings-ändring).
    this._disposed = false;

    // aisstream-barnet finns ALLTID (pass-through-defaulten).
    this._streamClient = new AISStreamClient(logger);
    this._streamActive = false;
    this._bindStreamChild();

    // AISHub-barnet skapas först när en aishub-källa är konfigurerad.
    this._hubClient = null;

    // Aggregerad anslutningsflank (Bug#12: emittera ALDRIG per barnhändelse).
    this._aggConnected = false;

    // Fusionsstate ('both'-läget) — per-MMSI, prunas i monitoring-takt.
    this._fusionStates = new Map();
    this._fusionCfg = AIS_CONFIG.FUSION;
    this._fusionStats = {
      accepted: 0, rejected: 0, feedSwitches: 0, byReason: {},
    };

    // Skuggjämförelsen ('shadow'/'both'): fönsterdata + positionsindex.
    this._shadowTimer = null;
    this._shadowPosIndex = new Map(); // "mmsi:lat5:lon5" → aisstream-mottagnings-ts
    this._resetShadowWindow();
  }

  // ==========================================================================
  // Publika styrytan (samma form som AISStreamClient + applySourceConfig)
  // ==========================================================================

  /**
   * LEVANDE getter (V1-M1) — app.js:6746 läser propertyn direkt.
   * @returns {boolean}
   */
  get isConnected() {
    return this._computeConnected();
  }

  /**
   * @returns {boolean}
   */
  getConnectionStatus() {
    return this._computeConnected();
  }

  /**
   * Aggregerad statistik + perFeed-uppslag (feed-watchdogens sanning).
   * @returns {object}
   */
  getConnectionStats() {
    const stream = this._streamActive ? this._streamClient.getConnectionStats() : null;
    const hub = this._hubClient ? this._hubClient.getConnectionStats() : null;
    // Fältprov 1 (2026-08-02): AGGREGATET speglar enbart pipeline-matande
    // källor (se _computeConnected). I skuggläge exkluderas hubbens färskhet
    // — annars höll 65s-pollen aggregatets timeSinceLastMessage permanent
    // färsk och stale-vakterna i app.js var avväpnade exakt när de behövdes.
    // perFeed nedan bär ALLTID råvärdena (feed-watchdogens sanning).
    const hubFeeds = this._hubFeedsPipeline() ? hub : null;

    const nums = (arr) => arr.filter((v) => Number.isFinite(v));
    const maxOf = (arr) => (nums(arr).length ? Math.max(...nums(arr)) : 0);
    const minOfNullable = (arr) => (nums(arr).length ? Math.min(...nums(arr)) : null);
    const lastMsgCandidates = nums([stream?.lastMessageTime, hubFeeds?.lastMessageTime]);

    return {
      isConnected: this._computeConnected(),
      reconnectAttempts: maxOf([stream?.reconnectAttempts, hubFeeds?.reconnectAttempts]),
      lastMessageTime: lastMsgCandidates.length ? Math.max(...lastMsgCandidates) : null,
      uptime: maxOf([stream?.uptime, hubFeeds?.uptime]),
      timeSinceLastMessage: minOfNullable([stream?.timeSinceLastMessage, hubFeeds?.timeSinceLastMessage]),
      perFeed: {
        aisstream: {
          configured: this._streamActive,
          isConnected: this._streamActive ? this._streamClient.isConnected : false,
          lastMessageTime: stream ? stream.lastMessageTime : null,
          timeSinceLastMessage: stream ? stream.timeSinceLastMessage : null,
          uptime: stream ? stream.uptime : 0,
          reconnectAttempts: stream ? stream.reconnectAttempts : 0,
        },
        aishub: {
          configured: !!this._hubClient,
          isConnected: this._hubClient ? this._hubClient.isConnected : false,
          lastMessageTime: hub ? hub.lastMessageTime : null,
          timeSinceLastMessage: hub ? hub.timeSinceLastMessage : null,
          uptime: hub ? hub.uptime : 0,
          lastOkResponseAt: hub ? hub.lastOkResponseAt : null,
          lastPollStartedAt: this._hubClient ? this._hubClient._memLastPollAt || null : null,
          dedupSize: hub ? hub.dedupSize : 0,
          counters: hub ? hub.counters : null,
        },
      },
      fusion: {
        stateSize: this._fusionStates.size,
        ...this._fusionStats,
      },
    };
  }

  /**
   * Starta källorna enligt aktuell konfiguration. apiKey lagras som
   * aisstream-credential (kan vara null i solo-AISHub).
   * @param {string|null} apiKey
   * @returns {Promise<void>}
   */
  async connect(apiKey) {
    this._disposed = false; // nytt liv efter ev. tidigare disconnect
    if (apiKey != null) this._config.apiKey = String(apiKey).trim() || null;
    this._activeConfigKey = this._configKey();
    await this._reconcile();
  }

  /**
   * aisstream-nyckelbyte: fan-out till stream-barnet (AISHub berörs inte —
   * dess credential är username, hanteras av applySourceConfig).
   * @param {string} apiKey
   * @returns {Promise<void>}
   */
  reconnectWithKey(apiKey) {
    this._config.apiKey = String(apiKey || '').trim() || null;
    this._activeConfigKey = this._configKey();
    if (!this._config.apiKey) {
      if (this._streamActive) {
        this._streamActive = false;
        this._streamClient.disconnect();
      }
      return Promise.resolve();
    }
    if (this._sourceWantsStream()) {
      this._streamActive = true;
      return this._streamClient.reconnectWithKey(this._config.apiKey);
    }
    return Promise.resolve();
  }

  /**
   * Total nedstängning (onUninit-vägen) — båda barnen + alla timers.
   */
  disconnect() {
    this._disposed = true;
    this._stopShadowTimer();
    if (this._streamActive) {
      this._streamActive = false;
      this._streamClient.disconnect();
    } else {
      // disconnect() på ett aldrig startat stream-barn är ofarligt men
      // spammigt — hoppa över.
    }
    this._teardownHub();
    // Aggregatflanken: barnens disconnected-event har redan triggat
    // _recomputeAggregate, men var defensiv om barnen var stubbade.
    if (this._aggConnected) {
      this._aggConnected = false;
      this.emit('disconnected', { code: 1000, reason: 'intentional disconnect' });
    }
  }

  /**
   * Idempotent konfigurationsapplicering (V2-m2): identisk effektiv config
   * ⇒ ingen sidoeffekt. Ändrad config ⇒ riv/skapa barn kontrollerat, ALDRIG
   * en omedelbar poll som sidoeffekt (AISHub-klientens connect respekterar
   * den persisterade spärren + startjitter).
   * @param {{source?: string, apiKey?: string|null, aishubUsername?: string|null}} cfg
   */
  applySourceConfig(cfg = {}) {
    const allowed = ['aisstream', 'shadow', 'both', 'aishub'];
    const next = {
      source: allowed.includes(cfg.source) ? cfg.source : 'aisstream',
      apiKey: (cfg.apiKey != null ? String(cfg.apiKey).trim() : this._config.apiKey) || null,
      aishubUsername: (cfg.aishubUsername != null
        ? String(cfg.aishubUsername).trim()
        : this._config.aishubUsername) || null,
    };
    // Fallback-regeln (konfigmatrisen): aishub-lägen utan username ⇒
    // aisstream — aldrig en tyst död källkonfiguration.
    if (next.source !== 'aisstream' && !next.aishubUsername) {
      this.logger.log(`⚠️ [AIS_MUX] ais_source='${next.source}' utan aishub_username — faller tillbaka till 'aisstream'`);
      next.source = 'aisstream';
    }
    const key = `${next.source}|${next.apiKey || ''}|${next.aishubUsername || ''}`;
    if (key === this._activeConfigKey) {
      this.logger.debug('🔧 [AIS_MUX] applySourceConfig: oförändrad effektiv konfiguration — no-op');
      return;
    }
    const prev = this._config;
    this._config = next;
    this._activeConfigKey = key;
    this._disposed = false; // ny konfiguration = nytt liv
    this.logger.log(
      `🔀 [AIS_MUX] Källkonfiguration: source=${next.source} `
      + `aisstream=${next.apiKey ? 'nyckel satt' : 'ingen nyckel'} `
      + `aishub=${next.aishubUsername ? 'username satt' : 'ej konfigurerad'}`,
    );
    this._reconcile(prev).catch((err) => {
      this.logger.error('❌ [AIS_MUX] Källomställning misslyckades:', err.message || err);
    });
  }

  /**
   * Testbar ingång (V3-C1): REPLAY_FUSION-läget och enhetstester matar
   * meddelanden här — EXAKT samma väg som barnens live-events tar.
   * @param {'aisstream'|'aishub'} feed
   * @param {object} msg - Normaliserat AIS-meddelande
   */
  _ingestFromFeed(feed, msg) {
    this._onChildMessage(feed, msg);
  }

  /**
   * Feed-vaktens AISHub-kick — vidare till klientens forceReschedule()
   * som aldrig kan bryta 61s-spärren.
   */
  kickAishub() {
    if (this._hubClient && typeof this._hubClient.forceReschedule === 'function') {
      this._hubClient.forceReschedule();
    }
  }

  // ==========================================================================
  // Intern wiring
  // ==========================================================================

  /** @private */
  _sourceWantsStream() {
    return this._config.source !== 'aishub';
  }

  /** @private */
  _sourceWantsHub() {
    return this._config.source !== 'aisstream' && !!this._config.aishubUsername;
  }

  /** @private */
  _hubFeedsPipeline() {
    return this._config.source === 'both' || this._config.source === 'aishub';
  }

  /** @private */
  _configKey() {
    return `${this._config.source}|${this._config.apiKey || ''}|${this._config.aishubUsername || ''}`;
  }

  /**
   * Få verkligheten att matcha konfigurationen.
   * @private
   */
  async _reconcile(prev = {}) {
    if (this._disposed) return;
    const wantStream = this._sourceWantsStream() && !!this._config.apiKey;
    const wantHub = this._sourceWantsHub();

    // aisstream-barnet
    if (wantStream && !this._streamActive) {
      this._streamActive = true;
      await this._streamClient.connect(this._config.apiKey).catch((err) => {
        this.logger.error('❌ [AIS_MUX] aisstream-anslutning misslyckades:', err.message || err);
      });
    } else if (!wantStream && this._streamActive) {
      this._streamActive = false;
      this._streamClient.disconnect();
    } else if (wantStream && prev.apiKey && prev.apiKey !== this._config.apiKey) {
      await this._streamClient.reconnectWithKey(this._config.apiKey).catch((err) => {
        this.logger.error('❌ [AIS_MUX] aisstream-nyckelbyte misslyckades:', err.message || err);
      });
    }

    // AISHub-barnet: username-/lägesbyte ⇒ riv och återskapa (disconnect
    // rensar _pollTimer FÖRE ny instansiering — aldrig dubbla kedjor).
    const hubCredChanged = this._hubClient && prev.aishubUsername
      && prev.aishubUsername !== this._config.aishubUsername;
    if ((!wantHub && this._hubClient) || hubCredChanged) {
      this._teardownHub();
    }
    // Disposed-vakt efter varje await-gräns: disconnect() kan ha kört medan
    // stream-grenen ovan suspenderade — inga nya barn/timers därefter.
    if (this._disposed) return;
    if (wantHub && !this._hubClient) {
      this._hubClient = new AISHubClient(this.logger, this._settings);
      this._bindHubChild();
      await this._hubClient.connect(this._config.aishubUsername);
    }

    // Skuggtelemetrin: endast i shadow/both — pass-through har NOLL timers.
    if (this._disposed) {
      this._teardownHub(); // barnet ovan skapades tvärs över en disconnect
      return;
    }
    if (wantHub && (this._config.source === 'shadow' || this._config.source === 'both')) {
      this._startShadowTimer();
    } else {
      this._stopShadowTimer();
    }

    this._recomputeAggregate();
  }

  /** @private */
  _teardownHub() {
    if (!this._hubClient) return;
    try {
      this._hubClient.disconnect();
      this._hubClient.removeAllListeners();
    } catch (err) {
      this.logger.debug(`🔧 [AIS_MUX] hub-teardown: ${err.message}`);
    }
    this._hubClient = null;
    this._recomputeAggregate();
  }

  /** @private */
  _bindStreamChild() {
    const c = this._streamClient;
    c.on('ais-message', (msg) => this._onChildMessage('aisstream', msg));
    c.on('static-name', (data) => this._onChildStaticName('aisstream', data));
    c.on('connected', () => this._recomputeAggregate());
    c.on('disconnected', (info) => this._recomputeAggregate(info));
    c.on('error', (err) => this.emit('error', err, 'aisstream'));
    c.on('auth-error', (detail) => this.emit('auth-error', detail, 'aisstream'));
    c.on('server-error', (detail) => this.emit('server-error', detail, 'aisstream'));
    c.on('reconnect-needed', () => this.emit('reconnect-needed'));
    c.on('max-reconnects-reached', () => this.emit('max-reconnects-reached'));
  }

  /** @private */
  _bindHubChild() {
    const c = this._hubClient;
    c.on('ais-message', (msg) => this._onChildMessage('aishub', msg));
    c.on('static-name', (data) => this._onChildStaticName('aishub', data));
    c.on('connected', () => this._recomputeAggregate());
    c.on('disconnected', (info) => this._recomputeAggregate(info));
    c.on('error', (err) => this.emit('error', err, 'aishub'));
    c.on('auth-error', (detail) => this.emit('auth-error', detail, 'aishub'));
    c.on('server-error', (detail) => this.emit('server-error', detail, 'aishub'));
    // OBS: ingen reconnect-needed/max-reconnects-reached från pollkällan —
    // dess självläkning bor i poll-kedjan (finally-ombokning + backoff).
  }

  /** @private */
  _computeConnected() {
    // Fältprov 1 (2026-08-02, logg-granskningens KRITISKA fynd): endast
    // källor som MATAR PIPELINEN får räknas. I skuggläge kastar muxen varje
    // AISHub-fix — en levande skugg-poll fick tidigare aggregatet att se
    // "anslutet och färskt" ut medan appen i själva verket var datalös, och
    // stale-vakterna (UI_FEED_STALE_GUARD/VESSEL_REMOVAL_STALE_GUARD, som
    // läser aggregatets timeSinceLastMessage) kunde ALDRIG fyra → "Inga
    // båtar"-lögnen vid aisstream-avbrott. Samma princip för isConnected:
    // en skuggkälla ska inte tända grönt när inget dataflöde finns.
    const streamOk = this._streamActive && this._streamClient.isConnected;
    const hubOk = !!this._hubClient && this._hubClient.isConnected && this._hubFeedsPipeline();
    return streamOk || hubOk;
  }

  /**
   * Aggregerad flankemission (Bug#12/V1-M7): connected/disconnected
   * emitteras på AGGREGATETS 0→1/1→0 — aldrig per barnhändelse. Annars
   * flappar _lastConnectionLost och stale-overriden i app.js.
   * @private
   */
  _recomputeAggregate(disconnectInfo = null) {
    const now = this._computeConnected();
    if (now === this._aggConnected) return;
    this._aggConnected = now;
    if (now) {
      this.emit('connected');
    } else {
      this.emit('disconnected', disconnectInfo || { code: 1006, reason: 'all sources down' });
    }
  }

  /**
   * Namnnormalisering (V1-m5): appliceras på BÅDA källorna så samma fartyg
   * inte flappar mellan namnvarianter ("VALEN " vs "VALEN") — varje flapp
   * skriver hela namnkartan till settings via _rememberVesselName.
   * Sentinelen 'Unknown' bevaras EXAKT (versaliseras aldrig — appens
   * !== 'Unknown'-grindar bygger på literalen).
   * @private
   */
  _normalizeName(raw) {
    if (raw == null) return 'Unknown';
    const s = String(raw);
    if (s === 'Unknown') return s;
    const out = s.replace(/@/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
    return out || 'Unknown';
  }

  /** @private */
  _onChildStaticName(feed, data) {
    const shipName = this._normalizeName(data && data.shipName);
    if (!data || !data.mmsi || shipName === 'Unknown') return;
    // Skuggläget får inte påverka pipelinen — inte ens namncachen.
    if (feed === 'aishub' && !this._hubFeedsPipeline()) return;
    this.emit('static-name', { mmsi: data.mmsi, shipName });
  }

  /**
   * Kärnrouting: pass-through, skugga eller fusion — per läge och källa.
   * @private
   */
  _onChildMessage(feed, msg) {
    if (!msg) return;
    const normalized = { ...msg, shipName: this._normalizeName(msg.shipName) };

    // Skuggbokföring (shadow/both): jämförelsedata per källa.
    if (this._shadowTimer) this._recordShadowSample(feed, normalized);

    if (feed === 'aisstream') {
      if (this._config.source === 'both') {
        this._fuseAndEmit(normalized);
      } else {
        // Pass-through (aisstream/shadow/aishub-fallback): exakt dagens väg.
        this.emit('ais-message', normalized);
      }
      return;
    }

    // feed === 'aishub'
    if (this._config.source === 'shadow') {
      return; // aldrig vidare — beviset ska vara rent
    }
    if (this._config.source === 'both') {
      this._fuseAndEmit(normalized);
      return;
    }
    if (this._config.source === 'aishub') {
      // Solo-poll: klienten har redan dedupat (mmsi, fixTs) — släpp igenom.
      this.emit('ais-message', normalized);
    }
  }

  /**
   * F1-F5 ('both'-läget). Accepterade fixar emitteras med feedSwitch-flaggan
   * när källbytet ser ut som ett hopp (SystemCoordinator undantar den
   * globala jump-tallyn men behåller per-fartygs-koordinationen).
   * @private
   */
  _fuseAndEmit(msg) {
    const now = Date.now();
    let state = this._fusionStates.get(msg.mmsi);
    if (!state) {
      state = FixFusionPolicy.createState();
      this._fusionStates.set(msg.mmsi, state);
    }
    const verdict = FixFusionPolicy.shouldAccept(state, msg, now, this._fusionCfg);
    if (!verdict.accept) {
      this._fusionStats.rejected++;
      this._fusionStats.byReason[verdict.reason] = (this._fusionStats.byReason[verdict.reason] || 0) + 1;
      return;
    }
    FixFusionPolicy.applyAccept(state, msg, verdict.fixTs, now);
    this._fusionStats.accepted++;
    if (verdict.feedSwitch) {
      this._fusionStats.feedSwitches++;
      this._logFusionSwitch(msg.mmsi);
    }
    this.emit('ais-message', {
      ...msg,
      fixTs: verdict.fixTs,
      feedSwitch: verdict.feedSwitch === true,
    });
  }

  /** @private */
  _logFusionSwitch(mmsi) {
    // Rate-limited 1/mmsi/5 min (🔀 [FUSION_SWITCH], slutplanen §7).
    if (!this._fusionSwitchLogTimes) this._fusionSwitchLogTimes = new Map();
    const last = this._fusionSwitchLogTimes.get(mmsi) || 0;
    const now = Date.now();
    if (now - last < 5 * 60 * 1000) return;
    this._fusionSwitchLogTimes.set(mmsi, now);
    if (this._fusionSwitchLogTimes.size > 200) this._fusionSwitchLogTimes.clear();
    this.logger.log(`🔀 [FUSION_SWITCH] ${mmsi}: källbyte med positionssprång — feedSwitch flaggad (global jump-tally undantas)`);
  }

  /**
   * Prunas i monitoring-takt från app-lagret (samma mönster som övriga
   * kartor). Ofarlig no-op i pass-through (tomma strukturer).
   */
  pruneFusionState() {
    const removed = FixFusionPolicy.pruneStates(this._fusionStates, Date.now(), this._fusionCfg);
    if (removed > 0) {
      this.logger.debug(`🧹 [AIS_MUX] Fusionsstate prunat: ${removed} poster (kvar: ${this._fusionStates.size})`);
    }
    // Skuggindexet delar TTL-princip.
    if (this._shadowPosIndex.size > 500) {
      const surplus = this._shadowPosIndex.size - 500;
      const it = this._shadowPosIndex.keys();
      for (let i = 0; i < surplus; i++) this._shadowPosIndex.delete(it.next().value);
    }
  }

  // ==========================================================================
  // Skuggjämförelsen (🔭 [SHADOW_COMPARE], etapp 2)
  // ==========================================================================

  /** @private */
  _resetShadowWindow() {
    this._shadowWindow = {
      streamMmsi: new Set(),
      hubMmsi: new Set(),
      deltas: [],
      navstat: { aisstream: {}, aishub: {} },
    };
  }

  /** @private */
  _recordShadowSample(feed, msg) {
    const w = this._shadowWindow;
    const posKey = `${msg.mmsi}:${Number(msg.lat).toFixed(5)}:${Number(msg.lon).toFixed(5)}`;
    if (feed === 'aisstream') {
      w.streamMmsi.add(msg.mmsi);
      // Mottagningstid för exakt denna position — deltamätningens ankare.
      this._shadowPosIndex.set(posKey, Number.isFinite(msg.timestamp) ? msg.timestamp : Date.now());
    } else {
      w.hubMmsi.add(msg.mmsi);
      // Samma (mmsi, position) sedd via aisstream? Deltat
      // aisstream-mottagning − AISHub-TIME är DEN siffra som avgör om
      // AISHub är färskare i området (etapp 3:s GO-kriterium).
      const streamReceiptTs = this._shadowPosIndex.get(posKey);
      if (Number.isFinite(streamReceiptTs) && Number.isFinite(msg.fixTs)) {
        if (w.deltas.length < 2000) w.deltas.push(streamReceiptTs - msg.fixTs);
      }
    }
    const nav = msg.navStatus == null ? 'null' : String(msg.navStatus);
    w.navstat[feed][nav] = (w.navstat[feed][nav] || 0) + 1;
  }

  /** @private */
  _startShadowTimer() {
    if (this._shadowTimer) return;
    this._resetShadowWindow();
    this._shadowTimer = setInterval(() => this._emitShadowCompare(), 5 * 60 * 1000);
    this.logger.log('🔭 [AIS_MUX] Skuggjämförelse aktiv — rapport var 5:e minut');
  }

  /** @private */
  _stopShadowTimer() {
    if (!this._shadowTimer) return;
    clearInterval(this._shadowTimer);
    this._shadowTimer = null;
  }

  /** @private */
  _emitShadowCompare() {
    const w = this._shadowWindow;
    const both = [...w.streamMmsi].filter((m) => w.hubMmsi.has(m));
    const onlyStream = [...w.streamMmsi].filter((m) => !w.hubMmsi.has(m));
    const onlyHub = [...w.hubMmsi].filter((m) => !w.streamMmsi.has(m));
    const sorted = [...w.deltas].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : null;
    this.logger.log(
      `🔭 [SHADOW_COMPARE] window=5min onlyAisstream=${onlyStream.length} `
      + `onlyAishub=${onlyHub.length} both=${both.length} samples=${sorted.length} `
      + `medianDeltaMs=${median ?? '-'} p90DeltaMs=${p90 ?? '-'} `
      + '(positivt delta = AISHub-fixen var färskare än aisstream-mottagningen) '
      + `navstatAisstream=${JSON.stringify(w.navstat.aisstream)} `
      + `navstatAishub=${JSON.stringify(w.navstat.aishub)}`,
    );
    if (onlyHub.length > 0) {
      this.logger.log(`🔭 [SHADOW_COMPARE] AISHub-exklusiva MMSI i fönstret: ${onlyHub.join(', ')}`);
    }
    this._resetShadowWindow();
  }
}

module.exports = AISSourceMultiplexer;
