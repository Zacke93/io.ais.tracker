# RÅDATAFACIT — brokorsningar per korpus (A2, etapp 7, 2026-08-08)

Filerna i den här katalogen är **facit**, inte cache. De genereras av
`makeGtPassages.js` ur korpusarnas jsonl och svarar på frågan **när passerade
fartyget bron enligt RÅDATAN** — oberoende av vad appen råkade registrera.

Bakgrunden är 42h-fältprovets F-20: appen bokförde 96 av 107 verkliga
målbropassager, och O1/INV-5/INV-13/INV-21 mätte mot appens egna bokföringar.
Blindheterna är **korrelerade** — två blinda mätare som jämförs med varandra ser
falskt bekräftande ut.

```
node tests/replay-validation/makeGtPassages.js              # generera om allt
node tests/replay-validation/makeGtPassages.js --check      # incheckat == genererat (CI-vänlig)
node tests/replay-validation/makeGtPassages.js --audit <id> # rådatabevis per post
node tests/replay-validation/makeGtPassages.js --anchor-check
```

`index.json` mappar jsonl-basename → korpus-id, så en konsument som bara har
`result.jsonl` (invariants.js) hittar rätt facit.

## Postformat

| Fält | Betydelse |
|---|---|
| `mmsi`, `name` | fartyget (namnet = senaste riktiga namnet på/före korsningen) |
| `bridge`, `bridgeId` | bron / triggerpunkten |
| `kind` | `line` = brokorsning, `zone` = besök innanför Kanalinfartens 300 m-radie |
| `t`, `iso` | korsningstiden, **interpolerad**, i LEVERANSDOMÄNEN (`aisTimestamp`) |
| `tFix` | samma korsning i FIXDOMÄNEN (`fixTs`) — för källfärskhetsmätningar |
| `tFrom`, `tTo` | sampelfönstret korsningen ligger i (`tFrom: null` ⇒ före korpusstart) |
| `inferred` | `true` ⇒ korsningen är BEVISAD men tiden är bara ett fönster |
| `dir` | `nord`/`syd` längs farleden |
| `gapS` | glappet mellan de två sampel som straddlade bron |
| `dp`, `dq` | avstånd **längs farleden** från respektive sampel till brostationen |
| `stepM` | sampelparets steg längs farleden |
| `offP`, `offQ` | sampelpunkternas sidledsavstånd till farledspolylinjen |
| `fp`, `fq` | källa per sampel (`aisstream`/`aishub`) |

**`inferred` får ALDRIG användas som punktstämpel.** Räkna dem i täckningens
nämnare (de är verkliga passager), men uteslut dem ur varje tidsfönstermätning
— A3 gör exakt det, och differensen mellan serierna ÄR källtystnadsmåttet.

## Geometrin i korthet

* Farleden = `coverageMap.FAIRWAY_CENTERLINE` (36 noder, härledd ur korpusarna).
  Varje fix projiceras → `s` = meter längs farleden.
* Broarna ligger som **frusna stationer** i `BRIDGE_STATIONS` — generatorn läser
  **aldrig** `BRIDGES` för geometri. Motiv: `BRIDGES.stallbackabron.lon` är
  ~221 m fel och rättas i C0; ett facit som läser den koordinaten bygger in
  exakt den buggklass C0 ska rätta. Med frusna stationer är facit **immunt** mot
  C0 och behöver inte köras om när koordinaten landar.
* Korsning = teckenbyte i `s − s_bro` med **dödband 50 m** på båda sidor
  (kajvobbel kan inte generera korsningar), sidledsgrind 250 m på **båda**
  sampelpunkterna, och hoppvakt 40 kn.
* Kanalinfarten är en **zon**, inte en linje: besök innanför 300 m räknas bara
  med rörelsebevis (någon fix ≥ 2 kn eller ≥ 100 m nettoförflyttning), och
  `inside` initieras från FÖRSTA samplet så att en vistelse som pågår vid
  korpusstart syns.

## Kända artefakter — EXAKTA knownException-strängar

Strängarna nedan är avsedda för prefixmatchning (samma mekanism som
`corpora.js` → `knownInvariantExceptions`). De är **rådataverifierade** och ska
inte "rättas" bort.

### KE-1 · INV-21 vid 20260708-21h (WARN, ej fatal)

```
INV-21 ÖPPNINGSVARNING EFTER PASSAGE: Stridsbergsbron varnades 2026-07-08T07:37:35.461Z (Stridsbergsbron#9) men medlemmen 257919970 passerade redan 2026-07-08T07:28:55.880Z
```

Uppstår FÖRST när INV-21 mäter mot rådatafacit (A3) och är **inte** en
regression: JAATTEN II (257919970) levererade sitt sista sampel söder om
Järnvägsbron `07:25:57` (58.29008, 4,8 kn) och nästa `07:39:56` (58.30625,
4,4 kn) — 2 195 m på 840 s. Både Järnvägsbron och Stridsbergsbron korsades i
glappet. Appen bokförde passagen först vid det senare samplet, vilket gjorde att
O1 rapporterade 141 s ledtid för en varning som gick ut `07:37:35`.
**Sanningsvärdet är sannolikt men inte säkert:** interpolationen (5,1 kn mot
uppmätta 4,8→4,4 kn) lägger korsningen `07:28:55`, men fönstret sträcker sig
till `07:39:56` — i fönstrets ytterkant vore varningen laglig. Utslaget är
alltså en **äkta kandidat**, inte ett bevis, och rapporteras med fönstret
utskrivet så att en granskare kan döma själv.

### KE-2 · Korsningar vid korpuskanten saknas MED FLIT

En korsning vars enda bevis ligger före korpusens första sampel kan inte
bokföras. Rådataverifierat exemplar (42h-korpusen):

```
211216440 NIGE-O @ Stallbackabron 2026-08-07T09:02:02.740Z
```

Posten finns i dirigentens oberoende facit men **inte** i vårt. NIGE-Os första
sampel någonsin (`2026-08-07T09:01:43.155Z`, lat 58.31068, lon 12.31783,
sog 5,9, cog 206,8) ligger redan **76,7 m söder** om den rättade brostationen.
Det finns inget sampel norr om bron. Dirigentens post är en artefakt av den
felaktiga brokoordinaten (186 m vid sidan av farleden ⇒ stationen 97 m för långt
söderut). Fysiskt skedde korsningen ~25 s före inspelningens start.

### KE-3 · `inferred` utesluts ur tidsfönstermätningar

Inte en sträng utan en **regel**: 84 av 275 målbropassager i de 16 grindade
korpusarna är `inferred`. De räknas i täckningen men aldrig i ledtids-,
tunn-ledtids- eller INV-21-mätningar. En konsument som mäter marginaler mot en
`inferred`-tid uppfinner precision som inte finns.

## Diff mot dirigentens oberoende facit (42h-korpusen, 2026-08-08)

`--compare` mot `faltdygn3/gt-passages.json` (137 poster, gammal metod):
**116 matchade · 14 bara våra · 21 bara dirigentens.**

* **+12 `line`, alla `inferred`** — exakt de gap-korsningar F-19 pekade ut
  (NIGE-O ×3, AGULHAS ×3, LENYA ×3, FILOU ×2, ELFKUNGEN ×1; glapp 1 007–11 055 s).
* **+2 `zone`** — UTOPIA och VALKYRIA, vistelser som pågick vid korpusstart
  (`inside`-initieringen, krav iii).
* **−20 `zone`** — Kanalinfartens GPS-brus (ELFKUNGENs kajplats på 295–305 m
  ×17, BOBLEN, SKYBIRD:s andra "intrång", S/Y DESIREE). Exakt den andel F-19
  räknade fram (20 av 42).
* **−1 `line`** — KE-2 ovan (NIGE-O @ Stallbackabron).

Tidsskiften mot dirigentens poster är ≤ 64 s för brokorsningar (Stallbacka-
stationen flyttas 97 m när koordinatfelet inte längre styr) och ≤ 279 s för
Kanalinfartens zonposter (vi interpolerar radiekorsningen; dirigenten stämplade
första observationen innanför). Två zonposter skiljer mer (ELFKUNGEN 1 009 s,
CAVAT 278 s) — båda är glapp där båten låg still vid kaj och sedan avgick;
den förra är därför `inferred`.

Mot **nattens** facit (`night-facit/gt-passages.json`, 23 poster) matchar
**23 av 23** — inga saknas, och vi hittar två zonposter till (PRICKBJORN vid
korpusstart, SALTYX 06:22 med 44 s glapp).
