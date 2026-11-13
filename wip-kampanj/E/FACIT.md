# FACIT.md — familj E (avgångs-ETA, F04), rättningskampanjen 2026-11-04

Prototyp: `E/wt`, detached på 7699cbe. Andra revisionen: `5febba0` (koden och
regressionstestet), `5b9ea15` (DEMO-omlåsningen av 24h) och `f3a2d46`
(dokumentationen). Omlåsningen är en DEMO byggd på
7699cbe:s facit; dirigenten låser om på riktigt vid integrationen.

## Kort sagt

Rättningen flyttar facit i **tre låsta korpusar, sex rader**. Alla sex blir
rättare mot rådatan, ingen är likvärdig och ingen blir sämre.

Mot första revisionen (`e949ae1`) skiljer bara en rad: PRIMA LADYs text i
20260823-24h blir "om 4 minuter" i stället för "om 3 minuter". Golvet är nu
dubbla igångsättningsfarten (3,6 kn för 1,8 kn) i stället för 4 kn. Raden är
fortfarande rättare än 7699cbe:s "om 7" (fel +0,9 mot +3,9).

Utanför låst facit försvinner första revisionens enda försämring: SKONNERTENs
notis 07:30:52 i 20260601-41h är åter eta 2, som på 7699cbe (V4-principen,
DESIGN.md §6).

Detta är oförändrat i hela banken (24 korpusar):
- notisantal, fördelnings- och riktningsmultiset och öppningsmultiset;
- passager, notistider och notiskällor;
- öppningsvarningarnas tider, ledare och `firedBy`;
- WARN-lagret.

Det bekräftas av:
- `relockGoldenText.js`:s järngrind;
- `replay:all`, 24/24 gröna;
- `replay:openings`, som ger samma utskrift som 7699cbe (O1/O2/O3).

Alla tider nedan är UTC. "gt" betyder `tests/replay-validation/gt-passages/<korpus>.json`,
kind=line med punktstämpel. "Stillhet" är fartbufferten när avgången syns och
"golv" är avgångsgolvet i det samplet.

## 20260601-41h — 1 rad (golden-text, 178 övergångar före och efter)

| Rad | Vad ändras | Rådatabelägg (U13) | Bedömning |
|---|---|---|---|
| golden-text idx 127 | **Text.** 07:30:11.633 "En båt på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter" blir "… om 3 minuter". Idx 128 ("… strax" 07:30:52.233) är oförändrad. | jsonl: SKONNERTEN JYLLAND 220276000, stillhet [0,0, 0,1, 0,0], 3,4 kn 07:30:11, 72 m från senaste stillasampel och 318 m från Stridsbergsbron; därefter 4,2 kn 07:30:52. Golv min(4, 2 × 3,4) = 4 kn ⇒ 2,6 min, men den uppmätta farten ger 3,06 min, så M9 håller 3,0. gt: Stridsbergsbron 2026-06-03T07:32:18.148Z = **+2,1 min** från 07:30:11. | **rättare** (fel +5,9 → +0,9) |

Utanför låst facit (korpusen har inga golden-events), mätt med `measure:eta`:
SKONNERTENs notis 07:30:52 har eta 2 mot sanningen 1,4 min, som på 7699cbe.
Första revisionen gav 3, eftersom EMA:n räknade från det M9-hållna 3,0. Nu räknar
den från det ohållna värdet, eftersom samplets egen mätning (3,8 kn, 238 m) lovar
strax. LECKOs notis 07:29:14 är oförändrad (eta 3 mot 2,2).

## 20260823-24h — 3 rader (golden-text + golden-events)

| Rad | Vad ändras | Rådatabelägg (U13) | Bedömning |
|---|---|---|---|
| golden-text idx 65 | **Text.** 16:34:01.965 "En båt på väg mot Stridsbergsbron, beräknad broöppning om 7 minuter" blir "… om 4 minuter". | jsonl: PRIMA LADY 230693000, stillhet [0,4, 0,3, 0,4] (16:30:30–16:32:49), därefter 1,8 kn 16:34:01 (42 m från stillheten), 3,3 kn 16:35:01 och 4,0 kn 16:36:01. Golv 2 × 1,8 = 3,6 kn. gt: Stridsbergsbron 16:37:07.133 = **+3,1 min**. | **rättare** (fel +3,9 → +0,9) |
| golden-events notifications post 20 | **Notis.** 16:35:10.138 boat_near Stridsbergsbron northbound: eta 5 → 3 ("beräknad ankomst om 3 minuter"). Tid, källa (target), avstånd och mottagare är oförändrade. | Golv vid 3,3 kn: 3,3 + 1,5 ⇒ 4 kn. gt: 16:37:07.133 = **+1,9 min**. | **rättare** (fel +3,0 → +1,1) |
| golden-events openingWarnings post 5 | **Öppning.** Stridsbergsbron#8 16:35:10.138, ledare PRIMA LADY, `firedBy` fix: `etaMin` 5 → 3. Tid, ledare, medlemmar och riktning är oförändrade, och O1/O2-klassen likaså (samma varning, samma passage). | gt: +1,9 min | **rättare** (fel +3,0 → +1,1) |

Första revisionen gav texten "om 3" (fel −0,1). Nu blir den "om 4", eftersom
golvet i avgångssamplet följer den uppmätta igångsättningen (dubbla 1,8 kn) i
stället för att anta 4 kn. Både 3 och 4 är rättare än basens 7. Notisen och
kortet är oförändrade mot första revisionen.

## 20260907-31h — 2 rader (golden-events; golden-text är oförändrad)

| Rad | Vad ändras | Rådatabelägg (U13) | Bedömning |
|---|---|---|---|
| golden-events notifications post 22 | **Notis.** 18:50:04.897 boat_near Stridsbergsbron northbound: eta 4 → 1 ("beräknad ankomst om 1 minut"). | jsonl: OLA 265031670, stillhet [0,1, 0,0] (0,1/0,1/0,0 kn 18:44:17–18:48:15), därefter 5,3 kn 18:49:44 (145 m från stillheten). gt: Stridsbergsbron 18:51:24.729 = **+1,3 min** från 18:50:04. | **rättare** (fel +2,7 → −0,3) |
| golden-events openingWarnings post 7 | **Öppning.** Stridsbergsbron#11 18:50:04.897, ledare OLA, `firedBy` fix: `etaMin` 4 → 1. Tid, ledare och medlemmar är oförändrade, och O1/O2-klassen likaså. | gt: +1,3 min | **rättare** (fel +2,7 → −0,3) |

OLA avgår i 5,3 kn, över golvet. Här verkar alltså bara att väntans nollor
lämnar fartbufferten. Korpusnoten SEPTEMBER_REVIEW (2026-09-18) beskrev redan
PRIMA:s och OLA:s notisprognoser som "fartutjämningens kvarvarande fel".

## Utanför låst facit (mätt, men inte i någon golden-fil)

- 20260601-41h SKONNERTENs notis 07:30:52: eta 2, oförändrad mot 7699cbe.
  Första revisionens försämring (3 mot 1,4) är borta.
- Buggjägarens kritiska världar (bas-seed 1):
  - 884 (F04-representanten), 117 och 950 i F04-klustret och 1963 i F06-klustret
    är rena;
  - 664, 906, 920 och 1113 (första granskningens jämna låga fart) och 595 (M9)
    är rena;
  - 192 (F06) och 996 (U16-klassen) har samma utslag som förut.
- Platåklassen (syntetiska avgångar från tre platser, DESIGN.md §4) ingår inte
  i något facit. Fyra fall ur den är nya regressionstest.

## Riktning

Ingen riktningsrad flyttas. Riktningsmultiset och notisernas `direction` är
oförändrade i alla 24 korpusar.

## Hur raderna togs fram

- `tmp/scripts/golddiff.py` diffar golden-text och golden-events (LCS) mot en
  färsk replay och skriver gt bredvid varje rad. Den kördes mot 7699cbe:s facit
  i `tmp/base7699` för varje korpus; utdata i `tmp/rev3/bank/wt-full/golddiff.txt`.
- `tmp/scripts/bands.py` jämför `measure:eta` före och efter: parad och oparad
  population och ändrade påståenden. Utdata i `tmp/rev3/bank/wt-full/bands.txt`
  och `tmp/rev3/bank/wt/bands.txt`.
- `measure:eta` kontrollerades mot `rendering-saknas` = 0, eftersom harnessen
  tappar renderingsposter när maskinen är hårt lastad (DESIGN.md §12).
- Varianter som flyttade rader åt fel håll är avvisade (DESIGN.md §5 och
  VALIDATION.md §ETA-mätharnessen, "Familj E").
