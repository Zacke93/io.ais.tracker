# Täckningskartan — mottagningsglapp per farledssegment och källa

_Genererad 2026-08-03T23:57:30Z av `tests/replay-validation/coverageMap.js`._
_Diagnosverktyg (etapp 6, leverabel 1). Rör ingen produktionskod och ingen gate._

## Sammanfattning

* **Underlag:** 16 korpusar, ~250 h, 7113 AIS-fixar, 201 fartygsspår.
* **Mottagningen är gles i hela kanalen.** Medianglappet mellan två konsekutiva aisstream-fixar för ett fartyg i transit är **120 s** (p90 421 s). Transitmaterialet är 66 % Klass B (sänder var 30:e sekund i fart) och 34 % Klass A (var 2–10:e sekund), dvs. en förväntad sändningstakt runt 22 s — medianglappet motsvarar alltså ~5 missade sändningar, inte en storleksordning fler. Medianglappet ligger UNDER 120 s — de långa hålen är svansen, inte normaltillståndet.
* **Stadssektorn:** 0,25 fixar/min mot 0,34 i övriga sektorer (kvot 0,74), glapp p50 330 s mot 240 s, mörka passager 77 %.
* **Nattens tvåkällemätning:** AISHub (den egna antennkedjan) levererade 138 fixar mot aisstreams 70; mörka segment på samma resor 100/203 (49 %) mot 148/203 (73 %), tillsammans 78/203 (38 %) — men gallrad till samma 70 fixar ligger AISHub på 72–76 % mörkt, så skillnaden är leveransvolym, inte antenn.
* **Sämsta enskilda segmentet (aisstream):** segment 21 (2100–2200 m, Klaffbron N147m) med medianglapp 479 s (ändpunktsattribuerat 151 s på 28 glapp) och 85 % mörka passager
* **Målbroinseglingen:** i 49 % av de 224 observerade passagerna av Klaffbron/Stridsbergsbron fanns INTE EN ENDA fix på de sista 300 metrarna, och i 24 % ingen på de sista 700. Den siffran blandar två klasser: 65 passager är INFERRERADE ur samma tystnad (> 300 s fram till korsningen — de har fixes300 = 0 per konstruktion). Räknat bara på de 159 passager med verkligt observerad insegling är andelen **28 %** — fortfarande ett fullgott skäl till deadline-motorn, men det är den siffran som ska citeras. Mediantystnaden fram till passagen var 126 s (p90 779 s).

---

## 1. Metod

### 1.1 Farledsmodellen

Farleden modelleras som en polylinje med 36 noder, härledd ur korpusdatan själv (medianposition per 200 m av de 1 843 rörelsefixarna, 3-punkts utjämning, 6 iterationer) och sedan hårdkodad i verktyget så att kartan blir identisk oavsett vilken delmängd korpusar man kör.

Raka linjer bro-till-bro fungerar **inte**: kanalen svänger, och mot en rak linje ligger de faktiska fartygsspåren systematiskt fel (−110 m mellan Olidebron och Klaffbron, −200 m söder om Stallbackabron; p90 = 277 m). Mot centerlinjen är samma spår p50 = 7 m, p90 = 21 m, p95 = 27 m från linjen.

| Ankare | s längs farleden | Avstånd koordinat→farled | Metod |
|---|---:|---:|---|
| Kanalinfarten | 0 m | 6 m | vinkelrät projektion |
| Olidebron | 623 m | 11 m | broaxelns skärning |
| Klaffbron | 2003 m | 10 m | broaxelns skärning |
| Järnvägsbron | 2973 m | 4 m | broaxelns skärning |
| Stridsbergsbron | 3229 m | 9 m | broaxelns skärning |
| Stallbackabron | 5537 m | 187 m | broaxelns skärning |

Broarnas läge längs farleden bestäms genom att skära **brolinjen** (koordinat + `axisBearing`, samma modell som `geometry.hasCrossedBridgeLine` använder) mot centerlinjen — alltså där bron faktiskt korsar vattnet.

> **Sidofynd (ingen åtgärd föreslås här):** `BRIDGES.stallbackabron` ligger 187 m från farleden — koordinaten pekar på brons västra del medan farleden går under den östra. Brolinjen (axisBearing 125°) korsar farleden korrekt, så passagedetekteringen påverkas inte; men varje **avståndsmått** till Stallbackabron är systematiskt 187 m för långt när båten står rakt under bron. Övriga broar ligger inom 11 m från farleden.

### 1.2 Klockdomänen

Analysen körs i **fixtidsdomänen** (`fixTs ?? aisTimestamp`) — "när hörde mottagarnätet båten". För aisstream är fixtid och mottagningstid identiska per konstruktion. För AISHub är `fixTs` den riktiga fixtiden medan `aisTimestamp` är pollens leveranstid; att mäta AISHub i leveransdomänen hade gett 65-sekunderskvantiserade "glapp" för allting — det är pollkadensen, inte antennen.

### 1.3 Definitioner

| Begrepp | Definition | Härledning |
|---|---|---|
| Transitfix | fix med sog ≥ 2 kn | uppdragsgivet; 62 % av alla fixar ligger på exakt 0 kn och 12 % i 0–2 kn (kajvobbel) |
| Segment | 100 m längs farleden | ≈ 30 s färd i 6,5 kn (p95-farten) |
| Korridor | ≤ 150 m lateralt | p99 för rörelsefixarnas lateralavstånd är 118 m |
| Transitlänk | två konsekutiva fixar, samma fartyg + källa, implicerad fart ≥ 2 kn, ≤ 60 min isär, ≤ 40 kn | båten har bevisligen färdats genom de spända segmenten under glappet |
| Blackout | transitlänk med glapp > 120 s | uppdragsgivet; graderas i glapp/allvarlig/kritisk (>120/>300/>600 s) |
| Mörk passage | ett segment traverseras utan en enda fix från källan | den renaste antennsignalen: hålet var totalt |
| Exponering | tid i segmentet, linjärt interpolerad längs transitlänkarna | nämnare för fixfrekvensen (fart-neutral) |

Självkontroll av projektionen mot produktionens `geometry.distancePointToSegmentM`: 105 punkter, största avvikelse 0.0e+0 m — samma matematik, ingen parallell sanning.

## 2. Underlaget

| Korpus | h | Fixar | Fartyg | Källor | I kartan | S om kartan | N om kartan | Utanför korridoren | Blackouts |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| 20260525 | 4 | 244 | 6 | aisstream | 222 | 0 | 22 | 0 | 28 |
| 20260601-41h | 41 | 1007 | 18 | aisstream | 332 | 0 | 260 | 415 | 82 |
| 20260610-förfix | 1 | 13 | 1 | aisstream | 13 | 0 | 0 | 0 | 0 |
| 20260611-4h | 4 | 10 | 1 | aisstream | 7 | 0 | 3 | 0 | 4 |
| 20260610-19h | 19 | 362 | 12 | aisstream | 327 | 0 | 35 | 0 | 57 |
| 20260702-11h | 11 | 123 | 11 | aisstream | 116 | 0 | 7 | 0 | 29 |
| 20260702-2h | 2 | 97 | 9 | aisstream | 90 | 0 | 7 | 0 | 22 |
| 20260702-19h | 19.5 | 330 | 12 | aisstream | 308 | 0 | 22 | 0 | 58 |
| 20260707-14h | 14 | 168 | 15 | aisstream | 151 | 0 | 17 | 0 | 71 |
| 20260708-21h | 21 | 103 | 10 | aisstream | 91 | 0 | 12 | 0 | 49 |
| 20260710-13h | 13.5 | 302 | 12 | aisstream | 168 | 0 | 133 | 1 | 77 |
| 20260711-7h | 7 | 210 | 8 | aisstream | 25 | 183 | 2 | 0 | 8 |
| 20260711-16h | 16.5 | 583 | 14 | aisstream | 102 | 475 | 5 | 1 | 32 |
| 20260712-25h | 25 | 821 | 27 | aisstream | 176 | 635 | 8 | 2 | 68 |
| 20260713-41h | 41 | 1355 | 34 | aisstream | 402 | 937 | 15 | 1 | 139 |
| 20260803-natt | 10 | 1385 | 11 | aishub + aisstream | 208 | 1169 | 8 | 0 | 19 |

Kartan börjar per definition vid **Kanalinfarten** och slutar vid **Stallbackabron** — trafiken gör det inte. "S om kartan" är i huvudsak den permanent förtöjda flottan vid infarten (PRICKBJORN, CAPELLA, VIRGO, S/Y ENYA, KNIGHT OWL m.fl.) plus sydlig insegling upp till ~560 m innan triggerpunkten; "N om kartan" är trafik ovanför Stallbackabron. "Utanför korridoren" = gästhamnar, Spikö-ankringen och annat som inte är farled. Att andelen är hög är alltså väntat och inte ett mätfel — men det betyder att kartan INTE säger något om mottagningen vid infartskajerna.

> **Kolumnen "S om kartan" hoppar från 0 till hundratals mellan 20260710-13h och 20260711-7h.** Det är inte ett mätfel utan ett spår av `AIS_CONFIG.BOUNDING_BOX.SOUTH`, som flyttades 58,2681 → 58,26 (ChatGPT-granskningen 2026-07-10, F1). Före den ändringen prenumererade appen inte på området söder om Kanalinfarten, så infartsflottan syns helt enkelt inte i de äldre korpusarna. Det är ett bevis på att projektionen klassar rätt — och en påminnelse om att korpusarna inte är utbytbara mot varandra.

## 3. Segmenttabellen (alla korpusar, källa: aisstream)

`n` = transitfixar, `exp` = exponeringstid i minuter, `fix/min` = transitfixar per exponeringsminut, `mörk` = andel traverseringar helt utan fix, `p50/p90/max` = glapp i sekunder.

| # | s (m) | Landmärke | n | exp (min) | fix/min | trav | mörk | p50 | p90 | max | blackouts |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 0–100 | **Kanalinfarten** | 20 | 30.6 | 0,65 | 44 | 55 % | 240 | 663 | 1199 | 37 |
| 1 | 100–200 | Kanalinfarten N150m | 28 | 45.9 | 0,61 | 62 | 55 % | 180 | 594 | 1199 | 51 |
| 2 | 200–300 | Kanalinfarten N250m | 19 | 54.5 | 0,35 | 72 | 76 % | 210 | 640 | 1458 | 59 |
| 3 | 300–400 | Olidebron S273m | 34 | 64.1 | 0,53 | 87 | 64 % | 180 | 594 | 1458 | 77 |
| 4 | 400–500 | Olidebron S173m | 34 | 71.9 | 0,47 | 101 | 65 % | 210 | 599 | 1576 | 85 |
| 5 | 500–600 | Olidebron S73m | 33 | 83.1 | 0,40 | 113 | 66 % | 213 | 594 | 1576 | 96 |
| 6 | 600–700 | **Olidebron** | 31 | 90 | 0,34 | 117 | 74 % | 211 | 594 | 1576 | 92 |
| 7 | 700–800 | Olidebron N127m | 37 | 95.5 | 0,39 | 126 | 67 % | 211 | 604 | 1576 | 104 |
| 8 | 800–900 | Olidebron N227m | 46 | 98 | 0,47 | 129 | 61 % | 210 | 640 | 2488 | 109 |
| 9 | 900–1000 | Olidebron N327m | 41 | 98.4 | 0,42 | 127 | 69 % | 210 | 840 | 2661 | 108 |
| 10 | 1000–1100 | Olidebron N427m | 35 | 97.8 | 0,36 | 130 | 73 % | 211 | 900 | 2661 | 116 |
| 11 | 1100–1200 | Olidebron N527m | 32 | 98.6 | 0,32 | 130 | 75 % | 210 | 960 | 2661 | 123 |
| 12 | 1200–1300 | Olidebron N627m | 24 | 98.8 | 0,24 | 130 | 81 % | 231 | 963 | 2661 | 116 |
| 13 | 1300–1400 | Klaffbron S653m | 33 | 99.7 | 0,33 | 130 | 75 % | 231 | 1150 | 2661 | 125 |
| 14 | 1400–1500 | Klaffbron S553m | 34 | 103.8 | 0,33 | 127 | 74 % | 243 | 1201 | 3160 | 128 |
| 15 | 1500–1600 | Klaffbron S453m | 22 | 105 | 0,21 | 127 | 82 % | 302 | 1320 | 3160 | 120 |
| 16 | 1600–1700 | Klaffbron S353m | 26 | 104.6 | 0,25 | 124 | 76 % | 269 | 1320 | 3160 | 115 |
| 17 | 1700–1800 | Klaffbron S253m | 22 | 101.2 | 0,22 | 122 | 78 % | 349 | 1458 | 3160 | 109 |
| 18 | 1800–1900 | Klaffbron S153m | 26 | 101.9 | 0,26 | 119 | 78 % | 323 | 1530 | 3160 | 108 |
| 19 | 1900–2000 | Klaffbron S53m | 23 | 102.2 | 0,23 | 118 | 81 % | 323 | 1530 | 3160 | 110 |
| 20 | 2000–2100 | **Klaffbron** | 22 | 99.2 | 0,22 | 115 | 83 % | 332 | 1530 | 3160 | 104 |
| 21 | 2100–2200 | Klaffbron N147m | 17 | 96.3 | 0,18 | 110 | 85 % | 479 | 1558 | 3160 | 103 |
| 22 | 2200–2300 | Klaffbron N247m | 24 | 93.4 | 0,26 | 111 | 75 % | 357 | 1558 | 3160 | 106 |
| 23 | 2300–2400 | Klaffbron N347m | 35 | 93 | 0,38 | 111 | 69 % | 323 | 1558 | 3160 | 107 |
| 24 | 2400–2500 | Klaffbron N447m | 20 | 91 | 0,22 | 108 | 77 % | 300 | 1576 | 3160 | 97 |
| 25 | 2500–2600 | Järnvägsbron S423m | 23 | 85.7 | 0,27 | 102 | 79 % | 323 | 1635 | 3160 | 91 |
| 26 | 2600–2700 | Järnvägsbron S323m | 15 | 84.5 | 0,18 | 100 | 80 % | 363 | 1635 | 3160 | 89 |
| 27 | 2700–2800 | Järnvägsbron S223m | 19 | 81.3 | 0,23 | 101 | 75 % | 363 | 1635 | 3160 | 94 |
| 28 | 2800–2900 | Järnvägsbron S123m | 22 | 81.7 | 0,27 | 104 | 72 % | 323 | 1576 | 3160 | 99 |
| 29 | 2900–3000 | **Järnvägsbron** | 25 | 86.8 | 0,29 | 108 | 76 % | 284 | 1576 | 3160 | 96 |
| 30 | 3000–3100 | Järnvägsbron N77m | 16 | 85.7 | 0,19 | 109 | 79 % | 284 | 1576 | 3160 | 100 |
| 31 | 3100–3200 | Stridsbergsbron S79m | 20 | 88.8 | 0,23 | 114 | 75 % | 272 | 1576 | 3160 | 105 |
| 32 | 3200–3300 | **Stridsbergsbron** | 24 | 86.5 | 0,28 | 115 | 79 % | 242 | 1576 | 3160 | 106 |
| 33 | 3300–3400 | Stridsbergsbron N121m | 28 | 84.6 | 0,33 | 118 | 66 % | 264 | 1530 | 3160 | 113 |
| 34 | 3400–3500 | Stridsbergsbron N221m | 33 | 84.9 | 0,39 | 117 | 72 % | 212 | 1320 | 3160 | 109 |
| 35 | 3500–3600 | Stridsbergsbron N321m | 24 | 83.9 | 0,29 | 122 | 78 % | 241 | 900 | 3160 | 112 |
| 36 | 3600–3700 | Stridsbergsbron N421m | 39 | 85.1 | 0,46 | 129 | 71 % | 242 | 809 | 3160 | 124 |
| 37 | 3700–3800 | Stridsbergsbron N521m | 21 | 84.4 | 0,25 | 129 | 84 % | 269 | 705 | 3160 | 119 |
| 38 | 3800–3900 | Stridsbergsbron N621m | 23 | 83.3 | 0,28 | 131 | 82 % | 269 | 690 | 3160 | 125 |
| 39 | 3900–4000 | Stridsbergsbron N721m | 18 | 83.6 | 0,22 | 134 | 87 % | 270 | 690 | 3160 | 123 |
| 40 | 4000–4100 | Stridsbergsbron N821m | 17 | 81.9 | 0,21 | 135 | 87 % | 270 | 690 | 3160 | 121 |
| 41 | 4100–4200 | Stridsbergsbron N921m | 22 | 80 | 0,27 | 134 | 84 % | 269 | 661 | 3160 | 120 |
| 42 | 4200–4300 | Stridsbergsbron N1021m | 22 | 77.2 | 0,28 | 133 | 83 % | 261 | 600 | 3160 | 114 |
| 43 | 4300–4400 | Stridsbergsbron N1121m | 22 | 77.3 | 0,28 | 133 | 83 % | 250 | 599 | 3160 | 115 |
| 44 | 4400–4500 | Stallbackabron S1087m | 29 | 75.7 | 0,38 | 134 | 78 % | 241 | 570 | 3160 | 125 |
| 45 | 4500–4600 | Stallbackabron S987m | 29 | 75.7 | 0,38 | 134 | 79 % | 209 | 540 | 3160 | 117 |
| 46 | 4600–4700 | Stallbackabron S887m | 21 | 74.9 | 0,28 | 133 | 84 % | 209 | 540 | 3160 | 118 |
| 47 | 4700–4800 | Stallbackabron S787m | 36 | 74.1 | 0,49 | 133 | 73 % | 190 | 510 | 3160 | 124 |
| 48 | 4800–4900 | Stallbackabron S687m | 22 | 72.2 | 0,30 | 130 | 83 % | 199 | 540 | 3160 | 116 |
| 49 | 4900–5000 | Stallbackabron S587m | 26 | 70.5 | 0,37 | 129 | 80 % | 190 | 540 | 3160 | 114 |
| 50 | 5000–5100 | Stallbackabron S487m | 26 | 67.8 | 0,38 | 125 | 80 % | 190 | 510 | 3160 | 112 |
| 51 | 5100–5200 | Stallbackabron S387m | 31 | 64 | 0,48 | 121 | 74 % | 181 | 510 | 3160 | 103 |
| 52 | 5200–5300 | Stallbackabron S287m | 23 | 62.2 | 0,37 | 117 | 80 % | 180 | 509 | 3160 | 91 |
| 53 | 5300–5400 | Stallbackabron S187m | 38 | 60 | 0,63 | 114 | 68 % | 149 | 449 | 3160 | 82 |
| 54 | 5400–5500 | Stallbackabron S87m | 27 | 57 | 0,47 | 106 | 75 % | 180 | 423 | 3160 | 76 |
| 55 | 5500–5537 † | **Stallbackabron** | 10 | 52.2 | 0,19 | 102 | 90 % | 181 | 423 | 3160 | 72 |

† Sista segmentet är kapat vid Stallbackabron (37 m brett).

Läsanvisning: `max` upprepas i långa serier av segment eftersom ETT enda långt glapp bokförs på ALLA segment båten passerade under tystnaden — det är hela poängen med måttet ("hur långt glapp kan drabba en båt som befinner sig här").

## 4. Heatmap

Medianglapp per 100 m-segment, syd (Kanalinfarten) → nord (Stallbackabron). `·` <60 s · `░` 60–120 s · `▒` 120–240 s · `▓` 240–480 s · `█` >480 s · blank = inget underlag.

OBS: `aisstream`-raden bygger på alla 16 korpusarna, `aishub`/`fusion` finns bara i nattkorpusen — raderna är alltså inte samma underlag. Den rättvisa jämförelsen står i avsnitt 7.

```
            I─────O─────────────K─────────J─S──────────────────────B
aishub     S|░░░░░░░░░░░░░░░▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░|N
aisstream  S|▓▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒|N
fusion     S|░░░░░░░···░·░░░▒░░░░░░·░·░··░░░·····░░░░░░░░···░░░···░░░|N
            I─────O─────────────K─────────J─S──────────────────────B
            I=Kanalinfarten  O=Olidebron  K=Klaffbron  J=Järnvägsbron
            S=Stridsbergsbron  B=Stallbackabron
```

Samma karta som fixtäthet (transitfixar per exponeringsminut, aisstream — hög stapel = tät kontakt). Skalan är kapad vid p90 för att inte domineras av kantsegmenten; `†` = tunt underlag (< 5 traverseringar eller < 2 exponeringsminuter).

```
   0 m Kanalinfarten          ████████████████████████████████████████ 0,65
 100 m Kanalinfarten N150m    ████████████████████████████████████████ 0,61
 200 m Kanalinfarten N250m    █████████████████████████████            0,35
 300 m Olidebron S273m        ████████████████████████████████████████ 0,53
 400 m Olidebron S173m        ███████████████████████████████████████  0,47
 500 m Olidebron S73m         █████████████████████████████████        0,40
 600 m Olidebron              ████████████████████████████             0,34
 700 m Olidebron N127m        ████████████████████████████████         0,39
 800 m Olidebron N227m        ███████████████████████████████████████  0,47
 900 m Olidebron N327m        ██████████████████████████████████       0,42
1000 m Olidebron N427m        ██████████████████████████████           0,36
1100 m Olidebron N527m        ███████████████████████████              0,32
1200 m Olidebron N627m        ████████████████████                     0,24
1300 m Klaffbron S653m        ███████████████████████████              0,33
1400 m Klaffbron S553m        ███████████████████████████              0,33
1500 m Klaffbron S453m        █████████████████                        0,21
1600 m Klaffbron S353m        █████████████████████                    0,25
1700 m Klaffbron S253m        ██████████████████                       0,22
1800 m Klaffbron S153m        █████████████████████                    0,26
1900 m Klaffbron S53m         ███████████████████                      0,23
2000 m Klaffbron              ██████████████████                       0,22
2100 m Klaffbron N147m        ███████████████                          0,18
2200 m Klaffbron N247m        █████████████████████                    0,26
2300 m Klaffbron N347m        ███████████████████████████████          0,38
2400 m Klaffbron N447m        ██████████████████                       0,22
2500 m Järnvägsbron S423m     ██████████████████████                   0,27
2600 m Järnvägsbron S323m     ███████████████                          0,18
2700 m Järnvägsbron S223m     ███████████████████                      0,23
2800 m Järnvägsbron S123m     ██████████████████████                   0,27
2900 m Järnvägsbron           ████████████████████████                 0,29
3000 m Järnvägsbron N77m      ███████████████                          0,19
3100 m Stridsbergsbron S79m   ███████████████████                      0,23
3200 m Stridsbergsbron        ███████████████████████                  0,28
3300 m Stridsbergsbron N121m  ███████████████████████████              0,33
3400 m Stridsbergsbron N221m  ████████████████████████████████         0,39
3500 m Stridsbergsbron N321m  ████████████████████████                 0,29
3600 m Stridsbergsbron N421m  ██████████████████████████████████████   0,46
3700 m Stridsbergsbron N521m  █████████████████████                    0,25
3800 m Stridsbergsbron N621m  ███████████████████████                  0,28
3900 m Stridsbergsbron N721m  ██████████████████                       0,22
4000 m Stridsbergsbron N821m  █████████████████                        0,21
4100 m Stridsbergsbron N921m  ███████████████████████                  0,27
4200 m Stridsbergsbron N1021m ████████████████████████                 0,28
4300 m Stridsbergsbron N1121m ████████████████████████                 0,28
4400 m Stallbackabron S1087m  ████████████████████████████████         0,38
4500 m Stallbackabron S987m   ████████████████████████████████         0,38
4600 m Stallbackabron S887m   ███████████████████████                  0,28
4700 m Stallbackabron S787m   ████████████████████████████████████████ 0,49
4800 m Stallbackabron S687m   █████████████████████████                0,30
4900 m Stallbackabron S587m   ██████████████████████████████           0,37
5000 m Stallbackabron S487m   ████████████████████████████████         0,38
5100 m Stallbackabron S387m   ████████████████████████████████████████ 0,48
5200 m Stallbackabron S287m   ███████████████████████████████          0,37
5300 m Stallbackabron S187m   ████████████████████████████████████████ 0,63
5400 m Stallbackabron S87m    ███████████████████████████████████████  0,47
5500 m Stallbackabron         ████████████████                         0,19
```

## 5. Sektorerna

Enbart **aisstream** (den källa som finns i alla 16 korpusarna). AISHub-jämförelsen ligger i avsnitt 7, där båda källorna såg samma båtar samma natt.

**Vilket mått ska man läsa?** `fix/min` och `blind`-kolumnerna är fartneutrala, MEN de är betingade på samma urval: bara länkar med implicerad fart ≥ 2 kn räknas, och hur stor del av rörelsetiden som därmed kastas skiljer sig KRAFTIGT mellan sektorer (se "tappad rörelsetid" nedan). Jämförelsen är alltså inte äppel-mot-äppel — den sektor som har flest väntande båtar (målbroarna!) får mest bortsållat. `Mörka passager` är dessutom fartberoende (en båt i 8 kn hinner igenom fler 100 m-rutor mellan två fixar än en i 4 kn) — det måttet ska bara användas för att jämföra KÄLLOR inom samma sektor, där farten är densamma för båda. `Blind >120 s` = andelen av transittiden i sektorn som ligger inuti ett glapp längre än 120 s. `p50` bokförs på VARJE segment länken spänner och är därför lika mycket ett centralitetsmått som ett mottagningsmått; `p50 (ändpunkt)` räknar bara glapp som faktiskt BÖRJADE eller SLUTADE i sektorn och är det ärliga mottagningsmåttet.

| Sektor | Längd | Transitfixar | fix/min | Blind >120 s | Blind >300 s | p50 | p50 (ändpunkt) | p90 | Mörka passager |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kanalinfarten→Olidebron | 623 m | 199 | 0,45 | 80 % | 44 % | 210 | 121 | 599 | 397/596 (67 %) |
| Olidebron→Klaffbron | 1379 m | 454 | 0,30 | 83 % | 53 % | 240 | 120 | 1164 | 1404/1871 (75 %) |
| Klaffbron→Järnvägsbron | 970 m | 222 | 0,25 | 87 % | 65 % | 330 | 120 | 1576 | 826/1070 (77 %) |
| Järnvägsbron→Stridsbergsbron | 256 m | 85 | 0,24 | 88 % | 56 % | 272 | 121 | 1576 | 345/446 (77 %) |
| Stridsbergsbron→Stallbackabron | 2308 m | 611 | 0,34 | 82 % | 44 % | 211 | 121 | 600 | 2389/3008 (79 %) |
| **STADEN (Klaffbron→Stridsbergsbron)** | 1300 m | 282 | 0,24 | 87 % | 62 % | 313 | 120 | 1576 | 1089/1408 (77 %) |

**Tappad rörelsetid per sektor** (länkar under implicerad-fart-grinden, dvs. tid som INTE ingår i raderna ovan). Andelen skiljer sig kraftigt mellan sektorer, och det är den enskilt viktigaste reservationen mot att läsa tabellen som en rättvis sektorjämförelse:

| Sektor | Bortsållad rörelsetid | Behållen | Andel bortsållad |
|---|---:|---:|---:|
| Kanalinfarten→Olidebron | 472 min | 440 min | 52 % |
| Olidebron→Klaffbron | 303 min | 1495 min | 17 % |
| Klaffbron→Järnvägsbron | 715 min | 893 min | 44 % |
| Järnvägsbron→Stridsbergsbron | 139 min | 348 min | 29 % |
| Stridsbergsbron→Stallbackabron | 493 min | 1799 min | 22 % |

**Kajen norr om Klaffbron** (`MOORING_ZONES[0]` projicerar till 2197–2297 m = 100 m; statistiken tas på hela segment 21–22 = 200 m): 41 transitfixar, fix/min 0,22, mörka passager 177/221 (80 %), glapp p50 391 s / p90 1558 s.

## 6. Parvis test: är stadssektorn sämre för SAMMA resa?

Sektorer skiljer sig också i trafik, fart och årstid. Det parvisa testet eliminerar det: för varje enskild resa som exponerats ≥ 60 s i BÅDE stadssektorn (Klaffbron→Järnvägsbron) och i resten av farleden jämförs fixfrekvensen inom samma resa.

| Referens | Resor | fix/min stan | fix/min ref | Kvot | Sämre i stan | p | Blind stan | Blind ref | Blindare i stan | p |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ÖVRIGA | 138 | 0,33 | 0,32 | 1,02 | 74/138 (54 %) | 0,444 | 100 % | 89 % | 70/103 (68 %) | < 0,001 |
| Olidebron→Klaffbron | 112 | 0,29 | 0,25 | 1,14 | 63/108 (58 %) | 0,101 | 100 % | 90 % | 54/74 (73 %) | < 0,001 |
| Stridsbergsbron→Stallbackabron | 84 | 0,26 | 0,32 | 0,81 | 54/82 (66 %) | 0,005 | 100 % | 94 % | 31/53 (58 %) | 0,272 |

`ÖVRIGA` = all exponering utanför stadssektorn i samma resa. `Blind` = medianandel av tiden i sektorn som ligger inuti ett glapp > 120 s. Teckenandelarna räknas på AVGJORDA resor (oavgjorda, där måttet är exakt lika i båda sektorerna, utesluts — de bär ingen information). Teckentestet är ett tvåsidigt exakt binomialtest: vore sektorerna likvärdiga skulle "sämre i stan" inträffa i hälften av fallen.

## 7. Tvåkällenatten: aisstream vs AISHub

> **Viktigt vid tolkning:** AISHub-kolumnen är till stor del **användarens egen antennkedja** — den egna mottagaren matar AISHub, och det som kommer tillbaka via webservicen är i huvudsak samma antenn. Kolumnen mäter alltså *den egna installationen*, medan aisstream-kolumnen mäter AISstream.io:s mottagarnät över Trollhättan.

> **Och en spärr i mätningen:** AISHub pollas var 65:e sekund och returnerar EN position per fartyg och poll. Källans fixfrekvens kan därför aldrig överstiga ~0,92 fixar/min oavsett hur bra antennen är. Fixtäthet är alltså INTE jämförbar mellan källorna — men **hålen är det**: ett glapp > 120 s betyder att minst en poll passerade utan att nätet hört något nytt från båten.

| Källa | Fixar | Transitfixar | Transitlänkar | Glapp p50 | p90 | max | Mörka passager | Leveranslatens p50/p90 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| aisstream | 70 | 59 | 60 | 65 | 269 | 1558 | 129/184 (70 %) | 0/0 s |
| aishub | 138 | 103 | 106 | 70 | 80 | 630 | 100/203 (49 %) | 27.5/62.3 s |
| fusion | 184 | 149 | 152 | 46 | 71 | 630 | 78/203 (38 %) | – |

### 7.1 Gemensam nämnare — samma resor, båda källorna

Tabellen ovan har ett mätfel inbyggt: en källa som missade en HEL passage får inga traverseringar alls i det avsnittet i stället för 100 % mörker (överlevnadsbias — den sämre källan ser bättre ut). Här definieras resorna i stället av den **sammanslagna** vyn, och varje källa mäts mot exakt samma segment och samma tidsfönster.

| Källa | Mörka segment / traverseringar | Andel mörkt | Resor helt utan en enda fix |
|---|---:|---:|---:|
| aisstream | 148/203 | 73 % | 0 |
| aishub | 100/203 | 49 % | 0 |
| fusion | 78/203 | 38 % | 0 |

| Sektor | aisstream (mörkt) | aishub (mörkt) | fusion (mörkt) | AISHubs försprång |
|---|---:|---:|---:|---:|
| Kanalinfarten→Olidebron | 27/33 (82 %) | 10/33 (30 %) | 8/33 (24 %) | +52 p.e. |
| Olidebron→Klaffbron | 46/67 (69 %) | 28/67 (42 %) | 24/67 (36 %) | +27 p.e. |
| Klaffbron→Järnvägsbron | 21/34 (62 %) | 19/34 (56 %) | 14/34 (41 %) | +6 p.e. |
| Järnvägsbron→Stridsbergsbron | 7/12 (58 %) | 5/12 (42 %) | 3/12 (25 %) | +16 p.e. |
| Stridsbergsbron→Stallbackabron | 57/72 (79 %) | 44/72 (61 %) | 33/72 (46 %) | +18 p.e. |

"AISHubs försprång" = hur många procentenheter FÄRRE mörka segment den egna kedjan har än AISstream i sektorn. Ett litet försprång betyder att den egna antennen har samma hål som alla andra där.

### 7.2 Per källas egna resor

Per sektor under natten (mörka passager / traverseringar, varje källa mot sina egna resor):

| Sektor | aisstream | aishub | fusion |
|---|---:|---:|---:|
| Kanalinfarten→Olidebron | 19/25 · p50 210 s | 10/33 · p50 70 s | 8/33 · p50 62 s |
| Olidebron→Klaffbron | 40/60 · p50 120 s | 28/67 · p50 70 s | 24/67 · p50 60 s |
| Klaffbron→Järnvägsbron | 20/34 · p50 70 s | 19/34 · p50 71 s | 14/34 · p50 57 s |
| Järnvägsbron→Stridsbergsbron | 7/12 · p50 115 s | 5/12 · p50 70 s | 3/12 · p50 43 s |
| Stridsbergsbron→Stallbackabron | 52/67 · p50 151 s | 44/72 · p50 70 s | 33/72 · p50 47 s |

Korskälledubbletter som slogs ihop i fusionsvyn: 291 par (≤ 10 s och ≤ 30 m isär).

Nattens heatmap per källa (medianglapp, samma skala som ovan):

```
aisstream  S|▒▒▒▒▒▒▒▒░░░▒▒▒▒█▒▓▓▓▓▓▓▓▒▒░░░░▒░▒▒▓▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒|N
aishub     S|░░░░░░░░░░░░░░░▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░|N
fusion     S|░░░░░░░···░·░░░▒░░░░░░·░·░··░░░·····░░░░░░░░···░░░···░░░|N
```

## 8. Topp 20 blackouts

Transitlänkar med glapp > 120 s, sorterade på glapplängd. Totalt 743 blackouts i materialet (72 kritiska > 600 s, 166 allvarliga > 300 s).

| Tid (UTC) | Korpus | Källa | Fartyg | Glapp | Sträcka | Segment | sog sista fixen | Medelfart i glappet |
|---|---|---|---|---:|---:|---|---:|---:|
| 2026-07-02 09:23:34 | 20260702-11h | aisstream | MARLIN (265571760) | 52 min 40 s | 4185 m | 14→55 (1448→5633 m) | 4,4 kn | 2,6 kn |
| 2026-07-02 08:24:49 | 20260702-11h | aisstream | MOSHE (211471090) | 44 min 21 s | 4194 m | 51→9 (5150→957 m) | 6,2 kn | 3,1 kn |
| 2026-06-10 08:04:56 | 20260610-19h | aisstream | SABETH (211478350) | 41 min 28 s | 4107 m | 8→49 (881→4987 m) | 5,5 kn | 3,2 kn |
| 2026-07-13 12:26:57 | 20260712-25h | aisstream | ELFKUNGEN (265573130) | 39 min 22 s | 2746 m | 41→14 (4196→1450 m) | 8,6 kn | 2,3 kn |
| 2026-07-13 13:41:26 | 20260712-25h | aisstream | MARJELCHE (211483870) | 35 min 32 s | 2584 m | 39→13 (3950→1366 m) | 6,1 kn | 2,4 kn |
| 2026-07-08 10:23:01 | 20260708-21h | aisstream | ELFKUNGEN (265573130) | 33 min 34 s | 2112 m | 22→44 (2291→4403 m) | 4,2 kn | 2 kn |
| 2026-07-14 12:46:19 | 20260713-41h | aisstream | S/Y ONA IX (219034975) | 30 min 59 s | 2489 m | 17→42 (1712→4201 m) | 1,8 kn | 2,6 kn |
| 2026-06-03 08:16:56 | 20260601-41h | aisstream | Unknown (265759700) | 30 min 27 s | 4106 m | 55→14 (5582→1476 m) | 8,4 kn | 4,4 kn |
| 2026-07-02 08:36:21 | 20260702-11h | aisstream | SILVERMORK II (265825890) | 29 min 30 s | 1971 m | 33→13 (3369→1399 m) | 0,8 kn | 2,2 kn |
| 2026-07-10 10:11:56 | 20260710-13h | aisstream | ELFKUNGEN (265573130) | 28 min 33 s | 1993 m | 16→36 (1684→3678 m) | 6,2 kn | 2,3 kn |
| 2026-07-08 07:07:13 | 20260708-21h | aisstream | AVALON (219009353) | 27 min 59 s | 3536 m | 8→44 (891→4427 m) | 3,7 kn | 4,1 kn |
| 2026-07-14 12:54:22 | 20260713-41h | aisstream | ELFKUNGEN (265573130) | 27 min 15 s | 2390 m | 33→10 (3399→1009 m) | 1,4 kn | 2,8 kn |
| 2026-07-10 12:43:06 | 20260710-13h | aisstream | ELFKUNGEN (265573130) | 26 min 16 s | 3124 m | 35→4 (3547→424 m) | 3,2 kn | 3,9 kn |
| 2026-08-03 05:53:30 | 20260803-natt | aisstream | SALTYX (211648800) | 25 min 58 s | 1641 m | 23→7 (2379→738 m) | 0 kn | 2 kn |
| 2026-07-12 10:08:55 | 20260711-16h | aisstream | ELFKUNGEN (265573130) | 25 min 30 s | 2827 m | 8→36 (842→3668 m) | 5,9 kn | 3,6 kn |
| 2026-07-15 10:51:34 | 20260713-41h | aisstream | NEST (261435000) | 24 min 18 s | 2926 m | 32→2 (3206→280 m) | 4,5 kn | 3,9 kn |
| 2026-07-03 10:06:42 | 20260702-19h | aisstream | ELFKUNGEN (265573130) | 23 min 00 s | 3122 m | 5→36 (508→3630 m) | 5,8 kn | 4,4 kn |
| 2026-07-14 10:10:50 | 20260713-41h | aisstream | ELFKUNGEN (265573130) | 22 min 00 s | 2717 m | 9→36 (950→3668 m) | 6,5 kn | 4 kn |
| 2026-07-07 10:15:17 | 20260707-14h | aisstream | ELFKUNGEN (265573130) | 20 min 02 s | 2002 m | 14→34 (1463→3465 m) | 6,3 kn | 3,2 kn |
| 2026-07-07 15:23:13 | 20260707-14h | aisstream | ILLUSION 3 (265083240) | 20 min 01 s | 2000 m | 30→10 (3067→1067 m) | 0 kn | 3,2 kn |

`sog sista fixen` är farten i den fix då kontakten tappades — den kan vara låg (båten kom just igång) medan medelfarten under glappet bevisar att hon fortsatte. Kolumnen `Segment` visar var kontakten tappades → var den återkom.

**Tystnad efter rörelse utan bevisad framfart** (båten kan ha stannat — t.ex. väntat på broöppning; ingår ALDRIG i segmentstatistiken): 179 fall. De är designfallet för deadline-motorn: sista fixen visar fart, sedan tystnad, och appen kan inte veta om båten fortsatte eller stannade.

| Tid (UTC) | Korpus | Fartyg | sog sista fixen | Tystnad | Segment | Förflyttning | Medelfart |
|---|---|---|---:|---:|---:|---:|---:|
| 2026-07-13 08:24:16 | 20260712-25h | Unknown (265806230) | 8,5 kn | 58 min 22 s | 38 | 2974 m | 1,7 kn |
| 2026-07-08 09:55:38 | 20260708-21h | SISU (219032725) | 0,3 kn | 57 min 00 s | 17 | 1737 m | 1 kn |
| 2026-07-15 05:44:53 | 20260713-41h | RONJA (219029789) | 0 kn | 53 min 30 s | 23 | 4 m | 0 kn |
| 2026-07-15 10:04:27 | 20260713-41h | NEST (261435000) | 2,4 kn | 47 min 08 s | 34 | 269 m | 0,2 kn |
| 2026-07-15 07:54:19 | 20260713-41h | LINNEA (265764760) | 0,1 kn | 45 min 59 s | 0 | 813 m | 0,6 kn |
| 2026-07-13 07:16:55 | 20260712-25h | IDUN (265761140) | 2,3 kn | 45 min 47 s | 15 | 1273 m | 0,9 kn |
| 2026-07-15 10:08:28 | 20260713-41h | ELFKUNGEN (265573130) | 5,5 kn | 43 min 51 s | 9 | 2697 m | 2 kn |
| 2026-07-15 06:30:59 | 20260713-41h | PILGRIM (211110880) | 0,1 kn | 41 min 23 s | 23 | 567 m | 0,4 kn |
| 2026-07-07 07:41:41 | 20260707-14h | DESTINY (265706440) | 0 kn | 36 min 56 s | 23 | 349 m | 0,3 kn |
| 2026-07-11 12:27:16 | 20260711-7h | ELFKUNGEN (265573130) | 2,5 kn | 35 min 30 s | 34 | 1633 m | 1,5 kn |

## 9. Målbroinseglingen — vad visste appen när båten gick under bron?

Varje gång ett fartyg passerade **Klaffbron** eller **Stridsbergsbron** har verktyget räknat bakåt: hur långt bort låg den sista fixen före passagen, hur länge hade det då varit tyst, och hur många fixar fanns över huvud taget på de sista 1 500 / 700 / 300 metrarna. Det är inseglingens verklighet, mätt på riktig trafik.

| Källa | Passager | Sista fix (m från bron) p50 / p90 / max | Tystnad vid passagen p50 / p90 / max | Passager utan fix sista 1500 m | 700 m | 300 m |
|---|---:|---:|---:|---:|---:|---:|
| aisstream (alla 16 korpusar) | 224 | 297 / 1447 / 3579 | 126 s / 779 s / 1997 s | 20/224 (9 %) | 53/224 (24 %) | 109/224 (49 %) |
| aisstream (endast natten) | 7 | 258 / 1008 / 1008 | 104 s / 375 s / 375 s | 0/7 (0 %) | 1/7 (14 %) | 2/7 (29 %) |
| aishub (endast natten) | 7 | 85 / 376 / 376 | 30 s / 234 s / 234 s | 0/7 (0 %) | 0/7 (0 %) | 1/7 (14 %) |
| fusion (endast natten) | 7 | 52 / 376 / 376 | 17 s / 234 s / 234 s | 0/7 (0 %) | 0/7 (0 %) | 1/7 (14 %) |

"Tystnad vid passagen" är tiden från den sista fixen till det interpolerade ögonblick då fartyget korsade brolinjen. Natt-raderna är få passager och ska läsas som en illustration, inte som statistik — men riktningen är entydig: med två källor fanns det alltid data på de sista 700 metrarna.

## 10. VERDIKT

### Är stadssektorn Klaffbron↔Järnvägsbron sämre än övriga farleden?

**DELVIS — sämre i aggregatet, men den parvisa bekräftelsen är inte specifik (OBS: samma parvisa test slår ut för 2 av 5 sektorer — Klaffbron→Järnvägsbron, Järnvägsbron→Stridsbergsbron — så utslaget är inte specifikt för staden utan följer positionen i farleden).**

_Placebokontroll: samma parvisa test kört med VARJE sektor som kandidat ger utslag i 2 av 5 sektorer (Klaffbron→Järnvägsbron, Järnvägsbron→Stridsbergsbron). Utslaget är alltså inte specifikt för staden utan följer positionen i farleden — en resas fixar klumpas vid start och slut, så den långa spännande länken dominerar mitten._

Stadssektorn (970 m, segment 20–29) har 222 transitfixar över 893 exponeringsminuter = **0,25 fixar/min**. Medianen för övriga fyra sektorer är **0,34 fixar/min** (kvot 0,74). Medianglappet är 330 s mot 240 s, och 826 av 1070 traverseringar (77 %) skedde utan en enda fix.

Det parvisa testet (samma resa, stad mot resten av farleden, 138 resor — samma fartyg, samma utrustning, samma timme, så trafikmixen kan inte förklara skillnaden) skiljer på TVÅ saker. **Mängden data** är ungefär densamma: median 0,33 mot 0,32 fixar/min (kvot 1,02, 74/138 avgjorda resor sämre i stan, p = 0,444). **Fördelningen** är däremot sämre: medianresan tillbringar 100 % av sin stadstid inuti ett glapp > 120 s mot 89 % i resten av samma resa, och 70 av 103 avgjorda resor (68 %) var blindare i stan (p < 0,001). Slutsatsen: i stan kommer fixarna i klumpar med långa hål emellan — precis den felmod som fäller ett notislöfte, eftersom det är hålets längd och inte fixarnas antal som avgör om varningen hinner ut.

Tar man hela stadskärnan (Klaffbron→Stridsbergsbron, dvs. båda målbroarna och Järnvägsbron emellan) är bilden densamma: 0,24 fixar/min, medianglapp 313 s, 77 % mörka passager. **Det är exakt den sträcka där appens notislöfte avgörs** — inseglingen mot en målbro.

Rangordning (sämst först, fixar/min): Järnvägsbron→Stridsbergsbron 0,24 · Klaffbron→Järnvägsbron 0,25 · Olidebron→Klaffbron 0,30 · Stridsbergsbron→Stallbackabron 0,34 · Kanalinfarten→Olidebron 0,45.

### Kajen norr om Klaffbron

Kajsegmenten (segment 21–22 = 200 m, varav kajzonen själv är 2197–2297 m) har 0,22 fixar/min och medianglapp 391 s — klart under farledssnittet. 177 av 221 traverseringar (80 %) var mörka.

Kajzonen är dessutom den plats där sämst täckning gör mest skada: det är här V1-kajbokföringen ska skilja en avgående båt från en kajvobblare, och varje minut utan fix är en minut där avgångsbeviset inte kan samlas in.

### Sämsta enskilda segmentet

Med minst 5 traverseringar: segment 21 (2100–2200 m, Klaffbron N147m) med medianglapp 479 s (ändpunktsattribuerat 151 s på 28 glapp) och 85 % mörka passager.

Rangordnat på ÄNDPUNKTSATTRIBUERADE glapp — där kontakten faktiskt tappades eller återkom, inte där ett långt glapp råkade passera — är sämsta segmentet i stället nr 0 (0–100 m, Kanalinfarten) med 240 s på 45 glapp. Skillnaden mellan de två listorna ÄR span-attributionen: läs den första som "här är man ofta blind", den andra som "här tappas kontakten".

### Antennfrågan: vad säger tvåkällenatten?

Under de 10 timmarna levererade **AISHub 138 fixar** och **aisstream 70** i kartområdet (unionen 184 efter att 291 korskälledubbletter slagits ihop). Medianglappet i transit var 70 s för AISHub — men det talet är golvat av pollkadensen (65 s), så det ska INTE läsas som antennkvalitet. Det som ÄR jämförbart är mörka segment mätta på GEMENSAM nämnare (samma resor, samma fönster): AISHub 100/203 (49 %) mot aisstream 148/203 (73 %).

Slutsatsen för antennplaceringen: den egna kedjan (AISHub) har 49 % mörka segment mot AISstreams 73 % på samma resor; MEN skillnaden är i första hand LEVERANSVOLYM: gallras AISHub slumpmässigt ned till AISstreams 70 fixar hamnar den på 72–76 % mörkt (4 dragningar: 75→74 %, 72→72 %, 62→76 %, 68→74 %); vid samma fixantal är källorna alltså OSKILJBARA — mätningen ger inget stöd för att den egna antennen hör båtar som AISstream-nätet missar, och inget underlag för att flytta antennen; tillsammans faller mörkret till 38 % (från 49 %); även den vinsten är till största delen fler fixar, inte komplementaritet: mörkerandelen faller monotont med fixantalet enligt gallringskurvan ovan, och bara överskottet mot den kurvan är äkta komplementaritet; per sektor (endast celler med ≥30 traverseringar) är den egna kedjan starkast i Kanalinfarten→Olidebron (30 % mörkt mot AISstreams 82 %) och svagast i Stridsbergsbron→Stallbackabron (61 % mörkt) — men underlaget är 5 båtresor, så sektorsiffrorna är illustration, inte statistik, och bär ingen antennrekommendation.

---

### Vad kartan INTE säger

* Den mäter **levererad** täckning, inte radiotäckning. En fix som mottagarnätet hörde men aldrig levererade (filtrerad, tappad, downsamplad) är osynlig här och räknas som ett hål.
* Underlaget är ojämnt fördelat: 15 korpusar är enkälliga (aisstream) och en enda är tvåkällig. Källjämförelsen görs därför ENBART inom nattkorpusen, där båda källorna såg samma båtar samtidigt.
* `Mörka passager` är fartberoende och duger bara för att jämföra KÄLLOR inom samma sektor — för att jämföra sektorer med varandra används fixfrekvens, blindtid och glappkvantiler, som alla är fartneutrala.
* Målbropassagerna i avsnitt 9 är GEOMETRISKA (fartyget korsade brolinjen enligt centerlinjeprojektionen), inte appens egna passageregistreringar. De två kan skilja sig i enstaka fall — kartan vet inget om passage-latchar, GPS-hoppgater eller resemodellen.
* Exponeringstiden interpoleras ur samma fixar som räknas. I ett segment där källan var helt tyst blir exponeringen ändå rätt (den kommer från länken som spänner över hålet), men fixfrekvensen i mycket tunna segment (< 5 traverseringar) ska läsas som indikation, inte mätvärde.

