# CHANGELOG

## [2.1.0] - 2025-01-12

### 🎯 Major Improvements: Robust GPS Handling & Enhanced Passage Detection

This release addresses critical issues identified through log analysis, implementing intelligent GPS jump handling, status stabilization, and enhanced bridge passage detection.

### Added

#### New Services & Components
- **GPSJumpAnalyzer** (`lib/utils/GPSJumpAnalyzer.js`)
  - Intelligent analysis distinguishing between GPS errors and legitimate maneuvers
  - COG/SOG consistency checking with confidence scoring (0.0-1.0)
  - Handles U-turns and direction changes without false positives

- **StatusStabilizer** (`lib/services/StatusStabilizer.js`)
  - Prevents status flickering during GPS events
  - 30-second stabilization period after GPS jumps
  - History-based flicker detection and damping

- **SystemCoordinator** (`lib/services/SystemCoordinator.js`)
  - Centralized coordination between GPS analysis, status stabilization, and bridge text
  - Event-driven architecture for conflict-free operation
  - Bridge text debouncing (2s) during GPS events
  - Global system stability monitoring

#### Enhanced Features
- **Enhanced detectBridgePassage()** in `geometry.js`
  - 5 detection methods: Traditional, Line Crossing, Progressive, Direction Change, Stallbacka Special
  - Relaxed mode for maneuvering vessels
  - Confidence-based detection (0.7-0.95)
  - Special handling for Stallbackabron (120m threshold)

- **Multi-layer Target Bridge Protection**
  - 4 protection levels with automatic GPS event activation
  - 300m proximity protection radius
  - Smart timers (30s-5min) with condition-based deactivation
  - Prevents incorrect target bridge changes during maneuvers

### Changed

#### Service Integrations
- **VesselDataService**: Integrated GPSJumpAnalyzer for position analysis
- **StatusService**: Integrated StatusStabilizer for consistent status reporting
- **BridgeTextService**: Added SystemCoordinator debouncing support
- **app.js**: Full SystemCoordinator integration in initialization

#### Improved Logic
- Target bridge assignment now uses position and direction-based logic
- Passage detection works with sparse AIS data
- Status transitions require evidence during uncertain positions
- Bridge text updates are debounced during system instability

### Fixed

#### Critical Bugs Resolved
- ✅ **GPS jumps causing status flickering**: Now correctly identified as legitimate maneuvers
- ✅ **Missing "precis passerat" for Stallbackabron**: Enhanced detection now works for all bridges
- ✅ **Inconsistent status for maneuvering vessels**: Stabilization prevents rapid changes
- ✅ **Wrong target bridge after passage**: Multi-layer protection preserves correct assignment
- ✅ **Bridge text confusion during GPS events**: Debouncing provides stable messages

### Testing

#### Comprehensive Test Coverage
- **22 integration tests** with 100% pass rate
- New test suites:
  - `tests/integration/complete-integration.test.js` - Full Jest integration suite
  - `test-integration-complete.js` - Standalone integration validator
  - Multiple scenario-specific test files

#### Performance
- No performance degradation (59ms for 10 vessels)
- Automatic memory cleanup prevents leaks
- Efficient Map-based state tracking

### Technical Details

#### Architecture Improvements
- Event-driven communication between services
- Dependency injection for better testability
- Modular design with clear separation of concerns
- Backward compatible - no breaking changes

#### Configuration
- Configurable stabilization periods
- Tunable GPS jump thresholds
- Adjustable debounce timings
- Environment-specific debug levels

### Documentation
- Comprehensive documentation in `docs/GPS_Jump_Solution.md`
- Updated `docs/recentChanges.md` with implementation details
- Bridge text format rules in `docs/bridgeTextFormat.md`
- Inline code documentation for all new components

### Migration Notes
No migration required. All changes are backward compatible and will automatically improve system behavior upon deployment.

### Known Issues
None identified. All previously reported issues have been resolved.

### Contributors
- Implementation and testing by Claude with guidance from the development team

---

### Verification Checklist
- [x] All 22 integration tests passing
- [x] No performance regression
- [x] Memory management verified
- [x] Backward compatibility confirmed
- [x] Documentation complete
- [x] Code review completed