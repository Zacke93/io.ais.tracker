# GRANSKNING — familj E (MOTOR), varv 2

Granskad kod: `V/E/rwt` = 1dfd18a (c14938f..1dfd18a, 12 commits). Basen: `V/E/bwt` = c14938f.
Mina skript ligger i `V/E/rscripts`, mutantkopiorna i `V/E/rmut`, motorkörningarna i `V/E/rkör`
och övriga tempfiler i `V/E/rtmp`. V = S/varv2 och S = scratchpad.

Under större delen av granskningen låg lasten på 15–34 på 4 kärnor, eftersom granskarna av A, B,
D och F körde samtidigt. Mot slutet sjönk den till 3–8. Alla väggtider är därför övre gränser.

## Dom: ÄNDRINGAR KRÄVS

Skälet är anmärkning H1. Villkor (3′) är inte oberoende av appen:
- vilka fix som prövas väljs med appens egna flaggor i domspåret;
- fönsterslutet är appens eget, när domen bär det.

En regression som slår ut bakkanten via renhetsflaggan syns därför inte längre. U17 och K-NÄSTA
tar 18 av 23 nya utslag i quick, och bland dem finns fem missade öppningar (T2 OKLASSAD). Med
c14938f:s motor och samma appmutation blev 21 av 23 KANDIDAT. Det är alltså en regression i
motorns känslighet.

Den mutation som familjen själv körde, där bakkanten alltid dömer `covered`, fångas däremot: 21
av 21 blir KANDIDAT. Det som avgör är alltså hur felet syns i domspåret, inte vad appen gör.

Rättningen är liten och provad (se H1). Resten av leveransen håller:
- harnessen är additiv och bitlik;
- självtestet är grönt;
- determinismen håller;
- radiomodellen är deterministisk och rör bara båtar med en avgång;
- alla registerändringar står i §7:s lista med källa.

## Anmärkningar

### H1 (hög): (3′) döljer en bakkantsregression som c14938f:s motor visade

**Felet.** `tystRecoverSammaÖppning` prövar appens prognos och den oberoende fysiken bara vid
"rena bakkantsdomar" (`rentBakkantsfix`, registry.js). De väljs med appens egna tal i domspåret:
- `arm.lastFixClean`;
- `frozen`;
- `courseAway`;
- `arm.lastSeenAt` efter `event.firstPassageAt`;
- `firstPassageRegisteredAt` före korsningen.

Med domspåret hoppar (3a) dessutom över kvotregeln (`if (spår) continue;`). Rader efter att
passagen blev känd som inte hör till en ren dom prövas alltså inte alls med fysik. Utan domspår
prövade c14938f:s kvotregel varje sådan rad. Till det kommer att `domensFönsterslut` använder
domens `windowEndMs` (familj B:s fält, appens tal) när det finns.

Slår appen ut bakkanten genom att markera fixen som orena, till exempel med en trasig
färskhetsgräns för AISHub-fix, så blir villkoret tomt och posten godtar släppet vid
täckningsslutet. Detsamma gäller när appens fönsterslut blir för sent.

**Belägg.**
1. Fixturprov, `node V/E/rscripts/vakuum.js V/E/rwt`. Fallen w625, w1973 och w1337 ur
   `varv2-motor-2026-11-09.json` prövas med sista raden satt till 1 kn:
   - som i familjens vakt: KANDIDAT;
   - samma med `lastFixClean=false` i hennes domar: DESIGN U17 i alla tre.
2. `node V/E/rscripts/fonsterslut.js V/E/rwt`, w625 med sista raden i 2,0 kn:
   - utan `windowEndMs`: KANDIDAT;
   - med domens `windowEndMs` = täckningsslutet (09:28:26 i stället för det räknade 09:28:01):
     DESIGN U17.
3. Motorn, quick med `--lanes=synth --no-shrink`, jämförd med `V/E/rscripts/mutdiff.js`.
   Mutationen "aldrig rent fix" är `arm.lastFixClean = false` i `_refreshArm`:

   | Motor | App | Nya utslag | Varav KANDIDAT | Tagna av en post |
   |---|---|---|---|---|
   | 1dfd18a | c14938f + mutationen (`rmut/ren` mot `rmut/ref`) | 23 | 4 | 16 K-NÄSTA, 2 U17, 1 J13 |
   | c14938f | c14938f + mutationen (`rmut/basren` mot `rmut/basref`) | 23 | 21 | 1 U17, 1 J13 |
   | 1dfd18a | c14938f, bakkanten alltid `covered` (`rmut/bakkant`) | 21 | 21 | 0 |
   | 1dfd18a | B:s 5d4b2c3, fönsterslutet = täckningsslutet (`rmut/bfonster` mot `rmut/bref`) | 3 | 2 | 1 U17 (w260) |

   - De dolda är fem T2 ÖPPNING-MISS:OKLASSAD, alltså missade öppningar (w63, w110, w119, w122
     och w290), sex T2 LEDTID<60s och sju T3 VARNING-EFTER-SANN-PASSAGE. En av de sju (w235) tar
     U17 även i c14938f:s motor.
   - I den omuterade referensen har världarna inga utslag, till exempel w28 och w260.
   - Punkt 6, K-NÄSTA för T2 OKLASSAD, gör att de missade öppningarna kan tas alls.
4. Kontrollen ovan (bakkanten alltid `covered`) är familjens mutation. Den fångas eftersom appens
   flaggor då fortfarande pekar ut de rena domarna.

**Förslag.** Pröva premissen oberoende av appens flaggor:
- **(a)** Pröva fysiken ur varje egen rad som bearbetats efter att passagen blev känd (`bok`) och
  före W. Undantaget är rader med kursen bort, som redan prövas oberoende (`kursBort`).
- **(b)** Mät både prognosen och fysiken mot det tidigare av domens `windowEndMs` och motorns eget
  fönsterslut ur domens arm och händelse, alltså
  `min(coverUntilMs, max(firedAt, firstPassageAt) + CONVOY_WINDOW_MS)`.
- **(c)** Låt inte appens renhetsflagga ensam undanta en dom från prognosprovet. Världarnas fix
  är GPS-rena i sanningen (R0 och R1 har bara brus), och U17:s premiss gäller vad hennes position
  sa, inte hur appen bedömde fixet. Vill familjen behålla undantaget för äkta orena fix ska
  renheten prövas mot sanningen, alltså fixets avvikelse från L0-banan, och inte mot appens
  flagga.

Prototyperna ligger i `V/E/rmut`. Varje steg är några rader i `registry.js`:
- `fixprov`: steg (a) och (b) i radslingan;
- `fixprov2`: dessutom (c);
- `fixprov3`: dessutom (b) i `domensFönsterslut`.

Hela förslaget, alltså `fixprov3`, ligger som patch i `V/E/rtmp/förslag-H1.diff` (29 rader).
Med alla tre ger motorns 27 sviter 426/426 gröna, och fixturproven i belägg 1 och 2 blir
KANDIDAT. Utfallet i quick:

| Prototyp | Omuterad app | "Aldrig rent fix" | Fönsterslut = täckningsslut (B) |
|---|---|---|---|
| nuvarande motor | — | 4 av 23 KANDIDAT | 2 av 3 KANDIDAT |
| `fixprov` | 0 ändrade utfall | 18 av 23 | — |
| `fixprov2` | 0 ändrade utfall (c14938f och B) | 21 av 23, som c14938f:s motor | 2 av 3 (w260 är kvar som U17) |
| `fixprov3` | 0 ändrade utfall (c14938f och B) | 21 av 23, som c14938f:s motor | 3 av 3 |

I `fixprov3` är de två som inte blir KANDIDAT w235 (U17) och J13. Dem tar även c14938f:s motor.
Standardprofilen med förslaget är inte körd.

Lägg också till:
- jest-vakter för `lastFixClean=false` eller `frozen` med fysiken efter fönstret, och för en
  `windowEndMs` som ligger senare än det räknade fönsterslutet;
- mutationsproven "aldrig rent fix" och "fönsterslut = täckningsslut" i §7 och bilaga A.7,
  bredvid bakkanten och under-bron-hållet.

### L1 (låg): M9 i AISHub. "Aldrig senare" gäller den dragna tiden, inte den första hörda fixen

Belägg: `node V/E/rscripts/m9.js V/E/rwt 0 2000 ut.json`. Skriptet kör standardens 2 000
världar med ny och gammal radio (`taktbyte: false`).

**aisstream: håller.**
- 242 avgångar mitt i ett stillaintervall.
- 0 hörs senare, 181 tidigare och 61 samtidigt.
- Första fixen efter avgången, p50/p90/max: 76/300/685 s, förut 398/913/1 778 s.

**AISHub: den dragna tiden `due` blir aldrig senare, men den första hörda fixen kan bli det.**
- 251 avgångar: 190 hörs tidigare, 4 samtidigt och 57 senare.
- De 57 senare: median +27 s, p90 +71 s och max +272 s.
- p50/p90 sjunker ändå från 115/435 s till 62/109 s.
- Raderna som tas emot före avgången skiljer sig i 2 fall (w850 och w1830), eftersom det extra
  slumptalet dras vid stillapollen och flyttar åldrarna i pollerna fram till avgången. DESIGN §6
  och testtitlarna i `a-radio.test.js` säger att de raderna är bitlika.

**Värld 1527 är ett sådant fall** (`node V/E/rscripts/w1527.js V/E/rwt 1527 265013012`). DAGNY är
klass B och hörs via AISHub.
- Gammal radio: hon hörs första gången efter avgången 09:27:30 med fixen 09:28:32 (2,6 kn), alltså
  62 s efter avgången.
- M9: hon hörs först med fixen 09:33:04, 334 s efter avgången. Pollen efter avgången levererar ett
  stillafix från 09:27:23, och nästa rörelseintervall dras till 341 s. Det ligger kring p98 i
  klass B:s transitkadens för AISHub (p95 120 s, p99 420 s).
- Mekanismen är triage B:s M4 (tyst köare vid en tidigare bro): reservvarningen 09:32:23 kom 300 s
  efter sista fixet och 50 s efter korsningen 09:31:33. Det är inte D:s M6.
- `hunt.js --repro` på F06:s r2 (`V/E/std-efter/fynd/F06-…/r2`) ger KVAR både på 1dfd18a och på
  provintegrationen.

Förslag:
- Skriv i RESULTAT, DESIGN §6, BUGGJAKT §4.5 och §7 (Följder) att AISHub kan höra en enskild
  avgång senare, med siffrorna ovan.
- Ändra testtitlarna för AISHub.
- Hänför 1527 till triage B:s M4 (MÄTGRÄNS-klass) i stället för till D:s område.

### L2 (låg): U24-grindarna syns bara i räknarna, och två T2-utslag tas av O1

Belägg:
- **U24:s sju policygrindar bortkopplade** (en-prognos, inom-fönstret, kö, deadline,
  täckningsslut-i-tid, golv och kurs) på B:s 5d4b2c3, `rmut/bu24` mot `rmut/bref`:
  - 2 nya T2 LEDTID<60s, och båda tas av O1 som ACCEPTERAD: w181 (FÖRST_SEDD_FÖR_NÄRA) och w282
    (RIKTNINGSBEVIS_FÖR_SENT). I w181 var båten absorberad i Stridsbergsbron#4 10:03:17 och täckt.
    U24-släppet 10:03:30 gav henne en egen varning 49 s före korsningen 10:04:19.
  - I övrigt syns grindarna bara i räknarna: T4 >1 går 97 → 124 (R0) och 228 → 278 (R1), och
    T3-varningarna ökar med 46 respektive 72.
  - U24-DELAD-KÖ tar inget nytt.
- **KRAV (1) bortkopplat** (`rmut/bkrav1`): 0 ändringar i quick, eftersom ett fix utan riktning
  bortom bron inte förekommer i världarna. Kodläsning: ett sådant släpp är en dom `bakkant`, och
  då svarar U17, K-NÄSTA och U24-posten nej.

Förslag:
- O1:s T2-gren bör inte godta en kort ledtid när båten var täckt av en varning i tid och släpptes
  av en dom `bakkant` (också U24) före korsningen. Det motsvarar T3-undantaget för RECOVER-släppet
  (rad 32), och domspåret gör det prövbart.
- Skriv i A.7 att motorn bara ser U24-grindarna och KRAV (1) genom jest.

### L3 (låg): harnessens wrapper är inte undantagssäker, och `waitingAtBridge` bokförs inte

`instrumentCoverageVerdicts` kör följande i appens anropsväg (`_releaseStrandedArms` →
`_coverageVerdict`): `kopia(verdict)`, `JSON.stringify(post)`, `_courseAway` och
`_hasUnappliedObservation`.
- Ett undantag där avbryter appens släppslinga. Ett exempel är ett cykliskt objekt i ett framtida
  domfält, eftersom `kopia` saknar cykelskydd.
- `calculateBearing` kastar vid icke-finita koordinater. I dag skyddas anropet i `_courseAway`.

Förslag:
- Räkna domen först, lägg bokföringen i try/catch (skriv en felpost vid fel) och returnera alltid
  domen.
- Bokför `arm.waitingAtBridge` additivt. Det är familjens öppna fråga 4, och U24-postens grind
  `kö` kan då pröva flaggan.

### L4 (låg): dokumentationen

- **§7, listans inledning** (BUGGJAKT.md:362) nämner rad 40 och 42, men inte rad 45 (U24-posten
  speglar ett ägarbeslut) och rad 46.
- **Fysikens marginal:** DESIGN §4 säger 27–154 s, men BUGGJAKT rad 41 och testkommentaren i
  `k-varv2-motor.test.js` säger 27–136 s.
- **Realismen:** §4.2 och A.7 anger bara glappet i rörelse. M9 flyttade andra mått mer:
  - korsningsglappet för aisstream, p90 848 → 735 s;
  - sista fix före korsningen för aisstream, p90 1 097 → 1 053 s;
  - samma mått för AISHub, p90 210 → 191 s.

  Siffrorna är reproducerade exakt med `realism.js` på båda träden.
- **§14:** säger att kriterierna håller, fast kravet på 5 s för jest inte håller (L5). Standard tog
  18 min i min andra körning, alltså inom 25 min.
- **§14 och A.7, konvojfönstrets bakkant:** A.7 säger att den står kvar i F02. Men kriteriet är
  "gräns vid CONVOY_WINDOW_MS", och F02:s gräns är kötiden vid `queueGraceMs (Kajen) = 900 s`, så
  redan på c14938f. Det enda kortet med CONVOY_WINDOW_MS som närmaste konstant var i `std-fore` F06
  (1973, B − A 504–522 s). Det blir U17 genom M1, vilket är rätt enligt triage B. I `std1` har inget
  kort CONVOY_WINDOW_MS (`grep -c 'Närmaste konstant: CONVOY_WINDOW_MS'` ger 0 mot 1). Skriv det, och
  låt ägaren avgöra om kriteriet ska formuleras om.
- **RESULTAT och DESIGN §6:** se L1.

### L5 (låg): tidskravet på 5 s för motorns jest-sviter

Mätt vid den lugnaste stunden (se punkt 8 nedan):

| Körsätt | Last | 1dfd18a | c14938f |
|---|---|---|---|
| `--detectOpenHandles` (sviterna i följd) | 4 | 10,6–11,6 s | 8,5–8,9 s |
| parallellt | 3–4 | 5,9–7,7 s | 5,4–7,2 s |

Kravet kan inte beläggas. I följd hölls det inte ens på basen, och parallellt är marginalen borta.
E lägger till 0,5–2 s, mest i `a-radio.test.js`.

Förslag:
- Färre radioseeds i M9:s jämförelse, till exempel 10 i stället för 25. Mätningen över 2 000
  världar finns i stället i A.7.
- Redovisa i §14 att kravet inte håller med `--detectOpenHandles`.

### Känt sedan tidigare, inte infört här: U2-VS-DEADLINE (familjens öppna fråga 3)

Posten tog 8 utslag i familjens bakkantsmutation på standard, men 0 i min quick. Bindningen till
släppvägen är ett ägarbeslut. Jag instämmer i att frågan ska stå kvar.

## Vad som håller (belägg)

**1. Harnessen är additiv (punkt 3).**
- `node V/E/rscripts/bitlogg.js V/E/bwt V/E/rwt …` jämför resultat-JSON och hela app-loggen
  (`REPLAY_VERBOSE=1`) i 26 av 26 korpusar. Allt är lika mot c14938f utom
  `openingCoverageVerdicts` (204 domar).
  - Med `REPLAY_MONITORING=1`: 26 av 26.
  - Utan monitoring gav en körning en avhuggen stderr i 20260702-174109, med lika JSON. Vid
    omkörning var stderr byte-lik.
- `runOpeningGates`, `runSyntheticScenarios` och `runAllCorpora`, med och utan monitoring, ger
  byte-lik stdout (`V/E/rtmp/og`).
- `_coverageVerdict` anropas lika många gånger, med samma argument och samma returvärden
  (`V/E/rscripts/räkna.cjs`, med samma hash): 395, 133, 147 och 154 anrop i 17h, both-21h, 0707
  och 0713.
- Hjälparna som wrappern anropar är rena läsare i c14938f, i B:s 5d4b2c3 och i
  provintegrationen. Signaturen `(arm, event, now)` är oförändrad överallt.

**2. Självtestet och determinismen (punkt 5).**
- Självtestet är GRÖNT på 142,7 s:
  - determinism 24/24, SHIFT30 24/24, MMSI 24/24;
  - kanarier 5/5, rundresa 45/45;
  - låst bank: 0 nya träffar.
- Självtestets rapport.json är lika med familjens `batt7` utom tid, HEAD och fingeravtryck.
- Sanningsspåret i quick (`rkör/q-ref`) ger raderna 23f5b8fd31a0 och fynden 3fe700ad4f07, samma
  som familjens.
- Standard (`rkör/std1`, 51 min vid last 18–30) ger:
  - 261 utslag, 44 kluster och 9 kort;
  - sanningsspåret: raderna f8ac8893d61b och fynden 1752927f48fa.

  rapport.json är lika med familjens `std-efter` utom fingeravtryck, git, HEAD och körnings-id.
- Andra standardkörningen (`rkör/std2`) ger samma fingeravtryck, f2ac05d1ad1c.
  - rapport.json är lika med `std1` utom tidsblocket, efter normalisering av utkatalogen.
  - Alla 123 filer i `fynd/` är lika efter samma normalisering.
- §14 i övrigt:
  - självtestet och determinismen håller;
  - `eslint --max-warnings=0` på `bugHunt/` och `replayRunner.js` ger exit 0;
  - porcelain i `rwt` visar bara node_modules;
  - kortet F02 står kvar, men gränsen ligger inte vid CONVOY_WINDOW_MS (se L4);
  - bankkortet F04 står kvar;
  - 9 kort, alla med repro.

**3. M9 (punkt 4).**
- R0 är bitlik i 2 000 av 2 000 världar.
- Ny radio körd två gånger ger 0 avvikelser.
- R1: 465 världar och 539 båtar ändras, alla med en avgång. Ingen båt utan avgång ändras.
- Realismtabellen reproduceras exakt, före och efter.

**4. Mutationsprov (punkt 1).** Quick, sanningsspåret.

| Mutation | App | Nya utslag | Utfall |
|---|---|---|---|
| bakkanten alltid `covered` | c14938f | 21 | 21 KANDIDAT |
| under-bron-hållet bortkopplat | c14938f | 1 | KANDIDAT |
| Kajens köundantag 0 | c14938f och provintegrationen | 0 i quick | se nedan |
| KRAV (1) bortkopplat | B 5d4b2c3 | 0 | — |
| U24:s policygrindar bortkopplade | B 5d4b2c3 | 2 | 2 ACCEPTERAD O1 (L2) |
| aldrig rent fix | c14938f | 23 | 4 KANDIDAT (H1) |
| fönsterslut = täckningsslut | B 5d4b2c3 | 3 | 2 KANDIDAT, 1 U17 (H1) |

Kajens köundantag prövades också i scenariot kajK (17 min kö vid Kajen mot Klaffbron) med
`hunt.js --repro`. Med köundantaget satt till 0 blir felet KANDIDAT (T2 LEDTID<60s) både på c14938f
och i integrationen, och U23-posten tar ingenting. Omuterat ger c14938f KANDIDAT (DEFAULT-FLASH och
T2), medan integrationen med F:s U23 ger 0 utslag.

**5. Registret (punkt 2).**
- 41 poster. Alla ändrade poster står i §7:s lista, rad 37–49, med källa:
  - U16, U1-C11, R2, S10, U18 och U19 har bara nya källhänvisningar (rad 47 och 49);
  - D1-KAJZON-DEMOTION ersätts av U23-posten;
  - U24-posten är ny.
- U23 och U24 vilar på ägarbesluten.
- Övriga ändringar:
  - rättar motorfel (M2, M3, B01 och 1837);
  - ersätter en mätgräns (kvotregeln, M1);
  - följer familjerna B och F (rad 43 och 44);
  - utvidgar en KÄND_ÖPPEN post till T2:s vy av samma händelse (punkt 6, rad 42).

  Punkt 6 är en registerändring som ägaren bör se särskilt, eftersom den låter en KÄND_ÖPPEN post
  ta missade öppningar (se H1).
- Registret laddar utan varningar i 1dfd18a, i B:s träd och i provintegrationen.
- U23-posten tar bara kapslar utanför väntzonen. Kajen mot Klaffbron (161 m) är KANDIDAT i kajK.
  Enligt koden gäller detsamma i F:s norra spets (300–320 m), eftersom predikatet mäter kapselns
  närmaste punkt.

**6. Regressionstesten.** De nya och ändrade testfilerna fäller c14938f:s motor: 58 av 169 test
i de fyra sviterna (`V/E/rmut/bastest`). På 1dfd18a är 426/426 gröna, och testerna prövar
predikaten på verkliga fixturer.

**7. hunt:repro.** Familjens 26 kort ger samma resultat som familjen redovisar: 20 BORTA och 6
KVAR (std-F02, std-F05, std-F08, 790, 977 och 1794). Sju kort återskapas med M9:s radio
("AVVIKER mot den sparade radhashen"): 290, 790, 510 ×2, 625 ×2 och 941. För dem gäller BORTA en
annan realisering, men M2 för 941 prövas på originalraderna i jest.

**8. Tider (punkt 6).** Motorns jest-sviter, körda växelvis mot c14938f med
`npx jest --detectOpenHandles --testPathPatterns=bugHunt`. Flaggan `--detectOpenHandles` kör sviterna
i följd.

| Träd | Last 4 (lugnaste stunden, `jesttid2.txt`) | Last 17–19 (`jesttid.txt`) |
|---|---|---|
| 1dfd18a, 27 sviter och 426 test | 10,6–11,6 s, user 12,4–12,5 s | 15,9–24,3 s, user 12,0–12,6 s |
| c14938f, 26 sviter och 366 test | 8,5–8,9 s, user 10,7–11,0 s | 14,8–29,6 s, user 10,7–14,7 s |

- Kravet på 5 s uppfylls inte av något av träden vid last 4. E lägger till cirka 2 s väggtid och
  13 % CPU.
- Mest ökar `a-radio.test.js` (M9:s 25-seedsjämförelse): 0,8 s vid last 4 och 3,1 s mot 0,9 s vid
  last 26. `k-varv2-motor.test.js` tar 0,24 s.
- Inga öppna handtag.
- Standard tog 51 min vid last 18–30 (`std1`) och 18 min när lasten sjönk från 29 till 8 (`std2`).
  Det ligger inom 25 min.

**9. Samspelet och provintegrationen (punkt 7).** `rmut/iref` är provintegrationen med E:s
`bugHunt/` och `replayRunner.js`. Quick:
- Självtestet är GRÖNT.
- Korten F01–F03 är basens ETA-kort (U22).
- Basens F04 (290) är borta.
- 138 blir U1-C11.
- Ett nytt kort, F04 INV-10 STRAX-ZOMBIE (w129: SALTIS 2 köar 60 min vid Kajen med F:s U23), har
  sin grund i F:s senare harnessändring cf43811. Den ingår inte i provintegrationen men patchar
  rent ovanpå E:s `replayRunner.js` (offset 75 rader), och med den ger kortet BORTA.
- w235 blir ett nytt U17-utslag i integrationen. Det är legitimt: #5:s passage var okänd under
  hela hennes täckning, prognosen 07:24:41 låg inom fönstret, och hon korsade 07:24:41.

Familjens öppna frågor:
1. **1038:** syns som KANDIDAT efter B, inget döljs. Ett beslut behövs.
2. **1527:** se L1. Det är M4-klassen, inte D:s område.
3. **U2-VS-DEADLINE:** som ovan.
4. **`waitingAtBridge`:** se L3.
