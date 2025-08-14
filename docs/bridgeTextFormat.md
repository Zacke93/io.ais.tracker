# Bridge Text Format Regler V2.0 - ROBUST SYSTEM

## Grundläggande koncept

### Brotyper:

- **Målbroar**: Klaffbron, Stridsbergsbron (kan tilldelas som target)
- **Mellanbroar**: Olidebron, Järnvägsbron (normala öppningsbroar)
- **Specialfall**: Stallbackabron (hög bro utan öppning - helt unika regler, INTE mellanbro)

### Båtstatus med NYA AVSTÅNDSTRIGGRAR:

- **approaching**: <500m från bro → "En båt närmar sig [bro]" (NY 500m REGEL)
- **waiting**: <300m från bro → "En båt inväntar broöppning vid/av [bro]" (INGEN hastighetskrav)
- **under-bridge**: <50m från bro → "Broöppning pågår vid [bro]" (UTOM Stallbackabron: "passerar")
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

**Multi-vessel för Stallbackabron (KONSEKVENT FORMAT):**

- **Närmar sig**: "En båt närmar sig Stallbackabron på väg mot [målbro], ytterligare X båtar på väg, beräknad broöppning om X minuter"
- **Åker strax under**: "En båt åker strax under Stallbackabron på väg mot [målbro], ytterligare X båtar på väg, beräknad broöppning om X minuter"
- **Passerar**: "En båt passerar Stallbackabron på väg mot [målbro], ytterligare X båtar på väg, beräknad broöppning om X minuter"

**OBS:** Alltid "En båt" följt av "ytterligare X båtar" för konsekvent format med andra broar

### 1. Närmar sig (approaching status - NY 500m REGEL)

**Målbroar (Klaffbron/Stridsbergsbron):**

- **<500m**: "En båt närmar sig [målbro], beräknad broöppning om X minuter"
- **Multi-vessel**: "Två/Tre båtar närmar sig [målbro], beräknad broöppning om X minuter" (text-baserade siffror)

**Mellanbroar (Olidebron/Järnvägsbron):**

- **<500m**: "En båt närmar sig [mellanbro] på väg mot [målbro], beräknad broöppning om X minuter"
- **Multi-vessel**: "Två/Tre båtar närmar sig [mellanbro] på väg mot [målbro], beräknad broöppning om X minuter" (text-baserade siffror)

**Stallbackabron (specialfall):**

- **<500m**: "En båt närmar sig Stallbackabron på väg mot [målbro], beräknad broöppning om X minuter"

### 2. Inväntar broöppning (waiting status - EXKLUDERAR STALLBACKABRON)

**Målbroar (Klaffbron/Stridsbergsbron):**

- **<300m trigger**: Båt ≤300m från målbro
- **1 båt**: "En båt inväntar broöppning vid [målbro]"
- **Multi-vessel**: "Två/Tre båtar inväntar broöppning vid [målbro]" (text-baserade siffror)
- **Ingen ETA visas** (för nära för korrekt beräkning)

**Mellanbroar (Olidebron, Järnvägsbron - INTE Stallbackabron):**

- **<300m trigger**: Båt ≤300m från mellanbro
- **Format**: "En båt inväntar broöppning av [mellanbro] på väg mot [målbro], beräknad broöppning om X minuter"
- **ETA visar tid till målbro** (inte till mellanbron)
- **Multi-vessel**: "Två/Tre båtar inväntar broöppning av [mellanbro] på väg mot [målbro], beräknad broöppning om X minuter" 
  ELLER "En båt inväntar broöppning av [mellanbro] på väg mot [målbro], ytterligare X båtar på väg, beräknad broöppning om X minuter"
- **KRITISK FIX**: `_shouldShowWaiting()` kontrollerar nu specifik bro istället för att returnera true för alla broar

**VIKTIG REGEL**: Stallbackabron visar ALDRIG "inväntar broöppning" - använder istället "åker strax under"!

### 3. Broöppning pågår (under-bridge status)

**VIKTIGT GRUPPBETEENDE:** När EN båt har status 'under-bridge' (<50m från bro) visas "Broöppning pågår" för HELA gruppen mot samma målbro. Detta är avsiktligt för att prioritera den mest kritiska statusen för användarens förståelse.

**Målbroar (<50m från bro):**

- **Standard**: "Broöppning pågår vid [målbro]"
- **Multi-vessel**: "Broöppning pågår vid [målbro], ytterligare 2 båtar på väg"
- **Gruppbeteende**: Även båtar som är längre bort (t.ex. 146m, status=waiting) inkluderas i "ytterligare X båtar" när minst en båt är under-bridge

**Mellanbroar (<50m från bro):**

- **Standard**: "Broöppning pågår vid [mellanbro], beräknad broöppning av [målbro] om X minuter"
- **Multi-vessel**: "Broöppning pågår vid [mellanbro], ytterligare 2 båtar på väg, beräknad broöppning av [målbro] om X minuter"

**Stallbackabron (specialfall):**

- **Standard**: "En båt passerar Stallbackabron på väg mot [målbro], beräknad broöppning om X minuter"
- **Multi-vessel**: "En båt passerar Stallbackabron på väg mot [målbro], ytterligare 2 båtar på väg, beräknad broöppning om X minuter"

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

- **<500m**: "närmar sig [bro]" med ETA för målbroar, "på väg mot [målbro]" för mellanbroar/Stallbackabron
- **<300m**: "inväntar broöppning vid/av [bro]" för målbroar/mellanbroar, "åker strax under" för Stallbackabron
- **<50m**: "broöppning pågår vid [bro]" för målbroar/mellanbroar med ETA för mellanbroar, "passerar" för Stallbackabron
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
- **Stallbackabron SPECIAL**: Använder `_formatPassedETA()` som alltid beräknar ETA till målbro, även för under-bridge/passed status
- **Robusthet**: Inga "undefinedmin" - alltid giltiga värden eller inget ETA
- **Fallback-beräkning**: Om standard ETA saknas beräknas ETA baserat på position och hastighet

### STATUS PRIORITERING (UPPDATERAD):

**KORREKT prioriteringsordning (matchar app-logiken):**

1. **Passed** (precis passerat) - 1 minut, HÖGSTA PRIORITET
2. **Under-bridge** (<50m) - broöppning pågår
3. **Waiting** (<300m) - inväntar broöppning
4. **Stallbacka-waiting** (<300m) - åker strax under (specialfall)
5. **Approaching** (<500m) - närmar sig
6. **En-route** (>500m) - på väg mot (lägsta prioritet)

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
if (
  vessel.currentBridge === bridgeName &&
  vessel.distanceToCurrent <= APPROACH_RADIUS
) {
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

## AVANCERADE BRIDGE TEXT SCENARIOS V2.0

### 7. SEMIKOLON-SEPARATION REGLER (KOMPLETT GUIDE)

**GRUNDREGEL**: 1 fras per unik målbro, åtskiljt med semikolon när flera målbroar är aktiva samtidigt.

**Gäller för ALLA bridge-typer:**

- **Målbroar**: "Klaffbron-meddelande; Stridsbergsbron-meddelande"
- **Intermediate bridges**: "Båtar mot Klaffbron vid Järnvägsbron; Båtar mot Stridsbergsbron vid Järnvägsbron"
- **Stallbackabron**: "Båtar mot Stridsbergsbron vid Stallbackabron; Båtar mot Klaffbron vid annan bro"

### 8. INTERMEDIATE BRIDGE + MIXED MÅLBROAR (NYA DETALJERADE REGLER)

**Scenario**: Flera båtar vid samma intermediate bridge mot olika målbroar

**Format**: `"X båtar vid [intermediate] på väg mot [målbro1], ETA; Y båtar vid [intermediate] på väg mot [målbro2], ETA"`

**Konkreta exempel:**

**Vid Järnvägsbron (3 båtar, olika målbroar):**

- 2 båtar mot Klaffbron, 1 båt mot Stridsbergsbron
- **Meddelande**: `"2 båtar inväntar broöppning av Järnvägsbron på väg mot Klaffbron, beräknad broöppning om 5 minuter; En båt inväntar broöppning av Järnvägsbron på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter"`

**Vid Olidebron (4 båtar, olika målbroar):**

- 3 båtar mot Klaffbron, 1 båt mot Stridsbergsbron
- **Meddelande**: `"3 båtar inväntar broöppning av Olidebron på väg mot Klaffbron, beräknad broöppning om 12 minuter; En båt inväntar broöppning av Olidebron på väg mot Stridsbergsbron, beräknad broöppning om 15 minuter"`

### 9. STALLBACKABRON + MIXED MÅLBROAR SCENARIOS

**VIKTIGT**: Stallbackabron endast relevant för **söderut-trafik** mot Stridsbergsbron/Klaffbron.

**Stallbackabron specialregler gäller även vid mixed scenarios:**

**Scenario A - Endast Stridsbergsbron-trafik:**

- `"3 båtar åker strax under Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om 7 minuter"`

**Scenario B - Mixed med andra broar (teoretiskt, sällsynt):**

- `"2 båtar åker strax under Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om 7 minuter; En båt inväntar broöppning vid Klaffbron"`

### 10. ETA-PRIORITERING VID MIXED MÅLBROAR

**Regel**: Varje målbro-grupp använder sin egen närmaste båts ETA.

**Exempel vid Järnvägsbron:**

- **Klaffbron-grupp**: Båt A (5min), Båt C (12min) → **Använder 5min** (närmast Klaffbron)
- **Stridsbergsbron-grupp**: Båt B (8min) → **Använder 8min**
- **Resultat**: Separata ETA för varje målbro-fras i meddelandet

### 11. ELIMINATION EFTER SISTA MÅLBRO (UPPDATERADE REGLER)

**Klaffbron söderut**: Tas bort efter Klaffbron (sista målbro söderut)
**Stridsbergsbron norrut**: Fortsätter till Klaffbron som nästa målbro  
**Stallbackabron söderut**: Fortsätter Stridsbergsbron → Klaffbron (båda målbroar)
**Stallbackabron norrut**: **INGA MEDDELANDEN** efter Stridsbergsbron (utanför system)

**KRITISK REGEL**: Norrut-trafik förbi Stridsbergsbron genererar **INGA** bridge text-meddelanden (utanför kanalsystemets scope).

### 12. KOMPLETT PRIORITERINGSORDNING (FINALIZED)

**Inom samma målbro-grupp:**

1. **Passed** (precis passerat) - 1 minut, högsta prioritet
2. **Under-bridge** (<50m) - broöppning pågår
3. **Waiting** (<300m) - inväntar broöppning
4. **Stallbacka-waiting** (<300m) - åker strax under (specialfall)
5. **Approaching** (<500m) - närmar sig
6. **En-route** (>500m) - på väg mot

**Mellan målbro-grupper:**

- **Semikolon-separation** för olika målbroar
- **Oberoende prioritering** per målbro-grupp
- **Ingen global prioritering** mellan målbroar

### 13. EDGE CASE EXAMPLES (KOMPLETT KATALOG)

**Mixed status inom samma målbro:**

- En båt waiting vid Klaffbron + en båt approaching Klaffbron
- **Resultat**: `"En båt inväntar broöppning vid Klaffbron, ytterligare 1 båt på väg"` (waiting prioriteras)

**Passed vs andra statusar:**

- En båt precis passerat Järnvägsbron + två båtar waiting vid Klaffbron
- **Resultat**: `"En båt har precis passerat Järnvägsbron på väg mot Klaffbron, beräknad broöppning om 6 minuter"` (passed har högsta prioritet, waiting ignoreras)

**Stallbackabron + andra broar samtidigt:**

- Båtar vid Stallbackabron (söderut) + båtar vid Klaffbron
- **Resultat**: `"2 båtar åker strax under Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter; En båt inväntar broöppning vid Klaffbron"`

**Intermediate bridge waiting vs target bridge waiting:**

- Båt waiting vid Järnvägsbron mot Klaffbron + båt waiting vid Klaffbron
- **Resultat**: `"En båt inväntar broöppning vid Klaffbron"` (target bridge waiting prioriteras över intermediate bridge waiting för samma målbro)

---

## KOMPLETT EXEMPEL-KATALOG (ALLA MÖJLIGA MEDDELANDEN)

### SINGLE VESSEL EXAMPLES

#### **KLAFFBRON (MÅLBRO):**

- **En-route**: `"En båt på väg mot Klaffbron, beräknad broöppning om 12 minuter"`
- **Approaching**: `"En båt närmar sig Klaffbron, beräknad broöppning om 8 minuter"`
- **Waiting**: `"En båt inväntar broöppning vid Klaffbron"`
- **Under-bridge**: `"Broöppning pågår vid Klaffbron"`
- **Passed**: `"En båt har precis passerat Klaffbron på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter"`

#### **STRIDSBERGSBRON (MÅLBRO):**

- **En-route**: `"En båt på väg mot Stridsbergsbron, beräknad broöppning om 15 minuter"`
- **Approaching**: `"En båt närmar sig Stridsbergsbron, beräknad broöppning om 10 minuter"`
- **Waiting**: `"En båt inväntar broöppning vid Stridsbergsbron"`
- **Under-bridge**: `"Broöppning pågår vid Stridsbergsbron"`
- **Passed (mot Klaffbron)**: `"En båt har precis passerat Stridsbergsbron på väg mot Klaffbron, beräknad broöppning om 6 minuter"`
- **Passed (slutpunkt norrut)**: Ingen text (tas bort från system)

#### **OLIDEBRON (MELLANBRO):**

- **Approaching**: `"En båt närmar sig Olidebron på väg mot Klaffbron, beräknad broöppning om 18 minuter"`
- **Waiting**: `"En båt inväntar broöppning av Olidebron på väg mot Klaffbron, beräknad broöppning om 18 minuter"`
- **Under-bridge**: `"Broöppning pågår vid Olidebron, beräknad broöppning av Klaffbron om 15 minuter"`
- **Passed**: `"En båt har precis passerat Olidebron på väg mot Klaffbron, beräknad broöppning om 15 minuter"`

#### **JÄRNVÄGSBRON (MELLANBRO):**

- **Approaching**: `"En båt närmar sig Järnvägsbron på väg mot Stridsbergsbron, beräknad broöppning om 10 minuter"`
- **Waiting**: `"En båt inväntar broöppning av Järnvägsbron på väg mot Stridsbergsbron, beräknad broöppning om 10 minuter"`
- **Under-bridge**: `"Broöppning pågår vid Järnvägsbron, beräknad broöppning av Stridsbergsbron om 7 minuter"`
- **Passed**: `"En båt har precis passerat Järnvägsbron på väg mot Stridsbergsbron, beräknad broöppning om 7 minuter"`

#### **STALLBACKABRON (SPECIALFALL):**

- **Approaching**: `"En båt närmar sig Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om 9 minuter"`
- **Stallbacka-waiting**: `"En båt åker strax under Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om 9 minuter"`
- **Under-bridge**: `"En båt passerar Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter"`
- **Passed**: `"En båt har precis passerat Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter"`

### MULTI-VESSEL EXAMPLES (SAMMA MÅLBRO)

#### **KLAFFBRON:**

- **3 En-route**: `"3 båtar på väg mot Klaffbron, beräknad broöppning om 10 minuter"`
- **2 Waiting**: `"2 båtar inväntar broöppning vid Klaffbron"`
- **1 Waiting + 2 Approaching**: `"En båt inväntar broöppning vid Klaffbron, ytterligare 2 båtar på väg"`
- **1 Under-bridge + 2 En-route**: `"Broöppning pågår vid Klaffbron, ytterligare 2 båtar på väg"`

#### **INTERMEDIATE BRIDGE:**

- **2 Waiting vid Järnvägsbron**: `"2 båtar inväntar broöppning av Järnvägsbron på väg mot Klaffbron, beräknad broöppning om 8 minuter"`
- **1 Under-bridge + 1 Approaching**: `"Broöppning pågår vid Olidebron, ytterligare 1 båt på väg, beräknad broöppning av Klaffbron om 12 minuter"`

#### **STALLBACKABRON:**

- **3 Stallbacka-waiting**: `"3 båtar åker strax under Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om 7 minuter"`
- **1 Under-bridge + 2 En-route**: `"En båt passerar Stallbackabron på väg mot Stridsbergsbron, ytterligare 2 båtar på väg, beräknad broöppning om 6 minuter"`

### MIXED MÅLBRO EXAMPLES (SEMIKOLON-SEPARATION)

#### **BÅDA MÅLBROAR AKTIVA:**

- **Basic**: `"En båt inväntar broöppning vid Klaffbron; 2 båtar närmar sig Stridsbergsbron"`
- **Complex**: `"2 båtar inväntar broöppning vid Klaffbron; En båt på väg mot Stridsbergsbron, beräknad broöppning om 12 minuter"`
- **Under-bridge**: `"Broöppning pågår vid Klaffbron; En båt inväntar broöppning vid Stridsbergsbron"`

#### **INTERMEDIATE + MÅLBRO:**

- **Järnvägsbron + Klaffbron**: `"En båt inväntar broöppning av Järnvägsbron på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter; 2 båtar inväntar broöppning vid Klaffbron"`

#### **STALLBACKABRON + ANDRA BROAR:**

- **Stallbacka + Klaffbron**: `"2 båtar åker strax under Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om 7 minuter; En båt inväntar broöppning vid Klaffbron"`
- **Stallbacka + Järnvägsbron**: `"En båt passerar Stallbackabron på väg mot Stridsbergsbron, beräknad broöppning om 6 minuter; En båt inväntar broöppning av Järnvägsbron på väg mot Klaffbron, beräknad broöppning om 15 minuter"`

### MIXED MÅLBRO VID INTERMEDIATE BRIDGE

#### **JÄRNVÄGSBRON - SPLIT MÅLBROAR:**

- **2 mot Klaffbron, 1 mot Stridsbergsbron**: `"2 båtar inväntar broöppning av Järnvägsbron på väg mot Klaffbron, beräknad broöppning om 12 minuter; En båt inväntar broöppning av Järnvägsbron på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter"`

#### **OLIDEBRON - SPLIT MÅLBROAR:**

- **3 mot Klaffbron, 2 mot Stridsbergsbron**: `"3 båtar inväntar broöppning av Olidebron på väg mot Klaffbron, beräknad broöppning om 20 minuter; 2 båtar inväntar broöppning av Olidebron på väg mot Stridsbergsbron, beräknad broöppning om 25 minuter"`

### PRIORITY OVERRIDE EXAMPLES

#### **MÅLBRO-NÄRHET HAR HÖGSTA PRIORITET:**

- **Waiting vid målbro beats passed**: `"En båt inväntar broöppning vid Klaffbron"` (ignorerar båt som precis passerat Järnvägsbron mot Klaffbron - målbro-aktivitet viktigare)
- **Under-bridge vid målbro beats passed**: `"Broöppning pågår vid Stridsbergsbron"` (ignorerar båt som precis passerat Stallbackabron mot Stridsbergsbron - pågående broöppning viktigare)

#### **TARGET BRIDGE PRIORITY:**

- **Target vs Intermediate**: Båt waiting vid Klaffbron + båt waiting vid Järnvägsbron mot Klaffbron = `"En båt inväntar broöppning vid Klaffbron"` (intermediate ignoreras)

### EDGE CASES

#### **INGA MEDDELANDEN:**

- **Norrut förbi Stridsbergsbron**: Ingen text genereras (utanför system)
- **Inga relevanta båtar**: `"Inga båtar i närheten av Stridsbergsbron eller Klaffbron"`

#### **ELIMINATION SCENARIOS:**

- **Klaffbron söderut slutpunkt**: Båt försvinner efter Klaffbron-passage
- **Stallbackabron söderut fortsättning**: Båt får ny målbro Stridsbergsbron efter Stallbacka-passage

#### **GPS-HOPP RECOVERY:**

- **Position återställd**: Normal meddelande-generation återupptas efter giltiga GPS-koordinater

---

## TEKNISKA IMPLEMENTERINGSDETALJER

### Numerisk Text-konvertering

**Alla numeriska räkneord använder text-baserade siffror:**
- 1 = "En"
- 2 = "Två"
- 3 = "Tre"
- 4+ = siffror ("4", "5", etc.)

**Exempel:**
- "Två båtar inväntar broöppning" (INTE "2 båtar")
- "ytterligare Tre båtar på väg" (INTE "ytterligare 3 båtar")

### Passage Window System

**PassageWindowManager - Centraliserad hantering:**
- **Display Window**: ALLTID 60 sekunder för "precis passerat" meddelanden
- **Internal Grace Period**: Hastighetsbaserad (2 min snabb, 1 min långsam) för intern systemlogik
- **Dynamic Calculation**: Avancerad beräkning baserat på broavstånd för intelligenta timings

**Separation av logik:**
- Användare ser alltid 60 sekunders "precis passerat"
- Systemet använder smart intern logik för stabilitet
- Målbro-skydd använder hastighetsbaserad grace period

### Stallbackabron Konsekvent Format

**ALLTID använd "ytterligare X båtar" format:**
- RÄTT: "En båt åker strax under Stallbackabron, ytterligare Två båtar på väg"
- FEL: "Tre båtar åker strax under Stallbackabron"

Detta säkerställer konsekvent format med alla andra broar.

---

**TOTALT: 50+ UNIKA MEDDELANDE-VARIANTER** som täcker alla möjliga scenarios i bridge text-systemet.
