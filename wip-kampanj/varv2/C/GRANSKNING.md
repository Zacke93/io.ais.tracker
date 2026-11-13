# GRANSKNING — familj C, M3 ÅTERFÖDD-DÖDBAND (varv 2, 2026-11-09)

Förkortningar: S = `/tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad`,
V = S/varv2, C = V/C. Granskat: `19b3bfa` (f62aea8 + revision 1) i C/rwt mot `c14938f` i en egen
worktree C/bwt. Alla tempfiler, skript och loggar ligger i C/rtmp. Inga ändringar i C/wt, C/rwt
eller andra familjers kataloger. En tillfällig prob kördes i C/rwt och flyttades sedan till
C/rtmp/prober; `git status --porcelain` visar i båda träden bara `?? node_modules`.

## Dom: GODKÄND

Det finns inga höga och inga medelhöga anmärkningar, men sex låga. Rättningen gör det den
påstår. Varje adversariellt motexempel jag konstruerade och som rättningen släpper igenom ger
exakt samma utfall som en tvilling med kurs i banden ger på c14938f. M3 är alltså aldrig
mildare än dagens bandkursregel, bara strängare (K1 ≥ 2 kn, sog ≥ 2 kn och kursens sida).
Dokumentationen säger dock för mycket på tre ställen (L1, L2, L3).

## Belägg i korthet

1. **Rotorsaken.** Kommando: `C/rtmp/reproC.sh <träd> <ut>`, alltså `hunt.js --repro` för
   korten F05-w756, F05-w1913, F05-w977 och V/tA/fynd/F05. Utfall på c14938f: KVAR ×4. Utfall
   på HEAD: BORTA ×4 (C/rtmp/repro/{bas,head}/sammanfattning.tsv).

   Verbos logg (`C/rtmp/rrv.sh`, C/rtmp/logs/F05-bwt.log) för c14938f:
   - `NORTH_PROGRESS_REBIRTH … (-3.408 m/s över 428 s)`;
   - `Osäker COG (229.6°) → ingen målbro`;
   - därefter `SKIPPED_BRIDGES_DIRECTION_LOCK … 'south'`;
   - ingen arm för Stridsbergsbron.

   På HEAD (F05-rwt.log) loggas i stället:
   - `positionsbevisad riktning (kursen 229.6 läses inte)`;
   - `TARGET_ASSIGNMENT_REBIRTH … → Stridsbergsbron`;
   - `OPENING_ARM … Stridsbergsbron d=1888 m … deadline om 187 s`.

   Mekanismen är bekräftad.

   Alla 26 tA-kort och tA-fynd gav samma utfall på HEAD som i familjens tabell
   (C/rtmp/repro/alla-head.sorted): BORTA bara för 756, 1913, 977 och F05-fyndet, övriga KVAR.
   tB-korten kajA och kajB ger samma utfall på bas och HEAD (BORTA respektive KVAR).
2. **Regressionstesten.**
   - `tests/m3-aterfodd-dodband-2026-11-09.test.js` kopierades till bwt: 15 av 24 röda
     (C/rtmp/jest-m3-bas.log). Kärnfallen, kontrollen, ordningen och helappen fäller på
     beteendet; resten fäller på att metoden saknas.
   - På HEAD är testet 24 av 24 grönt.
   - De två nya syntetiska scenarierna kördes mot c14938f med HEAD:s
     runSyntheticScenarios.js och scenarioGenerator.js. Båda är röda (SAKNAD
     ÖPPNINGSVARNING, ÄGGKLOCKAN TYST). De övriga 74 raderna är identiska med HEAD:s, också
     WARN-raderna (`diff` på C/rtmp/synth-bas-nya.log och batt/synth.log; bara M3-raderna och
     slutraden skiljer).
3. **Batteriet.** `bash S/port/battery.sh C/rwt C/rtmp/batt` gav följande (C/rtmp/batt/status):
   - jest 0 (370 sviter, 5288 gröna, 2 hoppade);
   - lint 0;
   - replay-all 0 och replay-all-mon 0;
   - synth 0;
   - openings 0;
   - soak 0 och soak-mon 0;
   - phase 0 och phase-mon 0 ("inget odokumenterat fasberoende");
   - hunt-selftest 0 och hunt-quick 0;
   - porcelain visar bara `?? node_modules`.
4. **Bitlikt mot c14938f.** Skript: `C/rtmp/scripts/bitlik.sh` och `bitjmf.py`. Jämförelsen
   gjordes STRÄNGARE än familjens: bara `heapUsedMB` och väggklocktider undantas.
   `runtimeDiagnostics`, som familjens bitlik.sh hoppar över helt, jämfördes alltså också.
   Resultat:
   - 26 av 26 bitlika utan monitoring;
   - 26 av 26 bitlika med `REPLAY_MONITORING=1`.

   Öppningsgrindarnas logg på bwt är byte för byte identisk med HEAD:s (`cmp` → IDENTISK).
   Inget låst facit flyttas, och FACIT.md stämmer.
5. **Quick.** `quickjmf.py V/bas/quick/rapport.json C/rtmp/batt/hunt-quick/rapport.json`:
   - kluster 25 → 24 och råa utslag 58 → 57;
   - samma fyra kandidatkluster och inga nya;
   - min körning är identisk med familjens (24/24 och 57/57, inga skillnader).

   **Värld 217.** Världen återskapades med basSeed 1, och jsonl-filen är identisk med
   familjens. Utfall:
   - c14938f: PELLE 2 (265250189) beväpnas 13:33:00 och absorberas i Klaffbron#17. RECOVER
     ger sedan en egen varning #22 13:55:11 på ett 22 min gammalt fix, 13 min EFTER hennes
     sanna korsning 13:42:02 (L0).
   - HEAD: hon beväpnas på återfödelsen 13:31:27 och blir ledare i #17, som avfyras 13:32:08
     med eta 10. Det är 9,9 min före hennes korsning, så eta stämmer. BRISEN 2 korsar 13:45:40.
     Ingen #22 kommer.

   Det är rättare. Hon hanteras som en båt beväpnad före avfyrningen, precis som en
   bandkurstvilling.

   **Värld 235.** Den kördes med monitoring, eftersom i % 4 = 3. MASEN 2 (kurs 249,4°)
   får målbro 07:03:22 i stället för 07:06:34. Varningar, notiser och passager är
   oförändrade. ETA-koden är orörd (U22), men se L3.
6. **Fältstatistiken.** `faltfordelning.py` gav med min körning en identisk utdata. Med sog ≥ 2
   och kurs i dödbandet låser 2 kn 56 av 121 transitpar och 0 av 50 övriga.

   Utökad kontroll (`C/rtmp/scripts/maltraff.py`) av de 56 paren: vilken målbro hade
   `_calculateTargetBridge(dir)` gett, och korsades den?
   - 39 par ger ingen målbro (på väg ut).
   - 15 par korsar målbron i den riktningen inom 60 min.
   - 2 par korsar den efter ett kajstopp: FILOU efter 2,5 h och MARY efter 79 min, båda i
     K1-riktningen.

   Inget par får en målbro bakom sig. NORDIC SOLA (41h) rörs inte, eftersom 41h är bitlik.
7. **Ordningen mot svepet och R1/F15.**
   - Steg 5 i testet (FREJA) visar att svepet inte låser en gång till.
   - Värld W8 (C/rtmp/adv): båten vänder i glappet och återföds med kurs 250° men netto
     norrut, med Klaffbron i fönstret. På HEAD avvisar M3 henne med krav 5, och sedan loggas
     `SKIPPED_BRIDGES_DIRECTION_LOCK` och `…_LOCK_RELEASED` precis som på bas. Notiser,
     varningar, brotext och passager är lika.
   - W6a och W6b (ut ur kanalen vid Stallbackabron och Kanalinfarten) är identiska på bas och
     HEAD, och låset släpps.
   - W7 (passerar Stridsbergsbron i avbrottet och fortsätter söderut med kurs 230° hela vägen)
     ger på c14938f INGEN Klaffbron-varning, en missad öppning. På HEAD kommer Klaffbron#2
     10:08:54 (deadline), 6,4 min före passagen 10:15:17.

## Anmärkningar

### L1 (låg) — F18-residualen är inte redovisad: fyra realistiska motexempel stoppas inte

DESIGN §5 och RESULTAT säger "Motexemplen stoppas". Det gäller de konstruerade varianterna,
men inte närliggande fall. Världarna finns i C/rtmp/adv (`advgen*.js`), med sammanställningen
i C/rtmp/adv/sammanfattning.txt. Alla kördes genom hela appen på bas och HEAD.

| Värld | c14938f | HEAD | Tvilling med kurs 25° vid återfödelsen, på c14938f |
|---|---|---|---|
| W1: vändning medurs PÅGÅR vid återfödelsen, kurs 100°, 389 m före Klaffbron, hon ger upp | – | Klaffbron-varning 10:02:30 (fix) och 60 s måltext | samma varning |
| W1b: som W1 men 1,8 km ut | – | 60 s falsk måltext; armen avväpnas `uturn` före deadline | – |
| W2: första ankomst till Kajen efter avbrott, kurs 70° | – | Stridsbergsbron-varning 10:07:33 (deadline) och cirka 6 min falsk måltext | samma |
| W3: första ankomst till Gästhamnen, kurs 95° | – | Stridsbergsbron-varning 10:08:00 och cirka 6 min falsk måltext | samma |
| W4: kaj norr om infartspunkten, ETT GPS-hopp 300 m norrut, 2,4 kn, kurs 70° | – | Klaffbron-varning 10:05:48 och 9 min falsk måltext | samma |
| W5 (V8): AISHub-basfix 200 s gammal, sann nordfart 0,45 m/s | – | K1 1,142 m/s, Klaffbron-mål och 9 min falsk måltext | samma |

Probe C/rtmp/prober/granskning-c-probe.test.js prövade Kajen, som familjen inte prövat (bara
Gästhamnen):
- MED kajhistorik håller kajgrinden i båda riktningarna (`TARGET_QUAY_POSITION_PROOF`, inget
  lås);
- UTAN kajhistorik blir målet Stridsbergsbron norrut och Klaffbron söderut.

Familjens kontrolltest låser själv det senare som "TRANSIT".

**Förslag:** ingen kodändring. Redovisa i DESIGN §5 och i ARCHITECTURE.md:s "Kända gränser" att
dödbandet inte längre skyddar dessa klasser för återfödda båtar:
- vändning medurs/moturs genom samma sidas dödband;
- infart till kaj utan kajhistorik;
- GPS-hopp med fartspik åt kursens sida;
- V8.

Varje klass ger samma utfall som bandkurstvillingen, och kostnaden är ett falsklarm i stället
för en missad öppning. Lås gärna W1 och W3 som test ("som tvillingen"), så att en framtida
ändring blir medveten. En zonvakt avråder jag från: farleden går 7–52 m från kajplatserna
(FP9-H'), så en sådan vakt återinför missen för äkta transiter förbi kajerna.

### L2 (låg) — "Låset är det svepet själv hade satt" stämmer inte alltid

Svepet returnerar före låset när fönstret saknar kandidatbroar (app.js:8634,
`if (passedBridgeEntries.length === 0) return;`, före låskoden på app.js:8679–8690). Två exempel:
- PELLE (977) 07:22:35 på c14938f: ingen `SKIPPED_BRIDGES_CHECK` och inget lås
  (V/tA/logs/w977.log);
- W1 på c14938f: inget lås.

Där är M3:s lås det enda.

**Förslag:** formulera om på fyra ställen till "låser svepet alls, låser det samma riktning;
annars är M3:s lås det enda, och det släpps när ingen målbro blir":
- VDS:518–520;
- app.js:8660–8662;
- ARCHITECTURE.md:958;
- DESIGN §6.

### L3 (låg) — värld 235: ETA-talen blir något sämre mot sanningen, inte bara annorlunda

Det tidigare målet startar EMA-utjämningen tre minuter tidigare (`ETA_SMOOTHING` 07:04:35 och
07:06:34). Sanningen (truth L0) är att MASEN 2 korsar Stridsbergsbron 07:15:12.

| Tid | c14938f | HEAD | Sant |
|---|---|---|---|
| 07:06:34 | ETA 8,8 min (rå) | 9,8 min | 8,6 min |
| 07:12:00 | "cirka 3" | "cirka 4" | 3,2 min |

Oscillationen blir alltså 1 min större (4→10→4). ETA-koden är orörd, så U22 hålls.

**Förslag:** skriv det exakt i RESULTAT/DESIGN §11 ("ETA:n hamnar ~1 min sent mot sanningen
p.g.a. EMA över den tidigare starten") och lämna det till ETA-rundan.

### L4 (låg) — systerstället i ACCELERATED-grenen finns kvar (fanns redan på c14938f)

`_shouldAssignTargetBridge` (VDS:4421) prövar kajgrinden mot kursens målbro, men grenen
tilldelar `_calculateTargetBridge(vessel, positionDirection)` (VDS:801/876). Med kurs i
dödbandet och positionsbevisad riktning, alltså en långsam positionsvändning via
`_updatePositionDirectionEvidence`, är grinden stum: samma mönster som 19b3bfa rättade i
ny-båtsgrenen.

DESIGN §2.3 avfärdar ACCELERATED med "har oldVessel och ingen återfödelsebas". Det är inte
rätt kriterium.

**Förslag:** skicka positionsriktningens målbro till `_slowInitialQuayApproachNeedsProof` även
där, eller för upp det som öppen fråga för en senare runda.

### L5 (låg) — V8: riktningen kan inte bli fel, men ett icke-transitmål kan uppstå i fusionsläge

Tecknet på K1 följer två verkliga positioner i fixtidsordning. F6 avvisar en äldre AISHub-fix
så länge fusionsstatet lever, och F4b avvisar den efter prunen. Felet blir därför bara en
överskattad storlek, med faktorn 1 + (L0 − L1)/dt:
- 1,5 vid p90 och 120 s;
- 2,8 vid nattens max.

W5 visar ett falskt mål i 'both'-/AISHub-läge (lag 200 s). Det är samma utfall som
bandkurstvillingen, och leveransläget aisstream berörs inte. Ingen rättning behövs nu.

**Förslag (senare):** låt `app.js:_onVesselRemoved` spara `fixTs`/`fixFeed` i posten och
`_rebirthNorthBase` föra dem vidare, så att `fixDtMs` (samma källa) mäter på fixklockan.
K1:s Kanalinfartsregel vinner på samma sak.

### L6 (låg) — integrationsnoter och en FACIT-formulering

- Textkonflikter med familj A:
  - VALIDATION.md, där A har 74 → 77 och C 74 → 76; sammanslaget ska det bli 79;
  - slutet av SCENARIOS i runSyntheticScenarios.js;
  - dokblocket och push i scenarioGenerator.js;
  - A:s nya rader direkt före ny-båtsgrenen i VDS.

  Semantiskt krockar inget.
- Med F:s U23 kommer en återfödd sydgående båt som stannar vid Kajen med M3-målet Klaffbron
  att stå kvar som köare, precis som bandkurstvillingen.
- FACIT.md säger att bara `heapUsedMB` får skilja, men familjens bitlik.sh hoppar över hela
  `runtimeDiagnostics`. Min strängare jämförelse ger ändå 26 av 26, så formuleringen bör bara
  justeras.

## Bedömning per granskningspunkt

- **Korrekthet och kantfall:** godkänt.
  - Banden är inklusiva vid 45, 135, 225 och 315.
  - Saknad kurs, sog < 2, gammal mätning, omleverans, utanför kanalen och "lämnar kanalen"
    avstår alla eller släpper låset.
  - `FIX_D_MIN_SOG` finns i scope, och `KN_TO_MPS` är delad.
- **Död kod:** ingen. Inga rester från skissens `_rebirthDirectionEvidence`.
- **Kommentarer och dokumentation:** stämmer, med undantag för L1–L3.
- **F18:** riktningen är mätt, inte gissad. Varje residual är bandkurstvillingens (L1).
- **Tröskeln 2 kn:** fältsiffrorna är reproducerade. Tröskeln flyttar inget i banken, inte
  heller NORDIC SOLA i 41h.
- **Två riktningskällor:** nej. Samma post och samma tecken. Krav 5 släpper bara igenom
  kombinationer som R1/F15 aldrig hade släppt, och W8 visar att släppet fungerar som förut.
- **Kajgrinden (19b3bfa):** den kan bara ta bort M3-mål och falla tillbaka på c14938f:s
  beteende, så den ger inga nya fall utan målbro mot basen. Den håller på Kajen och i
  Gästhamnen när kajhistorik finns.
