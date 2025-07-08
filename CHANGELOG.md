# Changelog

## [1.2.0] - 2025-07-08 - Critical Bug Resolution

### 🚨 Critical Fixes - Log-Driven Analysis

Based on detailed analysis of production log `app-20250708-191544.log`, five critical reliability issues were identified and resolved:

### 🔧 Added
- **Enhanced Bridge Passage Detection** (`_detectBridgeJump()`)
  - Detects vessels appearing at distant bridges after >5min gaps
  - Prevents vessel loss during bridge-to-bridge transitions
  - Bridge jump logging with detailed analysis

- **Stale Data Recovery** (`_detectStaleDataRecovery()`)  
  - Identifies frozen data (same distance >3min) and assumes passage
  - Handles "frozen vessel data syndrome" from production logs
  - Automatic recovery from stale AIS data

- **AIS Data Freshness Monitoring**
  - `_checkStaleDataWarning()` - Alerts when data is >2 minutes old
  - `_checkDuplicateDataWarning()` - Detects identical position/speed combinations
  - Enhanced logging for data quality issues

- **Protection Zone Escape Logic**
  - `_checkProtectionZoneTimeout()` - 25-minute maximum stay in protection zones
  - `_shouldEscapeProtectionZone()` - Logic for boats to escape when clearly departed
  - Prevents boats from being trapped indefinitely

- **System Health Monitoring**
  - `getSystemHealth()` - Comprehensive system status monitoring
  - Vessels, timeouts, ratio, bridges, connection status tracking
  - Real-time health assessment

### 🛠️ Improved
- **Extended Timeout Tolerance**
  - MAX_AGE_SEC increased from 5 to 10 minutes
  - GRACE_PERIOD_SEC increased from 60 to 120 seconds
  - Speed-compensated timeouts: 20min for very slow boats, 15min for slow boats

- **Enhanced Logging and Monitoring**
  - Long gap detection (>5 minutes) with automatic logging
  - Grace period and timeout expiration logging
  - Stale data and duplicate data warnings
  - Bridge passage logging with detection type (NORMAL/JUMP/RECOVERY)

### 🧪 Testing
- **New Test Files**
  - `log-bug-analysis.test.js` - Tests all 5 identified bugs individually
  - `real-log-validation.test.js` - Validates complete log scenario reproduction
  - 6 new tests covering all critical improvements

- **Validation Results**
  - ✅ Original 7-minute gap scenario: Vessel survives with proper detection
  - ✅ All 5 bugs handled simultaneously in multi-scenario tests
  - ✅ Performance maintained: 20 boats processed in 1ms
  - ✅ System health monitoring working correctly

### 🐛 Fixed
1. **Frozen vessel data syndrome** - Same distance (287.140534304579m) repeated for 6+ minutes
2. **Insufficient timeout tolerance** - 5-minute MAX_AGE_SEC too aggressive for realistic AIS variations
3. **Missing bridge passage detection** - No detection of vessel jumps between bridges
4. **Protection zone traps** - Boats stuck in 300m zones with no escape mechanism
5. **Stale AIS data processing** - No warnings for old or duplicate data

### 📈 Performance
- **Zero Performance Impact** - All improvements maintain 1ms processing time
- **Reliability Improvements**
  - Timeout tolerance: 100% improvement (5min → 10min base, up to 20min for slow boats)
  - Bridge passage detection: 3 detection methods (normal, jump, recovery)
  - Protection zone logic: Timeout-based escape after 25 minutes
  - Data quality: Real-time monitoring of stale and duplicate data

### 🔍 Technical Details
- **File Changes**: `app.js` (lines 389-421, 456-489, 797-806, 1381-1406, 2025-2046)
- **New Functions**: 7 new functions for reliability improvements
- **Test Coverage**: 6 new tests validating all improvements
- **Documentation**: Updated CLAUDE.md and DEVELOPMENT.md with comprehensive analysis

### 🎯 Validation Against Production Issue
The exact scenario from `app-20250708-191544.log` was reproduced in tests:
- **17:43:16**: Vessel at Klaffbron (287.140534304579m) ✅ Detected
- **17:43:16-17:50:24**: 7+ minute gap with frozen data ✅ Survives with new timeouts
- **17:50:24**: Vessel appears at Järnvägsbron ✅ Bridge jump detected
- **Result**: Complete vessel tracking through entire problematic scenario

---

## [1.1.0] - 2025-07-07 - Enhanced Boat Behavior

### Added
- 300m protection zone for boats turning around near bridges
- Adaptive speed thresholds based on distance to bridges
- Enhanced behavior verification tests

### Improved
- Better handling of slow boats near bridges
- Improved detection of boats waiting for bridge openings
- Enhanced smart approach detection logic

### Fixed
- Boats turning around very close to bridges being removed prematurely
- Very slow boats (under 0.2 knots) being removed when near bridges

---

## [1.0.0] - 2025-07-01 - Initial Release

### Added
- Real-time AIS boat tracking with WebSocket connection to AISstream.io
- Bridge proximity detection for 5 bridges in Sweden
- Smart approach detection with confidence scoring
- ETA calculations for bridge openings
- Flow cards for Homey automation
- Device capabilities: bridge_text, alarm_generic, connection_status
- Comprehensive test suite with 145+ tests
- Multi-boat handling with proper prioritization
- Connection resilience with exponential backoff
- Configurable debug logging levels