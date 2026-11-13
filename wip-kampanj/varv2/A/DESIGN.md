# DESIGN — familj A SAMMA-TICK (varv 2, 2026-11-09, revision 1)

Designer: familj A. Bas: c14938f. Worktree `V/A/wt`, med commits 91641f9, ab9c57c och
5edfe20 (revisionen efter granskningen i `V/A/GRANSKNING.md`). Radhänvisningar gäller
worktree om inget annat sägs; "c14938f:N" avser basen.
V = `/tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad/varv2`.

## 1. Rotorsaken, bekräftad

Båda mekanismerna har samma följd: vändningen var bekräftad på två positioner (U18), men
målbron, och därmed öppningsarmen, kom först vid NÄSTA fix.

**M1 NYRESA-SAMMA-TICK** (936, 1208 ×2, 1316, 1918). Ur `V/tA/logs/w936.log` (c14938f),
XENIA, 06:58:53:
- i `updateVessel` går ACCELERATED-grenen igenom grinden, men `_calculateTargetBridge`
  ger `Söderut, passerat Klaffbron → lämnar kanalen`. FIX Z läste nämligen den avslutade
  resans `_finalTargetDirection` och `passedBridges`;
- därefter `[NEW_JOURNEY] … CONFIRMED` i `app.js _onVesselUpdated`. Resetten lämnar
  tilldelningen åt nästa fix, så `_observeBridgeOpening` ser ingen målbro;
- 07:00:01 kommer `TARGET_CHANGE … ACCELERATED` vid 154 m och varning #9, 46 s före
  korsningen.

**M2 RECROSS-TOMT-MÅL** (1274, 1317). Ur `V/tA/logs/w1274.log`, 09:14:21:
- `RE_CROSS_EVIDENCED Järnvägsbron` och `TARGET_RECALC … clearing target`, inne i
  målbrogrenen (c14938f:719);
- ACCELERATED-grenen ligger i samma else-if-kedja (c14938f:761) och körs inte;
- nästa fix (52 m) ger varningen 23 s före korsningen. I 1317 kom ingen varning alls.

**Minsta repro:** de syntetiska scenarierna för 936, 1208 och 1317 (§3), alla röda på
c14938f-koden.

## 2. Rättningen på kodnivå

**`lib/services/VesselDataService.js`**
- **ACCELERATED-tilldelningen** är utbruten ordagrant till `_selectAcceleratedTarget` (val,
  brogiltighet, återinträdesbevis) och `_applyAcceleratedTarget` (TARGET_CHANGE,
  riktning med C4b, ruttlås, reseankare). ACCELERATED-grenen använder dem. C4b:s villkor
  bor i `_routeLockVerdict` ('none', 'keep' eller 'override'), och `FIX_D_MIN_SOG` har
  lyfts till modulnivå med oförändrat värde.
- **`assignTargetAfterReversal`** är den gemensamma metoden för M1 och M2:
  - först `_shouldAssignTargetBridge(…, true)` och valet med `reversalConfirmed: true`.
    Det är samma grindar som ACCELERATED-grenen har när Fix D bekräftar en vändning i
    ticken;
  - sedan **riktningskontrollen**, som är ny i revisionen: motsäger riktningen som skulle
    låsas den nyss bekräftade vändningen vid ≥ 2 kn (`_routeLockVerdict` 'override'),
    avgör nästa fix, som förut;
  - sedan **under-bro-vakten** (≤ 70 m) och därefter tillämpningen.
- **M2-kroken** ligger efter mellanbroblocken i `updateVessel`. Den körs när kedjan
  startade med målbro och båten saknar målbro efteråt, och `_reversalSeq` (räknas upp i
  `_confirmDirectionReversal`) visar att en vändning bekräftades inne i kedjan.
- **B2:** RE_CROSS_EVIDENCED skickar segmentets start som `journeyStartAt`, och
  reseankaret sätts där. Undantaget i revisionen: motsäger kursen i ≥ 2 kn återkorsningen
  (samma predikat), sätts ankaret i nuet som förut.

**`app.js`**
- STEG 1:s bokföring är utbruten ordagrant till `_noteTargetBridgeChange`.
- NEW_JOURNEY-resetten slutar med `assignTargetAfterReversal?.(…, 'new-journey')`, och vid
  tilldelning `_noteTargetBridgeChange`. `_observeBridgeOpening` längre ned i samma
  hanterare ser målbron.

## 3. Regressionstest

**Syntetiska scenarier** (74 → 79) och den nya förväntan `openingLeadS`: ledtid mot den
sanna korsningen ur generatorns `truthPath`. Inga slumptal dras, och de 74 gamla
scenarierna genereras byte för byte lika.

| Scenario | c14938f | wt | Rött i variant |
|---|---|---|---|
| `retur-efter-målbroslut-gles-ais-Klaffbron (M1, värld 936)` | rött (35 s) | grönt | – |
| `retur-efter-målbroslut-tyst-genom-tre-broar (M1, värld 1208)` | rött (ingen varning) | grönt | – |
| `återkorsning-på-linjen-gles-ais-Järnvägsbron (M2, värld 1317)` | rött (ingen varning) | grönt | utan B2 (notisen vid Järnvägsbron) |
| `gps-utliggare-74m-bakom-…` (seed 9715, H1) | grönt | grönt | utan riktningskontrollen |
| `gps-utliggare-inom-under-bro-bandet-…` (seed 9713) | grönt | grönt | utan både kontrollen och vakten |
| U14-brusscenariot (vaktens M1-test) | grönt | grönt | utan vakten |

- De två utliggarscenarierna dömer med `maxOpeningsPerBridge` och den nya
  `maxPassagesPerBridge`.
- Båda tål en DEFAULT-FLASH mellan två Stridsbergsbrontexter, som kommer likadant på
  c14938f: vändningen på utliggaren lämnar båten mållös till nästa fix. Att den tros på
  utliggaren är RE_CROSS:s GPS-grinds sak, inte familjens.
- Vakten ensam klarar 9713, och kontrollen ensam klarar det också. För M2 är vakten alltså
  ett andra lager; för M1 är den det enda skyddet.

**Enhetstest** (`tests/varv2-a-maltilldelning-samma-tick.test.js`, 11 test, 10 röda på
c14938f). Testen prövar:
- metoden och grindarna;
- riktningskontrollen med en positiv kontroll;
- vakten vid 40 och 85 m;
- M2 via `updateVessel`, med B2 och B2-undantaget;
- M1 via `_onVesselUpdated`. Testet fångar nu `vessel.targetBridge` i det ögonblick
  `_observeBridgeOpening` anropas (L5): `['Klaffbron']` på wt, `[null]` på c14938f.

Två test spionerar på implementationen (grindarna, och att ACCELERATED-grenen använder
de utbrutna metoderna). De prövar inte beteende, och det är godtaget i granskningen.

## 4. Övervägda alternativ

### 4.1 Grindarna
Skissen gav `_calculateTargetBridge` den bekräftade riktningen som "positionsbevisad".
Det kopplar bort det strikta kursbandet och Anomali 16, och skissen låste dessutom utan
C4b. Det är en breddning, inte bara en ny tidpunkt. Valt: ACCELERATED-grenens egen
kedja, delad.

### 4.2 Riktningskontrollen och under-bro-vakten
- **H1 (granskningen).** En enstaka utliggare 70–140 m bakom linjen strax efter en äkta
  passage:
  - RE_CROSS vände båten;
  - kursen (≥ 2 kn) valde bron hon nyss passerat;
  - C4b låste om.

  Granskarens prov P3 (504 banor) gav 10 extra varningar, 8 med fantompassage. c14938f
  gav 0. Min första formulering, att vakten "tar båda mekanismerna", var fel.
- **Riktningskontrollen** är granskarens provade förslag, byggt med `_routeLockVerdict`
  så att C4b:s villkor finns på ett ställe. Kurs och positionsbevis är oense, och då
  räcker inte ett fix. För M1 kan kontrollen inte slå till, eftersom NEW_JOURNEY låser
  ur samma kurs.
- **Under-bro-vakten** (70 m, `UNDER_BRIDGE_CLEAR_DISTANCE`) tar M1-fallet i
  U14-brusscenariot: ett fix 16 m från Klaffbron, söder om bron i latitud men 7,9 m norr
  om linjen längs kanalaxeln. Mitt svep (504 banor) gav utan vakten 2 extra varningar och
  5 fantompassager. 50 m gav samma utfall. Entydig sida (`beforeBridge`) skyddar bara
  inom ±10 m.
- **Vaktens kostnad** (L1, rättad). Inom 70 m behålls c14938f:s beteende, alltså vid gles
  AIS ofta ingen varning. I granskarens prov P1 (576 returer) hade en variant utan vakt
  varnat för 138 korsningar som förblir ovarnade: 115 med under 30 s, 22 med 30–60 s och
  1 med 62 s. HEAD är aldrig sämre än c14938f; 85 korsningar blir bättre.

### 4.3 B2 och undantaget
- Utan B2 försvinner returnotisen vid Järnvägsbron i 1317. Ankaret hamnar norr om bron,
  och `INFERRED_PASSAGE_SKIP` följer.
- Origin-vakterna (RC9, S-F6, triggerpunktsvakten och den monotona förlängningen) dömer
  annorlunda bara för broar mellan segmentets start och båten.
- **Undantaget**, nytt i revisionen:
  - med riktningskontrollen men villkorslöst B2 förlorade 2 av 504 banor i
    Järnvägsbrosvepet en returnotis (`Js-F4-…-retur-s4/s5`);
  - ett brusfix på linjen gav en falsk RE_CROSS, och B2 lade ankaret på brusfixets sida
    (norr om bron);
  - kontrollen sköt upp tilldelningen. Nästa fix tilldelade norrut, och det monotona
    ankaret kunde inte flytta förbi bron;
  - på c14938f låg ankaret i nuet, 1,6 m söder om bron.

  B2 gäller därför bara när kursen inte motsäger återkorsningen. Efter det är
  Järnvägsbrosvepet identiskt med c14938f, och 1317 behöver fortfarande B2.
- Den smala varianten (bara obokad återkorsning) mättes lika i 1317 och banken. Den
  lämnar dock fel ankare i flerbrosegment.

### 4.4 Krokens plats och omfång
- Kroken ligger efter mellanbroblocken, så att segmentet prövas med båten mållös som på
  c14938f. Den gäller bara målbrogrenen, eftersom ACCELERATED-grenen redan väljer efter
  N2 i samma tick.
- **Systervägar i app-lagret (L4), kvar och motiverade.** Två vägar bekräftar en
  vändning efter `updateVessel` och väntar fortfarande på nästa fix för målbron:
  - STEG 5:s GPS-grind (`registerConfirmedIntermediatePassage` i `_analyzeVesselPosition`);
  - skipped-bridges-failsafen (`applyInferredPassage`).

  Skälen till att lämna dem:
  - båda följer på en GPS-osäkerhet eller ett glapp, där ett fix till är försiktigt;
  - failsafen körs efter `_observeBridgeOpening`, så en målbro där hade ändå beväpnats
    först vid nästa fix;
  - i banken (24 korpusar, 482 h, `V/A/res/gate`) gav vägarna 5 grindbekräftade passager
    och ingen vändning.

## 5. Samspel med andra familjer

- **C:** ny-båtsgrenen är inte rörd. `git merge-tree` (granskningen) ger en textuell krock
  i `scenarioGenerator.js` (C:s `leg.cogDeg` och A:s `truthPath` i samma benloop) och i
  scenarioantalet i VALIDATION.md. De är förenliga.
- **D, spärren vid en tidigare bro (M6):**
  - spärren gäller nu från fixet efter vändningen, eftersom köbevisbokföringen kräver
    målbro;
  - i quick-värld 169 kommer returens Stridsbergsbronvarning 123 s före korsningen i
    stället för 824 s, som för annan trafik söderifrån;
  - ändrar D spärren ska världen mätas om.
- **B:** ingen kodöverlapp. Merge utan konflikt.
- **E och F:** `beslutsregister.json` pekar på VDS:385–491 (Fix D), som nu ligger på
  :398–504. F krockar textuellt i `runSyntheticScenarios.js` och VALIDATION.md.

## 6. Besluten

- **U13:** inget facit flyttas (FACIT.md).
- **U17, C-IV och D1:** täckning, konvojregler och kajregeln är orörda.
- **U18:** orörd. Metoden anropas bara efter en bekräftad vändning, och riktningskontrollen
  gör den bara strängare.
- **U22 (L2, rättad):** ETA-koden är orörd, men ETA-historiken börjar ett fix tidigare.
  Utjämningen ger då en längre ETA i första notisen efter vändningen:

  | Värld | Notis | c14938f → wt | Avstånd till bron | Korsningen |
  |---|---|---|---|---|
  | 936 | Klaffbron | "om 1 minut" → "om 2 minuter" | 154 m | 46 s senare |
  | 1918 | Stridsbergsbron | "strax" → "om 1 minut" | 97 m | 9 s senare |
  | 169 | Klaffbron | "om 2 minuter" → "om 3 minuter" | 170 m | 43 s senare |

  Annan trafik med målbro i två fix får samma utjämning. Felet hör till de uppskjutna
  ETA-korten (F01, F03, F04, F09 och F10).
- **Notiserna (L3, rättad):**
  - 1208: Klaffbronotisen är oförändrad (källa current → target). Stridsbergsbronotisen
    blir "passerade … under AIS-tystnad" (target) i stället för "har precis passerat"
    (current). Det är sannare efter 13,5 min tystnad, och antalet per bro är oförändrat;
  - 1316 och 1317: identiska notiser. 1316:s passagenotis har kvar källan current.
    Triagens "samma notistext, källa target" stämde alltså inte.

## 7. Dokument

- `docs/ARCHITECTURE.md`, U-svängspunkten: riktningskontrollen, vakten med sin kostnad,
  B2 med undantaget, systervägarna, ETA-texten och spärren.
- `docs/VALIDATION.md`: 79 scenarier, ledtid mot sann korsning och utliggarscenarierna.
- Kodkommentarerna.

## 8. Mätningar (revisionen, 5edfe20)

**Batteriet** (`V/A/batt-rev1`):
- alla 13 steg har slutkod 0: jest (370 sviter, 5275 test), lint, replay-all,
  replay-all-mon, synth, openings, soak, soak-mon, phase, phase-mon, hunt-selftest
  (GRÖNT) och hunt-quick;
- porcelain visar bara `node_modules`;
- replay-all, replay-all-mon och openings är bitlika mot c14938f;
- synth: de 74 gamla raderna är identiska, och 5 nya har tillkommit.

**`hunt.js --repro`** (`V/A/repro/rev2.tsv`): exakt de nio familjekorten ändras, alla till
BORTA (936, 1208 ×2, F05/r2, 1316, 1918, 1274, F02/r2 och 1317). De 17 övriga är
oförändrade.

**Quick mot `V/bas/quick`:**
- alla 25 kluster har identiska fynd, och rad- och fyndfingeravtrycken är lika;
- räknarna T2 "tunn" går 130 → 131 och T9 "ingenDomVändning" 21 → 23, bara i M1-världarna
  169 och 269 (per värld i `V/A/res/qw/rev.json`), som i första omgången.

**Ledtid mot sann korsning** (familjens returer, oförändrade av revisionen):

| Värld | 936 | 1918 | 1274 | 1317 | 1316 | 1208 |
|---|---|---|---|---|---|---|
| c14938f | 46 s | 10 s | 23 s | ingen | ingen | ingen / ingen |
| wt | 113 s | 77 s | 389 s | 101 s | 196 s | 74 s / 632 s |

Övriga korsningar är oförändrade, utom 1918:s följande Klaffbronpassage (378 → 383 s).
Notiserna är identiska i 1274, 1316 och 1317.

**Svepen** (`V/A/res/sweep-rev`, `sweepJ-rev2`):
- U14-familjerna vid Klaffbron och Stridsbergsbron (504 banor) och vid Järnvägsbron (504)
  är signaturlika med c14938f: varningar, passager, notiser och invariantutslag;
- 0 T2-regressioner mot sann korsning;
- första omgångens DEFAULT-FLASH-förbättringar i brusbanorna föll bort, eftersom
  riktningskontrollen skjuter upp de falska vändningarna, som på c14938f;
- de två förlorade returnotiserna (före B2-undantaget) är borta.

**Mutationsprov** på scenarierna (`V/A/exp/rev-*`), se tabellen i §3.
