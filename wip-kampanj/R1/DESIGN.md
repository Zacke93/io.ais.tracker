# R1 – riktning och vändning: design (andra revisionen, efter omgranskningen)

Familj R1 i rättningskampanjen 2026-11-04. Kort: F10, W750, U-svängsreturerna i F01
och F15. Prototypen ligger i `K/R1/wt` (detached, ovanpå `7699cbe`) som fem commits:
- `89b47dd`: kod och tester (första prototypen);
- `a675979`: dokumentation;
- `34c2b57`: en kommentar i app.js:s journey-reset-hanterare;
- `9ea8de8`: första revisionen (långsam återkorsning, svepslåset bär svepets notiser);
- `dea1f1d`: andra revisionen (avsmalnat rörelsebevis för den långsamma återkorsningen,
  regressionstester för omgranskningens fall, U18 och U19 i dokumentationen).

HEAD är `dea1f1d`. Patchen ligger i `K/R1/patch.diff` (`git diff 7699cbe` utan
`bugHunt/` och `node_modules`).

K = `/tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad/kampanj`.
Radnummer utan annan angivelse gäller `7699cbe`.

## 0. Vad omgranskningen tog upp och vad jag gjorde

| # | allvar | issue | åtgärd |
|---|---|---|---|
| 1 | medel | Väntansregeln i `RE_CROSS_EVIDENCED` vände en väntande båt på ett enda GPS-sprang (AQUILA i 20260601-41h med en inlagd outlier, två syntetiska väntlägen) | **Rättat.** Rörelsebeviset för en långsam återkorsning kräver nu fyra villkor (`_slowReCrossEvidence`, §3.1): väntan sattes på segmentets startfix, korsningsfixet går självt i minst 1 kn, segmentet är minst 100 m och segmentets nettofart når 2 kn. Granskarens tre fixturer ligger i testerna och får inte vända. De ger nu exakt samma utfall som `7699cbe` (§2.4). Granskningens tidigare fall (långsam återkorsning efter väntan) bokförs fortfarande. |
| 2 | låg | Fråga 2: omfattningen var för snäv och det verkliga motexemplet saknades | Frågan är besvarad (U19). §13.2 redovisar båda sidorna: 3 varningar under väntan i de 26 världarna, alla onödiga, och 1 i verklig data (AIR), där varningen behövdes. Uppgifterna är kontrollerade mot rådata. Formuleringen är "första positionen i minst 2 knop som visar vändningen". |
| 3 | låg | Klassen är inte helt stängd; KÄND LUCKA-delfallen | Står kvar som eget kort. Avsmalningen lägger till två delfall i samma klass (korsningsfix under 1 kn, väntan äldre än startfixet), redovisade i §7.3 med bankens andel. Registerposterna med predikat finns i §14. |
| 4 | låg | FACIT: brotextövergångar 30 s tidigare i fem världar; "56 m före bron" lästes tvärtom | Båda rättade. FACIT.md har en rad om brotexten med mekanismen. Scenariokommentaren, VALIDATION.md och FACIT.md säger nu "54 m söder om Klaffbron (bron redan korsad)". |

Besluten U18 och U19 och dirigentens svar på R2:s frågor är inarbetade (§6, §13). De två
frågeavsnitten är nu beslutade avsnitt.

## 1. Sammanfattning i klartext

Tre rättningar, alla små.

1. **En båt som vänder och kör tillbaka under en bro får inte returpassagen bokförd.**
   Appen kräver två fixar i den nya riktningen innan den tror på en vändning
   (Anomali 18). Den andra fixen ligger ofta redan på andra sidan bron. När vändningen
   bekräftas städar appen listan över passerade broar, men bara broar *framför* båten.
   Bron som båten precis korsat tillbaka ligger *bakom* och blev kvar i listan. Därför
   trodde appen att bron redan var avklarad, och ingen kod bokförde returen.
   **Rättning:** när vändningen bekräftas tittar appen också på sträckan mellan de två
   fixarna. Korsar sträckan en bro i den nya riktningen släpps bron, och samma tick
   bokför returen.

2. **Samma fel när båten är långsam just när den passerar bron.** Är fixen på andra
   sidan bron långsammare än 2 knop, hoppar appen över den i vändningslogiken.
   **Rättning:** returen bokförs ändå i den tick då båten korsade bron, men bara när
   rörelsen syns i nuet: förra fixen visade vändningen i minst 2 knop, fixen på andra
   sidan går själv i minst 1 knop, sträckan är minst 100 m och båten har i snitt gjort
   minst 2 knop över den. En båt som ligger still och väntar kan inte ge det beviset med
   ett GPS-fel. Det var omgranskningens fynd: den första formen av regeln gick att lura.

3. **En båt som dyker upp igen efter ett långt glapp kan få fel riktning resten av resan.**
   Appen gissar riktningen ur nettoförflyttningen sedan sist. Har båten vänt i glappet
   pekar nettot åt fel håll, och låset prövas aldrig mer. **Rättning:** låset används
   för appens egna notiser om broarna i glappet (de passerades verkligen åt nettots
   håll) och släpps sedan, om båtens rörelsebevisade kurs säger motsatsen.

Ingen låst korpus ändras. Banken kör aldrig de nya vägarna (§6).

## 2. Rotorsaken, bekräftad med logg och minsta repro

### 2.1 F10, W750 och F13/r2: returpassagen bokförs aldrig

Kedjan har tre led:

1. **Fix D bekräftar på fixen bortom bron.** `VesselDataService.updateVessel` kör
   Fix D (rad 384–476) *före* all passagedetektering i samma tick (målbrogrenen börjar
   rad 487, mellanbrodetekteringen ligger längre ned). Första omvända fixen sätter
   `_fixDPendingReversal`; den andra anropar `_confirmDirectionReversal` (rad 468).
2. **N1-resetten räknar "framför" från nuvarande läge.** I `_confirmDirectionReversal`
   (rad 6735) släpps bara broar där `aheadInNewDir` är sant (rad 6777–6782). Kommentaren
   förutsätter att broar *bakom* båten är "nya benets nyss korsade", bokförda av
   korsningsbevis-reversalen i samma tick. I COG-grenen stämmer det inte: där har ingen
   bro bokförts i den nya riktningen ännu. Bron bakom är den gamla resans post.
3. **Ingen annan väg bokför korsningen.** `RE_CROSS_EVIDENCED` i
   `_handleIntermediateBridgePassage` (rad 6932–6981) bokför annars en återkorsad bro,
   men kräver `reCrossDir !== vessel._routeDirection` (rad 6971). Fix D har redan låst om
   riktningen, så villkoret är falskt och bron hoppas över. `applyInferredPassage`
   (rad 6880) kräver att bron saknas i `passedBridges`.

**Logg, minsta repro F10 (värld 353, HAVSORN):**

```
09:18:24 ⏳ [TARGET_RECALC_PENDING] Reversal → south observerad (cog=228°)      ← 58.28975, norr om Klaffbron
09:23:15 (L0) HAVSORN korsar Klaffbron söderut
09:26:25 🔄 [TARGET_RECALC] Direction reversed CONFIRMED (north → south, dist=1733m > 500)   ← 58.27946, söder om bron
09:26:25 🔁 [JOURNEY_RESET] … clearing … [Olidebron] (keeping [Klaffbron])
09:26:25 🚪 [TARGET_ASSIGNMENT] Söderut, söder om Klaffbron → lämnar kanalen, ingen målbro
```

**W750 (GUNHILD):** väntande fix 09:09:33 på 58.28478 (79 m norr om Klaffbron),
korsning söderut 09:10:01, bekräftelse 09:11:44 på 58.28194, "keeping [Klaffbron]".

**F10/r2 (värld 1731, KAJSA):** väntande 11:01:04 söder om Järnvägsbron, korsningar
Järnvägsbron 11:03:12 och Stridsbergsbron 11:04:57 norrut, bekräftelse 11:05:53 norr om
båda. Båda broarna ligger bakom, så resetten släpper ingenting. Följdfelet är F13/r2:
notisen 11:06:36 säger "närmar sig Stridsbergsbron, beräknad ankomst om 2 minuter",
99 s efter korsningen.

Alla elva världar i F10-klustret följer samma kedja (tabellen i §4).

### 2.2 Granskningens fall: långsam återkorsning mellan väntande fix och bekräftelse

Granskarens variant av F10 (`tests/fixtures/r1-f10-havsorn-langsam-aterkorsning.jsonl`):
samma resa, men med ett fix 09:24:00 150 m söder om Klaffbron i 1,5 kn mellan den
väntande fixen 09:18:24 och bekräftelsefixen 09:26:25.

```
09:18:24 ⏳ [TARGET_RECALC_PENDING] Reversal → south (cog=228°, 3,1 kn)       ← 630 m norr om bron
09:24:00 (1,5 kn, 150 m söder om bron)   Fix D: hoppas över (sog < 2)
                                         RE_CROSS_EVIDENCED: hoppas över (kräver 2 kn)
09:26:25 🔄 [TARGET_RECALC] CONFIRMED (dist=1733m > 500)
09:26:25 🔁 [JOURNEY_RESET] … [Olidebron] (keeping [Klaffbron])   ← segmentet 09:24→09:26 korsar inte bron
```

Det långsamma fixet avslutar korsningssegmentet, så varken Fix D eller fartkravet i
`RE_CROSS_EVIDENCED` (rad 6951–6957, "Rörelse i NUET: Fix D-tröskeln för finit fart") ser
korsningen, och bekräftelsesegmentet innehåller inte bron.

### 2.3 F15: svepets riktningslås omprövas aldrig

**Logg, minsta repro F15 (värld 451, IRMA, monitoring):**

```
11:22:00 sista fix före glappet: 58.27257, nordgående
12:05:03 återfödd: 58.28003, sog 4.9, cog 193.5°  (L0: vände i glappet, korsade Klaffbron söderut 12:01:55)
12:05:03 🔍 [SKIPPED_BRIDGES_CHECK] new-vessel, direction=north, lat-range=[58.2726,58.2800]
12:05:03 🧭 [SKIPPED_BRIDGES_DIRECTION_LOCK] route direction 'north' locked from evidenced sweep window
12:11:57 notis "IRMA har precis passerat Olidebron", riktning northbound   (L0: söderut)
12:17:41 notis Kanalinfarten, riktning northbound                          (L0: söderut)
```

`_checkSkippedBridgesFallback` i app.js sätter `_routeDirection` från svepets riktning när
låset saknas (rad 8522–8528). Svepets riktning är nettot sedan sist kända läge. Båten är
mållös, så Fix D körs aldrig (kräver målbro). Olidebron ligger inte i `passedBridges`, så
korsningsbevis-reversalen har inget att pröva. Låset står kvar, och `_getDirectionString`
läser låset före kursen. Den första granskningen visade att svepets EGEN notis måste
behålla svepets riktning (`unknown` vid kurs 271–314°, se §8.3).

### 2.4 Omgranskningens fall: en väntande båt vänds av ett GPS-sprang

Första revisionens regel (`9ea8de8`) godtog en korsning under 2 kn som rörelsebevis om det
fanns en färsk Fix D-väntan i korsningens riktning (upp till `FIX_D_PENDING_MAX_AGE_MS`,
15 min) och segmentet var minst 100 m. Båda signalerna kan komma ur en båt som ligger
still. Väntan kan sättas av en manöverrapport i 2 kn eller mer, och korsningen kan vara
en GPS-outlier. Fysikgrinden godtar en outlier på upp till 2 × 1 kn × dt när båda fixarna
går under golvet 1 kn, alltså 185 m på 180 s (`GPSJumpAnalyzer`, medelrörelsegrenen).

**AQUILA (265735370, korpus 20260601-41h, `tests/fixtures/r1-omgr-aquila-gps-sprang.jsonl`):**
AQUILA passerade Stridsbergsbron söderut 13:14:51 (gt-passages) och låg sedan 51–89 m
söder om bron i 0–0,1 kn. Granskaren lade in EN outlier 13:42:40.

```
13:37:08 sog 2,8 kn, kurs 44,6°, 85 m söder om Stridsbergsbron  ⏳ TARGET_RECALC_PENDING → north
13:38:38 sog 0,1 kn, 62 m söder om bron
13:39:40 sog 0,1 kn, 60 m söder om bron                ← segmentets startfix (väntan är två fixar äldre)
13:42:40 sog 0,1 kn, 59 m NORR om bron (outliern)      ← segment 118 m på 180 s, nettofart 1,3 kn
         9ea8de8: 🔁 [RE_CROSS_EVIDENCED] … (rörelsebevis: Fix D-väntan north + segment 118 m)
13:43:39 sog 0,1 kn, 70 m söder om bron igen
```

Med `9ea8de8` rensades målbron Klaffbron, Stridsbergsbron bokfördes norrut som mellanbro,
och brotexten visade "Inga båtar är i närheten …" 13:42:40–13:54:07 i stället för "En båt
på väg mot Klaffbron, beräknad broöppning om 11 minuter" (WARN INV-14W). Granskarens två
syntetiska väntlägen (`r1-omgr-vantlage-sprang.jsonl` och `-180s.jsonl`) gav en falsk
vändning söderut vid Järnvägsbron. I den första avfyrades en falsk bridge_opening_soon för
Klaffbron söderut (Klaffbron#4 10:35:58), och Stridsbergsbron bokfördes som mållös
mellanbro i stället för målbro.

**Rotorsak:** regeln flyttade "rörelse i nuet" (PIANO-regeln, rad 6951–6957) till en
observation som kunde vara upp till 15 min gammal, och den prövade inte om korsningsfixet
självt visade rörelse. S-F4 (helkodsgranskning-2026-07-01.md:48) säger att en ensam
outlier på 100–500 m hos en stillaliggande båt inte får bevisa något.

**Utfall med andra revisionen** (`K/R1/tmp/rev3/adv/`, jämförelse av notiser, passager,
varningar och brotext): alla tre fixturer är identiska med `7699cbe`; `9ea8de8` skiljer i
alla tre.

## 3. Rättningen på kodnivå

### 3.1 `lib/services/VesselDataService.js`

- **`_confirmDirectionReversal(vessel, newDir, reason, { reCrossSegmentStart = null } = {})`**
  (oförändrad sedan första prototypen): N1-resetten släpper också en bro bakom båten när
  `_evidencedCrossingDirection(vessel, reCrossSegmentStart, bro) === newDir`, alltså när
  bron ligger strikt mellan bekräftelsesegmentets ändpunkter och korsades i nya
  riktningen. Bron går med i det befintliga `vessel:journey-reset`-eventet, och loggraden
  får tillägget `(re-crossed <riktning> in confirming segment: [...])`.
- **`_cleanReCrossSegmentStart(vessel, oldVessel)`** (oförändrad): segmentets start som
  tickens detektering använder (`GPSJumpAnalyzer.passageSegmentStart`), eller `null` om
  något fix är GPS-flaggat. Segmentet skickas av Fix D:s bekräftelse och av
  positionsbevisets två ben. De tre korsningsbevisvägarna skickar inget och behåller sin
  bro (AKIRA).
- **`_hasFreshFixDPending(vessel, dir)`** (första revisionen, oförändrad): sant när
  `_fixDPendingReversal` har riktningen `dir` och är yngre än `FIX_D_PENDING_MAX_AGE_MS`.
  Fix D:s egen bekräftelse läser samma predikat.
- **Nytt i andra revisionen: `_slowReCrossEvidence(vessel, previousVessel, segmentStart, reCrossDir, segmentM)`.**
  Den ersätter första revisionens `pendingSameDirMoving`. `RE_CROSS_EVIDENCED` anropar den
  bara när fartkravet inte räcker (`speedMoving` falskt). Den returnerar
  `{ sogKn, netKn }` eller `null`, och alla fyra villkor måste hålla:
  ```js
  if (!segmentStart || segmentStart !== previousVessel) return null;           // (1)
  if (!this._hasFreshFixDPending(vessel, reCrossDir)) return null;              // (1)
  if (!Number.isFinite(segmentStart.timestamp)
      || vessel._fixDPendingReversal.time < segmentStart.timestamp) return null; // (1)
  const sogKn = GPSJumpAnalyzer.positionSog(vessel);
  if (sogKn === null || sogKn < constants.QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN) return null; // (2)
  if (!Number.isFinite(segmentM) || segmentM < 100) return null;                // (3)
  // (4): fixseparation, mottagningstid som reserv (samma regel som _northProgressMps)
  const netKn = (segmentM / 1852) / (dtMs / 3600000);
  if (netKn < 2.0) return null;
  ```
  1. **Väntan sattes på segmentets startfix**, och startfixet är förra fixet självt (inget
     GPS-återhämtningssegment). Anomali 18:s två observationer blir två på varandra
     följande fixar: omvänd kurs i minst 2 kn, sedan korsningen. Väntans tid är
     `Date.now()` i den tick som satte den, och startfixets `timestamp` är `Date.now()`
     när fartygsobjektet skapades i samma tick, så jämförelsen gäller samma klocka.
  2. **Korsningsfixet rör sig självt:** fixens egen fart (`GPSJumpAnalyzer.positionSog`,
     råfältet, inte det framförda sog-värdet) är minst `QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN`
     (1,0 kn). Det är appens befintliga transitgräns på råfixen, samma som
     `ProximityService._hasContinuingPassageJourney` läser. En outlier bär båtens verkliga
     fart, och den är nära noll hos en båt som ligger still.
  3. **Segmentet är minst 100 m** (vobbelskyddet, samma gräns som för fartgivarlösa båtar).
  4. **Segmentets nettofart når Fix D:s 2 kn.** Båten har gjort väg över hela segmentet i
     stället för att cirkla på stället.

  Loggraden får tillägget
  `(rörelsebevis: Fix D-väntan <riktning> på segmentets startfix, korsningsfixet <sog> kn, nettofart <netto> kn över <m> m)`.
  Inget annat i `RE_CROSS_EVIDENCED` är ändrat: bron ska ligga i `passedBridges`, strikt
  mellan segmentets ändpunkter, i motsatt riktning mot låset, och båda fixarna ska vara
  GPS-rena.

  **Inga nya trösklar.** 1,0 kn är `QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN`, 2 kn är Fix D:s
  gräns (samma literal som fartkravet bredvid) och 100 m är vobbelskyddet.

  **Utfall i granskningens fall och scenariot:** i `r1-f10-havsorn-langsam-aterkorsning`
  sattes väntan på startfixet 09:18:24 (3,1 kn, kurs 228°), korsningsfixet 09:24:00 går i
  1,5 kn, segmentet är 780 m och nettofarten 4,5 kn. Returen bokförs 09:24:00 som förut. I
  scenariot `u-sväng-långsam-återkorsning-efter-väntan` är vändfixen 06:17:30 startfixet
  (6,5 kn), korsningsfixet 06:21:00 går i 1,5 kn och nettofarten är 6,5 kn.

### 3.2 `app.js`

- **`_checkSkippedBridgesFallback`, låsblocket (första revisionen, oförändrat).** Den
  levande kursen läses först, `liveDirection = this._dedupDirection(vessel, { requireMovement: true })`.
  Sedan sätts låset som i `7699cbe`. Svepets egna steg, scenario B:s `applyInferredPassage`
  och notisloopen, körs med svepets riktning. Efter notisloopen släpps låset
  (`vessel._routeDirection = null`, logg `SKIPPED_BRIDGES_DIRECTION_LOCK_RELEASED`) om
  1. den levande kursen är rörelsebevisad (2 kn, Fix D:s band) och säger motsatsen, och
  2. låset fortfarande är svepets eget.

  **Valt beteende för kurs 271–314°:** det bandet är söder enligt Fix D (A1-1) men
  tvetydigt enligt tokenbandet (FP8). Släppet följer Fix D:s band. Senare notiser får då
  tokenen `unknown` tills kursen hamnar i ett entydigt band.
- **Journey-reset-hanteraren:** bara kommentaren är ändrad (första prototypen).

### 3.3 Tester

`tests/r1-usvang-aterkorsning-2026-11-04.test.js`, 34 fall (8 nya i andra revisionen):

- **N1-resetten (6).**
- **RE_CROSS, långsam återkorsning direkt efter Fix D:s väntande fix (10, varav 5 nya):**
  positivt fall (väntan på startfixet, korsningsfix 1,5 kn, 780 m på 300 s, loggraden med
  nettofarten); utan väntan; väntan i fel riktning, väntan äldre än 15 min och GPS-flagga;
  segment under 100 m. **Nya, var och en stoppar ensam:** väntan satt före startfixet
  (AQUILA-mönstret), korsningsfix under 1 kn (0,1, 0,5 och 0,9 kn), korsningsfix utan egen
  fart (det framförda sog-värdet räcker inte), nettofart under 2 kn (150 m på 300 s), och
  ett segment som börjar i en GPS-återhämtning. Plus det delade väntepredikatet.
- **Svepslåset (6).**
- **Helapp-replayer på kortens minsta repro och granskarens varianter (6).**
- **Helapp-replayer på omgranskningens fixturer (3, nya):** AQUILA (passagerna oförändrade,
  målet Klaffbron står kvar, ingen "Inga båtar" 13:40–13:55, texten 13:42:40 är "En båt på
  väg mot Klaffbron, beräknad broöppning om 11 minuter") och de två väntlägena
  (Stridsbergsbron bokförs som målbro, ingen varning söderut).
- **Kända luckor (3, dagens beteende):** två återkorsade broar i samma segment, tät
  långsam återkorsning och långsam vändning utan fix i 2 kn. Se §7.3.

Fixturerna i `tests/fixtures/r1-*.jsonl` är buggjägarens minsta repro, granskarnas
varianter och tre varianter härledda ur F10-fixturen. Omgranskningens tre fixturer
(`r1-omgr-*.jsonl`) är granskarens, oförändrade.

`runSyntheticScenarios.js` har två R1-scenarier (oförändrade utom kommentaren):
`u-sväng-gles-ais-återkorsning-i-debouncen` och `u-sväng-långsam-återkorsning-efter-väntan`.

**Bevis att testerna fäller den gamla koden** (testfilen och fixturerna kopierade till
rena `git archive`-kopior, `K/R1/tmp/rev3/tree-*`):

| kod | jest (34 fall) | syntetiska R1-scenarier |
|---|---|---|
| `7699cbe` | 13 fälls (samma 13 som förut); omgranskningens 8 nya fall går igenom, de är vakter mot bas | båda fälls ("bokförda passager av Klaffbron 1 < förväntade 2") |
| `34c2b57` (första prototypen) | 7 fälls | det långsamma fälls |
| `9ea8de8` (första revisionen) | 9 fälls: de 8 nya beteendefallen (5 enhetsfall och 3 helappsreplayer) och loggradens nya form i det positiva fallet | båda gröna |
| `dea1f1d` | 34 av 34 gröna | båda gröna |

Utdata: `K/R1/tmp/rev3/jest/r1-mot-7699cbe.full.txt`, `r1-mot-34c2b57.full.txt`,
`r1-mot-9ea8de8.full.txt` och `r1-ny.txt`. Synt-beviset mot `7699cbe` och `34c2b57` är från
första revisionen (`K/R1/tmp/rev2/synth-nyttskript-mot-*.log`); scenarierna är oförändrade.

## 4. Prövning mot alla världar i kortens kluster

Världarna återskapades med `K/R1/tmp/scripts/gen.js` (motorns `sampleWorld` och
`materialize`, bas-seed 1). **Andra revisionen ger exakt samma notiser, passager och
öppningsvarningar som första revisionen i alla 26 världar** (`K/R1/tmp/rev3/worlds-new/`
mot `K/R1/tmp/rev2/worlds-new/`, `K/R1/tmp/rev3/worlds-cmp-9ea8.txt`). Ingen värld
använder den långsamma vägen, så avsmalningen ändrar inget där.

**F10-klustret (11 världar) och F01:s U-svängar där returen bokförs:**

| värld | fartyg | U-sväng (L0) | återkorsning (L0) | väntande fix | bekräftelse | bokfört efter |
|---|---|---|---|---|---|---|
| 188 | 265806662 | 14:45:55 | Klaffbron syd 14:51:24 | 14:49:38 | 14:54:48 | Klaffbron 14:54:48 |
| 353 | 265196010 | 09:17:47 | Klaffbron syd 09:23:15 | 09:19:37 | 09:26:09 | Klaffbron 09:26:09 |
| 523 | 265232445 | 15:35:16 | Klaffbron syd 15:38:25 | 15:37:09 | 15:39:24 | Klaffbron 15:39:24 |
| 750 | 265739417 | 09:07:45 | Klaffbron syd 09:10:01 | 09:09:33 | 09:11:44 | Klaffbron 09:11:44 |
| 892 | 265133806 | 16:39:35 | Klaffbron syd 16:44:59 | 16:44:29 | 16:48:19 | Klaffbron 16:48:19 |
| 1044 | 265901498 | 09:27:10 | Klaffbron syd 09:30:07 | 09:28:55 | 09:30:40 | Klaffbron 09:30:40 |
| 1558 | 265902319 | 13:01:37 | Klaffbron syd 13:07:14 | 13:06:46 | 13:07:54 | Klaffbron 13:07:55 |
| 1680 | 265670027 | 12:59:24 | Klaffbron syd 13:02:42 | 13:02:12 | 13:03:20 | Klaffbron 13:03:20 |
| 1731 | 265781143 | 10:54:40 | Järnvägsbron nord 11:03:12, Stridsbergsbron nord 11:04:57 | 11:01:04 | 11:05:53 | Järnvägsbron, Stridsbergsbron 11:05:53 |
| 1927 | 265431281 | 13:16:59 | Klaffbron syd 13:20:48 | 13:17:34 | 13:23:34 | Klaffbron 13:23:34 |
| 1953 | 265603684 | 02:47:45 | Klaffbron syd 02:52:27 | 02:50:00 | 02:53:16 | Klaffbron 02:53:16 |
| 18 | 265731767 | 11:41:34 | Klaffbron syd 11:46:35 | 11:42:45 | 11:54:01 | Klaffbron 11:54:01 |
| 134 | 265119890 | 11:45:15 | Järnvägsbron nord 11:49:53, Stridsbergsbron nord 11:51:17 | 11:47:23 | 11:57:01 | Järnvägsbron, Stridsbergsbron 11:57:01 |
| 227 | 265533681 | 11:25:14 | Järnvägsbron nord 11:31:33 | 11:29:00 | 11:33:29 | Järnvägsbron 11:33:29 |

Före R1 var ingen av returerna bokförd. Alla nya bokföringar är mellanbropassager med
`no-target`, ligger efter den sanna korsningen och inom T10:s kopplingsfönster.

Övriga förändringar mot `7699cbe` (alla i hela världar):

- **1731:** Stridsbergsbron-notisen flyttar från 11:06:36 ("närmar sig … om 2 minuter")
  till 11:05:53 i passerad form. Det tar F13/r2.
- **1953:** returen över Klaffbron får en egen notis i passerad form 02:53:16, 99 m från
  bron (söder om den). Förut stoppade utresans dedupnyckel den. Det följer U14.
- **451 (F15):** Olidebron 12:12:07 och Kanalinfarten 12:17:51 bär southbound i stället
  för northbound. Kanalinfarten får passerad form, eftersom båten ligger 72 m söder om
  punkten. (I minsta repro är tiderna 12:11:57 och 12:17:41.)
- **Brotexten i 18, 134, 750, 1558 och 1927** (omgranskningen, issue 4): en övergång kommer
  30 s tidigare med samma text. Den bokförda returen ger statusbytet approaching → passed,
  och det utlöser en kritisk UI-uppdatering i vändningsticken i stället för vid nästa
  halvminutstick (värld 18: `UI_UPDATE_TRIGGER … status change approaching → passed`
  11:54:01; förut kom texten 11:54:31). Övriga 21 världar har identisk brotext
  (`K/R1/tmp/rev3/bt-bas-mot-ny.txt`).

Inga invarianter (fatala eller WARN) ändras och inga öppningsvarningar flyttas i någon av
de 26 världarna.

## 5. Övervägda alternativ

### 5.1 Returpassagen (F10)

| alternativ | varför inte |
|---|---|
| Räkna resetten från läget vid `TARGET_RECALC_PENDING` (triagens förslag 1) | Släpper också broar som korsats före bekräftelsesegmentet. De släpps då utan att bokföras, eftersom tickens detektering bara prövar sista segmentet. |
| Bokföra returen som målbropassage | Kräver en efterhandstilldelning som kringgår målbrogrindarna. `RE_CROSS_EVIDENCED` bokför redan återkorsningar som mellanbropassager, så valet ger en enda semantik. |
| Pröva `RE_CROSS_EVIDENCED` mot låset vid tickens början | Bredare: påverkar varje tick där låset ändras före loopen. Felet sitter i resettens premiss. |

### 5.2 Den långsamma återkorsningen (granskningens och omgranskningens fall)

| alternativ | varför inte |
|---|---|
| **Vald:** fyra villkor i `_slowReCrossEvidence` (väntan på startfixet, korsningsfixets egen fart ≥ 1 kn, segment ≥ 100 m, nettofart ≥ 2 kn) | Bokför i korsningsticken med rätt tid och notis i passerad form. Rörelsen syns i nuet: i förra fixet (omvänd kurs i 2 kn) och i korsningsfixet (egen fart). Granskarens tre fixturer blir identiska med `7699cbe`. Inga nya trösklar och inget nytt tillstånd. |
| Första revisionens regel (färsk väntan upp till 15 min + segment ≥ 100 m) | Vände en väntande båt på ett GPS-sprang (§2.4). |
| Granskarens avsmalning (korsningsfixet ≥ 1 kn och nettofart ≥ 2 kn, väntan fortfarande upp till 15 min) | Stoppar de tre fixturerna. Men en outlier ger alltid hög nettofart när dt är kort, så villkoret skyddar inte mot en gammal väntan: en båt som manövrerar i 1–2 kn med fixar emellan, och sedan får en outlier 60 s efter förra fixet, vänds fortfarande. Villkoret (1) stänger det. Nettofarten behålls som villkor (4), eftersom den skiljer en båt som gör väg från en som cirklar. |
| Bokföra returen först när nästa fix fortsätter i den nya riktningen (granskarens robustare alternativ) | Mest robust mot sprang, men kräver ett nytt fält i `_createVesselObject`:s bärlista och en bokföring utanför tickens detektering, och returen bokförs en fix för sent. Det är kortet U-SVÄNG-LÅNGSAM-ÅTERKORSNING (§7.3), som också skulle ta de kända luckorna. |
| Undanta båtar i väntläge (status waiting/under-bridge eller `_forceWaitingAtBridge`) | En äkta långsam returkorsning inom 300 m kan ha status waiting, så undantaget slår mot just det fall regeln finns för. Statusen har hysteres och släpar. Fartvillkoren (1) och (2) utesluter redan en båt som väntar i båda ändar. |
| Fysikalisk samstämmighet: segmentet högst k × rapporterad fart × dt | Med båda fixarnas fart blåser manöverrapporten upp gränsen (väntläget: 2,3 kn ger 284 m på 120 s mot sprangets 174 m). Med bara korsningsfixets fart fälls granskningens äkta fall (780 m mot 2 × 1,5 kn × 336 s = 518 m). Kräver dessutom en ny tröskel k. |
| Ta bort väntansvägen helt (tillbaka till `34c2b57`) | Öppnar granskningens medel-issue igen. |

### 5.3 Svepslåset (F15)

| alternativ | varför inte |
|---|---|
| Första prototypen: sätt inte låset alls när kursen motsäger | Svepets egen notis fick den levande kursens riktning: fel (söderut) för en glappassage som gick norrut och `unknown` vid kurs 271–314°. |
| Tokenbandet (135–270°) i stället för Fix D:s band i motsägelseprovet | Tar bort `unknown`, men låser då kvar svepets riktning för en båt som går söderut med kurs 290°. |
| Skicka en riktning per notis genom notisvägen | Rör N-familjens funktioner (`_triggerBoatNearFlowForBridge`, `_getNotificationDirection`, dedupvägarna). Stor risk för integrationskrockar. |
| **Vald:** sätt låset som förut och släpp det efter svepet | Svepets egna notiser och dedupposter får exakt samma riktning som i `7699cbe`. Bara det som händer efter svepet ändras. |
| Låsa den levande riktningen | Ett lås ur en enda kursobservation går emot Anomali 18:s anda. |

## 6. Användarbesluten och facit

- **U13 (facit):** ingen låst korpus flyttas. `replay:all` och `replay:openings` är rad för
  rad identiska med `7699cbe` bortsett från tider, och en verbose-körning av hela banken
  visar att ingen korpus kör de nya vägarna (§11). Inget har låsts om. Se FACIT.md.
- **U14 (notis per passage):** R1 levererar bokföringen, och notisen följer där
  besöksregeln släpper den (1953 och granskarens långsamma F10-variant). Avsmalningen
  minskar dessutom risken för falska returnotiser: en falsk retur hade gett en falsk notis
  med N:s ändring.
- **U15 (returens öppningsvarning):** R1 ändrar inga öppningsvarningar. Fem av F01:s
  U-svängsreturer är U15-fall (§7.1), alltså K2:s.
- **U16:** berörs inte.
- **U17 (RECOVER-släppets säkerhetsvarning):** K:s område; R1 rör inte
  `BridgeOpeningService`. Värld 227:s varning Klaffbron#3 är ett RECOVER-släpp (§9, §14).
- **U18 (två positioner står kvar):** Fix D är oförändrad. Sju av F01:s returer får ingen
  varning före korsningen, och det är nu en dokumenterad känd gräns
  (`docs/ARCHITECTURE.md`, U-svängspunkten). Registerposten finns i §14.1. §13.1 är det
  beslutade avsnittet.
- **U19 (ZELDA godtas):** deadlinemotorn är oförändrad; varningen skickas även när en
  obekräftad vändning väntar. Beslutet står i `docs/ARCHITECTURE.md`. Registerposten finns
  i §14.2. §13.2 är det beslutade avsnittet.
- **U20 (E2) och U21 (N):** berörs inte. R1 skapar ingen notis ur ett glapp: varje ny
  returnotis (1953, granskarens varianter) gäller en korsning mellan två levande fixar.
- **Dirigentens svar på R2:s frågor:** fråga 1 (JA: K1:s nordprogress avgör passerad form
  i BN2 när en återfödd båts kurs ligger mellan banden) gäller också återfödda båtar vars
  svepslås R1 släpper; de har inget ruttlås, och BN2 läser då R2:s nordprogress. Fråga 2
  (JA: 1227/1731 är rätt appbeteende) är R2:s; R1:s returer i 1731 bokförs med `no-target`
  och ger inget INV-13 (undantaget i `invariants.js:576–580`). Registerposten finns i §14.5.

## 7. Det rättningen inte tar, och varför

### 7.1 U-svängsreturerna i F01 (ingen öppningsvarning före returen)

De 13 U-svängsreturerna i F01 har tre mekanismer. Ingen av dem är bokföringen; varningen
ska komma *före* korsningen.

- **Fem fall absorberas i båtens egen äldre händelse** (130, 806, 829, 1007, 1428):
  U15/B02, alltså K2:s sak.
- **Sju fall har bara en omvänd fix i minst 2 kn före korsningen** (18, 134, 188, 227,
  353, 1181, 1731). Andra fixen kommer efter korsningen. **Beslutat (U18): Anomali 18 står
  kvar, och fallen är en känd gräns.** Mätt på världarna (`K/R1/tmp/rev3/u18pred.txt`):
  alla sju har exakt en omvänd fix i minst 2 kn mellan L0-vändningen och korsningen. De
  sex övriga returerna (K2:s fem och 1208) har två eller fler, och Fix D bekräftade
  vändningen före korsningen.
- **Ett fall bekräftar NEW_JOURNEY i tid men får ingen målbro i samma tick** (1208).
  Målbron sätts först på nästa fix, 13,5 minuter senare. Egen mekanism i app.js; föreslås
  som kort (§14.6).

### 7.2 F15:s andra fall (värld 188, varningen Stridsbergsbron#12 norrut)

Deadlinemotorn avfyrar 14:54:07 medan Fix D väntar på bekräftelsen av ZELDA:s vändning
(väntande fix 14:49:38, bekräftelse 14:54:48). ZELDA korsade aldrig Stridsbergsbron (L0).
**Beslutat (U19): varningen skickas som förut**, och motorn registrerar fallet som
godtaget (§14.2). Kortets minsta repro (451) ger BORTA.

### 7.3 Kända luckor i returens bokföring (eget kort, KÄND_ÖPPEN)

Granskningens fall och omgranskningens fall är stängda. Fem smalare delfall i samma klass
är kvar. De tre första har ett test som visar dagens beteende (KÄND LUCKA). De två sista
är avsmalningens pris och täcks av enhetsfallen i §3.3, som låser beteendet åt båda håll
(skyddet och luckan är samma predikat).

1. **Två återkorsade broar i samma segment** (`r1-kand-lucka-tva-broar-i-segmentet.jsonl`).
   `RE_CROSS_EVIDENCED` bekräftar vändningen på Stridsbergsbron. Järnvägsbron prövas
   sedan mot det nya låset och bokförs inte. Järnvägsbron och Stridsbergsbron ligger 210 m
   isär, så geometrin är inte exotisk. En rättning måste bokföra resten av segmentets
   återkorsade broar och vända loopens ordning till den nya riktningens, annars blir
   `lastPassedBridge` fel.
2. **Tät långsam återkorsning efter en väntan** (`r1-kand-lucka-tat-langsam-aterkorsning.jsonl`):
   varje korsningssegment är under 100 m.
3. **Långsam vändning utan fix i 2 kn före korsningen**
   (`r1-kand-lucka-gles-langsam-vandning.jsonl`): det finns ingen väntan när korsningen sker.
4. **Båten stannar direkt efter bron:** korsningsfixet går under 1 kn. I bankens
   rådatafacit går 8 av 790 verkliga linjekorsningar från minst 2 kn på startfixet till
   under 1 kn på korsningsfixet (`K/R1/tmp/rev3/gt/gtsog.txt`; till exempel SILJA vid
   Järnvägsbron i 20260610-19h, 2,9 → 0,8 kn, och fyra nordgående korsningar av Klaffbron
   i 0,6–0,8 kn). Ingen av dem är en U-svängsretur.
5. **Väntan äldre än startfixet:** båten rapporterade igen under 2 kn mellan vändningen och
   korsningen. Det är AQUILA-mönstret, så luckan är priset för skyddet.

Gemensamt: i korsningsticken finns inget rörelsebevis i nuet, så korsningen går inte att
skilja från brus vid brolinjen just då. **Förslag till kort (U-SVÄNG-LÅNGSAM-ÅTERKORSNING):**
spara en kandidat `{bro, riktning, tid}` när en GPS-ren återkorsning saknar rörelsebevis,
rensa den när båten korsar tillbaka eller när den blir äldre än `FIX_D_PENDING_MAX_AGE_MS`,
och bokför den via `registerConfirmedIntermediatePassage` när en vändning i samma riktning
bekräftas och bron ligger bakom båten. Kortet tar delfall 2–5. Ett ensamt sprang utlöser
det inte, eftersom kandidaten rensas när nästa fix ligger tillbaka på andra sidan bron.
Delfall 1 är en egen ändring i loopen.

**Hur vanligt är det?** Bland bankens 790 linjekorsningar (gt-passages) går 28 på ett
korsningsfix under 2 kn: 18 i 1–2 kn och 10 under 1 kn. Banken har 6 bekräftade
reversaler och ingen med en bro bakom sig. Buggjägarens körningar har inga T10-utslag kvar
i klassen (§11).

Övriga systerställen (oförändrat):
- **NEW_JOURNEY-vägen** (app.js:3042–3097) nollar `passedBridges` helt och har inte
  N1-felet. Den har 1208-luckan i §7.1.
- **Svepslåset med osäker kurs.** Är kursen osäker i första fixen efter glappet
  (östbandet eller under 2 kn) låser svepet som förut, och för en mållös båt finns ingen
  senare omprövning. Banken har 64 svepslås. Fem följs av rörelse åt andra hållet, alla
  ELFKUNGEN (265573130), och där är låset rätt när det sätts. Föreslås som kort (§14.6).
- **Det framförda sog-värdet i fartkravet.** `speedMoving` i `RE_CROSS_EVIDENCED` läser
  `vessel.sog`, som `_createVesselObject` för fram från förra fixet när raden saknar fart.
  Ett fix utan fart direkt efter en rapport i 2 kn uppfyller alltså fartkravet. Det fanns
  före R1 och är utanför R1:s ändring; den nya vägen läser råfältet. Föreslås som kort
  (§14.6).

## 8. Konflikter med dokumenterade beslut

### 8.1 Anomali 18, Anomali 5, S-F4 och PIANO-regeln

För att varna före returen i de sju fallen i §7.1 skulle appen behöva agera på en enda
omvänd fix. Det strider mot Anomali 18 (två observationer, VesselDataService.js:442–448,
ARCHITECTURE.md:849) och Anomali 5 (Fix D bara vid sog ≥ 2 kn). U18 bekräftar båda.
Andra revisionens `_slowReCrossEvidence` följer dem och S-F4/PIANO: två på varandra
följande observationer, båda med rörelse (omvänd kurs i 2 kn, korsningsfixets egen fart),
och ingen enskild outlier hos en stillaliggande båt räcker.

### 8.2 S10 och öppningsvarningarna

S10 gäller bara notiser om broar bakom båten. Varningen under en väntande vändning är
beslutad i U19 (§13.2). R1 ändrar inte S10.

### 8.3 SISU-låset (rättat i första revisionen)

Svepslåset infördes för att svepets notistoken inte skulle bli `unknown`
(helgranskning-2026-07-06.md:313–315). Revisionen sätter låset som förut under svepet, så
svepets egna notiser får alltid svepets riktning. Efter svepet släpps låset om den
rörelsebevisade kursen motsäger det. Senare notiser bär den levande kursens token, och vid
kurs 271–314° är den `unknown` tills kursen är entydig (FP8).

### 8.4 Den riktningsrelativa N1-resetten

Beslutet efter fältprov 3 var att inte dubbelnotifiera nya benets broar (AKIRA,
Järnvägsbron ×2; helgranskning-2026-07-06.md:305–307). R1 behåller det för
korsningsbevisvägarna. I COG- och positionsbevisvägarna har ingen bro bokförts i den nya
riktningen före resetten. Den långsamma vägen går genom korsningsbevisvägen och skickar
inget segment.

## 9. Samspel med andra familjer

| familj | delade funktioner | samspel |
|---|---|---|
| N (U14, U21) | `vessel:journey-reset`-hanteraren och notisdedupen i app.js; `TriggerPointVisitTracker` | R1 bokför fler returer som mellanbropassager med `no-target` och rensar returbrons dedupnyckel. Besöksregeln är orörd. Avsmalningen hjälper N: en väntande båt kan inte längre få en falsk retur genom ett GPS-sprang och därmed en falsk returnotis. N:s hunkar i app.js överlappar inte R1:s. |
| K2 (U15) | inga | Fem av F01:s returer är K2:s absorptionsfall. R1 ändrar inga öppningsvarningar. |
| K (U17) | `BridgeOpeningService` rörs inte | En mållös returpassage når inte `_recordPassage`. Värld 227:s varning Klaffbron#3 (T3 FANTOM-UTAN-AVBROTT, kortet F14) är ett RECOVER-släpp medan ZELDA:s vändning väntar. K:s grindar kan ta bort varningen; gör de inte det täcker U19-posten den (§14.2). |
| R2 | `_handleIntermediateBridgePassage` (R1 ändrar rörelsebeviset i `RE_CROSS_EVIDENCED` och lägger `_slowReCrossEvidence` efter `_hasFreshFixDPending`; R2 lägger `_releaseGateCandidateForBookedBridge` efter bokföringen längre ned), `registerConfirmedIntermediatePassage` (bara R2), BN2 i app.js (bara R2) | Inga kodhunkar överlappar. Varje retur som R1 bokför släpper också en kvarliggande grindkandidat med R2:s anrop. Efter svepslåsets släpp har en återfödd båt inget ruttlås, och BN2 läser den levande kursen eller R2:s nordprogress (dirigentens JA på R2:s fråga 1). R1 tar F13/r2; F13:s representant 86 är R2:s. 1227/1731-posten är R2:s (§14.5). |
| M, E, E2 | – | Inget delat. |

Integrationsordning: R1 är oberoende av K och K2. Kör N efter R1, så att U14 mäts på
returer som faktiskt bokförs.

**Provad sammanslagning** (första revisionen, `K/R1/tmp/rev2/applycheck/`): koden, testerna
och fixturerna i R2, N, K, K2 och E applicerade rent ovanpå R1. Andra revisionen ändrar
bara R1:s egna hunkar (`RE_CROSS_EVIDENCED`, en ny metod efter `_hasFreshFixDPending`,
R1:s testfil och nya fixturer, R1:s stycken i ARCHITECTURE.md och VALIDATION.md och en
kommentar i R1:s scenario). Textkrockar finns bara i dokumenten och i
`runSyntheticScenarios.js` (förväntnings- och scenariolistorna) och slås ihop för hand.

## 10. Dokument som ska uppdateras

Uppdaterat i patchen:

- `docs/ARCHITECTURE.md`, U-svängspunkten: N1-resetten med bekräftelsesegmentet, de fyra
  villkoren för den långsamma återkorsningen med omgranskningens skäl, de kända luckorna
  som eget kort, **U18** och **U19** som beslutade punkter (källan för registerposterna i
  §14.1–§14.2), och svepslåset med bandet 271–314°.
- `docs/ARCHITECTURE.md`, helgranskningsavsnittet 2026-11-03: returen bokfördes bara när
  bekräftelsen kom före bron.
- `docs/VALIDATION.md`: tabellraden (46 → 48 scenarier), rutnätet, `minPassagesPerBridge`,
  `slowZone.afterUTurnOnly`, och att returens första sampel ligger 54 m söder om Klaffbron.

Kvar för dirigenten:

- `docs/BUGGJAKT.md` och registret (motorn, utanför min skrivgräns):
  - markera F10, F15, F10/r2, F15/r2, F13/r2 och W750 som BORTA;
  - lägga in posterna i §14 (källorna finns i ARCHITECTURE.md efter integrationen);
  - registrera korten i §14.6.
- `docs/helgranskning-2026-07-06.md:305–315` är historik och ska inte skrivas om.
- `tests/replay-validation/corpora.js`: ingen not behövs, eftersom inget facit flyttas.

## 11. Mätningar och motorkontroll

Alla mätningar i `K/R1/wt` på `dea1f1d` (koden är densamma som i den ocommittade
arbetskopian där batteriet kördes). Loggar i `K/R1/tmp/rev3/batt/`.

| mätning | andra revisionen | jämfört med 7699cbe |
|---|---|---|
| `npm test` | 355 sviter och 4 812 tester: 4 809 gröna, 2 överhoppade, 1 fel | Felet är den otrackade motorns `bugHunt/__tests__/b-register.test.js` ("STRESS-TÄTHET: källfilen docs/BUGGJAKT.md finns inte" i worktree) och fälls likadant på `7699cbe`. Appens sviter är gröna, också R1-testet (34 av 34). Första revisionen hade 4 804 tester; skillnaden är de 8 nya fallen. |
| `npm run replay:all` | ✅ alla låsta korpusar matchar facit | identisk utdata utom tider (`K/R1/tmp/rev3/diff-replay-all.txt` tom) |
| `npm run replay:synthetic` | ✅ 48 scenarier rena | 46 identiska; båda R1-scenarierna fälls på `7699cbe`; rad för rad som första revisionen |
| `npm run replay:openings` | ✅ standardgrindarna godkända | identisk utdata ("38 varningar med okänd ordning" fanns redan) |
| `npm run replay:monitoring` | ✅ 72 h stabil, 0 processfel, `timersAfterShutdown` 0 | – |
| `npm run replay:phase` | ✅ 24 korpusar, 168 replayer, inget odokumenterat fasberoende | – |
| `REPLAY_MONITORING=1 npm run replay:phase` | ✅ samma | – |
| `npm run replay:phase -- <fixturer>` (omgranskningens tre och den långsamma F10-varianten), med och utan `REPLAY_MONITORING=1` | ✅ 4 korpusar, 28 replayer, gröna i båda lägena (`K/R1/tmp/rev3/phase-fixturer*.log`) | – |
| `npm run lint` | ✅ 0 fel | – |

**Banken, verbose** (24 korpusar med respektive monitoringflagga, `K/R1/tmp/rev3/bank-new/`):
0 `re-crossed … in confirming segment`, 0 `rörelsebevis: Fix D-väntan` och 0
`SKIPPED_BRIDGES_DIRECTION_LOCK_RELEASED`, mot 64 vanliga svepslås, 2 vanliga
`RE_CROSS_EVIDENCED`, 6 bekräftade reversaler och 13 Fix D-väntor
(`TARGET_RECALC_PENDING`). Banken kör alltså inte de nya vägarna, och minst 7 av 13 väntor
bekräftades aldrig (underlaget för §13.1).

**Världarna:** alla 26 identiska med första revisionen i notiser, passager och
öppningsvarningar (§4). Omgranskningens tre fixturer identiska med `7699cbe` (§2.4).

**Motorn:**
- `hunt.js --repro` på alla 42 kataloger (`K/R1/tmp/rev3/repro-new.txt`): F10, F10/r2,
  F13/r2, F15, F15/r2 och W750 ger BORTA. Alla andra 36 ger KVAR, bland dem F01, F01/r2,
  F12, F13, F14, B01 och B02. Utfallet är kort för kort detsamma som för första revisionen
  och första prototypen.
- `--profile=quick --out=K/R1/hunt-quick` mot `r1-quick-a`: 34 → 33 kluster och 88 → 87
  utslag. Det enda som försvinner är T10 PASSAGE-EJ-REGISTRERAD i värld 188 (F10-klustret).
  Inga nya kluster och inga nya utslag. Bankspåret (48 fasvarianter, 44 rena),
  S-KALIBRERING och världarnas radavtryck (`3b19a079680f`) är identiska. Mot första
  revisionens quick-körning (`K/R1/tmp/rev2/hunt-quick-9ea8de8/`) skiljer rapporten bara i
  HEAD, körnings-id och tider; kluster, utslag, register och täckning är identiska.
- Från första prototypen, oförändrat giltig eftersom världarna ger samma utfall:
  `--profile=standard` mot `r1-standard-a` gav 46 → 45 kluster och 420 → 406 utslag, med
  F10-klustret, T1 FÖRVARNINGSFORM i 1731 och båda T9-utslagen i 451 borta och inga nya.

Loggar: `K/R1/tmp/rev3/batt/`, `K/R1/tmp/rev3/repro-new.txt`, `K/R1/tmp/rev3/hunt-quick.log`,
`K/R1/hunt-quick/`, `K/R1/tmp/rev3/bank-new/`, `K/R1/tmp/rev3/worlds-new/`,
`K/R1/tmp/rev3/adv/` och baslinjerna `K/R1/tmp/batt-base/` och `K/R1/tmp/base/`.

## 12. Risker

- Latitudbeviset (`_evidencedCrossingDirection`) förenklar snedställda brolinjer. Samma
  förenkling finns redan i `aheadInNewDir` och i `RE_CROSS_EVIDENCED`.
- Returnotiser som förut stoppades av utresans dedupnyckel kan nu gå ut (1953, granskarens
  F15-varianter). Det är U14:s avsikt, men tillsammans med N:s ändring kan notismängden i
  fält öka.
- Kvar i den långsamma vägen: en båt som manövrerar i 1–2 kn och vars förra fix var en
  omvänd rapport i minst 2 kn kan fortfarande vändas av ett sprang över en passerad bro, om
  språnget är minst 100 m och ger nettofart 2 kn. Det kräver två samtidiga avvikelser i
  två på varandra följande fixar. Fartkravet bredvid (2 kn i korsningsfixet, oförändrat
  sedan före R1) har samma risk utan någon väntan alls.
- Avsmalningen lämnar två nya delfall obokförda (§7.3 punkt 4 och 5). En båt som vänder,
  korsar tillbaka och lägger till direkt efter bron får ingen returpassage.
- F15: senare notiser bär `unknown` så länge kursen ligger i 271–314° efter ett släppt lås.
- Under Fix D:s debounce bär en notis om en bro FRAMFÖR båten i den nya riktningen det
  gamla låsets riktning (1731: "närmar sig Järnvägsbron" 11:01:04 med `southbound`). Det
  följer av U18.

## 13. Beslutade frågor

### 13.1 Ska appen tro på en vändning redan efter en enda position? Beslut U18: nej

**Beslutet (2026-11-04):** Fix D:s krav på två positioner i rad innan en vändning tros
behålls (Anomali 18). Returer med gles AIS, där den andra positionen kommer först efter
korsningen, får varningen sent eller inte alls. Det är en känd gräns.

**Vad det betyder i praktiken.** ALVA (värld 18) vänder norr om Klaffbron. Nästa
position, 11:42:45, visar att hon kör söderut. Sedan hörs ingenting på 11 minuter. Hon
passerar Klaffbron 11:46:35 utan öppningsvarning, eftersom appen väntar på den andra
positionen. Samma sak gäller de sju returerna i §7.1.

**Varför beslutet håller.** I banken har 13 vändningar fått sin första position i minst
2 kn, och bara 6 har bekräftats (`K/R1/tmp/rev3/bank-new/`, samma siffror som granskarens).
Minst 7 bekräftades alltså aldrig. Bland dem finns AQUILA:s manöverrapport 13:37:08 och
AIR:s två 08:16:13 och 08:23:43 i 20260601-41h; båda båtarna fortsatte åt det gamla hållet.
En regel som trodde på en enda position hade kunnat ge varningar för fel bro i de fallen.

**Följder:** inga kodändringar. Beslutet står i `docs/ARCHITECTURE.md` (U-svängspunkten).
Motorn märker de sju fallen med en registerpost (§14.1), så att de inte blir nya kort.

### 13.2 Ska appen hålla inne en öppningsvarning när båten verkar ha vänt? Beslut U19: nej

**Beslutet (2026-11-04):** en planerad öppningsvarning skickas även när en obekräftad
vändning väntar. Varningen hålls inte inne och stryks inte.

**Fallet, steg för steg (ZELDA, värld 188):**
1. ZELDA kör norrut mot Stridsbergsbron, och appen planerar varningen.
2. Kl. 14:49:38 kommer den första positionen i minst 2 knop som visar vändningen (4,3 kn,
   kurs 207°). Positionen 14:46:07 visade den också, men i 1,1 kn, och sådana räknar
   appen inte.
3. Appen väntar på nästa position. Kl. 14:54:07 går varningen ut ändå.
4. Kl. 14:54:48 kommer nästa position, och vändningen bekräftas. ZELDA kom aldrig till
   Stridsbergsbron.

**Båda sidorna, med underlag (kontrollerat mot rådata):**
- **Buggjägarens 26 världar:** 3 varningar under en väntande vändning, alla onödiga:
  värld 188 (Stridsbergsbron#12 14:54:07), 227 (Klaffbron#3 11:32:52, ett RECOVER-släpp)
  och 353 (Stridsbergsbron#3 09:21:19) (`K/R1/tmp/rev3/u19pred.txt`).
- **Verklig data:** 1 varning under en väntande vändning, och den behövdes. AIR
  (265671650, korpus 20260601-41h) cirklade 114–231 m norr om Stridsbergsbron i väntan på
  öppning. Rapporten 08:23:43 (kurs 38°, 2,2 kn) satte en väntan. Klaffbron#29 gick
  08:28:43 medan appen väntade, och AIR passerade Klaffbron söderut 08:41:02 (gt-passages,
  observerad linjekorsning). Nästa position kom 08:31:14.
- **Hålla inne eller stryka:** att hålla inne till nästa position hade gett AIR varningen
  08:31:14, knappt 10 min före passagen. Att stryka den hade gett ingen varning alls.
  Med beslutet kommer den i tid.

**Följder:** inga kodändringar. Beslutet står i `docs/ARCHITECTURE.md`. Motorn registrerar
fallet som godtaget (§14.2).

## 14. Registerposter för dirigenten

Formatet följer `docs/BUGGJAKT.md` §7. Källorna pekar på `docs/ARCHITECTURE.md` efter
integrationen av R1 (U-svängspunkten) och på koden. Predikaten är nya; de bygger på
befintliga hjälpare (`spelaFixD`, `medFramfördKursOchFart`, `appKonstant`) i
`tests/replay-validation/bugHunt/lib/registry.js`. Predikaten för U18, U19 och 1227/1731
är provade på de 26 världarna med egna skript (`K/R1/tmp/rev3/scripts/u18pred.py`,
`u19pred.py` och `inv13pred.py`, utdata bredvid i `K/R1/tmp/rev3/`). KÄND LUCKA-posterna
har inga träffar i buggjägarens körningar efter R1; deras material är testfixturerna.

Gemensamt för de nya predikaten: kursbanden är S10-predikatets (`nordFrån` 315, `nordTill`
45, `sydFrån` 135, Fix D:s breda sydband), `fixDMinSogKn` läses med `appKonstant`
(`FIX_D_MIN_SOG` i `VesselDataService.js`) och `maxÅlderMin` är
`FIX_D_PENDING_MAX_AGE_MS` (15 min).

### 14.1 U18-EN-OMVÄND-FIX-FÖRE-RETUR (DESIGN, källa U18)

- **Gäller:** orakel `T2`, klassRegex `^ÖPPNING-MISS:OKLASSAD$`.
- **Klass:** DESIGN. U18 tillåter KÄND_ÖPPEN eller DESIGN; beslutet är fattat och
  beteendet avsett, så DESIGN.
- **Källa:** `docs/ARCHITECTURE.md` (U-svängspunkten, punkten U18, användarbeslut
  2026-11-04); `lib/services/VesselDataService.js:380–476` (Fix D, Anomali 5 och 18).
- **Predikat `enOmvändFixFöreRetur`** {fixDMinSogKn, maxÅlderMin, nordFrån, nordTill,
  sydFrån, vändningFöreMin: 30}: låt tK vara fyndets sanna korsning (`belägg.korsningT`)
  och riktningen fyndets. Låt tU vara båtens senaste L0-vändning före tK, högst
  `vändningFöreMin` tidigare. Spela `spelaFixD` över båtens rader med fixtid efter tU och
  `aisTimestamp` ≤ tK, med låset i motsatt riktning mot korsningen. Sant när spelet slutar
  med en flagga i korsningens riktning och ingen bekräftelse: Fix D hade sin första
  observation men inte den andra.
- **Regel:** "U18: Fix D tror på en vändning först efter två omvända positioner i minst
  FIX_D_MIN_SOG inom FIX_D_PENDING_MAX_AGE_MS. Kom bara den första före returens korsning
  kunde appen inte varna för returen i tid. Känd gräns, inte ett fel."
- **Placering:** efter U2-RETURRESA, U2-VS-DEADLINE, J13-J14-KONVOJSEMANTIK och
  O1-ACCEPTERADE-MISSKLASSER, så att K2:s poster prövas först.
- **Mätt:** sant i alla sju U18-världar (18, 134, 188, 227, 353, 1181 och 1731, alla i
  F01 i r1-standard-a), med exakt en omvänd fix i minst 2 kn mellan vändningen och
  korsningen. Falskt i de sex övriga U-svängsreturerna (130 med två båtar, 806, 829,
  1007, 1428 och 1208), där Fix D bekräftade vändningen före korsningen. K2:s fem och
  1208 står alltså kvar.

### 14.2 U19-VARNING-UNDER-VÄNTANDE-VÄNDNING (ACCEPTERAD, källa U19)

- **Gäller:** orakel `T9` (bara anspråk med `belägg.anspråk.slag === 'varning'`) och `T3`,
  klassRegex `^FEL-RIKTNING$|^FANTOM-UTAN-AVBROTT$`.
- **Klass:** ACCEPTERAD. U19 säger "godtaget": en onödig varning är priset för att ingen
  öppning missas, samma slag som FALSKLARM-AVBRUTEN-GLES.
- **Källa:** `docs/ARCHITECTURE.md` (U-svängspunkten, punkten U19, användarbeslut
  2026-11-04); `lib/services/VesselDataService.js:440–468` (`_fixDPendingReversal`).
- **Predikat `väntandeVändningVidVarning`** {fixDMinSogKn, maxÅlderMin, nordFrån,
  nordTill, sydFrån}: låt t vara varningens tid och båten fyndets (ledaren). Spela
  `spelaFixD` över båtens rader med `aisTimestamp` i (t − maxÅlderMin; t], med låset i
  varningens riktning. Sant när spelet slutar med en flagga i motsatt riktning, yngre än
  maxÅlderMin vid t, och ingen bekräftelse.
- **Regel:** "U19: en planerad öppningsvarning skickas även när Fix D väntar på den andra
  observationen av en vändning. Var vändningen äkta blir varningen onödig; det godtas."
- **Mätt:** sant för exakt tre varningar i de 26 världarna: 188 Stridsbergsbron#12
  14:54:07 (T9 FEL-RIKTNING, F15 i r1-standard-a), 227 Klaffbron#3 11:32:52 (T3
  FANTOM-UTAN-AVBROTT, F14 i r1-standard-a) och 353 Stridsbergsbron#3 09:21:19 (inget
  utslag). Falskt för alla andra varningar.
- **Samspel med K:** varningen i 227 är ett RECOVER-släpp (`OPENING_RECOVER … prövas som
  EGEN öppning`). Tar K:s grindar bort den, blir T3-delen oanvänd och kan strykas.

### 14.3 U-SVÄNG-LÅNGSAM-ÅTERKORSNING (KÄND_ÖPPEN, kända luckor 2–5)

- **Gäller:** orakel `T10`, klassRegex `^PASSAGE-EJ-REGISTRERAD$`.
- **Källa:** `docs/ARCHITECTURE.md` (U-svängspunkten, kända luckor);
  `lib/services/VesselDataService.js#_slowReCrossEvidence`;
  `tests/r1-usvang-aterkorsning-2026-11-04.test.js` (KÄND LUCKA och enhetsfallen för den
  långsamma vägen).
- **Predikat `returUtanRörelsebevis`** {fixDMinSogKn, transitKn: `QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN`,
  minSegmentM: 100, vändningFöreMin: 30, kursbanden}: korsningen ligger efter en
  L0-vändning av båten, högst `vändningFöreMin` tidigare. Låt a vara båtens sista rad före
  korsningen och b den första efter. Sant när korsningstickens segment saknar rörelsebevis
  så som `RE_CROSS_EVIDENCED` definierar det: b:s egen fart är under fixDMinSogKn, och
  inte alla fyra av följande håller: a har omvänd kurs i korsningens band med minst
  fixDMinSogKn, b:s egen fart är minst transitKn, avståndet a–b är minst minSegmentM, och
  avståndet delat med fixseparationen är minst fixDMinSogKn.
- **Regel:** "En U-svängares returkorsning utan rörelsebevis i korsningsticken bokförs
  inte: korsningen går inte att skilja från brus vid brolinjen just då, och ingen väg
  tittar bakåt när vändningen bekräftas."
- **Fråga:** "Ska en långsam återkorsning bokföras i efterhand när vändningen bekräftas
  (kandidat {bro, riktning, tid}, kortet U-SVÄNG-LÅNGSAM-ÅTERKORSNING)?"

### 14.4 TVÅ-ÅTERKORSADE-BROAR-I-SAMMA-SEGMENT (KÄND_ÖPPEN, känd lucka 1)

- **Gäller:** orakel `T10`, klassRegex `^PASSAGE-EJ-REGISTRERAD$`.
- **Källa:** som 14.3, testet "KÄND LUCKA: två återkorsade broar i samma segment".
- **Predikat `andraBronISammaSegment`** {vändningFöreMin: 30}: korsningen ligger efter en
  L0-vändning. Mellan samma två på varandra följande rader a och b korsar båten (L0) en
  annan bro i samma riktning, och appen har bokfört den bron vid b:s tid (±1 s).
- **Regel:** "RE_CROSS_EVIDENCED bokför bara den första återkorsade bron i ett segment;
  nästa prövas mot det nya låset och hoppas över."
- **Fråga:** "Ska RE_CROSS_EVIDENCED bokföra alla återkorsade broar i segmentet, i den nya
  riktningens ordning?"

### 14.5 MÅLBRO-TILLDELAD-VID-LINJEN (DESIGN, R2:s fall 1227/1731)

R2 äger analysen (`K/R2/DESIGN.md` §4 och §6). Förslaget här är mitt och ska stämmas av
mot R2:s.

- **Gäller:** orakel `INV-F`, inv `["INV-13"]`, klassRegex `^INV-13 MÅLBRO SOM MELLANBRO$`.
- **Klass:** DESIGN (dirigentens JA på R2:s fråga 2).
- **Källa:** beslutet ska först skrivas i `docs/` (R2:s patch eller dirigenten);
  `tests/replay-validation/invariants.js:568–595` (INV-13); rörelsebevisgrinden i
  måltilldelningen ("No movement proof yet … rejecting target").
- **Predikat `målbroTilldeladVidLinjen`** {radieM: 100, glappMin: `VESSEL_GRAVE.TTL_MS` (15),
  stillaKn: `MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN` (0,5)}: låt tc vara båtens senaste
  L0-korsning av bron före registreringen och r0 båtens sista rad med fixtid ≤ tc. Sant när
  (a) r0 är båtens första rad eller föregående rad ligger minst glappMin tidigare (född
  eller återfödd), och (b) r0 ligger inom radieM från bron eller har sog under stillaKn
  (inget rörelsebevis). Appen kunde då inte ha bron som mål när båten korsade linjen.
- **Mätt:** sant för 1227 (ELSA MARIA, första raden 11 m från bron, 1 s före korsningen)
  och 1731 (KAJSA, återfödd efter 44 min 92 m norr om bron i 0,0 kn). Falskt för 254
  (JOLLY), R2:s egentliga dubbelbokföring. R1:s egna returer i 1731 bokförs med
  `no-target` och ger inget INV-13.

### 14.6 Kort och statusar (inga poster)

- **BORTA:** F10, F10/r2, F13/r2, F15, F15/r2 och W750.
- **Kvar som KANDIDAT, föreslagna kort:**
  - 1208: NEW_JOURNEY bekräftas i tid men målbron sätts först på nästa fix (T2
    ÖPPNING-MISS:OKLASSAD i F01). En appändring, ingen post.
  - Svepslås med osäker kurs (§7.3, övriga systerställen). Ingen träff i körningarna.
  - Det framförda sog-värdet i `RE_CROSS_EVIDENCED`:s fartkrav (§7.3). Fanns före R1.
    Ingen träff i körningarna.
