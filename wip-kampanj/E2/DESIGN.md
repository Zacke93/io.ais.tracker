# DESIGN för familj E2: ETA-etappen enligt U20 (K6, F06, F07) — revision 2026-11-05

**Status: delvis.** Koden är klar och batteriet grönt utom 20260917-7h, men två
saker kräver beslut som inte är designerns:

- **Ägarfråga (U13):** 22 låsta rader i bandet sanning < 10 min blir sämre
  (mot 55 rättare), alla med samma mekanism. Se §9 och FACIT.md
  "Ägarfrågan".
- **Dirigentbeslut:** 20260917-7h kan inte låsas om (ofullständig fångst).

Worktree: `K/E2/wt`, detached på e949ae1. Commits ovanpå e949ae1:

| Commit | Innehåll |
|---|---|
| 3bd8e64 … 7a80260 | första leveransen (memo per fix, del 1–3, F06, F07, DEMO, dokument) |
| ac4e131 | revisionen: mötande konvoj, F07-baslinjen, F06-marginalen, ökningstaket, tester |
| 9827d60 | DEMO-omlåsning efter revisionen (golden-text 5, golden-events 3, 17h:s öppningsfördelning, noter) |
| 66bb985 | ARCHITECTURE §8 (e) och VALIDATION "Familj E2" (HEAD) |

*Containeromstart:* inga ocommittade ändringar hittades när revisionen började.

## 0. Granskningens punkter och vad revisionen gjorde

| Allvar | Punkt | Åtgärd |
|---|---|---|
| hög | 25h SENTA/ELAIZA: varningen efter den sanna passagen | **Rättad.** Ny grind `_meetsOnlySilentOpening` i BridgeOpeningService (samordnas med K/K2, §2.3). Båda varnas 15:17:16 som medlemmar, 8,8 och 10,3 min före korsningarna. |
| hög | Quick-värld 5 (BRISEN) | **Motbevisad som missad öppning.** BRISEN är täckt av KAJSA:s varning i samma riktning; RECOVER-kortet efter passagen är U17-klassen (§1.5). Redovisat per kluster i §6. |
| hög | U13: sämre rader, replay:all rött | **Delvis.** Sämre i bandet < 10 min 26 → 22, rättare 46 → 55; sex korrekta "strax" åter. Resten lyfts som ägarfråga (§9). 20260917-7h kräver dirigentbeslut. |
| medel | F07 BORTA bara genom tröskeln; spärren håller uppe ett osett värde | **Rättad.** En baslinje äldre än 5 min försvaras inte mot en lägre färsk mätning. AVALON "om 18" → "om 12" (sanning 4,5). Testet kräver nu värdet. SISU och IDUN oförändrade. |
| medel | F06 saknar marginal | **Rättad.** Kvot ≥ 1,2 och momentanfartens ETA ≥ 3,5 min. NORDIC SOLA, CATHARINA och ELFKUNGEN 13h har åter strax; MALUCA och JUNO 17h står kvar (§9). |
| låg | Påståendet om de oparade banden | **Rättat** i ARCHITECTURE, VALIDATION och här. |
| låg | `_leadsEtaGroup` gör inte brotextens urval | **Rättad.** Brotextens lista och `isValidETA`; Fix G:s registrering avgörs efter snapshot-loopen. Enhetstest med filtrerad båt. |
| låg | dramatic_increase-hållningen obegränsad | **Rättad med ett tak på 15 min.** Tre fix och 5 min mättes och gjorde ANDREA 42h sämre (§3). |

## 1. Rotorsaker, bekräftade med logg och minsta repro

### 1.1 K6: dubbelkörningen (ARCHITECTURE §8 (e))

Meddelandevägen och snapshot-vägen räknade SAMMA AIS-fix med ungefär 25 ms
mellanrum, och båda muterade `ProgressiveETACalculator` — vikt 1 − 0,6² =
0,64. Dubbelkörningen bar last på tre sätt (glappets passagegolv, outlier-
grindens 30 s-fönster och pass 1:s värde som läses av notistoken och
öppningsmotor). Oförändrat från första leveransen; minsta repro i
`tests/e2-eta-etapp-2026-11-04.test.js`.

### 1.2 F06 (värld 192, XENIA)

Medelfarten i fartbufferten ligger efter vid inbromsning: 11:58:30 gav
snittet 3,0 min men momentanfarten (4,5 → 2,5 kn) 4,4 min, och texten gick
strax → om 4 → strax. Fixtur `tests/fixtures/e2-f06-xenia-inbromsning-varld192.jsonl`.

Granskningen visade att regeln utan krav höll 44 gånger i banken, sex gånger
under 3,25 min på momentanfarten. NORDIC SOLA (19h 06:17:48): 4,6 → 4,1 kn,
snittet 2,8 min, momentanfarten 3,0 min, korsade efter 2,8 min — "strax" var
rätt. Skillnaden mot XENIA är storleken: 4,5 → 2,5 kn (kvot 1,47) mot 4,6 →
4,1 kn (kvot 1,08).

### 1.3 F07 (20260708-21h, AVALON)

Verbose-logg (`K/E2/tmp/rev2/logs/21h-wt.log`, och granskarens
`K/E2/tmp/gr/vlog/20260708-21h.log`):
- 07:01:59 mätte AVALON 30,3 min medan JÄÄTTEN ledde gruppen. Värdet visades
  aldrig, men blev hennes publicerade baslinje.
- 07:07:02 kom nästa fix efter 5,04 min: "fresh 11.9 vs burst-base 30.3 (gap
  5.0 min) → clamped to 17.7".
- 07:11:30 nollades JÄÄTTEN (ETA_STALE_HARD), AVALON ledde med 17,7, och
  texten blev "om 18". AVALON korsade 07:16:01–02.

Första leveransen rörde bara Fix G:s extrapolering; spärren höll fortfarande
uppe en mätt men inaktuell baslinje. Granskarens "synlighetsregel även för
mätta värden" prövades (§3) och gav en ny sämre rad.

### 1.4 25h SENTA/ELAIZA (granskningens höga punkt)

Verbose-loggar i `K/E2/tmp/rev2/logs/25h-{base,e2}.log`:
- LIFE STYLE (norrut) beväpnades mot Stridsbergsbron 15:05:33, d = 2 372 m, och
  hördes aldrig mer. #33 avfyrade på deadline 15:10:33 (etaMin −1).
- ELAIZA (söderut) beväpnades 15:13:40 och absorberades i #33, täckt t.o.m.
  15:27:01,958, även på e949ae1.
- SENTA beväpnades 15:15:18. På e949ae1 läste beväpningen pass 1:s 11,96 min,
  hon låg utanför #33:s konvojfönster (gräns 11,73) och seedade #34, som
  avfyrade 15:20:11. Med en beräkning per fix är värdet 11,27, och #33
  absorberade även henne.
- Båda tystnade (ELAIZA efter 15:17:41, SENTA efter 15:20:47). Täckningen
  löpte ut 15:27:01 och RECOVER gav #36 — ELAIZA hade korsat 15:26:06.

Rotorsaken är alltså en mötande konvoj mot en tyst motpart: #33 var en
prognos från ett tio minuter gammalt fix för en båt som aldrig kom, och de
söderut gående båtarna fick täckning av den. e949ae1 räddades av slump.
K:s bakkant (efter bokförd passage) och K2:s regler griper inte här; att
`_belongsToEvent` prövas om vid varje fix räcker inte heller, eftersom ELAIZA
och SENTA låg inom 600 s från #33:s referens hela tiden. Mätt med K:s och
K2:s BridgeOpeningService (`K/E2/tmp/rev2/e2k`, `e2k2`): samma utfall.
Minsta repro: `tests/fixtures/e2-25h-elaiza-senta-motande-tyst-vard.jsonl`
(14 rader, tre båtar); e949ae1 ger SENTA:s #34 utan ELAIZA, den gamla E2 inget
kort före 15:27:01, revisionen #34 15:17:16 med båda.

### 1.5 Quick-värld 5 (BRISEN, F-KRYP, R1)

Världen återskapad ur receptet (`basSeed 1, index 5, R1`, radHash 96fb926c…)
med `K/E2/tmp/rev2/tools/mkworld.js`; fixtur
`tests/fixtures/e2-quick-varld5-brisen-u17.jsonl`.
- KAJSA (söderut) avfyrade #4 08:07:00 och korsade 08:12:10. BRISEN (söderut,
  samma riktning) absorberades 08:07:42.
- På e949ae1 var KAJSA:s prognos 08:12:15 och täckningen 08:22:15, kortad till
  08:22:10,8 vid KAJSA:s passage. Nu var prognosen 08:12:00,8, alltså 10 s
  före passagen, och täckningen 08:22:00,8. K:s rebasering förlänger aldrig.
- BRISEN:s senaste fix 08:16:40 sa ankomst 08:21:10. Hon korsade 08:20:43,
  tystnade till 08:22:03,9, och RECOVER gav #9 08:22:00 med etaMin −1.

Det är U17-klassen: säkerhetsvarningen för en tyst båt vars senaste position
sa att hon skulle hinna igenom den gemensamma öppningen. Ingen öppning missas
— BRISEN var varnad genom KAJSA:s kort 13,7 min före sin korsning. Motorn
klassar den ännu som KANDIDAT eftersom U17 inte är registrerad (uppgift för
dirigenten). Regressionstestet låser täckningen före korsningen.

## 2. Rättningen på kodnivå

### 2.1 `lib/services/ProgressiveETACalculator.js`

Oförändrat från första leveransen: memo per fix (`_fixIdentity`,
`_fixContext`, `_captureFixState`/`_restoreFixState`), del 1 (glappbaslinjen,
`GAP_BASELINE_ALPHA` 0,4), del 2 (`_outlierWindowMs`, fall mot förväntat nu,
bekräftelse av fall), del 3 (`EMA_ALPHA_PER_FIX` 0,64). Nytt i revisionen:

- **F06:** villkoren i `_processETAWithProtection` är nu
  `decel.ratio >= DECEL_HOLD_MIN_RATIO` (1,2) och
  `decelInstantETA >= DECEL_HOLD_MIN_INSTANT_ETA` (3,5 min), utöver rå-ETA
  < 3 på medelfarten, nytt inträde i strax och ingen imminent-flagga.
- **Ökningstaket:** `INCREASE_HOLD_MAX_MS` = 15 min. `_increaseHoldStreak`
  (Map mmsi → tid för första hållningen i serien) bokförs där outlierskyddet
  tillämpas, nollas när en prövning inte blir en hållen ökning, sparas och
  återställs av memot och städas i `_cleanupOldETAHistory`,
  `clearVesselETAHistory` och `destroy`. `[ETA_INCREASE_BOUND]` loggar släppet.

### 2.2 `app.js`

- **`_leadsEtaGroup(vessel, eta)`** använder `getVesselsForBridgeText()` (med
  `getAllVessels()` som reserv), kräver att fartyget självt står i listan och
  räknar bara andra båtar med `isValidETA` (> 0).
- **`_notePublishedETA` / `_applyPublishedNote` / `_flushPublishedNotes`:**
  Fix G:s extrapolering registreras som baslinje bara om fartyget leder. I
  `_reevaluateVesselStatuses` samlas besluten i `_pendingPublishedNotes` och
  avgörs i ett `finally` efter loopen. Utanför loopen avgörs de direkt.
- **`_reconcilePublishedETA`:** en baslinje vars `_etaPublishedAtMs` är äldre
  än `STALE_ETA_SOFT_THRESHOLD_MS` (5 min) behandlas som saknad när den färska
  mätningen är LÄGRE (`[ETA_PUBLISH_BASE_STALE]`). Mätta publiceringar
  registreras som förut.

### 2.3 `lib/services/BridgeOpeningService.js` (samordnas med K/K2)

- **`_meetsOnlySilentOpening(arm, event, arms, now)`** är sann när: händelsen
  har avfyrat och saknar bokförd passage; armen har känd riktning och en egen
  deadline (`fireDueMs`) i framtiden; och händelsens egna varnade medlemmar
  (inte absorberade) finns, alla går i motsatt riktning och alla är tysta
  (`rawAnchorMs` äldre än `STALE_ETA_SOFT_MS`).
- **`_bindLooseArms`** hoppar över en sådan värd i `host`-sökningen, så att
  armen seedar en egen händelse eller ansluter till en annan.

Den hör hemma i K:s domän. Den ligger i E2:s patch för att E2 inte kan
integreras utan den (granskningen: "integrera inte förrän absorptionen tål
det lägre värdet"). Vid sammanslagning med K och K2 är det en ny metod och
ett villkor i `host`-sökningen i `_bindLooseArms`, där K har lagt till
`_anchorFloorHost`. Konflikten blir en rad.

### 2.4 Tester

- **`tests/e2-revision-2026-11-05.test.js`** (20 tester): 25h ELAIZA/SENTA (2),
  grinden (6), världen 5 (1), F07 (4, varav 21h-fixturerna), ledarurvalet och
  registreringen efter loopen (3), F06-marginalen (3), ökningstaket (1).
- **`tests/e2-eta-etapp-2026-11-04.test.js`:** F07-testet kräver nu "om 12" och
  förbjuder "om 18/19" 07:07–07:12 i båda fixturerna, i stället för att låsa
  felet.
- **Fixturer:** `e2-25h-elaiza-senta-motande-tyst-vard.jsonl`,
  `e2-quick-varld5-brisen-u17.jsonl`.

## 3. Övervägda alternativ (alla mätta)

Hela tabellen står i docs/VALIDATION.md "Familj E2". Nytt i revisionen:

- **Mötande konvoj:**
  - granskningens "samma riktning eller bevisad passage": sju korpusar
    flyttade — för brett, och ARCHITECTURE K13b har mötande konvojer som
    designval ('mixed');
  - omprövning av `_belongsToEvent` vid varje fix: hjälper inte (ELAIZA och
    SENTA ligger inom 600 s från #33:s referens);
  - tyst motpart utan krav på egen deadline: 14h DESTINY fick ett kort med
    eta 0 åtta sekunder före korsningen, och AKIRA:s RECOVER-varning hamnade
    efter hennes korsning;
  - valt: tyst motpart, motsatt riktning, ingen bokförd passage, egen deadline
    framför armen. Det flyttar fem kort i banken (§6), inget av dem sämre
    mot O1.
- **F07:**
  - granskningens synlighetsregel för MÄTTA värden: AVALON blev rätt, men en
    icke-ledares baslinje flyttade sig aldrig och höll hennes värde uppe tills
    hon tog över texten (CATHARINA 19h 08:12:00, "om 7" mot 2,4, och "om 7"
    stod 08:05–08:10);
  - inaktuell baslinje släppt åt båda håll: NOCHT 41h "om 26" → "om 40" mot
    16,2;
  - valt: åldersgränsen 5 min (appens egen gräns för när Fix G börjar
    extrapolera) och bara mot en lägre färsk mätning. Mot den gamla E2:n
    ändras tre påståenden: AVALON (bättre), och SISU:s notis och QUEEN ELAN:s
    notis går tillbaka till e949ae1:s värden.
- **F06:** "strax hålls kvar under inbromsningen" i stället för hållning på 3:
  värld 192 kvar och 11 korpusar flyttade. Valt: kvot och marginal; värld 192
  och värld 286 är vakter i testerna.
- **Ökningstaket:** tre hållningar i följd (som GPS-grenen) och 5 min gav båda
  fyra sämre låsta påståenden och inga bättre (ANDREA 42h 18:40–18:52, rå 69–75
  min i 12 min medan den hållna nedräkningen träffade korsningen). 15 min rör
  inget påstående i banken och begränsar granskarens prov (`sakta.js`: 60 s
  kadens fryser 25,6 i 15 min och växer sedan; 30 s likaså, där även e949ae1
  frös).
- **FP9 (notistokenen):** inte rörd. Taket är notisflödets och tillhör inte
  ETA-etappen; PILOT 761 och ORCA redovisas i §9.

## 4. Samspel med andra familjer

- **K och K2 (BridgeOpeningService):** grinden i §2.3. Den läser bara
  arm-fält som finns på 7699cbe (`routeDirection`, `rawAnchorMs`, `fireDueMs`,
  `warnedAt`, `absorbedAt`) och händelsefält (`firedAt`, `firstPassageAt`).
  K:s korsningsankare sätter `firstPassageAt`, och då är grinden av. K:s
  bakkant, golv och håll läser `expectedArrivalMs`, så E2:s ETA-ändringar
  flyttar deras beslut; mätt med K:s och K2:s fil ovanpå E2 för 25h och värld
  5 (samma utfall före grinden).
- **E (avgångskontexten, revision pågår i K/E/wt):** orörd. E2:s nya kod i
  kalkylatorn är F06-villkoret och ökningstaket; inget av dem läser
  avgångsfälten.
- **N (notiser):** FP9 orört; notistokenen läser fixets enda värde.
- **R1, R2, M:** inga delade funktioner.
- **Delade funktioner:** `ProgressiveETACalculator._processETAWithProtection`,
  `_isETAOutlier`, `_getEffectiveSpeed`, `_applyGapResetIfNeeded`,
  `calculateProgressiveETA`; `app.js _reconcilePublishedETA`,
  `_reevaluateVesselStatuses` (Fix G och loopen), `_leadsEtaGroup`;
  `BridgeOpeningService._bindLooseArms`.

## 5. Hur användarbesluten följs

- **U20:** utjämningen och spärren är omgjorda i en egen familj ovanpå E.
  K6:s tre delar gick in tillsammans och vikten kalibrerades sist.
- **K6-acceptansen:** median, andel inom 2 min och bias i banden < 5 och
  < 10 min, parat och oparat, aldrig totalsumman (§6).
- **U13:** varje ändrad låst rad är bedömd mot gt-passages och O1/O2
  (FACIT.md). Sämre rader låses inte om på riktigt; DEMO-omlåsningen visar bara
  att allt annat är grönt. De som står kvar är en ägarfråga.
- **U17:** värld 5 är U17-klassen och ska registreras i motorn som DESIGN.
- **Huvudmålet ("en missad öppning är värre än ett falsklarm"):** grinden kan
  bara ge en båt en egen varning, aldrig ta en. replay:openings har täckningen
  391 → 392 av 447 och samma antal tunna ledtider (7).
- **U16:** strax-studsen (F40) är orörd.

## 6. Mätningar och motor

- **measure:eta, parat mot e949ae1** (alla siffror i VALIDATION "Familj E2"):
  - < 5 min, alla (n = 776): 0,46 → 0,45 · 89,6 → 90,5 % · +0,49 → +0,44;
  - < 10 min, alla (n = 1 274): 0,70 → 0,67 · 81,7 → 82,3 % · +0,15 → +0,11;
  - per typ lika eller bättre i median och andel; öppningskortens bias < 10 min
    +0,13 → −0,15;
  - oparat < 5 min n 8 → 11: 0,42 · 100 % → 0,46 · 81,8 % (sämre);
    < 10 min n 21 → 22: 0,66 · 76,2 % · +1,08 → 0,84 · 81,8 % · −0,37.
- **Mot 7699cbe, parat:** < 5 min 0,47 · 88,8 % · +0,51 → 0,45 · 90,5 % · +0,44;
  < 10 min 0,71 · 81,2 % · +0,17 → 0,67 · 82,3 % · +0,11.
- **Namngivna fall:** LINNEA:s Klaffbronsrader, 41h-svängningarna, SISU och
  IDUN är oförändrade mot e949ae1; AVALON "om 18" → "om 12"; SKONNERTEN 3 → 2
  mot 1,4; PRIMA LADY 3 → 4 mot 3,1.
- **replay:openings:** O1/O2/O3 gröna; 25h:s minsta ledtid 8,5 → 8,9 min (den
  tunna ledtiden 99 s är borta), tunna 7 → 7, täckning 391 → 392/447.
- **Motorn:** se svarets motorkontroll; repro: F06 och F07 BORTA, F04 BORTA
  redan på e949ae1, övriga 22 KVAR. Quick, per medlem mot e949ae1 (granskarens
  `hunt-quick-base`): ny är värld 5 (U17, §1.5); borta är världarna 192 (F06),
  246, 122 (båda klasserna), 77, 251, 28 och bankens F07; värld 82 går från
  ÖPPNING-MISS:OKLASSAD till LEDTID<60s (en missad öppning får en sen varning).

## 7. Regressionstest mot gammal kod

| Träd | e2-revision (20) | e2-eta-etapp (17) |
|---|---|---|
| e949ae1 | 16 röda, 4 gröna | 13 röda, 4 gröna |
| 7699cbe | 16 röda, 4 gröna | 12 röda, 5 gröna |
| första E2 (7a80260) | 16 röda, 4 gröna | 1 röd (det skärpta F07-testet), 16 gröna |
| revisionen | 20 gröna | 17 gröna |

De gröna på de gamla träden är vakter: världen 5:s täckning, F07:s dämpning
inom fem minuter och av ett hopp uppåt, och F06-vakten (verklig inbromsning
hålls på e2-träden; marginalfallet på e949ae1/7699cbe, som saknar regeln).

## 8. Dokument

- **I patchen:** `docs/ARCHITECTURE.md` §8 (e) "ETA-etappen gick in"
  (reviderad), `docs/VALIDATION.md` "Familj E2" (nya band, oparat korrekt
  redovisat, öppningar, facit, prövade varianter), DEMO-noter i
  `tests/replay-validation/corpora.js`, kodkommentarer.
- **Bör göras vid integrationen:** grinden i §2.3 dokumenteras även i K:s
  avsnitt om konvojfönstret; E:s stycke "Kvar till ETA-etappen" stryks när E
  och E2 slås ihop; U17 registreras i motorn (värld 5).

## 9. Ägarfrågan och kända gränser

**Ägarfråga: bandförbättring mot radförsämring (U13).** I bandet sanning
< 10 min blir 55 låsta rader rättare och 22 sämre (FACIT.md listar alla 22).
11 är öppningskort (etaMin en lägre, eller samma etaMin 22–50 s tidigare), 6
notiser och 5 brotextrader. Mekanismen: e949ae1:s notistoken och
öppningsmotor läste pass 1:s mer eftersläpande värde, nu läser de slutvärdet.
Att ta bort de sämre raderna kräver att den andra produkten återinförs — det
K6 ska ta bort. Ett nej lämnar F06 och F07 öppna (K6:s dubbla EMA är F06:s
rotorsak enligt U20).

Kvar, mätt:
- PRIMA LADY 24h 16:34:01 (familj E:s rad) "om 3" → "om 4" mot 3,1 min.
- MALUCA 25h 07:42:16 och JUNO 17h 15:55:31: "strax" → "om 3" mot 2,8 och 2,7
  min. De bromsade in vid bron (5,5 → 1,3 kn; 2,8 kn) och momentanfarten gav
  4,1 och 4,0 min; XENIA gav 4,4. Ingen marginal skiljer dem utan att anpassas
  efter tre punkter.
- PILOT 761 (13h, notis 2 → 5 mot 1,4) och ORCA (17h, 3 → 6 mot 2,2), utanför
  låst facit: FP9-knivseggen (§3).
- 20260917-7h: dirigentbeslut (FACIT.md).
- J10 (FRAM, 25h) är oförändrad.
- Värld 5: U17-klassen, registreras av dirigenten.
- Grinden i §2.3 gäller bara vid absorptionen. En motpart som är färsk när
  armen absorberas och sedan tystnar prövas inte om; K har en bakkant för det
  läget efter bokförd passage, inte före (K mätte en sådan och avvisade den).
- Memots läge (`_fixContext`) måste följa nya fält som påverkar ETA:n.
- Bekräftelseregeln för fall kan släppa en glimt som upprepas i två fix; inte
  sett i banken eller motorn.
