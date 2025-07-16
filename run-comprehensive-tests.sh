#!/bin/bash

echo "======================================"
echo "    OMFATTANDE TEST-SVIT FÖR AIS TRACKER"
echo "======================================"
echo ""
echo "Kör alla tester med scenariologgning..."
echo ""

# Sätt working directory
cd "$(dirname "$0")"

# Kör comprehensive test suite
echo "1. Kör omfattande testsvit..."
npm test -- tests/comprehensive-test-suite.js --verbose

# Kör alla andra tester också
echo ""
echo "2. Kör integration-tester..."
npm test -- tests/integration/ --verbose

# Generera coverage rapport
echo ""
echo "3. Genererar test coverage..."
npm run test:coverage

# Sammanfatta resultat
echo ""
echo "======================================"
echo "    TEST-SAMMANFATTNING"
echo "======================================"
echo ""
echo "✅ Alla tester körda med scenariologgning"
echo "✅ Varje test visar vad som händer med båtar och bridge_text"
echo "✅ Coverage-rapport genererad i coverage/"
echo ""
echo "Tips: Kolla loggarna ovan för detaljerade scenario-beskrivningar!"
echo ""