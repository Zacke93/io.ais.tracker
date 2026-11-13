# R1 – facit (andra revisionen, efter omgranskningen)

Gäller prototypen på `dea1f1d` i `K/R1/wt`. Alla jämförelser är mot `7699cbe` om inget
annat sägs.

## Låsta korpusar: inget facit flyttas

Ingen av bankens 24 låsta korpusar ändrar utfall med R1, så ingenting är omlåst.

**Belägg:**

1. `npm run replay:all` på andra revisionen (`K/R1/tmp/rev3/batt/replay-all.log`) och på
   `7699cbe` (`K/R1/tmp/batt-base/replay-all.log`) är rad för rad identiska när tiderna
   tas bort. Båda slutar med "✅ Alla låsta korpusar matchar facit". Notiser, fördelning,
   riktning, golden text och öppningar är alltså oförändrade.
2. Hela banken har körts med `REPLAY_VERBOSE=1` och varje korpus monitoringflagga
   (`K/R1/tmp/rev3/bank-new/`, skript `K/R1/tmp/rev3/scripts/bankscan.sh`):
   - 0 rader `re-crossed … in confirming segment`: N1-regeln slår aldrig till;
   - 0 rader `rörelsebevis: Fix D-väntan`: den långsamma vägen (`_slowReCrossEvidence`)
     slår aldrig till (de 2 vanliga `RE_CROSS_EVIDENCED` är oförändrade);
   - 0 rader `SKIPPED_BRIDGES_DIRECTION_LOCK_RELEASED`: svepslåset släpps aldrig, mot 64
     vanliga svepslås;
   - 6 bekräftade reversaler (fem i 20260804-both-21h, en i 20260806-42h), ingen med en
     återkorsad bro bakom sig, och 13 Fix D-väntor.
3. `npm run replay:openings` är identisk med `7699cbe`. `npm run replay:phase` är grönt
   både med och utan `REPLAY_MONITORING=1` (24 korpusar, 168 replayer).
4. Motorns bankspår och S-KALIBRERING i quick-körningen är identiska med `r1-quick-a`.

## Utanför låst facit: buggjägarens syntetiska världar

Raderna nedan är inget låst facit. Jag redovisar dem enligt U13:s princip. Rådatan är
världens sanning (L0 ur generatorn). Notistider gäller appens notis; passager gäller
appens `targetPassages` och `intermediatePassages`.

**Källa per rad:** "hel värld" är den återskapade världen (`K/R1/tmp/worlds/w<nr>-R1.jsonl`,
radhasharna stämmer mot motorns körning), "minsta repro" är kortets `repro.jsonl`.

Andra revisionen ger exakt samma notiser, passager och öppningsvarningar som första
revisionen i alla 26 körda världar (`K/R1/tmp/rev3/worlds-new/` mot
`K/R1/tmp/rev2/worlds-new/`, `K/R1/tmp/rev3/worlds-cmp-9ea8.txt`), så raderna gäller
båda. Brotexten jämfördes för sig mot `7699cbe` (`K/R1/tmp/rev3/bt-bas-mot-ny.txt`).

| värld (källa) | fartyg | dimension | ändring mot 7699cbe | rådatabelägg (L0) | bedömning |
|---|---|---|---|---|---|
| 188 (hel värld) | 265806662 ZELDA | passage | + Klaffbron mellanbro 14:54:48 | korsar Klaffbron söderut 14:51:24 efter U-sväng 14:45:55 | rättare |
| 353 (hel värld) | 265196010 HAVSORN | passage | + Klaffbron mellanbro 09:26:09 | korsar Klaffbron söderut 09:23:15 efter U-sväng 09:17:47 | rättare |
| 523 (hel värld) | 265232445 | passage | + Klaffbron mellanbro 15:39:24 | korsar Klaffbron söderut 15:38:25 efter U-sväng 15:35:16 | rättare |
| 750 (hel värld) | 265739417 GUNHILD | passage | + Klaffbron mellanbro 09:11:44 | korsar Klaffbron söderut 09:10:01 efter U-sväng 09:07:45 | rättare |
| 892 (hel värld) | 265133806 | passage | + Klaffbron mellanbro 16:48:19 | korsar Klaffbron söderut 16:44:59 efter U-sväng 16:39:35 | rättare |
| 1044 (hel värld) | 265901498 | passage | + Klaffbron mellanbro 09:30:40 | korsar Klaffbron söderut 09:30:07 efter U-sväng 09:27:10 | rättare |
| 1558 (hel värld) | 265902319 | passage | + Klaffbron mellanbro 13:07:55 | korsar Klaffbron söderut 13:07:14 efter U-sväng 13:01:37 | rättare |
| 1680 (hel värld) | 265670027 | passage | + Klaffbron mellanbro 13:03:20 | korsar Klaffbron söderut 13:02:42 efter U-sväng 12:59:24 | rättare |
| 1731 (hel värld) | 265781143 KAJSA | passage | + Järnvägsbron och Stridsbergsbron mellanbro 11:05:53, i färdordning | korsar Järnvägsbron norrut 11:03:12 och Stridsbergsbron norrut 11:04:57 | rättare |
| 1731 (hel värld) | 265781143 KAJSA | notis | Stridsbergsbron norrut: "närmar sig, ankomst om 2 min" 11:06:36 → passerad form 11:05:53 | korsningen 11:04:57 låg före båda notistiderna; fixen 11:05:53 ligger 163 m från bron, norr om den | rättare |
| 1927 (hel värld) | 265431281 | passage | + Klaffbron mellanbro 13:23:34 | korsar Klaffbron söderut 13:20:48 efter U-sväng 13:16:59 | rättare |
| 1953 (hel värld) | 265603684 IRMA | passage | + Klaffbron mellanbro 02:53:16 | korsar Klaffbron söderut 02:52:27 efter U-sväng 02:47:45 | rättare |
| 1953 (hel värld) | 265603684 IRMA | notis | + Klaffbron söderut, passerad form, 02:53:16, 99 m från bron (söder om den) | returpassagen 02:52:27. Den enda tidigare Klaffbronotisen, 02:46:59 "passerade Klaffbron under AIS-tystnad" norrut, gällde utresan, som korsade bron 02:41:16 | rättare (U14) |
| 18 (hel värld) | 265731767 ALVA | passage | + Klaffbron mellanbro 11:54:01 | korsar Klaffbron söderut 11:46:35 efter U-sväng 11:41:34 | rättare |
| 134 (hel värld) | 265119890 ULLA | passage | + Järnvägsbron och Stridsbergsbron mellanbro 11:57:01 | korsar Järnvägsbron norrut 11:49:53 och Stridsbergsbron norrut 11:51:17 efter U-sväng 11:45:15 | rättare |
| 227 (hel värld) | 265533681 ZELDA | passage | + Järnvägsbron mellanbro 11:33:29 | korsar Järnvägsbron norrut 11:31:33 efter U-sväng 11:25:14 | rättare |
| 451 (hel värld) | 265899297 IRMA | riktning | Olidebron "har precis passerat" 12:12:07: northbound → southbound | korsar Olidebron söderut 12:11:17; alla fixar 12:05:13–12:12:07 har kurs 193–208° | rättare |
| 451 (hel värld) | 265899297 IRMA | riktning och notis | Kanalinfarten 12:17:51: northbound "ankomst om 1 min" → southbound, passerad form | sydgående hela vägen; båten ligger 72 m söder om punkten (58.26735 mot 58.26800) vid notisen | rättare |
| 451 (minsta repro, testets fixtur) | 265899297 IRMA | riktning och notis | samma två ändringar 12:11:57 och 12:17:41 (fixen 58.26749) | samma L0 | rättare |
| 18, 134, 750, 1558, 1927 (hela världar) | returens fartyg | brotext | En övergång kommer 30 s tidigare med samma text: 18 11:54:31 → 11:54:01 och 134 11:57:31 → 11:57:01 ("Inga båtar är i närheten …"), 750 09:12:14 → 09:11:44, 1558 13:08:25 → 13:07:55 och 1927 13:24:04 → 13:23:34. Den bokförda returen ger statusbytet approaching → passed och en kritisk UI-uppdatering i vändningsticken; förut kom texten vid nästa halvminutstick | övergången ligger på returfartygets egen fix (vändningsfixen i tabellen i DESIGN.md §4), efter den sanna korsningen; texten är densamma och beskriver läget vid fixen | likvärdig |

**Inga sämre rader.** Inga öppningsvarningar flyttas i någon av de 26 körda världarna, och
inga invarianter (fatala eller WARN) ändras. De övriga 21 världarna har identisk brotext.

## Granskarnas varianter och de nya fixturerna (ej låsta)

| fixtur | ändring mot 7699cbe | belägg | bedömning |
|---|---|---|---|
| `r1-f10-havsorn-langsam-aterkorsning.jsonl` (första granskningens variant av F10) | + Klaffbron mellanbro 09:24:00 och notisen "har precis passerat Klaffbron" söderut 09:24:00 i passerad form | fixet 09:24:00 ligger 150 m söder om bron i 1,5 kn; förra fixet 09:18:24 låg 630 m norr om den och satte väntan söderut i 3,1 kn (väntan på startfixet, nettofart 4,5 kn); oförändrat i andra revisionen | rättare |
| `r1-f15b-irma-svepnotis.jsonl` | svepets notis "passerade Olidebron under AIS-tystnad" 12:05:03 behåller northbound; + "har precis passerat Olidebron" söderut 12:11:57; Kanalinfarten 12:17:41 northbound "ankomst om 1 min" → southbound passerad form | sista fix före glappet 58.26905 (söder om Olidebron 58.27274, nordgående), återfödd 58.28003: glappassagen gick norrut. Returen söderut över Olidebron ligger mellan fixarna 12:07:36 och 12:11:57 | rättare (U14 för returnotisen) |
| `r1-f15c-irma-kurs290.jsonl` | som f15b. Första prototypen gav svepets notis `unknown`; revisionerna ger northbound | som ovan | rättare |
| `r1-omgr-aquila-gps-sprang.jsonl` (omgranskningens AQUILA, verklig väntan i 20260601-41h och en inlagd outlier) | ingen: notiser, passager, varningar och brotext identiska med `7699cbe`. Mot `9ea8de8`: den falska vändningen norrut, Stridsbergsbron som mellanbro 13:42:40 och "Inga båtar" 13:42:40–13:54:07 försvinner | AQUILA passerade Stridsbergsbron söderut 13:14:51 (gt-passages) och låg sedan 51–89 m söder om bron i 0–0,1 kn; outliern 13:42:40 har 0,1 kn och väntan sattes 13:37:08, två fixar före segmentets start | likvärdig (mot `9ea8de8`: rättare) |
| `r1-omgr-vantlage-sprang.jsonl` (omgranskningens syntetiska väntläge) | ingen: identisk med `7699cbe`. Mot `9ea8de8`: den falska vändningen söderut, Klaffbron#4 söderut 10:35:58 och Stridsbergsbron som mellanbro försvinner; Stridsbergsbron bokförs som målbro 10:35:00 | generatorns båt ligger still 90 m norr om Järnvägsbron; språnget 10:25:00 är 174 m i 0,5 kn | likvärdig (mot `9ea8de8`: rättare) |
| `r1-omgr-vantlage-sprang-180s.jsonl` (samma med 180 s kadens och ett fix emellan) | ingen: identisk med `7699cbe`. Mot `9ea8de8`: den falska vändningen försvinner och Stridsbergsbron bokförs som målbro 10:47:00 | språnget 10:32:00 är 172 m i 0,5 kn, väntan sattes ett fix tidigare | likvärdig (mot `9ea8de8`: rättare) |
| syntetiska `u-sväng-långsam-återkorsning-efter-väntan` | + Klaffbron mellanbro 06:21:00; WARN INV-18 (ETA-stigning mot Stridsbergsbron) försvinner | generatorns vändfix 06:17:30 ligger 646 m förbi Klaffbron längs rutten i 6,5 kn; returens första sampel 06:21:00 ligger 54 m söder om Klaffbron (bron redan korsad) i 1,5 kn; segmentet är 699 m på 210 s, nettofart 6,5 kn | rättare (nytt kontrakt) |
| syntetiska `u-sväng-gles-ais-återkorsning-i-debouncen` | Klaffbron bokförs två gånger (mål 06:16, mellanbro 06:20) | vändning 592 m norr om Klaffbron, retur över bron före fixen 06:20 | rättare (första prototypen) |

De tre KÄND LUCKA-fixturerna (`r1-kand-lucka-*.jsonl`) har samma utfall i `7699cbe` och i
revisionerna; de flyttar inget.

Övriga syntetiska scenarier är oförändrade (`replay:synthetic`: 46 av 46 som förut plus
de två R1-scenarierna; utdata rad för rad som i första revisionen).

## Omlåsning

Ingen. Inget i `corpora.js`, `corpora-distribution.json`,
`corpora-direction-distribution.json`, `opening-distribution.json` eller `golden-*`
behöver låsas om.
