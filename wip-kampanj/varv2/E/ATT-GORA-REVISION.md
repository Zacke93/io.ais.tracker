# Till familj E:s revision (samlat av dirigenten)

1. **U24-posten (U24-DELAD-KÖ-EXTRA-VARNING) ska tillåta båda släppvägarna**, enligt
   omgranskningen av B, anmärkning 1 i V/B/OMGRANSKNING.md. I prob A3e släpps båt B ur den första
   händelsen genom U24, inte vid täckningsslutet, så punkt 3 i posten missar fallet. Postens
   orakel, varning på fruset fix, slår inte heller till för en hörd båt. Posten döljer ingen
   regression i dag, men punkt 3 bör godta båda släppvägarna.
2. **B:s revision 2 lägger till två saker i M5:** krypfixräkningen på fixtid och att ett första
   krypfix godtas efter marschfart. Kontrollera att (3′) och U17/K-NÄSTA fortfarande dömer rätt.
3. **Radhänvisningar:** registret pekar på symboler, inte på rader. Kontrollera efter
   integrationen att alla symboler finns.
4. **Två motortest faller efter integrationen med F** (provintegrationen V/integ/prov2,
   batt-prov2/jest.log). Testen ska hålla både före och efter F, eller skrivas för det
   integrerade läget:
   - `k-varv2-motor.test.js:180` (kajK): testet väntar sig att båten demoteras efter 15 min.
     Med U23 i appen demoteras hon inte, och skälet blir "ingen bärare på väg mot Klaffbron
     demoterades …".
   - `k-varv2-motor.test.js:400`: `shrink.KONSTANTER` saknar 'queueGraceMs (Kajen)' när
     köundantaget är Infinity, och `find(...)` ger då undefined, vilket ger ett TypeError.
