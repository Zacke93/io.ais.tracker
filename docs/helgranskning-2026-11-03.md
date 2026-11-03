# Helgranskning 2026-11-03 — tillförlitlighet för båtar och broöppningar

Utgångspunkt: `6dc2947`. Uppdraget var att gå igenom hela appen med fokus på
det som gör båtar och broöppningar otillförlitliga, rätta det som går att
rätta och mäta resten. Arbetet har tre delar:

1. Baslinje och mätning: jest, hela korpusbanken (24 låsta fältkörningar,
   cirka 485 h), syntetiska scenarier, öppningsgrindar, soak och fassvep, samt
   ETA och öppningsvarningar mot rådatans korsningar.
2. Granskning av varje delsystem: anslutning, minne och livscykel,
   öppningsmotorn, statusmaskinen, brotexten, boat_near och målbrolagret.
3. Adversariell verifiering av varje fynd med tre oberoende linser:
   - återskapa felet genom produktionsvägen,
   - redan känt eller användarbeslut,
   - verklig påverkan i rådata och på låst facit.

   Bara fynd som överlevde verifieringen har rättats. Fynd som rör ett
   användarbeslut redovisas som beslutspunkter.

Ingen installation eller publicering på Homey ingår. Rådata har inte redigerats.

## Var otillförlitligheten kommer ifrån (mätt)

**ETA mot rådata** (`measure:eta`, 24 korpusar, brotexter ≤ 60 min före passage):

| Klass | Antal | Median absolutfel |
| --- | ---: | ---: |
| Båt utan stopp | 1 062 | 1,4 min (61,6 % inom 2 min) |
| Stopp 1–5 min efter prognosen | 104 | 6,4 min |
| Stopp ≥ 5 min efter prognosen | 205 | 19,9 min |

Utan stopp och med sanning under 5 min ligger 82 % inom 2 min. De stora felen
kommer från **stopp och köer efter prognosen**, alltså bromanövrer, tåg och
väntan, som ingen AIS-data kan förutse.

**Öppningsvarningarnas deadline-fart.** Motorn räknar med 10 kn för att aldrig
varna för sent. Experiment med lägre fart (O1 = varning före passage):

| v_max | O1 app | O1 rådata | oklassade missar | varningar | sena (> 20 min) | median ledtid |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **10 kn (nu)** | 376/378 | 391/447 | 0 | 437 | 118 | 10,3 min |
| 8 kn | 376/378 | 384/447 | 0 | 432 | 109 | 9,0 min |
| 7 kn | 373/378 | 378/447 | 6 | 421 | 106 | 8,2 min |
| 6 kn | 368/378 | 362/447 | 14 | 414 | 101 | 7,8 min |

Slutsats: 10 kn är rätt avvägning. Lägre fart tar bort få sena varningar
men ger missade öppningar. Den gamla förklaringen i `runOpeningGates.js`, att
pessimismen ligger bakom de sena passagerna, var fel och är rättad.

**AIS-datans kadens.** En båt i rörelse rapporterar med median 52–68 s mellan
positionerna (p90 69–98 s, p99 137–821 s). AISHub-positionens ålder vid leverans
har median 19–33 s och p90 49–62 s. Glappen styr mycket av det som upplevs som
"sent" eller "konstigt". Den största enskilda hävstången för bättre data är en
lokal AIS-mottagare (se rekommendationerna).

## Rättade fel

### Commit `0824f09`

- **Avbrottstexten på tom kanal (INV-B4/D5).** Vid AIS-avbrott utan spårade båtar
  publicerades aldrig avbrottstexten; DEFAULT ("Inga båtar …") stod kvar som
  sanning. Vakthunden driver nu cykeln även vid tom kanal.
- **boat_near utan tidsgräns i borttagningslåset.** Ett Homey-anrop som aldrig
  svarade låste MMSI:t i `_processingRemoval`, och en återkommande båt syntes
  inte i brotexten förrän appen startades om. Nu gäller 60 s tidsgräns. Felet
  hittades oberoende av två granskare.
- **Inställningssidans skrivordning.** Ordningen gav falska notiser och korta
  källblinkningar vid källbyte. Prövat uttömmande över 27 × 27 accepterade
  tillstånd.
- **AISHub-pollen stannade vid bakåtstegad väggklocka.** Vid en NTP-korrigering
  stod appen tyst lika länge som klocksteget.
- **429-cooldown upphävdes inte vid källbyte.** aisstream kopplade då inte upp
  igen.

### Commit `74b3a34`

- **Dubbla öppningskort efter köväntan vid Kajen.** Kajzonen ligger i
  Klaffbrons väntzon och har köskydd (`queueGraceMs`). Ett 30 s-stopp där
  räknades ändå som nytt besök. TIM och CHARLYS DREAM fick därför ett andra
  kort för samma öppning.
- **ETA-historiken städades för levande fartyg** under drift. Prognosen
  började om från noll mitt i en anflygning.

### Denna commit

- **Väntehysteresen är bro-specifik.** Väntan vid Järnvägsbron flyttades till
  målbron Stridsbergsbron redan ~93 m söder om Järnvägsbron (broarna ligger
  257 m isär). ETA-kalkylatorn klampade därför prognosen, och väntbaslinjen
  släpptes inte vid passagen. ARESTEL fick "om 3 minuter"; rådatans passage
  kom 72,6 s senare och ger nu "om 1 minut". En notis ändras i banken.
- **En fullbordad resa stänger resans öppna besök.** Elimineringen sker
  ~300 m bortom sista punkten och reentry-blocket kastar båtens AIS i 10 min.
  Därför kunde besöksspärren aldrig se sina två utfärdsfixar, och en båt som
  kom tillbaka dagar senare tappade sin första notis (HELGE vid
  Stallbackabron, tre dygn senare). Positionsbeviset (förbi sista bron och
  utfartslatituden) räknas nu som utfärd. Tystnad, förtöjning och timeout
  stänger fortfarande ingenting (besöksregeln 2026-09-07). Banken: 55 aldrig
  stängda Stallbackabesök stängs, inget låst facit ändras.
- **U-svängen mätte mot det övergivna målet.** Efter en bekräftad U-sväng
  (Fix D) prövade 2-READINGS samma tick "närmar sig" mot det mål båten just
  vänt bort från. Valideringen föll alltid, och båten var mållös till nästa
  fix. ANYA ELAN 380 föll ur brotexten i två minuter, och hennes Klaffkort kom
  113 s efter deadline. Nu kommer kortet 07:38:00 i stället för 07:40:03. Ett
  nytt syntetiskt scenario med gles AIS (180 s) låser beteendet.
- **En bro som korsats i ett AIS-glapp fick förvarningsform.** Notisen sa
  "närmar sig Stridsbergsbron, beräknad ankomst om 1 minut" 160 m efter bron
  (EBONITA, 14,5 min glapp), och rättelsen dedupades bort. Nu gäller passerad
  form ("passerade X under AIS-tystnad", eta −1, already_passed). Beviset är
  gap-kedjans egna fönster med färdriktningen som villkor, och kontrollen görs
  där alla tre notisvägar möts. 13 notiser i 9 korpusar ändras; i samtliga låg
  rådatans korsning före notisfixen. Exempel är FILOU, LOVA, MARLIN, JOSELINA,
  SOLANDE, OLIVIER och ELFKUNGEN.
- **Mellanbrons avståndsreserv.** Ett långt segment (> 400 m, men under
  gap-kedjans hopp på 0,005°) som slutar strax efter en mellanbro bokfördes
  aldrig som passage. Notisen sa "närmar sig … strax" efter korsningen. Fyra
  fall i banken rättas, alla belagda mot rådata: WANDA, ORCA, HELGE och ELISE.
  Bandet är medvetet smalt. Korta segment bokförs vid nästa utgångsfix (låst
  design), och större hopp bär gap-kedjans form.
- **Städning.**
  - Död kod borttagen (`ProximityService.getDistanceToBridge`).
  - Hoppgränsen 0,005° är en delad konstant (`LARGE_JUMP_LAT_DEG`) i stället
    för tre hårdkodade tal.
  - Missvisande förklaringstexter om deadline-farten är rättade.

## Omlåst facit

Varje omlåsning gäller en enskild, rådatagranskad post. Motiveringen står även
i `tests/replay-validation/corpora.js`.

| Korpus | Ändring | Rådata |
| --- | --- | --- |
| `20260804-both-21h` | ARESTEL Stridsnotis 3 → 1 min | passage 72,6 s efter notisen |
| `20260804-both-21h` | ANYA ELAN: Klaffkortet 07:40:03 → 07:38:00 (eta 5 → 7), fyra textövergångar byter ETA, Klaffnotisen 4 → 5 min | U-sväng 07:37:49; ingen Klaffpassage i rådata, så ETA-siffrorna går inte att pröva |
| `20260804-both-21h` | WANDA "har precis passerat Järnvägsbron" 12:20:25 (förut "strax" 12:21:00), +1 mellanpassage | korsning 12:20:12 |
| `20260708-21h` | SOLANDE Klaffnotis i passerad form | korsning 10:05:50, notis 10:06:42 |
| `20260806-42h` | FILOU Järnvägsnotis i passerad form | korsning 11:54:03 i 55 min glapp |
| `20260804-17h` | ORCA:s textövergång 14:04:14 → 14:04:30 (samma text) | följd av bokförd passage 14:00:43 |

Notisantal, fördelnings-, riktnings- och öppningsmultiset är oförändrade i
samtliga korpusar.

## Beslutspunkter (kräver ditt beslut)

1. **Spöktext på tom kanal nattetid (P8/L6, rekommenderas först).**
   - Felet: när sista båten åldras ut medan kanalen är tom håller P8-vakterna
     kvar senaste båttexten ("En båt på väg mot Klaffbron, ETA okänd") och
     larmet, ofta till nästa båt hörs på morgonen.
   - Orsaken: vakten tolkar 5 min utan positioner som tappad prenumeration.
     Det strider mot U12-beslutet (2026-08-10), där "källan svarar men
     levererar inget" räknas som tom kanal och normaldrift.
   - Mätt i en produktionslik replay: 16 av 143 övergångar båttext → DEFAULT
     hålls (11 %), 4 av dem till körningens slut. L6 bedömde triggern som
     "smal"; mätningen visar att den inte är det.
   - Rekommendation: låt P8 använda U12:s svarspredikat. DEFAULT släpps
     igenom när någon pipelinekälla svarar, och vid äkta blindhet tar
     avbrottstexten över (D5).
   - Inget är ändrat, eftersom L6 är ditt beslut.
2. **Utfarter vid boxkanten (BN1).**
   - Felet: en båt som lämnar bevakningsområdet vid Kanalinfarten eller
     Stallbackabron utan två fixar bortom 350 m och utan fullbordad resa
     lämnar ett öppet besök. Hon tappar sin första notis vid återkomsten.
     Exempel är VISTEN (sista fix 267 m i 7,6 kn mot Vänern), S/V REBEL och
     JUNO.
   - Rättningen ovan täcker elimineringsfallen, inte boxkanten.
   - Alternativ: (a) en utåtriktad transit (≥ 2 kn, ökande avstånd, yttre
     sidan) räknas som utfärd vid de två ytterpunkterna; (b) en större
     bevakningsbox vid utfarterna.
   - Båda ändrar besöksregeln från 2026-09-07 och kräver därför ditt beslut.
3. **ETA:n drar inte av fixens ålder (open3).** En AISHub-position är i median
   20–30 s gammal vid leverans. Att räkna av åldern ger en mätbar men liten
   vinst och berör D2 (monotonicitet), som är uppskjutet.
4. **Latenta fynd utan uppmätt effekt i banken.**
   - Under-bro-låset kan sättas från en GPS-osäker fix; 0 fall i banken.
   - Öppningsmotorns klass utan fartgivare (sog = null); 0 fall.
   - Inbromsning efter glapp ger "om 3–4 minuter" vid målbron; bara
     syntetiskt.

   Inga ändringar gjorda: risken för regression väger tyngre än en omätt
   vinst.

## Rekommendationer

- **Lokal AIS-mottagare** (till exempel en enkel SDR-mottagare som matar
  AISHub eller appen direkt). Den kortar glappen och positionsåldern mer än
  någon kodändring kan.
- **Behåll 10 kn som deadline-fart.** Mätningen ovan visar att lägre fart ger
  missade öppningar utan att varningarna blir nämnvärt mer träffsäkra.
- **Bygg flows på `eta_available` och `already_passed`**, inte på texten.
  -1-sentinelen i `eta_minutes` betyder "okänd".
- **Kör `npm run replay:field` efter nästa fältprov.** De nya rättningarna
  (passerad form, väntan vid Järnvägsbron, U-svängar) syns tydligast i
  verklig drift.

## Validering

Hela batteriet har körts på slutläget med samma kommandon som i
`docs/VALIDATION.md`.

| Steg | Resultat |
| --- | --- |
| `npm test` | 331 sviter, 4 545 godkända, 2 överhoppade (kräver privata fältloggar); baslinjen var 320 sviter och 4 504 tester |
| `npm run replay:all` (normal och `REPLAY_MONITORING=1`) | 24 korpusar gröna |
| `npm run replay:synthetic` | 46 scenarier rena, inklusive det nya U-svängsscenariot |
| `npm run replay:openings` | standardgrindar godkända; 376/378 målbropassager varnade i tid; rådatavarningarna oförändrade mot baslinjen |
| `node tests/replay-validation/runSoak.js` och `npm run replay:monitoring` | stabila, 0 processfel, inga kvarlämnade timers |
| `npm run replay:phase` (normal och `REPLAY_MONITORING=1`) | hela banken, 168 replays vardera, inget odokumenterat fasberoende |
| `npm run lint` | rent |
