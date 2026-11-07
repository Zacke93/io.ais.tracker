# VALIDERINGSKÖRBOK — så vet du att appen fortfarande är korrekt

Skriven 2026-07-06 (helgranskningens teststärkning). Detta är den praktiska
handboken för att köra, tolka och underhålla valideringsbatteriet — utformad
för att fungera utan att någon minns historiken. Arkitekturen står i
`ARCHITECTURE.md`; textformatet i `bridgeTextFormat.md`.

Aktuellt inför fältprov 2026-09-09: bankens 20 körningar är låsta i text,
närnotiser och öppningar. Sju har dessutom fulla händelsereferenser
(`golden-events/`): tid, bro, riktning, ETA, text, källa och öppningsmedlemmar.
Det omfattar AKIRA, KNIGHT OWL/CALIMA, IDUN, CARAT samt de tre senaste
låsta fältkörningarna. Tidigare undantag för CARAT-korpusens öppningar är borttaget.
UI-uppdateringarna följer nu fasta halvminuter och utgången konvojtäckning
schemaläggs vid sin egen sluttid. PHOENIX fasundantag är borttaget; samma
AIS-glapp ska ge samma text i alla startfaser. Alla 20 körningar har klarat
sex ändrade startlägen både med och utan monitoring. 42-timmarskörningens
UTOPIA-fall har ett exakt rådatabelagt invariantundantag: 25-minutersgränsen
löper ut före nästa mottagna position. Ett separat test vaktar båda sidor
om tidsgränsen; AIS-tysta båtar visas inte längre för att göra testet grönt.
Kompletterande AISHub-råposter i `passage-evidence/` kan snäva oberoende
passagefönster; de ändrar aldrig appens replayindata eller uppfinner en
exakt passagetid. Källhashar och observationstider kontrolleras separat.

Stallbackas passagebevis och prognosens återstående rutt testas separat:
en färsk återkomst efter AIS-glapp får rätt avstånd utan ärvd passage.
GPS-hopp, råklockor, tre timmars färsk kö och byte av närmaste bro har egna
motprov. Det exakta EUGENIE→ANTJE-undantaget gäller ett verkligt ledarbyte
när den gamla prognosen åldras ut; andra minuthopp är fortfarande fällande.
Strikt rådatakontroll har 21 historiska tidsordningar som inte kan avgöras
med sparade positioner. De är inte säkert verifierade genom en låst replay.

Ett blandat öppningskort presenterar endast ännu inte varnade ankomster.
Fryst medlemsunderlag ger rätt ledare, antal, riktning och ETA; intern
konvojtäckning och deadlines bevaras. ANYA/ANTJE samt FILOU/MS JUTLAND och
MARY/DORY MAN är granskade och låsta i de fulla händelsereferenserna.
Fältjämförelsen läser även verkliga leveransloggar med `eta=okänd`.

Nya fältprov fångar icke-hemligt startminne i `AIS_REPLAY_STATE` och en separat
`ais-replay-<tid>.state.json`. Replay läser den automatiskt bredvid AIS-filen,
alternativt via `REPLAY_INITIAL_STATE`. Fasvarianter behåller samma minne.
API-nycklar och konton ingår inte. Äldre inspelningar saknar startminnet:
deras referenser bygger på granskad replay från tomt minne. En låst referens
är ett regressionsskydd, inte ett bevis på faktisk telefonleverans.

## De två pelarna (vad allt vaktar)

1. **bridge_text** är alltid korrekt och aktuell — aldrig spöktext, frusen
   nedräkning eller falskt "Inga båtar".
2. **boat_near** avfyras en gång per sammanhängande besök för varje båt och
   punkt. Stopp eller väntan inom samma område ger ingen extra notis;
   observerad utfärd och återkomst tillåter en ny. Gäller alla sex punkter.
   Vid en bro gäller dessutom en notis per passage (U14, användarbeslut
   2026-11-04): en verklig passage TILLBAKA, som appen själv bokför och som
   positionen bevisar (båten tydligt ute på ankomstsidan och under gång dit),
   avslutar besöket och får en egen notis även om båten aldrig lämnat området.
   En båt som vänder och sedan väntar nära linjen får ingen extra notis, inte
   heller vid gles AIS eller när hennes AIS rapporterar 0,5–1 kn, så länge
   GPS-bruset håller sig inom appens brusmodell (två stilla fixar under 60 m
   isär). En returnotis som skulle komma mer än 10 min efter den uppskattade
   korsningen skickas inte (U21).

## Batteriet — kör ALLTID allt efter varje ändring i status-/notis-/text-/livscykellogik

```bash
npm run validate          # jest + korpusar + syntetiska scenarier + öppningsgrindarna (~3 min)
npm run validate:full     # ovan + 72h-soak utan/med monitoring — före commit/publicering
```

Eller stegen var för sig:

| Steg | Kommando | Grönt betyder |
|---|---|---|
| Enhetstester | `npm test > /tmp/ais-jest.log 2>&1` (läs sedan slutraderna) | Alla tester passerar, exitkod 0 och inga öppna handtag. Aktuellt antal står i körningens sammanfattning. Omdirigeringen bevarar Jest:s exitkod; en pipe till `tail` gör inte det. |
| Korpusarna | `npm run replay:all` | Samtliga korpusar (aktuellt antal och timmar står i skriptets utskrift) ger EXAKT facit-antal notiser + exakt (mmsi,bro)-fördelning + exakt (mmsi,bro,riktning)-fördelning + EXAKT bridge_text-transitionsström (golden-text/) + alla invarianter. Ofullständig fångst redovisas separat och får bara utgöra regression för bevarade sampel. |
| Syntetiska | `npm run replay:synthetic` | 74 scenarier (gap, U-svängar även med gles AIS, GPS-hopp, kajliggare, sog=null, omstart, 2h-prune-stillaliggare, krypfart förbi passerad bro …) håller sina kontrakt. OBS: "rena" = inga FATALA utslag; WARN-invarianter (t.ex. INV-18) är informativa och fäller inte. Se §Syntetiska scenarier nedan för omstartsscenariots särskilda placeringskrav. |
| Öppningsgrindarna | `npm run replay:openings` | ETAPP 6: det proaktiva lagret (`bridge_opening_soon`). **O1** varje målbropassage i SAMTLIGA korpusar (låsta som olåsta — antalet står i skriptets utskrift, inte här) har en öppningsvarning FÖRE passagen — varje miss klassad mot rådata (oklassad = rött); en KONVOJTÄCKNING underkänns om bron bevisligen öppnat och stängt för någon annan emellan. **O2** varje varning utan passage inom 20 min klassas mot rådata (KAJVOBBEL och UTANFÖR_HORISONTEN = rött; avbruten approach, gles anflygning och garantipris = accepterade) — även SEN_PASSAGE-hinken klassas. **O2b** (S14, 2026-08-23) SAMMA fantommätning mot RÅDATAFACIT (A2, `gt-passages`) i stället för appens egna passager — O1b:s mönster: appens passageregistreringar delar grindarnas blindfläck, så en varning kan kallas BEKRÄFTAD av appens egen bokföring medan rådatan inte känner korsningen. Serierna redovisas BREDVID varandra (annars går körningsloggar inte att jämföra bakåt). `inferred`-poster (korsning bevisad, tidpunkt = fönster) bär ALDRIG hinkindelningen utan hamnar i egen hink INFERRERAD_TID — hinkarna ÄR en tidsfönstermätning. **O2b är INFORMATIV: den ändrar inte exitkoden** (grinden ligger kvar på appserien precis som O1:s täckning i fas A); `OPENING_GT_STRICT` flyttar den hit när fas C är klar. Vid införandet: 0 röda i BÅDA serierna, 118 av 360 varningar byter hink (98 blir omätbara `inferred`) och EN varning byter åt det farliga hållet (JAATTEN II @ Stridsbergsbron i 20260708-21h — samma fall INV-21 redan fäller). **O3** A/B-nattens båda armar: 6/6 öppningar varnade före, konvojen som EN varning, boat_near byte-identisk med nattens facit. Dessutom **avfyrningsfönstret** (`t − dueMs` inom två tick — kontraktet "avfyra så sent som garantin tillåter") och **ledtidsgolvet** (hårt golv 60 s; tunnare än utlovade 150 s rapporteras). |
| Soaken | `node tests/replay-validation/runSoak.js` | 72 h blandtrafik: 0 processfel, inga läckor, fatala invarianter rena |
| Driftens minutloop | `npm run replay:monitoring` | Samma 72 h med riktig monitoring/stale-städning även efter omstarter; samtliga timers avvecklade efter shutdown |
| Lint | `npm run lint` | 0 fel |

**Rör ändringen ETA-vägen?** Då räcker inte batteriet: facit säger bara att
texten är OFÖRÄNDRAD, inte att siffran är SANN. Mät med `npm run measure:eta`
mot baslinjen — se §ETA-mätharnessen, och läs ARCHITECTURE §8 (e) K6 först.

**Monitoring i replay (2026-09-06).** Standardkörningen behåller sin
etablerade timeruppsättning. `REPLAY_MONITORING=1` startar dessutom den
riktiga minutloopen efter init och efter varje `ctrl:restart`, vilket mäter
TTL-städning och `sweepStaleVessels` i driftens ordning. Det fungerar även
med `replay:field`; jämför utfallet separat från standardens facit.
`runtimeDiagnostics` visar att loopen verkligen startat/körts och antalet
timers efter varje omstart och avslut. Slutstädningsfel räknas som processfel.
Källorna är oanslutna testklienter: läget mäter inte nätkontakt eller
källhälsa. De kontrolleras av klient-/hälso-/sockettesterna och fältprovet.

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

**Fassvepet ska hålla även när starttiden ändras.** Standardsvepet tar de
olåsta korpusarna och, när alla är låsta, hela banken. Namngivna filer prövas med
`npm run replay:phase -- <jsonl> [...]`. Kör även med `REPLAY_MONITORING=1`
vid ändrad tidsstyrning. Ett rött utfall ska undersökas mot rådata; facit
eller undantag får inte ändras enbart för att göra grinden grön.

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
   rotorsaksanalys ligger kvar i det externa arkivet `../logs/` (på Macen:
   repots git-ignorerade `dirigent/logs/` — en mapp per repo sedan
   2026-09-01; harnessen provar båda). Ny korpus:
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
   rådataverifierad beteendeändring kan en bank utan ofullständiga fångster
   regenereras med `REGEN_DISTRIBUTIONS=1 npm run replay:all`. Skriptet
   vägrar skriva om någon låst korpus inte är grön i övrigt, och du MÅSTE
   granska diffen i golden-filerna som vilken facit-omlåsning som helst
   (git diff visar exakt vilka texter som ändrats).

   **Upptäckt ofullständig fångst efter låsning (2026-10-05).**
   `20260917-7h` har `captureIntegrity: 'incomplete'`: ett loggblock och minst
   en AISHub-fix saknas. Dess gamla assertions ligger kvar som strikt
   regression för de bevarade sampeln; körningen är inte komplett fältfacit.
   `replay:all` visar detta uttryckligen. Samlad `REGEN_DISTRIBUTIONS=1`
   avbryts innan någon skrivning om banken innehåller en sådan korpus.
   `relockGoldenText.js <id>` kan fortfarande omlåsa andra, verifierade
   korpusar, men avvisar den ofullständiga. Att låsa upp korpusen för att
   tysta dess regressioner är inte en reparation av fångsten.

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
   upptäckas av någon gate. Befintliga referenser skrivs i SAMMA regen-svep
   och med samma villkor som ovan: `REGEN_DISTRIBUTIONS=1 npm run replay:all`.
   En ny korpus får enbart sin nya id-post genom den riktade nyregistreringen
   nedan. Räkna alltid multiseten från verifierade replayhändelser; skriv inte
   manuellt valda antal. Saknas filen skriver `replay:all` en högljudd rad;
   saknas en LÅST korpus i den är det ett hårt fel.

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
grammatik (INV-1), notisdubbletter/tokens (INV-2; sedan U14 även
FALSKT RETURSLÄPP, när ett returpassagesläpp följs av att båten lämnar bron på
bortre sidan enligt replayRunnerns geometriska dom ur rådatan, och sedan
omgranskningen 2026-11-05 FÖR TIDIGT RETURSLÄPP, när båten varken vid släppet,
i nästa fix eller inom 60 s ligger entydigt på ankomstsidan, eller sedan
omgranskning 2 (2026-11-07) inte stannar där: färre än hälften av fixarna efter
släppet, nästa fix och 60 s-fönstret, ligger entydigt på ankomstsidan; domen
står i `tests/replay-validation/returnReleaseVerdict.js`), **räkningsbaserade INV-5/7**
(varje registrerad målbropassage kräver sin EGEN notis i tid — även
returpassagen av samma bro; sedan U14, 2026-11-04, är det appens kontrakt och
inte längre i konflikt med besöksregeln), sluttext (INV-6), namn (INV-8), distans (INV-11),
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

**Rutnätet bestämmer var en vändning syns.** Generatorn lägger samplen på ett fast
rutnät från ruttens start (s = k · fart · intervall) och vänder på första samplet
efter `uTurnAtFraction`. Returens sampel hamnar därför på samma platser som
utresans. `u-sväng-gles-ais-återkorsning-i-debouncen` (R1, rättningskampanjen
2026-11-04) behöver en vändfix mer än 500 m norr om Klaffbron och en
bekräftelsefix söder om bron. Det ger 7 kn och 240 s: vändfixen hamnar 592 m norr
om bron och bekräftelsen 273 m söder om den. Scenariot dömer med
`minPassagesPerBridge`, som räknar mål- och mellanbropassager tillsammans, eftersom
returen bokförs som mållös mellanbropassage. Mot `7699cbe` fälls det med
"bokförda passager av Klaffbron 1 < förväntade 2".

`u-sväng-långsam-återkorsning-efter-väntan` (R1, granskningen 2026-11-04) är samma
tur och retur, men fixet som avslutar returens korsningssegment är långsamt
(1,5 kn). Utresans rutnät får inte flyttas, så den långsamma zonen gäller bara
returbenet (`slowZone.afterUTurnOnly`). 6,5 kn och 210 s ger vändfixen 646 m
förbi Klaffbron längs rutten och returens första sampel 54 m söder om Klaffbron,
inne i zonen (56 m före bron längs den nordgående ruttkoordinaten; på den
sydgående returen är bron alltså redan korsad). Positionsbevisets kedja har då
bara ett ben, så det är Fix D:s väntan som bär rörelsebeviset. Väntan sattes på
segmentets startfix (vändfixen), korsningsfixet går i 1,5 kn och segmentets
nettofart är 6,5 kn, så scenariot uppfyller också den avsmalnade regeln efter
omgranskningen (`VesselDataService._slowReCrossEvidence`). Scenariot fälls både
mot `7699cbe` och mot R1:s första prototyp (`34c2b57`).

**Varje passage ska ha sin egen förvarning (U15, 2026-11-04).**
`expectedOpenings` prövar bara brons FÖRSTA passage och kan därför inte se en
ovarnad returresa. `openingBeforeEachPassage: [bro]` kräver en varning efter
båtens förra passage av samma bro och före varje ny, och varningen måste
täcka just den båten: hon är medlem eller ledare i den, eller absorberades i
dess händelse (`openingCoverage`) mellan passagerna. En annan båts varning
vid samma bro räcker alltså inte. Scenariot
`u-sväng-bortom-Stridsbergsbron (B02-returresan)` vänder 880 m bortom bron,
inom konvojfönstret räknat från utresan; på 7699cbe är det rött (returen
06:31:00 saknar varning), med U15-rättningen grönt. Samma kontroll ligger på
`u-sväng-efter-Klaffbron` och `u-sväng-gles-ais-norr-om-Klaffbron`, som båda
är röda på 7699cbe (returerna 06:30:00 och 06:27:00 absorberades i utresans
händelse) och gröna med rättningen.

**Krypfartsscenarierna (familj M, rättningskampanjen 2026-11-04, F05) prövar
närmandebeviset och fartgrinden i båda vägarna.** Placeringen är testet i alla sex.
- `krypfart-förbi-passerad-Klaffbron`, `krypfart-förbi-passerad-Järnvägsbron-söderut`
  och `lång-krypfart-Klaffbron-till-Järnvägsbron` prövar RETENTIONEN: 0,45 kn med
  30 s kadens, ≈ 7 m per fix. Zonen måste ligga där skyddszonen inte håller
  målbron, alltså inom 300 m från en PASSERAD bro (F21:s bypass) eller 300–500 m
  från närmaste bro. Målbron måste ligga mer än 300 m bort, annars prövas inte
  2-READINGS. Farten (generatorns brus ±0,1 kn) ska ligga över ANCHOR_BLOCK:s
  0,3 kn, annars är det FIX B som prövas. Mot `7699cbe` fälls de med INV-14
  DEFAULT-FLASH (5, 6 och 16 utslag).
- `krypfart-söder-om-Olidebron-ej-passerad` och
  `sog-null-stopp-norr-om-passerade-Klaffbron` prövar ÅTERINTRÄDET, där
  ANCHOR_BLOCK inte gäller: en krypare i 0,12 kn som inte passerat någon bro
  (300–500 m söder om Olidebron, utanför skyddszonen och norr om
  Kanalinfarten-punkten) respektive en båt utan fartgivare som stannar 60 m norr
  om passerade Klaffbron i 20 min. Mot `7699cbe` och mot den första prototypen
  (`9c802ed`) fälls de med 5 respektive 7 DEFAULT-FLASH. Med rättningen är båten
  dold tills hon gör väg, och varje scenario har därför EN förväntad INV-14W
  (lång "Inga båtar"-period, informativ) — samma klass som `ankrad-gles-sändare`
  och `återfödd-i-kö`.
- `fartgrind-krypare-söder-om-Stallbackabron` (revision 3, granskarens klass H)
  prövar återinträdets FARTPROV: 0,65 kn söderut 560–1650 m söder om
  Stallbackabron, alltså mer än 500 m från VARJE bro, där tilldelningen kräver
  > 0,7 kn. Generatorns fartbrus lägger fixar över 0,7 kn; retentionen tar bort
  målbron först när grinden fallerat i mer än nådafristen, och samma bro läggs
  tillbaka först när grinden HÅLLIT lika länge. Mot `7699cbe` 9 DEFAULT-FLASH
  (7–12 över seed 94–99) och mot revision 1 (`c6a765d`) 8. Med rättningen EN
  förväntad INV-14W (2550 s). Ligger zonen inom 500 m från en bro prövas
  0,1 kn-grinden i stället, och scenariot blir verkningslöst.

**U14 (2026-11-04): returpassagen inom besöket.** `u-sväng-inom-besöket-vid-Klaffbron (B01)`
vänder 200 m bortom Klaffbron, alltså innanför besökets utfärdsgräns (två fixar
över 350 m). Buggjägaren mätte felet i bandet 125–308 m; bortom 350 m tar
utfärdsregeln fallet, och scenariot `u-sväng-efter-Klaffbron` vänder 517 m bortom
bron. Förväntan `minNotifiedPerBridge` kräver två Klaffbronotiser och
`maxNotifiedPerBridge` högst två. Motvakten `guppar-på-Klaffbrons-linje (U14-vakt)`
står still på linjen i 40 min med GPS-brus på båda sidor och ska ha EN
Klaffbronotis. På 7699cbe fäller B01-scenariot (en notis, INV-5), medan
vakten är grön i båda versionerna.

Granskningen samma dag lade till sex vakter och två returer. **Vänd och vänta**
(`vänder-och-väntar-…-från-Klaffbron-brus-… (U14-vakt)`, fem varianter D = 5–30 m från
linjen och brus J = 10–30 m, samt en med gles AIS): båten passerar Klaffbron, vänder 150 m
bortom bron, väntar 30 min D m från linjen med slumpad kurs och kör sedan vidare. EN
Klaffbronotis krävs. Förra U14-prototypen gav 2–3. Passagelogiken bokför ibland en falsk
passage när bruset för båten till linjen. Det ger INV-5 exakt som på 7699cbe, och scenariot
tål just den raden med den nya förväntan `toleratedInvariants`, eftersom felet ligger i
passagelogiken och vakten bara prövar notisen. **Retur över två broar i samma glapp**
(`retur-över-två-broar-i-samma-glapp-Stridsbergsbron/-Klaffbron (U14-M1/M2)`): båda broarna
bokförs i samma tick, och returnotisen krävs för båda (`minNotifiedPerBridge`). Båda fäller på
7699cbe och på förra prototypen. Scenarierna använder generatorns benläge (`legs` i
`scenarioGenerator.js`), som uttrycker förlopp med flera vändningar och stopp.

Omgranskningen 2026-11-05 lade till fem vakter. **Vänd, bromsa in och vänta med gles AIS**
(`vänder-bromsar-väntar-…-gles-…-ge-upp/-retur (U14-vakt)`, kadens 35 + 0–10 s och 45 + 0–15 s
via benets nya `intervalJitterS`): båten bromsar till 1 kn och stannar 3–6 m från linjen i
15 min. `ge-upp` fortsätter sedan bort (EN Klaffbronotis krävs), `retur` går tillbaka genom
bron (TVÅ krävs, och INV-2 fäller ett för tidigt släpp). Förra revisionen gav en falsk andra
notis respektive en 16–17 min för tidig; 7699cbe missar returen. Passagelogikens bokföring vid
ankomsten till linjen ger INV-5 i `ge-upp`, som på 7699cbe. I `retur` ger 7699cbe INV-5 MISSAD;
med U14 kommer notisen vid den verkliga korsningen, och INV-7 (SEN) för passage nr 2 uppstår
eftersom INV-7 mäter mot bokföringen före korsningen. Vakterna tål just de raderna. **Långsam
retur** (`långsam-retur-1kn-genom-Klaffbron (U14-vakt)`): returen i 1 kn bokförs före linjen och
är 30 m ut först efter mer än 60 s. Den fäller på 7699cbe och på förra revisionen.

Omgranskning 2 (2026-11-07) lade till fyra vakter. **Väntan med rapporterad fart**
(`vänder-bromsar-väntar-6m-gles-…-i-…kn-brus-15m-ge-upp/-retur (U14-vakt)`, benets nya
`stopSog`): den väntande båtens AIS rapporterar 0,6–1 kn med slumpad kurs och bruset är ±15 m.
Revision 3 släppte på en enda gles fix entydigt på ankomstsidan och gav en falsk andra notis
(FALSKT RETURSLÄPP); `retur` prövar att den verkliga returen efter samma väntan får sin notis.
**Tät AIS med ±30 m brus** (`vänder-bromsar-väntar-3m-tät-10s-i-1kn-brus-30m-ge-upp (U14-vakt)`):
två fixar i rad på ankomstsidan där den förra låg vid linjen. Bruset ligger delvis utanför appens
brusmodell, och klassen har en uppmätt rest (registrerad som känd gräns); vakten håller fast det
fall som revision 4 stänger. Fröna kommer ur ett svep med appens egen generator (144 + 48 banor).
Alla tre `ge-upp`-vakterna fäller revision 3.

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

Aktuell utpekning (2026-09-09): brotext mäts mot textmotorns faktiska
ledarval och returtext vid publiceringens exakta tid. Tidigare rekonstruktion
ur ETA-loggar kunde välja fel båt efter extrapolering; 105 MMSI-val rättas
i banken. Alla 1 862 numeriska textfraser har direkt renderingsbevis.
196 gruppstyrda "strax" hålls omätta eftersom en annan gruppmedlems närhet
kan styra formuleringen. Mätfångsten ger identiska appresultat i alla 20
korpusar (endast varierande `heapUsedMB` undantas), med 17 egna tester i
`tests/eta-accuracy-rendered.test.js`. Historiska mätningar nedan använder
den äldre utpekningen och är inte direkt jämförbara med den rättade mätaren.

**HISTORISK BASLINJE — HEAD `a451f75`, 2026-08-22, 17 låsta korpusar (~330 h):**

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

### Familj E (rättningskampanjen 2026-11-04): avgångskontexten mätt enligt REGELN

Ändringen: `ProgressiveETACalculator` räknar inte längre avgångs-ETA på
igångsättningsfarten efter belagd stillhet. Väntans sampel lämnar
fartbufferten, och farten räknas på ett golv som följer den uppmätta
accelerationen ett sampel framåt (dubbla igångsättningsfarten, därefter
senaste farten plus senaste ökningen, högst 4 kn). Antagandet släpps mjukt när
farten slutar stiga. ARCHITECTURE §8 (e), "Avgångskontexten gick in", har
villkoren. Två granskningar formade det, och den andra mätte platåklassen
nedan.

**Banken.** Baslinje (7699cbe) och efter-körning med samma 24 korpusar, parning
per korpus, typ, bro och mmsi inom 2 s:

| Band | Population | Före (7699cbe) | Efter |
|---|---|---|---|
| sanning < 5 min, alla typer | parad, n = 784 | median 0,47 · 88,9 % ≤ 2 · bias +0,51 | median 0,46 · 89,7 % · bias +0,49 |
| sanning < 10 min, alla typer | parad, n = 1 295 | median 0,71 · 81,2 % · bias +0,18 | median 0,70 · 81,6 % · bias +0,17 |
| båda banden | oparad | n = 0 | n = 0 |

Sex parade påståenden ändras, och alla kommer närmare rådatafacit:
- SKONNERTEN JYLLANDs text, 8 → 3 mot sanning 2,1;
- PRIMA LADYs text, 7 → 4 mot 3,1;
- PRIMA LADYs notis och kort, 5 → 3 mot 1,9;
- OLAs notis och kort, 4 → 1 mot 1,3.

Inget påstående blir sämre. SKONNERTENs notis 07:30:52 i 20260601-41h är 2,
som på 7699cbe. Första revisionen gav 3 mot sanning 1,4, eftersom EMA:n räknade
från ett M9-hållet 3,0. V4-principen (ARCHITECTURE §8 (e)) låter EMA:n räkna
från det ohållna värdet när samplets egen mätning lovar strax, och de två
M9-raderna i tabellen över återtagna varianter nedan visar mätningen.
Brotextövergångarna (2 544) och strax-löftet (n 211, 63,0 % ≤ 3 min) är
oförändrade.

**Platåklassen (andra granskningen).** Banken har bara nio avgångar efter belagd
stillhet, så klassen mättes syntetiskt:
- *Geometri:* scenarioGeneratorns kanal. Väntan 480 och 360 m söder om
  Klaffbron (mål Klaffbron), 120 m söder om Olidebron (mål Klaffbron, 1,5 km)
  och 200 m söder om Järnvägsbron (mål Stridsbergsbron).
- *Platåprofiler (18):* igångsättning från 1,0–1,5 kn som planar ut på 2,0,
  2,5, 3,0 eller 3,5 kn, i långsam, medel och snabb ramp, med jämn fart redan
  från första samplet, och två med fartbrus.
- *Kontrollklassen (5 profiler):* F04-klassen, som når 4–6 kn (bland annat
  ALVA:s 1,6 → 4,0 → 4,4 → 5,0 → 7,4 kn).
- *AIS-takt:* var 30:e och var 60:e sekund.
- *Sanning:* linjekorsningen i den genererade geometrin.
- *Tidsviktat mått:* visad text var 10:e sekund från avgång till korsning.
  Det är REGELNs punkt 5: ett värde som står kvar länge väger mer.
- *Uppsteg:* ett minuttal som går upp efter avgången, inklusive steget från
  väntans prognos.

| Klass | Mått | 7699cbe | Fast golv 4 kn (första revisionen) | Golvet följer accelerationen |
|---|---|---|---|---|
| platå (144 fall) | tidsviktat < 5 min: median · ≤ 2 · bias | 1,03 · 87,9 % · +1,07 | 0,72 · 100 % · −0,03 | 0,76 · 98,9 % · +0,64 |
| | tidsviktat < 10 min | 0,88 · 93,1 % · +0,72 | 0,88 · 92,2 % · −0,00 | 0,80 · 97,7 % · +0,46 |
| | påståenden < 10 min | 0,67 · 94,4 % · +0,49 | 0,67 · 89,8 % · −0,38 | 0,47 · 97,5 % · +0,11 |
| | tidsviktade sampel ≥ 2 min för optimistiska (sanning < 10) | 0 | 174 | 23 |
| | fall med uppsteg / uppsteg / varav ≥ 2 min | 39 / 46 / 27 | 56 / 84 / 35 | 36 / 48 / 13 |
| kontroll (40 fall) | tidsviktat < 5 min | 2,08 · 46,2 % · +2,13 | 0,90 · 85,9 % · +1,13 | 1,33 · 72,4 % · +1,57 |
| | tidsviktat < 10 min | 2,32 · 39,4 % · +3,52 | 1,17 · 67,9 % · +1,73 | 1,63 · 59,5 % · +2,28 |
| | uppsteg | 6 / 6 / 6 | 3 / 3 / 0 | 0 / 0 / 0 |

Granskarens egna fall, minuttalen efter avgången:

| Fall | 7699cbe | Fast golv 4 kn | Golvet följer accelerationen |
|---|---|---|---|
| Klaffbron 470 m, 1,2 → 2,4 kn | 5, strax | 5, 4, 3, 4, strax | 5, 4, strax |
| Klaffbron 480 m, 1,1 → 2,0 kn | 5, strax | 5, 4, 3, 5, strax | 5, strax |
| fartbrus 2,5 → 2,4 mitt i accelerationen | 5, strax | 5, 4, 5, 4, strax | 5, 4, strax |
| flyttar sig i kön och blir liggande | 6 står kvar | 5, 4, 5 | 6 står kvar |
| Järnvägsbron 150 m, 1,0 → 2,0 kn (sanning 6,5) | 5, 4, strax | 3, strax | 5, 4, strax |
| Olidebron 120 m, 1,0 → 2,0 kn (sanning 24,5) | 19, 24, 30, 28, 21, 19 … | 13, 12, 11, 14, 15, 16 … | 23, 22, 19, 18, 17 … |
| Olidebron 120 m, 1,2 → 2,5 kn | 19, 22, 21, 18 … | 14, 13, 11, 14, 15, 14 … | 19, 17, 16, 15, 14 … |

De uppsteg som är kvar i platåklassen är av två slag:
- *Rättelse vid avgången:* väntans prognos räknar redan på rask kanalfart
  (E-F7:s decaygolv). En långsam båt rättas därför uppåt en gång när den
  avgår, mest från Olidebron.
- *Minutsteg vid avrundningen:* dubbleringen i första samplet skjuter över när
  båten redan går sin marschfart på 2,0–2,5 kn.

Priset är kontrollklassens försiktigare första prognos: ALVA "om 5" mot sanning
3,1, där det fasta golvet gav "om 4". Nedräkningen går därefter bara nedåt.

Prövat och återtaget (hela sviten, 208 fall):

| Variant | Platå < 5 min | Uppsteg (fall / antal / ≥ 2) | ≥ 2 min för optimistiskt | Kontroll < 5 min | Varför återtagen |
|---|---|---|---|---|---|
| Fast golv 4 kn medan farten stiger (första revisionen) | 0,72 · 100 % · −0,03 | 56 / 84 / 35 | 174 | 0,90 · 85,9 % · +1,13 | "om 3" mot sanning 6 och uppsteg när golvet släpps |
| Golv min(4, 2 × fart) per sampel (granskarens V3) | 0,67 · 99,6 % · +0,35 | 56 / 94 / 29 | 53 | 1,11 · 74,8 % · +1,41 | fler uppsteg än 7699cbe: dubbleringen sent i rampen skjuter över platån |
| Stigande kräver +0,5 kn per sampel (granskarens V2) | 0,74 · 93,5 % · +0,46 | 80 / 104 / 54 | 83 | 0,90 · 85,9 % · +1,15 | golvet släpps oftare mitt i rampen |
| Golvet följer accelerationen, släpps direkt | 0,77 · 97,5 % · +0,68 | 45 / 61 / 20 | 23 | 1,34 · 71,7 % · +1,59 | den eftersläpande bufferten höjer prognosen när golvet släpps |
| … släpps i avståndets takt, utan bandet kring toppfarten | 0,78 · 98,9 % · +0,62 | 22 / 25 / 8 | 38 | 1,34 · 72,0 % · +1,59 | för låg ETA ligger kvar i minuter för en båt i jämn låg fart ("om 3" mot sanning 6,4) |
| … ett brussampel tolereras innan antagandet släpps | 0,78 · 98,9 % · +0,61 | 37 / 50 / 19 | 38 | 1,34 · 72,0 % · +1,59 | rättelsen kommer ett sampel senare för jämn fart |
| Vald variant men 2,5 × igångsättningsfarten | 0,61 · 99,9 % · +0,45 | 26 / 41 / 8 | 42 | 1,11 · 84,5 % · +1,32 | nästan dubbelt så många grovt optimistiska sampel |
| Vald variant men 4 kn i första samplet | 0,72 · 100 % · −0,07 | 42 / 74 / 22 | 174 | 0,90 · 86,5 % · +1,11 | samma optimism som det fasta golvet |
| Vald variant men tre minuter | 0,77 · 97,5 % · +0,66 | 36 / 53 / 13 | 23 | 1,34 · 71,7 % · +1,59 | golvet släpps mitt i en igångsättning med 60 s-takt |
| **Vald:** golvet följer accelerationen; högst 0,3 kn över toppfarten, i avståndets takt, aldrig under aktuell fart, fem minuter | 0,76 · 98,9 % · +0,64 | 36 / 48 / 13 | 23 | 1,33 · 72,4 % · +1,57 | — |

Ett band på 20 % i stället för 0,3 kn mättes likvärdigt. Bandet i knop valdes
eftersom det är samma brusgräns som inbromsningen prövas mot.

Första revisionens varianter, alla mätta mot samma baslinje:

| Variant | Utfall | Varför återtagen |
|---|---|---|
| Första prototypen (d1f02ee): jämn fart räknas som acceleration, inget närhets- eller riktningskrav, inget M9 | 7 ändrade, alla bättre, men MARIANNE-raden i 20260525 likvärdig (samma text 55 s tidigare) | fyra nya fatala INV-3 i buggjägarens standardprofil (664, 906, 920, 1113: strax → om 4 → strax) |
| Utan M9-kravet | 6 ändrade, alla bättre (LECKOs notis 3 → 2 i stället för oförändrad) | värld 595: golvet gav ensamt strax som släpptes till "om 3" (4 → strax → 3) |
| M9 utan V4-principen (EMA:n räknar från det hållna 3,0) | 7 ändrade, SKONNERTENs notis sämre (2 → 3 mot 1,4) | V4 tar bort priset utan att något annat ändras |
| V4 utan vakt (EMA:n räknar alltid från det ohållna värdet) | samma bank som vald | ett antagande kan lova strax via utjämningen när nästa mätning inte gör det (enhetstest) |
| Utan närhetskravet | den valda varianten plus två avgångar: FRAM (20260713-41h, notis 2 → 1, bättre) och MARIANNE (20260525, låst rad likvärdig) | MARIANNE hördes igen 454 m från sin stillhet efter 11 min tystnad — ingen igångsättning, och U13 tillåter inte en likvärdig rad |
| Tak på tre sampel i igångsättningen | banken oförändrad | syntetisk avgång 450 m före Klaffbron i 1,4 → 3,8 kn: "om 4 → om 3 → om 4" |
| Eget stillhetsminne utanför fartbufferten, de två senaste stillasamplen räcker: (a) överlever bara gap-reseten, (b) överlever även målbyte och stationär-hold | (a) 23 ändrade: 15 bättre, 8 sämre. (b) 35 ändrade: 18 bättre, 17 sämre. Båda fångar ANTJE (27 → 11 mot 14,7) | (a) ELFKUNGEN ×3 och ANTJEs senare rader blir sämre i låst golden-text. (b) dessutom MOKENDEIST, LA FEMME, YOLO 2:s låsta notis 7 → 2 mot sanning 30 min, och öppningsvarningen Klaffbron#16 i 20260804-both-21h flyttas |
| De två senaste buffrade samplen räcker (granskarens V1) | fångar NOCHT 12:01 | ELFKUNGENs låsta rad i 20260907-31h blir sämre ("om 11 → om 8" mot 13,1) |
| Stillhet = alla sampel < 1,0 kn | 15 korpusar flyttas | ny fatal ETA-oscillation i 20260708-21h (AKIRAs kajdrift) |
| Två sampel < 0,5 kn och resten < 1,0 kn | tio fler förbättrade påståenden | UTOPIA "om cirka 2" → "ETA okänd" 30 s före passagen (42h) och en korrekt "strax" 6 s senare (both-21h) |

**Kvar efter rättningen (oförändrade mot 7699cbe).** Hela klassen i banken är
87 rörliga sampel (≥ 1,0 kn) efter långsam buffert som avgångskontexten inte
känner igen. Kolumnen "≥ +3 min" räknar de sampel där ett mätt påstående inom
tre minuter var minst 3 min för högt:

| Mekanism | Sampel | Med mätta påståenden inom 3 min | ≥ +3 min | Fallen med ≥ +3 min |
|---|---|---|---|---|
| tömd buffert (gap-reset, målbyte), högst ett sampel kvar | 32 | 13 | 6 | ANTJE (both-21h 07:31:45) +12,8 · AKIRA (21h 07:20:09) +8,8 · SOLUTION (19h 07:43:48) +3,9 · TINY (80h 16:34:09) +3,8 · NOCHT (41h 11:12:01) +3,8 · MISTRAL (42h 12:13:52) +3,3 |
| ankomstfarten kvar i bufferten efter en kort väntan | 18 | 8 | 1 | NOCHT (41h 12:01:02, [1,8, 0,3, 0]) +4,1 |
| krypfart utan stillhet (inget buffrat sampel under 0,5 kn) | 15 | 6 | 1 | NORDIC SOLA (41h 08:48:51, [1, 0,8, 0,8]) +9,5 |
| startsampel 0,5–0,99 kn före avgångssamplet | 7 | 5 | 2 | UTOPIA (42h 08:03:38, [0,2, 0,3, 0,6]) +6,9 · ANDREA (42h 18:52:22) +4,4 |
| långsam gång 0,5–0,99 kn i bufferten | 6 | 4 | 1 | ZORA (19h 07:11:17, [0,9, 0,3]) +5,9 |
| stillhet som aldrig nådde kalkylatorn | 4 | 2 | 1 | PILOT 761 (13h 12:13:45; ingen ETA räknades 11:49–12:13) +11,3 |
| för långt från stillheten (> 200 m) | 3 | 2 | 0 | — (MARIANNE 20260525, 454 m) |
| bort från målbron (riktningskravet) | 2 | 0 | 0 | — |

Skälen och vad som krävs för att fånga dem står i ARCHITECTURE §8 (e). Klassen
hör till ETA-etappen (familj E2 och senare).

*Mätanmärkning.* `measure:eta` tappade renderingsposter
(`attribution: rendering-saknas`) i slutet av en korpus när maskinen var hårt
lastad (lastsnitt 16–25 på fyra kärnor). Det gällde 3–38 påståenden i en eller
två korpusar per körning, och en omkörning gav 0. Orsaken är att
`replayRunner.js` avslutar med `process.exit` i stdout-callbacken medan
skrivningar till en stderr-pipe är asynkrona på Linux, så stderr-svansen kan
slängas. Mätningarna ovan är tagna i körningar med noll saknade renderingar.
Kontrollera `rendering-saknas` = 0 innan en mätning används, tills harnessen
tömmer stderr före exit.

## Buggjägaren — diagnosverktyg, INTE en gate (2026-11-04)

`tests/replay-validation/bugHunt/hunt.js` letar fel offline ur de 24 låsta
korpusarna och ur syntetiska världar med facit, så att appen inte behöver köras
live och felsökas i efterhand. Den **rapporterar bara**: den rättar ingenting,
låser aldrig om facit, sätter aldrig `REGEN_*` och ändrar inte
beslutsregistret. Därför ingår den inte i `npm run validate` eller
`validate:full` — samma skäl som för täckningskartan och korpuslåsningens
grindar. Exitkoden är 0 när motorn körde klart, även med fynd; 2 vid
självtest- eller motorfel; 1 vid felaktig användning.

```bash
npm run hunt:selftest           # fas 0: banken ×2, M-EXAKT, kanarier, rundresa, S-KALIBRERING
npm run hunt:quick              # ~1,5 min: 300 världar, M-FAS på +7/−11,52 s
npm run hunt                    # ~5 min: 2 000 världar, sju δ
npm run hunt:night              # 20 000 världar, 13 δ, även REPLAY_MONITORING=1
npm run hunt:repro -- <fynd>    # kör om ett sparat fynd mot aktuell HEAD
```

Utdata hamnar i git-ignorerade `dirigent/hunt/<stämpel>-<sha7>-<profil>-s<seed>/`
(`rapport.md`, `rapport.json`, `fynd/Fnn-*/`). Ett kort är en **kandidat** tills
du triagerat det (`docs/BUGGJAKT.md` §15): en bugg rättas separat med vanlig
validering, ett avsett beteende skrivs först i docs/ och får sedan en post i
`bugHunt/beslutsregister.json`, ett motorfel rättas i motorn — aldrig i
registret. Självtestet stoppar jakten (exit 2) om banken inte är byte-identisk,
om M-EXAKT bryts, om ett instrumentkrav är 0 eller om rundresan inte är
bitlik; då går inga andra fynd att lita på förrän det är utrett.

## Fältprov / ny korpus (så samlas verklighet in)

**Hel-loggsjämförelse (2026-09-06):**

```bash
npm run replay:field -- dirigent/logs/app-20260823-185834.log \
  dirigent/logs/ais-replay-20260823-185834.jsonl /tmp/ais-field-report
```

Rapporten läser HELA loggen, kontrollerar replay-integritet och tidshål och
kör den riktiga replayharnessen. `field-report.json` visar varje par av
notiser (text, ETA, källa, riktning, avrundat avstånd och tidsdiff),
öppningsvarningar, brotextantal, rådatafacit, källtäckning och ETA-påståenden.
`field-report.txt` summerar. Notisens försökstid jämförs; fältets separata
`successAt` visar leveranskvittensen. Misslyckade/okvitterade försök redovisas
separat. Efterspel EFTER sista loggtiden blandas aldrig med observerat fält:
23/8 ger sju öppningsvarningar före stopp och en åttonde efteråt.

Rapporten är **informativ**, inte en låsningsgrind: även fatala invarianter
redovisas utan att ändra exitkod (integritetsfel/processkrasch ger däremot
felkod). DIANAs två Kanalinfarten-notiser ligger kvar synligt som
invariantutslag. Monitoring/stale-svepet, avvisade fusionsfixar, livstecken
och initial settings-persistens återspelas fortfarande inte.

**P9: gt-punktens precision.** Nygenererat rådatafacit märker korsningspar
med glapp >120 s och SOG <0,5 kn i någon ändpunkt som `inferred` med orsaken
`sparse-stopped-endpoint`. En linjär tidsstämpel kan inte avgöra när båten
väntade; korsningen är kvar och endast fönstret får användas i ETA-mätning.
Tätare par lämnas eftersom hela deras tidsosäkerhet ryms inom två minuter.
Saknad/ogiltig SOG är inte stillhetsbevis. I 23/8 får PHOENIX samma fönster
14:50:18–15:02:19 UTC vid både Stridsbergsbron och Järnvägsbron; 23
korsningar/zonbesök kvar, 4→6 inferred. Regeln ändrar inga produktbeslut.

**Historiska gt-filer granskade och omlåsta 2026-09-12.** De 71 punktposterna
är nu intervall, med oförändrade korsningar och tidsfönster. Ytterligare 57
redan osäkra poster har fått uttrycklig orsak. Fartgrinden använder fixens
tid i stället för leveranstiden: CHARLYS DREAMs Klaffpassage 5/8 och
ELFKUNGENs Järnvägspassage 10/9 försvinner därmed inte vid källbyte. Råfixarna
visar normal förflyttning, trots mycket korta leveransgap. `--check` prövar
att samtliga incheckade filer stämmer med generatorn.

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
   sektionen "Logg-integritet (tidshål + replay-fångst)" med tre kontroller och ett
   samlat verdikt. Replay-kontrollen granskar även källans bokföring:
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
   - **Intern källbokföring (2026-10-05)** — från observerad boot får
     `AISHUB_HEALTH.accepted` inte överstiga summan av tidigare
     `AISHUB_POLL.accepted`. Ett överskott bevisar saknade pollrader även
     när samma block försvunnit ur både logg och JSONL. Det ger FEL och
     stoppar korpuslåsning. Omstart, källbyte, delad logg och okänt format
     redovisas konservativt; ett saknat nollankare blir OKÄNT. Skillnaden
     mellan fusionens accepted och appens sampel är en separat diagnos,
     eftersom appen kan avvisa data efter fusion. Den ensam fäller inte.

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

   Den interna bokföringen kan bevisa vissa tidigare dolda blockbortfall,
   men certifierar inte alla loggrader. Sista kontrollerade hälsorapportens
   tid skrivs ut; svansen därefter är inte fullständighetsbevisad. Ett OK
   för JSONL-jämförelsen betyder att den matchar den **bevarade** loggen.

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
   Utelämnad logg (och `--corpora`) matchas via tidsstämpel eller sha256 mot
   loggarkivet: `--log-dir`-kataloger, sedan `../logs/`, `dirigent/logs/`
   och `~/.ais-tracker-logs/` — de som finns.
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
   korpusens FÖRSTA sampel (`replayRunner.js`). UI-watchdogen följer fasta
   halvminuter och öppningsmotorn sina deadlines, medan exempelvis
   minutstädningen fortfarande startas vid init. Svepet spelar upp samma
   korpus med ENBART starttiden förskjuten och jämför utfallen:
   ```bash
   npm run replay:phase                  # olåsta korpusar, annars hela banken
   npm run replay:phase -- <jsonl> [...] # en eller flera namngivna korpusfiler
   node tests/replay-validation/runPhaseSweep.js --help
   ```
   Utan argument sveper skriptet varje korpus i `corpora.js` som har
   `locked: false` — exakt de körningar som står näst i tur att låsas. Finns
   ingen olåst korpus kör det hela den låsta banken och säger det rakt ut.
   De tidigare startberoende UI-tickarna och sena
   konvojfrisläppen är rättade; gamla röda fasresultat är ingen förväntad
   baslinje. Flaggor: `--offsets=-20,-11.52,-5` (fasoffsets i SEKUNDER,
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

   **Svepets blinda fläck: fasen mot halvminutsrutnätet.** Eftersom bara
   ankarraden flyttas ligger alla övriga sampel kvar på samma plats mot de fasta
   halvminuterna. Buggjägarens M-FAS-relation flyttar i stället HELA korpusen och
   starttillståndet δ, och det var den som fångade F08 (SINE BRES 20260917-16h
   tappade Järnvägspassagen vid δ −2,5 och −7 s; omgranskningen fann även −5 s;
   rättat 2026-11-04). Det fallet är låst i
   `tests/zonintrade-uppskjutet-bevis.test.js`, som flyttar korpusen på samma
   sätt, både som den är och med en extra fix inne i brozonen (granskarens prov:
   två tider och fyra faser). Samma fil visar den kända luckan med en extra fix
   50–60 m efter linjen (ARCHITECTURE.md, F08), som inte beror på fasen.

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

### Riktad nyregistrering när samlad regenerering är spärrad

En verifierad ny körning får tillföras utan att regenerera äldre korpusar.
Detta användes för `20260918-7h` när den ofullständiga `20260917-7h` redan
spärrade samlad `REGEN_DISTRIBUTIONS=1`. Förfarandet gäller **endast ett nytt
korpus-id** och är ingen tillåtelse att ändra befintliga referenser.

1. Bevara JSONL och eventuellt inspelat startminne byteexakt i `corpora-data/`.
   Dokumentera källfilernas SHA-256. Spara samtidigt SHA-256 för alla äldre
   golden-/GT-filer och en kopia av befintliga id-poster i delade
   distributionsfiler och GT-indexet, så oförändrat innehåll kan bevisas.
2. Kör integritetsgrinden mot hela källoggen och granska vad den faktiskt
   mäter. Belagt bortfall får inte kringgås. Kör sedan den nya filen både
   normalt och med `REPLAY_MONITORING=1`, samt namngivna fassvep med alla sex
   standardförskjutningar i båda lägena. Utred varje skillnad, processfel,
   invariantutslag eller läcka före låsning.
3. Jämför notiser, öppningar och passager mot oberoende råkorsningar och
   observerade närzoner. Särredovisa policyinferenser utan råpassagebevis;
   lägg aldrig till påhittade GT-korsningar för att få antal att matcha.
   Skapa ett motiverat regressionstest för de granskade fältfallen.
4. Generera referenser från den granskade replayn, **endast för det nya id:t**:
   nyckelmultiset i `corpora-distribution.json`, riktningsmultiset i
   `corpora-direction-distribution.json`, öppningsmultiset i
   `opening-distribution.json`, `{iso, text}`-ström i `golden-text/<id>.json`
   och hela `eventFacit(result)` i `golden-events/<id>.json`. Normal- och
   monitoringkörningen ska båda klara de nya låsta referenserna.
   Registrera det nya id:t, låsning och rådatamotivering i `corpora.js`
   utan att ändra andra korpusars lås eller undantag. Generera GT riktat
   med `makeGtPassages.js --corpus <id>` och lägg endast den nya filens
   uppslag i `gt-passages/index.json`; kontrollera med samma kommando plus
   `--check`.
5. Granska diffen och verifiera att alla gamla golden-/GT-hashar består och
   att delade filer endast fått den nya id-posten. Kör det nya fälttestet
   samt hela standardbanken med `npm run replay:all`. Kravet på monitoring
   och båda fassvepen ovan gäller det nya materialet; ordinarie
   72-timmarskontroll med `npm run replay:monitoring` kvarstår.
   En röd äldre korpus är en regression att utreda, inte skäl för massomlåsning.
   En ofullständig historisk korpus behåller både sina assertions och sin
   `captureIntegrity: 'incomplete'`-klassning; regenereringsspärren kvarstår.

## Kända fällor för den som skriver nya tester

- **Standardreplay utan monitoring prövar inte minutstädningen.**
  `REPLAY_MONITORING=1` aktiverar appens verkliga
  `_setupMonitoring`-loop i harnessen; `runtimeDiagnostics.staleSweeps`
  redovisar antalet körda svep. Kör även detta läge och dess fassvep när
  ändringen rör städning eller livscykel. `replay:monitoring` prövar dessutom
  72 timmar och omstarter. De riktade `k18-stale-sweep`-testerna behövs
  fortfarande för felvägar som fältkorpusarna inte täcker. Grönt i enbart
  standardreplay eller en svepräknare över noll bevisar inte korrekt städning;
  granska även utfall, kvarvarande fartyg och timers.


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
halvskrivet. `relockGoldenText` vägrar korpusar utan befintliga poster.
Nya korpusar kan genereras från en grön samlad körning när REGEN är tillåten,
eller enligt den strikt avgränsade **riktade nyregistreringen** ovan när
ofullständiga historiska fångster spärrar samlad regenerering.

**Dirigentläxan (2026-08-10):** LCS-diffa gamla mot nya goldens SJÄLV innan
omlåsning och skriv noten mot den FAKTISKA diffen (antal borttagna/tillagda
med livslängder, tidsskift, systematisk kostnad) — implementatörens
diffsammanfattning är otillräcklig som enda underlag (CRITICAL-fyndet i
adversariella granskningen 2026-08-10: selektiva noter på 7 korpusar).


## Tillägg 2026-08-23 (helkodsgranskning runda 4, fixrunda 4/4b/4c)

- **INV-14W (WARN):** INV-14 fäller bara inklämda DEFAULT-episoder ≤ 300 s; längre spann
  rapporteras nu som WARN-klassen INV-14W (spannlängd + bro) i stället för att tystas
  (M24). `runAllCorpora` varnar även för OANVÄNDA `knownInvariantExceptions`.
- **Syntetiska scenarier — känd WARN-baslinje.** På `7699cbe` är den 6: INV-15 ×2
  (u-sväng-gles-ais-norr-om-Klaffbron, fördröjd-gammal-position), INV-18
  (återfödd-utflygare-söderut) och 3 INV-14W (navstatus-flap-väntare 600 s, ankrad
  gles sändare 1440 s, återfödd-i-kö HERA-klassen 900 s). Familj M (F05, 2026-11-05)
  lägger till 3 INV-14W, en per krypfartsscenario där båten med rätta är dold
  medan hon kryper: krypfart-söder-om-Olidebron-ej-passerad 2970 s,
  sog-null-stopp-norr-om-passerade-Klaffbron 1050 s och
  fartgrind-krypare-söder-om-Stallbackabron 2550 s. Baslinjen är då 9. Fler än
  baslinjen, eller en annan sammansättning, = rapportera. (Integrationen:
  summera med de andra familjernas scenarier och WARN-rader.)
- **O1:s missklassificerare (`classifyMiss`)** kräver nu KORROBORERAT rörelsebevis i tre
  led (position ≥ MOVEMENT_PROOF_NET_M från första horisontsampel; etablerad stillhets-
  vistelse ≥ ARM_STALE_TTL_MS inom 50 m + tätt fixpar med implicerad fart < 0,5 kn ⇒
  sog-spikar är jitter; korroborering ur `lib/utils/quayTransitProof.js` som även
  app.js och O2 använder). Bevissträngen skriver "etablerad stillhetsvistelse …" resp.
  "korroborerad av egen förflyttning". Grönheten för CARAT (both-21h) vilar på
  vistelseledet — en grindregel produkten inte har; ompröva vid nästa korpustillskott.
- **Historiskt fasfel, rättat 2026-09-08:** absoluta UI-tick och egna konvojdeadlines
  ersätter startberoendet. Ett bart `npm run replay:phase` prövar nu hela den låsta banken;
  även körningen med `REPLAY_MONITORING=1` ska vara grön före fältprov.
- **Mäthygien:** ARM-jämförelser görs i TVÅ isolerade träd (git archive HEAD resp. rsync
  av arbetsträdet); påståendet "HEAD var redan röd" ska styrkas med loggfil från HEAD-trädet.
