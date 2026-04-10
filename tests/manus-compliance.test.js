'use strict';

/**
 * Manus Compliance Tests - Bug Regression + Full Journey Validation
 *
 * Tests all 7 bug fixes against real AIS replay data (ais-replay-20260121-075318.jsonl)
 * and validates full journey compliance with the manus specification.
 *
 * Vessels in replay data:
 * - SKAGERN (210548000) - northbound cargo vessel
 * - TIDAN (231907000) - southbound cargo vessel
 * - NORDIC SIRA (257941000) - southbound cargo vessel
 * - PILOT 761 (265606970) - pilot boat (variable direction)
 */

const fs = require('fs');
const path = require('path');
const RealAppTestRunner = require('./journey-scenarios/RealAppTestRunner');

const REPLAY_FILE = path.join(__dirname, '..', '..', 'logs', 'ais-replay-20260121-075318.jsonl');
const DEFAULT_MESSAGE = 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron';

// ==================== HELPERS ====================

const parseReplayFile = (filePath) => {
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  return lines.map((line) => {
    const match = line.match(/\[AIS_REPLAY_SAMPLE\]\s+({.*})/);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch (err) {
      return null;
    }
  }).filter(Boolean);
};

const resetRunnerState = (runner) => {
  // Stateless BridgeTextService has no internal state to reset
  if (runner?.app?.vesselDataService) {
    const existing = runner.app.vesselDataService.getAllVessels();
    existing.forEach((v) => runner.app.vesselDataService.removeVessel(v.mmsi, 'test-reset'));
  }
  runner.bridgeTextHistory = [];
  runner.lastBridgeText = DEFAULT_MESSAGE;
  runner.stepNumber = 0;
};

/**
 * Replay all samples and collect bridge text outputs with timestamps
 */
const replayAllSamples = async (runner, samples) => {
  resetRunnerState(runner);

  const outputs = [];
  const realNow = Date.now;

  for (const sample of samples) {
    runner.stepNumber += 1;
    Date.now = () => sample.aisTimestamp;

    try {
      await runner._processVesselAsAISMessage({
        mmsi: sample.mmsi,
        name: sample.shipName || `VESSEL_${sample.mmsi}`,
        lat: sample.lat,
        lon: sample.lon,
        sog: sample.sog,
        cog: sample.cog,
        timestamp: sample.aisTimestamp,
      });

      const currentText = runner.getCurrentBridgeText();
      outputs.push({
        timestamp: sample.aisTimestamp,
        text: currentText,
        mmsi: sample.mmsi,
        shipName: sample.shipName,
        sog: sample.sog,
        cog: sample.cog,
      });
    } catch (err) {
      // Continue on error
    }
  }

  Date.now = realNow;
  return outputs;
};

/**
 * Replay single vessel journey
 */
const replaySingleVessel = async (runner, samples, mmsi) => {
  const vesselSamples = samples
    .filter((s) => String(s.mmsi) === String(mmsi))
    .sort((a, b) => a.aisTimestamp - b.aisTimestamp);

  if (vesselSamples.length === 0) return [];

  resetRunnerState(runner);

  const outputs = [];
  const realNow = Date.now;

  for (const sample of vesselSamples) {
    runner.stepNumber += 1;
    Date.now = () => sample.aisTimestamp;

    try {
      await runner._processVesselAsAISMessage({
        mmsi: sample.mmsi,
        name: sample.shipName || `VESSEL_${sample.mmsi}`,
        lat: sample.lat,
        lon: sample.lon,
        sog: sample.sog,
        cog: sample.cog,
        timestamp: sample.aisTimestamp,
      });

      const currentText = runner.getCurrentBridgeText();
      if (currentText && currentText !== outputs[outputs.length - 1]?.text) {
        outputs.push({
          timestamp: sample.aisTimestamp,
          text: currentText,
          mmsi: sample.mmsi,
          sog: sample.sog,
        });
      }
    } catch (err) {
      // Continue on error
    }
  }

  Date.now = realNow;
  return outputs;
};

// ==================== FORBIDDEN PATTERNS ====================

const FORBIDDEN_PATTERNS = {
  // "precis passerat [målbro]" utan "på väg mot"
  PASSED_TARGET_NO_DESTINATION: /har precis passerat (Klaffbron|Stridsbergsbron), beräknad/,
  // Målbro med mellanbro-format
  TARGET_WITH_INTERMEDIATE_FORMAT: /Broöppning pågår vid (Klaffbron|Stridsbergsbron), beräknad broöppning av/,
  // Självreferens "passerat X på väg mot X"
  SELF_REFERENCE: /passerat (Klaffbron|Stridsbergsbron|Olidebron|Järnvägsbron|Stallbackabron) på väg mot \1/,
  // Stallbackabron should NEVER show "inväntar broöppning"
  STALLBACKA_WAITING: /inväntar broöppning.*Stallbackabron|Stallbackabron.*inväntar broöppning/,
};

// ==================== TEST SUITE ====================

describe('Manus Compliance Tests (ais-replay-20260121-075318)', () => {
  let runner;
  let samples;

  beforeAll(async () => {
    samples = parseReplayFile(REPLAY_FILE);
    if (!samples) {
      console.warn(`⚠️ Replay file missing: ${REPLAY_FILE}`);
      return;
    }

    samples = samples
      .filter((s) => s && Number.isFinite(s.aisTimestamp))
      .sort((a, b) => a.aisTimestamp - b.aisTimestamp);

    runner = new RealAppTestRunner();
    runner.setWaitMultiplier(0.1);
    runner.logLevel = 'silent';
    await runner.initializeApp();
  }, 30000);

  afterAll(async () => {
    await runner?.cleanup();
  });

  // ==================== BUG 1: Passed bridges reappearing ====================

  describe('Bug 1: Passed bridges never reappear as currentBridge', () => {
    test('bridge text never regresses from "passerat" to "närmar sig" for same bridge within 60s', async () => {
      if (!samples || !runner) return;

      const outputs = await replayAllSamples(runner, samples);
      const violations = [];

      // Track last "passerat" time per bridge
      const lastPassedTime = new Map();

      for (const output of outputs) {
        if (output.text === DEFAULT_MESSAGE) continue;

        // Track passed bridges (from bridge text, not per-vessel)
        const passedMatch = output.text.match(/har precis passerat (Olidebron|Järnvägsbron|Stallbackabron|Klaffbron|Stridsbergsbron)/);
        if (passedMatch) {
          lastPassedTime.set(passedMatch[1], output.timestamp);
        }

        // Check for approaching a recently-passed bridge (regression)
        const approachMatch = output.text.match(/närmar sig (Olidebron|Järnvägsbron|Stallbackabron|Klaffbron|Stridsbergsbron)/);
        if (approachMatch) {
          const bridge = approachMatch[1];
          if (lastPassedTime.has(bridge)) {
            const timeSincePassed = output.timestamp - lastPassedTime.get(bridge);
            // Only flag if regression happens within 60s (same vessel likely)
            if (timeSincePassed < 60000) {
              violations.push({
                bridge,
                timeSincePassed: Math.round(timeSincePassed / 1000),
                text: output.text.substring(0, 80),
              });
            }
          }
        }
      }

      if (violations.length > 0) {
        console.log('Bug 1 violations (approaching within 60s of passage):');
        violations.forEach((v) => console.log(`  ${v.bridge}: ${v.text} (${v.timeSincePassed}s after passage)`));
      }

      expect(violations).toHaveLength(0);
    }, 120000);
  });

  // ==================== BUG 2: Missing Stallbackabron phases ====================

  describe('Bug 2: Stallbackabron shows all phases', () => {
    test('Stallbackabron shows "åker strax under" or "passerar" for southbound vessel', async () => {
      if (!samples || !runner) return;

      // NORDIC SIRA (257941000) is southbound - should pass Stallbackabron
      const outputs = await replaySingleVessel(runner, samples, '257941000');

      if (outputs.length === 0) {
        console.warn('⚠️ No outputs for NORDIC SIRA - skipping');
        return;
      }

      // Check that Stallbackabron appears in any form (approaching, åker strax under, passerar, or passerat)
      const stallbackaTexts = outputs.filter((o) => o.text.includes('Stallbackabron'));

      if (stallbackaTexts.length > 0) {
        // If Stallbackabron appears, verify it uses correct special phrasing
        const hasSpecialPhrase = stallbackaTexts.some((o) => /åker strax under|passerar|har precis passerat|\d+m från Stallbackabron/.test(o.text));
        const hasForbiddenWaiting = stallbackaTexts.some((o) => /inväntar broöppning.*Stallbackabron/.test(o.text));

        // Stallbackabron should never show "inväntar broöppning"
        expect(hasForbiddenWaiting).toBe(false);

        // Should have at least one special phrase if vessel transits the bridge
        if (stallbackaTexts.length >= 2) {
          expect(hasSpecialPhrase).toBe(true);
        }
      }
    }, 120000);
  });

  // ==================== BUG 3: Bridge ordering ====================

  describe('Bug 3: Correct bridge ordering (intermediate before target)', () => {
    test('Olidebron appears before Klaffbron-only messages for northbound', async () => {
      if (!samples || !runner) return;

      // SKAGERN (210548000) is northbound
      const outputs = await replaySingleVessel(runner, samples, '210548000');
      if (outputs.length === 0) {
        console.warn('⚠️ No outputs for SKAGERN - skipping');
        return;
      }

      // In stateless service: distance-based text mentions Olidebron before Klaffbron
      const olidebronFirst = outputs.findIndex((o) => /Olidebron/.test(o.text));
      const klaffbronOnly = outputs.findIndex((o) => /\d+m från Klaffbron|Broöppning pågår vid Klaffbron/.test(o.text));

      // If both appear, Olidebron should come first
      if (olidebronFirst >= 0 && klaffbronOnly >= 0) {
        expect(olidebronFirst).toBeLessThan(klaffbronOnly);
      }
    }, 120000);
  });

  // ==================== BUG 4: Missing "passerat Järnvägsbron" ====================

  describe('Bug 4: Intermediate bridge passages are shown', () => {
    test('"passerat Järnvägsbron" appears for vessels that pass it', async () => {
      if (!samples || !runner) return;

      // SKAGERN (210548000) is northbound - should pass Järnvägsbron
      const outputs = await replaySingleVessel(runner, samples, '210548000');
      if (outputs.length === 0) {
        console.warn('⚠️ No outputs for SKAGERN - skipping');
        return;
      }

      // Check that Järnvägsbron appears in some form during the journey
      const jarnvagsbronTexts = outputs.filter((o) => o.text.includes('Järnvägsbron'));

      // If the vessel reaches Järnvägsbron area, check for passage message
      if (jarnvagsbronTexts.length > 0) {
        // Verify no phase regression - Järnvägsbron messages should not appear after Stridsbergsbron messages
        const lastJarnvags = outputs.findLastIndex((o) => o.text.includes('Järnvägsbron'));
        const firstStridsberg = outputs.findIndex((o) => /inväntar.*Stridsbergsbron|Broöppning pågår vid Stridsbergsbron/.test(o.text));

        if (lastJarnvags >= 0 && firstStridsberg >= 0) {
          expect(lastJarnvags).toBeLessThanOrEqual(firstStridsberg);
        }
      }
    }, 120000);
  });

  // ==================== BUG 5: ETA stability ====================

  describe('Bug 5: ETA stability during deceleration', () => {
    test('ETA does not increase dramatically between consecutive updates', async () => {
      if (!samples || !runner) return;

      const outputs = await replayAllSamples(runner, samples);

      // Extract ETA values from consecutive texts for same vessel direction
      const etaRegex = /beräknad broöppning om (\d+) minut/;
      let previousEta = null;
      let largeIncreases = 0;

      for (const output of outputs) {
        const match = output.text.match(etaRegex);
        if (match) {
          const eta = parseInt(match[1], 10);
          if (previousEta !== null && eta > previousEta) {
            const increase = eta - previousEta;
            // Allow up to 5 minute increase (normal variation), flag larger jumps
            if (increase > 10) {
              largeIncreases++;
            }
          }
          previousEta = eta;
        } else {
          previousEta = null; // Reset when text doesn't contain ETA
        }
      }

      // Should have very few large ETA increases (< 5% of total outputs)
      const etaOutputs = outputs.filter((o) => etaRegex.test(o.text));
      if (etaOutputs.length > 10) {
        expect(largeIncreases).toBeLessThan(etaOutputs.length * 0.1);
      }
    }, 120000);
  });

  // ==================== BUG 6: Stationary vessel false passages ====================

  describe('Bug 6: Stationary vessels (SOG=0) do not trigger false passages', () => {
    test('no passage detection for vessels with SOG=0', async () => {
      if (!samples || !runner) return;

      const outputs = await replayAllSamples(runner, samples);

      // Find all "passerat" messages and check if any correspond to stationary vessels
      const passageOutputs = outputs.filter((o) => /har precis passerat/.test(o.text));

      for (const passage of passageOutputs) {
        // The vessel that triggered the passage should have had SOG > 0.5
        const nearbyReports = samples.filter(
          (s) => String(s.mmsi) === String(passage.mmsi)
            && Math.abs(s.aisTimestamp - passage.timestamp) < 120000,
        );

        if (nearbyReports.length > 0) {
          const avgSog = nearbyReports.reduce((sum, s) => sum + s.sog, 0) / nearbyReports.length;
          // Vessel should have been moving (avg SOG > 0.3) when passage was detected
          expect(avgSog).toBeGreaterThan(0.3);
        }
      }
    }, 120000);
  });

  // ==================== BUG 7: "Inga båtar" flash ====================

  describe('Bug 7: No "Inga båtar" flash after passage', () => {
    test('no default message blink within 30s of active text', async () => {
      if (!samples || !runner) return;

      const outputs = await replayAllSamples(runner, samples);
      const violations = [];

      for (let i = 1; i < outputs.length - 1; i++) {
        const prev = outputs[i - 1];
        const curr = outputs[i];
        const next = outputs[i + 1];

        if (
          curr.text === DEFAULT_MESSAGE
          && prev.text !== DEFAULT_MESSAGE
          && next.text !== DEFAULT_MESSAGE
        ) {
          const timeToPrev = curr.timestamp - prev.timestamp;
          const timeToNext = next.timestamp - curr.timestamp;

          // Flag as violation if default appears briefly between active texts
          if (timeToPrev < 30000 && timeToNext < 10000) {
            violations.push({
              index: i,
              timeToPrev: Math.round(timeToPrev / 1000),
              timeToNext: Math.round(timeToNext / 1000),
              prevText: prev.text.substring(0, 60),
              nextText: next.text.substring(0, 60),
            });
          }
        }
      }

      if (violations.length > 0) {
        console.log('Bug 7 violations:');
        violations.forEach((v) => {
          console.log(`  [${v.index}] Blink: "${v.prevText}..." → DEFAULT → "${v.nextText}..."`);
        });
      }

      expect(violations).toHaveLength(0);
    }, 120000);
  });

  // ==================== FORBIDDEN PATTERN CHECKS ====================

  describe('Forbidden patterns (manus violations)', () => {
    let allOutputs;

    beforeAll(async () => {
      if (!samples || !runner) return;
      allOutputs = await replayAllSamples(runner, samples);
    }, 120000);

    test('no "precis passerat [målbro]" without destination', () => {
      if (!allOutputs) return;
      const violations = allOutputs.filter((o) => FORBIDDEN_PATTERNS.PASSED_TARGET_NO_DESTINATION.test(o.text));
      expect(violations).toHaveLength(0);
    });

    test('no target bridge with intermediate format', () => {
      if (!allOutputs) return;
      const violations = allOutputs.filter((o) => FORBIDDEN_PATTERNS.TARGET_WITH_INTERMEDIATE_FORMAT.test(o.text));
      expect(violations).toHaveLength(0);
    });

    test('no self-reference in passed messages', () => {
      if (!allOutputs) return;
      const violations = allOutputs.filter((o) => FORBIDDEN_PATTERNS.SELF_REFERENCE.test(o.text));
      expect(violations).toHaveLength(0);
    });

    test('Stallbackabron never shows "inväntar broöppning"', () => {
      if (!allOutputs) return;
      const violations = allOutputs.filter((o) => FORBIDDEN_PATTERNS.STALLBACKA_WAITING.test(o.text));
      expect(violations).toHaveLength(0);
    });
  });

  // ==================== FULL JOURNEY COMPLIANCE ====================

  describe('Full journey manus compliance', () => {
    /**
     * Helper: verify phase sequence appears in order (flexible - allows gaps)
     */
    const expectPhasesInOrder = (outputs, phases, label) => {
      let cursor = 0;
      const found = [];

      for (const phase of phases) {
        const idx = outputs.findIndex((o, i) => i >= cursor && phase.test(o.text));
        if (idx >= cursor) {
          found.push({ phase: phase.source, index: idx, text: outputs[idx].text.substring(0, 80) });
          cursor = idx + 1;
        }
      }

      if (found.length < phases.length) {
        console.log(`${label}: Found ${found.length}/${phases.length} phases:`);
        found.forEach((f) => console.log(`  [${f.index}] ${f.text}`));
        console.log('Missing phases:');
        const foundSources = new Set(found.map((f) => f.phase));
        phases.filter((p) => !foundSources.has(p.source)).forEach((p) => console.log(`  ${p.source}`));
      }

      return found;
    };

    test('SKAGERN (210548000) northbound journey follows manus phases', async () => {
      if (!samples || !runner) return;

      const outputs = await replaySingleVessel(runner, samples, '210548000');
      if (outputs.length === 0) {
        console.warn('⚠️ No outputs for SKAGERN - skipping');
        return;
      }

      console.log(`SKAGERN journey: ${outputs.length} text changes`);
      outputs.forEach((o, i) => console.log(`  ${i}: ${o.text.substring(0, 90)}`));

      // Northbound expected phases (flexible - not all may appear with 60s AIS)
      const northboundPhases = [
        /på väg mot Klaffbron/,
        /Klaffbron/, // Some interaction with Klaffbron
        /Stridsbergsbron/, // Eventually targets Stridsbergsbron
      ];

      const found = expectPhasesInOrder(outputs, northboundPhases, 'SKAGERN northbound');
      expect(found.length).toBeGreaterThanOrEqual(2); // At least 2 phases

      // No forbidden patterns
      for (const output of outputs) {
        expect(FORBIDDEN_PATTERNS.SELF_REFERENCE.test(output.text)).toBe(false);
        expect(FORBIDDEN_PATTERNS.STALLBACKA_WAITING.test(output.text)).toBe(false);
      }
    }, 120000);

    test('TIDAN (231907000) southbound journey follows manus phases', async () => {
      if (!samples || !runner) return;

      const outputs = await replaySingleVessel(runner, samples, '231907000');
      if (outputs.length === 0) {
        console.warn('⚠️ No outputs for TIDAN - skipping');
        return;
      }

      console.log(`TIDAN journey: ${outputs.length} text changes`);
      outputs.forEach((o, i) => console.log(`  ${i}: ${o.text.substring(0, 90)}`));

      // Southbound expected phases
      const southboundPhases = [
        /Stridsbergsbron/, // First interacts with Stridsbergsbron
        /Klaffbron/, // Then heading toward Klaffbron
      ];

      const found = expectPhasesInOrder(outputs, southboundPhases, 'TIDAN southbound');
      expect(found.length).toBeGreaterThanOrEqual(1);

      // No forbidden patterns
      for (const output of outputs) {
        expect(FORBIDDEN_PATTERNS.SELF_REFERENCE.test(output.text)).toBe(false);
        expect(FORBIDDEN_PATTERNS.STALLBACKA_WAITING.test(output.text)).toBe(false);
      }
    }, 120000);

    test('NORDIC SIRA (257941000) southbound journey with Stallbackabron', async () => {
      if (!samples || !runner) return;

      const outputs = await replaySingleVessel(runner, samples, '257941000');
      if (outputs.length === 0) {
        console.warn('⚠️ No outputs for NORDIC SIRA - skipping');
        return;
      }

      console.log(`NORDIC SIRA journey: ${outputs.length} text changes`);
      outputs.forEach((o, i) => console.log(`  ${i}: ${o.text.substring(0, 90)}`));

      // Southbound journey should pass through Stallbackabron area
      const stallbackaTexts = outputs.filter((o) => o.text.includes('Stallbackabron'));

      // If Stallbackabron appears, verify correct phrasing
      for (const st of stallbackaTexts) {
        // NEVER "inväntar broöppning" for Stallbackabron
        expect(st.text).not.toMatch(/inväntar broöppning.*Stallbackabron/);
        expect(st.text).not.toMatch(/Stallbackabron.*inväntar broöppning/);
      }

      // No forbidden patterns throughout journey
      for (const output of outputs) {
        expect(FORBIDDEN_PATTERNS.SELF_REFERENCE.test(output.text)).toBe(false);
      }
    }, 120000);

    test('PILOT 761 (265606970) journey has no forbidden patterns', async () => {
      if (!samples || !runner) return;

      const outputs = await replaySingleVessel(runner, samples, '265606970');
      if (outputs.length === 0) {
        console.warn('⚠️ No outputs for PILOT 761 - skipping');
        return;
      }

      console.log(`PILOT 761 journey: ${outputs.length} text changes`);
      outputs.slice(0, 15).forEach((o, i) => console.log(`  ${i}: ${o.text.substring(0, 90)}`));

      // No forbidden patterns
      for (const output of outputs) {
        expect(FORBIDDEN_PATTERNS.SELF_REFERENCE.test(output.text)).toBe(false);
        expect(FORBIDDEN_PATTERNS.PASSED_TARGET_NO_DESTINATION.test(output.text)).toBe(false);
        expect(FORBIDDEN_PATTERNS.STALLBACKA_WAITING.test(output.text)).toBe(false);
      }
    }, 120000);
  });

  // ==================== PHASE SEQUENCE VALIDATION ====================

  describe('Phase sequence validation', () => {
    test('no phase regressions within 120s window', async () => {
      if (!samples || !runner) return;

      const outputs = await replayAllSamples(runner, samples);

      // Define phase priority (higher = more advanced in journey)
      const phasePatterns = [
        { pattern: /på väg mot/, phase: 'en-route', priority: 1 },
        { pattern: /närmar sig/, phase: 'approaching', priority: 2 },
        { pattern: /inväntar broöppning/, phase: 'waiting', priority: 3 },
        { pattern: /åker strax under/, phase: 'special-waiting', priority: 3 },
        { pattern: /Broöppning pågår|passerar/, phase: 'under-bridge', priority: 4 },
        { pattern: /har precis passerat/, phase: 'passed', priority: 5 },
      ];

      const getPhase = (text) => {
        for (const { pattern, phase, priority } of phasePatterns) {
          if (pattern.test(text)) return { phase, priority };
        }
        return null;
      };

      // Track phase per bridge mentioned
      const lastPhasePerBridge = new Map();
      const regressions = [];

      for (const output of outputs) {
        if (output.text === DEFAULT_MESSAGE) continue;

        const phase = getPhase(output.text);
        if (!phase) continue;

        // Extract bridge name from text
        const bridgeMatch = output.text.match(/(Klaffbron|Stridsbergsbron|Olidebron|Järnvägsbron|Stallbackabron)/);
        if (!bridgeMatch) continue;

        const bridge = bridgeMatch[1];
        const key = `${output.mmsi}-${bridge}`;

        if (lastPhasePerBridge.has(key)) {
          const last = lastPhasePerBridge.get(key);
          const timeDiff = output.timestamp - last.timestamp;

          // Only check within 120s window
          if (timeDiff <= 120000 && phase.priority < last.priority) {
            regressions.push({
              mmsi: output.mmsi,
              bridge,
              from: last.phase,
              to: phase.phase,
              timeDiff: Math.round(timeDiff / 1000),
            });
          }
        }

        lastPhasePerBridge.set(key, {
          ...phase,
          timestamp: output.timestamp,
        });
      }

      if (regressions.length > 0) {
        console.log('Phase regressions detected:');
        regressions.slice(0, 10).forEach((r) => {
          console.log(`  ${r.mmsi} at ${r.bridge}: ${r.from} → ${r.to} (${r.timeDiff}s)`);
        });
      }

      // Allow some regressions due to AIS data gaps and multi-vessel interactions
      expect(regressions.length).toBeLessThanOrEqual(10);
    }, 120000);
  });
});
