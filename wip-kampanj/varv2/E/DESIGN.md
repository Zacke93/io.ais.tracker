# DESIGN — familj E (MOTOR), rättningskampanjens varv 2

Familjen rättar buggjägaren, appens offline-testmotor, inte appen. Underlaget är
triage B:s mekanismer M1, M2, M3 och B01 (`V/tB/TRIAGE-B.md`) och triage A:s M9 och M10
(`V/tA/TRIAGE-A.md`), plus dirigentens tillägg om ägarbeslutet U23 (KAMPANJ2.md).
Worktree `V/E/wt`, detached från c14938f. Appen (`app.js`, `lib/`, `drivers/`) är orörd.
Harnessen ändras bara additivt (`replayRunner.js`, ett nytt diagnostikfält).

Förkortningar: S = scratchpad, V = S/varv2, BOS = `lib/services/BridgeOpeningService.js`,
VDS = `lib/services/VesselDataService.js`, E = händelsen som täckte båten när hon korsade,
A = E:s första sanna korsning, B = båtens sanna korsning, W = fyndets varning.

## Commits (i ordning)

| Commit | Punkt | Innehåll |
|---|---|---|
| c667ca7 | 1, M2 | tystnaden över korsningen prövas på fixens tid |
| f69c88a | 2, M3 | gemensam RECOVER i villkor (2) |
| 5413323 | 3, B01 | kajpredikatet binds till textens bärare (motorfel; klassen orörd) |
| b8a60b1 | 3, U23 | KONFLIKT-posten ersätts av U23-KAJZON-UTANFÖR-VÄNTZONEN (ägarbeslut) |
| 85afb25 | 4, M1 | släppvägens domspår i harnessen; U17/K-NÄSTA på appens prognos med oberoende fysik |
| 606a52b | 6, M10 | ingen ny mätgränspost; K-NÄSTA gäller också T2:s vy av samma händelse |
| c474842 | samspel | familjerna A, B och F (samordnarens meddelande): domens arrivalMs/windowEndMs, U24-posten, Kajens Infinity, VDS-symboler |
| ca3d1af | 4, (3a) | med domspåret mäts raden mot fönstrets slut i appens dom (värld 1837) |
| cb2f41e | samspel | domspåret i en egen funktion i harnessen; studspostens kajmotivering (dirigenten, F:s L2) |
| 3f9f56b | samspel | U24-posten prövar U24:s övriga grindar i domens tal (familj B:s förslag) |
| 36f2f3b | samspel | U24-posten godtar en hörd köare och prövar grindarna bakom och en-prognos (B:s granskning) |
| 1dfd18a | 5, M9 | radion byter takt vid avgång (sista commit i första leveransen) |
| f0b7dc0 | rev. 1, H1 | (3′) oberoende av appens flaggor och fönsterslut (granskarens förslag) |
| d7dd393 | rev. 2, L1 | taktbytet i AISHub hörs aldrig senare; raderna före avgången bitlika; 10 radioseeds (L5) |
| 703bbf1 | rev. 3, L3 | harnessens bokföring undantagssäker; köflaggan bokförs och prövas i U24-posten |
| d913146 | rev. 4 | U24-posten godtar båda släppvägarna (A3e); kajK- och shrink-testen håller före och efter F |
| 5839d56 | rev. 5, L2/L4/L5 | dokumentationen och mätningarna efter granskningen |

Punkt 3 är två commits: motorfelet (bindningen) och registerändringen som ägarbeslutet U23
motiverar, så att granskaren kan bedöma dem var för sig. Punkt 6 och samspelscommitarna ligger
före punkt 5 eftersom punkt 5 ska vara sist. Var batteriets och körningarnas steg kördes står i
§11; slutcommiten skiljer sig från becf0ae (koden) bara i `docs/BUGGJAKT.md` (mätningarna).

## 1. M2 — tystnaden över korsningen (värld 941)

**Rotorsak, bekräftad.** `tystRecoverSammaÖppning` (registry.js, villkoret "tyst över
korsningen" för T3) jämförde `sista.aisTimestamp < kors.t`. För en AISHub-rad är
aisTimestamp mottagningen; fixen kan vara mer än en minut äldre. I värld 941 togs ZELDAs
sista rad emot 13:28:57,288, 0,1 s efter korsningen 13:28:57,177, men fixen var från 13:28:40
och visade henne 58 m norr om Stridsbergsbron i 6,7 kn. Appen kunde alltså inte se passagen.
Fixturen i `j-kampanj-register.test.js` (w941) gav KANDIDAT med skälet "kom efter korsningen";
det gamla vaktfallet byggde på samma misstag.

**Rättning.** `fixtid(sista) < kors.t` (fixTs, annars mottagningstiden), med båda tiderna i
skälet. U17:s regeltext synkad. Inget annat i predikatet ändras.

**Alternativ.** Bearbetningstiden (harnessens klocka) avgör när appen *hörde* raden, men inte
vad raden *visar*; positionen är fixens. Förkastat.

**Test.** `j-kampanj-register.test.js`: [träff] 941 (DESIGN U17), [vakt] samma rad med fixen
efter korsningen (KANDIDAT), [vakt] en rad utan fixTs prövas på mottagningen. Mot c14938f:
alla tre fäller (`V/E/bevis/m2-gamla-motorn.txt`).

## 2. M3 — gemensam RECOVER (värld 972, F07)

**Rotorsak, bekräftad.** Villkor (2) krävde `w.leadMmsi === fyndets båt`. I värld 972
absorberades QUEST och MASEN båda i Stridsbergsbron#6 13:49:33,735 (efter att ha släppts ur #4
och återabsorberats, J33 (a)), släpptes vid samma täckningsslut och bands till EN ny händelse
#10 13:54:52,919 (`BOS#_bindLooseArms` → `_openEvent`). Ledaren väljs på rått avstånd
(`BOS#_leadOf`): MASEN (715 m) före QUEST (1 067 m). Ingen av dem hördes efter absorptionen
(QUESTs sista rad 13:32:32,5, MASENs 13:41:33,6), så ingen färsk prognos kan ha seedat W.

**Rättning.** En annan ledare L godtas när (a) båten är medlem i W, (b) hennes och L:s
senaste absorption vid bron före W gällde samma händelse, och (c) ingen av dem har en egen
rad bearbetad (harnessens klocka) efter sin absorption och före W. Skälet säger vilket villkor
som fattas. Gäller båda lägena (U17 och K-NÄSTA), eftersom villkor (2) är gemensamt.

**Alternativ.** Att bara kräva samma händelse (utan tystnadskravet) hade godtagit en W som
ledaren seedat med en färsk rad. Att kräva att L också är U17-sann (rekursivt) är onödigt:
tystnaden sedan den gemensamma absorptionen räcker för att W är ett släpp, inte en ny prognos.

**Test.** Ny svit `k-varv2-motor.test.js` med fixturen `varv2-motor-2026-11-09.json`, byggd ur
världen med ALLA båtars rader (den gamla fixturen bar bara QUESTs tre rader och kunde inte visa
att ledaren var tyst): [träff] 972 och vakter för ledaren hörd efter absorptionen, hennes egen
rad efter absorptionen, en annan senaste händelse och icke-medlemskap. Vakten för 972 i
`j-kampanj-register.test.js` prövar nu en ledare utan absorption.

## 3. B01 — kajpredikatet (värld 138) och U23

**Rotorsak, bekräftad.** `mooringCapsuleStationary` itererade över alla båtar och godtog den
första som låg still minst 3 min i en kapsel mer än 600 m från bron. I värld 138 träffade
kajliggaren TROLLA (navStatus 5, still hela världen, utan rörelsebevis och utan målbro), medan
flashen var ULLAs 20-minuterssteg (U1-C11). Posten stod före U1-C11 i registret, så världen
blev KONFLIKT. Krymparen behöll TROLLA i minsta repro bara för klassens skull.

**Rättning (5413323).** Predikatet speglar zonregeln (`VDS#_classifyMooring`, :3623–3690) för
den båt som bar texten:
- appens stillhetsklocka (`VDS#_updateMooringEvidence`) spelas över hennes rader: start vid
  första raden med finit sog under STATIONARY_SOG_KN *var hon än ligger* (appen frågar inte
  efter zonen när klockan startar), en rad utan sog låter den gå, en rad med minst
  MOVEMENT_PROOF_SOG_KN eller två gråzonsrader i följd nollar den. Jitterhållet spelas inte;
  då startar predikatets klocka senare och predikatet blir falskt (bara smalare);
- demotionen är första raden i klockans sista varv där hon ligger i en kapsel och stilltiden,
  på harnessens bearbetningstider (appens `Date.now()`), nått zonens krav (3 min, eller zonens
  queueGraceMs inom 600 m med målbro och rörelsebevis); en navStatus 1/5 i varvet dessförinnan
  betyder navstatus-lagret;
- rörelsebevis (sog ≥ MOVEMENT_PROOF_SOG_KN) före varvet; utan det fick hon ingen målbro;
- hon var på väg mot bron (kursbandet i sista raden i rörelse, bron närmaste målbro framför
  henne; U1-C11:s bärarbegrepp);
- episoden börjar högst en halvminutstick + 40 ms efter demotionsraden.

Första versionen krävde att hela stillheten låg i kapseln; egna scenariot kajG visade att
appen startar klockan på en rad utanför kapseln (0,2 kn under inbromsningen) och demoterar
efter 3 min, så klockan följer nu appens.

**U23 (b8a60b1).** Dirigentens tillägg: ägaren beslutade U23 2026-11-09 (KAMPANJ2.md). En båt
på väg mot Klaffbron som stannar vid Kajen står kvar som i resten av väntområdet (D1 vinner);
Kajen för andra båtar och hela Gästhamnen behandlas som i dag. Fallet med 3 min och mer än
600 m krockar inte med D1 (båten är mer än 500 m från målbron). Förslaget, genomfört:
KONFLIKT-posten D1-KAJZON-DEMOTION ersätts av **U23-KAJZON-UTANFÖR-VÄNTZONEN (DESIGN)** på samma
plats, med samma predikat och gäller. Omfånget byts från "målbron mer än 600 m bort" till U23:s:
kapselns närmaste punkt ligger mer än APPROACH_RADIUS (300 m) från bron. Kajen ligger 161 m från
Klaffbron (inom), Gästhamnen 319,5 m (utanför), och båda ligger långt från Stridsbergsbron.
Därmed täcker posten exakt de två fallen "som i dag", och köfallet vid Kajen (före F:s
apprättning demoterat efter köundantagets 15 min) blir KANDIDAT med skälet att U23 kräver att hon
står kvar. Villkoret läser geometrin, inte queueGraceMs, så det håller både före och efter
familj F:s apprättning, också om F ändrar konstanterna i stället för zonregeln. Efter F
försvinner köfallets flashar ur körningarna; inget i posten behöver ändras. Beslutet speglas i
BUGGJAKT §7 (nytt avsnitt "Användarbeslut U23") och i listan (rad 40). Att ta bort posten
förkastades: då blev de beslutade flasharna (kajB, kajG) KANDIDAT.

**Test.** Fixturen bär 138 och fyra egna R0-scenarier: kajB (triagens, norrut, stopp 6 min i
Kajen 979 m från Stridsbergsbron: DESIGN U23), kajG (söderut mot Klaffbron, stopp 4 min i
Gästhamnen: DESIGN U23; före U23-commiten KANDIDAT av omfånget), kajK (triagens kajA med kön
kortad till 17 min vid Kajen: KANDIDAT, U23) och vakter för navStatus 5, en senare stillhet, en
sydgående kurs, 0,4 kn utan rörelsebevis och en ogiltig köundantagsgräns. Enhetsfallet i
`registry.test.js` är omskrivet.

## 4. M1 — U17 och K-NÄSTA på appens egen prognos med oberoende fysik

**Rotorsak, bekräftad.** Villkor (3b), kvotregeln (restid med radens fart ≤ 0,6 av tiden kvar
till fönstrets tidigaste slut), kan inte återskapa appens pessimistiska ETA nära broarna (vid
139 m 94 s mot den raka restidens 29 s). De nio U17- och K-NÄSTA-sanna släppen vid
täckningsslutet (1973, 537, 625 FREJA, 1337, 1629, 1752, 479; 510 och 1704 nästa öppning) hade
kvoter 0,78–1,03 och blev KANDIDAT.

**Harnessen (`replayRunner.js#instrumentApp`).** En wrapper på
`bridgeOpeningService._coverageVerdict` bokför `openingCoverageVerdicts`, en post varje gång
något ändrats sedan förra domen för samma arm (domen körs i varje utvärdering). Posten:
`{t, mmsi, bridge, eventId, verdict, arm: {lastSeenAt, anchorMs, expectedArrivalMs,
earliestArrivalMs, coverUntilMs, absorbedAt, distanceM, sog, lastFixClean, anchorFloor},
event: {id, firedAt, firstPassageAt, firstPassageRegisteredAt} | null, frozen, courseAway}`.
`verdict` är returvärdet kopierat **generiskt** (alla egna fält; tal, booleaner, null, strängar,
vanliga objekt och listor), så fält som familj B lägger till (fysikankomst, färskhet) följer
med utan ändring. Strängar får sina ISO-tider utbytta mot ‹tid›: SHIFT30 jämför hela resultatet
och flyttar bara tal och hela ISO-strängar, och bakkantsdomens reason bär tider mitt i texten.
`frozen` och `courseAway` kommer ur appens rena läsare (`_hasUnappliedObservation`,
`_courseAway`). Domen, armen och händelsen lämnas orörda. `instances.js` namnrymdar fältets
eventId efter en omstart, som `openingCoverage`.

**Fält som registret läser** (resten bokförs men läses inte): `t`, `mmsi`, `bridge`, `eventId`,
`verdict.kind`, när de finns `verdict.arrivalMs`, `verdict.windowEndMs` och (för U24-släppet)
`verdict.reason` (§8), `arm.lastSeenAt`, `arm.expectedArrivalMs`, `arm.coverUntilMs`,
`arm.lastFixClean`, `arm.anchorFloor`, `event.firedAt`, `event.firstPassageAt`,
`event.firstPassageRegisteredAt`, `frozen`, `courseAway`. Saknas något av dem i en post
(`domspårFält`) blir predikatet falskt med skälet "okänd form" i stället för att gissa. Vill B
att registret ska läsa B:s nya fält ska de ligga i returvärdet; anropssignaturen och `kind`
ska vara oförändrade (KAMPANJ2.md).

**Predikatet, villkor (3′)** (när resultatet bär spåret; utan spår gäller kvotregeln):
1. ingen dom från absorptionen i E till W var `bakkant`;
2. vid varje ren bakkantsdom (`covered` före täckningsslutet när passagen är bokförd *före
   hennes korsning*, över ett fix som armen tillämpade efter den skattade första passagen
   `firstPassageAt`, GPS-rent, inte fryst, utan kurs bort) ligger BÅDE appens prognos OCH den
   fysiska ankomsten ur samma fix
   (fixens tid + avståndet till bron med fixets fart, minst MINIMUM_VIABLE_SPEED) inom domens
   fönsterslut, `min(coverUntilMs, max(firedAt, firstPassageAt) + CONVOY_WINDOW_MS)` (golvhållen
   arm: täckningen), som i `_coverageVerdict`;
3. W kommer högst TICK_INTERVAL_MS efter hennes senaste dom `täckningsslut`.

Villkor (3a) (ingen rad efter fönstrets slut; med spåret appens slut i domen vid raden, §7) och
(4) (under-bron-hållet, kursen bort) prövas på raderna.

**Varför fysiken.** Appens prognos ensam skulle dölja appens prognosfel: ETA-kedjans golv 2,5 kn
efter en passage (M5, som familj B rättar) lade prognosen inom fönstret för kryparna i värld
790 (1 kn, fysiken 178–204 s efter fönstrets slut) och 1794 (1,1–1,5 kn). Därför krävs båda.
**Ingen tolerans:** i de nio fallen ligger fysiken 27–154 s och appens prognos 3,5–134 s inom
fönstret, och R1:s fartbrus (N(0; 0,15) kn) flyttar den fysiska ankomsten högst några sekunder
på de avstånd där marginalen är minst (1629: 1 210 m i 6,6 kn, ±2 %).

**Färskheten** mäts mot den skattade passagen (KRAV (2), `ARCHITECTURE.md:1848–1855`), inte mot
bokföringen som appen på c14938f gör (`ARCHITECTURE.md:1888`, "(4)"). Det är familj B:s rättning
av bakkanten (triage A, M4). Ett fix mellan passagen och bokföringen med prognosen efter
fönstrets slut är just det appfelet, och då blir predikatet falskt i stället för att dölja det.
Men bara när bokföringen kom före hennes korsning: bakkanten kan döma först när passagen är
bokförd, och bokfördes den efter att hon korsat kunde ingen bakkant släppa henne i tid; då är
RECOVER vid täckningsslutet den beslutade säkerhetsvarningen. Regeln kom till efter den första
mätningen (std-m1, med färskheten utan bokföringsvillkoret), där två U17-utslag blev KANDIDAT:
- **1160** (fixet 11:35:15, prognosen 11:40:57 efter fönstrets slut 11:39:31, bokföringen
  11:36:18, korsningen 11:39:19): ett äkta M4-fel. Med triage A:s skiss D (färskheten mot
  firstPassageAt) försvinner fyndet; bakkanten släpper henne vid bokföringen, 3 min före
  korsningen. Förblir KANDIDAT (förut dolt som U17).
- **1038** (prognoserna efter ledarens skattade passage 12:08:19 låg efter fönstrets slut, men
  passagen bokfördes 12:15:55, 12 s efter hennes korsning 12:15:43): ingen bakkant kunde hinna.
  Med skiss D släpps hon av bakkanten 12:15:55, fortfarande efter korsningen. Förblir U17.
Efter B:s rättning dömer appen samma fix, och då är kontrollen en mutationsvakt som för övriga
fix. **Öppen fråga till B och integrationen:** efter B blir 1038 ett bakkantssläpp efter
korsningen (passagen bokförd för sent), och det täcks inte av U17 eller K-NÄSTA. Det är triage A:s
M10 variant (i) ("E:s första passage bokfördes senare än korsningen − 60 s") och bör prövas när B
är integrerad.

**Alternativ.** (a) Skissens version med bara appens prognos: förkastad (döljer M5, 790 blev
K-NÄSTA). (b) Fysiken på alla rader efter bokföringen i stället för vid de rena domarna:
uppdraget anger de rena fixen, och raderna som appen inte dömt (före passagen) säger inget om
släppvägen. (c) En tolerans på fysiken: inte motiverad av mätbruset, eftersom marginalerna är
stora.

**Test.** `k-varv2-motor.test.js`: de nio ur världarna (med verkliga domspår), 790 (KANDIDAT
av fysiken), vakter för bakkanten bortkopplad (en ren dom med prognosen efter fönstret), en
bakkantsdom, en varning som inte följer på täckningsslutet, fysiken i 1 kn, under-bron-hållet,
M4-fixet i 1973, nya fält i domen (godtas), en okänd form (nej) och namnrymden.

## 5. Punkt 6 — M10 behövs inte som egen post

Efter punkt 1–5 prövades MÄTGRÄNS-U2-FÖNSTERKANT mot fynden. 510:s T3-utslag blir K-NÄSTA
genom punkt 4 och 977 försvinner med familj C:s apprättning. Kvar blev 510:s T2
ÖPPNING-MISS:OKLASSAD (korsningen 604 s efter VEGAs, RECOVERn 4 s efter korsningen): samma
apphändelse som K-NÄSTA-utslaget, sedd av T2. För en båt i samma öppning tar U2-VS-DEADLINE den
T2-vyn, men för nästa öppning saknades den, och en egen mätgränspost hade klassat samma händelse
två gånger med två klasser. Därför gäller K-NÄSTA nu också T2 OKLASSAD (gäller.klassRegex),
med hennes första levererade varning efter korsningen (högst CONVOY_WINDOW_MS) som W och samma
villkor som för T3. Föregångare: rad 32 (K-NÄSTA gäller också FRUSET-FIX, som U17).

Motexempel som förblir KANDIDAT: 977, 1476 och 1794 (ingen egen varning efter korsningen) och
1094 (prognosen 11:49:15 efter fönstrets slut 11:48:47 vid fixet 11:39:27, efter ledarens
skattade passage: triage A:s M4). 790 (T2 LEDTID) förblir KANDIDAT av fysiken.

## 6. M9 — radiomodellens taktbyte vid avgång

**Rotorsak, bekräftad.** `radio.js` drog nästa fixtid ur rörelsetillståndet vid föregående fix
(aisstream: `tS += max(10, interval(...moving))`; AISHub: `due = fixS + interval(...moving)`).
Värld 290: DAGNY lämnade kön vid Järnvägsbron 14:48:09; nästa fix kom 14:50:53 (164 s), 46 s
före korsningen. Värld 625: DAGNY lämnade kön 09:32:53, 3,6 s efter stillafixet, och hördes
först 09:44:28 (11,6 min).

**Rättning.** När den dragna tiden kommer ur stillaregimen och banan rör sig strikt före den
(`avgångMellan`), dras tiden om: `min(dragen, avgången + rörelseintervall)` (aisstream med
10 s-golvet). Aldrig senare än den först dragna tiden: tätare rapportering kan bara flytta nästa
sändning närmare, som när en SOTDMA-transponder lägger till platser vid högre fart. Ett fast
intervall (R0, `fixedIntervalS`) påverkas inte. Profilfältet `taktbyte: false` ger den gamla
modellen (för jämförelser och jest). Efter rättningen hörs DAGNY 14:49:46 i 290 och 09:33:32 i
625.

**AISHub efter granskningen (L1, d7dd393).** Den första versionen lovade "aldrig senare" bara för
den dragna tiden. I AISHub kunde en tidigare poll leverera ett stillafix (fixålder) och lägga
nästa rörelseintervall efter det, och det extra slumptalet vid stillapollen flyttade åldrarna i
pollerna fram till avgången: 57 av 251 avgångar hördes senare (median +27 s, max +272 s), och
raderna före avgången skilde sig i 2. I värld 1527 hördes DAGNY 334 s efter avgången i stället
för 62 s, och det gav två nya KANDIDAT-utslag. Nu gäller den omdragna tiden bara fixar från
avgången och framåt (en äldre fix prövas mot den gamla tiden), och rörelseintervallet dras ur
avgångens egen ström (`radio-<mmsi>-avgång-<s>`). Båtens ström är därmed densamma som i den
gamla modellen fram till den första färska fixen, så den första hörda fixen kommer aldrig senare
och raderna före avgången är bitlika. aisstream var redan rätt: nästa rad efter stillafixet
kommer tidigast vid avgången. Mätt över standardens 2 000 världar (granskarens `m9.js`):
aisstream 242 avgångar, 181 tidigare och 61 samtidigt; AISHub 130 avgångar som ändras, alla
tidigare (p50/p90/max 57/96/147 s mot 199/549/1 371 s); 0 rader före avgången ändras, 0 båtar
utan avgång, R0 bitlik och determinismen hel. 1527 ger inga utslag.

**Alternativ.** Att alltid dra två intervall (stilla och rörelse) vid varje fix hade ändrat alla
båtars rader; att ersätta tiden med avgången + rörelseintervall även när den blir senare hade
gjort vissa avgångar *senare* hörda. Det motsatta bytet (stopp mitt i ett rörelseintervall) ger
fler observationer, inte färre, och lämnas.

**Test.** `a-radio.test.js`: `avgångMellan`; per era och klass över 10 radioseeds (förut 25,
granskningen L5) jämförs ny och gammal modell (`taktbyte: false`): raderna mottagna före
avgången är bitlika, och första fixen efter avgången kommer aldrig senare, i båda erorna. R0 är
bitlik. AISHub-testet fäller 1dfd18a (klass A: 65 s mot 1 s).

## 7. (3a) med domspår — värld 1837

**Rotorsak, bekräftad** (värld 1837 med M9:s radio, `tmp/prov/w1837.json`). 265594787 absorberas i
Stridsbergsbron#4 12:39:04. Passagen bokförs 12:51:26 (skattad 12:47:27). Hennes rad 12:52:32,176
(fixen 12:52:14, 85 m före bron i 5,4 kn) döms `covered`: prognosen 12:52:43,893 ligger inom
täckningsslutet 12:52:46,115. Hon korsar 12:52:43,927 osedd, och RECOVERn #6 kommer 12:52:46,116.
Det är U17:s fall, men villkor (3a) fällde det: raden bearbetades efter fönstrets skattade
tidigaste slut `min(bok + 600 s, max(E, första korsningen) + 600 s, W − tickMs)` = 12:52:16.
Termen W − tickMs är en gräns för resultat utan spår (täckningsslutet ligger högst en tick före
W); med spåret är appens eget slut känt.

**Rättning** (ca3d1af). Med domspåret mäts varje rad mot fönstrets slut i appens dom när raden
bearbetades (den första domen från bearbetningen, när den är en dom `covered` efter passagen,
`domensFönsterslut`). Annars gäller skattningen. (3′) prövar prognosen och fysiken vid samma
dom (här 12:52:43,9 och 12:52:44,6 mot 12:52:46,1), så ingen bakkantsregression göms: i
mutationsproven på punkt 1–6 fälldes inget utslag av (3a), och slutlägets mutationsprov står i
§11. Test: 1837 ur `fixtures/varv2-m9-1837-2026-11-09.json` (U17), samma utan spår (KANDIDAT,
skattningen) och en rad efter slutet i sin egen dom (KANDIDAT); två av tre fäller c474842.

## 8. Samspelet med andra familjer (samordnarens och dirigentens meddelanden)

**B (BAKKANT), domens fält** (c474842). B:s steg 2 bär `arrivalMs` (M5: under 2,5 kn den senare
av prognosen och armens fysik), `physicsArrivalMs` och `windowEndMs` i domen; patch M7 (U24)
dessutom `ownDeadlineMs` och `gate`. Harnessen kopierar domen generiskt och behövde ingen
ändring. (3′) läser nu `arrivalMs` i stället för armens `expectedArrivalMs` och `windowEndMs`
i stället för det egna fönsterslutet, när fälten finns (`domensAnkomst`, `domensFönsterslut`);
kravet på den oberoende fysiken står kvar. Utan fälten (c14938f) är predikatet oförändrat.

**B, U24:s släpp före första passagen.** Domen `bakkant` med skälet "egen deadline …"
(`u24Släpp`) räknas av U17 och K-NÄSTA som bakkant (hon fick en egen varning och hörde inte
till den gemensamma öppningen), och skälet säger det. K-NÄSTA delar predikat med U17, så det
gäller båda. **U2-VS-DEADLINE:** predikatet är oförändrat. Posten gäller en korsning inom en
varnad öppnings fönster; ett U24-släpp gäller en båt vars båda prognoser låg efter fönstret,
och korsar hon ändå inom det hör hon enligt U2 till den varnade öppningen. Frågan är
uppdaterad: U24 valde C-IV väg b för båtar i rörelse utanför väntzonen; för korsningar inom
fönstret och för stilla köande båtar står den kvar. I bakkantsmutanten på punkt 1–6 tog
U2-VS-DEADLINE 8 nya utslag (T2 LEDTID/OKLASSAD inom första passagen + 600 s): båtarna korsade
inom fönstret, och posten är KÄND_ÖPPEN, så de syns i rapporten. Det är samma bild som mutation B
i review2 (b) (BUGGJAKT §7), som föreslog att nästa granskning prövar om posten ska bindas till
släppvägen som U17. Den bindningen ändrar en KÄND_ÖPPEN posts doktrin och är inte gjord här; den
står som öppen fråga.

**B, provvärld 143 och posten U24-DELAD-KÖ-EXTRA-VARNING** (DESIGN, c474842). På B:s 0b0a35d
(U24) släpps RUNA ur ALVAs #1 11:14:52 på sin egen deadline och varnas själv (#3). CORDELIA
köar stilla 104 m från bron, går vid #1:s täckningsslut 11:25:13 till #3 och varnas vid dess
täckningsslut 11:36:10 (#8) på sitt fix från 11:15:10 (T3 VARNING-PÅ-FRUSET-FIX). Hon korsar
353 s efter RUNA. Ägaren godtar kostnaden (U24). Predikatet `u24DeladKö` är smalt och kräver
alla: (1) W på tick följer inom en tick på hennes täckningsslut i E, E:s passage okänd; (2) E
leds av L och avfyrades inom en tick efter att U24 släppte L ur E0; (3) U24:s villkor höll för
L på hennes egen rad, oberoende av appens ETA: mer än 350 m från bron, mer än 0,5 kn, och både
fysiken och domens arrivalMs efter windowEndMs; dessutom U24:s övriga grindar i appens egna tal
i domen (armens avstånd, egen deadline, täckningsslut-i-tid, golv, kurs, rent fix; 3f9f56b,
efter familj B:s förslag i V/B/DESIGN.md) och B:s nya grindar efter granskningen, 'en-prognos'
(appens ETA fanns, prognosen var inte exakt armens fysik) och 'bakom' (L hade inte korsat bron
före släppet, ur L0; 36f2f3b); (4) hon var absorberad i E0 före släppet och
gick vid E0:s täckningsslut (passagen okänd) till E; (5) alla hennes rader från absorptionen
låg inom väntzonen och den sista var stilla, så U24 kunde aldrig släppa henne; (6) samma
öppning: korsningen efter W, vid eller efter L:s och högst 600 s efter; (7) fixet var högst T3:s 19 min gammalt
vid E0:s täckningsslut (`t2Opening.js#FROZEN_FIX_MS`, nu exporterad), så fixåldern kommer av
delningen. Hon får ha hörts efter E0:s täckningsslut: B:s granskning (anmärkning 4, proben A3b)
visade att kostnaden också träffar en hörd köare, som får sin extra varning på ett färskt fix.
Den ger inget utslag i motorn (T3 flaggar bara ett fix äldre än 19 min, och varningen kom i tid),
men tystnar hon efteråt i mer än 19 min blir det samma T3-klass, och då tar posten den.
Domens fält `gate` kan få B:s nya värden ('bakom', 'en-prognos'); posten läser inte `gate` utan
prövar grindarna själv. B:s omskrivna förslag till post fanns inte när koden lades fast
(V/B/DESIGN.md senast ändrad 12:28), men B:s revision 5d4b2c3 fanns: med den och slutmotorn är
143 fortfarande DESIGN U24, och quick är oförändrad mot 0b0a35d (`bevis/u24-quick-b-revision.txt`). En dom `covered` med `gate: 'bakom'` efter passagen bär inga
ankomstfält; (3′) faller då tillbaka på armens prognos, vilket i värsta fall ger en KANDIDAT för
mycket, aldrig en dold regression. **Varför den inte döljer en bakkantsregression:** utan U24-släppet finns ingen dom
att binda E till; en känd passage vid täckningssluten ger nej (bakkanten efter passagen gällde);
en båt utanför väntzonen eller i rörelse kunde ha släppts av U24 och ger nej; ett släpp av L
som bröt U24:s villkor eller en av appens grindar ger nej. Skillnad mot B:s förslag
(`U24-KONVOJDELNING`): B föreslog att harnessen också skulle bokföra `waitingAtBridge`; det
gör den inte, så köflaggan prövas inte, men grinden `kö`:s avstånd prövas både på L:s rad och
på armens `distanceM`. Posten kräver dessutom (1) och (4) okänd passage, (5) stilla i
väntzonen och (7) fixåldern vid E0:s täckningsslut. Mätt: quick på b3 (B + motorn): 143 blir DESIGN U24, och posten
används bara där; med bakkanten efter passagen bortkopplad (b3-mut) 21 nya utslag, alla
KANDIDAT, 0 U17/K-NÄSTA och U24-posten fortfarande bara 143 (`bevis/u24-quick-mut.txt`).
Jest: 143 ur B:s app, samma värld med en hörd köare och 18 vakter i nio test; de sex första fäller 606a52b, grindtestet cb2f41e och testen för den hörda köaren, 'bakom' och 'en-prognos' 3f9f56b.

**F (U23 i appen).** Kajens `queueGraceMs` är Infinity efter F. (a) Kajpredikatet läser fältet
som appen (`typeof … === 'number' && > 0`, Infinity giltigt; `kravTxt` säger "aldrig:
obegränsat köundantag"); förut gjorde `Number.isFinite` Infinity till 3 min. Utfallet för Kajen
mot Klaffbron är KANDIDAT före och efter F (inom väntzonen), men skälet beskrev en demotion
som appen inte gör. (b) `shrink.js` läser Kajens köundantag ur zonposten (`kajensKöundantagS`)
och tar inte med ett obegränsat undantag (förut hårdkodat 900 s). (c) Studspostens krav 6
(ingen fix i en kajkapsel) är oförändrat; motiveringen säger att en köare vid Kajen efter U23
kan bära "strax" i upp till 2 h. Jest: kajK och kajB med Infinity, shrink med och utan
undantaget. Mätt på F:s 3887254 med motorn: värld 1623:s T2 LEDTID (se §11) försvinner.

**A (SAMMA-TICK).** Registrets radhänvisningar till VDS pekar på symboler (`#FIX_D_MIN_SOG`,
`#_createVesselObject`, `#getVesselsForBridgeText`, `#STALE_AIS_TIMEOUT_MS`); laddningen
kontrollerar dem. :5286–5287 pekade redan på c14938f fel. Kommentarerna i registry.js och de
historiska raderna i BUGGJAKT är kvar med rader.

**Harnessen och F.** Domspåret ligger i den egna funktionen `instrumentCoverageVerdicts`, som
`instrumentApp` anropar med en rad (cb2f41e), så att F:s `confirmedTargetWaits` kan läggas
till utan konflikt. Ren kodflytt: 26/26 korpusar bitlika med och utan monitoring, domspåret
medräknat (`bevis/bitlik-flytt*.txt`).

**C och D.** Inga predikat ändras för dem. Värld 1527 (ny med M9, §11) ligger i D:s område
(spärren vid en tidigare bro, tyst avgång) men försvinner inte med D:s 9fe94c6.

**Integration.** registry.js, beslutsregistret, fixturerna, shrink.js, radio.js, t2Opening.js
och BUGGJAKT.md rörs bara av E. I replayRunner.js lägger E en funktion på toppnivå, ett anrop i
instrumentApp, en deklaration och ett resultatfält.

## 9. Hur besluten följs

U17 (säkerhetsvarningen behålls; premissen prövas nu direkt), U13 (inget facit flyttas; appen
orörd), U22 (ETA-texten och ETA-kedjan rörs inte: registret läser bara det appen redan räknar),
U18 (orörd), C-IV/U2 (U2-VS-DEADLINE:s predikat orört, frågan uppdaterad efter U24; punkt 6
gäller bara > 600 s), D1 och U23 (kajposten följer U23 och läser F:s Infinity; inget annat
kajbeslut tas), U24 (en smal DESIGN-post för den godtagna kostnaden i 143; U24-släppet räknas
som bakkant), §15 "rätta motorn, aldrig registret" (registerändringar bara för motorfel, för
dokumenterade ägarbeslut U23 och U24 och för punkt 6; alla i §7:s lista, rad 37–49).

## 10. Dokument som uppdateras

`docs/BUGGJAKT.md`: §2 (replayRunner bokför additivt, i en egen funktion), §4.2 och §4.5
(taktbytet, realismsiffror), §4.4 (Kajens köundantag i familjetabellen), §7 (posttabellen,
U17-avsnittet, avsnitten U23 och U24, studspostens motivering, listan rad 37–49, Följder i varv
2), §14 (efter varv 2), bilaga A.7 (mätningarna), bilaga B (T6:s kajundantag efter U23), bilaga
C. `beslutsregister.json` (regeltexter, källor, U23- och U24-posterna, K-NÄSTA:s gäller,
U2-VS-DEADLINE:s fråga). Kodkommentarerna i registry.js, radio.js, shrink.js, instances.js och
replayRunner.js. Inget facit, ingen VALIDATION-rad (inget nytt syntetiskt scenario), CLAUDE.md
oförändrad.

## 11. Mätningar

Alla körningar 2026-11-09 under tung främmande last (load 30–60). Underlag i `V/E/bevis/`,
`V/E/batt5` (af57b8f, alla 13 steg), `V/E/batt6` (5d3484f) och `V/E/batt7` (becf0ae, motorns
steg), `V/E/std-fore` (c14938f) och `V/E/std-efter` (f5eb11a). Commitarna efter f5eb11a ändrar
inget utfall på c14938f:s app (flytten i harnessen är bitlik, och U24-posten kräver U24-domar);
fyra quick-körningar har identiska kluster.

| Område | Utfall |
|---|---|
| Batteriet | 13/13 steg slutkod 0 på af57b8f; motorns steg 0 på 5d3484f och becf0ae. Jest 370 sviter, 5 324 test (2 överhoppade), inga öppna handtag; motorn 27 sviter, 426 test. Porcelain bara node_modules. |
| Harnessen | bitlik mot c14938f utom fältet (26/26, med och utan monitoring); flytten bitlik med fältet (26/26). |
| Standard före/efter | 263 → 261 utslag, 46 → 44 kluster, 11 → 9 kort. 33 fynd ändras, alla förklarade i BUGGJAKT §7 (följder i varv 2): 12 till U17/K-NÄSTA (M1, M2, M3, punkt 6), 1160 till KANDIDAT (M4), 138 till U1-C11 (B01), M9 tar bort 290 och 625:s DAGNY och ger nya realiseringar (1527 i D:s område, 1623 U23:s köfall), och 1837 är U17 via (3a). |
| quick | mot V/bas/quick: bara 290 BORTA och 138 → U1-C11; inga nya kandidater eller utslag. |
| Mutationsprov | bakkanten bortkopplad (slutmotorn och punkt 1–6): 75 nya, 67 KANDIDAT, 8 U2-VS-DEADLINE, 0 U17/K-NÄSTA; under-bron bortkopplat (punkt 1–6): 4 nya, alla KANDIDAT. |
| B:s app | quick: 143 → DESIGN U24, posten bara där; bakkantsmutanten 21 nya, alla KANDIDAT; grindarna kö och täckningsslut-i-tid bortkopplade: inget ändras. 1160 BORTA, 1038 KANDIDAT. |
| hunt:repro | familjens 20 kort BORTA; 6 KVAR hos andra familjer (F02, F05, F08, 790, 977, 1794). |
| Jest-tid | 5 s ej prövbart på ledig maskin; växelvis mot c14938f vid load 17–22 19–28 s mot 21–22 s, CPU med varm cache 13,0 s mot 10,7–11,1 s (+20 %). |
| Tider | standard 59 min (load 40–60); quick 4 min (load 17–22) till 12 min; självtest 98–255 s. |

## 12. Revision efter granskningen (ÄNDRINGAR KRÄVS)

Granskningen (`V/E/GRANSKNING.md`) fann ett högt fel och fem låga; dirigentens lista
(`V/E/ATT-GORA-REVISION.md`) lade till tre punkter. En commit per punkt, ovanpå 1dfd18a.

- **H1 (hög), f0b7dc0.** Villkor (3′) valde vilka fix som prövas med appens egna flaggor, (3a)
  hoppade över raderna med spåret, och fönsterslutet var appens `windowEndMs`. En bakkant som
  slogs ut via renhetsflaggan syntes inte. Granskarens `förslag-H1.diff` är infört: (a) fysiken
  ur varje egen rad efter `bok` mot fönstrets slut vid raden (3a′), (b) det tidigare av
  `windowEndMs` och motorns räknade slut, (c) `lastFixClean` undantar inte en dom. Quick:
  "aldrig rent fix" 21 av 23 KANDIDAT (1 U17, w235, som c14938f:s motor; 1 J13), förut 4;
  "fönsterslut = täckningsslut" på B:s 5d4b2c3 3 av 3, förut 2; omuterat 0 ändrade utfall på
  c14938f:s och B:s app. De nio, 1837 och alla övriga fixturfall är oförändrade. Vakter för
  båda mutationerna och en fryst arm; tre fäller 1dfd18a.
- **L1, d7dd393.** Se §6.
- **L3, 703bbf1.** Bokföringen i try/catch (domen räknas först och returneras alltid, ett fel
  blir en post med `fel`, som predikaten läser som okänd form). `arm.waitingAtBridge` bokförs,
  och U24-postens grind `kö` prövar flaggan. Replay bitlikt mot c14938f utom domspåret (26/26,
  med och utan monitoring). Funktionen prövas fristående i jest (en cyklisk dom).
- **Revisionslistan, d913146.** (1) U24-posten godtar båda släppvägarna ur E0 (täckningsslutet
  eller ett eget U24-släpp som håller samma villkor och grindar, hjälparen `u24Brott`;
  stillheten prövas då från absorptionen i E). (2) B:s revision 2 (e5f78b5, krypfix på fixtid,
  ett krypfix efter marschfart godtas): quick med motorn ger 0 ändrade utfall mot B:s 5d4b2c3
  (U17 7, K-NÄSTA 1, U24 1, KANDIDAT 8 i båda). (3) Symbolhänvisningarna laddar utan varningar
  i E:s träd och med F:s 0dce236. (4) kajK- och shrink-testen håller före och efter F: motorns
  27 sviter är gröna med F:s 0dce236 (432 test), och E:s `replayRunner.js` läggs rent ovanpå
  F:s.
- **L2, L4 och L5, 5839d56.** U24:s policygrindar och KRAV (1) syns bara i räknarna och i jest
  (§7, känd gräns). Dokumentationen rättad: listans inledning, marginalen 27–154 s, realismens
  övriga mått, §14 (jest-kravet håller inte; konvojfönstrets bakkant hör till Kajens köundantag,
  inte CONVOY_WINDOW_MS) och 1527 (radioartefakt, inte D:s område). a-radio.test.js kortad.

**Mätningar efter revisionen** (BUGGJAKT bilaga A.8, `V/E/bevis/`):
- **Batteriet** (`batt-rev1`, 67e09fa; slutcommiten 5839d56 skiljer sig bara i BUGGJAKT.md): alla 13 steg
  slutkod 0, jest 370 sviter och 5 332 test (2 överhoppade), motorn 27 sviter och 434 test, självtestet
  grönt, porcelain bara node_modules. Quick: 58 utslag, 24 kluster och 4 kort; mot becf0ae är bara 129
  nytt (T2 LEDTID, samma radiorealisering som i standard).
- **Standard** (`std-rev1`, 10 min vid load 10–12): 261 utslag, 44 kluster och 9 kort, som std-efter. 6 fynd
  ändras, alla av L1: 1527:s två KANDIDAT-utslag försvinner; 1675 (U17) flyttar 59 s; två nya
  radiorealiseringar blir KANDIDAT, 129 (T2 LEDTID: U23:s köfall vid Kajen, borta med F:s 0dce236) och
  340 (INV-3 ETA-OSCILLATION, ETA-kedjan enligt U22). H1 ändrar inget utfall i standard
  (`bevis/std-efter-rev1.txt`).
- **Mutationer, radio, harness, B:s revision 2 och F:** se §12 ovan och A.8.
- **Jest-tid:** motorns sviter 16,3–18,9 s mot c14938f:s 14,8–15,7 s vid load 14–19 (user 12,3–12,5 s mot
  10,8–11,0 s); 5 s-kravet håller inte för någon av dem med `--detectOpenHandles`.

