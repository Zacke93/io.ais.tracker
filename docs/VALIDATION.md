# VALIDERINGSKÖRBOK — så vet du att appen fortfarande är korrekt

Skriven 2026-07-06 (helgranskningens teststärkning). Detta är den praktiska
handboken för att köra, tolka och underhålla valideringsbatteriet — utformad
för att fungera utan att någon minns historiken. Arkitekturen står i
`ARCHITECTURE.md`; textformatet i `bridgeTextFormat.md`.

## De två pelarna (vad allt vaktar)

1. **bridge_text** är alltid korrekt och aktuell — aldrig spöktext, frusen
   nedräkning eller falskt "Inga båtar".
2. **boat_near** avfyras exakt EN gång per fartyg+bro-passage — ingen missad,
   ingen dubblett.

## Batteriet — kör ALLTID allt efter varje ändring i status-/notis-/text-/livscykellogik

```bash
npm run validate          # jest + korpusar + syntetiska scenarier (~3 min)
npm run validate:full     # ovan + 72h-soaken (~10 min) — före commit/publicering
```

Eller stegen var för sig:

| Steg | Kommando | Grönt betyder |
|---|---|---|
| Enhetstester | `npm test 2>&1 \| tail -5` (**pipa alltid** — annars ENOSPC) | 900+ tester passerar |
| | ⚠️ **Pipe-fällan** (ChatGPT-granskningen 2026-07-10, B1): pipens exitkod är `tail`:s (≈alltid 0) — LÄS `Tests:`-raden, lita inte på `$?`. `npm run validate` är immun: den skriver jest-utdatan till en tempfil och propagerar jest:s riktiga exitkod. | |
| Korpusarna | `npm run replay:all` | 11 låsta korpusar (~150 h verklig AIS) ger EXAKT facit-antal notiser + exakt (mmsi,bro)-fördelning + exakt (mmsi,bro,riktning)-fördelning + EXAKT bridge_text-transitionsström (golden-text/) + alla invarianter |
| Syntetiska | `npm run replay:synthetic` | 44 scenarier (gap, U-svängar, GPS-hopp, kajliggare, sog=null, omstart, 2h-prune-stillaliggare …) håller sina kontrakt. OBS: "rena" = inga FATALA utslag; WARN-invarianter (t.ex. INV-18) är informativa och fäller inte. |
| Soaken | `node tests/replay-validation/runSoak.js` | 72 h blandtrafik: 0 processfel, inga läckor, fatala invarianter rena |
| Lint | `npx eslint <ändrade filer>` (per fil — OneDrive gör helträd långsamt) | 0 fel |

**Rött är alltid på riktigt.** Batteriet har inga kända flakiga tester.
Om en låst korpus avviker har du en regression i pelarna — börja där.

## Facit-fällan (den viktigaste regeln)

Korpusarnas facit ÄR sanningen tills du bevisat motsatsen i rådata. Om en
ändring flyttar en korpussiffra:

1. **Anta regression.** Rulla inte facit för att bli grön.
2. Öppna korpusens `ais-replay-*.jsonl` och följ det avvikande fartyget
   sampel för sampel. Harnessen läser `tests/replay-validation/corpora-data/`
   (byte-exakta repo-kopior sedan 2026-07-10 — replay:all fungerar i ren
   checkout); appens fullständiga körloggar (`app-*.log`) för djupare
   rotorsaksanalys ligger kvar i det externa arkivet `../logs/`. Ny korpus:
   kopiera jsonl:en OFÖRÄNDRAD till corpora-data/ (samma bytes = samma facit).
3. Endast om rådatan BEVISAR att det nya utfallet är korrekt (t.ex. en notis
   som produktionsversionen bevisligen missade) får facit låsas om — och då
   med motivering i `tests/replay-validation/corpora.js` + uppdaterad
   fördelningspost i `corpora-distribution.json` (låst korpus utan
   fördelningspost är numera ett hårt fel).
4. **Riktnings- och golden-text-faciten** (2026-07-10): utöver (mmsi,bro)-
   multiseten låses även (mmsi,bro,riktning)-multiseten
   (`corpora-direction-distribution.json`) och HELA bridge_text-
   transitionsströmmen (`golden-text/<korpus>.json`). Vid en medveten,
   rådataverifierad beteendeändring: kör
   `REGEN_DISTRIBUTIONS=1 npm run replay:all` — skriptet vägrar skriva om
   någon låst korpus inte är grön i övrigt, och du MÅSTE granska diffen i
   golden-filerna som vilken facit-omlåsning som helst (git diff visar
   exakt vilka texter som ändrats).

Exempel på att fällan fungerar: helgranskningens ETA-gap-omordning gav
"ärligare" värden men korpusbelagd fatal sågtand (2→32 min i texten) —
batteriet fällde den, fixen togs tillbaka.

## Invarianterna — facit-oberoende sanningar

`tests/replay-validation/invariants.js` körs på varje replay. Fatala:
grammatik (INV-1), notisdubbletter/tokens (INV-2), **räkningsbaserade INV-5/7**
(varje registrerad målbropassage kräver sin EGEN notis i tid — även
returpassagen av samma bro), sluttext (INV-6), namn (INV-8), distans (INV-11),
läckage (INV-12), ETA-fysik (INV-16). WARN (informativa): INV-15/17/18.
Domarlogiken har EGNA enhetstester i `tests/replay-invariants-unit.test.js` —
ändrar du en invariant, uppdatera dem.

Kända legitima WARN: 2 st INV-18 i soaken (Strids 19→27 min vid modellerad
inbromsning; var 3 före Fable-granskningen 2026-07-10b — E-1-fixen tog en) —
dokumenterade, ignorera. Korpusnivå: INV-18 i 19h/13,5h + INV-15 i 21h
(AKIRA, dokumenterad i corpora.js) är förexisterande och informativa.

## Fältprov / ny korpus (så samlas verklighet in)

1. Sätt appens inställning **`debug_level` = `full`** — annars loggas inga
   `[AIS_REPLAY_SAMPLE]`-rader och jsonl-filen blir TOM (skriptet varnar
   högljutt efter 2 min).
2. `./run-with-logs.sh` — kör ~1 dygn. Live-loggen skrivs LOKALT
   (`~/.ais-tracker-logs/`, immunt mot OneDrive-synkstall — fältprov 4 tappade
   4 min loggrader när tee-röret skrev direkt i molnmappen) och synkas till
   `logs/` var 10:e minut + vid avslut. Ger `logs/app-*.log` +
   `logs/ais-replay-*.jsonl`.
3. **Kontrollera logg-integriteten**: summaryn (`bridge-text-summary-*.md`)
   har sektionen "Logg-integritet (håldetektor)". Står det TIDSHÅL där är
   körningen OFULLSTÄNDIG — den kan analyseras som fältbevis men får ALDRIG
   korpuslåsas (facit i hålet är overifierbart; jsonl:en saknar samples).
   Skriptet larmar också live om loggfilen slutar växa >3 min.
4. Analysera: jämför loggens notiser/texter mot förväntat beteende;
   replaya jsonl:en: `node tests/replay-validation/replayRunner.js <jsonl>`.
5. Lås som korpus (KRÄVER "Logg-integritet: OK" från steg 3): post i
   `corpora.js` (id, jsonl-sökväg, timmar, facit-antal, locked: true,
   motiveringskommentar) + fördelningsmultiset i
   `corpora-distribution.json` (genereras från en verifierad körning).

## Kända fällor för den som skriver nya tester

- **Fältlistorna (3 st!):** `_createVesselObject` (VDS), `vesselSnapshot`
  (VDS, removal) och BridgeText-PROJEKTIONEN (`app.js
  _findRelevantBoatsForBridgeText`). Nio historiska offer. Vakter:
  `SNAPSHOT_CONSUMED_FIELDS` (tests/namnkedjan-b1.test.js) och
  projektionsvakten med automatiskt källsvep
  (tests/helgranskning-2026-07-06.test.js) — den senare FALLER om
  textmotorn börjar läsa ett fält som projektionen inte bär.
- **TEST_MODE-no-op:en:** `_triggerBoatNearFlow` returnerar direkt i jest.
  För att testa den RIKTIGA notisvägen: sätt `process.env.NODE_ENV =
  'production'` + `global.__TEST_MODE__ = undefined` i beforeEach (mönster i
  rc-s-connection-hardening + helgranskning-2026-07-06-sviterna) — och
  återställ i afterEach.
- **Svälj-fällan:** notisvägen fångar interna fel. Assertera
  `expect(app.error).not.toHaveBeenCalled()` i "vägen-passerar"-tester,
  annars är gröna tester förenliga med ett kraschande flöde.
- **Replay-init:** `app.onInit()` MÅSTE köras under `__TEST_MODE__=true`
  (stäng av EFTER init) — annars startar monitoring-timers som ändrar
  replaybeteendet.
- **Dokumentationstester:** block märkta "⚠️ DOKUMENTATIONSTEST" exekverar
  inte produktionskod — de låser avsedd semantik som specifikation. Lita
  aldrig på dem som regressionsskydd; det gör korpusarna.
- **Fake-klocka-fällan:** med frusen jest-klocka kan "oförändrat värde"-
  assertions vara vakuösa (två vägar ger samma tidsstämpel). Diskriminera
  via loggutslag eller tvinga den gren som ska testas (mönster:
  ELIMINATION_PROTECTION-testet i bug-fixes-regression).

## Coverage-spärren

`npm run test:coverage` (pipa!). Trösklarna i `tests/jest.config.js` är ett
GOLV som aldrig sänks — höj dem när ny täckning landat.
