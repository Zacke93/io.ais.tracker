# Etapp 7 — "Bulletproof-paketet"

**Genomförd** 2026-08-08/09 efter 42-timmarsfältprovet 2026-08-06/07.
**Utgångsläge:** `acc0281` (minifixarna B2+B3). **Appversion:** 5.3.0 → 5.4.0.
**Underlag:** `FALTRAPPORT-42h-2026-08-08.md` (fältanalysen) och
`docs/etapp7-plan-2026-08-08.md` (planen, som är arbetsdokumentet).

Detta dokument beskriver vad som gjordes, vad som **inte** gjordes och varför — den senare delen
är avsiktligt lika utförlig som den första. Tre fixar återkallades eller sköts upp under etappen,
och skälen är det som gör dem återupptagbara.

---

## 1. Fältprovet som styrde etappen

42-timmarskörningen visade sig vara ett oplanerat **AISHub-only-prov**: aisstream levererade noll
positioner under hela körningen, och tystnaden hade i själva verket börjat 51 timmar tidigare —
mitt på en frisk socket i föregående körning. Appen bar hela trafiken på en källa utan att någon
märkte det: 116 fartygstransiter, 135 boat_near-notiser, 36 öppningsvarningar, 0 krascher.

Redundansen bevisade alltså sitt värde och sin blinda fläck samtidigt. `connection_status` skrevs
**två gånger på 870 167 loggrader**, båda under de första 1,4 sekunderna, båda "connected".

Analysen kördes som 11 + 3 dimensioner, var och en prövad av en adversariell skeptiker.
**Skeptikerna fällde eller korrigerade 41 av 142 slutsatser.** Det mest betydelsefulla de fällde
var förarbetets premiss för C0 — se §5.

---

## 2. Fas A — mätinstrument före produkt (`eab64f4`)

Fas A ändrar ingen produktbana. De 15 tidigare låsta korpusarnas fem facitdimensioner är
byte-identiska efteråt: facitfilerna fick **382 + 268 + 6 tillägg och noll borttagningar**.

| # | Vad | Varför |
|---|---|---|
| A1 | Monitoring-blocken extraherade till anropbara metoder | TEST_MODE stängde av dem i replay |
| **A1b** | VesselDataService städtimer extraherad | **Samma hål i en annan fil.** Timern var enda produktionsanropare av `_validateCleanupIntegrity`, som äger `_completedJourneys`-TTL, passage-cachen och logg-debouncen. Fält: 500 + 12 rader. Replay: **0 + 0**. Hela korpusskyddet validerade en tillståndsmaskin där de vägarna aldrig åldrades |
| **A2** | `makeGtPassages.js` — rådatafacit ur farledspolylinjen | Mot dirigentens egen geometri: **+12 äkta korsningar** under AIS-tystnad, **−18 falska** Kanalinfarts-intrång (kajplats på 300 m-gränsen), −1 korpuskantsartefakt. Läser **aldrig** `BRIDGES`-koordinaten — annars bygger facit in den bugg C0 ska rätta |
| A3 | O1/INV-21 mäter mot rådatafacit som parallell serie | Appens egna passageräknare delar facitets blindfläck (96 av 107) och blindheterna är **korrelerade** — en korsvalidering mellan dem ser falskt bekräftande ut |
| A4/A5 | `byReasonAll` + per-avvisning-loggrad | `shouldAccept` avvisar på första regel |
| A6 | PRE-fusionsfångst i replay | |
| A7 | Watchdogloggen: `sinceMessage`/`uptime`/`sinceConfigured` var för sig | **20 av 21 fältstrikes ljög.** Strike 21 sa "120 min"; sanningen var **3 009 min** |
| A8 | Token-timeout-filter, REGEN-complete-vakt, `originalDueMs` | |
| A12 | F6b:s samma-rapport-grind (90 s) | Latent hubsvält vid källåterkomst |
| A13 | Notisvägen loggar utfall | Utan den kan källdödslarmet **aldrig** fältverifieras |
| A14 | `heapUsed`/RSS i MEMORY_STATS | Loggen hade noll heap-observationer. ⚠️ EFTERSKRIFT (2026-08-10, söndagsfältet KX-3): `process.memoryUsage()` kastar ENOENT (uv_resident_set_memory, /proc otillgängligt) i Homey Pro-containern — A14 levererade i praktiken ALDRIG heap-observationer i fält förrän WS-1/P4 bytte primärkälla till `v8.getHeapStatistics()` |

**Korpusarna blev 18** (~319,5 h): #16 `20260804-17h` (låst 116), #17 `20260804-both-21h`
(låst 152, `lockOpenings:false`), #18 `20260806-42h` (**medvetet olåst**, se §6).

**Två defekter som fasgrinden hittade men inte fällde på**, åtgärdade av dirigenten:
- Token-timeout-filtret räknade men **ingen läste räknaren** — 3 279 rader försvann tyst ur
  utskriften. Kommentaren hävdade "raden RÄKNAS, den försvinner inte", vilket var bokstavligen
  sant och praktiskt osant. Det är svälj-fällan i harnessens egen skepnad.
- `originalDueMs` var **död end-to-end**: BridgeOpeningService satte fältet, replayRunner läste
  det, men app.js byggde state-objektet utan det. H-4 rapporterade "saknas" i 365 av 365
  varningar. Efter fixen mäter serien, och första resultatet är att **eligibleAt-ombindningen kan
  skjuta upp en varning 120,5 minuter** (median 1,4).

**A12 omklassades GRÖN → GUL av dirigenten.** Den ändrar hubOffset-skattningen och flyttade en
hub-fix av 1 385 i en av fem latensvarianter. Fyra varianter byte-identiska, notisfacit 24/24
orört i alla fem. Behölls: ändringen går i avsedd riktning och skyddar mot total hubblackout vid
källåterkomst.

---

## 3. Fas B — källdödslarmet (`c188545`)

Facit **helt orört**. Appversion 5.4.0 (ny capability-värde kräver ny version).

**Tre av källdödslarmets fyra mekanismer var trasiga i fält.** Alla tre löstes med ett grepp:
måttet är nu **observerad tystnad**, `now − max(lastMessageTime, observationsankare)`, i stället
för klientens sentinel och socketens uptime.

| Fel | Vad som hände i fält |
|---|---|
| **B2e** | `timeSinceLastMessage: null` blev `Infinity`, som uppfyllde **båda** eskaleringsstegen. Bas + 1h + 4h fyrade i **samma millisekund** 15 minuter efter appstart och brände alla tre 24h-nycklarna. En äkta fyratimmarstystnad senare samma dygn hade gett noll notis — exakt den blink-brända nyckel B2 skapades för att eliminera |
| **B2f** | Upptidsgrinden läste **socketens** ålder, som nollställs vid varje forcerad omanslutning. En källa som flappade snabbare än 15 min kunde aldrig dömas: **12 episoder, ~200 min loggmörker** (8 % av körningen) |
| **B2g** | Blindhetsgrenen nåddes bara när aggregatet var anslutet — vid ett **äkta totalavbrott** kördes den aldrig, vilket är tvärtemot avsikten. Dessutom avväpnade en enda flappande källa hela larmet |
| **B2c** | `connection_status` fick värdet `degraded`. Aggregatet returnerar `streamOk \|\| hubOk` och flanken emitteras bara på 0→1/1→0, så en källas död var **per konstruktion osynlig** |

Fixen verifierades mot det exakta fältscenariot innan commit: trappan går nu
**bas → :1h vid 70 min → :4h vid 5 h**, loggen säger 20/36/90/320 minuter, och ingen rad kan
skriva "Infinity". Fyra syntetiska prov täcker båda-nere-från-start, båda-nere-efter-leverans,
flappande + död, och aldrig-levererat-fallet som **saknades helt** i sviten.

Observationsankaret är medvetet **icke-persisterat**: ett persisterat ankare hade återinfört
kollapsen vid omstart mitt i ett avbrott.

**Övrigt i fas B:** B1 (targetBridge-förkontroll, ~3 400 rader/dygn bort — planens estimat var
1 900), B2d (ETA-token gatas på fixens ålder; Klaffbron#32 avfyrade "om 1 minut" på 1 209 m
byggt på ett 854 s gammalt fix = 39 knop), B4 steg 1 (konstantrefaktorn — det var **fyra** kopior,
inte tre; `FUSION.STATE_TTL_MS` hade lämnat fusionsstatens TTL på 13 min mot en 5-minutersgrind
vid en framtida flipp).

**B2d:s rimlighetstak prövades och FÄLLDES mot rådata.** Stor ETA-token är inte samma sak som fel
ETA-token: LINNEA 69 min mot verkliga 60 hade tystats i onödan, och köklassen felar lika grovt åt
andra hållet (MARY 46 mot 155,8; CARAT 25 mot 178,5). Roten är fartmodellen för köande båtar, och
den matar `expectedArrivalMs` → konvojgrupperingen. Lyft till **C14**.

---

## 4. Fas C-I — gästhamnsgracen (`9f588b4`)

**C0b:** köundantaget höjde stillhetskravet 3 → 15 min för varje båt med målbro inom 600 m.
Gästhamnen ligger 354–411 m från Klaffbron, så undantaget gällde alltid där och B3-kapseln var
halvt avväpnad för exakt den fartygsklass den skrevs för.

En avståndströskel var **omöjlig, inte bara olämplig**: zonernas broavstånd överlappar. Kajzonen
spänner 161,0–320,2 m, gästhamnen 319,1–445,7 m — kajzonens norra spets ligger längre bort än
gästhamnens närmaste punkt. Lösningen blev zon-lokal (`queueGraceMs` på MOORING_ZONES-posten).

Tre goldenfiler omlåsta, var och en rådataverifierad. Störst vinst i `20260804-17h`: **PILLE låg
`sog=0` med `navStatus=null` 14–15 m från kapsellinjen i minst nio minuter**, men undantaget
krävde femton. Hennes spöktext gick från 25 minuter till 30 sekunder.

**F-8b:** `gasthamnskapseln.test.js` hårdkodade en Klaffbron-koordinat 183 m fel, så
säkerhetsassertionen kunde aldrig fällas. Mutationsbevis efter rättelsen: kapseln 30 m söderut
fäller nu assertionen på 290,86 m — med den gamla koordinaten hade samma mutation passerat tyst.

---

## 5. C0 — den fix som INTE landade, och varför

C0 (Stallbacka-koordinaten) var förberedd i tolv omgångar och såg färdig ut. Den backades.

**Koordinaten är fortfarande bevisat fel** — ~172 m väster om farleden, och appens rapporterade
Stallbacka-avstånd är systematiskt fel med median **+174 m** (AGULHAS fick `distance=207m` när hon
var 10 m från bron). Men fixen är **netto negativ i nuvarande form**:

| Post | Mätt utfall |
|---|---|
| −3 **äkta** notiser | LAMANTIJN, EXCALIBUR X119 och SIESTA har alla sin sista fix **någonsin** på 295–300 m från gamla punkten men 324–327 m från den rätta. Inget senare sampel finns ⇒ ingen vakt kan rädda dem utan att fabricera en notis ur en terminalfix — den fantomklass som fällts tre gånger (F5-C, F4-D, ALICE-bakbensvakten) |
| +2 **fantomer** | Den rätta punkten drar in VIRGOs permanenta kajplats (146–177 m). Hon saknar navStatus ⇒ `sog=0,0 cog=0,0 ETA=−1 stallbacka-waiting` |
| +85 min spöktext | Samma rot |

**Förarbetets bärande premiss var sakligt fel.** "+2 återvunna äkta passager" stämde inte — VIRGO
hade redan båda sina korsningar notifierade före C0. Och SIESTA fanns inte i provkörningen
2026-08-06, eftersom korpus #17 skapades efteråt.

**Gapet kan inte skiljas från koordinaten.** Vi prövade att behålla `BRIDGE_GAPS 2415` och backa
longituden — gapet ensamt ger noll notisdiff, bara +1 min ETA i tolv goldens. Det föll på
`tests/helgranskning-2026-07-06.test.js`, som låser varje gap till **haversine mellan
brokoordinaterna med 10 m tolerans**. BRIDGE_GAPS-semantiken är alltså koordinatavstånd, inte
farledsavstånd. Båda måste landa i samma commit.

**Villkor för att landa C0** (hela härledningen står i `lib/constants.js` vid koordinaten):
1. **C9b** — jittertålig stillhetsdetektering. *(Ursprungligen antogs C9 räcka. Det gör den inte
   — se §6.)*
2. **Bro-lokal notisradie** ~350 m för Stallbackabron. `BRIDGES.radius` finns men är oanvänd av
   flow-vägen; endast `_getFlowTriggerCandidates` gäller broar, men `threshold` används på fyra
   ställen i den funktionen.
3. Först därefter koordinat + gap i **en** commit, med acceptanskrav `−0 äkta, ±0 fantomer`.

---

## 6. Fas C-II — riktningslåset och stillheten (`36567f0`)

**C4b:** målbrologiken förkastade uttryckligen en COG under 2,0 kn ("följer låset"), men raden
direkt efter skrev om `_routeDirection` från samma COG. En rot, tre användarsynliga fel. Fyrade
fyra gånger på 320 h.

Golden #17 omlåst 325→324: CARAT låg still i gästhamnen i nära sju timmar och avgick **söderut**
genom Klaffbron, medan avståndet till Stridsbergsbron **växte** 820 → 3 739 m. De gamla
goldenraderna pekade ut fel bro *och* fel riktning.

**C9** — stillhet som andra bevisväg i disarm-ben 3. Motivet är starkt: 76 % av fältprovets
fartyg saknade navStatus i samtliga sampel, men 2 064 av 2 069 förtöjningsklassningar kom ändå
från just det fältet.

> ⚠️ **C9 har noll mätbar verkan i 320 h korpusdata.** 'stale'-hinken är identisk med och utan
> fixen (105 avväpningar i båda), och den enda 'still'-avväpningen följs av ombeväpning 68 s
> senare. Två mätta orsaker: (1) klassen kräver att fartyget **fortsätter rapportera** medan det
> ligger stilla — i fältet sker det (13 av 51 avväpningar via ren TTL), i korpusarna tystnar
> båtarna i stället; (2) `_stationarySince` nollas redan vid **sog ≥ 0,5 kn**, och kajvobbel
> överskrider det: VIRGO hade 4 av 19 kajsampel på 0,5 / 2,1 / 2,9 kn.

**Konsekvensen är viktigare än fixen:** antagandet att C9 skulle låsa upp C0 håller inte.
Kajvobbel-fantomklassen kräver ett lager som tål jitter över 0,5 kn — rörelse mätt som
**nettoförflyttning över ett fönster** i stället för momentan sog. Infört som **C9b**, och det är
den, inte C9, som är C0:s verkliga förutsättning. C9 behölls: mekaniken är enhetstestad,
kirurgisk, och fältets 13 TTL-avväpningar visar att klassen finns i drift. Nästa fältdygn är dess
första riktiga prov.

**Öppen restpost till C8 (avsedd):** C4b tar bort fantomen som maskerade en äldre
medlemskapsbrist. Båda Klaffbron-varningarna i #18 ligger nu **före** MARYs passage — två
varningar för en o-passerad händelse, precis vad U2 kräver ska absorberas. Före fixen låg den
andra *efter* passagen och räknades därför som separat händelse.

---

## 6b. Fas C-III — [err]-kedjan, skyddszonen, churnen (`3aa8616`)

**Fem av tolv punkter genomfördes INTE.** Det är avsnittets viktigaste innehåll.

| Punkt | Utfall |
|---|---|
| **C5** | 🛑 **Rådatafalsifierad.** Planens design hade tagit bort **191 av 337 failsafe-notiser (57 %)**, inklusive 7 av de 9 i #18 som fältrapporten certifierat som äkta. Orsaken är strukturell: en gap-passage upptäcks per definition på episodens **första** sampel, och beviset kommer från persisterad `_lastKnownPositions` — inte spårhistoriken. Planen antog fel plats för beviset |
| **C3a** | 🛑 **Stoppad.** Golden rörde sig i två låsta korpusar; agenten vägrade tvinga fram omlåsning |
| **F12** | 🛑 Mätbart **skadlig**: 31 nya osanningar, 0 borttagna defekter |
| **F9** | 🛑 Strukturellt oförmögen: 0 av 498 täckningsrader, och `_emitCoverage` saknar fartygsobjektet |
| **C1c** | ⚠️ **Latent** — noll utlösningar i 320 h |

🔴 **STRUKTURFYND UR C3a: brotextens tidslinje är taktad av fartygs-churn.** Varje
`vessel:removed` schemalägger en UI-uppdatering. Uppmätt: "scheduling deferred UI update" gick
1 121 → 355 i both-21h när churnen minskade — vilket flyttar **andra** båtars texter till andra
tick med andra ETA-ögonblicksbilder. **Ingen churn-reducerande fix kan därför vara byte-identisk
mot golden.** Tre av planens fyra C3a-bevislager är dessutom mätt verkningslösa: `MOORING_ZONES`
kan aldrig binda (max 320,3/445,7 m ⇒ alltid ≤ 600 m), lärd kajplats gav 0 färre borttagningar,
rå navstatus 0 extra träffar.

**Det som landade:** C1a (−12 [err]-par, alla med fallbacktext byte-identisk med indata, dvs.
100 % brus) · C1b (497 av 500 utslag låg i aktiv hållning; degraderingstid 38,4 s → **0,36 s**) ·
C1d (**−33,7 min falsk "Inga båtar"-text**, noll notiser/öppningar rörda — rotorsaken var att
skyddszonen valde *närmaste* bro även när den var passerad) · C2 (206 → 181 clamp-händelser, en
enda användarsynlig token) · **C3b −87,3 %** och **C3c −89,6 %** av settings-skrivningarna.

⚠️ **C2:s riktning kan inte avgöras.** Mot appens detekterade passagetid är den en förbättring
(1,16 → 0,84 min), mot den fysiskt interpolerade korsningen en försämring (0,12 → 1,88).
Sampelgapet 69,5 s är större än effekten. Clampen som helhet behålls — den var bättre i 99 fall
och sämre i 83.

## 6c. Fas C-IV — öppningskontraktet (`39f6573`)

🔴 **U2-SEMANTIKEN OCH DEADLINE-GARANTIN ÄR ÖMSESIDIGT OFÖRENLIGA.** U2 gör varje icke-ledande
båt till medlem i den o-passerade händelsen, så hennes varning skjuts till `firstPassageAt + K`.
Deadline-garantin räknas **per arm** och förfaller medan hon är täckt. Grinden mätte det exakt:
`LEDTIDSGOLV` 18/22/29/41 s mot golvet 60 s, `AVFYRNINGSFÖNSTER` 92/94/214 s mot taket 60 s —
noll sådana brott i baslinjen.

**C8 byggdes, mättes och återkallades.** Kontraktet *är* nåbart: kvot 1,242 → **0,957**,
öppningar med >1 varning 79 → 20, totalt −22,3 % varningar. Men ovarnade öppningar går
**26 → 32** och O1-täckningen **332/333 → 329/333**. En kontraktsvinst som kostar sex ovarnade
öppningar är en försämring för pelare 3.

**Levererat:** C7 (i) benordning — sex falska `_recordPassage`-anrop eliminerade (latent
händelseförgiftning), noll varningar rörda · C7 (ii) frisläppning — **0 träffar i 319,5 h**,
klassen finns inte, levererad som C8:s förutsättning · C7b/F-4 — **−1 fantom, +1 äkta varning**
i samma öppning (ELFKUNGEN-fantomen ut, MOKENDEIST med 27,2 min ledtid in).

🛑 **C7b/F-5 återkallad.** Klassen har två exemplar i 318 h; fysiskt möjlig förvarning **66 s**
respektive **negativ**, mot garantifönstrets 210 s. De 66 sekunderna vilar på en enda observation.

⚠️ **Metodfynd:** "Fältprovets 1,33" kan inte reproduceras (facitet regenererades i fas A) —
H-4:s **1,34** är det verifierade talet. **Kvoten ensam duger inte som acceptanskriterium:** #18
har kvot 1,00 bara för att sex nollor kompenserar sex överskott. RECOVER-vägen ger 5 räddningar
mot 15 dubbletter och 20 fantomer — att ta bort den kostar fem äkta öppningar.

## 7. Användarbeslut som styrde etappen

| # | Beslut | Följd |
|---|---|---|
| U4 | `both` står kvar trots 51 h aisstream-tystnad | A12 prioriterad — den skyddar vid källåterkomst |
| U5 | **Behåll båda notiserna** vid långa väntetider (ankomst + passage) | F-17 blev dokumenterat designval, inte fix. D9 utgår. #18 låses på **135**, inte 132 |
| U6 | **U1 står fast** — "strax" behålls även vid 153 min väntan | De 256 felvisningsminuterna klassas som sanktionerade. INV-10-utslaget behöver `knownInvariantException` |
| U7 | Retroaktiva notiser tystas över avståndströskel | Ny fix **C13**. ⚠️ 600 m är för lågt — UTOPIA (894 m) och ELFKUNGEN (1 056 m) är de *enda* notiserna för sina passager |
| U8 | Ny appversion godkänd | B2c kunde landa; 5.4.0 |

---

## 8. Vad som är kvar

**Fas C:** C7 + C7b + C8 (öppningskontraktet, tyngst), C11 + C11b, C12, C13, C14, samt den nya
C9b. Se planen för aktuell status.

**Fas D** är uppskjuten till efter nästa fältdygn — den kräver 3-minuterskalibrering och
fältbevis. Omprioriteringar efter fältprovet: **D1 och D8 upp**, **D6 och D7 ned**.

**C0** som egen etapp, efter C9b och den bro-lokala radien.

---

## 9. Läxor värda att bära vidare

1. **Mät verkan innan du tror på den.** C9 landade med perfekt design och noll effekt. En fix som
   inte gör något mätbart ska redovisas som sådan, inte som en seger.
2. **Förarbete åldras.** C0:s premiss byggde på en provkörning från 2026-08-06; korpus #17
   skapades efteråt och innehöll en tredje förlorad notis som ingen kunde se då.
3. **Invarianter fångar det man inte tänkte på.** Gap-mot-haversine-testet stoppade ett försök att
   behålla halva C0 — en inkonsistens som ingen av oss hade förutsett.
4. **Grinden ska vägra.** Fyra röda rundor i C-I var rätt utfall, inte ett misslyckande.
5. **Noter är permanent minne.** Fem sifferimprecisioner i en omlåsningsnot rättades i C-II; de
   rörde inte substansen men hade blivit projektets sanning.
