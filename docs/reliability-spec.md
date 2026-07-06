# Tillförlitlighetsspec (v1.0 — RATIFICERAD 2026-06-03) — io.ais.tracker

> **Syfte:** Definiera *exakt* vad de två pelarna ska göra, så att "är detta en bugg?" blir en kontrollerbar fakta. Varje regel nedan blir en **invariant** som en simuleringssvit hävdar mot tusentals genererade resor + alla historiska loggar.
>
> Status: **RATIFICERAD.** De öppna besluten (Del D) är avgjorda och inarbetade nedan. `⚖️` markerar var ett ratificerat beslut styr regeln.

## Pinnade konstanter (från `lib/constants.js`)

| Konstant | Värde | Roll |
|---|---|---|
| `APPROACHING_RADIUS` | 500 m | "närmar sig" / currentBridge sätts |
| `APPROACH_RADIUS` | 300 m | nära-tröskel |
| `FLOW_TRIGGER_DISTANCE_THRESHOLD` | 300 m | notis fyrar inom detta (icke-target) |
| `UNDER_BRIDGE_SET / CLEAR` | 50 / 70 m | "under bron"-status på/av |
| `PROTECTION_ZONE_RADIUS` | 300 m | skyddszon runt målbro |
| `MINIMUM_VIABLE_SPEED` | 0,5 kn | minsta fart för ETA/riktning |
| `STALE_ETA_SOFT / HARD` | 5 / 10 min | börja extrapolera / ge upp ETA |
| `COG NORTH_MIN / MAX` | 315° / 45° | nordband |
| `BOAT_NEAR_DEDUPE_MINUTES` | 10 min | (legacy re-trigger-fönster) |
| `_PERSISTENT_DEDUP_WINDOW_MS` | 2 h | persistent dedupe-fönster — bor i `app.js:190`, inte i constants.js (helgranskningen 2026-07-06, docs-core#R2-3) |

Målbroar: **Klaffbron**, **Stridsbergsbron**. Övriga (Kanalinfarten, Olidebron, Järnvägsbron, Stallbackabron) är mellanbroar/trigger-punkter.

---

## Del A — Notiser (boat_near)

### A1. När en notis SKA fyra
En `boat_near` fyrar för (fartyg, bro) när fartyget är inom relevant avstånd och har färsk AIS, från någon av källorna:

| Källa | Avstånd | Not |
|---|---|---|
| `target` | ≤ ~500 m | målbro (Klaff/Strids); vidare räckvidd |
| `current` | ≤ 300 m | aktuell bro fartyget passerar |
| `trigger-point` | ≤ 300 m | Kanalinfarten m.fl. |
| `just-passed` / `passage-fallback` | ≤ 300 m (fallback vidare) | precis passerad bro |
| `exit-point` | ≤ 400 m N om Kanalinfarten | sydgående utfart |

**Regel R-N1 (komplett­het):** För varje bro ett fartyg faktiskt kommer inom dess tröskel *med färsk AIS* under en resa, ska minst en notis fyra (eller undertryckas av en *legitim* regel nedan).

### A2. Tokens
- `vessel_name` = fartygets namn.
- `bridge_name` = den **notifierade** bron (ej målbron, om de skiljer sig).
- `eta_minutes`: om källa = `target` → `vessel.etaMinutes`; annars beräknad mot **den notifierade brons** avstånd. Nära+långsam (<150 m, <1 kn) → `-1` (ärligt okänt). Ogiltig/≤0 → `-1`.
- `direction`: route-latch (`_finalTargetDirection`/`_routeDirection`) **primärt**; annars COG-fallback med SOG-gate (<0,5 kn → `unknown`). ⚖️ **D4** (bandet).

### A3. När en notis ska UNDERTRYCKAS (legitimt — inte en miss)
- **Session-dedupe:** samma `mmsi:bro` redan fyrad denna resa.
- **Persistent dedupe:** samma `mmsi:bro` fyrad inom 2 h. ⚖️ **D3** (ska överleva omstart).
- **Stale:** AIS-data för gammal (notisvägens staleness-guard).
- **Borttaget fartyg:** `STALE_AIS`-removal (30 min utan position) eller cleanup-timeout → resan nollställs.
- **NEW_JOURNEY:** riktningsvändning rensar dedupe → får fyra igen nästa resa.

### A4. Invarianter (notiser)
- **INV-N1 (exakt en gång):** högst **en** notis per `(mmsi, bro, resa)` — även över **omstart**. *(Idag bruten: P2.)*
- **INV-N2 (inga tysta bortfall):** varje `FLOW_TRIGGER_ATTEMPT` resulterar i `SUCCESS` eller loggat fel. *(Håller i 41h-loggen.)*
- **INV-N3 (rätt attribution):** en fyrad notis attribueras till rätt `mmsi` (ej `null`). *(Idag: 1 kosmetiskt brott via JOURNEY_COMPLETED-race.)*
- **INV-N4 (token-sanning):** `direction ≠ unknown` får aldrig vara en ren gissning från en COG som riktningshärledningen själv anser för osäker. *(Idag bruten: P5.)*

---

## Del B — bridge_text

### B1. Relevans
Ett fartyg är *relevant* för texten om det har en målbro (Klaff/Strids) och inte är GPS-hold-filtrerat. ⚖️ **D1** (stoppade båtar).

### B2. Format (Variant-1)
Per målbro-grupp: `"{antal} båt(ar) på väg mot {målbro}, {ETA-klausul}"`. Flera grupper sammanfogas med `"; "`. **Endast Klaffbron/Stridsbergsbron** namnges som mål. Inga fasfraser ("inväntar", "Broöppning pågår", "precis passerat").

### B3. ETA-klausuler
| Klausul | Villkor |
|---|---|
| `beräknad broöppning strax` | ETA < 3 min **eller** imminent (<300 m från målbron) |
| `beräknad broöppning om N minuter` | ETA ≥ 3 min (ingen övre gräns) |
| `beräknad broöppning om cirka N minuter` | extrapolerad (AIS 5–10 min gammal) |
| `ETA okänd` | ogiltig ETA, eller AIS > 10 min gammal |

### B4. Special-tillstånd
- **DEFAULT:** `"Inga båtar är i närheten av Klaffbron eller Stridsbergsbron"` när inga relevanta fartyg finns.
- **Avbrott:** `"AIS-anslutning saknas — data kan vara inaktuell"` när frånkopplad > 2 min. ⚖️ **D5** (måste gälla även vid sista-båt-borttagning under avbrott — idag P8).

### B5. Invarianter (bridge_text)
- **INV-B1 (liveness):** texten visar **aldrig** DEFAULT när ett relevant fartyg är inom 500 m av en målbro på aktiv resa. *(Idag bruten: STOPPED→DEFAULT, se D1.)*
- **INV-B2 (ETA-monotonicitet):** för ett närmande fartyg ökar visad ETA aldrig bakåt (ingen "strax"→"11 min"). ⚖️ **D2**. *(Idag bruten: 2 flippar i loggen.)*
- **INV-B3 (rätt mål):** texten namnger aldrig en passerad bro som mål; en bekräftad passage flyttar alltid målet. *(Idag bruten: P6, GPS-gate-deadlock.)*
- **INV-B4 (anslutnings­sanning):** vid avbrott visas avbrottstexten, aldrig DEFAULT. *(Idag bruten: P8.)*
- **INV-B5 (Variant-1):** inga förbjudna fraser, inga mellanbroar som mål. *(Håller.)*

---

## Del C — Vad simuleringssviten ska göra (steg 3)
1. **Historiska loggar:** spela alla `logs/ais-replay-*.jsonl` genom den fixade harnessen; hävda alla invarianter + matcha facit exakt.
2. **Genererade resor (property-based, t.ex. `fast-check`):** syntetisera fartygsresor med slumpade men giltiga parametrar + **elaka injektioner**: stopp nära bro, U-svängar, GPS-hopp exakt på målbro, stale-luckor 5/10/30 min, app-omstart mitt i resa, bursts (flera fartyg samma tick), två målbroar samtidigt, off-axis-kurser inom 300 m.
3. För varje genererad resa: kör genom riktiga appen → hävda INV-N1..N4 + INV-B1..B5. Krymp varje brott till minsta repro.

---

## Del D — BESLUT (RATIFICERADE 2026-06-03)

| # | Beslut | Avgjort | Styr |
|---|---|---|---|
| **D1** | Stoppad/väntande båt inom 500 m av målbro | **Behåll i texten som "på väg mot X" (utan ETA)** — Variant-1-konformt, ingen ny fras | INV-B1 |
| **D2** | ETA-monotonicitet | **Klampa — visad ETA hoppar aldrig bakåt** för ett närmande fartyg | INV-B2 |
| **D3** | Notis-dedupe över omstart | **Ja — persistera 2 h-dedupen till `homey.settings`** (åtgärdar P2) | INV-N1 |
| **D4** | Riktnings-token off-axis utan latch | **`unknown` när osäker** (COG 226–314° utan latch → unknown; åtgärdar P5) | INV-N4 |
| **D5** | Text vid avbrott + sista båt | **Ja — "AIS-anslutning saknas" före "Inga båtar" vid > 2 min avbrott** (åtgärdar P8) | INV-B4 |
| **D6** | "100 %"-definitionen | **Ja — alla 9 invarianter håller mot (a) alla historiska loggar + (b) genererad scenario-svit** | mållinje |

### Konsekvenser inarbetade i reglerna ovan
- **B1/INV-B1:** ett fartyg förblir *relevant* för bridge_text så länge det är inom `APPROACHING_RADIUS` (500 m) av sin målbro på en aktiv resa, **även om sog ≈ 0**. En stoppad båt visas som "En båt på väg mot X" utan ETA-klausul (eller med "ETA okänd" om ETA saknas). Texten får aldrig falla till DEFAULT medan en sådan båt finns.
- **A2/INV-N4:** `_getDirectionString` sydband snävas till 135–225° för COG-fallback; off-axis (226–314°) utan route-latch → `unknown`. **REVIDERAT 2026-07-02 (JOSEPHINE, replay-belagt):** token-fallbackens sydband breddades till 135–314° — bevisligen sydgående båt med COG 226,7° fick felaktigt `unknown`. Det STRIKTA bandet 135–225° gäller fortsatt alla HÖGRISK-beslut (målbro-/riktningslås, Fix D, NEW_JOURNEY). Koden + `notification-tokens.test.js` är sanningskällan (P5-beslutet i constants.js:276–285); denna spec-rad behålls som historik (helgranskningen 2026-07-06, docs-core#R2-1).
- **B3/INV-B2:** visad ETA klampas icke-ökande medan fartyget närmar sig (tolerans för brus tillåten).
