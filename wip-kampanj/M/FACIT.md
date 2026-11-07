# Familj M: facitförflyttningar (U13), revision 3

Prototyp: `454850a` (bas `7699cbe`; revision 1 `c6a765d`).

## Resultat

**Inget låst facit flyttas.** Ingen korpus behöver låsas om, och inga rader i
corpora.js eller golden-text behöver bedömas mot rådata.

## Belägg

1. **`npm run replay:all`:** "Alla låsta korpusar matchar facit". Utskriften är
   identisk med `7699cbe` rad för rad (`matningar/replay-all-rev3.log` mot
   `matningar/replay-all-7699cbe.log`).
2. **Byte-jämförelse av replayresultaten** för alla 24 korpusar, `7699cbe` mot
   revisionen, med full debuglogg (`matningar/bank-bytejamforelse-rev3.txt`). Alla
   resultatfält jämförs utom tid och heap. Resultat: 0 av 24 korpusar skiljer sig,
   och alla TARGET_CHANGE-rader med etiketter är identiska. Båda återinträdesproven
   slår till 0 gånger i banken (0 REENTRY_APPROACH_PROOF- och 0
   REENTRY_SPEED_PROOF-rader), så banken prövar inte den nya koden.
3. **Öppningsgrindarna, fassvepet över banken, sex fassvep med minutstädning och
   72 h-soaken med minutstädning** har samma utskrift som på `7699cbe`. Soaken
   skiljer bara i heap-talet och fassvepen bara i tidsangivelser (`matningar/`).

## Det som ändras utanför det låsta facit

Inget av detta är låst facit. Det redovisas för fullständighetens skull, med
rådatabelägg från buggjägarens sanning (L0), generatorns sanning eller rådata i
jsonl. Raderna för 933, 757 och de första syntetiska scenarierna är oförändrade
från revision 1. Utfallet där är identiskt med revision 1, hela resultat-JSON:en
utom heap.

| Underlag | Ändring mot 7699cbe | Typ | Belägg | Bedömning |
|---|---|---|---|---|
| Värld 933, minsta repro (fixturen `m-f05-wilma-krypfart-norr-om-klaffbron.jsonl`, byte-lik med buggjägarens `repro.jsonl`) | "Inga båtar" 17:19:30–17:20:00 försvinner. Texten står på "…Stridsbergsbron" från passagen av Klaffbron (17:16:00) till passagen av Stridsbergsbron (17:31:00). | text | L0: WILMA korsar Klaffbron 17:16:40 i 0,5 kn, Järnvägsbron 17:29:12 och Stridsbergsbron 17:30:40, utan stopp. Hon var på väg mot Stridsbergsbron hela tiden. | rättare |
| Värld 933 | ETA kl. 17:21: "om 15 minuter" (förut "om 72 minuter"). Målbron återtilldelas inte, så ETA-serien nollställs inte. | text | L0: Stridsbergsbron korsas 17:30:40, alltså 9 min 40 s efter 17:21. Felet minskar från +62 till +5 min. | rättare |
| Värld 757 (återskapad ur generatorn, radhash `b6ec3ab3…`) | DEFAULT-FLASH 14:05:29 försvinner (ALVA, samma mekanism). | text | L0 (`w757-R0.truth.json`): ALVA korsar Klaffbron 14:02:23 i 0,5 kn, Järnvägsbron 14:17:28 och Stridsbergsbron 14:19:20, utan stopp. | rättare |
| Värld 757 | ETA kl. 14:06:29: "om 15 minuter" (förut "om 72 minuter"). | text | L0: Stridsbergsbron korsas 14:19:20, alltså 12,9 min efter 14:06:29. Felet minskar från +59 till +2 min. | rättare |
| Notiser, öppningsvarningar och passager i 933 och 757 | Oförändrade | – | `matningar/varld933.txt`, `varld757.txt` | likvärdig |
| **Granskarens slinga-C** (`tests/fixtures/m-f05-slinga-c-bortglidning-och-vandning.jsonl`), omskriven rad | **Ingen ändring.** "Inga båtar" står 30 s (17:06:00–17:06:30), som på 7699cbe. Revision 1 hade 150 s, och den raden kallades "rättare" utan belägg enligt U13. Omgranskningen underkände den. | text | Korsningarna (U13:s rådatafacit, `targetPassages` mot jsonl): Klaffbron 17:00 och Stridsbergsbron 17:17, ingen återkorsning, så båten var på väg mot Stridsbergsbron hela tiden. Granskarens variant (ingen beväpning vid bortrörelse ≥ 10 m) ger utfallet identiskt med 7699cbe (`matningar/slinga-C-rev3.txt`). | likvärdig (= 7699cbe) |
| Granskarens slinga-C | Notiser, öppningsvarningar och passager | – | `matningar/slinga-C-rev3.txt` | likvärdig |
| **Granskarens klass H, 0,65 kn s1** (`tests/fixtures/m-f05-fartgrind-0.65kn-soder-om-stallbackabron.jsonl`) | 9 DEFAULT-FLASH blir 0 (revision 1: 10). "Inga båtar" står i stället oavbrutet medan båten kryper (INV-14W, informativ). | text | Generatorns sanning: 0,65 kn ± 0,1 kn, 560–1650 m söder om Stallbackabron, alltså mer än 500 m från varje bro, där fartgrinden ger "likely anchored" vid 0,7 kn och lägre. Retentionen tar bort målbron efter fyra prov under grinden i rad, och revisionen lägger tillbaka den efter fyra prov över grinden i rad. Notiser, varningar och passager identiska (testet i hela appen). | rättare (ingen blink; texten följer fartgrindens beslut i stället för enstaka brusprov) |
| Det nya syntetiska scenariot `fartgrind-krypare-söder-om-Stallbackabron` (seed 96, ej låst) | 9 DEFAULT-FLASH blir 0 (revision 1: 8). En INV-14W (2 550 s) tillkommer. Över seed 94–99: 7–12 blir 0. | text | Samma som klass H. Notiser, varningar och passager identiska över alla sex seeds (`matningar/nytt-scenario-seed94-99.txt`). | rättare |
| De två syntetiska scenarierna från revision 1 (seed 94 och 95) | Oförändrade mot revision 1: 5 respektive 7 DEFAULT-FLASH blir 0, med en INV-14W var. | text | Generatorns sanning: 0,12 kn (≈ 5,6 m per nådafrist) respektive stilla i 20 min. | rättare |
| Klassvepen (756 körningar, ej låsta) | DEFAULT-FLASH 3 340 → 558 (revision 1: 663). Ingen körning sämre mot 7699cbe eller revision 1. | text | Generatorns sanning per klass; notiser, varningar och passager identiska i alla (DESIGN §5). | rättare |
| Avgångssvepen (58 avgångar, ej låsta) | En avgång under 2,0 kn får första "på väg mot"-texten 30–60 s senare i 12 av 58 fall (7 av dem är nya mot revision 1, alla från fartprovet). 2 fall får texten tidigare och 44 samtidigt. Notiser, varningar och passager är identiska. | text | Rådata i jsonl: avgångens fart (1,0–1,9 kn) och, i "f0"-fallen, en första fix med fart men oförändrad position. Fördröjningen är rättningens pris för att retention och återinträde ska döma symmetriskt, och den följer dirigentens beslut (väg 1). Se DESIGN §5.4 och §7 (d). | sämre (accepterat pris; dirigentens beslut, låst med test, inga notiser eller varningar berörs) |
| 72 h-soaken (replay:monitoring, ej låst) | Ingen ändring mot 7699cbe (761 textövergångar, samma 6 INV-14W). | text | `matningar/replay-monitoring-rev3.log` | likvärdig |

**Om raden "sämre":** avgångsfördröjningen gäller inget låst facit och ingen
notis, varning eller passage. Den är den uttalade konsekvensen av dirigentens
beslut att följa väg 1 ("ACCELERATED ska kräva att samma grind håller under ett
fönster lika långt som TARGET_REMOVAL_GRACE_PERIOD"), och den är begränsad till
avgångar under `FIX_D_MIN_SOG`. Från 2,0 kn räknas meddelandets egen fart som
bevis, och då finns ingen fördröjning. Den redovisas här för att U13:s krav på
öppen redovisning ska vara uppfyllt, inte för omlåsning.
