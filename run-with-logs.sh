#!/bin/bash

# Skapa logs-mapp i AIS Tracker huvudmappen
mkdir -p "../logs"

# Generera filnamn med datum och tid
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOGFILE="../logs/app-$TIMESTAMP.log"
BRIDGE_TEXT_SUMMARY="../logs/bridge-text-summary-$TIMESTAMP.md"

echo "Startar app och sparar loggar till: $LOGFILE"
echo "Bridge text summary kommer skapas i: $BRIDGE_TEXT_SUMMARY"
echo "Tryck Ctrl+C för att stoppa"

# Funktion för att extrahera bridge text updates när appen stoppas
extract_bridge_text() {
    echo ""
    echo "🔍 Genererar bridge text summary..."
    
    # Skapa bridge text summary
    cat > "$BRIDGE_TEXT_SUMMARY" << 'EOL'
# Bridge Text Summary Report

**Generated:** $(date --iso-8601=seconds)
**Source:** $(basename "$LOGFILE")

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
}

# Sätt trap för att köra bridge text extraction när scriptet avbryts
trap extract_bridge_text EXIT

# Kör appen och spara både stdout och stderr till loggfil
homey app run --remote 2>&1 | tee "$LOGFILE"

echo "Loggar sparade i: $LOGFILE"