# FACIT för familj E2 (ETA-etappen, U20), revisionen 2026-11-05, sammanslagen med familj E 2026-11-07

Jämförelsen gäller låst facit på **e949ae1** (familj E) mot **E2-revisionen**
(HEAD 66bb985 i `K/E2/wt`, koden från ac4e131). Varje ändrad rad i golden-text
och golden-events är bedömd vid sin egen tid mot nästa verkliga brolinje-
korsning för samma fartyg och bro (gt-passages, `kind=line`, via
`loadPassageEvidence`), och öppningskorten dessutom mot O1/O2
(`runOpeningGates`). "Fel" är publicerat värde minus sanning i minuter.
Verktyg: `K/E2/matningar/facit.py` och `facitmd.py`, rådata i
`K/E2/matningar/facit-rader.json` och de manuella bedömningarna i
`K/E2/matningar/facit-manuella.json`.

## Sammanslagningen E + E2 (2026-11-07): facit mot 7699cbe

Sammanslagningen ligger i `K/E2/mwt` (HEAD `57808cb`; efter `a53dd18` har bara kommentarer, noter och dokument ändrats): E2-revisionen
(`66bb985`) med familj E:s andra revision ovanpå (`928daf4`, `6a293be` och
`ca1272c`, cherry-pick av `5febba0`, `5b9ea15` och `f3a2d46`). Goldenfilerna i
mwt är byte-lika med E2-revisionens. replay:all är grönt mot dem i 23 av 24
korpusar; 20260917-7h är rött som förut (GOLDEN-TEXT 68 ≠ 69). measure:eta ger
samma publicerade värde som E2-revisionen i alla 3 110 påståenden. Facit för
hela patchen (`patch-ETA.diff`, `git diff 7699cbe`) är därför E2:s 164 rader
nedan och familj E:s sex rader (7699cbe → e949ae1). En rad finns i båda:

| Korpus | Rad | 7699cbe | e949ae1 (E, första revisionen) | E + E2 | Sanning (gt, line) | Fel 7699cbe → E + E2 | Mot 7699cbe |
|---|---|---|---|---|---|---|---|
| 20260823-24h | golden-text idx 65, 16:34:01 PRIMA LADY, Stridsbergsbron | "om 7 minuter" | "om 3 minuter" | "om 4 minuter" | 16:37:07.133, +3,1 min | +3,9 → +0,9 | **rättare** |

Mot e949ae1 är raden sämre (−0,1 → +0,9), och därför står den i E2:s
ägarfråga nedan. Mot 7699cbe, som patchen jämförs med, är den rättare. E:s
andra revision ger själv "om 4", eftersom golvet är 3,6 kn (2 × 1,8 kn) i
stället för 4 kn. Sammanslagningen ändrar alltså inte raden mot någon av de två
revisionerna.

E:s fem övriga rader har E:s värden (bedömning och belägg i `K/E/FACIT.md`):

| Korpus | Rad | 7699cbe → E + E2 | Sanning (gt, line) | Fel | Bedömning |
|---|---|---|---|---|---|
| 20260601-41h | golden-text idx 127, 07:30:11 SKONNERTEN JYLLAND, Stridsbergsbron | "om 8" → "om 3" | +2,1 min | +5,9 → +0,9 | rättare |
| 20260823-24h | golden-events notis 20, 16:35:10 PRIMA LADY | eta 5 → 3 | +1,9 min | +3,0 → +1,1 | rättare |
| 20260823-24h | golden-events openingWarnings 5, Stridsbergsbron#8 16:35:10 | etaMin 5 → 3 | +1,9 min | +3,0 → +1,1 | rättare |
| 20260907-31h | golden-events notis 22, 18:50:04 OLA | eta 4 → 1 | +1,3 min | +2,7 → −0,3 | rättare |
| 20260907-31h | golden-events openingWarnings 7, Stridsbergsbron#11 18:50:04 | etaMin 4 → 1 | +1,3 min | +2,7 → −0,3 | rättare |

Utanför låst facit: SKONNERTENs notis 07:30:52 är eta 2 mot 1,4 min, som på
7699cbe. Både E:s V4 och E2:s enda EMA per fix ger 2.

**Summa mot 7699cbe** (`K/E2/matningar/sammanslagning/facit-summa.txt`,
verktyget `facit_summa.py` återskapar E2:s egen summa 71/8/61/24 ur samma
filer):

| Population | Rättare | Likvärdig | Sämre | Utan linjefacit | Summa |
|---|---|---|---|---|---|
| Alla ändrade låsta rader | 77 | 8 | 60 | 24 | 169 |
| Sanning < 10 min | 61 | 6 | 21 | 1 | 89 |
| Sanning < 5 min | 39 | 5 | 8 | 1 | 53 |

Ägarfrågan nedan gäller fortfarande, för hela patchen med 21 sämre rader mot 61
rättare i bandet < 10 min. Sammanslagningen lägger inga sämre rader till, och
PRIMA LADY-raden faller bort ur frågan när patchen jämförs med 7699cbe.
Dirigentbeslutet om 20260917-7h och omlåsningen med verktyget återstår som
förut.

Avsnitten nedan, från "Sammanfattning" och framåt, är E2-revisionens facit mot
e949ae1 och står oförändrade, utom märkningen av PRIMA LADY-raden.

## Sammanfattning

| Population | Rättare | Likvärdig | Sämre | Utan linjefacit | Summa |
|---|---|---|---|---|---|
| Alla ändrade låsta rader | 71 | 8 | 61 | 24 | 164 |
| Sanning < 10 min | 55 | 6 | 22 | 1 | 84 |
| Sanning < 5 min | 33 | 5 | 9 | 1 | 48 |

Den första E2-leveransen hade 60 rättare, 13 likvärdiga, 65 sämre och 23 utan
linjefacit (161 rader), varav 46 rättare och 26 sämre i bandet < 10 min.

Revisionen ändrade, mot den första leveransen:
- **25h SENTA/ELAIZA** (granskningens höga punkt): ELAIZA och SENTA varnas
  15:17:16 som medlemmar i en egen söderut-händelse, 8,8 och 10,3 min före
  sina korsningar. Förut kom RECOVER-kortet 15:27:01, 55 s efter ELAIZA:s
  korsning. Raden är **rättare** även mot e949ae1 (se nedan).
- **F06-marginalen** gav tillbaka "strax" på sex rader där e949ae1 hade strax
  och båten korsade inom 3 min: NORDIC SOLA (19h 06:17:48), CATHARINA (19h
  08:12:00), ELFKUNGEN (13h 12:43:06), 11h 09:17:30, 13h 08:24:47 och 24h
  15:07:16. De är inte längre FACIT-rader.
- **F07**: AVALON (21h) visas "om 12" från 07:07:13 i stället för "om 18"
  07:11:30 mot verkliga 4,5 min (12 rättare rader i 21h).

## Ägarfrågan: bandförbättring mot radförsämring

Enligt U13 är varje sämre rad ett designfel. De parade banden sanning < 5 och
< 10 min blir lika eller bättre i median och andel inom 2 min i alla typer
(VALIDATION "Familj E2"), men 22 låsta rader i bandet < 10 min blir sämre.
Mekanismen är densamma i nästan alla: på e949ae1 läste notistokenen och
öppningsmotorn **pass 1:s värde** mellan dubbelkörningens två pass (vikt 0,4,
mer eftersläpning). Nu läser de fixets enda värde, som ligger 0,3–1 min
lägre vid inflygning. Där pass 1 råkade ligga närmare sanningen blir raden
sämre, där det låg längre bort blir den rättare (55 rader i samma band).
Det går inte att få bort de sämre raderna utan att återinföra en andra,
mer eftersläpande produkt — det K6 ska ta bort.

Raderna (11 öppningskort, 6 notiser, 5 brotextrader):

| Korpus | Tid | Vad | Bro | Fartyg | Före → efter | Sanning | Fel före → efter |
|---|---|---|---|---|---|---|---|
| 20260610-19h | 16:31:17 | brotext | Klaffbron | WILHELM THAM | Klaffbron, om 5 min → Klaffbron, om 4 min | 4,5 min | +0,5 → -0,5 |
| 20260707-14h | 08:18:00 | brotext | Klaffbron | AKIRA | Klaffbron, om 6 min → Klaffbron, om 5 min | 8,2 min | -2,2 → -3,2 |
| 20260708-21h | 06:19:56 | notis | Stridsbergsbron | JUNO | eta 2 → eta 3 | 2,4 min | -0,4 → +0,6 |
| 20260712-25h | 07:42:16 | brotext | Klaffbron | MALUCA | Klaffbron, strax → Klaffbron, om 3 min | 2,8 min | +0,0 → +0,2 |
| 20260804-17h | 15:55:31 | brotext | Klaffbron | JUNO | Klaffbron, strax → Klaffbron, om 3 min | 2,7 min | +0,0 → +0,3 |
| 20260804-both-21h | 07:04:53 | öppning | Klaffbron | — | 07:04:53 etaMin 9 (deadline) → 07:04:53 etaMin 8 (deadline) | 9,3 min | -0,3 → -1,3 |
| 20260804-both-21h | 07:09:02 | notis | Klaffbron | ANYA ELAN 380 | eta 3 → eta 2 | 5,2 min | -2,2 → -3,2 |
| 20260804-both-21h | 07:44:29 | öppning | Klaffbron | — | 07:44:29 etaMin 7 (fix) → 07:44:29 etaMin 6 (fix) | 6,6 min | +0,4 → -0,6 |
| 20260804-both-21h | 10:08:40 | öppning | Klaffbron | — | 10:08:40 etaMin 7 (deadline) → 10:08:40 etaMin 6 (deadline) | 6,5 min | +0,5 → -0,5 |
| 20260804-both-21h | 12:03:26 | öppning | Klaffbron | — | 12:03:26 etaMin 7 (deadline) → 12:03:26 etaMin 6 (deadline) | 7,0 min | +0,0 → -1,0 |
| 20260806-42h | 11:52:47 | öppning | Stridsbergsbron | — | 11:52:47 etaMin 6 (deadline) → 11:52:47 etaMin 5 (deadline) | 5,8 min | +0,2 → -0,8 |
| 20260823-24h | 16:34:01 | brotext | Stridsbergsbron | PRIMA LADY | Stridsbergsbron, om 3 min → Stridsbergsbron, om 4 min (mot 7699cbe: om 7 → om 4, rättare; se sammanslagningen) | 3,1 min | -0,1 → +0,9 |
| 20260907-31h | 13:25:14 | notis | Stridsbergsbron | ELFKUNGEN | eta 3 → eta 2 | 3,0 min | -0,0 → -1,0 |
| 20260907-31h | 15:12:51 | öppning | Stridsbergsbron | — | 15:13:13 etaMin 5 (deadline) → 15:12:51 etaMin 5 (deadline) | 6,2 min | -0,8 → -1,2 |
| 20260909-80h | 15:35:40 | notis | Klaffbron | TINY | eta 2 → eta 1 | 4,3 min | -2,3 → -3,3 |
| 20260909-80h | 18:00:35 | öppning | Stridsbergsbron | — | 18:00:58 etaMin 5 (deadline) → 18:00:35 etaMin 5 (deadline) | 7,1 min | -1,8 → -2,1 |
| 20260909-80h | 18:04:58 | notis | Stridsbergsbron | ELFKUNGEN | eta 2 → eta 1 | 2,8 min | -0,8 → -1,8 |
| 20260917-16h | 02:19:18 | öppning | Stridsbergsbron | — | 02:20:08 etaMin 5 (deadline) → 02:19:18 etaMin 5 (deadline) | 6,1 min | -0,3 → -1,1 |
| 20260917-16h | 02:56:30 | öppning | Stridsbergsbron | — | 02:57:00 etaMin 5 (deadline) → 02:56:30 etaMin 5 (deadline) | 5,5 min | +0,0 → -0,5 |
| 20260917-16h | 03:03:14 | öppning | Klaffbron | — | 03:03:14 etaMin 6 (fix) → 03:03:14 etaMin 5 (fix) | 5,6 min | +0,4 → -0,6 |
| 20260917-16h | 09:19:32 | notis | Stridsbergsbron | KAPEREN | eta 3 → eta 2 | 4,1 min | -1,1 → -2,1 |
| 20260918-7h | 12:21:57 | öppning | Stridsbergsbron | — | 12:22:43 etaMin 5 (deadline) → 12:21:57 etaMin 5 (deadline) | 7,0 min | -1,2 → -2,0 |

Fördelning efter orsak:
- **Öppningskortens etaMin eller avfyrningstid** (11 rader): etaMin 1 lägre,
  eller samma etaMin men kortet 22–50 s tidigare (längre ledtid). Ingen
  öppning går förlorad; replay:openings har samma täckning eller bättre.
- **Notistokenen** (6 rader): en minut lägre (fem rader) eller högre (JUNO 21h).
- **Brotext** (5 rader): WILHELM THAM och AKIRA (en minut lägre), PRIMA LADY
  (familj E:s rad, väntefasens platå, "om 3" → "om 4" mot 3,1) samt MALUCA och
  JUNO 17h, där F06-regeln fortfarande håller på 3 min (de bromsade in vid bron
  till 1,3 och 2,8 kn, momentanfarten gav 4,1 och 4,0 min, men de korsade efter
  2,8 och 2,7 min).

Utanför låst facit, mätta: PILOT 761 (13h 06:11:19, notis 2 → 5 mot 1,4) och
ORCA (17h 13:56:15, 3 → 6 mot 2,2). FP9-taket (rå restid + 3 min) kapade på
e949ae1 pass 1:s värde (5,1 och 7,2) till rå restid, men inte slutvärdet (4,7
mot taket 4,8). FP9 hör till notisflödet och är orört.

**Frågan:** ska K6 gå in med den här bytesaffären (55 rättare mot 22 sämre
rader i bandet < 10 min, bättre band), eller ska ETA-etappen vänta tills en
annan väg finns? Ett "nej" lämnar F06 och F07 öppna, eftersom K6:s memo är
F06:s rotorsak (dubbel EMA) enligt U20.

## Öppningar som flyttas utanför golden-events (mätta)

Grinden för en mötande konvoj mot en tyst motpart flyttar fem kort i korpusar
utan låsta golden-events. Bara 20260804-17h:s öppningsfördelning (låst) ändras.

| Korpus | Före (e949ae1) | Efter | Rådata | Bedömning |
|---|---|---|---|---|
| 20260804-17h | KOLLAND absorberad 15:01:13 i Klaffbron#35 (MISTY söderut, tyst, korsar aldrig Klaffbron); inget eget kort | Klaffbron#36 15:04:51 norrut, etaMin 15 | KOLLAND korsar Klaffbron 15:25:01 (line), ledtid 20,2 min | rättare (en missad öppning får varning) |
| 20260804-17h | ADA absorberad 16:03:03 i Stridsbergsbron#39 (JUNO norrut), RECOVER 16:14:57 etaMin 0 | egen 16:07:58 etaMin 7 | ADA korsar 17:07:46 (line), 53–60 min senare | likvärdig (båda en timme för tidiga) |
| 20260710-13h | SAGESSE absorberad 08:17:49 i Klaffbron#6 (söderut, tyst), RECOVER 08:30:55 etaMin 0 | egen 08:19:34 etaMin 6 | SAGESSE korsar Klaffbron 08:30:35 (inferred) — förut kom kortet 20 s EFTER korsningen | rättare |
| 20260707-14h | LYS och HERA II absorberade 08:27–08:28 i Stridsbergsbron#5 (KINN norrut, tyst, korsar aldrig), RECOVER 08:44:30 etaMin 0 | egen 08:30:17 etaMin 7 | HERA II korsar 08:49:18, LYS 08:52:05 (båda inferred) | oklar (ledtid 4,8 → 19 min, etaMin-felet −4,8 → −12) |
| 20260712-25h | se 15:17:16 nedan (låst) | | | rättare |

## 20260917-7h (dirigentbeslut)

Korpusen har ofullständig fångst, och `relockGoldenText` vägrar. Raden
SUSANNE 14:58:43 ("Två båtar … om 15" på e949ae1) uteblir: texten står kvar på
"om 14" från 14:55:21 till 15:00:59. SUSANNE korsar 16:12:48 (+74 min), så
raden är sämre med en minut vid sanning 74 min, men texten blir monoton (14 →
15 → 17 blir 14 → 17). replay:all är rött här och bara här.

## Quick-värld 5 (motorn, inte låst facit)

BRISEN (265549774) absorberas 08:07:42 i Stridsbergsbron#4 (KAJSA, samma
riktning, varnad 08:07:00; KAJSA korsar 08:12:10). BRISEN:s senaste fix
08:16:40 sa ankomst 08:21:10, före täckningsslutet 08:22:00,8; hon korsar
08:20:43 och hörs igen 08:22:03,9. RECOVER-släppet ger #9 08:22:00 med etaMin
−1. På e949ae1 slutade täckningen 08:22:10,8 (rebaserad på KAJSA:s passage),
alltså efter BRISEN:s bokförda passage. Skillnaden är att KAJSA:s prognos nu
var 08:12:00,8 i stället för 08:12:15, och K:s rebasering förlänger aldrig.
Det är U17-klassen (säkerhetsvarning för en tyst båt som enligt sin senaste
position hann igenom den gemensamma öppningen) — ett godtaget falsklarm, ingen
missad öppning. Regressionstestet låser att hon är täckt före sin korsning.

## Per korpus

### 20260525 (3 rader: 2 oklar, 1 rättare)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 05-26 09:52:23 | text | Klaffbron | MARIANNE | Två båtar på väg mot Klaffbron, om 14 min | Två båtar på väg mot Klaffbron, om 13 min | ingen linjekorsning | — → — | oklar |
| 05-26 10:07:43 | text | Klaffbron | JOSEPHINE | Två båtar på väg mot Klaffbron, om 5 min | Två båtar på väg mot Klaffbron, om 4 min | ingen linjekorsning | — → — | oklar |
| 05-26 15:32:26 | text | Stridsbergsbron | ORANESS | Stridsbergsbron, om 4 min | Stridsbergsbron, om 3 min | 15:35:07 (+2,7 min) | +1,3 → +0,3 | rättare |

### 20260601-41h (4 rader: 2 rättare, 2 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 06-02 13:38:38 | text | Klaffbron | AQUILA | Klaffbron, om 15 min | Klaffbron, om 12 min | 13:54:34 (+15,9 min) | -0,9 → -3,9 | sämre |
| 06-02 17:53:25 | text | Stridsbergsbron | AIR | Stridsbergsbron, om 77 min | Stridsbergsbron, om 78 min | 08:24:41 (+871,3 min) | -794,3 → -793,3 | rättare |
| 06-03 11:08:02 | text | Klaffbron | NOCHT | Klaffbron, om 27 min | Klaffbron, om 26 min | 11:24:15 (+16,2 min) | +10,8 → +9,8 | rättare |
| 06-03 11:33:31 | text | Stridsbergsbron | NOCHT | Stridsbergsbron, om 5 min | Stridsbergsbron, om 4 min | 12:02:54 (+29,4 min) | -24,4 → -25,4 | sämre |

### 20260610-19h (2 rader: 2 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 06-10 10:45:07 | text | Klaffbron | LILLI | Klaffbron, om 20 min | Klaffbron, om 19 min | 11:20:01 (+34,9 min) | -14,9 → -15,9 | sämre |
| 06-10 16:31:17 | text | Klaffbron | WILHELM THAM | Två båtar på väg mot Klaffbron, om 5 min | Två båtar på väg mot Klaffbron, om 4 min | 16:35:49 (+4,5 min) | +0,5 → -0,5 | sämre |

### 20260702-11h (3 rader: 2 likvärdig, 1 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 07-02 08:31:20 | text | Stridsbergsbron | MOSHE | Tre båtar på väg mot Stridsbergsbron, strax | Tre båtar på väg mot Stridsbergsbron, om 3 min | 08:45:08 (+13,8 min, inferred) | -10,8 → -10,8 | likvärdig |
| 07-02 08:33:00 | text | Stridsbergsbron | MOSHE | Tre båtar på väg mot Stridsbergsbron, strax | Tre båtar på väg mot Stridsbergsbron, om cirka 2 min | 08:45:08 (+12,1 min, inferred) | -9,1 → -10,1 | sämre |
| 07-02 08:35:00 | text | Stridsbergsbron | SILVERMORK II | Tre båtar på väg mot Stridsbergsbron, strax | Tre båtar på väg mot Stridsbergsbron, om 3 min | 08:38:27 (+3,5 min, inferred) | -0,5 → -0,5 | likvärdig |

### 20260702-19h (1 rader: 1 oklar)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 07-03 10:58:55 | text | Klaffbron | DIAMOND | Klaffbron, om 26 min | Klaffbron, om 25 min | ingen linjekorsning | — → — | oklar |

### 20260702-2h (1 rader: 1 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 07-02 13:00:16 | text | Stridsbergsbron | YEMANJA II | Stridsbergsbron, om 4 min | Stridsbergsbron, om 3 min | 13:35:13 (+34,9 min) | -30,9 → -31,9 | sämre |

### 20260707-14h (3 rader: 1 oklar, 2 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 07-07 08:15:30 | text | Klaffbron | AKIRA | Tre båtar på väg mot Klaffbron, om 6 min | Tre båtar på väg mot Klaffbron, om 5 min | 08:26:11 (+10,7 min, inferred) | -4,7 → -5,7 | sämre |
| 07-07 08:18:00 | text | Klaffbron | AKIRA | Tre båtar på väg mot Klaffbron, om 6 min | Tre båtar på väg mot Klaffbron, om 5 min | 08:26:11 (+8,2 min, inferred) | -2,2 → -3,2 | sämre |
| 07-07 08:20:38 | text | Klaffbron | — | Tre båtar på väg mot Klaffbron, strax | Tre båtar på väg mot Klaffbron, ETA okänd | ingen linjekorsning | — → — | oklar |

### 20260708-21h (16 rader: 1 likvärdig, 2 oklar, 12 rättare, 1 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 07-08 06:17:28 | text | Stridsbergsbron | JUNO | Stridsbergsbron, strax | Stridsbergsbron, om 3 min | 06:22:18 (+4,8 min) | -1,8 → -1,8 | likvärdig |
| 07-08 06:19:56 | notis | Stridsbergsbron | JUNO | eta 2 | eta 3 | 06:22:18 (+2,4 min) | -0,4 → +0,6 | sämre |
| 07-08 07:07:13 | text | Klaffbron | AVALON | Två båtar på väg mot Klaffbron, om cirka 17 min | Två båtar på väg mot Klaffbron, om 12 min | 07:16:01 (+8,8 min, inferred) | +8,2 → +3,2 | rättare |
| 07-08 07:08:00 | text | Klaffbron | JAATTEN II | Två båtar på väg mot Klaffbron, om cirka 16 min | Två båtar på väg mot Klaffbron, om 12 min | 07:18:16 (+10,3 min) | +5,7 → +1,7 | rättare |
| 07-08 07:09:00 | text | Klaffbron | JAATTEN II | Två båtar på väg mot Klaffbron, om cirka 15 min | Två båtar på väg mot Klaffbron, om 12 min | 07:18:16 (+9,3 min) | +5,7 → +2,7 | rättare |
| 07-08 07:10:00 | text | Klaffbron | JAATTEN II | Två båtar på väg mot Klaffbron, om cirka 14 min | Två båtar på väg mot Klaffbron, om 12 min | 07:18:16 (+8,3 min) | +5,7 → +3,7 | rättare |
| 07-08 07:10:30 | text | Klaffbron | JAATTEN II | Två båtar på väg mot Klaffbron, om cirka 14 min | Två båtar på väg mot Klaffbron, om 12 min | 07:18:16 (+7,8 min) | +6,2 → +4,2 | rättare |
| 07-08 07:11:00 | text | Klaffbron | JAATTEN II | Två båtar på väg mot Klaffbron, om cirka 13 min | Två båtar på väg mot Klaffbron, om 12 min | 07:18:16 (+7,3 min) | +5,7 → +4,7 | rättare |
| 07-08 07:11:30 | text | Klaffbron | AVALON | Två båtar på väg mot Klaffbron, om 18 min | Två båtar på väg mot Klaffbron, om 12 min | 07:16:01 (+4,5 min, inferred) | +13,5 → +7,5 | rättare |
| 07-08 07:12:30 | text | Klaffbron | AVALON | Två båtar på väg mot Klaffbron, om cirka 12 min | Två båtar på väg mot Klaffbron, om cirka 7 min | 07:16:01 (+3,5 min, inferred) | +8,5 → +3,5 | rättare |
| 07-08 07:13:00 | text | Klaffbron | AVALON | Två båtar på väg mot Klaffbron, om cirka 12 min | Två båtar på väg mot Klaffbron, om cirka 6 min | 07:16:01 (+3,0 min, inferred) | +9,0 → +3,0 | rättare |
| 07-08 07:15:00 | text | Klaffbron | AVALON | Två båtar på väg mot Klaffbron, om 5 min | Två båtar på väg mot Klaffbron, om cirka 4 min | 07:16:01 (+1,0 min, inferred) | +4,0 → +3,0 | rättare |
| 07-08 07:16:00 | text | Klaffbron | AVALON | Två båtar på väg mot Klaffbron, om 5 min | Två båtar på väg mot Klaffbron, om cirka 3 min | 07:16:01 (+0,0 min, inferred) | +5,0 → +3,0 | rättare |
| 07-08 07:16:30 | text | Klaffbron | AVALON | Två båtar på väg mot Klaffbron, om 5 min | Två båtar på väg mot Klaffbron, om cirka 2 min | ingen linjekorsning | — → — | oklar |
| 07-08 08:55:30 | text | Klaffbron | — | Klaffbron, om cirka 2 min | Klaffbron, ETA okänd | ingen linjekorsning | — → — | oklar |
| 07-08 09:48:44 | notis | Stridsbergsbron | SOLANDE | eta 2 | eta 3 | 09:51:33 (+2,8 min, inferred) | -0,8 → +0,2 | rättare |

### 20260710-13h (3 rader: 3 rättare)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 07-10 09:04:16 | text | Stridsbergsbron | MALVA | Två båtar på väg mot Stridsbergsbron, om 16 min | Två båtar på väg mot Stridsbergsbron, om 17 min | 09:29:46 (+25,5 min, inferred) | -9,5 → -8,5 | rättare |
| 07-10 09:04:48 | text | Stridsbergsbron | MALVA | Stridsbergsbron, om 16 min | Stridsbergsbron, om 17 min | 09:29:46 (+25,0 min, inferred) | -9,0 → -8,0 | rättare |
| 07-10 09:09:00 | text | Stridsbergsbron | MALVA | Två båtar på väg mot Stridsbergsbron, om 16 min | Två båtar på väg mot Stridsbergsbron, om 17 min | 09:29:46 (+20,8 min, inferred) | -4,8 → -3,8 | rättare |

### 20260711-16h (2 rader: 2 rättare)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 07-12 09:19:07 | öppning | Stridsbergsbron | — | 09:19:07 etaMin 3 (fix) | 09:19:07 etaMin 2 (fix) | 09:21:14 (+2,1 min) | +0,9 → -0,1 | rättare |
| 07-12 09:20:08 | notis | Stridsbergsbron | MINANDRA | eta 2 | eta 1 | 09:21:14 (+1,1 min) | +0,9 → -0,1 | rättare |

### 20260712-25h (7 rader: 2 oklar, 4 rättare, 1 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 07-13 07:42:16 | text | Klaffbron | MALUCA | Två båtar på väg mot Klaffbron, strax | Två båtar på väg mot Klaffbron, om 3 min | 07:45:06 (+2,8 min) | +0,0 → +0,2 | sämre |
| 07-13 08:13:12 | text | Stridsbergsbron | NICOLINE | Två båtar på väg mot Stridsbergsbron, om 16 min | Två båtar på väg mot Stridsbergsbron, om 14 min | 08:25:16 (+12,1 min, inferred) | +3,9 → +1,9 | rättare |
| 07-13 08:14:16 | text | Stridsbergsbron | NICOLINE | Stridsbergsbron, om 16 min | Stridsbergsbron, om 14 min | 08:25:16 (+11,0 min, inferred) | +5,0 → +3,0 | rättare |
| 07-13 14:50:32 | text | Klaffbron | LIFE STYLE | Klaffbron, om 11 min | Klaffbron, om 10 min | ingen linjekorsning | — → — | oklar |
| 07-13 14:52:32 | text | Klaffbron | LIFE STYLE | Klaffbron, om 11 min | Klaffbron, om 12 min | ingen linjekorsning | — → — | oklar |
| 07-13 15:17:16 | öppning | Stridsbergsbron | ELAIZA/SENTA | (ingen) | 15:17:16 etaMin 6 (deadline) Stridsbergsbron#34 | ingen linjekorsning | — → — | rättare — ELAIZA (korsar 15:26:06, line) och SENTA (15:27:36, line) varnas som medlemmar 8,8 respektive 10,3 min före korsningarna. På e949ae1 gav SENTA:s egen #34 (bara SENTA) 15:20:11, och ELAIZA var formellt täckt av den norrgående fantomen #33 (LIFE STYLE, tyst sedan 15:05:33, korsar aldrig). etaMin-felet mot första korsningen −0,9 → −2,8 min; ledtiden 5,9 → 8,8 min |
| 07-13 15:20:11 | öppning | Stridsbergsbron | SENTA/ELAIZA | 15:20:11 etaMin 5 (deadline) Stridsbergsbron#34 | (borta) | ingen linjekorsning | — → — | rättare — ELAIZA (korsar 15:26:06, line) och SENTA (15:27:36, line) varnas som medlemmar 8,8 respektive 10,3 min före korsningarna. På e949ae1 gav SENTA:s egen #34 (bara SENTA) 15:20:11, och ELAIZA var formellt täckt av den norrgående fantomen #33 (LIFE STYLE, tyst sedan 15:05:33, korsar aldrig). etaMin-felet mot första korsningen −0,9 → −2,8 min; ledtiden 5,9 → 8,8 min (raden försvinner, ersätts av 15:17:16) |

### 20260713-41h (19 rader: 4 likvärdig, 1 oklar, 12 rättare, 2 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 07-14 06:53:53 | text | Stridsbergsbron | FRAM | Stridsbergsbron, om 26 min | Stridsbergsbron, om 24 min | 07:31:26 (+37,5 min) | -11,5 → -13,5 | sämre |
| 07-14 07:07:57 | text | Klaffbron | ARVIKA | Klaffbron, om 14 min | Klaffbron, om 13 min | 07:21:20 (+13,4 min) | +0,6 → -0,4 | rättare |
| 07-14 07:13:00 | text | Klaffbron | ARVIKA | Klaffbron, om cirka 9 min | Klaffbron, om cirka 8 min | 07:21:20 (+8,3 min) | +0,7 → -0,3 | rättare |
| 07-14 07:13:30 | text | Klaffbron | ARVIKA | Klaffbron, om cirka 9 min | Klaffbron, om cirka 7 min | 07:21:20 (+7,8 min) | +1,2 → -0,8 | rättare |
| 07-14 07:14:00 | text | Klaffbron | ARVIKA | Klaffbron, om cirka 8 min | Klaffbron, om cirka 7 min | 07:21:20 (+7,3 min) | +0,7 → -0,3 | rättare |
| 07-14 07:14:30 | text | Klaffbron | ARVIKA | Klaffbron, om cirka 8 min | Klaffbron, om cirka 6 min | 07:21:20 (+6,8 min) | +1,2 → -0,8 | rättare |
| 07-14 07:15:00 | text | Klaffbron | ARVIKA | Klaffbron, om cirka 7 min | Klaffbron, om cirka 6 min | 07:21:20 (+6,3 min) | +0,7 → -0,3 | rättare |
| 07-14 07:15:30 | text | Klaffbron | ARVIKA | Klaffbron, om cirka 7 min | Klaffbron, om cirka 5 min | 07:21:20 (+5,8 min) | +1,2 → -0,8 | rättare |
| 07-14 07:16:00 | text | Klaffbron | ARVIKA | Klaffbron, om cirka 6 min | Klaffbron, om cirka 5 min | 07:21:20 (+5,3 min) | +0,7 → -0,3 | rättare |
| 07-14 07:16:50 | text | Klaffbron | ARVIKA | Klaffbron, om cirka 5 min | Klaffbron, om cirka 4 min | 07:21:20 (+4,5 min) | +0,5 → -0,5 | likvärdig |
| 07-14 07:17:30 | text | Klaffbron | ARVIKA | Klaffbron, om cirka 5 min | Klaffbron, om cirka 3 min | 07:21:20 (+3,8 min) | +1,2 → -0,8 | rättare |
| 07-14 07:17:50 | text | Klaffbron | ARVIKA | Klaffbron, om cirka 4 min | Klaffbron, om cirka 3 min | 07:21:20 (+3,5 min) | +0,5 → -0,5 | likvärdig |
| 07-14 07:51:00 | text | Klaffbron | LAMANTIJN | Klaffbron, strax | Klaffbron, om 3 min | 08:01:11 (+10,2 min, inferred) | -7,2 → -7,2 | likvärdig |
| 07-14 08:30:55 | text | Stridsbergsbron | — | Två båtar på väg mot Stridsbergsbron, strax | Två båtar på väg mot Stridsbergsbron, om 4 min | ingen linjekorsning | — → — | oklar |
| 07-14 08:31:42 | text | Stridsbergsbron | JOY | Två båtar på väg mot Stridsbergsbron, strax | Två båtar på väg mot Stridsbergsbron, om 4 min | 08:57:41 (+26,0 min, inferred) | -23,0 → -22,0 | rättare |
| 07-14 08:33:43 | text | Stridsbergsbron | JOY | Två båtar på väg mot Stridsbergsbron, strax | Två båtar på väg mot Stridsbergsbron, om 4 min | 08:57:41 (+24,0 min, inferred) | -21,0 → -20,0 | rättare |
| 07-14 08:40:42 | text | Klaffbron | IL PUNTO | Klaffbron, strax | Klaffbron, om 3 min | 08:44:45 (+4,1 min) | -1,1 → -1,1 | likvärdig |
| 07-14 12:02:43 | text | Klaffbron | SILVERTASS | Klaffbron, om 4 min | Klaffbron, om 3 min | 07:05:46 (+1143,0 min, inferred) | -1139,0 → -1140,0 | sämre |
| 07-15 09:36:30 | text | Stridsbergsbron | LINNEA | Två båtar på väg mot Stridsbergsbron, om 13 min | Två båtar på väg mot Stridsbergsbron, om 14 min | 09:55:48 (+19,3 min, inferred) | -6,3 → -5,3 | rättare |

### 20260804-17h (7 rader: 1 oklar, 6 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 08-04 07:28:07 | text | Stridsbergsbron | CARMEN VAXHOLM | Två båtar på väg mot Stridsbergsbron, om 21 min | Två båtar på väg mot Stridsbergsbron, om 17 min | 07:54:52 (+26,8 min) | -5,8 → -9,8 | sämre |
| 08-04 07:30:33 | text | Stridsbergsbron | CARMEN VAXHOLM | Stridsbergsbron, om 21 min | Stridsbergsbron, om 17 min | 07:54:52 (+24,3 min) | -3,3 → -7,3 | sämre |
| 08-04 10:08:00 | text | Stridsbergsbron | CYGNUS | Två båtar på väg mot Stridsbergsbron, om 4 min | Två båtar på väg mot Stridsbergsbron, om 3 min | 10:29:30 (+21,5 min) | -17,5 → -18,5 | sämre |
| 08-04 10:11:30 | text | Stridsbergsbron | CYGNUS | Två båtar på väg mot Stridsbergsbron, om 4 min | Två båtar på väg mot Stridsbergsbron, om 3 min | 10:29:30 (+18,0 min) | -14,0 → -15,0 | sämre |
| 08-04 10:11:35 | text | Stridsbergsbron | CYGNUS | Två båtar på väg mot Stridsbergsbron, om 4 min | Två båtar på väg mot Stridsbergsbron, om 3 min | 10:29:30 (+17,9 min) | -13,9 → -14,9 | sämre |
| 08-04 14:17:10 | text | Klaffbron | ORCA | Två båtar på väg mot Klaffbron, strax | Två båtar på väg mot Klaffbron, om 3 min | ingen linjekorsning | — → — | oklar |
| 08-04 15:55:31 | text | Klaffbron | JUNO | Klaffbron, strax | Klaffbron, om 3 min | 15:58:13 (+2,7 min) | +0,0 → +0,3 | sämre |

### 20260804-both-21h (25 rader: 1 oklar, 4 rättare, 20 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 08-05 01:03:01 | öppning | Stridsbergsbron | — | 01:03:01 etaMin 5 (fix) | 01:03:01 etaMin 4 (fix) | 03:19:38 (+136,6 min) | -131,6 → -132,6 | sämre |
| 08-05 07:04:53 | öppning | Klaffbron | — | 07:04:53 etaMin 9 (deadline) | 07:04:53 etaMin 8 (deadline) | 07:14:12 (+9,3 min, inferred) | -0,3 → -1,3 | sämre |
| 08-05 07:09:02 | notis | Klaffbron | ANYA ELAN 380 | eta 3 | eta 2 | 07:14:12 (+5,2 min, inferred) | -2,2 → -3,2 | sämre |
| 08-05 07:42:19 | notis | Klaffbron | ANYA ELAN 380 | eta 5 | eta 4 | ingen linjekorsning | — → — | oklar |
| 08-05 07:44:29 | öppning | Klaffbron | — | 07:44:29 etaMin 7 (fix) | 07:44:29 etaMin 6 (fix) | 07:51:07 (+6,6 min) | +0,4 → -0,6 | sämre |
| 08-05 08:49:43 | öppning | Stridsbergsbron | — | 08:49:43 etaMin 8 (deadline) | 08:49:43 etaMin 7 (deadline) | 09:42:45 (+53,0 min) | -45,0 → -46,0 | sämre |
| 08-05 08:49:52 | öppning | Klaffbron | — | 08:49:52 etaMin 11 (deadline) | 08:49:52 etaMin 10 (deadline) | 09:48:20 (+58,5 min, inferred) | -47,5 → -48,5 | sämre |
| 08-05 09:14:49 | notis | Stridsbergsbron | YOLO 2 | eta 7 | eta 6 | 09:44:37 (+29,8 min, inferred) | -22,8 → -23,8 | sämre |
| 08-05 10:08:40 | öppning | Klaffbron | — | 10:08:40 etaMin 7 (deadline) | 10:08:40 etaMin 6 (deadline) | 10:15:12 (+6,5 min) | +0,5 → -0,5 | sämre |
| 08-05 11:22:19 | text | Klaffbron | S/Y THELMA | Klaffbron, om 17 min | Klaffbron, om 14 min | 11:46:37 (+24,3 min, inferred) | -7,3 → -10,3 | sämre |
| 08-05 11:23:14 | text | Klaffbron | S/Y THELMA | Klaffbron, om 18 min | Klaffbron, om 15 min | 11:46:37 (+23,4 min, inferred) | -5,4 → -8,4 | sämre |
| 08-05 11:23:25 | text | Klaffbron | S/Y THELMA | Klaffbron, om 18 min | Klaffbron, om 15 min | 11:46:37 (+23,2 min, inferred) | -5,2 → -8,2 | sämre |
| 08-05 11:24:32 | text | Klaffbron | S/Y THELMA | Klaffbron, om 16 min | Klaffbron, om 15 min | 11:46:37 (+22,1 min, inferred) | -6,1 → -7,1 | sämre |
| 08-05 11:25:37 | öppning | Klaffbron | — | 11:25:37 etaMin 15 (deadline) | 11:25:37 etaMin 13 (deadline) | 11:46:37 (+21,0 min, inferred) | -6,0 → -8,0 | sämre |
| 08-05 11:25:40 | text | Klaffbron | S/Y THELMA | Klaffbron, om 13 min | Klaffbron, om 12 min | 11:46:37 (+21,0 min, inferred) | -8,0 → -9,0 | sämre |
| 08-05 11:26:21 | text | Klaffbron | S/Y THELMA | Klaffbron, om 13 min | Klaffbron, om 12 min | 11:46:37 (+20,3 min, inferred) | -7,3 → -8,3 | sämre |
| 08-05 11:26:44 | text | Klaffbron | S/Y THELMA | Klaffbron, om 10 min | Klaffbron, om 9 min | 11:46:37 (+19,9 min, inferred) | -9,9 → -10,9 | sämre |
| 08-05 11:26:50 | text | Klaffbron | S/Y THELMA | Klaffbron, om 10 min | Klaffbron, om 9 min | 11:46:37 (+19,8 min, inferred) | -9,8 → -10,8 | sämre |
| 08-05 11:30:11 | notis | Stridsbergsbron | CAVAT | eta 3 | eta 2 | 12:15:45 (+45,6 min) | -42,6 → -43,6 | sämre |
| 08-05 12:03:26 | öppning | Klaffbron | — | 12:03:26 etaMin 7 (deadline) | 12:03:26 etaMin 6 (deadline) | 12:10:24 (+7,0 min) | +0,0 → -1,0 | sämre |
| 08-05 12:08:36 | notis | Klaffbron | BLADE | eta 3 | eta 2 | 12:10:24 (+1,8 min) | +1,2 → +0,2 | rättare |
| 08-05 12:09:57 | öppning | Stridsbergsbron | — | 12:09:57 etaMin 12 (deadline) | 12:09:57 etaMin 11 (deadline) | 12:18:36 (+8,7 min) | +3,3 → +2,3 | rättare |
| 08-05 12:14:12 | öppning | Stridsbergsbron | — | 12:14:12 etaMin 7 (deadline) | 12:14:12 etaMin 6 (deadline) | 12:18:17 (+4,1 min) | +2,9 → +1,9 | rättare |
| 08-05 12:26:59 | öppning | Klaffbron | — | 12:26:59 etaMin 6 (deadline) | 12:26:59 etaMin 5 (deadline) | 12:32:16 (+5,3 min) | +0,7 → -0,3 | rättare |
| 08-05 14:07:41 | öppning | Stridsbergsbron | — | 14:07:41 etaMin 7 (deadline) | 14:07:41 etaMin 6 (deadline) | 14:30:30 (+22,8 min) | -15,8 → -16,8 | sämre |

### 20260806-42h (26 rader: 4 oklar, 13 rättare, 9 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 08-05 23:20:04 | öppning | Stridsbergsbron | — | 23:20:24 etaMin 5 (deadline) | 23:20:04 etaMin 5 (deadline) | 23:24:58 (+4,9 min) | +0,4 → +0,1 | rättare |
| 08-06 01:10:16 | öppning | Stridsbergsbron | — | 01:10:34 etaMin 5 (deadline) | 01:10:16 etaMin 5 (deadline) | 01:15:10 (+4,9 min) | +0,4 → +0,1 | rättare |
| 08-06 08:05:03 | öppning | Klaffbron | — | 08:05:03 etaMin 16 (deadline) | 08:05:03 etaMin 13 (deadline) | 08:14:08 (+9,1 min) | +6,9 → +3,9 | rättare |
| 08-06 08:13:39 | text | Klaffbron | UTOPIA | Två båtar på väg mot Klaffbron, om cirka 2 min | Två båtar på väg mot Klaffbron, ETA okänd | 08:14:08 (+0,5 min) | +1,5 → — | oklar |
| 08-06 10:05:44 | öppning | Stridsbergsbron | — | 10:05:44 etaMin 8 (deadline) | 10:05:44 etaMin 7 (deadline) | 10:28:01 (+22,3 min) | -14,3 → -15,3 | sämre |
| 08-06 10:41:25 | text | Klaffbron | S/V REBEL | Klaffbron, om 4 min | Klaffbron, om 3 min | 08:46:26 (+1325,0 min) | -1321,0 → -1322,0 | sämre |
| 08-06 11:52:47 | öppning | Stridsbergsbron | — | 11:52:47 etaMin 6 (deadline) | 11:52:47 etaMin 5 (deadline) | 11:58:33 (+5,8 min) | +0,2 → -0,8 | sämre |
| 08-06 16:24:21 | text | Stridsbergsbron | ANDREA | Stridsbergsbron, om 13 min | Stridsbergsbron, om 12 min | 18:36:13 (+131,9 min) | -118,9 → -119,9 | sämre |
| 08-06 18:52:22 | text | Klaffbron | ANDREA | Klaffbron, om 10 min | Klaffbron, om 9 min | 19:00:10 (+7,8 min) | +2,2 → +1,2 | rättare |
| 08-06 18:53:32 | öppning | Klaffbron | — | 18:53:32 etaMin 10 (fix) | 18:53:32 etaMin 9 (fix) | 19:00:10 (+6,6 min) | +3,4 → +2,4 | rättare |
| 08-06 18:53:32 | text | Klaffbron | ANDREA | Klaffbron, om 11 min | Klaffbron, om 10 min | 19:00:10 (+6,6 min) | +4,4 → +3,4 | rättare |
| 08-06 18:58:04 | notis | Klaffbron | ANDREA | eta 4 | eta 3 | 19:00:10 (+2,1 min) | +1,9 → +0,9 | rättare |
| 08-06 19:44:25 | notis | Klaffbron | MONIKA | eta 4 | eta 3 | 19:47:17 (+2,9 min) | +1,1 → +0,1 | rättare |
| 08-06 19:57:55 | öppning | Stridsbergsbron | — | 19:57:55 etaMin 6 (deadline) | 19:57:55 etaMin 5 (deadline) | 20:01:08 (+3,2 min) | +2,8 → +1,8 | rättare |
| 08-07 09:12:50 | text | Stridsbergsbron | — | Fem båtar på väg mot Stridsbergsbron, strax | Fem båtar på väg mot Stridsbergsbron, om 3 min | ingen linjekorsning | — → — | oklar |
| 08-07 09:13:57 | notis | Stridsbergsbron | AGULHAS | eta 3 | eta 2 | 10:05:06 (+51,1 min, inferred) | -48,1 → -49,1 | sämre |
| 08-07 09:17:18 | notis | Stridsbergsbron | MOKENDEIST | eta 4 | eta 3 | 11:43:11 (+145,9 min) | -141,9 → -142,9 | sämre |
| 08-07 10:16:07 | notis | Klaffbron | ELFKUNGEN | eta 3 | eta 2 | 10:17:48 (+1,7 min) | +1,3 → +0,3 | rättare |
| 08-07 11:49:03 | text | Klaffbron | MISTRAL | Två båtar på väg mot Klaffbron, om 13 min | Två båtar på väg mot Klaffbron, om 12 min | 12:24:33 (+35,5 min) | -22,5 → -23,5 | sämre |
| 08-07 11:51:21 | text | Klaffbron | MISTRAL | Två båtar på väg mot Klaffbron, om 12 min | Två båtar på väg mot Klaffbron, om 10 min | 12:24:33 (+33,2 min) | -21,2 → -23,2 | sämre |
| 08-07 11:53:39 | text | Klaffbron | MISTRAL | Klaffbron, om 12 min | Klaffbron, om 10 min | 12:24:33 (+30,9 min) | -18,9 → -20,9 | sämre |
| 08-07 12:17:13 | öppning | Klaffbron | — | 12:17:13 etaMin 7 (fix) | 12:17:13 etaMin 6 (fix) | 12:22:20 (+5,1 min) | +1,9 → +0,9 | rättare |
| 08-07 12:22:47 | notis | Klaffbron | MISTRAL | eta 4 | eta 1 | 12:24:33 (+1,8 min) | +2,2 → -0,8 | rättare |
| 08-07 16:03:02 | notis | Stridsbergsbron | FARUREJ | eta 3 | eta 2 | 16:05:28 (+2,4 min) | +0,6 → -0,4 | rättare |
| 08-07 16:07:30 | öppning | Klaffbron | 261005370 | 16:07:30 etaMin 7 (fix) | 16:07:30 etaMin 6 (fix) | ingen linjekorsning | — → — | oklar — etaMin 7 → 6; ledaren korsar inte Klaffbron i gt-passages, varningen finns i båda körningarna |
| 08-07 16:14:15 | text | Klaffbron | FARUREJ | Klaffbron, om 4 min | Klaffbron, om 3 min | ingen linjekorsning | — → — | oklar |

### 20260823-24h (4 rader: 3 rättare, 1 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 08-24 08:27:21 | text | Klaffbron | TANGELA | Klaffbron, om 21 min | Klaffbron, om 19 min | 08:42:19 (+15,0 min, inferred) | +6,0 → +4,0 | rättare |
| 08-24 08:30:33 | öppning | Klaffbron | — | 08:30:33 etaMin 13 (deadline) | 08:30:33 etaMin 12 (deadline) | 08:42:19 (+11,8 min, inferred) | +1,2 → +0,2 | rättare |
| 08-24 16:07:50 | öppning | Klaffbron | — | 16:07:50 etaMin 11 (deadline) | 16:07:50 etaMin 10 (deadline) | 16:17:40 (+9,8 min) | +1,2 → +0,2 | rättare |
| 08-24 16:34:01 | text | Stridsbergsbron | PRIMA LADY | Stridsbergsbron, om 3 min | Stridsbergsbron, om 4 min | 16:37:07 (+3,1 min) | -0,1 → +0,9 | sämre mot e949ae1; rättare mot 7699cbe (om 7, +3,9) |

### 20260907-31h (4 rader: 1 rättare, 3 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 09-07 04:06:19 | notis | Klaffbron | TROUBADOUR | eta 3 | eta 2 | 04:08:16 (+1,9 min) | +1,1 → +0,1 | rättare |
| 09-07 13:25:14 | notis | Stridsbergsbron | ELFKUNGEN | eta 3 | eta 2 | 13:28:16 (+3,0 min) | -0,0 → -1,0 | sämre |
| 09-07 15:12:51 | öppning | Stridsbergsbron | — | 15:13:13 etaMin 5 (deadline) | 15:12:51 etaMin 5 (deadline) | 15:19:00 (+6,2 min) | -0,8 → -1,2 | sämre |
| 09-07 18:35:19 | text | Stridsbergsbron | OLA | Stridsbergsbron, om 4 min | Stridsbergsbron, om 3 min | 18:51:24 (+16,1 min) | -12,1 → -13,1 | sämre |

### 20260909-80h (6 rader: 3 rättare, 3 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 09-10 15:35:40 | notis | Klaffbron | TINY | eta 2 | eta 1 | 15:40:01 (+4,3 min) | -2,3 → -3,3 | sämre |
| 09-10 16:06:35 | öppning | Klaffbron | — | 16:06:35 etaMin 7 (deadline) | 16:06:35 etaMin 6 (deadline) | 16:12:21 (+5,8 min) | +1,2 → +0,2 | rättare |
| 09-10 16:11:36 | notis | Klaffbron | ELFKUNGEN | eta 3 | eta 2 | 16:12:21 (+0,8 min) | +2,2 → +1,2 | rättare |
| 09-10 16:34:09 | öppning | Stridsbergsbron | — | 16:34:09 etaMin 6 (fix) | 16:34:09 etaMin 5 (fix) | 16:36:21 (+2,2 min) | +3,8 → +2,8 | rättare |
| 09-10 18:00:35 | öppning | Stridsbergsbron | — | 18:00:58 etaMin 5 (deadline) | 18:00:35 etaMin 5 (deadline) | 18:07:43 (+7,1 min) | -1,8 → -2,1 | sämre |
| 09-10 18:04:58 | notis | Stridsbergsbron | ELFKUNGEN | eta 2 | eta 1 | 18:07:43 (+2,8 min) | -0,8 → -1,8 | sämre |

### 20260917-16h (19 rader: 1 likvärdig, 8 oklar, 6 rättare, 4 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 09-17 21:08:40 | öppning | Stridsbergsbron | — | 21:08:40 etaMin 5 (fix) | 21:08:40 etaMin 4 (fix) | 21:10:51 (+2,2 min) | +2,8 → +1,8 | rättare |
| 09-18 00:05:41 | öppning | Stridsbergsbron | — | 00:05:41 etaMin 4 (deadline) | 00:05:41 etaMin 3 (deadline) | 00:08:53 (+3,2 min) | +0,8 → -0,2 | rättare |
| 09-18 02:19:18 | öppning | Stridsbergsbron | — | 02:20:08 etaMin 5 (deadline) | 02:19:18 etaMin 5 (deadline) | 02:25:26 (+6,1 min) | -0,3 → -1,1 | sämre |
| 09-18 02:24:59 | notis | Stridsbergsbron | SINE BRES | eta 2 | eta 1 | 02:25:26 (+0,5 min) | +1,5 → +0,5 | rättare |
| 09-18 02:56:30 | öppning | Stridsbergsbron | — | 02:57:00 etaMin 5 (deadline) | 02:56:30 etaMin 5 (deadline) | 03:01:58 (+5,5 min) | +0,0 → -0,5 | sämre |
| 09-18 03:03:14 | öppning | Klaffbron | — | 03:03:14 etaMin 6 (fix) | 03:03:14 etaMin 5 (fix) | 03:08:47 (+5,6 min) | +0,4 → -0,6 | sämre |
| 09-18 03:07:44 | notis | Klaffbron | NORDIC SOLA | eta 2 | eta 1 | 03:08:47 (+1,1 min) | +0,9 → -0,1 | rättare |
| 09-18 05:58:29 | öppning | Stridsbergsbron | — | 05:58:29 etaMin 13 (deadline) | 05:58:29 etaMin 12 (deadline) | 06:05:36 (+7,1 min) | +5,9 → +4,9 | rättare |
| 09-18 06:07:30 | öppning | Klaffbron | — | 06:07:30 etaMin 7 (fix) | 06:07:30 etaMin 6 (fix) | 06:14:01 (+6,5 min) | +0,5 → -0,5 | likvärdig |
| 09-18 06:12:20 | notis | Klaffbron | TUNA | eta 3 | eta 2 | 06:14:01 (+1,7 min) | +1,3 → +0,3 | rättare |
| 09-18 09:19:32 | notis | Stridsbergsbron | KAPEREN | eta 3 | eta 2 | 09:23:38 (+4,1 min) | -1,1 → -2,1 | sämre |
| 09-18 09:40:30 | text | Klaffbron | SYBIL OF WIVENHOE | Två båtar på väg mot Klaffbron, om 14 min | Två båtar på väg mot Klaffbron, om 13 min | ingen linjekorsning | — → — | oklar |
| 09-18 09:41:06 | text | Klaffbron | SYBIL OF WIVENHOE | Två båtar på väg mot Klaffbron, om 16 min | Två båtar på väg mot Klaffbron, om 14 min | ingen linjekorsning | — → — | oklar |
| 09-18 09:43:22 | text | Klaffbron | SYBIL OF WIVENHOE | Två båtar på väg mot Klaffbron, om 17 min | Två båtar på väg mot Klaffbron, om 14 min | ingen linjekorsning | — → — | oklar |
| 09-18 09:43:22 | text | Klaffbron | SYBIL OF WIVENHOE | Två båtar på väg mot Klaffbron, om 17 min | Klaffbron, om 14 min | ingen linjekorsning | — → — | oklar |
| 09-18 09:43:52 | text | Klaffbron | SYBIL OF WIVENHOE | Klaffbron, om 17 min | Klaffbron, om 14 min | ingen linjekorsning | — → — | oklar |
| 09-18 09:44:02 | öppning | Klaffbron | KAPEREN | 09:44:02 etaMin 15 (deadline) | 09:44:02 etaMin 13 (deadline) | ingen linjekorsning | — → — | oklar — etaMin 15 → 13; ingen linjekorsning (gles passage), varningen finns i båda körningarna |
| 09-18 09:44:29 | text | Klaffbron | SYBIL OF WIVENHOE | Klaffbron, om 16 min | Klaffbron, om 15 min | ingen linjekorsning | — → — | oklar |
| 09-18 09:45:40 | text | Klaffbron | SYBIL OF WIVENHOE | Klaffbron, om 11 min | Klaffbron, om 10 min | ingen linjekorsning | — → — | oklar |

### 20260917-7h (6 rader: 1 oklar, 3 rättare, 2 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 09-17 12:23:58 | öppning | Klaffbron | DORINDA | 12:23:58 etaMin 13 (deadline) | 12:23:58 etaMin 12 (deadline) | ingen linjekorsning | — → — | oklar — etaMin 13 → 12; DORINDA korsar aldrig (tyst fortsättning), varningen finns i båda körningarna |
| 09-17 14:38:05 | öppning | Klaffbron | — | 14:38:05 etaMin 14 (deadline) | 14:38:05 etaMin 13 (deadline) | 14:52:56 (+14,8 min) | -0,8 → -1,8 | sämre |
| 09-17 14:49:11 | notis | Klaffbron | SUSANNE | eta 5 | eta 4 | 14:52:56 (+3,7 min) | +1,3 → +0,3 | rättare |
| 09-17 14:58:43 | text | Stridsbergsbron | SUSANNE | Två båtar på väg mot Stridsbergsbron, om 15 min | Två båtar på väg mot Stridsbergsbron, om 14 min | 16:12:48 (+74,1 min) | -59,1 → -60,1 | sämre |
| 09-17 16:09:46 | öppning | Stridsbergsbron | — | 16:09:46 etaMin 6 (deadline) | 16:09:46 etaMin 5 (deadline) | 16:12:48 (+3,0 min) | +3,0 → +2,0 | rättare |
| 09-17 16:11:01 | notis | Stridsbergsbron | SUSANNE | eta 4 | eta 3 | 16:12:48 (+1,8 min) | +2,2 → +1,2 | rättare |

### 20260918-7h (3 rader: 2 rättare, 1 sämre)

| Datum tid (UTC) | Vad | Bro | Fartyg | Före (e949ae1) | Efter (E2-revisionen) | Rådata: nästa korsning | Fel före → efter | Bedömning |
|---|---|---|---|---|---|---|---|---|
| 09-18 12:21:57 | öppning | Stridsbergsbron | — | 12:22:43 etaMin 5 (deadline) | 12:21:57 etaMin 5 (deadline) | 12:28:56 (+7,0 min) | -1,2 → -2,0 | sämre |
| 09-18 12:34:35 | notis | Klaffbron | WILSON WESER | eta 2 | eta 1 | 12:35:31 (+0,9 min) | +1,1 → +0,1 | rättare |
| 09-18 17:26:18 | öppning | Stridsbergsbron | — | 17:26:26 etaMin 5 (deadline) | 17:26:18 etaMin 5 (fix) | 17:31:13 (+4,9 min) | +0,2 → +0,1 | rättare |

