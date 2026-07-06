# Helgranskning 2026-07-06 — radnivågranskning av hela appen

**Metod:** 55 granskningspaket (Opus 4.8-subagenter) med full radtäckning av
139 filer — app.js i 9 segment, VesselDataService i 7, StatusService/PECalc i
2 vardera, övriga lib-moduler, harnessen, Homey-kontraktet, rot-konfig, docs
och samtliga 91 testfiler (~50 raders överlapp mellan segment). Dirigenten
(Claude Fable 5) byggde täckningsmanifestet, avstämde det maskinellt mot
filsystemet (0 saknade filer utöver medvetet undantagna: `.homeybuild/`,
historiska docs-rapporter, logg-/jsonl-data), validerade VARJE fynd
personligen mot koden och körde 2 adversariella skeptiker (Opus 4.8) per
högt/kritiskt fynd. Tre paket levererade platshållarfynd → diskvalificerades
och omgranskades (t-infra föll två gånger på kreditgräns → dirigenten
granskade paketet själv). En oplanerad andra granskningsomgång (workflow-
resume) gav 49 ytterligare fynd som validerades på samma sätt.

**Fyndstatistik:** 95 fynd i omgång 1 + 49 nya i omgång 2 + 1 dirigentfynd
(D-1) + t-infra-egengranskningen = ~142 verdikt. Utfall: 85 bekräftade,
23 delvis, 14 motbevisade, 12 dubbletter, 4 diskvalificerade platshållare,
2 prövade→avgjorda under FAS D/E.

**Skeptikernas värde:** de fällde 3 av 11 höga fynd (app-3#1: riktningen LÅSES
vid måltilldelning + target-transitionen körs före status-eventet; vds-1#1 och
harness-synthetic#1: dokumenterade designval) och hittade dessutom
`_lockRouteDirection`-anropare som dirigentens första grep missade.
Omvänt bekräftade de enhälligt SOG-sentinelen, BRIDGE_GAPS-felen och
fältlistvaktens luckor.

## Fixgrupper (alla batterivaliderade: full jest + 8/8 korpusar EXAKTA + syntetiska scenarier + lint per fil)

### F1 — sog=null-familjen (P1+P2)
- **aisclient#1 (hög):** SOG-sentinelen 102.3 ("ej tillgänglig", ITU-R M.1371)
  föll på SOG_MAX=100 → HELA positionsrapporten avvisades → båt utan
  fartgivare helt osynlig. Normaliseras nu till null i AISStreamClient
  (≥102.15), symmetriskt med COG 360-sentinelen.
- **status-1#1 (nedgraderad kritisk→medel):** `null.toFixed(2)` i
  waiting-timerns loggrad kastade TypeError (loggargument evalueras oavsett
  debugnivå) och slängde tickens statusresultat — engångs per fartyg
  (mutationen före kastet + fältlistan). Defensiv formatering.
- **vds-3#1/#2 (medel):** `Number(null)=0` föll på fartgrindarna (0.7/0.1 kn)
  resp. ANCHOR_BLOCK (<0.3 kn) → null-sog-båt fick målbro först <300 m/aldrig
  efter passage. Grindarna gäller nu bara KÄND fart (rörelsebevis-gaten
  täcker ankrade).
- **vds-2#1 (medel):** stale-display-undantagen gatade på finit sog →
  null-sog-glessändare flappade in/ut ur texten. Kö-klassen (≤600 m från bro)
  omfattar nu okänd fart.
- **D-1 (dirigentfynd, medel):** `||`-fallback i jumpanalys-indata kastade
  legitima cog=0 (nordkurs)/sog=0 (stilla) → `??`.

### F2 — geometridata (P1)
- **constants#1 (hög) + constants#2 + bridgeregistry#1/#2:** BRIDGE_GAPS
  olide–klaff 950 m var FYSISKT OMÖJLIGT (haversine 1363 m; enbart
  latitudseparationen är 1264 m) och järnväg–strids 420 m var 63 % för högt
  (257 m). Matade `_calculateCumulativeTime` → fler-bro-ETA fel ±1–3 min.
  Korrigerade till haversinvärden; BridgeRegistrys självtest-baslinje
  (EXPECTED_DISTANCES) rättad; permanent jest-invariant låser gapen mot
  koordinaternas haversine (±10 m). Golden snapshots MEDVETET omlåsta —
  varje diff verifierad fysikaliskt korrekt (Olide→Klaff-ben ÖKADE,
  Järnväg→Strids-ben MINSKADE). INV-18-warnen i 19h-korpusen försvann
  (bättre ETA-fysik).
- **app-2#R2-2 (medel):** `[AIS_REPLAY_SAMPLE]` loggades OVILLKORLIGT per
  AIS-meddelande i produktion (vårt eget korpusinsamlingsverktyg spammade
  Homey-loggen). Gatar nu på debug_level='full'; run-with-logs.sh varnar
  aktivt om tom jsonl efter 2 min. **⚠️ Fältprov kräver debug_level='full'.**

### F3 — koordinationsnivå-kedjan (8:e + 9:e fältlistoffren)
- **vds-4#1 (hög):** nivån skrevs till `_stabilizationLevel` (ingen läsare),
  konsumenterna läste `lastCoordinationLevel` (ingen skrivare) — TRE designade
  GPS-skydd döda (micro-graces GPS-term, GPSJumpGateService:235,
  PECalc-outlierdämpningen). Rätt fält skrivs/nollas nu + bärs i fältlistan.
- **app-5#1 (medel):** micro-graces kritisk-övergångsterm läste
  `_criticalTransitionHoldUntil`/`_zoneTransitions` ur BridgeText-PROJEKTIONEN
  (tredje fältlistan!) som saknar fälten → alltid false. Läser nu levande
  objekt via `getVessel(mmsi)`.

### F4 — drifthärdning
- **app-8#1 (medel):** watchdog-backoffens strike-reset förväxlade "färsk
  data" med "ung socket" → eskaleringen 20→40→80→120 min kunde ALDRIG ske;
  reconnect var 20:e minut för evigt på tyst kanal (RC-S2:s 503-churn).
  Reset gatar nu på sinceMessage.
- **app-9#1 (medel):** StatusService/PECalc saknades i destroy-kedjan →
  5-min-setInterval läckte per onInit-cykel. StatusService.destroy() +
  kedjan utökad.
- **app-4#2 (medel):** alarm_generic räknade orenderbara båtar → larm PÅ +
  "Inga båtar"-text upp till 180 s. Larmet speglar nu texten (alarm ⇔ text).
- **app-4#1 (låg):** F29 kunde återpublicera "AIS-anslutning saknas" efter
  lyckad reconnect — BT-F5-undantaget tillagt.
- **vds-1#R2-1 (medel):** timeout-removal registrerade "avslutad resa" utan
  målbropassage → halvfärdig resa (gap-klassen) gav 10 min TOTAL AIS-blackout
  vid återkomst (reentry-blocket ignorerar allt). Kräver nu
  målbro i passedBridges (Bug E:s äkta fall bevarat).
- **app-6#R2-2 (medel):** exit-fallbacken saknade förtöjnings-/rörelsebevis-
  gate OCH snapshotten saknade fälten — kajliggare inom 400 m från
  Kanalinfarten kunde ge återkommande falska notiser. Gates + snapshotfält +
  vaktlista + 2 regressionstester.
- **Härdningar (låg):** rad 1323-terminalbeslutet föredrar riktningslås +
  finit-guard (inert idag — skeptikerbelagt — men familjekonsistent); samma i
  VesselLifecycleManager; passage-latchens registrering föredrar låst riktning
  (route-latch#1: null-riktning gjorde F13-releasen omöjlig i NO-kröken);
  F13-releasen kräver 2 konsekutiva motsatta samples (route-latch#2,
  Anomali 18-spegling); frysackumulatorn nollas vid ny latch-episod
  (status-2#2); protection-aktiveringsobjektet bär coordinationActive
  (vds-7#1); klockbakhoppsklamp i mellanintervallgrenen (gpsjump#2);
  global koordinationsprune i cleanup() (syscoord#1); GPS-gate-kandidater
  dedupas per bro (gpsjump#R2-3); moored-demote rensar grace-posten
  (vds-1#R2-2); dev-timern spåras (app-8#2); settings-sidans spara-knapp
  låst tills debug_level laddats (kontrakt-homey#1).
- **Raderat:** test-integration-complete.js (stale API-referenser),
  .eslintrc.json (död konfig), ProximityServices två oanvända metoder utan
  B5-guard.

### F5 — harnesshärdning
- **harness-core#1 (medel):** INV-5/7 var Set-/existensbaserade per
  (mmsi,bro) → blinda för missad ANDRA passage (U-sväng/retur — exakt
  SOAK-RESA-18-klassen). Nu RÄKNINGSBASERADE (antal notiser ≥ antal passager
  per nyckel; k:te passagen kräver k notiser i tid). **8/8 låsta korpusar
  passerar de skärpta invarianterna — inga historiska missar avslöjades.**
- **harness-corpora#R2-1 (medel):** låst korpus utan fördelningspost hoppade
  TYST över multiset-gaten → nu hårt fel.
- **harness-corpora#R2-3 (medel):** icke-finita läckagefält inaktiverade
  soak-kontrollen tyst → nu eget fel (LÄCKAGEDIAGNOSTIK TRASIG).
- **t-kedjor#1 (medel):** SNAPSHOT_CONSUMED_FIELDS-vakten saknade 6:e offrets
  fält (maxRecentSpeed/passedAt) — kompletterad (+ _moored/_hasMovementProof).

### F6 — testkvalitet (åtgärdade)
- MockFlowCards flerradiga JSON-console.log per notis tystad bakom
  REPLAY_VERBOSE (t-infra — direkt ENOSPC-bidrag).
- Nytt fönsterutgångstest för getCoordination-10s-släppet (t-unit-gps#1 —
  den viktigaste fastlåsningsfixen var otestad).
- feedIsSilent-grenen ("ansluten men döv") testad + färsk-feed-motfall
  (t-connection#2).
- ELIMINATION_PROTECTION-vakten exekveras nu bevisligen (t-regression-a#1 —
  gamla testet var grönt även utan vakten pga frusen fake-klocka).
- +1-min-taket asserteras faktiskt (t-eta-geo#1); golvtestet diskriminerar
  (buffertsnitt < golvet) (t-regression-b#2); re-entry-testernas kastade
  resultat asserteras (t-lifecycle#1/#2); BridgeTextService-konstruktorns
  omkastade argument rättade (t-bridge-text#3); RC4-flaken (realtid utan
  fake-timers) → toBeCloseTo.
- ScenarioLibrary: "Waiting"-waypoints flyttade 280→260 m (nådde aldrig
  waiting — WAITING_SET är 270), gränstest mot operativa 480/270,
  BOAT2-positionen rättad (200 m söder om Strids = 57 m från Järnvägsbron
  med verkliga gapet — kommentaren hade räknat midpoint mot 420-felet!).
  Goldens medvetet omlåsta; diffen bekräftar att waypointsen nu når de
  statusar de påstod sig testa.

## Motbevisade fynd (urval, med motivering)
- **app-3#1 (hög→motbevisad som pelarbugg):** kedjan bröts på tre punkter —
  `_routeDirection` låses vid måltilldelning (5 anropare), target-transitionen
  körs FÖRE status-eventet, fallbacken kräver finalTarget i passedBridges.
  Raden härdad ändå (familjekonsistens).
- **vds-1#1, constants#3, app-7#1, route-latch#3, app-6#R2-1:** de "smala"
  COG-banden är det DOKUMENTERADE P5-beslutet (constants.js:276–285): strikt
  band för högriskbeslut, brett endast för notis-token/dedup. Verklig färdled
  är 22–35°/202–216°.
- **harness-synthetic#1:** textmodellen emitterar ALDRIG "inväntar broöppning"
  (NEVER_SHOW_WAITING; enda frasmallen är "på väg mot") — mooring-regression
  ger på-väg-mot-text som regexen fångar.
- **gpsjump#1/#R2-1, vlm COG-360-delen:** COG 360 normaliseras till null vid
  ingest — sentinelen kan inte nå analysen.
- **geometry#1 (hög→delvis/accepterad):** epsilon-grenen är riktningsblind
  MEN |proj|≤10 m kräver position ~vid brolinjen längs kanalaxeln — köande
  båtar ligger 50+ m bort och METHOD-förvillkoren kräver stor förflyttning.
  Ingen åtgärd (ändrad passagesemantik utan bevisad vinst = korpusrisk).
- **t-unit-a#1:** jest.config har clearMocks:true — assertionen är inte vakuös.
- **syscoord#R2-1:** bridgeTextDebounced LÄSES (StatusService:268).
- **vds-7#R2-1:** metoden kräver ingen target (felcitering).

## Medvetet accepterat (dokumenterat)
- **peta-1#1 — PRÖVAD OCH ÅTERTAGEN:** gap-reset före rå-ETA:n gav
  korpusbelagd FATAL sågtand (19h: Klaffbron 2→32 min på 10 s i texten).
  En cykels förgapsoptimism, RC4-dämpad och självläkande, är den medvetna
  avvägningen. (Detta var granskningens enda fix som batteriet fällde —
  facit-fällan fungerade exakt som avsett.)
- app-6#1 (imminent-hold): tre release-vägar verifierade; kvarvarande fönster
  kräver ihållande accept_with_caution med avancerande position.
- app-7#2 (ETA-token för långsam bro-nära båt): fysikaliskt korrekt värde.
- app-5#R2-1 (Fix G fryser för sog=null): extrapolering utan känd fart vore
  gissning.
- Fallbacktextens enkelhet (app-5#R2-2/3), sampleKey-dedupen (peta-1#R2-2),
  axisBearing-falsy-0 (geometry#R2-1 — förekommer aldrig), isHeadingTowards
  latenta kast (geometry#R2-2 — ingest stoppar ogiltiga koords),
  harness-core#2 (timer-notisers dräneringstid — triggar inte i dagens 8/8),
  INV-2:s 180-min-tak och INV-13:s no-target-undantag (harness-core#R2-1/3),
  root-config#3/#4 (loggar utanför repot; rotation onödig för valideringsverktyg),
  kontrakt-homey#2 (blandspråkig settings-sida — kosmetiskt, validate-rent),
  mockens eta_minutes-null-tolerans och saknade homey.settings (tester
  injicerar egna).

## Kvarvarande testskuld (bekräftad, ej åtgärdad — låg risk)
Dokumentationstester/inline-kopior som inte exekverar produktionskod:
t-bridge-text#1/#2/#4, t-korningar#1, t-regression-a#2/#3, t-regression-b#1,
t-notification-reliability#2/#3/#R2-3/4/5, t-target-mooring#1/#2,
t-comprehensive#1/#2/#3, t-journey#2/#3/#4/#R2-5, t-flow#1, t-connection#1/#3,
t-eta-geo#2, t-passage#1/#2, t-scenario-library#R2-1/2, t-regression-b#R2-1,
t-bridge-text#R2-2/5, t-passage#R2-2, harness-core#R2-2. Dessa är märkta och
motiverade; det verkliga beteendet täcks av replay-korpusarna (som fångar
texten EFTER hela skyddskedjan och notiser genom riktiga gaten). Betas av
löpande vid testöversyner.

## Slutläge
- **819/819 jest** (73 sviter; +17 nya regressionstester)
- **8/8 låsta korpusar EXAKTA** (~101,5 h) — under SKÄRPTA räkningsbaserade
  INV-5/7; notissiffror och fördelningsmultiset oförändrade genom hela
  granskningen (ingen fix ändrade en enda korpusnotis)
- **35 syntetiska scenarier** rena
- **72h-soaken stabil:** 0 processfel, tomma strukturer, invarianter rena,
  samma 3 dokumenterade INV-18-WARN som före granskningen
- **Golden snapshots:** 2 medvetna omlåsningar (BRIDGE_GAPS-fysiken;
  ScenarioLibrary-positionerna) — varje diff rådataverifierad
- **Lint** rent på alla ändrade filer

## Bedömning
Granskningen hittade EN verklig P2-klassbugg av substans (SOG-sentinelen —
osynliga båtar), EN trippel-död skyddskedja (koordinationsnivån), två
geometridatafel som förvrängt ETA sedan dag 1, en drifthärdningsmiss
(watchdog-eskaleringen) och en handfull latenta fällor — samtliga fixade och
batterivaliderade. Inget av fynden hade observerats i fältdata (korpusarna är
exakta genom alla fixar), vilket är förenligt med att buggklasserna kräver
ovanliga indata (fartgivarlösa Class B-båtar, tysta kanaler, kajliggare vid
Kanalinfarten).

**"Redo att publiceras efter ett fältprov"-bedömningen från 2026-07-03 STÅR
SIG och är nu starkare:** invariantlagret som ska granska fältprovet är
skärpt (räkningsbaserat), replay-fångsten är produktionsren, och den enda
regressionen granskningen själv införde fångades av det egna batteriet.
Kvarvarande väg: (1) fältprov ~1 dygn med **debug_level='full'**
(run-with-logs.sh varnar annars), (2) analys + korpus #9-låsning,
(3) merge + `homey app publish`.
