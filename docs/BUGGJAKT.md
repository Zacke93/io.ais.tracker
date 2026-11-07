# BUGGJAKT.md — buggjägaren v1 (en motor som bara rapporterar)

Status: **v1 byggd 2026-11-04 mot HEAD 7699cbe.** Filen beskriver vad v1 faktiskt gör. Avvikelser från designen står i §16, det som inte är byggt i §12, och uppmätta värden i bilaga A.
Underlaget är fyra kartläggningar (harness, orakel, generering, felinjektion), tre konkurrerande designer och två domare. Domarna valde sanningsmotorn som grund, med de bästa delarna från mutations- och sökdesignerna.

## 1. Syfte och ramar

Ägarens mål: en motor som på egen hand hittar fel genom korpusen, så att appen inte behöver köras live, loggas och felsökas i efterhand. Motorn skapar syntetiska data ur banken och dömer den riktiga appen mot en sanning som motorn själv känner.

Beslut som gäller v1:
- **Motorn rapporterar bara.** Den rättar ingenting, låser aldrig om facit, sätter aldrig `REGEN_DISTRIBUTIONS` (eller någon annan `REGEN_*`) och ändrar inte beslutsregistret. Rättningar görs separat efter triage.
- **Ingen passiv inspelning.** Underlaget är de 24 låsta korpusarna (485 h, 18 679 rader) plus syntetik som härleds ur deras fördelningar.
- **Offline.** Motorn gör inga nätverksanrop, schemalägger inget och använder inga externa tjänster. Replayharnessen nätisolerar redan appen: WS-stubb, kastande https och `ais_api_key = null`.
- **Ett fynd är en kandidat.** Rapporttexten kallar det aldrig en bugg förrän ägaren har triagerat det.
- **Motorn ingår medvetet inte i `npm run validate`.** Den är ett diagnosverktyg, inte en grind (samma skäl som för korpuslåsningens grindar). Exitkoden är 0 när motorn körde klart, även med fynd, 2 vid självtest- eller motorfel (och när git-vakten fäller) och 1 vid felaktig användning.

## 2. Översikt

Två spår matar samma triagekedja.

- **Bankspåret (verklighetsankaret).** Verkliga spår ur banken varieras med relationer som är uppmätt tysta på oförändrad app. Fynden är realistiska per konstruktion. Spåret bär också självtestet.
- **Sanningsspåret (världar med facit).** En seedad världsmodell simulerar båtar längs den uppmätta farleden i steg om 1 s, och en radiomodell avgör vad appen får se. Varje båt bär exakt fysisk sanning (L0) och observerbar sanning (L1). Därför kan appen dömas även för tyst felbeteende: utebliven eller sen varning, fel riktning och missad passage.

Triagekedjan har fem steg: beslutsregister, mekanismkluster, krympning till minsta repro, bekräftelse och svensk rapport.

```
hunt.js  (förälder med äkta klocka: generering, dom, klustring, krympning, rapport)
  Fas 0  Självtest: git-vakt · banken ×2 · M-EXAKT · instrumentkrav · H3-baslinje · låst bank
         + sanningsspårets tillägg: kanarier · rundresa · S-KALIBRERING · realismtabell
  Fas 1  Bankspåret: fasrelationen M-FAS (δ)
  Fas 2  Sanningsspåret: spec → L0 → radio → rader → replay → domare mot L0/L1 → register
  Fas 3  Register → mekanismkluster
  Fas 4  Krympning på specnivå → bekräftelse
  Fas 5  Rapport: rapport.md · rapport.json · fynd/Fnn-*/ · fynd/Bnn-*/
            │
            └── pool med 4 barnprocesser:  node tests/replay-validation/replayRunner.js <jsonl> [mmsi]
                (oförändrad CLI och oförändrat markörkontrakt __REPLAY_JSON__ … __END__)
```

All motorkod ligger under `tests/replay-validation/bugHunt/` (modulkarta i bilaga C). Fyra befintliga filer har fått små krokar: `package.json` (skript), `CLAUDE.md` (en rad under Kommandon), `docs/VALIDATION.md` (ett kort avsnitt) och den här filen. `app.js`, `lib/`, `drivers/`, `settings/`, `app.json`, `.homeycompose/` och `replayRunner.js` är orörda.

## 3. Ramar och hygien

**Processmodell.** Allt utom replay körs i föräldern, och föräldern har inga fejkade timrar. Replay körs i barnprocesser mot det oförändrade CLI:t via `execFile(process.execPath, …)` (`lib/pool.js`). 44 jest-sviter och ett tiotal verktyg är beroende av markörkontraktet. Barnprocesserna isolerar också mot fejkklockans överhörning och mot runnerns globala sidoeffekter, och de kan dödas hårt.

**Hygien per körning:**
- **Miljöskrubb** (`lib/hygiene.js`). Alla variabler med prefixen `REPLAY_`, `AIS_REPLAY_`, `AISHUB_POLL_CAPTURE`, `REGEN_`, `GT_`, `ETA_MEASURE`, `PHASE_SWEEP`, `SOAK_`, `OPENING_GATES_` och `OPENING_GT_` tas bort, liksom `FUSION_PASS`, `INV21_GT`, `AIS_BRIDGE_SELFTEST` och `NODE_ENV` — både för barnen och i föräldern själv (föräldern kör harnessens domare i-process). Därefter sätts bara `TMPDIR`/`TMP`/`TEMP` (körningens egen katalog) och `REPLAY_MONITORING=1` för var fjärde syntetiska värld och för nattprofilens monitoringarm. `REPLAY_FUSION` används inte i v1.
- **Schemavalidering före varje skrivning** (`lib/schema.js`, felen anger radnummer):
  - `aisTimestamp` ska vara ett ändligt epok-ms-tal i [1,5e12; 4,1e12] på alla rader, även ctrl-rader.
  - ctrl ska vara disconnect, reconnect eller restart.
  - Positionsrader ska ha mmsi som 9-siffrig sträng, ändliga lat/lon och `fixTs ≤ aisTimestamp`. `feed` ska vara aisstream eller aishub, eller saknas.
  - Fältnamnen `timestamp` och `fixFeed` avvisas, eftersom runnern ignorerar dem tyst.
  Radiomodellen har samma eftervillkor (`radio.checkRows`), och båda körs på varje syntetisk värld.
- **Tidsgräns per körning:** max(60 s; 20 × (0,25 s + 0,31 ms per rad + 0,6 ms per simulerad timme)), mätt i föräldern. Vid överskridande dödas barnet med SIGKILL och körs om en gång med dubbel gräns; två missar i rad är H2 HÄNG.
- **Unika basnamn:** `w<seed>-<i>-<profil>.jsonl` för världar, `<korpus>.fas<δ>.jsonl` (`.mon` i monitoringarmen) för fasvarianter och `p<nnn>.jsonl` för krympningens prov. Då slår `makeGtPassages.idForJsonl` aldrig upp en korpus facit för en variant. Facit skickas alltid explicit till `validateWarnInvariants`, `analyseCoverage` och `analysePhantoms`.
- **Starttillstånd.** Fyra korpusar har `.state.json`. Deras varianter får en transformerad `<variant>.state.json` bredvid sig. Basen körs från `corpora-data/` med sitt eget tillstånd.
- **Git-vakt.** `git status --porcelain` (med `GIT_OPTIONAL_LOCKS=0`, så att vakten själv aldrig skriver) ska ge samma utdata före och efter körningen, annars blir exitkoden 2. Repot räknas bara som git-repo om toppnivån är exakt repots rot. Utkatalogen ska vara git-ignorerad (`git check-ignore -q`) eller ligga utanför repot; annars exit 2 redan vid start.
- **Utkatalog.** Standard är `dirigent/hunt/<ÅÅÅÅMMDD-HHMMSS>-<sha7>-<profil>-s<seed>/`, ägarens git-ignorerade arbetsmapp, med `senaste.txt` i `dirigent/hunt/`. Utan git, eller om `dirigent/` inte är ignorerad, används `os.tmpdir()/ais-tracker-hunt/`, och `senaste.txt` hamnar där. `senaste.txt` skrivs bara i dessa två baskataloger, som är motorns egna.
  - **`--out=` styr platsen.** Då skrivs ingenting utanför utkatalogen, alltså ingen `senaste.txt` i föräldern. Rättat 2026-11-04 (M08): förut hamnade filen i `--out`-katalogens förälder, som kunde ligga i repot.
  - **En icke-tom utkatalog godtas bara när den innehåller en tidigare motorkörning och inget annat.** Det betyder `rapport.json` med formatet `buggjägaren-rapport/1`, `rapport.md` och `fynd/`. De tre töms precis innan den nya rapporten skrivs, så att inga gamla `Fnn`-, `Bnn`- eller `r2`-kataloger blir kvar och körs av `hunt:repro`. Allt annat vägras med exit 2 innan något körs. Rättat 2026-11-04 (M13).
  - **Loggfiler är kringfiler.** Vanliga filer med ändelsen `.log` får ligga i utkatalogen, även i en ny eller tom katalog, och lämnas orörda; motorn skriver och tömmer dem aldrig. Då fungerar `hunt.js … --out=X 2>&1 | tee X/hunt.log`, där tee skapar loggen innan motorn startar, och en tidigare körning med sin logg kan ersättas. En katalog som heter `*.log` är ingen kringfil. Rättat 2026-11-04 (efterrättning D): förut vägrades båda fallen med exit 2.
  - **Tempfiler** läggs i `os.tmpdir()/ais-tracker-hunt-<körnings-id>-XXXXXX/` och raderas efteråt om inte `--keep-temp` anges. Samma regel gäller den fristående drivaren `lib/synthLane.js`: dess tempkatalog raderas i `finally`, om inte `--tmp` eller `--keep-temp` anges, och barnen körs med cwd i tempkatalogen som i `lib/pool.js`. Rättat 2026-11-04 (M14). En relativ `--tmp` görs absolut mot förälderns cwd, och barnet får absolut jsonl-sökväg och TMPDIR (efterrättning D: förut tolkade barnet den relativa sökvägen mot sin egen cwd, och varje värld fallerade med ENOENT).
- **Windows.** Motorn är ren Node utan skalkonstruktioner, sökvägar byggs med `path`, git anropas med argumentlista och npm-skripten har inga subshells. Git är valfritt; utan git varnar vakten i stället för att stoppa. (Repro-kommandon med `REPLAY_MONITORING=1 node …` är POSIX-syntax; på Windows sätts variabeln separat.)

**Determinism.** Budgeten räknas i antal världar, inte i tid. Samma HEAD, profil och seed ger därför samma `rapport.json`, bortsett från tidsblocket `tid`.
- Värld i får seed ur strömmen (bas-seed, ’värld-i’) och radioprofil ur (bas-seed, ’profil-i’), så värld i är densamma oavsett hur många världar som körs.
- Resultaten samlas i indexordning, oavsett vilket barn som blev klart först.
- Specen djupfryses under simulering och radio, så ingen modul kan skriva i den. Radions slumputfall, till exempel namnfördröjning, bokförs i en separat radiorealisering.
- Krympningens budget räknas i prov och i **modellerad** körtid (poolens kostnadsmodell), inte i väggtid.
- `rapport.json` skrivs med rekursivt sorterade nycklar; inga tempsökvägar står utanför tidsblocket (`repro.filer[].från` rensas bort).
- `--max-minutes` är en nödbroms och märker rapporten AVKORTAD varje gång den påverkar utfallet:
  - **I fas 1 och 2** avbryter den efter det sammanhängande prefix av fasvarianter eller världar som hunnit dömas.
  - **I fas 4** tar poolen inga nya jobb. En representant som aldrig hann starta blir obekräftad, och kortet får tidslinjen ur den sparade världen. En krympbudget som bromsas lämnar repron "delvis krympt (nödbromsen (--max-minutes))".
  - **Före fas 4** prövar hunt.js nödbromsen. Är tiden redan slut krymps ingenting.
  - **Efter en krympning** märks rapporten också när tiden är slut. Med `--no-shrink` gör fas 4 ingen replay, och då märks ingenting där.

  Märkningen syns på tre ställen: titeln får "(AVKORTAD)", sammanfattningen får en första rad om var nödbromsen slog till, och `rapport.json` får `körning.avkortad` och `körning.avkortning` (skälen per fas). Fram till 2026-11-04 märktes bara fas 1 och 2 (M09). En rapport som nödbromsen påverkat beror på väggklockan och är per definition inte reproducerbar.

**Körnings-id** = HEAD-sha + kalibreringens hash + motorversion + profil + seed.

## 4. Sanningsspåret

### 4.1 Världsmodellen (L0)

Varje båt är en bana s(t), l(t), v(t) längs farledens centerlinje (`lib/world.js`). Linjen kommer från `makeGtPassages.buildFairway`, med samma frusna stationer som rådatafacit:

| Punkt | s (m) |
|---|---|
| Kanalinfarten | ≈ 296 |
| Olidebron | 919,1 |
| Klaffbron | 2 298,4 |
| Järnvägsbron | 3 268,4 |
| Stridsbergsbron | 3 524,8 |
| Stallbackabron | 5 762,0 |

Inversprojektionen är exakt på centerlinjen; sidled ±20 m återger s och l inom 0,01 m utom i två skuggzoner innanför farledens vänsterbrytpunkter vid s ≈ 1 500 och 5 500 m (där det matematiskt inte finns någon invers; felet är begränsat och prövas i jest).

Kinematiken räknas i steg om 1 s:
- acceleration 0,04 m/s² och inbromsning 0,06 m/s²;
- önskad fart = marschfart × sektorfaktor, där sektorfaktorn är sektormedianen / 4,6 kn klippt till 0,6–1,3;
- sidledsläget följer en OU-process (τ 90 s) mot båtens fil, N(0; 6 m).

Banan börjar och slutar 350–400 m bortom radiohorisonten, så båten hörs först inne i bevakningsboxen, som i fält.

Planprimitiverna är deklarativ JSON som simulatorn bara läser: `queue{bridge, distM, durS}`, `stop{atS, durS}`, `crawl{bridge, withinM, kn}`, `uturn{atS}` och kajliggare (`role: 'moored'`, `quay`, `durS`).

L0 (`lib/truth.js`) bokför exakta, interpolerade brokorsningar, radiebesök inom 300 m, Kanalinfartens zonbesök, stopp, U-svängar och avsikten (planen).

### 4.2 Radioprofiler

- **R0 idealradio.** Fast intervall 30 s, klass A, aisstream, inget brus, inga namnglapp och ingen sen födelse. Ett fel som syns här har ingen observerbarhetsursäkt.
- **R1 fältlik radio** (`lib/radio.js`). Varje båt har en egen slumpström (`radio-<mmsi>`), och AISHub-pollens tider kommer ur en världsström som inte beror på vilka båtar som finns, så krympningen kan ta bort båtar utan att ändra de andras observationer. Modellen:
  - aisstream-kadens per klass och rörelse ur fältkvantilerna, med log-interpolerad svans;
  - AISHub-poll var 65 + U(0, 5) s med fixålder ur fältet, sekundupplöst `fixTs`, 5 decimaler och spridning ≤ 150 ms;
  - brus på sog, cog och GPS ur fältet;
  - namnbackfill för klass B, där 25 % börjar som Unknown;
  - sen födelse (F-SENFÖDD);
  - ingen leverans under ctrl:disconnect.
- **R2 adversariell** (dubbletter, spikar, framtida tider) kommer i v1.1.

**Rörelsetillståndet är fysiskt** (rättat 2026-11-04, motorgranskningens M02). En båt är stilla bara när banans fart är exakt 0, alltså under väntan i kö eller stopp och som kajliggare. Annars är den i rörelse, hur långsamt den än kryper (`radio.inMotion`). Tillståndet styr allt i raden som beror på rörelse, i båda profilerna:

| | I rörelse (\|v\| > 0) | Stilla (v = 0) |
|---|---|---|
| sog | \|v\| i knop; R1 + N(0; 0,15) kn, aldrig under 0 | 0; R1 fältets stillabrus (0 i 80 %, 0,1 i 13 %, 0,2–0,4 kn i 7 %) |
| cog | färdriktningen längs farleden; R1 ± fältets cog-fel mot farleden | farledsriktningen; R1 slumpad, för klass B saknad i 35 % |
| navStatus (klass A) | 0 (under gång) | båtens stillastatus, annars 0; kajliggare 5 |
| GPS-brus (R1) | 3,5 m | 2 m |
| kadens och AISHub-fixålder (R1) | fältets transitkvantiler och rörelseålder | fältets stillakvantiler och stillaålder |

Fältet har kadens för två tillstånd: transit (sog ≥ 2 kn hos båda fixarna) och stilla (sog < 0,3 kn och < 60 m mellan fixarna). Kadensregimen följer därför rörelsetillståndet och inte någon sog-gräns. AIS-klassernas fartberoende sändregler, till exempel klass B var 3:e minut vid högst 2 kn, modelleras inte (4.5). Fram till rättningen gick gränsen vid \|v\| ≥ 0,25 m/s (≈ 0,49 kn). Under den rapporterade en båt sog 0, slumpad cog och stillakadens även i R0. Båda T10-korten på R0-nivå i första standardrapporten byggde på den artefakten. F05 var bara radioartefakten. F08 (ett R1-fynd som R0-bekräftelsen flyttade till logikfel) var dessutom T10 (b):s motsägelse mot (a), och vardera rättningen tar bort det (bilaga B, T10). A/B över standardens 2 000 världar finns där.

**R1 är okalibrerad i v1.** Realismtabellen (`lib/realism.js`, S-REALISM) mäts i varje självtest och redovisas i hälsorutan, men stoppar inget. Grinden (p50 inom ±30 %, p90 inom ±40 %) är röd för båda erorna: för aisstream är glappen i rörelse p50/p90 101/325 s mot fältets 129,5/538,3 s; för AISHub 71/123 s mot 61/119 s. Korsningsmåtten finns i fältet bara poolade över erorna och märks så. Radiorättningen M02 (ovan) flyttade måtten högst några sekunder. Den största ändringen gäller aisstreams sista fix före korsningen: p50 gick från 161 till 160 s mot fältets 123,5 s och hamnar därmed precis innanför ±30 %. aisstream klarar nu båda kvantilerna i två av fyra mått och AISHub i ett av fyra, så grinden är fortfarande röd. Fältets båtar saktar in före broarna i väntan på öppning, så kalibreringen kräver en inflygningsprofil och mottagningshål per sektor (v1.1). Därför redovisas R1-fynd som **robusthet**. Ett R1-fynd som reproducerar med R0 i bekräftelsen flyttas till logikfel.

### 4.3 Observerbar sanning (L1)

L1 är det en idealisk observatör av radioströmmen kunde veta.
- En korsning är **punktobserverbar** när radion levererat fixar på båda sidor med högst 900 s emellan.
- Med mer än 900 s emellan blir den **inferred**, samma regel som i `buildFacit`.
- Utan fixar på båda sidor finns den inte i L1.

För varje korsning bokförs `t_obs`, den första fixen efter händelsen, och för varje fix den närmaste notispunkten. Stridsbergsbron och Järnvägsbron ligger bara 257 m isär.

**Domregeln:** förutsättningarna, alltså vad appen borde ha gjort, tas ur L1. Felet mäts mot L0.

I bankkalibreringen ersätts L1 av rådatafacitet i `gt-passages/` (bara punktstämplade korsningar som förutsättning), de observerade radiebesöken ur raderna och besöken som var öppna i korpusens starttillstånd.

### 4.4 Familjer och nivåer

Varje värld är 2–4 h lång och har en fokal familj plus bakgrundstrafik (`lib/families.js`). Familjerna har fasta vikter i v1 (konvoj och kö 15, övriga 10); det finns ingen bandit.

| Familj | Fokalt beteende | Nyckelparameter vid gränssökning | Närliggande konstanter |
|---|---|---|---|
| F-TRANSIT | bara bakgrundstrafik (15 % nära deadline-taket) | marschfart | 10 kn (DEADLINE_MAX_SPEED_KN) |
| F-KONVOJ | följare i samma riktning, Δ ∈ U(0,5; 13) min | Δ | CONVOY_WINDOW_MS 600 s, WARNING_LEAD_MS 180 s |
| F-MÖTE | motriktad båt vid samma målbro inom 10 min | Δ | CONVOY_WINDOW_MS |
| F-KÖ | kö på fältets köplatser, p50 15 och p90 39 min, klippt vid 60 min | distM, durS | WAITING_SET/CLEAR 270/350 m, radie 300 m, queueGraceMs 900 s, STALE 300/600 s |
| F-KRYP | 0,4–1,5 kn inom 150–400 m före målbron; radion rapporterar farten fysiskt i hela intervallet (4.2) | kn, withinM | 0,5 / 1,0 / 2,0 kn, 300/500 m |
| F-USVÄNG | vändning 100–900 m från närmaste station, på båda sidor | avstånd | besöksutfärd 350 m, radie 300 m, 50/70 m |
| F-KAJ | kajliggare på 12 kajplatser härledda ur banken | (ej sökbar i v1) | 600 m (DISARM_MOORED_MIN_DISTANCE_M) |
| F-SENFÖDD | hörs först 300–1 500 m före målbron (bara R1) | avstånd | 210 s minsta varningsbarhet, 926 m, 2 500 m |
| F-AVBROTT | disconnect i 1–15 min under fokal anflygning, radion tyst | längd | 120 s (D5), 300/600 s, 900 s |
| F-OMSTART | **inte byggd** (sträckmål S1, kräver T11) | — | — |

Köplatserna i F-KÖ, mätt som avstånd före bron: Stridsbergsbron söderut 80–193 m, Järnvägsbron norrut 121–278 m, Järnvägsbron söderut 56–180 m och Klaffbron söderut 221–307 m.

Ankomsterna följer en Poissonprocess i två täthetsnivåer: realistisk täthet tar takten per lokal timme ur banken, med 34 % följare; 20 % av världarna är avsedda för stresstäthet (1–3 ankomster/h). Nivån som redovisas bestäms av **uppmätt** täthet (`truth.densityLevel`): en kedja med minst 6 korsningar av samma bro i samma riktning med högst 10 min mellanrum, eller fler än 9 samtidigt rörliga båtar. Uppmätt stress är sällsynt (bilaga A), eftersom sådana kedjor sällan uppstår även med 1–3 ankomster/h.

### 4.5 Kända modellgränser

- U-svängen är en inbromsning till 0,25 m/s och en vändning på stället i 0,1 m/s (farten blir aldrig 0), med momentant cog-språng på 180°. Verkliga vändningar sveper cog gradvis.
- Kön stannar exakt distM före stationen. Fältets köer driver.
- Radion saknar mottagningshål per sektor och en inflygningsprofil (se 4.2).
- AIS-klassernas sändregler modelleras inte. En båt i rörelse får fältets transitkadens även under 2 kn, där klass B i verkligheten sänder var 3:e minut. En krypande klass B-båt hörs därför oftare i R1 än i fält, eftersom fältet saknar mätt kadens för 0,3–2 kn.
- Kadensen dras vid varje fix ur tillståndet just då. En båt som lämnar kön mitt i ett stillaintervall hörs alltså först när intervallet löpt ut, medan en verklig transponder byter takt direkt.
- R1:s cog-brus är fältets fel mot farleden vid sog ≥ 2 kn. Vid krypfart är verklig GPS-kurs betydligt brusigare.

## 5. Bankspåret

### 5.1 Exakta relationer (självtest)

Tre relationer är uppmätt tysta på 24 av 24 korpusar och körs i varje självtest (`lib/relations.js`):
- **ID:** samma indata två gånger ger byte-identiskt resultat, bortsett från `heapUsedMB` (H5).
- **SHIFT30:** rader och state flyttas 7 d + 30 s. I state flyttas alla epok-ms-tal i [1,5e12; 4,1e12], även `capturedAt`. Halvminutfasen mot UI-klockans absoluta rutnät bevaras, så **hela resultatet** ska vara lika efter t − Δ (jsonl-namnet, `heapUsedMB` och `runtimeDiagnostics` undantagna).
- **MMSI:** en ordningsomvänd bijektion m → 999 999 999 − m i rader och state (formerna `mmsi`, `mmsi:Bro` och `Bro|mmsi|riktning`).

Ett brott stoppar jakten med exit 2. Utvecklarflaggorna `--plant=skip-state-shift` och `--plant=skip-state-relabel` mutationsprövar relationerna (bilaga A).

### 5.2 Fasrelationen M-FAS

Hela korpusen och dess state flyttas δ ∈ (0, 30) s, typbevarande (`aisTimestamp`, `fixTs`, `receivedAt` som ISO, epok-ms i state). Varianten jämförs med självtestets cachade bas:
- multiset av notis-, öppnings- och passagenycklar (med parade byten: riktning, ledare, mål-/mellanbro);
- parade notiser driver högst 30 s;
- inga nya fatala invariantinstanser (instansnyckel: ISO → T, mmsi → M, talen behålls), nya leveransfel, H1 över basen eller nya H3-signaturer.

**Parning och drift.** Ur varje nyckel som skiljer väljs de tappade eller tillagda posterna som ligger längst från andra sidan i tid (`project.pickExtras`). Sedan paras en tappad och en tillagd post till ett byte (NOTISRIKTNING BYTT, PASSAGETYP BYTT och ÖPPNINGSRIKTNING BYTT) bara när de ligger högst 120 s isär (`PAIR_WINDOW_MS`). Notiser och passager paras då med den närmaste i tid; paren väljs girigt på stigande |Δt|, så valet är deterministiskt. Driften mäts på de notiser som är kvar när de tappade och tillagda posterna tagits bort, med samma val.
- Rättat 2026-11-04 (motorgranskningens M06): förut parades notiser och passager på mmsi och bro utan tidsvillkor. En notis som tappades 13:46:40 och en orelaterad notis sex timmar senare med riktningen unknown blev ett enda NOTISRIKTNING BYTT, som D4 sedan klassade DESIGN. Två fel försvann. Nu blir det NOTISNYCKEL TAPPAD och NOTISNYCKEL TILLAGD, båda KANDIDAT. Öppningsbytena hade redan fönstret men parar fortfarande med första kortet i fönstret, inte närmaste.
- Rättat 2026-11-04 (M07): förut parades notiserna per index. En extra notis i en nyckel förskjöt alla senare par, och en notis som fanns oförändrad i båda fick en falsk drift. Granskarens fall (basen T och T + 3 h, varianten T, T + 1 h och T + 3 h) gav NOTISNYCKEL TILLAGD och dessutom NOTISDRIFT>30s på 7 200 s för fel notis. Nu ger det bara TILLAGD.

**Fatala invarianter i varianten.** Ett nytt fatalt utslag är ACCEPTERAT via KIE-PER-KORPUS bara när det gäller samma episod som ett av korpusens knownInvariantExceptions. Det betyder samma klass och broar, samma fartyg när undantaget namnger ett, och en tid högst |δ| + L + en tick (30 s) från undantagets. L är undantagets egen längd för klasser vars tid är episodens slut (ETA-SÅGTAND UPP "på Ns", ETA-OSCILLATION "inom Ns"), annars 0. DEFAULT-FLASH:s tid är starten av "Inga båtar" och "(Ns)" hur länge texten stod, så en flash jämförs start mot start med |δ| + en tick. Utslagets egen längd vidgar aldrig fönstret. Ett undantag förklarar dessutom högst en träff per variant, den närmaste: varje nytt fatalt utslag bär variantens alla utslag av samma klass vid samma broar i `belägg.syskon`, och har ett syskon närmare undantaget är utslaget en annan episod (§7, M03 och efterrättning D). En ny episod vid samma bro vid en annan tid är KANDIDAT.
- Rättat i tre steg 2026-11-04. M03 införde tidsvillkoret |δ| + 5 min. Efterrättning D snävade det: granskarens prov gav en separat DEFAULT-FLASH (60 s) 2, 4 och 5 min efter 42h:s kända flash ACCEPTERAD, och ett undantag kunde amnestiera hur många träffar som helst i en variant. 42h-flashens fasvarianter ligger 0 s (δ +7 och +15 s) och 30 s (δ −7, −11,52 och −20 s: en tick tidigare och 59–60 s lång) från undantaget och är fortfarande ACCEPTERADE.
- Runda 2 (E3): efter efterrättning D var L den längre av undantagets och utslagets längd, även för DEFAULT-FLASH. En separat lång flash vidgade då sitt eget fönster: granskarens kiewindow2 (42h, δ +7 s) gav flashar på 240 s vid +4 min, 290 s vid +5 min och 300 s vid +5,5 min ACCEPTERADE. Nu är de KANDIDAT. 42h-flashens fem fasvarianter behöver bara |δ| + en tick (30 s isär vid δ −7 s ger 37 s fönster) och är fortfarande ACCEPTERADE. Bankens 41h-undantag saknar längd i strängen, så även ETA-klasserna där jämförs med |δ| + en tick.

**hunt:repro för ett bankkort** (relation M-FAS) kör om bas och variant och klassar varje utslag med registret. Svaret är KVAR bara när mekanismen fortfarande ger ett utslag med kortets registerutfall: klass och post ur klusternyckeln i `fynd.json` (`klass|post|mekanism`, i praktiken KANDIDAT). Utslag av samma mekanism med ett annat registerutfall, till exempel 42h-flashen som KIE-PER-KORPUS godtar, gav inte kortet. De räknas och listas som information, som för S-KALIBRERING (§10). Saknar `fynd.json` både nyckel och sparade fynd blir svaret KAN INTE DÖMAS (exit 2). Rättat 2026-11-04 i runda 2 (E4): förut räknades varje utslag av mekanismen, så granskarens konstruerade M-FAS-kort för 42h (δ +7 s, nyckeln KANDIDAT) svarade KVAR fast den enda träffen var ACCEPTERAD via KIE-PER-KORPUS. Nu svarar det BORTA med träffen som information.

Alla utslag taggas KNIVSEGG men undantas aldrig; CLAUDE.md kräver att startberoende utfall undersöks. Utslag som bara skiljer i δ slås ihop och får sin δ-lista. Nattprofilen kör alla δ även med `REPLAY_MONITORING=1` (egen bas).

### 5.3 Isolering ⇄ union

Sträckmål S2, **inte byggt** i v1.

## 6. Orakel i sammanfattning

Fullständiga regler, trösklar och falsklarmsvakter finns i bilaga B. Fyra principer gäller:
- Förutsättningar tas ur L1, felet mäts mot L0.
- Oraklen kopierar inga produktregler. De använder produktens konstanter (`lib/constants.js`) och harnessens egna domare (`invariants.js`, `openingDelivery.js`, `runOpeningGates.js`), och de kodar ägarbeslut som registerposter med källa.
- Inget orakel får fälla innan det är tyst på den låsta banken eller har varje bankträff registrerad. Kalibreringen körs om i varje självtest.
- En metamorf relation får bara ge kort om den är uppmätt tyst på oförändrad app.

Tre följder av principerna, förtydligade 2026-11-04:
- **Ett beslut som oraklet tillämpar självt står i registret med verkan `iOraklet`.** Det gäller beslut som är en förutsättning för domen eller en del av oraklets regel, till exempel T1:s rörelsebevis och 70 m-bandet. Posten pekar ut var oraklet tillämpar beslutet (`orakelvakt`, `fil.js#symbol`: funktionen eller konstanten, inte raderna, så att hänvisningen inte glider när filen ändras; laddningen kontrollerar att symbolen definieras i filen, runda 2 E5). Registret prövar den aldrig, så den kan inte bli "närmast" och räknas inte som oanvänd (§7, M12). Ett beslut som förklarar ett utslag i efterhand, som besöksregeln, är en vanlig post.
- **T2-oraklets förklaringar och registrets konvojposter använder samma definitioner** (`lib/konvoj.js`): "täckt av händelsen" (medlem i varningen, ledare eller absorberad senast vid korsningen), "händelsens första passage" (första punktkorsningen av en båt som då var täckt), "returresa" (båten korsade själv bron efter händelsens varning och före korsningen; enligt U15 är returen en egen öppning, så händelsen förklarar den aldrig, `konvoj.egenKorsningEfter`, registret 2026-11-07) och "öppen enligt medlemskravet" (ingen täckt båt, inte heller båten själv tidigare, passerade bron mer än CONVOY_WINDOW_MS före korsningen; J13 kräver det). Oraklet prövar dem i registrets ordning och med postens klassRegex (`t2Opening.explainT2`). Förut gick definitionerna isär, och 13 instanser i första standardrapportens två T2-kandidatkluster bar en orakelförklaring som registret avvisade (M04, triagens T-2).
- **Ett utslag bär det underlag som registrets predikat läser.** INV-10 (STRAX-ZOMBIE) får strax-övergången, nästa övergång och de bekräftade väntintervallen för bron i `belägg.väntan` (`oracles/existing.js`). Det är underlaget för mätgränsen MÄTGRÄNS-INV10-VÄNTKEDJA (§7, triagens T-1). Bron är zombiens egen, den i "utan <bro>-passage", och fyndets `bro` är densamma. INV-10 fäller en gång per bro i texten, och INV-9 kräver att Klaffbron står först, så första bron i den citerade texten är alltid Klaffbron när båda målbroarna har strax. Rättat 2026-11-04 (efterrättning D): förut prövades Klaffbrons väntan även för zombien vid Stridsbergsbron, och ett fatalt utslag utan någon väntan vid Stridsbergsbron blev MÄTGRÄNS (granskarens prov: strax vid båda broarna i 38 min, väntan bara vid Klaffbron). Samma väg gäller M-FAS-varianternas nya utslag. Ett nytt fatalt utslag i en fasvariant bär dessutom sina syskon (`belägg.syskon`, §5.2) för KIE-PER-KORPUS.

**Rekommendation till ägaren (ingen ändring i harnessen).** INV-10 i `invariants.js:476–503` godtar bara ETT bekräftat väntintervall som når nästa övergång. Harnessen (`replayRunner.js:293–311`) startar ett nytt intervall när nästa textgenerering kommer efter `until`, alltså när fixglappet är längre än STALE_ETA_HARD_THRESHOLD_MS (10 min), och halvminutstickens text byts upp till en tick efter sista intervallet. F18 i första standardrapporten är ett sådant fall: fixglappet 10 min 13 s delade väntan i två intervall med 13 s emellan, och det sista slutade 26 s före ticken 09:27:30 då "ETA okänd" publicerades. Samma granularitet finns därför i `replay:all`, som kör INV-10 oförändrad. Motorn behandlar en kedja av intervall med högst 30 s mellanrum och högst 30 s svans som en mätgräns, men bara när inget glapp i kedjan innehåller en halvminutstick. UI-klockan slår på absoluta halvminuter (`app.js:13089–13096`) och tickens text genereras inom högst 40 ms (`app.js:5513–5520`). Vid en tick inne i glappet är positionen inte färsk, så 'strax' spärras av hasFreshPosition (`BridgeTextService.js:304–308`) och en korrekt app byter text där. Ett 'strax' som står kvar över en sådan tick är just det INV-10 vaktar och blir KANDIDAT (runda 2, E2). F18:s glapp (08:59:44,854–08:59:57,860) innehåller ingen tick. Vill ägaren ha samma tolerans i `replay:all` hör den hemma i INV-10 själv.

| Id | Vad | Utfall i v1 |
|---|---|---|
| H1–H3, H5 | processfel, häng, ny APP ERROR-signatur, determinism | kort eller instrumentfel |
| INV-F, LEV | befintliga fatala invarianter, öppningsleverans | kort |
| INV-W, T4 | WARN-invarianter, en varning per öppning | räknare |
| T1 | notis per observerat besök | kort |
| T2 | öppningsvarning före sann passage, ledtidsgolv | kort |
| T3 | fantomvarning mot avsikt (och varning efter sann passage) | kort |
| T9 | riktningssanning | kort |
| T10 | passagedetektion | kort |
| M-EXAKT | ID, SHIFT30 och MMSI på banken | självtest |
| M-FAS | fasrelationen på banken | kort (KNIVSEGG) |
| S-KANARIE, S-KALIBRERING, S-RUNDRESA, S-GIT | självtestets kontroller | självtest |
| S-REALISM | realismtabellen för R1 | redovisas (ingen grind i v1) |
| T6, T11, M-ISO | liveness, omstart, isolering | **inte byggda** (sträckmål) |

## 7. Beslutsregistret

`tests/replay-validation/bugHunt/beslutsregister.json` är en maskinläsbar spegel av ägarbesluten. Källan är alltid `docs/` eller koden. Ett nytt beslut skrivs först där och får sedan en post som pekar dit (CLAUDE.md: domänbeslut dokumenteras i docs/).

**Format:** `{id, klass, datum, källa, gäller: {orakel[], inv?[], klassRegex}, predikat: {namn, parametrar}, regel, verkan?, orakelvakt? (iOraklet), doktriner? (KONFLIKT), fråga?}`. `lib/registry.js` laddar och validerar registret. Följande ger laddfel: saknad källa eller saknat datum, okänt predikat eller okänd parameter, en INV-F-post utan INV-id, en KONFLIKT utan fråga eller två doktriner, en okänd verkan och en post med verkan `iOraklet` utan orakelvakt.

**Hänvisningar** i `källa` och `orakelvakt` är sökvägar i repot, följda av `:rad`/`:rad–rad` eller `#symbol`. En hänvisning till motorns egna filer (`tests/replay-validation/bugHunt/`) ska peka på en symbol, till exempel `t10Passage.js#decisiveFixAfter`, så att den inte glider när filen ändras. Laddningen kontrollerar att symbolen definieras i filen: som funktion, deklaration (även en inre, som `const judgePhantom =`), metod eller objektegenskap. Ett omnämnande i en kommentar räcker inte: block- och radkommentarer tas bort innan matchningen (`utanKommentarer`, en liten lexer som läser strängar, mallsträngar och reguljära uttryck som kod och ger samma kommentarer som espree i alla 471 JS-filer i app.js, lib/, drivers/ och tests/). En import räknas inte heller som definition: `const x = require(…)`, en destrukturerad require även över flera rader, `= await import(…)`, `import … from` och `export … from`. Inte heller en objektegenskap vars värde är en import (`judgeT1: require(…).judgeT1,`, även med värdet på nästa rad, eller `judgeT1: await import(…),`) eller bara ett annat namn (`judgeT1: judgeT1,`, `judgeT1: a.b,`): den återexporterar något som definieras på annat håll, och definieras namnet i filen hittar de andra mönstren det (efterrättningen R3b, rad 20). Rättat 2026-11-04 i runda 3 (L2, rad 17): förut matchades den råa källtexten, så en bortkommenterad deklaration, ett JSDoc-exempel, en rad i en blockkommentar utan asterisk och `const judgeT1 = require(…).judgeT1;` godtogs (granskarens varv s1, nytt problem 2). Den rensade källtexten cachas per fil på storlek och ändringstid, eftersom registret laddas många gånger per körning. Följande ger registervarningar i rapportens hälsoruta, inte laddfel: en fil som saknas, en symbol som inte definieras, en hänvisning med rader till motorns egna filer och en appkonstant som inte kunde läsas (nedan). Jest kräver att det levererade registret laddar utan varningar. Infört 2026-11-04 i runda 2 (E5): förut kontrollerades bara att filen fanns, och orakelvakten `t10Passage.js:57–60` pekade efter efterrättning D på JSDoc i stället för på `decisiveFixAfter`.

**Klasser:** DESIGN (beslutat korrekt beteende), ACCEPTERAD (känt pris), KÄND_ÖPPEN (känt fall med öppet beslut), KONFLIKT (två doktriner krockar; båda citeras och ägaren får en fråga), KOSTNAD, MÄTGRÄNS (harnessartefakt), INSTRUMENTFEL och KANDIDAT (allt som inte matchar).

**Regler:**
- Ett utslag omklassas bara när orakel, klassRegex och predikat alla matchar. Ett fatalt invariantutslag omklassas dessutom bara av en post som namnger INV-id:t (säkerhetsregeln), även när posten gäller orakel `*`.
- Ordningen spelar roll: första matchande post vinner. Poster med `verkan: "tagg"` (STRESS-TÄTHET) omklassar inte; de lägger bara till en tagg. Därför gäller säkerhetsregeln inte dem: en taggpost med orakel `*` och utan inv-lista når även INV-F-fynd, och med en inv-lista bara de namngivna. Rättat 2026-11-04 i runda 2 (E7): förut krävde `Registry.applies` inv även för taggposter, så de fem INV-F-fynden i standardkörningens stressvärldar (F18, F19 och INV5-stressklustret) saknade taggen STRESS-TÄTHET medan T1-, T2- och T3-fynden hade den.
- **Poster med `verkan: "iOraklet"` speglar ett beslut som oraklet själv tillämpar** som förutsättning eller som del av sin regel. Fältet `orakelvakt` anger fil och symbol (`fil.js#namn`). Registret prövar dem aldrig: de blir aldrig "närmast" eller prövade, har ingen användning, räknas inte bland de oanvända och redovisas för sig under Kända utfall och i `rapport.json` (`register.iOraklet`). Infört 2026-11-04 (M12) för fem poster som aldrig kunde matcha men stod som "Närmast" på korten F05, F12 och F14 och gav permanent brus i listan över oanvända poster.
- **Den låsta banken får ingen registeramnesti.** En ny träff i basens fatala invarianter, leveransfel eller processfel (relation BAS) är en regression i `replay:all` och blir alltid ett KANDIDAT-kort under "Nya träffar på låst bank". Bara runAllCorpora:s exakta prefixmatch mot korpusens knownInvariantExceptions undantar (FP9, `runAllCorpora.js:252–262`). `selftest.lockedBankFindings` sätter registerutfallet direkt, och KIE-PER-KORPUS:s predikat vägrar relation BAS (M03). Kortet visar KIE-PER-KORPUS som "närmast" bara för en fatal invariant av postens klasser (INV-3, INV-14); för ett leveransfel, ett processfel eller en annan invariant står ingen post som närmast. Alla tre slagen av träff bär basens jsonl (+ state) och receptet `{korpus, relation: 'BAS'}`, så `hunt:repro` dömer dem (§10). Båda rättat 2026-11-04 (efterrättning D): förut fick LEV- och H1-korten "Närmast KIE-PER-KORPUS" och ingen jsonl, så hunt:repro svarade KAN INTE DÖMAS.
- Predikaten är data med parametrar, inte kod per post: 38 små funktioner i `lib/registry.js`, som läser produktens konstanter men inte anropar produktfunktioner som avgör samma sak som oraklet. Konvojpredikaten delar sina definitioner med T2-oraklet (`lib/konvoj.js`, §6). En gräns som är lokal i en produktfil och inte exporteras ur `lib/constants.js` läses ur källtexten (`appKonstant`: deklarationen `const NAMN = tal;` ska stå exakt en gång). I v1 gäller det FIX_D_MIN_SOG och, sedan registret 2026-11-07, TARGET_REMOVAL_GRACE_PERIOD i `VesselDataService.js`. Kan värdet inte läsas blir predikatet falskt och laddningen varnar, så registret amnestierar aldrig på en gissad gräns. S10-predikatet modellerar dessutom Fix D:s pending-logik på raderna (`spelaFixD`, rad 15 nedan) i stället för att anropa appen. Modellen antar att Fix D-blockets övriga villkor (målbro, inte nytt fartyg, shouldRecalc) håller vid varje fix med minst FIX_D_MIN_SOG. En rad utan finit kurs eller fart prövas, som i appen, med fartygets senast kända värde (`medFramfördKursOchFart`; `_createVesselObject`, `VesselDataService.js:5286–5287`). Det gäller spelet före zonen, fixen före besöket och zonfixarna, eftersom både Fix D-blocket och S10-vaktens krav 3 läser vessel.cog och vessel.sog (rad 16). Framföringen antar, som modellen i övrigt, att fartyget inte tas bort och skapas om mellan raderna. U16-predikatet läser brons ETA-serie ur brotextövergångarna med samma grammatik som INV-3 (`etaSerie`, rad 18) och radernas bearbetningstider ur en modell av harnessens klocka (`harnessTider`, rad 19): raderna matas i aisTimestamp-ordning, och en rad bearbetas vid max(radens tid, förra AIS-radens bearbetning + 60 ms), eftersom harnessen tickar 60 ms efter varje AIS-rad (`replayRunner.js:122–126` och `:501–622`).
- Ett KANDIDAT-kort visar den post som var **närmast** (första post vars orakel och klass matchade men vars predikat var falskt, med skäl) och de övriga prövade posterna.
- Varje körning redovisar oanvända poster, så att inga amnestier ligger kvar efter en rättning.
- Motorn ändrar aldrig registret. Ett kort kan föreslå en post med källa, om ägaren beslutar att utfallet är avsett.

**Poster** (41, i registerordning; fem har verkan iOraklet):

| Post | Klass | Gäller | Predikat | Källa |
|---|---|---|---|---|
| STRESS-TÄTHET | MÄTGRÄNS (tagg) | alla orakel, även INV-F | stressDensity(6, 10 min, 9) | denna fil §4.4 |
| KIE-PER-KORPUS | ACCEPTERAD | INV-F, M-FAS (INV-3, INV-14) | kiePrefix(samma episod: \|δ\| + en tick, plus undantagets längd när tiden är episodens slut; högst en träff per undantag och variant; aldrig låst bank) | corpora.js knownInvariantExceptions; runAllCorpora FP9 |
| U16-F40-STRAX-STUDS | MÄTGRÄNS | INV-F (INV-3) ETA-OSCILLATION, ETA-SÅGTAND UPP | f40StudsVidNästaFix(600 s, 1 s, 350 m, 300 m, 270 m, 500 m: strax → hopp → strax, hoppet när harnessen bearbetar en båts nästa rad, hennes föregående fix bearbetad mer än STALE_ETA_HARD före hoppet, ingen brotext eller halvminutstick mellan 600 s-gränsen och hoppet, båda fixarna inom 350 m och utanför kajkapslarna, återgången högst 1 s efter raden utan någon annan båts rad inom 500 m emellan, ingen styrrad, båten kunde bära strax vid sin förra fix (inom 300 m, eller inom 350 m efter en fix inom 270 m), och ingen annan båt kunde bära det vid hoppet (senaste fix inom 500 m, högst 600 s gammal, utanför kajkapslarna och på väg mot bron); aldrig låst bank) | harnessens uppskjutna UI-arbete (`replayRunner.js:86–88` och `:512–521`, `app.js:6857–6862`; §7 nedan); användarbeslut U16 om beteendet (§7 nedan); helgranskning-2026-07-06:271–274 (F40); etapp7-plan:8 (U1), :15 (U6), :267 (C11); app.js:7107–7113 |
| INV5-VS-BESÖKSREGEL | KONFLIKT | INV-F (INV-5, INV-7) | sameVisit(350 m, 2 fixar, 300 m) | VALIDATION §Invarianterna mot TriggerPointVisitTracker.js:12–16 |
| D1-KAJZON-DEMOTION | KONFLIKT | INV-F (INV-14), T6 | mooringCapsuleStationary(3 min, 600 m) | constants MOORING_ZONES mot reliability-spec D1 |
| OMSTART-DEFAULT-FÖRE-FÖRSTA-FIX | KÄND_ÖPPEN | INV-F (INV-14), T11 | defaultUntilFirstFixAfterRestart(60 s) | app.js:487 (beslut saknas) |
| U1-C11-TYST-FÖRE-DEFAULT | DESIGN | INV-F (INV-14) DEFAULT-FLASH | tystBärareFörfallen(texten före: "En båt på väg mot X, ETA okänd"; en båts tystnad passerar trappan 10/15/20/25 min inom en tick före episoden, harnessens klocka; aldrig låst bank) | etapp7-plan:8 (U1), :266–267 (C11, C11b); VesselDataService#getVesselsForBridgeText |
| M-BRUSBAND-RÖRELSEBEVIS | KÄND_ÖPPEN | INV-F (INV-14) DEFAULT-FLASH | krypbandVidTröskel(samma båt bär texten före och efter episoden; median-sog ±0,1 kn från 0,1/0,3/0,7, närmande 5–15 m per 60 s eller sog saknas med spridning > 8 m; aldrig låst bank) | ARCHITECTURE:913–921, kända gränser (a)–(c) |
| R2-MÅLBRO-EFTER-LINJEN | DESIGN | INV-F (INV-13) | målbroEfterLinjen(livet från glapp ≥ 30 min; registrering ≤ 10 min efter första raden bortom bron; stilla < 0,5 kn inom 50 m och utan kurs mot bron före den; aldrig låst bank) | §7 dirigentens beslut om R2:s fråga 2; VesselDataService#_calculateTargetBridge; invariants.js:568–593 |
| MÄTGRÄNS-INV17-R0 | MÄTGRÄNS | INV-W INV-17 | profileIs(R0) | invariants.js INV-17 |
| MÄTGRÄNS-INV10-VÄNTKEDJA | MÄTGRÄNS | INV-F (INV-10) STRAX-ZOMBIE | chainedConfirmedWait(30 s glapp utan halvminutstick, 30 s svans, start ≤ 10 min) | invariants.js:476–503; replayRunner.js:293–311; etapp7-plan:15 (U6); BridgeTextService.js:304–308 |
| K20-FASKÄNSLIG-LEDARE | KÄND_ÖPPEN | M-FAS (ÖPPNING…) | leaderOnlyChange(150 ms) | ARCHITECTURE K20; VALIDATION Facit-fällan p. 6 |
| D4-RIKTNING-UNKNOWN | DESIGN | M-FAS (NOTISRIKTNING BYTT, ÖPPNINGSRIKTNING BYTT) | directionUnknown (belägg.nyRiktning) | reliability-spec D4 |
| BN1-BOXKANT | KÄND_ÖPPEN | T1 | boxEdgeExit | helgranskning 2026-11-03, beslutspunkt 2 |
| KANALINFARTEN-FP8-SYDGRIND | DESIGN | T1 | sydgrindUtanKanalrelevans(0,0009°) | ARCHITECTURE:410–413; etapp7-plan:485 |
| SKIPPA-BRO-ÅLDER-17MIN | DESIGN | T1 | inferenceAge(17 min) | runSyntheticScenarios.js:423–426 |
| D3-2H-DEDUP | DESIGN | T1, T11 | dedup2h(120 min) | reliability-spec D3 |
| BESÖKSREGEL-2026-09-07 | DESIGN | T1 | sameVisit (även besök öppna i state) | TriggerPointVisitTracker.js:12–16; ARCHITECTURE:1040 |
| S10-VÄNDNING-BRON-BAKOM | DESIGN | T1 NOTIS-UTEBLIVEN | reversalAwayFromBridge(300 m, 15 min; Fix D spelad över fixarna före zonen: låset är det gamla och ingen färsk flagga finns; zonens första fix ≥ FIX_D_MIN_SOG 2,0 kn, ingen senare zonfix ≥ FIX_D_MIN_SOG; en rad utan kurs eller fart får det senast kända värdet) | ARCHITECTURE:1928 (S10 godkänd); app.js:9708–9783, :10293; VesselDataService.js:380–407, :446–476, :5286–5287 |
| KAJGRIND-UTAN-RÖRELSEBEVIS | DESIGN (iOraklet) | T1 | — (t1Notice.js#judgeT1, förutsättning 3) | constants QUAY_DEPARTURE_GATE |
| U10-BN2-PASSERAD-FORM | DESIGN (iOraklet) | T1 (FORM) | — (t1Notice.js#judgeT1) | ARCHITECTURE P8/U10 |
| UNDER-BRO-BANDET-70M | DESIGN (iOraklet) | T1, T10 | — (t1Notice.js#judgeT1; t10Passage.js#decisiveFixAfter) | constants UNDER_BRIDGE_CLEAR_DISTANCE |
| U2-VS-DEADLINE | KÄND_ÖPPEN | T2 | crossingWithinEventWindow(600 s; konvoj.inomHändelsefönster; aldrig en händelse som båten själv passerat i, U15) | etapp7-plan C-IV |
| J13-J14-KONVOJSEMANTIK | KÄND_ÖPPEN | T2 | nonMemberCrossingBetween (konvoj.ickeMedlemEmellan; aldrig en händelse som båten själv passerat i, U15) | ARCHITECTURE:1611–1628 |
| O1-ACCEPTERADE-MISSKLASSER | ACCEPTERAD | T2, T3 | missklassAccepterad | runOpeningGates.js classifyMiss |
| U18-RETUR-BEKRÄFTAD-SENT | DESIGN | T2 OKLASSAD, LEDTID; T3 VARNING-EFTER-SANN-PASSAGE | fixDBekräftarReturSent(L0-vändning ≤ 30 min före korsningen, minst en omvänd fix ≥ FIX_D_MIN_SOG före den; Fix D bekräftar efter korsningen (OKLASSAD), eller < 2 × TICK före eller efter den och den egna varningen kommer ≤ 2 × TICK efter bekräftelsen) | §7 U18; ARCHITECTURE:1028–1035; VesselDataService.js:385–491 |
| U17-TYST-BÅT-RECOVER | DESIGN | T3 VARNING-EFTER-SANN-PASSAGE, VARNING-PÅ-FRUSET-FIX | tystRecoverSammaÖppning(samma: absorberad i E före korsningen, egen varning på tick efter absorptionen, tyst över korsningen, korsning ≤ 600 s efter E:s första sanna korsning) | §7 U17; ARCHITECTURE:1869–1886; BridgeOpeningService#_coverageVerdict |
| K-TYST-BÅT-NÄSTA-ÖPPNING | KÄND_ÖPPEN | T2 LEDTID, T3 VARNING-EFTER-SANN-PASSAGE | tystRecoverSammaÖppning(nästa: som U17 men > 600 s) | ARCHITECTURE:1818–1840, :1869–1886 |
| U19-VARNING-UNDER-VÄNTANDE-VÄNDNING | ACCEPTERAD | T9 FEL-RIKTNING (varning), T3 FANTOM-UTAN-AVBROTT | väntandeVändningVidVarning(egen varning; Fix D:s flagga i motsatt riktning vid varningen, bekräftad efter den; inget RECOVER-släpp) | §7 U19; ARCHITECTURE:1036–1042 |
| FALSKLARM-AVBRUTEN-GLES | ACCEPTERAD (iOraklet) | T3 | — (runOpeningGates.js#classifyPhantom; t2Opening.js#judgePhantom) | runOpeningGates classifyPhantom |
| DEADLINE-10KN-GARANTIPRIS | ACCEPTERAD (iOraklet) | T3 | — (runOpeningGates.js#classifyLatePassage; t2Opening.js#judgePhantom) | runOpeningGates GARANTIPRIS |
| FIXD-SLINGA | KÄND_ÖPPEN | T3, T9 | holdPattern(2 × 150 m, 60 min) | ARCHITECTURE:2024–2029 |
| OMSTART-ARMAR-EJ-PERSISTERADE | KOSTNAD | T11 | restartWithin(30 min) | trigger-etapp6 §2 |
| OMSTART-RESETILLSTÅND | KONFLIKT | T11 | restartWithin(30 min) | ARCHITECTURE:1037 mot reliability-spec D3 |
| LATENT-INBROMSNING | KÄND_ÖPPEN | T8 (v1.1) | stillNearBridge(270–350 m) | helgranskning, beslutspunkt 4 |
| P8-L6-SPÖKTEXT | KÄND_ÖPPEN | omätbar i standardreplay | aldrig | helgranskning, beslutspunkt 1 |
| MÄTGRÄNS-TOKEN-TIMEOUT | MÄTGRÄNS | H3 | stderrSignature(GLOBAL_TOKEN_TIMEOUT) | replayRunner A8(ii) |
| GPS_JUMP-DIAGNOSTIK | DESIGN | H3 | stderrSignature([GPS_JUMP…]) | GPSJumpAnalyzer.js:545 |
| MÄTGRÄNS-FACIT-SIDLED | MÄTGRÄNS | T10, S-KALIBRERING | lateralOffset(250 m) | makeGtPassages sidledsgrind |
| TVÅ-ÅTERKORSADE-BROAR-I-SAMMA-SEGMENT | KÄND_ÖPPEN | T10 PASSAGE-EJ-REGISTRERAD | andraBronISammaSegment(vändning ≤ 30 min före; en annan bro korsad i samma riktning mellan samma två rader och bokförd vid den andra radens bearbetning ± 1 s) | ARCHITECTURE:1022–1027 (känd lucka 1) |
| U-SVÄNG-LÅNGSAM-ÅTERKORSNING | KÄND_ÖPPEN | T10 PASSAGE-EJ-REGISTRERAD | returUtanRörelsebevis(vändning ≤ 30 min före; korsningsfixet < FIX_D_MIN_SOG, eller utan fart och segmentet < 100 m, och den långsamma vägens fyra villkor håller inte alla) | ARCHITECTURE:1022–1027 (kända luckor 2–5); VesselDataService#_slowReCrossEvidence |

Posterna med verkan iOraklet behåller sitt predikat i filen som registerform av regeln, men predikatet utvärderas inte.

Ändringar vid integrationen 2026-11-04 (alla med källa, inga nya beslut): KANALINFARTEN-FP8-SYDGRIND lades till (bankkalibreringens enda oregistrerade träff, S/Y DESIREE i 42h); O1 utvidgades till kort ledtid och varning efter sann passage för båtar som inte var varningsbara och flyttades efter U2- och J13-posterna; besöksregelns predikat godtar ett besök som var öppet i starttillståndet (ELFKUNGEN i 80h); U2-VS-DEADLINE:s predikat rättades (§16).

### Användarbeslut U16 (2026-11-04): F40-studsen behålls

Ägaren besvarade triagens beslutsfråga 3 (`docs/buggjakt-triage-2026-11-04.md`, §Ägarens beslut 2026-11-04): **beteendet behålls, appen visar aldrig "strax" på en position som är äldre än 10 min, och motorn registrerar studsen som DESIGN.** Beslutet vilar på F40-avvägningen (`docs/helgranskning-2026-07-06.md:271–274`: ETA-hopp vid 600 s-gränsen för väntande glesa sändare, säkerhetsvalet "aldrig strax på gammal position" står) och på U1, U6 och C11 (`docs/etapp7-plan-2026-08-08.md:8`, `:15` och `:267`). Registret speglar beslutet med posten U16-F40-STRAX-STUDS (rad 18 nedan; bunden till den "strax"-bärande båten i efterrättningen R3b, rad 19). Sedan efterrättningen R3c (rad 21) är postens klass MÄTGRÄNS: studsen vid båtens nästa rad uppstår för att harnessen skjuter upp appens UI-arbete (Mekanismen nedan). Beslutet U16 om beteendet står kvar som källa och ändras inte.

- **Mekanismen** (F18/F19 i s1-standard-a, värld 1608): MASEN 2 köar 82 m från Stridsbergsbron och är tyst 09:32:10,242–09:42:15,101 (604,9 s; harnessen bearbetade fixen 09:32:10,291, efter två andra rader i samma AISHub-kluster, så appens ålder är 604,8 s). När klockan når hennes nästa rad dränerar harnessen väntande UI-arbete före sampelbearbetningen (`replayRunner.js:512–521`). Positionen är då äldre än STALE_ETA_HARD, så imminent-grinden släpper "strax" (`app.js:7107–7113`, `IMMINENT_SKIP … AIS too old (605s > 600s)` på :7174), och klausulen lånar YRSA:s ETA, 7 min (8 min i minsta repro). Efter sampelbearbetningen bär texten "strax" igen, 246 ms senare (25 ms i minsta repro). INV-3:s studsdiskriminator (`invariants.js:302–319`) fäller det som ETA-OSCILLATION och ETA-SÅGTAND UPP. Hoppet låg på kniveggen: vid dräneringen i slutet av harnessens 30 s-steg 09:42:09,998 var åldern 599,7 s, och appen satte `IMMINENT_SET` ("AIS 600s old"). **Hoppet vid hennes rad är en uppskjuten svans i harnessen** (granskarens slutvarv, belagt i värld 1608:s verbose-logg). Harnessen kör appens asynkrona UI-arbete först vid sin nästa dränering, en enda verklig setImmediate efter varje `clock.tick` (`replayRunner.js:86–88` och `:512–521`). UI-cykeln från halvminuten 09:42:00 räknade därför först vid dräneringen 09:42:09,998, och dess omkörning (setImmediate, `app.js:6857–6862`) kördes först vid dräneringen före MASEN 2:s rad 09:42:15,101: där kommer `AIS too old (605s > 600s)`. I fält hade omkörningen gått vid halvminuten med åldern cirka 590 s, och nästa cykel 09:42:30 hade kommit efter hennes färska rad. Åldern 604,8 s är alltså harnessens tid, och den varianten av studsen som posten täcker är en mätgräns. Tick-varianten, som posten utesluter, är den som en riktig körning skulle ge.
- **Posten är smal och bunden till den båt som kan ha burit "strax".** Den gäller bara studsen när den båtens nästa rad bearbetas. Kraven: nivån före hoppet och återgången är "strax" i brons ETA-serie; hoppet publicerades exakt när harnessen bearbetade båtens rad (`harnessTider`, §7 Regler), högst 1 s efter radens tid; båtens föregående fix bearbetades mer än STALE_ETA_HARD före hoppet, med samma jämförelse som appens `dataIsFreshEnough`; båda fixarna ligger inom 350 m från bron (imminent-hysteresens yttre gräns, `app.js:7210–7212`) och utanför kajkapslarna (MOORING_ZONES); ingen brotext publicerades och ingen halvminutstick (i variantens fas för M-FAS) föll mellan 600 s-gränsen och hoppet; återgången kom efter radens bearbetning och högst 1 s efter radens tid; ingen annan båts rad inom 500 m från bron bearbetades emellan; ingen styrrad bearbetades mellan båtens förra fix och återgången; båten kunde bära "strax" vid sin förra fix (fixen inom 300 m, imminent SET, eller inom 350 m efter en tidigare fix inom 270 m, väntläget, utan att båten lämnat 350 m emellan; `app.js:7210–7212`); och ingen annan båt kunde bära "strax" vid hoppet (ingen annan båt har sin senaste fix före hoppet inom 500 m, högst 600 s gammal i appens klocka, utanför kajkapslarna och på väg mot bron: kursen inom ±90° från bäringen till bron, eller saknad kurs inom 350 m).
- **Varför villkoren.** Bar båten "strax" ensam, tappar appen det vid den första textgenereringen efter 600 s-gränsen. En publicerad brotext eller en halvminutstick (UI-klockans absoluta halvminuter, `app.js:13089–13096`, med textens mikrograce på högst 40 ms) mellan gränsen och hoppet visar att båten inte var ensam bärare, eftersom "strax" stod kvar där. Att hoppet ligger på bearbetningen av just hennes rad binder hoppet till hennes ålder. Bearbetade harnessen en annan båts rad inom 500 m (den vidaste radie där appen sätter "strax", den uttömda grenen på `app.js:7239`) mellan hennes rad och återgången, kan återgången komma från den båten. En förtöjd båt i en kajkapsel sänder glest, och hennes rad kan sammanfalla med en studs som har en annan orsak. Appen kan räkna en stillaliggare vid kajen norr om Klaffbron som köare i upp till 15 min (`queueGraceMs`, `lib/constants.js:415–470`), så en äkta studs med bäraren där blir KANDIDAT. Det är ett medvetet pris.
- **Fönstret 1 s gäller återgången.** Återgången publiceras tidigast efter textens mikrograce (15–40 ms, `app.js:5512–5520`). I minsta repro för F18 kom den 25 ms efter raden. I fullvärlden 1608 gav hennes sampel `IMMINENT_SET` direkt, men texten publicerades först efter de tre AISHub-rader som följde 66–109 ms senare, 246 ms efter hennes rad (harnessen tickar 60 ms efter varje rad, `replayRunner.js:619`). De tre båtarna låg 1,0–1,7 km från bron. Fönstret räknas från radens tid, inte från bearbetningen, så att posten aldrig blir bredare än i rundans första försök. Hoppet har inget eget fönster: det ska ligga på radens bearbetning.
- **Bindningen kom i efterrättningen R3b** (granskarens varv r3, rad 19). Rundans första försök godtog vilken båt som helst inom 350 m med en fix äldre än 600 s, räknad på radernas tider, och en rad högst 1 s från hoppet åt båda hållen. Granskarens u16e2e genom appen: F21:s minsta repro i R3-standard (värld 1907, B4-studsen) och en förtöjd båt vid kajen norr om Klaffbron, 240 m från bron, tyst i 720 eller 605 s och med en rad 35 ms före ULLA:s. Appen ger samma studs ("om 7 minuter" 11:01:40,950, "strax" 11:01:41,035), och posten gjorde den till DESIGN. Nu ger 720 s-fallet KANDIDAT, eftersom appen publicerade "strax" 10:59:56,883 och 11:01:11,643, efter att båtens ålder passerat 600 s 10:59:40,985. 605 s-fallet ger KANDIDAT, eftersom båten ligger i kajkapseln. Samma båt 45 m öster om kapseln, 262 m från bron (appen ger samma texter), ger KANDIDAT, eftersom ULLA:s rad bearbetades 11:01:41,010, mellan båtens rad och återgången. Granskarens enhetsfall (en annan tyst båt 273 m från bron med en rad 23–41 ms före hoppet, en färsk MASEN 2 med en tyst båt i samma kluster, ett hopp 0,8 s efter MASEN 2:s färska rad) ger också KANDIDAT. Granskarens förslag om ett villkor att ingen annan färsk båt finns inom 300 m togs inte: i fullvärlden 1608 låg ORION (183 m) och NORDVIND (298 m) med 65 s gamla fixar vid hoppet.
- **Bäraren och klassen i efterrättningen R3c** (granskarens slutvarv, rad 21). Posten tog radens båt som bärare utan att pröva att hon kunde bära "strax" och att ingen annan båt kunde det. Granskarens ce-b genom appen: F21:s B4-studs (ULLA:s uttömda "strax" 452 m från Klaffbron, fixen 407 s gammal) och en båt Y som närmar sig söderifrån, 320 m från bron 10:51:35,950 och 260 m 11:01:40,950. Appen loggar `IMMINENT_SKIP … dist=320m > 300m` för Y, som alltså aldrig bar "strax". Vid dräneringen före Y:s rad körs vakthundens uppskjutna omkörning från halvminuten 11:01:30, och B4-taket släpper ULLA:s "strax": "om 7 minuter" 11:01:40,950 och "strax" igen 11:01:40,975. Posten gav DESIGN, medan samma körning med Y tyst i 590 s (bitlik apputdata, ce-b590) gav KANDIDAT. Nu ger båda KANDIDAT: ce-b eftersom Y:s fix ligger 320 m från bron utan föregående väntläge, ce-b590 eftersom Y:s fix är färsk. Enhetsfallet med en stillaliggande Y 262 m från bron och ULLA:s rad borttagen (förut DESIGN) ger KANDIDAT, eftersom ULLA:s 407 s gamla fix 452 m från bron, på väg mot bron, kunde bära "strax". Villkoret om andra bärare kräver kurs mot bron: i fullvärlden 1608 går ORION och NORDVIND söderut från Stridsbergsbron, och värld 1608 är kvar i posten. Klassen ändrades samtidigt från DESIGN till MÄTGRÄNS, eftersom hoppet vid båtens nästa rad uppstår av harnessens uppskjutna UI-arbete (Mekanismen ovan). Ägarbeslutet U16 om beteendet står kvar.
- **B4-varianten omfattas inte.** B4:s 90 s-tak på uttömt "strax" (`app.js:257`, `docs/korrigeringar-2026-07-03.md:105–110`) släpper "strax" medan positionen är yngre än 600 s, och uttömningsstämpeln syns inte i raderna, så en radbaserad regel kan inte belägga den. I de fulla världarna i s1-standard-a ligger ingen B4-studs inom 1 s från den uttömda båtens nästa rad. I värld 1907 (F18/F19) kommer hoppet vid 265182731:s rad efter 407 s tystnad, men återgången först 22 s senare, vid en annan båts rad. I värld 1275 (F06) kommer hoppet vid halvminutsticken och återgången 1,2 s senare, 25 ms efter en annan båts rad; den uttömda båtens nästa rad kommer 155 s efter hoppet. Bara minsta repro r2 har B4-studsen med återgången 25 ms efter raden. En B4-studs vid en annan båts rad ger KANDIDAT sedan R3c: radens båt måste ha kunnat bära "strax", och den uttömda båtens fix (inom 500 m, yngre än 600 s, på väg mot bron) räknas som en annan möjlig bärare.
- **Tick-varianten omfattas inte heller.** Där släpps "strax" vid en annan textgenerering än båtens nästa rad (en halvminutstick, en annan båts rad eller en timer) när åldern har passerat 600 s. Ägarbeslutet U16 täcker den: beslutsfråga 3 (a) beskrev posten för studsen med ett hopp som sammanfaller med åldersgränsen eller 90 s-taket och en återgång med samma båts nästa fix, och ägaren valde DESIGN. Posten är smal av två andra skäl: dirigentens uppdrag gällde studsen vid båtens nästa rad, och predikatet måste kunna avgöra på raderna att den gamla fixen var den som bar "strax". I värld 1507 (F04) kommer hoppet 65 s före båtens nästa rad, och "strax" kommer tillbaka 74 ms efter den raden. I värld 1038 (F06) får båten ingen ny rad, och "strax" kommer tillbaka 50 s senare, 25 ms efter en annan båts rad.
- **ETA-hoppet vid 600 s utan "strax" omfattas inte.** I tio av F04:s utslag med triagens 600 s-mekanism rensar `ETA_STALE_HARD` båtens ETA vid en tick, och hoppet går från hennes ETA, inte från "strax", till nästa båts (i värld 765 från 6 till 21 min). "Strax" kommer 25 ms efter hennes nästa rad, 25 s respektive 104 s senare i värld 765 och 60. F40-avvägningen i helgranskningen nämner ETA-hopp vid 600 s-gränsen, men U16 gäller "strax", och posten kräver "strax" före hoppet (rad 18).

### Användarbesluten U17–U21 (2026-11-04, kväll) och dirigentens beslut om R2:s fråga 2

Ägaren besvarade designernas ägarfrågor i rättningskampanjen efter den första rapporten. Besluten står i `docs/ARCHITECTURE.md` där appens beteende beskrivs (U17 vid RECOVER-släppet, U18 och U19 vid U-svängspunkten, U15 vid returresan) och speglas här för motorn. Registret 2026-11-07 (rad 23–31 nedan) lägger in posterna. Varje post har jest-fall åt båda hållen i `__tests__/j-kampanj-register.test.js`.

- **U17 (familj K, den tysta båten): RECOVER-släppets säkerhetsvarning behålls.** Den gäller en båt vars senaste position sa att hon skulle hinna igenom den gemensamma öppningen, men där appen inte vet om hon gjorde det. Ingen öppning får missas, så F11/F23-klassen godtas som falsklarm av samma slag som AVBRUTEN_APPROACH (`docs/ARCHITECTURE.md:1869–1886`). Posten U17-TYST-BÅT-RECOVER (DESIGN) gäller T3 VARNING-EFTER-SANN-PASSAGE och VARNING-PÅ-FRUSET-FIX och kräver fyra saker: båten absorberades i en händelse E vars varning kom före hennes sanna korsning; fyndets varning är hennes egen, kom efter absorptionen och avfyrades av ticken i radiotystnad; hennes sista rad före varningen kom före korsningen; och korsningen ligger högst CONVOY_WINDOW_MS efter E:s första sanna korsning. Ingen fixålder, som K-familjen föreslog. Ligger korsningen mer än 600 s efter E:s första korsning hörde hon till nästa öppning; det är K-familjens kvarvarande gräns K-TYST-BÅT-NÄSTA-ÖPPNING (KÄND_ÖPPEN, också för T2 LEDTID), som står kvar för att banken inte kan belägga alternativ A (U13).
- **U18 (familj R1): Fix D:s krav på två positioner innan en vändning tros behålls** (Anomali 18, `docs/ARCHITECTURE.md:1028–1035`). En retur med gles AIS får därför sin varning sent eller inte alls, och det är en känd gräns. Posten U18-RETUR-BEKRÄFTAD-SENT (DESIGN) ersätter både R1:s föreslagna U18-EN-OMVÄND-FIX-FÖRE-RETUR och K2:s U15-RETUR-SEN. K2-granskaren varnade för att U15-RETUR-SEN bara byggde på tid och kunde dölja sena egna returvarningar som inte beror på U18. Därför är posten knuten till mekanismen: båten har en L0-vändning högst 30 min före korsningen och minst en omvänd fix med FIX_D_MIN_SOG före den, och Fix D:s bekräftelse, spelad på raderna (`spelaFixD`), kom sent. För ÖPPNING-MISS:OKLASSAD betyder sent efter korsningen. För LEDTID och VARNING-EFTER-SANN-PASSAGE betyder det under 2 × TICK_INTERVAL_MS före korsningen eller efter den, och den egna varningen ska ha kommit inom 2 × TICK_INTERVAL_MS efter bekräftelsen. Klassen är DESIGN och inte KÄND_ÖPPEN, eftersom ägaren har fattat beslutet och frågan alltså inte är öppen; granskarens skäl för KÄND_ÖPPEN (tidsvillkoret) gäller inte det mekanismbundna predikatet.
- **U19 (familj R1): en planerad öppningsvarning skickas även när en obekräftad vändning väntar** (`docs/ARCHITECTURE.md:1036–1042`). Posten U19-VARNING-UNDER-VÄNTANDE-VÄNDNING (ACCEPTERAD, som FALSKLARM-AVBRUTEN-GLES) gäller T9 FEL-RIKTNING för en varning och T3 FANTOM-UTAN-AVBROTT: varningen är båtens egen, Fix D väntade på den andra observationen när den gick, vändningen bekräftades efteråt, och varningen är inget RECOVER-släpp (K:s anmärkning om värld 1590). Exempel: ZELDA i värld 188 och SALTIS i värld 1590.
- **U20 (familj E2): ETA-utjämningen och spärren görs om i kampanjen.** Beslutet gäller appens ETA-väg (F06, F07) och ger ingen registerpost: utslagen ska bli BORTA genom rättningen. E2 är inte integrerad på e088a51, och INV-3-korten i standardkörningen står kvar som KANDIDAT.
- **U21 (familj N): ingen sen notis för en returpassage under ett långt AIS-avbrott** (beslutet 2026-09-07 "ingen ny notis antas ur glappet" står fast; dirigentens gräns 2026-11-05: en returnotis bara högst STALE_ETA_HARD_THRESHOLD_MS efter den interpolerade korsningen). Beslutet hör till N:s notis per passage (U14), som inte är integrerad på e088a51. Posten U21-SEN-RETURNOTIS läggs in med N, och INV5-VS-BESÖKSREGEL rörs inte förrän dess.
- **Dirigentens beslut om R2:s fråga 2 (2026-11-04): JA.** En båt som får sin målbro först vid eller just efter bron bokför bron som mellanbro, och det är korrekt appbeteende (värld 1227 ELSA MARIA och 1731 KAJSA). Appen ger inget mål utan rörelsebevis (`MOVEMENT_PROOF_SOG_KN`, `MOVEMENT_PROOF_NET_M`), och `_calculateTargetBridge` väljer målbro på latitud mot brons latitud, så en båt som föds eller återföds stilla vid bron, eller redan bortom den, kan inte ha bron som mål när hon korsar linjen. Posten R2-MÅLBRO-EFTER-LINJEN (DESIGN, R2:s predikat) gäller INV-F INV-13. R2:s egentliga dubbelbokföring (värld 254, registrerad 13 min efter första raden bortom bron) omfattas inte.
- **U15 och U2-RETURRESA.** U15 (2026-11-04) besvarade U2-RETURRESA:s fråga: INV-21:s returresa är kontraktet, och returen får en egen varning (K2, commit 2c3f778). Posten användes fortfarande tre gånger i standardkörningen på e088a51 (värld 1208, 1316 och 1317), men varje träff är nu antingen U18 (1317: Fix D bekräftade först efter korsningen) eller en retur utan egen varning som U15 kräver (1208, 1316). Därför är posten borttagen och inte märkt som löst. Samtidigt förklarar U2-VS-DEADLINE och J13-J14-KONVOJSEMANTIK aldrig en returresa via båtens egen äldre händelse (`konvoj.egenKorsningEfter`): utan vakten hade J13 tagit över värld 1316 och 936.

### Registerändringar att granska (rättningsrundan 2026-11-04)

Rad 1–17 och 19–22 rättar motorfel eller registrerar en mätgräns i ett befintligt orakel och skriver inga nya ägarbeslut. Rad 18 speglar ägarens beslut U16 (2026-11-04, ovan), rad 19 och 21 snävar den posten efter motorfel, och rad 21 gör den till MÄTGRÄNS med beslutet U16 kvar som källa för beteendet. Rad 23–31 (registret 2026-11-07, på e088a51 med familjerna K, K2, M, E, R1 och R2 integrerade) speglar användarbesluten U15, U17, U18 och U19, dirigentens beslut om R2:s fråga 2 och familjernas kända gränser (ovan); de skriver inga nya beslut. Varje post pekar på sin källa. Ägaren bör granska listan.

| # | Post | Ändring | Skäl och källa |
|---|---|---|---|
| 1 | KIE-PER-KORPUS | Predikatet `kiePrefix` kräver samma episod: utslagets tid högst \|δ\| + 5 min från undantagets (parametern `toleransMin: 5`), samma fartyg när undantaget namnger ett. Relation BAS (låst bank) amnestieras aldrig. Regeltexten är uppdaterad. | Motorfel M03. Inget av bankens tre undantag namnger ett fartyg, så tidsvillkoret saknades helt och en ny DEFAULT-FLASH på låst bank hamnade under Kända utfall. Källa oförändrad: `corpora.js:21–23` (EXAKTA utslagssträngar, prefixmatch) och `runAllCorpora.js:252–262` (FP9). 42h-flashens fasvarianter är fortfarande ACCEPTERADE. Toleransen snävades i efterrättningen (rad 9). |
| 2 | D4-RIKTNING-UNKNOWN | `gäller` är nu bara M-FAS med klassRegex `^(NOTIS\|ÖPPNINGS)RIKTNING BYTT$` (förut T9, M-FAS och T11 med `.*`). Predikatet läser bara `belägg.nyRiktning`, utan återfall på fyndets riktning. | Motorfel M05: en tappad, tillagd eller förskjuten notis med riktningen unknown blev DESIGN. Källa oförändrad: reliability-spec D4 (`:45`, `:105`). T9 tillämpar D4 själv (`t9Direction.js:55–58`: anspråk med unknown döms inte); T11 är inte byggt. |
| 3 | KAJGRIND-UTAN-RÖRELSEBEVIS, U10-BN2-PASSERAD-FORM, UNDER-BRO-BANDET-70M, FALSKLARM-AVBRUTEN-GLES, DEADLINE-10KN-GARANTIPRIS | Ny `verkan: "iOraklet"` och fältet `orakelvakt` (fil:rad; sedan runda 2 fil#symbol, rad 13). Gäller, predikat och regel är oförändrade. | Motorfel M12: oraklen utesluter redan fallen, så predikaten blev aldrig sanna (användning 0 i standard) men posterna stod som "Närmast". Val per post och orakelvakt: se nedan. |
| 4 | U2-RETURRESA | Posten är oförändrad utom regeltexten; predikatet `uturnReturnAbsorbed` använder `konvoj.returresa`. Returen hör till en egen äldre händelse när båten var täckt av den vid utresan (medlem, ledare eller absorberad) och returen ligger inom händelsens konvojfönster. Förut krävdes en absorbed-rad men inget fönster. | Motorfel M04 och triagens T-2. Källa oförändrad: `invariants.js:866–871` mot `etapp7-plan:9`. |
| 5 | U2-VS-DEADLINE | Posten är oförändrad utom regeltexten; predikatet använder `konvoj.inomHändelsefönster`. Båten måste ha varit täckt av den äldre händelsen före korsningen, och händelsens första passage måste vara en annan båts. | Motorfel M04: 13 av 40 OKLASSAD-amnestier i första standardrapporten gällde en båt som aldrig täcktes, och 3 räknade båtens egen utresa (världarna 936, 1208 och 1317). Källa oförändrad: `etapp7-plan:310–349` (C-IV: garantin förfaller medan båten är täckt). |
| 6 | J13-J14-KONVOJSEMANTIK | Posten är oförändrad utom regeltexten; predikatet använder `konvoj.ickeMedlemEmellan`: en händelse som täckte båten och som fortfarande var öppen enligt medlemskravet, och en båt utanför händelsen som korsade emellan. Förut prövades bara den sista varningen, oavsett om den täckte båten, och en absorberad medlem räknades som icke-medlem. | Triagens T-2 (samma definition som T2-oraklet). Kravet på en öppen händelse följer av J14 (en händelse stängs av sina medlemmars passager): hade en medlem passerat mer än CONVOY_WINDOW_MS före hade appens täckning löpt ut, och då förklarar medlemskravet inte den uteblivna varningen (konvojfönstrets bakkant, värld 675 och 1011 i A/B). Källa oförändrad: `ARCHITECTURE.md:1611–1628`. |
| 7 | MÄTGRÄNS-INV10-VÄNTKEDJA (ny) | MÄTGRÄNS för INV-F INV-10 STRAX-ZOMBIE när de bekräftade väntintervallen för bron bildar en kedja med högst 30 s mellan angränsande intervall, börjar senast 10 min efter strax-övergången och slutar högst 30 s före nästa övergång. | Triagens T-1 (F18): mätgräns i ett befintligt orakel. Källa: `invariants.js:476–503` (ETT intervall krävs), `replayRunner.js:293–311` (ett intervall per fixglapp) och `etapp7-plan-2026-08-08.md:15` (U6: strax vid lång väntan är sanktionerat). Samma granularitet finns i `replay:all` (§6, rekommendation). Snävad i runda 2: inget glapp får innehålla en halvminutstick (rad 12). |
| 8 | S10-VÄNDNING-BRON-BAKOM (ny) | DESIGN för T1 NOTIS-UTEBLIVEN när fixen före besöket hade det motsatta kursbandet och alla fixar inom 300 m under besöket går i det nya bandet med minst MIN_VIABLE_SPEED (0,5 kn), med bron bakom sig och inom FIX_D_PENDING_MAX_AGE_MS (15 min) från den första, utan korsning i besöket. | Triagens T-3 (F15): S10-vakten är användargodkänd, `ARCHITECTURE.md:1928` (FIXRUNDA 6 LIGHT, 2026-08-23: "S10+S6 godkända"); vakten `app.js:9708–9783` och loggraden FLOW_TRIGGER_SKIP_PENDING_REVERSAL `app.js:10293`. Replayresultatet bär inte loggraden, så predikatet prövar vaktens tre villkor på raderna. Snävad i runda 2 till Fix D:s fartgräns (rad 10) och till Fix D:s tillstånd före zonen (rad 15). |
| 9 | KIE-PER-KORPUS (efterrättning D) | Parametern `toleransMin: 5` ersätts av `tickS: 30`. Utslagets tid ska ligga högst \|δ\| + L + en tick från undantagets (L = episodens längd ur meddelandena, den längre av undantagets och utslagets), och ett undantag förklarar högst en träff per variant, den närmaste (`belägg.syskon`, satt av `relations.comparePhase`). Regeltexten är uppdaterad. Posten blir smalare, aldrig bredare. | Motorfel i rättningen av M03 (granskarens varv r0): en separat DEFAULT-FLASH 2, 4 och 5 min efter 42h:s kända flash blev ACCEPTERAD "samma episod", och varje undantag kunde amnestiera hur många träffar som helst i en variant. Källa oförändrad: `corpora.js:21–23` och `runAllCorpora.js:252–262`. Den kända flashens fasvarianter ligger 0–30 s från undantaget (en tick tidigare vid δ −7, −11,52 och −20 s) och är fortfarande ACCEPTERADE (acceptanskriteriet i §14). Påståendet "aldrig bredare" höll inte för långa flashar; rättat i rad 11. |
| 10 | S10-VÄNDNING-BRON-BAKOM (runda 2, E1) | Predikatet `reversalAwayFromBridge` kräver att zonens första fix har sog ≥ FIX_D_MIN_SOG (2,0 kn) och att ingen senare zonfix har det. Ny parameter `fixDMinSogKn`, vars standardvärde läses ur appens källtext (`appKonstant`, `VesselDataService.js`), inte ur registret. Källan är utökad med `VesselDataService.js:380–391` och `:446–470`, och regeltexten är uppdaterad. Regeltextens "bara en sådan fix sätter Fix D:s pending-flagga" gäller bara när ingen färsk flagga redan finns och låset fortfarande är det gamla; kompletterat i efterrättningen (rad 15). | Motorfel i rättningen av T-3 (granskarens varv r1, nytt problem 1, medel). Predikatet krävde bara MIN_VIABLE_SPEED (0,5 kn) och godtog hur många zonfixar som helst inom 15 min. Appens S10-vakt slår bara till när Fix D har en färsk pending-flagga, och den sätts bara av en omvänd fix med sog ≥ FIX_D_MIN_SOG (`VesselDataService.js:380–391`). En andra omvänd fix med minst den farten inom FIX_D_PENDING_MAX_AGE_MS bekräftar reversalen (`:446–470`, `_confirmDirectionReversal`), och då går notisen ut. Granskarens sonder i värld 581, med notisen borttagen: s10sog (zonfix 0,6, 1,0 och 1,9 kn; appen notifierar) och s10two (en eller två extra zonfixar på 2,2 kn; appen notifierar 10:06:36 respektive 10:06:31) gav DESIGN, nu KANDIDAT. Zonfix 2,2 och 3,6 kn, där appen avstår, är kvar som DESIGN, liksom F15:s tre världar (215, 581 och 1818, med en zonfix på 3,6, 2,2 och 2,4 kn). Egen kontroll mot appen: med en senare zonfix på 1,5 kn notifierar appen inte (DESIGN), med 0,4 kn notifierar den (KANDIDAT). |
| 11 | KIE-PER-KORPUS (runda 2, E3) | L tas bara ur undantaget och bara för klasser vars tid är episodens slut (ETA-SÅGTAND UPP "på Ns", ETA-OSCILLATION "inom Ns"). DEFAULT-FLASH jämförs start mot start med \|δ\| + en tick, och utslagets egen längd vidgar aldrig fönstret. Parametrarna och källan är oförändrade. Regeltexten är uppdaterad och citerar `invariants.js:170–180` och `:438` (DEFAULT-FLASH:s tid är starten) samt `:321` och `:351` (ETA-klassernas tid är slutet). | Motorfel i efterrättning D (granskarens varv r1, nytt problem 3). DEFAULT-FLASH:s tid är starten av "Inga båtar" och "(Ns)" dess längd, så en separat lång flash vidgade sitt eget fönster. I granskarens kiewindow2 (42h, δ +7 s) blev flashar på 240 s vid +4 min, 290 s vid +5 min och 300 s vid +5,5 min ACCEPTERADE; i varv r0 var den sista KANDIDAT. Nu är alla KANDIDAT. Påståendet i rad 9 ("smalare, aldrig bredare") höll alltså inte; nu gäller det, eftersom det nya L aldrig är större än det gamla. 42h-flashens fasvarianter ligger 0 och 30 s från undantaget och är ACCEPTERADE vid alla fem δ (acceptanskriteriet i §14). Bankens två 41h-undantag saknar längd i strängen, så också ETA-klasserna jämförs där med \|δ\| + en tick. |
| 12 | MÄTGRÄNS-INV10-VÄNTKEDJA (runda 2, E2) | Predikatet `chainedConfirmedWait` godtar inget glapp i kedjan som innehåller en halvminutstick, med nya parametrar `tickS: 30` och `tickFördröjningMs: 40`. En tick räknas på absoluta halvminuter, med textgenereringens mikrograce. Svansen på högst 30 s behålls. Källan är utökad med `BridgeTextService.js:304–308` (hasFreshPosition), och regeltexten är uppdaterad och citerar `app.js:13089–13096` (UI-klockans absoluta halvminuter) och `:5513–5520` (mikrograce, högst 40 ms). | Mätgränsen var för bred (granskarens varv r1, nytt problem 2). Vid en UI-tick inne i glappet är positionen inte färsk, så 'strax' spärras av hasFreshPosition och en korrekt app byter text där. Granskarens inv10tick-b (värld 1228 med fixen flyttad till 09:00:10 och 'strax' kvar över ticken 09:00:00, glapp 25 s) gav MÄTGRÄNS, nu KANDIDAT. F18:s glapp 08:59:44,854–08:59:57,860 innehåller ingen tick och är kvar som MÄTGRÄNS. Ett glapp på 30 s innehåller alltid en tick, så i praktiken måste glappet vara kortare än 30 s. |
| 13 | KAJGRIND-UTAN-RÖRELSEBEVIS, U10-BN2-PASSERAD-FORM, UNDER-BRO-BANDET-70M, FALSKLARM-AVBRUTEN-GLES, DEADLINE-10KN-GARANTIPRIS (runda 2, E5) | `orakelvakt` pekar på en symbol i stället för rader: `t1Notice.js#judgeT1`, `t10Passage.js#decisiveFixAfter`, `t2Opening.js#judgePhantom`, `runOpeningGates.js#classifyPhantom` och `#classifyLatePassage`. Laddningen varnar när en citerad symbol inte definieras i filen och när motorns egna filer citeras med rader. Gäller, predikat och regel är oförändrade. | Inaktuell hänvisning (granskarens varv r1, nytt problem 5). `t10Passage.js:57–60` var efter efterrättning D JSDoc, inte `decisiveFixAfter` (62–65), och laddningen kontrollerade bara att filen fanns. Även `runOpeningGates.js:1067–1068` låg en rad fel, eftersom GLES_ANFLYGNING står på rad 1066. Ingen klassning ändras: posterna prövas aldrig. |
| 14 | STRESS-TÄTHET (runda 2, E7) | Posten är oförändrad. `Registry.applies` låter en taggpost utan inv-lista nå INV-F-fynd. En omklassande post måste fortfarande namnge INV-id:t (säkerhetsregeln), också med orakel `*`, och laddningen kräver INV-id för en post som namnger INV-F. `_om` i registret är uppdaterad. | Motorfel som fanns före rundan (triagens anmärkning efter varv r1). Posten har orakel `*` men inget inv, så de 5 INV-F-fynden i standardkörningens stressvärldar (F18, F19 och INV5-stressklustret) saknade taggen, medan T1-, T2- och T3-fynden hade den. Sektioneringen påverkas inte, eftersom M10 klustrar på fyndets nivå. |
| 15 | S10-VÄNDNING-BRON-BAKOM (runda 2, efterrättning H) | Predikatet `reversalAwayFromBridge` spelar Fix D:s pending-logik över fartygets alla fixar före zonens första fix (`spelaFixD`), med det gamla bandet som riktningslås. En fix med sog ≥ FIX_D_MIN_SOG som är omvänd mot låset sätter flaggan, eller bekräftar reversalen och byter lås om en flagga i samma riktning är yngre än FIX_D_PENDING_MAX_AGE_MS. En fix med sog ≥ FIX_D_MIN_SOG som inte är omvänd nollar flaggan, och långsammare fixar rör ingenting. Predikatet är falskt när en färsk flagga redan finns (zonens första fix bekräftar då reversalen, och notisen går ut) och när låset redan är det nya (zonens första fix är då inte omvänd och sätter ingen flagga). Är zonens första fix långsammare än FIX_D_MIN_SOG och finns en färsk flagga från före zonen, säger skälet det; utfallet är som förut KANDIDAT. Parametrarna är oförändrade. Källan är utökad till `VesselDataService.js:380–407` och `:446–476` (kursbanden mot låset och nollningen), och regeltexten är uppdaterad. | Motorfel i rättningen E1 (granskarens varv s0, nytt problem 1, låg). Predikatet antog att zonens första fix satte flaggan, men en omvänd fix med minst 2,0 kn före zonen kan redan ha satt den, och en långsammare fix i det gamla bandet nollar den inte, eftersom den inte klarar blockets yttre villkor (`:383–391`). Granskarens s10x i värld 581 (10:03:51 omvänd på 2,2 kn, 10:05:18 i det gamla bandet på 1,9 eller 1,0 kn): appen bekräftar reversalen 10:06:16 och notifierar söderut. Med notisen borttagen gav predikatet DESIGN, nu KANDIDAT. Med 10:05:18 på 2,2 kn nollas flaggan, appen avstår, och utfallet är kvar som DESIGN. Granskarens förslag (sätt och nolla flaggan, utan lås) hade missat fallet med två omvända fixar före zonen (10:02:53 och 10:03:51): appen bekräftar då reversalen före zonen, fixen 10:05:18 i det gamla bandet flaggar tillbaka, och zonens första fix nollar den flaggan. S10-vakten avstår inte, och appen notifierar 10:06:16. Det fallet är nu KANDIDAT, och med ännu en fix i det gamla bandet (bekräftat tillbaka) DESIGN. Flaggans ålder räknas som i appen (`< FIX_D_PENDING_MAX_AGE_MS`, `:448–451`): en flagga 899 999 ms gammal bekräftas och appen notifierar, en på 900 000 ms är inaktuell och appen avstår. Samma mönster gäller i den nordvända världen 1818. Alla utfall är prövade mot appen med sonden s10h (granskarens s10x utvidgad med appens Fix D-loggrader), redovisad i efterrättningens svar. F15:s tre världar är kvar som DESIGN med oförändrat skäl. |
| 16 | S10-VÄNDNING-BRON-BAKOM (runda 3, L1) | Predikatet `reversalAwayFromBridge` och hjälparen `spelaFixD` prövar en rad utan finit kurs eller fart med fartygets senast kända värde (`medFramfördKursOchFart`), som appen gör. Det gäller spelet före zonen, fixen före besöket och zonfixarna, och ett framfört värde redovisas i skälet med tiden det kom från. Parametrarna är oförändrade. Källan är utökad med `VesselDataService.js:5286–5287`, och regeltexten är uppdaterad. | Motorfel i efterrättning H (granskarens varv s1, nytt problem 1, låg). `_createVesselObject` sätter sog och cog till det gamla fartygsobjektets värden när raden saknar dem (`VesselDataService.js:5286–5287`). Fix D-blockets yttre villkor (`:384–392`) och S10-vaktens krav 3 (`app.js:9745`) prövar sedan det värdet. spelaFixD hoppade över raden, och zonkontrollerna dömde den som saknad kurs eller fart. Granskarens sond s10h i värld 581: 10:03:51 utan kurs på 2,2 kn (216° från raden före) eller med 216° utan fart (2,2 kn från raden före). Appen sätter flaggan där, bekräftar reversalen 10:06:16 och notifierar. Med notisen borttagen gav predikatet DESIGN, nu KANDIDAT. Egna sonder mot appen (s10h, värld 581, notisen borttagen) gav samma utfall som appen: en rad utan kurs på 2,2 kn med 30° från raden före nollar flaggan, zonens första fix utan fart får 2,2 kn från fixen före besöket, fixen före besöket utan kurs får 30° från raden före, och en senare zonfix utan kurs på 1,0 kn bekräftar inte. I alla fyra avstår appen, och utfallet blir DESIGN, förut KANDIDAT. En senare zonfix utan fart får 2,2 kn och bekräftar reversalen. Där notifierar appen 10:06:36, och utfallet är KANDIDAT som förut, nu med rätt skäl. Jest-fallet `h-efterratt.test.js:211`, som låste fast det gamla beteendet, är ändrat. Sanningsspårets radio ger aldrig null-fart och null-kurs bara vid sog ≤ 0,4 kn, och S10 används inte i bankkalibreringen. |
| 17 | Hänvisningskontrollen (runda 3, L2) | Ingen post ändras. `definesSymbol` tar bort block- och radkommentarer innan den matchar (`utanKommentarer`) och räknar inte en import som definition: `const x = require(…)`, en destrukturerad require även över flera rader, `= await import(…)`, `import … from` och `export … from`. Den rensade källtexten cachas per fil på storlek och ändringstid. | Kontrollen var svagare än dokumentationen lovade (granskarens varv s1, nytt problem 2, låg). Granskarens fyra fall gav sant, nu falskt: `// const decisiveFixAfter = null;`, `/* function judgeT1(ctx) { gammal version } */`, en rad `judgeT1: …` i en blockkommentar utan asterisk och `const judgeT1 = require("./t1Notice").judgeT1;`. Lexern ger samma kommentarer som espree i alla 471 JS-filer i arbetskopian (app.js, lib/, drivers/ och tests/). Registret laddar med 0 varningar, och alla symbolhänvisningar definieras fortfarande. Ingen klassning ändras. |
| 18 | U16-F40-STRAX-STUDS (ny, runda 3) | DESIGN för INV-F INV-3 ETA-OSCILLATION och ETA-SÅGTAND UPP med predikatet `f40StudsVidNästaFix`. Fönstret är 1 s; åldern STALE_ETA_HARD (600 s) och radien WAITING_CLEAR_DISTANCE (350 m) läses ur `lib/constants.js`. Posten står efter KIE-PER-KORPUS, så att KIE-PER-KORPUS fortfarande är "närmast" för INV-3- och INV-14-utslag. Den gäller aldrig den låsta banken. Bunden till den "strax"-bärande båten i efterrättningen R3b (rad 19). | Ägarbeslutet U16 (2026-11-04, ovan; `docs/buggjakt-triage-2026-11-04.md` §Ägarens beslut). Källor: `docs/helgranskning-2026-07-06.md:271–274`, `docs/etapp7-plan-2026-08-08.md:8`, `:15` och `:267`, `app.js:7107–7113`. Mätt på triagens 49 återskapade världar för F04, F06, F18 och F19 i s1-standard-a uppfyller bara värld 1608 predikatet: F18:s och F19:s utslag, samma övergång. Av de 17 utslag i F04 (14) och F06 (3) som triagen gav F18:s mekanism flyttar inget. I 10 av F04:s 14 går hoppet inte från strax (till exempel 6→21, 2→10 och 15→25 min). I de övriga 7 (1507, 368, 1241 och 1521 i F04; 1038, 888 och 1275 i F06) kommer hoppet vid en annan textgenerering än båtens nästa rad (en halvminutstick, en annan båts rad eller en timer), och återgången till strax kommer 1,2–87 s senare. Två av dem gäller 600 s-gränsen: i 1507 kommer hoppet 65 s före båtens nästa rad, och i 1038 får båten ingen ny rad och återgången kommer med en annan båt. De fem övriga är B4-varianten. Värld 1907, F18:s och F19:s andra värld, är också B4-varianten, med återgången 22 s efter raden, och står kvar. |
| 19 | U16-F40-STRAX-STUDS (efterrättning R3b) | Predikatet `f40StudsVidNästaFix` är bundet till den båt som kan ha burit "strax". Hoppet ska vara publicerat exakt när harnessen bearbetade båtens rad (`harnessTider`, en modell av harnessens klocka), och båtens ålder räknas från när harnessen bearbetade hennes förra fix, som appens. Ingen brotext och ingen halvminutstick (i variantens fas för M-FAS) får falla mellan 600 s-gränsen och hoppet. Fixarna ska ligga utanför kajkapslarna (MOORING_ZONES). Återgången ska komma efter radens bearbetning och högst 1 s efter radens tid, utan att någon annan båts rad inom 500 m från bron bearbetas emellan, och ingen styrrad får bearbetas mellan båtens förra fix och återgången. Hoppet har inget eget fönster längre: det ska ligga på radens bearbetning. Nya parametrar `straxRadieM: 500`, `tickS: 30` och `tickFördröjningMs: 40`. Regeltexten och källan är uppdaterade. Posten blir smalare, aldrig bredare: varje villkor från rad 18 finns kvar eller är skärpt. | Motorfel i rad 18 (granskarens varv r3, nytt problem 1, medel): predikatet prövade aldrig att båten med den gamla fixen var den som bar "strax", så vilken båt som helst inom 350 m med en fix äldre än 600 s och en rad högst 1 s från hoppet räckte. Granskarens u16e2e genom appen (F21:s minsta repro i R3-standard, alltså B4-studsen, och en förtöjd båt vid kajen norr om Klaffbron, 240 m från bron, tyst i 720 eller 605 s och med en rad 35 ms före ULLA:s) gav DESIGN, nu KANDIDAT. Samma båt 45 m öster om kapseln ger också KANDIDAT (appen ger samma texter). Granskarens enhetsfall (en annan tyst båt med en rad 23–41 ms före hoppet, en färsk MASEN 2 med en tyst båt i samma kluster, ett hopp 0,8 s efter MASEN 2:s färska rad) gav DESIGN, nu KANDIDAT. Källor: `replayRunner.js:122–126` och `:501–622` (harnessens klocka), `VesselDataService.js:5291` (positionen stämplas när raden bearbetas), `app.js:7239` ("strax" inom 500 m i den uttömda grenen), `app.js:13089–13096` (UI-klockan), `lib/constants.js:415–470` (MOORING_ZONES och köundantaget vid kajen). F18/F19 i s1-standard-a (värld 1608) är kvar som DESIGN: hoppet 09:42:15,101 när harnessen bearbetade MASEN 2:s rad, appens ålder 604,8 s (fixen bearbetades 09:32:10,291), ingen text eller tick mellan 600 s-gränsen 09:42:10,291 och hoppet, återgången 246 ms efter raden, och de tre rader som bearbetades emellan låg 1,0–1,7 km från bron. På triagens 49 återskapade världar uppfyller fortfarande bara värld 1608 predikatet. |
| 20 | Hänvisningskontrollen (efterrättning R3b) | Ingen post ändras. `definesSymbol` räknar inte en objektegenskap vars värde är en import (`namn: require(…).namn,`, även med värdet på nästa rad, eller `namn: await import(…),`) eller bara ett annat namn (`namn: namn,`, `namn: a.b,`) som definition. | Motorfel i rad 17 (granskarens varv r3, nytt problem 2, låg): `judgeT1: require("./t1Notice").judgeT1,` och `judgeT1: judgeT1,` i ett module.exports-objekt gav sant, så en fil som bara återexporterar en flyttad funktion klarade hänvisningskontrollen. Nu falskt. En egenskap med eget värde (`stressDensity: {`, en pilfunktion eller ett funktionsuttryck) definierar fortfarande, och ett namn som definieras i filen hittas även när en egenskap pekar på det. Registret laddar med 0 varningar, och de fem symbolhänvisningarna definieras fortfarande. Ingen klassning ändras. |
| 21 | U16-F40-STRAX-STUDS (efterrättning R3c) | Klassen är MÄTGRÄNS i stället för DESIGN. Predikatet `f40StudsVidNästaFix` har två nya krav: båten kunde bära "strax" vid sin förra fix (fixen inom 300 m, imminent SET, eller inom 350 m efter en tidigare fix inom 270 m utan att båten lämnat 350 m emellan), och ingen annan båt kunde bära det vid hoppet (ingen annan båt har sin senaste fix före hoppet inom 500 m, högst 600 s gammal i appens klocka, utanför kajkapslarna och på väg mot bron: kursen inom ±90° från bäringen till bron, eller saknad kurs inom 350 m). Nya parametrar `imminentRadieM: 300` (`app.js:7210–7212`) och `väntRadieM` (WAITING_SET_DISTANCE, 270 m, ur `lib/constants.js`). Kraven prövas sist, så de tidigare skälen är oförändrade. Regeltexten och källan är uppdaterade; användarbeslutet U16 står kvar som källa för beteendet. Posten blir smalare, aldrig bredare. | Motorfel i rad 19 (granskarens slutvarv, nytt problem 1, medel): posten tog radens båt som bärare utan att pröva att hon kunde bära "strax" eller att ingen annan båt kunde det, så en B4-studs (90 s-taket) blev DESIGN när en tyst båt som aldrig bar "strax" hade den första raden efter släppet. Granskarens ce-b (Y 320 m från Klaffbron, tyst i 605 s) gav DESIGN och ce-b590 (tyst i 590 s, bitlik apputdata) KANDIDAT; nu ger båda KANDIDAT. Enhetsfallet med en stillaliggande båt 262 m från Klaffbron och ULLA:s rad borttagen gav DESIGN och ger nu KANDIDAT. Klassen (granskarens nya problem 2, låg, och triagens beslutsfråga 3 (a), som erbjöd MÄTGRÄNS): hoppet vid båtens nästa rad uppstår för att harnessen skjuter upp appens asynkrona UI-arbete till nästa dränering (setImmediate-omkörningen, `replayRunner.js:86–88` och `:512–521`, `app.js:6857–6862`); i fält hade omkörningen gått vid halvminuten med åldern cirka 590 s. Användarbeslutet U16 (beteendet behålls: aldrig "strax" på en position äldre än 10 min) påverkas inte. Värld 1608 (F18/F19) är kvar i posten, och enligt granskarens prototyp uppfyller på triagens 49 återskapade världar fortfarande bara värld 1608 predikatet. |
| 22 | Hänvisningskontrollen (efterrättning R3c) | Ingen post ändras. `definesSymbol` räknar inte ett egenskapsalias med värdet på nästa rad (`judgeT1:` och `judgeImpl,` på raden efter) som definition: `IMPORT_RES[4]` tillåter `\s*` efter kolon i stället för `[ \t]*`. | Motorfel i rad 20 (granskarens slutvarv, nytt problem 3, låg): aliaset på en rad gav falskt, men samma alias med värdet på nästa rad sant. Granskarens sond l2extra (13 kantfall) ger nu inga avvikelser; en egenskap med eget värde på nästa rad (ett funktionsuttryck) definierar fortfarande. Inga citerade filer har formen, och ingen klassning ändras. |
| 23 | U2-RETURRESA (borttagen) | Posten och predikatet `uturnReturnAbsorbed` är borttagna, liksom `konvoj.returresa` och returresesteget i `t2Opening.explainT2`. `konvoj.egenKorsningEfter` hindrar U2-VS-DEADLINE och J13-J14-KONVOJSEMANTIK från att förklara en retur via en händelse som båten själv passerat i; båda posternas regeltext och källa är uppdaterade. | U15 (2026-11-04) besvarade postens fråga, och K2 (2c3f778) ger returen egen varning. Posten användes tre gånger i standardkörningen på e088a51: 1317 blir U18, 1208 och 1316 blir KANDIDAT (returer utan egen varning; 1208 är R1:s föreslagna NEW_JOURNEY-kort). Utan vakten hade J13 tagit 1316 och 936 i stället. |
| 24 | U1-C11-TYST-FÖRE-DEFAULT (ny) | DESIGN för INV-F INV-14 DEFAULT-FLASH med predikatet `tystBärareFörfallen`: texten före episoden har för bron exakt "En båt på väg mot X, ETA okänd", och en båts tystnad passerar ett steg i STALE_DISPLAY_DROP-trappan (10/15/20/25 min) inom en halvminutstick före episodens start, räknat från harnessens bearbetning (`harnessTider`). Aldrig låst bank. | Familj M:s F05/r2 och klustrets B- och C-världar (U1, C11, C11b). Mätt på standardkörningens 15 DEFAULT-FLASH-kandidater på e088a51: alla 15 (182, 495, 621, 691, 715, 876, 1024, 1031, 1038, 1199, 1323, 1526, 1590, 1887, 1910), med tystnaden 904–1508 s och 0,4–29 s efter steget. M:s formulering ("varje fartyg som bar texten") är inte observerbar ur raderna; klausulen "ETA okänd" och trappsteget är det. |
| 25 | M-BRUSBAND-RÖRELSEBEVIS (ny) | KÄND_ÖPPEN för INV-F INV-14 DEFAULT-FLASH med predikatet `krypbandVidTröskel`: samma båt bär texten före och efter (episoden börjar och slutar vid hennes två på varandra följande rader, högst 40 ms senare), och hennes median-sog ligger inom ±0,1 kn från 0,1, 0,3 eller 0,7 kn, eller hennes närmande är 5–15 m per TARGET_REMOVAL_GRACE_PERIOD, eller hon saknar sog med en spridning över 8 m. Ny appkonstant TARGET_REMOVAL_GRACE_PERIOD. | M:s kända gränser (a)–(c), beslutade 2026-11-05 utan hysteres. Inga träffar väntas i dagens profiler (F-KRYP ger 0,4–1,5 kn); jest prövar syntetiska krypare. Gräns (d) har inget orakel och ingen post. |
| 26 | U18-RETUR-BEKRÄFTAD-SENT (ny) | DESIGN för T2 ÖPPNING-MISS:OKLASSAD, LEDTID och T3 VARNING-EFTER-SANN-PASSAGE med predikatet `fixDBekräftarReturSent` (ovan, U18). Står efter O1-ACCEPTERADE-MISSKLASSER. | Ersätter R1:s U18-EN-OMVÄND-FIX-FÖRE-RETUR, K:s U18-utvidgning och K2:s U15-RETUR-SEN med ett mekanismbundet predikat. Mätt på e088a51: OKLASSAD i värld 18, 134, 188, 227, 353, 1181, 1317 och 1731; LEDTID i 829, 1038 och 1274; T3 i 227. Motexempel: 1208 och 1316 (bekräftade före korsningen), 936 och 1918 (bekräftade 113 respektive 77 s före korsningen, egen varning först vid nästa fix) förblir KANDIDAT. |
| 27 | U17-TYST-BÅT-RECOVER (ny) | DESIGN för T3 VARNING-EFTER-SANN-PASSAGE och VARNING-PÅ-FRUSET-FIX med predikatet `tystRecoverSammaÖppning` (läge `samma`, ovan, U17). | Mätt på e088a51: 40 VARNING-EFTER och 11 FRUSET-FIX. Motexempel: 972 (varningen leds av en annan båt), 941 (båten hördes efter korsningen) och 625:s andra båt (ingen absorption) förblir KANDIDAT. |
| 28 | K-TYST-BÅT-NÄSTA-ÖPPNING (ny) | KÄND_ÖPPEN för T2 LEDTID och T3 VARNING-EFTER-SANN-PASSAGE med samma predikat i läge `nästa`. | K-familjen revision 3 (U13). Mätt på e088a51: T3 i 87, 331, 510, 582, 1704 och 1907, T2 i 790 och 1247. En egen varning som avfyrades av ett fix (U-svängsreturen 829) omfattas inte. |
| 29 | U19-VARNING-UNDER-VÄNTANDE-VÄNDNING (ny) | ACCEPTERAD för T9 FEL-RIKTNING (varningsanspråk) och T3 FANTOM-UTAN-AVBROTT med predikatet `väntandeVändningVidVarning` (ovan, U19). | R1:s förslag med K:s tillägg (inget RECOVER-släpp) och kravet att vändningen bekräftas efter varningen. Mätt på e088a51: 188 (T9) och 1590 (T3). |
| 30 | TVÅ-ÅTERKORSADE-BROAR-I-SAMMA-SEGMENT (ny) | KÄND_ÖPPEN för T10 PASSAGE-EJ-REGISTRERAD med predikatet `andraBronISammaSegment`. | R1:s kända lucka 1. Inga träffar i körningarna; jest prövar R1:s fixtur `r1-kand-lucka-tva-broar-i-segmentet.jsonl`. |
| 31 | U-SVÄNG-LÅNGSAM-ÅTERKORSNING (ny) | KÄND_ÖPPEN för T10 PASSAGE-EJ-REGISTRERAD med predikatet `returUtanRörelsebevis`. | R1:s kända luckor 2–5. Inga träffar i körningarna; jest prövar R1:s fixturer för tät långsam korsning och långsam vändning. |

**Valet för M12, per post** (flytta vakten till registret eller märka posten):
- **KAJGRIND-UTAN-RÖRELSEBEVIS: märkt.** T1:s förutsättning 3 (`t1Notice.js#judgeT1`, rörelsebeviset med MOVE_KN) dömer inget besök utan en fix med sog ≥ 1,0 kn i [tIn − 10 min; max(tOut, första fixen)] och räknar dem i `utanRörelsebevis`. Registrets fönster skilde bara med högst 120 s i svansen. Att flytta vakten till registret hade gjort varje kajliggare till ett rått T1-utslag.
- **U10-BN2-PASSERAD-FORM: märkt.** Formkravet prövas bara för en notis i förvarningsform (`t1Notice.js#judgeT1`). Passerad form är ingen avvikelse som behöver förklaras.
- **UNDER-BRO-BANDET-70M: märkt.** 70 m är T1:s och T10:s egen tröskel (`t1Notice.js#judgeT1` med BEYOND_M, `t10Passage.js#decisiveFixAfter`). En fix inom bandet ger inget utslag alls.
- **FALSKLARM-AVBRUTEN-GLES: märkt.** runOpeningGates accepterar klasserna (`runOpeningGates.js#classifyPhantom`), och T3 är tyst bara när L0 visar korsning eller avbrott; annars blir det FANTOM-UTAN-AVBROTT (`t2Opening.js#judgePhantom`). Att flytta vakten hade bytt klassnamnen i korten.
- **DEADLINE-10KN-GARANTIPRIS: märkt (inte rättat).** `belägg.veffKn` sattes ingenstans. Effektivfarten räknas redan i runOpeningGates (`runOpeningGates.js#classifyLatePassage`), där en sen passage med veff < 10 kn blir GARANTIPRIS och accepteras, och T3 ger då inget utslag (`t2Opening.js#judgePhantom`). En SEN-kandidat har därför alltid veff ≥ 10 kn eller okänd fart, så predikatet kunde inte bli sant ens med `veffKn` satt.

**Följder i standardens världar** (A/B med 2 000 världar, seed 1, `--lanes=synth --no-shrink`, arbetskopian före och efter rättningarna; 400 råa syntetiska utslag i båda):
- **T2 ÖPPNING-MISS:OKLASSAD med U2-VS-DEADLINE (41 före: R0 13, R1 22, stress 6):** 27 står kvar. 4 blir KONFLIKT U2-RETURRESA (världarna 936, 1208, 1316 och 1317: händelsens "första passage" var båtens egen utresa). 1 blir J13-J14-KONVOJSEMANTIK. 9 blir KANDIDAT (R0 2, R1 6, stress 1): båten var inte täckt vid korsningen av den händelse vars fönster förklarade den, och den händelse som täckte båten hade stängt (konvojfönstrets bakkant, till exempel värld 675 där båten korsade 662 s efter händelsens första passage).
- **J13-J14-KONVOJSEMANTIK (17 före):** 14 blir KANDIDAT, eftersom registret räknade absorberade medlemmar som icke-medlemmar (värld 119: korsningen 605 s efter händelsens första passage) eller händelsen redan hade stängt. 1 blir U2-RETURRESA (värld 1590: båten var absorberad i händelsen före utresan). 2 står kvar.
- **U2-RETURRESA (15 före):** 13 står kvar. 2 blir KANDIDAT: returen kom efter händelsens konvojfönster (värld 806: 617 s efter utresan, 17 s efter fönstret).
- **KANDIDAT → U2-VS-DEADLINE: 1** (värld 750: båten var absorberad i en händelse vars första passage gjordes av en annan absorberad medlem; förut räknades bara `mmsis`).
- **Oraklets förklaring och registrets post skilde sig för 66 av 170 T2-fynd före (13 i kandidatkluster), 0 efter.**
- **INV-10 STRAX-ZOMBIE i värld 1228 (F18)** blir MÄTGRÄNS via MÄTGRÄNS-INV10-VÄNTKEDJA, och **T1 NOTIS-UTEBLIVEN i världarna 215, 581 och 1818 (F15)** blir DESIGN via S10-VÄNDNING-BRON-BAKOM.
- Summan: T2 OKLASSAD-kandidater R0 1 → 5, R1 34 → 50 och stress 1 → 5. Inga andra syntetiska utslag ändrar registerutfall.
- **I standardkörningen med krympning** (alla tre rättarnas ändringar, 23 kort mot förra rapportens 18) försvinner korten F15 (T1, nu DESIGN via S10) och F18 (INV-10, nu MÄTGRÄNS). Kandidatklustret T2 ÖPPNING-MISS:OKLASSAD i R0/R1 växer från 36 till 55 utslag (53 världar) och blir F01 (minsta repro ur F-AVBROTT, gräns vid avbrottets längd 543–819 s). Konvojfönstrets bakkant står kvar som F02 (T2 LEDTID<60s, gräns B − A 627–664 s vid CONVOY_WINDOW_MS, "Närmast U2-VS-DEADLINE … utanför +600 s"). Bankkorten, KIE-PER-KORPUS för 42h-flashen (δ −20, −11,52, −7, +7 och +15 s) och KONFLIKT INV5-VS-BESÖKSREGEL är oförändrade.
- **Runda 2, rättare E (rad 10–14)** (A/B med samma 2 000 världar och bankens 168 fasvarianter, seed 1, `--lanes=bank,synth --no-shrink`; ögonblicksbilden efter runda 1 mot samma ögonblicksbild med bara `lib/registry.js`, `beslutsregister.json` och `lib/lanes.js` utbytta, så att de andra rättarnas samtidiga ändringar inte blandas in): 420 råa utslag i båda, inget byter registerutfall, och klustren är desamma (46, samma nycklar och antal). S10-VÄNDNING-BRON-BAKOM används 3 gånger och MÄTGRÄNS-INV10-VÄNTKEDJA 1 gång i båda: F15:s tre världar har en enda zonfix med minst 2,0 kn, och F18:s glapp innehåller ingen tick. KIE-PER-KORPUS används 5 gånger i båda (42h-flashen vid alla fem δ). Det som ändras är taggen STRESS-TÄTHET: 45 → 55 tillämpningar. Den når nu stressvärldarnas fem INV-F-fynd (världarna 1608 och 1907 med ETA-OSCILLATION och ETA-SÅGTAND, och värld 212 med INV-5), och dessutom bankens DEFAULT-FLASH i 42h, som fortfarande är ACCEPTERAD. Utan uppmätt täthet räknar `stressDensity` korsningskedjor i korpusens facit, och 42h är den enda av bankens 24 korpusar med en kedja på 6 korsningar (Olidebron söderut, högst 10 min mellanrum). Ett fynd av bankens övriga orakel (M-FAS, LEV, H1) i 42h kunde få taggen redan före rundan, eftersom inv-kravet bara gällde INV-F; i standardkörningen har 42h inget sådant fynd. Taggen ändrar varken klass, kluster eller sektion, men sanningsspårets och rapportens fingeravtryck ändras. Sonderna, jest-fallen och de tre verkliga bankkorten (F07–F09 i varv r1:s standardkörning, alla KVAR) är redovisade i rundans svar.
- **Runda 2, efterrättning H (rad 15)** (A/B med samma 2 000 världar och bankens 168 fasvarianter, seed 1, `--lanes=bank,synth --no-shrink`; arbetskopian efter varv s0 mot samma kopia med bara `lib/registry.js` utbytt): ingenting ändras. Rapporterna är lika utom tidsblocket, med fingeravtrycket 16a56465413b i båda, och `fynd/` skiljer bara i utkatalogens sökväg i `kommando.txt`. S10-VÄNDNING-BRON-BAKOM används 3 gånger i båda (F15:s världar 215, 581 och 1818): i deras spår rör ingen fix före zonen Fix D:s flagga. I standardkörningen prövas S10-predikatet bara där, eftersom alla andra T1 NOTIS-UTEBLIVEN-utslag fångas av poster före S10 i registret, och inget kort har mekanismen T1 NOTIS-UTEBLIVEN, så krympningen berörs inte. quick och självtestet efter efterrättningen ger samma fingeravtryck som i varv s0 (df2a702991a1 respektive 393a4609ced1).
- **Runda 3 (rad 16–18)** (standardkörningen R3-standard, seed 1, mot varv s1:s slutkörning s1-standard-a, alltså läget efter runda 2): 419 råa utslag i båda. U16-F40-STRAX-STUDS används 2 gånger: värld 1608:s ETA-OSCILLATION och ETA-SÅGTAND UPP (samma övergång, F18 och F19 i s1-standard-a) blir DESIGN och bildar två nya registerkluster i stressavsnittet. Klustren blir därför 47 i stället för 45, men korten är fortfarande 22. Stresskorten för INV-3 ETA-OSCILLATION och ETA-SÅGTAND UPP står kvar med värld 1907 (B4-varianten, en värld var) och heter nu F20 och F21. Deras minsta repro är bitlik med r2 i s1-standard-a (radhash d273b7117ba5 respektive 186e740575ce), och U16-skälet säger att ingen båt inom 350 m hade en fix äldre än 600 s vid hoppet. s1-standard-a:s F20 (T3 VARNING-EFTER-SANN-PASSAGE, stress) och F21 (T2 LEDTID<Ns, stress) heter nu F18 och F19. Alla övriga kluster har samma nyckel, antal, registerutfall, kortnummer och representanter. Representanterna blir 37 i stället för 39, eftersom F18 och F19 hade två var. Inga S10- eller hänvisningsutfall ändras (rad 16 och 17): S10-VÄNDNING-BRON-BAKOM används 3 gånger i båda körningarna (F15:s världar 215, 581 och 1818, utan rader som saknar kurs eller fart), och registret laddar med 0 varningar. KIE-PER-KORPUS används 5 gånger, MÄTGRÄNS-INV10-VÄNTKEDJA 1 gång och STRESS-TÄTHET 54 gånger i båda. Fingeravtrycket ändras från 19804855dcf4 till d430afed337c, och en andra körning efter containeromstarten (R3-standard-b) gav samma rapport utom tidsblocket. På INV-3-korten F04, F06, F07, F20 och F21 står U16-F40-STRAX-STUDS bland de prövade posterna, med skälet att villkoret fattas (till exempel "hoppet … går från 6 min till 16 min, inte från strax"). I en fasvariant läser predikatet fyndets tid, raderna och övergångarna i basens tidsram (§5.2), så skälets tider är basens: på F07 är hoppet 07:11:41,560 i basen och 07:11:30,040 i varianten (δ −11,52 s).
- **Efterrättningen R3b (rad 19–20)** (standardkörningen R3b-standard, seed 1, mot R3-standard): 419 råa utslag, 47 kluster, 22 kort (R0 6, bank 3, R1 7, stress 6) och 37 representanter i båda. Alla kluster har samma nyckel, antal, registerutfall, kortnummer och representanter. rapport.json skiljer sig bara i U16-postens skäl och därmed i sanningsspårets fyndHash och fingeravtrycket, som ändras från d430afed337c till 4bd9b2366e77. Skälet är nytt på de tolv INV-3-utslag där nivån går från "strax" till ett hopp och tillbaka till "strax" (368, 1241 och 1521 i F04; 8, 192, 888, 1038, 1183, 1275 och 1809 i F06; värld 1907 i F20 och F21), till exempel "hoppet 11:01:40.985 publicerades när harnessen bearbetade 265182731:s rad 11:01:40.985, men 265182731:s fix 10:54:53.804 (452 m från Klaffbron) var 407.2 s gammal (högst 600 s: färsk i appen)" för B4-studsen i värld 1907. Värld 1608:s två utslag är kvar som DESIGN, nu med appens ålder: MASEN 2:s fix 09:32:10,242 bearbetades 09:32:10,291, efter två andra rader i samma AISHub-kluster, och var 604,8 s gammal vid hoppet. U16-F40-STRAX-STUDS används 2 gånger, S10-VÄNDNING-BRON-BAKOM 3, KIE-PER-KORPUS 5, MÄTGRÄNS-INV10-VÄNTKEDJA 1 och STRESS-TÄTHET 54, som förut. Inga motorfel och 0 registervarningar. hunt:repro ger BORTA för kopior av s1-standard-a:s F18 och F19 (båda utslagen i minsta repro DESIGN U16-F40-STRAX-STUDS) och KVAR för R3-standard:s F20 och F21. På triagens 49 återskapade världar uppfyller fortfarande bara värld 1608 predikatet. Hänvisningskontrollen (rad 20) ändrar ingen klassning.
- **Efterrättningen R3c (rad 21–22)** (quick, seed 1, R3c-quick; standard är inte omkörd): 88 råa utslag → 34 kluster (17 kandidater), som i A.6. U16-F40-STRAX-STUDS används inte i quick. Fingeravtrycket är 5e1496854e3a (A.6: 7db549d8d4e4). rapport.json skiljer sig från A.6:s quick, utom tidsblocket, bara i postens klass i listan över oanvända poster och i fingeravtrycket. Självtestet är grönt med samma tal som förut. Granskarens ce-b och ce-b590 ger KANDIDAT i enhetsform, och sonden l2extra ger 0 avvikelser.
- **Efterrättningen D** (A/B med samma 2 000 världar, arbetskopian efter varv r0 mot efter D, `--lanes=synth --no-shrink`): inget av de 400 råa syntetiska utslagen byter registerutfall eller försvinner, och inga tillkommer. T10:s en-till-en-koppling ger ingen ny dubblett (världarnas enda FANTOMPASSAGE, värld 254, ligger utanför fönstret och får `dubblett: false`), och inget syntetiskt INV-10-utslag har strax vid båda målbroarna. I standardkörningen med krympning (bilaga A.3) är klustren och korten desamma som efter varv r0. Det som skiljer är texter och belägg: KIE-PER-KORPUS:s skäl för 42h-flashen ("≤ \|δ\| 7 s + längd 56 s + en tick 30 s"), syskonen på bankens två nya fatala variantutslag, FANTOMPASSAGE-kortets rubrik och sammanfattningens R0-rad ("1 stressfynd med R1-radio reproducerar med R0 (stannar under Stress)" i stället för "1 R1-fynd").
- **Registret 2026-11-07 (rad 23–31)** (standardkörningen, seed 1, på e088a51 med familjerna K, K2, M, E, R1 och R2 integrerade; samma motor och samma 2 000 världar med det gamla registret som baslinje): 297 råa utslag i båda. Klustren blir 49 (43 före) och kandidatklustren 10 (16 före), varav 9 i sanningsspåret (R0 3, R1 3, stress 3) och 1 i banken; fingeravtrycket är c1c21879fe6c (757ad62a19ed före). Registerutfallen som byts: T3 VARNING-EFTER-SANN-PASSAGE 49 KANDIDAT → U17 40, K-TYST-BÅT-NÄSTA-ÖPPNING 6, U18 1 och KANDIDAT 2 (625:s andra båt utan absorption, 941 hörd efter korsningen); T3 VARNING-PÅ-FRUSET-FIX 12 KANDIDAT → U17 11 och KANDIDAT 1 (972, en annan båts varning); T2 ÖPPNING-MISS:OKLASSAD KANDIDAT → U18 7, U2-RETURRESA → U18 1 (1317) och → KANDIDAT 2 (1208, 1316); T2 LEDTID KANDIDAT → U18 3 och K-NÄSTA 2, J13 → O1 5 och → KANDIDAT 1 (936), U2-VS-DEADLINE → O1 1 och → J13 1; INV-14 DEFAULT-FLASH 15 KANDIDAT → U1-C11 15; INV-13 2 KANDIDAT → R2-MÅLBRO-EFTER-LINJEN 2; T9 FEL-RIKTNING 1 och T3 FANTOM-UTAN-AVBROTT 1 → U19. Korten som står kvar: tre INV-3-kluster och bankens INV-3 (E2:s ETA-väg, ej integrerad), T2 LEDTID under 60 s (R0-kortet, världarna 263, 290, 313, 936, 979, 1139 och 1918), T2 OKLASSAD i R1 (510, 625, 756, 977, 1094, 1208, 1316, 1476 och 1913) och i stress (1794), T3 VARNING-EFTER-SANN-PASSAGE (625, 941) och T3 VARNING-PÅ-FRUSET-FIX (972). Oanvända av de nya posterna: M-BRUSBAND-RÖRELSEBEVIS, TVÅ-ÅTERKORSADE-BROAR-I-SAMMA-SEGMENT och U-SVÄNG-LÅNGSAM-ÅTERKORSNING (väntat; jest prövar dem).

## 8. Klustring, krympning och bekräftelse

**Klustring** (`lib/cluster.js`). Identiteten är registerutfall + mekanism: `registerklass | post | orakel | normaliserad klass`. Sanningsspårets fynd får dessutom `| synt`, och fynd ur världar med uppmätt stresstäthet (nivå stress, 4.4) får `| synt | stress`. Klassen normaliseras så att ISO-tid blir T, mmsi blir M och övriga tal blir N, men INV-id:t behålls. Bro, riktning, era, radioprofil, familj, korpus, δ och taggar är metadata och visas som fördelningar på kortet. Räknarfynd klustras inte; de summeras i täckningsrutan.

**Stressfynd bildar egna kluster.** Ett stresskluster har nivån stress och nivåvikten 0,3 och redovisas i rapportens sektion Stress (§9). Stressvärldar räknas aldrig som oberoende enheter i ett R0- eller R1-kluster. Rättat 2026-11-04 (M10). Förut saknade nyckeln nivån, och klustrets nivå blev R0 eller R1 så fort ett enda fynd hade den nivån. I första standardrapporten låg därför tio stressfynd i åtta R0- och R1-kort, och sammanfattningen sade "stress 0".

**Representanter.** Upp till en (quick), två (standard) eller tre (natt) per kluster. Motorn väljer helst R0-världar, helst olika broar och den minsta världen först (färst båtar × timmar).

**Tvillingkort slås inte ihop.** Identiteten ovan är avsiktlig: en apphändelse som fäller två orakel ger två kluster, och samma mekanism i stressvärldar ger ett eget stresskluster. Rapporten länkar i stället korten (§9). Relationerna är rena funktioner i `lib/cluster.js`:
- `utanStress` ger nyckeln utan `|stress`, alltså stresstvillingens nyckel.
- `reproIdentitet` ger det minsta reprots identitet, radhash och monitoringläge, för en krympt representant.
- `utslagsfönster` och `sammaUtslag` avgör om två fynd är samma utslag sett från två orakel.

Tillagt 2026-11-04 (runda 2, E8).

**Krympning på specnivå** (`lib/shrink.js`, fas 4 i `lib/lanes/synth.js`). Profilens topp-N kandidatkluster ur sanningsspåret (quick 5, standard 25, natt 40) och upp till två konfliktkluster krymps; representanterna krymps parallellt i poolen. Världen simuleras om ur den förenklade specen i varje prov, så sanningen följer med. Predikatet kräver samma mekanism, samma bro om utslaget har en, att minst ett av fyndets mmsi är inblandat och samma registerutfall (krympningen får inte glida över i en känd förklaring).

Stegen:
- **A.** Ta bort ctrl-händelser (alla på en gång, annars parvis disconnect/reconnect).
- **B0.** Tidsfokus: släng båtar utan aktivitet i [t − 45 min; t + 15 min].
- **B1.** Pröva med bara den skyldiga båten.
- **B2.** ddmin över båtarna (granularitet 2 → n, den skyldiga skyddad; utslag utan mmsi får ddmin utan skyddad båt).
- **C.** Förenkla varje båt: ta bort planelement, inget sidledsbrus och — för R1 — fast 60 s-kadens, inget brus, klass B till A, inget namnglapp och AISHub mot aisstream.
- **D.** Korta världen: kajliggarna slutar 15 min efter utslaget (transitbåtarnas banor kortas inte i v1).
- **E.** Gränssök nyckelparametern med högst 7 prov per parameter och högst 4 parametrar: familjens nyckelparameter, den skyldiga båtens egen plan (kö, kryp, U-sväng) oavsett familj, och när inget av det finns avståndet i tid till den båt som korsar samma bro (KONVOJPAR). Sökningen vidgar steget från utgångsvärdet tills utslaget försvinner och halverar sedan; gränsen anges i ett mått ur L0 när det finns (för konvojer B − A vid bron). Närmaste konstant inom 15 % ur `lib/constants.js` antecknas, familjens närliggande konstanter först.

Proven cachas på innehållshash (radioprofil, radhash, monitoring). Taket är 60 prov eller 90 s **modellerad** körtid per representant; därefter märks fyndet "delvis krympt". Nödbromsen `--max-minutes` kan också bromsa budgeten. Då står det "delvis krympt (nödbromsen (--max-minutes))", repron beror på väggklockan och rapporten märks AVKORTAD (§3). Sammanfattningen räknar delvis krympta representanter för sig.

Bankfynd krymps inte i v1. Receptet och utdraget ur bas och variant (tidslinje med parade och oparade händelser) räcker för triage. Sträckmål S6 lägger till krympning över fartyg och tidsfönster.

**Bekräftelse** av varje minsta repro (`lib/confirm.js`):
1. Dubbelkörning ska vara byte-identisk bortsett från `heapUsedMB` (och provfilens namn), och en ny simulering ur den sparade specen ska ge samma radhash. Annars INSTRUMENTFEL.
2. Hela världen flyttad +30 s ska ge identiskt utfall efter t − 30 s (hela resultatet). Annars INSTRUMENTFEL.
3. Hela världen flyttad +7 s: om fyndet försvinner taggas det KNIVSEGG men visas ändå.
4. Ett R1-fynd körs med R0 på samma spec. Reproducerar det, flyttas kortet till logikfel (taggen R0-BEKRÄFTAD). Ett stresskluster stannar under Stress även när dess representant (R1-radio) reproducerar med R0. Sammanfattningen och `täckning.krympning` räknar det för sig: "N stressfynd med R1-radio reproducerar med R0 (stannar under Stress)" och `r0BekräftadeStress`. Rättat 2026-11-04 (efterrättning D): förut räknades det som ett R1-fynd, och raden "1 R1-fynd reproducerar med R0" avsåg ett stresskort.
5. Sträckmål S8 (tre nya radiodragningar, monitoring av och på) är **inte byggt**.

Ett kluster vars alla representanter fäller steg 1 eller 2 flyttas till avsnittet Instrumentfel. Poängen räknas om efter bekräftelsen.

## 9. Rapporten

Motorn skriver (`lib/report.js`):
- `rapport.md` på svenska, för ägaren;
- `rapport.json`, maskinläsbar, med rekursivt sorterade nycklar, fingeravtryck och ett separat tidsblock `tid`. Blocket `körning` säger om rapporten är AVKORTAD (`avkortad`, och skälen per fas i `avkortning`; §3);
- `fynd/Fnn-<slug>/` per kort. Syntetiska fynd får `repro.jsonl`, `repro.spec.json`, `repro.truth.json` (L0 + L1), `repro.result.json`, `gräns.json`, `recept.json`, `tidslinje.txt`, `kommando.txt` och `fynd.json`. Bankfynd får i stället `bas.jsonl`, `variant.jsonl` (+ state), `recept.json`, `tidslinje.txt`, `kommando.txt` och `fynd.json`. Ett kalibreringskort (S-KALIBRERING) får `bas.jsonl` (+ `bas.state.json`) och ett recept med korpus och orakel, och ett kanariekort (S-KANARIE) får `repro.jsonl` och ett recept med kanariens id. Låsta bankens kort (INV-F, LEV och H1) får `bas.jsonl` (+ `bas.state.json`) och receptet `{korpus, relation: 'BAS'}`. Därmed kan `hunt:repro` döma om alla kort (§10). `repro.result.json` sparas utan `leakDiagnostics.heapUsedMB`: processens minnesmätvärde varierar mellan körningar och undantas redan av INV-12, H5 och M-EXAKT. Därmed är `fynd/` bitlikt mellan två körningar med samma seed (efterrättning D; körarens kontroll fann förut 6 olika filer i quick och 12 i standard).
- `fynd/Bnn-<post>/` för beslutsfrågor och konflikter med en krympt representant (de är inga kort, men ägaren behöver reprot);
- `senaste.txt` med utkatalogens namn, bara i motorns egna baskataloger `dirigent/hunt/` och `os.tmpdir()/ais-tracker-hunt/`. Med `--out` skrivs ingenting utanför utkatalogen (§3).

Ordningen i rapport.md:
1. **Huvud:** HEAD och om arbetsträdet är ändrat, Node, plattform, profil, seed, spår, underlag (korpusar, fasvarianter, världar per radioprofil och täthetsnivå, simulerade timmar och rader), väggtid och körnings-id.
2. **Hälsa:** självtest, instrumentkrav i banken, låst bank, H3-baslinje, bankkalibrering per orakel, kanarier och rundresa, R1:s realismnivå, sanningsspårets determinism (fingeravtryck), git-vakt och miljöskrubb.
3. **Sammanfattning** i tre rader (självtest, bankspår, sanningsspår). En AVKORTAD rapport får först en rad om var nödbromsen slog till, och sanningsspårets rad räknar då delvis krympta och obekräftade representanter. Sanningsspårets rad räknar R1-fynd som reproducerar med R0 (flyttade till logikfel) och stressfynd som gör det (stannar under Stress) var för sig (§8).
4. **Nya träffar på låst bank och kanarier**, om några. De står först eftersom de bygger på verklig data eller exakt känt facit.
5. **Kandidater:** först översikten "Länkade kort" (varje länkat par en gång; se Tvillinglänkar nedan), sedan logikfel (R0), bank (KNIVSEGG-taggade), robusthet (R1) och stress. Sektionen Stress har sanningsspårets egna stresskluster (§8). I avsnitt 6–8 märks ett registerklassat stresskluster "stress" respektive "(stress)", eftersom samma post då kan stå två gånger.
6. **Beslutsfrågor och konflikter:** en post per mekanism, med båda doktrinerna, frågan och (om krympt) exemplet.
7. **Kända utfall:** antal per registerpost och mekanism, samt oanvända poster.
8. **Instrumentfel och mätgränser.**
9. **Täckning:** orakel × radioprofil och familj × radioprofil (prövat, utslag, tyst), självtestets och bankspårets rader, räknarna och det v1 inte prövar. Hela matrisen familj × orakel × profil står i rapport.json.

rapport.md har högst 25 kort; resten finns i rapport.json. Korten sorteras på

    poäng = allvar × nivåvikt × (1 + log2(oberoende världar eller korpusar)) × 0,8 vid KNIVSEGG

där nivåvikten är 1,0 för R0 och bank, 0,6 för R1 och 0,3 för stress. Lika poäng ordnas på klusternyckeln.

**Tvillinglänkar** (`kortlänkar` i `lib/report.js`; relationerna i `lib/cluster.js`, §8). Korten slås inte ihop. Två kort som bär samma apphändelse i två orakel, eller samma mekanism på två täthetsnivåer, länkas i stället åt båda hållen. Det finns tre slags länkar:
- **"Samma minsta repro som Fxx (troligen samma apphändelse)".** En representant i vartdera kortet har samma minsta repro: samma radhash (sha256 över raderna i repro.jsonl) och samma monitoringläge, alltså samma replaykommando. Bara krympta representanter räknas, eftersom en okrympt representant bär hela världens radhash. Texten anger vilka representanter som delar repro, till exempel "r2 = F13:s r2 (värld 1731)". r1 är kortets egen katalog och rN underkatalogen rN/.
- **"Samma utslag som Fxx i N världar (troligen samma apphändelse där)".** Klustren delar ett utslag: samma värld eller korpus, samma bro och samma fartyg med överlappande utslagsfönster. Ett utslag utan fartyg, som ett INV-3-textutslag, möter bara andra utslag utan fartyg. Fönstret spänner över fyndets tid och det händelsepar som oraklet jämför, när belägget har det: korsningen, varningen, den sanna passagen, notisen, den registrerade passagen och T1:s besök. Det täcker också hela episoden för ETA-SÅGTAND UPP och ETA-OSCILLATION (tiden är episodens slut), för DEFAULT-FLASH (tiden är starten) och för STRAX-ZOMBIE:s väntan. Kontextfält som senasteFix, fixFöre och fixEfter ingår inte, och överlappet prövas utan tolerans. Länken prövar alla utslag i klustren, inte bara representanterna. Listan visar högst fyra underlag, först de där en representant ingår, till exempel "1907 (r1 här)" eller "353 (F10:s r1)", och "(+N)" för resten; hela listan står i rapport.json. Länken visas bara när den tillför något utöver samma minsta repro.
- **"Stresstvilling till Fxx (samma mekanism)".** Klusternycklarna är lika utan `|stress`. Om tvillingen ligger utanför de 25 korten står klustrets mekanism i stället för ett kort-id.

Länkarna syns på tre ställen. På kortet står de i raden "Länkar:" mellan registerraden och nästa steg. Överst i avsnittet Kandidater står översikten "Länkade kort". I rapport.json har varje kluster fältet `länkar`, som är tomt för kluster utan kort. Där har varje länk:
- typen (`samma-repro`, `samma-utslag` eller `stresstvilling`);
- det andra kortets id och klusternyckel;
- texten och belägget: representantparen och radhashen, underlagen med representanterna, eller tvillingens mekanism och nivå.

Länkarna härleds bara ur klustren och representanterna, så de är lika deterministiska som korten. Länkade kort triageras tillsammans. En länk säger dock inte att korten har samma rotorsak: stresstvillingar har samma mekanism, men triagen kan ge olika rotorsaker.

Gränser: samma minsta repro och samma utslag prövas bara mellan korten, inte mot kluster utanför de 25 korten eller mot kluster med registerpost. Ett textutslag utan fartyg (INV-3, INV-14, INV-10) länkas inte till ett fartygsutslag ens när tiderna överlappar, eftersom textklausulen gäller bron och inte en viss båt.

Länkraderna på kortet F10 i standardkörningen efter runda 2 (seed 1):

```
Länkar:       Samma utslag som F01 i 3 världar (troligen samma apphändelse där): 353 (r1 här), 1731 (r2 här), 188.
              Samma minsta repro som F13 (troligen samma apphändelse): r2 = F13:s r2 (värld 1731).
```

Tillagt 2026-11-04 (runda 2, E8). Triagen av runda 1:s standardrapport (23 kort; numreringen nedan) hittade två slags par som saknade länk:
- samma apphändelse i två orakel: F12↔F16 i värld 254, med samma minsta repro på 17 rader, och F18↔F19 (INV-3 OSCILLATION och SÅGTAND UPP), med byte-identiska repro.jsonl;
- stresstvillingar: F20↔F03, F23↔F11, F22↔F02, F21↔F13 och F17↔F01.

Regeln "samma representantvärld och överlappande utslagstid" prövades på samma rapport. Mellan representanter gav den fyra delade utslag i tre kortpar (F10↔F13, F12↔F16 och F18↔F19), och alla tre paren har redan samma minsta repro. Det enda nya var F18:s och F19:s r2 i värld 1907. Där överlappar episoderna, men reproten skiljer sig, eftersom krympningen behöll olika båtar. Över alla utslag i klustren gav regeln fem par till:
- F01↔F03 i 14 världar: varningen kom efter den sanna korsningen, så T2 saknar en varning före och T3 ser varningen efter;
- F01↔F10 i 3 världar och F01↔F13 i 1 värld: samma obokförda korsning;
- F03↔F11 och F20↔F23 i 1 värld vardera: samma varning, för F20↔F23 Stridsbergsbron#34 i värld 1907.

Triagen hade funnit tre av sambanden för hand: samma varning i F20:s och F23:s kluster, att F13:s r2 är F10:s mekanism och att U-svängsreturerna i F01 delar F10:s rotorsak. Varje delat utslag var samma apphändelse: samma korsning eller samma varning, kontrollerat utslag för utslag.

Standardkörningen efter runda 2 (seed 1, 22 kort; E6 tog bort förra F21, så F22 och F23 heter nu F21 och F22) gav 14 länkade par. Alla triagens par utom F21↔F13, vars stresskort är borta, är länkade:
- samma minsta repro: F12↔F16, F18↔F19 och F10↔F13 (r2 i värld 1731);
- samma utslag: F01↔F03 (14 världar), F01↔F10 (3), F18↔F19 (2), F01↔F13, F03↔F11 och F20↔F22 (1 vardera);
- stresstvillingar: F01↔F17, F02↔F21, F03↔F20, F11↔F22, F04↔F19 och F06↔F18.

rapport.json är i övrigt oförändrad: utan `länkar`, fingeravtrycket och tidsblocket är den lika med samma motor utan länkarna.

Ett kort ur acceptanskörningen (quick, seed 1; förkortat; konvojfönstrets bakkant, ogranskad kandidat):

```
### F01 · KANDIDAT · R0 · allvar 5 — Öppningsvarning med för kort ledtid före sann passage vid Stridsbergsbron
Orakel:       T2 LEDTID<60s — öppningsvarning före sann passage — …
Förekomst:    8 världar (F-KONVOJ 5, …); radio R1 5, R0 3; Stridsbergsbron 8; söderut 6, norrut 2.
Minsta repro: 2 båtar söderut, klass A, 268 rader, 77 min (R0).
              node tests/replay-validation/replayRunner.js <fynd>/repro.jsonl
              npm run hunt:repro -- <fynd>
Sanning och app (minsta repro; urval vid fyndets bro, allt i tidslinje.txt):
  13:53:15  L0     265591652 GUNHILD korsar Stridsbergsbron söderut (4,0 kn)
  14:03:35  app    varning Stridsbergsbron#3 söderut ledare 265591718 MASEN (deadline) [265591718]
  14:04:30  L0     265591718 MASEN korsar Stridsbergsbron söderut (4,2 kn)
Utslag:       varning Stridsbergsbron#3 14:03:35 (fired) bara 55 s före sann korsning 14:04:30
Gräns:        fel när B − A vid Stridsbergsbron ∈ 657–675 s; borta vid 638 och 693 s. Närmaste konstant: CONVOY_WINDOW_MS = 600 s.
Bekräftelse:  deterministisk · +30 s identisk · +7 s kvar · R0 (ursprung)
Register:     ingen post matchar. Närmast U2-VS-DEADLINE (etapp7-plan C-IV): predikatet falskt: korsningen 14:04:30
              ligger 675 s efter händelsens (Stridsbergsbron#1) första passage 13:53:15, utanför +600 s.
Nästa steg:   triage — läs reprot och avgör om det är en bugg eller ett beslut (§15).
```

## 10. Kommandon och profiler

```
npm run hunt                            # standard
npm run hunt:quick                      # snabb
npm run hunt:night                      # natt
npm run hunt:selftest                   # bara fas 0
npm run hunt:repro -- <fynd-katalog>    # kör om ett sparat fynd mot aktuell HEAD (KVAR/BORTA eller KAN INTE DÖMAS)
npm run hunt -- --seed=7 --worlds=500 --corpus=20260806-42h,20260710-13h
```

| Flagga | Betydelse |
|---|---|
| `--profile=quick\|standard\|night` | välj profil |
| `--worlds=N` | budget i antal världar |
| `--seed=S` | bas-seed |
| `--corpus=id,…` | delmängd för bankspåret; självtestet märks då ”delmängd” och instrumentkraven blir varningar |
| `--lanes=selftest,bank,synth` | vilka spår som körs (utan självtestet kör sanningsspåret själv basen och S-KALIBRERING) |
| `--families=F-KÖ,…` | vilka familjer som genereras (F-OMSTART ger exit 1: sträckmål) |
| `--radio=R0,R1` | vilka radioprofiler som används (R2 ger exit 1: v1.1) |
| `--jobs=N` | parallellitet, standard min(4, antal CPU) |
| `--out=KATALOG` | utkatalog. Ingenting skrivs utanför den, och en icke-tom katalog godtas bara när den innehåller en tidigare motorkörning. Loggfiler (`*.log`) får ligga där och lämnas orörda, så `… --out=X 2>&1 \| tee X/hunt.log` fungerar (§3). |
| `--max-minutes=M` | nödbroms i fas 1, 2 och 4; rapporten märks AVKORTAD (§3) |
| `--no-shrink` | hoppa över krympningen och bekräftelsen (korten får tidslinjer ur de sparade världarna) |
| `--keep-temp` | behåll tempfilerna |
| `--ignore-selftest`, `--plant=skip-state-shift\|skip-state-relabel` | utvecklarflaggor för att felsöka och mutationspröva motorn |

| Profil | Världar (≈ 30 % R0, 70 % R1) | δ i M-FAS | Representanter | Uppmätt tid på 4 CPU |
|---|---|---|---|---|
| quick | 300 | +7 och −11,52 s | topp 5 kluster × 1 | 1 min 20 s |
| standard | 2 000 | ±2,5, ±7, −11,52, +15, −20 s | ≤ 25 kluster × 2 | 4 min 55 s |
| night | 20 000 | 13 värden, även med REPLAY_MONITORING=1 | ≤ 40 kluster × 3 | uppskattat 40–60 min (inte körd i acceptansen) |

R0-andelen dras per värld ur (bas-seed, ’profil-i’), så den är cirka 30 % och inte exakt; rapportens huvud visar utfallet.

**hunt:repro** kör om ett sparat kort mot aktuell HEAD. Kortet döms med samma domare som skapade det, och domaren väljs efter `recept.json` och mekanismens orakel:

| Kort | Domare |
|---|---|
| sanningsspåret (`recept.spår` = synth) | världen byggs om ur `repro.spec.json` och döms med alla orakel; målet ska ha samma mekanism, bro, båt och registerutfall |
| bankspåret (relation M-FAS) | bas och variant körs om och jämförs, och varje utslag klassas med registret. KVAR betyder att mekanismen fortfarande ger ett utslag med kortets registerutfall (klass och post ur nyckeln i `fynd.json`, i praktiken KANDIDAT). Övriga utslag av mekanismen räknas och listas som information per klass och post. Saknar `fynd.json` både nyckel och sparade fynd blir svaret KAN INTE DÖMAS. Rättat 2026-11-04 i runda 2 (E4, §5.2): förut gav varje utslag av mekanismen KVAR, även ett som registret godtar. |
| S-KALIBRERING | `bas.jsonl` körs om och döms med T1/T10 mot banksanningen och registret, samma domare som i självtestet. KVAR betyder att mekanismen fortfarande ger en oregistrerad träff (KANDIDAT) på korpusen; det var en sådan som gav kortet. Registrerade träffar av samma mekanism räknas och visas som information men håller inte kortet kvar. Varje utslag listas med sin registerklass. Rättat 2026-11-04 (efterrättning D): förut gav även registrerade träffar KVAR, så ett kalibreringskort kunde aldrig bli BORTA på en korpus som 42h, där alla åtta NOTIS-UTEBLIVEN är registrerade. |
| S-KANARIE | kanarien byggs om ur `canaries/kanarier.json` och prövas med kanariekontrollen |
| H1–H3 (låst bank, relation BAS eller inget recept) | hälsooraklen på kortets jsonl (låst bank: `bas.jsonl`). H3 döms absolut: signaturen ska inte förekomma alls. |
| INV-F, INV-W, LEV (låst bank) | harnessens domare på kortets `bas.jsonl`, utan korpusens knownInvariantExceptions |

Svaret är KVAR eller BORTA, med exit 0. Finns ingen domare för kortets relation och orakel, saknas jsonl, eller kan körningen inte döma (körfel eller blind kanarie), blir svaret KAN INTE DÖMAS med exit 2, aldrig BORTA. Rättat 2026-11-04 (M11). Förut gick allt utom sanningsspåret och M-FAS till harnessens domare, som svarade BORTA för T1-, T10-, kanarie- och hälsokort de aldrig kunde döma.

## 11. Fas 0 stoppar körningen när

- git-vakten eller kontrollen av utkatalogen fallerar;
- banken inte är byte-identisk mellan två körningar;
- M-EXAKT bryts;
- ett instrumentkrav fallerar, det vill säga en kanarie bryter ett instrumentkrav eller en banktotal är 0 (INSTRUMENT BLINT);
- rundresan spec → rader inte ger bitlikt resultat.

Kanariernas produktförväntningar och nya träffar i bankkalibreringen stoppar inte körningen. De blir de första korten i rapporten, och ett okalibrerat orakels syntetiska utslag blir räknare i körningen. `--ignore-selftest` låter jakten fortsätta efter ett stopp (rapporten märks).

## 12. Vad v1 inte prövar och inte bygger

Följande prövas inte i v1. Rapportens täckningsruta listar dem varje gång.
- Transportlagret: AISStreamClient, AISHubClient och muxens källhälsa.
- Inställningsändringar under körning.
- Klocksteg.
- Krasch utan flush.
- Plattformsfel i kort, token och enheter.
- Fusion av två källor.
- P8/L6, som inte går att mäta i standardreplay.
- ETA-noggrannhet per båt (T7), spöktext per båt (T5) och utgånget ETA-löfte (T8).
- Artefakter från den synkrona ticken (tickAsync).

Sträckmål som **inte är byggda** i v1:

| Mål | Innehåll | Läge |
|---|---|---|
| S1 | T11 och F-OMSTART | ej byggt; registrets OMSTART-poster är därför oanvända |
| S2 | M-ISO | ej byggt |
| S3 | T6 liveness | ej byggt |
| S4 | textepisoder i M-FAS | ej byggt; brotextens formulering jämförs inte i M-FAS |
| S5 | reprobank (ny, kvar, borta mellan körningar) | delvis: `hunt:repro` kör om ett enskilt fynd och svarar KVAR/BORTA, eller KAN INTE DÖMAS (exit 2) när motorn saknar domare för kortet eller inte kan köra det (§10) |
| S6 | krympning av bankfynd | ej byggt |
| S7 | realismtabell | mäts och redovisas i varje självtest; ingen grind, inga mått per era för korsningarna |
| S8 | radiodragningar och monitoring i bekräftelsen | ej byggt |
| S9 | NAME och QR | ej byggt |
| S10 | de 46 kurerade scenarierna genom sanningsoraklen | ej byggt (kräver krok i runSyntheticScenarios.js) |

Vägen vidare:
- **v1.1** kräver inga ändringar utanför bugHunt/: renderingssonden via `--require measureEtaAccuracy.js` med `ETA_MEASURE_CAPTURE=1` (T5, T7, T8); skarvning av verkliga donatorresor; informationsreducerande bankfamiljer med differentiellt T1D-orakel; kalibrerad radio med inflygningsprofil och mottagningshål; R2; versionsdiff mot en baslinjerevision (läs-endast via `git archive`) och bisect; semantisk tillståndstäckning; bandit för familjevalet.
- **v2** kräver ägarbeslut, eftersom det rör replayRunner: runReplay-API med require.main-vakt och en varm processpool (cirka 2,3× snabbare); tickAsync-läge; felinjektion i kontroll- och plattformslagret.

## 13. Risker och motåtgärder

| Risk | Motåtgärd |
|---|---|
| Modellfel ger ”buggar” som ingen verklig båt framkallar | R1 räknas som robusthet tills realismgrinden är grön; R0-motsvarighet i bekräftelsen; stresstäthet redovisas separat |
| Självuppfyllande eller felkalibrerade orakel | L1/L0-regeln; bankkalibrering i varje självtest; produktens konstanter och harnessens domare i stället för kopior; jest med planterade defekter åt båda hållen |
| Beslutsenliga utfall ser röda ut | registret med källa och datum; KONFLIKT som egen klass; oanvända poster redovisas |
| Tystnade wrappers gör orakel vakuösa | instrumentkrav i kanarierna och banktotalerna; körningen stoppas |
| Determinismen går förlorad | budget i antal världar och modellerad krympkostnad; frysta specer; insamling i indexordning; dubbelkörning och rundresa |
| Häng | schemavalidering; tidsgräns i föräldern; omkörning |
| Ägarens uppmärksamhet räcker inte | mekanismkluster; högst 25 kort; R0 och bank först; WARN bara som räknare |
| Motorn skriver i repot | git-vakt; git-ignorerad utkatalog; aldrig REGEN_*; tempfiler utanför repot |

## 14. Acceptans för v1

Kriterierna, utfallet i byggets acceptanskörning (bilaga A.2) och utfallet i kontrollkörningen efter rättningsrundan (bilaga A.3). Utfallen efter runda 2, runda 3 och efterrättningen R3b står under tabellen (bilaga A.4–A.6). Inget kriterium byggde på ett av rundornas motorfel.

| Kriterium | Acceptanskörningen (A.2) | Efter rättningsrundan (A.3) |
|---|---|---|
| `npm test` grönt; buggjägarens jest-filer under 5 s och utan öppna handtag | **uppfyllt:** 344 sviter, 4 699 test gröna (2 överhoppade) på 84–95 s; bugHunt 10 sviter, 128 test på 2,0–2,8 s; inga öppna handtag under `--detectOpenHandles` | **uppfyllt för motorn:** bugHunt 20 sviter, 205 test på 3,5–3,7 s, inga öppna handtag. Hela repots jest kördes inte om; appen och harnessen är orörda (skyddskollen jämför arbetskopian med HEAD 7699cbe). |
| `npm run lint` rent för de nya filerna | **uppfyllt:** `npm run lint` exit 0; `eslint --max-warnings=0 tests/replay-validation/bugHunt/` exit 0 | **uppfyllt:** `eslint --max-warnings=0 tests/replay-validation/bugHunt/` exit 0 |
| `npm run hunt:selftest` grönt: determinism, SHIFT30 och MMSI 24/24, instrumentkraven uppfyllda, 0 avvikelser i rundresan | **uppfyllt** på 25 s: 24/24, 24/24, 24/24; kanarier 5/5; rundresa 45/45; 0 oregistrerade kalibreringsträffar | **uppfyllt** på 25,4–25,7 s, samma tal; 0 nya träffar på låst bank |
| `npm run hunt:quick` under 6 min och `npm run hunt` under 25 min på 4 CPU | **uppfyllt:** 1 min 20 s respektive 4 min 55 s | **uppfyllt:** 2 min 31 s (två quick parallellt) respektive 5 min 27 s |
| Två körningar med samma seed och profil ger identisk rapport.json utom tidsblocket | **uppfyllt** för quick (fingeravtryck 8a4380663210) och för standard (e625f7413ff8), seed 1, två körningar vardera | **uppfyllt** för quick (1cc9d86386ca två gånger). `fynd/` är dessutom bitlikt (155 filer), sedan `repro.result.json` sparas utan heapUsedMB (§9). Standard: 3284652ba6a7. |
| `git status --porcelain` oförändrat | **uppfyllt** i en git-klon av HEAD 7699cbe med v1:s ändringar (porcelain lika före och efter; `--out` i repot som inte är ignorerad avvisas med exit 2). Det kanoniska repot rördes inte. | inte omprövat i git-klonen; huvudträdets `git status` är tomt efter rundan (skyddskollen) |
| Rapporten återfinner konvojfönstrets bakkant (T2, R0, 2 båtar, gräns vid CONVOY_WINDOW_MS) | **uppfyllt:** standardens F01, T2 LEDTID<60s, R0, 2 båtar, gräns B − A ∈ 627–664 s, närmaste konstant CONVOY_WINDOW_MS; "Närmast U2-VS-DEADLINE … utanför +600 s" | **uppfyllt:** standardens F02 (37 utslag; F01 är nu det växta T2 ÖPPNING-MISS:OKLASSAD-klustret, §7), samma gräns 627–664 s, samma registerrad |
| U-sväng mot INV-5 (KONFLIKT INV5-VS-BESÖKSREGEL) | **uppfyllt:** 31 världar; krympt exempel `fynd/B01-…` (1 båt) med gräns 125–308 m bortom Klaffbron, närmaste konstant besöksutfärden 350 m | **uppfyllt:** 30 världar (32 utslag) och ett eget stresskluster med 1 värld (§8, M10); samma exempel och gräns |
| U2-extravarningen i 20260710-13h och ETA-studsen i 20260708-21h, båda KNIVSEGG | **uppfyllt:** bankkorten F11 (δ −11,52 och +15 s) och F09 (δ −11,52 s) | **uppfyllt:** bankkorten F09 (13h, δ −11,52 och +15 s) och F07 (21h, δ −11,52 s) |
| 42h-flashens fasvariant som ACCEPTERAD via KIE-PER-KORPUS | **uppfyllt:** Kända utfall, δ −20, −11,52, −7, +7 och +15 s | **uppfyllt** med den snävare toleransen: samma fem δ; varianterna ligger 0 s (+7, +15) och 30 s (−7, −11,52, −20) från undantaget |
| Högst 25 kort, och varje kort har minsta repro och kommando | **uppfyllt i standard:** 18 kort; alla syntetiska kort är krympta och bekräftade (32 representanter), bankkorten har bas, variant och recept (bankfynd krymps inte i v1). I quick krymps bara topp 5 (profilen); övriga kort har hela världen som underlag och samma kommandon. | **uppfyllt:** 23 kort (R0 6, bank 3, R1 7, stress 7); 40 representanter krympta och bekräftade; alla kort har repro och recept |

**Efter runda 2 (bilaga A.4)** håller alla kriterier:
- **Jest:** hela repots jest var grönt i varv s0 (357 sviter, 4 823 test, 2 överhoppade). Motorns 23 sviter och 250 test tog 4,10–4,30 s på ledig maskin, utan öppna handtag. Efterrättningen H lägger till en svit på cirka 50 ms: 24 sviter och 257 test tog 4,2–4,8 s vid last 2 på 4 kärnor, och växelvis mot läget före efterrättningen 4,22–4,48 s mot 4,15–4,45 s. Marginalen till 5 s är liten, och under främmande last överskrids gränsen (5,8–6,3 s i varv s0).
- **Lint:** exit 0.
- **Självtest:** grönt med samma tal som i A.3; fingeravtrycket 393a4609ced1 är detsamma i varv s0 och efter efterrättningen H.
- **Tider:** quick tog 1 min 55 s och standard 11 min 4 s respektive 16 min 58 s under tung främmande last, alltså inom 6 och 25 min.
- **Determinism:** quick df2a702991a1 och standard 19804855dcf4, två gånger vardera.
- **Konvojfönstrets bakkant:** F02, 37 utslag, gräns 627–664 s, samma registerrad.
- **INV5-VS-BESÖKSREGEL:** 30 världar (32 utslag) och ett stresskluster.
- **Bankkorten:** F09 (13h, δ −11,52 och +15 s) och F07 (21h, δ −11,52 s).
- **42h-flashen:** ACCEPTERAD vid alla fem δ.
- **Korten:** 22 (R0 6, bank 3, R1 7, stress 6), alla med repro och recept.
- **Git:** huvudträdets `git status` är tomt (skyddskollen).

**Efter runda 3 (bilaga A.5)** håller kriterierna:
- **Jest:** motorns 25 sviter och 282 test är gröna, utan öppna handtag. Vid låg last efter containeromstarten (load 0,6–1,2; 280 test, före de två fallen för U16-fönstrets gränser) tog de 4,2–4,4 s, växelvis mot 4,0–4,1 s för läget efter runda 2 (24 sviter, 257 test). Det håller 5 s-kravet. Under främmande last (load 12–18) tog de 6,6–11,4 s mot 5,4–12,4 s. CPU-arbetet (user) steg från 5,3–5,7 s till 6,1–6,7 s. Den nya sviten `i-runda3.test.js` tar 0,1–0,3 s, och registrets första laddning per process tar 11–13 ms i stället för 3–4 ms (lexern i hänvisningskontrollen, §7).
- **Lint:** exit 0.
- **Självtest:** grönt med samma tal som i A.4. Fingeravtrycket 62d056c08456 skiljer sig från 393a4609ced1 bara genom registerlistan: den nya posten U16-F40-STRAX-STUDS är oanvänd i självtestet. Självtestet efter omstarten gav samma rapport utom tidsblocket.
- **Tider:** standard 6 min 44 s och 7 min 24 s under last (load upp till 17), och quick 5 min 25 s respektive 5 min 27 s, två körningar parallellt vid load upp till 21. Alltså inom 25 respektive 6 min.
- **Determinism:** quick gav b33a209c9b1c två gånger och standard d430afed337c två gånger (före och efter omstarten), med rapport.json lika utom tidsblocket och `fynd/` lika (155 respektive 335 filer) efter normalisering av utkatalogen.
- **Konvojfönstrets bakkant:** F02, oförändrat.
- **INV5-VS-BESÖKSREGEL:** B01, oförändrat.
- **Bankkorten:** F09 (13h, δ −11,52 och +15 s) och F07 (21h, δ −11,52 s), oförändrade.
- **42h-flashen:** ACCEPTERAD vid alla fem δ; KIE-PER-KORPUS används 5 gånger.
- **Korten:** 22 (R0 6, bank 3, R1 7, stress 6), alla med repro och recept. Stresskorten för INV-3 heter nu F20 och F21 och bär bara värld 1907 (§7, följder i runda 3).
- **Git:** huvudträdets `git status` är tomt.

**Efter efterrättningen R3b (bilaga A.6)** håller kriterierna:
- **Jest:** motorns 25 sviter och 294 test är gröna, utan öppna handtag. Vid load 3,6–4,9 tog de 4,3 s (4,8 s väggtid). Under främmande last (load 12–24) tog de 8,8–13,4 s, och vid load 15–16 växelvis mot läget efter runda 2 (24 sviter, 257 test) 8,8–9,9 s mot 6,6–11,9 s; CPU-arbetet (user) var 6,1–6,3 s mot 5,1–5,3 s med varm cache. Marginalen till 5 s är liten och håller bara på ledig maskin. Sviten `i-runda3.test.js` har 37 test och tar 0,6–1,1 s.
- **Lint:** exit 0.
- **Självtest:** grönt med samma tal som i A.5, och rapport.json är lika med R3-selftest utom tidsblocket (fingeravtrycket 62d056c08456).
- **Tider:** standard 6 min 36 s vid load 7–14, och quick 4 min 48 s respektive 3 min 0 s vid load 14–29. Alltså inom 25 respektive 6 min.
- **Determinism:** quick gav 7db549d8d4e4 två gånger, med rapport.json lika utom tidsblocket och `fynd/` lika (155 filer) efter normalisering av utkatalogen. Standard gav 4bd9b2366e77; mot R3-standard skiljer bara U16-postens skäl (§7, efterrättningen R3b).
- **Konvojfönstrets bakkant:** F02, oförändrat.
- **INV5-VS-BESÖKSREGEL:** B01, oförändrat.
- **Bankkorten:** F09 (13h, δ −11,52 och +15 s) och F07 (21h, δ −11,52 s), oförändrade.
- **42h-flashen:** ACCEPTERAD vid alla fem δ; KIE-PER-KORPUS används 5 gånger.
- **Korten:** 22 (R0 6, bank 3, R1 7, stress 6), alla med repro och recept, med samma nummer som i R3-standard.
- **Git:** huvudträdets `git status` är tomt.

## 15. Så triagerar du ett kort

1. Läs kortets tidslinje (sanning mot app) och gräns.
2. Kör `node tests/replay-validation/replayRunner.js <fynd>/repro.jsonl` och öppna `repro.truth.json` (bankkort: kör `bas.jsonl` och `variant.jsonl` och jämför).
3. Avgör vad det är:
   - **Bugg:** rätta separat med vanlig validering. Kör sedan `npm run hunt:repro -- <fynd>`; svaret ska bli BORTA. KAN INTE DÖMAS (exit 2) betyder att motorn saknar domare för kortet eller inte kunde köra det (§10), inte att felet är borta.
   - **Avsett beteende:** skriv beslutet i docs/ och lägg till en registerpost som pekar dit.
   - **Motorfel:** rätta motorn, aldrig registret.
4. Ett KNIVSEGG-kort utreds som vilket fynd som helst. Taggen säger bara att utfallet beror på klockfasen.
5. Ett R1-kort utan R0-BEKRÄFTAD är robusthet: radion är okalibrerad, så det kan bero på modellen. Pröva R0-motsvarigheten i `repro.spec.json` innan det prioriteras.

## 16. Avvikelser från designen och kända begränsningar

Avvikelserna är medvetna och mätta i bygget:
- **M-FAS i quick ger 44 av 48 rena varianter, inte 45.** 42h-flashens fasvariant syns vid båda δ (56 s vid +7 och 60 s vid −11,52); designens 45/48 räknade sannolikt mekanismer. Tre kluster, som designen förväntar.
- **Fatala invarianter i bankvarianter jämförs med instansnyckel** (ISO → T, mmsi → M, talen kvar), inte med den helt normaliserade signaturen. Med full normalisering blir 42h-flashens 30 → 56 s osynlig.
- **SHIFT30 jämför hela resultatet** efter invers tidsförskjutning. `--plant=skip-state-shift` är annars en ekvivalent mutant för appens beteende (ett 7 dygn för gammalt state ger identiska notiser och passager); planteringen upptäcks via harnessens eko av state-tiderna.
- **U16-F40-STRAX-STUDS är medvetet smal** (§7 rad 18, 19 och 21). Posten gäller bara studsen hos den båt som kan ha burit "strax", när harnessen bearbetar hennes nästa rad, och bara när ingen annan båt kunde bära det vid hoppet (villkoren i §7, Användarbeslut U16). Klassen är MÄTGRÄNS sedan efterrättningen R3c: hoppet vid båtens nästa rad uppstår för att harnessen skjuter upp appens UI-arbete till nästa dränering (`replayRunner.js:86–88` och `:512–521`); i fält hade omkörningen gått vid halvminuten. Användarbeslutet U16 om beteendet står kvar som källa. Tick-varianten (hoppet vid en annan textgenerering när åldern passerat 600 s, återgången med båtens nästa fix sekunder eller minuter senare), ETA-hoppet vid 600 s utan "strax" före hoppet, B4-varianten (90 s-taket på uttömt "strax", positionen yngre än 600 s), också när hoppet kommer vid en annan, tyst båts rad, och en studs med bäraren i en kajkapsel är kvar som KANDIDAT. Kraven på bäraren är radobserverbara approximationer och avsiktligt smala: en båt vars förra fix ligger 300–350 m från bron räknas bara som möjlig bärare efter en fix inom 270 m (väntläget), inte efter en fix 270–300 m (imminent-hysteresen), och en annan båts kurs mot bron prövas med en plan bäring och kursen på hennes senaste rad, utan framförd kurs; en sådan båt utan kurs räknas bara inom 350 m. Ägarbeslutet U16 täcker studsen så som triagens beslutsfråga 3 (a) beskrev den (hoppet vid åldersgränsen eller 90 s-taket, återgången med samma båts nästa fix), alltså även tick- och B4-varianten. Smalheten kommer från dirigentens uppdrag (studsen vid båtens nästa rad) och från att predikatet måste kunna avgöra på raderna att den gamla fixen var den som bar "strax". En bredare post kräver därför att dirigenten väljer bredden och ett radobserverbart predikat som är bundet till bäraren, och för B4 dessutom ett belägg för uttömningen, som inte syns i raderna. Det kräver inget nytt ägarbeslut.
- **U16-predikatets klocka är en modell av harnessens.** Appen räknar åldern från när positionen bearbetades (`_lastConfirmedPositionMs`, `vessel.timestamp = Date.now()`), och hoppet publiceras vid dräneringen före en rad. Predikatet räknar därför med radernas bearbetningstider (`harnessTider`, §7 Regler) i stället för radernas tider. Rättat 2026-11-04 i efterrättningen R3b (rad 19): förut räknades åldern på radernas tider, så en radålder strax över 600 s kunde vara färsk för appen (fixen bearbetades efter andra rader i samma AISHub-kluster). Modellen gäller bypass-läget som motorn kör, inte REPLAY_FUSION=1. Den antar att `_processAISMessage` inte kastar: en rad som kastar hoppar över harnessens tick, och då stämmer modellen inte för de följande raderna (processfelet syns som H1). Modellen ser inte textgenereringar i timrar mellan dräneringarna, till exempel en mikrograce som löper ut under harnessens 60 ms-tick. Ett hopp som publiceras där ligger inte på någon rads bearbetning och ger KANDIDAT. Åldersgränsen prövas bara mot belagda textgenereringar: publicerade brotexter och halvminutstickar (vakthunden kör en UI-cykel vid varje halvminut när det finns båtar). En annan båts rad genererar text bara när uppdateringen är betydande (`_updateUIIfNeeded`), och en generering som lämnade texten orörd syns inte i resultatet. Behöll appen "strax" vid en sådan rad mellan 600 s-gränsen och hoppet, bar båten det inte ensam, och då kan posten ta en studs där en annan bärare tappade "strax" just vid båtens rad. Fönstret är kortare än en halvminut, eftersom ingen tick får ligga i det; i F18 var det 4,8 s utan någon annan rad. Att räkna varje rad som generering hade fällt studsen så snart båtens rad inte var först i sitt AISHub-kluster.
- **S10-modellens framföring av kurs och fart** (§7 rad 16) antar, som Fix D-spelet i övrigt, att fartyget inte tas bort och skapas om mellan raderna. Då är det gamla fartygsobjektet borta i appen, och inget förs fram.
- **K20-FASKÄNSLIG-LEDARE** har klassRegex `^ÖPPNING` så att posten blir "närmast" för öppningsändringar; predikatet godtar bara parade kortbyten i samma AISHub-pollkluster. **STRESS-TÄTHET** är en taggpost, som också når INV-F-fynd (§7, runda 2 E7).
- **U2-VS-DEADLINE:s predikat rättades vid integrationen.** Det prövade bara den sista varningen före korsningen och räknade korsningen själv som händelsens första passage. Då förklarades konvojfönstrets bakkant bort (B:s egen sena varning är den sista, och B:s korsning blev "första passagen"). Nu prövas varje äldre händelse vid bron, och korsningen själv räknas aldrig som första passage.
- **Sanningsoraklens avvikelser från katalogen** (granskade i bygget, återgivna i bilaga B): T9 kräver minst två observerade fixar efter båtens senaste vändning, senast 30 s före anspråket; T3 räknar avbrottet från medlemmens senaste observerade fix; ny T3-klass VARNING-EFTER-SANN-PASSAGE (varning upp till 10 min efter att en medlem enligt L0 passerat bron, konvojbakkanten i fältradio där T2 inte ser korsningen); T2 LEDTID<60s och T3 VARNING-EFTER-SANN-PASSAGE prövar varningsbarheten med classifyMiss; T1 läser öppna besök ur starttillståndet och har FP8-sydgrinden.
- **T10 på banken ger 228 beslutsamma korsningar, inte prototypens 243**, eftersom katalogen kräver en fix före bron inom 600 m. Missarna är 0 i båda fallen.
- **Sanningsspårets fynd klassas direkt i världen** (registerkontexten — rader, resultat, L0 — är för stor att spara för tusentals världar); fas 3 klassar bara fynd som saknar klassning.
- **Sanningsspårets fynd klustras för sig** (`| synt` i klusternyckeln), så att ett KNIVSEGG-fynd ur banken inte hamnar i ett syntetiskt R0-kluster av samma mekanism. Stressvärldarnas fynd klustras dessutom för sig (`| synt | stress`) med nivåvikt 0,3 och en egen sektion (rättat 2026-11-04, M10; §8). Ett registerklassat stresskluster kan därför stå bredvid R0/R1-klustret med samma post i Beslutsfrågor och Kända utfall, märkt stress.
- **Krympningens tak räknas i modellerad körtid**, inte väggtid, för att rapporten ska vara deterministisk. Steg D kortar bara kajliggarna.
- **Kanarie K5** (konvojpar med 3 min mellanrum) får två Klaffbronvarningar: följaren fick en egen deadlinevarning i stället för att absorberas. Det redovisas som information (T4 >1, U2 mot deadline, öppen fråga), inte som fel.
- **Uppmätt stresstäthet är sällsynt** trots 20 % avsedda stressvärldar, eftersom kedjor med minst 6 korsningar inom 10 min är ovanliga.
- **R1 är okalibrerad** och realismgrinden röd för båda erorna; R1-kort är robusthet tills R0-bekräftelsen säger annat.
- **`lib/platser.js` och `lib/geo.js`** har var sin farledsprojektion (registrets predikat respektive världsmodellen); båda bygger på rådatafacitets frusna centerlinje. **`lib/synthLane.js`** finns kvar som fristående drivare med egen runner (för felsökning av sanningsspåret utan ramverket); motorn kör spåret via `lib/lanes/synth.js` och poolen. Drivaren raderar sin tempkatalog efteråt om inte `--tmp` eller `--keep-temp` anges, och barnen körs med cwd i tempkatalogen (rättat 2026-11-04, M14); en relativ `--tmp` görs absolut (efterrättning D).
- **Bankspårets varianter skrivs innan de körs**: i nattprofilen upp till cirka 130 MB i tempkatalogen, som raderas efteråt.
- **AVKORTAD är försiktig.** En körning som krympt märks också när tiden tar slut under fas 4, även om ingen representant hann påverkas. Märkningen säger då "tiden var slut efter fasen" (§3).
- **hunt:repro för S-KALIBRERING svarar på oregistrerade träffar.** Svaret är KVAR bara när mekanismen fortfarande ger en oregistrerad träff på korpusen; registrerade träffar listas som information. Granskningens konstruerade kort S01 på 42h, där alla 8 NOTIS-UTEBLIVEN är registrerade (D3-2H-DEDUP 4, BESÖKSREGEL-2026-09-07 2, BN1-BOXKANT 1, KANALINFARTEN-FP8-SYDGRIND 1), ger därför BORTA (efterrättning D; i varv r0 KVAR). Sedan runda 2 (E4) gäller samma princip för M-FAS-kort: KVAR bara för ett utslag med kortets registerutfall, och övriga utslag av mekanismen listas som information (§5.2, §10).
- **hunt:repro dömer H3 absolut.** Bankens H3-baslinje byggs inte om, så varje stderr-signatur i kortets körning räknas, även kända.
- **Låsta bankens träffar sparas med basens jsonl.** INV-F-, LEV- och H1-träffar får `bas.jsonl` (+ `bas.state.json`) och receptet BAS (`selftest.lockedBankRepro`), så hunt:repro dömer dem med harnessens domare respektive hälsooraklen. Rättat 2026-11-04 (efterrättning D): förut fick bara INV-F-träffarna en repro, och ett LEV- eller H1-kort svarade KAN INTE DÖMAS (exit 2).

## Bilaga A — mätningar

### A.1 Underlaget designen vilar på

| Område | Mätning |
|---|---|
| Banken | 24 korpusar, 485,06 h, 18 679 rader, 0 ctrl-rader. State finns för 20260909-80h, 20260917-7h, 20260917-16h och 20260918-7h. Kända invariantundantag: två i 20260713-41h, ett i 20260806-42h. |
| Replay | 0,1–1,6 s per körning. Banken tar 5,4–5,6 s med 4 processer och 12,9 s sekventiellt. Kostnadsmodell: 253 ms + 0,31 ms per rad + 0,6 ms per simulerad timme (R² 0,86). Utfallet är byte-identiskt sekventiellt, parallellt och i-process, bortsett från heapUsedMB. |
| Exakta relationer | ID, SHIFT30, MMSI och NAME tysta 24/24; tyst omstart 3/3 (design-mutation, exp1). |
| Isolering | 98/98 fartyg rena med konvojmedvetet medlemskap; textadditivitet 0 avvikelser av 16 288 prov. |
| Konvojbakkant (prototypen, R0, 2 båtar) | B − A = 618/648/678 s ger egen varning −6/24/54 s från korsningen. 588 s är konvojtäckt; ≥ 708 s ger 324 s ledtid. |
| U-sväng ≤ ~365 m bortom Klaffbron | 2 målbropassager men 1 notis (INV-5). Alla 13 R0-fall av INV-5 i prototypen var U-svängare. |

### A.2 v1:s acceptanskörning

Körd 2026-11-04 i en arbetskopia av HEAD 7699cbe (Node 22, Linux, 4 CPU), seed 1.

| Område | Mätning |
|---|---|
| Jest | Hela repot: 344 sviter, 4 699 test (2 överhoppade), 84–95 s, exit 0, inga öppna handtag. Buggjägaren: 10 sviter, 128 test, 2,0–2,8 s. |
| Lint | `npm run lint` exit 0; `eslint --max-warnings=0 tests/replay-validation/bugHunt/` exit 0. |
| Självtest (25 s) | determinism 24/24, SHIFT30 24/24, MMSI 24/24, kanarier 5/5 (instrument och produkt), rundresa 45/45; bankens instrumenttotaler alla > 0; låst bank 3 fatala utslag, alla täckta av knownInvariantExceptions. |
| Mutationsbevis | `--plant=skip-state-shift`: SHIFT30 20/24, exakt 20260909-80h, 20260917-7h, 20260917-16h och 20260918-7h, exit 2. `--plant=skip-state-relabel`: MMSI 23/24 (20260909-80h), exit 2. |
| S-KALIBRERING | T1: 1 098 besök, 732 bedömda, 13 utslag, alla registrerade (D3-2H-DEDUP 6, BESÖKSREGEL-2026-09-07 4, BN1-BOXKANT 2, KANALINFARTEN-FP8-SYDGRIND 1). T10: 931 app-passager, 228 beslutsamma korsningar, 0 missar, 3 utslag (MÄTGRÄNS-FACIT-SIDLED 3, RIB 218023240). |
| Kanarier | Ledtid vid Stridsbergsbron norrut 155 s (5 kn), 146 s (8 kn) och 125 s (klass B, 60 s); K5 (konvojpar) ger två Klaffbronvarningar (information). |
| Realism (R1) | aisstream: glapp i rörelse p50/p90 101/325 s mot fältets 129,5/538,3 s; AISHub 71/124 s mot 61/119 s; 1 av 4 mått inom grinden per era; grinden röd. |
| quick (1 min 20 s) | Fas 0 25 s, fas 1 11 s, fas 2 30 s, fas 4 14 s. 48 fasvarianter, 44 rena. 300 världar (R0 97, R1 203; stress 6), 895 simulerade timmar, 84 047 rader, 0 fel och 0 häng. 87 råa utslag → 30 kluster, 15 kort (R0 4, bank 2, R1 9). 7 representanter krympta och bekräftade på 104 prov. |
| standard (4 min 55 s) | Fas 0 25 s, fas 1 38 s, fas 2 190 s, fas 4 42 s. 168 fasvarianter, 158 rena. 2 000 världar (R0 635, R1 1 365; stress 23), 5 978 simulerade timmar, 545 034 rader, 0 fel och 0 häng; 10,5 världar/s med 4 jobb. 420 råa utslag (400 syntetiska) → 35 kluster: 18 kandidater (R0 8, bank 3, R1 7), 3 KONFLIKT, 4 KÄND_ÖPPEN, 3 ACCEPTERAD, 5 DESIGN, 2 MÄTGRÄNS. 32 representanter krympta och bekräftade på 541 prov; 1 R1-fynd reproducerade med R0 (flyttat till logikfel), 1 blev KNIVSEGG vid +7 s, 0 INSTRUMENTFEL. |
| Determinism | Två quick-körningar med seed 1: rapport.json byte-identisk utom tidsblocket (fingeravtryck 8a4380663210). Två standardkörningar med seed 1: identiska utom tidsblocket (fingeravtryck e625f7413ff8). Sanningsspårets fingeravtryck (rader/fynd) står i hälsorutan. |
| Git-vakt | I en git-klon av HEAD 7699cbe med v1:s ändringar: `git status --porcelain` lika före och efter `hunt:selftest`; standardutkatalogen `dirigent/hunt/<stämpel>-7699cbe-standard-s1/` är git-ignorerad och `senaste.txt` skrevs; `--out=docs/hunt-ut` avvisas med exit 2 utan att något skrivs. |
| Steg 10, prototypens konvojspec | `design-truth/proto/work-ideal/sb-3009-…/repro.spec.json` (R0): 2 båtar (redan minimal), gräns B − A vid Stridsbergsbron = 618 s för T2 ÖPPNING-MISS:OKLASSAD (borta vid 571 och 665 s, där varningen i stället blir en kort ledtid), närmaste konstant CONVOY_WINDOW_MS; +30 s identisk. |
| Steg 10, U-svängen | INV-5-fallet krympte till 1 båt (seed 7: 78 rader; standard: 181 rader) och bekräftades (+30 s identisk, R0). |
| Befintligt batteri | `node tests/replay-validation/runAllCorpora.js` och `runSyntheticScenarios.js` gröna i arbetskopian. |

**Första genomgång av standardens kort** (observationer, inga domar — korten är kandidater tills ägaren triagerat dem):
- Konvojfönstrets bakkant syns i två klasser med gräns kring CONVOY_WINDOW_MS: F01 (T2 LEDTID<60s, 627–664 s) och F03 (T3 VARNING-EFTER-SANN-PASSAGE, 587–605 s); prototypens konvojspec ger samma mekanism som T2 ÖPPNING-MISS:OKLASSAD vid 618 s. Mekanismklustringen håller isär klasserna; korten bör triageras tillsammans (öppen fråga 2 i designen). F02 (T2 ÖPPNING-MISS:OKLASSAD, R0) har i sitt minsta repro i stället ett radioavbrott med gräns 854–882 s.
- F05 (T10 PASSAGE-EJ-REGISTRERAD, R0) och F08 (T10 FANTOMPASSAGE, R1 → R0) gäller båtar som kryper under 0,5 kn förbi bron; gränserna ligger vid MOVEMENT_PROOF_SOG_KN 0,5 kn. Pröva först om T10:s observerbarhetsfönster är för snävt för krypande båtar innan appen misstänks.
- F04, F06 och F07 (ETA-SÅGTAND, ETA-OSCILLATION och DEFAULT-FLASH i R0) är fatala invarianter i idealradio; F06 och F07 har gränser vid krypfarten.
- Bankspåret: F09 och F11 är designens väntade KNIVSEGG-fynd; F10 (tappad Järnvägsbronpassage för 304225000 i 20260917-16h vid δ −7 och −2,5 s) är nytt sedan designen mätte.
- R1-korten (F12–F18) är robusthet: radion är okalibrerad, och ingen av dem reproducerade med R0.
- Nollfynd: inga nya träffar på låst bank, inga brutna kanarieförväntningar, inga instrumentfel, inga H1/H2/H3-utslag och inga LEV-utslag i något spår.

### A.3 Kontrollkörning efter rättningsrundan

Körd 2026-11-04 efter rättningsrundan (motorgranskningens M01–M14, triagens T-1–T-3) och efterrättningen D, i arbetskopian (Node 22, Linux, 4 CPU, ledig maskin utom där det anges), seed 1.

| Område | Mätning |
|---|---|
| Jest | Buggjägaren: 20 sviter, 205 test, 3,5–3,7 s, exit 0, inga öppna handtag. Rundans nya fall fäller ögonblicksbilden före rundan, och efterrättningens fall fäller också motorn efter varv r0 (utom två vakter som ska hålla i båda). |
| Lint | `eslint --max-warnings=0 tests/replay-validation/bugHunt/` exit 0. |
| Självtest (25,4–25,7 s) | determinism 24/24, SHIFT30 24/24, MMSI 24/24, kanarier 5/5, rundresa 45/45. Låst bank: 3 fatala utslag, alla täckta, 0 nya träffar. S-KALIBRERING: T1 13 utslag och T10 3 utslag, alla registrerade (T10: MÄTGRÄNS-FACIT-SIDLED 3, även med T10:s en-till-en-koppling). Ledtid vid Stridsbergsbron 155/146 s. |
| standard (5 min 27 s) | Fas 0 25,7 s, fas 1 41,7 s, fas 2 193 s, fas 4 66,6 s. 168 fasvarianter, 158 rena. 2 000 världar (R0 635, R1 1 365; stress 23), 5 978 simulerade timmar, 0 fel och 0 häng. 420 råa utslag (400 syntetiska) → 46 kluster: 23 kandidater (R0 6, bank 3, R1 7, stress 7), 4 KONFLIKT, 5 KÄND_ÖPPEN, 4 ACCEPTERAD, 7 DESIGN, 3 MÄTGRÄNS. 40 representanter krympta och bekräftade på 796 prov; inget R1-fynd reproducerade med R0, men ett stressfynd med R1-radio gjorde det (stannar under Stress, §8). 0 INSTRUMENTFEL. Fingeravtryck 3284652ba6a7. |
| quick (2 min 31 s, två körningar parallellt) | Fas 0 47 s, fas 1 22 s, fas 2 61 s, fas 4 22 s. 48 fasvarianter, 44 rena. 300 världar (R0 97, R1 203; stress 6). 88 råa utslag (69 syntetiska) → 34 kluster, 17 kort (R0 4, bank 2, R1 9, stress 2). 7 av 7 representanter på 104 prov. |
| Determinism | De två quick-körningarna: rapport.json identisk utom tidsblocket (fingeravtryck 1cc9d86386ca), och `fynd/` (155 filer) byte för byte lika när utkatalogens egen sökväg bortses från (den står bara i `kommando.txt`). |
| Jämfört med varv r0 | Standardens kluster och kort är desamma som efter varv r0 (fingeravtryck aa610e616d4c); skillnaderna är texter och belägg (§7, följder av efterrättningen D). |

### A.4 Kontrollkörning efter runda 2

Körd 2026-11-04 av köraren i varv s0, efter runda 2 (rättare E: E1–E5 och E7, rättare F: E6, rättare G: E8), i arbetskopian (Node 22, Linux, 4 CPU), seed 1. Underlaget och lastloggen är redovisade i körarens svar för varv s0. Maskinen hade tung främmande last under stora delar av körningen, bland annat en samtidig standardkörning i en annan kopia. Väggtiderna är därför övre gränser; CPU-arbetet (user) var detsamma som i runda 1. Efterrättningen H (§7 rad 15) kom efter körningen och står i sista raden.

| Område | Mätning |
|---|---|
| Jest | Hela repot: 357 sviter, 4 823 test (2 överhoppade), 125 s under last (92 s i runda 1), exit 0. Buggjägaren: 23 sviter, 250 test, 4,10–4,30 s på ledig maskin och 5,79–6,27 s under 3,0–3,8 kärnor främmande last, inga öppna handtag. Marginalen till 5 s har krympt från runda 1:s 3,5–3,7 s, eftersom tre sviter tillkommit. |
| Lint | `npm run lint` och `eslint --max-warnings=0 tests/replay-validation/bugHunt/` exit 0. |
| Självtest (49 s under last) | determinism 24/24, SHIFT30 24/24, MMSI 24/24, kanarier 5/5, rundresa 45/45. Låst bank: 3 fatala utslag, alla täckta, 0 nya träffar. S-KALIBRERING: T1 13 utslag och T10 3 utslag, alla registrerade. Fingeravtryck 393a4609ced1. |
| standard (16 min 58 s och 11 min 4 s under last) | 168 fasvarianter, 158 rena. 2 000 världar (R0 635, R1 1 365; stress 23), 5 978 simulerade timmar, 0 fel och 0 häng. 419 råa utslag (399 syntetiska) → 45 kluster: 22 kandidater (R0 6, bank 3, R1 7, stress 6), 4 KONFLIKT, 5 KÄND_ÖPPEN, 4 ACCEPTERAD, 7 DESIGN, 3 MÄTGRÄNS. 39 representanter krympta och bekräftade på 790 prov; ett stressfynd med R1-radio reproducerade med R0 och stannar under Stress (§8). 0 INSTRUMENTFEL. Fingeravtryck 19804855dcf4. |
| quick (1 min 55 s och 3 min 42 s under last) | 48 fasvarianter, 44 rena. 300 världar (R0 97, R1 203; stress 6). 88 råa utslag (69 syntetiska) → 34 kluster, 17 kort (R0 4, bank 2, R1 9, stress 2). 7 av 7 representanter krympta och bekräftade på 104 prov. Fingeravtryck df2a702991a1. |
| Determinism | Två körningar vardera: rapport.json identisk utom tidsblocket (quick df2a702991a1, standard 19804855dcf4), och `fynd/` (155 respektive 353 filer) lika. |
| Jämfört med runda 1 | 420 → 419 råa utslag och 46 → 45 kluster: stresskortet T1 FÖRVARNINGSFORM-EFTER-PASSAGE (värld 856, förut F21) försvann genom E6, så standarden har 22 kort i stället för 23. De övriga 22 klusternycklarna fanns redan efter runda 1, och hunt:repro gav KVAR på alla 22 kort och deras r2-kataloger. Rapporten länkar tvillingkort (E8, 14 par, §9), och STRESS-TÄTHET når stressvärldarnas INV-F-fynd (E7, §7). |
| Efterrättningen H | Motorns jest: 24 sviter och 257 test på 4,20–4,81 s vid last 2 (växelvis mot läget före efterrättningen: 4,22–4,48 s mot 4,15–4,45 s), inga öppna handtag; den nya sviten `h-efterratt.test.js` tar 44–57 ms. A/B av bara S10-predikatet (standardens 2 000 världar och bankens 168 fasvarianter, `--no-shrink`): rapporterna är lika utom tidsblocket (§7, följder). quick och självtestet efter H ger samma fingeravtryck som i varv s0 (df2a702991a1 och 393a4609ced1). Standard- och quick-talen ovan gäller därför också efter efterrättningen. |

### A.5 Kontrollkörning efter runda 3

Körd 2026-11-04 av rättaren i runda 3 (L1, L2 och U16, §7 rad 16–18), i arbetskopian (Node 22, Linux, 4 CPU), seed 1. Containern startades om mitt i rundan, cirka 20:40. Standard, quick och det första självtestet kördes före omstarten. Efter omstarten rättades kommentarer, U16-postens regeltext och källa samt dokumentationen, utan att något predikat ändrades, och två jest-fall lades till för U16-fönstrets gränser. Därefter kördes jest, lint, självtestet och standard om. Maskinen hade nästan hela tiden främmande last från andra agenters körningar (load 4–21), så väggtiderna under last är övre gränser.

| Område | Mätning |
|---|---|
| Jest | Buggjägaren: 25 sviter och 282 test gröna, inga öppna handtag. Växelvis mot läget efter runda 2 (24 sviter, 257 test): vid load 0,6–1,2 efter omstarten (280 test, före fönsterfallen) 4,21–4,44 s mot 3,95–4,05 s (en kall första körning av den gamla motorn tog 4,84 s), med CPU-arbetet 6,07–6,18 s mot 5,25–5,30 s. Under last: vid load 12–15 före omstarten (280 test) 6,6–11,4 s mot 5,4–12,4 s, och vid load 16–18 efter omstarten (282 test) 8,5–11,1 s mot 7,0–9,3 s, med CPU-arbetet 6,2–6,7 s mot 5,4–5,7 s. Den nya sviten `i-runda3.test.js` tar 0,1–0,3 s. |
| Lint | `eslint --max-warnings=0 tests/replay-validation/bugHunt/` exit 0, före och efter omstarten. |
| Självtest (39 s före omstarten, 41 s och 1 min 39 s efter, under last) | determinism 24/24, SHIFT30 24/24, MMSI 24/24, kanarier 5/5, rundresa 45/45. Låst bank: 3 fatala utslag, alla täckta, 0 nya träffar. S-KALIBRERING: T1 13 utslag och T10 3 utslag, alla registrerade. 0 registervarningar. Fingeravtryck 62d056c08456 i alla tre körningarna, med rapport.json lika utom tidsblocket. |
| standard (6 min 44 s och 7 min 24 s under last, user 19 min 4 s och 17 min 10 s) | 168 fasvarianter, 158 rena. 2 000 världar (R0 635, R1 1 365; stress 23). 419 råa utslag → 47 kluster: 22 kandidater (R0 6, bank 3, R1 7, stress 6) och två nya DESIGN-kluster för U16-F40-STRAX-STUDS (värld 1608). 37 representanter krympta och bekräftade på 720 prov. 0 fel, 0 häng, 0 motorfel och 0 registervarningar. Fingeravtryck d430afed337c i båda körningarna (R3-standard före omstarten, R3-standard-b efter), med rapport.json lika utom tidsblocket och `fynd/` lika (335 filer) efter normalisering av utkatalogen. |
| quick (5 min 25 s och 5 min 27 s, två parallellt under last, före omstarten) | 48 fasvarianter, 44 rena. 300 världar. 88 råa utslag → 34 kluster, 17 kort, som i A.4. U16-F40-STRAX-STUDS används inte. Fingeravtryck b33a209c9b1c i båda; mot A.4:s df2a702991a1 skiljer bara den nya posten bland INV-3-fyndens prövade poster (och därmed sanningsspårets fyndHash, som omfattar fyndens registerfält) och registerlistan. |
| Jämfört med varv s1 (s1-standard-a) | Se §7, följder i runda 3: värld 1608:s två INV-3-utslag är DESIGN, F18/F19 heter nu F20/F21 med bara värld 1907, och övriga kluster är oförändrade. hunt:repro ger KVAR (exit 0) för F20 och F21, och BORTA för s1-standard-a:s F18 och F19, där båda utslagen i minsta repro är DESIGN U16-F40-STRAX-STUDS. |

### A.6 Kontrollkörning efter efterrättningen R3b

Körd 2026-11-04 av rättaren i efterrättningen R3b (§7 rad 19–20), i arbetskopian (Node 22, Linux, 4 CPU), seed 1. Maskinen hade främmande last från andra agenters körningar (load 4–29), så väggtiderna under last är övre gränser.

| Område | Mätning |
|---|---|
| Jest | Buggjägaren: 25 sviter och 294 test gröna, inga öppna handtag. Vid load 3,6–4,9: 4,3 s (4,8 s väggtid, user 6,3 s). Växelvis mot läget efter runda 2 (24 sviter, 257 test) vid load 15–16: 8,8–9,9 s mot 6,6–11,9 s, med CPU-arbetet 6,1–6,3 s mot 5,1–8,7 s (5,1–5,3 s med varm cache). `i-runda3.test.js` (37 test) tar 0,6–1,1 s. Mot rundans första försök fäller alla sex [efterrättning]-fall, och mot F/pre3 fäller alla [rättning]-fall i `i-runda3.test.js`; [vakt]-fallen håller i alla tre. |
| Lint | `eslint --max-warnings=0 tests/replay-validation/bugHunt/` exit 0. |
| Självtest (34 s) | determinism 24/24, SHIFT30 24/24, MMSI 24/24, kanarier 5/5, rundresa 45/45. Fingeravtryck 62d056c08456, rapport.json lika med R3-selftest utom tidsblocket. |
| standard (6 min 36 s, user 17 min 7 s) | 168 fasvarianter, 158 rena. 2 000 världar (R0 635, R1 1 365; stress 23). 419 råa utslag → 47 kluster: 22 kandidater (R0 6, bank 3, R1 7, stress 6) och 25 registerkluster, bland dem värld 1608:s två DESIGN-kluster för U16-F40-STRAX-STUDS. 37 representanter krympta och bekräftade på 720 prov. 0 fel, 0 häng, 0 motorfel och 0 registervarningar. Fingeravtryck 4bd9b2366e77. Mot R3-standard (d430afed337c) skiljer bara U16-postens skäl på tolv INV-3-utslag och på de två DESIGN-utslagen, och därmed sanningsspårets fyndHash. |
| quick (4 min 48 s och 3 min 0 s) | 48 fasvarianter, 44 rena. 300 världar. 88 råa utslag → 34 kluster, 17 kort. U16-F40-STRAX-STUDS används inte. Fingeravtryck 7db549d8d4e4 i båda, rapport.json lika utom tidsblocket och `fynd/` lika (155 filer). Mot A.5:s b33a209c9b1c skiljer bara U16-skälen på två INV-3-utslag (värld 8 och 192) och därmed fyndHash. |
| Sonder genom appen | Granskarens u16e2e på F21:s minsta repro i R3-standard med en kajbåt 240 m från Klaffbron, tyst i 720 eller 605 s, och samma båt 45 m utanför kapseln (262 m): appen ger samma studs i alla tre ("om 7 minuter" 11:01:40,950, "strax" 11:01:41,035). Rundans första försök ger DESIGN i alla tre, nu KANDIDAT (en publicerad text efter 600 s-gränsen, kajkapseln respektive ULLA:s rad emellan). Granskarens enhetsfall (u16motex) ger KANDIDAT utom F18, som är DESIGN. |
| hunt:repro | Kopior av s1-standard-a:s F18 och F19: BORTA, med båda utslagen i minsta repro DESIGN U16-F40-STRAX-STUDS. R3-standard:s F20 och F21: KVAR (exit 0). |

## Bilaga B — orakelkatalog

Katalogen återges ur byggunderlaget med regler, trösklar och falsklarmsvakter. Raden **v1** säger vad som är byggt och var v1 avviker. Den uppdateras i samma commit som oraklen.

### H1 PROCESSFEL

- **Regel:** En körning räknas som processfel om något av följande gäller: (1) replayRunner svarar {fatal}; (2) processErrors > 0, vilket inkluderar GLOBAL_TOKEN_DELIVERY_MISMATCH och kast i reconnect/onUninit; (3) runtimeDiagnostics.shutdownErrors > 0; (4) timersAfterShutdown > 0; (5) något värde i timersAfterRestartShutdown > 0. Syntetiska världar döms absolut, bankvarianter differentiellt mot sin oförändrade bas.
- **Tröskel:** Syntetiska världar: > 0. Bankvarianter: > basens värde. Allvar 10; ger alltid kort efter bekräftelse.
- **Falsklarmsvakt:** Endast schemavaliderad indata körs (lib/schema.js), så harnessens kända fällor blir motorfel och aldrig fynd: ctrl-rad utan aisTimestamp, sekunder i stället för ms, ISO-sträng. Miljön skrubbas: AIS_REPLAY_CAPTURE_FILE och REGEN_DISTRIBUTIONS sätts aldrig. REPLAY_FUSION körs aldrig utan REPLAY_MONITORING=1, eftersom fusionStateSize annars ger en falsk INV-12. Fyndet dubbelkörs (H5) innan kortet skrivs.
- **v1:** byggt (`oracles/health.js`): absolut i syntetiska världar och i bankens bas, differentiellt i fasvarianter. Ett körfel utan resultat bokförs som `PROCESSFEL inget resultat`.

### H2 HÄNG

- **Regel:** Ingen __REPLAY_JSON__…__END__-markör kommer inom tidsgränsen. Föräldern dödar då barnet med SIGKILL och kör om en gång i en ny process med dubbel gräns. Två missar i rad ger fyndet HÄNG.
- **Tröskel:** Gräns = max(60 s; 20 × (0,25 s + 0,31 ms per rad + 0,6 ms per simulerad timme)). Formeln bygger på kostnadsmodellen från map-harness (R² 0,86) och ger ungefär 20 × uppmätt körtid. Allvar 10.
- **Falsklarmsvakt:** Tidsgränsen mäts i föräldern med äkta klocka, eftersom fejkklockan kapar värdens timers i barnet. Häng på indata som inte klarar schemat räknas som motorfel och redovisas i ett eget avsnitt. En enstaka timeout under hög last fäller inte; det krävs två i rad.
- **v1:** byggt (`pool.js`, `oracles/health.js`).

### H3 NY APP ERROR-SIGNATUR

- **Regel:** Varje stderr-rad som innehåller [APP ERROR], [FATAL] eller Unhandled normaliseras: ISO-tid → T, 9-siffrigt mmsi → M, övriga tal → N, och raden kapas efter 140 tecken. En signatur som saknas i baslinjen ger KANDIDAT. En känd signatur som förekommer minst 10 gånger oftare per simulerad timme än i baslinjen ger en räknarpost (OBSERVATION).
- **Tröskel:** En ny signatur med minst 1 förekomst. Baslinjen byggs i samma körning ur självtestets två bankvarv plus registerposten GPS_JUMP-DIAGNOSTIK. Banken har bara GPS_JUMP-diagnostik: 4 rader på 26 körningar. Allvar 4.
- **Falsklarmsvakt:** Baslinjen mäts om i varje körning, så miljöskillnader tar ut varandra. GLOBAL_TOKEN_TIMEOUT och suppressedTokenTimeouts dömer inte (MÄTGRÄNS-TOKEN-TIMEOUT); de är en artefakt av den synkrona 30 s-ticken enligt replayRunner A8(ii). Kanalen behövs eftersom notisvägen sväljer interna fel (VALIDATION, Svälj-fällan).
- **v1:** byggt; baslinjen byggs ur självtestets två bankvarv (utan självtest: ur ett bankvarv). GPS_JUMP-signaturerna är DESIGN via registret.

### H5 DETERMINISM (bekräftelse)

- **Regel:** Varje minsta repro körs två gånger. Resultat-JSON ska vara byte-identisk när leakDiagnostics.heapUsedMB har strukits. Syntetiska repros simuleras dessutom om ur den sparade specen, och radernas SHA-256 ska vara lika. Hela världen flyttad +30 s ska ge identiskt utfall efter tidsförskjutning.
- **Tröskel:** 0 avvikande byte. En avvikelse ger INSTRUMENTFEL, som redovisas i ett eget avsnitt och aldrig som appfynd.
- **Falsklarmsvakt:** Byte-identiteten är uppmätt för alla 24 korpusar i sekventiell, parallell och i-process-körning (map-harness). Specen djupfryses under simuleringen. Prototypens radio skrev nameUnknownMin i specen, och 23 av 40 aisstream-världar gick därför inte att återskapa. Med separat radiorealisering blev det 200/200 för både aisstream och AISHub (mätt i syntesen).
- **v1:** byggt: bankens två varv (ID-relationen) och bekräftelsens steg 1 (`confirm.js`), där även provfilens namn i `jsonl`-fältet stryks.

### INV-F FATALA INVARIANTER

- **Regel:** validateInvariants(resultat) körs på varje körning (INV-1–14 och INV-16). Signaturen är INV-id + klass (texten före första kolon) med normaliserade detaljer; bro, riktning och mmsi blir metadata. I syntetiska världar är varje utslag ett rått fynd. I bankvarianter räknas bara signaturer som förekommer fler gånger än i basen.
- **Tröskel:** Minst 1 ny signatur. Allvar 6 för INV-2/11/13, 5 för INV-5/7, 4 för INV-3/4/10/14 och 3 för övriga.
- **Falsklarmsvakt:** I bankvarianter är signaturer ACCEPTERADE (KIE-PER-KORPUS) om de gäller samma episod som ett av korpusens knownInvariantExceptions: samma klass och broar, samma fartyg när undantaget namnger ett, och en tid högst |δ| + L + en tick (30 s) från undantagets. L är undantagets egen längd för klasser vars tid är episodens slut (ETA-SÅGTAND UPP "på Ns", ETA-OSCILLATION "inom Ns"), annars 0. DEFAULT-FLASH jämförs alltså start mot start med |δ| + en tick, och utslagets egen längd vidgar aldrig fönstret (§5.2, runda 2 E3). Ett undantag förklarar högst en träff per variant, den närmaste (`belägg.syskon`). Exempel: 42h-flashen på 30 s, som blir 56–60 s i fasvarianter och vid δ −7, −11,52 och −20 s börjar en tick tidigare. På den låsta banken gäller bara runAllCorpora:s exakta prefixmatch, och en ny träff får ingen registeramnesti (§7, M03). Registret får omklassa ett fatalt utslag bara via en post som namnger INV-id:t och vars predikat är sant på just detta utslag. Sådana poster är INV5-VS-BESÖKSREGEL (KONFLIKT; VALIDATION §Invarianterna mot besöksregeln 2026-09-07), D1-KAJZON-DEMOTION (KONFLIKT; MOORING_ZONES mot reliability-spec D1), OMSTART-DEFAULT-FÖRE-FÖRSTA-FIX (KÄND_ÖPPEN), MÄTGRÄNS-INV10-VÄNTKEDJA (MÄTGRÄNS; INV-10:s granularitet, triagens T-1; inget glapp i kedjan får innehålla en halvminutstick, runda 2 E2) och U16-F40-STRAX-STUDS (MÄTGRÄNS; F40-studsen i harnessens uppskjutna UI-arbete, med beteendet enligt användarbeslut U16: INV-3 fäller ett hopp bort från strax när harnessen bearbetar den strax-bärande båtens nästa rad och en återgång till strax högst 1 s efter radens tid, efter att hennes föregående fix blivit äldre än STALE_ETA_HARD utan textgenerering sedan dess och utan någon annan båts rad inom 500 m före återgången, när båten kunde bära strax vid sin förra fix och ingen annan båt kunde bära det vid hoppet; runda 3, §7 rad 18, 19 och 21). Inga amnestier ges utan exakt predikat, och oanvända poster redovisas.
- **v1:** byggt (`oracles/existing.js`). I bankvarianter jämförs instansnycklar (talen kvar), se §16. Ett INV-10-utslag bär strax-övergången, nästa övergång och de bekräftade väntintervallen för zombiens bro (den i "utan <bro>-passage", som också är fyndets bro) i `belägg.väntan`; förut togs första bron i texten (efterrättning D, §6). Ett nytt fatalt utslag i en fasvariant bär variantens utslag av samma klass vid samma broar i `belägg.syskon` (§5.2).

### INV-W WARN-INVARIANTER

- **Regel:** validateWarnInvariants(resultat, L1-gt) körs alltid med facit explicit. Unika basnamn gör att idForJsonl ger null, så det finns ingen tyst fallback till appens egna passager.
- **Tröskel:** Informativ i v1: räknare per klass, profil och familj i täckningsrutan. Ger aldrig kort.
- **Falsklarmsvakt:** INV-17 är kalibrerad mot fältkadens och gav 111 utslag i 53 av 100 R0-världar (MÄTGRÄNS-INV17-R0). WARN-skiktet stod för de största klustren i prototypen; ETA-STIGNING fanns i 39 av 200 R1-världar. Som kort skulle det dränka kandidaterna.
- **v1:** byggt; alltid räknare (täckningsrutan).

### LEV ÖPPNINGSLEVERANS

- **Regel:** openingDeliveryFailures(resultat) fäller vid något av följande: misslyckat kortanrop; openingServiceFires skiljer sig från antalet levererade kort plus redovisade same-arrival-dubbletter; obelagd dedup; obelagd konvojtäckning.
- **Tröskel:** Syntetiska världar: minst 1 utslag. Bankvarianter: fler utslag än basen. Allvar 6.
- **Falsklarmsvakt:** eventId får en namnrymd per app-instans (i<n>:id, där n = antal ctrl:restart före t) innan någon join görs, eftersom BridgeOpeningService börjar om _eventSeq i varje ny instans. Kontraktet är oförändrat mot runOpeningGates.
- **v1:** byggt; eventId namnrymdas per instans (`instances.js`) innan joinen.

### T1 NOTIS PER OBSERVERAT BESÖK

- **Regel:** Gäller varje båt och punkt (de fem broarna och Kanalinfarten) och varje L0-besök inom 300 m där båten rör sig (max |v| ≥ 0,5 m/s). En levererad notis (success ≠ false) för nyckeln ska finnas i [tIn − 10 min; tOut + 15 min] om alla dessa villkor är uppfyllda: (1) radion levererade minst en fix ≤ 300 m från punkten, och punkten är fixens närmaste notispunkt; (2) båten har minst 2 observerade fixar före den fixen; (3) båten har rörelsebevis, det vill säga någon observerad fix med sog ≥ 1,0 kn (QUAY_DEPARTURE_GATE.TRANSIT_SOG_KN) inom [tIn − 10 min; tOut]. Formkrav: en notis i förvarningsform (alreadyPassed ≠ true) som kommer mer än 15 s efter sann L0-korsning är ett brott bara om appen före notisen fått en fix mer än 70 m bortom linjen.
- **Tröskel:** NOTIS-UTEBLIVEN och FÖRVARNINGSFORM-EFTER-PASSAGE ger KANDIDAT med allvar 5. SEN-NOTIS (notis − t_obs > 120 s, ej Kanalinfarten) ger bara en räknare. På banken ska varje träff vara registrerad. Map-oracles per-korsningsvariant gav 790 punktkorsningar → 4 råa utslag → 0 oförklarade. Besöksvarianten kalibreras om i bygget och i varje självtest.
- **Falsklarmsvakt:** BESÖKSREGEL-2026-09-07 → DESIGN: det finns en tidigare notis för nyckeln och inga två konsekutiva observerade fixar över 350 m däremellan (TriggerPointVisitTracker.js:15, ARCHITECTURE §6). BN1-BOXKANT → KÄND_ÖPPEN: utfart vid Kanalinfarten eller Stallbackabron utan två fixar över 350 m (helgranskning 2026-11-03, beslutspunkt 2). SKIPPA-BRO-ÅLDER-17MIN → DESIGN: bron korsades i ett glapp och slutsatsen är äldre än 17 min (runSyntheticScenarios.js:424). D3-2H-DEDUP → DESIGN: samma mmsi:bro och riktning inom 2 h (reliability-spec D3). S10-VÄNDNING-BRON-BAKOM → DESIGN: zonens fixar går bort från bron efter en vändning, och zonens första fix har sog ≥ FIX_D_MIN_SOG (2,0 kn) och sätter Fix D:s pending-flagga. Det gör den bara när låset fortfarande är det gamla och ingen färsk flagga finns från före zonen; predikatet spelar Fix D över fartygets fixar före zonen för att avgöra det. En rad utan kurs eller fart prövas med fartygets senast kända värde, som i appen (runda 3, §7 rad 16). Ingen senare zonfix har sog ≥ FIX_D_MIN_SOG, eftersom den bekräftar reversalen och notisen går ut. Då avstår S10-vakten (ARCHITECTURE:1928, S10 användargodkänd; triagens T-3; runda 2 E1 och efterrättningen, §7 rad 10 och 15). Tre beslut tillämpar oraklet själv, och registerposterna har verkan iOraklet: rörelsebeviset i förutsättning 3 (KAJGRIND-UTAN-RÖRELSEBEVIS), passerad form efter ett glapp (U10-BN2-PASSERAD-FORM; formkravet gäller bara förvarningsform) och 70 m-bandet (UNDER-BRO-BANDET-70M: en utgångsfix högst 70 m bortom linjen är inget formbrott). Oraklet dömer inte under ctrl:disconnect, inte när fixen före besöket är mer än 10 min gammal (STALE_ETA_HARD) och inte i Kanalinfartens zon när det gäller SEN-NOTIS, eftersom en kvardröjande båt ger falskt sen t_obs.
- **v1:** byggt (`oracles/t1Notice.js`). Läser dessutom besök som var öppna i korpusens starttillstånd och har FP8-sydgrinden vid Kanalinfarten (KANALINFARTEN-FP8-SYDGRIND). Bankkalibrering i acceptanskörningen: se bilaga A.
- **Formkravets "fått" (rättat 2026-11-04, runda 2, E6; kortet F21):** fixar räknas när appen faktiskt hade fått dem när notisen gick ut (`truthCommon.noticeHadFix`). Förut räknade filtret `f.aisTimestamp <= n.t` även en tidslik rad som harnessen matade in först efter notisen. Klockan stegas i 30 s-bitar och dräneras i bitens slut (replayRunner.js:512–521), så en notis från en asynkron omkörning kan gå ut på exakt nästa rads tid. Nu räknas fixar strikt före notisen, och en tidslik fix bara när notisens frysta position (vesselLat/vesselLon, replayRunner.js:749–769) är just den fixen, alltså när notisen byggdes på den. Räknaren `tidslikUtesluten` redovisar tidslika fixar mer än 70 m bortom linjen som därför inte räknades: `ejInmatad` när vesselLatNext är fixen (raden väntade på inmatning) och `oklar` annars (väntat 0). Kortets `fixBortom.mottagen` säger om fixen kom före notisen eller var notisens egen.
  - Belägg för regeln: en sond i en kopia av motorn före runda 2 jämförde regeln med harnessens fält i varje levererad notis, i standardens 2 000 världar och i bankens bas. I alla 41 832 notiser är regelns gräns harnessens: första fix som inte räknas är vesselLatNext, eller så finns ingen och vesselLatNext är null. 34 918 notiser har en tidslik fix, och 34 809 byggdes på den. 109 syntetiska notiser, alla vid Järnvägsbron, gick ut före sin tidslika rad; på banken inga.
  - A/B (standardens världar, seed 1, `--lanes=synth --no-shrink`; motorn före runda 2 mot samma motor med bara E6): 400 → 399 råa syntetiska utslag och 42 → 41 kluster (20 → 19 kandidater). Enda skillnaden är T1 FÖRVARNINGSFORM-EFTER-PASSAGE på stressnivån, 1 → 0: värld 856 (F21, XENIA vid Järnvägsbron), där notisen byggdes på fixen 6 m före linjen medan den tidslika raden 77 m bortom väntade på inmatning. R1-utslagen 86 (F13:s SALTIS), 783 och 1731 är byggda på den tidslika fixen och står kvar (3 → 3). Bankens T1-kalibrering är oförändrad: 732 bedömda besök av 1 098, 13 utslag, 13 registrerade, 0 oregistrerade träffar. Formkravet gav inga utslag på banken före eller efter.
  - Utfärdsbeviset (två konsekutiva fixar över 350 m efter förra notisen) jämför fortfarande med `<=` mot förra notisens tid. Ingen av de 109 tidslika raderna som kom efter sin notis låg mer än 350 m från punkten, så stället ändrar inget utfall och är orört.

### T2 ÖPPNINGSVARNING FÖRE SANN PASSAGE

- **Regel:** För varje L1-punktobserverbar målbrokorsning (Klaffbron, Stridsbergsbron) körs runOpeningGates.analyseCoverage med resultatet (eventId i namnrymd), världens rader via loadSamples och L1-punktgt. Korsningen är täckt om båten var medlem i en varning, eller absorberad i openingCoverage före korsningen, utan någon mellanliggande punktobserverbar passage. Om korsningen inte är täckt körs classifyMiss på världens rader. Om den är täckt beräknas ledtiden som sann L0-korsning − varningens t.
- **Tröskel:** OKLASSAD ger KANDIDAT med allvar 5. Täckt med ledtid < 60 s ger KANDIDAT LEDTID<60s; 60 s är det hårda golvet enligt etapp7-plan C-IV och runOpeningGates ledtidsgolv. Ledtid 60–150 s ger räknaren ’tunn’. För enbåtsvärldar (kanarier) gäller golvet max(60 s; WARNING_LEAD_MS − TICK_INTERVAL_MS − kadens − 10 s), alltså 110 s vid 30 s kadens och 80 s för klass B med 60 s kadens. Uppmätt ledtid vid Stridsbergsbron norrut: 132–160 s.
- **Falsklarmsvakt:** Accepterade missklasser är tysta (O1-ACCEPTERADE-MISSKLASSER): TYST_I_HORISONTEN, FÖRST_SEDD_FÖR_NÄRA (< 210 s), SNABBARE_ÄN_DEADLINE_TAKET (> 10 kn), RÖRELSEBEVIS_FÖR_SENT och RIKTNINGSBEVIS_FÖR_SENT. Bara punktobserverbara L1-korsningar skickas in, även för andra båtar, eftersom exakt sanning för osedda korsningar gav falska OKLASSAD. U2-VS-DEADLINE → KÄND_ÖPPEN när båten var täckt av en äldre händelse (medlem, ledare eller absorberad före korsningen) och korsningen ligger inom [händelsens första passage; + CONVOY_WINDOW_MS], där den första passagen är en annan båts (etapp7-plan C-IV: garantin förfaller medan båten är täckt). J13-J14-KONVOJSEMANTIK → KÄND_ÖPPEN när en båt utanför en händelse som täckte båten korsade mellan varningen och passagen, och händelsen fortfarande var öppen enligt medlemskravet (ingen täckt båt passerade mer än CONVOY_WINDOW_MS före; ARCHITECTURE §9, runda 2, och J14). Ingen av dem förklarar en returresa: har båten själv korsat bron efter händelsens varning är returen en egen öppning (U15), och U2-RETURRESA är borttagen (registret 2026-11-07, §7 rad 23). Definitionerna finns i `lib/konvoj.js` och delas av oraklets förklaring och registrets predikat; oraklet prövar dem i registrets ordning (§6, M04 och triagens T-2). Världar med stresstäthet redovisas i en egen sektion.
- **v1:** byggt (`oracles/t2Opening.js`). LEDTID<60s prövar båtens varningsbarhet med classifyMiss; en båt som inte var varningsbar är ACCEPTERAD via O1. Filens två jämförelser mellan varningens tid och medlemmarnas rader (avbrottsfönstret och VARNING-PÅ-FRUSET-FIX) hör till T3; se där om tidslika rader (E6).

### T3 FANTOMVARNING MOT AVSIKT

- **Regel:** analysePhantoms körs med resultatet (eventId i namnrymd), raderna och L1-punktgt. Dessutom prövas L0-avsikt: en levererad varning vars medlemmar enligt L0 inte korsar bron inom 120 min räknas som fantom, om inte L0 visar ett avbrott efter varningen (U-sväng eller stopp i minst 10 min). Om världen tar slut inom 120 min fälls ingen dom. En varning där någon medlems senaste observerade fix är äldre än 19 min får klassen VARNING-PÅ-FRUSET-FIX.
- **Tröskel:** Klasserna KAJVOBBEL, UTANFÖR_HORISONTEN, INGA_SAMPEL_FÖRE, OFÖRKLARAD_TIDIGHET, FANTOM-UTAN-AVBROTT och VARNING-PÅ-FRUSET-FIX ger KANDIDAT med allvar 4.
- **Falsklarmsvakt:** AVBRUTEN_APPROACH och GLES_ANFLYGNING är ACCEPTERADE (runOpeningGates classifyPhantom; tystnad avväpnar aldrig), men bara när L0 bekräftar avbrottet. DEADLINE-10KN-GARANTIPRIS: sena passager med veff < 10 kn är garantins pris (helgranskning 2026-11-03). Båda tillämpas i oraklet och i runOpeningGates, och registerposterna har verkan iOraklet (§7, M12). FIXD-SLINGA → KÄND_ÖPPEN vid minst 2 vändningar på minst 150 m inom 60 min (ARCHITECTURE §9, helgranskning 2026-11-03). Klassen fryst arm rättades i etapp 7 (etapp7-plan C-IV, C7b/F-4), så ett återfall är en kandidat, inte ett känt fall.
- **v1:** byggt. Avbrottet räknas från medlemmens senaste observerade fix. Ny klass VARNING-EFTER-SANN-PASSAGE (allvar 4): en varning upp till 10 min efter att en medlem enligt L0 passerat bron.
- **Tidslika rader (analyserat 2026-11-04, runda 2, E6; inte ändrat):** avbrottsfönstret (`lastSeenFixTs`) och VARNING-PÅ-FRUSET-FIX tar med en rad på exakt varningens tid (`<=`), och det är rätt för de varningar där tidslikheten förekommer. En fix-varning (firedBy 'fix') går ut medan raden som utlöste den matas in, så den raden hade appen. En deadline-varning går ut i klockstegningen före nästa rad, men har nästan aldrig en rad på exakt sin tid. Sonden i standardens 2 000 världar (se T1) gav följande.
  - Av 11 866 levererade varningar var 2 844 fix-utlösta och 9 022 deadline-utlösta. 2 352 medlemsrader hade exakt varningens tid. 2 351 av dem hörde till fix-varningar (2 350 var ledarens egen rad, en var en täckt medlems), och i 2 347 av de fallen var raden världens enda rad på den tiden.
  - Den enda deadline-varningen med tidslik rad ändrade inget utfall: fixen före var 300 s gammal, och varningen prövades inte mot något avbrott.
  - T1:s regel går inte att flytta hit. Varningar har ingen frusen position i harnessen. En strikt jämförelse hade gett 19 falska VARNING-PÅ-FRUSET-FIX, där en färsk fix efter mer än 19 min tystnad utlöser varningen, och dolt FANTOM-UTAN-AVBROTT i värld 1590 (Klaffbron#11). Därför är koden oförändrad. Kommentarer i `t2Opening.js` säger varför, och vaktfall i `__tests__/f-tidslik.test.js` håller fast att en utlösande tidslik rad räknas.

### T4 EN VARNING PER ÖPPNING (liggare)

- **Regel:** Per bro grupperas L1-punktkorsningarna i öppningar; en ny grupp börjar när en korsning ligger mer än CONVOY_WINDOW_MS efter gruppens första. För varje grupp räknas de levererade varningarna för bron i intervallet (föregående grupps första passage; gruppens första passage].
- **Tröskel:** Informativ liggare. >1-räknaren och 0-räknaren redovisas var för sig per profil, analogt med H-4b. Ger aldrig kort i v1.
- **Falsklarmsvakt:** U2 och deadline-garantin är dokumenterat oförenliga, och C8 återkallades (etapp7-plan C-IV). Valet mellan (a), (b) och (c) är ägarens. Ett utslag i >1-räknaren är därför inget fel i sig. Nya varningar som uppstår enbart av klockfas fångas i stället av M-FAS.
- **v1:** byggt som liggare; >1- och 0-räknarna per radioprofil står i täckningsrutan.

### T9 RIKTNINGSSANNING

- **Regel:** En levererad notis eller öppningsvarning med riktningen northbound eller southbound jämförs med L0. För kort jämförs ledarens riktning. Utslag ges när alla L0-prov med |v| > 0,25 m/s i [t − 180 s; t] har samma tecken och tecknet motsäger riktningen.
- **Tröskel:** Minst 1 utslag ger KANDIDAT med allvar 4.
- **Falsklarmsvakt:** unknown är aldrig fel (reliability-spec D4, reviderad 2026-07-02); oraklet dömer inte anspråk med riktningen unknown. Registerposten D4-RIKTNING-UNKNOWN gäller sedan 2026-11-04 bara M-FAS-riktningsbyten (§7, M05). Ingen dom fälls när L0 vänt inom fönstret (U-sväng) eller för blandade kort (mixed). FIXD-SLINGA → KÄND_ÖPPEN. INV-15 (WARN) mäter samma sak mot latitud och ger bara en räknare.
- **v1:** byggt (`oracles/t9Direction.js`). Kräver dessutom ur L1 minst två fixar efter båtens senaste L0-vändning, levererade senast 30 s före anspråket.

### T10 PASSAGEDETEKTION

- **Regel:** (a) MISS: en L1-punktkorsning av en målbro har en fix före, högst 600 m från bron, och en beslutsam fix efter (mer än 70 m bortom linjen, högst 600 m från bron, högst 10 min efter), men appen har ingen passage (targetPassages eller intermediatePassages) för båten och bron i kopplingsfönstret [t − 180 s; beslutsam fix + 300 s]. (b) FANTOMPASSAGE: appen har en passage som ingen korsning av samma båt och bro förklarar. Kopplingen är densamma som i (a): korsningen x förklarar registreringen p när x.t − 180 s ≤ p.t ≤ E(x) + 300 s, där E(x) är (a):s beslutsamma fix efter x. Saknar x beslutsam fix (glapp, fixen mer än 600 m bort eller båten kvar inom 70 m) är E(x) första fixen efter x mer än 70 m bortom linjen, annars första fixen efter x. En korsning förklarar högst en registrering per slag (target, intermediate): registreringarna kopplas i tidsordning till den lediga korsning vars fönster slutar först, och en andra registrering av samma slag i en redan registrerad korsnings fönster är en dubblett och fälls. I syntetiska världar prövas mot L0 (exakt tid). På banken prövas mot rådatafacitets alla linjekorsningar (även inferred); facit vet bara att korsningen ligger i [tFrom; tTo], så fönstret börjar där vid tFrom − 180 s.
- **Tröskel:** Minst 1 utslag ger KANDIDAT med allvar 5. En registrering som (a) räknar som träff är aldrig fantom i (b). En registrering efter E(x) + 300 s ger både MISS i (a) och FANTOMPASSAGE i (b); kortet anger då närmaste korsning, hur långt utanför fönstret registreringen ligger och om korsningen redan är registrerad. En dubblett inom fönstret får texten "dubblett: korsningen … är redan registrerad …" och `närmasteKorsning.dubblett = true`. Kortets rubrik är "Registrerad målbro-/mellanbropassage som ingen sann korsning förklarar": klassen täcker en registrering utan korsning, en för sen registrering och en dubblett. Prototypens bankkalibrering: 931 app-passager gav 1 förklarad båt (RIB 218023240, fix 877 m utanför farleden), och 243 beslutsamma korsningar gav 0 missar. Körtid 5,4 s.
- **Falsklarmsvakt:** Glappinfererade registreringar 12–25 min efter korsningen är legitima: E(x) är då första fixen efter glappet. UNDER-BRO-BANDET-70M gäller. Slagen kopplas var för sig, eftersom en målbro som först bokförs som mellanbro och rättas inom samma tick är INV-13:s sak (`invariants.js:568–593`, självläkt par), inte T10:s; appen bokför annars varje passage en gång (dubblettvakterna PASSAGE_DUPLICATE och INTERMEDIATE_PASSAGE_DUPLICATE i `VesselDataService.js`). På banken gäller MÄTGRÄNS-FACIT-SIDLED: rådatafacitet har en sidledsgrind på 250 m. En omstart inom 10 min före korsningen hör till T11:s domän (sträckmål S1). Omstarts- och sidledsvakten i (b) läser registreringens observerbarhetsfönster [tredje fixen före registreringen − 120 s; t + 120 s], som efter ett glapp över 900 s börjar vid glappets början.
- **v1:** byggt (`oracles/t10Passage.js`). (b) rättades 2026-11-04 (motorgranskningens M01). Förut var observerbarhetsfönstret själva kopplingen. Då kunde en sen men äkta registrering av en krypande båt vara träff i (a) och fantom i (b) samtidigt. F08 i första standardrapporten var ett sådant fall: korsning 10:44:55, registrering 10:52:48, och fönstret började först 10:45:06. På banken är utfallet detsamma före och efter rättningen: 931 app-passager, 228 beslutsamma korsningar (fix före bron inom 600 m krävs), 0 missar och 3 fantomer, alla MÄTGRÄNS-FACIT-SIDLED (RIB 218023240).
- **A/B för rättningarna M01 och M02** (standardens 2 000 världar, seed 1, `--lanes=synth --no-shrink`; 400 råa syntetiska utslag både före och efter):
  - M01 ensam ändrar 2 världar. F08:s FANTOMPASSAGE(target) försvinner (R1). Den dubbla registreringen i värld 254 fälls nu som FANTOMPASSAGE(intermediate) (R1): det är F13:s fall, där samma korsning först registreras som målbropassage 16:03:34 och sedan som mellanbropassage 16:16:49. Den gamla regeln förklarade dubbletten med 18 s marginal.
  - Radiorättningen M02 (4.2) ändrar raderna i 115 världar och fynden i 9. De två R0-utslagen PASSAGE-EJ-REGISTRERAD (F05:s kluster, krypfart under 0,49 kn) försvinner. I sju R1- och stressvärldar ändras INV-3 ETA-OSCILLATION (R1 −3, stress +1), ETA-SÅGTAND UPP (R1 +1, stress +1), INV-14 DEFAULT-FLASH (R1 +1) och T2 ÖPPNING-MISS:OKLASSAD [U2-VS-DEADLINE] (R1 +1). I R1 drar båtens radioström andra slumptal från första raden i det nya tillståndet, så även senare rader ändras. I R0 ändras bara sog, på de 144 rader (av standardens 635 R0-världar) där båten rör sig långsammare än 0,25 m/s.
- **Efterrättning D (en korsning, en registrering per slag).** Påståendet i M01-rättningen att reservreglerna för E(x) är "lika smala eller smalare än det gamla" stämde inte. När x saknar beslutsam fix och båten ligger kvar inom 70 m bortom linjen är E(x) första fixen när båten lämnar bandet, och fönstret förklarade då varje registrering tills dess. Granskarens prov: stopp 40 m bortom Stridsbergsbron i 30 min, registreringar 1 och 20 min efter korsningen; gamla motorn fällde den andra (observerbarhetsfönstret), M01-motorn ingen (kopplingsfönster 10:03:39–10:43:15). Fönstret behålls, eftersom en sen registrering av en kvarliggare inte är en fantom (appen registrerar i provet vid första fixen efter korsningen, 6 s efter), men en korsning förklarar nu högst en registrering per slag, och den andra registreringen är en dubblett. Banken är oförändrad (931 app-passager, 3 fantomer, alla MÄTGRÄNS-FACIT-SIDLED). A/B i standardens världar: se §7, "Följder i standardens världar".

### M-EXAKT (självtest)

- **Regel:** Tre relationer körs på alla 24 låsta korpusar: (1) ID: samma indata två gånger; (2) SHIFT30: rader och state flyttas 7 d + 30 s, inklusive alla epok-ms-tal i [1,5e12; 4,1e12] i state och capturedAt; (3) MMSI: ordningsomvänd bijektion m → 999999999 − m i rader och i state-nycklar och -värden av formerna mmsi, mmsi:Bro och Bro|mmsi|riktning. Efter invers mappning ska följande vara lika: notiser (t − Δ, mmsi, bro, riktning, eta, alreadyPassed, meddelande), öppningar (t − Δ, bro, riktning, ledare, etaMin, firedBy, sorterade mmsis), passager och hela textströmmen.
- **Tröskel:** 0 avvikelser på 24/24; design-mutation exp1 mätte 24/24 för alla tre. Ett brott ger SJÄLVTEST RÖTT och exit 2, med diffen i rapporten.
- **Falsklarmsvakt:** leakDiagnostics.heapUsedMB och runtimeDiagnostics jämförs inte, och ’undefined:undefined’ i vessels ignoreras. Relationen mutationsbevisas med utvecklarflaggan --plant=skip-state-shift, som ska fälla exakt de fyra korpusarna med .state.json. Ett brott betyder antingen motorfel eller ett nytt absolut tidsberoende i appen. Båda kräver utredning innan andra fynd går att lita på.
- **v1:** byggt (`relations.runExact`). SHIFT30 jämför hela resultatet efter invers tidsförskjutning.

### M-FAS (bankspåret)

- **Regel:** Hela korpusen och dess state flyttas δ ur profilens mängd. Flytten bevarar typerna: aisTimestamp, fixTs, receivedAt (ISO) och epok-ms i state. Varianten jämförs med basen på: multiset av notisnycklar (mmsi:bro:riktning), öppningsnycklar (bro:riktning) och passagenycklar (T/I:mmsi:bro), nya fatala INV-signaturer och nya leveransfel.
- **Tröskel:** Varje avvikelse ger KANDIDAT med allvar 4, taggen KNIVSEGG och listan över de δ som ger den. Parade notiser får driva högst 30 s; uppmätt max är 23 s. Kalibrering: 45 av 48 varianter är rena på {+7; −11,52} s.
- **Falsklarmsvakt:** Fasberoende utfall undersöks och undantas aldrig (CLAUDE.md; VALIDATION Facit-fällan p. 6); taggen sänker bara prioriteten. K20-FASKÄNSLIG-LEDARE → KÄND_ÖPPEN bara när ledare, riktning eller ETA byts på samma bro:riktning-kort och den alternativa ledaren låg i samma AISHub-pollkluster (≤ 150 ms; ARCHITECTURE §3 K20). Tillagda eller tappade varningar omfattas inte. KIE-PER-KORPUS → ACCEPTERAD för samma episod (|δ| + en tick, plus undantagets egen längd när tiden är episodens slut; högst en träff per undantag och variant; §5.2, runda 2 E3). D4-RIKTNING-UNKNOWN → DESIGN bara för NOTISRIKTNING BYTT och ÖPPNINGSRIKTNING BYTT vars nya riktning är unknown. Ett byte paras bara inom 120 s och då med närmaste post, och driften räknas sedan de tappade och tillagda posterna tagits bort (§5.2, M06 och M07). Brotextens formulering jämförs inte i v1, eftersom fasta halvminuter flyttar den med avsikt. Sträckmål S4 lägger till normaliserade textepisoder.
- **v1:** byggt (`relations.runPhase`); 44 av 48 varianter rena i quick (§16).

### S-KANARIE (självtest)

- **Regel:** Fem R0-världar med exakt känt facit: (1) norrut, 5 kn, klass A, 30 s; (2) söderut, 5 kn, klass A, 30 s; (3) norrut, 8 kn, klass A, 30 s; (4) norrut, 5 kn, klass B, 60 s; (5) ett konvojpar norrut med 3 min mellanrum. Instrumentkrav i kanarierna: notiser > 0; minst 2 målbropassager per transit; mellanbropassager > 0; minst 1 öppningsvarning; minst 1 openingCoverage med reason absorbed i konvojparet; textövergångar > 0. Instrumentkrav i banken: totalerna > 0 för targetPassages, intermediatePassages, openingWarnings, absorberad täckning, visitReentries, journeyResets, confirmedTargetWaits, notiser med alreadyPassed och notiser med source passage-fallback.
- **Tröskel:** Ett brutet instrumentkrav ger INSTRUMENT BLINT och exit 2. Produktförväntningarna stoppar inte körningen men ger kortet KANARIE överst i rapporten. Förväntningarna är: exakt en notis per punkt och transit (6 st); 2 målbropassager; 2 varningar med ledtid över T2:s kanariegolv; DEFAULT inom 120 s efter sista målbrokorsningen (uppmätt 21–54 s).
- **Falsklarmsvakt:** Instrumentkraven fångar wrappers som tystnat efter ett namnbyte: typeof-vakterna på _onBridgeOpeningWarning, _fuseAndEmit och _triggerPointVisits samt loggregexarna i replayRunner. Sådana wrappers gör annars INV-5/7/13 och öppningsdomarna vakuösa utan att något fel syns. Ledtidsgolvet beror på fart och kadens, eftersom även en enbåtskanarie bara får 132–160 s.
- **v1:** byggt (`selftestSynth.js`, `canaries/kanarier.json`); K5:s två Klaffbronvarningar redovisas som information.

### S-KALIBRERING (självtest)

- **Regel:** T1 och T10 körs på de 24 korpusarnas basresultat. Som L1 används rådatafacitet i gt-passages (bara punktstämplade korsningar) och de observerade radiebesöken ur raderna. Varje träff ska matcha en registerpost med korpus-id.
- **Tröskel:** 0 oregistrerade träffar. En ny träff gör att oraklet märks okalibrerat i körningen, så dess syntetiska utslag blir räknare. Träffen visas överst som ny träff på låst bank.
- **Falsklarmsvakt:** Instrumentet kalibreras före produkten (VALIDATION; INV-21 var WARN tills den var tyst). Bankdata är verklig, så en ny träff efter en appändring är själv en regressionssignal och redovisas i stället för att sväljas.
- **v1:** byggt i `lanes/synth.js`: T1 och T10 på basresultaten, varje träff klassad av registret (inte bara oraklets eget förslag). `hunt:repro` dömer om ett kalibreringskort med samma `kalibreraKorpus` och svarar KVAR bara när mekanismen fortfarande ger en oregistrerad träff (§10).

### S-RUNDRESA (självtest)

- **Regel:** För kanarierna och de 20 första världarna görs spec → JSON, och världen simuleras och observeras två gånger ur den tolkade JSON:en. Rad-hasharna ska vara identiska. All simulering sker på djupfryst spec, så varje skrivförsök kastar.
- **Tröskel:** 0 avvikelser. Annars exit 2 (motorfel).
- **Falsklarmsvakt:** Kontrollen fångar exakt prototypens defekt: radion skrev nameUnknownMin i specen, och Infinity blev null i JSON. Efter rättningen uppmättes 200/200 för båda erorna.
- **v1:** byggt: 20 världar × R0/R1 plus de fem kanarierna.

### S-GIT (självtest)

- **Regel:** git status --porcelain ska ge samma utdata före och efter körningen. Utkatalogen ska vara git-ignorerad (git check-ignore -q) eller ligga utanför repot. Motorn sätter aldrig REGEN_DISTRIBUTIONS och skriver aldrig under tests/ (utom tempfiler utanför repot), lib/, drivers/ eller docs/.
- **Tröskel:** En skillnad ger exit 2.
- **Falsklarmsvakt:** Utan git, till exempel i en ren Windows-miljö, skrivs en varning i rapporten och utkatalogen läggs i os.tmpdir()/ais-tracker-hunt.
- **v1:** byggt (`hygiene.js`).

### BEKRÄFTELSE (alla kort)

- **Regel:** Varje kortrepresentants minsta repro prövas i fem steg: (1) H5. (2) Hela världen flyttad +30 s ska ge identiskt utfall. (3) Hela världen flyttas +7 s; försvinner fyndet taggas det KNIVSEGG. (4) R1-fynd körs med R0 på samma spec; reproducerar det flyttas kortet till logikfel. (5) Sträckmål S8: tre nya radiodragningar samt monitoring av och på.
- **Tröskel:** Steg 1–2 måste hålla, annars blir fyndet INSTRUMENTFEL. Steg 3–5 ändrar bara taggar och prioritet: poängen multipliceras med 0,8 vid KNIVSEGG och med andelen reproducerande dragningar.
- **Falsklarmsvakt:** KNIVSEGG döljer aldrig ett kort. R0-motsvarigheten är vägen förbi R1:s okalibrerade realism: ett fel som finns även med idealradio har ingen observerbarhetsursäkt.
- **v1:** steg 1–4 byggda (`confirm.js`); steg 5 (S8) är inte byggt.

### T6 LIVENESS (sträckmål S3)

- **Regel:** Brotexten är DEFAULT oavbrutet i minst 120 s medan en båt uppfyller båda villkoren: (1) enligt L0 är den på aktiv resa mot målbron T, det vill säga korsar T senare och har högst 500 m kvar (APPROACHING_RADIUS); (2) enligt L1 har den en senaste fix som är högst 5 min gammal och ligger högst 500 m från T, samt minst 2 fixar med sog ≥ 2 kn de senaste 60 min.
- **Tröskel:** Minst 120 s ger KANDIDAT med allvar 4 (INV-B1/D1, ratificerad 2026-06-03).
- **Falsklarmsvakt:** Ingen dom fälls i följande fall: senaste fixen ligger stilla i en MOORING_ZONES-kapsel längre än baskravet 3 min (för Kajen 15 min när köundantaget gäller, det vill säga målbro, rörelsebevis och högst 600 m); fixen har navStatus 1 eller 5; inom 5 min efter ctrl:restart; under ctrl:disconnect. D1-KAJZON-DEMOTION → KONFLIKT. P8/L6 hör inte hit, eftersom det inte går att mäta i standardreplay.
- **v1:** inte byggt.

### T11 OMSTART (sträckmål S1)

- **Regel:** Varje F-OMSTART-värld körs två gånger med identisk radio, med och utan ctrl:restart. Omstarten placeras vid ett L0-ögonblick: korsning − 20 s, köstart + 60 s eller tvillingens notistid ± 30 s. Levererade notiser jämförs per (mmsi, punkt, besök) och varningar per (bro, öppningsgrupp).
- **Tröskel:** En extra notis efter omstarten, för samma mmsi:punkt och riktning inom 2 h och utan observerad utfärd, ger KANDIDAT (INV-N1/D3, ratificerat). En tappad notis går till familjekortet OMSTART-RESETILLSTÅND (KONFLIKT): en post per mekanism med antal och högst 2 krympta exempel. En tappad varning ger KOSTNAD, redovisad som antal per 100 omstarter. DEFAULT från omstarten till högst 60 s efter första fixen ger KÄND_ÖPPEN.
- **Falsklarmsvakt:** OMSTART-ARMAR-EJ-PERSISTERADE gäller: v1 persisterar inga armar (trigger-etapp6 §2; ARCHITECTURE §3). Riktning som blir unknown efter omstarten är DESIGN (D4). eventId får namnrymd per instans. ctrl:restart i harnessen är graciös och ögonblicklig, så fynd som kräver krasch utan flush ligger utanför v1.
- **v1:** inte byggt.

### M-ISO (sträckmål S2)

- **Regel:** Varje fartyg i varje korpus körs ensamt med mmsiFilter. Förutsättningen är att korpusen har 0 ctrl-rader, vilket motorn kontrollerar. Kraven: (a) fartygets notisnycklar i helkörningen är desamma som isolerat; (b) öppningstäckningen per (mmsi, bro), som medlem eller absorberad, är densamma som isolerat; (c) i varje 15 s-prov som ligger utanför ±45 s från en övergång är helkörningens antal per målbro summan av delarnas; (d) en fatal invariant som bara syns isolerat räknas som AVMASKERAD.
- **Tröskel:** (a)–(c) ska stämma exakt; uppmätt 98 av 98 fartyg och 0 avvikelser av 16 288 prov. (d) Minst 1 ger KANDIDAT med allvar 4.
- **Falsklarmsvakt:** Antalet varningar får skilja, eftersom väntande båtar absorberas enligt U2. Därför jämförs täckning och inte antal. mmsiFilter används aldrig när ctrl-rader finns, eftersom runnern filtrerar bort dem.
- **v1:** inte byggt.

### S-REALISM (sträckmål S7)

- **Regel:** Generatorns mått per era jämförs med fältets mått för samma era. Underlaget är 150 världar per era, bara generering. Måtten är: glapp i rörelse, korsningsglapp, sista fix före målbrokorsning (tid och avstånd) och fixar per transit.
- **Tröskel:** p50 inom ±30 % och p90 inom ±40 % för alla mått ger R1 nivån fältlik; annars redovisas R1 som robusthet. Grinden är röd i dag: aisstream-glapp p90 321 s mot 538 s, sista fix före korsning p50 305 m mot 181 m.
- **Falsklarmsvakt:** Jämförelsen görs per era. Prototypen jämförde AISHub-eran mot poolade fältvärden som domineras av aisstream, ett mätfel som alltid ger rött. Tills mått per era finns för korsningarna viktas generatorns blandning efter fältets källpar 320/83/36.
- **v1:** tabellen mäts och redovisas i varje självtest; ingen grind i v1.

## Bilaga C — modulkarta

Alla sökvägar under `tests/replay-validation/bugHunt/`.

| Fil | Innehåll |
|---|---|
| `hunt.js` | CLI, körningsobjektet och faserna 0–5; exitkoderna |
| `lib/profiles.js` | profilerna quick, standard och night, nivåvikter, KNIVSEGG-faktorn och kortgränsen |
| `lib/hygiene.js` | utkatalog, tempkatalog, git-vakt, miljöskrubb och körnings-id |
| `lib/pool.js` | barnprocesspoolen, tidsgränsmodellen, SIGKILL, omkörning och stderr-histogram |
| `lib/schema.js` | schemavalideringen av rader |
| `lib/lanes.js`, `lib/lanes/synth.js` | spårregistret; inbyggda självtest- och bankspår; sanningsspåret med självtesttillägg, fas 2, fas 4 och hunt:repro |
| `lib/selftest.js`, `lib/relations.js`, `lib/bankOps.js`, `lib/project.js` | självtestet, M-EXAKT och M-FAS, bankens transformationer och projektionerna |
| `lib/registry.js`, `beslutsregister.json` | beslutsregistret och dess predikat |
| `lib/cluster.js`, `lib/report.js`, `lib/finding.js`, `lib/signature.js` | klustring och poäng, rapporten, fyndformatet och normaliseringen |
| `lib/instances.js`, `lib/platser.js`, `lib/util.js` | eventId-namnrymd, registrets geometri och hjälpare |
| `lib/oracles/existing.js`, `lib/oracles/health.js` | INV-F, INV-W, LEV, H1–H3 och H5 |
| `lib/oracles/t1Notice.js`, `t2Opening.js`, `t9Direction.js`, `t10Passage.js`, `truthJudge.js`, `truthCommon.js` | sanningsoraklen |
| `lib/rng.js`, `lib/geo.js`, `lib/calib.js`, `lib/bankHash.js`, `calibration.json` | slump, farledsgeometri och den frysta kalibreringen (skrivs bara av `tools/freezeCalibration.js --write`) |
| `lib/world.js`, `lib/families.js`, `lib/radio.js`, `lib/truth.js` | världsmodellen, familjerna, radioprofilerna och sanningen L0/L1 |
| `lib/synthCore.js` | en spec → dömd och klassad värld (delas av fas 2, fas 4 och hunt:repro) |
| `lib/shrink.js`, `lib/confirm.js` | krympningen på specnivå och bekräftelsen |
| `lib/selftestSynth.js`, `canaries/kanarier.json`, `tools/writeCanaries.js` | kanarierna, rundresan och bankkalibreringens byggstenar |
| `lib/realism.js` | realismtabellen för R1 |
| `lib/synthLane.js` | fristående drivare för sanningsspåret (felsökning utan ramverket) |
| `__tests__/` | jest: schema, domarkärnan, registret, klustring och rapport, bankoperationer, hygien och pool, geometri och kalibrering, världen, sanningsoraklen samt krympning och bekräftelse |
