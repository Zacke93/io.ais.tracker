# DESIGN.md — familj E: avgångs-ETA (F04), andra revisionen

Prototyp: `kampanj/E/wt`, detached på 7699cbe. Commits i ordning:
- första leveransen: `d1f02ee`, `ea88454`, `fa269e2`;
- första revisionen: `00f41a5`, `bd9892e`, `e949ae1`;
- **andra revisionen:** **`5febba0`** (koden och regressionstestet), **`5b9ea15`**
  (DEMO-omlåsningen av 24h) och **`f3a2d46`** (dokumentationen).

`patch.diff` är `git diff 7699cbe` utan `bugHunt/` och `node_modules`.

Familj E omfattar efter användarbeslut U20 bara **F04**. F06 och F07 hör till
familj E2, som bygger på `e949ae1` (§10).

## 0. Kort och enkelt

**Felet (F04).** En båt som väntade vid en bro och körde iväg fick en alldeles
för hög ETA: "om 27 minuter" fast båten var framme efter 3 minuter. Appen räknade
på farten i startögonblicket och tog med väntans nollor i medelvärdet.

**Första revisionen** tog bort nollorna och räknade med minst 4 knop så länge
farten steg. Granskningen visade att det blev fel för båtar som aldrig kommer
upp i 4 knop. Texten visade "om 3" när båten var 6 minuter bort och hoppade
sedan upp: "5 → 4 → 3 → 5". Från Olidebron blev det "om 11" mot verkliga 23
minuter och sedan "11 → 14 → 16".

**Nu** gissar appen inte längre på 4 knop. Den antar bara att båten fortsätter
att öka farten lika mycket ett sampel till:
- i första samplet efter stillheten räknar den med dubbla farten;
- medan farten stiger räknar den med senaste farten plus senaste ökningen;
- aldrig med mer än 4 knop.

När farten slutar stiga släpps antagandet försiktigt, så att texten inte hoppar
upp bara för att gissningen tas bort.

**Effekt:**
- *Granskarens fall:* Klaffbron blir "5, 4, strax" och "5, strax".
  Järnvägsbron blir "5, 4, strax" i stället för "om 3" mot 6,5. Olidebron blir
  "23, 22, 19, 18 …" mot verkliga 24,5.
- *Platåklassen:* av 144 syntetiska avgångar som planar ut på 2,0–3,5 kn
  minskar tiden med en prognos som är minst 2 minuter för låg från 174 till 23
  tidsviktade sampel. Fallen där texten hoppar upp minskar från 56 till 36,
  färre än 7699cbe:s 39.
- *Banken:* sex låsta rader i tre korpusar flyttas, alla rättare. Inget mätt
  påstående blir sämre.
- *M9-priset är borta:* SKONNERTENs notis är "om 2" som förut, inte "om 3".
- *F04 är BORTA.*

**Priset.** En båt som verkligen accelererar till 4–6 knop får en något
försiktigare första prognos: ALVA "om 5" mot verkliga 3,1, där första revisionen
gav "om 4". Därefter går nedräkningen bara nedåt (5, 4, 3, strax).

**Status: klar för F04.** F06 och F07 är KVAR i motorn och hör till E2.

## 1. Rotorsaken

### F04 (värld 884, ALVA), oförändrad sedan första omgången

Körning: `REPLAY_VERBOSE=1 REPLAY_DEBUG_LEVEL=full` på kortets `repro.jsonl`
(logg: `E/tmp/F04/verbose.log`). ALVA ligger still 237 m före Järnvägsbron,
med mål Stridsbergsbron, och avgår 11:31:47 i 1,6 kn:

```
11:31:47.281 [ETA_RAW] 265969679: Raw ETA = 29.5min          ← snitt [0, 0, 1,6] = 0,53 kn
11:31:47.281 [ETA_GAP_RESET] 265969679: 1218s since last calculation — clearing stale ETA history
11:31:47.281 [ETA_RAW] 265969679: Raw ETA = 9.8min           ← snapshot-passet: tömd buffert, bara 1,6
11:31:47.281 [ETA_OUTLIER] Suspicious ETA 9.8min detected (dramatic_decrease_0.33x)
11:31:47.281 [ETA_SMOOTHING] EMA smoothing applied (raw: 23.6min → smooth: 27.1min)
→ "om 27 minuter" (L0: ALVA korsar Stridsbergsbron 11:34:52, alltså 3,1 min senare)
```

Nu: `11:31:47 "om 5" → 11:32:17 "om 4" → 11:32:47 "om 3" → 11:33:17 "strax"`
(fixturen `tests/fixtures/e-f04-alva-avgang-jarnvagsbron.jsonl`).

### Platåklassen (andra granskningen): golvet antog marschfarten

I `e949ae1` räknade `_getEffectiveSpeed` med 4 kn så länge varje nytt sampel var
snabbare än det förra. Två fel följde:
1. *För låg ETA under hela igångsättningen.* En båt som ökar 1,0 → 1,3 → 1,6 →
   1,9 → 2,0 kn "steg" i fyra sampel, och ETA:n räknades på 4 kn i stället för
   ~2 kn. Vid Klaffbron (480 m) blev det "om 3" när sanningen var 6.
2. *Uppsteg när golvet släpptes.* När farten slutade stiga gällde buffertens
   snitt igen, och det släpar dessutom efter med accelerationens låga sampel.
   Prognosen hoppade då från d/4 kn till d/1,8 kn: "3 → 5" vid Klaffbron och
   "11 → 14 → 16" från Olidebron.

M9-priset hade en egen mekanism: M9 höll SKONNERTENs prognos på 3,0 07:30:11,
och värdet gick in i historiken. EMA:n i nästa sampel räknade från 3,0 i
stället för från 2,6, och notisen blev "3" mot sanning 1,4 (7699cbe sa 2).

## 2. Granskningens punkter och vad som gjordes

| Allvar | Punkt | Åtgärd | Belägg |
|---|---|---|---|
| medel | Golvet på 4 kn ger för låg ETA och uppsteg när avgången planar ut under 4 kn | Golvet följer den uppmätta accelerationen ett sampel framåt och släpps mjukt (§3). Platåklassen är mätt enligt REGELN: 208 syntetiska fall från fyra väntplatser vid tre broar, med uppsteg och fel mot sanningen (§4). | §4; fyra nya regressionstest (platå vid Klaffbron, Järnvägsbron och Olidebron samt fartbrus), alla röda på `e949ae1` |
| låg | Klassen har fler kvarvarande fall än de fyra som redovisades | Hela klassen är klassad: 87 sampel i åtta mekanismer, varav tolv med minst 3 min för hög prognos (§7). Den står i ARCHITECTURE §8 (e) och VALIDATION "Familj E". | `tmp/rev3/restklass.txt`, `tmp/rev3/restklass-alla.txt` |
| låg | M9-priset (SKONNERTENs notis 2 → 3) går att undvika | V4-principen är införd med en vakt (§6): SKONNERTENs notis är 2 igen, och banken har 6 ändrade påståenden, alla bättre. | tre enhetstest; `tmp/rev3/bank/vFINnov4` (utan V4: 7 ändrade, 1 sämre) |
| låg | Dokumenten är inaktuella efter U20 | ARCHITECTURE §8 (e) och DESIGN säger att F06 och F07 förs till E2. "Väntar på ägarbeslut" är borta, och det står att E2 ska mäta om de sex raderna och M9/V4. | §9, §10 |

## 3. Rättningen på kodnivå

Allt ligger i `lib/services/ProgressiveETACalculator.js`. `app.js` är orört.

**Konstanter:**
- `BRISK_CANAL_SPEED_KNOTS = 4`, som förut;
- `DEPARTURE_STILL_SAMPLES = 2`;
- `DEPARTURE_MAX_DISTANCE_FROM_STILL_M = 200` (gravens radie);
- `DEPARTURE_CONTEXT_MAX_AGE_MS = 5 min` (var 3);
- nya `DEPARTURE_FIRST_SAMPLE_GAIN = 2`;
- nya `DEPARTURE_SPEED_NOISE_KN = MOORING_DETECTION.STATIONARY_SOG_KN` (0,3 kn,
  GPS-brusnivån).

**Tillstånd i `_departures`:** nya fält är `peakSog` (högsta farten sedan
avgången), `floorKn` (golvet i knop), `released` (antagandet är tillbakadraget)
och `lastDistance` (avståndet till målbron i förra samplet). Städningen är
oförändrad och gäller hela posten.

**`_noteDepartureSample`:**
- Avgångsdetekteringen är oförändrad: belagd stillhet, ≤ 200 m och närmare
  målbron.
- Vid avgång blir `floorKn = min(4, 2 × sog)`.
- En pågående kontext förs vidare av `_advanceDeparture`.

**`_advanceDeparture(vessel, departure, sog, key)`**, ny, per nytt sampel:
1. `sog < 1,0` eller `sog < peakSog − 0,3`: kontexten raderas (stopp eller
   inbromsning).
2. `sog > lastSog` och (inte släppt eller `sog > peakSog`): båten accelererar.
   `floorKn = min(4, max(floorKn, sog + (sog − lastSog)))` och
   `peakSog = max(peakSog, sog)`.
3. Annars, jämn fart inom bruset: `_releaseDepartureFloor`.

**`_releaseDepartureFloor(departure, sog, distance)`**, ny:
`floorKn = max(sog, min(floorKn × d/d_förra, peakSog + 0,3))`.
- Golvet sjunker högst i avståndets takt, så rå-ETA:n (d / v) står still i
  stället för att stiga när antagandet dras tillbaka.
- Det ligger aldrig mer än bruset över toppfarten, så ett stort antagande skärs
  ned direkt.
- Det går aldrig under aktuell fart; bufferten släpar.

**`_getEffectiveSpeed`:** i kontexten jämförs uppmätt fart (`max(snitt,
minRouteSpeed)`) med `floorKn`.
- Är den lägre bestämmer golvet farten. `floorKey` och
  `floorRatio = floorKn / uppmätt` sätts för M9, som förut.
- Annars, om antagandet är släppt, raderas kontexten: snittet har hunnit ikapp.
- Båda passen i K6-dubbelkörningen ger samma fart, eftersom radering bara sker
  när golvet inte binder.

**`_processETAWithProtection`:**
- *M9:* oförändrad regel. När M9 håller ETA:n sparas det ohållna värdet i
  historikposten som `m9UnheldETA`. `processedETA` är som förut det
  publicerade, hållna värdet (E-F6).
- *V4 i EMA-steget:* `emaBase` är `lastEntry.m9UnheldETA` om förra posten hölls
  av M9 OCH det här samplets egen mätning (`departureMeasuredETA`, annars
  rå-ETA:n) lovar strax. Annars är `emaBase` `lastEntry.processedETA`.

**K6 rörs inte.** Dubbelkörningen, gap-resetens plats, outliergrindens 30 s-
fönster och `emaAlpha` är oförändrade. V4 väljer bara EMA:ns bas efter ett
M9-hållet värde.

## 4. Platåklassen mätt enligt REGELN

**Harness:** `tmp/rev3/scripts/platå.js` (körning: `node platå.js <träd> <ut>`),
med jämförelseskripten `platå_tabell.py`, `platå_jmf.py` och `varianttabell.py`.
- *Geometri:* scenarioGeneratorns kanal, samma metod som granskarens
  `synth.js` och E:s test.
- *Väntplatser:* fyra, vid tre broar:
  - 480 och 360 m söder om Klaffbron, mål Klaffbron;
  - 120 m söder om Olidebron, mål Klaffbron;
  - 200 m söder om Järnvägsbron, mål Stridsbergsbron.
- *Profiler:* 26 st:
  - platåklassen 2,0, 2,5, 3,0 och 3,5 kn, i långsam, medel och snabb ramp,
    med jämn fart från första samplet, plus två med fartbrus;
  - kontrollklassen (F04-klassen, når 4–6 kn, bland annat ALVA);
  - inbromsning;
  - två köfall från granskaren.
- *AIS-takt:* 30 och 60 s, vilket ger 208 fall.
- *Sanning:* linjekorsningen i geometrin.
- *Tidsviktat mått:* visad text var 10:e sekund.
- *Uppsteg:* minuttal som går upp efter avgången, inklusive steget från väntans
  prognos.

| Klass | Mått | 7699cbe | `e949ae1` (fast 4 kn) | Andra revisionen |
|---|---|---|---|---|
| platå (144) | tidsviktat < 5: median · ≤ 2 · bias | 1,03 · 87,9 % · +1,07 | 0,72 · 100 % · −0,03 | 0,76 · 98,9 % · +0,64 |
| | tidsviktat < 10 | 0,88 · 93,1 % · +0,72 | 0,88 · 92,2 % · −0,00 | 0,80 · 97,7 % · +0,46 |
| | påståenden < 10 | 0,67 · 94,4 % · +0,49 | 0,67 · 89,8 % · −0,38 | 0,47 · 97,5 % · +0,11 |
| | ≥ 2 min för optimistiskt (tidsviktade sampel) | 0 | 174 | 23 |
| | uppsteg: fall / antal / ≥ 2 min | 39 / 46 / 27 | 56 / 84 / 35 | 36 / 48 / 13 |
| kontroll (40) | tidsviktat < 5 | 2,08 · 46,2 % · +2,13 | 0,90 · 85,9 % · +1,13 | 1,33 · 72,4 % · +1,57 |
| | tidsviktat < 10 | 2,32 · 39,4 % · +3,52 | 1,17 · 67,9 % · +1,73 | 1,63 · 59,5 % · +2,28 |
| | uppsteg | 6 / 6 / 6 | 3 / 3 / 0 | 0 / 0 / 0 |

Per plats (platåklassen, tidsviktat < 10 min: andel ≤ 2 min och bias, samt
fall med uppsteg; `tmp/rev3/platå-tabell-slutlig.txt`):

| Plats | 7699cbe | `e949ae1` | Andra revisionen |
|---|---|---|---|
| Klaffbron 480 m | 79,4 % · +0,98 · 16 fall | 87,8 % · −0,69 · 13 fall | 96,7 % · +0,30 · 3 fall |
| Klaffbron 360 m | 99,4 % · +0,08 · 0 | 83,0 % · −1,10 · 0 | 98,2 % · −0,01 · 0 |
| Järnvägsbron 200 m | 94,6 % · +0,59 · 0 | 81,9 % · −1,07 · 8 | 96,7 % · +0,06 · 3 |
| Olidebron 120 m | 97,0 % · +0,74 · 23 (27 uppsteg ≥ 2 min) | 97,9 % · +0,71 · 35 (35) | 98,3 % · +0,70 · 30 (13) |

**Granskarens egna fall** (`omgr1/scripts/synth.js` och `synth_mid.js` körda
mot de tre träden, `tmp/rev3/gransk*-*/ut.txt`):

| Fall | 7699cbe | `e949ae1` | Andra revisionen |
|---|---|---|---|
| platå: Klaffbron 470 m, 1,2 → 2,4 kn | 5, strax | 5, 4, 3, 4, strax | 5, 4, strax |
| platå2: Klaffbron 480 m, 1,1 → 2,0 kn | 5, strax | 5, 4, 3, 5, strax | 5, strax |
| brus: 2,5 → 2,4 mitt i accelerationen | 5, strax | 5, 4, 5, 4, strax | 5, 4, strax |
| falsk: flyttar sig i kön och blir liggande | 6 står kvar | 5, 4, 5 | 6 står kvar |
| gles: 60 s-takt, 1,3 → 2,6 kn | 5, strax | 5, 4, strax | 5, strax |
| manöver: rör sig, stannar, avgår | 5, 8, 9, 12, 8, strax | 5, 4, 3, strax | 5, 8, 9, 7, 6, strax |
| jarnv_platå: 1,0 → 2,0 kn | 5, 4, strax | 3, strax | 5, 4, strax |
| olide_platå: 1,0 → 2,0 kn | 19, 24, 30, 28, 21, 19, 17 … | 13, 12, 11, 14, 15, 16, 15 … | 23, 22, 19, 18, 17 … |
| olide_platå25: 1,2 → 2,5 kn | 19, 22, 21, 18, 17 … | 14, 13, 11, 14, 15, 14 … | 19, 17, 16, 15, 14 … |
| olide_accel: 1,4 → 5,0 kn (kontroll) | 19, 27, 23, 19, 15 … | 14, 12, 11, 10, 9 … | 17, 15, 13, 11, 10 … |

I "manöver" stannar båten 3,5 min mitt i köflytten, och "8, 9" är den ärliga
uppgången då. `e949ae1` visade "3" när sanningen var 7–8.

**Det som är kvar i platåklassen:**
- *Rättelse vid avgången från en väntprognos som redan räknade på 4 kn:*
  E-F7:s decaygolv gör det vid Olidebron, till exempel "18 → 23" för en båt som
  går 2 kn. Rättelsen är ärlig och sker en gång. 7699cbe gör samma sak, men
  större: "18 → 24 → 27".
- *Minutsteg vid avrundningen:* jämn fart 2,0–2,5 kn redan i första samplet ger
  dubbleringen 4 kn, och när den skärs ned till 2,3–2,8 kn går texten "4 → 5"
  en gång. Den jämna farten kan inte skiljas från en igångsättning förrän
  andra samplet.
- *Den värsta optimismen:* jämn 2,0 kn från Olidebron med 60 s-takt visar
  "om 12" mot 23 under en minut, tills andra samplet visar att farten inte
  steg.

## 5. Övervägda alternativ

Alla är mätta på hela sviten, 208 fall (`tmp/rev3/varianttabell.md`). De
experimentella varianterna kördes i ett separat träd med miljöväxlar
(`tmp/rev3/exp`).

| Variant | Platå < 5 min | Uppsteg (fall / antal / ≥ 2) | ≥ 2 min för optimistiskt | Kontroll < 5 min | Beslut |
|---|---|---|---|---|---|
| 7699cbe | 1,03 · 87,9 % · +1,07 | 39 / 46 / 27 | 0 | 2,08 · 46,2 % · +2,13 | bas |
| Fast golv 4 kn medan farten stiger (`e949ae1`) | 0,72 · 100 % · −0,03 | 56 / 84 / 35 | 174 | 0,90 · 85,9 % · +1,13 | ersatt (granskningens punkt) |
| Granskarens V3: golv min(4, 2 × fart) per sampel | 0,67 · 99,6 % · +0,35 | 56 / 94 / 29 | 53 | 1,11 · 74,8 % · +1,41 | avvisad: dubbleringen sent i rampen skjuter över platån, fler uppsteg |
| Granskarens V2: stigande kräver +0,5 kn | 0,74 · 93,5 % · +0,46 | 80 / 104 / 54 | 83 | 0,90 · 85,9 % · +1,15 | avvisad: släpper golvet mitt i rampen |
| Följer accelerationen, släpps direkt | 0,77 · 97,5 % · +0,68 | 45 / 61 / 20 | 23 | 1,34 · 71,7 % · +1,59 | avvisad: bufferten släpar, prognosen hoppar upp vid släppet |
| … släpps till aktuell fart | 0,76 · 98,9 % · +0,66 | 43 / 59 / 19 | 23 | 1,34 · 72,0 % · +1,59 | avvisad: brus mitt i accelerationen ger "4 → 5 → 4" |
| … släpps i avståndets takt, tre minuter | 0,79 · 97,5 % · +0,64 | 28 / 40 / 11 | 38 | 1,34 · 71,7 % · +1,59 | avvisad: håller kvar för låg ETA i minuter för jämn låg fart |
| … släpps i avståndets takt, inbromsning släpper, fem minuter | 0,78 · 98,9 % · +0,62 | 22 / 25 / 8 | 38 | 1,34 · 72,0 % · +1,59 | avvisad: färst uppsteg, men "om 3" kvar mot sanning 6,4 för jämn 2,0 kn vid Järnvägsbron |
| … ett brussampel tolereras | 0,78 · 98,9 % · +0,61 | 37 / 50 / 19 | 38 | 1,34 · 72,0 % · +1,59 | avvisad: rättelsen för jämn fart kommer ett sampel senare |
| … band 20 % över toppfarten | 0,76 · 98,9 % · +0,63 | 34 / 40 / 13 | 23 | 1,33 · 72,4 % · +1,57 | likvärdig; knopbandet valdes, eftersom det är samma brusgräns som inbromsningen |
| **Vald:** band 0,3 kn över toppfarten, avståndets takt, aldrig under aktuell fart, fem minuter | 0,76 · 98,9 % · +0,64 | 36 / 48 / 13 | 23 | 1,33 · 72,4 % · +1,57 | **vald** |
| Vald men 2,5 × igångsättningsfarten | 0,61 · 99,9 % · +0,45 | 26 / 41 / 8 | 42 | 1,11 · 84,5 % · +1,32 | avvisad: nästan dubbelt så mycket grov optimism (Olidebron "om 12" mot 23) |
| Vald men 4 kn i första samplet | 0,72 · 100 % · −0,07 | 42 / 74 / 22 | 174 | 0,90 · 86,5 % · +1,11 | avvisad: samma optimism som det fasta golvet |
| Vald men tre minuter | 0,77 · 97,5 % · +0,66 | 36 / 53 / 13 | 23 | 1,34 · 71,7 % · +1,59 | avvisad: släpper mitt i en igångsättning i 60 s-takt (MS JUTLAND, DIANA) |

**Varför faktor 2 i första samplet.** Rådatan i banken visar att kvoten mellan
andra och första rörliga sampel efter stillhet oftast är 1,1–2,9, med median
~1,5 (`tmp/rev3/avgangsprofil.txt`). Bland 91 råa avgångar når två tredjedelar
inte 4 kn inom tre minuter. Dubbleringen ligger i övre kvartilen.
- Mot 2,5 ×: kontrollklassen blir bättre (84,5 % ≤ 2 mot 72,4 %), men den grova
  optimismen i platåklassen nästan fördubblas.
- Mot 4 kn: granskarens punkt kom ur just den optimismen.

Valet följer projektets regel att en båt som inte visat farten inte ska lovas
den.

**Ett positionsbaserat startbevis prövades som idé.** Tanken var att använda
sträckan sedan stillheten för att avgöra om första samplet redan är
marschfart. Det föll i rådatan: AIS-intervallet efter stillhet är ofta
200–500 s, och kvoten skilde inte jämna från accelererande båtar (ADA 0,03,
SOLUTION 0,14, ELFKUNGEN 0,14–0,35).

**De två principerna i granskarens förslag är båda med:** golvet knyts till
uppmätt fart och acceleration, och det släpps mjukt.

## 6. M9-priset och V4-principen

Granskarens V4 (`omgr1/v4`) räknade nästa EMA från det ohållna värdet varje
gång. I den valda designen ger det samma bank som den vaktade formen
(`tmp/rev3/bank/vFINv4`). V4 utan vakt kan ändå låta antagandet lova strax via
utjämningen. Exempel: M9 håller 3,0 med det ohållna värdet 2,6, och nästa
mätning säger 3,4. EMA:n blir då 0,4 × 3,4 + 0,6 × 2,6 = 2,92, alltså strax.
Med det hållna värdet blir den 3,16, alltså "om 3".

Vakten bygger på en princip: det hållna värdet är en spärr för
presentationen. Utjämningen får bortse från spärren bara när det nya samplets
egen mätning själv lovar strax.

| Mätning | Utan V4 | V4 utan vakt | V4 med vakt (vald) |
|---|---|---|---|
| Banken, ändrade påståenden | 7: 6 bättre, 1 sämre (SKONNERTEN notis 2 → 3 mot 1,4) | 6, alla bättre | 6, alla bättre |
| Platåsviten | identisk | identisk | identisk |
| Enhetstest "mätning ≥ 3 efter hållet värde" | 3,16 | 2,92 (strax) | 3,16 |

E-F6 håller: historiken lagrar fortfarande det publicerade värdet
(`processedETA`). Alla andra skydd, som monotoni, approach-limit, growth-cap,
wait-clamp och idle-decay, läser det. `m9UnheldETA` läses bara av EMA-steget.

## 7. Hela den kvarvarande klassen

**Kroken:** granskarens `omgr1/scripts/rhook.js` (RH_LEAN=1) över banken mot
`E/wt` (`tmp/rev3/hook/wt`).

**Klassning:** `tmp/rev3/scripts/restklass.py`, som läser kroken, `measure:eta`
och rådatan. Utdata i `tmp/rev3/restklass.txt` och `restklass-alla.txt`.

Banken har 9 avgångar som känns igen och 87 rörliga sampel efter långsam buffert
som inte gör det:

| Mekanism | Sampel | Med mätta påståenden inom 3 min | ≥ +3 min |
|---|---|---|---|
| tömd buffert (gap-reset/målbyte), högst ett sampel kvar | 32 | 13 | 6: ANTJE +12,8, AKIRA +8,8, SOLUTION +3,9, TINY +3,8, NOCHT 11:12 +3,8, MISTRAL +3,3 |
| ankomstfarten kvar efter kort väntan | 18 | 8 | 1: NOCHT 12:01 +4,1 ([1,8, 0,3, 0]) |
| krypfart utan stillhet | 15 | 6 | 1: NORDIC SOLA +9,5 ([1, 0,8, 0,8]) |
| startsampel 0,5–0,99 kn | 7 | 5 | 2: UTOPIA +6,9 ([0,2, 0,3, 0,6]), ANDREA +4,4 ([0,3, 0, 0,9]) |
| långsam gång 0,5–0,99 kn i bufferten | 6 | 4 | 1: ZORA +5,9 ([0,9, 0,3]) |
| stillhet som aldrig nådde kalkylatorn | 4 | 2 | 1: PILOT 761 +11,3 |
| för långt från stillheten (> 200 m) | 3 | 2 | 0 |
| bort från målbron | 2 | 0 | 0 |

Tidpunkter och korpusar står i VALIDATION "Familj E".

**Varför klassen står kvar:**
- Att fånga tömd buffert och ankomstfart kräver ett stillhetsminne utanför
  bufferten. Det är mätt två gånger och gör låsta rader sämre:
  - första revisionens minne gör ELFKUNGEN ×3, ANTJEs senare rader och YOLO 2
    sämre och flyttar en öppningsvarning;
  - granskarens V1 gör ELFKUNGEN i 31h "om 11 → om 8" mot 13,1.
  - Båda avvisades enligt U13.
- Krypfart och startsampel 0,5–0,99 kn kräver en annan stillhetsdefinition än
  rörelsebeviset. "Stillhet = alla sampel < 1,0 kn" gav en ny fatal
  ETA-oscillation i 21h.
- PILOT 761 kräver en stillhetssignal från VesselDataService.

Klassen hör till ETA-etappen (E2 och senare). Lägg märke till att E2 ändrar
gap-reseten så att bufferten behåller fixets eget sampel. Det ändrar indata för
den största mekanismen, "tömd buffert", så klassen ska mätas om efter
sammanslagningen.

## 8. Bankens mätning (`measure:eta`, 24 korpusar)

Sanning ur `gt-passages` (kind=line). Parning per korpus, typ, bro och mmsi
inom 2 s. Basen är `tmp/rev/eta-base` (7699cbe).

| Band | Population | 7699cbe | Andra revisionen |
|---|---|---|---|
| < 5 min, alla typer | parad, n = 784 | 0,47 · 88,9 % · +0,51 | 0,46 · 89,7 % · +0,49 |
| < 10 min, alla typer | parad, n = 1 295 | 0,71 · 81,2 % · +0,18 | 0,70 · 81,6 % · +0,17 |
| båda | oparad | n = 0 | n = 0 |

Ändrade påståenden: 6, alla bättre (FACIT.md). Brotextövergångarna är 2 544 →
2 544 och strax-löftet är oförändrat (n 211, 63,0 % ≤ 3 min).
`tmp/rev3/bank/wt-full/bands.txt` och `tmp/rev3/bank/wt/bands.txt` är
identiska i påståendena.

**K6-fallen som E2 mäts mot** (KAMPANJ.md, `E/matningar/k6-fallen.txt`) är
identiska med 7699cbe:
- LINNEA 265764760 i 20260713-41h: 24 påståenden, alla lika;
- SISU i 20260708-21h: 10, alla lika;
- IDUN i 20260712-25h: 8, alla lika;
- 41h-svängningarna: 20260713-41h har 206 brotextpåståenden, alla lika. I
  20260601-41h ändras bara SKONNERTENs rad (8 → 3, FACIT).

Vilka två svängningar K6-texten menar står inte där. Den enda brotexten
"8 → 14" i 41h-korpusarna är NORDIC SOLA 258715000 vid Stridsbergsbron
2026-07-15 08:48:51 (sanning 4,5 min). Samma påstående är klassens
krypfartsfall i §7 (bufferten [1, 0,8, 0,8], inget sampel under 0,5 kn). E2 och
sammanslagningen bör alltså mäta det också som en del av klassen.

## 9. Motorn

- `hunt --repro`, alla 25 kort i r1-standard-a (`E/motor-repro.txt`): **F04
  BORTA** (0 utslag i värld 884). Övriga 24 är KVAR, som på 7699cbe. Där ingår
  F06 och F07, som hör till E2.
- `hunt --profile=quick` (`E/hunt-quick`, `E/hunt-quick-jamforelse.txt`), kört
  på `5b9ea15`, vars kod är densamma som i `f3a2d46`: självtestet GRÖNT,
  34 → 34 kluster och 88 → 87 utslag mot r1-quick-a. Bara värld 117 lämnar
  SÅGTAND-klustret, och utfallet är identiskt med första revisionens quick.
- `hunt --profile=standard` (`tmp/rev3/standard-ren`, `E/hunt-standard-jamforelse.txt`,
  `E/matningar/hunt-standard.log`), kört på `f3a2d46` med exit 0:
  - självtestet GRÖNT; bankspåret 168 fasvarianter, 158 rena; sanningsspåret
    2000 världar, 0 fel och 0 häng; 40 av 40 representanter bekräftade;
  - 46 → 46 kluster och 420 → 416 utslag mot r1-standard-a, inga nya kluster
    och inga nya världar i något kluster;
  - världarna 117, 884 och 950 lämnar SÅGTAND-klustret (31 → 28) och 1963
    lämnar OSCILLATION-klustret (16 → 15);
  - klusterutfallet är identiskt med första revisionens standard
    (`tmp/rev2/standard`, 0 ändrade kluster).

  Första körningen (`tmp/rev3/standard`) gav samma kluster men exit 2.
  S-GIT-vakten såg att `docs/ARCHITECTURE.md` och `docs/VALIDATION.md`
  ändrades under körningen, eftersom dokumentationen skrevs då. Omkörningen
  gjordes på det rena trädet.
- De kritiska världarna (`tmp/scripts/worlds.js` mot `E/wt`, `tmp/rev3/worlds-wt`):
  - 884, 117, 950, 1963, 664, 906, 920, 1113 och 595 är rena;
  - 192 (F06) och 996 (U16-klassen) har samma utslag som förut.

## 10. Samspel med andra familjer

**E2 (U20) bygger på `e949ae1` och rör samma fil.** Sammanslagningen behöver
handpåläggning på fyra ställen och en kontroll på ett femte (läst i `E2/wt`,
commits `3bd8e64` och `77e6774`):
1. *EMA-raden i `_processETAWithProtection`.* E2 byter alfa
   (`alpha = this._inGapStep ? GAP_BASELINE_ALPHA : this._emaAlpha`) och E byter
   bas (`emaBase`). De slås ihop som
   `smoothedETA = alpha * protectedETA + (1 - alpha) * emaBase`.
2. *M9-blocket.* E2 lägger ett strax-krav för inbromsning (`_decelRatio`) bredvid
   M9. E:s `m9UnheldETA` ska bara sättas av M9-hållningen.
3. *`_getEffectiveSpeed`.* E2:s `_decelRatio` ligger direkt efter E:s
   golvkod och läser `minRouteSpeed`, som hos E kan vara golvet när det binder.
   Det fungerar, men ska mätas.
4. *Gap-reseten.* E2 låter bufferten behålla fixets eget sampel. Det ändrar
   avgångsdetekteringens indata, eftersom "tömd buffert" är klassens största
   mekanism (§7).
5. *Ögonblicksbilden per fix (kontroll).* E2:s `_captureFixState` och
   `_restoreFixState` kopierar `_departures`-posten grunt och historiken med
   `slice()`. E:s nya fält (`peakSog`, `floorKn`, `released`, `lastDistance`)
   är primitiva, och `m9UnheldETA` ligger i historikposterna, som E aldrig
   ändrar på plats. Den grunda kopian räcker alltså, men ett test med en
   omräknad avgång bör ingå i sammanslagningen.

E2 ska enligt KAMPANJ.md mäta om E:s sex omlåsta rader och M9/V4-utfallet.
PRIMA LADYs och SKONNERTENs värden beror på den dubbla EMA:n.

**Övriga familjer:**
- *K (konvojens bakkant)* läser `expectedArrivalMs`. I banken ändras bara
  `etaMin` på två varningar (PRIMA 5 → 3, OLA 4 → 1). Tider, ledare och
  O1/O2/O3 är identiska; `replay:openings` ger samma utskrift som 7699cbe.
- *K2 (returresan):* avgången kräver belagd stillhet på plats och att båten
  närmar sig målbron, så en U-sväng utan stopp utlöser den inte.
- *N (notiser):* notisernas `eta`-token ändras för avgående båtar (två låsta
  rader). Antal och tider är oförändrade.
- *R1, R2 och M:* ingen beröring.

## 11. Användarbesluten

- **U13:** FACIT.md listar alla sex flyttade låsta rader med rådatabelägg, och
  alla är rättare. Varje variant som flyttade en låst rad åt fel håll är
  avvisad. Omlåsningen i `bd9892e` och `5b9ea15` är en DEMO.
- **U14, U15, U19 och U21:** rörs inte. Notisantal, öppningsvarningarnas antal
  och tider och notiskällor är oförändrade.
- **U16:** rörs inte. Imminent-reglerna och 600 s-gränsen är orörda; M9 läser
  imminent-flaggan.
- **U17 och U18:** ingen beröring.
- **U20:** F06 och F07 är förda till E2. E rör inte K6-dubbelkörningen och inte
  spärren mot extrapolering (RC4-clampen i app.js). Överlappet i EMA-raden
  står i §10.

## 12. Mätningar

Loggar finns i `E/matningar/` och `tmp/rev3/batt/`.

| Mätning | Resultat |
|---|---|
| `npm test` | 4 808 gröna, 2 hoppade, 1 röd. Den röda är motorkopians otrackade `bugHunt/__tests__/b-register.test.js` ("docs/BUGGJAKT.md finns inte"), lika röd på 7699cbe. Appens svit är grön. |
| Regressionstestet `tests/e-avgangs-eta-2026-11-04.test.js` (33 fall) | 33/33 på andra revisionen; 15/33 röda på `e949ae1` (de fyra platåtesten, V4 och de ändrade golvfallen); 24/33 röda på 7699cbe (`E/test-mot-tre-trad.txt`). Omkört på `f3a2d46` tillsammans med brotexttesterna: 33/33 och 128/128 (`E/matningar/regressionstest-f3a2d46.txt`). |
| `replay:all` | 24/24 gröna efter DEMO-omlåsningen. Mot 7699cbe:s facit avviker exakt 41h idx 127, 24h idx 65 + notis 20 + kort 5, och 31h notis 22 + kort 7. |
| `replay:synthetic` | alla rena, samma utskrift som 7699cbe |
| `replay:openings` | samma utskrift som 7699cbe (O1/O2/O3) |
| `replay:monitoring` (72 h) och `runSoak` | identiska med 7699cbe utom heapUsedMB |
| `replay:phase`, hela banken | 24/24 GRÖNT |
| `replay:phase` för 41h, 24h och 31h, med och utan `REPLAY_MONITORING=1` | GRÖNT, 6 varianter per korpus |
| `npm run lint` | rent |
| `measure:eta` (§8) | < 5 min 0,47 → 0,46 · 88,9 → 89,7 % · +0,51 → +0,49; < 10 min 0,71 → 0,70 · 81,2 → 81,6 % · +0,18 → +0,17; oparad 0 → 0; 6 ändrade, alla bättre |
| Platåsviten (§4) | ≥ 2 min för optimistiskt 174 → 23; uppsteg 56 → 36 fall (7699cbe 39) |
| `hunt --repro` | F04 BORTA, övriga 24 KVAR |
| `hunt --profile=quick` | självtest GRÖNT; 34 → 34 kluster, 88 → 87 utslag |
| `hunt --profile=standard` | självtest GRÖNT, exit 0 på `f3a2d46`; 46 → 46 kluster, 420 → 416 utslag; 117, 884, 950 och 1963 lämnar INV-3-klustren; identiskt med `e949ae1` |
| K6-fallen (§8) | LINNEA, SISU, IDUN och 41h-svängningarna identiska med 7699cbe |

**Mätanmärkning: `measure:eta` är opålitlig under hög last.** Lastsnittet var
16–25 på fyra kärnor, och flera agenter körde samtidigt. Då saknade 3–38
påståenden sin renderingspost (`rendering-saknas`) i slutet av en eller två
korpusar, och en omkörning gav 0. Samma kod har mätts med 0 saknade i
`tmp/rev3/bank/wt`, `wt-full`, `vFIN` och `vFINv4`. `variant.sh` och
`remeasure.sh` kör nu om tills 0 saknas. Felet sitter i harnessen, inte i appen.

Mekanismen är bekräftad. replayRunner avslutar med
`process.stdout.write(json, () => process.exit(0))`, men på Linux är
skrivningar till en stderr-pipe asynkrona. Det som ännu ligger i stderr-kön
slängs därför vid exit. En minimal demonstration (`tmp/rev3/stderrprov`):
ett barn som skriver 10 MB till pipad stderr och sedan gör samma exit når
föräldern med bara 20 KB.

Rättningen hör inte till familj E. Förslag till dirigenten:
- töm stderr före exit, till exempel med en sista stderr-rad med callback;
- låt `measure:eta` kräva en slutmarkör på stderr och fallera hårt utan den,
  i stället för att påståenden tyst blir `rendering-saknas`.

## 13. Dokument

I patchen:
- `docs/ARCHITECTURE.md` §8 (e), "Avgångskontexten gick in":
  - golvet som följer accelerationen, det mjuka släppet, fem minuter och
    V4-principen;
  - båda granskningarnas mätta skäl;
  - hela den kvarvarande klassen med mekanismer;
  - stycket om E2 (U20), som ersätter "väntar på ägarbeslut".
  "Kända latenta klasser" pekar dit.
- `docs/VALIDATION.md` §ETA-mätharnessen, "Familj E": bankens band, platåklassen
  enligt REGELN, granskarens fall, båda revisionernas återtagna varianter,
  klassen per mekanism och mätanmärkningen.
- `tests/replay-validation/corpora.js`: noterna för 41h och 24h (DEMO;
  dirigenten skriver om dem vid omlåsningen).
- Kodkommentarerna i `ProgressiveETACalculator` (`DEPARTURE_STILL_SAMPLES`-blocket
  och de nya funktionerna).

För dirigenten:
- DESIGN-poster i motorns beslutsregister för U16-klassen, som förut;
- en uppgift om `measure:eta`-svansen (§12).

## 14. Risker

- *Försiktigare första prognos för snabba avgångar:* kontrollklassen < 5 min
  har 72,4 % ≤ 2 min mot 85,9 % med det fasta golvet. Det är fortfarande långt
  bättre än 7699cbe:s 46,2 %. I banken gäller det PRIMA LADYs text, "om 4" mot
  sanning 3,1, där `e949ae1` gav "om 3".
- *Jämn låg fart redan i första samplet* (2,0–2,5 kn) ger en optimistisk första
  prognos som rättas uppåt i andra samplet ("4 → 5" vid Järnvägsbron). Längst
  bort ger det "om 12" mot 23 under en minut från Olidebron. Det går inte att
  skilja från en igångsättning med ett sampel.
- *Rättelsen vid avgången från en väntprognos på 4 kn* (E-F7:s decaygolv) står
  kvar för långsamma båtar ("18 → 23" från Olidebron). Den är ärlig, men den är
  ett uppsteg.
- *Kontexten kan vara upp till fem minuter.* Golvet ligger då högst 0,3 kn över
  toppfarten och aldrig över 4 kn. Inbromsning mer än 0,3 kn, stopp eller
  vändning avslutar den.
- *Imminent-flaggan läses en cykel gammal (SVEPFÖRDRÖJNINGEN),* så M9 kan hålla
  3,0 en cykel innanför 300 m, som förut.
- *Sammanslagningen med E2* har fyra beröringspunkter (§10). Klassen och de sex
  raderna ska mätas om efter den.
- *Falsk avgång:* ett fartbrus på minst 1,0 kn efter belagd stillhet ger golvet
  2 × fart i ett sampel. Riktnings- och närhetskraven gäller.
