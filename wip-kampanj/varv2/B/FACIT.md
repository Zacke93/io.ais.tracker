# FACIT — familj B (BAKKANT), varv 2 (2026-11-09)

Facit mäts mot `replay:all` (låsta notiser, multiset, golden-text, golden-events och
opening-distribution) och mot `replay:openings` (O1/O2/H-4, rådatafacit gt-passages). Alla tider
är UTC. Antal: replay:all:s 24 korpusar har 431 öppningsvarningar. runOpeningGates räknar 437,
eftersom den också tar med nattens fusionskörning (6).

## Slutläge efter revision 2 (e5f78b5) — två olåsta rader skiljer mot c14938f

Mot c14938f, med och utan monitoring, skiljer två olåsta rader. Ingen låst rad flyttas, och de fem
U9-korpusarna är identiska.
- **JOSEPHINE** (steg 3, U24): likvärdig, se nedan.
- **PILLE** (M5): 20260804-17h, 11:33:56 → 11:29:38; likvärdig, se steg 2.
  - Revision 1 tog bort raden, eftersom PILLE:s släpp låg på ett första krypfix.
  - Revision 2 godtar ett första krypfix direkt efter marschfart. Hennes förra fix låg i 5,7 kn, så
    raden är tillbaka som på steg 2.

## Steg 1 (M4, 650a0c7) — inget facit flyttas

replay:all, replay:synthetic och replay:openings är bitlika med c14938f, med och utan monitoring.
Alla 437 öppningsvarningar (431 + 6) är identiska.

## Steg 2 (M5, 594a146; batteriet på ad87498, samma kod) — ingen låst rad flyttas; en olåst varning (borta i revision 1, tillbaka i revision 2)

**20260804-17h** (`locked`, `lockEvents: false`; opening-distribution oförändrad, Stridsbergsbron:southbound
har samma antal).

| | Före (c14938f, steg 1) | Efter (steg 2) |
|---|---|---|
| Varning | Stridsbergsbron#22 11:33:56,462, deadline, eta 0, d 264 m, [PILLE 211488730] | Stridsbergsbron#22 11:29:38,576, fix, eta 2, d 264 m, [PILLE] |
| Släpp ur #19 | täckningsslut 11:33:56,461 | bakkant på fixet 11:29:38,576: fysik 11:36:14 (264 m i 1,3 kn) efter fönstret 11:33:56,461; appens ETA 11:32:05 |

Rådata (corpora-data/ais-20260804-17h-dag.jsonl, PILLE söderut, avstånd till Stridsbergsbron):
11:22:39 1309 m N 5,7 kn · 11:29:38 264 m N 1,3 kn · 11:34:09 176 m N 0,4 kn · 11:37:07 166 m N 0,2 kn ·
11:40:10 175 m N 0,1 kn · 11:43:10 153 m N 0,3 kn · 11:46:08 134 m N 0,1 kn · 11:49:08 111 m N 0,1 kn ·
12:04:08 46 m S 1,0 kn.
gt-passages: Stridsbergsbron 11:59:40 inferrerad (`sparse-stopped-endpoint`, fönster 11:49:08–12:04:08).
#19:s första passage var 219036470 11:24:45,7 (skattad), alltså minst 24 min före PILLE: hon är
nästa öppning och ska ha en egen varning i båda versionerna.

**Bedömning: likvärdig.** Båda varningarna ligger mer än 15 min före korsningsfönstret, och O1 räknar
passagen som varnad i båda. Den nya bygger på det färska fixet som visade krypet (KRAV (4)), den
gamla på täckningsslutet. Ingen eta-token stämmer med verkligheten, eftersom hon väntade 15–30 min.
Rådatan kan inte avgöra vilken som är bättre, och ingen omlåsning behövs. Härledda tal i openings som
rör sig: intervallmedianen i H-4 15,7 → 15,0 min och medianen för sena passager i O2 32,5 → 32,6 min.

## Steg 3 (M7, ägarbeslut U24, 0b0a35d) — ingen låst rad flyttas; en olåst varning

**20260525** (`locked`, `lockEvents: false`; multiset oförändrat).

| | Före (steg 2) | Efter (steg 3) |
|---|---|---|
| Varning | Klaffbron#10 10:06:05,877, deadline, eta 5, d 470 m, [JOSEPHINE 244870852] | Klaffbron#10 10:01:20,160, deadline, eta 6, d 961 m |
| O2 | ACCEPTERAD AVBRUTEN_APPROACH | ACCEPTERAD AVBRUTEN_APPROACH |

Rådata: 09:46:43 1379 m N 4,2 kn · 09:50:43 1043 m 0,2 kn · 09:58:13 1046 m 0 kn (väntar vid
Järnvägsbron) · 10:01:13 961 m 5,2 kn · 10:03:14 703 m 3,5 kn · 10:05:45 470 m 1,8 kn · 10:07:43 385 m
1,4 kn · 10:11:43–10:35:44 339–348 m 0 kn.
gt-passages: Stridsbergsbron 09:48:39 och Järnvägsbron 10:01:09, båda inferrerade. Ingen passage vid
Klaffbron.

**Bedömning: likvärdig.** Det är samma fantomvarning (avbruten anflygning), fem minuter tidigare,
på hennes egen deadline.

**Värld 143 (buggjägarens quick, inte facit):** den nya kandidaten `T3 VARNING-PÅ-FRUSET-FIX`
(CORDELIA 265101116, Stridsbergsbron#8 11:36:10 på ett 21 min gammalt fix) är den kostnad som U24
godtar. Den registreras av familj E med U24 som källa (DESIGN.md §Registerpost för värld 143). Den
låsta banken har 431 varningar som förut.

**Förkastad variant V1b, med låst rad.** I 20260804-both-21h (`lockEvents: true`) hade
LAURIERBORG 246924000 Stridsbergsbron flyttats från 07:36:41,333 (deadline, eta 6, d 666) till
07:33:39,230 (deadline, eta 7, d 1082). Undertryckningen 07:34:25,548 för ANYA ELAN 380 hade
försvunnit, eftersom ANYA i stället absorberades i LAURIERBORGs händelse.
- Rådata: LAURIERBORG korsade 07:42:31,1 (gt, inte inferrerad, glapp 60 s). ANYA korsade först
  08:26:30,5 (norrut, inte inferrerad). Det var alltså separata öppningar, och båda varningarna
  låg före korsningen (5,8 och 8,9 min).
- Rådatan visar inte att den nya varningen är rättare, och ANYAs absorption är snarast sämre.
  **Bedömning: likvärdig och sämre → designfel.** Villkoret "täckningsslutet kommer för sent"
  i patchen tar bort flytten.
