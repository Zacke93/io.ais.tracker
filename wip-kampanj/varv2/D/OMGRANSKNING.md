# Omgranskning av familj D (SPÄRR), varv 2 — EFTER-BRON, commit 19e87b5

Granskare: samma som för GRANSKNING.md (TYST-GOLV, 9fe94c6), 2026-11-09.
S = `/tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad`, V = S/varv2,
R = V/D/rtmp. `V/D/rwt` står detached på 19e87b5 och är orörd: porcelain visar bara
node_modules.

Egna worktrees för proven:
- `V/D/ewt`: 19e87b5 med 210 s minsta tystnad.
- `V/D/gwt`: 19e87b5 där spärren aldrig släpps innan hon i sin egen fart har nått den tidigare
  bron.
- `V/D/fwt`: båda ändringarna.
- `V/D/m2wt`: B:s 0b0a35d + 19e87b5.

## Dom: ÄNDRINGAR KRÄVS (mindre)

Granskningens anmärkningar för de tre världarna är lösta: 29, 1767 och 1089 är exakt som på
c14938f, och 263 är BORTA (100 s). Familjens påståenden stämmer i de 2 000 världarna, och banken
är bitlik. Men mekanismen bakom den höga anmärkningen finns kvar i ett smalare fönster:
- Släpptiden ankare + e/sog + (d − e)/4 kn − 180 s infaller för Stridsbergsbron cirka 55 s
  innan båten i sin egen fart når Järnvägsbron, alltså medan hon fortfarande kan stanna där.
- Grinden 180 s är kortare än AISHubs mottagning av klass B:s lågfartstakt (3 polls ≈ 195 s).

En AISHub-båt med jämn takt som bromsar in i kön vid Järnvägsbron kan därför fortfarande
varnas långt för tidigt, där c14938f väntade ut kön (anm. 1). Påståendena "ingen uppmätt
kostnad" och "före bron gäller spärren som förut" (RESULTAT) håller alltså inte i allmänhet,
utan bara i de 2 000 världarna.

## Anmärkningar

### 1. MEDEL — Kö vid Järnvägsbron under tystnad ger fortfarande för tidig varning (smalare fönster)

**Belägg A: motorns värld 1511 med en poll till** (`R/var/w1511-fylld-poll.jsonl`). Det är
värld 1511 (R1, monitoring) med en enda tillagd AISHub-rad 09:20:16,911, mitt i en missad poll.
- DAGNY 265252653 hörs då var 67–69:e sekund. Hon sänder sista rörliga fixet 09:24:50 i
  2,4 kn, 372 m före Järnvägsbron, och nästa fix 09:29:18, 268,6 s senare, i 0 kn i kön.
- Enligt sanningen köar hon 09:27:11–09:46:11 och korsar Strid 09:50:45.

| Version | Varning | Före korsningen |
|---|---|---|
| c14938f | 09:45:59 | 286 s |
| 19e87b5 | 09:28:51,003 (eta 5) | 22 min, med 17 min kö kvar |

`R/var/w1511-fylld-poll.{bwt,rwt}.log` och `python3 R/tools/flows.py`.

I originalvärlden 1511 skyddas DAGNY bara av ett äldre glapp på 135 s i kadensfönstret
(2 × 135 = 270,6 s). Köfixet kom 2 s före den gränsen.

**Belägg B: kögrid** (`node R/probe/probe2.js <wt> grid`). Gridet har 84 fall:
- sista rörliga fixet e = 130–400 m före Järnvägsbron;
- farten 2,0–3,0 kn och takten 65–69 s;
- första köfixet 195, 205 eller 230 s senare.

I 35 fall varnar båda versionerna för tidigt. 19e87b5 varnar dessutom för tidigt i 26 fall där
c14938f väntade ut kön, till exempel:
- e = 202 m (BRISENs plats), 2,1 kn och glapp 195 s: c14938f 846 s, 19e87b5 180 s;
- e = 300 m, 2,5 kn och glapp 205 s: c14938f 856 s, 19e87b5 180 s.

Fusion med blandad kadens (S3, 10–65 s) ger samma sak: c14938f 1080 s, 19e87b5 180 s.

**Varför de 2 000 världarna inte visar det:** i de fall jag granskade hade kadensfönstret ett
dubbelpollsglapp på cirka 135 s. 2 × längsta blir då ungefär 270 s, och det skyddar.
- Av 320 köer vid Järnvägsbron norrut har 18 ett glapp på 180–300 s till ett köfix
  (`R/tools/queueapproach.js`).
- Värld 591 skyddas av ett fönster på 138 s, värld 1511 av ett på 135 s.
- I fält förekommer jämn AISHub-takt, till exempel 219033332 i both-21h: 68/66/69/67 s, sedan
  205 s glapp och 1,1 kn.

**Varianter** (mätta i ewt, gwt och fwt):

| Variant | 263 | 36 världar: ändrade / längre ledtid | Grid: för tidig där c14938f väntade (av 84) | 1511 + en poll |
|---|---|---|---|---|
| 19e87b5 | 100 s | 36 / 38 | 26 | varning 22 min före korsningen |
| + aldrig före bron i egen fart | 100 s | 12 / 13 | 12 | som c14938f |
| grind 210 s (3 polls) | 70 s | 27 / 27 | 8 | varning 22 min före korsningen |
| båda | 70 s | 9 / 9 | 3 | som c14938f |

Alla fyra varianterna håller 263 BORTA (`hunt.js --repro` i rwt, ewt och fwt; gwt ger
15:06:05 = 100 s). Ingen av dem varnar före en kö eller ger en fantom i de 36 världarna
(`python3 R/tools/cover.py R/wr3/bas36.jsonl R/wr3/{efter36,e210,g,f}.jsonl`).

**Förslag.**
1. Lägg till villkoret att spärren aldrig släpps innan hon i sin egen fart har nått den
   tidigare bron: `Math.max(silenceMs, travelMs − LEAD, toEarlierM / sog)`. Det är familjens
   egen princip ("före bron gäller spärren som förut"). Det behåller 263 på 100 s och stänger
   fallen av typen 1511, men minskar vinsten från 38 till 13 korsningar.
2. Höj gärna också grinden till 210 s (3 AISHub-polls). Då kvarstår 3 av 84 gridfall, men
   263 får bara 70 s.
3. Om dirigenten behåller 19e87b5 ska restrisken stå i beslutet, med 1511-varianten och
   gridet som underlag.
4. Lägg i alla fall ett test för en kö nära bron: e ≈ 200–300 m och glapp 195 s.
   Dagens kötester har sista fixet 453 m före Järnvägsbron och missar fönstret.

### 2. LÅG — Påståenden att justera

- **RESULTAT** "Före bron kan hon stanna, och där gäller spärren som förut" stämmer inte. För
  Stridsbergsbron släpps spärren cirka 55 s innan hon i egen fart når Järnvägsbron. Det följer
  av 257 m / 4 kn = 125 s mot WARNING_LEAD_MS = 180 s.
- **Konstantkommentaren** "tystnadsgränsen får aldrig vara kortare än den takten (180 s)"
  gäller sändningen. Via AISHub tas samma takt emot efter 130 eller 195 s.
- **Kostnaden i §8** ("ingen uppmätt") bör kompletteras med restfönstret i anm. 1.

## Det som höll (kontrollerat)

### Granskningens anmärkningar för de tre världarna

Värld 29, 1767 och 1089 ger alla öppningsvarningar exakt som på c14938f
(`R/worlds2/w{29,1767,1089}.{bwt,rwt}.flows`, `cmp`). Värld 263:

| Version | Varning BRISEN | Före korsningen |
|---|---|---|
| c14938f | 15:07:00,824 | 44 s |
| 19e87b5 | 15:06:05,253 | 100 s |

`hunt --repro F02-w263-Strid` ger BORTA. Granskningens punkter 3–6 (påståenden, fältmotivering,
`originalDueMs`, A:s text) är åtgärdade eller noterade för integrationen.

### Familjens påståenden

Min körning av de 36 ändrade världarna och 150 slumpvalda oförändrade, på c14938f och 19e87b5,
är lika med familjens `wr2/full-*` i 186 av 186 världar. 0 av de 150 ändras.

Över familjens 2 000 världar med `cover.py`:
- 36 världar ändras;
- 38 korsningar får längre ledtid;
- 0 varningar kommer före en väntan som c14938f väntade ut;
- 0 korsningar får kortare ledtid;
- 0 nya varningar efter korsning och 0 nya fantomer;
- antalet varningar går från 11 898 till 11 897;
- 34 varningar med samma medlemmar kommer tidigare (median 21 s, max 107 s), ingen senare.

### De adversariella proverna

Proverna körs med `node R/probe/probe2.js <wt> scen`, och alla tider räknas från det sista
rörliga fixet:

| Prov | c14938f | 19e87b5 | Bedömning |
|---|---|---|---|
| Båten passerar Järnvägsbron i tystnaden och köar 150 m före målbron (S1) | 200 s | 180 s | Båda varnar medan hon väntar vid målbron. Likvärdigt. |
| Båten kryper i 2,1 kn även efter bron (S2) | ledtid 180 s | ledtid 236 s | Ofarligt. |
| Annan tidigare bro: Olidebron före Klaffbron norrut, och Järnvägsbron före Klaffbron söderut (S4–S5) | 295 s | 295 s | Lika, eftersom sträckan efter bron (1 363 m respektive 960 m) i 4 kn når taket på 300 s. I praktiken gäller regeln bara Stridsbergsbron norrut. |
| Fusion med blandad kadens (S3) | | | Samma fönster som anm. 1. |

### Kod och samspel

- **Vakten** (`_courseAway`, `_fixDPendingReversal`) är prövad av familjens test. `_courseAway`
  delas med B:s släppväg, men B ändrar inte dess kropp.
- **B:** 19e87b5 går att cherry-picka på 0b0a35d utan konflikt. Jest för D och B är grönt
  (34/34), och 263 är BORTA (`V/D/m2wt`).

### Bitlikhet och batteriet

- **Bitlikhet:** `replay:openings` är md5-lik med c14938f (171d83c8…), och `replay:synthetic`
  är lik utom tider.
- **Dumpen:** hela resultat-JSON:en för alla 24 korpusar, med och utan monitoring, är identisk
  med c14938f utom `heapUsedMB` (48 jämförelser, 0 skillnader, `R/dump/head2*`). Inget låst
  facit flyttas.
- **Batteriet** (`bash S/port/battery.sh V/D/rwt R/batt2`): alla 13 steg gav 0.
  - jest: 370 sviter, 5 279 test och 2 överhoppade.
  - replay:all med och utan monitoring: "Alla låsta korpusar matchar facit".
  - Fassvepet med och utan monitoring: OK för 24 korpusar.
  - Porcelain: `?? node_modules`.
- **Quick mot V/bas/quick:**
  - 25 kluster i båda, och utslagen går från 58 till 57. Kandidatklustren är 4 i båda.
  - Enda utslaget som försvinner är 263 (`KANDIDAT|-|T2|LEDTID<Ns|synt` går från 2 till 1).
  - Räknarna:
    - T2 tunn R0: 82 → 81 (värld 213);
    - F-USVÄNG-matrisen: −1 (263);
    - krympningens prov: 76 → 89.
  - Till skillnad från TYST-GOLV ändras inga T3-, T4- eller T9-räknare.
