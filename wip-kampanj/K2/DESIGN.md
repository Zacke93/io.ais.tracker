# K2 — konvojens medlemskap (B02 och F09), revision 3

Prototyp: commit `afce797` i `K2/wt` (detached; `d7a8022` är revisionens
kodändring och `afce797` en kommentarsrättning, ovanpå `5e273df`, `ac7a460`
och bas 7699cbe). Patch: `K2/patch.diff`. Facit: `K2/FACIT.md`.
Motorkörning: `K2/hunt-quick/`. Mätunderlag: `K2/tmp/rev4/` (skript i
`scripts/`, loggar i `final/`). Granskarens sonder: `K2/tmp/omg1/probes/`.

## Kort sagt

Båda felen gäller samma fråga: täcks en båt redan av en annan varning, eller
ska hon få en egen?

1. **B02 (U15), returresan.** En båt som passerar en bro, vänder och kommer
   tillbaka fick ingen varning för returen, eftersom appen räknade returen
   till öppningen hon redan passerat. **Regel:** ingen händelse vars öppning
   ligger inom ett konvojfönster från hennes passage får täcka returen.
   Passagen sparas i ett eget returminne, oberoende av händelsestädningen.
   Returen får sin egen varning även när ankomsten är närmare än 60 s
   (dirigentens beslut 2026-11-05: U15 utan golvundantag).
2. **F09, kön vid en tidigare bro.** Om en båt som stod i kö när en annan
   båts varning gick ut släpps ur den varningen avgörs av hennes egna fix,
   aldrig av tickens fas. Oförändrat sedan revision 2.

Revision 3 åtgärdar omgranskningens punkter:
- **medel:** returen kändes bara igen medan hennes egen gamla händelse levde.
  Nu finns ett returminne, och granskarens sond ger 0 av 30 faser utan egen
  varning vid alla tidpunkter (förut 2–30 av 30 från 732 s);
- **låg:** villkor (b) jämför händelsens öppning, inte varningens tid, med
  hennes passage;
- **låg:** de två ändrade syntetscenarierna är redovisade och låsta med
  `openingBeforeEachPassage`;
- **låg:** AKIRA-raden i FACIT anger fönstren;
- **låg:** samspelet mellan F09:s villkor (2)/(3) och konvojticken är
  beskrivet och föreslaget som registerpost;
- **låg:** golvfrågan är avgjord av dirigenten.

Ingen låst facit flyttas, och banken är identisk med revision 2 (samma tre
olåsta tidsbyten som där). Golvbeslutet ger en ny returvarning i elva av
buggjägarens världar (tolv instanser, eftersom värld 227 finns både i
standard och quick): tio före returkorsningen och en (värld 227) 10 s efter
den. Inget fall ger dubbla varningar för samma öppning (§6).

## 0. Utgångsläge

Worktreen var ren vid start (`git status`: bara de otrackade `node_modules`
och `bugHunt/`). Det fanns inget avbrutet försök att ta ställning till.

## 1. Rotorsaken

### B02 — returresan (värld 1273, R0)

Oförändrad. Minsta repro
`S/hunt-fix/runs/r1-standard-a/fynd/B02-…/repro.jsonl`, verbose mot 7699cbe:

```
08:24:49  Stridsbergsbron#3 avfyras, ledande VEGA, norrut
08:27:05  [OPENING_DISARM] 265441711 (VEGA): avväpnad — passage
08:32:35  [OPENING_ARM] VEGA d=724 m dir=south "deadline om -93 s"
08:32:35  VEGA absorberad av öppning Stridsbergsbron#3 (konvoj, täckt t.o.m. 08:37:05)
L0:       VEGA korsar söderut 08:35:55 utan egen varning
```

Kedjan: `_evaluateBridge` steg 2 behåller den avfyrade och passerade
händelsen i 600 s, `_bindLooseArms` väljer värd utan undantag för båten som
själv passerat, och `_belongsToEvent` jämför returprognosen med
`referenceArrivalMs`, som `_recordPassage` satt till hennes egen passage.

### B02 — returminnet i revision 2 (omgranskningens medel)

Bekräftat med granskarens sond `K2/tmp/omg1/probes/b02-936-kant.js` mot
`5e273df`. X passerar norrut 130 s. Y:s händelse varnar 287 s, och Y korsar
söderut 630 s, 500 s efter X. X:s returarm skapas `armS` sekunder in, 300 s
före returkorsningen.

| armS | 5e273df: retur utan egen varning | d7a8022 |
|---|---|---|
| ≤ 728 s | 0 av 30 faser | 0 av 30 |
| 732 s | 2 av 30 | 0 av 30 |
| 745 s | 15 av 30 | 0 av 30 |
| 758 s | 28 av 30 | 0 av 30 |
| 762–1200 s | 30 av 30 | 0 av 30 |

Mekanismen: `_ownPassageAt` läste `passedMmsis` i händelselistan innan steg 2
hade städat den. X:s händelse lever till max(firedAt, lastPassageAt) + 600 s
= 730 s och städas vid nästa utvärdering, oftast en tick senare. Därefter
absorberades returen i Y:s händelse, vars öppning hon redan passerat.

### F09 — fasberoendet i 20260710-13h

Oförändrat sedan revision 2. I 7699cbe släppte `_bindLooseArms` alla
avfyrade händelser vid varje utvärdering medan armen var spärrad av en
tidigare bro. En tick mellan PILOT 761:s avfyrning 05:44:09 och VIRGOs fix
05:44:17 gav VIRGO en egen varning för samma öppning (rådata: båda korsade
Klaffbron norrut, 05:48:59 och 05:50:20). Revision 2 stängde också två
fasberoenden som fanns redan i 7699cbe: villkor (2) mot klockan och samma
millisekund i villkor (1).

## 2. Rättningen på kodnivå

Allt i `lib/services/BridgeOpeningService.js`.

### B02 / U15 (ändrat i revision 3)

- **Returminnet** `this._passageMemory`: armKey (`mmsi::Bro`) → `{ at,
  eventId }` för båtens senaste bokförda passage.
  - Skrivs i `_recordPassage` för varje båt med arm, även när armen saknar
    händelse (`eventId === null`), och före kontrollen av händelsen.
  - En armlös passage bokförs inte, som i resten av öppningslagret (app.js
    `_observeBridgeOpening`, J14: medlemskravet är ett val).
  - `passedMmsis` på händelsen är borttaget; `eventId` i minnet ersätter det.
- **`_ownPassage(arm)`** läser minnet. `_arm` sparar svaret som
  `arm.returnAfterPassage`; satt betyder att armen är en returresa.
- **`_prunePassageMemory(bridgeName, events, now)`** anropas i
  `_evaluateBridge` direkt efter steg 2 (städningen). En post lever:
  - minst `CONVOY_WINDOW_MS` efter passagen, eftersom en annan händelse kan
    få sin första passage inom fönstret;
  - därefter så länge någon levande händelse beskriver hennes passerade
    öppning. Den mängden kan bara krympa efter fönstret.
  Minnet töms i `destroy()`.
- **`_describesPassedOpening(event, passage)`** prövar bara avfyrade
  händelser (bara de kan absorbera; en oavfyrad händelse hon går med i varnar
  för henne som medlem). Sant om:
  - (a) hon passerade själv i händelsen (`passage.eventId`);
  - (b) händelsens referensankomst ligger inom `CONVOY_WINDOW_MS` från hennes
    passage. Referensen är den första verkliga passagen när den finns, annars
    prognosen när varningen gick ut (`_fire`). Det är dig9:s definition av
    samma öppning, och samma mått som `_belongsToEvent`;
  - (c) referensen saknas och varningen gick vid eller före hennes passage.
  En varning för en SENARE öppning (referensen mer än 600 s från hennes
  passage) täcker returen oavsett när den gick ut.
- **`_releaseReturnCoverage(arm, events)`** anropas för varje arm i
  `_bindLooseArms`, före värdvalet. Det lägger de beskrivande händelserna i
  `releasedFrom` och släpper en absorption i en sådan händelse. **Inget
  ledtidsgolv**; `returnFloorLogged` är borttaget.

### F09 (oförändrat sedan revision 2)

- `_refreshArm` → `_noteHoldEnd(arm, now)` före det nya fixet: gällde förra
  spärren vid fixet sätts `heldThroughMs = fixtid`, annars
  `silentHoldEndMs = earlierBridgeUntilMs`. Visar fixet henne hållen bokförs
  `heldSeenOrder = ++_orderSeq`. `_fire` bokför `firedOrder = ++_orderSeq`.
- `_releaseWarningsWhileHeld(arm, events, keep, now)` släpper varningen W
  (utom konvojvärden `keep`) när (1) ett eget fix bearbetat efter W visade
  henne hållen, (2) `W.firedAt + TICK_INTERVAL_MS < heldThroughMs`, eller
  (3) `W.firedAt < _silentHoldEnd(arm, now)`.
- `_bindLooseArms`: i spärrgrenen väljs värd bara bland konvojvärden och
  oavfyrade, opasserade händelser; `wideHost` bara konvojvärden. Det är
  samma värdmängd som i 7699cbe.
- Konvojundantaget (`_sharesMovingConvoy`, `keepMovingConvoy`) är
  oförändrat från 7699cbe.

Inga nya konstanter.

## 3. Omgranskningens punkter

| # | Allvar | Punkt | Åtgärd | Belägg |
|---|---|---|---|---|
| 1 | medel | B02: returen känns bara igen medan hennes egen händelse lever | returminnet `_passageMemory`, bokfört även utan händelse och städat först när ingen levande händelse beskriver öppningen | Sonden `b02-936-kant`: 0 av 30 faser vid armS 700–1200 s (5e273df: upp till 30 av 30). `b02-936-sen`: egen varning i alla faser (5e273df: ingen). `b02-936-stadfas`: egen varning i alla 9 faser (5e273df: miss i fas 12 s). Nya test: deterministiskt (armS 780 s), kanten 732/745/758 s i alla 30 faser, bokföring utan händelse, städningen. Alla röda på 5e273df |
| 2 | låg | konvojticken mot (2)/(3), överlämningen saknar mottagare | beskrivet i ARCHITECTURE och §10; registerpost föreslagen (§11) | `fasfuzz` på d7a8022: 34/29/25 fasberoende scenarier per 3000 (seed 11/12/13), samma som 5e273df; missar vid passage 2/0/4, samma scenarier. Scenario 62 (seed 11): absorberad vid fas 3,3–15,5 s, egen varning vid övriga |
| 3 | låg | (b) bredare än sin motivering | (b) jämför händelsens referensankomst med hennes passage | Sonden `b02-senare-oppning`: två varningar, A absorberad i B:s #1 (som 7699cbe; 5e273df gav tre). `b02-stadfas`: två varningar i alla 8 faser (5e273df: två eller tre). Test "villkor (b): en varning före/efter hennes passage för en senare öppning täcker returen" (före: rött på 5e273df) |
| 4 | låg | AKIRA-raden anger inferrerade korsningar som exakta | FACIT anger båda fönstren; "rättare" bara på O1b-fönstret | gt-passages 20260707-14h: AKIRA 08:13:39.974–08:37:10.640 (1411 s glapp), GRETA 08:08:07.749–08:26:33.556 (1106 s) |
| 5 | låg | två syntetscenarier ändras utan att redovisas | redovisade i FACIT; `openingBeforeEachPassage: ['Klaffbron']` på båda | 7699cbe med kontrollen: båda röda (returerna 06:30:00 och 06:27:00), liksom B02-scenariot; inga andra (`tmp/rev4/synth-base-skarpt.log`) |
| 6 | låg | golvfrågan obesvarad | avgjord av dirigenten: inget golv | §6 och FACIT, golvtabellen |

Testfilen `tests/opening-returresa-och-fasoberoende.test.js` har 69 test, alla
gröna. På 7699cbe är 36 röda och på 5e273df 9 (`tmp/rev4/jest-basetest.failed`,
`jest-r5e.failed`). De nio röda på 5e273df är nya i revisionen: två
golvtest, sex för returminnet (ett av dem prövar städningen direkt) och
"villkor (b) före".

## 4. Övervägda alternativ

### Nytt i revision 3

| Alternativ | Varför inte |
|---|---|
| Stämpla hennes mmsi i `passedMmsis` på de andra händelserna för samma öppning (granskarens andra förslag) | Kräver stämpling på två ställen: vid hennes passage, och när en annan händelse senare får sin första passage inom fönstret. Det minns ändå inte en passage utan händelse. Ett minne per båt och bro gör samma sak på ett ställe |
| Minnet lever så länge hennes egen händelse lever | Det var felet |
| Minnet lever ett fast fönster (t.ex. 2 × `CONVOY_WINDOW_MS`) | En händelse som beskriver öppningen kan leva längre med medlemmar kvar. Städningen mot levande händelser är exakt och lika billig |
| Bokför också armlösa passager (notePassage utan arm) | Öppningslagret bokför inte armlösa passager någon annanstans (J14). Dessutom kommer samma fysiska passage ofta två gånger i samma meddelande: observeVessel steg 1 bokför den och avväpnar armen, och notePassage anropas sedan utan arm (app.js `_observeBridgeOpening`). Utan arm går den andra inte att skilja från en ny passage |
| (b) som i revision 2, med dokumentation och test (granskarens andra väg) | Utfallet hänger på om en annan båts varning gick 15 s före eller efter hennes passage. Referensankomsten är samma mått som resten av konvojlogiken |
| (b) bara på referensankomsten, även för oavfyrade händelser | En oavfyrad händelse varnar för henne som medlem när den går. Att spärra den hade gett henne en egen händelse bredvid, alltså två varningar för samma lyft (resonemang, inte mätt; revision 2 spärrade inte heller oavfyrade händelser) |
| Behåll golvet | Dirigentens beslut 2026-11-05: U15 gäller utan golvundantag |

### Från revision 2 (konvojundantaget vid tick, F09)

| Alternativ | Varför inte |
|---|---|
| Konvojen avgörs när varningen går ut | Värld 276 (R1): tre nya instanser; JOLLY korsade utan förvarning |
| Konvojen avgörs vid hennes nästa fix | 20260702-19h ZWERK fick en andra varning för samma öppning (U2) |
| Som ovan, plus konvojbeviset vid tystnad | Tio låsta test i `opening-shared-queue-convoy.test.js` (LIV/JOHANNA) röda |
| F09: kräv alltid ett eget fix efter varningen | Låst facit i 41h och 17h flyttat, O1 röd i 41h |
| F09: utan tystnadsvillkoret (3) | Nya T3-utslag i quick-värld 2 och 143 |

## 5. Samspel med andra familjer

### K (samma fil)

Provsammanslagning med `git merge-file` (bas 7699cbe) mot K:s HEAD `7b520c2`
och mot K:s arbetskopia (`K2/tmp/rev4/merge`). Två konflikter i
servicen och en i ARCHITECTURE:

1. **`_recordPassage`.** K inför `crossedAtMs` och `const crossedAt` efter
   kontrollen av händelsen; K2 skriver returminnet före den. Lösning
   (`K2/tmp/rev4/scripts/resolve-kk2.py`):
   ```js
   _recordPassage(bridgeName, arm, now, crossedAtMs = null) {
     if (!arm) return;
     const crossedAt = Number.isFinite(crossedAtMs) && crossedAtMs <= now ? crossedAtMs : now;
     const event = arm.eventId === null ? null : this._eventsAt(bridgeName).find(…) || null;
     this._passageMemory.set(arm.key, { at: crossedAt, registeredAt: now, eventId: event ? event.id : null });
     if (!event) return;
     …
   ```
   Villkor (b) jämför då K:s `firstPassageAt` (korsningstid) med hennes
   korsningstid. Reservvillkoret (c) och städningens minimifönster använder
   `registeredAt`, det försiktiga hållet.
2. **`wideHost`/`floorHost`.** Behåll båda. K:s golv gäller inte en hållen
   arm: `const floorHost = host || wideHost || blocked ? null : this._anchorFloorHost(…)`.
3. **ARCHITECTURE §bridge_opening_soon.** K:s omskrivna RECOVER-punkt står
   före K2:s två punkter. Behåll båda.

I den sammanslagna kopian `K2/tmp/rev4/kk2` är K2:s, K:s och
schemaläggningens testfiler gröna (113 av 113). `hunt.js --repro`
(`tmp/rev4/kk2-repro.txt`): B02, F01, F03, F09, F14 och F20 BORTA.

**Konflikten med K:s korsningsankargolv (värld 227).** K:s
`_anchorFloorHost` tog bort T3-utslaget i värld 227 genom att absorbera ZELDA
i hennes egen gamla händelse `#1` när ankomsten låg under 60 s. Med U15 utan
golv lägger K2 först `#1` i hennes `releasedFrom`, och K:s golv kräver att hon
inte är släppt. I K+K2 är F14-kortet BORTA, men T3-utslaget (varning 10 s
efter korsningen) kommer tillbaka som KANDIDAT. Det följer av dirigentens
beslut och kan inte stängas i konvojlagret (§6). K:s DESIGN §5 ("K:s och
K2:s golv har samma villkor och samma utfall") gäller inte längre: K2 har
inget golv.

Övriga överlapp är textuella. Mina rader i `_refreshArm` står kvar på sina
platser: `_noteHoldEnd` före `lastSeenAt = now`, och `heldSeenOrder` efter
spärren. K:s DESIGN hänvisar fortfarande till revision 1:s funktionsnamn
(`_releaseEventsBeforeOwnPassage`); de gällande är `_releaseReturnCoverage`,
`_describesPassedOpening` och `_releaseWarningsWhileHeld`.

K2:s tre olåsta facitrader (13h PILOT, 17h CARAT, 0525 JOSEPHINE) går via
RECOVER-släppet. Kör efter integrationen `K2/tmp/rev3/scripts/cmpall.js` och
fassvepet med tid (`K2/tmp/scripts/banksweep2.js <ut> -15..14 <träd>`).

**Överlämning av konvojticken.** Restklassen (§10, punkt 1) hör ihop med K:s
omprövning av medlemskapet mot en färsk prognos (F22/F02), men K:s plan
nämner den inte. Jag föreslår att dirigenten ger den en ägare genom en
KÄND_ÖPPEN-post i motorn (§11) med sonderna `f09-konvojtick` och `fasfuzz`
som underlag.

### R1 (riktning och vändning)

R1 avgör när returen får en målbro och därmed en arm. U18 behåller Fix D:s
krav på två positioner. Returer som upptäcks sent får därför varningen sent:
utan golvet kommer den kort före korsningen (936: 46 s, 1918: 9 s) eller
efter den (227: 10 s). De tre KVAR-världarna i U2-RETURRESA (1208, 1316,
1317) saknar returarm före korsningen. K2 rör inte riktningslogiken.

### N (U14)

Samma princip i notislagret: returen får både notis (N) och öppningsvarning
(K2). Inga delade funktioner. U21 rör bara notiser.

### R2, M, E, E2

Inga delade funktioner. E:s och E2:s ETA-ändringar flyttar `expectedArrivalMs`,
och därmed referensankomsten i villkor (b). Mät om efter integrationen.

## 6. Användarbesluten och dirigentens beslut

- **U13:** ingen låst facit flyttas (replay:all exit 0, O1 376/378). Tre
  tidsbyten i olåsta dimensioner, bedömda som likvärdiga mot rådata
  (FACIT.md). Banken är identisk med revision 2.
- **U14:** rörs inte (familj N).
- **U15, med dirigentens beslut 2026-11-05 (60 s-golvet):** genomförd utan
  golvundantag. En returresa får egen varning även när ankomsten ligger
  närmare än 2 × `TICK_INTERVAL_MS`. Returminnet är frikopplat från
  händelsestädningen, som granskaren föreslog. INV-21:s returresa är
  kontraktet.
  - **Dubbla varningar för samma öppning:** inga belagda. Jag prövade alla
    tolv golvfall i buggjägarens körningar (fyra i standard, åtta i quick,
    elva världar; FACIT, golvtabellen). I varje fall gäller den nya varningen returens egen
    korsning. Ingen annan båt korsar i returens lyft med en egen varning; i
    värld 289 går den andra båten i stället in i returens varning, så antalet
    varningar är oförändrat. Returen ligger alltid inom 600 s från hennes
    utresa, alltså i samma dig9-kluster, men det fallet beslutar U15
    uttryckligen.
  - **Konflikt som inte gäller dubbla varningar:** i värld 227 upptäcks
    returen 9 s efter den verkliga korsningen (U18). Utan golv kommer
    varningen 10 s efter korsningen, och motorn ger ett T3-utslag
    (KANDIDAT). Öppningen var missad även med golvet. U15 ändras inte;
    utslaget är föreslaget som registerpost med källa U18 och dirigentens
    beslut (§11).
- **U16:** rörs inte.
- **U17:** RECOVER-släppets säkerhetsvarning för en tyst båt behålls. K2:s
  tre olåsta facitrader bygger på den.
- **U18:** sena returer med gles AIS är en känd gräns; utan golvet syns de som
  korta ledtider eller sena varningar (§5, R1).
- **U19, U20, U21:** rör inte K2.
- **Dirigentens beslut för R2:s frågor:** rör inte K2.
- **U2 och a8d7b76 (AKIRA-regeln):** behålls. `quay-departure-continuation`
  och `opening-confirmed-waiting-eta` är gröna.
- **Produktprincipen** (en missad öppning är värre än ett falsklarm): B02 och
  golvbeslutet lägger till varningar för returer; F09 behåller
  reservvarningen vid radiotystnad i kön.

## 7. Mätningar (K2/wt, commit `d7a8022`; `afce797` ändrar bara en kommentar)

| Körning | Utfall |
|---|---|
| `npm test` | 4844 godkända, 2 hoppade, 1 röd: motorns otrackade kopia `bugHunt/__tests__/b-register.test.js` ("källfilen docs/BUGGJAKT.md finns inte"), lika röd på 7699cbe och inte en del av appen |
| K2:s testfil | 69/69 gröna; 7699cbe 36 röda, 5e273df 9 röda |
| `npm run replay:all` | exit 0, alla 24 låsta korpusar matchar facit |
| alla 24 korpusar mot 7699cbe vid δ = 0 (`rev4/cmpall-base.log`) | notiser, målbropassager och brotexter identiska i alla; öppningsvarningar identiska i 21; samma tre tidsbyten som revision 2 |
| `npm run replay:synthetic` | exit 0, 47 scenarier rena. Tre B02-scenarier med `openingBeforeEachPassage`, alla röda på 7699cbe |
| `npm run replay:openings` | exit 0, O1 376/378, samma utskrift som revision 2 |
| `npm run replay:monitoring` | exit 0, 72 h stabil; identisk med 7699cbe utom heap och tider |
| `npm run replay:phase` | exit 0, 24 korpusar, inget odokumenterat fasberoende |
| `REPLAY_MONITORING=1 runPhaseSweep.js` för 13h, 17h, 0525 och 2h | exit 0 för alla fyra |
| fassvep med tid, 13h, δ −15…+29 s och −11,52 s | 0 av 45 faser avviker (7699cbe 15 av 45) |
| fassvep med tid, hela banken, 24 korpusar × δ −15…+14 s | 0 av 696 (korpus, fas)-par; 0 ändrade notisnycklar (7699cbe 8) |
| `fasfuzz` 3 × 3000 (F09) | 34/29/25 fasberoende scenarier, samma som 5e273df; 0/0/0 utan konvojundantaget |
| `npm run lint` | exit 0 |

## 8. Motorkontroll

- `hunt.js --repro` för alla 25 kort i r1-standard-a (`rev4/reproall.txt`):
  B02 och F09 BORTA, 23 KVAR. Utslagen är identiska med revision 2 utom i två
  golvvärldar: B01:s värld får T2 LEDTID 14 s (ACCEPTERAD), och F14:s värld
  227 får T3 10 s efter korsningen (KANDIDAT).
- U2-RETURRESA-klustret, 18 världar (`rev4/u2ret.txt`): 15 BORTA (alla nio
  R0, R1 191, 998, 1351, 1590, 936 och 1918) och 3 KVAR (1208, 1316, 1317).
  Revision 2: 13 BORTA och 5 KVAR. Nya utslag: 936 T2 LEDTID 46 s
  (KÄND_ÖPPEN J13-J14) och 1918 T2 LEDTID 10 s (KANDIDAT).
- Quick (`--profile=quick --out=K2/hunt-quick`, självtest grönt, exit 0):
  - mot r1-quick-a: inga nya kandidatkluster (kandidatkort 17 → 16). Borta:
    U2-RETURRESA (w101, w191), M-FAS 13h (quickens F06), T2 OKLASSAD w130 och
    U2-VS-DEADLINE-missen w116. Två nya kluster med registerpost
    (J13-J14 och U2-VS-DEADLINE för T2 LEDTID vid Klaffbron);
  - mot quick för 5e273df: åtta nya instanser, alla golvfall. Sju är T2 LEDTID
    i registrerade klasser (ACCEPTERAD w40, w140, w152, w161; KÄND_ÖPPEN
    w289, w212, w272). En är T3 för w227 i det befintliga F01-klustret
    (KANDIDAT).
- Värld 276 (R1), där en förkastad variant i revision 2 gav tre nya
  instanser: oförändrat BORTA.

## 9. Dokument

Uppdaterade i prototypen:

- `docs/ARCHITECTURE.md` §bridge_opening_soon:
  - punkten om returresan: returminnet och dess livslängd, villkoren (a)–(c)
    mot referensankomsten, inget golv och värld 227;
  - punkten om F09: samspelet mellan (2)/(3) och konvojticken, fuzzens tal
    och scenario 62.
- `docs/VALIDATION.md` §Syntetiska scenarier: `openingBeforeEachPassage` på
  de två u-svängsscenarierna.

Att uppdatera vid integrationen:

- `docs/ARCHITECTURE.md` §H29/H30 "KRAV PÅ ETT NYTT FÖRSÖK": meningen om att
  en båt som anländer efter första passagen plus `CONVOY_WINDOW_MS` är nästa
  öppning men aldrig en andrapåminnelse behöver U15-undantaget för båtens
  egen returresa (K redigerar samma avsnitt).
- `tests/replay-validation/invariants.js`, INV-21-kommentaren: U15 gör
  returresan till kontrakt.
- K:s DESIGN och ARCHITECTURE-text om att K:s och K2:s golv har samma
  utfall (§5).
- Motorns register och BUGGJAKT.md (dirigenten): posterna i §11.

## 10. Risker och kvarvarande gränser

1. **Konvojundantaget vid tick** (fanns i 7699cbe). Det prövas vid första
   utvärderingen efter varningen, så en tick före följarens nästa fix kan
   avgöra på hennes äldre fix. **Samspelet med villkor (2) och (3):** utan
   en sådan tick släpper (2) eller (3) varningen vid hennes fix eller när
   spärren tar slut, och med tick kan konvojundantaget absorbera henne.
   Fasfuzz: 125–151 fasberoende scenarier per 3000 på 7699cbe, 25–34 med
   rättningen, alla via konvojundantaget (0 utan det). 7 av 9000 är
   fasberoende bara med rättningen, till exempel seed 11 scenario 62
   (absorberad vid fas 3,3–15,5 s, egen varning vid övriga faser). Banken:
   0 avvikelser. Föreslagen som KÄND_ÖPPEN-post (§11).
2. **Värld 227-klassen:** en retur som upptäcks efter korsningen får en sen
   varning (T3). Följer av U15 utan golv och U18 (§6).
3. **Korta ledtider för sent upptäckta returer** (936: 46 s, 1918: 9 s och
   sju quick-instanser 8–55 s). Följer av U18; varningen är ändå före
   korsningen.
4. **Samma millisekund i F09:s villkor (1):** utfallet följer ordningen i
   AIS-svepet, aldrig tickens fas. Låst av `opening-confirmed-waiting-eta`.
   Banken har inga sådana rader.
5. **Armlösa passager** bokförs inte i returminnet (som i resten av
   öppningslagret).
6. **K-integrationen:** tidsdomänerna i returminnet (`at` = korsning,
   `registeredAt` = bokföring), K:s golv för hållna armar, och omkörning av
   13h, 17h och 0525 efter K:s RECOVER-grindar (§5). Med K:s sena
   korsningsbokföring (p90 625 s) kan en annan händelses första passage
   bokföras efter att minnet städats. En returarm som redan skapats bär sin
   egen kopia, så det gäller bara en returarm som skapas därefter.
7. **ETA-familjerna** flyttar referensankomsten i villkor (b).

## 11. Registerposter som dirigenten ska lägga in

Se `registryRequests` i svaret. Kort:

1. **U15-RETUR-SEN** (DESIGN, källa dirigentens beslut 2026-11-05 om U15 och
   U18): T2 LEDTID och T3 VARNING-EFTER-SANN-PASSAGE för en båts egen
   returvarning när returen upptäcktes sent.
2. **U2-RETURRESA** stryks som KONFLIKT: U15 har besvarat frågan. De tre
   kvarvarande världarna prövas mot R1:s U18-post.
3. **F09-KONVOJTICK** (KÄND_ÖPPEN, källa K2 DESIGN §10): fasberoendet via
   konvojundantaget vid tick.
