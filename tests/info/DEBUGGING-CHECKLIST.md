# Bridge Text Debugging Checklist

## 🔍 Snabb Felsökningsguide

Använd denna checklista när du hittar buggar i bridge_text generering.

## 📋 Steg-för-steg Debugging

### 1. Kör Comprehensive Test
```bash
node tests/chronological-bridge-text-test.js > debug_output.txt
```

### 2. Leta efter Avvikelser
Sök efter rader som INTE matchar:
```
🎯 Förväntat mönster: "Expected message"
🌉 BRIDGE_TEXT: "Actual message"
```

### 3. Analysera Specifika Problem

#### ❌ Problem: Tom text när båtar finns
```
🎯 Förväntat mönster: "En båt närmar sig Klaffbron"
🌉 BRIDGE_TEXT: ""
```
**Möjliga orsaker:**
- Båt saknar `targetBridge`
- Båt filtreras bort av `_isVesselStationary()`
- Fel i boat grouping logic
- Invalid boat object

**Debug steps:**
```javascript
// Kontrollera boat object:
console.log('Boat:', JSON.stringify(boat, null, 2));
// Kolla targetBridge:
console.log('Target bridge:', boat.targetBridge);
// Verifiera grouping:
console.log('Groups:', groups);
```

#### ❌ Problem: Fel ETA format
```
🎯 Förväntat mönster: "beräknad broöppning nu"
🌉 BRIDGE_TEXT: "beräknad broöppning om 0 minuter"
```
**Möjliga orsaker:**
- `_formatETA()` logik fel
- `etaMinutes` är 0 men behandlas som positiv
- `isWaiting` flag ignoreras

**Debug steps:**
```javascript
// Kontrollera ETA input:
console.log('ETA minutes:', boat.etaMinutes);
console.log('Is waiting:', boat.isWaiting);
// Testa _formatETA directly:
console.log('Formatted:', messageGenerator._formatETA(boat.etaMinutes, boat.isWaiting));
```

#### ❌ Problem: Fel prioritet
```
🎯 Förväntat mönster: "En båt som precis passerat [bridge]"
🌉 BRIDGE_TEXT: "En båt vid [currentBridge] närmar sig [target]"
```
**Möjliga orsaker:**
- `lastPassedBridgeTime` inte satt korrekt
- Tidsfönster-logik fel (sog vs time window)
- Priority order i `_generatePhraseForBridge` fel

**Debug steps:**
```javascript
// Kontrollera passage data:
console.log('Last passed time:', boat.lastPassedBridgeTime);
console.log('Time diff:', Date.now() - boat.lastPassedBridgeTime);
console.log('SOG:', boat.sog);
// Beräkna förväntat tidsfönster:
const window = boat.sog > 5 ? 2*60*1000 : 1*60*1000; // 2min eller 1min
console.log('Expected window:', window);
```

#### ❌ Problem: Fel boat counting
```
🎯 Förväntat mönster: "ytterligare 2 båtar på väg"
🌉 BRIDGE_TEXT: "ytterligare 3 båtar på väg"
```
**Möjliga orsaker:**
- Stationary boats inte filtrerade korrekt
- Duplicate boats i gruppen
- Waiting vs approaching counting fel

**Debug steps:**
```javascript
// Kontrollera boat array:
console.log('All boats in group:', boats.length);
console.log('Waiting boats:', boats.filter(b => b.isWaiting).length);
console.log('Approaching boats:', boats.filter(b => !b.isWaiting).length);
// Check for duplicates:
const mmsis = boats.map(b => b.mmsi);
console.log('Unique MMSIs:', [...new Set(mmsis)].length);
```

#### ❌ Problem: Ankrade båtar räknas som aktiva
```
🎯 Förväntat mönster: "En båt närmar sig Klaffbron"
🌉 BRIDGE_TEXT: "En båt närmar sig Klaffbron, ytterligare 1 båt på väg"
```
**Möjliga orsaker:**
- `_isVesselStationary()` fungerar inte
- `lastPositionChange` inte uppdaterat
- SOG threshold för låg

**Debug steps:**
```javascript
// Kontrollera stationary detection:
console.log('SOG:', boat.sog);
console.log('Last position change:', boat.lastPositionChange);
console.log('Position diff:', Date.now() - boat.lastPositionChange);
// Manuell stationary check:
const isStationary = boat.sog <= 0.2 && 
  boat.lastPositionChange && 
  (Date.now() - boat.lastPositionChange > 30000);
console.log('Should be stationary:', isStationary);
```

### 4. Common Patterns för Debugging

#### Kontrollera Input Data
```javascript
function debugBoat(boat) {
  console.log('=== BOAT DEBUG ===');
  console.log('MMSI:', boat.mmsi);
  console.log('Name:', boat.name);
  console.log('Target bridge:', boat.targetBridge);
  console.log('Current bridge:', boat.currentBridge);
  console.log('ETA minutes:', boat.etaMinutes);
  console.log('Status:', boat.status);
  console.log('Is waiting:', boat.isWaiting);
  console.log('Confidence:', boat.confidence);
  console.log('SOG:', boat.sog);
  console.log('Last passed time:', boat.lastPassedBridgeTime);
  console.log('Last position change:', boat.lastPositionChange);
  console.log('==================');
}
```

#### Trace Message Generation
```javascript
// Lägg till detta i din test:
const originalGenerateBridgeText = messageGenerator.generateBridgeText;
messageGenerator.generateBridgeText = function(boats) {
  console.log('INPUT BOATS:', boats.length);
  boats.forEach((boat, i) => {
    console.log(`Boat ${i}:`, {
      mmsi: boat.mmsi,
      target: boat.targetBridge,
      eta: boat.etaMinutes,
      waiting: boat.isWaiting
    });
  });
  
  const result = originalGenerateBridgeText.call(this, boats);
  console.log('OUTPUT:', result);
  return result;
};
```

## 🎯 Snabba Kontroller

### ✅ Message är korrekt om:
- [ ] Har rätt boat count ("En båt" vs "2 båtar")
- [ ] ETA format är rätt ("nu", "1 minut", "X minuter", "inväntar broöppning")
- [ ] Prioritet följs (precis passerat > mellanbro > normal)
- [ ] Bridge names är korrekta och finns i systemet
- [ ] Grammatik är korrekt (singular/plural)

### ❌ Message är felaktig om:
- [ ] Tom text när båtar finns
- [ ] "om 0 minuter" istället för "nu"
- [ ] Fel boat count (ankrade båtar räknas)
- [ ] Fel prioritet (mellanbro över precis passerat)
- [ ] Okända bridge names
- [ ] Malformed text eller grammatik fel

## 🔧 Verktyg för Debugging

### Console Commands
```bash
# Kör bara pattern test:
node -e "
const test = require('./tests/chronological-bridge-text-test.js');
// (editera för att bara köra testAllMessagePatterns)
"

# Filtrera output:
node tests/chronological-bridge-text-test.js | grep "🌉 BRIDGE_TEXT"

# Spara för jämförelse:
node tests/chronological-bridge-text-test.js > before_fix.txt
# ... gör ändringar ...
node tests/chronological-bridge-text-test.js > after_fix.txt
diff before_fix.txt after_fix.txt
```

### Test Modifications
```javascript
// Lägg till specifikt testfall:
runTest(
  'Min bug reproduction',
  'Specifik scenario som triggar buggen',
  [/* exakt boat data som orsakar problem */],
  'Vad som förväntades'
);
```

Använd denna checklista systematiskt för att snabbt identifiera och lokalisera bridge_text buggar!