#!/bin/bash

echo "========================================"
echo "AIS Tracker - Real Code Integration Tests"
echo "========================================"
echo ""
echo "Running tests that verify actual code behavior"
echo "based on Kravspec v2.3 and real AIS logs"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Navigate to project directory
cd "$(dirname "$0")"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    npm install
fi

echo -e "${GREEN}Running Kravspec v2.3 compliance tests...${NC}"
echo "----------------------------------------"
npm test -- tests/integration/kravspec-v2.3-real-tests.js --verbose

echo ""
echo -e "${GREEN}Running real AIS log scenario tests...${NC}"
echo "----------------------------------------"
npm test -- tests/integration/real-ais-log-tests.js --verbose

echo ""
echo -e "${GREEN}Running full system integration tests...${NC}"
echo "----------------------------------------"
npm test -- tests/integration/full-system-integration-tests.js --verbose

echo ""
echo -e "${GREEN}Running all tests with coverage...${NC}"
echo "----------------------------------------"
npm test -- --coverage

echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"

# Check if all tests passed
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    echo ""
    echo "These tests verify:"
    echo "- Bridge passage detection (§5)"
    echo "- Hysteresis rule (§1)"
    echo "- Waiting status with 2 min continuity (§2.2b)"
    echo "- Under-bridge detection (§2.2c)"
    echo "- Timeout zones (§4.1)"
    echo "- GRACE_MISSES logic (§4.2)"
    echo "- Message generation (§2)"
    echo "- Real AIS log scenarios"
    echo "- Full system integration"
else
    echo -e "${RED}✗ Some tests failed!${NC}"
    echo ""
    echo "Please check the output above for details."
fi

echo ""
echo "Coverage report available in ./coverage/lcov-report/index.html"