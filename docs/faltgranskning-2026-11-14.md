# Fältgranskning 2026-11-14: fältprovet 10–13 november

Utgångspunkt: `e51c7b6`, appversion 5.4.0, körd två gånger på ägarens egen Homey. Sju
granskare gick igenom loggarna: integriteten, driften, öppningsvarningarna respektive
notiserna och brotexten i varje körning, och de tio mekanismerna från 3–9 november. Felen
rättades i sju familjer. Varje rättning granskades adversariellt av en annan agent och
reviderades tills granskaren godkände den. Familjerna slogs sedan ihop ovanpå `e51c7b6`
(commitlistan i avsnitt 5). Dokumentet stämmer med `1d8e0f9` (25 commits ovanpå `e51c7b6`,
med omlåsningen `b40488f` och rättningen av C2 efter buggjägarens körning). Alla tider är UTC;
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
**Omgång 2** (15–16 november, U28–U30, avsnitt 11) hävde uppskovet; avsnitt 10–11 stämmer med `57e4789`.

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
| `5129215` | A | Ankomstspärren i farleden: avgången efter ett stopp på minst två timmar är en ny ankomst |
| `2abc7ca` | B | Kedjearmens spärr gäller från första målbrofixet efter en bekräftad vändning |
| `7e4997e`, `897ba8d` | C | C1 failsafens retursläpp följer formregeln; C2 Järnvägsbron söderut |
| `b0b4f83` | E | Avgångsgolvet armeras efter en målbroövergång |
| `77d843e` | D | Manöverskyddet kräver verklig rörelse vid kajerna söder om Kanalinfarten |
| `b99d8b1`, `80e6020`, `09dc72d`, `f7e1ac6` | F | UI-ticken, loggraden, AISstream efter nätavbrott, korsnotiserna |
| `f85075a` … `24b0048` (elva) | V | Varningens ålder, INV-22, tidsstegningen, tidshål, loggskriptet, `replay:field` |
| `c13ca74` | – | VALIDATION: antalet syntetiska scenarier (100; 101 med C3) och WARN-baslinjen |
| `b40488f` | – | Omlåsning av golden-events för sju korpusar (C, U13) |
| `2556d7b`, `1d8e0f9` | C | C3: FIX U behåller väntan under parbron i positionens eget pass (felet i C2 som buggjägaren hittade), och en skärpt scenarioförväntan |

Familjerna är squashade; varje commitmeddelande nämner familjens egna commits.

### 5.1 Ankomstspärren i farleden (A, `5129215`)

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

### 5.2 Kedjearmen efter en vändning (B, `2abc7ca`)

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

### 5.3 Järnvägsbron söderut (C2, `897ba8d`)

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
Omlåst i `b40488f`, efter dirigentens egen jämförelse av gammalt mot nytt facit: exakt 24
notiser ändras, alla flyttade kommer tidigare mot rådatans korsning, och de två som förut kom
efter korsningen (TIDAN 14 s efter, SINE BRES 34 s efter) kommer nu före (41 respektive 18 s).
De nya filerna är byte för byte lika med dem granskaren och sammanslagaren tog fram var för sig.

**Vad granskningen ändrade.** Inget beteende: ett nytt test för F08-skyddet i FIX U-grenen,
D6 nämnt och en loggrad när parbron läggs till. C2 tog också bort ett fasberoende: korpusen
med SINE BRES gav på basen 60 olika notisströmmar i 121 tidsförskjutningar, nu en.

**Felet som buggjägaren hittade efter sammanslagningen (C3, `2556d7b`).** Familjens tester,
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
`1d8e0f9` skärper en scenarioförväntan som annars kunde bli grön utan att pröva något.

**Inte rättat.** 18 förvarningar där båten redan är förbi bron (F9); "strax" på en position
upp till 50 m bortom linjen i positionens eget pass, 3–21 s efter korsningen (med 25 s
AISHub-latens upp till 46 s — basens beteende, F9); och F08:s kända lucka (en mellanposition
40–55 m bortom linjen). C2 rättar på annat sätt det ägaren sköt upp som D6 (F18).

### 5.4 Avgångsgolvet efter målbyte (E, `b0b4f83`)

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

### 5.5 Falsk "under AIS-tystnad" (C1, `7e4997e`)

PRICKBJORN kom tillbaka söderut 13/11 13:46:49 efter 6,5 h borta, låg 13:48:44 8 m från
Stallbackabron utan förvarning (morgonens besök stod öppet, F8) och fick 13:49:53
"passerade Stallbackabron under AIS-tystnad", fast positionerna kom var 28–68:e sekund.
U14:s retursläpp gick via failsafen, som släppte besöket innan notisvägen hann fråga
formregeln (tystnad kräver segment > 130 s och notis > 60 s efter korsningen). Nu skickar
failsafen formen med kandidaten och notisen säger "har precis passerat"; källan
`passage-fallback` står kvar, så dedup och INV-11 är oförändrade. Prövas i
`tests/u14-returpassage-notis.test.js`, där ett test som låste tystnadsmeningen är ändrat.

### 5.6 Manöverskyddet söder om Kanalinfarten (D, `77d843e`)

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

**AISstream efter nätavbrottet (`09dc72d`).** Homey var utan nät 11/11 02:20–06:53 (03:20–07:53
svensk tid). AISHub svarade 06:54:21, AISstream först 07:31:34: klienten hade gått in i
timfasen och inget drog fram försöket, så statusen var "Degraderad" i 38 min. Nu drar muxen
fram AISstreams försök till 5 s plus jitter när AISHub kommer tillbaka (`nudgeReconnect`), om
socketen är nere, snabbfasen passerad, ingen rate-limit-spärr gäller, senaste försöket aldrig
nådde servern och inget dragits fram på 5 min. En server som inte svarar på TCP/TLS-nivå kan
då få 4–5 extra försök per timme (`tests/f1-aisstream-tidigt-forsok-efter-natavbrott.test.js`).

**Korsnotiserna (`f7e1ac6`).** 06:55:09, 48 s efter att AISHub kommit tillbaka, gick tre
tidslinjenotiser inom 17 ms: "AISstream har varit tyst i över 4 h medan AISHub flödar" två
gånger och "… kan vara halvdöd". Båda källorna hade varit borta (BT-12: texten får inte påstå
mer än mätningen bär). Nu räknas bara tiden då grannen faktiskt levt, ackumulerat över glapp;
statusen och tom-kanal-nätet läser samma mått. Granskningen fällde två versioner: den första
nollställde vid varje grannglapp över 210 s, så att K22-trappan uteblev och notisen sa "på
28 min" efter ett dygn; den andra jämförde tider med exakt likhet, och klientens och vaktens
klockor skiljer 0–2 ms, vilket bara syns med riktig klocka. Slutversionen känner igen
episoden på lagrade stämplar och är provad med förskjutning och riktig klocka
(`tests/f2-korstystnad-efter-totalavbrott.test.js`).

**UI-ticken (`b99d8b1`)** fyrade 1 ms före halvminuten 13 gånger och en gång dubbelt (12/11
03:53:59.999 och 03:54:00.001); nu bär timern sin målgräns. Replayns klocka löser aldrig ut
tidigt, så felet prövas bara i jest. **Loggraden (`80e6020`)** kallade AISHubs nätfel "AIS
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

**Slutbatteriet på den sammanslagna koden (`1d8e0f9`), varje steg med slutkod 0:**

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

**Fältkörningarna i replay på `1d8e0f9`**, med och utan monitoring: k1 ger 44 notiser, 17
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
- *Omgång 2:* F2 oförändrad; en vakt mot tidiga varningar söder om Olidebron infördes inte (11.4).

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
- *Beslutat 2026-11-15 (U30):* 20 min behålls. Före släppet visas en båt som legat stilla i fem
  minuter med färsk position, mer än 350 m från bron, som "En båt på väg mot <bro>, ETA okänd"
  i stället för en frusen siffra (docs/bridgeTextFormat.md). Infört i `57e4789` (11.3.5).

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
- *Omgång 2:* en fartökningsregel är mätt och omgjord och omgranskas; nya alternativ i 11.5.

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
- **Beslutat 2026-11-15 (U29):** (b) + (c). Gränsen för AISstream-sidans basnotis och status
  "Degraderad" är 25 min, med samma villkor för båda; en död AISstream syns 10 min senare, vilket
  ägaren godtar. Feed-vaktens tvångsåteranslutning (20–21 min) kommer före larmet. När
  anslutningen bevisligen lever (socketen öppen, pong inom 60 s) lyder notisen "AISstream är
  ansluten men har inte levererat några positioner på N medan AISHub flödar. Appens vakter
  försöker återansluta automatiskt."; annars står "… kan vara halvdöd" kvar. AISHub-spegeln,
  trappans 1 h/4 h/dygn och blindhetslarmet är oförändrade. Fältkörning 3 (14–15 november) gav
  fem tystnader till på 15,3–23,3 min. Med appens eget mått i app.log är fältets tystnader på
  minst 15 min nio på 100,2 h (k1: 3, k2: 1, k3: 5; siffrorna ovan för k1/k2 är jsonl-glapp, en
  övre gräns); ingen hade larmat vid 25 min. Alternativ (d)
  valdes inte (docs/ARCHITECTURE.md §K22/U29, `tests/u29-korstystnad-25min.test.js`).
  Infört i `bb546c2` (11.3.1); marginalen är fråga F23.

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
- *Beslutat 2026-11-15 (U28):* ETA-uppskovet hävs; ETA tas i små, mätta steg, och ett steg går
  bara in om ingen enskild ETA-uppgift i banken blir sämre (measure:eta, hela bandet) OCH inga
  nya kort uppstår i buggjägaren (annars lyfts påståendena och korten till ägaren).
- *Fartspiken (punkt 2):* mätt och granskad 2026-11-15/16; inte införd (dirigentens beslut
  2026-11-16). Fältfallet: körning 2, 13 nov 13:56Z, en AISHub-fix rapporterade 22,2 kn när
  förflyttningen sedan förra fixen var 356 m på 70 s (9,9 kn), i samma sampel som målbytet till
  Klaffbron; texten sa "strax" på 940 m i 3,8 min, och korsningen kom 3,7 min senare.
  Varningen påverkades inte. Skälen: felet har setts en gång på ca 100 h fält och aldrig i 519 h
  bank eller 2 000 jaktvärldar; vakten blev ca 300 rader i ETA-kedjans kärna med fyra nya
  tillstånd, omskrivning av historiken och en signal in i publiceringslagret; tre
  granskningsvarv där varje version påstod något som inte höll; och den vilar på antaganden som
  nästa ETA-steg rör direkt (K6-rättningen, idle-decayn). Grenen `omg2/ETA1-S` sparas med
  mätningarna (docs där). I stället loggas signaturen som `[ETA_SOG_SPIKE_CANDIDATE]` utan
  verkan och räknas efter varje fältkörning (docs/VALIDATION.md §Fältprov), så att ägaren vet
  hur ofta det händer innan vakten tas upp igen.
- *Beslutat 2026-11-15 (U30):* den frusna nedräkningen rättas med alternativ A2: "ETA okänd" för
  en båt som legat stilla i fem minuter med färsk position mer än 350 m från bron, tills hon rör
  sig igen eller släpps (U27). Alternativ A (alla avstånd) ändrar en låst text i banken (TIM); B
  löser inte fältfallet.
- *Omgång 2:* F07 och R7 infördes under U28; inbromsningen och notisen mot texten väntar (F19, F20).

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

- [ ] Installera grenens HEAD (`1d8e0f9` eller senare) och anteckna commiten; bestäm om versionsnummer och
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

## 10. Fältkörning 3 och korpuslåsningen

Tillagt 2026-11-15. Fältkörning 3 kördes på `1f6dd46` (den rättade koden) på ägarens Homey
Pro och är den första körningen sedan 18 september som klarar båda grindarna. Den är låst
som korpus **`20261114-34h`** i `f44b8dc` enligt VALIDATION §Fältprov och §Riktad
nyregistrering. F16 är inte infört; körningen blev korpus för att integriteten ändå var OK.

| Körning | Intervall | Timmar | Loggrader | AIS-sampel | Notiser | Öppningsvarningar | Brotexter | Målbropassager |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| k3 | 14/11 08:16 – 15/11 18:20 | 34,1 | 315 800 | 3 357 | 24 | 8 | 75 | 8 |

**Grindarna.** Integritetsgrinden mot hela källoggen: OK. Alla 3 357 rader är identiska
med loggens sampel, källbokföringen är OK (408 bootförankrade AISHub-kontroller, 407
fusionsfönster), och största luckan är 58,8 s vid starten, före första båten (UI-ticken
loggar bara när båtar finns). Grinden bevisar inte svansen efter sista räknarrapporten
(15/11 18:16:44, drygt tre minuter före loggens slut) och inte bortfall under 65 s som inte
sväljer en poll. Fassvepet är grönt med alla sex standardförskjutningar, med och utan
monitoring, utan undantag. Replay med och utan monitoring ger samma händelser och texter,
0 processfel, 0 invariantutslag och inga kvarlämnade timers. Fältet och replay har samma
notiser, varningar och texter utan innehållsskillnad.

**Mot rådatan.** Rådatafacit har 24 korsningar och zonbesök utan inferens: 20 brolinjer
och fyra zonbesök vid Kanalinfarten. En egen geometri, oberoende av `makeGtPassages.js`,
ger samma 20 linjekorsningar inom 3 s. Alla 20 brolinjenotiser kommer på en fix före
linjen, och Kanalinfartens fyra på första fixen inne i zonen. Varje målpassage har en
varning före sig, 137,8–657,5 s före korsningen, och ingen varning är äldre än 20 min vid
passagen. Mellan- och målpassagerna gäller samma fartyg och broar som rådatans korsningar,
bokförda inom korsningsfönstret eller på nästa fix.

**Rättning C2 prövad i fält.** Järnvägsbronotisen söderut går på Stridsbergsbrons
passagefix: NAVEN 14/11 23:00:27 på 239 m, 100,7 s före korsningen, och NINA BRES 15/11
01:25:31 på 150 m, 69,4 s före. Samma korpus på koden före C2 (`7e4997e`) ger 23:01:00
(68 s före) och 01:26:30 (10,6 s före); inget annat i händelser eller text skiljer.

**Det körningen täcker.** Fyra genomresor med lastfartyg, en åt gången: NAVEN och NINA
BRES söderut, LIDAN och SYLVIA norrut, 2,5–9,6 kn norr om Kanalinfarten. Tre förtöjda båtar
vid Kanalinfarten i 34 h (PILOT 761, PRICKBJORN och CAPELLA, som flyttade sig högst 2, 7 och
10 m): ingen notis, varning, passage eller text. Driftsidan fick en AISstream-server som
stängde och vägrade anslutning 22:24–22:32 och feed-vaktens första återanslutning 18:42,
båda utan båtar i rörelse.

**Det körningen inte täcker.** Inga köer, konvojer eller vändningar, inga långa stopp
(båtarna väntade bara 450 m söder om Kanalinfarten, utanför området) och inga kajbyten.
Inga fritidsbåtar eller klass B-sändare, inget GPS-hopp, ingen omstart, ingen "cirka" eller
"ETA okänd". Av rättningarna 14 november prövades bara C2:s huvudväg, UI-ticken (0 tidiga
och 0 dubbla av 4 085 tick) och loggraden `[OPENING_HOLD]` (sex spärrar med en start och ett
slut var) på hårdvara. A, B:s regel, C1, C3, D, E och F1 slog aldrig till, och F2:s kärna
prövades inte eftersom AISHub aldrig var borta.

**Kända gränser låsta som de är.** Korpusens not i `corpora.js` är minnet; när ETA-etappen
(U28) eller en rättning av spärren gör utfallen rättare låses de om enligt U13.
- *F7.* Stridsbergsbron#7 för LIDAN kom 137,8 s före passagen (130,7 s mot fixtiden), under
  utlovade 150 s, och sa "om 5" när 2,3 min återstod. Hon gick 2,5–3,5 kn mot Järnvägsbron och
  ökade till 4,4–5,1 kn; spärren släpptes först på fixen 352 m från bron.
- *K6/F13.* Tre Klaffbronotiser sa "om 3–4 minuter" i samma pass som texten bytte till
  "strax" 25 ms senare (NINA BRES, LIDAN, SYLVIA). Båtarna korsade 1,6–2,9 min senare.
- *±10 m-bandet (avsnitt 6, C).* LIDANs Stridsbergspassage bokfördes på en fix 10 m före
  linjen i 5,1 kn; texten blev "Inga båtar" 3,1 s före korsningen.
- *Zonen korsad mellan två fixar (5.9).* LIDAN fick notisen för Stallbackabron 29 s och SYLVIA
  för Stridsbergsbron 38 s före korsningen.

**Följder i repot.** Regressionstestet `tests/november14-field-corpus.test.js` prövar
Järnvägsbron söderut (fäller koden före C2), de åtta varningarna, de förtöjda båtarna och de
två kända gränserna. Banken har nu 25 låsta korpusar, 519,1 h. Buggjägarens kalibrering är
fryst på de 24 före och skrivs bara om med `freezeCalibration.js --write` och dess externa
källor, så jägaren varnar för den ändrade banken tills dess; testet som räknar den levande
banken (`geo-calib.test.js`) säger 25. Siffrorna i avsnitt 7 ("den inspelade trafiken", 24
körningar) är mätta före låsningen och står kvar.

**Batteriet efter låsningen**, varje steg med slutkod 0: jest 385 sviter och 5 670 test gröna
(2 överhoppade); lint rent; `replay:all` med och utan monitoring, alla 25 korpusar matchar
facit; `replay:synthetic` och `replay:openings` gröna; `replay:phase` över hela banken med och
utan monitoring, 25 korpusar gröna; `replay:monitoring` stabil; `hunt:selftest` grönt
(determinism, SHIFT30 och MMSI 25/25, med varningen om den frysta kalibreringen). I
`measure:eta` mäts 90 påståenden i korpusen: median 0,70 min, p90 2,31 min, 83,3 % inom två
minuter. Alla äldre golden-, GT- och korpusfiler har samma SHA-256 som före, och de delade
filerna har bara fått den nya id-posten.

## 11. Omgång 2: 15–16 november 2026

Tillagt 2026-11-16. Omgången utgick från `1f6dd46` och slogs ihop på grenen `omg2/integration`,
som sedan fördes över till arbetsgrenen. Slutbatteriet (11.8) kördes på `2d1aa75`; därefter har
bara dokument ändrats. Varje spår hade en egen rättare i en egen
arbetskopia och en oberoende granskare som mätte själv. Ändringen granskades om tills den blev
godkänd. De tunga körningarna (hela jest, `measure:eta`, buggjägaren och fassvepet) gick genom
en gemensam kö. Grenarna som inte slagits ihop är inte pushade. Alla tider är UTC.

### 11.1 Översikt

| Spår | Vad | Utfall | Commits / gren |
|---|---|---|---|
| Fältkörning 3 | Låst som korpus `20261114-34h` (avsnitt 10) | inne | `f44b8dc`, `6c74eac` |
| U29 | AISstream-tystnaden larmar efter 25 min; "halvdöd" bara utan livsbevis | inne, godkänd i första granskningen | `3c7654c`, `3847d56`; `bb546c2` |
| F07 | Klampen försvarar det användaren ser | inne, godkänd i fjärde granskningen | `00b378b` … `102344d`; `8b60f57` |
| F07 R7 | Samma regel för varje osedd baslinje | inne, golden-text omlåst i fyra korpusar | `ca9e199`, `d4964e4`; `397ade0`; `187f31e` |
| Verktygen | Buggjägarens luckor, invarianterna, `run-with-logs.sh`; appen orörd | inne, godkänd i andra granskningen | `4c02b82` … `dcaa423`; `225f826` |
| U30 | En stilla båt visas som "ETA okänd" | inne, godkänd efter omgörning | `60242ad`; `57e4789` |
| Fartspikskandidaten | Loggrad utan verkan | inne | `764d7c6` |
| Fartspiksvakten | Ersätter en orimlig fart i målbytessamplet | inte införd | `omg2/ETA1-S` (`208df56`) |
| Vakt söder om Olidebron | Senare varning vid förstakontakt | inte införd | `omg2/SPARR` (`e03694c`, prototyp) |
| Sågtand vid tyst främsta båt | Nedräkning och kö-delen | inte införd | `omg2/sagtand` (`b9b3eb9`, prototyp) |
| K6 och tidsmedveten utjämning | En beräkning per fix; utjämning som räknar tiden | vilar | `omg2/ETA2` (prototyp) |
| Spärren vid Järnvägsbron | Fartökningsregeln (F7) | godkänd i tredje granskningen, väntar på ägaren (F7) | `omg2/SPARR-d2` (`22a4e37`) |
| Inbromsningsregeln | Buggjägarens kort F02 | godkänd i tredje kontrollen, väntar på ägaren (F19) | `omg2/ETA2-C` (`1237091`) |
| Notisen mot texten | Notisens tid när texten säger "strax" | prototyp, väntar på ägaren (F20) | `omg2/ETA2-BC` (`6ee78f8`) |

### 11.2 Ägarbesluten U28–U30

- **U28 (2026-11-15), ETA-etappen.** Uppskovet (U20/U22) hävs. ETA tas i små, mätta steg. Ett
  steg går bara in om inget enskilt ETA-påstående i banken blir sämre (`measure:eta`, hela
  bandet) och buggjägaren inte ger några nya kort. Annars lyfts påståendena och korten till
  ägaren. Följden i omgången: F07 och R7 gick in. Inbromsningsregeln (en rad sämre) och
  notisen mot texten (fem sämre i den smalaste varianten) ligger hos ägaren. K6, den
  tidsmedvetna utjämningen och nedräkningen vid en tyst främsta båt klarade inte villkoret.
- **U29 (2026-11-15, F12).** Gränsen för AISstream-sidans tystnadsnotis och statusen
  "Degraderad" höjs från 15 till 25 min, med samma villkor för båda. När anslutningen
  bevisligen lever står det "ansluten men har inte levererat några positioner" i stället för
  "halvdöd". En död AISstream syns 10 min senare, och det godtar ägaren.
- **U30 (2026-11-15, F5 och F13, alternativ A2).** En båt med status "närmar sig" som legat
  stilla i minst fem minuter med färsk position, mer än 350 m från bron, visas som "En båt på
  väg mot <bro>, ETA okänd" i stället för en frusen siffra. U27 styr som förut när hon lämnar
  texten.

### 11.3 Det som gick in

#### 11.3.1 U29: AISstream-tystnaden larmar efter 25 minuter (`bb546c2`)

**Situationen.** På vintern rör sig ofta ingen båt i området på 15–23 minuter. AISstream
levererar då ingenting fast anslutningen är frisk, medan AISHub fortsätter rapportera de
förtöjda båtarna. I k3 visade appen "Degraderad" tre gånger och skickade två gånger "AISstream
har inte levererat några positioner på 15 min medan AISHub flödar — anslutningen kan vara
halvdöd" (14/11 12:03 och 15/11 18:16). Nästa meddelande kom båda gångerna på samma socket,
15 respektive 48 s senare.

**Ändringen.** Gränsen är 25 min för både notisen och statusen. Är socketen öppen och kom
senaste pong inom 60 s lyder notisen "AISstream är ansluten men har inte levererat några
positioner på N medan AISHub flödar. Appens vakter försöker återansluta automatiskt." Annars
står den gamla texten kvar. Feed-vakten tvingar fram en återanslutning efter 20–21 min, alltså
före larmet.

**Granskningen.** Godkänd i första varvet. En död AISstream larmar fortfarande vid första
minutkontrollen efter 25 min, sedan efter 1 h, 4 h och ett dygn. Vaktens återanslutning
nollställer inte tystnaden. De fem låga anmärkningarna är åtgärdade i `3847d56` utan ändrat
beteende. Där står bland annat att ett klocksteg bakåt kan hålla kvar "Degraderad" och att
granskarens prov genom riktiga klienter nu är ett permanent test.

**Mätningen.** Med appens eget mått fanns nio tystnader på minst 15 min på 100,2 h fält (k1 3,
k2 1, k3 5) och ingen på 25 min. Uppspelade genom riktiga klienter gav fältets tystnader 0
"Degraderad" och 0 notiser med U29 i alla 16 körningarna, mot fältets falsklarm på den gamla
koden. Den längsta tystnaden var 23,33 min (k3 14/11 18:21:50), alltså 1,7 min under gränsen.
Den slutade 2 min 20 s efter vaktens återanslutning, på den nya socketen, så det går inte att
avgöra om den var naturlig eller en hängning som vakten lagade. Granskaren skattar
falsklarmen till ungefär ett var 2–5 vecka i vintertrafik, mot cirka två per dygn med 15 min.
Underlaget är 100 h under en årstid.

#### 11.3.2 F07: klampen försvarar det användaren ser (`8b60f57`)

**Situationen.** Buggjägarens bankkort F03 kommer ur en tidsförskjuten uppspelning
(δ −11,52 s) av den inspelade körningen 20260708-21h. JAATTEN II ledde texten mot Klaffbron.
AVALON, som texten inte visade, hade en extrapolerad tid på 25,3 min som ingen användare sett.
Publiceringsklampen (RC4) försvarade den mot de färska 13,4 och 11,9 och klampade till 18,9.
När ledarens tid nollades sa texten 07:11:30 "om 19 minuter", fast den färska beräkningen var
12–13 och bron öppnade om 4,5 min.

**Ändringen.** En båt som inte är den texten visar dämpas mot det texten faktiskt visar, med
klampens steg: högst max(3 min, 25 % av det visade) per fönster. Alla osedda båtar mot samma
bro delar en gräns i klampens 30 s-fönster, så att de tillsammans inte kan sänka texten mer än
en ensam båt. Dämpningen gäller bara på ett fix som går ihop med båtens egen rörelse: kvoten
mellan förflyttningsfarten och den rapporterade farten får vara högst 1,35, och fixet får inte
vara GPS-misstänkt. Referensen är det senast renderade värdet. Det gäller till nästa rendering,
högst 60 s.

**Granskningen.** Fyra varv, underkänd tre gånger:
- Första versionen släppte klampen fritt. Vid en låg utliggare blev texten 4–8 min för
  optimistisk: "om 10" mot sanningen 14, och "om 6" mot 14.
- Två osedda båtar kunde sänka texten två steg i samma sekund (14 → 11 → 8, sanningen 14).
- Gruppens golv följde inte med när det visade värdet steg inom fönstret, så att texten kunde
  gå 18 → 9 i ett steg.

Godkänd på `aea67c6`. I `aef07ff` åtgärdades granskarens låga anmärkningar, och `102344d` lade
till ett test som mutationsprovet saknade.

**Mätningen.** `measure:eta` gav 0 ändrade av 3 102 påståenden. Banken och k1–k3 var bitlika.
I standardjakten försvann kortet F03, och inga nya kort tillkom. Av 9 920 fix efter glapp på
minst 180 s i banken och k1–k3 låg 20 (0,20 %) över kvoten 1,35.

Två godtagna avvägningar står i ARCHITECTURE §8 (e):
- Ett GPS-hopp som godkänns, eftersom den tidigare farten var hög, sänker texten högst ett
  steg.
- Golvet kan bli högre än för en ensam båt om ledaren själv sjunker inom fönstret (15 → 9 ger
  11,25).

#### 11.3.3 F07 R7: samma regel för varje osedd baslinje (`397ade0`, omlåsning `187f31e`)

**Situationen.** I bankens egen fas av 20260708-21h hade AVALON en uppmätt tid på 30,3 min från
sitt första fix. Den visades aldrig, eftersom JAATTEN II ledde. Klampen höll texten på "om 18"
07:11:30 när bron öppnade om 4,5 min, och raden låg i låst facit. F07 rättade bara den
extrapolerade varianten.

**Ändringen.** Regeln gäller varje tid som texten inte visar, extrapolerad eller uppmätt.

**Granskningen.** Domen var "ändringar krävs, svagt". Banken höll U28, men två konstruerade
fixturer (`f07-dubbel`, `f07-trippel`) blev en minut mer optimistiska i 60 s: "om 6" mot F07:s
"om 7", med sanningen 13,0. Efter det kom ett synligt steg 6 → 7. Dirigenten godtog
avvägningen 2026-11-16, och utfallen är låsta i expected-filer.

**Mätningen.** `measure:eta` gav 8 ändrade parade påståenden: 4 bättre, 0 sämre och 4 omätta,
som alla var rättare mot rådatan. Strax-löftet steg från 63,03 till 63,81 %. Granskarens
radvisa dom blev 23 ändrade rader: 20 bättre, 2 lika, 1 bedömd ur rådatan som bättre och 0
sämre. Tider och antal för varningar och notiser ändrades inte, k1–k3 var bitlika och jakten
gav inga nya kort.

**Omlåsningen (U13).** Golden-text i fyra korpusar: 14 rader borta och 17 nya, var och en
dömd mot rådatans korsning i dirigentens egen jämförelse.
- 20260708-21h: "om 18" 07:11:30 blir "om 13" från 07:07:13, sedan "om cirka 8, 7, 4, 3". Ett
  nytt synligt steg 3 → 5 kommer 07:17:26, när JAATTEN II:s egen tid tar över.
- 20260710-13h: "strax" 11:43:09 och 11:44:04 blir "om 4" (sanningen 4,0 och 3,0), och
  "strax" kommer 11:45:24.
- 20260804-17h: en ny rad "om 7" 17:21:33, och "om 6" blir "om 5" 17:23:03.
- 20260804-both-21h: "strax" kommer 08:25:06 i stället för 08:26:46. Förut kom den 16 s efter
  första korsningen (ANYA ELAN 380, 08:26:30), nu 1,4 min före.

Notiser, varningar och händelsefacit är orörda.

#### 11.3.4 Verktygen (`225f826`)

Appens kod är orörd. Grenen täpper till luckor där buggjägaren kunde gömma ett fel bakom en
beslutad post:
- **INV-22** flaggar inte längre en förvarning inför en returkorsning, och i buggjägarens
  sanningsspår krävs att båten redan vänt. Standardjaktens fem INV-22-utslag var alla sådana
  och försvinner. Det var ett av F14:s villkor för (c).
- **U17 (3″)** kräver att täckningsslutet kom i tid. Förut kunde ett släpp två minuter för
  sent gömmas som U17.
- **INV-3** jämför inte två båtars tider vid ett bevisat ledarbyte, men bara om den nya nivån
  håller.
- **U16-posten** täcker B4-varianten av F40-studsen. Korten F04 och F05 (värld 1907) blir
  MÄTGRÄNS U16.
- **U2, J13 och U24** prövar att täckningen hade rätt längd.
- **Registret.** 78 av 99 radhänvisningar rättades eller byttes mot symboler, och testet
  `n-kallrader` prövar alla fält.
- **`run-with-logs.sh`** stänger utan "Killed: 9" och utan kvarlämnade processer.

Första granskningen underkände INV-3-undantaget: det svalde en konstruerad spik på +7 min i
första texten efter ett byte (världarna 246 och 1788: 7 → 21 → 14 och 4 → 17 → 10). Andra
granskningen godkände. I standardjakten gick utslagen från 240 till 238, och rättningarna
efter första granskningen (till `f806e0f`) ändrade inget utslag. Kvarstående gränser i
täckningsproven står i BUGGJAKT §7.

#### 11.3.5 U30: en stilla båt visas som "ETA okänd" (`60242ad`, `57e4789`)

**Situationen.** PRICKBJORN gick söderut 12/11 (k1) och stannade 463 m norr om
Stridsbergsbron. Texten sa "om 4" i 12,7 min från 08:35:34. Sedan steg den 08:48:13–08:53:09
genom 9, 12, 16, 21, 27 och 28, och 08:54:18 kom "Inga båtar" (U27). Hon passerade först 12:35.

**Ändringen.** En båt med status "närmar sig" som legat stilla i minst fem minuter med färsk
position, mer än 350 m från målbron och utan kö vid en tidigare bro, får "ETA okänd". Läget
lämnas när positionerna visar att hon flyttat sig minst 50 m (bara en nyare fix räknas), vid
målbyte, vid statusbyte eller när hon kommer så nära att texten säger "strax". Notisen bygger då
inte heller någon tid ur avstånd och fart.

**Granskningen.** Första versionen underkändes, eftersom läget släpptes av ett enda fartsampel
på minst 1 kn:
- En båt som efter stoppet kröp mot bron i 0,7–0,9 kn visade "ETA okänd" i 7–8,5 min, ända
  tills "strax" tog över. Målbronotisen sa "om 15 minuter" mot basens 10 och sanningen 8,5.
- En båt som legat stilla i 30 min och hade fartbrus på minst 1 kn växlade mellan siffra och
  "ETA okänd" 12 gånger på 12 min.

Revisionen lämnar läget på belagd förflyttning och godkändes. Två småsaker följde: ett test
för kövillkoret, och att en 600 s gammal AISHub-fix inte längre räknas som rörelse.

**Mätningen.** `measure:eta` gav 0 av 3 102 påståenden ändrade, och standardjakten gav samma
fem kort som förut. Banken var bitlik. I k1 ändras bara PRICKBJORNs stopp: "ETA okänd"
08:40:37–08:54:18, och trappan är borta. "Om 4" står kvar 08:35:34–08:40:37, alltså fem
minuter plus ett sampelintervall. Notiser, varningar och passager är oförändrade.

**Fartspikskandidaten (`764d7c6`).** Kalkylatorn loggar `[ETA_SOG_SPIKE_CANDIDATE]` när
fartspiksvaktens villkor håller (11.4), utan att ändra något. I fältet gav k2 exakt en rad och
k1, k3 och banken ingen. Raden räknas efter varje fältkörning (VALIDATION §Fältprov).

### 11.4 Det som inte gick in, och varför

**Fartspiksvakten (F13 punkt 2).** Fältfallet är k2 13/11 13:56. En AISHub-fix rapporterade
22,2 kn när förflyttningen sedan förra fixen gav 9,9 kn. Texten sa "strax" på 940 m i 3,8 min.
Vakten granskades i tre varv:
1. Den behandlade en båt som verkligen ökade farten kraftigt strax före en fix som en spik, och
   då kom öppningsvarningen senare. Värst var ledtiden 183 → 126 s i ett konstruerat fall.
2. Rättaren fann själv i ett eget svep att den ersatta farten låg kvar i samplet efter. I 16 av
   80 världar sa kortet "om 5"–"om 8" där basen sa "om 3" eller "om 4", och i fyra kom varningen
   1–5 s senare.
3. Den tredje versionen ("nästa sampel avgör") kunde granskaren inte fälla på beteende. Banken,
   fältet och jakten var bitlika.

Granskaren avrådde ändå, och dirigenten delade bedömningen 2026-11-16:
- Vakten blev cirka 300 rader i ETA-kedjans kärna, med fyra nya tillstånd.
- Felet har setts en gång på cirka 100 h fält och aldrig i 519 h bank eller 2 000 jaktvärldar.
- Nästa ETA-steg (K6, idle-decayn) rör de antaganden vakten vilar på.

Grenen `omg2/ETA1-S` sparas med villkoren för att ta upp vakten igen. I stället loggas
signaturen (11.3.5).

**Vakten mot tidiga varningar söder om Olidebron.** En norrgående båt som hörs första gången
vid Kanalinfarten varnas för Klaffbron på 10-knopsgränsen redan från första fixet, innan hon
passerat Olidebron. Det gäller 26 varningar i banken, 9–38 min före passagen. Vakten gav
78–567 s senare varningar, i snitt cirka 2,5 min, men fortfarande 6–30 min före. Priset var för
högt: en förstakontakt som tystnar och går 8–10 kn fick varningen 5–125 s före Klaffbron mot
181–276 s i dag. Därmed bryts 10-knopsgarantin. Dessutom tillkom 3 extra kort i banken, och 11
korpusar fick flyttat facit. Vakten införs inte, och beteendet är en känd gräns.

**Nedräkningen när den främsta båten tystnat, och kö-delen i 5-minutersgrenen.**
- *Nedräkningen.* Den tysta båtens senaste tid räknas ned i stället för att nästa båts tid
  visas. I buggjägarens världar blev texten mycket bättre (median +11,6 → +2,7 min vid bytet).
  I banken blev den sämre: mot rådatans korsningar 7 bättre och 21 sämre, i den snävare
  varianten 3 bättre och 6 sämre. `replay:all` gav tio regressioner i låst facit.
- *Kö-delen.* Den ska nolla tiden bara vid bekräftad väntan. Den hjälpte i 3 av 7 syntetiska
  världar och skadade i 2. I banken flyttade den 14 låsta texter. Av 34 nya mätta påståenden
  blev 10 mer än 2 min för tidiga.

Ingen av dem klarar U28. Rättarens första utkast angav "29 för tidiga" för kö-delen. Siffran var
mätt mot härledda korsningar, och 27 av dem föll bort mot rådatans verkliga korsningar.
Slutsatsen vilar därför på `measure:eta`. Frågan om texten är F21.

**K6 och tidsmedveten utjämning.** En beräkning per fix (K6) gav 77 bättre och 70 sämre
påståenden. Den snävaste utjämningen som räknar tiden gav 66 bättre och 57 sämre, och dessutom
ett nytt kort i buggjägaren: en öppningsvarning efter passagen. Ingen snävning fick ner antalet
sämre till noll. Båda vilar tills ägaren vill pröva en sådan bytesaffär.

### 11.5 Nya och uppdaterade beslutsfrågor till ägaren

Frågorna står i prioritetsordning och i samma form som i avsnitt 7. Nästa lediga U-nummer är
U31.

**F7 (uppdaterad). Tunna ledtider vid Stridsbergsbron: fartökningsregeln**
- *Situationen.* Varningen för Stridsbergsbron hålls tills båten närmar sig Järnvägsbron, som
  ligger 257 m före. Appen släpper den efter farten i senaste positionen. Kryper båten fram och
  ökar när Järnvägsbron öppnar, kommer varningen under de utlovade 2,5 min. LIDAN fick den
  15/11 137,8 s före passagen, och kortet sa "om 5" när 2,3 min återstod.
- *Regeln, och hur den föll första gången.* Första versionen släppte också spärren på ett
  enda fix i rörelse efter ett fix under 1 kn. Granskaren visade att den då varnade 10–20 min
  för tidigt när en båt rycker fram i en kö 100–400 m före Järnvägsbron. Fallet fanns i
  bankens rådata: NICOLINE (20260712-25h) gick från 0,9 till 1,9 kn 358 m före bron och köade
  sedan i 10 min. Med en konstruerad anflygning varnades hon 9,9 min tidigare än i dag, och
  kortet sa "eta 3" när det var cirka 15 min kvar. Hon fanns i rättarens egen skanning men
  redovisades inte.
- *Den omgjorda regeln.* Den gäller bara en båt som redan är i gång, med båda föregående fixen
  i minst 1 kn. Båten ska öka farten tydligt två positioner i rad, högst 400 m före
  Järnvägsbron, med kurs mot bron, och den sista positionen ska visa minst 2,8 kn (fartgolvet
  efter omgranskningen; långsammare än 257 m på 3 min hinner varningen ändå gå efter
  Järnvägsbron). Då räknar appen som om hon går minst 5 kn. Kortet visar den lägre av
  ETA-kedjans siffra och regelns restid, avrundad uppåt. Regeln verkar bara när positionerna
  kommer glest (AISHub-takt, en position per minut eller glesare). Med täta positioner syns
  ökningen aldrig över två steg, och då gäller dagens varning.

  | Båt | Varning före passagen i dag | Med regeln |
  |---|---|---|
  | LIDAN (fältet 15/11) | 2 min 18 s | 3 min 26 s |
  | VISTEN (17/9) | 2 min 12 s | 3 min 12 s |
  | BALTIC DREAM (2/6) | 1 min 47 s | 3 min 6 s |
  | LIANNE (fältet 12/11) | 2 min 37 s | 3 min 47 s |
  | NAVEN (fältet 12/11) | 2 min 30 s | 3 min 29 s |
  | MONIKA (6/8) | 3 min 13 s | 4 min 4 s |
  | JAATTEN II (8/7) | 2 min 49 s | 2 min 57 s |

  Kortet sa förut upp till 3,5 min fel för dessa båtar och nu högst 1,1 min. Inget påstående i
  `measure:eta` blir sämre. Fyra låsta varningar kommer tidigare (JAATTEN II, MONIKA, VISTEN och
  LIDAN), med kortet 3 i stället för 5–6. De är inte omlåsta.
- *Kostnaden.* I all inspelad trafik och fältets tre körningar utlöstes regeln 13 gånger hos 8
  båtar, och alla gick igenom utan att stanna eller vända. Det är ett tunt belägg. Konstruerat:
  en båt som ökar till minst 2,8 kn och sedan ändå köar 10 min 150 m före Järnvägsbron får
  varningen 907 s före passagen i stället för 105 s. Kostnaden gäller ända ner till golvet: en
  ökning till exakt 2,8 kn följd av samma kö varnas 833 s före passagen mot 119 s. En långsam
  ökning till 2,9–3,1 kn ger kortet "3" när 5,5–5,75 min återstår. Alla dessa fall är låsta i
  test. Buggjägaren kan inte generera mönstret "ökning följd av kö", så att den är tyst säger
  inget om kostnaden. Utan golvet varnades också
  krypande köer (1,2 kn, ett ryck och sedan kö) 13–15 min för tidigt; golvet tar bort dem utan
  att något i banken eller fältet ändras. Tre båtar som lade ut ur kö 360–440 m från bron
  (NORDIC SOLA, PRIMA LADY och ORANESS) får som i dag.
- *Alternativ.* (A) Ingen regel. (B) Bara ökning i gång, som är införd på grenen. (C) Som B,
  plus avgång ur kö när nästa fix bekräftar den. C ger samma utfall som B i verklig trafik, men
  i en krypkö kom varningen för tidigt: 540 s mot 175 s med fix var 10 s, och 470 s mot 145 s
  med otur i fasen.
- *Rekommendation.* (B) med fartgolvet, enligt rättaren, granskaren och dirigenten.
- *Granskningen.* Tre varv. Första versionen underkändes: avgångsgrenen varnade 10–20 min för
  tidigt i en krypkö. Den omgjorda regeln höll i banken och fältet, men granskaren visade att
  en KRYPANDE kö fortfarande kunde utlösa den (kryp i 1,2 kn, ett ryck till 2,2 kn och sedan
  kö: 808–834 s före passagen mot 157–181 s i dag) och föreslog fartgolvet. Med golvet godkändes
  regeln (`15602c3`): 57 konstruerade fall ger dagens utfall utom LIDAN-formen och de redovisade
  kostnaderna; i banken och k1–k3 flyttas exakt sju varningar, alla tidigare, och inget annat;
  inget påstående i `measure:eta` blir sämre; standardjakten är identisk med slutbatteriets (två
  kandidatkort). Granskarens bedömning: i banken och fältet en ren förbättring, men en avvägning
  som ägaren tar. Grenen är inte sammanslagen. Väljer ägaren (B) låses fyra varningar om (U13).

**F19. Inbromsningsregeln: "strax" för en båt som bromsar in (buggjägarens kort F02)**
- *Situationen.* I en syntetisk värld bromsar XENIA från 4,5 till 1,1 kn cirka 340 m före
  Klaffbron. Medelfarten bär fortfarande anloppsfarten, och texten säger "strax" 9,9 min före
  passagen, sedan "om 4" och sedan "strax" igen.

  Regeln håller tiden på "om 3" när bara medelfarten lovar strax. Villkoren: båten går nyss in
  i strax, fixets egen mätning ger under 3 min, medelfarten är minst 1,2 gånger momentanfarten,
  momentanfarten ger minst 3,5 min, och båten ligger mer än 300 m från bron.

  0 av 3 198 bankpåståenden ändras, och fältet är oförändrat. Två låsta textrader flyttas:
  - 20260712-25h 07:42:16. MALUCA bromsade från 5,5 till 1,3 kn 320 m före Klaffbron. Texten
    "Två båtar … strax" blir "om 3 minuter". Hon ökade igen och korsade 07:45:06, 2,8 min
    senare. "Om 3" missar alltså med 10 s och är strikt taget sämre. Därför går raden till
    ägaren (U28).
  - 20260806-42h. En för tidig "strax" för fem båtar i kö kommer 67 s senare.
- *Klassens pris* (granskarens syntetiska båtar). En båt som bromsar kort utanför 300 m och
  sedan går igenom får "strax" ett fix senare:
  - 33 av 120 båtar med fix var 30–90 s, i snitt 1,3 min senare och som mest 1,5 min;
  - 23 av 48 båtar med fix var 120–180 s, i snitt 2,1 min och som mest 2,5 min;
  - i tre fall med fix var 180 s kom "strax" aldrig: "om 3" stod i 3 min till passagen, mot
    sanningen 2,8–3,0.

  Varning och notis påverkas inte. Vinsten: 74 kö- och krypbåtar får sin för tidiga "strax"
  senare, och växlingen strax → om N → strax går från 34 till 2.
- *Granskningen.* Första versionen underkändes, eftersom regeln också höll innanför 300 m och
  kunde ge notisen "om 3" mot textens strax. Andra versionen godkändes. Buggjägaren gav inga nya
  kort. En tredje kontroll gällde rättarens egen rättning efter flytten till den
  sammanslagna koden: regeln jämför nu med det som visades vid föregående fix. I granskarens sök
  (900 båtar som stannar eller kryper 302–600 m före bron) gav den förra versionen tre nya
  växlingar strax → om 3 → strax, den rättade inga, och 48 av dagens växlingar försvann.
- *Alternativ.* (a) Godta regeln och MALUCA-raden, och lås om de två textraderna (U13).
  (b) Avstå, så står XENIA-felet kvar. Ett tredje alternativ, att låta texten lämna strax
  först vid 4 min, är förkastat: det behåller "strax" 9,9 min före passagen.
- *Rekommendation.* (a), enligt dirigenten och granskaren. Grenen `omg2/ETA2-C` granskades i
  två versioner på `187f31e` och i en tredje på `57e4789`, och ligger nu på
  `2d1aa75` med spetsen `1237091`.

**F20. Notisen säger "om 3–4 minuter" när texten säger "strax"**
- *Situationen.* Notisen för målbron byggs på första beräkningen av ett fix, och texten på den
  andra 25 ms senare (K6). Texten säger dessutom "strax" inom 300 m, samma radie som notisen. I
  k3 sa tre Klaffbronotiser "om 3–4 minuter" i samma ögonblick som texten bytte till "strax":
  NINA BRES 01:33:27, LIDAN 06:15:58 och SYLVIA 15:48:23. Båtarna korsade 1,6–2,9 min senare.
  Banken har 90 sådana motsägelser och fältets tre körningar 12 (k1 5, k2 4, k3 3).
- *Alternativ.*
  - (a) Som i dag.
  - (b) Tak: notisen säger högst "om 2 minuter" när texten säger "strax". 39 påståenden blir
    bättre och 32 sämre. Motsägelserna går 90 → 1 i banken och 12 → 0 i fältet, och notiserna
    i 9 låsta korpusar ändrar siffra.
  - (c) Tak med fart: som (b), men bara när båten i sin fart når bron inom 3 min. 33 blir
    bättre och 5 sämre. Motsägelserna går 90 → 48 och 12 → 3, och 7 låsta korpusar berörs. De
    fem sämre gäller båtar där texten själv sa "strax" för tidigt, till exempel HELGE, vars
    notis går från 4 till 2 mot sanningen 3,8.

  Varken texten, varningen eller notisens tidpunkt ändras, och buggjägaren ger inga nya kort.
  Noll sämre går inte: där texten säger "strax" fel blir en notis som följer texten också fel.
- *Rekommendation.* (c), enligt dirigenten. Prototypen ligger på `omg2/ETA2-BC` (`6ee78f8`)
  och är mätt om på F07-koden (`102344d`) med samma utfall.

**F21. Texten när den främsta båten tystnat**
- *Situationen.* Den båt vars tid texten visar tystnar, och appen nollar hennes tid. Det sker
  när positionen är 10 min gammal, efter 5 min om hon gick under 1 kn eller kan ligga i kö vid
  en tidigare bro, eller när nedräkningen tagit slut utanför 300 m. Hon räknas ändå kvar i
  gruppen, och texten visar nästa båts tid.

  Exempel ur banken, 20260713-41h den 15 juli: 08:40:18 stod det "Två båtar på väg mot
  Klaffbron, beräknad broöppning om 3 minuter", och 08:41:30 "… om 11 minuter". Det var 42 s
  innan den främsta båten passerade. Hennes position var då 308 s gammal, i 7,5 kn.

  Textformatet säger att gruppen visar den lägsta giltiga tiden, och inget beslut reglerar
  fallet. I buggjägarens 28 kvarvarande sågtandsvärldar är 23 ett sådant byte. I 15 av dem var
  den tysta båten kvar och först, och texten var i median 11,6 min för sen.
- *Varningen.* I alla 15 världarna kom öppningsvarningen i tid, med den tysta båten som
  ledare, 2,9–18,3 min före passagen. Fel text utan någon varning yngre än 10 min förekom i 6
  världar, under 0,7–2,2 min utom i värld 1453, där det var 5,7 min. I banken finns en sådan
  lucka på cirka 7 min (20260804-both-21h 08:17).
- *Alternativ.*
  - (i) Som i dag.
  - (ii) "ETA okänd". Den är inte mätt i banken, och vilken båt som är främst går inte att
    avgöra på en gammal position.
  - (iii) Den tysta båtens senaste tid räknas ned som "om cirka N" i högst 5 min, eller (iii2)
    tills hon enligt sin fart borde ha nått bron. Varianterna gav 7 bättre och 21 sämre
    respektive 3 bättre och 6 sämre i banken. Skadan gäller båtar som tystnar och sedan inte
    kommer: ADA vände och ANTJE stod still, men räknades ned till "cirka 2" medan nästa båt var
    7–9 min bort.
  - (iv) Den tysta båten räknas inte med. Det ändrar bara antalet, och tiden blir lika fel.

  Inget alternativ klarar U28.
- *Frågan.* Ska dagens beteende registreras som en känd gräns i buggjägarens register (ett
  förslag till post, LEDARBYTE-TYST-FRÄMSTA, finns)? Det kräver ett U-nummer, och harnessen
  måste då bokföra varje båts tid, positionsålder, fart och kurs vid varje text. Annars står
  korten kvar som kandidater.
- *Rekommendation.* (i), registrerad som känd gräns: varningen kommer i tid, och inget
  alternativ gör banken rättare.

**F22. Långsam drift under U30**
- *Situationen.* En båt som driver mot bron i 0,1–0,3 kn lämnar "ETA okänd" var 50:e meter
  och går in igen efter fem minuter. Däremellan visas appens vanliga siffra, som kan vara fel.
  Granskaren såg "om 24" mot sanningen 5, och rättaren "om 3" eller "strax" mot 13–23 min.
  Rättaren fick upp till 4 formbyten på 30 min och granskaren 2.
- *Alternativ.* (a) Som nu, en blandning med minst fem minuter mellan bytena. (b) Behandla
  långsam drift som stilla, alltså "ETA okänd" hela tiden. (c) Behandla den som gång, alltså
  siffran hela tiden. (b) och (c) är inte mätta.
- *Rekommendation.* (a) tills ett fältfall finns. Granskaren bedömer blandningen som inte
  orimlig.

**F23. Marginalen i U29**
- *Situationen.* Gränsen är 25 min. Fältets längsta friska tystnad var 23,33 min, alltså en
  marginal på 1,7 min, och den slutade först efter vaktens återanslutning (11.3.1). Granskaren
  skattar en tystnad på minst 25 min till ungefär var 16:e–36:e dygn i vintertrafik.
- *Alternativ.* (a) Behåll 25 min. (b) Höj gränsen, till exempel till 30 min. Då blir det färre
  falsklarm, men en död AISstream syns ännu senare. (b) är inte mätt.
- *Rekommendation.* (a). Pröva igen när det finns fler fälttimmar.

### 11.6 Kända gränser och uppföljning

Inget av detta är rättat.
- **Siffran efter ett långt stopp.** En båt som legat stilla i 45 min och sedan går 8 kn får
  "om 18" eller "om 20" mot sanningen 1,4. Efter 90 min och 4 kn blir det "om 20, 16" mot 3,2
  och 2,7. Felet är detsamma före och efter U30 och hör till ETA-etappen.
- **Dubbel "närmar sig"-notis.** En stilla båt 365–400 m från bron vars nästa position hoppar
  till 280–295 m fick två notiser för Stridsbergsbron i ett syntetiskt prov. Det gäller både
  före och efter U30.
- **Glesa sändare under U30.** Lägger båten ut med fix var 180 s i 5 eller 9 kn står "ETA
  okänd" ända till passagen. Där visade basen ett fruset "om 4". Varningar och notiser är
  oförändrade.
- **Släppklockan (U27, hör till F4).** Mätt av rättaren under U30-revisionen, inte ändrat:
  klockan som släpper en stilla båt ur texten nollställs av ett enda fartsampel över 2,0 kn
  eller av en belagd förflyttning på minst 50 m. Med fast kurs släpps båten efter cirka 20 min,
  också med fartbrus upp till 2 kn. Med konstruerade spikar på 2,5 kn var tionde minut står hon
  kvar i minst 2 h. Av 56 stilla vistelser på minst 20 min 300–600 m från broarna i banken och
  k1–k3 har två spikar över 2 kn (CARAT och PRICKBJORN i k1).
- **Värld 1183.** MASEN vid Stridsbergsbron tar över klausulen efter en U-sväng. Världen står
  kvar som representant för kortet F02, men mekanismen är ett ledarbyte, inte en inbromsning.
- **Heapen i k3.** Golvet steg från 15,4 till 17,5–17,9 MB, 2,1 MB per dygn mot k1:s 1,9 och
  k2:s 1,1. Ökningen kom i trappsteg vid passagerna, med +0,4 MB de sista tio timmarna.
  Läckkontrollen gav "No memory leaks" i 204 av 204 kontroller. Körningen är för kort för att
  visa platån som soaken på 14 dygn visade (5.7).
- **Kortet mot texten efter spärrändringen.** Med fartökningsregeln säger kortet 3, men texten
  säger 2–5 min mer i alla sju fallen. Kortet ligger närmast sanningen. Rättningen hör till
  ETA-kedjans avgångs-ETA, inte till F20.
- **Ett andra kort efter passagen vid blandad källa.** I ett konstruerat fall med aisstream var
  30:e sekund och AISHub i samma anflygning (LIDAN-formen) kom ett andra öppningskort för
  Stridsbergsbron 29 s efter passagen, med eta 0. Det är lika före och efter fartökningsregeln
  och hör inte till den (granskningen av spärren).
- **Avgångar ur kö 360–440 m från Järnvägsbron.** Båtarna får fortfarande tunn ledtid
  vid Stridsbergsbron, eftersom första rörelsefixet redan ligger inom 350 m.
- **Andra fixet vid Kanalinfarten.** Kommer en norrgående båts andra fix mer än cirka 195 s
  efter det första kan varningen gå 17–20 min före Klaffbron. Det är en hypotes ur k3, inte
  sedd i drift. När LIDANs fix 05:58:24–06:02:30 stryks varnas hon 17,5 min före i stället för
  11,2.

### 11.7 Lärdomar

Tillägg till avsnitt 8.
- **Granskningen fällde nästan allt i första varvet.** Av åtta granskade ändringar godkändes
  bara U29 direkt. Sex fick krav på ändring i kod eller test: F07, verktygen, U30,
  fartspiksvakten, inbromsningsregeln och spärren. R7 fick "ändringar krävs, svagt" för en
  avvägning som dirigenten avgjorde. Felen låg nästan alltid där banken inte når, och de syntes
  först i fall som granskaren byggde med egna positioner.
- **Pröva rättarens "0 undantag" mot rättarens egna rådata.** Spärrens första version vilade på
  att "av 32–41 fartökningsfix följdes 0 av kö". Den skanningen hade andra villkor än regeln.
  Med regelns villkor, i rättarens egen fil, följdes 1 av 45 av kö: NICOLINE. Buggjägaren kunde
  inte heller se det, eftersom dess köfamiljer saknar en kö efter ett ryck. "0 nya i 2 000
  världar" bevisade därför ingenting.
- **Världarna och banken kan peka åt olika håll.** Nedräkningen vid en tyst främsta båt gjorde
  världarnas text mycket bättre men banken sämre. Båda måste mätas, och U28 gäller banken. Mät
  mot verkliga korsningar, inte härledda: "29 för tidiga" blev 2.
- **En gräns som sammanfaller med appens egen takt håller i test men inte i drift.** F07:s
  renderade värde gällde i exakt 30 s, samma period som halvminutsklockan. Vid tickgränsen var
  det 30,0x s gammalt, och skyddet föll ibland bort. Nu gäller det till nästa rendering, högst
  60 s. Det hör till samma familj som fejkad klocka i avsnitt 8.
- **En rättning som är svårare att lita på än felet ska inte in.** Fartspiksvakten blev cirka
  300 rader för ett fel som setts en gång på 100 h, och varje version påstod något som inte
  höll. Nu loggas signaturen i stället, och hur ofta felet syns i fält avgör om vakten tas upp
  igen.

### 11.8 Slutbatteriet

Kört 2026-11-16 på `2d1aa75`, sammanslagningsgrenens sista commit med kod.

| Steg | Utfall |
|---|---|
| Lint | rent |
| Hela jest | 395 sviter gröna: 5 919 test, 2 överhoppade |
| `replay:all`, utan och med monitoring | grönt på 25 korpusar; 17 WARN-rader, som baslinjen |
| `replay:synthetic` | 112 scenarier rena; 16 WARN-rader (baslinjen i VALIDATION) |
| `replay:openings` | grönt; 0 oklassade missar, 37 varningar med okänd ordning mot passagen, som förut |
| Soak och `replay:monitoring` (72 h) | stabila, 0 processfel |
| `measure:eta` | 3 198 mätta påståenden, bitlikt med mätningen efter den sista kodsammanslagningen; median 1,37 min, p90 20,28 min |
| Fassvepet, utan och med monitoring | OK på 25 korpusar, inget odokumenterat fasberoende |
| `hunt:selftest` | grönt |
| `hunt:quick` (300 världar) | 2 kandidatkort |
| `npm run hunt` (2 000 världar) | 220 utslag i sanningsspåret, 2 kandidatkort; bankspåret 170 av 175 fasvarianter rena, 0 kandidatkluster |
| `hunt:night` (20 000 världar) | 2 571 utslag i sanningsspåret, 28 kandidatkluster och 25 kort; bankspåret 636 av 650 fasvarianter rena, 0 kandidatkluster |

Fasvarianterna som inte är rena hör till ett kluster som redan har en registerpost.
Standardjaktens två kort är INV-3 ETA-OSCILLATION (inbromsningen, F19) och INV-3 ETA-SÅGTAND UPP
(en tyst främsta båt, F21).

**Nattjaktens kort.** Nattjakten prövar tio gånger så många världar som standardjakten och gav
25 kort: 6 med felfri radio, 13 med fältlik radio och 6 under stress. Inget av dem är nytt för
omgången. Alla 65 representanter kördes om med samma verktyg mot appkoden före omgången
(`1f6dd46`) och gav ordagrant samma utslag. Korten visar alltså äldre egenskaper som den större
körningen når. De är inte triagerade här.

**Avsändaren.** Efter slutbatteriet byttes avsändaren på arbetsgrenens commits till samma
anonyma identitet som `main` använder (ägarens besked 2026-11-16). Innehållet i varje commit är
bitlikt, men alla commits efter `e51c7b6` fick nya beteckningar. Hänvisningarna i dokument,
testkommentarer och commit-meddelanden är omräknade (123 ställen i 19 filer). Därefter kördes
lint, kontrollen av registrets radhänvisningar, de åtta berörda sviterna (172 test),
`replay:all` och `replay:synthetic` om, alla gröna. Tre hänvisningar i VALIDATION (`34c2b57`,
`9c802ed` och `c6a765d`) pekar på prototyper som aldrig låg på någon gren. De stod så redan
före omgången.
