# TRIAGE-A — T2-korten F02, F05 och F08 (varv 2, 2026-11-09)

Triagerare T-A. Underlaget är motorns standardkörning i `S/reg/slut-standard` (HEAD c14938f).
Radhänvisningar gäller c14938f. Alla tider är UTC.

Förkortningar: S = `/tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad`,
T = S/varv2/tA. VDS = `lib/services/VesselDataService.js`, BOS = `lib/services/BridgeOpeningService.js`.

## Sammanfattning

De 21 fynden (F02 9, F05 11, F08 1) har tio mekanismer:

| Mekanism | Klass | Fynd (värld) | Skiss |
|---|---|---|---|
| M1 NYRESA-SAMMA-TICK | APPFEL | 936, 1208 Klaff, 1208 Strid, 1316, 1918 | BORTA, facit orört |
| M2 RECROSS-TOMT-MÅL | APPFEL | 1274, 1317 | BORTA, facit orört |
| M3 ÅTERFÖDD-DÖDBAND | APPFEL | 756 (F05-rep), 1913 (och 977 på köpet) | BORTA, facit orört |
| M4 BAKKANT-BOKFÖRINGSFÄRSKHET | APPFEL | 1094, 1476 | BORTA, facit orört |
| M5 KRYP-PROGNOS | APPFEL | 790, 1794 (F08) | BORTA, facit orört |
| M6 SPÄRR-I-RÖRELSE | ÄGARBESLUT | 263 | mätt: BORTA men 10 låsta korpusar flyttar |
| M7 TÄCKNINGSSLUT-UTAN-PASSAGE | ÄGARBESLUT (C-IV) | 979 (F02-rep), 1139 | ingen |
| M8 KÖ-I-KAJKAPSELN | ÄGARBESLUT (D1-familjen) | 313 | ingen |
| M9 AVGÅNG-I-STILLAINTERVALL | MOTORFEL (radiomodellen) | 290, 625 | ingen (motorändring) |
| M10 U2-FÖNSTERKANT | MÄTGRÄNS | 510, 977 | registerpost |

Ingen mekanism är TÄCKT av U14–U22: motorns U18-post prövades korrekt och avvisades i 936, 1208,
1274, 1316, 1317 och 1918, eftersom vändningen var bekräftad i tid. Det var appens måltilldelning
som kom ett fix för sent.

Fem APPFEL-skisser (M1–M5) gör tillsammans 14 av de 21 fynden BORTA (977 räknat). Mätningar på den
sammanslagna skissen `T/skiss-ALLA-APPFEL.diff`:
- `replay:all`: bitlik med baslinjen;
- `replay:synthetic`: bitlik;
- `replay:openings`: lika, utom att en varning i 20260804-17h går 258 s tidigare;
- hela jest: 369 sviter, 5264 test, gröna.

## Underlag och metod

- **Repro:** `node tests/replay-validation/bugHunt/hunt.js --repro` för de fem fyndkatalogerna,
  kopierade till T/fynd (F02 = värld 979, F02/r2 = 1274, F05 = 756, F05/r2 = 1208, F08 = 1794).
  Alla gav KVAR på c14938f.
- **Helvärldar:** de övriga världarna återskapades med `T/scripts/gen.js`, kopierad från
  triage-1 och pekad mot worktree. Radhashen var bitlik mot fyndets recept i alla 16 okrympta
  världar.
- **Kort:** `T/scripts/mkcard.js` byggde hunt:repro-kort i T/cards, så att varje värld kan dömas
  KVAR/BORTA.
- **Loggar och tidslinjer:** verbosa replayer (`REPLAY_VERBOSE=1 REPLAY_DEBUG_LEVEL=full`) ligger i
  T/logs. `T/scripts/tl.js` lägger L0, rader, varningar, täckning, notiser och passager för en båt på
  samma tidslinje. `T/scripts/olog.sh` plockar en båts rader ur öppningstjänsten.
- **Skisserna:** mätta i worktree och sedan återställda (`git checkout -- .`). Bara node_modules är
  otrackad. Mätloggarna ligger i T/matningar och reprotabellerna i T/repro.

## Per värld

### F02 — LEDTID<60s

#### 263 · BRISEN 265891927 · Stridsbergsbron norrut · R1 AISHub · monitoring
- **Tidslinje:**
  - Klaffbron passeras 14:52:40.
  - Fixar 15:00:53 (670 m från Strid, 2,4 kn), 15:01:59 (556 m, 2,4 kn) och 15:03:05 (459 m,
    2,1 kn, fix 15:02:56). Därefter ett fixglapp på 272 s.
  - L0: Järnvägsbron 15:05:41 (2,4 kn), Stridsbergsbron 15:07:45 (4,2 kn). Båten accelererar
    efter Järnvägsbron (sektorfarten).
  - Varning Stridsbergsbron#4 kommer 15:07:00,824 (deadline). Ursprunglig förfallotid 14:51:34.
- **Rotorsak:** spärren vid en tidigare bro. Järnvägsbron räknas som tidigare bro, eftersom båten
  har passerat broar (BOS:626). För en båt i rörelse sätts spärren till ankare +
  min(300 s, restid i nuvarande fart − 180 s) (BOS:1311–1316). fireDueMs = max(deadline, spärr)
  ersätter alltså 10-knopsgarantin, och varje fix ankrar om spärren.
- **Belägg** (omräknat ur raderna): från fixet 15:02:56 blir spärren 459 m / 1,08 m/s − 180 s =
  244,9 s, alltså till 15:07:00,823, och varningen gick 15:07:00,824. Deadlinen i 10 kn hade varit
  15:01:25.
- **Mekanism:** M6.

#### 290 · DAGNY 265264951 · Stridsbergsbron norrut · R1 AISHub
- **Tidslinje:**
  - Kö vid Järnvägsbron 14:30:44–14:48:09 (L0), 441 m före Strid.
  - Stillafixar ungefär var 200:e s; den sista 14:47:44 (fix 14:47:20, sog 0).
  - Nästa fix kommer 14:51:07 (fix 14:50:53): 182 m, 5,6 kn, redan förbi Järnvägsbron.
  - Strid korsas 14:51:53. Varning #8 går 14:51:07 (fix), 46 s före.
- **Rotorsak:** avgången hördes först 164 s efter att den skett. Radiomodellen drar nästa fix
  ur stillakadensen vid det stilla fixet (`tests/replay-validation/bugHunt/lib/radio.js:225–227`
  och :271, `due = fixS + interval('aishub', moving)`). BUGGJAKT §4.5 (rad 175) anger detta som
  en känd modellgräns. Appens spärr för en väntande båt räknar 300 s tystnad, och varje stillafix
  ankrar om den (BOS:1311–1315). Väntan är därför tyst till första rörelsefix.
- **Mekanism:** M9.

#### 313 · SALTIS 265128436 · Klaffbron söderut · R1 AISHub
- **Tidslinje:**
  - Varning Klaffbron#5 går 09:22:37 (845 m).
  - Kö 265 m norr om bron 09:26:08–10:26:08 (60 min).
  - 09:48:34: `[MOORED] … zon "Kajen norr om Klaffbron" (still 18 min)` följt av `[MOORED_DEMOTE]`.
    Målbron rensas.
  - 10:14:20: `[OPENING_DISARM] … stale (d=240 m, … armad 3584 s)`. Armen uppdateras inte utan
    målbro, så TTL på 30 min löper ut.
  - 10:26:42 (2,7 kn, 244 m): `[STILLNESS_JITTER_HELD] … netto 21.6 m (<50 m)` och
    `[TARGET_QUAY_POSITION_PROOF] … avvaktar mätbar avgång`.
  - 10:27:49 (82 m, 5,1 kn): `[OPENING_QUAY_DEPARTURE]`, ny arm med deadline om −270 s. Varning
    Klaffbron#6 går direkt, 32 s före korsningen 10:28:21.
- **Rotorsak:** kajkapseln "Kajen norr om Klaffbron" ligger 190–295 m från bron, mitt i väntzonen.
  Köundantaget är 15 min (`lib/constants.js:421–434`). Kön blir därför en kajliggare
  (VDS:3683 och :323–330). Armen dör (BOS:1636–1641, `ARM_STALE_TTL_MS` i `lib/constants.js:1418`)
  och avgången blir en ny ankomst (`app.js:1535`). Kajavgångsbeviset kräver ≥ 50 m netto
  (VDS:4104–4135), alltså två fix.
- **Varför T2 fäller:** oraklet mäter ledtiden mot den senaste varningen före korsningen
  (`tests/replay-validation/runOpeningGates.js:763–768`). Utan den sena #6 hade #5 täckt henne
  med 66 min.
- **Mekanism:** M8.

#### 790 · FREJA 2 265276913 · Stridsbergsbron norrut · R1 aisstream
- **Tidslinje:**
  - Tyst 13:06:30–13:28:18.
  - 13:28:18 (334 m, 1 kn): absorberas i XENIAs #10. XENIA har redan korsat 13:26:22, och
    täckningen gäller t.o.m. 13:37:22,760 (bokföringen + 600 s).
  - 13:31:18 (230 m, 0,9 kn): appens ETA är 3,0 min. `[ETA_OUTLIER] … 8.3min … dramatic_increase_2.78x`
    följs av `[ETA_FALLBACK] … 3.0min`.
  - 13:37:22: `[OPENING_RECOVER] … löpte ut (Stridsbergsbron#10) … d=230 m`, och egen #11 går
    direkt. Korsningen sker 13:38:09 (1,1 kn), 47 s efter varningen.
- **Rotorsak:** bakkanten (BOS:2298–2318) och medlemskapet (BOS:2448) läser expectedArrivalMs ur
  appens ETA (BOS:1296). För en krypare håller ETA-kedjan nere värdet:
  - passagegolvet 2,5 kn (`lib/services/ProgressiveETACalculator.js:787–790`,
    `MIN_PASSAGE_ROUTE_SPEED_KNOTS` i `lib/constants.js:141`);
  - outlierskyddet (:1289).

  Prognosen 13:34:17 låg därför inom fönstret till 13:36:10, medan fysiken (230 m i 0,9 kn) gav
  13:39:35, bortom fönstret.
- **Mekanism:** M5.

#### 936 · XENIA 265664174 · Klaffbron norrut (retur) · R1 AISHub
- **Tidslinje:**
  - Klaffbron söderut 06:51:34. `[TARGET_END]` 06:51:57.
  - U-sväng 06:55:56 (s = 1607).
  - 06:57:43 (5,0 kn, cog 17,5°): `[NEW_JOURNEY_PENDING]`.
  - 06:58:53 (5,2 kn, 366 m): `[NEW_JOURNEY] … CONFIRMED`, men ingen målbro.
  - 07:00:01 (154 m): `[TARGET_CHANGE] … ACCELERATED` och `[OPENING_RETURN]`. Varning #9 går
    46 s före korsningen 07:00:47.
- **Rotorsak:** NEW_JOURNEY körs i `app.js:3148–3225` (`_onVesselUpdated`), efter att VDS redan
  kört målbrokedjan för samma fix. Där gav `_calculateTargetBridge` null på den gamla resans
  `_finalTargetDirection`/passedBridges (FIX Z, VDS:4602–4626). Resetten litar på
  "accelerated-target-assignment" vid NÄSTA fix, och `_observeBridgeOpening` (`app.js:3301`) ser
  ingen målbro i den här ticken.
- **Mekanism:** M1.

#### 979 · XENIA 265141626 · Stridsbergsbron söderut · R0 · monitoring (F02-representanten)
- **Tidslinje:**
  - FREJAs varning Stridsbergsbron#1 går 08:41:32 (1029 m, eta 5).
  - 08:43:32: XENIA absorberas i #1, "täckt t.o.m. 08:56:34.936Z". Det är #1:s referensankomst
    08:46:34,9 + 600 s.
  - FREJA stannar i kö 08:45:55–09:22:59 (37 min). #1 får alltså ingen första passage.
  - XENIA saktar in från 6,5 till 5,8 kn, och prognosen glider till 08:57:52.
  - 08:56:34,937: `[OPENING_RECOVER] … löpte ut (Stridsbergsbron#1) … d=154 m`, och egen #2 går
    direkt (ursprunglig förfallotid 08:48:36). Korsningen sker 08:57:25, 50 s senare.
- **Rotorsak:** se de särskilda frågorna.
- **Mekanism:** M7.

#### 1139 · MASEN 265620261 · Stridsbergsbron söderut · R1 aisstream · monitoring
- **Tidslinje:**
  - 12:16:49 (577 m, 6,9 kn): absorberas i QUESTs #1. QUEST korsade 12:14:18.
  - Kö 157 m från bron 12:19:17–12:34:16.
  - 12:26:08: täckningsslut för #1. MASEN återabsorberas i #5. Den händelsen avfyrades 12:25:02
    som RECOVER-släppets säkerhetsvarning (U17) för den tysta YRSA 2, på hennes 15 min gamla fix
    12:10:12 (2469 m bort). YRSA 2 hade i själva verket korsat osedd 12:23:03 (L0), och appen
    bokförde aldrig den passagen.
  - 12:35:02,447: `[OPENING_RECOVER] … löpte ut (Stridsbergsbron#5) … d=157 m`, och egen #6 går
    41 s före korsningen 12:35:43. Avgången 12:34:16 hördes inte.
- **Rotorsak:** samma som 979. Täckningsslut på en händelse utan bokförd passage
  (BOS:2171–2197, :2340) ger en sen andra varning på förfallen deadline.
- **Mekanism:** M7.

#### 1274 · YRSA 265402472 · Klaffbron söderut (retur) · R1 aisstream (F02:s r2)
- **Tidslinje:**
  - Järnvägsbron norrut 09:11:30.
  - U-sväng 09:12:43 mellan Järnvägsbron och Strid.
  - L0: Järnvägsbron söderut 09:14:10.
  - 09:14:21 (27 m söder om Järnvägsbron, cog 222°):
    - `[TARGET_RECALC_PENDING]`;
    - `[RE_CROSS_EVIDENCED] Järnvägsbron korsad IGEN … (north → south)`;
    - `[TARGET_RECALC] … clearing target Stridsbergsbron — recalculation will run via normal flow`;
    - `[PASSAGE_AUDIT] … targetBridge=none`.
  - Nästa fix 09:20:29 (52 m norr om Klaffbron): målbro och varning #4, 23 s före korsningen
    09:20:52.
- **Rotorsak:** se de särskilda frågorna.
- **Mekanism:** M2.

#### 1918 · GUNHILD 265251208 · Stridsbergsbron söderut (retur) · R1 AISHub
- **Tidslinje:**
  - `[TARGET_END]` vid Strid 09:05:59.
  - U-sväng 09:09:09, 760 m norr om bron.
  - 09:10:30: `[NEW_JOURNEY_PENDING]`.
  - 09:11:39 (8,3 kn, 448 m): `[NEW_JOURNEY] … CONFIRMED`, ingen målbro.
  - 09:12:46 (97 m): `[TARGET_CHANGE] … ACCELERATED`. Varning #9 kommer 10 s före korsningen
    09:12:55.
- **Rotorsak:** som 936.
- **Mekanism:** M1.

### F05 — ÖPPNING-MISS:OKLASSAD

#### 510 · JOLLY 265558533 · Stridsbergsbron söderut · R1 AISHub
- **Tidslinje:**
  - 15:52:50: absorberas i VEGAs #1. VEGA korsar 15:58:15, så U2-fönstret slutar 16:08:15.
  - Täckningen kortas till 16:08:23,591 (`[OPENING_COVER_REBASE]`).
  - Fixar: 16:05:11 (273 m, 5,6 kn) och 16:06:19 (102 m, 2,9 kn). Därefter kryper hon 1,4 kn de
    sista 160 m.
  - Korsning 16:08:19,97, 605 s efter VEGA.
  - RECOVER vid täckningsslutet ger egen #4 16:08:23,59, 4 s EFTER korsningen.
- **Rotorsak:** knivsegg vid U2-fönstrets kant. Varje egen rad efter VEGAs korsning gav en fysisk
  ankomst inom fönstret, den sista 16:07:12 ur fixet 16:06:19. Appens prognos var 16:07:46.
  Krypet började efter sista fixet (se M10).
- **Mekanism:** M10.

#### 625 · DAGNY 265956525 · Stridsbergsbron norrut · R1 aisstream
- **Tidslinje:**
  - Kö vid Järnvägsbron 09:29:38–09:32:53.
  - Fixar 09:29:43 och 09:32:49 (sog 0, 520 m från Strid). Nästa fix 09:44:28 (11,6 min).
  - L0: Järnvägsbron 09:35:32, Strid 09:36:55.
  - Spärrens reservvarning #11 går 09:37:49,362, alltså 09:32:49,362 + 300 s. Det är 54 s EFTER
    korsningen.
- **Rotorsak:** som 290. Avgången 4 s efter ett stillafix hörs inte före korsningen
  (radio.js:244, `tS += interval('aisstream', moving)` med stillaintervallet). Reserven i
  spärren är 300 s (BOS:1311–1315), längre än restiden kö → Strid, 242 s.
- **Mekanism:** M9.

#### 756 · FREJA 265172107 · Stridsbergsbron söderut · R1 aisstream (F05-representanten)
- **Tidslinje:**
  - 13:44:47: återfödd 1888 m norr om Strid, 6,4 kn, cog 229,6°.
  - Avbrott (ctrl:disconnect) 13:45:02–13:57:23.
  - L0: Strid 13:54:34 och Järnvägsbron 13:56:20.
  - Första fixet efter avbrottet 13:57:28. Varningen gäller då bara Klaffbron#1.
- **Rotorsak:** i fixet 13:44:47 loggas, i tur och ordning:
  - `[NORTH_PROGRESS_REBIRTH] … (-3.408 m/s över 428 s)` (VDS:265–295);
  - `[TARGET_ASSIGNMENT] … Osäker COG (229.6°) → ingen målbro tilldelas ännu` (VDS:4645–4651);
  - i samma tick men senare, i app-lagret,
    `[SKIPPED_BRIDGES_DIRECTION_LOCK] … 'south' locked from evidenced sweep window`
    (`app.js:8676–8686`).

  Målbron väljs före låset, och ingen väg tilldelar om. Utan målbro beväpnas ingen arm (BOS:588–595),
  och ingen deadline kan gå i tystnaden. Koden vet om luckan: kommentaren `app.js:8653–8655` säger
  "en återfödd vessel kan sakna _routeDirection (osäker COG stoppade targettilldelningen)".
- **Mekanism:** M3.

#### 977 · PELLE 265369968 · Klaffbron norrut · R1 aisstream
- **Tidslinje:**
  - Fixarna 07:18:49, 07:22:35, 07:23:06 och 07:24:06 har kurs 45,9–51° → "Osäker COG", ingen målbro.
  - 07:25:32 (1833 m): målbro (ACCELERATED) och absorption i XENIAs Klaffbron#1, "täckt t.o.m.
    07:40:34".
  - XENIA är tyst över bron och korsar 07:29:00. `[OPENING_PASSAGE_TIME] … korsningen 07:29:21.292Z
    skattad, 622 s före bokföringen`: passagen bokförs först 07:39:43.
  - PELLE: 07:36:12 (418 m, 4,4 kn) och 07:38:40 (86 m). Korsning 07:39:14, 614 s efter XENIA.
  - 07:39:43 släpps hon och absorberas i ULLAs sydgående Klaffbron#3, efter korsningen. Ingen
    egen varning.
- **Rotorsak:** ledarens passage blev känd för appen 29 s EFTER följarens korsning. Före det hör
  följaren till händelsen (U2; BOS:2212–2214, bakkanten kräver passageKnown på BOS:2301–2303).
  Appens skattning av XENIAs korsning (07:29:21) gav fönsterslutet 07:39:21, och PELLEs prognos
  07:39:17 låg innanför det.
- **Mekanism:** M10. Skiss C tar ändå bort fyndet: med den beväpnas hon 07:22:35 på en långsam
  prognos och får en egen varning 07:30:32.

#### 1094 · QUEST 265109339 · Stridsbergsbron söderut · R1 AISHub
- **Tidslinje:**
  - 11:37:13 (2372 m): absorberas i ALVAs #1, "täckt t.o.m. 11:49:17.025Z".
  - ALVA är tyst över bron (L0 11:38:25). Passagen bokförs 11:41:39, och den skattade korsningen
    är 11:38:47,979.
  - QUEST: sista fixet 11:39:27 (1810 m, 5,9 kn), före bokföringen. Avbrott 11:41:51–11:52:15.
  - Korsning 11:48:44. RECOVER vid täckningsslutet ger #6 11:49:17, 33 s efter korsningen.
- **Rotorsak:** bakkanten kräver ett fix EFTER bokföringen (`arm.lastSeenAt > firstPassageRegisteredAt`,
  BOS:2303). QUESTs sista fix låg före bokföringen och efter den skattade korsningen. Prognosen ur
  det fixet (11:49:10–11:49:15) låg bortom fönsterslutet 11:48:48. Bakkanten hade alltså släppt
  henne, men fick aldrig döma.
- **Mekanism:** M4.

#### 1208 · KAJSA 265244034 · Klaffbron norrut och Stridsbergsbron norrut (två fynd, F05:s r2)
- **Tidslinje:**
  - Klaffbron söderut 13:34:21. `[TARGET_END]` 13:34:38.
  - U-sväng 13:38:17.
  - 13:40:17: `[NEW_JOURNEY_PENDING]`.
  - 13:41:25 (255 m, 5,1 kn): `[NEW_JOURNEY] … CONFIRMED`, ingen målbro.
  - Nästa fix 13:54:56, 13,5 min senare. Under tiden passeras Klaffbron 13:42:39, Järnvägsbron
    13:51:51 och Strid 13:53:22, alla utan varning.
- **Rotorsak:** som 936 (M1). Se de särskilda frågorna.

#### 1316 · GUNHILD 265909710 · Stridsbergsbron söderut (retur) · R1 aisstream
- **Tidslinje:**
  - `[TARGET_END]` vid Strid 01:08:12. Hon korsade 01:03:37 och bokfördes efter ett glapp.
  - U-sväng 01:08:07.
  - 01:08:55: `[NEW_JOURNEY_PENDING]`.
  - 01:09:53 (623 m, 6,3 kn): `[NEW_JOURNEY]`, ingen målbro.
  - Nästa fix 01:14:46. Korsning 01:13:09, utan varning.
- **Mekanism:** M1.

#### 1317 · YRSA 265535696 · Stridsbergsbron norrut (retur) · R1 aisstream
- **Tidslinje:**
  - Söderut: Strid 12:26:38 och Järnvägsbron 12:28:35.
  - U-sväng 12:30:36, söder om Järnvägsbron.
  - 12:30:44: 1,1 kn, ingen Fix D-väntan (under 2 kn).
  - 12:33:26 (8 m norr om Järnvägsbron, 2,9 kn):
    - `[RE_CROSS_EVIDENCED] Järnvägsbron … (south → north)`;
    - `[TARGET_RECALC] … clearing target Klaffbron — recalculation will run via normal flow`.
  - Strid (253 m bort) blir aldrig målbro. Nästa fix 12:36:07. Korsning 12:35:06, utan varning.
- **Mekanism:** M2.

#### 1476 · RUNA 265848238 · Klaffbron norrut · R1 aisstream
- **Tidslinje:**
  - 11:53:33 (1737 m, 5,6 kn): absorberas i PELLEs #3. PELLE korsar 11:52:55 och bokförs 11:54:00.
  - RUNA är tyst 11:53:33–12:05:00. Korsning 12:03:04, 609 s efter PELLE.
  - Täckningen kortas till 12:04:00,087. Efter korsningen absorberas hon i DAGNYs #4.
- **Rotorsak:** som 1094. Sista fixet låg 27 s före bokföringen, och prognosen 12:03:36 låg
  bortom fönsterslutet 12:03:08.
- **Mekanism:** M4. Med skiss D släpps hon 11:54:00 och absorberas i DAGNYs #4 (varning 11:44:44).
  DAGNY korsar 12:01:33, 91 s före henne, så det är samma öppning. Utslaget blir KÄND_ÖPPEN
  J13-J14 (JOLLY och BRISEN korsade emellan): ägarens öppna J13-fråga, ingen kandidat.

#### 1913 · HAVSORN 265629897 · Klaffbron norrut · R1 aisstream
- **Tidslinje:**
  - Återfödd tre gånger: 13:21:51 (2459 m, cog 48,2°), 13:25:52 (2085 m, 45,3°) och 13:38:12
    (365 m, 4,8 kn, 48,6°). Varje gång loggas "Osäker COG … ingen målbro".
  - 13:38:12: `[NORTH_PROGRESS_REBIRTH] … (2.040 m/s över 739 s)` och
    `[SKIPPED_BRIDGES_DIRECTION_LOCK] … 'north'`.
  - Korsning 13:40:36. Ingen arm, ingen varning.
- **Mekanism:** M3.

### F08 — stresstvillingen

#### 1794 · CORDELIA 2 265059630 · Klaffbron norrut · R1 AISHub · krypfart 1,3 kn (F08-representanten)
- **Tidslinje:**
  - 10:01:32: absorberas i YRSAs Klaffbron#2. YRSA korsar 10:09:04, bokförs 10:09:29 (skattad
    10:09:10,3). Fönsterslutet är 10:19:10 och täckningen kortas till 10:19:29,612.
  - Kryp i 1,3 kn från ungefär 320 m. Appens ETA (direct_at_target) var 3,5 min vid 258 m
    (10:12:52), 2,0 min vid 127 m och 1,5 min vid 90 m. Fysiken ger 6,4, 3,2 och 2,2 min.
  - Korsning 10:19:09, 604 s efter YRSA.
  - RECOVER ger #4 10:19:29, 20 s efter korsningen. Det blir T3 och den saknade varningen.
- **Rotorsak:** som 790. Passagegolvet 2,5 kn gör att bakkanten ser ankomsten 10:16–10:18,
  innanför fönstret. Gränsen 1,26–1,3 kn är just där fysiken passerar fönsterkanten.
- **Mekanism:** M5.

## Svar på de särskilda frågorna

**1274 och 1317: varför hålls målbron tom efter RE_CROSS?**
- Målbrokedjan i `VesselDataService.updateVessel` är en else-if-kedja:
  - VDS:503 för ny båt;
  - VDS:534 för båt MED målbro;
  - VDS:761 för båt UTAN målbro (ACCELERATED-grenen).
- Båten har målbro när ticken börjar, så kedjan tar grenen på VDS:534. Där anropar VDS:719
  `_handleIntermediateBridgePassage`. RE_CROSS_EVIDENCED (VDS:7189–7196) ser då att mellanbron
  (Järnvägsbron) återkorsas, och `_confirmDirectionReversal` (VDS:6813–6826) nollar målbron med
  texten "recalculation will run via normal flow".
- Den normala vägen är ACCELERATED-grenen på VDS:761, men den är `else if` i samma kedja och körs
  inte i den här ticken. Målbron sätts först vid nästa fix.
- Fix D:s bekräftelse (VDS:394–487) körs FÖRE kedjan och sätter `fixDReversalConfirmed`. I den
  vägen tilldelas därför ny målbro i samma tick. Felet gäller alltså bara vändningar som bekräftas
  under en annan bro än målbron.
- Med gles AIS (6 min i 1274, 2,7 min i 1317) kommer nästa fix vid eller efter korsningen.

**1208: vilken kodväg sätter inget mål i samma tick, och vad krävs?**
- NEW_JOURNEY ligger i `app.js:3148–3225` (`_onVesselUpdated`). Den körs på händelsen
  `vessel:updated`, alltså EFTER att `updateVessel` har kört målbrokedjan för samma fix.
- I kedjan gav ACCELERATED-grenen (VDS:761, :837) null via `_calculateTargetBridge`. Skälet var
  FIX Z-spegeln (VDS:4622–4626): `_finalTargetDirection` och passedBridges beskrev fortfarande den
  avslutade resan.
- NEW_JOURNEY nollar sedan passedBridges, `_finalTarget*` och ruttlåset, men lämnar
  måltilldelningen åt nästa fix. `_observeBridgeOpening` (`app.js:3301`) i samma hanterare ser
  därför ingen målbro, och ingen arm skapas.
- Det som krävs för att målet ska sättas direkt: direkt efter resetten (efter `app.js:3223`)
  ska ACCELERATED-grenens tilldelning köras för samma fix, före `_observeBridgeOpening`:
  - `_shouldAssignTargetBridge(vessel, oldVessel, true)`;
  - `_calculateTargetBridge(vessel, newDir)`;
  - `_lockRouteDirection` och `_extendJourneyOrigin`;
  - avbokning av en kvarvarande borttagningstimer och ETA-historiken.

  Skiss A gör det. U18 rörs inte, eftersom vändningen redan är bekräftad på två positioner.

**F05-representanten (756): MÄTGRÄNS eller extrapolerad ETA?**
- Ingetdera. Deadlinemotorn behöver ingen ETA: "tystnad avväpnar aldrig" (ARCHITECTURE.md:807).
  Fixet 1888 m ut i 6,4 kn hade gett tidigaste ankomst 13:44:47 + 367 s, och med 180 s ledtid blir
  deadlinen 13:47:54. Varningen hade alltså gått i tystnaden, 400 s före korsningen.
- STALE_ETA_HARD (600 s) styr bara texten och eta-tokenen, inte deadlinen.
- Varningen uteblev för att ingen arm fanns: ingen målbro (M3). Med skiss C går
  Stridsbergsbron#1 13:47:54,060, deadline, eta 6.
- Gränsen 520–741 s i kortet stämmer med detta:
  - vid ett kortare avbrott hörs båten före korsningen;
  - vid ett längre blir glappet över bron längre än 900 s, och korsningen är då inte
    punktobserverbar i L1.

**F02-representanten (979): vad avgör att XENIA får en egen, sen varning?** Tre grindar samverkar:
1. **Smal täckning.** Vid absorptionen 08:43:32 låg hennes prognos inom #1:s fönster.
   `coverUntilMs` sattes till referensankomsten + 600 s, alltså 08:56:34,9.
2. **Ingen tidigare släppväg.** Bakkanten kräver att händelsen fått sin första passage
   (`passageKnown`, BOS:2301–2303). Docblocket säger uttryckligen att "en väntande ledare gör att
   följaren fortfarande hör till samma öppning (U2)" (BOS:2212–2214). FREJA väntade i 37 min, så
   bakkanten var stum. Räddningsventilen U9 (BOS:2054–2057, egen deadline) är avstängd
   (`lib/constants.js:1504`) och gäller dessutom bara bred täckning.
3. **Täckningsslut.** 08:56:34,937 dömer `_coverageVerdict` täckningsslut (BOS:2340). Hon låg
   154 m från bron, så under-bron-hållet (≤ 50 m) gäller inte. `_releaseCoveredArm` (BOS:2371)
   ger en egen händelse, och fireDueMs ur senaste fixet hade förfallit sedan länge (ursprungligen
   08:48:36). Varningen gick direkt, 50 s före korsningen.

Oraklet tar den senaste täckande varningen (`runOpeningGates.js:763–768`), så det är #2 (50 s) och
inte #1 (953 s) som avgör ledtiden.

**263, 290 och 313: vad hände utan täckning och vändning?**
- **263:** spärren vid Järnvägsbron räknar reservtiden på nuvarande fart, 2,1 kn. Båten
  accelererade till 4,4 kn efter bron under ett fixglapp på 272 s (M6).
- **290:** båten väntade vid Järnvägsbron. Avgången hördes först 164 s efter att den skett, på
  grund av radiomodellens stillaintervall (M9).
- **313:** en kö på 60 min i kajkapseln blev en kajliggare efter 15 min, armen dog, och avgången
  krävde två fix (M8).

**936 och 1918: kan returens egna varning komma tidigare utan att bryta U18?**
- Ja. Vändningen är bekräftad på andra positionen (936: 06:58:53, 1918: 09:11:39), men målbron
  och armen kom först vid tredje fixet.
- Med skiss A sätts målbron i bekräftelseticken. Varningen går då 06:58:53 i 936 (113 s ledtid i
  stället för 46 s) och 09:11:39 i 1918 (77 s i stället för 10 s). Två positioner krävs fortfarande.
- Motorns U18-post säger samma sak: "Fix D bekräftade vändningen 06:58:53, 113 s före korsningen
  (≥ 60 s): upptäckten var inte sen".

**790, 979 och 1139: vad hände?**
- **790 (K-NÄSTA-sann, restid 1,34):** båten hade en egen rad efter att händelsens passage blev
  känd, så hon var inte tyst. Raden 13:31:18 gav en restid som var 1,34 gånger tiden kvar till
  täckningsslutet. Bakkanten borde ha släppt henne, men läste appens ETA (golv 2,5 kn och
  outlierskydd) i stället för fysiken (M5).
- **979:** inte bakkanten (ledaren väntade, ingen passage) utan RECOVER vid täckningsslutet (M7).
- **1139:** RECOVER vid täckningsslutet för #5. Händelsen avfyrades på YRSA 2:s frusna fix, och
  YRSA 2:s passage bokfördes aldrig (M7).

## Mekanismer

### M1 NYRESA-SAMMA-TICK — APPFEL
- **Fynd:** 936 (F02), 1208 Klaff, 1208 Strid, 1316 och 1918 (F05/F02).
- **Rotorsak:** NEW_JOURNEY (`app.js:3148–3225`) bekräftar vändningen efter VDS:s målbrokedja, och
  målbron sätts först vid nästa fix (se 1208 ovan).
- **Rättning** (`T/skiss-NYRESA-SAMMA-TICK.diff`):
  - ny publik metod `VesselDataService.assignTargetAfterReversal(vessel, oldVessel, dir, reason)`
    med ACCELERATED-grenens grindar: `_shouldAssignTargetBridge(…, true)`,
    `_calculateTargetBridge(vessel, dir)`, `_lockRouteDirection` och `_extendJourneyOrigin`;
  - anropet görs i `app.js` direkt efter `_clearBoatNearTriggers(vessel, true)` (:3223), och
    borttagningstimern och ETA-historiken avbokas där;
  - en vakt avstår inom `UNDER_BRIDGE_CLEAR_DISTANCE` (70 m) från målbron. Utan vakten gav U14-vakten
    "vänder-bromsar-väntar-3m-tät-10s-i-1kn-brus-30m-ge-upp" (±30 m brus) en fantompassage och en
    extra varning (passager 2 → 3, öppningar 3 → 4). Med vakten är `replay:synthetic` bitlik.
- **Mätt:**
  - alla fem fynd BORTA (0 utslag i världen);
  - `replay:all` bitlik (24 av 24);
  - `replay:synthetic` bitlik;
  - `replay:openings` lika;
  - 26 riktade sviter (762 test) gröna.
- **Effekt per värld:**
  - 936: Klaffbron#9 06:58:53 (113 s);
  - 1918: Stridsbergsbron#9 09:11:39 (77 s);
  - 1208: Klaffbron#5 13:41:25 (74 s) och Stridsbergsbron#6 13:42:50 (632 s);
  - 1316: Stridsbergsbron#7 01:09:53 (196 s).

  Passagerna i 1208 och 1316 bokförs som målbropassager i stället för mållösa mellanbropassager,
  med samma notistext (källa target i stället för current).
- **Risk för de låsta korpusarna:** låg. Uppmätt noll ändrade rader: ingen NEW_JOURNEY i banken
  ändrade något utfall av att målbron sattes en tick tidigare.

### M2 RECROSS-TOMT-MÅL — APPFEL
- **Fynd:** 1274 (F02) och 1317 (F05).
- **Rotorsak:** se de särskilda frågorna (VDS:534/:719 → :7189–7196 → :6813–6826, medan VDS:761
  hoppas över).
- **Rättning** (`T/skiss-RECROSS-SAMMA-TICK.diff`):
  - `_confirmDirectionReversal` räknar bekräftelserna (`_reversalSeq`, `_lastReversal`);
  - efter målbrokedjan, före Anomali 11-blocket (VDS:957), anropas samma
    `assignTargetAfterReversal` när en vändning bekräftades INNE i kedjan och båten saknar målbro;
  - **B2:** i RE_CROSS-grenen ankras reseankaret i segmentets start (`oldVessel.lat`) i stället
    för i nuvarande läge.

  B2 behövs i 1317. Där låg korsningsfixet 8 m från linjen (`UNDER_BRIDGE_CROSS_AMBIGUOUS`), så
  tickens detektering bokförde inte återkorsningen. Med ankaret i nuet hoppade TARGET_END:s
  geometriska inferens över Järnvägsbron (`[INFERRED_PASSAGE_SKIP]`, VDS:5240), och returnotisen
  vid Järnvägsbron försvann. Med B2 är alla notiser i 1317 kvar. Den geometriska inferensen ger
  notisen (U14), men intermediatePassages-raden ersätts av `[INFERRED_PASSAGE]`.
- **Mätt:**
  - 1274 (även r2) och 1317 BORTA;
  - `replay:all`, `replay:synthetic` och `replay:openings` bitlika.
- **Effekt per värld:** 1274: Klaffbron#4 09:14:23 (389 s); 1317: Stridsbergsbron#6 12:33:26 (101 s).
- **Risk:** låg–medel. Inga ändrade rader i banken. B2 flyttar reseankaret för alla
  RE_CROSS-vändningar (origin-vakterna RC9 och S-F6). Granska därför `r1-usvang-*` och
  RC9-testerna (de är gröna).

### M3 ÅTERFÖDD-DÖDBAND — APPFEL
- **Fynd:** 756 (F05-representanten) och 1913. Därtill 977, som också försvinner.
- **Rotorsak:** en återfödd båts enda fix har kurs i dödbanden (46–134° eller 226–314°), och
  `_calculateTargetBridge` avstår (VDS:4645–4651). Ruttlåset ur svepet sätts senare i samma tick
  i app-lagret (`app.js:8676–8686`). Ingen målbro ger ingen arm, och ingen deadline i tystnad.
- **Rättning** (`T/skiss-ATERFODD-DODBAND.diff`): i ny-båtsgrenen (VDS:503–510) prövas, när
  målbron blir null och ruttlås saknas, `_rebirthDirectionEvidence(vessel)`. Det är K1-mätningen
  mot sist kända position från samma meddelande (VDS:265–295), med tre krav:
  - nettofart i längdled ≥ 2 kn (1,03 m/s);
  - rapporterad fart ≥ 2 kn;
  - kursen ligger inte i motsatt riktnings band.

  Uppfylls kraven låses riktningen och `_calculateTargetBridge(vessel, dir)` körs.
- **Mätt:**
  - 756, F05 och 1913 BORTA, och 977 BORTA på köpet;
  - `replay:all` bitlik;
  - `replay:synthetic` bitlik;
  - 34 sviter (690 test) gröna.
- **Första versionen förkastades:** med bara K1-ribban 0,25 m/s flyttade 20260713-41h tre
  golden-textrader. NORDIC SOLA vid Kanalinfarten (0,43 m/s) fick målbro 08:12:51, och två
  ETA-texter blev sämre mot rådata (08:23:57 "ETA okänd" i stället för "om cirka 7 minuter").
  Transitfartskravet tog bort det.
- **Effekt per värld:**
  - 756: Stridsbergsbron#1 13:47:54 (400 s);
  - 1913: Klaffbron#4 13:29:38 (659 s);
  - 977: Klaffbron#4 07:30:32 (522 s).
- **Risk:** låg–medel. Uppmätt noll rader. Åtgärden breddar F18 (ingen gissad målbro), men bara
  för positionsbevisad transit. BN2:s beslut (KAMPANJ.md, dirigentens R2-fråga 1) har samma
  princip.

### M4 BAKKANT-BOKFÖRINGSFÄRSKHET — APPFEL
- **Fynd:** 1094 och 1476 (F05).
- **Rotorsak:** `_coverageVerdict` kräver att armen tillämpat ett fix efter BOKFÖRINGEN av
  ledarens passage (BOS:2303). KRAV (2) i ARCHITECTURE.md:1848–1855 kräver färskhet mot
  KORSNINGEN. Bokförs ledarens passage sent (hon var tyst över bron) och tystnar följaren före
  bokföringen, får bakkanten aldrig döma. Följaren släpps vid täckningsslutet, efter sin korsning.
- **Rättning** (`T/skiss-BAKKANT-FARSKHET.diff`): `arm.lastSeenAt > event.firstPassageAt`, den
  skattade korsningen, i stället för `firstPassageRegisteredAt`.
- **Mätt:**
  - 1094 BORTA: egen Stridsbergsbron#4 11:42:05, 399 s före;
  - 1476 BORTA: hon täcks av DAGNYs öppning och blir KÄND_ÖPPEN J13-J14;
  - `replay:all`, `replay:synthetic` och `replay:openings` bitlika;
  - 30 öppningssviter (518 test) gröna.
- **Risk:** låg. Uppmätt noll ändringar i banken. Utfallet kan bara bli att en båt som ändå
  skulle släppas vid täckningsslutet släpps tidigare.

### M5 KRYP-PROGNOS — APPFEL
- **Fynd:** 790 (F02) och 1794 (F08).
- **Rotorsak:** bakkanten läser appens ETA (BOS:1296, :2312). ETA-kedjan räknar med minst 2,5 kn
  efter en passage (`ProgressiveETACalculator.js:787–790`) och håller emot hopp uppåt (:1289).
  För en krypare i 0,9–1,3 kn ligger prognosen minuter för tidigt, inom U2-fönstret.
- **Rättning** (`T/skiss-KRYP-FYSIK.diff`):
  - `_refreshArm` sparar `arm.physicsArrivalMs` = ankare + d/sog, men bara när
    0,5 kn < sog < 2,5 kn, där golvet binder;
  - bakkanten jämför `max(expectedArrivalMs, physicsArrivalMs)` med fönsterslutet;
  - ETA-texten och eta-tokenen rörs inte (U22).
- **Mätt:**
  - 790, 1794 och F08 BORTA;
  - `replay:all` och `replay:synthetic` bitlika;
  - 30 öppningssviter gröna.
- **Effekt per värld:** 790: Stridsbergsbron#11 13:28:30 (580 s). I 1794 täcks hon av JOLLYs #5,
  och JOLLY korsar 17 s efter henne.
- **Mätt och förkastat:** den breda varianten utan fartgräns fällde 7 test i
  `opening-convoy-release-scheduling.test.js`. Testernas fixturer har sog 3 och eta 1,5 min vid
  300 m, alltså inkonsistenta.
- **Risk:** låg–medel. `replay:openings` visar en ändring. 20260804-17h PILLE (211488730)
  Stridsbergsbron#22 går 11:29:38 (fix, eta 2) i stället för 11:33:56 (deadline, eta 0).
  Rådatafacit ger korsningsfönstret 11:49:08–12:04:08 (inferred), så båda varningarna ligger
  mer än 15 min före. Bedömningen är likvärdig. Ingen låst rad flyttas.

### M6 SPÄRR-I-RÖRELSE — ÄGARBESLUT
- **Fynd:** 263 (F02).
- **Rotorsak:** spärren vid en tidigare bro (införd i a8d7b76, "Förhindra för tidiga
  öppningsvarningar vid tidigare broar") ersätter 10-knopsdeadlinen med restid i nuvarande fart
  − 180 s (BOS:1311–1316). För en båt som passerat broar räknas varje opasserad bro emellan som
  tidigare bro (BOS:626). Accelererar båten efter Järnvägsbron under ett fixglapp, krymper
  ledtiden.
- **Mätt rättning** (`T/skiss-SPARR-RORELSE.diff`: `FIRE_EXPECTED_ETA_MS`, 300 s, i stället för
  `WARNING_LEAD_MS`): 263 blir BORTA, men GOLDEN-EVENTS flyttar i tio låsta korpusar: 21h, 16h,
  25h, both-21h, 42h (+1 varning, Klaffbron söderut 19 mot facit 18), 24h, 80h, 0917-7h, 0917-16h
  och 0918-7h. Varningarna kommer tidigare, men rådata kan inte visa att det är rättare (U13).
- **Fråga till ägaren:** När en båt är på väg mot Stridsbergsbron men först ska förbi
  Järnvägsbron, vet appen inte om hon kommer att stanna och vänta vid Järnvägsbron. I dag varnar
  appen ungefär 3 minuter före den ankomst som båtens nuvarande fart ger. Det gör att appen inte
  varnar i onödan för båtar som sedan blir stående länge vid Järnvägsbron. Men en båt som ökar
  farten efter Järnvägsbron, medan appen inte hör henne, kan få varningen mindre än en minut i
  förväg (värld 263: 44 s). Vill du:
  - **(a)** behålla dagens avvägning och godta enstaka sena varningar i det här läget? Motorn får
    då en registerpost.
  - **(b)** varna ungefär 5 minuter före båtens beräknade ankomst, som appen gör annars? Då blir
    varningarna längre i förväg, men fler kommer innan båten stannar vid Järnvägsbron. Tio låsta
    körningar får ändrade varningstider, och en får en varning till.
  - **(c)** låta appen pröva en mer försiktig fart bara när den inte har hört båten på en stund?
    Det kräver en ny, mätt design.
- **Registerpost vid (a):** "SPÄRR-JVB-ACCELERATION", KÄND_ÖPPEN:
  - orakel T2 LEDTID;
  - predikat: båten passerade en tidigare bro, varningen avfyrades vid spärrens slut (deadline,
    fireDue = ankare + d/sog − 180 s ± 1 s), och farten vid korsningen ≥ 1,5 × farten i sista
    fixet;
  - källa: BOS:1303–1316 och a8d7b76.
- **Risk:** hög vid (b).

### M7 TÄCKNINGSSLUT-UTAN-PASSAGE — ÄGARBESLUT (C-IV)
- **Fynd:** 979 (F02-representanten) och 1139 (F02).
- **Rotorsak:** en båt täcks av en äldre händelse som ännu inte har någon bokförd passage. I 979
  väntar ledaren i kö i 37 min. I 1139 korsade ledaren osedd, och händelsen avfyrades på hennes
  frusna fix.
  - Bakkanten gäller bara efter första passagen (BOS:2212–2214, :2301–2303).
  - U9 är avstängd (`lib/constants.js:1504`).
  - Enda utgången är täckningsslutet (BOS:2340). RECOVER-släppet avfyrar då på en sedan länge
    förfallen deadline: 50 s och 41 s före korsningen.
  - Släppet bygger på premissen att "öppningen hon knöts till passerat utan henne"
    (ARCHITECTURE.md:809–811). Den håller inte när händelsen saknar passage.
  - Utfallet bryter både mot U2 (det är en andrapåminnelse) och mot garantin (varningen kommer sent).
- **Fråga till ägaren:** En båt räknas till en öppning som en annan båt redan har fått varning
  för. Den andra båten har ännu inte passerat; hon väntar vid bron, eller appen har tappat henne.
  Den första båten kommer fram efter den tid appen räknade med för öppningen. I dag får hon då en
  egen varning först när den tiden har gått, ibland under en minut före passagen (värld 979: 50 s,
  värld 1139: 41 s). Vill du:
  - **(a)** att hon räknas till den gemensamma öppningen tills någon faktiskt passerar? Hon får då
    ingen egen varning. Den första varningen kom 11–16 min före (U2, väg a i C-IV).
  - **(b)** att hon får en egen varning så fort hennes egen tidsfrist går ut och appens prognos
    visar att hon inte hinner med den gemensamma öppningen? Varningen kommer då 4–10 min före,
    men det blir en andra varning för samma bro (väg b, smal; jämför U9).
  - **(c)** att behålla dagens beteende?

  Både (a) och (b) tar bort fynden. (c) är sämre än båda. Om du väljer (a) eller (c) behövs en
  registerpost.
- **Registerpost vid (a) eller (c):** utvidga U2-VS-DEADLINE, eller lägg till
  "U2-VS-DEADLINE-OPASSERAD" (KÄND_ÖPPEN):
  - orakel T2 LEDTID|OKLASSAD;
  - predikat: båten absorberades i E före korsningen, E:s varning kom ≥ 60 s före korsningen, E
    saknade bokförd passage (`openingCoverage` och `targetPassages` i resultatet) vid båtens
    korsning, och fyndets varning är RECOVER vid E:s täckningsslut;
  - källa: etapp7-plan:310–349 (C-IV), BOS:2212–2214 och :2340.
- **Risk:** (a) flyttar konvojfacit (C8 kostade sex ovarnade öppningar, etapp7-plan:333–337).
  (b) kan ge andrapåminnelser i äkta konvojer (U9-mätningen, `lib/constants.js:1467–1503`).
  Båda kräver O1/O2-mätning och U13.

### M8 KÖ-I-KAJKAPSELN — ÄGARBESLUT (D1-familjen)
- **Fynd:** 313 (F02).
- **Rotorsak:** kajkapseln "Kajen norr om Klaffbron" ligger 190–295 m från bron, inne i
  väntzonen. Kön (fältets köplatser 221–307 m) klassas som förtöjning efter 15 min
  (`lib/constants.js:421–434`, VDS:3683). Då rensas målbron (VDS:323–330) och armen dör efter
  30 min (BOS:1636–1641). Avgången blir en ny ankomst som kräver ≥ 50 m netto (VDS:4104–4135,
  `app.js:1535`). Den nya varningen kommer 82 m från bron, och oraklet läser den i stället för
  den första, som kom 66 min före.
- **Fråga till ägaren:** En båt ligger stilla i mer än 15 minuter vid kajen 190–300 m norr om
  Klaffbron. Det är också där båtar köar inför broöppning. I dag tror appen efter 15 minuter att
  hon har lagt till, och glömmer hennes varning. När hon sedan kör mot bron behöver appen två
  positioner för att tro på avgången, så den nya varningen kan komma under en minut före
  passagen (värld 313: 32 s). Vill du:
  - **(a)** att en båt som kom farleden fram med Klaffbron som mål räknas som köande, hur länge
    hon än ligger? Hon får då ingen ny varning när hon kör; den första gäller.
  - **(b)** att behålla regeln, men låta appen tro på avgången redan vid första positionen i
    minst 2 kn mot bron? Det ger ungefär 1,5 min förvarning här, men risk för falsklarm från
    kajliggare som guppar.
  - **(c)** att behålla dagens beteende och godta att avgångar från kajen så nära bron får kort
    förvarning?

  Frågan hör ihop med den öppna D1-KAJZON-DEMOTION.
- **Registerpost vid (c):** "KAJKAPSEL-AVGÅNG-NÄRA-BRO" (DESIGN eller KÄND_ÖPPEN):
  - orakel T2 LEDTID;
  - predikat: båtens L0-stopp ligger i en MOORING_ZONE med queueGraceMs > 0, stoppet > queueGraceMs,
    och fyndets varning är en OPENING_QUAY_DEPARTURE-arm (fix-avfyrad, första rörelsefix + 1);
  - källa: `lib/constants.js:415–436` och QUAY_DEPARTURE_GATE.
- **Risk:** (a) och (b) rör kajzonsregeln, som är användarverifierad 2026-06-10 och har
  korpusfacit (ELFKUNGEN, NANNA). De kräver `replay:all` och U13.

### M9 AVGÅNG-I-STILLAINTERVALL — MOTORFEL (radiomodellen)
- **Fynd:** 290 (F02) och 625 (F05).
- **Felet i motorn:** `tests/replay-validation/bugHunt/lib/radio.js:225–227`
  (`interval(feed, moving)`), :244 (aisstream, `tS += interval('aisstream', moving)`) och :271
  (AISHub, `due = fixS + interval('aishub', moving)`). Nästa fix dras ur rörelsetillståndet VID
  det föregående fixet. En båt som lämnar kön strax efter ett stillafix hörs därför först när
  stillaintervallet har löpt ut:
  - 290: 164 s efter avgången, med 224 s kvar till korsningen. Ledtiden blir 46 s.
  - 625: 11,6 min tystnad. Avgången kom 4 s efter stillafixet, och korsningen 242 s efter.

  BUGGJAKT §4.5 (rad 175) beskriver gränsen ("en verklig transponder byter takt direkt"). Den ger
  ändå kandidatkort. En verklig klass A sänder var 10:e s vid 0–14 kn, och klass B CS var 30:e s
  över 2 kn.
- **Appens del:** med de observationer appen fick var det ogörligt att varna i tid. Spärren vid
  Järnvägsbron ger väntande båtar en reserv på 300 s (BOS:1311–1315), och den hinner inte före
  restiden kö → Strid (224–242 s).
- **Rättning i motorn:** dra om nästa fixtid när L0-banan byter från stilla till rörelse före den
  dragna tiden, så att tiden blir avgången + `interval(feed, true)`, i båda erorna. Det ändrar
  R1-världarnas rader och därmed fingeravtrycken, så självtestets kalibrering och realismtabellen
  måste köras om.
- **Interimistisk registerpost**, om motorn inte rättas nu: "MÄTGRÄNS-AVGÅNG-I-STILLAINTERVALL"
  (MÄTGRÄNS):
  - orakel T2 LEDTID|OKLASSAD;
  - predikat: båtens sista rad före L0-avgången var stilla (L0 v = 0), och första raden efter
    avgången kom senare än korsningen − 60 s;
  - källa: BUGGJAKT.md §4.5 och `radio.js#observeWorld`.

### M10 U2-FÖNSTERKANT — MÄTGRÄNS
- **Fynd:** 510 och 977 (F05).
- **Siffror:**
  - **510:** korsningen kom 605 s efter händelsens första passage, alltså 4 s utanför fönstret.
    Varje egen rad mellan VEGAs korsning och korsningen − 60 s gav en fysisk ankomst inom fönstret.
    Den senaste var 16:07:12, ur fixet 16:06:19 (102 m, 2,9 kn), och appens prognos var 16:07:46.
    Krypet i 1,4 kn började efter sista fixet. En varning ≥ 60 s före hade behövt beslutas
    senast 16:07:20, och då pekade alla data in i fönstret.
  - **977:** korsningen kom 615 s efter, alltså 14 s utanför. Ledarens passage bokfördes
    07:39:43, 29 s EFTER följarens korsning. Före det hör följaren till händelsen (U2), och
    bakkanten kan inte döma. Appens skattning av ledarens korsning (07:29:21, 21 s sen) gav
    dessutom fönsterslutet 07:39:21, och PELLEs prognos 07:39:17 låg innanför det.
- **Registerpost:** "MÄTGRÄNS-U2-FÖNSTERKANT" (MÄTGRÄNS):
  - orakel T2 OKLASSAD|LEDTID;
  - predikat `u2Fönsterkant(600 s, 30 s, 60 s)`: korsningen ligger inom (600; 630] s efter
    händelsen E:s första sanna passage, båten var absorberad i E före korsningen, E:s varning kom
    före korsningen, och något av följande gäller:
    - (i) E:s första passage bokfördes av appen senare än korsningen − 60 s;
    - (ii) båten har minst en egen rad mellan E:s första sanna passage och korsningen − 60 s, och
      varje sådan rad ger fysisk ankomst (avstånd/sog från fixTs) ≤ E:s första passage + 600 s.
  - källa: etapp7-plan:9 (U2), :310–349 (C-IV), `BridgeOpeningService.js#_coverageVerdict`
    (bakkanten) och `konvoj.js#inomHändelsefönster`.
- **Prövning av predikatet:**
  - 510 och 977 matchar.
  - 1094, 1476 och 1794 matchar inte: en rad gav ankomst bortom fönstret (11:49:10, 12:03:36
    respektive 10:20:24), och de är APPFEL.
  - 790 ligger 707 s efter, utanför bandet.

## Skisser och mätningar

| Skiss | Fynd BORTA | replay:all | replay:synthetic | replay:openings | jest |
|---|---|---|---|---|---|
| A NYRESA-SAMMA-TICK | 936, 1208 ×2, 1316, 1918 | bitlik | bitlik (med 70 m-vakten) | lika | 762/762 (26 sviter) |
| B RECROSS-SAMMA-TICK (+B2) | 1274, 1317 | bitlik | bitlik | lika | 762/762 |
| C ÅTERFÖDD-DÖDBAND | 756, 1913 (+977) | bitlik | bitlik | lika | 690/690 (34 sviter) |
| D BAKKANT-FÄRSKHET | 1094, 1476 (→ J13) | bitlik | bitlik | lika | 518/518 (30 sviter) |
| E KRYP-FYSIK | 790, 1794 | bitlik | bitlik | 17h: 1 varning 258 s tidigare | 518/518 |
| A+B+C+D+E (`skiss-ALLA-APPFEL.diff`) | 14 av 21 | bitlik | bitlik | som E | 5264/5264 (hela) |
| F SPÄRR-RÖRELSE (förkastad) | 263 | 10 korpusar flyttar | – | – | – |

Baslinjens mätloggar och varje skiss mätloggar finns i T/matningar. KVAR/BORTA per kort finns i
T/repro (`repro-alla.tsv` för den sammanslagna skissen).

## Rekommenderad ordning

1. **M1 + M2** (skiss A+B, `T/skiss-SAMMA-TICK-A+B.diff`):
   - tar bort 7 fynd (5 F05, 2 F02);
   - noll facitrörelse och liten kodyta, en gemensam metod;
   - regressionstest: 936-, 1208- och 1317-mönstret som syntetiska scenarier med gles AIS, och
     U14-brusvakten som negativtest för 70 m-vakten.
2. **M4** (skiss D):
   - en rad, noll facitrörelse;
   - för 1094 och 1476 krävs bara att KRAV (2) läses som det står.
3. **M3** (skiss C):
   - noll rader med transitfartskravet;
   - granska mot F18 och FP8 och lägg F05-representanten och 1913 som regressionstest.
4. **M5** (skiss E, fartgränsen < 2,5 kn):
   - redovisa PILLE-raden i 17h enligt U13 som likvärdig; ingen låst rad;
   - rätta fixturerna i `opening-convoy-release-scheduling.test.js` bara om den breda varianten
     väljs.
5. **Ägarfrågorna:**
   - M7 (C-IV, 979/1139), M8 (D1, 313) och M6 (Järnvägsbrons spärr, 263) presenteras tillsammans
     med de öppna konvojfrågorna (beslutsfråga 5–6 i triagedokumentet);
   - M7 är viktigast, eftersom det är kortets representant.
6. **Motorn:**
   - M9: rätta radiomodellen (eller lägg den interimistiska posten);
   - M10: lägg MÄTGRÄNS-U2-FÖNSTERKANT;
   - kör sedan `npm run hunt` och kontrollera att 290, 625, 510 och 977 blir mätgräns eller
     försvinner, och att inga nya kort uppstår.
