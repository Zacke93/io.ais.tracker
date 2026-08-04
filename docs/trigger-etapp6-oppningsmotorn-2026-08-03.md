# Trigger-etapp 6 — öppningsmotorn: notislöftet härdat mot radiotystnad (2026-08-03)

## Bakgrund

Appens andra pelare — `boat_near`-flowkortet — är **reaktivt**: notisen kräver
ett AIS-fix inne i 300 m-zonen. Den konstruktionen har ett hål som ingen
mängd finslipning av gaterna kan täppa: **om båten tystnar på slutsträckan
kommer notisen aldrig**, hur välfungerande resten av kedjan än är. Man står
vid en öppen bro utan att ha blivit varnad.

Tre observationer drev etappen:

**1. JUNO-fallet (A/B-natten 2026-08-03).** Öppningen 06:11:51 vid Klaffbron
tog tre båtar — JUNO, NANNA och SALTYX — i EN och samma broöppning. Alla tre
saknade notis. Men JUNO sände hela vägen in: hennes data ensam hade räckt för
att varna för öppningen som alla tre passerade genom. Det pekade på att
evidensen hör hemma **per bro**, inte per båt — en sändande båt i en konvoj
täcker sina radiotysta grannar.

**2. 700-metersfallet (användarens designkrav).** Sista fix 700 m från bron i
7 knop, därefter total tystnad. Varningen ska ändå gå ut i tid. Det kräver att
avfyrningen garanteras av en **deadline** i stället för av nästa meddelande —
en äggklocka som ringer även om ingenting mer hörs.

**3. Täckningskartan.** Etappens första leverabel (se nedan) mätte hålen:
i **28 %** av de passager där inseglingen verkligen observerades fanns inte en
enda fix på de sista 300 metrarna. Hålet var alltså inte ett kantfall.

### Produktprincipen som styrde designen

> En **missad öppning** (stå vid öppen bro) är VÄRRE än ett **falsklarm**
> (onödig heads-up).

Accepterad falsklarmsklass: båt som stannar eller vänder EFTER sista fixen mitt
i en beväpnad approach. **Inte** accepterad: kajliggare och kajvobblare som
aldrig gör en riktig avgång.

**Det viktiga undantaget:** en båt som stannar NÄRA bron är *normalfallet* för
en öppning — hon väntar på att bron ska öppna. Ett stopp i väntzonen får därför
aldrig avväpna. Öppningen kommer ju.

---

## Leverabel 1 — Täckningskartan

`tests/replay-validation/coverageMap.js` → `docs/coverage-map-2026-08-03.md`
(+ `.json`). Diagnosverktyg, **ingen gate**. Farleden modelleras som en
centerlinje, varje fix projiceras på den, och 100 m-segment räknar transitfixar,
glapp, mörka passager och blackouts **per källa**.

### Huvudfynd

| Fynd | Siffra |
|---|---|
| Underlag | 16 korpusar, ~250 h, 7113 fixar, 201 fartygsspår |
| Medianglapp mellan två fixar i transit (aisstream) | **120 s** (p90 421 s) |
| Målbroinsegling utan en enda fix sista 300 m | **28 %** av 159 observerade inseglingar |
| Mediantystnad fram till passagen | 126 s (p90 779 s) |
| Stadssektorn (Klaffbron↔Järnvägsbron) | 0,25 fix/min mot 0,34 i övriga sektorer |
| Sämsta segment (ändpunktsattribuerat) | Kanalinfarten 0–100 m, 240 s medianglapp |
| Kajen norr om Klaffbron | 0,22 fix/min, 80 % mörka traverseringar |

**Verdikt i tre punkter.** (a) Mottagningen är gles i hela kanalen, men
medianglappet ligger *under* blackouttröskeln — de långa hålen är svansen, inte
normaltillståndet. (b) Stadssektorn är sämre i *fördelning* snarare än i
*mängd*: lika många fixar, men de kommer i klumpar med långa hål emellan, vilket
är exakt den felmod som fäller ett notislöfte. (c) Tvåkällenatten ger **inget**
stöd för att den egna antennen hör båtar som AISstream missar — gallrar man
AISHub ned till AISstreams fixantal blir källorna oskiljbara. Skillnaden är
leveransvolym, inte antenn.

⚠️ Kartan mäter **levererad** täckning, inte radiotäckning, och körs i
fixtidsdomänen (`fixTs`) — mäter man AISHub i leveransdomänen blir allt
65 s-kvantiserat av pollkadensen.

---

## Leverabel 2 — Öppningsmotorn

Nytt flowkort `bridge_opening_soon` (app-nivå, precis som `boat_near`), ägt av
`lib/services/BridgeOpeningService.js`. **Helt additivt** — rör varken
boat_near-dedupen, bridge_text eller något befintligt facit.

### De tre mekanismerna

**(a) Bro-centrerade öppningshändelser.** Evidens ackumuleras per MÅLBRO
(endast Klaffbron och Stridsbergsbron — Stallbackabron öppnar aldrig). En
händelse öppnas när första båten beväpnas, ackumulerar båtar, och avfyrar EN
gång. En sändande båt täcker radiotysta grannar i samma konvoj.

**(b) Deadline-motorn ("äggklockan").** Per beväpnad båt beräknas *tidigast
möjliga* ankomst pessimistiskt: `avstånd / 10 kn` räknat från fixets tid.
Varningen avfyras senast vid `tidigast_ankomst − 180 s` — även i total
radiotystnad.

**(c) Tidig beväpning, sen avfyrning.** Bevisinsamling börjar vid 2500 m, inte
vid 300 m. **Tystnad kan aldrig avväpna** — bara motbevis.

### Tick-doktrinen

Servicen äger **inga timers**. `tick()` anropas från den befintliga
30 s-watchdogen, och anropet ligger FÖRE watchdogens tomkanals-retur — annars
dör deadline-motorn exakt när den behövs (båten timeout:ad, kanalen tom).
Samtliga marginaler är dimensionerade så att ±1 tick (30 s) aldrig äter
garantin.

---

## Tröskeltabellen — varje värde grävt ur korpusarna

Underlag: 16 korpusar, ~250 h, 245 målbropassager, 188 öppningar.

| Konstant | Värde | Härledning ur data |
|---|---|---|
| `ARM_MAX_DISTANCE_M` | **2500 m** | Ger 245/245 passager varnade före (100 %). ARM=2000 gav 242/245 utan beväpningsgrind och **232/245 med rörelsegrind** — bland missarna nattens NANNA/SALTYX. Bortom 2500 m börjar horisonten svälja Olidebron-trafik som ännu inte valt målbro. |
| `ARM_RELEASE_DISTANCE_M` | **3000 m** | Hysteres ×1,2 (samma filosofi som `STATUS_HYSTERESIS` 480/580 ≈ ×1,21) så en båt som guppar kring gränsen inte av- och återbeväpnas — och därmed inte kan generera en ANDRA varning för samma anflygning. |
| `DEADLINE_MAX_SPEED_KN` | **10 kn** | 1798 anflygningssampel: effektiv anflygningsfart median 3,13 kn, p90 5,24, p99 6,97, **max 9,37** (DIANA @ Stridsbergsbron). Garantibrott per tak: 7 kn → 16 brott, 8 → 9, 9 → 2, **10 → 0**, 12 → 0 men 21 % längre ledtid utan täckningsvinst. |
| — varför inte `sog × faktor` | | Kvoten `veff/sog` är obegränsad vid låg sog (median 0,89, **max 10,32**): en båt still vid ett fix kan vara i full fart vid nästa. Hela svepet över (CAP, F, FLOOR) hade 0,56–27,75 % garantibrott — ingen parametrisering nådde noll. Ren avståndsformel fungerar dessutom **identiskt för fartgivarlösa båtar** (sog = null), klassen som fällt fyra tidigare granskningsrundor. |
| `WARNING_LEAD_MS` | **180 s** | Järnregeln kräver ≥ 90 s; 180 s = SEX tick-intervall, så tre raka försenade ticks inte kan äta marginalen. Täckningen är IDENTISK (242/245) över hela 90–300 s — ledtiden köper **marginal, inte träffar**. Kostnad: medianavstånd vid avfyrning 1206 m (LEAD=90) → 1422 m (LEAD=180). |
| `FIRE_EXPECTED_ETA_MS` | **5 min** | Ren snabbbåts-påfyllnad. Deadline-grenen ensam fyrar vid ~926 m; för medianbåten är 5 min = 483 m, alltså *innanför* och utan effekt. För en 9,5-knopsbåt är det 1466 m. Tightaste fallet i korpusen: JUNO från 2400 m, 184 s marginal. |
| `CONVOY_WINDOW_MS` | **10 min** | Klustring av alla 245 passager: 3 min → 209 öppningar, 5 → 196, 8 → 191, **10 → 188**, 15 → 178, 20 → 168. Kurvan planar ut mellan 8 och 10 min (3 nya sammanslagningar) och brantar sedan (10→15 slår ihop 10 till). Vid Klaffbron ligger 18,9 % av gapen ≤10 min medan p25 är 16,4 min — 10 min hamnar i den naturliga svackan. |
| `DISARM_MOORED_MIN_DISTANCE_M` | **600 m** | Stopp ≥5 min vid bevisad målbro som ÄNDÅ följdes av passage (45 st), per avståndsband: 100–200 m: 6 · 300–400: 12 · 400–500: 7 · 500–600: 3 · 800–1000: 1 · 1000–1200: 5 · 2000–3000: 11. **28 av 45 under 600 m, och bandet 600–800 m är TOMT** — gränsen ritas av datan. |
| `ARM_STALE_TTL_MS` | **30 min** | 5,4× den längsta tystnad en arm behöver överleva för att hinna avfyra (306 s teoretiskt, 336 s med tick-rastrering). Medvetet identiskt med `TIMEOUT_SETTINGS.ACTIVE_JOURNEY_MIN`: en arm ska aldrig överleva det fartyg den beskriver. |
| `MAX_ARMS` | **500** | Rent minnesskydd, samma skala som `FUSION.STATE_MAX_ENTRIES`. Max samtidigt beväpnade vid EN målbro i korpusarna: **6**. |

### Den viktigaste slutsatsen ur grävningen

Samma mätning som gav 600 m visade att **ett stopp aldrig ensamt får avväpna,
oavsett avstånd**. Det längsta "stanna och sedan passera ändå" låg på **2913 m**
(AQUILA, 17 min stopp → passage 26,5 min senare) — bortom hela
beväpningshorisonten. Elva sådana fall låg i bandet 2000–3000 m, och TIM och
TIDAN från nattkorpusen ingår. En regel av typen *"stopp långt ut avväpnar"*
hade alltså skjutit bort just den trafik som lagret finns till för.

Endast förtöjningsklassningen duger som motbevis — och den kan inte ta fel här:
stopp med navStatus 1/5 som ÄNDÅ följdes av passage är **0 av 56**.

Marginalen mot 2 h-backstopen: längsta stopp som ändå följdes av passage var
**102 min** (S/Y NANNA, 383 m från Klaffbron) — 18 min under
`MOORING_DETECTION.MAX_STATIONARY_WAIT_MS`, och NANNA skyddas dubbelt eftersom
383 m < 600 m.

---

## Grindarna — utfall

| Grind | Krav | Utfall |
|---|---|---|
| **G1** `npm run validate` | jest grönt, replay:all EXAKT facit, syntetiska rena | ✅ **1551 tester / 103 sviter**, 15 låsta korpusar exakt, 45 scenarier rena |
| **G2** `npm run replay:fusion` | 2 pass + 5 fältvarianter oförändrat | ✅ grön |
| **G3** `npm run lint` | 0 | ✅ 0 |
| **O1** Öppningstäckning | varje målbropassage varnad FÖRE; varje miss klassad | ✅ **222/223 (99,6 %)**, 1 klassad miss (`FÖRST_SEDD_FÖR_NÄRA`), 0 oklassade |
| **O2** Fantomtak | varning utan passage klassad mot rådata; kajvobbel = rött | ✅ **0 röda** av 255 varningar |
| **O3** Nattkorpusen | 6/6 öppningar varnade före, konvojen som EN varning | ✅ 6/6, konvojen EN varning, boat_near oförändrad |
| **O4** 700-metersfallet | enhetstester på riktiga servicen | ✅ alla fem fallen |
| **O5** Öppningsfacit | `opening-distribution.json` genererad + jämförd | ✅ låst, jämförs i `runAllCorpora` |

### Ledtidsfördelning (O1)

Median **17,4 min**, min 2,4 min, p10 7,5 min, max 87,4 min. **1 tunn ledtid**
(141 s mot utlovade 150 s, 20260708-21h). Avfyrningsfördelningen visar att
äggklockan bär lagret: **fix 28 / deadline 227** — deadline-motorn står för
89 % av varningarna, vilket är hela poängen.

Nattkorpusen (designfallet), samtliga deadline-avfyrade:

| Öppning | Varnad | Marginal före sann passage |
|---|---|---|
| TIM @ Klaffbron | 22:30:15 | 8,5 min |
| TIM @ Stridsbergsbron | 22:39:45 | 7,7 min |
| TIDAN @ Klaffbron | 23:41:45 | 8,6 min |
| TIDAN @ Stridsbergsbron | 23:52:45 | 5,9 min |
| JUNO @ Stridsbergsbron | 05:58:45 | 5,2 min |
| **Konvojen @ Klaffbron** | 06:05:15 | 6,6 min — EN varning täcker 06:09–06:13 |

Det sista är JUNO-fallet ur bakgrunden, nu löst: en varning, tre båtar.

---

## Falsklarmsklasserna — uppmätta frekvenser

Av **255 varningar** över alla 16 korpusar:

| Utfall | Antal | Andel | Bedömning |
|---|---|---|---|
| Bekräftad passage inom 20 min | 121 | 47 % | Kärnfallet |
| Passage senare än 20 min — `GARANTIPRIS` | 81 | 32 % | **Accepterad.** Effektiv anflygningsfart lägre än det pessimistiska 10-knopstaket; tidigheten ÄR garantin |
| Ingen passage — `AVBRUTEN_APPROACH` | 50 | 20 % | **Accepterad klass** enligt produktprincipen: äkta beväpnad approach som avbröts efter sista fixen |
| Ingen passage — `GLES_ANFLYGNING` | 3 | 1 % | **Accepterad.** Rörelsebevis fanns men glest |
| `KAJVOBBEL` | **0** | 0 % | **Skulle varit rött** — V1-kajbokföringen håller |
| `UTANFÖR_HORISONTEN` / `OFÖRKLARAD_TIDIGHET` | **0** | 0 % | Skulle varit rött |

Sena passager: median 30,1 min, max 85,9 min. Det är priset för att taket är
satt på maxobservationen (9,37 kn) i stället för på medianen (3,13 kn) — och
det priset är medvetet, eftersom alternativet är garantibrott.

**Den centrala siffran: noll kajvobbel-fantomer.** Den klass användaren
uttryckligen inte accepterar förekommer inte i något korpusutfall.

---

## Facit-dimensionen (O5)

`tests/replay-validation/opening-distribution.json` — multiset
`bro:riktning → antal` per korpus. Samma roll för `bridge_opening_soon` som
`corpora-direction-distribution.json` har för `boat_near`.

Motivet är att **notisfacit, riktningsfacit och golden-text per konstruktion är
BLINDA för den nya dimensionen** — utan filen kan en tappad eller uppdiktad
öppningsvarning inte upptäckas av någon gate.

Regenereras endast via `REGEN_DISTRIBUTIONS=1 npm run replay:all` från en grön
körning, aldrig för hand. Saknas filen skriver `replay:all` en högljudd rad;
saknas en LÅST korpus i den är det ett **hårt fel** (den gropen — "saknas filen
⇒ kör informativt" — var en gång öppen och stängdes i granskningen).

Ny WARN-invariant **INV-21**: öppningsvarning efter registrerad målbropassage
för samma händelse. Tyst över samtliga korpusar och soaken.

### Låsningens verifiering

Facit genererades om från noll via REGEN-vägen och blev **byte-identiskt**
(sha256 `250f3b9e…`) — utfallet är alltså reproducerbart, inte en ögonblicksbild.
Riktningsfacit och samtliga golden-text-filer var **oförändrade** efter samma
regen-svep (git status ren), vilket är kravet: det nya lagret får inte röra det
gamla.

Gaten sabotagetestades i tre lägen — fel antal, uppdiktad nyckel, och hel korpus
borttagen ur facit. Samtliga tre fälldes med exit 1:

```
❌ REGRESSION  20260611-4h  ÖPPNINGSFÖRDELNING AVVIKER: Stridsbergsbron:northbound: 1 (facit 2)
❌ REGRESSION  20260702-2h  ÖPPNINGSFÖRDELNING AVVIKER: Klaffbron:westbound: 0 (facit 1)
❌ REGRESSION  20260711-7h  ÖPPNINGSPOST SAKNAS i opening-distribution.json
```

### Stickprov mot rådata (5 poster)

| # | Fall | Bevis ur korpus-jsonl |
|---|---|---|
| 1 | HOKUS POKUS @ Stridsbergsbron (fix) | Varning 09:58:31.845 sammanfaller med råfixen `d=167 m, sog=2.1 kn`. Passage 4,5 min senare. |
| 2 | NORDIC SOLA @ Stridsbergsbron (deadline) | Sista fix 01:22:40 `d=1128 m, sog=5 kn`, sedan **49 s tystnad** → deadline fyrar 01:23:28. Båten vid bron 01:28:00 (`d=117 m`). Äggklockan i ren form. |
| 3 | CLABBYDOO @ Klaffbron (fix) | Första råfixen 11:29:18.616 `d=352 m, sog=4.8, cog 220` (sydgående) — varningen ligger 2 ms före, dvs. **är** den fixen. Passage 11:44:45 (`d=12 m`); dröjsmålet är att hon saktade till 0,8 kn och **väntade vid bron** — normalfallet. |
| 4 | KNIGHT OWL @ Stridsbergsbron (deadline) | 2398→1878 m i 5,6 kn nordgående, sedan **186 s tystnad** → varning 13:00:37. Nästa fix 13:06:30 visar `d=882 m, sog=0.1` och hon står kvar (885, 887 m) i 30+ min. **Äkta `AVBRUTEN_APPROACH`** — den accepterade falsklarmsklassen, korrekt klassad. |
| 5 | JUNO @ Klaffbron — konvojfallet | Sista fix 06:04:33 `d=1170 m, sog=5.5 kn` [aishub], **42 s tystnad** → varning 06:05:15. Passage 06:12:29 (`d=48 m`). Varningen täcker NANNA och SALTYX i samma öppning. |

Fall 4 är värt att notera: det ser ut som ett falsklarm och **är** ett falsklarm
— men av exakt den klass produktprincipen accepterar. Båten gjorde en äkta
beväpnad approach i 5,6 knop och avbröt efter sista fixen. Tystnad kan inte
avväpna, och det är designvalet.

---

## Kvarstående begränsningar (medvetna)

**1. Den ensamma radiotysta båten.** En båt som är tyst i ALLA källor på hela
anflygningen kan inte varnas — det finns ingen observation att beväpna på.
Klassen heter `TYST_I_HORISONTEN` och är per konstruktion olöslig utan mer
mottagning. Konvojtäckningen mildrar den bara när någon annan sänder.

**2. Ingen arm-persistens över omstart (v1).** Armarna lever i servicens Map och
försvinner vid omstart; `boat_near`-lagret är oförändrad fallback. Dedupen
persisteras dock (`persistent_opening_warnings`, 10 min) så en omstart mitt i en
anflygning inte ger dubbelvarning. Medvetet val — persistens av armar kräver att
tillståndet överlever en kodversionsväxling, vilket är en egen etapp.

**3. Lokal källa ej byggd.** Täckningskartan visar att hålen finns; den ger
**inget** stöd för att en egen antenn skulle täppa dem (källorna är oskiljbara
vid samma fixantal). En lokal mottagare är alltså inte motiverad av den här
mätningen.

**4. En tunn ledtid kvarstår** (141 s mot utlovade 150 s). Den ligger över det
hårda golvet (60 s) och över tick-jittret, men rapporteras av grinden så att den
inte tystnar in.

**5. Sena varningar är priset för garantin.** Median 30,1 min för de sena
passagerna. Att sänka taket från 10 kn skulle korta dem — och återinföra
garantibrott. Avvägningen följer produktprincipen.

---

## Slutläge

Notislöftet vilar inte längre på att båten sänder på slutsträckan. 222 av 223
målbropassager varnas i tid, 89 % av varningarna kommer från äggklockan snarare
än från ett meddelande, och den falsklarmsklass användaren inte accepterar
(kajvobbel) förekommer inte i något korpusutfall. Det nya lagret är helt
additivt: samtliga befintliga facit — notiser, riktningar, golden-text — är
oförändrade.
