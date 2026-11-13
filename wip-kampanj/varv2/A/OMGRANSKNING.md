# OMGRANSKNING — familj A SAMMA-TICK, revision 1 (5edfe20, 2026-11-09)

Förkortningar: S = `/tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad`,
V = S/varv2, A = V/A, R = A/rtmp. A/rwt är utcheckad detached på `5edfe20`
(`git -C A/rwt checkout --detach 5edfe20`). Basen är A/bwt (`c14938f`). Provträdet A/pwt är
`ab9c57c` plus provväxlarna; utan växlar motsvarar det första omgången ("ab"). Inga ändringar i
A/wt eller andra familjers kataloger. rwt, bwt och pwt visar bara `?? node_modules`.

## Dom: GODKÄND

- H1 är rättad: utliggarproven ger exakt c14938f:s utfall.
- B2-villkoret behövs, och det ger ingen ny lucka mot c14938f.
- Medel- och lågpunkterna, testerna och dokumentationen håller. Batteriet och quick är rena.
- Kvar står en ny låg anmärkning (L6). Felet fanns redan i 91641f9: en utliggare där även
  kursen är vänd ger ett falsklarm vid Järnvägsbron. Den bör dokumenteras som känd gräns,
  men hindrar inte integrationen.

## 1. H1 (hög) är rättad

- **Koden.** `assignTargetAfterReversal` avstår när riktningen som skulle låsas
  (`positionDirection || _deriveAssignmentDirection`) motsäger den nyss bekräftade vändningen
  vid ≥ 2 kn (`_routeLockVerdict` 'override'). Logiken är densamma som i min prob
  `PROBE_DIRCHECK`. C4b läser samma `_routeLockVerdict`, och dess villkor ('keep') är
  ordagrant det gamla. Banken är bitlik, vilket bekräftar att C4b är oförändrad.
- **Utliggarproven** (`R/probe/run.sh A/rwt R/probe/p3|p4 …`): båda ger samma utfall som
  c14938f.
  - P3, 504 banor: 0 banor med extra varning eller extra målbropassage (HEAD i första omgången
    gav 10). Antalet varningar, målbropassager och notiser är lika med c14938f i varje bana,
    och lika med `PROBE_DIRCHECK`.
  - P4, 36 banor med generatorns `gpsJump`: likaså.
- **De nio familjekorten** (`R/repro/rev.tsv`): BORTA ×9, också 1317.

## 2. Det nya B2-villkoret

- **Syftet håller.** De två banor familjen nämner (`Js-F4-D3-J30-iv10+0-sog1-retur-s4/s5`,
  återskapade med deras `sweep-gen.js`, MMSI 905001102 och 905001103) gav följande
  returnotiser vid Järnvägsbron (`R/sweepJ`):

  | Träd | returnotis |
  |---|---|
  | c14938f | ja |
  | ab | ja |
  | rev | ja |
  | ab + riktningskontroll + villkorslöst B2 (min `PROBE_DIRCHECK`) | **nej** |

  Villkoret behövs alltså, och min ursprungliga förslagsvariant var för grov.
- **Prov P6** (`R/probe/defs-p6.js`, 192 banor). Det är 1317-mönstret, där RE_CROSS
  bekräftar inne i målbrogrenen, med brusig kurs efter vändningen: ±45° eller ±90° på varje
  fix, eller bara återkorsningsfixets kurs vänd 180°. Återkorsningsfixet ligger på linjen,
  mitt emellan eller bortom nästa bro.
  - **rev mot c14938f:**
    - ingen korsning får sämre ledtid, och 24 blir bättre;
    - ingen notis förloras;
    - 2 returnotiser tillkommer (U14), och båda motsvarar sanna korsningar.
  - **rev mot ab:** skillnader bara i de vända fallen. Där blir rev lika med eller bättre än
    ab: 11 korsningar får bättre ledtid, och ab:s sena returvarningar efter korsningen
    försvinner.
  - **Det villkorade B2-fallet**, alltså ankaret i nuet och målbron uppskjuten (logg
    `R/logs/p6flip.rev.log`): `JOURNEY_ORIGIN … (reversal-north)` i nuet,
    `REVERSAL_TARGET_DEFERRED … kurs och positionsbevis är oense`, och sedan
    `ACCELERATED` vid nästa fix.
  - **Järnvägsbrons returnotis:** den saknas i 120 banor på rev och 121 på c14938f. Ingen
    bana saknar den bara på rev. Luckan finns redan på c14938f; det är det öppna kortet
    U-SVÄNG-LÅNGSAM-ÅTERKORSNING.
  - **Invariantutslag:** ett enda, SEN MÅLBRO-NOTIS i p6-S-d120-v3-iv120-linje-k90, både på
    ab och rev. Notisen kommer vid samma tid som på c14938f, men passagen bokförs ett fix
    tidigare, närmare den sanna korsningen.
- **Slutsats:** villkoret ger ingen ny lucka mot c14938f. När kursen motsäger återkorsningen
  blir beteendet c14938f:s (ankare och målbro), annars första omgångens.

## 3. Medel- och lågpunkterna, testerna och dokumentationen

- **M1 (vaktens M2-del).** Scenarierna med seed 9715 och 9713 finns, och den nya
  `maxPassagesPerBridge` dömer fantompassager. Mutationsprov med revisionens
  `runSyntheticScenarios.js` (`R/synthrev`):

  | Träd | 9715 | 9713 | U14-vakten |
  |---|---|---|---|
  | ab (ingen kontroll) | rött, "Klaffbron fick 2 varningar" | grönt | – |
  | ingen kontroll och ingen vakt | rött | rött (fantompassage, 2 varningar) | rött |
  | kontroll men ingen vakt | grönt | grönt | rött |
  | c14938f | grönt | grönt | – |

  Påståendena i VALIDATION och ARCHITECTURE stämmer: 9713 fäller först utan båda skydden,
  och vakten är det enda skyddet för M1. På c14938f är de tre M1/M2-scenarierna röda, som
  avsett.
- **L1–L3.** Rättat i ARCHITECTURE, VDS-kommentaren och DESIGN:
  - vaktens kostnad med mina tal;
  - ETA-utjämningen i 936, 1918 och 169;
  - notiserna i 1208 och 1316.
- **L4.** Systervägarna står som "Kvar" med motivering. Familjens räkning
  (`A/scripts/gate-count.sh`: 5 grindbekräftade passager på 482 h, ingen vändning) har jag
  granskat metodiskt men inte kört om.
- **L5.** M1-testet fångar nu `targetBridge` vid `_observeBridgeOpening` (`['Klaffbron']`,
  respektive `[null]` i testet utan tilldelning).
- **Enhetstesten:** 11 av 11 gröna på 5edfe20 och 10 av 11 röda på c14938f (kopierade till
  bwt och borttagna efteråt).
- **Kvar, ny men låg (L6): utliggare där även kursen är vänd.**
  - **Prov P7** (`R/probe/defs-p7.js`, 252 banor): som P3, men utliggarens kurs vänds 180°.
  - **Prov P8** (`R/probe/defs-p8.js`, 84 banor): fart och kurs räknas ur positionsskillnaden.
  - **Utfall:** vid Järnvägsbron norrut, med målbro Stridsbergsbron, ger ab och rev lika.
    Det gäller 23 av 252 banor i P7 och 42 av 84 i P8, alltså alla P8-banor där utliggaren är
    andra fixet efter passagen (k = 2), oavsett X = 30–180 m:
    - en falsk varning "Klaffbron … southbound";
    - "på väg mot Klaffbron" i 20–60 s;
    - i en bana bokförs Stridsbergsbrons passage som mellanbropassage.
  - c14938f ger i stället 20 s "Inga båtar" (`R/logs/p7J50.rwt.log`).
  - **Varför kontrollen inte tar fallet:** kursen och återkorsningen är eniga, och
    Klaffbron ligger 900 m bort, utanför vakten.
  - **Bedömning:** felet fanns redan i 91641f9 och är inte en följd av revisionen. Det kräver
    att position och kurs är fel i samma fix. Fältdatan säger att utliggare bär båtens
    verkliga fart (S-F4, ARCHITECTURE:1089), och följden är ett falsklarm, inte en missad
    öppning. Därför låg.
  - **Förslag:** för in fallet som känd gräns under "Kvar" i ARCHITECTURE. Ett skydd kunde
    vara en kadensberoende rimlighetsprövning: en vändning på 180° i ≥ 2 kn mellan två fix
    med under cirka 30 s emellan avstår samma-tick-tilldelningen.

## 4. Batteriet och motorn

- **Batteriet** (`bash S/port/battery.sh A/rwt R/batt-rev1`): alla 13 steg har slutkod 0.
  - jest: 370 sviter och 5275 test.
  - Fassvepen är OK med och utan monitoring, och självtestet är GRÖNT.
  - porcelain visar bara `node_modules`.
- **Bitlikhet mot c14938f** (`R/basbank`):
  - replay-all, replay-all-mon och openings har 0 råa diffrader;
  - synth har 79 scenarier, där de 74 gamla raderna är identiska och 5 nya har tillkommit;
  - inget låst facit flyttas.
- **Quick mot V/bas/quick** (`R/batt-rev1/hunt-quick`):
  - 25 kluster och 58 utslag, med identiska fynd;
  - radHash 3b19a079680f och fyndHash cac3641fbeda är lika;
  - inga nya kandidatkort;
  - bara samma två räknare som i första omgången ändras: T2 "tunn" 130 → 131 (värld 169)
    och T9 "ingenDomVändning" 21 → 23 (169 och 269).
- **`hunt.js --repro`:** BORTA ×9 för familjens kort (`R/repro/rev.tsv`).
