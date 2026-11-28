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
**Omgång 4** (17 november, U45–U51, avsnitt 13) lät en annan båts passage förbruka den varnade öppningen och gav notis vid utfärd och avgång från kaj vid kanalens ytterpunkter; avsnitt 13 stämmer med `9b3728b`.
**Omgång 5** (23–24 november, U52–U58, avsnitt 14) rättade fynden ur fältprov 2 (17–23 november) och en evig slinga i appens krockskydd; avsnitt 14 stämmer med `bf646fe`.
**Omgång 6** (24 november, U59–U61, avsnitt 15) mätte var restiden är fel över hela underlaget och lät restiden räknas om från avgången efter ett långt stopp; avsnitt 15 stämmer med `9bbc276`.
**Omgång 7** (24 november, U62–U64, avsnitt 16) mätte hur ofta en väntande båt saknas i brotexten och ändrade ingen kod; tre kända gränser är beskrivna med mätningen.
**Omgång 8** (24 november, U65, avsnitt 17) bytte "beräknad broöppning strax" mot "En båt väntar vid <målbro>" medan en båt väntar vid sin målbro, på ägarens beslut samma dag. Avsnitt 17 stämmer med `a065019`.
**Omgång 9** (26–27 november, U66–U77, avsnitt 18) gick vid sidan av fältprov 3: sändare som inte är fartyg ignoreras, handskakningen mot AISstream får 30 s, fältfångsten får löpnummer och omsändning, och robusthetsfel funna med felinjektion är rättade; paketet U66 + U73 är infört efter ägarens ja till U73. Avsnitt 18 stämmer med `e40f856`.

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

## 14. Fältprov 2 och omgång 5: 17–23 november 2026

Tillagt 2026-11-24. Omgång 4 (`7633653`) gick i fält på ägarens Homey i 133 timmar. Provet visade
att appen är stabil och att öppningsvarningarna kommer före passagen, och det visade ett fåtal
verkliga fel. Ägaren bad dirigenten rätta dem ("fixa appen och se till att den blir så bra den
bara kan"). Omgång 5 utgick från `7633653` och slogs ihop på grenen `omg5/integration`.
Arbetsformen var densamma som förut: en rättare per spår i en egen arbetskopia, en oberoende
granskare som mätte själv, och en dirigent som slog samman och låste om facit enligt U13 efter en
egen radvis jämförelse mot rådatan. Nytt för omgången var två mätspår, där en utredare mätte
alternativen över hela underlaget innan dirigenten fattade beslut. Beteendebesluten fattade
dirigenten på ägarens uppdrag; ägaren kan ändra vart och ett. Alla tider är UTC.

Fyra ändringar gick in: en lång förtöjning är en resegräns (U52), brotexten under väntan och vid
orimlig restid (U53–U55), och de två sparade rättningarna från omgång 4 som nu klarade
granskningen (U44 punkt 3 och U49). Två regler fördes inte in: varningen vid avgång ur kön vid
Järnvägsbron (U56, återtaget efter granskningen) och spärren mot en falsk passage bakåt (U57,
efter rättarens eget svep). För båda gick dokumentationen av den kända gränsen och test som
låser dagens beteende in i stället.

Efter slutbatteriet hittades ett fel till, inte i fältet utan i arbetet med omgången: tio
kvarglömda testkörningar gick på full processorlast i tio timmar. Orsaken låg i appens eget
krockskydd (U58). Rättningen gick in som en femte ändring (`bf646fe`), och slutbatteriet kördes
om i sin helhet (14.8).

### 14.1 Fältprov 2

Körningen gick 2026-11-17 22:45 till 2026-11-23 11:45 (133 h, 9 476 positioner) och stoppades
ordnat.

- **Stabilitet.** En appstart, inga krascher och inga oväntade fel. 15 avbrott i AIS-strömmen,
  alla upptäckta av appens egen vakt och återanslutna på 2–15 s. Minnet planade ut på 19–20 MB
  efter andra dygnet (gränsen är 70 MB).
- **Fält = replay.** Alla 92 notiser, 31 öppningsvarningar och 358 brotexter var identiska när
  samma positioner kördes om.
- **Loggens integritet föll.** Loggströmmen från Homey till datorn hade tre hål (90, 90 och 180 s;
  minst fem positioner saknas i loggen). Appen gick igenom hålen, men körningen kan inte låsas som
  korpus (`docs/VALIDATION.md`, Fältprov). Regressionstesten i omgången är därför byggda som
  syntetiska scenarier med egna positioner.
- **Öppningsvarningarna.** 30 av 30 verkliga passager av Klaffbron och Stridsbergsbron var varnade
  före passagen, i median 356 s före (37–1 095 s). Ingen varning kom efter passagen. En varning
  var falsk: lotsbåten PRICKBJORN gick 20/11 mot Klaffbron i 6,6 kn och lade sedan till vid en kaj.
  För Stridsbergsbron norrut kom 7 av 9 varningar 37–218 s före (14.5, U56).
- **Notiserna.** 92 notiser mot 88 korsningar och zonbesök. En notis saknades och en hade fel
  riktning, båda för samma båt efter en lång förtöjning (U52). Restiden låg inom en minut i 72 %
  av notiserna och inom två i 82 %; de största felen gällde båtar som sedan väntade vid
  Järnvägsbron.
- **Brotexten.** Under väntan före Järnvägsbron räknade texten uppåt (KINNE 22/11: "om 10" till
  "om 27 minuter" på 18 minuter), och 23/11 visade den "om 117–120 minuter" i 45 minuter för en
  båt som låg nästan stilla vid Stallbackabron (U53–U55).
- **Mätlistan i 13.6.** Fartspiksvakten gav inga kandidater. U45 noterade en annan båts passage
  en gång och gav ingen ny varning; trafiken var för gles för att pröva regeln. U51 gav fem
  avgångsnotiser. Inga par av korsningar låg 300–900 s isär, och ingen sen säkerhetsvarning (U17)
  gick. Fältet har alltså ännu inte prövat U45, U46 eller konvojfönstrets svans.

### 14.2 Översikt

| Spår | Vad | Utfall | Commits |
|---|---|---|---|
| A (U52) | En lång förtöjning är en resegräns | inne, godkänd i andra granskningen | `587e89f`, `b89e505`; `0734038` |
| C (U53–U55) | Brotexten under väntan och vid orimlig restid | inne; U54 och U55 godkända i första granskningen, U53 i andra; fyra korpusar omlåsta | `d6d41df`, `2c555f7`, `5bdb59f`, `2c3f1d9`, `66d4b20`; `9f93d91`; `833f40a` |
| D3 (U44 punkt 3) | Förvarning för en långsam båt bortom en bro | inne i tredje varvet, godkänd efter granskarens ändring; två korpusar omlåsta | `afd0778`, `1ead192`, `35b59e6`, `edc300b`; `6d778c3`; `15b2bb6` |
| D9 (U49) | En båt i fart vid brolinjen när konvojens täckning löper ut | inne, godkänd i första granskningen | `1bc974e`, `400e158`; `9642c19` |
| B (U56) | Varningen för Stridsbergsbron norrut efter väntan vid Järnvägsbron | regeln inte införd (beslutet återtaget efter granskningen); känd gräns och test inne | `a7e6d60`; `45cc053` |
| D1 (U57) | Falsk passage bakåt över brolinjen efter en osäker position | regeln inte införd efter tre varv; känd gräns och test inne | `5b842aa`; `eeeecc2` |
| E (U58) | Ett fel i loggkanalen håller inte appen i en evig slinga | inne i tredje varvet, godkänd efter granskarens ändring | `b53bc30`, `c107258`, `53b2f45`; `bf646fe` |

### 14.3 Besluten U52–U58

- **U52. En lång förtöjning är en resegräns.** En båt som legat förtöjd i minst två timmar (appens
  befintliga förtöjningsklassning, samma två timmar som U51) börjar en ny resa när hon lägger ut.
  Den första positionen i minst 2,0 kn släpper förra resans riktning, och två positioner i rad i
  samma kursband, högst 15 minuter isär, bekräftar den nya resan. Bara broar framför
  förtöjningsplatsen i den nya riktningen nollställs. En båt som väntar vid en bro räknas inte.
- **U53. Väntan vid en mellanbro visas som väntan.** Brotexten säger "väntar vid Järnvägsbron på
  väg mot …" (och motsvarande vid Olidebron) när en båt belagt ligger still eller kryper före en
  mellanbro, upp till 800 m från bron, utan det tidigare kravet att farten någon gång varit högst
  0,5 kn. Väntan släpps över 1,5 kn eller bortom 850 m. Medan texten visar kö hålls den dolda
  tiden (upp till 1 kn). Det gäller bara texten och aldrig målbron.
- **U54. En restid över 60 minuter visas som "ETA okänd"** i brotexten.
- **U55. En båt som legat still i fem minuter får "ETA okänd"** också när hon har status på väg
  eller väntar vid Stallbackabron (regeln i U30 utsträckt). Långsam drift (U35) ändras inte.
- **U56. Återtaget.** Beslutet var att en båt som haft köbelägg vid Järnvägsbron och sedan syns
  röra sig mot bron i minst 2,0 kn får varningen för Stridsbergsbron direkt. Granskningen visade
  att ett ryck i kön inte går att skilja från avgången (14.5), och regeln fördes inte in.
- **U57. Den falska passagen bakåt står kvar som känd gräns.** Rättningen förs inte in (14.5).
- **U58. Ett fel i loggkanalen får inte hålla appen i en evig slinga.** Appen ska överleva en
  trasig loggkanal tyst: fel från stdout och stderr sväljs och räknas men loggas aldrig, och
  krockskyddet får inte kunna hålla sig självt vid liv. Appen fortsätter med notiser, varningar
  och brotext utan logg. Avstått: att avsluta processen när loggkanalen går sönder (appen slutar
  då fungera där den kunde ha fortsatt).
- **U49, preciserat.** Under-bro-hållet mäter ankomsten med det tidigaste av appens prognos och
  avstånd genom fart för en båt i minst 2 kn; kravet att ankomsten ligger inom täckningen står
  kvar. Känd kostnad: en båt i minst 2 kn vid linjen som stannar och aldrig hörs mer får ingen
  varning för den bron.

### 14.4 Det som gick in

**U52, en lång förtöjning är en resegräns.** Lotsbåten PRICKBJORN ligger vid lotskajen vid
Kanalinfarten mellan sina turer och sänder hela tiden, så fartygsposten levde kvar med förra
resans bokföring. 23/11 lade hon ut norrut efter 69 timmar; notisen vid Olidebron uteblev,
eftersom bron stod som passerad från resan 20/11. 19/11 gick avgångsnotisen (U51) ut med
riktningen söderut, eftersom ruttlåset från ankomsten dagen före fortfarande gällde vid den första
positionen. Felet med den uteblivna notisen kräver dessutom mer än sex timmars förtöjning; vid
kortare förtöjning släpper besöksposten nyckeln och notisen kommer ändå. Med rättningen ändras
exakt de två notiserna i fältprov 2 (riktningen norrut 19/11; "närmar sig Olidebron, beräknad
ankomst om 1 minut" 23/11 08:10:28). Banken och de två tidigare fältkörningarna är oförändrade.
Den största nyttan syns inte i fältet: en båt som legat över natten och går tillbaka genom samma
bro fick förut varken notis eller öppningsvarning.

Granskningen fällde första versionen på en punkt: en långsam position mitt i avgången nollade den
väntande riktningen, så att öppningsvarningen kom en minut senare än förut (upp till tre med gles
AIS). Rättningen var en rad. Rättaren visade sedan att två brus-positioner med en timmes mellanrum
kunde bekräfta en resa, och lade till 15-minutersgränsen (samma som för en vändning).

**U53–U55, brotexten.** Mätningen över banken och de tre fältkörningarna (2 227 textrader med tid)
visade att 10 % av raderna är mer än tre minuter fel när båten går i marschfart, men 66 % när hon
väntar före Järnvägsbron norrut. Båtar norrut väntade där i 1 052 minuter, och texten sa "väntar"
i 271 av dem. Det som hindrade vänttexten var i tur och ordning gles AIS, kravet på en position
med högst 0,5 kn, obekräftad anflygning och avståndsgränsen 350 m. Av restider över 60 minuter var
ingen av 18 sann; över 30 minuter var 5 av 40 sanna, så taket sattes inte lägre.

I fältprov 2 visar texten nu "väntar vid Järnvägsbron" för KINNE från 20:41:56 i stället för
20:52:10 och för VISTEN utan avbrott från 20:35:43, och "ETA okänd" för PRICKBJORN från 10:42:55
23/11 i stället för "om 27" till "om 120 minuter". Notiserna är oförändrade i hela underlaget.
Ingen öppningsvarning ändrar tid, bro eller medlemmar; tre kort får en annan minutsiffra, alla
närmare det verkliga (KINNE 14 → 8 där 2,2 återstod, PRICKBJORN 18/11 4 → 3 där 2,0 återstod,
ANDREA i banken 10 → 9 där 6,6 återstod). I banken flyttas 38 textrader i fyra korpusar; varje
rad är prövad mot positionerna.

Granskningen fällde U53 på flimmer vid Kajens zonkant (kajzonen täcker farleden 644–788 m söder om
Järnvägsbron): en båt vid kanten med 12 m positionsbrus växlade mellan "väntar" och en restid fyra
gånger på nio minuter. En marginal på 12 m för en redan bekräftad väntan tog bort det.

**U44 punkt 3, en långsam båt bortom en bro (tredje varvet).** Förvarningen hålls inne tills
riktningen är belagd, och släpps när båten med kursen mot bron ligger minst 30 m närmare linjen än
spärrens ankare. Ankaret är den position där båten hölls inne; det flyttas utåt först när två
positioner i rad ligger längre bort. En båt utan giltig kurs släpps när två positioner i rad
ligger minst 30 m närmare. I rättarens 840 byggda världar ger koden 170 falska notiser mot 305
förut, och 31 förvarningar under 60 s före korsningen mot 6 förut. I banken ändras två notiser:
HALIFAX (20260708-21h) får förvarningen vid Olidebron i rätt riktning 68 s före korsningen i
stället för i fel riktning elva minuter före, och EUGENIE (20260804-both-21h) slipper en falsk
förvarning för Klaffbron som hon aldrig korsade.

**U49, under-bro-hållet.** Felet (en varning 58–73 s efter passagen) fanns i 2 av nattjaktens
20 000 världar; i båda var öppningen redan varnad i tid av en annan varning. Banken och
fältkörningarna är oförändrade rad för rad. Kostnaden har inte hänt i någon av 90 inspelade
episoder med en båt i minst 2 kn högst 50 m före bron (alla korsade, ingen tystnade).

**U58, loggkanalen.** Tio replay-körningar från ett av spårens svep låg kvar utan förälder efter
slutbatteriet och gick på full processorlast i tio timmar, där samma filer annars är klara på
någon sekund. Mekanismen är återskapad på `7633653`: när mottagaren av loggen försvinner
misslyckas varje skrivning (EPIPE). Felet kommer upp som ett ofångat fel, appens krockskydd
(`_onUncaughtException`) loggar det, den loggningen misslyckas på samma sätt, och så vidare,
omkring 9 000 varv per sekund utan att händelseslingan släpps fram. Är bara stdout trasig blir
det ingen slinga, men en `[FATAL]`-rad för varje misslyckad loggrad. På Homey går loggen genom
samma slags kanal till Homeys kärna. Felet har inte setts i fältproven (drygt 200 timmar), men
skulle där låsa appen på full last tills Homey stänger av den.

Rättningen har tre delar. Loggkanalens två strömmar får var sin lyssnare som bara räknar felen.
Krockskyddet loggar som förut, men inom `try/catch` och med en spärr: högst tio `[FATAL]`-rader
per minut, resten räknas och summeras i en rad som namnger det första spärrade felet. Lyssnarna
tas bort i `onUninit` och sätts om i `onInit`, så att två starter i rad inte ger dubbla.
Testverktygets replay fick dessutom en egen lyssnare, eftersom det skriver också mellan appens
stopp och start. Krockskyddet känner inte igen felet på felkoden: ett EPIPE från AIS-anslutningen
ser likadant ut och ska loggas.

Notiser, öppningsvarningar och brotexter är identiska i banken och de tre fältkörningarna.
Granskningen gick i tre varv. Det första fann att testens egna barnprocesser blev föräldralösa
och snurrade när jest dödades mitt i körningen, alltså just det fel rättningen gällde; de fick en
vakt i en egen tråd. Det andra fann att summeringsraden höll kvar ett 80 MB stort felmeddelande
i minnet; rättningen var två rader som granskaren själv hade prövat.

### 14.5 Det som inte gick in, och varför

**U56, varningen för Stridsbergsbron norrut.** Båtar norrut väntar söder om Järnvägsbron, som
öppnas mellan tågen, och når sedan Stridsbergsbron ett par minuter efter att de satt fart.
Mätningen över 93 passager visade att inget i datan förebådar öppningen utom båtens egen avgång:
väntan varar 4–52 minuter utan mönster, en annan båt går före i samma öppning i 7 av 35 fall (en
mötande i 4, en norrgående bara sekunder före i 3), och i fem fall ligger redan den första
positionen i rörelse vid Järnvägsbron.
Tre alternativ avstods på mätningen: ett sänkt fartgolv i U32 (hjälpte en båt och gav krypköer en
varning 10–15 minuter för tidigt), en varning redan under väntan (median 9–11 minuter för tidigt,
svans 30–50 minuter, ingen tid på kortet i 17 av 39 fall) och en varning i tidtabellens fönster.
Det fjärde, en varning när en köande båt sätter fart från 2,0 kn med minst 20 m framsteg, byggdes:
det gav 9–78 s tidigare varning i fyra av 39 passager och inga falska varningar i banken och
fältet. Granskaren visade ändå att ett ryck i kön inte går att skilja från avgången i den position
där regeln bestämmer sig. En båt som flyttar sig 25–60 m i drygt 2 kn för att ge plats, driver,
eller får en enda felaktig position fick kortet "om 3 minuter" 12–35 minuter för tidigt och sedan
inget kort vid den verkliga avgången, där koden utan regeln varnar 64–148 s före. Två verkliga
ryck i rådatan (OLA 7/9 och PRICKBJORN 18/11, båda 2,1 kn i verklig medelfart) klarade sig bara
för att den enda positionens rapporterade fart var 1,2 och 1,5 kn. Den sena varningen står därför
kvar som känd gräns, och tio syntetiska fall låser att ett ryck i kön inte ger någon varning.

**U57, den falska passagen bakåt.** Regeln (ingen passage bakåt över brolinjen från en position
appen dömt osäker) fälldes två gånger i omgång 4. I tredje varvet byggde rättaren granskarens
variant och svepte själv 31 440 världar. Där felet finns försvinner de falska passagerna (1 528 →
62) bara när den riktiga positionen har en fart under 0,5 kn. I gengäld förlorar 162 av 1 440
världar en sann passagenotis när båten verkligen har passerat under ett AIS-glapp och nästa
position är brus före linjen, 54 av dem också öppningsvarningen. Felet och dess spegelbild ser
likadana ut i den position där regeln bestämmer sig. Enda vägen som tar båda är att vänta en
position med beslutet, vilket är en ombyggnad av GPS-grinden. Felet har aldrig setts i banken
eller fältkörningarna.

**Avstått inom spåren.** I brotexten: ett generellt håll av tiden för långsamma båtar (fler rader
sämre än bättre), ett tak på 30 minuter (tar bort nästan rätta siffror), en ny textform "tidigast
om N minuter", och att släppa väntan först efter två positioner i rad över hysteresfarten (höll
"väntar" in i verkliga avgångar; 16 felminuter sämre mot 7 bättre). I U52: att nollställa även
broar bakom båten.

### 14.6 Kända gränser och uppföljning

Kända gränser som omgången lämnar, alla beskrivna i `docs/ARCHITECTURE.md`:

- **Stridsbergsbron norrut:** varningen kommer 37–218 s före passagen efter en väntan vid
  Järnvägsbron (U56).
- **U52:** en båt som legat förtöjd i minst två timmar och byter kaj 60–100 m i över 2 kn mot en
  bro hon passerade på förra resan behandlas som en förstakontakt och kan få en falsk
  öppningsvarning. En båt som kryper eller svajar i mer än sex timmar utan att klassas förtöjd
  tappar fortfarande notisen för en bro från förra resan.
- **U53:** jämn gång i 1,0–1,5 kn mot bron visas som väntan; en ensam fartspik kan släppa väntan
  så att en restid visas en stund; kajzonen gör att bandet i praktiken är 350–644 m söder om
  Järnvägsbron.
- **U44 punkt 3:** en båt som hörs första gången medan hon ligger still nära en bro, med en första
  kurs som pekar fel, kan få förvarningen sent eller inte alls (förut i god tid men i fel
  riktning). Inget sådant fall finns i banken eller fältkörningarna.
- **U49:** en båt i minst 2 kn vid brolinjen som stannar och aldrig hörs mer får ingen varning för
  bron; bakkantens systerställe (kortet 20 s efter korsningen med en 39 s gammal position).
- **U57:** en falsk passage bakåt efter en brusposition.
- **U58:** går stdout sönder just när appen stängs skrivs den sista loggraden efter att
  lyssnarna tagits bort, och processen slutar med kod 1 i stället för 0 (låst av test; på Homey
  tas processen ändå ned). Att Homeys SDK loggar via stdout och stderr är belagt av SDK:ns typer
  och fältloggens form, inte av SDK:ns källkod.

Uppföljning, i ordning:

1. **Restiden (ETA-etappen).** Tiden som visas innan en båt norrut börjar vänta före Järnvägsbron
   är fel i 88 % av raderna (median 12 minuter); 42 % av passagerna norrut har en väntan, i median
   17 minuter. Hit hör också den första tiden efter väntan, notisernas restid för en båt som sedan
   väntar (vad "beräknad ankomst" ska betyda), ett tak för restiden i notiser, den långsamma
   återhämtningen efter ett långt stopp, och den åldrade utjämningen från omgång 4 (E2).
2. **Spärren "bron är redan passerad på den här resan"** för en båt som ligger länge utan att
   klassas förtöjd.
3. **Loggströmmens hål.** Tre hål på 90–180 s gjorde att fältprov 2 inte kunde låsas som korpus.
   Orsaken är inte utredd.
4. En krypande båt vid Kanalinfarten tas bort ur texten efter cirka fem minuter, och en båt som
   ligger helt stilla 350–800 m före en mellanbro tappar målbron efter cirka fyra minuter.
5. Uppföljningslistan i 13.5 i övrigt: U48, verktygsspåret, U45 för en ny båt innanför väntzonen.

### 14.7 Lärdomar

- **"Noll fall i rådatan" är inte ett bevis när marginalen är slumpen.** Regeln i U56 hade inga
  falska utslag i 35 inspelade avgångar. Granskaren räknade den verkliga medelfarten mellan
  positionerna i stället för den rapporterade farten och fann två ryck som låg över regelns gräns.
  Fråga vad som skiljer de inspelade fallen från felet, och om det är regeln eller turen.
- **Mät före beslutet, och granska ändå.** De två mätspåren gav bättre beslut än dirigentens
  första antaganden (det var inte fartgolvet 2,8 kn som fördröjde varningen, utan kravet på två
  positioner i rörelse före ökningen). Men mätningen såg inte ryckfallen; det gjorde granskaren.
- **En rättare som själv avråder är ett fullgott resultat.** Rättaren av U57 byggde det brett band
  som granskaren annars hade byggt, och visade själv att regeln bytte ett fel mot dess spegelbild.
- **Test som låser dagens beteende kan låsa ett fel.** Ett av de nya scenarierna låste en falsk
  förvarning som en annan rättning i samma omgång tog bort. Vid sammanslagningen ska varje test
  som faller prövas mot positionerna, inte anpassas.
- **Sex agenter på en dator gör tidskänsliga test opålitliga.** Två sviter föll på sina
  tidsgränser under last och gick gröna ensamma. Slutbatteriet kördes när maskinen var ledig.
- **Arbetsmappen är inte beständig.** Verktygen från omgång 4 var borta efter fältprovets fem
  dygn. Omlåsningsverktyg och kö läggs nu i det beständiga underlaget så fort de skapas.
- **En körning som borde vara klar på sekunder men lever i timmar är ett fynd.** Tio föräldralösa
  replayer gick på full last genom hela det första slutbatteriet utan att något test föll, och
  de var lätta att ta för brus. Orsaken var ett verkligt fel i appen (U58). Processlistan
  kontrolleras nu före varje batteri.

### 14.8 Slutbatteriet

Kört på `1b255af`, alltså sammanslagningen med omlåsningarna och VALIDATION; efter den commiten
ändras bara detta dokument, datumet för U56:s återtagande på två kommentarsrader (23 november,
inte 24) och U58, som har sitt eget batteri sist i avsnittet. Alla steg slutade med kod 0.

| Steg | Utfall |
|---|---|
| `npm run lint` | 0 |
| hela jest (`--detectOpenHandles`) | 426 sviter, 6 804 test gröna, 2 överhoppade |
| `replay:all`, med och utan monitoring | alla låsta korpusar matchar facit |
| `replay:synthetic` | 213 scenarier rena, WARN 22 |
| `replay:openings` | standardgrindarna godkända |
| soak och `replay:monitoring` | 0 |
| `measure:eta` | brotexten bättre, inget sämre (se nedan) |
| fassvepet, med och utan monitoring | 0 |
| `hunt:selftest` | grönt |
| snabbjakten | 45 utslag som i 13.8, samma 2 kandidatkluster |
| standardjakten | 220 utslag, samma 2 kandidatkluster; utslag för utslag lika med `7633653` |
| nattjakten (20 000 världar) | 2 386 utslag (2 387), 16 kandidatkluster som förut, 435 kandidatutslag (436) |
| `git status --porcelain` efter batteriet | tom |

**Restidsmätningen mot `7633653`** (samma mätning körd på båda kodlägena; sanningen är rådatans
korsningar):

| | mätta påståenden | summa fel (min) | median (min) | inom 2 min |
|---|---|---|---|---|
| brotext | 1 495 → 1 478 | 28 885 → 24 011 | 2,17 → 2,12 | 47,8 → 48,4 % |
| notis | 599 → 599 | 2 292 → 2 286 | 0,39 → 0,38 | 85,1 → 85,3 % |
| öppningskort | 202 → 202 | 4 708 → 4 707 | 1,50 → 1,50 | 56,4 → 56,4 % |

Rad för rad: 20 påståenden är borta (18 minutsiffror i brotexten som nu är "väntar" eller "ETA
okänd", HALIFAX förvarning i fel riktning och EUGENIE:s falska förvarning), 2 är nya (HALIFAX i
rätt riktning och en flyttad textrad för OLA), 4 har en minutsiffra närmare sanningen och ingen
har en sämre. Den stora posten är 20260601-41h, där AIR:s "om 73–86 minuter" stod för drygt
4 700 av felminuterna.

**Nattjakten värld för värld mot 13.8** (samma seed, samma världar): tre världar skiljer sig i
utslag, och var och en kördes på koden före och efter omgången.

- **8814 och 18489:** varningen som kom 58 och 73 s efter att båten passerat Stridsbergsbron är
  borta, och inget annat ändras (17 → 16 och 4 → 3 varningar). Det är U49:s verkan.
- **17318:** ett nytt kandidatutslag, ETA-OSCILLATION vid Stridsbergsbron ("strax" → "om 4
  minuter" → "strax" på 142 s). Notiser och varningar är lika, och brotexten skiljer sig på en
  rad: vänttexten vid Järnvägsbron står kvar 30 s längre (U53), så att mellanledet "om 5 minuter"
  12:03:06 inte publiceras. Förut var följden "strax", väntan, "om 5", "om 4", "strax" med samma
  tider; mätaren räknar tre led som en oscillation men inte fyra. Samma beteende, alltså, och
  inget nytt fel. Språnget från "om 4 minuter" till "strax" på 30 s när en båt lämnar väntan hör
  till avgångssiffran i ETA-etappen (14.6, punkt 1).

I en fjärde värld (13085) ändras bara tiden i ett utslag som fanns förut (sågtanden 15 → 23
minuter vid Klaffbron på 53 s i stället för 71), eftersom en krypande båt före Järnvägsbron nu
visas som väntande i tio minuter. Inga utslag under registrerade poster kom till eller försvann;
registerklasserna är oförändrade (beslutat beteende 1 016, kända fall med öppet beslut 301).

De 16 kandidatkorten är desamma som i 13.8.

**Slutbatteri 2 på `bf646fe`** (koden med U58, kört 2026-11-24). Alla steg slutade med kod 0.
Hela jest gav 427 sviter och 6 827 gröna test, 2 överhoppade; den nya sviten är U58:s.
Restidsmätningen är lika med det första batteriet i varje påstående (bara tidsstämpeln skiljer).
Snabbjakten, standardjakten och nattjaktens 20 000 världar är utslag för utslag lika med det
första batteriet, med samma 16 kandidatkort. Det är det väntade utfallet: U58 rör loggkanalen och
krockskyddet, inte båtlogiken. Inga kvarglömda körningar fanns före eller efter batteriet.

## 15. Omgång 6, restiden: 24 november 2026

Tillagt 2026-11-24. Omgång 5 pekade ut restiden som nästa steg (14.6, punkt 1). Omgång 6 började
med en mätning över hela underlaget, bankens 25 korpusar och de tre fältkörningarna, av var
restiden i brotexten, notiserna och öppningskorten är fel och vad appen kan veta i det ögonblick
den skriver siffran. Därefter fattade dirigenten tre beslut på ägarens uppdrag (U59–U61); ägaren
kan ändra vart och ett. Arbetsformen var densamma som i omgång 5. Omgången utgick från
`omg5/integration` och slogs ihop på grenen `omg6/integration`. Alla tider är UTC.

En ändring av beteendet gick in: efter ett långt stopp räknas restiden om från avgången (U59).
En regel fördes inte in: avgångsgolvet efter kryp (U60), som rättarens eget svep fällde. U61 är en
definition i dokumentationen. Mätningens viktigaste besked är att det mesta av restidens fel inte
går att räkna bort: 68 % av brotextens felmängd ligger kring väntan vid en bro, och ingenting
appen ser förutsäger väntan.

### 15.1 Mätningen

Felmängden är summan av brotextens fel i minuter, provad var 30:e sekund över 28 körningar
(25 076 totalt). Sanningen är rådatans linjekorsning.

- **Kring väntan: 68 %.** Före en väntan 32 % (siffran räknar med fri väg; median 13,8 min fel),
  under väntan vid målbron 15 % ("strax" medan bron inte öppnar), under väntan vid en mellanbro
  7 % och stilla länge 14 %.
- **I marschfart: 9 %**, med median 1,3 min fel och 67 % inom två minuter. I de sista minuterna
  före passagen ligger 80 % inom två minuter.
- **Notiserna** är träffsäkra: median 0,4 min och 87 % inom två minuter. För de 52 notiser där
  båten sedan väntade är medianen 1,9 min mot ankomsten till väntplatsen och 10,2 mot passagen.
- **Öppningskorten:** 79 % av felsumman kommer från sju kort där båten sedan låg förtöjd i 2–22
  timmar. Med sanningen inom 60 minuter är medianen 1,2 min.
- **Väntan går inte att förutsäga.** Klockslag, månad, minut i timmen, väntande och mötande
  båtar, tid sedan förra öppningen, fart och rapporttakt prövades. Ingen modell slog "ingen
  väntan" i korsvalidering per korpus (bästa 9,4 mot 9,7 min medelfel norrut, ingen vinst
  söderut). Två iakttagelser utan praktisk nytta: nattetid väntar nästan ingen (1 av 23), och
  Järnvägsbron öppnar sällan minut 36–44 i timmen.

### 15.2 Översikt

| Spår | Vad | Utfall | Commits |
|---|---|---|---|
| M1 | Mätning av restiden över hela underlaget | rapport, ingen kod | – |
| R1 (U59) | Restiden efter ett långt stopp | inne med oförändrad kod; godkänd i andra granskningen sedan priset skrivits ut och låsts | `612fb35`, `7e902e5`; `f44003b`; `9bbc276` |
| R1 (U60) | Avgångsgolvet också efter kryp | regeln inte införd (rättarens eget svep); känd gräns och test inne | `52129f8` |
| R1 (U61) | Notisens "beräknad ankomst"; mätverktygets tabell inom 60 min | inne | `0cdd2b4` |

### 15.3 Besluten U59–U61

- **U59. Efter ett långt stopp räknas restiden om från avgången.** När en båt belagt har legat
  still (familj E:s avgångskontext eller U30-läget) och sedan går i minst 2 kn, närmare målbron
  än där hon låg, släpps utgångsvärdet från stillheten. En båt som bara saktar in berörs inte.
- **U60. Avstått.** Beslutet var villkorat: avgångsgolvet skulle gälla också när alla buffrade
  positioner är under 1 kn och den nya är minst 2 kn, om det inte gick att få regeln att visa en
  klart för låg tid för en båt som rycker i kön. Det gick (15.5).
- **U61. "Beräknad ankomst" i notisen betyder ankomsten till bron eller väntplatsen,** inte
  passagen. Ingen kodändring och inget tak för notisernas restid (högst 21 min har förekommit i
  1 025 notiser).

### 15.4 Det som gick in

**U59, restiden efter ett långt stopp.** En båt ligger still i 20 minuter vid Stallbackabron och
går sedan i 5 kn mot Stridsbergsbron. Förut visade texten "ETA okänd" i sju minuter och sedan "om
59 minuter" när sju återstod, och öppningskortet "om 45–54 minuter" när 6–7 återstod. Mekanismen:
under stoppet räknar kedjan på fartgolvet 0,5 kn, och efter avgången försvaras det värdet av
utjämningen, som bara släpper ned det i små steg. Felet syns bara när beräkningen har stått över
i mer än tre minuter under stoppet (33 av 80 körningar med 20 och 45 minuters stopp); annars
räknar appen redan om från avgången. Rättningen släpper utgångsvärdet när avgången är
belagd, i kalkylatorn och i publiceringen, med samma signal som väntbaslinjens släpp.

Banken är oförändrad i alla 3 182 påståenden och i varje notis, öppningskort och textrad. I
fältet ändras fyra saker: PRICKBJORN 12/11 "om 11" → "om 8" där 5,0 återstod och kortet 9 → 7
där 3,9 återstod; 19/11 "om 9" → "om 4" och kortet 9 → 4 där 3,6 återstod; samma dag en notis
1 → 2 där 1,3 återstod; och 20/11 en notis 3 → 2 för en båt som redan var på väntplatsen och
aldrig korsade bron. I de byggda världarna ligger kortet inom 0,7 min från sanningen i alla
körningar, och felet står kvar i 6 av 80 (15.6).

**Priset.** Granskaren byggde 6 064 egna världar med köer, ryck och felaktiga positioner. En båt
som legat still länge i kön och sedan rycker fram, eller får en enda position med felaktig fart,
får nu en för låg tid: öppningskortet "om 3" där 34 återstod (förut "om 21"), notisen "om 2" där
12,5 återstod till passagen (förut "om 15"), och "om 5" i nästan 20 minuter där 35 → 16 återstod
(förut "om 32" och sedan ett fruset "om 27"). Texten blev ny klart för låg i 360 minuter i 155
världar (2,6 %). Ingen öppningsvarning flyttade i tid och ingen kom till. Fyra följekort försvann
vid verkliga avgångar, där ledbåtens kort nu täcker konvojen.

Dirigenten tog in regeln ändå. Det är inget nytt beteende: i de körningar där beräkningen inte
stått över visar koden före rättningen samma låga siffror efter ett ryck. Det frusna värdet var
rätt vid ett ryck av en slump och fel vid varje verklig avgång. Varje väntan slutar med en avgång,
medan ryck finns i ungefär 2 av 35–39 inspelade väntor. Granskaren prövade ett krav på 50 m
förflyttning före släppet; det tog bort 76–97 % av nyttan och lät priset stå kvar.

Priset är låst i dagens storlek av två scenarier (ryck 120 m i kön söder om Järnvägsbron och en
ensam fartspik i en lång väntan norr om Klaffbron): kortet får inte komma tidigare, och text och
kort får inte bli lägre. Varje villkor i regeln har ett enhetstest som faller när villkoret tas
bort (16 av 16 mutationer), och scenarierna fäller 6 av de 16, bland dem en kod utan krav på
stillhetsbevis.

**U61, notisens restid och mätverktyget.** Definitionen står i `docs/ARCHITECTURE.md` och
`docs/VALIDATION.md`. `measure:eta` har fått en tabell över påståendetyperna med sanningen inom
60 minuter (öppningskorten: 195 kort, median 1,22 min, p90 14,3), så att de sju korten för båtar
som sedan förtöjde inte dränker resten.

### 15.5 Det som inte gick in, och varför

**U60, avgångsgolvet efter kryp.** En båt som krupit i kön under 1 kn och sedan sätter fart får i
dag en för hög första siffra: KINNE 22/11 "om 10" där 3,6 återstod och kortet "om 8" där 2,2
återstod. Regeln hade gjort fem av sex kort rättare. Rättarens svep över 2 112 byggda världar
fällde den: en båt som kryper i 0,7 kn, rycker 60 m i kön och väntar tio minuter till fick "om 5
→ 6 → 7" där 16 återstod (förut "om 12 → 10"). Klart för låg text där koden förut inte hade det
i 72,5 minuter i 32 världar, som mest 16 minuter lägre, och en enda felaktig position räckte. I
banken blev tre påståenden sämre (LA FEMME två, LILLI ett), eftersom golvet antar att båten
accelererar. Skillnaden mot U59: U60 var en ny regel som gav för låga tider som koden aldrig
annars visar, och den vann några minuter där U59 vinner 40–50. KINNE-fallet står kvar som känd
gräns, låst av fyra enhetstest och tre scenarier.

**Avstått på mätningen.**

- **En statistisk väntetid** ovanpå siffran före en väntan: väntarna går från 15,8 till 10,3 min
  medelfel, de som inte väntar från 6,4 till 10,4–11,3. Felet flyttas, det minskar inte.
- **"ETA okänd" före en mellanbro:** tar bort 174 minuter fel siffror norrut och 105 minuter
  rätta; söderut 509 rätta mot 201 fel.
- **Tak för notisernas restid:** inget fall i underlaget berörs.
- **Öppningskortens stora fel:** kommer från båtar som sedan förtöjde; ingen kodändring.

### 15.6 Kända gränser och uppföljning

Kända gränser som omgången lämnar, beskrivna i `docs/ARCHITECTURE.md`:

- **U59:** för låg tid efter ett ryck i kön eller en ensam fartspik efter lång stillhet (15.4).
  Går en båt iväg och stannar igen visas siffran från avgången i upp till sju minuter ("om 9–14"
  där 33–36 återstod) innan U55 tar över. Utan familj E:s avgång kan första siffran vara upp till
  25 min för hög i två minuter (6 av 80 körningar). Kortet vid avgång ur väntan vid Järnvägsbron
  kan bli upp till 3 min sämre (5 → 8 där 5,5 återstod). En båt som saktar in till 1 kn i tio
  minuter utan att ligga still har inget stillhetsbevis och rättas inte: "om 57" där 14 återstod.
- **U60:** ingen avgång ur kryp; första siffran efter kryp är för hög.

Uppföljning, i ordning:

1. **"Strax" medan en båt väntar vid målbron.** Texten säger "beräknad broöppning strax" hela
   tiden en båt väntar direkt vid Klaffbron eller Stridsbergsbron (CALIMA i 48 minuter, ANDREA i
   60). Det står för 27,5 % av brotextens felmängd. Alternativet är formen "En båt väntar vid
   Stridsbergsbron", som är sann i varje minut. Det vänder ägarens beslut 2026-08-08 (U6) och
   2026-09-12, så frågan är ställd till ägaren.
   Avgjord av ägaren 2026-11-24: texten byts (U65, avsnitt 17).
2. **"Inga båtar" efter en omstart.** En stillaliggande båt i kön försvinner ur texten i upp till
   tio minuter efter en omstart, tills hon rör sig. Funnet av granskaren, finns före omgången.
   Mätt i omgång 7 (avsnitt 16, U63).
3. **Målbron tappas gång på gång för en båt som väntar i 0,3–0,5 kn utanför väntzonen.** Varje
   byte tömmer restidens historik och stillhetsläget, så "ETA okänd" kommer aldrig; i stället står
   en frusen siffra i upp till 20 minuter, och båten försvinner ur texten i perioder. Funnet av
   granskaren i fartspiksscenariot, finns före omgången. Hör ihop med 14.6, punkt 4.
   Mätt i omgång 7 (avsnitt 16, U62 och U64): felet finns inte i inspelad trafik, och att "ETA
   okänd" aldrig kommer beror främst på att stillhetsklockan startar först under 0,3 kn.
4. **Hur ofta beräkningen står över för stilla båtar i fält.** Det avgör hur ofta U59:s nytta och
   pris uppträder. Nästa fältprov räknar släppen i loggen (`ETA_STILL_RELEASE`).
5. Uppföljningslistan i 14.6 i övrigt (punkt 2–5).

### 15.7 Lärdomar

- **Mätningen kan säga att något inte går.** Det största felet (tiden före en väntan) har ingen
  rättning i koden, eftersom ingenting appen ser förutsäger väntan. Det beskedet sparade en omgång
  av modeller som bara hade flyttat felet.
- **Rättarens eget svep är inte granskarens.** Rättaren fällde U60 med sitt svep men friade U59
  ("högst 5 min lägre"). Granskaren byggde längre stopp, större ryck och felaktiga positioner och
  fann ett pris som var flera gånger större. Dokumentationen ska bära granskarens tal.
- **Ett villkor ska skrivas för alla regler det gäller.** Villkoret "ingen klart för låg tid vid
  ryck" sattes för U60 men gällde efter bokstaven också U59. Det som skilde dem var om felet var
  nytt eller redan fanns, och det skälet står nu i beslutet.
- **Ett fel som beror på slumpen i körningen kräver frön i testen.** U59:s fel syns bara i en del
  av körningarna; regressionstesten använder frön där det syns, och granskaren svepte 80.

### 15.8 Slutbatteriet

Kört på `9bbc276`, alltså sammanslagningen med VALIDATION; efter den commiten ändras bara detta
dokument. Alla steg slutade med kod 0. Jämförelsen görs mot slutbatteri 2 i omgång 5 (`bf646fe`,
14.8), som har samma appkod som omgång 6 utgick från.

| Steg | Utfall |
|---|---|
| `npm run lint` | 0 |
| hela jest (`--detectOpenHandles`) | 430 sviter, 6 849 test gröna, 2 överhoppade |
| `replay:all`, med och utan monitoring | alla låsta korpusar matchar facit |
| `replay:synthetic` | 228 scenarier rena, WARN 25 rader i 24 scenarier |
| `replay:openings` | standardgrindarna godkända, utskriften lika med omgång 5 |
| soak och `replay:monitoring` | 0 |
| `measure:eta` | alla 3 182 påståenden lika med omgång 5 (se nedan) |
| fassvepet, med och utan monitoring | 0 |
| `hunt:selftest` | grönt |
| snabbjakten | 45 utslag, utslag för utslag lika med omgång 5 |
| standardjakten | 220 utslag, utslag för utslag lika med omgång 5 |
| nattjakten (20 000 världar) | 2 385 utslag (2 386), 16 kandidatkluster som förut, 434 kandidatutslag (435) |
| `git status --porcelain` efter batteriet | tom |

De tre nya jestsviterna är U59:s (16 test), U60:s kända gräns (4) och mätverktygets tabell (2).
Inga kvarglömda körningar fanns före eller efter batteriet.

**Restidsmätningen mot omgång 5.** Varje påstående är lika: 3 182 totalt, 2 279 mätta, samma
summa, median och andel inom två minuter för brotext, notis och öppningskort som i 14.8. Det som
skiljer är den nya tabellen med sanningen inom 60 minuter (15.4) och räknare över kalkylatorns
interna loggrader i sju korpusar. Banken har alltså inget fall där U59 ändrar en publicerad
siffra, vilket stämmer med 15.4.

**Nattjakten värld för värld mot omgång 5** (samma seed, samma världar): tre världar skiljer sig
i utslag, och var och en kördes på koden före och efter omgången. I alla tre lämnar en båt kön
vid Järnvägsbron efter 16–60 minuters väntan, och brotexten ändras på en enda rad, den första
siffran efter avgången. Notiser och öppningsvarningar är lika.

- **14915:** "om 16 minuter" blir "om 3 minuter" där 2,9 minuter återstod till Stridsbergsbron.
  Kandidatutslaget ETA-OSCILLATION ("strax" → "om 16 minuter" → "strax" på 238 s) försvinner.
- **17318:** "om 4 minuter" blir "om 3 minuter" där 2,0 återstod. Utslaget som kom till i 14.8
  försvinner.
- **3560:** "om 20 minuter" följt av "om 4 minuter" 30 s senare blir "om 4 minuter" direkt, där
  3,9 återstod. Ett nytt kandidatutslag kommer till, ETA-OSCILLATION ("om 4 minuter" → "strax" →
  "om 4 minuter" på 224 s): mätaren räknar tre led som en oscillation men inte fyra, och förut
  stod "om 20 minuter" emellan. De två första leden gäller en annan båt, som passerar
  Stridsbergsbron medan köbåten väntar. Inget nytt fel.

Det är U59:s verkan i alla tre, och texten är närmare sanningen i varje fall. Inga utslag under
registrerade poster kom till eller försvann; registerklasserna är oförändrade (beslutat beteende
1 016, kända fall med öppet beslut 301). De 16 kandidatkorten är desamma som i 14.8.

## 16. Omgång 7, väntande båtar som saknas i texten: 24 november 2026

Tillagt 2026-11-24. Granskaren av omgång 6 fann två fel utanför rättningen (15.6, punkt 2 och 3):
en båt som väntar i mycket låg fart en bit från bron tappar målbron gång på gång, och en
stillaliggande båt försvinner ur texten efter en omstart. Omgång 7 mätte hur stora felen är i
bankens 25 korpusar och de tre fältkörningarna (28 körningar) och prövade rättningar som
prototyper. Dirigenten fattade tre beslut på ägarens uppdrag (U62–U64); ägaren kan ändra vart
och ett. Ingen kod ändrades. Omgången utgick från `omg6/integration` och ligger på grenen
`omg7/integration`. Alla tider är UTC.

### 16.1 Mätningen

Brotexten provades var 30:e sekund. En båt räknas som på väg när hon korsar Klaffbron eller
Stridsbergsbron inom 120 minuter utan att vända (rådatans linjekorsning), och området är det
avstånd före målbron där båtar i rörelse visas i minst 94 % av proven.

**Luckorna.** Av 7 165 minuter med en båt på väg i området saknades hon i texten i 1 098.
Luckor på minst två minuter: 47 episoder, 1 091 minuter.

| Orsak | Episoder | Minuter | Beslut |
|---|---|---|---|
| Förtöjd eller utan rörelsebevis vid Gästhamnen och Kajen | 32 | 615,5 | kajzonerna, förtöjningslagren |
| Långliggare i farleden (PRICKBJORN 4 h, PILOT 761 2 h) | 4 | 323,5 | U27 och tvåtimmarsregeln |
| Ingen målbro tilldelad (bland annat turbåtens rundor) | 6 | 79 | – |
| Hörd första gången medan hon låg still | 4 | 39,5 | förtöjningslager 1 (2026-06-10) |
| Målbron borttagen efter passagen, före en vändning (PILOT 761 11/11) | 1 | 33,5 | – |

Ingen episod gäller en båt som väntade och tappade målbron för låg fart. Två beror på en
appstart (BLADE 8,5 minuter, HOKUS POKUS 2).

**Borttagningarna.** Appen tog bort målbron för låg fart eller stopp tio gånger. Ingen av
båtarna korsade bron inom 60 minuter: fem låg kvar i timmar (bland dem AIR 14 timmar och
PRICKBJORN 18), två vände, och de övriga korsade aldrig eller först efter 72–93 minuter.

**Väntorna.** Av 57 väntor i farleden som slutade med passage inom en timme låg 54 inom 300 m
från en öppningsbar bro, där skyddszonen håller kvar målbron. Två låg längre ut (ANTJE 432 m,
KINNE 354 m), kröp i 1,4–1,5 kn och visades hela tiden. Den sista är slutet på PILOT 761:s två
timmar vid Stallbackabron. Väntarna stod i texten 94 % av tiden.

**Kännetecknen.** Fem minuter in i ett stopp skiljer avståndet bäst: inom 300 m från bron
framför är tre av fyra stopp en väntan, på 300–800 m ett av fyra (3 väntare, 5 långliggare, 4
vändare). Att båten kom i fart mot bron skiljer inte (CALIMA, ANDREA och PRICKBJORN kom i 3–7 kn
och låg sedan i en till fyra timmar), en annan stilla båt i närheten pekar mot gästhamn, och
ingen stoppad båt sände navstatus för ankar eller förtöjning.

**Stillhet och fart.** En minutsiffra stod i texten för en båt vars position legat still i fem
minuter i 29 minuter (20 episoder): 11,5 där U30 enligt beslut inte gäller eller ännu räknar
upp, 17,5 efter en fartspik fast positionen stod still (PILLE 4/8, 10 minuter), och 0 för en båt
som rapporterade 0,3–0,5 kn. Verkliga stilla båtar sänder 0–0,2 kn.

### 16.2 Besluten U62–U64

- **U62. Köare 300–800 m före en bro får inget eget skydd.** Frågan stod som öppen hos ägaren
  i `docs/ARCHITECTURE.md` (om köare i luckan ska skyddas av något annat än kursbruset). Felet
  finns inte i inspelad trafik, regeln tog rätt beslut tio gånger av tio, och en väntare går
  inte att skilja från en lotsbåt eller långliggare i det bandet. Riktningen är ägarens från
  2026-07-18: hellre tyst än falsk måltext.
- **U63. En stilla båt efter omstart eller vid första kontakt: ingen ändring nu.** Storleken är
  fyra episoder och cirka 40 minuter i hela underlaget, notisen kommer ändå när båten rör sig,
  och båda vägarna att rätta det för in en ny risk för falsk text.
- **U64. U30 gäller inte 0,3–0,5 kn: ingen ändring.** Stillhetsklockan startar först under
  0,3 kn och styr också förtöjningsklassningen. Inget fall finns i underlaget.

### 16.3 Det som prövades och inte gick in

- **Kö-zonen vidgad till 800 m, också mot en mellanbro.** Stängde ingen lucka i banken eller
  fältkörningarna och gav tre falska episoder: PILOT 761 11/11 10:21–10:45, still vid lotskajen
  söder om Olidebron, visad som "på väg mot Klaffbron, om 22–27 minuter" (hon korsade 93
  minuter senare); PRICKBJORN samma dag 13:30 i sex minuter (låg 18 timmar); PRICKBJORN 20/11
  07:51 i 20 minuter (vände). I byggda världar (240 körningar med väntare, 80 motfall) blev
  väntarnas luckor 42 % kortare (2 144 → 1 247 minuter), mot 450 minuter falsk "på väg" i
  motfallen (6–12 minuter per liggare, vändare eller drivare), och notisens och öppningskortets
  minut ändrades i 8 respektive 5 körningar.
- **Ett tappat mål tömmer inte restidens historik och stillhetsläget.** Ingen ändring i banken
  eller fältkörningarna; liten och blandad verkan i de byggda världarna.
- **Omstarten.** Två vägar beskrevs men byggdes inte: att spara båtarnas läge över en ordnad
  omstart, eller att visa en stilla båt direkt i farleden inom 300 m från en öppningsbar bro. Den
  senare hade i en räkning över stoppen stängt tre luckor (BLADE, ILLUSION 3, SOLUTION, cirka 45
  minuter) utan att visa någon ny långliggare, men riktningen måste då gissas ur läget, och
  regeln som hindrar det kom till efter en falsk notis vid appstart.

### 16.4 Kända gränser och uppföljning

Tre kända gränser är beskrivna med mekanism och mätning i `docs/ARCHITECTURE.md`: köare 300–800 m
före en bro (U62), U30 och fart 0,3–0,5 kn (U64), och en stilla båt efter omstart eller vid
första kontakt (U63). De två första syns bara i byggda världar; scenariot
"en-fartspik-i-30min-väntan-600m-norr-om-Klaffbron (känd gräns, U59)" visar dem, eftersom dess båt
väntar med stadig kurs och 0,4 kn genom hela stoppet. Det rättar förklaringen i 15.6, punkt 3:
målbytena tömmer stillhetsläget, men det som hindrar "ETA okänd" där är främst att
stillhetsklockan aldrig startar. 14.6, punkt 4, är samma gräns som U62.

Uppföljning:

1. **Omstarter i fält.** Fältkörningarna startade en gång var, utan väntande båt, så omstarten
   är oprövad i fält. Blir omstarter vanliga hör U63 hemma i en egen omgång tillsammans med
   registrets tre omstartsposter.
2. **Fartspikar på en stilla båt** (17,5 minuter i underlaget): en siffra står kvar en stund
   fast positionen står still. Inte utrett.
3. Uppföljningslistorna i 14.6 och 15.6 i övrigt; frågan om "strax" (15.6, punkt 1) avgjordes
   av ägaren 2026-11-24 (U65, avsnitt 17).

### 16.5 Lärdomar

- **Ett fel i en byggd värld ska mätas i inspelad trafik innan det rättas.** Båda felen var
  verkliga i scenarierna och frånvarande i 28 körningar. Scenariots båt (stadig kurs, 0,4 kn i
  30 minuter) finns inte bland 5 273 inspelade stillaminuter.
- **Det omvända måttet avgör priset.** Att räkna vad båtarna gjorde efter att regeln slagit till
  (tio av tio gick inte) sade mer än att räkna luckor.
- **En prototyp i fältkörningarna visar priset tidigare än ett svep.** Den vidgade kö-zonen såg
  bra ut i byggda världar och gav bara falska texter i fält.

### 16.6 Kontroller

Omgången ändrar dokumentationen och radhänvisningarna i registret, ingen kod och inga test.
Källradsverktyget säger att alla radhänvisningar håller, och de jestsviter som läser
dokumentationen och registret är gröna. Slutbatteriet i 15.8 gäller oförändrat för koden.

## 17. Omgång 8, väntan vid målbron: 24 november 2026

Tillagt 2026-11-24. Mätningen i omgång 6 visade att 27,5 % av brotextens felmängd var texten
"beräknad broöppning strax" medan en båt väntar direkt vid målbron (15.6, punkt 1). Frågan låg
hos ägaren, som den 24 november svarade att texten får ändras. Omgång 8 byter texten (U65) och
ändrar ingenting annat i appens beteende. Omgången utgick från `omg7/integration` och ligger på
grenen `omg8/integration`. Alla tider är UTC.

### 17.1 Beslutet U65

**Ägarens beslut 2026-11-24:** en båt som väntar vid sin målbro ska visas som väntande, inte som
"beräknad broöppning strax". Det ersätter U1/U6 (2026-08-08) och beslutet 2026-09-12, som behöll
"strax" under hela väntan.

Utformningen är dirigentens, och ägaren kan ändra den:

1. Formen är `En båt väntar vid Stridsbergsbron` (flera: `Två båtar väntar vid Klaffbron`), samma
   form som mellanbroarnas vänttext men utan "på väg mot".
2. Villkoret är köbeviset vid målbron, alltså samma bevis som förut gav "strax". Inget nytt
   avstånd och ingen ny stillhetsregel (U62 står kvar).
3. De väntande är en egen grupp, före båtarna under gång mot samma bro. Båtar under gång behåller
   sin egen rad med minuter, "strax" eller "ETA okänd". En väntande båt gör inte längre att hela
   gruppen säger "strax".
4. När köbeviset släpper (båten sätter fart, öppning pågår) går hon tillbaka till raden under gång
   och får "strax" av närhetsflaggan som förut. "Strax" betyder då åter att passagen är nära.
5. Notiser, öppningsvarningar, målbro, statusar och restidsvärden ändras inte.

### 17.2 Det som gick in

- **Texten** (`lib/services/BridgeTextService.js`): kön vid målbron räknas till köerna i stället
  för till gruppen under gång. Ordningen inom en målbro är kön vid målbron, köerna vid tidigare
  broar, sist båtarna under gång.
- **Notisens "strax"-regel (U33)** svarar nej för en båt i målbrons väntgrupp, så att notisen
  behåller sin siffra när texten inte säger "strax" för just den båten. Ingen notis ändras i
  någon inspelad körning.
- **Ledarvalet** för den visade restiden väljer bara bland båtar under gång. En variant med det
  gamla ledarvalet gav identiska texter, restider och notiser i alla körningar.
- **Test:** en ny svit med 17 test och två nya syntetiska scenarier (kö 150 m före
  Stridsbergsbron och Klaffbron), alla röda på koden före U65 utom fem avsedda regressionsskydd.
- **Loggskriptet** `run-with-logs.sh` räknar "väntar vid" i fältsammanfattningen, alla och de
  vid själva målbron, så att den lägre "strax"-räknaren i fältprov 3 inte läses som en
  försämring.
- **Verktygen:** kontrollen av långvarig "strax" (INV-10) godtar bara en bekräftad kö vid Kajen
  som förklaring, inte längre köbeviset vid målbron. Replayn bokför väntorna vid Kajen för sig,
  och buggjägarens två registerposter som byggde på att en köare bär "strax" är omprövade:
  kedjan av väntor räknar bara köer vid Kajen, och en "strax"-studs binds inte till en båt som
  står i vänttexten.
- **Dokumentationen:** `docs/bridgeTextFormat.md`, `docs/ARCHITECTURE.md` (§5 med kostnaderna),
  `docs/VALIDATION.md` (sektionen U65) och `docs/reliability-spec.md`.

### 17.3 Mätningen

Underlaget är bankens 25 korpusar och fältkörningarna, körda på koden före och efter, normalt och
med `REPLAY_MONITORING=1`.

- **Händelserna är lika.** Notiser med alla fält, öppningsvarningar, täckning, passager,
  resenollställningar, borttagningar och bekräftade väntor är identiska i varje körning.
- **Texten ändras i tio korpusar och två fältkörningar:** 194 stycken, 751,6 minuter. 44 stycken
  (455,7 min) är ren ersättning av "strax" med vänttexten, 146 (294,9 min) är en grupp som delas
  i väntgrupp och grupp under gång, och 4 (1,0 min, alla i 20260806-42h) skiljer bara i tidpunkt.
- **Vänttexten är oftast sann.** Av 1 175,5 båtminuter vänttext (41 väntor) låg båten still eller
  kröp före bron i 968 och hade en position äldre än fem minuter men låg kvar vid nästa fix i
  108,5. Förut stod "strax" i samma minuter, och passagen kom inom tre minuter i 76 av dem; i
  354 minuter dröjde den mer än en timme. MISTRAL (145 min), MOKENDEIST (142), ANDREA (130 och
  110), FILOU (101) och CALIMA (64) har sann vänttext genom hela väntan utom i glappen nedan.
- **Efter vänttexten** kommer "strax" i 17 av 41 väntor (passagen 0,2–4,3 min senare), "ETA
  okänd" i 11 (positionen har blivit gammal), nästa målbro efter passagen i 8, en minutsiffra i
  4 och i ett fall försvinner båten. Ingen väntande båt går till en siffra som är hennes egen
  och fel.
- **Gruppen under gång** visar sin egen klausul i 214 minuter där den förut sa "strax". I de 72
  minuter som går att mäta är den bättre i 69 och sämre i 1,5.

### 17.4 Kostnader och kända gränser

Alla står med mekanism i `docs/ARCHITECTURE.md` §5.

1. **Passerad under ett radioglapp** (50,5 min): en båt som tystnar vid bron och hörs nästa gång
   bortom den visas som väntande tills positionen är tio minuter gammal (ANTARES 8–9 min, AGULHAS
   och PHOENIX 7,5). I just passageminuterna var det gamla "strax" rätt. De flesta fallen ligger i
   äldre korpusar med tio minuter mellan positionerna.
2. **Växling på ett fartfix** (6 stycken, 1,1–7,9 min): ett fix över 1 kn släpper köbeviset, och
   texten säger "strax" tills stillheten bekräftats igen. FILOU 7/8 växlar sex gånger på 101
   minuter (tre på fart, tre på gammal position). Mitt i växlingen står samma "strax" som förut.
3. **En köare med gammal position under en annan båts siffra** (3 fall): CAVAT "om 15 minuter" i
   2,2 min, ELIZABETH GREENWOOD "om 8", FILOU "om 2" i 0,7 min. Förut höll en annan köares
   "strax" gruppen.
4. **Restiden bortser från kön framför.** En båt som närmar sig en bro där andra väntar visar sin
   egen tid till bron: MARY 7/8 10:39–10:57 "om 18 → 4 minuter" bredvid "Tre båtar väntar vid
   Stridsbergsbron", och hon gick igenom efter 48–66 minuter. Förut stod "strax" i samma minuter.
   Siffran är ankomsten till bron eller väntplatsen (U61); appen har ingen kömodell.
5. **Köaren vid Kajen (U23)** behåller "strax". Köbeviset gäller inte i en kajzon, så en båt som
   väntar vid Kajen norr om Klaffbron visas som förut. I underlaget syns 19 sådana båtar i 88
   minuter, varav 60,6 med eget "strax"; ingen låg över natten. Se 17.5.

### 17.5 Det som prövades och inte gick in

- **En hållning upp till 1,5 kn** (som U53 för mellanbroarna) tar bort tre av de sex
  fartväxlingarna men döljer två verkliga avgångar: CAVAT 5/8 12:15 i 2,2 minuter (hon går igenom
  bron innan hållningen släpper) och PILOT 761 18/11 13:05 i 1,2.
- **Vänttext bara med en position högst fem minuter gammal** tar bort 29 av de 50,5 passerade
  minuterna men också cirka 100 minuter sann vänttext.
- **Vänttext också vid Kajen.** Kräver ett eget, svagare bevis än köbeviset (anflygningen
  bokförs inte i en kajzon), för 8–22 minuter verklig stillhet i hela underlaget. Tas upp med
  ägaren efter fältprov 3 om köer vid Kajen syns där.

### 17.6 Omlåsningen (U13)

Textfacit är omlåst i tio korpusar (20260702-2h, 20260710-13h, 20260711-16h, 20260712-25h,
20260713-41h, 20260804-17h, 20260804-both-21h, 20260806-42h, 20260823-24h, 20260909-80h) med
`relockGoldenText`, som kräver att notiser, fördelning, riktning, öppningar, händelsefacit och
fatala invarianter är oförändrade. Dirigentens egen radvisa diff gav 191 stycken i de tio
korpusarna (41 ren ersättning, 146 delad grupp, 4 tidpunkt), samma som rättarens tal för banken,
med lika antal båtar per målbro i gammal och ny text i varje stycke utom de fyra tidsstyckena.
En kontroll mot rådatan (rätt antal båtar med senaste fix inom 400 m från bron i högst 1,5 kn)
stöder vänttexten i 744,7 av 747,0 minuter. Noterna i `corpora.js` anger rådatan per korpus och
de kända kostnaderna där de förekommer.

### 17.7 Granskningen

Den oberoende granskaren godkände koden utan fynd och begärde ändringar i verktyg och
beskrivningar: loggskriptets räknare, mekanismen bakom de fyra tidsstyckena, och två kostnader
som saknades eller var för milt beskrivna (17.4, punkt 1 och 4). Granskarens egna prov: 12 av
de 17 nya testen röda på koden före (de fem övriga är avsedda regressionsskydd), sju mutationer
som alla fälls, den gamla textregeln körd på den nya körningens indata (varje ändrat stycke är
ren regelverkan utom de fyra tidsstyckena), och fassvepet grönt på de två tätaste korpusarna.

**De fyra tidsstyckena.** En publicerad textändring ger nästa uppdatering 200 ms anstånd. I
replayn varar anståndet tills klockan stegats till nästa AIS-rad (6–30 s), så en båt som kommer
till eller byter målbro kan synas upp till 30 s senare när en ny textändring ligger precis före.
I fält är skillnaden tiondels sekunder.

### 17.8 Lärdomar

- **Sök läsare av texten utanför appkoden.** Loggskriptets sammanfattning räknade "strax" och
  hade gett en falsk misstanke om försämring i fältprov 3.
- **Kör den gamla regeln på den nya körningens indata.** Det skiljer regelns verkan från
  följdändringar i tid och gjorde de fyra tidsstyckena förklarliga.
- **En rättning kan göra en gammal gräns synlig.** Restiden utan kömodell fanns förut bakom
  "strax"; nu står den som en siffra bredvid vänttexten.

### 17.9 Fältprov 3 ska mäta

1. Hur ofta och hur länge "väntar vid <målbro>" visas, och vad som står direkt efter.
2. Växlingar till "strax" på ett fartfix och efter gammal position (17.4, punkt 2 och 3).
3. Båtar som går igenom bron under vänttexten (17.4, punkt 1): hur långa är glappen med dagens
   AIS-källor?
4. Köer vid Kajen norr om Klaffbron (17.5).
5. En minutsiffra bredvid en väntgrupp (17.4, punkt 4).
6. Uppföljningslistorna i 14.6, 15.6 och 16.4, bland annat raderna `ETA_STILL_RELEASE` och
   omstarter.

### 17.10 Slutbatteriet

Kört på `a065019`; efter den commiten ändras bara detta dokument. Alla steg slutade med kod 0.
Jämförelsen görs mot slutbatteriet i omgång 6 (`9bbc276`, 15.8); omgång 7 ändrade varken kod
eller test.

| Steg | Utfall |
|---|---|
| `npm run lint` | 0 |
| hela jest (`--detectOpenHandles`) | 433 sviter, 6 877 test gröna, 2 överhoppade |
| `replay:all`, med och utan monitoring | alla låsta korpusar matchar facit |
| `replay:synthetic` | 230 scenarier rena, WARN-raderna lika med omgång 6 |
| `replay:openings` | standardgrindarna godkända, utskriften lika med omgång 6 |
| soak och `replay:monitoring` | 0 |
| `measure:eta` | notis och öppningskort lika med omgång 6; brotexten se nedan |
| fassvepet, med och utan monitoring | 0 |
| `hunt:selftest` | grönt |
| snabbjakten | 45 utslag, utslag för utslag lika med omgång 6 |
| standardjakten | 218 utslag (220), 2 kandidatkluster som förut |
| nattjakten (20 000 världar) | 2 373 utslag (2 385), 16 kandidatkluster som förut, 429 kandidatutslag (434) |
| `git status --porcelain` efter batteriet | tom |

De tre nya jestsviterna är U65:s (17 test), buggjägarens två omprövade registerposter (5) och
INV-10 efter U65 (5); därtill ett test för loggskriptets räknare. De två nya scenarierna är
köerna vid målbron (17.2). Inga kvarglömda körningar fanns före eller efter batteriet.

**WARN-utslagen i `replay:all`** flyttar sig i tre korpusar, alla INV-18 (restiden stiger utan
passage) vid Stridsbergsbron: ett försvinner i 20260710-13h, ett kommer till i 20260713-41h
(14/7 08:41, "strax" → "om 13 minuter") och ett i 20260806-42h (7/8 10:35, "strax" → "om 18
minuter", efter en växling på ett fartfix). Det är gruppen under gång som visar sin egen klausul
där köarens "strax" stod förut (17.4, punkt 2–4).

**Restidsmätningen mot omgång 6.** Notiser och öppningskort är lika, påstående för påstående.
Brotexten har 66 fler mätta minutsiffror (1 478 → 1 544), och felsumman stiger från 24 011 till
26 024 minuter. Alla nya siffror står i en text med en väntgrupp, där gruppen förut sa "strax";
ett "strax" för en hel grupp mäts inte som siffra, så det gamla felet låg utanför summan.
Ökningen fördelar sig så här:

- **1 324 min är ett enda påstående.** S/V REBEL 6/8 10:38 visar "om 4 minuter" bredvid "En båt
  väntar vid Klaffbron" i en dryg minut. Samma siffra för samma båt står 10:31 och 10:41 både
  före och efter; restiden stod still på 3,9 minuter, och hon gick igenom bron 22 timmar senare.
- **535 min är fem båtar på väg mot en bro med kö** (17.4, punkt 4): MARY 330 (sju påståenden,
  45–49 min för tidigt), ALINDE 116, SEEBAER III 44, IL PUNTO 27 och SKYBIRD 18.
- **57 min är ett oförändrat påstående räknat två gånger till** (MOKENDEIST mot Klaffbron 7/8
  11:43), eftersom texten byts oftare.
- **99 min är övriga 45 påståenden**, i snitt 2,2 minuter fel (WANDA 5/8 11:58–12:13 med 25
  påståenden inom 0–5 minuter). Ett av dem ersätter ett likadant en sekund tidigare, så nettot
  är 66 påståenden och 2 012 minuter.

"Strax"-löftet, mätt där en enskild båt bär det, håller i 67,0 % av fallen (65,3 %).

**Jakterna värld för värld mot omgång 6** (samma seed, samma världar). I standardjakten
försvinner tre utslag (världarna 1507 och 1608) och ett kommer till under en registrerad post
(859). I nattjakten försvinner 19 utslag och 6 kommer till, och en värld (6713) får ett andra
utslag under samma registrerade post:

- **Borta:** sju INV-10 (ett "strax" som stod 37–49 minuter utan passage; texten säger nu
  "väntar vid"), tio kandidatutslag i INV-3 (köarens "strax" följt av en annan båts siffra) och
  två under posten för "strax"-studsen (värld 1608).
- **Nya:** fem kandidatutslag i INV-3 (världarna 2140, 2224, 8453, 11358 och 19599) och ett
  under posten för ledarbyte (859). I alla fem är det gruppen under gång som visar sin egen
  klausul bredvid en väntgrupp: en båt passerar och nästa har 14 minuter kvar (2140), en båt
  tappar närhetsflaggan och gruppen visar ledarens 11 minuter (2224), ledaren byts från båten
  som går igenom bron till nästa (8453) eller från 6 till 15 minuter (19599), eller
  "strax"-båten blir väntande och nästa kommer in med 3 minuter (11358). Förut dolde köarens
  "strax" samma växlingar.

Alla 23 världar som skiljer sig i utslag kördes på koden före och efter omgången. Passager,
borttagningar, resenollställningar, notiser och öppningsvarningar är lika, och båtarnas flaggor
är lika vid varje gemensam tidpunkt; bara textregeln skiljer. Registerklasserna i nattjakten:
beslutat beteende 1 016 och kända fall med öppet beslut 301 som förut, accepterade 623 (621),
mätgränser 4 (13). De 16 kandidatkorten är desamma som i 15.8.

## 18. Omgång 9, vid sidan av fältprov 3: 26–27 november 2026

Tillagt 2026-11-27. Omgång 8 (`a0d8706`) gick i fält på ägarens Homey från 2026-11-24 14:46. Två
dygn in frågade ägaren om det fanns mer att förbättra medan provet gick. Dirigenten tolkade det som
ett ja till en ny omgång vid sidan av fältprovet, med simuleringen som ett av spåren. Provet fick
inte störas: huvudkopian, där loggskriptet körs, rördes inte, allt arbete gick i egna arbetskopior
utgångna från `a0d8706`, och tunga körningar gick genom en kö med sänkt prioritet. Underlaget från
fältprov 3 var en ögonblicksbild efter 56 timmar (k4 nedan; k1 och k2 är de tidiga
fältkörningarna, k3 är fältprov 2).

Arbetsformen var densamma som förut: rättare och utredare i egna spår, oberoende granskare som
försökte fälla varje rättning med egna fall, och en dirigent som beslutade och slog samman.
Beteendebesluten fattade dirigenten på ägarens uppdrag, och ägaren kan ändra vart och ett; två
frågor rörde uttryckliga ägarbeslut (18.3): ägaren sa ja till U73 den 27 november, och den andra
väntar fortfarande på ägaren. Omgången ligger på grenen `omg9/integration-U73` (59 commits ovanpå
`a0d8706`). Paketet U66 + U73 lades sist och på en egen gren tills ägaren svarat. Samma dag sa
ägaren ja till push av omgången till `main` och till att stoppa fältprov 3 och starta ett nytt på
den nya versionen. Alla tider är UTC.

Åtta utrednings- och rättningsspår, och därefter sammanslagningen:

- **Datakällorna (K):** handskakningen mot AISstream får 30 s (U67, inne); vaktens omstart på
  AISHubs belägg (U66) och ett belägg för larmet (U73) är inne efter ägarens ja.
- **Båtar som tystnar (T):** texten för en tyst båt lämnas som den är (U68), och sändare som inte
  är fartyg ignoreras (U69, inne); den "båt" som startade spåret var en räddningshelikopter.
- **En enda källa (G):** felen när bara den ena källan levererar är kända gränser (U70).
- **Robustheten (R):** tre fel funna med felinjektion är rättade och tre förslag till inne (U72);
  tidsgränsen för tidslinjenotisen ströks.
- **Fältfångsten (L):** löpnummer och omsändning, så att ett fältprov med hål i loggströmmen kan
  låsas när inget saknas (U71, inne); grinden godkänner bara en körning med en appstart och en
  fångstström (U77).
- **Simuleringen (S):** ett verklighetsmått för buggjägarens världar och två nya profiler, `falt`
  och `blandad`; de gamla profilerna är oförändrade.
- **Returen från kaj (V):** en båt som lägger till strax bortom en målbro och går tillbaka genom
  den får ingen varning, en känd gräns (U75).
- **Triagen av de nya profilernas kort (W):** ett latent fel i appen utan rättning (U76) och fem
  drag i världarna som inte finns i verkligheten, alla rättade.

### 18.1 Fältprov 3 efter 56 timmar

Dirigentens genomgång 2026-11-26 av ögonblicksbilden:

- **Stabilt.** Inga krascher eller omstarter; minnet gick från 14 till 19,5 MB och planade ut.
- **Notiser och varningar.** Sju fartyg gick genom kanalen. 42 av 42 notiser och 14 av 14
  öppningsvarningar kom, passagen 2–10 minuter efter varningen, och den utlovade tiden var som mest
  3,4 minuter fel (INGRID B: lovat 7, blev 10,4).
- **Väntan.** LIDAN låg still söder om Järnvägsbron 26/11 17:10–17:24, och texten "En båt väntar
  vid Järnvägsbron på väg mot Stridsbergsbron" stod 17:08:55–17:25:47. Vänttexten vid målbron
  (U65) hade inte visats; ingen båt hade väntat vid en målbro.
- **AISstream var opålitlig.** 102 handskakningar löpte ut, vakten startade om en ansluten men tyst
  AISstream 37 gånger, och tre tidslinjemeddelanden gick ut; i fältprov 2 var talen 0, 15 och 2 på
  133 timmar.
- **En båt som hördes en gång.** LIFEGUARD 007 hördes en enda gång (25/11 12:41). Texten sa "En båt
  på väg mot Stridsbergsbron, beräknad broöppning strax" i fem minuter, och hon stod i texten i
  femton.
- **Hålen i loggströmmen är tappade loggrader, inte en paus i appen.** Fältprov 3 hade ett hål på
  79 s (25/11 20:09:31–20:10:50), fältprov 2 tre. AISHub-räknaren för dubbletter gick vidare genom
  hålen och pollens fas var oförändrad: appen hämtade data, och raderna försvann på vägen från
  Homey. Det svarar på 14.6, punkt 3.

AISstreams opålitlighet gav spår K och LIFEGUARD 007 spår T; R och S gick i samma första våg utan
ett enskilt fältfynd. Hålen gav spår L, och G, V och W kom till ur det de andra spåren fann.

### 18.2 Översikt

| Spår | Utfall | Commits på `omg9/integration-U73` |
|---|---|---|
| K (U66, U67, U73) | U67 inne; paketet U66 + U73 godkänt i tredje granskningen och infört efter ägarens ja | `0cc927f`, `c373880`, `0e0d096`, `43c9eeb`, `1c540a0`, `d7986ba`; `7f6a618`, `e40f856` |
| T (U68, U69) | U68 dokumentation och två scenarier, U69 inne; båda godkända | `2b48709`, `a3aed68`, `fd674eb`, `7096761`, `785377e`, `d155576` |
| G (U70) | ingen kod; kända gränser och fyra scenarier | `1ff638e`, `cb30d20`; `d7e5f5f` |
| R (U72) | R1–R3, klockstegets loggrad, taket vid laddning och MMSI-normaliseringen inne; tidsgränsen för tidslinjenotisen införd och återtagen | `a899d6e` … `ea9e7de` (15 commits); `dba7de3`, `8c8a093` |
| L (U71, U77) | inne; grinden begränsad till den enkla körningen efter fem granskningsvarv | `d6bc61d`, `b1265c7`, `389324d`, `43c892f`, `994806a`, `226fe65`; `a24b3ff` |
| S | profilerna `falt` och `blandad`; registerposterna borttagna efter granskningen | `8f8f6ff` … `cab33a0` (7 commits), `95856b3`, `581c09d`, `5b9f589` |
| V (U75) | ingen kod; känd gräns och ett scenario | `2675127`, `17dcc65`; `3697fef` |
| W (U74, U76) | ingen kod i appen; rättelserna i världarna gick in med S | – |

Commits efter semikolon är radhänvisningar efter sammanslagningen och ett bytt testexempel
(`8c8a093`, 18.4). I R återtar `6a8e6db` tidsgränsen `a2472b8`, och i S tar `7238de3` bort de två
registerposter som `114bf5a` lade in. `51b23c3` sätter antalet syntetiska scenarier i
`docs/VALIDATION.md` till 239 (förut 230).

### 18.3 Besluten U66–U77

**Frågorna till ägaren.**

- **U73, larmet kräver belägg (rör ägarens U29), och U66 följer med.** En förtöjd lotsbåt
  rapporterar var tredje minut och AISstream hör ungefär var fjärde rapport, så tystnader på 20–25
  minuter är normala. I dag går tidslinjemeddelandet och statusen "Degraderad" ut efter 25 minuters
  tystnad medan AISHub levererar; av 9 meddelanden på 476 timmar inspelad trafik pekade 2 på ett
  verkligt fel. Förslaget: larmet kräver dessutom minst 40 nya AISHub-positioner under tystnaden och
  släpps senast efter 150 minuter. Mätt: 2 meddelanden, båda verkliga. Priset: en död AISstream syns
  senare, i fältprov 3:s trafik i median efter 93 minuter i stället för 25; under tiden ger AISHub
  ensam samma notiser och varningar (18.6). **Dirigenten rekommenderar U73.** U66 och U73 hör ihop:
  utan U73 kan larmet komma före vaktens första omstart medan texten säger att vakterna försöker
  återansluta; med U73 kommer det alltid efter (31 positioner före 40, 120 minuter före 150).
  **Ägaren sa ja den 27 november 2026** ("låter bra"): U73 ändrar ägarens beslut U29 på ägarens
  besked, och U66 följer med eftersom de två hör ihop. Paketet är infört: `c373880`, `0e0d096`,
  `43c9eeb`, `1c540a0` och `d7986ba`, och radhänvisningarna i `e40f856`.
- **Ett möjligt val, inte rekommenderat nu: aldrig "strax" på en position äldre än 5 minuter i
  stället för 10 (rör ägarens U16).** Priset och nyttan står i 18.5; i fält med båda källorna är
  skillnaden 0–3 minuter. Prototypen och mätningen är sparade i omgångens underlag. Väntar på
  ägaren.
- Ägaren har sagt ja till push och till ett nytt fältprov på den nya versionen (ingressen).

**Dirigentens beslut.**

- **U66. Vakten startar om AISstream först när det finns skäl.** I läget med båda källorna krävs,
  utöver dagens tystnadsgräns och trappa, minst 31 nya AISHub-positioner under tystnaden. Svarar
  AISHub inte, eller har det inte kommit någon ny AISHub-position på 15 minuter, gäller dagens
  regel, liksom när bara AISstream används. Efter 120 minuters tystnad startas anslutningen om
  oavsett. Skäl: ingen av vaktens 52 omstarter i fältprov 2 och 3 lagade något, och i fältprov 3
  kostade de 93 utlöpta handskakningar och 66 minuter utan anslutning. Priset: en hängd
  prenumeration lagas senare (median 77 minuter en lugn vintervecka, högst 120). Går in bara med
  U73, och båda är inne.
- **U67. Handskakningen får 30 s i stället för 15.** I fältprov 3 tog lyckade handskakningar 11,5 s
  i median, och 73 % av försöken löpte ut vid 15 s.
- **U68. Texten för en tyst båt lämnas som den är.** Ingen regel gör fler minuter sanna utan att ta
  bort sann text (18.5).
- **U69. Positioner från sändare som inte är fartyg ignoreras helt.** En helikopter ska inte ge "En
  båt på väg mot Stridsbergsbron" (18.4).
- **U70. Ingen kodändring för felen med en enda källa.** Rättningarna fälls av sina egna kostnader
  (18.5).
- **U71. Fältfångsten får löpnummer och omsändning, och en körning med tidshål får låsas när
  löpnumren visar att fångsten är hel.** Ett femdygnsprov blir hålfritt bara med några procents
  chans. Omsändning efter 60 minuter valdes bort.
- **U77. Fältfångstens grind godkänner bara den enkla körningen.** En numrerad logg kan bli godkänd
  bara med exakt en appstart och exakt en fångstström utan byte av loggnivå. En omstart, en andra
  ström eller ett byte av loggnivå ger som bäst DELVIS, och en sådan körning låses inte utan
  handbedömning. Skäl: granskningen fann i varv efter varv en ny väg till falskt godkänt, och alla
  utom den första gick genom en omstart eller ett byte av ström. Ett fältprov startas en gång på
  full nivå och stoppas en gång, så regeln kostar ingenting i normalfallet. Den begränsar vad
  grinden påstår i stället för att laga en väg i taget.
- **U72. Robustheten.** Klocksteg bakåt blir känd gräns med loggraden `[CLOCK_STEP]`; fyra sparade
  kartor utan tak får tak 2048 vid laddning; kapaciteten blir känd gräns (300 båtar mättar
  sannolikt Homey, fältet har haft ungefär 20). Ett MMSI som inte är rena siffror normaliseras eller
  avvisas. Tidsgränsen för tidslinjenotisen ströks (18.5).
- **U74. En vild position bortom brolinjen som bokför passagen för tidigt rättas inte.** I en byggd
  värld väntar en båt 25 m före Stridsbergsbron, och en enda AISHub-position i 2,7 kn hamnar 41 m
  bortom linjen. Passagen bokförs sex minuter för tidigt, texten byter till nästa målbro medan båten
  ligger kvar, och den verkliga korsningen bokförs inte. I inspelad trafik finns 257 grannpar under
  3 kn inom 150 m före en målbro och inget sådant fall. Rättningen är samma ombyggnad av GPS-grinden
  som U57 avstod; känd gräns bredvid U57.
- **U75. Returen från kaj nära en målbro är en känd gräns under ägarens U18** (18.5, 18.6).
- **U76. Ingen rättning nu av återkorsningens latitudprov** (18.4). Mät först de äkta
  återkorsningarnas segment.
- **Dessutom:** de två nya registerposterna togs bort (18.5); U38 står kvar med nytt skäl (18.5);
  returen efter en U-sväng i farleden (buggjägarens kort, varningen 43 s före korsningen) är känd
  gräns tills ett inspelat fall finns, eftersom ingen av de fem inspelade returerna genom en målbro
  är det fallet. Tips till ägaren, inget krav: nätverkskabel till Homey och datorn kan minska hålen
  i loggströmmen; effekten är okänd.

### 18.4 Det som gick in

**U67 (K)** godkändes i första granskningen, prövad mot en riktig websocket; en server som aldrig
svarar upptäcks 15 s senare. Sju felinjektionsprov i återanslutningsvägen gick in som
regressionsskydd. Om handskakningar på 15–30 s lyckas syns först i nästa fältprov.

**Paketet U66 + U73 (K)** gick tre granskningsvarv. Första varvet godkände kärnlogiken men fällde
två luckor: en AISHub som svarar tomt eller bara med gamla positioner räknades som belägg (en hängd
AISstream startades om efter 119 minuter i stället för 19), och larmet saknade tak (352 minuter med
en AISHub som svarar glest). Belägget kräver nu en AISHub-position inom 15 minuter, vilket kostar 0
extra omstarter på 476 timmar, och larmet har taket 150 minuter. Dirigentens tillägg i samma varv
fälldes i andra varvet (18.5). Tredje varvet godkände: i granskarens 33 prober får inget läge fler
omstarter än basen, och varje tystnads första notis har en vaktomstart före sig.

**U69 (T).** LIFEGUARD 007:s enda position låg i 14,6 kn 569 m från Stridsbergsbron enligt appens
avståndsmått, och lika långt från kanalens farledslinje. Hennes MMSI börjar på 111 och Sveriges landskod; 111 är räddningsflyg
enligt ITU-R M.585, och granskaren bekräftade att hon är Sjöfartsverkets räddningshelikopter 007.
Över 31 inspelade filer (42 300 positioner) är hon den enda sändaren som inte är ett fartyg.
Kontrollen sitter i appens gemensamma ingång och ignorerar 111 (räddningsflyg), 970, 972 och 974
(nödsändare), 979 (autonoma radioanordningar som nätbojar), 99 (sjömärken), 00 (kuststationer) och
0 (gruppanrop); farkoster till ett moderfartyg (98), handhållen VHF (8) och fartyg släpps igenom.
111, 99, 00 och 0 gäller bara med en giltig landskod på sin plats (201–775), så att en fritidsbåt
med ett felprogrammerat nummer som 111111111 syns som förut. Positionen spelas in i fältfångsten men
ger inget fartyg, och appen skriver `[NON_VESSEL_IGNORED]` på felsökningsnivå. Banken, k1–k3 och
grindarna är bitlika med basen; i k4 försvinner exakt räddningsflygets tre textrader. Godkänd i båda
varven, med alla mutanter fällda i det andra.

**U68 (T).** Ingen kod. De kända gränserna står i `docs/ARCHITECTURE.md` §5, och scenarierna
`tystnar-200m-före-Stridsbergsbron-6kn-passerar-i-glappet-hörs-efter-40min (känd gräns, U68)` och
`en-enda-position-14kn-utanför-farleden-vid-Stridsbergsbron-aldrig-mer (känd gräns, U68)` låser
förloppet minut för minut.

**U70 (G).** Ingen kod. Spåret rättade två uppgifter i underlaget: felet i texten med AISHub ensam
gällde PILOT 761 den 11/11, inte PRICKBJORN den 12/11, och de två falska varningarna med AISstream
ensam har var sin syster som var falsk också med båda källorna. Mekanismerna:

| Mekanism | Fall i k1–k4: båda / AISHub / AISstream | Vad användaren ser |
|---|---|---|
| T1. Fristen (varna 180 s före den tidigaste ankomsten i 10 kn) löper ut i ett glapp | 0 / 0 / 8 | varningen 3,5–20 min tidigare än med båda källorna |
| T2. Spärren vid en tidigare bro håller en båt i gång bara 300 s utan ny position | 0 / 0 / 6 | varning 6–35 min för tidigt med "ETA okänd" (VISTEN 21/11: 33 min före passagen, med båda källorna 1) |
| T3. Samma reservsläpp för en stilla båt (U38) | 0 / 0 / 3, varav 2 falska | varning för en båt vid kaj som passerar timmar eller dagar senare |
| H1. En båt som lägger ut efter lång förtöjning saknar historik, så spärren vid Järnvägsbron gäller inte | 0 / 1 / 1 | PRICKBJORN 12/11: Klaffbronvarningen 26,5 min före passagen i stället för 3,8 |
| H2. En vändning vid kaj 220 m från bron bekräftas först under bron | 0 / 1 / 1 | PILOT 761 11/11: ingen varning för Stridsbergsbron (med båda källorna 2,4 min före) |
| H3. Följd av H2: köbeviset får sitt första läge 77 m från Järnvägsbron | 0 / 1 / – | "på väg mot Klaffbron, om 13 minuter" i 35 min i stället för "väntar vid Järnvägsbron" |
| N1–N3. Ingen position på ena sidan om Stallbackabron; lotsbåt som lägger ut vid Kanalinfarten; vändning som inte bekräftas i glappet | 0 / 0 / 13 | uteblivna notiser för Stallbackabron, Kanalinfarten och Stridsbergsbron |

Med båda källorna gick ingen varning i fältkörningarna på en position äldre än 120 s (74 av 74).
Med glesa sändare finns mekanismen ändå: i bankens sommartrafik gick 26 av 97 varningar på
reservsläppet eller fristen i ett glapp, 15 av dem falska mot rådatan. Mekanismerna står i
`docs/ARCHITECTURE.md` §3, och fyra scenarier "(känd gräns, U70)" låser H1, T2, T3 och N1. Ingen
oberoende granskning av spår G finns i underlaget; spåret ändrade ingen kod.

**R1–R3 och U72 (R).** Spåret prövade hela appen med falsk klocka och en Homey-attrapp där varje
gränssnitt kunde felinjiceras, upp till 300 samtidiga båtar och 60 dygn. Det mesta hanterades
redan. Tre fel rättades:

- **R1, en andra "öppnar snart" efter en klumpleverans.** En båt passerar Klaffbron medan nätet står
  still en dryg minut utan att anslutningen bryts. Sedan levererar websocketen tre positioner i
  samma läsning (88 m före, 13 m före och 60 m efter linjen) med samma mottagningstid, och
  användaren får en andra varning efter passagen; tio minuters paus gav sju extra. Första varvet
  hoppade över varje ersatt fartygsobjekt och fälldes: i en klump är det första fixet ofta det enda
  giltiga, eftersom de senare rört sig utan tidsskillnad och avvisas av GPS-grinden. Med nätstopp
  två minuter var tionde minut över banken försvann två varningar helt, en kom 36 minuter för
  tidigt och sex 2–9 minuter för tidigt. Andra varvet följer granskarens förslag (det ersatta
  objektet observeras, bara passagebokföringen hoppas över); varje varning har då samma tid och
  avstånd som basen, och fyra sena dubbletter är borta. Felet har sannolikt aldrig hänt i fält.
- **R2, en framtida stämpel i den sparade notisspärren.** Gick Homeys klocka före när en båt fick
  sina notiser, fick hon inga notiser vid samma broar nästa gång. En stämpel mer än 120 s fram sätts
  nu till "nu", också för sista kända position; att radera den i stället fälldes, eftersom ett
  klocksteg bakåt då raderade alla färska positioner och en båt som återföddes i kö tappade två
  notiser.
- **R3, en andra `onInit` utan `onUninit`.** Minutloopen och fem städintervall läckte, och den
  läckta loopen tog bort en båt en halvtimme efter avstängningen. `onInit` stänger nu först den
  förra körningen.

Av U72 gick klocksteget (`[CLOCK_STEP]` när väggklockan gått mer än 60 s bakåt), taket 2048 vid
laddning och MMSI-normaliseringen in. Hela spåret gick tre granskningsvarv. Vid sammanslagningen föll
ett av spårets test, som använde `002650995` som exempel på ledande nolla; det numret är en
kuststation, som U69 ignorerar. Exemplet byttes (`8c8a093`); inget beteende ändrades.

**U71 (L).** Raderna försvinner i strömmen från Homey till `homey app run`: loggfilen är byte för
byte lika med terminalens rålogg och har samma hål, och kommandoradsverktyget prenumererar utan
kvittens eller återsändning. På `debug_level = full` får nu varje rad som uppspelningen och
fältjämförelsen läser ett löpnummer per appstart. Raderna hålls i en buffert (högst 1 000 poster)
och skrivs igen efter 2 och 10 minuter, och en kontrollpunkt skrivs varje minut. Loggskriptet läker
fångsten. Grinden (`docs/VALIDATION.md` §Fältprov, grind 1) godkänner ett tidshål bara när inget
löpnummer saknas, och låsning kräver att svansen är bevisad: skriptet skriver vid stoppet hur länge
loggfilen varit tyst, mätt med datorns klocka, så att beviset inte blandar Homeys och datorns
klockor. Grinden godkänner dessutom bara den enkla körningen, med en appstart och en fångstström
utan byte av loggnivå (U77); allt annat blir som bäst DELVIS. Rättningen läker alla nio uppmätta
hål, inte ett avbrott längre än tio minuter, och kostar 7–10 % mer logg på full nivå. Appens del
(journalen) är oförändrad sedan första varvet; allt som ändrades efter det gäller testverktyget.

Granskningen gick i fem varv, och nästan varje varv fann en ny väg till falskt godkänt:

- **Varv 1.** Koden höll (inget falskt godkänt i 12 riktade fall och 3 000 slumpvisa förvanskningar,
  uppspelningarna bitlika i 87 av 87 körningar), men testen höll inte: 16 av granskarens 26
  mutanter av grinden överlevde, sex med falskt godkänt. Fallen blev test.
- **Varv 2.** En för tidig stopptid, en tid utan tidszon eller en Homey-klocka som går före datorn
  gav "Svansen bevisad" trots ett hål som nådde stoppet. Svansbeviset byggdes om på loggfilens
  tystnad.
- **Varv 3.** Klockfelet var stängt, men rättaren hade utanför uppdraget lagt till en regel om
  omstarter, och den gav en ny väg: en omstart på full nivå följd av ett hål som nådde stoppet
  godkändes. Dirigenten beslöt en sista rättelse exakt enligt granskarens förslag och förbjöd allt
  utöver de angivna punkterna.
- **Varv 4.** Rättelsen höll, men omstartsregeln gav en väg till: två täta omstarter där den
  mellersta processens rader försvann godkändes, och ett fall från första varvet (en omstart på
  lägre nivå, full nivå påslagen igen och den nya strömmen borta) hade aldrig fångats. Dirigenten
  beslöt U77: omstarter lyfts ut ur beviset.
- **Varv 5.** Spärren tog bort alla vägar genom omstarter, men undantaget för en sänkt loggnivå före
  stoppet gick att använda: nivån sänks, full slås på igen, allt efter nivåbytet försvinner, och
  loggen har ändå bara en appstart och en ström. Byte av loggnivå ger därför också DELVIS.
  Granskarens slutdom över hela spåret efter sex varv är godkänt: i 3 000 slumpkörningar med
  omstarter och nivåbyten gav ingen numrerad logg med förlust godkänt utanför det dokumenterade
  fönstret, och förlusterna i de godkända körningarna låg alla inom de sista 13 sekunderna före
  stoppet.

**U75 (V).** Ingen kod. Den kända gränsen står under U18 i `docs/ARCHITECTURE.md` §4, och scenariot
`retur-från-Kajen-220m-norr-om-Klaffbron-en-fix-före-bron (känd gräns, U75)` låser dagens utfall.
Spåret rättade två uppgifter från spår S: korsningen 5 augusti ligger strax före ELFKUNGENS position
12 m söder om bron, inte mitt i ett tolv minuter långt glapp, och texten "En båt på väg mot
Stridsbergsbron, ETA okänd" i 86 s (20260710-13h) bars av MALVA, en verklig båt som passerade under
AIS-tystnad, inte av en arbetsbåt vid Stallbackabron.

**Simuleringen (S).** Profilen `falt` (1 000 världar) har fyra fältfamiljer: lågsäsong med ett
ensamt lastfartyg, en lotsbåt och en arbetsbåt som gör en av bankens inspelade kajflyttar;
källbortfall; en båt som hörs en enda gång i 10–16 kn nära en bro; och väntan vid målbron med kryp,
tystnad och en andra båt. Radiomodellen ger båda källorna samtidigt med fältprov 2 och 3:s
fördelningar (bara aggregat i repot) och fusionens regel att en AISHub-position levereras bara när
den är nyare än båtens senaste; utan den regeln gav första körningen tre kort där båtar gick bakåt.
En inflygningsprofil låter transiterna sakta in och krypa fram till 20–80 m före bron. Profilen
`blandad` (2 000 världar) är de nio gamla familjerna med inflygningsprofilen och båda källorna. De
gamla profilerna är oförändrade: snabb- och standardjakten ger samma rapport som i omgång 8, och
granskaren prövade 2 190 nattvärldar värld för värld. Första granskningen fällde två saker:
familjen med väntan vid målbron räknade köerna vid alla broar (fel i 93 av 298 världar), och de två
registerposterna (18.5). Båda rättades, och andra varvet godkände. Världsrättningarna efter
triagen (18.6) fördes in utan eget varv; bara de valbara profilerna berörs.

**Triagen (W)** fann ett latent fel: beviset för en återkorsning jämför bara latitud. Två positioner
1 s isär (först AISstream, sedan AISHub) med 3 m bakåtbrus över Stridsbergsbrons mittlatitud gav en
falsk vändning och en andra öppningsvarning 40 s efter passagen. Det har aldrig hänt i inspelad
trafik (3 återkorsningar i 29 körningar, alla äkta; 0 av 4 179 radpar nära broarna spänner över en
bros mittlatitud) och utlöstes av att världen gav två källors rader för samma sändning olika brus.
U76: ett krav på segmentets längd kan fälla en äkta långsam återkorsning, och ett villkor på
brolinjens tecken hade fällt det äkta fallet i k3. De äkta segmenten är cirka 224, 121 och 210 m.

### 18.5 Det som prövades och inte gick in

- **Notisomstarten (K, dirigentens tillägg).** Vakten skulle starta om AISstream när tystnadslarmet
  skickas, så att U66 kunde gå in utan U73. En tidslinjenotis som avvisas gång på gång gav en
  omstart i minuten: 156 på tre timmar mot basens 3 (69 med U73), och två av tre villkor saknade
  test. Borttagen helt.
- **Tidsgränsen för tidslinjenotisen (R).** Ett anrop till `createNotification` som hänger spärrar
  samma anslutningsvarning i 24 timmar. En gräns på 60 s med återrullning gav en notis i minuten när
  tjänsten svarar långsamt men levererar: 30 på 30 minuter mot 1 på basen, vid svarstider på 90 och
  150 s. Nyttan var liten (läget syns ändå i `connection_status`), och rättningen blev värre än
  felet. Återtagen; den hängande notisen är känd gräns.
- **De två registerposterna (S).** `U62-KÖ-300-800M` och `U17-EN-FIX` klassade 0 utslag i de gamla
  profilerna, men predikaten var bredare än besluten. U17-posten prövade inte U17:s mekanism (släppet
  för en tyst båt, hållen, kursen), kunde uppfyllas i 159 av 2 000 standardvärldar, 90 av dem för
  båtar som hörs igen, och stod före fyra poster för kända öppna fall. U62-posten godtog varje sen
  eller utebliven varning upp till 30 minuter efter ett stopp 300–800 m ut, utan att pröva att
  målbron tappades. Borttagna; registret är identiskt med `a0d8706`.
- **Rättningarna för en enda källa (G).** Prototyper spelade över fältkörningarna i alla tre
  varianterna, bankens 25 korpusar och grindarna:
  - *Reservvarningen för en stilla båt efter 10 minuter i stället för 5 (rör U38).* Båda falska
    varningarna försvann, men LIANNE 12/11 med AISstream ensam fick varningen 1,1 minut efter
    passagen i stället för 3,9 före, och med båda källorna sjönk ledtiden till 1,4 minuter för två
    båtar i banken; 73 av 450 varningar i banken flyttades. **U38 står kvar med nytt skäl:** fem
    minuter ger för tidiga och falska varningar, tio ger en varning efter passagen, och ingen gräns
    tar bort båda.
  - *Spärren för en båt i gång längre än 300 s, räknad på egen fart.* Fältfallen kom 4–26 minuter
    närmare passagen, men två bankvarningar kom 31 och 36 s före passagen (golvet är 60 s), en kom
    efter, och ett scenario blev rött. I tystnad går inbromsning inte att skilja från acceleration.
  - *P2: en avgång efter lång förtöjning behandlas som efter en vändning.* Rättade H1 med AISHub
    ensam och ändrade inget i inspelad trafik, men i en byggd värld (båten lägger ut, tystnar och
    går genom tre broar i 9–10 kn) kom varningen 36–66 s före passagen i stället för 202–232 s. En
    sen varning är värre än en tidig. Prototypen sparas.
  - *Vändningen bekräftad på svagare underlag (H2)* byggdes inte: förtöjda båtar vid broarna ger
    just sådana bruspositioner, och varje falsk vändning nollar resan.
- **R-KAJ, returen från kaj (V).** Stillhetsläget plus en position i minst 2 kn mot bron och minst
  50 m närmare räknas som bekräftad vändning; prövad på rådata. Regeln slår till två gånger i hela
  underlaget: ELFKUNGEN 7/8 53 s före korsningen och PILOT 761 k1 med AISHub ensam 10 s. Den bryter
  U18, 53 s ligger under grindens golv på 60 s, och utan kravet på samma resa hade den varnat för
  PRICKBJORN i k3, som efter ett dygns förtöjning gick 150 m mot Klaffbron i 5,6 kn och vände. En
  varning redan före avgången vore falsk för 5 av 8 båtar som lägger till bortom en passerad bro.
- **Regeln för tysta båtar (T).** Över 29 körningar och, för prototypen, 120 världar:

  | Alternativ | Nytta | Kostnad |
  |---|---|---|
  | "Strax" bara på en position yngre än 5 min | 98 min falskt löfte blir "ETA okänd"; 206 min "strax" för en passerad båt blir utan löfte | 18,5 min sann "strax"; växlingarna 29 → 39; omlåsning av cirka 20 korpusar; skärper U16 |
  | Samma med 3 eller 2 min | 187 + 319 respektive 258,5 + 396 min | 49,5 respektive 78,5 min sann "strax"; 50 respektive 83 växlingar (gränsen hamnar på en långsam klass B-båts rapporttakt) |
  | Ta bort en tyst båt nära bron | 402,5–408 min blir sanna | 154,5–191 min "Inga båtar" medan en båt väntar (NEST, TRUNTEN, DIONE korsade 38–45 min senare) |
  | Visa en båt först vid andra positionen | tre båtar som aldrig hördes igen | 169 av 172 inträden på en enda position får siffran senare (median 1,5 min) |
  | Räkna ned den frysta siffran efter 90 s | 67,5 min fler siffror inom marginalen | 516,5 min sämre mot 303,5 bättre |
  | Vänttexten bara på en position yngre än 5 min | – | 245 min sann vänttext |
  | Kortare visningstid än 15/20/25 min | – | efter 15 min: 177 min båtar som låg kvar mot 158,5 min passerade |

  Ingen regel ändrar notiser eller öppningsvarningar. För en riktig båt som hörs en enda gång i hög
  fart (ett fall till, 2026-08-04 i 13 kn) finns ingen regel; det bevakas i fält.
- **Övrigt.** Granskarens förslag mot en ny båts dubbla varning efter en klump över en bro (18.7)
  och förslaget att bara skicka vidare klumpens nyaste position byggdes inte; felet har aldrig
  setts i fält. En farledskorridor (ingen annan båt i texten har legat mer än 250 m från
  farledslinjen) är en möjlig följdfråga till U69; appen har ingen farledsmodell. Fältfångst genom
  appens webb-API eller en fil på Homey är inte värd kostnaden så länge hålen är korta.

### 18.6 Mätningarna

**AISstream är gles, inte trasig.** Andel av ett fartygs rapporttillfällen där AISstream hade en
position:

| Körning | Alla fartyg med minst 50 tillfällen | PILOT 761 (förtöjd) | Glapp, median / p90 |
|---|---|---|---|
| k1 | 28 % | 26 % | 1,5 / 5,0 min |
| k2 | 27 % | 20 % | 1,4 / 4,3 min |
| k3 | 26 % | 22 % | 2,2 / 7,2 min |
| k4 | 22 % | 21 % | 3,3 / 12,0 min |

Det som ändrats är antalet sändare: i fältprov 3 fanns i stort sett bara PILOT 761. Socketen levde
vid varje omstart, och nästa position kom inte fortare efteråt (k4: median 9,2 minuter från den nya
socketen, 6,0 från en slumpvis tidpunkt). Omstarterna simulerade på de råa ankomsterna, under
antagandet att en omstart inte ändrar när nästa position kommer:

| Underlag (476 h) | Dagens regel | U66 + U73 |
|---|---|---|
| k1 | 4 (socketen var nere; i praktiken 0) | 4 (dagens regel; i praktiken 0) |
| k3 och k4 | 15 och 37 | 0 och 0 |
| 20260804-both-21h | 4 | 3 (AISstream dog och kom aldrig tillbaka) |
| 20261114-34h | 1 | 1 (31 AISHub-positioner på 23,3 min; kan ha varit en verklig hängning) |
| övriga sju | 10 | 0 |
| **Summa** | **71** | **8** |

Tidslinjemeddelanden: dagens villkor 9 (2 verkliga), U73 2 (båda verkliga). Under en frisk
AISstream-tystnad har AISHub levererat högst 24 positioner, och gränsfallet 14/11 har 31. Vaktens
gräns ligger därför vid 31 och larmets, med marginal till gränsfallet, vid 40.

**En källa i taget.** Fältkörningarna rekonstruerade per källa och uppspelade:

| Körning | Notiser | Saknas / mer än 30 s senare: AISHub ensam | AISstream ensam | Varningar saknas / extra: AISHub | AISstream | Båt saknas i texten (min): AISHub / AISstream |
|---|---|---|---|---|---|---|
| k1 | 45 | 0 / 4 | 4 / 24 | 1 / 0 | 1 / 1 | 30 / 56 |
| k2 | 36 | 0 / 3 | 3 / 24 | 0 / 0 | 0 / 0 | 2 / 12 |
| k3 | 93 | 0 / 4 | 8 / 57 | 0 / 0 | 0 / 1 | 3 / 125 |
| k4 | 42 | 0 / 4 | 0 / 27 | 0 / 0 | 0 / 0 | 2 / 30 |

AISHub ensam ger i k2–k4 samma notiser och varningar som båda källorna; avvikelserna i k1 är H1 och
H2. Två av de 15 "saknade" notiserna med AISstream ensam gick, men med riktningen "okänd". Fusionen
med en död källa ger samma utfall som enkälleläget. AISHub bär appen; en användare utan AISHub-konto
får öppningsvarningar som ofta kommer 5–35 minuter för tidigt.

**Tysta båtar.** Båtminuter i texten med en position äldre än 90 s, mot rådatans linjekorsning:

| Underlag | Timmar | Målbropassager | Båtminuter | Felminuter | Per 10 passager |
|---|---|---|---|---|---|
| banken utan AISHub (16 korpusar, sommar) | 254 | 305 | 3 712 | 2 063 | 68 |
| banken med AISHub (9 korpusar) | 262 | 142 | 1 314 | 426 | 30 |
| fältet k1–k4 (november, båda källorna) | 255 | 72 | 60,5 | 2,5 | 0,3 |

"Strax" för en tyst båt var fel i 836,5 av 994 minuter (508 säkert): en båt tystnar vid bron, går
igenom inom 1–3 minuter och hörs nästa gång långt bortom. "ETA okänd" står sedan kvar, 476,5 minuter
för en båt som redan passerat. Vänttexten var rätt i 916,5 minuter och fel i 114,5. I slumpade
världar, där den verkliga korsningen finns, var ett "strax" som mätningen kallade fel också fel i
97 % av minuterna.

**Hålen i loggströmmen.** Nio korta hål på cirka 255 timmar fältlogg, ett per 28 timmar: k1 90, 90
och 156 s inom tio minuter (dessutom 4,5 timmar då Homey själv tappade nätet), k2 90 och 88 s, k3
90, 90 och 180 s, k4 79 s. Förlorat: 19 positioner, alla från AISHub, och ingen brotext, notis eller
öppningsvarning. De går inte att återskapa.

**Verklighetsmåttet för buggjägarens världar.** Samma definitioner på banken (sommar), vintern (k3
och k4, 189 h) och världarna:

| Mått | Banken | Vintern | Standardvärldarna | `falt` | `blandad` |
|---|---|---|---|---|---|
| Klaffbronkorsningar per timme | 0,40 | 0,12 | 1,12 | 0,35 | – |
| Andel av tiden med minst tre rörliga båtar | 3,7 % | 0 % | 14 % | – | – |
| Transitresor med båda källorna | 22 % | 100 % | 0 % | 91 % | – |
| Glapp över 5 min per timme under gång | 2,4 | 0 | 1,1 | 0,16 | 0,05 |
| Transitrader i krypfart 0,3–2 kn | 18,4 % | 26 % | 2,0 % | 16,3 % | 17,5 % |
| Transitresor med väntan | 30 % | 33 % | 7 % | 48 % | 29,5 % |
| Resor med U-sväng | 0,6 % | 2 av 26 | 4,5 % | – | – |

Nattjaktens 2 360 utslag i omgång 8 samlades där världarna avviker: 85 % när minst två transitbåtar
rörde sig samtidigt, 60 % efter ett glapp över 5 minuter, 20 % hos en båt med U-sväng. I profilen
`blandad` ger de gamla familjerna 185 utslag mot standardprofilens 206, och U17:s säkerhetsvarning
för en tyst båt, en tredjedel av nattjaktens utslag, 1 mot 60.

**Världarna före och efter triagen** (triagens skript, 300 världar per profil):

| Drag | Inspelat | `blandad` | `falt` |
|---|---|---|---|
| Bakåtsteg i minst 2 kn i radpar nära broar | 0,02 % | 0,39 → 0,08 % | 34 → 5 av 18 470 |
| Kryp bland hamnraderna, norrgående före Olidebron | 22 % | 75 → 11 % | 77 → 14 % |
| Korsningar av Olidebron norrut med kryp under 2 kn inom 200 m | 10,7 % | 27 → 7,3 % | 33 → 11,3 % |
| Intervall över 120 s, båt under 2 kn nära en bro | 0,9 % | 18 → 3,8 % | 26 → 5,2 % |

Den femte rättelsen: arbetsbåtens "kajflytt" från Gästhamnen var i rådatan KNIGHT OWL:s avgång genom
Järnvägsbron och Stridsbergsbron; 0 av 18 inspelade kajflyttar gav en varning. Efteråt gav `falt` 25
råa utslag och 4 kandidatkluster (förut 70 och 6) och `blandad` 121 och 8 (förut 185 och 8).

**Triagens domar** över tolv kort:

| Kort | Världar | Dom |
|---|---|---|
| en andra varning 40 s efter passagen (`blandad` F06 r2) | 1 | verkligt latent fel, utlöst av fel i världen (U76) |
| ledtid under 60 s vid Stridsbergsbron norrut (`blandad` F04, `falt` F05) | 13 + 4 | känd gräns efter väntan vid Järnvägsbron (U56 återtaget); världens glesa rader i kö förstärker den |
| varning efter passagen och retur utan varning (`blandad` F05, F06 r1) | 2 + 1 | samma mekanism, respektive beslutat beteende (U18, U15) |
| varning med fel riktning (`blandad` F07) | 1 | beslutat beteende (U19) som registret missar |
| "Inga båtar" i 202 s vid Klaffbron (`blandad` F03) | 53 | fel i världen (hamnkrypet) |
| restiden följer farten, INV-3 (fem kort) | 43 | känt beteende i den uppskjutna restidsetappen |
| ingen notis vid Kanalinfarten (`falt` F02) | 6 | beslutat beteende (en kajflytt i zonen) som oraklet inte känner till |

**Returerna från kaj.** I banken och k1–k4 föregicks 70 korsningar av en målbro av minst 5 minuters
stillhet inom 500 m från en målbro. Tre är returer från kaj (ELFKUNGEN 5/8 och 7/8 vid Kajen norr om
Klaffbron, PILOT 761 k1 vid kajen norr om Stridsbergsbron), och alla tre fick varningen sent eller
inte alls (ELFKUNGEN ingen; PILOT 761 146 s före med båda källorna, ingen med en källa). Av de övriga
67 fick 48 varningen i tid, 11 en gammal, 7 en sen och 1 ingen. Kajen ligger 190–295 m från
Klaffbron; en båt som lägger ut där i 4–5 kn är vid bron på 60–90 s och hörs med AISHubs takt högst
en gång. Öppningsgrinden godtar fallen i klassen RIKTNINGSBEVIS_FÖR_SENT. Medan ELFKUNGEN låg vid
kajen gick båda dagarna en reservvarning för Stridsbergsbron (T2 och T3).

### 18.7 Kända gränser och uppföljning

Kända gränser efter omgången:

- **U68** (`docs/ARCHITECTURE.md` §5): "strax" till tio minuter och sedan "ETA okänd" till 20–25 för
  en båt som tystnar vid bron och går igenom i glappet; vänttexten upp till tio minuter efter en
  passage i glappet; en båt som hörs en enda gång i hög fart visas i femton minuter.
- **U70** (§3, öppningstjänstens kända gränser och notisernas grindkedja): T1–T3, H1–H3 och N1–N3.
- **U75** (§4, Target-livscykeln, under U18).
- **U72** (§8): klocksteg bakåt, kostnaden per meddelande med antalet båtar, klumpleveransen (en
  klump över en mellanbro bokför inte den brons passage, och en ny båts första klump över en bro kan
  ge två varningar: basen gav 3–12 i 48 av granskarens 96 fall, spetsen högst två i 20), och den
  hängande tidslinjenotisen.
- **U74** (§1, vid GPS-analysen direkt efter U57; också `docs/BUGGJAKT.md` §7, utan registerpost).
- **U76** (§4, Target-livscykeln, vid `RE_CROSS_EVIDENCED`).
- **Returen efter en U-sväng i farleden när målbron släpps före bekräftelsen** (§4, efter U75).
- **U71 och U77** (`docs/VALIDATION.md` §Fältprov, grind 1): avbrott längre än tio minuter läks
  inte; poster efter sista kontrollpunkten är obevisade (i granskarens slumpprov alla förluster inom
  de sista 20 s före stoppet); och en körning med omstart eller byte av loggnivå kan inte bli
  godkänd, bara handbedömas.

Uppföljning, i den ordning nyttan i verklig trafik motiverar:

1. **Restiden (ETA-etappen)**, oförändrat 14.6, punkt 1. Triagen fann att restiden följer farten
   hos den båt som bär texten i ungefär samma takt i inspelad trafik som i världarna.
2. **Smala registerposter med mutationsprov:** U62 och U17 i fältprofilerna med granskningens
   villkor, och triagens fyra förslag (sen varning efter väntan vid Järnvägsbron, INV-3 vid
   fartbyte, kajflytt inom Kanalinfartens 300 m, U19 bekräftad av återkorsningen). Hit hör frågan
   om U17:s säkerhetsvarning ska gälla en båt som hörts en enda gång (fältjaktens kort, en värld).
3. **Återkorsningens latitudprov (U76):** mät segmenten innan ett villkor väljs.
4. **Klumpleveransen:** klientens tidsstämpling och den nya båtens dubbla varning. Hit hör
   granskarens låga anmärkning: klampningen av sista kända position sätter också positionens egna
   tidsfält, vilket efter ett klocksteg bakåt kan flytta riktningen i Kanalinfartens notis från
   okänd till norrut.
5. **Två svagheter utan fel i inspelad trafik:** Fix D:s nordband nollar en väntande vändning norr
   om Stridsbergsbron (6,5 % av de norrgående raderna där ligger utanför bandet), och
   riktningslåset ligger kvar vid Kanalinfarten efter en utflytt.
6. **Buggjägarens världar:** tätheten i fältvärldarna (tre gånger vintern), omstarter, krypet som
   ligger för sällan nära broarna (23–25 % av krypraderna mot inspelade 38–44 %), och två kort som
   inte är utredda (målbro som mellanbro i en värld; "Inga båtar" i hamnen i 8 fältvärldar).
7. **Returen efter en U-sväng i farleden** (mät när ett inspelat fall finns) och **en
   farledskorridor** (18.5).
8. Uppföljningslistorna i 13.5, 14.6, 15.6 och 16.4 i övrigt. 14.6, punkt 3, är besvarad (felet
   ligger i fångstkanalen, och U71 gör fångsten tålig). Vänttexten vid Kajen (17.5) väntar på
   fältprov 3.

### 18.8 Fältprov 3 och nästa fältprov ska mäta

Fältprov 3 går på `a0d8706` och har ingenting av omgång 9. Det har redan ett hål i loggströmmen och
kan inte låsas med dagens grind; fångstjournalen prövas i nästa fältprov, som ska startas en gång
på full loggnivå och stoppas en gång med loggskriptet (U77).

1. Mätlistan i 17.9.
2. AISstream: utlöpta handskakningar, vaktens omstarter och tidslinjemeddelanden, och om AISstream
   någon gång dör helt (det enda läge där U66 + U73 kostar något).
3. Tysta båtar: ligger felminuterna närmare fältets 0,3 eller bankens 30 per tio passager när
   sommartrafiken kommer? Hörs fler båtar en enda gång i hög fart, och ligger de i farleden?
4. Med omgång 9 i nästa fältprov: vilka sändare `[NON_VESSEL_IGNORED]` ignorerar; att löpnumren är
   hela och svansen bevisad; att `[CLOCK_STEP]`, `[PERSISTENT_DEDUP_FUTURE]`, `[LAST_KNOWN_FUTURE]`
   och kapningen vid laddning inte förekommer; och omstarterna och larmen med U66 + U73.
5. Båtar i texten mer än 250 m från farledslinjen, returer från kaj och avgångar efter lång
   förtöjning nära en bro, särskilt när AISstream är nere.
6. Uppföljningslistorna i 14.6, 15.6 och 16.4.

### 18.9 Lärdomar

- **Dirigentens eget tillägg fälldes.** Notisomstarten skulle göra U66 oberoende av ägarens svar,
  men gjorde rättningen större i stället för beslutet enklare, och granskaren fann en
  omstartsslinga. Ett beroende av ägarens svar kostar ingenting när ingenting går in utan beskedet.
- **En registerpost som är bredare än sitt beslut döljer fel.** De två posterna tog inga utslag i
  dag men kunde uppfyllas i hundratals världar och prövade inte besluten mekanism; samma skäl
  fällde verktygsspåret i omgång 4. Att en post inte tar något i dag bevisar inte att den är smal.
- **Det mesta av de gamla världarnas brus kom av en enda källa.** Med båda källorna gav U17:s
  säkerhetsvarning 1 utslag mot 60. Ett kort ska vägas mot hur appen faktiskt går.
- **En "räddningsbåt" var en helikopter.** Mätningen av tysta båtar visade ingen regel värd att ta
  in; rådatan (MMSI-prefixet, inga skrovmått) visade att felet var ett annat och hade en säker
  rättning. Läs vad sändaren är innan du mäter vad den gjorde.
- **En rättning av en felväg som aldrig setts kan öppna en vanligare.** R1:s första varv släckte
  klumpens enda giltiga position, och tidsgränsen för tidslinjenotisen gav en notis i minuten när
  Homey är långsam.
- **Spårens egna uppgifter ska också mätas.** Tre uppgifter i rapporterna var fel (fel båt för
  texten med AISHub ensam, fel båt för texten i 86 s, en "kajflytt" som var en avgång), och spår som
  läste varandras underlag hittade dem.
- **En grind ska prövas med mutanter av dataflödet, inte bara av villkoren.** Rättarens
  villkorsmutanter fälldes till slut alla utom en; granskarens mutanter av vilka nummer som räknas
  som sedda och var strömmen slutar överlevde till största delen. Och ett bevis som blandar två
  klockor är bara så bra som den klocka som går fel.
- **En rättare som lägger till något obeställt i sista varvet har lagt till något ogranskat.**
  Följdrättelsen om omstarter i fångstgrinden låg utanför uppdraget och öppnade två nya vägar till
  falskt godkänt. Briefen ska förbjuda tillägg uttryckligen från första varvet.
- **Att begränsa vad ett verktyg påstår är säkrare än att laga en väg i taget.** Fyra granskningsvarv
  fann var sin väg till falskt godkänt genom omstarter och strömbyten. U77 lät grinden påstå mindre
  (bara den enkla körningen), och det kostar ingenting i ett vanligt fältprov.

### 18.10 Slutbatteriet

Kört 2026-11-27 på paketgrenen `omg9/integration-U73`, som är övermängden: `omg9/integration` plus
U66 och U73. Vakten och larmet körs aldrig i uppspelningar och jakter, så skillnaden mot
`omg9/integration` gäller bara jest och lint. Alla steg slutade med kod 0. Jämförelsen görs mot
slutbatteriet i omgång 8 (17.10).

| Steg | Utfall |
|---|---|
| `npm run lint` | 0 |
| hela jest (`--detectOpenHandles`) | 450 sviter, 7 175 test gröna, 2 överhoppade (omgång 8: 433 och 6 877) |
| `replay:all`, med och utan monitoring | alla låsta korpusar matchar facit; WARN-raderna lika med omgång 8 |
| `replay:synthetic` | 239 scenarier rena; 25 WARN-utslag i 24 scenarier, samma som omgång 8 (de nio nya ger ingen) |
| `replay:openings` | utskriften identisk med omgång 8 |
| soak och `replay:monitoring` (72 h) | stabila, 0 processfel |
| `measure:eta` | identisk med omgång 8 i varje mått; bara genereringstiden och en räknare av loggrader skiljer |
| fassvepet, med och utan monitoring | OK, 25 korpusar |
| `hunt:selftest` | grönt |
| snabbjakten och standardjakten | 0 skillnader mot omgång 8:s rapporter, fält för fält utom git-läge och tid (45 och 218 utslag) |
| nattjakten (20 000 världar) | 2 360 råa utslag i sanningsspåret, 16 kandidatkluster, 52 kluster med registerpost, samma radfingeravtryck som omgång 8 |
| `git status --porcelain` före och efter nattjakten | tom |

**Nattrapporten** skiljer sig från omgång 8 bara i 92 källhänvisningar, där radnumren i
`docs/ARCHITECTURE.md` flyttats eftersom dokumentet vuxit, och därmed i fyndhashen.

**Slutsatsen:** i alla uppspelningar och alla 22 300 byggda världar beter sig appen exakt som i
omgång 8. Det som ändrats syns bara där det ska: i de nya testen och i k4:s tre textrader om
räddningsflyget.

Efter batteriet tillkom bara spår L:s sista ändringar i grinden (testverktyget, ingen appkod) och
dokumentationen. Batteriet kördes om på slutspetsen före det här avsnittet, och på `8d42be9` gav
alla slutkod 0: lint, `replay:all` (alla låsta korpusar matchar facit), de 239 scenarierna (rena,
samma 24 WARN-rader), openings (loggen identisk med omgång 8:s), hela jest (448 sviter, 7 155
godkända, 2 överhoppade) och buggjägarens självtest; arbetsträdet var rent.

Efter sammanslagningen av paketet kördes batteriet om på paketgrenens spets `e40f856`, och alla
steg gav slutkod 0: lint, `replay:all` (alla låsta korpusar matchar facit), de 239 scenarierna
(rena, samma 24 WARN-rader), openings (loggen identisk med omgång 8:s), hela jest (450 sviter,
7 195 godkända, 2 överhoppade), buggjägarens självtest och snabbjakten (0 skillnader mot omgång
8:s rapport); arbetsträdet var rent. Slutbatteriet med nattjakten ovan kördes på samma kod i
`app.js` och `lib/`: den är lika mellan den körningen (`927d98d`) och `e40f856`.

## 19. Omgång 10, vid sidan av fältprov 4: 27 november 2026

Tillagt 2026-11-27. Omgång 9 pushades till `main` (`a7e83bb`) samma dag, och fältprov 4 startades
på den versionen. Efter beskeden om omgång 9 frågade ägaren om det fanns mer att rätta innan nästa
fältprov ("känns inte som appen är så robust just nu"), och invände mot att sommartrafiken inte
skulle gå att pröva förrän till sommaren: "vi har ju data från i somras och kan därigenom simulera
mycket av det och se svagheter/styrkor". Dirigentens svar var att inget känt fel med en säker
rättning stod orättat, och att de verkliga svagheterna var den sena varningen efter väntan vid
Järnvägsbron, nätstopp, omstarter och sommartrafikens glesa sändare. Ägaren hade rätt om sommaren:
den inspelade sommartrafiken spelas upp i varje batteri, men batteriet säger bara att utfallet är
oförändrat, och ett samlat bokslut över om utfallet var rätt hade aldrig gjorts.

Ramarna var desamma som i omgång 9: huvudkopian, där fältprovets loggskript körs, rördes inte; allt
arbete gick i egna arbetskopior utgångna från `a7e83bb`; tunga körningar gick genom en kö med sänkt
prioritet; varje ändring fick en oberoende granskare; inga tillägg utanför uppdraget; ingen push
utan ägarens besked. Besluten U78–U86 fattade dirigenten på ägarens uppdrag, och ägaren kan ändra
vart och ett. Alla tider är UTC om inget annat sägs.

Sju utrednings- och rättningsspår och en förstudie, och därefter sammanslagningen på grenen
`omg10/integration`:

- **Genomgången av fältprov 3 (F):** hela körningen, 67,7 timmar (19.1).
- **Sommarbokslutet (M):** appen på `main` uppspelad mot all inspelad trafik och dömd mot rådatan
  (19.2).
- **Den sena varningen efter väntan vid Järnvägsbron (J):** ingen ny regel (U79); den kända gränsen
  omskriven med mätningen och ett scenario (19.3).
- **När broarna öppnar (ÖT):** ingen klockregel (U80); en ny känd gräns, "appen vet inte när bron
  öppnar" (19.4).
- **Reservsläppet (P):** behålls med 300 s (U81); skälet omskrivet och ett scenario (19.5).
- **Nätstopp (N):** ingen kodändring (U78); bilden av vad klienten gör rättad och låst med ett test
  (19.6).
- **Omstarter (O):** en ordnad omstart sparar de levande båtarnas sista positioner (O1, U83), ett
  GPS-hopp sparas inte heller vid radering (U84) eller på något annat ställe där en position sparas
  som belägg (O3, U86), ankomstspärren är känd gräns (U82), och omstartssvepet blir ett stående
  verktyg (19.7).
- **Förstudien om resetillståndet (RT):** ska båtarnas rörelsebevis, målbro och riktning sparas
  över en omstart? Nej (U85, 19.7).

Spåren F och M ändrade ingenting i repot. Spåren N, J, ÖT och P ändrade ingen appkod; spår O är
omgångens enda appkod (`app.js` och `lib/services/VesselDataService.js`). I integrationsgrenen: N
`5035335`, `ebfd499`; J `b11909d`, `a478e9f`; ÖT `738abe3`; P `4492c46`, `31e4e64`; radhänvisningarna
efter J, ÖT och P i `ce73d94`, `edfe453` och `9c38465`; O `b34d22e`, `907b7d6`, `6fe1bcf`,
`d104adb`, `637fd90`, `f4a16f8`, `5c9cf76`, `c489af6`, `8f950a1`; antalet scenarier i
`49299a8`; O3 `ab6ae95`, `2f5c609`, `3b814b7`, `4df8854`, `b795226`, `061d612` och `489b419`, med
radhänvisningarna efter O3 i `611ed4f` och `647ca6d`.

### 19.1 Fältprov 3 i sin helhet

Körningen gick 2026-11-24 14:46 – 2026-11-27 10:26 (67,7 timmar) på `a0d8706` och stoppades
ordnat. 18.1 gällde de första 56 timmarna; det här är hela körningen.

- **Notiser och varningar.** Åtta fartyg gick genom kanalen, ett i taget (aldrig två samtidigt).
  Alla 48 notiser kom, sex per fartyg, med rätt bro och riktning och ingen extra; 38 av 40 mätbara
  notiser låg inom en minut från den utlovade tiden. Alla 16 öppningsvarningar kom före passagen
  och ingen var falsk. Ledtiden, här och i resten av avsnittet tiden från varningen till att båten
  korsar brolinjen enligt rådatan, var som kortast 130 och 131 s (punkt 1 nedan). Genomgången av
  hela provet angav ledtiderna 130–626 s med korsningen räknad på tiderna då positionerna togs
  emot. Det här avsnittet räknar på positionernas egna tider, vilket ger LIDAN 131 s i stället för
  147 s; positioner från AISHub är upp till en halv minut gamla när de tas emot. Den utlovade
  tiden var som mest 3,4 minuter fel (INGRID B: lovat 7, blev 10,4).
- **Fältet och uppspelningen är lika.** 48 av 48 notiser, 16 av 16 varningar och 157 av 157
  brotexter med samma innehåll; två textbyten kom 30 s senare i uppspelningen, vilket är
  uppspelningens kända tidsstegning. Fassvepet är grönt. Den nya versionen (`a7e83bb`) ger samma
  notiser och varningar; bara räddningsflygets tre textrader försvinner.
- **Driften var stabil.** En appstart, inga krascher, minnet 14,4 → 19,9 MB och plant (0,03 MB per
  timme dygn 2–3), inga fel utöver AISstreams utlöpta handskakningar, och alla 64 flödeskort
  lyckades.

Det som var fel för användaren, i allvarsordning:

1. **Sen varning för Stridsbergsbron norrut efter väntan vid Järnvägsbron.** LIDAN (26/11) och
   SYLVIA (27/11) väntade söder om Järnvägsbron, stilla (under 0,5 kn) i 15 respektive 33
   minuter och i kö (under 1 kn) i 18 respektive 37 minuter. De fick varningen för
   Stridsbergsbron med ledtiden 131 respektive 130 s, ungefär två minuter efter att de börjat
   röra sig. Öppningslagret höll Stridsbergsbron bakom Järnvägsbron hela väntan och släppte först
   på positionen där båten låg 27–36 m söder om Järnvägsbron i över 2,8 kn. Mekanismen är utredd i 19.3.
2. **Restiden före väntan vid Järnvägsbron.** Innan de stannade visade texten "om 10 → 7" (LIDAN)
   och "om 11 → 7" (SYLVIA) när 30–20 respektive 50–40 minuter återstod, och notisen för
   Järnvägsbron sa "om 7" och "om 5" för båtar som korsade efter 20 och 40 minuter. Det är de två
   enda av 40 mätbara notiser som var mer än en minut fel. Appen har ingen modell för väntan före
   Järnvägsbron; restiden räknas på farten (14.6, punkt 1).
3. **Räddningsflyget LIFEGUARD 007** gav 15,3 minuter falsk text (5,3 min "strax" och 10 min "ETA
   okänd"). Borta i den nya versionen (U69).
4. **Hålen i loggströmmen.** Två hål, ingen kostnad för användaren. Det första (25/11 20:09:31,
   78,6 s) tappade en AISHub-position, troligen INGRID B:s; uppspelningen utan den ger samma notiser
   och texter. Det andra (27/11 02:14:00, 142,3 s) är nytt i sitt slag: AISHub-räknaren för nätfel
   gick från 0 till 1 just då (det enda nätfelet på 67,7 timmar; fältprov 2 hade 0 på 133), och
   AISstream-anslutningen byttes ut inne i hålet. Slutsatsen att Homey kort tappade nätet, och
   därmed både internet och loggströmmen, är antagen, inte bevisad. De nio tidigare hålen hade
   oförändrad räknare.
5. **AISstream var fortsatt gles.** 48 omstarter av vakten (17 per dygn mot 2,7 i fältprov 2), 113
   utlöpta handskakningar (0) och 3 tidslinjemeddelanden. Alla omstarter kom efter 20–21 minuters
   tystnad medan AISHub bara levererade förtöjda båtar eller båtar på väg ut, och AISstream dog
   aldrig (längsta tystnad 54 minuter). Simulerat på de råa ankomsterna hade den nya versionen gett
   0 omstarter (U66; AISHub levererade som mest 23 positioner under en tystnad, kravet är 31) och 0
   meddelanden (U73).
6. **Lågt: för hög siffra vid inbromsning före Stridsbergsbron söderut.** INGRID B saktade in från
   6 till 2,1 kn och siffran steg "8 → 9 → 10"; 7 minuter av hennes text var mer än 2 minuter för
   hög. KINNE samma mönster i mindre skala (lovat 7, blev 9,9).

**Brotexten** för de åtta fartygen, klassad var 30:e sekund mot rådatan: 221 av 270,5 minuter
rätt. Felen är 22,5 minuter för låg siffra före väntan vid Järnvägsbron (punkt 2), 12 minuter för
låg siffra längst norrut i hög fart, 13 minuter för hög siffra vid inbromsning (punkt 6), 0,5
minut "strax" efter passagen och 1,5 minut vänttext medan en båt gled in. Gränserna för rätt
(inom 2 minuter eller 25 %; "strax" om högst 3 minuter återstod) är genomgångens, inte appens.
Efter varje målbropassage bytte texten inom 58 s.

**Mätlistan från 17.9 och 18.8:** "väntar vid <målbro>" (U65) visades 0 gånger, eftersom ingen båt
låg still inom 300 m från en målbro; vänttexten vid Järnvägsbron var rätt i 51 av 52,5 minuter. 0
växlingar till "strax" på ett fartfix, 0 passager under vänttext, 0 köer vid Kajen, aldrig två
båtar i texten. Ingen båt i texten låg mer än 32 m från farledslinjen (verktygens linje; appen har
ingen). PRICKBJORN lade ut efter 927 minuter vid Kanalinfarten och gick söderut utanför kanalen;
appen släppte förtöjningen och förra resan, och ingen notis gick ut, vilket var rätt. Restiden i
notiserna var bättre än i fältprov 2 (95 % inom en minut mot 72 %), men nästan alla båtar gick
jämnt utan väntan.

**Körningen kan inte låsas som korpus.** En AISHub-position saknas (hål 1) och kan inte
återskapas, `a0d8706` har ingen fångstjournal som visar att inget mer saknas, och det finns ingen
stoppfil. Som fältbevis är den god; som facit får den inte användas.

### 19.2 Sommarbokslutet

Appen på `main` spelades upp mot bankens 25 inspelade körningar (516 timmar räknat från varje
körnings start till dess sista position, 24 körningar från maj–september 2026 och en från
november), och varje öppningsvarning, notis och brotext dömdes mot rådatan: när båtarna korsade
brolinjen och om de låg still. Körningarna innehöll 444 passager av Klaffbron och Stridsbergsbron
(436 från sommaren) och 1 212 passager av alla broar och Kanalinfarten. Därtill fältproven k1–k4
(november, båda källorna, 255 timmar räknat på samma sätt; loggarna är tillsammans 266,8 timmar
från appstart till loggens slut), varianterna med en källa i taget och 2 000 byggda världar.
Varningens fönster (i tid 2–10 minuter före passagen, tidig 10–15, för tidig över 15, sen under 2)
är bokslutets val; passagen mäts mot korsningen, eftersom när bron öppnade inte syns i data.

**Styrkorna.**

1. **En notis per passage, med rätt riktning.** 1 199 av 1 212 passager fick exakt en notis; åtta
   fick ingen, och fem fick två (alla fem samma lokala båt som vänder vid områdets ändar).
   Riktningen var fel i 5 av 1 170 bedömda notiser.
2. **Varningen kommer nästan aldrig för sent.** Ingen av de 444 passagerna fick varningen efter
   passagen, och 7 fick den mindre än 2 minuter före. Ingen av 450 varningar hade fel riktning.
3. **"Väntar vid" stämmer** i 99 % av 1 207 minuter.
4. **"Inga båtar" stämmer.** Säkert fel i 84 av 24 571 minuter (0,3 %); i ytterligare 6 % av tiden
   låg en båt tyst och korsade under ett avbrott, så att ingen kan säga exakt när.
5. **Med båda källorna och jämn trafik är appen bra.** I novemberfältet fick 92 % av 72 passager
   varningen 2–15 minuter före, ingen blev utan, och 2 av 74 varningar följdes inte av en passage.

**Svagheterna, största först.**

1. **Varningen kommer mer än 15 minuter före i 104 av 444 passager (23 %; 24 % med båda
   källorna).** Tio kom mer än en timme före, medianen för de 104 var 31 minuter. I 97 av dem låg
   båten sedan still i minst fem minuter eller kröp i under 3 knop: hon väntade på öppningen.
   Exempel: den 5 augusti 11:21 fick tre båtar söderut "om 9 minuter" för Stridsbergsbron, låg still
   27–38 minuter och passerade 12:12–12:16.
2. **64 av 450 varningar (14 %) följs inte av någon passage inom en timme.** 45 av dem är
   reservsläpp (en båt som inte hörts på fem minuter); i 34 av de 64 öppnade bron ändå för en annan
   båt inom timmen.
3. **Minutsiffran stämmer i 37 % av de bedömbara minuterna.** Oftast kom passagen senare än
   utlovat, och i fyra av tio sådana minuter hade båten legat still vid bron före passagen.
4. **"Strax" stämmer i 35 % av minuterna** (44 % med båda källorna, 30 % med bara AISstream). En
   femtedel av alla "strax"-minuter gällde en båt som redan passerat men inte hörts efter bron.
5. **Tysta båtar.** Med bara AISstream skedde 117 av 302 passager (39 %) medan båten var tyst, och
   36 % av brönotiserna blev "passerade … under AIS-tystnad"; med båda källorna 14 % och 7 %.

**Vad båda källorna betyder.** I de sju sommarkörningarna med båda källorna, uppspelade också med en
källa i taget, rättar AISHub det som beror på glesa positioner: uteblivna varningar 3 mot 14 med
bara AISstream, uteblivna notiser 0 mot 32, notiser mer än 2 minuter efter passagen 8 mot 34. Det
rättar inte köerna: falska varningar är 12 i alla tre varianterna, och andelen varningar mer än 15
minuter före är 24–27 % med eller utan AISHub, mot 1 % i novemberfältet. Sommarens fritidsbåtar
köar, kryper och lägger till; vintertrafiken är yrkesfartyg som går jämnt.

**Reservsläppet** (U38) står för 195 av de 450 varningarna, 45 av de 64 falska och 54 av de 104 för
tidiga.

**Världarna är för snälla mot de största svagheterna.** I 2 000 världar ur profilen `blandad` kom
8–9 % av varningarna mer än 15 minuter före (inspelat 24 %), 1,1–1,4 % var falska (13 %), och
minutsiffran stämde i 55 % (41 %). Världarna saknar långa väntor på öppningen, båtar som lägger
till eller vänder efter en varning och glesa fritidsbåtar som tystnar. Mot sena varningar efter
väntan är de i stället strängare: 5,3 % under 2 minuter mot 2 % inspelat.

**Dirigentens slutsats:** sommarens stora fel är inte brus eller buggar, utan att appen inte vet
när bron öppnar för en båt som är framme. Det gav spåren ÖT (19.4) och P (19.5).

### 19.3 Den sena varningen efter väntan vid Järnvägsbron (U79)

**Situationen.** En båt på väg norrut väntar söder om Järnvägsbron, som ligger 257 m före
Stridsbergsbron. När hon sätter fart passerar hon Stridsbergsbron inom några minuter, och varningen
för Stridsbergsbron kommer sent. U56 (omgång 5) försökte rätta det och återtogs, eftersom ett ryck
i kön inte gick att skilja från avgången.

**Mätningen.** Banken, k1–k4 och 209 världar ur profilerna `falt` och `blandad`, med passagerna ur
rådatan: 112 passager av Stridsbergsbron norrut, 47 av dem efter en väntan på minst 2 minuter. 13
av de 47 varnades under 150 s före passagen; i november 8 av 11 (median 129 s). Med bara AISstream
och fritidsbåtar på sommaren kommer varningen i stället i median 28 minuter för tidigt
(reservsläppet). Söderut finns inte felet: Klaffbron fick 0 sena varningar av 39 efter en väntan
vid Järnvägsbron, som ligger 963 m norr om Klaffbron.

**Det som begränsar är geometrin och källornas takt, inte en regel.** Kön ligger 120–160 m före
Järnvägsbron, alltså 380–420 m före Stridsbergsbron:

| Del | Spännvidd (median) |
|---|---|
| Från första rörelsen till passagen | 117–292 s (223) |
| Från första rörelsen till att första positionen i rörelse når appen | 25–110 s (80) |
| Appens väntan på ytterligare en position, den som skiljer ett ryck från en avgång | 0–141 s (67) |
| Ledtiden i dag för de 13 sena | 37–131 s (100) |

Även en perfekt avgångsdetektor hade gett 5 av de 13 under 180 s. I rådatan finns 21 avgångar och 12
ryck där en regel kan spela roll, och de överlappar i fart (avgång 1,2–6,1 kn, ryck 1,0–2,3 kn),
framsteg, avstånd, väntetid och positionens ålder. OLA (2026-09-07) ryckte 165 m fram till 123 m
före bron och stod sedan 18 minuter.

**U79 (dirigentens beslut): ingen ny regel.** Den bästa regeln (varna på första positionen i minst
1,0 kn och 20 m framsteg, högst 200 m före Järnvägsbron) flyttar 7 båtar från 100–131 s till
152–211 s, men ger två verkliga ryck varningen 8,6 och 18,7 minuter för tidigt, och i världarna 9
ryck 6,6–10,4 minuter för tidigt. Det är samma byte som fick U56 att återtas. Sex andra alternativ
prövades, från U56-regeln till en varning redan när väntan börjar. Det enda utan nya för tidiga
eller falska varningar i inspelad trafik (två positioner, den andra i minst 2,5 kn) flyttar bara 2
av de 13, med 14–68 s.

Den kända gränsen står med mätningen i `docs/ARCHITECTURE.md` (öppningstjänsten), och scenariot
"kö-140m-söder-om-Järnvägsbron-ryck-35m-och-ny-väntan (känd gräns, U79)" låser den med kön på det
verkliga avståndet: dagens varning kommer 143 s före passagen, och den bästa regeln ger den på
rycket 878 s före och fäller scenariot.

**Råd till ägaren, inget beslut:** notisen för Järnvägsbron går ut när en båt norrut kommer dit,
och brotexten säger "väntar vid Järnvägsbron på väg mot Stridsbergsbron"; det är den tidiga
signalen för Stridsbergsbron. Öppen fråga, inte mätt: om Stridsbergsbron i praktiken öppnas redan
när båten släpps vid Järnvägsbron är passagen fel mått för varningen.

### 19.4 Klockslag och öppningstider (U80)

**Frågan.** Följer broöppningarna klockan eller yttre regler (öppettider, rusningstrafik, tågtider),
och hade en sådan regel rättat de för tidiga varningarna i 19.2? Underlaget var banken och k1–k4:
756 observerade timmar och 521 passager av Klaffbron och Stridsbergsbron. Observerad tid är här
tiden med data, alltså utan perioder då ingen källa gav en position på mer än 30 minuter: 494
timmar i banken och 262 i k1–k4 (där en paus på fyra och en halv timme i k1 faller bort).
Klockslagen i det här avsnittet är svensk lokal tid.

**De offentliga reglerna** (lästa 2026-11-27): fritidsbåtar får passera broarna och slussarna mellan
Lilla Edet och Vänersborg kl. 09–19 (Sjöfartsverket); yrkestrafiken går dygnet runt och har
företräde (Transportstyrelsens föreskrifter TSFS 2019:97, 24 §). Det finns inga fasta öppningstider
och inga rusningsstopp för Klaffbron, Stridsbergsbron eller Järnvägsbron. Enligt en turistsida,
alltså inte förvaltaren, styr tågen järnvägsbrons öppningar. Ingen tågtidtabell för Järnvägsbron
gick att hitta.

**I datan:**

- **09–19 håller.** 296 av 315 passager av fritidsbåtar låg 09–19, och 9 av de 19 undantagen låg i
  kanten.
- **Väntan sitter vid Järnvägsbron och Stridsbergsbron, inte vid Klaffbron.** Mitt på sommardagen
  väntade 35–47 % av båtarna minst fem minuter där, mot 2–5 % vid Klaffbron, och 68 av de 104 för
  tidiga varningarna i 19.2 gällde Stridsbergsbron. Att tågen orsakar väntan är antaget, inte mätt.
- **Ingen klocktid på sommaren.** Öppningarna samlas inte vid någon minut i timmen. En tidig
  snabbräkning som tydde på det räknade varje båt i en kö för sig; per öppning är fördelningen
  jämn. I november låg 63 % av Stridsbergsbrons öppningar inom fem minuter från hel- eller
  halvtimme, mot 33 % av slump (n = 40).
- **Klaffbron vardagar 15–17 har färre öppningar, men inget stopp:** 12 av 14 båtar som kom fram då
  kom igenom 3–31 minuter senare.

**U80 (dirigentens beslut): ingen klockregel för broöppningar.** Av de 105 varningar som kom mer än
15 minuter före passagen (104 i banken, 1 i fältet) gick 101 mellan 09 och 19, och alla hade
passagen samma dag: båtarna väntade medan broarna var i drift och öppnades efter behov. En regel om
09–19 rättar 0 av 105 och gör att 13 av 16 berörda varningar kommer efter passagen; ett
rusningsstopp 15–17 rättar 0 och ger 20 av 23 efter passagen. Att flytta Stridsbergsbrons utlovade
tid till nästa hel- eller halvtimme ger på sommaren lika många rätta som fel textminuter, och i
november 35 rätta mot 99 fel. Den kända gränsen "appen vet inte när bron öppnar" står med källorna i
`docs/ARCHITECTURE.md` (öppningstjänsten).

**Möjliga vägar framåt, ägarens val och inte påbörjade:** tågtrafiken i realtid ur Trafikverkets
öppna gränssnitt (ett nytt yttre beroende, inte prövat), och en regel som utgår från att båten
lämnar väntläget (rör ägarbeslutet U2 och den sena varningen i 19.3).

### 19.5 Reservsläppet (U81)

**Frågan.** En båt som hålls tillbaka av spärren vid en tidigare bro och inte hörts på fem minuter
får sin varning ändå (U38), så att ingen öppning blir utan varning. I sommarbokslutet stod de här
reservsläppen för 45 av 64 varningar utan passage och 54 av 104 för tidiga. Går reservsläppet att
göra träffsäkrare utan att någon varning uteblir eller kommer efter passagen?

Varje alternativ spelades upp över banken, bankens åtta körningar med båda källorna en källa i
taget och k1–k4 i alla tre varianterna, och dömdes passage för passage mot rådatan; två alternativ
också i 600 världar och i byggda fall.

| Alternativ | Banken: falska / mer än 15 min / sena / uteblivna | Sämre (utan varning eller under 2 min) | Dom |
|---|---|---|---|
| I dag: 300 s | 64 / 104 / 7 / 19 | – | – |
| Inget reservsläpp alls | 31 / 54 / 45 / 75 | 169 | förkastat |
| Inget släpp för en stilla båt | 54 / 84 / 12 / 33 | 31 | förkastat |
| Stilla båt: 420 s | 63 / 99 / 9 / 19 | 2 | förkastat |
| Stilla båt: 600 s | 59 / 96 / 11 / 19 | 5 | förkastat |
| Stilla båt: dubbla mottagningsintervallet | 62 / 101 / 9 / 19 | 3 | förkastat |
| Håll så länge en kökamrat hörs stilla | 62 / 102 / 7 / 19 | 0 | avstått: en byggd båt utan varning |
| Håll en båt i kö vid den andra målbron | 61 / 102 / 7 / 19 | 0 (1 i världarna) | förkastat: en värld utan varning |

Det som bär slutsatsen:

- **Släppet bär garantin.** Utan det hade banken fått 33 falska och 50 för tidiga varningar färre,
  men 56 passager hade blivit utan varning och 38 fått den under 2 minuter före. En båt i kön vid
  Järnvägsbron som inte varnas medan hon väntar varnas först bortom Järnvägsbron, under en minut
  före Stridsbergsbron (en båt den 4 augusti: 24,7 minuter före med släppet, 0,7 utan).
- **Bara 64 av de 195 reservsläppen gäller en stilla båt.** 131 gällde en båt i gång, och för 74
  av dem kom släppet högst två minuter efter den vanliga säkerhetsfristen (varna tre minuter före
  tidigaste ankomst i 10 knop). Där är det grundgarantin som ger de tidiga och falska varningarna.
- **Fem minuter ligger nära gränsen.** En fritidsbåt låg den 3 juli nästan still 220 m norr om
  Stridsbergsbron, hördes inte på 14 minuter och passerade Klaffbron 470 s efter sin sista
  position, varnad 2,8 minuter före. Den kortaste tysta passagen för en stilla båt i underlaget var
  373 s.
- **Inget appen vet när spärren löper ut skiljer de rimliga varningarna från de för tidiga**
  (prövat: källa, sändningstakt, fart, kajzon, avstånd, kö och andra båtar i kön).
- **De två regler som inte försämrade något i inspelad trafik saknar tidsgräns.** De tog bort två
  falska och två för tidiga varningar var, men en båt som lägger ut tyst ur kön får ingen varning
  alls.

**U81 (dirigentens beslut): reservsläppet (U38) behålls med 300 s.** En utebliven varning är värre än
en för tidig. Skälet står i `docs/ARCHITECTURE.md` (öppningstjänsten), och scenariot
"söderut-stilla-220m-norr-om-Stridsbergsbron-tyst-avgång-6kn-genom-tre-broar (U81)" låser det: i
dag kommer varningen 168 s före korsningen, och 420 s, 600 s, det dubbla intervallet och köregeln
fäller scenariot.

**Läsningen av sommarbokslutet efter 19.3–19.5.** De för tidiga och falska varningarna i
sommartrafik är priset för att ingen öppning ska bli utan varning, givet att appen inte ser när
bron öppnar. Ingen regel på det appen ser i dag rättar dem utan att bryta garantin. Det som kunde
ändra bilden är ny information utifrån, som tågtider, och det är ägarens val.

### 19.6 Nätstopp (U78)

**Situationen.** Omgång 9 rättade en dubbel öppningsvarning efter en klumpleverans (flera
positioner för samma båt levererade i samma ögonblick, med samma mottagningstid) och mätte resten
med inlagda nätstopp på två minuter. Frågan nu var vad klienten faktiskt gör vid ett nätstopp, och
om en ändring i klienten skulle hjälpa.

**Vad klienten gör**, mätt med den riktiga klienten mot en lokal server bakom en proxy som fryser
trafiken åt båda hållen:

- Klienten buffrar ingenting själv. Pingvakten skickar en ping var 30:e sekund och river
  anslutningen när förra pingen saknar svar och inget meddelande kommit sedan förra kontrollen.
- Ett stopp överlevs därför bara till pingvaktens andra kontroll, 30 till knappt 60 s. Då kommer
  stoppets positioner i en klump (ett stopp på 55 s gav 33 meddelanden, det äldsta 52 s gammalt).
- Ett längre stopp river anslutningen, och en ny prenumeration får ingen gammal data: stoppets
  positioner från AISstream är förlorade. AISHub ger aktuella positioner vid nästa hämtning.
- En klump längre än ungefär en minut uppstår bara om appens process fryser medan nätet går.
  Omgång 9:s tvåminutersklump är alltså ett läge klienten inte kan hamna i vid ett nätstopp.

I banken och fältkörningarna finns ingen klump: av 14 289 mottagningar från AISstream låg ett enda
par för samma båt inom en sekund (en båt som låg still), och pingvakten har aldrig rivit en
anslutning i fältproven.

**Mätningen**, banken och fältprov 2 och 3 med ett stopp i början av varje tiominutersperiod (långt
tätare än i verkligheten; talen visar känsligheten). Uteblivna / extra / mer än en minut sena / mer
än en minut för tidiga varningar av 497:

| Stopp | Klump (dagens kod) | Bara nyaste positionen per båt | Varje position med egen tid | Positionerna försvinner |
|---|---|---|---|---|
| 30 s | 0/1/2/1 | 0/1/2/1 | 0/1/0/1 | – |
| 60 s | 3/3/5/7 | 4/3/5/7 | 0/1/1/5 | 7/5/17/21 |
| 120 s | 4/6/33/27 | 4/5/32/27 | 3/6/17/22 | 27/16/32/47 |

Vid två minuter är det verkliga utfallet den sista kolumnen: 27 uteblivna varningar, mot 4 med
klump. Det som kostar är att informationen kommer sent eller inte alls, inte att positionerna delar
tid.

**U78 (dirigentens beslut): ingen kodändring för nätstopp.** Ett stopp längre än pingvakten tillåter
går inte att rätta i klienten, eftersom positionerna inte finns. Att bara skicka vidare klumpens
nyaste position var inte bättre i någon inställning. Att ge varje position sin egen tid var bättre i
mätningen (vid 60 s 16 varningar bättre och ingen sämre), men tiden skulle komma från ett
odokumenterat fält i AISstreams meddelanden, ändringen bryter sammanslagningens regel att
AISstreams tid är mottagningstiden, och läget har aldrig setts i fält. Under ett nätavbrott är
appen blind, och positionerna från avbrottet går inte att få i efterhand.

Bilden i `docs/ARCHITECTURE.md` (§8) är rättad, och testet `tests/n-natstopp-pingvakt.test.js`
låser det mätta beteendet genom det riktiga websocketbiblioteket: ett stopp på 59 s överlevs och
ger en klump, och ett stopp som når kontrollen efter nästa river anslutningen och dess positioner
kommer aldrig.

**Uppföljning:** en loggrad när en position från AISstream kommer mer än några sekunder efter
meddelandets egen tid, och den tiden i inspelningen, så att ett fältprov kan visa om klumpar
förekommer; först därefter eventuellt egen tid i smal form. Det kan tidigast komma med nästa
fältprov efter fältprov 4, eftersom ändringen ändrar inspelningens format.

### 19.7 Omstarter (O1, O3, U82–U86)

**Situationen.** Appen startar om vid varje appuppdatering, när Homey startar om och om den
kraschar. Fältproven har startat en gång var och utan väntande båt (16.4, punkt 1), så vad
användaren ser över en omstart mitt i trafiken var oprövat utöver fyra syntetiska scenarier och
soakens två omstarter, som bara kontrollerar processfel och kvarlämnade strukturer.

**Hur det mättes.** Omstartssvepet spelar upp en körning en gång utan omstart och sedan en gång
per omstartspunkt med en omstart inlagd: appen stängs ordnat (`onUninit`) eller "dör" (det
`onUninit` skrev kastas), ingen app finns under pausen och raderna som kommer då tas aldrig emot,
och en ny instans startar mot samma inställningar. Punkterna låg på ett raster varje timme och
riktat: i en väntan vid målbron, före en målbropassage, direkt efter en öppningsvarning, när
texten visade två båtar och mitt i ett långt stopp. Svepet prövar inte sammanslagningen av
källorna, inte AISHub-hämtningen efter omstarten (i Homey kommer alla båtars position inom
ungefär en minut; svepet väntar på nästa inspelade rad, så tiden till första position är en övre
gräns) och inte fler än en omstart per uppspelning.

På `a7e83bb`, 1 890 omstarter med två minuters paus över banken och k1–k4 (summor över
omstarterna):

| | Antal |
|---|---|
| Uteblivna varningar: i pausen / efter, tyst båt / efter, båten hördes i tid | 33 / 77 / 75 |
| Varningar mer än 20 min fel | 104 |
| Nya varningar (varav en andra varning för en redan varnad öppning) | 42 (38) |
| Uteblivna notiser: i pausen / efter, tyst båt / efter, båten hördes | 121 / 256 / 43 |
| Extra notiser | 64 |
| Dubbla notiser för samma passage | 0 |
| "Inga båtar" fast en båt fanns | 4 374 min (mer än en minut i 491 omstarter, längst 88 min) |

Hård och ordnad omstart gav samma utfall i 267 av 277 punkter. Ingen båt som själv varnats före
omstarten varnades igen för samma ankomst: notisspärren, besöksminnet och öppningsdedupen håller.

**Det som var fel: de levande båtarnas positioner sparades inte vid stoppet.** Appens minne av
båtarnas sista kända position (`last_known_positions`) skrevs bara när en båt raderades, och en
ordnad omstart raderar inga båtar. Efter omstarten var varje båt ny, och appen gissade att hon kom
in genom kanalens ände. EBONITA PRINCESS 40 (2026-06-01) miste tre "passerade … under
AIS-tystnad", BRANIF fick en falsk för Klaffbron, och ELFKUNGEN (2026-07-12) fick tre 45 minuter
för tidigt.

**Det som ändrats (O1, U83, U84).**

- **O1:** vid en ordnad omstart bokförs de levande båtarna i samma minne som vid en radering, och
  appens befintliga logik för en båt som hörs igen tar över efter omstarten. En krasch hinner
  inte spara något.
- **Den rena positionen.** Den senaste positionen som inte är ett obekräftat GPS-hopp sparas;
  finns ingen sparas båten inte. Granskningens första varv visade varför: ett hopp norr om
  Järnvägsbron sparat strax före omstarten gav "passerade Järnvägsbron" och "passerade Klaffbron
  under AIS-tystnad" medan båten låg 458 m söder om Klaffbron.
- **U83 (dirigentens beslut): positionen från stoppet gäller i 15 minuter.** En uppdatering eller
  omstart av Homey tar sekunder till minuter; efter en längre paus vet appen inte vad båten gjort.
  Gränsen gäller appens paus och prövas när positionerna laddas. En båt som inte hörs efter
  omstarten behåller posten som en vanlig sist känd position (6 timmar), som en raderad båt i en
  körning utan omstart.
- **Förbrukningen.** Posten används vid båtens första position efter omstarten och tas bort vid
  den andra, så att en senare krasch inte laddar en position från en tidigare ordnad omstart.
- **U84 (dirigentens beslut): ett obekräftat GPS-hopp sparas inte heller vid radering.** Felet
  fanns på `main` sedan tidigare: en båt som låg still söder om Klaffbron, vars sista position före
  raderingen var ett hopp, fick när hon hördes igen falska "passerade Järnvägsbron/Klaffbron" och
  ett riktningslås åt fel håll. Nu sparas hennes rena position, och ingenting om ingen finns.
  Banken och fältkörningarna har ett enda flaggat hopp, OSPREY 2026-06-02 09:59 (583 m), och det
  var en verklig förflyttning som nästa position bekräftade. Felet är alltså mycket sällsynt, men
  det är en falsk notis.
- **Timern.** En pausfunktions timer på 200 ms låg kvar efter `onUninit` i tre av drygt 2 000
  omstarter; ofarlig, men den kunde fälla `replay:monitoring`. Den spåras nu och löses upp.
- Registerposten OMSTART-RESETILLSTÅND och persistenstabellen i `docs/ARCHITECTURE.md` §6 säger nu
  att positionen sparas vid en ordnad omstart och gäller i 15 minuter, men inte vid en krasch.

**O3: ett obekräftat hopp är inte belägg någonstans.** Regeln från den rena positionen och U84
gäller nu på alla ställen där appen sparar en position som belägg. Rättaren räknade upp dem och
prövade vart och ett; tre hade verkligt fel och är rättade med regressionstest:

- **Graven** (det appen minns om en raderad båt): en båt utan fartgivare som sänder var 180 s fick
  en helt tyst resa när hoppets punkt sparades.
- **Kajkartan**, som minns kajplatser i 365 dygn: hoppets punkt lärdes in som kajplats, och en ny
  båt som syntes där fick inga notiser om passager under tystnad.
- **Kajbokföringen vid Kanalinfarten:** ett hopp raderade posten, och ett vobbel gav sedan ett
  falskt "närmar sig Kanalinfarten".

Två ställen är medvetet orörda, med en prob som belägg för att hoppet inte ger något fel där:
öppningslagrets kajankare och stillhetsankaret. Inte prövade: reseankaret på vägarna för vändning,
ACCELERATED och NEW_JOURNEY, och ETA-räknarens minnen.

**Nyttan.** I rättarens svep, i samma punkter före och efter: uteblivna och extra notiser 436 och
50 före O1, 231 och 5 efter, av 1 686 omstarter med två minuters paus; med tio minuters paus 265 →
142 och 17 → 6. Varningar och text är i stort sett oförändrade. Med granskarens strängare mått
(riktning och tid räknas också) blev 122 omstarter bättre och 10 sämre av 1 938 med 45 s och 5
minuters paus, och notisfelen gick från 780 till 588. Med 30 minuters och två timmars paus blev 12
bättre och 7 sämre av 1 319.

**Kända gränser.**

- **PILOT 761 (k1)** passerade Stridsbergsbron under pausen och vände sedan i låg fart.
  Riktningslåset som sätts när en båt hörs igen höll henne: cirka 39 minuter fel text och ingen
  varning söderut. ELFKUNGEN (2026-07-02) miste utfartsnotisen vid Kanalinfarten i två omstarter,
  och PRICKBJORN (k3) "har precis passerat Stallbackabron", av samma skäl: utan portgissningen
  sätts inget riktningslås.
- **Lång paus.** Vid en paus över 15 minuter kastas positionen från stoppet, och eftersom den skrev
  över en äldre raderingspost för samma båt finns inte heller den kvar; appen startar utan kunskap
  om båten. ELFKUNGEN (2026-08-04, 30 minuters paus) miste fem notiser som körningen utan omstart
  ger. Dirigenten lät det stå: att lägga tillbaka den äldre posten ger exakt basens utfall, alltså
  12 sämre och 7 bättre än i dag.
- **Klocksteg bakåt.** Backar Homeys klocka lika mycket som pausen varade ser en gammal post färsk
  ut. Ett orimligt läge i drift.
- **U86 (dirigentens beslut): priset i graven kvitteras.** En båt utan fartgivare som sänder var
  180 s, där en verklig position flaggas som hopp (fel klocka), och som raderas och hörs igen inom
  15 minuter vid hoppets punkt, får ingen grav, eftersom den båtklassen inte har någon ren position,
  och förlorar båda öppningsvarningarna; notiserna kommer. Det omvända fallet, ett falskt hopp för
  en stilla båt, gav 0 notiser före O3 och är nu rätt. Kedjan av flaggat hopp, radering och
  återfödelse har aldrig setts i inspelad trafik, och regeln är densamma som i den rena positionen
  och U84. Förslaget att spara båda punkterna i graven står kvar till nästa omgång.
- **Kajbokföringen räknar också osäkra positioner** (samma prövning som öppningslagrets band i
  samma funktion). För en båt där varje position är osäker kan posten stå kvar upp till två timmar
  efter att hon lämnat närområdet. Grinden blir då strängare, inte falskare; kvitterad.
- **U82 (dirigentens beslut): ankomstspärren över omstarten står kvar som känd gräns.** En båt som
  varnats långt i förväg och sedan väntat får i basen en andra varning cirka tio minuter före
  passagen, när en annan båt använt den första öppningen (U45). Efter en omstart finns spärren kvar
  men inte öppningshändelsen som släpper den: 9 varningar tystades i 48 omstarter (CALIMA
  2026-07-11: varnad 10:19, basens andra varning 11:26 uteblir efter en omstart 11:00). Att släppa
  en laddad spärr när båten passerar den andra målbron mättes i 818 omstarter: dubbla varningar för
  samma ankomst 3 → 8, och 18 omstarter blev sämre mot 1 bättre, eftersom öppningshändelsen redan
  avfyrats och tystats och inte avfyras igen.
- **Det som inte sparas.** Båtens resetillstånd (rörelsebevis, målbro, riktning, passerade broar)
  och öppningshändelserna sparas inte över en omstart. "Inga båtar" direkt efter omstarten varar i
  median 50 s, mer än tio minuter i 116 omstarter, mest för stilla båtar utan rörelsebevis (U63).
  Tysta båtar varnas inte efter omstarten, och en båt som ansluter till en redan varnad öppning
  får en egen varning. Under pausen står enhetens gamla text kvar.

**Granskningen.** O1 gick två varv. Första varvet fann att O1 rättade ett verkligt fel på rätt
ställe men sparade positionen utan att pröva om den dög som bevis (det obekräftade hoppet, en krasch
inom sex timmar efter en ordnad omstart och en lång paus där båten vänt); det gav den rena
positionen, förbrukningen och U83. Andra varvet godkände O1 som helhet, timern, registerposten och
svepet, och fann systerstället vid radering. Ärendet med U84, svepets nya mått och texterna
godkändes i ett varv. O3 gick ett varv och ett sista varv med bara test och text. I O3:s första
varv var alla 29 korpusar (banken och k1–k4) bitlika med spetsen före O3, omstartssvepet före och
efter gav 0 bättre och 0 sämre av 1 112 omstarter, och regressionstesten fällde spetsen före O3 (4
röda av 8); två mutanter av kajbokföringen överlevde. Det sista varvet lade till två test som fäller
dem (ett hopp inom närområdet flyttar inte posten, och kajbokföringens bredare prövning) och
meningar i `docs/ARCHITECTURE.md` om priset i graven (U86), kajbokföringens prövning och de ställen
som inte är prövade.

**Sidofynd.** PRICKBJORN i k1 (2026-11-12 08:26) får en öppningsvarning efter en omstart, men den
finns i samma omstartspunkter på basen och är inte O1:s verk. En båt utan fartgivare som sänder var
180 s får i granskarens prob inga notiser alls, också på `a7e83bb`, eftersom hon aldrig bygger
rörelsebevis (U63); det går till nästa omgång.

**Verktyget.** `npm run replay:restart` (`docs/VALIDATION.md`) kör omstartssvepet som ett stående
verktyg, med `--compare` för före och efter och granskarens strängare mått. Miljövariablerna heter
`REPLAY_RESTART_*`, och uppspelningen utan dem är bitlik med förut. Det prövar inte sammanslagningen
av källorna, AISHub efter omstarten eller fler än en omstart per uppspelning.

**U85 (dirigentens beslut): resetillståndet sparas inte över en omstart.** Förslaget var att spara
båtens rörelsebevis, målbro, riktning och passerade broar vid stoppet och återställa dem för en båt
som hörs igen inom 15 minuter och 50 m från sin sparade position. En förstudie prövade det på samma
1 686 omstarter med två minuters paus och granskarens mått, med O1 som jämförelse:

- **Under förslagets eget villkor går det mesta inte att rätta.** Av felen som är kvar efter O1
  uppfyller högst 8 av 602 notisfel, 84 av 536 varningsfel och 3 389 av 8 201 minuter fel text
  villkoret (en övre gräns för nyttan), och nästan allt gäller den stilla båten i kön. O1:s kända
  pris rättas inte i ett enda fall: PILOT 761 hörs igen 521 respektive 260 m från den sparade
  positionen i de två omstarterna, och ELFKUNGEN 859 och 765 m.
- **Hur ofta appen startar om.** I fältproven startade appen 4 gånger på 266,8 timmar logg, alla
  avsiktliga driftsättningar, utan krascher och utan oplanerade omstarter. Hur ofta den installerade
  appen startar om (appuppdateringar, Homeys uppdateringar, strömavbrott) går inte att mäta i
  något befintligt underlag; uppskattat 10–25 gånger per år.
- **Tre engångsprototyper**, inte committade. *Hela listan* gav 1 414 minuter mindre fel text
  (−17 %), men 4 omstarter blev sämre, bland dem en där MARY (2026-08-07) fick en falsk
  "Stridsbergsbron öppnar snart" för en bro hon aldrig gick till och tre varningar uteblev. *Bara
  riktningen* (rörelsebevisen plus ruttlåset och slutmålet, prövad på 849 omstarter) gav 5 sämre,
  bland dem samma falska varning och en utebliven varning i k1. *Bara gravens fält*
  (rörelsebevis, stillhetsklocka och episodankare) gav 1 sämre omstart som inte märks för
  användaren (ett konvojbyte) och 49 minuter mindre fel text.
- **Per slumpvis omstart** ger hela listan under en minut rättare text i sommartrafik (0,95
  minuter) och 0,15 i november; uppskattat 5–12 minuter rättare text och 0,1–0,3 rättade
  varningsfel per år.

Skälet: nyttan är minuter per år, och priset är risken för falska öppningsvarningar, eftersom de
händelser som släpper fälten i minnet (en väntande vändning, en ny resa, en avgång efter lång
förtöjning) inte följer med. Beslutet omprövas om det visar sig att den installerade appen startar
om ofta under säsongen (gränsen ligger runt 60 omstarter per säsong för en timme rättare text). Om
det ändå byggs är gravens fält den enda nivå som inte gav något sämre.

### 19.8 Uppföljning i fältprov 4

Fältprov 4 går på `a7e83bb` (omgång 9). Ingenting från omgång 10 finns i det, och spåren i 19.3–19.6
ändrade ingen appkod.

1. **Det fältprov 3 inte kunde mäta** eftersom det gick på `a0d8706`: punkt 4 i 18.8 (vilka sändare
   som ignoreras, att fångstjournalens löpnummer är hela och svansen bevisad, klocksteg och
   framtida stämplar, och vaktens omstarter och larm med U66 + U73). Simulerat på fältprov 3:s
   trafik gav U66 och U73 0 omstarter och 0 meddelanden; fältprov 4 visar det verkliga talet, och om
   AISstream någon gång dör helt, det enda läge där paketet kostar något.
2. **Hålen i loggströmmen och Homeys eget nät** (19.1, punkt 4): följer ett hål ett nätfel på Homey
   (AISHub-räknaren för nätfel, en AISstream-återanslutning inne i hålet), och läker journalen det?
3. **Den sena varningen efter väntan vid Järnvägsbron** (19.3): fler fall med båda källorna. När
   bron öppnar syns inte i data, så den öppna frågan i 19.3 besvaras inte av ett fältprov.
4. **Restiden före väntan vid Järnvägsbron** (19.1, punkt 2; 14.6, punkt 1).
5. **Omstarter i fält** (16.4, punkt 1): fältprov 3 hade inga.
6. Mätlistorna i 17.9 och 18.8 och uppföljningslistorna i 14.6, 15.6 och 16.4 i övrigt.

### 19.9 Slutbatteriet

Kört 2026-11-27 kl. 21:15–23:07 lokal tid i en fristående kopia av integrationsgrenens spets
`332ddf2`, med de tunga stegen genom kön. Det är spetsen före den här dokumentcommiten, som bara
rör dokumentationen. Alla 18 steg slutade med kod 0. Jämförelsen görs mot slutbatteriet i omgång
9 (18.10).

| Steg | Utfall |
|---|---|
| `npm run lint` | 0 |
| hela jest (`--detectOpenHandles`) | 456 sviter, 7 229 test gröna, 2 överhoppade (omgång 9: 450 och 7 175; skillnaden är omgång 10:s nya test) |
| `replay:all`, med och utan monitoring | alla låsta korpusar matchar facit; loggarna identiska med omgång 9 |
| `replay:synthetic` | 245 scenarier rena; 25 WARN-rader i 24 scenarier, samma som omgång 9 (de sex nya ger ingen) |
| `replay:openings` | loggen identisk med omgång 9 |
| soak och `replay:monitoring` (72 h) | samma utfall som omgång 9; bara minnesanvändningen skiljer (38 mot 42 MB och 42 mot 43 MB) |
| `measure:eta` | alla tal identiska med omgång 9 |
| fassvepet, med och utan monitoring | identiska med omgång 9 utöver tider och sökvägar |
| omstartssvepet (`replay:restart` på 20260804-17h-dag, raster 120 min, pauser 2 och 30 min, ordnad och hård omstart) | inga processfel och inga timers kvar efter `onUninit` |
| `hunt:selftest` | grönt |
| snabbjakten och standardjakten | 45 utslag i 19 kluster och 218 i 38 kluster, 2 kandidater vardera; kluster, registerklasser, hälsa och motorfel lika med omgång 9 |
| nattjakten (20 000 världar) | 2 373 utslag i 72 kluster, 16 kandidater (2 360 råa utslag i sanningsspåret, 52 kluster med registerpost), 0 körfel och 0 häng; kluster, registerklasser, hälsa och motorfel lika med omgång 9 |
| `git status --porcelain` före och efter nattjakten | tom |

**Nattjakten** jämfördes med omgång 9 utslag för utslag (värld, klass, bro, båt och tid): 0 nya och
0 försvunna, och radernas fingeravtryck är detsamma. Det enda som skiljer är att 85 utslag pekar på
en radhänvisning i `docs/ARCHITECTURE.md` som flyttats (1345–1374 blev 1360–1389) eftersom
dokumentet vuxit, och därmed fyndens kontrollsumma.

**`measure:eta`** skiljer sig i utdata bara i en räknad loggrad till i 20260710-13h: O1:s rad
`[LAST_KNOWN_SHUTDOWN]` om de levande båtar som sparas vid stoppet, i den körning som slutar med en
levande båt.

**Omstartssvepet** listar uteblivna notiser vid 30 minuters paus; de är informativa och är den
kända gränsen vid lång paus i 19.7.

**Slutsatsen:** i alla uppspelningar och alla 22 300 byggda världar beter sig appen exakt som i
omgång 9. Omgång 10:s appkod (O1, U83, U84 och O3) verkar bara över en omstart och vid ett
obekräftat GPS-hopp, och det syns bara där det ska: i de nya testen, de nya scenarierna och
omstartssvepet.

## 20. Omgång 11, vid sidan av fältprov 4: natten 27–28 november 2026

Tillagt 2026-11-28. Omgång 10 pushades till `main` (`5a975d8`) sent på kvällen den 27 november.
Ägarens besked samma kväll var att dirigenten kunde fortsätta: "du kan göra fler saker för att
förbättra appen". Fältprov 4 går sedan 2026-11-27 10:27 UTC på `a7e83bb` (omgång 9), och omgång 11
arbetade vid sidan av det i samma form som omgång 9 och 10: huvudkopian rördes inte, allt arbete
gick i egna arbetskopior utgångna från `5a975d8`, tunga körningar gick genom en kö med sänkt
prioritet, varje ändring fick en oberoende granskare och högst två varv. Besluten U87–U94 fattade
dirigenten på ägarens uppdrag, och ägaren kan ändra vart och ett. Push av omgång 11 kräver ett nytt
besked. Alla tider är UTC om inget annat sägs.

**Varför de här spåren.** Nattjakten i omgång 10:s slutbatteri (20 000 byggda världar) hade 16
kandidatkluster med 429 utslag, bland dem öppningsvarning efter passagen (22), öppning utan varning
(41), ledtid under 60 s (36) och minutsiffra som hoppar (316). I inspelad trafik är "ingen varning
efter passagen" en av appens styrkor (19.2), så varje sådant utslag i en byggd värld är antingen en
gräns i världen eller i oraklet, en känd gräns som buggjägarens beslutsregister inte känner igen,
eller ett verkligt fel som den inspelade trafiken inte når. Det är ägarens fråga från omgång 10
(simulera och se svagheter och styrkor), ställd till de byggda världarna.

Spåren:

- **Fältprov 4:s första fartyg (D):** de första 12,3 timmarna mot rådatan (20.1).
- **Öppningsvarningarna i nattjakten (A):** 104 utslag (20.2).
- **Minutsiffrans hopp i nattjakten (B):** 316 utslag, och U34 mätt i inspelad trafik (20.2, 20.3).
- **Notiser, riktning och båtar utan fartvärde (C):** 9 utslag, och båtar som saknar fart eller
  kurs (20.2, 20.4).
- **De nya klasserna i nattjakten med slumpfrö 2 (E):** 8 utslag, och rättningen U93 (20.5, 20.6).
- **Kajgrinden mot båtar som väntat på en broöppning (K):** mätning (20.5).
- **Verktygsspåret (U90, U91):** registret och oraklen lär sig det utredarna fann, av spåren A, B
  och C (20.7).

Spåren D och K ändrade ingenting i repot, och verktygsspåret ändrade ingen appkod. Omgångens enda
appkod är rättningen U93 (spår E) i `lib/services/VesselDataService.js`.
I integrationsgrenen `omg11/integration`: C `04a088b`, `1801d96`, `9b8018f`, `81096c7`; A `8e77697`,
`55bab70`, `26051a5`, `31cd1c7`, `cb9fd8a`; B `a7749ef`, `bb54741`; postlistans räknare i
`docs/BUGGJAKT.md` §7 i `125bf78`; E `e21d420`, `9208253` och radhänvisningarna efter E i `611e791`; antalet scenarier (256) i
`8ae19f6`; postlistan i `docs/BUGGJAKT.md` §7 med alla 62 poster i `20e686e`, och anmärkningen om
arbetsmappen i samma avsnitt i `85d44e3`.

### 20.1 Fältprov 4:s första fartyg

Ögonblicksbilden togs 2026-11-27 22:45, efter 12,3 timmar (10:27–22:45; 311 positioner). Ett
fartyg gick genom kanalen: WILSON ELBE söderut 20:06–20:36. Ledtiden räknas som i avsnitt 19, från
notisen eller varningen till korsningen av brolinjen enligt rådatan, på positionernas egna tider.

| Bro | Notis | Ledtid | Öppningsvarning | Ledtid |
|---|---|---|---|---|
| Stallbackabron | "strax" | 9 s efter korsningen | – | – |
| Stridsbergsbron | "om 2 minuter" | 79 s | eta 5 (tidsgränsen) | 339 s |
| Järnvägsbron | "om 1 minut" | 30 s | – | – |
| Klaffbron | "om 2 minuter" | 96 s | eta 5 (en position) | 312 s |
| Olidebron | "om 2 minuter" | 101 s | – | – |
| Kanalinfarten | "om 2 minuter" | 30 s efter att hon kom in i zonen | – | – |

- **Rätt bro, rätt riktning, inga extra notiser eller varningar.** Alla siffror i notiserna låg
  inom en minut från verkligheten.
- **Stallbackabron kom efter passagen.** Hennes första position var en 27 s gammal AISHub-position
  338 m från bron (notisradien är 300 m), nästa låg redan förbi bron, och AISstream hade varit tyst
  i 16 minuter. Ett täckningsfall, inte ett regelfel; i sommarbokslutet kom 30 % av notiserna vid
  Stallbackabron efter passagen, mest med en källa.
- **Brotexten** var rätt varje minut med fältprov 3:s gränser; siffran var som mest 1,3 minuter för
  hög. "Strax" låg kvar 54 s efter passagen av Stridsbergsbron och 27 s efter Klaffbron, till nästa
  position. Hon väntade aldrig.
- **Driften:** inga hål i loggströmmen, löpnumren 1–347 utan lucka, en appstart, en
  AISstream-anslutning, 0 utlöpta handskakningar, 0 vaktomstarter, 0 larm, 0 nätfel hos AISHub;
  längsta AISstream-tystnad 69 minuter. Fältprov 3 hade 2 hål, 113 utlöpta handskakningar och 48
  omstarter (19.1).
- **PILOT 761** ligger förtöjd 160 m från Kanalinfartens punkt. Varje position, 247 på 12,3 timmar,
  prövas för en notis och stoppas av förtöjningsspärren. Det är rätt; kostnaden är bara loggbrus på
  full loggnivå.
- **Uppspelningen:** `a7e83bb` och `main` ger byte för byte samma utfall, och fältet paras med
  uppspelningen i 6 av 6 notiser, 2 av 2 varningar och 13 av 13 texter.

Integritetsgrinden ger FEL på ögonblicksbilden, eftersom det sista samplet och svansen saknas i en
kopia tagen under gång; den ska köras om på den slutliga körningen. Dirigentens bedömning: ingenting
att rätta.

### 20.2 Nattjaktens 429 kandidatutslag utredda

Varje utslag byggdes om ur sitt världsnummer, spelades upp med appens fulla logg och dömdes igen;
alla återkom exakt. **Inget av dem är ett okänt fel som syns i inspelad trafik.**

**Öppningsvarningarna (104 utslag i 98 världar).** 103 är beslutat beteende eller en dokumenterad
känd gräns som registret inte kände igen, och ett är ett mätfel i oraklet. Mekanismerna:

| Mekanism | Utslag | Beslut eller gräns |
|---|---|---|
| Spärren vid Järnvägsbron: rörelsegrenen, reserven efter 300 s, eller släppet på första positionen bortom bron | 35 | M6 val B, U32, U38/U81, U79 |
| Returen efter en U-sväng bekräftas inte eller för sent (Fix D kräver två omvända positioner i minst 2 kn) | 19 | U18 |
| Vändningen bekräftas 11–59 m från målbron, och målbron skjuts upp till nästa position | 3 | under-bro-vakten |
| Osäker kurs: ny båt med kursen strax utanför banden, eller bekräftad vändning med osäker kurs | 8 | U48, D8B |
| En täckt båt korsar strax efter konvojfönstret | 11 | fältgranskningen 12.5 |
| Säkerhetsvarning för en tyst båt som redan passerat, vänt eller lämnat | 12 | U17 |
| Stilla eller tyst täckt båt som släpps sent | 6 | U25, U26, U38 |
| U42, U47 (returbåtens referens), oraklets referens, kajgrinden | 2, 3, 1, 1 | U42, U47, mätfel i oraklet, V1-kajgrinden |
| Bakkanten dömer på prognosen nära bron fast fysiken ligger inom fönstret | 3 | känd gräns sedan omgång 5 (20.4, U88) |

**Minutsiffrans hopp och "Inga båtar"-blinket (316 utslag i 294 världar).** 315 är fattade beslut,
kända gränser eller sådant oraklet inte ser; ett är ett möjligt fel (F2: vid en vändning sätts
målbron om till Klaffbron innan vändningen bekräftats, "om 11" i 66 s), som finns 0 gånger i banken
och fältet. De 309 utslagen om minutsiffran har fem mekanismer: den främsta båten tystnar och
gruppen visar nästa båts tid (U34; 186 utslag); "strax" släcks och kommer tillbaka kring en uttömd
nedräkning (U16; 62); båten som bar tiden lämnar gruppen, vilket ger rätt text som oraklet inte ser
(38); kryp strax före bron (U31:s rest; 11); köavgång och vändning (12). Av de 7 utslagen om
"Inga båtar"-blinket är 6 en tyst båt som släpps och kommer tillbaka (U1/C11) och 1 är F2.

**Notiser och riktning (9 utslag).** Sju är kända beslut som registret eller oraklet inte känner
igen. Två är fel i snäv mening, båda 0 gånger i inspelad trafik: en position med kurs i Fix D:s
dödband nollade en väntande vändning (F10), och en enda position 20 m före Järnvägsbron bytte mål i
samma tick (F14).

**Samlad bild:** fyra fel i snäv mening (bakkanten nära bron, F2, F10 och F14) finns bara i byggda
världar. Ingen apprättning följer av de 429 utslagen.

**Rättelse.** Omgång 4 (avsnitt 13, spår T2) utredde nästan samma öppningsvarningsutslag, 125 stycken, och
skrev registerförslag. Förslagen genomfördes aldrig: verktygsspåret i omgång 4 fälldes eftersom
posterna var för breda, och U47:s beslutade post lades aldrig in. Därför har samma kluster stått som
kandidater i varje nattjakt sedan dess, och utgångspunkten för den här omgången ("ingen har utrett
dem sedan omgång 2") var fel. Det är skälet till verktygsspåret (20.7).

### 20.3 U34 mätt i inspelad trafik (U87)

U34 är regeln att gruppens text visar nästa båts tid när den främsta båten tystnat. I de byggda
världarna passerade den tysta båten bron först efter hoppet i 110 av 186 fall, och siffran var då i
median 14 minuter för hög (p90 25 minuter); öppningsvarningen kom ändå minst 2,5 minuter före i 105
av 108 fall.

Mätt i banken, k1–k4 och fältprov 4:s ögonblicksbild (784 timmar), med sommarbokslutets domare:

- 33 episoder, 121 minuter, där en annan båts tid visas medan den främsta är tyst. 28 av dem i
  körningar med bara AISstream, 5 med båda källorna (15,5 minuter), 0 i fältkörningarna.
- Den visade siffran var i median 2,3 minuter för **låg** mot den tysta båtens passage (i de byggda
  världarna 14 minuter för hög): på sommaren betyder tystnad oftast att båten köar vid bron.
- Alternativen: den tysta båtens egen nedräkning är sämre och hade gett 58,5 minuter falska löften
  där texten i dag ärligt säger "ETA okänd"; "ETA okänd" för hela gruppen gör 64,5 felaktiga minuter
  ärliga och tappar 11,5 rätta.
- Mekanismen står för 3,6 % av sommarbokslutets felaktiga minuter.

**U87 (dirigentens beslut): U34 står kvar.** Det enda alternativet utan nya fel vinner 65 minuter på
784 timmar, bara i sommarkörningar med en källa, och ingenting i fält med båda källorna. En ändring
i textens gruppering är inte värd risken för den vinsten.

### 20.4 Båtar utan fartvärde och saknad kurs (U89), och bakkanten (U88)

**Båtar utan fartvärde.** Sidofyndet från omgång 10: en båt utan fartgivare som sänder var 180 s
får inga notiser. Mekanismen: fartkontrollen i GPS-hoppsanalysen räknar ett saknat fartvärde som 0
kn när steget mellan två positioner är längre än 500 m. Varje position märks då osäker, och båten
får aldrig målbro, aldrig öppningsvarning och, om appen hör henne första gången inne i kanalen,
inga notiser. Det fungerar vid 30 och 60 s mellan positionerna men faller vid 180 s och 6–8 kn.

Båtklassen finns inte i inspelad trafik: 3 av 41 193 positioner på 795,6 timmar saknar fartvärde
(två från en stillaliggande båt, en ensam AISHub-position), och ingen båt rapporterar fart 0 medan
hon flyttar sig (0 av 3 077 rörelsepar). En prototyp på fem rader ändrade ingenting i banken,
fältkörningarna, synthetic eller openings och gav 17 bättre och 0 sämre i variantsvepet, men 3 av
80 byggda kajfall utan fartvärde blev sämre (falska notiser), och en probvariant tappade en notis.

**U89 (dirigentens beslut): luckan rättas inte.** Både nyttan och skadan gäller en båtklass som
inte finns i 795 timmar data. Känd gräns med en mening i `docs/ARCHITECTURE.md` (vid GPS-grinden)
och scenariot "fartlös-var-180-s-6kn-inne-i-kanalen-tyst (känd gräns, U89)". Prototypen sparas och
tas fram om en sådan båt syns i fält.

**Saknad kurs.** En båt som saknar kurs och är mer än 300 m från närmaste bro får ingen målbro
(`_calculateTargetBridge`), och därmed ingen öppningsvarning. 1 260 av 41 193 positioner (3,1 %)
saknar kurs, 1 153 av dem för stillaliggande båtar. 107 gäller båtar i rörelse, bara 6 i minst 2
kn, längsta följd 5 positioner, och alla de båtarna har kurs i sina andra positioner. I alla 32
korsningar av Klaffbron eller Stridsbergsbron med någon position utan kurs före saknades kursen bara
medan båten låg still. Inget fall där en båt i rörelse saknar kurs fram till en målbro; ingen åtgärd.

**Bakkanten nära bron.** Bakkanten (konvojfönstrets släpp) jämför den utjämnade restiden, inte
appens egen fysik. I 3 av 20 000 världar visade fysiken att båten skulle korsa inom fönstret, men
prognosen låg efter, och båten fick en extra, sen varning (20 s före till 85 s efter passagen) för
en redan varnad öppning. I inspelad trafik finns 4 bakkantsläpp, inget inom 100 m från bron. En
prototyp (U49:s regel också i bakkanten, högst 100 m från bron och minst 2 kn) var ren.

**U88 (dirigentens beslut): rättningen byggs inte; känd gräns med registerpost.** Nyttan är noll i
784 timmar inspelad trafik, skadan är en extra varning för en redan varnad öppning, och
öppningstjänstens bakkant är den känsligaste delen av appen. Prototypen sparas.

### 20.5 Nattjakten med slumpfrö 2, vändningar i låg fart (U92) och kajgrinden (U94)

För första gången kördes nattjakten med andra världar än slumpfrö 1, på `5a975d8`: 20 000 världar,
0 körfel, 0 häng, självtestet grönt; 2 168 utslag i 67 kluster, 19 kandidatkluster med 450 utslag
(slumpfrö 1: 2 373, 72, 16 och 429). De gamla klasserna kom i ungefär samma antal. Fyra klasser var
nya bland kandidaterna, med 7 utslag, alla med störd radio och sex ur världar med U-sväng eller kryp:

| Utslag | Vad hände | Dom |
|---|---|---|
| Dubbelnotis vid Stallbackabron (2) | Passage under tystnad, sedan vändning: "passerade … under AIS-tystnad" och strax därefter "närmar sig" åt andra hållet. Båda sanna. | oraklet (INV-2 mäter mellan notistiderna) |
| Ingen notis vid Klaffbron (2) | Första positionen efter ett glapp ligger 7 m bortom brolinjen men söder om brons latitud (kilen), med kursen söderut; passagen bokförs men S10-vakten tiger, och vid nästa position har båten korsat tillbaka | verkligt, på en knivsegg (vändning precis vid linjen) |
| Stridsbergsbron inte bokförd (2) | Återinträdesspärren avvisar den enda positionen inne i kanalen efter en vändning i tystnad | känd gräns |
| Fantompassage (1) | Efter 25,6 minuters tystnad dyker båten upp 17 m bortom Stridsbergsbron, i kilen; målbrobytet går en väg som saknar kedjan som annars bokför den nya målbron, och passagen bokförs 12 minuter för sent: en öppningsvarning 5 s efter passagen och 12 minuter "på väg mot Stridsbergsbron" | verkligt, inom en känd gräns vars följd var underskattad (20.6) |

Därtill värld 9428, där en båt i 7 kn inte fick några notiser: hon vänder 178 m före
Stallbackabron och korsar ingen bro, och U44 säger att ingen notis ska gå ut. I inspelad trafik slutar 4 av
481 linjekorsningar i kilen; alla fyra var vanliga transiter som bokfördes rätt. Ingen av de nya
klasserna syns i inspelad trafik. Ingen notis vid Klaffbron rättas inte (en vändning precis vid
linjen, och rättningen ger fel tempus och kan ge en falsk notis); känd gräns.

**Vändningar i låg fart (F2).** Med slumpfrö 2 kom F2 i en längre form: en båt vänder och går
därifrån i under 2 kn, Fix D bekräftar inte vändningen, och texten säger "på väg mot Klaffbron, om 11
→ 16 minuter" i 6–10 minuter (två världar, 0 gånger i inspelad trafik).

**U92 (dirigentens beslut): F2 rättas inte nu; post för känd gräns.** En vändning i under 2 kn som
Fix D inte bekräftar har inte setts i inspelad trafik. Flera spår i natten pekade på samma område
(returen efter U-sväng: 11 utslag med slumpfrö 2 bland öppningsvarningarna, 4 bland notiserna, 6
bland minutsiffrorna), så om en långsam vändning syns i fält är det första stället att titta.

**Kajgrinden mot båtar som väntat på en broöppning.** I en byggd värld med slumpfrö 2 köar en båt en
timme cirka 70 m från Stridsbergsbron, går därifrån söderut genom Järnvägsbron, vänder och kommer
tillbaka norrut i 2,7–3,0 kn. Appen bekräftar vändningen och sätter målbro Stridsbergsbron men beväpnar aldrig
öppningsvarningen: kajgrinden räknar kön som en kajvistelse och kräver en position i minst 3,13 kn.
Hon passerar Stridsbergsbron utan varning. Samma mekanism gav 54 s ledtid i en värld med slumpfrö 1.

Mätt i inspelad trafik (795 timmar, 30 uppspelningar): kajgrinden står inte för någon sen eller
utebliven varning för en båt som väntat på en öppning. Den nekade 6 gånger i 3 episoder: BARAVI
(väntade 216 m söder om Klaffbron; varningen kom ändå 1 070 s före, lika med och utan grind), EUGENIE
(en riktig kajavgång; varnad 183 s före, utan grind 722 s) och NICOLINE (korsade aldrig). Grinden
stoppade heller ingen falsk varning, och den nekade ingen av de 13 sena varningarna efter väntan vid
Järnvägsbron (19.3). Felet kräver kön, avfärden genom en annan bro, vändningen och en återkomst i
under 3,13 kn inom två timmar; båten kan då aldrig komma 40 m närmare bron än sin väntplats. En
prototyp (grinden nekar inte när båten varit minst 150 m från väntplatsen) ändrade ingenting i banken
och fältet och rättade de två världarna, men gav en extra sen säkerhetsvarning i standardjakten och
är inte prövad mot kajflyttar på minst 150 m.

**U94 (dirigentens beslut): prototypen byggs inte; känd gräns.** Utlösaren har inte setts i 795
timmar och är osannolik, och rättningen är en lättnad i ett skydd mot falska varningar, med en mätt
kostnad och en omätt risk. Skillnaden mot U93: där görs en väg lik de andra utan kostnad, här öppnas
en grind. Prototypen sparas; utslagen står kvar som kandidater i registret.

### 20.6 Rättningen U93

**Felet.** I en byggd värld med slumpfrö 2 tystnar en båt före Olidebron på väg norrut och hörs
igen efter 25,6 minuter, 17 m bortom Stridsbergsbrons linje men 19 m i sidled, så att positionen
ligger söder om brons latitud (den omvända kilen: brolinjerna går snett, och en position kan vara
förbi linjen men inte förbi latituden). I samma position korsas Klaffbron, som var målbron, och
Stridsbergsbron blir ny målbro. Målbrobytet löstes på en väg (`TARGET_PENDING_RESOLVED`, båten är
mer än 300 m från den passerade bron) som saknade kedjan som annars prövar den nya målbron mot
samma segment, och svepet över glappet väljer broar på latitud och hittade inte bron. Passagen
bokfördes först 12 minuter senare vid Stallbackabron. Användaren fick **en öppningsvarning för
Stridsbergsbron 5 s efter passagen och i tolv minuter "på väg mot Stridsbergsbron, strax / ETA okänd
/ om 12 minuter"** medan båten gick bort.

**Aldrig sett i inspelad trafik, och ändå rättat.** I inspelad trafik slutar 4 av 481
linjekorsningar i kilen, alla vanliga transiter som bokfördes rätt; ingen hade båda målbroarna i
samma segment. Skälen för att rätta (U93): utlösaren är fysiskt rimlig i den här kanalen (ett långt
radioglapp som slutar med en första position strax bortom målbron; 36 % av notiserna med en källa
kom under tystnad), följden är det allvarligaste appen kan göra (varning efter passagen och tolv
minuter fel text), och rättningen gör en väg lik de andra i stället för att lägga till en regel.
Skillnaden mot U88 (mild följd) och U89 (utlösaren finns inte i verkligheten) är rimligheten gånger
allvaret.

**Rättningen** kör samma kedja också efter `TARGET_PENDING_RESOLVED`, och bokföringen görs av den
vanliga vägen, men bara när tre villkor håller:

1. svepets latitudfönster når inte den nya målbron (annars bokför svepet som förut);
2. segmentets start ligger mer än 10 m före och båten mer än 10 m bortom brons linje;
3. positionens egen fart är minst 2 kn.

De två sista kom till under rättningen: utan dem bokfördes en båt som efter glappet väntar tätt
före linjen, eller vars första position är en utliggare bortom den, som passerad, eftersom appens
avståndsreserv räknar en position inom 50 m och ±10 m från linjen som sidbyte. Banken, k1–k4 och
fältprov 4:s ögonblicksbild är byte för byte oförändrade, liksom `replay:all` med och utan
monitoring, openings, fassvepen, `measure:eta` och snabb- och standardjakten. Tio scenarier låser
det: två som fäller koden utan rättningen (norrut vid Stridsbergsbron och söderut vid Klaffbron),
sju motfall (bland dem två som fäller rättningen utan villkor 2 och ett som fäller den utan villkor
3) och ett som låser priset.

**Det godtagna priset.** Är båten i själva verket före Stridsbergsbron och hennes första position
efter glappet en utliggare mer än 10 m in i kilen i minst 2 kn, bokförs en passage som inte skett.
Basen bokför samma falska passage en position senare, men hinner skicka öppningsvarningen; med
rättningen uteblir varningen före den verkliga passagen. I granskarens byggda fall norrut gick 53 s
till drygt 6 minuter ledtid förlorad; söderut ändras ingen varning (Klaffbrons varning har redan
gått), men passagen bokförs 60 s tidigare och i ett fall tillkommer en falsk notis norrut. I 795
timmar inspelad trafik spänner 38 segment båda målbroarnas linjer, och inget slutar närmare den
andra målbron än 79 m; de fyra kilfallen landade 1,2–3,4 m in, och rättningen verkar först mer än
10 m in. Granskaren uppskattade riskfallet till ungefär hundra gånger ovanligare än felet som
rättas. Dirigenten godtog priset. Järnvägsbron bokförs i ett sådant hopp som härledd passage i
stället för mellanbropassage; ingen notis, text eller varning ändras av det.

**Granskningen** gick två varv. Första varvet fann två luckor i test och text, inte i logiken:
villkor 2 fälldes inte av något test, och `docs/ARCHITECTURE.md` beskrev utliggarfallet som "på samma
sätt som förut", vilket inte stämde för varningen. Andra varvet lade till tre scenarier och skrev
priset i klartext, och godkändes.

Ingen notis vid Klaffbron i den andra kilvärlden (20.5) rättas inte; den står som känd gräns i
`docs/ARCHITECTURE.md`.

### 20.7 Verktygsspåret (U90, U91)

**U90 (dirigentens beslut): registret och oraklen uppdateras nu, av de tre utredarna medan
kunskapen är färsk.** Samma utslag hade utretts två gånger (omgång 4 och 11) utan att registret
ändrats, så varje nattjakt visade 429 kandidater, och en ny mekanism skulle drunkna. Kraven: ingen
appkod; varje predikat binds till appens egen bokföring eller exakta släpptid, inte till tidsfönster;
för varje post visas att en mutant (appen gjord fel i just den mekanismen) fortfarande ger
kandidatutslag; självtestet grönt; snabb- och standardjakten före och efter; och ett prov utanför
urvalet, nattjakten med slumpfrö 2. En oberoende granskare prövade allt med egna mutanter, och det
som fälldes lämnades utanför.

**Det registret och oraklen nu känner igen.**

- **Öppningsvarningarna:** spärren vid en tidigare bro (bunden till appens släpptid; släppet flyttat
  2 s gav 6 av 34 träffar kvar), returen utan omvänd position (U18), under-bro-vakten, bekräftad
  vändning med osäker kurs (D8B), konvojfönstrets kant, returbåtens referens (U15/U47, den beslutade
  posten från omgång 4) och bakkanten nära bron (U88). Harnessen bokför nu två av appens egna
  debugrader: spärrens håll och släpp och under-bro-vaktens uppskjutna målbro. Med slumpfrö 1 kändes
  73 av 104 utslag igen före granskningen, med slumpfrö 2 62 av 99; av dem står 6 respektive 17 åter
  som kandidater sedan U48-posten togs bort.
- **Minutsiffran:** U34 (den främsta båten tystnar), U16 ("strax" släpps vid appens gräns), U31:s
  rest, köavgång, U1/C11, U92 och bäraren som lämnade gruppen. Harnessen bokför för varje båt vid
  varje text appens visade minuter, positionsklocka, fart och köbro, och appens målbrobyten. I
  utredarens 294 världar känns 279 av 316 igen och 37 står kvar; med slumpfrö 2 278 av 320.
- **Notiserna:** R2:s liv efter appens radering (en båt hörd utanför kanalens gräns, raderad utan
  målbro), T3-oraklets U17-kedja (fönsterslutet räknas från den händelse som täckte båten vid
  korsningen) och dödbandet i Fix D (F10, KÄND_ÖPPEN, med kravet att ingen brolinje ligger mellan
  raderna).

**U91 (dirigentens beslut): den gamla posten LEDARBYTE-TYST-FRÄMSTA ersätts av den strängare
U34-posten.** I mutantproven godtog den gamla posten 4 respektive 20 hopp som ett räknefel i restiden
förstorat; den nya kräver att den tysta båten korsar före nästa båt och att nästa båts tid är rimlig
mot hennes verkliga korsning.

**Det granskaren fällde, och som togs bort i stället för att lagas.** Fem delar togs bort:
U19:s nya RECOVER-prov, posterna C-P5-SYDBAND-FÖRE-LINJEN, C-ENSAM-FIX-FÖRE-MELLANBRO och
A11-U48-KURSBAND-NY-BÅT, och E2-VÄNDNING; dessutom står INV-3 kvar som på basen. Kandidaterna står
då kvar som förut, vilket är ofarligt.

- **Två poster som svalde ett fel i återfödelsen** (riktningen ur förflyttningen sedan graven):
  P5:s strikta sydband och U48 (ny båt med kursen i det osäkra bandet). Med felet inlagt i appen
  kände posterna igen utslaget som avsett beteende.
- **En post för en ensam position före en mellanbro** (F14) svalde en utebliven notis när
  närmaste-bro-grenen bland notiskandidaterna stängdes av.
- **U19:s nya RECOVER-prov** kände inte igen bakkantens RECOVER-släpp och godtog en inlagd
  bakkantsdom som basen kallar kandidat.
- **Posten för minutsiffran över en vändning** godtog varje hopp som spände över bärarens vändning,
  oavsett storlek.
- **Lättnaden i INV-3** (bärarbyte efter en bokförd passage eller till väntgruppen) litade på appens
  egen passagebokföring, så en falsk passage hade också godkänt hoppet. Invarianten vaktar också
  banken och ska inte bli mildare; den är som på basen, och mekanismen känns i stället igen av en
  registerpost som kräver att passagen motsvaras av en sann korsning.

**Det som står kvar som kandidater:** bland öppningsvarningarna U17-familjen, stilla eller tyst täckt
båt (U25, U26, U38 för T3), U42, U48, oraklets referens och kajgrinden (U94); bland minutsiffrorna
bl.a. hopp från "strax" under U16:s gräns, fall där den tysta båten korsar efter nästa båt, och F2 i
den form U92-posten inte täcker; bland notiserna de utslag som de borttagna posterna gällde.

**Snabb- och standardjakten:** de nya posterna ändrar ingen annan registerklass. För minutsiffran gick
snabbjakten från 2 kandidatkluster till 0 och standardjakten från 25 kandidatutslag till 4.

### 20.8 Uppföljning

**I fältprov 4, när provet är slut:**

1. Integritetsgrinden och fassvepet på den slutliga körningen, med stoppfilen (U77).
2. Stallbackabron söderut: hur ofta första positionen ligger utanför 300 m och nästa redan är förbi
   bron, med båda källorna.
3. Hur länge "strax" ligger kvar efter passagen (54 och 27 s i fältprov 4, inom 58 s i fältprov 3).
4. Om AISstream någon gång dör helt, det enda läge där U66 och U73 kostar något.
5. En långsam vändning som Fix D inte bekräftar (U92): första stället att titta om den syns.

**Till nästa omgång, inte genomfört:**

1. Oraklet INV-2 godtar paret "passerade under tystnad" och "närmar sig" efter en bokförd passage;
   T10:s position före korsningen ska vara den sista före korsningen; poster för återinträdesspärren
   och för en vändning före Stallbackabron.
2. De tre öppningsvarningsfamiljerna som lämnades ogjorda (U42 begränsning 1, U25/U26 för T3 och
   U17-predikatets tystnadsprov) kräver ändringar i befintliga, långa predikat med egna mutanter.
3. Granskarens låga anmärkningar på de godkända posterna (bland annat att posten för bäraren som
   lämnade gruppen inte prövar korsningens riktning).
4. Loggbruset för en förtöjd båt vid Kanalinfarten (cirka 500 rader per dygn på full loggnivå).
5. Registerposter för de fel i snäv mening som inte rättades: bakkanten nära bron (U88), F2 (U92)
   och dödbandet i Fix D (F10) har poster; den ensamma positionen före en mellanbro (F14) och
   ingen notis vid Klaffbron i kilen (20.5) saknar post, och kajgrinden (U94) står som kandidat.

### 20.9 Slutbatteriet

Utfallet förs in när slutbatteriet är kört på omgångens slutliga spets.
