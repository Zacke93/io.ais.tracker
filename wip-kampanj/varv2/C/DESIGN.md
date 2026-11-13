# DESIGN — familj C, M3 ÅTERFÖDD-DÖDBAND (rättningskampanjen varv 2, 2026-11-09)

Förkortningar: S = `/tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad`,
V = S/varv2, C = V/C. VDS = `lib/services/VesselDataService.js`. Radnummer utan
prefix "c14938f:" gäller mina commits i C/wt (detached ovanpå c14938f): `f62aea8` (prototypen),
`19b3bfa` (revision 1, kajgrinden i §2 punkt 3) och `d190e9c` (revision 2 efter granskningen,
GRANSKNING.md L1–L6: kommentarer, dokument och test, ingen beteendeändring).

## 1. Rotorsaken, bekräftad med logg och minsta repro

**Världen 756 (F05-representanten, FREJA 265172107, söderut).** Buggjägarens minsta
repro (V/tA/fynd/F05/repro.jsonl, 14 rader, nu också `tests/fixtures/m3-f05-freja-aterfodd-dodband.jsonl`)
ger på c14938f, verbos replay (V/tA/logs/F05rep.log, rad 189–227):

| Tid | Logg | Betydelse |
|---|---|---|
| 13:37:39 | `Outside canal bounds (lat=58.320527 …)` | första fixet: ingen målbro, ingen K1-bas |
| ~13:42:39 | `VESSEL_REMOVED (timeout)` | 5 min (7,4 kn > 4 kn) |
| 13:44:47 | `GRAVE_SKIP … 1582m` | återfödd, för långt bort för arv |
| 13:44:47 | `NORTH_PROGRESS_REBIRTH … (-3.408 m/s över 428 s)` | K1 mot sist kända position |
| 13:44:47 | `Qualifies for target bridge (6.4kn …, 229.6°)` | `_shouldAssignTargetBridge` släpper |
| 13:44:47 | `Osäker COG (229.6°) → ingen målbro` | c14938f:VDS:4645–4651 |
| 13:44:47 | `SKIPPED_BRIDGES_DIRECTION_LOCK … 'south'` | c14938f:app.js:8676–8686, EFTER `_observeBridgeOpening` |
| 13:45:02–13:57:23 | `ctrl:disconnect` | avbrottet; sann korsning 13:54:34,202 |

Ingen `OPENING_ARM` för Stridsbergsbron. I `_onVesselEntered` körs `_observeBridgeOpening`
(c14938f:app.js:3056) före `_checkSkippedBridgesFallback` (:3068), så svepets lås kom för sent
för både målbrovalet (i VDS) och armen. Nästa fix hade inte räddat henne heller:
`_calculateTargetBridge` följer ruttlåset bara när kursen SAKNAS (FP8), inte när den ligger i
dödbandet. Utan arm går ingen deadline. Fixet 1888 m ut i 6,4 kn hade gett deadline
13:47:54, alltså 400 s före korsningen; det är ingen mätgräns.

**1913 (HAVSORN, norrut mot Klaffbron)** och **977 (PELLE)**, V/tA/logs/w1913.log och w977.log:
samma kedja. HAVSORN återföds 13:25:52 (1,108 m/s, kurs 45,3°) och 13:38:12 (2,040 m/s, 48,6°);
båda gångerna `Osäker COG`, och 13:38:12 låser svepet 'north' efter armvalet. PELLE återföds
07:22:35 (1,041 m/s, kurs 50,9°, 2,8 kn) utan målbro.

**Minsta egna repro** (C/logs/m3-syd-base.log och m3-nord-base.log, scenarierna i §3): båten
hörs en gång utan målbro, raderas, återföds med dödbandskurs och tystnar över målbron. På
c14938f: svepet låser i återfödelsens tick men ingen målbro, radering efter 10 min, nästa fix
bortom bron. Ingen varning för bron.

## 2. Rättningen på kodnivå

1. **Ny-båtsgrenen** (VDS:503–572). Blir `_calculateTargetBridge(vessel)` null och saknas
   ruttlås, prövas `this._rebirthTransitDirection(vessel, FIX_D_MIN_SOG)`. Ger den en
   riktning låses den (`_lockRouteDirection`) och `_calculateTargetBridge(vessel, dir)` väljer
   målbron (positionsbevisad riktning: kursen läses inte, FP8-vägen). Blir det ingen målbro
   (t.ex. på väg ut ur kanalen) eller håller kajgrinden (punkt 3), nollas låset, så att svepet
   beter sig exakt som förut. Sedan går den vanliga vägen: `_deriveAssignmentDirection` (kurs
   tvetydig ⇒ ruttlåset), `_lockRouteDirection`, `_extendJourneyOrigin`. Logg:
   `[TARGET_ASSIGNMENT_REBIRTH]`.
2. **`_rebirthTransitDirection(vessel, minKn)`** (VDS:4091, efter `_rebirthNorthBase`). Krav:
   1. kursen är giltig och ligger i ett dödband (varken `isNorthCog` eller `isSouthCogStrict`);
   2. rapporterad fart ≥ 2,0 kn (`FIX_D_MIN_SOG`);
   3. `_lastNorthProgress` hör till detta meddelande (ts-kontraktet från `_freshNorthProgressMps`);
   4. |nordprogress| ≥ 2,0 kn (`minKn × KN_TO_MPS`, projektets enda knopomräkning);
   5. kursens sida stämmer: östra dödbandet (46–134°) ↔ norrut, västra (226–314°, Fix D:s
      breda sydband) ↔ söderut. Avvikelsen loggas.
3. **Systerstället, kajgrinden** (revision 1). Svep över alla anrop av
   `_calculateTargetBridge(`: ny-båtsgrenen (:507, :527), ACCELERATED (:876) och kajgrinden
   `_slowInitialQuayApproachNeedsProof` (:4226), som räknar sin målbro ur kursen och därför är
   stum för varje dödbandskurs. I ACCELERATED-grenen finns samma mönster kvar (granskningen
   L4): `_shouldAssignTargetBridge` prövar kajgrinden mot kursens målbro, men grenen tilldelar
   `_calculateTargetBridge(vessel, positionDirection)`. Med kurs i dödbandet och
   positionsbevisad riktning, alltså en långsam positionsvändning via
   `_updatePositionDirectionEvidence` eller en köbekräftelse via `_confirmRebornQueueApproach`,
   är grinden därför stum. Felet fanns redan på c14938f och skapas inte av M3. Jag lämnar det,
   eftersom grenen hör till målbrokedjan efter vändningar, där familj A arbetar i varv 2, och
   eftersom inget fynd eller fall i banken visar det. Det står som öppen fråga i §10. Utan ändring hade en
   båt som legat vid sin kajplats i Gästhamnen, gått ut förbi Klaffbron, raderats och kommit
   tillbaka i 2,5 kn med kurs 80° fått målbro av M3, fast grinden håller samma båt med kurs i
   banden (testet "kaj: återkomst …" är rött på `f62aea8`). Grinden fick en valfri parameter
   `proposedTarget`; utelämnad räknar den som förut. M3 prövar sin målbro mot den.
4. **Loggraden i `_calculateTargetBridge`** (VDS:4757): med positionsbevisad riktning stod
   det "COG saknas (229.6)"; nu "positionsbevisad riktning (kursen … läses inte)".
5. Kommentarer i app.js (svepets lås :8659 och `_freshNorthProgressMps` :11113), inga
   beteendeändringar där.

Följder för klassen (båtar som beviset gäller): målbron och armen kommer på återfödelsen i
stället för vid en senare fix. Därmed går också STEG 3 i `_onVesselEntered`
(`_triggerBoatNearFlow`, villkoret `vessel.targetBridge`) i samma tick, så en återfödd båt
inom 300 m från en bro får sin närmar-sig-notis direkt, med låsets riktning, precis som en
båt med kurs i banden. Brotexten visar båten med ETA från återfödelsen; ETA-kedjan själv är
orörd (U22). I banken ger regeln inget av detta (bitlik, FACIT.md).

## 3. Regressionstest

- `tests/m3-aterfodd-dodband-2026-11-09.test.js`, 26 test i sju steg: rådatans tal; RIKTIGA
  `updateVessel` för FREJA (756), HAVSORN (1913), PELLE (977) och SY FREYJA (låset släpps);
  F18-motexemplen med kajåterkomsten och dess kontroll; grindarna en och en; ordningen mot
  svepet genom hela appen; hela appen på fixturen (Stridsbergsbron#1 `deadline`
  13:47:54,060, ≥ 400 s före korsningen); och (revision 2) granskningens W1 och W3, som
  genom hela appen ska ge exakt tvillingens utfall (kurs 25° vid återfödelsen). Mot en kopia
  av c14938f (C/tmp/base): 17 av 26 röda. Kärnfallen, kontrollen, ordningen, helappen och
  tvillingtesterna fäller på beteendet; testerna som anropar `_rebirthTransitDirection` fäller
  på att metoden saknas. Motexemplen utan sådant anrop är gröna i båda.
- Två syntetiska scenarier i `runSyntheticScenarios.js` (benläget, nytt valfritt `cogDeg` i
  `scenarioGenerator.js` som inte drar extra slumptal):
  `återfödd-i-dödbandet-söderut-tyst-över-Stridsbergsbron (M3, värld 756)` och
  `…-norrut-tyst-över-Klaffbron (M3, värld 1913)`. Krav: `expectedOpenings`,
  `deadlineFiredOpenings`, `maxOpeningsPerBridge`. Mot c14938f-kopian: båda röda
  (SAKNAD ÖPPNINGSVARNING, ÄGGKLOCKAN TYST), de övriga 74 raderna identiska. Med
  rättningen gröna, ingen ny WARN. docs/VALIDATION.md: 74 → 76.

## 4. Tröskeln mot fältdata

`C/scripts/faltfordelning.py` (utdata C/matningar/faltfordelning.txt): alla fixpar i bankens
24 korpusar med 65–900 s mellanrum (återfödelsens mätregim: tidigast PASSED_TIMEOUT, högst
nordprogressens 15 min), K1 på mottagningsklockan, klassade mot gt-passages (transit = sann
korsning i K1-riktningen inom [t0 − 10 min, t1 + 30 min]).

| Population: sog ≥ 2 och kurs i dödbandet (171 par) | n | median | max | låses vid 2 kn |
|---|---|---|---|---|
| transit i K1-riktningen | 121 | 1,89 kn | 6,62 kn | 56 (46 %) |
| motsatt riktning (vänd) | 6 | 0,21 kn | 1,14 kn | 0 |
| passage nära men inte i fönstret | 32 | 0,67 kn | 1,68 kn | 0 |
| ingen passage inom ± 60 min | 12 | 0,17 kn | 0,61 kn | 0 |

Känslighet (transit låst / övriga låsta): 1,0 kn 87/7, 1,5 kn 72/2, 1,75 kn 66/0, **2,0 kn 56/0**,
2,5 kn 50/0, 3,0 kn 41/0. Valet 2 kn: det är `FIX_D_MIN_SOG`, projektets befintliga ribba för
rörelsebevis i riktningsbeslut (AERANDIR: vobbel i 1,1–1,8 kn; C4b, F4-J), alltså inget nytt
kalibrerat tal; den ligger över bankens högsta icke-transit (1,68 kn) och 2,4 gånger över
kajavgången NORDIC SOLA (41h: 0,433 m/s = 0,84 kn i 3,2 kn, kurs 46,5°). Som jämförelse är
dig3:s effektiva anflygningsfart (lib/constants.js vid `DEADLINE_MAX_SPEED_KN`) median 3,13 kn
och p90 5,24 kn; 2 kn är 64 % av medianen. En lägre ribba (1,5 kn) låser två icke-transitpar;
skissens första variant (0,25 m/s) flyttade tre golden-text-rader i 41h till sämre. En högre
(2,5 kn) förlorar 977 (2,02 kn) utan vinst i banken.

Fartkravet (krav 2) tar bort VIRGO (20260710-13h 11:30:36: +2,08 kn netto i 1,4 kn, kurs 63°,
korsade sedan söderut, alltså vänd). Kurssidan (krav 5) tar bort ett transitpar: 265800960 i
20260702-2h, som cirklade i kön vid Järnvägsbron med kurs 242° och sedan fortsatte norrut.
Hon får målbro som förut, när kursen blir entydig. I banken ligger kursen för alla
transitpar som kraven släpper igenom nära bandkanten mot färdriktningen: 45,1–51,1° österut
och 225,1–261,7° västerut. Dödbandets sida följer alltså färdriktningen i fältet.

## 5. F18-principen och motexemplen

Riktningen kommer ur en MÄTT förflyttning mellan två observerade positioner (posten
`_onVesselRemoved` skrev och återfödelsens fix), med `_rebirthNorthBase`:s ålders- och
fartspärr. Det är samma positionsbevis som svepets lås redan vilar på (FP8 kallar det
"ingen gissning"). En båt med kurs i banden får målbro utan förflyttningsbevis alls; här
krävs mer. Kanalen går 22–36° mellan broarna, så 2 kn i nordled är minst 2 kn längs farleden.

Kraven stoppar de konstruerade varianterna nedan. De stoppar INTE varje närliggande fall;
se residualen efter tabellen.

| Konstruerad variant (test i steg 3/4) | Stoppas av |
|---|---|
| sidodrift tvärs farleden, 2,3 kn, kurs 120° (konstruerat) | krav 4: −0,21 m/s; sidledes begränsar kanalens bredd |
| GPS-hopp 900 m på 130 s (konstruerat) | `_rebirthNorthBase`: över fysikens 669 m, ingen K1 |
| GPS-hopp 300 m på 180 s men 0,3 kn (konstruerat) | krav 2 |
| kaj i Gästhamnen, 20 m vobbel, fartspik 2,6 kn (konstruerat) | krav 4 |
| återkomst till belagd kajplats i Gästhamnen i 2,5 kn, kurs 80°, +1,25 m/s (konstruerat) | kajgrinden med M3:s målbro (§2 punkt 3) |
| kajavgång NORDIC SOLA (fältbanken, 41h) | krav 4 (faktor 2,4) |
| vänd under avbrottet: norrut netto, kurs 250° / söderut netto, kurs 70° (konstruerat) | krav 5 |
| gammal eller omlevererad mätning | krav 3 |
| saknad kurs | krav 1 (FP8:s fall vidgas inte) |

**Residualen (granskningen L1, C/rtmp/adv).** Granskaren körde realistiska grannfall genom
hela appen på c14938f och HEAD, var och en med en tvilling som har kurs 25° (nordbandet) vid
återfödelsen. Fyra klasser stoppas inte, men varje klass ger exakt samma utfall som
bandkurstvillingen ger på c14938f:
- **W1, vändning vid återfödelsen:** vändningen pågår genom samma sidas dödband, kurs 100°
  389 m före Klaffbron, och hon ger upp. HEAD ger Klaffbron-varningen 10:02:30 (fix) och 60 s
  måltext, som tvillingen. (W1b, 1,8 km ut, ger 60 s måltext; armen avväpnas före deadline.)
- **W2 och W3, första ankomst till Kajen eller Gästhamnen utan kajhistorik:** kurs 70° och
  95°. Stridsbergsbron-varning 10:07:33 respektive 10:08:00 och cirka 6 min falsk måltext, som
  tvillingen. Med kajhistorik håller kajgrinden (steg 3 och granskarens prob för Kajen).
- **W4, GPS-hopp med fartspik åt kursens sida:** 300 m norrut i 2,4 kn med kurs 70° från en
  kaj norr om infartspunkten. Klaffbron-varning och 9 min falsk måltext, som tvillingen. Ett
  fysikaliskt möjligt hopp kan inte skiljas från rörelse av någon positionsmetod, och samma
  båt med kurs i banden får målbro utan förflyttningsprov.
- **W5, V8:** se nästa punkt.

Kostnaden är alltså ett falsklarm i stället för en missad öppning, samma avvägning som
bandkursregeln gör i dag. W1 och W3 är låsta i testets steg 7 ("samma utfall som
tvillingen"), så att en framtida skärpning blir ett medvetet beslut. En zonvakt bara för M3
avråds: farleden går 7–52 m från kajplatserna (FP9-H'), så den återinför missen för äkta
transiter förbi kajerna.

Kvarstående risk:
- Basen saknar fixtid, så K1 mäts på mottagningsklockan (V8:s kända pris, `_rebirthNorthBase`).
  Var basens fix gammal när den levererades blir dt för kort och nordfarten överskattas med
  faktorn 1 + (basens fixålder − återfödelsefixets fixålder) / dt. Fältets fixåldrar (A/B-natten,
  lib/constants.js: median 27,5 s, p90 62,3 s, max 220,9 s) ger vid 120 s högst 1,5 vid p90,
  och då ligger NORDIC SOLA på 1,3 kn, under ribban. Vid nattens max och kortaste normala
  radering blir faktorn 2,8; en båt i hennes klass hade då passerat, men bara om hon också
  rapporterar ≥ 2 kn och kursens sida stämmer, alltså en båt som faktiskt gör väg åt det
  hållet. Felet ger en tidig målbro i rätt riktning, inte en målbro bakom båten: tecknet följer
  två verkliga positioner i fixtidsordning (F6 och F4b avvisar en äldre AISHub-fix), så bara
  storleken kan bli fel. Granskarens W5 (AISHub-basfix 200 s gammal, sann nordfart 0,45 m/s)
  ger K1 1,142 m/s, Klaffbron-mål och 9 min falsk måltext, som tvillingen; leveransläget
  aisstream berörs inte. I banken finns inget sådant fall: mätsonden hittar bara två
  återfödelser med dödbandskurs och färsk K1, NORDIC SOLA och SY FREYJA (FACIT.md). Det är en
  känd gräns (ARCHITECTURE, M3 (d)); förslaget till en senare runda står i §10.

## 6. Ordningen mot app-lagrets ruttlås

Ny ordning i återfödelsens tick: VDS sätter låset och målbron → `_observeBridgeOpening`
beväpnar → svepet. Svepet låser bara när `_routeDirection` saknas (app.js:8683), så det låser
inte en gång till. Låser svepet alls, låser det samma riktning. Saknar svepets fönster
kandidatbroar returnerar det före låset (app.js:8634, `passedBridgeEntries.length === 0`), som
för PELLE i värld 977 och för W1; då är M3:s lås det enda, och det släpps när ingen målbro
blir. De två källorna kan alltså aldrig säga emot varandra:
- samma bas (posten i `app._lastKnownPositions`), samma tecken på Δlat;
- 2 kn över minst 65 s ger ≥ 67 m; vid ≥ 100 m har svepet `rebornEvidence` och samma riktning,
  under 100 m avstår svepets portgissning helt vid dödbandskurs (ingen riktning);
- krav 5 släpper bara igenom kombinationer där R1/F15:s release inte hade släppt svepets lås
  (östra dödbandet ger ingen levande riktning i `_dedupDirection`, västra ger söderut).
Testet i steg 5 kör FREJA:s två fixar genom hela appen: lås och målbro i VDS, arm i samma tick,
`SKIPPED_BRIDGES_CHECK … direction=south` loggas men varken `…_DIRECTION_LOCK` eller
`…_LOCK_RELEASED`, och svepets Stallbackabron-notis bär 'south'.

## 7. Övervägda alternativ

- **Skissen som den var.** Dess bandkontroll (`isSouthCogStrict`/`isNorthCog` för motsatt
  riktning) kan aldrig slå till för en dödbandskurs, så en båt som vänt (norrut netto, kurs
  250°) hade fått en nordlig målbro, i strid mot R1/F15. Den släppte också igenom saknad kurs.
- **Flytta svepets lås före `_observeBridgeOpening` i app.js.** Ändrar ordningen i ENTERED-
  vägen för alla återfödda båtar (notistokens, svepets notiser), och räcker ändå inte, eftersom
  `_calculateTargetBridge` inte följer låset vid dödbandskurs.
- **Låt `_calculateTargetBridge` följa varje lås vid dödbandskurs.** Ett lås från tidigare i
  resan kan vara inaktuellt efter en vändning: gissad målbro, F18-brott.
- **Även kontinuerligt spårade båtar (ACCELERATED-grenen, K1 mot förra fixet).** Utanför
  uppdraget, inget fynd. Öppen fråga (§10).
- **Explicit förflyttningsgolv (100 m).** Överflödigt med dagens raderingstider (≥ 67 m >
  `MOVEMENT_PROOF_NET_M`), och svepets 100 m är en lokal konstant i app.js som annars får en
  andra kopia.

## 8. Samspelet med andra familjer

- **A (samma fil, VDS).** Jag rör bara ny-båtsgrenen (VDS:503–572), en ny metod efter
  `_rebirthNorthBase`, kajgrindens signatur och målbroval (en valfri parameter) och en loggrad
  i `_calculateTargetBridge`. A:s `assignTargetAfterReversal` anropar
  `_calculateTargetBridge(vessel, dir)` och får samma, nu sanna, loggrad. Ingen ändring i
  målbrokedjan efter vändningar eller i NEW_JOURNEY. Textkonflikt bara om A ändrar just de
  raderna.
- **B och D (BridgeOpeningService).** Inget berörs; armen skapas av befintliga
  `_observeBridgeOpening`.
- **Integrationen (granskningen L6).** Textkonflikter med A, inga semantiska: VALIDATION.md
  (A 74 → 77, C 74 → 76, sammanslaget 79), slutet av SCENARIOS i runSyntheticScenarios.js,
  dokblocket och `push` i scenarioGenerator.js och A:s nya rader direkt före ny-båtsgrenen i
  VDS. Antalet scenarier sätter dirigenten vid integrationen.
- **E (motorn).** 977 är M10 (MÄTGRÄNS) i triagen och försvinner här på köpet, eftersom PELLE
  nu beväpnas 07:22:35 på en långsam prognos (1,2 % över ribban, se §10). Registerposten
  MÄTGRÄNS-U2-FÖNSTERKANT behövs fortfarande för 510.

## 9. Besluten

- **U13:** inget låst facit flyttas (FACIT.md); banken är bitlik mot c14938f.
- **U17, C-IV, D1:** täckning, konvoj och kajregeln rörs inte. Kajgrinden för ny målbro
  (CARAT, inte D1:s kvarstående båt) ändrar inte beteende för befintliga anrop; den prövas
  bara också mot M3:s målbro.
- **U18:** ingen vändning tros här; beviset bygger ändå på två positioner.
- **U22:** ETA-kedjan rörs inte. NORDIC SOLA:s ETA-rader i 41h skyddas av 2 kn-kravet.
- **F18 och BN2** (dirigentens JA på R2:s fråga 1): K1 får avgöra riktningen mellan banden;
  K1 själv är oförändrad. Här krävs dessutom transitfart och kursens sida.

## 10. Dokument och öppna frågor

Uppdaterade: docs/ARCHITECTURE.md (§Target-livscykeln M3, svepets lås, K1:s tredje läsare),
docs/VALIDATION.md (76 scenarier och M3-stycket), kommentarerna i VDS och app.js.

Öppna frågor till granskningen:
1. **977 ligger på en knivsegg:** PELLE:s 1,041 m/s är 1,2 % över ribban (1,0288). Fyndet är M10
   och försvinner bara på köpet.
2. **Saknad kurs** (FP8) omfattas inte. En återfödd båt utan kurs får målbro först på nästa fix.
   Inget fall i banken eller hos buggjägaren.
3. **Kontinuerligt spårade båtar** med kurs i dödbandet får som förut målbro först när kursen
   lämnar bandet (PELLE 07:23–07:24).
4. **54 % av bankens dödbandstransiter** (sog ≥ 2) ligger under 2 kn netto och omfattas inte.
5. **V8 är en känd gräns** (§5). Förslag till en senare runda: låt `app.js:_onVesselRemoved`
   spara `fixTs` och `fixFeed` i posten i `_lastKnownPositions` och `_rebirthNorthBase` föra
   dem vidare, så att `fixDtMs` (samma källa) mäter på fixklockan. K1:s Kanalinfartsregel
   vinner på samma sak. Det ändrar postens format och persistensen, så det hör inte hit.
6. **Kajgrinden i ACCELERATED-grenen** är stum vid dödbandskurs med positionsbevisad riktning
   (§2 punkt 3, granskningen L4). Felet fanns redan på c14938f. Förslag: skicka
   positionsriktningens målbro till `_slowInitialQuayApproachNeedsProof` även där, i samma
   runda som familj A:s målbrokedja efter vändningar.

## 11. Mätningar (slutcommiten `19b3bfa`)

- **Batteriet** (`S/port/battery.sh`, C/batt/status): jest 0 (370 sviter, 5288 test gröna, 2 hoppade),
  lint 0, replay-all 0, replay-all-mon 0, synth 0 (76 scenarier), openings 0 (loggen identisk med
  c14938f-kopians), soak 0, soak-mon 0, phase 0, phase-mon 0, hunt-selftest 0, hunt-quick 0.
  Porcelain visar bara `?? node_modules`. Prototypen `f62aea8` var grön t.o.m. fassvepet
  (C/batt-f62aea8-avbrutet); jag avbröt den efter fassvepet, när revision 1 behövdes.
- **Bitlikhet mot c14938f:** 26 av 26 korpusar, med och utan monitoring (FACIT.md).
- **hunt --repro** (C/matningar/repro-alla-19b3bfa.tsv): BORTA för 756 (V/tA/fynd/F05 och kortet),
  1913 och 977. Övriga 22 tA-kort och -fynd är KVAR, som på c14938f (TRIAGE-A). De 26 tB-korten
  ger samma utfall som på c14938f (`*.bas.txt`, och C/matningar/repro-tB-c14938f.tsv för kajA,
  kajB, w138 och r0-*).
- **quick mot V/bas/quick** (C/matningar/quick-jmf.txt): samma fyra kandidatkluster, inga nya
  kluster eller utslag. Två världar påverkas:
  - **217:** DESIGN-klustret `U17-TYST-BÅT-RECOVER|T3|VARNING-PÅ-FRUSET-FIX` försvinner (25 → 24
    kluster, 58 → 57 utslag). PELLE 2 (265250189, kurs 67,2°, +1,489 m/s) beväpnas nu på
    återfödelsen 13:31:27 och blir medlem i Klaffbron#17 (13:32:08, deadline), ~10 min före sin
    korsning 13:42:02. På c14938f absorberades hon först 13:33:00, släpptes vid täckningsslutet och
    fick en egen varning Klaffbron#22 13:55:11 på ett 22 min gammalt fix, 13 min EFTER korsningen.
    Det är rättare.
  - **235:** samma KANDIDAT-utslag (INV-3 ETA-OSCILLATION, Stridsbergsbron 07:12:00), men talen blir
    4→10→4 i stället för 4→9→3, och ETA:n blir cirka 1 min sämre mot sanningen (granskningen
    L3). Båten 265175825 (kurs 249,4°, −2,902 m/s) får målbro vid återfödelsen 07:03:22 i stället
    för 07:06:34, så EMA-utjämningen (`ETA_SMOOTHING`) startar tidigare: 07:04:35 och 07:06:34
    i stället för först efter 07:06:34. Hon korsar Stridsbergsbron 07:15:11 (L0):
    - 07:06:34: c14938f ger 8,8 min (rå, utan historik), HEAD 9,8 min (rå 8,9, utjämnad 10,4
      och sedan 9,8 i dubbelkörningen K6); sant 8,6 min;
    - 07:12:00: c14938f "cirka 3", HEAD "cirka 4"; sant 3,2 min.
    Varningar, notiser och passager är oförändrade. ETA-koden är orörd (U22), och
    oscillationen fanns redan på c14938f. Felet hör till ETA-kedjans EMA och lämnas till
    ETA-rundan.
