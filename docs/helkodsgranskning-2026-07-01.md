# Helkodsgranskning 2026-07-01 — fynd, fixar och testfördjupning

Sex parallella granskningsagenter (bridge_text, notiser, tillståndsmaskin,
ETA-kedja, anslutning, testkvalitet) över hela kodbasen, följt av
självverifiering av varje fynd mot koden och batchvis fix + validering.
Alla fixar är validerade mot: 494 enhetstester, 5 låsta replay-korpusar
(~69 h produktionsdata, notisfördelning per fartyg+bro låst) och 26
syntetiska scenarier med 13 facit-oberoende invarianter.

## KRITISKA fynd (alla fixade)

| ID | Fil | Defekt | Konsekvens |
|----|-----|--------|-----------|
| C1 | AISStreamClient `_onClose` | `code !== 1000`-villkoret hoppade över reconnect vid servergraceful close; feed-watchdogen är gated på `isConnected` | PERMANENT död feed efter serverdeploy tills manuell omstart |
| C2 | AISStreamClient `disconnect()` | `_intentionalClose`-återställningen låg inne i `if (this.ws)` — flaggan fastnade true vid disconnect under backoff | Nästa misslyckade handshake efter nyckelbyte tolkades som avsiktlig → ingen reconnect någonsin |
| BT-F1 | app.js `_onVesselRemoved` | `getVesselCount() - 1` dubbelsubtraherade (delete sker FÖRE emit) | Falsk "Inga båtar..."-publicering när näst sista båten togs bort (replay-bevisad) |
| S-F1 | GPSJumpGateService | `vessel.speed` finns inte (fältet heter `sog`) → NaN → `isStable` alltid false | Tvåstegsbekräftelsen kunde ALDRIG lyckas — gate:ade passager övergavs tyst |
| N1 | VesselDataService Fix D | Bekräftad U-sväng mitt i resan rensade varken passedBridges eller dedup-nycklar | Hela returresan onotifierad OCH osynlig i bridge_text (target kunde aldrig återtilldelas) |

## HÖGA fynd (alla fixade)

- **E-F1**: ETA-gap-resetten tömde `_etaHistory` men inte `_speedBuffers` →
  förgapsfarter smittade första post-gap-ETA:n när alla skydd var avstängda.
- **BT-F2**: count-validatorn räknade ofiltrerade fartyg (BUG 11-inkluderingen
  med targetBridge=null) → falsk critical-mismatch vid varje passagemoment →
  RC-B-fallbacken återpublicerade INAKTUELL text ("på väg mot Klaffbron,
  strax" i 60 s EFTER passagen — replay-bevisad). Validatorn speglar nu
  BridgeTextServices filter.
- **N2**: tur-och-retur efter avslutad resa + reentry blockerades av
  persistent 2h-dedup → `vessel:journey-reset`-event vid cooldown-utgång.
- **N3**: skipped-bridges-fallbackens distans/fart-skattning ströp mellanbroar
  vid normala 3–18-min-gap → stale-fönstret räknas nu från
  detektionsögonblicket (scenario B skickar `detectionTs`).
- **N4**: `_passageBackfills` saknades i `_createVesselObject`-fältlistan
  (samma fälla som passedAt) + 11 andra saknade fält tillagda (S-F9–S-F13:
  statusdebounce, hysteresis-vakter, passage-cooldowns, zonövergångar,
  Fix G-extrapolationstillstånd).
- **S-F2**: cleanup-timerns callback raderade map-poster EFTER removeVessel →
  föräldralös dubbletttimer kunde radera ett AKTIVT fartyg mitt i resan.
- **S-F3**: `break` i mellanbro-loopen + en-transition-per-tick tappade
  passager när ETT gap korsade flera broar. Fix: färdriktningssorterad loop
  utan break + kedjad målbroutvärdering av samma segment (`_gapChainDepth`).
  Följdfynd: `_applyTargetTransition` läste previousTarget från stale
  oldVessel → fel TARGET_END-bro, dubbelregistrering, fel riktningstokens
  och falsk NEW_JOURNEY vid kedjade transitioner. Två RÄTTADE prod-missar i
  41h-korpusen (265580000@Stallbackabron + @Järnvägsbron) → facit omlåst
  75→77 (dokumenterat i corpora.js).
- **S-F4**: GPS-hopp 100–500 m accepterades BLINT → fysikgata i
  GPSJumpAnalyzer (implied speed vs sog, 2× marginal) → positionUncertain.
- **S-F5**: rörelsebeviset förgiftades av GPS-flaggade prover och beviljades
  av EN outlier → GPS-flagg-skydd + 2 konsekutiva prover för nettobeviset.
- **S-F6**: RC2b-inferensen antog att resan började bortom Järnvägsbron →
  falsk notis för kajavgångar mellan broarna. Gate på `_firstSeenLat`.
- **S-F7**: förtöjd-klassningen släppte på ETT sog-jitterprov/navStatus-flap
  och nollade backstop-klockan → släpp-hysteres (2 konsekutiva gråzonsprov;
  sog=null behåller; klassning består medan stillheten består).
- **N8**: gate-bekräftade mellanbropassager stämplade bara lastPassedBridge →
  full registrering via ny `registerConfirmedIntermediatePassage` (ankring,
  dedup, passedBridges, FIX U, RC9-inferens).

## MEDEL/LÅG (fixade)

BT-F4 (hasGpsJumpHold-fältet fanns aldrig på projektionen), BT-F5
(frånkopplingstexten kunde återpubliceras som fallback efter reconnect),
BT-F6 (`\båtta\b` matchade aldrig — å är inte \w), BT-F8 (global token fick
'' vid boot), C3 (gate-kandidater raderades vid 15 s i stället för 30 s),
C4 (SystemCoordinator räknar nu DISTINKTA jumpers i tidsfönster — ett ensamt
multipath-fartyg kan inte längre blockera all passagedetektering), C8
(alarm_generic släcks under stale-data-guarden), N5 (BUG C jämför även
tidsstämpel — re-passage av samma bro), N6 (NEW_JOURNEY har nu samma
2-observations-debounce som Fix D + rättar _routeDirection), N7
(kanalport-antagandet begränsas för kajavgångar via mooring-zon-check),
N9/E-F3 (eta_minutes=-1 för redan passerad bro), E-F2 (ingen
förhandsavrundning → 0 kunde bli -1), E-F4 (approach-limit tillåter +1
min/cykel i stället för hård frysning), E-F5 (passage-fartgolvet
tidsbegränsat 15 min), E-F6 (WAIT-cap+bounds FÖRE historiken), E-F7
(idle-decay golvas distansbaserat — ingen evig "strax" 400 m från bron),
E-F8 (under-bridge ETA 0.1 i st.f. 0), E-F9 (speed-buffer-nyckel på
sampeldata i st.f. bearbetningstid), N10 (`mmsi:any` speglas i persistent
dedup — "Any bridge"-flow max en gång per resa).

## MEDVETET EJ åtgärdade (dokumenterade)

- BT-F7: ETA-avrundningsflimmer vid .5-gränsen (10↔11) — kosmetiskt.
- BT-F9: död snapshot-konsistenscheck (kan aldrig avvika) — ofarlig.
- S-F14/S-F15: döda skrivningar (`_pendingPassedAnnouncement`,
  `_pendingUnderBridge*`) — ingen funktionspåverkan.
- S-F20: `bridgeVessels`-mappen befolkas aldrig; `getVesselsNearBridge`
  returnerar alltid [] men har INGA anropare — död API-yta.
- C5: Retry-After på 503 läses inte (ws `unexpected-response`) — backoffen
  hanterade 2026-06-11-incidenten acceptabelt; förbättring vid behov.
- C6/C7: död koordinations-API-yta + onåbar flicker-gren — riskfria.
- P5: medvetet behållen (test-låst, se tidigare beslut).

## Testfördjupningen (replay-sviten)

**Harness-fixar:** död processErrors-kontroll i BÅDA runner-skripten
(`(tal).length` → alltid undefined — krascher flaggades ALDRIG);
notistidsstämplar fångas; journey-resets och INTERMEDIATE_PASSAGE_RECORDED
fångas ur loggen; ctrl-samples (`disconnect`/`reconnect`) simulerar
anslutningsavbrott mitt i korpus.

**Fördelningslåsning:** `corpora-distribution.json` låser (mmsi,bro)-
multiset:en per korpus — totalsumman kunde dölja kompenserande fel (en
missad + en falsk = samma summa).

**Nya invarianter** (tests/replay-validation/invariants.js):
- INV-2 är nu journey-reset-medveten (legitim andra passage av samma bro).
- INV-3-oscillationen bandad till operativa området (≤15 min).
- INV-6: 0 fartyg efter efterspel ⇒ sista texten DEFAULT (fångar spöktext).
- INV-7: målbropassagens notis senast 60 s efter registrering.
- INV-9: klausulunikhet, Klaffbron-först-ordning, rimlighetstak.
- INV-10: "strax"-text orörd >35 min utan passage = zombie.
- INV-12: ALLA läckagefält 0 efter efterspel (utom medvetna undantag).
- INV-13: målbro registrerad som INTERMEDIATE utan korrigering/journey-reset
  = tyst degraderad målbropassage. **Fångade omedelbart den verkliga
  S-F3-klassen i 41h-korpusen.**
- INV-1 skärpt: nödfallback kräver känt bronamn; `null` i trasig-text-regex;
  frånkopplingstexten tillåten klausul.

**12 nya syntetiska scenarier** (26 totalt): u-sväng-efter-Klaffbron
(tur-och-retur), möte-vid-Stridsbergsbron, navstatus-flap-väntare,
navstatus-5-kajliggare (första som exercerar navStatus-lagret),
teleport-över-Klaffbron (S-F4-klassen), sog-kollaps-vid-Klaffbron
(RC3-klassen proaktivt), krypfart-0.8kn, dubblettmeddelanden,
gap-35min-över-Klaffbron (stale-removal + återfödelse),
fördröjd-gammal-position (out-of-order-leverans), samma-namn-två-mmsi,
avbrott-mitt-i-passage (ctrl-events). Generatorn utökad med
navStatusPattern, slowZone, staleEcho, duplicateEvery, events.

## Kvarvarande kända begränsningar

- Golden-snapshot-sviten är fortfarande delvis inlåst beteende (två
  race-artefakt-poster omlåsta med motivering 2026-07-01); runnern kör nu
  produktionens statusomvärdering före textbygge (deterministisk).
- Flera äldre testfiler testar KOPIOR av produktionslogik
  (notification-reliability.test.js m.fl.) — noll regressionsskydd trots
  namnen; det verkliga skyddet är replay-sviten + invarianterna.
  Kandidater för sanering, ej brådskande.
- Notisers riktningstoken valideras mot enum men inte mot faktisk
  förflyttning (framtida INV-kandidat).
- Intermediate-bro-notiser under aktiv GPS-hold kan fortfarande missas i
  extrema kombinationer (Järnvägsbron@265580000 räddas numera av RC2b-
  inferensen, men klassen är inte heltäckt av invariant).
- Parse-lagret (AISStreamClient._extractAISData) förbigås i replay
  (harnessen matar _processAISMessage direkt) — unit-testat separat.
