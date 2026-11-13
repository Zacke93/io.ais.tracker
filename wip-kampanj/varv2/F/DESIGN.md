# Familj F (KAJ), varv 2: ägarbeslut U23 — kajen norr om Klaffbron

Worktree `S/varv2/F/wt`, bas c14938f. S = scratchpad, V = S/varv2, F = V/F.
Revision 1 efter granskningen (V/F/GRANSKNING.md, "ÄNDRINGAR KRÄVS") står i
avsnitt 10, med en commit per punkt; ägarfrågan om 300–500 m i avsnitt 11.
Revision 2 efter omgranskningen (V/F/OMGRANSKNING.md) står i avsnitt 12.
Avsnitt 1–9 är rättade där granskningen visade fel (världen 129, norra
spetsen, andra varningens ledtid).

**Ledtider.** I avsnitt 1–10 mäts kajprovens ledtider (K-, X-proven) mot
världsmodellens korsning (`F/scripts/scensum.py`). Granskaren interpolerar
korsningen ur fixarna (`F/rtmp/lead.py`), vilket ger 4 s kortare: 47 → 43,
77 → 73 och 96 → 92 s. Avsnitt 12 och ARCHITECTURE använder granskarens
metod.
Alla tider UTC. VDS = `lib/services/VesselDataService.js`, BOS =
`lib/services/BridgeOpeningService.js`.

## 1. Rotorsaken, bekräftad

**Mekanismen (T-A M8, T-B "Kajfrågan").** Kapseln "Kajen norr om Klaffbron"
ligger 190–295 m från bron, mitt i väntzonen. Dess köundantag var 15 min
(`lib/constants.js` MOORING_ZONES, `VDS._classifyMooring`). En köare mot
Klaffbron klassades därefter förtöjd, målbron rensades (MOORED_DEMOTE) och
texten blev "Inga båtar …". Armen uppdaterades inte utan målbro och dog efter
30 min (`ARM_STALE_TTL_MS`). Ankomstspärren i app.js (`_observeOpeningArrivals`)
läste samma 15 min och bekräftade ett "kajstopp", så avgången blev en ny ankomst
(`OPENING_QUAY_DEPARTURE`, app.js:1535) med en ny, sen varning.

**Logg, värld 313 (R1 AISHub, `V/tA/cards/F02-w313-Klaff`).** Varning #5 09:22:37
(845 m). Kö 09:26–10:26. 09:48:34 `[MOORED] … zon "Kajen norr om Klaffbron"
(still 18 min)`. 10:14:20 armen stale. 10:27:49 `OPENING_QUAY_DEPARTURE` och
varning #6, 32 s före korsningen 10:28:21.

**Minsta repro (`F/kaj/A.jsonl`, T-B:s kajscenario A, R0, en båt).** Kö 250 m
norr om Klaffbron 08:27:36–08:52:36. På c14938f: 08:42:38 MOORED (15 min),
"Inga båtar" 08:42:38–08:53:38, 08:54:08 OPENING_QUAY_DEPARTURE och Klaffbron#3
vid 101 m, 47 s före korsningen. Samma fall som syntetiskt scenario (avsnitt 5).

## 2. Rättningen på kodnivå

1. **`lib/constants.js`**, Kajens post: `queueGraceMs: Infinity`, med kommentaren
   ÄGARBESLUT U23 (2026-11-09) och motivet D1. Gästhamnen (`0`) och zoner utan
   fältet påverkas inte.
2. **VDS `_classifyMooring`**: zonvillkoret bröts ut till `_zoneMinStillMs(vessel,
   zone)`, med samma tre villkor som förut (målbro, rörelsebevis, målbron inom
   600 m). Den gamla läsningen `Number.isFinite(zone.queueGraceMs)` hade gjort
   Infinity till "ingen grace" (3 min). Nu godtas varje tal > 0, och NaN, null och
   saknat fält betyder ingen grace. Med Infinity klassar zonlagret aldrig köaren.
   Navstatus 1/5 (lager 3) och 2 h-backstoppen (lager 5) är orörda.
3. **VDS `holdsQuayQueue(vessel, bridgeName)`** (ny, publik): sant när båten
   ligger i en zon med obegränsat köundantag, inte är förtöjd och uppfyller
   villkoren med just `bridgeName` som målbro.
4. **app.js `_observeOpeningArrivals`**: `stopGraceMs` ersätter `queueGraceMs` i
   bekräftelsen av kajstoppet. Medan klassningen håller köaren är stoppet samma
   ankomst (Infinity). När den släpper henne (navstatus, backstoppen, ingen
   målbro) gäller 30 s-regeln. `gapResetsStop` läser zonens fält som förut, så
   ett AIS-glapp nollställer inte stoppet och övernattningen bekräftas nästa
   morgon. En ändlig grace beter sig exakt som förut. Sedan revisionen minns
   stoppet att klassningen höll henne (`heldAsQueue`, L1, avsnitt 10.5), och
   avgången godtas inne i Kajen när båten flyttat minst 50 m mot bron (M3,
   avsnitt 10.2).

**2 h-gränsen gäller vid Kajen.** `queueBridge` (lib/utils/bridgeQueue.js:38–44)
ger null i en MOORING_ZONE. Därför är `_hasFreshBridgeQueueEvidence` falsk där,
och backstoppen biter (testet "queueBridge ger null i kajkapseln …" i
`tests/u23-kajens-ko.test.js`). Samma båt i farleden har undantaget.
`_noteBridgeQueueApproach` tömmer dessutom anflygningsbeviset för en stilla båt
i en kajzon, så `_deferUncertainBridgeQueue` kan inte heller skjuta upp
backstoppen där. (I transit genom en kapsel, sog ≥ 0,5 kn, behålls bekräftat
bevis sedan M1 c, avsnitt 10.3.)

## 3. Båtens väg genom appen under kön

- **Brotexten:** "En båt på väg mot Klaffbron, beräknad broöppning strax". Det
  följer imminent-regeln i docs/bridgeTextFormat.md (< 300 m, färsk position)
  och U6 (strax vid lång kö är sanktionerat). Ingen ny fras. **Rättat efter
  granskningen (M2):** kapselns norra spets (300–320 m) har varken imminent-
  flaggan eller bekräftad väntan (`queueBridge` ger null i en kajzon) och
  visar den kvarstående ETA:n ("om 4 minuter" i granskningens X3kaj), medan
  farledsköaren på samma avstånd har bekräftad väntan och får "strax". Efter
  20 min stillhet släpps målbron på båda (avsnitt 11). Brotextsviterna saknade
  kajfall; sedan L3 finns det i `tests/bridge-text-variant1.test.js`.
- **Armen:** målbron står kvar, så armen uppdateras vid varje fix och dör inte.
  Den avväpnas vid passagen. I kajscenarierna `F/kaj/K60` och `F/kaj/K110` (R0)
  levde den 4 650 s (60 min kö) och 7 650 s (110 min kö), med en
  Klaffbronvarning i båda. På c14938f dog den stale efter 30 min, och båda
  scenarierna fick en andra varning 47 s före korsningen.
  `_disarmEvidence` avväpnar aldrig inom 600 m, och `warnedAt` står kvar.
- **Konvojtäckningen:** i provet med två köare (`F/kaj/KKONVOJ`) täcks köaren
  vid Kajen av sin egen varning hela vägen. Den andra båten låg i Gästhamnen och
  demoterades efter 3 min som förut.
- **Kajavgångsgrinden:** 0 `OPENING_QUAY_DEPARTURE` i T-B:s 17 kajköer med U23,
  mot 5 på c14938f. QUAY_DEPARTURE_GATE (`_slowInitialQuayApproachNeedsProof`)
  gäller bara båtar utan målbro, och köaren har kvar sin. Därför försvinner
  också den extra fixfördröjningen `TARGET_QUAY_POSITION_PROOF` vid avgången.
- **När kommer en andra varning ändå?** När klassningen har släppt henne.
  - Efter 2 h-backstoppen (150 min kö, `F/kaj/K150`): MOORED 10:28:08, "Inga
    båtar" 29 min, armen stale 10:57:38, ny varning 10:58:38 vid 168 m, 77 s
    före korsningen sedan M3 (före M3 10:59:08 vid 101 m, 47 s, samma sena
    varning som c14938f gav redan efter 15 min).
  - Med navstatus 5 (`F/kaj/KNAV5`): texten "Inga båtar" som på c14938f, och
    den nya varningen 77 s före korsningen (47 s före M3 och på c14938f).

  Båda är U23:s uttryckliga gränser. Varningen är sen, men den uteblir inte.
  Efter en omstart eller ett AIS-glapp mitt i kön kommer sedan L1 ingen andra
  varning (avsnitt 10.5).

## 4. Övervägda alternativ

| Alternativ | Varför inte |
|---|---|
| Bara `Infinity` i konstanten | VDS:s `Number.isFinite` hade gjort Kajen till 3 min. I app.js hade stoppet aldrig bekräftats, så avgången efter navstatus, efter backstoppen eller efter en övernattning hade fått sitt kort tystat av ankomstspärren. Det hade varit en missad öppning. |
| Ändligt tal, t.ex. 2 h eller 40 min (ägarens alternativ C) | U23 valde B. I app.js räcker inte en ren tidsgräns: en navstatusförtöjd köare som går efter 40 min har en död arm, och dess nya kort hade tystats. |
| `queueBridge` godtar köaren vid Kajen | Det tar bort 2 h-gränsen vid Kajen, vilket bryter U23. Det sprider sig också till BOS, StatusService och texten. |
| `waitingBridge` räknar Kajens köare som bekräftad väntan (för INV-10) | Det ändrar `arm.waitingAtBridge` i BOS (täckning, ETA-token, reservdeadline), som hör till familjerna B och D. INV-10:s blinda fläck vid Kajen rättas i stället i harnessen (avsnitt 10.1). |
| Spärren i app.js med ren 2 h-tid utan klassningen | Navstatusfallet missas (se raden ovan om ändligt tal). |

## 5. Regressionstest och negativtester

- **`runSyntheticScenarios` "kö-25min-i-Kajens-kapsel (U23)"**: en båt söderut
  ligger still exakt 250 m norr om Klaffbron i 25 min, med ben (`legs`), och går
  sedan igenom bron.
  - Två nya förväntningar: `noDefaultWhileStopped` och `minOpeningLeadS`. Den
    senare mäter mot den sanna korsningen ur scenariots egna sampel.
  - Mot c14938f fälls scenariot på alla tre villkoren: "Inga båtar" 06:49, en
    ÖPPNINGSDUBBLETT vid Klaffbron och en varning 47 s före korsningen. Med U23
    är det grönt.
  - docs/VALIDATION.md: 75 scenarier, och ett nytt stycke om placeringen.
- **`tests/u23-kajens-ko.test.js`** (10 test):
  - 2 regressionstest som fäller c14938f: köaren står kvar i 60 min, och först
    backstoppen klassar henne;
  - 1 kontroll av `queueBridge`;
  - 6 negativtester som klarar både c14938f och U23: norrgående med målbro
    bortom 600 m efter 3 min, båt utan målbro, navstatus 5, 2 h-gränsen,
    Gästhamnen efter 3 min, och kajliggaren utan rörelsebevis.
- **`tests/opening-queue-quay-stop.test.js`**:
  - fixturen bär klassningens fält;
  - "U23: kö på 25 min … inget nytt kort" fäller c14938f, och 7 av 8 test
    klarar båda;
  - nya fall för backstoppen och navstatus 5, och övernattningen med en ny båt
    utan målbro.
- **Uppdaterade låsningar av 15-minutersregeln:**
  - `gasthamnskapseln.test.js`: konstanten och övre änden, som nu är backstoppen;
  - `moored-vessel-detection.test.js` LAGER 4+2;
  - `m1-ihallande-stillhetsankare.test.js` KÖ-ZONENS GRÄNS: brusig givare 46 →
    152 min, ren 18 → 124 min, uppmätt i båda träden med `F/scripts/m1mat.js`;
  - `helgranskning-2026-07-10.test.js` V2-1, där sog=null-köaren bärs till
    backstoppen.
- Revisionens test står i avsnitt 10.

## 6. Samspel med andra familjer

- **A och C (VDS och app.js):** jag rör bara `_classifyMooring` (en rad
  ersatt), två nya metoder före `_hasFreshBridgeQueueEvidence` och
  `_observeOpeningArrivals`. Det överlappar inte målbrokedjan, NEW_JOURNEY
  eller ny-båtsgrenen.
- **B och D (BOS):** ingen BOS-ändring. Armen lever längre för köaren, eftersom
  målbron står kvar.
- **E (motorn) — beskrivs här, inte ändrat:**
  1. E:s pågående D1-KAJZON-predikat (`V/E/wt/…/registry.js:1195`) läser
     `Number.isFinite(zone.queueGraceMs) ? … : 0`. Med Infinity ger det 3 min
     och förutsäger en demotion som appen inte längre gör. Läs fältet som
     `> 0 ? värde : 0`, så att Infinity betyder "aldrig".
  2. `bugHunt/lib/shrink.js:128` har gränskonstanten "queueGraceMs (Kajen)" =
     900 s, som nu är inaktuell.
  3. **INV-10 STRAX-ZOMBIE:** rättat i harnessen av F (cf43811, avsnitt 10.1).
     Den första förklaringen här (gles AISHub, beviset rensat vid
     Järnvägsbron) var fel; se avsnitt 7.

  Punkterna 1 och 2 är granskningens L2 och går till E via dirigenten.

## 7. Motorns syn: vad U23 flyttar i de 2 000 provvärldarna

Sanningsspåret över standardens 2 000 världar (`--no-shrink`, F/hunt/bas mot
F/hunt/u23, `F/scripts/huntdiff.py`): 261 → 264 fynd, och 0 ändrade
registerdomar. Alla förändringar ligger i kajvärldarna:

| Värld | Utslag | Före → efter | Förklaring |
|---|---|---|---|
| 313 | T2 LEDTID<60s (F02) | KANDIDAT → **borta** | `--repro` ger BORTA. |
| 129 | INV-10 STRAX-ZOMBIE | – → KANDIDAT (nytt kluster); efter revisionen MÄTGRÄNS | **Rättad förklaring (granskningen M1):** köaren står 60 min som "strax" (U6). Harnessens `confirmedTargetWaits` byggde på `waitingBridge`, och `queueBridge` ger null i en kajzon, så bekräftad väntan var omöjlig vid Kajen oavsett AIS-täthet. INV-10 fällde därför varje lång kö där: en blind fläck i harnessen, inte ett appfel (texten är densamma som i farleden). Rättad i cf43811 (avsnitt 10.1). Farledstvillingen (`F/cards/var2-w129`) gav samma utslag på c14938f av ett annat skäl: beviset rensades inte vid Järnvägsbron utan vid fixen 17:25:24, 24 m från Gästhamnens kapsellinje (radie 35 m), i transit på 4,3 kn; nästa fix var redan stoppet. Rättad i c5fdb1c (avsnitt 10.3). Tvillingen flyttade dessutom hela rutten (`laneM` −60), inte bara kön. |
| 397 | INV-3 ETA-SÅGTAND UPP | – → KANDIDAT (befintligt kluster, U22) | ETA-kedjans stale-imminent-studs efter ett 11 min AIS-glapp. Farledstvillingen ger samma utslag på c14938f. |
| 235 | T3 VARNING-EFTER-SANN-PASSAGE | – → DESIGN U17 | Samma varning #6 på båda. Köaren absorberas inte längre i #6, eftersom hennes egen varning #4 bär henne, så registret dömer om den. |
| 1623 | INV-14 DEFAULT-FLASH | – → DESIGN U1-C11 | Ett AIS-glapp på 26 min ger släppet vid 25 min. Hon kommer tillbaka i texten i stället för att vara demoterad. |

T-B:s 17 kajköer (`F/scripts/kajutfall.py`, F/kaj/base mot F/kaj/v2):

| Mått | c14938f | U23 |
|---|---|---|
| Demoterade köare | 9 | 1 |
| "Inga båtar" under kön efter 15 min | 140 min | 45 min |
| Andra varningar | 2 | 0 |
| OPENING_QUAY_DEPARTURE | 5 | 0 |

- **Den kvarvarande demoterade köaren** är ORION i värld 128. Hon är senfödd
  vid kajen, utan målbro, och behandlas som i dag.
- **De kvarvarande 45 minuterna "Inga båtar"** beror på AIS-glapp: i värld 829
  40 min, i 1753 29 min och i 1623 26 min. De styrs av de ordinarie
  åldringsreglerna, inte av U23.
- **`--repro` på kort för de åtta övriga demotionsvärldarna** (`F/cards/kaj-w*`,
  `F/runs/kajkort-repro.txt`):
  - 128, 835, 1127 och 1753 har samma utslag som på c14938f;
  - 129 och 397 får de nya KANDIDAT-utslagen ovan;
  - 235 och 1623 får DESIGN-utslagen.

**Batteriet** (`F/batt`, commit 3887254): alla steg har slutkod 0.

| Steg | Resultat |
|---|---|
| jest | 370 sviter, 5 276 test |
| lint | grönt |
| replay:all, med och utan monitoring | alla låsta korpusar matchar facit |
| replay:synthetic | 75 scenarier rena |
| replay:openings | standardgrindarna godkända |
| soak, med och utan monitoring | stabila |
| fassvepet, med och utan monitoring | OK, 24 korpusar |
| självtest | GRÖNT |
| quick | se nedan |
| porcelain | bara `?? node_modules` |

Batteriets första körning (`F/batt-1`) stoppades vid jobbets tidsgräns under
självtestet. Batteriet kördes därför om helt på den slutliga commiten.
Öppningsgrindarna, soak och de 74 gamla syntetiska scenarierna jämfördes också
med c14938f (`F/battbas`): loggarna är identiska utom heap-måttet.

**Quick mot V/bas/quick (första körningen, 3887254):** 58 → 60 fynd, 0 borta
och 0 ändrade registerdomar. Två nya fynd, båda i kajvärldar: värld 129
INV-10 (KANDIDAT-kort F05; förklaringen i tabellen ovan är rättad) och värld
235 T3 (DESIGN U17). Bankspåret var oförändrat (45 av 48 rena). Revisionens
quick står i avsnitt 10.6.

## 8. Hur besluten följs

- **U23:** byggt som beslutet lyder. ELFKUNGEN, SUSANNE och Gästhamnen är
  oförändrade, och negativtesterna klarar c14938f.
- **D1/INV-B1:** konflikten är löst (docs/reliability-spec.md).
- **U6:** strax vid lång kö behålls.
- **U22:** ETA-kedjan är orörd. INV-3-utslaget i värld 397 är ETA-kedjans
  stale-imminent-studs. Farledstvillingen (kön flyttad 75 m öster om kapseln,
  `F/cards/var2-w397`) ger exakt samma utslag på c14938f. Det hör till det
  U22-uppskjutna klustret (standardens F01, 28 utslag).
- **U13:** U23 flyttar inget låst facit. Revisionen flyttar två, båda med
  rådatabelägg (FACIT.md): 20260806-42h (M3, öppningsfacit och golden-events)
  och 20260713-41h (M1 c, golden-text).
- **U2/C-IV:** ingen andra varning tillkommer. I kajköerna gick andra
  varningar från 2 till 0, och efter L1 kommer ingen heller efter en omstart
  eller ett AIS-glapp mitt i kön. M3:s varning för REBEL är en ny ankomst
  efter en natt i Gästhamnen, inte en andra varning för samma öppning.

## 9. Dokument

- lib/constants.js (MOORING_ZONES-kommentaren);
- docs/ARCHITECTURE.md (§Förtöjningslagren lager 4 och 5, konstantlistan och
  C0b-raden; i revisionen norra spetsen, L1 och M3);
- docs/reliability-spec.md (B1/INV-B1-raden om U23 med 300 m-förbehållet, och
  den reviderade B1-raden om ETA-klausulen, L3);
- docs/VALIDATION.md (76 scenarier och två scenariostycken);
- docs/helgranskning-2026-11-03.md (REBEL markerad rättad 2026-11-09);
- tests/replay-validation/corpora.js (omlåsningsnoterna för 41h och 42h);
- kommentarer i VDS, app.js och replayRunner.js.

## 10. Revision 1 (granskningen 2026-11-09)

En commit per punkt på 3887254: cf43811 (M1 a/b), f166adf (M3), c5fdb1c
(M1 c), abaeafe (M2) och 1893af8 (L1 och L3). L2 hör till E. Proven ligger i
F/rev (verbosa körningar `*.vstdout`/`*.log`, sammanfattade med
`F/scripts/scensum.py`; fatala invarianter med granskarens `F/rtmp/inv.js`).

### 10.1 M1 a/b — harnessens blinda fläck vid Kajen (cf43811)

- **Mekanismen (rättad):** `confirmedTargetWaits` (replayRunner.js) byggde på
  `waitingBridge`, och `queueBridge` ger null i en kajzon. Vid Kajen var
  bekräftad väntan därför omöjlig, och INV-10 STRAX-ZOMBIE (35 min) fällde varje
  lång kö där, oavsett AIS-täthet. Texten är densamma som i farleden (U6).
- **Rättningen (F, enligt dirigenten):** harnessen räknar också den båt som
  `holdsQuayQueue(live, targetBridge)` håller, läst på den levande båten
  (`vesselDataService.getVessel`; presentationskopian saknar
  `_hasMovementProof`), med färsk position och minst 60 s stillhet — samma
  krav som `waitingBridge`. Appen är orörd, och `queueBridge` ger fortfarande
  null i kajzonen, så 2 h-backstoppen gäller där.
- **Nytt scenario** "kö-60min-i-Kajens-kapsel-med-annan-trafik (U23, INV-10)":
  60 min kö 250 m norr om Klaffbron, och en senare båt kommer in i texten 39 min
  efter köarens "strax". Utan regeln: INV-10 ("stod 44 min"). Mot c14938f:
  "Inga båtar" under kön och en tredje Klaffbronvarning 47 s före korsningen.
  Med regeln grönt (76 scenarier).
- **Utfall:** X1kaj 48 min → 0 fatala, K150 122 min → 0 fatala, X1far 0 → 0.
  `--repro F/cards/kaj-w129`: den sparade mekanismen BORTA, och kvarvarande
  INV-10 (38 min) blir MÄTGRÄNS-INV10-VÄNTKEDJA (`F/rev/l1/repro.kaj-w129.txt`).

### 10.2 M3 — kajavgången inne i Kajen (f166adf)

- **Rättningen** (helgranskning-2026-11-03:248–253, granskarens
  `probe-kajavgang.diff`): avgången från ett bekräftat stopp godtas inne i en
  kajzon med köundantag när båten flyttat minst 50 m från stoppet MOT kortets
  bro. Ett bekräftat stopp krävs som förut, så en köare som klassningen håller
  berörs inte.
- **Fält (20260806-42h):** S/V REBEL:s varning efter natten i Gästhamnen kommer
  tillbaka: Klaffbron#24 08:44:41.473 vid 249 m, 105 s före rådatans korsning,
  som fältappens Klaffbron#19 08:44:41.922. Omlåst enligt U13 (FACIT.md).
- **Syntetiskt:** den sena andra varningen efter 2 h-gränsen och navstatus 5
  kommer 77 s före korsningen i stället för 47 s (K150, KNAV5; granskaren
  43 → 73 s). K60 och X1kaj har fortfarande en enda varning.
- **Öppningsgrindarna före och efter** (`F/rev/openings.fore.log`,
  `openings.efter.log`): O1 36/36 i 42h som förut; O2 21 → 22 bekräftade inom
  20 min av 41 i 42h, totalt 228/437 → 229/438. Inga röda.
- **Test:** tre nya i `opening-queue-quay-stop.test.js` (REBEL-fallet fäller
  f166adf^; rörelse bort från bron är ingen avgång; köaren som klassningen
  håller lägger ut genom Kajen och är samma ankomst).

### 10.3 M1 c — farledsbeviset genom en kajkapsel (c5fdb1c)

- **Mekanismen:** `_noteBridgeQueueApproach` tappade allt köbevis för en fix i
  en kapsel, även i transit. Farledstvillingen till värld 129 tappade sitt
  bekräftade Klaffbronbevis vid fixen 17:25:24 (24 m från Gästhamnens linje,
  4,3 kn), och nästa AISHub-fix var redan stoppet. Följden blev också att
  2 h-undantaget från användarvalet 2026-09-06 aldrig nådde en sådan köare.
- **Rättningen** (granskarens `probe-transit-evidence.diff`): redan bekräftat
  bevis behålls genom kapseln när båten går i minst 0,5 kn i samma riktning
  (`waitAnchor` och `waitConfirmedAt` nollställs). En stilla båt i en kajzon
  tappar beviset som förut, så Kajen och Gästhamnen klassas som förut.
- **U13:** sonden flyttade bara 20260713-41h (golden-text 264 → 262). Rådatan
  visar att båda ändrade raderna blir rättare (en stilla kö vid en tidigare bro
  får ingen minutprognos), så den committades med omlåsning (FACIT.md). Raderna
  är ETA-klausuler, men ingen kod i ETA-kedjan ändras (U22-förbehåll i noten).
- **Utfall:** `--repro F/cards/var2-w129`: den sparade mekanismen BORTA, och
  INV-10 blir MÄTGRÄNS-INV10-VÄNTKEDJA (`F/rev/l1/repro.var2-w129.txt`). 42h:s
  olåsta diagnostik `confirmedTargetWaits` 6 → 7.
- **Kvar, känd lucka (samma på c14938f):** min första tvilling
  `F/cards/var-w129-farled` (rutten genom kapslarna, kön 60 m ut) ger
  fortfarande INV-10 KANDIDAT, 38 min. Hennes första stillafix 17:26:30 ligger
  i Kajens kapsel (26 m från linjen, sog 0), där beviset för en stilla båt
  tappas som förut, och kön fortsätter 73 m från linjen. Att behålla beviset
  för en stilla båt i kapseln skulle låta `_deferUncertainBridgeQueue` skjuta
  upp 2 h-gränsen vid Kajen under ett AIS-glapp, så jag rör det inte
  (`F/rev/l1/repro.var-w129-farled.txt` och `.base.txt`).
- **Test:** två nya i `bridge-queue-adversarial.test.js` (beviset behålls genom
  kapseln i 3 kn; det tappas när båten saktar in till 0,1 kn där).

### 10.4 M2 — norra spetsen 300–320 m (abaeafe)

- **Dokumenten** (constants.js, ARCHITECTURE §lager 4, reliability-spec) lovar
  inte längre U23 över 300 m. Spetsen beter sig som farleden på samma avstånd
  när det gäller målbron (släpps efter 20 min stillhet), men texten skiljer sig
  (avsnitt 3). §3 här är rättad.
- **Ingen kodändring.** Granskarens kodförslag (BridgeTextService räknar
  `holdsQuayQueue` som väntan vid målbron; `_isInTargetQueueZone` godtar
  `holdsQuayQueue`) väntar på ägarfrågan i avsnitt 11, eftersom samma
  20-minutersgräns gäller hela bandet 300–500 m även i farleden.

### 10.5 L1 och L3 (1893af8)

- **L1, granskarens förslag (bedömt säkert):** `quayStop.heldAsQueue` minns att
  klassningen höll köaren och överlever omstart. Efter en omstart eller ett
  AIS-glapp mitt i kön är hon ny för appen, och zonlagrets 3 min förtöjer henne,
  men stoppet bekräftas inte så länge hon ligger kvar (< 50 m), inte sänder
  navstatus 1/5 och inte legat still i MAX_STATIONARY_WAIT_MS räknat från
  stoppets första fix — U23:s tre villkor.
  - Varför säkert: det gäller bara Kajen (enda zonen med Infinity) och bara ett
    stopp som klassningen faktiskt höll. En passage kräver att hon flyttar sig,
    och då ersätts stoppet. Riktningen ingår i nyckeln, så en återkomst åt andra
    hållet är en egen ankomst. Övernattningen (> 2 h) bekräftas som förut.
  - Utfall: X2kaj (omstart) och X5kaj (30 min AIS-tystnad) får inte längre ett
    andra kort 77 s före korsningen, som X2far och X5far. X3kaj (norra spetsen)
    behåller sin första varning som X3far; före L1 kom en ny 96 s före
    korsningen. Texten är oförändrad ("Inga båtar" 30,4 och 22,6 min, som i
    farleden). K150, KNAV5 och K60 är bitlika.
  - Banken 24/24 bitlik mot c5fdb1c; replay:all med och utan monitoring matchar
    facit; 76 syntetiska rena; öppningsgrindarna identiska.
  - Test: fem nya i `opening-queue-quay-stop.test.js` (omstart, AIS-glapp,
    navstatus 5 efter omstart, 2 h-gränsen över omstart, båt som aldrig hölls).
    Fyra fäller abaeafe; navstatusfallet klarar båda.
- **L3:** reliability-spec B1-raden "utan ETA-klausul" är reviderad mot beslutet
  2026-09-12 och U6, och D1:s lydelse står kvar i beslutstabellen som historik.
  `tests/bridge-text-variant1.test.js` har tre kajfall: inom 300 m samma
  "strax" som farledsköaren med bekräftad väntan (och `waitingBridge` null vid
  Kajen), norra spetsen med ordinarie ETA-klausul medan farledsköaren på 310 m
  har "strax", och "ETA okänd" på gammal position.

### 10.6 Batteriet och quick (revision 1)

**Batteriet** (`bash S/port/battery.sh V/F/wt V/F/batt-rev1`, HEAD 1893af8):
alla steg har slutkod 0.

| Steg | Resultat |
|---|---|
| jest | 370 sviter, 5 289 test (2 hoppade) |
| lint | grönt |
| replay:all, med och utan monitoring | alla låsta korpusar matchar facit |
| replay:synthetic | 76 scenarier rena |
| replay:openings | standardgrindarna godkända (loggen identisk med L1-körningen) |
| soak, med och utan monitoring | stabila |
| fassvepet, med och utan monitoring | OK, 24 korpusar |
| självtest | GRÖNT |
| porcelain | bara `?? node_modules` |

**Quick mot V/bas/quick** (`F/scripts/huntdiff.py`): 58 → 60 råa utslag, 0
borta, 0 ändrade registerdomar, och kandidatklustren är desamma (3 i
sanningsspåret, KNIVSEGG i bankspåret). De två nya utslagen ligger i
kajvärldar och är inga kandidater:
- värld 129, INV-10 STRAX-ZOMBIE: MÄTGRÄNS-INV10-VÄNTKEDJA (efter M1 a/b);
- värld 235, T3: DESIGN U17-TYST-BÅT-RECOVER (avsnitt 7).

Mot familjens första quick (`F/batt/hunt-quick`) är enda skillnaden att F05
(KANDIDAT INV-10, värld 129) blivit MÄTGRÄNS; kandidatklustren 5 → 4.
Bankspåret är oförändrat (48 varianter, 45 rena).

**Kajköerna** (T-B:s 17, `F/kaj/rev1` mot `F/kaj/v2`): demoterade köare 1,
"Inga båtar" 45 min, andra varningar 0 och OPENING_QUAY_DEPARTURE 0, som efter
U23. Text, notiser, varningar, passager och täckning är bitlika i alla 16
världar; bara harnessens `confirmedTargetWaits` ändras (M1 a/b).

## 11. Fråga till ägaren: 300–500 m

**Frågan.** Ska en båt som ligger still 300–500 m från sin målbro stå kvar i
texten tills hon kör vidare, sänder navstatus 1/5 eller legat still i 2 h, som
inom 300 m? I dag släpps målbron efter 20 min stillhet
(`VesselDataService._isInTargetQueueZone`: `lastActiveTime` inom 20 min), och
texten blir "Inga båtar". D1 (2026-06-03) säger att en stoppad båt inom 500 m
står kvar. Luckan är inte U23:s: den gäller farleden lika mycket.

**Var bandet ligger.** Kö-zonsvakten behövs bara där ingen opasserad bro ligger
inom 300 m: söderut mot Klaffbron norr om bron (Kajens norra spets 300–320 m,
farleden öster om kapslarna; Gästhamnen 354–411 m är en kajzon utan köundantag
och klassas efter 3 min oavsett), norrut mot Klaffbron söder om bron, och
söderut mot Stridsbergsbron norr om bron. Norrut mot Stridsbergsbron ligger
bandet 43–243 m söder om Järnvägsbron, vars skyddszon håller köarna där
(Järnvägsbron–Stridsbergsbron 257 m).

**20 minuter är inget ägarbeslut.** Tiden kom med kö-zonsvakten i
valideringskörningen 2026-07-02 (docs/valideringskorning-2026-07-02.md:36–40):
en köare som pausade 12 min på 399 m tappade målbron efter 120 s, och vakten
fick "aktivitetsfönster 20 min; äkta ankrare täcks av förtöjningslagren/
2h-backstoppen". Jag hittar ingen ägarpost om 20 min i docs/.

**Mätt utan kodändring** (`F/scripts/skanna300.js`, `tcanalys.js`; F/rev):

| Underlag | Stopp ≥ 20 min 300–500 m före målbron | Målbron släppt i bandet |
|---|---|---|
| Banken, 24 korpusar | Kö-zonsvakten höll 3 gånger: 211488730 och REBEL i Gästhamnen (sedan zonförtöjda), 265819150 ~320 m från Stridsbergsbron i 11 min | 0 av bankens 5 målbortag (alla 886–2 860 m från målbron) |
| Standardens 2 000 provvärldar | 73: 71 norrut i Järnvägsbrons kö (skyddade), w450 300 m i Kajens kapsel 20 min och w1975 301 m i farleden 31 min (båda R1) | 0 (R1-brusets fart håller båtarna aktiva) |
| Granskningens rena R0-prov (sog exakt 0) | X3kaj 306 m, X3far 307 m | 2: målbron släpps efter ~21 min, "Inga båtar" ~19,5 min till avgången |

**Vilka båtar.** Luckan kräver målbro, rörelsebevis och en transponder som
rapporterar exakt 0 kn. I provvärldarna var alla 73 långa stopp i bandet köare
(motorns kajliggare ligger i kajzonerna och räknades inte). I banken höll
kö-zonsvakten två kajliggare i Gästhamnen (zonförtöjda efter 3 min) och en köare
320 m från Stridsbergsbron i 11 min; ingen tappade målbron i bandet. Ankrare
med navstatus 1/5 klassas av lager 3 oavsett, och ankrare utan navstatus finns
inte i underlaget.

**Alternativ och följder:**
- **A — behåll 20 min.** D1-luckan står kvar. Mätt frekvens 0 i fältbanken och i
  2 000 provvärldar. Med L1 och M3 får en båt som tappat målbron ingen ny
  varning när hon lägger ut; den första gäller.
- **B — som inom 300 m: kvar så länge positionen är färsk och hon ligger still
  inom 500 m, med 2 h-backstoppen som slut.** D1 håller i hela radien, och
  enligt mätningen är det bankneutralt (inga målbortag i bandet). Kostnad: en
  ankrare utan navstatus visas som "på väg mot X" i upp till 2 h, som inom 300 m
  i dag (valideringskörningens motivering för 20 min hänvisar redan ankrarna
  till förtöjningslagren och backstoppen). Vid Kajens spets behövs dessutom
  granskarens textändring, annars står en fryst ETA ("om 4 minuter") kvar.
- **C — ett längre men ändligt fönster, t.ex. 40 min.** Täcker de flesta köer i
  motorns världsmodell (20–60 min), men en kö som varar längre tappas fortfarande
  och visar "Inga båtar".

## 12. Revision 2 (omgranskningen 2026-11-09)

Omgranskningen godkände båda omlåsningarna enligt U13 och fann två fel i
revision 1:s nya kod, båda i rimliga brusfall där revision 0 gjorde rätt.
Fem commits på 1893af8: 056a535 (M3), ba72a32 (M3, låg), bd30c8a (L1),
5af2ebc (L1, låg) och 0dce236 (41h-noten). Proven ligger i F/rev/r2, med
granskarens scenarier (`F/rtmp2/sc`) och ledtider mot interpolerad korsning.

### 12.1 M3: ett ensamt GPS-hopp är ingen avgång (056a535)

- **Felet:** en förtöjd båt vid Kajen med aktiv ankomst fick en enda fix 60 m
  mot bron i 0,6 kn, utan GPS-hoppflagga. Det gav `MOORED_RELEASED`, ny målbro,
  `OPENING_QUAY_DEPARTURE` och en falsk varning vid 226 m (A5n5, A5n0). Var hon
  förtöjd av 2 h-gränsen (A5q), förbrukade den falska varningen ankomsten, och
  den verkliga avgången blev utan varning.
- **Rättningen** (granskarens `probe-m3-rimlighet.diff`): avgång inne i
  kajzonen kräver att steget sedan föregående fix (VDS:s `lastPosition`,
  ankomstens `lastFixTs`) är högst 20 m plus dubbla farten gånger tiden.
  Utanför kajzonerna gäller kravet inte.
- **Utfall:** A5n5, A5n0 och A5q ger ingen falsk varning, och den verkliga
  avgången varnas 57 s före korsningen, som i revision 0. REBEL finns kvar
  (Klaffbron#24 08:44:41.473 vid 249 m), och banken är 24/24 bitlik mot
  revision 1. K150, KNAV5 och B2 behåller 73 s.
- **Test:** fixturen bär `lastPosition`. Nytt: GPS-hoppet för en båt förtöjd av
  2 h-gränsen och med navstatus 5 (båda fäller 1893af8), och en verklig avgång
  inne i Kajen (60 m på 60 s i 2 kn).
- **Känd gräns:** kravet växer med tiden sedan förra fixen. Med tre minuter
  mellan fixarna (en stilla klass B-sändare) tillåts 131 m i 0,6 kn, så ett hopp
  på 60 m skulle passera. Proven har 30 s mellan fixarna.

### 12.2 M3, låg: priset för enfixsregeln (ba72a32)

- **A4** (navstatus 5, fix var 10:e s): en äkta omförtöjning 100 m mot bron inne
  i Kajen räknas som avgång. Varningen kommer 62 min (3 744 s) före korsningen,
  och den verkliga avgången får ändå sin egen, 54 s före (samma som revision 0).
- **A4n0** (utan navstatus, förtöjd av 2 h-gränsen): den tidiga varningen
  kommer, och sedan ingen vid den verkliga avgången, eftersom U23 håller henne
  som köare på den nya platsen. Revision 0 gav 54 s.
- REBEL behöver enfixsregeln med gles AIS. Avvägningen är ägarens och står i
  ARCHITECTURE §Förtöjningslagren (lager 4) och i kommentaren i app.js.
- ARCHITECTURE:s ledtider är nu granskarens: 73 s efter 2 h-gränsen (43 s före
  M3), 73 s för X2kaj/X5kaj och 92 s för X3kaj före L1.

### 12.3 L1: minnet släpps på klassningens stillhetsklocka (bd30c8a)

- **Felet** (B3, K150 med en fartspik 09:27:38): spiken raderar det
  obekräftade stoppet, och nästa fix startar ett nytt med senare första fix.
  VDS:s stillhetsklocka startar inte om, så backstoppen förtöjer henne 10:28 som
  vanligt, men minnet höll "samma ankomst" till 11:28. Avgången 10:58 fick
  ingen varning. Revision 0 gav den.
- **Rättningen** (granskarens `probe-m3-l1.diff`): `keptQueue` kräver också att
  `Date.now() − vessel._stationarySince` är under MAX_STATIONARY_WAIT_MS. Efter
  en omstart är klockan ny, så omstartsfallet påverkas inte.
- **Utfall:** B3 får sin varning 73 s före korsningen. B1, X2kaj, X5kaj och K60
  har fortfarande ingen andra varning, B2, K150 och KNAV5 har 73 s, och X3kaj
  behåller sin första varning.
- **Test:** fartspiken som regressionstest (fäller 056a535).

### 12.4 L1, låg: negativtestet (5af2ebc)

Testet fällde revision 0 bara på fältet `heldAsQueue: false`. Det prövar nu
beteendet: köaren hålls vid stopp A, efter en omstart ligger hon 60 m bort vid
kapselns norra spets där klassningen inte håller henne, och stopp B bekräftas
med 30 s-regeln så att avgången blir en ny ankomst. Testet klarar 3887254 och
HEAD, och det fäller en avsiktligt felaktig kopia där minnet följer med till
nästa stopp (`heldAsQueue: holdsQueue || stop?.heldAsQueue`).

### 12.5 41h-noten (0dce236)

Noten i corpora.js anger nu mekanismen, som granskaren bad om: app.js
stale-ETA-gren (Fix G) extrapolerar inte när `queueBridge` ger en kö vid en
tidigare bro (`queueAhead`), och 09:36:30 ger ProgressiveETACalculator
`ETA_POST_TRANSITION_HOLD` "unknown" i stället för `ETA_GAP_RESET`:s 13,9 min.
Facit är orört.

### 12.6 Batteriet och quick (revision 2)

**Batteriet** (`bash S/port/battery.sh V/F/wt V/F/batt-rev2`, HEAD 0dce236):
alla steg har slutkod 0. jest 370 sviter och 5 293 test (2 hoppade), lint,
replay:all med och utan monitoring (alla låsta korpusar matchar facit, med de
två godkända omlåsningarna), 76 syntetiska scenarier, öppningsgrindarna
(loggen identisk med revision 1), soak med och utan monitoring, fassvepet med
och utan monitoring (24 korpusar), självtestet GRÖNT, och porcelain visar bara
`?? node_modules`.

**Quick mot V/bas/quick:** 58 → 60 råa utslag, 0 borta, 0 ändrade
registerdomar och samma kandidatkluster (3 i sanningsspåret, KNIVSEGG i
bankspåret). De två nya utslagen är desamma som i revision 1: värld 129 INV-10
(MÄTGRÄNS-INV10-VÄNTKEDJA) och värld 235 T3 (DESIGN U17). Mot revision 1:s
quick är resultatet identiskt.

**Kajköerna** (`F/kaj/rev2`): T-B:s 17 köer i 16 världar är bitlika mot
revision 1 i text, notiser, varningar, passager, täckning och
`confirmedTargetWaits`.
