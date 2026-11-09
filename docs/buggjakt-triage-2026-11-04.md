# Buggjaktstriage 2026-11-04 — buggjägarens första rapport

Det här är triagen av buggjägarens standardrapport efter motorns två
rättningsrundor (`docs/BUGGJAKT.md` §7). Motorn rapporterar bara; den rättar
aldrig appen. Ägaren beslutade 2026-11-04 att appfelen ska rättas i en
rättningskampanj med full validering, och att motorn ska köras om tills korten
är borta. Besluten står i §Ägarens beslut 2026-11-04 nedan, och dokumentet är
kampanjens underlag. Varje kort är reproducerat och rotorsakerna är belagda med
loggar och kod. Rättningsriktningarna är däremot triagens förslag: de prototypas
och mäts i kampanjen.

## Körningen

- **Kommando:** `npm run hunt` (profil standard, seed 1).
- **Kod:** samma som i den här commiten. Appen och harnessen är oförändrade
  sedan `7699cbe`, och motorn är den som checkas in här. Körningen gjordes i
  en arbetskopia utan git, så rapportens huvud säger "git saknas".
- **Underlag:**
  - självtestet: determinism, SHIFT30 och MMSI 24/24, kanarier 5/5 och
    rundresa 45/45;
  - bankspåret: de 24 låsta korpusarna (482,2 simulerade timmar, 18 679 rader)
    och 168 fasvarianter (δ = ±2,5, ±7, −11,52, +15 och −20 s), varav 158 rena;
  - sanningsspåret: 2 000 syntetiska världar (R0 635, R1 1 365; uppmätt
    stresstäthet 23) med 5 978,2 simulerade timmar och 545 078 rader.
- **Utfall:** 419 råa utslag (399 syntetiska) i 45 kluster: 22 kandidater
  (R0 6, bank 3, R1 7, stress 6), 4 KONFLIKT, 5 KÄND_ÖPPEN, 4 ACCEPTERAD,
  7 DESIGN och 3 MÄTGRÄNS. Alla 39 representanter är krympta och bekräftade.
- **Fingeravtryck:** `rapport.json` 19804855dcf4 i två körningar.
  Sanningsspårets fingeravtryck är 19bbc284099d (rader) och 847ffde12743
  (fynd).

**Så återskapas korten.** Kör `npm run hunt` vid samma HEAD. Utdata hamnar i
`dirigent/hunt/<ÅÅÅÅMMDD-HHMMSS>-<sha7>-standard-s1/`, som är git-ignorerad,
och `dirigent/hunt/senaste.txt` pekar ut den senaste körningen. Budgeten
räknas i världar, inte i tid, så samma HEAD, profil och seed ger samma kort
(BUGGJAKT §3). Rapportens fingeravtryck räknas även över HEAD och körnings-id
(`tests/replay-validation/bugHunt/lib/report.js`), så i repot blir det ett
annat än 19804855dcf4. Sanningsspårets två fingeravtryck beror inte på
HEAD-sha:n. Ett enskilt kort körs om med
`npm run hunt:repro -- dirigent/hunt/<körning>/fynd/<kort>`, som svarar KVAR
eller BORTA.

**Domar.** Av rapportens 22 kort är 20 trolig bugg (F01–F17 och F20–F22) och
2 beslut eller design (F18 och F19). Därtill kommer W750, en trolig bugg i en
av F10:s världar utan eget kort, och förra F21, en motorartefakt som nu är
borta. Inget kort är oklart. B01 och B02 är exempel på konflikter, inga kort,
och även de ger KVAR.

**Så prövades korten.**
- `hunt:repro` gav KVAR (exit 0) för alla 22 kort och deras r2-kataloger, med
  bitlika rader och samma utslag som i runda 1. Direkt replay av varje
  syntetiskt minsta repro gav samma resultat som sparad `repro.result.json`.
- Rotorsakerna är belagda med `REPLAY_VERBOSE`-loggar i minsta repro. Alla
  fullvärldar i F04, F06 och F10 återskapades och kördes också, och F01:s
  kluster klassades ur sanningen och beläggen.
- Mot runda 1 försvann ett enda utslag, T1 i värld 856 (förra F21), genom
  motorrättningen E6. Inga kort tillkom.

## Appfynd efter rotorsak

Korten är grupperade efter rotorsak. Ett blandat kort kan höra till flera
grupper, och en länk i rapporten (BUGGJAKT §9) betyder inte att korten har
samma rotorsak. Radhänvisningarna gäller `7699cbe`. Prioriteten väger
idealradio (R0) före fältlik radio (R1), antalet världar och om felet gäller
öppningsvarningen (produktprincipen: en missad öppning är värre än ett
falsklarm). Efter en rättning ska `npm run hunt:repro` på gruppens kort ge
BORTA, och en ny `npm run hunt` visar följderna i andra kluster (BUGGJAKT §15).

| # | Rotorsak | Kort | Facit flyttas | Mätning | Prioritet |
|---|---|---|---|---|---|
| 1 | RECOVER-släppet och konvojfönstrets bakkant | F02, F03, F11, F14, F17, F20–F22, del av F01 | konvoj- och öppningsfacit | O1/O2 (`replay:openings`), `replay:all`, omlåsning | hög |
| 2 | Glappregistreringen flyttar konvojtäckningen | F01 | konvojfacit | O1/O2, `replay:all` | hög |
| 3 | U-svängens obokförda återkorsning | F10, W750, del av F01, F12, F13 och F15 | inte låst facit | `replay:all`, `replay:synthetic` | medel |
| 4 | GPS-grindens dubbelbokföring | F12, F16 | nej | `replay:all` | medel |
| 5 | BN2-luckan för en återfödd båt | F13 | notisform kan ändras | `replay:all` | låg–medel |
| 6 | Det svepinfererade riktningslåset | F15 | notisriktning kan ändras | `replay:all` | låg |
| 7 | ETA-kedjan | F04, F06, F07 | golden-text | `replay:all`, `measure:eta` | medel (F04), låg |
| 8 | LOW_SPEED/INSUFFICIENT_MOVEMENT-flappen | F05 | syntetiskt textfacit, ev. golden-text | `replay:all` | medel |
| 9 | Fasberoendet i 16h och 13h | F08, F09 | nej för basen | `hunt:repro`, `replay:all`, `replay:openings` | medel |

F18 och F19 är beslut eller design och står under Beslutsfrågor (punkt 3).

### 1. RECOVER-släppet och konvojfönstrets bakkant

- **Kort:** F02 (37 världar, 10 av utslagen i R0), F03 (72 utslag i 71
  världar, 3 i R0), F11 och F14 (R1) samt stresskorten F17, F20, F21 och F22.
  Dessutom omkring 14 av F01:s världar (RECOVER-sömmen, länken F01↔F03) och
  F01:s r2 (värld 1349).
- **Vad händer:** en båt som absorberats i en äldre händelse är täckt till
  händelsens registrerade första passage + `CONVOY_WINDOW_MS` (600 s). Är hon
  kvar beväpnad när täckningen löper ut släpps armen på ren tid, och samma
  utvärdering binder den och avfyrar på den ärvda, redan förfallna deadlinen.
  Utfallet beror på B − A, tiden från händelsens första passage till båtens
  korsning:
  - under 600 s, alltså samma öppning enligt U2: varningen kommer efter
    passagen (F03: 22 s efter, gräns 587–605 s; F20: 268 s efter);
  - strax över 600 s: varningen kommer i eller efter korsningen, och T2 ser
    ingen varning före (F17: gräns 605–623 s; F01:s r2: 607 s);
  - därefter: för kort ledtid (F02: 47 s, gräns 627–664 s; F21: 54 s). Det är
    konvojfönstrets bakkant i BUGGJAKT §14;
  - för en tyst båt: varning på ett fruset fix (F11: 20 min; F22: 22 min,
    efter en återabsorption enligt J13+J33 (a));
  - för en båt vars senaste fix visar att bron ligger bakom: fantomvarning
    (F14: fixen 705 m från bron med kurs 32,8°).
- **Rotorsak:** `lib/services/BridgeOpeningService.js:1648–1667`
  (`_releaseStrandedArms`), steg (1b) i `_evaluateBridge` (:1279), med
  bindning på :1298 och avfyrning på :1327. Släppet saknar grindarna i
  `_rescueCoveredArms` (:1567–1580: finit ankomst och ledtidsgolv). Täckningen
  sätts en gång, på en prognos (:1470–1473), och kortas bara av K14
  (:1801–1812). Premissen "öppningen har bevisligen gått utan henne"
  (:1637–1641) håller inte för en tyst båt.
- **Dokument:** `docs/ARCHITECTURE.md:1461–1474` (KRAV PÅ ETT NYTT FÖRSÖK,
  punkt 1–4), :1474–1482 (VIRGO och PILGRIM), :738–741 (tidsbegränsad
  täckning) och :1611–1622 (J13+J33);
  `docs/etapp7-plan-2026-08-08.md:9` (U2) och :380–381 (RECOVER-vägens
  5 räddningar, 15 dubbletter och 20 fantomer, en mätning och inget beslut).
  Inget ägarbeslut täcker fallen. U2-VS-DEADLINE gäller bara inom +600 s, och
  produktprincipen (`BridgeOpeningService.js:45–50`) godtar bara stopp eller
  vändning efter sista fixen.
- **Rättningsriktning:** behåll RECOVER, men gör släppet smalt enligt
  KRAV 1–4:
  - avväpna i stället för att släppa när bron ligger bakom armen (F14);
  - kräv att `lastSeenAt` är nyare än händelsens `firstPassageAt` (F11, F22);
  - använd samma grindar som `_rescueCoveredArms` och en ny egen deadline i
    stället för den ärvda (F02, F17, F21);
  - kräv en fix efter täckningsslutet, eller extrapolera förbi bron, innan en
    båt som kan ha passerat varnas (F03, F20).

  KRAV 3–4 räcker inte för F21: prognosen gav 81,7 s kvar, men verkligheten
  54 s. Där måste medlemskapet omprövas mot armens färska `expectedArrivalMs`
  vid varje fix efter händelsens första passage. Att bara ankra täckningen i
  sann korsningstid räcker inte heller: i F17 hade släppet då kommit 6 s före
  korsningen.
- **Facit och mätning:** flyttar konvoj- och öppningsfacit. Banken har 56
  RECOVER, varav 10 återabsorberas (`ARCHITECTURE.md:1611–1616`). Mät O1, O2
  och O2b med `npm run replay:openings` och öppningsfacit med
  `npm run replay:all`, och lås om enligt `ARCHITECTURE.md:1621–1622`. Kör
  fassvepet även med `REPLAY_MONITORING=1`, eftersom ändringen rör
  tidsstyrning (CLAUDE.md). Ett nytt försök ska ha rött-utan-vakt-tester för
  VIRGO och PILGRIM (:1474–1482).
- **Prioritet:** hög. Felet finns i idealradio och gäller öppningsvarningen.
  Rättningen hör till samma beslut som konvojfrågorna (Beslutsfrågor,
  punkt 6).

### 2. Glappregistreringen som flyttar konvojtäckningen

- **Kort:** F01 (representant värld 1900, R0, F-AVBROTT). Klustret är blandat.
  Runda 1:s grovklassning av dess 55 utslag i 53 världar: avbrott 9 (dit
  representanten hör), RECOVER-söm 14 (grupp 1), U-svängsretur 13 (grupp 3),
  absorberad utan egen varning 17 och övrigt 2.
- **Vad händer:** i minsta repro korsar ORION Klaffbron 09:13:46 mitt i ett
  avbrott (09:13:27–09:26:11). Passagen bokförs först 09:26:22, och
  händelsens första passage blir registreringstiden. ULLA beväpnas 09:26:23
  och absorberas med täckning till 09:36:22. Hon korsar 09:31:35, 1 069 s efter
  ORIONs sanna korsning. Enligt U2 är det nästa öppning, men hon får ingen
  varning.
- **Rotorsak:** `lib/services/BridgeOpeningService.js:1743–1761`
  (`_recordPassage` sätter `firstPassageAt` och `referenceArrivalMs` till
  registreringstiden), och täckningen räknas från den tiden (:1470–1473,
  :1801).
- **Dokument:** K14-doktrinen i samma fil (:1763–1800: täckningen ankras i den
  verkliga passagen) och U2 (`docs/etapp7-plan-2026-08-08.md:9`).
  U2-VS-DEADLINE gäller inte, eftersom 1 069 s > 600 s. Inget ägarbeslut.
- **Rättningsriktning:** ankra händelsens första passage i den interpolerade
  korsningstiden när passagen bokförs efter ett glapp. Rättningen tömmer inte
  F01, eftersom grupp 1 och 3 har egna rotorsaker. En tidigare ankring kortar
  täckningen och lämnar fler båtar åt RECOVER-släppet, så rätta grupp 1
  först eller samtidigt.
- **Facit och mätning:** flyttar konvojfacit. En kortare täckning kan bara
  lägga till varningar (:1785–1793). Mät O1/O2 med `replay:openings` och kör
  `replay:all`.
- **Prioritet:** hög: en missad öppningsvarning i idealradio.

### 3. U-svängens obokförda återkorsning

- **Kort:** F10 (11 världar, R1) och W750 (värld 750, en av F10:s världar).
  Samma mekanism ger utslag i andra kort: F01:s U-svängsreturer (13 utslag;
  T10 belägger 353, 1731 och 188), F13:s r2 och F12:s utslag (båda i värld
  1731) samt F15:s utslag i värld 188.
- **Vad händer:** en båt vänder 241–755 m bortom en bro och korsar den igen.
  Första fixen efter vändningen ger bara en väntande reversal. Nästa fix ligger
  redan bortom bron och bekräftar vändningen, och journey-reseten behåller den
  återkorsade bron (`JOURNEY_RESET … (keeping [Klaffbron])`). Returen bokförs
  aldrig, och båten får "lämnar kanalen, ingen målbro". Tio av elva båtar är
  klass B.
- **Rotorsak, i tre led:**
  1. Fix D:s tvåfixsdebounce (`lib/services/VesselDataService.js:440–468`,
     Anomali 18) bekräftar vändningen först bortom bron.
  2. N1-resetten i `_confirmDirectionReversal` (:6771–6793) räknar "framför"
     från nuvarande läge och behåller bron i `passedBridges`.
  3. Varken passagedetektionen eller `applyInferredPassage` (:6858, villkoret
     på :6879) bokför då korsningen.
- **Dokument:** `docs/helgranskning-2026-07-06.md:305–307` (N1-resetten),
  `docs/ARCHITECTURE.md:849–853` (Fix D) och :2023–2029 (fixvågens avvägning:
  en gles äkta U-sväng ska få returpassagen bokförd). Inget ägarbeslut godtar
  en obokförd returpassage.
- **Rättningsriktning:** räkna resetten från läget vid den väntande
  reversalen, eller bokför en bro som bekräftelsesegmentet korsar i den nya
  riktningen. Varningen före returen (T2 i F01) räddas inte av det. Den kräver
  tidigare vändningsdetektion och krockar med Anomali 18.
- **Facit och mätning:** låst facit väntas inte flytta sig, eftersom banken
  har fyra journey-resetter mitt i resan och ingen behåller en bro. Kör
  `replay:all` och `replay:synthetic` (U-svängsscenariot med gles AIS).
  Bokförs en retur inom 350 m-utfärden hamnar fallet i INV5-VS-BESÖKSREGEL
  (som W750). Det avgjordes genom U14: returen ska ha en egen notis.
- **Prioritet:** medel. Klassen är homogen och syns i 11 världar och i F01,
  men bara i R1. Världsmodellens U-sväng är dessutom en vändning på stället
  med momentant kursbyte (BUGGJAKT §4.5).

### 4. GPS-grindens dubbelbokföring

- **Kort:** F12 (INV-13, 3 världar, R1) och F16 (T10 FANTOMPASSAGE
  (intermediate), 1 värld). Båda bär samma apphändelse i värld 254, med samma
  minsta repro på 17 rader. F12:s övriga världar är andra mekanismer: 1227,
  där båten föds 9 m från bron en sekund före korsningen, och 1731 (grupp 3).
- **Vad händer:** JOLLY (klass B) har ett glapp på 9 min över
  Stridsbergsbron. Fixen 16:03:34 registrerar en kandidat i GPS-grinden och,
  i samma tick, gap-vägens målbropassage. Båten står sedan i kö 126 m söder om
  bron. 16:16:49, 795 s senare, bekräftar grinden kandidaten, och bron bokförs
  en gång till, nu som mellanbro.
- **Rotorsak:** `GPSJumpGateService.confirmStableCandidates`
  (`lib/services/GPSJumpGateService.js:184–257`, TTL 20 min) bekräftar en
  kandidat för en redan bokförd bro, och `app.js:4229–4252` skickar den till
  `registerConfirmedIntermediatePassage`
  (`lib/services/VesselDataService.js:6358`), eftersom målet redan har bytts.
  Dedupen räcker inte vid 795 s: passageId (:8249–8258), studsvakten på 3 min
  (:8305–8320) och `processedPassages`, som lever 5 min (:8288–8296).
  Systervägen `applyInferredPassage` har en vakt mot `passedBridges`, men
  grindvägen saknar den.
- **Dokument:** `docs/reliability-review-2026-06-09.md:126–128` (B6). Bara
  borttagningshalvan av förslaget infördes
  (`lib/services/VesselDataService.js:1711–1720`). Inget ägarbeslut.
- **Rättningsriktning:** släpp just den bokförda brons kandidat när gap-vägen
  bokför passagen. Rensa inte alla kandidater vid målbyte: i 20260713-41h
  bekräftar 218023240 Järnvägsbron i samma tick som Stridsbergsbrons
  gap-inferens.
- **Facit och mätning:** bankens fem grindbekräftade mellanbropassager (41h 2,
  17h 2, 24h 1) är enkla, så en smal rättning flyttar inte låst facit. Kör
  `replay:all`.
- **Prioritet:** medel. Det är en fatal invariant och en dokumenterad risk,
  men felet syns i en enda R1-värld. Rättningen är smal.

### 5. BN2-luckan för en återfödd båt

- **Kort:** F13 (T1 FÖRVARNINGSFORM-EFTER-PASSAGE, 3 världar, R1) med
  representanten värld 86. Värld 1731 (r2) hör till grupp 3, och 783 är inte
  rotorsaksutredd.
- **Vad händer:** SALTIS (klass B, AISHub) har ett glapp på 6,8 min, tas bort
  och återföds 08:57:32, 115 m bortom Olidebron med kurs 49,9°. Notisen blir
  "SALTIS närmar sig Olidebron, beräknad ankomst om 1 minut", fast korsningen
  skedde 08:56:38 och notisen byggdes på fixen bortom linjen. I samma tick
  låser SKIPPED_BRIDGES riktningen norrut, men Olidebron-fallbacken dedupas.
- **Rotorsak:** BN2 (`app.js:9890`, `_hasGapCrossedNotifiedBridge`) kräver en
  färdriktning ur ruttlåset eller kursbanden. Kursen 49,9° ligger utanför
  nordbandet 315–45° (`lib/utils/cogDirection.js`), och den återfödda båten
  har inget ruttlås, så beviset ger false.
- **Dokument:** `docs/helgranskning-2026-11-03.md:108–115` (BN2) och :266–272
  (restfallen scenario A och Kanalinfarten, som inte gäller broarna);
  `docs/ARCHITECTURE.md:2030`. Inget ägarbeslut.
- **Rättningsriktning:** ge BN2 en riktningskälla för en återfödd båt vars kurs
  ligger mellan banden. Villkoret får inte bli detsamma som glappets egen
  latitudförflyttning, för då får BN2 samma fel som gap-kedjans scenario A
  (en återresa får passerad form för broar framför båten). Rätta tillsammans
  med grupp 6, som också gäller färdriktningen för en återfödd båt.
- **Facit och mätning:** BN2-rättelsen ändrade 13 notiser i 9 korpusar
  (`docs/helgranskning-2026-11-03.md:113`), och 3,6 % av de nordgående
  bankfixarna mellan Kanalinfarten och Olidebron har kurs 46–134°. En breddning
  kan alltså ändra notisform i banken. Kör `replay:all`.
- **Prioritet:** låg till medel: en utredd värld i R1, men klassen finns i
  fält.

### 6. Det svepinfererade riktningslåset

- **Kort:** F15 (T9 FEL-RIKTNING, 3 utslag i 2 världar, R1) med
  representanten värld 451. Utslaget i värld 188 hör till grupp 3.
- **Vad händer:** IRMA har ett glapp på 43 min och U-svänger inne i det. När
  hon hörs igen 12:05:03 mellan Olidebron och Klaffbron, på kurs 193,5°,
  låser SKIPPED_BRIDGES_DIRECTION_LOCK riktningen norrut ur svepfönstrets
  nettoförflyttning. Sju sydgående fixar rättar aldrig låset, och Fix D är
  inte aktiv. Notiserna vid Olidebron (12:11:57) och Kanalinfarten (12:17:41)
  bär därför riktningen norrut.
- **Rotorsak:** låset sätts när riktning saknas (`app.js:8515–8528`) och
  omprövas aldrig mot levande kurs. Koden räknar med att korsningsbeviset i
  VesselDataService rättar en motsägelse, men här rättar varken det eller
  Fix D låset.
- **Dokument:** korpusnoten för 20260708-21h
  (`tests/replay-validation/corpora.js:771–772`: "låst ruttriktning > momentan
  COG"). Avvägningen förutsätter att låset vänds när båten bevisligen vänt.
  Inget ägarbeslut täcker ett lås som härletts ur ett svep över en U-sväng.
- **Rättningsriktning:** låt ett svepinfererat lås omprövas mot levande kurs
  och progress, till exempel när flera fixar i rad går åt motsatt håll. Rätta
  tillsammans med grupp 5.
- **Facit och mätning:** notisernas riktning kan ändras. Kör `replay:all`,
  som också jämför riktningsmultiset.
- **Prioritet:** låg, eftersom fallet kräver en U-sväng i ett långt glapp.

### 7. ETA-kedjan

- **Kort:** F04 (INV-3 ETA-SÅGTAND UPP, 31 världar, varav 4 i R0), F06
  (INV-3 ETA-OSCILLATION, 16 världar, varav 3 i R0) och bankkortet F07
  (20260708-21h, δ −11,52 s). 14 av F04:s utslag och 3 av F06:s har i stället
  F18:s mekanism och hör till beslutsfrågan om F40-studsen (punkt 3).
- **Vad händer:**
  - **F04, avgång efter lång väntan:** ALVA väntar 30 min 238 m före
    Järnvägsbron. Vid avgången (1,6 kn) rensas ETA-historiken, och
    progressive_route ger 29,5 min. Det andra K6-passets 9,8 min stoppas som
    avvikare, och efter blandning och EMA går texten från "strax" till
    "om 27 minuter". Hon korsar 3 min senare.
  - **F06, inbromsning nära bron:** XENIA bromsar från 4,5 till 1,1 kn cirka
    340 m före Klaffbron. ETA:n pendlar kring 3 min, och texten går "strax" →
    "om 4 minuter" → "strax" inom 90 s, 8–10 min före ankomsten.
  - **F07, knivsegg i 21h:** när JAATTEN II:s position blir 606 s gammal tar
    gruppen AVALONs 17,7 min, som hålls uppe av publiceringsklämman. Hoppet
    13 → 18 (Δ5) finns redan i låst golden, och fasen avgör bara om
    heltalströskeln Δ ≥ 6 slår till (13 → 19).
- **Rotorsak:** F04: avgångs-ETA räknas på igångsättningsfart, och kedjan
  ETA_GAP_RESET (`lib/services/ProgressiveETACalculator.js:745`), ETA_OUTLIER
  (:904, :1156) och EMA förstärker felet. F06: 3-minutersgränsen saknar
  hysteres, K6-dubbelkörningen ger dubbel EMA-eftersläpning, och
  300 m-regeln (Fix H) slår till. F07: klämkedjan (ETA_PUBLISH_CLAMP,
  `app.js:5442`).
- **Dokument:** `docs/ARCHITECTURE.md:2230–2232` (känd latent klass:
  avgångs-ETA på igångsättningsfart), :1593–1610 (J10: klämkedjan kräver en
  egen mätt design) och :1234 (§8 (e) K6). U1 och U6
  (`docs/etapp7-plan-2026-08-08.md:8`, :15) sanktionerar "strax" inom 300 m,
  men inte växlingen. Inget ägarbeslut.
- **Rättningsriktning:** ETA-etappen, inte kirurgi: en accelerationsmedveten
  avgångs-ETA, hysteres kring 3-minutersgränsen och en mätt design för
  klämkedjan. Skjuts F04 upp behövs en KÄND_ÖPPEN-post med källan
  `ARCHITECTURE.md:2231`. F07 kan i stället bokföras som knivsegg i
  korpusnoten och i `tests/replay-validation/phase-sweep-exceptions.json`
  (`docs/VALIDATION.md:230–238`).
- **Facit och mätning:** flyttar golden-text i banken. Kör `replay:all` och
  `measure:eta` (A/B), och för F07 `hunt:repro`.
- **Prioritet:** medel för F04 (31 världar, varav 4 i idealradio), låg för
  F06 (inget fall i banken) och F07.

### 8. LOW_SPEED/INSUFFICIENT_MOVEMENT-flappen

- **Kort:** F05 (INV-14 DEFAULT-FLASH, 17 världar, varav 2 i R0).
- **Vad händer:** WILMA kryper norrut förbi Klaffbron i 0,5 kn med målet
  Stridsbergsbron 1,2 km bort. Efter 60 s målgrace tappas målet (LOW_SPEED vid
  0,3–0,4 kn, INSUFFICIENT_MOVEMENT vid 0,5 kn med 7–8 m per fix), och texten
  blir "Inga båtar". Nästa fix inom 300 m från Klaffbron tilldelar målet igen.
  Gränsen är 0,26–0,59 kn, och den övre kanten motsvarar 10 m per 30 s.
- **Rotorsak:** grindarna mäter mot olika broar. Tilldelningens närhetsundantag
  (`lib/services/VesselDataService.js:4377–4383`) mäter mot närmaste bro,
  medan retentionens LOW_SPEED (:8065–8067) och INSUFFICIENT_MOVEMENT
  (:8092–8093, `MIN_APPROACH_DISTANCE` = 10 m i `lib/constants.js:148`) mäter
  mot målbron.
- **Dokument:** syskonet i `docs/valideringskorning-2026-07-02.md:36–40`
  rättades med kö-zonsvakten inom 600 m från målbron, och det här fallet
  ligger utanför vakten. Ingen dokumenterad avvägning finns för
  `MIN_APPROACH_DISTANCE`. Inget ägarbeslut.
- **Rättningsriktning:** låt tilldelning och retention mäta mot samma bro,
  eller tidsnormalisera kravet på 10 m per fix (jämför K19 och J10 om nakna
  tal).
- **Facit och mätning:** flyttar syntetiskt textfacit och kan röra golden-text
  där en båt kryper efter en bro. I banken har 38 av 306 fixar i 0,45–0,7 kn
  högst 40 s kadens. Kör `replay:all`.
- **Prioritet:** medel: en fatal invariant i idealradio, och texten säger
  "Inga båtar" mitt i en anflygning.

### 9. Fasberoendet i 16h och 13h

- **Kort:** F08 (20260917-16h, δ −7 och −2,5 s) och F09 (20260710-13h,
  δ −11,52 och +15 s). Båda är KNIVSEGG på verklig data. F07 (21h) står i
  grupp 7.
- **Vad händer:**
  - **F08:** SINE BRES (304225000) Järnvägspassage 02:27:17, som ligger i
    låst eventfacit sedan 2026-10-05, saknas i varianten. I basen hinner
    watchdog-tickens korsningsbevis (`UNDER_BRIDGE_CROSS_PROOF`,
    `lib/services/StatusService.js:1341`) före AISHub-fixen. I varianten körs
    `FIX_U_FORCE_WAITING` (:183) i stället, och fixen ger ingen passage.
  - **F09:** PILOT 761:s varning Klaffbron#2 går 05:43:57,9 i varianten och
    05:44:09,5 i basen. VIRGO hålls vid Olidebron till sin fix 05:44:05,98. I
    varianten ligger halvminutsticken 05:44:00 emellan, så #2 släpper henne,
    och hon får en egen extra varning 05:44:29. Båda passerar Klaffbron inom
    cirka 4 min, alltså samma öppning.
- **Rotorsak:** F08: passagebeviset vid Järnvägsbron beror på om tickens
  korsningsbevis eller fixens tvingade väntan kommer först. F09: regeln "en
  varning som gick medan båten hölls vid en tidigare bro täcker inte hennes
  senare ankomst" (`lib/services/BridgeOpeningService.js:1387–1394` i
  `_bindLooseArms`) prövas vid varje utvärdering, även vid en tick utan ny
  observation.
- **Dokument:** F08 är den klass som rättelsen 2026-10-05 skulle stänga
  (`docs/faltgranskning-2026-10-05.md:130–136`, :219–221). F09 bryter U2
  (`docs/etapp7-plan-2026-08-08.md:9`). Det finns inga undantag i
  `phase-sweep-exceptions.json`, och K20-FASKÄNSLIG-LEDARE gäller bara parade
  kortbyten. CLAUDE.md kräver att startberoende utfall utreds. Inget
  ägarbeslut.
- **Rättningsriktning:** gör båda besluten oberoende av om en halvminutstick
  hinner före nästa fix. Passagebeviset vid Järnvägsbron ska inte bero på
  ordningen mellan tick och fix, och medlemsregeln i F09 bör bara verka på en
  observation efter avfyrningen.
- **Facit och mätning:** basens utfall är facit, så inget låst facit väntas
  flytta sig. `replay:phase` ser inte felen, eftersom det bara byter
  korpusens ankarrad och UI-klockan följer fasta halvminuter. Mät därför med
  `hunt:repro` på F07–F09; bankkortens repro kör om M-FAS, som flyttar hela
  korpusen. Kör `replay:all` även med `REPLAY_MONITORING=1` (CLAUDE.md), och
  för F09 även `replay:openings`.
- **Prioritet:** medel: verklig data i låsta korpusar, men knivseggar.

## Rättningskampanjens utfall (2026-11-07)

Ägaren beslutade 2026-11-04 att felen skulle rättas. Arbetet gjordes familj för familj:
1. design med prototyp och regressionstest;
2. adversariell granskning;
3. revision tills granskningen godkände;
4. integration med hela batteriet efter varje steg.

Facit låstes om bara där rådatan visar att utfallet blir rättare (U13).

| Commit | Familj | Kort (numrering i tabellerna ovan) | Facit |
|---|---|---|---|
| c8a5cb6 | R1: U-svängens återkorsning, svepets riktningslås | F10, W750, F15 | oförändrat |
| 10d058e | R2: GPS-grindens dubbelbokföring, BN2 utan kurs, Järnvägsbrons passagebevis | F12, F16, F13, F08 | oförändrat |
| 8a013d5 | E: avgångs-ETA | F04 | 6 rader rättare (41h, 24h, 31h) |
| f198d52 | K: RECOVER-släppet, bakkanten, passagetiden efter glapp | F01, F02, F03, F14, F17, F20, F21 | oförändrat |
| 2c3f778 | K2: returresan får egen varning (U15), 13h-fasen | B02, F09 | oförändrat |
| e088a51 | M: krypfartens målbroflapp | F05 | oförändrat |
| aa71099 | N: notis per passage (U14) | B01 | 6 rader rättare (25h, both-21h, 42h) |
| f6f35e6, e6cc0e1, 286fb09 | registret: U17–U19, R2:s fråga 2, kända luckor | F11, F22 (U17) | – |

**Ägarens beslut under kampanjen** (motiv och källor i `docs/ARCHITECTURE.md` och
`docs/BUGGJAKT.md` §7):
- U13: omlåsning bara med rådatabelägg.
- U14: notis även för returpassagen.
- U15: egen öppningsvarning för returresan.
- U16: "strax" aldrig på en position äldre än 10 min.
- U17: säkerhetsvarningen för en tyst båt behålls.
- U18: två positioner krävs innan en vändning tros.
- U19: en planerad varning skickas även när en vändning väntar.
- U20 och U22: ETA-etappen (F06 och F07) prövades men integrerades inte, eftersom 45
  enskilda ETA-påståenden i banken blev sämre. F06 och F07 står kvar som kända fel.
- U21: ingen sen returnotis efter ett långt AIS-avbrott.

**Motorn efter kampanjen.** Körningen är `npm run hunt`, standard, seed 1, på aa71099 med
registret.
- Utfall: 263 utslag i 46 kluster, varav 10 kandidatkort. Den första rapporten gav
  22 kandidatkort.
- Självtestet är grönt.
- Kvarvarande kandidater:
  - **ETA (U22, uppskjutna):** INV-3 SÅGTAND och OSCILLATION i idealradio, i banken
    (21h, fasvariant) och i stress. E2-prototypen sparas för en senare ETA-etapp.
  - **T2 LEDTID (9 världar):** tre utan täckning eller vändning (263, 290, 313), två
    returer där den egna varningen kom vid nästa fix (936, 1918) och ett
    bakkantsfall (979).
    - Ny mekanism: när en vändning bekräftas via RE_CROSS under en annan bro hålls
      målbron tom, och varningen kommer sent (1274).
  - **T2 OKLASSAD (10 världar):** 1208 (NEW_JOURNEY utan målbro i samma tick), 1316
    (retur utan egen varning) och samma tomma målbro som ovan (1317). Övriga ligger
    604–619 s efter händelsens första passage.
  - **T3 (11 världar):** RECOVER-släpp vid täckningsslut som U17 täcker men där
    restiden är mer än 0,6 av tiden kvar, och därför gränsfall.
  - **Stress:** ett T2-fall.
- Beslutskort: D1-KAJZON-DEMOTION (KONFLIKT) är fortfarande öppen.

## Rättningskampanjens varv 2 (2026-11-09)

Ägaren beslutade att ett andra varv skulle köras på de restkort som inte gäller ETA:
- F02, T2 LEDTID (9 världar);
- F05, T2 OKLASSAD (11 fynd);
- F06, T3 VARNING-EFTER (10 fynd);
- F07, T3 FRUSET-FIX (2 världar);
- F08, stress (1);
- B01, KONFLIKT D1-KAJZON-DEMOTION.

Två triagerare gick igenom fynden värld för värld. Mekanismerna rättades i sex familjer, och varje familj granskades adversariellt och reviderades tills den godkändes. Granskningarna hittade verkliga fel som provvärldarna missade:
- falska varningar vid GPS-utliggare (A);
- tidiga varningar vid Järnvägsbron när en klass B-båt sänder glest (D);
- att motorns U17-villkor först litade på appens egna flaggor (E).

| Commit | Familj | Rättning | Världar |
|---|---|---|---|
| 811c723 | A | Målbron i samma tick som en bekräftad vändning (NEW_JOURNEY och RE_CROSS), med riktningskontroll och under-bro-vakt | 936, 1208, 1274, 1316, 1317, 1918 |
| b6a4002 | C | Återfödd båt med kurs i dödbandet får målbro ur förflyttningen | 756, 977, 1913 |
| c798e9b | F | U23: köaren vid Kajen står kvar. Kajavgången inne i kapseln och köbeviset genom en kapsel | 313 och kajköerna |
| b38eabc | B | Bakkantens färskhet mot korsningen, krypfartens fysik och U24: egen varning före första passagen | 790, 979, 1094, 1476, 1794 |
| 25862ee | D | Spärren vid en tidigare bro: rask fart efter bron vid onormal tystnad, aldrig före bron | 263 |
| 7b449bb | motorn | U17/K-NÄSTA på appens dom med oberoende fysik, fixtid, gemensam RECOVER, kajpredikatet, U23/U24-posterna och radiomodellen vid avgång | 941, 972, 138, 290, 625 med flera |

Övriga fynd var redan beslutade beteenden som motorn tidigare missade. Exempel är U17-släppen vid täckningsslutet (1973, 537, 625, 1337, 1629, 1752, 479) och K-NÄSTA (510, 1704).

**Ägarens beslut under varv 2:**
- **U23 (kajen norr om Klaffbron):** en båt på väg mot Klaffbron som stannar vid Kajen behandlas som i resten av väntområdet. Hon står kvar tills hon kör vidare, sänder navStatus 1/5 eller har legat stilla i 2 timmar. Andra båtar vid Kajen, och Gästhamnen, behandlas som förut.
- **U24 (C-IV väg b, smal):** en båt i en avfyrad händelse utan bokförd passage får sin egen varning när hennes egen tidsfrist går ut, i stället för vid täckningsslutet. Det gäller när hon är i rörelse, mer än 350 m från bron och efter fönstret enligt båda prognoserna. Ägaren godtog att en köande konvoj ibland får en extra varning.
- **M6 (spärren vid Järnvägsbron):** dirigenten valde den smala varianten EFTER-BRON, eftersom den inte har någon uppmätt kostnad i form av för tidiga varningar eller fantomer.

**Omlåst facit enligt U13**, med rådatabelägg i corpora.js-noterna:
- **20260806-42h:** S/V REBEL:s varning återställd, Klaffbron södergående 18 → 19. Fältappens varning kom 105 s före korsningen.
- **20260713-41h:** två övergångar blir "ETA okänd" för en båt i kö vid Järnvägsbron. Den gamla texten var fel med 41 min.

**Motorn efter varv 2.** Körningen är `npm run hunt`, standard, seed 1, på 7b449bb.
- Självtestet är grönt: determinism, SHIFT30 och MMSI 24/24, kanarier 5/5 och rundresa 45/45.
- Sanningsspåret: 2 000 världar och 222 råa utslag. De ger 6 kandidatkluster och 29 kluster
  med registerpost, alltså 43 kluster och 240 fynd med registertagna. Före varv 2 var det
  263 råa utslag och 46 kluster.
- Kandidatkorten är 7, mot 11 före varvet:
  - fem är ETA-kort, uppskjutna enligt U22 (INV-3 SÅGTAND och OSCILLATION, i bank och stress);
  - två gäller inte ETA, med ett fynd vardera, mot sex kort med cirka 34 fynd före varvet.

**Kvar efter varv 2** (frågor till ägaren och kända gränser; besluten står i nästa stycke):
- **1139 (T2 LEDTID):** en stilla köande båt omfattas inte av U24 och får dagens sena andra
  varning vid täckningsslutet. Avgjort genom U26.
- **1038 (T3):** efter B släpper bakkanten båten vid en sen bokföring, 12 s efter hennes
  korsning. Avgjort genom U25.
- **D1-luckan 300–500 m:** en helt stilla båt 300–500 m från sin målbro tappar målet efter
  20 min, även i farleden (`_isInTargetQueueZone`). Gränsen kommer från valideringskörningen
  2026-07-02. Fallet har inte setts i banken eller i provvärldarna. Avgjort genom U27.
- **U2-VS-DEADLINE och konvojfamiljen:** beslutsfråga 5–6 nedan står kvar. Ägaren skjuter upp
  den till efter fältprovet.
- **Kända gränser:**
  - A:s riktningskontroll ser inte en GPS-utliggare med vänd kurs bakom Järnvägsbron, som kan
    ge ett kort falsklarm för Klaffbron (ARCHITECTURE);
  - D:s restfönster: ett köfix under 2,8 kn strax efter tystnadsgränsen;
  - F:s rimlighetskrav vid kajavgång tillåter 131 m på 3 min i 0,6 kn;
  - C:s grannfall vid återfödelse (ARCHITECTURE, känd gräns e).
- **eta-accuracy-rendered** var lastkänsligt: barnprocessen tog 32–42 s mot gränsen 25 s
  när maskinen var hårt belastad. Felet fanns redan på c14938f. Rättat i eda1839: gränserna
  vaktar bara mot häng (120 s per barn, 300 s totalt).

**Ägarens beslut efter varv 2 (2026-11-09):**
- **U25 (1038):** en varning som kommer efter båtens passage därför att händelsens första
  passage bokfördes för sent, när appen inte hade något tidigare underlag, godtas som en känd
  gräns. Appen ändras inte. Beslutet speglas i beslutsregistret (BUGGJAKT §7).
- **U26 (1139):** en stilla köande båt som U24 inte omfattar får täckningsslutets sena varning
  när hennes avgång inte hördes. Det godtas som en känd gräns. Appen ändras inte, och beslutet
  speglas i registret.
- **U27 (D1-luckan 300–500 m):** 20 min behålls tills vidare. Fallet har inte setts i fältdata
  eller i provvärldarna. Frågan tas upp igen om det syns i fält (docs/ARCHITECTURE.md,
  docs/reliability-spec.md).
- **Konvojfrågan (beslutsfråga 5–6, C-IV):** uppskjuten till efter fältprovet.
- **Nästa steg:** ägaren kör grenen på sin egen Homey som fältprov enligt docs/VALIDATION.md
  §Fältprov. Någon ny version släpps inte i Homey App Store nu.

## Ägarens beslut 2026-11-04

Ägaren besvarade beslutsfrågorna 1–3 nedan och gav regeln för omlåsning:

- **U13 (facit).** Låst facit får låsas om när en rättning ändrar utfallet, men
  bara där rådatafacit visar att det nya beteendet är rättare. Rådatafacit är de
  verkliga korsningarna (gt-passages) och öppningsgrindarnas O1/O2. Varje
  ändring motiveras per korpus, i noten i `tests/replay-validation/corpora.js`
  och i docs/, enligt `docs/VALIDATION.md` §Facit-fällan.
- **U14 (B01, en notis per passage).** En båt som passerar en bro, vänder och
  passerar tillbaka får en notis även för returpassagen. Besöksregeln
  2026-09-07 justeras därmed: en verklig passage tillbaka ger en egen notis,
  men en båt som bara ligger och guppar eller väntar vid bron får inte flera.
  INV-5/7 blir kontraktet.
- **U15 (B02, egen varning för returresan).** En båt som passerar, vänder och
  kommer tillbaka får en egen öppningsvarning, även inom konvojfönstret.
  Beslutet följer U2 (båtar som anländer efter passagen är nästa öppning) och
  principen att en missad öppning är värre än ett falsklarm. INV-21 blir
  kontraktet.
- **U16 (F18/F19, F40-studsen).** Beteendet behålls: appen visar aldrig
  "strax" på en position som är äldre än 10 min. Motorn registrerar studsen
  som DESIGN.

Frågorna 4–7 är fortfarande öppna.

## Beslutsfrågor

Frågorna 1–3 avgjordes 2026-11-04 (se ovan). Texten står kvar som underlag.

1. **B01 · INV5-VS-BESÖKSREGEL (KONFLIKT).**
   - Fallet: en U-sväng 125–308 m bortom en målbro ger två registrerade
     målbropassager men bara en notis, eftersom båten aldrig lämnar besöket.
     Det gäller 32 utslag i 30 världar (14 av dem F-USVÄNG) och en
     stressvärld. Exemplet `fynd/B01-…` är WILMA vid Klaffbron: 1 båt,
     181 rader, R0.
   - Doktrinerna: INV-5/7 kräver en notis per registrerad målbropassage, även
     returen (`docs/VALIDATION.md:296–300`). Besöksregeln 2026-09-07 ger en
     notis per besök (`lib/services/TriggerPointVisitTracker.js:12–16`,
     `docs/ARCHITECTURE.md:1040`).
   - Frågan: ska det vara en notis per passage eller per besök?
   - Följder: väljer du besöksregeln behöver INV-5/7 ett undantag för en
     retur inom samma besök, och posten blir DESIGN. Väljer du notis per
     passage ändras besöksregeln i appen. Banken fäller inte INV-5 i dag.
     Svaret avgör också grupp 3, där en bokförd retur som W750:s hamnar här.
2. **B02 · U2-RETURRESA (KONFLIKT).**
   - Fallet: en U-svängare absorberas i sin egen äldre händelse och korsar
     tillbaka inom konvojfönstret utan egen varning. Det gäller 18 världar,
     varav 13 F-USVÄNG. Exemplet `fynd/B02-…` är VEGA vid Stridsbergsbron:
     1 båt, 117 rader, R0, retur 538 s efter utresan.
   - Doktrinerna: INV-21-texten säger att returen är en helt äkta ny öppning
     (`tests/replay-validation/invariants.js:866–871`). U2 säger en varning per
     öppning, och väntande båtar hör till samma händelse
     (`docs/etapp7-plan-2026-08-08.md:9`).
   - Frågan: är returen en ny öppning med egen varning, eller hör den till
     båtens egen äldre händelse? Ta frågan i konvojbeslutet (punkt 6).
3. **F40-studsen (F18 och F19): DESIGN, MÄTGRÄNS eller hysteres?**
   - Fallet: en köande gles sändare tappar "strax" när positionen blir äldre
     än 600 s (STALE_ETA_HARD: `app.js:6995–6999` och :7171–7175,
     `lib/constants.js:1133`) eller när B4:s 90 s-tak släpper ett uttömt
     "strax" (`app.js:257`). Texten lånar då nästa båts ETA, och "strax"
     kommer tillbaka med samma båts nästa fix, i F18:s minsta repro 25 ms
     senare. INV-3:s studsdiskriminator
     (`tests/replay-validation/invariants.js:302–319`) antar att en ärlig
     degradering ger en stabil ny nivå, och fäller.
   - Varje steg följer beslut: U1 och C11 (`docs/etapp7-plan-2026-08-08.md:8`,
     :267), U6 (:15) och F40-avvägningen
     (`docs/helgranskning-2026-07-06.md:271–274`: ETA-hopp vid 600 s-gränsen
     för väntande glesa sändare).
   - Omfattning: F18 och F19 är samma apphändelse i stressvärldarna 1608 och
     1907. Samma mekanism ger 17 utslag i realistiska R1-världar: 14 av F04:s
     och 3 av F06:s. Taggen STRESS-TÄTHET gör alltså inte fallet till en
     stressartefakt.
   - Frågan: (a) en registerpost, antingen DESIGN med källorna ovan eller
     MÄTGRÄNS för INV-3 när hoppet sammanfaller med åldersgränsen eller
     90 s-taket och återgången med samma båts nästa fix; eller (b) hysteres i
     appen, så att en bekräftad köväntan behåller sin text i stället för att
     låna nästa båts ETA.
   - Följder: (a) flyttar inget facit, och posten ska beskriva mekanismen, inte
     stressnivån. (b) flyttar golden-text i banken, där F40-hoppen redan finns.
4. **INV-10:s granularitet i `replay:all` (rekommendation).**
   - INV-10 (`tests/replay-validation/invariants.js:476–503`) godtar bara ett
     bekräftat väntintervall som når nästa textövergång. Harnessen startar ett
     nytt intervall när fixglappet är längre än 10 min
     (`tests/replay-validation/replayRunner.js:293–311`). En korrekt lång
     köväntan med glesa fixar kan därför fälla INV-10, som i första rapportens
     F18 (värld 1228).
   - Motorn behandlar en kedja av intervall som mätgräns
     (MÄTGRÄNS-INV10-VÄNTKEDJA): högst 30 s mellan intervallen, ingen
     halvminutstick i något glapp, högst 30 s svans och start senast 10 min
     efter strax-övergången. Tickvillkoret behövs, eftersom en korrekt app byter
     text vid en tick när positionen inte är färsk
     (`lib/services/BridgeTextService.js:304–308`).
   - Rekommendation: lägg samma kedjeregel, med tickvillkoret, i INV-10, så att
     `replay:all` och motorn dömer lika, och ta sedan bort registerposten.
     Annars kan en gles fältkorpus med lång köväntan ge falskt rött i
     `replay:all`. Banken har inga INV-10-utslag i dag, så ändringen flyttar
     inget låst facit; den kan bara ta bort utslag, och tickvillkoret hindrar
     att en äkta strax-zombie döljs. Ändringen rör harnessen och kräver ditt
     beslut.
5. **Övriga KONFLIKT- och KÄND_ÖPPEN-poster i rapporten.**
   - **U2-VS-DEADLINE (KÄND_ÖPPEN):** 34 utslag (T2 OKLASSAD 23, T2 LEDTID 6,
     stress 5). Frågan är C-IV:s val a, b eller c, eftersom U2 och
     deadline-garantin inte går att förena
     (`docs/etapp7-plan-2026-08-08.md:310–349`).
   - **J13-J14-KONVOJSEMANTIK (KÄND_ÖPPEN):** 3 världar. Ska en öppning stängas
     av en medlems passage, som i dag, eller av första faktiska passagen oavsett
     medlemskap (`docs/ARCHITECTURE.md:1611–1628`)?
   - **BN1-BOXKANT (KÄND_ÖPPEN):** 2 träffar i banken (20260806-42h och
     20260909-80h, Kanalinfarten). Frågan är beslutspunkt 2 i
     `docs/helgranskning-2026-11-03.md:162–172`: ska en utåtriktad transit vid
     ytterpunkterna räknas som utfärd, eller ska bevakningsboxen vidgas?
   - **D1-KAJZON-DEMOTION (KONFLIKT, avgjord 2026-11-09 genom U23, se varv 2 ovan):** 1 värld (R1). En båt som står still
     minst 3 min i Kajens kapsel med målbron mer än 600 m bort demoteras, och
     texten blinkar "Inga båtar" (INV-14). Zonregeln
     (`lib/constants.js:415–470`) står mot INV-B1/D1
     (`docs/reliability-spec.md:83`, :102). Är demotionen avsedd?
   - De övriga KÄND_ÖPPEN-posterna (OMSTART-DEFAULT-FÖRE-FÖRSTA-FIX,
     K20-FASKÄNSLIG-LEDARE, FIXD-SLINGA, LATENT-INBROMSNING och
     P8-L6-SPÖKTEXT) gav inga utslag.
6. **Konvojfamiljen som ett beslut (rekommendation; uppskjuten av ägaren 2026-11-09 till
   efter fältprovet).**
   `docs/ARCHITECTURE.md:1621–1622` kräver ett användarbeslut och ett
   omlåsningsprotokoll med O1/O2-mätning för hela konvojfamiljen. Ta därför
   U2-VS-DEADLINE, B02, J13-J14 och J13+J33 i samma beslut som rättningarna i
   grupp 1 och 2. Alla flyttar samma facit, och grupp 2 lämnar fler båtar åt
   RECOVER-släppet i grupp 1.
7. **Fixarnas fas mot halvminuterna.** `npm run replay:phase` byter bara
   korpusens ankarrad (filhuvudet i `tests/replay-validation/runPhaseSweep.js`).
   Fassvepet var grönt för hela banken vid `7699cbe`, medan buggjägarens
   M-FAS, som flyttar hela korpusen, fann F07–F09. Vill du att den dimensionen
   ska vara en stående grind behöver fassvepet, eller en ny grind, flytta hela
   korpusen. Annars prövar bara `npm run hunt` den.

## Registerändringar att granska

Rättningsrundorna ändrade beslutsregistret
(`tests/replay-validation/bugHunt/beslutsregister.json`) på 15 punkter. Listan
med skäl och källor står i `docs/BUGGJAKT.md` §7, under "Registerändringar att
granska". Inga nya ägarbeslut har skrivits, och varje post pekar på sin källa.
Sammanfattning:

- **Två nya poster omklassar utfall och bör granskas först:**
  - **S10-VÄNDNING-BRON-BAKOM** (DESIGN; rad 8, 10 och 15; första rapportens
    F15). Källan är S10-vakten, som godkändes i FIXRUNDA 6
    (`docs/ARCHITECTURE.md:1928`). Predikatet spelar Fix D:s pending-logik på
    raderna och kräver Fix D:s fartgräns `FIX_D_MIN_SOG`, som läses ur appens
    källtext. Modellen antar att Fix D-blockets övriga villkor håller. Posten
    används 3 gånger i körningen.
  - **MÄTGRÄNS-INV10-VÄNTKEDJA** (MÄTGRÄNS; rad 7 och 12; första rapportens
    F18). Se beslutsfråga 4. Posten används 1 gång.
- **Snävade poster (motorfel):**
  - **KIE-PER-KORPUS** (rad 1, 9 och 11): samma episod inom |δ| + en tick,
    plus undantagets längd bara när tiden är episodens slut. Ett undantag
    förklarar högst en träff per variant och aldrig något på den låsta banken.
    42h-flashen är ACCEPTERAD vid alla fem δ.
  - **D4-RIKTNING-UNKNOWN** (rad 2) gäller bara M-FAS-riktningsbyten.
  - **U2-RETURRESA, U2-VS-DEADLINE och J13-J14-KONVOJSEMANTIK** (rad 4–6)
    delar nu definitionerna med T2-oraklet
    (`tests/replay-validation/bugHunt/lib/konvoj.js`). Netto blev det fler
    kandidater (T2 OKLASSAD: R0 1 → 5, R1 34 → 50, stress 1 → 5), och en värld
    (750) gick från KANDIDAT till U2-VS-DEADLINE.
- **Märkta poster:** fem poster har verkan `iOraklet` (rad 3 och 13). Oraklet
  tillämpar beslutet självt, registret prövar dem aldrig, och orakelvakten
  pekar på en symbol i stället för rader.
- **Taggposten STRESS-TÄTHET** (rad 14) når nu INV-F-fynd. En omklassande post
  måste fortfarande namnge INV-id:t.
- Vid integrationen lades KANALINFARTEN-FP8-SYDGRIND till, O1-posten
  utvidgades och besöksregelns predikat godtar ett besök som var öppet i
  starttillståndet (§7, stycket före listan).

## Motorartefakter som rättats under triagen

- **F05 i första rapporten** (T10 PASSAGE-EJ-REGISTRERAD, R0, krypfart
  0,4 kn) var en radioartefakt: under 0,25 m/s fick båten sog 0 och
  stillakadens, vilket M02 rättade med fysiskt rörelsetillstånd
  (BUGGJAKT §4.2), och nyckeln bär nu U-svängsklassen i F10.
- **F08 i första rapporten** (T10 FANTOMPASSAGE(target)) var en sen men äkta
  registrering av en krypande båt som T10 kallade fantom, vilket M01
  (kopplingsfönstret, bilaga B T10) och M02 rättade, så kortet försvann.
- **F18 i första rapporten** (INV-10 STRAX-ZOMBIE, värld 1228) var en korrekt
  lång köväntan som ett fixglapp på 10 min 13 s delade i två bekräftade
  intervall, och den registrerades som mätgränsen MÄTGRÄNS-INV10-VÄNTKEDJA
  (§7 rad 7 och 12).
- **F21 i runda 1** (T1 FÖRVARNINGSFORM-EFTER-PASSAGE, stress, värld 856)
  byggde på en tidslik fix som appen ännu inte hade fått, eftersom notisen gick
  ut i 30 s-stegets dränering innan raden på samma tid matades in, och E6
  rättade T1 så att F21 försvann medan F13 står kvar (bilaga B T1).

## Kända gränser

- **R1 är okalibrerad.** Realismgrinden (p50 inom ±30 %, p90 inom ±40 %) är
  röd för båda erorna. aisstream klarar 2 av 4 mått (glapp i rörelse p50/p90
  101/325 s mot fältets 129,5/538,3 s) och AISHub 1 av 4 (71/123 s mot
  61/119 s). R1-kort är därför robusthet tills R0-bekräftelsen säger annat.
  F10–F16 och stresskorten F18, F19, F20 och F22 reproducerar inte med R0.
  Pröva R0-motsvarigheten i `repro.spec.json` innan ett R1-kort prioriteras
  (BUGGJAKT §15).
- **Modellgränser som berör korten** (BUGGJAKT §4.5): U-svängen är en vändning
  på stället med momentant kursbyte på 180° (grupp 3 och 6, B01 och B02).
  AIS-klassernas sändregler modelleras inte, så en krypande klass B-båt hörs
  oftare än i fält (grupp 8). Bankfynd krymps inte i v1 (F07–F09).
- **Länkarna är inga rotorsaker.** En länk säger att korten bär samma
  apphändelse eller mekanism, inte att de har samma rotorsak (BUGGJAKT §9).
  F01↔F10 (3 världar) är en undre gräns: T10 ser bara returer med en
  beslutsam fix högst 600 m från bron inom 10 min. Värld 18 har samma
  obokförda retur men inget T10-utslag.
- **Inte utrett per utslag:** F01:s 17 absorberade utan egen varning och 2
  övriga, F12:s värld 1227, F13:s värld 783 och de 17 F04-utslag som saknar
  F18:s mekanism. F04:s representanter är avgångskedjan.
- **Vad v1 inte prövar** (BUGGJAKT §12): transportlagret (AISStreamClient,
  AISHubClient och muxens källhälsa), inställningsändringar under körning,
  klocksteg, krasch utan flush, plattformsfel i kort, token och enheter, fusion
  av två källor, P8/L6, ETA-noggrannhet per båt (T7), spöktext per båt (T5),
  utgånget ETA-löfte (T8) och artefakter från den synkrona ticken. Sträckmålen
  omstart (T11, F-OMSTART), liveness (T6), isolering (M-ISO), textepisoder i
  M-FAS, adversariell radio (R2), NAME/QR, krympning av bankfynd och nya
  radiodragningar i bekräftelsen är inte byggda.

## Bilaga: kortnumreringen

Motorrättningarna numrerade om korten två gånger. Äldre text, även
`docs/BUGGJAKT.md` §7, använder ibland de gamla numren.

| Nu | Runda 1 (23 kort) | Första rapporten (18 kort) | Mekanism | Grupp |
|---|---|---|---|---|
| F01 | F01 | F02 | T2 ÖPPNING-MISS:OKLASSAD (R0) | 2 (och 1, 3) |
| F02 | F02 | F01 | T2 LEDTID<60s (R0) | 1 |
| F03 | F03 | F03 | T3 VARNING-EFTER-SANN-PASSAGE (R0) | 1 |
| F04 | F04 | F04 | INV-3 ETA-SÅGTAND UPP (R0) | 7 (och F40) |
| F05 | F05 | F07 | INV-14 DEFAULT-FLASH (R0) | 8 |
| F06 | F06 | F06 | INV-3 ETA-OSCILLATION (R0) | 7 (och F40) |
| F07 | F07 | F09 | INV-3 ETA-SÅGTAND UPP, bank 20260708-21h | 7 |
| F08 | F08 | F10 | M-FAS PASSAGENYCKEL TAPPAD, bank 20260917-16h | 9 |
| F09 | F09 | F11 | M-FAS ÖPPNINGSNYCKEL TILLAGD, bank 20260710-13h | 9 |
| F10 | F10 | F05 | T10 PASSAGE-EJ-REGISTRERAD (nu R1) | 3 |
| F11 | F11 | F12 | T3 VARNING-PÅ-FRUSET-FIX (R1) | 1 |
| F12 | F12 | F13 | INV-13 MÅLBRO SOM MELLANBRO (R1) | 4 |
| F13 | F13 | F14 | T1 FÖRVARNINGSFORM-EFTER-PASSAGE (R1) | 5 (och 3) |
| F14 | F14 | F16 | T3 FANTOM-UTAN-AVBROTT (R1) | 1 |
| F15 | F15 | F17 | T9 FEL-RIKTNING (R1) | 6 |
| F16 | F16 | — | T10 FANTOMPASSAGE(intermediate) (R1) | 4 |
| F17 | F17 | — | T2 ÖPPNING-MISS:OKLASSAD (stress) | 1 |
| F18 | F18 | — | INV-3 ETA-OSCILLATION (stress) | beslutsfråga 3 |
| F19 | F19 | — | INV-3 ETA-SÅGTAND UPP (stress) | beslutsfråga 3 |
| F20 | F20 | — | T3 VARNING-EFTER-SANN-PASSAGE (stress) | 1 |
| F21 | F22 | — | T2 LEDTID<60s (stress) | 1 |
| F22 | F23 | — | T3 VARNING-PÅ-FRUSET-FIX (stress) | 1 |
| — | F21 | — | T1 FÖRVARNINGSFORM-EFTER-PASSAGE (stress) | motorartefakt (E6) |
| — | — | F08 | T10 FANTOMPASSAGE(target) | motorartefakt (M01, M02) |
| — | — | F15 | T1 NOTIS-UTEBLIVEN | DESIGN via S10-VÄNDNING-BRON-BAKOM |
| — | — | F18 | INV-10 STRAX-ZOMBIE | MÄTGRÄNS-INV10-VÄNTKEDJA |
