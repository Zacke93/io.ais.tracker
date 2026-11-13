# Familj D (SPÄRR) — resultat, varv 2 (2026-11-09), efter omgranskningen

**Utfall: COMMITTAD som 229561e** ovanpå 19e87b5 i V/D/wt; leveransen är 19e87b5 + 229561e på c14938f (patch.diff =
git diff c14938f). Dirigentens val: B med båda skärpningarna. Inget låst facit flyttas. Underlag: V/D/DESIGN.md (§8
beslut och restfönster, §3b mätningar) och FACIT.md.
**Regeln:** har appen inte hört båten på max(2 × längsta intervallet, 210 s), räknas hennes fart fram till den
tidigare bron och minst 4 kn efter den, men spärren släpps aldrig innan hon i egen fart har nått bron, där hon kan stå
i kö. 210 s är klass B:s 180 s-takt som AISHub tar emot den: ceil(180/65) = 3 pollar à högst 70 s. Kurs bort eller
väntande vändning ger ingen tidigareläggning (U19).
**Mot c14938f:** 263 går från 44 till 70 s (hunt:repro BORTA). 1511 + en poll varnas 09:45:59 som på c14938f (19e87b5:
22 min för tidigt). Kögridet: 3 av 84 för tidiga där c14938f väntade (19e87b5: 26). Banken: hela resultat-JSON:en
lika, med och utan monitoring; openings och synthetic bitlika. 2 000 världar: 9 ändras, 9 varningar tidigare (median
20 s), 0 före kö, 0 nya fantomer, 0 nya varningar efter korsning.
**Restfönstret (§8):** ett köfix efter tystnadsgränsen, när hon i egen fart redan skulle ha nått Järnvägsbron men före
c14938f:s gräns. Det kräver under 2,8 kn och är högst 257 m/sog − 180 s brett (70 s i 2,0 kn, 20 s i 2,5 kn). Ingen av
motorns 320 köer vid Järnvägsbron ligger där.
**Test:** 20 fall, 5 frusna världar; nya är kö nära bron (202 och 300 m, glapp 195 och 230 s) och 1511-varianten. Röda
fall: c14938f 3, 19e87b5 6, bara 210 s 3, bara egen fart 2, 229561e 0.
**Batteriet** (V/D/batt-efterbron2): alla 13 steg gav 0 (jest 5 284 test), porcelain bara node_modules. Quick mot
V/bas/quick: bara 263:s T2 LEDTID borta. B + D utan konflikt (39/39 grönt). Öppet: tunna ledtider när båten hörs (T2).
