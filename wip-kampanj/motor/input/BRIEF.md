# Rättningsrunda för buggjägarens motor (2026-11-04)

Buggjägaren är ett testverktyg som BARA rapporterar fel i appen (ägarens beslut:
"Rapportera tänker jag, rättningen gör du senare"). v1 är byggd och har gett sin första
rapport. En oberoende granskning av motorn hittade 14 belagda motorfel (M01–M14), och
triagen av rapportens 20 kort pekade ut ytterligare motorpunkter. Rundan rättar MOTORN.
Appen rörs inte.

Förkortningar nedan:
- S = /tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad
- C = S/hunt-build/C/repo
- F = S/hunt-fix

## Platser

- **Arbetskopia (skriv här):** C. Det är en vanlig katalog, inte ett git-repo.
  `node_modules` är en symlänk till huvudträdet; skriv aldrig i den.
- **Huvudträdet** /home/user/io.ais.tracker (HEAD 7699cbe) är ENDAST för läsning. Skriv
  aldrig där och kör inget där som skriver (inte `npm test`, inte hunt).
- **Motorn:** C/tests/replay-validation/bugHunt/ (hunt.js, lib/, lib/oracles/, lib/lanes/,
  beslutsregister.json, calibration.json, canaries/, __tests__/). Dokumentationen ligger i
  C/docs/BUGGJAKT.md.
- **Ögonblicksbild före rundan** (orörd referens): F/pre/bugHunt och F/pre/docs/BUGGJAKT.md.
  Ändra den aldrig.
- **Underlag:**
  - F/input/motorgranskning.json: M01–M14 med fil, belägg och rättningsförslag.
  - F/input/triage.json: triagen av förra rapportens kort. Fälten 'note' och 'summary'
    nämner fler motorpunkter.
- **Granskarens sonder och körningar:** S/hunt-review/ (t10probe.js, regprobe.js,
  kieprobe.js, u2probe.js, pairprobe.js, driftprobe.js, f02probe.js, monh3.js, abcount.js,
  fakecards/, reuse/, runs/, ab/). Triagens finns i S/hunt-triage/ (variants/, scripts/,
  worlds/). Sonderna kan peka på granskarens egna kopior (hunt-review/repo, repo2). Peka
  om dem mot C, gärna via en kopia av sonden under F/tmp.
- **Förra standardkörningen** (referens, rör inte): S/hunt-build/C/out/standard/ med
  rapport.md, rapport.json och fynd/.
- **Egna tempfiler:** F/tmp/<ditt-namn>/ med TMPDIR satt dit. Nya körningar läggs i
  F/runs/<namn>/.

## Skrivgränser

Du får bara ändra filer under C/tests/replay-validation/bugHunt/ och C/docs/BUGGJAKT.md.
Allt annat i C ska vara oförändrat. `bash F/input/skyddskoll.sh` ska skriva OK; den
jämför C mot huvudträdet och den kända mängden avvikelser.

## Kommandon (kör från C)

- **jest för motorn:**
  `TMPDIR=F/tmp/<namn> npx jest --config tests/jest.config.js --detectOpenHandles --cacheDirectory=S/hunt-build/C/jest-cache --testPathPatterns=bugHunt/__tests__/`
- **lint:** `npx eslint --max-warnings=0 tests/replay-validation/bugHunt/`
- **självtest:** `node tests/replay-validation/bugHunt/hunt.js --selftest --out=F/runs/<namn>`
- **quick:** `node tests/replay-validation/bugHunt/hunt.js --profile=quick --out=F/runs/<namn>`
  (cirka 1,5 min)
- **standard:** `node tests/replay-validation/bugHunt/hunt.js --out=F/runs/<namn>` (cirka
  5 min på 4 CPU)
- **Ett fynd:** `node tests/replay-validation/replayRunner.js <fynd>/repro.jsonl`, sedan
  `node tests/replay-validation/bugHunt/hunt.js --repro <fynd>`

`--out` måste ligga utanför repot eller vara git-ignorerad. F/runs ligger utanför.

## Regler

- **Appen och den delade harnessen ändras ALDRIG.** Det gäller app.js, lib/, drivers/,
  settings/, app.json, .homeycompose/ och alla tests/replay-validation/*.js utanför
  bugHunt/, till exempel invariants.js, replayRunner.js och runAllCorpora.js. Motorn
  rapporterar bara.
- **"Motorfel: rätta motorn, aldrig registret"** (BUGGJAKT §15). En post i
  beslutsregister.json får bara läggas till eller ändras för ett DOKUMENTERAT ägarbeslut
  eller en mätgräns i ett befintligt orakel. Den ska ha källhänvisning (fil:rad eller §).
  Varje registerändring förs in i BUGGJAKT.md:s lista över registerändringar som ägaren
  ska granska. Finns ingen sådan lista, skapa den i §7.
- **Varje rättning får ett jest-fall som den gamla motorn fäller och den nya klarar.**
  Pröva mot ögonblicksbilden F/pre/bugHunt, till exempel genom att kopiera C till
  F/tmp/<namn>/old och lägga den gamla filen där. Ange i svaret hur du visade det.
- **Motorns jest-sviter ska ta under 5 s tillsammans** och får inte lämna öppna handtag.
  `--detectOpenHandles` gör att en läckt timer ger evig häng.
- **Determinismen får inte brytas.** Samma seed och profil ska ge identisk rapport.json,
  utom tidsblocket. Data som hamnar i rapporten får inte bero på väggklocka, Math.random
  eller mängdordning.
- **Kommentarer och dokumentation skrivs på svenska.** Uppdatera BUGGJAKT.md där
  beteendet ändras, till exempel §4.2, §7, §8, §9, §16 och bilaga B.
- **Acceptanskriterierna i BUGGJAKT §14 ska fortfarande hålla**, om inte en rättning visar
  att ett kriterium byggde på motorfelet. Skriv då det uttryckligen. Kriterierna är:
  - konvojfönstrets bakkant (T2 LEDTID<60s, R0, gräns vid CONVOY_WINDOW_MS);
  - KONFLIKT INV5-VS-BESÖKSREGEL;
  - bankkorten för 13h och 21h (KNIVSEGG);
  - 42h-flashens fasvariant som ACCEPTERAD via KIE-PER-KORPUS;
  - högst 25 kort;
  - grönt självtest: determinism, SHIFT30 och MMSI 24/24, kanarier 5/5, rundresa utan
    avvikelser.
- **Använd inte git stash.** Radera inget utanför F/tmp och F/runs.
- **Andra agenter kan arbeta i samma kopia samtidigt.** Se ägarlistan i din uppgift. Ändra
  inte deras filer; behöver du det, beskriv ändringen i svaret i stället. Ett rött test i
  en fil du inte äger kan vara någon annans pågående arbete. Kör om innan du drar
  slutsatser.

## Containeromstart 2026-11-04 cirka 20:40 UTC

Containern startades om mitt i runda 3. Det avbrutna försöket hade redan
ändrat följande i C mot F/pre3:
- lib/registry.js
- beslutsregister.json
- __tests__/h-efterratt.test.js
- docs/BUGGJAKT.md
- den nya filen __tests__/i-runda3.test.js

Gör så här innan du fortsätter:
1. Granska ändringarna med diff -ru F/pre3/bugHunt C/tests/replay-validation/bugHunt.
2. Behåll det som är rätt och slutför resten, eller återställ filen ur F/pre3.
3. Skriv i ditt svar vad du valde.
