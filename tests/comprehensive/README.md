# Comprehensive Bridge Text Test Suite

Exhaustive test suite for bridge text functionality using real app logic.

## 📁 Structure

```
comprehensive/
├── ScenarioLibrary.js              # 52 curated test scenarios
├── GoldenSnapshotGenerator.js      # Generates expected outputs
├── JourneyTestRunner.js            # Visual test execution
├── generate-snapshots.js           # Script to create golden snapshots
├── golden-snapshots.json           # Frozen expected outputs (generated)
├── comprehensive-bridge-text.test.js  # Main test suite
└── README.md                       # This file
```

## 🚀 Quick Start

### 1. Generate Golden Snapshots (First Time Only)

```bash
node tests/comprehensive/generate-snapshots.js
```

This runs the real app logic to generate expected bridge text outputs and saves them to `golden-snapshots.json`.

### 2. Run Tests

```bash
npm test tests/comprehensive
```

Tests will compare actual outputs against frozen golden snapshots.

## 📊 Test Coverage

**Total: 20 curated scenarios**

### Core Journeys (4 scenarios)
- Complete canal passages (North→South, South→North)
- Fast vessel timing validation
- Slow vessel timing validation

### Status Transitions (6 scenarios)
- Approaching → Waiting (boundary tests)
- Waiting → Under-bridge (boundary tests)
- Under-bridge → Passed
- Stallbackabron special sequences
- Intermediate bridge messages

### Multi-Vessel Scenarios (5 scenarios)
- 2 vessels same bridge (various configurations)
- 2 vessels different bridges (semicolon separation)
- 3-5 vessels at target bridges
- Mixed status scenarios

### Edge Cases (5 scenarios)
- Distance boundaries (299m vs 301m, 49m vs 51m)
- No vessels (default message)
- Missing vessel data
- Extreme speeds

## 🎨 Visual Output

Tests provide clear, emoji-rich console output:

```
================================================================================
🚢 Journey 1: Single vessel North→South (complete passage)
================================================================================

🟠 Update #1: "En båt närmar sig Stallbackabron på väg mot Stridsbergsbron..."
🟣 Update #2: "En båt åker strax under Stallbackabron på väg mot Stridsbergsbron..."
🟢 Update #3: "En båt passerar Stallbackabron på väg mot Stridsbergsbron..."
🔵 Update #4: "En båt har precis passerat Stallbackabron på väg mot Stridsbergsbron..."
...

✅ Journey completed: 12 updates validated
```

### Emoji Legend
- ⚪ No vessels (default message)
- 🟢 Under-bridge (opening in progress)
- 🟡 Waiting (awaiting opening)
- 🔵 Just passed (recently passed bridge)
- 🟠 Approaching (getting close)
- 🟣 Stallbackabron special messages
- 🎯 Other scenarios

## 🔧 When to Regenerate Snapshots

Regenerate golden snapshots when:
- Bridge text logic changes intentionally
- Adding new scenarios to ScenarioLibrary
- Fixing bugs that change expected outputs

```bash
node tests/comprehensive/generate-snapshots.js
```

Then review `golden-snapshots.json` and commit if changes are correct.

## ✅ Design Principles

1. **Use Real App Logic**: Tests run actual app code via RealAppTestRunner
2. **Golden Snapshot Testing**: Expected outputs generated from real logic, not hardcoded
3. **Deterministic Scenarios**: Fixed test cases, no runtime randomization
4. **Physical Validity**: All scenarios validated for realistic vessel states
5. **Sequential Execution**: No parallel test execution to avoid race conditions
6. **Fail Fast**: First mismatch stops test with detailed diff

## 🤔 FAQ

**Q: Why golden snapshots instead of hardcoded expected strings?**
A: Eliminates double maintenance. If app logic changes, regenerate snapshots instead of updating hundreds of test assertions.

**Q: How do I add new scenarios?**
A: Add to ScenarioLibrary.js, then regenerate snapshots.

**Q: Tests are failing after code changes. What do I do?**
A: Review the diff. If the new output is correct (intended change), regenerate snapshots. If incorrect, fix the bug.

**Q: Can I run a single scenario?**
A: Yes! Use Jest's test filtering:
```bash
npm test -- --testNamePattern="Journey 1"
```
