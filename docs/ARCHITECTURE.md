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

Tidsstyrningen ovan gäller sedan 2026-09-08. Sedan fältprovet 2026-11-12
(F5) bär watchdogens timer sin målgräns: en timer som löser ut medan
väggklockan står före gränsen (fältet: 1 ms, 13 gånger på 66 h, en gång med
dubbelt tick) bokas om till gränsen i stället för att köra, och nästa gräns
räknas strikt efter körningen, så ingen halvminut körs för tidigt eller två
gånger, och en sen callback kör inte ikapp. Känd, ofarlig gräns: ställs
klockan bakåt mer än en halvminut blir ett 30 s-fönster utan tick (högst
cirka 60 s mellan två körningar) innan ticken följer rutnätet igen.
Öppningsmotorns deadline-timer jämför själv `now` mot varje deadline
och bokar om efter en tidig utlösning. Monitoringloopen är ett vanligt
intervall utan rutnät. Förbrukad ankomstprognos efter
mer än fem minuters AIS-tystnad ger okänd ETA i öppningskortet. Full loggning
bevarar även avvisade AISstream-fixar i `AIS_SOURCE_REJECT_SAMPLE`; dessa
diagnostikrader påverkar varken livstecken eller appens replayindata.

Moduler (ansvar / ägda tillstånd / in-ut):

- **AISStreamClient** (lib/connection/AISStreamClient.js): WebSocket-livscykel mot
  AISstream.io. Bounding box-prenumeration (:254), meddelandetypfilter (:379–386),
  extraktion av mmsi/lat/lon/sog/cog/navStatus/shipName i `_extractAISData`
  (:463–515, avvisar 0,0; String()-wrap på Name). Reconnect-tillstånd (progressiva
  delays, medium 5 min ×12, slow 60 min; :521–529), ping/pong-watchdog
  (`_awaitingPong` :35; U29: `lastPongAt` stämplar senaste pong på den NUVARANDE
  socketen och nollställs per socket — korsvaktens livssignal, se §K22/U29). Emitterar connected/disconnected/ais-message/static-name
  (typ 5/24-namn, :362–373)/auth-error/error/reconnect-needed/max-reconnects-reached.
  **Framdraget försök efter nätavbrott (F1, fältprovet 2026-11-11):** timfasen
  gällde även när nätet bevisligen var tillbaka — k1: AISHub svarade 06:54:21Z
  efter 4,5 h utan nät, AISstream återanslöt först 07:31:34Z. Muxen anropar nu
  `nudgeReconnect` vid hubbens connected-flank (efter en nedflank, men också
  vid appstart och när hubbklienten byggs om — ofarligt, då står AISstream i
  snabbfasen eller får högst ett försök). Klienten drar fram nästa försök till
  5 s + 0–5 s jitter bara när socketen är nere utanför snabbfasen, ingen
  rate-limit-spärr pågår och det senaste försöket aldrig nådde servern (ingen
  öppnad socket, inget HTTP-svar — ett nätfel ELLER en server som inte svarar
  på TCP/TLS-nivå: DNS-fel, TLS-fel, handskakningstimeout, ECONNRESET och
  TCP-vägran räknas alla hit; spärrad nyckel, policyfel och HTTP-fel som 503
  och 429 undantas), högst en gång per 5 min. Stegräknaren rörs inte, och ett
  misslyckat försök faller tillbaka i fasens vanliga backoff. Känd gräns: mot
  en server som inte svarar på TCP/TLS-nivå medan AISHub har egna avbrott blir
  det högst cirka 4–5 extra försök per timme (hubbens hysteres gör en
  hubbcykel minst cirka 13–14 min), mot ett per timme utan F1 — godtagbart mot
  RC-S1 och KX-2, som båda gällde HTTP-svar.
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
  :171–227; FIX U-tvingad waiting som "prioritet 0" :110–168; parbron omprövas vid
  konsumtionen, både när den är bokförd (PHOENIX) och sedan fältprovet 2026-11-13 när
  båten entydigt ligger bortom dess linje sett från den bro som satte flaggan
  (`isBeyondForcedWaitingBridge`, `FIX_U_SKIP_PAST_LINE`). Avståndsprövningen
  (≤ 500 m) frågade inte efter sida: PRICKBJORN 13:56:38 låg 23 m bortom Järnvägsbron,
  och varje statuspass före nästa fix tvingade "väntan" vid den passerade bron och gav
  notisen "närmar sig Järnvägsbron, beräknad ankomst strax". Nu bokförs passagen vid
  nästa fix, och passerad form kommer från S4 eller, när den fixen ligger utanför
  notisradien, från failsafen (OSPREY i 20260601-41h: 591 m, 130 s senare än den falska
  förvarningen). **Gränsen (familj C3, buggjägaren 2026-11-14):** 10 m bortom linjen
  ensamt var fel. Det är mindre än en båtlängd: en båt 12–31 m bortom Järnvägsbron
  står under bron (appen själv loggar "Under Järnvägsbron" i samma pass). Låg
  passagefixen där och bokfördes Stridsbergsbron utan broöppningsfönster (båten låg
  redan under den bron), gav basen "närmar sig … strax" i samma pass, 7–28 s efter
  korsningen, en form som INV-22 (samma cykel inom bandet) och T1 godtar. C2 skickade
  i stället notisen via S4 eller failsafen vid nästa glesa fix, 61–367 s senare (9 av
  buggjägarens 35 142 besök, FREJA 2 +367 s, BRISEN +202 s). Nu behålls väntan när
  fixen ligger högst `UNDER_BRIDGE_SET_DISTANCE` (50 m) från parbron OCH passet är
  fixens eget (`ownCleanFixPass`: meddelandevägens uttryckligen rena positionsanalys,
  samma signal som släpper stabilizern; timerpassen skickar ingen sådan analys).
  Med fönstret aktivt står flaggan vilande. Ett senare pass på samma fix (vakthunden,
  en omkörning) rensar den: där var basens notis falsk (OSPREY-klassen, en 30–55 s
  gammal fix 15–34 m bortom linjen) och C2:s passerade form står kvar, ofta 39–130 s
  senare. Den klassen är känd och ägarfråga 4 (passerad form redan på passagefixen).
  **Känd lucka (nattjakten F10 r3, 2026-11-16):** med fönstret aktivt väntar parbrons
  bokföring på nästa fix. Vänder båten före den och nästa fix ligger på ankomstsidan,
  bokförs parbron aldrig och ingen notis går för den (värld 2737, NORDVIND 13 m bortom
  Järnvägsbron, nästa fix 5 min senare 282 m norr om Stridsbergsbron; inträdesbeviset
  har då löpt ut). Att erbjuda parbron som kandidat inom under-bro-bandet stänger luckan
  men ger PRICKBJORN (23 m, samma pass, samma fönster) "närmar sig … strax" igen i
  stället för sann passerad form, och fäller C2:s tester; på passagefixen går de två
  fallen inte att skilja åt),
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
  **Stillagrinden (S1, 2026-08-23)** spärrar även koordinationsnivån `moderate`
  (osäker position) när fixens sog är finit och under MOVEMENT_PROOF_SOG_KN:
  en stilla båt har inte rört sig, så förflyttningen är brus (kajliggarens
  brusprov). **K1 (2026-11-16, nattjaktens F16/F17)**: grinden spärrar INTE när
  stoppet förklaras av färden före glappet (`_stopExplainedByPriorTransit`;
  anroparna skickar segmentets startfix). Alla fyra villkor ska hålla: ren
  startfix med rå sog ≥ MOVEMENT_PROOF_SOG_KN; förflyttningen ≤ startfart ×
  fix-dt × 2,0; bäringen inom 45° från startkursen (okänd kurs prövas inte); och
  stillafixen mer än UNDER_BRIDGE_CROSS_PROOF_JITTER_M från den prövade brons
  linje (innanför kan en stilla fix inte bevisa sidan). Startkursen är fixens
  råkurs; en återhämtningsstart bär den rena fixens råkurs
  (`passageRecoveryPosition`), inte den osäkra fixens. Faktorn 2,0 och 45° är
  kopior av analysatorns literaler (`GPSJumpAnalyzer.PRIOR_TRANSIT_*`) och ska följa med
  om de ändras där. Villkor 1–3 är EN regel, `GPSJumpAnalyzer.stopExplainedByPriorTransit`,
  som också analysatorn använder (U40 nedan). Fallet: söderut i
  5,2 kn, nästa fix 327 s senare 165 m bortom Stridsbergsbron med sog 0 och en
  stillakurs 51° fel mot förflyttningen (`uncertain_movement`); spärren gav
  "närmar sig" efter passagen och en brotext mot den passerade bron i 17 min.
  Bandet är smalt: förflyttningen ska vara över 500 m (under 500 m dömer
  analysen antingen ingen osäkerhet eller `medium_movement_speed_mismatch`, och
  det fallet tar orimlighetsflaggan före S1) och latitudhoppet under
  LARGE_JUMP_LAT_DEG (annars bokför glappvägen i samma tick).
  **U40 (N4, 2026-11-16): ett stopp som färden förklarar är inget GPS-hopp.** När
  stillafixens egen kurs pekar > 45° fel mot förflyttningen OCH snittfarten är över 5 kn
  mot sog 0 hamnar legitimitetspoängen under 0,4, och analysen dömde förut fixen som
  GPS-hopp (`likely_gps_error`); orimlighetsflaggan spärrade passagen till nästa fix och
  K1 nåddes aldrig (söderut i 5,2 kn, 638 m på 200 s till 120 m bortom Stridsbergsbron).
  Nu blir en sådan fix osäker (`accept_with_caution`, skälet `stop_after_transit`) när
  fixens rå sog är finit och under MOVEMENT_PROOF_SOG_KN, `stopExplainedByPriorTransit`
  håller mot förra fixen och fixen ligger mer än UNDER_BRIDGE_CROSS_PROOF_JITTER_M bortom
  varje brolinje som segmentet korsat (inom bandet ser ett brusprov hos en båt som stannat strax före bron
  likadant ut, och hoppdomen gör att nästa fix mäts från den rena startpositionen så att
  ingen falsk passage bokförs), OCH snittfarten över glappet är högst
  `STOP_AFTER_TRANSIT_MAX_SPEED_RATIO` (1,1) × startfarten (skärpningen, dirigentens
  beslut: en båt som stannat har bromsat, så den fysiska gränsen är 1,0; marginalen täcker
  bara att rapporterad och verklig fart skiljer sig; i banken och fältet har inget
  transit→stopp med startfart minst 3 kn snittfart över 1,03 × startfarten). Kvoten gäller
  bara hoppgrenen, inte K1. Stillagrinden och K1 avgör sedan passagen per bro. Känd gräns:
  en fix med sog 0 mer än 60 m bortom en korsad brolinje och med snittfart upp till 1,1 ×
  startfarten bokförs som passage även när den är en positionsutliggare, både hos en båt
  som stannat strax före bron (brus bortom linjen) och hos en båt som går vidare med en
  enstaka sog 0-fix framåt längs kursen (passagen kommer för tidigt och "närmar sig"-notisen
  uteblir). Utan kvoten släpptes snittfarter upp till 2 × startfarten. I det syntetiska
  motfallsbandet kräver de kvarvarande falska fallen ett positionsfel på 95–180 m på en fix
  med sog 0; sådant finns inte i banken eller fältet. En fartspik på startpositionen (9 kn
  rapporterat när båten går i 3 kn) gör kvoten tandlös och släpper samma falska fall igen;
  fartspikar finns i data (11 av 4 172 positioner), men felet kräver dessutom
  positionsavvikelsen ovan (granskningens kontroll av skärpningen). Nyttan är också hypotetisk: grenen nås
  aldrig i banken eller fältet, och i det syntetiska bandet (2 646 varianter) rättas 11 av de
  28 sena cellerna (de med kvot högst 1,1; 9 av dem har kvot högst 1,0, alltså verkliga
  tvära stopp). Allt annat döms som förut: fysiskt omöjligt (F64)
  kan regeln aldrig nå (villkoret förflyttning ≤ startfart × dt × 2,0 ligger inom taket
  max(sog, 5) × dt × 2,0), och en rörlig fix (sog ≥ 0,5), en stilla startfix, ett hopp
  längre än färden, ett bakåthopp eller en osäker startfix är fortfarande GPS-hopp. I
  banken och fältkörningarna fälls `likely_gps_error` aldrig (orimlighetsflaggan fälls fyra
  gånger: tre `medium_movement_speed_mismatch`, ett fysiskt omöjligt hopp).
  **Känd gräns (beslut U57, 2026-11-23): falsk passage bakåt efter en brusposition.** En båt
  stannar strax före en bro direkt efter ett AIS-glapp, och första stillapositionen är brus som
  hamnar 10–60 m BORTOM brolinjen. Analysen dömer den osäker (`uncertain_movement`) och S1
  spärrar passagen på den. På nästa position, den riktiga före bron, mäts segmentet ändå från
  bruspositionen (bara GPS-hopp får en återhämtningsstart), och korsningen bakåt bokförs som
  passage: målbron byter och ingen notis går vid den verkliga passagen. Rättningen D1 (tre varv,
  rättningsomgång 4 och 5) försökte stoppa passagen när segmentet går bakåt från en osäker
  position och fördes inte in. En regel som bara ser de två positionerna kan inte skilja felet
  från dess spegelbild: båten har verkligen passerat under glappet och ligger strax bortom bron,
  och NÄSTA position är stilla brus före linjen (eller båten vänder verkligen tillbaka). Båda är
  en osäker position bortom bron följd av en stilla position före. I rättarens svep (31 440
  byggda världar) försvann de falska passagerna (1 528 → 62) bara när den riktiga positionen
  hade en fart under 0,5 kn; i gengäld förlorade 162 av 1 440 världar med omvänt brus en sann
  passagenotis, 54 av dem också öppningsvarningen, och verkliga returer under 0,5 kn fick fel
  utfall i 71 av 283 världar. Felet har aldrig setts i banken eller i fältkörningarna k1–k3.
  Den enda väg som tar båda är att vänta en position med beslutet (bortom igen ⇒ verklig
  passage, kvar före ⇒ brus), vilket kräver en ombyggnad av GPS-grinden och sidokontraktet.
  Dagens beteende för verkliga returer strax bortom bron låses av
  `tests/u57-returer-strax-bortom-bron.test.js` och scenarierna `u-sväng-… (U57)`.
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
- **Brolinjen (F08-systerstället, nattjakten 2026-11-16)**: fönstret är latitud,
  men brolinjerna går snett (axel 130°, Stallbackabron 142°). En bro där båten nu
  ligger entydigt (> 10 m, `geometry.decisiveBridgeSide`) på tillfartssidan av
  linjen i svepets riktning stryks ur fönstret (`SKIPPED_BRIDGES_BEFORE_LINE`):
  hon har inte korsat den. Gäller alla scenarier, inte Kanalinfarten. Förut
  bokfördes en båt som hoppat fram till kilen före linjen och väntade där som
  passerad (texten bytte bro och sedan till "Inga båtar" medan hon väntade), och
  en transponder utanför farleden, 850–890 m öster om Stridsbergsbron och
  Järnvägsbron (218023240 i 20260713-41h, troligen ett landfordon på
  Stallbackabron: första positionen 4 m från brolinjen med kursen längs broaxeln
  i 33 kn; ingen korsning i rådatafacit), fick två falska "passerade … under
  AIS-tystnad". Den omvända kilen (förbi linjen men inte förbi
  latituden) bokförs fortfarande först vid nästa fix.
- **U36 (dirigentens beslut 2026-11-16, nattjaktens F13)**: har appen själv sett
  att en återfödd båt vände i glappet (svepets riktningslås släpps, se
  `SKIPPED_BRIDGES_DIRECTION_LOCK_RELEASED` i §4) och är sist kända position
  (`posT`, annars borttagningstiden) äldre än 17 min (`SWEEP_TURNED_STALE_MS`,
  samma ålder som designposten SKIPPA-BRO-ÅLDER-17MIN), skickas inga
  svepnotiser (`SKIPPED_BRIDGES_STALE_AFTER_TURN`). Passagerna gäller resan åt
  andra hållet och kan ha skett när som helst i glappet: FREJA fick "passerade
  Stallbackabron under AIS-tystnad" söderut för en passage 55 min tidigare och
  tre minuter senare "närmar sig Stallbackabron" norrut. Låset och dess släpp
  sker som förut. Vändningar appen inte sett (fart under 2 kn, kurs i
  dödbandet eller saknad), kurs som håller med nettot (vändning utanför
  området vid boxkanten, 265573130-mönstret), återfödelser högst 17 min efter
  sist kända position och scenario B (redan låst färdriktning) rörs inte.
  Låsets släpp förekommer inte i banken eller fältkörningarna k1/k2, så
  ingen notis där ändras.

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
Järnvägs/Strids-överlappet; :4120–4146). **Broparets nästa bro (fältprovet
2026-11-13, familj C):** så länge FIX U-flaggan (`_forceWaitingAtBridge`) lever
erbjuds parbron som `current`, om den inte redan är bokförd och båten inte ligger
entydigt bortom den (`StatusService.isBeyondForcedWaitingBridge`). Söderut ligger
Järnvägsbron ~257 m efter Stridsbergsbron, så fixen som bokför Stridsbergsbron ligger
redan i Järnvägsbrons zon, men Phase 3-hållningen höll `currentBridge` på
Stridsbergsbron i 30 s och FIX U gjorde Järnvägsbron till current först därefter, i
praktiken i vakthundens pass på en 30–60 s gammal fix. Notisen kom då 23 s efter till
4 s före passagen (ASPEN, WILSON ALSTER, NORDIC SOLA i körning 2). Nu går den på
passagefixen med samma avstånd, ETA, källa och text. Hållningen och FIX U styr
fortfarande status och brotext. Norrut är parbron målbron och erbjuds redan som
`target`. Inget dokument motiverade fördröjningen för notisen; hållningen och FIX U:s
vakt gäller brotextens fassekvens från det äldre formatet. Tillägget ligger i Fix 7:s
linje (målbron och en annan bro inom 300 m får trigga i samma tick, EKEN-fallet) men
Fix 7 säger inget om parbron när den inte är målbro. Etiketten `current` behålls för
att tokens ska vara identiska med vakthundens notis; en egen debugrad
(`FIX_U_PAIR_CANDIDATE`, en gång per FIX U-flagga) säger i loggen att parbron erbjuds
medan `currentBridge` fortfarande är den passerade bron.
**Förhållandet till D6** (`docs/etapp7-plan-2026-08-08.md`, "Järnvägsbrofördröjningen
(S2-1)", risk RÖD, uppskjuten med hela fas D genom användarbeslut 2026-08-05b). D6
reproducerade en fördröjning vid Järnvägsbron (medianlag 57 s mot 28–32 s vid snabba
broar), noterade att Olidebron hade större lag (64 s) utan att vara parbro och skisserade
en annan rättning: undanta parbron från zonstoppet i ProximityService, med full
golden-genomgång i parbrokorpusar och ett revert-kriterium. Rättningen ovan rör inte
zonstoppet och inte spärrarna FIX O (20 s), CLOSE_BRIDGE_PAIR (15 s) eller FIX U:s 90 s.
Den rättar notisens fördröjning söderut: mätt i banken (24 korpusar, tid från första fix
inom 300 m på ankomstsidan till förvarningen) gick medianlaget för Järnvägsbron söderut
från 42 s till 0 s, och av de 48 ändrade notiserna kom 7 efter rådatans korsning före och
1 efter (den enda är OSPREY i passerad form). p90 står kvar på 67 s; de notiserna gäller
båtar vars första fix i Järnvägsbrons zon låg norr om Stridsbergsbron, före den bron, och
är avsiktliga. **Kvar av D6:** D6:s eget lagmått är inte dokumenterat. Med måttet ovan
har Olidebron medianlag 0 s både före och efter (178 förvarningar med mätbart lag), och appens
bokföringslag vid Olidebron (rådatans korsning till bokföring, median 80 s) är
oförändrat eftersom passagerna är byte för byte lika. Om D6:s 64 s avsåg bokföringen
står den delen kvar orörd. Zonstoppet och de tre spärrarna är också orörda.
**Revert-kriterium för C2** (kandidaten och sidprövningen, i D6:s anda): reverta om ett fältprov, när
fältets jsonl körs i replay med och utan tillägget, visar (1) någon skillnad i brotext,
passager, öppningsvarningar eller notisantal (i banken: ingen), utöver notiserna för
Järnvägsbron söderut; (2) två notiser för
samma Järnvägspassage, eller "närmar sig Järnvägsbron" från en fix entydigt bortom
linjen; (3) en sydgående Järnvägsbronnotis som kommer senare mot rådatans korsning än
utan tillägget, utom OSPREY-klassen (en notis som utan C2 kom i ett senare pass på en
fix bortom linjen och var falsk; den får passerad form senare, och det är känt); eller (4)
en Järnvägspassage som bokförs utan tillägget men inte med det (F08-klassen). Kriterium
(3) fångade inte felet som buggjägaren hittade efter sammanslagningen (FREJA 2-klassen),
eftersom banken saknade fallet; buggjägarens standardkörning (T1 SEN-NOTIS och
populationsjämförelsen av första notisens tid) hör därför till prövningen av varje
ändring här. Sjätte och sjunde source-värdet —
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
   `geometry.decisiveBridgeSide`). **N6 (granskningen av N2, 2026-11-16):** en
   förvarning som går ut på en position entydigt bortom linjen i notisens
   färdriktning (`reserve(…, { travelSign })`: ruttlåset, annars kursen, samma
   riktning som notisen bär) har bron bakom sig, och då är ankomstsidan den bortre,
   utom när kursen pekar tillbaka mot bron (ett ruttlås som ännu inte vänt efter en
   U-sväng). **Vakten (granskningens H1, dirigentens beslut U44):** bron räknas som
   bakom båten bara när det är belagt i nuet, alltså när båten rör sig i minst 2 kn
   (`RETURN_SPARSE_MOVING_SOG_KN`, appens gräns för rörelse i nuet vid ett
   korsningsbevis) eller när föregående position (`vessel.lastPosition`) låg
   entydigt på andra sidan linjen. Utan vakten fick en båt som driver bort från bron
   på tillfartssidan (0,8–1,5 kn, kursen och det av driften satta ruttlåset bort) och
   sedan går igenom två notiser för en passage: granskarens driftsvep 44 av 60
   världar, gles kadens 16 av 20, basen 0; HALIFAX i 20260708-21h är det fallet.
   Bortre sidan räknas som sedd först vid nästa rena fix där, så en väntande båt
   vars förvarning gick ut på en brusposition bortom linjen inte kan få ett
   retursläpp. Förut vändes besöket: i granskarens svep (120 s kadens, förvarningen
   22 m söder om Järnvägsbron) gav en ensam brusfix på andra sidan en falsk "har
   precis passerat" 12 min efter passagen, och en verklig retur gav ingen notis (48
   av 48 banor). Med vakten är de falska returerna 0 och banken oförändrad av den
   här delen. Därefter följer `observe` varje ren fix: när
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
     **U37 del 1** (dirigentens beslut 2026-11-16, nattjaktens F15): i transitfart
     räcker korsningsfixen vid vilken kadens som helst (bevis `linje-transit`):
     korsningen noterad i just den fixen, fixen entydigt (över 10 m) på
     ankomstsidan, föregående fix entydigt på bortre sidan, första fixen på
     ankomstsidan, bokföringen i segmentet och ett korsningssegment som går att
     färdas i farten (högst 1,5 × farten + 0,5 m/s och högst 15 m längre än
     farten medger, oavsett kadens; granskningen A1 och B1: en ensam
     GPS-utliggare 12–25 m förbi linjen, som grinden släpper igenom och
     passagelogiken bokför bron i, gav annars falska returer vid 10–30 s
     kadens). Alla krav står samlade i `isTransitCrossingFix` med vad vart och
     ett skyddar mot; ett segment som inte klarar dem släpps vid nästa
     position, som på basen. LINNEA 2 korsade Klaffbron i 5,8 kn, fixen 9 s senare
     låg 26 m ut (segment 24 s) och nästa fix kom 421 s senare; returnotisen kom
     7 min sent tillsammans med "närmar sig Olidebron". En båt i över 3 kn som är
     förbi linjen med kursen mot ankomstsidan hinner sällan vända inom bron. En fix
     PÅ linjen (inom ±10 m) släpps fortfarande bara vid gles kadens: i
     motfallssvepet gav en båt som bromsar till 3,25 kn mot linjen och stannar
     eller vänder 3–8 m förbi den annars 5 falska returer på 240 banor.
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
   Formen följer beviset (`_returnPassageForm`, sedan U37 del 2 den gemensamma
   formregeln i `lib/utils/passageNoticeForm.js`): "passerade … under AIS-tystnad"
   när det var tyst i mer än två AISHub-pollar (130 s) kring korsningen, alltså
   det längsta leveransintervallet från fixen före korsningen till släppets fix
   (`silenceMs`), och notisen kommer efter "precis passerat"-fönstret (60 s),
   räknat från korsningen skattad ur släppfixen (avståndet bortom linjen delat
   med farten; U21:s tidsgräns mäter fortfarande mot den interpolerade
   korsningen), annars "har precis passerat". Det gäller alla tre vägarna. Failsafen släpper besöket innan
   notisvägen prövar sitt eget släpp och skickar därför formen med kandidaten
   (`returnForm`); källsträngen står kvar som `passage-fallback`, så dedup,
   ETA (−1), `already_passed` och INV-11:s undantag är oförändrade, och bara
   `message` följer beviset (fältprovet 2026-11-13: PRICKBJORN fick "passerade
   Stallbackabron under AIS-tystnad" för en korsning i ett segment på 68 s,
   93 s före notisen). Släppet städar som en observerad återkomst (sessionsnyckel och
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
   Kanalinfarten har ingen brolinje och följer besöksregeln, med U46:s utfärdsbevis.
   **U46 (dirigentens beslut 2026-11-17, BN1-BOXKANT):** vid de två ytterpunkterna
   (Kanalinfarten och Stallbackabron) räknas också en utåtriktad transit som utfärd när
   båten sedan är tyst. `observe` sätter utåtbeviset (`outwardFixTs`) på en ren fix som
   ligger entydigt på den yttre sidan (norr om Stallbackabron, sydväst om Kanalinfarten),
   har gått minst 50 m utåt längs kanalaxeln sedan förra fixen, rör sig i minst 2,0 kn med
   en kurs som inte pekar inåt och har ett segment på högst 10 min som går att färdas i
   farten. Beviset gäller bara den senaste fixen. Besöket stängs först när nästa rena fix
   kommer minst `STALE_ETA_HARD_THRESHOLD_MS` (10 min, fixklockan) senare och visar att båten
   varit borta (`_isReturnAfterSilence`: utanför radien + 50 m, på den inre sidan, eller på
   väg inåt i minst 2,0 kn); därefter gäller återkomstregeln (inom 300 m). Hörs båten
   tidigare, eller stilla på den yttre sidan i zonen efter tystnaden, gäller dagens regler för
   den fixen, så en båt som går ut förbi punkten och lägger till, vänder eller guppar i zonen
   behåller sitt besök. Se "Rättningsomgång 4" under §9.
   **U51 (dirigentens beslut 2026-11-17, F8 alternativ (c)):** vid ytterpunkterna får en båt
   som legat förtöjd minst 2 h ett nytt besök när hon lägger ut. `observe` följer ett
   förtöjningsbelägg i besöket (`moorLat/moorLon/moorSince/moorLastTs/moorProven`, sparas):
   stilla fixar (navstatus förtöjd/ankrad eller fart under 0,3 kn; en fix utan fart räknas
   bara inom 40 m från ett ankare som redan satts, så en båt utan fart och navstatus 1/5 får
   inget belägg) inom 40 m från ankaret med högst 60 min mellan dem, som spänner minst 2 h
   (`MOORING_DETECTION.MAX_STATIONARY_WAIT_MS`). Ett belagt belägg står kvar till avgången.
   Avgången är belagd när båten i minst 2,0 kn (föregående fix minst 0,5 kn, kursen inte
   tillbaka) är högst 50 m från punktens linje eller förbi den och har gått minst 50 m mot
   linjen från ankaret, före linjen dessutom högst 70 m från punkten (granskningen M2), med
   ett segment på högst 10 min som stämmer med farten. Då tas besöket bort som vid en
   återkomst (`reentered`), och avgången får sin notis. Ligger fixen entydigt förbi linjen
   returnerar `observe` `pastLine`, appen sätter den entickiga flaggan
   `_tpMooredDeparturePastLine`, och `_hasPassedTriggerPoint` ger passerad form ("har passerat
   Kanalinfarten") i stället för en förvarning med minuttal (granskningen H1).

Tokens: `vessel_name` (B1: känt namn → cache-uppslag → "Okänd båt", :4464),
`bridge_name`, `direction` (`_getDirectionString`:4639: låst rutt-riktning
först, annars COG — 'unknown' vid omätbar fart; sedan K30 2026-08-21 är
riktningen den ENDA kvarvarande källan till `unknown` i loggen — `[BRIDGE_TEXT_FILTER]`
skriver numera `passed-recent-window` där den förr skrev `unknown` på reason-fältet,
och det fältet stod för 96 av fältprov 10:s 104 unknown-rader och ledde
riktningsutredningen fel), `eta_minutes` (target-källa =
målbro-ETA, restiden avstånd/fart när brotexten säger "strax" för båten (U33, §8 (e));
övriga = dist/fart mot notisbron; de retroaktiva källorna
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
"X passerade Y under AIS-tystnad" och "X har precis passerat Y" för en
passage som redan skett. **U37 del 2 (dirigentens beslut 2026-11-16):** meningen
väljs av en gemensam formregel för alla passagenotiser (retursläppen, S4,
just-passed, BN2, failsafen och svepet; `lib/utils/passageNoticeForm.js`):
tystnadsform när det var tyst i mer än 130 s kring korsningen och notisen kommer
mer än 60 s efter den, annars "har precis passerat". Korsningstiden skattas ur
fixen efter korsningen: avståndet bortom linjen delat med den rapporterade
farten (från 0,5 kn, appens rörelsebevis), aldrig före segmentets början och
aldrig efter första positionen bortom linjen. En båt som ligger still efter en
tystnad får tystnadsformen (korsningstiden är okänd). Regeln bärs av en
asymmetri: "passerade … under AIS-tystnad" är sant så snart korsningen låg i ett
glapp över 130 s, medan "har precis passerat" kräver belägg; vid osäkerhet väljs
tystnadsformen. Känd gräns: en båt som stannat efter bron och gått vidare, med
en tystnad som täcker både korsningen och stoppet, får för litet dröjsmål och kan
få "har precis passerat" om en gammal passage (18 av bankens 1 006 korsningar
stannar inom 300 m efter linjen och går vidare, nästan alla vid
Stridsbergsbron). En post i sist kända position utan `fixTs` (skriven av äldre
kod, högst 6 h efter uppgradering) ger okänd korsningstid och alltså
tystnadsformen efter en tystnad. Linjär interpolation över hela glappet lade korsningen för tidigt för
båtar som väntat i kö före bron: i banken låg tolv båtar 18–56 s efter
korsningen enligt farten men 62–148 s enligt interpolationen (PAX 54 m bortom
Järnvägsbron i 5,3 kn efter 1 135 s tystnad); SALTIS (nattjaktens R2-fixtur)
ligger 54 s efter L0-korsningen, som farten säger, mot 62 s interpolerat. För andra vägar än retursläppen är segmentet föregående fix
(`_prevFixSample`, fixklockan) eller, för en återfödd båt, sist kända position
fram till notisens fix (`_segmentPassageForm`). Ligger båda ändarna redan bortom
linjen i färdriktningen gäller undre gränser (tystnadsform bara om de räcker);
saknas beviset behåller vägen sin gamla mening: `passage-fallback` (passagen
inferreras ur en position på andra sidan bron) och BN2 tystnad, `just-passed` och
S4 (källan current/target/nearest men appen har bokfört bron inom nådan) "har
precis passerat". En ny båt (BN2:s portgissning, N6/U44) har inget segment men
prövas med samma regel och okänd tystnad räknad som tystnad (`_newVesselPassageForm`).
Källsträngen, eta=-1 och already_passed rörs inte. Förut följde
meningen källan: S4 sa "har precis passerat" efter 800 s tystnad och en korsning
4 min före notisen, BN2 och failsafen "under AIS-tystnad" för en korsning 4 s
före fixen. I banken byter 53 notiser form (40 till tystnadsform, 13 till "har
precis passerat"), alla i linje med regeln på rådatan; fältkörningarna k1 och k2
påverkas inte. Vidare "X var på väg ut ur kanalen vid Y
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
  deadline ur samma fix. För en krypare under ETA-kedjans passagegolv
  (`MIN_PASSAGE_ROUTE_SPEED_KNOTS`, 2,5 kn) är ankomsten den senare av appens
  prognos och armens fysik, avstånd genom fart (`physicsArrivalMs`, varv 2,
  familj B, M5): golvet och outlierskyddet höll prognosen minuter för tidigt
  (värld 790: 230 m i 0,9 kn, appen 3 min, fysiken 6,4 min). Fysiken gäller
  från det andra NYA krypfixet i följd, eller direkt efter ett fix i marschfart
  (≥ 2,5 kn), och aldrig med köflaggan (`waitingAtBridge`): en kölämnares första
  rörelsefix i låg fart släppte henne annars, fast hon korsade inom fönstret
  (granskningen av varv 2). Ett fix räknas bara när dess tid gått framåt, så en
  upprepad leverans av samma fix ger inget andra krypfix (omgranskningen). Ligger bron redan bakom
  hennes senaste läge (ett fix utan riktning) släpper bakkanten inte; passagedomen
  vid täckningsslutet avväpnar (KRAV (1), `_bridgeBehindArm`). Deadlinen,
  eta-tokenen och ETA-texten läser inte fysiken (U22); (b) **vid täckningsslut** hålls armen kvar (`OPENING_RECOVER_HOLD`,
  nästa fix avgör) om bron ligger bakom henne (avväpnas som passage), om armen
  är fryst, om ankomstfysik saknas, om hon låg under bron (≤
  `UNDER_BRIDGE_SET_DISTANCE`, i rörelse) med ankomst inom täckningen (från
  2 kn den tidigare av appens prognos och avstånd genom fart, U49), eller om
  kursen leder bort från bron utanför väntzonen. Första passagens tid är den
  skattade korsningen (`_crossingEstimate`), inte bokföringstiden; den styr
  medlemskapet och bakkanten. En NY båt med minst två tick kvar prövas dessutom
  mot händelsens tidigaste bokförda korsning (se K-familjen nedan, nattjaktens
  F02 r3). Täckningsslutet räknas fortfarande från
  bokföringen, så en tyst båt släpps som förut. En ny båt som bara på grund av
  korsningen får en egen händelse, men som upptäcks under två tick före sin
  ankomst, absorberas som förut (`_anchorFloorHost`, golvet). Se §H29/H30 för
  vad som medvetet inte är grindar och för U17.
  (c) **Före händelsens första passage** (ägarbeslut **U24, 2026-11-09**:
  "inför ändringen"; C-IV väg b, smal variant, varv 2 familj B M7,
  `_ownDeadlineVerdict`): har hennes egen deadline passerat (garantins,
  `earliestArrivalMs − WARNING_LEAD_MS`) och ligger både appens prognos och
  armens fysik efter händelsens fönsterslut (referensankomsten +
  `CONVOY_WINDOW_MS`), släpps hon på sitt fix och varnas direkt, om
  täckningsslutet annars hade kommit mindre än `WARNING_LEAD_MS` före hennes
  ankomst. Appens prognos måste finnas (`etaMinutes`; utan den är prognosen
  samma fysik, och villkoret vore tomt), och bron får inte ligga bakom hennes
  senaste läge (KRAV (1)). En båt som ligger still (ingen fysik), har köflaggan eller ligger i
  väntzonen (`STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE`) släpps inte så, och
  inte heller under ledtidsgolvet eller med kursen bort; för stilla köande
  båtar (värld 1139) gäller täckningsslutet som förut. Schemaläggaren väcker
  släppvägen på deadlinen. U9:s breda täckning är fortfarande avstängd: U24
  ändrar bara släppet, inte vilka som täcks. Mätt: värld 979 får sin varning
  330 s före korsningen i stället för 50 s; banken har lika många varningar
  och ingen låst rad flyttas. Kostnaden som ägaren godtog: buggjägarens
  quick-värld 143, där en köande konvoj delas när den första följaren släpps
  tidigt och den andra varnas vid täckningsslutet på ett 21 min gammalt fix
  (registerpost med U24 som källa, familj E).
  (d) **Två sena varningar som ägaren godtar som kända gränser** (ägarbesluten
  **U25 och U26, 2026-11-09**). De är inte avsett idealbeteende. De är priset
  för att släppvägen bara kan döma på det appen vet, och appen ändras inte.
  **U25:** bakkanten kan döma först när händelsens första passage är bokförd.
  Bokförs den för sent, därför att ingen båt som händelsen täckte hördes
  efter sin korsning, släpps en följare först vid bokföringen. Hennes egen
  varning kommer då efter hennes passage. Provvärld 1038: ledaren ZELDA korsar
  Stridsbergsbron tyst 12:07:18 och hörs nästa gång 12:15:55, när passagen
  bokförs (skattad till 12:08:20). ELSA MARIA släpps i samma utvärdering
  (prognosen 12:17:06 ligger efter fönstrets slut 12:16:27) och varnas 12 s
  efter sin korsning 12:15:43. Hade appen haft underlaget tidigare och ändå
  bokfört sent, är det ett fel och inte U25.
  **U26:** en stilla köande båt i en händelse utan bokförd passage omfattas
  inte av U24 (hon saknar fysik och ligger i väntzonen), så hon släpps vid
  täckningsslutet. Hörs inte hennes avgång ur kön, kommer varningen sent.
  Provvärld 1139: MASEN ligger stilla 157 m från Stridsbergsbron. Vid den
  äldre händelsens täckningsslut absorberas hon i en händelse som avfyrades
  på den tysta YRSA 2:s 15 min gamla fix. YRSA 2 hade redan korsat osedd och
  hördes aldrig mer, så den händelsen fick ingen passage. MASEN avgår osedd
  12:34:16 och varnas vid täckningsslutet 12:35:02, 41 s före korsningen.
  Buggjägaren registrerar båda som ACCEPTERAD med predikat som bara tar
  mekanismen: ett fel i bokföringen, bakkanten, U24-släppet eller
  täckningsslutet förblir en kandidat (`docs/BUGGJAKT.md` §7).
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
- **Spärren vid en tidigare bro (a8d7b76) och tystnaden (familj D, varv 2,
  2026-11-09; M6, dirigentens val B med omgranskningens två skärpningar):**
  färska positioner före en annan öppningsbar bro kan inte lova nästa öppning
  (`_earlierBridgeAhead`: en bekräftad kö vid en annan bro, eller en opasserad
  bro emellan i färdriktningen; har båten passerat broar, eller en köpost för
  bron i färdriktningen, räknas varje opasserad bro emellan, utom
  Stallbackabron och inom `WAITING_CLEAR_DISTANCE` från målbron; efter en
  bekräftad vändning räknas kedjearmens broar även utan dem, se nästa
  punkt). Spärren infördes mot för tidiga varningar för båtar som sedan
  väntar vid den tidigare bron, och den ersätter 10-knopsdeadlinen: för en båt
  i rörelse (≥ 2 kn, ingen kö bekräftad i senaste fixet) släpps den vid
  ankaret + min(`STALE_ETA_SOFT_MS`, restiden i nuvarande fart −
  `WARNING_LEAD_MS`), annars vid ankaret + `STALE_ETA_SOFT_MS`, och varje fix
  ankrar om den. Restiden räknas på den senaste farten, så en båt som kryper
  fram mot Järnvägsbron och ökar efter bron äter ledtiden; hörs hon som
  vanligt syns det i nästa fix. **Tystnaden:** har appen inte hört henne på
  `EARLIER_BRIDGE_SILENCE_FACTOR` (2) gånger hennes längsta
  mottagningsintervall bland de `EARLIER_BRIDGE_CADENCE_WINDOW` (4) senaste,
  och minst `EARLIER_BRIDGE_MIN_SILENCE_MS` (210 s), räknas restiden i hennes
  fart fram till den tidigare bron och i minst `EARLIER_BRIDGE_BEYOND_KN` (4
  kn, rask kanalfart) efter den. Spärren släpps vid det senaste av
  tystnadsgränsen, den restiden − `WARNING_LEAD_MS` och tiden hon i sin egen
  fart behöver fram till den tidigare bron, om det kommer före den vanliga
  gränsen (`_silentHoldLimitMs`). Medan hon i sin egen fart ännu inte har nått
  den tidigare bron slutar spärren alltså aldrig tidigare än förut. 210 s är
  klass B:s takt under 2 kn (180 s) som AISHub tar emot den: pollen går var
  65–70 s, så takten kommer fram efter två eller tre pollar, högst 3 × 70 s.
  Leder kursen i sista fixet bort från bron, eller väntar en vändning
  (`_fixDPendingReversal`), ges ingen sådan släppning; spärren och en planerad
  varning gäller då som förut (U19). Fältet motiverar uppdelningen: norrut
  150–500 m före Järnvägsbron är farten median 2,3 kn, mellan Järnvägsbron och
  Stridsbergsbron median 5,1 kn. Buggjägarens värld 263: BRISEN tystnade 272 s
  459 m före Stridsbergsbron (202 m före Järnvägsbron) i 2,1 kn och korsade i
  4,2 kn; varningen gick 44 s före korsningen och går nu 70 s före.
  **Kostnaden prövas mot spärrens syfte:** i tystnad går inbromsning inte att
  skilja från acceleration (värld 29: 269 s glapp före en kö på 10 min vid
  Järnvägsbron). Rask fart på hela sträckan (familj D:s förkastade TYST-GOLV)
  varnade 9–13 min för tidigt före köer som c14938f väntade ut (världarna 29
  och 1767) och gav en fantom när båten vände under tystnaden (värld 1089).
  Den första versionen med rask fart efter bron (19e87b5: gräns 180 s, inget
  villkor om egen fart) släppte spärren för Stridsbergsbron cirka 55 s innan
  båten i egen fart nådde Järnvägsbron. I omgranskningens värld 1511 med en
  poll till varnades då en båt som stannade i kön där 22 min före korsningen,
  och i granskarens kögrid (84 fall) kom 26 varningar före köfixet där c14938f
  väntade ut kön. Med skärpningarna är det 3 fall, och 1511-varianten blir som
  på c14938f. Mätt: banken (med och utan monitoring), `replay:openings` och
  `replay:synthetic` är bitlika med c14938f; i buggjägarens 2 000
  standardvärldar kommer 9 varningar tidigare (median 20 s), ingen före en kö
  som c14938f väntade ut, ingen ny fantom och ingen ny varning efter en
  korsning. En kö som var bekräftad i senaste fixet, en båt under 2 kn och en
  båt i 4 kn eller fortare berörs inte. Efter `restartArrival` behålls
  kadensen, så nästa fix sätter `originalDueMs` med en spärr som regeln kan ha
  kortat (bara mätinstrumentet). **Restfönstret:** kommer första köfixet efter
  tystnadsgränsen och efter att båten i egen fart skulle ha nått Järnvägsbron,
  men före c14938f:s gräns, varnas hon före köfixet där c14938f väntade ut
  kön. Det kräver fart under 257 m / 180 s = 2,8 kn, och fönstret är högst 257
  m / sog − 180 s brett (70 s i 2,0 kn, 20 s i 2,5 kn). Av motorns 320 köer
  vid Järnvägsbron norrut ligger ingen i fönstret. **Kvar står** också att
  reservvägen räknar på kryparfarten när båten hörs: i standardvärldarna fick
  843 av 1 227 spärrbundna varningar i rörelse 60–150 s ledtid, och i banken 3
  av 36. Det är T2:s tunna klass, inte golvet. Familj A:s punkt om returresor
  (spärren gäller från fixet efter vändningen) hänvisar till samma fråga, M6;
  dirigenten valde B och, efter omgranskningen, båda skärpningarna.
  **Fartökning före en nära bro emellan (sparr, 2026-11-15/16; F7,
  `_accelBeforeNearEarlier`; omgjord efter granskningen SPARR-d2).** T2:s tunna
  klass ligger nästan helt vid Stridsbergsbron norrut. Järnvägsbron ligger
  257 m före, så en båt i mer än 2,8 kn måste varnas medan hon ännu är före
  Järnvägsbron, och spärren räknade restiden i fixets fart. Båtar kryper eller
  saktar in mot Järnvägsbron och ökar när den öppnar, och då åt accelerationen
  efter släppberäkningen upp ledtiden (fältet: LIDAN 138 s, LIANNE 157 s, NAVEN
  150 s, NORDIC SOLA 107 s). Regeln: ett nytt fix högst
  `EARLIER_BRIDGE_ACCEL_BAND_M` (400 m) före en tidigare bro som ligger högst
  `EARLIER_BRIDGE_NEAR_M` (500 m) från armens bro, efter två föregående nya fix
  i minst `EARLIER_BRIDGE_ACCEL_MOVING_KN` (kajgrindens 1 kn), med minst
  `EARLIER_BRIDGE_ACCEL_DSOG2_KN` (0,8 kn) ökning mot fixet före det förra och
  minst `EARLIER_BRIDGE_ACCEL_DSOG_KN` (0,3 kn) mot det förra, det utlösande
  fixet i minst `EARLIER_BRIDGE_ACCEL_FLOOR_KN` (2,8 kn = 257 m /
  `WARNING_LEAD_MS`), varje steg högst `EARLIER_BRIDGE_ACCEL_PREV_MAX_MS` (240 s),
  kurs mot bron och ingen väntande vändning. Då räknas spärrens restid i max(fart, `EARLIER_BRIDGE_ACCEL_KN`)
  (5 kn; fältets median mellan broarna är 5,1 kn). Geometrin, inte ett villkor,
  gör att det bara gäller Järnvägsbron före Stridsbergsbron norrut (963 m till
  Klaffbron, 1 363 m från Olidebron, ingen öppningsbar bro söder om
  Stridsbergsbron). **Ingen avgångsgren:** den första versionen räknade också
  ett ensamt fix ur stillhet (under 1 kn, nu minst 1,5 kn). Granskningen
  SPARR-d2 (H1) visade att den varnade 10–20 min för tidigt när en båt ryckte
  fram i en kö 100–400 m före Järnvägsbron: NICOLINE i 20260712-25h (0,9 → 1,9
  kn 358 m före bron, sedan kö i 10 min; i korpusen dolt av att basen redan
  varnat), krypköer, fartbrus hos en stillastående båt och ett ryck följt av
  vändning (falsklarm). En avgång bekräftad av två fix i gång räddade inget i
  banken och fältet men varnade fortfarande tidigt i krypkön med klass A och i
  en fas med AISHub, så den finns inte heller. Den förra texten här ("av
  fixen med fartökning följdes inget av kö", "ingen varning före en kö") var
  fel: den gällde en skanning med 2 kn och ett steg, inte regelns villkor.
  Med regelns nuvarande villkor utlöses regeln 13 gånger hos 8 båtar i
  rådatan (25 korpusar och k1–k3), och alla gick igenom utan att stanna; det
  är ett tunt belägg. **Fartgolvet (omgranskningen, R2):** kravet på gång stänger
  ute en stilla kö men inte en krypande. Granskarens former (kryp 1,2 kn, ryck
  2,2 kn och kö; 1,2 → 2,1 → 2,5 kn och stopp; en båt som driver men rapporterar
  1 kn med en spik på 2,0; en bakre båt som följer den främres ryck) varnade
  5–15 min för tidigt. Under 2,8 kn hinner varningen ändå gå efter
  Järnvägsbron, så golvet kostar inget: banken och fältet är bitlika med
  versionen utan golv (alla bindande utlösningar har minst 3,0 kn, LIANNE
  lägst), och alla formerna får basens utfall. 2,5 kn räcker inte
  (1,2 → 2,1 → 2,5 kn och stopp varnar då 13–15 min för tidigt); 3,0 kn tar
  bort ett långsamt kort till men ligger precis på LIANNE:s 3,0. I rådatan
  finns sex krypfaser (minst tre nya fix i 1,0–1,9 kn 0–600 m före
  Järnvägsbron); två slutade i stopp (PRIMA LADY, SKONNERTEN JYLLAND), och
  ingen av de två utlöser regeln. **Känd kostnad:** en båt som ökar i gång till
  minst 2,8 kn och sedan stannar i en kö före bron går inte att skilja från
  LIDAN-formen i ögonblicket; syntetiskt (2 → 3 → 3,5 kn, kö 10 min 150 m före
  Järnvägsbron) kommer varningen 907 s före korsningen i stället för 105 s. En
  långsam ökning till 2,9–3,1 kn ger kortet "3" när 5,5–5,75 min återstår
  (basen 4 med 3,0 kvar). Båda låses i `opening-accel-motfall`. Inget sådant
  fall finns i rådatan, och buggjägaren genererar aldrig mönstret ökning → kö.
  **Bara AISHub-takt:** med tät klass A (fix var 2–10 s) eller blandad källa
  visar två nya fix i rad aldrig 0,8 kn ökning, så regeln utlöses inte där;
  LIDAN-formen får då basens 128–130 s. Vinsten gäller i praktiken AISHub. **Mätt:** i
  banken och fältet lyfts BALTIC DREAM 107 → 186 s, VISTEN 132 → 192 s och
  LIDAN 138 → 206 s över 150 s, och MONIKA, LIANNE, NAVEN och JAATTEN II får
  51–70 s mer ledtid; NORDIC SOLA, PRIMA LADY och ORANESS (avgångar) får som
  förut. Ingen passage blir sämre. I buggjägarens 2 000 standardvärldar är
  utfallet som basen 187f31e: T2 tunn 537 / 870, samma kandidatkort, en varning
  7 s tidigare. Den första versionens konvojkostnad (tre följare med eget kort
  och fyra mötande södergående båtar med kortare ledtid, alla ≥ 150 s)
  försvann med avgångsgrenen. `opening-accel-rule-villkor`
  har ett fall per villkor och `opening-accel-motfall` granskarens motfall.
  **Kortets siffra (U28):** när regeln förkortade spärren bär armen
  `accelArrivalMs` (ankaret + avståndet i max(fart, 5 kn)), och
  `_warningLeadInfo` låter kortets `eta_minutes` bli den lägsta av
  ETA-kedjans värde och regelns restid, uppåt till hel minut (granskningen,
  M3). Regeln avfyrar därför att den tror att båten går i minst 5 kn; kortet
  får då inte i samma ögonblick påstå kedjans ETA ur den lägre farten. Andra
  kort är orörda, och en okänd ETA förblir okänd.
  **Känd gräns (klass B):** avgång ur kö 360–440 m från Stridsbergsbron.
  Första rörelsefixet ligger ofta redan inom 350 m, där spärren inte gäller,
  och båten är framme på 140–170 s. Varningen kan bara komma tidigare om appen
  varnar medan hon köar, och det är just det fel som spärren finns mot
  (20260907-31h 80 s, 20260909-80h 131 s). **Känd gräns (förstakontakt söder
  om Olidebron):** utan historik spärras hon inte (H1), och Klaffbronvarningen
  går på 10-knopsdeadlinen från första fixet, i banken 26 gånger 9–38 min före
  Klaffbron. En vakt vid Olidebron mättes 2026-11-16 och infördes inte: den
  bröt 10-knopsgarantin för en förstakontakt som tystnar och går 8–10 kn (5–125 s
  mot 181–276 s); fältgranskningen 2026-11-14, F2.
- **Kedjearmen efter en bekräftad vändning (fältprovet 10–13 november, familj
  B; granskningen och dirigentens beslut 2026-11-14):** k1 11 nov vände PILOT
  761 222 m norr om Stridsbergsbron efter 30 min stopp. Vändningen tömde
  `passedBridges` (NEW_JOURNEY) och köposterna (`_anchorJourneyOrigin`), och
  köposterna skapas av `_noteBridgeQueueApproach`, som körs före
  måltilldelningen. Första målbrofixet efter en vändning saknar därför allt
  underlag för spärren. Kajprovet sköt målbron ett fix, och kedjearmen
  Klaffbron (`ARM_NEXT_TARGET`) beväpnades 12:33:55 på ett AISHub-fix 27 s
  gammalt utan spärr. 10-knopsdeadlinen föll före nästa fix, och varningen gick
  12:34:57 med "eta 25", 50,7 min före passagen efter 34 min kö vid
  Järnvägsbron.
  - **Regeln.** Efter en bekräftad vändning räknar `_earlierBridgeAhead` varje
    opasserad bro mellan båten och kedjearmens bro som tidigare bro, även utan
    passerade broar och köposter. Kedjearmen hålls alltså från första
    målbrofixet, som för en båt med historik; den egna målbrons arm berörs
    inte. Underlaget är vändningsmärket `_reversalConfirmedAt`, som sätts av
    `_anchorJourneyOrigin` med `reversal` (app-lagrets NEW_JOURNEY och
    `_confirmDirectionReversal`, båda efter U18:s två positioner) och förs
    vidare i `_createVesselObject`. Märket släcks på första fixet där
    `_noteBridgeQueueApproach` bokför en köpost (då finns det vanliga
    underlaget), när båten klassas förtöjd, och det följer inte med i graven
    eller över en omstart. En ny vändning sätter om det. I k1 går PILOTs
    varning nu 13:15:44, cirka 9,6 min före korsningen (fixen 13:24:50 och
    13:25:58 ligger på var sin sida om bron). Banken är bitlik med e51c7b6.
  - **Bara efter en vändning.** Samma regel för varje båt utan historik
    (förstakontakt mitt i kanalen, båt efter en omstart) gav sena varningar:
    spärren håller då en arm som saknar kadens, och tystnadsregeln
    (`_silentHoldLimitMs`) kräver två mottagningsintervall. Granskarens
    sondmatriser: ett första fix i 2,5 kn och sedan 8–10 kn utan fix gav 22 av
    108 fall under 150 s, tio under 60 s eller efter passagen; en omstart under
    spärren gav en passage helt utan varning. Basen gav minst 181 s.
    Scenarierna `förstakontakt-2,5kn-sedan-8kn-norrut-i-tystnad` och
    `omstart-120m-före-Stridsbergsbron-10kn-gles` prövar det.
  - **Känd gräns: vändning följd av hög fart i tystnad.** Situationen: en båt
    vänder i låg fart (två omvända fix i cirka 2,5 kn), hörs sedan inte på 3–6
    min och går därefter fort genom målbron och Järnvägsbron, som båda måste
    öppna. Vid beslutsögonblicket ser det likadant ut som när båten går 1,8 kn
    till kön vid Järnvägsbron (familjens scenario 2, k1:s PILOT låg där 34 min),
    och den får inte varnas före kön. Spärren håller 300 s från bekräftelsen.
    Ledtiden för kedjebron mot den sanna korsningen, granskarens sondmatriser (12
    fall per fart: båda riktningarna, vändning 200 och 300 m bortom målbron, nästa
    fix efter 180, 240 eller 360 s):

    | Fart efter vändningen | Bas e51c7b6 | Nu | varav 240–360 s tystnad | Vakt 8 kn (prövad, ej införd) |
    |---|---|---|---|---|
    | 4 kn | 621–651 s | 175–457 s | 402–451 s | 556–582 s |
    | 6 kn | 407–421 s | 181–281 s | 188–221 s | 342–352 s |
    | 8 kn | 300–306 s | 81–165 s | 81–105 s | 235–236 s |
    | 9 kn | 264–268 s | 45–127 s | 45–67 s | 197–200 s |
    | 10 kn | 236–237 s | 17–96 s | 17–36 s | 165–172 s |

    Under 150 s: 10 fall i 8 kn (81–141 s) och alla 12 i 9 och 10 kn; under 60 s:
    4 fall i 9 kn och 8 i 10 kn. Ingen varning kom efter passagen och ingen
    passage blev ovarnad i de 60 fallen, men i 10 kn är marginalen 17 s. Snabbare
    än 10 kn är inte prövat. Det låsta scenariot för värld 1208 (M1, 5 kn) får
    Stridsbergsbrons varning 280 s före den sanna korsningen i stället för 472 s,
    och en ETA som stämde ("eta 8") blir okänd. Det som talar för att fallet är
    en undre gräns: generatorn passerar broarna utan uppehåll, men i
    verkligheten måste målbron och Järnvägsbron hinna öppna; den tidiga klassen
    (fältfelet, 50,7 min) är sedd i fält, den sena inte. Vakten som räknar
    spärren efter vändning på minst 8 kn tar bort fallen (tabellen; 1208 400 s
    och "eta 6") men varnar familjens scenario 2 29,6 min före passagen (1 779 s
    mot 411 s); 4 kn (`EARLIER_BRIDGE_BEYOND_KN`) ändrar ingenting. Ingen vakt är
    införd. Öppen ägarfråga (2026-11-14), alternativ: (a) spärren som nu, med
    tabellens sena fall; (b) vakten 8 kn, och fältfelets klass kommer tillbaka
    när nästa fix efter vändningen dröjer mer än cirka 170 s; (c) ingen spärr
    efter vändning (basen), fältfelet kvar. Familj B rekommenderar (a).
    Scenariot `vänder-norr-om-Stridsbergsbron-8kn-söderut-i-tystnad (känd gräns)`
    låser gränsen vid 90 s (i dag 105 s).
  - **Omstart.** Märket sparas inte, så efter en omstart är båten en
    förstakontakt. Ligger hon då mellan Stridsbergsbron och Järnvägsbron på väg
    söderut (eller mellan Klaffbron och Järnvägsbron norrut) är nästa målbro
    hennes EGEN, med Järnvägsbron emellan; den egna armen saknar historik och
    köposter på första fixet och varnar på 10-knopsdeadlinen. Granskarens omstart
    12:36:40Z i k1 gav PILOT en varning 12:37:46Z, 47,6 min för tidigt. Det är
    basens beteende och hör till de kända omstartsgränserna (öppningsarmar och
    resetillstånd sparas inte); att låta märket eller regeln gälla där skulle
    återinföra granskningens H1.
  - **Instrumentet `[OPENING_HOLD]`** (debug, `_noteHoldTransition`) skriver
    bara övergångar för armar där spärren kan hålla en varning (ovarnade och
    absorberade): spärren börjar hålla (bro, underlag, gren, slut), spärren
    kortas mer än `TICK_INTERVAL_MS`, och spärren släpps (fix utan tidigare
    bro, utlöpt, avväpnad eller varnad). Släpp-raden bär det faktiska slutet
    och antalet förnyelser. En förnyelse som skjuter slutet framåt och ett
    brobyte inom spärren loggas inte. I fem uppmätta korpusar (k1 och fyra ur
    banken) blev det 12–68 rader per korpus, med en start och ett slut per
    spärr.
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
  och `persistent_opening_warnings` (`bro|mmsi|riktning`, ÖVER omstart — v1
  persisterar inga armar, så en omstart mitt i en anflygning varnade annars om
  för samma öppning). Sedan 33b9fbf är posten en **ankomstspärr utan
  tidsgräns**, inte ett tiominutersfönster: den gäller tills ankomsten tar slut
  (bekräftad passage, bortfärd eller kajstopp följt av avgång; se tabellen
  i §6 Persistens och §Förtöjningslagren).
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
- **U41 (2026-11-16): en sändare med en fart som ingen båt håller skapas inte.**
  `updateVessel` skapar ingen båt när en sändare som appen inte följer rapporterar minst
  `IMPLAUSIBLE_NEW_VESSEL_SOG_KN` (15 kn); loggraden är `[VESSEL_IMPLAUSIBLE_SPEED]` och
  nästa position prövas på nytt. Fältfallet är ett landfordon, 218023240 i 20260713-41h:
  33,2 kn på Stallbackabrons körbana (kursen längs broaxeln) och 21,7 kn på en stamväg 877 m
  från farleden. Det visades som båt i 18 min och fick en notis för Stallbackabron på sin
  första position, så regeln verkar på ett enda sampel. Mätningen (banken + k1/k2, 30 719
  positioner): den snabbaste båten som korsar en bro rapporterar 10,6 kn, och över 12 kn finns
  bara fordonets två positioner, PRICKBJORNs enstaka spik (22,2 kn mitt i ett spår, k2) och ett
  enkelsampel på 13 kn i farleden (211488728). Ingen befintlig vakt tog fallet: båda
  positionerna ligger inom `BOUNDING_BOX`, GPS-hoppsanalysen behöver en föregående position
  (och den andra positionen stämmer med farten), och C6:s rimlighetsvakt (> 10 kn kräver
  positionsstöd) gäller bara öppningsbeväpningen. En båt som redan följs berörs inte, så en
  enstaka orimlig fart får henne inte att försvinna. Banken och k1/k2 har inga positioner mellan
  13 och 21,7 kn, så varje gräns mellan cirka 13,5 och 21,5 kn ger samma utfall där; 15 kn är
  mittpunkten. *Kända gränser* (ingen av dem finns i banken eller fältet; siffrorna är
  granskningens syntetiska prov, bas mot U41):
  (a) **En verklig båt på minst 15 kn kostar notiser och ledtid.** Hon skapas först när hon
  saktar in under 15 kn. Söderifrån mot Klaffbron (16 kn från Olidebron, saktar in 400 m före
  bron) sjunker varningens ledtid från 276 till 156 s, och med 60 s mellan positionerna och
  inbromsning 250 m före bron från 217 till 97 s; förvarningarna för Kanalinfarten och Olidebron
  blir "passerade … under AIS-tystnad". Norrifrån (16 kn, saktar in 500 m före Stridsbergsbron)
  går ledtiden från 404 till 194 s och förvarningen för Stallbackabron blir "passerade … under
  AIS-tystnad". En båt som håller 16 kn hela vägen (en RIB under broarna) syns inte alls (basen:
  5 notiser, 2 varningar, 7 texter).
  (b) **"En båt som redan följs" gäller bara tills appen raderar henne.** Efter en omstart, en
  närhetstimeout eller 30-minutersbackstoppen prövas hon som ny sändare, och en båt som då går
  minst 15 kn är osynlig tills hon saktar in (prov: omstart mitt i en 16-knopssträcka, varningen
  för Stridsbergsbron 60 s senare än i basen, ledtid 194 s).
  (c) **Ett fordon som först rapporterar under 15 kn visas som båt.** Prov: 12 kn på
  Stallbackabron, sedan 28 och 21,7 kn (den sista 877 m från farleden): notisen "Okänd båt närmar
  sig Stallbackabron", texten "på väg mot Stridsbergsbron" i 19 min och en öppningsvarning för
  Klaffbron, lika i bas och U41. Att ta bort en redan följd sändare när två positioner i rad
  rapporterar minst 15 kn och förflyttningen mellan dem också motsvarar minst 15 kn (kostnad 0 i
  banken; PRICKBJORNs spik faller inte på det, förflyttningen var 9,9 kn) är INTE byggt:
  borttagningen går genom skyddszonen (300 m från en bro skjuter upp borttagningen), exit-
  fallbacken i `_onVesselRemoved` (kan själv skicka notiser), och öppningstjänsten, som
  medvetet behåller armen vid en borttagning (`BridgeOpeningService.removeVessel` släpper armar
  bara med `force`, i dag endast vid journey-reset). Fordonets varning i provet kom ur just en
  sådan kvarvarande arm; att släppa den kräver en egen granskad ändring av öppningstjänstens
  tillstånd (händelser och konvojmedlemskap).
- **Återinträdesspärren och återvändaren (nattjaktens F04, 2026-11-16).** I 10 min efter en
  avslutad resa avvisar `updateVessel` varje position för mmsi:t (`VESSEL_REENTRY_BLOCK`), och
  `_shouldAssignTargetBridge` spärrar målbron lika länge (`REENTRY_BLOCK`). Spärren finns mot
  remove→recreate-churn för en båt som just lämnat området. Felet: en båt som gick ut genom
  Stallbackabron, vände ~420 m bortom bron och kom tillbaka i 9–10 kn syntes först 232 m före
  Stridsbergsbron; notisen, en sju minuter gammal notis för Stallbackabron och öppningsvarningen
  kom på en gång, 51 s före korsningen. Söderut är det värre: resan avslutas först söder om
  `KANALINFARTEN_EXIT_LAT`, och en återvändare når Klaffbron inom spärren. *Rättningen*
  (`_releaseReturningVessel`): under spärren bygger appen en kedja av godkända positioner. En
  position är godkänd när den ligger entydigt på utfartssidan av sista bron (nord ⇒
  Stallbackabron, syd ⇒ Olidebron), har kurs mot brolinjen (`courseBridgeSide`; utfarten söderut
  går västsydväst, så kompassband duger inte), går i minst `REENTRY_RETURN.MIN_SOG_KN` (4,5 kn) och
  har ett steg från förra godkända positionen som farten medger (2 × fart × tid + 50 m). Den första
  godkända positionen ankrar kedjan; båten släpps när en senare position ligger minst
  `REENTRY_RETURN.MIN_APPROACH_M` (100 m) närmare linjen än ankaret, netto. En underkänd position
  nollar kedjan. Loggrader: `[REENTRY_RETURN_CANDIDATE]` och `[REENTRY_RETURN_RELEASE]`. Posten får
  `returnReleased`, och `_shouldAssignTargetBridge` tar då samma väg som när spärren löper ut
  (`REENTRY_NEW_JOURNEY`, journey-reset med förra resans riktning). Bokföringen av avslutade resor
  och gravvården är orörda (jfr L9 i §9). *Mätningen* (banken + k1/k2): 191 spärrade positioner,
  ingen gick mot sista bron ens i 2 kn (17 hade kurs mot bron, alla ≤ 0,8 kn), och ingen spärrad
  båt korsade sista bron tillbaka inom 30 min i rådatafacit; med regeln är banken och fältet
  bitlika. *Talen* 4,5 kn och 100 m kommer ur två granskningsvarv av N5. Med 2 kn och 50 m
  släpptes en båt som driver i 2,2 kn mot bron till 150–250 m (förvarning "närmar sig
  Stallbackabron, beräknad ankomst om 4 minuter" fast hon aldrig korsar, och spöktext i 3–5 min),
  en kajmanöver i 2,5 kn söder om Olidebron och en ankrad båt med ett brusigt positionspar. Med
  3 kn släpptes fortfarande båtar i 3,1–3,5 kn som driver eller går mot bron och sedan stannar
  eller vänder ("DRIV31-A närmar sig Stallbackabron, beräknad ankomst om 35 minuter" 300 m från
  bron, med ETA:n till Stridsbergsbron) och en ankrad båt med tre brusiga positioner i rad
  (3,2 kn). 4,5 kn skiljer en båt i marschfart från en som driver eller ligger för ankar. Alla
  dessa är låsta som syntetiska motfall med basens utfall. *Utfallet för en återvändare*
  (syntetiskt, vänder 430 m bortom Stallbackabron respektive cirka 1 000 m söder om Olidebron):
  i 9 kn kommer varningen för Stridsbergsbron 290/272/245 s före korsningen med positioner var
  10/30/60 s (basen 54/94/154 s); söderut för Klaffbron i 5–9 kn 247–415 s före (basen 166–370 s,
  i 9 kn ingen varning före korsningen). I 4,5–6 kn norrut hinner spärren löpa ut före varningen i
  båda; det som ändras är att förvarningen för sista bron kommer före korsningen i stället för som
  "passerade … under AIS-tystnad" 4–6 min efter. Under 4,5 kn är utfallet basens.
  *Kända gränser:* (1) en återvändare under 4,5 kn syns först när spärren löpt ut, som förut;
  (2) en båt som verkligen går mot bron i minst 4,5 kn och kommer 100 m närmare, men sedan vänder
  eller stannar, släpps och får en förvarning: i syntetiskt prov (5 kn från 430 till 250 m
  bortom Stallbackabron) "VAND5 närmar sig Stallbackabron, beräknad ankomst om 2 minuter" och
  1,5 min i texten innan hon vänt ut (ETA:n stiger 16 → 22 min när hon vänder, INV-3); stannar hon i stället (STOPP5) står hon i texten i cirka
  40 min (ETA okänd efter 5 min) och får en öppningsvarning för Stridsbergsbron på deadline cirka
  20 min senare. En ny båt som kommer norrifrån och stannar 250 m före Stallbackabron får samma
  notis och samma slags text och varning (där bär varningen eta 15 mot 22 här, och "ETA okänd"
  kommer efter 20 min mot 5 här); (3) med glesa positioner (180 s)
  norrut ligger högst en position bortom bron på vägen tillbaka, och då hjälper regeln inte;
  (4) utan fusionen bryter ett AISHub-eko ur ordning kedjan (basens utfall). Produktionens väg
  ('both', FixFusionPolicy) sorterar bort ekot, och släppet fungerar där (jest-test
  `f04-aterintrade-fusion`).
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
    kurs i dödbandet får som förut målbro först när kursen lämnar bandet. Första
    fältfallet (2026-11-12, PRICKBJORN): avgång från ett stopp 460 m norr om
    Stridsbergsbron med kurs 225–232° (farleden går ~45° där) och ruttlåset `south`
    kvar; målbro först på 165 m, öppningsvarningen 133 s före korsningen och "Inga
    båtar" i texten under anflygningen. M3:s bevis fångar henne inte tillförlitligt
    (nordkomponenten 1,1 kn över 97 s mot ribban 2 kn). En skuggmätt regel för
    följda båtar (låst riktning, samma sidas dödband, sog ≥ 2 kn, två närmande ben
    ≥ 50 m) slår till just där och ingen gång i bankens 24 korpusar, så banken kan
    varken visa nytta eller kostnad; frågan ligger hos ägaren. (c) En äkta
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
  (`_detectManeuverProtection`: COG-ändring >45° ELLER fartändring >2 kn;
  söder om Kanalinfarten-punkten krävs verklig rörelse, se k1 nedan);
  passage <60 s; koordination aktiv. Aktiv protection ÅTERSTÄLLER targetBridge
  om något ändrat den. Manöverflaggan håller också skyddet vid liv: släppet
  ">500 m + inga event + >1 min" kräver att samplet inte är en manöver.
  **Manövern söder om Kanalinfarten (fältprov k1, 2026-11-11, rättningskampanjen
  familj D, revision 2 efter omgranskningen):** PRICKBJORN svängde in mot en kaj
  166 m från Kanalinfarten-punkten, 2,1 km från Klaffbron (verklig manöver,
  skyddet aktiverades med rätta). När skyddet släppt och nådafristen startat
  återaktiverades det av kursbrus (292° → 152° vid sog 0 och 2,5 m) och
  förlängdes av nästa kurshopp (sog 0,1, 1,3 m); målbron släpptes 138 s för
  sent och texten räknade henne "på väg mot Klaffbron". `_maneuverLacksMovement`:
  när BÅDA fixarna ligger söder om gränsen och båten flyttat sig
  < `NULL_SOG_STILL_RADIUS_M` (40 m) sedan förra fixen räknas (a) kursbenet inte
  när samplets EGEN fart (`_rawPositionSog`, inte den ärvda `sog`; prejudikat
  F05 rev 3) är under `MOORING_DETECTION.STATIONARY_SOG_KN` (0,3), och (b) inget
  av benen när farten hoppat mer än fartbenets 2 kn.
  **Beslutsgrund: FP9-H′** (användarbeslut 2026-07-18, `_shouldAssignTargetBridge`):
  söder om punkten ligger lotskajen och väntplatserna utanför brosystemet, en
  målbro där förutsätter demonstrerad färd norrut, fristen ska släppa
  retentionen och en äkta väntare döljs hellre tills hon rör sig. Villkoret
  (båda fixarna söder om gränsen) är FP9-H′:s. **Gränsen** ligger 40 m
  (`NULL_SOG_STILL_RADIUS_M`, kodens jitterradie) norr om
  `TRIGGER_POINTS.kanalinfarten.lat`: kajraden vid Kanalinfarten, 125–170 m väster
  om punkten, ligger på båda sidor om punktens latitud (CAPELLA permanent 2 m
  norr, PRICKBJORN 9–10 m norr den 12 november), och med gränsen på linjen kom
  fältfelet tillbaka byte för byte när k1-händelsen flyttades dit (omgranskningen
  R1-M1). Radien täcker raden utan att nå in i någon köyta; punktens egen radie
  (300 m) prövades också och gav samma utfall men vore en större region än
  fältfelet kräver. FP9-H′:s egna regler och deras gräns är orörda. (b) gäller
  fartbrus vid just de kajerna, som FP9-H′ dokumenterar (HEY JOE 0,8–7,5 kn):
  rådatan har 60 fixpar söder om gränsen där ett ben slår till med < 40 m —
  29 brus, 31 början på en verklig avgång (en avgångs första fix har full fart
  men nästan ingen förflyttning, så ett fixpar kan inte skilja dem åt) — och
  bara ett av dem hade målbro: PILOT 761 10:16:31, en verklig sväng i 3,9 kn som
  inte berörs. En avgång med bevisad förflyttning (≥ 40 m) räknas som förut.
  **Norr om gränsen är båda benen oförändrade:** där är kursbruset det som håller
  en stilla köare utanför kö-zonen (600 m) och broarnas 300 m, t.ex. kön mellan
  Klaffbron och Järnvägsbron mot Stridsbergsbron (Klaffbrons skyddszon upphävd
  av F21). Revision 0 av rättningen gällde överallt och tappade 15 av
  granskningens 26 konstruerade köfall i 9–14 min; den vidgade också U27, som
  beslutades med premissen "kräver fart exakt 0". Om stilla köare i luckan ska
  skyddas av något annat än kursbruset är en öppen fråga hos ägaren. Utfall:
  bara k1 ändras (PRICKBJORN släpps 13:28:15 i stället för 13:30:33); banken är
  byte-identisk. Kända gränser: (1) skyddet gäller på alla avstånd, så en verklig
  sväng mot en kaj söder om punkten skyddas fortfarande (PILOT 761 k1 10:16,
  3,9 kn, 22 m; ELFKUNGEN 20260806-42h 11:35) — ägarfråga; (2) gråzonsfart
  0,3–0,49 kn utan förflyttning räknas som rörelse även söder om gränsen; (3) ett
  fartbrus som råkar ge ≥ 40 m (lång tystnad, GPS-drift) räknas som rörelse;
  (4) **en båt med målbro som stannar söder om gränsen döljs tidigare än förr**
  (omgranskningen R1-L1). En båt vid kaj där har ingen målbro (FP9-H′), men en
  båt som kommer söderifrån och går norrut får målbro redan söder om punkten
  (PILOT 761 10:15:35, PRICKBJORN 13:24:50). Stannar hon där räknas
  inbromsningens fartsprång inte längre som manöver, och FP9-H′ med fristen
  släpper henne efter 60 s. Granskarens konstruerade fall (norrgående, stopp
  2 min 230 m söder om punkten med 10 s kadens) visar "Inga båtar" i 60 s där
  basen höll henne kvar (INV-14 DEFAULT-FLASH i det fallet); vid 4 min stopp
  110 → 180 s. Riktningen är FP9-H′:s ("hellre tyst"); notiser,
  öppningsvarningarnas tid, bro och innehåll samt avgångens tilldelning är
  oförändrade (bara den interna händelsenumreringen flyttas ett steg), och
  fallet finns inte i data. Med glesare AIS (60 s eller mer) blir det identiskt
  med basen.
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
  **Målbron borta i väntans fix (nattjakten F12, 2026-11-16).** Fix D-blocket kräver
  målbro. Tog samma fix som satte väntan också bort målbron (MOVING_AWAY: avståndet växer,
  vilket är vändningen själv), prövades den andra omvända positionen aldrig, och låset stod
  kvar till nästa brokorsning (värld 2931, HAVSORN: "närmar sig Järnvägsbron" 12:01:50 med
  riktningen söderut efter två omvända positioner i följd). `_confirmFixDPendingWithoutTarget`
  bekräftar nu en sådan väntan utan målbro, med Fix D:s grindar (2 kn, kursbanden, 15 min),
  bara på fixen direkt efter väntans fix (`_fixDPendingReversal.fixTs`) och inte efter ett
  avslutat slutmål, där NEW_JOURNEY äger vändningen. Utfallet är det Fix D hade gett om målbron
  levt en fix till. U18 rörs inte: ingen fix utan målbro startar en väntan, och en mellanfix i
  dödbandet (46–134°) bryter kedjan som förut. Den gränsen, inte målbron, förklarar tre av
  kortets nio världar (2125, 6244, 16784) och är kvar som känd gräns under U18; i två till
  (7262, 18849) kom bara en omvänd position före varningen.
  Positionsbenen under 2 kn har kvar sitt målbrokrav (deras prov läser målbrons geometri).
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
    - **Känd gräns (omgranskningen 2026-11-09, L6).** En utliggare 30–180 m bakom
      Järnvägsbron vars kurs också är vänd ger ett kort falsklarm. Kontrollen ser inget,
      eftersom kurs och återkorsning är eniga, och Klaffbron ligger 900 m bort, utanför
      under-bro-vakten. Följden är en falsk Klaffbronvarning söderut och 20–60 s "på väg mot
      Klaffbron", där c14938f gav 20 s "Inga båtar". Granskarens prov gav det i 23 av 252
      banor med vänd kurs. Fältdatan (S-F4) visar att utliggare bär båtens verkliga fart,
      så fallet är ovanligt. Följden är ett falsklarm, inte en missad öppning. Ett möjligt
      skydd är att avstå samma-tick-tilldelningen vid en vändning på 180° i minst 2 kn
      mellan fix som ligger mindre än cirka 30 s isär.
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
    (`_earlierBridgeAhead` i BridgeOpeningService) gäller för kedjearmen redan från
    första målbrofixet efter vändningen (vändningsmärket, se "Kedjearmen efter en
    bekräftad vändning" ovan). Fram till fältprovet gällde den först från fixet efter,
    eftersom köposterna kräver målbro, och bara om det fixet hann före kedjearmens
    10-knopsdeadline; i fältet kom målbron dessutom ett fix sent (kajprovet), och
    PILOT 761 varnades 50,7 min före passagen. Returbåten behandlas som vilken båt som
    helst med en tidigare bro framför målbron. Mätningen när samma-tick-målbron
    infördes (mot c14938f, där hon slapp spärren för nästa målbro eftersom målbron kom
    ett fix sent): i svepet kom 90 av 103
    tidsflyttade varningar tidigare och 13 upp till 37 s senare, alla mot en målbro med
    Järnvägsbron emellan. I buggjägarens quick-värld 169 kom returens
    Stridsbergsbronvarning 123 s före korsningen i stället för 824 s. Ingen ledtid mot en
    sann korsning sjönk under 60 s. Spärrens avvägning avgjordes i M6 (dirigentens
    val B med två skärpningar, se spärren vid en tidigare bro ovan).
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
  tvingade väntan returnerar före hela `_isUnderBridge` (sedan familj C3, 2026-11-14:
  när fixen ligger på ankomstsidan, inom ±10 m från linjen, eller högst 50 m bortom
  den i fixens eget pass; ett senare pass på en fix bortom linjen, som vakthunden vid
  SINE BRES 26 m, rensar flaggan och går den ordinarie vägen genom INTERMEDIATE_UNDER,
  som prövar samma inträdessegment. Testerna i `zonintrade-uppskjutet-bevis.test.js`
  låser alla tre vägarna (hållningen, FIX U i fixens eget pass, det senare passet)
  och FIX U-grenens anrop, även med fixen i ±10 m-bandet där det bara kan spara P1:s
  epsilonkandidat; SINE BRES Järnvägspassage bokförs i alla 121 fasförskjutningar
  δ = −30…+30 s. I de följder familj C prövade
  avgjordes passagen ändå av den ordinarie vägen, i basen och efter C2: utgångsfixen
  bokför passagen direkt, och en mellanfix 20–30 m bortom linjen ger segmentbevis
  direkt från A0. En mellanfix 40–55 m bortom linjen efter en start 3–6 m bortom den
  tappar passagen (granskningens 208 följder: 32), eftersom segmentet från A0 blir
  över 400 m och nästa pass startar ett nytt zonbesök. Det gäller både i basen och
  efter C2/C3 och är samma klass som korpustestets KÄNDA LUCKA (en extra fix 50–60 m
  efter linjen)), och rensningspasset
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
   är en känd lucka mot D1 även i farleden. Ägaren beslutade 2026-11-09 (U27)
   att 20 min behålls tills vidare: fallet kräver fart exakt 0 och har inte
   setts i fältdata eller i buggjägarens provvärldar. Frågan tas upp igen om
   det syns i fält. Fallet syntes i fältprovet 2026-11-12 (PRICKBJORN 460 m
   från Stridsbergsbron, se farleden innanför 600 m nedan); frågan ligger hos
   ägaren.
   Motivet för U23 är D1 (docs/reliability-spec.md): utanför kajzonerna tas
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
   **Farleden innanför 600 m (familj A, fältprovet 2026-11-12; revision 1
   efter granskningen):** utanför kajzonerna registrerades förut inget stopp
   innanför `DISARM_MOORED_MIN_DISTANCE_M`, så ankomsten kunde bara ta slut
   genom passage eller bortfärd. PRICKBJORN varnades för Stridsbergsbron 08:30,
   låg sedan helt stilla 460 m norr om bron i 3 h 54 min, tappade målbron
   efter 20 min (U27) och förtöjdes av backstoppen 10:35; när hon lade ut
   12:29 och korsade bron 12:35 spärrades den nya varningen av den fyra
   timmar gamla. Nu gäller:
   - *Farledsstoppet.* Från första stilla fix i bandet (sog ≤ 0,5 kn, eller
     klassningens stillhet när farten saknas) bär posten ett stopp med egen
     ålder (`quayStop` med `fairway: true`: första fix, läge, senaste fix),
     som kajstoppet. Inom 50 m är det samma stopp oavsett fartbrus, AIS-glapp
     och omstart; ett fix 50 m bort startar ett nytt (eller är ett
     avgångsfix). Granskningens M1: med klassningens klocka (`_stationarySince`)
     nollade ett glapp på 15 min följt av fältets brus 2 h-räkningen, och en
     omstart 10:26–10:36 i fältfallet missade kortet.
   - *Släppet.* Stoppet bekräftas när det är minst MAX_STATIONARY_WAIT_MS
     gammalt (eller klassningens klocka nått dit) och klassningen inte håller
     båten som köare mot kortets bro: hon är förtöjd ELLER har inte kortets
     bro som målbro — samma två led som `holdsQuayQueue` släpper på vid Kajen
     (U23: "navstatus 1/5, 2 h-backstoppen, eller ingen målbro").
     Granskningens M2: i bandet 300–350 m tar U27 målbron, men en båt som
     passerat en bro har färsk brokö, så backstoppen förtöjde henne aldrig och
     fältfelet blev kvar.
   - *Avgången* kräver TVÅ avgångsfix i följd (minst 50 m från stoppet, minst
     0,5 kn, inte förtöjd); ett fix som inte är ett avgångsfix (till exempel
     tillbaka inom 50 m) nollar kravet. Det andra fixet ska komma inom
     `STALE_ETA_HARD_THRESHOLD_MS` (10 min, samma gräns som `gapResetsStop`)
     efter det första och ligga längre från stoppet än det första; annars
     räknas det som ett nytt första avgångsfix (omgranskningens N3: en
     utliggare, 20 min tystnad och en ny utliggare, eller drift två fix i rad
     på samma förskjutning, gav annars fortfarande ett falskt kort och en
     spärrad verklig avgång). Granskningens H1: innanför ca 925 m har
     deadlinen redan passerat när båten får målbro, så ett ensamt GPS-hopp hos
     den förtöjda båten gav ett falskt kort och spärrade sedan den verkliga
     avgången. Ett kort som servicen avfyrar på det första avgångsfixet
     spärras, och `restartArrival` på det andra låter servicen avfyra igen.
     `plausibleStep` räcker inte här (131 m på 3 min i 0,6 kn).
     Kvar efter N3 (omgranskningen av revision 2): en förtöjd båt vars
     position av GPS-drift rör sig FRAMÅT två fix i rad (granskarens P14:
     70 m och sedan 90 m från stoppet inom 10 min, i 0,6 kn) räknas som
     avgång, ger ett falskt kort och spärrar den verkliga avgången inom 2 h.
     Med två fix går det inte att skilja från en långsam verklig avgång, och
     formen kräver ett bekräftat farledsstopp (inget i bankens cirka 550 h
     trafik, ett i fältproven).
   - *Känd gräns: priset för två avgångsfix (omgranskningens N1, dirigentens
     beslut 2026-11-14 att behålla kravet).* Kortet kan aldrig komma före det
     andra avgångsfixet, och ligger det fixet bortom bron kommer inget kort.
     Uppmätt (granskarens sond P8, kurs 215°, stopp bekräftat efter 150 min,
     tre faser, ledtid före den sanna korsningen; inom parentes ett fix):
     460 m i 3 kn med fix var 60:e s 148–178 s (208–238 s), var 120:e s
     53/118/58 s (173–238 s), var 180:e s inget kort i 2 av 3 faser och 28 s
     (113–208 s); 460 m i 1,8 kn var 180:e s 132–227 s (312–407 s); 400 m i
     3 kn var 120:e s 19/79/14 s (134–199 s); 400 m i 1,8 kn var 180:e s
     67–162 s (247–342 s); 330 m i 3 kn var 60:e s 64–94 s; 330 m i 3 kn var
     120:e s inget kort i 2 av 3 faser och 34 s; 330 m i 1,8 kn var 180:e s
     inget kort i 2 av 3 faser och 86 s (330 m gav inget kort alls före M2).
     Fältfallet kostar inget, eftersom målbron kom först på 165 m
     (kursbandet); granskaren glesade fältutsnittet till 60/120/180 s utan
     skillnad. Det syntetiska scenariot får 135 s i stället för 195 s med en
     tystad avfyrning. Skälet till beslutet: utan rättningen fanns aldrig något
     kort i den här situationen, så ett uteblivet kort vid gles AIS är inte
     sämre än förut, medan ett falskt kort förbrukar ankomsten och gör den
     verkliga avgången inom 2 h utan kort. Mekanismen utlöses sällan: i banken
     (cirka 550 h trafik) skapas 107 farledsstopp och inget bekräftas.
     Alternativet en avgång på ETT fix när steget är rimligt och farten är
     minst 1,5 kn gav tillbaka 89–407 s men släppte igenom utliggare i 2–3 kn
     som falska kort. Avvägningen är en fråga till ägaren. En tredje väg,
     inte införd: ett stopp som visar sig ligga kvar efter en "avgång" (båten
     är tillbaka inom 50 m) återskapas med sin gamla ålder och bekräftelse, så
     att ett falskt kort inte kostar den verkliga avgången; då kunde ett fix
     räcka, men ett falskt kort skulle fortfarande gå ut.
   - *Känd gräns: en annan båts händelse mellan avgångsfixen (omgranskningens
     N2).* Avfyrar en annan båts händelse mellan båtens två avgångsfix filtreras
     båten bort ur det kortet (spärren gäller ännu), och `restartArrival` på
     det andra fixet släpper henne även ur den nya händelsen, så hon får ett
     eget kort ca 30 s efter den andra båtens (granskarens P9: två kort där
     ett fix gav ett gemensamt). Det hör till U2 och konvojfrågan (C-IV) och
     är inte rättat.
   - *Gränsen.* Köaren som appen håller (målbron kvar, texten visar henne)
     får inget andra kort hur länge hon än väntar (användarvalet 2026-09-06;
     bankens ANDREA 129 min på 145 m och MOKENDEIST 142 min på 114 m
     oförändrade). Stopp under 2 h, också i U27-bandet, är samma ankomst
     (U2; dig10: inget stopp över 102 min följdes av passage), liksom
     navstatus 1/5 med kortare stillhet än 2 h (KINNE-testet under 600 m i
     `tests/opening-confirmed-mooring.test.js`). KINNE-dokumentets "tid,
     navstatus eller vanlig brokö räcker inte" (`docs/faltgranskning-2026-10-05.md`)
     gäller fortfarande: 2 h-tiden ensam släpper inget, det krävs ett belagt
     stopp, att klassningen släppt båten och en verklig avgång.
   - *Följder att känna till.* Tystnad på samma plats räknas in i stoppets
     ålder, som Kajens övernattning: en båt som var stilla, stängde av AIS i
     mer än 2 h och hörs igen inom 50 m från stoppet får en ny ankomst när
     hon lägger ut (förut samma ankomst). En köare som appen höll men som
     efter ett glapp på mer än 10 min eller en omstart är ny för appen (ingen
     målbro) släpps när stoppet är 2 h gammalt — samma pris som Kajens minne
     efter 2 h. Avgångens ledtid styrs av när båten får målbro (PRICKBJORN:
     165 m, 133 s, kursbandet P5, känd gräns (b) för M3).
   - *Inte rättat, öppen fråga till ägaren:* banken har tio återavfyrningar
     som ankomstspärren höll inne och som följdes av passage (familj V:s
     mätning "Gamla öppningsvarningar"), till exempel NENJA (en kajfix, 17 h
     tystnad) och CALIMA (tyst 120 min i rörelse). Ingen av dem har ett
     observerat stopp på 2 h i farleden; att släppa dem kräver en regel som
     avslutar en ankomst utan stopp (tystnad, eller en annan båts passage),
     och det hör till konvojfrågan (C-IV).
   Prov: `tests/opening-fairway-long-stop.test.js` och scenariot
   `stopp-4h-460m-norr-om-Stridsbergsbron-i-farleden`.
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
- Fix H imminent (:3429–3517; sedan U33 i den rena funktionen `_imminentVerdict`,
  som omvärderingen verkställer och notisvägen frågar): target + färsk AIS + ej GPS-hold + ≤300 m ⇒
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
| `last_known_positions` | `_loadLastKnownPositions`:615 | `_persistLastKnownPositions`:646 | `{ mmsi: {lat, lon, t, posT, fixTs?} }`, 6 h TTL; skrivs vid removal (:1084–1090); begränsar skipped-bridges-scenario A för återfödda båtar (§3). `fixTs` (fixens egen tid, U37 del 2) låter en återfödd båts passagenotis mäta segmentet på fixklockan; äldre poster saknar fältet och prövas på mottagningsklockan |
| `quay_stable_ledger` | `_loadQuayLedger` | `_persistQuayLedger` (STRYPT: max var 15:e min + tvingad vid `onUninit`) | V1-kajavgångsgrindens historik `{ mmsi: {stillAt, lat, lon} }`, TTL = `QUAY_DEPARTURE_GATE.MEMORY_MS` (2 h); rörelseräknaren `movingFixes` persisteras ALDRIG (den är ett påstående om innevarande sessions observationer). Utan persistensen återskapade en appomstart 5 s före kajavgången PRICKBJORN-fantomen exakt |
| `persistent_opening_warnings` | `_loadPersistentOpeningWarnings` | `_persistOpeningWarnings` (vid varje avfyrning, ändring av ankomsten och konsumtion) | Etapp 6 + J15 (2026-08-22), ankomstspärr sedan 33b9fbf: öppningsvarningarnas dedup ÖVER omstart, `{ "Bro\|mmsi\|riktning": {arrivalActive: true, firedAt, closestDistance, lastFixTs, awayFixTs?, quayStop?} }`. Posten har INGEN tidsgräns (`_openingDedupActiveUntil` ger Infinity för `arrivalActive`): samma båt får inget nytt kort för samma bro och riktning förrän ankomsten tagit slut. Den tar slut genom (1) bekräftad passage — TRE konsumtionsvägar: bekräftad passage i `_observeBridgeOpening`, gap-inferrerad passage och backfill (L19); (2) bortfärd, två färska fix minst 350 m längre bort än närmaste läget (`OPENING_ARRIVAL_LEFT`); (3) ett bekräftat stopp följt av en verklig avgång (`OPENING_QUAY_DEPARTURE`, `_observeOpeningArrivals`). Stoppet bekräftas i en ritad kajzon (Kajens köare enligt U23), för en förtöjd båt mer än `DISARM_MOORED_MIN_DISTANCE_M` från bron (KINNE), och sedan familj A (fältprovet 2026-11-12) i farleden innanför 600 m när farledsstoppet (`fairway: true`, egen ålder som överlever glapp och omstart) är minst `MAX_STATIONARY_WAIT_MS` gammalt och klassningen inte håller båten som köare mot kortets bro; avgången från ett farledsstopp kräver två avgångsfix i följd (`departFixTs`) (§Förtöjningslagren). Äldre poster i formatet `{firedAt, expiresAt}` läses fortfarande till expiresAt. Riktningsledet gör att en U-svängares RETURPASSAGE aldrig tystas; sedan S11 (fixrunda 6) är riktningsledet MEDLEMMENS egen låsta riktning (`memberDirections` i payloaden), ledarens bara som fallback. S13:s härledning av expiresAt (armens förväntade ankomst `expectedArrivalMs`, kapad) hörde till det gamla fönstret; nya poster bär inget expiresAt. Känd avvägning: avbruten anflygning före omstart (§9) |
| `trigger_point_visits` | konstruktorn (`TriggerPointVisitTracker.loadSnapshot`) | `_persistTriggerPointVisits` (vid varje fasbyte i `observe`, reservation/rollback av notis, stängning vid fullbordad resa och tvingad i `onUninit`) | Besöksregeln 2026-09-07: `{ version: 2, entries: { "mmsi:punkt": {startedAt, lastFixTs, outsideFixTs, exitedAt, lastLat, lastLon, lastPositionTs, arrivalLat, arrivalLon, farSign, farSideSeenAt} } }` för alla broar och Kanalinfarten. Ett notifierat besök spärrar nya notiser till observerad utfärd (två rena fixar > 350 m, passage följd av två fixar på bortre sidan, positionsbevisad fullbordad resa, eller vid Kanalinfarten och Stallbackabron ett utåtbevis följt av minst 10 min tystnad, U46) och återkomst inom 300 m. U46:s utåtbevis `outwardFixTs` sparas och gäller bara besökets senaste fix (äldre poster och skadade värden saknar det). U51: vid ytterpunkterna släpper också en belagd avgång efter minst 2 h belagd förtöjning besöket; förtöjningsbelägget (`moorLat`, `moorLon`, `moorSince`, `moorLastTs`, `moorProven`) och föregående fixs fart (`lastSog`) sparas, så en omstart under förtöjningen ändrar inget; skadade värden ger inget belägg. U14 (2026-11-04): vid en bro avslutar också en bevisad passage tillbaka besöket (§3, dedup-lager 3); `farSign` och `farSideSeenAt` sparas, och första observationen på bortre sidan är ett fasbyte. Bokföringsstämplarna (`farSideBooking`, `returnBookedAt`), den noterade korsningen och fixens segment gäller bara det levande fartygsobjektet och sparas inte; efter en omstart noteras en korsning på nytt ur den sparade sista fixen. Äldre poster utan fälten, eller med skadade värden, får inget returpassagesläpp. Stängda poster gallras efter 6 h; tak 2048 poster |
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
- `corpora.js`: **25 låsta korpusar (519,1 h, läget 2026-11-15)**, inklusive 42h-körningen, med
  `expectedNotifications` + motiverad `note` vid omlåsning = **facit**;
  `corpora-distribution.json` låser fördelningen per fartyg+bro. Samtliga 25
  låser även öppningar; tolv har fullständiga `golden-events` för att upptäcka
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

**Avgångsgolvet efter en målbroövergång (familj E, fältprovet 2026-11-12).**
PRICKBJORN 265012090 (körning 1) passerade Stridsbergsbron söderut 12:35,
fick Klaffbron som målbro 12:36:04, låg stilla 160–175 m norr om
Järnvägsbron till 12:53:33 och lade ut i 1,1 → 1,0 → 3,7 → 6,9 kn. Texterna
blev "om 32, 33, 25 minuter" mot sanningen 6,7, 6,1 och 5,0 min. Målbytet
tömmer fartbufferten och armerar stationär-holden (FP6-1/FP7-1, H22), och
holden svarar null i `_getEffectiveSpeed` INNAN bufferten matas — väntans
sampel nådde alltså aldrig avgångsigenkänningen, och rå-ETA:n räknades på
1,1 kn. Nu bokförs holdens sampel som stillhetsbevis (`_holdStillness`,
`_noteHoldStillness`) med buffertens definition (de senaste högst tre
farterna, senaste stillasamplets position), och `_noteDepartureSample` prövar
det beviset med samma krav när buffertens bevis inte räcker: minst två sampel,
alla under 0,5 kn, avgången högst 200 m från stillheten och närmare målbron.
Beviset finns bara i samplet som släpper holden och förbrukas där. Det samlas
BARA i en hold som ett målbyte armerade (`clearVesselETAHistory` öppnar en tom
post): där är bufferten tom, så avgången ändrar ingenting utom att golvet
armeras. Holden svarar fortfarande "ETA okänd" under 1,0 kn, och fartbufferten,
`_lastStillSample` och historiken rörs inte — en släppt hold utan igenkänd
avgång räknar exakt som förut. Skillnaden mot det återtagna stillhetsminnet
nedan är att beviset aldrig bärs över ett målbyte och aldrig överlever holden.
En hold som `ETA_STALE_HARD` armerade (`armStationaryHold`) samlar inget bevis:
där ligger förgapsfarterna kvar i bufferten, och den varianten prövades och
återtogs (LA FEMME 219033332 i 20260804-both-21h 10:04:48 fick "om 10 → 7" och
"om 7 → 6" mot sanning 10,0 och 9,2 min, eftersom hon väntade igen före
Klaffbron; MOKENDEIST i 20260806-42h bytte ledare i Klaffbrongruppen). Mätt
enligt VALIDATION.md §REGELN ("Familj E", fältprovet): banken är oförändrad i
alla 3 103 påståenden; i k1 blir PRICKBJORNs texter "om 16, 17, 12, 8, 5" i
stället för "om 32, 33, 25, 7, 4" (sanning 6,7, 6,1, 5,0, 3,9, 3,0). De två
sista texterna, notisen 12:58:39 ("om 3 → 4", sanning 1,6) och
öppningskortet Klaffbron#27 (eta 6 → 9, sanning 3,9) blir sämre: förut
släppte den stora överskattningen väntbaslinjen under Järnvägsbron
(`_releaseWaitingBaseline`, outliergrenen), nu bär EMA:n golvprognosen två
sampel till. Svansen kommer av EMA:n och av att holden inte lämnar någon
väntehistorik åt `_releaseWaitingBaseline`, som därför bara kan släppa via
outliergrenen. I familjens syntetiska kontroll ger buffertvägen (samma
avgångsprofil för en båt som fick Klaffbron utan målbyte) samma sena värden,
"om 13, 9, 6, 4". Det gäller inte allmänt: med holden avstängd i fältets egen
data bär buffertvägen väntans prognos genom EMA:n och publiceringsklampen och
ger "om 46, 34, 24, 17, 12" (granskningen 2026-11-13, A1). Att ta bort svansen
kräver ändringar i baslinjesläppet eller i EMA:n, alltså ETA-etappen
(U20/U22).

*Avvägningen mot REGELN (beslut för ägaren).* I fältfallet blir de tre första
texterna 13–16 min rättare (+25,3/+26,9/+20,0 → +9,3/+10,9/+7,0), och det
tidsviktade felet går från 14,1 till 6,3 min. Men enligt REGELNs
acceptansmått blir fältets påståenden i bandet under 5 min sämre: median
2,13 → 4,13 och andel ≤ 2 min 2 av 5 → 1 av 5 (bias +5,53 → +4,13), och
öppningskortet säger eta 9 mot sanningen 3,9 (förut 6). Banken
(`measure:eta`, 3 103 påståenden) är oförändrad. REGELN saknar ett
tidsviktat mått (punkt 5), så att väga det grova felet mot de små
försämringarna i bandet är ett beslut, inte en följd av REGELN.

*Gränser för rättningen (samma som buffertvägen).* Avgången känns bara igen
om samplet som släpper holden ligger mätbart närmare målbron än det sista
stillasamplet; hörs första samplet på 1 kn eller mer på stoppets position
missas avgången, beviset förbrukas och ETA:n räknas på igångsättningsfarten
som förut. Och eftersom varje sampel på 1 kn eller mer släpper holden omfattas
bara båtar vars första sampel efter målbytet är under 1 kn: i praktiken
södergående som stannar vid Järnvägsbron strax efter Stridsbergsbron, och
målbyten efter AIS-glapp. En norrgående båt som stannar först vid Järnvägsbron,
ungefär 1 km efter Klaffbron, har redan släppt holden.

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
20260710-13h 12:13:45 +11,3; ingen ETA räknades 11:49–12:13 — varianten där
holden efter ett målbyte svarade null är sedan fältprovet 2026-11-12 täckt,
se stycket ovan, men PILOT 761 räknades inte alls). Två vidgningar
prövades och återtogs enligt U13: ett eget stillhetsminne utanför bufferten
(överlever gap-reset, målbyte och stationär-hold) fångar ANTJE men gör 8–17
mätta påståenden sämre (ELFKUNGEN ×3, ANTJEs senare rader, YOLO 2:s notis
7 → 2 mot sanning 30 min) och flyttar en öppningsvarning; att låta de två
senaste buffrade samplen räcka (granskarens V1) fångar NOCHT 12:01 men gör
ELFKUNGENs låsta rad i 20260907-31h sämre, "om 11 → om 8" mot sanning 13,1.
PILOT 761 kräver en stillhetssignal från VesselDataService, krypfarten och
startsamplen en annan stillhetsdefinition än rörelsebeviset — klassen hör till
ETA-etappen (familj E2 och senare).

*Kryp i kön och ny väntan (omvänt fel, gemensamt för buffertvägen och
holdvägen; granskningen 2026-11-13, A3).* Avgångsigenkänningen ser bara det
första rörliga samplet och kan inte skilja ett kryp i kön från en avgång. En
båt som efter väntan kryper 1–2 kn i några sampel och sedan väntar igen får
golvet (dubbla krypfarten, högst 4 kn) och en för LÅG prognos, och
outlierskyddet håller sedan det låga värdet under den nya väntan
(`ETA_FALLBACK`). Granskningens svep (södergående, målbyte vid
Stridsbergsbron, 17 min väntan 175 m norr om Järnvägsbron, kryp, 10 min ny
väntan; mest optimistiska textfel under kryp och väntan, `e51c7b6` → efter
familj E):

| Kryp | Före | Efter |
|---|---|---|
| 1,2 kn × 3 steg | +8,5 | −5,5 |
| 1,5 kn × 2 | +5,4 | −6,6 |
| 1,5 kn × 3 | +3,6 | −8,4 |
| 2,0 kn × 2 | −1,4 | −9,4 |
| 2,0 kn × 3 | −1,1 | −10,1 |
| 1,0 kn × 2 | +17,3 | −0,7 |

I fallet 2,0 kn × 3 visar texten "om 9, om 8" mot sann restid 19,1 och 18,1
min, "om 8" står kvar 12,5 min, och öppningskortet Klaffbron#3 (deadline) har
eta 8 mot sanningen 17,0 (före familj E: 19). Ingen "strax", ingen ändrad
notis och ingen ändrad varningstidpunkt. Samma rörelse utan målbyte
(buffertvägen) ger samma sak ("om 11, 12", "om 12, 10"), så familj E gör ingen
ny klass utan ställer holdvägen på samma fot. Klassen var inte mätt av F04.
Tidsviktat över kryp och väntan är felet 4,7 min efter familj E mot 8,3 före:
pessimism byts mot optimism, och den tydliga förlusten är kortets eta, en push
som står kvar och lovar för tidigt. Dagens storlek är låst i det informativa
scenariot "kryp-i-kön-efter-målbyte-och-ny-väntan" (förväntan `creepEta`: högst
11 min för optimistisk text, högst 10 min för optimistiskt kort), så att en
ändring som gör klassen större syns. Att göra den mindre hör till ETA-etappen
(U20/U22).

**Stilla båt utanför väntzonen ⇒ "ETA okänd" (U30, 2026-11-15).** Fältprovet,
körning 1, 12 nov 08:30–08:54Z: PRICKBJORN saktade in och låg stilla 460 m norr
om Stridsbergsbron med färsk AIS (passage fyra timmar senare). Farten 0 gav
fartgolvet 0,5 kn och rå-ETA 30 min; monotoniskyddet, absolutklampen och
tillväxtklampen höll ned värdet, idle-decayn (status `approaching`) tvingade
ned det till golvet avstånd / rask kanalfart = 3,7 min, och i K6:s andra pass
höll outlierfallbacken samma värde. "Om 4 minuter" blev en fixpunkt i 12,7 min.
När positionen inte ändrats på 10 min räknades ingen ETA (app.js
`positionFresh`), och när den räknades igen tömde gap-reseten historiken och
publiceringsklampen (RC4) trappade 9 → 12 → 16 → 21 → 27 → 28 innan U27 släppte
målbron. M9-principen ("inget rörelsevillkor i idle-decayn; äkta köares
nedräkning ska fortsätta, bara inte ned i strax-bandet", TIM 212571000) gäller
fortfarande för decayn, men golvet visade här en frusen undre gräns och ingen
nedräkning. Regeln är därför ett PUBLICERINGSLÄGE, inte ett rörelsevillkor i
decayn. `ProgressiveETACalculator._updateStillUnknown` håller reda på läget
`_stillUnknown`; kalkylatorn räknar och returnerar sitt värde som förut, och
`app.js` `_presentETA` publicerar null ("ETA okänd") medan läget står, medan
publiceringsklampens baslinje (`_etaPublishedValue`) uppdateras dolt. När
läget lämnas visas därför exakt det värde basen hade visat (granskningen av
`b9c581a`: efter en fartspik publicerades annars kalkylatorns värde oklampat,
okänd → 25).
*Inträde*, alla villkor: VesselDataService:s stillhetsklocka
(`vessel._stationarySince`) har gått minst 5 min; positionen har legat inom
50 m (`MOORING_DETECTION.MOVEMENT_PROOF_NET_M`) från samma punkt i minst 5 min,
hela tiden i status `approaching` mot samma målbro och utan kö vid en tidigare
bro (`_stillWatch`; `queueBridge` — där visar texten vänttexten); samplet är
under 0,5 kn; positionen är färsk och ren (`hasFreshPosition`, inget GPS-hopp);
ingen imminent-flagga; avståndet till målbron är större än
`STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE` (350 m).
*Utträde* ("tills hon rör sig"): en ren position minst 50 m från lägets
ankarpunkt (belagd rörelse, samma bevisklass som VesselDataService), eller
målbyte, annan status än `approaching`, eller imminent-flaggan. Ett
fartsampel utan förflyttning lämnar inte läget (granskningen, H2: med "ett
sampel ≥ 1 kn släpper" blinkade texten vid varje sampel efter 30 min stillhet),
och en krypare lämnar det efter 50 m (H1: förut stod hon som "ETA okänd" ända
in till "strax"). Ett nytt inträde kräver fem minuters stillhet på den nya
platsen. Notisvägens spärr (`targetETAHeld`) omfattar läget, så notisens ETA
byggs aldrig ur avstånd/fart medan texten säger "ETA okänd" — geometriskt kan
en notis (≤ 300 m) bara nås i läget om båten rört sig minst 50 m utan att det
belagts (GPS-misstänkta positioner), så spärren är försvar på djupet.
*När positionen blir gammal under läget* (L2): snapshotvägens åldersgrenar
armerar stationär-holden även när det publicerade värdet redan är null på grund
av läget (`app.js`, `etaShownOrStillUnknown`), exakt som på basen där värdet var
en siffra. Steg för steg: läget visar "ETA okänd"; efter 5 min utan ny position
(SOFT, fart < 1 kn) armeras holden och baslinjen nollas, som på basen (där
texten först nu blir "ETA okänd"); efter 10 min (HARD) samma; när hon hörs igen
svarar holden "ETA okänd" under 1 kn, och läget står kvar tills hon förflyttat
sig 50 m. Texten och notisen är alltså "ETA okänd" hela tiden; efter avgången
visas basens värden (prövat i två scenarier med 7 och 12 min tystnad).
*Öppningsvarningen påverkas inte, och skälet är geometriskt:* armen läser
`vessel.etaMinutes` (null i läget) och faller då tillbaka på avstånd/fart
(M7-grinden "en-prognos"), men deadlinen (avstånd / 10 kn − 180 s) har redan
passerat för alla avstånd ≤ 926 m, alltså i hela regelns zon 350–580 m, så
varningen har gått innan läget kan gå in.
*Hur länge står den stilla båten i texten?* Det styrs inte av U30. U27:s
köundantag (`_isInTargetQueueZone`) kräver aktivitet inom 20 min, och
`lastActiveTime` stämplas av ett enda fartsampel över 2,0 kn
(VesselDataService:5495) eller av belagd förflyttning ≥ 50 m; dessutom håller
manöverskyddet kvar målbron när kursen hoppar (k1-granskningens F4). En båt med
fast kurs och fartbrus ≤ 2 kn släpps efter 20 min; spikar över 2 kn minst var
20:e minut, eller slumpad kurs, håller henne kvar till tvåtimmarsgränsen.
Det är snävare än de två tillbakatagna rörelsevillkoren: fältprov 7 (`9c03238`,
"stationär + tom historik ⇒ null" utan armering, fällde 19h-korpusen och gav en
fatal oscillation) och J10b (färskhetsregel för fartgolvet, `measure:eta` 2,30
→ 2,38). Kvar: frysningen står i 5 min innan läget går in; sker ingen
beräkning mellan minut 5 och 10 av stillheten (gles sändare utan
positionsändring) går läget aldrig in; en båt som DRIVER långsamt (0,1–0,3 kn)
lämnar läget efter 50 m och kan gå in igen efter fem nya minuter, och däremellan
visas basens siffra. Ägarbeslut U30, mätning i docs/VALIDATION.md
§ETA-mätharnessen. Bara en position som är NYARE än lägets ankarpunkt (fixTs,
annars timestamp) är bevis för rörelse; ett sent AISHub-eko från före
ankarpunkten lämnar inte läget och flyttar inte stillhetsbevakningen
(omgranskningen 2026-11-16, L-A).
*Kända gränser (omgranskningen 2026-11-16):*
(1) **INV-18 räknar bara stigningsserier på högst 15 min.** "ETA okänd" kan
korta en serie som basen redan hade så att den syns i invarianten (granskarens
"gles 240 s": texten identisk med basen fram till 06:12:30, basens serie 5 → 30
tog 16 min). Det är ett verktygsfynd, inte en ändring i vad användaren ser.
(2) **En grupp med en stilla båt främst och en gående bakom:** texten går
"Två båtar … om 5" → "om 13" och räknar sedan ned efter den gående båten. Det
är ett synligt hopp uppåt, men rättare: den stilla båtens frusna siffra ersätts
(fel −6,7 → +2,3 min mot sanningen 10,7/12,0).
(3) **Siffran efter ett långt stopp är inte rättad av U30:** 45 min stilla och
sedan 8 kn ger "om 18–20" mot sanningen 1,4 min, lika på basen. Den kommer ur
kalkylatorns historik, inte ur den dolda publiceringsbaslinjen; uppföljning i
ETA-etappen (avgångskontext efter långt stopp).
(4) **Långsam drift 0,1–0,3 kn** växlar mellan "ETA okänd" och basens siffra,
med minst fem minuter mellan inträdena. Beteendet står kvar tills ägaren
säger annat.

Till familj E2 (användarbeslut U20, 2026-11-04): ETA-oscillationen vid
inbromsning (buggjägarens F06, K6:s dubbla EMA mot den binära
3-minutersgränsen) och 21h-knivseggen (F07, RC4-clampen mot en extrapolerad
baslinje). E2 gör om ETA-utjämningen och spärren ovanpå F04-rättningen och
mäter om E:s sex omlåsta rader och M9/V4-utfallet, eftersom PRIMA LADYs och
SKONNERTENs värden beror på den dubbla EMA:n.

**F02 gick in (ETA-etappen under ägarbeslutet U28, 2026-11-16): inbromsningen
nära bron.** Buggjägarens kort F02 (standardkörningen 2026-11-14) är triagens
F06 ovan. XENIA (värld 192) bromsar från 4,5 till 1,1 kn cirka 340 m före
Klaffbron. Fartbufferten (tre sampel) bär fortfarande anloppsfarten, rå-ETA:n
på medelfarten lovar strax (2,9) och EMA:n för värdet till 2,99. Texten sa
"strax" 9,9 min före korsningen, sedan "om 4" när medelfarten hann ikapp och
"strax" igen när imminent-flaggan (300 m) tog över.
- *Regeln* (`ProgressiveETACalculator._processETAWithProtection`, efter
  M9-hållningen och före historiken): det PUBLICERADE värdet hålls på
  strax-tröskeln (3 min) när medelfarten ENSAM lovar strax. Alla villkor:
  ett nytt inträde i strax (värdet som publicerades för föregående FIX ≥ 3,
  det nya < 3),
  samplets egen mätning < 3, medelfarten minst `DECEL_HOLD_MIN_RATIO` (1,2)
  gånger momentanfarten (golv 0,5 kn), momentanfartens ETA minst
  `DECEL_HOLD_MIN_INSTANT_ETA_MINUTES` (3,5 min), och båten utanför
  imminent-radien: flaggan av OCH avståndet till målbron över
  `APPROACH_RADIUS` (300 m).
- *Varför avståndet prövas direkt* (granskningen av C-decel, H1): Fix H
  skriver imminent-flaggan senare i svepet än ETA:n räknas (samma
  svepfördröjning som idle-decayns golv beskriver), så på första fixet
  innanför 300 m var flaggan falsk och regeln höll ändå. Texten skyddades av
  att flaggan sattes senare i samma svep, men målbronotisen (300 m, byggd på
  första passets värde) bar "om 3" medan texten sa strax. Banken hade fem
  sådana dolda träffar på 205–278 m; granskarens rutnät 180 av 364
  hållningar. Hysteresen (350 m medan flaggan står) täcks av flaggprovet.
- *Hållningen gäller bara publiceringen* (granskningen, M1): historiken bär
  det OHÅLLNA värdet (`processedETA`), så att EMA:n och skydden i nästa
  sampel räknar som om regeln inte hade hållit; det hållna 3 sparas i
  `decelHeldETA` och läses bara av villkoret "nytt inträde", så att andra
  passet på samma fix (K6) håller igen. Med det hållna 3 i historiken drog
  hållningen nästa värde uppåt när båten gasade igen, och målbronotisen
  kunde gå 2 → 3 (fem sämre notiser i granskarens rutnät, sanning 1,3–1,8
  min).
- *Varför föregående fix, inte föregående pass* (prövat 2026-11-16 i samspelet
  med U30): för en båt som stannat 300–350 m före bron kan första passet på
  ett fix nudda 3,0 när EMA:n klättrar, fast texten (andra passet) säger
  strax hela tiden. Med förra passet som jämförelse gav regeln då strax →
  om 3 → strax. Föregående fix är den senaste historikposten från ett
  annat sampel (`sampleKeyOf`: position, fart, kurs). Sänder en
  stillastående båt identiska ramar letar villkoret sig förbi dem tillbaka
  till den sista fixen med ett annat sampel (i praktiken den sista rörliga),
  så beslutet blir detsamma på varje identisk ram som på den första; finns
  ingen sådan post håller regeln inte.
- *Varför villkoren ser ut så:* det är E2:s inbromsningsregel (U20) med
  E2-revisionens marginaler. Nytt inträde: en redan given strax lyftes annars
  till "om 3" (RUNA, quick-värld 286). Kvoten och marginalen: utan dem höll
  regeln 44 gånger i banken och gjorde fem uppfyllda strax till "om 3"
  (NORDIC SOLA 19h 06:17:48: 4,6 → 4,1 kn, 2,8 min på snittet och 3,0 på
  momentanfarten, korsade 2,8 min senare). E2 som helhet integrerades inte
  (U22), eftersom K6-steget i den gjorde 45 påståenden sämre; regeln här står
  för sig på dagens tvåpasskedja.
- *Prövat och förkastat (C-hyst, 2026-11-15):* hysteres i publiceringen, så att
  texten lämnar strax först vid 4 min. Den tog bort växlingen men höll kvar
  XENIA:s för tidiga strax och gav nio fler ouppfyllda strax i banken
  (strax-löftet 63,0 → 62,3 %).
- *Rörs inte:* imminent-flaggan och dess 300/350 m (regeln läser dem bara och
  håller aldrig innanför 300 m), U16 och F40-studsen. Regeln läser inte
  positionens ålder och kan bara hålla ETA:n uppe, aldrig ge strax;
  åldersgrinden (Fix G och `BridgeTextService.hasFreshPosition`) är orörd.
- *Notiser och kort:* målbronotisen byggs inom 300 m, där regeln inte håller,
  och nästa sampel räknar från det ohållna värdet. I banken och i
  granskarens rutnät (450 + 144 båtar och 54 konvojer) ändras ingen notis och
  ingen öppningsvarning.
- *Utfallet:* XENIA-formen ger "om 3", "om 4" och strax först vid imminent
  (inom 300 m), utan den för tidiga strax och utan strax → om 4 → strax.
  Kvar står ett steg 3 → 4 innan medelfarten hunnit ikapp. I granskarens
  rutnät går oscillationerna strax → om N → strax från 34 till 2; de två
  kvarvarande (8 kn, fix var 90 s, kö eller kryp 400 m före) finns också i
  basen, och regelns strax kommer där 1,5 min senare. Mätningen och de två
  flyttade raderna står i VALIDATION "### F02, 2026-11-16".
- *Priset (till ägaren enligt U28):* MALUCA, 20260712-25h 07:42:16, bromsade
  verkligen in vid bron (5,5 → 1,3 kn, 320 m söder om Klaffbron) och korsade
  2,8 min senare. Hennes uppfyllda strax blir "om 3" (fel +0,2). Klassen är
  större än raden: en båt som bromsar kort utanför 300 m och sedan går
  igenom får sin strax ett fix senare (granskarens rutnät: i snitt 1,3 min
  vid fix var 30–90 s, 2,1 min vid 120–180 s; i tre fall vid 180 s kom strax
  aldrig, "om 3" mot sanningen 2,8–3,0 min).
- *Samspel med U30:* "ETA okänd" gäller en bevisat stilla båt mer än 350 m
  från målbron och avgörs av presentationen i app.js. Regeln kan inte slå
  till på en sådan båt (bufferten nära 0, mätningen långt över 3), men de
  kan följa på varandra: en båt som bromsar 454 m före bron och står still
  418 m före får först regelns "om 3" (basen: strax), sedan stigande värden
  och efter 5 min U30:s "ETA okänd", utan blink (`f02-stannar`).
  Regeln avfyras inte efter M9-hållningen, eftersom det hållna värdet redan
  är 3.
- Regressionstest: `tests/f02-inbromsning-nara-bron.test.js` (enhetsfall för
  varje delvillkor åt båda håll, hela kedjan för XENIA-formen, sju motfall
  låsta mot basen och tre utfall låsta med regeln — notisfallet ur
  granskarens rutnät, samspelet med U30 och XENIA med U30 inne —
  `tests/fixtures/f02-*.jsonl`).

**U33 gick in (F20, 2026-11-16): målbronotisen följer brotextens "strax".**
Notisen för målbron byggs på fixets första ETA-beräkning (K25) och brotexten
på den andra, 25 ms senare i `_reevaluateVesselStatuses`, där Fix H också
sätter imminent-flaggan (300 m, 350 m med hysteres). Notisradien är samma
300 m. Notisen avrundade därför sin utjämnade siffra (2,5–2,99 → 3, 3,5 → 4)
i samma ögonblick som texten bytte till "strax": NINA BRES, LIDAN och SYLVIA
i fältkörning 3 (båtarna korsade 1,6–2,9 min senare); 94 sådana motsägelser i
banken och 9 i k1–k2.
- *Regeln* (`_triggerBoatNearFlowForBridge`, efter FLOW_TRIGGER_ETA_CAP;
  `_noticeStraxTravelMinutes`): notisen hade sagt 3 eller mer, båten når bron
  inom `NOTICE_STRAX_REACH_MINUTES` (3 min) i sin fart (avstånd/fart), hon
  bromsar inte in, och texten kommer att säga "strax" för just henne ⇒
  notisen säger restiden avstånd/fart, avrundad som alla notiser, minst
  `NOTICE_STRAX_MIN_MINUTES` (1) och aldrig mer än den annars hade sagt.
  Bara siffran ändras: inte notisens tidpunkt, texten, öppningsvarningen,
  båtens ETA eller flaggor. `eta_minutes` och `message` bär samma siffra.
- *Preciserat efter granskningen: restiden, inte ett tak på "om 2".* Den
  första versionen sa alltid "om 2". "Strax" betyder inom 300 m, och 300 m i
  3,5 kn tar 2,8 min, så taket gjorde notisen sämre när sanningen låg på
  2,5–3 min (WILSON ALSTER 16h, 3 → 2 mot 2,6). Restiden ger lägre medelfel i
  banken och i ett svep över 225 slumpade världar, och färre sämre notiser i
  svepet (siffrorna i VALIDATION "### U33"). Priset: när restiden avrundas
  till 3 säger notisen "om 3" medan texten säger "strax" (LIDAN, 2,95 min,
  korsade 2,91 min senare).
- *Regeln på ett ställe.* Notisen kopierar inget av textens villkor. Fix H:s
  beslut är en ren funktion, `_imminentVerdict`, som omvärderingen verkställer
  (flaggan, `_imminentFromExhausted`, loggraden) och notisen frågar. Textens
  per-båt-regel är `BridgeTextService.vesselSaysStrax`, byggd av samma delar
  som `_buildGroupPhrase`/`_targetGroups`: kö vid målbron räknas som imminent
  (`_asQueuedAtTarget`), närvaron (`_drivesStraxByPresence`: imminent eller
  under målbron, färsk position, ingen zombie) och klausulen själv
  (`formatETABroOpeningClause`: under 3 min för en färsk siffra, aldrig för en
  extrapolerad). Frågan ställs med båtens egen siffra (`vessel.etaMinutes`,
  den texten bygger på), inte notisens: notisens kan vara sänkt av
  FLOW_TRIGGER_ETA_CAP, och då förutsade regeln "strax" för en båt vars text
  sa "om 8 minuter" (granskningen: osäker position efter ett glapp, där
  echo-hållningen låter flaggan vara falsk). Inbromsningen mäts som i U31
  (`ProgressiveETACalculator.isBraking`, samma kvot `DECEL_HOLD_MIN_RATIO`
  via `_decelerationRatio`). Refaktoreringen är bitlik i hela banken.
- *Den uttömda grenen räknas inte för notisen* (`forNotice`): notisen byggs
  innan omvärderingens ETA-block har nollat `_etaExtrapolationExhausted` för
  det nya fixet. Felriktningen är medveten: regeln svarar då "inte strax" och
  notisen behåller sin siffra.
- *Bara samma båt.* En annan båts "strax" i gruppen ändrar inte notisen
  (EUGENIE both-21h, källa 'current', och båtar som notifieras utanför 300 m
  medan en annan båt är imminent). Mellanbroarnas notiser rörs inte (källan
  är inte 'target'). Väntan ("inväntar broöppning") och "ETA okänd" (U30)
  saknar siffra och påverkas inte.
- *Fartvillkoret och inbromsningen* (ägarens variant "tak med fart", F20 (c),
  med dirigentens tillägg om inbromsning): en båt som saktar in mot en kö
  (inom 300 m men i 0,5–2 kn) behåller sin siffra, och likaså en båt som
  bromsar in: i banken väntade eller saktade AIR, CAVAT och ELFKUNGEN 31h
  vidare efter notisen (sanning 10,5, 45,6 och 3,0 min). Villkoren kan bara
  lämna notisen som före U33.
- *Priset* (U28; mätningen i VALIDATION "### U33, 2026-11-16"): texten säger
  "strax" även när båten inte når bron inom 3 min (HELGE 14h, sanning 3,8;
  CAVA 19h, 3,6), och då följer notisen restiden, som underskattar. WILSON
  ALSTER (restid 2,40, sanning 2,56) blir "om 2" också med restiden.
- *Kvar:* motsägelsen står kvar där fart- eller inbromsningsvillkoret
  spärrar (en båt som kryper inom 300 m), där en annan båt driver strax, där
  restiden avrundas till 3, och där andra passets siffra går under 3 utan att
  första gör det.
- *Kända gränser (granskningens andra varv):* (1) restiden bygger på farten i
  notisens position, så en ensam fartspik där ger "om 1" när båten behöver
  cirka 2,8 min (7 av 27 konstruerade spikfall, 0 i banken och fältet). Ett
  skydd kräver farten räknad ur positionerna; de två prövade skydden ändrade
  också verkliga accelerationer ur väntan (NORDIC SOLA i fältkörning 1) eller
  tappade LIDAN. (2) Korta restider avrundas till "om 1" och blir ofta för
  låga: SYLVIA "om 1" mot sanningen 1,57, och i granskningens svep hade 11 av
  59 "om 1" en sanning över 2 min. (3) En båt som stannar tvärt efter notisen
  får "om 1" eller "om 2" mot 5–22 min; det är samma klass som HELGE och CAVA.
- Regressionstest: `tests/u33-notis-foljer-strax.test.js` (fallen och
  motfallen, rutnätet som låser att `vesselSaysStrax` svarar som brotexten,
  och granskningens glappfall genom hela appen, `tests/fixtures/u33-osaker-glapp.jsonl`),
  testet "U33: Klaffbronotisen säger restiden …" i
  `tests/november14-field-corpus.test.js` (NINA BRES, LIDAN, SYLVIA mot
  rådatan) och de syntetiska scenarierna `notis-följer-strax-nord/syd (U33)`
  och `notis-behåller-siffran-långsam (U33)`.

**F07 gick in (ETA-etappen under ägarbeslutet U28, 2026-11-15): klampen
försvarar det användaren ser.** Buggjägarens kort
F03 (standardkörningen 2026-11-14) är 21h-knivseggen ovan, i fasvarianten
δ −11,52 s. Kedjan:
- Fix G (`_reevaluateVesselStatuses`, extrapoleringen i SOFT-zonen)
  registrerar varje extrapolering som publicerad baslinje (`_etaPublishedValue`),
  även för en båt som inte leder sin målbros grupp och vars siffra alltså inte
  syns i brotexten.
- AVALON 219009353 mätte 30,3 min på sitt första fix (1,7 kn) medan JAATTEN II
  ledde Klaffbrongruppen. Fix G räknade ned det osedda värdet till 25,3.
- Hennes färska 13,4 och 11,9 min klampades av RC4 (`_reconcilePublishedETA`,
  maxDelta = max(3, glapp + 0,25 · bas)) till 18,9.
- När JAATTEN:s position blev 600 s gammal tog AVALON över texten: "om cirka
  13" → "om 19 minuter", mot sanningen 4,5 min. Hoppet är INV-3:s sågtand; i
  bankens egen fas blir det 13 → 18, som är låst i golden-text.

**Principen: klampen försvarar det användaren ser** (granskningen av första
versionen och dirigentens beslut 2026-11-15). RC4 finns för att texten inte ska
hoppa, och för en båt som inte är den brotexten visar är hennes egen baslinje
inget användaren har sett. I `_reconcilePublishedETA` gäller därför, för
varje baslinje — Fix G:s extrapolering lika väl som en uppmätt (R7) — när
texten visar en annan båt med lägre giltig ETA (`_presentedGroupLead`:
brotextens eget val, `BridgeTextService.presentedLead`, över det som
presenteras — `_processingRemoval` och GPS-hållningen filtreras som i
publiceringen, köer vid en tidigare bro och zombier leder inte):
- Ligger den färska beräkningen ÖVER det visade värdet förblir båten osedd.
  Baslinjen följer den färska, och texten är oförändrad.
- Ligger den UNDER det visade värdet dämpas hon mot brogruppens gemensamma
  referens (`_unseenGroupReference`). Fönstret är RC4:s 30 s. Basen är det
  visade ledarvärdet när den första sänkningen i fönstret skedde — det senast
  RENDERADE (`_rememberRenderedLeads`; det gäller tills nästa rendering för
  bron ersätter det, dock högst två fönster, eftersom UI-ticken har samma
  period som fönstret och renderingen vid tickgränsen ofta är 30,0x s gammal),
  annars det levande. Golvet är det högsta av två:
  - fönstrets golv, bas − max(3, 0,25 · bas);
  - golvet för det värde som visas NU (det högsta av levande och renderat),
    nu − max(3, 0,25 · nu).
  Alla osedda båtar som sänker samma bro inom fönstret dämpas mot samma golv,
  och båtens burstbas sätts så att andra passet (K6) landar på samma golv.
  Flera osedda båtar kan alltså tillsammans inte sänka texten mer än en ensam
  båt hade kunnat — vare sig från värdet när fönstret öppnades eller från det
  som visas nu. Granskningarnas fall:
  - två båtar 1 s isär gav "om 11" och sedan "om 8" mot det visade 14,6 (A);
  - det visade värdet steg inom fönstret (8 → 18 när ledaren lämnat gruppen),
    och nästa osedda båt fick sänka 18 → 9 mot den gamla basen; nu 13,5 (G1);
  - i samma tick som ledarens eget fix (renderat 15, ledaren själv → 12)
    öppnades fönstret på det levande 12 och den osedda båten fick 9, så texten
    gick 15 → 9 på ett tick; nu är basen det renderade 15 och golvet 11,25
    (G2).

  *Godtagen avvägning (granskning 4):* sjunker ledaren SJÄLV inom fönstret
  (till exempel 15 → 9) håller fönstrets golv 11,25 den osedda båten dold,
  fast en ensam båt som visar 9 hade fått gå till 6. Golvet kan alltså bli
  högre än för en ensam båt med det nu visade värdet, aldrig lägre — det
  pessimistiska hållet. Det varar högst fönstret ut (30 s).
- Men bara om fixet går ihop med båtens egen rörelse (`_fixKinematics`):
  förflyttningen sedan förra fixet (fixtiderna, `_prevFixSample` i
  VesselDataService) delad med den största fart båten rapporterade i de två
  ändarna får vara högst `ETA_UNSEEN_BASELINE.FIX_KINEMATICS_MAX_RATIO` (1,35),
  och fixet får inte vara GPS-misstänkt. Annars gäller klampen som förut.

*Varför rimlighetsprovet finns:* granskningens `gps700` — en klass B-båt bakom
ledaren vars första fix efter ett glapp ligger 700 m för långt fram — hade
annars sänkt texten till "om 10" mot sanningen 14. Bekräftelse med två fix
prövades först och föll: klass B-båtar har för få fix, och AVALON har bara två
före sin passage. Kvoterna där sänkningen binder: AVALON 0,86, accstop 0,95,
bankens enda fall 1,05, gps400 1,66, gps700 2,16. Över alla 9 920 fix efter
ett glapp på minst 180 s i banken och k1–k3 ligger 20 (0,20 %) över 1,35,
nästan alla båtar som rapporterar låg fart i båda ändarna men har rört sig
emellan; för dem gäller basens klamp.

*Utfall:* F03:s fasvariant visar "om 13" från 07:07:02 i stället för "om 19"
07:11:30 (varje rad närmare sanningen än basen). gps700, gps400 och spik1 ger
basens texter. accstop (båten accelererade under glappet och stannade sedan)
sjunker 14,6 → 11,0 på ett fix, inom maxDelta 3,65. Banken och k1–k3 är
oförändrade (VALIDATION.md "F07, 2026-11-15").

*Redovisad avvägning (`accstop`):* en båt som accelererade under glappet och
sedan stannar sänker texten 14,6 → 11,0 (sanningen 14) och vid nästa fix till
7 (basen 9, sanningen 13). Det är i sak samma utfall som en ensam båt får med
samma fix — klampen begränsar steget, rimlighetsprovet godkänner fixet — och
inte ett fel i den här regeln.

*Känd gräns ("strax"):* visar ledaren 5,0 och en osedd båt har färska 1,0
med rimligt fix dämpas hon till 2,0, och texten säger "strax". Det är inom
maxDelta från det visade och samma utfall som en ensam båt får, men det är en
ny väg till "strax" som bara vilar på rimlighetsprovet (granskning 2, Q4).
Ingen extra spärr: inget fall i banken, fältet eller granskningens scenarier
ger "strax" för en båt som är mer än ett par minuter bort.

*R7 (2026-11-16): regeln gäller även uppmätta baslinjer.* Steget gick in för
sig efter granskning 3. I bankens egen fas av 21h klampades AVALON:s uppmätta
30,3 från första fixet, och texten sa "om 18" 07:11:30 mot sanningen 4,5 (låst
golden). Med R7 visar texten "om 13" från 07:07:13 och "om 18" försvinner.
`measure:eta` mot `eta-bas`: 8 ändrade parade påståenden, 4 bättre, 0 sämre,
4 omätta (alla fyra rättare mot rådatan, se VALIDATION "### F07 R7"). Kvar
står fönstret där ett lågt men osett värde över det visade blir båtens
baslinje; det syns först om ledaren försvinner före båtens nästa fix.
*Godtagen avvägning L1 (dirigenten 2026-11-16).* I de syntetiska fixturerna
`f07-dubbel` och `f07-trippel` visar texten 10:08:01 "om 6" i 60 s i stället för
F07:s "om 7" (sanning 13,0 min), följt av ett synligt steg 6 → 7. Den tredje
båtens baslinje är uppmätt sedan förra fixet och osedd. R7 gäller henne, så ett
nytt gruppfönster öppnas på det renderade 7 med golvet 4. Kvotprovet fångar
bara fix som rört sig för fort, inte en båt som stannat. Godtaget eftersom
scenariot är konstruerat, texten redan ligger 6 min fel där på F07, och banken
får 20 rättare rader och ingen sämre. Utfallen är låsta i
`tests/fixtures/f07-{dubbel,trippel,dubbel20}.expected.json`.
Den första versionen (släpp varje osedd extrapolerad baslinje fritt) återtogs:
den gjorde gps700 och accstop 4–8 min för optimistiska, och dess hjälpare
läste inte presentationslistan (P1), släppte en uppmätt baslinje i andra passet
(P2) och en tidigare visad baslinje (P3). En oavgränsad variant (alla
extrapolerade baslinjer) gjorde SISU och IDUN sämre mot inferred-sanningen.
Regressionstest: `tests/f07-oseedd-extrapolerad-baslinje.test.js`.

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
inte gjord om), utom i ett fall: när en annan båt har använt öppningen (U45,
`_releaseForeignPassageMembers`, med kraven (1)–(4) och ett lägesvillkor). Buggjägarens kort F02, F03, F11, F14, F17, F20, F22, F23 och F01
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
  position att hon inte har det, släpps hon som förut. **U49 (dirigentens
  beslut i omgång 4, genomfört i omgång 5):** från `MOVING_SOG_KN` (2 kn) är ankomsten den
  tidigare av appens prognos och armens fysik (`physicsArrivalMs`, avstånd
  genom fart ur samma fix). Appens ETA nära bron är pessimistisk (utliggar-
  skyddet och utjämningen lyfter 0,3 min till 1,3 min), och prognosen ensam
  fällde hållet med 0,5–3,4 s i nattjaktens världar 8814 (43 m i 4,5 kn) och
  18489 (24 m i 5,7 kn), som varnades 58 och 73 s efter passagen. Kravet att
  ankomsten ligger inom täckningen står kvar, för det gör att hållet bara
  varar till nästa fix (ett fix efter täckningsslutet har ankomsten efter
  slutet). Mätt och avvisat: att ta bort kravet, som beslutets ordalydelse
  säger. Då förnyas hållet på varje fix inom 50 m i minst 0,5 kn, och en
  krypare som korsar efter täckningsslutet eller en väntande båt med brusfart
  vid linjen får ingen varning. Under 2 kn gäller prognosen som förut (ETA-
  kedjans golv lägger den före fysiken). **Känd kostnad (U49, bekräftad av
  dirigenten i omgång 5):** en båt som setts i minst 2 kn högst 50 m före bron
  och som sedan stannar och aldrig hörs mer får ingen öppningsvarning för den
  bron. Hörs hon igen varnas hon på det fixet, ett fixintervall senare än
  förut. Mätt: i bankens 27 korpusfiler och fältkörningarna k1–k3 finns 90
  episoder där en båt setts i minst 2 kn med kurs mot Klaffbron eller
  Stridsbergsbron högst 50 m före bron (94 från 0,5 kn). Alla 90 korsade, ingen
  tystnade före bron, och en stannade (lotsbåten i k1 vid Klaffbron, 40 m i
  3,6 kn, stilla 79 s med fix emellan, korsade efter 250 s): 0 av 90 hade
  tappat sin varning. I granskningens band av byggda världar kring brolinjen
  (864 världar vid Stridsbergsbron söderut) blev 1 sådan, och där kom
  kedjevarningen för nästa bro ändå. **Känd gräns, systerstället vid
  bakkanten (omgång 5, rörs inte):** före täckningsslutet jämför bakkanten
  appens prognos (över 2,5 kn) med fönstrets slut, och samma för höga restid
  nära bron kan släppa en följare som ligger vid linjen. Granskningens prov:
  ledarens passage bokförd, följaren 43 m före bron i 4,5 kn med prognosen 3 s
  efter fönstrets slut och fysiken 57 s före; hon får ett eget kort 18,6 s före
  korsningen med ett omedelbart fix, men 20,4 s efter korsningen med ett 39 s
  gammalt AISHub-fix. Utfallet är detsamma före och efter U49, och fallet är
  inte sett i banken eller i k1–k3. Hållet läser inte
  U45:s fält (en annan båts passage): U45:s dom gäller före täckningsslutet och
  utanför väntzonen. En U45-släppt båt i hållet behåller `foreignReleasedFrom`
  tills hon passerar eller släpps vid täckningsslutet, som nollar flaggan.
- **(3)** Utan finit ankomstfysik släpps hon inte (hängslen: `_canArm` kräver ett
  finit avstånd, så ingen arm i drift når grenen). **(4)** gäller bakkanten: den
  släpper på ett färskt, rent fix efter den första passagen, och deadlinen
  räknas ur det fixet (F02, F17, F22, F01:s r2). Färskheten **(2)** mäts sedan
  varv 2 (familj B, M4) mot den skattade korsningen (`firstPassageAt`), inte mot
  bokföringen: bokfördes ledarens passage sent och tystnade följaren mellan
  korsningen och bokföringen, fick bakkanten förut aldrig döma, och följaren
  släpptes först vid täckningsslutet, efter sin korsning (buggjägarens världar
  1094 och 1476). Saknas skattningen är `firstPassageAt` bokföringstiden och
  villkoret detsamma som förut. Vid täckningsslut
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
- **Nya båtar prövas mot den tidigaste bokförda korsningen** (nattjaktens F02 r3
  och F23 r2, 2026-11-16; dirigentens val av den enkla varianten efter två
  granskningsvarv). Händelsens första passage är den först BOKFÖRDA. Korsade två
  medlemmar osedda och bokfördes i omvänd ordning, svalde fönstret nästa
  öppning: i värld 11777 korsar PELLE Klaffbron 16:26:10 och FREJA 16:30:55 under
  ett avbrott, FREJA bokförs först, och HAVSORN 2 hörs 16:34:14 och korsar
  16:40:24 utan egen varning. Händelsen minns nu sin tidigaste bokförda
  korsning (`earliestCrossingAt`, satt bara när en senare bokföring korsade
  tidigare, och bara bakåt; `OPENING_PASSAGE_EARLIER`). I `_belongsToEvent`
  räknas en båt inte till händelsen när hon har minst 2 × `TICK_INTERVAL_MS`
  kvar och hennes ankomst ligger mer än `CONVOY_WINDOW_MS` från den tidigaste
  korsningen. Hon får då en egen händelse och en egen varning som hinner göra
  nytta. Med under två tick kvar gäller referensen som förut, så ingen båt
  hamnar mellan medlemskapet och korsningsankarets golv. Villkoret prövas bara
  när en LÖS båt binds. `firstPassageAt`, referensen, bakkanten, golven, U15,
  täckningsslutet och domspåret är oförändrade. En tidigare version flyttade
  `firstPassageAt` bakåt; den gav i granskningen senare eller uteblivna
  varningar där den flyttade referensen mötte golven och U15 och lämnades.
  **Känd begränsning 1:** en båt som redan absorberats innan den tidigare
  korsningen bokfördes släpps inte av den (som före rättningen); hon släpps av
  bakkanten mot det gamla fönstret eller vid täckningsslutet.
  **Följdfall, ingen försämring:** får en ny båt X en egen händelse genom
  villkoret kan en senare båt C bindas i X:s händelse. Stannar C sedan och
  korsar mer än ett konvojfönster efter X, släpper bakkanten henne mot X:s
  fönster (i det konstruerade svepet 46–286 s före korsningen, 48 av 345 lägen,
  alla med 600 s stopp). Det är samma utfall som koden före rättningen ger för
  samma trafik när bokföringarna kommer i rätt ordning: 345 av 345 lägen är
  lika, varning för varning (granskningen av K2, tredje varvet). Före
  rättningen varnades C tidigare bara därför att felordningen höll X kvar i
  den gamla händelsen. Korsar C inom fönstret efter X täcks hon av X:s varning
  (U2). Beslut U42 (2026-11-16) godtar följdfallet.
  **Känd kostnad:** en för tidig skattning av den tidigare korsningen (rät
  linje över ett glapp där båten saktade in osedd) kan ge en ny båt som enligt
  U2 hör till öppningen en andra varning; före rättningen hände det bara när
  den båten bokfördes först. Testen ligger i
  `tests/k2-tidigaste-korsningen.test.js` och två syntetiska scenarier
  (`omvänd-bokföring-efter-avbrott-vid-Klaffbron`).
- **En annan båts passage använder den varnade öppningen** (beslut U45, omgång 4,
  registerposten J13-J14-KONVOJSEMANTIK). I 20260707-14h varnar Klaffbron#15 för
  BEAUTYFIELD 11:01:34 medan hon ligger 1,4 km norr om bron. HELGE, med egen
  händelse, korsar Klaffbron norrut 11:18:08, och BEAUTYFIELD korsar 11:35:10
  utan ny varning (likadant DELFIN i 20260710-13h och JOY i 20260713-41h). Alla
  tre var MEDLEMMAR vid avfyrningen, inte absorberade. Regeln: den första
  bokförda passagen vid bron av en beväpnad båt som inte hör till händelsen,
  efter varningen (`crossedAt > firedAt`), i en avfyrad händelse vars kort gick
  ut och som saknar egen passage, sparas i egna fält (`foreignPassageAt`,
  `foreignPassageMmsi`; `_noteForeignPassage`; bokföringstiden står i loggraden).
  `firstPassageAt`, referensen, bokföringen och täckningsslutet rörs aldrig, och
  när en egen passage bokförs gäller den som förut (en första version som satte
  `firstPassageAt` flyttade den låsta raden 20260712-25h 265806230 08:37:18 →
  08:36:19: NICOLINE bokfördes före MALUCA, som korsade först). Domen
  `_foreignPassageVerdict` släpper en båt bara när appen i samma ögonblick hade
  varnat henne som en ny båt (dirigentens precisering av U45, varv 2): på HENNES
  EGET fix, tillämpat i utvärderingen och mottaget efter att fönstret max(varningen,
  passagens korsning) + `CONVOY_WINDOW_MS` har löpt ut (för en absorberad arm det
  tidigare av det och täckningsslutet); fixet rent och efter passagens korsning,
  bron inte bakom, utanför väntzonen (U24 (c)), minst 2 kn (`MOVING_SOG_KN`, som
  U46 och U48) med fysikankomst, ingen spärr vid en tidigare bro, ankomst efter
  fönstrets slut, minst två tick kvar och kursen inte bort. Ett tick eller en annan
  båts fix släpper aldrig, så utfallet beror inte på tickens fas. Varför varje grind
  finns: att släppa på en prognos bortom fönstret, som bakkanten efter en egen
  passage gör, gav i U45-svepet i omgång 4 (7 344 lägen) 134 andra varningar i samma
  öppning för båtar som kröp och sedan ökade; ett släpp på tick efter fönstret gav
  buggjägaren ett fasberoende i 20260711-16h och en varning 8 s efter passagen på ett
  fix från före en tystnad; ett släpp under spärren vid en tidigare bro gav varningar
  17 och 54 s före korsningen; 0,5 kn som rörelsegräns släppte båtar som drev långt
  ute och aldrig kom. Den gäller (a) en absorberad arm, före U24 i `_coverageVerdict` (släpper
  den inte gäller U24 och täckningsslutet som förut); (b) en varnad medlem, i en
  egen släppväg (`_releaseForeignPassageMembers`), som annars saknas (H29).
  Medlemmen släpps bara på domen, aldrig vid täckningsslutet, och `_fire` lägger
  hennes mmsi i `reopenedMmsis` så att appen släpper den gamla ankomstens
  dedupspärr (som vid egen passage, J15); utan det hade kortet tystats som samma
  ankomst. (c) En ny båt med minst två tick kvar hör inte till händelsen när
  hon kommer mer än `CONVOY_WINDOW_MS` efter passagen (`_belongsToEvent`, bara
  nej). `foreignReleasedFrom` följer med när en släppt båt absorberas i en annan
  händelse; ett släpp vid täckningsslutet (U17) nollar den (varv 3), annars hade
  säkerhetsvarningen för en tyst båt öppnat den gamla dedupspärren och nått
  användaren efter passagen (ANTARES 11:44:44 i 20260710-13h). Mätt i banken
  (25 korpusar, k1, k2): 469 → 479 varningar, k1 och k2 bitlika. Del 1–2
  (släppen) ger 478, del 3 (`_belongsToEvent`) ensam ändringen i 20260707-14h
  (HERA II binds inte i KINN:s händelse och varnas själv; LYS får U17:s varning
  ur HERA II:s händelse). Tre verkliga öppningar som förut var ovarnade får en
  varning 8–10 min före (DELFIN med ANTARES, JOY med SEEBAER III, ALINDE), och
  HEY JOE (516 s) är en vinst om den andra båtens inferrerade korsning ligger
  efter basens senaste varning. BEAUTYFIELD och MAJALISA får ingen: ingen av dem
  har något eget fix efter fönstrets slut utanför väntzonen (BEAUTYFIELD:s enda
  ligger 140 m från bron, 79 s före korsningen; HALIFAX:s passage bokfördes först
  efter MAJALISA:s enda fix). Att ta dem kräver släpp på tick eller prognos,
  alltså första versionens fel. Kostnaden är tre varningar för båtar som gick
  minst 2 kn mot bron och sedan lade till 330–490 m ute (CALIMA, PILGRIM, DORY
  MAN) och ett sant men dubbelt kort i samma öppning (ELIZABETH GREENWOOD, F09).
  **Kända gränser:** en medlem som köar inom väntzonen när bron öppnar för en
  annan båt släpps inte (TIM i 20260804-both-21h gick in 445 s efter MS JUTLAND
  utan att behöva en ny öppning; utan kögrinden fick hon en andra varning). En
  tyst medlem står kvar. En armlös passage räknas inte (J14). Inget sparas över
  omstart; en omstart mellan passagen och släppet ger ingen ny varning
  (dedupspärren står kvar). Den nya varningen kommer på medlemmens vanliga
  deadline ur det senaste fixet. En medlem som hålls av en tidigare bros spärr
  tills hon är inne i väntzonen, eller som aldrig gör 2 kn utanför den, släpps
  inte (BEAUTYFIELD). En släppt båt som hölls vid en tidigare bro när en annan
  händelse varnade binds inte i den (F09) och kan få en egen varning för samma
  öppning: ELIZABETH GREENWOOD i both-21h, 89 s efter CHARLYS DREAM:s, och i
  granskningens byggda konvojer genom Järnvägsbron 64 av 180 båtfall. På basen
  kunde det inte hända, eftersom hon stod kvar i sin gamla händelse. Ett enda
  fix med falsk fart på minst 2 kn kan släppa en stilla båt utanför väntzonen
  (4 av 24 byggda världar 400 m från bron); ett krav på minskat avstånd sedan
  förra fixet tog inte bort dem (armen hade inte tillämpat krypfixen emellan)
  och kostade vinster, så det är inte infört. En släppt och absorberad båt som
  bakkanten sedan släpper nära bron (utan golv) får sitt kort, eftersom flaggan
  öppnar dedupspärren (1 av 594 byggda världar, 15 s ledtid); den korta
  ledtiden är bakkantens.
  Testen ligger i `tests/u45-annan-bats-passage.test.js`,
  `tests/u45-dedup-app.test.js` och två syntetiska scenarier
  (`annan-båts-passage-använder-den-varnade-öppningen-vid-Klaffbron`).
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
- **U25 och U26 (ägarbeslut 2026-11-09): två sena varningar godtas som kända
  gränser** (se §bridge_opening_soon, punkt (d)). U25: bakkanten släpper en
  följare först när händelsens första passage bokförs, och bokförs den efter
  hennes korsning därför att ingen täckt båt hördes efter sin korsning,
  kommer hennes varning efter passagen (provvärld 1038). U26: en stilla
  köande båt som U24 inte omfattar släpps vid täckningsslutet, och hörs inte
  hennes avgång kommer varningen under 60 s före korsningen (provvärld 1139).
  Till skillnad från U17 är båda ett känt pris och inte det avsedda beteendet.
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
  Omgång 4 (U45): en annan båts passage bokförs fortfarande inte på händelsen,
  men den startar händelsens fönster i egna fält när händelsen saknar egen
  passage; se "En annan båts passage använder den varnade öppningen" vid
  K-familjen.
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
  tillsammans. *Tillägg 2026-11-16 (nattjaktens F04):* spärren släpper nu igenom en båt som
  bevisligen går tillbaka mot sista bron (se "Återinträdesspärren och återvändaren" i §4); det
  rör bara genomsläppet, inte bokföringen eller gravvården, och banken är bitlik. Kvar av L9:s
  felmod är blackouten för en båt som ligger still eller går under 4,5 kn innanför utfarten.
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
  ligga mellan föregående (eller sist kända) och aktuell position i gap-kedjans fönster,
  och hoppet ska gå i färdriktningen. Källsträng och distans lämnas orörda. **F08 (nattjakten
  2026-11-16):** "mellan" avgörs av brolinjen, inte av brons latitud. Latitudlinjen genom brons
  punkt avviker från brolinjen med 0,84 m (axel 130°) respektive 1,28 m (Stallbackabron, 142°)
  längs kanalaxeln per meter i sidled; vid linjen ligger bankens fixar −30…+30 m i sidled vid
  Klaffbron (p1–p99) och −25…+19 m vid Stallbackabron (p1–p90), så kilen är upp till ett par tiotal meter.
  BRISEN låg 13 m före Stallbackabrons linje men norr om latituden, fick "passerade … under
  AIS-tystnad", besöket fick fel bortre sida och den riktiga korsningen gav en returnotis (två
  notiser). Regeln: entydigt (> 10 m) på tillfartssidan ger ingen passerad form; entydigt på
  bortre sidan ger passerad form när hoppet inte började entydigt bortom linjen; i övrigt (inom
  ±10 m, eller båda positionerna bortom linjen) gäller latitudsvaret som förut. Banken och k1/k2
  har inget BN2-fall i kilen. Färdriktningen tas ur
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
  **N6 (granskningen av N2, ägarfråga F9, 2026-11-16): en ny båt.** Saknar båten både
  föregående fix och sist känd position prövar BN2 svepets portgissning (scenario A i
  `_checkSkippedBridgesFallback`, `_isNewVesselPastNotifiedBridge`): minst 2 kn, kurs i
  nordbandet eller det strikta sydbandet, inget motsägande ruttlås, bron är inte båtens målbro
  (målbron ligger framför), ingen start vid en känd eller inlärd kajplats, positionen entydigt bortom brolinjen i den riktningen och mer än
  `UNDER_BRIDGE_CLEAR_DISTANCE` (70 m, appens gräns för "vid bron", samma som ETA-taket i
  notisvägen) från bron. Svepet notifierar redan en sådan båts broar bakom henne som passerade,
  men närhetsnotisen gick först och tog den närmaste i förvarningsform; svepets notis dedupades
  bort. I banken nio båtar 74–252 m efter Olidebron norrut och Stallbackabron söderut, i
  4,8–6,9 kn: "NEST närmar sig Stallbackabron, beräknad ankomst om 1 minut" 248 m efter bron,
  och SABETH fick i samma sekund "passerade Kanalinfarten under AIS-tystnad" och "närmar sig
  Olidebron, beräknad ankomst om 1 minut" 88 m efter Olidebron. Nu passerad form, och meningen
  följer U37 del 2 (dirigentens beslut U44, `_newVesselPassageForm`): tystnaden är okänd för en ny
  båt och räknas som tystnad (`passageNoticeForm` med `silenceMs = Infinity`), och dröjsmålet
  skattas som avståndet bortom linjen delat med farten (`fixLatenessMs`). Högst 60 s efter den
  skattade korsningen "har precis passerat", annars "passerade … under AIS-tystnad". I banken
  får sex av de nio "har precis passerat" (korsningen 23–53 s före notisen) och tre
  tystnadsformen (67–86 s). Inom 70 m står förvarningen kvar: "beräknad ankomst strax" om en båt
  10–40 m bortom linjen betyder nu (JOY 15 m, GRETA AF HAMMARO 21 m, HELGE 10 m, SIR HENRY 39 m).
  **Kända gränser (granskningen av N6):**
  - *70 m mäts mot brons punkt* (`candidate.distance`), inte längs kanalaxeln (L2): i
    granskarens sidledsprov (160 världar) får en båt 45 m bortom linjen men 60 m i sidled (75 m
    från punkten) passerad form, och en båt 69 m bortom linjen mitt i farleden "strax". Passerad
    form före linjen förekom aldrig (0 av 96 världar 15–30 m före bron eller 20 m bortom den,
    sidlägen ±35 och ±60 m). Ingen sådan rad i banken.
  - *Kajavgång bortom en bro* (L3): en ny båt som lägger ut från en kajplats appen inte känner
    till, bortom bron, och vars första position kommer i minst 2 kn mer än 70 m från bron, får
    "passerade <bron>" om en bro hon aldrig korsat. I granskarens kajprov (100 världar, första
    fix 60–250 m bortom en bro i 2,2 eller 4 kn) skiljer 48 från basen, varje gång exakt
    "närmar sig X, beräknad ankomst om 1 minut" → passerad form, med samma antal notiser; basen
    ger i samma tick svepets "passerade <bron längre bak> under AIS-tystnad". Ett osant
    påstående byts alltså mot ett annat. Realistisk plats: väntytan mellan Järnvägsbron och
    Stridsbergsbron. 0 fall i banken och k1/k2.
  **U44 punkt 3 (omgång 4): långsamma båtar bortom bron.** En förvarning om en bro som ligger
  entydigt (> 10 m) bortom en båt i notisens riktning hålls inne när farten är under 2 kn
  (`SLOW_BRIDGE_BEHIND_MAX_KN`, samma gräns som portgissningen, punkt 1 och punkt 4): kursen är då
  inget belägg för riktningen (`_isSlowVesselPastNotifiedBridge`, anropad i
  `_triggerBoatNearFlowForBridge` efter dedupbesluten och passageformerna men före besöket och
  nycklarna, så inget skrivs och nästa position prövas på nytt). Har båten hållits inne för en bro
  hålls förvarningen också (b) när hon sedan går bort i minst 2 kn med kursen i notisens riktning
  på samma sida (riktningen är då belagd och bron ligger bakom henne), och (c) medan riktningen
  är okänd och hon ligger kvar på samma sida. **Undantaget i (a) (granskningen av D3, H1; omgång 5):**
  notisens riktning kommer i första hand ur ruttlåset, och ett enda omvänt kursvärde i krypfart
  kan låsa det åt fel håll; låset vänder först i fart. Rör sig båten belagt mot bron hålls därför
  inget inne (`_slowVesselHeadsForBridge`): kursen är giltig (minst `MIN_VIABLE_SPEED_KN`) och
  pekar mot bron (`geometry.courseBridgeSide`), och positionen ligger minst
  `SLOW_BRIDGE_APPROACH_MIN_M` (30 m) närmare linjen än spärrens **ankare**. Ankaret
  (`_slowBridgeBehindHolds`, mmsi → bro → `{side, anchorM}`) sätts vid första inhållna
  positionen för bron, på hennes avstånd till linjen, och flyttas ut när en inhållen position
  och föregående position båda ligger längre bort (till det kortare av de två): det följer en
  båt som glider bort, men en ensam brusfix eller utliggare flyttar det inte. Vid första
  försöket för bron (inget ankare) mäts mot föregående position, om den ligger entydigt på samma
  sida; Järnvägsbron och Stridsbergsbron ligger 257 m isär, och den andra bron blir ofta kandidat
  först när båten redan är på väg mot den. Är kursen ogiltig (stilla nu, under
  `MIN_VIABLE_SPEED_KN` eller saknas) släpps hon om två positioner i rad, den aktuella och
  föregående, ligger minst 30 m närmare linjen än ankaret (granskningen av varv 3): en båt med fel
  lås som närmat sig bron mellan två glesa positioner (klass B rapporterar var tredje minut under
  2 kn) och nu väntar nära bron fick annars förvarningen först när hon satte fart, 19 s före
  korsningen (10 av 40 byggda världar; med regeln 2). En ensam utliggare närmare bron räcker inte
  (med en position: 17 → 30 falska av 40). Förvarningen får låsets riktning, som förut. Varv 2
  krävde i stället 10 m sedan föregående position; det släppte aldrig vid tät rapportering i
  krypfart (10 m på 10 s kräver 1,94 kn: förvarningen kom 29 s före korsningen) och släppte på
  GPS-brus (två fixar med ±10–20 m brus kan ligga 10 m isär). Ankarets post tas bort när en
  notis för bron har gått ut och när båten raderas; den sparas inte över en omstart (första
  positionen efter omstarten hålls inne och sätter ett nytt ankare, föregående position finns
  inte). Läckdiagnostiken i replay räknar ankarkartan och loggmängden, och `replay:all` och
  `replay:synthetic` fäller en körning där de inte är tomma efter efterspelet. Den första
  inhållna positionen per båt och bro loggas i fältloggen, resten som debug.
  *Valet av gräns och ankare (omgång 5, 840 byggda världar i 15 familjer: alla fem broar, båda
  sidor, 0,3–3 kn, kadens 10–180 s, brus 0–20 m, kurs med, mot och tvärs, stilla, vändningar,
  AIS-glapp, omstart, utliggare).* Förvarning under 60 s före korsningen / falsk notis för en bro
  båten aldrig korsar, summerat: `7633653` (ingen regel) 6 / 305; regeln utan undantag 129 /
  167; varv 2 48 / 207; ankaret längst bort av enstaka positioner (granskarens förslag, med
  föregående position) 20 m 24 / 200, 30 m 30 / 190, 40 m 38 / 179; ankaret vid första
  inhållna positionen 44 / 167 (20 och 30 m), 53 / 167 (40 m); **valt: två positioner i rad,
  föregående position vid första försöket**, 20 m 30 / 182, **30 m 32 / 169**, 40 m 41 / 167;
  med släppet för en stilla båt (två positioner i rad) 31 / 170: en sen färre (24 → 93 s mellan
  Järnvägsbron och Stridsbergsbron) och en falsk till (stilla med 20 m brus efter ett AIS-glapp,
  två brusfixar i rad 33–41 m närmare än ankaret).
  Det valda ankaret ger lika få falska notiser som regeln utan undantag utom 2 (stilla med 20 m
  brus) och nästan lika få sena förvarningar som granskarens förslag; det förslaget gav 21 fler
  falska notiser än det valda (23 fler än regeln utan undantag), alla ur brus eller en enstaka utliggare som flyttade ankaret. Två båtar vid
  samma bro samtidigt (30 världar): 0 sena, falska 30 → 9 (varv 2: 1 sen, 12 falska). En passagenotis (S4, BN2,
  retroaktiva källor) går alltid ut, och en ny båt i minst 2 kn följer punkt 1. HALIFAX
  (20260708-21h, 194 m söder om Olidebron i 1,1 kn med kursen söderut; hon låg och drev på
  tillfartssidan och gick norrut genom bron 11,6 min senare) får i stället för "närmar sig
  Olidebron, beräknad ankomst om 6 minuter" söderut 08:29 en förvarning norrut 08:39:34, 160 m före
  bron, "om 1 minut", 68 s före korsningen. EUGENIEs falska "närmar sig Klaffbron" (20260804-both-21h,
  1,9 kn, 268 m norr om bron; hon korsade aldrig Klaffbron) försvinner. Inga andra rader i banken
  eller k1/k2 ändras. En båt som korsar bron i ett glapp efter driften får passagenotisen enligt
  U37 del 2 när korsningen syns: av 90 byggda världar (alla broar, båda hållen, första position
  efter glappet 40–250 m bortom bron, i fart eller långsamt) fick 84 passagenotisen, 5 en
  förvarning 37–39 m bortom bron där appen inte bokförde korsningen och ruttlåset från driften
  pekade fel (3 av dem exakt som förut), och 1 ingen notis (se gränserna nedan). Förut fick 72 av
  de 90 en förvarning i fel riktning innan glappet.
  - *Förvarningen kommer senare* för en båt som driver bort från bron, ligger still och sedan går
    igenom. Driftsvepet (60 världar), första notisen mot den sanna korsningen (antal, därav rätt
    riktning), `6fad291` → nu: efter korsningen 4 (4) → 4 (4); 0–59 s 6 (6) → 6 (6); 60–119 s 2
    (2) → 30 (6); 120–299 s 0 → 14 (14); 300–599 s 48 (1) → 6 (5). 22 världar går från fel till rätt
    riktning (median 472 → 232 s), 13 är rätt och oförändrade, och **25 förblir i fel riktning med
    ledtiden kapad från median 472 till 112 s**: ruttlåset från driften pekar bort från bron, båten
    ligger still med slumpad kurs (ingen förflyttning, alltså inget undantag) och notisen går ut
    först när hon går i fart. Gles drift (20 världar): 217 → 97 s, fel riktning 16 → 8. En stilla
    båt med slumpad kurs ser likadan ut på tillfartssidan (ska få notisen) och bortom bron (ska inte
    få den); regeln väljer att hålla inne. Samma sak för en väntande båt 100 m före bron med fel lås
    (granskarens VQ): 4 av 20 får förvarningen 49 s före korsningen i fel riktning, som utan
    undantaget (förut 589–649 s, också fel riktning). Den tidigare förvarningen nämnde rätt bro men
    fel riktning och fel minuttal (HALIFAX: 11,6 min före passagen, "om 6 minuter", söderut).
    Omgång 5, egen VQ-familj med brus 0–20 m och kadens 10–120 s: 18 av 40 får förvarningen
    under 60 s före korsningen (varv 2: 11, där brus ibland släppte henne; regeln utan undantag:
    22). Över alla 504 byggda världar med korsning, första notisen (antal, därav rätt riktning),
    `7633653` → nu: under 60 s 6 (6) → 31 (10); 60–119 s 9 (6) → 43 (12); 120–299 s 64 (51) →
    135 (69); 300 s eller mer 414 (106) → 283 (183); passagenotis 10 → 11; efter korsningen 1 → 1.
  - *Fel lås nära bron, sedan krypfart genom bron* (granskningen av varv 3, 40 byggda världar):
    första positionen 20–80 m bortom bron med omvänd kurs (fel lås), väntan 2–5 min, sedan
    krypfart tillbaka genom bron i 0,7–1,9 kn. Ankaret ligger då under 80 m, så "30 m närmare" kan
    bara ske de sista metrarna. 8 av 40 får ingen förvarning (passagenotisen kommer 5–37 s efter
    korsningen, i rätt riktning) och 9 får den 9–56 s före; `7633653` gav alla 40 förvarningen
    3–8 min före, men i fel riktning i 35 av 40.
  - *Hörs första gången medan hon väntar, med fel lås ur första kursen* (granskningen av varv 3,
    60 världar före Järnvägsbron norrut och Klaffbron söderut): 9 får förvarningen 33–107 s före i
    stället för 10–20 min (samma fel riktning), 2 får riktningen rättad. Den väntande båten med
    fel lås i omgång 5:s egen familj (VQ): 18 av 40 får förvarningen under 60 s före.
  - Inget av de två fallen ovan, och inte VQ, finns i banken eller fältkörningarna k1–k3.
    Avvägningen är beslutad (omgång 4): en falsk notis för en båt som aldrig kommer väger tyngre
    än en sen förvarning, och en stilla båt med fel lås ser likadan ut före och bortom bron.
  - *Ankaret ser bara positioner där bron var kandidat* (omgång 5): mellan Järnvägsbron och
    Stridsbergsbron är den närmare bron kandidat, så positioner där båten låg närmare den andra
    bron flyttar inte den förstas ankare. En båt som drev bort mot Stridsbergsbron, vände och
    stannade 50 m före Järnvägsbron fick förvarningen 24 s före korsningen (1 av 80 driftvärldar
    med släppet för en stilla båt, 2 utan; granskarens förslag 0, eftersom det räknade föregående position vid varje försök, vilket
    också släppte på en enstaka utliggare). 0 fall i banken och k1–k3.
  - *Krypfart genom bron hela vägen* (granskarens KK, 30 världar i 1,0–1,9 kn utan någon position
    i fart): när båten ligger på linjen (±10 m) släpper spärren och förvarningen går ut med
    låsets riktning; i 2 av 30 blir det "närmar sig … strax" 3 s efter korsningen (5 utan
    undantaget, 0 på `6fad291`, där förvarningen kom 237–297 s före i fel riktning). 9 av de 30 får
    med undantaget förvarningen i fel riktning 196–444 s före, som på `6fad291`, i stället för vad
    de fick utan undantaget (8 passagenotisen 36–44 s efter korsningen, 1 en förvarning i rätt
    riktning 57 s före).
  - *Järnvägsbron och Stridsbergsbron i samma glapp*: hålls Järnvägsbrons förvarning inne för en
    båt söder om bron, och nästa position kommer först bortom Stridsbergsbron (ett hopp under
    `LARGE_JUMP_LAT_DEG`), bokförs Stridsbergsbron först och Järnvägsbrons passage spärras av
    ruttordningsvalideringen (bakåtsekvens): Järnvägsbron får ingen notis (1 av 90 byggda
    världar). Förut fick hon förvarningen söderut innan glappet. 0 fall i banken och k1/k2.
  - *Krypfart utan notisförsök*: spärren (b) kräver att en notis hållits inne. En båt vars första
    långsamma position inte gav något notisförsök (till exempel utan målbro söderut ur
    Klaffbron) och som sedan sätter fart bort inom 300 m får förvarningen om bron bakom sig som
    förut (5 av 20 byggda världar). 0 fall i banken och k1/k2.
  - *Inom 70 m* gäller punkt 2 ("strax") bara båtar i minst 2 kn; en långsam båt 10–70 m bortom
    linjen hålls inne. Spärren och ankaret sparas inte över en omstart: första positionen efter
    omstarten hålls inne och sätter ett nytt ankare (omstartsfamiljen, 30 världar: 0 sena
    förvarningar, 9 falska notiser som utan undantaget).
  - *Gränsen 2 kn i vakten är skarp* (granskningens andra varv): en båt som rör sig bort från bron
    på tillfartssidan i strax över 2 kn och sedan går igenom får två notiser för en passage,
    "passerade" medan hon rör sig bort (punkt 1, eller svepets portgissning) och "har precis
    passerat" när hon korsar. Omgång 4 mätte på `6fad291`: 20 av 20 världar i 2,1 kn (12 genom
    punkt 1, 8 genom portgissningen som fanns före N6), 0 av 20 i 1,9 kn; U44 punkt 3 ändrar
    inget av det. Att flytta alla tre grindarna (portgissningen, punkt 1 och punkt 3) till 3 kn
    gav 0 av 20 i 2,1, 2,5 och 2,9 kn, alltså samma klippa vid 3 kn i stället. Ingen sådan rad i
    banken.
  - *Vakten litar på föregående position* (granskningens andra varv): är den en utliggare 25 m
    bortom linjen hamnar bortre sidan fel för en båt som driver i 1 kn. Det syns i trackern men
    gick inte att få fram i replay (0 av 40 världar); släppet kräver ändå hela U14-beviset.
- Mellanbrons avståndsreserv i `_hasPassedBridge` täcker bandet mellan
  `UNDER_BRIDGE_CROSS_SEGMENT_MAX_M` och `LARGE_JUMP_LAT_DEG` (den delade hoppgränsen, förut
  hårdkodad 0,005).

**Beslutspunkter (användarens):** L6/P8 med ny mätning: 11 % av båttext → DEFAULT hålls i
produktion, se nedan. BN1: utfarter vid boxkanten lämnar besök öppna (VISTEN, REBEL, JUNO; beslutat som U46
2026-11-17, se "Rättningsomgång 4"). open3:
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
- **U37 del 1 (rättningsomgång 3, 2026-11-16):** vid tät kadens krävde beviset 30 m ut eller två
  fixar, och antog att nästa fix kommer inom "precis passerat"-fönstret. Nattjaktens F15
  (aisstream klass A, glapp 421 s efter korsningsfixen, fältets p97–98) visade att det inte
  håller. Korsningsfixen i transitfart släpps nu direkt (villkor 7d i
  `releaseReturnPassage`), när den ligger entydigt bortom linjen och korsningssegmentet stämmer
  med farten (kvot och tak 15 m). Motfallen (stopp på
  linjen, guppande ±30 m i upp till 1,5 kn, kurs bort, fart 3,0 kn, osäker position,
  bokföring före segmentet, fixen på linjen vid tät kadens) släpps inte; låsta i `tests/u37-retur-linjefix-transit.test.js` för alla fem
  broar i båda riktningar och i de syntetiska scenarierna `retur-tät-kadens-…` och
  `vänder-och-stannar-på-Klaffbrons-linje-…`. Banken och fältkörningarna k1/k2 påverkas inte.
- **U37 del 2 (samma omgång):** formregeln gäller nu alla passagenotiser (§3, P8/U10), och
  retursläppets tystnad mäts fram till släppets fix. Nattjaktens F08 r1 (TROLLA) korsade
  Järnvägsbron i ett segment på 67 s och var sedan tyst i 135 s; returnotisen 174 s efter
  korsningen, 531 m bort, sa "har precis passerat" och säger nu "passerade … under
  AIS-tystnad". Trigger-punktens "har passerat Kanalinfarten" (H16) och exit-fallbacken rörs
  inte.

### Rättningsomgång 4 (2026-11-17) — U46, utfärd vid ytterpunkterna

- **Situationen.** En båt som lämnar området utåt vid en ytterpunkt utan att appen ser två
  positioner bortom 350 m lämnade ett öppet besök, och öppna besök gallras aldrig. Boxens östkant
  (12,32) ligger 140 m öster om Stallbackabron, så en nordgående båt lämnar boxen 300–500 m norr
  om bron, ofta före fullbordad-resa-latituden 58,3125. PRICKBJORN i fältet 13/11 (k2): norrut
  genom bron i 10,1 kn, sista fixen 288 m norr, tyst i 6,5 h; när hon kom tillbaka söderut
  13:48:44, 8 m från bron, kom ingen förvarning, och U14:s retursläpp gav "har precis passerat"
  13:49:53. VISTEN (20260917-16h, 267 m norr i 7,6 kn) och S/V REBEL (42h, 378 m sydväst om
  Kanalinfarten i 3,0 kn) lämnade besök öppna på samma sätt.
- **Rättningen** (`TriggerPointVisitTracker._isOutwardTransitFix`, `_isReturnAfterSilence` och
  `observe`): utåtbeviset enligt §3, dedup-lager 3, och utfärden bekräftad av minst 10 min
  tystnad följd av en fix som visar att båten varit borta. Tystnaden skiljer en båt som lämnat
  boxen från en som går ut förbi punkten och lägger till: ELFKUNGEN går in till sin kaj
  297–305 m sydväst om Kanalinfarten via 170 → 276 m i 4,5/2,7 kn och hörs 60–84 s senare vid
  kajen. Kravet på en återkomstfix (utanför zonen, inre sidan eller på väg inåt) tar fallet där
  AIS är tyst i över 10 min just när hon lägger till (glapp på upp till 45 min vid kajen):
  hörd stilla på samma plats behåller hon besöket (syntetiska scenariot
  `ut-förbi-Kanalinfarten-förtöjd-tyst-12min-direkt` gav annars en andra notis). Utan tystnadsvillkoret (prov i 42h) gav utåtparet en andra notis ("har
  passerat Kanalinfarten") för elva båtar som gick ut söderut förbi Kanalinfarten och fortsatte
  höras i zonen, och en förvarning till för en båt vid Stallbackabron.
- **Utfall.** Banken (25 korpusar) och k1 oförändrade. I k2 får PRICKBJORN "närmar sig
  Stallbackabron, beräknad ankomst strax" 13:48:44 i stället för "har precis passerat" 13:49:53.
  Bankens två BN1-träffar (ELFKUNGEN vid Kanalinfarten i 42h och 80h) är ingen utfart: hon låg
  förtöjd vid zonkanten i 21 h respektive tre dygn och fick ingen notis när hon lade ut. Det är
  fältgranskningens F8 (c), som inte är beslutad; besöksregeln säger att förtöjning inte är en
  utfärd. Nattjaktens fem BN1-världar är returer inifrån kanalen (båten vänder innanför
  ytterpunkten under ett glapp) och ändras inte heller.
- **Kända gränser.** En båt som stannar på den yttre sidan direkt efter utåtparet, är tyst i minst
  10 min och sedan hörs på väg inåt i minst 2 kn får ett nytt besök (hon har legat stilla i minst
  10 min; FP8/FP9/V1-grindarna står kvar). En båt som kommer tillbaka efter en utfärd men först
  hörs stilla eller långsam på den yttre sidan i zonen behåller sitt gamla besök (som före U46).
  En båt som lämnar boxen utan rapporterad fart, med kursen inåt eller med ett segment som inte
  stämmer med farten får inget bevis. Låst i `tests/u46-utfard-ytterpunkt.test.js` och åtta
  syntetiska scenarier (`utfärd-…-tyst-6h-…`, `ut-förbi-Kanalinfarten-och-förtöjd-vid-zonkanten`,
  `ut-förbi-Kanalinfarten-förtöjd-tyst-12min-direkt`, `vänder-strax-utanför-Kanalinfarten`, och
  efter granskningen (M1) ett per villkor: `norrut-mot-Stallbackabron-tyst-14min-på-inre-sidan`,
  `ut-söder-om-Kanalinfarten-med-kurs-inåt-tyst-6h`, `ut-söder-om-Kanalinfarten-37m-per-fix-tyst-6h`).
  Mutationsprovet: varje villkor (yttre sidan, 50 m utåt, kurs, fart, segment, återkomstkrav,
  tystnad) fäller minst ett test när det tas bort.

### Rättningsomgång 4 (2026-11-17) — U51, förtöjd båt som lägger ut vid en ytterpunkt

- **Situationen.** ELFKUNGEN har sin kajplats 290 m ut från Kanalinfartens linje och låg där i
  21 h (20260806-42h) och tre dygn (20260909-80h); när hon lade ut norrut tystades notisen av
  besöket från ankomsten. Samma sak för PRICKBJORN från lotskajen (149 m ut) 12/11 07:08 (k1) och
  13/11 06:48 (k2). Besöksregeln 2026-09-07 räknade inte förtöjning som utfärd; U51 gör en
  belagd förtöjning på minst 2 h följd av en belagd avgång till ett nytt besök.
- **Rättningen** (`_trackMooring`, `_isMooredDeparture` och `observe`), bara Kanalinfarten och
  Stallbackabron, enligt §3, dedup-lager 3. Belägget kräver stilla fixar, inte tystnad: ett glapp
  över 60 min mellan stilla fixar börjar om (längsta glapp i en förtöjning vid Kanalinfarten i
  banken och fältet är 54 min). Avgångsbandet 50 m från linjen ligger innanför närmaste kajplats
  (CAPELLA, 70 m), så ett kajbyte på samma sida släpper inte besöket, och en sydgående kajstartare
  som går ut ur kanalen rör sig bort från linjen (FP8 orörd).
- **Utfall.** Fem nya notiser, tre i banken: ELFKUNGEN 7/8 10:07:00 ("har passerat Kanalinfarten",
  203 m in i kanalen) och 10/9 16:01:36 ("närmar sig …, beräknad ankomst strax", 23 m), DIANA 24/8
  16:48:04 (förtöjd 2 h 24 min, "närmar sig …, strax", 16 m); i fältet PRICKBJORN 12/11 07:08:07
  (k1, "har passerat", 63 m) och 13/11 06:48:54 (k2, "närmar sig …, strax", 36 m). PILOT 761 11/11
  11:42 hade legat 75 min (under 2 h) och JUNO 4/8 har ett glapp på 102 min utan fixar vid kajen
  (glappregeln river belägget) och hördes efter avgången först 454 m in i kanalen: ingen av dem
  får notis. U51 vänder låsningen 2026-09-09 (DIANA: en Kanalinfartsnotis för hamnstoppet på 2,5 h):
  den skyddade mot en andra notis för samma zonbesök när 2 h-dedupen löpte ut; nu kommer den andra
  notisen bara efter belagd förtöjning i minst 2 h och belagd avgång. Vid broarna (mätt, inte infört) skulle
  regeln ge ANDREA en andra Stridsbergsnotis efter två timmar i brokön, den notis besöksregeln
  2026-09-07 tog bort; därför bara ytterpunkterna.
- **Granskningen (andra varvet).** H1: med 30–120 s mellan fixarna kom släppet oftast på första
  fixen förbi linjen, och formregeln (reseankarets latitud med 100 m marginal; lotskajen ligger
  inom marginalen) gav då "närmar sig … om 1–3 minuter" för en båt 15–290 m inne i kanalen,
  3 av 12 avgångar vid 30 s och 8 av 12 vid 60 s i granskarens rutnät. Släppet bär nu sidan
  (`pastLine`), och rutnätet ger 0 fel form vid alla fixtakter. M2: före linjen högst 70 m från
  punkten; närmaste kajplats ligger 123 m från punkten, granskarens förhalning i sidled slutade
  114 m från den, och de verkliga släppen före linjen låg 16–36 m från den.
- **Kända gränser.** Avgångsnotisen kommer vid första fixen i bandet eller förbi linjen; en båt
  som går igenom bandet mellan två fixar får den först innanför linjen, i passerad form
  (ELFKUNGEN 42h: "har passerat", 203 m). En lotsbåt får en notis vid varje avgång efter minst
  2 h vid kaj. Ett GPS-hopp från kajen till bandet nära punkten (till exempel 30 m före linjen i
  2,5 kn) efter en fix i minst 0,5 kn vid kajen ger en falsk avgångsnotis; det kräver två
  samtidiga fel och finns inte i data (0 av 18 050 kajfixar med stilla grannar har ett hopp på
  50 m mot linjen, 0 har fart ≥ 2 kn). Vid Stallbackabron kan notisens riktning bli fel när
  kursen ligger i det osäkra bandet (förtöjd söder om bron, sedan norrut med kurs 52°, utanför
  norrbandet 315–45°: notisen säger "southbound"); det är riktningslogiken, inte U51, och det
  finns ingen förtöjning vid Stallbackabron i data. Låst i `tests/u51-fortojd-avgang.test.js`,
  `tests/u51-granskning-helkedja.test.js` (H1 och M2 genom hela appen) och tre syntetiska
  scenarier (`förtöjd-3h-…`, `förtöjd-1h30-…`, `förtöjd-3h-byter-kajplats-…`). Mutationsprovet:
  varje villkor i avgången och belägget fäller minst ett test när det tas bort.

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
det inte. Hubbens återkomst efter ett avbrott drar fram AISstreams nästa
försök när AISstreams försök aldrig nått servern (F1, se AISStreamClient i
modullistan); spärrar och HTTP-fel följer fortfarande sin egen takt.

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
korstystnadsfönstret; för AISstream-sidan 25 min sedan U29, se nedan) → 1 h →
4 h → 1 dygn**. Varje nivå bär sin egen
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

**Korstystnadens gräns för AISstream efter U29** (ägarbeslut 2026-11-15, fråga
F12 i `docs/faltgranskning-2026-11-14.md`, alternativ b + c). På vintern rör sig
ingen båt i området på 15–23 minuter, och AISstream levererar då inget alls fast
anslutningen är frisk, medan AISHub fortsätter rapportera de förtöjda båtarna.
Tre fältkörningar (app.log täcker 100,2 h) gav sju episoder "Degraderad" och
tre falska notiser "… kan vara halvdöd". Antalet tystnader beror på måttet. Med
appens eget mått (AISstreams meddelanden i app.log, även dem fusionen avvisar;
en övre gräns eftersom avslagen bara loggas som urval) var de nio på minst
15 min: k1 tre, k2 en, k3 fem, på 15,3–23,3 min. Talet elva (k1/k2: sex på
16–20 min) räknar k1/k2 som glapp mellan pipeline-accepterade sampel i
`ais.jsonl`, vilket ger längre och fler glapp; testet
`tests/u29-korstystnad-25min.test.js` använder den strängare listan. **Gränsen för AISstream-sidans basnotis
(`aisstream:silent`, även skuggvarianten `aisstream:silent:shadow`) och för
statusen `degraded` är därför 25 min**
(`CONNECTION_ALERT.AISSTREAM_CROSS_SILENCE_ALERT_MS`), med exakt samma villkor
för båda (B2c: `degradeNow` läser `streamCrossSilent`). **Priset**, uttalat och
godtaget av ägaren: en verkligt död AISstream syns tio minuter senare.
Marginalen mot fältets längsta friska tystnad (23,33 min, k3 14/11 18:21:50Z)
är 1,7 min. Den tystnaden slutade inte av sig själv: feed-vakten
tvångsåteranslöt 18:42:50Z, och nästa meddelande kom 2 min 20 s senare, på den
nya socketen. Det går inte att avgöra om det var ett naturligt uppehåll (som
då kunde ha blivit längre än 23,33 min) eller en hängd prenumeration som vakten
lagade. Granskarens skattning, som information (exponentiell svans anpassad
till glappen över 10, 12 och 15 min; 100 h underlag från en årstid): med 25 min
väntas ett falsklarm ungefär var 2–5 vecka i vintertrafik, mot cirka två per
dygn med 15 min. Varje sådant falsklarm blir högst en notis per dygn och
"Degraderad" tills nästa meddelande.

**Ordningen feed-vakt före larm.** Feed-vakten
(`UI_CONSTANTS.STALE_FEED_RECONNECT_MS`, 20 min, mätt som min(tid sedan
senaste meddelande, socketens upptid)) tvingar en återanslutning vid första
monitoringtick med minst 20 min tystnad, alltså 20–21 min in (k3 18:42:50Z:
"sinceMessage=21 min"); larmet kommer vid första tick ÖVER 25 min, alltså
25–26 min in, fem (eller sex) monitoringtick efter vaktens ingrepp. Appen
hinner därmed försöka laga felet själv innan den larmar, och en ny socket
hinner pinga och ponga. Två undantag, båda
där appen redan försökt: socketen har återanslutits under tystnaden (då väntar
vakten ut ett helt tyst fönster på den nya socketen), eller socketen är nere
(då äger klientens egen backoff återanslutningen och vakten ingriper inte).
Låst av `tests/u29-korstystnad-25min.test.js` (vakten 20:09, larmet 25:09 i
samma tick som "Degraderad", sedan 1 h, 4 h och 1 dygn som förut) och av
`tests/u29-e2e-riktiga-klienter.test.js`, som kör samma förlopp genom riktig
`AISStreamClient` (fejkad `ws`), riktig `AISHubClient` (fejkad HTTP) och riktig
mux: död men pongande källa, socket som inte pongar, socket nere, ett
meddelande var 24:e respektive 27:e min, serverstängning under tystnaden
(undantaget ovan), skuggläget och klocksteg bakåt.

**Texten utan diagnos när anslutningen bevisligen lever.** "Halvdöd" var
falskt varje gång i fält: nästa meddelande kom på samma socket. När socketen
är öppen (`perFeed.aisstream.isConnected`) OCH senaste pong på den socketen
(`lastPongAt`, nollställs per socket i `_stopPing`, som både en ny socket
via `_startPing` och en stängd via `_clearTimers` går igenom) är yngre än
pingvaktens fönster (`CONNECTION_ALERT.AISSTREAM_PONG_PROOF_WINDOW_MS`,
2 × 30 s) säger basnotisen nedanstående. Pingvakten pingar var 30:e s och
terminerar socketen vid nästa tick om pingen inte besvarats, alltså när senaste
pong är knappt 60 s gammal; en socket vars senaste ping just blivit obesvarad
räknas därför som levande i upp till 30 s till. Socketen är då fortfarande
öppen, så texten påstår inte mer än så:

> AIS Tracker: AISstream är ansluten men har inte levererat några positioner
> på N medan AISHub flödar. Appens vakter försöker återansluta automatiskt.

Annars (socketen nere, ingen pong ännu på en ny socket, pongen för gammal)
står den gamla formuleringen kvar:

> AIS Tracker: AISstream har inte levererat några positioner på N medan
> AISHub flödar — anslutningen kan vara halvdöd. Appens vakter försöker
> återansluta automatiskt.

Signalen läses ur en absolut stämpel mot vaktens klocka och ett 60 s brett
fönster, aldrig ur två härledda klockvärden på exakt likhet (familj F:s läxa
N1); proven kör förloppen med statistiken 0/1/2/50 ms före vaktens now. Båda
texterna delar nyckeln `aisstream:silent` (de beskriver samma tystnad; en egen
nyckel hade gett två basnotiser per dygn). Trappans texter ("har varit tyst i
över N … halverad redundans") innehöll aldrig "halvdöd" och är oförändrade.

**Vad som INTE följde med U29, och varför.** (1) **AISHub-spegeln**
(`aishub:silent`, AISHub tyst medan AISstream flödar) står kvar på 15 min:
den gatas på att AISstream levererat inom 2 min, alltså på bevisad trafik i
området just då, så vinterns tomma kanal kan inte utlösa den (fältet: noll
`aishub:silent` i k1–k3). Därmed står också "grannen levererar"
(`hubDelivering`, AISHub levererat inom 15 min) kvar — samma konstant som
AISHub-sidans dom, som förut. (2) **Blindhetsgrenen** (`feeds:silent`)
kräver att ingen källa svarar och har ingenting med trafikuppehåll att göra.
(3) **Trappans steg** 1 h, 4 h och 1 dygn, och tom-kanal-nätet
`feeds:empty:4h` (4 h), är oförändrade. (4) **Loggraden** `[FEED_SILENT]
aisstream har inte levererat …` börjar fortfarande vid 15 min (fältdiagnostik
för marginalen) och får tillägget `[under larmgränsen 25 min (U29)]` så länge
larmet inte gått. (5) **Släppet** av en degradering läser fortfarande den
tysta källans tystnad mot 15 min; tystnaden sjunker bara när källan
levererar, så bandet 15–25 min kan inte ge fladder.

**B2c:s likhet förutsätter en klocka som inte går bakåt.** Med U29 sätts
statusen över 25 min men släpps först under 15 min. Ställs väggklockan bakåt
efter ett larm, så att den observerade tystnaden hamnar mellan 15 och 25 min,
står "Degraderad" kvar medan notisvillkoret är falskt (granskningen: larm vid
27 min, klockan 10 min bakåt, sex tick med status kvar och villkoret falskt).
Statusen står då kvar tills källan levererar. Felet går åt det försiktiga
hållet, eftersom den verkliga tystnaden fortfarande är över 25 min, och ingen
kodändring görs. Före U29 var sättning och släpp samma gräns, så bandet fanns
inte. Valet att släppet läser 15 min är låst av klockstegsprovet i
`tests/u29-e2e-riktiga-klienter.test.js`: ett släpp på 25 min hade skrivit
"connected" där.

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

**Korstystnaden är den tid grannen levt under tystnaden** (F2, fältprovet
2026-11-11; revision 1 efter granskningen samma vecka). Korsnotiserna
(`aisstream:silent` med trappan, `aisstream:silent:shadow`, `aishub:silent`
med trappan) påstår två saker om samma tid N: att källan varit tyst OCH att
grannen flödat. I k1 var Homey utan nät 02:20–06:53Z; AISHub svarade
06:54:21Z, och ticken 06:55:09Z skickade bas-, 1h- och 4h-notisen med "4 h
medan AISHub flödar" — hubben hade flödat i 48 s. N är därför den tid under
källans PÅGÅENDE tystnad då grannen levt, ACKUMULERAD över glapp
(`_aliveTimeDuringSilence`), klämd mot den observerade tystnaden. "Levt" är
grenens egna predikat (`_noteFeedAlive`: aisstream svarar enligt H18:s latch
eller har levererat inom 2 min; AISHub har pollklockan inom 210 s). Vid
grannens återkomst räknas bara tiden sedan återkomsten (den senare av senaste
döda tick och källans egen återkomst ur `uptime`), så N är en sann undre
gräns. En ny tystnadsepisod (källan levererar) börjar om räkningen.
Notiserna gatas på att N passerat 15 min (AISstream-sidan 25 min sedan U29)
och texten bär N.

Episodens IDENTITET (revision 2, omgranskningen N1) är en nyckel av lagrade
stämplar: konfigurationsstämpeln och senaste meddelandets ABSOLUTA tid
(klientens `lastMessageTime`, bokföringens `lastMessageAt`), sammanställd i
`_observedFeedSilence` (`episodeKey`). Revision 1 jämförde `now − observerad
tystnad` på exakt likhet; talet innehåller `timeSinceLastMessage`, som
klienterna räknar med sin egen `Date.now()` några millisekunder före
korsvaktens `now` (uppmätt med riktig klocka: 0–2 ms på en Mac, mer på en
Homey). Varje millisekunds skillnad startade en ny episod och nollställde
ackumulatorn — första versionens fel, osynligt i jest och replay där klockan
står still inom ett anrop. Tom-kanal-episoden är summan av de relevanta
källornas nycklar, så ett källbyte också startar en ny episod. Proven kör
förloppen med statistiken 0/1/2/50 ms före vaktens `now` och genom den
riktiga `_checkAISFeedHealth` med klockan stegad mellan statistik och tick.

Ett glapp hos grannen drar bara av sin egen längd. Den första versionen
nollställde N vid varje glapp över grannens svarsfönster (två missade
AISHub-pollar räcker); då uteblev K22-trappan för en källa som var tyst i
dygn medan grannen hackade, och basnotisen sa "på 28 min" efter ett dygns
tystnad. Utan glapp hos grannen är N lika med den observerade tystnaden, så
K22:s tider står kvar; med ett grannglapp på 4 min var 50:e min kommer hela
trappan, med stegen några minuter senare och texter som underskattar med
högst grannens frånvaro (låst av granskarens förlopp i testfilen).

Skuren av tre notiser i samma tick i k1 var en följd av samma felräkning,
inte av K22-avvägningen ovan: N hoppade från 0 till 277 min.
`connection_status` läser SAMMA mått: `degradeNow` är exakt korsnotisens
villkor (B2c), så statusen får samma nåd efter ett totalavbrott som basnotisen
(25 min för AISstream-sidan sedan U29, 15 min för AISHub-sidan) precis som
när AISstream tappar ensam (den första versionen lät statusen läsa den råa
tystnaden och blinkade "degraded" efter varje totalavbrott). Släppet läser
fortfarande den tysta källans egen tystnad. Tom-kanal-nätet (`feeds:empty:4h`,
"AIS-källorna svarar men ingen båtdata på N") räknar på samma sätt den tid
under den gemensamma tystnaden då ALLA relevanta källor svarat; ett
totalavbrott följt av tom kanal gav annars notisen 41 s efter återkomsten med
"på 4 h". `[FEED_SILENT]`-raderna behåller sina prefix och får ett tillägg
("korstystnad N min: så länge … svarat under tystnaden" respektive "alla
källor har svarat N min av tystnaden") när måttet är minst en tick kortare än
tystnaden. Ackumulatorerna är minnesbaserade; efter omstart börjar en ny
episod vid observationsankaret. Kända gränser: inget tak på tickavståndet
(ett stall där grannen levde vid båda tickarna räknas som levande, som den
observerade tystnaden), och tiden mellan grannens sista levande och första
döda tick räknas inte (undre gräns, upplösning en tick). Låst av
`tests/f2-korstystnad-efter-totalavbrott.test.js`.

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
