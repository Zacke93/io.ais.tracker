# Familj G: registerposterna U25 och U26 (2026-11-09 och 2026-11-10)

## Vad som gjordes

Ägaren godtog fynd 1038 och 1139 som kända gränser. Besluten speglas i buggjägarens
beslutsregister med två ACCEPTERAD-poster. Appens kod är oförändrad.

- **U25-BAKKANT-VID-SEN-BOKFÖRING** (T3 VARNING-EFTER-SANN-PASSAGE), predikatet
  `bakkantVidSenBokföring`, villkor (a)–(g).
- **U26-STILLA-KÖ-SEN-VARNING** (T2 LEDTID), predikatet `stillaKöVidTäckningsslut`,
  villkor (a)–(e).
- Hjälparna `motornsTäckningsslut`, `förstaPassageunderlag` och `släppvägenHöllHenne`.
- Dokument: docs/ARCHITECTURE.md (släppvägen, punkt (d), och U25/U26-punkten),
  docs/BUGGJAKT.md §7 (posttabellen, avsnittet om U25 och U26, rad 53 och 54) och bilaga A.9.

En agent skrev predikaten och ARCHITECTURE-texten. Den stoppades av en containeromstart.
Dirigenten skrev testerna, mutationsproven, BUGGJAKT-texten och integrerade, utan fler agenter.

## Mätningar (appen på eda1839, seed 1)

- **Standard** (`V/G/std`, 5 min): självtestet grönt, 222 råa utslag, 43 kluster och 5 kort,
  alla INV-3 ETA. Före posterna var det 7 kort. U25 och U26 har en träff vardera.
- **Jest:** `l-u25-u26.test.js` har 25 test (3 träffar och 22 vakttest). Motorns 28 sviter och
  459 test är gröna. Lint är rent.
- **Repro:** F04 (1139) och F05 (1038) ur `V/integ/std-final` klassas ACCEPTERAD U26 och U25.
- **Mutationsprov** (`V/G/mut`, standardens sanningsspår, 2 000 världar, utan krympning):

  | Mutant | Nya utslag mot baslinjen | U25 och U26 |
  |---|---|---|
  | A: bakkanten bortkopplad | 78 (70 KANDIDAT, 8 U2-VS-DEADLINE) | inget nytt |
  | B: U24-släppet bortkopplat | 4 (2 U17, 1 K-NÄSTA, 1 KANDIDAT) | inget nytt |
  | C: täckningsslutet 2 min sent | 18 (15 U17, 1 U2-VS-DEADLINE, 1 K-NÄSTA, 1 KANDIDAT) | inget nytt |
  | D: bokföringen 3 min sen | 10 (4 KANDIDAT, 3 U2-VS-DEADLINE, 2 U17, 1 K-NÄSTA) | inget nytt |

  Värld 979 med mutant B (fixturens `w979utanU24`) förblir KANDIDAT.

## Integration

- V/G/wt: 0bb2d93 (bas eda1839).
- Produktgrenen: e51c7b6 ovanpå e1759eb. Radhänvisningen till ARCHITECTURE i de två posterna
  är rättad till :2312–2319, eftersom e1759eb flyttar raderna.

## Kända gränser och öppna punkter

- Referensankomsten i motorns täckningsslut läses ur appens domar (`windowEndMs`).
- Posterna räknar bara om U24:s grindar `kö`, `ingen-fysik` och `inom-fönstret`.
- **U17 (inte de nya posterna):** U17 prövar inte täckningsslutets tid mot händelsen. Mutant C
  gav 15 nya utslag som U17 tog, och mutant D gjorde 1038 till ett RECOVER-släpp som U17 tog.
  Det är inte åtgärdat. Det är en möjlig förbättring av buggjägaren, inte av appen.
