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

# STÄDNING VID START (granskningsfynd 2026-08-21): temp-filerna från sync_file
# och rebuild_replay_jsonl är per konstruktion övergivna först när skrivaren
# DOG — vid SIGKILL eller strömavbrott hinner ingen avslutsväg städa dem, och
# i LOGS_DIR (OneDrive) synkas skräpet dessutom upp i molnet. Varje hårdstoppad
# körning lämnade förr ett nytt lager. Därför sopas gamla rester bort här.
# -mtime +1 = äldre än ett dygn: en parallell körnings temp-filer kan aldrig
# träffas, hur länge fältprovet än pågår.
sweep_stale_tempfiles() {
    local dir
    for dir in "$LIVE_DIR" "$LOGS_DIR"; do
        [ -d "$dir" ] || continue
        find "$dir" -maxdepth 1 -mtime +1 \
            \( -name '.app-*.log.tmp.*' \
            -o -name '.ais-replay-*.jsonl.tmp.*' \
            -o -name '.bridge-text-summary-*.md.tmp.*' \) \
            -delete 2>/dev/null || true
    done
}
sweep_stale_tempfiles

# Skriptets egen pid: bakgrundsloopar nedan använder den för att dö när
# huvudprocessen är borta (annars blir de föräldralösa och maler vidare i
# evighet — två sådana från en tidigare rigg levde i över fyra timmar).
MAIN_PID=$$

# Generera filnamn med datum och tid
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOGFILE="$LIVE_DIR/app-$TIMESTAMP.log"
BRIDGE_TEXT_SUMMARY="$LIVE_DIR/bridge-text-summary-$TIMESTAMP.md"
AIS_REPLAY_FILE="$LIVE_DIR/ais-replay-$TIMESTAMP.jsonl"
FINAL_LOGFILE="$LOGS_DIR/app-$TIMESTAMP.log"
FINAL_SUMMARY="$LOGS_DIR/bridge-text-summary-$TIMESTAMP.md"
FINAL_REPLAY="$LOGS_DIR/ais-replay-$TIMESTAMP.jsonl"

# K24 (fältprov 10, 2026-08-21) — EN SKRIVARE PER FIL. Appen har en EGEN
# fångstväg (app.js:232-250 läser AIS_REPLAY_CAPTURE_FILE, :8559 gör
# fs.appendFile). Den vägen är BEVISAT död i fältkörningar: `homey app run`
# kör appen på Homey-enheten och skalets env följer inte med dit — båda
# 19/8-loggarna säger på rad 18 "ℹ️ [AIS_REPLAY] No AIS_REPLAY_CAPTURE_FILE
# detected; replay samples will be emitted to stdout only", och något env.json
# finns inte. Men om den vägen NÅGON gång vaknar (lokal körning, CLI med
# env-stöd) skulle appen och skriptet skriva till SAMMA fil, och den ena är
# radvis medan den andra inte är det ⇒ dubblerade/blandade rader i facit.
# Därför får appen en egen sökväg. Env-variabeln behålls: när den är satt
# släpper app.js:8543 fram stdout-raderna OAVSETT debug_level, vilket är ett
# skyddsnät om inställningen råkar stå på "basic".
APP_SIDE_REPLAY_FILE="$LIVE_DIR/ais-replay-$TIMESTAMP.appside.jsonl"

touch "$AIS_REPLAY_FILE"

# ATOMISK SYNK (K24): `cp -f` TRUNKERAR målet innan den börjar skriva, så ett
# avbrott mitt i kopieringen lämnar en HALV fil kvar under det riktiga namnet —
# och en halv fil ser ut som ett giltigt facit. Bevis i repots logs/ efter de
# två hårdstoppade körningarna: app-20260819-003935.log = 0 byte och
# app-20260816-160407.log = exakt 1 048 576 byte (1 MiB, avhugget mitt i en
# OneDrive-skrivning) medan live-originalen är 1 512 850 respektive 2 589 994
# byte. Skriv-till-temp + mv byter målet i ETT steg (samma filsystem): läsaren
# ser antingen den gamla eller den nya filen, aldrig en halv.
sync_file() {
    local src dst tmp
    src="$1"; dst="$2"
    [ -f "$src" ] || return 0
    tmp="$(dirname "$dst")/.$(basename "$dst").tmp.$$.$RANDOM"
    if cp -f "$src" "$tmp" 2>/dev/null && mv -f "$tmp" "$dst" 2>/dev/null; then
        return 0
    fi
    rm -f "$tmp" 2>/dev/null || true
    return 1
}

# REPLAY-FÅNGSTEN (K24) — EN skrivare, härledd ur loggen, alltid atomisk.
#
# FÖRR: `... | tee "$LOGFILE" | tee >(grep ... | sed ... >> "$AIS_REPLAY_FILE")`.
# Processubstitutionen väntas ALDRIG in av skalet, och grep|sed är blockbuffrad
# när utdata går till en fil. Vid hård stopp dog pipelinen med upp till 4 KiB
# osparat: nattkörningen 2026-08-19 fick 24 576 byte = exakt 6×4096, 99 hela
# rader mot loggens 146 sampel — 32 % av rådatafacit borta, utan ett enda
# varningsspår.
#
# NU: loggen är den enda strömmen (tee skriver rad för rad, direkt), och
# jsonl:en HÄRLEDS ur loggen med exakt samma grep+sed som förut. Vinster:
#   1. ingen buffert kan tappa något — grep|sed körs till EOF varje gång,
#   2. skrivningen är atomisk (temp + mv), så filen är aldrig halv,
#   3. jsonl ⊆ logg per konstruktion, vilket är precis det grinden nedan mäter,
#   4. filen kan när som helst byggas om ur loggen om något ändå går fel.
# VERIFIERAT byte-identiskt mot den gamla vägen på dygnets huvudkörning:
# grep+sed över app-20260819-081250.log ger 1348 rader som `cmp` säger är
# identiska med den fältfångade ais-replay-20260819-081250.jsonl.
# LC_ALL=C: samma läxa som summaryn nedan (fältprov 1) — GNU grep under
# UTF-8-locale kan hoppa över rader med ogiltiga byte-sekvenser.
rebuild_replay_jsonl() {
    local tmp grep_status
    [ -f "$LOGFILE" ] || return 0
    tmp="$LIVE_DIR/.ais-replay-$TIMESTAMP.jsonl.tmp.$$.$RANDOM"
    LC_ALL=C grep 'AIS_REPLAY_SAMPLE' "$LOGFILE" 2>/dev/null \
      | sed 's/^.*AIS_REPLAY_SAMPLE\] //' > "$tmp" 2>/dev/null
    grep_status=${PIPESTATUS[0]}
    # grep 1 = "inga träffar än" (normalt de första minuterna) och ska ge en
    # tom fil; allt >1 är ett riktigt läsfel och får INTE skriva över facit.
    if [ "$grep_status" -le 1 ]; then
        mv -f "$tmp" "$AIS_REPLAY_FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
    else
        rm -f "$tmp" 2>/dev/null || true
    fi
}

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
  kill -0 "$MAIN_PID" 2>/dev/null || exit 0
  # K24: vakten läser LOGGEN, inte jsonl:en. Loggen är källan — jsonl:en byggs
  # ur den med jämna mellanrum, så en tom jsonl kunde förr betyda två helt
  # olika saker (fel debug_level ELLER trasig fångstväg) och vakten sa alltid
  # det första. Nu skiljs felen åt.
  #
  # ORDNINGEN ÄR HELA POÄNGEN (granskningsfynd 2026-08-21): räkna sampel
  # FÖRST, bygg om SEDAN, döm SIST. Förr sov vakten 120 s och läste en jsonl
  # som den periodiska loopen ansvarade för — en ren kapplöpning som kunde
  # skrika "fångstvägen skriver inte" på en fullt frisk körning. Nu är vakten
  # inte längre beroende av loopens tidtabell: ombyggnaden här täcker allt som
  # räknats, och att vakten själv bygger om är samtidigt det skarpaste provet
  # på fångstvägen — lyckas inte skrivningen här är den verkligen trasig.
  SAMPLES=$(LC_ALL=C grep -c 'AIS_REPLAY_SAMPLE' "$LOGFILE" 2>/dev/null)
  case "$SAMPLES" in ''|*[!0-9]*) SAMPLES=0 ;; esac
  rebuild_replay_jsonl
  if [ "$SAMPLES" -eq 0 ]; then
    echo ""
    echo "🚨🚨 [REPLAY-VAKT] Inga [AIS_REPLAY_SAMPLE]-rader efter 2 minuter!"
    echo "🚨🚨 Kontrollera att debug_level='full' i appens inställningar,"
    echo "🚨🚨 annars blir replay-filen tom och körningen oanalyserbar."
    echo ""
  elif [ ! -s "$AIS_REPLAY_FILE" ]; then
    echo ""
    echo "🚨🚨 [REPLAY-VAKT] Loggen har $SAMPLES sampel men jsonl-filen är TOM!"
    echo "🚨🚨 Fångstvägen (rebuild_replay_jsonl) skriver inte — kontrollera"
    echo "🚨🚨 skrivrättigheter i $LIVE_DIR. Körningen kan inte korpuslåsas."
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
    kill -0 "$MAIN_PID" 2>/dev/null || exit 0
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
# K24: samma loop bygger dessutom om jsonl:en ur loggen med jämna mellanrum.
#
# INTERVALLET ÄR MÄTT, INTE GISSAT (2026-08-21): ombyggnaden är en FULL
# grep+sed över hela loggen, och grep ligger på ~50 MB/s på den här maskinen
# (mätt tre varv vardera: 15,6 MB fältlogg = 0,30 s, 30,5 MB = 0,63 s). En
# dygnskörning växer till 15–70 MB, så var 60:e sekund kostar ~1440 pass ×
# halva slutstorleken ≈ 3,6 min CPU/dygn för en 15 MB-logg och ~29 min för en
# 70 MB-logg — där de sista passen tar över en sekund var, på samma maskin som
# ska mata tee-röret (fältprov 4 tappade loggrader just när röret stallade).
# 300 s ger samma skydd för en femtedel av arbetet.
#
# INKREMENTELL APPEND VALDES BORT: att bara läsa nya byte och lägga till med
# ">>" är billigare, men en hård stopp mitt i en append lämnar en HALV sista
# rad — exakt det haveri K24 finns till för att utrota. Full ombyggnad + mv
# byter filen i ETT steg och kan aldrig ge en halv rad.
# DET SOM STÅR PÅ SPEL vid glesare intervall är bara bekvämlighet: loggen är
# alltid hel, jsonl ⊆ logg gäller per konstruktion, och nedstängningen bygger
# om filen en sista gång i ALLA avslutsvägar. Bara vid SIGKILL/strömavbrott
# kan jsonl:en sakna upp till 5 minuter, och byggs då om ur loggen med
# enradskommandot i docs/VALIDATION.md steg 2.
# 2 = 2×300 s, dvs exakt de 600 s synken hade förut. Synken är atomisk.
(
  ticks=0
  while true; do
    sleep 300
    # Föräldralös loop (granskningsfynd 2026-08-21): dör huvudskriptet utan att
    # hinna städa (SIGKILL) skulle den här annars mala vidare i evighet.
    kill -0 "$MAIN_PID" 2>/dev/null || exit 0
    rebuild_replay_jsonl
    ticks=$((ticks + 1))
    if [ $((ticks % 2)) -eq 0 ]; then
      sync_file "$LOGFILE" "$FINAL_LOGFILE" || true
      sync_file "$AIS_REPLAY_FILE" "$FINAL_REPLAY" || true
    fi
  done
) &
SYNC_PID=$!

# K24: EXIT-trap:en ensam är INTE tillräcklig. Två fel bevisade i riggen:
#  (1) en icke-interaktiv bash som tar emot SIGINT UTAN egen INT-hanterare dör
#      där och då — EXIT-trap:en körs aldrig (två identiska Ctrl+C-körningar,
#      den ena fick summary, den andra inte);
#  (2) en signal som kommer medan EXIT-trap:en redan startat servas vid nästa
#      kommandogräns MITT I nedstängningen och avbryter den (mätt: TERM-trap:en
#      fyrade med EXTRACT_DONE redan satt till 1, och summaryn uteblev).
# Båda ger nattkörningens signatur 2026-08-19: ingen summary, alltså inget
# integritetsverdikt, alltså en trunkerad jsonl som ingen grind stoppar.
# Därför: egna INT/TERM/HUP-trap:ar som avväpnar ALLA trap:ar innan de gör
# något, och en nedstängning (finish_run) som gör samma sak på sin första rad.
#
# AVSLUTSKODERNA, MÄTTA I RIGG 2026-08-21 (inte antagna): Ctrl+C ⇒ 130 (3/3),
# `kill` ⇒ 143, `kill -HUP <pid>` ⇒ 129, dvs 128 + signalnummer. MEN får hela
# processgruppen signalen — så gör en stängd terminal — dör tee av signalen,
# pipelinen tar slut och `wait` returnerar innan trap:en hinner servas; då
# går skriptet den NORMALA vägen och koden blir 0 (3/3). Samma nedstängning,
# samma summary, samma verdikt i båda fallen: det är utfallet som räknas, och
# koden är bara ärlig om HUR körningen tog slut.
EXTRACT_DONE=0
PIPE_PID=""
APP_PID=""

# STOPPA FÅNGSTEN INNAN SUMMARYN MÄTER (granskningsfynd 2026-08-21).
# Appen får TERM, och sedan väntar vi in tee: när appen dör får röret EOF och
# tee skriver klart av sig själv, så loggen är komplett när grinden läser den.
# Utan det här steget skulle `kill <skriptets pid>` lämna kvar en föräldralös
# `homey app run` som fortsätter mata en tee vars förälder är borta.
stop_capture() {
    local killer
    [ -n "$PIPE_PID" ] || return 0
    [ -n "$APP_PID" ] && kill -TERM "$APP_PID" 2>/dev/null
    # Nödbroms: skulle appen ignorera TERM får den 10 s innan KILL — annars
    # kunde nedstängningen hänga för alltid i wait nedan.
    (
      sleep 10
      [ -n "$APP_PID" ] && kill -KILL "$APP_PID" 2>/dev/null
      kill -TERM "$PIPE_PID" 2>/dev/null
    ) &
    killer=$!
    # tee avslutar själv när appen dött (EOF) — då är loggen komplett.
    wait "$PIPE_PID" 2>/dev/null || true
    # -KILL, inte -TERM: nödbromsen väntar på sitt `sleep`-barn, och bash
    # skjuter upp en TERMinerande signal tills förgrundskommandot är klart
    # (exakt samma regel som gjorde att `kill <pid>` hängde hela skriptet).
    # Med KILL dör subskalet direkt; dess `sleep` blir en tom process som
    # bara löper ut — nödbromsens kill-kommandon körs aldrig, så en
    # återanvänd pid kan inte träffas av misstag.
    kill -KILL "$killer" 2>/dev/null || true
    PIPE_PID=""
}

# Temp-filer för DENNA körning. Egen funktion så att varje avslutsväg städar,
# inte bara den normala (granskningsfynd 2026-08-21: städningen låg mitt inne
# i extract_bridge_text och kunde hoppas över).
cleanup_run_tempfiles() {
    rm -f "$LIVE_DIR"/.ais-replay-"$TIMESTAMP".jsonl.tmp.* \
          "$LOGS_DIR"/.app-"$TIMESTAMP".log.tmp.* \
          "$LOGS_DIR"/.ais-replay-"$TIMESTAMP".jsonl.tmp.* \
          "$LOGS_DIR"/.bridge-text-summary-"$TIMESTAMP".md.tmp.* 2>/dev/null || true
}

# Allt som ska hända vid avslut, i ordning och exakt en gång.
finish_run() {
    # Avväpna direkt: en signal som anländer MITT I nedstängningen ska varken
    # avbryta den eller starta om den (K24:s bonusfynd — TERM-trap:en fyrade
    # en gång med EXTRACT_DONE redan satt, och summaryn uteblev).
    trap '' INT TERM HUP
    stop_capture
    extract_bridge_text
    cleanup_run_tempfiles
}

shutdown_and_exit() {
    # Först av allt: koppla bort varenda trap. En andra Ctrl+C, en kvarliggande
    # signal eller EXIT-trap:en efteråt får varken avbryta eller köra om
    # nedstängningen.
    trap '' INT TERM HUP EXIT
    finish_run
    exit "$1"
}

# Funktion för att extrahera bridge text updates när appen stoppas
extract_bridge_text() {
    # ALLRA FÖRST (K24): nedstängningen ska inte gå att avbryta halvvägs.
    trap '' INT TERM HUP
    if [ "$EXTRACT_DONE" -eq 1 ]; then
        return 0
    fi
    EXTRACT_DONE=1
    # Fältprov 1 (2026-08-02): GNU grep under UTF-8-locale (LANG=en_US.UTF-8
    # i Git Bash) matchar INTE emoji-mönstren (📱 U+1F4F1) — summaryn
    # rapporterade permanent 0 uppdateringar trots träffar i loggen, och det
    # är artefakten körboken kräver för korpuslåsning. LC_ALL=C ger ren
    # bytematchning och alla mönster träffar igen.
    export LC_ALL=C
    # -KILL, inte -TERM: två av loopvakterna kan stå MITT I en ombyggnad
    # (rebuild_replay_jsonl), och bash skjuter upp en terminerande signal tills
    # det pågående förgrundskommandot är klart. En uppskjuten `mv` skulle då
    # landa EFTER att grinden nedan mätt filen och kunna ersätta den kompletta
    # jsonl:en med en äldre, kortare — summaryn skulle beskriva en fil som inte
    # längre finns. Med KILL dör skalet direkt och ingen `mv` kan köras; en
    # halvskriven temp-fil städas av cleanup_run_tempfiles.
    kill -KILL "$REPLAY_GUARD_PID" 2>/dev/null || true
    kill -KILL "$HOLE_GUARD_PID" 2>/dev/null || true
    kill -KILL "$SYNC_PID" 2>/dev/null || true
    echo ""
    echo "🔍 Genererar bridge text summary..."

    # SLUTLIG FÅNGST (K24): bygg jsonl:en ur den färdiga loggen INNAN grinden
    # mäter. Kör till EOF i förgrunden — inget kan ligga kvar i en buffert.
    rebuild_replay_jsonl

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
    # Rubriken namnger BÅDA grindarna (granskningsfynd 2026-08-21): sektionen
    # bar kvar namnet "håldetektor" fast den sedan K24 innehåller tidshål,
    # replay-fångst och ett samlat verdikt.
    echo "## Logg-integritet (tidshål + replay-fångst)" >> "$BRIDGE_TEXT_SUMMARY"
    echo "" >> "$BRIDGE_TEXT_SUMMARY"
    # Fältprov 2 (2026-08-02): den gamla awk:en jämförde ENDAST rader inom
    # samma datum (`if (prevd == d && ...)`), så varje hål som spände över
    # midnatt rapporterades aldrig — och ett 48h-fältprov passerar midnatt
    # två gånger. Dagsräknaren nedan ger en monoton sekundskala över
    # dygnsgränser (loggen är kronologisk, så varje datumbyte = +1 dygn).
    HOLES=$(grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' "$LOGFILE" | \
      awk -F'[T:]' '{
        t = $2*3600 + $3*60 + $4; d = $1;
        if (prevd != "" && d != prevd) daycount++;
        tabs = t + daycount*86400;
        if (prevt != "" && tabs - prevt > 180)
          printf "- HÅL: %s → %s (%d s utan loggrader)\n", prev, $0, tabs - prevt;
        prevt = tabs; prevd = d; prev = $0;
      }')
    INTEGRITY_FAIL=0
    if [ -n "$HOLES" ]; then
        INTEGRITY_FAIL=1
        echo "⚠️ **TIDSHÅL FUNNA — körningen är OFULLSTÄNDIG och får inte korpuslåsas:**" >> "$BRIDGE_TEXT_SUMMARY"
        echo "" >> "$BRIDGE_TEXT_SUMMARY"
        echo "$HOLES" >> "$BRIDGE_TEXT_SUMMARY"
        echo ""
        echo "🚨🚨 [HÅLVAKT] Tidshål funna i loggen — se $BRIDGE_TEXT_SUMMARY"
        echo "$HOLES"
    else
        echo "✅ Inga tidshål >180 s — loggens tidslinje är obruten." >> "$BRIDGE_TEXT_SUMMARY"
    fi

    # REPLAY-INTEGRITET (K24, fältprov 10 2026-08-21): håldetektorn ovan läser
    # BARA loggen. Nattkörningen 2026-08-19 hade en obruten tidslinje och hade
    # alltså passerat grinden — men jsonl:en bar 99 av loggens 146 sampel.
    # Facit kan vara trunkerat även när loggen är hel, så de två räknas nu mot
    # varandra: en jsonl-rad per [AIS_REPLAY_SAMPLE]-rad, varken fler
    # (dubbelskrivning) eller färre (tappad fångst).
    echo "" >> "$BRIDGE_TEXT_SUMMARY"
    echo "### Replay-fångst (jsonl mot logg)" >> "$BRIDGE_TEXT_SUMMARY"
    echo "" >> "$BRIDGE_TEXT_SUMMARY"

    LOG_SAMPLES=$(grep -c 'AIS_REPLAY_SAMPLE' "$LOGFILE" 2>/dev/null)
    case "$LOG_SAMPLES" in ''|*[!0-9]*) LOG_SAMPLES=0 ;; esac
    # wc -l räknar radbrytningar = KOMPLETTA rader. Ett avhugget svansfragment
    # utan avslutande \n räknas alltså inte med — precis det vi vill mäta.
    JSONL_LINES=$(wc -l < "$AIS_REPLAY_FILE" 2>/dev/null | tr -d '[:space:]')
    case "$JSONL_LINES" in ''|*[!0-9]*) JSONL_LINES=0 ;; esac
    JSONL_BYTES=$(wc -c < "$AIS_REPLAY_FILE" 2>/dev/null | tr -d '[:space:]')
    case "$JSONL_BYTES" in ''|*[!0-9]*) JSONL_BYTES=0 ;; esac

    # Kommandosubstitution kapar avslutande radbrytningar: är sista byten \n
    # blir resultatet TOMT. Icke-tomt ⇒ filen slutar mitt i en rad.
    REPLAY_FAIL=0
    TAIL_NOTE="ja"
    if [ "$JSONL_BYTES" -gt 0 ] && [ -n "$(tail -c 1 "$AIS_REPLAY_FILE" 2>/dev/null)" ]; then
        TAIL_NOTE="**NEJ — sista raden är AVHUGGEN**"
        REPLAY_FAIL=1
    fi
    # Sista kompletta raden ska vara ett helt JSON-objekt ({...}).
    LAST_LINE=$(tail -n 1 "$AIS_REPLAY_FILE" 2>/dev/null)
    LAST_JSON_OK=1
    if [ "$JSONL_LINES" -gt 0 ]; then
        case "$LAST_LINE" in
            '{'*'}') ;;
            *) LAST_JSON_OK=0; REPLAY_FAIL=1 ;;
        esac
    fi

    echo "- Sampel i loggen (\`AIS_REPLAY_SAMPLE\`): **$LOG_SAMPLES**" >> "$BRIDGE_TEXT_SUMMARY"
    echo "- Kompletta rader i jsonl: **$JSONL_LINES**" >> "$BRIDGE_TEXT_SUMMARY"
    echo "- Filstorlek: $JSONL_BYTES B — slutar med radbrytning: $TAIL_NOTE" >> "$BRIDGE_TEXT_SUMMARY"
    if [ "$LAST_JSON_OK" -eq 0 ]; then
        echo "- ⚠️ sista raden i filen är inte ett helt JSON-objekt" >> "$BRIDGE_TEXT_SUMMARY"
    fi

    if [ "$LOG_SAMPLES" -eq 0 ]; then
        REPLAY_FAIL=1
        echo "- ⚠️ loggen saknar [AIS_REPLAY_SAMPLE]-rader helt — debug_level var inte 'full'" >> "$BRIDGE_TEXT_SUMMARY"
    elif [ "$JSONL_LINES" -lt "$LOG_SAMPLES" ]; then
        REPLAY_FAIL=1
        echo "- ⚠️ $((LOG_SAMPLES - JSONL_LINES)) av $LOG_SAMPLES sampel SAKNAS i jsonl:en" >> "$BRIDGE_TEXT_SUMMARY"
    elif [ "$JSONL_LINES" -gt "$LOG_SAMPLES" ]; then
        REPLAY_FAIL=1
        echo "- ⚠️ $((JSONL_LINES - LOG_SAMPLES)) FLER rader än loggens sampel — dubbelskrivning?" >> "$BRIDGE_TEXT_SUMMARY"
    fi

    # Node-kontrollen jämför dessutom rad för rad och validerar JSON:en.
    # Skalgrinden ovan är den bindande — den fungerar även utan node.
    REPLAY_CHECKER="$SCRIPT_DIR/tests/replay-validation/checkReplayIntegrity.js"
    if command -v node >/dev/null 2>&1 && [ -f "$REPLAY_CHECKER" ]; then
        CHECK_OUT=$(node "$REPLAY_CHECKER" "$AIS_REPLAY_FILE" "$LOGFILE" --brief 2>&1)
        CHECK_STATUS=$?
        echo "" >> "$BRIDGE_TEXT_SUMMARY"
        echo "$CHECK_OUT" >> "$BRIDGE_TEXT_SUMMARY"
        if [ "$CHECK_STATUS" -ne 0 ]; then
            REPLAY_FAIL=1
        fi
    fi

    # SAMLAT VERDIKT — körboken (docs/VALIDATION.md steg 5) kräver strängen
    # "Logg-integritet: OK" för att en körning ska få låsas som korpus.
    echo "" >> "$BRIDGE_TEXT_SUMMARY"
    if [ "$INTEGRITY_FAIL" -eq 0 ] && [ "$REPLAY_FAIL" -eq 0 ]; then
        echo "✅ **Logg-integritet: OK** — obruten tidslinje och komplett replay-fångst (korpuslåsning tillåten)." >> "$BRIDGE_TEXT_SUMMARY"
    else
        echo "🚨 **Logg-integritet: FEL** — körningen är OFULLSTÄNDIG: **korpuslåsning EJ tillåten**." >> "$BRIDGE_TEXT_SUMMARY"
        echo ""
        echo "🚨🚨 [INTEGRITET] Logg-integritet: FEL — korpuslåsning EJ tillåten"
        echo "🚨🚨 Loggen har $LOG_SAMPLES sampel, jsonl:en $JSONL_LINES kompletta rader."
        echo "🚨🚨 Se $FINAL_SUMMARY"
        echo ""
    fi

    # SLUTSYNK (F4-A): flytta allt till OneDrive-mappen — samma namn/plats som
    # tidigare arbetsflöden förväntar sig. K24: atomiskt (se sync_file).
    sync_file "$LOGFILE" "$FINAL_LOGFILE" || echo "⚠️ Kunde inte synka $FINAL_LOGFILE"
    sync_file "$AIS_REPLAY_FILE" "$FINAL_REPLAY" || echo "⚠️ Kunde inte synka $FINAL_REPLAY"
    sync_file "$BRIDGE_TEXT_SUMMARY" "$FINAL_SUMMARY" || echo "⚠️ Kunde inte synka $FINAL_SUMMARY"
    # Temp-filerna städas av cleanup_run_tempfiles direkt efter den här
    # funktionen (finish_run), så att även en halvvägs avbruten summary städas.

    echo "✅ Bridge text summary skapad: $FINAL_SUMMARY"
    echo "✅ AIS replay logg skapad: $FINAL_REPLAY"
    echo "✅ App-logg synkad: $FINAL_LOGFILE"
}

# Sätt trap för att köra bridge text extraction när scriptet avbryts.
# K24: INT/TERM/HUP hanteras uttryckligen — Ctrl+C, `kill` och stängd terminal
# är de tre sätt ett fältprov faktiskt tar slut på, och alla tre måste ge en
# fullständig jsonl + ett integritetsverdikt. Att trap:arna FYRAR kräver
# dessutom att appen körs i bakgrunden med `wait` (se körraden längst ned) —
# annars servas signalen först när förgrundskommandot är klart.
trap finish_run EXIT
trap 'shutdown_and_exit 130' INT
trap 'shutdown_and_exit 143' TERM
trap 'shutdown_and_exit 129' HUP

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

# K24: EN ström, EN skrivare. tee skriver loggen rad för rad (ingen buffert
# som kan dö med processen) och vidare till terminalen. jsonl:en byggs ur
# loggen av rebuild_replay_jsonl — var 300:e sekund under körningen och
# slutgiltigt i nedstängningen. Appens egen fångstväg pekar på en SEPARAT fil
# (APP_SIDE_REPLAY_FILE) så två skrivare aldrig kan mötas i samma jsonl.
#
# BAKGRUND + wait (granskningsfynd 2026-08-21): bash servar en trappad signal
# FÖRST när det aktuella FÖRGRUNDSkommandot är klart. Med pipelinen i
# förgrunden sköts därför TERM-trap:en upp tills `homey app run` tog slut —
# alltså aldrig. REPRODUCERAT i rigg: `kill -TERM <skriptets pid>` lämnade
# skriptet loggande i 2,5 minuter utan en enda summary, medan det FÖRE K24
# åtminstone dog direkt (default disposition). `wait` däremot AVBRYTS av en
# trappad signal, och då fyrar INT/TERM/HUP omedelbart.
# `jobs -p %+` ger pid:en för pipelinens FÖRSTA process (appen) — `$!` är
# tee, sist i röret. Nedstängningen behöver appens pid för att kunna stoppa
# den och sedan låta tee skriva klart på EOF.
AIS_REPLAY_CAPTURE_FILE="$APP_SIDE_REPLAY_FILE" "${HOMEY_CMD[@]}" 2>&1 | tee "$LOGFILE" &
PIPE_PID=$!
APP_PID=$(jobs -p %+ 2>/dev/null | head -1)
case "$APP_PID" in ''|*[!0-9]*) APP_PID="" ;; esac
wait "$PIPE_PID"
# Pipelinen är slut och redan inväntad — nedstängningen ska inte leta efter den.
PIPE_PID=""

echo "Loggar sparade i: $FINAL_LOGFILE"
