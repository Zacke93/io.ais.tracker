# Korrigeringar 2026-07-03 — 19,5h-körningen (korpus #8)

Underlag: `logs/app-20260702-174109.log` + `ais-replay-20260702-174109.jsonl`
(2026-07-02 15:41 → 2026-07-03 11:09 UTC, 12 fartyg, 48 notiser i prod).
Användarens direktobservation: en båt hette "Unknown" i notiserna.

Arbetet följde en användargodkänd plan i sju faser: baslinje + mätinstrument,
arkitekturkarta, namnkedjan, gap-kedjan, bridge_text-livscykeln,
geometri/race/hygien, korpuslåsning + invariantskärpning, testexcellens.

## Användarbeslut (2026-07-03)

1. **F8 gränsbro-inferens**: alltid notis vid bekräftad/inferrerad passage,
   även sent upptäckt — 300 s-skattningen ersatt.
2. **Namn-fallback**: "Okänd båt" (aldrig "Unknown") när namnet aldrig blir känt.
3. **Stale docs**: CODEX.md + docs/recentChanges.md raderade;
   docs/ARCHITECTURE.md är enda sanningskällan.

## Fynden och fixarna

### F1 — VALEN: 5 notiser med "Unknown" (namnkedjan, fas 2/B1)

VALEN (265741640) sände `shipName:"Unknown"` i 8 första positionsrapporterna;
riktiga namnet kom 17:09 — efter alla 5 notiserna. Namn↔Unknown flimrar per
meddelande hos 7 av 12 fartyg i körningen. TRE rotorsaker:

1. **Fältlist-fällans 4:e offer (aktiv bugg)**: removal-snapshotten i
   `VesselDataService.removeVessel` kopierade `shipName: vessel.shipName` —
   fältet heter `name`, så `shipName` var alltid `undefined` och snapshotten
   saknade namnet helt ⇒ ALLA notiser via exit-/removal-fallbackvägen fick
   "Unknown", oavsett aisstream. Fix: `name: vessel.name` + permanent
   snapshot-fullständighetstest (`tests/namnkedjan-b1.test.js`).
2. **Ingen persistent namncache**: appen glömde kända namn vid omstart/removal.
   Fix: `known_vessel_names` i Homey settings (mönstret från
   `_persistentRecentTriggers`): `_loadVesselNames`/`_persistVesselNames`/
   `_rememberVesselName`/`_lookupVesselName`, TTL 30 dagar, tak 200 poster
   (äldst-först-eviction), write-throttling (skriv endast vid nytt/ändrat namn
   eller >24 h), TTL-städning i monitoring-loopen. Uppslag i
   `_processAISMessage` FÖRE vesselPatch — även replay-inspelningen bär det
   effektiva namnet.
3. **Statiska AIS-rapporter kastades**: `StaticDataReport` (typ 24 — kanalen
   där Class B-fartyg faktiskt sänder namnet) och `ShipStaticData` (typ 5)
   filtrerades bort före namnextraktion. Fix: fångas nu FÖRE positionsfiltret
   i `AISStreamClient._onMessage`, emit `static-name` → cache + levande
   vessel uppdateras. Skapar aldrig vessel; rör inte feed-watchdogen.

Verifiering: INV-8-varningarna (5 st "Unknown"-notiser i 4 befintliga
korpusar) släcktes helt av snapshot-fixen. Token-fallback är "Okänd båt".

### F2/F5/F3 — Gap-kedjan (fas 3/B2+B3): ELFKUNGEN 3 missade notiser, DIANA 1, fel-bro-text

**ELFKUNGEN (265573130)**: 23-min-gap 10:06→10:29 där Olidebron+Klaffbron+
Järnvägsbron+Stridsbergsbron korsades. Rotorsak (replay-belagd): vid
återkomsten hade båten **cog 50,2°** — kanalen svänger nordost vid
Stridsbergsbron — och cog-gaten (north = cog ≤45°) klassade riktningen som
"öster/osäker" och strök HELA skipped-bridges-kontrollen. Klaffbron-flushen
vid 10:40 (från Stallbacka-positionen) dog sedan på 2000 m-taket (3863 m),
och Järnvägsbron/Stridsbergsbron flushades aldrig. Dessutom RESTORE:ade
target-protection den passerade Klaffbron som målbro (fel-bro-text ~11 min +
ETA-hopp 2→20 min, F3).

**DIANA (265576710)**: 13,8-min-gap; scenario B körde korrekt men
Järnvägsbron @2057 m ströps av 2000 m-taket.

Fixar i `_checkSkippedBridgesFallback`/`_triggerBoatNearFlowFallback`/VDS:

- **Hoppvektorn ger riktningen** för scenario B (`vessel.lat > oldVessel.lat`)
  — cog- och sog-gaterna gäller nu bara scenario A (antagande utan observerat
  hopp). Hoppet ÄR rörelsebeviset.
- **Färdriktningsordning** i kandidatlistan (nord→syd för södergående) så
  target-transitionskedjan i `applyInferredPassage` kaskaderar korrekt
  (Klaff→Strids norrut; Strids→Jvb→Klaff söderut).
- **Inferensen körs FÖRE notisloopen** så transition + passedAt-ankring finns
  när fallbacken bedömer varje bro.
- **`inferredFlush`-undantag från 2000 m-taket**: bron är geometriskt belagd
  mellan hoppets ändpunkter — taket ersätts av färsk position (<2 min) +
  10 km-sanity (`FALLBACK_TRIGGER_STALE_POSITION`/`TOO_FAR`-loggar).
- **B3 protection-release**: `_shouldDeactivateProtection` släpper skydd vars
  bro ligger i `passedBridges`; `applyInferredPassage`/MISSED_TARGET_INFERRED
  deaktiverar explicit (`inferred-passage`/`missed-target-inferred`) före
  transitionen. TARGET_PROTECTION_RESTORE kan inte längre återinsätta en
  passerad bro som target.

**F8-beslutet**: scenario A skickar också `detectionTs: Date.now()` — den
kända-tid-grenen ersätter distans/fart-skattningen som godtyckligt ströp
PHILULA/DIAMOND@Kanalinfarten (medan OLIVIER/ELFKUNGEN fick sina). 2000 m-
taket, sog≥2, kajvakten (N7) och persistent dedupe består för scenario A.

**SPIKEN-följdfixen (avslöjad av F8)**: en ÅTERFÖDD båt (removal→ny instans)
fick porten-antagandet — SPIKEN (231898000) låg ankrad norr om
Stridsbergsbron, avgick, och F8 utan skydd gav falska Jvb+Strids-notiser
(gamla skattningen råkade maskera klassen). Fix: `_lastKnownPositions`
(mmsi→position vid removal, TTL 6 h) begränsar inferensfönstret till
[senast kända, nuvarande] — belagd evidens i stället för gissning. SY FREYJA:s
äkta Jvb+Strids överlever (ligger i fönstret); hennes Klaffbron-gissning dör.

### F7 — VALEN: falskt "Inga båtar" mitt i transit (fas 4/B5)

`UNDER_BRIDGE_TIMEOUT` räknade väggtid: under VALEN:s 13-min-gap under
Järnvägsbron force-clearades latchen (10-min-taket) och texten föll till
"Inga båtar" fast båten var kvar. Fix: stuck-tiden fryses när positionen är
>2 min gammal (basen förskjuts så varaktigheten står stilla under gapet);
äkta ankrat-under-bro med färsk AIS force-clearas som förut (Bug #5 intakt).

### F10/F9/F4 — "strax"-livscykeln (fas 4/B4+B6)

- **B4**: `IMMINENT_SET_EXHAUSTED` ("hon borde vara framme nu") håller nu max
  **90 s** efter uttömningen (`_etaExhaustedAtMs`, nytt fält — tillagt i
  fältlistan!) innan degradering till "ETA okänd". ZWERK/PHILULA stod annars
  2–5 min med fruset "strax" + antalsflimmer på stale extrapolering.
- **B6**: TARGET_END-grenen (slutmålspassage) nollställer nu hela ETA-serien +
  `_isImminentAtTargetBridge` (speglar isTransitionToNext-grenen) — PHILULA:s
  kvarhängande "strax" mot passerad Stridsbergsbron. Plus vakt i
  `BridgeTextService._buildGroupPhrase`: imminent-flaggan räknas inte för en
  båt vars target redan ligger i `passedBridges`.
- **F9 rotorsak (replay-belagd)**: PHILULA:s "strax" stod under ett
  7,5-min-AIS-gap MITT i passagen — passagen kunde inte detekteras förrän
  nästa sample. B4:s 90 s-tak degraderar nu till "ETA okänd" efter
  nedräkning+90 s även i det fönstret.
- **F4 (spöknedräkningen)** var nedströms av F2/F3 (fryst target) — botad av
  fas 3. Kvarvarande SOFT-extrapolering (5–10 min-fönstret, Fix G) är en
  dokumenterad medveten avvägning.
- **F13 (minor)**: ETA-stigning vid äkta inbromsning är korrekt fysik;
  optimistisk extrapolering i gap täcks av Fix G-fönstret. Ingen ändring.

### F11 — Stridsbergsbron-geometrin (fas 5/B7a): INGEN BUGG

Datadriven analys (scratchpad-skript, 4 korpusar): geometrin detekterar
**13/13** verkliga Stridsbergsbron-sidflippar (trajectory/traditional/
enhanced). `NEAR_MISS_PASSAGE ... not_crossed`-raderna loggas för par som
ännu inte korsat (båt på väg MOT bron) — diagnostik, inte missar. Alla fem
"drabbade" fartygen fick sina notiser. Klaffbron-fallet 258715000
(prev=119 m→curr=18 m) avvisas medvetet av isMovingAway (båten UNDER bron)
och fångas av nästa par. Ingen ändring.

### F12 — sub-sekund dubbel-UI (fas 5/B7b)

`_scheduleImmediatePublish` publicerade per händelse via `setImmediate` — två
passage-händelser i samma tick gav två publiceringar med halvfärdigt
mellanläge synligt ("Två båtar"→"En båt" samma sekund, OLIVIER 07:49:57).
Fix: leading-edge-fönster 150 ms samlar bursten till EN publicering; version
sätts vid avfyr (monoton ordning); timern städas i onUninit. Övergångar med
~1 s mellanrum är legitima tillståndsändringar och lämnas.

### F6 — failsafe-loggens status (fas 5/B8)

`vessel.status` beskriver båtens läge mot AKTUELL målbro — för failsafe-
notiser om andra/passerade broar blev loggen missvisande ("under-bridge"
@854 m). Loggen visar nu `passage-inferred` för fallback-notiser >300 m.
`eta_minutes=-1` behålls som okänd-sentinel (bakåtkompatibelt med användarnas
flöden). Flow-trigger-state utökad med `distance` + `source` (för replay-
invarianterna; run-listenern läser bara `bridge`).

### F14 (positivt)

Förtöjda APHRODITE/SOLUTION/NO LIMIT gav 0 notiser/text tills avgång —
kajlogiken från 9d389d0 fungerar i produktion.

## Omlåsningar (alla diffar verifierade mot rå jsonl)

- **41h 81→85**: +BRANIF@Jvb (korsad i 72,6-min-gap; tidigare dokumenterad
  policy-icke-fix, nu levererad), +BRANIF@Olidebron (födelseinferens per
  F8-beslut; kaj-alternativ kan inte uteslutas — accepterad osäkerhet),
  +265759700@Jvb+Strids (korsade i 30,4-min-gap; ströps av 2000 m-taket).
- **19h 47→49**: +SABETH@Strids (41,5-min-gap), +235029263@Klaffbron
  (södergående född söder om Klaffbron — logiskt säker passage: både kaj-
  och Vänern-ursprung ligger norr om bron).
- **11h 24→25**: +MOSHE/211471090@Klaffbron (44,3-min-gap).
- **2h 30→32**: +SIVSIN@Klaffbron (logiskt säker) +SIVSIN@Jvb
  (F8-födelseinferens). SPIKEN-vakten hindrar SY FREYJA:s falska
  Klaffbron-gissning.
- Oförändrade: 20260525, 20260610-förfix, 20260611-4h (regressionsstoppen).

## Korpus #8 (20260702-19h)

Facit **54 notiser** = prods 48 + 6 rättade missar: ELFKUNGEN +3 (Klaff, Jvb,
Strids), DIANA +1 (Jvb), PHILULA +1 + DIAMOND +1 (Kanalinfarten, F8).
Fördelningen per mmsi→bro verifierad mot rå jsonl (facit8-skriptet) och
replay-bekräftad exakt före låsning.

## Nya mätinstrument (fas 0)

- Notisfångsten i replay bär nu `vessel_name`, `eta_minutes`, `distance`,
  `source` + positionsberikning (`vesselLat/vesselLatNext`) + `firstNameSeen`.
- Sex nya WARN-invarianter: INV-8 (namnkvalitet), INV-11 (distansrimlighet),
  INV-15 (riktning-vs-geografi), INV-16 (ETA-fysik), INV-17 (flappbudget),
  INV-18 (mjuk ETA-stigning). Skärps selektivt i fas 6.

## Fas 7 — testexcellens

- **Coverage-konfigen mäter nu lib/** (`tests/jest.config.js`): tidigare
  samlades bara app.js + drivers, så alla services rapporterade 0 %.
- **168 nya enhetstester** för åtta tidigare otestade/tunt testade moduler:
  MessageBuilder (33), ETAFormatter (25), StallbackabronHelper (3),
  PassageWindowManager (19), RouteOrderValidator (22), StatusStabilizer (24),
  VesselLifecycleManager (25), CurrentBridgeManager (17).
- **Scenariogeneratorn utökad**: `nameFromS` (namnbackfill — VALEN-klassen),
  och replayRunner stöder nu **ctrl:'restart'** — ÄKTA processomstart mitt i
  replayen (ny app-instans mot samma settings-store; persistent dedup +
  namncache laddas om på riktigt). Tre nya scenarier:
  `namnbackfill-unknown-20min`, `storgrupp-fem-båtar` (5 samtidiga båtar,
  10 målbropassager, 30 notiser), `omstart-mitt-i-passage` (persistent dedup
  över omstart vaktad av fatala INV-2). Nya expect-optioner:
  `noUnknownTokens` (rå "Unknown" får aldrig nå notistoken),
  `namedNoticesAfterS` (namnkrav efter backfill).
- **Harness-regression hittad och fixad under arbetet**: omstruktureringen
  flyttade av misstag `__TEST_MODE__`-avstängningen till FÖRE `onInit` —
  appen initierades i produktionsläge med övervakningstimers som harnessen
  medvetet hoppar över; scenario 34 tappade en målbropassage. Init körs nu
  åter under TEST_MODE (även vid restart) — dokumenterat i replayRunner.

## Backlogg från fas 1/7-granskningarna (rapporterade, EJ åtgärdade)

**Död kod (borttagningskandidater):**
- `utils/MessageBuilder.js` + `utils/ETAFormatter.js` — require:as ALDRIG i
  produktion (bridge_text byggs via `etaValidation.formatETABroOpeningClause`).
  Karakteriseringstester låser kontrakten tills beslut. MessageBuilder har
  dessutom dubbelt "av" i `buildUnderBridge` och grammatikmismatch mot
  produktionens "om N minuter".
- `utils/StallbackabronHelper.js` — i praktiken tom; instansieras i
  StatusService med ignorerade argument, används aldrig.
- Döda grenar: `PassageWindowManager.getDynamicPassageWindow` (anropas ej),
  `removeVessel`-anropen bakom typeof-vakt i VDS (metoden finns inte),
  StatusStabilizer `no_history`-grenen + flimmergrenen,
  VesselLifecycleManager `getEliminationStats`/`logJourneyAnalysis`,
  CurrentBridgeManager `INCONSISTENT`-loggen.

**Kända buggar i sällan använda vägar (dokumenterande tester finns):**
- RouteOrderValidator `_hasDirectionChanged`: COG exakt 0° (rakt norrut)
  behandlas som saknad kurs — vändning till 0° detekteras aldrig.
- StatusStabilizer: stale stabiliseringsfönster (proposed==previous under
  GPS-hopp nollställer inte starttiden → nästa hopp får ingen stabilisering).
- CurrentBridgeManager: stuck-risk när ANNAN bro blir närmast bortom 500 m
  (lagrat avstånd fryses, currentBridge rensas aldrig) + sätt/rensa-flapp
  för passerad bro i 50–500 m-bandet.
- Stale kommentarer: constants.js "Fyra lager" (är fem), removal-timerns
  "60 sekunder enligt spec" (är 2,5 min), BridgeTextService "app.js:597".

## Medvetna icke-fixar

- SOFT-extrapoleringens nedräkning i 5–10-min-fönstret (Fix G) — medveten
  avvägning, ger bilförare användbar info under normala Class B-gap.
- Textövergångar med ≥1 s mellanrum vid kaskadhändelser — legitima.
- NEAR_MISS_PASSAGE-loggarna behålls som diagnostik.
- BRANIF@Olidebron/SIVSIN@Jvb: födelseinferens där kaj-ursprung inte kan
  uteslutas — accepterade per F8-beslutet ("hellre några fler notiser").
