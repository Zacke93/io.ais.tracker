#!/bin/bash

# FULL-PIPELINE TEST RUNNER
# Kör alla full-pipeline integrationstester för AIS Bridge app
# 
# Dessa tester simulerar hela kedjan från WebSocket till device updates
# och fångar integrationsproblem som inte upptäcks av unit tests.

echo "🚢 Running Full-Pipeline Integration Tests för AIS Bridge"
echo "=========================================================="

# Set working directory
cd "$(dirname "$0")"

# Colors för output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test categories
echo -e "${BLUE}Test Categories:${NC}"
echo "1. Full-Pipeline Integration (WebSocket → Device Updates)"
echo "2. Real Log Scenarios (Verklig AIS-data från production)"
echo "3. Device Integration & Race Conditions"
echo "4. Performance & Stress Testing"
echo ""

# Function to run test with timing
run_test() {
    local test_file=$1
    local test_name=$2
    
    echo -e "${YELLOW}Running: ${test_name}${NC}"
    echo "----------------------------------------"
    
    start_time=$(date +%s.%N)
    
    if npm test -- "$test_file" --verbose; then
        end_time=$(date +%s.%N)
        duration=$(echo "$end_time - $start_time" | bc)
        echo -e "${GREEN}✅ ${test_name} PASSED${NC} (${duration}s)"
    else
        end_time=$(date +%s.%N)
        duration=$(echo "$end_time - $start_time" | bc)
        echo -e "${RED}❌ ${test_name} FAILED${NC} (${duration}s)"
        return 1
    fi
    echo ""
}

# Total test start time
total_start=$(date +%s.%N)

# Run all full-pipeline tests
echo -e "${BLUE}🔄 Starting Full-Pipeline Test Suite...${NC}"
echo ""

# Test 1: Core Integration
run_test "tests/full-pipeline-integration.test.js" "Full-Pipeline Integration" || exit 1

# Test 2: Real Log Scenarios  
run_test "tests/real-log-scenario-tests.test.js" "Real Log Scenarios" || exit 1

# Test 3: Device Integration & Race Conditions
run_test "tests/device-integration-race-conditions.test.js" "Device Integration & Race Conditions" || exit 1

# Test 4: Performance Testing
run_test "tests/full-pipeline-performance.test.js" "Performance & Stress Testing" || exit 1

# Calculate total time
total_end=$(date +%s.%N)
total_duration=$(echo "$total_end - $total_start" | bc)

echo "=========================================================="
echo -e "${GREEN}🎉 ALL FULL-PIPELINE TESTS PASSED!${NC}"
echo -e "Total execution time: ${total_duration}s"
echo ""

# Summary
echo -e "${BLUE}Test Summary:${NC}"
echo "✅ Full-Pipeline Integration - WebSocket → Vessel → Device Updates"
echo "✅ Real Log Scenarios - AVA, MARTINA, RIX RIVER production data"  
echo "✅ Device Integration - Race conditions, failures, recovery"
echo "✅ Performance Testing - 15+ boats, message bursts, scalability"
echo ""

# Integration problem coverage
echo -e "${BLUE}Integration Problems Covered:${NC}"
echo "• Device update failures och recovery"
echo "• Race conditions i UI updates"  
echo "• Vessel removal without bridge_text refresh"
echo "• WebSocket reconnection/device sync"
echo "• Flow trigger failures under load"
echo "• Memory leaks i device event handling"
echo "• Bridge_text som blir 'stuck' på gamla värden"
echo "• Performance degradation under high vessel count"
echo ""

echo -e "${GREEN}Full-pipeline integration testing complete! 🚢${NC}"