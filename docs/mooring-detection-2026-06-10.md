# Förtöjningsdetektering — 5 lager (2026-06-10)

**Bakgrund (prod-bugg dag 1):** En båt förtöjd vid kajen norr om Klaffbron
(190–295 m från bron = inom 280 m-väntzonen) tolkades som "inväntar
broöppning" på obestämd tid och avfyrade en falsk boat_near. Rotorsak: det
gamla designantagandet "stillaliggande <300 m från bro = väntar på öppning"
(`_shouldAssignTargetBridge` tillät 0,0 kn nära bro), och `_isWaiting` är
rent avståndsbaserat utan fart- eller tidskontroll.

**Designprincip:** skilj på *ankomsthistorik*, inte stillhetens längd. En
äkta väntare seglade dit under appens observation; en kajliggare har aldrig
setts röra sig. INGET lager triggar på väntans längd under tid då bron varit
stängd → äkta väntare (även 90+ min vid rusningsspärr) påverkas aldrig.

| Lager | Regel | Implementation |
|---|---|---|
| 1 | Inget målbro utan rörelsebevis: netto ≥50 m från första position ELLER sog ≥0,5 kn någon gång | `_updateMooringEvidence` + gate i `_shouldAssignTargetBridge`; bevisfält persisteras i `_createVesselObject` |
| 2 | Demotera (rensa target), ta aldrig bort — ingen re-entry-churn; `_routeDirection` behålls så ACCELERATED-vägen återpromoverar inom 1 uppdatering | `updateVessel` efter `_updateMooringEvidence` |
| 3 | AIS NavigationalStatus 1 (at anchor) / 5 (moored) → förtöjd — ENDAST vid stillhet (sog <0,3) så glömd status på avgående båt inte missar notiser | `_extractAISData` (nytt fält) → `_processAISMessage` → vessel.navStatus |
| 4 | Stationär i känd förtöjningszon → förtöjd. Kapsel: centrumlinje + halvbredd (`geometry.distancePointToSegmentM`, ny). Kräver stillhet → genomfart/väntan i farleden opåverkad | `MOORING_ZONES` i constants — kajen norr om Klaffbron (användarverifierade koordinater, alla väster om farledslinjen) |
| 5 | Backstop: stationär >2 h → förtöjd (bortom alla rimliga öppningsfönster) | `MAX_STATIONARY_WAIT_MS` |

Hängslen: `_triggerBoatNearFlow` har egen moored-gate (täcker framtida
kandidatvägar utan targetBridge).

**Felasymmetri:** en felaktig demotering rör bara texten (notisen är redan
skickad, dedupen omstartssäker) och självläker inom en AIS-uppdatering när
båten rör sig. En utebliven demotering stod tidigare kvar i dygn.

**Validering:**
- 18 nya tester (`tests/moored-vessel-detection.test.js`), bl.a. test-låst
  skydd för äkta väntare som legat still 90 min.
- Hela sviten 55/447 grön, lint rent.
- Replay: notiser EXAKT 29 + 75 (oförändrat); 41h-korpusens textsekvens
  IDENTISK (inkl. äkta långsamtgående båtars höga ETA-texter); äldre korpusen
  −8 övergångar = 112-minuters-"spökfladdret" från en aldrig-rörlig båt
  försvann — en förbättring (produktionen visade samma fladder).
- Två äldre regressionsvakter uppdaterade med `_hasMovementProof: true`
  (syntetiska fartyg som i verklig drift har beviset; avsikten bevarad).
