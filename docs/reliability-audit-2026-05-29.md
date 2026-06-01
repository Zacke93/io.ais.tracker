Both critical findings (F8 settings listener only handles debug_level; F4 projection drops the two imminent/extrapolated flags) are confirmed in the live code. The findings are well-grounded. I have everything needed to write the report.

# Tillförlitlighetsrapport — Homey AIS-app

## Sammanfattning

Appen är **inte produktionsredo**. Två av de 26 verifierade fynden är kritiska och slår direkt mot appens grundfunktion: ett byte av API-nyckeln i inställningarna leder aldrig till återanslutning (F8), och en korrekt flerbåts-bridge_text underkänns systematiskt och degraderas till "N båtar är i närheten" (F16). Utöver dessa löper fyra systemiska teman genom fynden: (1) **anslutningsresiliens** — en half-open WebSocket upptäcks aldrig (F1) och avsiktlig disconnect schemalägger en zombie-reconnect (F3); (2) **dedupe-läckor i notispipelinen** — en misslyckad trigger förgiftar 2h-dedupen (F6), huvudvägen läser aldrig persistent-dedupen (F34), och "any"-flows spammar (F7, F35); (3) **async-race och flagg-/fält-bortfall i publiceringsvägen** — imminent/extrapolated-flaggor tappas i objekt-projektionen (F4), reentrant status-emit mitt i snapshot-bygget (F5), och fält-namnsglapp som dödar GPS-städning (F14); (4) **ofullständig städning / dead state** — process-lyssnare avregistreras aldrig (F54), GPS-koordination kan fastna permanent (F10), och flera skydd (riktningslås F19, per-lane-dedupe F75, micro-grace F28) är halvimplementerad död kod som ger falsk trygghet.

## Produktionsbedömning

**Dom: Ej redo.**

Motivering per pelare:

- **Pelare 1 (bridge_text):** 1 kritiskt (F16) + 5 höga (F4, F14, F18-relaterat, plus tvärgående F1/F2/F10 som fryser texten). Det kritiska fyndet F16 inträffar i *normal* drift (1 båt vid en bro + ≥2 vid en annan), och F4 kopplar bort hela "strax"/"cirka"-lagret från publiceringsvägen. Textens kärnvärde — rätt bro och rätt ETA precis före broöppning — är inte tillförlitligt.
- **Pelare 2 (boat_near-notiser):** 1 kritiskt (F8, gemensamt med anslutning) + 4 höga (F5, F6, F7) och flera medel (F34, F35, F36). Notiser kan dubbleras (F7, F35), permanent tystas av förgiftad dedupe (F6), eller avfyras på frusen/stale data (F5). Notispelaren är funktionell men har flera vägar till både falska och uteblivna notiser.

Sammantaget: kritiska fel i båda pelarna som triggas i vardaglig drift, inte bara i edge-case. Krav på "Nästan redo" (endast medel/låga kvar, höga åtgärdade) är inte uppfyllt.

## Kritiska & höga fynd

### Bridge-text

**[F16 — KRITISK] ASCII-siffer-regex underkänner korrekt flergrupps-text** — `app.js:2097-2120`
`_extractVesselCounts` matchar antal endast via `/(\d+)\s*(båt|vessel)/gi`, men Variant-1 skriver ordtal ("Två/Tre båtar"). I flergruppstext där en grupp är "En båt" och övriga >1 blir expectedTotal=1, actualCount≥3 → kritiskt underkänt → degraderad fallback "N båtar är i närheten" varje cykel.
*Åtgärd:* gör regexen språkmedveten — summera svenska ordtal (En=1…Tio=10) till `totalMentioned`, alternativt sänk severity till 'warning' när expectedTotal härleds enbart från implicitCount. **Komplexitet: small. Regressionstest krävs.**

**[F4 — HÖG] Imminent/extrapolated-flaggor tappas i objekt-projektionen** — `app.js:2560-2580`
`_findRelevantBoatsForBridgeText` bygger nya plain-objekt som kopierar etaMinutes men INTE `_etaIsExtrapolated`/`_isImminentAtTargetBridge`. `BridgeTextService._buildGroupPhrase` läser dem som `=== true` → alltid false. Imminent-override ("strax") och "om cirka N min" aktiveras aldrig via publiceringsvägen; en stillastående båt 0-300m från bron visar "ETA okänd" i stället för "strax". (Verifierat i live-kod ovan: projektionen saknar båda fälten.)
*Åtgärd:* lägg till de två fälten i return-objektet. **Komplexitet: trivial. Regressionstest krävs** (imminent MED ETA≥3 → "strax", inte "om 4 minuter").

**[F14 — HÖG] GPS-jump skickar undefined movementDistance (fält-namnsglapp)** — `app.js:952-988`
`positionAnalysis` byggs med `{gpsJumpDetected, positionUncertain, analysis}` men raderna 967/976/983 läser `positionAnalysis.movementDistance` (rätt väg är `.analysis.movementDistance`). Följd: `handleGPSJump` får alltid 0 → `clearVesselLatches` triggas aldrig vid >1km-hopp; `clearVesselHistory` körs aldrig. Stale latches blockerar korrekt approaching/waiting på den nya positionen i upp till 10 min.
*Åtgärd:* läs `positionAnalysis.analysis?.movementDistance` på rad 967/976/983/986. **Komplexitet: trivial. Regressionstest krävs.**

### Notiser

**[F6 — HÖG] Misslyckad trigger förgiftar persistent 2h-dedupe** — `app.js:3222-3240`
Session- OCH persistent-nyckel sätts synkront FÖRE `await _triggerBoatNearFlowBest`. Vid reject raderar catch ENDAST session-nyckeln; persistent-nyckeln blir kvar i 2h och läses av alla failsafe-vägar → en notis som *failade* markeras som "nyligen skickad" och tystar skyddsnätet i 2h.
*Åtgärd:* spegla rollbacken — `this._persistentRecentTriggers.delete(dedupeKey)` i catch direkt efter session-delete. **Komplexitet: trivial. Regressionstest krävs** (mocka trigger att rejecta, asserta båda Maps tomma).

**[F7 — HÖG] "any"-flows avfyras en gång per bro (upp till ~6 dubbletter)** — `app.js:3257, 3551-3552, 2730-2732`
`_triggerBoatNearFlowForAny` är död kod (noll anropställen) — enda vägen som sätter "mmsi:any"-nyckeln. Live-vägen loopar bro-kandidater och run-listenern returnerar ovillkorligt `true` för 'any' → en "Alla broar"-flow får en notis per passerad bro i stället för en per resa.
*Åtgärd:* inför journey-scoped `mmsi:any`-grind i `_triggerBoatNearFlowForBridge`; låt run-listenern för 'any' returnera true endast vid `firstOfJourney`. **Komplexitet: small. Regressionstest krävs.**

### Tvärgående

**[F8 — KRITISK] Byte av ais_api_key triggar ingen återanslutning** — `app.js:323-342`
`_onSettingsChanged` reagerar ENBART på `key === 'debug_level'` (verifierat i live-kod ovan). Vid förstainstallation utan/med fel nyckel: när användaren sparar korrekt nyckel görs ingenting, `connect()` anropas aldrig med nya nyckeln. Hela datainflödet (text + notiser) ligger nere tills manuell omstart; UI lovar dessutom felaktigt "Appen försöker nu ansluta...".
*Åtgärd:* lägg gren för 'ais_api_key' som kör `disconnect()` (inkl. `this.apiKey = null` i klienten) följt av `connect(newKey)`. **Komplexitet: small. Regressionstest krävs.**

**[F1 — HÖG] Half-open WebSocket upptäcks aldrig** — `AISStreamClient.js:263-265, 99-103, 210, 373-382`
`_onPong` är no-op, `_startPing` skickar `ws.ping()` var 30:e s UTAN pong-timeout, `lastMessageTime`/`timeSinceLastMessage` har noll konsumenter. Vid TCP half-open fyrar inget close-event → `isConnected` förblir true för evigt, ingen reconnect → permanent död feed efter ~10-30 min staleness-degradering.
*Åtgärd:* pong-baserad liveness-watchdog — `_awaitingPong`-flagga, `ws.terminate()` om pong uteblir (återanvänder befintlig `_onClose`→`_scheduleReconnect`). **Komplexitet: small. Regressionstest krävs.**

**[F3 — HÖG] Avsiktlig disconnect schemalägger zombie-reconnect** — `AISStreamClient.js:68-81, 224-240, 352-366`
`disconnect()` anropar `ws.close()` utan kod (→ 1005/1006, aldrig 1000) och anropar aldrig `_clearTimers()`. `_onClose` ser `code!==1000` → `_scheduleReconnect()` → ny WebSocket öppnas EFTER att appen rivits. `onUninit` rensar aldrig timern/listeners.
*Åtgärd:* `_intentionalClose`-flagga som `disconnect()` sätter och `_onClose` respekterar (early return före reconnect-grenen); komplettera `onUninit` med `removeAllListeners()`+`_clearTimers()`. Uppdatera även test-stubben (RealAppTestRunner.js:22) att emit:a 1006. **Komplexitet: small. Regressionstest krävs.**

**[F2 — HÖG] Half-open kringgår STALE_DATA_GUARD; watchdog re-broadcastar frusen text** — `app.js:1659-1668, 1675-1693, 3935-3946`
STALE_DATA_GUARD kräver `!_isConnected && _lastConnectionLost`; vid half-open (F1) är båda false/null → guarden löser aldrig ut. Watchdogen republicerar frusen/extrapolerad text var 30-60:e s; notis-vägen saknar färskhetsguard helt.
*Åtgärd:* gör guarden datadriven (`Date.now() - aisClient.lastMessageTime > 2 min`) i stället för connection-driven; lägg färskhetsguard i notis-vägen. **Komplexitet: small. Regressionstest krävs** (enhetstest för notis-färskhetsguarden).

**[F5 — HÖG] Reentrant status:changed under UI-snapshot → notis på frusen position** — `app.js:1506, 2344`
`analyzeVesselStatus` emitterar `status:changed` synkront inifrån snapshot-bygget, anropas utan `positionAnalysis` → StatusStabilizer (30s GPS-hold) förbikopplas. En GPS-jump som AIS-vägen höll tillbaka kan flippas av watchdogen → boat_near på undertryckt/frusen position.
*Åtgärd:* lägg AIS-stale-guard i `_triggerBoatNearFlow` (skip om `lastPositionUpdate` för gammal); skicka persistent positionAnalysis i `_reevaluateVesselStatuses`. **Komplexitet: small. Regressionstest krävs.**

## Medel/låga fynd

- **F10 [medel]** `SystemCoordinator.js:386-417` — system-wide GPS-koordination kan fastna permanent (decay nollställs av varje inkommande position; ingen absolut timeout) → all passage-detektering gatas, ~5-6s fördröjning på obestämd tid. *Regressionstest krävs.*
- **F11 [medel]** `GPSJumpGateService.js:131-162` — kandidat "gammal nog men instabil" droppas tyst (varken confirmed/remaining) → bekräftad målbro-passage tappas, fel bro fryser.
- **F40 [medel]** `app.js:2383-2394, 2448` — stale-ETA gateras på `lastPositionUpdate` som fryser för stillastående-men-sändande båt → "ETA okänd"-fladder. *Fix: gatea på `vessel.timestamp` i stället. Regressionstest krävs.*
- **F21 [medel]** `VesselDataService.js:3546-3561, 451-488` — skyddszon (300m) håller kvar målbro nära ALLA broar inkl. mellanbroar → långtidsankrad båt visas som "på väg" i timmar.
- **F25 [medel]** `app.js:720-741` — sista-vessel-borttagning sätter `_lastBridgeText`=default men inte `_lastBridgeTextHash` → dedupe-desync kan frysa texten på DEFAULT (icke-läkande för 'passed'-status). *Fix: sätt även hash + timestamp.*
- **F26 [medel]** `VesselDataService.js:1116-1125, 1170-1179` — 100ms-elimination tystas av BUG 6 anti-shortening-guard → spök-båt kvar 10-20 min i minnet. *Regressionstest krävs.*
- **F34 [medel]** `app.js:3167, 3099` — huvud-proximity-vägen läser aldrig persistent-dedupen → dubbelnotis när vessel återskapas inom 2h (motsatsen till F6; koordinera fix).
- **F35 [medel]** `app.js:2949-2972` — dubbel "any"-notis när Järnvägs-/Stridsbergsbrons 300m-zoner överlappar (target + current i samma tick). *Regressionstest krävs.*
- **F36 [medel]** `app.js:3667-3689` — boat_at_bridge-condition för "Kanalinfarten" alltid false (trigger-point saknas i `proximityData.bridges`); inkonsekvent mot notis-vägen som funkar.
- **F55 [medel]** `AISStreamClient.js:192-218, 321-328` — auth-fel sväljs tyst (filtreras bort), `max-reconnects-reached` saknar lyssnare → oändlig reconnect-loop utan användarsignal. Samverkar med F8.
- **F54 [medel]** `app.js:98-106, 3954-4019` — `process.on('uncaughtException'/'unhandledRejection')` avregistreras aldrig i `onUninit` → MaxListenersExceeded + döda instanser hålls levande över in-process-omstarter. *Regressionstest krävs.*
- **F18 [medel]** `VesselDataService.js:1629-1630 m.fl.` — inkonsekvent syd-definition (COG 46-134/226-314 tvingas 'south') → fel målbro/`_routeDirection` vid sog≥1.5. *Fix: använd tre-vägs `_safeDetermineDirection`.*
- **F13 [medel]** `PassageLatchService.js:77-125` — passage-latch är riktnings-agnostisk → blockerar legitim återgång (U-sväng) vid mellanbro i ~7-min-fönster; `clearLatch` har noll anropare.
- **F29 [medel]** `VesselDataService.js:3674-3701` — `gpsJumpHold` exkluderar fartyget samtidigt ur text+notis+imminent under 2s-fönstret → ensam båt kan flippa texten till DEFAULT. *Fix: behåll `_lastBridgeText` om held vessel finns.*
- **F74 [låg]** `ProgressiveETACalculator.js:769-774` — outlier-fallback blandar in 30% rå-ETA även för bekräftade avvikare → långsam uppåtdrift i smalt edge-case (icke-närmande båt). *Fix: cappa uppåt till conservativeETA.*
- **F45 [medel]** `BridgeTextService.js:128-157` — imminent/extrapolated tas bara från lead-vessel; en icke-lead imminent båt tappar sin "strax". *Fix: `anyImminent`-aggregering. (maskeras av F4 idag).*
- **F41 [låg]** `etaValidation.js:186-201` — grenordning sätter "strax" före extrapolated-grenen → "cirka N min"-markör tappas vid ETA<3 (latent, maskeras av F4).
- **F37 [låg]** `app.js:442-472, 795-894` — `_onVesselEntered`/`_onVesselStatusChanged` saknar yttre try/catch (defense-in-depth; ej reproducerbar idag pga inre skydd + global rejection-handler).
- **F19 [låg]** `VesselDataService.js:3007, 3003, 2141` — `_routeDirectionLockUntil` skrivs men läses aldrig → dött lås, falsk trygghet (Fix D:s debounce gör verkligt jobb).
- **F28 [låg]** `app.js:1570-1571, 2157-2214` — `vessel.lastCoordinationLevel` sätts aldrig → GPS-jump micro-grace + gate-fallback är död kod (ofarlig pga gpsJumpHold-filter).
- **F63 [låg]** `app.js:2995-3029` — exit-point-fallback avfyrar Kanalinfarten-notis upp till 400m bort på potentiellt inaktuell position (geometrisk staleness-guard, ej väggklocka). *Fix: lägg `_lastSeen`-check.*
- **F64 [låg]** `GPSJumpAnalyzer.js:94-130` — fysik-gate kräver >800m → fysiskt omöjliga 500-800m-hopp kan accepteras (well-mitigated nedströms).
- **F70 [låg]** `SystemCoordinator.js:495-498` — `removeVessel` clearTimeoutar inte bridgeTextDebounce-timern; `cleanup()` aldrig anropad → kortlivad self-cleaning timer-läcka.
- **F75 [låg]** `app.js:3932` — `_lastBridgeTexts` per-lane dedupe-Map deklareras men skrivs/läses aldrig → död, vilseledande state. *Fix: ta bort.*

## Föreslagen åtgärdsordning

**Fas 1 — Trivial-fixar med hög utdelning (säkra punktfixar, gör först):**
1. **F4** (trivial) — lägg till 2 fält i projektionen. Återkopplar hela "strax"/"cirka"-lagret. *Regressionstest.*
2. **F6** (trivial) — rensa persistent-nyckel i catch. Stoppar 2h-tystnad av skyddsnätet. *Regressionstest.*
3. **F8** (small) — KRITISK: gren för 'ais_api_key' + `disconnect→connect`. Utan denna kan användaren aldrig rätta nyckeln utan omstart. *Regressionstest.*
4. **F16** (small) — KRITISK: språkmedveten räkning. Slutar degradera korrekt flerbåts-text i normal drift. *Regressionstest.*
5. **F14** (trivial) — läs `.analysis.movementDistance`. Återställer latch-/historik-städning vid GPS-hopp. *Regressionstest.*
6. **F25** (trivial) — sätt hash+timestamp vid sista-vessel-default. Eliminerar dedupe-desync.

*Motivering:* F4/F14/F25/F6 är trivial/små med isolerad blast-radius och löser höga/kritiska defekter direkt; F8/F16 är de två kritiska som måste in före release men kräver test.

**Fas 2 — Anslutningsresiliens (gemensam rot, fixa som ett block):**
7. **F1** (small) — pong-watchdog. Grunden för att half-open ens upptäcks. *Regressionstest.*
8. **F3** (small) — `_intentionalClose`-flagga + `onUninit`-städning. Stoppar zombie-reconnect. *Regressionstest.*
9. **F2** (small) — datadriven STALE_DATA_GUARD + notis-färskhetsguard. Bygger på F1. *Regressionstest.*
10. **F55** (small) — synliggör auth-fel + lyssnare på `max-reconnects-reached`. Komplement till F8.

*Motivering:* F1 är förutsättning för att F2:s guard ska kunna lösa ut; F3/F55 hör till samma klient och bör testas tillsammans för att undvika regressioner i reconnect-kedjan.

**Fas 3 — Notispipeline-konsistens (koordinera F6/F34, dedupe-semantik):**
11. **F5** (small) — AIS-stale-guard i notis-vägen. *Regressionstest.*
12. **F34** (small) — läs persistent-dedupen i huvudvägen. **OBS: koordinera med F6/F7** — rensa persistent vid NEW_JOURNEY så fixen inte förvärrar falsk blockering.
13. **F7** (small) — `mmsi:any`-grind. *Regressionstest.*
14. **F35** (small) — per-tick "any"-dedupe. Bygger på F7:s infrastruktur. *Regressionstest.*
15. **F36** (small) — TRIGGER_POINTS-uppslag i condition-listenern.

*Motivering:* dessa rör samma dedupe-/kandidat-logik; F34 och F6 är spegelvända och måste lösas ihop annars motverkar de varandra. F7→F35 delar mekanism.

**Fas 4 — Djupare korrekthet (GPS/koordination/livscykel, högre regressionsrisk):**
16. **F10** (small) — tidsbaserad decay + absolut timeout. *Regressionstest.*
17. **F40** (small) — gatea stale-ETA på `vessel.timestamp`. *Regressionstest.*
18. **F26** (small) — tvinga 100ms-elimination förbi BUG 6-guard. *Regressionstest.*
19. **F11** (small) — behåll instabil kandidat i remainingCandidates.
20. **F18** (small) — konsekvent tre-vägs riktning vid tilldelning/lås. *Regressionstest.*
21. **F21, F13, F29, F45** (small/trivial) — målbro-/latch-/grupp-fixar, testa mot befintliga regressionssviter (anchor-after-passage, bug-b-eta-oscillation).

**Fas 5 — Städning / dead state (låg risk, kan batchas sist):**
22. **F54** (small) — avregistrera process-lyssnare i `onUninit`. *Regressionstest.*
23. **F70** (trivial) — clearTimeout i `removeVessel`.
24. **F19, F75, F28** (trivial) — ta bort/synka död state (riktningslås, per-lane-Map, lastCoordinationLevel).
25. **F37** (trivial) — yttre try/catch på de två handlers.
26. **F41, F74, F63, F64** (trivial/small) — kosmetiska/edge-case ETA- och fallback-fixar.

*Motivering för ordningen:* Fas 1 levererar maximal pelarförbättring per kodrad (trivial/small, isolerat) och tar de två kritiska fynden. Fas 2-3 attackerar de systemiska temana (resiliens, dedupe) som block där fynd delar rot och måste samordnas för att inte regrediera mot varandra (särskilt F1↔F2 och F6↔F34). Fas 4 har störst regressionsrisk (GPS/status-logik med många befintliga "Fix"-lager) och kräver test mot existerande sviter. Fas 5 är ren hygien utan driftpåverkan och kan tas när tiden finns.

Relevanta filer: `io.ais.tracker/app.js`, `io.ais.tracker/lib/connection/AISStreamClient.js`, `io.ais.tracker/lib/services/VesselDataService.js`, `io.ais.tracker/lib/services/BridgeTextService.js`, `io.ais.tracker/lib/services/SystemCoordinator.js`, `io.ais.tracker/lib/services/GPSJumpGateService.js`, `io.ais.tracker/lib/services/PassageLatchService.js`, `io.ais.tracker/lib/services/ProgressiveETACalculator.js`, `io.ais.tracker/lib/utils/etaValidation.js`, `io.ais.tracker/lib/utils/GPSJumpAnalyzer.js`.
