# Överlämning 2026-11-13: analysera fältprovet och rätta det som hittas

Det här dokumentet lämnar över arbetet med Homey-appen io.ais.tracker till en ny chatt som
körs lokalt i VS Code. Läs hela dokumentet innan du börjar. Det förutsätter inget minne av
den tidigare chatten.

## 1. Uppdraget

Ägaren har kört **två fältprovskörningar** under några dagar på sin egen Homey. Du ska:

1. **Gå igenom loggarna** från båda körningarna (avsnitt 4).
2. **Triagera** varje avvikelse: appfel, beslutat beteende eller känd gräns, eller mätartefakt.
3. **Rätta appfelen**, med ett regressionstest per fel (avsnitt 6).
4. **Ta hand om det som är kvar** från den tidigare chatten (avsnitt 7), i den ordning ägaren vill.
5. **Låsa körningarna som korpus** om grindarna i `docs/VALIDATION.md` §Fältprov är gröna.

Rapportera först vad loggarna visar, kort och i prioritetsordning, innan du börjar rätta.
Tydliga fel rättar du utan att fråga. Val som gäller hur appen ska bete sig är ägarens
(avsnitt 6.4).

**Om ägaren:** svara på svenska, kort och utan kodjargong. Beskriv ett fall som en konkret
situation ("en båt ligger stilla 157 m från bron och …"), ge alternativ och en rekommendation.
Ägaren har tidigare bett om paus när veckogränsen för användning når 95 %.

## 2. Läget just nu

| Sak | Värde |
|---|---|
| Gren | `claude/wonderful-wozniak-yhk4kz`, HEAD `e51c7b6` |
| Mot main | 27 commits före `main` (`6dc2947`, 2026-10-05). Ingen PR finns, och ingen har begärts. |
| Senaste ändring i appens kod | `25862ee` (2026-11-09). Commits därefter rör bara tester, buggjägaren och dokument. |
| Appversion | 5.4.0 i `.homeycompose/app.json`, oförändrad |
| Fältprovet | Kördes på grenens appkod. Bekräfta med ägaren vilken commit som var utcheckad. |

Grenarna `origin/VSCode` och `origin/fix/ghost-vessel-and-eta-bugs` är gamla (september) och
ska inte användas. Fortsätt på `claude/wonderful-wozniak-yhk4kz` eller en gren ur den. Ägaren
avgör när något slås ihop med `main`.

**Vad som gjordes i den tidigare chatten (3–10 november):**
- En genomgång av tillförlitlighetskritiska vägar, med rättningar och kodstädning.
- En buggjägare som letar appfel offline och bara rapporterar (`npm run hunt`,
  `docs/BUGGJAKT.md`).
- Två rättningsvarv på buggjägarens fynd, familj för familj, med adversariell granskning.
  Utfallet står i `docs/buggjakt-triage-2026-11-04.md`.
- Ägarbesluten U13–U27 (avsnitt 8).

**Kontrollerat på `e51c7b6`:**
- jest: 376 sviter, 5 469 test gröna, 2 överhoppade; lint rent.
- `replay:all`: 24 korpusar (485 h fältdata) matchar facit; `replay:synthetic`: 83 scenarier
  rena; `replay:openings` och 72 h-soaken med monitoring gröna.
- Buggjägaren: självtestet grönt. Standardkörningen (seed 1) ger **5 kandidatkort, alla
  INV-3 ETA**. Det är baslinjen: nya kort efter en ändring ska triageras.

**Mätvärden på den låsta banken (2026-11-09), att jämföra fältprovet mot:**
- Varning före passage: 376 av 378 passager som appen bokförde (99,5 %). Mot rådatafacit minst
  392 av 447 (88 %), 37 med okänd ordning och 18 säkra missar.
- Ledtid: median 14,8 min, p10 5,2 min. Sju varningar kom under den utlovade ledtiden
  (150 s), alla vid Stridsbergsbron.
- Av 438 varningar följdes 229 av en passage inom 20 min, 117 senare (median 33 min) och 92
  inte alls. Klasserna heter GARANTIPRIS, AVBRUTEN_APPROACH och GLES_ANFLYGNING i
  `runOpeningGates.js` och är godtagna.
- ETA: medianfel 1,51 min, p90 21,7 min, bias −14,9 min (för optimistisk). Stridsbergsbron är
  sämst: median 3,48 min och 39,6 % inom 2 min.

## 3. Läs först

1. `CLAUDE.md`: kommandon, regler och fallgropar.
2. `docs/VALIDATION.md`: "Batteriet", "Facit-fällan", "Fältprov / ny korpus" och
   "ETA-mätharnessen".
3. `docs/buggjakt-triage-2026-11-04.md`: "Rättningskampanjens utfall (2026-11-07)",
   "Rättningskampanjens varv 2 (2026-11-09)" med ägarens beslut efter varvet, och
   "Beslutsfrågor".
4. `docs/ARCHITECTURE.md`: target-livscykeln, öppningsvarningarna (släppvägen, punkt (a)–(d)),
   förtöjningslagren och de kända gränserna.
5. `docs/BUGGJAKT.md`: §7 (beslutsregistret), §15 (så triagerar du ett kort) och bilaga A.9.
6. `docs/bridgeTextFormat.md` och `docs/reliability-spec.md`.

## 4. Fältprovets loggar

### 4.1 Var filerna finns

`run-with-logs.sh` skriver live i `~/.ais-tracker-logs/` och synkar till loggarkivet. Arkivet
är `../logs` (bredvid repot) om den mappen finns, annars `dirigent/logs` i repot. Båda är
git-ignorerade. Varje körning ger tre filer med samma tidsstämpel:

- `app-<tid>.log`: appens logg.
- `ais-replay-<tid>.jsonl`: AIS-samplen, härledda ur loggen. Det är indata till replay.
- `bridge-text-summary-<tid>.md`: sammanfattning med avsnittet "Logg-integritet".

Filen `ais-replay-<tid>.appside.jsonl` är appens egen fångst och inget facit. Fråga ägaren
vilka två tidsstämplar som gäller om det finns fler körningar i mappen.

**Loggarna får aldrig committas.** Repot är publikt. Bara det som korpuslåsningen i
`docs/VALIDATION.md` föreskriver läggs i repot.

### 4.2 Gör så här, per körning

1. **Integriteten.** Läs sista raden i summaryns "Logg-integritet". Kör sedan:
   ```bash
   node tests/replay-validation/checkReplayIntegrity.js <jsonl> <logg>
   ```
   En körning med FEL får analyseras som fältbevis men aldrig bli facit.
2. **Hel-loggsjämförelsen** mellan fältet och replay:
   ```bash
   npm run replay:field -- <app.log> <ais.jsonl> <utkatalog>
   ```
   `field-report.txt` summerar och `field-report.json` har varje par av notiser (text, ETA,
   källa, riktning, tid), öppningsvarningarna, invariantutslagen, rådatafacit och
   källtäckningen. Rapporten är informativ och ändrar inte exitkoden.
3. **Replay av körningen**, vid behov med appens logg:
   ```bash
   node tests/replay-validation/replayRunner.js <jsonl>
   ```
   ```bash
   REPLAY_VERBOSE=1 REPLAY_DEBUG_LEVEL=full node tests/replay-validation/replayRunner.js <jsonl>
   ```
4. **Driften i loggen.** Sök efter `[APP ERROR]`, `uncaughtException`, `unhandledRejection`,
   `FEED_WATCHDOG`, återanslutningar, källbyten mellan AISStream och AISHub, läget
   "Degraderad", `[INTEGRITET]` och `[REPLAY-VAKT]`. Diagnostikraden `[GPS_JUMP]` loggas som
   APP ERROR med avsikt och är inget fel.
5. **Varje öppningsvarning.** Kom en passage efter den, och hur långt efter? Kom varningen
   efter passagen? Fanns en passage utan varning? Jämför med klasserna i
   `tests/replay-validation/runOpeningGates.js`.
6. **Varje notis och brotext.** Stämmer texten med `docs/bridgeTextFormat.md`? Finns spöktext,
   frusen nedräkning eller falskt "Inga båtar"? Invarianterna i
   `tests/replay-validation/invariants.js` är måttstocken.
7. **Fassvepet**, med och utan monitoring:
   ```bash
   npm run replay:phase -- <jsonl>
   ```
   ```bash
   REPLAY_MONITORING=1 npm run replay:phase -- <jsonl>
   ```
8. **Korpuslåsning** enligt `docs/VALIDATION.md` §Fältprov, när integriteten är OK: lägg
   körningen i `tests/replay-validation/corpora.js` som olåst, bygg rådatafacit, granska facit
   mot rådata och lås först därefter. Läs "Facit-fällan" innan du låser något.

### 4.3 Det som replay inte visar

Jämförelsen spelar inte upp monitoring- och stale-svepet, avvisade fusionsfixar, livstecken
eller den första sparningen av inställningar. Sådant måste läsas direkt i appens logg. Varje
start av `run-with-logs.sh` är dessutom en omstart av appen, och resetillstånd och
öppningsarmar sparas inte över omstarter (posterna OMSTART-… i beslutsregistret).

I november går det mest yrkestrafik i kanalen. Fritidsbåtarnas fall (gles klass B, kö vid
Kajen, Gästhamnen) syns därför troligen lite i körningarna. Skriv i rapporten vad
körningarna faktiskt täcker.

## 5. Titta särskilt efter

Det här är första gången koden från 3–9 november körs på en riktig Homey. Fältproven har
hittills alltid visat nya fel. Granska särskilt de mekanismer som ändrades:

| Commit | Ändring | Risk att leta efter |
|---|---|---|
| `811c723` | Målbron sätts i samma tick som en bekräftad vändning | Falsk varning vid en GPS-utliggare med vänd kurs. Känd gräns: en utliggare bakom Järnvägsbron kan ge ett kort falsklarm för Klaffbron. |
| `b6a4002` | En återfödd båt med kurs i dödbandet får målbro ur förflyttningen | Fel målbro efter ett AIS-glapp |
| `c798e9b` | U23: en köare vid Kajen norr om Klaffbron står kvar i texten | Båtar som blir stående i texten för länge, eller en kajavgång som missas |
| `b38eabc` | Bakkantens färskhet, krypfart och U24 (egen varning före första passagen) | Extra varning i en köande konvoj (godtaget), eller en varning som uteblir |
| `25862ee` | Spärren vid en tidigare bro, efter bron vid onormal tystnad | För tidiga eller sena varningar vid Stridsbergsbron när Järnvägsbron ligger emellan |
| `aa71099` | U14: notis även för en returpassage | Dubbla notiser när en båt vänder och väntar nära linjen |
| `2c3f778` | U15: returresan får en egen öppningsvarning | Extra eller utebliven varning efter en U-sväng |
| `f198d52` | RECOVER-släppet, konvojens bakkant och passagetiden efter glapp | Varning efter passagen, eller varning på en gammal position |
| `e088a51` | Krypfart förbi en passerad bro behåller målbron | Målbron fladdrar, och texten blinkar "Inga båtar" |
| `8a013d5` | Avgångs-ETA följer accelerationen | ETA som hoppar vid avgång ur en kö |

Leta också efter det som bara drift visar: minne och CPU över dygn, timers som driver,
långsamma skrivningar till Homey, notiser som inte kvitteras och beteendet de första
minuterna efter en omstart.

## 6. Så rättar du

### 6.1 Arbetsgång per fel

1. **Reproducera** ur fältets jsonl, helst som ett litet utsnitt, och bekräfta mekanismen i en
   verbos logg.
2. **Skriv ett regressionstest som fäller koden före rättningen.** Lägg fallet som syntetiskt
   scenario i `tests/replay-validation/runSyntheticScenarios.js` när det beror på placering
   eller gles AIS, och uppdatera då antalet i `docs/VALIDATION.md` (83 i dag).
3. **Gör den smalaste rättningen** och leta efter systerställen med samma mönster.
4. **Uppdatera dokumentationen** i samma commit: `docs/ARCHITECTURE.md` där beteendet beskrivs,
   och kommentarerna i koden.
5. **Kör batteriet** (6.2) och buggjägaren (6.3).
6. **Låt en oberoende granskare pröva varje ändring i logiken.** I den tidigare chatten hittade
   granskningarna verkliga fel i nästan varje rättning, fel som testerna inte såg.
7. **Committa per mekanism**, med meddelande på svenska, och pusha när batteriet är grönt.

### 6.2 Batteriet

Kör allt efter varje ändring i status-, notis-, text- eller livscykellogik. Varje steg ska ge
slutkod 0, och `git status --porcelain` ska vara tom efteråt.

```bash
npm test
```
```bash
npm run lint
```
```bash
npm run replay:all
```
```bash
REPLAY_MONITORING=1 npm run replay:all
```
```bash
npm run replay:synthetic
```
```bash
npm run replay:openings
```
```bash
node tests/replay-validation/runSoak.js
```
```bash
npm run replay:monitoring
```
```bash
npm run replay:phase
```
```bash
REPLAY_MONITORING=1 npm run replay:phase
```
```bash
npm run hunt:selftest
```
```bash
npm run hunt:quick
```

På Windows sätts miljövariabeln annorlunda (i PowerShell `$env:REPLAY_MONITORING=1`), och
`npm run validate` fungerar inte där.

### 6.3 Buggjägaren

- `npm run hunt:quick` tar cirka 1,5 min och `npm run hunt` (standard) cirka 5 min. Utdata
  hamnar i den git-ignorerade mappen `dirigent/hunt/`.
- Baslinjen är 5 kandidatkort, alla INV-3 ETA. Ett nytt kort triageras enligt
  `docs/BUGGJAKT.md` §15.
- `npm run hunt:repro -- <fyndkatalog>` kör om ett sparat fynd mot aktuell kod.
- Motorn ändrar aldrig beslutsregistret. En ny post kräver ett ägarbeslut med källa i `docs/`,
  ett smalt predikat, test åt båda hållen och mutationsprov (mönstret finns i
  `tests/replay-validation/bugHunt/__tests__/l-u25-u26.test.js` och i BUGGJAKT bilaga A.9).

### 6.4 Regler

- **U13: facit låses om bara när rådatan visar att utfallet blir rättare.** Blir ett utfall
  sämre är designen fel.
- **Domänbeslut är ägarens.** Fråga med en konkret situation, alternativ och rekommendation.
  Skriv beslutet i triagedokumentet och i `docs/ARCHITECTURE.md` med nästa nummer (U28 och
  framåt), och i `docs/BUGGJAKT.md` §7 om registret berörs.
- Använd inte `git stash`. Redigera aldrig `app.json` direkt, bara `.homeycompose/`.
- Ändra aldrig textformat utan att köra brotext-testerna.
- Hänger `npm test` är det ett öppet handtag. Leta upp det i stället för att vänta.
- Ge inte jest en cachekatalog inne i repot. Några test är känsliga för
  `git status --porcelain`.
- Radiebeslut och liknande konstanter är dokumenterade i `docs/`. Läs där innan du
  ifrågasätter dem.

## 7. Kvar från den tidigare chatten

I den ordning jag skulle ta dem, efter att fältprovets fel är rättade:

1. **Konvojfrågan (C-IV).** Ägaren sköt upp den till efter fältprovet, så den är aktuell nu.
   Två regler går inte att uppfylla samtidigt när flera båtar går mot samma bro med några
   minuters mellanrum: en varning per öppning (U2), och en varning i tid för varje båt.
   Alternativen är (a) U2 gäller, (b) varje båt varnas i tid och en extra varning tillåts,
   (c) en varning per båt och öppning. U24 var ett litet steg mot (b). Underlaget står i
   triagedokumentets beslutsfråga 5–6 och i `docs/etapp7-plan-2026-08-08.md:310–349`. Ett
   beslut flyttar låst facit och kräver omlåsning enligt `docs/ARCHITECTURE.md`.
2. **ETA (U22, uppskjutet).** Buggjägarens fem kort gäller ETA som hoppar upp och ner (INV-3
   SÅGTAND och OSCILLATION). En prototyp (E2) prövades men integrerades inte, eftersom 45
   enskilda ETA-påståenden i banken blev sämre. Varje ändring i ETA-vägen ska mätas mot
   baslinjen med `npm run measure:eta` (REGELN i `docs/VALIDATION.md`). Prototypen ligger på
   WIP-grenen (avsnitt 9).
3. **Tidiga varningar och varningar utan passage.** 27 % av varningarna kom långt före
   passagen och 21 % följdes inte av någon. Det är godtaget i dag men är den största
   begränsningen för användaren. Fältdatan kan visa om något går att vinna, och ett byte av
   avvägning är ett ägarbeslut.
4. **Kända gränser som inte är åtgärdade:**
   - En helt stilla båt 300–500 m från sin målbro tappar målet efter 20 min. U27: behålls
     tills fallet syns i fält. Se om det syns i loggarna.
   - Spärren vid en tidigare bro har ett restfönster: ett köfix under 2,8 kn strax efter
     tystnadsgränsen.
   - Rimlighetskravet vid kajavgång tillåter 131 m på 3 min i 0,6 kn.
   - Grannfallen vid återfödelse (ARCHITECTURE, känd gräns e).
   - En omstart mitt i en anflygning kan tappa varningen, eftersom öppningsarmar och
     resetillstånd inte sparas.
   - Posterna med klassen KÄND_ÖPPEN i
     `tests/replay-validation/bugHunt/beslutsregister.json`.
5. **Buggjägaren själv:**
   - Posten U17 prövar inte när täckningsslutet kom. Med täckningsslutet avsiktligt två
     minuter för sent godtog U17 15 av 18 nya utslag (BUGGJAKT §7 och bilaga A.9). En sådan
     försämring i appen kan alltså delvis gå obemärkt förbi. Inte åtgärdat.
   - Radhänvisningarna till `docs/ARCHITECTURE.md` i beslutsregistrets källfält har glidit
     för de äldre posterna. Det är en skönhetsbrist.
   - Beslutsfråga 4 (INV-10:s granularitet): en gles fältkorpus med lång köväntan kan ge
     falskt rött i `replay:all`. Det kan bli aktuellt när de nya körningarna låses.
   - Beslutsfråga 7: fassvepet flyttar bara ankarraden, inte hela korpusen.
6. **Släpp.** Ägaren har sagt att "produktion" tills vidare betyder den egna Homeyn. När
   versionen ska släppas behövs ett nytt versionsnummer i `.homeycompose/app.json` och en rad
   i `.homeychangelog.json`. Efter ett godkänt fältprov installeras appen permanent med
   `homey app install`.
7. **På längre sikt:** `app.js` är 13 700 rader och `lib/services/VesselDataService.js`
   9 600 rader. Flera rättningar har själva behövt rättas efter granskning. En förenkling
   skulle göra framtida ändringar billigare, men är ett eget arbete.

## 8. Ägarens beslut i korthet

Motiv och källor står i `docs/ARCHITECTURE.md`, `docs/BUGGJAKT.md` §7 och triagedokumentet.

| Beslut | Innebörd |
|---|---|
| U13 | Facit låses om bara med rådatabelägg. |
| U14 | En verklig returpassage över en bro får en egen notis. |
| U15 | Returresan är en egen öppning och får en egen varning. |
| U16 | "Strax" visas aldrig på en position som är äldre än 10 min. |
| U17 | Säkerhetsvarningen för en tyst båt behålls, även om den kan komma sent. |
| U18 | Två positioner krävs innan en vändning tros. |
| U19 | En planerad varning skickas även när en obekräftad vändning väntar. |
| U20, U22 | ETA-etappen prövades men integrerades inte. ETA-arbetet är uppskjutet. |
| U21 | Ingen sen returnotis efter ett långt AIS-avbrott (mer än 10 min efter korsningen). |
| U23 | En båt på väg mot Klaffbron som stannar vid Kajen står kvar tills hon kör vidare, sänder navstatus 1 eller 5, eller har legat stilla i 2 h. |
| U24 | En båt i rörelse, mer än 350 m från bron, i en händelse utan bokförd passage får en egen varning när hennes egen tidsfrist går ut. En köande konvoj kan då få en extra varning. |
| U25 | En varning efter passagen godtas när händelsens första passage bokfördes för sent och appen saknade tidigare underlag. |
| U26 | En stilla köande båt som U24 inte omfattar får täckningsslutets sena varning när avgången inte hördes. |
| U27 | En stilla båt 300–500 m från målbron tappar målet efter 20 min. Behålls tills fallet syns i fält. |

Öppet: konvojfrågan (avsnitt 7, punkt 1).

## 9. Arbetsmaterial från den tidigare chatten

Grenen `claude/wonderful-wozniak-yhk4kz-wip` innehåller arbetsmaterial, inte produktkod, under
`wip-kampanj/`. Den ska aldrig slås ihop med något. Läs filer direkt ur git:

```bash
git fetch origin
```
```bash
git show origin/claude/wonderful-wozniak-yhk4kz-wip:wip-kampanj/RESUME.md
```

Där finns bland annat:
- `OVERLAMNING.md`: det här dokumentet.
- `RESUME.md`: löpande statusanteckningar.
- `KAMPANJ.md` och `varv2/KAMPANJ2.md`: uppdragen till rättningsfamiljerna.
- `varv2/GRANSKNING2.md`: uppdraget till de adversariella granskarna.
- `varv2/<A–G>/`: design, resultat, granskningar och patchar per familj.
- `varv2/tA/` och `varv2/tB/`: triagen värld för värld.
- `E2/`: ETA-prototypen som inte integrerades.
- `skript/battery.sh`: batteriet som ett skript.

## 10. Förslag på första steg

1. Kör `git status` och `git log --oneline -3`, och kontrollera att du står på
   `claude/wonderful-wozniak-yhk4kz` vid `e51c7b6` eller senare.
2. Fråga ägaren var de två körningarnas filer ligger om de inte finns i `../logs` eller
   `dirigent/logs`.
3. Gör steg 1–7 i avsnitt 4.2 för båda körningarna.
4. Ge ägaren en kort rapport: vad körningarna täcker, vad som fungerade, och fynden i
   prioritetsordning med förslag på åtgärd.
5. Rätta enligt avsnitt 6, och gå sedan vidare med avsnitt 7.
