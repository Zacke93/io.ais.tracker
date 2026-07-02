# Eftermiddagskörningen 2026-07-02 (13:28–15:38) — åtta fel, alla åtgärdade

Körning efter e1a184f med nio fartyg (~2 h 10 min, 97 samples). Alla banor
rekonstruerade ur rå jsonl och korsvaliderade mot apploggen och koden.
Körningen är nu **korpus #7** (`20260702-2h`). Denna omgång åtgärdade
dessutom fyra FÖLJDBUGGAR som fixarna avslöjade i replay-sviten.

## Felen och rotorsakerna (alla fixade)

### FEL 1 — SY FREYJA: två missade notiser (Järnvägsbron + Stridsbergsbron)
211351080 sågs 12:12 stilla söder om Järnvägsbron, togs bort tyst av
cleanup-timern under 20-min-tystnaden och återföddes 12:32 NORR om
Stridsbergsbron — båda broarna korsade i gapet (broöppning!), noll notiser.
**Rotorsak:** target-gaten `!targetBridge && !_finalTargetBridge → return` i
`_checkSkippedBridgesFallback` — en utgående/mållös båt fick aldrig
failsafes. Samma klass som MOSHE-missen men i app-failsafe-lagret.
**Fix:** gaten borttagen (ersatt med `_moored`-undantag); distans-/tids-
gaterna (2000 m/300 s) begränsar redan kandidaterna. Retroaktivt räddade
detta TRE missar i 41h-korpusen (omlåst 78→81, se corpora.js).

### FEL 2 — ELFKUNGEN: missad Stridsbergsbron-notis (persistent dedup över omstart)
265573130 passerade Strids 12:08:30 på en NY resa söderut — notisen
blockerades av 2h-dedupposten från FÖRRA körningen/app-processen
("triggered 95 min ago", återladdad från settings).
**Rotorsak:** persistent dedup var rese-omedveten över omstarter;
journey-reset-rensningen existerar bara i-session.
**Fix:** dedupposterna bär nu riktning (`{t, dir}`, bakåtkompatibel läsning
av äldre rena tal) — motsatt färdriktning = ny passage, samma riktning
blockerar som förut. `_persistentDedupCheck()` är gemensam för alla tre
läsvägarna (proximity/fallback/exit).

### FEL 3 — YEMANJA II: fel målbro i 39 minuter efter gap-passage
257904890 korsade Klaffbron i ett 9-min-gap vars ändpunkter låg utanför
alla geometrimetoders gränser (prev 1015 m/curr 311 m). Failsafen skickade
notisen men target förblev Klaffbron — texten visade "på väg mot Klaffbron,
strax/ETA okänd" i 39 min medan båten låg still vid Järnvägsbron.
MISSED_TARGET_INFERRED kräver en SENARE brolinjekorsning (kom först 13:32).
**Rotorsak:** scenario B-failsafen var notis-enbart.
**Fix:** ny VDS-metod `applyInferredPassage()` — för scenario B (observerat
hopp) appliceras passagen även i VDS: målbro → omedelbar transition
(`GAP_TARGET_INFERRED`), mellanbro → `registerConfirmedIntermediatePassage`
(RC9-inferensen täcker bortom-target-fallet). Scenario A (antagande om
resans start) transiterar ALDRIG.

### FEL 4 — CLABBYDOO: exit-fallbackens stale-gard var död kod
Exit-notisen avfyrades på en 20 min gammal position; F63-garden släppte
igenom allt.
**Rotorsak (två):** (a) `vesselSnapshot` i `removeVessel` saknade
ålderfälten → `vessel.timestamp || vessel._lastSeen || 0` blev alltid 0 →
garden hoppade över sig själv (fältlist-fällan, snapshot-varianten).
(b) 10-min-tröskeln var oförenlig med featuren: exit-fallbacken körs vid
removal som sker via ~20-min-timern — Anomali 10:s egna verifierade fall
hade stoppats.
**Fix:** snapshotten bär `timestamp`/`lastPositionUpdate`/`_lastSeen`;
garden mäter POSITIONSålder (`lastPositionUpdate` — `timestamp` uppdateras
av varje meddelande inkl. namnmeddelanden) med tröskel 25 min; saknade
fält ⇒ avstå (tidigare tyst genomsläpp).

### FEL 5 — Falska passager på väntande båtar (två mekanismer)
(a) **CLABBYDOO 11:37** — `progressive_distance` (konf 0,75) förklarade
henne passerad medan hon driftade 68→103 m på SAMMA sida om Klaffbron
(sog 0,4) och inväntade öppningen; verklig passage 8 min senare.
(b) **YEMANJA II 13:34:45** — distance_fallback tvingade "passed"
(`method: no_passage_detected, confidence: 0.50`) när hon ANKOM till 48 m
söder om Strids för att invänta öppning → texten föll till "Inga båtar" i
själva öppningsögonblicket.
**Rotorsak:** de heuristiska metoderna (1/4/5/6) och distance_fallback
saknade sidbyteskrav — genom en STÄNGD bro kan ingen båt byta sida.
**Fix:** ny geometrihjälpe `hasChangedBridgeSide()` (samma kanalaxel-
projektion som linjekorsningen, ±10 m på-linjen-epsilon) krävs nu i metod
1/4/5/6 och i distance_fallback (som även fått korrekt metodnamn i loggen).
Metod 5:s sidbyteskrav stoppar dessutom U-svängar vid bron.

### FEL 6 — "Strax" utan avståndsgräns vid uttömd extrapolation
`IMMINENT_SET_EXHAUSTED` satte "beräknad broöppning strax" på 433 m
(HAJH-LAIF — verklig öppning 25 min senare), 1016 m (YEMANJA II — redan
FÖRBI målet) och 1419 m (ELFKUNGEN), på 7–10 min gammal data.
**Rotorsak:** Anomali 3-grenen (2026-05-06) saknade övre distansgräns.
**Fix:** exhausted-imminent kräver nu `distToTarget ≤ 500 m` (≈ strax-
bandets räckvidd vid 5 kn); bortom det visas "ETA okänd".

### FEL 7 — Kö-båtar osynliga i texten (RC7-nivåer + kajzonsdemotering)
(a) HAJH-LAIF doldes efter 10 min medan hon KÖADE vid Järnvägsbron (sista
sog-snapshot 2,4 kn slog stillaliggande-undantaget); PAX doldes mitt i
passageögonblicket vid Strids; DEFAULT-fönster uppstod under äkta trafik.
**Fix:** RC7 i `getVesselsForBridgeText` har nu nivåer: stillaliggande
(sog < 1,5) ⇒ 25 min; **kö-klassen** (sog < 3,0 OCH ≤600 m från närmaste
bro) ⇒ 25 min; **mitt-i-passage-klassen** (≤300 m från MÅLBRON) ⇒ 20 min
(INV-14 i korpus #7 visade att 15 min gav en 42-sekunders DEFAULT-flash
innan PAX passagedetektering tog över); SABETH-klassen (rörlig, långt
från broar) behåller 10 min.
(b) ELFKUNGEN moored-klassades på ETT stillasample i kajzonen och
demoterades 4,5 min före sin Klaffbron-passage; följdfel: passagen blev
"intermediate" → ingen TARGET_END → ingen `_finalTargetBridge` → även
Kanalinfarten-exitnotisen uteblev.
**Fix:** zonlagret kräver stillhetsTID — 3 min normalt, 15 min kö-förtur
(target inom 600 m + rörelsebevis). Navstatus-lagret och 2h-backstoppen
oförändrade. Kedjan gav +2 notiser i korpus #7 (Järnvägsbron i gap +
Kanalinfarten-exit, båda verifierade äkta).

### FEL 8 — Trolig falsk Järnvägsbron-notis vid kajavgång
CLABBYDOO:s första sampel låg 67 m bortom kajkapselns norra ände (redan i
4,8 kn) → N7-vakten missade kajavgången → scenario A antog infart norrifrån
och notifierade Järnvägsbron (616 m bakom).
**Rotorsak:** transpondern rapporterar först EFTER avgång — 30 m-kapseln
är för snäv för första-sampel-positionen.
**Fix:** `isNearMooringZone(lat, lon, extraRadiusM)` — N7 använder 100 m
marginal. Priset (äkta transitörer vars första sampel råkar ligga vid
kajen får ingen bakåt-inferens) är samma medvetna "gissa inte"-avvägning
som MOJITO II-klassen.

## Följdbuggar som fixarna AVSLÖJADE (replay-sviten fångade dem)

De falska tidiga passagerna (FEL 5) hade maskerat tre presentationsbuggar
som blev synliga när passagerna började ske vid RÄTT ögonblick:

1. **Echo-flappen** (`fördröjd-gammal-position`): ett GPS-osäkert sampel
   (S-F4 accept_with_caution / GPS-jump-accept) fick driva publicerade
   ETA-hopp — "strax"→"om 4 minuter"→"strax" inom 90 s när en bakåt-
   levererad gammal position accepterades. **Fix:** ETA-omräkningen gatas
   på `_positionUncertain`/`_gpsJumpDetected` i BÅDA beräkningsvägarna
   (meddelande + snapshot); imminent-läget hålls över osäkra sampel.
2. **Fältlist-fällan, imminent-varianten:** `_isImminentAtTargetBridge`
   fanns inte i `_createVesselObject`-fältlistan — flaggan raderades av
   varje meddelande och återuppstod först på nästa 30s-tick, så meddelande-
   triggade textuppdateringar flappade. **Fix:** flaggan kopieras nu.
3. **Teleport-läckan** (`teleport-över-Klaffbron`): i transitionsticken
   ärvde NYA målbron gamla bronns nedräkning — "på väg mot Stridsbergsbron,
   strax" 1,4 km från Strids. **Fix (två lager):** (a) måltransitionen
   nollställer hela ETA-serien (RC4-baslinje, extrapolationstillstånd,
   imminent) och begär färsk beräkning; (b) E-F8:s under-bridge-ETA (0,1)
   sätts BARA när bron under kölen är målbron.

## Replay-utfall

- **6/6 låsta korpusar exakta.** 41h omlåst 78→81 — alla tre nya är
  verifierade äkta korsningar för MÅLLÖSA fartyg (FEL 1-klassen):
  211112870@Strids (72-min-gap), 231898000@Stallbacka (17 h ankrad vid
  Spikön, avgick mållös, korsade i 5,5-min-gap), 265759700@Klaffbron
  (30-min-gap söderut). Fördelningsfacit uppdaterat.
- **30/30 syntetiska scenarier.** Två nya: `återfödd-utflygare-norrut`
  (SY FREYJA-klassen — diskriminerar target-gaten) och
  `gap-över-målbron-utan-geometriträff` (YEMANJA II-klassen —
  diskriminerar via minTargetPassages=2: utan GAP_TARGET_INFERRED
  registreras målbropassagen aldrig).
- **INV-2 riktningsmedveten:** notisdubbletter i MOTSATT riktning är
  fysiska returpassager (per-bro-semantiken) — legitima även utan
  journey-reset-event (Fix D bekräftar inte U-svängar där ruttriktningen
  hinner låsas om av annan mekanism). Samma riktning kräver fortsatt reset.
  (u-sväng-före-Klaffbron notifierar nu korrekt returbenets Olidebron +
  Kanalinfarten — de åts tidigare tyst av riktningsblind dedup.)

## Korpus #7 (20260702-2h) — facit 30, alla diffar mot prod verifierade

Prod gav 26 notiser. Replay med fixarna ger 30:
- **−1** CLABBYDOO@Järnvägsbron (FEL 8 — trolig falsk kajavgångsnotis).
- **+2** SY FREYJA@Järnvägsbron+Stridsbergsbron (FEL 1 — verifierade
  gapkorsningar 12:12→12:32).
- **+1** ELFKUNGEN@Stridsbergsbron (FEL 2 — äkta passage 12:08:30; i prod
  uppäten av omstarts-dedup; replay har inget settings-arv).
- **+2** ELFKUNGEN@Järnvägsbron (äkta korsning i 22-min-gapet 12:08→12:30,
  58.29305→58.28586 spänner 58.29164) + ELFKUNGEN@Kanalinfarten (äkta
  exit; båda möjliggjorda av FEL 7b-fixen: ingen felaktig demotering ⇒
  target kvar ⇒ TARGET_END ⇒ exit-spårning).
- ELFKUNGEN@Klaffbron kommer nu 12:30:30 (proximity 219 m, waiting) i
  stället för 12:35 (79 m) — samma bro, tidigare och ärligare.

## Medvetet INTE åtgärdat

- Järnvägsbron för 211112870 i 41h-korpusen föll utanför scenario A:s
  300s-fönster (~302 s) — "klockan ringer inte efter att tåget gått"-
  policyn står fast.
- PAX Kanalinfarten-exit (last position 460–490 m > 400 m-radien) — kvar
  som designgräns.
- Fix D bekräftar inte U-svängar före målbron när annan mekanism hinner
  låsa om ruttriktningen — ofarligt nu (riktningsmedveten dedup + INV-2
  täcker semantiken), men noterat som framtida städkandidat.
- Ingen positions-medveten invariant ("passage kräver sidbyte") — kräver
  att runnern exponerar per-passage-positioner; sidbyteskravet är i
  stället låst på enhetsnivå (geometri + VDS).
