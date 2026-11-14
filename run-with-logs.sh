#!/bin/bash

# Välj samma befintliga arkiv som replayverktygen, oberoende av aktuell katalog.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
if [ -d "$SCRIPT_DIR/../logs" ]; then
  LOGS_DIR="$SCRIPT_DIR/../logs"
elif [ -d "$SCRIPT_DIR/dirigent/logs" ]; then
  LOGS_DIR="$SCRIPT_DIR/dirigent/logs"
else
  # Ny installation: behåll det ursprungliga arkivet bredvid repot.
  LOGS_DIR="$SCRIPT_DIR/../logs"
  mkdir -p "$LOGS_DIR" || exit 1
fi
LOGS_DIR="$(cd "$LOGS_DIR" && pwd)" || exit 1

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
    # Parameterexpansion, inte $(dirname)/$(basename) (revision 1 av V4): en
    # kommandosubstitution gafflar skalet, och har en tidigare inbyggd skrivning
    # till en död terminal misslyckats ärver gaffeln bash 3.2:s stdout-buffert
    # och skriver ut den i substitutionens värde. Temp-sökvägen fick då en
    # radbrytning och skräptext, cp föll och slutsynken blev FEL.
    tmp="${dst%/*}/.${dst##*/}.tmp.$$.$RANDOM"
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
    local tmp
    local -a extract_status
    [ -f "$LOGFILE" ] || return 0
    tmp="$LIVE_DIR/.ais-replay-$TIMESTAMP.jsonl.tmp.$$.$RANDOM"
    LC_ALL=C grep 'AIS_REPLAY_SAMPLE' "$LOGFILE" 2>/dev/null \
      | sed 's/^.*AIS_REPLAY_SAMPLE\] //' > "$tmp" 2>/dev/null
    extract_status=("${PIPESTATUS[@]}")
    # grep 1 = "inga träffar än" (normalt de första minuterna) och ska ge en
    # tom fil. Både läsningen och sed-skrivningen måste lyckas: ett diskfel
    # efter grep kan annars ersätta en hel fil med ett atomiskt bytt fragment.
    if [ "${extract_status[0]}" -le 1 ] && [ "${extract_status[1]}" -eq 0 ]; then
        mv -f "$tmp" "$AIS_REPLAY_FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
    else
        rm -f "$tmp" 2>/dev/null || true
    fi
    # Starttillståndet har en egen fil: AIS-jsonl förblir råa, oförändrade fix.
    # Första booten är facit för denna körnings början.
    local state_tmp
    state_tmp="$LIVE_DIR/.ais-state-$TIMESTAMP.tmp.$$.$RANDOM"
    LC_ALL=C grep -m 1 'AIS_REPLAY_STATE]' "$LOGFILE" 2>/dev/null \
      | sed 's/^.*AIS_REPLAY_STATE\] //' > "$state_tmp" 2>/dev/null
    extract_status=("${PIPESTATUS[@]}")
    if [ "${extract_status[0]}" -eq 0 ] && [ "${extract_status[1]}" -eq 0 ] && [ -s "$state_tmp" ]; then
        mv -f "$state_tmp" "${AIS_REPLAY_FILE%.jsonl}.state.json" 2>/dev/null || true
    fi
    rm -f "$state_tmp" 2>/dev/null || true

}

# Varje stat-försök behöver en egen fångst. GNU tolkar BSD:s -f som
# filsystemsstatus och kan skriva text till stdout ÄVEN när anropet misslyckas.
file_mtime() {
    local mtime
    if mtime=$(stat -f %m "$1" 2>/dev/null) || mtime=$(stat -c %Y "$1" 2>/dev/null); then
        case "$mtime" in ''|*[!0-9]*) return 1 ;; esac
        printf '%s\n' "$mtime"
    else
        return 1
    fi
}

# Kalenderdagar gör även helt saknade dygn synliga. POSIX awk saknar en
# portabel mktime, så räkna gregorianska dagar med sekelskiftets skottårsregel.
#
# HÅLGRÄNSEN FÖLJER HJÄRTSLAGET (V4, fältprovet 2026-11-13). Loggvägen
# Homey → homey CLI tappade fem block om 88–156 s, och 180 s missade alla
# fem. Monitoringloopen skriver [COORDINATION_CLEANUP] ovillkorligt varje
# minut från debugnivå detailed; där den är belagd är gränsen 60 s + 5 s
# marginal = 65 s (mätt: största normala lucka 54,6 s på 66 h fältlogg med
# full debugnivå). Utan belagt hjärtslag (basic/off: normala luckor upp till
# ~70 s) gäller 180 s som förut. Boot och ändrad debugnivå nollar
# hjärtslaget. Samma regel som node-grinden (checkReplayIntegrity.js,
# createTimeGapAudit). Gränserna kan sättas med HOLE_LIMIT_HEARTBEAT_S och
# HOLE_LIMIT_S; standardvärdena står här så att funktionen fungerar fristående.
find_log_holes() {
    local hb_limit="${HOLE_LIMIT_HEARTBEAT_S:-65}" base_limit="${HOLE_LIMIT_S:-180}"
    LC_ALL=C awk -v hb_limit="$hb_limit" -v base_limit="$base_limit" '
        function calendar_day(date, parts, year, month, previous_year) {
          split(date, parts, "-");
          year = parts[1] + 0; month = parts[2] + 0; previous_year = year - 1;
          return 365*previous_year + int(previous_year/4) - int(previous_year/100) \
            + int(previous_year/400) + month_start[month] + parts[3] \
            + (month > 2 && year % 4 == 0 && (year % 100 != 0 || year % 400 == 0));
        }
        BEGIN { split("0 31 59 90 120 151 181 212 243 273 304 334", month_start, " "); hb = 0; }
        /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/ {
          stamp = substr($0, 1, 19);
          split(stamp, f, "[T:]");
          # Millisekunderna räknas med (rev 1): node-grinden mäter i ms, och
          # med hela sekunder kunde en lucka på 65,1–65,99 s bli 65 här men
          # 65,x där. Nu dömer skal och node exakt lika, och luckan skrivs med
          # en decimal (rev 2), så att 65,2 s inte ser ut att ligga på gränsen.
          frac = (substr($0, 20, 1) == "." && substr($0, 21, 3) ~ /^[0-9][0-9][0-9]$/) ? substr($0, 21, 3) / 1000 : 0;
          tabs = calendar_day(f[1])*86400 + f[2]*3600 + f[3]*60 + f[4] + frac;
          limit = hb ? hb_limit : base_limit;
          if (prevt != "" && tabs - prevt > limit)
            printf "- HÅL: %s → %s (%.1f s utan loggrader)\n", prev, stamp, tabs - prevt;
          prevt = tabs; prev = stamp;
          if (index($0, "AIS Bridge starting with modular architecture") || index($0, "Debug level changed to:")) hb = 0;
          if (index($0, "[COORDINATION_CLEANUP]")) hb = 1;
        }' "$1"
}

# Hålgränsen just nu för livevakten, ur loggens svans (1 MiB räcker till flera
# minuter även i loggens tätaste minuter, ~100 kB/min). Samma regel som
# find_log_holes: 65 s bara om den SISTA av raderna hjärtslag, nivåbyte och
# boot är ett hjärtslag. Revision 1 av V4: förr räckte det att ett hjärtslag
# fanns någonstans i svansen, och efter en sänkning till basic (loggen växer då
# ~40 KiB/h) låg det kvar där i ungefär ett dygn, med falsklarm som följd.
current_hole_limit() {
    local last
    last=$(tail -c 1048576 "$1" 2>/dev/null \
      | LC_ALL=C grep -E 'COORDINATION_CLEANUP|Debug level changed to:|AIS Bridge starting with modular architecture' \
      | tail -n 1)
    case "$last" in
        *COORDINATION_CLEANUP*) printf '%s\n' "${HOLE_LIMIT_HEARTBEAT_S:-65}" ;;
        *) printf '%s\n' "${HOLE_LIMIT_S:-180}" ;;
    esac
}

# Terminalutskrift som aldrig kan fälla nedstängningen (V4): när terminalen
# är borta (utloggning, stängt fönster) ger en skrivning EIO eller SIGPIPE.
# EXTERN printf med flit: bash inbyggda printf/echo behåller en misslyckad
# skrivning i sin stdout-buffert och skriver ut den vid nästa omdirigerade
# skrivning (uppmätt: terminaltexten hamnade i nästa fil som skrevs med >>).
# I nedstängningen är nästa fil summaryn.
say() {
    env printf '%s\n' "$*" 2>/dev/null || true
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
    say ""
    say "🚨🚨 [REPLAY-VAKT] Inga [AIS_REPLAY_SAMPLE]-rader efter 2 minuter!"
    say "🚨🚨 Kontrollera att debug_level='full' i appens inställningar,"
    say "🚨🚨 annars blir replay-filen tom och körningen oanalyserbar."
    say ""
  elif [ ! -s "$AIS_REPLAY_FILE" ]; then
    say ""
    say "🚨🚨 [REPLAY-VAKT] Loggen har $SAMPLES sampel men jsonl-filen är TOM!"
    say "🚨🚨 Fångstvägen (rebuild_replay_jsonl) skriver inte — kontrollera"
    say "🚨🚨 skrivrättigheter i $LIVE_DIR. Körningen kan inte korpuslåsas."
    say ""
  fi
) &
REPLAY_GUARD_PID=$!

# HÅLDETEKTOR, runtime (F4-A, gräns V4 2026-11-13): på debugnivå detailed/full
# skriver monitoringloopen [COORDINATION_CLEANUP] varje minut, så en logg som
# inte växt på 65 s tappar rader (CLI-strömmen eller röret). Utan belagt
# hjärtslag gäller 180 s. Larma direkt i terminalen. homey CLI varnar INTE
# själv när strömmen bryts (dess disconnect-hanterare anropas aldrig), så det
# här är det enda livelarmet.
(
  sleep 240
  while true; do
    kill -0 "$MAIN_PID" 2>/dev/null || exit 0
    if [ -f "$LOGFILE" ]; then
      NOW=$(date +%s)
      MTIME=$(file_mtime "$LOGFILE") || MTIME=$NOW
      AGE=$((NOW - MTIME))
      LIMIT=$(current_hole_limit "$LOGFILE")
      if [ "$AGE" -gt "$LIMIT" ]; then
        say ""
        say "🚨🚨 [HÅLVAKT] Loggfilen har inte växt på ${AGE}s (>${LIMIT}s)!"
        say "🚨🚨 Monitoringloopen loggar varje minut på debugnivå detailed/full —"
        say "🚨🚨 rader tappas troligen (CLI-ström/rör). Loggen kan bli ofullständig."
        say ""
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
      sync_file "${AIS_REPLAY_FILE%.jsonl}.state.json" "${FINAL_REPLAY%.jsonl}.state.json" || true
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
          "$LIVE_DIR"/.bridge-text-summary-"$TIMESTAMP".md.tmp.* \
          "$LOGS_DIR"/.app-"$TIMESTAMP".log.tmp.* \
          "$LOGS_DIR"/.ais-replay-"$TIMESTAMP".jsonl.tmp.* \
          "$LOGS_DIR"/.bridge-text-summary-"$TIMESTAMP".md.tmp.* 2>/dev/null || true
}

# Allt som ska hända vid avslut, i ordning och exakt en gång.
finish_run() {
    # Avväpna direkt: en signal som anländer MITT I nedstängningen ska varken
    # avbryta den eller starta om den (K24:s bonusfynd — TERM-trap:en fyrade
    # en gång med EXTRACT_DONE redan satt, och summaryn uteblev).
    # PIPE/TTOU (V4, fältprovet 2026-11-13): när terminalen försvinner
    # (utloggning, stängt fönster) får en skrivning dit inte döda skriptet.
    trap '' INT TERM HUP PIPE TTOU
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
    trap '' INT TERM HUP PIPE TTOU
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

    # SLUTSYNK FÖRST (V4, fältprovet 2026-11-13). Körning 2 avslutades av en
    # macOS-uppdatering: utloggningen dödade skriptet EFTER summaryn men FÖRE
    # synken, och arkivet saknade loggens och jsonl:ens svans. Loggen är det
    # enda som inte kan återskapas, så den synkas allra först, sedan byggs
    # jsonl:en om och synkas. Först därefter den långsamma summaryn (node-
    # kontrollen tar sekunder på en dygnslogg). Dör skriptet i summaryn är
    # arkivet ändå komplett, och summaryn går att göra om ur filerna.
    FINAL_SYNC_STATUS="OK"
    sync_file "$LOGFILE" "$FINAL_LOGFILE" || FINAL_SYNC_STATUS="FEL"

    # SLUTLIG FÅNGST (K24): bygg jsonl:en ur den färdiga loggen INNAN grinden
    # mäter. Kör till EOF i förgrunden — inget kan ligga kvar i en buffert.
    rebuild_replay_jsonl
    sync_file "$AIS_REPLAY_FILE" "$FINAL_REPLAY" || FINAL_SYNC_STATUS="FEL"
    sync_file "${AIS_REPLAY_FILE%.jsonl}.state.json" "${FINAL_REPLAY%.jsonl}.state.json" || FINAL_SYNC_STATUS="FEL"
    if [ "$FINAL_SYNC_STATUS" != "OK" ]; then
        say "⚠️ Kunde inte synka logg/jsonl till $LOGS_DIR — live-filerna i $LIVE_DIR är kompletta"
    fi

    say ""
    say "🔍 Genererar bridge text summary..."

    # Summaryn skrivs till en temp-fil och byts in med mv (V4): en avbruten
    # summary lämnar ingen halv fil under det riktiga namnet.
    SUMMARY_TMP="$LIVE_DIR/.bridge-text-summary-$TIMESTAMP.md.tmp.$$"

    # Skapa bridge text summary (portable header expansion, macOS/BSD-friendly)
    GENERATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    SOURCE_NAME="${LOGFILE##*/}"
    cat > "$SUMMARY_TMP" << EOL
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
        echo "$line" >> "$SUMMARY_TMP"
        echo "" >> "$SUMMARY_TMP"
    done

    # Lägg till summary statistik
    echo "## Summary Statistics" >> "$SUMMARY_TMP"
    echo "" >> "$SUMMARY_TMP"

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

    echo "- **Total Bridge Text Updates:** $TOTAL_UPDATES" >> "$SUMMARY_TMP"
    echo "- **boat_near Notifications:** $NOTIFICATIONS" >> "$SUMMARY_TMP"
    echo "- **\"strax\"-Updates:** $STRAX_UPDATES" >> "$SUMMARY_TMP"
    echo "- **\"ETA okänd\"-Updates:** $ETA_UNKNOWN" >> "$SUMMARY_TMP"
    echo "- **\"Inga båtar\"-Updates:** $DEFAULT_UPDATES" >> "$SUMMARY_TMP"

    # HÅLDETEKTOR, efterhand (F4-A, gräns V4 2026-11-13): tidsstämpelluckor
    # över 65 s där monitoringloopens minutslag är belagt (annars 180 s) =
    # tappade rader, se find_log_holes. Resultatet skrivs i summaryn så en
    # ofullständig körning aldrig korpuslåses av misstag (körboken kräver
    # "Logg-integritet: OK" före låsning).
    echo "" >> "$SUMMARY_TMP"
    # Rubriken namnger BÅDA grindarna (granskningsfynd 2026-08-21): sektionen
    # bar kvar namnet "håldetektor" fast den sedan K24 innehåller tidshål,
    # replay-fångst och ett samlat verdikt.
    echo "## Logg-integritet (tidshål + replay-fångst)" >> "$SUMMARY_TMP"
    echo "" >> "$SUMMARY_TMP"
    HOLES=$(find_log_holes "$LOGFILE")
    INTEGRITY_FAIL=0
    if [ -n "$HOLES" ]; then
        INTEGRITY_FAIL=1
        echo "⚠️ **TIDSHÅL FUNNA — körningen är OFULLSTÄNDIG och får inte korpuslåsas:**" >> "$SUMMARY_TMP"
        echo "" >> "$SUMMARY_TMP"
        echo "$HOLES" >> "$SUMMARY_TMP"
        say ""
        say "🚨🚨 [HÅLVAKT] Tidshål funna i loggen — se $BRIDGE_TEXT_SUMMARY"
        say "$HOLES"
    else
        echo "✅ Inga tidshål (gräns 65 s med 60 s-hjärtslaget [COORDINATION_CLEANUP], annars 180 s) — loggens tidslinje är obruten." >> "$SUMMARY_TMP"
    fi

    # REPLAY-INTEGRITET (K24, fältprov 10 2026-08-21): håldetektorn ovan läser
    # BARA loggen. Nattkörningen 2026-08-19 hade en obruten tidslinje och hade
    # alltså passerat grinden — men jsonl:en bar 99 av loggens 146 sampel.
    # Facit kan vara trunkerat även när loggen är hel, så de två räknas nu mot
    # varandra: en jsonl-rad per [AIS_REPLAY_SAMPLE]-rad, varken fler
    # (dubbelskrivning) eller färre (tappad fångst).
    echo "" >> "$SUMMARY_TMP"
    echo "### Replay-fångst (jsonl mot logg)" >> "$SUMMARY_TMP"
    echo "" >> "$SUMMARY_TMP"

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

    echo "- Sampel i loggen (\`AIS_REPLAY_SAMPLE\`): **$LOG_SAMPLES**" >> "$SUMMARY_TMP"
    echo "- Kompletta rader i jsonl: **$JSONL_LINES**" >> "$SUMMARY_TMP"
    echo "- Filstorlek: $JSONL_BYTES B — slutar med radbrytning: $TAIL_NOTE" >> "$SUMMARY_TMP"
    if [ "$LAST_JSON_OK" -eq 0 ]; then
        echo "- ⚠️ sista raden i filen är inte ett helt JSON-objekt" >> "$SUMMARY_TMP"
    fi

    if [ "$LOG_SAMPLES" -eq 0 ]; then
        REPLAY_FAIL=1
        echo "- ⚠️ loggen saknar [AIS_REPLAY_SAMPLE]-rader helt — debug_level var inte 'full'" >> "$SUMMARY_TMP"
    elif [ "$JSONL_LINES" -lt "$LOG_SAMPLES" ]; then
        REPLAY_FAIL=1
        echo "- ⚠️ $((LOG_SAMPLES - JSONL_LINES)) av $LOG_SAMPLES sampel SAKNAS i jsonl:en" >> "$SUMMARY_TMP"
    elif [ "$JSONL_LINES" -gt "$LOG_SAMPLES" ]; then
        REPLAY_FAIL=1
        echo "- ⚠️ $((JSONL_LINES - LOG_SAMPLES)) FLER rader än loggens sampel — dubbelskrivning?" >> "$SUMMARY_TMP"
    fi

    # Node-kontrollen jämför dessutom rad för rad och validerar JSON:en.
    # Skalgrinden ovan är den bindande — den fungerar även utan node.
    REPLAY_CHECKER="$SCRIPT_DIR/tests/replay-validation/checkReplayIntegrity.js"
    if command -v node >/dev/null 2>&1 && [ -f "$REPLAY_CHECKER" ]; then
        CHECK_OUT=$(node "$REPLAY_CHECKER" "$AIS_REPLAY_FILE" "$LOGFILE" --brief 2>&1)
        CHECK_STATUS=$?
        echo "" >> "$SUMMARY_TMP"
        echo "$CHECK_OUT" >> "$SUMMARY_TMP"
        if [ "$CHECK_STATUS" -ne 0 ]; then
            REPLAY_FAIL=1
        fi
    fi

    # SAMLAT VERDIKT — körboken (docs/VALIDATION.md steg 5) kräver strängen
    # "Logg-integritet: OK" för att en körning ska få låsas som korpus.
    echo "" >> "$SUMMARY_TMP"
    if [ "$INTEGRITY_FAIL" -eq 0 ] && [ "$REPLAY_FAIL" -eq 0 ]; then
        echo "✅ **Logg-integritet: OK** — obruten tidslinje och komplett replay-fångst (korpuslåsning tillåten)." >> "$SUMMARY_TMP"
    else
        echo "🚨 **Logg-integritet: FEL** — körningen är OFULLSTÄNDIG: **korpuslåsning EJ tillåten**." >> "$SUMMARY_TMP"
        say ""
        say "🚨🚨 [INTEGRITET] Logg-integritet: FEL — korpuslåsning EJ tillåten"
        say "🚨🚨 Loggen har $LOG_SAMPLES sampel, jsonl:en $JSONL_LINES kompletta rader."
        say "🚨🚨 Se $FINAL_SUMMARY"
        say ""
    fi

    # Arkivsynken redovisas i summaryn (V4): utan raden går det inte att se i
    # efterhand om arkivets logg och jsonl är kompletta.
    echo "" >> "$SUMMARY_TMP"
    echo "## Arkivsynk" >> "$SUMMARY_TMP"
    echo "" >> "$SUMMARY_TMP"
    echo "- Logg, jsonl och starttillstånd synkade till \`$LOGS_DIR\` före summaryn: **$FINAL_SYNC_STATUS**" >> "$SUMMARY_TMP"

    # Summaryn byts in i ETT steg och synkas sist (V4). Logg och jsonl ligger
    # redan i arkivet (se SLUTSYNK FÖRST ovan); K24: atomiskt (se sync_file).
    mv -f "$SUMMARY_TMP" "$BRIDGE_TEXT_SUMMARY" 2>/dev/null || say "⚠️ Kunde inte skriva $BRIDGE_TEXT_SUMMARY"
    sync_file "$BRIDGE_TEXT_SUMMARY" "$FINAL_SUMMARY" || say "⚠️ Kunde inte synka $FINAL_SUMMARY"
    # Temp-filerna städas av cleanup_run_tempfiles direkt efter den här
    # funktionen (finish_run), så att även en halvvägs avbruten summary städas.

    say "✅ Bridge text summary skapad: $FINAL_SUMMARY"
    say "✅ AIS replay logg skapad: $FINAL_REPLAY (arkivsynk: $FINAL_SYNC_STATUS)"
    say "✅ App-logg synkad: $FINAL_LOGFILE"
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

# say, inte echo (revision 1 av V4): hit kommer skriptet när processgruppen får
# HUP och tee dör först, alltså när terminalen redan kan vara borta. En inbyggd
# echo till en död terminal lämnar texten i bash 3.2:s stdout-buffert, och den
# hamnade sedan i nedstängningens kommandosubstitutioner (sync_file) och i
# summaryn. Regeln låses i tests/field-log-script-recovery.test.js.
say "Loggar sparade i: $FINAL_LOGFILE"
