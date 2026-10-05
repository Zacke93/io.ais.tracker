# Fält- och helgranskning 2026-10-05

Utgångspunkt: `29de1ff`. Tre parallella granskare ansvarade för fältbevis,
anslutning/livscykel och domänlogik. Ändringarna har motgranskats av en annan
granskare och därefter sammanvägts av dirigenten. Ingen installation eller
publicering på Homey ingår. Originaldata har inte redigerats.

## Material och verkliga fel

Samtliga **1 748 798 loggrader** har strömlästs och händelseklassats, inklusive
fortsättningsrader. Alla sparade AIS-poster och AISHub-svar har parsats.
Original och arkivkopior är byteidentiska. Alla tider nedan är **UTC**.

| Fältkörning | Observerat tidsintervall | Loggrader | AIS-poster | Närnotiser | Öppningskort | Brotextbyten |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `20260918-141252` | 18/9 12:13:04–19:09:30 | 51 558 | 379 | 16 | 4 | 33 |
| `20260921-001606` | 20/9 22:16:13–29/9 18:48:00 | 1 697 240 | 12 471 | 204 | 68 | 630 |

De viktigaste observerbara rättelserna i långkörningen:

- **KINNE:** ett kort från 21/9 spärrade nästa ankomst den 23/9 trots drygt
  40 timmars bekräftad förtöjning utanför de ritade kajzonerna. Ny varning
  ges nu 23/9 13:06:11.473 vid 691 meter. Förändringen kräver belagt stopp
  och verklig avgång; tid, navstatus eller vanlig brokö räcker inte.
- **LIV/JOHANNA:** redan belagd konvoj splittrades när LIV fick väntestatus
  vid Järnvägsbron. Båtarna låg 6–8 meter från varandra och avgick ihop med
  1,5 sekunders skillnad mellan AIS-rapporterna. LIV:s extra Stridskort
  27/9 14:50:19.249 tas bort. En ny egen observation kan fortfarande bevisa
  att följaren stannat i en annan kö. Explicit fartygsidentitet skiljer
  egen observation från en annan båts uppdatering, även samma millisekund.
- **SWIX och AMELIA:** gammal krypväntan behandlades som skyddsvärd även när
  rena positioner bevisade korsning av mellanbron. ETA-skyddet får nu släppa
  denna baslinje. Både registrerad passage och statusvägens starka
  linjekorsningsbevis används; färskhet, råfart, minst 50 meters fysisk
  rörelse och rimlig förflyttning krävs fortfarande. U-sväng, fel bro,
  epsilonband, GPS-fel och framtida/gammal passagestämpel räcker inte.
  Öppningskortens ETA ändras från **7→2** respektive **11→2 minuter**.

KINNE tillför ett kort och LIV tar bort ett: **oförändrat totalantal hade
dolt båda felen**. Jämförelserna granskar därför de enskilda händelserna.

## Övriga kodfel och rättelser

Granskningen omfattade `app.js`, samtliga 14 tjänster, 13 hjälpfiler,
broregistret, konstanter, fyra anslutningsmoduler, drivrutin/enhet,
inställningssidan och loggskriptet.

| Fel | Rättat beteende och motprov |
| --- | --- |
| Källinställning under asynkron uppstart kunde starta AIS innan eventmottagarna fanns | Uppstart använder de senaste inställningarna när mottagarna är kopplade. Tester omfattar alla tre källnycklar, initfel, avbruten uppstart och omstart. |
| `NEW_JOURNEY` kunde ärva saknad fart/kurs och nollställa passager/notisdedup | Två verkliga returfixar kräver rapporterad råfart/råkurs och betrodd position. Riktiga vändningar i båda riktningarna fungerar. |
| Passagegeometrin kunde tolka saknad råfart som tidigare stillhet | Stillhetsbevis använder varje positions egen råfart. Återhämtningsankaret bevarar sin egen råfart i stället för att låna hoppfixets. |
| Flow-villkoret ”båt vid bro” godkände GPS-hopp när tidslåset löpt ut | Positionen måste också ha återhämtats med riktigt positionsbevis. Allmän försiktighet efter ett rimligt AIS-glapp blockeras inte. |
| GPS-hopp kunde avväpna rätt broöppning och beväpna fel bro | Öppningsmotorn bevarar senaste betrodda anflygningen och deadline tills ren data kommer. Ny målbro, passage och prognos kan inte styrkas av en underkänd fix. |
| Långsamma Homey-skrivningar spelade upp gamla brotexter efter att båtarna försvunnit | Pågående skrivning följs av senaste väntande brotext. Övriga capabilityflanker behåller sin ordning. Tester omfattar verklig UI-kedja, A→B→A, lika köposter, flera enheter, timeout, sent SDK-svar och omstart. |
| Rensning av en passerad bro kunde förbruka nästa bros korsningssegment | Den föregående rena observationen behålls till nästa statusanalys när en passerad bro rensas. NINA B:s Järnvägspassage registreras vid ordinarie zonutgång. Broval, notisordning samt GPS-, tids- och segmentgränser behålls. |

Riktade tester har först visat fel på den gamla koden och därefter passerat
med respektive rättelse. Kritikerna har prövat bland annat omstarter,
köstopp, tystnad, null-fält, fel riktning, verkliga vändningar, GPS-hopp,
gamla observationer och samtidiga fartygsuppdateringar.

En första ETA-kandidat motbevisades: exakt likhet mellan positionsstämpel
och passagestämpel fungerade bara med fryst testklocka. SWIX:s verkliga
bearbetning tog 3 ms mellan dessa steg. Slutversionen accepterar registrering
från den aktuella positionens mottagning fram till nu; 0/1/3/50 ms och
96 oberoende kombinationer av tids-, fart-, bro- och GPS-fall prövades.

UI-felet reproducerades med sex båtar 150 ms isär, därefter tomt läge och
fem sekunder per lyckad Homey-skrivning. Den gamla kön visade historiska
båtar i upp till 35 sekunder trots tom aktuell text och släckt larm. Nu
behövs två skrivningar i samma prov: den pågående och det senaste läget,
klart inom tio sekunder. Homeys egen svarstid kvarstår. Denna bugg hittades
i kodkritiken; de sparade fältkvittenserna visade inget sådant fel.

## Loggarnas fullständighet

**Långfältet är ofullständigt och får inte bli komplett fältfacit.**
JSONL matchar den bevarade loggen, trots bevisade bortfall i loggbokföringen
och motsvarande sampelunderskott mot fusionen. Den gamla kontrollen kunde
därför ge ett missvisande OK.

Den nya grinden kontrollerar AISHubs bokföring från observerad boot:
emitterade fixar får inte överstiga summan av tidigare pollars deklarerade
fixar. Ett överskott bevisar saknade pollrader. Fusionens accepted-räknare
ensam används inte som hårt bevis, eftersom appen kan avvisa data senare.

| Material | Bevisat bortfall |
| --- | --- |
| Nya långfältet, 27/9 omkring 16:51:13 | Emissioner 9 980 mot 9 979 deklarerade. UI-version 21 329 saknas. Snäv blockgräns vid loggrader 1 426 236–1 426 238. |
| Nya långfältet, 29/9 omkring 16:58:32 | Emissioner 11 829 mot 11 827 deklarerade: underskottet ökar till två. UI-version 27 111 saknas; loggrader 1 687 649–1 687 650. |
| Tidigare låsta `20260917-7h`, omkring 17/9 17:13 | Fem pollar enligt hälsoräknaren men fyra bevarade; emissionsökning två mot en deklarerad. UI-version 1 001 saknas. Kontrollfönster 17:12:18.991–17:17:18.993. |

De saknade positionernas identitet och innehåll kan inte återskapas. Ingen
syntetisk komplettering har gjorts. Kortfältet passerar den nya kontrollen
med 83 bootförankrade AISHub-kontroller; långfältets 2 550 kontroller ger
FEL med minst två saknade emissioners pollbokföring. Svansen efter sista
hälsorapporten och alla övriga loggrader är inte fullständighetscertifierade.

Den äldre korpusen behåller alla strikta assertions för de bevarade sampeln
men märks `captureIntegrity: 'incomplete'`. Den utgör historisk regression,
inte komplett fältbevis. Samlad regenerering med `REGEN_DISTRIBUTIONS`
spärras före skrivning, liksom `relockGoldenText` för just denna korpus.
Ingen kontroll eller varning har
undantagits för att göra dataintegriteten grön.

## Korpus efter användarens begäran

Kortfältet tas in som **`20260918-7h`**, 6,94 timmar, med byteexakta kopior
av 379 AIS-poster och det inspelade startminnet. Låsningen omfattar
16 närnotiser, fyra öppningsvarningar och 33 brotextövergångar, inklusive
fullständiga händelser med tider, ETA, riktning, källa och medlemmar.
Råpassagefacit hålls separat från appens egna registreringar.

De oberoende rådata ger 14 korsningar/zonbesök. SIR HENRYs två ytterligare
närnotiser kräver uttrycklig avgränsning: första fixen visar närhet till
Järnvägsbron på 39 m, medan Klaffnotisen 1 002 m bakom båten följer det
befintliga beslutet om kallstartsinferens (Scenario A i `ARCHITECTURE.md`).
Den senare är en policyreferens och ingen rådataverifierad passage.
Ingen extra korsning har lagts in i råfacit för att få antalen att matcha.

Granskningen inför låsningen hittade också NINA B:s rena segment över
Järnvägsbron 18/9 17:31:26.104–17:32:34.469. Den gamla koden rensade först
den passerade Stridsbergsbron och avslutade brovalet, så segmentet tappades
och Järnvägspassagen bokfördes först i efterhand vid Klaffbron. Rättelsen
bevarar segmentet till ordinarie zonutgång 17:34:15.400 och ger sju
registrerade mellanpassager i stället för sex. Kortfältets notiser, öppningsvarningar,
målpassager och textövergångar är oförändrade.

Samma rättelse återställer två tidigare missade Järnvägspassager i den
historiska banken. Båda korsningarna finns redan i råfacit utan inferens:

| Fartyg | Råsegment över linjen | Registrering vid nästa utgångsfix |
| --- | --- | --- |
| OSPREY, 2/6 | 09:57:07.019–09:59:39.605, 336 m före → 19 m efter | 10:02:39.828 |
| SINE BRES, 18/9 | 02:26:08.016–02:26:30.446, 94 m före → 26 m efter | 02:27:17.778 |

Tre granskare har kontrollerat råfixar, riktning och registreringstider.
Endast SINEs extra mellanpassage behöver läggas till i ett befintligt
händelsefacit. Inga tidigare passager tas bort. Samtliga historiska notiser,
öppningar, målpassager och brotexter är exakt oförändrade av denna rättelse,
även källfält, tider, ETA och textinnehåll.

TANGELA den 24/8 skyddar motsatt fall: efter ett 952 sekunder långt
AIS-glapp är Järnvägsbron redan passerad. Notisen ska fortfarande säga
”passerade … under AIS-tystnad”, med ETA −1. Ett nytt rådatabundet test
hindrar att bevarat korsningsunderlag samtidigt gör om detta till en
kommande ankomst. Ingen händelsereferens ändras för att godta den regressionen.

Långfältet tas inte in som komplett korpus. De byteexakta utdragen för
SWIX (56 rader) och AMELIA (98 rader) används som avgränsade ETA-regressioner
och ligger före första bevisade bortfallet. De representerar inte hela
körningens fångst eller startminne.

## ETA-mätning och granskade facitändringar

Slutversionen jämfördes med den frysta baslinjen över 23 korpusar,
478,12 timmar. De två nya fälten ingår inte i dessa 23; `20260917-7h`
bidrar endast med sina bevarade sampel. Måttet använder publicerade påståenden mot rådatans
linjekorsningar; intervallinferenser behandlas inte som exakta tidpunkter.
Positiv bias betyder att ETA anger senare ankomst än den observerade.

| Population | n före → efter | Median absolutfel, min | Andel inom 2 min | Bias, min |
| --- | ---: | ---: | ---: | ---: |
| Sanning <5 min, samtliga mätta | 762 → 761 | 0,48 → 0,48 | 88,06 % → 88,57 % | +0,540 → +0,522 |
| Sanning <5 min, samma påstående/tid | 759 → 759 | 0,48 → 0,48 | 88,14 % → 88,67 % | +0,538 → +0,519 |
| Sanning <10 min, samtliga mätta | 1 261 → 1 260 | 0,72 → 0,72 | 80,33 % → 80,79 % | +0,210 → +0,192 |
| Sanning <10 min, samma påstående/tid | 1 257 → 1 257 | 0,72 → 0,71 | 80,35 % → 80,83 % | +0,207 → +0,191 |

Parningen använder korpus, typ, MMSI, bro och exakt tid. Även toleranserna
1 sekund och 60 sekunder prövades: medianen försämras inte; andelen inom
två minuter och bias förbättras vid båda toleranserna. Vid 60 sekunder är
medianen för <10 minuter 0,72→0,72, jämfört med 0,72→0,71 vid exakt/1 s parning.
Brotextövergångar ändras **2 512 → 2 511**. Måttet väger publiceringar lika;
det är inte tidsviktat och bevisar inte att alla enskilda prognoser förbättras.

De korta sanningshorisonterna ovan beskriver inte hela ETA-populationen.
Utan horisontgräns, inklusive långvariga stopp före nästa rålinjekorsning,
är antalet mätta numeriska påståenden 2 159→2 158, medianen 1,59→1,56 min
och andelen inom två minuter 55,26→55,51 %. 90:e percentilen är oförändrat
22,19 min och medelabsolutfelet 16,64 min; bias är −15,20→−15,21 min.
Detta är helhetsinformation, inte acceptansmåttet för ändringen.
Påståenden utan mätbar rålinjekorsning, intervallinferenser och separat
klassade ”strax”-texter ingår inte i denna total.

I det nya långfältet ändras även åtta närnotisers ETA/text. Alla tider,
avstånd, riktningar och källor består:

| Fartyg och tid | Närnotisens ETA före → efter |
| --- | ---: |
| SKAGERN, 20/9 22:55:25 | 2→1 min |
| NORFJELL, 23/9 08:18:42 | 1→2 min |
| LECKO, 24/9 16:35:45 | 3→1 min |
| SPIKEN, 25/9 17:30:14 | 3→2 min |
| LA VIE, 26/9 12:24:21 | 2→1 min |
| SWIX, 26/9 14:52:08 | 1→2 min |
| AMELIA, 27/9 08:51:29 | 2→3 min |
| PRIMA VITA, 27/9 10:52:16 | 0→1 min |

Fyra blir bättre och fyra sämre mot interpolerat punktfacit; genomsnittligt
absolutfel för dessa åtta är 0,884→0,676 min. NORFJELLs råpassagefönster är
0,245–0,920 min efter notisen och AMELIAs 0,754–1,761 min. Konservativa
prognoser kvarstår alltså även när öppningskortens stora väntfel rättats.
Hela långfältets textström och samtliga mål-/mellanbropassager är oförändrade.

Endast rådatagranskade referensposter har ändrats:

- PILOT 761: Klafftext 14→9 och 9→7 minuter efter bevisad Järnvägskorsning;
  följande femminuterstext kommer tidigare. Faktisk Klaffkorsning ligger
  12:21:48.842–12:22:48.797 den 10/7. En textövergång försvinner.
- BLADE, MONIKA och VISTEN: Stridsnärnotis 3→1, 4→2 respektive 4→2 minuter.
  Rådata ger interpolerade återstående tider 0,81, 2,11 och 1,50 minuter.
  Notistider, avstånd, riktning, källa och antal består.
- ATHENA: en GPS-underkänd fix får inte längre flytta öppningens deadline.
  Kortet flyttar från 6/8 14:49:41.790 på 710 m till 14:51:57.265 på 276 m,
  ETA 4→3. Råkorsningsintervallet ger **68,5–138,9 sekunders förvarning**.
  Detta är en konkret kostnad i marginal för att osäker data inte ska
  styra öppningen. Kortantal och alla passager består.
- SINE BRES: den rådatabevisade Järnvägspassagen 18/9 02:27:17.778 läggs
  till i händelsefacit enligt segmentgranskningen ovan. Det befintliga
  råkorsningsfacitet förblir oförändrat.

Ändringarna är motiverade även i `tests/replay-validation/corpora.js`.
Befintliga rådata, korsningsfacit samt antals- och riktningsreferenser är
orörda. Den nya korpusens separata poster har tillkommit efter granskningen.

## Driftobservationer och begränsningar

Inga appkrascher, oinfångade undantag eller AIS-bearbetningsfel observerades
i de bevarade nya loggarna. Alla 11 680 sparade AISHub-svar var HTTP 200
med `ERROR=false`. Alla 2 220 UI-kvittenser var godkända; enhetens återläsning
matchade och globala kvittenser var inte sena.

RSS kunde inte läsas i Homeys miljö (`uv_resident_set_memory`/`ENOENT`).
AISStream gav två 503-försök den 21/9 och återhämtades efter cirka 19 s;
AISHub fortsatte leverera. Tyst feed, dubblettavslag, åldersstädning och
avsiktligt okänd ETA har skilts från programfel. Heap nådde omkring
19,1 MB av 70 MB och planade ut; detta är ingen generell läckfrihetsgaranti.

Råpassagekontrollen har två osäkra tidsordningar i långfältet (SYBIL och
TIMELESS efter långa AIS-glapp). Den historiska öppningsgrinden har fortsatt
38 tidsordningar som rådata inte kan avgöra och noll oklassade missar.
Det är därför inte styrkt att varje verklig passage fick minst 60 sekunders
förvarning. SPIKENs stora ETA-avvikelse följde acceleration efter senaste
fixen; vanlig prognosutjämning och okänd framtida fart har inte ersatts med
efterhandskunskap.

LECKOs 9,399 sekunders replaydifferens är isolerat härledd till harnessen:
synkron fake-timerkörning fördröjer microtasks. En isolerad asynkron variant
ger 13 ms mot fältet med samma notiser, kort och texter. Produktionskoden
har inte ändrats för att anpassas till denna testartefakt.

## Verktyg och slutkontroll

Jest 30.5.2, ESLint 8.57.1 och Athom-konfiguration 4.0.2 har verifierats i
isolerade kopior före installation. Det gamla minimatch-overridet togs bort.
`npm audit` går från 38 rapporterade utvecklingsberoendeposter till **0**.
Runtimeberoendet `ws` är oförändrat; produktionsaudit var redan noll.
Utvecklingskraven och Jest 30:s filterflagga finns i `CLAUDE.md`. Sju nya
lintvarningar rättades utan ändrad funktion eller sänkta regler.

Efter den sista produktändringen, bevarat korsningsunderlag vid brorensning,
har följande kontroller körts på samma frysta produktkod:

| Kontroll | Resultat |
| --- | --- |
| Hela Jest-sviten, inklusive kontroll av öppna handtag | **320 sviter, 4 506 tester**, samtliga godkända efter den granskade SINE-referensändringen |
| Hela replaybanken | **24 korpusar**, cirka 485 timmar; samtliga regressionsassertions godkända. `20260917-7h` redovisas fortsatt som ofullständig fångst. |
| De två nya fälten, normalt och med monitoring | **4 återspelningar**, inga undantag eller överhoppade sampel. Endast NINA B:s extra mellanpassage ändras av den sista rättelsen. |
| Fassvep med sex tidsförskjutningar och en baslinje | **84 återspelningar**: 56 historiska och 28 från de nya fälten, med och utan monitoring. Inga fasberoende skillnader eller undantag. |
| Syntetiska scenarier och öppningsgrind | **45 scenarier** och **25 öppningskörningar**: 24 korpusar samt nattfältets extra fusionsvariant. Nattens 6/6 öppningar får varning i förväg; alla tillämpliga assertions godkända. |
| Simulerad 72-timmarsdrift, både normalt och med monitoring/omstarter | Båda körningarna: 38 fartyg, 3 464 fixar, 216 notiser, 762 textövergångar, 72 målpassager. Inga process-/nedstängningsfel; noll kvarvarande timers efter omstarter och avslut. |
| Oberoende passagekritik och portabilitet | 21 motprov godkända. Ren kopia av Git-innehållet och avsedda ändringar: **4 sviter, 62 tester** godkända utan privata loggar, externt startminne eller `dirigent/`. |
| Statisk kontroll och paketering | ESLint utan anmärkningar; Homeys validering för publicering godkänd; `git diff --check` och loggskriptets syntaxkontroll godkända |

ETA-mätningen har upprepats över samma 23 historiska korpusar efter sista
rättelsen. Alla publicerade påståenden, textantal och mätresultat är exakt
identiska med underlaget till ETA-tabellen ovan. Den nya kortkorpusen ingår
inte i före/efter-populationen.

Tidigare i granskningen passerade även fusion över alla dåvarande
23 korpusar med normal och 60 sekunders fördröjd leverans och fem
fältvarianter. Den separata fusionsmatrisen föregår de sista UI- och
passagerättelserna; den räknas inte som upprepad slutkontroll.
Informativa heuristikvarningar och rådatans okända tidsordningar kvarstår
synliga och räknas inte som bevisat korrekta passager.

Produktfilerna har hashkontrollerats före och efter slutkörningarna.
Tre granskare och dirigenten har inga öppna reproducerbara produktfel
efter sista motgranskningen. **Grönt ljus gäller kodändringarna och de
redovisade kontrollerna.** Långfältets dataintegritet är fortsatt FEL;
förvarning vid varje verklig passage och framtida fart kan inte styrkas
av det tillgängliga underlaget.

Detaljerade råutdrag, fryst baslinje, före/efter-resultat och kritikersonder
finns lokalt i `/tmp/ais-audit-20261005/`. Rapporten och regressionstesterna
bevarar slutsatserna i repot; stora privata fältloggar har inte lagts till.
