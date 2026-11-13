# Rättningskampanjen, varv 2: familjerna (2026-11-09)

Varv 2 rättar det som triagen av restkorten hittade. Produktgrenen
claude/wonderful-wozniak-yhk4kz står på c14938f. Varje familj arbetar i två steg:
1. design, prototyp, regressionstest och mätningar (det här uppdraget);
2. adversariell granskning, och revision tills granskningen godkänner.

Därefter integrerar dirigenten familj för familj med hela batteriet.

Ägarens huvudmål: appen ska vara tillförlitlig kring båtar och broöppningar. En missad
öppning är värre än ett falsklarm.

Förkortningar:
- S = /tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad
- V = S/varv2

## Beslut som gäller

- **U13–U22:** står i S/kampanj/KAMPANJ.md, med motiv i docs/ARCHITECTURE.md och
  docs/BUGGJAKT.md §7.
  - **U13:** låst facit låses om BARA där rådatafacit (gt-passages, O1/O2) visar att det nya
    utfallet är rättare. Anta regression tills rådatan visar motsatsen. Följ
    docs/VALIDATION.md §Facit-fällan.
  - **U17:** säkerhetsvarningen för en tyst båt behålls, när hennes senaste position sa att hon
    skulle hinna igenom den gemensamma öppningen men appen inte vet om hon gjorde det.
  - **U18:** två positioner krävs innan en vändning tros.
  - **U22:** ETA-texten och ETA-kedjan rörs inte i varv 2.
- **C-IV, ägarens val 2026-08-09 (väg b):** "Garantin står fast, U2 mjukas upp. Tillåt en
  andra varning när en medlems egen deadline annars skulle förfalla."
  - Källor: docs/etapp7-plan-2026-08-08.md:310–349 och kommentaren vid U9_RESCUE_COVERAGE i
    lib/constants.js:1466–1504.
  - U9:s breda täckning prövades och stängdes av, eftersom den splittrade äkta konvojer.
    Exemplet är JOY och SEEBAER III 2026-07-14, och samma sak hände i ytterligare fyra
    korpusar. En rättning i den familjen får inte återskapa den splittringen.
- **D1 (2026-06-03):** en stoppad eller väntande båt inom 500 m från sin målbro står kvar i
  texten (docs/reliability-spec.md:102). Kajfrågan ställs till ägaren separat, och ingen
  familj rör kajregeln innan svaret kommit.

## Underlag

- **Triagen:**
  - V/tA/TRIAGE-A.md och V/tA/triage-a.json: T2-korten F02, F05 och F08;
  - V/tB/TRIAGE-B.md och V/tB/triage-b.json: T3-korten F06 och F07, B01 och kajfrågan.
- **Triagens skisser:** V/tA/skiss-*.diff och V/tB/skiss-*.diff. Skisserna är provade men inte
  granskade. Börja gärna från dem, men pröva dem själv.
- **Triagens verktyg:** V/tA/scripts/ (gen.js, mkcard.js, tl.js, olog.sh) och V/tB/scripts/
  (gen.js, mkcard.js, spion.js, spår.py, marginal.py, kajscen.js).
  - Världar återskapas med basSeed 1, och radhashen ska vara bitlik mot receptet.
  - Kopiera verktygen till din katalog och peka om dem mot din worktree.
  - Färdiga kort för hunt:repro finns i V/tA/cards och V/tB/kort.
- **Motorns körningar:**
  - S/reg/slut-standard: standardkörningen på c14938f, med rapport.md, rapport.json och fynd/.
  - V/bas/quick: quick-körningen på c14938f, baslinjen att jämföra mot.

## Din arbetsplats

- **Worktree:** V/<familj>/wt, en git-worktree detached på c14938f. node_modules är en symlänk;
  skriv aldrig i den.
- **Tempfiler:** V/<familj>/tmp. Sätt TMPDIR dit.
- **Skrivgränser:** skriv BARA i V/<familj>/. Huvudträdet /home/user/io.ais.tracker och andra
  familjers kataloger är bara för läsning.
- **Commit:** du får committa lokalt i din detached worktree, men inte pusha, byta branch
  eller röra andra worktrees.
- **Regler:**
  - Följ CLAUDE.md.
  - Använd inte git stash.
  - Redigera aldrig app.json.
  - Kommentarer och dokumentation skrivs på svenska.
  - npm test kör med --detectOpenHandles. Ge jest `--cacheDirectory=V/<familj>/jest-cache`.
- **Andra familjer arbetar samtidigt** (se nedan). Rör bara dina egna funktioner. Märker du att
  du måste ändra en annan familjs funktion, beskriv det i DESIGN.md i stället.

## Vad du ska leverera, i V/<familj>/

1. **DESIGN.md:**
   - rotorsaken bekräftad med logg och minsta repro;
   - rättningen på kodnivå;
   - övervägda alternativ;
   - samspelet med andra familjer;
   - hur besluten ovan följs;
   - vilka dokument som uppdateras.
2. **Commits i din worktree:**
   - koden;
   - regressionstest i tests/ som fäller c14938f. Visa det genom att köra testet mot c14938f,
     till exempel i en kopia eller med koden tillfälligt återställd.
   - Lägg gärna fallet som syntetiskt scenario i runSyntheticScenarios när det är
     placeringsberoende eller kräver gles AIS. Uppdatera då antalet i docs/VALIDATION.md.
   - Uppdatera dokumentationen: docs/ARCHITECTURE.md där beteendet beskrivs, och kommentarerna
     i koden.
3. **Mätningar:** kör `bash S/port/battery.sh V/<familj>/wt V/<familj>/batt`. Det kör jest,
   lint, replay:all med och utan monitoring, synthetic, openings, soak, fassvepet med och utan
   monitoring, självtestet och quick. Varje steg ska ha slutkod 0, och porcelain ska bara visa
   node_modules.
4. **FACIT.md:**
   - varje låst korpus vars facit flyttas;
   - för varje ändrad rad: vad som ändras, rådatabelägget enligt U13 och din bedömning
     (rättare, likvärdig eller sämre).

   Ett utfall som blir sämre är ett designfel: ändra designen. Flyttas inget facit, skriv det.
5. **Motorkontrollen:**
   - `node tests/replay-validation/bugHunt/hunt.js --repro <kort>` ger BORTA för familjens
     världar;
   - quick-körningen i batteriet jämförs med V/bas/quick: inga nya kandidatkort och inga nya
     utslag som rättningen orsakar.
6. **patch.diff:** `git diff c14938f` utan node_modules.
7. **RESULTAT.md:** högst 40 rader med vad som gjordes, mätningarna och öppna frågor.

## Familjerna

| Familj | Innehåll | Världar | Filer |
|---|---|---|---|
| A SAMMA-TICK | T-A M1 och M2: målbron i samma tick efter NEW_JOURNEY och efter RE_CROSS-vändning | 936, 1208 (×2), 1316, 1918, 1274, 1317 | app.js, VesselDataService.js |
| B BAKKANT | T-A M4 och M5, därefter M7 | 1094, 1476, 790, 1794, därefter 979, 1139 | BridgeOpeningService.js |
| C DÖDBAND | T-A M3: återfödd båt med kurs i dödbandet | 756, 1913, 977 | VesselDataService.js, ny-båtsgrenen |
| D SPÄRR | T-A M6: spärren vid en tidigare bro när båten accelererar under ett glapp | 263 | BridgeOpeningService.js#_refreshArm, spärrdelen |
| E MOTOR | T-B M1, M2, M3 och B01; T-A M9 och M10 | se uppdraget | tests/replay-validation/bugHunt/, replayRunner.js och docs/BUGGJAKT.md |

**Delade ställen:**
- A och C ändrar båda VesselDataService.js, men olika grenar (A: efter målbrokedjan och i
  app.js:s NEW_JOURNEY; C: ny-båtsgrenen VDS:503–510).
- B och D ändrar båda BridgeOpeningService.js:
  - B: _coverageVerdict, bakkanten och medlemskapet, samt fysikankomsten i _refreshArm;
  - D: spärren i _refreshArm, BOS:1303–1316.
- E instrumenterar `_coverageVerdict` från harnessen. B ska behålla dess anropssignatur och
  returform; nya fält får läggas till.

## Ägarbeslut U23 (2026-11-09): kajen norr om Klaffbron

En båt på väg mot Klaffbron som stannar vid Kajen norr om Klaffbron behandlas som i resten av
väntområdet. Hon står kvar i texten tills hon kör vidare, sänder navStatus "förtöjd" eller
"ankrad" (1 eller 5), eller har legat stilla i 2 timmar (MAX_STATIONARY_WAIT_MS). D1 vinner
alltså över kajzonens 15-minutersgissning.

Två saker behandlas som i dag:
- båtar vid Kajen som inte är på väg mot Klaffbron, till exempel norrgående som redan har
  passerat Klaffbron och har Stridsbergsbron som mål mer än 600 m bort;
- hela Gästhamnen, som ligger utanför väntzonen.

Ägarens motiv: utanför kajzonerna tas en väntande båt nära bron aldrig bort automatiskt, och
Kajen ligger mitt i väntzonen. Underlaget står i V/tB/TRIAGE-B.md, avsnittet "Kajfrågan för
ägaren". Där framgår att fallet uppstod i 9 av 2 000 provvärldar men aldrig i de 482 timmarna
fältdata. Familj F bygger beslutet.

## Ägarbeslut U24 (2026-11-09): egen varning i tid före första passagen

Ägaren valde "inför ändringen", alltså familj B:s smala variant V1c (V/B/patch-M7.diff och
V/B/DESIGN.md §M7).

Fallet: en båt som tillhör en avfyrad händelse utan bokförd passage kommer fram efter
händelsens fönster. Hon får sin egen varning så fort hennes egen tidsfrist går ut, i stället
för vid täckningsslutet. Fyra villkor gäller:
- hon är i rörelse;
- hon är mer än 350 m från bron;
- båda prognoserna lägger henne efter fönstret;
- varningen hade annars kommit för sent.

Ägaren godtar kostnaden att en köande konvoj ibland får en extra varning, som i provvärld 143.
Beslutet följer C-IV väg b (2026-08-09). Stilla köande båtar, som i provvärld 1139, omfattas
inte: för dem gäller dagens beteende.
