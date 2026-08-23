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
npm run validate          # jest + korpusar + syntetiska scenarier + öppningsgrindarna (~3 min)
npm run validate:full     # ovan + 72h-soaken (~10 min) — före commit/publicering
```

Eller stegen var för sig:

| Steg | Kommando | Grönt betyder |
|---|---|---|
| Enhetstester | `npm test 2>&1 \| tail -5` (**pipa alltid** — annars ENOSPC) | 1400+ tester passerar (1551 i 103 sviter efter öppningsetappen 2026-08-03) |
| | ⚠️ **Pipe-fällan** (ChatGPT-granskningen 2026-07-10, B1): pipens exitkod är `tail`:s (≈alltid 0) — LÄS `Tests:`-raden, lita inte på `$?`. `npm run validate` är immun: den skriver jest-utdatan till en tempfil och propagerar jest:s riktiga exitkod. | |
| Korpusarna | `npm run replay:all` | 17 låsta korpusar (~277,5 h verklig AIS — siffran ändras vid varje låsning; skriptets egen utskrift är den aktuella) ger EXAKT facit-antal notiser + exakt (mmsi,bro)-fördelning + exakt (mmsi,bro,riktning)-fördelning + EXAKT bridge_text-transitionsström (golden-text/) + alla invarianter |
| Syntetiska | `npm run replay:synthetic` | 45 scenarier (gap, U-svängar, GPS-hopp, kajliggare, sog=null, omstart, 2h-prune-stillaliggare …) håller sina kontrakt. OBS: "rena" = inga FATALA utslag; WARN-invarianter (t.ex. INV-18) är informativa och fäller inte. Se §Syntetiska scenarier nedan för omstartsscenariots särskilda placeringskrav. |
| Öppningsgrindarna | `npm run replay:openings` | ETAPP 6: det proaktiva lagret (`bridge_opening_soon`). **O1** varje målbropassage i SAMTLIGA korpusar (låsta som olåsta — antalet står i skriptets utskrift, inte här) har en öppningsvarning FÖRE passagen — varje miss klassad mot rådata (oklassad = rött); en KONVOJTÄCKNING underkänns om bron bevisligen öppnat och stängt för någon annan emellan. **O2** varje varning utan passage inom 20 min klassas mot rådata (KAJVOBBEL och UTANFÖR_HORISONTEN = rött; avbruten approach, gles anflygning och garantipris = accepterade) — även SEN_PASSAGE-hinken klassas. **O2b** (S14, 2026-08-23) SAMMA fantommätning mot RÅDATAFACIT (A2, `gt-passages`) i stället för appens egna passager — O1b:s mönster: appens passageregistreringar delar grindarnas blindfläck, så en varning kan kallas BEKRÄFTAD av appens egen bokföring medan rådatan inte känner korsningen. Serierna redovisas BREDVID varandra (annars går körningsloggar inte att jämföra bakåt). `inferred`-poster (korsning bevisad, tidpunkt = fönster) bär ALDRIG hinkindelningen utan hamnar i egen hink INFERRERAD_TID — hinkarna ÄR en tidsfönstermätning. **O2b är INFORMATIV: den ändrar inte exitkoden** (grinden ligger kvar på appserien precis som O1:s täckning i fas A); `OPENING_GT_STRICT` flyttar den hit när fas C är klar. Vid införandet: 0 röda i BÅDA serierna, 118 av 360 varningar byter hink (98 blir omätbara `inferred`) och EN varning byter åt det farliga hållet (JAATTEN II @ Stridsbergsbron i 20260708-21h — samma fall INV-21 redan fäller). **O3** A/B-nattens båda armar: 6/6 öppningar varnade före, konvojen som EN varning, boat_near byte-identisk med nattens facit. Dessutom **avfyrningsfönstret** (`t − dueMs` inom två tick — kontraktet "avfyra så sent som garantin tillåter") och **ledtidsgolvet** (hårt golv 60 s; tunnare än utlovade 150 s rapporteras). |
| Soaken | `node tests/replay-validation/runSoak.js` | 72 h blandtrafik: 0 processfel, inga läckor, fatala invarianter rena |
| Lint | `npx eslint <ändrade filer>` (per fil — OneDrive gör helträd långsamt) | 0 fel |

**Rör ändringen ETA-vägen?** Då räcker inte batteriet: facit säger bara att
texten är OFÖRÄNDRAD, inte att siffran är SANN. Mät med `npm run measure:eta`
mot baslinjen — se §ETA-mätharnessen, och läs ARCHITECTURE §8 (e) K6 först.

**Korpuslåsningens två grindar** — `node tests/replay-validation/checkReplayIntegrity.js`
(jsonl mot logg) och `npm run replay:phase` (fassvepet) — ingår MEDVETET inte i
`npm run validate`: de prövar en FÄLTKÖRNING, inte en kodändring, och körs före
varje låsning. Fullständiga kommandon och grindkriterier i §Fältprov / ny
korpus, steg 3 och 4. Integritetskontrollens egen domarlogik är enhetstestad i
`tests/replay-integrity.test.js` (körs med `npm test`); dess REGRESSIONSFALL kör
mot fixturer i repot (sökvägen står i testfilens huvud), inte mot fältfiler i
`~/.ais-tracker-logs` — de senare byggs om av just det `grep | sed`-kommando
steg 2 rekommenderar, och då hade ett grönt test blivit rött av att projektet
gjorde vad körboken säger.

⚠️ **Ett bart `npm run replay:phase` är FÖRVÄNTAT rött** tills den olåsta
`20260806-42h` är avgjord efter K20a (gula paketet): standardsvepet tar just de
OLÅSTA korpusarna, och den bär 117 odokumenterade fasavvikelser (HEAD 480b78f mäter samma 117 — talet drev från 101 sedan K20a; skriptets egen utskrift är den aktuella siffran) i öppnings- och
brotextdimensionerna. Rött där är alltså en ÄRLIG mätning, inte en trasig
grind — men lägg därför aldrig kommandot i `npm run validate`/CI, och kör
rökprov mot en NAMNGIVEN korpus (`npm run replay:phase -- <jsonl>`).

**Nätisolering (etapp 1, 2026-08-02):** replay-harnessen och RealAppTestRunner
stubbar `https` med en KASTANDE stub — batteriet kan aldrig göra äkta anrop
mot AISHub (rate-limiten är 1 request/minut per username; en testkörning som
läcker ut på nätet kan ge indragen access). AISHub-klienten enhetstestas med
mockad `_httpGet` under fake timers (`tests/aishub-client-unit.test.js` låser
kadensdisciplinen: aldrig < 61 s mellan poll-starter över 24 h simulerad tid).

**Fusionsgrinden (etapp 3, 2026-08-02):** `npm run replay:fusion` genererar en
syntetisk AISHub-skuggström ur varje låst korpus (makeFusionCorpus: 65s-poll-
snapshots av senast kända fix, re-leveranser, 150 ms-spridning) och kör den
genom AISSourceMultiplexer i 'both'-läge (`REPLAY_FUSION=1` — muxen sitter PÅ
RIKTIGT i vägen, F1-F6 aktiva). Kontraktet: eftersom ekona bara upprepar redan
levererad information ska notisantal, (mmsi,bro)-multiset och riktnings-
multiset vara EXAKT parentkorpusens facit, och grinden asserterar dessutom
att fusionen var aktiv (accepted > 0, alla ekon svalda: rejected > 0).
Golden-text hoppas medvetet över (ekon förskjuter publiceringstidpunkter utan
att ändra innehållsbeslut). Kör grinden efter varje ändring i FixFusionPolicy,
AISSourceMultiplexer eller fixTs-plumbningen — utöver ordinarie batteri.

**Latenspasset (V4, A/B-natten 2026-08-03):** grinden kör numera ALLTID två
pass — normal leverans och +60 s LEVERANSLAGG på hub-strömmen (`aisTimestamp`
skjuts, `fixTs` orörd; `FUSION_PASS=normal|latency` kör ett enskilt pass vid
felsökning). Motivet: nattens latenstest gav +30 s ⇒ dubbelnotiser på målbro
och +60 s ⇒ sju dubbletter, varav en 152 m EFTER passagen, medan källans egen
observerade latens hade p90 62,3 s — felmoden låg alltså INOM normal drift.
Kravet är EXAKT samma facit i båda passen och noll dubbletter, plus att F6
faktiskt fyrade (`stale_cross_fix > 0`) i latenspasset: utan F6 släpps 9-624
släpande hub-fixar per korpus in i pipelinen, så noll träffar betyder att
grinden slutat pröva något. `tests/fusionsgrind-latenspass-v4.test.js` vaktar
kopplingen (lagget flyttar bara mottagningstid; båda passen deklarerade).

**Fältkorpusen (granskningsrunda 2, 2026-08-03):** de syntetiska ekona ovan
sväljs till 100 % (ekot bär moderfixens fixTs), så grinden bevisade bara att
F-reglerna BLOCKERAR — muxens accept-väg, StatusServices segmentbevis,
korskälle-fysik-dt:t och klockkompensationen var oexekverade i hela batteriet.
`replay:fusion` kör därför även `corpora-data/ais-fusion-20260803-nattkorning.jsonl`
— A/B-nattens B-arm med 1014 ÄKTA AISHub-poster, där ~650-720 hub-fixar faktiskt
ACCEPTERAS — i fem varianter: som levererad, +30 s och +60 s leveranslagg, samt
TVÅ klockskevsvarianter (hubklockan 60 s respektive 5 min FÖRE Homeys). Kravet:
samma 24 notisnycklar, noll dubbletter, noll notis för 265012090 (kajvobbel-
fantomen), TIM:s Olidebron- OCH Järnvägsbron-passager kvar i
`intermediatePassages`, och `accepted` > antalet aisstream-rader (annars är
accept-vägen oexekverad och passet bevisar ingenting). Skevvarianterna är de
enda som kan fälla F6b — `makeFusionCorpus` och `shiftFeedDelivery` härleder
båda ekots fixTs ur korpusstämplarna och är per konstruktion blinda för
fixtidsskev.

**Så kör du grinden** (den ingår MEDVETET inte i `npm run validate` — den tar
lika lång tid som hela korpusbatteriet; kör den separat efter varje ändring i
fusions-/fixTs-/andrakällelogiken, och alltid före en A/B- eller
aktiveringsomgång):

```bash
npm run replay:fusion                       # 15 korpusar × 2 pass + fältkorpusens 5 varianter
FUSION_PASS=latency npm run replay:fusion   # ENBART latenspasset (felsökning)
FUSION_PASS=normal  npm run replay:fusion   # ENBART normalpasset (felsökning)
```

⚠️ Med `FUSION_PASS` satt hoppas **fältkorpusen över helt** — det är den enda
delen som exekverar accept-vägen, så en grön `FUSION_PASS=…`-körning är inget
kvitto. Slutkontroll körs alltid utan variabeln. Exit-koden är 0 endast om
samtliga pass OCH samtliga fältvarianter håller kontraktet; slutraderna ska
lyda "Fusionsgrinden grön i 2 pass" + "Fältkorpusen grön i 5 varianter".
Latenspasset jämför dessutom mellanbro-/målbropassagerna mot NORMALPASSETS
register (pelare 1-regression: nattens B+30 s gav identiskt notismultiset
medan `212571000|Järnvägsbron` föll ur `intermediatePassages`).

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

   **Riktningsnycklarna är INTERNA trots att tokenen är svensk** (F5,
   2026-08-21): `replayRunner.js:83–99` översätter tillbaka med
   `fromUserDirection` innan facit läses. Ett SPRÅKBYTE är ingen
   beteendeändring och får inte kosta en omlåsning — river du adaptern
   flyttas riktningsmultisetet i 17 korpusar utan att en enda båt har bytt
   kurs.

5. **Öppningsfacit** (etapp 6, O5): multiseten `bro:riktning → antal` per korpus
   för `bridge_opening_soon` (`opening-distribution.json`). Notisfacit,
   riktningsfacit och golden-text är per konstruktion BLINDA för den
   dimensionen — utan filen kan en tappad eller uppdiktad öppningsvarning inte
   upptäckas av någon gate. Skrivs i SAMMA regen-svep och med samma villkor:
   `REGEN_DISTRIBUTIONS=1 npm run replay:all`, aldrig för hand. Saknas filen
   skriver `replay:all` en högljudd rad; saknas en LÅST korpus i den är det ett
   hårt fel.

6. **Fas-känsliga utfall** (K20, 2026-08-21): innan du felsöker en flyttad
   siffra i en AISHub-korpus — pröva om utfallet ens är stabilt. Replayn ankrar
   klockan i korpusens första sampel, och en förskjutning på 5–20 s räckte i
   19/8-korpusen för att byta ledande båt, riktning och ETA i en
   öppningsvarning. Ett värde som vippar av ren fas är en knivsegg, inte ett
   facit: fassvepet (§Fältprov, steg 4) avgör vilket, och en dimension som
   visat sig fas-känslig ska bära det skriftligt — i korpusens `note` som
   permanent minne OCH i `tests/replay-validation/phase-sweep-exceptions.json`
   som grindens egen kvittens — innan den används som bevis mot en fix.

Exempel på att fällan fungerar: helgranskningens ETA-gap-omordning gav
"ärligare" värden men korpusbelagd fatal sågtand (2→32 min i texten) —
batteriet fällde den, fixen togs tillbaka.

## Verkanskontrollen (etapp 7, 2026-08-09)

En grön grind betyder att fixen inte gick sönder — **inte** att den gör något.
Efter varje fix, mät och skriv ut i klartext:

> Hur många notiser, öppningsvarningar eller brotexter ändras faktiskt?

**Noll är ett giltigt svar och ska redovisas som sådant.** C9 (förtöjd utan
navStatus) landade med korrekt design, enhetstester och noll observerbar effekt
i 320 timmar korpusdata — 'stale'-hinken var identisk med och utan fixen, och
den enda avväpningen följdes av ombeväpning 68 sekunder senare. Utan
verkanskontrollen hade den bokförts som en seger.

Två skäl till att en fix kan sakna verkan i replay men behövas i drift:
- **Klassen kräver beteende korpusarna inte innehåller.** C9 förutsätter att
  fartyget fortsätter rapportera medan det ligger stilla. Fältet gör det (13 av
  51 avväpningar via ren TTL i 42h-provet); i korpusarna tystnar båtarna i
  stället, och TTL hinner först.
- **En tröskel uppströms neutraliserar den.** C9:s stillhetsklocka nollas vid
  `sog ≥ 0,5 kn`, och kajvobbel överskrider det (VIRGO: 4 av 19 kajsampel på
  0,5 / 2,1 / 2,9 kn).

Båda är legitima skäl att behålla fixen — men de ska stå skrivna, i koden och i
commit-meddelandet, annars tror nästa läsare att problemet är löst.

## Förarbete åldras

Ett beslutsunderlag som byggdes mot en tidigare datamängd kan vara osant i dag.
C0 (Stallbacka-koordinaten) förbereddes i tolv omgångar och byggde på en
provkörning från 2026-08-06. Korpus #17 skapades efteråt och innehöll en tredje
förlorad notis (SIESTA) som ingen kunde se då — och förarbetets bärande premiss,
"+2 återvunna äkta passager", visade sig vara två *fantomer* från en kajplats.
Läxan gäller även när fixen till sist landar: C0 genomfördes 2026-08-10, men mot
en ANNAN punkt än förarbetets (konsensuspunkten 58.309802/12.316748, inte
`lon 12.317971` som föll på 159,8 m AV brolinjen) och med ett annat mätutfall
(+3 äkta notiser / −0 förlorade). Se ARCHITECTURE §2 och
`docs/c0-matning-2026-08-10.md`.

**Verifiera premisserna mot nuvarande data innan du genomför en förberedd fix**,
särskilt om nya korpusar tillkommit sedan förarbetet skrevs.

## Noter är permanent minne

Sifferpåståenden i `corpora.js`-noter blir projektets sanning. Läs **hela**
fönstret innan du skriver ett intervall — fem imprecisioner i en omlåsningsnot
(avståndsintervall, sog-utslag, COG-spann, fönsterstorlek, minsta avstånd)
härrörde alla från att siffrorna lästs ur ett urval sampel. Ingen rörde
substansen, men alla hade blivit permanenta.

Samma sak gäller loggrader: en rad som påstår fel *källa* för ett värde
vilseleder nästa fältläsare lika effektivt som ett fel värde.

## Invarianterna — facit-oberoende sanningar

`tests/replay-validation/invariants.js` körs på varje replay. Fatala:
grammatik (INV-1), notisdubbletter/tokens (INV-2), **räkningsbaserade INV-5/7**
(varje registrerad målbropassage kräver sin EGEN notis i tid — även
returpassagen av samma bro), sluttext (INV-6), namn (INV-8), distans (INV-11),
läckage (INV-12), ETA-fysik (INV-16). WARN (informativa): INV-14W/15/17/18/19/20
samt **INV-21** (etapp 6: öppningsvarning EFTER registrerad målbropassage för
samma händelse — tyst över samtliga korpusar och soaken i dag).
Domarlogiken har EGNA enhetstester i `tests/replay-invariants-unit.test.js` —
ändrar du en invariant, uppdatera dem.

Kända legitima WARN: 2 st INV-18 i soaken (Strids 19→27 min vid modellerad
inbromsning; var 3 före Fable-granskningen 2026-07-10b — E-1-fixen tog en) —
dokumenterade, ignorera. Korpusnivå: INV-18 i 19h/13,5h + INV-15 i 21h
(AKIRA, dokumenterad i corpora.js) är förexisterande och informativa.

## Syntetiska scenarier — placeringen ÄR testet

`tests/replay-validation/runSyntheticScenarios.js` matar `scenarioGenerator.js`
resor genom replayharnessen och dömer med invarianterna plus scenariospecifika
förväntningar. `ctrl:'restart'` (och `disconnect`/`reconnect`) läggs in som
egna rader i sampelströmmen och konsumeras av `replayRunner`; `restart` river
appen med `onUninit()` och bygger en NY instans mot SAMMA settings-store, så
allt som ska överleva en omstart prövas på riktigt (namncachen, boat_near-
dedupen, öppningsdedupen).

**FÄLLAN — en ctrl-rad på fel sekund gör grinden tyst i stället för grön.**
`omstart-mitt-i-passage` låg fram till 2026-08-22 ~200 m norr om Klaffbron.
Där fanns ingen post att deduplicera: Klaffbron-varningens nyckel var redan
nollad av passagen och Stridsbergsvarningen hade inte hunnit avfyras.
Mutationsprov: hela den persistenta öppningsdedupen kunde kopplas bort
(`app.js _openingDedupActiveUntil` → `null`) utan att scenariot blev rött —
`maxOpeningsPerBridge` kunde alltså aldrig falla. Omstarten ligger nu **11 min
efter den första Stridsbergsbron-varningen**, vilket är EFTER in-session-
fönstret (avfyrning + `CONVOY_WINDOW_MS`) men FÖRE `expiresAt`, så det är
J15:s boot-fönster som spärrar. En saktafartszon (2,0 kn mellan broarna)
sträcker ut anflygningen så att omstarten ryms före passagen. Härledningen med
mätta tider står i filens egen kommentar (`OMSTART_RESTART_S`).

**Kontraktet är tvåsidigt.** `maxOpeningsPerBridge` fäller bara dubbletten;
`suppressedOpeningFires: N` kräver dessutom att EXAKT N av servicens
avfyrningar tystades av app-sidans dedup (`openingServiceFires` − levererade
kort). Utan det talet blir en omstart som slutar beväpna om — alltså en
förlorad andra varning — falskt grön. Standardvärdet är 0 för alla andra
scenarier: varje avfyrning ska nå kortet.

**Skriver du om ett scenario: mutationsbevisa det.** Kör den vakt scenariot
påstår sig pröva i en isolerad kopia, koppla bort den, och kontrollera att
scenariot blir RÖTT. Blir det grönt är kontraktet dekoration.

## Täckningskartan — diagnosverktyg, INTE en gate

`tests/replay-validation/coverageMap.js` (etapp 6) svarar på frågan **var längs
farleden, och för vilken källa, tappar vi båtarna?** Notislöftet kan aldrig bli
bättre än mottagningen; kartan är underlaget som deadline-motorns trösklar
härleddes ur. Den fäller ingenting och ingår därför inte i `npm run validate`.

```bash
node tests/replay-validation/coverageMap.js                      # alla korpusar
node tests/replay-validation/coverageMap.js --corpus 20260803-natt   # en korpus
node tests/replay-validation/coverageMap.js extra.jsonl --md /tmp/x.md
```

Utdata: `docs/coverage-map-2026-08-03.json` (maskinläsbar) +
`docs/coverage-map-2026-08-03.md` (segmenttabell, heatmap, verdikt).

Metod: farleden modelleras som en centerlinje (Kanalinfarten → Olidebron →
Klaffbron → Järnvägsbron → Stridsbergsbron → Stallbackabron), varje fix
projiceras på den (meter längs farleden + lateralt avstånd) och 100 m-segmenten
räknar transitfixar, glapp, **mörka passager** (traversering utan en enda fix)
och blackouts (>120 s i rörelse) **per källa**.

⚠️ **Klockdomänen** (ARCHITECTURE §mux): kartan körs i FIXTIDSDOMÄNEN
(`fixTs ?? aisTimestamp`) — "när hörde mottagarnätet båten". Mäter man AISHub i
leveransdomänen blir allt 65 s-kvantiserat: det är pollkadensen, inte antennen.
Leveranslatensen redovisas separat. Läser du om kartan, läs den siffran först.

## ETA-mätharnessen — diagnosverktyg, INTE en gate (röda etappen 2026-08-22)

`tests/replay-validation/measureEtaAccuracy.js` svarar på frågan **hur fel är
ETA-siffran vi faktiskt PUBLICERAR?** Facit kan bara säga att texten är
oförändrad; det säger ingenting om huruvida "om 8 minuter" var sant. Harnessen
fäller ingenting och ingår därför inte i `npm run validate`.

```bash
npm run measure:eta                                      # alla låsta korpusar
npm run measure:eta -- <utkatalog>                       # egen utkatalog
npm run measure:eta -- <utkatalog> --label="efter X"     # namnge körningen
npm run measure:eta -- <utkatalog> --corpus=20260713-41h # en korpus
npm run measure:eta -- <utkatalog> --include-unlocked    # ta med olåsta
```

**Utkatalogen**: utan argument skrivs `eta-accuracy.json`/`.txt` till
`<os.tmpdir()>/ais-tracker-eta` (`%TEMP%\ais-tracker-eta` på Windows-
jobbdatorn) — skriptet skriver ut de fullständiga sökvägarna sist i körningen.
Fram till 2026-08-22 stod här en hårdkodad absolut macOS-sökväg med ett
sessions-UUID i; på varje annan maskin skapade den tyst en bogus katalog i
stället för att skriva dit någon letade. Defaultkatalogen är EN fast plats som
skrivs över av nästa körning: en baslinje som ska sparas ska alltid ha en egen
`--out=<katalog>` (eller ett bart positionsargument).

**Storheten**: publicerat värde − (nästa faktiska brolinjekorsning för samma
mmsi+bro − påståendets tid). Positivt = för pessimistisk, negativt = för
optimistisk. Sanningen hämtas ur `gt-passages/` och **endast `kind=line`** —
inferred-korsningar och Kanalinfartens zonbesök hålls utanför felstatistiken.
Tre påståendetyper mäts: brotextens "beräknad broöppning om [cirka] N minuter",
`boat_near`-tokenens `eta_minutes` och `bridge_opening_soon`-kortets
`eta_minutes`. "strax" mäts separat som ett LÖFTE (utlovar < 3 min) och blandas
aldrig in i felstatistiken. Körtid ~30 s för hela baslinjen; utdatan är
deterministisk (bit-identisk JSON bortsett från `meta.generatedAt`).

**BASLINJEN — HEAD `a451f75`, 2026-08-22, 17 låsta korpusar (~330 h):**

| Mått | Värde |
|---|---|
| Påståenden totalt / mätbara | **2 583 / 1 729** (oattribuerade: 0) |
| Median absolutfel | **2,37 min** |
| p90 absolutfel | **34,45 min** |
| Bias | **−15,42 min** (appen är systematiskt FÖR OPTIMISTISK) |
| Andel ≤ 2 min | **47,3 %** |
| Jämförbar delmängd (passage inom 60 min, n=1 648) | median 2,03 · p90 24,91 · bias −5,08 · 49,6 % ≤ 2 min |
| Sämst bro | Stridsbergsbron (median 5,33 · 32,2 % ≤ 2 min) |
| Bäst bro | Stallbackabron (median 0,23 · 98,8 % ≤ 2 min) |
| Dubbelkörningar (K6) | 3 885 `[ETA_CALC_V2]`-rader, **1 824 par < 200 ms ⇒ 93,9 %** |

Råfilerna ligger i `handoff-2026-08-21/eta-baseline-2026-08-22/`
(`eta-accuracy.json` + `eta-accuracy.txt` + `LÄS-MIG-baslinjen.md`).
Mätarens rena delar (textparser, utpekning, statistik, parräkning) är
enhetstestade i `tests/eta-accuracy-unit.test.js` (33 tester, körs med
`npm test`).

### Vad K25 gjorde — det arbetade exemplet på varför bandet, inte summan

Mätning av arbetsträdet (K25 + K19, K6 backad) mot baslinjen ovan, samma
17 korpusar:

| Påståendetyp | Band | Före | Efter |
|---|---|---|---|
| brotext | sanning < 5 min (n=192) | Σ 477,28 · median 1,29 · 65,1 % ≤ 2 | **bit-identiskt** |
| brotext | sanning < 10 min (n=470) | Σ 1 101,89 · median 1,30 · 66,0 % ≤ 2 | **bit-identiskt** |
| öppningskort | båda banden | — | **bit-identiskt** |
| notis | sanning < 5 min (n=349) | Σ 279,90 · 90,0 % ≤ 2 · bias +0,46 | Σ **264,46** (−5,5 %) · **91,4 %** · bias **+0,39** |
| notis | sanning < 10 min (n=381) | Σ 425,03 · 84,0 % ≤ 2 · bias +0,18 | Σ **406,01** (−4,5 %) · **84,8 %** · bias **+0,05** |
| notis | TOTALT (alla n) | n=428 · Σ 2 452,43 | n=**431** · Σ **2 533,68** ⟵ **SER SÄMRE UT** |

Sista raden är hela poängen. K25 gör tre notiser MÄTBARA som inte var det förut
(DELFIN, SILVERTASS, ADA — tokens som tidigare bar ett saknat/föråldrat värde
bär nu fixets ETA). Alla tre har sanning 16–42 min, alltså långt utanför det
band användaren står i, och deras fel dominerar totalsumman. **Varje operativt
band blev bättre samtidigt som totalen blev sämre.** Mät bandet.

De enda spåren efter K25 i brotexten är TRE påståenden vars TIDSSTÄMPEL flyttar
5 ms (IN-AXXI 20260710-13h 07:55:36.950→.945, VIRGO samma korpus
11:34:54.489→.484, HEY JOE 20260713-41h 12:11:09.945→.940) — identisk text,
identiskt publicerat värde, identiskt fel. ALLA TRE är golden-transitioner
(20260710-13h idx 17 OCH idx 92, 20260713-41h idx 118 — två korpusar, två
golden-filer) och låstes om 2026-08-22 med not i corpora.js. Riktningen är
5 ms TIDIGARE (fick .945, väntade .950): micro-grace 15 ms → 10 ms när den
köade notisen låter high-signifikansen ansluta till en redan öppnad batch.

### REGELN: varje ändring i ETA-vägen MÄTS mot baslinjen

Rör en ändring `StatusService.calculateETA`, `ProgressiveETACalculator`,
`_reconcilePublishedETA`, extrapolationen eller `_positionUpdatedSinceLastETA`
gäller följande — det är läxan från K6 (ARCHITECTURE §8 (e)):

1. **Mät i banden `sanning < 5 min` och `sanning < 10 min`.** Det är banden
   användaren står vid bron och tittar på.
2. **ALDRIG totalsumman som acceptanskriterium.** 87 % av felmassan ligger över
   20 min (förtöjda/väntande båtar appen fortsätter räkna ned för), så en äkta
   regression i det operativa bandet drunknar. K6:s rena memo förbättrade
   totalsumman och försämrade bandet < 5 min med 11,4 % samtidigt.
3. **Acceptansmåtten är median absolutfel, andel ≤ 2 min och bias** — aldrig
   summan av absolutfel. Summan **byter tecken beroende på parningstolerans**:
   samma ändring gav +4,08 % på den parade delmängden och −0,9 % på den oparade,
   eftersom de poster som bara finns i den ena körningen i snitt var sämre.
4. **Redovisa BÅDA populationerna** (parad och oparad) med n för var och en.
   Annars kan en framtida omlåsare visa vilket tecken som helst genom att välja
   parningstolerans.
5. **Räkna textövergångarna.** Harnessen väger varje PUBLICERING lika och tar
   ingen hänsyn till hur länge ett värde stod kvar — en ändring som halverar
   antalet övergångar kan se neutral ut trots att användaren ser fel siffra
   dubbelt så länge. K6 tappade 63 brotextövergångar (2 163 → 2 100) utan att
   felmåttet fångade det. **Känd begränsning; ett tidsviktat parallellmått
   saknas.**
6. `measure:eta` **ersätter inte** `npm run replay:all` — den mäter en annan
   sak. Facit säger *"texten är oförändrad"*, harnessen säger *"siffran är
   sann"*. Båda krävs.

## Fältprov / ny korpus (så samlas verklighet in)

**Två grindar står mellan en fältkörning och en låst korpus: steg 3
(logg-integriteten) och steg 4 (fassvepet).** Båda är OBLIGATORISKA före
låsning, båda kan köras i efterhand på en färdig körning, och båda ger grönt
bara på mätning — aldrig på att körningen "såg bra ut". Skälet är fältprov 10:
en trunkerad korpus och en knivseggsartefakt ser båda ut som giltigt facit
efteråt.

1. Sätt appens inställning **`debug_level` = `full`** — annars loggas inga
   `[AIS_REPLAY_SAMPLE]`-rader och jsonl-filen blir TOM. `[REPLAY-VAKT]` larmar
   efter 2 min och skiljer sedan K24 på de två felen: `Inga
   [AIS_REPLAY_SAMPLE]-rader efter 2 minuter!` (fel `debug_level`) och `Loggen
   har N sampel men jsonl-filen är TOM!` (fångstvägen skriver inte) — förr sa
   vakten alltid det första.
2. `./run-with-logs.sh` — kör ~1 dygn. Live-loggen skrivs LOKALT
   (`~/.ais-tracker-logs/`, immunt mot OneDrive-synkstall — fältprov 4 tappade
   4 min loggrader när tee-röret skrev direkt i molnmappen) och synkas till
   `logs/` var 10:e minut + vid avslut. Ger `logs/app-*.log` +
   `logs/ais-replay-*.jsonl`.
   **Sedan K24 (2026-08-21) är loggen den ENDA strömmen och synken atomisk**
   (skrivning till temp + `mv`, aldrig `cp -f` som trunkerar målet först):
   jsonl:en HÄRLEDS ur loggen var 5:e minut och en sista gång i
   nedstängningen — som numera fångar Ctrl+C, `kill` och stängd terminal
   (`INT`/`TERM`/`HUP`), inte bara normalt avslut. jsonl ⊆ logg gäller därför
   per konstruktion, och filen kan alltid byggas om i efterhand:
   ```bash
   LC_ALL=C grep 'AIS_REPLAY_SAMPLE' app-<ts>.log \
     | sed 's/^.*AIS_REPLAY_SAMPLE\] //' > ny.jsonl
   ```
   Intervallet är MÄTT, inte valt på känsla: ombyggnaden är en full `grep`+`sed`
   över HELA loggen (~50 MB/s uppmätt), så var 60:e sekund kostade ~3,6 min
   CPU/dygn på en 15 MB-logg och ~29 min på en 70 MB-logg — på samma maskin som
   ska mata tee-röret, och det var just ett stallat rör som kostade fältprov 4
   fyra minuters loggrader. Priset för 300 s är enbart bekvämlighet: **bara ett
   hårdstopp som INTE går att trappa** (SIGKILL, strömavbrott) kan lämna jsonl:en
   upp till fem minuter efter loggen, och då är loggen ändå hel — kommandot ovan
   återställer facit. Vid Ctrl+C, `kill` och stängd terminal byggs filen om en
   sista gång innan skriptet dör.
3. **GRIND 1 — logg-integriteten.** Summaryn (`bridge-text-summary-*.md`) har
   sektionen "Logg-integritet (tidshål + replay-fångst)" med TVÅ delar och ett
   samlat verdikt:
   - **Tidshål** — luckor >180 s i loggens tidsstämplar (watchdogen skriver var
     ~90 s, så ett hål = tappade loggrader). Grönt:
     `✅ Inga tidshål >180 s — loggens tidslinje är obruten.`
   - **Replay-fångst (jsonl mot logg)** — undersektionen jämför antalet
     KOMPLETTA jsonl-rader mot antalet `[AIS_REPLAY_SAMPLE]`-rader i loggen och
     kontrollerar att filen slutar med radbrytning och att sista raden är ett
     helt JSON-objekt. Färre rader = tappat facit, fler = dubbelskrivning; båda
     fäller. (Innan K24 mätte grinden ENBART tidshål trots att den här körboken
     redan angav "jsonl:en saknar samples" som dess syfte — nattkörningen
     2026-08-19 hade obruten tidslinje men bar 99 av loggens 146 sampel.)

   **Vad grinden bevisar — och vad den INTE bevisar.** Sedan K24 härleds jsonl:en
   ur loggen och byggs om i förgrunden direkt före mätningen, så
   `jsonl-rader == loggens sampel` gäller i normalfallet per KONSTRUKTION. Den
   historiska trunkeringsvektorn (den blockbuffrade processubstitutionen) är
   alltså borta av design, inte av grinden — behåll ändå grinden som
   defence-in-depth, men läs den för vad den mäter:
   - **Fångar:** trasig extraktion (fel `debug_level` ⇒ noll `AIS_REPLAY_SAMPLE`
     i loggen; ändrad `grep`/`sed` ⇒ fel radantal), en avbruten slutkörning
     (ombyggnaden eller dess `mv` gick inte igenom), en avhuggen fil (sista
     raden saknar radbrytning eller är inte ett helt JSON-objekt) och
     dubbelskrivning (fler jsonl-rader än sampel).
   - **Fångar INTE:** att LOGGEN i sin tur fick appens sista rader. Tappar
     `tee` rörbuffertens svans vid en hård stopp förlorar logg OCH jsonl exakt
     samma svans — håldetektorn mäter luckor MELLAN rader, aldrig en kapad
     ände, och verdiktet blir grönt. Den säger heller ingenting om DATAT: att
     körningen har täckning, rätt källa eller stabilt utfall är steg 4:s och
     analysens sak, inte grindens.

   Sista raden i sektionen är verdiktet och det är det som gäller:
   `✅ **Logg-integritet: OK** … (korpuslåsning tillåten)` mot
   `🚨 **Logg-integritet: FEL** — körningen är OFULLSTÄNDIG: **korpuslåsning EJ
   tillåten**` (då skriker skriptet dessutom `🚨🚨 [INTEGRITET]` i terminalen).
   En fälld körning får analyseras som fältbevis — den får aldrig bli facit.
   Skriptet larmar också live om loggfilen slutar växa >3 min.

   Kontrollen är fristående och kan köras när som helst, utan fältrigg:
   ```bash
   node tests/replay-validation/checkReplayIntegrity.js <jsonl> [logg]
   node tests/replay-validation/checkReplayIntegrity.js --corpora      # alla filer i corpora-data/
   node tests/replay-validation/checkReplayIntegrity.js --dir <katalog>
   ```
   **`--dir` plockar bara upp korpuskandidater:** filtret kräver
   `ais-replay-*.jsonl` och hoppar över `*.appside.jsonl`. Appens EGEN fångstväg
   (`AIS_REPLAY_CAPTURE_FILE`, satt i `run-with-logs.sh`) skriver
   `ais-replay-<ts>.appside.jsonl` i SAMMA katalog; den filen är inget facit,
   men matchar både `.jsonl`-mönstret och tidsstämpelregexet och skulle annars
   paras mot `app-<ts>.log` och rapporteras som FEL fast den aldrig var en
   låsningskandidat. `--corpora` behåller det breda filtret — där är katalogen
   (`corpora-data/`) kontrollerad.

   Loggen paras ihop via filnamnets tidsstämpel, annars via sha256 (hel fil
   respektive aisstream-delen). Exitkod **0 = OK** (och **0 = DELVIS**, se
   nedan), **1 = FEL** (bekräftad avvikelse), **2 = anropsfel**, **3 = OKÄNT** —
   källoggen hittades inte, och då säger verktyget "källogg saknas" i stället
   för att gissa. **OKÄNT är inte grönt:** en jsonl utan parbar logg måste
   beläggas på annat sätt innan den låses.

   **DELVIS** (exitkod 0) betyder att den loggbara delen är komplett och
   byte-identisk, men att resten av filen inte GÅR att mäta mot loggen. Det
   gäller de härledda tvåkälliga korpusarna (`ais-fusion-*.jsonl`): aisstream-
   raderna finns som `[AIS_REPLAY_SAMPLE]` i loggen och jämförs rad för rad,
   medan aishub-raderna är parseade ur `[AISHUB_RESPONSE_SAMPLE]`-kuvert där ett
   svar bär många fartygsrader — ingen 1:1-relation, alltså inget att jämföra
   mot. Verdiktraden skriver ut exakt hur mycket som mätts, t.ex. `☑️ VERDIKT:
   DELVIS verifierad (aisstream-delen 371/371 mot logg; aishub-delen 1014 ej
   loggbar)`. Läs DELVIS som "så långt mätningen räcker" — inte som OK.

   Skalgrinden i `run-with-logs.sh` är den BINDANDE (den fungerar utan node);
   finns node körs `checkReplayIntegrity.js --brief` som tillägg och jämför
   dessutom rad för rad. Retroaktiv körning 2026-08-21: **alla 20 jsonl-filer
   i `corpora-data/` hela** (de 17 låsta korpusarna, den olåsta 42h-körningen och
   fusionsparet; 14 836 rader) — sammanfattningen lyder `20 filer — OK 19,
   DELVIS 1, FEL 0, OKÄNT 0, ANROPSFEL 0`, där DELVIS-filen är
   `ais-fusion-20260803-nattkorning.jsonl`. Ingen redan låst korpus har tagits
   in trunkerad.
4. **Analysera + GRIND 2 (fassvepet).** Jämför först loggens notiser/texter mot
   förväntat beteende och replaya jsonl:en:
   `node tests/replay-validation/replayRunner.js <jsonl>`.
   Kör sedan **fassvepet** (K20, fältprov 10): replayn ankrar klockan i
   korpusens FÖRSTA sampel (`replayRunner.js`), så starttiden avgör var varje
   tick faller. Svepet spelar upp samma korpus igen med ENBART starttiden
   förskjuten och jämför utfallen:
   ```bash
   npm run replay:phase                  # standardsvep: alla OLÅSTA korpusar i corpora.js
   npm run replay:phase -- <jsonl> [...] # en eller flera namngivna korpusfiler
   node tests/replay-validation/runPhaseSweep.js --help
   ```
   Utan argument sveper skriptet varje korpus i `corpora.js` som har
   `locked: false` — exakt de körningar som står näst i tur att låsas. Finns
   ingen olåst korpus kör det den MINSTA LÅSTA som självtest av grinden och
   säger det rakt ut. ⚠️ **Just därför är ett bart `npm run replay:phase`
   FÖRVÄNTAT rött** så länge `20260806-42h` är olåst och oavgjord (K20a, gula
   paketet): den bär 117 odokumenterade fasavvikelser (HEAD 480b78f mäter samma 117 — talet drev från 101 sedan K20a; skriptets egen utskrift är den aktuella siffran) i öppnings- och
   brotextdimensionerna. Rött är där en ärlig mätning, inte en trasig grind —
   men grinden ska av samma skäl ALDRIG läggas i `npm run validate`/CI, och
   rökprov körs mot en NAMNGIVEN korpus (`npm run replay:phase -- <jsonl>`). Flaggor: `--offsets=-20,-11.52,-5` (fasoffsets i SEKUNDER,
   decimaler ok; default `-2.5,-5,-11.52,-15,-20,-25`, kan också sättas med
   `PHASE_SWEEP_OFFSETS`), `--id=<korpus-id>` (nyckel för undantagsuppslagningen),
   `--exceptions=<fil>` och `--keep-temp`. **Exitkod 0 = grönt, 1 = fas-känsligt eller OMÄTT (ingen fasvariant kunde köras)
   utan dokumenterat undantag, 2 = anropsfel** (trasig flagga, saknad fil,
   ogiltig undantagsfil) — samma skala som steg 3, men utan OKÄNT-nivå: en
   variant som inte går att köra är ett HÅRT fel, och en offset som inte ryms i
   korpusens första gap rapporteras separat som "ej tillämpbar" och räknas
   aldrig som godkänd. **En körning där INGEN fasvariant kunde köras räknas som
   OMÄTT — rött, aldrig grönt** (samma anda som steg 3:s OKÄNT: en grind får
   inte döma på en mätning som uteblev). Det kan hända med egna, positiva
   offsets på en korpus vars första gap är kortare än offseten. Kostnad: ~1,2 s per replay på ett dygnsfältprov (hela
   svepet ~9 s), 19 s för den största korpusen (42 h, 3922 sampel).

   Varje variant är en TEMPORÄR kopia av korpusen där bara ankarraden är utbytt
   — `aisTimestamp`, `fixTs` OCH `receivedAt` skiftas lika mycket, så fixens
   ÅLDER bevaras och varianten blir en ren fasförskjutning (skiftas bara
   `aisTimestamp` mäter man fas och datafärskhet samtidigt). `receivedAt`
   skiftas med i fasvarianten trots att det är verifierat 2026-08-21 att
   replayvägen inte LÄSER fältet (app.js skriver det, ingen läsare finns) — det
   görs för renhetens skull, så att svepet inte blir tyst fel den dag
   leveranslatensen (`receivedAt − aisTimestamp`) börjar konsumeras. Fältet kan
   vara ISO-sträng i korpusarna; typen bevaras vid skiftet. **Korpusfilen rörs
   aldrig.** Grinden är definierad av vad den MÄTER, inte av skriptet: saknas
   skriptet i din checkout kör du samma sak för hand — flytta den TIDIGASTE
   `aisTimestamp` i jsonl:en (och `fixTs`/`receivedAt` på samma rad, om fälten
   finns) −5 s, −11,52 s respektive −20 s, exakt en ändrad rad per variant,
   replaya varje variant och jämför mot basreplayn.

   **Offsettecknet och RUTNÄTET.** Defaultoffsets är negativa därför att ett
   POSITIVT skift äter av korpusens första gap (en offset som inte ryms
   rapporteras "ej tillämpbar"). Ekvivalensen gäller ett rutnät i taget: mot
   **30 s-rutnätet** (watchdogen/öppningsticket, `BRIDGE_OPENING.TICK_INTERVAL_MS`)
   är `+δ` samma fas som `−(30−δ)`; mot **60 s-monitoringloopen**
   (`UI_CONSTANTS.MONITORING_INTERVAL_MS`) gäller i stället `−(60−δ)`. 60 s är
   en harmonisk av 30 s i PERIOD men inte i FAS, så +5 s täcks av −25 s på
   30 s-rutnätet och av −55 s på 60 s-loopen. Vill du täcka BÅDA: kör båda
   värdena (`--offsets=-25,-55`).

   **Grönt** = alla FYRA gatande dimensionerna är identiska i samtliga
   fasvarianter — notismultiseten (`mmsi:bro:riktning`, samma nyckel som
   `corpora-direction-distribution.json`), målbropassagerna (`mmsi:bro`),
   öppningsvarningarna (`Bro#n` → ledande/riktning/eta/källa) och
   **brotextmultiseten** (dedupad i följd) — ELLER varje avvikelse täcks av en
   post i `phase-sweep-exceptions.json`. Utfallet hänger då inte på var klockan
   råkade ankras och korpusen är säker att låsa. Två saker rapporteras men
   FÄLLER inte: notisernas ETA-token (`mmsi:bro:eta=<token>` — K20:s tredje
   utfall, inte en facitdimension men värd att se vandra) och brotexter som är
   samma multiset i annan ORDNING (tick-brus). Hårda fel som inte kan undantas:
   en variant som kraschar, en variant med fler processfel än basen, och en
   variant vars sampelantal skiljer sig från basens — då har skiftet ändrat mer
   än fasen.

   **Rött** = minst en gatande dimension byter värde mellan varianterna. Så såg
   19/8-korpusen ut: en 11,52-sekunders förskjutning bytte ledande båt,
   riktning och ETA i brons första öppningsvarning (fältet:
   TONGA/southbound/eta 8/deadline — basreplayn: BALTIC JONGLEUR/northbound/
   eta 11/fix), och ett notis-token vandrade 2 → 4 min på identiska data.
   Notisernas NYCKELmultiset och målbropassagerna var däremot exakt i alla
   varianter — samma signatur som på den olåsta 42h-korpusen, där alla 101
   avvikelser låg i öppningar och brotext. Pelare 2 är alltså fas-robust;
   öppningsmotorn och ETA-texten är knivseggarna.
   (⚠️ Svepet numrerar varningarna PER BRO — `Stridsbergsbron#1` är brons
   första varning. Appens eget `eventId` är en GLOBAL räknare och kallar samma
   varning `Stridsbergsbron#2`; det id:t skrivs ut som `[app-id …]` på varje
   diffrad så den går att grepa fram i apploggen. **Ett undantag skrivs mot
   svepets ordningsnyckel, inte mot app-id:t.**)

   Rött stoppar inte låsningen automatiskt — men det tvingar fram ett val, och
   valet ska stå skrivet:
   - **Antingen** bevisa i rådata vilket utfall som är sant (fältets EGEN logg
     är facit — fasvarianten som återger fältet exakt visar att fältutfallet låg
     på en knivsegg, inte att replayn har fel) och låsa den dimensionen därefter;
   - **eller** dokumentera den fas-känsliga dimensionen som ett känt undantag.
     **Undantaget ska in i `tests/replay-validation/phase-sweep-exceptions.json`
     — det är den ENDA fil som gör GRINDEN grön.** (`note`,
     `knownInvariantExceptions` och `lockOpenings: false` i `corpora.js` styr
     korpuskörningen och är fortfarande rätt ställe för invariantsträngar
     respektive en vippande öppningsdimension, men de påverkar inte fassvepets
     exitkod — utan en post här är `npm run replay:phase` rött för alltid och
     nästa läsare tror att korpusen är otillåten att låsa.) Formen:
     ```json
     { "<korpus-id eller jsonl-filnamn>": {
         "oppningar": [ { "utfall": "Stridsbergsbron#1",
                          "motivering": "K20: ledande båt väljs på armavstånd av olika ålder …",
                          "datum": "2026-08-21" } ] } }
     ```
     `utfall` matchas som PREFIX mot avvikelsens nyckel (samma konvention som
     `knownInvariantExceptions`); `"*"` matchar hela dimensionen. `motivering`
     (minst 10 tecken) och `datum` är OBLIGATORISKA — saknas de vägrar skriptet
     köra (exit 2), eftersom ett omotiverat undantag är en tyst avstängd grind.
     En post som inte längre matchar rapporteras som `⚠️ OANVÄNT UNDANTAG` och
     ska städas bort. Namnge alltid fartyg, bro, dimension och vilka fasvärden
     som växlar utfallet, och skriv samma sak i korpusens `note` — noter är
     permanent minne (se avsnittet ovan). Gäller känsligheten bara
     öppningsdimensionen kan korpusen dessutom låsas med `lockOpenings: false`
     tills den underliggande defekten är åtgärdad (K20:s produktdel: ledande båt
     väljs på armavstånd av olika ålder mitt i pollbatchen) — fältet är ALLTID
     tillfälligt och noten ska namnge vilken fix som tar bort det.
5. Lås som korpus (KRÄVER `Logg-integritet: OK` från steg 3 OCH ett grönt eller
   skriftligt motiverat fassvep från steg 4): post i `corpora.js` (id,
   jsonl-sökväg, timmar, facit-antal, locked: true, motiveringskommentar) +
   fördelningsmultiset i `corpora-distribution.json` (genereras från en
   verifierad körning).

## Kända fällor för den som skriver nya tester

- **`sweepStaleVessels` (K18 del 2) ligger UTANFÖR allt replay-facit — medvetet
  dirigentbeslut 2026-08-22.** Svepet drivs av `_setupMonitoring`-loopen i app.js,
  som returnerar tidigt i testläge (`__TEST_MODE__`), så ingen av de 17 låsta
  korpusarna, öppningsgrindarna, fassvepet eller syntetiken kan någonsin fälla en
  regression där. Enhetstesterna i `tests/k18-stale-sweep.test.js` bär hela
  bevisbördan, och varje framtida ändring av svepet kräver egna enhetstester +
  ett fältdygn. Alternativet (att låta replayRunner driva svepet) skulle flytta
  borttagningar 4–6 min tidigare i flera korpusar och är därför en EGEN
  omlåsning om den någonsin görs — smyg aldrig in den i en annan batch.


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
- **Riktnings-token-fällan (F5, 2026-08-21):** appen har TVÅ
  riktningsvokabulärer — interna ord (`northbound`/`southbound`/`unknown`/
  `mixed`) i all logik, svenska (`norrut`/`söderut`/`okänd`/`båda`) i
  Flow-tokenen. **En ny notisväg ska hämta riktningen med
  `_getNotificationDirection` och ALLTID passera `toUserDirection`
  (`lib/utils/directionTokens.js`) innan värdet läggs i en token** — det är
  den enda översättningspunkten, och ett kringgående läcker antingen ett
  engelskt ord i användarens Flow eller ett svenskt ord i en facitnyckel.
  Assertera i testet på ANVÄNDARvärdet (`toBe('norrut')`), aldrig på det
  interna. Motsatt håll gäller lika hårt: persistenta dedup-nycklar
  (`bro|mmsi|riktning`, boat_near-dedupens `{t, dir}`) och varje intern
  jämförelse ska STÅ KVAR på interna ord — de lever i `homey.settings` över
  omstarter. Harnessen översätter tillbaka i riktningsadaptern
  (`replayRunner.js:83–99`), så facitfilerna är och förblir interna; se
  ARCHITECTURE.md §Riktningsvokabulären.

## Coverage-spärren

`npm run test:coverage` (pipa!). Trösklarna i `tests/jest.config.js` är ett
GOLV som aldrig sänks — höj dem när ny täckning landat.

## Omlåsning av golden-text: relockGoldenText

`node tests/replay-validation/relockGoldenText.js <korpusId...>` är den ENDA
sanktionerade vägen att skriva om golden-text för redan låsta korpusar
(tillkom 2026-08-10; ersätter sessionsberoende engångsskript). Verktyget kör
replayn per korpus och skriver golden ENDAST om ALLA övriga dimensioner är
exakta: processfel 0, fartygsläcka 0, notisantal, fördelnings-/riktnings-/
öppningsmultiset (samma fält och form som runAllCorpora), och varje fatalt
invariantutslag prefixmatchar korpusens `knownInvariantExceptions`.
Validering och skrivning är TVÅ faser — en abort lämnar aldrig facit
halvskrivet. Nya korpusar bootstrappas fortfarande via REGEN_DISTRIBUTIONS=1
från grön körning — relockGoldenText vägrar korpusar utan befintliga poster.

**Dirigentläxan (2026-08-10):** LCS-diffa gamla mot nya goldens SJÄLV innan
omlåsning och skriv noten mot den FAKTISKA diffen (antal borttagna/tillagda
med livslängder, tidsskift, systematisk kostnad) — implementatörens
diffsammanfattning är otillräcklig som enda underlag (CRITICAL-fyndet i
adversariella granskningen 2026-08-10: selektiva noter på 7 korpusar).


## Tillägg 2026-08-23 (helkodsgranskning runda 4, fixrunda 4/4b/4c)

- **INV-14W (WARN):** INV-14 fäller bara inklämda DEFAULT-episoder ≤ 300 s; längre spann
  rapporteras nu som WARN-klassen INV-14W (spannlängd + bro) i stället för att tystas
  (M24). `runAllCorpora` varnar även för OANVÄNDA `knownInvariantExceptions`.
- **Syntetiska scenarier — känd WARN-baslinje är 8** (5 gamla + 3 INV-14W:
  navstatus-flap-väntare 540 s, ankrad gles sändare 1440 s, återfödd-i-kö HERA-klassen
  900 s). Fler än 8 = rapportera.
- **O1:s missklassificerare (`classifyMiss`)** kräver nu KORROBORERAT rörelsebevis i tre
  led (position ≥ MOVEMENT_PROOF_NET_M från första horisontsampel; etablerad stillhets-
  vistelse ≥ ARM_STALE_TTL_MS inom 50 m + tätt fixpar med implicerad fart < 0,5 kn ⇒
  sog-spikar är jitter; korroborering ur `lib/utils/quayTransitProof.js` som även
  app.js och O2 använder). Bevissträngen skriver "etablerad stillhetsvistelse …" resp.
  "korroborerad av egen förflyttning". Grönheten för CARAT (both-21h) vilar på
  vistelseledet — en grindregel produkten inte har; ompröva vid nästa korpustillskott.
- **Batteri:** steg 8 ska köra det NAMNGIVNA rökprovet (minsta låsta korpus); ett bart
  `npm run replay:phase` är dokumenterat rött (117 avvikelser, HEAD lika) tills 42h låses.
- **Mäthygien:** ARM-jämförelser görs i TVÅ isolerade träd (git archive HEAD resp. rsync
  av arbetsträdet); påståendet "HEAD var redan röd" ska styrkas med loggfil från HEAD-trädet.
