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

# FÄLTPROV 4-FIX (2026-07-09, F4-A — ANVÄNDARBESLUT): live-loggen skrivs LOKALT,
# inte direkt i OneDrive-mappen. Körningen 20260708-224444 tappade ~4 minuter
# loggrader (09:31–09:33, mitt i lastpiken) när tee-röret mot den OneDrive-
# synkade filen stallade — notiser avfyrades bevisligen i hålet men syntes
# aldrig, och rå-jsonl:en blev ofullständig (körningen kunde inte korpuslåsas).
# Lokal disk är immun mot synklås; filerna synkas till logs/-mappen var 10:e
# minut och kopieras slutgiltigt vid avslut — samma filnamn och plats som förut.
LIVE_DIR="$HOME/.ais-tracker-logs"
mkdir -p "$LIVE_DIR"

# Generera filnamn med datum och tid
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOGFILE="$LIVE_DIR/app-$TIMESTAMP.log"
BRIDGE_TEXT_SUMMARY="$LIVE_DIR/bridge-text-summary-$TIMESTAMP.md"
AIS_REPLAY_FILE="$LIVE_DIR/ais-replay-$TIMESTAMP.jsonl"
FINAL_LOGFILE="$LOGS_DIR/app-$TIMESTAMP.log"
FINAL_SUMMARY="$LOGS_DIR/bridge-text-summary-$TIMESTAMP.md"
FINAL_REPLAY="$LOGS_DIR/ais-replay-$TIMESTAMP.jsonl"

touch "$AIS_REPLAY_FILE"

echo "Startar app — live-loggar skrivs LOKALT (immunt mot OneDrive-stall):"
echo "  $LOGFILE"
echo "Synkas var 10:e minut och vid avslut till: $LOGS_DIR"
echo ""
echo "⚠️  VIKTIGT: replay-fångsten ([AIS_REPLAY_SAMPLE]-raderna) kräver att"
echo "    appens inställning debug_level är satt till 'full' (Homey-appens"
echo "    inställningssida). Utan den blir jsonl-filen TOM och körningen kan"
echo "    inte analyseras/låsas som korpus. (Ändrad 2026-07-06: raderna"
echo "    loggas inte längre i normal drift för att skona Homey-loggen.)"
echo "Tryck Ctrl+C för att stoppa"

# Aktiv vakt (2026-07-06): larma tidigt om replay-rader uteblir — annars
# upptäcks en tom jsonl först efter ett dygns fältprov.
(
  sleep 120
  if [ ! -s "$AIS_REPLAY_FILE" ]; then
    echo ""
    echo "🚨🚨 [REPLAY-VAKT] Inga [AIS_REPLAY_SAMPLE]-rader efter 2 minuter!"
    echo "🚨🚨 Kontrollera att debug_level='full' i appens inställningar,"
    echo "🚨🚨 annars blir replay-filen tom och körningen oanalyserbar."
    echo ""
  fi
) &
REPLAY_GUARD_PID=$!

# HÅLDETEKTOR, runtime (F4-A): appen loggar watchdog-/self-healing-rader var
# ~90:e sekund i ALLA lägen — om loggfilen inte växt på 3 minuter tappar
# röret data (eller CLI-strömmen har dött). Larma direkt i terminalen.
(
  sleep 240
  while true; do
    if [ -f "$LOGFILE" ]; then
      NOW=$(date +%s)
      MTIME=$(stat -f %m "$LOGFILE" 2>/dev/null || stat -c %Y "$LOGFILE" 2>/dev/null || echo "$NOW")
      AGE=$((NOW - MTIME))
      if [ "$AGE" -gt 180 ]; then
        echo ""
        echo "🚨🚨 [HÅLVAKT] Loggfilen har inte växt på ${AGE}s (>180s)!"
        echo "🚨🚨 Watchdogen loggar var ~90:e sekund — rader tappas troligen"
        echo "🚨🚨 (CLI-ström/rör). Körningens logg kan bli ofullständig."
        echo ""
      fi
    fi
    sleep 60
  done
) &
HOLE_GUARD_PID=$!

# PERIODISK SYNK (F4-A): kopiera live-filerna till OneDrive-mappen var 10:e
# minut — kraschskydd utan att live-skrivningen någonsin väntar på synken.
(
  while true; do
    sleep 600
    cp -f "$LOGFILE" "$FINAL_LOGFILE" 2>/dev/null || true
    cp -f "$AIS_REPLAY_FILE" "$FINAL_REPLAY" 2>/dev/null || true
  done
) &
SYNC_PID=$!

# Funktion för att extrahera bridge text updates när appen stoppas
extract_bridge_text() {
    kill "$REPLAY_GUARD_PID" 2>/dev/null || true
    kill "$HOLE_GUARD_PID" 2>/dev/null || true
    kill "$SYNC_PID" 2>/dev/null || true
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

    # FP8 (2026-07-13): räknarna moderniserade. De gamla grep-mönstren
    # ("Broöppning pågår"/"inväntar broöppning"/"närmar sig") tillhör ett
    # textformat appen inte längre producerar (designbeslut "alternativ 1":
    # under-bridge/waiting renderas som "beräknad broöppning strax") —
    # summaryn visade permanent 0/0/0 och utlöste en falsk regressions-
    # misstanke i fältprov 8-granskningen. Nu räknas det som finns.
    TOTAL_UPDATES=$(grep -c "📱 \[UI_UPDATE\] Bridge text updated:" "$LOGFILE")
    NOTIFICATIONS=$(grep -c "\[FLOW_TRIGGER_SUCCESS\]" "$LOGFILE")
    STRAX_UPDATES=$(grep "📱 \[UI_UPDATE\] Bridge text updated:" "$LOGFILE" | grep -c "broöppning strax")
    ETA_UNKNOWN=$(grep "📱 \[UI_UPDATE\] Bridge text updated:" "$LOGFILE" | grep -c "ETA okänd")
    DEFAULT_UPDATES=$(grep "📱 \[UI_UPDATE\] Bridge text updated:" "$LOGFILE" | grep -c "Inga båtar är i närheten")

    echo "- **Total Bridge Text Updates:** $TOTAL_UPDATES" >> "$BRIDGE_TEXT_SUMMARY"
    echo "- **boat_near Notifications:** $NOTIFICATIONS" >> "$BRIDGE_TEXT_SUMMARY"
    echo "- **\"strax\"-Updates:** $STRAX_UPDATES" >> "$BRIDGE_TEXT_SUMMARY"
    echo "- **\"ETA okänd\"-Updates:** $ETA_UNKNOWN" >> "$BRIDGE_TEXT_SUMMARY"
    echo "- **\"Inga båtar\"-Updates:** $DEFAULT_UPDATES" >> "$BRIDGE_TEXT_SUMMARY"

    # HÅLDETEKTOR, efterhand (F4-A): tidsstämpelluckor >180 s i loggen = tappade
    # rader (watchdogen loggar var ~90 s). Resultatet skrivs i summaryn så en
    # ofullständig körning aldrig korpuslåses av misstag (körboken kräver
    # "Logg-integritet: OK" före låsning).
    echo "" >> "$BRIDGE_TEXT_SUMMARY"
    echo "## Logg-integritet (håldetektor)" >> "$BRIDGE_TEXT_SUMMARY"
    echo "" >> "$BRIDGE_TEXT_SUMMARY"
    HOLES=$(grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' "$LOGFILE" | \
      awk -F'[T:]' '{
        t = $2*3600 + $3*60 + $4; d = $1;
        if (prevd == d && prevt != "" && t - prevt > 180)
          printf "- HÅL: %s → %s (%d s utan loggrader)\n", prev, $0, t - prevt;
        prevt = t; prevd = d; prev = $0;
      }')
    if [ -n "$HOLES" ]; then
        echo "⚠️ **TIDSHÅL FUNNA — körningen är OFULLSTÄNDIG och får inte korpuslåsas:**" >> "$BRIDGE_TEXT_SUMMARY"
        echo "" >> "$BRIDGE_TEXT_SUMMARY"
        echo "$HOLES" >> "$BRIDGE_TEXT_SUMMARY"
        echo ""
        echo "🚨🚨 [HÅLVAKT] Tidshål funna i loggen — se $BRIDGE_TEXT_SUMMARY"
        echo "$HOLES"
    else
        echo "✅ Inga tidshål >180 s — loggen är komplett (korpuslåsning tillåten)." >> "$BRIDGE_TEXT_SUMMARY"
    fi

    # SLUTSYNK (F4-A): flytta allt till OneDrive-mappen — samma namn/plats som
    # tidigare arbetsflöden förväntar sig.
    cp -f "$LOGFILE" "$FINAL_LOGFILE"
    cp -f "$AIS_REPLAY_FILE" "$FINAL_REPLAY"
    cp -f "$BRIDGE_TEXT_SUMMARY" "$FINAL_SUMMARY"

    echo "✅ Bridge text summary skapad: $FINAL_SUMMARY"
    echo "✅ AIS replay logg skapad: $FINAL_REPLAY"
    echo "✅ App-logg synkad: $FINAL_LOGFILE"
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

echo "Loggar sparade i: $FINAL_LOGFILE"
