# Familj F (KAJ): revision 2 efter omgranskningen (2026-11-09)

Alla fyra punkterna är gjorda, med en commit per punkt på 1893af8 i V/F/wt: 056a535, ba72a32, bd30c8a och 5af2ebc. Dessutom anger 0dce236 mekanismen i 41h-noten, som granskaren bad om. Båda godkända omlåsningarna står kvar, och inget nytt facit flyttas. Batteriet V/F/batt-rev2 har slutkod 0 i alla steg. Underlag finns i V/F/DESIGN.md §12, V/F/FACIT.md och V/F/patch.diff.

**Punkterna**
- **M3, medel:** en avgång inne i Kajen kräver nu ett steg sedan förra fixen som är rimligt för farten (högst 20 m plus dubbla farten gånger tiden).
  - GPS-hoppet ger ingen falsk varning i A5n5, A5n0 eller A5q. Den verkliga avgången varnas 57 s före korsningen.
  - REBEL:s varning finns kvar. K150, KNAV5 och B2 behåller 73 s.
  - Fixturen bär `lastPosition`, och hoppfallet är regressionstest (fäller 1893af8).
- **M3, låg:** priset för enfixsregeln står i ARCHITECTURE och DESIGN. En äkta omförtöjning 100 m mot bron inne i Kajen ger en varning 62 min före korsningen (A4). Utan navstatus får den verkliga avgången sedan ingen egen varning (A4n0).
- **L1, medel:** minnet släpps också när VDS:s stillhetsklocka (`_stationarySince`) har nått 2 h.
  - B3 får sin varning 73 s före korsningen.
  - B1, X2kaj, X5kaj och K60 får fortfarande ingen andra varning.
  - Fartspiken är regressionstest (fäller 056a535).
- **L1, låg:** negativtestet prövar nu beteendet: ett stopp där båten aldrig hölls, efter ett hållet stopp och en omstart. Det klarar 3887254 och HEAD och fäller en kopia där minnet följer med till nästa stopp.

**Mätningar**
- Batteriet: jest 370 sviter och 5 293 test, lint, 76 syntetiska scenarier, öppningsgrindarna, soak, fassvepet och självtestet är gröna. Porcelain visar bara node_modules.
- replay:all med och utan monitoring: alla låsta korpusar matchar facit, inklusive omlåsningarna av 42h och 41h. Banken är 24/24 bitlik mot revision 1.
- Quick mot V/bas/quick: 58 → 60 råa utslag, 0 borta, 0 ändrade domar och inga nya kandidatkluster. Resultatet är identiskt med revision 1:s quick.
- T-B:s 17 kajköer är bitlika mot revision 1.

**Öppet:** ägarfrågan om 300–500 m (DESIGN §11), L2 hos E, `var-w129-farled` (samma på c14938f), och rimlighetskravets gräns: med 3 min mellan fixarna tillåts 131 m i 0,6 kn.
