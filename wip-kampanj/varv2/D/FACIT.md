# Familj D (SPÄRR) — facit (varv 2, 2026-11-09, efter omgranskningen)

**Leveransen flyttar inget låst facit.** Leveransen är 19e87b5 (EFTER-BRON) och 229561e
(omgranskningens två skärpningar), direkt på c14938f.

| Kontroll på 229561e | Utfall |
|---|---|
| `replay:all` (24 korpusar), utan och med `REPLAY_MONITORING=1` | Hela resultat-JSON:en är lika med c14938f utom `heapUsedMB` (48 jämförelser, 0 skillnader). Alltså 0 rader i notiser, öppningsvarningar, undertryckningar, mål- och mellanbropassager och bridge_text, och 0 golden-events-rader i de 11 händelselåsta korpusarna. |
| batteriets replay:all och replay:all med monitoring | "Alla låsta korpusar matchar facit" i båda (`V/D/batt-efterbron2`) |
| batteriets fassvep, utan och med monitoring | "FASSVEP: OK — 24 korpus(ar), inget odokumenterat fasberoende" i båda |
| `replay:openings` | bitlik logg mot c14938f |
| `replay:synthetic` | bitlik logg mot c14938f |

Hur jämförelsen gjordes:
- multiset-diff rad för rad av varje korpus resultat-JSON med `V/D/scripts/cmp.js`, och hela JSON:en utan `heapUsedMB`;
- dumparna ligger i `V/D/dump/g-efterbron2` och `g-efterbron2-mon`, loggarna i `V/D/matningar/g-efterbron2-*`;
- de kördes på arbetskopian före commit. Koden är densamma som i 229561e, och bara kommentarer ändrades efteråt. Det är kontrollerat med espree-AST (`V/D/scripts/astlika.js`).

Ingen omlåsning behövs. Ingenting ändras i `tests/replay-validation/corpora.js`, golden-events,
golden-text, fördelnings- eller öppningsfacit, så U13 kräver inget rådatabelägg.

Bankens bitlikhet prövar inte spärrens syfte. Det gör motorns världar, granskarens kögrid och
regressionstesten: TYST-GOLV och 19e87b5 var också bitlika i banken, men varnade för tidigt före köer
(DESIGN.md §3, §3b och §5).
