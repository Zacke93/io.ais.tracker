# AISHub etapp 5 — härdningen före det avgörande A/B-testet (2026-08-03)

## Bakgrund

| | |
|---|---|
| Underlag | Skuggkörning 2026-08-02 21:37 → 2026-08-03 07:34 UTC (9 h 57 min), 72 287 loggrader |
| Analys | 15 analysagenter + 4 skeptiker; verdikt i `ab/syntes.md` (A/B-underlaget ligger utanför repot) |
| Trafik | 11 fartyg, 5 broresor, 8 målbropassager, 22 notiser i A-armen / 25 i B |
| Driftbild | 0 error, 0 warn, 1 WebSocket-anslutning, 529 AISHub-pollar × HTTP 200, 0 auth-fel |
| Kod före | main @ a2e7cbe (etapp 0-3 + fältprov 1-3), rent träd |

**Verdiktet som beställde den här etappen:** AISHub gjorde appen mer TÄCKANDE
(3 extra notiser, passage-fallback 5 → 2, ett 20-minutershål fyllt) men inte
mer FÖRUTSEENDE (5/8 målbropassager förvarnade i BÅDA armarna; medianförvarning
78,5 → 77,5 s). Kostnaden var däremot verklig, och den bestod inte av dålig
data utan av **LATENTA KODHÅL SOM BLEV AKTIVA JUST FÖR ATT DATAN BLEV TÄTARE**:

- 1 fantomnotis (PRICKBJORN @Kanalinfarten 07:19:11) — experimentellt bevisad
  som ett hål i FP9-gaten, inte ett AISHub-datafel: A-korpusen plus EN enda
  rad ommärkt till `feed:'aisstream'` gav exakt samma fantom.
- 2 tappade mellanbropassager i B (TIM @Olidebron + @Järnvägsbron) som fick
  brotexten att räkna UPPÅT 13→14→15→16→17 min under pågående insegling;
  maxfel +10,2 min mot A:s 2,9 min hela natten.
- Dubbletter vid +30 s AISHub-latens (målbro!) och 7 dubbletter vid +60 s —
  medan källans egen observerade latens hade p90 62,3 s. Felmoden låg alltså
  INOM normal drift.

Uppdraget: fixa produktionskoden så bra det går, så att ETT sista A/B-test kan
köras före skarp aktivering. Fem paket (P1 fusionslagret, P2 StatusService,
P3 fysik-dt, P4 AISHub-klienten + grindarna, P5 app.js), en ägare per fil,
separat batteriagent. Järnregel hela vägen: **de 15 låsta korpusarna ska förbli
EXAKT gröna** — beteendet får ändras ENDAST i den nya situationen (tät
sampling / korskälla / kajstabil historik), aldrig brett.

---

## 1. Fusionslagret (P1)

### F6 — asymmetrisk stale-grind (löser dubblettrisken vid latens)
**Rotorsak:** F1:s monotoni är PER KÄLLA och F5 flaggar utan att blockera. En
släpande hub-fix som landade efter en färskare aisstream-fix flyttade därför
fartyget ~200 m BAKÅT och lät det närma sig bron en gång till ⇒ ny notis.
**Fix (`FixFusionPolicy.shouldAccept`):** en AISHub-fix accepteras bara om dess
fixtid är STRIKT nyare än den senast accepterade fixen för fartyget — oavsett
källa (`state.lastAcceptedFixTs`, ny avslagsnyckel `stale_cross_fix`).
Asymmetrin är medveten: aisstream mäts ALDRIG mot en hub-stämpel, så
huvudkällan kan aldrig svältas. En klampad stämpel (F4a) avvisas separat
(`hub_clock_skew`) — den är per konstruktion "maximalt färsk" och hade friat
ovillkorligt precis när klockan inte går att lita på. Referensen är senast
accepterade värde, inte ett löpande max, så ett NTP-bakhopp självläker.

### F6b — klockoffsetkompensation (granskningsrunda 2)
**Rotorsak:** F6 jämför tvärs två klockdomäner, så grindens hela marginal ÄR
offseten mellan dem. Den ursprungliga motiveringen ("asymmetrin är
klockskevs-säker") gällde bara ett tecken: går hubbens klocka FÖRE Homeys ser
varje släpande fix färsk ut. Mätt på nattkorpusen med +60 s leveranslagg:
+30 s skev ⇒ 26 notiser (231907000|Klaffbron ×3, en MÅLBRO), +60 s ⇒ 31
notiser och sju dubbletter, +300 s ⇒ F4a klampar allt och grinden fyrar noll.
**Fix (`observeClock`):** hubbens fixTs lyfts in i Homeys klockdomän innan F6
jämför. Offseten skattas ur två fysiskt grundade bevis och det starkaste
(mest negativa) vinner: (A) leveransbeviset — en fix kan inte postdatera sin
egen leverans (nattens 1014 hub-fixar: min 414 ms, median 27,5 s, NOLL
negativa); (B) MEDIANEN av korskällepar (samma fysiska rapport från båda
källorna: 282 par, median 2,3 s = aisstreams pushlatens; medianen tål de 4 %
artefakter där en kajliggares två olika rapporter delade koordinat).
Korrigeringen är **klampad till ≤ 0** ⇒ exakt noll vid friska klockor ⇒ facit
per konstruktion oberört. Går klockan åt andra hållet blir grinden strängare,
och värsta utfall är dagens enkälle-beteende.

### V5 — `[FUSION_HEALTH]` var 5:e minut
`_fusionStats` lästes ENBART av replayRunner: i drift var avslagsprofilen helt
osynlig medan `[AISHUB_HEALTH]` fortsatte rapportera `accepted=N` från
KLIENTEN (som mäter parsning, inte vad som når pipelinen). En systematisk
svält — TIME-formatbyte som får F4b att avvisa 100 %, eller en klockskev som
låser F6 — hade alltså pågått i tysthet. Raden bär fönsterdelta (det som
avslöjar svälten) + totaler + klockregimen. Att klockregimen måste med är
inte kosmetik: en hubklocka som går före yttrar sig som FRÅNVARO av avslag,
dvs. raden hade blivit GRÖNARE precis när F6 slutade skydda.

### Instrumentfixar (fynd 12–16)
| # | Fel | Åtgärd |
|---|---|---|
| 12 | `raceMedianMs` kunde per konstruktion aldrig bli positiv (bara aisstream-grenen skrev positionsindexet ⇒ 103/103 fönster negativa; talet mätte pollintervallet) | Mätningen är TVÅSIDIG: båda källorna indexeras, den som kommer sist parar ihop sig med den andras post |
| 16 | Join-nyckeln `toFixed(5)` tappade 15,1 % av äkta par på rutgränser — samma nyckel bar F2:s korskälle-dedup | Positionslikhet i METER: F2 jämför avstånd (`CONTENT_MATCH_DIST_M` 1,5 m ⊃ gamla rutans diagonal 1,26 m ⇒ STRIKT utvidgning); skuggparningen svepar 3×3-grannrutor |
| — | Följdfel av 12: en stillaliggande båts återkommande koordinat parades mot en HELT ANNAN, äldre rapport ⇒ falska POSITIVA race (20 av 22, alla sog=0) | Samma-rapport-bevis (`PAIR_SAME_REPORT_MS` 10 s) + motparten KONSUMERAS ur indexet |
| 13 | `maxSilence` censurerades vid 60 min — nattens två 120-minutersglapp rapporterades aldrig, och censuren slog ENSIDIGT mot aisstream (instrumentet underskattade AISHubs enda tydliga övertag) | TTL 4 h (2× värsta observerade) + varje prunad post räknas som `silenceCensored*` i SHADOW_COMPARE, så ett tak aldrig kan läsas som ett sanningsenligt maxvärde |
| 14 | `_pct` returnerade MAXVÄRDET vid exakt n=10 — precis vid tröskeln `MIN_SAMPLES_FOR_P90` | Nearest-rank (⌈q·n⌉) |
| 15 | "LRU"-prunen var FIFO på insättningsordning i tre kartor (fusionsstate, klientens dedup, skuggindexet) ⇒ det längst spårade (mest aktiva) fartyget slängdes först | Äkta åldersbaserad eviction på senast accepterade fix/skrivning i alla tre |

### Källstämpeln kommer från ROUTINGEN
`_onChildMessage(feed, msg)` skriver `fixFeed = feed` för ALLA vägar, och
fusionspolicyn får källan som PARAMETER. Tidigare lästes `msg.fixFeed` ur
nyttolasten — ett tappat fält (fältprov 3-klassen, projektet har tolv
dokumenterade fältlistoffer) hade tyst avväpnat F1:s per-källa-hink, F6:s
vitlista, segmentbevisets källgrind OCH fysik-dt:t samtidigt, utan att ett
enda test blev rött.

---

## 2. Segmentbeviset för under-bro-zonen (P2, V2)

**Rotorsak:** `UNDER_BRIDGE_NO_CROSS` jämför bara zonbesökets ÄNDPUNKTER. Vid
tät sampling (~68 s kadens, ~240 m mellan fixar i 3,4 kn) kan den fix som
LATCHADE zonen redan ligga bortom brolinjen — då är båda "sidorna" den bortre,
passagen äts upp och ETA-motorn fastnar i `progressive_route`. TIM 2026-08-02:
Olidebron −98 → +16 → +123 m, Järnvägsbron −68 → +16 → +105 m. A-armen undgick
det bara för att aisstream var för gles för att landa en fix under bron.

**Fix (`StatusService._noteUnderBridgeLineCross`):** varje konsekutivfix-segment
under zonbesöket prövas mot brolinjen; korsar ett segment entydigt KORRIGERAS
`_underBridgeEntryLat/Lon` till segmentets startpunkt (den sida båten kom
ifrån) och bron stämplas i `_underBridgeCrossedBridge`. **Beslutet fattas
fortfarande av den befintliga entry↔exit-vakten — beviset flyttar bara
ankaret.** Det är precis vad som gör kanteffekterna ofarliga: korrigeringen
sker EN gång per zonbesök, så en U-sväng (AKIRA-låset) eller kajbrus tvärs
linjen ger fortfarande samma sida ut ⇒ ingen ankring. Ett rent booleskt "bron
korsades" hade fabricerat en passage i båda fallen. `geometry` METHOD 1 läser
stämpeln + ankaret (`zoneCrossProven`) som alternativ till sitt
tvåsampels-`sideFlipped`, med samma nettokrav; metoderna 4/5/6 är orörda.

Fyra spärrar: inget bevis på en GPS-hoppstick (hoppet ÄR annars "sidbytet" —
`positionAnalysis` skickas därför ned i `_isUnderBridge`); inget bevis när båda
samplen är bevisat stillaliggande med jitter-liten rörelse (CG2-1-spegeln);
segment ≤ 400 m (längre är ett AIS-glapp och ägs av inferensvägarna); och en
KÄLLGRIND.

**Källgrinden var en utrullningsspärr, inte fysik — och den är numera
BREDDAD (användarbeslut senare samma dag).** Rotorsaken är källneutral:
mätning över alla 15 korpusar (~240 h) gav 5 träffar mot nattens 2 på 10 h —
alltså 0,02/h mot 0,2/h, tio gånger vanligare när andrakällan förtätar
kadensen, men dimensionerna är oskiljbara (korsande segment 85–165 m, fart
3,3–5,7 kn). De fem enkelkällefallen är ÄKTA, tidigare tappade passager
(NORDIC SOLA, ORANESS, CATHARINA, ALICE, EXCALIBUR — samtliga Olidebron).
`UNDER_BRIDGE_CROSS_PROOF_REQUIRED_FEED` är satt till `null` och golden-
texten i de fyra berörda korpusarna (20260525, 20260610-19h, 20260711-16h,
20260713-41h) omlåstes efter radgranskad diff: samtliga ändringar är
Olidebron-återvinningens effekter (sågtänderna 13→14 och 14→15→16 ersatta av
monotona nedräkningar; CATHARINA-hålet 08:05–08:09 fyllt med 8→6→5→4→strax).
Notis-, fördelnings- och riktningsfacit var byte-identiska före och efter.
Ett medvetet accepterat gränsfall: 20260610 08:10:23 visar nu "strax" vid
sanning ~3,4 min (regelriktigt, snäppet optimistiskt). Källnärvaro-
maskineriet (`_secondSourceFixAt` + TTL) står kvar som återställningsspak
(`'aishub'` återinför dubbelkälle-gatningen).

**Läxa (granskningsrunda 2):** första formuleringen krävde att just
segmentets två fix kom från andrakällan — det gjorde fixen LATENSBEROENDE,
eftersom F6 äter exakt de släpande hub-fixar som annars står i segmentet
(TIM@Järnvägsbron tappades igen vid +30 s, TIM och TIDAN vid +60 s). Grinden
frågar nu om KÄLLNÄRVARO (`_secondSourceFixAt` inom 15 min = 13 pollcykler).

---

## 3. Korskälle-fysiken (P3, V8)

**Rotorsak:** 49 % av de konsekutiva uppdateringarna i 'both'-läget bytte
källa, och just de föll tillbaka på MOTTAGNINGSTIDS-dt — exakt den blandning
klockdomändoktrinen förbjuder. JUNO 265576720 kl. 05:54:47: 245 m mellan en
AISHub-fix och en aisstream-fix som mottogs 17 s isär medan FIXARNA låg 51 s
isär ⇒ 28,6 kn implicerat mot 9,4 verkliga ⇒ falsk `positionUncertain` ⇒
`_canAssignTarget` avvisade måltilldelningen.

**Fix:** regeln bor numera på EN plats — `GPSJumpAnalyzer.fixDtMs` (publik,
anropad av VesselDataService och GPSJumpGateService). Samma källa: oförändrat.
Korskälla: fixseparationen används, men bara när den (a) är ≥ 1 s (AISHubs
TIME är SEKUNDupplöst — allt därunder är kvantiseringsbrus), (b) **VIDGAR**
mottagningsseparationen, och (c) ligger inom 300 s från den (vidgningen ÄR
hubbens pollfördröjning; nattens max var 220,9 s — bortom det är det en
klock-/dataanomali och ett uppblåst fönster gör grindarna godtyckligt
tillåtande). Utan användbar separation: `null` ⇒ anroparen behåller dagens
mottagningstidsuttryck, alltså ingen ny felmod. Koden ANTAR aldrig att
korskälleseparationen är framåt — P3 får inte bero på P1:s F6.

**Läxa (granskningsrunda 2):** V8 motiverades ENSIDIGT. Alla åberopade vinster
är riktningen aishub→aisstream, där fixseparationen är LÄNGRE. Den motsatta
riktningen KRYMPER fönstret systematiskt (252 av 507 accepterade korskällepar,
kvot fixDt/recvDt p10/median/p90 = 0,56/0,84/0,95) och ett kortare fönster
INFLATERAR varje härledd fart: TIDAN 22:59:01→22:59:15 fick northMps 0,333 mot
0,161 och släppte FP9-H':s kajvobbelgrind (tröskel 0,25) — precis den grind som
finns för att PRICKBJORN/HEY JOE-klassen inte ska få målbro på kajbrus. Med
vidgningskravet behålls varje citerad vinst medan ingen fysikgrind kan bli MER
tillåtande än före V8.

---

## 4. AISHub-klienten och grindarna (P4)

### V6 — auth-dödläget brutet
**Rotorsak:** efter `AUTH_FAIL_STOP` (5) sattes `_stopped = true` och INGEN
kodväg återupplivade klienten (`forceReschedule` returnerar direkt på
`_stopped`, muxens `_reconcile` skapar bara nya barn vid cred-/lägesbyte). Ett
ÖVERGÅENDE 403 slog alltså ut andrakällan för processens livstid i ett läge
som ska gå månader utan omstart — och AISHubs stationskrav (≥10 fartyg/7 dygn,
≥90 % upptid) mäts löpande, så access KAN komma tillbaka av sig själv.
**Fix:** permanent stopp ersatt av `AUTH_COOLDOWN_MS` = 6 h ("fyra försök per
dygn"), EN användarnotis per episod, automatisk återupptagning, och ett
välformat svar upphäver allt. Pausen kontrolleras i `_poll` (inte bara i
schemaläggningen) så forceReschedule/feed-vakten/en dubbelbokad timer aldrig
kan slinka förbi den; kadensspärren på 61 s gäller ovillkorligt ovanpå. Enda
vägen till `_stopped` är numera `disconnect()`. Läget syns i
`getConnectionStats().authCooldownMsLeft` och i `[AISHUB_HEALTH]`
(`authCooldownMinLeft=`) — annars ser en sovande källa exakt ut som en tyst
kanal.

**Följdfynd (granskningsrunda 2):** V6 härdade bara 401/403-grenen, som under
hela fältprovet aldrig exekverade. AISHubs DOKUMENTERADE felväg är HTTP 200
med kuvertet `[{ERROR:true, ERROR_MESSAGE:…}]` — access-klassade error-records
pollade vidare 288 ggr/dygn i evighet och emitterade `auth-error` vid VARJE
poll. De går nu genom samma `_noteAuthFailure`. Dessutom: `_failStreak` måste
nollställas med räknaren, annars föll den första pollen efter varje cooldown
rakt in i "≥3 raka" ⇒ en vilseledande pushnotis per dygn, för evigt.

### V7 — kontraktstestet som saknades
Hela batteriet, alla 15 korpusar och alla scenarier passerade om
`AISStreamClient.js:579` raderades — exakt blindfläcken som skapade fältprov
3-regressionen. Nya `tests/kallkontrakt-fixfalt-v7.test.js` matar RÅA
ws-meddelanden (ingen injektion) och asserterar `fixFeed`/`fixTs`/
`fixTsQuality` på både positionsrapport och Class B, plus att `fixTs` är
MOTTAGNINGSTID och inte aisstreams `time_utc` (en falsk `true-fix` hade
avväpnat F6). Motsvarande assertion finns nu även för AISHubClient.

### V4 — latensgrinden (permanent)
`runFusionCorpora.js` kör numera ALLTID två pass: normal leverans och +60 s
LEVERANSLAGG på hub-strömmen (`aisTimestamp` skjuts, `fixTs` orörd —
`shiftFeedDelivery.js`). +60 s är källans egen p90, inte ett konstruerat
extremvärde, och den nivå där gamla koden gick sönder värst. Kravet: EXAKT
samma facit i båda passen, noll dubbletter, OCH att F6 faktiskt fyrade
(`stale_cross_fix > 0`) — annars är den gröna raden ett falskt kvitto.
Latenspasset jämför dessutom passageregistret mot normalpassets: en
latensinducerad PELARE 1-regression var annars osynlig (nattens B+30 s gav
identiskt notismultiset medan `212571000|Järnvägsbron` föll ur
`intermediatePassages`).

### Fältkorpusen — grindens största hål (granskningsrunda 2)
De syntetiska ekona sväljs till 100 % (ekot bär moderfixens fixTs), så grinden
bevisade bara att F-reglerna BLOCKERAR. Muxens accept-väg, segmentbeviset,
korskälle-fysik-dt:t och klockkompensationen var **oexekverade i hela det
permanenta batteriet**. `tests/replay-validation/corpora-data/ais-fusion-20260803-nattkorning.jsonl`
(A/B-nattens B-arm: 371 aisstream + 1014 ÄKTA AISHub-poster) körs därför i fem
varianter — som levererad, +30 s, +60 s lagg samt två KLOCKSKEVSvarianter
(hubben 60 s resp. 5 min FÖRE Homeys). Skevvarianterna är de enda som kan
fälla F6b: både `makeFusionCorpus` och `shiftFeedDelivery` härleder ekots
fixTs ur korpusstämplarna och är per konstruktion blinda för fixtidsskev.

---

## 5. app.js (P5)

### V1 — kajavgångskorroborering (fantomen)
**Rotorsak:** FP9-grenen släppte notisen på ETT momentant `sog ≥ 1,0`. Kring
Kanalinfarten ligger fem kajliggare PERMANENT inne i 300 m-zonen
(119/132/148/211/242 m) — för dem är tröskeln inget transitbevis utan ett
brusprov. PRICKBJORN 07:19:11: sog EXAKT 1,0, cog 128,7° (östbandet ⇒
'unknown', där FP8:s kanalhistorikkrav aldrig aktiveras), 3 m förflyttning;
båten gick sedan BORT (119→143→179→297→387→401 m). Appen skrev själv "quay
wobble, blocking target assignment" sex rader tidigare. Fönstret där båda
villkoren höll var ≤ 66 s brett — gles aisstream missade det, tät dubbelkälla
träffar det.
**Fix:** fartyg med FÄRSK kajstabil historik (bokförd i `_quayStableLedger`)
avkrävs korroborering på sog-benet: `MIN_MOVING_FIXES` (2) på varandra följande
rörelsefixar OCH ingen netto-reträtt, ELLER `NET_APPROACH_M` (40 m)
netto-närmande. targetBridge-benet är orört (målbrotilldelningen har egna
förtöjnings-/kajvobbelvakter), och fartyg utan kajhistorik prövas exakt som
förut. Dedup-nyckeln sätts inte vid skip: en äkta insegling FÖRDRÖJS en fix
(uppfyller båda benen direkt i 4 knop, ~130 m/pollcykel), den förloras aldrig.

Fyra hål som granskningsrunda 2 hittade i den färska fixen — var och en gjorde
grinden nästan verkningslös:
1. **Riktningskravet saknades.** Två rörelsefixar räckte oavsett vart båten
   tog vägen, och eftersom benen är ett ELLER band netto-kravet aldrig ⇒
   grinden var en enpolls fördröjning. Fantomen dog i praktiken av FP8 (cog
   rullade in i sydbandet), inte av V1.
2. **Dödbandet 0,5–1,0 kn.** Ett mellanliggande sampel varken räknade upp
   eller nollade, så sekvensen 1,2 / 0,7 / 1,1 gav `movingFixes = 2` — det är
   kajvobbelns naturliga profil. Dödbandet NOLLSTÄLLER nu.
3. **Grinden var inert för sin målgrupp.** Bokföringen låg bara i
   `_onVesselUpdated`, men kajliggarna kring Kanalinfarten ligger >600 m från
   närmaste bro ⇒ 120 s timeout mot Class B:s 180 s kadens ⇒ nästan varje fix
   blir en VESSEL_ENTERED (PRICKBJORN: 72 cykler på tio timmar).
   `_noteQuayStability` anropas nu i BÅDA vägarna, före notisvägen.
4. **Minnet var för kort och sessionslokalt.** 15 min var KORTARE än
   rapportintervallet för samma fartygsklass i rent aisstream-läge
   (PRICKBJORN 11 glapp > 15 min, KNIGHT OWL max 120 min) ⇒ 2 h. Och en
   appomstart 5 s före kajavgången återskapade fantomen EXAKT (verifierat med
   `ctrl:'restart'`: 25 notiser i stället för 24) ⇒ persistens i
   `quay_stable_ledger`, strypt till en blob var 15:e minut + tvingad vid
   `onUninit`. Den inlärda kajkartan (F4-L) räknas som stillasample.

### V3 — navStatus i replay-fångsten (fältlistoffer nr 13)
`_captureAISReplaySample` fångade inte `navStatus` trots att `vesselPatch` bär
fältet: 0 av 371 aisstream-rader i A/B-korpusarna hade det medan
AISHub-generatorn skrev det för 793 av 1014 poster — arm B fick alltså
förtöjningsdetekteringens lager 3 som arm A strukturellt inte kunde ha.
Artefakten var bevisligen inert den natten (två oberoende kontrollkörningar)
men ogiltigförklarar varje framtida A/B i förtöjnings-/"inväntar"-dimensionen.
Genomgång av vad mer som saknas: `feedSwitch` fångas MEDVETET inte (den är
leveranshärledd och ska räknas om av fusionspolicyn vid replay, inte frysas
in), och heading finns inte i pipelinen alls. De 15 låsta korpusarna saknar
fältet som förut (→ null) och är oberörda.

### Fynd 17 — tystnadsnotisen i skuggläge
`_checkCrossFeedSilence` kunde skicka en användarnotis ("kontrollera
användarnamnet") om AISHub-tystnad medan källan bara var konfigurerad för
SKUGGLÄGE, där den varken påverkar brotext eller notiser. Notisen gatas nu på
`_hubFeedsPipeline()` (`ais_source` ∈ {both, aishub} + username, samma
konfigmatris som muxen). **Loggraden behålls i båda lägena** — den är exakt
vad en skuggkörning ska mäta.

---

## Grindarna G1–G6

| # | Krav | Utfall |
|---|---|---|
| **G1** | `npm run validate` grönt | ✅ 1433/1433 jest (99 sviter), **15/15 korpusar EXAKTA** (30/86/0/3/51/32/33/55/74/55/80/12/48/86/164 — notiser, fördelning, riktning och golden-text oförändrade), 44/44 syntetiska scenarier rena |
| **G2** | `npm run replay:fusion` grönt i BÅDA passen | ✅ 15 korpusar × 2 pass. Normalpasset: 29 219 ekon, samtliga svalda. Latenspasset (+60 s): F6 fyrade i ALLA 15 korpusar (`stale_cross_fix` 6–668/korpus) med identiskt facit och identiskt passageregister. Dessutom fältkorpusen i 5 varianter (se nedan) |
| **G3** | `npm run lint` 0 fel | ✅ eslint rent över hela trädet |
| **G4** | Natt-A: aisstream-läget oförändrat | ✅ **22 notiser**, multiset (mmsi\|bro\|avstånd) IDENTISK med `field-notif.txt`; **45/45 brotextövergångar ordagrant** lika `field-texts.txt` |
| **G5** | Natt-B: alla fem delkraven | ✅ (a) 0 notiser för 265012090 — fantomen borta; (b) `intermediatePassages` bär BÅDE `212571000\|Olidebron` och `212571000\|Järnvägsbron` (11 mellanbropassager mot A:s 6); (c) 24 notiser = A:s 22 nycklar + `212571000\|Stallbackabron` + `219001291\|Kanalinfarten`, **0 dubbletter, 0 saknade**; (d) JUNO 265576720 har target-notis @Klaffbron **06:12:29 på 48 m** (före passagen) och kvarstående notiser för Stallbacka/Strids/Järnvägs/Olide/Kanalinfarten; (e) TIM@Klaffbron 22:23–22:37 stiger som mest **+1 min** (12→13, sedan monoton nedräkning till "strax") mot förfixens 12→17 |
| **G6** | Latensvarianter +30 s / +60 s | ✅ Notisnyckel-multiset **IDENTISK** med G5:s i båda, 0 dubbletter, ingen PRICKBJORN. Fältkorpusens fem varianter: B (24/24, 11 mellanbropassager, 1093 accepterade varav ~722 hub), B+30s (24/24, 11, 1050/679), B+60s (24/24, 10, 1024/653), B+60s med hubklockan 60 s FÖRE (24/24, 10, 1030/659, `hubOffsetMs=−57588`), B med skev +300 s (24/24, 11, 1093/722, `hubOffsetMs=−299442`) |

Testtillskott: fem nya sviter (`kajavgang-korroborering-v1`,
`under-bridge-segmentbevis-v2`, `korskalla-fixdt-v8`, `kallkontrakt-fixfalt-v7`,
`fusionsgrind-latenspass-v4`) plus utökningar i fusion-/mux-/klient-/
gate-sviterna. `runSoak.js` (72 h) kördes INTE denna omgång — den bör köras
före publicering, inte före A/B-testet.

---

## 6. Kvarstående kända begränsningar (medvetet ej åtgärdade)

| # | Fynd | Varför den står kvar |
|---|---|---|
| **10** | `FEED_WATCHDOG` kan strukturellt inte se PER-FARTYGS-degradering: den mäter aggregerad tystnad med 20 min-tröskel. Nattens värsta systemvida aisstream-tystnad var 9,4 min — under halva tröskeln — samtidigt som ETT fartyg var osynligt i 20 min (JUNO, hela målbropassagen) och ett annat i 2 h | En per-fartygs-vakt kräver att man definierar "förväntad kadens" per fartyg (Class A 2–10 s, Class B 30–180 s, kajliggare timmar) — en modell som INTE finns i koden och som skulle behöva kalibreras mot flera dygns data. Fel kalibrerad blir den antingen tyst eller en larmspruta. Och: en larmande vakt löser inte problemet — datan finns ändå inte. Det AISHub gör åt just den här klassen är hela dess mervärde, och det ska MÄTAS i nästa A/B, inte gissas |
| **11** | Exit-failsafens 25-minutersgräns ger antingen värdelöst sena notiser eller tysta missar: SALTYX fick sin Kanalinfarten-notis 15 min för sent, NANNA fick ingen alls och INGEN failsafe loggade något (`[EXIT_TRIGGER_STALE] … last position 1800s ago`). De 5 `[FALLBACK_BOAT_NEAR]` underskattar därmed missarna — den verkliga siffran är minst 7 | Rör exit-/failsafe-kärnan, som är facit-låst i flera korpusar (LYS-completed, ELFKUNGEN-retursessionsdedupen, exit-radien 400→800 i F5-B). Projektet har fällt fem "uppenbara" varianter i just den vägen. Kräver egen valideringsrunda + användarbeslut, inte en sidoåtgärd i en härdningsetapp. Notera också att båda fallen hade 31 resp. 10,5 minuters tystnad i BÅDA källorna — ingen datakälla räddar dem |
| **18** | Stallbackabrons brokoordinat ligger ~196–220 m vid sidan av farleden (58.31142992 / 12.31456386). Ingen av nattens tre passerare kom närmare än 196 m; 300 m-radien ger bara ~80–105 m effektiv marginal ⇒ ~25–30 s notisfönster vid 7 kn | Fyndet är **inte verifierat mot en kartkälla** — det vilar på att observerade passager aldrig kom nära. Att flytta en brokoordinat ändrar avstånd, ETA och passagedetektering för varje korpus som innehåller bron (minst fyra) och skulle kräva omlåsning av både notis- och textfacit. En koordinatändring får bara göras mot en auktoritativ källa (sjökort/Trafikverket), aldrig mot en natts sampel. Stallbackabron öppnas dessutom aldrig — den är ren informationsbro |
| **19** | Otestad felmod: målbrons `distance_fallback` (`confidence 0,50`) kan registrera en falsk passage för ett fartyg som når ~12 m från målbron och STANNAR för att invänta öppning. B:s bästa latenssiffra (TIM@Klaffbron, 5 s efter sanningen) vilade på just den vägen: `lineCrossResult: "not_crossed"`, position 11,9 m söder om bron | Ingen båt avbröt en insegling under natten — risken är OMÄTT, och risken ökar med tätare sampling. Att skärpa fallbacken (kräva linjekorsning eller rörelse-bort) utan ett enda observerat fall vore precis den breda designändring facit-fällan straffar: den skulle också träffa varje legitim passage där linjegeometrin missar. Kandidat för nästa A/B: leta specifikt efter en båt som stannar i under-bro-zonen |
| **8** | F5-flaggan konsumeras aldrig i praktiken: alla 15 källbyten låg på 152–249 m medan enda konsumenten läser >500 m | Skadan F5 skulle ha täckt (bakåtflyttning ⇒ dubbelnotis) stängs numera av F6 vid roten. Att sänka `GPS_JUMP_THRESHOLD` för att "aktivera" F5 hade rört den globala jump-tallyn i alla lägen — brett, alltså facit-farligt, utan känd vinst |
| — | ~~**Segmentbevisets källgrind** (V2)~~ **ÅTGÄRDAT samma dag (användarbeslut):** grinden breddad (`UNDER_BRIDGE_CROSS_PROOF_REQUIRED_FEED = null`), de fem historiska passagerna återvunna, golden-text i fyra korpusar omlåst efter radgranskad diff | Se §"Källgrinden var en utrullningsspärr" ovan. ALICE-testet låser numera återvinningen; TTL-testet låser att breddningen är i kraft |
| — | ~~**`[FUSION_HEALTH]` klockfälten**~~ **ÅTGÄRDAT samma dag:** `_emitFusionHealth` läste `x.lag` medan `pushClockSample` skriver `{v, at}` — klockfälten renderades alltid `-` | Rättat (`x.v`) + mux-testet asserterar nu att `hubLagMinMs`/`hubLagMedianMs` bär tal när hub-sampel finns |

---

## Slutläge

- 1433/1433 jest (99 sviter), 15/15 korpusar EXAKTA, 44/44 scenarier, lint rent
- `replay:fusion` grön i 2 pass + 5 fältvarianter (accept-vägen exekverad för
  första gången i det permanenta batteriet)
- Natt-A byte-trogen (22 notiser, 45 texter ordagrant) — aisstream-lägets
  beteende är OFÖRÄNDRAT
- Natt-B: fantomen borta, båda mellanbropassagerna räddade, sågtanden borta
  (max +1 min), JUNO-vinsterna kvar, 0 dubbletter vid 0/+30/+60 s latens och
  vid 60 s/5 min klockskev

**Rekommendation:** kör det avgörande A/B-testet — helst en TÄT DAG med många
kajavgångar och Class B-fritidsbåtar, inte ännu en tyst natt. Avgörande utfall
enligt syntesen: (1) minst en målbropassage där B ger förvarning som A inte
hade, (2) noll fantomer på ≥10 observerade kajavgångar inuti en triggerzon,
(3) noll dubbletter vid +60 s, (4) noll tappade mellanbropassager i B relativt
A. Punkt 3 och 4 är nu permanenta grindar i batteriet; 1 och 2 kan bara
mätas i fält. `debug_level='full'` är fortfarande ett absolut krav — utan
poll-nivåfångsten går ingen incident att replaya.

## Tillägg 2026-08-03b: förvarningsfönstret som kandidat-etapp

JUNO@Klaffbron kvantifierar grundproblemet: notisfönstret vid 300 m-radien är
~85–115 s i kanalfart, och varje latenskälla (Class B-slot 30 s, pollkadens
65–70 s, fixålder p90 62 s) är i samma storleksordning. 48 m-fixen togs 16 s
FÖRE korsningen men levererades 54 s senare → notis 38 s efter. `both`-läget
adresserar leveransvägen (push när aisstream lever); om förvarningstiden efter
nästa A/B fortfarande bedöms för kort är rätt nästa etapp en av:
  (a) tidigare avfyrning (större radie eller ETA-trigger ≤3 min) — köper
      3–5 min fönster mot fler falska förvarningar från kajvändarklassen;
  (b) dead reckoning-avfyrning (projicerad position når radien, hårda vakter:
      max ~90 s extrapolering, färsk kurs mot bron, avbrott vid motbevis) —
      hade räddat JUNO även i ren aisstream-arm.
Båda är breda ingrepp i notistidpunkterna = egen etapp med eget fältprov och
eget facit. INTE påbörjad här.
