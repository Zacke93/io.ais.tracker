# Vad fassvepets avvikelser betyder inför nästa fältprov

Slutkodens standardsvep är fortsatt strikt rött: 20 avvikelser för
23–24 augusti och 101 för 42-timmarskorpusen. Inga notis- eller
passagemultiset ändras med fasen. Den tidigare instabila Klaffbron-konvojen
efter den långa kön är nu stabil i samtliga prövade faser. Slutkontrollen
med och utan produktionens monitoringloop redovisas efter baslinjeanalysen.

## Mätt kodläge och kontrakt

Mätningen gäller arbetskopian vid början av den förnyade granskningen den
6 september, inklusive passagefixarna och användarens väntnotisbeslut. Den
kopierades till `/tmp/ais-pre-field-baseline-20260906` innan ytterligare
produktionsändringar. Siffrorna nedan är denna baslinje, inte ett påstående
om senare slutkod. Alla tider är UTC.

```sh
node tests/replay-validation/runPhaseSweep.js \
  dirigent/logs/ais-replay-20260823-185834.jsonl \
  tests/replay-validation/corpora-data/ais-20260806-42h.jsonl \
  --keep-temp
```

Svepet flyttar bara första samplets tidsfält. Efterföljande positioner och
deras inbördes tider är identiska. Det prövar var 30-sekunderstickarna hamnar
i förhållande till dessa positioner. I denna baslinje startar replay inte
produktionens separat schemalagda monitoringloop; den begränsningen måste
hållas isär från själva fasresultatet.

Grinden jämför notisernas multiset av fartyg/bro/riktning, målbropassager,
öppningsvarningarnas ledare/riktning/ETA/källa och brotexternas multiset.
Notis-ETA rapporteras separat och fäller inte. Notistider och medlemmarna i
en öppningsvarning ingår inte i dessa jämförelsenycklar. Därför har även de
fullständiga replayobjekten granskats här. Oförändrat antal bevisar inte
oförändrat innehåll eller leveranstid.

Inga undantag eller facitändringar införs genom denna analys. Grinden
förblir röd när dess exakta jämförelsekontrakt inte uppfylls. Ett rött
fassvep är inte ensamt bevis för tappade notiser eller ett driftsstopp.

## Baslinjens resultat

| Underlag | Notiser | Målbropassager | Öppningsvarningar | Brotexter i basen | Fasavvikelser |
|---|---:|---:|---:|---:|---:|
| 23–24 augusti, 920 sampel | 24 | 6 | 8 | 77 | 16 öppning + 4 text = 20 |
| 42 timmar, 3 922 sampel | 134 | 34 | 35 | 303 | 58 öppning + 68 text = 126 |

Sex förskjutningar kördes för varje underlag: −2,5, −5, −11,52, −15,
−20 och −25 sekunder. Alla varianter behåller respektive antal notiser,
målbropassager och öppningsvarningar. Inget notis- eller passage-multiset
ändras. Inga nya processfel uppkommer.

För 23–24 augusti är samtliga 24 kompletta notisobjekt dessutom exakt
identiska i alla sju körningar, inklusive text, ETA, avstånd och tid.
Den åttonde öppningsvarningen är fortfarande efterspel efter fältloggens
slut; siffran åtta får inte beskrivas som åtta observerade fältvarningar.

42-timmarskorpusen behåller samma 43 unika fartyg/bro-par i
öppningsservicens täckningsspår i samtliga faser. Detta är en separat,
informativ kontroll: den bevisar inte att varje täckning kommer i rätt
fysiska öppning. Samtliga öppningsvarningar ligger 0–29,902 sekunder efter
sin då gällande `dueMs`, alltså inom den befintliga ett-tick-marginalen.

## 23–24 augusti: tre förklarade klasser

### Avfyrning före eller efter nästa positionsrapport

TANGELAs första Klaffbron-varning avfyras i basen 08:31:48.116 med
avstånd 1 047 meter och ETA 7 minuter. Vid fas −11,52 avfyras den
08:30:36.596 med avstånd 1 262 meter och ETA 12 minuter. I den senare
varianten används fortfarande positionen mottagen 08:29:36.788. Nästa
rapport kommer 08:30:43.682, efter den tidiga varningen, och uppdaterar
ankomstprognos och deadline i de varianter som ännu inte varnat.

Detta är inte enbart avrundning, men heller inte två olika svar från samma
senaste position vid samma avfyrningstid. Motorn hinner i vissa faser varna
innan ny information flyttar deadlinen. Att frysa den tidigare prognosen
för att få identiska facit skulle ignorera färsk information.

PHOENIX visar samma mekanism tydligare. Klaffbron-varningen kommer i basen
14:23:18.116, avstånd 1 438 meter och ETA 24 minuter. Vid fas −5 kommer den
14:22:13.116, avstånd 1 514 meter och ETA 13 minuter. Nästa rapport mottas
14:22:13.956 och sänker farten från 3,3 till 1,8 knop. Den tidiga varningen
kan inte känna till fartminskningen som ännu inte mottagits. Klaffbron är
dessutom en senare bro medan PHOENIX väntar vid Stridsbergsbron; någon
prognos för denna kötid finns inte i modellen.

### Samma prognos, olika avrundningstid

PRIMA LADYs Stridsbergsbron-varning har samma senaste position, avstånd
1 168 meter och deadline 16:18:53.017. Basen avfyrar 16:19:18.116 och visar
8 minuter; fas −20 avfyrar 16:18:58.116 och visar 9. Prognosen räknas vid
avfyrningen som `round((expectedArrivalMs - now) / 60000)`. Ett tick på
andra sidan halvminutsgränsen ändrar därmed den heltalsavrundade tokenen.

### En färskhetsgräns som hamnar strax före nästa rapport

PHOENIXs position bekräftas 14:27:49.423 och nästa gång 14:38:00.114,
ett gap på 610,691 sekunder. Gränsen för att fortfarande kalla positionen
färsk är 600 sekunder.

Vid fas −20 sker ett tick 14:37:58, när positionen är cirka 608,7 sekunder
gammal. Brotexten blir därför ”ETA okänd” i 30 sekunder och återgår sedan
till ”strax” efter den färska rapporten. Basens föregående tick ligger
14:37:48, vid cirka 598,7 sekunders ålder. Dess nästa tick ser redan den
färska rapporten och visar aldrig mellanläget.

Färskhetsregeln fungerar konsekvent i båda körningarna. Att lägga till
extra tilltro till gammal position enbart för att dölja denna övergång vore
ett nytt beteendebeslut. Det behövs ingen produktfix för att uppfylla det
befintliga 600-sekunderskontraktet.

## 42 timmar: innehåll och konvojgruppering kräver egen bedömning

### 134 mot 135 är ingen belagd missad äkta notis

`corpora.js` dokumenterar redan varför förväntat antal fortfarande är 135:
det är inspelningens historiska antal, avsiktligt bevarat tills korpusen
låses. C4b tog bort en extra MARY-notis vid Klaffbron som uppstod när samma
sydgående passage felaktigt bokfördes under både nordlig och sydlig
riktning. Den äkta notisen kvarstår med rätt riktning. Detta är därför
facitreconciliation efter en tidigare rättning, inte evidens för ett
aktuellt notisbortfall. Separata ankomst- och passagenotiser efter långa
väntetider är dessutom uttryckligen tillåtna enligt användarbeslut U5.

### Notisformen för NOSSAN påverkas av den generella statusspärren

NOSSAN når 240 meter från Klaffbron 01:21:00.242, vid 4,8 knop. Notisen
går exakt då i alla faser. Basen säger ”beräknad ankomst om 2 minuter”;
alla sex fasvarianter säger ”inväntar broöppning”, utan minutprognos.

Basens timer avslutar först passagevisningen för Järnvägsbron och sätter
`passed → approaching` 01:20:56.738 på den föregående positionen, 415 meter
från Klaffbron. Den nya rapporten bedöms som `waiting`, men den generella
femsekundersspärren håller kvar `approaching`: bara 3 504 millisekunder har
gått. Vid fas −5 skedde timerövergången fem sekunder tidigare, så
`approaching → waiting` godkänns när samma färska rapport kommer.

Väntnotisen följer alltså korrekt den slutligt accepterade statusen. Att
kringgå denna status enbart i textbyggaren skulle skapa två olika
bedömningar av samma fartyg. En eventuell förbättring ska i stället pröva
hur den generella statusspärren behandlar färska bevis på framåtrörelse
efter en timerorsakad övergång, med korpusmätning av hela ändringen.

Fem ytterligare notisobjekt ändrar bara tid i fasvarianterna. Det är
Järnvägsbron-notiser för TIDAN, NOSSAN, ELFKUNGEN, MOKENDEIST och DORY MAN.
De behåller text, ETA, bro, riktning, källa och avstånd. Deras timerdrivna
statusövergångar flyttar sig med tickarnas fas.

### Samma fysiska konvoj, olika varningsmedlemskap

I basen avfyrar `Klaffbron#27` 11:45:26.698 med MISTRAL som enda medlem.
Fas −5 avfyrar 11:44:21.698 med MOKENDEIST som enda medlem. Vid fas −15
avfyrar den 11:44:37.133 med båda båtarna. Senare avfyrar `Klaffbron#29`
med MOKENDEIST och MS JUTLAND i basen, MISTRAL och MS JUTLAND vid fas −5,
eller FILOU och MS JUTLAND vid fas −15. Övriga båtar absorberas som täckta.

Rådatafacitet ger Klaffbron-passager 12:22:20 för MS JUTLAND, 12:22:52
för FILOU, 12:24:10 för MOKENDEIST och 12:24:33 för MISTRAL. Alla fyra
passerar alltså inom cirka två minuter och fjorton sekunder. De har
täckning i samtliga faser, men klustringen av prognoser och tidsgränsen
för absorberade armar gör medlemskap och senare varningsledare instabila.

Detta får inte beskrivas som enbart minutavrundning. I denna baslinje var
det en begränsning i modellen för vilka fartyg som delar en framtida öppning.
Tidigare försök att bredda täckningen har enligt arkitekturen orsakat
ovarnade öppningar och splittrade konvojer; `U9_RESCUE_COVERAGE` är därför
avsiktligt avstängd. Det finns inte tillräcklig evidens här för att slå på
den eller ändra konvojfönstret inför nästa fältprov.

## Slutkontroll efter beslutet om obegränsad bekräftad broväntan

Slutmätningen omfattar köfixen, kajavgångsfixen och runtime-fixarna den
6 september. Bevisad anflygning till rätt, opasserad bro får behålla kön
efter två timmar när positionen är färsk och båten är på ankomstsidan.
Riktiga kajzoner och navstatus för ankring/förtöjning behåller sina regler.
Positionslösa livstecken förnyar inte positionsåldern. Samma råa position
med gammal AISHub-tid får inte återkomma som en ny fix efter dedupens TTL.

Oberoende granskning omfattade alla fyra öppningsbroar i båda riktningar,
Olidebron efter den sista målbron, falska fartspikar hos nyupptäckta
stillabåtar, riktning/resreset, överlappande parbrozoner, navstatus/kaj,
gamla eller osäkra fixar och 10/30-minutersgränserna. Ett reproducerat fel
vid långsam förhalning med fortsatt rapporterad nollfart rättades:
ackumulerad nettorörelse från stillhetsankaret bryter den gamla köns
stillhetsklocka även när inget enskilt steg når 50 meter. Därmed kan båten
korsa brolinjen utan att först bli felklassad som förtöjd.
`tests/bridge-queue-adversarial.test.js` har 25 gröna fall.

Standardsvepet kördes med samma kommando och sex offsets som baslinjen.
För 42 timmar kördes även följande utökning för båda halvorna av
monitoringloopens 60-sekundersperiod:

```sh
REPLAY_MONITORING=1 node tests/replay-validation/runPhaseSweep.js \
  tests/replay-validation/corpora-data/ais-20260806-42h.jsonl \
  --offsets=-2.5,-5,-11.52,-15,-20,-25,-30,-32.5,-35,-41.52,-45,-50,-55 \
  --keep-temp
```

| Slutkod | Notiser | Målbropassager | Öppningsvarningar | Texter i basen | Strikta fasavvikelser |
|---|---:|---:|---:|---:|---:|
| 23–24 augusti, sex offsets | 24 | 6 | 8 | 77 | 16 öppning + 4 text = 20 |
| 42 timmar, sex offsets | 134 | 36 | 34 | 293 | 48 öppning + 53 text = 101 |
| 42 timmar, monitoring, tretton offsets | 134 | 36 | 34 | 293 | 96 öppning + 106 text = 202 |

Alla 28 kompletta resultatobjekt granskades, utöver grindens jämförelser.
Samtliga körningar har noll processfel, noll shutdown-fel och noll
kvarvarande timers efter shutdown. Monitoring kör verkligen: en start och
2 547–2 548 städsvep per körning. Ingen variant är överhoppad eller omätt.

Fältdygnets samtliga 24 fullständiga notisobjekt är fortsatt byteidentiska
i alla sju faser. 42-timmarskorpusens samtliga varianter behåller samma
43 unika fartyg/bro-par i öppningstäckningen, även jämfört med den första
baslinjen. Det är samma mängd par, inte bara samma antal. Alla varningar
ligger fortfarande 0–29,902 sekunder efter sin då gällande deadline.

### Vad som försvann och vad som finns kvar

Den falska tvåtimmarsdemotionen av MISTRAL och MOKENDEIST försvinner. Deras
Stridsbergsbron-passager bokförs nu som målpassager i alla faser, vilket
förklarar 34 → 36; det är inga tillagda fysiska korsningar. Den tidigare
extra Klaffbron-varningen efter kön försvinner, 35 → 34. Mellan 11:20 och
12:30 den 7 augusti finns nu exakt en Klaffbron-varning i samtliga sju
standardfaser och fjorton monitoringfaser: `Klaffbron#29` klockan
12:14:58.542, FILOU och MS JUTLAND, FILOU som ledare, ETA 9. Hela det
varningsobjektet är identiskt mellan faserna. Konvojfönstret och
`U9_RESCUE_COVERAGE` ändrades inte för att få detta resultat.

Andra framtida prognoser varierar fortfarande när nästa rapport kommer
före eller efter avfyrningen. Exempel: `Klaffbron#22` har samma fem
medlemmar i alla faser, men basen varnar 09:13:56.698 med MISTRAL som
ledare och ETA 16. Vid −20 och −25 sekunder kommer varningen från en
fix 09:13:57.997, med AGULHAS som ledare och ETA 23. Det är prognoser för
en senare bro; de inkluderar ingen känd kötid vid en tidigare bro.
Denna begränsning är fortfarande synlig i den strikta grinden.

NOSSANs tidigare analyserade skillnad mellan bekräftad `approaching` och
`waiting` kvarstår exakt. De fem Järnvägsbron-notiser som tidigare ändrade
bara avfyrningstid gör fortfarande det, inom 25 sekunder. Inga ytterligare
notisfält varierar med fasen. Fältdygnets skillnader vid nästa positionsfix,
minutavrundning och tio minuters dataålder är också oförändrade.

### Monitoring: en avgränsad tidsartefakt i replay

Vid samma sex offsets och basfasen har normal replay och monitoring
byteidentiska notis-, målpassage-, öppnings- och täckningsobjekt. Enda
skillnadsklassen i brotext är att FARUREJs ändring från 18 till 19 minuter till
Stridsbergsbron publiceras 15:51:10.156 i stället för 15:50:40.121 den
7 augusti i basfasen: +30,035 sekunder i replay. Vid −20 och −25 sekunder
är även brotexternas fullständiga objekt identiska mellan körlägena.

Den kompletta verbose-jämförelsen visar orsaken. Monitoring städar bort
VALKYRIA, MMSI 275049245, efter 31 minuters AIS-tystnad. Hon var redan
utesluten ur brotexten, men hennes kvarvarande Klaffbron-mål fick standard-
körningen att välja den globala uppdateringskön. Efter raderingen används
Stridsbergsbrons kö och en minutforcerad enhetsskrivning av den oförändrade
18-minuterstexten sker före FARUREJs nästa uppdatering.

FARUREJs råfix 15:50:40.096 är identisk i båda körningarna:
58.30769/12.31345, 4,5 knop, 1 923 meter till Stridsbergsbron. Båda räknar
rå ETA 19,4 och samma utjämning 18,4 → 18,8. Monitoringvägen går därefter
genom appens loggade 200 ms micro-grace; standardvägen publicerar direkt.
Replay använder synkron `clock.tick()` i upp till 30-sekunderssteg och
dränerar Promise-fortsättningar efter steget. Den 200 ms långa pausen
rastreras därför till följande stegslut. Samma begränsning är redan
beskriven vid `_shouldApplyMicroGrace` i app.js och J32-testernas kontrakt.

Detta belägger en 200 ms stabiliseringspaus i produktkoden och en
30-sekundersrastrering i testharnessen. Det belägger inte att Homey får
en motsvarande 30-sekundersfördröjning. Den tidigare texten innehåller
fortfarande samma båt och bro; ingen notis eller öppningsvarning påverkas.
Någon bred omläggning av replayklockan eller produktens micro-grace görs
inte för att dölja tidsartefakten.

Slutartefakter: `/tmp/ais-final-phase-default.log`,
`/tmp/ais-final-phase-monitoring.log` och fullständiga resultat i
`/tmp/ais-final-phase-field.json`, `/tmp/ais-final-phase-42h.json` samt
`/tmp/ais-final-phase-42h-monitoring.json`. Den sista innehåller basen och
alla tretton varianter. Monitoringförklaringen bygger på
`/tmp/ais-final-phase-default-verbose.log` och
`/tmp/ais-final-phase-monitoring-verbose.log`.

## Slutsats för användning av grinden

En fasoberoende låsning av dessa underlag är fortfarande inte belagd.
Samtidigt är de analyserade färskhets- och avrundningsgränserna ingen
anledning att kalla appen opålitlig i allmänhet. Utvärdera nya ändringar
mot fullständigt innehåll, fysisk passage och täckning; använd inte ett
enskilt rött avvikelsetal som ersättning för den bedömningen.

Kvarstående konvoj- och statusgränser ska finnas kvar som synlig mätning.
Nästa fältprov behöver särskilt fånga längre väntan, flera fartyg vid samma
bro och leveransen genom Homey. Inga facit lättas och ingen produktlogik
ändras av denna dokumentation.

Artefakter från baslinjen: `/tmp/phase-readiness-20260906.log`,
`/tmp/phase-readiness-field.json`, `/tmp/phase-readiness-42h.json` och
`/tmp/phase-readiness-notification-differences.json`. De två JSON-filerna
med fulla replayresultat innehåller basen och samtliga sex fasvarianter.
