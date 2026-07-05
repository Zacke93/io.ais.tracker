# Produktionsredo-granskning 2026-07-03

Helkodsgenomgång av io.ais.tracker inför 24/7-produktion, utförd med
13 parallella modulgranskare + adversariell tvåröstsverifiering per fynd
(100 råfynd), två testagenter (143 nya beteendetester), en 72h-syntetisk
soak-körning och full publiceringskontroll. Alla fixar validerade mot
8 låsta korpusar (~101,5 h produktionsdata), 35 syntetiska scenarier,
full jest-svit och 72h-soaken.

## Utgångsläge

Commit `86c5937` (19,5h-körningens fixar): 725/725 jest, 8/8 korpusar,
35/35 scenarier. `homey app validate --level publish`: ren redan före
granskningen.

## Fyndhantering

100 råfynd från granskningen + 2 soak-fynd + testagenternas anomalier.
Verifieringen (2 oberoende skeptiker per fynd) bekräftade/motbevisade;
kreditavbrott lämnade ~57 fynd overifierade — de högprioriterade av dessa
prövades manuellt mot koden under fixarbetet, resten triagerades efter
allvarlighetsgrad. 15 fynd motbevisades och lämnades.

## ÅTGÄRDAT — notispelaren (boat_near)

1. **U-svängd båt fabricerade målbro-passage (soak-belagd, falsk notis
   reproducerad)**: RC9-inferensen ("bro bortom target ⇒ target passerad")
   saknade beviskrav på att resan börjat på anflygningssidan. SOAK-RESA-18
   U-svängde med gammal target kvar (protection/grace) och fick falsk
   Klaffbron-notis @1155 m. Fix: `_targetOriginSideOk`-vakt (baserad på
   `_firstSeenLat`, samma mönster som INFERRED_PASSAGE_SKIP) i BÅDA
   RC9-vägarna. Soakens ETA-oscillation försvann som följdeffekt.
2. **Fix D/U-sväng städade inte target-protection (CONFIRMED high)**:
   RESTORE-grenen skrev tillbaka den övergivna bron som target i upp till
   5 min (B3-vakten besegrad — passedBridges tömd). Fix: protection-släpp i
   Fix D-blocket + publika `clearTargetProtection()` för NEW_JOURNEY-vägen.
3. **GPS-gatens kandidater kunde aldrig bekräftas utan COG**: `NaN < 30`
   alltid falskt ⇒ äkta passager övergavs tyst efter 30 s (samma felklass
   som S-F1). Fix: COG NaN-säkrad i `_isVesselStable`.
4. **Fältlist-fällans 6:e offer (CONFIRMED 3-0)**: removal-snapshotten
   saknade `maxRecentSpeed` ⇒ RC3-stale-gaten i exit-fallbacken degraderade
   till momentan sog och ströp Kanalinfarten-notisen för insaktande båtar
   (0,5–2,6 kn-bandet). Fix: `maxRecentSpeed` + `passedAt` i snapshotten.
5. **sog/cog=null avvisade HELA positionsrapporten**: AIS-spec tillåter
   "ej tillgänglig"; klienten levererar null. Fartyg blev osynliga och
   notiser missades. Fix: valideringen släpper null; `_createVesselObject`
   behåller senast kända sog/cog vid null-sampel; COG 360-sentinelen
   ("ej tillgänglig" enligt ITU-R M.1371) blir null i stället för
   fabricerad nordkurs.
6. **Kanalinfarten strukturellt onåbar för mållösa båtar (CONFIRMED)**:
   proximity-gaten krävde bro-referens — trigger-points nåddes aldrig.
   Fix: gaten släpper även båtar inom triggerradien av en trigger-point.
7. **SPIKEN-vakten var enbart in-memory**: appomstart nollade
   `_lastKnownPositions` och porten-antagandets falska notiser återkom
   (utan gamla tidsstrypet, borttaget av F8). Fix: persistens via settings
   (`last_known_positions`, TTL 6 h).
8. **System-koordination fastnade och gate:ade passage-detektering**:
   (a) per-fartyg `coordinationActive` släpptes bara av en väg som slutar
   anropas ⇒ evig gate för fartyget; fix: tidsbaserad aktiv-bedömning i
   `getCoordination` (koordinationsfönstret ÄR stabilizationCoordinationMs);
   (b) system_wide krävde exakt 0 färska jumpers för släpp ⇒ en ensam
   ihållande multipath-jumper höll HELA systemet gate:at; fix: släpp när
   antalet faller under aktiveringströskeln.
9. **BUG 7-bevarade dedupnycklar raderades av monitoring-städningen inom
   60 s**: sessionslagrets timeout-skydd var dött. Fix: nycklar med färsk
   persistent-post (2h-TTL) behålls.
10. **Riktningsband harmoniserade**: `_dedupDirection` sydband breddat
    135–225 → 135–314° (som `_getDirectionString`) — SV-kurs på returresa
    lagrade dir=null och riktningssläppet slog aldrig.

## ÅTGÄRDAT — textpelaren (bridge_text)

11. **B5-frysformeln var min egen regression från 2026-07-03-arbetet**:
    omappliceringen återanvände redan-förskjuten bas ⇒ ackumulerad
    under-bro-tid KRYMPTE mot noll ⇒ Bug #5-force-clearen (10 min) avfyrades
    aldrig för gles-sändande ankrade båtar (Class B ankrad = 3-min-intervall
    > färskhetsgränsen) ⇒ fastnat "Broöppning pågår". Fix: engångsfryst
    ackumulator `_underBridgeFrozenAccMs` (+ fältlistan).
12. **Imminent-hold utan färskhetsgräns (CONFIRMED)**: en båt som fastnat
    med `_positionUncertain` och sedan TYSTNAT höll sitt "strax" i upp till
    20–25 min. Fix: hold delar F40:s 10-min-färskhetsgräns.
13. **P8-vakten täckte inte "ansluten men döv" (CONFIRMED)**: feedstall +
    sista båtens STALE-removal tvingade ut falskt "Inga båtar" som stod
    tills watchdog-reconnect (20–120 min). Fix: DEFAULT-tvånget gatas även
    på feed-tystnad >5 min (`getConnectionStats().timeSinceLastMessage`).
14. **B6-zombie kunde bli lead**: båt med target i passedBridges
    exkluderades från imminent men kunde driva "strax" via
    etaMinutes<3-grenen som lead. Fix: zombies styr varken imminent eller
    ETA-klausul (räknas i antalet — båten finns fysiskt).
15. **Fel-snapshot publicerade falsk "Inga båtar"**: error-flaggan
    ignorerades och tom vessellista behandlades som tom kanal. Fix:
    guard i `_processUIUpdate` behåller senaste text.
16. **Falsk passage-ankring vid kö-drift**: under-bro-latchens clear
    ankrade passage OVILLKORLIGT — även båtar som backade ut på SAMMA sida
    (3-min-guarden blockerade sedan äkta passagen). Fix: ankring kräver
    verkligt sidbyte (`hasChangedBridgeSide` mot ingångspositionen).
17. **Nödfallbackens ETA-klausul**: extrapolated/imminent-optionerna
    skickas nu till SSOT-hjälparen (hårt "strax" för extrapolerad gissning
    kunde annars visas).

## ÅTGÄRDAT — långtidsdrift

18. **destroy-kedjan**: PassageLatchService (60 s-intervall),
    RouteOrderValidator (2h) och GPSJumpGateService (10 s/5 min) städas nu
    i onUninit; självtest-timern spåras.
19. **SystemCoordinator**: `cleanup()` kopplad till monitoring-loopen
    (anropades aldrig i prod); `removeVessel` normaliserar mmsi-nyckeln
    (typmiss = långsam tillståndsläcka) och rensar debounce-timern.
20. **`_aisRejectLogTimes`** städas (växte obegränsat).
21. **setGpsJumpHold**: timern spåras (clearAllTimers), överlappande anrop
    avbryter föregående, delete endast om holden inte förlängts.
22. **72h-soak etablerad som permanent verktyg**
    (`tests/replay-validation/runSoak.js`): 38 fartyg/3 dygn blandtrafik,
    2 avbrott + 2 äkta processomstarter; facit = 0 processfel, tomma
    per-fartygs-strukturer, fatala invarianter. Avslöjade dessutom en
    harnessbugg (stdout-trunkering vid stora resultat — flush-callback).

## ÅTGÄRDAT — indata-robusthet

23. `.trim()` på icke-sträng-namn kastade och slängde positionsrapporten
    (String-wrap). Klockbakhopp (NTP) gav falskt GPS-hopp en tick
    (negativt delta ⇒ 60 s-antagande). `_isNorthbound(null)` gav
    inkonsekvent riktnings-coercion (nu konservativt söderut-regler).

## ÅTGÄRDAT — Homey-kontraktet (publiceringskontroll)

24. Capability-migrering i device onInit (pre-2026-06-09-enheter saknade
    `connection_status` — eviga skrivfel); död Web API-deklaration
    borttagen; settings `validation`→`pattern`; i18n-nycklar kompletterade
    (en+sv); spara-knappen kräver inte längre API-nyckel för debug_level
    och tvingar bara omanslutning när nyckeln ÄNDRATS; döda composefiler/
    pair-HTML/startOnInstall raderade; README.txt omskriven till ren
    engelsk löptext (App Store-format) + README.sv.txt.
    `homey app validate --level publish`: ren.

## ÅTGÄRDAT — backloggen från 2026-07-03

25. Se §A–C i P6-rapporten nedan (död kod raderad, RouteOrderValidator
    cog=0°/speed-fältet, StatusStabilizer stale-fönster, CBM stuck+flapp
    med fältlisterotorsaken — currentBridge/distanceToCurrent är
    fältlistans 7:e offer, nu åtgärdat med levande hysteres).
    WARN-invarianterna kalibrerade: INV-15 tröskel 55→220 m (kö-drift),
    INV-17 flappbudget skalar med fartygsantal, INV-18 kvarstår WARN
    (dokumenterat: legitim fysik vid inbromsning går inte att skilja utan
    fartdata i textloggen).

## MEDVETET ACCEPTERAT

- `_captureAISReplaySample` loggar varje AIS-meddelande (AIS_REPLAY_SAMPLE)
  — det är korpusinsamlingens designade kanal och användarens arbetsflöde
  för replay-validering. Volymen är hanterbar (~1 rad/meddelande) och
  raderna är grunden för facit-byggena. Ingen ändring.
- INV-18 (mjuk ETA-stigning) förblir WARN — en båt som saktar in får äkta
  stigande ETA; utan fartdata i textövergångarna kan invarianten inte
  skilja det från stale-extrapolering.
- `eta_minutes=-1` behålls som okänd-sentinel i Flow-token
  (bakåtkompatibelt med användarnas flöden).
- 15 motbevisade granskningsfynd (bl.a. setGpsJumpHold-racens allvar,
  cog=null-coercionen i terminalbro-bestämningen, klockbakhopps-clampen i
  extrapoleringen) — skeptikerna belade skydd på andra nivåer; de
  billigaste fixades ändå som robusthetshöjning.

## ÅTERSTÅR (kända, ej blockerande)

- ~40 overifierade låg-severity-fynd från granskningen (dokumentation,
  kosmetik, teoretiska races med befintliga skydd) — triagerade som
  icke-blockerande; listan finns i granskningsjournalen.
- Verklig fältvalidering: alla fixar är replay-/soak-validerade men den
  slutliga domaren är en ny produktionskörning (korpus #9-kandidat).

## SLUTLÄGE OCH REKOMMENDATION

**Slutbatteri (allt grönt):**
- Jest: 792/792 tester, 72 sviter (nettoförändring −77 mot 869: död kods
  karakteriseringstester raderade tillsammans med modulerna, +nya
  regressionstester för fixarna).
- Replay: 8/8 låsta korpusar EXAKTA (~101,5 h produktionsdata) — ingen
  enda notissiffra eller fördelning ändrades av någon fix.
- Syntetiska scenarier: 35/35 rena.
- 72h-soak: stabil — 0 processfel, alla per-fartygs-strukturer tomma efter
  tre dygn + efterspel, fatala invarianter rena (3 dokumenterade
  INV-18-WARN: legitim ETA-stigning vid U-sväng/inbromsning).
- `homey app validate --level publish`: ren.
- ESLint: rent på samtliga ändrade filer.

**Rekommendation: REDO ATT PUBLICERAS, med ett förbehåll.**

Koden har nu gått igenom radgranskning av varje modul med adversariell
verifiering, och alla bekräftade fynd på pelarnivå är åtgärdade och
regressionslåsta. Långtidsdriften är soak-testad med äkta omstarter och
läckagediagnostik som facit. Publiceringskontraktet är rent.

Förbehållet: flera av fixarna (särskilt U-svängsvakten, gap-kedjans
inferredFlush, CBM-hysteresen och feed-tystnadsvakten) har aldrig sett
VERKLIG trafik — replay/soak är troget men syntetiskt. Rekommenderad
ordning: (1) committa, (2) kör EN ny verklig valideringskörning (~1 dygn,
gärna med returtrafik och en ankrad-avgående båt), (3) analysera + lås som
korpus #9, (4) merge till main + `homey app publish`. Om körningen är ren
finns inget kvar som blockerar publicering.
