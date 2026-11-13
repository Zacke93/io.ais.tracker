# Familj D (SPÄRR) — design, varv 2 (2026-11-09), efter omgranskningen

Mekanism M6 SPÄRR-I-RÖRELSE, värld 263 (F02, T2 LEDTID<60s). Worktree `V/D/wt`, detached.
BOS = `lib/services/BridgeOpeningService.js`, radnummer på c14938f.
S = `/tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad`, V = S/varv2.

**Status:** omgranskningen (V/D/OMGRANSKNING.md) gav ÄNDRINGAR KRÄVS (mindre) för 19e87b5.
- **Dirigentens val: B (EFTER-BRON) med omgranskningens båda skärpningar** (§8):
  1. spärren släpps aldrig innan båten i sin egen fart har nått den tidigare bron;
  2. tystnadsgränsen är minst 210 s, det längsta AISHub kan ge klass B:s 180 s-takt.
- Skärpningarna är committade som **229561e** ovanpå 19e87b5 i V/D/wt, med test, fixtur och
  dokumentation. `V/D/patch.diff` är `git diff c14938f` (19e87b5 + 229561e). Bara skärpningarna:
  `V/D/varianter/patch-SKÄRPNINGAR-på-19e87b5.diff`. 36c695d var samma träd (a29a8a6) med ett
  tidigare commit-meddelande; dess batteri ligger i `V/D/batt-efterbron2-36c695d`.
- 9fe94c6 (TYST-GOLV) ligger åt sidan som grenen `d-tyst-golv` och ingår inte.
- Inget låst facit flyttas (FACIT.md).
- Batteriet på 229561e (`V/D/batt-efterbron2`) gav slutkod 0 i alla 13 steg:
  - jest: 370 sviter, 5 284 test och 2 överhoppade;
  - lint, replay ×2 ("Alla låsta korpusar matchar facit"), synthetic, openings och soak ×2;
  - fassvep ×2 (24 korpusar, OK), självtest (GRÖNT) och quick;
  - porcelain visar bara node_modules.
- Quick mot V/bas/quick: 25 kluster och 4 kandidatkluster i båda. Utslagen går från 58 till 57, och
  det enda som försvinner är 263:s T2 LEDTID.
  - Räknarna: T2 tunn R1 130 → 131 (263 ligger nu på 70 s, i det tunna bandet 60–150 s), F-USVÄNG-matrisen −1 (263) och krympningens prov 76 → 89.
  - Inga T3-, T4- eller T9-räknare ändras.
- `hunt:repro F02-w263-Strid` mot 229561e ger BORTA (`V/D/matningar/efterbron2/repro263.log`). 263 varnas 70 s före korsningen (15:06:35 mot 15:07:45).

## 0. Omgranskningens anmärkningar och svaret

| Anm. | Allvar | Innehåll | Svar i 229561e |
|---|---|---|---|
| 1 | MEDEL | Kö vid Järnvägsbron under tystnad. Släpptiden föll cirka 55 s innan båten i egen fart nådde bron, och gränsen 180 s var kortare än AISHub:s mottagning av lågfartstakten (3 pollar, cirka 195 s). Värld 1511 med en poll till varnades 22 min före korsningen, och i kögridet kom 26 av 84 varningar för tidigt där c14938f väntade | Båda skärpningarna (förslag 1 och 2). 1511-varianten blir som c14938f och kögridet har 3 av 84 kvar (§3b). Test för kö nära bron och 1511-varianten finns (förslag 4, §5). Restfönstret står med siffror i beslutet (förslag 3, §8) |
| 2 | LÅG | Tre påståenden höll inte: RESULTAT ("före bron gäller spärren som förut"), konstantkommentaren ("aldrig kortare än den takten (180 s)") och §8 ("ingen uppmätt kostnad") | RESULTAT: "släpps aldrig innan hon i egen fart har nått bron". Konstanten härleds ur AISHub:s mottagning, ceil(180/65) = 3 pollar à högst 70 s. §8 redovisar restfönstret |

### 0b. Granskningens anmärkningar (första varvet, 9fe94c6)

| Anm. | Allvar | Innehåll | Svar |
|---|---|---|---|
| 1 | HÖG | TYST-GOLV varnar 9–13 min för tidigt före en kö som börjar under tystnaden (värld 29, 1767) | EFTER-BRON: rask fart bara efter den tidigare bron. Ingen kö i de världarna varnas tidigare än på c14938f (§3) |
| 2 | MEDEL | fantom när båten vänder under tystnaden (1089) | borta i EFTER-BRON, plus vakt för kurs bort och väntande vändning |
| 3 | MEDEL | kostnaden saknades | kostnaden står i §3 och §8 och i ARCHITECTURE-punkten |
| 4 | LÅG | talen motiverade av facit | fältmotivering vid konstanterna: farten 2,3 kn före och 5,1 kn efter Järnvägsbron; tystnadsgränsen ur radiotakten |
| 5 | LÅG | `originalDueMs` efter `restartArrival` | dokumenterat: kadensen behålls, och nästa fix kan sätta en kortad `originalDueMs` (bara instrumentet) |
| 6 | LÅG | samordning med A:s M6-rad | ARCHITECTURE-punkten är märkt "M6, dirigentens val B" och nämner A:s returresepunkt |

## 1. Rotorsaken (bekräftad, oförändrad)

Logg `V/D/logs/w263-base.log` (c14938f, monitoring):
- BRISEN 265891927 hördes var 65,0–69,4:e sekund.
- Sista raden kom 15:03:05,253. Fixet var från 15:02:56: 459 m före Stridsbergsbron, 202 m före Järnvägsbron, 2,1 kn.
- Därefter var hon tyst i 272 s. Hon korsade Järnvägsbron 15:05:41 i 2,4 kn och Stridsbergsbron 15:07:45,239 i 4,18 kn.
- `⏰ [OPENING_DEADLINE] … BRISEN d=459 m … utlöst av deadline` kom 15:07:00,824, 44 s före korsningen.

Spärren (BOS:1311–1316) räknade 15:02:56 + 459 m / 2,1 kn − 180 s och ersatte 10-knopsdeadlinen.

## 2. Hur ofta

Mätt med en tillfällig spion (V/D/spy.diff).
- **263 är ensam** bland 2 000 standardvärldar om att få en ledtid under 60 s.
- Av 1 227 varningar som spärren styrde i rörelse fick 843 en ledtid på 60–150 s. 704 av dem kom utan onormal tystnad: båten kröp vid Järnvägsbron och ökade farten efter bron.
- Banken: 36 sådana varningar. Ingen ligger under 60 s och 3 under 150 s. Ingen var en långsam båt i onormal tystnad.
- I tystnad går acceleration inte att skilja från inbromsning: 263 hade 272 s glapp och accelererade, 29 hade 269 s glapp och köade.
- **Köer vid Järnvägsbron norrut** (`V/D/scripts/restfonster.js`, `V/D/matningar/efterbron2/restfonster.txt`):
  - motorns 2 000 världar har 320 sådana köer;
  - i 261 är raden efter det sista rörliga fixet ett köfix, och i 53 av dem kom köfixet mer än 210 s senare;
  - räknat analytiskt släpper varken 19e87b5 eller 229561e spärren före köfixet i någon kö där c14938f håller;
  - motorns standardprofil träffar alltså inte fönstret, inte ens för 19e87b5. Fönstret prövas i stället av granskarens kögrid och 1511-varianten (§3b).

## 3. Varianterna, mätta mot samma mätpunkter

Mätpunkterna och var resultaten finns:
- **Världar:** 263, 29 (RUNA, kö), 1767 (MASEN, kö) och 1089 (LINNEA, vändning).
- **Banken:** 24 korpusar, låsta och olåsta rader, med och utan monitoring (`V/D/dump/g-*`).
- **Grindar:** `replay:openings` och `replay:synthetic` (`V/D/matningar/g-*`).
- **Standardprofilen:** granskarens metod (`V/D/scripts/cover.py`, `metrics.py`), per båt och korsning, mot c14938f.
  - "Före kö" betyder att varningen kom tidigare och följdes av minst 60 s mer väntan än på c14938f.

| Variant | 263 | 29 | 1767 | 1089 | Banken | openings / synth | Tidigare varningar (median, max) | Tunn → ≥ 150 s | Före kö | Fantom / varning efter korsning |
|---|---|---|---|---|---|---|---|---|---|---|
| c14938f | 44 s | 199 s | 268 s | ingen | – | – | – | – | – | – |
| C: TYST-GOLV (9fe94c6) | 141 s | 965 s (−13 min, före kön) | 797 s (−9 min) | fantom | 0 rader | bitlika | 102 (59 s, 765 s) | 29 | **4** (29, 1767, 954, 1038) | 1089; 1902 RECOVER |
| (i) faktor 3 | 72 s | 908 s (före kön) | 268 s | ingen | 0 | bitlika | 54 (55 s, 708 s) | 13 | 1 (29) | 1902 |
| (ii) tystnad ≥ 200 s | 80 s | 916 s (före kön) | 268 s | fantom | 0 | bitlika | 74 (54 s, 717 s) | 17 | 3 | 1089; 1902 |
| (iii) tystnad ≥ 180 s | 100 s | 936 s (före kön) | 791 s | fantom | 0 | bitlika | 85 (49 s, 737 s) | 20 | 4 | 1089; 1902 |
| (iv) rask fart efter bron, utan golv | 141 s | 199 s | 268 s | ingen | 0 | bitlika | 47 (26 s, 387 s) | 12 | 0 | – |
| B: EFTER-BRON (19e87b5) = (iv) + (iii) + vakten | 100 s | 199 s | 268 s | ingen | 0 | bitlika | 38 (19 s, 387 s) | 11 | 0 | – |
| **B med skärpningarna (229561e)** | **70 s** | **199 s** | **268 s** | **ingen** | **0** | **bitlika** | **9 (20 s, 47 s)** | **1** | **0** | **–** |

- "387 s" är w1983. RUNA absorberas där först i en annan båts tidigare varning men får sin egen varning vid samma tid som på c14938f.
- Tabellens underlag: de 149 världar där TYST-GOLV ändrade något och 60 slumpvalda. 19e87b5 och 229561e är körda i alla 2 000 (`V/D/wr2/full-efter180v.jsonl` och `full-efterbron2.jsonl`).

### 3b. Omgranskningens skärpningar

Kögridet är granskarens (`node V/D/scripts/probe2-granskare.js <wt> grid`, kopierad ur rtmp): 84 fall
med sista rörliga fixet 130–400 m före Järnvägsbron, 2,0–3,0 kn, takt 65–69 s och första köfixet efter
195, 205 eller 230 s. Kolumnen räknar varningar före köfixet där c14938f väntade ut kön.
1511-varianten är värld 1511 med en tillagd AISHub-rad, där DAGNY köar vid Järnvägsbron efter 269 s
glapp.

| Variant | 263 | Kögrid | 1511 + en poll (korsning 09:50:45) | 2 000 världar: ändrade världar, tidigare varningar (median) | Före kö / fantom / efter korsning |
|---|---|---|---|---|---|
| c14938f | 44 s | – | 09:45:59 (286 s) | – | – |
| 19e87b5 | 100 s | 26 | 09:28:51 (22 min, 17 min kö kvar) | 36, 38 (19 s) | 0 / 0 / 0 |
| + egen fart (granskarens gwt) | 100 s | 12 | som c14938f | (granskaren: 12 av de 36) | – |
| grind 210 s (granskarens ewt) | 70 s | 8 | 09:28:51 | (granskaren: 27 av de 36) | – |
| **båda (229561e)** | **70 s** | **3** | **09:45:59, som c14938f** | **9, 9 (20 s)** | **0 / 0 / 0** |

- Mitt grid på 229561e (`V/D/matningar/grid-efterbron2.txt`) är identiskt med granskarens fwt. 38 av 84 fall varnar före köfixet, mot 35 på c14938f och 61 på 19e87b5. De 35 gäller båda versionerna, och där varnar 229561e på samma sekund som c14938f utom i ett fall (210 mot 221 s). De 3 nya fallen är 202 m i 2,0 och 2,1 kn och 250 m i 2,1 kn, alla med glapp 230 s.
- Granskarens prov S1–S5 på 229561e: S3 (fusion med blandad kadens) ger 1080 s som c14938f (19e87b5: 180 s), S1 200 s som c14938f, S2 ledtid 206 s (c14938f 180 s, 19e87b5 236 s) och S4–S5 295 s som förut.
- 229561e i hela standardprofilen (2 000 världar, `V/D/wr2/full-efterbron2.jsonl` mot `full-bas.jsonl`; körd på arbetskopian före commit, med samma kod enligt espree-AST):
  - varningar ändras i 9 världar (130, 213, 263, 305, 505, 730, 1053, 1602 och 1952), alla bland 19e87b5:s 36;
  - 9 varningar kommer tidigare (median 20 s, högst 47 s) och ingen senare. Antalet varningar är oförändrat, 11 898;
  - 263 lyfts över golvet (44 → 70 s), och en tunn ledtid blir minst 150 s (505: 124 → 153 s);
  - ingen båt varnas före en kö som c14938f väntade ut, och ingen ny fantom eller varning efter korsning tillkommer.
- Banken: hela resultat-JSON:en för 24 korpusar, med och utan monitoring, är lika med c14938f utom `heapUsedMB` (48 jämförelser, 0 skillnader, `V/D/dump/g-efterbron2*`). `replay:openings` och `replay:synthetic` är bitlika.

## 4. Koden

Leveransen ligger bara i spärrdelen: `_noteFixCadence` och `_silentHoldLimitMs` efter
`_blockedByEarlierBridge`, spärrblocket och två armfält i `_refreshArm`/`_arm`, och konstanterna.
Kärnan i `_silentHoldLimitMs` efter 229561e:

```js
if (!arm.earlierBridge || !moving || arm.fixIntervalsMs.length < 2) return Infinity;
if (vessel._fixDPendingReversal || this._courseAway(arm, this._targetBridges.get(arm.bridge))) return Infinity;
const gateMs = Math.max(EARLIER_BRIDGE_SILENCE_FACTOR × längsta intervallet, EARLIER_BRIDGE_MIN_SILENCE_MS);
const silenceMs = (now − ankare) + gateMs;
const toEarlierMs = e / sog;                                  // e = avstånd till den tidigare bron
const travelMs = toEarlierMs + (d − e) / max(sog, EARLIER_BRIDGE_BEYOND_KN);
return Math.max(silenceMs, travelMs − WARNING_LEAD_MS, toEarlierMs);   // 229561e: + toEarlierMs
```

Konstanter (BRIDGE_OPENING):
- `EARLIER_BRIDGE_SILENCE_FACTOR: 2` och `EARLIER_BRIDGE_CADENCE_WINDOW: 4`;
- `EARLIER_BRIDGE_MIN_SILENCE_MS = ceil(CLASS_B_STATIONARY_REPORT_MS / AISHUB_POLL_INTERVAL_MS) × (AISHUB_POLL_INTERVAL_MS + POLL_JITTER_MS)` = 3 × 70 s = 210 s. Klass B sänder var 180:e sekund under 2 kn, och AISHub tar emot den takten efter två eller tre pollar (130–140 eller 195–210 s);
- `EARLIER_BRIDGE_BEYOND_KN: 4` (rask kanalfart).

Varför spärren aldrig slutar tidigare än på c14938f före bron: c14938f:s gräns är
min(300 s, d/sog − 180 s). Den nya gränsen är min(300 s, d/sog − 180 s, L), där L ≥ e/sog. Den är
kortare bara när L < c14938f:s gräns, och då har hon i sin egen fart redan nått bron.

Värld 263: e = 202 m i 2,1 kn, alltså 187 s fram till bron och 187 + 125 − 180 = 132 s för restiden
minus 180 s, räknat från ankaret 15:02:56. Tystnadsgränsen är max(2 × 69, 210) = 210 s efter
mottagningen 15:03:05, och den är senast. Varningen går därför 15:06:35, 70 s före korsningen.

1511 + en poll: e = 372 m i 2,4 kn, alltså 301 s fram till bron. 19e87b5 släppte vid 301 + 125 − 180
= 246 s, 09:28:51. Nu gäller c14938f:s gräns på 300 s, köfixet kommer 274 s efter ankaret, och
spärren ankras om som på c14938f.

## 5. Regressionstester (i 19e87b5 och 229561e)

`tests/opening-earlier-bridge-silent-hold.test.js` har 20 fall och fem frusna fixturer. Fixturerna
för 263, 29, 1767 och 1089 har sha256 lika med världens radhash. 1511-fixturen är världen
(radhash c239b285bb5d…) med granskarens tillagda rad 09:20:16,911, och sanningen är densamma.
Kolumnerna är kopior av respektive kod med samma testfil (`V/D/matningar/efterbron2/test-mot-*.log`).

| Fall | c14938f | 19e87b5 | bara grind 210 s | bara egen fart | 229561e |
|---|---|---|---|---|---|
| 263-mekanismen (varning 676 s, ≥ 60 s före BRISEN:s ankomst) | röd | röd | grön | röd | grön |
| 263 genom replayRunner, med och utan monitoring (≥ 60 s) | 2 röda | grön | grön | grön | grön |
| kö under tystnad, glapp 204 och 269 s, 453 m före bron (= c14938f) | grön | grön | grön | grön | grön |
| **kö nära bron: 202 m, 2,1 kn, glapp 195 s (= c14938f, efter kön)** | grön | röd | grön | röd | grön |
| **kö nära bron: 300 m, 2,5 kn, glapp 195 s** | grön | röd | grön | grön | grön |
| **kö nära bron: 300 m, 2,5 kn, glapp 230 s** | grön | röd | röd | grön | grön |
| värld 29 och 1767 genom replayRunner: ingen varning före kön | grön | grön | grön | grön | grön |
| **värld 1511 + en poll, med och utan monitoring: ingen varning före köfixet** | grön | 2 röda | 2 röda | grön | grön |
| vändning under tystnad (enhet och värld 1089): ingen varning | grön | grön | grön | grön | grön |
| vakten: kurs bort eller väntande vändning ger samma spärr som c14938f | grön | grön | grön | grön | grön |
| smalhet: hörs som vanligt, ≥ 4 kn, kö bekräftad i senaste fixet, < 2 intervall | grön | grön | grön | grön | grön |

Röda fall: 3 på c14938f (263), 6 på 19e87b5, 3 med bara grinden, 2 med bara egen fart och 0 på
229561e. Varje skärpning har alltså ett eget fall som bara den klarar.

## 6. Samspel med andra familjer

- **B:** rör `_coverageVerdict` och fysikankomsten. D:s ändring ligger i `_silentHoldLimitMs` och konstanterna, och ingen rad är gemensam. 229561e går att cherry-picka på B:s 0b0a35d med 19e87b5 (granskarens 6f5d751) utan konflikt (`git merge-tree`, träd bfc35ab). I en kopia av det trädet är jest för D och B grönt (39 av 39 fall), och 263 är BORTA (`V/D/matningar/efterbron2/test-b-plus-d.log` och `repro263-b-plus-d.log`). `_courseAway` delas med B:s släppväg, men ingen av familjerna ändrar dess kropp.
- **A:**
  - Med A gäller spärren också på returresor, från fixet efter vändningen.
  - A:s ARCHITECTURE-mening "Spärrens avvägning är ägarfrågan M6" bör vid integrationen bli "M6 är avgjord (B med skärpningarna, familj D:s punkt ovan)".
  - Kör standardprofilen på A+B+D vid integrationen.
- **E:** orört. Registerposten SPÄRR-JVB-ACCELERATION (§9) behövs inte med B.

## 7. Beslut och dokument

- **U13:** inget låst facit flyttas.
- **U19:** vakten håller inte inne någon planerad varning. Den tar bara bort tidigareläggningen på antagen rask fart.
- **U17, U18, U22 och D1:** orörda.
- **Produktprincipen:** ingen variant ger en missad öppning. A ger en sen varning (44 s), och C ger för tidiga varningar före köer och en fantom.
- **Dokument i 229561e:** ARCHITECTURE-punkten (regeln, 210 s, egen fart, 1511, restfönstret), konstantkommentaren och docblocket för `_silentHoldLimitMs` (med restfönstret i siffror).

## 8. Beslut (M6): dirigentens val är B med omgranskningens två skärpningar

**Frågan.** Mellan Klaffbron och Stridsbergsbron ligger Järnvägsbron. Appen håller därför inne
varningen för Stridsbergsbron tills båten nästan är framme, räknat på hur fort hon går just nu.
Spärren infördes i september (a8d7b76) mot onödigt tidiga varningar för båtar som sedan blir
stående vid Järnvägsbron. Om appen inte hör båten en stund och hon samtidigt ökar farten efter
bron, kan varningen komma sent. I en av motorns 2 000 provvärldar kom den 44 s före passagen.
Målet är minst en minut, och helst två och en halv.

Alternativen som vägdes, med underlaget i §3:
- **A. Behåll dagens spärr.**
  - Vinst: inga varningar kommer tidigare.
  - Kostnad: den sena varningen (44 s) står kvar, och motorn behöver registerposten i §9.
- **B. EFTER-BRON med skärpningarna (vald).** Efter minst 210 s tystnad räknar appen med att båten
  kan öka farten efter Järnvägsbron. Spärren släpps aldrig innan hon i sin uppmätta fart har nått bron.
  - Vinst: den sena varningen kommer 70 s före. 9 varningar kommer tidigare (median 20 s), och en tunn varning blir minst 150 s.
  - Kostnad: ingen i banken, i motorns 2 000 världar eller i 1511-varianten. Restfönstret nedan står kvar.
  - Första versionen (19e87b5) gav 100 s och 38 tidigare varningar, men släppte spärren cirka 55 s
    innan båten i egen fart nådde bron. 1511-varianten varnades då 22 min för tidigt.
- **C. TYST-GOLV.** Efter drygt två minuters tystnad räknar appen med 4 kn hela vägen.
  - Vinst: 141 s, och 29 tunna varningar blir minst 150 s.
  - Kostnad: fyra köande båtar varnas för tidigt, två av dem 13 och 9 min, och en båt som vänder får ett falsklarm.

**Restfönstret, med siffror.** Regeln släpper spärren för Stridsbergsbron tidigare än c14938f bara
när tre villkor gäller samtidigt:
1. appen har inte hört båten på tystnadsgränsen, alltså minst 210 s;
2. hon skulle i sin uppmätta fart redan ha nått Järnvägsbron;
3. c14938f:s gräns (restiden i hennes fart − 180 s, högst 300 s) har inte löpt ut.

Har hon i stället stannat i en kö före bron, och första köfixet kommer inom det fönstret, går
varningen före köfixet där c14938f väntade ut kön. Villkor 2 och 3 går bara ihop under
257 m / 180 s = 2,8 kn. Fönstret är högst 257 m / sog − 180 s brett:

| Fart | 2,0 kn | 2,1 kn | 2,5 kn | ≥ 2,8 kn |
|---|---|---|---|---|
| Fönstrets största bredd | 70 s | 58 s | 20 s | inget |

- Kögridet (84 fall): 3 fall, alla med glapp 230 s i 2,0–2,1 kn och 202–250 m före bron. 19e87b5 hade 26.
- Motorns 2 000 världar: av 320 köer vid Järnvägsbron norrut ligger ingen i fönstret (§2), och körningen ger 0 varningar före en kö som c14938f väntade ut.
- Fältet: jämn AISHub-takt följd av 205 s glapp förekommer (219033332 i both-21h: 68/66/69/67 s, sedan 205 s och 1,1 kn). Det ligger inom grinden 210 s.
- Fönstret kräver alltså lågfart under 2,8 kn, ett glapp till köfixet på mer än tre AISHub-pollar och ett köfix som kommer först efter att hon i egen fart skulle ha passerat bron.

**Beslutet.** Dirigenten valde B med båda skärpningarna. Vinsten krymper från 38 till 9
tidigare varningar, och 263 får 70 s i stället för 100 s. I gengäld ger varken banken, motorns
2 000 världar eller 1511-varianten någon varning före en kö som c14938f väntade ut. Restfönstret
ovan är det som står kvar.

Produktprincipen säger att en missad öppning är värre än ett falsklarm. B tar bort den sena
varningen. Skärpningarna gör att spärren aldrig släpps tidigare än förut medan båten i sin uppmätta
fart ännu inte har nått bron.

## 9. Registerpost om beslutet ändras till A (behövs inte med B)

"SPÄRR-JVB-ACCELERATION" (KÄND_ÖPPEN, orakel T2 LEDTID<Ns). Motorfamiljen lägger till posten.

Predikat, alla villkor ska gälla:
- Båten hade passerat en bro och hade en opasserad öppningsbar bro mellan sig och målbron vid sitt sista fix före varningen.
- Varningen var hennes egen och avfyrades av ticken i tystnad, när spärren löpte ut: `t = ankare + d / sog − WARNING_LEAD_MS ± 1 s`, med sog ≥ 2 kn ur samma fix.
- Tystnaden var minst 2 × hennes längsta av de fyra föregående mottagningsintervallen.
- L0-farten vid korsningen var minst 1,5 × sog i sista fixet.

Källa: BOS:1303–1316, a8d7b76, TRIAGE-A §M6 och V/D/DESIGN.md §2–3.
