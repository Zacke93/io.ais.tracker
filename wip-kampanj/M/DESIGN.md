# Familj M: krypfartens målbroflapp (F05), revision 3

Prototyp: commit `454850a` i `K/M/wt` (bas `7699cbe`; tidigare `9c802ed` och
`c6a765d`). Patch: `K/M/patch.diff` (git diff 7699cbe, utan bugHunt och
node_modules). Revisionen svarar på omgranskningen 2026-11-05 (avsnitt 0) och
följer dirigentens beslut inför revision 3: "Följ granskarens väg 1, alltså
tidsbedömningen även för fartgrinden. Slinga-C får inte bli sämre."

## Sammanfattning

Felet: en båt som kryper tappade sin målbro och fick tillbaka den på nästa
AIS-fix. Brotexten visade då "Inga båtar" en kort stund mellan två likadana
texter (INV-14 DEFAULT-FLASH).

Orsaken är att retention och tilldelning dömer samma båt efter olika mått.
Retentionen tar bort målbron först när valideringen fallerat oavbrutet i mer än
nådafristen (60 s) och kräver ett närmandebevis mot MÅLBRON (2-READINGS).
Tilldelningen (ACCELERATED) prövar inte 2-READINGS och dömer fartgrindarna per
SAMPEL mot NÄRMASTE bro. Ett enda gynnsamt prov lade därför tillbaka målbron.

Rättningen speglar retentionens två prov i återinträdet, utan nya konstanter:
1. **Närmandet** (revision 1, oförändrat): retention och återinträde kräver samma
   bevis, minst 10 m närmande från förra fixen eller fönstrets start (det största
   närmandet gäller), inom ett fönster lika långt som nådafristen.
2. **Fartgrinden** (nytt, granskarens väg 1): föll borttagningen på fartgrinden
   (0,7 kn mer än 500 m från närmaste bro, 0,1 kn vid 300–500 m) läggs samma bro
   tillbaka först när grinden HÅLLIT oavbrutet i mer än nådafristen. Det är
   samma tidsbedömning som borttagningen.
3. **Beväpningen** (nytt, granskarens variant): närmandebeviset beväpnas bara vid
   otillräcklig rörelse, inte vid en tydlig bortrörelse (≥ 10 m bort). Slinga-C
   får tillbaka 7699cbe:s 30 s.

Utfall:
- F05 blir BORTA. Alla andra kort och r2 har samma dom som på 7699cbe.
- Banken (24 korpusar) är byte-identisk med 7699cbe, liksom 72 h-soaken och
  fassvepen. Inget låst facit flyttas.
- Klassvepen med appens generator (756 körningar, klasserna A–L, två eller tre
  kadenser): DEFAULT-FLASH 3 340 → 558 (revision 1: 663). Ingen körning blev
  sämre mot 7699cbe eller mot revision 1. Notiser, öppningsvarningar och
  målbropassager är identiska i alla.
- Granskarens klasser G och H: 562 → 8 (revision 1: 108). Slinga-C: 30 → 30 s
  (revision 1: 150 s). 36 av 36 helappslingor lika med 7699cbe.
- Priset: en avgång under 2,0 kn kan få sin första måltext 30–60 s senare än på
  7699cbe (12 av 58 avgångar i svepen, avsnitt 5.4).

## 0. Omgranskningens punkter och vad som gjorts

| # | Allvar | Punkt | Åtgärd |
|---|---|---|---|
| 1 | medel | Fartgrinden (0,7 kn) mer än 500 m från broar flappar kvar (klass G och H) | Väg 1 införd: fartprovet (avsnitt 3.3). Klass G och H över tre kadenser: 562 → 8 DEFAULT-FLASH (revision 1: 108). Körningen H 0,65 kn s1, som var 9 → 10 i revision 1, är nu 9 → 0. Ingen körning sämre. G och H, och en ny klass I för 0,1 kn-grinden, finns i klassvepet. Regressionstest `KLASS H` (rött på 7699cbe och c6a765d), helapptest med granskarens fil och ett nytt syntetiskt scenario. |
| 2 | medel | FACIT-raden för slinga-C ("rättare") var inte belagd enligt U13 | Granskarens variant införd (avsnitt 3.2). Slinga-C är tillbaka på 30 s (som 7699cbe), och loop-n12-k6-v1.8 på 30 s. Raden i FACIT.md är omskriven: utfallet är nu identiskt med 7699cbe. Granskarens förbehåll (sog=null med kraftigt GPS-brus) är mätt: klass J och K med ±3–20 m brus ger identiskt utfall med revision 1 (avsnitt 5.5). Regressionstest för varaktigheten (rött på c6a765d, grönt på 7699cbe). |
| 3 | låg | Avgångar under 2,0 kn vars första fix inte flyttat sig fördröjs en fix | Inskrivet som rättningens pris i avsnitt 7 och ARCHITECTURE (punkt d). Test `ACCEPTERAT (närmandebeviset)` låser beteendet. Fartprovet har ett eget, likartat pris, som är mätt och låst på samma sätt (avsnitt 5.4). |
| 4 | låg | VALIDATION.md:939 "WARN-baslinjen är 8" var inte uppdaterad | Omskriven: 6 på 7699cbe (INV-15 ×2, INV-18, 3 INV-14W), plus 3 INV-14W från M, alltså 9, med namn och längd per rad och en not till dirigenten. |

**Avbrutet tidigare försök.** Vid start fanns ocommittade ändringar i
`lib/services/VesselDataService.js` och två jämförelseträd i `K/M/tmp/r3/`. De kom
från ett avbrutet försök med samma uppdrag (filerna är från 2026-11-05 02:06–02:12).
Ändringarna var fartprovet och granskarens variant, alltså precis punkterna 1 och 2.
Jag granskade dem rad för rad med `git diff`, behöll dem och slutförde dem. Två
småsaker rättades: ANCHOR_BLOCK-predikatet i `_armReentrySpeedProof` är nu
ordagrant detsamma som i `_shouldAssignTargetBridge`, och K32(c)-kommentaren pekar
på den nya hjälparen. Tester, svep, dokumentation och leveranser saknades och är
gjorda nu.

## 1. Rotorsaken, bekräftad med minsta repro och logg

Minsta repro: värld 933 (R0, 30 s kadens), WILMA 265340152 norrut, kryper 0,5 kn
förbi Klaffbron mot Stridsbergsbron 1,2 km bort. Fixturen
`tests/fixtures/m-f05-wilma-krypfart-norr-om-klaffbron.jsonl` är byte-lik med
buggjägarens `repro.jsonl`. Kört med `REPLAY_VERBOSE=1` på 7699cbe
(`K/M/tmp/runs/F05-base.log`):

```
17:16:00 TARGET_BRIDGE_PASSED Klaffbron → målbro Stridsbergsbron
17:17:30 PROTECTION_ZONE_BYPASS Klaffbron är passerad och ≠ målbro (F21)
17:17:30 2-READINGS 1216 m → 1208 m (−7 m): Insufficient approach movement (min 10 m)
17:17:30 TARGET_GRACE Starting 60s grace period
17:19:00 TARGET_CHANGE "Stridsbergsbron" → "none" | Reason: INSUFFICIENT_MOVEMENT | 0.5kn
17:19:30 PROTECTION_ACTIVE 41m from Klaffbron (≤300m) → Qualifies (0.5kn)
17:19:30 TARGET_CHANGE "none" → "Stridsbergsbron" | Reason: ACCELERATED
Brotext: 17:16:00 "…ETA okänd" → 17:19:30 "Inga båtar …" → 17:20:00 "…om 76 minuter"
```

Mekanismen (radnummer i `lib/services/VesselDataService.js` vid 7699cbe):
1. **Retentionen** (`updateVessel`, :582–660) anropar
   `_shouldAssignTargetBridge(vessel, oldVessel)`. 2-READINGS (:4282–4323) kräver
   `MIN_APPROACH_DISTANCE` = 10 m (`constants.js:148`) sedan FÖRRA FIXEN när målbron
   ligger mer än 300 m bort: 10 m per 30 s ≈ 0,65 kn, per 10 s ≈ 1,9 kn. Varje
   lyckad validering släpper fristen (S-F8), så målbron tas bort först efter
   minst fyra fallerade prov i 30 s kadens (frist > 60 s).
2. Skyddszonen hjälper inte: F21 häver den när närmaste bro redan är passerad och
   inte är målbron (:562–578).
3. **Tilldelningen** (ACCELERATED, :733) anropar samma funktion utan gammal målbro,
   så 2-READINGS hoppas över. Fartgrindarna (:4377–4383) mäter mot NÄRMASTE bro och
   prövas per sampel. ANCHOR_BLOCK (:4144) kräver passerad bro OCH känd fart.

**Fartgrindens syskon (omgranskningens punkt 1), bekräftat i logg.** Granskarens
fil `H_langtfran_syd_stallbacka-0.65-30s-s1.jsonl` (nu fixturen
`m-f05-fartgrind-0.65kn-soder-om-stallbackabron.jsonl`) och H 0,7 kn s2 med full
debuglogg (`K/M/tmp/r3/H07s2.log`): båten kryper 0,6–0,75 kn 700–1100 m söder om
Stallbackabron. Retentionen tar bort Stridsbergsbron efter 90 s med fyra prov
≤ 0,7 kn i rad (`TARGET_CHANGE … Reason: ANCHORED | Grace period: 90s`). På
7699cbe och c6a765d lade ACCELERATED tillbaka den på nästa prov över 0,7 kn. Med
revisionen syns `REENTRY_SPEED_PROOF … grinden har hållit 0s / 30s / 60s (krav
> 60s)`, och tilldelningen sker först på fjärde provet i rad över grinden.

**Rättelse av triagen** (oförändrad): LOW_SPEED och INSUFFICIENT_MOVEMENT är
etiketter från `_getTargetRemovalReason`, inte grindar.

## 2. Klustret: 17 världar, två mekanismer

Oförändrat (`K/M/matningar/kluster-F05-klassning.txt`):

| Mekanism | Världar | Vad som händer |
|---|---|---|
| **A, krypfartsflappen (familj M)** | 933, 757 | Samma fartyg tappar målbron och får den tillbaka nästa fix. |
| **B, U1/C11 och ett annat fartyg** | 182, 495, 621, 691, 715, 876, 1024, 1031, 1038, 1199, 1323, 1590, 1887, 1910 (och 138 i KONFLIKT-klustret) | Fartyg A är tyst i jsonl i 904–1523 s och tas bort ur texten (`STALE_DISPLAY_DROP`, trappan 10/15/20/25 min). Sedan dyker ett ANNAT fartyg upp med samma signatur. |
| **C, U1/C11 och samma fartyg** | 1526 (kortets r2) | ELSA MARIA är tyst i 25 min i kön vid Järnvägsbron, tas bort och syns igen när hon hörs. |

B och C är beslutat beteende (U1, `docs/etapp7-plan-2026-08-08.md:8`; C11 och
trappan i C11b). Granskaren har kontrollerat tystnaden i rå jsonl för 1526, 495
och 1323. F05/r2 står därför kvar som KVAR tills dirigenten lagt in registerposten
(avsnitt 13).

## 3. Rättningen på kodnivå

Allt ligger i `lib/services/VesselDataService.js`.

### 3.1 Ett närmandebevis (oförändrat från revision 1)

- **`_targetApproachEvidence(vessel, prevFix, windowRef, bridge)`**: räknar
  närmandet mot `bridge` från den av två referenser som ger STÖRST närmande, förra
  fixen och fönstrets startposition, och säger vilken (`source`).
- **2-READINGS** använder hjälparen med `windowRef =
  _graceApproachReference(vessel, oldVessel.targetBridge)` (nådafristens start).
  Fönstret kan bara lägga till godkännanden.
- **`_getTargetRemovalReason`** räknar etiketterna med samma bevis.

### 3.2 Återinträdets närmandebevis, med ändrad beväpning

- **Beväpning** (`_armReentryApproachProof`, anropas i retentionsblocket före
  raderingen av fristens post): beväpnar bara när borttagningen föll på
  OTILLRÄCKLIG rörelse, alltså mer än 300 m kvar och ett närmande i intervallet
  (−10 m, +10 m) enligt samma bevis. **Nytt i revision 3:** en tydlig bortrörelse
  (närmande ≤ −10 m, MOVING_AWAY) beväpnar inte. Det är en båt under gång som
  svänger, inte en krypare vars närmande drunknar i bruset, och där gäller
  7699cbe:s återtilldelning. Med beväpning stod "Inga båtar" 150 s i stället för
  30 s i slinga-C, för en båt som enligt korsningarna var på väg mot målbron hela
  tiden (Klaffbron 17:00, Stridsbergsbron 17:17, ingen återkorsning).
- **Prövning** i `_reentryNeedsProof` (förut `_reentryNeedsApproachProof`), med
  retentionens undantag: målbron inom 300 m, skyddszonen kring en opasserad bro
  eller målbron (F21-regeln) och kö-zonen (`_isInTargetQueueZone`). Anroparen
  hoppar över provet vid en bekräftad vändning och när meddelandets egen fart
  (`_rawPositionSog`) är minst `FIX_D_MIN_SOG` (2,0 kn).
- **Livscykel** (`_maintainReentryApproachProof`, oförändrad): förbrukas med en
  målbro, glider annars med fristens längd och startar aldrig på en GPS-misstänkt
  position.

### 3.3 Återinträdets fartprov (nytt, väg 1)

- **`_targetSpeedGate(vessel)`** (ny): fartgrindarna ur `_shouldAssignTargetBridge`,
  utbrutna ordagrant. Närmaste bro över hela registret, > 500 m ⇒ farten måste vara
  > 0,7 kn, 300–500 m ⇒ > 0,1 kn, ≤ 300 m ⇒ ingen gräns, och bara känd fart kan
  fälla (helgranskningen 2026-07-06). `_shouldAssignTargetBridge` anropar
  hjälparen med samma loggrader som förut, så tilldelning, retention och
  återinträde dömer med exakt samma grind.
- **Beväpning** (`_armReentrySpeedProof(vessel, now)`, anropas bredvid
  närmandebevisets beväpning): sätter `vessel._reentrySpeedProof = {bridge, t,
  holdsSince: null}` när borttagningens sampel fälls av fartgrinden. Den
  beväpnar INTE när ANCHOR_BLOCK (passerad bro och känd fart under 0,3 kn) fällde
  samma sampel. Då är borttagningen FIX B:s, och FIX B:s återtilldelning per fix
  (≥ 0,3 kn) är ett dokumenterat beslut som lämnas orört. Det gör också att en
  avgång efter ett stopp vid en passerad bro inte fördröjs av fartprovet.
- **Loppet** (`_maintainReentrySpeedProof`, sist i `updateVessel` bredvid
  närmandebevisets livscykel): har fartyget en målbro är posten förbrukad. Annars
  är `holdsSince` det första provet i en obruten följd där grinden HÅLLER. Ett
  prov där grinden fäller, eller en GPS-misstänkt position, bryter följden.
  Posten byts mot ett nytt objekt i stället för att muteras, eftersom
  `_createVesselObject` bär den vidare från förra fixen.
- **Prövning** (`_reentryNeedsProof`): tilldelningen av SAMMA bro väntar tills
  `now − holdsSince > TARGET_REMOVAL_GRACE_PERIOD`. Det är samma jämförelse som
  retentionens `graceElapsed > TARGET_REMOVAL_GRACE_PERIOD`. I 30 s kadens tas
  målbron alltså bort på fjärde fallerade provet och läggs tillbaka på fjärde
  hållande provet, och i 10 och 60 s kadens gäller samma symmetri. Undantagen är
  desamma som för närmandet.

### 3.4 Konstanterna

Inga nya. `TARGET_REMOVAL_GRACE_PERIOD` (60 000 ms) och `TWO_READINGS_NEAR_TARGET_M`
(300 m) ligger på modulnivå sedan revision 1. Fartgrindarnas tal (0,7, 0,1, 500 m,
300 m) och ANCHOR_BLOCK:s 0,3 kn är oförändrade och står kvar på sina ställen.

## 4. Övervägda alternativ

| Alternativ | Varför inte |
|---|---|
| **Väg 2 (granskaren): klassa fartgrindens flapp som ägarbeslut** | Dirigenten valde väg 1. |
| Fartprov med fast fönster från borttagningen ("ett prov över grinden efter minst 60 s") | En båt kring 0,7 kn får då tillbaka målbron efter 60 s på ett enda prov och tas bort igen efter 90 s: en långsammare flapp som INV-14 ändå fångar. Kravet måste vara OAVBRUTEN hållning, som retentionens borttagning. |
| Räkna loppet från beväpningen i stället för från första hållande prov | Prövat som mutation M11: fälls av fyra test, och H-filen ger flapp igen. |
| Beväpna fartprovet även när ANCHOR_BLOCK fällde samma prov | Mutation M8: fördröjer en avgång efter stopp vid en passerad bro med upp till tre fixar (testet `ACCEPTERAT (närmandebeviset)` blir rött), och ändrar FIX B:s beslutade per-fix-regel. |
| Positionsbaserad fart som bevis i fartprovet | GPS-bruset (±3 m per fix) ger ±0,4 kn i 30 s kadens, mer än marginalen kring 0,7 kn. |
| Låta ett tydligt fartöverskott (t.ex. dubbla grinden) räknas som bevis direkt | Ny tröskel, alltså ny parameter. Fartundantaget vid 2,0 kn (FIX_D_MIN_SOG) är grenens befintliga ribba. |
| Behålla beväpningen vid MOVING_AWAY (revision 1) | Slinga-C 150 s och loop-n12-k6-v1.8 120 s "Inga båtar" för en båt på väg mot målbron, inte belagt enligt U13 (punkt 2). |
| Beväpna vid MOVING_AWAY bara för sog=null eller låg fart | Mätt behövs inte: klass J och K (sog=null, ±3–20 m brus) är identiska med revision 1 även med granskarens variant. Ett extra villkor vore utan verkan. |
| Hysteres (högre krav för återinträde än för retention) | Stänger även brusbandet men kräver en ny parameter. Inte beslutat; brusbandet är en känd gräns (avsnitt 7). |
| Fönstret ensamt, OR-varianten ensam, fast återinträdesfönster, fönster från fristens start, inget fartundantag, den burna `vessel.sog`, lägre fartundantag, ANCHOR_BLOCK för sog=null, retentionen behåller målbron, fönstret upphäver ANCHOR_BLOCK | Oförändrat från revision 1: underkänner fixar som 7699cbe godkände, lämnar syskonen, ger långsammare flapp, fördröjer avgångar, släpper igenom sog=null-syskonet, öppnar kajspikar, bryter dokumenterade beslut eller flyttar facit i 20260917-7h. |
| **Valt: retentionens båda prov speglade i återinträdet, med retentionens undantag** | Inga nya konstanter, inget facit flyttas, banken byte-identisk och inget svep sämre. |

## 5. Hela klassen prövad

Alla svep körs i tre träd: 7699cbe (`K/M/tmp/r3/tree-7699cbe`), revision 1
(`tree-c6a765d`) och revisionen. Skript och utdata ligger i `K/M/tmp/r3/` och
sammanfattningarna i `K/M/matningar/`. Appens generator har ±3 m GPS-brus och
±0,1 kn fartbrus, och varje punkt körs med tre seeds. Svepen kördes på
ögonblicksbilden `tree-wip1`. Den skiljer sig från `454850a` bara i en kommentar
och i hur ANCHOR_BLOCK-predikatet skrivs i `_armReentrySpeedProof`
(`Array.isArray(...)` mot `Boolean(... && ...)`), alltså samma utfall för
`passedBridges`, som alltid är en lista. Regressionstestet, batteriet, banken,
världarna, slinga-C och motorn är körda på `454850a`.

### 5.1 Fartgrinden: klasserna G, H och I (`matningar/klassvep3-GHI.txt`)

- G: 530–830 m norr om Olidebron norrut, 0,6–0,9 kn (granskaren).
- H: 560–1650 m söder om Stallbackabron söderut, 0,6–0,9 kn (granskaren).
- I (ny): 300–500 m söder om Olidebron norrut, 0,05–0,2 kn, alltså 0,1 kn-grinden.

DEFAULT-FLASH summerat, 7699cbe → revision 1 → revisionen:

| Klass | 10 s | 30 s | 60 s |
|---|---|---|---|
| G | 75 → 6 → 1 | 13 → 11 → 1 | 3 → 3 → 1 |
| H | 403 → 36 → 0 | 53 → 37 → 4 | 15 → 15 → 1 |
| I | 232 → 9 → 9 | 107 → 10 → 10 | 18 → 5 → 4 |

- 162 körningar. Ingen blev sämre mot 7699cbe eller revision 1.
- Notiser, öppningsvarningar och målbropassager är identiska i alla 162.
- Resten i G och H (8 utslag) ligger vid 0,65–0,75 kn (G 0,7 s3 i 10 och 30 s,
  H 0,7 s2 i 30 och 60 s, H 0,75 s2, G 0,65 s2 i 60 s). Där brusar farten kring
  själva grinden, så båten tar 2–3 min att tas bort och lika lång tid att komma
  tillbaka. Det är brusbandet, inte flappen. I klass I ligger resten vid
  0,15–0,2 kn, alltså närmandets brusband (som i klass A).
- "Inga båtar" blir längre inom resan i G och H (H 30 s: 14 520 → 21 360 s
  summerat). Det är avsett: en båt i 0,6–0,7 kn mer än 500 m från broar ska enligt
  fartgrinden vara mållös ("likely anchored"). På 7699cbe syntes hon i 30–90 s
  åt gången mellan borttagningarna.
- Ett fatalt utslag syns i H 0,8 kn 10 s (ETA-SÅGTAND UPP 20→26 på 30 s, tre
  seeds). Det finns likadant i revision 1, och på 7699cbe doldes det av flappen.
  Det hör till ETA-kedjan (familj E/E2) och redovisas som kort till dirigenten
  (avsnitt 13).

### 5.2 Närmandet: klasserna A–E (`matningar/klassvep3-AE.txt`)

Samma klasser som i revision 1 (A ej passerad söder om Olidebron, E ej passerad
norr om Stallbackabron, C sog=null-krypning, D stopp med sog=null och med känd
fart, B känd fart efter passerade Klaffbron), 0,1–0,5 kn, 450 körningar.

| Klass | 10 s | 30 s | 60 s |
|---|---|---|---|
| A | 455 → 63 → 62 | 243 → 36 → 34 | 44 → 9 → 8 |
| B | 288 → 67 → 67 | 109 → 30 → 30 | 22 → 17 → 17 |
| C | 405 → 54 → 54 | 147 → 13 → 13 | 60 → 11 → 11 |
| D sog=null | 36 → 0 → 0 | 21 → 0 → 0 | 0 → 0 → 0 |
| D känd fart | 0 → 0 → 0 | 0 → 0 → 0 | 0 → 0 → 0 |
| E | 82 → 21 → 21 | 40 → 15 → 15 | 16 → 7 → 7 |

Ingen körning blev sämre, och notiser, varningar och passager är identiska.
Revisionen är identisk med revision 1 utom i klass A, där fartprovet tar ytterligare
fyra utslag vid 0,1 kn-grinden.

### 5.3 Slingor och vändning (omgranskningens punkt 2)

- **slinga-C i hela appen:** 7699cbe 30 s "Inga båtar", revision 1 150 s,
  revisionen 30 s (`matningar/slinga-C-rev3.txt`). Signaturen för notiser,
  varningar och passager är identisk i alla tre.
- **Granskarens 36 helappslingor** (`scen-loop.json`, med varaktighet): revisionen
  är lika med 7699cbe i alla 36. Revision 1 hade loop-n12-k6-v1.8 30 → 120 s.
- **Granskarens 60 slingor i VDS-riggen** (`loopdur.sh`): 60 av 60 lika med både
  7699cbe och revision 1.

### 5.4 Avgångar och rättningens pris (omgranskningens punkt 3)

Mätt som tiden från avgångens första fix till första "på väg mot"-text, i
7699cbe → revision 1 → revisionen (`matningar/avgangssvep.txt`).

- **Granskarens 30 avgångar** (`scen-dep.json`: stopp 100, 300 och 500 m norr om
  passerade Klaffbron, 0,5–2,5 kn, känd fart och sog=null): revisionen är identisk
  med revision 1 i alla 30. Fartprovet beväpnas inte där, eftersom ANCHOR_BLOCK
  fäller stoppet. Mot 7699cbe står närmandebevisets pris kvar vid 500 m:
  dep-at500-v{1.0,1.5,1.9}-sog 0 → 30 s (granskarens tre fall) och v0.5-sog
  0 → 60 s. Avgångens första fix har fart men samma position, och farten under
  2,0 kn räknas inte som bevis i sig. Åt andra hållet blir dep-at500-v0.5-null
  90 → 30 s och v1.0-null 30 → 0 s.
- **Nytt svep, 28 avgångar från stopp utan passerad bro** (`scen-dep-fart.json`:
  ≈ 570 m söder om Olidebron (0,7 kn-grinden), ≈ 400 m söder om Olidebron
  (0,1 kn-grinden) och ≈ 700 m norr om Stallbackabron; 0,3–2,5 kn; med och utan
  orörlig första fix, "f0"). Fördröjning mot 7699cbe, med första fixen flyttad /
  orörlig:

| Stopp | 0,3 kn | 0,8 kn | 1,0 kn | 1,5 kn | 1,9 kn | 2,5 kn |
|---|---|---|---|---|---|---|
| 570 m söder om Olidebron | – | 0 / 0 | +30 s / 0 | +60 s / +30 s | +60 s / +30 s | 0 / 0 |
| 400 m söder om Olidebron | +30 s / 0 (revision 1:s pris) | 0 / 0 | – | +60 s / +30 s | – | 0 / 0 |
| 700 m norr om Stallbackabron | – | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

  I alla sju fall med fartprovets fördröjning kommer texten 90 s efter avgången
  (fyra hållande prov i 30 s kadens), mot 30–60 s på 7699cbe. Notiser och
  öppningsvarningar är identiska i alla 28. Fördröjningen gäller bara 1,0–1,9 kn
  och syns inte från 2,0 kn, där fartundantaget gäller. Vid 0,8 kn och norr om
  Stallbackabron kom texten lika sent redan på 7699cbe. Det är priset för att
  retention och återinträde ska döma symmetriskt. Testet `ACCEPTERAT
  (fartprovet)` låser beteendet i riggen, där målbron kommer tillbaka på fjärde
  fixen i 1,5 kn och direkt i 2,5 kn.
- **Sammantaget, 58 avgångar:** 12 får texten senare än på 7699cbe (högst
  +60 s), 2 tidigare och 44 samtidigt. Revisionen ger 7 senare än revision 1
  (fartprovet) och 0 tidigare.
- **72 h-soaken:** identisk med 7699cbe (761 textövergångar och samma 6 INV-14W),
  alltså inga avgångar i soaken fördröjda.

### 5.5 GPS-brus (granskarens förbehåll för varianten)

`matningar/klassvep3-JKL.txt`, 30 och 10 s kadens:
- J: sog=null-stopp 20 min 60 m norr om passerade Klaffbron, brus ±3, 5, 8, 10,
  15 och 20 m.
- K: sog=null-krypning 0,1–0,5 kn med ±10 m brus.
- L: samma stopp med känd fart, ±3–20 m (kontroll).

| Klass | 10 s | 30 s |
|---|---|---|
| J | 135 → 41 → 41 | 94 → 27 → 27 |
| K | 151 → 82 → 82 | 73 → 38 → 38 |
| L | 0 → 0 → 0 | 0 → 0 → 0 |

Revisionen är körning för körning identisk med revision 1, så varianten öppnar
inget nytt. Resten i J ligger vid ±8 m brus och uppåt, där topp till dal är minst
16 m och bruset själv kan ge 10 m skenbart närmande inom ett fönster. Det är en
känd gräns (avsnitt 7, punkt c).

### 5.6 Första omgångarnas svep (oförändrat utfall)

`K/M/matningar/klassvep.txt` (krypfart vid alla broar, kadens 10–180 s) och
granskarens filer från granskningen 2026-11-04: utfallet är detsamma som i
revision 1.

## 6. Världarna 933 och 757

Utfallet är identiskt med revision 1 (hela resultat-JSON:en utom heap).

| Värld | 7699cbe | revisionen |
|---|---|---|
| 933 (minsta repro) | DEFAULT-FLASH 17:19:30; kl. 17:21 "om 72 minuter" | ingen blink; kl. 17:21 "om 15 minuter" |
| 757 | DEFAULT-FLASH 14:05:29; kl. 14:06:29 "om 72 minuter" | ingen blink; kl. 14:06:29 "om 15 minuter" |

Sanningen (L0): WILMA korsar Stridsbergsbron 17:30:40 och ALVA 14:19:20.
Notiser, öppningsvarningar och passager är identiska (FACIT.md).

## 7. Beslutat: väg 1 och rättningens kända gränser

**Beslut (dirigenten 2026-11-05):** granskarens väg 1, alltså tidsbedömningen även
för fartgrinden, och slinga-C får inte bli sämre. Båda är införda (avsnitt 3.2 och
3.3). Revision 1:s förslag om ett ägarkort för hysteres ("Hysteres för målbrons
rörelsebevis") bärs inte vidare: ingen hysteres införs. De kvarvarande fallen
nedan är kända gränser. Motorn registrerar dem (avsnitt 13), så att de inte blir
nya kort.

a. **Brusbandet kring varje tröskel.** Retention och återinträde kräver samma
   bevis, så en båt med jämn fart nära en tröskel avgörs av bruset, åt båda
   hållen. Närmandet: 10 m per fönster ≈ 0,22 kn vid 30 s, 0,28 kn vid 10 s och
   0,16 kn vid 60 s kadens (A 30 s: 34 utslag kvar, C: 13). Fartgrinden: 0,7 kn
   (G och H: 8 utslag kvar över tre kadenser). Klass I (0,05–0,2 kn 300–500 m
   från Olidebron, där 0,1 kn-grinden och närmandets band sammanfaller): 23.
   Förekommer 0 gånger i banken.
b. **ANCHOR_BLOCK:s 0,3 kn med fartbrus** (FIX B). Retentionen bedömer över fristen,
   tilldelningen per fix (B 30 s: 30 kvar). Det är ett dokumenterat beslut som
   rättningen medvetet inte ändrar. Förekommer 0 gånger i banken.
c. **sog=null med kraftigt GPS-brus.** Vid ±8 m och mer kan bruset ge 10 m
   skenbart närmande inom ett fönster (J 30 s: 27 kvar av 94). Samma i revision 1.
d. **Priset: avgångar under 2,0 kn.** En till två fixar senare när avgångens
   första fix inte flyttat sig eller farten är låg (närmandebeviset). Upp till
   90 s efter avgången (högst 60 s senare än 7699cbe) i 1,0–1,9 kn efter ett stopp
   mer än 300 m från alla broar utan passerad bro (fartprovet). I avgångssvepen
   gäller det 12 av 58 avgångar. Notiser, öppningsvarningar och passager påverkas
   inte i något svep.
e. **Krypning som övergår i fart inom 5 min.** En båt som med rätta blivit mållös
   och sedan får fart igen inom 5 min ger en DEFAULT-FLASH enligt INV-14. Texten
   har samma signatur före och efter, och appen beter sig konsekvent (samma klass
   som ett kort stopp med känd fart).
f. **Fartspikar på minst 2,0 kn hos en stillaliggande båt** släpper igenom
   återinträdet som på 7699cbe, så utfallet blir aldrig sämre än förut. Söder om
   Kanalinfarten har FP9-H' ett eget skydd.
g. **U1/C11-utslagen i F05:s kluster** är beslutat beteende (avsnitt 2).

## 8. Samspel med andra familjer

- **Delad fil `VesselDataService.js`.** M:s hunkar på 7699cbe-sidan: :85–90
  (modulkonstanterna), :584–659 (retentionsblocket: fristens längd, kö-zonens
  utbrytning, båda beväpningarna), :725–731 (M6), :821–826 (ACCELERATED),
  :937–942 (lagringen, båda livscyklerna), :4284–4407 (2-READINGS och
  fartgrindarnas utbrytning), :5547–5552 (`_createVesselObject`), :7939–7957
  (hjälparna) och :8076–8095 (etiketten). R1 har :443–471, :6701–6800 och
  :6952–6977, och R2 har :5150, :5472, :6018, :6409, :7038 och :8296. Ingen hunk
  överlappar. ACCELERATED-villkoret läser `fixDReversalConfirmed` och
  `FIX_D_MIN_SOG` ur Fix D-blocket som R1 ändrar. Integrationen bör kontrollera
  att uttrycket är detsamma som tredje argumentet till `_shouldAssignTargetBridge`.
- **Fartgrindarnas utbrytning** (`_targetSpeedGate`) ligger i
  `_shouldAssignTargetBridge`, som R1 och R2 inte ändrar i sina patchar. Ändrar en
  annan familj fartgrindarna senare måste ändringen göras i hjälparen, inte i
  anroparen. Annars glider återinträdet isär från tilldelningen igen.
- **R1 (vändning).** En bekräftad vändning hoppar över båda proven, precis som
  2-READINGS. J12 släpper fristen vid vändning.
- **R2 (passage och notis).** En mållös båt bokförs via mellanbrovägarna som förut.
  Proven gäller inte inom 300 m från målbron respektive närmaste bro, så en
  målbropassage förblir en målbropassage. Passager och notiser är identiska i alla
  svep. R2 använder `_rawPositionSog` med samma betydelse.
- **N, K och K2.** Inga delade funktioner. Notiser och öppningsvarningar är
  identiska i banken, i svepen och i världarna.
- **E och E2 (ETA-kedjan).** M rör ingen ETA-kod. En krypare som behåller målbron
  behåller sin ETA-serie, vilket gav sannare ETA i 933 och 757. ETA-sågtanden i
  H 0,8 kn 10 s (avsnitt 5.1) är E/E2:s, och den syns nu när flappen inte döljer
  den.
- **`runSyntheticScenarios.js`.** M använder seed 94–99 och mmsi 901000094–099
  (sex scenarier, det nya har seed 96). R1, N och K2 delar seed 92 och 93 med
  varandra. Antalet "52" i VALIDATION.md gäller bas plus M och måste summeras vid
  integrationen, liksom WARN-baslinjen (6 + 3).
- **Dokumenten.** VALIDATION.md:66 (antalet scenarier) och insättningen efter
  :344–349 (§Syntetiska scenarier) ändras också av R1, N och K2. Det blir
  textkonflikter vid integrationen men inga sakkonflikter. ARCHITECTURE.md :776–781
  ligger nära K:s och K2:s :738–744 utan att överlappa.

## 9. Användarbesluten och dirigentens beslut

- **U13:** inget låst facit flyttas. Banken är byte-identisk med 7699cbe. Raden för
  slinga-C, som omgranskningen underkände, är omskriven: utfallet är nu identiskt
  med 7699cbe (FACIT.md).
- **U14 och U15:** notiser, målbropassager och öppningsvarningar är oförändrade i
  banken, i alla svep (756 klassvepskörningar, 36 + 60 slingor, 58 avgångar) och
  i världarna.
- **U16–U21:** rörs inte. B- och C-utslagen i F05:s kluster hör till U1/C11 och
  registreras av dirigenten.
- **Dirigentens beslut för M (2026-11-05):** väg 1 införd, slinga-C tillbaka på
  7699cbe:s 30 s med granskarens variant (avsnitt 3.2–3.3 och 7).

## 10. Dokument

Uppdaterade i prototypen:
- `docs/ARCHITECTURE.md` §4 "Target-livscykeln (VDS)": de tre speglade delarna
  (närmandet, återinträdet med ändrad beväpning, fartprovet), hjälparnas namn och
  de kända gränserna (a)–(d) med priset.
- `docs/VALIDATION.md`: antalet syntetiska scenarier (52), stycket
  "Krypfartsscenarierna" med det nya fartgrindsscenariot och WARN-baslinjen
  (6 på 7699cbe + 3 INV-14W från M = 9, med en not till dirigenten).

För dirigenten:
- Summera antalet scenarier och WARN-baslinjen med de andra familjernas.
- Registerposterna i avsnitt 13.
- Ingen ändring i CLAUDE.md.

## 11. Regressionstest och mätningar

**`tests/m-krypfart-malbron-2026-11-04.test.js`, 35 test** (11 nya), med två nya
fixturer (granskarens H-fil och slinga-C). Utfall per träd
(`K/M/matningar/regressionstest-rev3-mot-*.txt`):

| Träd | Gröna | Röda |
|---|---|---|
| 7699cbe | 12 | 23 (kryparna, syskonen, fartgrinden, världen 933, H-filen, hjälparnas enhetstest och de två ACCEPTERAT-testen) |
| c6a765d (revision 1) | 27 | 8 (fartgrinden: KLASS H, dess kontroll, `_targetSpeedGate`, livscykeln, H-filens DEFAULT-FLASH och ACCEPTERAT (fartprovet); slinga-C:s varaktighet och beväpningens enhetstest) |
| revisionen | 35 | 0 |

Nya test:
- `KLASS H`: krypare kring 0,7 kn mer än 500 m från broar.
- Kontrollen att målbron kommer tillbaka när grinden hållit i mer än en frist.
- `_targetSpeedGate` och fartprovets livscykel.
- H-filen i hela appen: ingen DEFAULT-FLASH (7699cbe 9, revision 1 10), samma
  notiser, varningar och passager.
- Slinga-C i hela appen: "Inga båtar" högst 30 s, samma notiser och varningar.
- Beväpningens enhetstest.
- Två ACCEPTERAT-test som låser priset för avgångar under 2,0 kn.

Slinga-C-testet är grönt på 7699cbe och rött bara på revision 1, så det låser
omgranskningens punkt 2.

**Mutationsprov** (`matningar/mutationsprov-rev3.txt`), sex felaktiga varianter
av revisionen. Alla fälls:

| Mutation | Röda |
|---|---|
| M6 inget fartprov | 5 |
| M7 loppet bryts aldrig | 5 |
| M8 beväpna trots ANCHOR_BLOCK | 2 |
| M9 beväpna vid bortrörelse (revision 1) | 2 |
| M10 `>=` i stället för `>` | 4 |
| M11 loppet räknas från beväpningen | 4 |

Revision 1:s fem mutationer (`matningar/mutationsprov.txt`) gäller koden som är
oförändrad.

**Syntetiska scenarier: sex M-scenarier** (nytt: `fartgrind-krypare-söder-om-Stallbackabron`,
seed 96). Det nya scenariot har 9 DEFAULT-FLASH på 7699cbe och 8 på revision 1
(7–12 över seed 94–99). Med revisionen har det 0 över alla sex seeds och en
förväntad INV-14W (2 550 s).

| Mätning | Utfall |
|---|---|
| `npm test` | 355 sviter, 354 gröna. 4 810 test gröna (4 799 + 11 nya), 2 hoppade och 1 rött. Det röda är motorkopians `bugHunt/__tests__/b-register.test.js` ("källfilen docs/BUGGJAKT.md finns inte"), lika rött på 7699cbe. Inga öppna handtag. |
| `npm run replay:all` | Alla låsta korpusar matchar facit. Utskriften är identisk med 7699cbe. |
| Banken byte-jämförd (24 korpusar, full debuglogg) | 0 skillnader i resultat-JSON. Alla TARGET_CHANGE-rader med etiketter är identiska, och båda återinträdesproven slår till 0 gånger (`matningar/bank-bytejamforelse-rev3.txt`). |
| `npm run replay:synthetic` | 52 av 52 rena. De 46 gamla scenarierna och deras WARN-rader är identiska med 7699cbe, och WARN-raderna är 9 (6 + 3 INV-14W). |
| `npm run replay:openings` | Utskriften är identisk med 7699cbe. |
| `npm run replay:monitoring` | 72 h stabil: 0 processfel och 0 fatala. Identisk med 7699cbe utom heap-talet (761 textövergångar och samma 6 INV-14W). |
| `npm run replay:phase` (banken) | 24 av 24 gröna, identiskt med 7699cbe utom tider. |
| `REPLAY_MONITORING=1 npm run replay:phase -- …` (17-7h, 42h, 41h, 13h, 25h, both-21h) | 6 av 6 gröna, identiskt med 7699cbe utom tider. |
| `npm run lint` | Rent. |
| `npm run measure:eta` | Inte omkörd. Bankens texter är byte-identiska med 7699cbe, så ETA-vägen påverkas inte i korpusarna. |

## 12. Motorkontroll

- `hunt.js --repro` för alla 41 kort och r2: F05 BORTA (var KVAR). F05/r2 KVAR
  (U1/C11). Alla andra har samma dom och samma antal utslag som på 7699cbe
  (`K/M/motor-repro.txt`).
- `hunt.js --profile=quick --out=K/M/hunt-quick` (exit 0, självtestet grönt)
  jämfört med `r1-quick-a`: 34 → 34 kluster, 17 → 17 kandidatkluster och 88 → 88
  fynd, identiska fynd för fynd (0 bara i basen, 0 bara i revisionen).
  Fingeravtrycken för rader (3b19a079680f) och fynd (3fca35ae89c7) är desamma som
  i `r1-quick-a`. Inga nya kort (`K/M/hunt-quick-jamforelse.txt`).
- Motorns F-KRYP-familj ger bara 0,4–1,5 kn och aldrig sog=null eller krypning mer
  än 500 m från broar, så quick-körningen ser varken syskonen eller fartgrindens
  klass. De prövas av svepen, regressionstestet och de syntetiska scenarierna.

## 13. Registerposter för dirigenten

1. **U1-C11-TYST-FÖRE-DEFAULT** (F05/r2 och klustrets B- och C-världar), klass
   DESIGN, källa U1 (`docs/etapp7-plan-2026-08-08.md:8`) och C11/C11b (trappan
   10/15/20/25 min). Orakel INV-F, inv [INV-14], klassRegex `DEFAULT-FLASH`.
   Predikatet: varje fartyg som syntes i texten närmast före "Inga båtar" saknar
   AIS-rader i jsonl under minst `STALE_ETA_HARD_THRESHOLD_MS` (10 min) fram till
   fallet. Kan aldrig dölja en äkta flapp av M:s slag, där samma fartyg sänder var
   30:e sekund.
2. **M-BRUSBAND-RÖRELSEBEVIS** (gräns a, b och c), klass KÄND_ÖPPEN, källa
   `docs/ARCHITECTURE.md` §4 (kända gränser a–c) och denna DESIGN §7. Orakel
   INV-F, inv [INV-14], klassRegex `DEFAULT-FLASH`. Predikatet: samma fartyg bär
   texten före och efter "Inga båtar" och sänder hela tiden (inget glapp över
   2 × kadensen). Båtens rapporterade fart under de 5 minuterna före ligger inom
   ±0,1 kn från en av trösklarna 0,1, 0,3 eller 0,7 kn, eller också är hennes
   nettonärmande mot målbron per 60 s mellan 5 och 15 m (eller sog=null med
   positionsspridning över ±8 m). Inga träffar väntas i motorns nuvarande
   profiler (F-KRYP ger 0,4–1,5 kn).
3. **M-AVGÅNG-UNDER-2KN** (gräns d, rättningens pris), klass DESIGN (dirigentens
   beslut väg 1), källa `docs/ARCHITECTURE.md` §4 punkt (d) och testen
   `ACCEPTERAT` i `tests/m-krypfart-malbron-2026-11-04.test.js`. Inget orakel mäter
   tiden till första måltext i dag. Posten behövs först om motorn får ett sådant
   orakel. Predikatet: båtens första fix med fart efter ett stopp har sog under
   `FIX_D_MIN_SOG` (2,0 kn), och fördröjningen är högst
   `TARGET_REMOVAL_GRACE_PERIOD` + en kadens.
4. **Kort till E/E2 (inte M):** ETA-SÅGTAND UPP 20→26 min på 30 s vid
   Stridsbergsbron för en krypare i 0,8 kn i 10 s kadens 560–1650 m söder om
   Stallbackabron (`K/M/tmp/r3/sv-GH/H_langtfran_syd_stallbacka-0.8-10s-s{1,2,3}.jsonl`).
   Utslaget finns likadant i revision 1 och doldes på 7699cbe av flappen.
5. **Statusar:** markera F05 som BORTA. F05/r2 blir BORTA när post 1 finns.
