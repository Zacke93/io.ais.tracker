# Bridge Text Format Regler

## Grundläggande koncept

### Brotyper:
- **Målbroar**: Klaffbron, Stridsbergsbron (kan tilldelas som target)
- **Mellanbroar**: Olidebron, Järnvägsbron, Stallbackabron
- **Undantag**: Stallbackabron (hög bro utan öppning)

### Båtstatus:
- **waiting**: Båt ≤300m från bro (INGEN hastighetskrav längre)
- **passed**: Båt som precis passerat en bro (visas i 1 minut)
- **approaching**: Normal status efter "passed" timeout

## Bridge Text Regler

### 1. Inväntar broöppning (waiting status)

**Målbroar (Klaffbron/Stridsbergsbron):**
- 1 båt: "En båt inväntar broöppning vid [målbro]"
- 2+ båtar: "Två/Tre/etc båtar inväntar broöppning vid [målbro]"
- **Ingen ETA visas** (för nära för korrekt beräkning)

**Mellanbroar (utom Stallbackabron):**
- Format: "En båt inväntar broöppning av [mellanbro] på väg mot [målbro], beräknad broöppning om X minut/er"
- **ETA visar tid till målbro** (inte till mellanbron)

**Stallbackabron (undantag):**
- Visar ALDRIG "inväntar broöppning"
- Format: "En båt närmar sig Stallbackabron"

### 2. Precis passerat (1 minut efter passage)

**Målbroar:**
- "En båt har precis passerat [målbro] på väg mot [nästa målbro], beräknad broöppning om X minuter"
- **Endast om båten får ny målbro** (annars försvinner från meddelande)

**Mellanbroar:**
- "En båt har precis passerat [mellanbro] på väg mot [målbro], beräknad broöppning om X minuter"

### 3. Kombinerade meddelanden

**Ledande båt + ytterligare:**
- "En båt inväntar broöppning vid [målbro], ytterligare X båtar på väg"
- **Ledande båt = närmast målbron** (kan växla om båtar kör om)

**Dubbla målbro-meddelanden:**
- Format: "[Klaffbron-meddelande]; [Stridsbergsbron-meddelande]"
- **Endast när båtar finns vid båda målbroarna**

## KOMPLETTA REGLER:

### Triggers:
- **"Inväntar broöppning"**: Båt ≤300m från bro (INGEN hastighetskrav)
- **"Precis passerat"**: Visas i 1 minut efter passage, sedan → approaching
- **"Approaching"**: Normal status med ETA till målbro

### Stallbackabron:
- **ALDRIG** "inväntar broöppning", även vid låg hastighet
- **ALLTID** "närmar sig Stallbackabron"

### Efter målbro-passage:
- Om båt inte får ny målbro → försvinner från bridge_text
- Om båt får ny målbro → "precis passerat [gammal] på väg mot [ny]"

### ETA-regler:
- **Målbro**: Ingen ETA när "inväntar broöppning"
- **Mellanbro**: ETA visar tid till målbro (inte mellanbron)
- **Syfte**: Användare ska kunna "timea" körning över målbroar

### Ledande båt:
- Definieras som båt närmast målbron
- Styr hela meddelandet: "En båt [status], ytterligare X båtar på väg"
- Kan växla om båtar kör om varandra