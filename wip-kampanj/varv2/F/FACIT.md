# Familj F (KAJ): facit efter U23 och revision 1 och 2

**Omgranskningen 2026-11-09 (V/F/OMGRANSKNING.md) godkände båda omlåsningarna
enligt U13:** varje ändrad rad är rättare enligt rådatan, och inget annat i
korpusarna rör sig. Revision 2 (056a535, ba72a32, bd30c8a, 5af2ebc, 0dce236)
flyttar inget facit: banken är 24/24 bitlik mot revision 1 i alla resultatfält
och kajrader, och REBEL:s varning finns kvar. 0dce236 kompletterar bara
41h-noten med mekanismen (avsnitt 2 nedan).

**U23 flyttar inget låst facit.** Revisionen flyttar två, båda rättare enligt
U13 med rådata (docs/VALIDATION.md §Facit-fällan, steg 3), med motivering i
`tests/replay-validation/corpora.js` och utan att andra korpusars lås ändras.

| Commit | Korpus | Facit | Före → efter |
|---|---|---|---|
| f166adf (M3) | 20260806-42h | `opening-distribution.json` Klaffbron:southbound; `golden-events/20260806-42h.json` | 18 → 19; +1 varning, −1 spärr |
| c5fdb1c (M1 c) | 20260713-41h | `golden-text/20260713-41h.json` (relockGoldenText.js) | 264 → 262 övergångar |

Övriga commits flyttar inget: 0873322/3887254 (U23) och 1893af8 (L1) ger banken
24/24 bitlik mot föregående läge i alla resultatfält och alla förtöjnings- och
kajavgångsrader (`F/scripts/bankkor.sh`, `bankdiff.py`; F/bank/u23 och
F/bank/l1). cf43811 ändrar bara harnessens `confirmedTargetWaits`, och abaeafe
är dokument.

## 1. 20260806-42h — S/V REBEL:s varning efter natten (M3)

- **Rådata** (`corpora-data`, `gt-passages`, field-facit):
  - REBEL 265827650 varnades dag 1 (Klaffbron#13 2026-08-06T10:30:04, 900 m),
    gick in i Gästhamnen 10:34:35 och låg där över natten (sog 0, 7–13 m från
    gästhamnslinjen; sista stillafixen 2026-08-07T08:37:53, 391 m från bron).
  - Första rörelsefixen 08:44:41.473 (58.28622/12.28529, 3,3 kn, kurs 213°)
    ligger i Kajens kapsel, 249 m från Klaffbron och 142 m närmare bron än
    stoppet. Nästa fix 08:48:06 ligger 245 m söder om bron.
  - Rådatans korsning söderut: 08:46:26.407 (observerad, mellan 251 m norr och
    239 m söder).
  - Fältappen varnade Klaffbron#19 08:44:41.922 vid 249 m, eta 2 min
    (field-facit/20260806-42h/field-openings.txt:19).
- **Före:** replayn avfyrade Klaffbron#24 vid samma fix men spärrade den som
  same-arrival mot dag 1, eftersom avgångsbeviset krävde en fix utanför
  kajzonerna och nästa fix kom efter passagen.
- **Efter:** Klaffbron#24 levereras 08:44:41.473, 249 m, fix, eta 2, 105 s före
  korsningen, som i fält. Felet var känt (helgranskning-2026-11-03:248–253,
  nu markerat rättat).
- **Grindarna före och efter** (`F/rev/openings.fore.log`, `openings.efter.log`):
  O1 36/36 i 42h som förut (passagens enda täckning var dag 1:s varning, 1 336 min
  gammal); O2 21 → 22 bekräftade inom 20 min av 41; inga röda. Normal- och
  monitoringkörningen ger samma händelser.
- **Orört:** notiser (131/131), fördelning, riktning och golden-text.

## 2. 20260713-41h — kön vid Järnvägsbron får ingen minutprognos (M1 c)

- **Rådata:** 265764760 norrut korsade Klaffbron 09:01:36 (gt, inferred) och
  hade en fix i Kajens kapsel 09:04:18 (288 m norr om bron, 25 m från linjen,
  3,1 kn). Den fixen tömde förut hennes bekräftade anflygning mot Järnvägsbron
  och Stridsbergsbron (08:52:49); nu behålls den, eftersom hon gick i minst
  0,5 kn. Sista fixen 09:07:49 245 m före Järnvägsbron i 2,4 kn, tyst till
  09:32:17, sedan stilla 127 m före Järnvägsbron (även 09:38:16 och 09:47:18).
  Rådatafacit: Järnvägsbron 09:54:07 och Stridsbergsbron 09:55:48 (inferred).
- **De två ändrade raderna** blir båda det som texten visade en tick senare:
  1. 09:13:00 "om cirka 2 minuter" (extrapolerat från 09:07:49) blir "ETA
     okänd". Hon korsade Stridsbergsbron 43 min senare och låg i kön vid
     Järnvägsbron.
  2. 09:36:30 "Två båtar …, om 13 minuter" (ledaren stilla i kön, 0,1 kn) blir
     "Två båtar …, ETA okänd". Gruppens korsningar kom 09:45:38 (265013030) och
     09:55:48.
  En stilla kö vid en tidigare bro får ingen minutprognos
  (docs/bridgeTextFormat.md), så raderna 09:13:30 och 09:37:30 försvinner.
- **Mekanismen** (i noten sedan revision 2): app.js stale-ETA-gren (Fix G)
  extrapolerar inte när `queueBridge` ger en kö vid en tidigare bro
  (`queueAhead`), och M1 c ger tillbaka det köbevis koden väntar sig. 09:36:30
  ger ProgressiveETACalculator `ETA_POST_TRANSITION_HOLD` "unknown" i stället
  för `ETA_GAP_RESET`:s 13,9 min ur golvfarten.
- **U22-förbehåll:** raderna är ETA-klausuler, men ingen kod i ETA-kedjan
  ändras. Noten säger det uttryckligen, så att ägaren kan se ändringen.
- **Orört:** notiser (165/165), fördelning, riktning och öppningar. Olåst
  diagnostik: 42h:s `confirmedTargetWaits` 6 → 7.

## Facit-fällan

Ingen omlåsning gjordes för att bli grön. M3 drevs av fältets varning och den
kända helgranskningsposten; omlåsningen följer rådatan och fältappen. M1 c
skrevs för en syntetisk tvilling, och 41h-ändringen var en bieffekt. Den
prövades rad för rad mot rådatan innan den committades (dirigentens punkt 3:
commit bara om rådatan visar att raderna blir rättare). Köfallet vid Kajen
(U23) syns fortfarande inte i fältbanken; visar ett fältprov det, ska den nya
korpusen låsas enligt U13.
