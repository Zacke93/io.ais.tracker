# Helkodsgranskning 2026-07-10 — pelarfokus + testaudit

> **Tillägg samma kväll (§ChatGPT-verifieringen 2026-07-10b, se längst ned):
> fyra ytterligare bekräftade fynd C1–C4 fixade** — varav C1
> (GPS-kandidaternas 30 s-TTL i produktion) neutraliserade GJ-1-fixen i
> skarp drift och var osynlig för hela batteriet.

Uppdrag (användaren): "gå igenom hela appens kod med fokus på de två pelarna
och verkligen se till att den blir 100 % tillförlitlig; kika även på om det
finns något som hade kunnat göra testerna bättre."

Metod: 12 Opus-granskare parallellt — app.js i tre radintervall, VDS i två,
statuskedjan, bridge_text-renderingen, ETA-kedjan, passagedetekteringen,
GPS-vakterna, anslutningskedjan + en dedikerad testkvalitetsauditor (~20 000
rader produktion + harnessen). Varje fynd dirigentverifierades mot koden
före fix; hela batteriet (facit-fällan) efter.

## Åtgärdade produktfynd (23 st)

### Pelare 2 (notiser)
- **A1-1 (HÖG)** `app.js` NEW_JOURNEY-reversalens sydband var 135–225°
  (Anomali 7-original) medan `_dedupDirection`/`_getDirectionString`
  harmoniserades till 135–315° redan 2026-07-03. En U-sväng söderut med
  SV-kurs (226–314° = normal sydfärd i den NE–SV-orienterade kanalen)
  nollställde ALDRIG resan → returresans alla notiser dedup-blockerade
  (PRICKBJORN-klassen som blocket finns för att förhindra). Samma band
  rättat i VDS Fix D (`VesselDataService.js:215`). Nordbandet (315–45°)
  orört; fartkrav + N6-debounce består.
- **A3-1 (MEDEL)** exit-fallbackens expired-släpp (`_triggerExitPointFallback`)
  var ovillkorligt medan huvudvägen fick F5-A-gaten — spegel införd:
  släpp kräver rörelsebevisad riktning i nuet + ingen pending-reversal.
- **A3-2 (LÅG)** `_triggerBoatNearFlowBest` returnerade null när trigger-
  kortet saknade `.trigger` → anroparen skrev dedup-nyckel + persistent-post
  och loggade SUCCESS utan levererad notis (2h tyst spärr). Nu: throw →
  F4-K-rollbacken.
- **G-1** `RouteOrderValidator` skip-taket +3 → +4: hela brokedjan (5 broar)
  kan täckas av ETT Class B-glapp; gamla taket blockerade en äkta
  Olidebron→Stallbackabron-detektering som "sequence_too_far_forward" när
  båten var snabbare än 30-min-undantaget.
- **G-2** `_hasDirectionChanged`: okänd aktuell riktning (null i tvetydiga
  COG-band) räknades som riktningsändring → vändningsundantaget godkände
  passager INNAN backwards-spärren hann köra. Nu: null = ingen ändring.

### Pelare 1 (bridge_text)
- **GJ-1 (HÖG)** `GPSJumpGateService._isVesselStable`: fasta 200 m-gränsen
  kunde ALDRIG bekräfta en rörlig gles-kadens-båt (Class B 3–15 min ⇒ alltid
  >200 m mellan sampel; age > gateTimeout ⇒ kandidaten övergavs vid FÖRSTA
  försöket). En äkta passage detekterad under aktiv gate (multipath vid just
  broar) registrerades aldrig → utebliven target-transition → text frusen
  på passerad bro. Nu kadensmedveten fysik: fart × tid × 2,0-marginal
  (5 kn-golv vid okänd fart, 200 m-golvet består för korta intervall —
  multipath-skyddet för stilla båtar intakt); COG-toleransen 30°→60° för
  sampel >60 s isär (kanalens svängar).
- **T-1 (MEDEL)** nöd-fallbacktexten (`_generateSafeFallbackText`) kunde säga
  MELLANBRO-namn ("En båt 250m från Järnvägsbron") — `currentBridge` är
  närmaste registerbro inom 400 m. Kontraktsbrott ("Mellanbroar nämns aldrig").
  Nu: bronamn begränsas till målbroarna; distansen räknas mot bron som nämns.
  **T-3**: representanten är båten med lägst giltig ETA (ledarprincipen),
  inte `vessels[0]`.
- **S-1 (MEDEL, dubbelfynd — två oberoende granskare)** dödband 270–300 m mot
  MÅLBRO: approaching krävde >300 m (APPROACH_RADIUS), waiting ≤270 m
  (WAITING_SET) → inkommande båt föll till en-route i bandet: texten gick
  "närmar sig" → "på väg mot" → "inväntar". Nu möts banden exakt vid 270 m.
- **S-2 (MEDEL)** FIX U:s tvingade waiting emittade aldrig `status:changed`
  (early-return före emitten) — boat_near-steg 2/3, dedup-rensning och UI
  drivs av eventet. Nu emittas det (avsiktligt förbi FIX G-debouncen — FIX U
  ÄR en tvingad status).
- **S-3 (LÅG)** `_lastWaitingShownAt` (FIX O-underlaget) stämplades i
  `_isWaiting`-predikatet FÖRE debounce/stabilizer — även waiting-förslag som
  rullades tillbaka räknades som "visade". Stämplingen flyttad till bekräftad
  slutstatus i `analyzeVesselStatus`.
- **S-4 (LÅG)** Stallbacka-approaching-fallbackens `sog > 0.5` → null-tolerant
  (`sog == null ||`) — enda sog-gaten i statuskedjan; fartgivarlösa fick
  aldrig "närmar sig Stallbackabron" via fallbacken.
- **T-2 (LÅG)** stale `_isImminentAtTargetBridge` nollställs nu före
  coord-invalid-hoppet i `_reevaluateVesselStatuses` (kunde annars driva
  falskt "strax" för en båt utan användbar position).
- **A2-1 (LÅG)** `[BRIDGE_TEXT_BUG]`-error-larmet speglar nu GPS-hold-filtret
  (BridgeTextService + BT-F2 exkluderar hållna) — inga falska error-larm för
  en ensam GPS-hållen målbåt.
- **A2-2 (LÅG)** SOG > SOG_MAX (sentinelen 102.3/korrupt) fällde HELA
  positionsrapporten på appnivån → osynlig båt om klientnormaliseringen
  regredierar (osynliga-båtar-klassen från 2026-07-06). Nu → sog=null,
  positionen behålls (samma försvar-på-djupet som 0,0-garden, symmetriskt
  med COG 360→null).

### Fartgivarlös-familjen (sog=null — genomgående klass, 4 fynd)
- **V2-1 (MEDEL)** `_updateMooringEvidence`: `sog===null`-returnen gjorde
  HELA förtöjningsklassningen död för fartgivarlösa (stillhetsklockan
  startade aldrig → navstatus-/kajzon-/2h-backstop-lagren onåbara) →
  fartgivarlös kajliggare = evig "inväntar broöppning". Nu positionshärledd
  stillhet: ankare + 40 m-jitterradie (`NULL_SOG_STILL_RADIUS_M`);
  klassningslagren utbrutna till `_classifyMooring` så båda vägarna kör
  EXAKT samma lager. S-F7 bevarad (enstaka null-prov hos blandsändare rör
  ingen klassning). Nytt fält `_nullSogStillAnchor` i fältlistan.
- **V2-2 (MEDEL)** `lastActiveTime` frös vid skapelsen för null-sog-båtar
  (`data.sog > 2.0` aldrig sant) → kö-zonsvakten (recentlyActive) permanent
  död för klassen. Nu stämplas den vid positionsbevisad förflyttning
  (≥ MOVEMENT_PROOF_NET_M) i null-sog-grenen.
- **E-1 (MEDEL)** ETA-absolutklampen: null-sog föll mellan nearStationary
  och isMoving → ingen dämpning alls för klassen med 0,5 kn-fartgolv (~50 m
  brus = ~3 min ETA-sväng). Nu räknas okänd fart som near-stationary (±3).
- **GJ-2 (LÅG)** GPSJumpAnalyzers medium-fysikgate: 5 kn-golvet gäller nu när
  NÅGOT sampel saknar sog (inte bara båda) — avgående väntare (gammal 0,3,
  ny null) dömdes annars positionUncertain på legitim avfärd.

### Övrigt
- **E-2** `stallbacka-waiting` ingår nu i idle-decayns statuslista (systrarna
  WAIT-clamp/WAIT_CAP hade den redan) — stillaliggarens ETA fryser inte.
- **E-3** motsägande gap-reset-kommentar rättad (koden var korrekt: STEP 2-
  placeringen är den AVSIKTLIGA efter den korpusfällda flytten).
- **G-3** mellanbro-latchen får riktnings-fallback
  (`_finalTargetDirection || _routeDirection`) som målbro-registreringen —
  null-riktad latch kunde aldrig släppas av F13-reversalen.
- **V1-1** null-distansguards (Bug F1-mönstret) i `_isInProtectionZone`
  (TypeError på `.toFixed`) och `_findMooringZone` (falsk zonträff).
- **V1-2** post-final-target-grenen fick MOSHE-grenens `!_moored`+rörelse-gate
  (kajliggar-jitter kunde ge falska passedBridges-poster).
- **Dödkod raderad**: `etaValidation.formatETA`,
  `CountTextHelper.buildAdditionalText`, `PassageLatchService.shouldBlockMessage`
  (0 produktionsanrop var; den sista dessutom trasig vid bruk).

## Avvisade fynd (dirigentens motbevis)
- **A3-3** (lagringssidans dedup-riktning utan rörelsekrav): MEDVETET F4-C-val,
  facit-låst (HALIFAX-posten 'south' @ 1,1 kn krävs i korpus #10).
- **C-1/C-2** (anslutning): "ansluten-men-tyst"-fönstret är dokumenterad
  RC7/RC8-avvägning; ping/pong-antagandet motbevisat av 150 h korpusdrift.
- **S-5** (B5-backstoppens ackumuleringstakt): trolig avsedd "bekräftad
  närvaro"-semantik; ingen kodändring utan fältbevis.
- Anslutningsgranskaren och VDS del 1-granskaren fann noll bevisade fel i
  sina paket (exceptionellt härdade — verifierat, inte antaget).

## Testauditens åtgärder (batteriet stärkt)
- **TA1 — golden bridge_text**: HELA transitionsströmmen (iso + text) låst
  per korpus i `tests/replay-validation/golden-text/` (11 filer). Pelare 1:s
  största strukturella hål: "rimligt men fel" värde (rätt grammatik, fel
  båt/antal/ETA) rörde tidigare ingen gate. Determinismverifierad
  (regenerering + ren omkörning = grönt).
- **TA2 — riktningsfacit**: (mmsi,bro,riktning)-multiset låst per korpus i
  `corpora-direction-distribution.json` — riktnings-token var bara
  WARN-skyddad (INV-15, 220 m-tolerans). Omlåsning av båda:
  `REGEN_DISTRIBUTIONS=1 npm run replay:all` (vägrar skriva från bruten
  körning; diffen granskas som facit-omlåsning).
- **TB5 — INV-2-skärpning (fatal)**: motsatt-riktnings-undantaget var en
  öppen dörr (N,S,N,S,… godkändes obegränsat). Nu krävs ≥5 min mellan
  flip-legitimerade notiser (fysisk returtid; HALIFAX 10 min/ELFKUNGEN
  76 min klarar, PIANO-vobbelns ~1 min fälls).
- **INV-19 (ny WARN)**: ≥4 flip-släppta notiser per nyckel utan reset =
  pendlings-/vobbelsignal för manuell granskning.
- **INV-20 (ny WARN)**: målbro-flapp — "på väg mot X" som försvinner och
  återkommer inom 3 min utan passage (INV-3:s syskon för målbron).
- **TA3 — nytt scenario #44** 'stillaliggare-efter-2h-prune (PILOT-klassen)':
  nordgående parkerar 200 m norr om Stallbackabron, sänder var 3:e min i
  2h20 — helkedjeskydd för F5-A/A3-1-expired-släppen
  (maxNotifiedPerBridge = 1).
- **TD14 — ärlighetsmärkning**: 12 describe-block i
  `notification-reliability.test.js` märkta "⚠️ DOKUMENTATIONSTEST"
  (omimplementerad logik som aldrig kan falla på produktionsregression) +
  filhuvudvarning.
- **TE15 — harnessvakter** (`tests/harness-vakter.test.js`): replayRunners
  logg-regexar låsta mot produktionens loggsträngar (INTERMEDIATE/TARGET_
  PASSAGE_RECORDED + journey-reset-familjen) — INV-13:s indata kan inte
  längre bli tyst vakuöst av en omformulering.
- **TE16**: replayRunner räknar nu kastande `_onAISConnected`/`onUninit` som
  processfel i stället för att svälja tyst.
- **TE17**: källsvep-vakt som kräver att varje notiskälla i app.js finns i
  invariants `PROXIMITY_SOURCES` (utom passage-fallback).
- Regressionssvit `tests/helgranskning-2026-07-10.test.js` (24 tester) för
  A1-1/A3-1/A3-2/T-1/T-3/S-1/S-2/GJ-1/V2-1/E-1 + A2-2-testerna i fuzz-sviten.

## Kvarstående testauditförslag (EJ genomförda — nästa iteration)
- TB6: notis↔text-konsistensinvariant (notis ⇒ båten syns i texten ±X min).
- TB8: passageordningsinvariant i replay (monotona målbropassager per resa).
- TC9–13: scenarioluckor — burst-kadens (<10 s), >5 samtidiga båtar
  (ordtalen Sex–Tio), permanent-Unknown-fartyg, sydspeglingar av nord-only-
  klasserna, anslutningsflapp/watchdog-stress.
- TA4: stale-notisgate-scenario (>10 min tyst båt som SKA blockeras).
- TE18: soakens notisgolv är grovt (fullJourneys×5) — per-bro-golv, eller
  betrakta soaken som stabilitets-/läckagevakt enbart (dokumenterat).

## Slutläge (batteriet)
- **jest**: 949/949 (80 sviter) — +26 tester, 2 medvetet omlåsta
  (A2-2-semantiken i fuzz, G-1-taket i route-order).
- **Korpusar**: 11/11 EXAKTA (~150 h) — notisfacit + (mmsi,bro)-multiset +
  NYA riktningsmultiset + NYA golden-text, alla gröna, determinismprövade.
- **Syntetiska**: 44/44 rena (nya PILOT-scenariot inkluderat).
- **Soak**: stabil (0 processfel, kända 3×INV-18-WARN, inga läckor).
- **Lint**: rent på alla ändrade filer. **homey validate publish**: rent.
- Alla fixar passerade facit-fällan UTAN korpusdiffar — de räddar fall
  utanför korpusdata (fartgivarlösa, SV-kurs-returer, gles-kadens-gater)
  och är nu enhets-/scenario-låsta i stället.

---

## §ChatGPT-verifieringen 2026-07-10b (samma kväll)

Användaren fick en PARTIELL extern granskningssession (ChatGPT/Codex mot
commit 0d05dea — UTAN dagens arbetsträd; sessionen dog på tokens). Fem
inbäddade anspråk dirigentverifierades mot aktuell kod: **fyra bekräftade
och fixade, ett avvisat**. Regressionssvit:
`tests/chatgpt-verifiering-2026-07-10b.test.js` (10 tester).

- **C1 (HÖG — neutraliserade GJ-1 i produktion):** GPS-kandidaternas
  livstid var `_gateTimeout` (30 s) och produktions-cleanupen (10 s-
  intervall) raderade varje kandidat FÖRE nästa Class B-sample (3–15 min) —
  tvåstegsbekräftelsen var alltså omöjlig i skarp drift oavsett dagens
  stabilitetsfix. **Osynligt för HELA batteriet**: test/replay startar
  aldrig cleanup-intervallet (`__TEST_MODE__` vid init) — en ren
  test/produktions-divergens. Nu egen `_candidateTtl` (20 min, täcker
  maxkadensen); gate-BLOCKERINGEN är fortsatt 30 s. Två gamla tester som
  låste 30 s-gränsen medvetet omlåsta.
- **C2:** expired-släppets `curDir !== null` uppfylldes av LÅST
  `_routeDirection` även vid sog 0 — låset från gamla resan bevisar ingen
  ny passage. Fönstret är realistiskt: dedup-expiry (notis + 2h) infaller
  alltid före moored-backstopen (stillhetsstart + 2h) för en båt som
  stannat efter notisen. Nu explicit fartkrav (sog ≥ 2) i både huvud- och
  exit-vägen; fartgivarlösa returer täcks av korsningsbevis-reversalen.
- **C3:** sessionssläppet krävde att 2h-posten var FYSISKT borttagen ur
  mappen medan `_persistentDedupCheck` behandlar ålder ≥ 2h som utgången —
  en äkta ny passage strax efter 2h kunde blockeras hela prune-glappet
  (monitoring-cleanupen går var 60:e sekund) och missas helt om båten hann
  korsa 300 m-zonen. Nu: utgången post = frånvarande post, deterministiskt.
- **C4:** bridge_text-cachen/hashen uppdateras FÖRE den oawaitade
  skrivningen: (a) misslyckad skrivning + hash-dedup → texten fastnar på
  enheten (värst för sluttexten "Inga båtar…" som saknar force-själv-
  läkning — utan båtar sker ingen 60 s-omskrivning); (b) två parallella
  skrivningar kunde landa i omvänd ordning (enheten på gammalt värde,
  cachen på nytt). Nu: per-capability-SERIALISERING av skrivningarna +
  hash-nollställning vid fel (garanterad omskrivning nästa UI-cykel).
- **AVVISAT:** "första-och-enda AIS-provet nära bro ger ingen notis" —
  rörelsebeviskravet (RC-S3) är ett medvetet anti-kajliggarskydd; en enda
  observation utan rörelsebevis SKA inte notifiera.

Batteri efter C-fixarna: **961/961 jest (81 sviter)**, 11/11 korpusar
EXAKTA inkl. golden-/riktningsgaterna, 44/44 scenarier, soak stabil,
lint + validate publish rent.
