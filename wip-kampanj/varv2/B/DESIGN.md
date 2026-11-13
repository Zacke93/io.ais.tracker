# DESIGN — familj B (BAKKANT), varv 2 (2026-11-09)

Worktree `S/varv2/B/wt`, bas c14938f. Alla tider är UTC. BOS = `lib/services/BridgeOpeningService.js`.
Radnummer gäller c14938f om inget annat sägs.

| Steg | Mekanism | Utfall | Commit |
|---|---|---|---|
| 1 | M4 bakkantens färskhet | 1094 och 1476 BORTA, banken bitlik | 650a0c7 |
| 2 | M5 krypfartens prognos | 790, 1794 och F08 BORTA, en olåst varning flyttar | 594a146 |
| 3 | M7 täckningsslut utan passage (U24) | 979 och F02-rep BORTA, 1139 KVAR, värld 143 ny kandidat (godtagen kostnad) | 0b0a35d |
| rev 1 | granskningen: KRAV (1), appens prognos i U24, kölämnaren i M5 | proberna A1, A1b, A4, A4c, C4, C4b, C4c som c14938f; PILLE-raden försvinner | 5d4b2c3 |
| rev 2 | omgranskningen: krypräknaren räknar nya fix; krypfix efter marschfart godtas | D4 som c14938f; D2, D3, D3b åter tidiga; PILLE-raden tillbaka | e5f78b5 |

**Antal varningar i banken:** replay:all:s 24 korpusar har 431 öppningsvarningar. runOpeningGates och
familjens dump räknar 437, eftersom de också tar med nattens fusionskörning (6). Där "437" står nedan
avses den räkningen.

## Revision 2 efter omgranskningen (e5f78b5)

Omgranskningen (`OMGRANSKNING.md`) godkände revision 1 och hade tre låga anmärkningar. Två rättas här;
registerposten för A3e går till familj E via dirigenten.
- **Nya fix, inte observationer** (anm. 3, prob D4). `crawlFixes` ökas bara när fixets tid
  (`rawAnchorMs`) har gått framåt. En upprepad leverans av kölämnarens första rörelsefix gav förut
  två krypfix och en extra varning; aisstream-multiplexern filtrerar inte dubbletter.
- **Krypfix efter marschfart** (anm. 2, granskarens `rtmp/forslag-krypfix-alt.diff`). Ett första
  krypfix godtas när förra nya fixet låg i minst 2,5 kn (`crawlFromCruise`, `prevFixSog`). En
  kölämnare kommer från stillhet och omfattas inte.
- **Två familjetest ändras:**
  - 790-testet släpper nu på första krypfixet efter marschfart, som i steg 2;
  - kölämnartestet ligger still före sitt första krypfix, eftersom testets marschfix vid T0
    annars hade gjort det godtaget.
- **Nya test:** D4 (dubblett med samma fixtid) och D3 (gles kadens). På 5d4b2c3 fälls 4 av 26 test:
  de ändrade och de nya.
- **Mätt:**
  - Probfilen före och efter (`prober/fore-5d4b2c3.json`, `prober/efter-rev2.json`):
    - D4 ger 1 varning (5d4b2c3: 2), som c14938f;
    - D2, D3 och D3b varnar 600, 700 och 700 s (5d4b2c3: 750, 840 och 730 s);
    - C4, C4b och C4c ger 1 varning, som c14938f;
    - C1 och C3b varnar tidigare (500 och 450 s) med samma antal;
    - övriga är lika med 5d4b2c3.

    Revision 2 lägger inte till någon varning mot c14938f utöver M4:s kända B1.
  - 790, 1794, F08 och 1476 förblir BORTA. 790 varnas 13:31:18: armen skapades vid krypfixet
    13:28:18 och har inget föregående marschfix. F08 varnas åter 10:11:45.
  - Banken mot c14938f: JOSEPHINE (U24) och PILLE (M5; hennes krypfix kom direkt efter 5,7 kn), båda
    olåsta (FACIT.md). U9-korpusarna är identiska, och JOY och SEEBAER III har kvar #9 08:25:16,678.
  - Mutationsprov: 22 av 22 fälls (`scripts/mutera-rev2.py`). 65 öppningssviter och 1049 test gröna.
  - Batteriet `batt-rev2`: se RESULTAT.md.

## Revision efter granskningen (5d4b2c3)

Granskningen (`GRANSKNING.md`, ÄNDRINGAR KRÄVS) gav tre medelpunkter och två låga. Probfilen
(`rtmp/probes/zz-granskning-b.test.js`) kördes före och efter (`prober/fore-0b0a35d.json`,
`prober/efter-rev1.json`). Antal varningar per prob:

| Prob | c14938f | 0b0a35d | 5d4b2c3 | Punkt |
|---|---|---|---|---|
| A1, A1b (fix bortom bron utan riktning) | 1, 1 | 2, 2 | 1, 1 | 1 |
| A4, A4c (fartfladder, ingen app-ETA) | 1, 1 | 2, 2 | 1, 1 | 2 |
| C4, C4b, C4c (kölämnare) | 1, 1, 1 | 2, 2, 2 | 1, 1, 1 | 3 |
| A3, A3b (köande konvoj, ingen app-ETA) | 3, 2 | 2, 3 | 3, 2 | 2 |
| A3e (= A3b med appens ETA, `prober/zz-granskning-b-A3e.test.js`) | 2 | – | 3 | 5 |
| B1 (M4:s kostnad, observation) | 1 | 2 | 2 | 4 |
| Övriga 10 | lika | lika | lika | – |

Punkterna:
1. **KRAV (1) i U24 och i bakkanten.** `_bridgeBehindArm` har samma uttryck som passagedomen och
   används av passagedomen, av grinden 'bakom' först i `_ownDeadlineGate` och av bakkanten efter
   passagen (domen 'covered' med `gate: 'bakom'`). Passagedomen vid täckningsslutet avväpnar som
   förut.
2. **'en-prognos'.** U24 kräver `etaMinutes`. Utan appens ETA är prognosen samma fysik. Fixturerna i
   M7-testen bär nu appens ETA.
3. **M5 och kölämnaren.** `_crawlArrivalMs` läser ingen fysik med köflaggan, och fysiken gäller först
   från det andra krypfixet i följd (`arm.crawlFixes`, nollas av varje annat fix). Kravet på två fix
   gick att göra rent:
   - 790, 1794, F08 och 1476 förblir BORTA;
   - 790 släpps 13:31:18 i stället för 13:28:30, 411 s före korsningen;
   - PILLE-raden i 20260804-17h försvinner, eftersom hennes släpp låg på ett första krypfix efter
     5,7 kn. Banken mot c14938f har då bara JOSEPHINE-raden kvar.
4. **Dokumentation.** "När underlaget finns" i stället för "alltid"; 431/437; 979 varnas 08:51:55
   och 330 s före korsningen (inte 08:52:08 och 317 s, som jag felskattade förut); M4:s kostnad B1 i
   docblocket.
5. **Registerposten** täcker nu även en hörd köande båt (A3e), se §Registerpost.

**Mätt:**
- Testfilen har 24 test. På 0b0a35d fälls exakt de 6 nya, på c14938f 14; ingen vakt fälls.
- Mutationsprov: 19 av 19 fälls (`scripts/mutera-rev1.py`).
- 65 öppningssviter, 1047 test, gröna.
- Banken mot c14938f (båda lägena) skiljer bara i JOSEPHINE-raden.
- U9-korpusarna är identiska med c14938f (JOY+SEEBAER III har kvar ett kort, #9 08:25:16,678).
- Batteriet `batt-rev1`: se §Mätt på revisionen nedan.

### Mätt på revisionen (5d4b2c3, `batt-rev1`)
- **Batteriet:** alla 13 steg slutkod 0, och porcelain visar bara node_modules. Jest: 370 sviter,
  5288 test gröna, 2 överhoppade.
- **Jämfört med c14938f:**
  - replay:all och synthetic är identiska;
  - openings skiljer bara i JOSEPHINE:s O2-rader;
  - fassvepet är grönt med och utan monitoring.
- **Quick mot `bas/quick`:** 58 → 57 utslag och 25 → 26 kluster, identiskt med steg 3.
  - −värld 240 och −värld 41.
  - +värld 143, den godtagna kostnaden (`batt-rev1/hunt-quick/fynd/F05-...`).
- **hunt --repro:**
  - BORTA: 1094, 1476, 790, 1794, F08, 979, F02-rep och 41.
  - KVAR: 1139 (stilla i kö) och 143 (godtagen kostnad).

## M4 — bakkantens färskhet mot korsningen

**Rotorsak, bekräftad.** `_coverageVerdict` krävde `arm.lastSeenAt > event.firstPassageRegisteredAt`
(BOS:2303), alltså ett fix efter BOKFÖRINGEN av ledarens passage. KRAV (2)
(ARCHITECTURE.md §H29/H30) kräver ett fix efter KORSNINGEN.
- Värld 1094 (R1 AISHub, minsta repro = helvärlden, 218 rader): QUEST absorberas 11:37:13 i ALVAs
  Stridsbergsbron#1. ALVA är tyst över bron, och passagen bokförs 11:41:39 med korsningen skattad
  till 11:38:47,979. QUESTs sista fix tas 11:39:14 och tas emot 11:39:27, 1810 m bort i 5,9 kn.
  Det ligger efter korsningen men före bokföringen. Prognosen är 11:49:15,7 och fönstret slutar
  11:48:48. c14938f höll henne till täckningsslutet 11:49:17 (RECOVER, `T2 ÖPPNING-MISS`), och hon
  korsade 11:48:44.
- Värld 1476 (R1 aisstream): RUNAs sista fix är 11:53:33,7. PELLEs korsning skattas till
  11:53:08,2 och bokförs 11:54:00. Prognosen 12:03:36 ligger efter fönsterslutet 12:03:08.

**Rättning** (650a0c7): `if (!(arm.lastSeenAt > event.firstPassageAt)) return { kind: 'covered' }`.
Docblocken i `_coverageVerdict` och `_openEvent` och ARCHITECTURE.md (KRAV (4)-stycket) är uppdaterade.

**Är firstPassageAt korsningsskattningen i alla vägar?** Ja.
- Enda skrivaren är `_recordPassage`, som sätter `crossedAt = crossedAtMs` om den är finit och
  ≤ now, annars `now`. Anroparna är:
  - `observeVessel` (glappvägen från K-familjen, F01): `_crossingEstimate`, alltså
    interpolation mellan armens sista tillämpade fix före bron och fixet bortom den, med
    väntregeln från revision 3, och annars `_crossingUpperBound`;
  - `notePassage`: `_crossingUpperBound`, fixets tid när armens senaste läge redan låg bortom bron;
  - passagedomen i `_releaseStrandedArms`: `_crossingUpperBound`.
- **Saknas skattningen** (fryst arm, okänd riktning, inget fix på var sin sida, eller
  notePassage med läget före bron) blir `firstPassageAt = now = firstPassageRegisteredAt`.
  Villkoret är då exakt det gamla. Testet "vakt: utan skattning" låser det.

**Klockdomänen (övervägt alternativ).** `lastSeenAt` är bearbetningstid, medan `firstPassageAt`
ligger i fixdomänen. För ett AISHub-fix som tas före korsningen men tas emot efter den blir
skissen något mildare än KRAV (2) bokstavligen. Hybriden "fixtid > korsning ELLER lastSeenAt >
bokföring" prövades som tanke och mättes med en spion i banken (`scripts/farskhet.js`):
- 22 bedömningar efter passage;
- 3 är färska bara med den nya regeln;
- 0 av dem har fixtiden före korsningen, och 0 släpp sker via den nya regeln.

I 1094 och 1476 ligger fixtiden efter korsningen i båda domänerna. Skissen behölls: den är
enklare, och det finns inget fall som skiljer dem åt.

**Mätt:**
- hunt --repro: 1094 BORTA (kvar finns bara KÄND_ÖPPEN U2-VS-DEADLINE vid Klaffbron 11:57:13, som
  även fanns på c14938f). QUEST varnas själv 11:42:05, 399 s före korsningen.
- 1476 BORTA: hon absorberas i DAGNYs Klaffbron#4 och blir KÄND_ÖPPEN J13-J14-KONVOJSEMANTIK.
- replay:all, synthetic och openings är bitlika (437 varningar, med och utan monitoring).
- Batteriet på steg 1 (`batt-steg1`) gav slutkod 0 i alla steg. Quick mot `bas/quick`: värld 240
  (KÄND_ÖPPEN U2-VS-DEADLINE) försvinner, och inget nytt tillkommer.

## M5 — krypfartens prognos i bakkanten

**Rotorsak, bekräftad.** Bakkanten jämförde `expectedArrivalMs` (appens ETA, BOS:1296) med
fönstrets slut. Efter en passage räknar ETA-kedjan med minst `MIN_PASSAGE_ROUTE_SPEED_KNOTS` = 2,5 kn
(ProgressiveETACalculator.js:787–790) och har dessutom outlierskydd.
- 790: FREJA 2 ligger 230 m från bron i 0,9 kn. Appen säger 3 min, fysiken 6,4 min.
- 1794: CORDELIA 2 ligger 258 m från bron i 1,3 kn. Appen säger 3,5 min, fysiken 6,4 min.

**Rättning** (594a146):
- `_refreshArm` sparar `arm.physicsArrivalMs = ankare + avstånd/sog` när sog >
  `MINIMUM_VIABLE_SPEED`, annars `null`. Ankaret är detsamma som för deadlinen.
- `_crawlArrivalMs(arm)` ger `max(expected, physics)` när sog < `MIN_PASSAGE_ROUTE_SPEED_KNOTS`
  (konstanten importeras, ingen ny konstant), annars `expected`.
- Bakkanten jämför det värdet. Deadlinen, `fireDueMs`, eta-tokenen och ETA-texten läser inte
  fysiken (U22). Det låses i testet.

**Övervägt:**
- (a) Den breda varianten utan fartgräns ger samma bankutfall, men fäller 7 test med
  inkonsistenta fixturer (sog 3, eta 1,5 min vid 300 m). Den visar sig inte rättare, så den
  smala valdes.
- (b) Fysik också i medlemskapet (`_belongsToEvent`) valdes bort. Bakkanten prövar varje färskt
  fix efter passagen, så en krypare som absorberats släpps inom en tick (790: absorberad
  13:28:18, släppt 13:28:30). Före passagen hade fysik i medlemskapet ändrat konvojbildningen
  kring väntande ledare, och det är U9:s riskzon.

**Mätt:**
- 790 BORTA: egen varning 13:28:30, 579 s före korsningen 13:38:09. Efter revisionen släpps hon på
  det andra krypfixet, 13:31:18, 411 s före korsningen.
- 1794 och F08 BORTA: CORDELIA 2 täcks av JOLLYs Klaffbron#5.
- replay:all och synthetic är bitlika.
- openings: en olåst varning flyttar (se FACIT.md); revisionen tar bort flytten. Det syns i 20260804-17h som fix 4→5,
  deadline 36→35, och i två härledda medianer. O1 376/378, 0-räknaren 10, >1-räknaren 48 och
  437 varningar är oförändrade.
- Slutbatteriet för steg 1 och 2 (`batt`, ad87498): 13/13 steg slutkod 0, porcelain bara
  node_modules, jest 370 sviter och 5273 test. Quick mot `bas/quick`: 58 → 57 utslag (bara
  värld 240 försvinner), inga nya kandidater. M5 ändrar alltså inget i quick.

## M7 — täckningsslut utan passage (ägarbeslut U24, steg 3, 0b0a35d)

**Rotorsak, bekräftad med spion** (`scripts/spionB.js`, `logs/spion-979-bas.jsonl`):
- I 979 absorberas XENIA 08:43:32 i FREJAs Stridsbergsbron#1. Händelsen avfyrades 08:41:32 med
  referens 08:46:34,9, så fönstret och täckningen slutar 08:56:34,9.
- FREJA köar i 37 min, och #1 får ingen passage. Bakkanten gäller bara efter passage
  (BOS:2301–2303).
- XENIAs egen deadline förfaller 08:52:07,8. Hennes prognos ligger efter 08:56:35 från 08:45:02.
- Hon släpps först vid täckningsslutet 08:56:34,937 och varnas direkt, 50 s före korsningen
  08:57:25.

1139 är en annan sorts fall. MASEN ligger STILLA i kö 157 m från bron (sog 0) när #5:s fönster
löper ut. #5 avfyrades på YRSA 2:s 15 min gamla fix, och YRSA 2 korsade osedd. MASENs avgång
12:34:16 hördes inte.

**Byggt och mätt.** Den smala varianten släpper med domen 'bakkant' före passagen. Steg för steg:

| Variant | Villkor | 979 | 1139 | Bank (437) | Låst facit | Quick |
|---|---|---|---|---|---|---|
| V1 | egen deadline passerad, båda prognoserna efter fönstret, i rörelse, ingen köflagga, ledtidsgolv, kurs | BORTA | KVAR | **440**: LYS+HERA II (20260707-14h) och en konvoj med 4 båtar (20260804-17h) splittras | LAURIERBORG flyttar | – |
| V1b | V1 + inte i väntzonen (≤ 350 m) | BORTA | KVAR | 437 | **rött**: 20260804-both-21h LAURIERBORG 07:36:41 → 07:33:39 och en undertryckning | – |
| V1c = patch | V1b + bara när täckningsslutet kommer < 180 s före hennes ankomst | BORTA | KVAR | 437, bara JOSEPHINE (olåst fantom) 10:06:05 → 10:01:20 | grönt | **+1 kandidat** (värld 143), −1 U17-utslag (värld 41) |

- **LAURIERBORG** (rådata): hon korsade 07:42:31 (gt, inte inferrerad). ANYA ELAN 380, vars
  händelse hon var absorberad i, korsade först 08:26:30. LAURIERBORG var alltså en egen öppning,
  och båda varningarna låg 5,8 respektive 8,9 min före korsningen. Rådatan visar inte att den
  nya är rättare (U13), därför villkoret i V1c.
- **Värld 143** (R1, F-SENFÖDD): V1c släpper RUNA 11:14:52 på hennes deadline. Prognosen ligger
  11–57 s efter fönstret, medan ledaren ALVA och CORDELIA köar vid bron. CORDELIA släpps senare
  vid #1:s täckningsslut. Hon absorberas då i RUNAs händelse i stället för att bilda en gemensam
  med henne (som på c14938f, Stridsbergsbron#5 11:25:13 med [RUNA, CORDELIA]). Vid dess
  täckningsslut 11:36:10 varnas hon på ett 21 min gammalt fix (`T3 VARNING-PÅ-FRUSET-FIX`).
  Hon korsar 11:46:32, 353 s efter RUNA, alltså i samma öppning.
  - c14938f, steg 1 och steg 2 ger BORTA för helvärlden (`cards/Q-w143-Strid`).
  - Det krympta reprot (`fynd/Q143`) ger KVAR på alla versioner och kan inte användas.
- **Värld 41** (R1): HAVSORN varnas med steg 3 kl. 12:16:52, 7,4 min före korsningen, i stället
  för 12:24:20, 2 s efter den (DESIGN U17-TYST-BÅT-RECOVER på steg 1 och 2). Ett utslag mindre.
- **Splittringsfallen från U9 är oförändrade i V1c och V1b** (antal varningar och kort med flera
  båtar): 20260713-41h 52/2 (JOY och SEEBAER III har kvar ett kort 08:25:16), 20260601-41h 28/0,
  20260610-19h 18/0, 20260707-14h 25/2 och 20260712-25h 32/3. V1 splittrade 20260707-14h (26/1).
- **Mutationsprov på steg 3:s 11 grindar och led:** alla fälls av testen.
- **Steg 3 (V1c):** 64 öppningssviter gröna (1033 test); vid commit 65 sviter (1042 test).

**Varför det blev en ägarfråga.** RUNA i 143 och XENIA i 979 ser likadana ut i
beslutsögonblicket: en följare i rörelse, en ledare som köar och en prognos strax efter fönstret.
Men 979:s följare körde rakt igenom, och 143:s följare ställde sig i kön. Det finns ingen grind i
datan som skiljer dem åt. Banken (verklig data) visar inga följder utöver en olåst fantom, men
quick fick en ny kandidat, och därför lades varianten fram som en ägarfråga.

**Beslut: U24 (2026-11-09), "inför ändringen"** (S/varv2/KAMPANJ2.md §Ägarbeslut U24). Ägaren
valde (b, smal) och godtar kostnaden att en köande konvoj ibland får en extra varning, som i
värld 143. Stilla köande båtar (1139) omfattas inte. V1c är committad som steg 3 (0b0a35d), med
U24 som källa i docblocken, i ARCHITECTURE.md:s punkt (c), i testhuvudet och i U9-kommentaren i
`lib/constants.js`.

**Mätt på steg 3** (0b0a35d, `batt-steg3`):
- **Batteriet:** lint, replay:all (med och utan monitoring), synthetic, openings, soak (båda),
  fassvepet (båda), självtestet och quick gav slutkod 0; porcelain visar bara node_modules.
- **Jest** gav i batteriet 1 fel av 5285, i `eta-accuracy-rendered.test.js` (fältdelen: ett
  textpåstående fick attributionen "rendering-saknas"). Lasten var då 30–40. Felet beror inte på
  steg 3:
  - testet är grönt 5 av 5 gånger ensamt;
  - under parallell last faller det i stället på `spawnSync ETIMEDOUT` (gränsen är 25 s);
  - renderingsfångsterna för 20260804-both-21h är byte-identiska mellan steg 1 och steg 3:
    3730 renderingar, 282 renderad-ledare, 156 token och ingen saknad fångst
    (`scripts/fangst.js`).

  Omkörningen med batteriets eget kommando gav slutkod 0: 370 sviter, 5283 test gröna och 2
  överhoppade (`batt-steg3/jest-omkorning.log`, `batt-steg3/status-omkorning`).
- **Regressionstestet** har 19 test. Det fäller 9 på c14938f och 5 på 594a146; ingen vakt
  fälls.
- **Jämfört med steg 1–2:** replay:all, synthetic och soak är bitlika. I openings ändras bara
  JOSEPHINE:s O2-rader.
- **Quick mot `bas/quick`:** 58 → 57 utslag och 25 → 26 kluster.
  - −värld 240 (steg 1).
  - −värld 41 (U24: HAVSORN varnas i tid).
  - +värld 143, den godtagna kostnaden: KANDIDAT `T3 VARNING-PÅ-FRUSET-FIX`, kortet
    `batt-steg3/hunt-quick/fynd/F05-oppningsvarning-pa-fruset-fix-vid-stridsbergsbron-soderut`.
- **hunt --repro:**
  - 979 och F02-representanten BORTA (0 utslag).
  - 1139 KVAR: T2 LEDTID<60s, 41 s.
  - 143 KVAR både som helvärld (`cards/Q-w143-Strid`) och som det krympta reprot
    (`fynd/Q143`). Det krympta reprot är KVAR även på c14938f.

### Registerpost för värld 143 (för familj E, källa U24)

Förslag: posten `U24-KONVOJDELNING`, klass DESIGN (en kostnad som ägaren godtagit, som
U17-TYST-BÅT-RECOVER), orakel `T3|VARNING-PÅ-FRUSET-FIX`.

**Predikat.** Fyndets varning W för båten B vid bron godtas när ALLA gäller:
1. **U24-släppet.** En annan båt L släpptes ur en avfyrad händelse E utan bokförd passage, vid
   tiden tL, med en dom 'bakkant' som bär `ownDeadlineMs` (bara U24-vägen bär fältet).
   Domens fält uppfyller U24:s villkor:
   - `arrivalMs > windowEndMs`;
   - `tL ≥ ownDeadlineMs`;
   - `coverUntilMs > arrivalMs − WARNING_LEAD_MS`;
   - L låg mer än 350 m från bron och saknade köflagga;
   - L hade appens ETA (`etaMinutes` ≠ null) och låg inte bortom bron (revisionen).

   Harnessen behöver därför också bokföra `distanceM` och `waitingAtBridge` per dom.
2. **L:s händelse.** L seedade händelsen H, och H avfyrades inom en tick efter tL.
3. **B i E.** B var absorberad i E före tL. Hon släpptes ur E med domen 'täckningsslut', inte
   genom U24, efter tL, och absorberades i H inom en tick.
4. **W är en täckningsslutsvarning.** W är B:s egen händelse, avfyrad inom en tick efter domen
   'täckningsslut' för B i H. B får vara TYST (värld 143) eller HÖRD och KÖANDE (granskningens
   A3e: B sänder var 30:e s, ligger still 250 m från bron och varnas ändå vid H:s täckningsslut).
   Är hon hörd ska hennes fix närmast före W visa kö, alltså `waitingAtBridge` satt eller sog ≤
   `MINIMUM_VIABLE_SPEED` inom väntzonen (≤ 350 m). En hörd båt i rörelse omfattas inte. För den
   gäller bakkanten och U24 själva, och en sådan W är en regression.
5. **Samma fysiska öppning.** B:s sanna korsning (L0) ligger inom `CONVOY_WINDOW_MS` (600 s)
   efter L:s. Det är precis kostnaden ägaren godtog: "en köande konvoj får en extra varning".

Orakel: `T3|VARNING-PÅ-FRUSET-FIX` när B är tyst. När B är hörd ger samma kedja en andra eller
tredje varning för samma öppning. Om motorn ser den med ett annat orakel (till exempel T3
VARNING-EFTER-SANN-PASSAGE eller ett H-4-utslag) ska posten utvidgas först när det fallet setts.

**Källa:**
- U24 (ägarbeslut 2026-11-09; C-IV väg b);
- granskningens prob A3b och A3e (`GRANSKNING.md` anm. 4; `prober/zz-granskning-b-A3e.test.js`);
- BridgeOpeningService#_ownDeadlineVerdict och #_releaseStrandedArms;
- DESIGN.md §M7, värld 143:
  - E = Stridsbergsbron#1 (ALVA);
  - L = RUNA 265101154, släppt 11:14:52;
  - H = #3, där B = CORDELIA 265101116 absorberas 11:25:30;
  - W = #8 kl. 11:36:10 på ett 21 min gammalt fix;
  - korsningar: RUNA 11:40:39, CORDELIA 11:46:32.

**Så skiljer sig posten från en regression:**
- **Utan U24-släpp i kedjan är det inte posten.** Det krympta reprot `fynd/Q143` ger samma
  orakel redan på c14938f, där U24 inte finns: varning Stridsbergsbron#7 11:34:48 på ett 20 min
  gammalt fix. Den klassen fanns före U24 och ska stå kvar som KANDIDAT. Helvärlden
  `cards/Q-w143-Strid` ger BORTA på c14938f, 650a0c7 och 594a146, och KVAR först på 0b0a35d.
- **Ett U24-släpp som bryter mot villkoren i punkt 1 är ett kodfel och ska ge utslag.** Exempel:
  en båt inom 350 m, med köflagga, med en prognos inom fönstret, eller med ett täckningsslut som
  hade kommit i tid. Kontroll: mutationsprovet utan grindarna `täckningsslut-i-tid` eller `kö`
  (V1 och V1b, se tabellen) ska ge utslag som posten inte tar.
- **En hörd båt i rörelse vid W, eller ett U24-släpp av L utan appens ETA, omfattas inte.** Grindarna
  'en-prognos' och 'bakom' (revisionen) ska ha hållit L kvar, så ett sådant släpp är en regression.
- **Den låsta banken är grinden för verklig data.** U24 får inte ändra antalet varningar (431 i
  replay:all) eller någon låst rad. Posten gäller bara sanningsspårets världar.
- **Andra orakel med samma kedja täcks inte förrän de setts och mätts**, till exempel T3
  VARNING-EFTER-SANN-PASSAGE eller ett H-4-utslag.

### Ägarfrågan som den ställdes (besvarad med U24)

En båt hör till en broöppning som en annan båt redan har fått varning för. Den andra båten har
ännu inte passerat; hon väntar vid bron, eller appen har tappat henne. Den första båten är på väg
och kommer fram först efter den tid appen räknade med för öppningen. I dag får hon en egen
varning först när den tiden har gått, ibland under en minut före passagen (provvärld 979:
50 sekunder).

Vi har byggt och mätt en ändring: hon får sin egen varning så fort hennes egen tidsfrist går ut
(provvärld 979: fem minuter före passagen). Det gäller bara när hon är i rörelse, mer än 350 meter
från bron, när appens prognoser säger att hon inte hinner med den gemensamma öppningen, och när
varningen annars hade kommit för sent.

Det här har vi mätt:
- **I de 24 inspelade körningarna (480 timmar):** lika många varningar som förut, ingen ny varning
  i en konvoj, och inget låst facit ändras. En varning för en båt som aldrig passerade kommer fem
  minuter tidigare; det är samma falsklarm som förut.
- **I buggjägarens 300 provvärldar:** två båtar får sin varning i tid i stället för för sent:
  provvärld 979 fem minuter före passagen i stället för 50 sekunder, och provvärld 41 sju minuter
  före i stället för två sekunder efter. I provvärld 143 delas däremot en konvoj: två båtar som
  köade vid samma bro och passerade med sex minuters mellanrum får två varningar i stället för
  en, och den andra bygger på en 21 minuter gammal position.
- **Båtar som ligger stilla i kön** (provvärld 1139) hjälper ändringen inte; för dem gäller
  dagens beteende.

Vill du
- **(b, smal)** införa ändringen? Det ger tidigare egna varningar för båtar som annars varnas för
  sent, men ibland en andra varning till en båt i en konvoj som köar.
- **(c)** behålla dagens beteende, där varningen i 979-fallet kan komma under en minut före? Då
  behövs en registerpost för motorn.
- **(a)** låta båten höra till den gemensamma öppningen tills någon faktiskt passerar? Hon får då
  ingen egen varning. Varianten är inte mätt i varv 2, och C8 kostade sex ovarnade öppningar.

## Domens fält (för familj E)

`_coverageVerdict(arm, event, now)` har samma signatur som förut och samma `kind`/`reason`.
- **Steg 2:** i bakkantsgrenen efter passage, när en ankomst har jämförts med fönstret, bär
  domen `arrivalMs` (`_crawlArrivalMs`: max av prognos och fysik under 2,5 kn, annars prognosen),
  `physicsArrivalMs` (armens fysik eller null) och `windowEndMs`. Gäller 'covered' (inom fönstret
  eller kurs bort) och 'bakkant'. Fälten saknas när domen avgjordes tidigare och efter
  täckningsslutet.
- **Armen** bär `physicsArrivalMs` från varje tillämpat fix.
- **Steg 3 (U24):** före passagen bär domen `arrivalMs` (den TIDIGARE av prognos och fysik,
  null utan fysik), `physicsArrivalMs`, `windowEndMs` (referens + 600 s) och `ownDeadlineMs`
  (`earliestArrivalMs − WARNING_LEAD_MS`), NÄR UNDERLAGET FINNS (en avfyrad händelse med
  referensankomst; annars en bar `{kind:'covered'}`). En dom 'covered' bär dessutom `gate` ∈
  {bakom, orent, ingen-fysik, en-prognos, inom-fönstret, kö, deadline, täckningsslut-i-tid, golv,
  kurs}. Släppet har `kind: 'bakkant'` och en reason som börjar med "egen deadline".
- **Revisionen:** efter passagen bär en dom 'covered' `gate: 'bakom'` (utan de tre fälten) när bron
  ligger bakom hennes senaste läge. Armen bär `crawlFixes` (antal NYA krypfix i följd, revision 2),
  `crawlFromCruise` (krypfixet kom direkt efter marschfart) och `prevFixSog` (förra nya fixets fart).

## Samspel med andra familjer

- **D (spärren i `_refreshArm`, BOS:1303–1316):** orörd. Fysikankomsten ligger direkt efter
  `expectedArrivalMs` (BOS:1296–1298, före `etaFireMs`), alltså ovanför D:s block.
- **E:**
  - E kan bokföra domens nya fält (ovan).
  - Triage B:s förslag (3′) jämför `expectedArrivalMs` med fönstrets slut. Efter steg 2 ska det
    vara domens `arrivalMs`, annars blir krypfall felklassade.
  - Med steg 3 tillkommer domen 'bakkant' före passage, igenkänd på fältet `ownDeadlineMs`.
    E:s U17-predikat ("släpp med domen täckningsslut") påverkas inte, men K-NÄSTA och
    U2-VS-DEADLINE kan behöva känna till den. Registerposten för värld 143 beskrivs ovan.
- **A och C:** ingen beröring (VDS, app.js).
- **Steg 3** rör dessutom `_scheduleNextDeadline` (en väckning per arm), lägger
  `_ownDeadlineVerdict`, `_ownDeadlineBasis`, `_ownDeadlineGate` och `_ownDeadlineWakeMs` i BOS,
  och lägger en kommentarrad om U24 vid `U9_RESCUE_COVERAGE` i `lib/constants.js`.

## Hur besluten följs

- **U13:** steg 1 flyttar inget facit. Steg 2 flyttar en olåst varning och redovisar den med
  rådata (FACIT.md). M7-varianten V1b, som hade flyttat en låst rad, förkastades.
- **U17:** säkerhetsvarningen vid täckningsslutet är orörd. Både M4 och M5 påverkar bara släppet
  före täckningsslutet.
- **U18:** rörs inte.
- **U22:** ETA-texten och ETA-kedjan rörs inte. Fysiken läses bara av släppvägen, och testet låser
  `fireDueMs` och eta-tokenen.
- **C-IV (b) och U24:** steg 3 följer ägarens ord "när en medlems egen deadline annars skulle
  förfalla" (villkoret täckningsslut-i-tid), och U24 godtar kostnaden i värld 143.
- **D1:** kajregeln är orörd.

## Dokument som uppdateras

- ARCHITECTURE.md: §bridge_opening_soon (bakkanten, krypfysiken) och §H29/H30 (KRAV (2)/(4)).
  Steg 3 lägger till punkt (c) "Före händelsens första passage", med U24 (2026-11-09) som källa.
- `lib/constants.js`: U9-kommentaren hänvisar till U24 (flaggan förblir av).
- Docblocken i BOS: `_coverageVerdict` (färskhet, domens fält), `_openEvent`, `_crawlArrivalMs`,
  `_arm` (`physicsArrivalMs`) och `_refreshArm`. Steg 3 lägger till `_ownDeadline*` med U24.
- Inga syntetiska scenarier har lagts till; mekanismerna prövas i jest
  (`tests/b-bakkant-varv2.test.js`). VALIDATION.md:s antal är därför oförändrat.

## Commits

- 650a0c7: steg 1 (M4).
- 594a146: steg 2 (M5). Slutbatteriet kördes på ad87498. 594a146 är samma commit med fem
  kommentarrader om M5 i testfilens huvud; koden är identisk (`git diff ad87498 594a146 -- lib`
  är tom), och testfilen och lint är omkörda.
- 0b0a35d: steg 3 (M7, U24) = `patch-M7.diff` plus U24-texterna. Batteriet: `batt-steg3`.
- 5d4b2c3: revision efter granskningen (punkt 1–4 i koden; punkt 5 i denna fil). Batteriet: `batt-rev1`.
- e5f78b5: revision 2 efter omgranskningen (nya fix, krypfix efter marschfart). Batteriet: `batt-rev2`.
- `patch.diff` = `git diff c14938f` (steg 1–3).
