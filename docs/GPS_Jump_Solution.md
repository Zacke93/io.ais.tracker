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

#### Decision Logic:
```javascript
legitimacyScore = (cogChangeScore + bearingConsistencyScore + speedConsistencyScore) / factors

if (score >= 0.7) → "accept" (legitimate_direction_change)
if (score >= 0.4) → "accept_with_caution" (uncertain_movement)  
if (score < 0.4) → "gps_jump_detected" (likely_gps_error)
```

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
  GPS_JUMP_THRESHOLD: 500, // meters - existing threshold
  // GPSJumpAnalyzer uses this as starting point for analysis
}
```

### Stabilization Parameters:
```javascript
// In StatusStabilizer.js
GPS_JUMP_STABILIZATION_DURATION = 30 * 1000; // 30 seconds
UNCERTAIN_POSITION_CONSISTENCY_REQUIRED = 2; // readings
FLICKERING_DETECTION_WINDOW = 3; // status changes
```

## Testing

### Test Coverage:
- **Unit Tests**: `tests/gps-jump-solution.test.js`
- **Integration Tests**: Real boat journey scenarios
- **Edge Cases**: Rapid direction changes, GPS dropouts, legitimate high-speed movements

### Test Scenarios:
1. **Legitimate Direction Changes**: U-turns, course corrections
2. **Real GPS Jumps**: Inconsistent movement patterns
3. **Medium Distance Movements**: 100-500m uncertain cases
4. **Status Flickering**: Prevention of rapid status changes
5. **Integration**: Full boat 257941000 scenario reproduction

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