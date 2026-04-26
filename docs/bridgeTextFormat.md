# Bridge Text Format — Variant-1 (v3.0)

## Designprincip

Bridge text producerar **en enda fras per målbro-grupp**. Inga faser (inväntar / Broöppning pågår / precis passerat). Inga mellanbroar i texten. Hela utdata är en ren funktion av vessel-listan vid ett givet ögonblick — inga timers, ingen state mellan anrop.

Detta är den enda modell som är matematiskt bevisbart 100% konsekvent: *en* regel, *ingen* kompressionsrisk mellan tätt spaced events, *inga* faser att hoppa över.

## Grundformat

```
[Antal] [båt|båtar] på väg mot [målbro], [etaKlausul]
```

- **Antal**: Svenskt räkneord för 1–10 (`En`, `Två`, `Tre`, `Fyra`, `Fem`, `Sex`, `Sju`, `Åtta`, `Nio`, `Tio`). För ≥11: siffra.
- **båt/båtar**: Singular vid antal = 1, annars plural.
- **målbro**: `Klaffbron` eller `Stridsbergsbron` (de enda broar som någonsin nämns i texten).
- **etaKlausul**: Se nedan.

## ETA-klausul

Beräknas från gruppens ledande båt — den båt i gruppen med lägst giltig `etaMinutes`. Om ingen båt har giltig ETA, fallback till båten med lägst `distanceToCurrent`; annars första båten.

| `etaMinutes` | Klausul |
|---|---|
| `null`, `undefined`, `NaN`, ogiltig | `ETA okänd` |
| `< 3` | `beräknad broöppning strax` |
| `N ≥ 3` (efter avrundning) | `beräknad broöppning om N minuter` |

**Inget tak på ETA-värdet.** Stora värden (40, 80, 120 minuter) visas verbatim — ETA-pipelinen ger trovärdiga värden även för stillastående båtar, så att visa 72 minuter ärligt är bättre än att klampa till en fras som lovar något annat.

**Strax-tröskeln är 3 min** (justerad från 1 min efter produktionsanalys april 2026). Med tidigare 1-min-tröskel hoppade Class B AIS (30 s intervall) ofta över den ~30 m breda strax-zonen — endast 13 % av båtarna fick "strax"-fasen visad. Med 3-min-tröskel blir zonen ~460 m vid 5 knop och praktiskt taget alla båtar får "strax" under sin passage.

**"ETA okänd"** triggas i två fall:
1. AIS-data har inte uppdaterats på > 5 minuter (vesseln finns kvar, men dess ETA är inte längre tillförlitlig).
2. Internt beräkningsfel (sällsynt — felsökning krävs om det inträffar i normal drift).

## Semikolon-separering

När båtar åker mot båda målbroar visas en fras per målbro, separerade med `"; "`. Klaffbron-frasen kommer alltid före Stridsbergsbron-frasen i utdata, oavsett input-ordning.

```
En båt på väg mot Klaffbron, beräknad broöppning om 3 minuter; En båt på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter
```

## Multi-vessel inom samma målbro

Båtar aggregeras till en fras med räkneord. ETA = gruppens ledande båt (närmaste i tid).

```
Två båtar på väg mot Klaffbron, beräknad broöppning om 2 minuter
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
3. När båten passerat sista målbron i sin riktning, tas den bort från systemet.

Ingen "precis passerat"-text visas — båten övergår direkt till nästa målbro-fras (eller försvinner).

## Mellanbroar (Olidebron, Järnvägsbron, Stallbackabron)

**Nämns aldrig i texten, oavsett status.** Detta är avsiktligt för systematisk konsekvens. Passage av mellanbroar detekteras och spåras av `VesselDataService` (för korrekt sekvens-validering och nästa-mål-tilldelning), men visas inte för användaren.

## Implementationsreferens

Se `io.ais.tracker/lib/services/BridgeTextService.js`. Klassen är stateless; de publika metoderna `clearVesselPhaseTracking()` och `resetPhaseTracking()` behålls som no-op för bakåtkompatibilitet med call-sites i `app.js` och `RealAppTestRunner.js`.
