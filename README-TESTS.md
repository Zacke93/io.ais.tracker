# AIS Bridge Test Suite

Denna testsvit verifierar kärnfunktionaliteten i AIS Bridge-appen för att säkerställa stabilitet och tillförlitlighet i båtspårning och bromöppningsförutsägelser.

## Översikt

Testsviten innehåller omfattande tester för alla kritiska funktioner som identifierats i CLAUDE.md:

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

## Körning av Tester

### Alla tester
```bash
npm test
```

### Specifik testfil
```bash
npm test tests/unit/boat-detection.test.js
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

Testerna fokuserar på:

### ✅ Kritiska Funktioner som Testas
- Haversine-avståndberäkningar
- Båthastighetsspårning och historik
- Väntedetektering för båtar vid broar
- ETA-beräkningar med hastighetskompenstation
- Riktningsbestämning (Göteborg/Vänersborg)
- Flödeskortsintegration
- WebSocket-anslutningshantering
- Multi-båt hantering vid målbroar

### 🎯 Stabilitetsaspekter
- Båtar försvinner inte vid mindre kursförändringar
- Tillförlitlig detektering av förankrade och väntande båtar
- Korrekt ETA-beräkning för bromöppningar
- Hantering av flera båtar som närmar sig olika målbroar
- Robust anslutningshantering med exponentiell backoff

### 📊 Förväntade Testresultat

Majoriteten av testerna bör passera. Eventuella fel indikerar:

1. **Funktionalitetsfel**: Kärnlogik fungerar inte som förväntat
2. **Stabilitetsfel**: Problem med tillförlitlighet i båtspårning
3. **Prestanda**: Minnesläckor eller ineffektiv datahantering
4. **Integration**: Problem mellan komponenter

## Felsökning

### Vanliga Problem

1. **Mock-fel**: Homey-API:t är mockat - verklig funktionalitet testas inte
2. **Timing-problem**: Async-operationer kan kräva `await` eller längre timeouts
3. **Datastruktur**: Ändringar i `_lastSeen` kan påverka flera tester

### Debug-tips

1. Använd `console.log` i tester för att spåra dataflöde
2. Kör enskilda tester med `npm test -- --testNamePattern="test name"`
3. Kontrollera mock-konfiguration i `tests/__mocks__/homey.js`

## Framtida Förbättringar

1. **End-to-End Tester**: Verkliga WebSocket-anslutningar
2. **Performance Benchmarks**: Mätning av prestanda vid hög belastning
3. **Error Simulation**: Simulera AIS-datafel och anslutningsavbrott
4. **Device Integration**: Testa bridge_status enheter direkt

## Mock-konfiguration

Testerna använder:
- **Homey SDK**: Helt mockad via `tests/__mocks__/homey.js`
- **WebSocket**: Mockad via Jest för att simulera AISstream.io
- **Timers**: Verkliga timers för tidsberoende tester

Detta säkerställer att testerna är snabba, deterministiska och oberoende av externa tjänster.