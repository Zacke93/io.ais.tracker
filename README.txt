# AIS Bridge — Trollhättekanalen

Spårar fartyg i Trollhättekanalen med hjälp av AIS-data och visar **bridge text** + skickar **Flow-notiser** när båtar närmar sig öppningsbara broar.

Appen är skriven för Homey Pro och tar emot AIS-positionsrapporter från [AISstream.io](https://aisstream.io). Med dem beräknar appen vilka båtar som är på väg mot Klaffbron och Stridsbergsbron, var de befinner sig, hur länge det är kvar tills de når bron, och triggar Flow-kort som du kan koppla till valfria automationer (t.ex. notifikationer, lampor, talsyntes).

---

## Vad du får

### 📱 Bridge text — uppdateras varje minut

En människovänlig svensk statussträng som visas på din `bridge_text`-capability. Exempel:

```
En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter
Två båtar på väg mot Stridsbergsbron, beräknad broöppning strax
En båt på väg mot Klaffbron, ETA okänd
Inga båtar är i närheten av Klaffbron eller Stridsbergsbron
```

### 🔔 Flow-notiser per bro

Notiser triggas via Flow-kortet **"Båt nära bro"** (boat_near). En notis per bro per båt under aktiv resa.

**Övervakade trigger-punkter (söder → norr):**

| Plats | Roll | Notis? |
|-------|------|--------|
| Kanalinfarten | Geografisk entré (södra) | ✅ |
| Olidebron | Mellanbro | ✅ |
| **Klaffbron** | Målbro 1 (öppningsbar) | ✅ |
| Järnvägsbron | Mellanbro | ✅ |
| **Stridsbergsbron** | Målbro 2 (öppningsbar) | ✅ |
| Stallbackabron | Mellanbro (hög, öppnar inte) | ✅ |

Endast Klaffbron och Stridsbergsbron nämns i bridge text — övriga broar utlöser notiser men förblir "osynliga" i bridge-textsträngen för läsbarhet.

---

## Installation

### Från Homey App Store
*(släpps separat — kontakta utvecklaren för status)*

### Lokalt från källkod
1. Klona repot:
   ```bash
   git clone https://github.com/Zacke93/io.ais.tracker.git
   cd io.ais.tracker
   ```
2. Installera beroenden:
   ```bash
   npm install
   ```
3. Skaffa en gratis API-nyckel från [AISstream.io](https://aisstream.io).
4. Installera på din Homey Pro:
   ```bash
   homey app install
   ```
5. I Homey-appen, öppna **AIS Bridge → Inställningar** och klistra in din API-nyckel under **"AIS API key"**.

Verifiera installationen genom att kolla att:
- `connection_status`-capability visar `connected`
- `bridge_text` visar antingen båtinfo eller "Inga båtar är i närheten…"

---

## Konfiguration

### AIS API-nyckel
Krävs. Hämtas från [AISstream.io](https://aisstream.io) (gratis konto). Klistra in i appens inställningar.

### Replay-läge (för utveckling)
Sätt miljövariabel `AIS_REPLAY_CAPTURE_FILE` till en sökväg för att spara inkommande AIS-data till en JSONL-fil för senare uppspelning. Används av utvecklare för att testa fixes mot riktiga scenarier.

---

## Bridge text — formatet i detalj

### Grundregeln
```
[Antal] [båt|båtar] på väg mot [målbro], [ETA-klausul]
```

### Antal
Svenskt räkneord 1–10: `En, Två, Tre, Fyra, Fem, Sex, Sju, Åtta, Nio, Tio`. Vid ≥11: siffra (`11 båtar`).

### ETA-klausul

| Villkor | Visas som |
|--------------|-----------|
| Inom 300 m från målbro (imminent) | `beräknad broöppning strax` |
| Saknas / NaN / ogiltig | `ETA okänd` |
| Inga positionsuppdateringar > 10 min | `ETA okänd` |
| AIS 5–10 min stale (extrapolerad) | `beräknad broöppning om cirka N minuter` |
| < 3 min | `beräknad broöppning strax` |
| ≥ 3 min | `beräknad broöppning om N minuter` (inget tak) |

### Multi-vessel
Båtar grupperas per målbro. ETA tas från båten med lägst valid ETA i gruppen.
```
Två båtar på väg mot Klaffbron, beräknad broöppning om 2 minuter
```

### Multi-target
Båtar mot båda målbroar visas separerade med `; `, Klaffbron alltid först:
```
En båt på väg mot Klaffbron, beräknad broöppning strax; En båt på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter
```

### Default
När inga relevanta båtar finns:
```
Inga båtar är i närheten av Klaffbron eller Stridsbergsbron
```

### Disconnect-skydd
Om AIS-anslutningen tappas i > 2 min visas:
```
AIS-anslutning saknas — data kan vara inaktuell
```

---

## Flow-kort

### Trigger: "Båt nära bro" (`boat_near`)

Utlöses när en båt kommer **inom 300 m** av en övervakad plats. Argument:

- **bridge** — vilken bro/plats. Välj specifik bro eller `any` för alla.

Tokens som triggern levererar:

| Token | Typ | Beskrivning |
|-------|-----|-------------|
| `vessel_name` | string | Båtens namn (t.ex. "RIX RIVER") eller "Unknown" |
| `bridge_name` | string | Bro/plats (t.ex. "Klaffbron") |
| `direction` | string | `northbound`, `southbound` eller `unknown` |
| `eta_minutes` | number | Minuter till bron, eller `-1` om okänt |

### Notis-policy

- **EN notis per bro per båt under aktiv resa** — ingen spam
- Båt stannar vid bron i 1 timme → ingen extra notis
- Båt lämnar bron (>300 m) och kommer tillbaka → **ny notis** (zonen återupptäckts)
- Båt försvinner från AIS i 30+ min → tas bort, ny notis nästa gång

### Condition: "Båt vid bro" (`boat_at_bridge`)

Returnerar `true` om någon båt finns inom 300 m av angiven bro just nu.

---

## Capabilities

| Capability | Typ | Innehåll |
|------------|-----|----------|
| `bridge_text` | string | Aktuell bridge text (se format ovan) |
| `connection_status` | string | `connected` / `disconnected` |
| `alarm_generic` | boolean | `true` när minst en båt är "i närheten" av en målbro |

Använd `bridge_text` i Homey Web-app eller dashboards. `alarm_generic` är praktiskt i Flow för enkel "någon båt i kanalen?"-logik.

---

## Övervakade broar — koordinater

| Bro | Latitud | Longitud | Roll |
|-----|---------|----------|------|
| Kanalinfarten | 58.268 | 12.269 | Trigger-punkt (södra entrén) |
| Olidebron | 58.2727 | 12.2751 | Mellanbro |
| **Klaffbron** | 58.2841 | 12.2839 | Målbro 1 (öppningsbar) |
| Järnvägsbron | 58.2916 | 12.2920 | Mellanbro |
| **Stridsbergsbron** | 58.2935 | 12.2946 | Målbro 2 (öppningsbar) |
| Stallbackabron | 58.3114 | 12.3146 | Mellanbro (hög bro, öppnar inte) |

Trigger-radie: 300 m runt varje plats.

---

## Hur det fungerar — under huven

### 1. AIS-data tas in
Appen prenumererar på AISstream.io WebSocket. Filtrerar på geografisk bbox runt Trollhättekanalen.

### 2. Vessel-state byggs upp
För varje båt (identifierad via MMSI) trackas position, hastighet (SOG), kurs (COG), målbro och passerade broar.

### 3. Status & ETA beräknas
- `StatusService` bestämmer status: `approaching`, `waiting`, `under-bridge`, `passed`, `en-route`, `stallbacka-waiting`
- `ProgressiveETACalculator` beräknar tid till målbro via avstånd och hastighet, med flera skydd:
  - **EMA-utjämning** mot AIS-bruset
  - **Monotonic protection** — ETA får inte hoppa stort bakåt
  - **Speed floor** — minsta fart 0.5 kn (eller 2.5 kn vid passage), förhindrar absurd ETA för stillastående
  - **Cykel-cap** — stillastående båtar med växande ETA klampas till +1 min/cykel

### 4. Bridge text genereras
`BridgeTextService` är en **stateless ren funktion** — input är vessel-listan, output är strängen. Inga timers, ingen fas-spårning.

### 5. UI och notiser uppdateras
Watchdog kör var 30:e sekund och uppdaterar `bridge_text`. Notiser triggas så fort en båt kommer inom 300 m av en plats.

---

## Begränsningar

### AIS-uppdateringsfrekvens
**Class A** (kommersiella fartyg): 2–10 sekunder vid rörelse, 3 minuter vid stilla.
**Class B** (fritidsbåtar): 30 sekunder vid rörelse, 3 minuter vid stilla.

För Class B-båtar med långa intervall kan en sample landa **mellan** två broars 300 m-zoner — då utlöses ingen notis för bron som passerades. Detta är en **fysisk begränsning** av AIS-systemet, inte en bugg.

### "ETA okänd"
Visas när:
1. Position har inte uppdaterats på > 10 minuter (vid 5–10 min extrapoleras ETA i stället och visas som "cirka N minuter")
2. Ogiltig/saknad ETA, eller internt beräkningsfel (sällsynt — ska felsökas)

I normal drift ska ETA alltid vara ett tal. En båt inom 300 m från målbron visar dock alltid "strax", oavsett ETA-värde.

### Stallbackabron
En **hög bro** som inte öppnar. Notiser triggas för spårning, men status blir aldrig "under-bridge" eller "broöppning". Bridge text nämner inte Stallbackabron.

---

## Felsökning

### Problem: Inga notiser kommer alls
1. Kontrollera `connection_status` — visar den `connected`?
2. Kolla API-nyckeln i inställningarna
3. Verifiera att en båt faktiskt är i kanalen via [marinetraffic.com](https://www.marinetraffic.com/)

### Problem: "Inga båtar är i närheten…" trots att båt finns
- Båten kanske är < 0.3 kn (ankrad/stillastående utan målbro)
- Båten är på mellanbro utan att ha någon målbro tilldelad
- AIS-data har inte uppdaterats på > 30 min → båten är borttagen

### Problem: ETA okänd visas länge
- AIS-data är glesa — vänta tills nästa sample
- Kontrollera connection_status

### Problem: Ingen notis för en specifik bro
- Båten gick för fort (> 8 kn) genom 300 m-zonen mellan AIS-samples
- Detta är vanligast för Class B-båtar och kan inte fixas i appen

### Problem: ETA visar väldigt högt värde (> 30 min)
- Båten står troligen still (eller har låg fart)
- ETA är beräknat med fart-floor 0.5 kn när båten är stationär
- När båten startar igen kommer ETA snabbt minska

---

## Utveckling

### Köra lokalt
```bash
homey app run
```

### Tester
```bash
npm test
```

### Lint
```bash
npm run lint
```

### Validera Homey-pakettering
```bash
homey app validate
```

### Replay från riktig produktionslogg
Kör appen med `AIS_REPLAY_CAPTURE_FILE=logs/ais-replay-XXX.jsonl` för att spara, eller ladda en sparad fil för testning.

---

## Bidragande

Se [`CONTRIBUTING.md`](./CONTRIBUTING.md) för riktlinjer kring pull requests och testning.

Bug-rapporter och feature-förslag tas emot via GitHub Issues:
👉 https://github.com/Zacke93/io.ais.tracker

---

## Licens

Licensieras under villkoren i [`LICENSE`](./LICENSE) (MIT).

---

**Version:** 5.0.0
**Plattform:** Homey Pro (SDK 3)
**Författare:** Zakarias Mortensen <Zaka_9@hotmail.com>
