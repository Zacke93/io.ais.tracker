# Granskning av körningarna 17–18 september 2026

Båda fullständiga loggarna har behandlats i integritets-, händelse- och
diagnossvep. Avvikande händelseförlopp har följts mot rå AIS och kod.
Kodgranskningen omfattar huvudappen, anslutningar/fusion, samtliga tjänstelager,
geometri och övriga hjälpare, Homey-enheten, inställningssidan, manifesten samt
logg- och replayverktygen. Tre Astra Max-agenter granskade separata delar och
följde upp reproducerade fel parallellt med huvudgranskningen.

Gröna tester belägger de kontrollerade beteendena. De är ingen garanti för
alla framtida AIS-förlopp, fysisk brostatus eller leverans till telefonen.

## Underlag

Alla klockslag nedan är UTC. Originalen ligger i `dirigent/logs/`.

| Körning | Loggintervall | Loggrader | AIS-poster | Närnotiser | Öppningsvarningar | Målpassager |
|---|---|---:|---:|---:|---:|---:|
| `20260917-121704` | 17/9 10:17:18–17:32:00 | 65 645 | 618 | 14 | 6 | 4 |
| `20260917-194542` | 17/9 17:45:53–18/9 09:59:30 | 121 809 | 838 | 38 | 14 | 12 |
| Totalt | cirka 23,5 timmar | 187 454 | 1 456 | 52 | 20 | 16 |

- Inga loggluckor över 180 sekunder; samtliga JSONL-rader matchar loggens
  `AIS_REPLAY_SAMPLE` i ordning och innehåll. Inga trasiga JSON-poster hittades
  bland accepterade fixar, avvisade källfixar eller sparade AISHub-svar.
- Alla 53 sparade avvisade AISstream-fixar är `cross_feed_duplicate`.
  Det är källornas dubblettfiltrering, inte 53 förlorade nya positioner.
- 1 250 AISHub-svar finns i loggarna. Hälsoserierna visar inga nät-,
  autentiserings-, format- eller parsningsfel.
- 308 kvitterade enhetsskrivningar av brotext har `readback=match`.
  Alla 310 kvitterade globala token-skrivningar har `sdk=ok, late=false`.
- V8-heapen ligger inom 12,9–16,1 respektive 13,0–17,1 MB i dessa loggar.
  Enda `[err]`-raden i vardera körningen är den redan hanterade plattformsbristen
  `uv_resident_set_memory/ENOENT`: RSS saknas, medan V8-serien fortsätter.
  Den diagnosen har inte dolts eller tolkats som en appkrasch.
- AISstreams sex tystnadsvarningar och första körningens watchdog-omanslutning
  är granskade mot källhälsan. AISHub fortsätter leverera under tiden.

De två nya testkorpusarna innehåller byteidentiska AIS-filer och deras inspelade,
icke-hemliga startminne. SHA-256 för JSONL:

```text
20260917-121704  0d770c0704dd051682ccc778bca73d1b34033f53bef73a198c9c534bf22fdce8
20260917-194542  26807b03d613bbf509d8412af710a782a9ad5ffc0c4e867f17debc1106c7a26e
```

## Rättningar i appen

1. **Stillastående GPS-jitter kunde bli en målbropassage.**
   `VesselDataService` kunde låta sin avståndsreserv åsidosätta geometrins
   uttryckliga `stationary_jitter_no_passage`. Två nästan stilla positioner
   20 meter på var sida om brolinjen flyttade då målbron. Reserven kompletterar
   nu endast `no_passage_detected`. Riktig rörelse och okänd fart kontrolleras
   separat i `target-passage-stationary-jitter.test.js`.

2. **Gammal fart förvandlade okänd fart till felaktigt stillhetsbevis.**
   VDS ersatte en rå `sog=null` med äldre låg fart innan fysikkontrollen.
   GPS-analysen, kandidatbekräftelsen och rörelserimligheten läser nu fixets
   råa fart. Presentationens avsiktliga fartminne består. Regressionerna i
   `gps-raw-speed-plumbing.test.js` prövar båda sidorna av fixparet och
   kontrasten mellan verklig låg fart, okänd fart och orimligt hopp.

3. **Ett nytt GPS-störningstillfälle ärvde ett förbrukat skyddsfönster.**
   Stabilizern fick osäkra statusförslag men ingen återhämtning när en ren fix
   kom. Nästa hopp kunde därför byta status direkt. En uttryckligen ren, färsk
   positionsanalys avslutar nu den gamla episoden för just det fartyget.
   Timerpass, gammal AIS och fortsatt osäkerhet återställer inte skyddet.
   Sex publika regressioner finns i `status-stabilizer-recovery.test.js`.

4. **Ofullständig eller upprepad avstängning kunde krascha eller radera minne.**
   `onUninit` antog att borttagningskartan fanns. Efter tidigt startfel eller
   ett andra avstängningsanrop bröts städningen och processlyssnare kunde bli
   kvar. En avbruten återstart kunde dessutom skriva förra körningens tömda
   kajkartor till lagringen. Avstängningen är nu idempotent; endast en start
   som hunnit läsa in sitt tillstånd får flusha det. Tre integrationstester
   prövar första startfelet, avbruten återstart och dubbel avstängning.

5. **Skuggjämförelsen återanvände redan parade leveranser.**
   Stream→Hub→Stream kunde räkna samma hubbrapport två gånger med olika
   latenstecken. Ett godkänt par förbrukar nu båda leveranserna.

6. **Skuggjämförelsen missade rapporter inom sitt avståndskrav.**
   Ett fast 3×3-rutsvep missade positioner 1,13–1,18 meter bort trots gränsen
   1,5 meter. Samma fartygs poster i det befintliga begränsade indexet prövas
   nu på faktiskt avstånd. Sju regressioner i
   `shadow-pairing-uniqueness.test.js` täcker båda parningsfelen.

7. **Öppningsdiagnosen påstod bekräftad väntan vid `null`.**
   När en tidigare bropassage fortfarande saknade bevis kunde loggen felaktigt
   kalla det bekräftad väntan. Den anger nu rätt orsak och bro. Brotextens
   dokumentation är samtidigt synkad med beslutet från 12 september: färsk,
   bekräftad väntan vid själva målbron behåller ”strax”.

8. **En ny passage förnyade inte en bevisat fortsatt resa.**
   Efter ett 19-minuters AIS-glapp kunde en färsk Olidepassage med 3 kn råfart
   lämna den gamla borttagningstimern orörd. Båten raderades elva minuter
   senare, före nästa fix, med Klaffbron framför sig. Nu förnyas den vanliga
   30-minutersfristen när senaste fixen visar ren transit, bokförd passage och
   en opasserad målbro framför båten. Stopp, okänd råfart och GPS-osäkerhet
   förlänger inte resan. `j17-continuing-passage-retention.test.js` prövar
   hela kedjan samt de tidigare spökfallen AKIRA och MISTY, med och utan
   minutstädning. Ingen visningstid eller generell tystnadsgräns har höjts.
   Även ANTARES och SENTA bevaras nu genom rådatabelagda Olidepassager;
   detaljer och följande publiceringstider finns i
   [J17:s fältverifiering](j17-faltverifiering-2026-09-18.md).

9. **GPS-hopp kunde skicka närnotis efter att det korta tidslåset löpt ut.**
   Ett syntetiskt 500-metershopp gav notis från den felaktiga positionen efter
   30 sekunder, innan nästa rena fix. Alla tre notisingångarna använder nu
   passageanalysens befintliga beviskrav samt aktivt GPS-lås. En rimlig
   förflyttning efter långt AIS-glapp är fortfarande tillåten: ELFKUNGENs
   rådatabelagda nord- och sydpassager kontrolleras separat. Notisen spärras
   före dedupbokföringen, så den riktiga ankomsten kan avfyra exakt en gång.

10. **Väntestatus vid en mellanbro kapade målbrons ETA.**
    I krypfartsprovet kapades cirka 69 minuter till Klaffbron av Olidebrons
    väntetak. Efterföljande publicering gav sedan 28→40→54 minuter trots
    jämn fart. Väntans tak och klamp binds nu till rätt bro. Kontrollfallet
    ger i stället 69→56→54 minuter med fortsatt två riktiga målpassager.

11. **Bevisad avgång kunde hållas tillbaka av väntans gamla prognos.**
    När det felaktiga taket rättades synliggjordes en andra felkedja:
    både kalkylatorn och publiceringslagret försvarade den gamla långsamma
    väntprognosen efter verklig avgång. ANTJE kunde då visas med 72 minuter
    trots att senaste möjliga råpassage låg inom 15 minuter; MISTRAL med
    55 trots högst nio. En ren, färsk förflyttning om minst befintliga
    50 meter, rimlig fysisk rörelse, rapporterad transitfart och minskat
    målavstånd släpper nu mellanbrons väntbaslinje. Publiceringslagret
    konsumerar ett bevis bundet till exakt målbro och positionstid, en gång.
    Osäker position, fartspik utan förflyttning och stigande ETA får inget
    undantag. ANTJE visar därefter cirka åtta minuter vid kontrollpunkten.
    MISTRALs publicerade prognos följer åter den aktuella beräkningen.

12. **En gammal konvojprognos kunde tysta nästa båts deadline.**
    SISUs prognos flyttades från 10:10 till 09:58 efter nya rena fixar.
    Den gamla prognosen kunde ändå binda ELFKUNGEN till samma varning och
    skjuta hans kort till 10:20. När den uppdaterade prognosen lämnat det
    befintliga tiominutersfönstret begränsas nu anslutningen av nya båtar.
    Redan given täckning består och en faktisk passage har företräde.
    ELFKUNGEN varnas 10:08:14.495, före råpassagefönstret 10:10:01–10:23:01.
    Ingen ny konvojgräns eller generell tidigareläggning har införts.

Felen 1–4, 8 och 9 är reproducerade integrationsfel, inte påståenden om att just de
händelserna inträffade under de två nya fältkörningarna. Skuggjämförelsens fel
kan också reproduceras på de bevarade accepterade fältpositionerna, men det
urvalet räcker inte för att återskapa produktionens fullständiga källstatistik.

## Rättningar i loggning och kontrollverktyg

- `run-with-logs.sh` blandade misslyckad BSD-`stat`-utdata med GNU-fallbackens
  tidsstämpel. Tystnadsvaktens tidsräkning kunde då krascha. Varje försök har
  nu separat resultatkontroll; felaktiga tidsstämplar går inte till aritmetiken.
- Loggens håldetektor räknade varje datumbyte som ett dygn. Ett helt saknat
  dygn kunde därför döljas. Beräkningen följer nu kalenderdagar och skottår.
- Replayåterskapandet kontrollerade `grep` men inte `sed`. Ett skrivfel kunde
  ersätta den hela inspelningen eller dess startminne med ett fragment.
  Båda processtegen måste nu lyckas före filbytet. Totalt 22 regressioner
  täcker dessa tre fel. GNU-fallbacken är prövad med kontrollerad GNU-utdata
  i Bash; ingen Windowsmaskin ingår i körningen.
- Öppningsrapportens H4/H4b band tidigare en varning till nästa passage vid
  bron, även om det var en helt annan båt. DORINDAs varningar blev då två
  skendubbletter på SUSANNEs senare resa. Gemensam bokföring kräver nu rätt
  fartyg eller belagd konvojanslutning, håller resor åtskilda och redovisar
  okänd ordning i AIS-glapp separat. O1/O2/O3:s godkännandekrav är oförändrade.
  Begreppet är passagegrupper: fysisk brostatus kan inte mätas ur AIS.
- O1b:s rådatamått kunde låna en varning inne i en tidigare resas
  korsningsintervall till nästa returresa. Även korta intervall behandlades
  som exakta punkter. Varningen binds nu till första möjliga passage och
  bedöms mot faktiska intervallgränser. På samma 24 sparade resultat ändras
  antalet säkert täckta 400→386, okänd ordning 25→38 och förklarade missar
  17→18. Oklassade missar är fortsatt noll, och appmåttet är oförändrat.
  Det är rättad mätning av samma händelser, inte en försämring i appen.
- Ett befintligt test låste `Math.random` till noll även när Jest formaterade
  ett förväntat fel. Source-map-sorteringen kunde då få stacköverskridning
  vid täckningsmätning. Just det testet använder nu vanlig slump eftersom
  det inte prövar jittertid. Dess fel- och timerkontroller är oförändrade.

## Granskade fältavvikelser

**DORINDA:** Klarar Kanalinfarten och Olidebron, därefter upphör positionerna
före Klaffbron. De två öppningsvarningarna gäller olika broar och följer den
beslutade deadlinevarningen under AIS-tystnad. Ingen målbropassage eller
närnotis där fabriceras. Texten åldras till okänd ETA och försvinner.

**KAPEREN:** Klaffpassagen ligger i AIS-glappet 09:33:09–09:43:22 den 18/9.
Nästa fix ligger 432 meter bortom bron. Appen skickar exakt en retroaktiv
notis, ”KAPEREN passerade Klaffbron under AIS-tystnad”, med ETA −1.
Det är en ärlig återvinning av en belagd passage; tidigare fysisk passage-
tid kan inte bestämmas exakt ur dessa data.

**SYBIL OF WIVENHOE:** Sen ankomst i andra körningen ger två deadlinevarningar.
Loggen slutar innan någon målpassage kan observeras. Det är inte bevis för
att passagen senare uteblev. Den 130:e replaytexten ligger efter loggstoppet
och redovisas som simulerat efterspel, inte som observerad fälttext.

**VISTEN:** Stridsvarningen 17/9 21:08:40 kommer 134 sekunder före appens
passageregistrering. Råfixarna avgränsar korsningen till 21:10:22–21:10:40,
alltså cirka 102–120 sekunders faktisk förvarning. Det är under riktmärket
150 sekunder, men över det hårda 60-sekundersgolvet. Föregående brospärr
och acceleration från 3,9 till 5,8 kn förklarar den tunna marginalen.
Fixet 21:08:31 anländer 21:08:40.136, räknar spärren till redan förfallen
och avfyrar i samma replaymillisekund. I fält kommer varningsraden 22 ms
efter samplet och leveranskvittot vid 21:08:40.597. Schedulerkontrollen
passerar; AIS-baserad prognos garanterar inte en exakt minsta fysisk ledtid
när båten accelererar mellan rapporter.

**Två informativa invariantvarningar:** Dagsfältets `INV-14W` jämför DORINDAs
tidigare text med SUSANNEs text 106 minuter senare. Tom kanal däremellan är
korrekt. Nattens `INV-18` jämför KAPERENs korta extrapolerade ”strax” med den
nya båten SYBILs längre prognos. Ingendera visar en felaktig ETA-förändring
för samma båt. Varningarna är kvar och inget invariantundantag har lagts till.

De syntetiska provens övriga informationsvarningar har också följts genom
hela förloppet. Tre tomtextintervall följer uttrycklig förtöjning eller
AIS-tystnad längre än visningsfristen. En riktningsvarning jämför en korrekt
notis med ett avsiktligt fördröjt gammalt fix. I det sydgående lågfartsprovet
ökar prognosen när modellens 15-minutersminne av passagefart löper ut;
råfarten är jämn. Det är en kvarvarande begränsning i prognosmodellen,
inte belägg för en faktisk inbromsning. Långtidstestets sex tomtextintervall
gäller avsiktliga 20-minutersstopp omkring en kilometer före Stridsbergsbron,
utanför brokön. Inga varningsregler eller domäntrösklar har lättats.

## Granskade ändringar i förväntade testresultat

Rå AIS och oberoende `gt-passages` har bevarats. Förväntad apptext och
apphändelser har däremot uppdaterats där rättningarna avsiktligt ändrar
beteendet. Underlaget är frysta före-/efterversioner över hela banken,
separata felreproducerande tester och granskning mot positionerna.

- J17:s fyra äldre korpusdeltan är beskrivna i den länkade fältverifieringen:
  rådatabelagda Olidepassager för ANTARES/SENTA samt följdändringar i
  publiceringstid. Tidigare stoppfall AKIRA och MISTY består.
- ETA-ändringarna berör text i 18 korpusar. När enbart minutfrasen,
  ”strax” och ”ETA okänd” normaliseras är hela följden av båtantal,
  målbroar och väntfraser identisk med baslinjen efter J17/GPS-rättningarna.
- Närnotisernas fartyg, broar och riktningar är oförändrade i hela banken.
  SENTA får samma Kanalinfartsnotis från det nu bevarade rörelsesegmentet.
  PRIMA LADYs minutvärde ändras 3→5 och OLAs 1→4; båda är sämre mot
  råpassageintervallet och redovisas nedan, inte som förbättringar.
- JAATTEN II/AVALON får ett gemensamt nordligt kort, medan SISU/SOLANDEs
  blandade kort delas i nordligt och sydligt. Båtarna är fortsatt säkert
  förvarnade. Netto i `20260708-21h`: Klaff mixed 1→0, south 4→5,
  north 4→4; totalantalet är oförändrat. De breda råintervallen avgör inte
  antalet fysiska broöppningar.
- CYGNUS behåller täckningen från BARAVI och behöver därför inget eget
  kort 09:51. Båtarnas råpassagefönster överlappar. Klaff north i
  `20260804-17h` ändras 8→7. ANYAs tidigare kort gäller samma belagda men
  senare avbrutna sydanflygning; det är inte en räddad verklig passage.
  AKIRAs kort flyttas 1,732 sekunder med den beräknade täckningens utgång,
  inom samma osäkra råpassageintervall. Övriga 22 ändrade kort berör bara ETA.
- Nattkontrollens A-arm ändras 44→45 texter, med samtliga 22 närnotiser
  identiska. TIMs 16 minuter före Olide stämmer med 14,93–16,04 minuter
  kvar till Klaff enligt råfixarna. TIDAN får följden 15→14→13 i stället
  för 12→13. Nattens passagefacit och godkännandekrav är oförändrade.

Med korrigerad mätning och slutlig produktkod omfattar öppningskontrollen
24 körningar och 442 målpassager: 386 säkert förvarnade, 38 med okänd
ordning och 18 klassificerade missar. Ingen tidigare säker förvarning
förloras och inga oklassade missar tillkommer. Öppningskorten minskar
434→433; passagegrupper med flera varningar 49→48. Båda nya fältens
sammanlagt 16 observerade målpassager är säkert förvarnade.

## ETA-modellens kvarvarande begränsning

Korrekt målbrobindning är inte samma sak som generellt bättre prognoser.
Den frysta mätningen över 23 korpusar ger följande för påståenden med
rådatapassage inom 60 minuter:

| Mått | Före ETA-rättningarna | Slutversion |
|---|---:|---:|
| Median absolutfel | 1,40 min | 1,46 min |
| Medel absolutfel | 5,31 min | 5,36 min |
| P90 absolutfel | 15,56 min | 15,56 min |
| Inom två minuter | 58,15 % | 57,41 % |

På 2 014 exakt gemensamma tid-/båt-/bropåståenden ändras 95: 49 blir bättre
och 46 sämre. De två nya fältkorpusarnas medelfel förbättras 2,35→2,09
respektive 1,86→1,81 minuter. Måttet använder rådatans interpolerade
punktpassager; passager med endast tidsintervall ingår inte i felstatistiken.

De största försämringarna har spårats separat. SOLUTIONs 33 minuter är den
aktuella råprognosen vid 0,1 kn före ett 8,5-minuters AIS-glapp som döljer
accelerationen; gamla 12 var ett felaktigt tak som råkade ligga närmare
framtiden. PRIMA och OLA har rå, skyddad och publicerad ETA lika vid
notisen, men den befintliga fartutjämningen reagerar långsamt på accelerationen.
OLA påverkas även av notisens befintliga reservregel med tre minuters marginal.
ANTJE, PILOT och CATHARINA har kontrollerats på samma sätt: det låsta
väntvärdet är borta, medan vanlig fartutjämning och EMA består. Inga
modellgränser har justerats enbart för att förbättra dessa historiska mått.

## Verifiering

Slutkontrollerna är genomförda med följande resultat:

- Full Jest-svit: **309 sviter, 4 391 tester godkända**, inklusive verkliga
  lokala sockettester. Täckning: statements 91,46 %, branches 87,96 %,
  functions 94,78 %, lines 92,61 %. Täckningskraven är oförändrade.
- `npm run lint`, `bash -n run-with-logs.sh` och `git diff --check`: godkända.
- `npm run replay:all`: alla 23 inspelade körningar, cirka 478 timmar, gröna.
- `npm run replay:synthetic`: 45 scenarier gröna; kvarvarande fem
  informationsvarningar är granskade ovan.
- `npm run replay:openings`: standardgrindarna godkända; rådatans 38 osäkra
  fall redovisas uttryckligen och räknas inte som säkra förvarningar.
- `npm run replay:fusion`: två pass över banken samt fem fältvarianter
  med leveransfördröjning och klockskevhet, godkända.
- `npm run replay:phase`, även med `REPLAY_MONITORING=1`: 161 återspelningar
  vardera, alla 23 korpusar gröna i båda lägena.
- `node tests/replay-validation/runSoak.js` och `npm run replay:monitoring`:
  72 simulerade timmar vardera, noll processfel. Monitoringvarianten gör
  tre starter och 4 355 städsvep; inga nedstängningsfel eller kvarvarande
  timers efter omstarterna eller slutstoppet. Sex avsiktliga stoppfall
  ger informationsvarningarna som förklaras ovan.
- `node tests/replay-validation/makeGtPassages.js --check`: godkänd.
- Båda nya fältjämförelserna med och utan monitoring: identiska
  notis-/öppningsjämförelser, textantal och efterspel, utan processfel.
- `homey app validate --level publish`: godkänd. Ingen installation eller
  publicering på Homey har gjorts.
- `npm audit --json`: noll rapporterade sårbarheter bland 503 beroenden.

De 36 produktfilerna i den slutliga frysta före-/eftermätningen är
byteidentiska med arbetskopians produktkod efter sluttesterna. En äldre
testdubbel använder nu det riktiga broregistret, och GPS-väntnotistestet
kräver uppskjuten notis med återhämtning och intakt deduplicering. Inga
produktändringar behövdes under den avslutande testsynkningen.

Fälten är låsta i notisfördelning, riktning, fullständiga händelser,
öppningsvarningar och brotext. Oberoende rådatafacit innehåller 14 respektive
38 korsningar/zonbesök och prövas i `september17-field-corpus.test.js`.

Slutlig fältjämförelse återger alla 52 närnotiser med samma innehåll,
utan saknade eller extra notiser; största tidsskillnaden är 53 respektive
30 millisekunder. Samtliga 20 öppningsvarningar finns kvar; två dagskort
och ett nattkort får ändrat ETA-värde. Brotexten har 69 respektive 135
övergångar före fältstopp, mot fältets 66/129. Nattens 136:e replaytext
ligger i det simulerade efterspelet.

En komplett replay återskapar appens beslut på det inspelade underlaget.
Den verifierar inte faktisk öppningsstatus, bortfall före loggfångsten eller
telefonleverans efter Homeys SDK-kvitto. Äldre korpusar innehåller dessutom
38 fall där varningens ordning mot passagen är okänd; de får
varken kallas säkra förvarningar eller bevisade missar.
