# FACIT — familj C, M3 ÅTERFÖDD-DÖDBAND (varv 2, 2026-11-09)

Gäller `19b3bfa` i C/wt (prototypen `f62aea8` gav samma utfall). Revision 2 efter granskningen
ändrar bara kommentarer, dokument och test, så utfallet nedan gäller oförändrat.

**Inget låst facit flyttas.** Ingen korpus behöver låsas om, och ingen rad behöver
bedömas enligt U13.

## Belägg

1. **`replay:all`** (batteriets `replay-all` och `replay-all-mon`, C/batt): alla låsta
   korpusar matchar facit (notiser, fördelning, riktning, golden-text och öppningsvarningar).
2. **Bitlik mot c14938f, utöver facit.** `C/scripts/bitlik.sh` kör replayRunner för bankens 24
   korpusar och de två nattkorpusarna (aisstream och fusion 20260803) i en kopia av c14938f
   (C/tmp/base, `git archive c14938f`) och i C/wt, och jämför hela resultat-JSON:en
   (notiser, brotextövergångar, mål- och mellanbropassager, öppningsvarningar, täckning,
   undertryckningar och läckdiagnostik). Skriptet undantar `heapUsedMB` och hela
   `runtimeDiagnostics` (harnessens körningsdiagnostik med timrar och monitoringstarter).
   `runtimeDiagnostics` jämfördes separat för `f62aea8` utan monitoring, utan skillnader.
   Granskarens strängare jämförelse, som bara undantar `heapUsedMB` och väggklocktider och
   alltså tar med `runtimeDiagnostics`, ger också 26 av 26 med och utan monitoring
   (GRANSKNING.md, belägg 4).
   - utan monitoring: 26 av 26 bitlika (C/bitlik/plain2.log; `f62aea8`: C/bitlik/plain);
   - med `REPLAY_MONITORING=1`: 26 av 26 bitlika (C/bitlik/mon2.log; `f62aea8`: C/bitlik/mon.log).
3. **Varför inget flyttas.** Mätsonden `C/scripts/probe.js` (C/probe/v2) spionerar på
   `_rebirthTransitDirection` i alla 24 korpusar. Den anropas 110 gånger (en ny båt som kvalar,
   men där `_calculateTargetBridge` gav null):
   - i 108 fall saknas en färsk K1-mätning eller ligger kursen i ett band, och regeln avstår;
   - NORDIC SOLA (20260713-41h 08:12:51, 0,433 m/s, kurs 46,5°) avvisas av 2 kn-kravet. Det
     var hennes tre golden-text-rader som skissens första variant flyttade till sämre;
   - SY FREYJA (20260702-2h 12:42:44, +1,923 m/s, kurs 45,1°) uppfyller beviset, men norr om
     Stridsbergsbron finns ingen målbro norrut; låset släpps och svepet beter sig som förut.
4. **Syntetiska sviten:** de 74 befintliga scenarierna ger identiska rader mot c14938f (samma
   passager, notiser och öppningar), och WARN-uppsättningen är oförändrad (10 rader). De två
   nya M3-scenarierna är röda på c14938f och gröna med rättningen.
5. **Batteriet för `19b3bfa`** (C/batt/status): replay-all, replay-all-mon, synth, openings, soak,
   soak-mon, phase och phase-mon har slutkod 0. Fassvepet: 24 korpusar, 168 replays, inget
   odokumenterat fasberoende. Öppningsgrindarnas logg är identisk med c14938f-kopians.

## Rader som flyttar

Inga.
