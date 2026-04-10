#!/bin/bash

# Robust path handling: anchor logs relative to this script's directory,
# resolving to an absolute path so messages never show ".." and work from any CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="$(cd "$SCRIPT_DIR/../logs" && pwd 2>/dev/null || true)"
if [ -z "$LOGS_DIR" ]; then
  # Create logs dir if it did not exist and resolve absolute path
  mkdir -p "$SCRIPT_DIR/../logs"
  LOGS_DIR="$(cd "$SCRIPT_DIR/../logs" && pwd)"
fi

# Generera filnamn med datum och tid
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOGFILE="$LOGS_DIR/app-$TIMESTAMP.log"
BRIDGE_TEXT_SUMMARY="$LOGS_DIR/bridge-text-summary-$TIMESTAMP.md"
AIS_REPLAY_FILE="$LOGS_DIR/ais-replay-$TIMESTAMP.jsonl"

touch "$AIS_REPLAY_FILE"

echo "Startar app och sparar loggar till: $LOGFILE"
echo "Bridge text summary kommer skapas i: $BRIDGE_TEXT_SUMMARY"
echo "AIS replay data loggas till: $AIS_REPLAY_FILE"
echo "Tryck Ctrl+C för att stoppa"

# Funktion för att extrahera bridge text updates när appen stoppas
extract_bridge_text() {
    echo ""
    echo "🔍 Genererar bridge text summary..."
    
    # Skapa bridge text summary (portable header expansion, macOS/BSD-friendly)
    GENERATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    SOURCE_NAME="$(basename "$LOGFILE")"
    cat > "$BRIDGE_TEXT_SUMMARY" << EOL
# Bridge Text Summary Report

**Generated:** $GENERATED_AT
**Source:** $SOURCE_NAME

## All Bridge Text Updates (Chronological)

EOL

    # Extrahera bridge text updates från loggen
    grep "📱 \[UI_UPDATE\] Bridge text updated:" "$LOGFILE" | \
    nl -w3 -s'. ' | \
    sed -E 's/^([[:space:]]*[0-9]+\. ).*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})\.[0-9]{3}Z.*"(.+)"$/\1**\2** `\3`/' | \
    while IFS= read -r line; do
        echo "$line" >> "$BRIDGE_TEXT_SUMMARY"
        echo "" >> "$BRIDGE_TEXT_SUMMARY"
    done

    # Lägg till summary statistik
    echo "## Summary Statistics" >> "$BRIDGE_TEXT_SUMMARY"
    echo "" >> "$BRIDGE_TEXT_SUMMARY"
    
    TOTAL_UPDATES=$(grep -c "📱 \[UI_UPDATE\] Bridge text updated:" "$LOGFILE")
    UNDER_BRIDGE=$(grep -c "Broöppning pågår" "$LOGFILE")
    WAITING_UPDATES=$(grep -c "inväntar broöppning" "$LOGFILE")
    APPROACHING_UPDATES=$(grep -c "närmar sig" "$LOGFILE") 
    PASSED_UPDATES=$(grep -c "precis passerat" "$LOGFILE")
    
    echo "- **Total Bridge Text Updates:** $TOTAL_UPDATES" >> "$BRIDGE_TEXT_SUMMARY"
    echo "- **Under Bridge Events:** $UNDER_BRIDGE" >> "$BRIDGE_TEXT_SUMMARY"
    echo "- **Waiting Events:** $WAITING_UPDATES" >> "$BRIDGE_TEXT_SUMMARY"
    echo "- **Approaching Events:** $APPROACHING_UPDATES" >> "$BRIDGE_TEXT_SUMMARY"
    echo "- **Passed Events:** $PASSED_UPDATES" >> "$BRIDGE_TEXT_SUMMARY"
    
    echo "✅ Bridge text summary skapad: $BRIDGE_TEXT_SUMMARY"
    echo "✅ AIS replay logg skapad: $AIS_REPLAY_FILE"
}

# Sätt trap för att köra bridge text extraction när scriptet avbryts
trap extract_bridge_text EXIT

# Kör appen och spara både stdout och stderr till loggfil
# Samtidigt extraheras AIS-replay-rader (innehåller [AIS_REPLAY_SAMPLE]) till jsonl-filen
# OBS: Vissa Homey CLI-versioner saknar stöd för --env.* för att vidarebefordra env till hubben.
# Därför fångar vi alltid AIS_REPLAY_SAMPLE från stdout och skriver lokalt till jsonl.
RUN_REMOTE=${RUN_REMOTE:-true}
if [ "$RUN_REMOTE" = "true" ] && [ -n "$AIS_BRIDGE_SELFTEST" ]; then
  echo "⚠️ Homey CLI saknar --env-stöd: AIS_BRIDGE_SELFTEST kan inte aktiveras på remote. Sätt RUN_REMOTE=false för lokal självtest."
fi

HOMEY_CMD=(homey app run)
if [ "$RUN_REMOTE" = "true" ]; then
  HOMEY_CMD+=(--remote)
fi

AIS_REPLAY_CAPTURE_FILE="$AIS_REPLAY_FILE" "${HOMEY_CMD[@]}" 2>&1 | tee "$LOGFILE" | tee >(
    grep 'AIS_REPLAY_SAMPLE' | sed 's/^.*AIS_REPLAY_SAMPLE\] //' >> "$AIS_REPLAY_FILE"
)

echo "Loggar sparade i: $LOGFILE"
