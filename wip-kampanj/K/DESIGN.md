# K-familjen — konvoj och öppning: design (revision 3)

Rättningskampanjen 2026-11-04, tredje revisionen 2026-11-05. Korten i `r1-standard-a` är F01
(representanten värld 1900 och r2-världen 1349), F02, F03, F11, F14, F17, F20, F22 och F23. All kod ligger
i `lib/services/BridgeOpeningService.js`. Prototypen är committad i `K/wt` (detached på 7699cbe):

- 4c8cca3, 94d573f, 90a63c6: första rundan;
- 44bc3c2, 3400fa5: revision 2 (golvet, övre gränsen, nollställningen, testerna);
- **7b520c2: revision 3, alternativ A.** Korsningsankaret bakåtskattar vid väntan före bron (W2),
  systerstället i `observeVessel`, test för golvets medlemsvillkor, sakfelen. Täckningsslutet räknas
  här från korsningen, och 25h är omlåst i arbetsträdet;
- **3707636: revision 3, prototypen.** Täckningsslutet räknas från bokföringen (U13). 25h och dess not
  är återställda till 7699cbe;
- **1b4c9a3:** testkommentarerna hänvisar inte till filer utanför repot;
- **f8aa77e:** under-bron-beslutet står i ARCHITECTURE.md, och K2:s returgolv är struket ur golvets
  text. **HEAD är f8aa77e.**

Leveranser i K/:
- `patch.diff` = `git diff 7699cbe f8aa77e`, utan bugHunt och node_modules;
- `alt-korsningstackning.diff`: alternativ A. Appliceras ovanpå `patch.diff`, med kod, test, golden-events,
  not och ARCHITECTURE-text. Kontrollerat med `git apply` på en ren 7699cbe;
- `FACIT.md`;
- `alt-coverbook.diff` är borttagen. Prototypen gör samma sak för låst facit men behåller PRINCESS
  LIZYMAR:s rättare varning, så den dominerar.

**Status: klar.** Alla beslut är fattade (§0). Det finns inga öppna frågor till ägaren.

## Kort sagt

När flera båtar närmar sig en bro samtidigt skickar appen **en** öppningsvarning för hela gruppen. De båtar
som hänger på kallas "täckta". Har en täckt båt inte passerat när konvojfönstret (10 min) är slut, får
hon en egen varning (RECOVER-släppet).

Rättningen gör fyra saker:

1. **Vem som hör till öppningen räknas från när passagen skedde (F01),** inte från när appen fick veta
   om den. Efter ett AIS-avbrott kunde det skilja 12 minuter, och då svaldes nästa öppning.
2. **En färsk position som visar att båten kommer efter öppningen släpper henne direkt (F02, F17, F22).**
   Hon varnas med full ledtid i stället för i sista stund.
3. **Tystnad tolkas inte som "inte passerad"** när båten senast sågs under bron eller på väg bort
   (F03, F14, F20). Appen väntar på nästa position.
4. **En tyst båt får sin säkerhetsvarning vid samma tid som förut.** Den tiden räknas fortfarande från
   bokföringen. Banken kan inte visa vilken tid som är rätt för en tyst båt, och då får ett låst facit
   inte flyttas (U13).

Nytt i revision 3:
- **Passagetiden efter en väntan vid bron.** Visar båtens sista position före bron att hon låg stilla
  i kön, räknas passagen bakåt från första positionen efter bron. Förut lades den mitt i väntan, upp
  till 13 minuter för tidigt.
- **Punkt 4 ovan.** I revision 2 räknades även en tyst båts säkerhetsvarning från passagen. Det flyttade
  en låst varning i 25h, och rådatan kunde bara visa att den nya tiden var lika bra, inte bättre.
  Varianten finns kvar som alternativ A, färdig och mätt, om dirigenten vill göra ett undantag.

## 0. Beslut som styr revisionen

### 0.1 F11/F23, den tysta båten — U17 (ägarbeslut 2026-11-04)

RECOVER-släppets säkerhetsvarning för en tyst båt **behålls**. Det gäller när hennes senaste position sa
att hon skulle hinna igenom den gemensamma öppningen, men appen inte vet om hon gjorde det. F11/F23-klassen
är ett falsklarm av samma slag som AVBRUTEN_APPROACH, och motorn registrerar den som DESIGN med källa U17.
- Därför är färskhetskravet i KRAV (2) och ledtidsgolvet i KRAV (3) inte införda (§4).
- Prototypen ändrar inte heller tidpunkten för den varningen (§2.7).
- Registerposten och dess predikat står i §10. Predikatet är omarbetat efter omgranskningen och täcker
  nu alla påstådda fall.

### 0.2 Under-bron-hållet — dirigentens beslut 2026-11-05

En tyst båt som senast sågs högst 50 m från bron (`UNDER_BRIDGE_SET_DISTANCE`), i rörelse
(≥ `MINIMUM_VIABLE_SPEED`) och med ankomst inom täckningen, **hålls tills nästa position kommer**. Det
strider inte mot U17: hon är vid brolinjen och har i praktiken passerat. Visar nästa position att hon
ändå inte passerat, släpps hon som förut.
- Så fungerar prototypen sedan revision 1 (`_coverageVerdict` (1c)), och testen för F03 och F20 låser
  beteendet.
- F03 och F20 är därmed **BORTA**, inte DESIGN.

### 0.3 Korsningsankaret och 25h-raden — dirigentens beslut 2026-11-05

Dirigenten beslutade två saker:
- Inför granskarens W2: när fixet före bron visar en stilla eller köande båt bakåtextrapoleras korsningen
  ur fixet efter bron. Räkna sedan om 25h-raden.
- En låst rad får låsas om bara när den är rättare mot rådata (U13). En likvärdig rad ska undvikas genom
  designen, eller redovisas tydligt med alternativen.

**Så har jag följt beslutet:**
1. **W2 är infört** (§2.1), med en skärpning som granskaren bad om: fallet med ett långsamt fix efter
   bron (§3.4).
2. **25h räknades om.** Med W2 skattas MALUCAs korsning till 08:24:15,9 i stället för 08:19:39,6.
   Varningen för LAENGE LAEUFT hade kommit 08:34:15 i stället för 08:37:18. Raden är fortfarande
   **likvärdig** mot hennes passage (FACIT §4.1). Rådatan belägger var fönstret slutar, men inte när
   hon passerade.
3. **Raden undviks genom designen.** Täckningsslutet räknas från bokföringen som på 7699cbe (§2.7).
   Korsningen styr bara medlemskapet och bakkanten, och det är där rådatan kan belägga en förbättring
   (PRINCESS LIZYMAR, rättare).
   - Inget låst facit flyttas.
   - Alla K-kort blir som förut: BORTA respektive DESIGN.
4. **Alternativet redovisas** (§3.5): alternativ A, med täckningsslutet från korsningen. Det är bättre
   för tysta båtar som hörde till nästa öppning, men sämre för tysta båtar som passerade med den
   gemensamma öppningen. Det flyttar 25h och kräver ett uttryckligt undantag från U13. Jag rekommenderar
   det **inte** under U13, men det ligger färdigt i `K/alt-korsningstackning.diff`.

## Omgranskningens anmärkningar och vad som är gjort

| # | Allvar | Anmärkning | Åtgärd |
|---|---|---|---|
| 1 | medel | Korsningsankaret interpolerar genom en synlig väntan; 25h och U2-fönstret blir fel | **Rättat** (§2.1): max(rät linje, bakåtskattning ur fixet efter bron i dess fart), och utan mätbar fart efter bron den räta linjen. Snabbprofilens 32 väntefall: median −101 s och värst −780 s med linjen, median −1 s och spann −90…+30 s med regeln. Granskarens sond p2 är regressionstest. 25h räknades om och undviks genom designen (§0.3). |
| 2 | låg | 25h-omlåsningen är villkorad; alternativet saknade dokumentation | **Löst genom designen.** Prototypen låser inte om 25h. Alternativ A har kompletta dokument- och docblockändringar. Hänvisningen till kampanjens K-underlag är borttagen ur ARCHITECTURE.md, och testkommentarerna hänvisar inte längre till filer utanför repot. |
| 3 | låg | Systerställe: observeVessel använder inte `_crossingUpperBound` | **Rättat.** `_crossingEstimate(...) ?? _crossingUpperBound(arm, now)`. Granskarens sond p1 är regressionstest. 0 fall i banken och snabbprofilen, som granskaren mätte. |
| 4 | låg | Bakkantens pris i R0-världen 295 (HAVSORN) är beskrivet som en för pessimistisk prognos | **Omskrivet** i docblocket, ARCHITECTURE.md och §9: en andrapåminnelse i R0 som bryter mot U2, registrerad som KÄND_ÖPPEN U2-VS-DEADLINE. Granskarens B1 gav 5 nya utslag, så valet står. |
| 5 | låg | r2-representanter saknas; U17-predikatet täcker inte de påstådda världarna | **Rättat.** Alla r2 redovisas (§7.4). Predikatet bygger inte längre på fixålder utan på U17:s ordalydelse: tyst över korsningen, och korsningen inom fönstret efter den gemensamma öppningen. Det är prövat fall för fall (§10.1). |
| 6 | låg | Golvets medlemsvillkor saknar fällande test (X8) | **Test skrivet** där villkoret ensamt avgör: ankomst 10 s efter bokföringen + 600 s, under den gamla täckningens sista minut. X8 (R10) fälls. |
| 7 | låg | Sakfel: 25h 08:25:25, LINNEA 08:41:50, `_crossingWithoutFixBeyond` | **Rättade**: 587 m i 8,5 kn ger 08:26:31; LINNEA varnades 08:42:16,654; kommentaren pekar på `_crossingUpperBound`. |
| 8 | låg | U17-läsningen för under-bron-hållet behöver bekräftas | **Bekräftad** av dirigenten (§0.2). |

## 1. Rotorsaken, bekräftad med minsta repro och verbose-logg

§1.1–1.4 gäller sedan första rundan. Loggarna ligger i `K/tmp/rr/`, `K/tmp/probe/` och `K/tmp/rev/`.

### 1.1 Glappregistreringen (F01, värld 1900)

- `_recordPassage` (7699cbe `:1743–1760`) satte `firstPassageAt = referenceArrivalMs = now`, alltså
  bokföringstiden.
- I värld 1900 var ORIONs sista fix före avbrottet 72 m före Klaffbron. Avbrottet varade 09:13:27–09:26:11,
  och passagen bokfördes 09:26:22. ULLA absorberades 09:26:23 och korsade 09:31:35, 1069 s efter ORIONs
  korsning, utan egen varning.
- I banken ligger bokföringen median 109 s efter den skattade korsningen, p90 625 s och max 1643 s.

### 1.2 RECOVER-släppet på ren tid (F03, F14, F17, F20, F11, F23, F01:s r2)

`_releaseStrandedArms` (7699cbe `:1648–1666`) släppte varje absorberad arm när `now > coverUntilMs`, och
armen avfyrade direkt på sin förfallna deadline:

| Kort | Båt | Läge | Fixålder | Utfall |
|---|---|---|---|---|
| F03 | ELSA MARIA | 23 m, 7 kn | 28 s | varnad 22 s efter korsningen |
| F20 | YRSA 2 | 25 m, 7 kn | 273 s | varnad 268 s efter korsningen |
| F17 | PELLE | 14 m, 5,6 kn | 22 s | varnad 18 s efter korsningen |
| F14 | ZELDA | 699 m, cog 32,8° (beväpnad söderut) | 213 s | fantom; hon hade vänt |
| F11 | QUEST | 1397 m | 20 min | kedja #4 → #5 → #6 |
| F23 | ALVA | 2391 m | 21,7 min | kedja #3 → #5 → #6 |

### 1.3 Bakkanten (F02, F22, F17, F01:s r2)

Medlemskapet prövades bara vid täckningsslut. F22: SALTIS släpptes 255 m från bron med 54 s ledtid. F02:
släppt 195 m från bron med 47 s ledtid.

### 1.4 Värld 227 (revision 2)

ZELDA:s retur upptäcktes 13 m före Stridsbergsbron, 10 s efter korsningen. Mot bokföringen hörde hon till
`#1`, mot korsningen inte, och hon fick en egen varning efter passagen. Golvet (§2.5) rättade det.

### 1.5 Nytt i revision 3: interpolationen genom en väntan

`_crossingEstimate` interpolerade linjärt mellan armens fix före bron och fixet bortom den, även när fixet
före bron visade en stilla eller köande båt. Den räta linjen antar jämn fart och lägger korsningen mitt i
väntan.
- **Minsta repro** (granskarens sond p2, nu testet "bakåtskattning ur fixet efter bron"): ledaren står
  still 100 m före bron T0+120 s, korsar T0+720 s, och nästa fix kommer T0+840 s, 370 m bortom bron i
  6 kn. Linjen gav T0+273 s. En båt som kom 407 s efter den verkliga korsningen, alltså samma öppning
  enligt U2, fick en andra varning. Med regeln blir korsningen T0+720 s, och hon absorberas.
- **25h** (`K/tmp/r3/logs/25h-w2m.log`): MALUCA hade sog 0,1 kl 08:14:16 i Järnvägskön, 403 m före
  Stridsbergsbron. Nästa fix kom 08:27:18, 574 m norr om bron i 6,1 kn. Linjen gav 08:19:39,6, och
  bakåtskattningen ger 08:24:15,9. Det stämmer med IDUN och NICOLINE ur samma kö.
- **Värld 82** (snabbprofilen): ALVA ankrades 431 s för tidigt efter väntan vid Järnvägsbron. Med
  regeln blir korsningen 09:34:47,7, mot sanningens 09:34:52 (`K/tmp/r3/worlds/w82-R1-headB.log`).

## 2. Rättningen på kodnivå

### 2.1 Korsningstiden (F01, revision 3)

- `observeVessel` steg 1 anropar vid `reason === 'passage'`:
  `_recordPassage(bridge, arm, now, _crossingEstimate(...) ?? _crossingUpperBound(arm, now))`.
- `_crossingEstimate` beräknar först den räta linjen mellan armens senaste tillämpade fix före bron och
  fixet bortom den: `t = t_före + (t_efter − t_före) · d_före / (d_före + d_efter)`, med
  `min(fixTs, timestamp)`.
- **Väntan före bron** (nytt). Visar fixet före bron en köande båt (`arm.waitingAtBridge`) eller en
  båt under `MINIMUM_VIABLE_SPEED`, och har fixet efter bron en fart över `MINIMUM_VIABLE_SPEED`, gäller
  `min(t_efter, max(linjen, t_efter − d_efter / v_efter))`.
  - **Varför max med linjen.** En båt som låg stilla och sedan accelererade har en konvex väg i tiden.
    Korsningen ligger då aldrig före den räta linjen. Ligger bakåtskattningen före linjen har hon saktat
    in efter bron, och då bär farten inte skattningen.
  - **Varför fartgränsen.** Under `MINIMUM_VIABLE_SPEED` är farten brus, och ETA-vägen räknar inte på
    den. Linjen gäller då, inte bokföringen: i snabbprofilens två sådana fall var linjens fel +8 och
    −17 s, bokföringens +214 och +52 s.
- Funktionen ger `null` när riktningen saknas, när fixen inte ligger på var sin sida, när armen är fryst
  eller när tiderna är orimliga.
- **Övre gräns (nytt i observeVessel).** Ger `_crossingEstimate` `null` och låg armens senaste tillämpade
  läge redan bortom bron, används det fixets tid. Samma regel som notePassage och passagedomen (§2.4).
- `_recordPassage` sätter `firstPassageAt = referenceArrivalMs = korsningen` och
  `firstPassageRegisteredAt = now`. Medlemskapet (`_belongsToEvent`) och bakkanten mäts mot korsningen.
  `lastPassageAt` och täckningsslutet (§2.7) är fortfarande bokföringstiden.

### 2.2 Släppvägens dom: `_coverageVerdict`

- **Bakkanten,** före täckningsslut. Armen släpps när alla dessa gäller:
  - händelsen har en bokförd första passage;
  - armen har tillämpat ett rent fix efter bokföringen;
  - armen är inte fryst;
  - prognosen ligger efter **fönstrets slut**, kursen leder inte bort.

  Fönstrets slut är det som kommer först av täckningsslutet och U2-fönstret kring korsningen,
  `max(firedAt, firstPassageAt) + CONVOY_WINDOW_MS` (revision 3). En golvhållen arm mäts bara mot
  täckningsslutet (§2.5). Hon varnas sedan på deadlinen ur samma fix.
- **Täckningsslut:**
  - bron bakom läget ⇒ `passage`;
  - hold (nästa fix avgör) om armen är fryst, om ankomstfysiken saknas, om hon låg under bron (§0.2)
    eller om kursen leder bort (`_courseAway`);
  - annars släpps hon (U17).

### 2.3 `_scheduleNextDeadline`

Ingen timer bokas för en hållen arm (`recoverHeldAt ≥ coverUntilMs`). Oförändrat.

### 2.4 Övre gräns för korsningstiden: `_crossingUpperBound`

Ligger armens senaste tillämpade läge redan bortom bron, skedde korsningen före det fixet. Fixets tid är
då en säker övre gräns. Den används nu av passagedomen, notePassage och `observeVessel` (§2.1). Annars
gäller bokföringstiden (§3.3).

### 2.5 Korsningsankarets golv: `_anchorFloorHost`

I `_bindLooseArms`, när en lös arm saknar värd (varken `host` eller `wideHost`), absorberas hon som före
rättningen om **alla** villkor gäller:
- armen tillämpade ett rent fix i just den här utvärderingen och är inte fryst;
- hennes förväntade ankomst ligger närmare än 2 × `TICK_INTERVAL_MS`;
- det finns en avfyrad händelse där hon inte är släppt och leveransen inte har misslyckats;
- händelsens korsning ligger före bokföringen, och den gamla täckningen lever;
- hon hör till händelsen mätt mot bokföringen. Villkoret har nu ett eget fällande test (X8).

Revision 3 lägger till att golvets händelse sparas i `arm.anchorFloorEventId`. Bakkanten mäter då en
golvhållen arm mot täckningsslutet. Mot U2-fönstret hade hon släppts direkt, eftersom golvet absorberade
henne just för att hon låg bortom det fönstret. Mutationen R2 visar det: utan undantaget faller
ZELDA-testet (värld 227-klassen, där revision 2 mätte att T3-utslaget kom tillbaka).

### 2.6 Hållskälen nollställs vid varje ny absorption

`recoverHeldAt` och `recoverHoldReason` nollställs där `_bindLooseArms` sätter `absorbedAt`. Oförändrat
(mutationen R11 fälls).

### 2.7 Nytt i revision 3: täckningsslutet räknas från bokföringen

- **I `_bindLooseArms`** räknas en absorberad arms täckning som
  `max(firedAt, coverRef) + CONVOY_WINDOW_MS`.
  - Efter första passagen är `coverRef = firstPassageRegisteredAt`, alltså när passagen blev känd.
  - Före den är `coverRef` prognosen (`referenceArrivalMs`).
  - Det är exakt 7699cbe:s värde.
- **I `_recordPassage`** rebaserar K14 på `now`, som på 7699cbe.
- **Följden:** en TYST båt släpps vid samma tid som förut. Det är när U17:s säkerhetsvarning kommer.
  Allt som en färsk position kan belägga mäts mot korsningen:
  - vem som hör till öppningen (F01, ULLA);
  - bakkanten (F02, F17, F22, PRINCESS LIZYMAR).
- **Varför.** Med täckningen räknad från korsningen (alternativ A) flyttades den låsta raden i 25h och
  två olåsta rader, alla likvärdiga mot rådata (FACIT §4). Dirigentens beslut säger att en likvärdig rad
  ska undvikas genom designen. Det här är den regel som undviker den och samtidigt har en princip:
  K ändrar inte det som banken inte kan belägga.

**Konstanter.** Inga nya tal. `MINIMUM_VIABLE_SPEED` är ETA-vägens fartgräns, `2 × TICK_INTERVAL_MS`
golvets och `CONVOY_WINDOW_MS` U2:s.

## 3. Övervägda alternativ och mätningar

Mätt på fem sätt:
- **korpusbanken**, med `dump-openings` och `abdiff`;
- **runOpeningGates**;
- **klustervärldarna**, 186 världar med motorns egna domare (`K/tmp/tools/sweep.js`);
- **buggjägarens profiler**, quick och standard;
- **mutationer**.

### 3.1 Första rundans val (oförändrade)

| Variant | Bankens varningar | O1 (appserien) | Bedömning |
|---|---|---|---|
| + KRAV 2: färskhet mot firstPassageAt | −6 / +1 | **3 OKLASSADE** | avvisad (U13, U17) |
| + fixålder ≤ STALE_ETA_HARD_MS | −7 / +2 | OKLASSADE | avvisad (U13, U17) |
| + ledtidsgolv 2 × TICK vid täckningsslut (KRAV 3) | −16 / +7 | 4 OKLASSADE | avvisad (U13, U17) |
| + bakkant även före första passagen | +8 / −5 | – | avvisad: splittrar konvojer |
| Interpolation bara över `STALE_ETA_SOFT_MS` | 2 flyttade | grön | avvisad (T2 31 mot 26) |
| Bakkant enbart mot U2-fönstret (94d573f) | 4 flyttade | grön | avvisad (standard 190 mot 186) |

### 3.2 Golvet (revision 2)

Det smala golvet är valt: bara när ankaret ensamt skapar händelsen, på ett färskt fix och under 2 tick.
Ett allmänt golv och ett golv för tysta armar är avvisade (det senare är KRAV (3), som U17 inte godtar).

### 3.3 notePassage och passagedomen (revision 2)

Fixets tid används när armens läge redan låg bortom bron. En projektion ur prognosen för en båt före
bron gav en andrapåminnelse i `opening-updated-host-forecast.test.js` och är avvisad. Utan ett fix bortom
bron finns ingen säker skattning.

### 3.4 Korsningsankaret vid väntan (revision 3)

Mätt mot L0-sanningen i snabbprofilens 1855 interpolationer, varav 32 med väntande fix före bron
(`K/tmp/r3/tools/clampvar.js` på granskarens instrumentering):

| Variant | Väntefallen: median | min | max | Fel < −120 s, alla |
|---|---|---|---|---|
| rät linje (revision 2) | −101 s | −780 s | +8 s | 21 |
| bokföringen | +214 s | +17 s | +616 s | 0 |
| W2 (granskaren): bakåt, klämd till [t_före, t_efter]; bokföringen utan fart | −1 s | −90 s | **+214 s** | 7 |
| **vald: max(linjen, bakåt); linjen utan fart** | **−1 s** | **−90 s** | **+30 s** | **7** |

- **Bakåtskattningen före linjen** förekom aldrig i snabbprofilens väntefall. I banken förekom den 4
  gånger (13h 230167390, 21h 265705550, 25h GALADRIEL vid Klaffbron och 42h 219031446), varav 2 före
  t_före. Den valda regeln tar linjen där, och W2 tog det klämda värdet. Ingen av raderna ändrar någon
  varning: banken med regeln är identisk med banken med W2.
- **Ett långsamt fix efter bron** (≤ 0,5 kn) fanns 2 gånger i snabbprofilen och 2 i banken (25h
  VENTICELLO och 21h 265819150). W2 föll då tillbaka på bokföringen, +214 s fel. Den valda regeln tar
  linjen.
- **Mot rådatafacit i banken:** 3 väntefall har en observerad (inte inferred) korsning.
  - 21h 219033332: linjen −7 s, regeln +43 s.
  - 42h 211214850: linjen −19 s, regeln −11 s.
  - 42h 219031446: linjen och regeln lika, −12 s.

  De övriga 29 har inferred punkter, alltså samma räta linje, och kan inte döma.
- **Banken:** i alternativ A flyttar regeln bara 25h (08:30:11 → 08:34:15), exakt som granskarens W2.
  I prototypen flyttar den ingenting, eftersom korsningen där bara styr medlemskap och bakkant.

### 3.5 Täckningsslutet: tre sätt att räkna det (revision 3)

Alla tre har W2-regeln, golvet och hållen.

| Mått | **Prototypen**: täckningsslut från bokföringen; medlemskap och bakkant mot korsningen | **Alternativ A**: allt mot korsningen | COVERBOOK (revision 2:s alternativ): bakkant mot täckningsslutet |
|---|---|---|---|
| Låst facit som flyttas | **inget** | 25h (likvärdig) | inget |
| Olåsta varningar som flyttas | 1: PRINCESS LIZYMAR (rättare) | 3 till: AMALIA II, ELFKUNGEN (likvärdiga) | 0 |
| O1b okända / TÄCKNING | 38 → 37 / 391 → 392 | 38 → 37 / 391 → 392 | 38 / 391 |
| hunt:repro, K:s kort | BORTA: F01, F01-r2, F02, F03, F14, F17, F17-r2, F20, F22, F11-r2 | samma (`K/tmp/r3/motor-alt-a/`) | samma (revision 2-mätning) |
| Klustervärldar KVAR (av 186) | 86 (F01 17, F02 9, F03 45) | **81** (F01 16, F02 7, F03 43) | 90 (revision 2-mätning) |
| Snabbprofilen, råa utslag | **48** | 51 | – |
| Snabbprofilen, T3 efter sann passage / fruset fix | **7 / 1** (ny: värld 82) | 9 / 2 (nya: 5, 21, 82 / 56) | – |
| Standardprofilen, KANDIDAT | **181** | 184 | – |
| Standardprofilen, T2 ledtid / oklassad miss | 9 / 17 | **8 / 16** | – |
| Standardprofilen, T3 efter sann passage | **47** | 52 | – |

**Skillnaden mellan prototypen och A gäller tysta båtar i R1-världar.** A släpper dem tidigare, och det
slår åt två håll:
- **Var båten nästa öppning, är A bättre.** Varningen kommer före hennes korsning.
  - Klustersvepet: värld 331, 510, 790 och 1139.
  - Standardprofilen: 790 och 1139 får 41–47 s ledtid med prototypen, och 510 blir en miss.
- **Passerade båten med den gemensamma öppningen, är A sämre.** Varningen kommer efter hennes passage,
  ett U17-falsklarm.
  - Standardprofilen: 7 fler (5, 21, 322, 783, 1462, 1602, 1863) och 1 på fruset fix (56).
  - Snabbprofilen: 5, 21 och 56.

**Bedömning.** Banken kan inte avgöra vilken tid som är rätt för en tyst båt. A:s alla extra rader ligger
i inferrerade fönster. U13 kräver då att beteendet står kvar, och dirigentens beslut säger att en
likvärdig rad ska undvikas genom designen. Prototypen gör det.
- Priset är fyra syntetiska världar där en tyst båt i nästa öppning varnas sent. De är 7699cbe:s
  beteende, inga regressioner.
- Motorn får en KÄND_ÖPPEN-post för dem (§10.2), så att de syns men inte blir nya kort.
- Vill dirigenten väga produktprincipen (en missad öppning är värre än ett falsklarm) tyngre än U13 för
  just den klassen, är A färdigt. Det kräver då ett uttryckligt undantag för 25h-raden.

COVERBOOK domineras av prototypen: samma låsta facit, men PRINCESS LIZYMAR:s rättare varning uteblir.

### 3.6 Mutationsprovet (revision 3)

Körd över alla 22 sviter som använder `BridgeOpeningService`, 340 test (`K/tmp/r3/mutlogs/`).

| Grupp | Antal | Utfall |
|---|---|---|
| Revision 2:s mutationer (M01–M17, N1–N11) som fortfarande gäller | 24 | **alla fällda** |
| M14 och N4 (rebasering och golvets täckning på bokföringen) | 2 | utgår, de är nu designen. Inversen R4 och R3 fälls. |
| N7 (nollställningen) | 1 | omformulerad till R11, fälls |
| Nya i revision 3 | 11 | **alla fällda** |

De nya mutationerna:
- R1: bakkanten bara mot täckningsslutet;
- R2: inget golvundantag i bakkanten;
- R3: täckningen från korsningen;
- R4: rebasering på korsningen;
- R5: ingen väntansregel;
- R6: bakåtskattning utan max med linjen;
- R7: fartgränsen 0 i stället för `MINIMUM_VIABLE_SPEED`. Den överlevde först, och testet med brusfart
  20 m bortom bron fäller den nu;
- R8: ingen övre gräns i observeVessel;
- R9: `waitingAtBridge` ignoreras;
- R10: golvets medlemsvillkor borttaget (granskarens X8);
- R11: ingen nollställning.

Utan mutation går alla 340 igenom.

## 4. KRAV (1)–(4) i ARCHITECTURE.md §H29/H30, och U17

| Krav | Infört? | Var |
|---|---|---|
| (1) bron bakom läget ⇒ avväpna, släpp inte | ja, och utvidgat till under bron (§0.2) och kurs bort (håll till nästa fix) | `_coverageVerdict` |
| (2) färskhet: `lastSeenAt` nyare än `firstPassageAt` | **nej**, enligt U17 och U13 | – |
| (3) ankomstfysik | första ledet ja (hängslen). Ledtidsgolvet vid täckningsslut **nej**, enligt U17 och U13. Golvet i §2.5 gäller bara ett färskt fix och bara när ankaret ensamt skapar en händelse. | `_coverageVerdict`, `_anchorFloorHost` |
| (4) egen deadline ur ett färskt fix | **bara i bakkanten.** Vid täckningsslut avfyras armen på deadlinen ur sitt senaste tillämpade fix. | `_coverageVerdict` (bakkant) |

**U17** avgör konflikten: säkerhetsvarningen för en tyst båt behålls, och prototypen ändrar inte heller
när den kommer (§2.7). Hållen under bron (§0.2) och för kurs bort gäller lägen som säger mer än en
prognos, och de skjuter bara upp släppet till nästa fix.

**U19 (R1:s fråga 2)** säger att en planerad varning skickas även när en obekräftad vändning väntar. Det
gäller båtens första, planerade varning, som deadlinemotorn avfyrar. K rör inte den vägen. `_courseAway`
prövas bara för en båt som redan är täckt, alltså i RECOVER-släppet och i bakkanten. Där skjuter den upp
en *andra* varning till nästa fix (KRAV 1).

## 5. Samspel med andra familjer

### K2 (samma fil)

Provsammanslagning med `git merge-file` (bas 7699cbe) mot K2:s HEAD d7a8022 (`K/tmp/r3/kk2/`). Det blir
**samma två konflikter** som K2 redan har löst i sin DESIGN §5:
1. **`_recordPassage`:** K:s `crossedAtMs`-parameter mot K2:s returminne före händelsekontrollen. K2:s
   lösning gäller oförändrad.
   - `firstPassageAt` är fortfarande korsningen, så K2:s villkor (b) jämför korsning med korsning.
   - Revision 3 ändrar bara rebaseringen till `now`, en rad som inte ingår i konflikten.
2. **`wideHost`/`floorHost`:** behåll båda och lägg till `|| blocked` i floorHost-raden (K2:s
   F09-regel).

`anchorFloorEventId` sätts på samma ställe som `recoverHeldAt` nollställs och krockar inte med K2.

**Det som har ändrats i K2 sedan revision 2.** K2 ger nu returresan egen varning utan golv (U15,
dirigentens beslut). K2 lägger då returbåtens gamla händelse i `releasedFrom`, och K:s golv kräver att
hon inte är släppt.
- Följden i K+K2: värld 227:s T3 (ZELDA varnad 10 s efter korsningen) kommer tillbaka som KANDIDAT. F14
  är fortfarande BORTA.
- Det följer av U15 och U18 (returen upptäcks sent), och K2 registrerar det.
- Revision 2:s mening "K:s och K2:s golv har samma villkor och samma utfall" gäller inte längre och är
  struken. K:s golv gäller nu bara arm som inte är en U15-retur.
- K2:s funktioner heter i dag `_releaseReturnCoverage`, `_describesPassedOpening` och
  `_releaseWarningsWhileHeld`.

Efter integrationen bör bankjämförelsen köras om för 13h, 17h, 25h och 0525. K2:s tre olåsta facitrader
går via RECOVER-släppet, och med prototypens täckningsslut från bokföringen ligger de där de låg på
7699cbe.

### R1 (VesselDataService)

- Fler bokförda returer ger fler `_recordPassage`. Interpolationen kräver fix på var sin sida om bron.
- **U18:** Fix D:s krav på två positioner behålls, och sena returer med gles AIS är en känd gräns. Värld
  227:s T2 OKLASSAD och F02:s r2 (värld 1274, YRSA beväpnad 52 m före bron) hör dit (§10.3).
- **U19:** F14:s r2 (värld 1590) hör dit (§10.4).

### E (ETA)

Bakkanten, golvet och hållen läser `expectedArrivalMs`, så E:s och E2:s ändringar flyttar besluten.
Väntansregeln läser `vessel.sog` och `arm.sog`, alltså rå AIS-fart, inte ETA-kedjan. Mät om efter
integrationen.

### N och M

Inget samspel. Notiser, texter och passager är oförändrade i hela banken.

## 6. Användarbesluten

- **U13:**
  - inget låst facit flyttas;
  - den enda flyttade olåsta varningen är bedömd som rättare mot rådata (FACIT §1);
  - alternativ A:s rader är bedömda var för sig (FACIT §4).
- **U15:** stöds indirekt. En retur mer än 600 s efter den verkliga korsningen får egen varning
  (syntetiska u-sväng-gles). K2 äger U15 inom 600 s.
- **U17:** följs, se §0.1 och §4. U17-kontraktet är testat.
- **U18 och U19:** se §4 och §5.
- **U14, U16, U20 och U21:** rör inte K.
- **Dirigentens beslut 2026-11-05:**
  - under-bron-hållet (§0.2);
  - W2 och 25h (§0.3).
- **U2** (etapp7-plan:9) är grunden för medlemskapet och bakkanten.
- **Produktprincipen** (en missad öppning är värre än ett falsklarm) styr två saker: avvisade grindar
  får inte kosta räddningar, och golvet stryker bara varningar som inte hinner hjälpa. Hur den vägs mot
  U13 för tysta båtar redovisas i §3.5.

## 7. Mätningar

Batteriet kördes på K/wt, 3707636. 1b4c9a3 och f8aa77e ändrar bara kommentarer och dokument; `npm test`
(355/355, 4812 gröna), `npm run lint` och `npm run replay:all` är omkörda på f8aa77e med samma resultat.
Loggarna ligger i `K/tmp/r3/batt/`.

### 7.1 Regressionstest

Testfilerna är kopierade till rena utpackningar (`K/tmp/r3/base7699`, `K/tmp/r3/head3400`).

| Svit | 7699cbe | 3400fa5 (revision 2) | HEAD |
|---|---|---|---|
| `tests/k-konvoj-recover-bakkant-glapp.test.js` (32) | **23 röda**, 9 gröna | 5 röda | 32 gröna |
| `tests/opening-convoy-release-scheduling.test.js` (12) | 4 röda, 8 gröna | 12 gröna | 12 gröna |

- **De 9 gröna på 7699cbe** vaktar beteenden som fanns redan där och som rättningen inte får ändra:
  - VIRGO, PILGRIM och 25h-raden (08:37:18);
  - U17-kontraktet;
  - två bakkantsfall;
  - M08, M10 och notePassage före bron.

  Testfilens huvud listar dem.
- **De 5 röda på revision 2** är revisionens nya beteende:
  - väntefallet och skattningens led;
  - systerstället i observeVessel;
  - M14 på bokföringen;
  - 25h-raden.

### 7.2 Batteriet

| Körning | Resultat |
|---|---|
| `npm test` | 355/355 sviter, 4812 gröna, 2 överhoppade, exit 0 |
| `npm run replay:all` | "Alla låsta korpusar matchar facit", utan någon omlåsning |
| `npm run replay:synthetic` | 46 scenarier, alla rena. Enda skillnaden mot bas: `u-sväng-gles` 2 → 3 öppningar (FACIT §2) |
| `npm run replay:openings` | standardgrindarna godkända; O1b 0 oklassade, okänd ordning 38 → 37; TÄCKNING 391 → 392 av 447 |
| `runSoak` och `npm run replay:monitoring` (72 h) | stabila, 0 processfel; de 6 INV-14W-raderna är identiska med 7699cbe |
| `npm run replay:phase`, även med `REPLAY_MONITORING=1` | OK, 24 korpusar, 168 replayer, inget odokumenterat fasberoende |
| `npm run lint` | rent |
| Bankjämförelsen mot 7699cbe | 1 öppningsvarning flyttad (PRINCESS LIZYMAR), 1 händelsenummer (LINNEA). Notiser, målbropassager och texter oförändrade |

**Alternativ A** (`K/tmp/r3/alt-a`, loggar i `K/tmp/r3/altbatt/`): K-sviterna 44/44, `replay:all` OK med
25h omlåst. Banken är identisk med granskarens W2 och med 7b520c2, även täckningsraderna. Hela batteriet
står i §7.6.

### 7.3 Motorn, `hunt:repro` (`K/tmp/r3/motor/`)

| Utfall | Kort |
|---|---|
| BORTA | F01, F01-r2, F02, F03, F14 (1 utslag kvar: T2 OKLASSAD, U18), F17, F17-r2, F20, F22, F11-r2 |
| KVAR, U17 (DESIGN, §10.1) | F11, F23, F03-r2 (värld 596), F20-r2 (värld 1907, TROLLA) |
| KVAR, U18 (R1) | F02-r2 (värld 1274, YRSA beväpnad 52 m före bron efter en U-sväng: 23 s ledtid) |
| KVAR, U19 (R1) | F14-r2 (värld 1590, SALTIS:s planerade varning medan vändningen väntade) |
| KVAR, andra familjer, som förut | B01, B02, F04–F10, F12, F13, F15, F16, F18, F19, F21 |

- F03-r2 och F20-r2 hade samma utfall på 7699cbe. Båda är tysta båtar vid täckningsslut som passerade
  med den gemensamma öppningen. U17-predikatet täcker dem (§10.1).
- F03-r2 har dessutom ett INV-3-utslag (ETA-sågtand), som hör till E2.

### 7.4 Snabbprofilen (`K/hunt-quick`) mot `r1-quick-a`

- Råa utslag 69 → **48**, kandidatkluster 15 → 12. **Inga nya klusternycklar**, alltså inga nya kort.
- T2 LEDTID 7 → 2, T2 OKLASSAD 12 → 5, båda stressklustren 1 → 0, T3 FANTOM 1 → 0.
- T3 VARNING-EFTER-SANN-PASSAGE 14 → 7. Den enda nya är värld 82: RUNA, tyst 220 s, med prognosen
  09:40:37 inom täckningen. Hon passerade 352 s efter ALVA, alltså med den gemensamma öppningen. Det är
  U17-klassen, och predikatet täcker den.
- T3 FRUSET-FIX 1 → 1. KÄND_ÖPPEN U2-VS-DEADLINE LEDTID 1 → 2 (värld 295, HAVSORN, R0, §9).
- Bankspåret som i `r1-quick-a`: 48 fasvarianter, 44 rena, 2 KNIVSEGG-kluster.
- Mot revision 2 (51 råa utslag) försvann världarna 5, 21 (T3) och 56 (FRUSET-FIX). Inget tillkom.

### 7.5 Standardprofilen (2000 världar, synth, utan krympning, `K/tmp/r3/hs-b`) mot `r1-standard-a`

- KANDIDAT-utslag 279 → **181**. Revision 2 och alternativ A gav 184.
- 297 råa utslag och 19 kandidatkluster, varav 16 med registerpost. **Inga nya klusternycklar.**
- T2 LEDTID 37 → 9, T2 OKLASSAD 55 → 17. Stressvarianterna: LEDTID 1 → 0, OKLASSAD 5 → 1.
- T3 FANTOM 2 → 1.
- T3 VARNING-EFTER-SANN-PASSAGE 72 → 47: 27 borta och 2 nya (82, 887).
- T3 FRUSET-FIX 10 → 12: 3 nya (685, 1453, 1960).
- De 5 nya är alla tysta båtar i R1-världar som passerade med den gemensamma öppningen. Alla 5 är
  prövade mot U17-predikatet (§10.1).
- KONFLIKT U2-RETURRESA 18 → 14. KÄND_ÖPPEN U2-VS-DEADLINE LEDTID 6 → 9 (HAVSORN-klassen).

### 7.6 Klustervärldarna och alternativ A

**Klustervärldarna** (`K/tmp/r3/sweep-b.json`), KVAR av alla:

| Kort | F01 | F02 | F03 | F11 | F14 | F17 | F20 | F22 | F23 | Summa |
|---|---|---|---|---|---|---|---|---|---|---|
| 7699cbe | 55 | 37 | 72 | 10 | 2 | 5 | 3 | 1 | 1 | 186 |
| **prototypen** | 17 | 9 | 45 | 9 | 1 | 1 | 3 | 0 | 1 | **86** |
| alternativ A | 16 | 7 | 43 | 9 | 1 | 1 | 3 | 0 | 1 | 81 |

**Alternativ A:s batteri** (`K/tmp/r3/altbatt/`, trädet `K/tmp/r3/alt-a` = 7699cbe + patch.diff +
alt-korsningstackning.diff):
- `npm test`: 355/355 sviter, 4812 gröna, 2 överhoppade;
- `npm run replay:all`: alla låsta korpusar matchar, med 25h omlåst till 08:34:15;
- `npm run replay:synthetic`: alla rena, `u-sväng-gles` 2 → 3 som prototypen;
- `npm run replay:openings`: standardgrindarna godkända, O1b 37 okända, TÄCKNING 392/447;
- `npm run lint`: rent;
- hunt:repro för K:s kort: samma utfall som prototypen.

## 8. Dokument

**Ändrat i patchen:**
- `docs/ARCHITECTURE.md`:
  - punkten "Konvojtäckningen är TIDSBEGRÄNSAD": bakkanten mot fönstrets slut, korsningen för
    medlemskap och bakkant, täckningsslutet från bokföringen, golvet;
  - stycket under §H29/H30:
    - kraven per punkt, och HAVSORN-priset som en U2-andrapåminnelse i R0;
    - väntansregeln och den övre gränsen i observeVessel;
    - täckningsslutet från bokföringen, med 25h och de syntetiska världarna;
    - golvet och U17;
  - noten under J13+J33 om 25h: raden står kvar 08:37:18;
  - hänvisningen till kampanjens K-underlag är borttagen.
- Docblocken i `BridgeOpeningService.js`:
  - `_crossingEstimate`: väntansregeln, och null-fallet faller på `_crossingUpperBound`;
  - `_recordPassage`: vad korsningen styr och vad bokföringen styr;
  - `_rebaseConvoyCoverage`: golvet följer åter av konstruktionen;
  - `_coverageVerdict`: bakkanten mot fönstrets slut, HAVSORN, PRINCESS LIZYMAR:s mekanism;
  - `_anchorFloorHost` och fältet `anchorFloorEventId`.
- `tests/replay-validation/corpora.js` och `golden-events/20260712-25h.json`: **oförändrade mot
  7699cbe.**

`docs/VALIDATION.md` behöver ingen ändring.

**Alternativ A** ändrar samma ställen till A:s semantik. Där ingår 25h:s golden-events, en ny not i
corpora.js (bedömd som likvärdig) och M14/25h-testen i A:s form.

## 9. Risker

- **Tysta båtar i nästa öppning varnas som på 7699cbe.** Släpps en tyst båt som egentligen var nästa
  öppning först vid bokföringens täckningsslut, kan varningen komma sent. Det är 7699cbe:s beteende,
  inga regressioner. Alternativ A fixar fyra syntetiska världar till men ger fler U17-falsklarm (§3.5).
  KÄND_ÖPPEN-posten i §10.2 håller klassen synlig.
- **Bakkantens pris i R0 är en U2-andrapåminnelse.** Snabbvärld 295: HAVSORN släpps på 0,83 s marginal
  (prognos 09:21:29,950 mot fönstret 09:21:29,116), 96 m från bron. Hon varnas 28 s före sin korsning
  09:20:55, fast korsningen ligger inom U2-fönstret efter DAGNY (09:17:59 + 600 s). 7699cbe varnade
  inte, vilket följer U2.
  - Klassen är registrerad som KÄND_ÖPPEN U2-VS-DEADLINE: +1 i snabbprofilen, +3 i standardprofilen.
  - Grinden "släpp bara när den färska deadlinen ligger framåt" (granskarens B1) tog bort 295 men gav
    5 nya utslag.
- **Väntansregeln litar på farten i fixet efter bron.** Har båten saktat in efter bron gäller linjen
  (max-ledet), men en båt som accelererat långt bortom bron skattas något för tidigt. I snabbprofilen
  ligger värsta fallet på −90 s.
- **Golvet stryker en egen varning med under 60 s kvar**, och bara när korsningsankaret ensamt skapade
  händelsen. Var prognosen för pessimistisk står den täckning hon hade på 7699cbe kvar. I K+K2 gäller
  golvet inte en U15-retur (§5).
- **Bakkanten, golvet och hållen beror på `expectedArrivalMs`.** E:s och E2:s ETA-ändringar kan flytta
  besluten.
- **En hållen arm släpps bara av ett nytt fix.** En båt som tystnar för gott under bron får ingen
  räddningsvarning (KRAV 1, §0.2).

## 10. Registerposter som dirigenten lägger in

Motorns register (`tests/replay-validation/bugHunt/beslutsregister.json`) skrivs av dirigenten. Ingen av
posterna nedan finns i motorn i dag. Predikaten behöver skrivas ovanpå `convoyData` och L0-sanningen,
liknande `crossingWithinEventWindow`.

### 10.1 U17-TYST-BÅT-RECOVER (DESIGN, källa U17)

- **Orakel:** T3. **Klasser:** `VARNING-EFTER-SANN-PASSAGE` och `VARNING-PÅ-FRUSET-FIX`.
- **Predikat `tystRecoverSammaÖppning`**, alla villkor:
  1. medlemmen har en `OPENING_COVERAGE 'absorbed'`-rad vid samma bro i en avfyrad händelse E, och E:s
     varning kom före hennes sanna korsning (L0). Hon täcktes av den gemensamma öppningens varning;
  2. den utlösande varningen leds av henne själv och kommer efter absorptionen. Det är hennes egen
     RECOVER-händelse;
  3. hennes sista sampel före varningen ligger före hennes sanna korsning. Hon var tyst över korsningen,
     och appen kunde inte veta att hon passerade;
  4. hennes sanna korsning ligger högst `CONVOY_WINDOW_MS` (600 s) efter den första sanna korsningen vid
     bron efter E:s varning, hennes egen medräknad. Hon hörde enligt U2 till E:s öppning.
- **Ingen fixålder.** Revision 2:s förslag (`minFixÅlderMs` 300 000) täckte inte F20-r2 (199 s), värld
  21 (209 s) eller värld 82.
- **Prövat fall för fall** (`K/tmp/r3/tools/u17pred.js` på HEAD), alla fyra villkoren uppfyllda:
  - korten: F11, F23, F03-r2, F20-r2;
  - snabbprofilen: världarna 41, 77, 82, 158, 217 (båda broarna) och 220;
  - standardprofilens nya: 82, 887, 1453, 1960 och 685. För 685 är E händelsen `#3` (07:49:27);
    hennes senare absorption i `#6` kom efter passagen.
- **Ett fall som inte ska täckas:** snabbvärld 87 är en verklig miss. Hon korsade 1194 s efter den
  gemensamma öppningen, alltså i nästa öppning, och varnades 45 s efter passagen. Villkor 4 faller, och
  fallet förblir KANDIDAT (eller §10.2).

### 10.2 K-TYST-BÅT-NÄSTA-ÖPPNING (KÄND_ÖPPEN, källa K-familjen revision 3, U13, dirigentens beslut 2026-11-05)

- **Orakel:** T3 `VARNING-EFTER-SANN-PASSAGE` och T2 `LEDTID<Ns`.
- **Predikat:** villkor 1–3 i §10.1, men villkor 4 faller. Hennes sanna korsning ligger mer än 600 s
  efter E:s första korsning, så hon var nästa öppning, och hennes RECOVER-varning kom vid bokföringens
  täckningsslut efter korsningen eller under 60 s före den.
- **Varför KÄND_ÖPPEN och inte DESIGN.** Det är en verklig sen varning. Den kvarstår för att banken
  inte kan belägga alternativ A (U13). Exempel: snabbvärld 87, standardvärldarna 790, 1139, 510 och 331.

### 10.3 U18 för K:s r2 och värld 227 (R1:s post)

F02-r2 (värld 1274: returarm beväpnad 52 m före bron efter en U-sväng, T2 LEDTID 23 s) och värld 227:s
T2 OKLASSAD (ZELDA:s retur upptäckt 13 m före bron, efter korsningen) hör till U18: Fix D:s två
positioner gör att returen upptäcks sent.
- R1:s U18-post ska omfatta T2 `LEDTID<Ns` och `ÖPPNING-MISS:OKLASSAD` för en arm som beväpnas först
  efter en bekräftad vändning med under 2 × `TICK_INTERVAL_MS` till korsningen.
- I K+K2 tillkommer värld 227:s T3 (U15 utan golv), som K2:s post täcker.

### 10.4 U19 för F14-r2 (R1:s post)

Värld 1590: SALTIS:s första, planerade varning för Klaffbron 13:35:27 gick medan vändningen 13:34:19
väntade på bekräftelse (bekräftad 13:36:32), T3 `FANTOM-UTAN-AVBROTT`.
- Predikatet: varningen är båtens första vid bron (`firedBy` deadline eller fix, inte RECOVER), och en
  obekräftad vändning (Fix D:s väntande flagga) var aktiv vid varningen och bekräftades senare.
- K rör inte vägen.

### 10.5 Ingen ny post behövs för

- F03, F20 (§0.2), F01, F02, F14, F17 och F22: BORTA.
- HAVSORN-klassen: redan KÄND_ÖPPEN U2-VS-DEADLINE.
