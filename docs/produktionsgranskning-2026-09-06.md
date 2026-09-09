# Produktionsgranskning efter fältprovet 23–24 augusti

Detta är den första granskningsomgångens resultat. Efterföljande rättningar
av Homey-skrivningar, kajklassning, lång brokö och gamla AISHub-positioner,
samt slutliga kontroller inför nästa prov, finns i
[fältprovskörboken](infor-faltprov-2026-09-06.md). Dess resultat har företräde
framför de historiska mätningarna och avgränsningarna nedan.

## Underlag och avgränsning

Granskningen utgår från HEAD `8a398bc`, de senaste 30 ändringarna och hela
`dirigent/logs/app-20260823-185834.log`. De två senaste ändringarna gäller
loggarkiv och paketering; produktionskoden i loggen (`a44fbaf`) är densamma
som före denna arbetsomgång. Tidigare beslut och återtagna fixar har jämförts
mot `ARCHITECTURE.md`, `VALIDATION.md` och Dirigentens fältrapport 11.

Loggen innehåller **152 706 rader** och sträcker sig från
2026-08-23 16:58:44.521 UTC till 2026-08-24 16:55:32.349 UTC
(18:58–18:55 svensk sommartid). Hela filen har skannats maskinellt;
avvikande händelseförlopp har följts i rålogg, AIS-positioner och kod.
Samtliga **920 AIS-sampel** stämmer med den sparade jsonl-filen:
359 från AISstream och 561 från AISHub. Filen innehåller redan fusionens
utdata och ska inte skickas genom fusionen en andra gång.

Filens SHA-256 är
`604bfdbc1406d7a9879fdfc8f8fa176ac35c105ad69108339d2bd08690b9a7e6`.
Den innehåller 78 647 tidsstämplade poster, 237 diagnostaggar och inget
tidsbaksteg. Största mellanrum mellan två loggposter är 30,007 sekunder.

## Vad dygnet belägger

- Inga appkrascher. Den enda `[err]`-raden gäller otillgänglig RSS-mätning
  i Homey-containern; V8-heapmätningen fortsätter fungera.
- 24 lyckade `boat_near`-kortanrop. Rådatafacitets 23 korsningar/zonbesök
  täcks, men två notiser är efterhandsbesked vid AIS-luckor.
- Sju öppningsvarningar före fältstoppet. Den sista båtens fortsatta resa
  saknas i loggen och får inte räknas som en verifierad förvarning.
- DIANA får två Kanalinfarten-notiser efter ett drygt två timmar långt
  hamnstopp. Det är befintlig tidsbaserad deduplicering med nytt rörelsebevis;
  återspelningens dubblettinvariant flaggar fortfarande detta öppet.
- Båda AIS-källorna levererar. Två watchdog-omanslutningar av AISstream
  återhämtas direkt. Samtliga 1 276 AISHub-pollar ger välformade svar utan fel.
- Heapens observerade värden går från cirka 13,2 till 16,5 MB. Detta dygn
  bevisar inte att långsam minnestillväxt är utesluten.

Ett lyckat Flow-kortanrop bevisar att Homey accepterade anropet. Det bevisar
inte att ett visst användarflöde matchade, att ett externt pushmeddelande
levererades eller att dashboarden visade rätt värde. Loggens två Flow-filter
matchar Olidebron och Stallbackabron; användaren har tillfrågats om det är
avsiktligt.

## Genomförda åtgärder

### Passage genom brolinjens osäkerhetsband återvinns efter bekräftelse

PRIMA LADY korsar Olidebron med ett AIS-sampel cirka fem meter bortom
brolinjen. Det ligger inom geometrins tiometersband där sidan är osäker.
Nästa sampel låg tydligt efter bron, men den tidigare positionen före bron
hade redan tappats bort. Passagen bokfördes aldrig och ETA-kalkylatorn
fortsatte räkna med ett felaktigt ben tillbaka till Olidebron.

Ett kort, rörligt inträdessegment får nu bevara en kandidatposition före
bron. Först en efterföljande fix på entydigt motsatt sida bekräftar beviset.
Kandidaten förfaller vid GPS-osäkerhet, bro-/episodbyte, stillhet, en lucka
längre än två minuter eller sammanlagd sträcka över 400 meter. En U-sväng
tillbaka till ingångssidan ger fortfarande ingen passage. Timerpass på
oförändrad position bekräftar inget nytt bevis.

För fältdygnets PRIMA LADY räknar den publicerade ETA:n nu ner
12→11→10→8→7 minuter, i stället för att stiga 12→14→15→16. Samtliga
24 `boat_near`-notiser har identiska tider, texter och övriga fält i
före/efter-replay. En öppningsvarnings ETA förbättras från 11 till 10 minuter;
varningstiden är oförändrad.

Samma fel återvinns för ANDREA i `20260804-both-21h`. Råpositionerna
2026-08-05 00:42:55–00:45:09 UTC visar en rak passage med 4,3–4,4 knop;
befintligt rådatafacit placerar Olidebron-passagen 00:43:42 och ankomsten
till Klaffbron 00:53:23. Den felaktigt stigande texten 12→13→14 minuter
ersätts med nedräkning. Endast denna korpus behöver ny golden-text
(313→314 övergångar), efter kontroll mot råpositioner av två granskare.
Antal notiser, varningstider, riktningar och målbropassager är oförändrade.
ANDREAs notis-ETA ändras 4→3 och öppningsvarningens ETA 10→7, båda närmare
den observerade ankomsten. Detaljer finns även vid korpusdefinitionen.

### Redan passerad parbro får inte tvinga väntestatus

PHOENIXs glesa positionsrapport bokför först Stridsbergsbron och sedan
Järnvägsbron. Flaggan för tvingad väntan vid Järnvägsbron skapas mellan dessa
två steg och kunde konsumeras vid nästa tick, trots att bron redan passerats.
`StatusService` omprövar nu passagebokföringen innan flaggan används och
rensar den även medan ett aktivt broöppningsfönster skjuter upp konsumtionen.
Regressionsprov täcker båda lägena, fortsatt bokföring av ytterligare en bro
och den legitima väntan framför nästa bro i paret.

I `20260707-14h` får rättningen dessutom samma text publicerad 10,042 sekunder
tidigare. EKEN har redan passerat Stridsbergsbron; dess gamla väntflagga får
inte fördröja BALTIC JONGLEURs aktuella sydgående positionsrapport. En
isolerad jämförelse med ursprungskoden visar att endast denna tidsstämpel
ändras, medan alla 111 texter, notisfält och målbropassager är identiska.
Även denna enda referenstidsstämpel har uppdaterats efter rådatagranskning.

### Inställningar skyddas vid läsfel och överlappande sparningar

Inställningssidan öppnade Spara trots att en eller flera `Homey.get`-anrop
misslyckats. Då kunde formulärets standardvärden skriva över lagrad
konfiguration. Sparning förblir nu spärrad efter ett läsfel och ett bestående,
översatt felmeddelande förklarar hur sidan laddas om.

Under en sparning spärras formuläret och ytterligare klick. Lyckade delsteg
bokförs så att ett nytt försök efter skrivfel bara skriver återstående
ändringar. Oförändrade värden skrivs inte. Tester kör sidans riktiga skript
med fördröjda och felande Homey-callbackar.

### Sen anslutningskod får inte återställa ett gammalt källval

Multiplexerns asynkrona omställning hade bara en nedstängningsflagga.
Ett äldre `connect`-anrop kunde fortsätta efter ett nytt källval och då
återstarta en bortvald AISHub-klient eller stänga den nyvalda klienten.
En generationsräknare gör nu äldre fortsättningar verkningslösa före både
skapande och nedmontering av klienter och timers.

### Osäker passagetid redovisas som intervall

Facitverktyget interpolerade PHOENIXs passage till en bestämd tid mitt i en
tolvminuterslucka som började med stillaliggande båt. Det gav skenbart exakta
ETA-felmått. Korsningspar längre än 120 sekunder där någon ändpunkt har
uppmätt fart under 0,5 knop markeras nu `inferred`, med hela tidsfönstret
bevarat. Tätare par behåller den tidigare approximationen: deras fulla
tidsosäkerhet ryms inom ETA-mätningens tvåminutersband. Saknad fart likställs
inte med stillhet. Befintliga låsta facitfiler har inte skrivits om.

För fältdygnets PHOENIX gäller det både Stridsbergsbron och Järnvägsbron
inom samma AIS-lucka: 23 korsningar/zonbesök kvarstår, varav 6 får
tidsintervall mot tidigare 4. En nygenerering av den äldre banken skulle
ändra 71 ytterligare punktposter till intervall. Äldre publicerade ETA-mått
använder fortfarande sina befintliga facit; de får inte beskrivas som
omkalibrerade av denna verktygsändring.

### Fältjämförelsen granskar även notisernas innehåll och tid

`tests/replay-validation/compareFieldReplay.js` kontrollerar logg/jsonl-
integriteten och jämför notiser på fartyg, bro, riktning, text, ETA, källa,
avstånd och tid. Misslyckade försök, saknade/extra händelser och invariantutslag
redovisas separat. Händelser efter loggens sista tidsstämpel räknas som
hypotetiskt efterspel, inte som observerade fälthändelser.

```sh
npm run replay:field -- \
  dirigent/logs/app-20260823-185834.log \
  dirigent/logs/ais-replay-20260823-185834.jsonl \
  /tmp/ais-field-20260823
```

Rapporten är informativ och låser inga nya facit. Efterföljande körningar
ska granskas för faktiska innehålls- och tidsändringar, även när antalet
notiser är oförändrat.

### Ankomstprognosens begränsningar förklaras i Flow-korten

Hjälptexterna förklarar att ETA inte inkluderar kötid eller väntan på andra
broöppningar, och hur `eta_available` och `message` används. Brotextens
format och befintliga Flow-tokenvärden behålls.

## Bekräftade produktval

Användaren har valt vänttext utan minutprognos: ”PHOENIX inväntar
broöppning vid Stridsbergsbron”. När notisen avser den bekräftade väntbron
blir även `eta_minutes=-1` och `eta_available=false`. StatusService binder
väntan till en bestämd bro före status-eventet; närmaste bro eller en annan
målbro får inte ärva väntformen. Passerad-formerna har fortsatt företräde.

En ensam tyst AIS-källa ska fortsatt ge både Homey-notis och försämrad
anslutningsstatus. Användaren vill kunna få notiser från alla broar.
Det stödet finns redan: ”Alla broar” i ”Båt nära” matchar varje
deduplicerad brohändelse under resan. De två befintliga Flow-filtren
begränsar endast dessa enskilda Flows, inte appens brostöd.

Vänttexten används via Flow-tokenen ”Notistext”. Befintliga manuellt
skrivna Flow-meningar ändras inte automatiskt.

### Verifiering efter väntbeslutet

Denna jämförelse utgår från kodläget efter produktionsfixarna ovan, före
vänttexten. Tidigare uppgifter om innehållsexakta notiser beskriver det
tidigare kodläget. En ny före/efter-replay av hela fältdygnet behåller alla
24 notiser med exakt samma tider, broar, riktningar, källor och avstånd.
Endast `message` och notisens ETA ändras, i sju notiser:

- TANGELA vid Olidebron och Klaffbron.
- PHOENIX vid Stridsbergsbron, Klaffbron och Olidebron.
- PRIMA LADY och DIANA vid Olidebron.

PHOENIX 2026-08-24 14:22:13.956 UTC får ”inväntar broöppning vid
Stridsbergsbron”, utan den tidigare prognosen tre minuter. Replayns övriga
utdata är exakt lika mellan kodlägena, inklusive brotexter, öppningsvarningar,
mål-/mellanbropassager och resestarter. Rapporten mot den faktiska loggen
har fortsatt den tidigare kända DIANA-dubbelnotisen efter ett långt stopp;
vänttexten ändrar inte den avvägningen.

Efter ändringen: 3 449 tester i 226 Jest-sviter godkända, inklusive 36 nya
tester för väntnotis och brobindning. Den oförändrade M12-socketsviten
ingick inte i omkörningen; dess 15 tester verifierades tidigare utanför
sandlådan. Samtliga 17 låsta korpusar, syntetiska scenarier och
öppningsgrindar godkända. Den olåsta 42h-korpusens tidigare avvikelser
kvarstår. Homeys `publish`-validering godkänd; lint har inga fel och fyra
befintliga radlängdsvarningar.

Granskningsartefakter från omkörningen: `/tmp/ais-waiting-comparison.json`,
`/tmp/ais-waiting-field/field-report.json` och
`/tmp/ais-waiting-{jest,corpora,synthetic,openings,lint,homey-validation}.log`.

Kömodell för ETA, deduplicering efter långa hamnstopp och tillåtna undantag
vid låsning av detta fältdygn är separata beteendebeslut. De införs inte
genom att ändra referensutfall tills tester blir gröna.

## Produktionsbedömning

| Kontroll på slutkoden | Resultat |
|---|---|
| Jest: helt testurval samt riktade omkörningar | Godkänt, över 3 400 tester. Manifesttestet kördes om efter Homeys regenerering; lokala sockettester krävde körning utanför sandlådan. Sista mux-/passageändringarna har egna godkända omkörningar. |
| ESLint | Inga fel; fyra sedan tidigare befintliga varningar om långa rader i korpusbeskrivningarna. |
| Homey `app validate --level publish` | Godkänt; `app.json` genererat från `.homeycompose`. |
| `npm audit --omit=dev` | Inga kända sårbarheter i produktionsberoendena vid kontrollen. |
| `replay:all` | Alla 17 låsta korpusar godkända; olåsta 42h redovisas separat. |
| `replay:synthetic` | Godkänt, åtta informativa varningar. |
| `replay:openings` | Godkänt. |
| `replay:fusion` | Godkänt, inklusive lagg och klockskevhet. |
| Fassvep `20260611-4h` | Alla sex varianter godkända. |
| Simulerad 72h-soak | 3 464 sampel, 38 fartyg, 222 notiser och 72 målbropassager; inga processfel, fatala invariantutslag eller kvarlämnade fartygsstrukturer. |

Soakens sju informativa varningar förekommer även i jämförelsekörningen
med ursprunglig statuskod, med samma antal notiser, textövergångar och
passager. Bland dem finns ETA-stigning och långa perioder med standardtext.
Simulerad tid och ett heap-slutvärde ersätter inte ett verkligt långtidsprov.

Den nya fullständiga fältjämförelsen ger 24/24 innehållsexakta notiser mot
loggen, med högst 0,444 sekunders skillnad i försökstid. Sju öppningsvarningar
matchas före fältstopp; tre har annan ETA än fältet. Två av dessa skillnader
fanns redan före rättningarna, den tredje är PRIMA LADYs förbättrade ETA.
Åttonde öppningen ligger efter loggstopp och är uttryckligen efterspel.

Fassvepet för just 23/8-dygnet är fortfarande rött: 20 känsligheter både
före och efter. Fördelningen ändras från 15 öppnings-/5 textavvikelser till
16 öppnings-/4 textavvikelser. En textavvikelse försvinner, medan PRIMA
LADYs öppnings-ETA varierar 10/11 minuter i en fas. Därför låses inte detta
dygn som ett nytt fasoberoende referensutfall.

Råresultaten har även jämförts före/efter i samtliga sju faser (baslinjen
plus sex förskjutningar): alla 24 notisobjekt och sex målpassageobjekt är
exakt identiska, inklusive tider. Även öppningarnas tider, ledare, riktning
och källa är oförändrade. Inga nya invariantutslag tillkommer; DIANAs
redan kända Kanalinfarten-dubblett kvarstår i varje fas.

Den äldre, olåsta 42-timmarskorpusen har redan före denna ändring avvikelser
i dubbletter, ETA och textövergångar. Den fortsätter redovisas som avvikande
och ingår inte bland de godkända låsta korpusarna. Fältdygnets DIANA-utslag
är också synligt i den nya rapporten; inga nya undantag har lagts till för
att kalla körningen felfri.

Publiceringsvalidering och automatiserade tester är nödvändiga kontroller,
men det finns kvar dokumenterade täckningsgränser: AIS-tystnad före första
rörelsebevis, kötid, initialt sparat tillstånd, monitoring-svepet som inte körs
av replay och faktisk leverans genom användarens Flows. Nästa fältprov ska
kontrollera dessa kanaler och de ändrade passagefallen på Homey.

Ingen installation, publicering eller push ingår i denna arbetsomgång.
