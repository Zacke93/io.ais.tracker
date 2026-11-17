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
**Omgång 3** (16–17 november, U31–U44, avsnitt 12) rättade de äkta felen ur nattjaktens triage och tog in inbromsnings- och fartökningsregeln; avsnitt 12 stämmer med `d6e4d94`.

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
- *Dirigentens åtgärd 2026-11-15/16:* (c) mättes och förkastades i sin breda form, eftersom den
  släppte spärren även före Klaffbron söderut och gav PILOT 761 en varning 38,6 min för
  tidigt. En smal regel (d2) prövades, men granskningen SPARR-d2 visade att dess avgångsgren
  (ett enda fix ur stillhet) varnade 10–20 min för tidigt när en båt ryckte fram i en kö före
  Järnvägsbron (NICOLINE i 20260712-25h och syntetiska krypköer). Den tidigare raden här
  ("ingen varning före en kö") var fel. Regeln är omgjord till bara ökning i gång: ett fix
  högst 400 m före Järnvägsbron efter två fix i minst 1 kn, med minst 0,8 kn ökning över två
  fix och minst 2,8 kn (fartgolvet efter omgranskningen: under 257 m / 180 s hinner varningen
  ändå gå efter bron), räknar restiden till Stridsbergsbron i minst 5 kn. Den vinner BALTIC DREAM 107 → 186 s,
  VISTEN 132 → 192 s och LIDAN 138 → 206 s, och 51–70 s mer åt MONIKA, LIANNE, NAVEN och
  JAATTEN II. NORDIC SOLA (107 s), PRIMA LADY (117 s) och ORANESS (93 s) var avgångar och får
  som förut. Känd kostnad efter golvet: en båt som ökar i gång till minst 2,8 kn och sedan köar
  varnas cirka 15 min för tidigt, och en långsam ökning till 2,9–3,1 kn ger kortet 3 min när
  5,5–5,75 återstår (syntetiskt; i rådatan gick alla 13 utlösningar hos 8 båtar igenom, ett
  tunt belägg, och buggjägaren genererar inte mönstret). Krypande köer under 2,8 kn omfattas
  inte. I
  buggjägaren är utfallet som basen; den första versionens konvojkostnad (följare med eget
  kort och mötande södergående båtar med kortare ledtid, alla minst 150 s) försvann med
  avgångsgrenen. Kortets siffra (alternativ (b), U28) är regelns restid i max(fart, 5 kn),
  uppåt till hel minut och aldrig mer än ETA-kedjans värde. Avvägningen går till ägaren
  (avsnitt 11.5 (F7)). Avgång ur kö 360–440 m från bron är känd gräns.
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
körningen når. Triagen står i 11.9.

**Avsändaren.** Efter slutbatteriet byttes avsändaren på arbetsgrenens commits till samma
anonyma identitet som `main` använder (ägarens besked 2026-11-16). Innehållet i varje commit är
bitlikt, men alla commits efter `e51c7b6` fick nya beteckningar. Hänvisningarna i dokument,
testkommentarer och commit-meddelanden är omräknade (123 ställen i 19 filer). Därefter kördes
lint, kontrollen av registrets radhänvisningar, de åtta berörda sviterna (172 test),
`replay:all` och `replay:synthetic` om, alla gröna. Tre hänvisningar i VALIDATION (`34c2b57`,
`9c802ed` och `c6a765d`) pekar på prototyper som aldrig låg på någon gren. De stod så redan
före omgången.

### 11.9 Nattjaktens kort: jämförelsen och triagen

**Jämförelsen.** Nattjakten kördes också på en jämförelsebas: samma verktyg och samma bank, men
appkoden från före omgången (`1f6dd46`). Utfallen jämfördes kluster för kluster och värld för
värld. Det som skiljer:
- Åtta ETA-hopp (INV-3) finns bara på den gamla koden: fem syntetiska världar och bankens
  fasvariant 2026-07-08 07:11:30 (Klaffbron 13 → 19 min), med och utan monitoring. Bankspårets
  enda kandidatkort på basen försvann därmed.
- Ett utslag finns bara på den nya koden, värld 11148, i den redan beslutade klassen U17. Det
  är en flyttad varning, ingen ny. På den gamla koden fick en båt en extra varning för att
  hennes ETA var 3 min för sen (8,1 mot verkliga 4,1). Den varningen råkade också täcka en tyst
  båt bakom henne. Med R7 är ETA:n rätt (5,0), den extra varningen uteblir, och den tysta båten
  får i stället säkerhetsvarningen enligt U17, 5 min efter sin passage. Båda versionerna ger
  11 varningar och 37 notiser i världen. Utan den första båten ger båda samma U17-varning.
- Inget annat skiljer. De 28 kandidatklustren är desamma.

**Triagen.** Två utredare gick igenom de 25 korten mot reprona och koden. Korten heter F01–F25 i
nattrapporten. Här skrivs de N01–N25, så att de inte blandas ihop med ägarfrågorna. Sju är äkta fel i
appen, alla äldre än omgången. Ungefär arton kort eller delar av kort är beslutat beteende som
verktyget inte kände igen, eller mätfel i verktyget.

| Fel | Situationen | Kort | Hur vanligt |
|---|---|---|---|
| Kö strax bortom Stridsbergsbron | En båt går söderut genom bron och stannar 90–165 m bortom den. Första positionen efter bron har fart 0, och passagen bokförs först vid nästa position, i världen 16 min senare. Användaren får "närmar sig Stridsbergsbron" 2 min efter passagen, "ETA okänd" i 17 min och ingen passagenotis. Varningen var rätt. | N16, N17 | 1 värld; kräver ingen ovanlig manöver |
| Konvojfönstrets ankare | Två båtar korsar under ett avbrott och bokförs i omvänd ordning. Fönstret räknas då från den senare korsningen, och en båt 14 min efter den första får ingen egen varning. | N02 r3, N23 r2 | Syns i 1 hel värld; felordningen finns 9 gånger i banken utan synlig följd |
| Utebliven notis efter vändning | En båt passerar Stridsbergsbron norrut, raderas i ett glapp och kommer tillbaka söderut 28 min senare. Notisen stoppas av 60-minutersregeln för riktningsbyte. | N14 r1 | 1 värld |
| Dubbelnotis vid Stallbackabron | En position 13 m före den sneda brolinjen räknas som "passerade under AIS-tystnad", och den riktiga passagen 104 s senare ger en andra notis. | N08 r3 | 1 värld |
| Återvändare utanför sista bron | En båt lämnar kanalen norr om Stallbackabron, vänder cirka 400 m bort och kommer tillbaka i 9 kn. Appen ignorerar henne i 10 min, och varningen för Stridsbergsbron kommer 51 s före passagen. | N04 | 1 värld med felfri radio |
| Riktningsfältet efter U-sväng | Notisens riktning står kvar på den gamla tills nästa bro. Texten stämmer. | N12 | 9 världar |
| Parbron inom 70 m | En observerad passage av Järnvägsbron får ingen notis när nästa position kommer efter en U-sväng. | N10 r3 | 1 värld |

De tre första raderna och dubbelnotisen rättas i omgång 3 (grenarna `omg3/K1`–`omg3/K3`).
Återvändaren kräver en mätning först: rättningen kan ge fler "Inga båtar"-blink och extra
notiser vid Stallbackabron för båtar som ligger och vänder vid utfarten. De två sista är små
och väntar.

Beslutat beteende eller mätfel, kort för kort:
- **Redan hos ägaren:** inbromsningen (N03, fråga F19) och en tyst främsta båt (N20, N21,
  fråga F21).
- **Fattade beslut som verktyget inte kände igen:** U6 (N18), U14 och U21 (N08 r1/r2, N15,
  N14 r2/r3), U15 (N02 r2, N23 r3), U17 (N07 r2/r3, N11 r2/r3, N24), U18 (N06 r2, N12 r3),
  U19 (N07 r1), U25 (N06 r3, N25), R2 (N09), S10 (N10 r1/r2) och U1-C11 (N05 r3).
- **Mätfel i verktyget:** N01 (texten byter båt efter en bekräftad vändning, och INV-3 jämför
  två båtars tider), N05 r1/r2 ("Inga båtar" mellan texter om två olika båtar), N11 r1 (en
  riktig varning på en gammal position), N19 (en köande båt som sedan vände), N22 (en båt i en
  redan varnad öppning) och N23 r1 (verktyget minns en gammal bindning).

Verktygets orakel och register behöver ungefär femton justeringar för att nästa nattjakt bara
ska visa det som är fel. Ingen av dem ändrar något för användaren. R1:s radio är dessutom
okalibrerad: AISHub-glapp över 25 min är fem till tio gånger vanligare i världarna än i banken.

**Nya frågor till ägaren**

**F24. En gammal passagenotis efter en vändning i ett långt glapp** (N13)
- *Situationen.* En båt hörs söderut norr om Stallbackabron 09:15, tystnar i 58 min och hörs
  igen 10:14 på väg norrut, 750 m söder om bron. Appen skickar då "passerade Stallbackabron
  under AIS-tystnad" för sydpassagen, och 10:17 "närmar sig Stallbackabron" norrut. Den första
  notisen är sann men 55 min gammal och pekar åt fel håll.
- *Alternativ.* (a) Som i dag. (b) Hoppa över notisen när appen själv har sett att båten vände
  under glappet och den senast kända positionen är äldre än cirka 17 min. (c) Hoppa över varje
  sådan notis efter 17 min; då stryks också färska och riktiga notiser vid utfarterna.
- *Rekommendation.* (b). Tre världar av 20 000, alla med AISHub-glapp nära fältets maximum.

**F25. En returnotis som kommer minuter sent** (N08 r1/r2, N15)
- *Situationen.* En båt vänder 176 m norr om Klaffbron och passerar den söderut 01:13. Nästa
  position kommer 01:20, 1,2 km bort. Då kommer "har precis passerat Klaffbron" samtidigt med
  "närmar sig Olidebron". Beteendet följer U14 och U21: returen släpps först när en senare
  position bevisar den, högst 10 min efter korsningen.
- *Alternativ.* (a) Som i dag. (b) Formen "passerade … under AIS-tystnad" när det var tyst i mer
  än 130 s efter korsningen. (c) Släpp returen direkt vid positionen på brolinjen när båten går
  i marschfart (över 3,13 kn), också vid täta positioner. Det släppet finns redan för glesa
  positioner.
- *Rekommendation.* (c). Notisen hade då kommit 10 s efter passagen.

**F26. Reservvarningen för en tyst båt i kö** (N02 r1, N06 r1; sidofynd i N11, N16 och N18)
- *Situationen.* En båt ligger i kö vid Järnvägsbron. Där varnar appen med avsikt inte för
  nästa bro. Hörs hon inte på 5 min släpps spärren, och reservvarningen går. Det ger två sorters
  fel. Låg hon kvar kommer varningen 24–39 min före passagen (tre världar). Avgick hon just när
  strömmen bröts kom varningen 12 s efter passagen (en värld).
- *Alternativ.* (a) Behåll 5 min. (b) Kortare, cirka 3,5 min: i avbrottsfallet hade varningen
  kommit 78 s före, men fler köande båtar får en tidig varning. (c) Längre: färre tidiga
  varningar, men en båt som avgår osedd varnas ännu senare.
- *Rekommendation.* (a) tills fältet visar något av felen. Inget av dem är sett i drift, och
  (b) och (c) är inte mätta.

## 12. Omgång 3: 16–17 november 2026

Tillagt 2026-11-17. Omgången rättade de äkta felen ur nattjaktens triage (11.9) och tog in de två
regler från omgång 2 som väntade på beslut (F7 och F19). Den utgick från `27182c8` och slogs ihop
på grenen `omg3/integration`. Spåren K1–K3 utgick från `03ec89b`, som har samma kod som `27182c8`.
Spåren som startade senare (N och V) utgick från sammanslagningsgrenen vid `f543190`, där K1 och
K3:s brolinjeprov redan låg inne (N1 från `9e4daf4` och N6 från `56762d0`). Arbetsformen var densamma som i omgång 2: en rättare per spår i
en egen arbetskopia, en oberoende granskare som mätte själv, och en dirigent som slog samman och
låste om facit enligt U13 efter en egen radvis jämförelse mot rådatan. De tunga körningarna gick
genom en gemensam kö. Ägaren delegerade beteendebesluten till dirigenten 2026-11-16 (12.2).
Korten från nattjakten skrivs N01–N25 som i 11.9. Alla tider är UTC; tiderna i nattjaktens
världar är syntetiska.

### 12.1 Översikt

| Spår | Vad | Utfall | Commits / gren |
|---|---|---|---|
| K1 | Kön strax bortom Stridsbergsbron (N16, N17) | inne, godkänd i första granskningen | `700af7a`, `0c09598`; `44fd1e1` |
| K3, fel 2 | Brolinjen i notisvägen och de skippade broarna (N08 r3) | inne, godkänd i första granskningen; 20260713-41h omlåst | `45c69cd`, `41ed615`; `02ea516`; `f543190` |
| K3, fel 1 | Notis för en retur efter radering (N14 r1) | inte införd, underkänd två gånger; känd gräns (U39) | `omg3/K3` (`6cf0063`, `1faceda`) |
| U31 (F19) | Inbromsningsregeln (gren `omg2/ETA2-C`) | inne; två golden-text-rader omlåsta | `dc5e101` … `1237091`; `87d265a`; `9e4daf4` |
| U32 (F7) | Fartökningsregeln med fartgolvet 2,8 kn (gren `omg2/SPARR-d2`) | inne; fyra öppningsvarningar omlåsta | `6497c4c` … `22a4e37`; `b9376d4`; `ade8734` |
| K2 | Konvojfönstrets ankare, första versionen (flyttad referens) | inte införd, underkänd två gånger | `omg3/K2` (`662c13e`, `7c92806`) |
| K2b (U42) | Konvojfönstrets ankare, den enkla varianten (N02 r3, N23 r2) | inne, godkänd i tredje granskningen | `597e01e`; `db9db01` |
| N3 | Riktningsfältet efter U-sväng (N12); parbron inom 70 m (N10 r3) | inne, godkänd i första granskningen; parbron känd gräns (U43) | `63e9d0c`, `3a28538`; `b19f444` |
| N1 (U33, F20) | Notisen säger restiden när brotexten säger "strax" | inne, godkänd i andra granskningen; 20 notiser omlåsta | `24ee319`, `7116d96`, `23e6d4e`; `75e48991`; `2474d18` |
| N2 (U36, U37; F24, F25) | Returnotisen direkt, formregeln för passagenotiser, den gamla svepnotisen | inne, godkänd i tredje granskningen; 17 notistexter omlåsta | `4a3cd96`, `a214595`, `49fb9b7`, `31e6b0d`, `af54833`; `5d48c83`; `56762d0` |
| N4 (U40, F28) | Ett stopp som färden före glappet förklarar är inget GPS-hopp | inne, godkänd i första granskningen; skärpningen godkänd i en kontroll | `aed7368`, `ce29f72`, `71ae772`; `b8e2e4c` |
| N5 (U41, F29) | Fartgränsen för sändare som inte är båtar; återvändaren utanför sista bron (N04) | inne, godkänd i tredje granskningen; 20260713-41h omlåst | `f919bd4`, `438e6cf`, `f62e492`, `af22888`, `4383fc6`; `71da90f`; `ee4b804`, `328ddfe` |
| V1 | Verktygens orakel och register lär sig de fattade besluten; appen orörd | inne, godkänd i andra granskningen | `39a00b0` … `cae4e88`; `ea581ff` |
| N6 (U44) | Förvarning för en bro som båten redan passerat; brobesökets bortre sida | inne, godkänd i andra granskningen; fyra notiser omlåsta | `98df942`, `74f1f51`, `d35a8c8`, `8ee92e6`; `5f1eea9`; `1e568f9` |

Grenarna `omg3/K2` och `omg3/K3` (fel 1) fördes inte in. De finns bara i dirigentens arbetskopior,
så hänvisningarna till deras commits går inte att följa i repot.

### 12.2 Besluten U31–U44

Ägaren delegerade besluten till dirigenten 2026-11-16 med riktlinjen att appen ska bli så bra som
möjligt för användaren och visa så rätt information som möjligt. **Besluten nedan är fattade av
dirigenten på ägarens uppdrag. Ägaren kan ändra vart och ett.** Frågorna F7 och F19–F23 står i
11.5 och F24–F26 i 11.9. F27–F29 kom ur omgång 3: F27 är K3:s returspärr (12.4), F28 är K1:s
kvarvarande band (12.3.9), F29 är sändaren i 20260713-41h (12.3.2) och F30 är förvarningen för
en bro bakom båten (12.3.12). Nästa lediga U-nummer är U45.

- **U31 (F19).** Inbromsningsregeln tas in: texten håller "om 3 minuter" för en båt som bromsar
  in 300–600 m före bron, tills hon är nära. Raden MALUCA 20260712-25h ("om 3 minuter" där bron
  öppnade efter 2,8 min) godtas. Skäl: inget av 3 198 mätta ETA-påståenden blir sämre, och
  växlingen strax → om N → strax går från 34 till 2 i granskarens rutnät (11.5).
- **U32 (F7).** Fartökningsregeln vid Järnvägsbron tas in med fartgolvet 2,8 kn (alternativ B).
  Skäl: i banken och fältkörningarna flyttas sju varningar, alla tidigare, och inget påstående i
  `measure:eta` blir sämre. Kostnaden (en ökning följd av kö ger en varning cirka 14 min för
  tidigt) godtas tills fältet visar den.
- **U33 (F20).** När texten säger "strax" för samma båt och bro, båten når bron inom 3 min i sin
  fart och inte bromsar in, säger målbronotisen båtens restid i sin egen fart (avrundad, minst 1
  och aldrig mer än notisens värde förut). Preciserat efter mätning: restiden ersätter taket
  "högst om 2 minuter", eftersom den ger lägre medelfel (banken 0,42 mot 0,46 min; 225 slumpade
  världar 0,91 mot 1,04) och färre sämre notiser i världarna (31 mot 51). Undantag från U28: tre
  påståenden blir sämre och godtas (HELGE, CAVA och WILSON ALSTER, 12.3.7).
- **U34 (F21).** Texten när den främsta båten tystnat behålls. Hoppet (till exempel "om 3" till
  "om 11" strax före passagen) är en känd gräns och får en registerpost. Skäl: varningen kom i tid
  i alla 15 världarna, och inget alternativ gjorde banken rättare (11.5).
- **U35 (F22, F23).** Långsam drift under U30 behålls, och gränsen 25 min i U29 behålls. Skäl:
  inget fältfall av driften, och de andra alternativen är inte mätta; marginalen i U29 prövas igen
  när det finns fler fälttimmar (11.5).
- **U36 (F24).** En passagenotis ur svepet efter ett långt glapp hoppas över när appen själv har
  sett att båten vände under glappet och den senast kända positionen är äldre än cirka 17 min
  (alternativ b). Skäl: notisen är sann men gammal och pekar åt fel håll, och alternativ c hade
  också strukit färska notiser vid utfarterna (11.9).
- **U37 (F25).** (1) En returpassage släpps direkt vid positionen på brolinjen när båten går i
  marschfart, också vid täta positioner (alternativ c). (2) En passagenotis som kommer sent efter
  en osedd korsning följer samma formregel som U14 rev. 3: var det tyst i mer än 130 s kring
  korsningen och kommer notisen mer än 60 s efter den, lyder den "passerade … under AIS-tystnad",
  annars "har precis passerat". Skäl: returnotisen kom upp till 10 min sent, och meningen följde
  notisens källa i stället för det som hänt.
- **U38 (F26).** Reservvarningen för en tyst båt i kö behåller 5 min. Skäl: inget av de två felen
  är sett i drift, och de andra längderna är inte mätta (11.9).
- **U39 (F27).** En returpassage inom 60 min efter att båten raderats eller appen startats om ger
  ingen notis. Känd gräns: en verklig retur och en felaktig position ser likadana ut i det
  ögonblick notisen ska skickas, så en säker rättning finns inte (12.4).
- **U40 (F28).** En båt som stannar tvärt strax bortom en bro ska få passagen bokförd direkt, också
  när analysen dömer förflyttningen som ett GPS-hopp. Rättas som egen granskad ändring (12.3.9).
  Skäl: K1 lämnade 28 sådana lägen sena i sitt band, med passagen 16 min sent.
- **U41 (F29).** En sändare som rapporterar en fart som ingen båt i kanalen håller ska inte visas
  som båt. Gränsen sätts efter mätning i banken och fältkörningarna (12.3.10). Skäl: sändaren
  218023240 i 20260713-41h (21–33 kn, troligen ett landfordon på Stallbackabron) står kvar som båt
  i brotexten efter K3 (12.3.2).
- **U42.** Den enkla konvojrättningen (`omg3/K2b`) tas in: en ny båt prövas mot öppningens
  tidigaste bokförda korsning. Följdfallet (en senare båt bakom en nysläppt båt, som stannar minst
  tio minuter, varnas 46–286 s före passagen) godtas som känd gräns OM granskningen visar att det
  är samma utfall som dagens kod ger när bokföringarna kommer i rätt ordning, annars tas
  rättningen inte in. Granskningen visade just det (12.3.5).
- **U44 (F30).** Förvarning för en bro som ligger bakom båten (12.3.12). (1) En ny båt mer än 70 m
  bortom en bro som inte är hennes målbro, på väg bort i minst 2 kn, får en passagenotis med
  meningen enligt formregeln i U37 del 2. (2) Inom 70 m behålls "närmar sig … strax": båten korsade
  3–11 s tidigare, och en passerad form på en brusposition vid en målbro vore fel i minuter. (3) En
  båt som först hörs bortom en bro och rör sig bort i under 2 kn får tills vidare förvarningen som
  förut (2 av 805 notiser). En regel som skjuter upp notisen är prövad av granskaren och tas som
  egen granskad ändring i en senare omgång. (4) Brobesökets bortre sida tas ur färdriktningen bara
  när farten är minst 2 kn eller föregående position låg entydigt på andra sidan brolinjen.
- **U43.** Två kända gränser efter riktningsändringen i N3: (1) en kurs tvärs över kanalen mitt i
  en U-sväng nollar vändningens första observation, så notisens riktningsfält kan stå kvar på det
  gamla hållet till nästa bro (texten stämmer); (2) parbron inom 70 m får ingen notis när nästa
  position kommer först efter en U-sväng. Båda får registerposter.

Utan eget nummer, som tydliga fel: återvändaren utanför Stallbackabron (N04) mäts först och rättas
om mätningen inte visar fler "Inga båtar"-blink eller extra notiser (N5); riktningsfältet (N12) och
parbron (N10 r3) prövas (N3); och verktygens orakel och register lär sig de fattade besluten (V1).

### 12.3 Det som gick in

#### 12.3.1 K1: kön strax bortom Stridsbergsbron (`44fd1e1`)

**Situationen.** Nattvärld 9530 (N16, N17). NORDVIND (klass B, aisstream) går söderut i 5,2 kn.
Fixen 13:12:54 ligger 517 m norr om Stridsbergsbron. Nästa fix kommer 327 s senare, 13:18:21,
165 m bortom bron i kön före Järnvägsbron, med fart 0 och kurs 164,1°. Därefter hörs hon först
13:34:50. Användaren fick "Okänd båt närmar sig Stridsbergsbron" 13:18:21, två minuter efter
passagen, brotexten "En båt på väg mot Stridsbergsbron, ETA okänd" i 16 min 50 s och ingen
passagenotis. Varningen var rätt. Analysen dömde förflyttningen som osäker (`uncertain_movement`:
stillafixens kurs pekade 51,5° fel mot förflyttningen), och stillagrinden (S1) spärrar då alla
broar för en båt under 0,5 kn, eftersom en stilla båt inte har rört sig. Glappvägen, som annars
bokför bron i samma tick, krävde ett latitudhopp över 0,005°; här var det 0,004994°. Samma köplats
och radioläge finns i banken (20260713, båt 219029789: 416 m före Stridsbergsbron i 7,5 kn, 299 s
glapp, stopp 177 m bortom bron), men där saknades kursen och S1 nåddes inte.

**Ändringen.** Stillagrinden spärrar inte när färden före glappet förklarar stoppet. Alla fyra
villkoren ska hålla: startfixen är ren och har en rå fart på minst 0,5 kn (MOVEMENT_PROOF_SOG_KN);
förflyttningen är högst startfarten × tiden mellan fixarna × 2,0; bäringen ligger inom 45° från
startkursen (en okänd kurs prövas inte); och stillafixen ligger mer än 60 m från brons linje
(UNDER_BRIDGE_CROSS_PROOF_JITTER_M), eftersom en stilla fix innanför inte kan bevisa sidan. Inga
nya konstanter. Faktorn 2,0 och 45° är analysatorns egna marginaler. Passagen bokförs nu på
stillafixen 13:18:21, och texten byter till "En båt på väg mot Klaffbron, ETA okänd". Notisen
sade på K1-grenen "Okänd båt har precis passerat Stridsbergsbron". Med formregeln i U37 (12.3.8)
byter 1 480 lägen i K1:s band till "passerade … under AIS-tystnad", alla med glapp 200–800 s.

**Granskningen.** Godkänd i första varvet, med tre låga anmärkningar:
- Notisen blev "har precis passerat" även efter långa glapp: 45 av de 80 lägen i bandet som bytte
  text blev sämre enligt formregeln för retursläpp och 35 bättre. Det var normalvägens befintliga
  regel och togs om hand av U37 del 2.
- Startkursen för en återhämtningsposition kom från den senare, osäkra fixen.
- Två konstanter speglade analysatorns literaler, och en mening i ARCHITECTURE var oprecis.

De två sista åtgärdades i `0c09598`, som granskaren kontrollerade och godkände. En mutation
överlevde där (en kurs som saknas faller tillbaka på den klistriga kursen), en liten testlucka.
Granskaren rättade också rättarens kostnadsräkning: i motfallsbandet (båten stannar 30 eller 60 m
FÖRE bron och första stillafixen hamnar 50–120 m bortom linjen) bokförde basen en falsk passage i
64 av 64 lägen, inte 48. K1 ändrar i 10 av dem när och hur den kommer: på brusfixen med en falsk
"har precis passerat", i stället för en riktig "närmar sig" och en tyst falsk passage 2–3 min
senare. Bruset som krävs, 65–120 m hos en stilla båt, förekommer 0 gånger på cirka 23 000
stillatripplar i banken och fältkörningarna; den största isolerade spiken är 43 m.

**Mätningen.** S1 spärrar inte en enda gång i banken eller k1/k2, räknat i full debuglogg i 87
körningar (29 filer, vanligt läge, fusion och monitoring), så banken och fältkörningarna är
bitlika. I rättarens band (2 646 varianter genom hela appen: avstånd bortom bron 20–240 m, glapp
60–800 s, fart 0,6–9 kn, stillakursens avvikelse −60…+50°) går 137 lägen från sen till direkt
passage och inget åt andra hållet. Hela jest gav 396 sviter (5 943 test efter `0c09598`),
`replay:synthetic` 114 scenarier (två nya, båda röda på koden före) med 16 WARN-rader som förut,
och `replay:openings` var identisk med slutbatteriets. Av nattens 65 representanter försvann
N16 r1 och N17 r1; de övriga 63 gav ordagrant samma utskrift. Standardjakten gav samma två
kandidatkort som slutbatteriet.

#### 12.3.2 K3 fel 2: notisvägen prövar brolinjen, inte brons latitud (`02ea516`, omlåsning `f543190`)

**Situationen.** Nattvärld 16517 (N08 r3). BRISEN hörs 10:01:22 efter 198 s glapp, 22 m från
Stallbackabron, norr om brons latitud men 13,3 m söder om brolinjen. Notisvägen (BN2) jämförde
latitud och skickade "passerade Stallbackabron under AIS-tystnad". Besöket fick därmed fel bortre
sida, och den riktiga korsningen gav 10:03:06 en returnotis "har precis passerat" 432 m bort. Två
notiser för en passage. Brolinjerna går snett: latitudlinjen genom brons punkt avviker från
brolinjen med 0,84 m längs kanalaxeln per meter i sidled vid broarna med axeln 130° och med
1,28 m vid Stallbackabron (142°). Vid linjen ligger bankens fixar −30…+30 m i sidled vid
Klaffbron (p1–p99) och −25…+19 m vid Stallbackabron (p1–p90), så kilen är upp till ett par
tiotal meter.

**Ändringen.** Ligger båten entydigt (mer än 10 m) på tillfartssidan av brolinjen ger notisvägen
ingen passerad form. Ligger hon entydigt på bortre sidan, och började hoppet inte redan bortom
linjen, ger den passerad form. I övrigt (inom ±10 m, eller båda positionerna bortom linjen) gäller
latitudsvaret som förut. Systerstället i de skippade broarna rättades i samma ändring: en bro där
båten ligger entydigt på tillfartssidan stryks ur svepets fönster (`SKIPPED_BRIDGES_BEFORE_LINE`).
Förut bokfördes en båt som hoppat fram till kilen och väntade där som passerad, och texten bytte
till "Inga båtar" medan hon väntade. BRISEN får nu en notis, "BRISEN närmar sig Stallbackabron,
beräknad ankomst strax", 22 m från bron och 1 s före korsningen.

**Granskningen.** Godkänd i första varvet. Granskaren visade att felet fanns också vid målbroarna:
ett hopp till 13 m före linjen gav på basen dubbelnotis i alla fyra fallen vid Klaffbron och
Stridsbergsbron åt båda hållen, och K3 gav en "närmar sig … strax". Två låga anmärkningar
åtgärdades i `41ed615`: sändaren i 20260713-41h beskrivs som troligen ett landfordon, och filtret
i de skippade broarna fick ett jest-test (det fälldes förut bara av `replay:synthetic`). Den andra
rättningen på spåret (fel 1) togs inte in (12.4); fel 2 lyftes ut och prövades för sig.

**Mätningen.** Banken ändras i en korpus, 20260713-41h; k1 och k2 är identiska. I banken och k1/k2
(14 859 unika fixar) ger linjen och latituden olika sida i 3 fixar: en i kanalen vid Olidebron och
två hos sändaren i 41h. Fältet har inget BN2-fall i kilen. I ett rutnät ±1,5 km kring varje bro
var linjeprovet aldrig sämre än latituden inom 50 m från farleden. Den utlyfta grenen gav hela
jest 396 sviter och 5 969 test, `replay:synthetic` 115 scenarier (tre nya) med 16 WARN-rader och
`replay:all` grönt utom 41h. Av nattens representanter försvann N08 r3. `measure:eta` gav inget
sämre påstående: sändarens "om 3 minuter" vid Klaffbron försvann. Standardjakten gav ett nytt
kort i bankspåret, INV-14 DEFAULT-FLASH i 41h vid δ −7 och −2,5 s: "Inga båtar" i 30 s 13:35:38.
Samma 30 s finns på koden före, men där stod de mellan texter om två olika broar och räknades inte
som blink. Kortet följer av omlåsningen.

**Omlåsningen (U13).** 20260713-41h. Sändaren 218023240 har två positioner: 13:17:01 4 m från
Stallbackabrons brolinje i 33,2 kn med kursen 142,5° längs broaxeln, och 13:20:31, 2 084 m bort,
924 m från Stridsbergsbron och 1 025 m från Järnvägsbron, cirka 890 m sydost om farleden.
Rådatafacit har ingen korsning. Förut bokfördes Stridsbergsbron och Järnvägsbron som passerade på
latitud 13:20:31, med två notiser "Okänd båt passerade … under AIS-tystnad" söderut. Båda
passagerna och båda notiserna försvinner: notiser 165 → 163, golden-text 262 → 261. Notisen för
Stallbackabron och de 52 öppningsvarningarna är oförändrade, och `replay:openings` går från en
klassad miss (spökpassagen) till full täckning, 40 av 40. Brotexten 13:20:31–13:35:40 är lika fel
före och efter, eftersom sändaren fortfarande visas som en båt: förut mot Klaffbron ("Två båtar …
om 3 minuter"), nu mot Stridsbergsbron ("strax" i 5 min, sedan "ETA okänd"). Tre rader ändras.
Det rättas av U41 (12.3.10).
Dirigentens radvisa diff mot positionerna och granskarens oberoende radfacit gav samma dom.

#### 12.3.3 U31: inbromsningsregeln (`87d265a`, omlåsning `9e4daf4`)

**Situationen.** Buggjägarens kort F02 (XENIA, 11.5 F19): en båt som bromsar in strax utanför
300 m fick "strax" 9,9 min före passagen, sedan "om 4" och sedan "strax" igen.

**Ändringen.** Det publicerade värdet hålls på 3 min när medelfarten ensam lovar strax. Alla
villkor ska hålla: ett nytt inträde i strax (föregående fix publicerade minst 3), fixets egen
mätning under 3, medelfarten minst 1,2 gånger momentanfarten (DECEL_HOLD_MIN_RATIO), momentanfartens
ETA minst 3,5 min, och båten utanför 300 m med imminent-flaggan av. Hållningen gäller bara
publiceringen; historiken bär det ohållna värdet. Regeln och dess granskning står i 11.5 (F19)
och ARCHITECTURE §8 (e), "F02 gick in".

**Granskningen.** Granskad i omgång 2 i tre kontroller (11.5). Vid sammanslagningen räknades
commit-hänvisningarna om efter avsändarbytet; regeln är oförändrad.

**Mätningen.** `measure:eta` mot `187f31e`: 0 av 3 198 parade påståenden ändras. Ett påstående
tillkommer (MALUCA, "om 3" mot sanningen 2,8, fel +0,2) och godtas i U31. Strax-löftet går från
65,14 till 65,28 %. Notiser, öppningskort och antalet övergångar är oförändrade, och k1–k3 är
bitlika (VALIDATION "### F02, 2026-11-16").

**Omlåsningen (U13).** Två golden-text-rader, antalet övergångar oförändrat i båda:
- 20260712-25h, 13/7 07:42:16, Klaffbron: "Två båtar på väg mot Klaffbron, beräknad broöppning
  strax" blir "… om 3 minuter". MALUCA bromsade från 5,5 till 1,3 kn 320 m före bron och korsade
  07:45:06, 2,8 min senare. Raden godtas uttryckligen i U31.
- 20260806-42h, 7/8, Stridsbergsbron: "Fem båtar … strax" kommer 09:13:57 i stället för 09:12:50.
  Gruppen låg i kö, och första korsningen därefter är 09:36:19. En för tidig "strax" kommer 67 s
  senare.

#### 12.3.4 U32: fartökningsregeln vid Järnvägsbron (`b9376d4`, omlåsning `ade8734`)

**Situationen.** En båt som väntat söder om Järnvägsbron och ökar farten när bron öppnar fick
öppningsvarningen för Stridsbergsbron bara cirka två minuter före passagen. LIDAN fick den 15/11
137,8 s före, och kortet sa "om 5" när 2,3 min återstod (11.5, F7).

**Ändringen.** Regeln gäller ett nytt fix högst 400 m före Järnvägsbron
(`EARLIER_BRIDGE_ACCEL_BAND_M`), efter två föregående fix i minst 1 kn, med minst 0,8 kn ökning
mot fixet före det förra och minst 0,3 kn mot det förra. Det utlösande fixet ska visa minst
2,8 kn (`EARLIER_BRIDGE_ACCEL_FLOOR_KN`), varje steg vara högst 240 s, kursen gå mot bron och ingen
vändning vänta. Då räknas spärrens restid i minst 5 kn, och kortets siffra är den lägre av
ETA-kedjans värde och regelns restid, avrundad uppåt. Någon avgångsgren ur stillhet finns inte.
Med täta positioner (klass A, fix var 2–10 s) syns ökningen aldrig över två steg, så vinsten
gäller i praktiken AISHub-takt. Bakgrunden står i 11.5 (F7) och ARCHITECTURE.

**Granskningen.** Granskad i omgång 2 i tre varv (11.5). Godkänd med fartgolvet (`15602c3`).

**Mätningen.** I banken och fältkörningarna flyttas exakt sju varningar, alla tidigare: BALTIC
DREAM 107 → 186 s, VISTEN 132 → 192 s och LIDAN 138 → 206 s lyfts över 150 s, och MONIKA, LIANNE,
NAVEN och JAATTEN II får mer ledtid (JAATTEN II 8 s, MONIKA 51 s). Inget påstående i `measure:eta` blir sämre. I
rådatan utlöses regeln 13 gånger hos 8 båtar, och alla gick igenom utan att stanna.

**Omlåsningen (U13).** En post i `openingWarnings` flyttas i var och en av fyra korpusar.
Händelse-id, medlemmar och originalDueMs är oförändrade; varningen kommer tidigare, och kortet
säger 3 minuter i stället för 5–6. Ledtiderna är räknade mot rådatafacits korsningar:

| Korpus | Båt | Ledtid före → efter | Sann restid vid varningen |
|---|---|---|---|
| 20260708-21h | JAATTEN II | 169 → 177 s | 2,9 min |
| 20260806-42h | MONIKA | 193 → 244 s | 4,1 min |
| 20260917-16h | VISTEN | 132 → 192 s | 3,2 min |
| 20261114-34h | LIDAN | 138 → 206 s | 3,4 min |

Notiser, texter, passager och övriga varningar är oförändrade, och monitoringkörningen ger samma
poster. Fältsviten för 14 november låste förut LIDANs tunna varning som känd gräns. Den låser nu
det nya utfallet, och att ingen varning i körningen ligger under 150 s. Förväntningarna i
fältsviten för 17 september ändrades i samma commit.

#### 12.3.5 K2 och U42: nya båtar prövas mot öppningens tidigaste korsning (`db9db01`)

**Situationen.** Nattvärld 11777 (N02 r3; N23 r2 är samma mekanism). Klaffbron#3 varnar för PELLE
och FREJA. PELLE korsar Klaffbron 16:26:10 och FREJA 16:30:55 under ett avbrott. FREJA bokförs
först (skattad korsning 16:31:19), PELLE 12 s senare (skattad 16:26:49). Öppningens fönster räknas
då från FREJAs korsning. HAVSORN 2 hörs 16:34:14, absorberas i #3 ("täckt t.o.m. 16:44:01") och
korsar 16:40:24, 14 min efter PELLE, utan egen varning. Felordningen finns 9 gånger i banken utan
synlig följd (11.9).

**Ändringen.** Öppningshändelsen minns sin tidigaste bokförda korsning (`earliestCrossingAt`). Den
sätts bara när en senare bokföring korsade tidigare, och bara bakåt; loggraden är
`OPENING_PASSAGE_EARLIER`. En ny, lös båt räknas inte till händelsen när hon har minst två tick
kvar till bron (2 × TICK_INTERVAL_MS, 60 s) och hennes ankomst ligger mer än ett konvojfönster
(CONVOY_WINDOW_MS, 600 s) från den tidigaste korsningen. Hon får då en egen händelse och en egen
varning. Med under två tick kvar gäller referensen som förut. Händelsens första passage,
bakkanten, golven, U15, täckningsslutet och domspåret är oförändrade. Villkoret gäller bara efter
en felordnad bokföring.

**Granskningen.** Den första versionen flyttade i stället händelsens referens bakåt. Den
underkändes två gånger (12.4), och granskaren föreslog i andra varvet en variant på nio rader.
Dirigenten valde den, och den godkändes i tredje varvet. Granskaren körde samma trafik på koden
före rättningen med bokföringarna i rätt ordning och jämförde varning för varning:

| Svep | Lägen | Som koden före i rätt ordning | Som koden före i samma felordning | Tidigare än båda |
|---|---|---|---|---|
| Rättarens följdfall | 345 | 345 | 0 | 0 |
| Rättarens svep | 750 | 623 | 127 | 0 |
| Granskarens svep 1 (fyra geometrier, tre medlemmar) | 10 620 | 10 050 | 570 | 0 |
| Granskarens svep 2a (annan händelse vid bron) | 2 016 | 1 786 | 206 | 24 |
| Granskarens svep 2b (två felordnade händelser) | 672 | 530 | 142 | 0 |

Följdfallet i U42 (46–286 s ledtid för en båt bakom en nysläppt båt) är alltså appens vanliga
beteende för den trafiken, inte en försämring, och U42:s villkor är uppfyllt. De korta ledtiderna
(26 och 46 s) är bakkantens befintliga gräns för en väntande båt strax bortom ett konvojfönster
(12.5). Tredje varvet hade tre låga anmärkningar. Två av dem, stycket om följdfallet i ARCHITECTURE
och loggradens ordalydelse ("tidigaste kända korsning"), togs om hand vid sammanslagningen, där
också tre radhänvisningar i registret som förslagsskriptet lagt på fel stycke rättades för hand.

**Mätningen.** Banken, k1 och k2 är bitlika i varningar, notiser, texter, täckning och
domar. Av nattens 65 representanter försvann N02 r3 och N23 r2; de övriga 63 gav byte för byte
samma utskrift. De 81 syntetiska världar med felordnad bokföring som buggjägarens kinematik ger
(köer, krypfart, stopp) gav identiska varningar, notiser och brotexter före och efter. Hela jest gav
396 sviter och 5 965 test, `replay:synthetic` 114 scenarier med 16 WARN-rader, och standardjakten
samma två kandidatkort som förut, utan något nytt domtillstånd.

#### 12.3.6 N3: riktningsfältet efter en U-sväng (`b19f444`)

**Situationen.** Nattvärld 2931 (N12 r2). HAVSORN går söderut genom Stridsbergsbron och Järnvägsbron
och vänder cirka 450 m norr om Klaffbron. Kurserna efter vändningen, alla i minst 3 kn, är 39°,
68°, 35° och 27°. Den första omvända positionen satte en väntan. 68° ligger i dödbandet (46–134°)
och nollade den. 35° satte väntan igen, men i samma fix togs målbron bort, eftersom avståndet växte,
vilket är vändningen själv. Den andra omvända positionen (27°) prövades aldrig, eftersom Fix D
kräver målbro. Notisen 12:01:50 "HAVSORN närmar sig Järnvägsbron, beräknad ankomst om 1 minut"
fick riktningen söderut, och Stridsbergsbrons returvarning kom inte före korsningen 12:04:21.
Texten stämde.

**Ändringen.** Utan målbro bekräftas Fix D:s väntan på positionen direkt efter väntans position,
med Fix D:s egna grindar: minst 2 kn, kursbanden, väntan yngre än 15 min, inget avslutat slutmål
(där äger NEW_JOURNEY vändningen) och inte förtöjd. Utfallet är det Fix D hade gett om målbron
levt en fix till. I värld 2931 bekräftas vändningen 12:01:31 i stället för 12:04:00, och
Stridsbergsbrons returvarning kommer i det syntetiska scenariot 3 min före korsningen i stället
för 64 s. U18 rörs inte: en position i dödbandet emellan bryter kedjan som förut.

**Granskningen.** Godkänd i första varvet, med fem låga anmärkningar. Tre villkor saknade test som
fällde dem; fyra test ur granskningen lades till vid sammanslagningen (spegling norrut,
åldersgränsen och ett lås som redan bytts). Två anmärkningar är upplysningar om vad rättningen
ärver från Fix D: en omsänd aisstream-position räknas som andra observation, och en dubbelvändning
kan ge en falsk returvarning. Båda finns i dag hos Fix D med målbro. Granskaren avrådde från
rättarens förslag att låta en kurs i dödbandet passera efter 50 m förflyttning: kravet skiljer
nästan ingenting, och det ändrar Fix D med målbro.

**Mätningen.** Fyra av kortets nio världar blir rätta (2931, 7135, 9681, 11673). Tre (2125, 6244,
16784) bryts av dödbandet och två (7262, 18849) hade bara en omvänd position före varningen; de
är kvar enligt U18 och U43. Av nattens 65 representanter ändrades bara N12 r2. Banken, k1 och k2
är oförändrade, eftersom vägen aldrig bekräftar där: i k1 och k2 satte Fix D aldrig en väntan, och
i banken bekräftade den 0 av 29 anrop. Värdet vilar alltså helt på syntetiska världar.
`replay:synthetic` gav 119 scenarier (två nya) med 16 WARN-rader.

**Parbron inom 70 m (N10 r3), inte rättad.** Nattvärld 2737: NORDVIND passerar Järnvägsbron
söderut, och appens enda position nära bron ligger 13 m bortom linjen, i samma ögonblick som
Stridsbergsbron bokförs. Hon vänder, och nästa position kommer fem minuter senare, 282 m norr om
Stridsbergsbron. Järnvägsbron bokförs aldrig och får ingen notis. Utredarens förslag (parbron som
kandidat inom 70 m) gjorde fältfallet bakom FIX U fel: PRICKBJORN i k2, 23 m bortom Järnvägsbron i
samma läge, fick "närmar sig Järnvägsbron, beräknad ankomst strax" i stället för den sanna "har
precis passerat Järnvägsbron". På passagefixen går de två fallen inte att skilja åt. Luckan
beskrivs i ARCHITECTURE (`3a28538`) och är en känd gräns enligt U43.

#### 12.3.7 U33: notisen säger restiden när brotexten säger "strax" (`75e48991`, omlåsning `2474d18`)

**Situationen.** Målbronotisen byggs på positionens första ETA-beräkning och brotexten på den
andra, 25 ms senare, där imminent-flaggan (300 m) tvingar "strax". Notisradien är också 300 m. I
fältkörning 3 sa tre Klaffbronotiser "om 3–4 minuter" i samma ögonblick som texten bytte till
"strax" (11.5, F20). LIDAN fick 15/11 06:15:58 "om 4 minuter" och korsade 2,91 min senare. Banken
hade 94 sådana motsägelser, k1 5 och k2 4.

**Ändringen.** Notisen säger restiden i båtens egen fart (avstånd/fart, avrundad som alla notiser)
när fyra villkor håller: notisen hade sagt 3 eller mer, båten når bron inom 3 min
(`NOTICE_STRAX_REACH_MINUTES`), hon bromsar inte in (U31:s kvot 1,2), och texten kommer att säga
"strax" för just henne. Siffran är minst 1 (`NOTICE_STRAX_MIN_MINUTES`) och aldrig högre än den
annars hade varit. Bara notisens siffra ändras, inte dess tidpunkt, texten, varningen eller båtens
ETA. Beslutet om "strax" ligger i en ren funktion som både texten och notisen frågar; med regeln
avstängd är banken och fältkörningarna bitlika med koden före.

**Granskningen.** Två varv. Första versionen sa alltid "om 2" och underkändes:
- Förutsägelsen frågade med notisens siffra efter taket FLOW_TRIGGER_ETA_CAP, inte med båtens egen.
  Granskaren byggde ett glapp med osäker position där notisen sa "om 2 minuter" medan texten sa
  "om 8 minuter". Rättat i `7116d96`.
- 20260917-7h har ofullständig fångst och får enligt sin egen not inte låsas om med verktyget.
  Det krävde ett uttryckligt beslut (se omlåsningen).

Taket och restiden mättes sedan mot varandra (VALIDATION "### U33"). Taket gav fler bättre
notiser (banken 33 mot 29), restiden lägre medelfel och färre sämre: i de 225 slumpade världarna
152 bättre och 31 sämre mot 169 och 51, och i klassen med sanningen 2,5–3,0 min 13 sämre mot 29.
Dirigenten valde restiden (`23e6d4e`, U33 preciserat). Andra varvet godkände, med två låga
anmärkningar som kända gränser (fartspik och "om 1", 12.5).

**Mätningen.** `measure:eta` mot `9e4daf4`: 34 notiser ändras, 29 bättre, 3 sämre och 2 omätta.
Texten, öppningskorten, strax-löftet (65,28 %) och antalet notiser är oförändrade. För notiser med
sanningen under 5 min (n 525) går medelfelet från 0,612 till 0,551 min och medianen från 0,36 till
0,32. Motsägelserna går 94 → 65 i banken, 5 → 3 i k1 och 4 → 0 i k2. I k1 och k2 ändras sju
notiser, alla i ett ögonblick då texten sa "strax" för båten. Ingen notis höjdes och ingen ändrades
utan "strax" i texten, i banken, fältet, 136 handbyggda fall eller 183 ändrade notiser i de
slumpade världarna. Nattens 65 representanter är identiska med koden före. `replay:synthetic` gav
120 scenarier (tre nya).

De tre sämre, alla med "strax" i texten för båten 25 ms efter notisen:

| Korpus | Tid | Båt | Bro | Avstånd, fart | Notis före → efter | Sanning |
|---|---|---|---|---|---|---|
| 20260707-14h | 7/7 11:14:21 | HELGE | Klaffbron | 297 m, 3,4 kn | 4 → 3 | 3,79 min |
| 20260702-19h | 3/7 08:21:10 | CAVA | Stridsbergsbron | 275 m, 4,4 kn | 3 → 2 | 3,56 min |
| 20260917-16h | 17/9 23:57:58 | WILSON ALSTER | Klaffbron | 289 m, 3,9 kn | 3 → 2 | 2,56 min |

För HELGE och CAVA sa texten "strax" för tidigt, och notisen följer den. För WILSON ALSTER sa texten
"strax" med rätta, men restiden (2,40 min) underskattade. Alla tre godtas i U33.

**Omlåsningen (U13).** Tjugo notiser i åtta korpusar byter siffra och mening; tid, bro, riktning,
avstånd och antal är oförändrade. Mot rådatafacits korsningar (sanningen inom parentes) blir 18
rättare, en sämre och en går inte att mäta:

| Korpus | Notiser |
|---|---|
| 20260804-both-21h | MS JUTLAND 3 → 2 (1,81), ANDREA 3 → 2 (1,64), LAURIERBORG 3 → 2 (2,46), ANYA ELAN 380 5 → 3 (omätt) |
| 20260806-42h | ATHENA 3 → 2 (1,70), ANDREA 4 → 2 (2,10), MONIKA 4 → 3 (2,88), ELFKUNGEN 3 → 2 (1,68), MISTRAL 4 → 1 (1,77), FARUREJ 3 → 2 (2,43) |
| 20260823-24h | PRIMA LADY 3 → 2 (2,33) |
| 20260907-31h | TROUBADOUR 3 → 2 (1,94), OLA 3 → 2 (1,87) |
| 20260909-80h | TINY 4 → 2 (1,45) |
| 20260917-7h | SUSANNE 4 → 2 (1,79) |
| 20260917-16h | VISTEN 3 → 2 (2,47), WILSON ALSTER 3 → 2 (2,56, sämre), TUNA 3 → 2 (1,68) |
| 20261114-34h | LIDAN 4 → 3 (2,91), SYLVIA 3 → 1 (1,57) |

ANYA ELAN 380 korsade aldrig Klaffbron igen: hon låg och manövrerade norr om bron till 08:23 och
gick sedan norrut. Notisen var falsk redan förut. I 20260917-7h ändrades bara post 12 (SUSANNE,
Stridsbergsbron 16:11:01). Posten ligger före bortfallet och är uppmätt mot rådatafacit; den
handredigerades med dirigentens uttryckliga beslut, som står i VALIDATION. Dirigentens egen diff
mot rådatafacit och granskarens oberoende radfacit gav samma före → efter på alla rader.

#### 12.3.8 U36 och U37: returnotisen direkt, en formregel och den gamla svepnotisen (`5d48c83`, omlåsning `56762d0`)

**Situationen.**
- *Returen (N15, N08 r2).* LINNEA 2 korsar Klaffbron söderut 01:13:14 i 5,8 kn. Fixen 01:12:59
  ligger 35 m norr om linjen och fixen 01:13:23 26 m söder om den. Vid täta positioner krävde
  returbeviset 30 m ut eller två fixar. Nästa fix kom 01:20:24, 1,2 km bort, och då kom "har
  precis passerat Klaffbron" samtidigt med "närmar sig Olidebron", 7 min 10 s sent.
- *Formen (N08 r1).* TROLLA korsade Järnvägsbron i ett segment på 67 s och var sedan tyst i 135 s.
  Returnotisen kom 15:42:15, 174 s efter korsningen och 531 m bort, och sa "har precis passerat".
  Meningen följde notisens källa: S4 sa "har precis passerat" efter 800 s tystnad, och notisvägen
  och failsafen sa "under AIS-tystnad" om en korsning 4 s före fixen.
- *Svepet (N13).* FREJA återföds 58 min efter sin senast kända position. Svepet räknade söderut
  (nettot), men den rörelsebevisade kursen var norrut. Hon fick "passerade Stallbackabron under
  AIS-tystnad" söderut för en passage 55 min tidigare, och 3 min senare "närmar sig Stallbackabron"
  norrut.

**Ändringen.**
- *U37 del 1.* I marschfart (minst 3,13 kn, `RETURN_TRANSIT_SOG_KN`) släpps returen på korsningsfixen
  vid vilken kadens som helst, när fixen ligger entydigt (mer än 10 m) på ankomstsidan, föregående
  fix entydigt på bortre sidan, det är första fixen på ankomstsidan och bokföringen hör till
  segmentet. Två villkor kom ur granskningen: korsningssegmentet ska gå att färdas i den
  rapporterade farten (högst 1,5 × farten + 0,5 m/s), och det får vara högst 15 m längre än farten
  medger (`RETURN_SEGMENT_EXCESS_MAX_M`). Ett segment som inte klarar kraven släpps vid nästa
  position, som förut. LINNEA 2 får notisen 01:13:23, 10 s efter korsningen. *Avvikelse från
  beslutets ordalydelse:* U37 säger "vid positionen på brolinjen", men en fix inom ±10 m från linjen
  släpps fortfarande bara vid gles kadens. I rättarens motfallssvep gav en sådan fix annars 5
  falska returer på 240 banor (en båt som bromsar till 3,25 kn mot linjen och stannar eller vänder
  3–8 m förbi den). Dirigenten behöll gränsen.
- *U37 del 2.* Alla passagenotiser (retursläppen, S4, just-passed, notisvägen, failsafen och
  svepet) väljer mening med samma regel (`lib/utils/passageNoticeForm.js`): tystnadsform när det var
  tyst i mer än 130 s kring korsningen och notisen kommer mer än 60 s efter den. Tystnaden är det
  längsta intervallet från fixen före korsningen till notisens fix. Korsningstiden skattas ur fixen
  efter korsningen som avståndet bortom linjen delat med farten (från 0,5 kn). Ligger båten still
  efter en tystnad är korsningstiden okänd, och formen blir tystnadens. TROLLA får nu "passerade
  Järnvägsbron under AIS-tystnad". Källsträngen, ETA och `already_passed` rörs inte, och inte heller
  "har passerat Kanalinfarten".
- *U36.* Har appen själv sett att en återfödd båt vände i glappet, och är den senast kända
  positionen äldre än 17 min (`SWEEP_TURNED_STALE_MS`), skickas inga svepnotiser. FREJA får bara
  "närmar sig Stallbackabron" norrut. Vändningar appen inte sett (fart under 2 kn, kurs i dödbandet
  eller saknad) och svepets scenario B rörs inte.

**Granskningen.** Tre varv:
- *Första varvet:* del 2 och U36 godkändes. Del 1 underkändes för en hög anmärkning: en ensam
  GPS-utliggare 15–25 m förbi linjen, som grinden släpper igenom och passagelogiken bokför bron i,
  gav en falsk returnotis för en båt som aldrig korsade. I granskarens svep (720 banor, fix var
  10 s) gav del 1 13 falska returnotiser mot basens 5 och 11 tidiga mot 5. Rättarens eget svep hade
  bara jämnt brus (±3 och ±10 m) och ingen enstaka utliggare. Fartkravet lades till (`31e6b0d`).
- *Andra varvet:* vid 10 s kadens var felet borta, men vid klass B-kadens 20–30 s rymdes
  utliggaren i fartkravet: 8 falska och 6 tidiga notiser på 960 banor mot basens 0. Taket på 15 m
  lades till (`af54833`).
- *Tredje varvet:* godkänt. I ingen kadens 10–180 s ger del 1 en falsk retur eller en notis vid
  utliggaren utöver basens.

Granskaren prövade också de två valen i del 2. Mot sanningen i banken (59 799 konstruerade
tystnader över 292 korsningar) gav fartskattningen fel form i 240 fall (0,4 %), alla nära gränsen,
och linjär interpolation över glappet i 986 (1,6 %). Fartskattningen och tystnadsdefinitionen
behölls.

**Mätningen.** I banken byter 53 notiser i 17 korpusar form: 40 till tystnadsform och 13 till "har
precis passerat". Tid, antal, bro, riktning, brotext och öppningsvarningar är oförändrade, och k1
och k2 påverkas inte. I K1:s band (12.3.1) byter 1 480 lägen till tystnadsform, alla med glapp
200–800 s. Del 1 och U36 ändrar ingenting i banken eller fältkörningarna; låsets släpp, som U36
kräver, förekommer inte där. I rättarens positiva svep (36 banor med en verklig retur vid 15 s
kadens och 400 s tystnad efter) kom notisen på koden före 376–497 s efter korsningen eller inte
alls; nu kommer den 4–11 s efter korsningen i 22 banor. Taket kostar bara när AIS-farten ligger
15–30 % under den verkliga och kadensen är 15–30 s: med 70 % av farten och 30 s kadens släpps 0 av
18 banor direkt mot 14 utan taket, och de notifieras vid nästa position som förut. Av nattens 65
representanter försvann sex: N08 r1, N08 r2 (samma värld som N15 r1), N13 r1–r3 och N15 r1.
Hela jest gav 400 sviter och 6 161 test, och `replay:synthetic` 122 scenarier (fem nya) med 16
WARN-rader.

**Omlåsningen (U13).** Sjutton låsta notiser byter mening mellan "har precis passerat" och
"passerade … under AIS-tystnad". Tid, bro, riktning, siffra och antal är oförändrade:

| Korpus | Notiser |
|---|---|
| 20260708-21h | 6: fem till tystnadsform, SOLANDE vid Klaffbron (10:06:42) till "har precis passerat" |
| 20260711-16h | 4: tre till tystnadsform, ELFKUNGEN vid Olidebron (12:32:12) till "har precis passerat" |
| 20260712-25h | GALADRIEL vid Järnvägsbron till tystnadsform |
| 20260804-both-21h | 4 till tystnadsform |
| 20260806-42h | UTOPIA vid Stallbackabron till tystnadsform |
| 20260823-24h | TANGELA vid Järnvägsbron till "har precis passerat" |

Varje rad prövades mot positionerna: tystnaden kring korsningen och dröjsmålet från rådatafacits
korsning till notisen. Tretton följer regeln rakt av. Fyra är gränsfall (GALADRIEL, CARAT, ELFKUNGEN
vid Klaffbron 5/8 10:15 och UTOPIA): korsningen låg i ett glapp på 203–529 s, och notisen kom 34–59 s
efter den interpolerade korsningen, medan appens fartskattning lägger korsningen tidigare. "Under
AIS-tystnad" är sant i båda fallen, eftersom korsningen skedde i en tystnad över 130 s.
Granskarens oberoende radfacit fann 49 av bankens 53 formbyten säkert rätt, 4 troliga och inget
bevisat fel.

#### 12.3.9 U40: ett stopp som färden förklarar är inget GPS-hopp (`b8e2e4c`)

**Situationen.** K1:s band C (12.3.1): en båt går söderut i 5,2 kn, 517 m norr om Stridsbergsbron.
Nästa fix kommer 200 s senare, 120 m bortom bron, med fart 0 och en stillakurs 44,8° från den
gamla. 638 m på 200 s är 6,2 kn i snitt. Analysen jämför bäringen med stillafixens kurs och
snittfarten med stillafixens fart 0, och båda "felen" ger tillsammans poängen 0,367, under 0,4.
Fixen döms som GPS-hopp (`likely_gps_error`), orimlighetsflaggan spärrar passagen, och K1:s undantag
nås aldrig. Passagen kom 16 min sent med "passerade … under AIS-tystnad", och brotexten stod kvar
på Stridsbergsbron hela kön. K1 lämnade 28 sådana lägen sena i sitt band.

**Ändringen.** K1:s villkor 1–3 är en regel i analysatorn (`stopExplainedByPriorTransit`) som både
analysatorn och stillagrinden använder. I hoppgrenen blir fixen osäker i stället för hopp (skälet
`stop_after_transit`) när alla villkor håller: fixens rå fart är under 0,5 kn, regeln håller mot
förra fixen, fixen ligger mer än 60 m bortom varje brolinje som segmentet korsat, och snittfarten
över glappet är högst 1,1 gånger startfarten (`STOP_AFTER_TRANSIT_MAX_SPEED_RATIO`). Därefter
avgör stillagrinden och K1 passagen. Ett fysiskt omöjligt hopp, en rörlig fix (fart minst 0,5 kn),
en stilla startfix, ett hopp längre än färden, ett bakåthopp och en osäker startfix döms som förut.
Passagen bokförs nu på stillafixen, och texten byter direkt till "på väg mot Klaffbron, ETA okänd".

**Granskningen.** Godkänd i första varvet, utan kvoten. Granskaren byggde sex falska fall som koden
före inte hade (bland dem en båt i 3 kn med en fix med fart 0 261 m framåt), alla med ett
positionsfel på 110–300 m på en fix med fart 0, något som inte finns i banken eller fältet.
Granskaren föreslog en kvot på cirka 1,2 som ett bättre verktyg än att vidga 60 m till 80 m, men
krävde den inte. Dirigenten valde att skärpa: en båt som stannat har bromsat, så den fysiska
gränsen är 1,0, och i banken och fältet har inget verkligt stopp efter marschfart (startfart minst
3 kn) en kvot över 1,03. Rättaren lade in 1,2 (`ce29f72`) och dirigenten valde 1,1 (`71ae772`).
Granskarens kontroll godkände båda commits: de sex falska fallen är borta, och en låg anmärkning om
fartspik på startpositionen står nu som känd gräns i ARCHITECTURE.

| Kvot | Rättade av 28 | Falska av 36 i motfallsbandet | Granskarens 6 falska fall |
|---|---|---|---|
| ingen | 28 | 36 | 6 |
| 1,5 | 22 | 28 | 2 |
| 1,2 | 14 | 18 | 0 |
| **1,1 (vald)** | **11** | **10** | **0** |
| 1,0 | 9 | 6 | 0 |

**Mätningen.** Grenen nås aldrig i banken eller fältet: `likely_gps_error` fälls inte en enda gång,
och orimlighetsflaggan fälls fyra gånger (tre `medium_movement_speed_mismatch` och ett fysiskt
omöjligt hopp), lika före och efter. De 39 verkliga stoppen efter färd i banken och fältet har alla
snittfart under 5 kn och når därför aldrig hoppgrenen. I bandet (2 646 varianter) går 11 lägen
från sen till direkt passage, och inget åt andra hållet; 9 av de 11 har kvot högst 1,0, alltså
verkliga tvära stopp. Nyttan är därmed hypotetisk. Av nattens 65 representanter var alla ordagrant
lika koden före. Hela jest gav 398 sviter och 6 015 test, och `replay:synthetic` 119 scenarier (två
nya, båda med kvot 0,94) med 16 WARN-rader.

#### 12.3.10 N5: fartgränsen för nya sändare (U41) och återvändaren utanför sista bron (N04) (`71da90f`, omlåsning `ee4b804`)

**Situationen.**
- *Sändaren (F29).* 20260713-41h: sändaren 218023240 har två positioner i hela korpusen. 13:17:01
  ligger den på Stallbackabrons körbana i 33,2 kn med kursen längs broaxeln, och 13:20:31 i 21,7 kn
  877 m från farleden. Den visades som båt i 18 min, fick notisen "Okänd båt närmar sig
  Stallbackabron, beräknad ankomst strax" på sin första position och stod sedan i brotexten som en
  båt på väg mot Stridsbergsbron (12.3.2).
- *Återvändaren (N04).* Nattvärld 19721: en båt går ut norrut genom Stallbackabron, vänder cirka
  420 m bortom bron och kommer tillbaka i 9–10 kn. I 10 min efter en avslutad resa avvisar appen
  varje position från båten (återinträdesspärren, som finns mot att en båt som just lämnat området
  skapas om och om igen). Hon syntes först 232 m före Stridsbergsbron, och notisen, en sju minuter
  gammal notis för Stallbackabron och öppningsvarningen kom på en gång, 51 s före korsningen.
  Söderut är det värre: resan avslutas först söder om Kanalinfarten, och en återvändare når
  Klaffbron inom spärren.

**Ändringen.**
- *U41.* Appen skapar ingen båt när en sändare som den inte följer rapporterar minst 15 kn
  (`IMPLAUSIBLE_NEW_VESSEL_SOG_KN`). Loggraden är `[VESSEL_IMPLAUSIBLE_SPEED]`, och nästa position
  prövas på nytt. En båt som redan följs berörs inte, så en enstaka orimlig fart får henne inte att
  försvinna.
- *N04.* Under spärren bygger appen en kedja av godkända positioner. En position är godkänd när den
  ligger entydigt på utfartssidan av sista bron (Stallbackabron norrut, Olidebron söderut), har kurs
  mot brolinjen, går i minst 4,5 kn (`REENTRY_RETURN.MIN_SOG_KN`) och ligger ett steg från den
  förra godkända positionen som farten medger. Båten släpps när en senare position ligger minst
  100 m (`REENTRY_RETURN.MIN_APPROACH_M`) närmare linjen än kedjans första. En underkänd position
  nollar kedjan. Därefter gäller samma väg som när spärren löper ut. Under 4,5 kn är utfallet som
  förut.

**Granskningen.** Tre varv. U41 godkändes i första varvet med anmärkningar om dokumentationen: 15 kn
är försvarbart men inte belagt åt något håll, eftersom banken och fältkörningarna saknar positioner
mellan 13 och 21,7 kn, och kostnaden för en verklig snabb båt var större än rättaren skrivit. Den
står nu i ARCHITECTURE (`af22888`). Återvändaren underkändes två gånger:
- *Första varvet:* med 2 kn och 50 m släpptes en båt som driver i 2,2 kn mot bron till 150–250 m.
  Hon fick "närmar sig Stallbackabron, beräknad ankomst om 4 minuter" fast hon aldrig korsade, och
  stod i texten i 3–5 min. Samma sak gällde en kajmanöver i 2,5 kn söder om Olidebron och en
  ankrad båt med ett brusigt positionspar. Rättaren höjde till 3 kn och 100 m (`f62e492`).
- *Andra varvet:* med 3 kn släpptes fortfarande båtar i 3,1–3,5 kn som driver eller går mot bron
  och sedan stannar eller vänder, och en ankrad båt med tre brusiga positioner i rad (3,2 kn).
  Dirigenten satte golvet till 4,5 kn, som skiljer en båt i marschfart från en som driver eller
  ligger för ankar (`4383fc6`).
- *Tredje varvet:* godkänt. Granskarens motfall ger byte för byte samma utfall som koden före, och
  en ankrad båt med en ensam utliggare (6,5 kn, 80 m mot bron) släpps inte vid 10, 30 eller 60 s
  mellan positionerna. Två låga anmärkningar infördes vid sammanslagningen.

**Mätningen.**
- *U41.* I banken och k1/k2 (30 719 positioner) rapporterar den snabbaste båten som korsar en bro
  10,6 kn. Över 12 kn finns bara fordonets två positioner, en enstaka spik hos PRICKBJORN (22,2 kn
  mitt i ett spår, k2) och ett enkelsampel på 13 kn i farleden. Varje gräns mellan cirka 13,5 och
  21,5 kn ger därför samma utfall där, och 15 kn är mittpunkten. Banken ändras i en korpus,
  20260713-41h; k1 och k2 är identiska.
- *N04.* I banken och k1/k2 finns 191 spärrade positioner. Ingen gick mot sista bron ens i 2 kn
  (17 hade kurs mot bron, alla i högst 0,8 kn), och ingen spärrad båt korsade sista bron tillbaka
  inom 30 min. Regeln släpper ingen där, och banken och fältkörningarna är bitlika. Nyttan vilar på
  syntetiska världar. För en återvändare i 9 kn kommer varningen för Stridsbergsbron 290, 272 och
  245 s före korsningen med positioner var 10:e, 30:e och 60:e sekund, mot 54, 94 och 154 s förut.
  Söderut kommer varningen för Klaffbron 247–415 s före i 5–9 kn, mot 166–370 s förut och ingen
  varning före korsningen i 9 kn. I 4,5–6 kn norrut är varningen oförändrad, men förvarningen för
  Stallbackabron kommer före korsningen i stället för som "passerade … under AIS-tystnad" 4–6 min
  efter. Med 180 s mellan positionerna norrut ändras ingenting.
- Av nattens 65 representanter försvann N04 r1; de övriga 64 gav samma utskrift som förut. Hela
  jest gav 400 sviter och 6 017 test, `replay:synthetic` 132 scenarier (femton nya) med 16 WARN-rader
  som förut, och standardjakten samma två kandidatkort som slutbatteriet i omgång 2.

**Omlåsningen (U13).** 20260713-41h. Notisen "Okänd båt närmar sig Stallbackabron, beräknad ankomst
strax" 13:17:01 utgår, och med den fordonets post i fördelningen: notiser 163 → 162. Golden-text
261 → 259:

| Tid | Före | Efter |
|---|---|---|
| 13:17:01 | "Två båtar på väg mot Klaffbron, beräknad broöppning strax; Två båtar på väg mot Stridsbergsbron, beräknad broöppning strax" | raden utgår |
| 13:19:30 | "Två båtar på väg mot Klaffbron, beräknad broöppning strax; En båt på väg mot Stridsbergsbron, beräknad broöppning strax" | "Två båtar på väg mot Klaffbron, beräknad broöppning strax" |
| 13:20:02 | "En båt på väg mot Klaffbron, ETA okänd; En båt på väg mot Stridsbergsbron, beräknad broöppning strax" | 13:19:32 "En båt på väg mot Klaffbron, ETA okänd" |
| 13:25:37 | "En båt på väg mot Klaffbron, ETA okänd; En båt på väg mot Stridsbergsbron, ETA okänd" | raden utgår |
| 13:30:49 | "En båt på väg mot Stridsbergsbron, ETA okänd" | "Inga båtar är i närheten av Klaffbron eller Stridsbergsbron" |

Mot positionerna: ELFKUNGEN, som hördes senast 12:54:22, hade 13:19:30 passerat båda målbroarna och
hörs 13:21:37 söder om Klaffbron, så ingen båt var på väg mot Stridsbergsbron. HEY JOE korsade
Klaffbron 13:17:07 och bokförs på positionen 13:19:32, och PILGRIM låg stilla cirka 300 m norr om
bron. 13:30:49 släpps PILGRIM ur texten. Då var ELFKUNGEN och HEY JOE söder om Olidebron (13:23:45
och 13:25:54) och FREE WILLY norr om Stallbackabron (13:23:39), och nästa båt, NENJA, hördes först
13:35:40. "Inga båtar" i 4 min 51 s är alltså rätt, där texten förut visade fordonet. De 52
öppningsvarningarna är oförändrade. Dirigentens radvisa diff mot positionerna och granskarens
oberoende radfacit gav samma dom.

#### 12.3.11 V1: verktygens orakel och register (`ea581ff`)

**Situationen.** Av nattjaktens 25 kort i omgång 2 var ungefär arton kort eller delar av kort
beslutat beteende som verktyget inte kände igen, eller mätfel i verktyget (11.9). Dessutom hade
förslagsskriptet för registrets radhänvisningar vid tre sammanslagningar lagt en hänvisning på
fel stycke medan kontrollen var grön: skriptet tog första träffen på postens nyckelord.

**Ändringen.** Bara `tests/replay-validation/` och `docs/BUGGJAKT.md`; appen är orörd.
- *Oraklen.* Ett ledarbyte där den förra båten har börjat en ny resa räknas som två båtars tider
  och inte som ett ETA-hopp (INV-3). "Inga båtar" mellan två texter räknas som blink bara när samma
  båt står i båda texterna (INV-14). En returnotis prövas mot U21. Konvojprovet följer den senaste
  bindningen, U15 och U2 (se granskningen). En varning efter passagen prövas mot U17-släppet, en
  varning på en gammal position godtas när båten korsar strax efter, och en köande båt som avgår
  osedd klassas enligt U38.
- *Registret.* Nya poster för U34 (LEDARBYTE-TYST-FRÄMSTA), U21 (U21-RETUR-EFTER-10-MIN), U39
  (U39-RETUR-EFTER-RADERING) och U43 (U43-DÖDBAND-I-U-SVÄNG, U43-PARBRO-FÖRE-U-SVÄNG), och vidgade
  predikat inom U1-C11, U6, U17, U18, U19, S10 och R2. Varje ny post har ett smalt predikat och ett
  motfall som ska ge kandidat.
- *Radhänvisningarna.* Skriptet väljer stycke på styckets text (en kontrollsumma per hänvisning),
  inte på nyckelordet. Ett stycke som skrivits om får inget förslag och rättas för hand, och en post
  kvitteras en i taget.

**Granskningen.** Två varv.
- *Första varvet:* ändringar krävs. Granskaren byggde mutanter av appen och visade att sju
  uppmjukningar gick att lura. Tydligast: med den andra varningen i en öppning bortkopplad fällde
  det gamla verktyget 1 361 utslag och det nya bara 714. Grenen "fysisk öppning" i konvojprovet
  dolde alltså en hel klass av verkliga fel. Den grenen, vidgningen av U25 och en del av R2 togs
  bort, och övriga uppmjukningar snävades (`7c09279`, `2ed4aac`).
- *Dirigentens beslut om konvojprovet (U2):* en senare bindning avslutar täckningen genom en
  öppning bara när båtens korsning ligger utanför öppningens fönster (tidigaste korsning plus
  600 s). Båten ska ha varit bunden till öppningen före korsningen, och öppningens varning ska ha
  gått före den. Kravet var att mutanten ovan skulle ligga kvar på basens nivå (`fff2470`).
- *Andra varvet:* godkänt. Mutanten ger 1 360 nya utslag mot basens 1 361; det enda som saknas är
  en värld som ändå syns som en miss i öppningsprovet. Granskaren byggde nya motfall mot var och en
  av de sju uppmjukningarna, prövade fönstret vid 590, 600, 601, 610 och 660 s (täckt bara vid
  590 s) och gav U43-posterna tolv motfall, alla med rätt utfall. Fem låga anmärkningar står i 12.5.

**Mätningen.** Nattjakten (20 000 världar) på verktygsgrenen, med appkoden från `f543190`:

| | Omgång 2 | Efter V1 |
|---|---|---|
| Kluster | 79 | 77 |
| Kandidatkluster | 28 | 19 |
| Kandidatutslag | 742 | 460 |

Mot omgång 2 finns tre nya kandidatutslag, alla sena U15-släpp som det gamla verktyget godtog
(12.5). Av de 37 utslag som beslutet om konvojprovet gällde blir 34 täckta av U2, och tre står kvar
som kandidater (världarna 18014, 2566 och 19724). Standardjakten gav två kandidatkluster, båda
INV-3. Lint var rent, hela jest gav 400 sviter och 6 073 test, och `replay:all`, `replay:synthetic`
och `replay:openings` var bitlika med koden före. Nattkörningen stördes en gång: två körningar skrev
i samma utkatalog. Granskaren kontrollerade rapporten mot 200 omkörda världar (122 av 122 utslag
lika), och slutbatteriets nattjakt (12.7) är en hel omkörning på den sammanslagna koden.

#### 12.3.12 N6 och U44: förvarning för en bro som båten redan passerat (`5f1eea9`, omlåsning `1e568f9`)

**Situationen.** Ett sidofynd ur granskningen av returnotiserna (12.3.8): 18 av 805 "närmar sig"-
notiser i banken och k1/k2 gick ut när båten redan låg mer än 10 m bortom brolinjen.
- *Nio nya båtar.* Båtens första position någonsin ligger 73–248 m efter Olidebron norrut eller
  Stallbackabron söderut, och hon går bort från bron i 4,8–6,9 kn. Hon fick "beräknad ankomst om
  1 minut" till en bro hon lämnar. SABETH fick i samma sekund "passerade Kanalinfarten under
  AIS-tystnad" och "närmar sig Olidebron, beräknad ankomst om 1 minut", 88 m efter Olidebron.
  Appens eget svep bedömde bron som passerad i samma ögonblick, men förvarningen gick först.
- *Sju båtar nära linjen.* Båten ligger 10–39 m bortom linjen, 3–11 s efter korsningen, och får
  "beräknad ankomst strax".
- *Två långsamma.* HALIFAX (1,1 kn, 194 m söder om Olidebron på väg söderut) och EUGENIE (1,9 kn,
  268 m norr om Klaffbron, ur gästhamnen) får "närmar sig" för en bro de rör sig bort från.
- *Följdfelet.* Brobesöket fick fel bortre sida, så att en senare vändning gav falska
  returnotiser: 48 i granskarens svep med 120 s mellan positionerna.

**Ändringen.**
- *Passagenotis för en ny båt.* En ny båt mer än 70 m bortom en bro som inte är hennes målbro, på
  väg bort i minst 2 kn och inte från en känd kajplats, får en passagenotis. Meningen följer
  formregeln i U37 del 2, med tystnaden räknad som okänd och korsningen skattad som avståndet bortom
  linjen delat med farten: högst 60 s efter korsningen "har precis passerat", annars "passerade …
  under AIS-tystnad". Inom 70 m står "närmar sig … strax" kvar.
- *Bortre sidan.* När förvarningen går ut på en position entydigt bortom linjen i färdriktningen är
  båtens egen sida den bortre. Bron räknas som bakom båten bara när farten är minst 2 kn
  (`RETURN_SPARSE_MOVING_SOG_KN`) eller föregående position låg entydigt på andra sidan linjen.
  Sidan räknas som sedd först vid nästa position där, så att en väntande båt med en brusposition
  bortom linjen inte kan få en returnotis.

**Granskningen.** Två varv.
- *Första varvet:* passagenotisen godkändes. Granskaren fann ingen stillaliggande position 75–400 m
  norr om Olidebron eller söder om Stallbackabron i hela banken och k1/k2, alltså ingen kaj som
  kunde förklara att någon av de nio aldrig korsade. Bortre sidan underkändes: en båt som driver
  långsamt (0,8–1,5 kn) bort från bron på tillfartssidan och sedan passerar fick två notiser för en
  passage, i 44 av 60 byggda världar och 0 på koden före. HALIFAX var just det fallet, och hennes
  extra notis var inte belagd som rättare. Vakten ovan lades till (`d35a8c8`), och dirigenten
  beslöt att meningen ska följa formregeln (`8ee92e6`, U44).
- *Andra varvet:* båda godkända. Driftfallen ger koden föres utfall (0 av 60 vid täta och 0 av 20
  vid glesa positioner), liksom granskarens utliggarsvep (0 av 1 200). Alla mutanter av vakten och
  formregeln fälls av testen. Två låga anmärkningar står som kända gränser (12.5).

**Mätningen.** I banken ändras nio notisrader i fyra korpusar, alla i klassen nya båtar; inga
notiser tillkommer eller försvinner. Öppningsvarningar, brotexter, passager, k1 och k2 är
oförändrade, och HALIFAX har samma utfall som förut. I granskarens svep går de falska returerna
vid 120 s från 48 till 0 (och från 18 till 0 i ett andra svep), och banorna utan returnotis från 153
till 105; ingen bana blir sämre, och övriga kadenser 10–180 s är identiska med koden före. Av
nattens 65 representanter ändrades ingen. Hela jest gav 408 sviter, och `replay:synthetic` 139
scenarier (sex nya) med 16 WARN-rader som förut.

**Omlåsningen (U13).** 20260712-25h: fyra notiser byter mening, eta 1 → −1 och markeringen "redan
passerad". Tid, bro, riktning, avstånd och antal är oförändrade.

| Tid | Båt | Position | Skattad korsning före notisen | Ny mening |
|---|---|---|---|---|
| 07:35:45 | 219031624 | 142 m norr om Olidebron, 5,6 kn | 49 s | "har precis passerat Olidebron" |
| 08:17:46 | 265806230 | 229 m söder om Stallbackabron, 6,6 kn | 67 s | "passerade Stallbackabron under AIS-tystnad" |
| 13:33:57 | MARJELCHE | 115 m söder om Stallbackabron, 6,1 kn | 37 s | "har precis passerat Stallbackabron" |
| 15:13:40 | 265013440 | 187 m söder om Stallbackabron, 6,9 kn | 53 s | "har precis passerat Stallbackabron" |

Alla fyra är båtens första position i korpusen, och nästa position ligger 410–1 350 m längre bort
från bron. De fem övriga raderna ligger i korpusar utan låst händelsefacit: SABETH (31 s) "har
precis passerat Olidebron", 211597910 (67 s) "passerade Olidebron under AIS-tystnad", och vid
Stallbackabron NORFJELL (23 s) och NENJA (23 s) "har precis passerat" och NEST (86 s) "passerade …
under AIS-tystnad". Dirigentens egen räkning mot positionerna, rättarens tabell och granskarens
radfacit gav samma dröjsmål på alla nio.

### 12.4 Det som inte gick in, och varför

**K3 fel 1: notisen för en retur efter radering (N14 r1).** Nattvärld 2263: QUEST får "passerade
Stridsbergsbron under AIS-tystnad" norrut 09:05. I ett glapp på 366 s raderas hon och föds om 708 m
bort, utan resminne. Sydpassagerna av Stridsbergsbron och Järnvägsbron bokförs 09:33:05 och
Olidebron 09:42:52, alla via failsafen, och 60-minutersregeln för riktningsbyte stoppar alla tre
notiserna (posterna var 28 och 38 min gamla). Regeln finns för AKIRA-klassen i 20260708-21h, där
en notis med fel riktningsetikett gav en dubbelnotis. Rättningen sparade passagens sida i
spärrposten och släppte en retur när båten nu ligger entydigt på andra sidan av brolinjen.
- *Första varvet:* en enda GPS-utliggare efter en återfödelse skapade en "bevisad" sida, och när
  båten hördes igen på rätt plats släpptes en tredje falsk notis som koden före stoppade. Rättaren
  hade beskrivit restrisken som "två samtidiga fel"; ett räckte. Rättaren lade till att sidan ska
  ses i en senare rapport och att posten ska vara minst 15 min gammal (`RETURN_ACROSS_MIN_AGE_MS`).
- *Andra varvet:* granskaren prövade det omvända, en utliggare som nu-position 15–60 min efter en
  bekräftad verklig passage. Den gav två falska notiser vid målbron (3 mot basens 1 för
  Stridsbergsbron). I QUEST är den första fixen efter glappet på andra sidan just det som utlöser
  notisen, och en ensam utliggare ger exakt samma data i samma ögonblick.

Felet syns i 1 värld av 20 000 och aldrig i banken eller k1/k2: 60-minutersspärren slår inte till
en enda gång där. Bland 30 817 fixar i banken och k1/k2 finns 15 ensamma utliggare, varav en över en
brolinje, och ingen sekvens med två felaktiga positioner i följd. Varje ny vakt tog bort ett byggt
fall och lämnade ett annat, och granskaren rekommenderade att bara ta in fel 2. Rättningen är
struken, och beteendet är en känd gräns enligt U39.

**K2:s första version: händelsens referens flyttad bakåt.** Den flyttade öppningens första passage
till den tidigaste korsningen och lade till golv för att hålla kvar redan absorberade båtar.
- *Första varvet (hög):* en ny båt som korsningsankarets golv tog efter flytten, och som sedan
  väntade vid bron, fick ingen varning där koden före varnade henne 236 s före korsningen. Rättat
  med en ny väg (`_movedEventHost`).
- *Andra varvet:* en U15-retur förlorade sin egen varning (koden före varnade 19 och 39 s före).
  I granskarens svep med en annan händelse vid bron (2 016 lägen) gav versionen 94 avvikelser,
  varav 28 senare varningar för en båt bakom en nysläppt båt: 4–276 s ledtid mot 304–864 s.
  Granskaren konstaterade att båda varvens fel låg i
  samspelet mellan den flyttade referensen och befintliga specialvägar (golvet, U15, en annan
  händelse), och att varje ny del behövdes för att laga följden av en tidigare.

Granskaren föreslog en variant på nio rader som bara ändrar om en ny båt hör till händelsen och som
gav noll avvikelser i alla granskarens svep. Dirigenten valde den (12.3.5, U42). Grenen `omg3/K2`
sparas som referens.

**Parbron inom 70 m (N10 r3).** Utredarens förslag gjorde fältfallet bakom FIX U fel (12.3.6). Den
enda väg som inte rör fältfallet är att bokföra parbron i efterhand när nästa fix visar vändningen,
med en "passerade … under AIS-tystnad" fem minuter efter korsningen. Den kräver en ny
bokföringsväg och möter journey-reset, U36 och U37. Rättaren bedömde den som svårare att lita på
än felet (1 värld av 20 000) och byggde den inte. Känd gräns enligt U43.

**Besluten som behöll dagens beteende.**
- U34 (F21): texten när den främsta båten tystnat. Registerposten LEDARBYTE-TYST-FRÄMSTA hör till V1.
- U35 (F22, F23): långsam drift under U30 och gränsen 25 min i U29.
- U38 (F26): reservvarningen för en tyst båt i kö behåller 5 min.

Skälen står i 12.2 och underlaget i 11.5 och 11.9.

### 12.5 Kända gränser och uppföljning

**Kända gränser som ändringarna medför eller lämnar kvar.**
- **U32: ökning följd av kö.** En båt som ökar i gång till minst 2,8 kn och sedan stannar i kö före
  Järnvägsbron går inte att skilja från LIDAN-formen i ögonblicket. Konstruerat (2 → 3 → 3,5 kn, kö
  10 min 150 m före bron) kommer varningen 907 s före korsningen i stället för 105 s; en ökning till
  exakt 2,8 kn följd av samma kö 833 s mot 119 s (11.5). Fallen är låsta i
  `opening-accel-motfall`. Buggjägaren genererar aldrig mönstret, så att den är tyst säger inget.
- **U33: tre sämre påståenden** (HELGE, CAVA, WILSON ALSTER, 12.3.7). Dessutom tre kända gränser ur
  andra granskningsvarvet: en ensam fartspik i notisens position ger "om 1" när båten behöver
  cirka 2,8 min (7 av 27 konstruerade fall, 0 i banken och fältet; ett skydd kräver farten räknad
  ur positionerna, och de två prövade skydden ändrade också verkliga accelerationer ur väntan); korta
  restider avrundas ofta för lågt (SYLVIA "om 1" mot 1,57; i svepet hade 11 av 59 "om 1" en sanning
  över 2 min); och en båt som stannar tvärt efter notisen får "om 1" eller "om 2" mot 5–22 min.
  Motsägelsen står kvar i 65 fall i banken, där fart- eller inbromsningsvillkoret spärrar, där en
  annan båt driver "strax" eller där restiden avrundas till 3.
- **U37 del 1.** En fix på brolinjen (±10 m) vid tät kadens släpps först vid nästa position, nu med
  tystnadsform om den kommer sent. Taket på 15 m skjuter upp direktsläppet när AIS-farten ligger
  15–30 % under den verkliga.
- **U37 del 2.** En båt som stannat efter bron och gått vidare, med en tystnad som täcker både
  korsningen och stoppet, får för litet dröjsmål och kan få "har precis passerat" om en gammal
  passage. 18 av bankens 1 006 korsningar stannar inom 300 m efter linjen och går vidare, nästan
  alla vid Stridsbergsbron. En sparad position utan `fixTs` (äldre kod, högst 6 h efter
  uppgradering) ger tystnadsformen efter en tystnad.
- **U36.** En båt vars kurs tillfälligt pekar fel med över 2 kn i Fix D:s band utan att ha vänt
  förlorar en riktig, kanske färsk, svepnotis. Ingen sådan i banken.
- **U40 och K1: positionsutliggare med fart 0.** En fix med fart 0 mer än 60 m bortom en korsad
  brolinje, med snittfart upp till 1,1 gånger startfarten, bokförs som passage även när den är en
  utliggare, hos en båt som stannat strax före bron eller hos en båt som går vidare (då uteblir
  "närmar sig"). I motfallsbandet gäller det 10 lägen med positionsfel 95–180 m; inget sådant finns
  i banken eller fältet. En fartspik på startpositionen (9 kn rapporterat när båten går i 3 kn) gör
  kvoten tandlös; fartspikar finns i 11 av 4 172 positioner, men felet kräver dessutom
  positionsavvikelsen. 17 av K1:s 28 lägen i band C (kvot 1,12–1,99) är sena som förut, och stopp
  20–40 m bortom bron bokförs inte på stillafixen.
- **K3: linjeprovet.** Den omvända kilen (förbi linjen men inte förbi latituden) bokförs i svepet
  först vid nästa fix. Brolinjen förlängs rakt, så för en sändare utanför farleden avgör linjen på
  hundratals meters avstånd.
- **U39.** En verklig retur som bokförs via failsafen inom 60 min efter en notis i passerad form,
  när båten raderats eller appen startats om däremellan, får ingen notis (12.4).
- **U42.** En båt som absorberades innan den tidigare korsningen bokfördes släpps inte av den, som
  före rättningen. En för tidig skattning av den tidigare korsningen (rät linje över ett glapp där
  båten saktade in osedd) kan ge en ny båt en andra varning. Bakkanten släpper en väntande båt
  strax bortom ett konvojfönster med 24–44 s ledtid (korsning 600–620 s efter föregående båt); det
  gäller alla öppningar, före och efter K2, och om den ska ha ett golv är en egen fråga.
- **U43.** Dödbandet bryter vändningens kedja i tre av N12:s nio världar, och två till hade bara en
  omvänd position före varningen. Parbron inom 70 m (12.3.6).
- **U41.** (a) En verklig båt i minst 15 kn skapas först när hon saktar in under 15 kn. I
  granskningens prov sjönk varningens ledtid från 276 till 156 s söderifrån mot Klaffbron (16 kn
  från Olidebron, inbromsning 400 m före bron) och från 404 till 194 s norrifrån mot
  Stridsbergsbron, och förvarningarna för broarna före blev "passerade … under AIS-tystnad". En båt
  som håller 16 kn hela vägen syns inte alls. Ingen sådan båt finns i banken eller fältet. (b) "En
  båt som redan följs" gäller bara tills appen raderar henne: efter en omstart eller en radering
  prövas hon som ny sändare. (c) Ett fordon som först rapporterar under 15 kn visas som båt. Att ta
  bort en redan följd sändare är inte byggt: borttagningen går genom skyddszonen vid broarna,
  notiserna vid borttagning och öppningstjänstens kvarvarande varningar, och kräver en egen
  granskad ändring.
- **Återvändaren (N04).** En båt som går mot sista bron i minst 4,5 kn, kommer 100 m närmare och
  sedan vänder ut eller stannar släpps och får en förvarning. I provet (5 kn från 430 till 250 m
  bortom Stallbackabron) kom "närmar sig Stallbackabron, beräknad ankomst om 2 minuter". Vänder hon
  ut står hon 1,5 min i texten. Stannar hon står hon i texten i cirka 40 min och får en
  öppningsvarning för Stridsbergsbron, samma slags utfall som för en ny båt som kommer norrifrån och
  stannar 250 m före bron. En återvändare under 4,5 kn syns först när spärren löpt ut, som förut.
  Med 180 s mellan positionerna norrut hjälper regeln inte.
- **U44: förvarning för en bro bakom båten.** Inom 70 m från bron står "närmar sig … strax" kvar
  3–11 s efter korsningen (sju rader i banken). En båt som först hörs bortom en bro och rör sig
  bort i under 2 kn får förvarningen som förut (HALIFAX och EUGENIE); med granskarens prövade regel
  får HALIFAX en enda notis, "närmar sig Olidebron, beräknad ankomst om 1 minut" norrut 68 s före
  korsningen, och EUGENIEs falska Klaffbronotis försvinner. Gränsen 2 kn är skarp: en båt som rör
  sig bort från bron i 2,1 kn och sedan går igenom fick två notiser för en passage i 12 av 20
  byggda världar (0 av 20 i 1,9 kn). Gränsen 70 m mäts mot brons punkt, inte längs kanalen. En ny
  båt som lägger ut i minst 2 kn från en kajplats appen inte känner till, bortom en bro, får
  "passerade" om en bro hon aldrig korsat; förut fick hon en lika osann förvarning. Vakten litar på
  föregående position också när den är en utliggare. Inget av fallen finns i banken utom de sju
  raderna och de två långsamma båtarna.
- **U38: reservvarningen för en tyst båt i kö.** Låg båten kvar kommer varningen 24–39 min före
  passagen (tre världar); avgick hon just när strömmen bröts kom den 12 s efter passagen (en värld)
  (11.9).

**Uppföljning.**
- **Sent U15-släpp (nattvärld 18014, felfri radio).** Båten 265424264 korsar Klaffbron norrut
  12:12:49, vänder 12:18:53 och absorberas 12:20:02 i Klaffbron#6, som varnat 12:15:12. När
  händelsens första passage bokförs 12:22:50 flyttas referensen från prognosen (cirka 12:22:58) till
  passagen (12:22:31), som då ligger 582 s från hennes passage och inom U15 (b). Hon släpps och får
  en egen varning 36 s före sin korsning 12:23:26. Öppningen var varnad 11 min i förväg, så skadan är
  liten. Världarna 2566 och 19724 har enligt V1:s rättare samma mönster. Syntes först när V1:s
  orakel slutade godta utslaget.
- **`distance_fallback` efter en spärrad brusposition (K1-granskningen).** En båt stannar 30 eller
  60 m före bron, och första stillafixen hamnar 50–120 m bortom linjen. På nästa fix, när båten
  ligger 30–60 m före bron, bokförs passagen ändå (`distance_fallback`, konfidens 0,50): segmentet
  från brusfixen till den riktiga fixen korsar linjen mot färdriktningen. Målbron byter, och
  brotexten säger "väntar vid Järnvägsbron" medan båten ligger vid Stridsbergsbron. Det gäller 64
  av 64 lägen i K1:s motfallsband, före och efter K1. Eget kort, inte rättat.
- **Öppningstjänstens latitudprov.** `_bridgeIsBehind`, `_bridgeBehindArm` och `_crossingEstimate`
  dömer fortfarande på brons latitud, inte på den sneda brolinjen. Granskaren av K3 byggde 24 fall i
  kilen (hopp, väntan 15 eller 30 min, ny båt i kilen) och fick samma öppningsvarningar som utan kil.
  Ingen synlig följd hittad; inkonsekvensen finns i koden och är värd en egen granskning.
- **U36 för scenario B.** En båt som hörs igen efter 17–30 min utan att ha raderats, nettoförflyttad
  förbi en bro men på väg tillbaka, kan få samma gamla svepnotis. Dirigenten beslöt att mäta det i
  en nattjakt först; i banken finns inget fall.
- **Spärren bortkopplad utan utslag (V1-granskningen, M4).** Verktygets uppmjukning för KAJVOBBEL
  kräver bara att båten låg i kö och korsade inom 120 min, inte att varningen var reservens. Med
  spärren bortkopplad som mutation varnades en kövärld 76 min före korsningen utan utslag, varken
  med V1:s verktyg eller med det gamla. Granskarens förslag: kräv att varningen kom efter sista fixen
  plus STALE_SOFT, och ta den gamla luckan som eget kort.
- **Reservvarningen för köande båtar (U38).** 5 min gäller tills fältet visar något av felen
  (11.9). Utfallen 24–39 min för tidigt och 12 s efter passagen är bara sedda i världar.
- **Kostnaden i U32.** Godtas tills fältet visar den: en ökning till minst 2,8 kn följd av kö före
  Järnvägsbron ger en varning cirka 14 min för tidigt. Inget sådant fall finns i rådatan.
- **De tre sämre notiserna i U33.** För HELGE och CAVA ligger felet i texten, som sa "strax" för
  tidigt; notisen följer den. WILSON ALSTER följer restidens osäkerhet: båten gick långsammare de
  sista 300 m än momentanfarten sa.
- **De långsamma båtarna bortom en bro (U44).** Regeln som skjuter upp notisen för en båt som rör
  sig bort i under 2 kn är prövad av granskaren i banken och i 80 byggda världar, men inte för en
  båt som korsar utan någon position i fart emellan. Kandidat till nästa omgång.
- **Verktygen (V1-granskningens låga anmärkningar).** Inget lås hindrar två jakter i samma
  utkatalog. Undantaget i konvojprovet når också registrets U25-post, utan att ändra något utfall.
  Fönstrets gräns vid exakt 600 s är i praktiken exklusiv. Provet för en sen returnotis litar på
  appens egen uppgift om förseningen.

### 12.6 Lärdomar

Tillägg till 11.7.
- **Mer än hälften föll i första varvet.** Av elva granskade ändringar godkändes fyra direkt: K1,
  K3:s brolinjeprov, N3 och U40. Sju fick krav på ändring: K3:s returspärr, K2, U33, U37 del 1,
  återvändaren i N5, verktygen i V1 och bortre sidan i N6. Två av dem (K3:s returspärr och K2:s
  första version) underkändes två gånger och togs inte in, och återvändaren underkändes två gånger
  innan fartgolvet 4,5 kn höll. U31 och U32 granskades i omgång 2.
- **En enda felaktig position, eller en båt som driver, fällde mest.** K3:s returspärr föll två
  gånger på en ensam utliggare, och U37 del 1 föll två gånger på samma klass vid två olika kadenser.
  Återvändaren och bortre sidan i N6 föll på båtar som driver eller ligger för ankar i 1–3,5 kn:
  rättarna prövade båtar i marschfart och stilla båtar, inte farterna däremellan. U40:s falska
  fall krävde positionsfel på 110–300 m. N2:s rättare hade i sitt svep jämnt brus (±3 och ±10 m)
  men ingen enstaka utliggare, och K3:s rättare prövade bara utliggare som skapar den sparade
  sidan, inte en utliggare som nu-position. Fältdata har sådana utliggare men sällan: 15 ensamma
  på 30 817 fixar, ingen sekvens med två.
- **Den enkla varianten vann.** K2:s första version byggde en flyttad referens och lade sedan till
  vägar för följderna: golvet, en egen värdväg och en rättning för U15. Varje granskningsvarv hittade
  ett nytt fel i samspelet. Varianten på nio rader, som bara ändrar ett beslut, tog bort samma
  nattfynd och gav noll avvikelser i 14 403 lägen.
- **Jämför med rätt bas.** K2b:s "senare" varningar i följdfallet var appens vanliga beteende när
  bokföringarna kommer i rätt ordning. Rättaren jämförde med koden före i fel ordning, alltså med
  felet. Först jämförelsen med samma trafik i rätt ordning visade att följdfallet inte är en
  försämring.
- **Pröva rättarens restriskbeskrivning.** K3:s rättare skrev "två samtidiga fel"; ett räckte. K1:s
  rättare räknade 48 av 64 lägen med falsk passage på basen; det var 64 av 64. Det hör till samma
  familj som "0 undantag" i 11.7.
- **Nyttan syns sällan i banken.** K1, K2b, N3 och U40, och i N2 både U36 och U37 del 1, ändrar
  ingenting i banken eller fältkörningarna. Deras nytta vilar på syntetiska världar, och granskarna
  sade det uttryckligen. Det som ändrar banken (U31, U32, U33, U37 del 2 och K3:s 41h) låstes om rad
  för rad mot rådatan.
- **En rättning som inte kan skilja fallen i beslutsögonblicket ska inte in.** Det bekräftades två
  gånger: K3:s returspärr (en retur och en utliggare ger samma data när notisen ska skickas) och
  parbron (13 m mot 23 m bortom linjen på samma fix).
- **Ett orakel som mjukas upp ska prövas med mutanter.** V1:s första leverans gav färre kort, men
  dolde samtidigt nästan hälften av de utslag som en bortkopplad andra varning ger (714 mot
  1 361). Det syntes först när granskaren byggde mutanter av appen. Varje uppmjukning har nu ett
  motfall som ska ge kandidat.
- **Två spår kan krocka utan att något av dem har fel.** Verktygens kontroll av att registrets
  källor finns föll när N6 gav en funktion ett anrop som standardvärde. Felet låg i kontrollens
  mönster och syntes först vid sammanslagningen, så berörda sviter körs efter varje sammanslagning,
  inte bara på grenarna.

### 12.7 Slutbatteriet

Kört 2026-11-17 på `d6e4d94`, sammanslagningsgrenens sista commit före det här avsnittet.

| Steg | Utfall |
|---|---|
| Lint | rent |
| Hela jest | 415 sviter gröna: 6 527 test, 2 överhoppade (omgång 2: 395 sviter, 5 919 test) |
| `replay:all`, utan och med monitoring | grönt på 25 korpusar; 17 WARN-rader, som baslinjen |
| `replay:synthetic` | 156 scenarier rena; 16 WARN-rader (baslinjen i VALIDATION) |
| `replay:openings` | grönt; 0 oklassade missar, 37 varningar med okänd ordning mot passagen, som förut |
| Soak och `replay:monitoring` (72 h) | stabila, 0 processfel |
| `measure:eta` | 3 188 påståenden, 2 289 mätta; median 1,31 min (omgång 2: 1,37), p90 20,28 min (oförändrat); notiserna median 0,39 min (0,42), öppningskorten 1,37 min (1,69) |
| Fassvepet, utan och med monitoring | OK på 25 korpusar, inget odokumenterat fasberoende |
| `hunt:selftest` | grönt |
| `hunt:quick` (300 världar) | 2 kandidatkort |
| `npm run hunt` (2 000 världar) | 217 utslag i sanningsspåret, 2 kandidatkort; bankspåret 170 av 175 fasvarianter rena, 0 kandidatkluster |
| `hunt:night` (20 000 världar) | 2 540 utslag i sanningsspåret, 16 kandidatkluster och 16 kort (omgång 2: 2 571, 28 och 25); bankspåret 636 av 650 fasvarianter rena, 0 kandidatkluster |

Arbetsträdet var orört efter batteriet, före och efter nattjakten. Fasvarianterna som inte är rena
hör till ett kluster som redan har en registerpost. Standardjaktens två kort är samma klasser som
i 11.8: INV-3 ETA-OSCILLATION och INV-3 ETA-SÅGTAND UPP.

**Nattjaktens kort.** 16 kort: 5 med felfri radio, 5 med fältlik radio och 6 under stress. Inget
är nytt för omgången. Nattjakten kör samma 20 000 världar som i 11.8, så utslagen går att jämföra
värld för värld: vart och ett av de 439 kandidatutslagen (742 i 11.8) fanns före omgången i samma
värld, i samma klass, vid samma bro och för samma båt. Tre av dem låg då under en registerpost
och är de sena U15-släppen i 12.5 (världarna 18014, 2566 och 19724).
Korten nedan har körningens egna nummer F01–F16; de är inte ägarfrågor.

| Kort i den här körningen | Klass | Kandidatutslag | Kort i 11.8 och 11.9 |
|---|---|---|---|
| F01, F12 | INV-3 ETA-SÅGTAND UPP | 150 + 16 | N01, N20 |
| F03, F11 | INV-3 ETA-OSCILLATION | 132 + 16 | N03, N21 |
| F02 | Sann målbropassage utan öppningsvarning | 43 | N02 (42) och ett sent U15-släpp |
| F04, F13 | Öppningsvarning med för kort ledtid | 34 + 3 | N04 (32), N22 (3) och två sena U15-släpp |
| F05, F15 | Öppningsvarning efter sann passage | 23 + 1 | N06, N25 |
| F06 | INV-13 målbro som mellanbro | 5 | N09 |
| F07 | INV-14 DEFAULT-FLASH | 7 | N05 |
| F08, F16 | Öppningsvarning på fruset fix | 4 + 1 | N11 och ett utslag utan eget kort |
| F09 | Fantomvarning utan avbrott i sanningen | 2 | N07 |
| F10 | Riktning som motsäger sanningen | 1 | N12 |
| F14 | Utebliven notis vid ett observerat besök | 1 | ett utslag utan eget kort |

Åtta klasser från 11.8 ger inget kandidatutslag längre: INV-11 DISTANS, INV-2 NOTIS-DUBBLETT,
INV-5 MISSAD MÅLBRO-NOTIS, INV-7 SEN MÅLBRO-NOTIS, INV-10 STRAX-ZOMBIE, en registrerad
målbropassage utan sann korsning, en sann passage som inte registrerades och fantomvarningen av
KAJVOBBEL-slaget. Minskningen har två källor: rättningarna i appen, och att verktygens orakel och
register nu känner de fattade besluten (12.3.11). Verktygsgrenens egen nattjakt, med V1:s verktyg
på appkoden `f543190`, gav 19 kandidatkluster och 460 kandidatutslag.

De 16 korten visar äldre egenskaper, triagerade i 11.9. De förs till nästa omgång tillsammans med
uppföljningen i 12.5.

**Sena säkerhetsvarningar (U17) är vanligare i världarna än 11.8 visade.** Nattjakten räknar nu
665 varningar som kom efter att en tyst båt redan gått igenom den gemensamma öppningen, mot 492 i
11.8. Ökningen kommer från verktyget, inte från appen: oraklet ser sedan V1 längre bakåt än tio
minuter efter båtens korsning. Standardjakten visar det: 40 sådana utslag med de gamla verktygen
på appkoden `56762d0`, 53 med V1:s verktyg på `f543190` och 53 i slutbatteriet. Varningen är
beslutad (U17: ingen öppning får missas), och i världarna kommer den ungefär en gång per 90
simulerade timmar. Fältet får visa hur ofta den kommer i kanalen.

## 13. Omgång 4: 17 november 2026

Tillagt 2026-11-17. Ägaren frågade efter omgång 3 om inte de kända felen borde rättas före nästa
fältprov. Omgången prövade därför varje känt fel som såg ut att ha en säker rättning, och gick
dessutom igenom de utslag i nattjakten som låg bakom registerposter och kort (12.7). Den utgick
från `6fad291` och slogs ihop på grenen `omg4/integration`. Arbetsformen var densamma som i omgång
2 och 3: en rättare per spår i en egen arbetskopia, en oberoende granskare som mätte själv, och en
dirigent som slog samman och låste om facit enligt U13 efter en egen radvis jämförelse mot
rådatan. Beteendebesluten fattade dirigenten på ägarens uppdrag (12.2); ägaren kan ändra vart och
ett. Alla tider är UTC; tiderna i nattjaktens världar är syntetiska.

Det viktigaste utfallet är att granskningarna fällde mer än de släppte igenom. Tre ändringar gick
in (U45, U46 och U51). Fyra rättningar och verktygsspåret fälldes eller sköts upp, alla med ett
prövat förslag sparat till nästa försök. Regeln i omgången var: en rättning som är svårare att
lita på än felet ska inte in.

### 13.1 Översikt

| Spår | Vad | Utfall | Commits / gren |
|---|---|---|---|
| R1 | Genomgång av registrets poster "känt fall med öppet beslut" och O1 (över 800 utslag om utebliven eller sen öppningsvarning) | utredning; gav U45 och belägg för U2 upp till 445 s | – |
| T1 | Triage av nattjaktens 314 kandidatutslag om restiden i texten | utredning; inga äkta fel (198 beslutat beteende, 106 mätfel i verktyget, 10 under U50) | – |
| T2 | Triage av nattjaktens övriga 125 kandidatutslag | utredning; tre äkta fel (U48 i två delar, U49), resten beslutat beteende eller mätfel | – |
| D5 (U45) | En annan båts passage förbrukar den varnade öppningen | inne, godkänd i tredje granskningen; sex korpusar omlåsta | `db3c2ff`, `cd1fe6c`, `e00ce55`; `6eb2533`; `ae586a1` |
| D6 (U46) | En båt som lämnar kanalen vid en ytterpunkt avslutar sitt besök | inne, godkänd i första granskningen (testen kompletterade i andra) | `709eccd`, `3f71f51`; `bb83ec2` |
| D6 (U51) | En båt som legat förtöjd minst 2 h vid en ytterpunkt får en notis när hon lägger ut | inne, godkänd i andra granskningen; tre korpusar omlåsta | `d222ed0`, `d122103`; `bb83ec2`; `e068249` |
| D1 | Falsk passage bakåt över brolinjen efter en osäker position | inte införd, underkänd två gånger; känd gräns | `omg4/D1` |
| D3 | Förvarning för en långsam båt bortom en bro (U44 punkt 3) | inte införd, underkänd två gånger; känd gräns som förut | `omg4/D3` |
| D8, del A (U48) | Riktning ur förflyttningen för en båt i fart med osäker kurs | inte införd: utfallen i verklig data blev sämre | `omg4/D8` |
| D8, del B | En bekräftad vändning ger målbro direkt även vid osäker kurs | inte införd, underkänd i första granskningen | `omg4/D8B` |
| D9 (U49) | En båt i fart vid brolinjen när konvojens täckning löper ut | byggd men inte granskad; väntar | `omg4/D9` |
| D2 (U47) | Sent släpp av en returbåt vid konvojfönstrets kant | ingen kodändring; känd gräns | – |
| D4 | Öppningstjänstens latitudprov mot brolinjen | ingen kodändring; provet står kvar | – |
| E1, E2 | Mätning av restidens eftersläpning och av en åldrad utjämning | ingen kodändring; egen ETA-etapp efter fältprovet | – |
| V2 | Buggjägarens register och orakel lär sig besluten bakom nattjaktens utslag | inte införd, underkänd: verktyget blev blint för byggda fel | `omg4/V2` |

Grenarna i högerkolumnen utan commit i `main` fördes inte in. De finns bara i dirigentens
arbetskopior, så hänvisningarna går inte att följa i repot.

### 13.2 Besluten U45–U51

- **U45. En annan båts passage förbrukar den varnade öppningen.** Har en båt som inte hör till
  den varnade öppningen gått igenom bron efter varningen, får en varnad båt som kommer mer än
  fönstrets längd (600 s) senare en ny varning. Hon släpps bara när appen i samma ögonblick hade
  varnat henne som en ny båt: på hennes egen position efter fönstrets slut, i minst 2 kn, utanför
  väntzonen 350 m och inte hållen av en tidigare bros spärr. Skäl: bron har bevisligen öppnats och
  stängts emellan, och en missad öppning är värre än en varning för mycket. Infört (13.3).
- **U46. En båt som lämnar kanalen vid en ytterpunkt har avslutat sitt besök.** En utåtriktad
  transit vid Kanalinfarten eller Stallbackabron (yttre sidan, minst 50 m utåt längs kanalaxeln,
  minst 2 kn), bekräftad av att nästa position kommer minst 10 min senare, räknas som utfärd. Skäl:
  användaren ska få notisen när båten kommer in i kanalen igen. Infört (13.3).
- **U47. En returbåt vid konvojfönstrets kant behåller dagens regel.** Sex varianter mättes i
  8 748 byggda lägen. De som rättade fallet tog bort 212–552 returvarningar som i dag kommer i tid,
  och de som inte kostade något rättade inte fallet. Känd gräns (13.5).
- **U48. En båt i fart med osäker kurs får sin riktning ur förflyttningen.** Beslutet står kvar i
  sak men genomförs inte före fältprovet: båda delarna gjorde utfallen sämre eller fälldes (13.4).
- **U49. En båt i fart vid brolinjen räknas som framme enligt fysiken.** Beslutet löd först att
  täckningskravet i under-bro-hållet skulle tas bort. Rättaren visade att det hade hållit krypande
  och väntande båtar utan varning för gott (88 800 uteblivna varningar i ett rutnät på 230 400
  fall, varav 19 680 för båtar som gick igenom). Beslutet läses därför så: för en båt i minst 2 kn
  mäts ankomsten med den tidigare av appens prognos och avståndet delat med farten. Byggt, inte
  granskat (13.4).
- **U50. Texten visar båtens restid tills en vändning är bekräftad.** Dagens beteende behålls, på
  samma grund som U19: appen kan inte veta att båten vänt förrän vändningen är belagd.
- **U51. En båt som legat förtöjd minst 2 h vid en ytterpunkt får en notis när hon lägger ut.**
  Förtöjningen ska vara belagd med stilla positioner (tystnad räknas inte), och avgången med fart
  mot punktens linje. Regeln gäller bara Kanalinfarten och Stallbackabron: vid broarna hade den
  gett tillbaka en enda notis i hela banken, just den som besöksregeln 2026-09-07 tog bort. En båt
  som redan ligger förbi linjen när notisen går får "har passerat", aldrig en förvarning med
  minuttal. Beslutet vänder låsningen av DIANA från 2026-09-09 (13.3). Infört.

Nästa lediga nummer är U52.

### 13.3 Det som gick in

**U45, den missade öppningen (D5).** *Situationen* (20260710-13h): Klaffbron varnar för DELFIN
10:52:11 och för ANTARES 10:58:04. COMETOGETHER, som inte hör till de varningarna, går igenom
norrut 11:00:39. DELFIN och ANTARES ligger sedan stilla 1,3 km norr om bron och går igenom runt
11:38 utan någon ny varning. *Orsaken:* en båt som var med i varningen när den gick ut hade ingen
väg ut ur händelsen (H29), och appens spärr mot dubbla kort hade dessutom tystat en ny varning som
samma ankomst. *Rättningen* (`lib/services/BridgeOpeningService.js`, `app.js`): den första
passagen efter varningen av en båt utanför händelsen sparas i egna fält (händelsens egen referens
och täckningsslut rörs inte), en egen släppdom prövas på båtens position efter fönstrets slut, och
kortet för en släppt båt bär en märkning som låter appen släppa den gamla spärren.

Vägen dit tog tre varv. Första versionen släppte på tick och prognos och gav varningar 17 s före
och 8 s efter passagen samt ett utfall i verklig data som berodde på klockans fas. Andra varvet
stramade åt släppet till villkoren i U45. Granskningen av det fann att märkningen följde med när
den släppta båten togs upp i en annan händelse, så att en säkerhetsvarning (U17) minuter senare
gick ut efter passagen (ANTARES 11:44:44); en rad rättade det.

I banken går varningarna från 469 till 479, och notiser, brotexter och passager är oförändrade:

| Korpus | Ändring | Rådata | Dom |
|---|---|---|---|
| 20260710-13h | ny: DELFIN 11:29:38 (834 m norr om bron i 5,3 kn) | DELFIN korsar mellan 11:34:38 och 11:44:04, ANTARES mellan 11:35:04 och 11:49:37 | rättare: öppningen var ovarnad |
| 20260713-41h | ny: JOY 09:02:54 (888 m, 6,2 kn) | JOY korsar mellan 09:09:57 och 09:13:55, SEEBAER III strax efter | rättare: öppningen var ovarnad |
| 20260806-42h | ny: ALINDE 14:07:32 (930 m, 6 kn) | ALINDE korsar mellan 14:15:04 och 14:16:04 | rättare: öppningen var ovarnad |
| 20260713-41h | ny: HEY JOE 13:08:31 (579 m, 6 kn) | korsar mellan 13:16:02 och 13:19:32; den förra varningen vid bron gick 12:59:22 | rättare om den andra båten gick igenom efter 12:59:22 (bara fönster i rådatan) |
| 20260711-16h | ny: QUEEN ELAN GT5 10:34:27 (700 m, 5,8 kn) | korsar mellan 10:56:26 och 10:57:26; förra varningen 37 min före | likvärdig, närmare korsningen |
| 20260707-14h | HERA II 08:31:57 och LYS 08:50:48 i stället för en gemensam 08:44:30 | bara fönster för korsningarna; öppningen låg kring 09:02 | likvärdig |
| 20260804-both-21h | CHARLYS DREAM 12:20:23 i stället för WANDA 12:20:25 | de fyra båtarna går igenom 12:28–12:32 | likvärdig |
| 20260711-16h | ny: CALIMA 11:26:40 (746 m, 5,2 kn) | korsar först 13:42 | kostnad: en varning för mycket |
| 20260713-41h | ny: PILGRIM 13:05:53 (957 m, 5,2 kn) | korsar först nästa morgon | kostnad |
| 20260806-42h | ny: DORY MAN 14:10:56 (443 m, 4 kn) | korsar inte efter varningen | kostnad |
| 20260804-both-21h | ny: ELIZABETH GREENWOOD 12:21:52 | samma öppning som CHARLYS DREAM, 89 s senare | kostnad: dubbel varning |

Kostnaderna är beslutade i U45: de tre första gällde båtar som gick mot bron i minst 2 kn utanför
väntzonen. Fältkörningarna k1 och k2 är oförändrade. Omlåsningen (`ae586a1`) rör
`opening-distribution.json`, `golden-events` för tre korpusar, det låsta antalet i
`opening-new-members-field.test.js` (39 → 40) och noten för varje korpus.

**U46, utfärden vid ytterpunkterna (D6).** *Situationen:* en båt går ut förbi Kanalinfarten utan
att appen hinner se två positioner bortom 350 m. Besöket står då öppet, och när hon kommer
tillbaka, även dagen efter, får hon ingen notis. *Rättningen*
(`lib/services/TriggerPointVisitTracker.js`): utåtbeviset enligt U46 stänger besöket och sparas
över omstart. I banken och k1 ändras ingenting. I k2 får PRICKBJORN "närmar sig Stallbackabron,
beräknad ankomst strax" på brolinjen 13:48:44 i stället för "har precis passerat" 13:49:53.

**U51, avgången från kaj (D6).** *Situationen:* ELFKUNGEN har sin kajplats cirka 300 m från
Kanalinfarten. När hon lade ut efter 21 timmar tystades notisen, eftersom besöket från ankomsten
stod öppet. *Rättningen:* förtöjningsbelägget följs position för position i besöket (stilla
positioner inom 40 m, högst 60 min mellan dem, minst 2 h) och avgångsbelägget kräver fart mot
punktens linje nära punkten. Tre nya notiser i banken, alla belagda mot båtens positioner:

| Korpus | Ny notis | Rådata |
|---|---|---|
| 20260806-42h | ELFKUNGEN 7/8 10:07:00 "har passerat Kanalinfarten" | stilla vid kajen i 21 h; 203 m förbi punkten i 5,8 kn på den position notisen går |
| 20260823-24h | DIANA 24/8 16:48:04 "närmar sig Kanalinfarten, beräknad ankomst strax" | stilla i 2 h 27 min; 16 m före linjen i 4,8 kn, 63 m förbi den 26 s senare |
| 20260909-80h | ELFKUNGEN 10/9 16:01:36 "närmar sig Kanalinfarten, beräknad ankomst strax" | stilla i minst 4 h 27 min; 23 m före linjen i 5,6 kn |

I fältkörningarna får PRICKBJORN en notis när hon lägger ut från lotskajen (k1 12/11 07:08:07, k2
13/11 06:48:54). PILOT 761 (förtöjd 75 min) och JUNO (102 min utan positioner) får ingen.

*DIANA-låsningen vänds.* Testet i `latest-field-corpus.test.js` låste sedan 2026-09-09 en notis för
hela hamnstoppet. Den låsningen skyddade mot en andra notis som kom bara för att 2 h-spärren löpt
ut medan båten låg kvar. Den andra notisen kommer nu av ett annat skäl, belagd förtöjning och
belagd avgång, och testet prövar båda notiserna med tid, avstånd och text. Ankomstnotisen 14:17:46
löd "beräknad ankomst om 5 minuter"; hon gick in i kanalen två och en halv timme senare.
Omlåsningen (`e068249`) rör `expectedNotifications`, de två fördelningsfilerna, `golden-events` för
de tre korpusarna och testet.

### 13.4 Det som inte gick in, och varför

- **D1, den falska passagen bakåt.** *Felet:* appen har dömt en position som osäker men mäter ändå
  nästa förflyttning från den, och förflyttningen ser då ut att korsa brolinjen baklänges. Det har
  aldrig inträffat i inspelningarna (0 av 1 025 bokförda passager). *Varför inte:* regeln stoppade
  i båda varven också verkliga passager. I första varvet tappades returen vid en U-sväng strax
  bortom bron (20 av 96 byggda lägen), i andra varvet en retur i under 2 kn (72 av 96): båten gick
  genom Stridsbergsbron utan varning och texten sa "på väg mot Klaffbron" i nästan en halvtimme.
  *Nästa försök:* granskarens tredje variant (rörelse räknas från 0,5 kn, och regeln avstår när
  positionen saknar fart) gav 0 skillnader mot dagens kod i alla band med hela nyttan kvar, men är
  inte körd genom hela batteriet.
- **D3, den långsamma båten bortom en bro (U44 punkt 3).** *Felet:* HALIFAX fick 08:29 en
  förvarning för Olidebron söderut "om 6 minuter" och gick igenom norrut 11,6 min senare; EUGENIE
  fick en förvarning för Klaffbron som hon aldrig passerade. *Varför inte:* första varvet höll inne
  förvarningen också för en båt som verkligen kryper mot bron med fel låst riktning (25 av 60
  byggda världar fick den 24–29 s före passagen). Andra varvets undantag, "minst 10 m närmare
  sedan föregående position", beror på rapporttakten: 10 m på 10 s kräver nästan 2 kn, så vid tät
  rapportering släpper det aldrig (21 av 60 världar utan positionsbrus), och brus på 10–20 m
  släpper in den falska notisen igen. *Nästa försök:* ett ankare per båt och bro (läget längst
  från linjen medan förvarningen hålls inne) och släpp när kursen pekar mot bron och båten ligger
  minst 30 m närmare än ankaret; banken och fältkörningarna 0 skillnader i granskarens prov.
- **D8 del A, riktning ur förflyttningen (U48).** Rättar sju av tio nattvärldar, men banken har
  ingen missad varning att rätta. Där slår regeln till 17 gånger, nästan alltid för båtar som
  lämnar väntområdet söder om Kanalinfarten i 2–3 kn: de får målbron en position tidigare, den
  första restiden räknas på den låga farten och utjämningen bär den höga siffran i några minuter.
  Tio restidspåståenden blir 1–4 min sämre och två bättre (bryter U28), ATHENA varnas 30 min före
  passagen i stället för 11, och en lotsbåt får "om 38/46 minuter" i 3,5 min när hon lägger till.
  Prövas på nytt tillsammans med ETA-etappen, eftersom kostnaden kommer ur samma eftersläpning.
- **D8 del B, den bekräftade vändningen.** En nordgående båt som svänger in mot Gästhamnen eller
  kajen norr om Klaffbron rapporterar kurs 340 → 300 → 280 → 265° i 2–3 kn. Appen läser det redan
  i dag som en vändning, men det strikta kursbandet gör att hon inte får någon målbro. Med
  rättningen fick hon Klaffbron som mål: en falsk öppningsvarning och texten "En båt på väg mot
  Klaffbron, om 6–9 minuter" i upp till 65 min (21 av 21 byggda fall). I inspelningarna slår regeln
  aldrig till. Nästa försök ska kräva att bekräftelsens förflyttning går längs farleden.
- **D9, båten vid brolinjen (U49).** Byggd enligt den rättade lydelsen i 13.2: de två nattvärldarna
  (en varning 58 respektive 73 s efter passagen) rättas, banken och fältkörningarna är bitlika.
  Mekanismen är att appens restid nära bron ligger cirka 0,3 min för högt, så prognosen hamnar
  några sekunder efter täckningsslutet. Rättningen är inte granskad och väntar därför.
- **V2, verktygsspåret.** Rättaren sorterade nattjaktens 439 kandidatutslag: 102 mätfel i INV-3,
  276 med registerpost och 61 kvar som kandidater. Granskaren fick samma siffror, men byggde 16
  egna fel i appen, och tio av dem syntes i färre världar med det nya verktyget än med det gamla:
  ett hopp i restiden på 10 min godtogs som beslutat (24 → 2 världar), "strax" 500 m från bron
  likaså (17 → 2), och en varning 51 s före passagen i stället för nästan 6 min togs av den nya
  posten för spärren vid en tidigare bro. Ett verktyg som har blivit blint är sämre än ett som
  larmar för mycket. De 16 mutanterna är godkännandeprovet för nästa försök.
- **E1 och E2, restidens eftersläpning.** Appens förväntade ankomst ligger i median cirka 40 s för
  sent i banken, eftersom utjämningen inte åldrar sitt förra värde. Tre varianter av åldring
  mättes. Eftersläpningen försvinner (+41 s blir +3 s inom 100 m), men 344 av 347 sämre
  restidspåståenden blir för låga: råvärdet räknar med jämn fart och är för optimistiskt när en
  båt bromsar, köar eller kryper, och eftersläpningen har dolt det. "Strax"-löftet håller i 58,5 %
  mot 65,3 %, tre båtar får sin varning sent eller efter passagen, regeln om en enda "strax" (U31)
  bryts, och 1 300–1 700 låsta textrader flyttas. En ETA-etapp är ett eget arbete (en
  inbromsnings- och kömodell i råvärdet, översyn av de regler som är trimmade mot eftersläpningen)
  och görs efter fältprovet.

### 13.5 Kända gränser och uppföljning

Nya eller preciserade kända gränser efter omgången:

- **U45.** BEAUTYFIELD (20260707-14h), felets första exempel, får fortfarande ingen ny varning:
  hon kröp i under 2 kn och hölls av spärren vid Järnvägsbron, och hennes enda position efter
  fönstrets slut låg 140 m från bron. MAJALISA likaså. Att ta dem kräver släpp på tick eller
  prognos, alltså första versionens fel. En stilla båt 400 m från bron med en ensam falsk
  fartuppgift på minst 2 kn kan få en falsk varning (4 av 24 byggda världar; i banken har 4 av
  14 483 stillaliggande positioner en sådan fart). Två sanna varningar för samma öppning kan gå ut
  när en släppt båt och en ny båt går i konvoj genom Järnvägsbron (64 av 180 byggda båtfall).
- **U51.** Ett GPS-hopp vid kaj till nära punkten kan ge en falsk notis (0 av 18 050 kajpositioner
  i data har ett sådant hopp). Med gles AIS kan en avgång bli utan notis (JUNO), men aldrig fler
  än förut. Vid Stallbackabron finns ingen förtöjning i data; regeln är prövad där bara i test.
- **U47.** En returbåt vid konvojfönstrets kant kan få en extra, sen varning för en redan varnad
  öppning (två världar av 20 000).
- **D4.** Öppningstjänsten dömer "bron bakom" på brons latitud på fyra ställen. Bytet till
  brolinjen var bitlikt i all data, och nyttan fanns bara i byggda fall i den 3–14 m breda kilen
  mellan latituden och linjen; latitudprovet skyddar dessutom mot sändare långt utanför farleden.
  En ny båt som först hörs i kilen 13 m före en målbro får nästa bro som mål.
- **U44 punkt 3, D1 och U48** står kvar som före omgången (13.4).

Uppföljningslistan, i den ordning nyttan i verklig trafik motiverar:

1. D3 med ankaret (13.4), D1 med granskarens tredje variant och D9 (U49) med en oberoende
   granskning. Alla tre har ett färdigt förslag.
2. ETA-etappen (E1, E2), och tillsammans med den U48 och bakkantens för höga restid nära bron.
3. Verktygsspåret: registerändringarna efter R1, T1 och T2, med granskarens 16 mutanter som
   godkännandeprov.
4. Spärren vid Järnvägsbron i krypfart (en båt som kryper förbi och ökar osedd får varningen för
   Stridsbergsbron 41–59 s före passagen i byggda världar; banken har ingen under 60 s), och två
   återkorsade broar i samma glapp.
5. Två små luckor från granskningen av U45: ett test som låser att märkningen behålls vid ett
   släpp på färsk position, och en mening i docblocket om att U24:s släpp sker på tid.
6. U45 för en ny båt innanför väntzonen: en båt som först hörs 87–147 m från bron vid
   600 s-fönstrets kant efter en annan båts passage får en egen varning 24–48 s före sin
   passage (två världar i nattjakten, 13.8). Regeln för nya båtar saknar väntzonsvillkoret
   som släppet har.

### 13.6 Fältprovet ska mäta

Utöver listan i 12.5 (raderna `[ETA_SOG_SPIKE_CANDIDATE]`, hur ofta den sena säkerhetsvarningen
U17 kommer, kostnaden i U32 och reservvarningen U38):

- Par av korsningar 300–900 s isär vid samma målbro: stannade den senare båten före bron, eller
  gick hon rakt igenom? Det avgör svansen i U2 (rådatan stöder regeln upp till 445 s).
- Hur ofta U45 ger en ny varning, och om båten sedan kom.
- Notiserna vid Kanalinfarten för båtar som lägger ut från kaj, särskilt lotsbåten.
- Hur ofta en båt med osäker kurs tystnar före bron (U48), och ledtiden vid Stridsbergsbron för
  båtar som kryper förbi Järnvägsbron.
- Tiden från omstart till första båttext, "Inga båtar" som blinkar till mellan två texter om
  samma båt, och hur länge en båttext står kvar nattetid.

### 13.7 Lärdomar

- **"Inget nytt kort" betyder inte "inga kända fel".** Nattjaktens kort triagerades i omgång 2 på
  tre representanter per kort, och registrets klass för kända fall med öppet beslut döljer utslag
  från kortlistan. Räkna utslagen per registerklass och post, inte bara korten. Genomgången gav
  omgångens viktigaste fynd (U45).
- **Ett beslut ska prövas mot det villkor det tar bort.** U49 löd först "ta bort täckningskravet".
  Rättaren mätte vad kravet skyddade mot innan något ändrades, och fann 88 800 uteblivna varningar.
- **En granskares förslag är också en rättning.** Två av granskarnas egna förslag (D1 varv 1, D3
  varv 1) hade samma slags hål som det de rättade, och hittades först när nästa varv byggde nya
  fall. Ett förslag ska prövas lika hårt som rättarens kod.
- **Bevis ur förflyttning mellan två positioner beror på rapporttakten.** "Minst 10 m närmare"
  betyder olika saker vid 10 s och 60 s mellan positionerna. Mät mot ett ankare, inte mot
  föregående position.
- **Nyttan ska finnas i verklig data.** U48 del A rättade sju byggda världar och gjorde tio
  restider och en varning sämre i banken. Ett fel som bara finns i byggda världar väger lätt mot
  en kostnad som syns i inspelningarna.
- **Ett verktyg som lär sig besluten ska prövas med nya fel.** V2 klarade rättarens elva mutanter
  men inte granskarens sexton. En registerpost är smal nog först när ett byggt fel av samma slag
  fortfarande syns.

### 13.8 Slutbatteriet

Kört på `9b3728b`, alltså sammanslagningen med omlåsningarna och VALIDATION; efter den commiten
ändras bara detta dokument. Alla steg slutade med kod 0.

| Steg | Utfall |
|---|---|
| `npm run lint` | 0 |
| hela jest (`--detectOpenHandles`) | 420 sviter, 6 619 test gröna, 2 överhoppade |
| `replay:all`, med och utan monitoring | alla låsta korpusar matchar facit |
| `replay:synthetic` | 169 scenarier rena, WARN 16 |
| `replay:openings` | standardgrindarna godkända |
| soak och `replay:monitoring` | 0 |
| `measure:eta` | identisk med slutbatteriet i 12.7 (ETA-vägen är orörd) |
| fassvepet, med och utan monitoring | 0 |
| `hunt:selftest` | grönt |
| snabbjakten | 45 utslag (48 i 12.7), samma 2 kandidatkluster |
| standardjakten | 220 utslag (231), samma 2 kandidatkluster och 26 kandidatutslag |
| nattjakten (20 000 världar) | 2 387 utslag (2 555), 16 kandidatkluster som förut, 436 kandidatutslag (439) |
| `git status --porcelain` efter batteriet | tom |

**Nattjakten värld för värld mot 12.7** (samma seed, samma världar): inget nytt kandidatutslag.
151 utslag försvann, räknat per värld och klass. Av dem är 125 missade öppningar under posterna
U2-VS-DEADLINE (78) och J13-J14-KONVOJSEMANTIK (47), och 2 är kandidatmissar. Det är U45:s verkan
i världarna.

Sju utslag i sex världar är nya, alla under registrerade poster. En registerpost kan dölja ett
nytt fel (13.7), så de sex världarna kördes på koden före och efter omgången:

- **2868 och 3723:** en öppning som förut var ovarnad får en varning cirka fem minuter före. I
  3723 får dessutom en båt som gick igenom tyst en säkerhetsvarning (U17) 18 min efter sin
  passage. I 2868 kommer en säkerhetsvarning som fanns förut 14 min senare.
- **3068:** en båt varnades 10:54:30 och gick igenom Klaffbron 11:15:45, efter att en annan båt
  passerat 11:00:27. Hon får nu en ny varning 11:10:23. En mötande båt, som förut hade en egen
  varning 11:17:43, tas upp i den händelsen och går igenom 11:25:25, 580 s efter den första
  passagen; hon gick igenom tyst och får en säkerhetsvarning 147 s efteråt.
- **10299 och 17578:** en ny båt som först hörs 87–147 m från bron, vid 600 s-fönstrets kant
  efter en annan båts passage, får en egen varning 24–48 s före sin passage. Förut fick hon ingen
  ny varning. Ingen varning försvinner. Fört till uppföljningslistan (13.5, punkt 6).
- **15056:** tre båtar i följd varnas 05:05:03 och 05:10:32 i stället för 05:08:20, 05:10:19 och
  05:10:32; den tredje båten täcks av den första varningen i stället för att få en egen.

I ingen av de sex världarna försvinner en varning utan att öppningen är varnad på annat sätt.
Säkerhetsvarningarna efter passagen hör till den beslutade klassen U17, och 3068 ligger i den del
av konvojfönstret (445–600 s) som rådatan ännu inte belägger och som fältprovet ska mäta (13.6).
Registerklassen för beslutat beteende minskar totalt från 1 037 till 1 016 utslag och klassen för
kända fall med öppet beslut från 446 till 301.

De 16 kandidatkorten är desamma som i 12.7. De 439 utslagen bakom dem är genomgångna i T1 och T2
(13.1): tre äkta fel, som alla står på uppföljningslistan (U48 i två delar och U49).

