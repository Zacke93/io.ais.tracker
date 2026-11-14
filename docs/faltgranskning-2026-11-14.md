# Fältgranskning 2026-11-14: fältprovet 10–13 november

Utgångspunkt: `e51c7b6`, appversion 5.4.0, körd två gånger på ägarens egen Homey. Sju
granskare gick igenom loggarna: integriteten, driften, öppningsvarningarna respektive
notiserna och brotexten i varje körning, och de tio mekanismerna från 3–9 november. Felen
rättades i sju familjer. Varje rättning granskades adversariellt av en annan agent och
reviderades tills granskaren godkände den. Familjerna slogs sedan ihop ovanpå `e51c7b6`
(commitlistan i avsnitt 5). Dokumentet stämmer med `e439f58` (25 commits ovanpå `e51c7b6`,
med omlåsningen `014d024` och rättningen av C2 efter buggjägarens körning). Alla tider är UTC;
svensk tid var UTC+1. Fältloggarna ligger inte i repot.

## 1. Sammanfattning

Fältprovet omfattade 66 timmar i två körningar och 28 verkliga passager av Klaffbron och
Stridsbergsbron. Appen kraschade aldrig, startade en gång per körning och klarade att Homey
var utan nät i 4,5 timmar. Alla 79 notiser och 28 öppningsvarningar kvitterades av Homey
inom en halv sekund. Brotexten följde formatet hela vägen, och prognoserna låg mycket
närmare verkligheten än i den inspelade trafiken. Trafiken var dock nästan bara yrkesfartyg
utan köer, så fältet säger lite om fritidsbåtar.

Det allvarligaste felet var en verklig broöppning utan färsk varning. PRICKBJORN varnades
för Stridsbergsbron den 12 november 08:30, låg stilla 460 m från bron i nästan fyra timmar
och passerade 12:35 utan ny varning: den gamla varningen räknades som samma ankomst.
Valideringsverktygen kallade körningen grön, eftersom de räknade den fyra timmar gamla
varningen som täckning.

Rättat är ankomstspärren efter ett långt stopp, en varning som kom 51 minuter för tidigt
efter en vändning, notisen vid Järnvägsbron söderut som kom först vid passagen, en prognos
som sa "om 32 minuter" när båten var framme efter 7, en falsk "under AIS-tystnad", en båt
som stod kvar i texten när hon lagt till vid kaj, och fyra driftfel efter nätavbrottet.
Verktygen ser nu varningens ålder och tidshål i loggen. Bara rättningen vid Järnvägsbron
flyttar låst facit. Ingen körning kan låsas som facit: loggvägen från Homey till datorn
tappade sex block utan att något larmade.

Kvar är 18 beslutsfrågor (avsnitt 7). Viktigast är när en gammal varning ska sluta gälla,
som hör ihop med den uppskjutna konvojfrågan, och hur appen ska väga tidig mot sen varning
när en båt vänder och sedan inte hörs. Prognosarbetet (U22) är fortfarande uppskjutet.

## 2. Körningarna och vad de täcker — och inte täcker

| Körning | Intervall | Timmar | Loggrader | AIS-sampel | Notiser | Öppningsvarningar | Brotexter | Målbropassager |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| k1 | 10/11 21:44 – 12/11 16:21 | 42,6 (38 med logg) | 381 239 | 4 222 | 44 | 16 | 155 | 16 |
| k2 | 12/11 19:19 – 13/11 18:50 | 23,5 | 243 092 | 2 803 | 35 | 12 | 90 | 12 |

**Trafiken.** k1 hade sex rörliga fartyg: PILOT 761 (lotsbåt, 8–9 kn), MONIKA, PRICKBJORN,
MARIETJE HESTER, NORDIC SOLA och LIANNE (1–3 kn), med fyra hela genomfarter, tre kajbyten vid
Kanalinfarten, väntan vid Järnvägsbron i båda riktningarna, en vändning norr om
Stridsbergsbron, tre båtar samtidigt 11/11 13:11–13:30 och PRICKBJORNs fyra timmar stilla
460 m från Stridsbergsbron. k2 hade sex genomfarter med fem fartyg i 4–10 kn (NAVEN, ASPEN,
WILSON ALSTER, NORDIC SOLA och PRICKBJORN två gånger); PRICKBJORN lämnade området vid norra
kanten och kom tillbaka efter 6,5 h. Ingen båt i rörelse saknade position i mer än 2 min.
Granskarna är inte eniga om typerna i k1: en räknade all trafik som yrkestrafik, en annan
två av båtarna som fritidsbåtar.

**De tio mekanismerna från 3–9 november** (sonder i replay, som återger fältets varningar
och notiser exakt):

| Commit | Mekanism | I fält | Dom |
|---|---|---|---|
| `811c723` | Målbron i samma tick som en bekräftad vändning | 2 (k1) | 1 rätt; 1 stoppad av kajprovet (PILOT, 5.2) |
| `b6a4002` | Återfödd båt med kurs i dödbandet | 0 | Rätt att den inte slog till |
| `c798e9b` | U23, köaren vid Kajen | 0 | Ingen båt stannade vid Kajen eller Gästhamnen |
| `b38eabc` | Bakkanten, krypfart, U24 | 5 domar, en arm | Rätt; krypfysiken och U24 användes aldrig |
| `25862ee` | Spärren vid en tidigare bro, tystnadsregeln | 140 uppdateringar | Tystnadsgränsen avgjorde aldrig |
| `aa71099` | U14, notis för returpassage | 2 | 1 rätt; 1 fel form (5.5) |
| `2c3f778` | U15, returresans egen varning | 0 | Returerna kom 37 min–6,7 h efter, minnet redan gallrat |
| `f198d52` | RECOVER, bakkanten, passagetid efter glapp | 27 av 28 passager | Skattningen 0–29 s före rådatan; RECOVER aldrig |
| `e088a51` | Krypfart förbi en passerad bro | 5 tillfällen | Rätt, ingen blinkning |
| `8a013d5` | Avgångs-ETA | 3 avgångar | 2 rätt, 1 missad (5.4) |

Av överlämningens kända gränser syntes bara U27 (avsnitt 6). **Inte prövat i fält:**
fritidsbåtar och glesa klass B-sändare, köer vid Kajen och Gästhamnen, konvojer med
absorberade följare, GPS-hopp, omstart mitt i en anflygning, AIS-tystnad medan en spärr
håller en båt, "cirka" och "ETA okänd" av ålder, och fler än tre båtar samtidigt.

## 3. Integriteten och loggvägen

Integritetsgrinden (`checkReplayIntegrity.js`) gav FEL för båda körningarna; fassvepet var
grönt för båda, med och utan monitoring. Loggen tappade hela block medan appen körde vidare:

| Körning | Bortfall | Längd | Vad som saknas |
|---|---|---|---|
| k1 | 11/11 02:21:05 – 06:53:09 | 4 h 32 min | Homey utan nät; ingen AIS-indata förlorad, men avbrottstexten, minst 17 UI-versioner och borttagningen av CAPELLA |
| k1 | 11/11 20:37:30, 20:40:30, 20:44:45 | 90, 90, 156 s | Fyra AISHub-pollar och åtta fixar, alla för förtöjda båtar |
| k2 | 13/11 06:17:30 | 90 s | En poll med två fixar |
| k2 | 13/11 07:03:31 | 88 s | En poll med tre fixar, bland dem PRICKBJORN 27 m från Stridsbergsbron mitt i passagen |

Fyra oberoende detektorer hittade samma sex bortfall och inga andra. Grinden fångade de fem
korta genom sin källbokföring men saknade kontroll av tidshål, så en logg med bara det långa
hålet hade fått OK. Raderna försvann med stor sannolikhet mellan Homey och homey CLI: inga
halva rader finns, datorn var vaken, och under de korta bortfallen hade Homey internet.
CLI:ns varning för bruten ström anropas aldrig med homey-api 3.20.1, så bortfallen är tysta.
Samma signatur fanns i tre körningar i september. Körning 2 avslutades 18:50:33 av en
macOS-uppdatering som loggade ut användaren; arkivkopian av loggen blev stympad, men
live-filen var hel.

**Därför kan ingen körning låsas.** `docs/VALIDATION.md` §Fältprov kräver "Logg-integritet:
OK", och belagt bortfall får inte kringgås. Hålet i k1 förblir FEL fast indata är komplett,
eftersom appens texter och notiser under hålet är okända. Början av k2 (19:19–06:14, 10,9 h,
18 notiser och 6 varningar) är ren; se F17.

**Ändrat inför nästa körning** (familj V, 5.8): grinden letar tidshål och fångar alla sex
bortfallen, loggskriptet sparar loggen före summaryn och redovisar "Arkivsynk", och
`replay:field` ger rapport med FEL-banner. Vilka rader som saknas kräver löpnummer (F16).
**Ägaren bör** koppla Homey med nätverkskabel, stänga av automatiska macOS-uppdateringar och
"Installera i natt", hålla datorn vaken, köra under `tmux` eller `nohup` och läsa routerns
logg om nätet faller igen.

## 4. Det som fungerade

- **Drift.** Inga krascher eller ohanterade fel. Nätavbrottet klarades utan omstart:
  avbrottstexten visades i stället för ett falskt "Inga båtar", och AISHub kom tillbaka
  själv 70 s efter nätet. Halvminutsklockan som uppdaterar brotexten höll takten i 66 h.
- **Kvittenser.** Alla 416 skrivningar av brotext till enheten och 418 till appens globala
  värde kvitterades, med rätt värde vid återläsning; alla 79 notiser och 28 varningar inom
  0,5 s.
- **Format.** Alla 245 brotexter följde det beslutade formatet. Inga spöktexter; i k2 kom
  "Inga båtar" 0–1,5 min efter sista målbropassagen varje gång. "Strax" byggde aldrig på en
  position äldre än 90 s (U16).
- **Notiser.** Rätt bro och riktning, inga dubbletter. I k1 kom alla 44 före passagen utom
  returnotisen "har precis passerat" (U14). I k2 kom fem vid eller efter passagen: tre vid
  Järnvägsbron söderut (rättat, 5.3) och två i 10 kn där zonen på 300 m korsades mellan två
  positioner (känd gräns).
- **Prognoser.** Medianfelet var 0,6–0,7 min för notisernas ETA och 0,9–1,1 min för
  brotextens, mot bankens 1,51 min (p90 21,7 min, 14,9 min för optimistisk). Fältet hade
  nästan inga köer, och det är köerna som ger bankens svans.
- **Öppningsvarningar.** Alla 28 passager hade en varning före sig, ingen varning kom efter
  en passage, och inget kort kom under det hårda golvet 60 s. 27 hade en varning högst två
  timmar gammal. 26 av 28 varningar följdes av passage inom 20 min, mot 229 av 438 i
  banken. Median ledtid 5,1 min (k1) och 4,9 min (k2) mot bankens 14,8: yrkestrafik i
  6–10 kn varnas 4–5 min före. Två öppningar 39 min isär (ASPEN, WILSON ALSTER) fick fyra
  varningar, inte två.
- **Replay** av körningarnas jsonl återgav alla 28 varningar och 78 av 79 notiser;
  skillnaderna kom av testriggen, inte appen (5.8).

## 5. Fynden och rättningarna

| Commit | Familj | Rättning |
|---|---|---|
| `c742d72` | A | Ankomstspärren i farleden: avgången efter ett stopp på minst två timmar är en ny ankomst |
| `00f493b` | B | Kedjearmens spärr gäller från första målbrofixet efter en bekräftad vändning |
| `3fd74d5`, `8af8efd` | C | C1 failsafens retursläpp följer formregeln; C2 Järnvägsbron söderut |
| `b9a43ad` | E | Avgångsgolvet armeras efter en målbroövergång |
| `bad8a74` | D | Manöverskyddet kräver verklig rörelse vid kajerna söder om Kanalinfarten |
| `5088bcb`, `ba8bc1c`, `7b2eb3c`, `c2de493` | F | UI-ticken, loggraden, AISstream efter nätavbrott, korsnotiserna |
| `2fb64c6` … `6302dc6` (elva) | V | Varningens ålder, INV-22, tidsstegningen, tidshål, loggskriptet, `replay:field` |
| `33f2b07` | – | VALIDATION: antalet syntetiska scenarier (100; 101 med C3) och WARN-baslinjen |
| `014d024` | – | Omlåsning av golden-events för sju korpusar (C, U13) |
| `6d4149f`, `e439f58` | C | C3: FIX U behåller väntan under parbron i positionens eget pass (felet i C2 som buggjägaren hittade), och en skärpt scenarioförväntan |

Familjerna är squashade; varje commitmeddelande nämner familjens egna commits.

### 5.1 Ankomstspärren i farleden (A, `c742d72`)

**Situationen.** PRICKBJORN vände norr om Stridsbergsbron 12/11 och gick söderut i 6–7 kn.
Stridsbergsbron#19 gick 08:30:31 (09:30 svensk tid). 08:34:57 stannade hon 460 m norr om bron,
i farleden utanför de ritade kajzonerna, och låg stilla i 3 h 53 min; bron öppnade 11:28 för
NORDIC SOLA utan henne. Hon lade ut 12:28:43 och korsade 12:35. Öppningsmotorn avfyrade #25
12:32:48, men appen höll inne kortet (`[OPENING_DEDUP_PERSIST] … samma ankomst`). Användaren
fick bara närnotisen "närmar sig Stridsbergsbron, om 2 minuter" 12:31:40.

**Mekanismen.** Ankomstspärren (`app.js` `_observeOpeningArrivals`) har ingen tidsgräns sedan
`33b9fbf` och släpps av passage, bortfärd ≥ 350 m eller bekräftat stopp följt av avgång. Ett
stopp räknades bara i en ritad kajzon eller för en förtöjd båt mer än 600 m från bron. Hon
räknades därför som köande, fast 2 h-backstoppen förtöjt henne och textlagret släppt henne
efter 19 min (U27).

**Rättningen.** Innanför 600 m utanför kajzonerna bär ankomstposten ett persisterat
farledsstopp (inom 50 m samma stopp trots fartbrus, glapp och omstart). Det släpps när det är
minst 2 h gammalt och appen inte längre håller båten som köare (förtöjd, eller inte kortets bro
som målbro). Avgången kräver två avgångsfix i följd (≥ 50 m, ≥ 0,5 kn), det andra inom 10 min
och längre bort. I k1 levereras #25, 133 s före korsningen; banken är bitlik. Prövas av
`tests/opening-fairway-long-stop.test.js` och scenariot `stopp-4h-460m-…-i-farleden` med nya
förväntningarna `maxOpeningAgeS` och `minOpeningLeadS`; ARCHITECTURE §Förtöjningslagren.

**Vad granskningen ändrade.** Första versionen godtog avgången på ett fix: ett GPS-hopp på
60–120 m hos den förtöjda båten gav falskt kort, och den verkliga avgången fick sedan inget.
Ett glapp på 15 min med fältets fartbrus nollade 2 h-klockan, och bandet 300–350 m efter en
passerad bro släpptes aldrig. Revisionerna gav stoppet egen ålder, två avgångsfix och en
tidsgräns för det första.

**Inte rättat.** Kursbandet vid avgången (F6), kortare stopp och navstatus (F4), bankens
spärrade återavfyrningar (F1), priset för två fix (F3). Två basfel bör utredas separat: ett
falskt Klaffbronkort cirka 2 min efter ett GPS-hopp hos en förtöjd båt, och ett andra
Klaffbronkort till CHARLYS DREAM efter en omstart 12:25 i 20260804-both-21h.

### 5.2 Kedjearmen efter en vändning (B, `00f493b`)

**Situationen.** PILOT 761 låg 222 m norr om Stridsbergsbron 11/11 12:00–12:31 och vände
söderut. Klaffbron#7 gick 12:34:57 med "eta 25". Hon låg 34 min i kön vid Järnvägsbron och
korsade Klaffbron 13:25:42, 50,7 min efter varningen.

**Mekanismen.** Spärren vid en tidigare bro (`BridgeOpeningService._earlierBridgeAhead`)
räknade en opasserad bro emellan bara med passerade broar eller en köpost. Vändningen tömde
båda, kajprovet stoppade samma-tick-målbron, och köposter skapas först på andra målbrofixet.
Kedjearmen beväpnades utan spärr, och 10-knopsdeadlinen löpte ut fem sekunder före nästa fix.

**Rättningen.** Efter en bekräftad vändning räknas båtens egen opasserade målbro och broarna
bortom den som broar emellan. Märket `_reversalConfirmedAt` sätts efter U18:s två positioner,
släcks av första köposten eller förtöjning och sparas inte över omstart. PILOT varnas nu
13:15:44, 10 min före passagen; banken är bitlik. Spärren loggar `[OPENING_HOLD]` när den
börjar och slutar. Prövas av `tests/opening-chain-arm-reversal-hold.test.js` och fem scenarier.

**Vad granskningen ändrade.** Första versionen gällde alla kedjearmar utan historik och
flyttade tre korpusar. Granskaren mätte då sena varningar för båtar som hörs första gången
eller efter omstart och sedan går fort i tystnad: flera under 60 s, fyra efter passagen och en
ovarnad passage, där basen gav minst 181 s. Regeln begränsades till bekräftade vändningar.

**Inte rättat.** Restklassen efter vändning med tystnad (F2), värld 1208 i syntetsviten
(472 → 280 s, "eta okänd"), kortets siffra 12 mot verkliga 10 min (F13). Klaffbron får nu två
kort för troligen en öppning, PILOT 13:15 och MONIKA 13:23 (F1).

### 5.3 Järnvägsbron söderut (C2, `8af8efd`)

**Situationen.** I k2 kom alla tre sydgående notiser för Järnvägsbron vid eller efter
passagen: ASPEN 01:33:00 (korsning 01:32:50), WILSON ALSTER 02:11:30 (02:11:34) och NORDIC
SOLA 16:06:30 (16:06:07), alla "om 1 minut", fast en position 115–208 m före bron kommit
44–56 s tidigare. För PRICKBJORN 13:56:38 låg passagefixen 23 m förbi linjen; fältet gav av
en slump den sanna "har precis passerat", replay "närmar sig … strax".

**Mekanismen.** Broarna ligger 260 m isär. Fixen som bokför Stridsbergsbron ligger redan i
Järnvägsbrons zon, sätter FIX U (tvingad väntan vid parbron) och ett 30 s-fönster som håller
kvar Stridsbergsbron som aktuell bro. Kandidatvalet prövade inte Järnvägsbron i den ticken;
efter fönstret tvingade vakthunden väntan på den gamla fixen. Avståndsprövningen frågade
inte vilken sida båten låg på.

**Rättningen.** Medan FIX U-flaggan lever erbjuds parbron som kandidat om den inte är bokförd
och båten inte ligger bortom den (`app.js` `_getFlowTriggerCandidates`): notisen går på
passagefixen, 30–61 s tidigare med samma text. Ligger båten mer än 10 m bortom parbron rensas
flaggan (`StatusService.isBeyondForcedWaitingBridge`, `FIX_U_SKIP_PAST_LINE`) och passerad form
kommer vid bokföringen. I banken ändras 49 notiser i 16 korpusar: fem av sex förvarningar som
kom efter korsningen kommer nu före, och OSPREY går från falsk förvarning till sann passerad
form, 130 s senare. Medianfelet för notisernas ETA vid Järnvägsbron går 0,86 → 0,55 min.
Prövas av `tests/c2-jarnvagsbron-soderut.test.js`, ett F08-test i
`tests/zonintrade-uppskjutet-bevis.test.js` och två scenarier märkta `(C2)`.

**Omlåsningen.** 24 av notiserna (en från C1) ligger i låst golden-events för 20260708-21h,
20260712-25h, 20260804-both-21h, 20260806-42h, 20260909-80h, 20260917-16h och 20260918-7h: 22
ändrar bara tiden, ELFKUNGEN texten, SINE BRES tid och position, och i both-21h byter en notis
plats. Inga öppningar eller passager ändras. Rådatabelägg i `corpora.js`-noterna (U13).
Omlåst i `014d024`, efter dirigentens egen jämförelse av gammalt mot nytt facit: exakt 24
notiser ändras, alla flyttade kommer tidigare mot rådatans korsning, och de två som förut kom
efter korsningen (TIDAN 14 s efter, SINE BRES 34 s efter) kommer nu före (41 respektive 18 s).
De nya filerna är byte för byte lika med dem granskaren och sammanslagaren tog fram var för sig.

**Vad granskningen ändrade.** Inget beteende: ett nytt test för F08-skyddet i FIX U-grenen,
D6 nämnt och en loggrad när parbron läggs till. C2 tog också bort ett fasberoende: korpusen
med SINE BRES gav på basen 60 olika notisströmmar i 121 tidsförskjutningar, nu en.

**Felet som buggjägaren hittade efter sammanslagningen (C3, `6d4149f`).** Familjens tester,
banken och granskarens 13 motexempel godkände C2, men buggjägarens standardkörning på den
sammanslagna koden visade att räknaren för sena notiser gått från 1 till 4. Gränsen 10 m
bortom linjen var mindre än en båtlängd. När en båt redan låg låst under Stridsbergsbron (så
att inget 30 s-fönster öppnades) och nästa glesa position landade 12–31 m bortom Järnvägsbron,
rensade C2 väntan i samma pass; nästa position låg utanför notisradien, och notisen kom via
failsafen 202–367 s senare som "passerade … under AIS-tystnad". Basen gav där "närmar sig …
strax" på passagepositionen, 7–12 s efter korsningen, vilket appens egna regler godtar (under
bron, samma pass). I buggjägarens 2 000 världar (35 142 notiser) blev nio notiser 61–367 s
senare; räknaren visade bara de tre över två minuter. Rättningen: väntan behålls när
positionen ligger högst 50 m från parbron (`UNDER_BRIDGE_SET_DISTANCE`) och passet är
positionens eget (`ownCleanFixPass`: bara meddelandevägen skickar en ren positionsanalys;
ingen klockjämförelse). Ett senare pass på samma position (vakthunden) rensar som i C2, så
OSPREY-klassen behåller sann passerad form. Alla nio notiser har tillbaka basens tid; inget
annat av de 35 142 flyttas, banken och fältkörningarna är byte för byte oförändrade, och
omlåsningen står kvar. Granskaren godkände C3 efter 520 F08-följder och 121 tidsförskjutningar;
`e439f58` skärper en scenarioförväntan som annars kunde bli grön utan att pröva något.

**Inte rättat.** 18 förvarningar där båten redan är förbi bron (F9); "strax" på en position
upp till 50 m bortom linjen i positionens eget pass, 3–21 s efter korsningen (med 25 s
AISHub-latens upp till 46 s — basens beteende, F9); och F08:s kända lucka (en mellanposition
40–55 m bortom linjen). C2 rättar på annat sätt det ägaren sköt upp som D6 (F18).

### 5.4 Avgångsgolvet efter målbyte (E, `b9a43ad`)

**Situationen.** PRICKBJORN passerade Stridsbergsbron söderut 12/11 12:35:22, väntade 175 m
norr om Järnvägsbron till 12:52 med rätt vänttext och lade ut 12:53:33 i 1,1 kn. Texten sa
"om 32, 33, 25 minuter" när verklig tid var 6,7, 6,1 och 5,0 min.

**Mekanismen.** Målbytet armerar en hold som svarar "ETA okänd" under 1 kn. Holden
returnerade före det enda stället som matar avgångsigenkänningen, så väntans stillasampel
nådde aldrig fartbufferten, avgångsgolvet (`8a013d5`) armerades inte och ETA:n räknades på
1,1 kn.

**Rättningen** (`ProgressiveETACalculator.js`, `_holdStillness`). Under en hold efter målbyte
bokförs stillheten för sig och prövas med samma krav som bufferten. Texterna blir "om 16, 17,
12" och det tidsviktade felet 14,1 → 6,3 min; bankens 3 103 påståenden är oförändrade.
Fyra senare påståenden blir 1–3 min sämre, bland dem kortet Klaffbron#27 "eta 6" → "eta 9"
(sanning 3,9): de gamla värdena var rätt bara för att överskattningen utlöste en släppning
av väntans baslinje. Prövas av `tests/e-avgang-efter-malbyte-2026-11-13.test.js` och två
scenarier. Inlagd enligt familjens och granskarens rekommendation (F13).

**Vad granskningen ändrade.** Koden godkändes, testen inte: sex av åtta test som fällde basen
gjorde det bara på `TypeError`. Granskaren visade också att kryp i kön efter målbytet räknas
som avgång och ger för låg ETA (kortet säger 8, sanningen 17); klassen är dokumenterad och låst
i ett informativt scenario. **Inte rättat:** EMA-svansen, golvet på dubbla
igångsättningsfarten ("om 16" mot 6,7) och avgångar där inget sampel når kalkylatorn (F13).

### 5.5 Falsk "under AIS-tystnad" (C1, `3fd74d5`)

PRICKBJORN kom tillbaka söderut 13/11 13:46:49 efter 6,5 h borta, låg 13:48:44 8 m från
Stallbackabron utan förvarning (morgonens besök stod öppet, F8) och fick 13:49:53
"passerade Stallbackabron under AIS-tystnad", fast positionerna kom var 28–68:e sekund.
U14:s retursläpp gick via failsafen, som släppte besöket innan notisvägen hann fråga
formregeln (tystnad kräver segment > 130 s och notis > 60 s efter korsningen). Nu skickar
failsafen formen med kandidaten och notisen säger "har precis passerat"; källan
`passage-fallback` står kvar, så dedup och INV-11 är oförändrade. Prövas i
`tests/u14-returpassage-notis.test.js`, där ett test som låste tystnadsmeningen är ändrat.

### 5.6 Manöverskyddet söder om Kanalinfarten (D, `bad8a74`)

**Situationen.** PRICKBJORN fick målbro Klaffbron 11/11 13:24:50 vid Kanalinfarten, vände
13:25:44 och låg från 13:27:47 still vid kaj 166 m från punkten. Texten sa "Två båtar på väg
mot Klaffbron" till 13:30:33, fast bara MONIKA var på väg. Manöverskyddet
(`VesselDataService._detectManeuverProtection`, kursändring över 45° utan fartkrav eller
fartsprång över 2 kn, på vilket avstånd som helst) återaktiverades 13:28:15 av kursbrus vid
fart 0,0.

**Rättningen.** När båda positionerna ligger söder om en gräns 40 m norr om
Kanalinfarten-punktens latitud och båten flyttat sig under 40 m, räknas kursbenet inte under
0,3 kn och inget ben vid fartsprång över 2 kn (`_maneuverLacksMovement`). Området är
FP9-H′:s (användarbeslutet 2026-07-18). PRICKBJORN släpps 13:28:15, 138 s tidigare. Banken
är bitlik. Prövas av `tests/falt-k1-manoverskyddets-kursben.test.js` och fyra scenarier.

**Vad granskningen ändrade.** Första versionen gällde överallt. Granskaren byggde 26 köfall:
i 15 visade den "Inga båtar" i 9–14 min medan båten köade 400–900 m från målbron, eftersom
kursbruset var det enda som höll henne kvar. Ett fartbrus vid kajen återställde dessutom
fältfelet. Revision 1 begränsade grinden till söder om punkten; revision 2 flyttade gränsen
40 m norrut, eftersom kajraden ligger på båda sidor om punktens latitud. **Inte rättat:**
PILOT 761:s falskstart 11/11 10:15 och ELFKUNGENs i juli kom av verkliga svängar (F11).

### 5.7 Driften (F)

**AISstream efter nätavbrottet (`7b2eb3c`).** Homey var utan nät 11/11 02:20–06:53 (03:20–07:53
svensk tid). AISHub svarade 06:54:21, AISstream först 07:31:34: klienten hade gått in i
timfasen och inget drog fram försöket, så statusen var "Degraderad" i 38 min. Nu drar muxen
fram AISstreams försök till 5 s plus jitter när AISHub kommer tillbaka (`nudgeReconnect`), om
socketen är nere, snabbfasen passerad, ingen rate-limit-spärr gäller, senaste försöket aldrig
nådde servern och inget dragits fram på 5 min. En server som inte svarar på TCP/TLS-nivå kan
då få 4–5 extra försök per timme (`tests/f1-aisstream-tidigt-forsok-efter-natavbrott.test.js`).

**Korsnotiserna (`c2de493`).** 06:55:09, 48 s efter att AISHub kommit tillbaka, gick tre
tidslinjenotiser inom 17 ms: "AISstream har varit tyst i över 4 h medan AISHub flödar" två
gånger och "… kan vara halvdöd". Båda källorna hade varit borta (BT-12: texten får inte påstå
mer än mätningen bär). Nu räknas bara tiden då grannen faktiskt levt, ackumulerat över glapp;
statusen och tom-kanal-nätet läser samma mått. Granskningen fällde två versioner: den första
nollställde vid varje grannglapp över 210 s, så att K22-trappan uteblev och notisen sa "på
28 min" efter ett dygn; den andra jämförde tider med exakt likhet, och klientens och vaktens
klockor skiljer 0–2 ms, vilket bara syns med riktig klocka. Slutversionen känner igen
episoden på lagrade stämplar och är provad med förskjutning och riktig klocka
(`tests/f2-korstystnad-efter-totalavbrott.test.js`).

**UI-ticken (`5088bcb`)** fyrade 1 ms före halvminuten 13 gånger och en gång dubbelt (12/11
03:53:59.999 och 03:54:00.001); nu bär timern sin målgräns. Replayns klocka löser aldrig ut
tidigt, så felet prövas bara i jest. **Loggraden (`ba8bc1c`)** kallade AISHubs nätfel "AIS
stream error"; nu står källan. **Heapen** steg cirka 1 MB per dygn i fält; en soak på 14 dygn
med forcerad GC visade att golvet planar ut efter 1–2 dygn (V8:s uppvärmning, ingen läcka).

### 5.8 Valideringsverktygen (V, elva commits)

- **Varningens ålder.** `runOpeningGates.js` skriver `⚠️ GAMMAL VARNING` när den färskaste
  varning som täckte en passage är över 120 min (O2:s `LATE_PASSAGE_WINDOW_MS`). Banken: 370 av
  378 bokförda passager har en färsk varning (97,9 % mot 99,5 %), mot rådatan 382 av 447. Elva
  återavfyrningar i banken hölls inne av spärren, nio följda av passage.
- **INV-22.** WARN när en "närmar sig"-notis byggs mer än 1 s efter rådatans korsning av samma
  bro i samma riktning: två utslag i banken på `e51c7b6` (OSPREY, SINE BRES), inga efter C2.
- **Tidsstegningen.** Harnessen kör timrar i 30 s-steg utan mikrouppgifter emellan (3 916
  kollisioner i banken mot cirka 4 i fält), och Homeys flow-kort tar median 420 ms mot mockens
  0 ms. Känd gräns i VALIDATION §Fältprov (F15).
- **Tidshål.** Grinden, `run-with-logs.sh` och `compareFieldReplay.js` larmar vid 65 s där
  `[COORDINATION_CLEANUP]`-minutslaget är belagt, annars 180 s. **Loggskriptet** synkar logg och
  jsonl före summaryn och skriver aldrig direkt till en terminal som kan vara död.
  **`replay:field`** ger rapport med `🚨 LOGG-INTEGRITET: FEL` först och felkod 1.
- **`docs/reliability-spec.md`** sa att målbrons notis gäller till ~500 m; koden prövar 300 m.

Granskningen fann att slutsynken misslyckades just när terminalen stängs: en kvarvarande
`echo` till den döda terminalen blev kvar i bash 3.2:s buffert och hamnade i nästa
kommandosubstitution, så logg och jsonl aldrig nådde arkivet; det syntes först med en riktig
pty och zsh. Den fann också att åldersmåttet valde fel varning (FILOU), att INV-22 dömde
annorlunda i buggjägaren och att `replay:field` inte gick att köra på fältkörningarna.

### 5.9 Fynd som inte rättades, och slutbatteriet

Den frusna nedräkningen, fartspiken och den dubbla ETA-beräkningen: F13. Besök som aldrig
stängs: F8. Notiser efter passagen i 10 kn (positionen 21–28 s gammal, zonen korsad mellan
två fixar): känd gräns (open3, radien 300 m). PRICKBJORN gick 10,3 kn mot deadline-motorns
tak 10 kn utan följd, eftersom ETA-grenen varnade 261 s före; värt en mätning i banken.
Händelser som städas utan att avfyras loggas fortfarande inte.

**Slutbatteriet på den sammanslagna koden (`e439f58`), varje steg med slutkod 0:**

| Steg | Utfall |
|---|---|
| jest | 384 sviter, 5 661 test gröna, 2 överhoppade (376 sviter och 5 469 test på `e51c7b6`) |
| lint | rent |
| `replay:all`, med och utan monitoring | alla låsta korpusar matchar facit |
| `replay:synthetic` | 101 scenarier rena (83 på `e51c7b6`), WARN-baslinjen 12 |
| `replay:openings` | godkänd; mot baslinjen tillkommer bara verktygens 18 informativa rader |
| soaken, med och utan monitoring, och `replay:monitoring` (72 h) | stabila, 0 processfel, inga kvarlämnade timers |
| `replay:phase`, med och utan monitoring | 24 korpusar gröna; k1 och k2 gröna i båda lägena |
| `hunt:selftest`, `hunt:quick` | gröna; samma tre kandidatkluster som på `e51c7b6` |
| `hunt` (standard, seed 1, 2 000 världar) | samma fem kandidatkort som på `e51c7b6` (F01–F05, alla INV-3 ETA); 240 utslag i 43 kluster |
| `measure:eta` | 0 ändrade av 3 063 parade påståenden; bara notiserna vid Järnvägsbron är omparade |
| `git status --porcelain` | tom |

Buggjägarens räknare mot `e51c7b6`: sena notiser i de syntetiska världarna 1 → 2 (basens egen
och ett fall i OSPREY-klassen, F9), och den nya kontrollen för förvarning efter passage ger
fem utslag som alla är en lucka i kontrollens regel (F14). Före rättningen av C2 var räknaren
för sena notiser 4; se avsnitt 5.3.

**Fältkörningarna i replay på `e439f58`**, med och utan monitoring: k1 ger 44 notiser, 17
öppningsvarningar (en mer än i fält: PRICKBJORN vid Stridsbergsbron 12/11 12:32:48) och 156
brotexter; k2 ger 35, 12 och 90. Varje skillnad mot `e51c7b6` är redovisad av sin familj, och
ingen samverkan mellan rättningarna syns.

## 6. Kända gränser sedda i fält

- **U27 syntes för första gången.** PRICKBJORN låg stilla 460 m från Stridsbergsbron och
  tappade målbron efter 19 min 21 s. Det var rätt, hon låg i praktiken förtöjd i fyra timmar;
  kostnaderna låg i den frusna nedräkningen, den uteblivna varningen och den sena målbron
  vid avgången (F5).
- **Tunna ledtider vid Stridsbergsbron.** Under den utlovade ledtiden 150 s kom 3 av 28
  varningar mätt som grindarna mäter (NORDIC SOLA 107 s, PILOT 761 och NAVEN 149 s) och 4 av
  28 mot när båten fysiskt var vid bron (även LIANNE 148 s), alla vid Stridsbergsbron; banken
  har sju, också alla där. Orsakerna är dokumenterade: krypfart mot Järnvägsbron följd av
  acceleration, och U18:s två positioner. Efter rättning A tillkommer PRICKBJORN med 133 s,
  som beror på kursbandet (F6, F7).
- **Kursbandet vid avgång.** En sydgående båt som lägger ut med kurs 225–232° får målbro först
  när kursen lämnar dödbandet (P5, känd gräns (b) för `b6a4002`) (F6).
- **Familjernas gränser** står i ARCHITECTURE och VALIDATION; de som kräver beslut finns i
  avsnitt 7. Övriga: GPS-drift framåt två fix i rad ger ett falskt kort (A); en omstart mellan
  Stridsbergsbron och Järnvägsbron ger basens tidiga varning (B); "strax" inom ±10 m från
  linjen (C); en båt med målbro som stannar söder om Kanalinfarten döljs 60–70 s tidigare (D);
  ett långt AISHub-avbrott skjuter upp påminnelserna om en tyst AISstream lika länge (F); hål
  under 65 s som inte sväljer en poll med fixar syns inte (V).
- **Omstart mitt i en anflygning** kan fortfarande tappa varningen; armarna sparas inte.

## 7. Beslutsfrågor till ägaren

I prioritetsordning; de får U-nummer (nästa lediga U28) när ägaren beslutat. "Den inspelade
trafiken" är de 24 låsta körningarna (cirka 485 h).

**F1. När ska en gammal öppningsvarning sluta gälla? (tas med konvojfrågan)**
- *Situationen.* När appen varnat för en båt varnar den inte igen förrän hon passerat eller
  tydligt åkt, så att en köande båt inte får dubbla varningar. Det är rättat för en båt som
  legat stilla minst två timmar. Kvar finns båtar som inte syntes ligga stilla: NENJA (juli)
  varnades 13:46, låg i gästhamnen, var tyst i 17 timmar och passerade Klaffbron 07:10 nästa
  morgon; appen ville varna 07:05 men höll inne. CALIMA tystnade 485 m från Klaffbron i två
  timmar och fick ingen varning före passagen. Fyra andra båtar passerade emellan i båda
  fallen. Elva varningar hölls inne så i den inspelade trafiken.
- *Alternativ.* (a) Som nu. (b1) En annan båts passage åt vilket håll som helst släpper
  spärren: räddar båda men ger tre extra varningar där den förra var färsk, en 1,8 min efter
  passagen, en andra varning till nästa båt i kön efter en omstart, och släpper köaren vid
  Kajen när bron öppnar för mötande trafik (mot U23). (b2) Bara samma håll: samma sena varning
  och dubbla varning efter omstart. (b3) Samma håll och minst tio minuter före den nya
  varningen: räddar båda utan uppmätt kostnad. (c) Två timmars tystnad släpper: räddar båda,
  men CALIMA bara med sekunders marginal, och principen att en varning överlever radiotystnad
  ändras. Inget alternativ ändrar hur många passager som har en varning före sig.
- *Konvojfrågan:* två båtar mot samma bro med några minuters mellanrum kan inte både få en
  varning per öppning (U2) och var sin varning i tid. PILOT 761 och MONIKA passerade Klaffbron
  4 min isär 11/11 och får efter rättning B två varningar (13:15, 13:23).
- *Rekommendation.* Behåll (a). Vill ägaren rädda NENJA och CALIMA: (b3), i samma beslut som
  konvojfrågan och efter att buggjägaren prövat den mot U24 och U26. Avstå från (c).

**F2. Efter en vändning: tidig eller sen varning när båten inte hörs?**
- *Situationen.* Efter rättning B väntar Klaffbronvarningen för en båt som vänt norr om
  Stridsbergsbron tills hon lämnat kön vid Järnvägsbron. Samma regel ger sen varning om
  båten vänder, hörs på två långsamma positioner och sedan går fort genom två broar utan att
  höras i 3–6 min. Appen har samma information i båda fallen. Mätt ledtid:

  | Fart efter vändningen | Före rättningen | Nu (a) | Med golv 8 kn (b) |
  |---|---|---|---|
  | 4 / 6 kn | 621–651 / 407–421 s | 175–457 / 181–281 s | 556–582 / 342–352 s |
  | 8 kn | 300–306 s | 81–165 s | 235–236 s |
  | 9 / 10 kn | 264–268 / 236–237 s | 45–127 / 17–96 s | 197–200 / 165–172 s |

- *Alternativ.* (a) Som nu: 12 av 24 provfall i 9–10 kn under 60 s, som lägst 17 s, men ingen
  varning efter passagen; provbåten väntar aldrig på broöppning, så verkligheten är troligen
  snällare. (b) Räkna som om båten går minst 8 kn: de sena fallen försvinner, men det tidiga
  felet kommer tillbaka när nästa position dröjer över 170 s (ett provfall 29,6 min för
  tidigt). (c) Ingen spärr efter vändning: PILOT-felet kommer tillbaka.
- *Rekommendation.* (a): det tidiga felet är sett i fält, det sena inte. Principen att en
  missad öppning är värre än ett falsklarm (U15) talar för (b).

**F3. Hur säker ska appen vara på att en båt åkt efter ett långt stopp?**
- *Situationen.* En båt har legat stilla minst två timmar och lägger ut; appen kräver nu två
  positioner i följd innan den varnar igen.
- *Alternativ.* (a) Två (som nu): ett GPS-hopp ger ingen falsk varning, men en båt som sänder
  var tredje minut kan få varningen under en minut före passagen eller inte alls (provfall:
  28 s eller ingen, mot 113–208 s med en). (b) En räcker: 1–3 min tidigare, men ett hopp på
  70–120 m ger falsk varning som förbrukar den riktiga. (c) En räcker vid minst 1,5 kn: alla
  provfall 89–407 s, men ett hopp med fartspik ger falsk varning igen.
- *Rekommendation.* (a). Fallet är sällsynt (ett på cirka 550 h), och en utebliven varning är
  inte sämre än före rättningen.

**F4. Stopp på 20 min–2 h, och navstatus "förtöjd", nära bron**
- *Situationen.* En varnad båt som stannar 300–600 m från bron i farleden kortare än två
  timmar och sedan passerar får ingen ny varning, inte heller om hon sänt "förtöjd". Vid
  Kajen ger navstatus en ny ankomst (U23).
- *Alternativ.* (a) Som nu. (b) Navstatus släpper som vid Kajen: 0 av 56 navstatusstopp i den
  inspelade trafiken följdes av passage; ett låst test från oktober (KINNE) skrivs om.
  (c) Kortare tid, till exempel 20 min: 19 verkliga köstopp på 300–500 m följdes av passage,
  det längsta 102 min, och skulle få en andra varning.
- *Rekommendation.* (a) för tiden, (b) för navstatus, så att farleden och Kajen beter sig lika.

**F5. U27: släpps en stilla båt 300–500 m från bron ur texten efter 20 minuter?**
- *Situationen.* U27 skulle tas upp om fallet syntes i fält. PRICKBJORN låg 460 m från
  Stridsbergsbron i nästan fyra timmar och följde inte med när bron öppnade för en annan båt;
  "Inga båtar" var rätt. Före släppet stod "om 4 minuter" fruset i 12,7 min och klättrade
  sedan till 28.
- *Alternativ.* (a) 20 min. (b) 2 h som vid Kajen: texten fel i två timmar. (c) 20 min men en
  ny text ("ligger still …"), vilket ändrar formatet.
- *Rekommendation.* (a); rätta hellre den frusna nedräkningen (F13). Efter rättning A styr U27
  bara texten, inte varningen.

**F6. Målbron när en båt lägger ut med kurs strax utanför sydbandet**
- *Situationen.* PRICKBJORN lade ut 12/11 12:28 med kurs 225–232°; kanalen går cirka 220° vid
  Stridsbergsbron, men sydbandet slutar vid 225°. Hon fick målbro 165 m före bron i stället
  för cirka 405 m, texten visade "Inga båtar" i fyra minuter, och varningen kom 133 s före
  passagen i stället för cirka 6 min.
- *Alternativ.* (a) Behåll som känd gräns. (b) Smal regel: låst riktning, kurs i samma sidas
  dödband, minst 2 kn och två positioner som närmar sig bron med 50 m; ingen ändring i den
  inspelade trafiken, en träff i fält, risken omätt. (c) Kursband mot kanalens riktning vid
  båten: bredare. (d) Nettofart norrut som för en återfödd båt: fångar inte fältfallet.
- *Rekommendation.* (a) nu, (b) efter att buggjägaren prövat omförtöjning nära en bro.

**F7. Tunna ledtider vid Stridsbergsbron**
- *Situationen.* NAVEN kröp mot Järnvägsbron i 10 min 12/11 och ökade 224 m före den.
  Varningen kom 149 s före passagen och sa "om 6 minuter" när bron öppnade efter 2. Spärren
  och att krypfart följd av acceleration äter ledtid är beslutat och dokumenterat.
- *Alternativ.* (a) Som nu. (b) Kortets siffra efter spärren räknas som avstånd genom fart:
  bara siffran ändras. (c) Släpp spärren på första position som visar avgång inom cirka 300 m
  före Järnvägsbron: cirka 187 s för NAVEN, kostnaden för köerna omätt.
- *Rekommendation.* Underlaget har ingen. Dirigentens förslag: (a) tills (c) är mätt, (b) i
  ETA-etappen.

**F8. Besök vid en bro som aldrig tar slut**
- *Situationen.* Appen skickar en notis per båt, bro och besök; ett besök slutar först när
  båten setts två gånger i rad över 350 m bort. PRICKBJORN fick "närmar sig Stallbackabron"
  13/11 07:12, försvann 288 m norr om bron och kom tillbaka 13:48, 8 m från bron, utan
  förvarning. 06:48 samma morgon fick hon ingen notis när hon lade ut från lotskajen 166 m
  från Kanalinfarten, där hon legat sedan dagen före. PILOT 761 likaså 11/11 11:42.
- *Alternativ.* (a) En båt som lämnar området utåt vid Stallbackabron räknas som utfaren: en
  ny notis i fält, högst en i den inspelade trafiken. (b) En båt borta minst 2 h får nytt
  besök: två i fält, missar återkomst inom 2 h. (c) En båt förtöjd minst 2 h i zonen får nytt
  besök när hon lägger ut: upp till tre i den inspelade trafiken; lotsbåten får en notis vid
  varje avgång.
- *Rekommendation.* (a) och (c). Besöksregeln från 2026-09-07 ändras, men båtar som guppar
  eller väntar vid bron berörs inte.

**F9. Vad får en båt som redan är förbi bron när appen ser henne?**
- *Situationen.* NEST (juli) dök upp 248 m söder om Stallbackabron på väg söderut och fick
  "närmar sig Stallbackabron, om 1 minut". Det finns 18 sådana notiser i den inspelade
  trafiken. OSPREY var 19 m förbi Järnvägsbron på passagepositionen och fick efter rättning C2
  passerad form först 130 s senare.
- *Alternativ.* (a) Som nu. (b) Ingen förvarning (upp till 18 notiser försvinner eller
  flyttas). (c) Direkt "X har passerat Y" (18 byter text, antalet står still), och samma sak
  på passagepositionen (en till fyra).
- *Rekommendation.* (c), även för passagepositionen.

**F10. När får en notis säga "har precis passerat"?**
- *Situationen.* Meningen väljs efter vägen notisen tog, inte efter beviset. SAGESSE (juli)
  hördes inte på 18 min och fick "har precis passerat Stridsbergsbron" 229 m bortom bron.
  111 notiser säger "har precis passerat", median 54 s efter passagen, 51 mer än 60 s efter.
- *Alternativ.* (a) Som nu. (b) "Har precis passerat" bara inom 60 s och 400 m, annars "X har
  passerat Y": 51 byter text. (c) Därtill "under AIS-tystnad" när passagen skedde i ett glapp
  över 130 s: 103 notiser byter till den meningen.
- *Rekommendation.* (b): litet, sant och tar bort "precis" där det inte stämmer.

**F11. Manöverskyddet söder om Kanalinfarten, och stilla köare norr om punkten**
- *Situationen.* Tre båtar fick målbro Klaffbron vid Kanalinfarten, svängde och lade till vid
  kaj, men stod kvar i texten: PILOT 761 11/11 10:15 ("om 13" som räknade upp till 21, 2 min
  46 s för länge), PRICKBJORN 11/11 13:25 (rättat) och ELFKUNGEN i juli ("om 23 → 31").
- *Alternativ.* (a) Som nu. (b) Avståndsgräns 500–600 m: tappar verkliga köbåtar mellan
  Klaffbron och Järnvägsbron (ANTJE, 747 m). (c′) Inget manöverskydd söder om gränsen 40 m
  norr om punkten: ändrar exakt de tre fallen, kräver omlåsning av en korpus, och en båt med
  målbro som stannar söder om punkten döljs då vid varje stopp.
- *Andra delen.* En båt som köar stilla i luckan norr om punkten hålls i dag kvar bara av att
  kursen råkar fladdra; en sändare med konstant kurs tappas efter fristen.
- *Rekommendation.* (c′). Andra delen saknar mätning och rekommendation; den behöver ett
  fältfall.

**F12. Larmet "AISstream kan vara halvdöd" efter 15 minuter**
- *Situationen.* AISstream var tyst 16–20 min sex gånger på 61 h med frisk anslutning, med
  bara förtöjda båtar i området. Appen visade "Degraderad" fyra gånger och skickade 13/11
  08:51 "anslutningen kan vara halvdöd". Gränsen är ägarbeslutet K22.
- *Alternativ.* (a) 15 min: högst en falsk notis per dygn i vintertrafik. (b) 25 min: inget av
  glappen larmar, men en död AISstream syns 10 min senare och marginalen är 5,3 min.
  (c) Texten "ansluten men har inte levererat några positioner på N", utan "halvdöd".
  (d) Larma bara om AISHub sett en båt i rörelse: granskaren avråder, eftersom kanalen kan
  sakna rörlig trafik i timmar (14,1 h i k1) eller veckor och en halvdöd AISstream då förblir
  olarmad.
- *Rekommendation.* (c), eventuellt med (b).

**F13. ETA-etappen (U22) med fältets belägg**
- *Situationen.* En stilla båt fick "om 4 minuter" fruset i 12,7 min och sedan en trappa till
  28 (inget sådant fall i den inspelade trafiken). En felaktig fart på 22,2 kn gav "strax" 3,8
  min före passagen. Prognosen räknas två gånger per position, så utjämningen går fortare än
  avsett. NAVENs kort sa 6 min mot 2. Rättning E gjorde tre texter 13–16 min rättare men fyra
  senare 1–3 min sämre, och kryp i kön ger nu "om 8" i 12,5 min när sanningen är 18.
- *Alternativ.* (a) Behåll uppskjutet. (b) Starta ETA-etappen med fältfallen: fartspiken först
  (liten), den frusna nedräkningen ihop med F5, den dubbla beräkningen sist (berör varje
  prognos och kräver omlåsning).
- *Rekommendation.* Låt rättning E ligga kvar, och ta (b) i den ordningen.

**F14. Ska gamla varningar och "närmar sig" efter passagen fälla grindarna?**
- *Situationen.* Verktygen räknade PRICKBJORNs fyra timmar gamla varning som täckning. Nu
  redovisas varningar över 120 min och "närmar sig"-notiser efter passagen, men bara som
  upplysning. Den inspelade trafiken har kvar sex passager med över 120 min gammal varning:
  NENJA och CALIMA (F1) och fyra långa väntor nära bron (MISTRAL, MOKENDEIST, ANDREA två
  gånger). "Närmar sig" efter passagen finns inte längre där efter rättning C2. I
  buggjägarens standardkörning ger den nya kontrollen fem utslag, men alla fem är förvarningar
  inför en returkorsning 28–150 s senare, där texten stämmer och bara notisens riktning är den
  gamla; notiserna är desamma på den gamla koden. Det är en lucka i kontrollens egen regel,
  som måste rättas innan den kan fälla.
- *Alternativ.* (a) Som nu. (b) 120 min fäller: röd på de sex tills F1 avgjorts och väntorna
  klassats. (c) "Närmar sig" efter passagen fäller nu.
- *Rekommendation.* (c) först när kontrollens regel för returkorsningar är rättad och
  buggjägaren inte visar kvarvarande fall; (b) efter F1.

**F15. Ska testriggen köra appens följdsteg i rätt ordning?**
- *Situationen.* Replay kör alla timrar i ett 30 s-steg utan att låta appens följdsteg köras
  emellan, och Homeys kort svarar på 420 ms mot riggens 0 ms. Det gav en felaktig notis i
  replay av k2.
- *Alternativ.* (a) Behåll som känd gräns. (b) Ändra riggen och lås om i två steg: först
  ordningen (låst text flyttas i 19 av 25 korpusar, inga notiser eller varningar kommer eller
  går), sedan 420 ms (23 av 25, en varningssiffra 9 → 10). Då återges fältets texter exakt.
- *Rekommendation.* (b), som ett eget steg efter den här omlåsningen.

**F16. Löpnummer i loggen och fångst till fil på Homey**
- *Situationen.* Grinden ser att rader saknas men inte vilka, och fångsten går via
  loggströmmen.
- *Alternativ.* (a) Inget. (b) Löpnummer i positions- och pollraderna: exakt vilka sampel som
  saknas, larm på sekunder. (c) Därtill en inställning som skriver sampeln till fil på Homey:
  överlever bortfall och nätavbrott men inte notiser och texter, kräver tak och rotation
  (cirka 1 MB per 42 h) och en väg att hämta filen. (d) En markering i loggen när strömmen från
  Homey bryts, och hålvaktens larm till fil så att det syns efter en natt.
- *Rekommendation.* (b) före nästa fältprov, (c) efter, (d) när det passar.

**F17. Körningarna som regressionsmaterial, eller nästa fältprov som korpus?**
- *Situationen.* Ingen körning kan låsas. Början av k2 (10,9 h; NAVEN, ASPEN, WILSON ALSTER)
  är ren, men valideringsreglerna beskriver inte låsning av bara en början.
- *Alternativ.* (a) Inget; nästa fältprov blir korpus. (b) Början av k2 som avgränsad
  regression, som SWIX- och AMELIA-utdragen 2026-10-05, efter fullt fassvep. (c) Lås den som
  korpus genom ett uttryckligt undantag.
- *Rekommendation.* Högst (b), enligt integritetsgranskaren. Gör F16 (b) först om nästa körning
  ska bli korpus. Låses en körning med glesa positioner och lång köväntan blir triagens
  beslutsfråga 4 från november aktuell.

**F18. Järnvägsbrofördröjningen (D6), som ägaren sköt upp i augusti**
- *Situationen.* Notisen för Järnvägsbron söderut kom i median 42 s efter första positionen i
  zonen; ägaren sköt upp D6 2026-08-05b. Rättning C2 löser notisdelen smalare än D6 skisserade
  och flyttar 24 låsta notiser.
- *Alternativ.* (a) Godta C2 för notisdelen; resten av D6 står kvar uppskjutet. (b) Ta ut C2.
- *Rekommendation.* (a), med det kriterium för att ta ut C2 igen som står i
  arkitekturdokumentet (till exempel två notiser för samma passage efter ett fältprov).

## 8. Lärdomar

- **Granskningen hittade det testerna inte såg.** I fem av sju rättningar fann granskningen
  verkliga fel som familjernas tester missade: A gav falskt kort vid ett GPS-hopp, B:s regel
  gällde för brett och gav sena varningar, D tog bort det som håller kvar köare, F:s K22-trappa
  uteblev (andra gången bara med riktig klocka och 0–2 ms skillnad), V:s skript sparade inte
  loggen när terminalen stängdes. I C och E prövade testen inte det de hette. Ett test ska
  fälla basen på beteende och överleva mutationer.
- **Fejkad klocka är inte riktig klocka.** I jest och replay går 0 ms mellan två
  klockläsningar, timrar löser aldrig ut tidigt och kort svarar direkt; på Homey skiljer
  läsningar 0–2 ms, timrar kan komma 1 ms tidigt och kort tar 420 ms. Kod som jämför tider med
  exakt likhet eller beror på följdstegens ordning ska provas med förskjutning eller riktig
  klocka. Åt andra hållet kan en skillnad mellan fält och replay vara riggens (V3).
- **Grön betyder inte rätt.** Grindarna kallade k1 grön fast en verklig öppning saknade färsk
  varning: O1 räknade den gamla varningen som täckning, O2 kallade samma varning fantom, och
  fältjämförelsen såg inget eftersom replay troget återgav felet. Verktyg som jämför appen
  med sig själv ser inte en varning som saknas.
- **Antal döljer fel.** k1 har 16 varningar före och efter rättning B, som tog bort en och lade
  till en. Jämför händelserna en och en.
- **Kör buggjägaren före sammanslagningen, och läs räknarna.** Rättning C2 var godkänd av
  familjens tester, banken och en adversariell granskning, men gjorde nio notiser minuter
  senare för glest sändande båtar. Det syntes först i buggjägarens standardkörning på den
  sammanslagna koden, och bara som en informativ räknare som gick från 1 till 4 — kandidatkorten
  var desamma. Banken innehåller inte alla lägen; populationen på 2 000 världar gör det oftare.
  Varje familj som rör notiser eller varningar bör jämföra hela populationen mot basen, inte
  bara korten, innan den lämnar ifrån sig.

## 9. Inför nästa fältprov

- [ ] Installera grenens HEAD (`e439f58` eller senare) och anteckna commiten; bestäm om versionsnummer och
      `.homeychangelog.json` ska ändras.
- [ ] Homey med nätverkskabel; automatiska macOS-uppdateringar och "Installera i natt"
      avstängda; datorn vaken; körning under `tmux` eller `nohup`.
- [ ] `debug_level` = `full`, annars saknas fångsten och minutslaget som hålgränsen bygger på.
- [ ] `./run-with-logs.sh`; följ `[HÅLVAKT]`, läs "Arkivsynk" och "Logg-integritet" efteråt.
- [ ] Efteråt `checkReplayIntegrity.js`, `npm run replay:phase -- <jsonl>` med och utan
      `REPLAY_MONITORING=1` och `npm run replay:field`; läs `GAMMAL VARNING` och INV-22.
- [ ] Faller nätet: spara Homeys tidslinje, eftersom loggen inte visar notiserna under hålet.
- [ ] Kör gärna sju dygn i följd, så att heapens golv kan ses plana ut.
- [ ] Se efter de nya vägarna: `OPENING_QUAY_DEPARTURE` efter ≥ 2 h stilla, `[OPENING_HOLD]`
      efter vändningar, `FIX_U_SKIP_PAST_LINE`, `ETA_DEPARTURE … under stationär-holden`,
      manöverskyddet vid Kanalinfarten, AISstreams framdragna försök och inga
      `aisstream:silent` direkt efter ett totalavbrott.
- [ ] Leta efter det som inte prövats: fritidsbåtar, Kajen och Gästhamnen, konvojer, GPS-hopp,
      omstart mitt i en anflygning, glesa klass B-sändare.
- [ ] Avgör F16 före körningen om den ska kunna bli korpus.
