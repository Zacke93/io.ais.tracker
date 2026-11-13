# Familj N — en notis per passage (U14, kort B01), revision 4

Rättningskampanjen 2026-11-04. Kortet är B01 (KONFLIKT INV5-VS-BESÖKSREGEL, 30 världar plus ett
stresskluster). Prototypen ligger i `K/N/wt` (detached ovanpå `7699cbe`) som sex commits:

- `3f793a7`: första prototypen;
- `1b7a193`: omlåsning av tre korpusar med rådatabelagd returnotis;
- `9dc2a15`: revision 2 (positionsbevis, M1/M2, U21 som avbrottsgräns);
- `2a69eb1` och `66a5813`: revision 3 (korsningen fix för fix, U21 mot interpolerad korsning);
- `0be75e5`: revision 4, den här (efter omgranskning 2, se §12).

Patchen är `K/N/patch.diff` (`git diff 7699cbe HEAD`, utan `bugHunt/` och `node_modules`).
`K/N/patch-utan-omlasning.diff` är samma patch utan omlåsningsfilerna. Facit står i `K/N/FACIT.md`.
Motorns quick-körning ligger i `K/N/hunt-quick` (revision 3:s i `K/N/hunt-quick-rev3`, revision 2:s i
`K/N/hunt-quick-rev2`). Mätningarna för revision 4 ligger i `K/N/tmp/batt4/` och `K/N/tmp/r4/`.
S = `/tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad`, K =
S/kampanj. Radnummer utan annan angivelse gäller `7699cbe`.

**Arbetsplatsen vid start.** Worktreen var ren på `66a5813` (bara `node_modules` och `bugHunt`
ospårade). Inga ändringar från ett avbrutet försök fanns.

## Kort och enkelt

**Felet (kortet).** En båt passerar en bro, vänder strax bortom den och passerar tillbaka. Det är två
riktiga passager, men appen gav bara en notis. Appen minns ett *besök* per båt och bro och ger en
notis per besök (besöksregeln 2026-09-07). Ett besök slutar först efter två fixar i rad över 350 m
från bron, så en båt som vänder närmare än så var kvar i samma besök, och returen tystades.

**Rättningen.** Ett besök slutar också när båten *bevisligen* har passerat tillbaka. Då får returen
sin egen notis. Appen följer varje fix efter vändningen och noterar när båten korsar brolinjen från
bortre sidan till ankomstsidan; korsningstiden räknas fram ur de två fixarna på var sin sida.
Notisen skickas när:

1. appen har bokfört bron igen, i en fix där båten inte låg på bortre sidan (eller i en fix strax
   bortom linjen medan hon väntade efter vändningen);
2. korsningen är noterad och båten ligger minst 30 m ut på ankomstsidan, under gång dit (minst
   0,5 kn och kurs mot ankomstsidan), och appens färdriktning har vänt;
3. notisen kommer högst 10 min efter korsningen (U21).

Vid gles AIS räcker en enda fix på ankomstsidan om båten rör sig i nuet (minst 2 kn), eller en fix
på linjen i transitfart (minst 3,13 kn). En båt som bromsar in och stannar vid linjen för att vänta
får ingen extra notis.

**Vad omgranskning 2 hittade.** En väntande båt vars AIS rapporterar 0,5–1 kn och slumpad kurs kunde
vid gles AIS få en falsk "har precis passerat" av bara ±15 m GPS-brus: en enda gles fix över 10 m ut
på ankomstsidan räckte, i vilken fart som helst över 0,5 kn. Vid tät AIS och ±30 m brus räckte två
fixar i rad på ankomstsidan, även när den första låg på linjen och kursen var slumpad.

**Vad revision 4 gör.**

- En gles fix på ankomstsidan räcker bara när båten rör sig i nuet, 2,0 kn. Det är samma gräns som
  appen redan använder för ett korsningsbevis (RE_CROSS) och för att släppa en notisspärr (C2).
- Två fixar i rad räknas bara när båda ligger entydigt på ankomstsidan (över 10 m) och båten var
  under gång dit även i den första.
- Passagelogiken bokför ibland returen redan medan båten väntar strax bortom linjen. Den bokföringen
  sparas nu i stället för att kastas, så den verkliga returen inte missas när passagelogiken inte
  bokför igen.
- Failsafen släpper besöket först när dess egna spärrar är passerade.
- Mätinstrumentet (INV-2) kräver att båten stannar på ankomstsidan efter släppet.

**Resultat.**

- Granskarens P1 (720 banor, gles AIS, 0,6–1 kn): 360 av 360 väntande båtar får en notis, och 360 av
  360 verkliga returer får två, ingen före korsningen. Revision 3: 6 falska, 6 för tidiga och 8
  missade. 7699cbe: alla returer missas.
- Granskarens P2 (24 banor, tät AIS, ±25–30 m): 24 av 24 rätt. Revision 3: 3 med tre notiser.
- Långsamma verkliga returer (120 banor, 0,7–2,0 kn, brus ±5–30 m): 120 av 120 får två notiser.
- Kvar finns brus som går utanför appens brusmodell (±30 m per koordinat, upp till 42 m längs
  kanalaxeln): 5 av 48 och 2 av 48 sådana banor ger ett falskt eller för tidigt släpp (revision 3: 11
  och 13). Ingen av 192 banor med ±20–25 m gör det. Klassen registreras som känd gräns (§13).
- B01 är BORTA. Klustret, banken, soaken, öppningarna och motorns quick-körning är identiska med
  revision 3.

## Omgranskning 2:s punkter och vad jag gjorde

| Allvar | Punkt | Åtgärd | Belägg |
|---|---|---|---|
| medel | En väntande båt i 0,5–1 kn fick en falsk eller för tidig returnotis; vid gles AIS räckte ±15 m brus via `gles-korsning`, vid tät AIS ±30 m via `ankomstsidan-två-fixar` | (A) `gles-korsning` kräver sog ≥ 2,0 kn (`RETURN_SPARSE_MOVING_SOG_KN`, RE_CROSS/C2), utan fart ett segment ≥ 100 m. (B) `ankomstsidan-två-fixar` kräver att båda fixarna ligger entydigt på ankomstsidan och att båten var under gång dit i den förra. (C) Passagelogikens förtida returbokföring i en fix inom 30 m på bortre sidan efter vändningen behålls (`_noteFarSideBooking`). (C) behövs eftersom (A) annars gör 10 av granskarens 360 verkliga returer till missade. Vakter med `stopSog` i 0,6–1 kn, brus 15 m vid 35+10/45+15/60 s och 30 m vid 10 s. | P1 720/720, P2 24/24 (`K/N/tmp/r4/logs/p1-*.r4c.log`, `p2.*.log`). Egen generator: G1 144/144 (revision 3: 142), G2 45/48 (42/48). Tre nya `ge-upp`-vakter fäller revision 3; två fixturer ur granskarens P1-exempel. |
| låg | INV-2:s tidsdom är blind när bruset lägger släppfixen på ankomstsidan | Domen kräver att båten stannar där: minst hälften av fixarna efter släppet (nästa fix och 60 s-fönstret) entydigt på ankomstsidan. Domen ligger nu i `tests/replay-validation/returnReleaseVerdict.js` och har egna enhetstester. | Revision 3:s sex för tidiga släpp i P1-retur döms nu `för tidig` (förut `ankomst`, `K/N/tmp/r4/rev3h`). Ingen verklig retur döms fel i 1 320 banor (`r4c`). |
| låg | Failsafen släppte besöket före sina egna spärrar | Failsafen prövar beviset torrt (`releaseReturnPassage(…, { dryRun: true })`) och släpper besöket först efter `FALLBACK_TRIGGER_TOO_FAR`, `STALE_POSITION`, `STALE` och `LOW_SOG_FAR`. Instrumentet bokför inte torrkörningen. | Apptestet "failsafen släpper inte besöket när dess egna spärrar stoppar notisen" fäller revision 3. |
| låg | Vaktkommentaren påstod att INV-7 kommer "exakt som på 7699cbe" | Rättad i `runSyntheticScenarios.js` och VALIDATION.md: på 7699cbe ger returvakterna INV-5 MISSAD; med N ger de INV-7 SEN eftersom bokföringen ligger före korsningen. | – |

## 1. Rotorsaken, bekräftad med minsta repro och logg

**Minsta repro.** Kortets egen repro: värld 1939 (seed 878719126), R0, `REPLAY_MONITORING=1`, 181
rader, en båt (WILMA 265178387). Den finns byteexakt som
`tests/fixtures/n-b01-wilma-retur-inom-besoket.jsonl` (md5 `328d1fd071b956214409d2c66fe1ee4b`).

**Sanningen (tidslinje.txt).** WILMA korsar Klaffbron söderut 01:56:10. Hon vänder 01:57:56, cirka
162 m söder om bron, och korsar norrut 01:59:54.

**Appen på 7699cbe** (`REPLAY_VERBOSE=1`, `K/N/tmp/b01-base.err`):

| Tid | Händelse |
|---|---|
| 01:53:10 | Notis "WILMA närmar sig Klaffbron, beräknad ankomst om 3 minuter" (söderut, 270 m). `reserve()` öppnar besöket. |
| 01:56:10 | `FINAL_TARGET_PASSAGE_RECORDED` Klaffbron (första passagen). |
| 01:58:40 | `NEW_JOURNEY_PENDING`: vändning mot norr observerad. |
| 01:59:10 | `NEW_JOURNEY` bekräftad. Besöket ligger kvar; ny resa är ingen utfärd. |
| 02:00:10 | Andra målbropassagen bokförs. `holds()` stoppar huvudvägen och `_persistentDedupCheck` failsafen ("already notified for this visit"). |
| 02:05:40 och 02:06:10 | Först nu två fixar över 350 m, så besöket stängs. Då är returen förbi. |

INV-5 fäller: "2 registrerade passager men 1 notis(er)".

**Var i koden (7699cbe).** `TriggerPointVisitTracker.js:12–16` (regeln), `observe` rad 80–140
(utfärd kräver över 350 m i två fixar, rad 129–135; `departedAfterPassage` rad 92–102 likaså),
`app.js:10080` (`holds()` i huvudvägen) och `app.js:1100` (`_persistentDedupCheck` svarar
`sameVisit` och stoppar failsafen, `app.js:9371`). Buggjägarens felband är vändningar 125–308 m bortom
bron.

**Omgranskningens fall mot revision 2** (9dc2a15, granskarens `w-i35-v1.0-d6-s1` och `a1`, sond
`K/N/tmp/rev3/scripts/probe3.js`). Båten passerar Klaffbron norrut, vänder 150 m bortom, går
tillbaka i 3 kn till 30 m och bromsar till 1 kn. 06:08:20 ligger hon 3,7 m norr om linjen i 0,98
kn, och passagelogiken bokför Klaffbron (`distance_fallback`, fixen räknas som "på linjen" i
`hasChangedBridgeSide`). Leveransintervallet är 40 s. Revision 2:s villkor 6b krävde bara att
föregående fix låg entydigt på bortre sidan och att den här inte gjorde det; 3,7 m räknas inte som
entydigt. Besöket släpptes och notisen "har precis passerat" gick ut medan båten låg kvar norr om
bron. Låg hon sedan kvar och gav upp norrut blev notisen falsk; gick hon söderut 16 min senare kom
notisen 16 min för tidigt.

**Långsam retur (b-1.3).** Bokföringen sker 06:08:20 när båten ännu ligger 4,7 m på bortre sidan.
Vid 1,0–1,3 kn når hon 30 m ut först 60–70 s senare, och revision 2:s `_confirmReturnPassages`
räknade sitt 60 s-fönster strikt från bokföringen.

**Omgranskning 2:s fall mot revision 3** (66a5813, granskarens `geupp/retur-i60+0-d3-j15-r06-s2`,
sond `K/N/tmp/rev3/scripts/probe3.js`, nu fixturerna `n-p1-vantar-vid-linjen-ger-upp.jsonl` och
`n-p1-vantar-vid-linjen-retur.jsonl`). Båten passerar Klaffbron norrut, vänder 150 m bortom, bromsar
in och väntar 15 min 3 m norr om linjen. AIS rapporterar 0,5–0,7 kn och slumpad kurs, bruset är
±15 m och kadensen 60 s.

| Tid | Läge | Vad revision 3 gör |
|---|---|---|
| 06:11:00 | +13,8 m (bortre sidan), sog 0,54 | passagelogiken bokför Klaffbron; fixen ligger entydigt på bortre sidan, så bokföringen absorberas |
| 06:12:00 | −14,3 m, sog 0,56, kurs 221° | korsning noterad; glest segment, entydig ankomstsida och sog över 0,5: `gles-korsning` släpper. Notis "har precis passerat" söderut |
| 06:13:00 | +5,2 m | båten väntar vidare norr om bron |
| 06:25:00–06:26:00 | +15,9 → −96,5 m, 3,5 kn | den verkliga korsningen söderut (sann tid 06:25:01,7) i retur-varianten; ingen notis, besöket är redan förbrukat |

I `ge-upp` fortsätter hon norrut, och notisen 06:12 var falsk. Med enbart fartkravet (A) försvinner
släppet 06:12, men då missas returen 06:25: passagelogiken bokför inte igen vid den verkliga
korsningen, och bokföringen 06:11 hade absorberats. Det gällde 10 av granskarens 360 retur-banor, alla
med samma mönster: andra bokföringen i en fix 11–19 m ut på bortre sidan medan båten väntar efter
vändningen (`K/N/tmp/r4/logs/probe-*.txt`). Därför (C).

Vid tät AIS (P2, 10 s, ±30 m) räckte två fixar i rad på ankomstsidan där den första låg på linjen
(granskarens `p2-i10-d3-j30-s1`: korsning 06:20:09, släpp 06:20:20, sog 0,6, slumpad kurs).

## 2. Rättningen på kodnivå

### 2.1 `lib/utils/geometry.js` (oförändrad sedan revision 2)

- `bridgeLineOffsetM(pos, bridge)`: signerat avstånd i meter längs kanalaxeln (positivt norrut), samma
  projektion som `hasChangedBridgeSide`.
- `decisiveBridgeSide`: +1, −1 eller 0 inom ±10 m. `isDecisivelyOppositeBridgeSide` bygger på den.
- `courseBridgeSide(cog, bridge)`: mot vilken sida en kurs pekar; 0 för ogiltig kurs eller ±10° från
  linjens riktning.

### 2.2 `lib/services/TriggerPointVisitTracker.js`

Besöket (bara broar) bär:

| Fält | Innebörd | Sparas |
|---|---|---|
| `farSign` | sidan den notifierade passagen leder till (±1) | ja |
| `farSideSeenAt` | appens klocka vid senaste rena fixen entydigt på bortre sidan | ja |
| `farSideBooking` (+ fix och läge) | senaste bokföringsstämpeln i en fix på bortre sidan | nej |
| `returnBookedAt` (+ fix) | returens bokföring: gjord när båten inte låg entydigt på bortre sidan, eller (revision 4) en förtida bokföring vid linjen efter vändningen | nej |
| `segment` | fixens segment: startfix, om den låg entydigt på bortre sidan, leveransintervall | nej |
| `crossing` | noterad korsning: interpolerad tid, startfix, segmentets leveransintervall och längd längs kanalaxeln, antal fixar på ankomstsidan, förra och senaste ankomstfixens läge (entydig sida, under gång) | nej |
| `lastObservedAt` | leveransklockan | nej |

- **`_trackReturn`** (anropas av `observe` för varje ren fix i ett öppet brobesök med `farSign`):
  - fix entydigt på bortre sidan: `farSideSeenAt` sätts, bokföringen noteras via
    `_noteFarSideBooking` (nedan), korsningen stryks;
  - annars fångas en ny stämpel som `returnBookedAt` med fixens tid;
  - fix på bortre sidan inom 10 m (`offset > 0`): korsningen stryks;
  - fix på ankomstsidan (`offset ≤ 0`) efter en fix med `offset > 0`: korsning noteras, tiden
    interpolerad linjärt på fixklockan, `previousFix.fixTs + span × prev/(prev − offset)`, som
    `gt-passages` gör. Varje följande fix på ankomstsidan räknas (`arrivalFixes`), och den förra och
    senaste ankomstfixens läge sparas (`_arrivalFixState`: entydigt ute, under gång dit).
- **`_noteFarSideBooking`** (ny i revision 4): en bokföring i en fix entydigt på bortre sidan
  absorberas, utom när båten redan har setts på bortre sidan, ruttriktningen pekar tillbaka och fixen
  ligger inom `RETURN_CLEAR_M` (30 m) från linjen. Då är det passagelogikens förtida bokföring av
  returen medan båten väntar vid linjen, och den behålls som `returnBookedAt`. Eftersom den gjordes
  före korsningssegmentet kan den bara släppas med beviset `ankomstsidan-två-fixar`.
- **`releaseReturnPassage(vessel, bro, { maxBookingAgeMs, maxLatenessMs, sparseFixGapMs, dryRun })`**
  släpper bara när allt gäller:
  1. besöket är öppet, gäller en bro och har `farSign`; positionen är ren och är besökets senaste fix;
  2. ligger båten entydigt på bortre sidan noteras bokföringen (`_noteFarSideBooking`) och inget
     släpps;
  3. en korsning är noterad i den här fixen, eller (8c) fixen ligger inom ±10 m i ett glest segment;
  4. bokföringen hör till korsningssegmentet (gjord i segmentets startfix eller senare), eller båten
     har legat två fixar i rad på ankomstsidan; bokföringen är yngre än `maxBookingAgeMs`;
  5. **U21**: `now − korsningstid ≤ maxLatenessMs`;
  6. `_routeDirection` pekar tillbaka;
  7. rapporterad fart minst 0,5 kn och kurs mot ankomstsidan (saknas ett värde prövas det andra);
  8. positionen bevisar passagen, på ett av tre sätt:
     a. `ankomstsidan`: minst `RETURN_CLEAR_M` (30 m) ut och bokföringen i korsningssegmentet;
     b. `ankomstsidan-två-fixar`: minst 30 m ut och två fixar i rad på ankomstsidan där **båda ligger
        entydigt där och båten var under gång dit även i den förra** (revision 4); bokföringen kan
        vara äldre;
     c. gles kadens (segmentets leveransintervall över `sparseFixGapMs`, segmentet började entydigt på
        bortre sidan, bokföringen i segmentet): `gles-korsning` när fixen ligger entydigt på
        ankomstsidan **och båten rör sig i nuet** (revision 4: `RETURN_SPARSE_MOVING_SOG_KN` = 2,0 kn;
        utan fart ett korsningssegment på minst `RETURN_SPARSE_NO_SOG_SEGMENT_M` = 100 m), eller
        `gles-linje-transit` när den ligger inom ±10 m och farten är minst
        `RETURN_TRANSIT_SOG_KN` = `BRIDGE_OPENING.QUAY_TRANSIT_PROOF_SOG_KN` (3,13 kn).

  Med `dryRun` (revision 4) returneras beviset utan att besöket avslutas. Metoden returnerar
  `{ farSign, bookedAt, evidence, crossedAt, crossingGapMs, latenessMs }` eller `null`.
- **Snapshot**: sparar `farSign` och `farSideSeenAt`. De transienta fälten sparas inte.

**Brusmodellen (varför 30 m räcker inom den).** Appen räknar två stilla fixar under
`UNDER_BRIDGE_CROSS_PROOF_JITTER_M` (60 m) isär som GPS-brus (constants.js:110–121), så en båt på
linjen kan synas upp till 30 m åt vardera hållet. Bevisen a och b kräver att båten ligger minst 30 m
ut på ankomstsidan. En båt som i själva verket ligger kvar på bortre sidan (d ≥ 0 m från linjen) kan
därför bara släppas av ett brus på mer än 30 + d meter längs kanalaxeln, alltså utanför modellen.
Bevis c kräver i stället rörelse i nuet. Alla kvarvarande falska släpp i svepen (§5) har brus ±30 m
per koordinat, upp till 42 m längs axeln.

**Varför 2,0 kn för `gles-korsning`.** Det är appens etablerade gräns för "rörelse i nuet" när en
enstaka observation ska bära ett korsningsbevis eller släppa en spärr:
`VesselDataService` RE_CROSS ("Fix D-tröskeln för finit fart", `vessel.sog >= 2.0`, och för
fartgivarlösa ett segment på minst 100 m) och C2 i `_triggerBoatNearFlowForBridge`/
`_triggerExitPointFallback` (`movingNow`, `sog >= 2.0`). Fältet visar väntande båtar vid broar med
sog upp till 0,6 kn (granskarens `stillsog.js`), och generatorns väntan i 0,6–1,0 kn ligger en faktor
två under. En verklig retur under 2 kn vid gles AIS får notisen vid nästa fix, ute på ankomstsidan
(bevis a), alltså en kadens senare. Det kostar INV-7 (SEN) i 4 av 120 långsamma svepbanor (§5).

**Varför båda fixarna entydigt ute och under gång.** En brusutflykt hos en väntande båt varar en
eller två fixar, har slumpad kurs och ligger ofta på linjen i den första fixen. En verklig retur som är
30 m ut har redan legat flera fixar över 10 m ut med kurs mot ankomstsidan (vid 0,7 kn och 60 s
kadens rör hon sig 21 m per fix). Kravet halverade de falska släppen vid ±30 m (11 → 5 av 144 vid tät
AIS) och ändrade ingen långsam retur vid ±5–15 m.

**Varför den förtida bokföringen behålls.** Passagelogiken bokför en andra passage ibland redan när en
väntande båt ligger 11–19 m ut på bortre sidan, och bokför inte igen vid den verkliga korsningen.
Revision 3 absorberade bokföringen, men släppte (felaktigt) tidigare via `gles-korsning`. När det
släppet försvinner missas returen helt (10 av 360 P1-returer, INV-5). Undantaget är smalt: båten har
redan setts på bortre sidan (så det är inte den notifierade passagens egen bokföring i första
fixen), vändningen är bekräftad (`_routeDirection` pekar tillbaka) och fixen ligger inom 30 m från
linjen. Släppet kräver ändå en noterad korsning och två entydiga fixar under gång på ankomstsidan.

### 2.3 `app.js`

- **`_releaseVisitOnReturnPassage(vessel, bro, maxBookingAgeMs = PASSAGE_TRIGGER_GRACE_MS, { dryRun })`**
  skickar `maxLatenessMs = UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS` och
  `sparseFixGapMs = PASSAGE_CLEAR_WINDOW_MS / 2`. Den städar som en observerad återkomst och loggar
  `TRIGGER_POINT_VISIT_RETURN`; med `dryRun` städar och loggar den inget.
- **`_returnPassageForm(released)`** (oförändrad): `'silence'` när korsningssegmentet är längre än två
  AISHub-pollar (130 s) och notisen kommer mer än 60 s efter korsningen; annars `'live'`.
- **`_triggerBoatNearFlowForBridge`** (oförändrad sedan revision 3): släppet före `holds()`; ett släpp
  ger passerad form, `'silence'` ger BN2:s mening.
- **`_triggerBoatNearFlowFallback`** (revision 4): prövar beviset torrt före dedupkontrollen. Ett
  godkänt bevis ersätter `_persistentDedupCheck` (det riktiga släppet tar bort just de poster den
  skulle ha blockerat på). Besöket släpps på riktigt först när failsafens spärrar
  (`FALLBACK_TRIGGER_TOO_FAR`, `STALE_POSITION`, `STALE`, `LOW_SOG_FAR`) är passerade, alldeles före
  `FALLBACK_BOAT_NEAR`. Faller beviset bort mellan torrkörningen och släppet (gränsfall på
  millisekunden) går ingen notis ut.
- **`_confirmReturnPassages`** (oförändrad): prövar öppna brobesök i slutet av varje fix utan
  bokföringsgräns.

### 2.4 Mätinstrumentet

- **`tests/replay-validation/returnReleaseVerdict.js`** (nytt): den geometriska domen över ett släpp,
  utbruten ur `replayRunner.js` så att den kan enhetstestas. Avstånd: första sampel minst 100 m från
  linjen avgör `ankomst`/`bortre`. Tid (revision 3): `för tidig` när varken släppfixen, nästa fix
  eller något sampel inom 60 s ligger entydigt på ankomstsidan. **Att stanna (revision 4):** `för
  tidig` också när färre än hälften av fixarna efter släppet (nästa fix plus alla sampel inom 60 s)
  ligger entydigt på ankomstsidan. Vid gles kadens är det nästa fix; vid tät kadens tål domen
  enstaka brusiga sampel.
- **`replayRunner.js`**: använder modulen; failsafens torrkörning (`limits.dryRun`) bokförs inte i
  `visitReturnReleases`.
- **`invariants.js` INV-2**: meningen för FÖR TIDIGT RETURSLÄPP nämner att båten ska stanna.
- **`scenarioGenerator.js`**: stoppbenet tar `stopSog` (förvalt 0,1, samma slumptal som förut).
- **`runSyntheticScenarios.js`**: fyra nya vakter (§4) och den rättade kommentaren.

### 2.5 Hur guppande och väntande båtar skyddas

| Fall | Vad som stoppar | Belägg |
|---|---|---|
| Guppar på linjen, brus på båda sidor | ingen bokföring och ingen vänd rutt | vakten `guppar-på-Klaffbrons-linje`; apptest |
| Vänder och väntar nära linjen, tät AIS, sog 0,1 | fartkravet | fem vakter `vänder-och-väntar-…` |
| Vänder, bromsar in och väntar vid linjen, gles AIS, sog 0,1 | ingen korsning; linjefix under transitfart | svep 2: 72/72; fyra vakter `vänder-bromsar-väntar-…` |
| Samma med AIS-fart 0,5–1 kn och slumpad kurs, gles AIS, brus ±5–20 m | `gles-korsning` kräver 2,0 kn; a/b kräver 30 m ut | P1 360/360; G1 72/72; vakterna `…-i-1kn-brus-15m-ge-upp` och `…-i-0.6kn-brus-15m-ge-upp`; fixturen `n-p1-vantar-vid-linjen-ger-upp` |
| Samma vid tät AIS, brus ±20–25 m | a/b kräver 30 m ut | P2X 96/96 vid ±20/25 m |
| Samma vid tät AIS, brus ±30 m (utanför modellen) | b kräver två entydiga fixar under gång | P2 24/24, P2X 43/48, G2 22/24; vakten `…-tät-10s-i-1kn-brus-30m-ge-upp`. **Rest: känd gräns** |
| Kommer i transitfart och tvärstannar inom 10 m från linjen | inte sett | 54 banor (revision 3) |
| Avgång tillbaka mot bortre sidan | kursen pekar mot bortre sidan | enhetstester, vakterna |
| Bokföring i en fix på bortre sidan | absorberas (undantag: förtida returbokföring vid linjen efter vändningen, släpps bara av b) | enhetstester "absorberas", "förtida bokföring", "samma väntan som ger upp" |
| Sen notis efter långt avbrott | U21 (10 min efter korsningen) | enhets- och apptester "U21" |
| Failsafens spärrar stoppar notisen | besöket släpps inte (torrkörning) | apptestet "failsafen släpper inte besöket …" |

## 3. Övervägda alternativ

| Alternativ | Varför inte (eller varför) |
|---|---|
| **Granskarens förslag: `gles-korsning` kräver 2,0 kn.** | Valt. Ensamt gör det 10 av 360 P1-returer till missade (passagelogiken bokför inte igen); därför (C). |
| **Granskarens alternativ: `gles-korsning` kräver 30 m ut (`RETURN_CLEAR_M`).** | Granskaren mätte INV-7 SEN i två R1-världar (LINNEA 487 i 3,7 kn, ZELDA 579 i 3,1 kn). Fartgolvet behåller dem. |
| **Granskarens förslag för tät AIS: båda fixarna entydigt ute och under gång.** | Valt (B). Halverar de falska släppen vid ±30 m utan att ändra någon retur inom brusmodellen. |
| **Fartgolv 2,0 kn även för `ankomstsidan-två-fixar`.** | Långsamma verkliga returer (granskarens b-0.7, b-1.3, a1, a1s-1.0) bevisas just av två fixar i 0,7–1,3 kn; de hade missats. |
| **Kinematisk rimlighet: farten sedan korsningen ska kunna förklara avståndet ut (prövad som variant K).** | Tog bort fler falska släpp vid ±30 m (11 → 3), men fördröjde verkliga returer vid ±15 m (max 132 → 201 s) och ±30 m (max 189 → 489 s), alltså inom modellen. Förkastad. |
| **Absorbera den förtida bokföringen som förut och acceptera missen.** | 10 av 360 verkliga returer utan notis, samma klass som kortet (INV-5). Förkastad. |
| **Kräva att den förtida bokföringen ligger inom 10 m i stället för 30 m.** | Granskarens fall hade 11,0–18,6 m. 30 m är brusmodellens halva bredd och samma gräns som beviset. |
| **Registrera allt brus över ±20 m som känd gräns utan kodändring.** | Revision 3 fällde redan vid ±15 m och gles AIS (inom modellen). Det är ett fel, inte en gräns. |
| **INV-2-domen: nästa fix måste ligga entydigt ute (granskarens första variant).** | Dömde två verkliga långsamma returer vid ±30 m som `för tidig`. Majoritetsregeln över nästa fix och 60 s-fönstret gör det inte och fångar ändå alla sju för tidiga släpp i svepen. |
| **Failsafen: flytta hela dedupkontrollen efter spärrarna.** | Ändrar vilken loggrad som syns för vanliga blockerade failsafe-fall. Torrkörningen ändrar bara släppfallet. |
| **Tidigare revisioners alternativ** (tystnadens mening vid 60 s, U21 som avbrottslängd, inte godta `distance_fallback`, ändra INV-7) | Oförändrade skäl, se revision 3 (`K/N/tmp/r4/DESIGN-rev3.md` §3). |

## 4. Tester

**`tests/u14-returpassage-notis.test.js`, 84 tester** (62 i revision 3). Nytt i revision 4:

- spåraren:
  - gles fix 15 m ut i 0,6/1,0/1,9 kn släpper inte (men nästa fix ute på ankomstsidan gör det), i
    2,0/3 kn släpper den (`gles-korsning`);
  - utan fart: korsningssegment 145 m släpper, 75 m inte;
  - två fixar på ankomstsidan: förra fixen 4 m ut, med kurs mot bortre sidan eller i 0,3 kn släpper
    inte; båda entydigt ute och under gång släpper;
  - förtida bokföring 13,8 m ut på bortre sidan efter vändningen behålls och släpps vid den verkliga
    passagen (`ankomstsidan-två-fixar`, korsningen före första ankomstfixen); samma väntan som ger upp
    släpps aldrig; samma bokföring när rutten inte har vänt eller fixen ligger 45 m ut absorberas;
  - torrkörning lämnar besöket orört;
- appen: failsafen med `FALLBACK_TRIGGER_TOO_FAR` (2 100 m) släpper inte besöket, loggar inget släpp
  och behåller den persistenta posten;
- domen (`returnReleaseVerdict`): granskarens för tidiga släpp döms `för tidig`; en verklig retur vid
  tät kadens med ett brusigt sampel döms `ankomst`; vid gles kadens avgör nästa fix;
- replay: fixturerna `n-p1-vantar-vid-linjen-ger-upp.jsonl` (md5 `d8db995c…`, en notis, inget släpp)
  och `n-p1-vantar-vid-linjen-retur.jsonl` (md5 `87d927f7…`, två notiser, notisen efter den sanna
  korsningen 06:25:01,7, inom 3 min, beviset `ankomstsidan-två-fixar`). Båda är granskarens
  `geupp/retur-i60+0-d3-j15-r06-s2` byte för byte.

**Mot äldre träd** (`K/N/tmp/r4/u14-rev3h.txt`, `u14-base-h.txt`; revision 4:s testfil och harness
kopierade till exporter):

- revision 4: 84/84;
- revision 3 (66a5813): 71/84. De 13 röda är alla nya beteendetester: tre fartfall
  (`toBeFalsy`, släppet kommer), utan fart 75 m, tre tvåfixfall, förtida bokföring (falskt släpp
  06:12 i väntan), ge upp-väntan, torrkörning, failsafen (loggar släpp), P1 ge upp (två notiser) och
  P1 retur (notisen före den sanna korsningen);
- 7699cbe: 16/84 (B01, failsafen, M1/M2, P1 retur m.fl. röda).

**Syntetiska scenarier** (65, alla rena, `K/N/tmp/batt4/synthetic.log`). Nya:

- `vänder-bromsar-väntar-6m-gles-35+10s-i-1kn-brus-15m-ge-upp` och
  `…-60+0s-i-0.6kn-brus-15m-ge-upp`: EN notis. Fäller revision 3 (DUBBLETT, FALSKT RETURSLÄPP).
- `…-60+0s-i-0.6kn-brus-15m-retur`: TVÅ notiser. Fäller 7699cbe (SAKNAD RETURNOTIS).
- `vänder-bromsar-väntar-3m-tät-10s-i-1kn-brus-30m-ge-upp`: EN notis. Fäller revision 3.

Fröna kommer ur svepet `K/N/tmp/r4/scripts/guardFind4.js` med appens egen generator (G1: 144 banor
gles AIS ±15 m; G2: 48 banor tät AIS ±30 m). Vakten vid ±30 m ligger i en klass med uppmätt rest och
håller fast ett fall som revision 4 stänger; resten är registrerad (§13). Med revision 4:s harness
fäller revision 3 de tre `ge-upp`-vakterna och 7699cbe sju scenarier
(`K/N/tmp/r4/synthetic-rev3h.log`, `synthetic-base-h.log`).

## 5. Mätningar (K/N/wt på `0be75e5`; loggar i `K/N/tmp/batt4/` och `K/N/tmp/r4/`)

| Körning | Utfall |
|---|---|
| `npm test` | 354/355 sviter, 4 859 gröna, 2 överhoppade, 1 röd. Den röda är `bugHunt/__tests__/b-register.test.js` ("docs/BUGGJAKT.md finns inte"), lika på 7699cbe och i revision 3. |
| `npm run replay:all` | Alla låsta korpusar matchar facit (med omlåsningen). Banken notis för notis identisk med revision 3 (`K/N/tmp/r4/cmp-rev3-rev4.log`, 0 ändrade rader); mot 7699cbe exakt tre. Bankens tre släpp: domen `ankomst`, bevis `ankomstsidan`, 5,1/2,1/1,4 min efter korsningen. |
| `npm run replay:synthetic` | 65 scenarier, alla rena. |
| `npm run replay:openings` | Godkänt, rad för rad identiskt med revision 3 och 7699cbe. |
| `npm run replay:monitoring` | Stabil, 0 processfel, 0 timers. 219 notiser (Järnvägsbron 38), samma som revision 3. |
| `npm run replay:phase` | OK, 24 korpusar, inget odokumenterat fasberoende. |
| `REPLAY_MONITORING=1 npm run replay:phase` | OK, 24 korpusar. |
| `npm run lint` | 0 fel. |

**Adversariella svep** (sanning ur generatorns s-profil: `K/N/tmp/r4/scripts/gen4.js` skriver
`*.truth.json`; körare `esweep.js`, sammanfattning `summ.js`; loggar `K/N/tmp/r4/logs/<familj>.<träd>.log`
med träden `r4c` = revision 4, `head` = revision 3, `base` = 7699cbe). "Rätt" betyder lika många
Klaffbronotiser som sanna korsningar och inget släpp före en sann returkorsning.

| Familj (banor) | Revision 4 | Revision 3 | 7699cbe |
|---|---|---|---|
| Granskarens P1 ge upp (360: gles 10–60 s, ±5–20 m, väntan i 0,6/1,0 kn) | 360 rätt | 354 (6 falska) | 360 |
| Granskarens P1 retur (360) | 360 rätt; släppet median 77 s, högst 118 s efter korsningen | 346 (6 för tidiga, 8 missade) | 0 (alla returer missade) |
| Granskarens P2 (24: tät, ±25/30 m) | 24 rätt | 21 (3 med tre notiser) | 24 |
| P2X ge upp (144: tät 10–30 s, ±20/25/30 m) | 139 (5 falska, alla ±30 m) | 133 (11) | 144 |
| P2X retur (144) | 138 (5 för tidiga, 1 missad; alla ±30 m) | 130 (11 för tidiga, 3 missade) | 0 |
| P3X ge upp (96: gles 35–60 s, ±25/30 m) | 94 (2 falska, ±30 m) | 83 (13) | 96 |
| P3X retur (96) | 94 (2 för tidiga, ±30 m) | 79 (14 för tidiga, 3 missade) | 0 |
| Långsam retur (120: 0,7–2,0 kn, ±5/15/30 m, 10–60 s) | 120 rätt; median 62–69 s efter korsningen, max 189 s | 119 (1 för tidig) | 0 |
| Appens generator G1 (144: gles, ±15 m, 0,6/1,0 kn) | 144 rätt | 142 (2 falska) | 72 (returerna missade) |
| Appens generator G2 (48: tät 10 s, ±30 m) | 45 | 42 | 24 |
| Granskarens svep 2 / svep 3 (72 / 36) | 72 / 36 | 72 / 36 | 72 / 0 |
| Egna vakter revision 3 (72) | 38 + 34, samma som revision 3 | – | – |
| Granskarens enskilda banor (a1, a1d, a1s, a2, b-0.7–2.0, c3, u21-12/25/40) | notis för notis som revision 3 | – | – |

**Kostnaden.** Fartgolvet för `gles-korsning` flyttar en verklig gles retur under 2 kn till nästa fix:
INV-7 (SEN) i 4 fler av 120 långsamma banor (53 → 57), samma kostnad som revision 3:s accepterade
dröjsmål vid linjen (registerposten U14-GLES-NÄSTA-FIX). Kravet på två entydiga fixar flyttar
medianen i P1 retur från 58 till 77 s. Den förtida bokföringen gör att P1:s tio tidigare missade
returer får notisen; INV-7 fäller där eftersom bokföringen gjordes under väntan (P1 retur 346 → 360
SEN, alla med bokföringen före korsningen).

**INV-2:s skärpta dom.** I alla svep döms varje första släpp före en sann returkorsning `bortre`
(ge upp, 7 st) eller `för tidig` (retur, 7 st): 14 av 14 i revision 4. Ingen verklig retur döms fel (1 320 banor).
Revision 3:s sex för tidiga P1-släpp döms nu `för tidig` (`K/N/tmp/r4/rev3h`, revision 3:s app med
revision 4:s harness).

## 6. Motorkontrollen

Se §12.

## 7. Samspelet med andra familjer

Delade funktioner: notisflödet i app.js (`_triggerBoatNearFlowForBridge`, `_triggerBoatNearFlowFallback`
med torrkörningen, `_persistentDedupCheck`, slutet av `_onVesselUpdated`), passagebokföringen
(`lastPassedBridge`, `lastPassedBridgeTime`, `passedAt`; N läser, ändrar inte), ruttriktningen
(`_routeDirection`, R1 äger) och harnessen (`replayRunner.js`, `invariants.js`,
`runSyntheticScenarios.js`, `scenarioGenerator.js`). Kombinationsträden ligger i `K/N/tmp/r4/inter/`
(7699cbe + familjens senaste patch + N:s patch, `git apply --3way`, skript `mk.sh`, konfliktlösning
`resolve.py` och `resolve_corpora.py`, körning `runonly.sh`).

| Familj (patch, md5) | Textkonflikt | Lösning | replay:all | synthetic |
|---|---|---|---|---|
| R1 (`388e3ea09eae`) | `runSyntheticScenarios.js`, VALIDATION.md | behåll båda; lägg `},\n  {` mellan blocken i scenariolistan | grön | 67 rena |
| R2 (`94b7bc94a1c1`) | ingen | – | grön | 65 rena |
| K (`64bb4cb90f46`) | ingen | – | grön | 65 rena |
| K2 (`73c54fba24d9`) | VALIDATION.md | behåll båda | grön | 66 rena |
| M (`64c5cd32f77e`) | VALIDATION.md | behåll båda | grön | 71 rena |
| E + E2 (`E2/patch-ETA.diff`) | `corpora.js` (noterna för 25h, both-21h och 42h) | N:s `expectedNotifications`, båda noterna, N:s först | 20260917-7h röd (golden-text 68 ≠ 69) | 65 rena |

Den röda raden i E + N kommer likadant med E:s patch ensam på 7699cbe (`K/N/tmp/r4/inter/eonly`,
samma rad), alltså från E:s demo-omlåsning och inte från samspelet.

**Fallgrop vid sammanslagningen av `runSyntheticScenarios.js`** (oförändrad): konfliktblocken slutar
mitt i listan. Att bara behålla båda sidorna smälter ihop två scenarier till ett objekt. Lägg in
`},\n  {` mellan blocken och kontrollera att sviten rapporterar summan av scenarierna.

R1 gör att fler returer bokförs, och utan N blir de tysta. N bör integreras med R1 eller direkt
efter. E och E2 ändrar ETA-vägen; N:s returnotiser har eta −1 och berörs inte. R2 äger
passagelogiken, vars förtida bokföring vid linjen N nu tar hand om (§2.2); en R2-rättning som slutar
bokföra i väntan gör undantaget overksamt men inte fel.

## 8. Användarbesluten och dokumenterade beslut (alla beslutade)

- **U13:** omlåsningen gäller bara de tre korpusar där `gt-passages` visar två verkliga passager som
  appen också bokför. Revision 4 ändrar inget i facit jämfört med revision 2 och 3 (banken identisk,
  FACIT.md).
- **U14:** genomfört enligt §2. INV-5/7 är kontraktet. En båt som guppar, väntar, vänder och väntar,
  eller vänder, bromsar in och väntar vid gles AIS och med AIS-fart 0,5–1 kn får fortfarande en notis
  inom appens brusmodell. Brus utanför modellen är en registrerad känd gräns (§10, §13).
- **U21 (användaren 2026-11-04, dirigentens gräns 2026-11-05):** en returnotis släpps bara om den
  kommer högst `STALE_ETA_HARD_THRESHOLD_MS` (10 min) efter den uppskattade korsningen, som
  interpoleras på glappsegmentet. Annars skickas ingen returnotis. Genomfört som villkor 5 i §2.2.
  Bankens tre returer har dröjsmålen 5,1, 2,1 och 1,4 min; 21h ELFKUNGEN (80 min) får ingen notis (§9).
- **Dirigentens beslut inför revision 3, punkten om N (U21:s gräns):** genomfört, se ovan. De andra
  punkterna (K:s under bron-hållet och korsningsankaret, K2:s 60 s-golv, M:s väg 1) gäller andra
  familjer och rör inte N:s funktioner.
- **U15, U16, U17–U20:** rörs inte. U19 (en planerad öppningsvarning skickas även när en obekräftad
  vändning väntar) gäller öppningslagret; N rör bara boat_near. U18 (Fix D:s två positioner) gör att
  en vändning direkt i under cirka 1,5 kn inte bekräftas; då bokförs returen inte och N får inget att
  släppa (§10).
- **Besöksregeln 2026-09-07:** U14 lägger bara till ett sätt för ett besök att sluta. "Ingen ny notis
  antas ur glappet" står fast (U21).
- **AKIRA-regeln, D3, C13/U7, radierna 300/350 m:** oförändrade.

## 9. 21h ELFKUNGEN under U21 (beslutat)

Appen *ser* returen men bokför den inte. Förloppet i 20260708-21h (granskarens logg
`K/N/tmp/review/logs/c21h-rwt.err` rad 2675–2677):

1. ELFKUNGEN passerar Stallbackabron norrut 11:01–11:02 (observerad) och notifieras.
2. Hon hörs inte på 80 min. Appen tar bort fartyget efter 20 min.
3. 12:22 hörs hon 1,3 km söder om bron. Det återfödda fartyget saknar passagehistorik, och
   `SKIPPED_BRIDGES_CHECK … new-vessel, direction=south, candidates=[Stallbackabron]` hittar returen.
4. Svepets scenario A är ett *antagande* ur glappet och bokför ingen passage. Failsafen stoppas av
   besöksregeln.

Rådata: 11:01:36 norrut (observerad) och 11:07:33 söderut (inferred, 97 m norr → 1322 m söder). Med
U21 vore notisen dessutom 75 min sen och skulle inte släppas även om returen bokfördes. Korpusen har
54 notiser som förut.

## 10. Risker och kvarvarande gränser

- **Brus utanför appens brusmodell** (ny i revision 4, registrerad). Med ±30 m per koordinat (upp
  till 42 m längs kanalaxeln) kan en väntande båt i 0,6–1 kn ligga två fixar i rad över 30 m ut på
  ankomstsidan med kurs dit. Uppmätt rest: 5 av 48 banor vid tät AIS och 2 av 48 vid gles AIS ger ett
  falskt eller för tidigt släpp, och ett falskt släpp kan ge en tredje notis när båten sedan ger upp.
  Vid ±20–25 m: 0 av 192. Kinematiska krav som stänger mer (variant K) fördröjer verkliga returer
  inom modellen och valdes bort.
- **Passagelogikens falska bokföringar vid linjen.** De ger inte notiser men INV-5 för en båt som
  vänder och väntar, som på 7699cbe (`distance_fallback`, ±10 m-regeln i `hasChangedBridgeSide`).
- **Förtidig bokföring och INV-7.** När passagelogiken bokför vid ankomsten till linjen och båten
  korsar senare kommer notisen vid den verkliga korsningen, men INV-7 mäter mot bokföringen och
  fäller SEN. Revision 4:s undantag för bokföringen strax bortom linjen (§2.2) gör den klassen
  vanligare i svepen (P1 retur: 360 av 360), eftersom returer som förut missades nu notifieras. På
  7699cbe är de MISSAD.
- **Gles retur under 2 kn, eller vid linjen under transitfart.** Notisen kommer vid nästa fix ute på
  ankomstsidan, upp till ett leveransintervall (65–70 s vid AISHub) senare; INV-7 kan då fälla SEN
  (4 av 120 långsamma svepbanor). Registerposten U14-GLES-NÄSTA-FIX.
- **Ruttriktningen efter lång väntan vid linjen (R1).** 2 av 36 glesa returvakter missas lika på
  7699cbe: RE_CROSS vänder rutten fel vid den verkliga korsningen.
- **Vändning direkt i låg fart (R1/U18).** En båt som vänder bortom bron och går tillbaka i
  0,7–1,3 kn utan en snabbare sträcka får vändningen obekräftad, och returen bokförs inte (90 av 90
  sådana banor, och 6 av 30 i 2,0 kn, `K/N/tmp/r4/logs/slow-direkt.head.log`; stickprov på 7699cbe
  ger samma bokföring). N har inget att släppa. Med en vändning i 3 kn (familjen `slow`) bokförs
  returen och får sin notis i 120 av 120.
- **Båt som efter korsningen ligger stilla inom 30 m från linjen i mer än 10 min.** Ingen notis (U21).
  Inte sett.
- **Transitfart och tvärstopp vid linjen** när passagelogiken bokför: teoretiskt en falsk notis. Inte
  sett i 54 banor.
- **AIS utan fart och kurs:** då prövas position, korsning och rutt; `gles-korsning` kräver ett
  korsningssegment på minst 100 m.
- **Returer som appen inte bokför** (studsvakten `REVERSE_RECRROSS_GUARD`, retur inom cirka 3 min) får
  ingen notis. Oförändrat.
- **Omstart mellan bokföring och bekräftelse:** stämplarna sparas inte, så returen får ingen notis.
- **Form vid AISHub-kadens:** en retur vars korsningssegment är längre än 130 s och som notifieras
  efter 60 s får tystnadens mening (ORION 1034 i klustret).
- **Mellanbroarna omfattas** (soaken +3 vid Järnvägsbron, alla verkliga returer).

## 11. Dokument

**Uppdaterade i worktreen:**

- `docs/ARCHITECTURE.md`: §3 dedup-lager 3 (förtida bokföring vid linjen, två entydiga fixar under
  gång, rörelse i nuet vid gles AIS, brusmodellen, failsafens torrkörning, INV-2:s dom med
  `returnReleaseVerdict.js`), U14-avsnittet med omgranskning 2 och den nya kända gränsen (brus
  utanför modellen, uppmätt rest).
- `docs/VALIDATION.md`: pelare 2 (brusmodellen, AIS-fart), 65 scenarier, INV-2 med att stanna,
  U14-stycket med rättad INV-7-mening och de fyra nya vakterna.
- `TriggerPointVisitTracker.js`: huvudkommentaren, docblocken för `releaseReturnPassage`,
  `_noteFarSideBooking`, `_arrivalFixState` och konstanterna.
- `app.js`: docblocken för `_releaseVisitOnReturnPassage` och failsafens kommentar.
- `scenarioGenerator.js`, `runSyntheticScenarios.js`, `replayRunner.js`, `returnReleaseVerdict.js`:
  kommentarerna.

**För dirigenten:** registerposterna i svarets `registryRequests` (§13), raderna om
INV5-VS-BESÖKSREGEL i `S/hunt-build/C/repo/docs/BUGGJAKT.md` (269, 280, 587, 599), och två föreslagna
kort: passagelogikens förtidiga bokföring vid linjen (INV-5 för väntande båt, INV-7 för senare verklig
korsning) och RE_CROSS-riktningen efter lång väntan.

## 12. Körningar på HEAD

HEAD är `0be75e5`. Patchen `K/N/patch.diff` har md5 `84551e23bd5f` och 24 filer; `git apply --check`
är rent på 7699cbe. `K/N/patch-utan-omlasning.diff` (md5 `d2b26a8b6e05`, 16 filer) är samma patch utan
omlåsningsfilerna.

**Fassvepen** (`K/N/tmp/batt4/phase.log`, `phase-mon.log`): `npm run replay:phase` OK för 24
korpusar, och med `REPLAY_MONITORING=1` likaså, utan odokumenterat fasberoende.

**Motorn.**

- `hunt.js --repro` för B01: BORTA ("utfall mot aktuell HEAD: BORTA (0 utslag i världen)").
- Alla 41 kort- och r2-kataloger i r1-standard-a: byte för byte samma utfall som revision 3
  (`K/N/tmp/batt4/repro-all.txt` mot `K/N/tmp/batt3/repro-all.txt`, diff tom), alltså BORTA för B01
  och KVAR för de andra familjernas kort.
- `hunt.js --profile=quick --out=K/N/hunt-quick` (`git status --porcelain` oförändrad under körningen):
  - självtestet GRÖNT (determinism 24/24, SHIFT30 24/24, MMSI 24/24, kanarier 5/5, rundresa 45/45);
  - mot `S/hunt-fix/runs/r1-quick-a`: 34 → 32 kluster och 88 → 81 utslag; bara INV5-VS-BESÖKSREGEL
    försvinner (synt 6 → 0, stress 1 → 0) och inget nytt kluster uppstår;
  - mot revision 3:s quick (`K/N/hunt-quick-rev3`): samma 32 klusternycklar, samma antal, samma
    klusterfingeravtryck, samma täckning och hälsa.
- B01-klustrets 33 utslag (återskapade, `K/N/tmp/r4/cl-rev4.log`): identiska med revision 3, alla ger
  två notiser och inga INV-2/5/7-utslag, och alla släpp får domen `ankomst`.

## 13. Registerposter

Se svarets `registryRequests`. I korthet: INV5-VS-BESÖKSREGEL avgörs av U14 och ska bort;
BESÖKSREGEL-2026-09-07 får U14-undantaget; U21 blir en DESIGN-post; U14-GLES-NÄSTA-FIX (DESIGN) täcker
nu även glesa returer under 2 kn; och fem kända luckor blir KÄND_ÖPPEN med smala predikat:
passagelogikens falska och förtida bokföring vid linjen, RE_CROSS-riktningen efter lång väntan,
obokförda snabba returer och (ny) brus utanför appens brusmodell.
