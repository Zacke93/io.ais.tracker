# Triage B, varv 2: F06, F07 och B01 (2026-11-09)

Underlag: motorns standardkörning `S/reg/slut-standard` (c14938f, appkoden som
aa71099), worktree `S/varv2/tB/wt` på c14938f. Alla tider är UTC. Alla
fullvärldar är återskapade ur generatorn (basSeed 1) med bitlika radhashar mot
rapporten, och `hunt.js --repro` ger KVAR för var och en på c14938f
(`S/varv2/tB/kort/*.bas.txt`).

Verktyg (alla i `S/varv2/tB/scripts/`):
- `gen.js`, `mkcard.js`, `mkcard0.js`: världar och repro-kort ur generatorn.
- `spion.js`: kör replayRunner med en spion på `BridgeOpeningService` som loggar
  armens prognos vid varje fix (`_refreshArm`), släppvägens dom
  (`_coverageVerdict`), släppen och passagerna. Den ändrar inget i worktree.
  Utdata: `S/varv2/tB/v/w<värld>.spion`.
- `spår.py` (tidslinje per båt), `marginal.py` (appens prognos mot fönstrets
  slut per fix), `kajscen.js`/`kajkort.js` (egna kajscenarier),
  `kajskanna.js`/`kajutfall.py` (kajköer i standardens 2 000 världar).

Förkortningar: E = händelsen som täckte båten när hon korsade. A = E:s första
sanna korsning (L0). B = båtens sanna korsning. W = fyndets varning.
"Fönstrets slut" = appens `windowEnd = min(coverUntilMs, max(firedAt,
firstPassageAt) + 600 s)` i `_coverageVerdict` (BridgeOpeningService.js:2298–2320).

## Kort sammanfattning

| Mekanism | Världar | Klass |
|---|---|---|
| M1 Tyst konvojmedlem släpps vid täckningsslutet med appens prognos inom fönstret | 1973, 537, 625 (FREJA), 1337, 1629, 1752, 479 (F07); 510 och 1704 är nästa öppning | TÄCKT (U17, K-TYST-BÅT-NÄSTA-ÖPPNING). Motorns kvotregel kan inte bevisa premissen; registret behöver appens egen prognos |
| M2 Tystnadsvillkoret läser mottagningstiden i stället för fixens tid | 941 | MOTORFEL (registry.js:1940); därefter TÄCKT av U17 |
| M3 Gemensam RECOVER: två tysta båtar släpps ur samma händelse, och den andra leder varningen | 972 (F07) | TÄCKT av U17; predikatets villkor (2) för snävt (registry.js:1927) |
| M4 Tyst köande båt vid en tidigare bro: reservvarningen 5 min efter senaste fixen | 625 (DAGNY) | MÄTGRÄNS (R1-modellens kadens, BUGGJAKT §4.5); den uteblivna varningen hör till T-A:s F05 |
| B01 Kajpredikatet träffar fel båt | 138 | MOTORFEL (registry.js:1023–1046); flashen är U1-C11 (DESIGN) |
| Kajfrågan Köare vid Klaffbron i Kajens kapsel demoteras efter 15 min | 9 av standardens 2 000 världar (bl.a. 313 i F02) | ÄGARBESLUT |

Ingen av F06:s eller F07:s världar är ett APPFEL.
- **Ingen position visade passagen.** I alla elva M1–M3-fall hade appen ingen
  sådan position när varningen gick. Nästa fix kom tidigast 0,5 s efter
  varningen (1704) och oftast 4 s–2,7 min efter. För F07-båtarna 479 och QUEST
  i 972 kom ingen fix alls.
- **Bakkanten kunde inte släppa henne.** Appens egen prognos låg inom fönstret
  vid VARJE fix efter att E:s första passage blev känd, med marginalen +3,5 till
  +134 s.
- **Släppet kom vid täckningsslutet,** med domen `täckningsslut`
  (`_releaseStrandedArms`, BridgeOpeningService.js:2171–2197, domen på :2340).

Det är exakt U17:s premiss: "hennes senaste position sa att hon skulle hinna
igenom den gemensamma öppningen, men appen vet inte om hon gjorde det".

## Per värld

Tidslinjerna står i sin helhet i `S/varv2/tB/v/` (spion och verbos logg) och
återskapas med `python3 -I scripts/spår.py w/w<värld>-R1 <mmsi> <bro>`.

### F06 · värld 1973 (representanten) · MASEN 265329761 · Stridsbergsbron söderut · R1 aishub
- 15:27:55 E = Stridsbergsbron#1 varnar (ledare PELLE). A = 15:32:03,6.
- 15:32:24,9 MASEN absorberas (2 413 m). 15:32:25,0 PELLEs passage bokförs;
  `OPENING_COVER_REBASE` kortar täckningen till 15:42:25,0 (bokföringen + 600 s,
  BridgeOpeningService.js:2686–2712). Appens fönsterslut 15:42:04,9.
- Prognoser vid hennes sju fix efter bokföringen: 15:40:41–15:41:31, marginal
  +33,5 till +83,5 s. Bakkanten släpper henne aldrig (rätt).
- Sista fix före W: fixTs 15:39:57 (mottagen 15:40:18,4), 139 m norr om bron i
  9,2 kn, prognos 15:41:31,4. B = 15:40:27,7 (B − A = 504 s, samma öppning).
- 15:42:25,0 täckningsslut: domen `täckningsslut`, släpp, ny händelse #4 och
  W (deadline, eta 0) 117 s efter B. Nästa fix 15:42:32,8 (fix 15:41:54, 305 m
  söder om bron), 7,7 s efter W.
- Rotorsak: U17-släppet (BridgeOpeningService.js:2197, :2340). Hon låg 139 m
  från bron, alltså utanför under-bron-hållet (≤ 50 m, :2330–2338).
- Varför predikatet missar: villkor (3b), raden 15:33:31 har den raka restiden
  418 s mot 507 s kvar (kvot 0,82 > 0,6, registry.js:1984–1989). Appens prognos
  vid samma rad låg 83,5 s inom fönstret. Klass: TÄCKT (U17), mekanism M1.

### F06 · värld 510 · JOLLY 265558533 · Stridsbergsbron söderut · R1 aishub
- 15:52:15,9 E = #1 (ledare 265558311). JOLLY absorberas 15:52:50,5. A = 15:58:15,5
  (appens skattning 15:58:08,8, bokförd 15:58:23,6). Täckningsslut 16:08:23,6,
  fönsterslut 16:08:08,8.
- Prognoser vid sju fix efter bokföringen: 16:07:34–16:08:05,2, marginal +3,6 till
  +34,7 s. Hon saktade in vid bron (2,9 kn vid 102 m, 1,4 kn i korsningen).
- Sista fix: 16:06:04 (102 m, 2,9 kn), prognos 16:07:46,5. B = 16:08:20,0, alltså
  B − A = 604 s. Hon hör till NÄSTA öppning, med 4 s marginal.
- 16:08:23,6 täckningsslut, W 4 s efter B. Nästa fix 16:08:36,8 (fix 16:08:26,
  6 m söder om bron).
- Samma apphändelse ger T-A:s F05 (T2 OKLASSAD för JOLLY). I R0 släpper
  bakkanten henne 16:07:46 med 33 s ledtid (T2 LEDTID; `kort/r0-w510.txt`).
- Varför predikatet missar: kvoten 490/580 = 0,84 på raden 15:58:23. Klass:
  TÄCKT (K-TYST-BÅT-NÄSTA-ÖPPNING, KÄND_ÖPPEN), mekanism M1.

### F06 · värld 537 · DAGNY 265185267 · Stridsbergsbron söderut · R1 aisstream
- 12:44:44,2 E = #6 (ledare 265185218). Absorberad 12:45:14,8 med täckning
  13:01:15,6, som räknas ur ledarens prognos vid absorptionen. Ledaren bokförs
  12:51:40,0, före sin sanna korsning A = 12:51:44,6. Bokföringen + 600 s ligger
  senare än täckningen, och täckningen förlängs aldrig (:2696).
- Fix 12:56:20 (546 m) med prognos 12:59:52,7 (+82,9 s) och fix 12:58:37,8
  (187 m, 5,3 kn) med prognos 13:01:12,2 (+3,5 s).
- B = 12:59:52,9 (B − A = 488 s). W 13:01:15,6 (täckningsslut) 83 s efter B.
  Nästa fix 13:01:26,2 (175 m söder om bron).
- Predikatet: kvoten 208/265 = 0,78. Klass: TÄCKT (U17), M1.

### F06 · värld 625, fynd 1 · FREJA 265956823 · Stridsbergsbron söderut · R1 aisstream
- 09:12:18 E = #4 (ledare 265956645). A = 09:17:57,6, bokförd 09:18:27,0.
  FREJA absorberas 09:18:43,7 på första fixen, 1 905 m från bron. Fönsterslut
  09:28:01,3, täckningsslut 09:28:27,0.
- Prognoser vid fyra fix: 09:25:47–09:26:51, marginal +70 till +134 s.
- Sista fix 09:24:59,8 (202 m, 8,7 kn). B = 09:25:44,1 (B − A = 467 s). Därefter
  tyst i 6 min, till 09:31:00,2.
- W 09:28:27,0 (täckningsslut) 163 s efter B.
- Predikatet: kvoten 436/553 = 0,79 (jest-fallet `[gräns] värld 625`). Klass:
  TÄCKT (U17), M1.

### F06 · värld 625, fynd 2 · DAGNY 265956525 · Stridsbergsbron norrut · R1 aisstream
- DAGNY är den fokala F-KÖ-båten med kö vid Järnvägsbron (265 m före bron, 195 s).
  Hon absorberas aldrig vid Stridsbergsbron.
- Fix 09:29:43 och 09:32:49,4: still i kön, 520 m söder om Stridsbergsbron.
  Armen mot Stridsbergsbron hålls av den tidigare bron
  (`earlierBridge`/`earlierBridgeUntilMs`, BridgeOpeningService.js:1302–1316).
  Med en bekräftad kö är spärren `STALE_ETA_SOFT_MS`.
- Sanningen: hon lämnar kön 09:32:53,0, 3,6 s efter sista fixen, korsar
  Järnvägsbron 09:35:32 och Stridsbergsbron 09:36:55,8. Hon är tyst till
  09:44:28,5, alltså 11,6 min.
- W = Stridsbergsbron#11 09:37:49,4. Det är exakt sista fixen + 300,0 s, alltså
  spärrens reservvarning när den löper ut i tystnad (:1313–1315 och :397;
  ARCHITECTURE.md:858–873, regel (3)). W kom 54 s efter B (eta −1).
- Varför predikatet missar: "absorberades inte". Det stämmer, och U17 gäller inte.
  Klass: MÄTGRÄNS (M4); se nedan. Samma båt ger F05 (T2 OKLASSAD) hos T-A.

### F06 · värld 941 · ZELDA 265790032 · Stridsbergsbron söderut · R1 aishub
- 13:18:00,9 E = #7 (ledare 265789954). ZELDA absorberas 13:18:45,6 med täckning
  13:33:01,2. Ledaren korsar A = 13:21:49,5 men hörs först 13:33:25,6. E har
  alltså ingen bokförd passage, och bakkanten prövas inte (rätt: "före första
  passagen är fönstret en prognos om ledaren").
- Sista raden före W: mottagen 13:28:57,288 men med fixTs 13:28:40. Den visar
  henne 58 m norr om bron i 6,7 kn. B = 13:28:57,177, alltså 0,1 s före
  mottagningen men 17 s efter fixen. Positionen ligger före bron.
- W 13:33:01,2 (täckningsslut) 244 s efter B. Nästa fix 13:35:42,8 (fix 13:34:57,
  961 m söder om bron).
- Varför predikatet missar: "båtens rad 13:28:57 kom efter korsningen 13:28:57".
  Predikatet jämför RADENS MOTTAGNINGSTID med korsningen (registry.js:1940:
  `sista.aisTimestamp < kors.t`), men raden bär en fix från före korsningen.
  Appen kunde inte veta att hon passerat (BUGGJAKT §7 rad 27 kallar 941 ett
  motexempel, "hördes efter korsningen", och jest-fallet `[vakt] värld 941`
  bygger på samma misstag). B − A = 428 s. Med fixens tid matchar U17. Klass:
  MOTORFEL (M2), därefter TÄCKT (U17).

### F06 · värld 1337 · WILMA 265222729 · Stridsbergsbron söderut · R1 aisstream
- 10:22:26,9 E = #4. Ledaren 265222557 kryper (F-KRYP, 0,7 kn) och korsar
  A = 10:36:20,9, bokförd 10:37:09,6. WILMA absorberades 10:25:55 med täckning
  10:39:39,7 ur ledarens prognos. Täckningen förlängs aldrig, så fönsterslutet
  är 10:39:39,7.
- Fix 10:37:42,5 (220 m, 5,7 kn): prognos 10:38:58,9 (+40,8 s). B = 10:38:56,6
  (B − A = 156 s, samma öppning).
- W 10:39:39,7 (täckningsslut) 43 s efter B. Nästa fix 10:41:03,4 (273 m söder om
  bron).
- Täckningen slutade före U2-fönstret (10:46:20) därför att den inte förlängs.
  Det är medvetet: docblocket i BridgeOpeningService.js:2667–2675, "rebasera NED,
  aldrig upp", efter produktprincipen.
- Predikatet: kvoten 75/87 = 0,86; "tidigaste slut" W − 30 s är 30 s
  tidigare än appens. Klass: TÄCKT (U17), M1.

### F06 · värld 1629 · WILMA 265479497 · Stridsbergsbron söderut · R1 aisstream (F-SENFÖDD)
- E = #1 (ledare 265479558). A = 09:07:28,3, bokförd 09:07:45,2. Fönsterslut
  09:17:29,0, täckningsslut 09:17:45,2.
- WILMA hörs första gången 09:11:05,4, 1 210 m från bron i 6,6 kn. Prognosen
  09:17:01,9 ligger 27,1 s inom fönstret, så hon absorberas. Därefter är hon tyst
  till 09:18:24,5.
- B = 09:17:06,6 (B − A = 578 s). W 09:17:45,2 (eta −1) 39 s efter B.
- Predikatet: kvoten 356/370 = 0,96. Klass: TÄCKT (U17), M1.

### F06 · värld 1704 (r2-representanten) · VEGA 265584588 · Klaffbron söderut · R1 aisstream (F-AVBROTT)
- E = Klaffbron#3, en varning norrut 11:58:58 med ledaren MASEN 265584549.
  MASEN korsar A = 12:11:29,1 mitt i ett AIS-avbrott (12:01:25–12:15:57).
  Appen skattar hennes korsning till 12:13:07,5 ur fixarna 12:00:51 och 12:18:25.
- GUNHILD korsar 12:16:02 och bokförs först, 12:17:59,0 med korsningen 12:16:01,9.
  Därför blir `firstPassageAt` 12:16:01,9. VEGA absorberas 12:16:37,9 med
  täckning 12:22:49,5. Fönsterslutet är 12:22:49,5, med eller utan MASENs
  skattade korsning.
- Fix 12:20:26,7 (135 m, 4,1 kn): prognos 12:21:29,8 (+79,7 s). B = 12:21:36,6.
  B − A = 607 s räknat från MASENs sanna korsning, så hon hör till nästa öppning
  med 7 s marginal. Mätt mot appens kunskap hör hon till samma öppning.
- W 12:22:49,5 (täckningsslut) 73 s efter B. Nästa fix 12:22:50,0, 0,5 s efter W.
- Predikatet: restiden 64 s mot 62 s kvar (kvot 1,03). Mot sann korsning hade en
  bakkant släppt henne med 0,7 s marginal (prognosen 12:21:29,76 mot 12:21:29,09). Avbrottet döljer MASENs sanna
  korsning. Klass: TÄCKT (K-TYST-BÅT-NÄSTA-ÖPPNING), M1.

### F06 · värld 1752 · ZELDA 265205690 · Stridsbergsbron söderut · R1 aishub
- E = #1 (ledare 265205602). A = 14:32:15,5, bokförd 14:32:51,0. Fönsterslut
  14:42:17,1, täckningsslut 14:42:51,0.
- Prognoser vid fem fix: 14:41:04–14:41:26, marginal +51 till +73,5 s. Sista fix
  14:36:59 (mottagen 14:37:20, 562 m). B = 14:40:09,7 (B − A = 474 s).
- W 14:42:51,011 (eta −1) 161 s efter B. Nästa fix har fixTs 14:42:51,000, alltså
  11 ms före W, men mottogs först 14:42:55,3. Appen kunde inte ha den.
- Predikatet: kvoten 464/571 = 0,81. Klass: TÄCKT (U17), M1.

### F07 · värld 479 (r2-representanten) · 265651025 · Stridsbergsbron söderut · R1 aishub, monitoring
- E = #8, en varning norrut med ledaren 265651105. A = 14:18:12,2, bokförd
  14:18:37,4. Båten hörs bara en gång före W: 14:19:43 (fix 14:19:38), 1 452 m från
  bron i 6,6 kn. Hon absorberas i #8 med prognosen 14:26:45,7, 85,6 s inom
  fönstret 14:28:11,3.
- B = 14:27:14,5 (B − A = 542 s, samma öppning).
- 14:28:37,4 täckningsslut för #8, och släppet sker. Samma utvärdering
  återabsorberar henne i #9, en redan varnad händelse söderut (J13+J33 (a),
  ARCHITECTURE.md:2080–2093) med täckningen 14:43:20,2.
- 14:43:20,2 täckningsslut för #9 ger ny händelse #14 och W (eta −1, d = 1 452 m).
  Fixen är då 24 min gammal.
- Varför hon räknades med: tystnad avväpnar aldrig (BridgeOpeningService.js:1350),
  och släppvägen har ingen färskhets- eller åldersgräns. U17 avvisade
  uttryckligen KRAV (2) (lastSeenAt > firstPassageAt), åldersgränsen
  STALE_ETA_HARD och ledtidsgolvet (ARCHITECTURE.md:1934–1951). Kedjan i två
  led kommer av J33:s värdval. "F11 och F23 är fortfarande kedjor i två led"
  (:2093), och U17 godtog just F11/F23-klassen.
- Vilken regel hade uteslutit henne: KRAV (2) eller en fixålder. Båda är mätta
  och avvisade (U17, U13). Ett annat värdval i J33 (kräv `host.firedAt` nyare än
  släppet) är en öppen semantikfråga (J13+J33, KÄND_ÖPPEN). Med det hade
  säkerhetsvarningen kommit 14:28:37 i stället, 83 s efter B och fortfarande
  efter passagen.
- Predikatet: kvoten 428/514 = 0,83 på raden 14:19:43. Klass: TÄCKT (U17), M1.

### F07 · värld 972 (representanten) · QUEST 265159025 · Stridsbergsbron söderut · R1 aisstream
- Sista fixar 13:31:55 och 13:32:32,5 (1 067 m, 4,2 kn). QUEST absorberas i #4, en
  blandad händelse med ledaren 265158853 norrut som varnade 13:28:45. Prognosen
  är 13:41:11,8. Sedan är hon tyst resten av världen.
- QUEST korsar först av alla: B = 13:40:31,6 = A (B − A = 0).
- MASEN 265158956 absorberas i #4 13:39:40,9. Sista fix 13:41:33,6 (715 m),
  prognos 13:47:33,4. Hon korsar 13:46:14.
- 13:49:33,7 täckningsslut för #4. Båda släpps, och samma utvärdering
  återabsorberar båda i #6 (J33 (a)), en varnad händelse norrut med täckningen
  13:54:52,9.
- 13:54:52,9 täckningsslut för #6. Båda släpps i samma utvärdering och binds till
  EN ny händelse #10, som avfyras direkt (deadline). Ledaren väljs på rått avstånd
  (`_leadOf`, :2761): MASEN 715 m, QUEST 1 067 m. QUESTs fix är då 22,3 min gammal.
  MASEN, som korsade 8,6 min före W, har inget eget utslag i rapporten.
- Varför predikatet missar: "varningen Stridsbergsbron#10 leds av 265158956, inte
  av båten själv" (registry.js:1927). Den andra båten är lika tyst och släpptes ur
  samma händelse vid samma täckningsslut, så W är en gemensam RECOVER.
- Varför hon räknades med, och vilken regel: samma svar som för 479. Klass:
  TÄCKT (U17), M3.

### B01 · värld 138 · Stridsbergsbron · R1 aisstream
- Texten "En båt på väg mot Stridsbergsbron, ETA okänd" bärs av ULLA 265162344.
  Hennes sista fix är 09:33:47,7, 125 m norr om bron i 4,8 kn. Därefter är hon tyst
  och korsar Stridsbergsbron 09:34:41, Klaffbron 09:45:35 och Olidebron 09:56:20.
- 09:54:00,04 (tick): `STALE_DISPLAY_DROP 265162344: AIS 1212s old > limit 20min`.
  Trappans 20-minuterssteg gäller "mitt i passage" (≤ 300 m från målbron,
  VesselDataService.js#getVesselsForBridgeText). Texten blir "Inga båtar".
- 09:55:23,7 hörs ELSA MARIA 265162191: "En båt på väg mot Stridsbergsbron, om 11
  minuter". Flashen varade 84 s.
- Kajliggaren TROLLA 265162412 (navStatus 5, still hela världen 2,4 h, utan målbro
  och utan rörelsebevis) ligger i Kajens kapsel. Hon var aldrig i texten
  (`BRIDGE_TEXT_FILTER ... No valid targetBridge`).
- Registrets D1-KAJZON-DEMOTION matchade på TROLLA. Predikatet
  `mooringCapsuleStationary` (registry.js:1023–1046) godtar VILKEN båt som helst
  som ligger still ≥ 3 min i en kapsel > 600 m från bron, och posten står före
  U1-C11 i registret (beslutsregister.json:74 mot :133).
- Med kajposten avstängd blir både minsta repro och fullvärlden DESIGN via
  U1-C11-TYST-FÖRE-DEFAULT (prövat med `hunt.js --repro`). Krymparen behöll
  TROLLA i minsta repro bara för att hålla kvar KONFLIKT-klassen.
- Klass: MOTORFEL. Den verkliga kajkonflikten är en annan; se Kajfrågan.

## Mekanismerna

### M1 · TÄCKT (U17 och K-TYST-BÅT-NÄSTA-ÖPPNING) · tyst konvojmedlem släppt vid täckningsslutet
- **Världar:** 1973, 537, 625 (FREJA), 1337, 1629, 1752 och 479 (F07) är
  samma öppning. 510 (604 s) och 1704 (607 s) är nästa öppning med 4 och 7 s
  marginal.
- **Rotorsak:** U17-släppet i `_releaseStrandedArms`
  (BridgeOpeningService.js:2171–2197, domen `täckningsslut` :2340). Täckningen
  räknas från bokföringen (:1898–1903, :2686–2712) och förlängs aldrig (:2696).
  Vid täckningsslutet hålls bara en båt ≤ 50 m från bron eller med kursen bort
  (:2330–2339). Övriga släpps och varnas på sin sedan länge förfallna deadline.
  Ägarbeslutet U17 (ARCHITECTURE.md:1934–1951) säger att varningen ska stå kvar.
- **Belägg:** appens prognos vid varje fix efter att E:s första passage blev
  känd låg inom fönstret (`marginal.py`):

  | Värld | Kvot i motorn | Minsta marginal i appen |
  |---|---|---|
  | 1973 | 0,82 | +33,5 s |
  | 510 | 0,84 | +3,6 s |
  | 537 | 0,78 | +3,5 s |
  | 625 | 0,79 | +70 s |
  | 1337 | 0,86 | +40,8 s |
  | 1629 | 0,96 | +27,1 s |
  | 1704 | 1,03 | +79,7 s |
  | 1752 | 0,81 | +51 s |
  | 479 | 0,83 | +85,6 s |

  Appens ETA är pessimistisk nära broarna. Vid 139 m gav den 94 s mot den raka
  restidens 29 s, och vid 2 km 1,04 gånger den raka. Kvotregeln (restid ≤ 0,6 av
  tiden kvar) kan därför aldrig skilja fallen åt. Motorns "tidigaste slut"
  (W − 30 s) ligger dessutom upp till 30 s före appens, eftersom täckningsslutet
  bokas exakt (`Math.floor(coverUntilMs) + 1`, :393).
- **Varför predikatet inte träffade:** villkor (3b) i `tystRecoverSammaÖppning`
  (registry.js:1984–1989, `maxRestandel` 0,6, :1914). Registret 2026-11-07 rad 32
  införde kvotregeln för att mutationsprovet med bakkanten bortkopplad annars gav
  43 nya U17/K-NÄSTA-utslag. Granskningens anmärkning (a) konstaterade redan att
  de här tio är U17-sanna. Kvotregeln är alltså motorns mätgräns, inte appens.
- **Registerpost (utvidgning av U17-TYST-BÅT-RECOVER och K-TYST-BÅT-NÄSTA-ÖPPNING):**
  - *Predikat:* `tystRecoverSammaÖppning` med villkor (3′) när resultatet bär
    harnessens nya prognosspår. Varje dom 'covered' för henne i E efter att E:s
    första passage bokförts, på ett rent och ofryst fix före täckningsslutet och
    utan kursen bort, ska ha `expectedArrivalMs ≤ min(coverUntilMs, max(firedAt,
    firstPassageAt) + 600 s)` (golvhållen: `coverUntilMs`). W ska komma högst en
    tick efter ett släpp med domen `täckningsslut` (inte `bakkant`) ur E eller en
    återabsorberande händelse. Utan spåret gäller kvotregeln som förut.
  - *Harness:* `replayRunner.js#instrumentApp` wrappar
    `bridgeOpeningService._coverageVerdict` och bokför per arm och (händelse, fix,
    dom) i `openingCoverageVerdicts`: t, mmsi, bro, eventId, dom, lastSeenAt,
    expectedArrivalMs, coverUntilMs, firedAt, firstPassageAt,
    firstPassageRegisteredAt, anchorFloor, clean, frozen och courseAway. Det är
    ren diagnostik, som `openingCoverage`.
  - *Källa:* ARCHITECTURE.md:1934–1951 (U17); BridgeOpeningService.js#_coverageVerdict
    (bakkanten :2300–2320, täckningsslutet :2321–2340); replayRunner.js#instrumentApp
    (prognosspåret); BUGGJAKT §7 rad 32 och granskningens anmärkning (a).
- **Skiss:** `S/varv2/tB/skiss-M1-u17-prognosspar.diff`.
  - Med skissen ger `hunt.js --repro` BORTA för 1973, 537, 625:1, 1337, 1629,
    1752 och 479 (DESIGN U17) och för 510 och 1704 (KÄND_ÖPPEN K-NÄSTA). Det gäller
    även F06:s båda representanter och F07:s r2.
  - Kvar som KANDIDAT: 625:2 (M4), 941 (M2) och 972 (M3).
  - Motorns 26 jest-sviter är gröna, med tre nya fall: träff för 625 med det
    verkliga spåret, vakt för en prognos efter fönstrets slut och vakt för ett
    släpp genom bakkanten. De 38 harnessnära sviterna och lint är också gröna.
  - Standardens sanningsspår (2 000 världar, `hunt/m1-bas`) mot `slut-standard`
    byter exakt 10 registerutfall:
    - de nio ovan;
    - 790 i F02 (T2 LEDTID<60s, KANDIDAT → K-NÄSTA). Det är T-A:s "K-NÄSTA-sann
      med restid 1,34".

    U17 används 45 → 52 gånger och K-NÄSTA 7 → 10.
  - Mutationsprovet med bakkanten bortkopplad (`hunt/m1-mutA`; `_coverageVerdict`
    :2312 dömer alltid 'covered' före täckningsslutet) gav 75 nya utslag. Inget av
    dem tas av U17 eller K-NÄSTA:
    - 67 är KANDIDAT (28 T2 LEDTID, 21 T3 VARNING-EFTER, 18 T2 OKLASSAD);
    - 8 tas av U2-VS-DEADLINE, lika många som i registrets eget mutationsprov
      2026-11-07. Korsningen ligger inom konvojfönstret;
    - 14 av kandidaterna fälls av just det nya villkoret (3′), "prognos efter
      fönstrets slut".

    Känsligheten mot en bakkantsregression är alltså kvar utan kvotregeln.
    Under-bron-hållet (4) och kursen bort prövas som förut på raderna och
    påverkas inte av skissen.
- **Risk för de 24 låsta korpusarna:** ingen ändring i appen. Harnessens nya fält
  är additivt och läses inte av replay:all, openings eller några golden-filer.
  `hunt.js --selftest` med fältet är GRÖNT (`hunt/m1-selftest`): determinism
  24/24, SHIFT30 24/24, MMSI 24/24, kanarier 5/5 och rundresa 45/45. Facit
  flyttas inte.

### M2 · MOTORFEL · tystnadsvillkoret läser mottagningstid
- **Världar:** 941.
- **Felet:** `tests/replay-validation/bugHunt/lib/registry.js:1940`
  (`if (!(sista.aisTimestamp < kors.t))`). För AISHub-rader är aisTimestamp
  mottagningstiden, och fixen kan vara mer än en minut äldre. Positionens tid
  (`fixtid`, :549) avgör om appen kunde se passagen.
- **Rättning:** jämför `fixtid(sista) < kors.t`. Jest-fallet "[vakt] värld 941"
  (j-kampanj-register.test.js:397–401) byggde på samma misstag och blir ett
  träfffall. Ett nytt vaktfall flyttar fixen efter korsningen och ska ge
  KANDIDAT. BUGGJAKT §7 rad 27 och "Följder" (motexemplet 941) bör rättas.
- **Skiss:** `S/varv2/tB/skiss-M2-tyst-over-korsningen-fixtid.diff`. Med den ger
  `--repro` för w941 BORTA (DESIGN U17), och de 26 jest-sviterna är gröna.
- **Risk:** bara motorn. Andra U17/K-NÄSTA-fall med AISHub-rader som mottagits
  efter korsningen kan flytta från KANDIDAT till DESIGN eller KÄND_ÖPPEN. Den
  uppsättningen har samma premiss som 941, och ny körning bör räkna dem.

### M3 · TÄCKT (U17) · gemensam RECOVER
- **Världar:** 972 (F07 och dess minsta repro).
- **Rotorsak i appen:** två tysta båtar som släpps i samma utvärdering ur samma
  händelse binds till en ny händelse (`_bindLooseArms` → `_openEvent`,
  BridgeOpeningService.js:1868–1874). Ledaren är den närmaste på rått avstånd
  (`_leadOf`, :2761), och båda är U17-båtar.
- **Varför predikatet inte träffade:** villkor (2) kräver att varningen leds av
  fyndets båt (registry.js:1927).
- **Registerpost (utvidgning av villkor (2) i U17 och K-NÄSTA):** W får ledas av
  en annan båt L om hon är medlem i W, om hennes och L:s senaste absorption vid
  bron före W gällde samma händelse, och om ingen av dem hade en egen rad mellan
  den absorptionen och W. Då kan ingen färsk prognos ha seedat W.
  - *Källa:* BridgeOpeningService.js#_bindLooseArms, #_leadOf och
    #_releaseStrandedArms; U17.
- **Skiss:** `S/varv2/tB/skiss-M3-gemensam-recover.diff`. Med den ger w972 och
  F07:s representant BORTA (DESIGN U17). Jest-fallet "[vakt] värld 972" blir ett
  träfffall, och ett nytt vaktfall ("ledaren hördes efter absorptionen" ger
  KANDIDAT) är tillagt. Alla 26 sviter är gröna.
- **Risk:** bara motorn.

### M4 · MÄTGRÄNS · tyst köande båt vid en tidigare bro
- **Värld:** 625 (DAGNY, norrut, kö vid Järnvägsbron 520 m före Stridsbergsbron).
- **Mekanism:** spärren vid en tidigare bro (BridgeOpeningService.js:1302–1316)
  håller varningen för Stridsbergsbron så länge hon köar vid Järnvägsbron. Med en
  bekräftad kö släpper spärren i tystnad efter `STALE_ETA_SOFT_MS`, och då går
  reservvarningen (:397; ARCHITECTURE.md:858–873, regel (3)).
- **Siffrorna:**
  - sista fix 09:32:49,4: still i kön, sog 0;
  - avgång 09:32:53,0 (+3,6 s);
  - korsning av Järnvägsbron 09:35:32,4 och av Stridsbergsbron 09:36:55,8
    (+246 s);
  - nästa fix 09:44:28,5 (+699 s);
  - W 09:37:49,4 (+300,0 s).

  För 60 s ledtid hade appen behövt varna senast 09:35:56, alltså 187 s efter en
  fix som visade henne still i kön och utan någon ny data. Det går bara genom att
  varna varje tyst köare vid Järnvägsbron inom 3 min, och köerna där är långa
  (BUGGJAKT §4.4: p50 15 min, p90 39 min).
- **Modellgränsen:** tystnaden på 11,6 min kommer av R1-modellen. Kadensen dras
  ur tillståndet vid fixen, så hon fick stillakadensen fast hon startade 3,6 s
  senare (radio.js, `interval(feed, moving)`; BUGGJAKT §4.5: "en verklig
  transponder byter takt direkt"). En klass B-sändare byter till 30 s när
  farten passerar 2 kn. Världen reproducerar inte i R0 (`kort/r0-w625.txt`).
- **Förslag:**
  - *Motorn:* byt kadensregim när rörelsetillståndet byts (v1.1).
  - *Till dess, en registerpost MÄTGRÄNS-R1-STILLAKADENS-VID-KÖAVGÅNG*
    (T3 VARNING-EFTER-SANN-PASSAGE och T2 ÖPPNING-MISS:OKLASSAD). Predikatet:
    - W leds av henne, avfyras av ticken och kommer sista fixtid +
      `STALE_ETA_SOFT_MS` (± en tick);
    - hennes sista rad före W är still (v = 0 i L0) i en kö (L0-stopp `queue`)
      vid en annan bro än W:s;
    - L0-kön slutar efter den raden;
    - hon har ingen rad mellan köns slut och korsningen.

    Källa: BUGGJAKT §4.5, BridgeOpeningService.js#_refreshArm (earlierBridgeUntilMs),
    ARCHITECTURE.md:858–873.
- **Risk:** ingen app- eller facitrisk.

### B01 · MOTORFEL · kajpredikatet binds inte till textens bärare
- **Felet:** `registry.js:1023–1046` (`mooringCapsuleStationary`) itererar över
  alla båtar och godtar den första som ligger still ≥ 3 min i en kapsel > 600 m
  från bron, även en kajliggare som aldrig hade målbro.
- **Rättning:** spegla zonregeln (VesselDataService.js:3623–3690). Båten ska:
  - ha rörelsebevis före stillheten (`MOVEMENT_PROOF_SOG_KN`);
  - inte ha navStatus 1 eller 5;
  - vara demoterad just när episoden börjar, alltså högst en tick efter den rad
    där stilltiden nått 3 min (eller zonens `queueGraceMs` när kapseln ligger
    ≤ 600 m från bron, parameter `medGrace`).
- **Skiss:** `S/varv2/tB/skiss-B01-kajpredikat.diff`.
  - B01:s minsta repro och värld 138 ger DESIGN via U1-C11.
  - Ett eget scenario, norrut stopp 6 min i Kajen (`kort/kajB`), ger fortfarande
    KONFLIKT D1-KAJZON-DEMOTION för en äkta flash på 240 s.
  - registry.test.js-fallet är uppdaterat med vaktfall för en kajliggare utan
    rörelsebevis, navStatus 5 och fel tidpunkt. Alla 26 sviter är gröna.
- **Risk:** bara motorn. Posten används i dag 1 gång, och det var den felaktiga.

### Alla skisser tillsammans
M1, M2, M3 och B01 appliceras rent på c14938f, både var för sig och
tillsammans. Med alla fyra är motorns 26 sviter gröna (371 test).
- `--repro` ger BORTA för F06 (1973), F06/r2 (1704), F07 (972), F07/r2 (479) och
  B01.
- Standardens sanningsspår (`hunt/alla`) mot `slut-standard` byter exakt 13
  registerutfall och inga andra:
  - F06: 9 av 10 fynd blir U17 eller K-NÄSTA, och kvar är bara 625:2 (DAGNY, M4);
  - F07: båda fynden blir U17, så kortet försvinner;
  - B01: världen blir U1-C11, och D1-KAJZON-DEMOTION används 0 gånger;
  - F02: 790 blir K-NÄSTA, och kortet har 8 världar kvar.
- Worktree är återställd efter varje prov (`git status`: bara node_modules).

### Hänvisningar till andra kort (T-A)
- **313 i F02 (T2 LEDTID<60s) är kajfrågan.** SALTIS 265128436 köar 60 min i Kajens
  kapsel vid Klaffbron. Hon demoteras 09:48:34 (zonregeln, 18 min still), och
  armen dör 10:14:20 (stale). Vid avgången kommer en ny varning
  (`OPENING_QUAY_DEPARTURE`, app.js:1535) 10:27:49, 32 s före korsningen
  10:28:21. Varv 1 sorterade 313 som "utan täckning och vändning".
- **510 och 625 i F05 (T2 OKLASSAD)** är samma apphändelser som M1:510 och M4 ovan.

## Kajfrågan för ägaren

**Vad som händer.** Strax norr om Klaffbron, 190–300 meter från bron, finns en kaj.
Appen har en regel för den: en båt som ligger stilla där räknas som förtöjd, alltså
parkerad, och tas bort ur brotexten. För att inte ta bort båtar som bara väntar på
att Klaffbron ska öppna får en båt som är på väg mot Klaffbron ligga stilla där i
15 minuter innan regeln slår till.

Köerna vid Klaffbron är ofta längre än så. När 15 minuter har gått försvinner den
väntande båten. Texten säger "Inga båtar är i närheten av Klaffbron eller
Stridsbergsbron", fast en båt ligger och väntar 250 meter från bron. När hon sedan
kör vidare dyker hon upp igen, och appen skickar en ny öppningsvarning. Ibland kommer
den varningen bara en halv minut innan båten passerar.

Buggjägaren hittade det här i 9 av sina 2 000 provvärldar. Texten visade "Inga
båtar" i 6–53 minuter medan en båt väntade, sammanlagt cirka 150 minuter. I en
värld (313) kom den nya varningen 32 sekunder före passagen. Samma båt som köar en
bit bort från kajen står kvar i texten hela väntan.

**Varför det krockar.** Du beslutade 2026-06-03 (D1) att en båt som står still
eller väntar inom 500 meter från sin målbro ska stå kvar i texten som "på väg mot
Klaffbron". Kajregeln bryter mot det efter 15 minuter. Den skrevs 2026-07-02 för
att båtar som faktiskt lägger till vid kajen inte ska visas som "på väg" i timmar.

Kortet som buggjägaren visade (värld 138) var inte det här fallet. Där försvann en
båt som slutat sända i 20 minuter, enligt ett tidigare beslut (U1/C11), och
buggjägarens kajregel pekade ut fel båt. Det rättas i buggjägaren. Fallet med
3 minuter och mer än 600 meter, alltså en båt som stannar vid kajen på väg norrut
mot Stridsbergsbron, krockar inte med D1. Hon är då mer än 500 meter från sin
målbro, och utanför kajen tas hon bort ännu snabbare (efter 90 sekunder) av en
annan regel.

**Alternativ.**
- **A. Behåll som i dag (15 minuter).** En båt som köar länge vid kajen försvinner
  ur texten efter 15 minuter och får en ny, ibland mycket sen, varning när hon går.
  En båt som verkligen lägger till vid kajen försvinner efter 15 minuter.
  - Risk: du tror att ingen båt väntar vid Klaffbron, och den andra varningen
    kommer för sent att hinna göra nytta.
- **B. En väntande båt står kvar.** En båt som kom in mot Klaffbron, stannade vid
  kajen och fortsätter sända står kvar som "på väg mot Klaffbron" tills hon kör
  vidare. Hon tas bort först om hon sänder status "förtöjd" eller ligger stilla i
  mer än 2 timmar, appens befintliga reservgräns. Ingen extra varning, och samma
  beteende som för en båt som köar en bit från kajen.
  - Risk: en båt som faktiskt lägger till vid kajen utan att sända status
    "förtöjd" (vanligt för småbåtar) visas som "på väg mot Klaffbron" i upp till
    2 timmar. Det är ett falsklarm i texten, men ingen extra öppningsvarning.
- **C. Längre väntetid vid kajen, till exempel 40 minuter** (ungefär hur länge 9 av
  10 köer varar). De flesta köer klaras.
  - Risk: en båt som lägger till visas som "på väg" i upp till 40 minuter, och de
    längsta köerna (cirka 1 av 10) beter sig som i dag.

**Rekommendation: B.** Att dölja en båt som väntar vid bron, och sedan varna 30
sekunder före passagen, är en missad öppning i praktiken. Ett "på väg mot
Klaffbron" för en båt som har lagt till är ett falsklarm. Produktprincipen säger
att det första är värre.

B stämmer också med ditt beslut D1 och med hur appen redan behandlar köer
utanför kajen.

**Vad fältdatan säger.** De 24 låsta inspelningarna omfattar 482 timmar
(`S/varv2/tB/bank/*.kaj.txt`). Kajregeln vid Kajen slog till 7 gånger för 5
båtar, men aldrig för en båt på väg mot Klaffbron:
- **ELFKUNGEN och SUSANNE** kom norrut efter Klaffbron, och kajregeln tog deras
  mål Stridsbergsbron. Det är fallet med 3 minuter och mer än 600 meter.
  SUSANNE (2026-09-17) låg vid kajen i 67 minuter, alltså verkligen förtöjd.
  Appen tog bort henne efter 2 och 5,5 minuter. Det är rätt, och alternativ B och
  C ändrar inte det, eftersom hon hade passerat Klaffbron.
- **De övriga** hade ingen målbro. ATHENA (2026-07-12) lämnade kajen och varnades
  som en ny ankomst.
- **Alla tio demotioner i banken där målet var Klaffbron** kom från Gästhamnen.
  Den ligger utanför väntzonen och är avsedd för just det.

Ändringen flyttar alltså inget låst facit. Banken visar inte heller att köfallet
förekommer i verkligheten; det syns hittills bara i buggjägarens provvärldar,
vars köer är tagna ur fältets köplatser. Bygg B med ett regressionstest av
scenariot (en köare 250 m från Klaffbron i 25 minuter). Visar ett kommande
fältprov att båtar på väg söderut ofta lägger till vid kajen utan att sända
"förtöjd", är C mellanvägen.
