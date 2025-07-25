'use strict';

/**
 * Run Real App Journey Tests
 *
 * Runs ACTUAL app.js tests with complete system integration.
 * These tests show exactly how bridge_text changes during real boat journeys.
 */

console.log('🚢 AIS BRIDGE SYSTEM - REAL APP JOURNEY TESTING');
console.log('='.repeat(80));
console.log('Detta test kör den RIKTIGA app.js logiken med alla services:');
console.log('- VesselDataService (verklig båthantering)');
console.log('- StatusService (verklig status-analys)');
console.log('- ProximityService (verklig avståndsberäkning)');
console.log('- BridgeTextService (verklig textgenerering)');
console.log('- Event-driven kommunikation mellan alla services');
console.log('');
console.log('📚 TILLGÄNGLIGA REAL APP SCENARIOS:');
console.log('1. North to South Journey - Komplett resa genom alla broar');
console.log('2. Complex Multi-Vessel - 4 båtar mot båda målbroarna samtidigt');
console.log('');

const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('Ange scenario (1-2) eller tryck Enter för scenario 1: ', async (answer) => {
  console.log('\n');

  const choice = answer.trim() || '1';

  switch (choice) {
    case '1':
      console.log('🚀 Kör North to South Journey med REAL APP LOGIC...\n');
      try {
        const runScenario = require('./north-to-south-journey'); // eslint-disable-line global-require
        await runScenario();
        console.log('\n✅ Scenario completed successfully!');
      } catch (error) {
        console.error('\n❌ Scenario failed:', error.message);
      }
      break;

    case '2':
      console.log('🚀 Kör Complex Multi-Vessel Journey med REAL APP LOGIC...\n');
      try {
        const { complexMultiVesselJourney } = require('./complex-multi-vessel-journey'); // eslint-disable-line global-require
        await complexMultiVesselJourney();
        console.log('\n✅ Complex multi-vessel scenario completed successfully!');
      } catch (error) {
        console.error('\n❌ Complex multi-vessel scenario failed:', error.message);
      }
      break;

    default:
      console.log('❌ Ogiltigt val. Kör scenario 1 som standard...\n');
      try {
        const runScenario = require('./north-to-south-journey'); // eslint-disable-line global-require
        await runScenario();
        console.log('\n✅ Scenario completed successfully!');
      } catch (error) {
        console.error('\n❌ Scenario failed:', error.message);
      }
  }

  console.log('\n💡 NÄSTA STEG:');
  console.log('Baserat på resultaten ovan, bestäm exakt hur bridge_text ska fungera.');
  console.log('Säg sedan "Steg X ska visa Y istället för Z" för att guida implementation.');

  rl.close();
});
