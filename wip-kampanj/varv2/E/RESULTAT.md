# RESULTAT — familj E (MOTOR), varv 2, revision 1

**Commits** ovanpå 1dfd18a i `V/E/wt`, en per punkt: f0b7dc0 H1 · d7dd393 L1 · 703bbf1 L3 · d913146 revisionslistan · 5839d56 L2, L4, L5 och mätningarna. `V/E/patch.diff` = `git diff c14938f` utan node_modules. Appen är orörd.

1. **H1 (hög):** villkor (3′) är oberoende av appens flaggor och fönsterslut (granskarens `förslag-H1.diff`).
   - Fysiken prövas ur varje egen rad efter att passagen blev känd.
   - Fönsterslutet är det tidigare av `windowEndMs` och motorns räknade slut.
   - `lastFixClean` undantar inte längre en dom.
   - Quick: "aldrig rent fix" ger 21 av 23 KANDIDAT, som c14938f:s motor (förut 4). "Fönsterslut = täckningsslut" på B:s app ger 3 av 3 (förut 2). Omuterat ändras inget utfall. Vakterna ligger i jest, och proven står i §7 rad 50 och A.7.
2. **L1:** i AISHub dras taktbytets intervall ur en egen ström per avgång och gäller bara fixar från avgången. Den första hörda fixen kommer därför aldrig senare, och raderna före avgången är bitlika. Över 2 000 världar hörs ingen avgång senare (0/242 och 0/130). 1527 var en radioartefakt och ger inga utslag.
3. **L3:** harnessens bokföring ligger i try/catch, och domen returneras alltid. `waitingAtBridge` bokförs och prövas i U24:s grind `kö`. Replay är bitlikt 26/26 utom domspåret.
4. **Revisionslistan:** U24-posten godtar båda släppvägarna (A3e). B:s revision 2 (e5f78b5) ger 0 ändrade utfall i quick mot 5d4b2c3, så (3′), U17 och K-NÄSTA dömer som förut. Symbolerna laddar utan varningar. kajK- och shrink-testen håller före och efter F (432 test gröna med F:s 0dce236).
5. **L2, L4 och L5:** U24:s policygrindar och KRAV (1) syns bara i räknarna och i jest; det står som känd gräns i §7. Dokumentationen är rättad (marginalen 27–154 s, realismens övriga mått, §14 och 1527). `a-radio.test.js` har 10 seeds, och motorns sviter tar 16–19 s mot basens 15–16 s vid load 14–19 (user +13 %).

**Mätningar:**
- **Batteriet** (`batt-rev1`, 67e09fa; 5839d56 ändrar bara BUGGJAKT.md): alla 13 steg ger slutkod 0. Jest: 370 sviter, 5 332 test; motorn 434. Självtestet är grönt.
- **Standard** (`std-rev1`, 10 min): 261 utslag, 44 kluster och 9 kort, som std-efter. Sex fynd ändras, alla av L1: 1527:s två utslag försvinner, och 1675 (U17) flyttar. Nya är 129 (T2 LEDTID, U23:s köfall vid Kajen, borta med F; finns även i quick) och 340 (INV-3, ETA-kedjan enligt U22).

**Öppna frågor:**
- 1038 efter B: en U17-variant kräver beslut.
- Ska U2-VS-DEADLINE och O1:s T2-gren bindas till släppvägen?
- Ska kriteriet om konvojfönstrets bakkant formuleras om? F02:s gräns är Kajens köundantag.
- Jest-kravet 5 s håller inte, inte heller på c14938f.
