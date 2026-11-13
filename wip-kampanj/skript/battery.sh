#!/usr/bin/env bash
# Slutbatteri för en worktree: kör allt i följd, skriver status per steg.
# Användning: battery.sh <worktree> <utkatalog>
WT="$1"; OUT="$2"
mkdir -p "$OUT/tmp"
export TMPDIR="$OUT/tmp"
cd "$WT" || exit 9
: > "$OUT/status"
step() { # namn, kommando...
  local name="$1"; shift
  local t0=$(date +%s)
  ( "$@" ) > "$OUT/$name.log" 2>&1
  local ec=$?
  echo "$name $ec $(( $(date +%s) - t0 ))s" >> "$OUT/status"
}
step jest npx jest --config tests/jest.config.js --detectOpenHandles --cacheDirectory="$OUT/jest-cache"
step lint npm run lint
step replay-all node tests/replay-validation/runAllCorpora.js
step replay-all-mon env REPLAY_MONITORING=1 node tests/replay-validation/runAllCorpora.js
step synth node tests/replay-validation/runSyntheticScenarios.js
step openings node tests/replay-validation/runOpeningGates.js
step soak node tests/replay-validation/runSoak.js
step soak-mon node tests/replay-validation/runSoak.js --monitoring
step phase node tests/replay-validation/runPhaseSweep.js
step phase-mon env REPLAY_MONITORING=1 node tests/replay-validation/runPhaseSweep.js
step hunt-selftest node tests/replay-validation/bugHunt/hunt.js --selftest --out="$OUT/hunt-selftest"
step hunt-quick node tests/replay-validation/bugHunt/hunt.js --profile=quick --out="$OUT/hunt-quick"
step porcelain git status --porcelain --untracked-files=all
echo KLAR >> "$OUT/status"
