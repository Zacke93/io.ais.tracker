# Granskning av en familj i varv 2

Du granskar en familjs rättning ADVERSARIELLT. Anta att den är fel tills dina egna körningar
visar motsatsen. Lita inte på familjens påståenden; mät själv.

Förkortningar:
- S = /tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad
- V = S/varv2
- X = familjens bokstav

## Läs

- V/KAMPANJ2.md: besluten, däribland U23 och U24 längst ned, och reglerna.
- V/X/DESIGN.md, V/X/FACIT.md, V/X/RESULTAT.md och V/X/patch.diff.
- Triagen för familjens världar: V/tA/TRIAGE-A.md och V/tB/TRIAGE-B.md.
- Dokumentationen för området du granskar (docs/ARCHITECTURE.md, docs/VALIDATION.md med flera).

## Arbetsplats

- V/X/rwt är en git-worktree detached på familjens HEAD. node_modules är en symlänk.
- Tempfiler i V/X/rtmp. Sätt TMPDIR dit.
- Basen c14938f når du med git i samma repo. Gör en egen worktree under V/X/ om du behöver
  köra basen, till exempel V/X/bwt.
- Ändra ALDRIG familjens worktree V/X/wt eller andra familjers kataloger. Huvudträdet är bara
  för läsning.
- Ingen git stash och ingen push. Prober får du committa lokalt i rwt eller bwt.

## Pröva

1. **Rotorsaken.** Reproducera felet på c14938f med `hunt.js --repro` på familjens kort, och
   bekräfta mekanismen i en verbos logg.
2. **Koden.** Granska:
   - korrekthet och kantfall;
   - systerställen, alltså samma mönster på andra ställen;
   - samspelet med andra familjers områden: A och C i VesselDataService och app.js, B och D i
     BridgeOpeningService, F i förtöjningen;
   - att kommentarer och dokumentation stämmer med koden;
   - att ingen död kod finns kvar.
3. **Regressionstesten.**
   - De ska fälla c14938f: kör dem mot basen med de nya testfilerna kopierade dit.
   - De ska klara familjens HEAD.
   - De ska pröva rätt sak och inte vara tautologiska.
4. **Adversariella prov.** Konstruera motexempel där rättningen kan göra fel, till exempel:
   - falska varningar eller fantompassager;
   - missade öppningar;
   - fel mål;
   - text som flimrar.

   Kör dem, till exempel som syntetiska scenarier eller som varianter av motorns världar
   (V/tA/scripts/gen.js med flera).
5. **Batteriet.** Kör själv: jest (hela), replay:all med och utan monitoring, synthetic,
   openings, lint, och fassvepet när ändringen rör tidsstyrning eller livscykel. Är något
   påstått bitlikt mot c14938f, kontrollera det.
6. **Motorn.**
   - `hunt.js --repro` ska ge BORTA för familjens världar.
   - Quick jämförs med V/bas/quick: inga nya kandidatkort. Förklara ändrade räknare.
7. **Facit (U13).** Varje flyttad låst rad ska ha rådatabelägg. Är något "bitlikt", ska det
   vara det.

## Leverans

**V/X/GRANSKNING.md** ska innehålla:
- domen, GODKÄND eller ÄNDRINGAR KRÄVS;
- varje anmärkning med:
  - allvar (hög, medel eller låg);
  - belägg: kommando och utdata;
  - konkret förslag till rättning.

Hög betyder fel beteende i appen eller en regression. Medel betyder en lucka som kan ge fel i
ett rimligt fall eller ett test som inte prövar det det påstår. Låg betyder dokumentation,
stil eller små förbättringar.

**Slutsvaret** ska vara domen och anmärkningarna i korthet, högst 40 rader. Skriv på svenska.
