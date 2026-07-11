# ChatGPT-granskning 2 — verifiering och fixar (2026-07-11)

Extern ChatGPT-rapport körd mot exakt 0a3b1df-koden (b17da05 + lokala
ändringar). 20 fynd (CG2-1…CG2-20) verifierades kritiskt av **13 Opus 4.8
max-granskare** (1 fyndpaket var, med repro-skript mot skarpa moduler);
dirigenten (Fable) dömde varje verdikt, implementerade fixarna och
dubbelverifierade mot facit-fällan. Regressionssvit:
`tests/chatgpt2-granskningen-2026-07-11.test.js` (28 tester).

## Verdiktsöversikt

| Fynd | Rapportens rubrik | Verdikt | Utfall |
|---|---|---|---|
| CG2-1 | Falsk passage från litet GPS-brus | VERIFIED_REAL (medium) | **FIXAD** — stationär-jitter-gate i `detectBridgePassage` |
| CG2-2 | Första mållösa observationen missar notisen | PARTIAL (high) | **FIXAD (snäv)** — entered-gaten + trigger-punkterna; currentBridge MEDVETET utelämnad (SISU-fyndet, se Läxor) |
| CG2-3 | Transient trigger-reject förlorar notisen | PARTIAL (medium) | **ACCEPTERAD EXPONERING** — se nedan |
| CG2-4 | Publiceringslaner lämnar token/larm stale | VERIFIED_REAL (high) | **FIXAD** — global in-flight-vakt + set-vid rerun |
| CG2-5 | Omstart/döv feed → obevisat "Inga båtar" | DESIGN_CHOICE (high) | Avskriven — STALE_DATA_GUARD (2 min) + feed-hälsans null→Infinity (20 min) täcker de reella fallen; null-grenen i UI-vakten är bevisat onåbar som felkälla |
| CG2-6 | Capability-migration → falskt available | VERIFIED_REAL (medium) | **FIXAD** — hasCapability-gate på återhämtningen |
| CG2-7 | Null-SOG fabricerar ETA | PARTIAL (medium) | **FIXAD** — sog=null ⇒ ETA okänd; finit sog (inkl. 0) orörd |
| CG2-8 | Okänd gruppmedlem döljs av annan båts ETA | DESIGN_CHOICE (high) | Avskriven — fräscha nära båtar blir imminent ⇒ "strax" (app.js 300 m-gaten); residualen är stale-båtar där minutlöftet från den TILLFÖRLITLIGA båten är rätt (Anomali-3/HAJH-LAIF-korpuslåst) |
| CG2-9 | Passed-hold representerar inte öppningen | DESIGN_CHOICE (high) | Avskriven — båda delpåståendena är GOLDEN-LÅSTA som korrekta (19h 16:52:14 resp. 01:44:42); receptet är fasspårningen som fällts tre gånger (F4-G/F4-M/F5-C) |
| CG2-10 | Dedup-orphan via pruneordningen | VERIFIED_REAL (high) | **FIXAD** — persistent-prunen före sessionsnyckel-prunen; extraherad till `_pruneDedupCaches()` |
| CG2-11 | Dubbel concurrent reject → 2h-block | REFUTED (high) | Avskriven — kritiska sektionen 5459→5705 är synkron (enda await = trigger-anropet); repro visade calls=1, slutpost=original, retry fungerar |
| CG2-12 | Flow-kort/token självläker inte | PARTIAL (high) | **FIXAD (b+c)** — bounded createToken + setValue via safe-vägen + lat återskapning (60 s rate-limit); (a) getTriggerCard=null REFUTERAD (manifestkort kan inte bli null i SDK3) |
| CG2-13 | Fel riktningstoken (AKIRA, stale route-lock) | DESIGN_CHOICE (high) | Avskriven — riktningen var genuint obelagd i notisögonblicket (cog 101°, 1,5 kn); dokumenterat designval (corpora.js:317), INV-15 WARN-tolererad, facit-låst |
| CG2-14 | Partiell GPS-hold flimrar | DESIGN_CHOICE (high) | Avskriven — GPS-hållet SKA utesluta misstänkt position ur alla vägar; att rendera den betrodda båten är ärligare än frusen text; 2 s-fönster, raritet |
| CG2-15 | Hash-only-dedup tappar textövergång | VERIFIED_REAL (high) | **FIXAD** — strängjämförelse som OR-term (null-sentinelen bevarad); granskaren räknade 1197 äkta kollisionsbuckets men 0 bland verkliga goldens och 0 för enstegsövergångar |
| CG2-16 | ETA-tie är inputordningsberoende | REFUTED (high) | Avskriven — min-raw-ETA-reducen är deterministisk för alla distinkta floats; exakt float-tie mellan oberoende fartyg är onåbar (och skillnaden "om 5"/"cirka 5" är samma löfte) |
| CG2-17 | SystemCoordinator saknar destroy | VERIFIED_REAL (high) | **FIXAD** — destroy() + med i onUninit-kedjan (SYS-5 stängd) |
| CG2-18 | Replay bevisar inte tokenleverans | PARTIAL (high) | **FIXAD (A)** — leveransassertion i replayRunner (token == `_lastBridgeText \|\| DEFAULT`, processfel vid diff); (B) fake-timer-artefakten (GLOBAL_TOKEN_TIMEOUT-bruset) BEHÅLLEN — att ändra tick-interfolieringen riskerar goldens |
| CG2-19 | Soak kräver 5 av 6 notispunkter | PARTIAL (high) | **FIXAD** — per-bro-golv `ceil(fullJourneys*0.5)`; kalibrerad mot verklig körning (nivå 36–39 per bro mot golv 16); målbroarna hade redan INV-5, mellanbroarna var oskyddade |
| CG2-20 | Ordningsberoende testsvit | PARTIAL (high) | **FIXAD** — sammanfattningstestet asserterar självhärlett tillstånd; "faller med seed" var MOTBEVISAT (ingen --randomize i repot), men skörheten var äkta |

## CG2-3: accepterad exponering (dokumenterat beslut)

En transient `homey.flow.trigger`-reject på en **fallback-only-väg**
(backfill/exit/skipped-bridges — båten redan bortom 300 m) förlorar notisen:
F4-K-rollbacken återställer dedup korrekt men inget re-genererar kandidaten.
Beslut att INTE bygga retry/outbox:

1. Huvudvägen (båt inom 300 m) re-genererar kandidater varje tick — redan täckt.
2. En outbox inför **at-least-once**: om trigger-anropet avfyrade flowen men
   löftet ändå rejectade ger retry en DUBBLETT — pelare 2 kräver exakt en,
   och en dubblett är lika illa som en miss.
3. Transient flow-reject är **oobserverad i ~150 h korpus + 5 fältprov**
   (grep: noll FLOW_TRIGGER-failures).

At-most-once + rollback är alltså rätt sida av felet för en nära-noll-händelse.

## Läxor

- **SISU-läxan (facit-fällan fällde första CG2-2-varianten):** den breda
  entered-grinden (`currentBridge || …`) lät en proximity-notis förekomma
  skipped-bridges-fallbacken på en ÅTERFÖDD båts landningstick —
  riktningstoken föll från `northbound` (fallbackens positionsbevisade
  hoppvektor) till `unknown` (cog 46,5° utanför nordbandet). 21h-korpusens
  riktningsfacit fångade det (`saknas=northbound extra=unknown`), solo-replay
  + stash-bisektion rotorsakade det på ~10 min. Notiskällornas
  RIKTNINGSKVALITET skiljer sig: fallback-vägarna vet färdriktningen,
  proximity-vägen gissar ur cog — ordningen mellan dem är ett kontrakt.
- Rapportens radnummer/reproklamer höll blandat: 6 VERIFIED_REAL, 7 PARTIAL
  (kärnan höll men severity/bredd överdriven), 5 DESIGN_CHOICE, 2 REFUTED
  med körd motrepro. Samma mönster som ChatGPT-granskning 1 (2026-07-10).
- CG2-10 är klassen "osynlig för batteriet per konstruktion":
  monitoring-loopen är TEST_MODE-gatad så replay kan strukturellt aldrig se
  prod-orphanen. Extraktionen till `_pruneDedupCaches()` gjorde
  ordningskontraktet enhetstestbart.

## Slutläge

- 1039/1039 jest (84 sviter, +28 i nya sviten)
- 11/11 korpusar EXAKTA — **inga omlåsningar; facit helt orört**
- 44/44 syntetiska scenarier
- 72h-soak stabil: 221 notiser (golv 160), per-bro 36–39 (golv 16),
  2 kända INV-18-WARN
- Replayen asserterar nu global tokenleverans (CG2-18A) — grön i alla korpusar
- lint + `homey app validate --level publish` rent
