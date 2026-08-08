# Dirigentens egna mätningar — 42h-körningen (gjorda FÖRE agenternas rapporter)

Syfte: korsvalidera analysagenternas sifferpåståenden. Allt nedan är verifierat av dirigenten
själv med egna kommandon mot rådata.

## Baseline (före allt)
`npm run validate` exit 0 · `npm run replay:fusion` exit 0 · `npm run lint` exit 0. Rent träd
på main @ `acc0281`.

## Körningens grunddata
- Logg `app-20260806-005440.log`, 870 167 rader, 2026-08-05T22:54:52 → 2026-08-07T16:44:01 UTC
  (**41 h 49 min**). `source=both`, debug_level full.
- 3 922 replay-sampel · 29 fartyg · **100 % `feed:"aishub"`, 0 aisstream**
- 135 boat_near · 301 dedupade brotexter · 36 bridge_opening_soon · 31 deadline · 48 arm ·
  51 disarm · 6 recover · 4 clear · 6 `[err]` (alla 503) · 0 GLOBAL_TOKEN_TIMEOUT

## Trohet (bypass-replay av korpusen mot fältet)
| Dimension | Utfall |
|---|---|
| Notiser (mmsi:bro) | **135/135, 0 diffposter — EXAKT** |
| Öppningar (bro:riktning:antal) | **36/36, 0 diffposter — EXAKT** |
| Öppningar (bro:ledare) | **36/36, 0 diffposter — EXAKT** |
| Texter | 301 fält vs 306 replay, ~25 sekvensdiffar (ETA-rastrering + efterspel) |

## Rådatafacit (egen geometri)
137 korsningar: Stallbacka 20 · Stridsberg 18 · Järnväg 16 · Klaff 19 · Olide 22 ·
Kanalinfarten 42. **Känd blindfläck:** gap > 15 min filtreras ⇒ passager under AIS-tystnad syns
inte i facit (det förklarar flera "kandidatfantomer").

## Pelare 3 — öppningsvarningar mot ledarens faktiska passage
Av 36 varningar: **19 kom ≤20 min före** ledarens passage · **9 kom >20 min före**
(max 191 min, MISTRAL Klaffbron#21) · **8 följdes aldrig av att ledaren passerade den bron**.
Flera av de 8 är sannolikt facitets blindfläck (LENYA #32, FARUREJ #36) — måste verifieras per fall.

**Rådataverifierat ovarnat fall (C7 U-svängslåsningen):** ELFKUNGEN (265573130) 2026-08-07
passerade Klaffbron **norrut ~10:17** (sampel 10:16:07 lat 58.28192 cog 14,5° → 10:18:20
lat 58.28475 cog 16°; varnad av Klaffbron#22), låg still 10:28:30–10:34:02 (sog 0 @ 58.2858),
vände och passerade **söderut ~10:38** (10:37:28 sog 3,7 cog 196,6° → 10:38:35 lat 58.28402
cog 185,8°). Andra passagen fick **ingen öppningsvarning**.

**Fantom, rådataverifierad:** Klaffbron#26 (ELFKUNGEN, 2026-08-07T11:41, eta=25 min) — hon var
kl 11:08:47 på lat 58.26494 lon 12.26068 cog 261° på väg västerut UT ur kanalen. Ingen passage följde.

## Pelare 2 — notiser
Status: waiting 56 · en-route 16 · passed 16 · under-bridge 15 · stallbacka-waiting 14 ·
approaching 9 · **passage-inferred 9**.
**Alla 8 notiser med distans > 600 m är `passage-inferred`** (max 2 294 m). Fem notisskurar där
användaren fick 2–3 notiser i samma minut, t.ex. LENYA 2026-08-07T14:41: klaffbron/2 294 m +
olidebron/954 m + kanalinfarten/340 m — efter 68 minuters AIS-tystnad (gap 4 104 s).

### Kandidatmissarna vid Kanalinfarten — ALLA TRE DEMENTERADE av dirigenten
Mitt eget rådatafacit pekade ut tre "missade" Kanalinfarts-passager. Rådata fäller alla tre:
- **BOBLEN (219036470)**: 16 sampel 2026-08-06T06:27–07:21, avstånd till triggerpunkten
  **293–555 m**, sog 0–0,4 genomgående. Kajliggare som aldrig kom in i 300 m-radien; det enda
  "intrånget" (293 m kl 06:57:47) är kajvobbel. Ingen notis = KORREKT.
- **S/Y DESIREE (265731470)**: 19 sampel 13:31–13:54, avstånd **280–366 m**, sog 0,2–3,8,
  fram-och-tillbaka-manöver utanför radien. Ingen notis = KORREKT.
- **SKYBIRD (235056679)**: fick notis kanalinfarten@10:53/208 m. Facitets två "intrång" mot en
  notis är korrekt dedup. Ingen miss.
⇒ Mitt facits Kanalinfarts-dimension är brusig; pelare 2:s betyg ska inte belastas med dessa.

### Kandidatdubbletterna — ALLA FYRA DEMENTERADE av dirigenten
- **MOKENDEIST (211214850) @ Stridsbergsbron**: notis 09:17:19 (253 m, `waiting`) när hon ankom,
  därefter **sog = 0 på 112–117 m från 09:20:43 till 11:42:23 (2 h 22 min väntan)**, sedan notis
  11:43:30 (41 m, `under-bridge`) vid den faktiska passagen. Två skilda händelser.
- **MISTRAL (219025192) @ Stridsbergsbron**: samma mönster — notis 09:13:58 (258 m), väntan
  sog = 0 på 165–170 m i **2 h 27 min**, notis 11:43:30 (73 m) vid passagen 11:44:24.
- **MARY (219028537) @ Klaffbron**: notis 13:18:07 (252 m, `waiting`), manöver kring bron
  13:19–13:30, notis 13:41:44 (120 m, `under-bridge`) vid utpassagen.
- **ELFKUNGEN (265573130) @ Järnvägsbron**: notis 10:26:40 (93 m, nordgående) och 11:59:35
  (238 m, sydgående) — **två separata resor**; hon var 2 936 m bort kl 10:40:19 och återkom
  11:46:28. Helt legitima.
⇒ **Hela kandidatlistan utom fantomerna är dementerad.** Pelare 2 står betydligt starkare än
råjämförelsen antydde. Kvarstår att pröva: de 6 kandidatfantomerna (varav LENYA och NIGE-O
redan visats vara `passage-inferred` efter äkta passager under AIS-tystnad).

### Sidoobservation: långa väntetider vid bro är vanliga
Tre rådataverifierade fall på 42 h där en båt låg **sog = 0 i > 90 min** vid en målbro med
kontinuerlig AIS: ANDREA 98 min (Stridsberg), MOKENDEIST 2 h 22 min (Stridsberg), MISTRAL
2 h 27 min (Stridsberg). Det är kontexten som gör "strax"-texten problematisk — och det är
INTE C11 (ingen av dem var AIS-tyst).

## Pelare 1 — brotexten
Total tid 2 509 min · "Inga båtar" 1 652 min (66 %) · med båttext 857 min.
**Längsta enskilda text: 114 minuter** — 2026-08-06T16:42:33 "En båt på väg mot Stridsbergsbron,
beräknad broöppning strax". Rådata (ANDREA 219031446): hon sände kontinuerligt (1,1 min kadens),
låg **sog=0 från 16:51 till 18:29** på 58.29455/12.29702 (~110 m N om Stridsbergsbron) och
passerade 18:36. **Texten var sakligt sann — men "strax" stod i 114 min.** Detta är INTE C11
(båten var aldrig AIS-tyst). Näst längsta: 42 min och 29 min, båda "strax".

## B2 källdödslarmet — kodverifierad defekt
`AISStreamClient.js:230` ger `timeSinceLastMessage: null` när källan **aldrig** levererat →
`app.js:7889` sätter `sSilence = Infinity` → `app.js:7932` loggar "**Infinity min**" (bekräftat
153 ggr i fält) och `app.js:7941` anropar `_escalateSilenceNotices(..., Infinity, ...)`.
Eftersom `Infinity >= step.ms` är sant för **båda** stegen (`CONNECTION_ALERT.ESCALATION_STEPS`
= 1h, 4h) fyras **bas- + 1h- + 4h-notisen samtidigt vid första 15-minutersutslaget**, med
texterna "har varit tyst i över 1h" respektive "över 4h" vid en tidpunkt då tystnaden var
15 minuter. Därefter tystnad i 24 h (dedupen). Samma hål finns symmetriskt i AISHub-benet
(`AISHubClient.js:203`). Trappan förlorar alltså sin funktion i exakt det scenario den byggdes för.

## Källdöden aisstream
0 sampel på 41 h 49 min. 42 anslutningsförsök, 39 lyckade "Connected", 21 watchdog-strikes
(20→40→80→120 min, sedan fast på 120 min i 18 strikes). 3× HTTP 503 den 7:e kl 12:40.
`[SHADOW_COMPARE]` visade `onlyAisstream=0 both=0 samples=0` hela körningen.

## AISHub-kadens och färskhet
- **1 871 pollbatchar**; batchintervall median **1,1 min** (p90 2,3; max 3,5) — motsvarar
  `POLL_INTERVAL_MS = 65000` + jitter. Mediansstorlek 2 poster/batch.
- **Fixålder** (`aisTimestamp − fixTs`): median **26 s**, p75 46 s, p90 59 s, p99 68 s,
  **max 97 s**, 0 negativa.
- Viktig distinktion: `INTERVAL_MINUTES = 10` (constants.js:451) är AISHub-API:ets
  `&interval=`-parameter (datafönster), **inte** pollfrekvensen. Eftersom uppmätt fixålder
  aldrig översteg 97 s har B4:s sänkning 10→3 sannolikt **försumbar praktisk effekt** i denna
  trafikbild — det talar för nedprioritering.
- 14 sampelgap > 5 min medan båten var i rörelse (sog > 1); värst ELFKUNGEN 66,2 min @ sog 7,4.

## Ej mätbart ur denna logg
C3-churnen: persistensskrivningar loggas inte per skrivning. Taggräkningen är **identisk** med
både-dygn 1 (LAST_KNOWN 1, NAME_CACHE 17, PERSISTENT_DEDUP 1, MOORING_SPOTS 1) — det är
startup-återställningsrader. Både-dygn 1:s "1 183 skrivningar/dygn" måste ha mätts på annat sätt.
Påståenden om churn i denna körning kan alltså **inte** stödjas på loggen.
