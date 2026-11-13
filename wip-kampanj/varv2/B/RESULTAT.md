# RESULTAT — familj B (BAKKANT), varv 2, revision 2

**Revision 2 är committad:** e5f78b5, ovanpå 5d4b2c3 (som omgranskningen GODKÄNDE). `patch.diff` = `git diff c14938f`.

**Rättat enligt omgranskningen:**
1. **Nya fix, inte observationer:** `crawlFixes` räknar bara när fixtiden (`rawAnchorMs`) har gått framåt. D4 (kölämnarens rörelsefix levererat två gånger) ger 1 varning, som c14938f, i stället för 2. D4 är nytt regressionstest.
2. **Krypfix efter marschfart:** ett första krypfix godtas när förra nya fixet låg i minst 2,5 kn, enligt granskarens förslag.
   - D2, D3 och D3b varnar 600, 700 och 700 s (5d4b2c3: 750, 840 och 730 s). C4, C4b och C4c ger fortfarande 1 varning, som c14938f.
   - Två familjetest är ändrade och motiverade i DESIGN.md: 790-testet och kölämnartestet. D3 är nytt test.

**Mätt:**
- **Probfilen** (`prober/fore-5d4b2c3.json` mot `prober/efter-rev2.json`): ingen prob har fler varningar än c14938f, utom M4:s kända B1.
- **Repro:** 790, 1794, F08 och 1476 förblir BORTA (790 varnas 13:31:18, F08 10:11:45). 1094, 979, F02 och 41 är BORTA; 1139 och 143 KVAR.
- **Bank mot c14938f:** två olåsta rader, JOSEPHINE (U24) och PILLE (M5, tillbaka eftersom hennes krypfix kom efter 5,7 kn). Ingen låst rad rörs.
- **U9-korpusarna** är identiska; JOY och SEEBAER III har kvar #9 08:25:16,678.
- **Batteriet** (`batt-rev2`): 13/13 steg slutkod 0, porcelain visar bara node_modules, jest 370 sviter och 5290 test.
- **Quick mot `bas/quick`:** 58 → 57 utslag (−240, −41, +143), identiskt med revision 1. Värld 143 är U24:s godtagna kostnad.
- **Test:** 26 test, varav 4 fäller 5d4b2c3. Mutationsprovet fäller 22 av 22.

**Kvar:** registerposten för A3e (familj E via dirigenten) och stilla köande båtar (1139) utan beslut.
