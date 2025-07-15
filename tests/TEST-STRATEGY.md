# AIS Tracker 2.0 - Test Strategy

## Översikt

Testsviten är designad för att fånga verkliga buggar baserat på analys av produktionsloggar och kravspecifikationen. Fokus ligger på att verifiera systemets stabilitet och korrekthet i verkliga scenarion.

## Testfiler

### 1. `simple-bug-finder-tests.js`
**Syfte**: Statisk kodanalys för att hitta uppenbara buggar i källkoden.
- Söker efter kodmönster som indikerar buggar
- Verifierar att kritiska funktioner finns
- Kontrollerar att kravspec-regler är implementerade

### 2. `comprehensive-bug-detection-tests.js` 
**Syfte**: Omfattande tester för de 12 identifierade buggarna från produktionsloggar.
- Testar varje identifierad bugg individuellt
- Verifierar timeout-zoner enligt kravspec
- Kontrollerar bropassage-detektion
- Testar waiting/under-bridge statushantering
- Verifierar ETA-beräkningar
- Testar systemet under belastning (20+ båtar)

### 3. `real-log-scenario-tests.js`
**Syfte**: Återskapar exakta scenarion från produktionsloggar.
- Simulerar verkliga båtrörelser från loggarna
- Testar WebSocket-anslutningsproblem
- Verifierar hantering av flera båtar vid samma bro
- Testar båtar som rör sig mellan broar
- Inkluderar långvariga stabilitetstester

### 4. `chaos-edge-case-tests.js`
**Syfte**: Chaos testing och edge cases för att hitta oväntade buggar.
- Extrema värden (negativa koordinater, höga hastigheter)
- Snabba tillståndsändringar
- Korrupt data och saknade fält
- Samtidiga operationer
- Stress-tester med 1000+ båtar

## Identifierade Buggar från Loggar

Testerna fokuserar på följande 12 kritiska buggar:

1. **Minnesproblem** - process.memoryUsage() fel i Homey
2. **Felaktiga timeout-zoner** - 300m gränsen hanteras fel
3. **Under-bridge utan kontinuitet** - Status sätts direkt baserat på avstånd
4. **Felaktig ETA för nära båtar** - Visar minuter istället för "väntar"
5. **Ingen bropassage-detektion** - Båtar fastnar vid broar
6. **Båtar försvinner utan förvarning** - Ingen graceful cleanup
7. **Inkonsekvent statushantering** - Status uppdateras inte korrekt
8. **Saknade mellanbro-fraser** - Endast målbroar får kontext
9. **Duplicerade UI-uppdateringar** - Onödiga uppdateringar
10. **COG används inte** - Riktningsdata ignoreras
11. **Waiting utan kontinuitet** - Ingen 2-minuters regel
12. **Bro-till-bro avstånd** - Använder haversine istället för verkliga avstånd

## Körning av Tester

```bash
# Kör alla tester
npm test

# Kör specifik testfil
npm test -- comprehensive-bug-detection-tests.js

# Kör med coverage
npm run test:coverage

# Kör i watch mode
npm run test:watch
```

## Testresultat

Vid körning av comprehensive-bug-detection-tests.js hittades följande:
- ✅ 20 av 26 tester passerar
- ❌ 6 buggar identifierade som behöver åtgärdas:
  - speedBelowThresholdSince sätts till undefined istället för null
  - ETACalculator saknar logger i konstruktorn
  - Mellanbro-fraser saknas i MessageGenerator

## Nästa Steg

1. Fixa de identifierade buggarna i app.js
2. Lägga till fler edge case-tester baserat på nya loggar
3. Implementera integrationstester med verklig WebSocket
4. Skapa prestandatester för långvarig drift

## Underhåll

- Lägg till nya tester när buggar hittas i produktion
- Uppdatera real-log-scenario-tests.js med nya loggexempel
- Kör testerna innan varje release