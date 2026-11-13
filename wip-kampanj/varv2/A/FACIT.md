# FACIT — familj A SAMMA-TICK (varv 2, revision 1)

**Inget låst facit flyttas.** Ingen rad i någon låst korpus ändras, så U13 behöver inte
prövas mot rådata.

## Belägg (batteriet på revisionen 5edfe20, `V/A/batt-rev1`)

- **`replay:all` utan och med monitoring:** slutkod 0, och "Alla låsta korpusar matchar
  facit". Utdatan är bitlik mot c14938f, med 0 diffrader mot egna c14938f-körningar
  (`V/A/res/bank/c14.log` och `c14-mon.log`).
- **`replay:openings`:** slutkod 0. Utdatan är bitlik mot triagens c14938f-baslinje
  (`V/tA/matningar/base-openings.log`).
- **Fassvepen utan och med monitoring:** slutkod 0, och inget odokumenterat fasberoende.
- **`replay:synthetic`:** de 74 scenarierna från c14938f ger radlik utdata. 5 scenarier
  har tillkommit (79).
  - U14-brusscenariot har fått taket `maxOpeningsPerBridge: { Klaffbron: 2 }`. Det är en
    ny förväntan, inget flyttat facit: utfallet (passager 2, notiser 4, öppningar 3) är
    detsamma som på c14938f.
  - De två utliggarscenarierna tål en DEFAULT-FLASH som kommer likadant på c14938f.

## Utanför facit (redovisat enligt granskningen)

Notistexter bärs inte av någon facitdimension (ARCHITECTURE §golden). I familjens världar
ändras följande, och ingen ändring berör en låst korpus:

| Värld | Notis | c14938f → revisionen | Bedömning |
|---|---|---|---|
| 936 | Klaffbron | "om 1 minut" → "om 2 minuter" (154 m, korsning 46 s senare) | sämre |
| 1918 | Stridsbergsbron | "strax" → "om 1 minut" (97 m, korsning 9 s senare) | sämre |
| 169 | Klaffbron | "om 2 minuter" → "om 3 minuter" (170 m, korsning 43 s senare) | sämre |
| 1208 | Stridsbergsbron | "har precis passerat" → "passerade … under AIS-tystnad" | rättare |

- **ETA-texterna (936, 1918, 169):** ETA-koden är orörd (U22). Historiken börjar ett fix
  tidigare, och utjämningen förlänger därför första ETA:n. Annan trafik med målbro i två
  fix får samma utjämning. Hör till de uppskjutna ETA-korten.
- **1208:** båten var tyst i 13,5 min, så "under AIS-tystnad" är sannare. Antalet notiser
  per bro är oförändrat.
- **1316 och 1317:** identiska notiser.
