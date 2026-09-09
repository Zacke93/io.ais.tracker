# Inför nästa fältprov

Denna körbok kompletterar produktionsgranskningen av 23–24 augusti och
avser arbetskopian efter den förnyade kontrollen den 6 september. Ingen
installation eller publicering görs av granskningsarbetet.

## Produktbeteende

- `Båt nära → Alla broar` kan matcha varje bro längs samma fartygs resa.
  Använd tokenen **Notistext** i Flow-notisen för appens färdiga mening.
- Bekräftad väntan vid den notifierade öppningsbara bron visas som
  ”X inväntar broöppning vid Y”, utan minutprognos. `eta_available` blir
  falskt och `eta_minutes` blir −1. Passerad-formerna har företräde.
- En bortfallen AIS-källa ska ge både Homey-notis och försämrad
  anslutningsstatus enligt befintliga tidsgränser.
- En styrkt brokö får fortsätta över två timmar när båten ger färska
  positionsrapporter. Det gäller alla fyra öppningsbara broar, i båda
  riktningarna, även när väntbron och resans målbro är olika.

## Ytterligare rättningar inför provet

### Homey-publicering efter långsamma svar och omstart

Ett `createToken`-svar som kommer efter timeouten bevaras nu och används
för aktuell brotext. En redan registrerad global token återanvänds.
Synkrona skrivfel frigör också timeouten. Gamla köade skrivningar får inte
starta i en ny app-livscykel, och sena svar får inte lämna gamla värden på
enheter eller den globala tokenen. Regressionstester använder fördröjda
Homey-svar och kontrollerar det faktiska slutvärdet, även med flera enheter.

### Kajavgång behöver positionsbevis

En båt som redan bevisats förtöjd i en känd kajzon får behålla klassningen
vid ett brusigt fartprov på plats. DORY MAN:s falska prognos på 21–22 minuter
försvinner. I den låsta jämförelsebanken väntar två verkliga avgångstexter
32 respektive 53 sekunder på tydlig förflyttning; alla notiser och
öppningsvarningar behåller sina tider. Rådata, avvägning och den enda
berörda facituppdateringen finns i [kajgranskningen](kajgranskning-2026-09-06.md).

### Driftens minutloop ingår i ett extra långtidsprov

`npm run replay:monitoring` driver 72 timmar med den riktiga minutloopen,
TTL-städning, stale-svep och två omstarter. Kontrollen kräver att loopen
faktiskt startat även efter omstarter och att inga timers finns kvar efter
nedstängning. Nätklienterna är oanslutna i replay; deras beteende granskas
separat i klient- och sockettester.

### Lång väntan kräver både anflygning och färsk AIS

Enbart närhet, två fartspikar eller en tidigare väntstatus räcker inte för
obegränsad väntan. Appen kräver minst 50 meters styrkt nettoförflyttning
mot samma bro, en bekräftad väntstatus före brolinjen och fortsatt färska
positionsrapporter. Rapporter på identiska koordinater är giltiga när
rapporttiden är ny. Känd kaj och navigationsstatus för ankring/förtöjning
behåller företräde. Köbevis följer den pågående resan och återanvänds inte
ur grav eller permanent cache.

AISHub kunde efter sin dedupliceringsgräns återleverera samma gamla
position som ny. Ett åldersskydd före dedupliceringen stoppar nu råa
positioner äldre än den befintliga tolvminutersgränsen. Källan kan vara
frisk även när just ett fartyg har slutat sända. Positionslösa livstecken
förnyar därför inte fartygets positionsålder.

Appen vet inte om en AIS-sändare är avstängd. Efter tio minuter utan en
bekräftad position är köläget osäkert; det ska inte i sig tolkas som ny
förtöjning. Det befintliga skyddet som döljer gammal trafik efter 25 minuter
och tar bort den efter cirka 30 minuter består. En ny fix innan borttagning
kan återuppta samma styrkta kö utan krav på att den stillastående båten
förflyttar sig igen.

## Slutkontroller den 6 september

| Kontroll | Resultat |
|---|---|
| Hela Jest-urvalet | 3 505/3 505 tester i 232 sviter; de 15 riktiga sockettesterna kördes separat och är också gröna. Totalt 3 520 tester. |
| Lång brokö | 25 adversariella fall, inklusive alla fyra öppningsbara broar i båda riktningar. Två fullapp-prov visar obruten väntan under fyra timmar och borttagning vid efterföljande AIS-tystnad. Ingår i Jest-talet ovan. |
| AISHub och fusion | Åtta nya tester för gammal cache, 365 godkända källtester samt full fusionsgrind med lagg och klockskevhet. Källtesterna ingår i Jest-talet. |
| Inspelade körningar och öppningar | Alla 17 låsta korpusar godkända. Öppningsgrindarna godkända; den olåsta 42h-körningen redovisas separat nedan. |
| Namngivet fassvep | `20260611-4h`: alla sex fasvarianter godkända. De längre, strikt avvikande svepen redovisas nedan. |
| Syntetiska scenarier | Samtliga godkända; befintliga informativa varningar redovisas fortfarande. |
| 72 timmar, utan och med monitoring | Båda: 222 notiser, 72 målbropassager, 0 processfel och inga kvarlämnade timers efter två omstarter eller slutstopp. Monitoring: tre starter och 4 355 stale-svep. Sju befintliga informativa varningar i båda. |
| Homey-validering | Godkänd på nivån `publish`; manifestet regenererat från `.homeycompose`. |
| ESLint och diffkontroll | Inga fel eller whitespacefel; fyra befintliga radlängdsvarningar i korpusbeskrivningarna. |
| Fältdygn 23–24 augusti | 152 706 loggrader och 920 AIS-sampel integritetskontrollerade. Alla 24 notiser matchas utan bortfall/extra; sju får den valda vänttexten utan ETA. Högst 0,444 s skillnad i försökstid. |

Fältdygnets sju observerade öppningsvarningar matchas; tre ETA-värden
skiljer sig mot den historiska loggen enligt den tidigare granskningen.
En åttonde varning ligger efter fältstopp och är enbart simulerat efterspel.
Monitoring på samma dygn ger exakt samma notis- och öppningsobjekt som
standardreplay, 1 476 stale-svep och noll kvarvarande timers. DIANAs kända
Kanalinfarten-dubblett efter långt hamnstopp rapporteras fortsatt öppet.

`npm audit --omit=dev` kördes den 7 september efter användarens godkännande:
noll kända sårbarheter i produktionsberoendena. Kontrollen ändrade inga
beroenden. Den tidigare spärren för överföringen till npm är därmed löst.

Den 7 september lades även senaste fältdygnet in som `20260823-24h` med
byte-exakt AIS-fil och separat rådatafacit. Banken har nu 19 körningar,
varav 17 låsta. Senaste dygnet är fortfarande olåst: DIANAs andra notis
efter hamnstopp inväntar produktval och text-/öppningsfaserna har kvar
sina redovisade variationer.
Elva nya fullapp-tester skyddar dess 23 unika notisnycklar/riktningar,
sex målpassager och sju väntnotiser utan att frysa dubbelnotisen.
Omkörningen den 7 september gav 3 516/3 516 Jest-tester i 233 sviter;
de 15 sockettesterna på oförändrad klient var sedan tidigare gröna.
Alla 19 korpusar och öppningsgrindarna har körts; de 17 låsta är gröna.
Startskriptet väljer nu befintlig `dirigent/logs` i denna Mac-layout.

Fullständiga slutkörningsloggar finns under `/tmp/ais-pre-field-*-final.log`;
fältjämförelserna i `/tmp/ais-pre-field-report-final/` och
`/tmp/ais-pre-field-report-monitoring-final/`. Fusionslogg:
`/tmp/ais-aishub-stale-fusion.log`. Temporära artefakter är inte versionshanterade.

## Tolkning av kvarvarande avvikelser

134 mot det historiska antalet 135 i 42-timmarsprovet är en rättad
MARY-dubbelnotis, inte en belagd missad passage. Ett exakt fassvep kan vara
rött när en timer hinner före respektive efter en ny positionsrapport,
när en avrundningsgräns passeras eller när gammal position blir för osäker.
Rådataförklaringar finns i [fasgranskningen](fasgranskning-2026-09-06.md).
De befintliga grindarna behålls; oförändrat antal används inte som bevis
för identiska tider, prognoser eller konvojgrupper.

Efter köändringen har 42h-körningen 36 målbropassager mot tidigare 34:
MISTRAL och MOKENDEIST behåller nu Stridsbergsbron som mål genom den långa
väntan. En extra Klaffbron-varning som den gamla demoteringen skapade
försvinner (35→34), med bevarad fysisk öppningstäckning. Nästa gemensamma
varning kommer cirka 66 sekunder senare, fortfarande minst 7 min 21 s före
konvojens första passage. Exakta tider och medlemskap finns i
[långkörningsgranskningen](langkorning-2026-09-06.md).

Två låsta textfacit har uppdaterats efter oberoende rådatagranskning:
PILGRIM vid Järnvägsbron behålls korrekt i antalet på väg mot Klaffbron
(`20260713-41h`), och ANDREAs falska tiominutersglapp ”Inga båtar” under
lång Stridsbergskö försvinner (`20260804-both-21h`). Samtliga notisobjekt och
passageobjekt i dessa två korpusar är identiska före/efter; en öppningsvarning
i 41h kommer 2,762 sekunder tidigare, med samma båt och innehåll.

Den olåsta 42h-körningens fyra kvarvarande invariantutslag är de två
tidigare dokumenterade ankomst-/passagenotiserna efter lång väntan,
UTOPIAs 30 sekunders standardtext efter över 25 minuters AIS-glapp samt
fyra verkliga köbåtars långvariga ”strax”. Strikta fassvepet är fortfarande
rött: 20 avvikelser på 23/8 och 101 på 42h, mot tidigare 126 på 42h.
Inga nya undantag har införts för att dölja dem.

Kötid saknar fortfarande en säker minutprognos. En båt som först upptäcks
helt stilla har inte samma anflygningsbevis som en båt appen följt fram
till bron; tvåtimmarsskyddet består för sådan obestyrkt väntan. MISTRAL-
och MOKENDEIST-fallen används för att verifiera styrkt lång väntan och
efterföljande passage.

## Genomförande och observationer på Homey

1. Installera den färdigvaliderade arbetskopian med det vanliga fältflödet.
   Använd `run-with-logs.sh` för lokal, löpande loggfångst och sätt
   `debug_level=full` innan provet så att AIS-underlaget sparas.
2. Kontrollera att **Alla broar** är valt i det Flow som ska skicka
   notiser och att dess notisåtgärd använder **Notistext**. Ett lyckat
   app-kortanrop bevisar inte i sig att en pushnotis nådde telefonen.
3. Jämför telefonens notiser med `FLOW_TRIGGER_SUCCESS`, särskilt
   väntan/passage vid tätt liggande broar. Kontrollera enhetens brotext
   och det globala Flow-tokenvärdet efter en vanlig appomstart.
4. Följ faktisk brokö över två timmar, kajavgångar och konvojer. Anteckna
   observerad öppning/passagetid när möjligt; rå AIS kan annars bara
   ge ett tidsintervall för passager under radiotystnad.
5. Vid provslut: låt loggskriptet avsluta och göra integritetskontrollen.
   Kör därefter `npm run replay:field -- <app.log> <ais.jsonl> <utkatalog>`.
   Jämför även med `REPLAY_MONITORING=1` och redovisa efterspel separat
   från det som faktiskt hann observeras på Homey.

Loggmarkörerna `GLOBAL_TOKEN_RECOVERED`, `CAP_WRITE_RESTART_RECOVERY`,
`GLOBAL_TOKEN_ERROR`, `CAP_WRITE_TIMEOUT`, `FLOW_TRIGGER_ERROR` och
`STALE_AIS_SWEEP` hjälper till att följa de ändrade återhämtningsvägarna.
