# RESULTAT — familj A SAMMA-TICK, revision 1 (5edfe20 på 91641f9 och ab9c57c)

**Revisionen** (`V/A/GRANSKNING.md`; detaljer i DESIGN.md):
- H1: `assignTargetAfterReversal` avstår, och nästa fix avgör, när riktningen som skulle
  låsas motsäger den nyss bekräftade vändningen vid ≥ 2 kn. Villkoret delas med C4b
  (`_routeLockVerdict`).
- B2-undantaget (mitt svep): kontrollen plus villkorslöst B2 tappade Järnvägsbrons
  returnotis i 2 av 504 banor, eftersom ett brusfix gav fel sida för ankaret. B2 gäller
  nu bara när kursen inte motsäger återkorsningen; 1317 behöver det fortfarande.
- Test (79 scenarier, ny `maxPassagesPerBridge`):
  - seed 9715 är rött utan kontrollen;
  - seed 9713 är rött först utan både kontrollen och vakten. Vakten är ett andra lager
    för M2 och det enda skyddet för M1;
  - 11 enhetstest (10 röda på c14938f); M1-testet fångar målbron vid `_observeBridgeOpening`.
- Dokumenten är rättade: vaktens pris (138 ovarnade korsningar inom 70 m, som c14938f),
  ETA-utjämningen i 936, 1918 och 169 (U22) och notiserna i 1208 och 1316.
  Systervägarna i app-lagret lämnas med motivering (0 vändningar via dem i banken).

**Mätningar:**
- `V/A/batt-rev1`: 13/13 steg har slutkod 0 (jest 370/5275), porcelain visar bara
  node_modules, och banken och openings är bitlika mot c14938f.
- `hunt --repro` ger BORTA för exakt de nio familjekorten.
- Quick mot `V/bas/quick`: identiska fynd i 25 kluster, inga nya kort. Två räknare ändras,
  bara i 169 och 269.
- Svepen (2 × 504) är signaturlika med c14938f.
- Returernas ledtider är oförändrade: 936 46 → 113 s, 1918 10 → 77 s, 1274 23 → 389 s,
  och 1317, 1316 och 1208 går från ingen varning till 101, 196 och 74/632 s.

**Öppet:** M6 (D): spärren gäller från fixet efter vändningen. I värld 169 kommer
returvarningen för Stridsbergsbron 824 → 123 s före.
