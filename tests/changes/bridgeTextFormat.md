# Bridge Text Format Regler V2.0 - ROBUST SYSTEM

## Grundläggande koncept

### Brotyper:
- **Målbroar**: Klaffbron, Stridsbergsbron (kan tilldelas som target)
- **Mellanbroar**: Olidebron, Järnvägsbron, Stallbackabron
- **Specialfall**: Stallbackabron (hög bro utan öppning - unika regler)

### Båtstatus med NYA AVSTÅNDSTRIGGRAR:
- **approaching**: <500m från bro → "En båt närmar sig [bro]" (NY 500m REGEL)
- **waiting**: <300m från bro → "En båt inväntar broöppning vid/av [bro]" (INGEN hastighetskrav)
- **under-bridge**: <50m från bro → "Broöppning pågår vid [bro]"
- **passed**: >50m efter bro → "En båt har precis passerat [bro]" (1 minut varaktighet)
- **en-route**: Standard → "En båt på väg mot [målbro], beräknad broöppning om X minuter"

## Bridge Text Regler

### 0. STALLBACKABRON SPECIALREGLER (HELT NYA!)

**Stallbackabron har UNIKA meddelanden eftersom det är en hög bro utan öppning:**

**Avståndstriggrar för Stallbackabron (MED "PÅ VÄG MOT" + ETA):**
- **<500m**: "En båt närmar sig Stallbackabron på väg mot [målbro], beräknad broöppning om X minuter"
- **<300m**: "En båt åker strax under Stallbackabron på väg mot [målbro], beräknad broöppning om X minuter" (INTE "inväntar broöppning")
- **<50m**: "En båt passerar Stallbackabron på väg mot [målbro], beräknad broöppning om X minuter"
- **Efter passage**: "En båt har precis passerat Stallbackabron på väg mot [målbro], beräknad broöppning om X minuter" (1 minut)

**VIKTIGT**: Stallbackabron visar ALDRIG "inväntar broöppning" oavsett hastighet eller avstånd!

**Multi-vessel för Stallbackabron (MED "PÅ VÄG MOT" + ETA):**
- "Tre båtar närmar sig Stallbackabron på väg mot [målbro], beräknad broöppning om X minuter"
- "Två båtar åker strax under Stallbackabron på väg mot [målbro], beräknad broöppning om X minuter"
- "En båt passerar Stallbackabron på väg mot [målbro], ytterligare 2 båtar på väg, beräknad broöppning om X minuter"

### 1. Närmar sig (approaching status - NY 500m REGEL)

**Alla broar (inklusive Stallbackabron):**
- **<500m**: "En båt närmar sig [bro]"
- **Multi-vessel**: "Tre båtar närmar sig [bro]"
- **Med ETA**: "En båt närmar sig [bro], beräknad broöppning om X minuter" (endast för målbroar/mellanbroar)

### 2. Inväntar broöppning (waiting status - EXKLUDERAR STALLBACKABRON)

**Målbroar (Klaffbron/Stridsbergsbron):**
- **<300m trigger**: Båt ≤300m från målbro
- **1 båt**: "En båt inväntar broöppning vid [målbro]"
- **Multi-vessel**: "Tre båtar inväntar broöppning vid [målbro]"
- **Ingen ETA visas** (för nära för korrekt beräkning)

**Mellanbroar (Olidebron, Järnvägsbron - INTE Stallbackabron):**
- **<300m trigger**: Båt ≤300m från mellanbro
- **Format**: "En båt inväntar broöppning av [mellanbro] på väg mot [målbro], beräknad broöppning om X minuter"
- **ETA visar tid till målbro** (inte till mellanbron)
- **Multi-vessel**: "En båt inväntar broöppning av [mellanbro] på väg mot [målbro], ytterligare 2 båtar på väg, beräknad broöppning om X minuter"
- **KRITISK FIX**: `_shouldShowWaiting()` kontrollerar nu specifik bro istället för att returnera true för alla broar

**VIKTIG REGEL**: Stallbackabron visar ALDRIG "inväntar broöppning" - använder istället "åker strax under"!

### 3. Broöppning pågår (under-bridge status)

**Alla broar (<50m från bro):**
- **Standard**: "Broöppning pågår vid [bro]"
- **Stallbackabron**: "En båt passerar Stallbackabron" (specialfall)
- **Multi-vessel**: "Broöppning pågår vid [bro], ytterligare 2 båtar på väg"

### 4. Precis passerat (passed status - 1 minut efter >50m från bro)

**VIKTIGT: ALLA "precis passerat" meddelanden visar nu ALLTID ETA med förbättrad beräkning!**

**Målbroar:**
- **Format**: "En båt har precis passerat [målbro] på väg mot [nästa målbro], beräknad broöppning om X minuter"
- **Endast om båten får ny målbro** (annars försvinner från meddelande efter 1 minut)
- **ETA**: Använder `_formatPassedETA()` för robust ETA-beräkning även vid passed status

**Mellanbroar (inklusive Stallbackabron):**
- **Format**: "En båt har precis passerat [mellanbro] på väg mot [målbro], beräknad broöppning om X minuter"
- **ETA till målbro** (inte till mellanbron)
- **Stallbackabron**: "En båt har precis passerat Stallbackabron på väg mot [målbro], beräknad broöppning om X minuter"

**Multi-vessel med precis passerat:**
- **Format**: "En båt har precis passerat [bro] på väg mot [målbro], ytterligare 2 båtar på väg, beräknad broöppning om X minuter"

**ETA-FÖRBÄTTRING**: 
- Alla "precis passerat" meddelanden använder nu `_formatPassedETA()` funktion
- Fallback ETA-beräkning baserat på position och hastighet om standard ETA saknas
- Eliminerar problem med saknade ETA-värden för passed status

### 5. En-route status (på väg mot målbro)

**För båtar längre bort som har målbro och ETA:**
- **Format**: "En båt på väg mot [målbro], beräknad broöppning om X minuter"
- **Multi-vessel**: "Tre båtar på väg mot [målbro], beräknad broöppning om X minuter"
- **Kombinerat**: "En båt på väg mot [målbro], ytterligare 2 båtar på väg, beräknad broöppning om X minuter"

### 6. Kombinerade meddelanden

**Ledande båt + ytterligare:**
- "En båt inväntar broöppning vid [målbro], ytterligare X båtar på väg"
- **Ledande båt = närmast målbron** (kan växla om båtar kör om)
- **Prioritering per målbro-sida** (inte globalt)

**Dubbla målbro-meddelanden:**
- **Format**: "[Klaffbron-meddelande]; [Stridsbergsbron-meddelande]"
- **Endast när båtar finns vid båda målbroarna**
- **Exempel**: "En båt inväntar broöppning vid Klaffbron; Två båtar närmar sig Stridsbergsbron"

## KOMPLETTA REGLER V2.0:

### NYA AVSTÅNDSTRIGGRAR:
- **<500m**: "närmar sig [bro]" (NY REGEL för bättre användarupplevelse)
- **<300m**: "inväntar broöppning vid/av [bro]" (eller "åker strax under" för Stallbackabron)
- **<50m**: "broöppning pågår vid [bro]" (eller "passerar" för Stallbackabron)
- **>50m efter passage**: "precis passerat [bro]" (1 minut varaktighet)

### STALLBACKABRON SPECIALREGLER (MED "PÅ VÄG MOT" + ETA):
- **ALDRIG** "inväntar broöppning" eller "broöppning pågår"
- **<500m**: "närmar sig Stallbackabron på väg mot [målbro], beräknad broöppning om X minuter"
- **<300m**: "åker strax under Stallbackabron på väg mot [målbro], beräknad broöppning om X minuter"
- **<50m**: "passerar Stallbackabron på väg mot [målbro], beräknad broöppning om X minuter"
- **Efter passage**: "precis passerat Stallbackabron på väg mot [målbro], beräknad broöppning om X minuter"

### PASSAGE OCH MÅLBRO-ÖVERGÅNG:
- **Passage triggar**: >50m efter bro (inte vid brospannet)
- **Målbro-övergång**: Automatisk tilldelning av nästa målbro vid passage
- **Slutpunkt**: Båtar försvinner efter sista målbro i sin riktning
- **Skydd**: Ingen målbro-ändring om båt <300m från nuvarande målbro

### ETA-REGLER (FÖRBÄTTRADE):
- **Målbro vid "inväntar broöppning"**: Ingen ETA (för nära)
- **Mellanbro**: ETA visar tid till MÅLBRO (inte mellanbron)
- **En-route**: ETA till målbro för informativ användning
- **Stallbackabron SPECIAL**: Använder `_formatStallbackabronETA()` som alltid beräknar ETA till målbro, även för under-bridge/passed status
- **Robusthet**: Inga "undefinedmin" - alltid giltiga värden eller inget ETA
- **Fallback-beräkning**: Om standard ETA saknas beräknas ETA baserat på position och hastighet

### STATUS PRIORITERING (UPPDATERAD):
**Ny prioriteringsordning för korrekt intermediate bridge waiting:**
1. **Under-bridge** (högsta prioritet)
2. **Waiting** (kan överstryra "recently passed" om nära bro)
3. **Recently passed** (bara om inte waiting vid annan bro)
4. **Stallbacka-waiting** (specialfall)
5. **Approaching**
6. **En-route** (lägsta prioritet)

**VIKTIGT**: Waiting kan nu detektera intermediate bridges (Järnvägsbron, Olidebron) även om båten har "recently passed" status från annan bro.

### INTERMEDIATE BRIDGE LOGIC (KRITISKA FIXES):
**StatusService**: Sätter nu `currentBridge` och `distanceToCurrent` för intermediate bridge detection:
```javascript
// CRITICAL: Set currentBridge for BridgeTextService to detect intermediate bridge waiting
vessel.currentBridge = bridgeName;
vessel.distanceToCurrent = proximityData.nearestDistance;
```

**BridgeTextService**: `_shouldShowWaiting()` kontrollerar nu specifik bro istället för alla broar:
```javascript
// CRITICAL FIX: Only return true if vessel is actually waiting at the SPECIFIC bridge asked about
if (vessel.currentBridge === bridgeName && vessel.distanceToCurrent <= APPROACH_RADIUS) {
  return true;
}
```

### MULTI-VESSEL PRIORITERING:
- **Inom samma målbro**: "Tre båtar inväntar broöppning vid Klaffbron"
- **Ledande båt**: Närmast målbron (kan växla vid omkörning)  
- **Prioritering per målbro-sida**: Inte global prioritering
- **Semikolon-separation**: För båtar mot olika målbroar samtidigt

### ROBUST MÅLBRO-TILLDELNING:
- **Positions- och riktningsbaserad** (inte bara COG)
- **Norrut**: Första målbro baserat på position relativt broarna
- **Söderut**: Första målbro baserat på position relativt broarna
- **GPS-hopp hantering**: >500m ignoreras, 100-500m accepteras med varning