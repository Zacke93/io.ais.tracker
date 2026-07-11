# Fable-granskningen 2026-07-10b — protokoll

**Uppdrag:** full kodgenomgång med fokus på de två pelarna (boat_near-notiser +
bridge_text) plus övriga buggar (ej översättning/livekörning/bilder), med
Fable 5-granskare. Utgångsläge: `b9d4b15` (helkodsgranskningen +
ChatGPT-verifieringen samma dag).

**Metod:** 16 Fable 5-granskare — 13 delsystempaket (app.js ×4,
VesselDataService ×3, StatusService+Stabilizer, ETA-kedjan, BridgeTextService+
hjälpare, gate-kvartetten, geometri+konstanter, koordinator+livscykel+driver)
+ 3 tvärgående (pelare 1 end-to-end, pelare 2 end-to-end, test/prod-divergens+
async-racen+långtidsdrift). Varje granskare med radintervall, beviskrav
(fil:rad + citerad kod + konkret felscenario) och facit-låsta designval
flaggade. Dirigenten (Fable) radverifierade varje KRITISK/HÖG mot koden och
rådataverifierade varje notisdiff mot korpus-jsonl före fix/omlåsning.

**Utfall:** ~40 råfynd → ~33 unika (4 fynd hittade av 2–3 oberoende granskare)
→ **28 unika fixade** + 1 latent hål avslöjat av batteriet självt (#44).
6 medvetet uppskjutna städfynd (§Kvarstående). 0 falska KRITISKA/HÖGA.

## Fixade fynd (per allvarlighet)

### KRITISK
- **V1-1** (regression från V2-2/b9d4b15!): null-sog-grenens rörelseväg i
  `_updateMooringEvidence` returnerade före `_classifyMooring` — enda stället
  `_moored=false` skrivs. Fartgivarlös båt som förtöjts var förtöjd för evigt
  (ingen målbro/text/notiser under hela avresan + falska kajkarteposter var
  50:e meter). Fix: bevisad förflyttning (≥50 m netto) släpper klassningen —
  finit-grenens exakta spegel. + **V1-4**: 40–49 m-steg nollställer nu
  stillhetsklockan (kryp-kön ackumulerade "stillhet" över förflyttningar).

### HÖG
- **V2-1**: FIX Z-NORDSPEGELN. Partiell nordresa (TARGET_END Strids utan
  Klaffbron i passedBridges) + samma-sessions-U-sväng söderut fick målbro via
  ACCELERATED i samma tick — före NEW_JOURNEY (kräver target=null). Stale
  `_finalTargetDirection='north'` gav sedan target=Stridsbergsbron BAKOM den
  sydgående båten (pelare 1) och returpassagerna blev odetekterade+
  onotifierade (pelare 2). Fix: exakt FIX Z-spegel för nord.
- **G-1**: SIDOKONTRAKTET. GJ-1-fysikens tillåtelsefönster växer linjärt med
  kandidatålder medan en falsk kandidats offset (snapshot=hopp-position) är
  konstant → varje falsk kandidat "stabiliserades" garanterat inom C1:s
  20-min-TTL (600 m @ ~10 min) → falsk målbrotransition + fantomnotis, och
  den äkta passagen dedupades senare bort. Interaktionseffekt av GÅRDAGENS
  två fixar (GJ-1 × C1) — osynlig för batteriet (kräver 10–20 min simulerad
  kandidatålder). Fix: `geometry.isDecisivelyOppositeBridgeSide` + refutation
  vid STEG 5-konsumtionen (båt entydigt kvar på pre-passage-sidan ⇒ droppa).
- **S-1**: StatusStabilizern förbigicks av timer-/snapshotvägen —
  `_reevaluateVesselStatuses` anropade utan positionAnalysis och skrev status
  ovillkorligt, så GPS-/osäkerhetshold revs inom ≤30 s (ETA-vägen i samma
  loop hade gaterna; statusvägen saknade). Fix: syntetisk positionAnalysis ur
  `_gpsJumpDetected`/`_positionUncertain`-flaggorna.
- **E-1**: WAIT_CAP 12 min omfattade `stallbacka-waiting` — en RÖRLIG
  genomfartsstatus med målbron 2,3 km bort (sann ETA 17–21 min vid 4–5 kn).
  Deterministisk sågtand 17→12(platå)→trappa→16 i texten för varje sydgående
  transit under ~7 kn. Fix: capen gäller endast äkta `waiting`.
  **Golden-text omlåst** (6 korpusar + comprehensive-snapshots regenererade;
  varje diff granskad: sanna monotona nedräkningar ersätter platån).
- **P2-1**: N2-reentry-resetten (10-min-cooldownens utgång) rensade dedup
  positionsblint — bro notifierad UNDER cooldownen (nya benet, MOSHE-klassen)
  fick nycklarna raderade med båten kvar i 300 m-zonen → dubblett för samma
  fysiska passage. Fix: fullrensningsgrenen bevarar poster färskare än
  10 min (tidslinjen ger ren skiljelinje: gamla resans poster är ≥10 min vid
  resetten). N1-/NEW_JOURNEY-vägarna orörda (HALIFAX-facitlåsta).

### MEDEL (urval — full lista i testsvitens huvud + git-diffen)
- **A3-1/A4-1/P2-2** (3 oberoende granskare): `_newJourneyPending` in i
  removal-snapshotten (fältlistfällans offer nr 12, snapshotvarianten) —
  exit-vägens F5-A-pendinggate var död kod.
- **S-2/V1-5/V3-1** (3 oberoende): `_criticalTransitionCapturedPosTs` +
  `_criticalTransitionHoldBridge` in i fältlistan (offer 10–11) —
  SELENE-vaktens dedup nollades av varje meddelande.
- **G-2**: ensidig sog=null → 5 kn-golv i `_isVesselStable` (GJ-2-spegeln).
- **G-3**: gate-bekräftade passager registreras nu i PassageLatchService +
  RouteOrderValidator (kortslutningen hoppade över normalvägens block).
- **G-4**: latch-reversalens pending är sampelbaserad (sampleTs) med
  20-min-fönster — förr räknades ANROP: samma tick självbekräftade (waiting+
  approaching), gles kadens kunde aldrig bekräfta (F13-releasen död).
- **G-5**: validatorhistoriken lagrar låst riktning (fallbackkedjan från
  route-latch#1) — momentan cog gav null och dödade vändningsundantaget.
- **S-3**: Bug #5-force-clearens eviga 10-min-flip stängd —
  `_underBridgeTimeoutBlockedBridge` (i fältlistan) spärrar om-latchning
  tills båten bevisligen lämnat zonen (>70 m) eller passerat.
- **V1-2**: `lastActiveTime` stämplas nu vid positionsbevisad förflyttning
  även för känd låg fart (0,5–2,0 kn) — kö-zonsvakten var död för klassen.
- **V1-3**: `vessel.previousPosition` (existerar ej) → `lastPosition` i
  `_isActuallyApproaching` — metod 2 var död kod; S-4:s Stallbacka-fallback
  för kurs+fartgivarlösa fungerar nu.
- **V3-2**: FIX U-force-waiting riktningsgatad — parbron måste ligga FRAMFÖR
  (samma-tick-ordningen vid TARGET_END + reborn-mellan-paret gav retrograd
  waiting + möjlig fantomnotis för Järnvägsbron).
- **A4-2**: retroaktiv-flip-gaten 15→60 min (köväntetider 15–60 min är
  vardag; äkta retroaktiva returer är ≥66 min per korpus #9/ELFKUNGEN 117;
  HALIFAX-approach-vägen orörd). Lagringen kan inte rörelsegated:as
  (HALIFAX-posten facit-låst) — gränsen är rätt ratt.
- **A3-2**: exit-anropet bär `detectionTs` — distans/fart-skattningen ströp
  annars F5-B-radien till ~154 m/knop (700 m @ 4 kn = struken).
- **A4-3/P2-4**: exit-gaten utökad till MÅLLÖSA sydgående med ≥1 bokförd
  passage — **4 rådataverifierade äkta missar** i korpusarna (fulla
  sydtransiter som försvann 316–574 m norr om punkten i aktiv fart):
  **korpusfacit omlåsta** 85→86 (41h), 31→32 (11h), 72→73 (14h), 79→80
  (13,5h). Fördelnings- + riktningsfacit uppdaterade.
- **A2-1/P1-2 + A2-2/P1-1 + A2-3 + P1-1b**: publiceringsvägens självläkning
  komplett — null-sentineler för alarm_generic/connection_status vid
  skrivfel, watchdog-läkningscykel vid 0 båtar (C4a-fixen saknade drivkraft
  i exakt värsta fallet), token-fel nollar hashen, synkrona kast räknas.
- **A1-1/DIV-1**: kajkartans TTL-förnyelse 24h-gated (~480
  settings-skrivningar/dygn/kajliggare → ~1).
- **SYS-1**: `_deleted`-flaggan stoppar zombie-återregistrering i onInit-
  catchen (radering mitt i init gav permanent spökenhet → error-storm).
- **SYS-2**: 30 s-timeout på C4b-skrivkedjan (en hängande setCapabilityValue
  wedgade annars bridge_text för alltid, tyst).
- **A2-4/SYS-4 + SYS-3/P1-5**: device-onInit speglar appens larmcache och
  läker init-synken via nollade dedup-cacher + ordinarie kedjan.
- **#44-gaten** (LATENT sedan C3, avslöjad av scenario #44 mot BASLINJEN —
  fanns även i b9d4b15): expired-släppet öppnade för båt som passerat bron
  på innevarande resa, parkerat >2h och återupptagit färden BORT →
  fantomnotis. Fix: bro i passedBridges släpps aldrig via expired-vägen
  (ny resa = journey-reset; U-svängar går via flip-grenen, orörd).

### LÅG (urval)
- **B-1**: CurrentBridgeManagers återpassage-spärr villkorad på
  passedBridges-medlemskap (U-svängt returben nekades currentBridge i hela
  50–500 m-bandet — spärren saknade tidsgräns).
- **P1-3**: hysteres på imminent-gränsen (SET ≤300/CLEAR >350) —
  "strax"↔"om N min"-flappen för ködrivare stängd (golden-diffarna visar
  eliminerade okänd-dippar).
- **P1-4**: nödfallbacken räknar renderbara båtar (alla-orenderbara →
  DEFAULT i stället för antalslögn).
- **A3-3**: fallbackens ETA-klausul truthiness-gate fixad (null+imminent →
  "strax"). **A3-4**: T-2-grenen nollar även etaMinutes.
- **P2-3**: trigger-fel-rollbacken ÅTERSTÄLLER förexisterande persistent-post
  (raderade förr flip-postens original).
- **GEO-1** (död kraschbar metod raderad), **GEO-2** (cog=null-koercion:
  finit-vakter i METHOD 5 + isHeadingTowards), **GEO-3** (break→flagga i
  analyzeVesselProximity — avståndsinvarianten hel), **GEO-4** (död
  vilseledande konstant raderad).
- **S-5** (delvis): isStationary sog=null-fällan härdad; VDS:s no-op-städning
  av obefintlig `systemCoordinator.statusStabilizer` raderad.
- **SYS-6**: JOURNEY_COMPLETED-loggens riktningsetikett följer beslutets
  källa. **DIV-2**: `_capWriteChains` nollställs i onUninit. **DIV-3**:
  F37-catch på vessel:removed. **A4-H**: vilseledande F4-D-kommentar rättad.

## Avvisade/uppskjutna
- **A4-2:s ursprungsförslag** (rörelsekrav vid lagringen): AVVISAT —
  dokumenterat facit-fällt (HALIFAX-posten krävs); gränshöjningen tog fallet.
- **Uppskjutna städfynd** (nästa iteration): E-2 (rutt-ETA räknar baklänges
  vid nearest-akter-om efter omstart — självläkande minuter), SYS-5
  (SystemCoordinators overksamma text-debounce-subsystem — radera eller
  koppla in), S-4 (stabilizerns onåbara flicker-grenar), S-5 full radering
  av död publik yta (test-refererad), imminent-hysteresens
  BTS-kommentarsynk.

## Verifiering (facit-fällan)
- **984/984 jest** (82 sviter; +22 i `tests/fable-granskningen-2026-07-10b.test.js`,
  6 omlåsta med motiv: gamla anropssignaturer/objektformer + VLM:s
  "KÄNDA ANOMALI"→fixad + T-blockets ärliga väg till beskrivande grenen).
- **11/11 korpusar EXAKTA** inkl. fördelnings-, riktnings- och
  golden-text-gaterna. 4 omlåsningar (+1 Kanalinfarten var, rådataverifierade
  fulla sydtransiter). Golden-text regenererad via REGEN-flödet
  (stale poster raderade först — flödet vägrar tvätta diffar); varje diff
  granskad: E-1:s sanna nedräkningar, P1-3:s eliminerade dippar,
  SELENE-koalescerade övergångar. 19h-korpusens golden BYTE-IDENTISK
  (bevisar att dess INV-18-WARN:ar är förexisterande).
- **44/44 syntetiska scenarier** (#44 fälde baslinjen också — latent hål,
  inte regression; fixad + grön).
- **Comprehensive-goldens** regenererade (6 rader: exakt E-1-platån →
  fysikaliskt korrekt 18→17→16→15→15→strax).
- **72h-soak stabil**: 0 processfel, 2 informativa INV-18 (tidigare 3).
- **Lint rent** (hela ändringsytan), **homey validate publish rent**.
- **INGEN commit** (väntar på uttrycklig begäran).

---

# OMGÅNG 2 — verifieringsgranskningen 2026-07-11 (mot b17da05)

**Uppdrag:** exakt samma 16-paketsgranskning som omgång 1, som VERIFIERING
("gör exakt samma granskning igen för att verkligen se till att inget mer
hittas"). Alla 16 granskare avbröts en gång av sessionstak/anslutningsfel och
återupptogs med kontext intakt. ~31 unika fynd (5 hittade av 2–4 oberoende
granskare) → **29 fixade**, 1 uppskjuten (A1R2-3), 1 scenariofälld gate
tillagd under fixfasen (re-cross × echo).

## Huvudfynd

- **RE-CROSS-familjen (P2R2-1 HÖG/KRITISK-gräns, P2R2-2 HÖG, V2R2-1, A4R2-2
  — gemensam rot):** VDS-skippet "bro i passedBridges" gjorde nytt
  korsningsbevis omöjligt, samtidigt som ALLA reset-vägar kräver
  target (Fix D/korsningsbevis), _finalTargetDirection (NEW_JOURNEY) eller
  completed (N2). Klassen "mållös/oavslutad + vänd" — kajvändaren som
  förtöjer mitt i resan och vänder hem; U-sväng+återkorsning i samma
  kadensgap — fick HELA returresan odetekterad och onotifierad (stale
  riktningslås höll dedupen stängd i 2h, #44-gaten därefter för evigt).
  FIX: re-cross-bevis FÖRE skippet (bron strikt mellan positionerna i
  motsatt riktning + rörelse i nuet + GPS-REN tick) ⇒ bekräftad reversal +
  dedup-släpp för bron + ordinarie registrering. GPS-suspect-gaten
  tillkom efter att scenariot fördröjd-gammal-position FÄLLDE första
  varianten (echo-sampel 400 m bakåt gav falsk reversal) — batteriet
  gjorde sitt jobb.
- **V1R2-1 (HÖG):** sog-ARVET i fältlistan (sticky finit) förgiftade
  mooring-maskineriet — _updateMooringEvidence läste MERGAT värde, så
  null-sog-grenen var nåbar endast för aldrig-finita båtar. Ett förirrat
  0,2 kn-prov ⇒ evigt förtöjd trots vandrande position; ärvd ≥0,3 ⇒
  kajliggare aldrig förtöjd (2026-06-10-klassen via arvsvägen). FIX: rå
  sampel-sog som parameter.
- **Publiceringsvägen:** token-setValue timeout-säkrad (A2R2-2/P1R2-1,
  2×HÖG — hängning wedgade lanen permanent + läckte _processingRemoval);
  sen-landande timeout-släppt skrivning nollar sentinelen vid settling
  (A2R2-1/SYSR2-2/P1R2-2/DIVR2-2 — 4 oberoende!); UI-cykelns DEFAULT
  gatas av feed-stall (A2R2-3/P1R2-4 — P8-spegeln i _processUIUpdate);
  _shuttingDown-flaggan (A2R2-4).
- **Gaterna:** TTL i stable-grenen (GR2-1/DIVR2-1 — C1-klassens
  kvarvarande divergens); konsumtionen skippas på flaggade ticks (GR2-2);
  kandidater ruttordningsvalideras (GR2-4); latch/validator föredrar
  korsningsbeviset (GR2-5); sydbanden A1-1-harmoniserade (GR2-6);
  clearGate räknar endast applicerade (GR2-3).
- **Status/text:** exhausted-seedad imminent utan hysteres — 90s-taket
  äger igen (A3R2-1/P1R2-3); SR2-1-spärrtidsstämpeln (retroaktivt släpp);
  SR2-2 (stabilizer-rollbackens ETA-bieffekt); SR2-3 (färskläst
  broöppningsfönster); BR2-1 (CBM Regel 0-oscillationen, empiriskt
  reproducerad); fallbackens renderable-mängd (A3R2-2/-3).
- **Notiskedjan:** Kanalinfarten återfick 15-min-flipgränsen (A4R2-1/
  A1R2-2/P2R2-3 — 3 oberoende; 60-min-höjningen gällde bro-returer,
  entry/exit är två legitima notiser och rundturen tar 25–60 min);
  freshlyRecrossed-släppet i #44-gaten (A4R2-2); exit-reversal-motbeviset
  (A4R2-3); fartgivarlös-radien via maxRecentSpeed (A1R2-1);
  DIVR2-4-orphan-spegeln (prod/replay-divergens i sessionsnycklar — den
  fartgivarlösa returen missades i replay men inte i prod);
  P2R2-4 + DIVR2-3 (flip-/rollback-hygien); FIX U-korsningsbevis +
  reversal-städning (V3R2-1/-2); sorteringsriktning ur segmentet (V3R2-3);
  G-3-spegeln utanför bounce-vakten (V2R2-2).
- **ETA:** decay-golvet otakat (ER2-1) + wait-clampen enbart äkta
  'waiting' (ER2-2) — E-1:s eget argument fullföljt.
- **Device:** _deleted-spärr på try-vägen (SYSR2-1 HÖG);
  connection_status i init-läkningen (SYSR2-3); SYS-6-verifierad.
- **Härdningar:** isHeadingTowards sog=null-vakten (GEOR2-not),
  vessel:updated F37-catch, stale H2-kommentar.

## Rena paket/verifierat i omgång 2
GEOR2 helt rent (alla 4 GEO-fixar beteendebevarande; sidokontraktets
matematik omräknad). V2-1-nordspegeln KOMPLETT. G-2/G-4-grundfallen,
S-1 (ingen evig maskering), fältlistorna (ingen ny post), P2-1-preserve,
nyckelformaten (21 förekomster), C1-stängningen i övrigt — allt verifierat.

## Golden-text omlåst (diffgranskad rad för rad)
Notisantal/fördelning/riktning EXAKTA i alla 11 korpusar utan omlåsning.
Golden-diffarna: mestadels millisekund-artefakter (fler Date.now()-anrop) +
avsiktliga förbättringar: 14h-korpusens **AKIRA-spöke förkortat 25→6,5 min**
("Fyra→Tre båtar" — stillaliggande kajbåt med retroaktiv passage fick
korrekt 'passed' via SR2-3 i stället för att spöka i målbrogruppen med
ETA 53 min; rotorsakad mot rådata, F4-I-spökbåtsklassen); 2h/21h/19h/13h:
ärliga degraderingar och wait-clamp-släpp enligt fixarnas avsikt.

## Uppskjutet
- **A1R2-3:** FIXAD I EFTERHAND (användarbeslut alt. 1, 2026-07-11): exit-
  gaten räknar avfyrad bro-notis som transitbevis (bokföringen orörd —
  svepets inferensfrihet består). Fixen väckte LYS@Kanalinfarten i
  14h-korpusen — rådataverifierad ÄKTA miss (5 kn/cog 210, 119 m från
  punkten; Olidebron positionsbevisad men svep-notifierad = obokförd) →
  KORPUS OMLÅST 73→74. Fältprov 2-notens "INTE facit"-dom hävd med
  rådatabelägget.
- Kvarstående från omgång 1: E-2, SYS-5, S-4, S-5 full radering.
- Känd replay-artefakt: GLOBAL_TOKEN_TIMEOUT-fellogg i scenarier
  (fake-klockan stegar >10 s före mock-settling) — kosmetisk, fäller inget.

## Verifiering
1011/1011 jest (83 sviter; +27 i tests/fable-omgang2-2026-07-11.test.js),
11/11 korpusar EXAKTA (alla gater; golden regenererad via REGEN +
diffgranskad), 44/44 scenarier (echo-scenariot fällde+läkte re-cross-gaten),
72h-soak stabil (2 INV-18), lint rent, homey validate publish rent.
