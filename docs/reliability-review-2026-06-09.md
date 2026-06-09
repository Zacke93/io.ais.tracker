# Tillförlitlighetsgranskning 2026-06-09 — hela kodbasen

> **STATUS 2026-06-09 (kväll): SAMTLIGA FYND ÅTGÄRDADE.**
> Alla punkter i §A och §B nedan är implementerade och test-gateade samma dag.
> Verifiering: 52 testsviter / 419 tester gröna (äkta exit-kod 0, ej pipe-maskerad),
> lint rent. 4 nya regressionstestfiler: `p6-confirmed-passage-no-regate`,
> `p2-persistent-trigger-persistence`, `p8-stale-guard-reconnect-refresh`,
> `b1-b2-b3-feed-watchdog` (25 tester).
>
> **UTÖKAD PELARVALIDERING (2026-06-09, sen kväll)** — fokus bridge_text + notiser:
> 1. **Semantisk grammatikvalidering:** alla 310 bridge_text-övergångar i båda
>    korpusarna matchar en strikt vitlistegrammatik (klausulformer, numerus,
>    målbroar, ETA-format). Höga ETA (93–112 min) verifierade IDENTISKA med
>    produktionens texter = äkta långsamma båtar, ej defekt (no-cap by design).
> 2. **Mönsterdiff mot produktion:** replayens 23 frasmönster är en delmängd av
>    produktionens 24 (436 övergångar); NOLL nya/okända mönster.
> 3. **Notistokens:** 104/104 giltiga (mmsi, bro, riktning, ETA, success);
>    0 'unknown'-riktningar, 0 dubbletter, 0 misslyckade.
> 4. **41h-soak med läckagediagnostik** (ny sektion i replayRunner): ALLA
>    per-fartygs-strukturer = 0 efter korpus + 40 min efterspel; heap 14 MB.
>    (_triggeredBoatNearKeys/_persistentRecentTriggers kvarstår i harnessen
>    eftersom den stänger av monitoring-loopen — produktions-bounded av 2h-TTL
>    resp. aktiva-fartygs-beskärning.)
> 5. **Omstart mitt i resa (end-to-end):** `p2-restart-mid-journey.test.js` —
>    riktiga triggervägen: notis → omstart → spärrad; annan bro → släpps;
>    utgången post → släpps; misslyckad trigger → rollback även i persistens.
> 6. **Fuzz-härdning:** `ais-input-fuzz.test.js` — 22 skräpmeddelanden +
>    10 korrupta WS-payloads: inget kastar, inget når pelarna. Hittade och
>    täppte ett defense-in-depth-hål: 0,0-koordinater avvisades bara i
>    klientlagret — nu även i app._validateAISMessage.
> 7. **`homey app validate --level publish`: godkänd.** Slutläge: 54 sviter /
>    429 tester gröna, lint rent, båda korpusarna fortsatt exakta (29 + 75).
>
> **Replay-validering mot produktionsdata (samma kväll):** äldre korpus
> (20260525) **29/29 notiser exakt** (per-fartyg-fördelning matchar facit);
> 41h-korpusen (20260601) **75/75 = produktionsfacit exakt**, identisk
> fördelning per fartyg+bro. 0 processfel, 0 misslyckade notiser, alla 310
> bridge_text-övergångar rena (ingen undefined/NaN). Notera: produktions-
> loggens 75:e notis är loggad som `null:` (fartyget eliminerades mellan
> attempt och success-raden) — replayen attribuerar samma notis korrekt till
> 211355290@Stallbackabron; en ren logg-kosmetisk skillnad, inte en avvikelse.
>
> **Avvikelse från rekommendation:** A4/P5 löstes enligt alternativ **(b)** —
> bandet 135–314° BEHÅLLS. Skäl: breddningen är test-låst
> (`notification-tokens.test.js:32`) med replay-bevis (JOSEPHINE, bevisligen
> sydgående, COG 226,7°); en snävning hade återinfört en dokumenterad verklig
> regression. Beslutet + riskprofilen är nu dokumenterade vid `COG_DIRECTIONS`
> i `lib/constants.js`.
>
> **Följdfynd under verifieringen:** `comprehensive-bridge-text.test.js`
> ("Multi: 5 vessels") visade sig vara beroende av att testharnessen körde med
> `_isConnected=false` — en infra-artefakt som P8-stale-guarden exponerade.
> Fix: `RealAppTestRunner.initializeApp` sätter nu `_isConnected=true` (den
> matar ju in AIS-data och simulerar ansluten drift). Obs: scenariots
> golden-snapshot var genererad under förorenat tillstånd (testet failade
> redan FÖRE ändringarna när det kördes isolerat); baslinjekörningens "grönt"
> var pipe-maskerad exit-kod.

**Metod:** Sex parallella djupgranskningar (app.js, VesselDataService, anslutningslagret, status/ETA-tjänster, övriga tjänster/utils, drivers/manifest) + manuell verifiering av varje tungt fynd mot aktuell kod. Testsviten kördes som baslinje: **grön** (exit 0), men Jest rapporterar läckta `setTimeout`-handles från `_markPassageProcessed` (se C4).

**Slutsats:** Logikkärnan är väl härdad efter tidigare audit (F1–F75). Det som skiljer appen från 100 % pålitlighet är fem sedan tidigare kända defekter (alla **bekräftade kvar** i koden) plus en handfull nya fynd, främst i anslutningslagret och i långtidsdrift-hygien.

---

## A. Kända öppna defekter — alla omverifierade 2026-06-09

### A1. P2 (HÖG, notiser): `_persistentRecentTriggers` saknar persistens
- **Plats:** `app.js:182` (init), används `app.js:3337–3347`, `3412–3414`, städas `4162–4177`.
- **Bekräftat:** Inget `homey.settings.set(...)` finns någonstans i app.js — 2h-dedupkartan är ren in-memory.
- **Scenario:** Notis skickas → appen startas om (uppdatering/krasch) → kartan tom → samma fartyg inom 2h-fönstret får **dubbelnotis**.
- **Fix:** Persistera via `homey.settings`: ladda i `onInit` med expiry-filter (släng poster äldre än 2 h), skriv vid varje `set`/`delete` (eller debounce:at) och flusha i `onUninit`.

### A2. P6 (HÖG, bridge_text): bekräftad GPS-gate-passage om-gatas → text fryser 2–3 min
- **Plats:** `app.js:1042–1055` → `VesselDataService._handleTargetBridgeTransition` (`VesselDataService.js:1798`), om-kontroll på rad **1843** (`_hasPassedTargetBridge`).
- **Bekräftat:** När gaten bekräftar en kandidatpassage (app.js:1039) anropas `_handleTargetBridgeTransition`, som på rad 1843 kör om hela passage-detekteringen. Den går då igenom gate-blocket (`VesselDataService.js:2346`) och 500 ms-cachen (`2324`), och den geometriska linjekorsningen oldVessel→vessel ligger ofta redan bakom fartyget → `hasPassedCurrentTarget=false` → transitionen appliceras aldrig → bridge_text fryser tills andra timeouts tar över.
- **Fix:** Applicera en redan **bekräftad** passage utan om-gating: ge `_handleTargetBridgeTransition` en `confirmedPassage`-parameter (eller anropa `_applyTargetTransition` direkt från app.js-slingan) så att gate/cache/geometri inte konsulteras en andra gång. Rensa samtidigt gaten (`gpsJumpGateService.clearGate(mmsi)`) efter bekräftelse.

### A3. P8 (MEDIUM, bridge_text): DEFAULT-text trycks ut mitt i AIS-avbrott + ingen refresh vid reconnect
- **Plats:** `app.js:759–792` (`_onVesselRemoved`, 0 fartyg kvar) och `app.js:1165–1171` (`_onAISConnected`).
- **Bekräftat:** (1) När sista fartyget tas bort (t.ex. STALE_AIS under ett avbrott) sätts DEFAULT **ovillkorligt** — Bug#12-guarden (`_lastConnectionLost`, >2 min offline) konsulteras inte. Texten ljuger då "inga båtar" när sanningen är "ingen data". (2) `_onAISConnected` sätter bara `connection_status` — ingen bridge_text/UI-refresh, så en frusen text förblir frusen tills nästa fartygshändelse.
- **Fix:** I `_onVesselRemoved`-grenen för 0 fartyg: hoppa över DEFAULT-push om `!this._isConnected` eller `_lastConnectionLost` indikerar pågående avbrott (låt Bug#12-vägen styra). I `_onAISConnected`: schemalägg en `_updateUI('force', 'reconnect')` så texten alltid synkas efter återanslutning.

### A4. P5 (MEDIUM, notiser): COG-fallbackens sydband 135–314° är en gissning
- **Plats:** `app.js:3696–3706`; band: `COG_DIRECTIONS.NORTH_MIN=315`, `NORTH_MAX=45` (`constants.js:227–231`).
- **Bekräftat:** Olåsta fartyg (utan `_routeDirection`-latch) med COG 226–314° får `southbound`. Kodkommentaren motiverar breddningen (JOSEPHINE @COG 226,7° var bevisligen sydgående), men breddningen gäller bara fallbacken — härledningen/latchen använder 135–225°.
- **Rekommendation (beslutspunkt):** Antingen (a) snäva fallbacken till 135–225° så att 226–314° ger `unknown` (säkrast mot *falsk* riktningstoken), eller (b) behåll breddningen men dokumentera den i constants och lägg ett riktat test. Direction-token används i notiser, så fel riktning är synlig för användaren — (a) rekommenderas.

### A5. bridge_status-drivern (HÖG i praktiken — enheten är död idag)
- **Plats:** `drivers/bridge_status/device.js` + `driver.js`.
- **Bekräftat (tre döda referenser):**
  1. `device.js:22` läser `this.homey.app._latestBridgeSentence` — finns inte; rätt är `_lastBridgeText` (app.js:163) → enheten visar alltid default-text.
  2. `device.js:25–27` anropar `_findRelevantBoats()` — finns inte; rätt är `_findRelevantBoatsForBridgeText()` (app.js:2647).
  3. `device.js:58–63` anropar `_updateActiveBridgesTag()` — finns inte; rätt väg är `_updateUI()` (app.js:1431).
- **Dessutom:** `driver.js:20` listar bara 2 av 3 capabilities (saknar `connection_status`, jfr app.json); `device.js:58` sätter en `setTimeout` som aldrig rensas i `onDeleted`.
- **Fix:** Byt till rätt egenskaps-/metodnamn, lägg till `connection_status` i pairing-listan, spara och rensa timeout-ID:t. Lägg gärna ett test som instansierar device mot en mockad app så att namndrift fångas framöver.

---

## B. Nya verifierade fynd

### B1. (HÖG) `_subscribe()`-fel ger "ansluten men döv" utan återhämtning
- **Plats:** `lib/connection/AISStreamClient.js:158–183` (`_subscribe`), anropas från `_onOpen`.
- **Bekräftat:** Om `ws.send()` av subscription-meddelandet kastar, loggas felet och **inget mer händer** — `connected` är redan emittat, ingen retry, ingen reconnect. Appen tror den är frisk men får aldrig AIS-data.
- **Fix:** I catch-grenen: `this.ws.terminate()` (triggar `_onClose` → ordinarie reconnect-väg). Billigt och återanvänder befintlig logik.

### B2. (HÖG) Ingen stale-data-watchdog — tyst subscription-död upptäcks aldrig
- **Bekräftat:** `lastMessageTime`/`getConnectionStats()` finns i klienten (`AISStreamClient.js:144–153`) men **används aldrig** i app.js (grep: 0 träffar). Ping/pong fångar död TCP-socket (~60 s), men fallet "socket lever, pong svarar, men inga AIS-meddelanden" (tappad subscription, serverfel, ogiltig nyckel där servern bara tystnar) har inget skyddsnät.
- **Fix:** Lägg i den befintliga monitoring-loopen: om `isConnected && timeSinceLastMessage > X` (förslag 10–15 min — kanalen kan vara legitimt tom nattetid, så X får inte vara för lågt) → logga + `disconnect()` + reconnect med omprenumeration. Detta stänger även B1 och auth-fallet där servern stänger utan felmeddelande.

### B3. (MEDIUM) Tom/ogiltig API-nyckel → tyst evighetsloop utan användarsignal
- **Plats:** `AISStreamClient.js:420–435` + `app.js:1265–1273` (`_onAISReconnectNeeded`) + `_startConnection` (app.js:4031–4068).
- **Bekräftat:** Utan nyckel emittas `reconnect-needed`; app.js-handlern gör inget om `ais_api_key` saknas. `_startConnection` loggar bara och returnerar. Användaren får aldrig veta att appen står still.
- **Fix:** Sätt `connection_status`-capabilityn till t.ex. `error`/`disconnected` och skicka en Homey-timeline-notis ("API-nyckel saknas/ogiltig — appen tar inte emot båtdata") när nyckel saknas vid start, vid `auth-error`-event och i `_onAISReconnectNeeded`-fallet.

### B4. (MEDIUM) Långsamt växande Maps utan borttagning i VesselDataService
- **Bekräftat:** `_passageDetectionCache` (init `VesselDataService.js:66`; sätts på 6 ställen, **ingen** `delete`/`clear` någonstans) och `_logDebounce`/`_logRepeatCount` (rad 72–73; samma mönster). Nycklar per `mmsi:bridge` resp. logg-nyckel → växer med varje unikt fartyg över veckor/månader av drift.
- **Fix:** Rensa poster äldre än ~1 min (cachen har 500 ms TTL) resp. ~5 min i den befintliga periodiska cleanupen, samt ta bort fartygets nycklar i `_cleanupVesselState`.

### B5. (MEDIUM) Null-robusthet i geometrikedjan
- **Bekräftat:**
  - `ProximityService.getDistanceToBridge` (`ProximityService.js:29–35`) returnerar `geometry.calculateDistance(...)` rakt av, som kan ge `null` → `null <= 500` är `true` i JS → falsk närhet om ogiltiga koordinater slinker igenom. Fix: `return Number.isFinite(d) ? d : Infinity;`
  - `GPSJumpAnalyzer._checkBearingConsistency` (`GPSJumpAnalyzer.js:171–174`) anropar `geometry.calculateBearing` som **kastar** vid ogiltiga koordinater (`geometry.js:68`) — utan try/catch. Fix: try/catch → returnera null (graceful).
  - API-inkonsekvens: `calculateDistance` returnerar `null`, `calculateBearing` kastar. Harmonisera (båda → `null`).
- Upstream-validering av lat/lon gör praktisk risk låg, men dessa är billiga försvarslinjer för en app som ska gå 24/7.

### B6. (MEDIUM) GPS-gate: stale kandidater och gates överlever target-byte/borttagning
- **Bekräftat:** `_applyTargetTransition` rensar inte gamla kandidatpassager, och `_cleanupVesselState` (`VesselDataService.js`) städar SystemCoordinator/StatusStabilizer/PassageWindowManager men **inte** `gpsJumpGateService`/`passageLatchService`/`routeOrderValidator`. Tidsbaserad självstädning finns (30 s/15 s/2 h) så detta är ingen läcka, men en stale kandidat kan i värsta fall bekräftas för en redan hanterad bro.
- **Fix:** Anropa `gpsJumpGateService.clearGate(mmsi)` + rensa kandidater vid target-byte och i `_cleanupVesselState` (latch/validator har redan `clearVesselLatches`/`clearVesselHistory` att anropa).

### B7. (LÅG) Otrackade `setTimeout` i `_markPassageProcessed`
- **Plats:** `VesselDataService.js:3662` — rå 5-min-timeout per passage, rensas aldrig vid `destroy()`. Syns som läckta handles i Jest-körningen.
- **Fix:** `.unref()` på timern eller spåra i en Map och rensa i `destroy()`. Tar samtidigt bort test-bruset.

### B8. (LÅG) Död/vilseledande kod
- `VesselDataService.js:1965`: `this._generatePassageId(vessel.mmsi, previousTarget, passageTimestamp)` — returvärdet kastas bort och tredje argumentet har fel typ (signaturen tar `vessel`, rad 3622). Ren no-op → ta bort raden.
- `StatusStabilizer.js:29, 302–307`: `stabilizationTimers`-Map:en befolkas aldrig — cleanup-koden är död. Ta bort eller implementera.
- `PassageWindowManager.js:44–54`: båda grenarna returnerar `FAST_VESSEL_PASSED_WINDOW` — snabb/långsam-distinktionen är död (kommentaren antyder avsiktligt; förenkla i så fall till en gren).
- `onUninit` avregistrerar inte service-/aisClient-listeners. Ofarligt idag (tjänsterna återskapas i `onInit`, processen dör vid stopp) men billig hygien om livscykeln någonsin ändras.

---

## C. Granskade och AVFÄRDADE (falska positiver från delgranskningarna)

1. **"TOCTOU-race i boat_near-dedupe"** — Nej: inget `await` mellan dedupe-check (`app.js:3322`) och `add` (`3408`); allt däremellan är synkront → ingen interfoliering möjlig i enkeltrådad JS.
2. **"Kritisk listener-läcka över omstarter"** — Nej: alla tjänster skapas om med `new` i `onInit` (app.js:250–309); gamla instanser + listeners GC:as. (Hygienpunkt kvar i B8.)
3. **"`_lastWaitingShownAt` läcker"** — Nej: lagras **på vessel-objektet**, begränsad av antal broar (~8) och frigörs när fartyget tas bort.
4. **"PassageLatch/RouteOrderValidator/GPSGate läcker obegränsat"** — Nej: alla tre har periodisk självstädning via `setInterval` (verifierat: `_cleanupExpiredGates`, `_cleanupExpiredLatches`, `_cleanupOldHistory`). Kvarstående hygien = B6.
5. **"WAITING_SET_DISTANCE 270 m vs APPROACH_RADIUS 300 m är inkonsekvent"** — Nej: hysteres by design (sättpunkt innanför zongränsen).

---

## D. Rekommenderad åtgärdsordning

| # | Åtgärd | Pelare | Storlek |
|---|--------|--------|---------|
| 1 | A2/P6: applicera bekräftad passage utan om-gating + clearGate | bridge_text | Liten–medel |
| 2 | A1/P2: persistera `_persistentRecentTriggers` | notiser | Liten |
| 3 | A3/P8: stale-guard i `_onVesselRemoved` + refresh i `_onAISConnected` | bridge_text | Liten |
| 4 | A5: laga bridge_status-drivern (3 döda referenser m.m.) | bridge_text (enhet) | Liten |
| 5 | B1+B2: terminate vid subscribe-fel + stale-data-watchdog | båda | Liten–medel |
| 6 | B3: användarsignal vid saknad/ogiltig API-nyckel | båda | Liten |
| 7 | A4/P5: besluta + snäva COG-fallback | notiser | Trivial |
| 8 | B4–B6: Map-städning, null-guards, gate-hygien | drift 24/7 | Liten |
| 9 | B7–B8: timer-tracking + död kod | hygien | Trivial |

Varje punkt bör test-gateas (befintlig svit + nytt riktat test per fix) och valideras mot replay-harnessen innan nästa påbörjas.
