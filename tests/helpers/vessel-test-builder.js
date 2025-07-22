/* eslint-disable max-classes-per-file */

'use strict';

/**
 * VesselTestBuilder - Helper class for creating test vessel data
 * Provides fluent API for building complex vessel scenarios
 */
class VesselTestBuilder {
  constructor() {
    this.reset();
  }

  reset() {
    this._vessel = {
      mmsi: '123456789',
      name: 'Test Vessel',
      lat: 58.284, // Default near Klaffbron
      lon: 12.284,
      sog: 3.5,
      cog: 45,
      status: 'en-route',
      targetBridge: null,
      currentBridge: null,
      isWaiting: false,
      isApproaching: false,
      confidence: 'medium',
      distance: 200,
      distanceToCurrent: 200,
      etaMinutes: null,
      passedBridges: [],
      lastPassedBridgeTime: null,
      timestamp: Date.now(),
    };
    return this;
  }

  // Basic vessel properties
  withMMSI(mmsi) {
    this._vessel.mmsi = mmsi;
    return this;
  }

  withName(name) {
    this._vessel.name = name;
    return this;
  }

  withPosition(lat, lon) {
    this._vessel.lat = lat;
    this._vessel.lon = lon;
    return this;
  }

  withSpeed(sog) {
    this._vessel.sog = sog;
    return this;
  }

  withCourse(cog) {
    this._vessel.cog = cog;
    return this;
  }

  // Bridge-related properties
  withTargetBridge(bridgeName) {
    this._vessel.targetBridge = bridgeName;
    return this;
  }

  withCurrentBridge(bridgeName) {
    this._vessel.currentBridge = bridgeName;
    return this;
  }

  withDistance(distance) {
    this._vessel.distance = distance;
    this._vessel.distanceToCurrent = distance;
    return this;
  }

  // Status methods
  approaching(etaMinutes = null) {
    this._vessel.status = 'approaching';
    this._vessel.isApproaching = true;
    this._vessel.isWaiting = false;
    if (etaMinutes !== null) {
      this._vessel.etaMinutes = etaMinutes;
    }
    return this;
  }

  waiting() {
    this._vessel.status = 'waiting';
    this._vessel.isWaiting = true;
    this._vessel.isApproaching = false;
    this._vessel.etaMinutes = null;
    this._vessel.sog = 0.1; // Very slow
    return this;
  }

  underBridge() {
    this._vessel.status = 'under-bridge';
    this._vessel.isWaiting = false;
    this._vessel.isApproaching = false;
    this._vessel.distance = 25; // Very close
    this._vessel.distanceToCurrent = 25;
    this._vessel.etaMinutes = null;
    if (this._vessel.targetBridge) {
      this._vessel.currentBridge = this._vessel.targetBridge;
    }
    return this;
  }

  passed(bridgeName = null, minutesAgo = 1) {
    this._vessel.status = 'passed';
    this._vessel.isWaiting = false;
    this._vessel.isApproaching = false;

    if (bridgeName) {
      this._vessel.passedBridges = [...(this._vessel.passedBridges || []), bridgeName];
      this._vessel.lastPassedBridgeTime = Date.now() - (minutesAgo * 60 * 1000);
    }
    return this;
  }

  enRoute() {
    this._vessel.status = 'en-route';
    this._vessel.isWaiting = false;
    this._vessel.isApproaching = false;
    return this;
  }

  // Convenience methods for common scenarios
  nearKlaffbron(distance = 150) {
    return this.withPosition(58.284, 12.284)
      .withTargetBridge('Klaffbron')
      .withDistance(distance);
  }

  nearStridsbergsbron(distance = 150) {
    return this.withPosition(58.294, 12.295)
      .withTargetBridge('Stridsbergsbron')
      .withDistance(distance);
  }

  stationary() {
    return this.withSpeed(0);
  }

  fastMoving(speed = 8.0) {
    return this.withSpeed(speed);
  }

  northbound() {
    return this.withCourse(0); // North
  }

  southbound() {
    return this.withCourse(180); // South
  }

  // Multiple vessel creation
  static createFleet(count, baseBuilder = null) {
    const fleet = [];
    const builder = baseBuilder || new VesselTestBuilder();

    for (let i = 0; i < count; i++) {
      const vessel = builder.withMMSI(`${(i + 1).toString().padStart(9, '0')}`).build();
      fleet.push(vessel);
      builder.reset();
    }

    return fleet;
  }

  // Build the final vessel object
  build() {
    // Validate and set defaults based on status
    if (this._vessel.status === 'under-bridge' && !this._vessel.currentBridge && this._vessel.targetBridge) {
      this._vessel.currentBridge = this._vessel.targetBridge;
    }

    // Deep clone to prevent mutation
    return JSON.parse(JSON.stringify(this._vessel));
  }

  // Create a new builder with the same configuration
  clone() {
    const newBuilder = new VesselTestBuilder();
    newBuilder._vessel = JSON.parse(JSON.stringify(this._vessel));
    return newBuilder;
  }
}

// Pre-configured builders for common scenarios
class VesselScenarios {
  static singleApproachingKlaff(etaMinutes = 5) {
    return new VesselTestBuilder()
      .nearKlaffbron(200)
      .approaching(etaMinutes)
      .build();
  }

  static singleWaitingKlaff() {
    return new VesselTestBuilder()
      .nearKlaffbron(80)
      .waiting()
      .build();
  }

  static singleUnderKlaff() {
    return new VesselTestBuilder()
      .nearKlaffbron(25)
      .underBridge()
      .build();
  }

  static multipleAtKlaff(count = 3) {
    return VesselTestBuilder.createFleet(count,
      new VesselTestBuilder()
        .nearKlaffbron(150)
        .approaching(Math.floor(Math.random() * 10) + 2));
  }

  static bothBridgesActive() {
    return [
      new VesselTestBuilder().nearKlaffbron(180).approaching(4).withMMSI('111111111')
        .build(),
      new VesselTestBuilder().nearStridsbergsbron(120).waiting().withMMSI('222222222')
        .build(),
    ];
  }

  static recentlyPassedScenario() {
    return [
      new VesselTestBuilder()
        .nearStridsbergsbron(200)
        .approaching(6)
        .withMMSI('111111111')
        .build(),
      new VesselTestBuilder()
        .nearKlaffbron(300)
        .passed('Klaffbron', 1) // 1 minute ago
        .withMMSI('222222222')
        .build(),
    ];
  }

  static complexMultiBridge() {
    return [
      // Under bridge at Klaff (highest priority)
      new VesselTestBuilder().nearKlaffbron(25).underBridge().withMMSI('111111111')
        .build(),
      // Waiting at Klaff
      new VesselTestBuilder().nearKlaffbron(90).waiting().withMMSI('222222222')
        .build(),
      // Approaching Klaff
      new VesselTestBuilder().nearKlaffbron(250).approaching(7).withMMSI('333333333')
        .build(),
      // Waiting at Stridsberg
      new VesselTestBuilder().nearStridsbergsbron(75).waiting().withMMSI('444444444')
        .build(),
      // Approaching Stridsberg
      new VesselTestBuilder().nearStridsbergsbron(280).approaching(12).withMMSI('555555555')
        .build(),
    ];
  }
}

module.exports = {
  VesselTestBuilder,
  VesselScenarios,
};
