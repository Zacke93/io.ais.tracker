'use strict';

const GPSJumpAnalyzer = require('../lib/utils/GPSJumpAnalyzer');

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

/**
 * F64: fysik-grinden i _analyzeLargeMovement krävde >800m, så ett fysiskt
 * omöjligt 500-800m-hopp UTAN kursstöd kunde accepteras (fel position/ETA/bro
 * en tick). Grinden gäller nu från >300m, men bara när det inte finns en tydlig
 * sväng (cogChange null eller <=45°) — legitima U-svängar släpps fortfarande.
 *
 * Geografi: Trollhättan ~58.29°N. 1° lat ≈ 111 km → 0.006° ≈ 666m.
 */
describe('F64: GPS-fysikgrind fångar 500-800m utan kursstöd', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new GPSJumpAnalyzer(makeLogger());
  });

  // Två positioner ~666m isär (0.006° lat) i Trollhättan-området
  const POS_A = { lat: 58.290, lon: 12.290 };
  const POS_B = { lat: 58.296, lon: 12.290 };

  test('666m hopp på 30s med samma kurs (ingen sväng) → GPS-jump', () => {
    const now = Date.now();
    // 666m på 30s = ~43 knop — fysiskt omöjligt för en kanalbåt
    const oldVessel = {
      lat: POS_A.lat, lon: POS_A.lon, sog: 5, cog: 0, timestamp: now - 30000,
    };
    const newVessel = {
      lat: POS_B.lat, lon: POS_B.lon, sog: 5, cog: 0, timestamp: now,
    };

    const r = analyzer.analyzeMovement('1', POS_B, POS_A, newVessel, oldVessel);
    expect(r.isGPSJump).toBe(true);
    expect(r.reason).toBe('physically_impossible_movement');
  });

  test('666m hopp med STOR kursändring (>45°, U-sväng) → INTE GPS-jump', () => {
    const now = Date.now();
    // Samma omöjliga distans men med tydlig sväng → ska INTE flaggas som jump
    const oldVessel = {
      lat: POS_A.lat, lon: POS_A.lon, sog: 8, cog: 10, timestamp: now - 30000,
    };
    const newVessel = {
      lat: POS_B.lat, lon: POS_B.lon, sog: 8, cog: 200, timestamp: now,
    };

    const r = analyzer.analyzeMovement('2', POS_B, POS_A, newVessel, oldVessel);
    expect(r.isGPSJump).toBe(false);
  });

  test('666m hopp över LÅNG tid (realistiskt) → INTE GPS-jump', () => {
    const now = Date.now();
    // 666m på 10 min vid 5 knop är fullt realistiskt (maxRealistic överstiger)
    const oldVessel = {
      lat: POS_A.lat, lon: POS_A.lon, sog: 5, cog: 0, timestamp: now - 600000,
    };
    const newVessel = {
      lat: POS_B.lat, lon: POS_B.lon, sog: 5, cog: 0, timestamp: now,
    };

    const r = analyzer.analyzeMovement('3', POS_B, POS_A, newVessel, oldVessel);
    expect(r.isGPSJump).toBe(false);
  });

  test('normal liten rörelse (<100m) → accepteras (ingen regression)', () => {
    const now = Date.now();
    const near = { lat: POS_A.lat + 0.0005, lon: POS_A.lon }; // ~55m
    const oldVessel = {
      lat: POS_A.lat, lon: POS_A.lon, sog: 5, cog: 0, timestamp: now - 30000,
    };
    const newVessel = {
      lat: near.lat, lon: near.lon, sog: 5, cog: 0, timestamp: now,
    };

    const r = analyzer.analyzeMovement('4', near, POS_A, newVessel, oldVessel);
    expect(r.isGPSJump).toBe(false);
  });
});
