# SAMMANSLAGNING.md — familj E (andra revisionen) och familj E2 till ett ETA-patch

Datum: 2026-11-07. K = `/tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad/kampanj`.

- **Worktree:** `K/E2/mwt`, skapad med `git worktree add --detach` från E2:s
  senaste commit `66bb985`. Motorn är kopierad från `K/E2/wt` (otrackad
  `tests/replay-validation/bugHunt/`), och `node_modules` är en symlänk till
  huvudträdets.
- **Leverans:** `K/E2/patch-ETA.diff` = `git diff 7699cbe HEAD` utan `bugHunt/`
  och `node_modules`, 49 filer. `git apply --check` går igenom på en ren export
  av 7699cbe, och den applicerade patchen ger byte-lika filer med mwt. Fillistan
  är densamma som i E2:s tidigare `K/E2/patch.diff`.
- **Facit:** `K/E2/FACIT.md`, nytt inledande avsnitt "Sammanslagningen E + E2".
- **Mätningar och verktyg:** `K/E2/matningar/sammanslagning/`.

## 0. Kort sagt

E:s andra revision (golvet som följer accelerationen, mjukt släpp, fem minuter,
V4 med vakt) ligger nu ovanpå E2-revisionen (en beräkning per AIS-fix, F06, F07,
mötande konvoj mot tyst motpart).

**Konflikter.** Bara två kodkonflikter fanns, båda i
`_processETAWithProtection`, och en notkonflikt i `corpora.js`. Två test
behövde ändras för E2:s vikt 0,64, och ett nytt test vaktar ögonblicksbilden av
avgången.

**Bankens utfall är identiskt med E2-revisionen:**
- alla 3 110 mätta och omätta påståenden har samma publicerade värde;
- replay:all, synthetic, openings, monitoring, fassvepet, hunt --repro och quick
  ger samma utskrift.

E:s andra revision ändrar alltså inget i banken när E2 redan ligger där.
Skälet är att bankens enda avgång under 2 kn, PRIMA LADY, ger "om 4" med båda
golven (3,6 och 4 kn). E:s bidrag syns i E:s regressionstest (platåklassen,
V4), där E2 ensam fäller 16 av 34.

**Mot 7699cbe (hela patchen):**
- de parade banden < 5 och < 10 min är lika eller bättre i median och andel
  ≤ 2 min i alla typer;
- de sex raderna från E är rättare;
- F04, F06 och F07 är BORTA i motorn;
- LINNEA, 41h-svängningarna, SISU och IDUN är oförändrade.

**Kvar är E2:s ägarfråga (U13):** 21 låsta rader i bandet < 10 min blir
sämre, mot 61 rättare. Dessutom står 20260917-7h kvar, som inte kan låsas om.

## 1. Commits i `K/E2/mwt`

| Commit | Innehåll |
|---|---|
| `66bb985` och bakåt | E2-revisionen (på e949ae1, E:s första revision) |
| `928daf4` | cherry-pick av E:s `5febba0` (koden och regressionstestet), konflikter lösta (§2) |
| `6a293be` | cherry-pick av E:s `5b9ea15` (DEMO-omlåsning av 24h idx 65), konflikt i 24h-noten löst |
| `ca1272c` | cherry-pick av E:s `f3a2d46` (dokumentationen), automatiskt sammanslagen |
| `a53dd18` | V4-testen följer E2:s vikt; nytt test för omräknad avgång |
| `f3498bc` | dokumenten efter sammanslagningen, 24h-noten, kommentaren vid `_increaseHoldStreak` |
| `dc35066` | golvbeskrivningen i ARCHITECTURE och VALIDATION (E-granskningens låga punkt 1), se §8 |
| `57808cb` | E:s platåsvit ommätt, tabell i VALIDATION "Sammanslagningen E + E2" (§6) |

Inget är pushat, och inga andra worktrees är rörda.

## 2. Konflikterna och hur de löstes

**(a) Två olika `measuredETA` i `_processETAWithProtection`.**
- E2 inför `const measuredETA = rawETA`, fixets rå-ETA, som outliergrinden bär
  i historiken: `measuredETA` och `heldDecrease`, där två fix i följd
  bekräftar ett fall.
- E inför `const measuredETA = departureMeasuredETA ?? rawETA`, samplets egen
  mätning utan avgångsgolvets antagande, som V4-vakten läser.
- Det är två olika storheter. E:s heter nu `ownMeasuredETA`, och E2:s behåller
  namnet. Historikposten bär E2:s `measuredETA` som förut.
- De skiljer sig bara när avgångsgolvet bestämde farten. E2:s bekräftelse av
  fall räknar alltså på samma rå-ETA som på E2-revisionen.

**(b) EMA-raden.** Vikten kommer från E2 och basen från E:

```js
const alpha = this._inGapStep ? GAP_BASELINE_ALPHA : this._emaAlpha;
const emaBase = (Number.isFinite(lastEntry.m9UnheldETA)
  && Number.isFinite(ownMeasuredETA) && ownMeasuredETA < STRAX_THRESHOLD_MINUTES)
  ? lastEntry.m9UnheldETA
  : lastEntry.processedETA;
smoothedETA = alpha * protectedETA + (1 - alpha) * emaBase;
```

I glappsteget är `lastEntry` glappbaslinjen. Hölls den av M9 och lovar den
färska skattningen strax, räknar EMA:n från det ohållna värdet, som V4 kräver.

**(c) 24h-noten i `corpora.js`.** E2:s DEMO-rubrik behölls före E:s nya stycke
("om 7" → "om 4"). Efter mätningen fick noten ett inledande stycke om
sammanslagningen: idx 65 är 7 → 4 mot 7699cbe och rättare.

Resten slogs ihop automatiskt och är kontrollerat:
- M9-blocket med `m9UnheldETA` står bredvid E2:s inbromsningsregel;
- E:s golvkod i `_getEffectiveSpeed` står före E2:s `_decelRatio`;
- `_departures` ingår i E2:s ögonblicksbild.

## 3. E:s fem sammanslagningspunkter (E:s DESIGN §10)

1. **EMA-raden:** löst enligt §2 (b).
2. **M9 bredvid E2:s decel-strax:**
   - `m9UnheldETA` sätts bara av avgångens M9.
   - Inbromsningsregeln kräver `adjustedETA < 3`, så den kan inte hålla ett
     värde som M9 redan har hållit på 3.
   - `straxAlreadyGiven` läser det hållna `processedETA` (3,0), alltså inte
     "strax redan given".
   - Inbromsningsregeln sätter inget ohållet värde, eftersom medelfarten är en
     mätning (kommentaren vid EMA-raden säger det).
3. **`_decelRatio` läser `minRouteSpeed`, som kan vara golvet:**
   - när golvet binder är `minRouteSpeed = floorKn > baseSpeed`, så villkoret
     `baseSpeed > minRouteSpeed` är falskt och kvoten raderas;
   - avgångsgolvet och inbromsningsregeln utesluter alltså varandra i samma
     sampel;
   - inbromsning mer än bruset avslutar dessutom avgångskontexten;
   - banken är identisk med E2-revisionen, så inget påstående rörs.
4. **Gap-resetens buffert:**
   - avgången prövas i `_computeRawETA`, före glappreseten i
     `_processETAWithProtection`;
   - bufferten efter reseten är fixets eget sampel i båda träden: på 7699cbe
     genom pass 2:s omräkning, i E2 direkt;
   - den kvarvarande klassen är ommätt med E-granskarens krok (`rhook.js`,
     RH_LEAN=1) och E:s `restklass.py`. Det är samma 87 sampel i samma åtta
     mekanismer, med identiskt medlemskap (§6).
5. **Ögonblicksbilden:**
   - `_captureFixState` och `_restoreFixState` kopierar posten med spread, och
     E:s nya fält är primitiva;
   - det nya testet "en omräknad fix (ändrat läge) för avgången vidare en gång,
     inte två" kör en avgång, sedan ett stigande sampel med statusbyte mellan
     passen (`[ETA_FIX_RECOMPUTE]`), och kräver `samples` 2, `released` false
     och `floorKn` 3,2;
   - mutationsprov: testet är grönt utan E:s `lastKey`-dedup och grönt utan
     E2:s återställning av `_departures`, men rött utan båda. Två oberoende
     skydd bär alltså.

## 4. Testen

**Ändrade test i `tests/e-avgangs-eta-2026-11-04.test.js`.** De två V4-testen
räknade med vikten 0,4 och läser nu `calc._emaAlpha` (0,64):
- *Det första* kräver EMA från det ohållna 2,6 (2,17), inte från det hållna 3,0
  (2,31).
- *Det andra* behövde en ny mätning. Med 0,64 ger E:s exempel 3,4 inte längre
  strax utan vakt: 0,64 × 3,4 + 0,36 × 2,6 = 3,11. Testet använder därför 3,2,
  där vakten fortfarande avgör: 3,13 från det hållna värdet och 2,98 (strax)
  från det ohållna. Testet kräver nu också uttryckligen att varianten utan vakt
  hade gett strax.

**Regressionstesten mot gamla träd** (`matningar/sammanslagning/regressionstest-gamla-trad.txt`).
De tre testfilerna från mwt kördes på `git archive`-exporter. Värdena är röda
av totalt:

| Träd | e-avgangs-eta (34) | e2-eta-etapp (17) | e2-revision (20) |
|---|---|---|---|
| 7699cbe | 27 | 12 | 16 |
| e949ae1 (E:s första revision) | 16 | 12 | 16 |
| f3a2d46 (E:s andra revision, utan E2) | 1 (bara sammanslagningstestet) | 12 | 16 |
| 66bb985 (E2-revisionen, utan E:s andra) | 16 (platåtesten, V4, golvet, sammanslagningstestet) | 0 | 0 |
| sammanslagningen | 0 | 0 | 0 |

## 5. Batteriet

Allt kördes i mwt med TMPDIR i `K/E2/tmp/merge/tmpdir`. Loggarna ligger i
`matningar/sammanslagning/batteri/`.

| Steg | Utfall |
|---|---|
| `npm test` (a53dd18) | 4 846 gröna, 2 hoppade, 1 röd (bugHunt `b-register`, "docs/BUGGJAKT.md finns inte" — lika röd på E2 och 7699cbe). 4 849 = E2:s 4 838 + 11 nya test i E:s fil. |
| `npm test` (`f3498bc`) | 4 846 gröna, 2 hoppade, 1 röd (samma `b-register`). `dc35066` och `57808cb` ändrar bara ARCHITECTURE och VALIDATION. Inget test läser dem (bara kommentarer nämner dem), och de dokumentnämnande sviterna samt familjetesten är gröna på `dc35066` (98 gröna, 2 hoppade). replay:all och lint är också körda på `f3498bc`, med samma utfall. |
| `replay:all` | 23/24 gröna; 20260917-7h REGRESSION (GOLDEN-TEXT 68 ≠ 69, ofullständig fångst) som på E2-revisionen. Normaliserad utskrift identisk med E2:s. |
| `replay:synthetic` | alla rena, identisk med E2:s |
| `replay:openings` | exit 0, identisk med E2:s (täckning 392/447, TIDPUNKT_OKÄND 37) |
| `replay:monitoring` och `runSoak` | stabila, identiska med E2:s utom `heapUsedMB`; mot E (7699cbe) 761 → 760 textövergångar i soaken, en ändring som kom med E2 |
| `replay:phase`, hela banken | OK, 24 korpusar, 168 replays, identisk med E2:s |
| `REPLAY_MONITORING=1 replay:phase` på 41h-0601, 24h, 31h, 25h och 21h | GRÖNT, 6 varianter per korpus |
| `npm run lint` | rent |

## 6. measure:eta mot 7699cbe (acceptansen)

Mätningen följer REGELN (VALIDATION §ETA-mätharnessen):
- *Baslinje:* E:s `K/E/tmp/rev/eta-base`, 7699cbe, med 0 oattribuerade. E2:s
  egen 7699cbe-körning hade ett oattribuerat påstående och ger därför n 775 och
  1 273.
- *Körningar:* två på sammanslagningen, med identiska påståenden och 0
  oattribuerade. Lastsnittet var 5–8, eftersom andra familjer körde samtidigt.
- *Definition:* status `mätt` (linjefacit), parning per korpus, typ, bro och
  mmsi inom 2 s, och sanningen i bandet på båda sidor
  (`verktyg/jamfor.py`).

Värdena är median · andel ≤ 2 min · bias:

| Band | Typ | Population | 7699cbe | E + E2 |
|---|---|---|---|---|
| < 5 min | alla | parad, n = 776 | 0,47 · 88,8 % · +0,51 | 0,45 · 90,5 % · +0,44 |
| < 5 min | brotext | parad, n = 244 | 0,88 · 81,6 % · +0,96 | 0,87 · 82,4 % · +0,91 |
| < 5 min | notis | parad, n = 500 | 0,38 · 93,6 % · +0,26 | 0,34 · 94,6 % · +0,21 |
| < 5 min | öppningskort | parad, n = 32 | 1,03 · 68,8 % · +0,96 | 0,98 · 87,5 % · +0,52 |
| < 10 min | alla | parad, n = 1 274 | 0,71 · 81,2 % · +0,17 | 0,67 · 82,3 % · +0,11 |
| < 10 min | brotext | parad, n = 643 | 1,01 · 75,6 % · +0,25 | 1,00 · 76,0 % · +0,23 |
| < 10 min | notis | parad, n = 526 | 0,39 · 90,1 % · +0,07 | 0,38 · 90,9 % · +0,02 |
| < 10 min | öppningskort | parad, n = 105 | 1,04 · 71,4 % · +0,18 | 1,02 · 78,1 % · −0,15 |
| < 5 min | alla | oparad | n = 8: 0,42 · 100 % · +0,49 | n = 11: 0,46 · 81,8 % · +0,38 |
| < 10 min | alla | oparad | n = 21: 0,66 · 76,2 % · +1,08 | n = 22: 0,84 · 81,8 % · −0,37 |

**Ändrade påståenden mot 7699cbe:**
- 158 ändras: 66 bättre, 45 sämre, 1 lika och 46 omätta.
- I bandet < 10 min är 59 bättre, 21 sämre och 1 lika; i bandet < 5 min 41,
  11 och 1.
- Brotextövergångarna går 2 544 → 2 547, öppningsvarningarna 431 → 432 och
  notiserna 1 341 → 1 341.
- Strax-löftet går från n 211 och 63,0 % inom 3 min till n 208 och 63,9 %.

**Mot E2-revisionen** (granskarens `eta-rwt2`, 0 oattribuerade):
- 3 110 av 3 110 påståenden parar, och 0 ändrar publicerat värde;
- det enda fältet som skiljer är PRIMA LADYs `leadEta` 16:34:01, 3,54 → 3,75.

**Mot E:s andra revision** (`K/E/tmp/rev3/bank/wt-full`): 152 påståenden
ändras (60 bättre, 45 sämre, 1 lika, 46 omätta). Det är E2:s ändringar, och de
redovisas i E2:s FACIT.

**Mot e949ae1:** samma tal som E2-revisionen. Med en enda definition är det
< 10 min 54 bättre, 22 sämre och 1 lika, och < 5 min 36, 12 och 1. Det är
granskarens tal, och de står nu i VALIDATION "Familj E2".

**Acceptansfallen** (`namngivna-fall.txt`), mot 7699cbe:
- *LINNEA 265764760:* 24 påståenden. Klaffbronsraderna är oförändrade ("om 4"
  mot 4,76). Stridsbergsbron 09:36:30 går 13 → 14 mot 19,3 min (inferred), som
  i E2.
- *41h-svängningarna:* uppstegen på minst 5 min inom 3 min i 41h-korpusarnas
  brotext är desamma (LAMANTIJN 25 → 35, NORDIC SOLA 8 → 14, LINNEA 2 → 7).
  NORDIC SOLA 08:4x är oförändrad.
- *SISU (21h, 10 påståenden) och IDUN (25h, 8):* oförändrade.
- *E:s sex rader:* SKONNERTEN 8 → 3 (sanning 2,1), PRIMA LADY 7 → 4 (3,1),
  PRIMA LADYs notis och kort 5 → 3 (1,9) samt OLAs notis och kort 4 → 1 (1,3).
  Felet blir mindre i alla sex.
- *M9-priset:* SKONNERTENs notis 07:30:52 är 2 mot 1,4, som på 7699cbe. E:s V4
  och E2:s enda EMA per fix bär båda.
- *AVALON (21h):* "om 18" 07:11:30 mot 4,5 blir "om 12" från 07:07:13.

**Den kvarvarande klassen, ommätt** (`kvarvarande-klassen-sammanslagning*.txt`):
- Det är samma 87 sampel i samma mekanismer, med identiskt medlemskap mot E:s
  `kvarvarande-klassen-alla.txt`.
- Fallen med minst +3 min går från 12 till 13:
  - TINY faller bort;
  - UTOPIA går +6,9 → +3,9 och ANDREA +4,4 → +3,4;
  - PILOT 761 06:11:19 (notis 5 mot 1,4) och ORCA 13:56:15 (notis 6 mot 2,2)
    tillkommer. Båda är E2:s FP9-rader, som redan står i ägarfrågan.

**E:s platåsvit, ommätt** (`platå.js`, 208 syntetiska avgångar, fyra träd i
samma körning; `platåklassen-tabell.txt`, `platåklassen-jmf.txt`). Sviten
återskapar E:s tal exakt på 7699cbe och f3a2d46. Kolumnerna är 7699cbe → E:s
andra revision → E2-revisionen → E + E2:

| Klass | Mått | 7699cbe | E:s andra | E2 | E + E2 |
|---|---|---|---|---|---|
| platå | tidsviktat < 5 min | 1,03 · 87,9 % · +1,07 | 0,76 · 98,9 % · +0,64 | 0,67 · 99,9 % · +0,09 | 0,81 · 98,6 % · +0,71 |
| platå | påståenden < 10 min | 0,67 · 94,4 % · +0,49 | 0,47 · 97,5 % · +0,11 | 0,56 · 92,1 % · −0,36 | 0,45 · 98,6 % · +0,10 |
| platå | uppsteg (fall/antal/≥ 2) | 39/46/27 | 36/48/13 | 46/80/11 | 33/44/11 |
| platå | grovt optimistiska sampel (≥ 2 min, sanning < 10) | 0 | 23 | 124 | 13 |
| kontroll | tidsviktat < 5 min | 2,08 · 46,2 % · +2,13 | 1,33 · 72,4 % · +1,57 | 1,01 · 80,4 % · +1,29 | 1,46 · 68,4 % · +1,64 |
| kö | tidsviktat < 5 min | 1,58 · 60,3 % · +2,15 | 1,25 · 72,7 % · +1,73 | 0,90 · 92,6 % · +0,91 | 1,25 · 72,7 % · +2,32 |
| kö | uppsteg | 7/9/6 | 7/9/3 | 5/5/2 | 7/13/4 |
| inbromsning | påståenden < 10 min | 0,96 · 80,0 % · −0,78 | 1,30 · 70,4 % · −1,40 | 1,77 · 61,5 % · −1,68 | 1,52 · 61,5 % · −1,53 |

- *Platåklassen* (E:s acceptansklass) blir bättre än E ensam i påståenden,
  uppsteg och grovt optimistiska sampel (23 → 13).
- Det tidsviktade bandet < 5 min blir något sämre (median 0,76 → 0,81, andel
  98,9 → 98,6 %).
- Kontroll-, kö- och inbromsningsklassen blir något sämre än E ensam, men
  kontroll och kö är bättre än 7699cbe.
- Inget av detta syns i banken. Det står i VALIDATION "Sammanslagningen E +
  E2".

## 7. Facit och motorn

**Facit (U13) mot 7699cbe** (`K/E2/FACIT.md`, `facit-summa.txt`):
- Goldens i mwt är byte-lika med E2-revisionens. Facit för hela patchen är
  därför E2:s 164 rader och E:s sex.
- PRIMA LADYs textrad (24h idx 65) finns i båda: 7 → 3 → 4. Den är sämre mot
  e949ae1 men rättare mot 7699cbe (+3,9 → +0,9).

| Population | Rättare | Likvärdig | Sämre | Utan linjefacit | Summa |
|---|---|---|---|---|---|
| alla | 77 | 8 | 60 | 24 | 169 |
| sanning < 10 min | 61 | 6 | 21 | 1 | 89 |
| sanning < 5 min | 39 | 5 | 8 | 1 | 53 |

Sammanslagningen lägger inga sämre rader till. Omlåsningen är fortfarande E2:s
DEMO, och dirigenten låser om med verktyget. För 17h:s öppningsfördelning är
det en riktad registrering, eftersom REGEN vägras av 7h.

**Motorn** (`motor-repro.txt`, `motor-quick-mot-*.txt`):
- *`hunt --repro` på alla 25 kort i r1-standard-a:* F04, F06 och F07 är BORTA
  (0 utslag). De övriga 22 är KVAR, som på E2-revisionen.
- *`hunt --profile=quick`* (`K/E2/hunt-quick-sammanslagning`), kört på
  `f3498bc` med exit 0:
  - självtestet GRÖNT (determinism 24/24, SHIFT30 24/24, MMSI 24/24,
    kanarier 5/5, rundresa 45/45);
  - 33 kluster, varav 16 kandidater.
- *Per medlem:*
  - identiskt med E2-revisionens quick (`K/E2/hunt-quick`);
  - mot E:s andra revision (`K/E/hunt-quick`) syns E2:s ändringar: borta är
    bankens F07, 192, 246, 251, 28, 122 (två medlemmar) och 77, värld 5 (U17)
    är ny och värld 82 går från MISS till LEDTID<60s;
  - mot r1-quick-a är dessutom värld 117 borta (E:s F04-klass);
  - inga nya kort.

## 8. Dokumenten

**I patchen:**
- **ARCHITECTURE §8 (e):**
  - E:s mening "K6:s krav berörs inte" gäller nu bara E. Där står också att
    avgången förs vidare en gång per sampel genom `lastKey` och
    ögonblicksbilden.
  - E:s stycke "Till familj E2 (U20)" är borta. E2:s rubrik säger att U20 förde
    F06 och F07 hit.
  - Klassens ommätning står där.
  - Talen mot 7699cbe står där.
  - PRIMA LADY-raden förklaras mot båda baserna.
  - Under "Kända latenta klasser" står tretton fall i stället för tolv.
- **VALIDATION:**
  - nytt avsnitt "Sammanslagningen E + E2";
  - noten om ommätningen i "Familj E";
  - i "Familj E2" stämmer talen för ändrade påståenden med en definition (E2:s
    granskning, låg punkt 4), och raderna om E:s sex rader och M9 gäller båda
    revisionerna.
- **corpora.js:** 24h-noten.
- **ProgressiveETACalculator:** kommentaren vid `_increaseHoldStreak` pekade på
  den obefintliga `INCREASE_HOLD_MAX_CONSECUTIVE` (E2:s granskning, låg punkt
  4). Koden är oförändrad.
- **Golvbeskrivningen (E:s granskning, låg punkt 1):**
  - ARCHITECTURE och VALIDATION "Familj E" säger nu att golvet aldrig sänks
    medan farten stiger, max(förra golvet, fart + ökning);
  - ett avgångssampel på minst 2,0 kn ger därför 4 kn tills farten slutar
    stiga, i högst 5 min;
  - koden och testen är oförändrade.

**Utanför patchen:**
- `K/E2/FACIT.md`, nytt avsnitt;
- den här filen;
- `K/E2/matningar/sammanslagning/`.

E:s DESIGN.md ligger i E:s katalog och är inte ändrad.

## 9. Öppet efter sammanslagningen (ändras inte här)

- **E2:s ägarfråga (U13, hög i E2:s granskning):**
  - 21 låsta rader i bandet < 10 min blir sämre mot 7699cbe, mot 61 rättare;
  - PILOT 761 och ORCA (FP9) utanför låst facit;
  - ägaren svarar. Ett nej lämnar F06 och F07 öppna.
- **20260917-7h:** kan inte låsas om (68 ≠ 69). Det kräver ett
  dirigentbeslut.
- **E2:s låga punkter:**
  - mötande konvoj prövar bara tystnad vid absorptionen (K/K2);
  - F06-kvoten och Fix G:s registrering efter loopen saknar test (överlevande
    mutanter);
  - de sju sämre mätta påståendena utanför låst facit saknas i ägartabellen.
- **E:s låga punkter 2 och 3:**
  - kö- och inbromsningsklassen står nu med tal i VALIDATION "Sammanslagningen
    E + E2" (§6). Däremot finns de inte i VALIDATION "Familj E", och E:s DESIGN
    ligger i E:s katalog;
  - påståendet om färre uppsteg gäller fortfarande bara E:s svit. Granskarens
    omspelning med verkliga profiler (`K/E/tmp/omgr2/advbank`) är inte gjord
    om på sammanslagningen.
- **measure:eta under last:** harnessen tappar renderingsposter när maskinen är
  hårt lastad. Båda körningarna här hade 0 oattribuerade, men felet i
  harnessen kvarstår.
