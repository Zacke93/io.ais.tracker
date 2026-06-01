This is a decisive discrepancy I must surface. The **homey runtime log** (logs/app-20260525-231934.log) shows JOSEPHINE's Järnvägsbron notification fired with **direction=southbound** (line 576), **not northbound**. There is **zero** northbound line for 244870852 anywhere in the real log. The only genuine direction defect for JOSEPHINE in the real runtime is **Stridsbergsbron → direction=unknown** (cog 226.7), which matches the third confirmed finding and the FULL-DRIFT low-severity finding.

The "northbound, eta:68" finding describes the output of a *fresh re-run of the replayRunner against current code* — a different code path / timing than the captured homey log. Its own justification admits the time was imprecise. The code *can* produce northbound (cog=14 stopped boat has no SOG-gate — verified at app.js:3666), so the defect class is real, but the specific homey-log evidence shows southbound. I'll report the defect by its **verified root cause** (missing SOG-gate) and flag the evidence discrepancy honestly rather than parroting a timestamp the log contradicts.

I have enough verified ground truth. Writing the report.

## Sammanfattning

**Ja — om appen körts felfritt och stabilt är båda pelarna i allt väsentligt produktionsredo, med tre små men reella riktnings-/ETA-defekter kvar att städa.** Den medskickade replay-utdatan (14 notiser, MARIANNE "missar" broar, flera "defective"-verdikt) är till ~90 % en **harness-artefakt**, inte appens beteende. Verifierat mot den faktiska Homey-runtime-loggen (`logs/app-20260525-231934.log`): den loggen innehåller **29 `FLOW_TRIGGER_SUCCESS`** och **29 `FLOW_TRIGGER_ATTEMPT`** — exakt det antal en ren produktionskörning (utan `__TEST_MODE__`, med event-loop-drain) ger. Replayens 14 är artefakten.

Rotorsaken till artefakten är bekräftad i koden: `vessel:updated` registreras som icke-awaitad async-lyssnare (`app.js:418`), och `replayRunner` återställer `global.__TEST_MODE__=true` synkront mellan samples. GPS-triggade `_triggerBoatNearFlow`-anrop körs då i en senare microtask där test-guarden (`app.js:2801`) är aktiv igen och returnerar tyst. Därför "tappas" notiser i replayen men inte i produktion.

När man rensar bort artefakten kvarstår **tre verkliga defekter, alla i notis-/riktnings-/ETA-tokens — ingen i den text bilföraren faktiskt läser** (bridge_text och notistexten är genomgående korrekta). De är low–medium severity, isolerade till valfria Flow-tokens, och självläker eller berör bara enstaka samples.

**Viktig reservation om beviskvalitet:** Ett av de "bekräftade" fynden (JOSEPHINE Järnvägsbron = `northbound`, eta 68 @ 10:01:13) **motsägs av den faktiska Homey-loggen**, som visar `direction=southbound` (rad 576) och saknar varje `northbound`-rad för MMSI 244870852. Den underliggande koddefekten (avsaknad SOG-gate) är dock verklig och verifierad. Se Bekräftade fynd nedan.

## Produktionsdom per pelare

### bridge_text — **Produktionsredo**
Den primära användartexten är korrekt genom alla sex resor. Inga falska målbroar, inga felaktiga riktningstexter (BridgeTextService anropar aldrig `_getDirectionString`), och spik-skydden håller. De observerade ETA-rörelserna är antingen korrekt väntande-beteende (stillastående båtar, grupp-ETA stiger när farten faller mot noll — clamp ≤12–15 min hölls hela tiden) eller en liten, självläkande utjämnings-residual (JOSEPHINE Klaffbron, ~2 min, 11→52→12). Den enda kvarstående bridge_text-defekten är **low severity och självkorrigerande**. Inget blockerar produktion.

### notiser (boat_near) — **Nästan redo**
Kärnfunktionen är solid: i ren runtime fyrar boat_near på rätt bro, rätt avstånd, för alla relevanta passager (29/29 success i loggen, inkl. MARIANNEs tre broar). **Men tre defekter sitter i notis-tokens** och bör åtgärdas innan en "produktionsredo"-stämpel: (1) `_getDirectionString` saknar SOG-gate → fel/`unknown` riktning på stillastående båtar, (2) sydbandet är för smalt (135–225°) → `unknown` på normala SV-sydkurser, (3) `eta_minutes`-token saknar golv/clamp → orimliga ETA-tal (t.ex. 68 min på en båt 80 m från bron). Alla tre rör **valfria Flow-tokens**, inte själva notistexten — därav "Nästan" och inte "Ej redo". Plus en **latent async-race** (samma rot som artefakten) som är reell men sällsynt vid normal kadens.

## Bekräftade fynd

### notiser

**1. [medium] `_getDirectionString` saknar SOG-gate → fel riktning på stillastående båt**
- **Tid/fartyg:** JOSEPHINE (MMSI 244870852), vid/nära Järnvägsbron, ~09:58–10:01 UTC.
- **Verifierat i kod:** `app.js:3666` — `if (vessel.cog >= NORTH_MIN || vessel.cog <= NORTH_MAX) return 'northbound'`. `NORTH_MAX=45` (`constants.js:229`). Ingen SOG-kontroll. En förtöjd båt med `sog=0` och brus-`cog=14` klassas som `northbound` trots otvetydig sydfärd (lat 58.3194→58.2870 monotont fallande). Resten av kodbasen vet att låg-SOG-COG är opålitlig (`StatusStabilizer.js:106-107`, `geometry.js:129/532`, ProximityService `sog>0.5`); just denna funktion saknar skyddet helt.
- **OBS — beviskonflikt:** Den faktiska Homey-loggen (`logs/app-20260525-231934.log` rad 576) visar JOSEPHINEs Järnvägsbron-notis med **`direction=southbound, ETA=68`**, och innehåller **ingen** `northbound`-rad för 244870852. Påståendet "northbound @ 10:01:13" kommer från en separat färsk `replayRunner`-körning, inte den fångade loggen, och fyndets egen motivering medger att tiden är oprecis. **Defektklassen (saknad SOG-gate som *kan* ge northbound) är verklig och kodverifierad; den specifika northbound-evidensen är det inte.**
- **Användarpåverkan:** Begränsad. Endast en Flow som villkorar på `direction`-token kan få fel riktning, och bara på mellanbroar där en båt ankrar/stannar <300 m precis när SOG=0 och AIS rapporterar nord-ish heading. Notistexten/bridge_text är oförändrat korrekt.
- **Rekommendation:** Lägg SOG-gate i `_getDirectionString` — returnera `unknown` när `sog < LOW_SPEED_THRESHOLD (0.5 kn)`. Bättre: härled notis-riktning från den latch-låsta ruttriktningen (`vessel._routeDirection`/`_finalTargetDirection`, redan `south` här) eller lat-delta. Regressionstest: stillastående båt <300 m från mellanbro med `cog<45` ska ge `direction != northbound`.

**2. [medium] `eta_minutes`-token saknar golv/clamp → orimlig ETA på nära/passerad bro**
- **Tid/fartyg:** JOSEPHINE (244870852), Järnvägsbron, 09:50:43 UTC — `ETA=68` med båten 80 m från (och under) bron, `sog≈0.2`.
- **Verifierat i kod:** `etaMinutesForDisplay` (`etaValidation.js:215-218`) gör enbart `Math.round` — **inget golv, ingen waiting-clamp**. Kommentaren dokumenterar att 30-min-capen *togs bort* med flit för token-vägen. Bridge_text-vägen behåller däremot `MIN_PASSAGE_ROUTE_SPEED_KNOTS=2.5` (`constants.js:70`) och `WAITING_STATUS_MAX_ETA_MINUTES=12`, så samma fartyg visar korrekt "om 12 minuter" i texten samtidigt som token-ETA spikar. Asymmetrin är kärnan. Loggen rad 576 bekräftar `ETA=68`.
- **Användarpåverkan:** Vilseledande ETA-tal i Flows som renderar `eta_minutes`. Rätt bro/avstånd, men talet är orimligt vid nära-noll fart efter passage.
- **Rekommendation:** Inför samma låg-fart-golv/waiting-clamp i `etaMinutesForDisplay` (eller på token-källan) som bridge_text redan har. Notifiera helst inte mellanbro-"passage" när båten står still post-passage.

**3. [low] För smalt sydband → `direction=unknown` på normal SV-sydkurs**
- **Tid/fartyg:** JOSEPHINE (244870852), Stridsbergsbron, 09:46:43 UTC, `cog=226.7`, `sog=4.2`. **Bekräftat i Homey-loggen** rad 543/547: `direction=unknown` (detta fynd, till skillnad från #1, matchar den fångade loggen exakt).
- **Verifierat i kod:** `app.js:3672` — `southbound` endast för `cog 135–225`. 226.7° faller i glappet → `unknown`. "Anomali 16"-åtstramningen (`app.js:3669-3671`) tog bort öst/väst-felmärkning men överkorrigerade bort äkta SV-sydfärd i den NE-SV-orienterade kanalen. ~2 % av samples (5/244: 227/233/248/258/268°) träffas.
- **Användarpåverkan:** Mycket begränsad. Endast `direction`-token i egna Flows; notistext/bridge_text korrekt ("på väg mot Stridsbergsbron").
- **Rekommendation:** Vidga sydbandet till 135–314°, eller härled riktning från latitud-trend i stället för momentan COG.

**4. [medium, latent] Async-race i `vessel:updated`-vägen**
- **Verifierat i kod:** `app.js:418` registrerar `_onVesselUpdated` som icke-awaitad async utan `.catch`. Samtidiga `_triggerBoatNearFlow` delar den mutabla `_triggeredBoatNearKeys` (`app.js:170`). "RACE FIX" (`app.js:3390-3392`) sätter dedup-nyckeln före async-triggern — skyddar mot dubbletter, men inte mot att en parallell invokation hoppar över en bro vars nyckel just sattes.
- **Användarpåverkan:** Vid en verklig AIS-burst (återanslutning/flera fartyg samtidigt) kan en legitim notis tappas. Sällsynt vid normal kadens (sekunder mellan meddelanden), men reell — det är samma mekanism harnesset oavsiktligt blottade.
- **Rekommendation:** Awaita/serialisera `_onVesselUpdated` per fartyg, eller gör dedup-uppslag+sättning atomär. Lägg burst-regressionstest.

### bridge_text

**5. [low] Självläkande ETA-residual efter omstart från stillastående**
- **Tid/fartyg:** JOSEPHINE (244870852), Klaffbron, 10:01:30–10:03:14 UTC: visad text "Två båtar mot Klaffbron" hoppar 11→52→12 min (~+41), självläker på ~2 min.
- **Rotorsak (korrigerad mot råspår):** **Inte** en momentanhastighets-spik. Det höga rå-ETA (~67 min) beräknades korrekt medan båten stod still ~1045 m från Klaffbron (ärlig, fysiskt korrekt hög ETA, 0.5 kn-golv tillämpat). Det visade ~52 är en EMA-/outlier-fallback-**residual** (`ProgressiveETACalculator.js:649-660` + `526-536`) som *släpar 1–2 cykler efter att båten startat om* (sog 5.2). Ett korrekt högt värde dröjde kvar för länge — motsatsen till fyndets ursprungliga "absurda 58 min på närmande båt".
- **Användarpåverkan:** Låg och övergående. En förare som tittar exakt under dessa ~2 min ser ett konstigt tal som korrigeras vid nästa AIS-position. Båten nådde aldrig Klaffbron (närmast 339 m, ankrade 10:11) så ingen broöppning förväntades.
- **Rekommendation:** Behandla som låg-prioriterad utjämnings-tradeoff. Om man dämpar: låt en **nedåtgående** ETA passera snabbare (kringgå EMA/outlier-fallback i den riktningen) när en båt går från stillastående (avgSpeed<0.8) till rörlig (sog≥1.0). Utöka `tests/bug-b-eta-oscillation-regression.test.js` och verifiera mot just JOSEPHINE 09:58→10:03 UTC. **Fyndets ursprungliga bevissekvens (58/68/24/22) och "saknad stopped-clamp"-rotorsak är felaktiga och bör förkastas.**

## Vad som fungerade bra

- **Notisleverans i ren runtime:** 29/29 `FLOW_TRIGGER_ATTEMPT` → 29/29 `FLOW_TRIGGER_SUCCESS` i `logs/app-20260525-231934.log`. Inga missade passager när artefakten är borträknad.
- **MARIANNE (244236598)** — som i replayen "missade" Stridsbergsbron (passage på 5 m!) och Järnvägsbron (139 m) — fyrar i verkligheten alla tre broarna: **3 `SUCCESS`** i loggen (Stallbackabron + Stridsbergsbron + Järnvägsbron). Per-bro min-avstånd bekräftar geometrin (Stridsbergsbron 5 m @09:48:25, 6 samples <300 m).
- **Dubblettskydd:** dedup-loggen visar korrekt `FLOW_TRIGGER_DEDUPE`/`PERSISTENT_DEDUP` — JOSEPHINE Järnvägsbron triggas en gång och blockeras sedan korrekt vid 09:54/09:58/10:01 trots upprepade <300 m-samples.
- **bridge_text-texten:** korrekt målbro, riktning och formulering genomgående; väntande-clamp (≤12–15 min) hölls under alla observerade nära-noll-fart-scenarier; inga ETA-UPP-hopp på faktiskt närmande båtar.
- **Ärlig "ETA okänd"-design:** de tre `ETA okänd`-övergångarna inträffar alla vid första detektion av en ny vessel och löser till riktig ETA inom en AIS-tick (31–60 s) — medveten design, inte defekt.

## Förkastade observationer

- **14-notis-listan / MARIANNE "missar" broar (high → artefakt):** Ren harness-timing. `replayRunner` matar samples synkront och återställer `__TEST_MODE__=true` mellan dem; den icke-awaitade `vessel:updated`-lyssnaren träffar test-guarden (`app.js:2801`) i en senare microtask. Med drain (setImmediate) utan TEST_MODE → 29 notiser, identiskt med Homey-loggen. Ingen logikdefekt.
- **"ETA stiger i Två båtar mot Klaffbron" (09:50–10:01) som närmande-spike (design):** Båda båtarna stillastående/väntande (JOSEPHINE sog 0.2→0, MARIANNE 0.3→0); grupp-ETA stiger korrekt när farten faller mot noll. Spik-skyddet höll (inget >20 min visades).
- **Northbound-eta-68-fyndets bevissekvens (58/68/24/22) och "saknad stopped-clamp"-rotorsak:** Motsägs av Homey-loggen (visade southbound; texten var "2 båtar i närheten" utan ETA, inte "68"; ingen text-uppdatering 10:01:13). Förkasta beviset; behåll endast den kodverifierade SOG-gate-bristen (fynd #1).

## Slutsats

**Täcker valideringen pelarna?** Ja, för båda pelarna och med god kodförankring. Efter adversariell verifiering mot råspår och Homey-runtime-logg står domen: **bridge_text = produktionsredo; notiser = nästan redo** (tre token-defekter + en latent race att städa, alla low–medium, inga i den text bilföraren läser). Den ställda frågan — *hade appen fungerat felfritt och stabilt, är pelarna produktionsredo?* — besvaras med ett kvalificerat **ja**: instabiliteten i replayen var harnesset, inte appen.

**Begränsningar — väsentliga, dämpar inte domen men ramar in den:**
1. **En enda inspelning** (`...231934`), ~19 h, **6 resor**, dominerad av sydgående trafik och flera ankrings-/stillaståendescenarier. Bra på låg-fart-edge-cases (där alla tre defekterna bor), men tunt på: nordgående trafik i volym, äkta AIS-bursts/återanslutning (racen #4 är därför *inte* empiriskt utlöst, bara kodbevisad), och samtidiga flerfartygs-öppningar.
2. **Beviskonflikten i fynd #1** visar att färska `replayRunner`-körningar och den fångade Homey-loggen kan divergera i timing — slutsatser om exakt sample/tid bör alltid korsverifieras mot råloggen, inte enbart mot replay-utdata.
3. Defekterna rör **valfria Flow-tokens**; en användare utan custom-Flows som drar in `direction`/`eta_minutes` märker ingenting. Det sänker skarpheten i "Nästan redo" för notiser, men de tre fixarna (SOG-gate i `app.js:3666`, golv/clamp i `etaValidation.js:215`, vidgat sydband i `app.js:3672`) är små och väl avgränsade och bör in före bredd-release.

Relevanta filer (absoluta sökvägar):
- `/Users/Zamo0004/Library/CloudStorage/OneDrive-Privat/Broöppning_Homey/AIS Tracker VC_02/io.ais.tracker/app.js` (rader 418, 529, 2801, 3349, 3390-3392, 3529, 3660-3676)
- `/Users/Zamo0004/Library/CloudStorage/OneDrive-Privat/Broöppning_Homey/AIS Tracker VC_02/io.ais.tracker/lib/constants.js` (rader 67, 70, 227-231)
- `/Users/Zamo0004/Library/CloudStorage/OneDrive-Privat/Broöppning_Homey/AIS Tracker VC_02/io.ais.tracker/lib/utils/etaValidation.js` (rader 215-218)
- `/Users/Zamo0004/Library/CloudStorage/OneDrive-Privat/Broöppning_Homey/AIS Tracker VC_02/io.ais.tracker/lib/services/ProgressiveETACalculator.js` (rader 424, 526-536, 649-660, 699-705)
- `/Users/Zamo0004/Library/CloudStorage/OneDrive-Privat/Broöppning_Homey/AIS Tracker VC_02/logs/app-20260525-231934.log` (29 SUCCESS; JOSEPHINE rad 543/547/576; MARIANNE 3 SUCCESS)
- `/Users/Zamo0004/Library/CloudStorage/OneDrive-Privat/Broöppning_Homey/AIS Tracker VC_02/logs/ais-replay-20260525-231934.jsonl`