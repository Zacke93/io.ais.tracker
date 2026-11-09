# ARCHITECTURE.md — AIS Tracker (io.ais.tracker)

Varaktig arkitekturkarta, byggd 2026-07-03; helreviderad mot koden 2026-07-05
efter produktionsredo-fixarna (app.js = 5512 rader; VesselDataService.js =
4701 rader). Radnummer prefixade med `~` kan glida vid framtida redigering.
Ersätter CODEX.md och docs/recentChanges.md (raderade 2026-07-03, användarbeslut).

## 1. Översikt & modulgraf

```
AISstream.io (WebSocket)                AISHub ws.php (HTTPS-poll 65s, opt-in)
   ▼ push                                  ▼ batch (aishubParser → sentinels → TIME→fixTs → dedup)
AISStreamClient (oförändrad)            AISHubClient (lib/connection/AISHubClient.js)
   └──────────────┬────────────────────────┘
                  ▼ (etapp 2, 2026-08-02)
AISSourceMultiplexer (lib/connection/AISSourceMultiplexer.js)
   • ais_source='aisstream' (default): REN PASS-THROUGH — dagens beteende exakt
   • 'shadow': AISHub mäts (🔭 SHADOW_COMPARE var 5:e min), påverkar ALDRIG pipelinen
   • 'both':  FixFusionPolicy F1-F6 (per-källa-monotoni, korskälle-innehållsdedup
              på AVSTÅND, åldersgrind, klockskevsklamp, feedSwitch-flagga och
              F6: asymmetrisk stale-grind — en AISHub-fix måste vara STRIKT
              nyare än senast accepterade fix, aisstream berörs aldrig)
              + F6b: hubbens fixTs lyfts in i Homeys klockdomän innan F6
              jämför (klampad till ≤ 0 ⇒ no-op vid friska klockor)
              + 📊 [FUSION_HEALTH] var 5:e min (accepted/rejected/byReason +
                hubLagMin/hubOffset — klockregimen)
   • 'aishub': solo-poll
   ▼ samma nio events som AISStreamClient (isConnected är en LEVANDE GETTER;
     getConnectionStats() bär perFeed — feed-vakten läser ALDRIG aggregatet)
app.js  _onAISMessage → _processAISMessage (app.js:1894)
   ▼ updateVessel(mmsi, patch)
VesselDataService (lib/services/VesselDataService.js)
   ▼ events: vessel:entered / vessel:updated / vessel:removed / vessel:journey-reset
app.js händelsehanterare (_onVesselEntered:804, _onVesselUpdated:858, _onVesselRemoved:1074)
   ├─→ StatusService.analyzeVesselStatus (status/ETA) ── status:changed → _onVesselStatusChanged:1282
   ├─→ ProximityService.analyzeVesselProximity (avstånd/zoner)
   ├─→ boat_near-Flow-vägarna (§3)            [REAKTIVT: kräver fix inne i 300 m]
   ├─→ BridgeOpeningService.observe (§3)      [PROAKTIVT: beväpning från 2500 m]
   └─→ _updateUI → coalescing → _processUIUpdate:2393 → bridge_text-capability + global token

Watchdogen på fasta halvminuter (_initializeCoalescingSystem)
   ├─→ BridgeOpeningService.tick() (reservsvep, även när kanalen är tom)
   └─→ UI-uppdatering och självläkning
BridgeOpeningService: gemensam timer för nästa deadline/utgången konvojtäckning
   └─→ onWarning → bridge_opening_soon
```

Tidsstyrningen ovan gäller sedan 2026-09-08. Förbrukad ankomstprognos efter
mer än fem minuters AIS-tystnad ger okänd ETA i öppningskortet. Full loggning
bevarar även avvisade AISstream-fixar i `AIS_SOURCE_REJECT_SAMPLE`; dessa
diagnostikrader påverkar varken livstecken eller appens replayindata.

Moduler (ansvar / ägda tillstånd / in-ut):

- **AISStreamClient** (lib/connection/AISStreamClient.js): WebSocket-livscykel mot
  AISstream.io. Bounding box-prenumeration (:254), meddelandetypfilter (:379–386),
  extraktion av mmsi/lat/lon/sog/cog/navStatus/shipName i `_extractAISData`
  (:463–515, avvisar 0,0; String()-wrap på Name). Reconnect-tillstånd (progressiva
  delays, medium 5 min ×12, slow 60 min; :521–529), ping/pong-watchdog
  (`_awaitingPong` :35). Emitterar connected/disconnected/ais-message/static-name
  (typ 5/24-namn, :362–373)/auth-error/error/reconnect-needed/max-reconnects-reached.
- **AISHubClient** (lib/connection/AISHubClient.js, etapp 1 2026-08-02): pollande
  klient mot AISHubs webservice. HÅRD kadensdisciplin (max 1 request/minut per
  username — kontraktsbrott ⇒ tomt svar/indragen access): EN setTimeout-kedja, — SEDAN M12 (2026-08-23) TVÅ timerhandtag: kadenskedjan (`_pollTimer`) OCH pollens ABSOLUTA deadline (`inFlightDeadlineTimer`, ≈ 2×HTTP_TIMEOUT_MS + pollintervall) som nollar `_inFlight` om ett trickle-svar aldrig settlar; en generationsräknare (`pollGen`) ogiltigförklarar sena settlingar; feed-vaktens `forceReschedule` bryter ett inaktuellt single-flight när now − senaste poll > chainDeadMs; `disconnect` river båda timrarna.
  single-flight, ombokning i `finally` (en missad ombokning = död kedja),
  persisterad spärr (`aishub_last_poll_at`) som överlever omstart, backoff
  65→130→260→300 s som ALDRIG kortar kadensen. Parsning i `lib/utils/aishubParser.js`
  (ERROR-gren FÖRE formkontroll, FORMAT/RECORDS-assertioner, sentinelparitet med
  AISStreamClient, TIME→fixTs utan `new Date(str)`). Emitterar samma eventyta;
  positionen bär `fixTs`/`fixFeed:'aishub'`/`fixTsQuality:'true-fix'`.
  **Auth-cooldown (V6, A/B-natten 2026-08-03):** `AUTH_FAIL_STOP` (5) raka
  HTTP 401/403 PAUSAR kedjan `AUTH_COOLDOWN_MS` (6 h) i stället för att sätta
  `_stopped = true` — det gamla beteendet var ett dödläge (ingen kodväg
  återupplivade klienten utan appomstart/username-byte, så ett övergående 403
  slog ut andrakällan för processens livstid). Pausen kontrolleras i `_poll`
  (inte bara i schemaläggningen) så `forceReschedule`/feed-vakten aldrig kan
  bryta den, ett välformat svar upphäver den, och EN användarnotis går ut per
  episod. Läget syns i `getConnectionStats().authCooldownMsLeft` och i
  `[AISHUB_HEALTH]` (`authCooldownMinLeft=`). Enda vägen till `_stopped` är
  `disconnect()` (muxens teardown/onUninit).
- **AISSourceMultiplexer** (lib/connection/AISSourceMultiplexer.js, etapp 2):
  fan-in — app.js vet aldrig att fler än en källa finns. Äger stream-barnet
  (alltid) + hub-barnet (vid konfiguration), aggregerad flankemission
  (connected/disconnected på aggregatets 0→1/1→0, aldrig per barnhändelse —
  Bug#12), namnnormalisering på båda källorna ('Unknown'-sentinelen bevaras
  EXAKT), `applySourceConfig` (idempotent), `_ingestFromFeed` (replay-/testingång),
  skuggjämförelsen och fusionsstate. **Källstämpeln kommer från ROUTINGEN:**
  `_onChildMessage(feed, msg)` skriver `fixFeed = feed` på meddelandet innan
  det går vidare (alla vägar), och fusionspolicyn får källan som PARAMETER, inte
  ur nyttolasten — ett tappat fält (fältprov 3-klassen) kan alltså inte längre
  tyst avväpna F1/F6, segmentbevisets källgrind eller fysik-dt:t.

  **Klockdomänsinvarianten (uppdaterad 2026-08-03):** `vessel.timestamp` förblir
  MOTTAGNINGSTID (TTL/stale/passage-ID). `fixTs` (fixtid) används dels för
  fysik-dt (GPSJumpAnalyzer/gaten/kajvobbelvakten, etapp 0), dels — sedan F6 —
  som fusionens ACCEPT-kriterium för AISHub-fixar. Den senare är en
  KORSDOMÄNJÄMFÖRELSE (hubbens true-fix mot ett `lastAcceptedFixTs` som normalt
  är aisstreams mottagningsstämpel) och därför VILLKORAD, inte fri:
  - Jämförelsen är ENSIDIG. aisstream mäts aldrig mot en hub-stämpel — det hade
    kunnat svälta huvudkällan.
  - Hubbens stämpel lyfts först in i Homeys klockdomän av **F6b**
    (`FixFusionPolicy.observeClock`). Offseten skattas ur två fysiskt grundade
    bevis: leveransbeviset (`now − fixTs` kan inte vara negativt) och medianen
    av korskällepar (samma rapport från båda källorna). Korrigeringen är klampad
    till ≤ 0 ⇒ EXAKT noll när klockorna går rätt ⇒ facit oberört. Utan F6b var
    F6 bara giltig åt ett håll: en hubklocka 30 s FÖRE återskapade
    målbrodubbletterna, och > `FUTURE_CLAMP_MS` klampade F4a varje hub-fix till
    `now` och stängde av grinden helt.
  - Regimen redovisas i `[FUSION_HEALTH]` (`hubLagMinMs`, `hubOffsetMs`,
    `hubAheadSamples`) — en skev får inte kunna yttra sig som bara "färre
    avslag".

  Regeln för när fixtids-dt är giltig ägs av **`GPSJumpAnalyzer.fixDtMs`**
  (enda platsen — VDS och GPSJumpGateService anropar den): samma källa alltid;
  KORSKÄLLA sedan V8 (A/B-natten 2026-08-03) också, men bara när separationen
  är ≥ `FUSION.CROSS_FEED_MIN_FIX_DT_MS`, **VIDGAR** mottagningsseparationen och
  ligger inom `FUSION.CROSS_FEED_MAX_FIX_DT_EXCESS_MS` från den. Vidgningskravet
  är riktningsbestämt av fysiken: hubbens pollfördröjning pressar ihop
  leveranserna (JUNO: mottaget 17 s isär, fixarna 51 s isär ⇒ 28,6 kn implicerat
  mot 9,4 verkliga), medan den motsatta riktningen skulle KRYMPA fönstret och
  göra varje fysikgrind mer tillåtande än före V8. Utan användbar separation
  returneras null ⇒ anroparen behåller mottagningstidsuttrycket.

  **Skuggmätningen är ett INSTRUMENT, och instrumentet kalibrerades om
  2026-08-03** (fynd 12–16 ur A/B-natten — mätfel, inte pipelinefel, men de gav
  fel underlag för GO-beslutet): positionsindexet skrivs numera av BÅDA källorna
  så `raceMedianMs` alls kan bli positiv (förut skrev bara aisstream-grenen ⇒
  103/103 fönster negativa ⇒ talet mätte pollintervallet); parningen slår upp
  3×3-grannrutor och avgör på AVSTÅND (`PAIR_MATCH_DIST_M`) eftersom den
  avrundade rutnyckeln tappade 15,1 % av de äkta paren på rutgränser; ett
  race-sampel kräver dessutom SAMMA-RAPPORT-bevis (`PAIR_SAME_REPORT_MS`) och
  motparten KONSUMERAS ur indexet, annars parades en stillaliggande båts
  återkommande koordinat mot en helt annan, äldre rapport; `LAST_SEEN_TTL_MS`
  är 4 h och varje prunad post räknas som `silenceCensored*` i
  SHADOW_COMPARE-raden — förut censurerades nattens 120-minutersglapp tyst och
  maxSilence lästes som ett sanningsenligt maxvärde; och `_pct` använder
  nearest-rank (returnerade förut MAXVÄRDET vid exakt n=10, precis vid
  tröskeln `MIN_SAMPLES_FOR_P90`).
  **TIDSBASERNA STÅR UTSKRIVNA I RADERNA (K32 k, 2026-08-21).** Båda
  mätraderna bär mått på två olika skalor, och den som läste dem som EN skala
  drog fel slutsats: `[SHADOW_COMPARE]` säger nu att `window=5min` gäller
  räknarna och paren, medan `maxSilence*` mäts per MMSI mot `_shadowLastSeen`
  som ÖVERLEVER fönsterbyten (prunas först vid `LAST_SEEN_TTL_MS`) — ett glapp
  kan spänna flera fönster, vilket är varför fältprov 2 kunde mäta 669 007 ms i
  ett enda femminutersfönster och varför 32 min på en femminutersrad inte är ett
  trasigt instrument. `[FUSION_HEALTH]` delar på samma sätt sitt klockblock i
  `klocka/<N>min glidande fönster` (`hubLagMin`/`hubLagMedian`/`hubOffsetMs`,
  räknade ur `FUSION.CLOCK_OFFSET_WINDOW_MS` = 30 min och därmed
  återhämtningsbara) och `klocka/livstid (nollställs aldrig)`
  (`hubAheadSamples`, `hubPairsDroppedStale`) — fönsterlängden HÄRLEDS ur
  konstanten i stället för att skrivas som en siffra som kan glida isär.
  **NOLLSAMPELFALLET (KX-5/KX-6, fältprovet 2026-08-09)**: glappet kan bara
  mätas VID ANKOMST av ett nytt sampel, så en källa utan sampel rapporterade
  `maxSilence*Ms=0` — instrumentets mest lugnande värde vid total källdöd (sju
  rader i rad medan aisstream var död). Raden bär numera råa räknare
  (`msgsAisstream`/`msgsAishub`) och tre etiketter i stället för nollan:
  `ALDRIG_sedan_start_Xs` (aldrig levererat sedan mätstart),
  `TYST_Xs_inget_sampel` (levererat tidigare, inget i fönstret — täcker även
  källan som dör mitt i körningen) och `OMÄTT_inget_glapp` (levande källa,
  inget fartyg rapporterade två gånger). Uppmätta glapp skrivs oförändrat som
  tal, så `maxSilence*Ms=<tal>` betyder fortfarande exakt vad det gjorde.
- **app.js (AISBridgeApp)**: orkestrering, Flow-kort, UI-publicering, notisdedupe
  (per källa/felklass sedan etapp 2: `_notifyConnectionIssue(msg, feedKey)`;
  dedupradens debuglogg stryps sedan KX-14 till `DEDUP_LOG_THROTTLE_MS` = 5 min
  och bär en KUMULATIV kontrollräknare, så en avväpnad gren fortfarande syns
  som ett hopp i serien i stället för att drunkna i 1 440 rader/dygn),
  persistens, monitoring (inkl. per-feed-watchdog `_checkAISFeedHealth` +
  `[FEED_SILENT]`-korsvakt + muxens `pruneFusionState`). Totaltystnadsgrenens
  SVARSSIDA är fönstermätt för BÅDA källorna sedan H18-rundan (2026-08-22):
  hubben via pollklockan (`lastOkResponseAt` < `FRESH_POLL_MS`, 210 s) och
  aisstream via en svarsklocka i tystnadsbokföringen (senast observerade
  STABILA socket, samma fönster) — den var tidigare ett ögonblicksprov av
  `isConnected`, och EN tick i reconnect-backoff samtidigt med ett hubbglapp
  räckte för "appen är blind" + brända 24h-nycklar. Klockan stämplas bara av
  en socket äldre än fönstret, så en flappande källa (503-stormens 34,6 s)
  inte kan avväpna larmet, och den persisteras aldrig. **BEGRÄNSNING, ärligt
  utskriven (granskarfynd, fixrunda 1b):** H18 täcker RECONNECT-BLINKEN EFTER
  EN STABIL ANSLUTNING, inte aisstreams PERMANENTA serverdöd. Klockan stämplas
  bara av en socket som varit uppe minst 210 s; är källan borta (läget sedan
  ~5 augusti 2026) blir `isConnected` aldrig sant så länge, klockan sätts
  ALDRIG, och ett ~3,5-minuters hubbglapp ger fortfarande `trulyBlind` +
  brända 24h-nycklar — precis som före fixen. Alternativet (låt en
  KONFIGURERAD men permanent nere aisstream inte ensam göra läget blint när
  hubben levererat inom `SILENT_MS`, samma asymmetri som `hubDelivering` redan
  bär) är MEDVETET INTE gjort: det rör larmets grundsemantik, kräver egen
  fältmätning och omprövning av de låsta nattproven i
  `kalldodslarm-eskalering.test.js`. Det står som framtida punkt i docblocket.
  Korsvaktens
  AISHub-NOTIS gatas sedan fynd 17 (A/B-natten 2026-08-03) på `_hubFeedsPipeline()`
  (`ais_source` ∈ {both, aishub} + username) — i skuggläge loggas tystnaden men
  ingen användarnotis skickas, eftersom hubben då varken påverkar brotext eller
  notiser. Äger `_triggeredBoatNearKeys` (session-Set, :181),
  `_persistentRecentTriggers` (2h-Map, :189), `_knownVesselNames` (namncache,
  :204–207), `_lastKnownPositions` (6h-Map för återfödda båtar, :214–216, §3/§6),
  `_vesselRemovalTimers`, `_processingRemoval`, coalescing-tillstånd (:2139–2251,
  watchdog :5302–5313). Samtliga services instansieras :283–333.
- **VesselDataService** (VDS): sanningskälla för fartygstillstånd. `updateVessel`
  (:88) bygger om vesselobjektet varje meddelande via `_createVesselObject`
  (:2633–2865, EXPLICIT fältlista — §8a), kör förtöjningsdetektering (:125–135),
  Fix D-U-sväng (:137–265), målbrologik (`_shouldAssignTargetBridge`:1753,
  `_calculateTargetBridge`:2026, `_handleTargetBridgeTransition`:2223,
  `_applyTargetTransition`:2392), passage-detektering (`_hasPassedBridge`:3693,
  `_hasPassedTargetBridge`:2990), target-protection (:3963–4058), GPS-jump-hold
  (:4609/4638), removal + snapshot (:511–709), RC7-filtret (:1165–1307).
- **StatusService**: statusmaskinen (`analyzeVesselStatus`:71, prioritetsordning
  under-bridge > passed > waiting > stallbacka-waiting > approaching > en-route,
  :171–227; FIX U-tvingad waiting som "prioritet 0" :110–168),
  under-bridge-hysteres (:407–657). Äger CurrentBridgeManager, StatusStabilizer,
  PassageWindowManager, ProgressiveETACalculator. Emitterar `status:changed`.
- **ProximityService**: stateless avståndsanalys fartyg↔broar
  (`analyzeVesselProximity`), bridgeDistances/nearestBridge.
- **SystemCoordinator**: koordinerar GPS-analys/stabilisering; räknar distinkta
  "jumpers" (C4) via `recentJumpers`-Map (:26, :185–188); `cleanup()` (:410)
  körs varje minut från monitoring-loopen (§6). Inga publika
  debounce-/koordinationsmetoder längre (§9).
- **GPSJumpGateService**: blockerar passage-detektering under GPS-hopp;
  candidate→confirm, 30 s gate-timeout. Anropas från VDS (:3020–3028,
  :3695–3703; clearVessel vid removal :736–738). En kandidat släpps när en
  annan väg bokför samma bros passage (`releaseCandidate`, anropas från VDS
  `_releaseGateCandidateForBookedBridge` vid de fyra bokföringarna som lägger
  bron i `passedBridges`). Annars kunde den bekräftas inom TTL:n (20 min) och
  bokföra bron en gång till, en målbro då som mellanbro (F12/F16 2026-11-04:
  JOLLY, glappvägen 16:03:34 och grindbekräftelsen 795 s senare). Andra broars
  kandidater ligger kvar.
- **PassageLatchService**: latch per båt+bro som blockerar retrograda statusar
  ("tidsresor"); 10 min latch-timeout. Konsumeras av StatusService via
  `shouldBlockStatus` (StatusService.js:772, 846, 912, 960, 1176).
- **RouteOrderValidator**: avvisar fysiskt omöjlig broordning per riktning.
- **StatusStabilizer**: hysteres/konfidens vid GPS-osäkerhet (2 konsekutiva
  avläsningar för statusbyte). **VesselLifecycleManager**: resekomplettering;
  terminalgränser KANALINFARTEN_EXIT_LAT 58.2653 / STALLBACKABRON_EXIT_LAT 58.3141.
- **CurrentBridgeManager**: robust `currentBridge`-spårning. `distanceToCurrent`
  räknas alltid OM från positionen FÖRE reglerna (:30–39; jfr §8a offer 7).
  Regel 0: passerad bro rensas (:41–52); Regel 1: SET ≤500 m med flapp-skydd —
  nyss passerad bro (`lastPassedBridge`, >50 m) sätts inte om (:58–69); Regel 2:
  CLEAR >600 m (:70–78). Ingen Regel 3 (ersatt av omräkningen, :79).
- **BridgeTextService**: ren funktion vessels→text (§5).
- **BridgeOpeningService** (lib/services/BridgeOpeningService.js, etapp 6
  2026-08-03): det PROAKTIVA lagret bakom `bridge_opening_soon` (§3). Äger
  beväpning, bro-centrerade öppningshändelser och deadline-motorn. Ren service
  utan Homey-importer och **utan egna timers** — `tick()` drivs av den befintliga
  30 s-watchdogen. Läser bara BEFINTLIGA vessel-fält och håller armarna i egen
  Map (inget nytt fält på fartygsobjektet ⇒ fältlist-fällan undveks; armen
  överlever att fartyget timeout:as, vilket är hela designfallet). In: observation
  per fix + tick. Ut: `onWarning`/`onCoverage`-callbacks till app.js. Rör INTE
  boat_near, bridge_text eller något befintligt facit.
- **Utils**: `geometry` (haversine, distancePointToSegmentM, hasChangedBridgeSide),
  `CountTextHelper`, `etaValidation` (isValidETA, formatETABroOpeningClause =
  SSOT för ETA-klausulen), `PassageWindowManager`, `GPSJumpAnalyzer`.
  (`MessageBuilder`/`ETAFormatter`/`StallbackabronHelper` raderade 2026-07-05; §9.)

## 2. Geografin (lib/constants.js)

Broar i `BRIDGES` (:245–325), syd→nord (`BRIDGE_SEQUENCE` :573–579):

| Bro | lat | lon | radius | axisBearing | Roll |
|---|---|---|---|---|---|
| Olidebron | 58.272743 | 12.275116 | 300 | 130 | mellanbro |
| Klaffbron | 58.284096 | 12.283930 | 300 | 130 | **MÅLBRO** |
| Järnvägsbron | 58.291640 | 12.292025 | 300 | 130 | mellanbro |
| Stridsbergsbron | 58.293524 | 12.294566 | 300 | 130 | **MÅLBRO** |
| Stallbackabron | 58.309802 | 12.316748 | 300 | 142 | hög bro, öppnas aldrig |

- **Stallbackabrons rad flyttades i C0 (commit 4362da7, 2026-08-10)** — tabellen
  bar fram till fältprov 10 (K32 l) de gamla värdena 58.311430/12.314564 med
  axisBearing 125. Den punkten satt 221–228 m NNV LÄNGS bron, mitt över det 486 m
  breda vattenspannet, medan farleden går under bron ~55 m från östra stranden —
  därav att appen rapporterade `distance=207 m` för AGULHAS när hon låg 10 m från
  bron. Nya punkten är konsensus av fem oberoende indikatorer inom 30 m
  (OSM/OpenSeaMaps-nod med källa Ufs 2011:342, ledverkens mittlinje,
  farledsprickarnas parvisa mittpunkter, täckningskartans centerlinje,
  AIS-medianen av korpusbankens passager n=34); 142 är den uppmätta broaxeln vid
  farledsspannet (142,4°). Mätt utfall över ~320 h låst korpusdata: **+3 äkta
  notiser, −0 förlorade** (hela underlaget i `docs/c0-matning-2026-08-10.md`).
  Radien 300 BEHÅLLS — 350-frågan är stängd genom användarbeslut samma dag.
  C0-planens äldre mål `lon 12.317971` (gap 2415) föll i samma verifiering: det
  låg 159,8 m AV bron. **Punkt, axel, `BRIDGE_GAPS`, `EXPECTED_DISTANCES`
  (BridgeRegistry) och `STALLBACKABRON_EXIT_LAT` (58.3125,
  VesselLifecycleManager) flyttas ALLTID i samma commit** — helgranskningens
  invariant låser gapet till haversine ±10 m.
- `TARGET_BRIDGES = ['Klaffbron', 'Stridsbergsbron']` (:537); `INTERMEDIATE_BRIDGES` (:540).
- **Kanalinfarten** är INGEN bro utan trigger-punkt (`TRIGGER_POINTS.kanalinfarten`,
  :176–183: 58.268003/12.269365, radius 300 m) — triggar boat_near men ingår inte
  i brotext/status; ej i BridgeRegistry, uppslag direkt i TRIGGER_POINTS
  (app.js:3938/4108/4156/4255/4892).
- `BRIDGE_GAPS` (:556–567): olide–klaff 1363 m, klaff–järnväg 960 m,
  järnväg–strids 257 m (kortast, kritisk timing), strids–stallbacka **2226 m**
  (C0: haversine mot konsensuspunkten är 2226,2 m — 2310 hörde till den gamla
  koordinaten och 2415 till C0-planens övergivna mål; båda övergivna med den
  punkt de räknades mot).
  (Haversine bro-till-bro; 950/420-datafelen rättades i helgranskningen
  2026-07-06 — denna rad släpade efter till 2026-07-10.)
- `MOORING_ZONES` (:403–488): TVÅ kapslar (centrumlinje + halvbredd), båda norr
  om Klaffbron: "Kajen norr om Klaffbron" (30 m halvbredd, 190–295 m från bron,
  mitt i väntzonen, `queueGraceMs` Infinity sedan ägarbeslutet U23 2026-11-09,
  15 min dessförinnan) och "Gästhamnen norr om Klaffbron"
  (35 m, `queueGraceMs` 0 — B3, 2026-08-06). `MOORING_DETECTION`
  (:342–355): STATIONARY 0.3 kn, MOVEMENT_PROOF 0.5 kn/50 m, navstatus 1/5,
  2h-backstop.
- Stallbackabron-specialreglerna har INGET konstantobjekt längre:
  `STALLBACKABRON_SPECIAL` raderades 2026-08-10 (Fable-granskningen FG-E1 — noll
  referenser, och tre av fälten var hårdkodade `true`). Specialfallet — aldrig
  "inväntar broöppning", egen status `stallbacka-waiting` — implementeras via
  strängjämförelsen `'Stallbackabron'` i app.js, StatusService,
  VesselDataService, PassageLatchService, RouteOrderValidator,
  VesselLifecycleManager och geometry.

## 3. Dataflödet AIS→notis (boat_near)

Inflöde: `_processAISMessage` (app.js:1894) validerar (`_validateAISMessage`
:1989, 0,0-avvisning :2018), normaliserar sog/cog/navStatus till null vid okänt,
injicerar namncachen (B1, :1930–1937: riktigt namn registreras via
`_rememberVesselName`:593, "Unknown" ersätts med cachat namn) och anropar
`VDS.updateVessel` (:1964). Parallellt fyller `_onStaticName` (:1730, kopplad :768)
namncachen från typ 5/24-namn och uppdaterar levande "Unknown"-fartyg på plats.

### De FYRA notisvägarna

1. **Proximity** — `_triggerBoatNearFlow` (app.js:3693). Anropas från
   `_onVesselEntered` (:818, om targetBridge), `_onVesselUpdated` (:990, gate
   :985–989: current/target/finalTarget/nära trigger-punkt) och
   `_onVesselStatusChanged` (:1289–1295, övergång till waiting/stallbacka-waiting).
   Egna gater i ordning (:3695–3786): test-läge → `_moored` → rörelsebevis (RC-S3:
   `_hasMovementProof` eller sog ≥ 0.5) → GPS-jump-hold → stale-AIS >10 min på
   MOTTAGNINGS-tid (F5) → kandidatval (:4022) → per kandidat (:3786).
2. **Passage-fallback** (BUG C) — `_onVesselUpdated` :1011–1018: nyregistrerad
   passage (`lastPassedBridge` stämplad <2000 ms sedan; N5 jämför namn ELLER
   tidsstämpel) → `_triggerBoatNearFlowFallback(vessel, lastPassedBridge)`.
3. **Backfill** — `_onVesselUpdated` :1025–1032: `vessel._passageBackfills[]`
   (fylls av RC9-/gap-inferens i VDS, `registerConfirmedIntermediatePassage`
   VDS:3437–3486) töms och varje bro begärs via `_triggerBoatNearFlowFallback`.
4. **Exit/removal** — `_onVesselRemoved` → Kanalinfarten-exitgaten (blocket runt
   `completedSouthJourney`, direkt efter `STEG 2: RENSA BOAT_NEAR TRIGGERS`).
   *(SYMBOLNAMN, INTE RADNUMMER: de här hänvisningarna skrevs om 2026-08-22 och
   radnumren i samma fil glider med varje insättning — symbolerna gör det
   inte.)* Sydgaten är TVÅDELAD:
   `completedSouthJourney` (`_finalTargetDirection === 'south'` +
   `_finalTargetBridge`) ELLER `targetlessSouthTransit` (mållös sydfärd med
   `_routeDirection === 'south'` + bokförd bropassage ELLER färskt
   notisbevis, `hasNotifiedRealBridge`). **H19 (2026-08-22)**:
   notisbeviset är numera tidsbundet (persistent post inom 2h-fönstret) och
   riktningsprövat (post märkt `dir: 'north'` diskvalificeras) — tidigare
   räckte vilken nyckel som helst ur 6h-retentionen, även från en tidigare
   resa. Ovanpå det ligger motbevisgaten `exitContraEvidence`:
   TIDSBUNDEN obekräftad reversal (`_pendingReversalActive`, H14 — predikatet
   är sedan fixrunda 1b ENDA läsvägen: expired-släppet och dess `holdReason` i
   notisvägen läste tidigare rå truthiness, och åldringen `_ageOutPendingReversal`
   är GEMENSAM för `_onVesselUpdated` och `_onVesselEntered`, så flaggan inte
   kan överleva i en ingång som saknar åldring) eller
   entydigt nordlig sista-kurs (`lastCogIsNorth`) ⇒ ingen exit-notis
   (`EXIT_TRIGGER_SKIP_REVERSAL`). Därefter
   `_triggerExitPointFallback` (F63-stale ≤25 min på
   `lastPositionUpdate`/`timestamp`, ≤400 m från Kanalinfarten — 800 m vid
   aktiv sydtransit (F5-B), norr om punkten, ej `_moored`, `_hasMovementProof`,
   **H19**: fart i NUET ≥ `MIN_VIABLE_SPEED_KN` när farten är känd
   (`EXIT_TRIGGER_SKIP_STATIONARY`), session- + persistent-dedupe) →
   `_triggerBoatNearFlowFallback(vessel, 'Kanalinfarten')` med källan
   `exit-fallback` (F6 — texten påstår ingen passage).

### `_checkSkippedBridgesFallback` (app.js:3810)

Körs vid entered (:827) och updated (:997). Gemensamma gater för BÅDA scenarier:
giltiga koordinater, ej `_moored` (:3824), ej GPS-hold (:3825). Target-gaten är
BORTTAGEN (SY FREYJA 2026-07-02: mållösa återfödda båtar ska också fångas);
scenariovalet görs FÖRE sog-/cog-gaterna (:3828–3839). **F8**: fallbacken anropas
ALLTID med `detectionTs: Date.now()` (:4006–4008) — stale-fönstret räknas från
detektionsögonblicket.

- **Scenario A (new-vessel, oldVessel=null)**: kräver sog ≥ 2.0 (:3866) och cog
  tydligt N (≥315/≤45) eller S (135–225) (:3868–3870). Antar start från kanalport
  (58.265 syd / 58.32 nord, :3907/:3911) — UTOM när (a) `_lastKnownPositions`
  har en färsk post (<6 h TTL, skriven vid removal :1084–1090): fönstret
  begränsas till [senast kända position, nuvarande] (:3895–3902, återfödda
  båtar); eller (b) första positionen ligger i/nära en förtöjningszon
  (**N7-kajvakten**: `isNearMooringZone(_firstSeenLat/Lon, 100)`, :3903–3904 —
  broar bakom kajen falsknotifieras inte).
- **Scenario B (large-jump, |Δlat| > 0.005 ≈ 550 m)**: INGA sog-/cog-gater —
  hoppvektorn ger både rörelsebevis och riktning (`vessel.lat > oldVessel.lat ⇒
  north`, :3852–3858). Broar mellan gamla och nya lat flushas i
  FÄRDRIKTNINGSordning (:3960). Inferensen appliceras i VDS FÖRE notisloopen
  via `applyInferredPassage` (:3981–3989 → VDS:3528–3555): målbro → äkta
  måltransition (+ protection-släpp 'inferred-passage'), mellanbro →
  `registerConfirmedIntermediatePassage` (RC9-inferens om bron ligger bortom
  target). Notisloopen (:4009–4015) skickar `{ detectionTs, inferredFlush: true }`.

### Gate-kedjan i `_triggerBoatNearFlowFallback` (app.js:4230–4417)

I ordning: (0) GPS-jump-hold (:4232–4237) → (1) **persistent dedupe** 2h
riktningsmedveten (:4289–4297) → (2) **avståndstak**: normalt 2000 m
FALLBACK_HARD_MAX_DISTANCE (:4327); vid `inferredFlush` ERSÄTTS taket av
10 km-sanity + krav på färsk position <2 min (`lastPositionUpdate`, :4307–4326
— gap-hopp är legitimt långa) → (3) **stale**: exakt känd tid
(`passedAt[bro]`/detectionTs, max-väljare för "när VI fick veta") > 300 s ⇒
skip; annars skattning distans/maxRecentSpeed (RC3) > 300 s ⇒ skip (:4335–4394)
→ (4) **low-sog**: ≤0.5 kn utan tidsreferens och >500 m ⇒ skip (:4395–4405).
Passerar allt → `_triggerBoatNearFlowForBridge` med `source: 'passage-fallback'`
— UTOM när anroparen skickar `options.source: 'exit-fallback'`, vilket bara
Kanalinfartens exit-väg (`_triggerExitPointFallback`) gör. **F6 (2026-08-10):**
exit-vägen ärvde tidigare passage-taggen och fick därmed P8-meningen
"X passerade Kanalinfarten under AIS-tystnad" — ett påstående om en passage
appen aldrig sett: notisen avfyras med sista kända position NORR om punkten
och Kanalinfarten bokförs aldrig i `passedBridges`/`passedAt`. Taggen är
INTERN: dedup, ETA (-1) och `already_passed` är oförändrade via
`_isRetroactiveNotificationSource`; bara `message` och två loggrader skiljer.

### Kandidatval (:4022), dedup-lagren och tokens (`_triggerBoatNearFlowForBridge`:4424)

Kandidatval: tröskel 300 m (FLOW_TRIGGER_DISTANCE_THRESHOLD). Källor i ordning
(:4080–4113): `target` → `current` → `just-passed` (15 s grace efter passage) →
`nearest` (endast om inga andra) → `trigger-point` (Kanalinfarten, egen
distansberäkning). Finns target-kandidat: target dominerar, MEN target +
current/nearest/just-passed får båda trigga när de är olika broar (Fix 7,
Järnvägs/Strids-överlappet; :4120–4146). Sjätte och sjunde source-värdet —
`passage-fallback` respektive `exit-fallback` (F6, 2026-08-10) — sätts av
fallback-vägen; ingen av dem är en proximity-källa (se §8d).

**Trigger-punktens två grenar.** Sydgående kräver kanalrelevans (FP8:
passerade broar/målbro eller EPISODstart norr om punkten med marginalen
`TRIGGER_POINT_SIDE_MARGIN_DEG`, 0,0009° ≈ 100 m — samma konstant som
`_hasPassedTriggerPoint` läser sedan fixrunda 1b). Nord/okänd kräver
transitindikation: målbro ELLER `sog ≥ QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN`
(FP9). **Kajavgångskorroborering (V1, A/B-natten 2026-08-03):** sog-benet
räcker inte för ett fartyg med FÄRSK kajstabil historik — kring Kanalinfarten
ligger kajliggare permanent inne i 300 m-zonen och ETT momentant brusprov
(PRICKBJORN 07:19:11, sog exakt 1,0, 3 m förflyttning, cog i östbandet ⇒
'unknown') gav en fantomnotis för en båt som sedan gick BORT från punkten.
Klassen avkrävs `NET_APPROACH_M` (40 m) netto-närmande mot punkten sedan
kajläget — ben (b) — ELLER, när nettot är OKÄNT (bokföringsankaret saknar
koordinater), `MIN_MOVING_FIXES` på varandra följande rörelsefixar — ben (a).
Riktningskravet på rörelsebenet är inte kosmetiskt: utan det öppnade grinden
även när båten gick BORT, och fantomen överlevde bara för att dess cog råkade
rulla in i sydbandet på nästa fix. Ett sampel i dödbandet mellan
`MOVEMENT_PROOF_SOG_KN` och `TRANSIT_SOG_KN` NOLLSTÄLLER räknaren — annars var
"på varandra följande" inte sant för kajvobbelns naturliga profil
(1,2 / 0,7 / 1,1 kn). **K4-GOLVET (F3, fältprov 10; slutlig form 2026-08-22):**
ben (a) krävde tidigare bara "ingen netto-reträtt" (`approachM >= 0`), och 31 m
nosning räckte för en 300 m-notis (LADYBIRD 06:53:38). K4 lade först ett eget
golv (70 m) på ben (a), men den grenen var ONÅBAR — ben (b) returnerar redan
vid 40 m, så ett känt netto kan aldrig nå den. Konstanten `MIN_NET_APPROACH_M`
är därför borttagen och ben (a) prövar `approachM === null`; sanningsmängden är
byte-identisk med den förkastade 70-metersvarianten men STRIKT STRÄNGARE än
HEAD:s `approachM >= 0` — bandet 0–39 m känt netto blockeras (LADYBIRD-klassen).
Golvet stannade på 40 m efter rådatamätning: av 14
grindkonsultationer i hela korpusbanken (netto 40–253 m) ligger exakt två i
bandet 40–69 m, och båda är verifierade ÄKTA inseglare (ELFKUNGEN 265573130,
40,4 m, korpus 20260804-both-21h; MONIKA 304482000, 42,0 m, korpus
20260806-42h — båda passerade Olidebron och en MÅLBRO enligt `gt-passages/`).
Ett 70-metersgolv hade fällt noll fantomer men krympt deras förvarning
262→149 m respektive 249→171 m. **Öppningslagret ärver samma predikat** via
`_isBridgeOpeningQuayWobbler`, så en framtida höjning kostar potentiellt en
ÖPPNINGSvarning — dyrare än en notis.
Bokföringen är app-lokal (`_quayStableLedger`, `_noteQuayStability` i BÅDE
`_onVesselUpdated` OCH `_onVesselEntered` före notisvägen) eftersom kajliggarna
återföds oupphörligt — 72 ENTERED/REMOVED-cykler på tio timmar — och ett
vessel-scopat minne hade nollats varje gång; utan ENTERED-anropet var grinden
dessutom inert för just den klass den riktar sig mot (>600 m till närmaste bro
⇒ 120 s timeout mot Class B:s 180 s kadens ⇒ nästan varje fix blir en ENTERED).
Minnesfönstret `MEMORY_MS` är 2 h (nattens värsta observerade sändaruppehåll
för en kajliggare i rent aisstream-läge) och bokföringen PERSISTERAS strypt
(`quay_stable_ledger`, en blob var 15:e minut + vid onUninit) — en appomstart 5 s
före kajavgången återskapade annars fantomen exakt. Den inlärda kajkartan (F4-L)
räknas som stillasample för en långsam båt som ligger på en känd kajplats.
Målbro-benet är orört (målbrotilldelningen har egna förtöjnings-/kajvobbel-
vakter), och fartyg utan kajhistorik prövas exakt som förut.
**Söktermer i fält (K32 a, 2026-08-21):** målbrogrindens loggrad hette förut
"quay wobble, blocking target assignment" men fyrade på ren sydtransit i 4,6 kn,
så frasen dög inte som verktyg. Den heter numera "utan nordprogress"
(TARGET_ASSIGNMENT), och `grep "quay wobble"` träffar därmed ENBART den ÄKTA
kajvobbelvakten i reborn-grenen. Läser du en logg från före 2026-08-21 gäller
det omvända. Dedup-nyckeln
sätts inte vid skip: notisen fördröjs en fix, den förloras inte. **Löftet gäller LEVANDE
zonnärvaro.** En SVEPKANDIDAT (FP7-3, `_tpSweepCandidate` lever exakt en tick och bärs inte av
fältlistan) kunde förr dö på FP9/V1-skippen utan återkomst (N20, runda 5) — sedan fixrunda 5
räknas ett matchande segmentsvep som transitbevis i nordgrenen (segmentet ÄR transitbevis:
båda ändpunkter utanför zonen, latituden korsad). Failsafens förtöjningsretur (large-jump) är
OFÖRÄNDRAD — N20:s andra ben återkallades i 5b (ventilen infördes tillsammans med att target-
gaten togs bort; klassen 'förtöjd + oflaggat stort hopp' är öppen tills fältbevis finns).

Dedup-lagren:

1. **Session-Set** `_triggeredBoatNearKeys` ("mmsi:Bro", :4429–4432). Rensas vid
   journey-reset/NEW_JOURNEY (`_clearBoatNearTriggers`:4588; `clearPersistent=true`
   rensar även 2h-mappen — anropad :741, :948), statuslämning utan aktiv resa
   (:1298–1310), removal utan aktiv resa (:1118–1125, BUG 7 bevarar vid
   timeout+aktiv resa) och för döda mmsi i monitoring-loopen.
2. **Persistent 2h-Map** `_persistentRecentTriggers`: post `{t, dir}`;
   `_persistentDedupCheck` (:458–474) blockerar ENDAST i samma färdriktning
   (motsatt = ny passage, ELFKUNGEN-fallet); riktning saknas ⇒ konservativ
   blockering. Kontrolleras i huvudvägen (:4448), fallback (:4289) och exit
   (:4206). Skrivs vid varje mutation (§6), rollback vid triggerfel (:4562–4571).
3. **Besöksspärren** `TriggerPointVisitTracker` (besöksregeln 2026-09-07, `holds`):
   en notis per båt och punkt och sammanhängande besök. Besöket slutar vid
   observerad utfärd och återkomst (§6) och, sedan **U14 (användarbeslut
   2026-11-04, kort B01, reviderat efter två granskningar)**, vid en bevisad
   passage tillbaka över en bro. Besöket minns vilken sida av brolinjen den
   notifierade passagen leder till (`farSign`: ankomstsidans motsats vid
   förvarning, ankomstsidan vid passerad form via `reserve(…, { passageBehind })`)
   och när båten senast setts entydigt där (`farSideSeenAt`, ±10 m via
   `geometry.decisiveBridgeSide`). Därefter följer `observe` varje ren fix: när
   båtens signerade avstånd till linjen (`geometry.bridgeLineOffsetM`) byter
   tecken från bortre sidan till ankomstsidan noteras en **korsning**, med tiden
   interpolerad på segmentet (fixklockan, som `gt-passages`). En fix tillbaka på
   bortre sidan stryker korsningen. `releaseReturnPassage` släpper besöket bara när
   allt detta gäller:
   - appen har bokfört bron (`lastPassedBridge` eller `passedAt[bro]`, så att en
     retur över två broar i samma glapp räknas) i en fix där båten INTE låg
     entydigt på bortre sidan. En bokföring i en fix på bortre sidan absorberas
     (`farSideBooking`), utom passagelogikens förtida returbokföring medan båten
     väntar vid linjen: en fix inom 30 m på bortre sidan efter att ruttriktningen
     vänt (`_noteFarSideBooking`, revision 4). Den kan bara släppas av två fixar
     på ankomstsidan (nedan). Stämplarna jämförs bara med varandra;
   - ruttriktningen (`_routeDirection`) pekar tillbaka, och båten är under gång
     mot ankomstsidan (rapporterad fart minst `MOVEMENT_PROOF_SOG_KN`, 0,5 kn, och
     kurs mot ankomstsidan via `geometry.courseBridgeSide`);
   - positionen bevisar passagen: en korsning är noterad och båten ligger minst
     30 m ut på ankomstsidan (`UNDER_BRIDGE_CROSS_PROOF_JITTER_M / 2`), med
     bokföringen i korsningssegmentet eller två fixar i rad ENTYDIGT på
     ankomstsidan, under gång dit även i den förra (en bokföring som
     passagelogiken gjorde redan när en väntande båt nådde linjen). Vid gles AIS
     (leveransintervall över halva `PASSAGE_CLEAR_WINDOW_MS`) räcker i
     bokföringsticken ett segment från entydigt bortre sidan till entydigt
     ankomstsidan när båten rör sig i nuet (sog minst 2,0 kn, samma gräns som
     RE_CROSS och C2; utan fart ett segment på minst 100 m), eller till linjen
     (±10 m) i transitfart (`BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN`, 3,13 kn).
     En båt som bromsar in för att vänta vid linjen uppfyller inget av dem inom
     appens brusmodell: kravet på 30 m ut betyder att en båt som i själva verket
     ligger kvar på bortre sidan bara släpps av ett brus på över 30 m längs
     kanalaxeln, alltså utöver 60 m mellan två stilla fixar;
   - **U21** (dirigentens beslut 2026-11-05): notisen kommer högst
     `STALE_ETA_HARD_THRESHOLD_MS` (10 min) efter den interpolerade korsningen.
     Annars skickas ingen returnotis.

   Appen prövar släppet där notisbeslutet fattas (`_triggerBoatNearFlowForBridge`
   och failsafen, med S4:s fönster `PASSAGE_TRIGGER_GRACE_MS`, 15 s, som
   bokföringsgräns; failsafen prövar beviset torrt och släpper besöket först när
   dess egna spärrar, som `FALLBACK_TRIGGER_TOO_FAR` och `STALE`, är passerade)
   och i slutet av varje fix (`_confirmReturnPassages`, utan
   bokföringsgräns; tiden mäts mot korsningen). En retur som bokförs vid linjen
   får alltså sin notis när en senare fix visar båten tydligt på ankomstsidan.
   Formen följer beviset (`_returnPassageForm`): "passerade … under AIS-tystnad"
   när korsningen låg i ett segment längre än två AISHub-pollar (130 s) och
   notisen kommer efter "precis passerat"-fönstret (60 s), annars "har precis
   passerat". Släppet städar som en observerad återkomst (sessionsnyckel och
   persistent post för just den bron). Replayharnessen bokför det separat
   (`visitReturnReleases`, med bevis, korsningstid och dröjsmål) med en
   geometrisk dom ur rådatan (`tests/replay-validation/returnReleaseVerdict.js`),
   och INV-2 fäller ett släpp där båten lämnar bron på bortre sidan (FALSKT
   RETURSLÄPP) eller inte ligger på ankomstsidan vid släppet, i nästa fix eller
   inom 60 s, eller inte stannar där (färre än hälften av fixarna efter släppet,
   nästa fix och 60 s-fönstret, entydigt på ankomstsidan: FÖR TIDIGT RETURSLÄPP).
   En båt som guppar, väntar eller vänder och väntar nära linjen får fortfarande
   EN notis, även vid gles AIS, när hennes AIS rapporterar 0,5–1 kn och när
   GPS-bruset ger passagelogiken falska bokföringar, så länge bruset håller sig
   inom appens brusmodell (se U14, kvarvarande gränser).
   Kanalinfarten har ingen brolinje och följer besöksregeln oförändrad.

Tokens: `vessel_name` (B1: känt namn → cache-uppslag → "Okänd båt", :4464),
`bridge_name`, `direction` (`_getDirectionString`:4639: låst rutt-riktning
först, annars COG — 'unknown' vid omätbar fart; sedan K30 2026-08-21 är
riktningen den ENDA kvarvarande källan till `unknown` i loggen — `[BRIDGE_TEXT_FILTER]`
skriver numera `passed-recent-window` där den förr skrev `unknown` på reason-fältet,
och det fältet stod för 96 av fältprov 10:s 104 unknown-rader och ledde
riktningsutredningen fel), `eta_minutes` (target-källa =
målbro-ETA; övriga = dist/fart mot notisbron; de retroaktiva källorna
`passage-fallback`/`just-passed`/`exit-fallback` ⇒ -1; nära+långsam
icke-target ⇒ -1; sedan H16 även trigger-punkten BAKOM båten ⇒ -1;
:4477–4501), `eta_available` (G1,
2026-07-10: boolean, sant när `eta_minutes ≥ 0` — avväpnar -1-sentinelens
fotgevär i användarens villkor), `already_passed` och `message` (P8/U10,
användarbeslut 2026-08-09).

**P8/U10 — retro-notisernas text.** Kortet ägde tidigare INGEN text: appen
levererade tokens och MENINGEN skrevs av användaren i hens egen flow. En
RETROAKTIV notis — avfyrad efter passagen, från källorna `passage-fallback`
(upp till 2 294 m förbi bron i korpus #18) eller `just-passed` — bar exakt
samma tokens som en förvarning, så en flow som skrev "X närmar sig Y" påstod
något osant. Beslutet var att BEHÅLLA notiserna (C13/U7 mätte över 18 korpusar
att varje bortfiltrering byter notis mot täckningsmiss 1:1) och ändra TEXTEN.
`already_passed` är boolean för den retroaktiva klassen (SSOT
`_isRetroactiveNotificationSource`, samma predikat som persistent-dedupens
`retroactiveSource`), och `message` är en färdig svensk mening:
"X passerade Y under AIS-tystnad" (passage-fallback — klassen där passagen
inferreras i efterhand ur en observerad position på ANDRA sidan bron),
"X har precis passerat Y" (just-passed — LIVE-passage inom 15 s grace, där
AIS-tystnad hade varit ett osant påstående; sedan S4/fixrunda 6 även när källan är
current/target/nearest men appen själv bokfört bron som passerad inom nådan — källsträngen
orörd, eta=-1, already_passed sant), "X var på väg ut ur kanalen vid Y
när AIS-kontakten bröts" (exit-fallback, F6 2026-08-10 — här finns INGET
passagebevis alls: sista position ligger norr om Kanalinfarten, så meningen
påstår bara det gaterna belägger — rörelse, sydgående kurs/riktning inom
400–800 m norr om utfarten, och kontaktförlust) och annars
"X har passerat Y" (H16, 2026-08-22 — trigger-punkten ligger BAKOM båten;
se nedan) och annars "X närmar sig Y[, beräknad ankomst …]".
`_buildBoatNearMessage` härleder
texten UTESLUTANDE ur de redan beräknade tokens — den läser aldrig
bridge_text, så pelare 1 och pelare 2 förblir frikopplade, och den säger
"beräknad ankomst" i stället för bridge_texts "beräknad broöppning" (kortet
avfyrar även för Stallbackabron som ALDRIG öppnar och för trigger-punkten
Kanalinfarten som inte är en bro). Tillägget är rent ADDITIVT: de fem äldre
tokens är byte-identiska — `bridge_name` och `direction` är dessutom
FACITBÄRANDE, `direction` numera **VIA ADAPTERN** (F5, 2026-08-21:
tokenen är svensk, korpusarnas riktningsmultiset är internt, och
`tests/replay-validation/replayRunner.js:83–99` översätter tillbaka med
`fromUserDirection` innan facit läses — se §Riktningsvokabulären; river du
adaptern kostar språkbytet en omlåsning av 17 korpusar) — och notisantal,
dedup-nycklar och trigger-state är orörda.
Golden-text låser `bridge_text`-capabilityns skrivningar, inte notistexter, så
dimensionen är per konstruktion blind för `message`; NOLL DIFF över samtliga
18 korpusar bekräftade det.

**H16 (2026-08-22) — redan-passerad-vakt för trigger-punkten.** Exit-vägen
(`_triggerExitPointFallback`) har alltid haft vakten "söder om punkten =
redan passerad"; LIVE-vägen saknade den, för kandidatpushen prövar bara
avstånd och FP8/FP9-gaterna — aldrig vilken SIDA av Kanalinfarten båten är
på. En sydgående som lämnat punkten fick därför förvarningstext och en ETA
räknad som dist/fart mot en punkt hon rör sig BORT ifrån (13 uppmätta
fältinstanser över ~320 h; 6 över de fyra tätaste korpusarna, 113–299 m).
`_hasPassedTriggerPoint` klassar notisen som passerad när (a) segmentsvepet
observerat genomkorsningen i sampelparet, (b) sydgående SÖDER om punkten med
RESESTART norr om den ELLER minst en passerad bro (alla broar ligger norr
om punkten), eller (c) nordgående NORR om punkten med resestart söder om
den. **Två rättelser i fixrunda 1b (2026-08-22, granskarfynd):**
latitudjämförelserna i (b) och (c) bär nu marginalen
`TRIGGER_POINT_SIDE_MARGIN_DEG` (0,0009° ≈ 100 m) — samma konstant som
FP8-gaten i `_getFlowTriggerCandidates` läser, tidigare en naken literal där
och helt frånvarande här, vilket lät några meters GPS-brus göra en vobblande
kajliggare till "har passerat Kanalinfarten". Och ankaret är RESEANKARET
(`VesselDataService.getJourneyOriginLat` → `_journeyStartLat` med
`_firstSeenLat` som fallback), inte episodankaret: en kajvändare i samma
spårningsepisod bedömdes annars mot UTRESANS startpunkt. FP8-gaten läser
MEDVETET kvar episodankaret — dess fråga är "började den här EPISODEN uppe i
kanalen eller är detta en kajstartare i zonen", och till skillnad från den
här vakten avgör den om en KANDIDAT ÖVER HUVUD TAGET FINNS (notisantal ⇒
facit), så ett byte kräver egen fältmätning. Motiveringen står i koden vid
båda ställena. Beviskravet är strängare än "fel sida" med flit: korpusmätningen visar
liggplatser på BÅDA sidor (2 115 respektive 3 717 stillaliggande
positionsrapporter inom 300 m), och en kajstartare som lägger ut från sin
egen sida har inte passerat något — 5 av 5 nordgående kandidater i mätningen
var just den klassen och vakten avstod korrekt. Flaggan styr ENBART `eta`
(-1), `already_passed` och `message`. KÄLLSTRÄNGEN är orörd (`trigger-point`
bär dedupens semantik och är låst i paket-p8) och DISTANSEN är orörd
(INV-11:s 400 m-gräns läser den i svepfallet).

**Trigger-state (:4546):** `{ bridge, mmsi, distance: Math.round(d), source }`.
OBS per-bro-semantik: dedupen sker UPPSTRÖMS per mmsi:bro, så en "Any
bridge"-flow fyrar max EN gång per BRO och resa (upp till 6 för full genomresa)
— run-listenern (:4743–4758) släpper `'any'` rakt igenom; per-resa-gaten (F7,
mmsi:any-nyckeln) togs bort 2026-07-02 (användarbeslut). distance/source
konsumeras av replay-invarianterna (INV-11, inferens-särskiljning).

### Riktningsvokabulären — två språk, EN översättningspunkt (F5/A3, 2026-08-21)

Riktningen finns i **två vokabulärer** och de får aldrig blandas:

| internt (koden resonerar) | användare (Flow-token) | var |
|---|---|---|
| `northbound` | `norrut` | boat_near + bridge_opening_soon |
| `southbound` | `söderut` | boat_near + bridge_opening_soon |
| `unknown` | `okänd` | boat_near (öppningskortet når det via payloadens fallback) |
| `mixed` | `båda` | ENDAST bridge_opening_soon (mötande konvoj, K13b) |

**EN översättningspunkt: `lib/utils/directionTokens.js`.** `toUserDirection`
(internt → svenskt) anropas från exakt fyra ställen i app.js — `:6386`
(öppningskortet), `:8021` (boat_near-tokenen), `:8090` (`safeTokens`, idempotent
andrapass) och `:8881` (exit-fallbackens litteral). `fromUserDirection` (svenskt
→ internt) har EN anropare i drift: harnessens riktningsadapter
(`replayRunner.js:98`). Ingen annan fil får BYGGA en riktnings-token ur en egen
svensk sträng — loggtexter är fria (t.ex. K12:s `app.js:4779`), tokens är det
inte.

- **Asymmetrin i fallbackarna är medveten.** `toUserDirection` matar en
  ANVÄNDARSYNLIG token ⇒ okänd indata blir `okänd` (ett engelskt ord får aldrig
  läcka ut i någons Flow). `fromUserDirection` matar FACITNYCKLAR ⇒ okänd indata
  returneras ORÖRD, så INV-2 (`invariants.js:139`) fortsätter kunna fälla skräp.
- **Sväljningen har en vakt.** Att `toUserDirection` städar bort skräp gör en
  framtida stavfelsretur inne i riktningskedjan tyst (`'northboud'` → `okänd` →
  adaptern → `unknown` → INV-2 godkänner). `app.js:_assertInternalDirection`
  prövar därför värdet mot `INTERNAL_TO_USER` (`hasOwnProperty`, aldrig
  prototypkedjan) FÖRE översättningen och skriver `this.error('[DIR_TOKEN] …')`.
  Vakten LOGGAR — den ändrar aldrig tokenvärdet.
- **De persistenta dedup-nycklarna står KVAR på interna ord** och ska så
  förbli: öppningsvarningarnas `bro|mmsi|riktning` (`app.js:6312`) och
  boat_near-dedupens `{t, dir}`-poster (`app.js:8156`, `dir` från
  `_dedupDirection`) lever i `homey.settings` ÖVER omstarter — ett språkbyte
  där hade gjort varje lagrad nyckel omatchbar och släppt fram dubbelvarningar
  efter uppdateringen. Samma sak gäller varje intern jämförelse
  (`=== 'southbound'`, skip-grinden, målbrotilldelningen).
- **Facit är internt, tokenen svensk.** `replayRunner.js:83–99` definierar
  adaptern; den tillämpas på notisernas `direction` (`:560`) och
  öppningsvarningarnas (`:586`). Alla nedströmskonsumenter (runAllCorpora,
  runFusionCorpora, runPhaseSweep, relockGoldenText, invariants) ärver
  översättningen. **River du adaptern kostar språkbytet en omlåsning av 17
  korpusar.**

**K1 — Kanalinfart-regeln (`_getNotificationDirection`, app.js:8437).** Farleden
in mot trigger-punkten löper ENE, så det FÖRSTA in-zon-samplet ligger nästan
alltid i COG-dödbandet 46–134° som `_getDirectionString` medvetet svarar
`unknown` på (13/25 inkommande över fyra fältdygn). Regeln flyttar `unknown` →
`northbound` när ALLA villkor håller:

1. `_getDirectionString` gav `unknown` (ruttlåset är fortsatt primärt),
2. kandidaten ÄR trigger-punkten: `source === 'trigger-point'` OCH
   `name === TRIGGER_POINTS.kanalinfarten.name` (exit-/passage-fallback
   undantas — de är retroaktiva och sydgående per definition),
3. cog ligger i östbandet, härlett ur `COG_BANDS` (`> NORTH_MAX`,
   `< SOUTH_MIN`) — aldrig kopierade gradtal,
4. nordprogressen `vessel._lastNorthProgress.mps >=
   VesselDataService.NORTH_PROGRESS_MIN_MPS` (0,25 m/s — samma ribba som
   kajvobbelgrinden, inget nytt kalibrerat tal), och
5. **FÄRSKHET:** `_lastNorthProgress.ts === max(vessel.lastPositionUpdate, vessel.timestamp)` (S5-not: nordprogressen har sedan fixrunda 6 TVÅ baskällor — ordinarie oldVessel, och vid ÅTERFÖDELSE utan oldVessel posten i `app._lastKnownPositions` via `_rebirthNorthBase`, maxålder VESSEL_GRAVE.TTL_MS, fartspärr, mottagningsklockan), dvs.
   mätningen kommer från just den position som bär notisen. Utan kravet kunde
   beviset frysa (en "vet inte"-mätning skriver aldrig över, och
   `GPSJumpAnalyzer.fixDtMs` ger 0 — inte null — vid identisk fixTs från samma
   feed).

Regeln kan BARA ge `northbound`, aldrig `southbound`: ett felaktigt sydvärde
aktiverar TRIGGER_POINT_SKIP-grinden och RADERAR kandidater som i dag går fram.
Fältfacit på FIXklockan: BALTIC JONGLEUR 0,461 m/s och NAVEN 0,606 ⇒ norrut,
LADYBIRD 0,115 (46 % av ribban, marginal 2,2×) ⇒ `okänd` står kvar — hon vände
vid 230 m och förtöjde 423 m väster om punkten.

K1-mätningen har en tredje läsare sedan varv 2 (M3, se §Target-livscykeln):
`VesselDataService._rebirthTransitDirection` läser samma stash med samma
färskhetskontrakt, men bara vid återfödelse och med Fix D:s 2 kn i stället för
ribban 0,25 m/s, eftersom den väljer MÅLBRO och inte en notistoken. K1 själv
är oförändrad.

**K13b — `båda`.** Öppningskortet beskriver ÖPPNINGEN, inte ledaren:
`payload.eventDirection` mäts på HELA medlemsmängden och blir `mixed` vid en
mötande konvoj. `??` (inte `||`) skyddar `mixed` mot fallbacken; `null` =
ingen medlem har låst ruttriktning ⇒ ledarens `direction` bär tokenen.

**K4 — kajgrindens nettogolv:** se §Trigger-punktens två grenar ovan (ETT golv,
`NET_APPROACH_M` 40 m; ben (a) bär bara "netto okänt").

**K12 — passed-hold-hybriden (`_hasRecentTargetPassage`, app.js:4661).** Tiden
är TAKET, beviset är GOLVET: fönstervillkoret (`PASSED_HOLD_MS`) är oförändrat,
men hållningen får släppas i FÖRTID när utfärden är BEVISAD
(`_passedHoldDepartureProven`) — tre nödvändiga villkor: (1) bortom brolinjen
på färdriktningens sida med minst `PASSED_HOLD_RELEASE_BEYOND_M` (100 m, mätt
längs kanalaxeln), (2) sog ≥ `MINIMUM_VIABLE_SPEED` (en stillaliggande båt
bortom bron hålls kvar — bron kan stå öppen för henne, och utan fartkravet
kunde GPS-jitter fabricera villkor 3), (3) avståndet till bron ökade mellan två
på varandra följande fixar. Serien lagras i en APP-LOKAL karta
(`_passedHoldDistances`, bounded till båtarna i fönstret) — inte som ett nytt
vessel-fält, eftersom `_findRelevantBoatsForBridgeText` har en egen fältlista
(fältlist-fällan). Predikatet är rent SLÄPPANDE: allt obevisat ⇒ hållningen
behålls, så ändringen kan bara KORTA en hållning, aldrig förlänga.

**K18 del 2 — stale-svepet (`VesselDataService.sweepStaleVessels`).**
30-minutersbackstoppen är en GREN inne i `removeVessel` och kunde bara
utvärderas när en cleanup-timer redan brunnit ned; fältdygnet skrev själv "35
minutes" och "36 minutes" mot en 30-minuterströskel. Svepet FLYTTAR INTE grenen
— det gör den NÅBAR: hälsoticket (60 s) anropar `removeVessel(mmsi, 'timeout')`
för fartyg där `max(timestamp, lastPositionUpdate)` passerat
`STALE_AIS_TIMEOUT_MS`, och grenen sätter `staleAisForcedRemoval` själv, så
gravgate, protection-bypass och completed-bokföring behåller exakt dagens
semantik. VILKA som tas bort är oförändrat, bara NÄR (30–31 min i stället för
34–36). **Ingen injicerbar klocka:** svepet och grenen läser BÅDA `Date.now()`
— en `now`-parameter gick isär från grenen och kunde få svepet att FÖRLÄNGA ett
fartygs liv via protection-zonen. Tester styr tiden med `jest.setSystemTime`.

**K20a — batch-settle på ledarvalet (`_leadIsUnsettled`,
BridgeOpeningService:1631).** Ett fix avfyrar direkt mitt i AISHub-pollens
utspridning (`EMIT_SPREAD_MS` 150 ms) och `_fire` väljer ledande båt på
armarnas LAGRADE `distanceM` — som kan vara olika gamla (K20-defekten). Grinden
SKJUTER UPP avfyrningen ett tick när alla fyra leden håller: (1) `firedBy ===
'fix'`, (2) `_observationGapMs <= BATCH_SETTLE_MS` (2 × `EMIT_SPREAD_MS` =
300 ms — 53 % av AISHub-luckorna ligger under 300 ms mot 0,28 % av
aisstream-luckorna, och gränsen ligger 217× under pollperioden så den kan aldrig
spänna två poller), (3) ledaren uppdaterades i DETTA meddelande
(`lead.lastSeenAt === now`) och (4) ledaren är inte själv förfallen. Måttet
`_observationGapMs` skrivs BARA i `observeVessel` och sätts till `Infinity` i
`notePassage`, så batchledet är explicit inert i passagevägen. Ledarvalet är
rått `arm.distanceM` i `_leadOf`, delat av `_fire` och grinden — ingen
projektion. Garantin: händelsen står kvar orörd (`firedAt = null`) och prövas
igen vid nästa utvärdering; enda undantaget är om en medlems målbropassage
registreras inne i fönstret, och då är varningen ändå obsolet enligt
avfyrspärren (`BridgeOpeningService:1018`).

### bridge_opening_soon — det PROAKTIVA lagret (etapp 6, 2026-08-03)

Andra flow-kortet på app-nivå, **helt additivt**: rör varken boat_near-dedupen,
bridge_text eller något befintligt facit. boat_near är REAKTIVT (notisen kräver
ett fix inne i 300 m-zonen) och tappar därför exakt de öppningar där båten
tystnar på slutsträckan. Det här lagret varnar per **MÅLBRO** i stället för per
båt.

- **Ägare:** `lib/services/BridgeOpeningService.js` (ren service, inga
  Homey-importer, allt injicerat). Läser BEFINTLIGA vessel-fält (`targetBridge`,
  `_hasMovementProof`, `_moored`, `_routeDirection`, `_finalTargetDirection`,
  `passedAt`, `etaMinutes`) och skapar **inga nya** — armarna lever i servicens
  egen Map, inte på fartygsobjektet (fältlist-fällans 14:e potentiella offer
  undveks medvetet; armen överlever dessutom att fartyget timeout:as, vilket är
  hela designfallet).
- **Injektioner från app.js** (`onInit`, :410): `getDirection` →
  `_getDirectionString`, `isQuayWobbler` → `_isBridgeOpeningQuayWobbler`,
  `getVesselName` → `_lookupVesselName` (B1), `onWarning` →
  `_onBridgeOpeningWarning`, `onCoverage` → `_onBridgeOpeningCoverage`.
  Matningen sker i `_observeBridgeOpening` (:1218) från `_onVesselEntered`/
  `_onVesselUpdated`, direkt efter `_noteQuayStability`.
- **TICK-DOKTRINEN:** servicen äger **INGA timers**. `tick()` anropas från den
  BEFINTLIGA 30 s-watchdogen i `_initializeCoalescingSystem`, och anropet MÅSTE
  ligga FÖRE watchdogens tomkanals-retur — annars dör deadline-motorn exakt när
  den behövs (båten timeout:ad, kanalen tom).
- **KLOCKDOMÄNEN:** armens ankare är `min(fixTs, timestamp)` (fysik/fusion,
  §mux) — inte mottagningstiden. Ankaret klampas åt båda håll: framtid ⇒ `now`,
  äldre än `BRIDGE_OPENING.MAX_FIX_ANCHOR_AGE_MS` (12 min = fusionens
  åldersgrind) ⇒ `now − 12 min`.
- **Tre mekanismer:** (a) bro-centrerade öppningshändelser — flera samtidiga
  händelser per bro, medlemskap per arm mot dig9:s konvojfönster; (b) deadline
  ("äggklockan") — tidigast möjliga ankomst = `avstånd / DEADLINE_MAX_SPEED_KN`
  från FIXETS tid, minus `WARNING_LEAD_MS`; (c) tidig beväpning (2500 m), sen
  avfyrning. **Tystnad avväpnar aldrig** — bara motbevis (passage, U-sväng,
  förtöjning >600 m, bron bakom fartyget, hysteresrelease >3000 m).
- **Konvojtäckningen är TIDSBEGRÄNSAD:** en absorberad arm släpps igen om
  öppningen hon knöts till passerat utan henne (`referenceArrival +
  CONVOY_WINDOW_MS`), och kan då seeda en egen varning. Utan det blev en
  absorberad båt permanent tystad. Sedan K-familjen (2026-11-04) avgör
  `_coverageVerdict` släppet: (a) **bakkanten** — efter händelsens första
  passage släpps armen redan på det färska, GPS-rena fix vars förväntade
  ankomst ligger bortom det som slutar först av täckningen (`coverUntilMs`)
  och U2-fönstret kring den verkliga korsningen, och hon varnas på sin egen
  deadline ur samma fix; (b) **vid täckningsslut** hålls armen kvar (`OPENING_RECOVER_HOLD`,
  nästa fix avgör) om bron ligger bakom henne (avväpnas som passage), om armen
  är fryst, om ankomstfysik saknas, om hon låg under bron (≤
  `UNDER_BRIDGE_SET_DISTANCE`, i rörelse) med ankomst inom täckningen, eller om
  kursen leder bort från bron utanför väntzonen. Första passagens tid är den
  skattade korsningen (`_crossingEstimate`), inte bokföringstiden; den styr
  medlemskapet och bakkanten. Täckningsslutet räknas fortfarande från
  bokföringen, så en tyst båt släpps som förut. En ny båt som bara på grund av
  korsningen får en egen händelse, men som upptäcks under två tick före sin
  ankomst, absorberas som förut (`_anchorFloorHost`, golvet). Se §H29/H30 för
  vad som medvetet inte är grindar och för U17.
- **Returresan är en egen öppning (U15, användarbeslut 2026-11-04):** varje
  bokförd passage av en beväpnad båt skrivs i servicens returminne
  (`_passageMemory`, mmsi och bro, skrivs i `_recordPassage` även när armen
  saknar händelse). Hennes nästa arm mot samma bro är en returarm
  (`returnAfterPassage`). Ingen avfyrad händelse som beskriver öppningen hon
  redan passerat får täcka returen, inte ens inom konvojfönstret
  (`_describesPassedOpening`): (a) hon passerade själv i den, (b) dess
  referensankomst (första verkliga passagen, annars prognosen när varningen
  gick ut) ligger inom `CONVOY_WINDOW_MS` från hennes passage, alltså dig9:s
  definition av samma öppning, eller (c) referensen saknas och varningen gick
  vid eller före hennes passage. Två händelser kan beskriva samma fysiska
  öppning: värld 936 (den andra varningen gick före hennes passage) och dess
  spegelbild (den gick efter, och den andra båten korsar 75 s efter henne).
  En varning för en SENARE öppning, mer än ett konvojfönster från hennes
  passage, täcker returen som vanligt (U2), oavsett om den gick före eller
  efter passagen. `_releaseReturnCoverage` prövar villkoren vid varje värdval i
  `_bindLooseArms` och släpper också en retur som redan absorberats, så det
  gäller även när den andra båten korsar först efter att returarmen skapats.
  Returminnet är frikopplat från händelsestädningen
  (`_prunePassageMemory`): en post lever minst ett konvojfönster och sedan så
  länge någon levande händelse beskriver hennes passerade öppning. Förut lästes
  passagen ur hennes egen händelse, och runt dess städning avgjorde tickens fas
  (omgranskningen 2026-11-05). Inget ledtidsgolv (dirigentens beslut
  2026-11-05): returen får sin egen varning även under 2 × `TICK_INTERVAL_MS`
  före ankomsten. Upptäcks returen först vid eller efter korsningen
  (värld 227) kommer varningen sent; det är riktningslogikens kända gräns
  (U18), inte konvojens. En båt som vänder FÖRE bron eller ligger och väntar
  har ingen passage och stannar i sin öppning (U2: inga andrapåminnelser). En
  armlös passage bokförs inte, som i resten av öppningslagret. Kontraktet är
  INV-21:s returresa (`invariants.js`).
- **"Hölls vid en tidigare bro" avgörs av båtens egna fix (F09, 2026-11-04):**
  regeln från a8d7b76 (en varning som gick medan båten hölls vid en tidigare
  bro täcker inte hennes senare ankomst; AKIRA-testet) avgörs vid hennes första
  egna fix efter varningen, eller när spärren löper ut i tystnad
  (`_releaseWarningsWhileHeld`). Varningen släpps om (1) ett eget fix efter
  varningen visade henne hållen, (2) hennes nästa fix kom mer än
  `TICK_INTERVAL_MS` (30 s) efter varningen medan spärren gällde
  (`heldThroughMs`, skrivs bara av hennes fix i `_noteHoldEnd`), eller (3)
  spärren löpte ut i tystnad efter varningen (`_silentHoldEnd`). "Efter
  varningen" i (1) är bearbetningsordning (`_orderSeq`, `heldSeenOrder` mot
  `firedOrder`), så ett fix i samma millisekund som varningen får samma svar
  vid varje utvärdering. Medan spärren gäller kan bara konvojvärden absorbera
  henne i en avfyrad händelse. Förut släpptes varningen vid varje
  utvärdering medan spärren gällde, så halvminutstickens fas avgjorde
  (20260710-13h: VIRGO fick en extra varning i 15 av 45 faser; första
  K2-versionen gav PILOT 761 en annan varningstid i 6 av 45). Nu avviker 0 av
  45 faser, och bankens svep (24 korpusar × 30 faser) har 0 avvikelser.
  **Kvar står** att konvojundantaget (`_sharesMovingConvoy`, oförändrat)
  prövas vid första utvärderingen efter varningen. Är den en tick före
  hennes nästa fix avgör hennes fix från före varningen. Att flytta beslutet
  till varningsögonblicket gav en miss i buggjägarens värld 276, och att
  vänta på hennes nästa fix bröt den låsta gemensamma brokön
  (`opening-shared-queue-convoy`). Vägen stängs bäst genom att en given
  konvojtäckning kan omprövas mot hennes nästa fix. Samspelet med villkor (2)
  och (3): utan en tick före hennes nästa fix släpper (2) eller (3) varningen
  vid hennes fix eller när spärren tar slut, och med en sådan tick kan
  konvojundantaget i stället absorbera henne på det äldre fixet. Granskarens
  fasfuzz (3 × 3000 köscenarier vid Järnvägsbron, 10 faser) gav 125–151
  fasberoende scenarier per 3000 på 7699cbe och 25–34 med rättningen, alla via
  konvojundantaget (0 utan det). 7 av 9000 är fasberoende bara med
  rättningen, till exempel seed 11 scenario 62: följaren absorberas vid fas
  3,3–15,5 s och får egen varning vid övriga faser. Restklassen är registrerad
  för motorn som känd och öppen.
- **Dedup i TVÅ lager (app.js):** `_firedOpeningEvents` (eventId, sessionslokal)
  och `persistent_opening_warnings` (`bro|mmsi|riktning`, 10 min, ÖVER omstart
  — v1 persisterar inga armar, så en omstart mitt i en anflygning varnade annars
  om för samma öppning).
- **Grindar:** `npm run replay:openings` (O1 täckning / O2 fantomtak / O2b fantomer mot rådatafacit, informativ (S14) /
  O3 nattkontroll), `opening-distribution.json` (O5, bro:riktning-multiset per
  korpus, jämförs i `runAllCorpora`), INV-21 (WARN), och — före varje
  korpuslåsning — fassvepet `npm run replay:phase` (VALIDATION.md §Fältprov,
  steg 4), som gatar öppningsdimensionen `Bro#n → ledande/riktning/eta/källa`
  mot fasförskjuten korpusstart.
- **KÄND DEFEKT, EJ ÅTGÄRDAD (K20, fältprov 10 2026-08-19):** ett fix avfyrar
  direkt (`_evaluateBridge(..., 'fix', ...)`) mitt i AISHub-pollens utspridning
  (`EMIT_SPREAD_MS` 150 ms), och `_fire` väljer ledande båt på armarnas LAGRADE
  `distanceM` — som kan vara olika gamla. I 19/8-korpusen valde basreplayn
  TONGA:s 69 s gamla 1308 m fast hennes EGEN rad 149 ms senare i samma poll gav
  1165 m: fel ledande båt, och därmed fel riktning och fel ETA på kortet. Följd:
  öppningsdimensionen är KLOCKFASKÄNSLIG — 5–20 s förskjuten korpusstart byter
  kortets samtliga fält (boat_near-nyckelmultiseten var däremot exakt i alla
  fasvarianter). Fixen — uppdatera alla armar ur den aktuella pollbatchen INNAN
  ledaren väljs, eller välj ledaren på färskaste fix per fartyg — flyttar
  öppningsfacit och hör därför hemma i en egen, mätt commit (H-4b-liggaren).

### Övriga Flow-/notisytor

- **boat_at_bridge (villkorskort)** — run-listener app.js:4785–4906: sant om
  NÅGOT fartyg är ≤300 m från vald bro ('any' stöds, :4862–4869); F36 räknar
  trigger-punkter direkt mot TRIGGER_POINTS (:4887–4902).
- **Anslutningsnotiser** — `_notifyConnectionIssue` (:1769): timeline-notis max
  1/24 h (:1771–1776); vid max-reconnects (:1801), auth-fel (:1818) och saknad
  API-nyckel (:1852, :5015). connected/disconnected ger ENBART connection_status.

## 4. Tillståndsmaskiner

### Target-livscykeln (VDS)

- Tilldelning: `_shouldAssignTargetBridge` (:1753, kräver bl.a. rörelsebevis,
  ej `_moored`) → `_calculateTargetBridge` (:2026, COG-riktning + position).
- **M3 (rättningskampanjen varv 2, familj C, 2026-11-09): en återfödd båt med kurs i
  dödbandet får målbro ur förflyttningen.**
  - *Felet.* `_calculateTargetBridge` avstår vid kurs 46–134° och 226–314° (F18). En
    återfödd båt saknar ruttlås, och svepets lås (`_checkSkippedBridgesFallback`) kom
    först efter `_observeBridgeOpening` i samma tick. Ingen målbro gav ingen arm och
    ingen deadline när båten tystnade. Buggjägarens värld 756: FREJA korsade
    Stridsbergsbron ovarnad under ett AIS-avbrott, fast deadlinen hade gått 400 s före
    korsningen. Nästa fix räddade henne inte heller: `_calculateTargetBridge` följer
    låset bara när kursen SAKNAS (FP8), inte när den ligger i dödbandet.
  - *Rättningen.* Blir målbron null i ny-båtsgrenen och saknas lås, prövas
    `_rebirthTransitDirection`. Den läser K1-mätningen mot sist kända position ur samma
    meddelande (`_rebirthNorthBase`, ts-kontraktet från `_freshNorthProgressMps`) och
    kräver: (1) kursen ligger i ett dödband, (2) sog ≥ `FIX_D_MIN_SOG` (2,0 kn),
    (3) nettofarten i nordled ≥ 2 kn, (4) kursens sida stämmer med förflyttningen
    (östra dödbandet norrut, västra, alltså Fix D:s breda sydband, söderut). Då låses
    riktningen, och `_calculateTargetBridge(vessel, dir)` väljer målbron. Den målbron
    prövas också mot kajgrinden (`_slowInitialQuayApproachNeedsProof`, som annars
    räknar sin målbro ur kursen och därför är stum vid dödbandskurs), så en båt som
    återvänder till sin belagda kajplats hålls som förut. Blir det ingen målbro släpps
    låset igen.
  - *Ingen gissning (F18).* Riktningen kommer ur en mätt förflyttning mellan två
    observerade positioner, inte ur kursen. Ribban är högre än för en kurs i banden,
    som ger målbro utan något förflyttningsbevis alls. Kanalen går 22–36° mellan
    broarna, så 2 kn i nordled är minst 2 kn längs farleden.
  - *Ordningen mot svepet.* Låser svepet alls, låser det samma riktning: samma post i
    `_lastKnownPositions` och samma tecken. Vid ≥ 100 m förflyttning har svepet
    `rebornEvidence`, och under det avstår svepets portgissning vid dödbandskurs. Saknar
    svepets fönster kandidatbroar returnerar svepet före låset (PELLE i buggjägarens
    värld 977); då är M3:s lås det enda, och det släpps när ingen målbro blir. Krav 4
    gör att R1/F15:s release aldrig hade släppt låset. Svepet ser låset och låser inte
    en gång till, så ticken har en riktningskälla.
  - *Fältdata* (bankens 24 korpusar, alla fixpar med 65–900 s mellanrum, klassade mot
    gt-passages; `faltfordelning.py` i varv 2:s familj C). Med sog ≥ 2 och kurs i
    dödbandet låser 2 kn 56 av 121 transitpar och 0 av 50 övriga. Det högsta övriga
    paret når 1,68 kn, och motsatt riktning högst 1,14 kn. Fartkravet tar bort VIRGO
    (20260710-13h: +2,08 kn netto i 1,4 kn med kurs 63°, korsade sedan söderut).
    Kurssidan tar bort ett transitpar (265800960 i 20260702-2h, som cirklade i kön vid
    Järnvägsbron med kurs 242°). Kajavgången NORDIC SOLA (20260713-41h, 0,84 kn netto i
    3,2 kn) ligger en faktor 2,4 under ribban; skissens första variant med bara K1:s
    0,25 m/s gav henne målbro och flyttade tre golden-text-rader till sämre. I appen
    når regeln i banken bara SY FREYJA (20260702-2h, norr om Stridsbergsbron på väg ut,
    ingen målbro och låset släpps), och banken är bitlik (26 av 26 med och utan
    monitoring).
  - *Kända gränser.* (a) En återfödd båt UTAN kurs (FP8:s fall) omfattas inte; hon får
    målbro först när låset finns, på nästa fix. (b) En kontinuerligt spårad båt med
    kurs i dödbandet får som förut målbro först när kursen lämnar bandet. (c) En äkta
    transit under 2 kn netto får ingen målbro här (54 % av bankens dödbandstransiter
    med sog ≥ 2). (d) Basen saknar fixtid (V8): en gammal basfix gör dt för kort och
    överskattar nordfarten med faktorn 1 + (basens fixålder − återfödelsens)/dt, ≤ 1,5
    vid fältets p90-fixålder och 2,8 vid nattens max. Tecknet, alltså riktningen, kan
    inte bli fel, men i AISHub- och 'both'-läge kan en långsam båt få ett mål hon inte
    transiterar mot. Förslag till en senare runda: låt `_onVesselRemoved` spara
    `fixTs`/`fixFeed` i posten och `_rebirthNorthBase` föra dem vidare, så att
    `fixDtMs` mäter på fixklockan; K1:s Kanalinfartsregel vinner på samma sak.
    (e) Dödbandet skyddar inte längre en återfödd båt mot falsklarm i klasser där en båt
    med kurs i banden redan får målbro (granskningen 2026-11-09, världarna W1–W5):
    vändning genom samma sidas dödband vid återfödelsen (W1), första ankomst till Kajen
    eller Gästhamnen utan kajhistorik (W2, W3), GPS-hopp med fartspik åt kursens sida
    (W4) och V8 (W5). Varje klass ger samma utfall som tvillingen med kurs i banden på
    c14938f, alltså ett falsklarm i stället för en missad öppning. W1 och W3 är låsta i
    testets steg 7. En zonvakt bara för M3 avråds: farleden går 7–52 m från
    kajplatserna (FP9-H'), så den återinför missen för äkta transiter förbi kajerna.
    Regressionstest: `tests/m3-aterfodd-dodband-2026-11-09.test.js` och de två
    syntetiska scenarierna `återfödd-i-dödbandet-…`.
- Retention: samma `_shouldAssignTargetBridge`, med 2-READINGS: målbron ska ha
  närmats ≥ `MIN_APPROACH_DISTANCE` (10 m) när den ligger > 300 m bort.
  Misslyckas valideringen utanför skyddszonen startar en 60 s nådafrist
  (`_targetRemovalGrace`), och målbron tas bort först när fristen löpt ut utan
  lyckad validering. Kö-zonsvakten (≤ 600 m från målbron, `_isInTargetQueueZone`)
  och skyddszonen håller kvar målbron. ACCELERATED-grenen prövar INTE 2-READINGS,
  bara fart- och kursgrindarna mot NÄRMASTE bro (ingen fartgräns inom 300 m,
  0,1 kn vid 300–500 m) och ANCHOR_BLOCK, som bara gäller en båt som passerat en
  bro och har KÄND fart.
  **F05 (familj M, rättningskampanjen 2026-11-04): retention och tilldelning
  dömer med samma närmandebevis** (`_targetApproachEvidence`: ≥ 10 m från förra
  fixen ELLER fönstrets start, det största närmandet gäller). Två speglade delar:
  1. *Retentionen.* Kravet per fix var kadensberoende (10 m per 30 s ≈ 0,65 kn,
     per 10 s ≈ 1,9 kn). Medan en nådafrist lever är fönstrets start fristens
     startposition (`vessel._graceApproachRef`, satt av `_stampGraceApproachRef`
     när fristen föds och när M6 stämplar om den; läses via
     `_graceApproachReference`, som kräver att fristens post lever). Det största
     närmandet gör att fönstret bara kan LÄGGA TILL godkännanden — med fristens
     start som enda referens underkändes en båt som gled bort och sedan vände mot
     målbron (granskningen 2026-11-04, slingsvepet).
  2. *Återinträdet.* Tog retentionen bort målbron för OTILLRÄCKLIG rörelse
     (`_armReentryApproachProof`, sätter `vessel._reentryApproachRef`; en tydlig
     bortrörelse ≥ 10 m beväpnar inte, revision 3), lägger ACCELERATED tillbaka
     SAMMA bro först när samma bevis finns (`_reentryNeedsProof`) — i ett fönster
     lika långt som fristen, som glider i `_maintainReentryApproachProof` och
     förbrukas med en målbro.
  3. *Fartprovet (revision 3, 2026-11-05).* Retentionen dömer fartgrindarna
     (0,7 kn > 500 m och 0,1 kn 300–500 m från närmaste bro, utbrutna ordagrant
     till `_targetSpeedGate`) över TID: målbron tas bort först när valideringen
     fallerat oavbrutet i mer än fristen. Föll borttagningen på fartgrinden
     (`_armReentrySpeedProof`; inte när ANCHOR_BLOCK fällde samma prov, där är
     det FIX B:s per-fix-regel som gäller) läggs samma bro tillbaka först när
     grinden HÅLLIT oavbrutet i mer än fristen (`vessel._reentrySpeedProof`,
     loppet räknas i `_maintainReentrySpeedProof`). Förut räckte ett enda
     fartprov över 0,7 kn (granskarens klasser G och H, 0,6–0,75 kn långt från
     broar).
     Retentionens undantag gäller: målbron inom 300 m, skyddszonen kring en
     opasserad bro eller målbron (med F21-regeln) och kö-zonen. En bekräftad
     vändning hoppar över beviset, precis som 2-READINGS, och det gör också
     meddelandets EGEN fart (`_rawPositionSog`, inte den burna `sog`) på minst
     `FIX_D_MIN_SOG` (2,0 kn): en avgångs första fix har ofta full fart men
     oförändrad position, och att vänta på 10 m där fördröjde avgången en fix
     (72 h-soaken).
  Etiketten i `_getTargetRemovalReason` mäter med samma bevis som beslutet.
  Inga nya konstanter: nådafristen (`TARGET_REMOVAL_GRACE_PERIOD`) och närzonen
  (`TWO_READINGS_NEAR_TARGET_M`) är de gamla talen, flyttade till modulnivå.
  Felbilden var "Inga båtar" inklämt mellan två likadana texter (INV-14
  DEFAULT-FLASH): WILMA 0,5 kn norr om Klaffbron (F21 häver skyddszonen vid en
  passerad bro), krypare 300–500 m från närmaste bro och båtar utan fartgivare.
  Mätt: banken byte-identisk (24 av 24 korpusar, alla 69 målbyten med
  etiketter). Kända gränser (beslutade 2026-11-05, registreras i motorn; ingen
  hysteres införs):
  (a) brusbandet kring varje tröskel — 10 m per fönster ≈ 0,22 kn vid 30 s,
      0,28 kn vid 10 s och 0,16 kn vid 60 s kadens, och fartgrindens 0,7 kn —
      där GPS- eller fartbrus avgör utfallet åt båda hållen;
  (b) ANCHOR_BLOCK:s 0,3 kn med fartbrus (FIX B: bedöms över fristen i
      retentionen men per fix i tilldelningen, medvetet orört);
  (c) en sog=null-båt med GPS-brus på ±8 m eller mer kan få ett skenbart
      närmande på 10 m;
  (d) PRISET: en avgång under `FIX_D_MIN_SOG` (2,0 kn) kan få målbron senare än
      förut — en fix om avgångens första fix inte flyttat sig (närmandebeviset),
      och upp till tre fixar (> 60 s) efter ett stopp mer än 300 m från alla
      broar utan passerad bro (fartprovet). I svepen 30–60 s, utan ändrade
      notiser, öppningsvarningar eller passager.
- Transition: `_applyTargetTransition` (:2392–2627). `previousTarget` läses från
  det LEVANDE objektet (S-F3-följdfixen, :2402). Vid byte till nästa bro:
  targetBridge muteras, `_finalTarget*` nollas, **hela ETA-serien nollställs**
  (:2427–2437: etaMinutes, `_etaPublishedValue`, alla extrapolationsflaggor inkl.
  `_etaExhaustedAtMs`, `_isImminentAtTargetBridge=false`) + `clearVesselETAHistory`
  (:2453); riktningen låses (`_lockRouteDirection`:2439). Vid TARGET_END
  (:2459–2494): targetBridge=null, `_finalTargetBridge`/`_finalTargetDirection`
  sätts, spårning fortsätter mot Stallbackabron resp. Olidebron+Kanalinfarten;
  **B6**: samma ETA-/imminent-nollning görs ÄVEN här (:2476–2484 — annars
  zombie-"strax"). Passagen ankras (`_anchorPassageTimestamp`:4559, anrop :2502)
  med RC9-kronologivakt (:2520–2525).
- **Gap-kedjan**: `_handleTargetBridgeTransition` (:2223) omvärderar efter
  bekräftad passage det NYA targetet mot SAMMA AIS-segment (`_gapChainDepth`,
  max djup 3, :2311–2312 — ett stort gap kan korsa flera broar).
- **`_pendingTarget`**: target-byte fångat i 300 m-skyddszonen skjuts upp
  (`{source, next, since}`) tills zonen lämnats/grace löpt ut (:2229–2263;
  sätts :2358–2370, :3172–3176; rensas vid moored-demote :132).
- **Target-protection** (`_checkTargetBridgeProtection`, VDS). *Radnumren i det
  här stycket är MEDVETET ersatta av metodnamn: de gamla (3963–4058, 3989–4007,
  4064–4081, 4092–4109, 4161) hade drivit ~2 000 rader fel och pekade på
  orelaterad kod — granskningen 2026-08-22.*
  Aktivering om något av: ≤300 m från target; GPS-event
  (`_detectGPSEventProtection`: `_gpsJumpDetected`, `_positionUncertain`, ELLER
  förflyttning över det **tidsnormaliserade** taket
  `max(200 m, maxfart × dt × 2,0)` — K19 2026-08-22, se nedan); manöver
  (`_detectManeuverProtection`: COG-ändring >45° ELLER fartändring >2 kn);
  passage <60 s; koordination aktiv. Aktiv protection ÅTERSTÄLLER targetBridge
  om något ändrat den.
  **K19 (2026-08-22)**: rörelsebenet var ett naket `movementDistance > 200`
  utan tidsnormalisering — systerhålet till GJ-1 i
  `GPSJumpGateService._isVesselStable`. Vid AISHubs kadens (fix-Δ p50 152 s)
  motsvarar 200 m bara 2,6 kn, alltså vanlig kanalfart: benet slog till 836
  gånger över korpusarna, 835 av dem fartkonsistenta enligt GPSJumpAnalyzers
  eget kriterium. Nu: tillåten förflyttning = maxfart × förfluten tid ×
  2,0-marginalen, med **200 m som GOLV** (`Math.max`) ⇒ grinden kan bara bli
  strängare, aldrig slappare. Tidsbasen är fixklockan
  (`GPSJumpAnalyzer.fixDtMs`) med mottagnings-Δ som fallback — och den fallbacken
  kräver att BÅDA sidorna har tidsstämpel, annars gäller golvet (utan den vakten
  blev dt hela epoken och grinden fail-open). Fartgolv: 1 kn när båda samplen
  har sog, 5 kn när EN sida saknar sog (GJ-2/G-2-läxan). Andrahandseffekt, mätt:
  gps-event var den DOMINERANDE släppmekanismen för protection, så skydden som
  ändå aktiveras lever längre (andel som når 5 min-taket 50 % → 63 %).
  Deaktivering (`_shouldDeactivateProtection`): **B3** — skyddad bro i
  `passedBridges` ⇒ OMEDELBART; >5 min alltid; >500 m + inga event
  + >1 min; GPS löst + >30 s; koordination löst + >15 s. Släpps även vid
  inferens (`'missed-target-inferred'`, `'inferred-passage'`), Fix D
  och NEW_JOURNEY via publika `clearTargetProtection`
  (anrop app.js:944 — annars RESTORE:ar skyddet gamla resans bro).
  **RC9-origin-vakten** `_targetOriginSideOk` (:3501, används :3469/:3652):
  RESEANKARET måste ligga på rätt sida om target för färdriktningen — stoppar
  fabricerad "bortom target"-inferens efter U-sväng.
  **H12 (2026-08-22) — RESEANKARE, inte episodankare.** Vakten (och
  Järnvägsbro-backfillens S-F6-villkor) läste tidigare EPISODANKARET
  `_firstSeenLat`, som skrivs EN gång per spårningsepisod och aldrig nollställs.
  På RETURBENET (kajvändning i MOORING_ZONES norr om Klaffbron, U-sväng i samma
  episod) pekade det på UTRESANS start, dvs. fel sida av den NYA resans målbro
  ⇒ `MISSED_TARGET_ORIGIN_SKIP` + `STALE_TARGET_CLEARED` i stället för
  `MISSED_TARGET_INFERRED`, tomt `_passageBackfills` och målbron aldrig bokförd.
  Båda vakterna läser nu `_journeyOriginLat` (fältet `_journeyStartLat`, med
  `_firstSeenLat` som FALLBACK; publik läsare `getJourneyOriginLat`). Ankaret
  skrivs av TVÅ vägar med olika kontrakt: `_anchorJourneyOrigin` HÅRT vid äkta
  resegränser (bekräftad reversal, app-lagrets NEW_JOURNEY via publika
  `anchorJourneyOrigin`; en vändning som bevisas av en återkorsning,
  `RE_CROSS_EVIDENCED`, ankras i återkorsningssegmentets start, B2 i varv 2, se
  U-svängspunkten nedan) och `_extendJourneyOrigin` MONOTONT vid måltilldelning
  (**H12-B** — måltilldelningen är ingen bevisad resegräns): behåll det
  extremaste av utgångsvärdet och tilldelningsläget i färdriktningen
  (nordresa ⇒ sydligast, sydresa ⇒ nordligast). Utgångsvärdet är reseankaret och
  när det saknas EPISODANKARET (**H12-B2**), så det första ankaret aldrig kan
  hamna FRAMFÖR episodstarten och origin-vakterna aldrig blir strängare än före
  H12. Returbenet ankras ändå om: i den NYA riktningen är kajläget per
  definition det extremaste.
- U-sväng: Fix D (VDS:137–265, sog ≥ 2.0 :149, 2-observations-debounce
  `_fixDPendingReversal` :196–231) nollar target mitt i resan; journey-reset
  rensar båda dedup-lagren (app.js:738–741). Post-resa: NEW_JOURNEY
  (app.js:897–952, debounce `_newJourneyPending`) nollar passedBridges + dedupe
  + target-protection för returresan och tilldelar målbron i samma tick (varv 2,
  se nedan).
- N1-resetten i `_confirmDirectionReversal` släpper broar framför båten i den nya
  riktningen. R1 (rättningskampanjen 2026-11-04, buggjägarens F10/W750): Fix D och
  positionsbevisets två ben bekräftar före tickens detektering, ofta på fixen bortom bron
  båten just korsat tillbaka. De skickar därför bekräftelsesegmentet
  (`_cleanReCrossSegmentStart`, GPS-rent), och en bro som segmentet korsar i den nya
  riktningen släpps också. Samma tick bokför returen som mellanbropassage (`no-target`),
  samma utfall som `RE_CROSS_EVIDENCED`. Korsningsbevisvägarna skickar inget segment;
  där är bron bakom den nya korsningen och behålls (AKIRA, Järnvägsbron ×2).
- `RE_CROSS_EVIDENCED` kräver rörelse i nuet: 2 kn, eller ett segment på minst 100 m för
  fartgivarlösa. R1 (granskningen 2026-11-04): en LÅNGSAM återkorsning direkt efter Fix D:s
  väntande fix bokförs i korsningsticken när alla fyra villkoren i `_slowReCrossEvidence`
  håller: (1) väntan i korsningens riktning sattes på segmentets startfix, och startfixet är
  förra fixet självt (Anomali 18:s två observationer blir två på varandra följande fixar);
  (2) korsningsfixets EGEN fart (`GPSJumpAnalyzer.positionSog`, inte det framförda värdet) är
  minst `QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN` (1,0 kn); (3) segmentet är minst 100 m;
  (4) segmentets nettofart når 2 kn. Omgranskningen 2026-11-04 visade varför alla fyra behövs:
  med bara "färsk väntan (upp till 15 min) + 100 m" vände en VÄNTANDE båt på ett enda GPS-sprang
  (AQUILA i 20260601-41h med en inlagd outlier, och två syntetiska väntlägen; fixturerna
  `tests/fixtures/r1-omgr-*.jsonl` får inte vända). En outlier hos en stillaliggande båt bär
  båtens verkliga fart nära noll (S-F4), och en väntan med fixar emellan säger inget om rörelsen
  nu. Kvar som kända luckor (eget öppet kort, U-SVÄNG-LÅNGSAM-ÅTERKORSNING): en tät långsam
  korsning (segment < 100 m), en långsam vändning utan fix i 2 kn före korsningen, en korsning
  där båten stannar direkt efter bron (korsningsfixet under 1 kn), en väntan som är äldre än
  startfixet och två återkorsade broar i samma segment (bara den första bokförs). Där bokförs
  returen inte; testerna "KÄND LUCKA" i `tests/r1-usvang-aterkorsning-2026-11-04.test.js` visar
  dagens beteende.
- **U18 (användarbeslut 2026-11-04): Fix D kräver TVÅ positioner innan appen tror på en
  vändning, som förut (Anomali 18).** En retur med gles AIS, där den andra omvända positionen
  kommer först efter korsningen, får därför sin öppningsvarning sent eller inte alls; det är en
  känd gräns, inte ett fel (sju av buggjägarens U-svängsreturer i F01: värld 18, 134, 188, 227,
  353, 1181 och 1731: i alla sju kom bara EN omvänd position i minst 2 kn mellan vändningen och
  korsningen). Under debouncen bär notiser om broar framför båten det gamla låsets riktning
  (1731: "närmar sig Järnvägsbron" 11:01:04 söderut). U18 gäller öppningsvarningen och
  riktningen; returens bokföring i de kända luckorna ovan är ett eget öppet kort.
- **Målbron i samma tick som bekräftelsen (varv 2, familj A, 2026-11-09).** Två vägar
  bekräftade en vändning men lämnade måltilldelningen åt NÄSTA fix:
  - (M1) app-lagrets NEW_JOURNEY i `_onVesselUpdated`, som körs efter att `updateVessel`
    redan kört målbrokedjan för fixet. ACCELERATED-grenen gav där null på den avslutade
    resans riktning och passager (FIX Z och dess nordspegel);
  - (M2) `RE_CROSS_EVIDENCED` eller korsningsbeviset inne i målbrogrenen, där
    ACCELERATED-grenen ligger i samma else-if-kedja och hoppas över.

  Med gles AIS kom öppningsarmen och returvarningen därför 10–46 s före passagen eller
  inte alls (buggjägarens värld 936, 1208, 1274, 1316, 1317 och 1918). Båda vägarna
  anropar nu `VesselDataService.assignTargetAfterReversal`. Den kör ACCELERATED-grenens
  tilldelning för samma fix, med samma grindar som när Fix D bekräftar en vändning i
  ticken: `_shouldAssignTargetBridge` med det gamla målet ogiltigt, därefter
  `_selectAcceleratedTarget` och `_applyAcceleratedTarget`. De två metoderna är utbrutna
  ordagrant ur ACCELERATED-grenen, som själv använder dem. M2:s krok ligger efter
  mellanbroblocken i `updateVessel`, så att tickens segment prövas med båten mållös som
  förut; räknaren `_reversalSeq` i `_confirmDirectionReversal` visar att vändningen
  bekräftades inne i kedjan. M1:s anrop ligger sist i NEW_JOURNEY-resetten och följs av
  STEG 1:s bokföring (`_noteTargetBridgeChange`: ETA-historiken och borttagningstimern).
  U18 rörs inte: vändningen är redan bekräftad på två positioner, och ingen ny
  riktningskälla tillkommer.
  - **Riktningskontrollen** (granskningen 2026-11-09). Tillämpningen skulle låsa
    riktningen `positionDirection || _deriveAssignmentDirection`. Om den motsäger den
    nyss bekräftade vändningen vid `FIX_D_MIN_SOG` eller mer (`_routeLockVerdict`
    'override', C4b:s andra halva), avgör nästa fix målbron, som förut. Kurs och
    positionsbevis är då oense. Fallet är en enstaka GPS-utliggare strax efter en äkta
    passage: `RE_CROSS_EVIDENCED` vände båten på utliggaren, och kursen valde bron hon
    nyss passerat (latitud bakom linjen, kurs framåt). Granskarens prov med utliggare
    30–180 m bakåt (504 banor) gav 10 extra varningar, 8 med fantompassage. c14938f gav
    0, och kontrollen ger 0. Scenariot med seed 9715 prövar fallet. För M1 kan
    kontrollen inte slå till, eftersom NEW_JOURNEY låser ur samma kurs.
  - **Under-bro-vakten.** Ligger båten inom den nya målbrons under-bro-band
    (`UNDER_BRIDGE_CLEAR_DISTANCE`, 70 m), avgör nästa fix målbron, som förut. Där är
    brus och linjens läge av samma storlek, och `_calculateTargetBridge` väljer efter rå
    latitud medan broarna är snedställda. I U14-vakten med ±30 m brus låg
    bekräftelsefixet söder om Klaffbron i latitud men 7,9 m norr om linjen. Målbron
    blev bron vid båten, och nästa fix bokfördes som målbropassage med en extra varning.
    Ett svep över U14-vaktfamiljerna vid Klaffbron och Stridsbergsbron (504 banor) gav
    utan vakten 2 extra varningar och 5 fantompassager, med vakten inga.
    - För M1 är vakten det enda skyddet; U14-scenariot fäller utan den.
    - För M2 ligger den bakom riktningskontrollen: scenariot med seed 9713 fäller först
      när båda tas bort.
    - Inom 70 m behålls c14938f:s beteende, alltså vid gles AIS ofta ingen varning. I
      granskarens prov med 576 returer nära bron hade en variant utan vakt varnat för 138
      korsningar som förblir ovarnade: 115 med under 30 s ledtid, 22 med 30–60 s och 1 med
      62 s.
  - **B2.** En vändning som bevisas av en återkorsning ankrar reseankaret i
    återkorsningssegmentets start (`journeyStartAt`). Bron ligger strikt mellan segmentets
    start och båten, så den nya resan började på startens sida om bron. Med ankaret i nuet
    hoppade TARGET_END:s Järnvägsbroinferens (S-F6) över bron när tickens detektering inte
    bokfört återkorsningen (fixet på linjen, `UNDER_BRIDGE_CROSS_AMBIGUOUS`), och
    returnotisen vid Järnvägsbron försvann (värld 1317). Origin-vakterna (RC9, S-F6 och
    triggerpunktsvakten) dömer annorlunda bara för broar mellan segmentets start och
    båten, alltså broar som den nya resan bevisligen har korsat. Undantag
    (granskningen 2026-11-09): motsäger kursen i `FIX_D_MIN_SOG` eller mer
    återkorsningens riktning, är återkorsningen tvivelaktig, och ankaret sätts i nuet som
    förut. Det är samma oenighet som riktningskontrollen mäter, till exempel ett brusfix
    på linjen hos en båt som väntar och sedan kör vidare. Med ankaret på brusfixets sida
    tilldelade nästa fix i kursens riktning, och det monotona ankaret kunde inte flytta
    tillbaka förbi bron. Returnotisen vid Järnvägsbron försvann då i två svepbanor.
  - **Kvar.** En vändning som bekräftas efter `updateVessel` väntar fortfarande på nästa
    fix för sin målbro. Det gäller STEG 5:s GPS-grind (`registerConfirmedIntermediatePassage`
    via `_analyzeVesselPosition`) och skipped-bridges-failsafen (`applyInferredPassage`).
    Båda vägarna följer på en GPS-osäkerhet eller ett glapp, där ett fix till är försiktigt.
    Failsafen körs dessutom efter öppningslagret, så en målbro där hade ändå beväpnats
    först vid nästa fix. Vägarna gav ingen vändning i banken: 5 grindbekräftade passager
    på 482 h, ingen av dem en vändning.
  - **Kvar.** Låg återkorsningsfixet på linjen och har nästa fix redan passerat den nya
    målbron, bokförs mellanbron bara av TARGET_END:s Järnvägsbroinferens. För M2 är
    Järnvägsbron den enda mellanbro som kan ge en ny målbro; en återkorsning av Olidebron
    eller Stallbackabron leder ut ur kanalen. Spärren vid en tidigare bro
    (`_earlierBridgeAhead` i BridgeOpeningService) gäller nu redan från fixet efter
    vändningen, eftersom köbevisbokföringen kräver målbro. Returbåten behandlas då som
    vilken båt som helst med en tidigare bro framför målbron. På c14938f slapp hon spärren
    för nästa målbro, eftersom målbron kom ett fix sent. I svepet kom 90 av 103
    tidsflyttade varningar tidigare och 13 upp till 37 s senare, alla mot en målbro med
    Järnvägsbron emellan. I buggjägarens quick-värld 169 kom returens
    Stridsbergsbronvarning 123 s före korsningen i stället för 824 s. Ingen ledtid mot en
    sann korsning sjönk under 60 s. Spärrens avvägning är ägarfrågan M6.
  - **ETA-texten (U22).** ETA-kedjan är orörd, men ETA-historiken börjar ett fix
    tidigare, och utjämningen ger då en längre ETA i första notisen efter vändningen.
    Värld 936: "om 1 minut" blir "om 2 minuter" 154 m före bron (korsningen 46 s
    senare). Värld 1918: "strax" blir "om 1 minut" 97 m före (9 s senare). Värld 169: "om
    2 minuter" blir "om 3 minuter" 170 m före (43 s senare). Annan trafik med målbro i
    två fix får samma utjämning. Felet hör till de uppskjutna ETA-korten.
- **U19 (användarbeslut 2026-11-04): en planerad öppningsvarning skickas även när en
  obekräftad vändning väntar.** Deadlinemotorn avfyrar som vanligt medan
  `_fixDPendingReversal` väntar på sin andra observation; varningen hålls inte inne och stryks
  inte. Ett falsklarm när vändningen var äkta (ZELDA i värld 188: Stridsbergsbron#12 14:54:07,
  bekräftelsen först 14:54:48) väger lättare än en missad öppning när båten bara svängde till
  (AIR i 20260601-41h: Klaffbron#29 08:28:43 under en väntan, passage 08:41:02). S10-vakten
  (notisvägen) är oförändrad och gäller bara notiser om broar bakom båten.
- Svepets riktningslås (SISU) sätts som förut och bär svepets egna notiser, eftersom
  broarna i svepfönstret korsades netto åt svepets håll. När den rörelsebevisade levande
  kursen (`_dedupDirection` med `requireMovement`, Fix D:s band 135–314° söderut och 2 kn)
  säger motsatsen släpps låset efter svepet (`SKIPPED_BRIDGES_DIRECTION_LOCK_RELEASED`):
  båten har vänt i glappet (R1, F15 IRMA). Senare notiser bär den levande kursens token.
  Ligger kursen i 271–314° (Fix D:s sydband men tokenbandets dödband, FP8) blir den tokenen
  `unknown` tills kursen är entydig. Osäker kurs, fart under 2 kn och samma riktning låser
  som förut. Sedan M3 (varv 2, se §Target-livscykeln) kan VDS ha låst riktningen redan i
  ny-båtsgrenen, när förflyttningen sedan sist kända position bevisar transit. Då låser
  svepet inte, och releasen prövas inte. M3:s kurskrav släpper bara igenom kombinationer
  som releasen aldrig hade släppt, så där svepet hade låst blir utfallet detsamma. Saknar
  svepets fönster kandidatbroar låser svepet inte alls, och då är M3:s lås det enda.

### Passage-latch + under-bridge-hysteres (StatusService)

- `_isUnderBridge` (:407–657). Syntetiskt broöppningsfönster `_bridgeOpeningUntil`
  håller under-bridge (30 s, distansventil >300 m rensar; :409–458). Hysteres:
  SET ≤50 m, CLEAR <70 m (:541–543 mellanbro, :594–596 målbro; konstanter
  constants.js:52–53). **10-min force-clear** (:513–523): latch äldre än 10 min
  (UNDER_BRIDGE_MAX_DURATION_MS) → släpps och `return false` (annars re-sättes
  latchen omedelbart). **B5-frysning** (:502–510): vid AIS-gap (positionsålder
  >2 min) fryses ackumulerad under-bro-tid EN gång i `_underBridgeFrozenAccMs`,
  basen hålls mot den — väggtid under gapet räknas inte mot 10-min-taket;
  släpps (null) vid färsk position. FIX O (:546–569) kräver att "inväntar"
  visats mellan par-broarna Järnvägs/Strids. **Entry + sidbyteskrav**:
  `_underBridgeEntryLat/Lon` fångas när latchen sätts (:580–581, :602–603); vid
  latch-clear (:618–654) ankras passagen ENDAST om fartyget bytt sida om bron
  relativt entry (`hasChangedBridgeSide`, geometry.js:443; :636–644) —
  samma-sida-utglidning ankrar ingen passage (:645–649).
  **SEGMENTBEVIS (V2, A/B-natten 2026-08-03, `_noteUnderBridgeLineCross`):**
  entry↔exit-jämförelsen ser bara ändpunkterna, och vid tät sampling
  (dubbelkälla ~68 s) kan LATCH-fixen redan ligga bortom brolinjen — då är båda
  "sidorna" den bortre och en äkta passage lästes som kö-drift (TIM 2026-08-02:
  −68 m → +16 m → +123 m; både Olidebron och Järnvägsbron åts upp och
  Klaffbron-ETA:n klättrade 12→17 min i `progressive_route`). Varje
  konsekutivfix-segment under zonbesöket prövas därför mot brolinjen; korsar
  ett segment entydigt KORRIGERAS `_underBridgeEntryLat/Lon` till segmentets
  startpunkt (den sida båten kom ifrån) och bron stämplas i
  `_underBridgeCrossedBridge`. **Beslutet fattas fortfarande av entry↔exit —
  beviset flyttar bara ankaret.** Det är vad som gör kanteffekterna ofarliga:
  korrigeringen sker EN gång per zonbesök, så en U-sväng (AKIRA-låset) eller
  kajbrus tvärs linjen ger fortfarande samma sida ut ⇒ ingen ankring. Samma
  nettokrav gäller `geometry` METHOD 1, som läser stämpeln + ankaret
  (`zoneCrossProven`) som alternativ till sitt tvåsampels-`sideFlipped`;
  metoderna 4/5/6 är oförändrade.
  **Epsilonbekräftelse (P1, 2026-09-06):** ett verkligt teckenbyte vars
  slutpunkt ligger i ±10 m-bandet sparas som `_underBridgePendingCross`.
  Kandidaten ändrar inget passagebeslut förrän en ny fix bevisar entydigt
  motsatta sidor mot startpunkten. Båda farterna måste vara minst 0,3 kn i
  varje segment, hela spåret högst 400 m och kandidaten högst 2 minuter.
  GPS-hopp/osäker position, stillhet, källgrind, nytt zonbesök och brobyte
  bryter kedjan. Fältlistan bevarar kandidaten över AIS-objektbyten.
  Råfallen PRIMA LADY 2026-08-24 och ANDREA 2026-08-05 återfår Olidebron;
  deras växande bakåtben i Klaffbron-ETA:n försvinner. U-svängens nettokrav
  och samtliga befintliga passagegrindar består.
  **Uppskjutna pass (F08, 2026-11-04, `_noteDeferredZoneEntryCross`):** vid det
  nära broparet når passet vid inträdesfixen ofta inte INTERMEDIATE_UNDER.
  Phase 3-hållningen för den nyss passerade bron returnerar före grenen, FIX U:s
  tvingade väntan returnerar före hela `_isUnderBridge`, och rensningspasset
  (CurrentBridgeManager Regel 0) väljer inte nästa bro. Beviset prövades då
  först i ett senare pass vid samma position, oftast UI-uppdateringen. Om det
  passet hann före nästa AIS-fix berodde på klockfasen (SINE BRES 20260917-16h
  tappade Järnvägspassagen 02:27:17 i fasvarianterna δ −2,5/−7 s). Nu prövas
  inträdessegmentet i det pass som gör uppskjutningen, med samma startpunkt och
  samma grindar som INTERMEDIATE_UNDER: ≤ `UNDER_BRIDGE_SET_DISTANCE` från bron,
  inte en passerad eller S-3-spärrad bro och inte Stallbackabron. Föregående
  observation läses utan att förbrukas. FIX O-spärren (under-bro väntar tills
  "inväntar" visats) skjuter upp grenen på samma sätt och prövar också beviset.
  **Beviset sparas till zonbesöket (granskningen 2026-11-04):** det första
  ordinarie passet efter uppskjutningen startar ofta ett nytt zonbesök vid
  samma bro och nollar beviset, antingen genom HYSTERESIS_RESET (målbytet i
  passagepasset sågs aldrig av hållningen eller FIX U) eller genom ett nytt
  INTERMEDIATE_UNDER med släppt lås. Låg nästa fix kvar i zonen prövades sedan
  segmentet från föregående observation till den nya fixen, och det kan vara
  för långt (SINE BRES med en extra fix 45 m söder om linjen: 362 + 45 =
  407 m > `UNDER_BRIDGE_CROSS_SEGMENT_MAX_M`). Därför sparas beviset i
  `_underBridgeDeferredProof` (bro, inträdesankare, tid; i VDS fältlista).
  INTERMEDIATE_UNDER och TARGET_UNDER återställer det när zonbesöket vid samma
  bro startar, och varje uppskjutande pass återställer det om ett ordinarie
  pass emellan har nollat det. Posten släpps vid GPS-hopp eller osäker
  position, när bron är bokförd (eller en passage av den registrerats efter
  posten), när båten är mer än `UNDER_BRIDGE_CLEAR_DISTANCE` från bron, när ett
  bevis för en annan bro har satts och efter två minuter. METHOD 1:s
  nettokrav består, så en båt som vänder i zonen får ingen passage. Basfacit är
  oförändrat: OSPREY, SINE BRES och NINA B får beviset i meddelandepasset och
  får det återställt när zonbesöket startar.
  **Känd lucka (omgranskningen 2026-11-04, eget kort):** METHOD 1 i
  `detectBridgePassage` (geometry.js) kräver ett steg från en fix högst 50 m
  från bron till en fix mer än 60 m bort. Har korsningen skett i inträdessteget
  och ligger nästa fix 50–60 m efter linjen, når inget steg det kravet, och
  inget steg korsar linjen. Passagen tappas då, i 7699cbe som efter rättningen
  (SINE BRES med en extra fix 58,8 m söder om linjen 02:26:41,6, alla faser;
  KÄND LUCKA-testet i `tests/zonintrade-uppskjutet-bevis.test.js`). Med en
  extra fix på 49 m eller på 60–63 m bokförs passagen. Ingen bankkorpus har
  fallet.
  Fyra spärrar: inget bevis på en GPS-hoppstick (hoppet ÄR annars "sidbytet" —
  flaggan skickas ned i `_isUnderBridge`), inget bevis när BÅDA samplen är
  bevisat stillaliggande med jitter-liten rörelse (CG2-1-spegeln), segment
  ≤ `UNDER_BRIDGE_CROSS_SEGMENT_MAX_M` (glapp hanteras av inferensvägarna), och
  en KÄLLGRIND: beviset gäller bara när andrakällan MATAR fartyget
  (`_secondSourceFixAt` inom `UNDER_BRIDGE_CROSS_PROOF_FEED_TTL_MS`) — inte
  "detta segment innehöll en hub-fix", som gjorde fixen latensberoende eftersom
  fusionens F6 äter just de släpande hub-fixarna. Grinden är en
  UTRULLNINGSSPÄRR, inte fysik: rotorsaken är källneutral (5 äkta men tappade
  passager i de låsta korpusarna) och en breddning kräver golden-omlåsning,
  dvs. ett användarbeslut. **Doktrinnotering:** `fixFeed` är därmed inte längre
  enbart metadata utan ett beslutsrelevant fält i statuslagret — det är också
  därför muxen stämplar det ur routingen.
- PassageLatchService blockerar retrograda statusar efter registrerad passage
  (radlista i §1); latchar rensas vid removal (VDS:740–742).

### Förtöjningslagren (VDS `_updateMooringEvidence`, :1588–1712)

1. **Rörelsebevis** (klistrar): sog ≥ 0.5 kn direkt; nettoförflyttning ≥50 m
   kräver 2 konsekutiva prover, GPS-flaggade räknas inte (S-F5, :1598–1618).
   Utan bevis: ingen målbro och ingen notis (RC-S3, app.js:3723–3728).
2. **Demotering, inte borttagning**: `_moored` + target ⇒ target och
   `_pendingTarget` rensas, protection släpps (VDS:126–135), fartyget behålls.
3. **Navstatus**: 1 (ankar)/5 (förtöjd) + stillaliggande (:1666–1668).
4. **Kajzon**: stationär i MOORING_ZONE kräver stillhetsTID — 3 min normalt,
   zonens `queueGraceMs` för trolig köare (target inom 600 m + rörelsebevis;
   `_zoneMinStillMs`). Kajen bär sedan **ägarbeslutet U23 (2026-11-09)** ett
   obegränsat köundantag: en båt på väg mot Klaffbron som stannar vid Kajen
   behandlas som i resten av väntområdet och klassas aldrig av zonlagret.
   Inom 300 m från bron (190–300 m, nästan hela kapseln) står hon kvar i
   texten ("på väg mot Klaffbron, beräknad broöppning strax", enligt
   imminent-regeln och U6) tills hon kör vidare, sänder navstatus 1/5
   (lager 3) eller legat still i MAX_STATIONARY_WAIT_MS (lager 5).
   **Kapselns norra spets (300–320 m) beter sig som farleden på samma
   avstånd:** målbron släpps efter 20 min stillhet (`_isInTargetQueueZone`,
   aktivitetsfönstret från valideringskörningen 2026-07-02), och texten visar
   till dess hennes senaste ETA i stället för "strax", eftersom hon varken har
   imminent-flaggan (över 300 m) eller bekräftad väntan (`queueBridge` ger
   null i en kajzon). Utan målbro håller undantaget inte längre, så zonlagret
   klassar henne efter 3 min. Avgången är ändå samma ankomst, eftersom stoppet
   minns att klassningen höll henne (`heldAsQueue` nedan): hon behåller sin
   första varning som farledsköaren på samma avstånd (granskningens prov
   X3kaj; före L1 kom en ny varning 92 s före korsningen). Bandet 300–500 m
   är en befintlig lucka mot D1 även i farleden (öppen ägarfråga). Motivet är D1 (docs/reliability-spec.md): utanför kajzonerna tas
   en väntande båt nära bron aldrig bort, och 15-minutersgissningen gav i
   buggjägarens provvärldar "Inga båtar" medan en båt väntade 250 m från bron
   och en ny, sen varning vid avgången (värld 313: 32 s före passagen).
   Utan undantagets villkor gäller 3 min som förut: norrgående efter Klaffbron
   med Stridsbergsbron ~980 m bort (ELFKUNGEN, SUSANNE), båtar utan målbro eller
   rörelsebevis, och hela Gästhamnen (`queueGraceMs` 0, utanför väntzonen).
   **Öppningslagrets ankomstspärr** (app.js `_observeOpeningArrivals`) följer
   samma klassning via `VesselDataService.holdsQuayQueue`: så länge köaren
   hålls är stoppet vid Kajen samma ankomst, och armen lever vidare eftersom
   målbron står kvar, så den första varningen gäller hela kön. Klassningen
   är flyktig, men stoppet minns att den höll henne (`quayStop.heldAsQueue`,
   överlever omstart; granskningen av familj F, L1): efter en omstart eller
   ett AIS-glapp mitt i kön är hon ny för appen, utan målbro, men stoppet är
   samma ankomst så länge hon ligger kvar (< 50 m), inte sänder navstatus
   1/5 och inte legat still i MAX_STATIONARY_WAIT_MS från stoppets första fix
   — som farledsköaren (prov X2kaj/X5kaj mot X2far/X5far; före L1 ett andra
   kort 73 s före korsningen). Minnet släpps också när klassningens egen
   stillhetsklocka (`_stationarySince`) nått MAX_STATIONARY_WAIT_MS, eftersom
   en ensam fartspik raderar det obekräftade stoppet och startar ett nytt med
   senare första fix (omgranskningens prov B3); efter en omstart är klockan
   ny. Släpper klassningen henne genom navstatus eller backstoppen bekräftas
   stoppet med 30 s-regeln och avgången blir en ny ankomst
   (`OPENING_QUAY_DEPARTURE`) som förut — efter backstoppen alltså med en sen
   andra varning (73 s före korsningen i det syntetiska 150-minutersprovet;
   43 s före M3, samma som på c14938f efter 15 min). Ledtiderna här mäts mot
   korsningen interpolerad ur fixarna.
   **Avgång inne i Kajen (M3):** avgången godtas när båten flyttat minst
   50 m från ett bekräftat stopp mot bron, på en enda fix, om steget sedan
   föregående fix är rimligt för farten (högst 20 m plus dubbla farten gånger
   tiden). S/V REBEL i 20260806-42h behöver enfixsregeln: med gles AIS kom
   nästa fix först efter passagen. Rimlighetskravet gör att ett ensamt
   GPS-hopp (60 m mot bron i 0,6 kn) inte är en avgång (omgranskningens prov
   A5). **Priset, ägarens avvägning:** en äkta omförtöjning 100 m mot bron
   inne i Kajen räknas som avgång, och varningen kommer då 62 min före
   korsningen (prov A4, navstatus 5, fix var 10:e s). Utan navstatus (A4n0)
   håller U23 henne som köare på den nya platsen, så den verkliga avgången
   får ingen egen varning; den tidiga gäller.
5. **2h-backstop**: stationär > MAX_STATIONARY_WAIT_MS. Sedan 2026-09-06
   undantas styrkt, fortsatt färsk brokö enligt kontraktet nedan. Undantaget
   når aldrig en kajzon: `queueBridge` (lib/utils/bridgeQueue.js) ger null i en
   MOORING_ZONE, så backstoppen gäller vid Kajen även för U23-köaren.
   Släpp-hysteres: tydlig avgång (≥0.5 kn) direkt; gråzon kräver 2 prover
   (`_mooredReleasePending`, :1638–1653); navstatus-flap ensam släpper inte
   (:1660–1665).

**Lång brokö (användarval 2026-09-06).** VDS bokför högst fyra
`_bridgeQueueApproaches` i den levande resan. Minst 50 m nettoförflyttning
mot samma öppningsbara bro, från samma sida och resriktning, krävs för
bekräftelse; fartspikar och återlevererade fixtider räcker inte. Posten
undantar tvåtimmarsklassningen och den separata tiominutersdemoteringen
bara vid bekräftad `waitingAtBridge`, före brolinjen, inom väntans befintliga
350 m-gräns, med färsk position och utan GPS-osäkerhet, förtöjningsstatus
eller känd kaj. Det gäller också väntan vid Järnvägsbron på väg mot Klaffbron
och Olidebron söderut efter sista målbron. Uppgiften bevaras av den explicita
fältlistan, rensas vid ny resa/riktningsbyte/passage och sparas inte i grav.
En fix i en kajkapsel skapar aldrig nytt bevis. Sedan 2026-11-09 (granskningen
av familj F, M1 c) behåller en båt som går genom kapseln i minst 0,5 kn redan
bekräftat bevis, med väntans ankare nollat; förut tömde en enda transitfix i
Gästhamnens eller Kajens kapsel beviset, och med AISHub-takt kunde nästa fix
redan vara stoppet i kön (20260713-41h omlåst 264 → 262 övergångar, se noten).

Färskhet använder `max(timestamp, lastPositionUpdate)` inom tio minuter;
`_lastSeen` är inget positionsbevis. AISHubs `fixTs` måste dessutom vara
inom dess befintliga ålders- och klockskevsgränser. Nya rapporter på samma
koordinater håller väntan levande. Gammal eller GPS-osäker information
skapar inte i sig en klistrande förtöjning. RC7:s 25-minutersvisningsgräns
och borttagning/stale-svep efter cirka 30 minuter gäller fortfarande.
En båt som först observeras stilla utan anflygning får inget obegränsat
köundantag. Se [fältprovskörboken](infor-faltprov-2026-09-06.md).

### ETA-extrapoleringens tillstånd (app.js `_reevaluateVesselStatuses`, :3262–3531)

> **ETA-vägen körs TVÅ gånger per AIS-fix** (meddelandevägen + snapshot-vägen)
> och det är i dag oavsiktligt BÄRANDE, inte bara slöseri. Rör inte
> `StatusService.calculateETA`, `ProgressiveETACalculator` eller
> `_positionUpdatedSinceLastETA` utan att först läsa **§8 (e) K6** och mäta med
> `npm run measure:eta` (docs/VALIDATION.md §ETA-mätharnessen).


Flaggor (bärs av `_createVesselObject`-fältlistan, §8a): `_etaIsExtrapolated`,
`_etaExtrapolationExhausted`, `_etaExhaustedAtMs`, `_etaExtrapolationBaseMs/Value`,
`_etaPublishedValue`, `_isImminentAtTargetBridge`. Per omvärdering (30 s-watchdogen):
- Färskt rent sampel ⇒ `calculateETA` + RC4-dämpning mot publicerat värde
  (`_reconcilePublishedETA`:2073), extrapolationstillståndet nollas (:3298–3322).
- Stale 5–10 min (Fix G) ⇒ extrapolera ned (kräver sog ≥ 1.0 kn; :3351–3379);
  når den 0 ⇒ `_etaExtrapolationExhausted = true` + `_etaExhaustedAtMs = nu`
  (:3391–3398; visar "strax" i st.f. "okänd").
- Stale >10 min ⇒ ETA null + flaggor rensas (Anomali 3-säkerhetsval; gatas på
  `lastPositionUpdate`, F40 medvetet; :3338–3350).
- Fix H imminent (:3429–3517): target + färsk AIS + ej GPS-hold + ≤300 m ⇒
  `_isImminentAtTargetBridge = true` (:3513–3517); **IMMINENT_SET_EXHAUSTED**
  (:3496–3505): exhausted + ≤500 m ⇒ imminent trots >300 m, MEN bara inom **90 s**
  av uttömningen (`_etaExhaustedAtMs`, ZWERK-tidslocket 2026-07-03 — därefter
  "ETA okänd"). Echo-gate/imminent-hold: GPS-osäkert sampel behåller föregående
  imminent-läge ENDAST om datat är färskt ≤10 min (F40-gränsen; :3429–3442);
  per-tick-nollningen sker :3441. **H17 (2026-08-22):** 90 s-taket prövas
  numera FÖRE hållningen — hållningen hoppar över HELA återhärledningen, så
  en exhausted-seedad flagga (`_imminentFromExhausted`) kringgick taket och
  stod till STALE_ETA_HARD (10 min) medan osäkra sampel stämplade om
  positionsklockan. Nu släcks den flaggan när
  `IMMINENT_EXHAUSTED_MAX_AGE_MS` (90 s; modulkonstant DELAD med
  SET-grenen) passerat, och saknad `_etaExhaustedAtMs` räknas som utgången
  (HARD-nollningen får inte frysa flaggan). Hållningen som sådan står kvar
  och ren närhetsbevisad imminent (≤300 m) berörs inte. **B6**: vid TARGET_END nollas
  imminent/exhausted/`_etaExhaustedAtMs` även i VDS (VDS:2476–2484, ovan).

## 5. bridge_text-pipelinen

1. **RC7-presentationsfiltret** (VDS `getVesselsForBridgeText`:1165–1307):
   fartyg vars senast MOTTAGNA data är äldre än nivågränsen döljs (behålls
   internt). Nivåer: (a) nära-stilla vid sista kontakt (sog < 1.5) ⇒ 25 min
   (:1208); (b) kö-klassen (sog < 3.0 OCH ≤600 m från närmaste bro) ⇒ 25 min
   (:1212); (c) mitt-i-passage (≤300 m från MÅLBRON) ⇒ 20 min (:1223); (d)
   annars (SABETH-klassen) ⇒ 10 min (:1182, :1207). Därefter: giltig målbro/nära
   Stallbackabron/180 s passagefönster, ankringsfilter, relevant status (:~1230–1307).
2. **Projektion** (app.js `_findRelevantBoatsForBridgeText`:3537–3594): explicit
   fältlista till BridgeTextService inkl. `_etaIsExtrapolated` och
   `_isImminentAtTargetBridge` (F4 — fälla, §8a); `_processingRemoval` filtreras bort.
3. **BridgeTextService** (199 rader, stateless): **Variant-1-grammatiken** — en
   fras per målbrogrupp (`_buildGroupPhrase`:126–154): `"[Räkneord] [båt|båtar]
   på väg mot [Klaffbron|Stridsbergsbron], [ETA-klausul]"` (:153). Endast
   målbroar nämns. ETA-klausul via `formatETABroOpeningClause` (SSOT,
   etaValidation): ogiltig ⇒ "ETA okänd"; <3 min ELLER imminent ⇒ "beräknad
   broöppning strax" (imminent gäller HELA gruppen, F45 :146–147); ≥3 min ⇒
   "om N minuter" (extrapolerad ⇒ "om cirka N minuter"). **B6-zombieundantaget**
   (:134–151): fartyg vars target redan ligger i `passedBridges` räknas i
   antalet men driver varken imminent eller lead-ETA (isZombie :134–135; lead
   väljs ur zombie-fria mängden :136–138). Lead-båt = lägst giltig ETA, annars
   kortast distans (`_selectLeadVessel`:164–178). Separator "; ", Klaffbron först
   (:91–110). Tom input ⇒ DEFAULT_MESSAGE ("Inga båtar är i närheten av Klaffbron
   eller Stridsbergsbron").
4. **UI-coalescing** (app.js): `_updateUI`:2139 → `_scheduleCoalescedUpdate`:2147
   (micro-grace 15/25/40 ms per signifikans; critical/immediate bypassar;
   high-event krymper till 10 ms). `_actuallyUpdateUI` (:2251) kan lägga 200 ms
   micro-grace + omsnapshot. 30 s-watchdog driver självläkning (:5302–5313).
5. **Publicering** (`_processUIUpdate`:2393): **fel-snapshot-guard** (:2402–2405,
   `snapshot.error` ⇒ behåll förra texten — tom lista pga krasch är "vet ej",
   inte "tom kanal"); F29-vakt (GPS-hållen ensam båt ⇒ behåll förra texten,
   :2432–2445); **stale-guard**: AIS nere >2 min (`STALE_DATA_GUARD_MS`, delad med
   30 s-vakthunden, som sedan 2026-11-03 driver cykeln även vid 0 båtar) ⇒ STALE_DATA_OVERRIDE_TEXT
   ("AIS-anslutning saknas — data kan vara inaktuell", :64, :2476–2485) och
   alarm_generic tvingas AV (C8, :2567–2586); hash-dedupe + 60 s tvångsrefresh
   (ej vid passed-fartyg, :2488–2499); loggtaggar UI_UPDATE vs UI_REFRESH (RC6).
   Skriver capabilityerna `bridge_text`/`connection_status`/`alarm_generic`
   (drivers/bridge_status) + global token `global_bridge_text` (:2514, skapas
   :4703). Sista båten borta: DEFAULT tvingas + hash synkas (F25, :1195–1228);
   **P8 + feedstall**: DEFAULT-tvånget gatas på `!_isConnected` ELLER
   feed-tystnad >5 min ("ansluten men döv", FEED_SILENT_GUARD_MS :1173,
   villkor :1185) ⇒ behåll texten (:1185–1194).

## 6. Persistens (homey.settings)

| Nyckel | Läses | Skrivs | Innehåll |
|---|---|---|---|
| `debug_level` | app.js:132, listener :365–378 | Homey-UI | 'basic'/... loggnivå; listener registreras :402 |
| `ais_api_key` | :5005 (boot), :5144 | Homey-UI | API-nyckel; ändring ⇒ `reconnectWithKey` (F8, :379–397) |
| `persistent_recent_triggers` | `_loadPersistentTriggers`:411 | `_persistRecentTriggers`:505 | 2h-notisdedupe `{ "mmsi:Bro": {t, dir} }` |
| `known_vessel_names` | `_loadVesselNames`:529 | `_persistVesselNames`:561 | B1-namncache `{ mmsi: {name, t} }`, 30 d TTL, max 200 poster (äldst-först-eviction); skrivs via `_rememberVesselName`:593 bara vid nytt/ändrat namn eller >24 h sedan sist |
| `last_known_positions` | `_loadLastKnownPositions`:615 | `_persistLastKnownPositions`:646 | `{ mmsi: {lat, lon, t} }`, 6 h TTL; skrivs vid removal (:1084–1090); begränsar skipped-bridges-scenario A för återfödda båtar (§3) |
| `quay_stable_ledger` | `_loadQuayLedger` | `_persistQuayLedger` (STRYPT: max var 15:e min + tvingad vid `onUninit`) | V1-kajavgångsgrindens historik `{ mmsi: {stillAt, lat, lon} }`, TTL = `QUAY_DEPARTURE_GATE.MEMORY_MS` (2 h); rörelseräknaren `movingFixes` persisteras ALDRIG (den är ett påstående om innevarande sessions observationer). Utan persistensen återskapade en appomstart 5 s före kajavgången PRICKBJORN-fantomen exakt |
| `persistent_opening_warnings` | `_loadPersistentOpeningWarnings` | `_persistOpeningWarnings` (vid varje avfyrning + vid konsumtion) | Etapp 6 + J15 (2026-08-22): öppningsvarningarnas dedup ÖVER omstart, `{ "Bro\|mmsi\|riktning": {firedAt, expiresAt} }`. TVÅDELAT läsfönster (`_openingDedupActiveUntil`): post skriven i DENNA session dedupar till firedAt + `CONVOY_WINDOW_MS` (10 min, som förr); post LADDAD VID BOOT dedupar till expiresAt = firedAt + 10 min + ETA (kapat `_OPENING_PERSIST_MAX_MS`) — omstartsskyddet. TRE konsumtionsvägar nollar nyckeln: bekräftad passage i `_observeBridgeOpening`, gap-inferrerad passage och backfill (L19). Riktningsledet gör att en U-svängares RETURPASSAGE aldrig tystas; sedan S11 (fixrunda 6) är riktningsledet MEDLEMMENS egen låsta riktning (`memberDirections` i payloaden), ledarens bara som fallback. Sedan S13 härleds expiresAt inte ur ETA-tokenen utan ur max(dagens uttryck, armens förväntade ankomst `expectedArrivalMs` — MAX över medlemmarna), fortfarande kapat. Känd avvägning: avbruten anflygning före omstart (§9) |
| `trigger_point_visits` | konstruktorn (`TriggerPointVisitTracker.loadSnapshot`) | `_persistTriggerPointVisits` (vid varje fasbyte i `observe`, reservation/rollback av notis, stängning vid fullbordad resa och tvingad i `onUninit`) | Besöksregeln 2026-09-07: `{ version: 2, entries: { "mmsi:punkt": {startedAt, lastFixTs, outsideFixTs, exitedAt, lastLat, lastLon, lastPositionTs, arrivalLat, arrivalLon, farSign, farSideSeenAt} } }` för alla broar och Kanalinfarten. Ett notifierat besök spärrar nya notiser till observerad utfärd (två rena fixar > 350 m, passage följd av två fixar på bortre sidan, eller positionsbevisad fullbordad resa) och återkomst inom 300 m. U14 (2026-11-04): vid en bro avslutar också en bevisad passage tillbaka besöket (§3, dedup-lager 3); `farSign` och `farSideSeenAt` sparas, och första observationen på bortre sidan är ett fasbyte. Bokföringsstämplarna (`farSideBooking`, `returnBookedAt`), den noterade korsningen och fixens segment gäller bara det levande fartygsobjektet och sparas inte; efter en omstart noteras en korsning på nytt ur den sparade sista fixen. Äldre poster utan fälten, eller med skadade värden, får inget returpassagesläpp. Stängda poster gallras efter 6 h; tak 2048 poster |
| `opening_quay_ledger` | `_loadOpeningQuayLedger` | `_persistQuayLedger` (samma strypta 15-min-klocka som V1-kartan + tvingad flush i `onUninit`; skrivtakt ~96→192/dygn) | M11 (2026-08-23): öppningslagrets kajbokföring `{ mmsi: {bandSince, stillAt, lat, lon, moving} }`, TTL = `QUAY_DEPARTURE_GATE.MEMORY_MS`. Utan persistens var kajvobbelgrinden BLIND 5 min efter varje omstart (bandSince sessionslokal) och efter ETT fix utanför 500 m-bandet; nu hysteres (en tolererad fix, `MIN_MOVING_FIXES`-härledd) + persistens. `movingFixes`, `prevFix`, `lastFix` persisteras ALDRIG (påståenden om innevarande session) |

**Kajbokföringens TVÅ kartor.** `_quayStableLedger` (persisterad, ovan) bokför
bara inom `QUAY_DEPARTURE_GATE.LEDGER_RADIUS_M` från en TRIGGER-punkt, och det
finns exakt en (Kanalinfarten). Öppningslagret har därför en EGEN karta —
`_openingQuayLedger` (sedan M11 PERSISTERAD, se tabellen) — som delar RUTINEN
(`_noteQuayLedgerEntry`) och stillasample-/dödbandsvillkoren men har SKILD
ANKARREGEL (L40, 2026-08-22): V1-kartan flyttar ankaret vid varje stillasample,
öppningskartan håller ankaret från kajvistelsens BÖRJAN — en harmonisering åt
V1-hållet ger MISSAD öppningsvarning för långsam äkta avgång. Referenspunkterna
är trigger-punkter PLUS målbroarna: Kanalinfarten ligger 1982 m från Klaffbron och 3197 m från
Stridsbergsbron, så V1-kartan gjorde kajvobbel-grinden strukturellt neutral vid
exakt de två broar öppningslagret varnar för. Kartorna hålls åtskilda så
boat_near-grinden och dess facit står byte-identiska.

Mönstret (mall för framtida cacher): ladda i konstruktorn med expiry-filter och
guards; **write-through vid varje mutation**; rollback vid misslyckad operation
(:4562–4571); migrationsvänlig läsning (talposter jämte `{t, dir}`, :424–433).

**Monitoring-loopen** (`_setupMonitoring`:5168, 60 s, avstängd i test-läge):
döda mmsi ur session-Set:en (:5183–5204); utgångna 2h-poster + persist
(:5206–5223); namncache-TTL (:5225–5239); **SystemCoordinator.cleanup()**
(:5241–5251 — anropades tidigare aldrig i drift); `_aisRejectLogTimes` (:5253);
`last_known_positions`-TTL (:5265–5277); `_checkAISFeedHealth`
B2-feedstall-watchdogen (:5282, def :5112).

**`onUninit`** (:5321): removal-timers + `_processingRemoval` + monitoring-
intervall (:5328–5347); **destroy-kedjan** passageLatchService/routeOrderValidator/
gpsJumpGateService `.destroy()` (:5353–5359); självtest-timern (:5362–5365);
coalescing-/immediate-/watchdog-timers + mappar (:5368–5392); `VDS.clearAllTimers()`
(:5395); `aisClient.disconnect()` (:5400); slutlig flush av
`persistent_recent_triggers` (:5406 — namncachen och last_known_positions litar
på write-through + monitoring) och av `quay_stable_ledger` (V1: skrivtakten är
strypt till 15 min, så utan tvingad flush hade upp till en kvarts kajhistorik
gått förlorad i just den omstart grinden ska överleva); removeAllListeners +
lyssnare av (:5411–5435).

## 7. Replay-/testharnessen (tests/replay-validation/)

Permanent valideringsverktyg — kör den RIKTIGA appen mot inspelad AIS-jsonl.
- `replayRunner.js`: v2 med @sinonjs/fake-timers — klockan driver BÅDE Date.now
  och timers (`clock.tick(gap)` mellan samples, :89–92, :214–215); setImmediate/
  nextTick hålls äkta. Init KRÄVER `__TEST_MODE__=true` (:95; av före uppspelning
  :206–207). Notisfångsten bär name/distance/source (:307–327) +
  positionen vid det verkliga SDK-kortanropet för INV-8/11/15, även när
  removal skickar ett fallback-kort. Framtida sampel används inte som då känd
  position. `ctrl:'restart'` = äkta
  processomstart (:246–264): `onUninit()` → `new AISBridgeApp()` → `onInit()`;
  persistensen återläses ur samma mock-settings; notiser samlas över instanserna.
- `corpora.js`: **20 låsta korpusar (374,1 h)**, inklusive 42h-körningen, med
  `expectedNotifications` + motiverad `note` vid omlåsning = **facit**;
  `corpora-distribution.json` låser fördelningen per fartyg+bro. Samtliga 20
  låser även öppningar; sju har fullständiga `golden-events` för att upptäcka
  ändrade tider, ETA-token, medlemmar och passageposter. Räkna aldrig
  siffran ur den här raden — den ändras vid varje låsning; `npm run replay:all`
  skriver ut den aktuella. Jsonl:erna ligger byte-exakt i `corpora-data/`;
  `appLog`-fälten pekar på det
  externa arkivet `../logs/` och konsumeras aldrig av harnessen.
- `checkReplayIntegrity.js` (K24, 2026-08-21): bevisar att en fångad jsonl bär
  HELA loggens facit — en rad per `[AIS_REPLAY_SAMPLE]`, samma ordning, hel
  sista rad. Fristående node-skript utan beroenden; `--corpora` sveper alla
  korpusfiler, `--dir` en katalog. Verdikt **OK/DELVIS/FEL/OKÄNT** (källogg
  saknas ⇒ aldrig OK; DELVIS = härledd tvåkällig korpus där bara den loggbara
  delen GÅR att mäta — `ais-fusion-*.jsonl`, vars aishub-rader är parseade ur
  `[AISHUB_RESPONSE_SAMPLE]`-kuvert utan 1:1-relation — exitkod 0, med den mätta
  andelen utskriven i verdiktraden). Loggen strömmas med `StringDecoder`, annars
  hade ett å/ä/ö på en läsbitsgräns gett en falsk FEL-dom på en hel korpus.
  Kallas av `run-with-logs.sh` och är grind 1 i körbokens fältprovsdel;
  domarlogiken är enhetstestad i `tests/replay-integrity.test.js`.
- `runPhaseSweep.js` (K20, 2026-08-21, `npm run replay:phase`): **grind 2** före
  korpuslåsning. Replayn ankrar fejkklockan i korpusens FÖRSTA sampel, så det
  ankaret är datats enda fas-knapp; svepet kör en bas plus en variant per
  fasoffset (default −2,5/−5/−11,52/−15/−20/−25 s) där EN temporär kopia har
  ankarradens `aisTimestamp` OCH `fixTs` skiftade lika mycket — ren fas, bevarad
  fix-ålder, korpusfilen orörd. Fyra dimensioner FÄLLER (notiser
  `mmsi:bro:riktning`, passager `mmsi:bro`, öppningar `Bro#n` →
  ledande/riktning/eta/källa, brotextmultiset dedupad i följd); notisernas
  ETA-token och ren ordningsomkastning i brotexten rapporteras men fäller inte.
  Accepterad känslighet skrivs i `phase-sweep-exceptions.json` (motivering +
  datum obligatoriska, annars exit 2). Utan argument sveper skriptet de olåsta
  korpusarna, annars hela banken. Historisk fältmätning 2026-08-21: pelare 2 var fas-robust (notis- och
  passagemultiset identiska i alla varianter, både på 19/8-korpusen och den
  olåsta 42h-körningen) — öppningsmotorn och ETA-texten är knivseggarna.
- `invariants.js`: facit-OBEROENDE sanningskontroller **INV-1…INV-21**. Fatala:
  INV-1…14 + INV-16 (`validateInvariants`; INV-8 namnkvalitet/INV-11
  distansrimlighet/INV-16 ETA-fysik <30 kn SKÄRPTES från WARN 2026-07-03). WARN:
  INV-15/17/18/19/20/21 (`validateWarnInvariants`, kalibrerade: INV-15
  riktning-vs-geografi ~220 m (0,002°); INV-17 textflappbudget max(40, 24×antal
  fartyg)/h; INV-18 mjuk ETA-monotoni ≥8 min inom 15 min; **INV-21 (etapp 6)
  öppningsvarning efter passage** — varning för en bro där en av varningens EGNA
  medlemmar redan registrerats som passerad; returresor undantas via
  journey-reset, och regeln är tyst över samtliga korpusar + soaken).
- `scenarioGenerator.js` + `runSyntheticScenarios.js`: seedade syntetiska resor
  genom riktig brogeometri — **35 scenarier**; `nameFromS` (:139–142) simulerar
  sen namn-backfill: "Unknown" sänds tills t ≥ nameFromS s (VALEN-klassen).
- `runSoak.js`: separat 72 h-soak (seed 46: 2 kajliggare + 36 genomresor, 2
  avbrott + 2 äkta restarts); bedömer STABILITET (0 processfel, inga läckor,
  fatala invarianter rena, ≥5 notiser/fullbordad resa) — inte facit. Körs
  manuellt (`node tests/replay-validation/runSoak.js`; medvetet inget npm-script).
- `runOpeningGates.js` (etapp 6): **`npm run replay:openings`** — det proaktiva
  lagrets egen sanning, mätt mot RÅDATA i stället för mot en inspelning.
  O1 täckning (varje målbropassage ska ha en varning FÖRE; varje miss klassas,
  OKLASSAD = rött; konvojtäckning underkänns om bron bevisligen öppnat och
  stängt emellan), O2 fantomtak (varning utan passage inom 20 min klassas mot
  rådata; KAJVOBBEL/UTANFÖR_HORISONTEN = rött; SEN_PASSAGE klassas också),
  O3 nattkontrollen (A/B-nattens två armar), plus avfyrningsfönstret
  (`t − dueMs` inom ett par tick) och ledtidsgolvet.
- `opening-distribution.json` (etapp 6, O5): multiset `bro:riktning → antal` per
  korpus för öppningsvarningarna — samma roll för `bridge_opening_soon` som
  `corpora-direction-distribution.json` har för boat_near. Jämförs i
  `runAllCorpora`; regenereras BARA med `REGEN_DISTRIBUTIONS=1` från en grön
  körning. Saknas filen skriver grinden en högljudd rad (dimensionen är då
  olåst).
- Körs: `npm run replay:all` / `npm run replay:synthetic` /
  `npm run replay:openings` — eller hela kedjan med `npm run validate`
  (jest + korpusar + scenarier) resp. `npm run validate:full` (+ soaken).
  Praktisk körbok: `docs/VALIDATION.md`.

**Teststärkningen 2026-07-06** (helgranskningens sista insats):
- 38 syntetiska scenarier (+3: `fartgivarlös-genomresa` med sog=null —
  avslöjade direkt GPSJumpAnalyzers 1 kn-golv för okänd fart;
  `kajliggare-kanalinfarten-ingen-exitnotis`; `gps-hopp-vid-notisgränsen`).
  Generatorn stöder `sogNull: true`.
- Invarianterna har EGNA enhetstester (`tests/replay-invariants-unit.test.js`)
  — domarlogiken döms åt båda hållen. INV-11/16 täcker nu även källan
  `just-passed` (empiriskt ren över hela batteriet vid tillägget).
- Projektions-fältlistvakt med AUTOMATISKT källsvep
  (helgranskning-2026-07-06-sviten): faller om textmotorn börjar läsa ett
  vessel-fält som `_findRelevantBoatsForBridgeText`-projektionen inte bär.
- TEST_MODE-no-op:en i `_triggerBoatNearFlow` kringgås numera i riktade
  jest-tester (NODE_ENV='production'-mönstret) — Fix 5-/mooring-gaten på den
  RIKTIGA notisvägen har direkta tester.
- Tautologi-/inline-kopietester omskrivna till produktionsdrivna (Fix D-
  journey-reset via updateVessel, M2-boot-seed via äkta onInit, METHOD 5/
  sideFlipped-geometri, M1/M3-diskriminering); kvarvarande rena
  dokumentationstester är MÄRKTA "⚠️ DOKUMENTATIONSTEST".
- Coverage-golv (ratchet, sänks aldrig): 75/70/80/76 (stmts/branch/funcs/
  lines) i `tests/jest.config.js`.

## 8. KÄNDA FÄLLOR

**(a) De två explicita fältlistorna.** Vesselobjektet BYGGS OM vid varje
AIS-meddelande (`_createVesselObject`, VDS:2633–2865) och SNAPSHOT:as vid removal
(`vesselSnapshot`, VDS:625–664). Fält som inte uttryckligen kopieras **raderas
tyst**. TIO kända offer: (1) `passedAt` m.fl. i `_createVesselObject`
(2026-06-13, VDS:2725–2730); (2) ålderfälten `timestamp`/`lastPositionUpdate`/
`_lastSeen` i snapshotten — gjorde F63-exit-vakten till död kod (CLABBYDOO,
VDS:648–655); (3) `_isImminentAtTargetBridge` (echo-flappen, VDS:2740–2746);
(4) `name` vs `shipName` i snapshotten — exit-notiser hette alltid "Unknown"
(VDS:634–637); (5) `_etaExhaustedAtMs` i `_createVesselObject` — 90 s-fönstret
började om varje meddelande (VDS:2860–2861); (6) `maxRecentSpeed`/`passedAt` i
snapshotten — RC3-stale-gaten degraderade till momentan sog (SILJA-klassen,
VDS:656–663); (7) `currentBridge`/`distanceToCurrent` i `_createVesselObject` —
**CBM-hysteresens rotorsak**: fälten var undefined varje tick så hela
500/600 m-hysteresen var död (VDS:2788–2793); (8) **namnbytes-varianten**
(helgranskningen 2026-07-06): koordinationsnivån skrevs till
`_stabilizationLevel` som INGEN läste medan tre konsumenter
(app `_hasActiveGPSJumps`, GPSJumpGateService:235, ProgressiveETACalculator:801)
läste `lastCoordinationLevel` som ALDRIG skrevs — tre designade GPS-skydd var
döda; fältet skrivs/nollas nu i `_applyCoordinationResults` och bärs i
fältlistan; (9) **projektionsvarianten** (helgranskningen 2026-07-06): en
TREDJE fältlista finns i `_findRelevantBoatsForBridgeText`-projektionen —
micro-graces kritisk-övergångsterm läste `_criticalTransitionHoldUntil`/
`_zoneTransitions` ur projektionen som saknar fälten (alltid false);
`_hasCriticalZoneTransitions` slår nu upp det levande objektet via
`getVessel(mmsi)`. Fältlistan bär numera även `_underBridgeFrozenAccMs`,
`_underBridgeEntryLat/Lon`, `_underBridgePrevLat/Lon/Sog`,
`_underBridgeCrossedBridge`, `_underBridgePendingCross`, `_secondSourceFixAt` (segmentbeviset — utan arv
nollas det av varje meddelande och fixen vore död i produktion),
`_pendingTarget` och `lastCoordinationLevel`;
snapshotten bär även `_moored`/`_hasMovementProof` (exit-fallbackens gates).
**REGEL: varje nytt fält som konsumeras efter removal eller över
meddelandegränser MÅSTE läggas till i BÅDA fältlistorna — och läses fältet i
publiceringsvägen även i PROJEKTIONEN (app.js `_findRelevantBoatsForBridgeText`)
eller via levande uppslag.** Vaktlistan `SNAPSHOT_CONSUMED_FIELDS`
(tests/namnkedjan-b1.test.js) ska täcka varje fält fallbackvägen läser. (10) `_fixDPendingReversal` (Fix D:s väntande riktningsvändning) saknas i graven ⇒ S10-vakten i notisvägen (fixrunda 6) är inert för en återfödd båt — fail-open, en notis kan gå ut med gammalt riktningslås men ingen förloras.

**(b) OneDrive gör lint långsamt.** Kör eslint per fil, inte över hela trädet.

**(c) Jest fyller disken.** Pipa `npm test` till en sammanfattning (t.ex.
`| tail`), annars ENOSPC av verbose-utskrifterna.

**(d) Source-fältlistan för Flow-state.** Trigger-state är
`{ bridge, mmsi, distance, source }` (app.js:4546) med source-värdena
`target | current | nearest | just-passed | trigger-point | passage-fallback |
exit-fallback` (§3). Replay-invarianterna och run-listenern (:4743) konsumerar
dessa — nya source-värden/state-fält måste synkas med invariants.js, annars
felklassas notiser i valideringen. `passage-fallback` och `exit-fallback` står
MEDVETET utanför `PROXIMITY_SOURCES` (400 m-regeln och fartfysiken i
INV-11/INV-16 gäller inte inferens-/exitklassen); vakten TE17 i
`tests/harness-vakter.test.js` låser att undantagslistan och produktionens
källsträngar hålls i synk åt BÅDA håll.

**(e) K6 — ETA-dubbelkörningen (fältprov 10): UPPMÄTT OCH UPPSKJUTEN
2026-08-22.** ETA-pipelinen körs TVÅ gånger för samma AIS-fix: meddelandevägen
beräknar och sätter sedan ovillkorligt `vessel._positionUpdatedSinceLastETA`,
och snapshot-vägen konsumerar flaggan och räknar om SAMMA position ~30 ms
senare. Båda anropen går rakt in i `ProgressiveETACalculator` och MUTERAR dess
historik. Mätt över 17 låsta korpusar (~330 h): 3 885 `[ETA_CALC_V2]`-rader,
1 824 par inom <200 ms för samma mmsi ⇒ **93,9 % av alla ETA-beräkningar är
dubbelkörningar**; 1 113 par ändrade värdet och pass 2 SÄNKTE i 900 av dem
(80,9 %) — dubbel-EMA-signaturen (effektiv alfa 1−(1−0,4)² = 0,64 i stället för
avsedda 0,4).

*Det uppenbara botemedlet gör skada.* Ett rent memo per fix (idempotent
`calculateETA`) byggdes, mättes och **backades ut** samma dag. Diagnosen, som
tre oberoende granskare reproducerade: **dubbelkörningen är oavsiktligt
bärande.** Två mekanismer, båda i `ProgressiveETACalculator`:
1. **`ETA_GAP_RESET` tömmer fartbufferten och dess sampelnycklar.** I
   dubbelkörningen pushade pass 2 om samma sampel direkt efter reseten, så
   passagefartsgolvet 2,5 kn levde vidare. Med memot står bufferten tom till
   nästa fix och ett enda långsamt sampel ger golvet 0,5 kn — **fem gångers
   rå-ETA**.
2. **Outliergrindens dramatiska grenar kräver `timeDelta < 30 s`.** Vid ~70 s
   pollkadens var det i praktiken bara pass 2 som kunde uppfylla det. Utan
   dubbelkörningen slocknar skyddet: `[ETA_OUTLIER]` går 264 → 79 globalt,
   `dramatic_decrease` 56 → 5, och F74-capen i `_getFallbackETA` följer med.

Uppmätta följder av det rena memot: **+11,4 % absolutfel i bandet sanning
< 5 min** (16 bättre mot 55 sämre, publicerat HÖGRE i 66 poster mot lägre i 5),
+4,1 % i bandet < 10 min, **63 färre brotextövergångar** (2 163 → 2 100 — texten
uppdateras både senare OCH mer sällan), en **NY hård invariantsågtand** (LINNEA
265764760 vid Klaffbron 2026-07-15: HEAD publicerade 4 mot sanning 4,76, memot
ger 4 → 8 → 14 mot sanning 3,24) och de två redan kända 41h-svängningarna
förvärrade från 8→14 till 10→16. Och memot är **inte** en biverkningsfri cache:
i 20260713-41h gav **18,8 % av de gemensamma fixarna en annan rå-ETA**
(`[ETA_RAW]`, medelavvikelse 4,11 min, enskilda hopp 3,0 → 16,3 och 8,5 → 26,4).
Att höja `emaAlpha` 0,40 → 0,64 botar **aggregatet** (bandets z-värde 3,35 → 0,80,
övergångsantalet återställt) men **inte svansen**: LINNEA-brottet är
bit-identiskt kvar.

**KRAV PÅ EN FRAMTIDA ETA-ETAPP** (ingen av delarna får gå in ensam):
- `ETA_GAP_RESET` måste etablera sin nya baslinje från **senast publicerade
  värde**, inte från ingenting — det är den skyddseffekt pass 2 råkade ge.
- Outliergrindens 30 s-fönster måste bli **kadensrelativt**, inte absolut, så
  skyddet lever vid 70 s pollkadens utan en andra körning.
- `emaAlpha` kalibreras **efter** de två ovan, aldrig före — annars kalibreras
  alfa för att kompensera något den inte orsakar.
- **ACCEPTANS**: median absolutfel, andel ≤ 2 min och bias i banden **sanning
  < 5 min och < 10 min**. **ALDRIG totalsumman** — 87 % av felmassan ligger över
  20 min, och summamåttet byter dessutom tecken beroende på parningstolerans
  (parad delmängd +4,08 % vs oparad −0,9 % för exakt samma ändring).

**K8 STRUKEN som eget fynd**: biasen "publicerat > rätt" är **EMA-inneboende**,
inte en följd av dubbelkörningen. Kvot publicerat-högre/lägre 1,98:1 före och
1,93:1 efter borttagen dubbelkörning (och före-populationen är dessutom
förorenad — pass 2 har mindre eftersläpning kvar, så den äkta före-kvoten är
högre). Ska biasen bort är alfa eller en icke-eftersläpande utjämnare knappen,
inte outlier-skyddet.

**K25 gick in** (notis-tokenen byggs efter ETA-omräkningen) och **K19 gick in**
(tidsnormaliserat gps-event-ben). Mätharnessen `npm run measure:eta` är
permanent — se docs/VALIDATION.md.

**Avgångskontexten gick in (familj E, rättningskampanjen 2026-11-04, F04).**
En båt som legat still och sätter igång får inte längre sin ETA räknad på
igångsättningsfarten. `ProgressiveETACalculator._noteDepartureSample` känner
igen avgången: första sampel med fart ≥ `MOVEMENT_SOG_KNOTS` (1,0 kn) efter
minst två buffrade sampel, alla under `MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN`
(0,5 kn), högst `VESSEL_GRAVE.MAX_REBIRTH_DIST_M` (200 m, gravens radie för
"på plats") från senaste stillasampel och närmare målbron än stillheten. Då
lämnar väntans sampel fartbufferten. Farten räknas sedan på ett golv som följer
den UPPMÄTTA accelerationen ett sampel framåt, aldrig på ett antagande om
marschfarten: dubbla igångsättningsfarten i avgångssamplet
(`DEPARTURE_FIRST_SAMPLE_GAIN`), därefter senaste farten plus senaste ökningen
så länge farten stiger, och aldrig över rask kanalfart
`BRISK_CANAL_SPEED_KNOTS` = 4 kn (samma tal som E-F7:s decaygolv, som läser
konstanten). När farten slutar stiga dras antagandet tillbaka mjukt
(`_releaseDepartureFloor`): golvet ligger högst fartbruset
`DEPARTURE_SPEED_NOISE_KN` (0,3 kn, `STATIONARY_SOG_KN`) över toppfarten,
sjunker i samma takt som avståndet till målbron krymper och går aldrig under
aktuell fart. Kontexten slutar när buffertens snitt har hunnit ikapp golvet,
när farten faller mer än bruset under toppfarten eller under 1 kn, när båten
inte längre är närmare målbron än stillheten och senast efter 5 min (klass B
hörs var 60–70:e sekund, och verkliga igångsättningar i banken pågår fyra–fem
sampel). Golvet får aldrig ensamt lova "strax" (M9-principen, som decaygolvet):
bestämde golvet farten och hade den uppmätta farten inte gett strax hålls ETA:n
på 3 min, om inte imminent-flaggan äger klausulen. Det hållna värdet är en spärr
för presentationen: historiken bär det ohållna bredvid (`m9UnheldETA`), och
nästa sampels EMA räknar från det när det samplets egen mätning lovar strax
(V4-principen), annars från det hållna. Felet var en kedja: väntans nollor i
snittet ([0, 0, 1,6] ⇒ 0,53 kn), gap-reseten EFTER rå-ETA:n (meddelandevägens
29,5 blev baslinje), outliergrenen som dömde snapshot-vägens 9,8 som
dramatic_decrease och EMA:n ⇒ "om 27 minuter" för verkliga 3,1 (buggjägarens
värld 884); nu "om 5 → 4 → 3 → strax". **K6:s krav berörs inte**:
dubbelkörningen, gap-resetens placering, outliergrindens 30 s-fönster och
`emaAlpha` är oförändrade, avgången nycklas på fartbuffertens sampelnyckel så
båda passen ger samma värde, och V4 väljer bara EMA:ns bas efter ett M9-hållet
värde. Villkoren kom ur två granskningar. Den första: jämn fart räknades som
acceleration (strax → om 4 → strax i fyra av buggjägarens 2 000
standardvärldar), en båt som hördes igen 454 m från stillheten efter 11 min
tystnad räknades som avgång (MARIANNE, 20260525), en båt som vände bort fick
nedräkning mot bron, och ett tak på tre sampel släppte golvet mitt i
accelerationen ("om 4 → om 3 → om 4"). Den andra: ett FAST golv på 4 kn medan
farten steg gav för låg ETA och uppsteg för båtar som planar ut under 4 kn
("om 3" mot sanning 6 vid Klaffbron, "om 11 → 14 → 16" mot sanning 23 från
Olidebron), och M9:s hållna 3,0 drog nästa notis uppåt (SKONNERTEN JYLLAND
20260601-41h: "om 3" mot sanning 1,4). Mätt enligt VALIDATION.md §REGELN
(§ETA-mätharnessen, "Familj E"): sex låsta rader i tre korpusar flyttas, alla
rättare, och inget mätt påstående blir sämre. I platåklassen (syntetiska
avgångar 2,0–3,5 kn från tre platser) minskar de tidsviktade sampel som är minst
2 min för optimistiska från 174 till 23 och fallen med uppsteg från 56 till 36
(7699cbe har 39). Priset: en avgång som når 4–6 kn får en försiktigare första
prognos än med det fasta golvet (ALVA "om 5" mot sanning 3,1 i stället för
"om 4"); nedräkningen går därefter bara nedåt.

*Kvar utanför klassen (mätt, medvetet):* stillheten läses ur fartbufferten.
Den får bara sampel när ETA:n räknas, töms av gap-reseten och målbytet och har
kvar ankomstfarten efter en kort väntan — efter rörelse krävs därför i
praktiken TRE stillasampel, efter en tömd buffert två. Hela klassen i banken är
87 rörliga sampel efter långsam buffert som inte känns igen som avgång (tabellen
per mekanism står i VALIDATION.md "Familj E"). Tolv av dem följs av en prognos
minst 3 min för hög inom tre minuter: tömd buffert med högst ett sampel kvar
(ANTJE 211347380 20260804-both-21h 07:31:45 +12,8 min, AKIRA 257605080
20260708-21h 07:20:09 +8,8, SOLUTION 20260702-19h 07:43:48 +3,9, TINY
20260909-80h 16:34:09 +3,8, NOCHT 20260601-41h 11:12:01 +3,8, MISTRAL
20260806-42h 12:13:52 +3,3), ankomstfarten kvar i bufferten (NOCHT 12:01:02
+4,1), krypfart utan stillhet (NORDIC SOLA 258715000 20260713-41h 08:48:51
+9,5), startsampel 0,5–0,99 kn före avgången (UTOPIA 20260806-42h 08:03:38
+6,9, ANDREA 18:52:22 +4,4), långsam gång i bufferten (ZORA 20260702-19h
07:11:17 +5,9) och stillhet som aldrig nådde kalkylatorn (PILOT 761 265606970
20260710-13h 12:13:45 +11,3; ingen ETA räknades 11:49–12:13). Två vidgningar
prövades och återtogs enligt U13: ett eget stillhetsminne utanför bufferten
(överlever gap-reset, målbyte och stationär-hold) fångar ANTJE men gör 8–17
mätta påståenden sämre (ELFKUNGEN ×3, ANTJEs senare rader, YOLO 2:s notis
7 → 2 mot sanning 30 min) och flyttar en öppningsvarning; att låta de två
senaste buffrade samplen räcka (granskarens V1) fångar NOCHT 12:01 men gör
ELFKUNGENs låsta rad i 20260907-31h sämre, "om 11 → om 8" mot sanning 13,1.
PILOT 761 kräver en stillhetssignal från VesselDataService, krypfarten och
startsamplen en annan stillhetsdefinition än rörelsebeviset — klassen hör till
ETA-etappen (familj E2 och senare).

Till familj E2 (användarbeslut U20, 2026-11-04): ETA-oscillationen vid
inbromsning (buggjägarens F06, K6:s dubbla EMA mot den binära
3-minutersgränsen) och 21h-knivseggen (F07, RC4-clampen mot en extrapolerad
baslinje). E2 gör om ETA-utjämningen och spärren ovanpå F04-rättningen och
mäter om E:s sex omlåsta rader och M9/V4-utfallet, eftersom PRIMA LADYs och
SKONNERTENs värden beror på den dubbla EMA:n.

**FÄLTVALIDERINGENS REGEL: kasta det KORRUPTA FÄLTET, aldrig positionen
(H34 — DIRIGENTBESLUT 2026-08-22).** *Var beslutet togs:* granskningsunderlaget
(fältprov 10:s helkodsgranskning 2026-08-22) klassade H34 som BESLUTSBEROENDE
("BESLUT om fuzzfacit"); DIRIGENTEN lade det ändå i FIXRUNDA 1:s paket TROTS
beslutsflaggan, och den handlingen ÄR beslutet. Noten är spåret.

En COG utanför 0–360 (eller icke-finit)
fällde tidigare HELA positionsrapporten i `_validateAISMessage` (app.js) och
båten blev OSYNLIG i både bridge_text och notiser trots fullt giltig position.
Beslutet: `cog = null` ("kurs okänd") och positionen behålls — EXAKT samma
regel som SOG-sentinelen 102,3 fick i A2-2 (osynliga-båtar-incidenten,
helgranskningen 2026-07-06) och som 0,0-garden bygger på. Klassen är inte
hypotetisk: rå AIS-COG kodas i tiondels grader (0–3599) och råvärden 3601–4095
avkodas till 360,1–409,5°. `null` är ett kontrakt hela riktningskedjan redan
bär (360-sentinelen, 837 gånger i fältloggarna) och som aldrig fabricerar en
riktning. Samma normalisering på parsersidan (`lib/utils/aishubParser.js`), så
källparitet råder. **TESTLÅS SOM LOSSADES, med spår:** `cog: 720` och
`cog: -10` flyttades ut ur `GARBAGE_MESSAGES` i `tests/ais-input-fuzz.test.js`
— de är efter beslutet GILTIGA positionsrapporter med okänd kurs, inte skräp.
Facitpåverkan är noll av konstruktion: 0 av 14 836 cog-fält i korpusdata ligger
utanför 0–360 (1 373 null, 0 exakt 360).

## 9. Granskningsfynd (kvarvarande avvikelser i KODEN)

§9.1–9.4 från helrevisionen 2026-07-05 var redan åtgärdade i koden när
helgranskningen 2026-07-06 kontrollerade dem (loggraden säger PASSED_HOLD_MS,
`ts`→`entry` omdöpt, runAllCorpora säger ~100h, 5:e offret är kodmärkt i
VDS:2860) — posterna var stale DOKUMENTATION, inte kodfel. Fullständig
fyndredovisning för helgranskningen: `docs/helgranskning-2026-07-06.md`.

Medvetet accepterade beteenden (utöver P5): eta_minutes=-1-sentinelen i
flow-tokens; 3 dokumenterade INV-18-WARN i soaken (Strids 12→27 vid legitim
inbromsning); geometry-epsilongrenen i `hasChangedBridgeSide` (kräver position
~vid brolinjen — geometriskt ointaglig för köande båtar); Fix G-extrapolering
fryser för sog=null (extrapolering utan känd fart vore gissning); första
post-gap-ETA:n bär en cykels förgapsoptimism (alternativet gav korpusbelagd
fatal sågtand 2→32 min — prövad och återtagen 2026-07-06).

**Öppna A/B-fynd som MEDVETET står kvar efter härdningsetappen 2026-08-03**
(fullständig motivering i `docs/aishub-etapp5-harderingen-2026-08-03.md` §5):
`FEED_WATCHDOG` mäter AGGREGERAD tystnad (20 min) och kan strukturellt inte se
per-fartygs-degradering (fynd 10); exit-failsafens 25-minutersgräns ger
antingen värdelöst sena notiser eller tysta missar (fynd 11); Stallbackabrons
brokoordinat låg ~196–220 m vid sidan av farleden (fynd 18 — **STÄNGT
2026-08-10 av C0**, se §2 och bulleten nedan); och målbrons `distance_fallback`
(confidence 0,50) är en otestad felmod för ett fartyg som stannar ~12 m från
bron (fynd 19). Samtliga
rör facit-låsta beslutsvägar eller kräver kalibrerdata som inte finns — de ska
mätas i nästa A/B, inte gissas fram.

**ETAPP 7 (2026-08-08/09) — status på de öppna A/B-fynden ovan:**
- **Fynd 18 (Stallbackakoordinaten) är STÄNGT — C0 landade 2026-08-10 (commit 4362da7).**
  Felet var bekräftat (appens Stallbacka-avstånd systematiskt fel, **median +174 m**), men BÅDA
  etapp 7:s premisser föll: kandidatvärdet `lon: 12.317971` (härlett tolv oberoende gånger;
  42h-fältprovets median 12.318344, n=19) låg enligt Fable-granskningens oberoende
  koordinatverifiering 159,8 m AV brolinjen, så etapp 7:s revert-mätning (**−3 äkta notiser / +2
  fantomer**) gällde ett falsifierat mål. Konsensuspunkten 58.309802/12.316748 med axel 142 mättes
  i stället REN: **+3 äkta notiser, −0 förlorade** över ~320 h låst korpusdata, med båda
  öppningsskiftena utredda (20260712-25h Strids:northbound 8→9 = ÄKTA tillkommen varning,
  GALADRIEL; 20260804-17h Strids:southbound 11→10 = RÄTTAD FANTOM). Förutsättningarna som stod
  här (C9b + bro-lokal notisradie) behövdes alltså inte: radiefrågan avgjordes i samma beslut —
  300 behålls, 350 är stängt, och FG-RAD-mekanismen ligger kvar neutral och testlåst som
  beredskap. Härledningen står vid koordinaten i `lib/constants.js`, mätningen i
  `docs/c0-matning-2026-08-10.md`. Detta stycke bar de gamla värdena till fältprov 10 (K32 l).
- **Fynd 10 (per-fartygs-degradering)** kvarstår, men watchdogloggen ljuger inte längre om
  varaktighet: A7 loggar `sinceMessage`, `uptime` och `sinceConfigured` var för sig. I fält sa
  20 av 21 strikes fel tid — strike 21 påstod 120 min när sanningen var 3 009.
- **Källdödslarmet mäter nu OBSERVERAD tystnad**, `now − max(lastMessageTime,
  observationsankare)`, i stället för klientens `timeSinceLastMessage`-sentinel och socketens
  uptime. Ankaret är medvetet **icke-persisterat** (ett persisterat ankare återinför kollapsen vid
  omstart mitt i ett avbrott). `connection_status` har värdet `degraded` sedan v5.4.0.
- **MOORING_ZONES bär `queueGraceMs`** (C0b): köundantaget som höjer stillhetskravet från 3 min
  (Kajen: 15 min, obegränsat sedan U23 2026-11-09) är zon-lokalt, inte avståndsbaserat.
  Zonernas broavstånd **överlappar** (kajzonen 161–320 m, gästhamnen 319–446 m), så ingen
  avståndströskel kan separera dem.
- **Riktningslåset kräver rörelsebevis** (C4b): `_routeDirection` skrivs bara om från COG när
  `sog ≥ FIX_D_MIN_SOG`. Målbrologiken förkastade redan sådana COG; låset gjorde det inte.
- **Rådatafacit (`gt-passages/`) läser farledspolylinjen, aldrig `BRIDGES`-koordinaten** — annars
  bygger facit in exakt den buggklass fynd 18 rättar.

**Replay-fångsten kräver debug_level='full'** (sedan 2026-07-06):
`[AIS_REPLAY_SAMPLE]`-raderna loggas inte längre i normal drift (spammade
Homey-loggen med varje AIS-meddelande i produktion). run-with-logs.sh varnar
aktivt efter 2 min och skiljer sedan K24 på "loggen saknar sampel" (fel
`debug_level`) och "loggen har sampel men jsonl:en är tom" (trasig fångstväg).
**Fältprov utan debug_level=full ger en oanalyserbar körning.**
Fångstens fältlista (V3, A/B-natten 2026-08-03):
mmsi/msgType/lat/lon/sog/cog/**navStatus**/shipName/aisTimestamp/fixTs/feed/
receivedAt. navStatus saknades tidigare — förtöjningsdetekteringens lager 3
fanns då bara i AISHub-genererade korpusrader, vilket ogiltigförklarade varje
A/B-jämförelse i förtöjnings-/"inväntar"-dimensionen. De då 15 låsta korpusarna
saknar fältet som förut (→ null) och är oberörda; `replayRunner` läser redan
`s.navStatus`. Muxens `feedSwitch` fångas medvetet INTE: den är leverans-
härledd och ska räknas om av fusionspolicyn vid replay, inte frysas in.

**Fångstvägen och dess grind (K24, fältprov 10 — 2026-08-21):** jsonl:en HÄRLEDS
numera ur apploggen (`grep`+`sed` till EOF var 5:e minut och en sista gång i
nedstängningen, installerad med temp + `mv`) i stället för att skrivas i en
processubstitution som skalet aldrig väntade in. Den gamla vägen var
blockbuffrad: nattkörningen 2026-08-19 fick 24 576 byte = exakt 6×4096 och 99
hela rader mot loggens 146 sampel — 32 % av rådatafacit borta utan ett enda
varningsspår. Nu gäller `jsonl ⊆ logg` per konstruktion, och filen kan alltid
byggas om i efterhand. Håldetektorn i summaryn räknar därför numera BÅDA
delarna (tidshål i loggen + jsonl-rader mot sampelrader) och avslutar med ett
samlat verdikt — `Logg-integritet: OK|FEL` — som körboken kräver för
korpuslåsning; `checkReplayIntegrity.js` kör samma kontrakt fristående
(rad-för-rad-jämförelse, `--corpora` över alla låsta korpusar). Appens egen
`AIS_REPLAY_CAPTURE_FILE`-väg finns kvar men pekar på en SEPARAT fil —
`homey app run` kör appen på Homey-enheten och skalets env följer inte med dit,
så två skrivare mot samma sökväg vore ren risk utan vinst. Retroaktiv kontroll
2026-08-21: alla 20 jsonl-filer i `corpora-data/` (de 17 låsta korpusarna, den
olåsta 42h-körningen och fusionsparet) är HELA — 14 836 rader, `OK 19, DELVIS 1,
FEL 0, OKÄNT 0` (DELVIS = fusionskorpusen, vars aishub-del inte är loggbar; se
§7). Ingen låst korpus har tagits in trunkerad. Nedstängningen är omskriven i
samma runda: pipelinen körs i BAKGRUNDEN och väntas in med `wait`, eftersom bash
servar en trappad signal först när förgrundskommandot är klart — med den
oändliga pipelinen i förgrunden sköts `INT`/`TERM`/`HUP`-trap:en upp i evighet
och körningen gick varken att stoppa eller avsluta med summary.

Åtgärdat sedan 2026-07-03: "Fem lager"-kommentaren rättad (constants.js:193);
MessageBuilder/ETAFormatter/StallbackabronHelper raderade — noll levande
förekomster (grep 2026-07-05); `shouldDebounceBridgeText` numera privat i
SystemCoordinator, ingen publik `hasActiveCoordination`; helgranskningen
2026-07-06 raderade även `test-integration-complete.js` (stale API-referenser,
homeyignorerad), `.eslintrc.json` (död konfig — `.eslintrc.js` har företräde)
och ProximityServices oanvända `getProtectionZoneStatus`/`getUnderBridgeStatus`.

**H29/H30 — armklasser utan släppväg (bekräftat 2026-08-22, fix ÅTERKALLAD
samma dag):** Två armklasser i `BridgeOpeningService` kan bli beväpnade utan att
någon släppväg äger dem, och båda är fältbelagda. (i) EN MEDLEM VID AVFYRNINGEN
får `warnedAt` av `_fire` (:1652) men varken `absorbedAt` eller `coverUntilMs` —
absorptionen sätts i `_bindLooseArms`, inte i avfyrningen. Hon faller därför
genom BÅDA släppvägarna: `_releasePassedEventArms` (:1363) hoppar över varje arm
med `warnedAt !== null`, och `_releaseStrandedArms` (:1306) prövar bara armar med
`absorbedAt !== null` och finit `coverUntilMs`. Hennes täckning har alltså ingen
utgång alls, och hennes EGEN öppning blir aldrig varnad. Fältbevis: YOLO 2
(265819150) @ Stridsbergsbron 2026-08-05 passerade 9 min efter händelsens första
passage utan ny varning; ANTJE (211347380) satt bunden 50,6 min; S/V REBEL blev
nära-miss och räddades enbart av att hon tystnade (`ARM_STALE_TTL_MS`). (ii) EN
FRYST ARM (C7b, `_hasUnappliedObservation`) utesluts ur `members` (:1025) och får
därför ingen `warnedAt` — men behåller sitt `eventId`. Efter upptining hoppar
avfyrspärren över henne (händelsen bär redan `firedAt`), `_bindLooseArms` rör
bara armar med `eventId === null`, och `_releaseStrandedArms` kräver
`absorbedAt`: permanent gisslan. Fältbevis: ELFKUNGEN @ Klaffbron nr 27,
21,7 min.

En fix för båda låg i arbetsträdet 2026-08-22 och ÅTERKALLADES samma dag
(arbetsträdet återställt till HEAD, `tests/h29-h30-armslapp.test.js` raderad).
Den släppte den varnade medlemmen på REN TIDSLOGIK — `max(firedAt,
firstPassageAt) + CONVOY_WINDOW_MS`, formeln lånad från `_bindLooseArms` — utan
någon bevisprövning, och det höll inte i fält. Tre orsaker: (a) armobjektet bär
ingen position alls (`grep` på `arm.lat`/`arm.lon` ger 0 träffar), så
`_bridgeIsBehind` (:460) — vakten som finns för exakt den här klassen — inte gick
att tillämpa vid släppet; (b) `_evaluateBridge` kör släppet (:985), bindningen
(:1001) och avfyrningen (:1036) i SAMMA anrop, så ingen ny observation krävdes
mellan släppt och varnad igen, och släppet nollade `warnedAt`/`eventId` men
lämnade `fireDueMs` orörd — en släppt arm var därför förfallen i samma
millisekund hon släpptes och avfyrade i nästa tick; (c) fel systerställe lånat:
det äkta är `_rescueCoveredArms` (:1217), som bär tre grindar släppet saknade
(krav på finit `earliestArrivalMs` och `expectedArrivalMs`, `now`-mot-`dueMs`,
och ledtidsgolvet 2 × `TICK_INTERVAL_MS`). UPPMÄTT FÖLJD: 12 av 13 nya
öppningsvarningar avfyrades på ett läge som var 10,5–28,7 min gammalt (median
16,6 min); VIRGO och PILGRIM varnades 5,4 respektive 6,9 min EFTER sin egen
passage enligt icke-inferrat rådatafacit, utan att någonsin korsa bron en andra
gång; H-4b:s >1-räknare försämrades 79 → 87 medan 0-räknaren bara förbättrades
24 → 21; och `replay:openings` gick från exit 0 till exit 1.

KRAV PÅ ETT NYTT FÖRSÖK (ingen av punkterna är valfri). Armen måste bära sitt
SENAST KÄNDA LÄGE: `lastSeenAt` finns redan (:527/:633, skrivs bara av
`_refreshArm` och är därmed tiden för senast TILLÄMPADE fix), men `lat`/`lon`
saknas och måste sättas i både `_arm` och `_refreshArm`. Släppet måste sedan
kräva (1) att bron INTE ligger bakom armen — `_bridgeIsBehind` mot det nya
lägesfältet; ligger den bakom ska armen AVVÄPNAS, inte släppas; (2) FÄRSKHET,
dvs. `lastSeenAt` nyare än händelsens `firstPassageAt` — annars är passagen
obevittnad och släppet vilar på gissning. Färskheten räcker INTE ensam: en
förtöjd men sändande båt förnyar `lastSeenAt` i evighet (det är samma klocka
`ARM_STALE_TTL_MS` mäts mot), så lägesvillkoret måste bära lika mycket som
klockan. Vidare (3) samma grindar som `_rescueCoveredArms` (finit ankomstfysik
plus ledtidsgolv), och (4) en NY deadline i stället för den ärvda, förfallna
`fireDueMs`. TESTKRAVET ÄR NEGATIVT: den återkallade sviten låste fixens NYTTA
men aldrig dess KOSTNAD (H29-mutationen fällde bara 1 av 10 tester, att jämföra
med H22:s 13 av 19), så ett nytt försök ska bära rött-utan-vakt-tester för VIRGO
(265552100 @ Stridsbergsbron 2026-07-10, passage 11:52:51, återkallad varning
11:58:17, deadline-grenen) och PILGRIM (211110880 @ Stridsbergsbron 2026-07-14,
passage 12:30:25, återkallad varning 12:37:19, fix-grenen): båtar som korsar bron
under tystnad utan att `notePassage` anropas, och som därför INTE får en andra
varning. U2-SEMANTIKEN är oförändrad och styr utfallet: en öppning lever till
FÖRSTA FAKTISKA PASSAGEN, och en båt som anländer efter den plus
`CONVOY_WINDOW_MS` är NÄSTA öppning — men aldrig en andrapåminnelse för samma
öppning.

**K-familjen (rättningskampanjen 2026-11-04) — KRAVEN tillämpade på
RECOVER-vägen.** H29:s varnade medlemmar har fortfarande ingen släppväg (fixen är
inte gjord om). Buggjägarens kort F02, F03, F11, F14, F17, F20, F22, F23 och F01
gällde i stället `_releaseStrandedArms`, de ABSORBERADE armarnas släpp, som hade
samma form: släpp på ren tid och avfyrning på den ärvda deadlinen. Rättningen
(`_coverageVerdict`, `_crossingEstimate`) följer kraven så här:
- Armen bär `lat`/`lon` ur senaste tillämpade fix. **(1)** Ligger bron bakom
  läget avväpnas armen som passage. Utvidgat på samma grund: låg hon UNDER bron
  (≤ `UNDER_BRIDGE_SET_DISTANCE`, ≥ `MINIMUM_VIABLE_SPEED`) med förväntad ankomst
  inom täckningen, eller leder kursen bort från bron (≥ 2 kn, utanför
  väntzonen), hålls täckningen kvar tills nästa fix (F20, F03, F14).
  Under-bron-hållet strider inte mot U17 (dirigentens beslut 2026-11-05): en
  båt som senast sågs högst 50 m från bron, i rörelse och med ankomst inom
  täckningen, är vid brolinjen och har i praktiken passerat. Visar nästa
  position att hon inte har det, släpps hon som förut.
- **(3)** Utan finit ankomstfysik släpps hon inte (hängslen: `_canArm` kräver ett
  finit avstånd, så ingen arm i drift når grenen). **(4)** gäller bakkanten: den
  släpper på ett färskt, rent fix efter den bokförda första passagen, och
  deadlinen räknas ur det fixet (F02, F17, F22, F01:s r2). Vid täckningsslut
  avfyras armen däremot på deadlinen ur sitt senaste tillämpade fix, som för en
  tyst båt sedan länge har förfallit. Bakkanten jämför med det som slutar
  först av täckningsslutet och U2-fönstret kring korsningen. Att jämföra
  enbart med U2-fönstret mättes: när ledaren passerat senare än sin prognos
  höll den kvar följarna till täckningsslutet, och de varnades efter sin
  korsning. Priset är snabbvärld 295 (R0): HAVSORN släpps på 0,8 s marginal
  och varnas 28 s före en korsning som ligger inom U2-fönstret efter DAGNY, en
  andrapåminnelse som bryter mot U2 (KÄND_ÖPPEN U2-VS-DEADLINE). Grinden
  "släpp bara när den färska deadlinen ligger framåt" tog bort den men gav 5
  nya utslag.
- Medlemskapet i konvojfönstret mäts mot den skattade korsningen, inte mot
  bokföringen (F01). I banken ligger bokföringen median 109 s och p90 625 s
  efter korsningen. Täckningsslutet, alltså när en tyst båt får sin
  säkerhetsvarning (U17), räknas däremot från bokföringen som förut (revision
  3, U13): med täckningen räknad från korsningen flyttade den låsta raden
  20260712-25h 265806230 08:37:18 → 08:34:15, och rådatan belägger fönstrets
  slut men inte när båten passerade (likvärdig). I buggjägarens klustervärldar
  hade den varianten fixat fyra tysta båtar till (331, 510, 790, 1139) men i
  snabbprofilen gett tre nya varningar efter sann passage eller på fruset fix
  (5, 21, 56), och i standardprofilen 184 kandidatutslag mot 181. Interpolationen gäller varje passage med fix på var sin sida om
  bron, inte bara AIS-glapp: U2 räknar fönstret från passagen, och en variant
  som bara interpolerade glapp över `STALE_ETA_SOFT_MS` lämnade fler missade
  öppningar i buggjägarens standardvärldar (T2 31 mot 26). Visar fixet före
  bron en stilla eller köande båt (`waitingAtBridge`, eller sog under
  `MINIMUM_VIABLE_SPEED`) ligger korsningen inte på den räta linjen utan
  senare: då gäller max(rät linje, bakåtskattning ur fixet efter bron i dess
  fart), och utan mätbar fart efter bron den räta linjen (omgranskningen
  2026-11-05; i snabbprofilens 32 väntefall median −101 s och värst −780 s
  med linjen, median −1 s och spann −90…+30 s med regeln). En fryst arm får
  bokföringstiden: hennes senaste tillämpade fix är inte nödvändigtvis det
  senaste före bron. Låg armens senaste tillämpade läge redan bortom bron
  används det fixets tid som övre gräns, i `observeVessel` lika väl som i
  `notePassage` och passagedomen. Utan fix bortom bron (`notePassage` med levande arm,
  passagedomen) används fixets tid bara när armens eget läge redan låg bortom
  bron; en projektion ur prognosen startade fönstret för tidigt när ledaren
  väntade och gav en andrapåminnelse (`opening-updated-host-forecast.test.js`).
- **Korsningsankarets golv** (granskningen, buggjägarens värld 227). Ankaret
  gjorde att ZELDA:s retur, upptäckt 13 m före Stridsbergsbron och 10 s efter
  korsningen, fick en egen varning. Hör en ny båt till händelsen mätt mot
  bokföringen men inte mot korsningen, och ligger hennes ankomst närmare än
  2 × `TICK_INTERVAL_MS` på ett färskt rent fix, absorberas hon som före
  rättningen, och bakkanten mäter henne mot täckningsslutet i stället för mot
  U2-fönstret. Samma golv som räddningsventilen.
- **U17 (ägarbeslut 2026-11-04): säkerhetsvarningen för en tyst båt behålls.**
  Gäller en båt vars senaste position sa att hon skulle hinna igenom den
  gemensamma öppningen, men där appen inte vet om hon gjorde det. Ingen öppning
  får missas; F11/F23-klassen godtas som falsklarm av samma slag som
  AVBRUTEN_APPROACH, och buggjägaren registrerar den som DESIGN med källa U17.
  Därför är färskheten i **(2)** (lastSeenAt nyare än firstPassageAt), en
  åldersgräns på fixet (`STALE_ETA_HARD_MS`) och ledtidsgolvet i **(3)** inte
  införda. Mätt mot U13 tog de i korpusbanken bort 5–16 RECOVER-varningar, och
  O1 (appserien) fick 3–4 OKLASSADE missar: 20260702-2h 265558470, 20260707-14h
  AKIRA, 20260713-41h ELFKUNGEN vid Klaffbron och Stridsbergsbron. Golvet hade
  dessutom flyttat en äkta räddning till efter korsningen (20260804-17h
  211100280: rådatans korsning 13:58:29, varningen 13:48:28 blev 14:00:01) och
  skjutit LYS varning (20260707-14h) in i hennes korsningsfönster. Hållen under
  bron och för kurs bort är inte en sådan grind: de gäller lägen som säger mer
  än en prognos (appens egen under-bron-gräns, en kurs bort från bron) och
  skjuter bara upp släppet till nästa fix.
- Negativtesterna för VIRGO och PILGRIM ligger i
  `tests/k-konvoj-recover-bakkant-glapp.test.js`, liksom U17-kontraktet och ett
  fällande test per grind (granskningens mutationsprov).

### Helkodsgranskning runda 2 (2026-08-22) — uppskjutet med diagnos

Runda 2 (13 paketgranskare, 80 skeptiker, HEAD 480b78f) bekräftade 24 fynd;
16 åtgärdades i fixrunda 2/2b/2c (J1 J2 J20 J4+J5 J12 J18 J22 J30 J9 J15 J21
J6+J35 J14-doc J28 J29 J38 — se handoff-2026-08-21/helkodsgranskning-
runda2.md, hkfix2-rapport.md, hkfix2b-rapport.md, hkfix2c-rapport.md); J10
och J17 ÅTERSTÄLLDA med diagnos (nedan), J32 löst som KOMMENTARFEL (koden stod
rätt). Fixrunda 2 och 2b UNDERKÄNDES av granskarna (2: J15 första varianten
dödade post-gap-omvarningen, J10 avslöjade klämkedjan; 2b: J17 återuppväckte
AKIRA-spöket och bar 6 av 7 omlåsningar, J32 harnessrastrerades till +30 s)
och rättades i 2b/2c — samma läxa som runda 1: varje fixvåg bär egna fel. Rundans HUVUDSIGNAL: 4 av runda 1:s 12 fixar
bar egna fel (H14 → J1, H1 → J2, H19 → J20, H24 → J4/J5) och tre lämnade
ospeglade syskon (H22 → J21, H34 → J6, H38 → J38). Varje fix i fixrunda 2
kräver därför ett redovisat SYSTERSTÄLLESVEP (grep-bevis per fix).

**Omätta beteendeändringar från fixrunda 2 (FÄLTPROVSCHECKLISTA — noll
korpustäckning, vilar på enhetstest genom riktig pipeline + mutationsprov).**
Varje punkt bär sitt loggmönster; fältprov 11 ska bekräfta att (a) mönstret
uppträder när klassen finns och (b) utfallet är sant mot rådata:
- J1 (removal-snapshotens U-svängsflagga per värde): 0 fall av pending vid
  removal i 18 korpusar. Mönster: `EXIT_TRIGGER_DEDUPE_EXPIRED_HOLD … reversal
  pending` / `EXIT_TRIGGER_SKIP_REVERSAL` på removal-vägen (var onåbara före).
- J2 (`_deriveAssignmentDirection`: COG → ruttlås → slutlås → bronamn): låset
  skilde sig från bronamnet 0 gånger i banken. Mönster: `ROUTE_LOCK_KEEP` kan
  inte längre skriva "källa målbro-fallback"; `TARGET_CHANGE … ACCELERATED` för
  COG-lös båt med lås ska följa låset.
- J9 (S-3-spärren geometrisk + fail-closed): `UNDER_BRIDGE_TIMEOUT`-grenen
  loggas 0 gånger i replay — onåbar där. Mönster: spärren HÅLLS i bandet
  50–70 m efter passage (förr släpptes den rutinmässigt) — bevaka att ingen båt
  fastnar utanför under-bro-latchen (se J9-kommentaren i StatusService).
- J28 (syntetisk hållning nollar episodfälten): no-op i banken.
- J30 (omätbar feedtystnad = tyst): harnessen fryser klientens stats ⇒ BÅDA
  P8-vakterna omätbara i replay. Mönster: `FEED_SILENCE_UNMEASURABLE` (ny rad)
  följd av att senaste texten behålls i stället för "Inga båtar".
- J6/J35 (aisstream COG-/NAVSTAT-normalisering via `aisFieldNormalization`):
  replay anropar aldrig `_extractAISData`. Mönster: F2-paritet — samma
  fysiska rapport från båda källorna ska ge `cross_feed_duplicate`, inte två
  accepterade fixar; navStatus 15 skriver aldrig över känt 1/5.
- J38 (svaljloggens strypning): ingen korpus bär ett kastande fält. Mönster:
  högst en `BRIDGE_TEXT_SWALLOWED`-rad per minut och signatur, "undertryckta: N".
- J18 (latchens riktning ur COG när anroparen saknar riktning): 0 träffar i
  alla 18 korpusar OCH 0 i synth — fältprov 11 är första gången beteendet
  ses. Mönster: `PASSAGE_LATCH … källa=cog`. Styr om reversal-grenen
  blockerar inväntar/närmar sig i 10 min ⇒ pelare 1.
- J29 (P2R2-4-kontrollen före nyckelradering på expired-vägen): grenen nås
  6 gånger i banken men den persistenta grinden svarar aldrig blockerad ⇒
  den ändrade effekten (sessionsnyckeln överlever) inträffar aldrig i replay.
- J12 (`_clearTargetGrace` på alla målbytesvägar): nådd 20 gånger i banken,
  bevisat inert mot facit. Mönster: `TARGET_GRACE … Starting 60s grace period`
  där det förr stod `TARGET_CHANGE … none` med flersiffrig grace.
- J20 (maxRecentSpeed null): 0 i korpus, 50 träffar i synth (sog=null-
  scenariot) — synth-täckt, inte omätt.
- J4+J5 är MÄTTA via fusionsgrinden (tunna-urvalsgrenen nås 11 130 gånger,
  grinden grön) — står medvetet INTE på listan.
- J15 boot-fönstret (omstartsdedup): synth-täckt sedan 2c, ingen korpus
  startar om. Mönster: `OPENING_DEDUP_PERSIST … (omstartsskydd)`.
- J22 (`hasArmingMovementEvidence` i `_canArm`): MÄTT (3 enkelsampelsfantomer
  bort, 0 äkta), men klassen är sällsynt — bevaka `OPENING_ARM_SKIP`-raden
  (eller motsvarande) för fartyg med ett enda sampel.

**Kvar, medvetet:**

- **J17 — avgränsat rättad 2026-09-18.** `ProximityService.calculateProximityTimeout`
  behåller 65 s-basnivån första minuten efter en passage när färska transitbevis
  saknas. `scheduleCleanup` förkortar aldrig en redan beviljad timer och skyddar
  passagevisningen; den tidigare beskrivningen av ett generellt dödligt 65–70 s
  pollglapp var därför missvisande. Det reproducerade felet var utebliven
  **förnyelse**: efter ett 19-minuters AIS-glapp bokfördes Olidebron med 3 kn
  råfart och Klaffbron framför båten, men ursprungstimern gick ut elva minuter
  efter den färska passagen. Texten blev "Inga båtar" en minut före nästa fix.
  Nu förnyas resan bara vid bokförd passage, rent accepterat positionssegment
  ≥50 m, råfart ≥befintliga transitgränsen 1 kn och en opasserad målbro framför
  i den kända ruttriktningen. Låg/okänd råfart och GPS-osäkra positioner får
  fortfarande den korta basnivån; visningens tidsgränser är oförändrade.

  Avgränsningen bevarar SR2-3: ett tidigare försök att göra 65 s till ett
  ovillkorligt golv förlängde AKIRA 257605080 i `20260707-14h` (0,1 kn, 409 m
  norr om passerade Klaffbron) från 6,5 till 25 minuter och gav spöktext även
  för MISTY i `20260804-17h`. Närhetsfiltret ensamt räcker inte — kö-klassen
  kunde fortfarande ge 25 minuter via opasserade Järnvägsbron 568 m bort.
  Den nya regeln ger exakt oförändrade texter/tider, notiser, passager och
  öppningar i båda hela korpusarna. `tests/j17-continuing-passage-retention.test.js`
  prövar den fortsatta resan och båda råfältstoppen med/utan minutstädning;
  `tests/j17-passage-taket-ar-inte-ett-golv.test.js` låser kvarvarande basnivå
  för objekt utan dessa transitbevis.
- **J32 — micro-grace-fönstret** (`_shouldApplyMicroGrace`): KODEN står som på
  HEAD (`hasCriticalTransitions ? 3000 : 5000`); KOMMENTAREN var felet.
  micro-grace är en 200 ms PAUS före publicering; kritiska under-bro-
  övergångar får ett KORTARE berättigandefönster (3 s) så de publiceras
  opausat snabbare. Fixrunda 2:s "rättning" till 5 000 lade en paus på
  kritiska övergångar i bandet 3–5 s (bakvänt) och harnessen rastrerade den
  till +30 s i fyra goldens + en fasberoende knivseggsrad i 2h — allt
  återställt i 2c.
- **J15 boot-fönstret (avvägning, skriven):** en post som överlevt en omstart
  dedupar till avfyrning + CONVOY_WINDOW + ETA (kapat 1 h); en AVBRUTEN
  anflygning före omstarten lämnar posten kvar tills dess (nollas bara av
  passage), så en äkta ANDRA öppning för samma båt/bro/riktning inom fönstret
  efter en omstart kan tystas. Sällsynt × sällsynt (71 AVBRUTEN_APPROACH i
  grindarna, men omstart mitt i är Homey-uppdateringens ögonblick).
  Alternativ som står öppna: nolla nyckeln även när armen släpps, eller binda
  fönstret till händelsens deadline. Synth-scenariot "omstart-mitt-i-passage"
  flyttades i 2c så grinden faktiskt provar boot-fönstret (tidigare dött:
  hela dedupen kunde kopplas bort utan rött).
- **J21:s systerställe rad ~833** (`ETA_GROWTH_CAP`:s `isStationary` prövar
  nakna 0,8 medan rad ~562 nu prövar MOVEMENT_SOG_KNOTS 1,0): i bandet
  0,80–0,99 säger de motsatt sak (golvet släpps medan tillväxtklamman står
  av). Befolkat band (116 sampel/58 mmsi). Eget litet paket med A/B mot
  measure:eta — får inte smygas in.
- **J10 — K19:s systerställe i `SystemCoordinator.coordinatePositionUpdate`
  (naket `movementDistance > 300` ⇒ `large_movement` ⇒ `coordinationActive` ⇒
  PROTECTION CONDITION 5)** står KVAR som naket 300 m-tal, MEDVETET. Fixrunda 2
  tidsnormaliserade grinden (rätt i sig: 7,5 % av bankens segment passerade
  300 m, 100 % under 10 kn), men i 20260712-25h tog det bort en OAVSIKTLIG
  dämpning som dolde ett befintligt fel: FRAM 211864690 stannade 16:42:53 på
  886 m från Stridsbergsbron (sog 0, > 4 h, passerade aldrig) och fick 16:45:25
  texten "om 10 minuter". Rå-ETA var 11,5 min (passagegolvet 2,5 kn på varm
  buffert); med färskhetsregel J10b (två slöa sampel i svansen ⇒ inget golv)
  blev rå-ETA 26,1 — men PUBLICERAT stod på 9,85 i båda fallen: raden ägs av
  klämkedjan `ETA_MONOTONIC → ETA_ABSOLUTE_CLAMP → ETA_GROWTH_CAP + EMA`. J10b
  mättes dessutom SÄMRE (`measure:eta` median 2,30 → 2,38, ≤ 2 min 47,8 → 47,1 %,
  5 låsta goldens rörda) och drogs tillbaka. Beslut: SystemCoordinator = HEAD
  (diff = kommentarer), 25h-raden "Inga båtar" = sant. ÖPPET FYND till nästa
  granskning: *klämkedjan låser en nyss stannad båts publicerade ETA* — kräver
  egen mätd design i K6-familjen (ETA-etappen), inte kirurgi. K19:s EGEN grind i
  VDS går nu via `lib/utils/movementPlausibility` (byte-identiskt i 18 korpusar);
  SystemCoordinator-stället är en namngiven kvarvarande kopia i hjälparens docblock.
- **J13+J33 — konvojbindningens värdval** (`BridgeOpeningService._bindLooseArms`
  ~:1070): (a) en arm som `_releaseStrandedArms` just släppt återabsorberas i
  SAMMA utvärdering av en ANNAN redan avfyrad händelse (10 av 56 RECOVER i
  korpusbanken, kedja i tre led) — RECOVER-loggradens löfte om egen händelse
  håller inte i 18 % av fallen; (b) `find` tar FÖRSTA matchande händelsen i
  skapandeordning, inte den med närmaste referensankomst. Båda är äkta, men
  den uppmätta "fixen" (kräv `host.firedAt` nyare än armens senaste släpp +
  närmaste värd) flyttar öppningsfacit i ≥ 6 korpusar och varnings-/öppnings-
  kvoten BORT från U2:s 1,00 (364 → 368 varningar). Det är ett SEMANTIKVAL
  (vad en släppt arm ska få binda till), inte kirurgi — hör ihop med H28
  (konvojkonvention) och H29/H30 (release-vägen) ovan: ETT användarbeslut +
  ETT omlåsningsprotokoll med O1/O2-mätning för hela konvojfamiljen.
  (K-familjen 2026-11-04 ändrar inte värdvalet, och täckningen vid en
  återabsorption räknas från bokföringen som förut: 20260712-25h 265806230
  varnas fortfarande 08:37:18. F11 och F23 är fortfarande kedjor i två led.)
- **J14 — `notePassage` bokför inte armlösa båtars passager** (`_recordPassage`
  returnerar utan arm). Valet är MEDLEMSKRAV: en öppningshändelse stängs av
  sina medlemmars passager. app.js-kommentaren i `_observeBridgeOpening` som
  lovade "hängslen" för armlösa vägar var osann och är omskriven (fixrunda 2).
  U2-tolkningen "första FAKTISKA passagen oavsett medlemskap" är det
  alternativa valet — tas i samma beslut som J13+J33.
- **J19 — F6b-offseten är inte domäninvariant**: `applyAccept` lagrar den
  KORRIGERADE stämpeln; när offseten först blir negativ jämförs nya stämplar
  mot referenser lagrade med offset 0, så F1/F6 kan avvisa 1–2 färska hubbfixar
  tills råtiden hunnit ikapp. Självläkande inom 1–2 pollar; skeptikerna mätte
  ingen användarsynlig effekt. Fix (spara råstämpel vid sidan av) vid nästa
  fusionsetapp.
- **J11 (osäker)** — mellanbrons bokföring gatas på ankarvakten
  (`_anchorPassageTimestamp`) medan systermetoden
  `registerConfirmedIntermediatePassage` bytte till PROCESSED-vakten. 837
  anrop i 20 korpusar, 0 `false` — asymmetrin är verifierad, nåbarheten inte.
- **J26 (osäker)** — `_aishubWatchdogStrikes` delas mellan kedjedöds- och
  tystnadsgrenen; skeptikerna fick motsatt resultat om ett smalt fönster
  (HTTP 500-storm minut 4–7 ⇒ 1–2 uteblivna tvingade omförsök). Ofarligt i
  mätt drift; egen räknare per gren vid nästa vaktöversyn.
- **Dementerade i runda 2** (ska inte återuppstå utan nytt bevis): J3 (SOG-
  grinden: namnhalvan hårdblockerad, negativ SOG onåbar), J7, J8 (`_isApproaching`-
  spärrarnas räckvidd — konsekvensen dementerad), J16 (tomkanalslarmet i
  både-läge), J23/J24/J25/J40 (H16 höll helt), J27, J31, J34 (K20a mäter
  bakåt BY DESIGN), J36, J37, J39.


### Helkodsgranskning runda 3 (2026-08-22, HEAD 53f02a2) — uppskjutet med diagnos

Runda 3 (13 paketgranskare, 80 skeptiker): 40 kandidater → 12 bekräftade (0 critical,
4 major, 8 minor), 24 dementerade, 1 osäker. Torrare än runda 2 — men 5 av runda 2:s 16
fixar bar egna fel (L1 J22×graven, L2 J20×H19, L5 J12 kö-zonen, L19 J15-syskon, L6 J30),
och två fynd satt i ny kod/kommentar (L20, L37). Fixrunda 3 åtgärdar L3 L1 L5 L2 L14 L19
L20 L21 L23 L37 L13-doc L34 L40-doc; L9 som MÄTT försök — se handoff-2026-08-21/
helkodsgranskning-runda3.md och hkfix3-rapport.md.

**Kvar, medvetet:**

- **L9 — `isCompletedTimeout` utan terminalpositionskontroll: ÅTERKALLAD PÅ MÄTNING
  (fixrunda 3).** Mekanismen är äkta (timeout + Olidebron/Stallbackabron i passedBridges
  ⇒ `_completedJourneys` ⇒ 10-min reentry-block även för en båt som vänder INNANFÖR
  utfarten ⇒ missad boat_near/bridge_opening_soon). Två varianter mättes i isolerat
  träd över 18 korpusar (krav på `hasCompletedJourney` resp. enbart latitudgrindarna —
  IDENTISKA siffror, kostnaden sitter i latitudgrinden): VESSEL_REENTRY_BLOCK 116 → 66
  och JOURNEY_RESET 31 → 13 (vinsten), men GRAVE_INHERIT 1615 → 1650 (+35 i fem
  korpusar) och VESSEL_REMOVED 2468 → 2496 — rad ~1004 gatar gravläggningen på
  icke-isCompletedTimeout, så åtstramningen flyttar kajliggare till graven och
  återöppnar P9-churnen. Notis-/öppningsmultiset oförändrade. Acceptanskrav (a)
  (ingen churn-ökning) föll ⇒ återkallad; karakteriseringstest låser dagens beteende.
  Krav på en framtida fix: koppla isär "avslutad resa" från "gravläggs inte" (t.ex.
  terminalzon-grind BARA för reentry-blocket, inte för gravvården) och mät churn + reentry
  tillsammans.
- **L5:s TREDJE systerställe — `TARGET_PROTECTION_ACTIVE`** (VDS ~:619, else-grenen
  när målbroskyddet är aktivt) hoppar över HELA grace-blocket (skapande OCH
  radering); en post från före skyddet åldras hela vistelsen. Mätt i fixrunda 3:
  rör 20260601-41h (161→163 övergångar) och tar tillbaka both-21h (335→333) —
  kräver egen rådataverifiering ⇒ eget fynd nästa runda. J12:s kravlista är
  därmed FEM anropsställen, inte fyra.
- **L5:s avvägning (dirigentbeslut, fixrunda 3):** CARAT 211452170 i both-21h:
  kö-grenen raderar grace-posten ⇒ den falska "Inga båtar"-flashen 04:40:11
  (559 s) blir 04:47:31 (107 s), DEFAULT-episoder 12→11, DEFAULT-tid 24 494→24 042 s
  — men "strax"-spöktexten för samma båt blir obruten och 60 s längre (21 759→
  21 819 s; measure:eta i korpusen 385→388 påståenden, p90 50→86 min). Accepterat:
  kortare falsk DEFAULT väger tyngre än 60 s på ett spöke som redan står 6 h.
  ROTORSAKEN ÄR ÖPPEN — **kajvobblare med brusig fartgivare**: sog-brus 0,1–1,5 kn
  nollar stillhetsklockan så CARAT aldrig klassas förtöjd och 2h-backstoppen är
  onåbar för klassen (hon ligger 401–436 m N om Klaffbron hela natten, avgår
  06:53). Eget fynd nästa runda; koppla till C11/C11b.
- **L3:s smala restvariant:** startar under-bro-latchen med en position som redan
  är äldre än UNDER_BRIDGE_FRESH_MS blir freezeAnchorMs < _underBridgeSince,
  Math.max nollar och ackumulatorn står på 0 tills ett färskt sampel kommer
  (kräver _underBridgeSince satt från timerpass med gammal position). Självläker;
  om den mäts i fält: ankra på max(freezeAnchorMs, _underBridgeSince).
- **L14 gjordes i MINIMAL variant** (zombie-/färskhetspredikaten kopierade i
  `_generateSafeFallbackText`, inte utbrutna till delad hjälpare; under-målbron-
  dominansen och zombie-uteslutning ur ledarvalet speglas inte). Städetapp:
  bryt ut `isZombie`/`hasFreshPosition` till lib/utils och låt båda anropa.
- **L6 — P8-texthållningens bortre gräns (ANVÄNDARBESLUT).** När tystnadsmåttet är
  omätbart (J30) ELLER mätbart > 5 min håller BÅDA P8-vakterna senaste positiva
  brotext UTAN bortre gräns (pre-existerande doktrin: "vi VET inte att kanalen är tom").
  J30 breddade bara ingången (omätbart = tyst). Alternativ: (a) tak — efter
  STALE_FEED_RECONNECT_MS utan mätbart livstecken degradera till
  STALE_DATA_OVERRIDE_TEXT (larmet följer med); (b) låt hubbklienten skilja
  "ansluten men aldrig levererat" från "lyckad tom poll" så det omätbara läget inte
  omfattar en frisk tom kanal. Triggern är smal (klientombyggnad mitt i en positiv text).
  Inget ändrat — beslutet är användarens (designdoktrin, inte bugg).
  **Ny mätning (helgranskningen 2026-11-03): triggern är INTE smal.** Det mätbara benet
  (> 5 min utan positioner) slår till på varje tom nattkanal. I en replay med produktionslikt
  tystnadsmått hölls 16 av 143 övergångar båttext → DEFAULT (11 %), 4 av dem till körningens
  slut. Premissen "5 min tystnad = tappad prenumeration" strider mot U12. Rekommendation: låt
  P8 använda U12:s svarspredikat, så att DEFAULT släpps igenom när en källa svarar och
  avbrottstexten (D5) gäller vid äkta blindhet. Fortfarande inget ändrat.
- **L4 (osäker)** — GPS-outliergrenen i ProgressiveETACalculator (~:966) saknar
  30-sekundersgrinden och kan frysa en stannad båts ETA via `_underBridgeLatched`;
  bedöms om EFTER L3 (frysackumulatorn), som styr latchens verkliga livslängd.
- **L39 — DÖD KOD:** skyddszonens uppskovsblock i `_handleTargetBridgeTransition`
  (VDS ~:3887) nås aldrig (0 av 122 i fält, 0 i testsviten, 0 i instrumenterad replay
  över 54 000 updateVessel-anrop) — `_pendingTarget` konsumeras alltid i samma tick.
  Tidigare beskrivning i §4 ("uppskov i skyddszonen") gäller alltså inte en levande
  väg. Ta bort eller väck i eget paket; ändra inte premisser på den.
- **L15 = H13** (båtantalet läses före exit-notisens await) — känd backlogg, 0 race-
  träffar i 4 671 fältborttagningar.
- **L29** — `_recordZoneTransition` armerar kritisk hållning inifrån predikaten
  (ospeglat S-3-syskon); enda konsument är micro-grace, kostnad ≤ 200 ms. Städetapp.
- **L13** — O1:s avfyrningsfönstergrind mäter tick-rastrering, inte ledtid (dueMs
  härleds ur samma tal som beslutar avfyrningen). Docblocket rättat i fixrunda 3;
  ledtidsfördelningen per korpus (t − originalDueMs) är OLÅST — separat facitlåsning.
- **Dementerade i runda 3** (återuppstår bara med nytt bevis): L7 (echo-gaten har tak
  via dataIsFreshEnough), L8, L10, L11 (J4: bypass-stämpeln blir inte F1/F6-referens
  på det sätt kandidaten påstod), L12, L16, L17, L18, L22, L24, L25, L26, L27, L28,
  L30, L31, L32 (känt), L33, L35, L36, L38.


### Helkodsgranskning runda 4 (2026-08-23, HEAD 0b72310) — läge och uppskjutet

Runda 4 (13 paketgranskare, 80 skeptiker): 40 kandidater → 12 bekräftade (2 critical,
BÅDA pre-existerande: M1 C9b-rotorsaken för kajvobblaren, M2 kajgrindens enkelsampel-
undantag), 3 osäkra, 12 dementerade, 13 bekräftade under 12-taket. Trend (bekräftade per
runda): 12 → 24 → 12 → 12 — loopen konvergerar i ALLVAR (runda 3:s kod införde inga
critical; regressionstakt ~17 %/våg) men inte i ANTAL: granskarna vänder nya stenar
utanför diffen varje runda. Två mätinstrument visade sig partiska: öppningsgrinden ärvde
produktionens 3,13 kn-kortslutning (M2) och INV-14 tystnade när en falsk "Inga båtar"-
episod växte förbi 300 s (M24) — båda rättas i fixrunda 4 (handoff-2026-08-21/
helkodsgranskning-runda4.md, hkfix4-rapport.md).

**Fixrunda 4/4b — läge (2026-08-23):** levererat M24 (INV-14W, synth-WARN-baslinjen
5 → 8: navstatus-flap-väntare 540 s, ankrad gles sändare 1440 s, återfödd-i-kö HERA 900 s),
M1 (IHÅLLANDE stillhetsankare: raderas bara vid äkta avgång ≥ MOVEMENT_PROOF_NET_M
eller GPS-flaggat prov ⇒ ankarålder mäter VISTELSENS ålder, inte klockans; CARAT
förtöjd 04:29 i st.f. aldrig; 74 min spöktext bort), M2 (kajgrindens enkelsampel-undantag
kräver korroborerad transit via `lib/utils/quayTransitProof.js`, delad med öppnings-
grinden; fantomvarningen 03:54 bort), M6 (skyddsgrenen STÄMPLAR OM nådafristen),
M11 (persistens + hysteres), M12 (AISHubClient: ABSOLUT deadline på _inFlight ≈
2×HTTP_TIMEOUT + pollintervall; forceReschedule bryter inaktuellt _inFlight), M37
(sann text för skuggläge utan nyckel), M4 (exit-grindens stillhet i FIX-domänen), M9
(idle-decayns golv harmoniserat med imminent-radien + hysteres via flaggan: 'strax'
utanför 300 m blir 'om 3 minuter' — 17 tidigare omätbara påståenden, alla närmare
sanningen). DELVIS: M8 (GPS-fallback-taket 3 i följd stoppar obegränsad serie men INTE
den isolerade första träffen — LA FEMME-klassen kräver annan konstruktion; taket räknas
i beräkningscykler ⇒ K6:s dubbelkörning gör det ≈ 1,5 fältsampel — mät om när K6 tas)
och M16 — ÅTERKALLAD i 4c: korroboreringen gav noll facitrörelse OCH slog ut L5:s
kö-zonsvakt för klassen 0,5–2,0 kn (finit-vägens systerstämpel mäter mot föregående
prov ⇒ 7–46 m/steg ⇒ aldrig 50 m ⇒ recentlyActive aldrig sann; mätt: köare i 1,5 kn
behåller målbron 600 s på HEAD, 120 s med M16) — lastActiveTime stämplas som på HEAD,
karaktäriseringstest låser 600 s-beteendet; en framtida korroborering måste ge BÅDA
stämplarna ett ackumulerande ankare och mätas i 10–60 s-kadens. M9b läser imminent-
flaggan EN svepning gammal (flaggan skrivs i `_reevaluateVesselStatuses` efter ETA-
beräkningen): läckande riktning = cykeln efter att båten lämnat 350 m-bandet kan ge
'strax' en tick; mätt 0 på banken; ofarligt eftersom den tvingade decayn inte tas när
avståndet krymper > 20 m/cykel. ÖPPNINGSGRINDENS `classifyMiss` (4b): rörelsebeviset har
TRE led (position ≥ MOVEMENT_PROOF_NET_M från första horisontsampel; ETABLERAD
STILLHETSVISTELSE ≥ ARM_STALE_TTL_MS inom 50 m + ett tätt fixpar med implicerad fart
< 0,5 kn ⇒ sog-spikar är jitter; korroborering ur `quayTransitProof`) — OBS: grindens
grönhet för CARAT vilar på det ANDRA ledet, en efterhandsregel produkten inte har;
korroboreringsledet är inert på dagens bank. Ompröva vid nästa korpustillskott. ÖPPET/KOPPLAT: M5 (stillhetsprövning i fart-
känd-grenen) — removal-snapshotten bär inte `_stillnessAnchor`, och M1 ändrade
ankarets betydelse; designfrågan 'äkta avgång som tystnar inom 50 m' måste avgöras
innan fältet bärs in (halvan borttagen i 4b, bokförd här). Mätinstrument rättade:
öppningsgrindens `classifyMiss` korroborerar rörelsebevis (4b), INV-14W synlig.
M28 (dirigenten, fixrunda 4): skuggparningens färskhetsval läste `best.storedAt`
(finns inte ⇒ första rutan i svepordningen vann); nu `best.side.storedAt`, låst av
`tests/m28-skuggparning-farskhet.test.js`; fixLag-medianen byter tecken (−7 396 →
+12 051 ms), 71 → 79 par — skuggmätaren visar rätt riktning.

**Kvar efter fixrunda 4 (12 bekräftade under taket + osäkra; M28 åtgärdad — se läget ovan):**
- M33 (major): jitter-grinden för segmentbeviset (StatusService ~1138) kräver finit sog
  < 0,3 i BÅDA samplen — ett brusigt sampel kopplar bort hela CG2-1-spegeln ⇒ kajliggare
  kan få korsningsbevis. 0 fältfall; eget paket med C9b-kopplingen.
- M36 = H10 (runda 1, aldrig åtgärdad): 40–49 m-bandet i null-sog-vägen returnerar utan
  `_classifyMooring` ⇒ `_moored` kan inte släppas för den klassen.
- M7 (under-bro-hysteresen 50–70 m kollapsar för REDAN passerad bro), M15 (graven bär
  inte `_stillnessAnchor`), M18 (gpsEventDetected skrivs över varje tick ⇒ 30 s-släppet
  dött), M10 (GPSJumpAnalyzer dömer rörelse LÅNGSAMMARE än rapporterad fart som GPS-fel;
  okänd fart ⇒ 0), M34 (koordinationsflaggan parkeras utan timer), M21 (nödfallbackens
  bro ≠ ETA-klausulens bro), M22 (moored-benet i `_disarmEvidence` utan warnedAt-vakt),
  M25 (StatusStabilizer fönsterläcka), M27 (F6b konsumerar inte parbeviset), M29 (auth-
  klassningen på ordet "invalid" pausar AISHub 6 h vid parameterfel).
- Osäkra: M35 (graven återställer episod- men inte reseankaret), M30 (REBORN_MOVEMENT_PROOF
  delar ut `_plausibleMovementSeen` på ren distans), M26 (kvarhängande GPS-hoppflagga
  nollar under-bro-klockan per timerpass).
- Dementerade i runda 4: M3, M13 (mux.connect reconcilerar korrekt), M14, M17, M19, M20,
  M23, M31, M32, M38, M39, M40.


### Helkodsgranskning runda 5 (2026-08-23, HEAD 2c67a13) — läge, dementeringar, stoppkriterium

Runda 5 (13 paketgranskare, 80 skeptiker): 40 kandidater → 12 bekräftade (0 critical; 5 major:
N2 pre-ex ACCELERATED-ticken utan passagedetektering, N11 M11:s frysta kajankare, N13 M11:s
prune-klocka, N21 hold-hybriden återspelar fel bros text, N20 svepkandidaten förloras), 5 osäkra,
23 dementerade. Fixrunda 5 åtgärdar N7 N8 N25 (M1:s tre systrar) N13 N11 N5 N10 N29 N30 och
prövar N2/N21/N20 som MÄTTA försök (handoff-2026-08-21/helkodsgranskning-runda5.md, hkfix5-
rapport.md). Trend (bekräftade/runda): 12 → 24 → 12 → 12 → 12 (~17 råa) — konvergens i ALLVAR
(0 critical), inte i antal. Fixvågens egen felfrekvens runda 4: 3 nya defekter/11 fixar (27 %).

**Fixrunda 5 — läge (2026-08-23):** levererat N7 (gråzonen 0,3–0,49 kn frågar nu
_stillnessJitterHolds — ERSÄTTER runda 4:s medvetna "gråzonen orörd"; två brusprov på moget
ankare utan netto HÅLLS), N8 (null-sog-avgången nollar ankaret), N25 (GPS-flaggat prov river
inte ett moget ankare; kassering bara vid netto ≥ 50 m), N2 (ACCELERATED-tickens eget segment
prövas mot mellanbroarna — 5 rådataverifierade passager, notisantal oförändrat, detektionsgrad
342→343/402; KVAR), N11 (laddningen ogiltigförklarar kajankarets geometri, behåller klockorna),
N13 (delad ttl-klocka stillAt→bandSince i prune/persist/load), N5 (GPS-flaggade sampel skiftar
inte prevFix), N10 (AISHub-vakten körs även när aggregatet är frånkopplat), N29 (egen dedupnyckel
för skuggnotisen), N30 (AISHubClient: settings-läsning skyddad i connect; armeringsögonblick i
perFeed), N21 (hållningarna kräver att den bevarade texten nämner en bro hållningen handlar om —
nästa målbro härleds ur passagehistorikens geografi; fail-open utan positionsbevis; två golden-
rader i both-21h rådataverifierade). N20: SVEPBENET levererat (ett matchande segmentsvep räknas
som transitbevis i nordgrenen); FAILSAFE-BENET (observerat latitudhopp passerar förtöjnings-
returen i large-jump-failsafen) ÅTERKALLAT i 5b — det fällde det låsta fälttestet
"förtöjd båt är undantagen" (korrigeringar-2026-07-02b) och har noll uppmätt effekt i banken;
klassen "förtöjd + oflaggat stort hopp" är ÖPPEN tills fältbevis finns.

**Öppet efter fixrunda 5/5b (dokumenterat, ej kod):** N13:s FJÄRDE klocka — bandgränsens
hysteres i `_noteQuayStability` (~1562) läser stillAt rakt av (en post med bara bandSince faller
på FÖRSTA fixen utanför bandet; blocket körs i replay ⇒ egen facitmätning krävs); N5:s syster —
ankarSKRIVNINGEN i `_noteQuayLedgerEntry`/`_noteQuayStability` tar GPS-flaggade sampel (en flaggad
utflykt > 100 m med lågt sog kan plantera ankaret fel — samma skadeklass som N5 via annat fält);
N29 täcker bara skuggläget (both-grenens lugnande besked delar fortfarande nyckel med det
alarmerande); BOS `_hasStillnessEvidence`-docblocket beskriver nu M1/N7-regeln (klockan behålls
så länge nettot från ett moget ankare < 50 m ⇒ en avgång i 0,4–1 kn håller avväpningen kvar i
minuter — ombeväpningen kan behöva eget rörelsevillkor). N21:s innehållsgata: strängmatchning
av bronamn (alla 569 golden-texter nämner en målbro); nästa målbro ur passagehistorikens geografi,
fail-open utan positionsbevis; nya loggrader `PASSED_HOLD_UI_SKIP`/`GPS_HOLD_UI_SKIP`. N30: C-agentens
`pollChainArmedAt` i perFeed + app.js-fallback (5b); `_readLastPollAt` try/catch så `connect`
aldrig kastar före schemaläggningen.

**Fixrunda 5b (2026-08-23, GODKÄNT m. anmärkningar):** N20 ben b återkallat (failsafen
kodidentisk med HEAD); gråzonstestet i `tests/moored-vessel-detection.test.js` ("GRÅZONEN
OFÖRÄNDRAD", runda 4-låst) OMLÅST OCH DELAT i "UNGT ANKARE ⇒ släpper som förr" + "MOGET ANKARE ⇒
hålls (N7)" med motivering per rad; N30:s app-fallback (`pollChainArmedAt` när
`lastPollStartedAt` saknas, strikt underordnad, `tests/n30-app-fallback.test.js`); N29b:
both-grenens lugnande besked fick egen nyckel `aisstream:nokey:both` (`BOTH_NOKEY_NOTICE_KEY`) —
`aisstream:nokey` bärs nu bara av de två alarmerande avsändarna. MÄTHYGIEN för nästa läsare:
`npm run replay:all` skriver "AVVIKELSE olåst 20260806-42h" (134/135 notiser, 2 dubbletter
Stridsbergsbron, ETA-sågtand, 2 DEFAULT-FLASH) och bart `replay:phase` sveper de OLÅSTA
korpusarna (117 avvikelser) — BÅDA RÖDA REDAN PÅ HEAD, ingen regression; rökprovet är det
NAMNGIVNA fassvepet på minsta låsta korpus (20260611-4h).

**SYSTERSTÄLLESRUNDAN (2026-08-23, efter fixrunda 5b, HEAD ecc93e6 — mekanisk enumerering av 8
predikatfamiljer + 3 "följ ett meddelande"-spår → dedup 30 → 14 kombinerade skeptiker på critical/major
(bantad av budgetskäl; 16 minor/info OPRÖVADE) → syntes).** 13 BEKRÄFTADE (7 major, 6 minor, 0 critical),
S9 dementerad. Git blame: NOLL av de 13 ligger i kod skriven av fixrunda 4–5b (första gången i loopen);
men S2/S3/S8/S12 är missade SYSTERSTÄLLEN till N5/N20a/M1-familjen/N29 (4/13 = 31 % på vidaste läsningen
⇒ villkor (3) "uttömmande systerställesvep" fortfarande ej uppfyllt). INGEN KOD ÄNDRAD — fixplan nedan är
överlämningen (se `handoff-2026-08-21/systerstallesrundan-rapport.md` för bevis/repro per fynd):
- **S4 (major, pelare 2) app.js ~8683:** kandidatordningen pushar target/current FÖRE just-passed och
  seen-mängden blockerar andra pushen ⇒ en NYSS PASSERAD bro får källan current/target ⇒ tokenet säger
  "närmar sig" (35 notiser i låsta korpusar). FIX: rör INTE ordningen (källsträngen bär dedupen) —
  boolean bredvid passedTriggerPoint enligt H16-mönstret; noll ändring i notis-/bro-/riktningsmultiset.
- **S10 (major, pelare 2) VDS ~367 + app.js ~10253:** tokenet läser _finalTargetDirection/_routeDirection
  FÖRE levande kurs; Fix D:s tvåobservationsdebounce ⇒ första samplet efter vändning bär gamla låset
  (ELFKUNGEN: norrut-token i 6 kn söderut, both-21h). FIX i notisvägen: färsk pending-reversal + bron
  bakom fartyget ⇒ avstå/okänd. FACIT: minst en låst post (both-21h ELFKUNGEN Klaffbron) — BESLUT.
- **S6 (major, pelare 2) app.js ~8065:** RC-S3:s rörelsebevis godtar ETT brusprov (_hasMovementProof
  sätts av ett sog ≥ 0,5) ⇒ förtöjd båt 63 m från Klaffbron får notis efter 4 min OCH tystar den äkta
  passagen i 2 h (dedupposten). FIX: blockera så länge nettot från satt stillhetsankare < MOVEMENT_PROOF_NET_M
  (mutation "kräv korroborerat" FALLER 5 korpusar — välj inte den). Kräver rådataverifiering av en extra
  Kanalinfarten-notis.
- **S2 (major, pelare 2+3) app.js ~2005 — N5:s syster:** _quayDepartureNeedsProof mäter netto från
  bokföringsankaret till en GPS-flaggad RÅ position ⇒ ett osäkert sampel "bevisar" avgång. FIX: nettot =
  null när samplet är GPS-flaggat (N11-mönstret). Noll uppmätt i banken.
- **S5 (major, pelare 2 riktningstoken) VDS ~3448:** _northProgressMps returnerar null utan oldVessel;
  stashen skrivs bara vid mätning, graven bär inte nordprogressen ⇒ K1-Kanalinfartsregeln oftast UTAN
  bevis vid trigger-punkten efter återfödelse. FIX: andra basposition ur app._lastKnownPositions (egen
  tidsdomän), maxålder + fartspärr. FACIT: 2 poster i corpora-direction-distribution (unknown→northbound,
  258715000 41h m.fl.) — rådataverifiering.
- **S1 (major, alla pelare) GPSJumpGateService ~305:** shouldBlockPassageDetection blockerar bara
  enhanced/system_wide; SystemCoordinator ger moderate för uncertain_position (accept_with_caution 100–500 m)
  ⇒ skenbar rörelse kan bokföra passage. FIX (snäv): blockera även moderate+protection när sog finit < 0,5.
  Noll uppmätt; tvåstegsbekräftelsen räddar kandidaten.
- **S12 (major, infra) app.js ~12059 — N29:s syster:** aisstream-tystnadsnotisen saknar hubFeedsPipeline-
  termen som hubbgrenen (fynd 17) har ⇒ skuggläge får falskt lugnande "halverad redundans" samtidigt som
  blindhetslarmet. FIX: spegla fynd 17 + skuggparentes i loggraden. Noll facitrisk.
- **S3 (minor, pelare 2) app.js ~8834 — N20a:s syster:** V1-kajgrinden raden under FP9 gör continue på
  matchande segmentsvep utan dedupnyckel ⇒ Kanalinfarten-notisen förloras (LATENT: grinden har aldrig
  blockerat i banken). FIX: en rad, samma härledning; n20-testets block b2 omlåses.
- **S7 (minor, pelare 3) app.js ~2153:** kajvobbelbokföringen täcker 500 m, beväpningen 2500 m ⇒ kajliggare
  i 500–2500 m-bandet har ingen post, predikatet svarar falskt. FIX: bokför i bandet runt målbroarna med
  LÄNGRE vistelsekrav (ARM_STALE_TTL_MS). Omätt ⇒ mät O1/O2 ON/OFF.
- **S8 (minor, pelare 1+3) VDS ~3002:** stillhetsklockan seedas olika (null-sog: ankartid; finit: nu).
  Kandidatens fix MOTBEVISAD (river skyddet); mätt variant = backdatering vid moget jitterhåll — replay
  IDENTISK mot HEAD men 3 karakteriseringstester (M1 kö-nåden, N8, N25) måste omlåsas — BESLUT.
- **S11 (minor, pelare 3) app.js ~7835 + BOS ~1793:** dedupnyckeln bro|mmsi|riktning stämplas med
  LEDARENS riktning för alla medlemmar (mötande konvoj). FIX additivt fält medlemsriktningar i payloaden
  (hör till konvojbeslutet); k13b-testet låser ledarnyckeln.
- **S13 (minor, pelare 3) app.js ~7977:** J15:s openExpiry byggs ur ETA-TOKENEN (noll vid stale fix,
  ser inte köande) ⇒ för kort omstartsskydd (127/366 varningar i banken utanför). FIX: bär armens
  förväntade ankomsttid i payloaden; halva B redan bokförd (J15-avvägningen).
- **S14 (minor, mätinstrument) runOpeningGates ~951:** O2:s fantomklassificering matchar mot appens EGNA
  passager, ingen rådataserie (O1b/H-4 har). FIX: O2b med facitargument bredvid O2, inferrerade poster
  aldrig i hinkindelningen.
- **OPRÖVADE (budget) S15–S30:** bl.a. S15 N25:s nettoingång på flaggad position (VDS ~3041), S16 N11:s
  docblock falsifierad (ankaret fryser även i levande session — 191 fall, värst 1033 m/5 h; bankens
  verdikt gynnar HEAD), S17 två textreplay-vägar utan BT-F5-undantag (5580/6359), S19 scenario A saknar
  L19-konsumtion, S20 nådafristblocket körs efter TARGET_END i samma tick (nyckel "mmsi:null", 12/28
  starter i tre korpusar; mutation byte-identisk), S21 M6 vs S-F8, S22 _targetRemovalGrace saknas i
  leakDiagnostics, S23 fem riktningsgrenar utan syskonens vakt, S24 absorberade medlemmar utan dedup-
  post, S25 N20:s korridor vs förtöjd-retur, S26 fynd 17 vs aishub:auth/server, S27 notistoken kringgår
  ETA-skydd, S28 removal-snapshot saknar lastPosition/_trackingEpisodeStartTs, S29 INV-grammatik utan
  riktningssuffix, S30 DEBUG_FULL_PATTERN ETA_CALC ≠ ETA_CALC_V2. Dessutom E6:s inerta systerställen
  (TARGET_PENDING_RESOLVED utan gap-kedja: 16 fall, A/B byte-identisk = kostnadsfri härdning).
- **Syntesens rekommendation:** fixrunda 6 i 8 paket (A kajgrindfamiljen S2+S3+S7+S6-ankarbenet
  TILLSAMMANS; B S4+S10 tokensanning; C S11+S13 payload; D S1; E S5; F S8; G S12; H S14) följd av en
  SMAL verifieringsrunda mot bara paketens kod + systerställen, budgetbox för S15–S30 — INTE en sjätte
  bred runda. Därefter fältprov 11.

**FIXRUNDA 6 LIGHT (2026-08-23, användarbeslut vid 75 % budget: paket A–H utom S8; S10+S6 godkända;
ingen ny loop efteråt).** Landat (bytidentiskt facit där inget annat sägs): **S1** GPSJumpGateService —
`shouldBlockPassageDetection` blockerar nu även koordinationsnivå moderate+protection när fartyget har finit
sog < MOVEMENT_PROOF_SOG_KN (helper `_blocksUncertainPositionOnStillVessel`; tvåstegsbekräftelsen räddar
äkta passage; latent i banken). **S14** runOpeningGates — O2b (fantomklassificering mot gt-passages, fjärde
hink INFERRERAD_TID, `reportGtPhantoms`) INFORMATIV bredvid O2, exitkoden oförändrad tills OPENING_GT_STRICT.
**S5** VDS — `_rebirthNorthBase`: nordprogressens andra basposition ur `app._lastKnownPositions` när
oldVessel saknas (maxålder VESSEL_GRAVE.TTL_MS, fartspärr via movementPlausibility golv 0; mottagnings-
klockan medvetet — posten bär ingen fixTs); FACIT: exakt 2 riktningsposter unknown→northbound (258715000
41h, 265576720 17h), notisantal oförändrat. **S2** app.js ~2003 — `_quayDepartureNeedsProof` beräknar inte
netto-benet på GPS-flaggat sampel (null; N11-mönstret) OCH ben (a) räknar inte "okänt p.g.a. flagga" som
"ingen geometri" (granskarfynd: annars öppnade ett flaggat sampel LADYBIRD-klassen) — en fix fördröjning,
aldrig förlorad notis. **S3** app.js ~8902 — V1-kajgrinden hoppas över
vid matchande segmentsvep (N20a-härledningen). **S6 ÅTERKALLAD** (granskare 2, egen tidsmätning): grinden "ingen
notis så länge nettot från stillhetsankaret < 50 m" tog bort NOLL fantomer i banken men sköt 12 FÖRVARNINGAR
till efter passagen (ELFKUNGEN 169 m före → 1825 m förbi; RONJA 82 m före → 201 min senare) — notisens TID/
KÄLLA bärs av inget facit. Rotorsaken (brusprov ⇒ fantom + dedup-post som tystar äkta passage) är ÄKTA och
ÖPPEN; smalare variant måste kräva kajzonsnärhet/avståndsgolv och mätas på notistid+källa. M5-frågan
därmed fortfarande öppen för båda vägarna. **S12** app.js ~12156 — aisstream-tystnads-
notisen + eskaleringstrappan villkoras på hubFeedsPipeline (fynd 17 speglat) + skuggparentes i loggraden;
**S12b** (dirigent): glappet i skuggläge (socket uppe, tyst kanal, hubben ser trafik ⇒ U12:s "tom natt"
utesluten) stängt med en SANN blindhetstext på egen nyckel `aisstream:silent:shadow` (N29-doktrinen);
socketen nere ägs av totalgrenen (feeds:silent) — ingen dubblett. Eskaleringstrappan förblir both-only.
`tests/kajavgang-korroborering-v1.test.js` FYND 17-blocket omlåst av S12 (förstärkt) — GODKÄNT av dirigenten. **S7 ÅTERKALLAD** (byggd + mätt ON/OFF): bokföring i 500–2500 m-bandet med 30-min-krav tog bort
en LÅST öppningspost (AKIRA 257605080 2026-07-08 07:20 Klaffbron southbound, eventId 8 — harnessen klassar
den själv som AVBRUTEN_APPROACH, netto 13 m, 1,5 kn) ⇒ enligt rundans villkor "flyttad låst öppningspost"
återkallad trots att O1 inte sjönk och O2 förbättrades; kod+test i sessionens scratch `hkfix6/app1/s7-
aterkallad/` — USER-BESLUT om posten är fel i sak. **S8** hoppad (minor, replay-identisk). **S4** app.js
`_triggerBoatNearFlowForBridge` — kandidatordningen ORÖRD (källsträngen bär dedupen); boolean enligt H16-
mönstret: bro som appen själv bokfört som passerad inom nådan ⇒ already_passed sant + "precis passerat"-
texten trots källa current/target, och eta nollas explicit (kontraktet eta=-1 även för 'target'-källan —
granskarfynd); 109–122 notiser byter text/ETA över 20 korpusar, notisantal/bro/riktning/källa/distans
identiska. OBS: notistext, ETA-sentinel och already_passed bärs av INGEN facitdimension — ändringen är
omätt av batteriet och vilar på fixens härledning + measure:eta (notiskanalen 2537→2003 summa|f|).
FIX_D_PENDING_MAX_AGE_MS är nu EN konstant i lib/constants.js (delad av Fix D-blocket och S10-vakten). **S10** notisvägen — smal vakt: Fix D:s färska
pending-reversal (15-min TTL) motsäger tokenriktningen OCH den notifierade bron ligger bakom fartyget på
levande kurs ⇒ avstå; FACIT: ELFKUNGEN 265573130 2026-08-05 12:28:49 Klaffbron northbound (127 m SÖDER
om bron, sog 6,0, cog 188,8 — fantom, användargodkänd) försvinner (both-21h 152→151, distribution Klaffbron
3→2, riktning 2→1); HAJH-LAIF 265800960 Järnvägsbron i 20260702-2h SKJUTS UPP 11:55→12:25 (till det ögonblick
hon återupptar nordfärden; samma bro/riktning, multiset still). Inert för återfödd båt (graven bär inte
pendingflaggan — fail-open). **S11** BOS payload `memberDirections` {mmsi→north|south|null} additivt ur
samma källa som eventDirection; app.js bygger dedupnyckeln av medlemmens egen riktning, ledarens som fallback
(k13b-testet omlåst m. motivering). **S13** BOS bär armens förväntade ankomsttid (MAX över medlemmarna —
eftersläntrarens skydd för alla; per-medlem vore exaktare) och app.js bildar openExpiry ur den (kap 1 h) i
stället för ETA-tokenen; breddar boot-fönstret åt samma håll som J15-avvägningen (en äkta andra öppning
inom fönstret tystas) — DIRIGENTBEDÖMNING: accepterat, eftersom tokenen systematiskt underskattade (127/288
= 44 % varningar utanför skyddet) och fönstret fortfarande är kapat; uppmätt förlängning: längre i ~hälften
av avfyrningarna (both-21h 20/33 max +31 min; 42h 16/35 max +30 min; 41h 20/48 max +7 min; 1–2 slår i
1h-taket); fältprov 11 mäter. S11 ENGÅNGSEFFEKT vid uppgradering: poster skrivna av tidigare version
matchar inte för medlemmar med egen låst riktning (5 i both-21h, 2 i 41h) ⇒ ett extra öppningskort kan gå
ut en gång per berörd medlem efter uppdateringen. ÖPPET: S2 ben b
(bandbeslut/V1-radering på samma flagga), S10 för återfödd båt (graven bär inte `_fixDPendingReversal` —
fältlistoffer nr 10, fail-open), S10:s trigger-punktsgren bara enhetstestad (0 träffar i banken), HARNESS-
BLINDFLÄCK: notisens TID/KÄLLA/TEXT/already_passed bärs av ingen facitdimension (replayRunner fångar
message/alreadyPassed) — nästa harness-etapp bör lägga en informativ diffrapport (O2b-mönstret) i
runAllCorpora; docs/VALIDATION.md:s O2b-cell skriven av S14-agenten = godkänd av dirigenten.

**VIKTIGT — dementerat med mätning (återuppstår bara med nytt bevis):** N1 (M1 "släpper inte
förtöjd vid rapporterad fart" — blockregionen ligger innanför projektets egen 40 m-gräns; första
avgångssamplet släpper vid ≥ 50 m netto = ≤ 1 poll), N3 (M2 "underkänner avgångsfixet" — samma
40 m-gräns; öppningsgrinden grön), N4 (mottagningsklockan över källgränsen), N6 (M1 inert för
återfödda = M15, känd), N9 (C9-avväpningen onåbar efter M1), N12 (0 av 268 849 predikatanrop),
N14 (0 av 12 964 observationer), N16, N17 (klientens råa dedup skuggar fusionen), N18, N19
(M16:s återkallade regression skulle återinföras), N22 (0 av 5 321 anrop), N24, N26, N28, N31,
N32, N33, N35, N36, N37, N39, N40.

**Osäkra (kvar):** N15 (M8-taket nollställs av K6-dubbelkörningens andra kalkyl — mät när K6
tas), N23 (M11:s hysteres över en avfärd med EN utanförfix), N27 (GPS-gatens kurstolerans i
mottagningsdomänen), N34 (RouteOrderValidator läser bara momentan COG ⇒ ordningsvakten faller
bort vid okänd riktning — reproducerad, minor), N38 (gps_coordination_active fyrar av under-bro-
latchen, inte GPS ⇒ M8 kalibrerad mot fel population — diagnostik).

**Syntesens stoppkriterium (tre villkor över två på varandra följande rundor):** (1) 0 critical
och 0 major i kod rundan själv ändrade (major = reproducerad genom produktionsvägen med rådata-/
korpusbelagt fel utfall); (2) fixvågens felfrekvens < 10 %, mätt av nästa rundas granskning av
just den vågen; (3) varje landad fix bär ett UTTÖMMANDE systerställesvep (alla läs-/skrivställen
för det ändrade predikatet, beslut per ställe). Status efter runda 5: EJ uppfyllt (N11 major i
M11:s kod; 27 %; N7/N8/N13 var missade systrar). METODLÄXA: de fyra pre-existerande majors som
överlevt fyra rundor delar form — tillstånd som lever exakt EN tick eller EN gren (else-if-kedja
som hoppar över detektering; flagga utanför fältlistan; håll utan innehållskoppling; vakt oarmerad
före första pollen) — och syns bara när man följer ETT meddelande genom hela kedjan. Därför: efter
fixrunda 5 körs en SYSTERSTÄLLESRUNDA (mekanisk enumerering av varje anrops-/skrivställe för de
predikat runda 4–5 rört) + "följ ett meddelande"-pass i stället för en sjätte bred runda.

### Helgranskning 2026-11-03 — rättat och beslutspunkter

Underlaget står i `docs/helgranskning-2026-11-03.md`; varje fynd prövades med tre linser
(produktionsrepro, känt/beslutat, påverkan på rådata och facit). Rättat i koden:

- Målbrogrenens väntehysteres i `_isWaiting` gäller bara väntan vid målbron. Väntan vid
  Järnvägsbron flyttades annars till Stridsbergsbron ~93 m söder om Järnvägsbron (ARESTEL).
- `_closeVisitsOnCompletedJourney`: en borttagning med fullbordad resa
  (`hasCompletedJourney`, positionsbevis) stänger fartygets öppna besök.
  `TriggerPointVisitTracker.closeOpenVisits` är den enda vägen utanför `observe` som sätter
  `exitedAt`. Tystnad, förtöjning och timeout stänger fortfarande ingenting.
- Fix D-bekräftelsen i samma tick skickar `previousTargetInvalid` till ACCELERATED-grenen, så
  2-READINGS inte mäter mot det övergivna målet. AVVÄGNING (granskningen av fixvågen
  2026-11-04): en gles äkta U-sväng får kortet en fix tidigare och returpassagen bokförd, men en
  väntslinga med två motriktade fixar i ≥ 2 kn längre än 300 m från målet ger nu ett accepterat
  AVBRUTEN_APPROACH-kort mot motsatt riktnings målbro (förut bara inom 300 m eller vid tre fixar).
  ANYA ELAN i both-21h är en sådan slinga. Slingskydd (beväpna först efter nästa fix i samma
  riktning) är ett användarbeslut. Returpassagen bokfördes bara när bekräftelsen kom före
  bron; kom den på fixen bortom bron stod bron kvar i `passedBridges` tills R1
  (rättningskampanjen 2026-11-04, se U-svängspunkten ovan).
- `_hasGapCrossedNotifiedBridge` är en tredje passerad-formsignal bredvid S4 och H16. Bron ska
  ligga strikt mellan föregående (eller sist kända) och aktuell position i gap-kedjans fönster,
  och hoppet ska gå i färdriktningen. Källsträng och distans lämnas orörda. Färdriktningen tas ur
  ruttlåset, annars ur kursen (nordbandet, det breda sydbandet). När kursen inte säger nord eller
  syd, alltså i östra dödbandet 46–134° och när kursen saknas (AIS 360 "ej tillgänglig" och
  ogiltiga värden blir null i `_validateAISMessage`), bär K1:s färska nordprogress riktningen
  norrut (`_freshNorthProgressMps`, samma kontrakt och ribba som Kanalinfartsregeln; K1 själv
  gäller fortfarande bara östbandet). Det stänger F13 (2026-11-04, dirigentens JA på R2:s fråga
  1, som uttryckligen omfattar även saknad kurs och det långa hoppet utan återfödelse): återfödda norrgående båtar med nordostlig kurs (SALTIS 49,9°, en okänd båt 46,2°) fick
  förvarningsform 107–115 m efter Olidebron, och SALTIS fick samma notis med kursen 360. En
  sydlig kurs ger fortfarande 'south', så en återresa behåller förvarningen. Nordprogressen mäts
  över samma hopp som BN2 prövar (från föregående fix, eller från återfödelsens bas). Regeln
  betyder därför i praktiken "hoppet gick norrut med minst 0,25 m/s": alltid vid ett långt hopp,
  och vid återfödelse bara med en bas som är högst 15 min gammal. Den ger aldrig 'south': ett
  hopp söderut med dödbandskurs eller utan kurs behåller förvarningsformen (känd gräns, inget
  fall i banken). Kantfall: en båt som korsat bron norrut under tystnaden och redan vänt, men
  har kurs 46–134° eller ingen kurs, får "passerade" i stället för "närmar sig". Påståendet är
  sant för korsningen under tystnaden; returen får en egen notis enligt U14.
- Mellanbrons avståndsreserv i `_hasPassedBridge` täcker bandet mellan
  `UNDER_BRIDGE_CROSS_SEGMENT_MAX_M` och `LARGE_JUMP_LAT_DEG` (den delade hoppgränsen, förut
  hårdkodad 0,005).

**Beslutspunkter (användarens):** L6/P8 med ny mätning: 11 % av båttext → DEFAULT hålls i
produktion, se nedan. BN1: utfarter vid boxkanten lämnar besök öppna (VISTEN, REBEL, JUNO). open3:
ETA utan fixålder (D2). Latenta fynd utan uppmätt effekt är listade i rapporten.

### Rättningskampanjen 2026-11-04 — U14, en notis per passage (kort B01)

Användarbeslutet U14 gör INV-5/7 till kontrakt: en båt som passerar en bro, vänder och passerar
tillbaka får en notis även för returpassagen. Besöksregeln 2026-09-07 justeras bara för den
passagen; en båt som guppar eller väntar vid bron får fortfarande en notis per besök.

- **Felet:** en vändning inom 350 m bortom bron stängde aldrig besöket (två fixar över 350 m
  krävs), så `holds` tystade returpassagen. Buggjägaren fann klassen i 30 världar (B01: WILMA
  vänder 162 m söder om Klaffbron; felbandet 125–308 m).
- **Rättningen:** dedup-lager 3 i §3. Den första prototypen släppte besöket redan när
  bokföringen kom och båten låg vid linjen. Granskningen visade att det gjorde passagelogikens
  falska bokföringar (distance_fallback när GPS-bruset för en väntande båt till linjen) till
  notiser för en båt som vänt och sedan väntade nära bron: 2–3 notiser i 13 av 30
  svepkörningar. Beviset kräver nu att båten är tydligt ute på ankomstsidan och under gång dit;
  vid tät AIS väntar en bokföring vid linjen på nästa fix. Släppet läser även `passedAt[bro]`,
  eftersom `lastPassedBridge` bara håller den sist stämplade bron när två broar bokförs i
  samma tick (granskningens M1/M2).
- **Omgranskningen 2026-11-05:** vid gles AIS (Class B med jitter, AISHub) godtog förra
  revisionen en fix som fortfarande låg på bortre sidan inom 10 m från linjen. Passagelogiken
  bokför just en sådan fix, så en båt som vände, bromsade in och stannade vid linjen för att
  vänta fick en falsk eller 16–17 min för tidig returnotis (9 av 72 respektive 9 av 36 svepbanor).
  Revision 3 följer korsningen fix för fix (ovan): en gles bokföringsfix vid linjen räcker bara i
  transitfart, och annars väntar beviset på en fix ute på ankomstsidan, utan bokföringsgräns.
  Samma ändring stänger klassen långsamma returer (under cirka 1,2 kn), där 60 s-fönstret från
  bokföringen gick ut innan båten var 30 m ut.
- **Omgranskning 2 (2026-11-07):** en väntande båt vars AIS rapporterar 0,5–1 kn och slumpad
  kurs fick av ±15 m brus vid gles AIS en falsk "har precis passerat" via en enda gles fix
  entydigt på ankomstsidan (6 av 360 granskarbanor), eller samma notis 13 min för tidigt.
  Revision 4: (1) en sådan gles fix räcker bara när båten rör sig i nuet (2,0 kn, appens gräns
  för korsningsbevis i RE_CROSS och C2); (2) två fixar i rad på ankomstsidan räknas bara när
  båda ligger entydigt där och båten var under gång dit även i den förra; (3) passagelogikens
  förtida returbokföring i en fix strax bortom linjen efter vändningen behålls i stället för att
  absorberas, så att den verkliga returen inte missas när passagelogiken inte bokför igen
  (granskarens retur-banor: 10 av 360 missade efter (1) ensam, 0 med (3)); (4) failsafen
  släpper besöket först när dess egna spärrar är passerade; (5) INV-2:s tidsdom kräver att
  båten stannar på ankomstsidan. Svep (K/N/tmp/r4): granskarens P1 360+360 banor och P2 24
  banor rätt; långsamma returer 0,7–2,0 kn 120 av 120 med två notiser.
- **U21 (användarbeslut 2026-11-04, kväll, med dirigentens gräns 2026-11-05):** ingen sen notis
  för en returpassage under ett långt AIS-avbrott. En returnotis släpps bara om den kommer högst
  `STALE_ETA_HARD_THRESHOLD_MS` (10 min) efter den uppskattade korsningen, som interpoleras på
  glappsegmentet. I 20260708-21h ser appen ELFKUNGENs retur över Stallbackabron när hon hörs
  igen efter 80 min (`SKIPPED_BRIDGES_CHECK … new-vessel, candidates=[Stallbackabron]`), men
  returen är bara antagen ur glappet och bokförs inte; den uppskattade korsningen ligger dessutom
  över en timme bakåt. Besöksregeln stoppar därför failsafen, som beslutet 2026-09-07 säger.
- **Facit:** tre rådatabelagda returpassager får notis (ELFKUNGEN i 20260712-25h,
  20260804-both-21h och 20260806-42h); notiserna togs bort av besöksregeln 2026-09-07. Notiserna
  i `corpora.js` har beläggen.
- **Kvar, utanför besöksregeln:** en retur som appen inte bokför får ingen notis. Två kända
  orsaker: Fix D:s återkorsning (familj R1, bokför returen i de flesta fall) och
  `_anchorPassageTimestamp`s studsvakt, som sväljer en mellanbrobokföring av en retur som
  korsar inom 3 min efter utpassagen (`REVERSE_RECRROSS_GUARD`, typiskt en snäv U-sväng).
  INV-5 fäller inte där, eftersom ingen passage registreras. Omvänt ger passagelogikens falska
  bokföringar vid linjen fortfarande INV-5 ("2 registrerade passager men 1 notis") för en
  väntande båt, precis som på 7699cbe. Det felet ligger i passagelogiken, inte i notisen.
  Samma förtidiga bokföring ger INV-7 (SEN MÅLBRO-NOTIS) när båten sedan verkligen korsar:
  notisen kommer vid den verkliga korsningen, men INV-7 mäter mot bokföringen. Därtill tre
  kända gränser i notisvägen: en retur där ruttriktningen inte har vänt (RE_CROSS vänder den
  fel efter en lång väntan vid linjen, 2 av 36 glesa svepbanor, även på 7699cbe), en båt som
  efter korsningen ligger kvar inom 30 m från linjen i stillhet längre än U21:s 10 min, och
  en båt som kommer i transitfart och tvärstannar inom 10 m från linjen just när
  passagelogiken bokför (inte sett i 54 sådana svepbanor). **Brus utanför appens
  brusmodell** (omgranskning 2, P2): med ±30 m per koordinat (upp till 42 m längs
  kanalaxeln) kan en väntande båt i 0,6–1 kn ibland ligga två fixar i rad över 30 m ut på
  ankomstsidan. Uppmätt rest i revision 4: 5 av 48 banor vid tät AIS och 2 av 48 vid gles AIS
  ger ett falskt eller för tidigt släpp (revision 3: 11 och 13), 0 av 192 vid ±20–25 m.
  Registrerad som känd gräns.

## 10. Söndagsfältet 2026-08-09/10 (commits a9f2a20, ce6a946, b1a7ba3 + WS-3)

Första fältkörningen av 5.4.0 (33 min logg + settings-arkeologi; aisstream
serverdött med 429-storm i JUST DEN körningen, AISHub-solo — se källägesnoten
nedan innan siffran generaliseras) gav 23 skeptikerbekräftade fynd som
åtgärdades i tre vågor samma natt. Mekanikändringarna i korthet:

**KÄLLÄGET — aisstream är INTERMITTENT, inte serverdöd** (rättat av fältprov
10, K23, 2026-08-19). Premissen "aisstream är död sedan ~5 aug" har styrt hur
flera körningar tolkats och den är motbevisad: nattloggen 18→19/8 bär **52 av
146 accepterade sampel med `feed=aisstream`**, med EGEN msgType
(PositionReport/StandardClassBPositionReport mot hubbens AISHubPosition) och
14–15 koordinatdecimaler mot hubbens 4–5 — alltså äkta aisstream-trafik, inte
felmärkta hub-ekon. Fusionen arbetade skarpt (53 korskälleavslag), FEED_SILENT
fyrade 0 gånger, och 21 av 25 skuggfönster hade `msgsAisstream > 0`. Källan
tystnade först vid **morgonstarten 19/8** (sista sampel efter 06:14:28Z; i
dygnsloggen därefter 1 skuggfönster av 178). Loggarna 6/8, 10/8 och 16/8 har
noll aisstream — mönstret är alltså AVBROTT OCH ÅTERKOMST, inte en död server.
Två följder för analysarbetet: (1) en logg från AISHub-eran får aldrig antas
vara "AISHub-solo" utan att `feed=`-fördelningen faktiskt räknats; (2)
nattloggen 18→19/8 är tvärtom det enda fältmaterial som övar fusionens
ACCEPT-väg (F1/F4a/F4b/F6/F6b) och skuggmätarna, lager som annars bara ses i
syntetiska ekon. Källvalet `both` påverkas inte — appen plockar upp flödet
automatiskt när det återkommer.

**Källkedjan.** `AISHubClient.connect()` bär kallstartsklampen (en persisterad
C3c-reservation i framtiden adopteras och klampas — blindstartsfönstret föll
från ≤11 min till ≤76 s). `AISStreamClient` är 429-medveten: dedikerad
cooldown (15 min + jitter, `Retry-After` respekteras strikt parsad, cooldownen
är GOLV — aldrig tak — mot fastrappan), och ping-vakten avväpnas av
leveransbevis (en socket som bevisligen levererar meddelanden termineras inte
för utebliven pong). Aktivt nyckel-/källbyte bryter cooldownen; watchdogen gör
det inte.

**connection_status-semantiken** (B2c fullbordad): `degraded` kräver BEVISAD
ASYMMETRI — den friska källan måste själv LEVERERA (silence ≤ 15 min), inte
bara svara. En tom nattkanal (båda svarar, ingen levererar) är `connected`.
Startgrinden håller tillbaka
`connected` tills minst ETT välformat källsvar setts (`_sourceEverResponded`);
`_writeConnectionStatus` är enda skrivvägen. Degradering som satts med
levererande granne släpps INTE när grannen också tystnar (dokumenterat val:
`connected` vore lögn; ett fjärde enumvärde kräver capability-bump).

**Källdödslarmet efter U12** (användarbeslut 2026-08-10). Totaltystnadsgrenen
skiljer nu SVAR från LEVERANS, precis som `degraded` gör. `feeds:silent` +
eskaleringstrappan (se nästa stycke) kräver ÄKTA BLINDHET: ingen konfigurerad,
pipeline-matande källa SVARAR ens (aisstream = socketen nere/429-cooldown,
`perFeed.aisstream.isConnected`; AISHub = pollklockan ofärsk, `lastOkResponseAt`
äldre än `FRESH_POLL_MS`). Svarar någon källa är grenen tyst — en tom kanal är
normaldrift nattetid (korpusbanken: värsta normala trafikuppehåll 198,7 min
över 336,6 h). Skyddsnätet är en egen, grov gren: alla källor svarar men noll
data på `FEED_SILENCE.EMPTY_CHANNEL_ALERT_MS` (4 h) ⇒ EN notis på nyckeln
`feeds:empty:4h` (24h-dedup, ingen trappa) som fångar bbox-/kontofel.
Loggraden i totalgrenen skiljer de tre lägena (blind / tom-kanal / delvis) och
struparen går PER LÄGE, så ett lägesbyte alltid syns direkt. Statusvärdet
(`connected`/`degraded`) berörs inte av U12.

**B2-eskaleringstrappan efter K22** (användarbeslut 2026-08-20, ur fältprov 10).
`CONNECTION_ALERT.ESCALATION_STEPS` går nu **15 min (basnotisen, =
korstystnadsfönstret) → 1 h → 4 h → 1 dygn**. Varje nivå bär sin egen
dedup-nyckel (`<basnyckel>:<etikett>`, t.ex. `aisstream:silent:1 dygn`), och
eftersom `_notifyConnectionIssue` dedupar per nyckel i 24 h ger trappan högst EN
notis per nivå och dygn — en påminnelse, inte en serie. Dygnssteget tillkom
därför att 19/8 gick dygnets sista notis 10:15:03, varefter appen körde 10 h
51 min på halverad redundans utan en enda ny signal medan den UPPMÄTTA tystnaden
växte till 886 min: ett 4-timmarsavbrott och ett 15-timmarsavbrott var
oskiljbara på enheten, vilket är precis vad trappan finns för att förhindra.
24 h är härlett som nästa begripliga tidsskala ovanför 4 h (886 min föll mitt
emellan) OCH som exakt dedupfönstrets längd, så steget kan strukturellt inte
fyra oftare än en gång per dygn av oavbrutet avbrott.

**Texterna anger den MÄTTA tystnaden** (K22, landat 2026-08-21) — BT-12, samma
princip som redan styrde `hubPhrase`: texten får inte påstå mer än mätningen
bär. Fältprov 10 visade en hårdkodad "på 15 min" i notisen bredvid en loggrad
som interpolerade det mätta värdet, och systerloggen 2026-08-11 gav skadefallet:
mätt 1456 min → notis "på 15 min" 24 ms senare, ~97× underskattning, utan
mellanliggande omstart. **EN formaterare — `_formatSilence(ms)` (app.js:3274) —
äger varje tidsfras i varje larmtext.** Den används av SAMTLIGA fyra basnotiser
(`feeds:silent`, `feeds:empty:4h` — som hårdkodade "på 4 timmar" oavsett om
kanalen varit tom i 4 eller 20 h — `aisstream:silent` och `aishub:silent`) OCH av
eskaleringstexterna; hårdkodningen kunde bara uppstå för att varje notistext
skrev sin egen siffra, så en enda formaterare är själva fixen.

Skalorna är `N min` (< 60 hela min), `N h` (< 24 hela h) och `N dygn`, alla tre
**GOLVADE** (`Math.floor`, dirigentbeslut 2026-08-21). Golvet är BT-12 taget åt
båda hållen: symmetrisk avrundning gjorde 90 min till "2 h" och 36 h till
"2 dygn" — tolv timmar som aldrig mätts, i en mening som säger "i över". Med
golv är varje siffra en SANN UNDRE GRÄNS och prepositionerna ("på N", "i över
N") sanna i bokstavlig mening; priset är en underdrift på under en enhet
(59 min 36 s ⇒ "59 min"), som prepositionen täcker. Gränserna prövas på det
golvade värdet, så "60 min" och "24 h" är strukturellt omöjliga utfall och
"0 dygn" kan inte uppstå (dygnsgrenen nås först vid ≥ 24 h). Under en minut ger
"0 min" — onåbart i produktion, eftersom varje anropare gatar på minst
korstystnadsfönstret. Ett icke-ändligt mått ger `okänd tid`, aldrig "NaN min".
Loggraderna avrundar fortfarande (`Math.round(ms / 60000)`): de är
fältdiagnostik och greppmönster, inte påståenden till en användare.

I trappan bär **NYCKELN** stegets etikett (`<basnyckel>:1h` / `:4h` /
`:1 dygn` — dedupens identitet får inte flyta), medan **TEXTEN bär den UPPMÄTTA
tystnaden**, inte stegets tröskel (skärpt 2026-08-21 efter granskning).
Motivet: ett 25-timmarsavbrott som upptäcks sent — appstart efter avbrottet,
eller ett dedupfönster som armar om — skrev annars "har varit tyst i över 1 h",
samma underskattningsklass som K22 rättar för basnotiserna, bara 24× i stället
för 97×. AVVÄGNINGEN: fyrar flera steg i SAMMA tick får notiserna nu identisk
text och skiljs bara av dedup-nyckeln. Det är avsiktligt — en sann siffra i
varje notis väger tyngre än att kunna skilja två notiser åt i den enda
situation där de krockar; i normal drift korsas stegen ett i taget och siffran
växer monotont. Trappan mäter OBSERVERAD tystnad och är sentinelsäkrad (B2e:
icke-ändligt mått ⇒ avbruten eskalering med felrad, annars brände `Infinity`
alla nivåer i samma millisekund). Låst av `tests/k22-larmtext.test.js`
(formateringens gränser, BT-12-invarianten "aldrig mer än mätningen bär", och
att trappans text följer mätningen och inte tröskeln).

**`FEED_SILENCE.EMPTY_CHANNEL_ALERT_MS` (4 h) speglar 4h-STEGET, inte trappans
topp** (användarbeslut 2026-08-21). Efter dygnssteget är 4 h ett MELLANSTEG, och
tom-kanal-nätet följer medvetet mellansteget: dess egen härledning handlar om
TRAFIKUPPEHÅLL på timskala (korpusbankens värsta normala uppehåll 198,7 min), en
skala som inte blir mer sann av att trappan fått ett dygnssteg ovanför. Larmens
tidsskalor ska fortfarande gå att läsa som EN trappa. Kopplingen är låst av
invarianttestet i `tests/kalldodslarm-eskalering.test.js` ("KONSTANTEN: 4h-nivån
ligger över fältets värsta uppehåll och speglar trappans 4h-steg"), som sedan K22
slår upp 4h-steget **vid namn** (`label === '4h'`) i stället för att ta trappans
sista element — den gamla formuleringen gjorde varje nytt, grövre steg till ett
rött test i stället för till en beteendefråga. Ett extra led låser att trappan
har ett grövre steg OVANFÖR 4 h, så dygnssteget inte kan tas bort i tysthet.

**Kajliggarlivscykeln (P9).** Tre samverkande mekanismer stänger churnen
(fältet: 20 raderingar/19 återfödelser av tre SÄNDANDE kajliggare på 22 min):
(a) LIVSTECKNET — en dedupad AISHub-post vars fixTs är färsk (< 365 s,
härledd 180+65+120) emitterar `vessel:seen`; `noteVesselSeen` laddar om
cleanup-timern med dess BASNIVÅ (engångsförlängningar som passage-grace
ratchetas aldrig in) och kan bara skjuta UPP döden, aldrig korta ett liv.
OBS: mekanismen är strukturellt osynlig i replay (harnessen kringgår
AISHubClient) — fältverifieras via `[AISHUB_POLL] seen=`-kvoten och
`💓 [VESSEL_SEEN]`-rader. (b) MOORED-TIMEOUTEN — förtöjd/inlärd kajplats ger
proximity-timeout ≥ 10 min (3 × klass B-kadens + 60 s) i stället för
FAR_DISTANCE 2 min. (c) GRAVVÅRDEN — vid kadensglapp-radering (INTE
STALE_AIS-backstoppens 30 min) sparas beteendeackumulatorerna
(`_stationarySince`, släpp-hysteresen, rörelsebevisen, `_firstSeen*`) i en
TTL-grav (15 min, 200 m-radien, max 50) och ärvs vid återfödelse på platsen.
`_moored` ärvs ALDRIG — klassningen härleds om av `_updateMooringEvidence` på
första ticket ur den ärvda klockan (2h-backstoppen förblir nåbar).
`_lastSeen` är LIVSLÄNGDS-klocka; varje POSITIONSåldersgrind läser
positionsklockan (`_lastConfirmedPositionMs`) — klassningen står vid fältet.

**Textpelaren.** staleDisplay-trappans 20-minutersnivå (mitt-i-passage) kräver
nu att bron ligger FRAMFÖR fartyget relativt `_routeDirection` (bäring — inte
fart — är diskriminanten; PAX-fallet fällde farttaket), med undantag för
under-bridge-bandet ≤ 70 m. Riktningslös båt behåller nivån.

**Notispelarna.** `boat_near` bär två ADDITIVA tokens: `message` (färdig
svensk mening; `passage-fallback` ⇒ "passerade X under AIS-tystnad",
`exit-fallback` ⇒ egen lämnade-området-mening — exit-vägen vilar ALDRIG på
passagebevis, `just-passed` ⇒ "har precis passerat X") och `already_passed`
(bool). Befintliga flows måste själva lägga in `message`-tokenen för att se
U10-texten. U9-räddningsventilen (öppningsmotorn) ligger HEL men AVSTÄNGD
bakom `BRIDGE_OPENING.U9_RESCUE_COVERAGE=false` — mätningen falsifierade
väg (b): bred täckning + individuella deadlines splittrar äkta konvojer.
H-4b-öppningsliggaren i `runOpeningGates` redovisar >1-/0-räknarna separat.

**Väntnotis (användarbeslut 2026-09-06).** `StatusService` sätter
`waitingAtBridge` till den bekräftade väntbron före `status:changed` och
nollar fältet vid annan slutstatus. Debounce/stabilisering håller även
brobindningen; `VesselDataService` bevarar den mellan AIS-fix och rensar vid
reserensning. `boat_near` använder väntformen bara när notisens bro matchar
fältet och är öppningsbar: ”X inväntar broöppning vid Y”, `eta_minutes=-1`,
`eta_available=false`. Ingen separat fartgräns införs för texten.
Passerad-formerna har företräde. Intern målbro-ETA, `bridge_text`,
öppningsvarningar och notisernas urval/deduplicering behåller sina regler.
”Alla broar” matchar varje brohändelse, även flera broar för samma fartyg.

**AISHub-cache (2026-09-06).** Råa fixar äldre än befintliga
`MAX_FIX_AGE_MS` (12 minuter) stoppas före dedup och omprövas vid faktisk
emission efter batchfördröjning. Samma gamla `TIME` får därmed inte förnya
VDS:s positionsklocka när dedup-TTL löpt ut, även i solo-AISHub. Nya fixtider
med oförändrade koordinater godtas. Friska HTTP-svar bevarar pollhälsan;
`staleFixes` och `AISHUB_STALE_EMIT` visar varför en position inte skickas
vidare. Fusionens separata klockkorrigering och framåtgräns består.

**Sena Homey-svar (2026-09-06).** Skrivköer binds till `_runtimeLifecycle`.
Gamla köade enhetsskrivningar startar inte efter ny init, och redan skickade
skrivningar som landar sent kompenseras med senast önskat värde. Global
token återanvänds via SDK:s `getToken`; en sen `createToken` efter timeout
återvinns i aktuell livscykel. Senaste önskade tokenvärde registreras före
asynkron init, så en äldre fortsättning inte skriver över ett nyare beslut.
Regressionerna kontrollerar faktiska slutvärden, inklusive flera enheter
och synkrona SDK-fel. Se [fältprovskörboken](infor-faltprov-2026-09-06.md).

**Kända latenta klasser efter natten:** avgångs-ETA räknas på
igångsättningsfart (ANYA ELAN: "om 23 min" för verklig 10,5 — churnen
maskerade klassen tidigare; ÅTGÄRDAD 2026-11-04 för avgång efter belagd
stillhet, se §8 (e) "Avgångskontexten gick in". ANYA ELAN själv faller
utanför stillhetskravet — 0,7 kn i bufferten före avgången — och är
oförändrad, liksom resten av den kvarvarande klassen: 87 sampel i åtta
mekanismer, varav tolv med minst 3 min för hög prognos, som §8 (e) och
VALIDATION.md "Familj E" redovisar), server-
stängda-men-levererande sockets kan fortfarande ge ~1 handskakning/min
(appens egen orsak är fixad), och `max-reconnects-reached` fyrar inte under
permanent 429 (cooldown-grenen rör inte räknaren).
