# Granskning av familj F (KAJ, ägarbeslut U23), varv 2

Granskare: adversariell granskning enligt V/GRANSKNING2.md. Granskat: commits 0873322 och
3887254 (V/F/rwt), mot basen c14938f (V/F/bwt). Prober i V/F/pwt (lokal, ej committad).
Tempfiler, scenarier och körloggar ligger i V/F/rtmp. S = scratchpad, V = S/varv2,
R = V/F/rtmp.

## Dom: ÄNDRINGAR KRÄVS

Kärnan är rätt och smal. Under 300 m från bron står köaren vid Kajen kvar hela kön med samma
text som en köare i farleden. Värld 313 är BORTA, testerna fäller c14938f av rätt skäl,
negativtesterna klarar båda träden, banken är bitlik och hela batteriet är grönt.

Två saker måste rättas före integrationen:
- **M1:** Det nya kandidatkortet i quick (INV-10, värld 129) har fel förklaring. Det är dessutom
  ett systematiskt falskt FATALT utslag för just det beteende U23 beslutar.
- **M2:** U23 håller inte i kapselns norra spets (300–320 m). Familjens påstående om spetsen är
  fel, och dokumentationen lovar mer än koden gör.

M3 är en befintlig lucka i kajavgångsgrinden som är belagd i fältdata. Den hör till en egen
uppföljning och fäller inte U23.

## Vad jag verifierade (utan anmärkning)

- **Rotorsaken på c14938f.**
  - `hunt.js --repro V/tA/cards/F02-w313-Klaff` ger KVAR på basen (T2 LEDTID: Klaffbron#6
    10:27:49, 32 s före korsningen) och BORTA på F.
  - Den verbosa loggen på basen visar `[MOORED] … zon "Kajen norr om Klaffbron" (still 18 min)`,
    "Inga båtar" 09:49:04–10:27:49 och `OPENING_QUAY_DEPARTURE` följt av Klaffbron#6 vid 82 m.
- **Beslutet som det är skrivet** (R/vdsprobe.js, familjens kaj-scenarier, egna scenarier i R/sc):
  - Norrgående med Stridsbergsbron 969 m bort demoteras efter 3 min. KNORR är identiskt på bas och
    F, även dess DEFAULT-FLASH på 240 s.
  - En båt utan målbro och en kajliggare utan rörelsebevis klassas efter 3 min (enhetstesterna
    gröna på båda träden).
  - Gästhamnen (`queueGraceMs` 0) är orörd.
  - Navstatus 5 klassar direkt (KNAV5). Även en ensam navstatus-5-flapp ger permanent förtöjd
    enligt S-F7, samma som basen.
  - 2 h-gränsen: K150 klassas 10:28:08 efter stopp 08:27:36, alltså 120,5 min.
- **Mål som byts under väntan** (R/vdsprobe.js):
  - En ensam fartspik norrut ändrar inget.
  - Två omvända fix på 2,4 kn ger `TARGET_RECALC`. Målet blir Stridsbergsbron (969 m), sedan
    `[MOORED] zon … (still 3 min)` och `MOORED_DEMOTE`. Exakt som c14938f, och enligt U23 är hon
    då ingen köare mot Klaffbron.
  - En långsam förflyttning på 0,8 kn och 60 m längs kajen behåller köaren.
- **Kajavgångsgrinden för köaren.**
  - K60, K110 och X1kaj (60 min, tät AIS, annan trafik) ger en enda Klaffbronvarning och ingen
    `OPENING_QUAY_DEPARTURE`.
  - Med `REPLAY_MONITORING=1` är utfallen identiska (K60, K150, X1kaj, X2kaj).
- **Regressionstesten mot c14938f.** Testfilerna kopierade till bwt: 3 fel av 18.
  - "köaren står kvar i 60 min": `Received: 900000` (förtöjd efter 15 min).
  - "först 2 h-backstoppen".
  - "U23: kö på 25 min … inget nytt kort": `has(KEY)` false.
  - Syntetiska scenariot fäller basen på alla tre villkoren: ÖPPNINGSDUBBLETT, 47 s och
    "Inga båtar" 06:49.
  - Testerna går genom äkta `updateVessel` och äkta `App.onInit`. De är inte tautologiska.
- **Banken.** 20260806-42h är bitlik mellan bas och F i alla resultatfält och alla kajrader
  (R/c42.*.out).
- **Samspelet.**
  - A:s, B:s, C:s och D:s patchar går att lägga på F:s HEAD utan konflikt i koden
    (`git apply --check`). Bara räkneraden i docs/VALIDATION.md krockar.
  - D räknar `distanceM ≤ WAITING_CLEAR_DISTANCE` som kö, så Kajens köare omfattas utan
    `waitingAtBridge`.
  - U24 (B:s V1c) kräver mer än 350 m och når alltså aldrig Kajen.
- **Infinity där `queueGraceMs` läses** (grep över app.js, lib/, tests/, tests/replay-validation/
  och bugHunt/):

  | Ställe | Läsning | Utfall med Infinity |
  |---|---|---|
  | VDS:3822 `_zoneMinStillMs` | `typeof === 'number' && > 0` | Infinity, så zonlagret klassar aldrig köaren (rätt) |
  | VDS:3848 `holdsQuayQueue` | `=== Infinity` | sant bara för Kajen med villkoren uppfyllda (rätt) |
  | app.js:1526 | `Number(…) > 0 ? Number(…) : 0` | Infinity (rätt) |
  | app.js:1540 `stopGraceMs` | `=== Infinity && holdsQuayQueue !== true ? 0 : …` | Infinity eller 0 (rätt) |
  | app.js:1580 | `Math.max(30000, stopGraceMs)` | `x >= Infinity` är falskt, så stoppet bekräftas aldrig (rätt) |
  | app.js:1561 `gapResetsStop` | `=== 0` | falskt som förut (rätt) |
  | tests: gasthamnskapseln:102/109/311, m1:293, opening-queue-quay-stop:100/183, u23:239 | `toBe(Infinity)`, `!z.queueGraceMs`, `> 30000` | rätt. Den gamla loopen `elapsed <= KAJEN.queueGraceMs` hade blivit oändlig och är borttagen |
  | runSyntheticScenarios, runSoak, coverageMap, platser.js | bara kapselgeometrin | opåverkat |
  | bugHunt/lib/shrink.js:128 | hårdkodat 900 s | inaktuellt (L2) |
  | bugHunt/lib/registry.js:1318–1321 och 1486 (krav 6) | text och kapselundantag | inaktuell motivering (L2) |
  | V/E/wt registry.js:1222 (ej i c14938f) | `Number.isFinite(…) ? … : 0` | 0, alltså 3 min: fel (L2) |
  | JSON | ingen kod serialiserar MOORING_ZONES. `persistent_opening_warnings` bär inget fält ur zonen. rapport.md citerar bara doktrintexten | ingen null-omvandling |
- **Batteriet** (`bash S/port/battery.sh V/F/rwt V/F/rbatt`):
  - jest 370 sviter (5 276 godkända, 2 hoppade);
  - lint, replay:all med och utan monitoring, synthetic, openings, soak med och utan monitoring;
  - fassvepet med och utan monitoring (24 korpusar, OK);
  - självtestet GRÖNT;
  - porcelain visar bara `?? node_modules`;
  - quick (873 s): identisk med familjens V/F/batt/hunt-quick. Mot V/bas/quick är 40 råa utslag
    och 3 kandidatkluster nu 42 och 4. Nytt är KANDIDAT INV-10 STRAX-ZOMBIE (kort F05, värld 129,
    se M1). U17-TYST-BÅT-RECOVER (DESIGN) har ökat från 7 till 8 (värld 235, som familjen
    förklarar). Bankspåret är oförändrat (45 av 48 rena).

## Anmärkningar

### M1 — medel: INV-10 fäller varje lång kö vid Kajen, och förklaringen av värld 129 är fel

**Påståendet** (DESIGN §6–7, RESULTAT öppen fråga 1): anflygningsbeviset rensas vid passagen av
Järnvägsbron och bekräftas aldrig igen med gles AISHub. Felet fanns redan och doldes av
15-minutersregeln.

**Vad som faktiskt händer:**

1. **Vid Kajen är bekräftad väntan omöjlig, oavsett AIS-täthet.**
   - Harnessens `confirmedTargetWaits` (replayRunner.js:298–307) bygger på `waitingBridge`, och
     `queueBridge` ger null i en MOORING_ZONE (lib/utils/bridgeQueue.js:38–43).
   - INV-10 (invariants.js:511–534, FATAL) fäller därför varje "strax" som står i mer än 35 min
     och slutar utan passage. Det gäller också U23:s egen 2 h-gräns.

   | Prov | F (3887254) | c14938f |
   |---|---|---|
   | `F/kaj/K150` (familjens eget prov) | `STRAX-ZOMBIE … stod 122 min utan Klaffbron-passage` | 0 fatala |
   | `sc/X1kaj` (R0, 60 min kö, en annan båt kommer in i texten efter 48 min) | `STRAX-ZOMBIE … stod 48 min` | 0 fatala |
   | Farledstvillingen `sc/X1far` (samma, tät AIS) | 0 fatala, `confirmedTargetWaits` Klaffbron 08:28:48–09:37:48 | 0 fatala |

   Kommando: `REPO=<träd> node R/inv.js <utfil>`. Texten är densamma i X1kaj och X1far, så
   utslaget är en blind fläck i harnessen och inget appfel. Det syntetiska scenariot (25 min)
   ligger under INV-10:s 35 min och prövar inte den långa kön som U23 handlar om.

2. **Farledstvillingen på c14938f har en annan mekanism.**
   - R/repro.var2-w129.bwt.txt ger samma utslag, så det påståendet håller.
   - Men beviset rensas inte vid Järnvägsbron. Spionen (V/F/runs/var2-129.spion) visar
     Klaffbronbeviset `c:17:04:02` kvar 17:22:02 och 17:24:17 och `ev:null` först 17:25:24.
   - Den fixen (58.28723, 12.28529) ligger 24,3 m från Gästhamnens kapsellinje, med radien 35 m.
     I originalvärlden ligger den 33,4 m från linjen.
   - `_noteBridgeQueueApproach` (VDS:3746–3747) tappar allt bevis när en fix ligger i en kapsel,
     även i transit på 4,3 kn. Med AISHub-takt kommer nästa fix redan vid stoppet.
   - Familjens tvilling flyttar dessutom hela rutten (`laneM` −60), inte bara kön.

**Dom:**
- För värld 129 vid Kajen är det en gräns i harnessen.
- För tvillingen är det ett befintligt appfel i köbeviset. Följden blir också att
  2 h-undantaget (användarvalet 2026-09-06) aldrig når en sådan farledsköare.

**Rättning:**
- (a) E, i replayRunner.js:298: räkna U23-köaren som bekräftad väntan. Skissen ligger i
  R/probe-inv10-harness.diff: läs den levande båten via `vesselDataService.getVessel`, eftersom
  presentationskopian saknar `_hasMovementProof`. Krav: `holdsQuayQueue(live, targetBridge)`,
  `hasFreshPosition` och stilla i minst 60 s.
  - Provat: X1kaj och K150 ger 0 fatala.
  - `hunt --repro F/cards/kaj-w129` ger `MÄTGRÄNS MÄTGRÄNS-INV10-VÄNTKEDJA` i stället för
    KANDIDAT.
- (b) F: rätta DESIGN §1/§6/§7 och RESULTAT till den mekanism som beskrivs ovan, och beskriv (a)
  för E. Lägg till ett syntetiskt kajscenario på mer än 35 min med annan trafik när (a) är på
  plats.
- (c) Separat: farledsfallet. Skissen ligger i R/probe-transit-evidence.diff: behåll redan
  bekräftat bevis genom kapseln vid sog ≥ 0,5 kn.
  - Tvillingen blir då MÄTGRÄNS.
  - Skissen flyttar 20260713-41h (262 mot 264 övergångar), så den kräver U13.

### M2 — medel: kapselns norra spets 300–320 m följer inte U23, och texten skiljer sig från farleden

**Prov:**
- `sc/X3kaj`: kö på 306 m, 18 m från Kajens linje, R0, 40 min.
- `sc/X3far`: samma avstånd i farleden (307 m), 39 m från kapseln.

**Utfall:**

| Prov | Text | Övrigt |
|---|---|---|
| X3kaj på F | "om 4 minuter" 08:27:18–08:47:48, sedan "Inga båtar" 08:47:48–09:08:18 | Stoppet varar 08:27:09–09:07:09. Loggen visar `TARGET_CHANGE "Klaffbron" → "none" \| Reason: STOPPED` |
| X3far | "strax" 08:28:28–08:47:28, sedan "Inga båtar" 08:47:28–09:07:28 | Bekräftad väntan 08:28:28–08:56:58; försvinner också efter 20 min, på F och på c14938f |
| X3kaj på c14938f | "Inga båtar" redan 08:42:18 | |

**Mekanismen:**
- Över 300 m saknar spetsen imminent-flaggan och bekräftad väntan. Den frusna ETA:n blir kvar.
- `_isInTargetQueueZone` (VDS:8318–8327) kräver `lastActiveTime` inom 20 min.

**Vad som är fel:**
- DESIGN §3 säger "får ETA-klausulen som en köare i farleden". Det är fel: farleden får "strax".
- constants.js, ARCHITECTURE §lager 4 och reliability-spec säger "står kvar tills hon kör
  vidare". Det är fel över 300 m.
- Fältets köplatser går upp till 307 m (constants-kommentaren).

**Rättning:**
- BridgeTextService:137: låt en båt som `holdsQuayQueue` håller (läst på den levande båten, färsk
  och stilla minst 1 min) räknas som väntan vid målbron. Då får hon "strax" som i farleden.
- Låt `_isInTargetQueueZone` godta `holdsQuayQueue`.
- Alternativt: begränsa löftet i dokumentationen till 300 m och lyft frågan till ägaren.
  20-minutersgränsen bryter D1 mellan 300 och 500 m även i farleden. Det är en befintlig lucka
  och inte U23:s.

### M3 — medel (befintlig, ej regression, egen uppföljning): avgångsgrinden ger en sen varning eller ingen

**Grinden:** app.js:1545 (`_observeOpeningArrivals`) kräver `!atQuay`. Kapseln ligger mellan Gästhamnen
och bron, så en båt som verkligen lagt till får sin nya varning först när hon lämnat Kajens
kapsel.

**Syntetiska prov** (ledtid mot sann korsning, R/lead.py): K150 (2 h-gränsen), KNAV5, X2kaj
(omstart) och X5kaj (30 min AIS-tystnad) får alla Klaffbronvarningen vid 101 m, 43 s före
korsningen. Det är under golvet på 60 s.

**Fältbelägg** (20260806-42h, S/V REBEL 265827650):
- Hon låg över natten i Gästhamnen och gick söderut dag 2.
- Fältappen varnade: Klaffbron#19, 2026-08-07T08:44:41, 249 m (field-openings.txt:19).
- Rådatans korsning är 08:46:26.7 (gt-passages.json).
- På c14938f och F avfyras Klaffbron#24 vid 249 m men undertrycks (`openingSuppressions`:
  `same-arrival`, firedAt från dag 1 kl. 10:30:04).
- `OPENING_QUAY_DEPARTURE` kommer först efter `FINAL_TARGET_PASSAGE_RECORDED`.

Felet är redan känt. docs/helgranskning-2026-11-03.md:248–253 beskriver det med samma rättning:
"räkna rörelse ≥ 50 m från ett bekräftat stopp som avgång även i en annan kajzon". Det som är
nytt här är att samma grind gör varningen sen för varje båt som U23 släpper vid Kajen
(navstatus, 2 h, omstart, AIS-glapp). Familjen tar upp det som öppen fråga 3 men hänvisar inte
till posten.

**Rättning:** se probe R/probe-kajavgang.diff. Godta avgång inne i en kapsel med köundantag när
båten flyttat minst 50 m från stoppet MOT bron.
- 43 s blev 73 s i alla fyra syntetiska prov.
- K60 och X1kaj har fortfarande en enda varning.
- 14 kajsviter med 199 test är gröna.
- REBEL:s fältvarning återkommer (08:44:41, 249 m). Det flyttar det låsta facit i 20260806-42h
  (Klaffbron:southbound 19 mot 18), vilket är rättare enligt U13 med rådata och fältets
  öppningsfacit.

Gör det som en egen ändring med en U13-låsning. U23 gör inte detta sämre.

### L1 — låg: omstart eller AIS-glapp på minst 25 min mitt i kön avviker från farleden

**Prov:** X2kaj och X5kaj mot X2far och X5far.
- Texten är densamma: "Inga båtar" i cirka 31 min.
- Kajen får en sen andra varning (101 m, 43 s före korsningen). Farleden får ingen.
- Basen ger samma utfall som F.

Det beror på att `holdsQuayQueue` bara läser den flyktiga klassningen. Familjen redovisar fallet
(öppen fråga 4).

**Förslag:** spara `heldAsQueue` i `quayStop`. Respektera flaggan efter omstarten så länge båten
ligger inom 50 m från stoppet, inte sänder navstatus 1/5 och `firstFixTs` är yngre än 2 h.
Alternativt dokumentera det som avsett.

### L2 — låg: inaktuella läsningar av kajens köundantag i motorn (E)

- `bugHunt/lib/shrink.js:128` har gränsvärdet "queueGraceMs (Kajen)" hårdkodat till 900 s. Det
  ger en vilseledande gränsannotering kring 765–1035 s.
- `bugHunt/lib/registry.js:1318–1321` (krav 6, studsposten): motiveringen "köare i upp till
  15 min" är inaktuell. En köare kan nu bära "strax" i 2 h.
- E:s pågående D1-KAJZON (V/E/wt registry.js:1222) läser `Number.isFinite(zone.queueGraceMs) ?
  … : 0`. Infinity blir då 0, alltså 3 min. Läs fältet som `> 0`.

### L3 — låg: dokumentation

- reliability-spec.md B1 (raden före den nya) säger fortfarande "En stoppad båt visas … utan
  ETA-klausul". Det motsägs av beslutet 2026-09-12 och U6.
- Brotextfrasen under 300 m är rätt enligt bridgeTextFormat.md: bekräftad väntan vid målbron
  behåller "strax", och en färsk kö kan ligga kvar i över 2 h. Farledsköaren får exakt samma text
  (X1far).
- bridge-text-sviterna innehåller inget kajfall. Att de är gröna säger alltså inget om frågan.
