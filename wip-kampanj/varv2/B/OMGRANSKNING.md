# OMGRANSKNING — familj B (BAKKANT), revision 5d4b2c3 (2026-11-09)

Granskad commit: 5d4b2c3 ovanpå 0b0a35d. Den är utcheckad i `V/B/rwt`, och batteriet där ger porcelain med bara
node_modules. Probträden ligger under V/B:
- `pwt` = 5d4b2c3;
- `fwt` = 0b0a35d för proberna, därefter 5d4b2c3 för mutationerna;
- `bwt` = c14938f.

Tempfiler ligger i `V/B/rtmp`. Probfilen är `rtmp/probes/zz-granskning-b.test.js`, med tre versioner sida vid sida i
`rtmp/probes/sammanfattning-rev1.txt`. Probernas tider anges i sekunder efter T0; ledarens fönster slutar vid 891,6 s
(A-proberna) och 840 s (C- och D-proberna).

## Dom: GODKÄND

De tre medelpunkterna är rättade och låsta av test. Batteriet, banken och motorn är rena. Kvar finns tre låga
anmärkningar (se nedan); ingen av dem är en regression mot c14938f.

## 1. De tre medelpunkterna är rättade

| Prob | c14938f | 0b0a35d | 5d4b2c3 |
|---|---|---|---|
| A1, A1b (fix bortom bron utan riktning) | 1, 1 | 2, 2 | 1, 1 |
| A4, A4c (fartfladder utan appens ETA) | 1, 1 | 2, 2 | 1, 1 |
| C4, C4b, C4c (kölämnare) | 1, 1, 1 | 2, 2, 2 | 1, 1, 1 |

- **Koden:**
  - `_bridgeBehindArm` har samma uttryck som passagedomen. Den ger grinden 'bakom' först i `_ownDeadlineGate` och
    i bakkanten efter passagen.
  - 'en-prognos' gäller när `etaMinutes === null`.
  - `_crawlArrivalMs` läser fysiken bara när `crawlFixes >= 2` och `waitingAtBridge` saknas. `crawlFixes` nollas
    av varje fix som inte är ett krypfix.
- **Testet** `tests/b-bakkant-varv2.test.js`: 14/24 rött på c14938f, 6/24 på 0b0a35d (exakt de sex nya) och 24/24
  grönt på 5d4b2c3.
- **Mutationer** (`rtmp/scripts/mutate2.py`): sju mutationer av de nya grindarna fälls alla:
  - 'bakom' borttagen i U24, i bakkanten och i passagedomen;
  - 'en-prognos' borttagen;
  - ett krypfix räcker;
  - köflaggan ignoreras;
  - räknaren nollas aldrig.
- **Väntade följder av 'en-prognos':** proberna saknar appens ETA, så A2, A3, A3b och A5–A7 får tillbaka utfallen
  från c14938f. U24 verkar nu bara där appen har en egen prognos. Spionen visade förut att alla U24-släpp i quick,
  i banken och i familjens världar hade det.

## 2. Kravet på två krypfix (adversariellt)

- **Verkliga krypare:**
  - 790: varningen kommer 13:31:18,846, 410 s före korsningen 13:38:09. På 0b0a35d kom den 13:28:30 och på
    c14938f 13:37:22.
  - F08: varningen kommer 10:12:52,579. På 0b0a35d kom den 10:11:45 och på c14938f 10:19:29, efter korsningen.
  - Fördröjningen är ett fixintervall (67–168 s), och ledtiden är fortfarande ≥ 376 s.
- **Gles kadens (D3, klass B, 180 s):** båten kryper i 1 kn från 100 m vid 700 s, och nästa fix kommer 880 s.
  - 5d4b2c3 varnar vid täckningsslutet 840 s, 46 s före korsningen, precis som c14938f.
  - 0b0a35d varnade 700 s.
  - Med tät kadens (D3b) varnar 5d4b2c3 730 s, 0b0a35d 700 s och c14938f 820 s.
  - Varningen kan alltså bli lika sen som på c14938f, men aldrig senare.
- **Pendling runt 0,5 kn (D1, 0,4/0,6 kn):** räknaren växlar mellan 0 och 1, och M5 slår aldrig till. Varningen
  kommer 840 s, 71 s före korsningen, precis som c14938f. 0b0a35d varnade 570 s.
- **Pendling runt 2,5 kn (D2, 2,4/2,6 kn med hållen ETA):** samma mönster. 5d4b2c3 varnar 750 s som c14938f,
  0b0a35d varnade 600 s.
- Inget av fallen ger en extra varning eller en missad öppning mot c14938f.

## 3. Världar, bank och motor

- **hunt --repro** (`rtmp/repro/rev1/`):
  - BORTA: 1094, 1476, 790, 1794, F08 (kort och fynd), 979, F02 och 41;
  - KVAR: 1139, 143 och Q143.
- **Banken** (24 korpusar, med och utan monitoring) mot c14938f: 431/431 öppningsvarningar; notiser, brotext och
  undertryckningar är identiska.
  - Bara JOSEPHINE-raden skiljer: 20260525 Klaffbron#10 10:06:05,877 → 10:01:20,160 (olåst).
  - PILLE-raden är borta.
  - U9-korpusarna (20260713-41h, 20260601-41h, 20260610-19h, 20260707-14h och 20260712-25h) har identiska
    varningslistor. JOY och SEEBAER III har kvar kort #9 08:25:16,678.
- **Batteriet** `bash S/port/battery.sh V/B/rwt V/B/rbatt2`:
  - jest 0 (370 sviter, 5288 test gröna, 2 överhoppade);
  - lint 0;
  - replay:all 0 (båda lägena);
  - synthetic 0, och identisk med c14938f;
  - openings 0, och skiljer mot c14938f bara i JOSEPHINE:s O2-rader;
  - soak 0 (båda lägena);
  - fassvepet 0 (båda lägena);
  - självtestet 0;
  - quick 0;
  - porcelain visar bara node_modules.
- **Quick mot V/bas/quick** (`quickdiff.py`): 58 → 57 utslag och 25 → 26 kluster: −240 (U2-VS-DEADLINE), −41
  (U17-TYST-BÅT-RECOVER) och +143 KANDIDAT `T3 VARNING-PÅ-FRUSET-FIX` (U24:s godtagna kostnad). Identiskt med
  steg 3; ingen ny kandidat utöver 143.

## 4. Registerposten och A3e

- **Kedjan i A3e** (familjens prob, körd själv på c14938f och 5d4b2c3): c14938f ger 2 varningar och 5d4b2c3 ger 3.
  - F1 släpps av U24 vid 557,7 s.
  - F2 släpps ur E också av U24: `gäller inte längre (Klaffbron#1) … bakkant: egen deadline`.
  - F2 absorberas i H (#2) och varnas vid H:s täckningsslut 1535,8 s.
- **Posten döljer ingen regression.** Punkt 1 kräver att L:s dom uppfyller alla U24-villkor, inklusive appens ETA och
  'bakom', och punkt 5 kräver samma fysiska öppning.
- **Men posten täcker inte A3e som den är skriven.** Punkt 3 kräver att B släpps ur E "med domen 'täckningsslut',
  inte genom U24", och A3e:s B släpps genom U24.
- **Oraklet passar inte heller.** Postens orakel `T3 VARNING-PÅ-FRUSET-FIX` utlöses inte för en hörd B.

## Anmärkningar (alla låga)

1. **Registerpostens punkt 3** utesluter A3e:s faktiska kedja (se avsnitt 4).
   - Förslag: tillåt att B släpps ur E antingen vid täckningsslutet eller genom U24, med U24-villkoren för B, följt
     av absorption i H inom en tick.
   - Skriv dessutom att en hörd B inte ger postens orakel. Kostnaden är då dokumenterad men oregistrerad tills
     motorn sett den.
2. **Kravet på två krypfix kostar ett fixintervall.** Vid gles kadens eller fart som pendlar runt 0,5/2,5 kn faller
   M5 tillbaka till c14938f:s sena varning (D1: 71 s, D3: 46 s).
   - Provat alternativ (`rtmp/forslag-krypfix-alt.diff`): godta det första krypfixet om förra fixet låg i
     marschfart (≥ 2,5 kn).
   - Det återställer D2, D3 och D3b till 0b0a35d:s tider, håller C4–C4c som c14938f och lämnar D1 oförändrad.
   - Två av familjens test förutsätter dock tvåfixregeln och måste ändras.
   - Valfritt; ingen regression mot c14938f.
3. **`crawlFixes` räknar tillämpade observationer, inte nya fix.**
   - D4: kölämnarens första rörelsefix levereras två gånger med samma fixTs. Räknaren blir 2, och hon släpps och
     varnas igen. c14938f ger 1 varning, 5d4b2c3 ger 2.
   - Multiplexern släpper igenom allt i aisstream-läget. I de korpusar jag kontrollerade (2 598 rader) fanns inga
     identiska upprepningar.
   - Förslag: räkna bara när fixets tid (`rawAnchorMs`) har gått framåt.
