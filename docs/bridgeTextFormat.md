# Brotext — rörelse och bekräftad väntan

## Designprincip

Brotexten grupperar båtar efter målbro och faktisk väntplats. Båtar under gång
får en ankomstprognos. En bekräftad kö får vänttext utan minuter. Samma båt
räknas en gång. Texten bygger på AIS; appen känner inte brons öppningsläge.

Väntan kräver färska positionsrapporter över minst en minut, stillhet och
belagd anflygning mot en ännu opasserad bro. En ensam position eller statusnamnet
`waiting` räcker inte. Färsk kö kan ligga kvar över två timmar. När positionerna
upphör gäller ordinarie åldringsregler; en avstängd AIS hålls inte kvar för evigt.

```
En båt väntar vid Stridsbergsbron
En båt väntar vid Järnvägsbron på väg mot Klaffbron
```

## Grundformat

```
[Antal] [båt|båtar] på väg mot [målbro], [etaKlausul]
```

- **Antal**: Svenskt räkneord för 1–10 (`En`, `Två`, `Tre`, `Fyra`, `Fem`, `Sex`, `Sju`, `Åtta`, `Nio`, `Tio`). För ≥11: siffra.
- **båt/båtar**: Singular vid antal = 1, annars plural.
- **målbro**: `Klaffbron` eller `Stridsbergsbron`. En väntplats kan även vara Olidebron eller Järnvägsbron.
- **etaKlausul**: Se nedan.

## ETA-klausul

Tiden bygger på fartygens AIS-positioner och fart. Kötid och väntan på andra
broöppningar kan förlänga tiden; appen mäter inte brons faktiska öppningsläge.
Flow-tokenen `eta_minutes` avser beräknad ankomst. Brotextens formulering
”beräknad broöppning” följer formatet nedan och ska läsas som en prognos.

Beräknas från gruppens ledande båt — den båt i gruppen med lägst giltig `etaMinutes`. Om ingen båt har giltig ETA, fallback till båten med lägst `distanceToCurrent`; annars första båten.

Klausulen avgörs i prioritetsordning (`lib/utils/etaValidation.js → formatETABroOpeningClause`):

| Villkor | Klausul |
|---|---|
| **imminent** (vessel <300 m från målbro) | `beräknad broöppning strax` |
| `null`, `undefined`, `NaN`, ogiltig ETA | `ETA okänd` |
| **extrapolerad** och `etaMinutes < 3` | `beräknad broöppning om cirka 2 minuter` |
| `etaMinutes < 3` (färsk data) | `beräknad broöppning strax` |
| **extrapolerad** (AIS 5–10 min stale) och `N ≥ 3` | `beräknad broöppning om cirka N minuter` |
| `N ≥ 3` (efter avrundning) | `beräknad broöppning om N minuter` |

*Extrapolerad-under-3-undantaget (dokumenterat vid helgranskningen 2026-07-06,
docs-core#5): en extrapolerad siffra som räknat ner in i strax-bandet är en
gissning från 5+ min gammal data — 11h-körningens MARLIN visades "strax" 730 m
från bron och korrigerades uppåt 67 s senare. "Strax" reserveras för färsk
data/imminent; extrapolationen säger ärligt "cirka". (Exhausted-vägen går via
imminent-flaggan och behåller strax.)*

**Bekräftad väntan går före ETA.** För båtar under gång kan imminent-flaggan
ge ”strax” inom 300 m från målbron. Flaggan kräver färsk position och skydd
mot GPS-störningar; den gäller bara gruppen som är under gång.

**Inget presentationsmässigt tak på giltig ETA.** Höga prognoser kan visas för
båtar under gång. En bekräftat stillastående kö får ingen minutprognos.

**Strax-tröskeln är 3 min** (justerad från 1 min efter produktionsanalys april 2026). Med tidigare 1-min-tröskel hoppade Class B AIS (30 s intervall) ofta över den ~30 m breda strax-zonen. Med 3-min-tröskel blir zonen ~460 m vid 5 knop och praktiskt taget alla båtar får "strax" under sin passage.

**Stale-ETA (två trösklar, `lib/constants.js`):**
- **5–10 min utan positionsuppdatering (SOFT):** ETA extrapoleras ned (senaste ETA minus förfluten tid) och markeras "cirka" så att texten är ärlig om osäkerheten.
- **> 10 min utan positionsuppdatering (HARD):** ETA nollställs → `ETA okänd` (data är för gammal för att lita på).

**"ETA okänd"** triggas alltså vid: > 10 min utan positionsuppdatering, ogiltig/saknad ETA, eller internt beräkningsfel (sällsynt — felsökning krävs om det inträffar i normal drift). OBS: imminent-flaggan (<300 m) överstyr detta till "strax".

## Semikolon-separering

Klausuler separeras med `"; "`. Klaffbrons grupper kommer före Stridsbergsbrons.
En målbro kan ha både en väntgrupp och en separat grupp under gång.

```
En båt på väg mot Klaffbron, beräknad broöppning om 3 minuter; En båt på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter
```

## Multi-vessel inom samma målbro

Båtar med samma mål och väntplats aggregeras med räkneord. Båtar under gång
grupperas separat; deras ETA kommer från den ledande båten (närmaste i tid).

```
Två båtar på väg mot Klaffbron, beräknad broöppning om 3 minuter
Tre båtar på väg mot Stridsbergsbron, beräknad broöppning strax
Tio båtar på väg mot Klaffbron, beräknad broöppning om 5 minuter
11 båtar på väg mot Klaffbron, beräknad broöppning om 7 minuter
```

## Tom / ogiltig input

Om inga vessels matchar `targetBridge ∈ {Klaffbron, Stridsbergsbron}`, eller vesseln är filtrerad av GPS-jump-hold, visas default-meddelandet:

```
Inga båtar är i närheten av Klaffbron eller Stridsbergsbron
```

Samma meddelande visas vid alla slags ogiltig input (`null`, tom array, icke-array).

## Passage-hantering

Variant-1 har ingen egen logik för passage-detektion eller post-passage-text. Allt hanteras automatiskt av `VesselDataService`:

1. När en båt passerar en målbro, uppdaterar `VesselDataService` dess `targetBridge` till nästa målbro i riktning.
2. Nästa `generateBridgeText()`-anrop returnerar naturligt en fras för nya målbron.
3. Efter bekräftad passage av sista målbron tas båten omedelbart bort ur brotexten.
   Den kan fortfarande spåras för notiser vid övriga broar och Kanalinfarten.

Ingen "precis passerat"-text visas — båten övergår direkt till nästa målbro-fras (eller försvinner).

## Mellanbroar (Olidebron, Järnvägsbron, Stallbackabron)

Olidebron och Järnvägsbron nämns när båten bekräftat väntar där på väg mot
sin målbro. Stallbackabron är fast och får ingen vänttext om broöppning.
`boat_near` kan notifiera alla fem broar och Kanalinfarten, oavsett vilka
broar användaren för tillfället valt i sina Flow-kort.

## Implementationsreferens

Se `io.ais.tracker/lib/services/BridgeTextService.js`. Klassen är stateless; de publika metoderna `clearVesselPhaseTracking()` och `resetPhaseTracking()` behålls som no-op för bakåtkompatibilitet med call-sites i `app.js` och `RealAppTestRunner.js`.
