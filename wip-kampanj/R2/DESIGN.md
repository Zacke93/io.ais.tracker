# R2: passage och notis — design med prototyp (revision 2, efter omgranskningen)

Familj R2 i rättningskampanjen 2026-11-04. Korten är F12 och F16 (GPS-grindens
dubbelbokföring), F13 (BN2-luckan när kursen inte säger nord eller syd) och F08
(fasberoendet vid Järnvägsbron).

Prototypen är tre commits i `K/R2/wt`:

- `e0e8124`: den första prototypen (förälder `7699cbe`);
- `8318c1a`: revision 1, efter granskningen (förälder `e0e8124`);
- `c02d88e`: revision 2, efter omgranskningen och dirigentens beslut (förälder `8318c1a`).

Patchen mot `7699cbe` ligger i `K/R2/patch.diff`. Radnummer i texten avser
`7699cbe` om inget annat sägs.

## Kort sammanfattning

Tre fel, tre små rättningar. Ingen ändrar något låst facit.

| Kort | Vad som hände | Varför | Rättning |
| --- | --- | --- | --- |
| F12, F16 | Stridsbergsbron bokförd två gånger. Den andra gången som mellanbro, 13 min efter den första, medan båten låg stilla i kön. | GPS-grinden höll en kandidat för bron. Glappvägen bokförde samma passage, men kandidaten släpptes aldrig och bekräftades senare. | När en bro bokförs släpps grindens kandidat för just den bron. |
| F13 | "SALTIS närmar sig Olidebron, beräknad ankomst om 1 minut", 115 m efter bron. | BN2 kräver färdriktning. En återfödd båt utan ruttlås fick ingen, när kursen låg i dödbandet 46–134° (49,9°) eller saknades (AIS 360). | När kursen inte säger nord eller syd får K1:s färska nordprogress ge riktningen norrut. |
| F08 | SINE BRES Järnvägspassage tappades om klockan låg 2,5, 5 eller 7 s förskjuten. | Beviset för att båten korsat brolinjen när den kom in i zonen prövades först i ett senare pass. Om det passet hann före nästa fix berodde på klockfasen. | Beviset prövas i det pass som skjuter upp under-bro-grenen, och det sparas tills zonbesöket vid bron har startat. |

## Vad omgranskningen hittade och vad jag har ändrat (revision 2)

| Omgranskningens punkt | Allvar | Vad jag gjorde | Belägg |
| --- | --- | --- | --- |
| F13: rättningen täcker inte båtar utan kurs (AIS 360 blir null), så klassen är inte stängd. | medel | Valt sätt (a): samma K1-mätning ger `north` även när kursen saknas (§2, §3). K1 själv är orörd. Testets null-fall är vänt till sant, och SALTIS med kursen 360 går genom hela appen (nytt test). | Granskarens repro (`saltis-cog360.jsonl`, `saltis-cognull.jsonl`) ger nu "SALTIS passerade Olidebron under AIS-tystnad". Banken: 0 BN2-prövningar där regeln slår till (26 prövningar, alla hade riktning ur ruttlås eller kurs), 0 skillnader i 48 körningar. |
| Fråga 2 var svår att förstå och delvis fel om värld 1227. | låg | Frågan är besvarad (dirigentens JA). §6 är skriven om till ett beslutat avsnitt med rätt beskrivning av båda världarna, och registerposten har ett smalt predikat (§12). | Predikatet är prövat på 1227, 1731, 254 och tre avsmalnande sonder (§12). |
| En fix 50–60 m inne i zonen tappar Järnvägspassagen, i både 7699cbe och patchen. | låg | Ingen kodändring. Beskriven som känd lucka i §9, i ARCHITECTURE.md (F08) och i ett KÄND LUCKA-test. Förslag till kort och registerpost i §12. | Egna prov med en extra fix på 49,1, 50,7, 54,8, 58,8, 60,4 och 62,9 m (§9). |
| (not) Även δ −5 s tappades i basen. | — | Fastestet prövar nu δ 0, −2,5, −5 och −7 s. FACIT.md och §1 nämner −5 s. | Testet är rött vid −2,5, −5 och −7 s mot `7699cbe`. |

Revision 1 (granskningen, `8318c1a`) rättade F08-beviset så att det överlever
nästa zonbesök (medel), gav varje släppställe för F12/F16 ett eget test och
beskrev F13:s mätning och samspelet med E (låga). De ändringarna står kvar
oförändrade.

## 1. Rotorsaker, bekräftade med minsta repro och logg

Alla loggar är körda med `REPLAY_VERBOSE=1 REPLAY_DEBUG_LEVEL=full`.

### F12 och F16: GPS-grindens dubbelbokföring

Minsta repro: värld 254 (17 rader, JOLLY, klass B, R1). Samma app-händelse ger
båda korten (INV-13 och T10 FANTOMPASSAGE).

Loggen, i ordning:

1. 16:03:34. Fixen efter ett 9 min glapp är GPS-osäker. `GPS_GATE: Registered
   candidate passage for Stridsbergsbron (gated)`.
2. Samma tick. `GAP_TARGET_INFERRED` och `TARGET_PASSAGE_RECORDED` för
   Stridsbergsbron. Målet blir Klaffbron.
3. 16:16:49, 795 s senare, på en stabil fix 125 m söder om bron: `Confirmed
   passage of Stridsbergsbron after 795s stability`, `ANCHOR_PASSAGE 16:16:49`
   och `INTERMEDIATE_PASSAGE_RECORDED (gate-confirmed)`.

Varför dedupen inte stoppade steg 3:

- `confirmStableCandidates` (GPSJumpGateService.js:184–257) bekräftar kandidaten
  inom sin TTL på 20 min. Inget släpper den när bron bokförs på annat sätt.
- app.js:4229–4252 skickar den till `registerConfirmedIntermediatePassage`
  (VesselDataService.js:6358), eftersom målet nu är Klaffbron.
- Studsvakten i `_anchorPassageTimestamp` (:8305–8320) släpper efter 3 min, och
  `passageId` byggs på det nya ankaret (:8249–8258). Bokföringen blir alltså ny.
- Systervägen `applyInferredPassage` (:6880) har en vakt mot broar i
  `passedBridges`, men grindvägen har ingen.

Risken var känd (B6 i `docs/reliability-review-2026-06-09.md:126–128`: "en stale
kandidat kan i värsta fall bekräftas för en redan hanterad bro"). Bara
borttagningshalvan av B6 infördes (`clearVessel`).

Samma mönster finns i banken, men där fångas det: MARY (219028537,
`20260806-42h`) fick en kandidat 11:45:45, normalvägen bokförde bron 11:46:51
och kandidaten bekräftades i samma tick. Studsvakten behöll ankaret från
bokföringen, så `passageId` var redan bokfört och registreringen hoppades
över. Vid 795 s finns inget sådant skydd.

### F13: BN2-luckan när kursen inte säger nord eller syd

Minsta repro: värld 86 (11 rader, SALTIS, klass B, AISHub, R1).

1. 08:50:46. SALTIS rör sig norrut vid Kanalinfarten med kurs 47°. "Osäker COG
   (47°) → ingen målbro tilldelas ännu." Hon tas bort på timeout.
2. 08:57:32, efter 6,8 min, föds hon igen 115 m norr om Olidebron med kurs 49,9°.
   `NORTH_PROGRESS_REBIRTH: 1.968 m/s över 406 s`. Hon har inget ruttlås.
3. Notisen byggs: `direction: okänd`, "SALTIS närmar sig Olidebron, beräknad
   ankomst om 1 minut", `already_passed: false`. Sanningen (L0): korsningen var
   08:56:38,99 norrut.
4. Först efter notisen loggas `SKIPPED_BRIDGES_DIRECTION_LOCK` (riktning norr),
   och fallbackens rättelse dedupas ("already notified for this visit").

`_hasGapCrossedNotifiedBridge` (app.js:9890) har det rumsliga beviset: Olidebron
ligger mellan sist kända position och den aktuella. Men färdriktningen kommer ur
`_routeDirection` (tom) eller kursen. Kursen 49,9° ligger varken i nordbandet
315–45° eller i det breda sydbandet 135–<315°. Därför blir svaret false.

Värld 783 (en okänd båt, aisstream, kurs 46,2°) är samma fall: 1,590 m/s över
463 s, notis 107 m efter Olidebron.

**Samma lucka när kursen saknas (omgranskningen).** AIS-värdet 360 betyder "kurs
ej tillgänglig" och blir null i `_validateAISMessage` (app.js:5302), liksom ett
ogiltigt värde (:5296). En båt med föregående fixobjekt får den gamla kursen
framförd (`_createVesselObject`, VesselDataService.js:5287), men en återfödd båt
har inget sådant objekt och behåller null. Då hoppar BN2 över hela kursgrenen
(`Number.isFinite(vessel.cog)`), och revision 1:s dödbandsregel låg inne i den
grenen. Granskarens repro är SALTIS med kursen 360 (och null) på
återfödelsefixen. Revision 1 gav fortfarande "SALTIS närmar sig Olidebron,
beräknad ankomst om 1 minut", 116 m efter bron, fast den färska nordprogressen
var 1,97 m/s. Fältloggarna har 360-värdet 837 gånger (kommentaren vid app.js:5292).

### F08: fasberoendet vid Järnvägsbron

Bankfynd: `20260917-16h`, SINE BRES (304225000), δ −2,5 s och −7 s.
Omgranskningen fann också δ −5 s (basen tappar passagen vid alla tre).

Råfixarna:

| Fix | Tid | Läge |
| --- | --- | --- |
| A0 | 02:24:59 | 362 m norr om Järnvägsbron |
| A | 02:26:08 | passerar Stridsbergsbron, 94 m norr om Järnvägsbron |
| B | 02:26:30 | 26 m söder om Järnvägsbrons linje |
| C | 02:27:17 | 108 m söder om bron |

Passagen vid C kräver METHOD 1 med zonbeviset (`zoneCrossProven`), eftersom
segmentet B→C inte byter sida. Zonbeviset sätts av `_noteUnderBridgeLineCross`
för segmentet A0→B (388 m). Det är beviset för att båten korsade linjen när den
kom in i zonen.

**Första halvan av felet: beviset prövades i fel pass.**

- B:s eget pass: Phase 3-hållningen för Stridsbergsbron är aktiv (7,6 s kvar).
  `_isUnderBridge` returnerar i hållningsgrenen, före INTERMEDIATE_UNDER där
  beviset prövas.
- Basen: watchdogen 02:27:00 kör FIX U (tvingad väntan vid Järnvägsbron, ny
  notis) och returnerar före `_isUnderBridge`. Den kritiska UI-uppdateringen körs
  direkt efter, gör `HYSTERESIS_RESET` och `UNDER_BRIDGE_CROSS_PROOF (388m)`.
  Vid C: `traditional_close_passage`.
- Varianten: samma FIX U-pass, men UI-uppdateringen ligger kvar bakom en
  pågående skrivning. Vid C: `NO_PASSAGE 26→108 m`.

Fyra uppskjutningar vid broparet når inte INTERMEDIATE_UNDER i passet vid
inträdesfixen: Phase 3-hållningen, FIX U:s tvingade väntan, rensningspasset
(CurrentBridgeManager Regel 0; `docs/faltgranskning-2026-10-05.md`, NINA
B-rättelsen) och FIX O-spärren. Beviset hamnade då i ett senare pass vid samma
position, och om det hann före nästa fix berodde på fasen.

**Andra halvan av felet (granskningen): beviset raderades i nästa ordinarie
pass.** Granskaren lade en extra fix C' 45 m söder om linjen mellan B och C.
Loggen med den första prototypen (δ −2,5 s, C' 02:27:05):

1. B: `UNDER_BRIDGE_CROSS_PROOF (388m)` i hållningspasset.
2. 02:27:00: `FIX_U_FORCE_WAITING`.
3. C': `HYSTERESIS_RESET: Target bridge changed from Stridsbergsbron to
   Klaffbron` och `INTERMEDIATE_UNDER 45m` utan bevis.
4. C: `NO_PASSAGE 45→108 m`.

Varför: målbytet skedde redan i passagepasset vid A. Hållningen och FIX U
returnerar före `_checkHysteresisResetConditions`, så bytet syns först i det
första ordinarie passet, vid C'. Återställningen nollar beviset, och
INTERMEDIATE_UNDER startar ett nytt zonbesök som också nollar det. Sedan prövas
segmentet från den sparade positionen A0 till C'. Det är 362 + 45 = 407 m, alltså
längre än `UNDER_BRIDGE_CROSS_SEGMENT_MAX_M` (400 m). Inget nytt bevis sätts.

Granskarens prov på samma fältdata (se `K/R2/tmp/granskning/f08x` och `f08y`):

| Extra fix C' | 7699cbe | Första prototypen `e0e8124` | Revision 1 och 2 |
| --- | --- | --- | --- |
| 02:26:41,6 | tappad i alla 8 faser | tappad i alla 8 faser | bokförd i alla 8 |
| 02:27:05 | tappad vid δ −2,5, −5 och −7 s | samma | bokförd i alla 8 |

Faserna är δ 0, −2,5, −5, −7, −11,52, −15, −20 och −25 s.

**FIX O i banken.** FIX O spärrar under-bro vid den ena bron i paret tills
"inväntar" visats efter passagen av den andra. I `20260804-both-21h` (ANTJE
211347380 och JEANNELLE 265662320) och `20260909-80h` (265573130) slår FIX O
till i passet direkt efter FIX U. Orsaken: passagen och FIX U:s väntstämpel har
samma millisekund, och FIX O kräver att stämpeln är strikt senare. Om FIX O-passet
nollar beviset (målbyte) och nästa fix är utgångsfixen, tappas passagen. I de
tre bankfallen hade båtarna ännu inte korsat linjen (38–50 m före
Stridsbergsbron norrut), så inget bevis fanns att ta fram.

## 2. Rättningen på kodnivå

### F12/F16

- `GPSJumpGateService.releaseCandidate(vesselId, bridgeName)`: tar bort
  kandidaten för EN bro. Andra broars kandidater ligger kvar.
- `VesselDataService._releaseGateCandidateForBookedBridge(vessel, bridgeName)`
  anropas vid de fyra bokföringar som lägger bron i `passedBridges`:
  1. målbrotransitionen (`_handleTargetBridgeTransition`, vid
     TARGET_PASSAGE_RECORDED);
  2. målbropassagen i `_hasPassedTargetBridge`;
  3. den grindbekräftade eller glappinfererade mellanbron
     (`registerConfirmedIntermediatePassage`);
  4. den ordinarie mellanbropassagen (`_handleIntermediateBridgePassage`).
- Två vägar släpper medvetet inget. Under-bro-ankringen i StatusService bokför
  ingen passage (V2R2-2). Järnvägsbro-inferensen vid TARGET_END registrerar inte
  passagen, så en väntande Järnvägsbro-kandidat är då den enda väg som gör det.

### F13

- `app._freshNorthProgressMps(vessel)`: K1:s färskhetskontrakt (stashens `ts`
  måste vara det senaste meddelandets stämpel, ribba `NORTH_PROGRESS_MIN_MPS`),
  utbrutet ur `_getNotificationDirection`. K1:s beteende är oförändrat, och K1
  gäller fortfarande bara östbandet (testat).
- `_hasGapCrossedNotifiedBridge`, revision 2: kursgrenen är som i basen
  (nordbandet ger `north`, det breda sydbandet `south`). Efter den grenen, om
  varken ruttlåset eller kursen gav riktning, ger färsk nordprogress
  riktningen `north`. Det täcker båda fallen där kursen inte säger nord eller
  syd: östra dödbandet 46–134° (revision 1) och saknad kurs (nytt). Inget nytt
  tal och inget nytt band.
- Regeln ger aldrig `south`. Returvärdet kräver dessutom, som förut, att hoppet
  gick i färdriktningen (`vessel.lat > fromLat`), så ett hopp söderut kan aldrig
  få passerad form av regeln.

I praktiken gäller saknad kurs bara återfödda båtar: en båt med föregående
fixobjekt får den kursen framförd (VesselDataService.js:5287), så hennes kurs är
null bara om också den förra var det.

### F08

Del 1, beviset prövas i det uppskjutande passet (oförändrat från `e0e8124`):

- `StatusService._noteDeferredZoneEntryCross(vessel, bridgeName, distanceM,
  prevFix, jumpTick)` kör det befintliga `_noteUnderBridgeLineCross` med samma
  grindar som INTERMEDIATE_UNDER: högst `UNDER_BRIDGE_SET_DISTANCE` (50 m) från
  bron, inte en passerad bro, inte en S-3-spärrad bro och inte Stallbackabron.
- Den anropas i de uppskjutande passen: hållningsgrenen (närmaste bro om den
  inte är den hållna), FIX U-grenen (den tvingade väntbron), rensningspasset
  (`clearedPassedBridge` och inget under-bro-läge, närmaste bro) och FIX
  O-grenen (den spärrade bron).
- Föregående observation läses utan att förbrukas (`_readUnderBridgePrevFix`).

Del 2, beviset sparas till zonbesöket (revision 1):

- När `_noteDeferredZoneEntryCross` sätter ett nytt bevis sparas det i
  `vessel._underBridgeDeferredProof = { bridge, lat, lon, at }`. `lat/lon` är
  inträdesankaret, alltså startpunkten för segmentet som korsade linjen.
- `_restoreDeferredZoneEntryProof(vessel, bridgeName, consume)` sätter tillbaka
  beviset (`_underBridgeCrossedBridge` och inträdesankaret) om posten gäller
  samma bro. Den anropas på två ställen:
  1. när INTERMEDIATE_UNDER eller TARGET_UNDER startar ett nytt zonbesök
     (`consume = true`: posten förbrukas, även om den gäller en annan bro);
  2. i varje uppskjutande pass, om beviset saknas (`consume = false`: posten
     ligger kvar till zonbesöket).
- `_expireDeferredZoneEntryProof(vessel, positionAnalysis)` körs överst i varje
  `analyzeVesselStatus`, före FIX U. Posten släpps när:
  - passet bär GPS-hopp eller osäker position;
  - bron är bokförd (i `passedBridges`, eller som `lastPassedBridge` med en tid
    efter posten, för det fall en vändning redan lyft bron ur listan);
  - ett bevis för en annan bro har satts;
  - posten är äldre än `DEFERRED_ZONE_PROOF_MAX_AGE_MS` (2 min, samma gräns som
    epsilonkandidaten i `_noteUnderBridgeLineCross`);
  - båten är mer än `UNDER_BRIDGE_CLEAR_DISTANCE` (70 m) från bron, alltså har
    lämnat zonen.
- GPS-hoppsblocket överst i `analyzeVesselStatus` nollar också posten.
- `_underBridgeDeferredProof` ligger i VesselDataService fältlista, annars
  vore posten borta vid nästa meddelande.

Varför det är rätt: zonbesöket vid Järnvägsbron började fysiskt vid B, men appen
registrerar det först i det första ordinarie passet. Återställningen ger exakt
det tillstånd som zonbesöket hade fått om det registrerats vid B: beviset för
Järnvägsbron och inträdesankaret på närsidan. Beslutet vid utgången är
oförändrat. METHOD 1 kräver fortfarande att utgångsfixen ligger tydligt på andra
sidan inträdesankaret. En båt som vänder i zonen och lämnar den på samma sida
får därför ingen passage (testat).

Revision 2 ändrar ingenting i F08-koden. Luckan vid 50–60 m (§9) ligger i
METHOD 1 själv och finns redan i basen.

## 3. Övervägda alternativ

### F12/F16

- **Rensa alla kandidater vid målbyte** (B6:s ursprungliga förslag). Förkastat.
  218023240 i `20260601-41h` bekräftar Järnvägsbron i samma tick som
  Stridsbergsbrons glappinferens; en bred rensning hade tappat en äkta passage.
- **Vakt mot `passedBridges` vid bekräftelsen**, som i `applyInferredPassage`.
  Förkastat. Den skulle också blockera en äkta återkorsning efter en U-sväng när
  N1-resetten lämnar bron kvar i listan (R1:s F10). Rättningen hade då berott på
  R1.
- **Vakt mot `passedAt` vid bekräftelsen.** Förkastat. Under-bro-ankringen
  skriver `passedAt` utan att bokföra, och då hade en äkta grindpassage tappats
  (samma hål som V2R2-2).
- **Spärr i bekräftelseloopen när en tidigare post i samma loop bokför bron**
  (RC9 eller TARGET_END). Inte infört. Det kräver två samtidigt bekräftade
  kandidater där den senare registrerades först, och registreringsordningen gör
  det i praktiken omöjligt. Inget tick i banken har mer än en grindbekräftelse
  för samma båt. Se risker.

### F13

- **Bredda nordbandet för BN2.** Förkastat. Banden är medvetet olika
  (cogDirection.js, P5-beslutet: "HARMONISERA DEM INTE"), och ett nytt band är
  ett nytt beslut.
- **Låt riktningslåset ur svepfönstret (`SKIPPED_BRIDGES_DIRECTION_LOCK`) gå
  före notisen.** Förkastat. Låset är R1:s F15-problem (omprövas aldrig mot
  levande kurs), och en omordning hade kopplat ihop familjerna.
- **Hoppets egen riktning som färdriktning i alla kursband.** Förkastat. Det
  hade gått före en sydlig kurs och tagit bort BN2:s skydd för återresor.
- **Behåll undantaget för saknad kurs** (omgranskningens sätt b: skriv bara att
  en båt utan kurs fortfarande får "närmar sig"). Förkastat. Felet syns för
  användaren på samma sätt som F13, och det är samma tvivel som dirigenten
  redan besvarat: kursen säger inte om båten åker norrut eller söderut. En
  saknad kurs är det tydligaste sådana fallet. Beviset är detsamma (K1:s
  färska nordprogress över samma hopp), och banken har 0 prövningar där regeln
  slår till, så inget låst facit flyttas. Kostnaden är en rad flyttad ur
  kursgrenen.
- **Hoppets egen riktning när kursen saknas** (ge `south` för ett hopp söderut).
  Förkastat. K1 ger aldrig `south` ("REGELN GISSAR ALDRIG 'southbound'",
  app.js:10779), och en sydregel vore ett nytt beslut utan fältfall. Ett hopp
  söderut utan kurs behåller därför förvarningsformen (känd gräns, §9).

  Rättvist sagt (granskningen): regeln betyder i praktiken "hoppet gick
  norrut". Nordprogressen mäts över samma hopp som BN2 prövar, från föregående
  fix eller från återfödelsens bas. Ett långt hopp (minst 0,005°, 556 m) ger i
  praktiken alltid minst 0,31 m/s, alltså över ribban 0,25 m/s, eftersom en båt
  som är tyst längre än 30 min (`STALE_AIS_TIMEOUT_MS`) tas bort och föds igen.
  Vid återfödelse krävs dessutom att basen är högst 15 min gammal. BN2:s krav
  "hoppet ska gå i färdriktningen" uppfylls därmed automatiskt. Skillnaden mot
  det förkastade alternativet "hoppets riktning i alla kursband" är var regeln
  gäller: bara där kursen inte säger något. En sydlig kurs går fortfarande före.

  Kantfall: en båt som har korsat bron norrut under tystnaden och redan vänt,
  men har kurs 46–134° eller ingen kurs, får "passerade" i stället för "närmar
  sig", fast hon snart passerar bron igen. Påståendet är sant för korsningen
  under tystnaden. Returen ska få en egen notis enligt U14 (familj N). Ingen
  sådan båt finns i banken.

### F08, del 1

- **Ett nytt pass direkt efter rensningen** (välja nästa bro i samma pass).
  Förkastat. Det strider mot det dokumenterade valet i CurrentBridgeManager
  ("ett direkt val av nästa bro gör att vanlig närhetsnotis kan förekomma
  passage-fallbacken efter ett AIS-glapp").
- **Pröva beviset i varje pass överst i `_isUnderBridge`.** Förkastat. Då prövas
  samma segment två gånger i samma pass, och epsilonkandidatens längd räknas
  dubbelt.
- **Pröva det fördröjda segmentet först vid utgångsfixen (i VDS).** Förkastat.
  Det kräver att VDS läser StatusServices interna föregångare. Det är en ny
  koppling mellan lagren.

### F08, del 2 (granskningen)

- **Spara beviset och återställa det när zonbesöket startar.** Valt. Det är
  granskarens förslag, och det rör bara båtar som fått ett bevis i ett
  uppskjutande pass. Övriga regler för zonbesök och återställning är oförändrade.
- **Låt HYSTERESIS_RESET behålla ett bevis för en annan bro än den som byttes.**
  Förkastat. Det ändrar återställningen för alla broar och alla båtar, och
  INTERMEDIATE_UNDER:s eget nya zonbesök hade ändå nollat beviset.
- **Uppdatera hysteresens spårning redan i hållningen och FIX U**, så att
  målbytet förbrukas där. Förkastat. Då återställs hållningens eget lås i
  hållningspasset, vilket ändrar Phase 3-beteendet. NINA B-fallet (inget målbyte)
  hade ändå tappat beviset i nästa zonbesök.
- **Registrera zonbesöket vid nästa bro redan i det uppskjutande passet** (sätta
  låset). Förkastat. Hållningen, FIX U och FIX O finns för att visa "passerad"
  eller "inväntar" före "under bron". Ett lås skulle ändra status och brotext.
- **Höj `UNDER_BRIDGE_CROSS_SEGMENT_MAX_M`.** Förkastat. Konstanten är
  dokumenterad, och en högre gräns flyttar bara problemet till nästa fix.
- **Återställ beviset i slutet av varje pass.** Förkastat. `analyzeVesselStatus`
  har flera returer, och beviset skulle återkomma även efter zonbesök som
  avslutats av goda skäl. Fasta återställningsställen är lättare att granska.
- **Ingen tidsgräns för posten.** Förkastat. Posten ligger utanför ett låst
  zonbesök. Två minuter räcker med god marginal: i banken återställs den efter
  25 ms–60 s. Priset: om en båt ligger 50–70 m från bron i mer än två minuter
  innan zonbesöket startar, blir utfallet som i basen.

### F08, luckan vid 50–60 m (omgranskningen)

- **Rätta METHOD 1 i R2** (till exempel låta en fix 50–60 m räknas som "nära"
  när zonbeviset finns). Inte gjort, enligt omgranskningens råd. Luckan finns i
  basen, beror inte på fasen och ligger i `detectBridgePassage`, som alla
  broar och alla passagemetoder delar. En ändring där behöver ett eget kort,
  egen bankmätning och egen granskning.

## 4. Klustrens världar

Varje värld är återskapad med triagens generator (`K/R2/tmp/scripts/gen.js`,
`mkcard.js`) och körd med `hunt.js --repro` mot `7699cbe` och mot prototypen.

| Kort | Värld | 7699cbe | Revision 2 | Mekanism |
| --- | --- | --- | --- | --- |
| F12 | 254 (JOLLY) | KVAR | BORTA | grindens dubbelbokföring |
| F12 | 1227 (ELSA MARIA) | KVAR | KVAR | målbron tilldelad först vid linjen (beslut 2, §6) |
| F12 | 1731 (KAJSA) | KVAR | KVAR | målbron tilldelad först efter linjen (beslut 2, §6) |
| F16 | 254 (JOLLY) | KVAR | BORTA | grindens dubbelbokföring |
| F13 | 86 (SALTIS) | KVAR | BORTA | dödbandet |
| F13 | 783 (okänd båt) | KVAR | BORTA | dödbandet |
| F13 | 86 med kursen 360 eller null (granskarens repro) | "närmar sig" | "passerade" | saknad kurs (nytt i revision 2) |
| F13 | 1731 (KAJSA) | KVAR | KVAR | R1:s F10 (U-sväng); R1:s rättning tar det |
| F08 | 16h, δ −2,5, −5 och −7 s | KVAR | BORTA | uppskjutet inträdesbevis |

**Värld 1227 och 1731 (F12/r2 och klustrets tredje värld).** Stridsbergsbron
bokförs EN gång, som mellanbro, eftersom appen gav båten Klaffbron som mål först
när hon redan var vid eller förbi Stridsbergsbron. Rättat mot revision 1:s text
(omgranskningen):

- **1227, ELSA MARIA:** appen ser henne först vid brolinjen. Första raden
  kommer 02:32:45,822 (fixen 02:32:39), och L0-korsningen var 02:32:40,8.
  AISHubs latitud 58,29352 ligger 0,4 m söder om brons latitud 58,293524, och
  målbrotilldelningen jämför latitud (VesselDataService.js:4723–4745: "norr om
  Stridsbergsbron" är `vessel.lat > bro.lat`, annars "mellan broarna →
  Klaffbron"). Hon får alltså Klaffbron som mål på första fixen, och
  Stridsbergsbron blev aldrig hennes mål.
- **1731, KAJSA:** hon hade Stridsbergsbron som mål före ett långt avbrott
  (tilldelad 09:35:11, notis "närmar sig Stridsbergsbron" 09:53:26). Hon låg
  sedan stilla 94 m norr om bron och var tyst i 44 min (09:59:30–10:43:36).
  Appen tog bort henne efter 30 min (`STALE_AIS`), och den raderingen
  gravlägger inte (VesselDataService.js:1248), så den återfödda båten började
  utan rörelsebevis, mål och passagehistorik (IDUN: "en längre AIS-lucka
  raderar rätteligen den aktiva resan", :5599). Hon låg still (0 kn) och fick
  inget mål ("no movement proof", :4263–4271). Nästa fix, 10:46:45, låg 28 m
  söder om linjen och gav Klaffbron ("Söderut, mellan broarna → Klaffbron").
  Passagen registrerades 10:50:16 som mellanbro.

INV-13 fäller båda, eftersom oraklet larmar varje gång en målbro registreras som
mellanbro med ett mål satt (`invariants.js:568–592`). Appbeteendet är beslutat
som rätt (beslut 2, §6). Registerposten står i §12.

**F13:s värld 1731** är R1:s klass (den nordgående återkorsningen 11:04:57
bokförs aldrig). R1:s rättning tar det (R1:s DESIGN §11: T1 FÖRVARNINGSFORM i
1731 försvinner).

**Uppskjutna bevis i banken** (instrumenterad kopia, 48 körningar,
`K/R2/matningar/8318c1a/uppskjutna-bevis-banken.txt`): ett bevis sparas 3 gånger
per läge, för OSPREY (`20260601-41h`), SINE BRES (`20260917-16h`) och NINA B
(`20260918-7h`). Alla tre återställs när zonbesöket startar, 25 ms till 60 s
senare, och ger samma tillstånd som basen fick i sitt senare pass. FIX O-grenens
anrop körs 3 gånger per läge och sätter aldrig något bevis (båtarna hade inte
korsat linjen). Ingen post släpps av utgångsreglerna i banken.

**BN2 i banken** (instrumenterad kopia av revision 2, 48 körningar,
`K/R2/matningar/bn2-banken.txt`): BN2:s rumsliga bevis håller 26 gånger (13 per
läge, samma 13 notiser som låstes 2026-11-03). Alla 26 hade färdriktning före
regeln: 22 ur ruttlåset (4 av dem med dödbandskurs) och 4 ur nordbandet.
Regeln slår till 0 gånger, varken i dödbandet eller utan kurs.

## 5. Samspel med andra familjer

| Familj | Delade funktioner och tillstånd | Samspel |
| --- | --- | --- |
| R1 | VDS `_handleIntermediateBridgePassage`, `_handleTargetBridgeTransition`, `_confirmDirectionReversal` | Textnära: mina anrop ligger vid `passedBridges.push`, R1 ändrar N1-resetten och återkorsningen. Semantiskt oberoende: släpps en grindkandidat för den utgående korsningen vid en bokförd returkorsning, hade sidokontraktet ändå motbevisat den. BN2 läser `_routeDirection` först; R1:s F15 kan ändra när låset sätts, men nordprogressregeln gäller bara när låset saknas. Det sparade F08-beviset släpps när bron bokförs, även om en vändning lyfter bron ur `passedBridges` i samma uppdatering (via `lastPassedBridge`). R1:s designer föreslår också en registerpost för 1227/1731; dirigenten lägger in EN (§12). |
| N | app.js notisflödet (`_triggerBoatNearFlowForBridge`) | Jag rör bara `_hasGapCrossedNotifiedBridge` och `_getNotificationDirection` (utbrytning). En återresa har sydlig kurs och behåller förvarningen. Kantfallet i §3 (vänd båt med kurs 46–134° eller ingen kurs) är N:s returnotis. |
| K, K2 | BridgeOpeningService via passagekrokar | En grindbekräftad dubbelbokföring kunde mata öppningsmotorn med en falsk passage. Den försvinner. Öppningsfacit i banken är oförändrat. |
| E | Tillståndet `_underBridgeLatched`, `_underBridgeCrossedBridge` och inträdesankaret, som `ProgressiveETACalculator._hasPassedWaitingBridge` (AMELIA-släppet, rad 769–784) läser | Inga delade funktioner, men delat tillstånd. AMELIA-släppet kräver låst under-bro-läge, bevis för väntbron och att både ankaret och väntpositionen ligger tydligt på andra sidan. Med prototypen kan beviset finnas ett pass tidigare än i basen, till exempel i FIX U-passet medan hållningens lås ligger kvar, och efter en återställning i samma pass som zonbesöket startar. Beviset beskriver en verklig korsning, så ett tidigare släpp är rätt i sak. Ingen skillnad i banken (48 körningar). E:s designer och dirigenten bör pröva det vid integrationen. Revision 2 rör inte det här. |
| M | Inga | — |

## 6. Användarbesluten och dirigentens beslut

- **U13 (facit).** Inget låst facit flyttas: 24 korpusar, normal och
  monitoring, är identiska i notiser, öppningar, mål- och mellanpassager,
  brotexter och resetter. Se FACIT.md.
- **U14 (notis per passage).** Berörs inte. F12-rättningen tar bort en falsk
  andra bokföring av samma passage; JOLLY:s notiser är oförändrade.
- **U15 (returresans öppningsvarning).** Berörs inte.
- **U16 ('strax'-studsen).** Berörs inte.
- **U17–U21.** Gäller andra familjer. U18 och U19 rör R1:s Fix D och ZELDA; R2
  har inget kort och ingen funktion där (registerposterna för dem föreslås av
  R1).

Dokumenterade beslut som följs: cogDirection-banden (P5, inga nya band),
K1:s färskhetskontrakt och ribba, CurrentBridgeManagers rensningspass (Regel 0
väljer inte nästa bro), studsvakten 3 min och V2R2-2 (ankringen bokför inte),
segmentbevisets grindar, `UNDER_BRIDGE_SET_DISTANCE`,
`UNDER_BRIDGE_CLEAR_DISTANCE` och `UNDER_BRIDGE_CROSS_SEGMENT_MAX_M`.

### Beslut 1 (fråga 1): K1:s mätning får avgöra passerad form i BN2

**Dirigentens beslut 2026-11-04: JA.** "K1-mätningen av nordprogress (beslut A3)
får avgöra passerad form i BN2 när en återfödd båts kurs ligger mellan banden.
K1 själv ändras inte."

Vad beslutet betyder i appen:

- När en båt dyker upp igen efter AIS-tystnad och redan är förbi en bro, säger
  notisen "passerade bron under AIS-tystnad" i stället för "närmar sig bron".
  Det gäller när kursen inte säger om båten åker norrut eller söderut, och
  K1:s mätning visar att hon har rört sig norrut över samma hopp.
- K1 själv är orörd. Kanalinfartsregeln gäller fortfarande bara östbandet
  46–134°, och testet `K1:s Kanalinfartsregel läser samma färskhetskontrakt`
  vaktar att en båt utan kurs fortfarande får `unknown` där.

Hur jag har tillämpat beslutet på omgranskningens fall (saknad kurs):

- Frågan och beslutet gällde kursen 46–134° ("mellan banden"). Frågan
  förklarade det med "alltså när kursen inte säger om båten åker norrut eller
  söderut", och omgranskningen visade att en läsare då tror att saknad kurs
  ingår. Skälet för beslutet gäller lika för saknad kurs, och beviset är
  detsamma. Därför gäller regeln nu båda fallen (§2, §3). Det är en utvidgning
  av beslutets ordalydelse, inte av dess skäl.
- Dirigenten bekräftar vid integrationen att JA:t täcker saknad kurs. Om inte:
  flytta raden `if (!travel && this._freshNorthProgressMps(vessel) !== null)
  travel = 'north';` tillbaka in i kursgrenen (mutant a i §8, revision 1:s
  beteende). Testet `utan kurs (AIS 360 → null)` och SALTIS-testet med kursen
  360 vänds då till KÄND LUCKA, och fallet blir en känd gräns.
- Regeln gäller båda glappfallen i BN2: föregående fix med långt hopp och
  återfödelse. Utan kurs gäller den i praktiken bara återfödda båtar (§2).

### Beslut 2 (fråga 2): målbro tilldelad först vid eller efter bron

**Dirigentens beslut 2026-11-04: JA.** "Fallet där en båt får sitt mål först vid
eller just efter bron (värld 1227 och 1731) är korrekt appbeteende. Motorn
registrerar det som DESIGN."

Vad beslutet betyder:

- Appen ändras inte. Buggjägaren får en DESIGN-post för INV-13 (§12), så att
  larmet tystnar för just det här fallet.
- Fallet i enkla ord. Appen följer varje båt mot en målbro (Klaffbron eller
  Stridsbergsbron). I värld 1227 syns båten i AIS först vid brolinjen. I värld
  1731 har appen tagit bort båten efter en halvtimmes tystnad, och när hon kommer
  tillbaka ligger hon still, så att nästa position redan är på andra sidan bron.
  I båda fallen får båten sin målbro först när hon är vid eller förbi
  Stridsbergsbron. Appen skriver då in passagen som en bro på vägen. Mer än så
  kunde appen inte göra.
- Risken med posten: ett för brett undantag kan dölja det INV-13 finns för, att
  en båt tappar sin målbro mitt i en passage. Predikatet i §12 är därför smalt.
  Det kräver att appen inte kan ha gett båten bron som mål före linjen: antingen
  är bron redan passerad på båtens första rad, eller så har båten inget
  rörelsebevis före linjen. Det räknar båtens livstid från ett glapp på minst
  30 min, samma gräns som appens radering.
- En sak dirigenten bör känna till: i 1731 hade KAJSA Stridsbergsbron som mål
  före tystnaden och fick notisen "närmar sig Stridsbergsbron" 09:53:26. Posten
  omfattar alltså också en båt som tappar sitt mål genom att appen tar bort
  henne efter 30 min tystnad. Det är appens dokumenterade beteende (IDUN,
  VesselDataService.js:5599; ingen grav efter STALE_AIS, :1237–1248), och det är
  just det dirigenten har godtagit för 1731.

## 7. Dokument

Uppdaterade i prototypen:

- `docs/ARCHITECTURE.md`:
  - GPS-grinden: kandidaten släpps vid bokföring.
  - Segmentbeviset: uppskjutna pass, FIX O, det sparade beviset och, nytt i
    revision 2, den kända luckan vid 50–60 m.
  - BN2: regeln gäller dödbandet och saknad kurs (nytt i revision 2), mätt över
    samma hopp, ger aldrig `south`, och kantfallet.
- `docs/VALIDATION.md`: fassvepets blinda fläck mot halvminutsrutnätet, var F08
  är låst (även δ −5 s och en extra fix i zonen) och var luckan vid 50–60 m visas.

Bör uppdateras av dirigenten vid integrationen:

- Kampanjens sammanställning: de tre rättningarna och att inget facit flyttats.
- Beslutsregistret i buggjägaren och `docs/BUGGJAKT.md` §7: posterna i §12, med
  dirigentens beslut 2 som källa.
- Ett eget kort eller en backloggpost för luckan vid 50–60 m (§9, §12).
- `docs/reliability-review-2026-06-09.md` B6 kan få en hänvisning om att
  kandidathalvan nu är införd (historiskt dokument, valfritt).

## 8. Regressionstester

| Fil | Låser | 7699cbe | `e0e8124` | `8318c1a` | `c02d88e` |
| --- | --- | --- | --- | --- | --- |
| `tests/gps-grind-kandidat-bokford-bro.test.js` | `releaseCandidate` släpper bara den bokförda bron; varje släppställe i VDS; JOLLY genom hela appen bokför Stridsbergsbron en gång | 5 av 5 röda | 5 gröna | 5 gröna | 5 gröna |
| `tests/bn2-dodband-nordprogress.test.js` | dödbandsregeln och dess gränser; regeln utan kurs (nytt); K1 läser samma kontrakt och gäller bara östbandet (utökat); SALTIS genom hela appen, med kursen 49,9° och 360 (nytt) | 4 av 5 röda (K1-vakten ska vara grön) | 2 av 5 röda (de två nya fallen utan kurs) | 2 av 5 röda (de två nya fallen utan kurs) | 5 gröna |
| `tests/zonintrade-uppskjutet-bevis.test.js` | beviset i de uppskjutande passen; negativa fall; beviset överlever nästa zonbesök; SINE BRES genom hela appen vid δ 0, −2,5, −5 (nytt) och −7 s och med en extra fix i 8 varianter; KÄND LUCKA 50–60 m med kanterna 49 och 60 m (nytt) | 20 av 26 röda | 14 av 26 röda | 26 gröna | 26 gröna |

Summa: 36 tester, 4 fler än i revision 1 (två för saknad kurs, δ −5 s och
KÄND LUCKA). Mot `7699cbe` är 29 röda. De 7 gröna är de fyra negativa fallen,
δ 0, K1-vakten och fallet med ett UI-pass vid B (där räddar basens senare pass
beviset). KÄND LUCKA-testet är rött mot `7699cbe` eftersom kanterna (49 och
60 m) tappas där; mittenfallet (58,8 m) tappas i alla versioner. Mot `e0e8124`
är 16 röda, mot `8318c1a` 2 (de två nya fallen utan kurs) och mot `c02d88e` 0.
Matrisen ligger i `K/R2/test-matris.txt`, körningarna i
`K/R2/test-mot-7699cbe.txt`, `test-mot-e0e8124.txt`, `test-mot-8318c1a.txt` och
`test-mot-prototyp.txt`.

Mutationsprov:

- F12/F16 (`K/R2/matningar/8318c1a/mut-f12.txt`): tar man bort ett av de fyra
  släppanropen blir exakt det ställets test rött.
- F08 (`K/R2/matningar/8318c1a/mut-f08.txt`): 13 mutanter, alla fångade.
- F13, nytt i revision 2 (`K/R2/matningar/mut-f13.txt`): 4 mutanter, alla fångade:
  (a) regeln tillbaka i kursgrenen, alltså revision 1:s beteende: 2 röda (båda
  fallen utan kurs);
  (b) regeln borttagen, alltså basens BN2: 4 röda;
  (c) `north` utan nordprogress: 2 röda (färskheten och ribban, i dödbandet och
  utan kurs);
  (d) hoppets riktning utan nordprogress: 2 röda (samma, och hoppet söderut
  utan kurs).

Inget nytt scenario i `runSyntheticScenarios`. F08 beror på när UI-passet
hamnar mot nästa fix, och det styr de syntetiska scenarierna inte. Testet
flyttar i stället den riktiga korpusen på samma sätt som buggjägarens M-FAS.

## 9. Risker, kända luckor och öppna punkter

- **Känd lucka, F08 vid 50–60 m (omgranskningen, ingen kodändring i R2).**
  METHOD 1 i `detectBridgePassage` (geometry.js:586–588) kräver ett steg från en
  fix högst 50 m från bron till en fix mer än 60 m bort. Har korsningen skett i
  inträdessteget (fixen B ligger redan 26 m bortom linjen) och ligger nästa fix
  50–60 m från bron, når inget steg det kravet, och inget steg korsar linjen.
  Passagen tappas, och notisen säger "närmar sig Järnvägsbron, beräknad ankomst
  strax" vid den extra fixen. Egna prov på 16h (extra fix 02:26:41,6 längs B→C,
  δ 0; `K/R2/tmp/rev2/band-*.jsonl`):

  | Extra fix, avstånd från bron | 7699cbe | Revision 2 |
  | --- | --- | --- |
  | 49,1 m | tappad | bokförd 02:27:17,778 (vid C) |
  | 50,7 m, 54,8 m, 58,8 m | tappad | tappad (luckan) |
  | 60,4 m, 62,9 m | tappad | bokförd 02:26:41,600 (vid den extra fixen), och notisen där blir "har precis passerat Järnvägsbron" i stället för "närmar sig …, beräknad ankomst strax" |

  Granskarens variant v4 (58,8 m) tappas i alla 8 faser i `7699cbe`,
  `8318c1a` och `c02d88e`. Luckan beror alltså inte på fasen och fanns före
  R2. KÄND LUCKA-testet i `tests/zonintrade-uppskjutet-bevis.test.js` visar
  dagens beteende; den som rättar luckan vänder mittenfallet. Reprot:
  `K/R2/tmp/omgr1/scripts/f08var.js` med variant v4 (spec
  `[{"t":"2026-09-18T02:26:41.600Z","frac":0.40}]`), eller testet. Förslag
  till kort och registerpost i §12. Ingen bankkorpus har fallet.
- **F13-regeln ger aldrig `south` (känd gräns).** Ett hopp söderut över en bro
  med kurs i dödbandet eller utan kurs behåller förvarningsformen. Banken har
  inget sådant fall, och sanningsspårets radio ger inte null-kurs i fart
  (BUGGJAKT §7, rad 16). En sydregel vore ett nytt beslut (§3).
- **F13-utvidgningen till saknad kurs** vilar på min läsning av beslut 1 (§6).
  Dirigenten bekräftar den vid integrationen.
- Bekräftelseloopen i app.js STEG 5 kan i teorin bokföra en bro två gånger i
  samma tick (se §3). Inte infört, eftersom fallet inte uppstår med dagens
  registreringsordning.
- Det sparade beviset har en tidsgräns på två minuter. En båt som ligger 50–70 m
  från bron längre än så innan zonbesöket startar får basens utfall.
- Det sparade beviset skrivs inte till disk. Startar appen om mellan inträdet
  och zonbesöket, blir utfallet som i basen.
- F12:s värld 1227 och 1731 står kvar i motorn tills registerposten i §12 är
  inlagd. Kortet F12 själv blir BORTA, eftersom dess minsta repro är värld 254.
- Det breda motorkortet `tests/replay-validation/bugHunt/__tests__/b-register.test.js`
  är rött i både `7699cbe` och prototypen: motorkopian saknar
  `docs/BUGGJAKT.md`. Det beror på kopian, inte på rättningen.
- Utanför R2:s kort (granskarens iakttagelse): i den låsta korpusen 16h säger
  notisen 02:27:00 "SINE BRES närmar sig Järnvägsbron, beräknad ankomst strax",
  cirka 35 s efter den verkliga korsningen. Den kommer från FIX U och finns
  redan i `7699cbe`. I prototypen finns beviset för korsningen redan i det
  passet, så en framtida rättning kan använda det. Den ändrar en låst notis och
  behöver ett eget beslut.

## 10. Mätningar i worktree (revision 2, `c02d88e`)

Loggarna ligger i `K/R2/matningar/`. Revision 1:s loggar ligger i
`K/R2/matningar/8318c1a/`, den första prototypens i `K/R2/matningar/e0e8124/` och
baslinjens i `K/R2/matningar/bas-7699cbe/`.

| Steg | Resultat |
| --- | --- |
| `npm test` | 357 sviter, 4 811 godkända, 2 överhoppade, 1 röd (4 814 tester, 4 fler än i revision 1). Den röda är motorkopians `bugHunt/__tests__/b-register.test.js` ("STRESS-TÄTHET: källfilen docs/BUGGJAKT.md finns inte"), som är lika röd i `7699cbe` med samma motorkopia. |
| `npm run lint` | utan anmärkningar |
| `npm run replay:all` | alla låsta korpusar gröna, normalt och med `REPLAY_MONITORING=1`; loggarna ordagrant lika med revision 1 |
| `npm run replay:synthetic` | 46 scenarier rena; utdata ordagrant lika med `7699cbe` |
| `npm run replay:openings` | standardgrindarna godkända, O1 376/378, O1b 391/447; utdata ordagrant lika med `7699cbe` |
| `npm run replay:monitoring` | 72 h-soaken stabil: 216 notiser, 761 textövergångar, 72 målpassager, 0 processfel, 0 kvarvarande timrar; lika med `7699cbe` utom heapUsedMB |
| `npm run replay:phase` | 24 korpusar, 168 replayer, grönt; lika med revision 1 utom körtiderna |
| `REPLAY_MONITORING=1 npm run replay:phase` | 24 korpusar, 168 replayer, grönt; lika med revision 1 utom körtiderna |
| Banken rad för rad (`snap.js`/`diffsnap.py`) | 0 korpusar med skillnad, 48 körningar (`bank-snapshot-diff.txt`) |
| BN2 i banken (instrumenterad kopia) | 26 prövningar med rumsligt bevis, alla med riktning före regeln; regeln slår till 0 gånger (`bn2-banken.txt`) |
| Revision 2 mot revision 1, världarna | bara SALTIS med kursen 360 och null skiljer, i Olidebron-notisen; 86, 783, 254, 1227 och 1731 identiska (`K/R2/tmp/rev2/cmp/r1-mot-rev2.txt`) |
| Egna prov med en extra fix 49–63 m (16h, δ 0) | se §9 och FACIT.md (`K/R2/tmp/rev2/band-base.jsonl`, `band-wt.jsonl`) |
| Regressionstesterna | 36 av 36 gröna; 29 röda mot `7699cbe`, 16 mot `e0e8124`, 2 mot `8318c1a` (`K/R2/test-matris.txt`) |
| Mutationsprov F13 | 4 av 4 fångade (`mut-f13.txt`) |
| `patch.diff` | 12 filer; går att applicera på `7699cbe` med `git apply`, och alla 12 filer blir byte-lika med `c02d88e` |

## 11. Motorkontroll

`hunt.js --repro` för varje kort i `r1-standard-a`, mot `7699cbe` och mot
revision 2 (`K/R2/motor-repro-7699cbe.txt`, `K/R2/motor-repro-prototyp.txt`):

- F08, F12, F13 och F16 går från KVAR till BORTA.
- Alla andra kort står kvar som KVAR med samma antal utslag: B01, B02,
  F01–F07, F09–F11, F14, F15 och F17–F23, och representanterna r2 (F12/r2 är
  värld 1227, som registerposten i §12.1 tar, och F13/r2 är värld 1731, som
  R1:s rättning tar).
- Utfallet är ordagrant lika med `e0e8124` och revision 1.

`hunt.js --profile=quick --out=K/R2/hunt-quick` jämfört med `r1-quick-a`
(`K/R2/matningar/hunt-quick-jamforelse.txt`):

- Självtestet är grönt.
- 69 → 66 råa utslag och 15 → 12 kandidatkluster. De tre som försvinner är
  INV-13 och T10 FANTOMPASSAGE för värld 254 och T1 FÖRVARNINGSFORM för värld 86.
- Inga nya kluster, och alla övriga kluster har samma världar. Klustren är
  identiska med revision 1 (`K/R2/tmp/rev2/hunt-quick-8318c1a`). Utvidgningen
  till saknad kurs ändrar alltså inget i quick: sanningsspårets radio ger inte
  null-kurs i fart.

Motorns bankspår (`hunt.js --lanes=bank --jobs=3`, 7 δ,
`K/R2/matningar/bankspar-m-fas.txt`):

- `7699cbe` 158 av 168 rena, revision 1 och revision 2 160 av 168.
- Det enda kluster som försvinner är F08:s (PASSAGENYCKEL TAPPAD, SINE BRES vid
  Järnvägsbron i `20260917-16h`). De tre kvarvarande klustren är desamma som i
  `7699cbe` och revision 1.

## 12. Registerposter för dirigenten

Två poster för R2, i den form `beslutsregister.json` har (BUGGJAKT §7). Båda
predikaten är nya och behöver en funktion i `lib/registry.js`. Prototyperna
ligger i `K/R2/tmp/rev2/pred/` och läser bara rader, appens konstanter och
motorns `platser.js`, som registrets regler kräver.

### 12.1 `R2-MÅLBRO-EFTER-LINJEN` (beslut 2)

- **Klass:** DESIGN.
- **Källa:** dirigentens beslut 2026-11-04 om R2:s fråga 2 (skrivs först in i
  `docs/BUGGJAKT.md` §7, som U16); `lib/services/VesselDataService.js:4263–4271`
  (inget mål utan rörelsebevis), `:4495`, `:4695–4705` och `:4723–4745`
  (`_calculateTargetBridge`: målbron väljs på latitud mot brons latitud),
  `:84` (`STALE_AIS_TIMEOUT_MS`), `:1237–1248` (STALE_AIS-raderingen
  gravlägger inte) och `:5599` (IDUN); `lib/constants.js:356–357`
  (`MOVEMENT_PROOF_SOG_KN`, `MOVEMENT_PROOF_NET_M`);
  `tests/replay-validation/invariants.js:568–592` (INV-13).
- **Gäller:** orakel `INV-F`, inv `INV-13`, klassRegex
  `^INV-13 MÅLBRO SOM MELLANBRO$`.
- **Predikat:** `målbroEfterLinjen`, parametrar `rörelseSogKn` (0,5, ur
  `MOORING_DETECTION.MOVEMENT_PROOF_SOG_KN`), `rörelseNettoM` (50, ur
  `MOVEMENT_PROOF_NET_M`), `livGlappMin` (30, `STALE_AIS_TIMEOUT_MS`; uttrycket
  `30 * 60 * 1000` kan inte läsas av `appKonstant`, så värdet står som parameter
  med hänvisning) och `maxEfterMin` (10).
- **Regel:** utslaget gäller båt V, bro X och registreringstiden t. V:s livstid
  är raderna sedan det senaste glappet på minst 30 min, annars sedan första
  raden. F är första raden i den sista följden av rader bortom X, mätt på
  latitud mot X:s latitud i passagens riktning, som appens målbrotilldelning.
  Posten gäller när t − F ≤ 10 min och något av följande håller:
  (a) F är livets första rad (båten syns först vid eller bortom linjen); eller
  (b) alla rader i livet före F har finit fart under 0,5 kn, ligger inom 50 m
  från livets första rad och har ingen kurs mot X (`isSouthCogStrict` för en
  passage söderut, `isNorthCog` norrut, banden i `_determineDirection`).
  Gäller aldrig relation BAS.
- **Prövat** (`malbroEfterLinjen.js`, utdata `malbroEfterLinjen-prov.txt`):
  1227 sant ("livets första rad 02:32:45.822 ligger redan bortom bron"), 1731
  sant ("stilla före bron … återfödd efter glapp; första fixen bortom bron
  10:46:45.992, registrerad 10:50:16.035"), 254 falskt (rörelse före linjen,
  registrerad 13 min efter). Tre avsmalnande sonder ger falskt: 1731 med ett
  glapp på 28,5 min (rörelsen 09:29 räknas), 1731 med kursen 200° på den
  stilla raden och 1227 med första raden norr om bron.
- **Följd i motorn:** standardkörningen har exakt tre INV-13-utslag (254, 1227
  och 1731, i både r1-standard-a och R3-standard). Efter R2 och posten finns
  inga kvar, och F12-klustret försvinner.
- **Varför (b) kräver kurs bort från bron:** en båt som tas bort av
  närhetstimern före 30 min kan gravläggas och ärva rörelsebeviset inom 15 min
  (`VESSEL_GRAVE`), och med rörelsebevis kan hon få bron som mål nära den även
  i 0 kn. Kursvillkoret gör att predikatet inte kan omfatta det fallet.
- **Jämfört med R1:s förslag** (`K/R1/DESIGN.md` §14.5,
  `målbroTilldeladVidLinjen`): båda ger sant för 1227 och 1731 och falskt för
  254, men R1:s är bredare på två punkter, och vardera punkten kan tysta ett
  äkta INV-13.
  (1) R1 räknar en båt som återfödd efter ett glapp på 15 min
  (`VESSEL_GRAVE.TTL_MS`). Appen tar bort en båt med mål först efter 30 min
  (`TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN`, constants.js:231, och STALE_AIS), och
  gravens 15 min räknas från raderingen, inte från den sista raden. En båt med
  bron som mål som är tyst 15–30 min har alltså kvar sitt mål. (2) R1 godtar en
  första rad inom 100 m från bron även i fart. På närsidan ger appen då båten
  bron som mål (VesselDataService.js:4723–4731), så ett INV-13 där vore ett
  äkta tappat mål. Mitt predikat kräver i stället att första raden redan ligger
  bortom bron på latitud, eller att båten saknar rörelsebevis före linjen.
  Dirigenten lägger in EN post; jag föreslår den här.

### 12.2 `R2-METOD1-BANDET-50-60M` (känd lucka, F08)

- **Klass:** KÄND_ÖPPEN.
- **Källa:** `docs/ARCHITECTURE.md` (F08, "Känd lucka", tillagd i `c02d88e`);
  `lib/utils/geometry.js:586–588` (METHOD 1: `previousDistance <= 50`,
  `currentDistance > 60`); `tests/zonintrade-uppskjutet-bevis.test.js`
  (KÄND LUCKA-testet).
- **Gäller:** orakel `T10`, klassRegex `^PASSAGE-EJ-REGISTRERAD$`.
- **Predikat:** `metod1Bandlucka`, parametrar `närM` (50) och `fjärrM` (60),
  literaler i geometry.js.
- **Regel:** båtens rader efter korsningen, till och med första raden mer än 60 m
  från bron (utgången), ligger alla på bortre sidan. Första raden efter
  korsningen ligger högst 50 m från bron (korsningen skedde i inträdessteget),
  och raden närmast före utgången ligger 50–60 m från bron. Då går inget steg
  från högst 50 m till mer än 60 m, och inget steg korsar linjen.
- **Prövat** (`metod1Bandlucka.js`): sant för 16h-varianterna med en extra fix på
  50,7, 54,8 och 58,8 m (de som appen tappar), falskt för 49,1, 60,4 och 62,9 m
  och för baskorpusen (de som appen bokför). Falskt också för alla 11
  T10 PASSAGE-EJ-REGISTRERAD-utslag i standardkörningen r1-standard-a, återskapade
  med triagens generator (`K/R2/tmp/rev2/t10worlds/metod1Bandlucka-standard.txt`).
  De hör till R1:s U-svängsklass: i 10 av dem är utgångsfixen första fixen efter
  korsningen, och i värld 1680 ligger fixen före utgången inom 50 m.
- **Rekommendation:** fallet är ett appfel utan beslut och ska bli ett eget kort.
  Ingen körning har hittat det (0 utslag i quick och standard, se ovan). Posten behövs
  först när motorn hittar fallet och kortet ska hållas samman i stället för att
  bli ett nytt kort varje körning. Lägg in den samtidigt som kortet, inte före.

Inga poster föreslås för F13:s kända gräns (hopp söderut utan kurs): 0 fall i
banken och i motorns körningar. Om motorn hittar det blir det T1
FÖRVARNINGSFORM-EFTER-PASSAGE med kurs i dödbandet eller ingen kurs och ett hopp
söderut över bron, och då hör det till ett nytt beslut, inte till DESIGN.
