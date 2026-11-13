# Granskning av familj D (SPÄRR), varv 2 — commit 9fe94c6 (TYST-GOLV)

Granskare: adversariell granskning enligt V/GRANSKNING2.md, 2026-11-09.
S = `/tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad`, V = S/varv2,
R = V/D/rtmp (mina filer). Worktrees: `V/D/rwt` (9fe94c6, orörd), `V/D/bwt` (c14938f),
`V/D/pwt` (9fe94c6 + mätspion), `V/D/mwt` (B:s 0b0a35d + 9fe94c6), `V/D/bbwt` (B ensam),
`V/D/awt` (A:s ab9c57c), `V/D/adwt` (A + 9fe94c6), `V/D/kwt` (9fe94c6 med faktor 3),
`V/D/swt` (9fe94c6 med tystnad ≥ 200 s).

## Dom: ÄNDRINGAR KRÄVS

Koden gör det den säger, rotorsaken är rätt, testen fäller basen, och banken är bitlik.
Men rättningen tar bort en del av spärrens syfte. En båt som bromsar in och går in i
kön vid Järnvägsbron medan appen inte hör henne varnas nu 9–13 minuter tidigare än på
c14938f, före en kö på 9–10 minuter. c14938f väntade ut kön (anm. 1). En båt som vänder
under tystnaden kan ge en ny fantomvarning (anm. 2). Familjen redovisar de 89 ändrade världarna som "tidigare, med
längre ledtid" och skriver att ingen ägarfråga behövs (anm. 3). I tystnad går det inte att
skilja acceleration från inbromsning: värld 263 hade 272 s glapp, värld 29 hade 269 s. Det
här är alltså M6:s avvägning, och den ska fattas med kostnaden på bordet.

## Anmärkningar

### 1. HÖG — En kö som börjar under tystnaden ger en varning 9–13 min för tidigt (spärrens syfte)

**Belägg A, motorns världar** (egen omkörning av alla 89 ändrade världar och 60 slumpvalda
oförändrade, bas mot HEAD: `node R/tools/wrun.js bwt|rwt …`, analys `python3 R/tools/cover.py
R/wr/bas.jsonl R/wr/head.jsonl`):

```
VARIANTEN TÄCKER FÖRE EN VÄNTAN SOM BASEN VÄNTADE UT (>60 s):
 (29, '265639400', 199, 965, 0, 621), (954, …, 3850, 3931, 3485, 3567),
 (1038, …, 1410, 1487, 1074, 1151), (1767, '265478550', 268, 797, 41, 545)
   (värld, mmsi, ledtid bas, ledtid HEAD, kö efter varningen bas, kö efter varningen HEAD; s)
```

- **Värld 29** (R1, RUNA 265639400, norrut mot Stridsbergsbron). Sista rörliga raden kom
  18:18:56,341: 2,5 kn, 709 m före Strid och 453 m före Järnvägsbron, med intervallen 69,4,
  68,4, 65,2 och 66,3 s. Nästa rad kom 18:23:25, 269 s senare: 171 m före Järnvägsbron i
  0,2 kn. Enligt sanningen köade hon 18:22:34–18:32:55 och korsade Strid 18:37:32.
  - c14938f: `OPENING_DEADLINE … RUNA d=436 m, eta=okänd (bekräftad väntan vid
    Järnvägsbron)` 18:34:13, 199 s före korsningen.
  - 9fe94c6: `OPENING_DEADLINE … RUNA d=709 m, eta=7 min` 18:21:27,726, 965 s före. Det är
    max(tystnadsgränsen 18:21:15, restid i 4 kn − 180 s = 18:21:27,5), 66 s innan kön börjar.
    (`R/worlds/w29.{bwt,rwt}.log`)
- **Värld 1767** (R1, monitoring, MASEN 265478550). Sista rörliga raden 13:57:31,697 i
  3,1 kn, 728 m före Strid. Nästa rad 14:00:43,570 (192 s senare) i 1,2 kn vid Järnvägsbron.
  Kö 14:00:51–14:09:56, korsning 14:13:42. Varningen gick 14:09:14 på c14938f (268 s före)
  och 14:00:25,295 på 9fe94c6 (797 s före, 18 s innan köfixet).
- I värld 954 och 1038 var båda varningarna redan för tidiga, men HEAD:s kom 77–81 s
  tidigare. Ingen värld blev bättre i det här avseendet.

**Belägg B, minsta prob** (BOS direkt, `node R/probe/probe.js V/D/bwt|rwt`). Båten hörs var
65–69:e sekund i 2,5 kn. Sista rörliga fixet ligger 709 m före bron, och nästa fix kommer
204 s senare i kön vid Järnvägsbron:

```
bas:  A-kö-efter-klassB-glapp-204s: Stridsbergsbron#1 fix  atS 1356 … ledtid 176 s
HEAD: A-kö-efter-klassB-glapp-204s: Stridsbergsbron#1 deadline atS 552 … ledtid 980 s
```

**Mekanism.** AIS klass B, som fritidsbåtar har, sänder var 30:e sekund över 2 kn och var
3:e minut under 2 kn. Simulatorn ger stilla båtar samma takt i båda klasserna; MASEN är
klass A. Med AISHubs 65 s-poll växer mottagningsintervallet därför från ungefär 66 s till
ungefär 200 s, just när båten bromsar in mot kön. Tröskeln 2 × längsta intervallet
(ungefär 138 s) läser den normala lågfartstakten som onormal tystnad. Vid gränsen 2 kn blir
språnget också större. 459 m före bron ger 1,99 kn en spärr på 300 s i båda versionerna. Vid
2,0 kn ger c14938f 266 s, men 9fe94c6 bara cirka 138 s i tystnad.

**Fältet säger samma sak.** Jag lade en egen spion i en kopia av 9fe94c6 (`V/D/pwt`, `RSPY`)
och körde hela banken. Analysen: `python3 R/tools/spyana.py R/spy/bank.jsonl` och skriptet i
R/spy.
- Spärrzonen hade 1 339 rörliga fix. Glappet till nästa fix var större än 2 × det längsta
  intervallet i 60 av 878 fix med kadens (6,8 %).
- 29 av de 60 låg under 4 kn. Av dem kom nästa fix i under 2 kn i 11 fall (inbromsning
  eller stopp) och i minst 4 kn i bara 7 fall (acceleration).
- Banken är bitlik bara därför att fallen låg längre bort än golvets räckvidd (ungefär
  988 m), eller hade glesare kadens. Exempel: 219033332 i both-21h, 68/66/69/67 s → 205 s →
  1,1 kn.

**Familjens egen måttstock.** Variant E förkastades eftersom PILOT 761 (kö vid
Järnvägsbron) varnades 9,5 min tidigare (DESIGN §5). TYST-GOLV gör samma sak med RUNA (12,8
min tidigare) och MASEN (8,8 min tidigare), men räknas i §4 och §7 som "tidigare, längre
ledtid". Motorns orakel saknar kontroll av för tidig varning. T2 har bara ett golv, och T3
godtar en korsning inom 20 min (`PHANTOM_WINDOW_MS`), så RUNA:s varning 16 min före
korsningen döms som rätt. "Inga nya kandidater" prövar alltså inte spärrens syfte.

**Förslag.**
1. Lyft M6 till ägaren som triagen avsåg (alternativ c), med vinst och kostnad i siffror:
   - vinst: 263 (44 → 141 s) och de tunna ledtider som förlängs;
   - kostnad: värld 29, 1767, 1089 och 1902.
2. Vill man smalna av, är faktorn 3 det jag mätt bäst (se "Varianter" nedan). En tröskel på
   3 min plus en poll (245 s), som skulle vara fysikaliskt ren, förlorar 263.
3. Lägg oavsett val ett regressionstest "kö som börjar under tystnaden", så att beteendet
   blir ett medvetet val (proben A ovan är en färdig mall).

### 2. MEDEL — Ny fantomvarning när båten vänder under tystnaden (värld 1089)

LINNEA 265411070 (F-KÖ, plan `uturn`) hade sin sista norrgående rad 07:17:30,342, i 3,1 kn och
746 m före Strid. Nästa rad kom 07:20:51,733 och gick söderut, alltså efter vändningen.
- c14938f: vändningsfixet kom före spärrens slut (07:22:08), och armen avväpnades utan
  Strid-varning.
- 9fe94c6: `Stridsbergsbron#15` gick 07:20:22,763 med LINNEA som ledare (båda riktningarna,
  VEGA med, eta 7). Det var 29 s före vändningsfixet, och LINNEA korsar aldrig Strid
  (cover.py: `ÄNDRAT ANTAL FANTOMER … (1089, 0, 1, … '265411070', 'Stridsbergsbron#15')`).
- ORION delade i basen varning med VEGA (#15 07:20:49) men får nu en egen (#17 07:20:49):
  två notiser på 27 s i stället för en.
- DESIGN §7 beskriver världen bara som "en blir ledare för en gemensam varning".

**Förslag:** samma rotorsak som anm. 1. Redovisa fallet som kostnad i M6-underlaget och
täck det med samma beslut.

### 3. MEDEL — Kostnaden saknas i underlaget; flera påståenden stämmer inte

- **RESULTAT:** "Ingen ägarfråga behövs".
  - Triagen ställde M6 som ägarbeslut.
  - Alternativ (b) hade kostnaden "fler [varningar] kommer innan båten stannar vid
    Järnvägsbron". TYST-GOLV har samma slags kostnad, bara mindre (anm. 1).
- **DESIGN §8 (produktprincipen):** "en båts egen varning kan bara komma tidigare". Det
  stämmer, men tidigare är inte alltid rättare: värld 29 och 1767.
- **ARCHITECTURE, konstantkommentaren och docblocket för `_silentHoldLimitMs`:** "en
  bekräftad kö … berörs inte". Det gäller bara en kö som var bekräftad i det sista fixet. En
  kö som börjar under tystnaden berörs, och det är spärrens huvudfall.
- **ARCHITECTURE:** "nästan alla tidigare och med längre ledtid". Värld 29, 1767 och 1089
  nämns inte.
- **DESIGN §4 och §7:** de 89 världarna klassas efter ledtidsklass, utan kontroll av stopp
  eller vändning efter varningen.

**Förslag:** skriv in kostnaden och de fyra världarna i DESIGN §4, §7 och §8, RESULTAT,
ARCHITECTURE och kommentaren vid konstanterna. Ändra "en bekräftad kö" till "en kö som var
bekräftad i senaste fixet".

### 4. LÅG — Talen är delvis motiverade av facit, inte av fältet

- **4 kn** är kopplat till ETA-kedjans `BRISK_CANAL_SPEED_KNOTS`, och det är bra. Men valet
  mot 5 och 6 kn motiveras med att de flyttar låsta rader.
- Min fältmätning i banken: norrut mellan Järnvägsbron och Strid är farten median 5,1 kn
  (p75 5,7). 150–500 m före Järnvägsbron är den median 2,3 kn (p75 3,5).
- Snittfarten för kryp fram till bron och fart efter blir då 3,3 kn i median och 4,5 kn vid
  p75. 4 kn ligger alltså ungefär vid p60–p70: försvarbart, men inget värstafall.
- **2 × längsta:** gränsen överskrids i 6,8 % av de rörliga fixen i spärrzonen (anm. 1), så
  ordet "onormal" är för starkt.
- Proben C2 visar samma sak för aisstream. Efter en skur på 20–40 s följer ett glapp på
  325 s, alltså aisstreams p90 i rörelse. Varningen går då 139 s tidigare (atS 440 → 301) för
  en båt som bara går jämnt i 2,5 kn. Glesa men normala fix ger alltså tystnad enligt
  regeln, så fort de fyra senaste råkar vara korta.

**Förslag:** skriv fältmotiveringen vid konstanterna och ta bort facitargumentet som skäl.

### 5. LÅG — `originalDueMs` efter `restartArrival`

Dokumentationen säger att armens första fix "och därmed `originalDueMs`" alltid räknas som
förut. `restartArrival` nollställer `originalDueMs` men inte kadensen. Nästa fix sätter
därför `originalDueMs` med en spärr som tystnadsgolvet kan ha kortat. Det påverkar bara
mätinstrumentet, ingen beslutsväg.

**Förslag:** justera formuleringen.

### 6. LÅG — Samordning med A vid integrationen

A:s ARCHITECTURE-text (ab9c57c) slutar med "Spärrens avvägning är ägarfrågan M6". Den ska
samordnas med D:s nya punkt och med beslutet i anm. 1.

## Det som höll (kontrollerat)

- **Rotorsaken.**
  - `hunt.js --repro V/tA/cards/F02-w263-Strid` ger på c14938f: `KVAR … varning
    Stridsbergsbron#4 15:07:00 (fired) bara 44 s före sann korsning 15:07:45`. På 9fe94c6 ger
    den `BORTA`.
  - Den verbosa loggen (`R/w263-bwt.verbose.log`) visar `OPENING_DEADLINE … BRISEN d=459 m,
    eta=3 min` 15:07:00,824. Fixet 15:02:56 plus 459 m / 2,1 kn − 180 s ger 15:07:00,8.
    De sju sista mottagningsintervallen före tystnaden var 65,0–69,4 s, och glappet var
    272,0 s.
  - Kortet i V/D/cards är bytelikt med V/tA/cards. Fixturens sha256 är lika med kortets
    radhash ac679ea4….
- **Koden.**
  - Kadensen mäts i mottagningstid (`now`), vilket stämmer med att tystnaden gäller när appen
    hör båten.
  - AISHub-klienten dedupar (mmsi, fixTs). Fusionen släpper bara ett AISHub-fix som är
    strikt nyare (F6) och tar bort korskälledubbletter på innehåll (F2). En AISHub-
    omleverans når alltså aldrig `_refreshArm`.
  - Prober (`R/probe/probe.js`), samma utfall som basen i alla tre:
    - en dubblett med samma fixtid 1 s efter varje fix (D = D0);
    - en sista rad som är 200 s fördröjd (E);
    - en båt som går från stilla till rörelse (F).
  - En aisstreamskur på 8–12 s följd av ett glapp på 120 s ändrade inget, eftersom
    golvrestiden dominerade.
  - Utfallet är kontinuerligt vid 4 kn:

    | Fart | c14938f | 9fe94c6 |
    |---|---|---|
    | 3,9 kn | 533 s | 522 s |
    | 3,99 kn | 523 s | 522 s |
    | 4,0 kn | 522 s | 522 s |
    | 4,1 kn | 511 s | 511 s |

  - Tystnadsgränsen ligger alltid efter `now`, så `_holdInEffect` och F09-bokföringen kan
    inte se en spärr som slutar före fixet.
  - Ingen död kod. Armfälten finns bara i `_arm`, och ingen annan kod räknar upp armfält.
- **Livscykeln.**
  - Armfälten skapas per arm, och armen raderas vid avväpning. BOS sparar inget över en
    omstart, så kadensen börjar om: två intervall krävs innan regeln gäller.
  - `restartArrival` behåller kadensen, och det är konservativt.
  - Fassvepet var grönt med och utan `REPLAY_MONITORING` på värld 263, 29, 1767 och 1089
    (rwt och bwt; `R/fas/status`), och batteriets fassvep likaså.
- **Regressionstesten.**
  - Mot c14938f, med testfilen och fixturen inkopierade, är 3 fall röda och 4 gröna:
    `Expected: 604 Received: 702`, och 2 × `Expected: >= 60000 Received: 44414.88`.
  - På HEAD är alla 7 gröna (batteriets jest).
  - Fall 1 prövar mekanismen exakt (604 = 466 + 2 × 69). Smalhetsfallen jämför mot
    golvet 0 i samma kod; på c14938f är de gröna av sig själva.
- **Bitlikheten.**
  - Hela resultat-JSON:en för alla 24 korpusar, med och utan monitoring, är identisk mellan
    c14938f och 9fe94c6 utom `leakDiagnostics.heapUsedMB` (48 jämförelser, 0 skillnader,
    `R/dump/`).
  - `replay:openings`-loggen är bytelik: md5 171d83c8… för båda.
  - `replay:synthetic` är lik utom tidsangivelser (93 rader).
  - Inget låst facit flyttas, så U13 kräver inget belägg.
- **De 89 världarna.**
  - Min omkörning återger familjens data exakt: 89 av 89 ändrade, och 0 av 60 slumpvalda
    oförändrade ändras. Täckningen ändras bara i de 89.
  - Per båt och korsning: 99 fick längre ledtid utan väntan efter varningen, och ingen fick
    kortare ledtid.
  - Rättare, till exempel:
    - 263: 44 → 141 s; 213: 96 → 319 s; 730: 84 → 216 s;
    - 959 och 1609: en varning i stället för två, och 97 → 247 s respektive 109 → 230 s;
    - 15, 245 och 1987: båten absorberas fortfarande i ledarens varning, men får dessutom en
      egen varning 330–371 s före sin korsning, 9–10 min efter ledarens. I basen var hon
      bara medlem i ledarens varning, 707–771 s före. Det räknas som likvärdigt eller
      rättare enligt C-IV väg b. Det ger dock en notis till, och inom U2:s fönster en andra
      varning för gruppen (T4 +1 i quick).
  - Likvärdiga: kösituationer där båda varningarna kom för tidigt (85, 276, 690, 954, 1038,
    1045, 1290 och 1450) och små förskjutningar.
  - Sämre: 29, 1767, 1089 och 1902.
  - Senare varning: ingen båt täcks för första gången senare än i basen. Senare tillkommer:
    - följarens RECOVER i 1902, 557 s efter hennes korsning (U17, DESIGN);
    - de egna andravarningarna i 15, 245 och 1987.
- **B (BAKKANT).**
  - 9fe94c6 cherry-pickas på B:s 0b0a35d (650a0c7, 594a146 och M7) utan konflikt.
  - B:s nya kod läser inga spärr- eller kadensfält, och D läser inte `physicsArrivalMs`.
  - På B+D:
    - jest för båda sviterna är grön (26/26);
    - `replay:all` med och utan monitoring ger 0;
    - `openings` och `synthetic` är lika med B ensam (diff tom);
    - 263 är BORTA.
  - I de 89 världarna (`R/wr/b.jsonl` mot `R/wr/bd.jsonl`) ger D ovanpå B exakt samma
    vinst- och kostnadslistor som D ovanpå basen.
    - I 88 världar ändrar B ingenting, och B+D är lika med D.
    - I värld 1038 ändrar B varning #6, och D:s två flyttningar är desamma.
  - Ingen semantisk krock.
- **A (SAMMA-TICK).**
  - Cherry-pick på ab9c57c utan konflikt. På A+D är D:s svit grön (7/7), och 263 är BORTA.
  - I värld 169 är A+D lika med A: returvarningen kommer 09:52:13,8, 123 s före korsningen.
    D ändrar inget där, eftersom kadensen hade glapp på 140 s.
  - Med A gäller spärren, och därmed tystnadsgolvet, även på returresor. Kör därför
    standardprofilen på A+B+D vid integrationen, som familjen själv föreslår.

## Varianter som underlag för anm. 1 (mätta på de 89 världarna)

Varianterna mättes i egna worktrees:
- `V/D/kwt`: `EARLIER_BRIDGE_SILENCE_FACTOR: 3`;
- `V/D/swt`: tystnadsgränsen är minst 200 s, alltså `Math.max(200000, 2 × längsta)`.

Kommandon: `node R/tools/wrun.js kwt|swt …` och `python3 R/tools/cover.py R/wr/bas.jsonl
R/wr/{head,k3,s200}.jsonl R/changed89.json`.

| Variant | 263 ledtid | Världar ändrade | Längre ledtid utan väntan | För tidig före kö som basen väntade ut | Fantom (1089) | RECOVER efter korsning (1902) |
|---|---|---|---|---|---|---|
| c14938f | 44 s | – | – | – | – | – |
| TYST-GOLV (9fe94c6) | 141 s | 89 | 99 | 29, 1767 (och 954 och 1038 tidigare) | ja | ja |
| faktor 3 | 72 s | 46 | 53 | 29 | nej | ja |
| tystnad ≥ 200 s | 80 s | 69 | 73 | 29 (och 954 och 1038) | ja | ja |

Ingen variant skiljer 263 från värld 29. Glappen är 272 respektive 269 s, och 263 accelererade
medan 29 bromsade in i kön. Valet är en avvägning mellan att bli sen och att varna för
tidigt, och det hör till M6:s ägarfråga. Faktorn 3 behåller 263 över C-IV:s golv (72 s) och
tar bort värld 1767 och 1089 ur kostnaden, men halverar vinsten. K = 3 och tystnad ≥ 200 s
håller 263 BORTA (`hunt.js --repro` i kwt och swt).

## Batteriet och motorn (9fe94c6, `bash S/port/battery.sh V/D/rwt R/batt`)

Alla 13 steg gav slutkod 0 (`R/batt/status`):

| Steg | Tid | Utfall |
|---|---|---|
| jest | 443 s | 370 sviter, 5 271 test, 2 överhoppade |
| lint | 74 s | |
| replay-all | 55 s | |
| replay-all-mon | 57 s | |
| synth | 31 s | |
| openings | 59 s | |
| soak | 8 s | |
| soak-mon | 10 s | |
| phase | 374 s | 24 korpusar GRÖNT |
| phase-mon | 538 s | |
| hunt-selftest | 342 s | GRÖNT |
| hunt-quick | 517 s | |
| porcelain | | `?? node_modules` |

**Quick mot V/bas/quick** (`python3 R/tools/qcmp.py`):
- Klustren är 25 i båda, och utslagen går från 58 till 57. Kandidatklustren är 4 i båda.
- Enda utslagsskillnaden är att 263 försvinner ur `KANDIDAT|-|T2|LEDTID<Ns|synt` (2 → 1).
- Inga nya utslag eller kort.

Räknarna som ändras, och varför:

| Räknare | Bas | HEAD | Förklaring |
|---|---|---|---|
| T2 tunn R0 | 82 | 81 | Värld 213: 96 → 319 s. |
| T3 varningar R1 | 1 247 | 1 248 | Värld 15 och 245 ger egen varning i stället för konvojtäckning (+2). Värld 263 slår ihop två varningar (−1). |
| T4 grupper med fler än en varning R1 | 226 | 227 | Samma tre världar (min omräkning: 15 +1, 245 +1, 263 −1). Den egna varningen kommer efter gruppens första korsning, och inom U2:s 10-minutersfönster blir den en andra varning för gruppen. |
| T3 bekräftade | 1 053 | 1 055 | Följer samma varningsändringar. |
| T3 inferredTid | 49 | 48 | Följer samma varningsändringar. |
| T9 prövade | 5 319 | 5 320 | Följer samma varningsändringar. |
| T9 ingenDomStilla | 39 | 37 | Följer samma varningsändringar. |
| Krympningens prov | 76 | 89 | Motorns arbete, inget utfall. |

**Facit (U13):** ingen låst rad flyttas. Hela resultat-JSON:en är identisk mellan c14938f och
9fe94c6 (se "Bitlikheten"). Inget rådatabelägg behövs.
