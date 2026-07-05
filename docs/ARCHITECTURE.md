# ARCHITECTURE.md — AIS Tracker (io.ais.tracker)

Varaktig arkitekturkarta, byggd 2026-07-03; helreviderad mot koden 2026-07-05
efter produktionsredo-fixarna (app.js = 5512 rader; VesselDataService.js =
4701 rader). Radnummer prefixade med `~` kan glida vid framtida redigering.
Ersätter CODEX.md och docs/recentChanges.md (raderade 2026-07-03, användarbeslut).

## 1. Översikt & modulgraf

```
AISstream.io (WebSocket)
   ▼ ais-message / static-name / connected / disconnected / reconnect-needed
AISStreamClient (lib/connection/AISStreamClient.js)
   ▼
app.js  _onAISMessage → _processAISMessage (app.js:1894)
   ▼ updateVessel(mmsi, patch)
VesselDataService (lib/services/VesselDataService.js)
   ▼ events: vessel:entered / vessel:updated / vessel:removed / vessel:journey-reset
app.js händelsehanterare (_onVesselEntered:804, _onVesselUpdated:858, _onVesselRemoved:1074)
   ├─→ StatusService.analyzeVesselStatus (status/ETA) ── status:changed → _onVesselStatusChanged:1282
   ├─→ ProximityService.analyzeVesselProximity (avstånd/zoner)
   ├─→ boat_near-Flow-vägarna (§3)
   └─→ _updateUI → coalescing → _processUIUpdate:2393 → bridge_text-capability + global token
```

Moduler (ansvar / ägda tillstånd / in-ut):

- **AISStreamClient** (lib/connection/AISStreamClient.js): WebSocket-livscykel mot
  AISstream.io. Bounding box-prenumeration (:254), meddelandetypfilter (:379–386),
  extraktion av mmsi/lat/lon/sog/cog/navStatus/shipName i `_extractAISData`
  (:463–515, avvisar 0,0; String()-wrap på Name). Reconnect-tillstånd (progressiva
  delays, medium 5 min ×12, slow 60 min; :521–529), ping/pong-watchdog
  (`_awaitingPong` :35). Emitterar connected/disconnected/ais-message/static-name
  (typ 5/24-namn, :362–373)/auth-error/error/reconnect-needed/max-reconnects-reached.
- **app.js (AISBridgeApp)**: orkestrering, Flow-kort, UI-publicering, notisdedupe,
  persistens, monitoring. Äger `_triggeredBoatNearKeys` (session-Set, :181),
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
  :3695–3703; clearVessel vid removal :736–738).
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
- **Utils**: `geometry` (haversine, distancePointToSegmentM, hasChangedBridgeSide),
  `CountTextHelper`, `etaValidation` (isValidETA, formatETABroOpeningClause =
  SSOT för ETA-klausulen), `PassageWindowManager`, `GPSJumpAnalyzer`.
  (`MessageBuilder`/`ETAFormatter`/`StallbackabronHelper` raderade 2026-07-05; §9.)

## 2. Geografin (lib/constants.js)

Broar i `BRIDGES` (:151–187), syd→nord (`BRIDGE_SEQUENCE` :255–261):

| Bro | lat | lon | radius | axisBearing | Roll |
|---|---|---|---|---|---|
| Olidebron | 58.272743 | 12.275116 | 300 | 130 | mellanbro |
| Klaffbron | 58.284096 | 12.283930 | 300 | 130 | **MÅLBRO** |
| Järnvägsbron | 58.291640 | 12.292025 | 300 | 130 | mellanbro |
| Stridsbergsbron | 58.293524 | 12.294566 | 300 | 130 | **MÅLBRO** |
| Stallbackabron | 58.311430 | 12.314564 | 300 | 125 | hög bro, öppnas aldrig |

- `TARGET_BRIDGES = ['Klaffbron', 'Stridsbergsbron']` (:234); `INTERMEDIATE_BRIDGES` (:237).
- **Kanalinfarten** är INGEN bro utan trigger-punkt (`TRIGGER_POINTS.kanalinfarten`,
  :117–124: 58.268003/12.269365, radius 300 m) — triggar boat_near men ingår inte
  i brotext/status; ej i BridgeRegistry, uppslag direkt i TRIGGER_POINTS
  (app.js:3938/4108/4156/4255/4892).
- `BRIDGE_GAPS` (:244–249): olide–klaff 950 m, klaff–järnväg 960 m,
  järnväg–strids 420 m (kortast, kritisk timing), strids–stallbacka 2310 m.
- `MOORING_ZONES` (:216–227): kapsel (centrumlinje + 30 m halvbredd) för "Kajen
  norr om Klaffbron" (190–295 m från bron, mitt i väntzonen). `MOORING_DETECTION`
  (:204–210): STATIONARY 0.3 kn, MOVEMENT_PROOF 0.5 kn/50 m, navstatus 1/5,
  2h-backstop.
- Stallbackabron-specialregler i `STALLBACKABRON_SPECIAL` (:343–348): aldrig
  "inväntar broöppning"; egen status `stallbacka-waiting`.

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
4. **Exit/removal** — `_onVesselRemoved` (:1074) → gate :1132–1142 (giltiga
   koordinater + `_finalTargetDirection === 'south'` + `_finalTargetBridge`) →
   `_triggerExitPointFallback` (:4155–4220: F63-stale ≤25 min på
   `lastPositionUpdate`, ≤400 m från Kanalinfarten, norr om punkten, session- +
   persistent-dedupe) → `_triggerBoatNearFlowFallback(vessel, 'Kanalinfarten')`.

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
Passerar allt → `_triggerBoatNearFlowForBridge` med `source: 'passage-fallback'`.

### Kandidatval (:4022), dedup-lagren och tokens (`_triggerBoatNearFlowForBridge`:4424)

Kandidatval: tröskel 300 m (FLOW_TRIGGER_DISTANCE_THRESHOLD). Källor i ordning
(:4080–4113): `target` → `current` → `just-passed` (15 s grace efter passage) →
`nearest` (endast om inga andra) → `trigger-point` (Kanalinfarten, egen
distansberäkning). Finns target-kandidat: target dominerar, MEN target +
current/nearest/just-passed får båda trigga när de är olika broar (Fix 7,
Järnvägs/Strids-överlappet; :4120–4146). Sjätte source-värdet
`passage-fallback` sätts av fallback-vägen. Dedup-lagren:

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

Tokens: `vessel_name` (B1: känt namn → cache-uppslag → "Okänd båt", :4464),
`bridge_name`, `direction` (`_getDirectionString`:4639: låst rutt-riktning
först, annars COG — 'unknown' vid omätbar fart), `eta_minutes` (target-källa =
målbro-ETA; övriga = dist/fart mot notisbron; `passage-fallback`/`just-passed`
⇒ -1; nära+långsam icke-target ⇒ -1; :4477–4501).

**Trigger-state (:4546):** `{ bridge, mmsi, distance: Math.round(d), source }`.
OBS per-bro-semantik: dedupen sker UPPSTRÖMS per mmsi:bro, så en "Any
bridge"-flow fyrar max EN gång per BRO och resa (upp till 6 för full genomresa)
— run-listenern (:4743–4758) släpper `'any'` rakt igenom; per-resa-gaten (F7,
mmsi:any-nyckeln) togs bort 2026-07-02 (användarbeslut). distance/source
konsumeras av replay-invarianterna (INV-11, inferens-särskiljning).

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
- **Target-protection** (`_checkTargetBridgeProtection`, VDS:3963–4058).
  Aktivering (:3989–4007) om något av: ≤300 m från target; GPS-event
  (jump/osäker/rörelse >200 m, :4064–4081); manöver (COG-ändring >45° ELLER
  fartändring >2 kn, :4092–4109); passage <60 s; koordination aktiv. Aktiv
  protection ÅTERSTÄLLER targetBridge om något ändrat den (:4047–4054).
  Deaktivering (`_shouldDeactivateProtection`:4161): **B3** — skyddad bro i
  `passedBridges` ⇒ OMEDELBART (:4172–4176); >5 min alltid; >500 m + inga event
  + >1 min; GPS löst + >30 s; koordination löst + >15 s. Släpps även vid
  inferens (`'missed-target-inferred'` :3481, `'inferred-passage'` :3547), Fix D
  (:238–239) och NEW_JOURNEY via publika `clearTargetProtection` (:4217–4220,
  anrop app.js:944 — annars RESTORE:ar skyddet gamla resans bro).
  **RC9-origin-vakten** `_targetOriginSideOk` (:3501, används :3469/:3652):
  `_firstSeenLat` måste ligga på rätt sida om target för färdriktningen —
  stoppar fabricerad "bortom target"-inferens efter U-sväng.
- U-sväng: Fix D (VDS:137–265, sog ≥ 2.0 :149, 2-observations-debounce
  `_fixDPendingReversal` :196–231) nollar target mitt i resan; journey-reset
  rensar båda dedup-lagren (app.js:738–741). Post-resa: NEW_JOURNEY
  (app.js:897–952, debounce `_newJourneyPending`) nollar passedBridges + dedupe
  + target-protection för returresan.

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
   **15 min** för trolig köare (target inom 600 m + rörelsebevis) (:1681–1696).
5. **2h-backstop**: stationär > MAX_STATIONARY_WAIT_MS (:1698–1702).
   Släpp-hysteres: tydlig avgång (≥0.5 kn) direkt; gråzon kräver 2 prover
   (`_mooredReleasePending`, :1638–1653); navstatus-flap ensam släpper inte
   (:1660–1665).

### ETA-extrapoleringens tillstånd (app.js `_reevaluateVesselStatuses`, :3262–3531)

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
  per-tick-nollningen sker :3441. **B6**: vid TARGET_END nollas
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
   :2432–2445); **stale-guard**: AIS nere >2 min ⇒ STALE_DATA_OVERRIDE_TEXT
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
(:5395); `aisClient.disconnect()` (:5400); slutlig flush av ENBART
`persistent_recent_triggers` (:5406 — namncachen och last_known_positions litar
på write-through + monitoring); removeAllListeners + lyssnare av (:5411–5435).

## 7. Replay-/testharnessen (tests/replay-validation/)

Permanent valideringsverktyg — kör den RIKTIGA appen mot inspelad AIS-jsonl.
- `replayRunner.js`: v2 med @sinonjs/fake-timers — klockan driver BÅDE Date.now
  och timers (`clock.tick(gap)` mellan samples, :89–92, :214–215); setImmediate/
  nextTick hålls äkta. Init KRÄVER `__TEST_MODE__=true` (:95; av före uppspelning
  :206–207). Notisfångsten bär name/distance/source (:307–327) +
  positionsberikning (närmaste sampel före/efter per mmsi → vesselLat/Lon/LatNext
  :329–354; firstNameSeen :358–365) för INV-8/11/15. `ctrl:'restart'` = äkta
  processomstart (:246–264): `onUninit()` → `new AISBridgeApp()` → `onInit()`;
  persistensen återläses ur samma mock-settings; notiser samlas över instanserna.
- `corpora.js`: **8 låsta korpusar (~101,5 h** = 4+41+1+4+19+11+2+19,5) med
  `expectedNotifications` + motiverad `note` vid omlåsning = **facit**;
  `corpora-distribution.json` låser fördelningen per fartyg+bro. Data i `../logs/`.
- `invariants.js`: facit-OBEROENDE sanningskontroller **INV-1…INV-18**. Fatala:
  INV-1…14 + INV-16 (`validateInvariants`; INV-8 namnkvalitet/INV-11
  distansrimlighet/INV-16 ETA-fysik <30 kn SKÄRPTES från WARN 2026-07-03). WARN:
  INV-15/17/18 (`validateWarnInvariants`, kalibrerade: INV-15 riktning-vs-geografi
  ~220 m (0,002°); INV-17 textflappbudget max(40, 24×antal fartyg)/h; INV-18
  mjuk ETA-monotoni ≥8 min inom 15 min).
- `scenarioGenerator.js` + `runSyntheticScenarios.js`: seedade syntetiska resor
  genom riktig brogeometri — **35 scenarier**; `nameFromS` (:139–142) simulerar
  sen namn-backfill: "Unknown" sänds tills t ≥ nameFromS s (VALEN-klassen).
- `runSoak.js`: separat 72 h-soak (seed 46: 2 kajliggare + 36 genomresor, 2
  avbrott + 2 äkta restarts); bedömer STABILITET (0 processfel, inga läckor,
  fatala invarianter rena, ≥5 notiser/fullbordad resa) — inte facit. Körs
  manuellt (`node tests/replay-validation/runSoak.js`; medvetet inget npm-script).
- Körs: `npm run replay:all` / `npm run replay:synthetic`.

## 8. KÄNDA FÄLLOR

**(a) De två explicita fältlistorna.** Vesselobjektet BYGGS OM vid varje
AIS-meddelande (`_createVesselObject`, VDS:2633–2865) och SNAPSHOT:as vid removal
(`vesselSnapshot`, VDS:625–664). Fält som inte uttryckligen kopieras **raderas
tyst**. SJU kända offer: (1) `passedAt` m.fl. i `_createVesselObject`
(2026-06-13, VDS:2725–2730); (2) ålderfälten `timestamp`/`lastPositionUpdate`/
`_lastSeen` i snapshotten — gjorde F63-exit-vakten till död kod (CLABBYDOO,
VDS:648–655); (3) `_isImminentAtTargetBridge` (echo-flappen, VDS:2740–2746);
(4) `name` vs `shipName` i snapshotten — exit-notiser hette alltid "Unknown"
(VDS:634–637); (5) `_etaExhaustedAtMs` i `_createVesselObject` — 90 s-fönstret
började om varje meddelande (VDS:2860–2861); (6) `maxRecentSpeed`/`passedAt` i
snapshotten — RC3-stale-gaten degraderade till momentan sog (SILJA-klassen,
VDS:656–663); (7) `currentBridge`/`distanceToCurrent` i `_createVesselObject` —
**CBM-hysteresens rotorsak**: fälten var undefined varje tick så hela
500/600 m-hysteresen var död (VDS:2788–2793). Fältlistan bär numera även
`_underBridgeFrozenAccMs` (:2787), `_underBridgeEntryLat/Lon` (:2796–2797) och
`_pendingTarget` (:2765). **REGEL: varje nytt fält som konsumeras efter removal
eller över meddelandegränser MÅSTE läggas till i BÅDA fältlistorna.**

**(b) OneDrive gör lint långsamt.** Kör eslint per fil, inte över hela trädet.

**(c) Jest fyller disken.** Pipa `npm test` till en sammanfattning (t.ex.
`| tail`), annars ENOSPC av verbose-utskrifterna.

**(d) Source-fältlistan för Flow-state.** Trigger-state är
`{ bridge, mmsi, distance, source }` (app.js:4546) med source-värdena
`target | current | nearest | just-passed | trigger-point | passage-fallback`
(§3). Replay-invarianterna och run-listenern (:4743) konsumerar dessa — nya
source-värden/state-fält måste synkas med invariants.js, annars felklassas
notiser i valideringen.

## 9. Granskningsfynd (kvarvarande avvikelser i KODEN)

Kvarvarande kod-skönhetsfel (funna vid helrevisionen 2026-07-05):

1. **Stale loggrad**: app.js:1332 loggar "scheduling removal in 60s" men timern
   använder PASSED_HOLD_MS = 150 s (constants.js:330); bara loggsträngen ljuger.
2. **Vilseledande variabelnamn**: `_persistRecentTriggers` (app.js:505) itererar
   `[key, ts]` (:514) där `ts` numera är `{t, dir}`-objekt.
3. **Stale korpussumma**: runAllCorpora.js:4 säger "~65h", manifestet summerar
   101,5 h (banret räknar dynamiskt och skriver rätt).
4. **Offer-numreringen hoppar över 5**: koden märker 4:e/6:e/7:e offret
   (VDS:634/656/2788); 5:e (`_etaExhaustedAtMs`) är bara belagt i
   tests/bridge-text-livscykel-b4b5b6.test.js:72 ("5:e offret-vakt").

Åtgärdat sedan 2026-07-03: "Fem lager"-kommentaren rättad (constants.js:193);
MessageBuilder/ETAFormatter/StallbackabronHelper raderade — noll levande
förekomster (grep 2026-07-05); `shouldDebounceBridgeText` numera privat i
SystemCoordinator, ingen publik `hasActiveCoordination`.
