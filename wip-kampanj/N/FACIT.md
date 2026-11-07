# Familj N — facit som flyttas (U14, kort B01), revision 4

Rättningskampanjen 2026-11-04. Jämförelsen gäller 7699cbe mot K/N/wt (HEAD revision 4, `0be75e5`) över hela korpusbanken. Verktyg: `K/N/tmp/scripts/dumpCorpora.js` och
`cmpDumps.js` (utdata i `K/N/tmp/dump-base/` för 7699cbe, `K/N/tmp/dump-rev2/` för revision 2,
`K/N/tmp/r3/dump-rev3/` för revision 3 och `K/N/tmp/r4/dump-rev4/` för revision 4). Rådatafacit
kommer från `tests/replay-validation/gt-passages/<korpus>.json`.

## Kort och enkelt

- **Revision 4 ändrar inget facit.** Banken är notis för notis identisk med revision 3 och därmed
  med revision 2 (`cmpDumps.js r3/dump-rev3 r4/dump-rev4`: 0 ändrade rader i 24 korpusar,
  `K/N/tmp/r4/cmp-rev3-rev4.log`). Brotext, öppningar, passager och invarianter är lika.
- **Mot 7699cbe får tre låsta korpusar en notis till**, samma tre som i revision 2 och 3. Alla gäller
  ELFKUNGEN (265573130), som passerar en bro, vänder och passerar tillbaka. Rådatan visar två
  verkliga passager varje gång. Förut fick bara den första en notis.
- **Bedömning:** alla tre raderna är **rättare**. Ingen rad blir sämre.
- **U21 (dirigentens gräns 2026-11-05):** alla tre notiserna kommer inom 10 min efter korsningen
  interpolerad på glappsegmentet: 5,1, 2,1 och 1,4 min. Alla tre släpps i bokföringsticken med
  beviset `ankomstsidan` (137–1230 m ut, 4,7–8,6 kn) och får failsafens mening. Revision 4:s nya
  krav (rörelse i nuet för `gles-korsning`, två entydiga fixar för `ankomstsidan-två-fixar`,
  förtida bokföring vid linjen, failsafens torrkörning och INV-2:s skärpta dom) rör inget av dem:
  domen är fortfarande `ankomst` för alla tre (`K/N/tmp/r4/dump-rev4/`).

Omlåsningen i K/N/wt (commit `1b7a193`) är en demonstration av att allt annat blir grönt. Dirigenten
låser om på riktigt. Samlad `REGEN_DISTRIBUTIONS=1` är spärrad eftersom `20260917-7h` har
ofullständig fångst (VALIDATION.md §Facit-fällan, punkt 4). Jag skrev därför bara de tre korpusarnas
poster med `K/N/tmp/scripts/relockN.js`, som kräver att golden-text och öppningsmultiset är
oförändrade. `K/N/patch-utan-omlasning.diff` är patchen utan omlåsningsfilerna. Revision 4 rör inte
omlåsningsfilerna.

## Ändrade rader

| Korpus | Dimension | Vad som ändras | Rådatabelägg (U13) | Bedömning |
|---|---|---|---|---|
| 20260712-25h | notis | 85 → 86. Ny rad i `golden-events`: 2026-07-13 12:26:57.910, Stallbackabron, söderut, "ELFKUNGEN passerade Stallbackabron under AIS-tystnad", eta −1, already_passed, 1265 m, källa passage-fallback. `corpora-distribution.json` 265573130: Stallbackabron 1 → 2. | Nordpassage 11:22:54.583 (inferred, glapp 11:03:29.218 → 12:20:57.510, 75 → 223 m). Sydpassage 12:21:51.259 (observerad, 12:20:57.510 på 223 m norr → 12:26:57.910 på 1270 m söder). Den första notisen 11:02:29.254 ("närmar sig", 272 m) gällde nordpassagen. Släppet: appens interpolerade korsning 12:21:51.7 (rådata 12:21:51.259), notisen 5,1 min efter, 1230 m ut, 8,6 kn. | rättare |
| 20260712-25h | riktning | Ny nyckel `265573130:Stallbackabron:southbound`: 1. | Samma sydpassage, riktning syd. | rättare |
| 20260804-both-21h | notis | 151 → 152. Ny rad i `golden-events`: 2026-08-05 10:38:19.540, Klaffbron, söderut, "ELFKUNGEN passerade Klaffbron under AIS-tystnad", eta −1, already_passed, 175 m, källa passage-fallback. Fördelningen 265573130: Klaffbron 1 → 2. | Nordpassage 10:15:12.558 (observerad, 604 → 87 m). Sydpassage 10:36:35.638 (inferred, `sparse-stopped-endpoint`; 10:26:00.620 på 220 m norr → 10:37:11.435 på 12 m söder). Korsningen är säker; tiden är ett fönster. Den första notisen 10:15:46.520 ("har precis passerat", 83 m) gällde nordpassagen. Släppet: appens interpolerade korsning 10:36:15 (rådatans 10:36:35), notisen 2,1 min efter, 148 m ut, 4,7 kn. | rättare |
| 20260804-both-21h | riktning | Ny nyckel `265573130:Klaffbron:southbound`: 1. | Samma sydpassage. | rättare |
| 20260806-42h | notis | 130 → 131. Ny rad i `golden-events`: 2026-08-07 10:39:41.258, Klaffbron, söderut, "ELFKUNGEN passerade Klaffbron under AIS-tystnad", eta −1, already_passed, 165 m, källa passage-fallback. Fördelningen 265573130: Klaffbron 3 → 4. | Nordpassage 2026-08-07 10:17:48.001 (observerad, 10:16:07.031 på 240 m → 10:18:20.844 på 78 m). Sydpassage 10:38:34.189 (observerad, 10:37:28.169 på 136 m norr → 10:38:35.937 på 4 m söder). Den första notisen 10:16:07.031 ("närmar sig", 245 m) gällde nordpassagen. Släppet: appens interpolerade korsning 10:38:20 (rådata 10:38:34), notisen 1,4 min efter, 137 m ut, 5,7 kn. | rättare |
| 20260806-42h | riktning | `265573130:Klaffbron:southbound` 1 → 2. | Samma sydpassage. | rättare |

Appens interpolerade korsning skiljer sig från rådatans med 0,4 s (25h), 20 s (both-21h) och 14 s
(42h). Skälet är att appen interpolerar på det segment den själv såg korsa linjen (dess sista fix på
bortre sidan och första på ankomstsidan), medan `gt-passages` använder sina egna ändpunkter. U21:s
marginal (10 min) är mycket större än skillnaden.

**Varför notisen har passerad form.** I alla tre fallen bokför appen returen som mellanbropassage
först när båten redan är förbi bron. Notisen kommer i samma tick som bokföringen, via failsafen, och
får dess fasta mening "under AIS-tystnad". I 42h var korsningssegmentet bara 68 s, så ordet "tystnad"
är lite starkt; meningen är failsafens befintliga format (docs/bridgeTextFormat.md), och U14 ändrar
ingen text. Revision 3:s egen formregel (`_returnPassageForm`) gäller huvudvägen och bekräftelsen och
rör inte de här raderna.

**Testfiler med samma antal:** `tests/boat-near-gps-recovery.test.js` (25h: 85 → 86) och
`tests/opening-new-members-field.test.js` (both-21h: 151 → 152).

## Oförändrat i facit (kontrollerat)

- **golden-text:** alla 24 korpusar lika (replay:all; `relockN.js` kräver det).
- **Öppningar:** `opening-distribution.json` och öppningsgrindarna (`npm run replay:openings`) är
  identiska med 7699cbe, revision 2 och revision 3, rad för rad (`K/N/tmp/batt4/openings.log`).
- **Passager:** målbro- och mellanbropassagerna är identiska i hela banken.
- **Invarianter:** fatala och WARN är lika många i varje korpus.

## Kontrollerat men inte återställt

Jag gick igenom alla bronotiser som besöksregeln 2026-09-07 tog bort (noterna "ALLA OMRÅDEN
2026-09-07" i 20260708-21h, 20260712-25h, 20260804-both-21h och 20260806-42h). Bara de tre ovan har
två verkliga passager som appen också bokför.

| Korpus | Båt och bro | Rådata | Varför ingen ny notis |
|---|---|---|---|
| 20260708-21h | HALIFAX 228086830, Olidebron | 1 korsning (08:40:41 norrut) | En passage ger en notis. Vändningen 08:29 → 08:39 sker söder om bron (högst 266 m). |
| 20260804-both-21h | ANYA 265705550, Järnvägsbron | 1 korsning (08:24:29 norrut) | En passage, en notis. |
| 20260804-both-21h | ANYA 265705550, Klaffbron 07:28 | 1 korsning (07:14:12 norrut, inferred) | Ingen andra passage. Hennes senare notiser 07:42:19 och 07:58:05 kommer från återkomstregeln och är oförändrade. |
| 20260804-both-21h | ANDREA 219031446, Stridsbergsbron | 1 korsning (03:19:38 norrut) | Brokö, ingen andra passage. |
| 20260806-42h | MISTRAL 219025192 och MOKENDEIST 211214850, Stridsbergsbron | 1 korsning var (11:44:24 och 11:43:11 söderut) | Brokö inom 258 m, ingen andra passage. |
| 20260708-21h | ELFKUNGEN 265573130, Stallbackabron | 2 korsningar: 11:01:36.684 norrut (observerad), 11:07:33.439 söderut (inferred i 80 min glapp, 11:02:05 på 97 m norr → 12:22:02 på 1322 m söder) | **U21, beslutat.** Appen ser returen när fartyget återföds 12:22 (`SKIPPED_BRIDGES_CHECK … new-vessel, candidates=[Stallbackabron]`), men svepets scenario A är ett antagande ur glappet och bokför ingen passage; failsafen stoppas av besöksregeln. Med dirigentens gräns (högst 10 min efter den interpolerade korsningen) skulle notisen dessutom vara cirka 75 min sen. Ingen notis, som beslutet 2026-09-07 säger. |

## Olåsta mätningar

- **72 h-soaken (`npm run replay:monitoring`):** 219 notiser (Järnvägsbron 38), samma som revision 2
  och 3 (7699cbe 216). De tre extra är soakens U-svängsresor 9, 18 och 27 vid Järnvägsbron. Var och
  en passerar bron, vänder 335–457 m bortom och passerar tillbaka; appen bokför båda passagerna.
  Bedömning: rättare.
- **B01-klustret (33 återskapade utslag, `K/N/tmp/r4/cl-rev4.log`):** identiskt med revision 3, alla
  33 ger två notiser, inga invariantutslag och domen `ankomst`. Mot revision 2 ändras fortfarande en
  mening: ORION 265901024 i värld 1034 (R1) får "passerade Klaffbron under AIS-tystnad" i stället
  för "har precis passerat" (korsningssegment 134 s, notisen 133 s efter korsningen). Bedömning:
  rättare.
- **Syntetiska scenarier:** 61 → 65. Fyra vakter med väntan i 0,6–1 kn och slumpad kurs
  (DESIGN.md §4). Alla övriga scenarier ger samma utfall.
- **Bankens instrument:** `visitReturnReleases` bär bevis, korsningstid, segmentlängd och dröjsmål.
  Domen beräknas nu i `tests/replay-validation/returnReleaseVerdict.js` och kräver också att båten
  stannar på ankomstsidan. Bankens tre släpp får samma dom som förut (`ankomst`).
- **Adversariella svep (inget facit, sanning ur generatorn):** se DESIGN.md §5. Inget av dem ingår i
  den låsta banken.
