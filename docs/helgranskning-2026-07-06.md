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

---

## §FÄLTPROV 20260707-092154 (14 h dagtrafik) — analys 2026-07-07/08

**Metod:** 47 Opus 4.8-granskare (45 loggsegment à 2000 rader med överlapp +
bananalys + textkorrelation) läste VARJE rad av 85 282; dirigenten
rotorsaksbestämde varje fynd mot rå jsonl och kod. 15 fartyg, 66 prod-notiser,
117 textändringar, 0 fel, 0 textflappar i huvudflödet.

**Fältbevisade fixar (från 2026-07-06-omgången):** watchdog-eskaleringen
(21→40→80→120 min + reset på äkta data), P8-stale-guarden,
moored-/movement-proof-gaterna, debug_level-insamlingen.

**Äkta fynd → fixade + regressionslåsta:**
1. **ELFKUNGEN-returmissarna (kritisk, 4 missade notiser):** sessionsdedupen
   saknade persistent-lagrets riktningsundantag och BUG7-bevarandet höll
   nycklarna i timmar; N2-återfödselrensningen är död >15 min (completed-
   posten prunas). Sessionschecken speglar nu persistent-beslutet
   (FLOW_TRIGGER_DEDUPE_DIRECTION) — även i exit-fallbacken. 3 enhetstester.
2. **HERA II Järnvägsbron-missen (hög):** scenario A:s sog≥2-gate gäller
   PORTGISSNINGEN men ströp reborn-med-POSITIONSBEVIS (återfödsel i kö-fart
   0,5 kn). Reborn-fallet tar nu riktningen ur positionsdeltat och kringgår
   fart-/cog-gaten. Nytt syntetiskt scenario 'återfödd-i-kö (HERA-klassen)'.
3. **LYS Olidebron-missen (hög):** timeout-completed + reentry-block åt
   gap-failsafen trots ofullbordad resa. Completed-timeout kräver nu
   RIKTNINGSSLUTFÖRD resa (nord ⇒ Stallbackabron, syd ⇒ Olidebron).
4. **Terminal-DEFAULT (hög, IMPERATOR/BALTIC JONGLEUR):** target-nollning vid
   terminalpassage fällde texten till "Inga båtar" MITT i broöppningen →
   PASSED_HOLD_UI (150 s hold, F29-mönstret). 3 enhetstester.
5. **ANCHOR_PASSAGE-fallbacken (låg, EKEN):** kunde ankra target-bron 1181 m
   bort → ankring kräver nu ≤150 m till bron.
6. **Stale-släppet 10 min mitt i transit (INV-14-belagt i BÅDE 14h och 41h):**
   målbro-riktad aktiv transit får 15 min (verklig Class B-täthet 6–13 min);
   mållösa behåller 10.
7. Kosmetiskt: FLOW_TRIGGER_SUCCESS-mmsi:t fångas före await (null-klassen).

**Harnessuppgradering (korpus #9 blottlade harness-core#2):** replayRunner
chunkar nu stora klockgap i 30 s-steg med drain per steg — timer-drivna
textpubliceringar landar på sina riktiga faketider. Blottlade omedelbart de
verkliga INV-14-fallen ovan (som prod uppvisade men gamla harnessen dolde)
och eliminerade den falska INV-10-zombien.

**Accepterat (dokumenterade avvägningar):** F40-stale-degraderingens
antalsfluktuation/ETA-hopp vid 600s-gränsen för väntande glesa sändare
(3→2→3, strax→12/24 min — säkerhetsvalet "aldrig strax på gammal position"
står); extrapoleringens ikapp-hopp vid soft-tröskeln (13→cirka 7 — ärlig
enkelriktad korrigering).

**KORPUS #9 LÅST:** 20260707-14h, facit 72 (prod 66 + 6 rådataverifierade
rättade missar), fördelningsmultiset låst. Batteriet är nu 9 korpusar /
~115,5 h produktionsdata.

## §FÄLTPROV 3: 20260708-001857 (21 h) — analys 2026-07-08

**Metod:** 28 granskare (25 chunkläsare à ~2 500 rader + bridge_text-,
notiskompletthets- och ETA-revisorer) läste varje rad av 59 258; dirigenten
rotorsaksbestämde varje fynd mot rå AIS och kod. 10 fartyg, 55 prod-notiser,
91 textuppdateringar, 0 fel. **Pelare 2 var 100 % ur lådan**: inga missade
och inga falska notiser (alla "saknade" var korrekt obevisade — ankarkravet/
LYS-regeln; HALIFAX Olidebron ×2 är en äkta U-sväng = två öppningshändelser).

**Huvudfyndet — AKIRA-klustret (1 critical + 6 major, samma rot):** en
kajliggare i kajzonen fick target=Klaffbron på sydlig avgångskurs (1,1 kn),
U-svängde norrut och korsade POSITIONSBEVISAT Stridsbergsbron 07:30:09 —
men RC9-blocken läste den inlåsta `_routeDirection='south'` (beyondTarget
föll åt fel håll), TARGET_PROTECTION (maneuver/gps-event) återaktiverades
var 300:e sekund, och Fix D:s COG-debounce behövde två samples till →
spöktexten "på väg mot Klaffbron, om 16 min" levde 5,5 min EFTER beviset
(hela fel-bro-fönstret 07:20:55–07:35:37).

**Fixar (alla batterivaliderade, replayen av körningen = prod EXAKT 55):**
1. **Korsningsbevis-reversalen:** RC9-platserna härleder korsningsriktningen
   ur positionsdeltat (`_evidencedCrossingDirection`); motsatt belagd
   korsning bekräftar reversalen OMEDELBART (`_confirmDirectionReversal` =
   Fix D:s confirmed-gren, extraherad). Origin-underkänd bortom-target ⇒
   `_clearStaleTargetBeyond` (target rensas utan fantomtransition).
2. **Riktningsrelativ N1-reset:** journey-reset rensar bara broar FRAMFÖR
   båten i nya riktningen — full rensning dubbelnotifierade nya benets
   redan avfyrade broar (Jvb ×2 i replayen tills fixen).
3. **Retroaktiv-källa-gaten:** persistent-dedupens riktningsflip-undantag
   kräver ≥15 min gammal post för passage-fallback/just-passed/exit (en
   färsk notis täcker samma öppningshändelse oavsett riktningsflagga —
   AKIRA:s approach-post var felmärkt 'south'). Approach-vägen (source=
   current) behåller HALIFAX-semantiken; äkta returer är ≥31 min i all data.
4. **Svepriktningslåset (SISU):** skipped-bridges-svepets belagda riktning
   låses på reborn-vessels utan `_routeDirection` — notistokens byggdes som
   'unknown' i samma millisekund som svepet visste 'north'.
5. **FIX_U-riktningsgaten:** force-waiting sätts aldrig mot en redan
   passerad parbro (JUNO/SELENE/MAJALISA: retrograd waiting + kritisk
   statusflapp på frusen position).
6. **Hysteresis-spårningen följer null:** "Target bridge changed X→null"
   retriggade varje statuspass (77 identiska resets, SOLANDE) och nollade
   under-bridge-latchen för MÅLLÖSA båtar (ELFKUNGEN@Stallbackabron —
   hysteresen var i praktiken död post-target).
7. **Capture-förnyelsegaten:** kritiska transition-holds förnyas bara när
   positionen avancerat (stale position återfångade holden var 30:e sekund,
   SELENE 02:30–02:33).
8. **Svep-idempotens:** skipped-bridges-svepet körs en gång per
   (mmsi, positionstid) — kördes dubbelt via entered+updated-vägarna.
9. Kosmetik: journey-completed-removals märks 'journey-completed' (inte
   '(timeout)'); lastKnown-posten bär positionens EGEN tid (`posT`) för
   ärlig åldersloggning (t på removal STYR TTL:n medvetet — skyddar mot
   SPIKEN-fantomer); ETA_START loggar bronamn (inte "[object Object]").

**Harness/invarianter:** TARGET_RECALC räknas som journey-reset i harnessen
(legitimerar returnotiser och INV-13:s nya 60 s-korrigeringsfönster (c) —
U-svängskorrigerad målbro-som-mellanbro är inte tyst degradering). Nytt
syntetiskt scenario 'kajavgång-u-sväng (AKIRA-klassen)' (seed 51) med nya
förväntansnyckeln `forbiddenNotifiedBridges` (fantomvakt — fällde först en
felbyggd scenariogeometri, sedan Jvb ×2-regressionen på riktigt).

**Verifierat korrekt per design (ej fel):** ELFKUNGEN-returens slut
("3 min"→"strax"→"ETA okänd"→"Inga båtar"; ingen Klaffbron-notis —
transpondern tystnade 476 m före bron), AVALON:s trippelflush 07:35
(positionsbevisad gap-kedja), SOLANDE:s "Okänd båt"-token (första kontakt,
designad fallback), watchdog-eskaleringen genom tyst natt/eftermiddag,
extrapolerings-/färskhetsflappen ±1 min (dokumenterad avvägning),
MAJALISA:s 56 s "Inga båtar" vid 23-min-gap (bortom 15-min-fönstret).

**KORPUS #10 LÅST:** 20260708-21h, facit 55 = prod (första korpusen utan
en enda rättad miss). Batteriet är nu 10 korpusar / ~136,5 h. Slutläge:
862/862 jest, 10/10 korpusar EXAKTA, 42/42 scenarier, 72h-soak stabil,
lint rent, homey validate publish rent.

## §FÄLTPROV 4: 20260708-224444 (21 h, 24 fartyg) — analys 2026-07-09

**Metod:** 73 Opus 4.8-läsare (max effort) läste varje rad av 180 184 —
körningens alla fynd rotorsakades av dirigenten mot rå AIS och kod (48 råfynd:
1 critical, 9 major). Livligaste körningen hittills (kommersiell trafik,
5-båtsköer). 114 notiser, 203 textuppdateringar, 0 processfel. Första
fältprovet av fältprov 3-fixarna — alla arbetade korrekt (inga U-svängsfall).

**HUVUDFYND A — LOGGHÅLET (infra, ej appfel):** loggfångsten tappade
09:30:04–09:34:54 (~4 min, mitt i lastpiken). Läsarnas CRITICAAL ("NORDIC SOLA
passerade Strids+Jvb utan notis") och "processfrysning" MOTBEVISADES:
CHEERIO:s persistent-dedup-post stämplades 09:33:38 MITT i hålet (processen
levde), nyckelräknaren gick 16→25 genom hålet (+9 = de "saknade" notiserna
avfyrades). Rotorsak: tee-röret skrev direkt i OneDrive-mappen som stallade
under synk. FIX (ANVÄNDARBESLUT): run-with-logs.sh skriver live-loggen lokalt
(~/.ais-tracker-logs/), synkar var 10:e min + vid avslut; dubbel håldetektor
(runtime-larm >3 min stillastående logg + efterhandsanalys i summaryn,
validerad mot det äkta hålet); körboken kräver "Logg-integritet: OK" före
korpuslåsning. KONSEKVENS (ANVÄNDARBESLUT): körningen låses INTE som korpus
(facit overifierbart i hålet); nästa körning blir #11.

**HUVUDFYND B — staleness-klockan (pelare 1-dominanten, 9 läsarfynd samma
rot):** degraderingsgaterna (ETA_STALE_HARD, IMMINENT-kedjan, exit-fallback,
B5 under-bridge, inferred-flush-färskhet) mätte positionsÄNDRINGSTID — en
stillaliggande men aktivt SÄNDANDE väntare (SOKERI: 74 m från Strids, sog 0,
samples var 3:e min) åldrades falskt förbi 600 s-tröskeln → "ETA okänd"-dippar
mitt i kön, strax→minuter-hopp (08:43, 14:50, 15:01), frusna klockor (INVITA,
PIANO, DE ZWIJGER, TUNA). FIX: `_lastConfirmedPositionMs` (max(timestamp,
lastPositionUpdate)) i ALLA degraderingsgater — OMRÄKNINGSGATEN (Fix G-
tvillingen) prövades också men ÅTERTOGS (facit-fällan: 41h-korpusen gav fatal
ETA-oscillation 8→11→9 — utan ny position finns inget nytt att beräkna).
Distinktionen dokumenterad i kod: omräkning kräver positionsförändring,
degradering kräver uteblivna livstecken. WIZARD-/Anomali-3-skyddet består
(timestamp bumpar bara på bearbetade positionsmeddelanden).

**Övriga fixar (alla facit-prövade):**
1. **F4-B (SENTA, äkta miss):** reborn-fönstrets positionsbevisade kandidater
   bär inferredFlush förbi 2000 m-taket (Jvb 2139 m ströps medan Klaffbron
   1184 m i samma fönster notifierades). BLOTTLADE ATT GAMLA FACIT HADE
   MISSAR: 19h OMLÅST 49→51 (SABETH Jvb+Klaffbron) och 11h OMLÅST 25→30
   (MOSHE Jvb+Strids; SOLUTION Jvb+Klaffbron+Strids) — samtliga sju
   positionsbevisade mot rå jsonl (gap-fönstren omsluter broarna).
2. **F4-C (PIANO, dubbelnotis):** riktningsflip-släppets NYA riktning kräver
   rörelsebevis (sog ≥ 2,0) — COG-vobbel hos väntare (40,6° @ 0,7 kn)
   släppte dedup-nyckeln. Lagringssidan orörd (HALIFAX-posten @ 1,1 kn är
   facit-låst; hennes äkta U-svängssläpp @ 4,2 kn består).
3. **F4-J (PIANO, falsk målbro):** låst ruttriktning motsägs inte av COG
   utan rörelsebevis i målbro-NYTILLDELNINGEN — vobbeln gav "Norrut →
   Klaffbron" för en båt 1,3 km SÖDER om bron ("på väg mot Klaffbron"-text
   tills removal).
4. **F4-F (SKAGERN, odetekterad Stallbacka-korsning):** linjekorsningens
   närhetskrav mäter BANANS segmentavstånd, inte bara ändpunkternas
   radialavstånd (samples 312/344 m från bromitten, banan 158 m — helt
   odetekterad: ingen bokföring, ingen notis). Ren generalisering —
   10/10 korpusar oförändrade.
5. **F4-I (MALVA, spökbåt i antalet):** ANKRAD-EFTER-PASSAGE-demoten —
   stillastående ≥10 min efter passage med target ≥800 m bort rensas
   (MALVA: ankrad 130 m utanför kajkapseln, "Två båtar på väg mot
   Stridsbergsbron" i 40+ min). Kö-skyddet: <800 m demoteras aldrig.
   BELUGA-följdfixen: mitt-i-passage-fönstret (20 min) gäller närhet till
   NÄRMSTA bro (hon tystnade UNDER Järnvägsbron och släpptes på 15-min-
   gränsen mitt i transit).

**PRÖVADE OCH ÅTERKALLADE (facit-fällan fungerade, 3 st):**
- **F4-D-strykningen (bevisprincipen för förstakontakt):** bröt SEX låsta
  korpusfacit — 10 rådata-ÄKTA notiser försvann (EXGRATIA/265759070:s session
  session är samma geometriska klass som "fantomen"). Klassen är oavgörbar
  i realtid; F8-beslutet äger. HERA II 07:24 (Klaffbron-notis 1467 m på
  porten-gissning) dokumenteras som accepterad avvägning. OBS: användarens
  ursprungliga beslut fattades på ofullständiga premisser — omprövningen
  redovisad.
- **F4-E på omräkningsgaten** (se ovan).
- **F4-G (under-bridge dominerar gruppens klausul):** gav korpusbelagda
  fatala ETA-sågtänder (strax↔9–11 min) — statusen är flappigare än
  imminent-flaggan. NATHALIE 2-fallet (1 s "om 12 minuter" under bron) =
  accepterad kosmetik; 08:43-klassen löses av huvudfynd B.

**Verifierat korrekt/redan täckt:** F4-K (dedup-rollback vid triggerfel
finns sedan F6); JOSELINA (kö-fönstrets designade trade-off); SOKERI 27,75
vs CHEERIO 25,3 min ("inkonsekvensen" = sändande vs tyst — olika klockor,
korrekt); INVITA:s reborn-notis (positionsbevisad); eta_minutes=-1-sentinelen
(dokumenterad i ARCHITECTURE.md sedan tidigare).

**Testtillskott:** tests/faltprov-4-20260709.test.js (11 tester, exakta
produktionskoordinater) + tre syntetiska scenarier (seed 52 SENTA-, 53
PIANO-vobbel-, 54 SOKERI-klasserna) + ny förväntansnyckel
maxNotifiedPerBridge (dubblettvakt som INV-2:s riktningsundantag inte
täcker). Batteriet: 45 scenarier.

**Slutläge fältprov 4:** 873/873 jest, 10/10 korpusar EXAKTA (~136,5 h, två
facit omlåsta med rådataverifierade rättade missar), 45/45 scenarier,
72h-soak stabil, lint rent, homey validate publish rent.

## §FÄLTPROV 4b: användarens följdfrågor (2026-07-09, eftermiddag)

Användaren utmanade två domar — utfall:

**F4-L SJÄLVLÄRANDE KAJKARTAN (användarens idé, implementerad):**
"Båtar dyker sällan upp mitt i kanalen om de inte legat ankrade" — de
statiska MOORING_ZONES täcker inte gästhamnar/ankringsvikar (MALVA låg
bevisligen 130 m utanför närmsta kapsel). Nu lärs varje konstaterad
förtöjning/ankring (MOORED_DEMOTE + ANCHORED_DEMOTE emitterar
vessel:mooring-spot) persistent i settings (`learned_mooring_spots`,
50 m-dedup med TTL-förnyelse, tak 200, TTL 30 dagar) och N7-kajvakten
konsulterar inlärda platser (100 m-radie): förstakontakt nära en inlärd
plats behandlas som kajavgång — porten-gissningens fantomer stryps exakt
där båtar bevisligen brukar ligga, och skyddet växer för varje körning.
KALIBRERING EFTER ANVÄNDARFRÅGOR (4b): TTL höjd 30→365 dagar (fysiska
kajplatser är stabila i år — 30 dagar hade raderat kartan efter en tyst
vinter; förnyas vid varje återbekräftad förtöjning) + BROFILTER 300 m
(en långkö vid en MELLANBRO — t.ex. Jvb-kö med target Klaffbron 964 m
bort, som passerar ANCHORED-vägens ≥800 m-krav — får inte läras som
kajplats). Notera: inlärningen kräver ingen felnotis — platsen lärs när
en båt LIGGER STILL, oberoende av notisflödet; värsta fall för en osedd
plats är dagens trolighetsgissning tills första förtöjningen där.
Faktakoll redovisad: korpusarna innehåller ~10 verifierat ÄKTA
transit-födslar mitt i kanalen (svag Class B + mottagarluckor), så
gissningen som helhet behålls — kartan stryper den selektivt.

**F4-M STRAX-HOLD — TRE VARIANTER FÄLLDA, SEDAN LÖST GENOM OMDIAGNOS:**
(1) 90 s generell hold → ljög efter äkta ledarpassager (0.5→31-sågtand,
2 korpusar); (2) 30 s samma-båt-kvar → ljög under ärlig degradering
(0.5→11); (3) exhausted-undantag → dött via ETA_STALE_HARD:s
flaggnollning (och avvärjde i förbigående det TIONDE fältlistoffret i
projektionen). FULLSTÄNDIG OMROTORSAKNING avslöjade sedan att "glimten"
var en FELDIAGNOS: NATHALIE 2 var vid 15:32:41 under JÄRNVÄGSBRON
(mellanbron) och 993 m från målbron — "om 12 minuter" var SANT;
sekundskiftet till "strax" var ett färskt sample som ärligt avslöjade att
den 5,5 min tysta sändaren hunnit fram (IMMINENT_SKIP dist=993m i loggen
är beviset). Holds försökte alltså dölja korrekt text — därav
facit-fällningarna. Enda "tidigare strax" vore positionsgissning bortom
datat (HAJH-LAIF-klassen, korpusförbjuden). SLUTLÖSNING: det vattentäta
hörnfallet täcks — båt fysiskt under SJÄLVA MÅLBRON (status under-bridge
+ currentBridge === targetBridge, ej zombie) ⇒ klausulen "strax" oavsett
ledarens ETA. Skild från fällda F4-G (mellanbro-fall = sågtandskällan).
Facit-neutral (10/10 EXAKTA), 4 nya enhetstester, projektionsvaktlistan
utökad med status/currentBridge.

**Slutläge 4b:** 878/878 jest, 10/10 korpusar EXAKTA, 45/45 scenarier,
72h-soak stabil, lint rent, validate publish rent.
