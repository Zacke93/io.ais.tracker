# Valideringskörning 2026-07-02 (11 h, nio fartyg) — analys och åtgärder

Körning 01:08–12:33 med riktig trafik. Alla fartygsbanor rekonstruerade ur
rå jsonl och korsvalidering mot apploggen. Körningen är nu **korpus #6**
(`20260702-11h`, låst på 24 notiser).

## Vad som FUNGERADE (fixarna från f0cf7c7 i skarp drift)

- **S-F6 live-verifierad**: kajavgången 265726650 (Kajen norr om Klaffbron,
  söderut 06:56) fick korrekt `INFERRED_PASSAGE_SKIP` — ingen falsk
  Järnvägsbron-notis.
- **N3/S-F3 live-verifierade**: SILVERMORK II:s 29-min-gap över TRE broar
  räddades komplett — dubbla failsafes 09:05:51 (Klaffbron 608 m +
  Järnvägsbron 1557 m), MISSED_TARGET_INFERRED för Klaffbron; alla 6
  bronotiser levererade.
- **Anslutningshärdningen**: nattlig 503/429-storm + 6 halvöppna
  anslutningar 02:02–02:40 självläkta (pong-watchdog + backoff); 429
  (rate limit) är första observationen — eskaleringen skyddade korrekt.
- Alla REGISTRERADE målbropassager hade notiser (INV-5/7 höll i prod).
- SOLUTION (kajliggare hela natten, 58 samples sog 0) — aldrig i text,
  aldrig notis: kajliggarklassen tät.

## Buggar funna i körningen (båda fixade + replay-låsta)

### 1. NO LIMIT-textflappen (pelare 1)
**Symptom:** "på väg mot Klaffbron" ↔ "Inga båtar" var ~10:e minut
(09:37, 09:49) för en båt som låg still vid Spikön och hördes var
12–18:e minut.
**Rotorsak:** RC7-presentationsfiltret (byggt 2026-06-11 för SABETH-
klassen: död transponder på båt I RÖRELSE) döljer alla fartyg med >10 min
gammal data — men en STILLALIGGANDE båts gamla position är fortfarande
sann. **Fix:** fartyg med sog < 1,5 vid senaste kontakt visas upp till
25 min (< STALE_AIS 30 min); ETA:n är redan nollad av HARD-gränsen och
visas ärligt som "ETA okänd".
**Följdfynd via nya INV-14:** samma flapp-klass fanns latent i
väntare-scenariot — en äkta köare som pausar 12 min på 399 m (utanför
300 m-väntzonen) fick target LOW_SPEED-borttagen efter 120 s.
**Fix:** kö-zonsvakt — nyss aktiv, rörelsebevisad, ej förtöjd båt inom
600 m från målbron behåller target under paus (aktivitetsfönster 20 min;
äkta ankrare täcks av förtöjningslagren/2h-backstoppen).

### 2. MOSHE-missen (pelare 2)
**Symptom:** MOSHE (211471090) stale-raderades i 44-min-gap, återföddes
söder om Klaffbron södergående (→ target=null, "lämnar kanalen") och
LIVE-korsade Olidebron 09:09→09:15 — ingen detektering, ingen notis
(312 m från bron vid båda samples = utanför proximityzonen).
**Rotorsak:** målbrolösa fartyg (utan targetBridge OCH utan
_finalTargetBridge) fick INGEN linjekorsningsdetektering alls.
**Fix:** intermediate-detekteringen körs nu även målbrolöst, gated på
ej-förtöjd + rörelsebevis; BUG C-failsafen levererar notisen.
**Retroaktiv validering:** samma fix räddade 211112870@Stallbackabron i
41h-korpusen (verifierad äkta korsning 11:40→11:47 efter 73-min-gap) →
41h-facit omlåst 77→78.

## Medvetet INTE åtgärdat (dokumenterade klasser)

- Broar korsade medan fartyget var STALE-RADERAT (>30 min tystnad) och
  >5 min gamla vid återfödelse notifieras inte ("klockan ringer inte
  efter att tåget gått"): MOSHE Strids/Järnv/Klaff, MARLIN
  Klaff/Järnv/Strids (53-min-gap).
- SABETH-klassen: 211285620 (1 sample), 265661830/265770420 (tystnade) —
  utan data är notis omöjlig.
- MOJITO II:s eventuella Stridsbergsbron-passage FÖRE första samplet är
  oavgörbar (kan ha lagt ut från gästhamnen norr om bron) — scenario A
  gissar medvetet inte.

## Varför hittades inte buggarna före körningen?

1. **NO LIMIT-flappen:** ingen korpus/scenario hade en båt MED target som
   sänder glesare än 10 min i stillaläge (väntare-scenariot hade
   60 s-intervall), och ingen invariant vaktade DEFAULT-flappar längre än
   INV-4:s 90 s-fönster. → Åtgärdat: generatorreglaget
   `stopReportIntervalS`, scenariot `ankrad-gles-sändare`, invarianten
   **INV-14** (DEFAULT ≤5 min mellan två texter med samma bro+antal utan
   passage = brott). INV-14 fångade omedelbart den latenta kö-flappen i
   det befintliga väntare-scenariot — beviset på att den är proaktiv.
2. **MOSHE-missen:** ingen korpus/scenario hade en återfödd MÅLBROLÖS
   utflygare med live-korsning; klassen var strukturellt osynlig eftersom
   detekteringen var target-gated. → Åtgärdat: scenariot
   `återfödd-utflygare-söderut` + korpus #6 + 41h-omlåsningen låser
   klassen för alltid.
3. **INV-3-oscillationen** på krypfartsnivå (15→12→16) var en falsk
   positiv — tröskeln är nu relativ (≥ max(3, 30 % av nivån)).

## Slutläge

498/498 enhetstester (59 sviter), 6/6 låsta korpusar (~80 h proddata,
30/78/0/3/47/24 med per-fartyg+bro-fördelning), 28/28 syntetiska
scenarier, 14 facit-oberoende invarianter, lint rent.

## Uppföljning (användarrapporterade observationer, 2026-07-02)

### 3. "Unknown" i notiser (pelare 2) — FIXAD + FÖRKLARAD
Två källor:
- **Namnbugg (fixad):** Class B blandar positionsrapporter (utan namn) med
  statiska data (med namn); `name: data.name || 'Unknown'` lät strängen
  'Unknown' ERSÄTTA ett tidigare känt namn. MOSHE:s första notis avfyrades
  som "Unknown" 2 min före namnets ankomst; SOLUTION växlade
  Unknown↔SOLUTION mellan samples. Fix: namnstickiness — ett en gång känt
  namn ersätts aldrig av 'Unknown' (äkta namnbyten uppdaterar fortfarande).
- **eta_minutes=-1 (medvetet):** 8 av 23 notiser i körningen var
  failsafe-/just-passed-notiser där bron redan är passerad — där är -1
  ("okänd") det ÄRLIGA värdet (E-F3/N9-beslutet). Flows som läser upp
  eta_minutes bör hantera -1 som "nu/okänd".

### 4. "Alla broar"-triggern — SEMANTIK ÄNDRAD (användarbeslut)
F7-gaten (2026-04) lät "Any bridge"-flowen trigga EN gång per resa —
per-bro-notiserna betraktades då som "duplikat". Användarens faktiska
förväntan är en notis vid VARJE bro. Ny semantik: run-listenern matchar
varje avfyrad trigger; dedup sker redan uppströms per mmsi:bro, så flowen
får max EN notis per bro och resa (upp till 6 för full genomresa).
mmsi:any-nyckeln (inkl. N10-persistentspegeln) är borttagen.

### 5. Extrapolerad "strax" (pelare 1) — FIXAD
09:22:27 visades "beräknad broöppning strax" för MARLIN 730 m från
Klaffbron — en EXTRAPOLERAD nedräkning (5 min gammal data) som 67 s senare
korrigerades UPPÅT till "om 4 minuter". Fix: extrapolerade värden i
<3-bandet visar "om cirka 2 minuter"; "strax" reserveras för färsk
data/imminent/exhausted (exhausted-vägen behåller strax — MARLIN-fallet
09:28 var korrekt).

### Bridge-text-summaryn i övrigt: genomgången rad för rad — REN
Alla 49 övergångar förklarade: räkningarna 1→2→3→2→1→0 speglade äkta
trafik + korrekta döljningar; #26→#27 (15→7 på 13 s) var RC4-klampen som
bromsade ett större rådatafall (designat beteende); #23–#24 stigande ETA
var äkta inbromsning (+1/cykel-skyddet); NO LIMIT:s Klaffbron-notis efter
10:02 var omöjlig (SABETH-klass: total tystnad efter sista samplet).
Inga ytterligare buggar.
