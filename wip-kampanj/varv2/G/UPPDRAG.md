# Familj G: registerposterna U25 och U26 (2026-11-09)

Förkortningar: S = /tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad,
V = S/varv2, R = /home/user/io.ais.tracker (huvudträdet, bara läsning).

## Bakgrund

Rättningskampanjens varv 2 är integrerat och pushat (produktgrenen står på eda1839). Motorns
slutkörning (V/integ/std-final, standard, seed 1) gav 7 kandidatkort: fem ETA-kort (uppskjutna,
U22) och två andra med ett fynd vardera:
- **F04 = värld 1139** (T2 LEDTID): MASEN ligger stilla i kö 157 m från Stridsbergsbron. Hon är
  återabsorberad i en händelse (#5) som avfyrades på den tysta YRSA 2:s gamla fix; YRSA 2 hade
  korsat osedd och passagen bokfördes aldrig. MASENs avgång hördes inte, och hennes egen varning
  kom vid #5:s täckningsslut, 41 s före korsningen. U24 omfattar henne inte (hon låg still i
  väntzonen).
- **F05 = värld 1038** (T3, varning efter sann passage): en följare i en händelse släpps av
  bakkanten när händelsens första passage bokförs (12:15:55), drygt 7 min efter ledarens skattade
  passage (12:08:19) och 12 s efter följarens egen korsning (12:15:43). Ingen bakkant kunde hinna.

Ägaren har nu beslutat (2026-11-09) att båda ska **godtas som kända gränser**. Appen ändras
inte. Din uppgift är att spegla besluten i motorn så att de två fynden inte längre blir
kandidatkort, utan att posterna kan dölja ett verkligt appfel.

Besluten får dessa namn:
- **U25:** en varning som kommer efter båtens passage därför att händelsens första passage
  bokfördes för sent (appen hade inget tidigare underlag) godtas. Provvärld 1038.
- **U26:** en stilla köande båt som U24 inte omfattar får täckningsslutets sena varning när
  hennes avgång inte hördes. Det godtas. Provvärld 1139.

(U27, D1-luckan 300–500 m, och konvojfrågan sköter dirigenten. Rör dem inte.)

## Läs först

- docs/BUGGJAKT.md §7 (registrets format, klasser och regler; ändringsloggen rad 1–52) och
  bilaga A.
- V/E/DESIGN.md §4 och §5 (1038, M10 (i)) och §12; V/E/GRANSKNING.md och V/E/OMGRANSKNING.md
  (hur U17-predikatet granskades, H1 och mutationsproven).
- V/B/DESIGN.md §M7 (U24, 979, 143, 1139) och V/KAMPANJ2.md §Ägarbeslut U24.
- V/tA/TRIAGE-A.md: 1139:s tidslinje, M7 och M10.
- docs/buggjakt-triage-2026-11-04.md, avsnittet om varv 2.
- tests/replay-validation/bugHunt/lib/registry.js: predikaten `tystRecoverSammaÖppning` och
  `u24DeladKö`, och hur domspåret (släppvägens domar ur replayRunner.js#instrumentCoverageVerdicts)
  läses.
- tests/replay-validation/bugHunt/__tests__/k-varv2-motor.test.js och j-kampanj-register.test.js
  (testmönstret, fixturerna).

## Arbetsplats och regler

- **Worktree:** V/G/wt, detached på eda1839. node_modules är en symlänk; skriv aldrig i den och
  kör inte npm install.
- **Tempfiler:** V/G/tmp (sätt TMPDIR dit). Jest: `--cacheDirectory=V/G/jest-cache` (absolut
  sökväg utanför worktreen; en relativ sökväg hamnar i worktreen och fäller porcelain-testerna).
- **Skrivgränser:** skriv bara i V/G/. Huvudträdet och andra familjers kataloger är bara för
  läsning. Mutationsprov gör du i en egen worktree, V/G/mwt (eller fler), som du tar bort
  efteråt. Disken har cirka 9 GB ledigt: städa tempfiler och kör inte fler samtidiga
  motorkörningar än nödvändigt.
- **Git:** committa lokalt i V/G/wt. Ingen push, ingen git stash, byt inte branch. Commitmeddelanden
  på svenska och avslutas med raderna
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` och
  `Claude-Session: https://claude.ai/code/session_01DNCqwt4q1MF8G4Aw5jG5pc`.
  Inga modellnamn eller modell-id i filer i repot.
- **Produktkoden (app.js, lib/, drivers/) ändras inte** i V/G/wt. Rör inte heller
  docs/buggjakt-triage-2026-11-04.md (dirigenten uppdaterar den).
- Följ CLAUDE.md. Kommentarer och dokumentation på svenska.

## Uppgift

1. **Mekanismen.** Kör `node tests/replay-validation/bugHunt/hunt.js --repro <fynd>` i V/G/wt på
   V/integ/std-final/fynd/F04-… och F05-… och bekräfta tidslinjen i en verbos logg: vilken rad
   som bokförde passagen (1038), vilken dom som släppte båten (domspåret), när den passerande
   båtens första levererade rad efter sin sanna korsning kom, och för 1139 varför U24:s grindar
   inte släppte henne.
2. **Besluten i docs först** (regeln i BUGGJAKT §7): beskriv U25 och U26 kort i
   docs/ARCHITECTURE.md där täckningsslutet, bakkanten, U17 och U24 beskrivs, med provvärldarna
   som exempel och tydligt att det är godtagna gränser, inte avsett idealbeteende.
3. **Två poster med klassen ACCEPTERAD** (känt pris, som U19) i beslutsregister.json, med nya
   predikat i lib/registry.js. Predikaten ska vara så smala att de bara tar sin mekanism:
   - **U25** (orakel T3; bara den klass som mekanismen faktiskt ger). Minst:
     a. båten var absorberad i händelsen E före sin korsning (den sista absorptionen före
        korsningen), och E:s varning kom före korsningen;
     b. hennes egen varning kom ur släppvägens dom bakkant (domspåret krävs) inom en tick efter
        att E:s första passage bokfördes;
     c. E:s första passage bokfördes senare än hennes korsning − 60 s (M10 (i));
     d. **den sena bokföringen förklaras av data:** appen hade inget tidigare underlag för
        passagen. Konkret: den passerande båtens första levererade rad efter sin sanna korsning
        (eller det underlag som bokföringen faktiskt bygger på; ta reda på vilket) kom tidigast
        en tick före bokföringen. Hade appen underlaget tidigare och bokförde ändå sent är det
        ett appfel och ska förbli KANDIDAT.
   - **U26** (orakel T2; bara LEDTID om inte mekanismen ger mer). Minst:
     a. båten var absorberad i en händelse E utan bokförd passage, och hennes egen varning kom
        vid E:s täckningsslut enligt domspåret, inom en tick efter det slut som motorn själv
        räknar ur arm och händelse (inte bara appens eget värde; jämför U17:s villkor (3′b));
     b. U24 omfattade henne inte därför att hon låg stilla i kön: hennes sista levererade rad före
        varningen låg inom väntzonen (≤ 350 m) och under rörelsegränsen, med gränserna lästa ur
        produktens konstanter på samma sätt som U24-predikatet gör;
     c. ingen levererad rad visade henne i rörelse mellan hennes egen deadline och varningen
        (avgången hördes inte);
     d. en båt i rörelse utanför väntzonen (979-fallet, som U24 släpper) får aldrig tas.
   Följ registrets regler: predikaten är data med parametrar, läser produktens konstanter men
   anropar inte produktfunktioner som avgör samma sak som oraklet; hänvisningar till motorns egna
   filer med `#symbol`; laddningsvalideringen ska godta posterna. Lägg posterna där ordningen
   inte låter en tidigare post ta fynden av fel skäl, och redovisa varför.
4. **Tester åt båda hållen** (mönstret i k-varv2-motor och j-kampanj-register): posten tar 1038
   respektive 1139 (fixturer ur världarna), och den tar inte närliggande fall: bokföring i tid,
   ett tidigare underlag som appen inte använde, båten i rörelse, 979-typen, saknat domspår,
   annan dom än bakkant respektive täckningsslut.
5. **Mutationsprov** i V/G/mwt (produktkoden får ändras där, aldrig i wt): minst
   - bakkanten bortkopplad i `_coverageVerdict`;
   - U24-släppet bortkopplat;
   - täckningsslutet förskjutet senare (till exempel + 2 min);
   - passagebokföringen fördröjd, om den går att injicera utan att skriva om appen.
   Kör quick (och `--repro` på relevanta världar) med respektive utan de nya posterna. Inget nytt
   utslag får tas av U25 eller U26 utom exakt deras mekanism. Redovisa talen.
6. **BUGGJAKT.md §7:** posttabellen (41 → 43 poster, rätt ordning), ändringsloggen (rad 53 och
   54 med skäl och källor) och mätningarna i bilaga A. Kontrollera att varje antal i dokumentet
   som beror på registret stämmer (sök efter "41").
7. **Kontroller i V/G/wt:** hela jest (`npx jest --config tests/jest.config.js --runInBand
   --cacheDirectory=…`), `npm run lint`, självtestet, quick, och en standardkörning:
   `node tests/replay-validation/bugHunt/hunt.js --profile=standard --seed=1 --out=V/G/std`
   (cirka 8 min). Förväntat: 5 kandidatkort (bara ETA), F04 och F05 borta som kandidater och
   registrerade under U26 respektive U25, och inga andra skillnader mot V/integ/std-final
   utöver det som posterna förklarar. `git status --porcelain` i wt ska bara visa node_modules.

## Leverans i V/G/

- **DESIGN.md:** mekanismerna med logg, predikaten villkor för villkor med skäl, motexemplen,
  mutationsproven med tal, standardkörningen mot std-final och de dokument som ändrats.
- **Commits i V/G/wt** och **patch.diff** (`git diff eda1839 -- . ':!node_modules'`).
- **RESULTAT.md:** högst 40 rader.

Slutsvaret: högst 40 rader på svenska med vad som gjordes, talen och öppna frågor.
