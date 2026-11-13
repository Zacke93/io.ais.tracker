# OMGRANSKNING — familj E (MOTOR), varv 2, revision 1

Granskad kod: `V/E/rwt` = 5839d56, alltså 1dfd18a och fem commits: f0b7dc0 H1, d7dd393 L1, 703bbf1
L3, d913146 revisionslistan och 5839d56 L2, L4 och L5. Mina körningar ligger i `V/E/rkör2`,
mutantkopiorna i `V/E/rmut2`, skripten i `V/E/rscripts` och tempfilerna i `V/E/rtmp`.
V = S/varv2. Lasten var 0–14, så tiderna nedan är rimligt rättvisande.

## Dom: GODKÄND

H1 (hög) är rättad, och L1, L3 och L4 är rättade och provade. L2 och L5 står som kända gränser och
öppna frågor. Kvar är en låg anmärkning (R1) som ska dokumenteras som känd gräns. Den kräver ingen
ny revision.

## 1. H1: (3′) oberoende av appens flaggor och fönsterslut

Koden i f0b7dc0 är mitt förslag (`V/E/rtmp/förslag-H1.diff`):
- `rentBakkantsfix` läser inte `lastFixClean`;
- `domensFönsterslut` tar det tidigare av `windowEndMs` och det räknade slutet;
- (3a′) prövar fysiken ur varje rad efter `bok`.

Quick (`--lanes=synth --no-shrink`, `V/E/rscripts/mutdiff.js`):

| Mutation | App | Nya utslag | Utfall |
|---|---|---|---|
| aldrig rent fix (`rmut2/ren` mot `ref`) | c14938f | 23 | **21 KANDIDAT**, w235 U17 och J13 (som c14938f:s motor) |
| fönsterslut = täckningsslut (`rmut2/bfon` mot `bref`) | B 5d4b2c3 | 3 | **3 KANDIDAT** (w110 ×2 och w260) |

- **Jest:** de tre nya H1-vakterna fäller 1dfd18a. På 5839d56 är 434 av 434 test gröna.
- **Andra vägar att lura (3′).** Jag provade en mutation där första passagen sätts till
  bokföringstiden i stället för den skattade korsningen (`rmut2/skatt`: `event.firstPassageAt = now`
  i `_recordPassage`). Det gav 5 nya utslag: 2 KANDIDAT, 2 U17 (w235, som förut, och w260) och 1
  J13. c14938f:s motor med samma app (`rmut2/basskatt`) ger 3 KANDIDAT, eftersom även w260 blir
  KANDIDAT. Se R1.
- **Övriga flaggor:** `frozen` och `courseAway` undantar fortfarande en dom från prognosprovet,
  men inte från fysikprovet (3a′). Appen släpper inte heller en fryst arm eller en arm med kursen
  bort vid täckningsslutet. Jag hittade ingen fler väg.

## 2. L1: radion i AISHub-läget

`node V/E/rscripts/m9.js V/E/rwt 0 2000 V/E/rtmp/m9-rev.json` kör standardens 2 000 världar med ny
och gammal radio. I AISHub-läget dras intervallet nu ur en egen ström per avgång.

- **Determinism:** samma seed två gånger ger 0 avvikelser. R0 är bitlik i 2 000 av 2 000 världar.
- **Vad som ändras:** 370 världar och 417 båtar, alla med en avgång. Ingen båt utan avgång ändras.
- **Avgångarna:**

  | Era | Avgångar som ändras | Hörs senare (fix / mottagning) | Rader före avgången som ändras | Första fix p50/p90/max, ny mot gammal |
  |---|---|---|---|---|
  | aisstream | 242 | 0 / 0 | 0 | 76/300/685 s mot 398/913/1 778 s |
  | AISHub | 130 | 0 / 0 (alla 130 hörs tidigare) | 0 | 57/96/147 s mot 199/549/1 371 s |

  Konstruktionen garanterar detta. En fix från före avgången prövas mot den gamla tiden, och
  båtens egen ström rörs inte.
- **Realismtabellen** (`realism.js`) stämmer med BUGGJAKT §4.2 och A.8:
  - aisstream: 101/324 s, korsningsglapp p90 735 s, sista fix före korsning p90 1 053 s;
  - AISHub: 71/123 s, korsningsglapp p90 337 s, sista fix före korsning p90 191 s.
- **Värld 1527 är borta.**
  - DAGNY:s rader är nu desamma som i den gamla radion: stillafixet 09:27:13 och sedan rörelsefixet
    09:28:32, 62 s efter avgången.
  - `hunt.js --repro` på std-efter:s F06/r2 ger BORTA, med 0 utslag i världen.
- **Jest:** det nya AISHub-testet fäller 1dfd18a.

## 3. L3: try/catch och waitingAtBridge

- **Felhanteringen:** domen räknas utanför try och returneras alltid, så appens egna undantag går
  igenom som förut. Ett fel i bokföringen blir en post med `fel`. Den posten gör spåret till en
  okänd form, och då svarar U17 och K-NÄSTA nej.
- **Köflaggan:** `arm.waitingAtBridge` bokförs och prövas i U24-postens grind `kö`.
- **Replay** (`V/E/rscripts/bitlogg.js`): 26 av 26 korpusar har lika JSON och lika app-logg mot
  c14938f, med och utan monitoring. Bara domspåret (204 domar) skiljer.
- **Anropen:** `_coverageVerdict` anropas lika ofta med samma argument och returvärden
  (`räkna.cjs`: 395 och 154 anrop, samma hash).
- **Jest:** de två L3-testen fäller 1dfd18a.

## 4. Revisionslistan (d913146) och L2

- **U24-postens andra släppväg.** Hennes eget U24-släpp ur E0 måste klara samma villkor och grindar
  som L:s (`u24Brott`). Med U24:s sju policygrindar bortkopplade (`rmut2/bu24`) tar posten
  ingenting nytt.
- **O1:** de två T2-utslag som O1 tar är oförändrade sedan förra granskningen och står som öppen
  fråga.
- **B:s revision 2** (e5f78b5) mot 5d4b2c3: 0 ändrade utfall. Värld 143 är DESIGN U24 i båda.

## 5. Självtest, quick och tider

- **Självtestet** (63 s) är GRÖNT: determinism 24/24, SHIFT30 24/24, MMSI 24/24, kanarier 5/5 och
  rundresa 45/45. Låst bank har 0 nya träffar.
- **Quick** (`rkör2/quick`) ger 58 utslag, 24 kluster och 4 kort. Sanningsspårets hashar är
  desamma som i familjens `batt-rev1`.
- **Quick mot V/bas/quick:**
  - 290 är borta;
  - 138 blir U1-C11;
  - w129 är nytt.

  w129 (SALTIS 2) är U23:s köfall vid Kajen i c14938f:s app. Det bekräftas i R0, och T2-kortet
  bär nu det fallet i stället för radioartefakten 290. Med F:s 0dce236 och E:s motor ger kortet
  BORTA, och E:s `replayRunner.js` läggs rent ovanpå F:s.
- **Motorns jest-sviter vid last 1–4:**

  | Körsätt | 5839d56 (434 test) | c14938f |
  |---|---|---|
  | i följd (`--detectOpenHandles`) | 10,3–11,0 s | 8,6–9,6 s |
  | parallellt | 5,6–5,9 s | 4,9–5,2 s |

  Inga öppna handtag. Kravet på 5 s håller inte, och det står som öppen fråga.
- **Lint:** `eslint --max-warnings=0` ger exit 0. Porcelain visar bara node_modules.

## Anmärkning

**R1 (låg): fönsterslutet bygger fortfarande på appens skattade första passage.**

Det räknade slutet i (3′) och (3a′) är `max(firedAt, firstPassageAt) + CONVOY_WINDOW_MS`, och båda
talen kommer ur appens händelse. Blir appens skattning fel, som i mutationen `skatt`, flyttas
fönstret med. Därför blir w260 U17 i stället för KANDIDAT.

En gräns ur sanningen, `max(e.t, förstaT) + fönsterMs`, går inte att införa:
- jag provade den i `rmut2/fixs-ref`, och då föll 8 test, bland dem träffen för de nio;
- w1704 (K-NÄSTA) skulle bli KANDIDAT, eftersom appens skattning där med rätta ligger 4,5 min
  efter den sanna korsningen (12:16:01 mot 12:11:29) efter ett AIS-avbrott.

Begränsningen hör alltså till premissen "bakkanten kunde inte släppa henne", som mäts mot det appen
visste.

Förslag: skriv den som känd gräns i §7 vid U17 och K-NÄSTA, och lägg mutationen `skatt` (1 av 3
dolda i quick) i A.8.
