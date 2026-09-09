# 42h-korpusen: verifiering av samtliga kvarstående signaturer

Granskning 2026-09-06 av 20260806-42h, inklusive användarens nya beslut att
belagd broväntan ska kunna bestå längre än två timmar.
Alla klockslag nedan anges i UTC.
Baslinje före kaj- och köfix: 134 notiser, 35 öppningsvarningar,
303 textövergångar, 34 målpassager.
Efter enbart kajfix: samma samtliga notis-, öppnings- och passageobjekt,
300 textövergångar. Efter den belagda köfixen: 134 notiser, 34
öppningsvarningar, 293 textövergångar och 36 målpassager. De äldre
signaturerna nedan är historiken som förklarar ändringen; aktuell klassning
och full A/B finns i avsnittet om användarens nya beslut.
Underlag: JSONL, aktuella GT-passages, corpora.js hela
42h-posten, ursprungsrapporten FALTRAPPORT-42h-2026-08-08 samt en instrumenterad
körning av hela appen med status/ETA per båt vid varje textövergång.

## Grundräkningen

135 → 134 är inte en saknad användarnotis. C4b rättade riktningen på MARY:s
Klaffbronnotis 2026-08-07 13:18:07.142, så den dubbla notisen 13:41:44.160
spärras för samma passage. Den förstnämnda och passagebokföringen finns kvar.
Korpusnoten bevarar medvetet gamla fältantalet 135 tills korpusen låses.

35 i stället för 36 öppningsvarningar beror på att MARY:s falska norrgående
Stridsbergsbronvarning 13:33:26 togs bort: hon hade passerat söderut 11:45.
Detta antal får inte användas som bevis för någon förlorad öppningsvarning.

## De sju fatala signaturerna före kajfix

1. **U5: MISTRAL 219025192, Stridsbergsbron två gånger.** 09:13:57.997
   väntnotis vid 258 m, 11:43:29.920 ankomstnotis vid 73 m. Samma riktning,
   verklig passage enligt geometriska segmentet 11:43:29.920–11:44:37.133,
   interpolerad 11:44:24.407. Lång väntan mellan två avsiktliga notiser.
2. **U5: MOKENDEIST 211214850, samma bro två gånger.** 09:17:18.957
   väntnotis vid 253 m, 11:43:29.770 bekräftad passage vid 41 m. GT 11:43:11.991.
   Godkänt användarval. Båda paren behålls.
3. **ETA 13 → 19 på 30 s, MARY vid 12:07:37.368.** 12:07:07.034 släcks
   MISTRAL:s Klaffbrontarget efter 12 min stillhet vid Järnvägsbron, varvid
   MARY ensam återstår med gammal ETA 12,68. Bara 124 ms senare kommer hennes
   första nya AIS-prov på 205 s: sog 0,1, lat 58.29329/lon 12.29415, Strids 36 m,
   Klaff 1184 m. PEC använder fartgolvet 0,5 kn, rå-ETA 76,7, och tömmer gammal baslinje
   via ETA_GAP_RESET. Appens publiceringsclamp tillåter 19,27 utifrån
   dataprovsgapet 3,4 min. Texten publiceras 30 s senare. Invarianten mäter
   skärmbyten, inte AIS-ålder; en ny färsk bedömning jämförs med en gammal
   precis nyintroducerad ledares ETA. MARY passerar faktiskt Klaff först i
   fönstret 13:30:28.127–13:41:44.160. 19 ligger närmare än 13; att bara dämpa
   bort ökningen vore inte en verifierad förbättring. Kvarstående
   modellbegränsning: restidsprognos och fartgolv kan inte beskriva okänd
   väntetid mellan broar. Minutnoggrannhet är inte garanterad där.
4. **UTOPIA, DEFAULT 08:46:56.738→08:47:26.738.** Senaste AIS 08:21:35.040
   vid 58.29111/12.29142, sog 0,7. Presentationsgränsen 25 min överskrids;
   återkommer 08:47:18.647 vid 58.29096/12.29089, sog 0,1. Nästa UI-tick visar
   åter ETA okänd. Ingen signal tappas i kod, och fartygsobjektet behålls.
   Detta är den befintliga stalenesspolicyn och ett 26 min glapp. Att
   förlänga just denna gräns för att täcka inspelningen vore facitanpassning.
5. **DORY MAN, DEFAULT 14:19:26.738→14:22:03.157.** Verifierad
   klassningsbugg. Fartbrus 0,6 kn river den redan bevisade kajförtöjningen
   trots några meters netto och introducerar falsk 21 → 22 min prognos.
   FIXAD i VDS. Se docs/kajgranskning-2026-09-06.md.
6. **U6: strax i 41 min från 10:39:06.602.** Fyra fartyg köar framför
   Stridsbergsbron utan passage. Oförändrad vänttext är sanktionerad enligt
   U6 i corpora-noten. Ingen ny undantagssträng tillagd.
7. **MISTRAL Stridsbergsbron som intermediate 11:45:44.949.** Den
   tvåtimmarsbackstop som skiljer okänd förtöjning från trafik klassar
   henne och MOKENDEIST som förtöjda 11:21:05 och tar bort deras target.
   MISTRAL börjar röra sig 11:43:29.920 vid 73 m norr om bron, target är ännu
   null. 11:44:37.133 är hon 17 m söder om brolinjen och tilldelas redan
   Klaffbron via ACCELERATED. Stridsbergspassagen bokförs nästa prov
   11:45:44.949 som intermediate eftersom den då inte är hennes target.
   Fysisk passage och notis finns; själva brokörepresentationen var borta
   i cirka 22 min. Att ändra loggens etikett skulle maskera denna faktiska
   begränsning och kan påverka täcknings-/passageevent. Den är nu rättad
   genom bevarad, belagd kö enligt användarens nya beslut nedan.

## De tre WARN-signaturerna

* Klaff 23 → 31 min 11:34–11:38: ELFKUNGEN bromsar 2,9 → 2 → 1,3 kn och vänder
  COG 44,4 → 207,3 → 240,7. Målbron tas bort 11:38:56.974. Rådata stöder ökad
  restid innan vändningen fastställts.
* Strids 9 → 17 min 11:57–12:02: MS JUTLAND bromsar 8,3 → 6,9 → 6,5 → 6,1 → 5,5 → 4,6 kn.
  Ökningen är förankrad i färska fartminskningar. Avståndet minskar men
  farten minskar ännu mer. Ingen ny smoothingregel införd för att dölja det.
* Lång DEFAULT 44,8 min 14:29:53→15:14:42 är en falskpositiv från en
  textinvariant som saknar båtidentitet: företexten handlar om DORY MAN
  vid kaj, eftertexten om helt annan båt VALKYRIA 275049245 i 6,1 kn norrut
  vid Olidebron. Försvinner med DORY-fixen eftersom de falska företexterna
  tas bort.

## Det tidigare otillräckliga försöket

Enbart i `/tmp` prövades att förhindra 2 h-backstop för färsk, GPS-ren position
utanför kajzon, `waitingAtBridge === targetBridge`, target inte passerat och avstånd
inom 350 m. Det rättar MISTRAL/MOKENDEISTs targetbokföring men ändrar alla
fem beteendedimensioner: 35 → 34 öppningsvarningar, MISTRAL:s Järnvägsnotis
37,606 s tidigare samt annat konvojmedlemskap. `waitingAtBridge` är zonstatus,
inte oberoende bevis att båten väntar på bron. Därför infördes det INTE i
produktkod; att behålla okänd förtöjning utan oberoende köbevis kan återinföra
fantomer. Ingen golden, grind eller undantagslista ändrades av försöket.

## Användarens nya beslut: aktiv, belagd brokö får fortsätta efter två timmar

Den levererade lösningen kräver oberoende positionsbevis: båten måste ha
närmat sig just den väntade bron minst 50 m netto under samma resa och
riktning, på nya fixar. Två fartspikar på samma plats räcker inte.
50 m är befintliga `MOVEMENT_PROOF_NET_M`; inga nya meter- eller tidsgränser
har införts. Beviset är begränsat till de fyra öppningsbroarna, rensas vid
riktig resgräns och följer inte med till grav/cache efter borttagning.

För att undanta förtöjningsklassning krävs dessutom aktiv resa, bron
opasserad, position före brolinjen och inom väntzonens befintliga 350 m
utträdesgräns, samt StatusServices bekräftade `waitingAtBridge` för samma
bro. Känd kajzon och navstatus ankrad/förtöjd har företräde. Det gäller även
väntan vid Olidebron eller Järnvägsbron med en annan målbro. F4-I:s separata
10-minutersdemotion efter passage använder samma köbevis; dess gamla
800-metersgräns skyddade inte kö vid en mellanbro.

Positionens färskhet är skild från kötid. Senast accepterade positionsrapport
används, aldrig `_lastSeen`. AISHub prövas också mot befintlig 12-minuters
fixålder och 120 s klockmarginal. En ny fixtid med identiska koordinater är
en aktiv sändare. Gamla cachefixar bevisar ingen ny väntan; de stoppas även
vid AISHub-ingången. Ett enstaka osäkert eller gammalt prov får varken skapa
ny kö eller göra en redan bevisad kö till en permanent förtöjning. Befintliga
25 min för presentation och 30 min till borttagning består när AIS tystnar.
Ren förflyttning minst 50 m från stillhetsankaret nollar stillhetsklockan,
även över flera små steg med felaktigt sog=0, innan passageprocessen körs.

### Samtliga beteendedeltor i 18 korpusar

Baslinjen här är efter kajfixen, före köfixen. Alla fem dimensioner jämfördes
som hela objekt: notiser, målpassager, mellanbropassager, textövergångar och
öppningsvarningar. Slutlig återkörning efter adversariella rättningar gav
samma utfall som första A/B. Femton korpusar är helt byte-identiska.

| Korpus | Notiser | Öppningsvarningar | Textövergångar | Målpassager |
| --- | --- | --- | --- | --- |
| 20260713-41h | 165, alla objekt identiska | 48, en 2,762 s tidigare | 270 → 269 | alla objekt identiska |
| 20260804-both-21h | 151, alla objekt identiska | 33, alla objekt identiska | 313 → 311 | alla objekt identiska |
| 20260806-42h | 134, två objekt ändras nedan | 35 → 34 | 300 → 293 | 34 → 36 |

**41h: PILGRIM 211110880.** Efter tydlig sydlig anflygning och Stridspassage
väntar hon 12:38:48–12:59:46 på 111–112 m före Järnvägsbron, med Klaffbron
1074 m bort som mål. Fixen 12:56:47.757 är 58.292525/12.292908333, sog=0.
Tidigare `ANCHORED_DEMOTE` efter 18 min tog bort en riktig mellanbrokö.
Nu behålls hon i Klaffräkningen 12:57–13:04. S/Y ONA IX:s Klaff#23 har
exakt samma medlemmar, 295 m och ETA okänd; `OPENING_RECOVER` på PILGRIM-fixen
avfyrar 12:56:47.757 i stället för deadline-tick 12:56:50.519. PILGRIMs
GT-passage av Järnvägsbron är 13:05:24.642. Senare klassas hon fortfarande
som förtöjd vid sin verkliga kajvistelse. Inga notis- eller passageobjekt
ändras.

**Both21h: ANDREA 219031446.** Färska fixar fortgår hela 00:55–03:21, med
största gap 77,481 s. Hon väntar 142–149 m före Stridsbergsbron med navstatus
0 och sog=0; exempelvis 03:08:55.170, 58.292413333/12.293223333. Avgången
börjar 03:17:59.048 vid 58.29251/12.29333, sog=0,5. GT-passage är
03:19:38.105. De två borttagna textraderna var falsk DEFAULT 03:08:55.195
och återkomst till samma vänttext 03:19:06.021, orsakade av 2h-demotionen.
Alla notis-, öppnings- och passageobjekt är identiska. Båda låsta korpusarnas
rådata verifierades även av en andra granskare innan ordinarie
`relockGoldenText.js` godkände endast dessa två textfacit. Inga notis-,
riktnings- eller öppningsfacit och inga invariantundantag ändrades.

**42h: MISTRAL/MOKENDEIST.** Den falska förtöjningen 11:21 försvinner och
köbåtarna ligger kvar tills de passerar. MOKENDEISTs Stridspassage
11:43:29.770 och MISTRALs 11:44:37.133 bokförs nu som målpassager;
tidigare var de mellanbropassager (MISTRAL först 11:45:44.949).
Notisernas MMSI/bro/riktning och antal är identiska. Exakt två notisobjekt
ändras: MISTRALs Stridsnotis 11:43:29.920 är nu från målbron, med vänttext
och ETA -1 i stället för current/ETA 1. Texten ändras från "MISTRAL närmar
sig Stridsbergsbron, beräknad ankomst om 1 minut" till "MISTRAL inväntar
broöppning vid Stridsbergsbron". Järnvägsnotisen kommer 37,606 s
tidigare, 11:45:07.343 vid 239 m i stället för 11:45:44.949 vid 183 m;
hon står före Järnvägsbron på 58.29342/12.29433 och har precis passerat
Stridsbergsbron. Nästa råfix är 58.29301/12.29375. Denna notis har samma
korrekta vänttext.

Den borttagna **Klaff#27, 11:45:26.698**, var en följd av den felaktiga
demotionen: 11:21 raderades MISTRALs/MOKENDEISTs redan avfyrade Klaffarmar;
MISTRAL återarmades 11:44:37 och fick en andra varning. Nu består deras
ursprungliga Klaff#22 från 09:13:56.698, med de fem medlemmarna MISTRAL,
AGULHAS, FILOU, NIGE-O och MOKENDEIST. Inga Klaffpassager sker 11:45;
båtarna köar därefter även före Järnvägsbron.

Den senare gemensamma Klaff#29 ändrar avfyrning 12:13:52.635 → 12:14:58.542:
MOKENDEIST + MS JUTLAND ersätts av FILOU + MS JUTLAND, ledande båt FILOU,
ETA 7 → 9. FILOU är då på 58.29013/12.28991 i 4,1 kn, 756,6 m från Klaffbron.
Konvojens rådatapassager är MS JUTLAND 12:22:20.132, FILOU 12:22:52.744,
MOKENDEIST 12:24:10.288 och MISTRAL 12:24:33.754. Den senare varningen
kommer alltså fortfarande 7 min 21,590 s före den första fysiska passagen.

Öppningsgrinden kördes både före och efter: råpassagetäckning **42/43** och
den bredare klassningen **33 fysiska öppningar, 6 ovarnade** är oförändrade.
Antalet fysiska öppningar med mer än en varning minskar **6 → 5**. Ingen
fysisk täckning förloras. Detekterade målpassager är nu **36/36** varnade.
De äldre rådataavvikelserna och klassade missarna är kvar synliga; de har
inte låsts bort.

Aktuella 42h-invariantutslag är de två godkända U5-notisparen, UTOPIAs
25-minutersgräns och U6-vänttexten (nu 55 min). MARYs synliga 13→19-hopp
försvinner eftersom MISTRAL/MOKENDEIST ligger kvar i den riktiga
Järnvägsbrokön och MARY inte introduceras som ensam ledare med gammal ETA.
Inga ETA-formler eller smoothinggränser ändrades; okänd väntetid mellan
broar är fortfarande en prognosbegränsning.

### Validering

25 adversariella VDS-prov omfattar alla fyra öppningsbroar i båda riktningar,
nyupptäckt stillabåt, fartspikar, navstatus 1/5, känd kaj, källbyte med gammal
fix, liveness utan position, 10/30-minutersålder, F4-I-mellanbrokö, GPS-osäkerhet,
återupptagen färsk sändning och passage med sog=0 i stora och små steg.
Två fullapp-prov verifierar fyra timmars aktiv väntan samt avstängd AIS efter
tre timmar med riktig monitoring/stale-städning. Dessa 27 prov är gröna;
hela syntetiska replaybatteriet och öppningsgrindarna är gröna. Övrig
slutvalidering och fassvep redovisas i fältprovs- och fasrapporterna.

Oberoende slutfassvep av 42h (7 standardfaser och 14 med monitoring) visar
dessutom att den gamla konvojkänsligheten försvinner: samtliga 21 körningar
har en enda Klaffvarning 11:20–12:30, alltid #29 12:14:58.542 med FILOU +
MS JUTLAND, ETA 9. Alla behåller samma 43 unika båt/bro-täckningar som
baslinjen före fältförberedelsen. Samtliga 17 låsta korpusar går gröna efter
de två granskade textomlåsningarna; den olåsta 42h-korpusen behåller sina
fyra öppet redovisade invariantutslag.

## Artefakter

* /tmp/ais-long-current-result.json: aktuell baslinjereplay.
* /tmp/ais-long-audit.log: hela körningen med tidstämplad app-logg och
  fartygstillstånd för varje användartext.
* /tmp/ais-long-eta.log: samma, med full DEBUG 12:00–12:09 för ETA-roten.
* /tmp/ais-mooring-baseline-results/ och /tmp/ais-mooring-after-results/:
  A/B per samtliga 18 korpusar.
* /tmp/ais-long-queue-probe-result.json: återtaget 2 h-köexperiment, EJ produkt.
* /tmp/ais-queue-baseline-results/ och /tmp/ais-queue-after-results/: slutlig
  kö-A/B för alla 18 korpusar; /tmp/ais-queue-final-summary.log verifierar att
  sista adversariella rättningarna inte ändrade korpusutfallen igen.
* /tmp/ais-queue-baseline-42h-audit.log och /tmp/ais-queue-final-42h-audit.log:
  hela appens tidsstämplade DEBUG med öppningsarmarnas livscykel.
* /tmp/ais-queue-baseline-opening-gates.log och /tmp/ais-queue-opening-gates.log:
  oberoende passage-/öppningstäckning före och efter.
* /tmp/ais-queue-relock.log: ordinarie järngrind och exakt två godkända textfacit.
