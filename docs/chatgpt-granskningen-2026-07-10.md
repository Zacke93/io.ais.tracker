# ChatGPT-granskningen 2026-07-10 — verifiering och åtgärder

Extern granskning (ChatGPT) levererade 22 påståenden med NO-GO-rekommendation
för v5.0.0. Metod: 11 oberoende Opus-max-granskare verifierade varje påstående
mot kod, körbara repron och officiella källor (GHSA-advisories, aisstream-docs,
Homey-guidelines); dirigenten (Fable) egenverifierade därefter samtliga mot
kodbasen. Facit-fällan vaktade varje fix: 906/906 jest, 10/10 korpusar EXAKTA,
43/43 syntetiska scenarier (inga FATALA utslag; WARN-invarianter är per
design informativa), 72h-soak stabil, lint + `homey validate publish` rent.
(Siffran 46 i en tidigare version av detta dokument var fel — rättad i
andra granskningsrundan nedan.)

**Huvuddom: inget av de nio "P0"-påståendena höll som kodblockerare** — men två
store-listing-fynd (README, bilderna) är äkta hårda certifieringsregler, och
~14 fynd var äkta och åtgärdades. Tre motbevisades helt, två avvisades som
medvetna, dokumenterade designval.

## Åtgärdat (med regressionstester i tests/chatgpt-granskning-2026-07-10.test.js)

| Fynd | Verdikt | Åtgärd |
|---|---|---|
| A1 ws 8.18.2 (CVE DoS/minnesläcka) | Sant men överdrivet — ren KLIENT mot betrodd TLS-endpoint; DoS:en kräver fientlig server, läckan otriggbar (close() utan args). `.homeybuild` bevisade dock att 8.18.2 skeppas. | `ws@8.21.0` installerad, `^8.21.0` som golv; `npm audit --omit=dev` = 0 sårbarheter. Lockfilens versionsfält synkades till 5.0.0 på köpet (A2). |
| B1 validate-pipen falskgrön | BEKRÄFTAD (reproducerad: jest exit 1→pipe exit 0, även exit 127 maskerades) | `validate` skriver jest-utdata till tempfil, visar `tail -5`, propagerar jest:s riktiga exitkod. Negativtestat åt båda hållen. ENOSPC-skyddet (begränsad output) bevarat. |
| B2 döda testscripts | BEKRÄFTAD (4 orphans utan CI-referenser) | `test:consolidated/unit/integration/production` borttagna. |
| B3 korpusdata utanför repot | BEKRÄFTAD (medvetet val, men bus-factor-risk) | De 10 låsta jsonl (0,5 MB) committade byte-exakt (MD5-verifierat) i `tests/replay-validation/corpora-data/`; replay:all fungerar nu i ren checkout. appLog-pekarna (aldrig konsumerade) kvar mot `../logs`. |
| D1 alla serverfel = auth-error | DELVIS — klassificeringen äkta, men "permanent grön-men-döv" motbevisad (aisstream stänger själv med 1006; feed-watchdogen tvingar reconnect ≤20 min) | Klienten klassificerar nu (nyckelsträngar → `auth-error`, övrigt → `server-error` med neutral notis) och river socketen så close→reconnect-vägen äger övergången. |
| E1 Valid:false accepteras | DELVIS — fältet finns i kontraktet, men go-ais-dekodern emitterar aldrig false; fem försvarslager fanns redan | Defense-in-depth: strikt `body.Valid === false` avvisas. `=== false` är kritiskt — replay-sampel saknar fältet helt och får aldrig tappas (0 träffar i korpusarna, verifierat). |
| F1 sydgräns 58.2681 vs exit 58.2653 | BEKRÄFTAD (grenen onåbar; alla 15 korpusar bottnar vid 58.2681 — 0 sydgående completions på 136 h; sydresor avslutades via timeout-vägen, ingen notis missades: exit-fallbacken täckte Kanalinfarten) | Prenumerationen läser nu `constants.AIS_CONFIG.BOUNDING_BOX` (SSOT, SOUTH 58.26). Replay opåverkad (matar `_processAISMessage` direkt) — korpusarna bevisade det: 10/10 EXAKTA. EXIT-TRÖSKELN RÖRDES INTE (hade ändrat replay-timing). |
| G1 eta_minutes=-1-fotgevär | BEKRÄFTAD men MEDVETEN+dokumenterad+invariantlåst (`n.eta >= -1`) | Additiv `eta_available`-boolean-token + "-1 = unknown" i tokentiteln. `eta_minutes`-semantiken OFÖRÄNDRAD (att ändra den bryter användarflows + 10 korpusfacit). |
| G2 boat_at_bridge utan filter + any missar Kanalinfarten | Filterdelen BEKRÄFTAD (villkoret gick över rå `getAllVessels()`; kajliggare inom 300 m höll det sant för evigt). Any-delen AVVISAD av ANVÄNDARBESLUT 2026-07-10: Kanalinfarten är ingen bro utan en nöjes-triggerpunkt — "any" ska bara betyda riktiga broar. | Speglar nu notis-vägens gater: `_moored`, `hasGpsJumpHold`, >10 min tyst sändare. Any-utökningen prövades och DROGS TILLBAKA — negativtest låser att "any" INTE matchar Kanalinfarten (specifika valet fungerar via F36). |
| G3 bridge_text setable:true | BEKRÄFTAD (enda app-capability med felet; låg praktisk effekt — sensor-UI är read-only) | `setable: false`. |
| H1 README bryter store-reglerna | BEKRÄFTAD P0 (6 stycken, funktionslista, URL — mot tre ordagranna "not allowed"-regler) | README.txt + README.sv.txt omskrivna till 2 stycken, ingen funktionsuppräkning, inga URL:er. |
| H2 svensk runtime | DELVIS — engelsk bas finns brett; bridge_text-svenskan är PRODUKTEN (korpuslåst, rörs aldrig); äkta delen var settings-sidans halvblandning | settings/index.html: engelska som bas + I18N-tabell (en/sv via webview-språket) för panel + statusmeddelanden. Timeline-notiserna förblir svenska (dokumenterat produktbeslut, svensk målgrupp). |
| H4 connection.svg-licens | BEKRÄFTAD (SVG Repo-boilerplate utan licens-ID; ikonen skeppas) | Ersatt med egenritad signal-ikon — licensfrågan eliminerad. |
| I1 device-init sväljer fel | DELVIS — konsekvensen överdriven (self-healing push-design; addDevice före capability-skrivningarna) | Catch sätter nu `setUnavailable` + `_initFailed`-flagga; första lyckade capability-skrivningen kör `setAvailable` (fastnar aldrig). |
| I2 API-nyckelns tre kontrakt | BEKRÄFTAD men ChatGPT:s premiss INVERTERAD: manifest-UUID-mönstret var både DÖTT (custom settings-sida vinner) och FEL (riktiga aisstream-nycklar är 40 hex, inte UUID) | Harmoniserat åt det TILLÅTANDE hållet: pattern borttaget, vilseledande UUID-placeholder/hint ersatta, fältet är nu `type=password`. Längd ≥20-gaten kvar (accepterar riktiga nycklar). |
| J1 notis-dedupe utan rollback | BEKRÄFTAD (gäller anslutnings-timelinenotisen — INTE boat_near som redan har F6-rollback; 24h-spärr efter misslyckad leverans) | Rollback av stämpeln i catch (F6-mönstret); race-vakten före await bevarad. |
| K1 gamla gap i ARCHITECTURE.md | BEKRÄFTAD (950/420 kvar efter 2026-07-06-rättningen till 1363/257) | Docs-raden rättad. |

## Motbevisat (ingen åtgärd)

- **H5 "obligatoriska docs/recentChanges.md saknas"**: Homey kräver
  `.homeychangelog.json` — den finns och är korrekt. recentChanges.md raderades
  medvetet 2026-07-03 (användarbeslut) och är dessutom .homeyignore:ad.
- **A2 "bygget ej reproducerbart"**: `.homeybuild` bevisar att Homey buntar
  lokala prunade node_modules (återupplöser inte semver i molnet) och att sänd
  version är 5.0.0 (app.json). Lockfilen är git-spårad; exkluderingen ur
  tarballen är Homeys standardmönster. (Versionsfältet 1.0.0 var kosmetik —
  ändå synkat.)
- **K2 "tester ersätter produktionen"**: replay-harnessen SLÄPPER `__TEST_MODE__`
  efter init och övar båda pelarna mot exakt facit; gaterna stänger bara
  periodiska GC-timrar. Nätverkslagret har egna resilience-tester. Standard
  testdesign — kvarvarande lucka är enbart riktig WS-I/O + GC-loopens body.

## Avvisat som medvetna designval (dokumenterade motiveringar)

- **C1 uncaughtException/unhandledRejection loggar-och-fortsätter**: Node-docs
  stödjer ChatGPT ordagrant, men remedyt förutsätter en pålitlig extern
  supervisor — Homey har ingen (community-belagt: kraschade appar blir
  pausade/disabled tills MANUELL omstart). Ovillkorlig exit riskerar totalt
  tyst driftstopp för båda pelarna; partiell funktion + logg slår total
  tystnad. Härdning finns redan vid källorna (ws-NOOP-sink, per-båts-.catch,
  snapshot-guard) och 136 h fältkörning visar 0 uncaughtException.
- **B4-resterna (lint/coverage utanför validate)**: medvetet separata steg
  (OneDrive gör helträdslint långsam); dokumenterade i VALIDATION.md. Den
  farliga delen (jest-masken) är fixad.
- **H2-resten (svenska timeline-notiser + bridge_text)**: produkttext för
  svensk målgrupp; bridge_text är dessutom korpuslåst facit.

## Kvarstår för användaren (kan inte göras från kod)

1. **H3 store-bilderna (ÄKTA P0)**: `app_small/large/xlarge.png` är exakt den
   förbjudna bildtypen (platt vit 2D-form på enfärgad blå bakgrund — riktlinjen
   ordagrant "not approved"). Kräver foto-/brandbild (t.ex. foto av bro/fartyg
   i kanalen) i 250×175/500×350/1000×700. Driver-bilderna bör ses över med
   samma regel.
2. **K3 gitläget**: fix/ghost-vessel-and-eta-bugs ligger 40 commits före
   origin/main; de 40 commitsen är pushade till feature-grenen, men DENNA
   sessions ändringar (granskningsfixarna) är ännu OKOMMITTADE per projektets
   arbetsregel (commit endast på uttrycklig begäran). Merge/fast-forward till
   main före publicering så source-länken visar levererad kod (etablerat
   beslut).
3. **Fysiskt slutprov**: ingen granskning ersätter en riktig körning på Homey
   med live-AIS — nästa fältkörning (korpus #11-kandidaten) kvarstår som
   sista steget före publicering, nu med den utökade sydgränsen aktiv.

## Andra granskningsrundan (ChatGPT granskade fixarna, 2026-07-10)

ChatGPT återgranskade allt ovan och fann två äkta buggar i de nya fixarna,
flera äkta rapportfel och ett antal punkter som inte höll för kritisk
granskning. Användarbeslut: språk/lokalisering, store-bilder och
liveprovs-punkterna är INTE relevanta (appen ska inte publiceras skarpt).

### Åtgärdat i andra rundan

- **Device-recoveryn kunde fastna (ÄKTA, båda delarna)**: (1) `_initFailed`
  rensades FÖRE `setAvailable()` avgjorts och rejecten svaldes — misslyckad
  setAvailable lämnade enheten unavailable för evigt. Nu rensas flaggan först
  efter bevisat lyckad setAvailable; vid fel består flaggan och nästa
  skrivning gör nytt försök. (2) Fel FÖRE addDevice-steget lämnade enheten
  utanför push-Set:en (självläkningen kunde aldrig nå den) — catchen
  registrerar nu enheten (Set.add är idempotent). Riktiga
  BridgeStatusDevice.onInit-tester tillagda (felväg + lyckad väg).
- **Auth-regexen (ÄKTA)**: fristående `not valid` fångade "Bounding Box Is
  Not Valid" som nyckelfel. Auth-klassningen kräver nu key-/auth-begrepp;
  regressionstest låser bbox-strängen som server-error.
- **Rapportfel rättade**: syntetiska scenarierna är 43 (inte 46 som en
  tidigare version av detta dokument påstod, och inte 38/8 korpusar/844
  tester som VALIDATION.md släpade med); "rena" förtydligat till "inga
  FATALA utslag — WARN är per design informativa" (runSyntheticScenarios
  fäller uttryckligen inte på WARN); soakens slutrad omformulerad (dedup-
  nycklarna är MEDVETET undantagna tomhetskravet och vaktas av 100-taket —
  67 efter 72h ≈ förväntade ~66 efter sista restart-pruningen, dokumenterat
  i runSoak.js); testfilens huvudkommentar hade kvar den tillbakadragna
  any/Kanalinfarten-formuleringen (koden och testet var redan rätta);
  "allt pushat"-frasen förtydligad (gäller de 40 commitsen, inte sessionens
  okommitterade ändringar).

### Avvisat efter kritisk granskning

- **"GPS-hopp rensar skydd när de behövs som mest"**: skyddet som efterlyses
  FINNS — vid hopp aktiveras GPSJumpGate och alla passager blir KANDIDATER
  som kräver stabilitetsbekräftelse (5 s + `_isVesselStable`, 30 s-tak,
  tvåstegsvalidering i `confirmStableCandidates`) plus gps-jump-hold.
  Latch-/routehistorik-rensningen vid >1 km är medveten (gamla lås/sekvenser
  beskriver fel läge efter hoppet — kommenterat i koden). Förslaget att
  BEHÅLLA för-hoppet-historiken skulle få routeOrderValidator att validera
  nya positioner mot en ogiltig sekvens och blockera ÄKTA passager efter
  AIS-gap — exakt den korpuslåsta klass (SENTA/DIANA/ELFKUNGEN) som kostade
  flera fältprov att fixa. Och "två konsekventa stabila prover" på andra
  sidan bron ÄR bästa tillgängliga sanning (gap-kedjans grundprincip,
  facit-låst genom 10 korpusar). Ingen ändring.
- **"AGENTS.md kräver recentChanges.md"**: AGENTS.md existerar inte i repot.
  Falsk premiss.
- **Crashpolicyn**: omklassad från "motbevisad" till vad den är — ett
  MEDVETET ACCEPTERAT RISKTAGANDE (Node-dokumentationens varning är
  korrekt; avvägningen mot Homeys opålitliga app-omstart står fast).

### Skippat per användarbeslut (appen publiceras inte skarpt)

Lokalisering/store-språk, store-/driverbilder, README-domänen,
Verified-nivån/platforms, appnamnsfrågan, liveprovs-checklistan.
