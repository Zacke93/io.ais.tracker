# Tillförlitlighetsverdikt — io.ais.tracker (2026-06-03)

Holistisk bedömning av appens två tillförlitlighetspelare: **boat_near-notiser** och **bridge_text-uppdateringar**. Metod: empirisk replay mot färsk produktionsdata + adversariell kodgranskning (10 prober) + ärlig redovisning av vad replay-harnessen strukturellt inte kan bevisa.

## Verdikt

| Pelare | 100 % tillförlitlig? | Kort motivering |
|---|---|---|
| **boat_near-notiser** | **NEJ — men mycket nära** | 0 äkta missade/dubbla/falska notiser i de testade fönstren. Två bekräftade koddefekter (P2, P5) blockerar "100 %". |
| **bridge_text** | **NEJ — men mycket nära** | 0 fel texter över 41 h / 23 målbro-passager. Två verkliga men ej triggade defekter (P6, P8) + en låg-allvarlig driver-bugg. |

Empirin är genuint stark. Inget av det som blockerar "100 %" observerades faktiskt i drift under de 41 timmarna — men flera är bevisade i kod och skulle slå till under rätt (realistiska) omständigheter.

## Empiriskt bevisat

**Replay (reproducerad):**
- Äldre korpus (`20260525`, 244 samples) → **29/29 notiser, exakt match** mot facit. Harnessen är 1:1 för normalfall.
- Senaste korpus (`20260601`, 1007 samples, 18 fartyg) → 78 notiser, **0 process-errors, 0 dubbletter, 0 unknown-riktning, 0 orimlig ETA**, 258 bridge_text-övergångar med **0 fel-texter, 0 förbjudna fraser**.

**Produktionslogg 41 h (`app-20260601-231305.log`):**
- **75 `FLOW_TRIGGER_SUCCESS`** — varje distinkt `mmsi:bro` har **exakt 1** success (0 dubbletter).
- **165 `FLOW_TRIGGER_DEDUPE`** + **53 `PERSISTENT_DEDUP`** + korrekt `STALE_AIS`-undertryckning.
- **0 `FLOW_TRIGGER_ERROR`, 0 `FLOW_TRIGGER_STALE`, 0 `[FATAL]`, 0 `uncaughtException`, 0 reella anslutningsavbrott.**
- 23 `TARGET_BRIDGE_PASSED` → **alla** gav korrekt målbro-transition.
- Testbaslinje: **48/48 sviter, 394/394 tester gröna.**

## Replayens 4 "extra" notiser = harness-artefakter (inte app-buggar)

Replayen gav 78 vs facit ~74–75. Alla 4 differenser är verifierade harness-artefakter, inte missade produktionsnotiser:

- **265759700:Klaffbron** — fartyget `STALE_AIS`-togs bort 08:46:56 (30 min utan position) *före* återkomst söder om bron. Produktion kunde korrekt inte notifiera "båt nära Klaffbron" utan färsk data.
- **211112870:Stridsbergsbron / Stallbackabron** — AIS frös på 727 m (`IMMINENT_SET_EXHAUSTED`); fartyget var aldrig inom 300 m med färsk data. Produktion fyrade bara Klaffbron.
- **211355290:Stallbackabron** — fyrades *faktiskt* i produktion (rad 2589) men attribuerades `mmsi=null` eftersom `JOURNEY_COMPLETED`-elimination skedde 416 ms före den asynkrona success-callbacken. **Samma notis** — attributions-mismatch, inte en extra notis.

**Rotorsak:** `replayRunner.js` mockar `Date.now` men använder **riktiga `setTimeout`**, som aldrig hinner lösa ut under sekunders körtid. Därför körs aldrig cleanup/`STALE_AIS`/`JOURNEY_COMPLETED` i replayen → fartyg som produktion korrekt tog bort lever vidare och "fortsätter" fyra. Detta är ett *bevis* på att driftens stale-undertryckning fungerar, plus en harness-förbättringsmöjlighet (se nedan).

## Bekräftade defekter (blockerar 100 %)

### P2 — "Persistent" dedupe överlever inte omstart  · pelare: notiser · **hög prioritet**
`_persistentRecentTriggers` (app.js:182) är en ren in-memory `Map` utan persistens (0 `getStoreValue`/`setStoreValue`/`settings.set`; `onInit` läser bara `debug_level`). Vid en app-omstart (Homey-uppdatering, krasch, ominstallation, hubb-omstart) medan ett `waiting`-fartyg ligger kvar inom 300 m → nästa AIS-meddelande ger en **garanterad dubbel boat_near för samma bro/resa**. Mekanismen är bevisad i kod; dvälj-mönstret är reellt (53 `PERSISTENT_DEDUP`-träffar, flera 9–17 min efter första trigger). Dubbletten uteblev i loggen enbart för att ingen omstart skedde (1 boot, 0 shutdown).
- **Fix:** persistera mappen via `homey.settings`. Ladda i `onInit` (filtrera bort entries äldre än 2 h-fönstret), skriv vid varje mutation (debounce'at) + flush i `onUninit`. Behåll expiry-filtreringen så en gammal snapshot inte blockerar en legitim ny notis.
- **Test:** `tests/boat-near-dedupe-survives-restart.test.js` — instans A fyrar → ny instans B med samma settings-store → assert ingen dubbel; samt expiry-test (>2 h ska inte blockera).

### P5 — direction-token-bandet inkonsekvent med riktningshärledningen  · pelare: notiser · medium
`_getDirectionString` (app.js:3703–3705) klassar COG **135–314°** som `southbound`, medan riktningshärledningen (`_determineDirection` + target-guards) använder **135–225°**. Ett **olåst** fartyg inom 300 m med COG 226–314° och sog ≥ 0,5 får då token `southbound` på ren gissning (kanalens verkliga sydaxel är ~196–209°). Bevisat i kod. Exponeringen är smal (route-latchen är primär källa, sog<0,5-guard finns); i loggen besöktes bandet (AIR 265671650: COG 314/271,6/226,8/305,6) men bara på 545–706 m → inget falskt token avfyrades *här*.
- **Fix:** snäva sydbandet i `_getDirectionString` till 135–225° (konsekvent med härledningen) så olåsta fartyg i 226–314° får `unknown` i stället för gissat `southbound`. JOSEPHINE-fallet (COG 226,7°) täcks i stället av route-latchen (redan primär källa). Alternativt en off-axis-vakt.
- **Test:** enhetstest av `_getDirectionString` (olåst fartyg: COG 270/314 → `unknown`; COG 200 → `southbound`; latchat `south` → `southbound` även vid 314) + replay-fixture.

### bridge_status-driver läser icke-existerande fält  · pelare: bridge_text · låg
`drivers/bridge_status/device.js:22` läser `this.homey.app._latestBridgeSentence` som **inte finns** (0 träffar i app.js; rätt fält är `_lastBridgeText`). Raderna 25/59 refererar också icke-existerande `_findRelevantBoats`/`_updateActiveBridgesTag`. Följd: den device-typen visar **alltid** DEFAULT-texten oavsett live-tillstånd. (Den primära `bridge_text`-capability-vägen påverkas inte.)
- **Fix:** byt `_latestBridgeSentence` → `_lastBridgeText`, `_findRelevantBoats` → `_findRelevantBoatsForBridgeText`, och korrigera/ta bort `_updateActiveBridgesTag`-anropet.
- **Test:** device-init-test som assertar att live-text speglas, inte DEFAULT.

## Verkliga men ej triggade defekter (theoretical)

### P6 — GPS-gate-deadlock på bekräftad målbro-passage  · pelare: bridge_text · medium
När ett äkta GPS-hopp sammanfaller med en målbro-passage gatar `_hasPassedTargetBridge` passagen och lägger den som kandidat. När kandidaten bekräftas anropar `_handleTargetBridgeTransition` **samma grindkontroll igen** — är grinden fortfarande aktiv hoppas transitionen över medan kandidaten redan tagits ur kön → passagen tappas → bridge_text fryser ~2–3 min på "på väg mot [passerad bro]". **Verifierat:** ett regressionstest mot hela pipelinen **failar på nuvarande kod** (`vessel.targetBridge` förblir `Stridsbergsbron` efter fysisk passage). Triggades inte i 41 h eftersom alla stora rörelser klassades som `legitimate_direction_change`/`vessel_turning` (0 GPS-gate-händelser).
- **Fix:** i `confirmStableCandidates`-grenen (app.js:1042–1055), applicera target-bytet direkt för en redan tvåstegs-bekräftad passage — rensa grinden (`gpsJumpGateService.clearGate`) innan transitionen, eller en grind-agnostisk transitionsväg som registrerar passagen i `passedBridges`.
- **Test:** `tests/gps-gate-confirmed-passage-applies.test.js` (verifierat: failar på nuvarande kod, ska passa efter fix).

### P8 — `_onVesselRemoved` visar "Inga båtar" mitt i AIS-avbrott  · pelare: bridge_text · medium
`_onVesselRemoved` (app.js:759–776) sätter ovillkorligt DEFAULT-texten när sista båten tas bort — utan att kolla `_isConnected`. Vid ett verkligt >2 min-avbrott kan en cleanup-timer (oberoende av AIS) fyra → UI visar "Inga båtar är i närheten…" mitt i ett dött flöde, precis det Bug #12-guarden skulle förhindra. Ingen självläkning förrän nästa AIS-meddelande (`_onAISConnected` triggar ingen UI-refresh). Obevisad i drift (0 avbrott på 41 h).
- **Fix:** applicera samma stale-guard i `_onVesselRemoved` vid 0 kvarvarande båtar (visa "AIS-anslutning saknas…" om frånkopplad >2 min), + lägg en `_updateUI`-refresh i `_onAISConnected`.
- **Test:** `tests/stale-guard-vessel-removal.test.js` (frånkopplad >2 min → "AIS-anslutning saknas"; ansluten → DEFAULT; hash-synk-regress).

### Observerad textinstabilitet (utanför P7-scope)
En intra-grupp ETA-flip **"strax" → "19 minuter"** (logg rad ~2390) — en äkta icke-monoton bakåt-flip i texten, orsakad av imminent/extrapolation-återställning vid färsk AIS. Värd en separat titt (ETA-monotonicitet inom en väntande grupp).

## Verifierat säkra (not-a-risk)

- **P1 burst-race:** has→add-fönstret (app.js:3322→3408) är helt synkront (ingen `await`/timer mellan check och add); olika MMSI har distinkta nycklar. Node:s event-loop serialiserar samma-fartyg-meddelanden. 75 ATTEMPT → 75 SUCCESS, 0 dubbletter.
- **P3 GPS-hold-block:** de 2 GPS-jumpen (265035480, 583 m) blockerade ingen legitim notis.
- **P4 fallback-race:** dedupe-nyckeln sätts före async; ingen fallback dubbel-fyrade i loggen.
- **P7 två målbroar:** ren funktion, fast ordning (Klaffbron före Stridsbergsbron), 0 omkastningar.

## Blinda fläckar (replay kan strukturellt inte bevisa)

1. **Reconnect/auth/pong-watchdog** — replay kör `ais_api_key=null`; loggen hade 0 reella avbrott → all backoff/auth/terminate-kod oprövad i drift (P9: koden ser korrekt ut men är empiriskt overifierad).
2. **Omstart-resiliens** (P2) — harnessen kör en enda process.
3. **Riktig flow-listener-exekvering** — `_boatNearTrigger.trigger` är mockad.
4. **Timing-jitter / cross-message-interleaving** — replayen serialiserar strikt.
5. **Riktiga cleanup-timers** (P0-roten) — mockad klocka driver inte `setTimeout`.
6. **Minne/läckor över längre horisont än 41 h.**

## Prioriterad åtgärdslista

| Prio | Pelare | Åtgärd | Fil |
|---|---|---|---|
| **Hög** | notiser | P2 — persistera dedupe-mappen över omstart | `app.js` (`_persistentRecentTriggers`) |
| **Hög** | harness | P0 — driv `setTimeout/setInterval` med fake-timers → replay 1:1 | `tests/replay-validation/replayRunner.js` |
| Medium | notiser | P5 — snäva direction-token-bandet till 135–225° | `app.js` (`_getDirectionString`) |
| Medium | bridge_text | P6 — applicera bekräftad målbro-passage utan om-gating | `app.js` + `VesselDataService.js` |
| Medium | bridge_text | P8 — stale-guard i `_onVesselRemoved` + refresh vid reconnect | `app.js` |
| Låg | bridge_text | bridge_status-driver läser fel fält | `drivers/bridge_status/device.js` |
| Låg | anslutning | P9 — reconnect/fault-injection-svit (utanför replay) | `tests/ais-connection-resilience.test.js` (+ nightly) |
| Låg | notiser | P1/P4 — AST-regressionsvakt för add-before-await-invarianten | `tests/unit/` (ny) |

## Harness-förbättring (rekommenderas före nästa validering)

Byt `replayRunner.js`-klockan mot `@sinonjs/fake-timers` (finns redan i `node_modules`) med `toFake: ['setTimeout','clearTimeout','setInterval','clearInterval','Date']`, och stega klockan med `clock.tick(deltaMs)` mellan samples. Då fyrar `STALE_AIS`-removal (30 min), `PROTECTION_ZONE`-reschedule och 100 ms `JOURNEY_COMPLETED`-elimination precis som i drift → de 4 fantomnotiserna försvinner och replay blir **1:1 med produktion**. Sätt även `_isConnected=true` efter `onInit` så bridge_text-fångsten motionerar den riktiga `_processUIUpdate`-vägen (inkl. stale-guarden).

## Slutsats

Appen är **inte 100 % produktionsredo** på någon pelare än, men ligger nära. Den enda vägen till "100 %" på de testade scenarierna går via **P2 + P5** (notiser) och **P6 + P8 + bridge_status** (bridge_text). Därutöver kräver ett ärligt "100 %" att de strukturella blinda fläckarna (reconnect/auth, omstart, långtid) täcks med tester **utanför** replay-harnessen.

> Detta är en rapport. Ingen appkod har ändrats. En testfil som en granskningsagent skapade för att bevisa P6 har körts (failade som väntat) och därefter raderats för att bevara rent läge.
