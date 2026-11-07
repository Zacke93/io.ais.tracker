# K2 — facitförflyttningar (U13), revision 3

Prototyp: commit `d7a8022` (kodändringen) och `afce797` (en kommentar) i
`K2/wt`, ovanpå `5e273df`, bas 7699cbe.
Underlag: `K2/tmp/rev4/`.

## Låsta facit: ingen förflyttning

`npm run replay:all`: exit 0, alla 24 låsta korpusar matchar facit. Det
betyder oförändrat i alla låsta dimensioner: notisantal, (mmsi,bro)- och
(mmsi,bro,riktning)-multiset, golden-text, golden-events (11 korpusar, där
öppningsvarningarna låses byte för byte) och `opening-distribution.json`.
Ingen omlåsning behövs, och ingen not i `corpora.js` ändras.

`npm run replay:openings`: exit 0, O1 376/378, samma utskrift som revision 2.
Mot 7699cbe ändras bara O2 i 13h (8 → 9 bekräftade ≤ 20 min, GARANTIPRIS
118 → 117) och tiderna för JOSEPHINE (0525) och CARAT (17h), båda ACCEPTERAD
i båda versionerna.

Alla 24 korpusar mot 7699cbe vid δ = 0 (`tmp/rev4/cmpall-base.log`):
notiser, målbropassager och brotextövergångar identiska i alla 24,
öppningsvarningar identiska i 21. Exakt samma tre tidsbyten som i revision 2,
alltså ingen bankändring alls mellan `5e273df` och `d7a8022`. Revisionens tre
ändringar (returminnet, inget golv, villkor (b)) rör bara returresor, och
banken har ingen retur som de påverkar.

## Informativa förflyttningar (olåsta dimensioner, oförändrade sedan revision 2)

Ingen av korpusarna har golden-events. Raderna är ändå bedömda mot rådata,
eftersom U13 kräver det för varje ändrat utfall. Gemensam mekanism (F09): en
båt som hölls vid en tidigare bro när en annan båts varning gick ut släpptes
i 7699cbe av en tick innan hennes nästa fix. Nu väntar släppet på hennes fix,
fixet visade en tät konvoj, och konvojundantaget behåller henne i varningen.
Hennes egen varning kommer sedan via RECOVER-släppet (familj K, U17) när
konvojtäckningen löper ut.

| Korpus | Vad ändras | Rådatabelägg | Bedömning |
|---|---|---|---|
| 20260710-13h | Öppning: PILOT 761 (265606970), Klaffbron söderut. Andra varningen 11:54:15.566 (#20) → 12:09:08.761 (#21). Absorberad i VIRGOs #19 vid sitt fix 11:45:39.622. Gäller i alla 45 faser. | gt-passages: PILOT 12:22:15.333 (linje, 60 s glapp), VIRGO 12:21:35.445 (linje), 40 s isär, alltså samma öppning, som redan varnades av #19 11:45:06.772. Två varningar för öppningen i båda versionerna. Ledtid 28,0 → 13,1 min; O2 8 → 9 bekräftade ≤ 20 min. | **Likvärdig** (samma antal; varningen närmare passagen) |
| 20260804-17h | Öppning: CARAT (211452170), Klaffbron söderut, #33 14:13:54.846 → 14:06:29.249. Spärren medan hon var absorberad i #28 räknas, så PAPOUs #32 täcker henne inte efter RECOVER. | CARAT korsade Stridsbergsbron 13:56:07.544 och Järnvägsbron 13:59:10.732 men har ingen Klaffbronkorsning (PAPOU 14:14:40.795, ORCA 14:17:03.552). Fantom i båda; O2 ACCEPTERAD i båda. | **Likvärdig** (samma fantom, annan tid) |
| 20260525 | Öppning: JOSEPHINE (244870852), Klaffbron söderut, #10 09:55:43.440 → 10:06:05.877. Absorberad i MARIANNEs #9 vid sitt fix 09:46:43.931. | Klaffbronkorsningar i gt-passages: NORDIC SOLA 01:36:47, DIANA 05:25:16, AURANA 07:40:11, ORANESS 15:14:28. Varken JOSEPHINE eller MARIANNE korsade. Fantom i båda; O2 ACCEPTERAD i båda (d 1043 m → 470 m). | **Likvärdig** (samma fantom, annan tid) |

## Syntetiska scenarier (inget låst facit)

`npm run replay:synthetic`: exit 0, 47 scenarier rena. Tre B02-scenarier
kräver nu `openingBeforeEachPassage`. Med den kontrollen är alla tre röda på
7699cbe, och inga andra (`tmp/rev4/synth-base-skarpt.log`).

| Scenario | 7699cbe | Nu | Belägg | Bedömning |
|---|---|---|---|---|
| u-sväng-efter-Klaffbron | 1 öppning; returen söderut 06:30:00 absorberad i utresans händelse | 2 öppningar; egen varning söderut 06:26:00 | rött på 7699cbe: "OVARNAD PASSAGE av Klaffbron 06:30:00 (901000018)" | **Rättare** (U15) |
| u-sväng-gles-ais-norr-om-Klaffbron | 2 öppningar; returen 06:27:00 absorberad | 3 öppningar; egen varning söderut 06:24:00 | rött på 7699cbe: "OVARNAD PASSAGE av Klaffbron 06:27:00 (901000091)" | **Rättare** (U15) |
| u-sväng-bortom-Stridsbergsbron (B02-returresan) | 3 öppningar; returen 06:31:00 absorberad i utresans händelse | 4 öppningar; egen varning söderut 06:28:00 | rött på 7699cbe: "OVARNAD PASSAGE av Stridsbergsbron 06:31:00 (901000093)" | **Rättare** (U15) |

Tiderna kommer ur sonden `tmp/rev4/synthsond/usvang.js`, körd i båda träden.
De två första scenarierna ändrades redan i revision 2 men redovisades inte då
(omgranskningen 2026-11-05).

## Golvfallen: U15 utan golvundantag (dirigentens beslut 2026-11-05)

Banken har inget golvfall (identisk med revision 2). I buggjägarens världar
finns tolv: fyra i standardkörningen och åtta instanser i quick, där värld
227 finns i båda. I varje fall låg returens förväntade ankomst närmare än
60 s när returarmen skapades. Med golvet stod den gamla täckningen kvar, alltså
en händelse för öppningen hon redan passerat. Nu får returen egen varning.
Tabellen visar varje fall med returkorsningen ur världens L0 och alla andra
korsningar och varningar vid bron i närheten (`tmp/rev4/golvquick.txt`,
`tmp/rev4/scripts/golvvarld.js`).

| Värld | Retur (L0) | Ny egen varning | Andra varningar och korsningar nära returen | Motorns dom | Bedömning |
|---|---|---|---|---|---|
| 936 R1, Klaffbron (XENIA 265664174) | norr 07:00:47, 553 s efter utresan | #9 07:00:01, 46 s före | ALVA korsade 06:50:20 (627 s före returen), varnad 06:43:23; ingen annan varning för returens lyft | T2 OKLASSAD (miss) → T2 LEDTID<60s, KÄND_ÖPPEN J13-J14 | **Rättare** (miss → varning före korsningen) |
| 1918 R1, Stridsbergsbron (GUNHILD 265251208) | söder 09:12:55, 422 s efter utresan | #9 09:12:46, 9 s före | ingen annan sydgående korsning efter 08:52:38 | T2 OKLASSAD (miss) → T2 LEDTID<60s, KANDIDAT | **Rättare** (miss → varning före korsningen, men för sent för att hjälpa) |
| B01-kortets värld, Klaffbron (WILMA 265178387) | norr 01:59:54, 224 s efter utresan | #3 01:59:40, 14 s före | inga andra båtar vid bron | ny T2 LEDTID<60s, ACCEPTERAD | **Rättare** (U15: egen varning i stället för utresans) |
| 227 R1, Stridsbergsbron (ZELDA 265533681) | norr 11:33:20, 879 s efter utresan | #4 11:33:30, **10 s efter** | inga andra nordgående korsningar | T2 OKLASSAD kvar (som förut) + ny T3 VARNING-EFTER-SANN-PASSAGE, KANDIDAT | **Sämre i T3** (ett sent kort), likvärdig i missen. Se konflikten nedan |
| quick 40 R1, Klaffbron (265090307) | söder 12:55:19 | 12:54:43, 36 s före | inga andra båtar | ny T2 LEDTID, ACCEPTERAD | **Rättare** (U15) |
| quick 140 R0, Klaffbron (265598888) | söder 04:20:30 | 04:19:37, 53 s före | andra sydgående korsningar en timme tidigare | ny T2 LEDTID, ACCEPTERAD | **Rättare** (U15) |
| quick 152 R0, Klaffbron (265742159) | söder 02:57:35 | 02:56:50, 45 s före | 042 norrut 03:07:29 har egen varning 02:56:52 som förut (594 s efter returen, 869 s efter klustrets första passage, alltså en annan öppning enligt dig9) | ny T2 LEDTID, ACCEPTERAD | **Rättare** (U15) |
| quick 161 R0, Klaffbron (265271547) | söder 15:03:40 | 15:03:32, 8 s före | 507 söderut 15:17:58, egen varning 15:11:23 som förut | ny T2 LEDTID, ACCEPTERAD | **Rättare** (U15) |
| quick 289 R1, Stridsbergsbron (265698589) | norr 12:33:30 | 12:32:51, 39 s före, blandad händelse med 504 som medlem | 504 söderut 12:38:42: hennes egna varning 12:33:47 försvinner och hon täcks av samma varning 12:32:51 (56 s mer ledtid). Antalet varningar är oförändrat (4) | ny T2 LEDTID, KÄND_ÖPPEN U2-VS-DEADLINE | **Rättare** (en varning för två båtar i samma lyft) |
| quick 272 R1, Klaffbron (265220295) | söder 13:52:14, 508 s efter utresan | 13:51:30, 44 s före | 258 söderut 13:44:23 (37 s efter hennes utresa, alltså utresans lyft) | ny T2 LEDTID, KÄND_ÖPPEN J13-J14 | **Rättare** (U15) |
| quick 212 R0, Klaffbron (265817494) | söder 11:56:37, 266 s efter utresan | 11:55:42, 55 s före | 872/781/691 söderut 11:51:58–11:52:11, i utresans lyft och varnade 11:44:00/11:46:35 | ny T2 LEDTID, KÄND_ÖPPEN U2-VS-DEADLINE | **Rättare** (U15) |
| quick 227 R1 | som standard 227 | | | ny T3 VARNING-EFTER-SANN-PASSAGE, KANDIDAT (F01-klustret i quick) | **Sämre i T3**, som ovan |

**Dubbla varningar för samma öppning:** inga belagda. I alla tolv fall gäller
den nya varningen returens egen korsning, och ingen annan båt korsar i
returens lyft med en egen varning. Det enda sättet att se returvarningen som
en dubblett är dig9:s kluster: returen ligger inom 600 s från hennes utresa
(och i 212 och 272 från andra båtars korsningar i utresans lyft). Just det
fallet beslutar U15 uttryckligen ("även inom konvojfönstret på 600 s"), så
det är ingen konflikt med U15.

**Konflikten som finns (värld 227):** returen upptäcks först 9 s efter den
verkliga korsningen, eftersom Fix D kräver två positioner (U18). Utan golvet
kommer hennes egen varning då efter korsningen, och motorn ger ett T3-utslag.
Inom U15 finns ingen annan väg: varje varning vid armens skapande kommer
efter korsningen, och att låta den gamla händelsen täcka returen är just det
U15 förbjuder. Öppningen var missad även med golvet (T2 OKLASSAD i båda).
Utslaget är föreslaget som registerpost med källa U18 och dirigentens beslut
(se DESIGN.md §6). I K+K2 tar K:s korsningsankargolv inte bort det, eftersom
returspärren redan har släppt hennes gamla händelse.

## Förkastade varianter (redovisas för spårbarhet)

En sämre rad är ett designfel enligt U13. Varianterna nedan prövades i
revision 2 och förkastades.

| Variant | Korpus eller värld | Ändring | Rådata eller motor | Bedömning |
|---|---|---|---|---|
| Konvojen avgörs vid hennes nästa fix (grind) | 20260702-19h | +1 varning: ZWERK (244100668), Klaffbron söderut 08:31:00.550. Spärren löpte ut i tystnad före nästa fix, och villkor (3) släppte CAVAs #13 | ZWERK korsade 08:35:13.386, CAVA (265083540) 08:35:45.291, 32 s isär, samma öppning ⇒ dubblett (U2) | **Sämre** ⇒ förkastad |
| (samma) | 20260707-14h | AKIRA (257605080), Klaffbron norrut: egen varning 08:24:47.964 → 08:06:43.884 | Båda korsningarna är **inferrerade** i gt-passages: AKIRA 1411 s glapp, fönster 08:13:39.974–08:37:10.640; GRETA (#2:s ledare) 1106 s glapp, fönster 08:08:07.749–08:26:33.556. Fönstren överlappar, så ordningen mellan dem är inte mätt. Belagt är bara att variantens varning 08:06:43 ligger före AKIRA:s fönster, medan 7699cbe:s varning 08:24:47 ligger inuti det (O1b TIDPUNKT_OKÄND) | Rättare (enbart på O1b-fönstret) |
| (samma) | 20260804-17h | CARAT #33 → 13:47:30.060 | fantom (se ovan) | Likvärdig |
| Som ovan, plus konvojbeviset från varningsögonblicket när spärren löper ut | banken | 19h och 2h som 7699cbe; 14h AKIRA 08:06:43.884 (rättare enbart på O1b-fönstret, se ovan); 0525, 13h, 17h som i tabellen ovan | tio låsta test i `opening-shared-queue-convoy.test.js` (LIV/JOHANNA 2026-09-27) röda | Rättare i banken men bryter låst fältbeteende ⇒ förkastad |
| Konvojen avgörs när varningen går ut, färskhet `<=` | 20260702-2h | ELFKUNGEN (265573130), Klaffbron söderut: egen varning 12:13:30.246 (#6) → absorberad i PAX #5 12:12:49.134 och RECOVER-varning 12:26:12.664 (#7) | ELFKUNGEN 12:33:53.129, PAX 12:34:07.347, 14 s isär, samma öppning; två varningar i båda. Konvojbeviset var PAX exakt 5 min gamla position, med båtarna på varsin sida om Stridsbergsbron | Likvärdig i antal, fel mekanism ⇒ förkastad |
| Konvojen avgörs när varningen går ut, färskhet `<` | banken / quick | banken som slutversionen; quick: 3 nya instanser i värld 276 (R1) | T2 JOLLY 265912288: sann korsning 13:21:48 utan förvarning; T3: hennes RECOVER-varning 43 s efter korsningen; T2 WILMA 265912437 14:04:15. 7699cbe och nu: 0 utslag i världen | **Sämre** ⇒ förkastad |
| F09 v1: kräv alltid ett eget fix efter varningen | 20260601-41h | Klaffbron söderut 5 → 4: PALOMA (265682580) absorberad i AIRs reservvarning 08:28:43 i stället för egen varning 08:30:14 | AIR korsade 08:41:02.920 (linje), PALOMA inferrerad 08:40:10 med 955 s glapp; O1 blev röd (OKLASSAD MISS) | Sämre ⇒ förkastad |
| (samma) | 20260804-17h | Klaffbron söderut 14 → 13: BOBLEN (219036470) absorberad i PACIFICs reservvarning 11:25:40 | BOBLEN 11:35:16.599, PACIFIC 11:36:13.701 (samma öppning) | Rättare ensam, men varianten föll på 41h |
| B02 villkor (b) som i revision 2 (varning före passagen spärras alltid) | granskarens sond `b02-senare-oppning` | A får en tredje varning för B:s senare öppning; utfallet hänger på om B:s varning gick 15 s före eller efter A:s passage | ingen rådata (sond) | Ersatt av referensankomsten (DESIGN.md §2) |
| B02 med returminnet i hennes egen händelse (revision 2) | granskarens sond `b02-936-kant` | returen utan egen varning i 2–28 av 30 faser vid returarm 732–758 s, i 30 av 30 efter 762 s | ingen rådata (sond) | Ersatt av returminnet |

## Buggjägarens världar och kort

U2-RETURRESA-klustret, 18 världar (`tmp/rev4/u2ret.txt`): **15 BORTA** (alla
nio R0, R1 191, 998, 1351, 1590 samt nu 936 och 1918) och **3 KVAR** (1208,
1316, 1317: ingen returarm före korsningen, riktningslogikens sak).
Revision 2: 13 BORTA och 5 KVAR. Nya utslag i klustret: 936 T2 LEDTID 46 s
(KÄND_ÖPPEN) och 1918 T2 LEDTID 10 s (KANDIDAT), se golvtabellen.

Alla 25 kort i r1-standard-a (`tmp/rev4/reproall.txt`): B02 och F09 BORTA;
23 KVAR. Utslagen är identiska med revision 2 utom två golvfall: B01:s värld
får T2 LEDTID 14 s (ACCEPTERAD), och F14:s värld 227 får T3 10 s efter
korsningen (KANDIDAT).

Motorns quick-profil (300 världar, banken med δ +7 och −11,52 s;
`hunt-quick/`, självtest grönt) mot r1-quick-a: inga nya kandidatkluster
(kandidatkort 17 → 16). Borta: U2-RETURRESA (värld 101 och 191), M-FAS-kortet
för 13h (quickens F06), en T2-miss (värld 130) och en U2-VS-DEADLINE-miss
(värld 116). Mot quick för 5e273df tillkommer åtta instanser, alla golvfall i
tabellen ovan: sju T2 LEDTID i registrerade klasser och T3 för värld 227 i det
befintliga F01-klustret.
