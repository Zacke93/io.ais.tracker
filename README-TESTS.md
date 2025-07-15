# AIS Bridge Test Suite

Denna omfattande testsvit verifierar kärnfunktionaliteten i AIS Bridge-appen för att säkerställa stabilitet och tillförlitlighet i båtspårning och bromöppningsförutsägelser.

## Uppdatering 2025-07-15: Nya tester som hittar riktiga buggar

### simple-bug-finder-tests.js
Nya tester skapade som faktiskt hittar buggar i produktionskoden:
- **17 tester** som analyserar källkoden direkt
- **3 kritiska buggar** identifierade och fixade:
  1. `speedBelowThresholdSince` saknades i vessel data initialization
  2. Reset-logik för hastighetsövervakning saknades
  3. Meddelandeformat följde inte kravspec ("broöppning" → "öppning")
- Alla tester passerar nu efter buggfixar

### Kör de nya testerna:
```bash
npm test  # Kör simple-bug-finder-tests.js
```

### Gamla tester (arkiverade)
De tidigare testerna (82+ st) testade mockar istället för riktig kod och har flyttats till `tests/integration/old-mock-tests/`.

## Översikt

Testsviten innehåller omfattande tester för alla kritiska funktioner som identifierats i CLAUDE.md och har utökats med avancerade realistiska scenarier baserade på verkliga AIS-loggar:

### Enhetstester (Unit Tests)

#### 1. Smart Boat Detection (`tests/unit/boat-detection.test.js`)
- **Haversine Distance Calculation**: Verifierar korrekta avstånd mellan koordinater
- **Speed History Tracking**: Testar hastighetshistorik och maximal hastighet
- **Waiting Detection Logic**: Identifierar båtar som väntar vid broar
- **Bridge Direction Logic**: Kontrollerar riktningsbestämning baserat på COG
- **Bridge Proximity Detection**: Verifierar detektering inom brozonerna
- **Multi-Bridge Vessel Tracking**: Testar spårning mellan flera broar
- **ETA Calculation Logic**: Grundläggande ETA-beräkningar
- **Target Bridge Focus**: Verifierar prioritering av Klaffbron och Stridsbergsbron

#### 2. WebSocket Connection Management (`tests/unit/websocket-connection.test.js`)
- **API Key Validation**: Testar giltiga och ogiltiga API-nyckelformat
- **Connection Establishment**: Verifierar WebSocket-anslutning till AISstream.io
- **Message Processing**: Bearbetar AIS-positionsrapporter korrekt
- **Connection Resilience**: Exponentiell backoff vid anslutningsfel
- **Connection Status Updates**: Statusuppdateringar för enheter
- **Cleanup and Resource Management**: Städning av intervaller och timeouts

#### 3. ETA Calculation and Bridge Text Generation (`tests/unit/eta-calculation.test.js`)
- **ETA Calculation Logic**: Korrekta ETA-beräkningar för olika hastigheter
- **Bridge Text Generation**: Meddelanden för olika båtscenarier
- **Bridge Sequence Logic**: Förståelse av båtrutter mellan broar
- **Time-based Message Updates**: Uppdateringar baserat på föränderlig data

### Integrationstester (Integration Tests)

#### 4. Flow Cards Integration (`tests/integration/flow-cards.test.js`)
- **Boat Near Trigger Card**: Trigger-kort för båtar nära broar
- **Boat Recent Condition Card**: Villkorskort för recent båtaktivitet
- **Global Token Updates**: Uppdateringar av aktiva broar-token
- **Multi-Bridge Flow Logic**: Flödeslogik för flera broar
- **Flow Card State Consistency**: Konsistent tillstånd mellan kort

#### 5. Stability and Reliability (`tests/integration/stability.test.js`)
- **Boat Tracking Reliability**: Tillförlitlig spårning trots kursförändringar
- **Anchored and Waiting Boat Detection**: Detektering av förankrade och väntande båtar
- **ETA Accuracy and Consistency**: Noggrannhet i ETA-beräkningar
- **Multi-Boat Handling**: Hantering av flera båtar samtidigt
- **Connection Resilience**: Motståndskraft mot anslutningsfel
- **Memory and Performance**: Minneshantering och prestanda

#### 6. Realistiska AIS-scenarier (`tests/integration/log-based-scenarios.test.js`)
**NYTT** - Baserat på verkliga AIS-loggar från 2025-07-08 och 2025-07-07:

- **EMMA F Journey Simulation**: Detaljerad simulering av EMMA F:s resa från Olidebron till Klaffbron
- **ENCORE Journey Simulation**: Snabb båt-approach och bropassage med riktningsförändringar  
- **SKAGERN Journey Simulation**: Konsekvent lastbåt med stabil hastighet
- **Speed Compensation Logic**: Tester för hastighetskompenserade timeouts (20min för mycket långsam, 15min för långsam, 10min för normal)
- **Signal Loss and Recovery**: Realistiska anslutningsavbrott och återhämtning
- **Bridge Passage Detection**: Omedelbar detektering av bropassage och ruttprediktion
- **Multi-Bridge Sequences**: Komplexa rutter genom hela bronätverket
- **Dual-Bridge Triggering Prevention**: Smart meddelandeprioritering för att undvika dubbel-triggering
- **ETA Calculation Accuracy**: Distansbaserade regler och hastighetskompenstation
- **Message Generation**: Meddelanden under olika båtkombinationer

#### 7. Avancerad Tillförlitlighet och Prestanda (`tests/integration/advanced-reliability.test.js`)
**NYTT** - Omfattande tillförlitlighets- och prestandatester:

- **Signal Loss Patterns**: Simulerar verkliga signalförlustmönster och återhämtning
- **Speed History Tracking**: Detaljerad hastighetshistorik och maxhastighet-spårning
- **Timeout Compensation**: Verifierar olika timeout-bonusar baserat på båthastighet
- **Bridge Passage Prediction**: Omedelbar ruttprediktion när båtar passerar broar
- **Complex Route Sequences**: Tester för hela brosequenser (Olidebron → Klaffbron → Stridsbergsbron)
- **ETA Edge Cases**: Hantering av extremfall (nollavstånd, negativa värden, mycket höga hastigheter)
- **Message Prioritization**: Smart prioritering av Stridsbergsbron över Klaffbron för samma fartyg
- **Performance Benchmarks**: Prestanda med 15+ båtar samtidigt (ska klara <200ms)
- **Memory Management**: Tester för minnesläckor vid höga frekvensuppdateringar
- **Error Recovery**: Graceful hantering av felformaterad data och extremvärden

#### 8. Realistic Boat Data (`tests/fixtures/boat-data.js`)
**UTÖKAD** - Realistiska båtscenarier:

- **5 olika fartygstyper**: Snabb motorbåt, långsam lastbåt, förankrad segelbåt, multi-bro hastighetsbåt, väntande båt
- **Kompletta AIS-resor**: 6 positioner per resa med realistiska hastighets- och riktningsförändringar
- **Multi-båt scenarier**: Samtidig hantering av flera båtar vid olika broar
- **Stress-test data**: Höga belastningsscenarier med 7+ båtar

## Körning av Tester

### Alla tester (82+ tester)
```bash
npm test
```

### Grundläggande funktionalitetstester
```bash
npm test tests/unit/
npm test tests/integration/flow-cards.test.js
npm test tests/integration/stability.test.js
```

### Nya avancerade realistiska tester
```bash
# Verkliga båtresor baserade på AIS-loggar
npm test tests/integration/log-based-scenarios.test.js

# Tillförlitlighet och prestanda
npm test tests/integration/advanced-reliability.test.js
```

### Specifika testscenarier
```bash
# Testa EMMA F journey från loggar
npm test -- --testNamePattern="EMMA F journey"

# Testa hastighetskompensation
npm test -- --testNamePattern="speed compensation"

# Testa bropassage-detektering
npm test -- --testNamePattern="bridge passage"
```

### Med kodtäckning
```bash
npm run test:coverage
```

### Watch-läge för utveckling
```bash
npm run test:watch
```

## Testresultat och Täckning

Testsviten fokuserar på de specifika problem som identifierades i AIS-loggarna:

### ✅ Kritiska Funktioner som Testas

**Grundläggande funktionalitet:**
- Haversine-avståndberäkningar
- Båthastighetsspårning och historik  
- Väntedetektering för båtar vid broar
- ETA-beräkningar med hastighetskompenstation
- Riktningsbestämning (Göteborg/Vänersborg)
- Flödeskortsintegration
- WebSocket-anslutningshantering
- Multi-båt hantering vid målbroar

**Avancerade scenario från verkliga loggar:**
- **Emma F-problemet**: Båtar som försvinner utan anledning innan de når broar
- **Julia 11-minuters ETA**: Orealistiska ETA-beräkningar för långsamma båtar nära broar
- **SPIKEN dual-triggering**: Samma båt triggar både Klaffbron och Stridsbergsbron samtidigt
- **Bropassage-detektering**: Långsam återspårning efter att båtar passerat broar
- **Signalförlust**: Båtar som inte återkommer trots stabila AIS-signaler
- **Hastighetskompensation**: Intelligent timeout-hantering baserat på båthastighet

### 🎯 Stabilitetsaspekter (Lösta Problem)

**Förbättrad signalhantering:**
- ✅ MAX_AGE_SEC utökad från 5 till 10 minuter för bättre tolerans
- ✅ GRACE_PERIOD utökad från 60s till 120s för komplexa rutter
- ✅ Hastighetskompenserade timeouts (20min för mycket långsam, 15min för långsam)

**Smart båtdetektering:**
- ✅ Båtar försvinner inte vid mindre kursförändringar
- ✅ Omedelbar bropassage-detektering och ruttprediktion
- ✅ Distansbaserade ETA-regler ("väntar" för mycket nära/långsamma båtar)
- ✅ Smart meddelandeprioritering för att undvika dual-triggering

**Prestandaförbättringar:**
- ✅ Effektiv multi-båt hantering (15+ båtar samtidigt <200ms)
- ✅ Intelligent loggnivåer för att minska overhead
- ✅ Robust minneshantering utan läckor

### 📊 Förväntade Testresultat

**82+ tester** bör passera med följande fördelning:
- **Unit tests**: 40+ tester för grundfunktionalitet
- **Integration tests**: 25+ tester för komponentinteraktion  
- **Realistic scenarios**: 15+ tester för verkliga AIS-scenarier
- **Advanced reliability**: 15+ tester för prestanda och tillförlitlighet

**Eventuella fel indikerar:**
1. **Regressionsfel**: Kärnfunktionalitet påverkad av nytt kod
2. **Scenarifeli**: Verkliga användningsfall inte korrekt hanterade
3. **Prestandaproblem**: Timeout-hantering eller minnesanvändning
4. **Integrationsproblem**: Flow-kort eller enhetssynkronisering

## Felsökning

### Vanliga Problem

1. **Mock-fel**: Homey-API:t är mockat - verklig funktionalitet testas inte
2. **Timing-problem**: Async-operationer kan kräva `await` eller längre timeouts
3. **Datastruktur**: Ändringar i `_lastSeen` kan påverka flera tester
4. **Missing fields**: Nya realistiska tester kräver komplett båtdata (mmsi, towards, sog, dist, dir)
5. **Timeout values**: Hastighetskompensation returnerar sekunder, inte millisekunder

### Debug-tips för Nya Tester

1. **Verkliga scenarier**: Kör `npm test -- --testNamePattern="EMMA F"` för att debugga specifika båtresor
2. **Hastighetsdata**: Kontrollera att båtdata innehåller alla required fields (`mmsi`, `towards`, `sog`, `dist`, `dir`, `vessel_name`)
3. **ETA-beräkningar**: Använd `etaMinutes` property, inte `eta`
4. **Method names**: Använd `_getSpeedAdjustedTimeout()`, `_calculateETA(vessel, distance, bridge)`, `_addToNextRelevantBridge(mmsi, bridge, lat, lon, dir, sog, passedBridges)`
5. **Prestandatester**: Använd `console.time()` för att mäta processingtid

### Specifik Felsökning

```bash
# Debug EMMA F scenario
npm test -- --testNamePattern="EMMA F journey" --verbose

# Debug timeout-kompensation  
npm test -- --testNamePattern="speed compensation" --verbose

# Debug prestanda
npm test -- --testNamePattern="performance" --verbose
```

## Verifiering av Loggfixar

Testerna verifierar att alla 8 identifierade problem från AIS-loggarna är lösta:

### ✅ Problem 1: Emma F försvinner
- **Test**: `log-based-scenarios.test.js` - "EMMA F signal loss and recovery"
- **Fix**: Utökad MAX_AGE_SEC och hastighetskompensation

### ✅ Problem 2: Julia 11-minuters orealistisk ETA  
- **Test**: `advanced-reliability.test.js` - "ETA edge cases"
- **Fix**: Distansbaserade regler, "väntar" status för nära/långsamma båtar

### ✅ Problem 3: SPIKEN dual-triggering
- **Test**: `log-based-scenarios.test.js` - "dual-bridge triggering prevention"  
- **Fix**: Smart meddelandeprioritering baserat på MMSI-jämförelse

### ✅ Problem 4: Långsam bropassage-detektering
- **Test**: `advanced-reliability.test.js` - "immediate bridge passage detection"
- **Fix**: Omedelbar `_addToNextRelevantBridge()` anrop

### ✅ Problem 5-8: Signal tolerans och prestanda
- **Test**: Omfattande stabilitets- och prestandatester
- **Fix**: Grace periods, hastighetskompensation, effektiv ruttprediktion

## Mock-konfiguration

Testerna använder:
- **Homey SDK**: Helt mockad via `tests/__mocks__/homey.js`
- **WebSocket**: Mockad via Jest för att simulera AISstream.io
- **Timers**: Verkliga timers för tidsberoende tester

Detta säkerställer att testerna är snabba, deterministiska och oberoende av externa tjänster.