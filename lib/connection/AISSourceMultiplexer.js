'use strict';

const EventEmitter = require('events');
const AISStreamClient = require('./AISStreamClient');
const AISHubClient = require('./AISHubClient');
const FixFusionPolicy = require('./FixFusionPolicy');
const geometry = require('../utils/geometry');
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
    // V5: ögonblicksbild vid förra [FUSION_HEALTH]-raden så fönsterdeltat
    // (inte bara ackumulerade totaler) kan redovisas.
    this._fusionStatsAtLastReport = null;
    // F6b: GLOBALT klockstate (AISHub är EN server med EN klocka). Skattar
    // hubbens offset mot Homeys klocka så F6:s korsdomänjämförelse blir
    // giltig i BÅDA skevriktningarna — se FixFusionPolicy.observeClock.
    this._fusionClock = FixFusionPolicy.createClockState();

    // Skuggjämförelsen ('shadow'/'both'): fönsterdata + positionsindex.
    this._shadowTimer = null;
    // "mmsi:latGrid:lonGrid" → {storedAt, aisstream?: side, aishub?: side}
    // där side = {deliveryTs, fixTs, lat, lon, storedAt}. storedAt driver
    // TTL-prunen (fältprov 2: utan åldersgräns parades färska fixar mot
    // urgamla mottagningar och en tredjedel av samplen blev artefakter).
    // BÅDA källorna indexeras (fynd 12) — se _recordShadowSample.
    this._shadowPosIndex = new Map();
    // Kontinuitetsmätningen: mmsi → senast sedd, per källa.
    this._shadowLastSeen = { aisstream: new Map(), aishub: new Map() };
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
        // F6b: klockregimen är en del av fusionens hälsa (se _emitFusionHealth).
        hubClockOffsetMs: this._fusionClock ? this._fusionClock.hubOffsetMs : 0,
        hubClockAheadSamples: this._fusionClock ? this._fusionClock.hubAheadSamples : 0,
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
    // KÄLLSTÄMPELN KOMMER FRÅN ROUTINGEN (granskningsrunda 2, 2026-08-03).
    // fixFeed sattes tidigare av respektive klient/parser och LÄSTES av
    // fusionens F1/F6, av segmentbevisets källgrind (StatusService) och av
    // fysik-dt:t (GPSJumpAnalyzer) — ett tappat fält (fältprov 3-regressionen)
    // hade alltså tyst avväpnat flera skydd samtidigt. Muxen VET vilket barn
    // meddelandet kom från; den vetskapen stämplas här, en gång, för alla
    // vägar (pass-through, skugga och fusion).
    const normalized = { ...msg, fixFeed: feed, shipName: this._normalizeName(msg.shipName) };

    // Skuggbokföring (shadow/both): jämförelsedata per källa.
    if (this._shadowTimer) this._recordShadowSample(feed, normalized);

    if (feed === 'aisstream') {
      if (this._config.source === 'both') {
        this._fuseAndEmit(feed, normalized);
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
      this._fuseAndEmit(feed, normalized);
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
  _fuseAndEmit(feed, msg) {
    const now = Date.now();
    let state = this._fusionStates.get(msg.mmsi);
    if (!state) {
      state = FixFusionPolicy.createState();
      this._fusionStates.set(msg.mmsi, state);
    }
    // F6b: bokför klockbevisen FÖRE beslutet, så en klocka som just hoppat
    // framåt kompenseras redan på det meddelande som avslöjade hoppet.
    FixFusionPolicy.observeClock(this._fusionClock, state, msg, feed, now, this._fusionCfg);
    const verdict = FixFusionPolicy.shouldAccept(state, msg, now, this._fusionCfg, {
      feed,
      hubOffsetMs: this._fusionClock.hubOffsetMs,
    });
    if (!verdict.accept) {
      this._fusionStats.rejected++;
      this._fusionStats.byReason[verdict.reason] = (this._fusionStats.byReason[verdict.reason] || 0) + 1;
      return;
    }
    FixFusionPolicy.applyAccept(state, msg, verdict.fixTs, now, feed);
    this._fusionStats.accepted++;
    if (verdict.feedSwitch) {
      this._fusionStats.feedSwitches++;
      this._logFusionSwitch(msg.mmsi);
    }
    this.emit('ais-message', {
      ...msg,
      fixFeed: feed,
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
    // Skuggindexet: ÅLDERSBASERAD prune (fältprov 2). Tidigare rensades det
    // först vid >500 poster — indexet nådde max 46 under en timme, alltså
    // rensades det i praktiken aldrig och gamla poster förgiftade parningen.
    const now = Date.now();
    const cfg = AIS_CONFIG.SHADOW;
    for (const [key, entry] of this._shadowPosIndex) {
      const storedAt = entry && Number.isFinite(entry.storedAt) ? entry.storedAt : 0;
      if (now - storedAt > cfg.POS_INDEX_TTL_MS) this._shadowPosIndex.delete(key);
    }
    // Taket: evictera ÄLDST SKRIVNA (fynd 15:s klass — Map-ordningen är
    // insättningsordning, och en post som skrivs om av en ny fix behåller sin
    // gamla plats, så FIFO hade slängt de mest aktiva fartygen först).
    if (this._shadowPosIndex.size > cfg.POS_INDEX_MAX_ENTRIES) {
      const byAge = [...this._shadowPosIndex.entries()]
        .sort((a, b) => (a[1].storedAt || 0) - (b[1].storedAt || 0));
      let over = this._shadowPosIndex.size - cfg.POS_INDEX_MAX_ENTRIES;
      for (const [key] of byAge) {
        if (over <= 0) break;
        this._shadowPosIndex.delete(key);
        over--;
      }
    }
    // Kontinuitetsmätningens lastSeen-kartor (TTL + tak). Varje bortprunad
    // post är ett fartyg vars tystnad blir OMÄTBAR (fynd 13) — räkna den så
    // att SHADOW_COMPARE kan redovisa maxSilence som nedre gräns i stället
    // för att tyst censurera nattens längsta glapp.
    for (const feed of ['aisstream', 'aishub']) {
      const seen = this._shadowLastSeen[feed];
      for (const [mmsi, ts] of seen) {
        if (now - ts > cfg.LAST_SEEN_TTL_MS) {
          seen.delete(mmsi);
          this._shadowWindow.silenceCensored[feed]++;
        }
      }
      while (seen.size > cfg.LAST_SEEN_MAX_ENTRIES) {
        seen.delete(seen.keys().next().value);
        this._shadowWindow.silenceCensored[feed]++;
      }
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
      // fixLag: aisstream-mottagning − AISHub-FIXTID (hur mycket äldre
      // AISHubs stämpel är). race: aisstream-mottagning − AISHubs
      // LEVERANSTID (vem som faktiskt kom först till appen).
      fixLags: [],
      races: [],
      stalePairsDropped: 0,
      maxSilence: { aisstream: 0, aishub: 0 },
      // Fynd 13: hur många fartyg som tystnade så länge att lastSeen-posten
      // prunades bort ⇒ deras glapp är OMÄTBART och maxSilence ovan är då
      // bara en NEDRE gräns. Utan detta lästes ett censurerat tak som ett
      // sanningsenligt maxvärde.
      silenceCensored: { aisstream: 0, aishub: 0 },
      navstat: { aisstream: {}, aishub: {} },
    };
  }

  /**
   * Rutnyckel för positionsindexet (1e-5° ≈ 1,1 m i lat). Heltalsindex i
   * stället för avrundad decimalsträng så grannrutor går att räkna fram.
   * @private
   */
  static _gridKey(mmsi, lat, lon, dLat = 0, dLon = 0) {
    return `${mmsi}:${Math.round(lat * 1e5) + dLat}:${Math.round(lon * 1e5) + dLon}`;
  }

  /**
   * Hitta MOTPARTENS senaste sampel för praktiskt taget samma position.
   *
   * FYND 16 (A/B-natten 2026-08-03): ett rent uppslag på den avrundade
   * rutnyckeln tappade 15,1 % av de bevisade paren — två avkodningar av
   * samma fysiska rapport hamnar i olika rutor så snart de ligger på var sin
   * sida om en rutgräns. Svep därför 3×3-grannskapet och avgör på AVSTÅND.
   * @private
   * @returns {object|null} motpartens side-post
   */
  _findShadowCounterpart(feed, msg) {
    const cfg = AIS_CONFIG.SHADOW;
    const other = feed === 'aisstream' ? 'aishub' : 'aisstream';
    let best = null;
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const key = AISSourceMultiplexer._gridKey(msg.mmsi, msg.lat, msg.lon, dLat, dLon);
        const entry = this._shadowPosIndex.get(key);
        const side = entry && entry[other];
        if (!side) continue;
        const dist = geometry.calculateDistance(msg.lat, msg.lon, side.lat, side.lon);
        if (!Number.isFinite(dist) || dist > cfg.PAIR_MATCH_DIST_M) continue;
        if (!best || side.storedAt > best.storedAt) {
          best = {
            side, key, entry, other,
          };
        }
      }
    }
    return best;
  }

  /**
   * Bokför ett par (aisstream-mottagning ↔ AISHub-fix) i fönstret.
   *
   * SAMMA FYSISKA RAPPORT, INTE BARA SAMMA KOORDINAT (granskningsrunda 2,
   * 2026-08-03): parningen matchar på POSITION, och en stillaliggande båt
   * återvänder till samma koordinat rapport efter rapport. Efter att
   * mätningen gjordes tvåsidig (fynd 12) kunde en FÄRSK aisstream-upprepning
   * därför paras mot hubbens post för en HELT ANNAN, äldre rapport och ge ett
   * POSITIVT race — "AISHub kom först" — som var ren artefakt (mätt: 20 av 22
   * positiva race, samtliga sog = 0, fixseparation 21–63 s). Före
   * tvåsidigheten kunde samma artefakt bara ge NEGATIVA race, så felet fick
   * nytt tecken i och med fynd 12-fixen. Två spärrar stänger det:
   *   1. race-samplet kräver att BÅDA LEVERANSERNA ligger inom
   *      PAIR_MAX_SKEW_MS — annars är det inte en kapplöpning utan två
   *      rapporter.
   *   2. anroparen KONSUMERAR motparten (posten tas bort ur indexet), så en
   *      och samma post aldrig kan paras om mot nyare motparter.
   * @private
   */
  _recordShadowPair(streamSide, hubSide) {
    const w = this._shadowWindow;
    const cfg = AIS_CONFIG.SHADOW;
    const receiptTs = streamSide.deliveryTs;
    if (!Number.isFinite(receiptTs) || !Number.isFinite(hubSide.fixTs)) return;
    // FÄLTPROV 2-FIXEN: godta paret bara när mottagningen och fixen ligger
    // nära varandra i tid. En stillaliggande båt återkommer till samma
    // koordinat var 3:e minut — utan denna grind parades färska fixar mot
    // urgamla mottagningar och 32 % av samplen blev artefakter (medianer på
    // flera minuter, ibland med fel tecken).
    if (Math.abs(receiptTs - hubSide.fixTs) > cfg.PAIR_MAX_SKEW_MS) {
      w.stalePairsDropped++;
      return;
    }
    if (w.fixLags.length >= cfg.MAX_SAMPLES_PER_WINDOW) return;
    const fixLag = receiptTs - hubSide.fixTs;
    w.fixLags.push(fixLag);
    // RACE = kapplöpning om SAMMA fysiska rapport, och kräver därför ett
    // snävare samma-rapport-bevis än fixLag: dels att leveranserna ligger
    // inom parningsfönstret, dels att hubbens fixtid ligger inom
    // PAIR_SAME_REPORT_MS från aisstreams mottagning. Utan det andra villkoret
    // överlevde 9 av 13 positiva race som artefakter (fixLag 21-62 s = hubbens
    // post gällde en HELT ANNAN, äldre rapport från samma stillaliggande båt),
    // medan de äkta låg på fixLag 1,8-2,5 s.
    if (Number.isFinite(hubSide.deliveryTs)
      && Math.abs(receiptTs - hubSide.deliveryTs) <= cfg.PAIR_MAX_SKEW_MS
      && Math.abs(fixLag) <= cfg.PAIR_SAME_REPORT_MS) {
      w.races.push(receiptTs - hubSide.deliveryTs);
    } else {
      w.stalePairsDropped++;
    }
  }

  /** @private */
  _recordShadowSample(feed, msg) {
    const w = this._shadowWindow;
    const now = Date.now();

    // Kontinuitetsmätningen (fältprov 2): största tystnadsglapp per källa.
    // Det är den metrik som faktiskt fångar AISHubs värde — täckningen —
    // till skillnad från fixLag som bara mäter stämpelålder.
    const seen = this._shadowLastSeen[feed];
    const prevSeen = seen.get(msg.mmsi);
    if (Number.isFinite(prevSeen)) {
      const gap = now - prevSeen;
      if (gap > w.maxSilence[feed]) w.maxSilence[feed] = gap;
    }
    seen.set(msg.mmsi, now);

    if (feed === 'aisstream') w.streamMmsi.add(msg.mmsi);
    else w.hubMmsi.add(msg.mmsi);

    // FYND 12 (A/B-natten 2026-08-03): indexet skrevs BARA av aisstream-
    // grenen, så ett par kunde bara uppstå när aisstream kom FÖRST —
    // raceMedianMs var negativ i 103 av 103 fönster och mätte i praktiken
    // pollintervallet, inte kapplöpningen. Mätningen är nu TVÅSIDIG: båda
    // källorna indexeras och den som kommer SIST parar ihop sig med den
    // andras post, så en AISHub-först-leverans ger ett POSITIVT race.
    if (Number.isFinite(msg.lat) && Number.isFinite(msg.lon)) {
      const side = {
        deliveryTs: Number.isFinite(msg.timestamp) ? msg.timestamp : now,
        fixTs: Number.isFinite(msg.fixTs) ? msg.fixTs : null,
        lat: msg.lat,
        lon: msg.lon,
        storedAt: now,
      };
      const counterpart = this._findShadowCounterpart(feed, msg);
      if (counterpart) {
        if (feed === 'aisstream') this._recordShadowPair(side, counterpart.side);
        else this._recordShadowPair(counterpart.side, side);
        // KONSUMERA motparten: en indexerad post får bära EXAKT ett par.
        // Utan detta parades varje ny upprepning av samma koordinat mot
        // samma gamla post om och om igen (se _recordShadowPair).
        delete counterpart.entry[counterpart.other];
        if (!counterpart.entry.aisstream && !counterpart.entry.aishub) {
          this._shadowPosIndex.delete(counterpart.key);
        }
      }
      const key = AISSourceMultiplexer._gridKey(msg.mmsi, msg.lat, msg.lon);
      const entry = this._shadowPosIndex.get(key) || {};
      entry[feed] = side;
      entry.storedAt = now;
      this._shadowPosIndex.set(key, entry);
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
    // Slutspolning (fältprov 2): utan detta gick det påbörjade fönstrets
    // mätdata förlorad vid varje lägesbyte/nedstängning.
    if (this._shadowWindow
        && (this._shadowWindow.streamMmsi.size > 0 || this._shadowWindow.hubMmsi.size > 0)) {
      this._emitShadowCompare(true);
    }
  }

  /**
   * Kvantil med NEAREST-RANK (⌈q·n⌉-te värdet).
   *
   * FYND 14 (A/B-natten 2026-08-03): den gamla formeln
   * arr[min(n-1, floor(n·q))] returnerade MAXVÄRDET vid exakt n=10 — alltså
   * precis vid tröskeln MIN_SAMPLES_FOR_P90, den första punkt där p90 alls
   * skrivs. Instrumentet rapporterade då svansens topp som "p90". Latent i
   * fältprovet (max 6 sampel/fönster) men aktivt vid högre trafik.
   * @private
   * @param {number[]} arr - sorterad numerisk serie
   * @param {number} q - kvantil 0-1
   */
  static _pct(arr, q) {
    if (!arr.length) return null;
    const rank = Math.ceil(q * arr.length);
    return arr[Math.min(arr.length - 1, Math.max(0, rank - 1))];
  }

  /** @private */
  _emitShadowCompare(isFinal = false) {
    const w = this._shadowWindow;
    const cfg = AIS_CONFIG.SHADOW;
    const both = [...w.streamMmsi].filter((m) => w.hubMmsi.has(m));
    const onlyStream = [...w.streamMmsi].filter((m) => !w.hubMmsi.has(m));
    const onlyHub = [...w.hubMmsi].filter((m) => !w.streamMmsi.has(m));

    const lags = [...w.fixLags].sort((a, b) => a - b);
    const races = [...w.races].sort((a, b) => a - b);
    const n = lags.length;
    const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
    // Percentil bara när urvalet bär den (annars är p90 = max, inte p90).
    const p90 = (a) => (a.length >= cfg.MIN_SAMPLES_FOR_P90
      ? AISSourceMultiplexer._pct(a, 0.9)
      : null);
    const fmt = (v) => (v === null ? '-' : v);

    this.logger.log(
      `🔭 [SHADOW_COMPARE]${isFinal ? ' (slutspolning)' : ''} window=5min `
      + `onlyAisstream=${onlyStream.length} onlyAishub=${onlyHub.length} both=${both.length} `
      + `samples=${n} stalePairsDropped=${w.stalePairsDropped} `
      // TECKENFÖRKLARINGEN RÄTTAD (fältprov 2): koden räknar
      // aisstream-mottagning MINUS AISHub-fixtid, så ett POSITIVT värde
      // betyder att AISHubs stämpel är ÄLDRE. Den gamla texten påstod
      // motsatsen och hade lett till fel GO-beslut.
      + `fixLagMedianMs=${fmt(med(lags))} fixLagP90Ms=${fmt(p90(lags))} `
      + '(positivt = AISHubs fixstämpel är ÄLDRE än aisstreams mottagning) '
      + `raceMedianMs=${fmt(med(races))} raceP90Ms=${fmt(p90(races))} `
      + '(positivt = AISHub levererade till appen FÖRE aisstream) '
      // Fynd 13: maxSilence är en NEDRE gräns när poster hunnit prunas —
      // silenceCensored* > 0 betyder att verkliga glapp översteg
      // LAST_SEEN_TTL_MS och alltså aldrig kunde mätas.
      + `maxSilenceAisstreamMs=${w.maxSilence.aisstream} maxSilenceAishubMs=${w.maxSilence.aishub} `
      + `silenceCensoredAisstream=${w.silenceCensored.aisstream} `
      + `silenceCensoredAishub=${w.silenceCensored.aishub} `
      + `navstatAisstream=${JSON.stringify(w.navstat.aisstream)} `
      + `navstatAishub=${JSON.stringify(w.navstat.aishub)}`,
    );
    if (onlyHub.length > 0) {
      this.logger.log(`🔭 [SHADOW_COMPARE] AISHub-exklusiva MMSI i fönstret: ${onlyHub.join(', ')}`);
    }
    // GO-kriteriernas råvärden (fältprov 2: de fanns i getConnectionStats()
    // men skrevs aldrig till loggen — kriterium 2/3/4 gick inte att avgöra).
    if (this._hubClient && typeof this._hubClient.getConnectionStats === 'function') {
      const s = this._hubClient.getConnectionStats();
      const c = s.counters || {};
      const emptyPct = c.polls > 0 ? ((c.emptyResponses / c.polls) * 100).toFixed(2) : '-';
      this.logger.log(
        `📊 [AISHUB_HEALTH] polls=${c.polls} emptyResponses=${c.emptyResponses} (${emptyPct}%) `
        + `timeParseFail=${c.timeParseFail} errorRecords=${c.errorRecords} netErrors=${c.netErrors} `
        + `authFail=${c.authFail} formatMismatch=${c.formatMismatch} parseErrors=${c.parseErrors} `
        + `emptySweeps=${c.emptySweeps} sentinelPos=${c.sentinelPos} invalidMmsi=${c.invalidMmsi} `
        + `accepted=${c.accepted} dedupSize=${s.dedupSize} backoffMs=${s.backoffMs} `
        // V6: en auth-pausad källa ser annars EXAKT ut som en tyst kanal
        // (räknarna står still, backoffMs=0) — läget måste stå i klartext.
        + `authCooldownMinLeft=${Math.round((s.authCooldownMsLeft || 0) / 60000)}`,
      );
    }
    this._emitFusionHealth();
    this._resetShadowWindow();
  }

  /**
   * 📊 [FUSION_HEALTH] — V5 (A/B-natten 2026-08-03).
   *
   * _fusionStats lästes ENBART av replayRunner: i drift var fusionens
   * avslagsprofil helt osynlig. En systematisk svält (t.ex. ett TIME-
   * formatbyte som får F4b att avvisa 100 % av hubbens fixar, eller en
   * klockskev som låser F6) hade alltså pågått i tysthet medan
   * [AISHUB_HEALTH] fortsatte rapportera accepted=N från KLIENTEN — den
   * räknaren mäter parsning, inte vad som når pipelinen.
   *
   * Fönsterdeltat är det som avslöjar svälten (totalerna domineras av
   * historiken och rör sig knappt); totalerna finns med för att en enda
   * loggrad ska räcka vid felsökning.
   *
   * KLOCKREGIMEN (granskningsrunda 2, 2026-08-03): avslagsprofilen ensam
   * räcker inte. En hubklocka som går FÖRE Homeys yttrar sig som FRÅNVARO av
   * avslag (stale_cross_fix → 0) plus hög accept-andel — raden hade alltså
   * blivit GRÖNARE precis när F6 slutade skydda. Därför redovisas hubbens
   * observerade leveranslagg: hubLagMin < 0 är fysiskt omöjligt utan skev
   * (en fix kan inte postdatera sin egen leverans) och hubOffset visar hur
   * mycket F6b kompenserar. Går klockan åt andra hållet syns det som en
   * onormalt STOR hubLagMin ihop med stigande stale_cross_fix (svält).
   * @private
   */
  _emitFusionHealth() {
    if (this._config.source !== 'both') return; // fusion körs bara i 'both'
    const s = this._fusionStats;
    const prev = this._fusionStatsAtLastReport
      || {
        accepted: 0, rejected: 0, feedSwitches: 0, byReason: {},
      };
    const dAccepted = s.accepted - prev.accepted;
    const dRejected = s.rejected - prev.rejected;
    const dByReason = {};
    for (const [reason, count] of Object.entries(s.byReason)) {
      const delta = count - (prev.byReason[reason] || 0);
      if (delta > 0) dByReason[reason] = delta;
    }
    const total = dAccepted + dRejected;
    const acceptPct = total > 0 ? ((dAccepted / total) * 100).toFixed(1) : '-';
    const clk = this._fusionClock || { hubLags: [], hubOffsetMs: 0, hubAheadSamples: 0 };
    // pushClockSample skriver {v, at} — inte {lag} (rättat 2026-08-03: fälten
    // renderades annars alltid som '-', och det är exakt den skevdiagnostik
    // raden finns för).
    const lags = clk.hubLags.map((x) => x.v).sort((a, b) => a - b);
    const lagMin = lags.length ? lags[0] : null;
    const lagMed = lags.length ? lags[Math.floor(lags.length / 2)] : null;
    this.logger.log(
      `📊 [FUSION_HEALTH] fönster: accepted=${dAccepted} rejected=${dRejected} (accept ${acceptPct}%) `
      + `byReason=${JSON.stringify(dByReason)} feedSwitches=${s.feedSwitches - prev.feedSwitches} `
      + `| klocka: hubLagMinMs=${lagMin ?? '-'} hubLagMedianMs=${lagMed ?? '-'} `
      + `hubOffsetMs=${clk.hubOffsetMs} hubAheadSamples=${clk.hubAheadSamples} `
      + '(hubLagMin < 0 ⇒ AISHub-klockan går FÖRE Homeys — F6b kompenserar) '
      + `| totalt: accepted=${s.accepted} rejected=${s.rejected} `
      + `byReason=${JSON.stringify(s.byReason)} feedSwitches=${s.feedSwitches} `
      + `stateSize=${this._fusionStates.size}`,
    );
    this._fusionStatsAtLastReport = {
      accepted: s.accepted,
      rejected: s.rejected,
      feedSwitches: s.feedSwitches,
      byReason: { ...s.byReason },
    };
  }
}

module.exports = AISSourceMultiplexer;
