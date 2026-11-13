# GRANSKNING — familj B (BAKKANT), varv 2 (2026-11-09)

Granskad HEAD: 0b0a35d (`V/B/rwt`, orörd, porcelain bara node_modules). Bas: c14938f (`V/B/bwt`).
Egna arbetsträd under V/B: `pwt` (prober på 0b0a35d), `mwt` (0b0a35d + D 9fe94c6), `pvt` (integ/prov 85151be),
`iwt` (85151be + 0b0a35d), `fwt` (0b0a35d + föreslagna grindar, `rtmp/forslag-grindar.diff`). Tempfiler i `V/B/rtmp`.
Alla tider UTC; probernas tider i sekunder efter T0.

## Dom: ÄNDRINGAR KRÄVS

M4 och M5 är rätt i sak, och M7/U24 gör det ägaren beslutade i de mätta världarna. Men U24-släppet saknar
KRAV (1), och ägarens villkor "båda prognoserna" är tomt för en arm utan appens ETA. M5 litar dessutom på ett
kölämnande fix. Alla tre ger en extra varning mot c14938f i konstruerade men rimliga fall. Rättningarna är små och
mätt neutrala i banken, i quick och i familjens världar (se anm. 1–3).

## Det som håller (mätt själv)

- **Rotorsaken** (`rtmp/repro/run.sh`, `hunt.js --repro`): på c14938f KVAR för 1094, 1476, 790, 1794, F08,
  979, F02-rep och 1139. På 0b0a35d BORTA för alla utom 1139 (KVAR, U24 undantar stilla köare); 143 KVAR (godtagen
  kostnad). Verbosa loggar (`rtmp/vlog/*-full.log`):
  - 1094: bas `[OPENING_RECOVER] QUEST … löpte ut (Stridsbergsbron#1)`, varning #6 11:49:17,026 eta −1, efter
    korsningen 11:48:44; HEAD `bakkant: färsk prognos 11:49:15.719Z ligger efter fönstrets slut 11:48:47.979Z`,
    varning 11:42:05,757 eta 7;
  - 790: bas #11 13:37:22,761 eta −1 d 230; HEAD fysik 13:39:08,776 mot fönstret 13:36:10,510 (appens ETA
    13:32:38,884), varning 13:28:30 eta 4;
  - 979: bas #4 08:56:34,920 eta 1 d 154; HEAD `egen deadline 08:51:55.086Z … prognos 08:57:49.626Z och fysik
    08:57:21.688Z ligger efter fönstrets slut 08:56:34.919Z`, varning 08:51:55,087 eta 6 d 1041.
- **firstPassageAt** skrivs bara i `_recordPassage` (BOS:2737), från `_crossingEstimate ?? _crossingUpperBound`
  (observeVessel), `_crossingUpperBound` (notePassage, passagedomen) eller bokföringstiden. Saknas skattningen gäller
  det gamla villkoret (vakttestet låser det).
- **Regressionstestet** `tests/b-bakkant-varv2.test.js`: 9/19 rött på c14938f, 5/19 på 594a146, 19/19 grönt på
  HEAD. 15 mutationer (`rtmp/scripts/mutate.py`: M4 tillbaka till bokföringen, M5 utan fartgräns eller utan fysik,
  varje U24-grind, väckningen, fönstret) fälls alla. Testet är inte tautologiskt.
- **Batteriet** `bash S/port/battery.sh V/B/rwt V/B/rbatt` (last 40–60): alla 13 steg slutkod 0. Jest gav 370/370
  sviter och 5283 test gröna (2 överhoppade). Porcelain visar bara node_modules.
- **Quick mot V/bas/quick** (`quickdiff.py`): 58 → 57 utslag och 25 → 26 kluster: −240 (U2-VS-DEADLINE), −41
  (U17-TYST-BÅT-RECOVER), +143 KANDIDAT `T3 VARNING-PÅ-FRUSET-FIX` (U24:s godtagna kostnad, kräver E:s post).
  Detta är identiskt med familjens `batt-steg3`.
- **Banken** (`rtmp/scripts/bank.sh` + `bankdiff.py`, 24 korpusar, med och utan monitoring): 431/431
  öppningsvarningar; notiser, brotext och undertryckningar är identiska. Exakt två olåsta rader flyttar: PILLE
  20260804-17h #22 11:33:56,462 → 11:29:38,576 och JOSEPHINE 20260525 Klaffbron#10 10:06:05,877 → 10:01:20,160.
  Rådatan och gt-passages stämmer exakt med FACIT.md (U13 håller). Synthetic är identisk. I openings ändras bara de
  rader FACIT redovisar. Av U9-korpusarna har 20260713-41h (52/52, JOY+SEEBAER III #9 08:25:16,678), 20260601-41h,
  20260610-19h, 20260707-14h och 20260712-25h identiska varningslistor.
- **U22**: `fireDueMs` och eta-tokenen läser inte fysiken. Proben C5 (fix 6 min gammalt) ger fireDue 218,25 s både
  på bas och HEAD, och fysiken är ankrad i fixtiden.
- **Samspelet med D**: cherry-pick av 9fe94c6 på 0b0a35d är konfliktfri (mwt), liksom 0b0a35d på integ/prov
  85151be (iwt).
  - B+D: full jest 371/371 sviter (5290 test); banken B+D = B i båda lägena; hunt --repro ger B:s världar
    oförändrade och 263 BORTA; proberna är identiska.
  - Banken iwt mot pvt: bara JOSEPHINE-raden ändras.
  - Semantiken: D skriver `earlierBridgeUntilMs`, och U24 läser `earliestArrivalMs`, prognoserna och
    `coverUntilMs`. Inget tillstånd delas, och spärren styr fortfarande avfyrningen efter ett U24-släpp.
- **eta-accuracy-rendered under last**: felet går inte att återskapa. 16 parallella fångstkörningar
  (`rtmp/scripts/etacheck.js`, 8 på c14938f och 8 på HEAD, last 50–60) gav alla 282/282 `renderad-ledare` och 0
  övergångar utan rendering. Testfilen körd samtidigt på bas och HEAD: 17/17 vardera. both-21h har identiska
  övergångar och varningar på bas och HEAD. Felet beror alltså inte på B. Varje fångstkörning tog 32–42 s mot
  testets `spawnSync`-gräns på 25 s, så lastkänsligheten sitter i harnessen och fanns redan på c14938f.

## Anmärkningar

### 1. U24-släppet saknar KRAV (1): varning efter passage — **medel**
- **Problemet:** `_ownDeadlineGate` prövar aldrig om bron ligger bakom armens senaste läge. Ett fix bortom bron utan
  riktning bokför ingen passage (`_bridgeIsBehind` är tyst). K-familjen bevakar just det läget vid täckningsslutet
  (domen `passage`, och sonden i `k-konvoj-recover-bakkant-glapp.test.js:585`). U24 släpper i stället båten, och
  hon varnas fast hon redan passerat.
- **Belägg:** `rtmp/probes/zz-granskning-b.test.js`, sammanställt i `rtmp/probes/sammanfattning.txt`:
  - A1: F 400 m bortom bron, kurs okänd → c14938f 1 varning (F avväpnas som passage vid 891 s), HEAD 2 (F varnas
    vid 790 s, efter passagen);
  - A1b: 360 m bortom i 1,9 kn, under kursgrindens 2 kn → 1 mot 2.
- Bakkanten efter passage har samma lucka sedan tidigare.
- **Förslag:** lägg grinden 'bakom' först i `_ownDeadlineGate`, med samma uttryck som passagedomen (BOS:2380–2383),
  och gärna även i bakkanten. Lägg till ett test.
  - Provat i fwt: A1 och A1b som c14938f, familjens test 19/19, 979/F02/41 BORTA, 143/1139 KVAR, banken bitlik
    mot HEAD.

### 2. Ägarens villkor "båda prognoserna" är tomt utan appens ETA — **medel**
- **Problemet:** när `arm.etaMinutes` är null (kedjearm eller ETA saknas) gäller `expectedArrivalMs = ankare +
  d/sog`, alltså exakt `physicsArrivalMs`. Villkor (b) vilar då på en enda prognos, och ett enda fix med en fartdipp
  på 5–12 % släpper en följare i rörelse som korsar inom fönstret. Det blir en andrapåminnelse (U2) utanför den
  kostnad ägaren godtog (köande konvoj).
- **Belägg:**
  - A4: följaren korsar 20 s före fönsterslutet, sog växlar 5,0/4,4 kn → c14938f 1 varning, HEAD 2 (495,6 s);
  - A4c: ledaren passerar 860 s → 1 mot 2;
  - A4b: samma fall med appens ETA → 1 mot 1.
- **Omfattning:** spionen `rtmp/scripts/spyU24.js` över quick (bank, fasvarianter och 300 världar) och familjens
  världar visar att alla U24-släpp hade appens ETA: 22 släpp (JOSEPHINE i banken och dess fasvarianter, världarna
  240, 41 och 143 med krympningsproberna), samt 979 och F02-rep.
- **Förslag:** grinden 'en-prognos' när `arm.etaMinutes === null`.
  - Provat i fwt: inga ändrade utfall i världarna eller i banken.
  - De fyra M7-testen saknar etaMinutes i fixturerna och behöver få det, eftersom de annars mäter fysiken två gånger.

### 3. M5 litar på kölämnarens första rörelsefix — **medel**
- **Problemet:** en absorberad båt som köat nära bron och startar efter ledarens passage rapporterar en momentan
  låg fart. Då ger `max(prognos, fysik)` en ankomst efter fönstret, och hon släpps och varnas igen, fast hon korsar
  inom det.
- **Belägg:**
  - C4: kö 150 m, 0,8 kn vid 560 s → c14938f 1 varning, HEAD 2;
  - C4b: kö 300 m, start 30 s efter passagen → 1 mot 2;
  - C4c: samma med appens bekräftade väntan, där `waitingAtBridge` är satt på fixet → 1 mot 2.
- **Omfattning:** alla M5-släpp i 790, 1794, F08 och PILLE (6 i quick) hade `waitingAtBridge` null.
- **Förslag:** ingen fysik i `_crawlArrivalMs` när `arm.waitingAtBridge` är satt.
  - Provat i fwt: C4c som c14938f; 790, 1794, F08 och 1476 BORTA; familjens test och
    opening-convoy-release-scheduling gröna; banken bitlik.
  - Fall utan bekräftad väntan (C4, C4b) täcks bara av ett krav på två krypfix i följd. Det är omätt.

### 4. Den godtagna kostnaden är bredare än registerpostens predikat — **låg**
- **Problemet:** DESIGN.md §Registerpost, punkt 4, kräver att B är tyst. Mekanismen träffar även en hörd köande båt.
- **Belägg:** A3b. F1 och F2 absorberas och köar bakom ledaren. U24 släpper F1 vid 557,7 s, och F2 absorberas i
  F1:s händelse. F2 sänder var 30:e s, 250 m från bron, och varnas ändå en tredje gång vid händelsens täckningsslut
  1535,4 s. c14938f gav 2 varningar (gemensamt kort F1+F2 vid 891,3 s), HEAD ger 3.
- Omvänt delar c14938f en konvoj som HEAD håller ihop (A3: 3 mot 2).
- **Förslag:** beskriv klassen som "köande konvoj, tyst eller hörd" i underlaget till E och ägaren, eller låt
  predikatet täcka båda.

### 5. Dokumentation — **låg**
- **"Alltid" stämmer inte:** `_coverageVerdict`-docblocket och DESIGN §Domens fält säger att domen före passage
  "alltid" bär `arrivalMs`, `physicsArrivalMs`, `windowEndMs` och `ownDeadlineMs`. Men `_ownDeadlineVerdict`
  returnerar en bar `{kind:'covered'}` när underlaget saknas (ingen händelse, ej avfyrad eller ingen
  referensankomst). Skriv "när underlaget finns".
- **Talet 437:** "437 varningar" är runOpeningGates räkning. replay:all-banken har 431. Ange källan.

### 6. M4 kan ge en andrapåminnelse på ett något pessimistiskt fix — **låg (observation)**
- **Belägg:** B1. Följaren är tyst mellan korsningen och bokföringen, med en prognos 20 s efter fönstret. Hon korsar
  60 s före det och hörs bortom bron. c14938f gav 1 varning, HEAD 2 (465,5 s).
- **Bedömning:** detta följer KRAV (2) och bakkantens envägsdom. Om hon i stället hade varit tyst ända till
  täckningsslutet hade c14938f varnat henne efter passagen (B2). Ingen ändring krävs, men nämn kostnaden i
  docblocket.
