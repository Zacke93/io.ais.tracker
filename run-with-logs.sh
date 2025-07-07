#!/bin/bash

# Skapa logs-mapp i AIS Tracker huvudmappen
mkdir -p "../logs"

# Generera filnamn med datum och tid
LOGFILE="../logs/app-$(date +%Y%m%d-%H%M%S).log"

echo "Startar app och sparar loggar till: $LOGFILE"
echo "Tryck Ctrl+C för att stoppa"

# Kör appen och spara både stdout och stderr till loggfil
homey app run --remote 2>&1 | tee "$LOGFILE"

echo "Loggar sparade i: $LOGFILE"