// Realistisk båtdata för tester baserat på verkliga AIS-meddelanden

const BRIDGE_COORDINATES = {
  olidebron: { lat: 58.272743083145855, lon: 12.275115821922993 },
  klaffbron: { lat: 58.28409551543077, lon: 12.283929525245636 },
  jarnvagsbron: { lat: 58.29164042152742, lon: 12.292025280073759 },
  stridsbergsbron: { lat: 58.293524096154634, lon: 12.294566425158054 },
  stallbackabron: { lat: 58.31142992293701, lon: 12.31456385688822 }
};

// Simulerade båtar med realistiska rutter
const BOAT_SCENARIOS = {
  // Snabb motorbåt som åker mot Göteborg
  fast_motorboat_goteborg: {
    mmsi: 265123456,
    name: "SPEED DEMON",
    route: [
      { lat: 58.275, lon: 12.270, sog: 8.5, cog: 225, timestamp: Date.now() - 300000 }, // 5 min sedan
      { lat: 58.280, lon: 12.275, sog: 8.2, cog: 220, timestamp: Date.now() - 240000 }, // 4 min sedan
      { lat: 58.285, lon: 12.280, sog: 7.8, cog: 215, timestamp: Date.now() - 180000 }, // 3 min sedan
      { lat: 58.290, lon: 12.285, sog: 7.5, cog: 210, timestamp: Date.now() - 120000 }, // 2 min sedan
      { lat: 58.294, lon: 12.292, sog: 4.2, cog: 205, timestamp: Date.now() - 60000 },  // 1 min sedan - bromsade för Stridsbergsbron
      { lat: 58.294, lon: 12.293, sog: 0.3, cog: 205, timestamp: Date.now() }          // Nu - väntar vid Stridsbergsbron
    ]
  },

  // Långsam lastbåt mot Vänersborg
  slow_cargo_vanersborg: {
    mmsi: 265789012,
    name: "CARGO MASTER",
    route: [
      { lat: 58.295, lon: 12.300, sog: 3.2, cog: 45, timestamp: Date.now() - 600000 },  // 10 min sedan
      { lat: 58.292, lon: 12.295, sog: 3.5, cog: 42, timestamp: Date.now() - 480000 },  // 8 min sedan
      { lat: 58.290, lon: 12.290, sog: 3.8, cog: 40, timestamp: Date.now() - 360000 },  // 6 min sedan
      { lat: 58.287, lon: 12.285, sog: 3.6, cog: 38, timestamp: Date.now() - 240000 },  // 4 min sedan
      { lat: 58.284, lon: 12.282, sog: 3.4, cog: 35, timestamp: Date.now() - 120000 },  // 2 min sedan - närmar sig Klaffbron
      { lat: 58.283, lon: 12.281, sog: 3.2, cog: 32, timestamp: Date.now() }           // Nu - passerar Klaffbron
    ]
  },

  // Segelbåt som ankrat upp
  anchored_sailboat: {
    mmsi: 265345678,
    name: "WIND DANCER",
    route: [
      { lat: 58.275, lon: 12.280, sog: 4.5, cog: 180, timestamp: Date.now() - 1800000 }, // 30 min sedan - i rörelse
      { lat: 58.273, lon: 12.279, sog: 2.1, cog: 190, timestamp: Date.now() - 1200000 }, // 20 min sedan - bromsade
      { lat: 58.272, lon: 12.278, sog: 0.2, cog: 195, timestamp: Date.now() - 600000 },  // 10 min sedan - nästan stillastående
      { lat: 58.272, lon: 12.278, sog: 0.1, cog: 200, timestamp: Date.now() - 300000 },  // 5 min sedan - ankrad
      { lat: 58.272, lon: 12.278, sog: 0.1, cog: 205, timestamp: Date.now() }            // Nu - fortfarande ankrad
    ]
  },

  // Snabb båt som passerat flera broar
  multi_bridge_speedboat: {
    mmsi: 265901234,
    name: "BRIDGE RUNNER",
    route: [
      { lat: 58.270, lon: 12.270, sog: 12.5, cog: 45, timestamp: Date.now() - 480000 }, // 8 min sedan - start vid Olidebron
      { lat: 58.278, lon: 12.278, sog: 11.8, cog: 42, timestamp: Date.now() - 360000 }, // 6 min sedan - passerade Olidebron
      { lat: 58.284, lon: 12.284, sog: 6.2, cog: 40, timestamp: Date.now() - 240000 },  // 4 min sedan - bromsade för Klaffbron
      { lat: 58.285, lon: 12.285, sog: 10.5, cog: 38, timestamp: Date.now() - 120000 }, // 2 min sedan - accelererade efter Klaffbron
      { lat: 58.292, lon: 12.292, sog: 5.8, cog: 35, timestamp: Date.now() - 60000 },   // 1 min sedan - bromsade för Järnvägsbron
      { lat: 58.294, lon: 12.294, sog: 2.1, cog: 32, timestamp: Date.now() }            // Nu - väntar vid Stridsbergsbron
    ]
  },

  // Fiskebåt med oregelbunden hastighet
  fishing_boat_irregular: {
    mmsi: 265567890,
    name: "CATCH OF THE DAY",
    route: [
      { lat: 58.290, lon: 12.275, sog: 4.2, cog: 120, timestamp: Date.now() - 900000 }, // 15 min sedan
      { lat: 58.288, lon: 12.278, sog: 1.8, cog: 130, timestamp: Date.now() - 720000 }, // 12 min sedan - saktar ner
      { lat: 58.286, lon: 12.280, sog: 0.5, cog: 140, timestamp: Date.now() - 540000 }, // 9 min sedan - nästan stopp
      { lat: 58.285, lon: 12.282, sog: 3.5, cog: 135, timestamp: Date.now() - 360000 }, // 6 min sedan - startar igen
      { lat: 58.284, lon: 12.284, sog: 4.1, cog: 132, timestamp: Date.now() - 180000 }, // 3 min sedan - normal hastighet
      { lat: 58.283, lon: 12.285, sog: 3.8, cog: 128, timestamp: Date.now() }           // Nu - närmar sig Klaffbron
    ]
  }
};

// Hjälpfunktion för att skapa AIS-meddelanden
function createAISMessage(boatData, routeIndex = -1) {
  const route = boatData.route;
  const position = routeIndex >= 0 ? route[routeIndex] : route[route.length - 1];
  
  return {
    MessageType: 'PositionReport',
    Metadata: {
      Latitude: position.lat,
      Longitude: position.lon,
      SOG: position.sog,
      COG: position.cog,
      ShipName: boatData.name,
      MMSI: boatData.mmsi,
      TimeOfFix: position.timestamp
    },
    Message: {
      'PositionReport': {
        MMSI: boatData.mmsi,
        Latitude: position.lat,
        Longitude: position.lon,
        SOG: position.sog,
        COG: position.cog,
        Name: boatData.name
      }
    }
  };
}

// Hjälpfunktion för att simulera båt som rör sig genom flera broar
function createBoatJourney(boatKey, startIndex = 0) {
  const boat = BOAT_SCENARIOS[boatKey];
  return boat.route.slice(startIndex).map((_, index) => 
    createAISMessage(boat, startIndex + index)
  );
}

// Scenarier för olika testsituationer
const TEST_SCENARIOS = {
  // Scenario 1: Ingen båtaktivitet
  no_boats: [],

  // Scenario 2: En båt närmar sig målbro
  single_boat_approaching: [
    createAISMessage(BOAT_SCENARIOS.fast_motorboat_goteborg)
  ],

  // Scenario 3: Flera båtar vid olika broar
  multiple_boats_different_bridges: [
    createAISMessage(BOAT_SCENARIOS.fast_motorboat_goteborg),
    createAISMessage(BOAT_SCENARIOS.slow_cargo_vanersborg),
    createAISMessage(BOAT_SCENARIOS.fishing_boat_irregular)
  ],

  // Scenario 4: Båt som väntar vid bro
  boat_waiting_at_bridge: [
    createAISMessage(BOAT_SCENARIOS.fast_motorboat_goteborg) // Sista positionen är väntande
  ],

  // Scenario 5: Ankrad båt (ska ignoreras)
  anchored_boat: [
    createAISMessage(BOAT_SCENARIOS.anchored_sailboat)
  ],

  // Scenario 6: Båt som passerat flera broar
  multi_bridge_scenario: [
    createAISMessage(BOAT_SCENARIOS.multi_bridge_speedboat)
  ],

  // Scenario 7: Hög belastning - många båtar
  high_load_scenario: [
    createAISMessage(BOAT_SCENARIOS.fast_motorboat_goteborg),
    createAISMessage(BOAT_SCENARIOS.slow_cargo_vanersborg),
    createAISMessage(BOAT_SCENARIOS.anchored_sailboat),
    createAISMessage(BOAT_SCENARIOS.multi_bridge_speedboat),
    createAISMessage(BOAT_SCENARIOS.fishing_boat_irregular),
    // Lägg till fler båtar för stress-test
    createAISMessage({
      mmsi: 265111111, name: "TEST BOAT 1", 
      route: [{ lat: 58.285, lon: 12.284, sog: 5.2, cog: 180, timestamp: Date.now() }]
    }),
    createAISMessage({
      mmsi: 265222222, name: "TEST BOAT 2", 
      route: [{ lat: 58.293, lon: 12.295, sog: 3.8, cog: 270, timestamp: Date.now() }]
    })
  ]
};

module.exports = {
  BRIDGE_COORDINATES,
  BOAT_SCENARIOS,
  TEST_SCENARIOS,
  createAISMessage,
  createBoatJourney
};