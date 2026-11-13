# GRANSKNING — familj A SAMMA-TICK (varv 2, 2026-11-09)

Förkortningar: S = `/tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad`,
V = S/varv2, A = V/A, R = A/rtmp. Granskat: `ab9c57c` (91641f9 + ab9c57c) i A/rwt mot `c14938f`
i en egen worktree A/bwt. Varianter kördes i ett eget provträd A/pwt (`ab9c57c` + lokala
provcommits 08f5f92 och 3553318 med miljöväxlarna `PROBE_GUARD_M`, `PROBE_NO_B2` och
`PROBE_DIRCHECK`). Alla skript, loggar och resultat ligger i R. A/wt, A/rwt och andra familjers
kataloger är orörda; `git status --porcelain` visar i rwt och bwt bara `?? node_modules`.

## Dom: ÄNDRINGAR KRÄVS

Rättningen gör det den ska i familjens världar, banken är bitlik och U18 är orörd. Men
samma-tick-tilldelningen efter en RE_CROSS-vändning ger en ny falsk öppningsvarning, en
fantompassage och flera minuter "på väg mot <bron hon just passerat> … strax" när en enstaka
GPS-utliggare ligger 70–140 m bakom linjen, strax bortom 70 m-vakten (H1). Det är en regression
mot c14938f och börjar redan vid 74 m, alltså inom det dokumenterade flervägsbandet 20–80 m.
Rättningen är liten och prövad (förslaget i H1).

## Anmärkningar

### H1 (hög) — M2 väljer bron båten just passerat när utliggaren ligger 70–140 m bakom linjen

**Belägg.**
- Prov P3 (`R/probe/defs-p3.js`, 504 banor): båten passerar Klaffbron norrut, Stridsbergsbron
  söderut eller Järnvägsbron norrut i 3–6 kn med 10/30 s kadens. Ett fix k = 1–5 kadenser efter
  den sanna korsningen flyttas X = 30–180 m bakåt längs rutten (fart och kurs orörda). Körning:
  `R/probe/run.sh <träd> R/probe/p3 <ut>` i bwt, rwt och pwt; jämförelsen i `R/probe/e3t.txt`
  och `R/probe/p3-extra.txt`.
  - c14938f: 0 banor med extra varning eller extra målbropassage.
  - HEAD: 10 banor med en extra varning för bron hon nyss passerat (X = 90–140 m, k = 2), 8 av
    dem med en fantompassage.
  - Utan vakt (PROBE_GUARD_M=-1): 67 banor, nu också med X = 30–70 m (det är det vakten tar).
  - Med riktningskontrollen nedan (PROBE_DIRCHECK): 0.
- Logg (`R/logs/p3K90.rwt.log`, p3-K-v4.4-iv10-k2-X90):
  `RE_CROSS_EVIDENCED … Klaffbron korsad IGEN i motsatt riktning (north → south)` →
  `Norrut, söder om Klaffbron → Klaffbron först` →
  `TARGET_CHANGE … "none" → "Klaffbron" | Reason: REVERSAL_SAME_TICK (vändning-i-målbrogrenen) | … Distance to target: 90m` →
  `OPENING_ARM … d=90 m … deadline om -261 s` → `OPENING_RETURN … (U15)` → varning Klaffbron#3
  (fix, 90 m). Nästa, sanna fix: `REVERSE_RECRROSS_GUARD … Ignoring potential bounce`, och
  målbron står kvar till `MOVING_AWAY` 70 s senare. Brotexten 06:06:50–06:11:30:
  "En båt på väg mot Klaffbron, beräknad broöppning strax / ETA okänd / om 3 minuter" för en båt
  som passerade 06:06:36 och går norrut. På c14938f (`p3K90.bwt.log`) avgör nästa fix:
  `"none" → "Stridsbergsbron" | Reason: ACCELERATED`, och texten har bara 20 s "Inga båtar".
- Samma sak med generatorns egen `gpsJump` (prov P4, `R/probe/defs-p4.js`): norrut 4,4 kn,
  10 s, `gpsJump: { atFraction: FRAC_KLAFFBRON + 40 / METRICS.total, offsetM: -100 }`, seed 9715.
  Utliggaren hamnar 74 m från Klaffbron. HEAD: två Klaffbronvarningar (den andra 06:21:20, fix,
  74 m) och "på väg mot Klaffbron" 06:21:20–06:26:00. c14938f: en varning.

**Mekanism.** RE_CROSS bekräftar vändningen söderut ur utliggarens läge och lyfter bron ur
passedBridges. I samma tick följer `_calculateTargetBridge` kursen (norr, ≥ 2 kn slår låset)
från ett läge söder om linjen och väljer bron bakom båten; C4b låser sedan om norrut. Vakten
täcker bara ≤ 70 m. DESIGN §4.2 ("Vakten tar båda mekanismerna, oberoende av vilken
riktningskälla som valde målbron") stämmer alltså inte.

**Förslag.** Låt `assignTargetAfterReversal` avstå, så att nästa fix avgör som förut, när
riktningen tillämpningen skulle använda (`positionDirection || _deriveAssignmentDirection`)
motsäger den nyss bekräftade vändningen (`vessel._routeDirection`) vid sog ≥ `FIX_D_MIN_SOG`.
Kurs och positionsbevis är då oense, och ett fix räcker inte. Provat i pwt (`PROBE_DIRCHECK`,
3553318):
- P3: 0 avvikelser från c14938f i varningar och målbropassager;
- P4: som c14938f;
- de nio familjekorten (936, 1208 ×2, 1316, 1918, 1274, 1317, F02/r2, F05/r2) är fortfarande
  BORTA;
- syntetsviten 77/77 radlik med HEAD;
- P1 (576 M1-returer) identiskt med HEAD i ledtider, antal och notistexter;
- P2c (192 M2-vändningar) identiskt med HEAD: alla 43 förbättringar mot c14938f står kvar.

Kontrollen kan inte slå till för M1, där NEW_JOURNEY sätter låset ur samma kurs.
Lägg till scenariot ovan (seed 9715) med `maxOpeningsPerBridge: { Klaffbron: 1 }`: rött på HEAD,
grönt på c14938f och med kontrollen.

### M1 (medel) — vaktens M2-del saknar test

`PROBE_GUARD_M=-1 node tests/replay-validation/runSyntheticScenarios.js` i pwt
(`R/synthvar/noguard.log`) fäller bara
`vänder-bromsar-väntar-3m-tät-10s-i-1kn-brus-30m-ge-upp (U14-vakt) ÖPPNINGSDUBBLETT: Klaffbron fick 3 varningar (max 2)`.
Det är M1-mekanismen. Brusfixet efter en äkta passage (STRAX-ZOMBIE, som vakten enligt
kommentaren skyddar mot) prövas inte. P4 ger ett färdigt negativtest: samma uppställning som i
H1 men `offsetM: -60`, seed 9713. Utfallet blir Klaffbron w1 tp1 på c14938f och HEAD, men
w2 tp2 utan vakt.

### L1 (låg) — vaktens kostnad är underskattad i dokumentationen

Prov P1 (`R/probe/defs-p1.js`, 576 returer nära bron): D = 70–280 m, 2,4–5 kn, 30–120 s,
skarp eller långsam vändning, brus 5 eller 25 m. Resultat i `R/probe/e1all.txt`.

| Träd | ingen varning | under 60 s | minst 60 s |
|---|---|---|---|
| c14938f | 429 | 99 | 1200 |
| HEAD | 393 | 73 | 1262 |
| utan vakt | 255 | 209 | 1264 |

Mot c14938f är HEAD aldrig sämre: 85 korsningar blir bättre och ingen sämre. Antalet notiser
är oförändrat utom 3 returnotiser som tillkommer (U14). I 12 banor kommer Järnvägsbronotisen
ett fix tidigare och med en annan ETA-text (L2).

Vakten håller däremot kvar 138 korsningar helt utan varning där varianten utan vakt varnar:
115 under 30 s, 22 på 30–60 s och 1 på 62 s. I ytterligare en korsning blir 2 s i stället 62 s
utan vakt. Formuleringen "Vakten kostar ingen förvarning" (ARCHITECTURE, VDS-kommentaren,
DESIGN §4.2) bör ersättas med vad vakten gör: c14938f:s beteende inom 70 m, alltså ofta ingen
varning vid gles AIS.

Två nya syntetiska invariantutslag (SEN MÅLBRO-NOTIS, p1-K-D180-v2.4-iv60-skarp-J25 och
p1-S-D280-v2.4-iv120-långsam-J25) har identiska notiser. Målbropassagen bokförs där ett fix
tidigare, via avståndsreserven.

### L2 (låg) — ETA-texten i notiser ändras (U22) och redovisas inte

ETA-historiken börjar ett fix tidigare, så EMA-utjämningen slår till
(`ETA_SMOOTHING … raw: 1.0min → smooth: 1.8min`, `R/logs/F02-w936-Klaff.rwt.log`).
- 936: "XENIA närmar sig Klaffbron, beräknad ankomst om 1 minut" → "om 2 minuter" (154 m;
  korsningen 46 s senare);
- 1918: "… beräknad ankomst strax" → "om 1 minut" (97 m; korsningen 9 s senare);
- 169: "om 2 minuter" → "om 3 minuter".

Det är samma utjämning som annan trafik får, och ingen ETA-kod är ändrad. Men DESIGN §6 säger
att ETA-texten är orörd. Redovisa ändringen i DESIGN/FACIT och peka på ETA-korten.

### L3 (låg) — notistexten i 1208 ändras, och påståendet om källan stämmer inte för 1316

Underlag: `R/cmpres.py` på de verbosa replayerna.
- 1208: "KAJSA har precis passerat Stridsbergsbron" (current) blir "KAJSA passerade
  Stridsbergsbron under AIS-tystnad" (target, BN2). Den nya texten är sannare, efter 13,5 min
  tystnad, och antalet notiser per bro är oförändrat, så U14 håller.
- 1316: notiserna är identiska, och källan för passagenotisen är fortfarande `current`.
- TRIAGE/DESIGN-formuleringen "samma notistext, källa target" bör rättas.

### L4 (låg) — systerställen i app-lagret

En vändning kan också bekräftas efter `updateVessel`, i två vägar:
- STEG 5 i `_analyzeVesselPosition`, där `registerConfirmedIntermediatePassage` ger
  korsningsbeviset och `_confirmDirectionReversal` (VDS:6417, app.js:4415);
- `_checkSkippedBridgesFallback`, som går via `applyInferredPassage` (app.js:8733).

Målbron väntar där på nästa fix, alltså samma mönster som M1 och M2. Ingen av vägarna nämns i
DESIGN §4.4. De är sällsynta, eftersom de kräver ett GPS-hopp eller ett stort latitudhopp.
Redovisa dem som kända rester, eller anropa metoden där med samma vakt och riktningskontroll,
mätt.

### L5 (låg) — enhetstestet påstår mer än det prövar

`expect(app._observeBridgeOpening).toHaveBeenCalledWith(vessel)` i M1-testet jämför ett
muterat objekt. Det visar inte att öppningslagret såg målbron, och det går lika grönt på
c14938f. Fånga `vessel.targetBridge` i en mockImplementation.

Två test är rena spioner på implementationen: grindtestet och testet "ACCELERATED-grenen
använder samma utbrutna val". Det är godtagbart, men de prövar inte beteende.

## Det som håller (mätt)

- **Rotorsaken.** `R/repro/run.sh` (hunt.js --repro) på de nio korten gav KVAR ×9 på c14938f
  och BORTA ×9 på HEAD (`R/repro/bas.tsv`, `head.tsv`).
  - 936 c14938f: `NEW_JOURNEY … CONFIRMED` vid 366 m, `TARGET_CHANGE … ACCELERATED` först vid
    nästa fix (154 m).
  - 936 HEAD: `REVERSAL_SAME_TICK (new-journey)` vid 366 m.
  - 1317: varningen Stridsbergsbron#6 12:33:26 tillkommer, och notiserna är identiska.
  - 1274: varningen går från 09:20:29 (52 m) till 09:14:23.
  - Övriga 17 kort: samma utfall och antal på bas och HEAD (`R/repro/ovr-*.tsv`).
- **Utbrytningen.** Normaliserad diff av c14938f:s gren mot `_selectAcceleratedTarget` och
  `_applyAcceleratedTarget` (`R/acc-base.txt`, `R/acc-new.txt`). Bara else-if-kedjan har blivit
  tidiga returer, `mmsi` läses ur `vessel.mmsi` (samma värde) och orsaksetiketten har blivit en
  parameter. `positionDirection` är alltid null eller en riktning, så standardvärdet ändrar
  inget.
  - `assignTargetAfterReversal` har ACCELERATED-grenens grindar efter en Fix D-bekräftelse:
    `_shouldAssignTargetBridge(…, true)` och `reversalConfirmed: true`, plus 70 m-vakten.
  - N2:s prov är redan gjort när kroken körs.
- **U18.** Metoden anropas bara efter en bekräftad vändning: NEW_JOURNEY:s två observationer
  eller RE_CROSS-segmentet. Ingen ny riktningskälla tillkommer, men M2 läser vändningsfixets
  kurs i stället för nästa fix kurs (det är H1).
- **Regressionstesten.**
  - Kopierade till bwt: enhetstestet ger 8 av 9 röda, och de tre nya scenarierna är röda
    (35 s / ingen täckande varning).
  - På HEAD är allt grönt.
  - `PROBE_NO_B2=1` fäller 1317-scenariot ("Järnvägsbron fick 1 notiser").
  - Utan vakt fälls U14-scenariot.
- **Batteriet** (`R/batt`, `bash S/port/battery.sh A/rwt R/batt`): alla 13 steg har slutkod 0.
  - jest: 370 sviter och 5273 test.
  - Fassvepen är OK, självtestet GRÖNT och porcelain visar bara node_modules.
  - Bitlikhet mot egna c14938f-körningar (`R/basbank`): replay-all, replay-all-mon och openings
    har 0 råa diffrader.
  - Syntetsvitens 74 gamla rader är identiska; 3 nya har tillkommit.
- **Facit.** Inget låst facit flyttas, och banken är bitlik.
- **Quick mot V/bas/quick.**
  - Klustren och fynden är identiska, liksom radHash 3b19a079680f och fyndHash cac3641fbeda.
  - T2 "tunn" 130 → 131: i värld 169 går returens Stridsbergsbronvarning från 824 till 123 s.
  - T9 "ingenDomVändning" 21 → 23: i 169 och 269 kommer returens Klaffbronvarning nu 157 s och
    122 s efter L0-vändningen, inom T9:s fönster på 180 s (förut 223 s och 189 s). T9 dömer
    därför inte.
  - Ingen räknare är ett fynd.
- **Värld 169 och 269.**
  - 169: spärren vid Järnvägsbron gäller från fixet efter vändningen. Där bokförs
    `BRIDGE_QUEUE_APPROACH … Järnvägsbron`, och `_earlierBridgeAhead` kräver köbevis eller
    passerade broar, som för annan trafik söderifrån.
  - På c14938f hann deadline-ticket före det fixet, och 824 s var en artefakt av den sena
    målbron. 123 s ≥ 60 s är rätt enligt hur annan trafik behandlas, men returen bär nu M6:s
    risk (familj D).
  - 269 är en ren förbättring: 71 → 138 s.
- **B2.**
  - De 12 R1-fixturerna (r1-f10*, r1-f15*, r1-kand-lucka-* inklusive tva-broar-i-segmentet,
    r1-omgr-*) har med och utan monitoring identiska notiser, varningar och passager på bas och
    HEAD (`R/r1fix`).
  - Prov P2 (256 U-svängar över en eller två broar) är lika i alla fyra träd; där bekräftar
    Fix D före kedjan.
  - Prov P2c (`R/probe/defs-p2c.js`, 192 banor med 1317-mönstret, så att RE_CROSS bekräftar
    inne i målbrogrenen; återkorsningsfixet tätt, på linjen, mitt emellan eller bortom nästa
    bro, alltså två broar i samma segment):
    - mot c14938f blir 43 korsningar bättre och ingen sämre;
    - inga invariantutslag och ingen förlorad eller dubblerad notis;
    - en returnotis tillkommer (U14);
    - texterna skiljer i 24 banor bara i ETA, i 11 i ordning, och i 9 i passageformen
      ("passerade … under AIS-tystnad" blir "har precis passerat" när båten hördes på båda
      sidor);
    - utan B2 (PROBE_NO_B2) är allt identiskt med HEAD; B2 behövs alltså bara i 1317-läget
      (scenariot fäller utan B2);
    - med riktningskontrollen i H1 (PROBE_DIRCHECK) är allt identiskt med HEAD; alla 43
      förbättringar står kvar.
  - Ankaret i segmentets start ligger mellan vändpunkten och den återkorsade bron. Origin-vakterna
    ser alltså en delmängd av de broar den nya resan korsat; ingen bro tillkommer som hon inte
    korsat.
- **Samspel med andra familjer.** `git merge-tree --write-tree ab9c57c <familjens HEAD>`:
  - B (594a146) och D (9fe94c6) slås ihop utan konflikt;
  - C (19b3bfa) krockar textuellt i `scenarioGenerator.js`, där C:s `leg.cogDeg` och A:s
    `truthPath` ligger i samma benloop och docblock (förenliga), och i scenarioantalet i
    VALIDATION.md;
  - F (3887254) krockar i `runSyntheticScenarios.js` och VALIDATION.md;
  - `VesselDataService.js` och `app.js` slås ihop automatiskt med alla fyra.
