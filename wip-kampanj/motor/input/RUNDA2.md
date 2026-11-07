# Runda 2 av motorrättningen (2026-11-04)

Runda 1 rättade M01–M14 och triagepunkterna T-1–T-3. Resultatet ligger i F/result.json
(resA, resC, resB, fixups, run, review, triage). Den sista standardkörningen finns i
F/runs/r1-standard-a/ med fingeravtrycket 3284652ba6a7 och 23 kort. Granskaren i varv r1
och triagen hittade de kvarvarande punkterna nedan.

**Ögonblicksbild före runda 2 (orörd referens):** F/pre2/bugHunt och F/pre2/docs/BUGGJAKT.md.
"Gamla motorn" i jest-beviset betyder nu F/pre2. Ögonblicksbilden före runda 1 finns
kvar i F/pre.

Granskarens sonder från varv r1 ligger i F/tmp/granskare-r1/probes/ och utfallen i
F/tmp/granskare-r1/probes-out/. Underlaget från triagen finns i F/tmp/triage-1/ och
F/tmp/triage-2/ (bland annat scripts/, variants/, cpy/ och tie-w*.jsonl).

## E1 (medel): S10-VÄNDNING-BRON-BAKOM är bredare än appens S10-vakt

Registret: lib/registry.js (reversalAwayFromBridge) och beslutsregister.json.

**Felet.** Predikatet kräver sog ≥ 0,5 kn på zonfixarna och godtar hur många zonfixar som
helst inom 15 min. Appens vakt (app.js:9745–9783) slår bara till när Fix D har en färsk
pending-flagga. Flaggan sätts bara av en fix med sog ≥ FIX_D_MIN_SOG = 2,0 kn
(VesselDataService.js:380–389 och 446–455). En andra omvänd fix med sog ≥ 2 kn bekräftar
reversalen, och då går notisen ut.

**Belägg.** I värld 581, där appen kör, finns två fall:
- en zonfix med sog 0,6, 1,0 eller 1,9 kn: appen notifierar;
- en extra zonfix med 2,2 kn: appen notifierar.

Om notisen tas bort klassar predikatet ändå utfallet som DESIGN. Se probes/s10sog.js,
s10two.js och s10two-b.js och utfallen s10sog.txt och s10two.txt.

**Rättning.**
- Första zonfixen ska ha sog ≥ FIX_D_MIN_SOG. Läs konstanten ur appens kod om det går, i
  stället för att hårdkoda den.
- Ingen senare zonfix inom TTL får ligga i det nya bandet med sog ≥ FIX_D_MIN_SOG.
- Jest-fall: zonfix 1,0 kn ger KANDIDAT, två zonfixar 2,2 kn ger KANDIDAT, och F15:s tre
  världar (215, 581 och 1818, med en zonfix vardera på 3,6, 2,2 och 2,4 kn) är kvar som
  DESIGN.
- Uppdatera §7.

## E2 (låg): MÄTGRÄNS-INV10-VÄNTKEDJA godtar ett glapp som innehåller en halvminutstick

Registret: lib/registry.js (chainedConfirmedWait).

**Felet.** Vid en UI-tick inne i glappet byter en korrekt app text, eftersom 'strax' spärras
av hasFreshPosition (BridgeTextService.js:304–308). Posten kan därför dölja just det
INV-10 vaktar.

**Belägg.** probes/inv10tick.js och inv10tick-b.js, med utfallet i inv10tick.txt. I värld
1228 (F18) innehåller glappet 08:59:44.854–08:59:57.860 ingen tick.

**Rättning.**
- Inget glapp får innehålla en halvminutstick strikt inne i sig. Svansen på högst 30 s
  behålls.
- Jest-fall: ett glapp på 25 s över 09:00:00.040 ger KANDIDAT, och värld 1228 är kvar som
  MÄTGRÄNS.

## E3 (låg): KIE-PER-KORPUS-fönstret vidgas av utslagets egen längd

Registret: lib/registry.js (kiePrefix och episodLängdMs).

**Felet.** Fönstret är |δ| + L + en tick, med L = max(undantagets längd, utslagets längd).
DEFAULT-FLASH:s ISO-tid är starten av texten 'Inga båtar', och INV-14 godtar upp till
300 s. En separat lång flash upp till |δ| + 330 s efter den kända godtas därför.

**Belägg.** probes/kiewindow2.js (42h, δ +7 s) med utfallet i kiewindow2.txt.

**Rättning.**
- Använd L bara för klasser vars tid inte är episodens start (ETA-SÅGTAND 'på Ns' och
  ETA-OSCILLATION 'inom Ns'), eller ta L enbart ur undantaget.
- För DEFAULT-FLASH gäller |δ| + en tick.
- Acceptansen ska hålla: 42h ACCEPTERAD vid alla fem δ.
- Jest-fall: en lång separat flash ger KANDIDAT.

## E4 (låg): hunt:repro för M-FAS-kort svarar KVAR när bara registrerade träffar av mekanismen finns kvar

Repro: lib/lanes.js (bankRepro, rad 90–92).

**Rättning.**
- Räkna som KVAR bara träffar vars registerklass och post är kortets, enligt nyckeln i
  fynd.json.
- Visa övriga träffar som information, som reproKalibrering gör.
- Pröva med probes/fakebankcard.js (utfallet fake-mfas-42h-repro.txt).
- Lägg till ett jest-fall.

## E5 (låg): orakelvaktens radhänvisningar är inaktuella

Registret: beslutsregister.json (UNDER-BRO-BANDET-70M.orakelvakt) och BUGGJAKT §7.

**Felet.** Orakelvakten citerar t10Passage.js:57–60, men funktionen decisiveFixAfter ligger
nu på 62–65.

**Rättning.**
- Peka på funktionsnamnet i alla orakelvakter som citerar motorns egna filer, så att
  hänvisningen inte glider.
- Låt gärna registrets laddning kontrollera att en citerad symbol finns i filen. Den
  kontrollerar i dag bara att filen finns.

## E6 (motorfel, kortet F21): T1 räknar en tidslik fix som appen ännu inte fått

Orakel: lib/oracles/t1Notice.js:250–253.

**Felet.** Filtret `f.aisTimestamp <= n.t` räknar en fix som appen inte fått före notisen.
Harnessen stegar klockan i 30 s-bitar och dränerar i slutet av biten (replayRunner.js:512–521),
så en notis kan gå ut på exakt samma tid som nästa rad, innan raden matats in. Det strider
mot katalogregeln i BUGGJAKT (bilaga B T1): "appen före notisen fått en fix mer än 70 m
bortom linjen". Harnessen har vesselLat och vesselLatNext för att skilja fallen
(replayRunner.js:749–769).

**Belägg.** Triagen (F/tmp/triage-2/):
- En positionsmedveten regel tar bort F21 (värld 856) och behåller F13 (SALTIS).
- Värld 86, 783 och 1731 är tidslika men äkta.

Se scripts/tieworlds.js, tie-w*.jsonl och cpy/.

**Rättning.**
- Räkna fixar strikt före n.t. En tidslik fix räknas bara när notisens vesselLat/vesselLon
  är just den fixen.
- Jest-fall: F21-mönstret ger inget utslag, och SALTIS-mönstret ger utslag.

**Systerställen med samma `<=`:** t2Opening.js:248–252 (lastSeenFixTs) och :366–369
(FRUSET-FIX). Där kan tidslikheten i stället dölja utslag. Analysera och rätta på samma
princip, alltså det appen faktiskt hade fått, och lägg till jest-fall för varje ändrat
ställe. Mät följderna med A/B över standardvärldarna (--lanes=synth --no-shrink, seed 1),
med räkningar per orakelklass och nivå, före och efter.

## E7: registerposten STRESS-TÄTHET når aldrig INV-F-fynd

Registret: lib/registry.js, Registry.applies (cirka rad 949).

**Felet.** applies kräver gäller.inv för INV-F, men posten har inget inv. De 5 INV-F-fynden i
stressvärldar saknar därför taggen.

**Rättning.**
- En taggpost (verkan tagg) med orakel '*' ska nå INV-F-fynd.
- En amnesterande post ska däremot fortfarande kräva ett uttryckligt inv för INV-F. Det
  är säkerhetsregeln.
- Lägg till ett jest-fall.

## E8: rapporten länkar inte tvillingkort

Rapporten: lib/report.js och lib/cluster.js.

**Felet.** Triagen fann två slags kortpar som saknar länk:
- **Samma apphändelse, olika orakel.** F12 (INV-13) och F16 (T10 FANTOMPASSAGE(intermediate))
  har samma representant, värld 254, och samma minsta repro på 17 rader. F18 och F19
  (INV-3 OSCILLATION och SÅGTAND UPP) har byte-identiska repro.jsonl.
- **Stresstvillingar.** Stresskort som har samma mekanismnyckel som ett R0- eller R1-kort:
  F20↔F03, F23↔F11, F22↔F02, F21↔F13 och F17↔F02/F01:s r2.

**Rättning.**
- Korten slås INTE ihop, eftersom klustringen per mekanism är avsiktlig (§8). De länkas i
  stället åt båda hållen:
  - "Samma minsta repro som Fxx (troligen samma apphändelse)", när kortens minsta repro har
    identisk radhash;
  - "Stresstvilling till Fxx (samma mekanism)", när mekanismnyckeln utan '|stress' är
    densamma.
- Länkarna ska stå i rapport.md och rapport.json och vara deterministiska.
- Lägg till jest-fall.
- Uppdatera §9.
