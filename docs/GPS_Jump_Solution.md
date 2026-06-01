# GPS Jump Solution - AIS Tracker App

## Problem Analysis

The AIS Tracker app was experiencing status flickering when boats made legitimate direction changes that involved large coordinate movements (>500m). The system interpreted these as "GPS jumps" and accepted the positions but couldn't distinguish between:

1. **Real GPS errors** - Spurious coordinate jumps due to poor GPS reception
2. **Legitimate large movements** - U-turns, direction changes, or rapid maneuvering

This caused vessels like boat 257941000 to flicker between statuses like "approaching", "under-bridge", and "en-route" when making turns.

## Root Cause

The original GPS jump detection only looked at **distance moved** without considering:
- Course Over Ground (COG) changes indicating direction changes
- Speed Over Ground (SOG) consistency with movement
- Bearing consistency between movement and reported COG
- Movement pattern analysis

## Solution Architecture

### 1. GPSJumpAnalyzer (NEW)
**File:** `/lib/utils/GPSJumpAnalyzer.js`

Sophisticated analysis engine that evaluates multiple factors:

#### Analysis Factors:
- **COG Change Detection**: Large COG changes (>90°) indicate U-turns/direction changes
- **Bearing Consistency**: Compares actual movement bearing with reported COG
- **Speed Consistency**: Validates if movement distance matches reported SOG over time elapsed
- **Movement Pattern Analysis**: Considers recent vessel behavior

#### Decision Logic (`_analyzeLargeMovement`, movements > 500m):
```javascript
// 1. Deterministic physics gate (F64): catches physically-impossible jumps
//    even in the 300-800m range, but ONLY when there is no clear turn.
if (movementDistance > maxRealisticDistance && movementDistance > 300
    && (cogChange === null || cogChange <= 45)) → "gps_jump_detected"

// 2. Clear turn (cogChange > 45°) with some legitimacy → accept as maneuver
// 3. Otherwise fall through to the legitimacy score:
legitimacyScore = (cogChangeScore + bearingConsistencyScore + speedConsistencyScore) / factors

if (score >= 0.7) → "accept" (legitimate_direction_change)
if (score >= 0.4) → "accept_with_caution" (uncertain_movement)
if (score < 0.4)  → "gps_jump_detected" (likely_gps_error)
```

**F64 (2026-06):** the physics gate previously required > 800m, so a physically-impossible 500–800m jump without a supporting course change could slip through to the legitimacy score and be accepted, injecting a wrong position/ETA/bridge for one tick. The gate now applies from > 300m but only when there is no clear turn (`cogChange` null or ≤ 45°), so legitimate U-turns still fall through to the maneuver/legitimacy branches.

#### Actions:
- **accept**: Normal processing, large movement is legitimate
- **accept_with_caution**: Accept position but mark as uncertain for status stability
- **gps_jump_detected**: Real GPS error detected, apply filtering/smoothing

### 2. StatusStabilizer (NEW) 
**File:** `/lib/services/StatusStabilizer.js`

Prevents status flickering through multiple stabilization techniques:

#### Stabilization Methods:

1. **GPS Jump Stabilization**: 
   - Maintains previous status for 30 seconds after detected GPS jump
   - Prevents rapid status changes during GPS errors

2. **Uncertain Position Stabilization**:
   - Requires 2+ consistent readings before changing status
   - Prevents single uncertain positions from changing state

3. **Flickering Detection & Damping**:
   - Detects rapid back-and-forth status changes
   - Uses most common recent status instead of latest proposal

4. **Confidence-Based Filtering**:
   - Reduces confidence for GPS jumps and uncertain positions
   - Lower confidence = more stabilization applied

### 3. Enhanced VesselDataService
**Updated:** `/lib/services/VesselDataService.js`

#### Changes:
- Integrated GPSJumpAnalyzer into position processing
- Stores analysis results in vessel object for StatusService access
- Enhanced position validation with sophisticated analysis

```javascript
// OLD: Simple distance threshold
if (movementDistance > 500) {
  logger.error("GPS_JUMP detected"); // Log only
  return currentPosition; // Accept anyway
}

// NEW: Sophisticated analysis
const analysis = this.gpsJumpAnalyzer.analyzeMovement(...);
switch (analysis.action) {
  case 'gps_jump_detected': 
    // Apply filtering/smoothing
  case 'accept_with_caution':
    // Mark for status stabilization
  case 'accept':
    // Normal processing
}
```

### 4. Enhanced StatusService
**Updated:** `/lib/services/StatusService.js`

#### Changes:
- Accepts position analysis data from VesselDataService
- Integrates StatusStabilizer for uncertainty handling
- Applies stabilization when GPS jumps or uncertain positions detected

```javascript
// NEW: Status stabilization integration
if (positionAnalysis?.gpsJumpDetected || positionAnalysis?.positionUncertain) {
  const stabilizedResult = this.statusStabilizer.stabilizeStatus(...);
  if (stabilizedResult.stabilized) {
    result.status = stabilizedResult.status; // Use stabilized status
  }
}
```

## How It Solves the Problem

### For Boat 257941000 GPS Jump Scenario:

**Jumps:** 763m, 1033m, 646m with COG changes

#### Analysis Results:
1. **Jump 1 (763m)**: COG change 200°→30° = 170° change
   - **Action**: `accept` (legitimate_direction_change)
   - **Reason**: Large COG change indicates U-turn

2. **Jump 2 (1033m)**: Continuing same direction
   - **Action**: `accept_with_caution` (if bearing/speed inconsistent)
   - **Status**: Marked uncertain, requires consistency

3. **Jump 3 (646m)**: Another direction change
   - **Action**: `accept` (if COG analysis supports it)
   - **Status**: Normal processing if legitimate

#### Status Stability:
- If any jumps marked as GPS errors → 30s status stabilization
- If marked uncertain → require 2+ consistent readings
- No more flickering between "approaching"/"under"/"en-route"

## Configuration

### Constants (in `/lib/constants.js`):
```javascript
MOVEMENT_DETECTION: {
  MINIMUM_MOVEMENT: 5,      // meters - smallest movement that counts
  GPS_JUMP_THRESHOLD: 500,  // meters - large-movement analysis kicks in above this
}
```

### Stabilization Parameters (`StatusStabilizer.js`, STABILIZER_CONSTANTS):
```javascript
GPS_STABILIZATION_DURATION_MS = 30 * 1000; // 30s — hold status after a GPS jump
CONSISTENCY_REQUIREMENT = 2;               // readings needed to change status when uncertain
```

### System-wide coordination (`SystemCoordinator.js`, config):
```javascript
gpsEventCooldownMs        = 5000;   // 5s — quiet window before decaying the instability counter
maxConcurrentGPSEvents    = 3;      // threshold for system-wide coordination
bridgeTextDebounceMs      = 2000;   // 2s — bridge-text debounce during coordination
```
Decay is driven by `lastJumpTime` (time since the last *actual* jump), so system-wide coordination always releases after a calm period (F10) — it can no longer stick permanently.

## Testing

### Test Coverage (current files):
- `tests/gps-physics-gate.test.js` — F64 physics gate (impossible 500–800m jumps vs legitimate U-turns)
- `tests/gps-jump-movement-distance.test.js` — `movementDistance` propagation into latch/gate/route-clearing
- `tests/gps-gate-candidate-retry.test.js` — F11 GPSJumpGateService two-step confirmation + retry of unstable candidates
- `tests/gps-hold-ui-flicker.test.js` — F29 GPS-hold must not flip bridge_text to DEFAULT for a lone held vessel
- `tests/system-coordinator-decay.test.js` — F10 system-wide coordination decays (never stuck permanently)
- `tests/hysteresis-corruption-fix.test.js`, `tests/statusService-synthetic-hold.test.js` — status stabilization
- `tests/comprehensive/` + `tests/journey-scenarios/` — full journey/golden-snapshot validation

### Test Scenarios:
1. **Legitimate Direction Changes**: U-turns, course corrections (cogChange > 45°)
2. **Real GPS Jumps**: physically-impossible movement without a turn
3. **Medium Distance Movements**: 100–500m uncertain cases
4. **Status Flickering**: Prevention of rapid status changes
5. **Coordination lifecycle**: activation under bursts, decay during calm (F10)

## Benefits

### 1. **Accurate Movement Detection**:
- Distinguishes between GPS errors and legitimate movements
- Considers vessel physics (COG, SOG consistency)
- Reduces false GPS jump alarms

### 2. **Status Stability**:
- Prevents flickering during GPS uncertainties
- Maintains consistent bridge text messages
- Improves user experience

### 3. **Robust Error Handling**:
- Graceful handling of GPS dropouts
- Confidence-based decision making
- Fallback to previous known good state

### 4. **Performance**:
- Minimal computational overhead
- Memory cleanup for vessel histories
- Efficient pattern analysis

## Future Enhancements

### Potential Improvements:
1. **Position Smoothing**: Kalman filtering for GPS jump recovery
2. **Machine Learning**: Pattern recognition for vessel behavior
3. **Historical Analysis**: Long-term movement pattern validation
4. **External Data**: Integration with marine traffic databases

### Configuration Options:
1. **Sensitivity Tuning**: Adjustable legitimacy score thresholds
2. **Bridge-Specific Settings**: Different rules per bridge type
3. **Vessel Class Handling**: Different logic for different vessel types

## Migration Notes

### Existing Functionality:
- ✅ **Backward Compatible**: All existing features preserved  
- ✅ **No Breaking Changes**: Same API, enhanced behavior
- ✅ **Performance**: No significant impact on processing speed

### New Capabilities:
- ✅ **GPS Jump Intelligence**: Smart detection vs. legitimate movement
- ✅ **Status Stability**: Prevents flickering during uncertainties
- ✅ **Better Logging**: Detailed analysis reasons in logs
- ✅ **Testability**: Comprehensive test coverage for edge cases

This solution transforms the simple distance-based GPS jump detection into an intelligent system that understands vessel movement patterns and maintains stable status reporting even during complex maneuvers.