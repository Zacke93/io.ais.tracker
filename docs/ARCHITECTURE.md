# ARCHITECTURE.md — AIS Tracker (io.ais.tracker)

Varaktig arkitekturkarta, byggd genom verifierande läsning 2026-07-03.
Alla fil:rad-hänvisningar är kontrollerade mot koden samma dag
(app.js = 5158-radersversionen, mtime 14:02; VesselDataService.js = 13:57-versionen).
Radnummer prefixade med `~` är lästa men kan glida vid framtida redigering.
Ersätter CODEX.md och docs/recentChanges.md (raderade 2026-07-03, användarbeslut —
de beskrev en borttagen fas-modell).

## 1. Översikt & modulgraf

```
AISstream.io (WebSocket)
   │ ais-message / static-name / connected / disconnected / reconnect-needed
   ▼
AISStreamClient (lib/connection/AISStreamClient.js)
   ▼
app.js  _onAISMessage → _processAISMessage (app.js:1772)
   ▼ updateVessel(mmsi, patch)
VesselDataService (lib/services/VesselDataService.js)
   │ events: vessel:entered / vessel:updated / vessel:removed / vessel:journey-reset
   ▼
app.js händelsehanterare (_onVesselEntered:735, _onVesselUpdated:789, _onVesselRemoved:988)
   ├─→ StatusService.analyzeVesselStatus (status/ETA) ── status:changed → _onVesselStatusChanged:1161
   ├─→ ProximityService.analyzeVesselProximity (avstånd/zoner)
   ├─→ boat_near-Flow-vägarna (§3)
   └─→ _updateUI → coalescing → _processUIUpdate:2263 → bridge_text-capability + global token
```

Moduler (ansvar / ägda tillstånd / in-ut):

- **AISStreamClient** (lib/connection/AISStreamClient.js): WebSocket-livscykel mot
  AISstream.io. Prenumererar med bounding box över kanalen (:246–255), filtrerar
  meddelandetyper (PositionReport, StandardClassB..., ExtendedClassB...; :379–385),
  extraherar mmsi/lat/lon/sog/cog/navStatus/shipName i `_extractAISData` (:462–510,
  avvisar 0,0-koordinater). Äger reconnect-tillstånd (progressiva delays, medium
  5 min ×12, slow 60 min; :516–521), ping/pong-watchdog (`_awaitingPong` :35).
  Emitterar `connected`, `disconnected`, `ais-message`, `static-name` (typ 5/24-namn,
  :362–373), `auth-error`, `error`, `reconnect-needed`, `max-reconnects-reached`.
- **app.js (AISBridgeApp)**: orkestrering, Flow-kort, UI-publicering, notisdedupe,
  persistens, monitoring. Äger `_triggeredBoatNearKeys` (session-Set, :~181),
  `_persistentRecentTriggers` (2h-Map, :~189), `_knownVesselNames` (namncache, :204–206),
  `_vesselRemovalTimers`, `_processingRemoval`, coalescing-tillstånd (:4961–).
  Services instansieras :274–333 (SystemCoordinator, BridgeRegistry, VesselDataService,
  ProximityService, PassageLatchService, GPSJumpGateService, RouteOrderValidator,
  StatusService, BridgeTextService, AISStreamClient).
- **VesselDataService** (VDS): sanningskälla för fartygstillstånd. `updateVessel`
  (:92) bygger om vesselobjektet varje meddelande via `_createVesselObject` (:2664–2874,
  EXPLICIT fältlista — se §8a), kör förtöjningsdetektering (:129–139), Fix D-U-sväng
  (:141–230), målbrologik (`_shouldAssignTargetBridge`:1798, `_calculateTargetBridge`:2071,
  `_handleTargetBridgeTransition`:2268, `_applyTargetTransition`:2437), passage-detektering
  (`_hasPassedBridge`:3659, `_hasPassedTargetBridge`:2999), target-protection (:3938–4033),
  GPS-jump-hold (`setGpsJumpHold`/`hasGpsJumpHold`:4559/4576), removal + snapshot (:507–698),
  RC7-presentationsfiltret (`getVesselsForBridgeText`:1210–1330).
- **StatusService**: statusmaskinen (`analyzeVesselStatus`:73, prioritetsordning
  under-bridge > passed > waiting > stallbacka-waiting > approaching > en-route,
  :173–247), under-bridge-hysteres (:409–580), ETA via ProgressiveETACalculator.
  Äger StallbackabronHelper, CurrentBridgeManager, StatusStabilizer,
  PassageWindowManager, ProgressiveETACalculator (:27–44). Emitterar `status:changed`.
- **ProximityService**: stateless avståndsanalys fartyg↔broar (`analyzeVesselProximity`),
  bridgeDistances/nearestBridge.
- **SystemCoordinator**: koordinerar GPS-analys/stabilisering; räknar distinkta
  "jumpers" (C4) i stället för råa händelser (SystemCoordinator.js:~20–30).
- **GPSJumpGateService**: blockerar passage-detektering under GPS-hopp;
  tvåstegsbekräftelse candidate→confirm, 30 s gate-timeout. Anropas från VDS
  (:3029–3040, :3661–3672).
- **PassageLatchService**: latch per båt+bro som blockerar retrograda statusar
  ("tidsresor"); 10 min latch-timeout. Konsumeras av StatusService via
  `shouldBlockStatus` (StatusService.js:712, 786, 852, 900, 1116).
- **RouteOrderValidator**: avvisar fysiskt omöjlig broordning per riktning.
- **StatusStabilizer**: hysteres/konfidens vid GPS-osäkerhet (2 konsekutiva
  avläsningar för statusbyte).
- **VesselLifecycleManager**: resekomplettering/eliminering; terminalgränser
  KANALINFARTEN_EXIT_LAT 58.2653 / STALLBACKABRON_EXIT_LAT 58.3141.
- **CurrentBridgeManager**: robust `currentBridge`-spårning, SET 500 m/CLEAR 600 m.
- **BridgeTextService**: ren funktion vessels→text (§5).
- **Utils**: `geometry` (haversine, distancePointToSegmentM), `MessageBuilder` +
  `CountTextHelper` (svenska räkneord), `ETAFormatter`/`etaValidation`
  (isValidETA, formatETABroOpeningClause = SSOT för ETA-klausulen),
  `StallbackabronHelper` (numera minimal: `isStallbackabron`), `PassageWindowManager`
  (passagefönster/grace), `GPSJumpAnalyzer` (hopp vs äkta manöver).

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
  :117–124: 58.268003/12.269365, radius 300 m) — triggar boat_near-Flow men ingår
  inte i brotext/status. Ligger inte i BridgeRegistry (uppslag sker direkt i
  TRIGGER_POINTS, app.js:~3688, ~3982).
- `BRIDGE_GAPS` (:244–249): olide–klaff 950 m, klaff–järnväg 960 m,
  järnväg–strids 420 m (kortast, kritisk timing), strids–stallbacka 2310 m.
- `MOORING_ZONES` (:216–227): kapsel (centrumlinje + 30 m halvbredd) för
  "Kajen norr om Klaffbron" (190–295 m från bron, mitt i väntzonen).
  `MOORING_DETECTION` (:204–210): STATIONARY 0.3 kn, MOVEMENT_PROOF 0.5 kn/50 m,
  navstatus 1/5, 2h-backstop.
- Stallbackabron-specialregler i `STALLBACKABRON_SPECIAL` (:343–348): aldrig
  "inväntar broöppning"; egen status `stallbacka-waiting`.

## 3. Dataflödet AIS→notis (boat_near)

Inflöde: `_processAISMessage` (app.js:1772) validerar (:1776, `_validateAISMessage`
:~1856: mmsi/lat/lon/sog≤100/cog-normalisering/0,0-avvisning), normaliserar sog/cog/
navStatus till null vid okänt, injicerar namncachen (B1, :1804–1815: riktigt namn
registreras, "Unknown" ersätts med cachat namn) och anropar `VDS.updateVessel` (:~1842).

### De FYRA notisvägarna

1. **Proximity** — `_triggerBoatNearFlow` (app.js:3509). Anropas från
   `_onVesselEntered` (:749, om targetBridge), `_onVesselUpdated` (:904, om
   current/target/finalTarget) och `_onVesselStatusChanged` (:1166–1175, vid
   övergång till waiting/stallbacka-waiting). Egna gater i ordning: test-läge →
   `_moored` (:~3527) → rörelsebevis (RC-S3: `_hasMovementProof` eller sog ≥ 0.5,
   :~3539) → GPS-jump-hold (:~3550) → stale-AIS >10 min på MOTTAGNINGS-tid (F5,
   :~3563) → kandidatval (`_getFlowTriggerCandidates`:3776) → per kandidat
   `_triggerBoatNearFlowForBridge` (:4150).
2. **Passage-fallback** (BUG C) — `_onVesselUpdated` :~925–932: nyregistrerad
   passage (`lastPassedBridge` stämplad <2000 ms sedan; N5 jämför namn ELLER
   tidsstämpel) → `_triggerBoatNearFlowFallback(vessel, lastPassedBridge)` (:3984).
3. **Backfill** — `_onVesselUpdated` :~939–946: `vessel._passageBackfills[]`
   (fylls av RC9-/gap-inferens i VDS, `registerConfirmedIntermediatePassage`
   VDS:3482–3484) töms och varje bro begärs via `_triggerBoatNearFlowFallback`.
4. **Exit/removal** — `_onVesselRemoved` (:988) → gate :1031–1041 (giltiga
   koordinater + `_finalTargetDirection === 'south'` + `_finalTargetBridge`) →
   `_triggerExitPointFallback` (:3909): F63-stale-vakt ≤25 min på
   `lastPositionUpdate` (:~3928), ≤400 m från Kanalinfarten (:~3941), fartyget
   norr om punkten (:~3947), session- + persistent-dedupe (:~3950–3968) →
   `_triggerBoatNearFlowFallback(vessel, 'Kanalinfarten')`.

### `_checkSkippedBridgesFallback` (app.js:3626)

Körs vid entered (:~755) och updated (:911). Kräver sog ≥ 2.0, ej `_moored`, ej
GPS-hold, cog tydligt N (≥315/≤45) eller S (135–225). Target-gaten är BORTTAGEN
(SY FREYJA 2026-07-02: mållösa återfödda båtar ska också fångas).

- **Scenario A (new-vessel, oldVessel=null)**: antar start från kanalport
  (58.265 syd / 58.32 nord) — UTOM när första positionen ligger i/nära en
  förtöjningszon (**N7-kajvakten**: `isNearMooringZone(_firstSeenLat/Lon, 100)`,
  :~3678–3695; då begränsas intervallet till kajen så broar bakom kajen inte
  falsknotifieras).
- **Scenario B (large-jump, |Δlat| > 0.005 ≈ 550 m)**: broar mellan gamla och nya
  lat. Fallback anropas med `{ detectionTs: Date.now() }` (N3, :~3744) så
  stale-fönstret räknas från detektionsögonblicket. Dessutom appliceras passagen
  i VDS via `applyInferredPassage` (:~3761 → VDS:3502–3522): målbro → äkta
  måltransition, mellanbro → `registerConfirmedIntermediatePassage` (med
  RC9-inferens om bron ligger bortom target).

### Gate-kedjan i `_triggerBoatNearFlowFallback` (app.js:3984–4119)

I ordning: (0) GPS-jump-hold (:~3990) → (1) **persistent dedupe** 2h
riktningsmedveten (:~4043) → (2) **2000 m-tak** FALLBACK_HARD_MAX_DISTANCE
(:~4053) → (3) **stale**: exakt känd tid (`passedAt[bro]`/detectionTs,
max-väljare för "när VI fick veta") > 300 s ⇒ skip; annars skattning
distans/maxRecentSpeed (RC3) > 300 s ⇒ skip (:~4076–4119) → (4) **low-sog**:
stillastående (≤0.5 kn) utan tidsreferens och >500 m ⇒ skip (:~4120–4131).
Passerar allt → `_triggerBoatNearFlowForBridge` med `source: 'passage-fallback'`.

### Kandidat-urval och source-värden (`_getFlowTriggerCandidates`, app.js:3776)

Tröskel 300 m (FLOW_CONSTANTS.FLOW_TRIGGER_DISTANCE_THRESHOLD). Källor:
`target` → `current` → `just-passed` (15 s grace efter passage) → `nearest`
(endast om inga andra) → `trigger-point` (Kanalinfarten, egen distansberäkning).
Finns target-kandidat: target dominerar, MEN target + current/nearest/just-passed
får båda trigga när de är olika broar (Fix 7, Järnvägs/Strids-överlappet).
Femte/sjätte source-värdet `passage-fallback` sätts av fallback-vägen (:~4137).

### `_triggerBoatNearFlowForBridge` (app.js:4150) och dedup-lagren

1. **Session-Set** `_triggeredBoatNearKeys` ("mmsi:Bro", :4158). Rensas per
   fartyg vid journey-reset/NEW_JOURNEY (`_clearBoatNearTriggers`:4307; med
   `clearPersistent=true` rensas även 2h-mappen), vid statuslämning utan aktiv
   resa (:1181–1189), vid removal utan aktiv resa (:1020–1025, BUG 7 bevarar vid
   timeout+aktiv resa) och för döda mmsi i monitoring-loopen.
2. **Persistent 2h-Map** `_persistentRecentTriggers`: post `{t, dir}`;
   `_persistentDedupCheck` (:449–467) blockerar ENDAST i samma färdriktning
   (motsatt riktning = ny passage, ELFKUNGEN-fallet); riktning saknas ⇒
   konservativ blockering. Kontrolleras i huvudvägen (:4174), fallback (:~4043)
   och exit (:~3961). Skrivs vid varje mutation (§6), rollback vid triggerfel
   (:4283–4290).

Tokens: `vessel_name` (B1: känt namn → cache-uppslag → "Okänd båt", :4188–4193),
`bridge_name`, `direction` (`_getDirectionString`: låst `_routeDirection` först,
annars breddat COG-band — P5-beslut), `eta_minutes` (target-källa = målbro-ETA;
övriga källor = dist/fart mot den notifierade bron; `passage-fallback`/`just-passed`
⇒ -1; nära+långsam icke-target ⇒ -1; :4203–4227).

**Trigger-state (NY form, :4271–4273):**
`{ bridge: bridgeId, mmsi: vessel.mmsi, distance: Math.round(distance), source }`
— mmsi låter en "Any bridge"-flow begränsas till en notis per resa; distance/source
konsumeras av replay-invarianterna (distansrimlighet, inferens-särskiljning).

## 4. Tillståndsmaskiner

### Target-livscykeln (VDS)

- Tilldelning: `_shouldAssignTargetBridge` (:1798, kräver bl.a. rörelsebevis,
  ej `_moored`) → `_calculateTargetBridge` (:2071, COG-riktning + position).
- Transition: `_applyTargetTransition` (:2437–2525). `previousTarget` läses från
  det LEVANDE objektet (S-F3-följdfixen, :2447). Vid byte till nästa bro:
  targetBridge muteras, `_finalTarget*` nollas och **hela ETA-serien nollställs**
  (:2472–2481: etaMinutes, `_etaPublishedValue`, `_etaIsExtrapolated`,
  `_etaExtrapolationExhausted`, `_etaExtrapolationBaseMs/Value`,
  `_positionUpdatedSinceLastETA=true`, `_isImminentAtTargetBridge=false`) +
  `clearVesselETAHistory` (:2497). Riktning låses (`_lockRouteDirection`:2483).
  Vid TARGET_END (:2503–2524): targetBridge=null, `_finalTargetBridge`/
  `_finalTargetDirection` sätts, spårning fortsätter mot Stallbackabron resp.
  Olidebron+Kanalinfarten. Passagen ankras (`_anchorPassageTimestamp`:2533)
  med RC9-kronologivakt (:2551–2556).
- **Target-protection** (`_checkTargetBridgeProtection`, VDS:3938–4033).
  Aktivering (:3981–3999) om något av: ≤300 m från target; GPS-event
  (`_gpsJumpDetected`/`_positionUncertain`/rörelse >200 m, :4039–4061); manöver
  (COG-ändring >45°, :4067–4078); passage <60 s sedan; koordination aktiv. Aktiv
  protection ÅTERSTÄLLER targetBridge om något ändrat den (:4023–4029).
  Deaktivering (`_shouldDeactivateProtection`:4136–4170): >5 min alltid; >500 m
  från target + inga event + >1 min; GPS löst + >30 s; koordination löst + >15 s.
- U-sväng: Fix D (VDS:141–230, sog ≥ 2.0, 2-observations-debounce
  `_fixDPendingReversal`) nollar target mitt i resan; `vessel:journey-reset`
  låter app-lagret rensa båda dedup-lagren (app.js:~669). Post-resa: NEW_JOURNEY
  (app.js:~828–880, samma debounce via `_newJourneyPending`) nollar
  passedBridges + dedupe för returresan.

### Passage-latch + under-bridge-hysteres (StatusService)

- `_isUnderBridge` (:409–580). Syntetiskt broöppningsfönster `_bridgeOpeningUntil`
  håller under-bridge (30 s, distansventil >300 m rensar; :411–459).
  Hysteres: SET ≤50 m, CLEAR <70 m (:514–517, :562–564; konstanter
  constants.js:52–53). **10-min force-clear** (:482–498): latchad under-bridge
  äldre än UNDER_BRIDGE_MAX_DURATION_MS = 10 min → latch släpps och `return false`
  (kritiskt: annars re-sättes latchen omedelbart). FIX O (:520–543) kräver att
  "inväntar" visats mellan par-broarna Järnvägs/Strids.
- PassageLatchService blockerar retrograda waiting/approaching/stallbacka-statusar
  efter registrerad passage (StatusService:712, 786, 852, 900, 1116); latchar
  rensas vid removal (VDS:735–737).

### Förtöjningslagren (VDS `_updateMooringEvidence`, :1633–1757)

1. **Rörelsebevis** (klistrar): sog ≥ 0.5 kn direkt; nettoförflyttning ≥50 m
   kräver 2 konsekutiva prover, GPS-flaggade prover räknas inte (S-F5, :1636–1668).
   Utan bevis: ingen målbro och ingen notis (RC-S3, app.js:~3539).
2. **Demotering, inte borttagning**: `_moored` + target ⇒ target rensas
   (VDS:130–139), fartyget behålls (ingen re-entry-churn).
3. **Navstatus**: 1 (ankar)/5 (förtöjd) + stillaliggande (:1711–1713).
4. **Kajzon**: stationär i MOORING_ZONE kräver stillhetsTID — 3 min normalt,
   **15 min** för trolig köare (target inom 600 m + rörelsebevis) (:1715–1741).
5. **2h-backstop**: stationär > MAX_STATIONARY_WAIT_MS (:1743–1747).
   Släpp-hysteres: tydlig avgång (≥0.5 kn) direkt; gråzon kräver 2 prover
   (:1683–1698); navstatus-flap ensam släpper inte (:1705–1710).

### ETA-extrapoleringens tillstånd (app.js `_reevaluateVesselStatuses`, :3101–3347)

Flaggor (persisteras i `_createVesselObject`, VDS:2867–2870): `_etaIsExtrapolated`,
`_etaExtrapolationExhausted`, `_etaExtrapolationBaseMs/Value`, `_etaPublishedValue`,
`_isImminentAtTargetBridge`. Flöde per omvärdering (30 s-watchdogen driver):
- Färskt rent sampel ⇒ `calculateETA` + RC4-dämpning mot publicerat värde
  (`_reconcilePublishedETA`:1943), extrapolationstillståndet nollas (:~3151–3163).
- Stale 5–10 min (Fix G) ⇒ extrapolera ned (kräver sog ≥ 1.0 kn; :~3185–3215);
  når den 0 ⇒ `_etaExtrapolationExhausted = true` (visar "strax" i st.f. "okänd").
- Stale >10 min ⇒ ETA null + flaggor rensas (Anomali 3-säkerhetsval; gatas på
  `lastPositionUpdate`, F40 medvetet).
- Fix H imminent (:~3240–3337): target + färsk AIS + ej GPS-hold + ≤300 m ⇒
  `_isImminentAtTargetBridge = true`; **IMMINENT_SET_EXHAUSTED**: exhausted-flaggan
  + `distToTarget <= 500` m ⇒ imminent trots >300 m (:3316–3321; övre gräns 500 m
  infördes 2026-07-02). Echo-gate: GPS-osäkert sampel behåller föregående
  imminent-läge (:~3255–3262).

## 5. bridge_text-pipelinen

1. **RC7-presentationsfiltret** (VDS `getVesselsForBridgeText`:1210–1330):
   fartyg vars senast MOTTAGNA data är äldre än nivågränsen döljs (behålls internt).
   Nivåer: (a) nära-stilla vid sista kontakt (sog < 1.5) ⇒ 25 min;
   (b) kö-klassen (sog < 3.0 OCH ≤600 m från närmaste bro) ⇒ 25 min;
   (c) mitt-i-passage (≤300 m från MÅLBRON) ⇒ 20 min; (d) annars (SABETH-klassen,
   rörlig långt från broar) ⇒ 10 min (:1252–1276). Därefter: giltig målbro eller
   nära Stallbackabron eller i 180 s passagefönster (:1279–1312), ankringsfilter
   (:1315) och relevant status (:1321–).
2. **Projektion** (app.js `_findRelevantBoatsForBridgeText`:3353–3415): explicit
   fältlista till BridgeTextService inkl. `_etaIsExtrapolated` och
   `_isImminentAtTargetBridge` (F4 — fälla, se §8a).
3. **BridgeTextService** (lib/services/BridgeTextService.js, 186 rader, stateless):
   **Variant-1-grammatiken** — en fras per målbrogrupp:
   `"[Räkneord] [båt|båtar] på väg mot [Klaffbron|Stridsbergsbron], [ETA-klausul]"`
   (:125–141). Endast målbroar nämns. ETA-klausul via `formatETABroOpeningClause`
   (SSOT, etaValidation): ogiltig ⇒ "ETA okänd"; <3 min ELLER imminent ⇒
   "beräknad broöppning strax" (imminent gäller HELA gruppen, F45 :134);
   ≥3 min ⇒ "om N minuter" (extrapolerad ⇒ "om cirka N minuter").
   Lead-båt = lägst giltig ETA, annars kortast distans (:151–165).
   Multi-target-separator "; ", Klaffbron först (:98–109). Tom input ⇒
   DEFAULT_MESSAGE ("Inga båtar är i närheten av Klaffbron eller Stridsbergsbron").
4. **UI-coalescing** (app.js): `_updateUI`:2009 → `_scheduleCoalescedUpdate`:2017
   (micro-grace 15/25/40 ms per signifikans; critical/immediate bypassar;
   high-event krymper väntetiden till 10 ms). `_actuallyUpdateUI` kan lägga
   200 ms micro-grace + omsnapshot. 30 s-watchdog driver självläkning (:~4975).
5. **Publicering** (`_processUIUpdate`:2263): F29-vakt (GPS-hållen ensam båt ⇒
   behåll förra texten, :~2286–2305); summary-validering; **stale-guard**: AIS
   nere >2 min ⇒ texten ersätts med STALE_DATA_OVERRIDE_TEXT ("AIS-anslutning
   saknas — data kan vara inaktuell", :64, :2332–2345) och alarm_generic tvingas
   AV (C8, :~2427); hash-dedupe (`_lastBridgeTextHash`) + 60 s tvångsrefresh
   (ej vid passed-fartyg); loggtaggar UI_UPDATE (ändrad) vs UI_REFRESH (RC6).
   Skriver `bridge_text`, `connection_status`, `alarm_generic` (capabilities i
   drivers/bridge_status) + global token `global_bridge_text` (:~4462).
   Specialfall sista båten borta: DEFAULT tvingas + hash synkas (F25, :1074–1107);
   P8: sista båten borta MEDAN AIS nere ⇒ behåll texten (:1064–1073).

## 6. Persistens (homey.settings)

| Nyckel | Läses | Skrivs | Innehåll |
|---|---|---|---|
| `debug_level` | app.js:132, :358–368 | Homey-UI | 'basic'/... loggnivå; settings-listener :~358 |
| `ais_api_key` | :~375, :~1689 (connect) | Homey-UI | API-nyckel; ändring ⇒ `reconnectWithKey` (F8, :370–390) |
| `persistent_recent_triggers` | `_loadPersistentTriggers`:402–433 | `_persistRecentTriggers`:491–507 | 2h-notisdedupe `{ "mmsi:Bro": {t, dir} }` |
| `known_vessel_names` | `_loadVesselNames`:515–540 | `_persistVesselNames`:547–570 | B1-namncache `{ mmsi: {name, t} }`, 30 d TTL, max 200 poster |

Mönstret (mall för framtida cacher): ladda i konstruktorn med expiry-filter och
defensiva guards; **write-through vid varje mutation** (låg skrivfrekvens);
rollback vid misslyckad operation (:4283–4290); TTL-städning i monitoring-loopen
(`_setupMonitoring`:4883, intervall 60 s: rensar döda mmsi ur session-Set:en,
utgångna 2h-poster + persist, samt kör `_checkAISFeedHealth` B2-watchdogen,
:~4894–4940); slutlig flush i `onUninit` (:~5000). Migrationsvänlig läsning:
gamla talposter accepteras jämte nya `{t, dir}` (:404–416).

## 7. Replay-/testharnessen (tests/replay-validation/)

Permanent valideringsverktyg — kör den RIKTIGA appen mot inspelad AIS-jsonl.
- `replayRunner.js`: v2 med @sinonjs/fake-timers — klockan driver BÅDE Date.now
  och timers (`clock.tick(gap)` mellan samples) så cleanup/STALE_AIS/monitoring
  fyrar som i drift; setImmediate hålls äkta för microtask-dränering (:1–30).
- `corpora.js`: manifest med 7 korpusar; `locked` + `expectedNotifications` +
  motiverad `note` vid omlåsning = **facit**. Jsonl/prodloggar bor i `../logs/`.
- `corpora-distribution.json`: fördelningslåsning per fartyg+bro (inte bara antal).
- `invariants.js`: facit-OBEROENDE sanningskontroller INV-1…INV-14 (grammatik,
  notiskvalitet/dubbletter, ETA-sågtand, count-degradering, journey⇒notis,
  sluttext-DEFAULT, notis-timing ≤60 s, klausulstruktur, strax-zombie m.fl.).
- `scenarioGenerator.js` + `runSyntheticScenarios.js`: seedade syntetiska resor
  genom riktig brogeometri (situationer som aldrig förekommit i korpus).
- Körs: `npm run replay:all` / `npm run replay:synthetic`.
- KÄND fidelitetsbrist historiskt löst i v2; kvarvarande: se minnesanteckning.

## 8. KÄNDA FÄLLOR

**(a) De två explicita fältlistorna.** Vesselobjektet BYGGS OM vid varje
AIS-meddelande (`_createVesselObject`, VDS:2664–2874) och SNAPSHOT:as vid removal
(`vesselSnapshot`, VDS:621–652). Fält som inte uttryckligen kopieras **raderas
tyst**. Fyra kända offer: (1) `passedAt` m.fl. i `_createVesselObject`
(2026-06-13, VDS:2751–2756); (2) ålderfälten `timestamp`/`lastPositionUpdate`/
`_lastSeen` i snapshotten — gjorde F63-exit-vakten till död kod (CLABBYDOO,
VDS:644–651); (3) `_isImminentAtTargetBridge` (echo-flappen, VDS:2766–2772);
(4) `name` vs `shipName` i snapshotten — exit-notiser hette alltid "Unknown"
(VDS:630–633). **REGEL: varje nytt fält som konsumeras efter removal eller
över meddelandegränser MÅSTE läggas till i BÅDA fältlistorna.**

**(b) OneDrive gör lint långsamt.** Projektet ligger i OneDrive-synkad katalog —
kör eslint per fil, inte över hela trädet.

**(c) Jest fyller disken.** Pipa `npm test` till en sammanfattning (t.ex.
`| tail`), annars ENOSPC av verbose-utskrifterna.

**(d) Source-fältlistan för Flow-state.** Trigger-state är numera
`{ bridge, mmsi, distance, source }` (app.js:4271–4273) med source-värdena
`target | current | nearest | just-passed | trigger-point | passage-fallback`
(§3). Replay-invarianterna och ev. run-listener-filter konsumerar dessa — ett
nytt source-värde eller state-fält måste synkas med invariants.js och
Flow-kortets förväntningar, annars felklassas notiser i valideringen.

## 9. Granskningsfynd (avvikelser funna vid läsningen)

1. **app.js redigerades under granskningen** (mtime 14:00 → 14:02 2026-07-03;
   4985 → 5113 → 5158 rader: B1-namncachen + "Okänd båt"-tokenfallbacken).
   Uppdragets/minnets äldre radnummer (persistens "392–497", gate-kedjan
   "3870–3990", IMMINENT "3163", TTL "4757", trigger-state "~4110") är
   förskjutna ca +120–160 rader; detta dokuments nummer avser 5158-versionen.
2. **Stale kommentar om removal-fönstret**: app.js:~1211 loggar "scheduling
   removal in 60s" och :~1228 kommenterar "60 sekunder enligt spec", men timern
   använder `PASSAGE_TIMING.PASSED_HOLD_MS` = 150 000 ms = 2,5 min
   (constants.js:330). Koden vinner; kommentarerna bör rättas.
3. **Stale lagerräkning i constants.js**: kommentaren :193–196 säger "Fyra
   lager" men listar och koden implementerar FEM (rörelsebevis, demotering,
   navstatus, kajzon, backstop).
4. **Variabelnamn kvar från gammalt format**: `_persistRecentTriggers`
   (app.js:500) itererar `[key, ts]` där `ts` numera är `{t, dir}`-objekt —
   fungerar (JSON-serialisering), men namnet vilseleder.
5. **Fjärde settings-nyckeln**: `known_vessel_names` (B1, 2026-07-03) fanns inte
   i uppdragsbeskrivningens lista (debug_level/ais_api_key/persistent_recent_triggers)
   — dokumenterad i §6.
6. **Removal-snapshotten** är VDS:621–652 (inte 621–649) — utökad med name- och
   ålderfälten efter fältlist-offren 2/4.
7. **Stale radhänvisning i BridgeTextService**: kommentaren "API stability with
   app.js:597" (BridgeTextService.js:43) — anropsplatsen är numera app.js:~1052.
8. **StallbackabronHelper är i praktiken tom** (endast `isStallbackabron`) trots
   att StatusService fortfarande instansierar den (:34) — kandidat för borttagning.
