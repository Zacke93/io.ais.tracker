class ScenarioLogger {
  constructor() {
    this.events = [];
    this.bridgeTextHistory = [];
    this.startTime = Date.now();
  }

  reset() {
    this.events = [];
    this.bridgeTextHistory = [];
    this.startTime = Date.now();
  }

  logEvent(eventType, data) {
    const timestamp = Date.now() - this.startTime;
    this.events.push({
      timestamp,
      type: eventType,
      data: { ...data }
    });
  }

  logBoatUpdate(mmsi, name, position, speed, heading, status) {
    this.logEvent('boat_update', {
      mmsi,
      name,
      position,
      speed,
      heading,
      status
    });
  }

  logBridgeTextChange(oldText, newText, boats) {
    this.logEvent('bridge_text_change', {
      oldText,
      newText,
      boats: boats ? boats.map(b => ({
        mmsi: b.mmsi,
        name: b.name,
        bridge: b.nearBridge,
        targetBridge: b.targetBridge,
        status: b.status,
        eta: b.eta
      })) : []
    });
    this.bridgeTextHistory.push({
      timestamp: Date.now() - this.startTime,
      text: newText
    });
  }

  logFlowTrigger(flowCard, args, state) {
    this.logEvent('flow_trigger', {
      flowCard,
      args,
      state
    });
  }

  logStatusChange(mmsi, name, oldStatus, newStatus, reason) {
    this.logEvent('status_change', {
      mmsi,
      name,
      oldStatus,
      newStatus,
      reason
    });
  }

  logBridgePassage(mmsi, name, bridge, nextBridge) {
    this.logEvent('bridge_passage', {
      mmsi,
      name,
      passedBridge: bridge,
      nextTargetBridge: nextBridge
    });
  }

  logBoatRemoval(mmsi, name, reason, lastPosition) {
    this.logEvent('boat_removal', {
      mmsi,
      name,
      reason,
      lastPosition
    });
  }

  generateScenarioSummary() {
    const summary = {
      duration: Date.now() - this.startTime,
      totalEvents: this.events.length,
      boats: {},
      bridgeTextChanges: this.bridgeTextHistory.length,
      flowTriggers: [],
      scenario: []
    };

    // Analysera händelser och bygg upp scenario
    this.events.forEach(event => {
      const { type, data, timestamp } = event;
      
      if (type === 'boat_update') {
        if (!summary.boats[data.mmsi]) {
          summary.boats[data.mmsi] = {
            name: data.name,
            firstSeen: timestamp,
            lastSeen: timestamp,
            positions: [],
            statuses: [],
            bridges: new Set()
          };
        }
        const boat = summary.boats[data.mmsi];
        boat.lastSeen = timestamp;
        boat.positions.push({ ...data.position, timestamp });
        if (data.status && !boat.statuses.find(s => s.status === data.status)) {
          boat.statuses.push({ status: data.status, timestamp });
        }
        if (data.bridge) {
          boat.bridges.add(data.bridge);
        }
      }
      
      if (type === 'flow_trigger') {
        summary.flowTriggers.push({
          timestamp,
          flowCard: data.flowCard,
          bridge: data.args?.bridge,
          state: data.state
        });
      }
      
      if (type === 'bridge_text_change') {
        summary.scenario.push({
          timestamp,
          type: 'bridge_text',
          description: `Bridge text ändrad: "${data.newText}"`,
          boats: data.boats
        });
      }
      
      if (type === 'status_change') {
        summary.scenario.push({
          timestamp,
          type: 'status',
          description: `${data.name} (${data.mmsi}) status: ${data.oldStatus} → ${data.newStatus} (${data.reason})`
        });
      }
      
      if (type === 'bridge_passage') {
        summary.scenario.push({
          timestamp,
          type: 'passage',
          description: `${data.name} (${data.mmsi}) passerade ${data.passedBridge}, nästa mål: ${data.nextTargetBridge || 'ingen'}`
        });
      }
      
      if (type === 'boat_removal') {
        summary.scenario.push({
          timestamp,
          type: 'removal',
          description: `${data.name} (${data.mmsi}) borttagen: ${data.reason}`
        });
      }
    });

    // Konvertera Set till Array för boats
    Object.keys(summary.boats).forEach(mmsi => {
      summary.boats[mmsi].bridges = Array.from(summary.boats[mmsi].bridges);
    });

    return summary;
  }

  printScenario() {
    const summary = this.generateScenarioSummary();
    
    console.log('\n=== SCENARIO SAMMANFATTNING ===');
    console.log(`Total tid: ${Math.round(summary.duration / 1000)}s`);
    console.log(`Antal händelser: ${summary.totalEvents}`);
    console.log(`Bridge text ändringar: ${summary.bridgeTextChanges}`);
    console.log(`Flow triggers: ${summary.flowTriggers.length}`);
    
    console.log('\n=== BÅTAR ===');
    Object.entries(summary.boats).forEach(([mmsi, boat]) => {
      console.log(`\n${boat.name} (${mmsi}):`);
      console.log(`  Tid i systemet: ${Math.round((boat.lastSeen - boat.firstSeen) / 1000)}s`);
      console.log(`  Broar: ${boat.bridges.join(', ') || 'inga'}`);
      console.log(`  Statusar: ${boat.statuses.map(s => s.status).join(' → ') || 'inga'}`);
    });
    
    console.log('\n=== HÄNDELSEFÖRLOPP ===');
    summary.scenario.forEach(event => {
      const time = Math.round(event.timestamp / 1000);
      console.log(`[${time}s] ${event.description}`);
    });
    
    console.log('\n=== BRIDGE TEXT HISTORIK ===');
    this.bridgeTextHistory.forEach(entry => {
      const time = Math.round(entry.timestamp / 1000);
      console.log(`[${time}s] "${entry.text}"`);
    });
    
    return summary;
  }

  // Hjälpmetoder för assertions
  assertBridgeTextContains(substring, message) {
    const lastText = this.bridgeTextHistory[this.bridgeTextHistory.length - 1]?.text || '';
    if (!lastText.includes(substring)) {
      throw new Error(`${message || 'Bridge text assertion failed'}: Expected to contain "${substring}", got "${lastText}"`);
    }
  }

  assertBridgeTextMatches(regex, message) {
    const lastText = this.bridgeTextHistory[this.bridgeTextHistory.length - 1]?.text || '';
    if (!regex.test(lastText)) {
      throw new Error(`${message || 'Bridge text assertion failed'}: Expected to match ${regex}, got "${lastText}"`);
    }
  }

  assertFlowTriggered(bridge, message) {
    const triggered = this.events.some(e => 
      e.type === 'flow_trigger' && 
      e.data.args?.bridge === bridge
    );
    if (!triggered) {
      throw new Error(`${message || 'Flow trigger assertion failed'}: Expected flow trigger for bridge "${bridge}"`);
    }
  }

  assertBoatStatus(mmsi, expectedStatus, message) {
    const boatEvents = this.events.filter(e => 
      e.type === 'boat_update' && 
      e.data.mmsi === mmsi
    );
    const lastStatus = boatEvents[boatEvents.length - 1]?.data.status;
    if (lastStatus !== expectedStatus) {
      throw new Error(`${message || 'Boat status assertion failed'}: Expected status "${expectedStatus}" for MMSI ${mmsi}, got "${lastStatus}"`);
    }
  }

  getBoatJourney(mmsi) {
    const journey = {
      mmsi,
      events: [],
      bridges: [],
      statuses: []
    };
    
    this.events.forEach(event => {
      if (event.data.mmsi === mmsi) {
        if (event.type === 'boat_update') {
          journey.events.push({
            time: event.timestamp,
            position: event.data.position,
            speed: event.data.speed,
            status: event.data.status
          });
          if (event.data.bridge && !journey.bridges.includes(event.data.bridge)) {
            journey.bridges.push(event.data.bridge);
          }
        }
        if (event.type === 'status_change') {
          journey.statuses.push({
            time: event.timestamp,
            from: event.data.oldStatus,
            to: event.data.newStatus,
            reason: event.data.reason
          });
        }
      }
    });
    
    return journey;
  }
}

module.exports = ScenarioLogger;