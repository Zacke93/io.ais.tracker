# Rättningskampanjen efter buggjägarens första rapport (2026-11-04)

Buggjägaren hittade appfel, och de är triagerade. Ägaren har nu beslutat att de ska
RÄTTAS. Varje rättning ska ge regressionstest och full validering, motorn ska köras om
och korten ska bli BORTA. Kampanjen sker i tre steg:
1. **Design med prototyp:** en designer per familj. Det är det här uppdraget.
2. **Granskning:** adversariell granskning av varje familj.
3. **Integration:** dirigenten integrerar familj för familj, låser om med belägg och
   committar.

Ägarens huvudmål: appen ska vara tillförlitlig kring båtar och broöppningar.

Förkortningar nedan:
- S = /tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad
- K = S/kampanj

## Användarbeslut 2026-11-04 (gäller hela kampanjen)

- **U13 (facit).** Låst facit får låsas om när en rättning ändrar utfallet, men BARA där
  rådatafacit visar att det nya beteendet är rättare. Rådatafacit är verkliga korsningar
  (gt-passages, loadPassageEvidence) och öppningsgrindarnas O1/O2 (runOpeningGates).
  Varje ändring motiveras per korpus: i noten i tests/replay-validation/corpora.js och i
  docs/. Följ docs/VALIDATION.md §Facit-fällan och §Omlåsning av golden-text. Anta
  regression tills rådatan bevisar motsatsen.
- **U14 (B01, två notiser).** En båt som passerar en bro, vänder och passerar tillbaka
  ska få en notis även för returpassagen. Det justerar besöksregeln 2026-09-07
  (TriggerPointVisitTracker.js:12–16). En VERKLIG passage tillbaka ger en egen notis,
  men en båt som bara ligger och guppar eller väntar vid bron ska fortfarande inte få
  flera notiser. INV-5/7 ("en notis per passage, även returpassagen",
  docs/VALIDATION.md:296–300) blir därmed kontraktet.
- **U15 (B02, returresan får egen öppningsvarning).** En båt som passerar en bro, vänder
  och kommer tillbaka får en egen bridge_opening_soon för returen, även inom
  konvojfönstret på 600 s. Det följer U2 (docs/etapp7-plan-2026-08-08.md:9: "båtar som
  anländer efter passagen är nästa öppning") och principen att en missad öppning är
  värre än ett falsklarm. INV-21 (invariants.js:866–871) blir kontraktet.
- **U16 (F18/F19, "strax"-studsen).** Beteendet behålls: appen visar aldrig 'strax' på en
  position som är äldre än 10 min (F40-avvägningen, docs/helgranskning-2026-07-06.md:271–274,
  U1/C11). Motorn registrerar det som DESIGN. Dirigenten gör det, och det ingår inte i
  någon familj.

## Underlag

- **Kort, minsta repro och tidslinjer:** S/hunt-fix/runs/r1-standard-a/fynd/<kort>/
  (repro.jsonl, repro.spec.json, repro.truth.json, tidslinje.txt, fynd.json, kommando.txt),
  plus rapport.md och rapport.json i samma körning.
- **Triagen** (domar, belägg, rotorsak med fil:rad och rättningsriktning):
  - S/hunt-fix/result.json, nyckeln "triage": två delar, kort F01–F23 och W750;
  - S/hunt-fix/input/triage.json: den första triagen, med gammal numrering;
  - triagearbetarnas underlag i S/hunt-fix/tmp/triage-1/ och triage-2/: skript, varianter
    och återskapade världar.
- **Motorns dokumentation:** S/hunt-build/C/repo/docs/BUGGJAKT.md.
- **Appens dokumentation:** docs/ARCHITECTURE.md, docs/reliability-spec.md,
  docs/VALIDATION.md, docs/etapp7-plan-2026-08-08.md och docs/helgranskning-2026-11-03.md.
  Läs dokumentationen för det område du rör innan du ändrar något. Konstanter och
  domänbeslut är ofta medvetna; se CLAUDE.md.

## Familjer och kort (id i r1-standard-a)

- **K, konvoj och öppning** (BridgeOpeningService.js med krokar i app.js):
  - RECOVER-släppet, _releaseStrandedArms: F02, F03, F11, F14, F17, F20, F22, F23 och
    F01:s r2.
    - Rotorsak: armen släpps på ren tid vid täckningsslut och avfyras direkt på en
      förfallen ärvd deadline. Det saknas grindar för bron bakom båten, färskhet,
      ankomstfysik och ledtidsgolv (ARCHITECTURE.md:1461–1474, KRAV (1)–(4)).
    - F22/F02, konvojbakkanten: medlemskapet omprövas bara vid täckningsslut. Det
      behöver omprövas mot en färsk prognos så att armen släpps i tid med egen deadline.
  - Glappregistreringen, F01 med representanten värld 1900: _recordPassage sätter
    firstPassageAt till registreringstiden, så konvojtäckningen flyttas efter ett
    AIS-avbrott. Rättningsriktning: använd den interpolerade korsningstiden.
- **K2, konvojens medlemskap** (samma fil som K, men andra funktioner; samordna via
  DESIGN.md):
  - U15, returresan B02: en båt får inte absorberas i sin egen äldre händelse efter en
    vändning.
  - Fasberoendet i 13h, bankkortet F09: en halvminutstick mellan PILOT 761:s avfyrning
    och VIRGO:s fix lägger händelsen i hennes releasedFrom.
- **R1, riktning och vändning** (VesselDataService.js):
  - U-svängens återkorsning bokförs aldrig: F10, W750 och U-svängsreturerna i F01.
    Fix D:s 2-fixdebounce bekräftar vändningen först på fixen bortom bron, och
    N1-resetten i _confirmDirectionReversal räknas från nuvarande läge. Den nyss
    återkorsade bron stannar därför i passedBridges.
  - Det svepinfererade riktningslåset, F15: SKIPPED_BRIDGES_DIRECTION_LOCK omprövas
    aldrig mot levande kurs eller progress.
- **R2, passage och notis:**
  - GPS-grindens dubbelbokföring, F12 och F16: confirmStableCandidates bekräftar en
    kandidat för en bro som glappvägen redan har bokfört.
  - BN2-luckan, F13: en återfödd båt med nordostlig kurs (cog 49,9°) utan ruttlås ger
    _hasGapCrossedNotifiedBridge false.
  - Fasberoendet i 16h, bankkortet F08: UNDER_BRIDGE_CROSS_PROOF mot FIX_U_FORCE_WAITING
    beror på tickens fas.
- **N, notis per passage (U14):** TriggerPointVisitTracker och notisflödet i app.js.
  Exemplet är B01: WILMA passerar Klaffbron söderut, vänder 162 m söder om bron och
  korsar norrut. I dag blir det två målbropassager men en notis. Samspel: R1 gör att fler
  returer bokförs, och U14 ska ge dem notiser.
- **M, mål och text:** LOW_SPEED/INSUFFICIENT_MOVEMENT-flappen, F05. Tilldelningens
  närhetsundantag mäter mot närmaste bro, medan retentionens LOW_SPEED och
  INSUFFICIENT_MOVEMENT mäter mot målbron. Det ger DEFAULT-flash.
- **E, ETA-kedjan:**
  - F04: avgångs-ETA räknas på igångsättningsfarten (ETA_GAP_RESET, ETA_OUTLIER, EMA).
  - F06: ETA-oscillation vid inbromsning (3-minuterströskeln saknar hysteres, och
    K6-dubbelkörningen ger dubbel EMA-eftersläpning).
  - F07: bankfyndet i 21h, klämkedjan J10/K6.

  Följ docs/VALIDATION.md §ETA-mätharnessen och "REGELN: varje ändring i ETA-vägen
  MÄTS mot baslinjen".

## Din arbetsplats

- **Granskarens worktree:** K/<familj>/rwt, med samma uppsättning. Granskaren applicerar
  patch.diff där.
- **Din worktree:** K/<familj>/wt. Den är en git-worktree, detached på 7699cbe, med
  motorn kopierad (otrackad) i tests/replay-validation/bugHunt och node_modules som
  symlänk.
- **Tempfiler:** K/<familj>/tmp, med TMPDIR satt dit.
- **Skrivgränser:** skriv BARA i dina egna kataloger. Huvudträdet /home/user/io.ais.tracker,
  S/hunt-build/C/repo och andra familjers worktrees är bara för läsning.
- **Commit:** du får committa lokalt i din detached worktree. Du får inte pusha, inte
  byta branch och inte röra andra worktrees.
- **Regler:**
  - Använd inte git stash; det förstör LF.
  - Redigera aldrig app.json direkt.
  - Kör brotexttesterna när du rör texter; formatet finns i docs/bridgeTextFormat.md.
  - Kommentarer och dokumentation skrivs på svenska.
  - npm test använder --detectOpenHandles. Hänger sviten, leta efter det öppna handtaget.

## Vad du ska leverera, i K/<familj>/

1. **DESIGN.md**, på svenska:
   - rotorsaken bekräftad med logg och minsta repro;
   - rättningen på kodnivå: funktioner och villkor;
   - övervägda alternativ och varför du valde som du gjorde;
   - samspelet med andra familjer, alltså vilka funktioner som delas;
   - hur användarbesluten följs;
   - vilka dokument som ska uppdateras.
2. **Prototypen**, committad i din worktree, med:
   - regressionstest i tests/ som fäller den gamla koden; visa det genom att köra testet
     mot 7699cbe;
   - gärna ett syntetiskt scenario i runSyntheticScenarios när fallet är
     placeringsberoende.
3. **Mätningar i din worktree:**
   - npm test (hela sviten);
   - npm run replay:all;
   - npm run replay:synthetic;
   - npm run replay:openings;
   - npm run replay:monitoring och fassvepet när ändringen rör tidsstyrning eller
     livscykel;
   - npm run lint.
4. **FACIT.md**: varje låst korpus vars facit flyttas, och för VARJE ändrad rad:
   - vad som ändras: notis, text, öppning eller riktning;
   - rådatabelägget enligt U13: korsningstid ur gt-passages, O1/O2-klass eller sampel
     ur jsonl;
   - din bedömning: rättare, likvärdig eller sämre.

   Ett utfall som blir sämre är ett designfel. Ändra designen, och lås inte om. Lås gärna
   om i din worktree med relockGoldenText.js eller REGEN_DISTRIBUTIONS=1 enligt
   VALIDATION.md för att visa att allt annat blir grönt. Dirigenten låser om på riktigt
   vid integrationen.
5. **Motorkontrollen:**
   - `node tests/replay-validation/bugHunt/hunt.js --repro <kort>` ska ge BORTA för
     familjens kort, och KVAR för andra familjers kort om du inte avsiktligt påverkar
     dem.
   - Kör `node tests/replay-validation/bugHunt/hunt.js --profile=quick --out=K/<familj>/hunt-quick`
     och jämför med S/hunt-fix/runs/ (r1-quick-a) så att inga nya kort uppstår av
     rättningen.
6. **patch.diff**: git diff 7699cbe för appen, testerna och docs, utan bugHunt/ och
   node_modules.

## Containeromstart 2026-11-04 cirka 20:40 UTC

Containern startades om mitt i arbetet, och agenter som då arbetade avbröts.
Filerna finns kvar.

Hittar du ocommittade ändringar i din worktree (git status) som du inte själv
gjort i den här sessionen, kommer de från ett avbrutet tidigare försök med
samma uppdrag. Gör så här innan du fortsätter:
1. Granska dem med git diff.
2. Avgör om de ska behållas och slutföras, eller tas bort med
   git checkout -- <fil>. Använd inte git stash.
3. Skriv i ditt svar vad du valde och varför.

## Användarbeslut 2026-11-04, kväll (besvarar designernas ägarfrågor)

- **U17 (K, fall A, tyst båt).** RECOVER-släppets säkerhetsvarning för en tyst båt BEHÅLLS:
  - Gäller när båtens senaste position sa att hon skulle hinna igenom den gemensamma
    öppningen, men appen inte vet om hon gjorde det.
  - Ingen öppning får missas. F11/F23-klassen godtas som falsklarm av samma slag som
    AVBRUTEN_APPROACH ("en missad öppning är värre än ett falsklarm").
  - Motorn ska registrera klassen som DESIGN, med källa U17.
- **U18 (R1, fråga 1).** Fix D:s krav på TVÅ positioner innan en vändning tros
  BEHÅLLS (Anomali 18).
  - Returer med gles AIS som därför får varningen sent är en känd gräns.
  - Motorn märker fallen som KÄND_ÖPPEN eller DESIGN med källa U18, så att de inte
    blir nya kort.
- **U19 (R1, fråga 2).** En planerad öppningsvarning skickas ÄVEN när en obekräftad
  vändning väntar (ZELDA, värld 188).
  - Motorn registrerar fallet som godtaget, med källa U19.
- **U20 (E, fall D).** ETA-utjämningen och spärren ska göras om NU, i den här kampanjen.
  - F06: dubbel EMA-utjämning per AIS-rapport i K6-dubbelkörningen.
  - F07: spärren mot stora hopp jämför med appens egen extrapolerade gissning i
    stället för med en mätning.
  - Följ VALIDATION.md §ETA-mätharnessen ("varje ändring i ETA-vägen MÄTS mot
    baslinjen") och U13.
  - Det blir en ny familj, E2, ovanpå familj E:s F04-rättning.
- **U21 (N, fall E).** Ingen sen notis för en returpassage under ett långt AIS-avbrott.
  - Beslutet 2026-09-07 "ingen ny notis antas ur glappet" står fast.
- **Dirigentens beslut för R2:s frågor (2026-11-04).**
  - Fråga 1: JA. K1-mätningen av nordprogress (beslut A3) får avgöra passerad form i
    BN2 när en återfödd båts kurs ligger mellan banden. K1 själv ändras inte.
  - Fråga 2: JA. Fallet där en båt får sitt mål först vid eller just efter bron
    (värld 1227 och 1731) är korrekt appbeteende. Motorn registrerar det som DESIGN.

## Familj E2: ETA-etappen (U20)

Den här etappen bygger vidare på familj E:s prototyp, commit e949ae1 (F04,
avgångskontexten).

Arbetsplats:
- worktree: K/E2/wt, detached på e949ae1;
- granskarens worktree: K/E2/rwt;
- leveranser: patch-e2.diff = git diff e949ae1 (bara E2) och
  patch.diff = git diff 7699cbe (E + E2).

**Mål:**
- **F06 (värld 192, XENIA):** inget fladder "strax → om 4 → strax" vid
  inbromsning. Orsaken är K6-dubbelkörningen, alltså dubbel EMA per AIS-fix.
- **F07 (20260708-21h, δ −11,52 s):** spärren ska inte hålla uppe appens egen
  extrapolering mot en färsk mätning. Kedjan är Fix G-extrapoleringen,
  burst-basen och sedan ETA_PUBLISH_CLAMP / ETA_ABSOLUTE_CLAMP /
  ETA_GROWTH_CAP. Varken 21h SISU ("om 10" → "om 3") eller 25h IDUN
  ("om 13" → "om 10") får bli sämre; designern av E prövade varianten F07a,
  och den gjorde dem sämre.

**Krav ur docs/ARCHITECTURE.md §8 (e) K6** (läs hela avsnittet och J10):
- **Dubbelkörningen bär oavsiktligt last.** Ett rent memo per fix gav
  +11,4 % absolutfel i bandet sanning < 5 min, och LINNEA-sågtanden och
  41h-svängningarna blev värre.
- **Ingen av följande delar får gå in ensam:**
  - ETA_GAP_RESET etablerar sin nya baslinje från senast publicerade värde;
  - outliergrindens 30 s-fönster blir kadensrelativt;
  - emaAlpha kalibreras EFTER de två ovan.
- **ACCEPTANS mäts med npm run measure:eta** (VALIDATION.md
  §ETA-mätharnessen, REGELN och K25-exemplet):
  - median absolutfel, andel ≤ 2 min och bias, i banden sanning < 5 min och
    < 10 min;
  - ALDRIG totalsumman;
  - LINNEA 265764760 (Klaffbron 2026-07-15) och 41h-svängningarna (8→14,
    10→16) ska bli lika bra eller bättre.
- **Facit:** golden-text-rader som flyttar bedöms mot rådata enligt U13.
  E:s sex omlåsta rader och M9-priset (SKONNERTEN) mäts om, eftersom de beror
  på den dubbla EMA:n.

Familj E:s andra revision pågår SAMTIDIGT i K/E/wt, med golvet på 4 kn vid
avgångens platå och dokumentationen. Ändra inte avgångskontexten i onödan. En
avslutande sammanslagning gör E och E2 till ett patch.

## Dirigentens beslut inför revision 3 (2026-11-05, för K, K2, N och M)

- **K, under bron-hållet (U17-läsningen).** En tyst båt som senast sågs högst 50 m från
  bron, i rörelse och med ankomst inom täckningen, hålls tills nästa position kommer.
  Det strider inte mot U17: hon är vid brolinjen och har i praktiken passerat (F03,
  F20). Hålls hon kvar efter nästa position släpps hon som förut.
- **K, korsningsankaret.** Inför granskarens W2: när fixet före bron visar en stilla
  eller köande båt bakåtextrapoleras korsningen ur fixet efter bron.
  - Räkna sedan om 25h-raden.
  - En låst rad får bara låsas om när den är RÄTTARE mot rådata (U13). En likvärdig
    rad ska undvikas genom designen, eller redovisas tydligt för dirigenten med
    alternativen.
- **K2, 60 s-golvet.** U15 gäller utan golvundantag: en returresa får egen varning även
  när mindre än 2 × TICK_INTERVAL_MS av den gamla täckningen återstår.
  - Visar du med belägg att det ger dubbla varningar för samma öppning, beskriv
    konflikten. Ändra då inte U15.
  - Frikoppla returminnet från händelsestädningen, som granskaren föreslår.
- **N, U21:s gräns.** U21 ("ingen sen notis för en returpassage under ett långt
  AIS-avbrott") betyder: släpp en returnotis bara om den kommer högst
  STALE_ETA_HARD_THRESHOLD_MS (10 min) efter den uppskattade korsningen. Korsningen
  interpoleras på glappsegmentet. Annars skickas ingen returnotis.
- **M.** Följ granskarens väg 1, alltså tidsbedömningen även för fartgrinden. Slinga-C
  får inte bli sämre: inför granskarens variant eller något likvärdigt.

## Användarbeslut 2026-11-07

- **U22 (E2, ETA-etappen).** E2 integreras INTE.
  - E2 tog bort F06 och F07 och gav ETA:n ett något bättre snitt, men 45 enskilda
    ETA-påståenden i banken blev sämre (21 i bandet < 10 min).
  - Beslutet följer U13.
  - F06 (ETA-oscillation vid inbromsning) och F07 (spärren mot extrapolering i 21h)
    står kvar som KÄND_ÖPPEN, med källorna U22 och ARCHITECTURE §8 (e) K6/J10.
  - Prototypen och mätningarna sparas i kampanj/E2 för en senare ETA-etapp.
