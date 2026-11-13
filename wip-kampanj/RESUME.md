# Återstart av rättningskampanjen (buggjägarens fynd)

Den här filen ligger i backupgrenen `claude/wonderful-wozniak-yhk4kz-wip`. Den beskriver
läget när arbetet pausades och hur det återupptas. Produktgrenen är
`claude/wonderful-wozniak-yhk4kz`. Backupgrenen innehåller bara arbetsmaterial och ska
aldrig slås ihop.

## Så återupptas arbetet

1. Om containern är ny, hämta backupgrenen:
   `git fetch origin claude/wonderful-wozniak-yhk4kz-wip` och checka ut
   `wip-kampanj/` i en separat worktree.
2. Varje familj har sin katalog `wip-kampanj/<familj>/` med följande innehåll:
   - `DESIGN.md` och `FACIT.md`;
   - granskningarna (`*.json`);
   - `wt-patchar/`: familjens commits som `git format-patch` mot 7699cbe. För E2 är
     basen e949ae1, som är E:s commit;
   - `wt-ocommittat.diff`: ocommittat arbete vid pausen.
3. Återskapa en familjs prototyp:
   `git worktree add --detach <dir> 7699cbe && git -C <dir> am <wt-patchar>/*.patch`.
   Applicera sedan `wt-ocommittat.diff`.
4. Fortsätt enligt läget nedan. Användarbesluten U13–U21 står i `KAMPANJ.md`.

## Läget (uppdateras vid varje backup)

Se avsnittet "Status" längst ned.

## Status 2026-11-05 cirka 01:40 UTC (veckogräns 87 % kl. 00:05)

**Pushat till produktgrenen:**
- 2e5b782 buggjägaren v1;
- c8a5cb6 R1;
- 10d058e R2.

**Motorrunda 3:** L1, L2 och U16 som MÄTGRÄNS (R3c) är klara i arbetskopian. De checkas in
ovanpå 10d058e som nästa commit. Finns ingen sådan commit på produktgrenen, applicera
`motor/C-bugHunt-mot-HEAD.diff` och `motor/C-BUGGJAKT-mot-HEAD.diff`.

**Familjerna:**

| Familj | Läge |
|---|---|
| K (RECOVER, bakkant, glapp) | revision 1 klar; omgranskning 1 pågick |
| K2 (returresa U15, 13h-fasen) | revision 1 klar; omgranskning 1 pågick |
| N (notis per passage, U14) | revision 1 klar; omgranskning väntar |
| M (krypfartens målflapp, F05) | revision 1 klar; omgranskning väntar |
| E (avgångs-ETA, F04) | revision 2 klar; omgranskning 2 klar |
| E2 (K6-dubbelkörningen, spärren, U20) | design klar; granskning pågick; därefter revision vid behov, sammanslagning E+E2 och granskning |

**Kvar efter familjerna:**
- integrera K, K2, N och M i produktgrenen med omlåsning enligt U13 och fullt batteri;
- därefter E+E2;
- registerposter för U17–U19, KÄND LUCKA-fallen, R2:s 1227/1731 och de KONFLIKT-poster som
  U14/U15 löser (task 149);
- ny motorkörning (standard), uppdaterad triage och dokument.

## Status 2026-11-05 cirka 01:10 UTC

**Pushat till produktgrenen:**
- f68595e motorrunda 3 (L1, L2, U16 som MÄTGRÄNS).

**Familjerna:**
- K, K2, N och M ändringar-krävs efter omgranskning 1. Revision 3 körs i workflowen
  rattningskampanj-revision-3. Skriptet ligger i backupen som backup/revision3.js.
- Dirigentens beslut inför revision 3 står i KAMPANJ.md.
- Senaste revision och granskning för varje familj finns i
  `<familj>/revision1.json` och `<familj>/omgranskning1.json`.

**ETA:**
- E: revision 2 är klar.
- E2: granskningen gav ändringar-krävs, och revisionen pågår i workflowen
  rattningskampanj-eta. Därefter följer omgranskning, sammanslagningen E+E2 och
  granskning.

**Vid återstart:**
1. Kör revisionen och granskningen för de familjer som inte är godkända.
2. Integrera i produktgrenen ovanpå f68595e: först K och K2, sedan N, M och E+E2.

## PAUS 2026-11-05 02:15 UTC (veckogränsen uppskattad till cirka 94 %; uppmätt 90 % kl. 01:08)

Arbetet pausades enligt ägarens instruktion om paus vid 95 %. Ägaren återupptar genom att
skriva i chatten. Workflowerna rattningskampanj-revision-3 och rattningskampanj-eta
stoppades.

**Klart och pushat till produktgrenen claude/wonderful-wozniak-yhk4kz** (HEAD f68595e):

| Commit | Innehåll |
|---|---|
| 2e5b782 | buggjägaren v1 med triagedokument och ägarens beslut U13–U16 |
| c8a5cb6 | R1: U-svängens återkorsning, svepets riktningslås |
| 10d058e | R2: GPS-grindens dubbelbokföring, BN2 utan kurs, fasoberoende passagebevis vid Järnvägsbron |
| f68595e | motorrunda 3 |

**Familjernas läge vid pausen.** Senaste resultat per familj ligger i `<familj>/resultat-*.json`,
`revision1.json` och `omgranskning1.json`.

| Familj | Läge | Nästa steg |
|---|---|---|
| K | revision 3 KLAR och committad i wt (`K/resultat-revision_3_K.json`) | granskning 3 |
| K2 | revision 3 KLAR och committad i wt (`K2/resultat-revision_3_K2.json`) | granskning 3 |
| N | revision 3 AVBRUTEN mitt i | se `N/wt-ocommittat.diff`; gör om eller slutför revision 3, sedan granskning 3 |
| M | revision 3 AVBRUTEN mitt i | se `M/wt-ocommittat.diff`; gör om eller slutför revision 3, sedan granskning 3 |
| E | revision 2 GODKÄND (`E/resultat-E_granskning_2.json`) | redo för sammanslagning med E2 |
| E2 | revision 1 klar, med status delvis (`E2/resultat-E2_revision.json`); omgranskningen avbröts | omgranskning, revision vid behov, sammanslagning E+E2 och granskning |

Granskningsskripten finns i `skript/`:
- `revision3.js`: revision och granskning per familj, med args till exempel `["K","K2"]`.
  För K och K2 behövs bara granskningssteget, så det kan köras separat.
- `rattningskampanj-eta-*.js`: ETA-kedjan.

**Därefter:**
1. Integrera i produktgrenen ovanpå f68595e: K och K2, sedan N, M och E+E2. Lås om bara
   enligt U13 och kör hela batteriet (`skript/battery.sh <worktree> <utkatalog>`) efter
   varje steg.
2. Lägg in registerposter i motorn: U17–U19, R1:s KÄND LUCKA-poster, R2:s 1227/1731 och
   familjernas registryRequests. När U14 och U15 är integrerade ska KONFLIKT-posterna
   INV5-VS-BESÖKSREGEL och U2-RETURRESA tas bort eller klassas om.
3. Kör `npm run hunt` (standard), uppdatera triagedokumentet och pusha.

## Status 2026-11-07 cirka 15:00 UTC (veckan nollställd; 0 % kl. 12:08)

**Pushat till produktgrenen:**

| Commit | Familj | Innehåll |
|---|---|---|
| 8a013d5 | E | avgångs-ETA (F04) |
| f198d52 | K | RECOVER-släppet, bakkanten, passagetid |
| 2c3f778 | K2 | returresan egen varning (U15), 13h-fasen |
| e088a51 | M | krypfartens målflapp (F05) |

**Kvar:**
- N: revision 4 pågick (workflow wf_678a7358-742).
- E2: tre granskningar gav ändringar-krävs (60 låsta rader sämre, U13). Ägaren ska
  informeras, och E2 integreras inte i nuvarande form.
- Registerposter: underlaget ligger i kampanj/registerforfragningar.json.
- Ny `npm run hunt` (standard) och uppdaterad triage.

## Status 2026-11-07, kväll

**Pushat:** aa71099 N (U14). Alla sju appfamiljer är integrerade, och batteriet är grönt.

**Kvar:**
- Registerposter: workflow buggjagare-registerposter i worktree reg/wt, bas e088a51.
  Efterrättningen pågick. Committen ska cherry-pickas på aa71099. Ta sedan bort eller
  klassa om INV5-VS-BESÖKSREGEL, eftersom U14 nu är integrerad.
- Slutlig `npm run hunt` (standard) och uppdaterat triagedokument.
- E2: ägarbeslut, eftersom U13 blockerar.

## Status 2026-11-07, kampanjens första varv klart

**Pushat:**
- c14938f: registret (f6f35e6, e6cc0e1, 286fb09) och triagedokumentets avsnitt om
  kampanjens utfall.

**Batteriet är grönt:**
- jest 5 264;
- replay:all med och utan monitoring;
- syntetiska scenarier, öppningsgrindarna, soak och fassvep;
- självtestet.

**Motorns standardkörning:** 10 kandidatkort, mot 22 i första rapporten.

**Möjligt nästa varv (väntar på ägaren):**
- T2/T3-restklasserna;
- 1274/1317: målbron hålls tom efter en RE_CROSS-vändning;
- 1208: NEW_JOURNEY;
- D1-KAJZON-DEMOTION, en beslutsfråga;
- ETA-etappen, uppskjuten enligt U22.

## Status 2026-11-09, varv 2 startat (veckogräns 9 % kl. 07:53)

Ägaren sa ja till ett andra varv ("Ja gör det"): triage av restkorten, rättning och ny
motorkörning. Briefen ligger i `varv2/VARV2.md`. Produktgrenen står på c14938f.

**Pågår:**
- T-A (`varv2/tA/`): T2-korten F02, F05 och F08. Resultatet blir `TRIAGE-A.md` och
  `triage-a.json`.
- T-B (`varv2/tB/`): T3-korten F06 och F07 samt kajfrågan B01 (D1-KAJZON-DEMOTION) med
  en enkel förklaring för ägaren. Resultatet blir `TRIAGE-B.md` och `triage-b.json`.

**Vid återstart:** finns TRIAGE-A.md och TRIAGE-B.md, gå vidare till rättningen. Annars kör
om triagen för det kort som saknas, i en worktree på c14938f med symlänkad node_modules.
Därefter följer rättning per APPFEL-mekanism (design, regressionstest, granskning,
integration med `skript/battery.sh`), registerposter för TÄCKT, `npm run hunt` (standard),
triagedokumentet, commit och push.

## Status 2026-11-09, varv 2: triagen klar, sex familjer arbetar

**Triagen:**
- `varv2/tA/TRIAGE-A.md` (T2): fem APPFEL, tre ÄGARBESLUT, ett MOTORFEL och en MÄTGRÄNS.
- `varv2/tB/TRIAGE-B.md` (T3 och B01): inga APPFEL, motorfel i registret och kajfrågan.

**Ägarbeslut U23 (2026-11-09):** en båt på väg mot Klaffbron som stannar vid Kajen
behandlas som i resten av väntområdet. Se `varv2/KAMPANJ2.md`.

**Familjerna** (brief i `varv2/KAMPANJ2.md`, worktrees `varv2/<F>/wt` på c14938f):

| Familj | Innehåll |
|---|---|
| A | SAMMA-TICK: målbron i samma tick efter NEW_JOURNEY och RE_CROSS |
| B | BAKKANT: färskheten mot korsningen, krypfysiken, och M7 täckningsslut utan passage (mäts mot C-IV väg b) |
| C | DÖDBAND: återfödd båt med kurs i dödbandet |
| D | SPÄRR: spärren vid tidigare bro vid acceleration (smal variant, annars ägarfråga) |
| E | MOTOR: U17-predikatet med appens prognos och oberoende fysik, fixtid, gemensam RECOVER, kajpredikatet, radiomodellen och U2-fönsterkanten |
| F | KAJ: U23 |

**Vid återstart:** varje familjs leveranser ligger i `varv2/<F>/`, och dess commits ligger
som `wt-patchar` mot c14938f. Saknas RESULTAT.md har familjen inte levererat. Kör i så fall
om uppdraget ur KAMPANJ2.md. Därefter följer granskning per familj, integration med
`skript/battery.sh`, standardkörning, triagedokument, commit och push.

## Status 2026-11-09, eftermiddag

**Ägarbeslut U24 (2026-11-09):** familj B:s smala M7-variant V1c införs. Den ger en egen
varning i tid före första passagen. Se `varv2/KAMPANJ2.md`.

**Levererat** (batteriet grönt i varje familj, inget låst facit flyttat):

| Familj | Commits | Läge |
|---|---|---|
| A | 91641f9, ab9c57c | granskas (`varv2/A/rwt`) |
| C | f62aea8, 19b3bfa | granskas |
| F | 0873322, 3887254 | granskas. Öppen fråga: ny INV-10-kandidat i värld 129, som F menar fanns redan |
| B | 650a0c7, 594a146 | steg 3 (M7 enligt U24) pågår, därefter granskning |
| D, E | – | arbetar fortfarande |

**Granskningsbriefen** ligger i `varv2/GRANSKNING2.md`.

## Status 2026-11-09, 12:30 UTC

| Familj | Commits | Läge |
|---|---|---|
| A | 91641f9, ab9c57c | granskas |
| B | 650a0c7, 594a146, 0b0a35d (U24) | granskas |
| C | f62aea8, 19b3bfa | granskas |
| D | 9fe94c6 (TYST-GOLV, inget facit flyttat) | granskas |
| F | 0873322, 3887254 | ÄNDRINGAR KRÄVS (`varv2/F/GRANSKNING.md`); revision 1 pågår |
| E | – | motorn, arbetar |

**F:s revision 1:**
- harnessen ska räkna U23-köaren som bekräftad väntan;
- kajavgångsgrinden rättas, så att REBEL i 42h återfår sin varning (U13-låsning);
- farledsbeviset genom en kapsel;
- ägarfråga om D1-luckan 300–500 m: en stillaliggande båt tappar målet efter 20 min.

**Provintegrationen** finns i `varv2/integ/prov` (A, C, F, B steg 1–2 och D, med konfliktlösningar och en lint-rättning). Den ska användas som mönster för den riktiga integrationen.

## Status 2026-11-09, cirka 13:30 UTC

**Granskningarna:**
- C är GODKÄND med sex låga anmärkningar. En dokumentationsrevision pågår.
- D: ÄNDRINGAR KRÄVS. Anmärkningen med allvar HÖG: TYST-GOLV varnar köande båtar 9–13 min för tidigt när appen inte hör dem, eftersom klass B under 2 kn bara sänder var 3:e minut. Revisionen pågår: smalare varianter mäts och en ägarfråga om M6 skrivs.
- F: revision 1 pågår.
- A och B granskas fortfarande.

**Provintegrationen** (`varv2/integ/prov`) gav ett grönt batteri, utom lint, som är rättad i 85151be. I quick finns ett nytt kort, F05 i värld 129 (INV-10 vid Kajen), som F:s revision åtgärdar.

## Status 2026-11-09, cirka 14:00 UTC

Alla sex familjer har granskats:

| Familj | Dom | Kvar att göra |
|---|---|---|
| C | GODKÄND | revision 2 (d190e9c, bara dokument och test) är klar |
| A | ÄNDRINGAR KRÄVS | HÖG: GPS-utliggare 70–140 m bakom linjen ger falsk varning. Revision pågår |
| B | ÄNDRINGAR KRÄVS | tre MEDEL, grindarna 'bakom', 'en-prognos' och ingen fysik vid waitingAtBridge. Revision pågår |
| D | ÄNDRINGAR KRÄVS | HÖG: tidiga varningar i tystnad. Revision pågår, med smalare varianter och en ägarfråga om M6 |
| F | ÄNDRINGAR KRÄVS | revision 1 pågår |

E (motorn) har tio commits i `varv2/E/wt` och väntar på sin slutkörning.

## Status 2026-11-09, cirka 14:40 UTC

- **E (motorn)** har levererat c14938f..1dfd18a, tolv commits. Granskningen pågår (`varv2/E/rwt`).
- **D:** dirigenten valde EFTER-BRON, eftersom den inte har någon uppmätt kostnad: inga för tidiga varningar och inga fantomer, och 263 får 100 s. D bygger varianten direkt på c14938f. TYST-GOLV 9fe94c6 läggs åt sidan.
- **A, B och F** reviderar.
- **Öppna punkter efter integrationen:**
  - 1038: bakkanten släpper vid sen bokföring, 12 s efter korsningen;
  - 1527: ny med M9, en tyst avgång ur kön vid Järnvägsbron varnas efter korsningen.

## Status 2026-11-09, cirka 15:30 UTC

| Familj | HEAD | Läge |
|---|---|---|
| A | 5edfe20 | omgranskas |
| B | 5d4b2c3 | omgranskas |
| C | d190e9c | GODKÄND |
| D | – | bygger EFTER-BRON på c14938f |
| E | 1dfd18a | granskas |
| F | 1893af8 | omgranskas; två omlåsningar ska prövas enligt U13: 42h REBEL och 41h ETA okänd |

Restfrågorna till ägaren samlas i `varv2/RESTFRAGOR.md`.

## Status 2026-11-09, cirka 16:00 UTC: provintegration 2 med alla sex familjer

`varv2/integ/prov2` innehåller A 5edfe20, C d190e9c, F 1893af8, B 5d4b2c3, D 19e87b5 och E 1dfd18a.
- **Batteriet:** grönt utom 2 motortest i k-varv2-motor.test.js, som skrevs för läget före F (U23). De ligger på E:s lista, `varv2/E/ATT-GORA-REVISION.md`.
- **Standardkörningen:** självtestet är grönt. 224 råa utslag, 7 kandidatkluster och 8 kort. 5 av korten gäller ETA (U22) och 3 inte:
  - F04 T3: 1038 och 1527;
  - F05 T2 LEDTID: 1139 (stilla köare, U24 undantar);
  - F06 T2 OKLASSAD: 1527.

  Före varv 2 fanns 6 kort som inte gällde ETA, med cirka 34 fynd.

**Kvar:**
- D:s skärpning (spärren släpps inte före bron, grinden 210 s);
- B:s revision 2;
- F:s revision 2;
- granskningen och revisionen av E;
- därefter den riktiga integrationen på produktgrenen, med lösningarna i `varv2/integ/resolve.py` och `varv2/integ/resolve_syn.py`.

## Status 2026-11-09, cirka 17:00 UTC: den riktiga integrationen har börjat

**Godkända slutversioner:**

| Familj | Commit |
|---|---|
| A | 5edfe20 |
| B | e5f78b5 |
| C | d190e9c |
| F | 0dce236 |

**`varv2/integ/final`**, detached på c14938f, har en commit per familj:
- 811c723 A
- b6a4002 C
- c798e9b F
- b38eabc B

Batteriet körs (`varv2/integ/batt-final1`). Är det grönt, fast-forwardas produktgrenen och pushas.

**Kvar:**
- D: skärpningen pågår (spärren släpps inte före bron, grinden 210 s).
- E: revisionen pågår, med H1 (fysiken oberoende av appens flaggor), M9 i AISHub och listan i ATT-GORA-REVISION.md.
- Därefter integreras D och E, följt av batteriet, standardkörningen och triagedokumentet.
- Dokumentationsrad för A:s L6, känd gräns: en utliggare med vänd kurs bakom Järnvägsbron.

## Status 2026-11-09, cirka 17:40 UTC: A, C, F och B pushade

Produktgrenen claude/wonderful-wozniak-yhk4kz står på b38eabc (pushad), med commits för
A (811c723), C (b6a4002), F (c798e9b) och B (b38eabc).
- Batteriet `varv2/integ/batt-final1` är grönt i alla 13 steg: jest 373 sviter och
  5 356 test, lint, replay med och utan monitoring, synthetic, openings, soak, fas med
  och utan monitoring, självtestet och quick.

**Kvar:**
- D: skärpningen pågår.
- E: revisionen pågår.
- Integrera D och E ovanpå b38eabc, kör batteriet och standardkörningen, uppdatera
  triagedokumentet och lägg in raden om A:s L6. Därefter commit och push.

## Status 2026-11-09, kväll: D pushad

Produktgrenen står på 25862ee (pushad): A, C, F, B och D.
- Batteriet `varv2/integ/batt-final2` är grönt, 374 sviter och 5 376 test.
- Med den gamla motorn har quick kvar F04 (290, radion, som E:s M9 åtgärdar) och F05 (143, U24-kostnaden, som E registrerar).

**Kvar:**
- E: revisionen pågår.
- Integrera E ovanpå 25862ee, och kör sedan batteriet och standardkörningen.
- Triagedokumentet, A:s L6 i ARCHITECTURE, eta-accuracy-rendered-testet (förslag till ägaren) och restfrågorna (`varv2/RESTFRAGOR.md`).
- Commit och push.

## Status 2026-11-09, kväll: slutmätningen klar, E och dokumenten väntar på push

`varv2/integ/final` har 25862ee plus:
- 7b449bb: motorn, familj E med revision 1;
- 59068cc: triagedokumentet och ARCHITECTURE.

**Batteriet** (`batt-final3`) är grönt: 375 sviter och 5 444 test.

**Standardkörningen** (`integ/std-final`): självtestet är grönt, 222 råa utslag, 43 kluster och 7 kort.
- 5 kort är ETA-kort (U22).
- 2 kort gäller annat: F04 (1139, T2 LEDTID) och F05 (1038, T3).

**Väntar på** omgranskningen av E (`varv2/E/OMGRANSKNING.md`). Är den godkänd:
`git -C /home/user/io.ais.tracker merge --ff-only 59068cc`, sedan push.

**Därefter:** slutrapport till ägaren med restfrågorna (`varv2/RESTFRAGOR.md`) och eta-accuracy-rendered.

## Status 2026-11-09, kväll: VARV 2 KLART OCH PUSHAT

Produktgrenen står på 6d23732 (pushad). Ovanpå c14938f ligger sju commits:

| Commit | Innehåll |
|---|---|
| 811c723 | A |
| b6a4002 | C |
| c798e9b | F |
| b38eabc | B |
| 25862ee | D |
| 7b449bb | E, motorn |
| 6d23732 | dokument |

**Batteriet** är grönt: 375 sviter och 5 444 test.

**Standardkörningen** gav 7 kandidatkort, mot 11 före varvet:
- 5 är ETA-kort (U22);
- 2 gäller annat: 1139 och 1038.

**Restfrågor till ägaren** står i `varv2/RESTFRAGOR.md` och i triagedokumentet, avsnittet om varv 2:
1139, 1038, D1-luckan 300–500 m och konvojfamiljen.

**Förslag:** gör eta-accuracy-rendered-testet lastoberoende. Uppgiftskortet ligger hos ägaren.

## Avslutat 2026-11-09: ägaren valde "Stanna här"

Kampanjen är avslutad efter varv 2. Produktgrenen står på 6d23732.

Restfallen är dokumenterade i docs/buggjakt-triage-2026-11-04.md, avsnittet om varv 2, och i `varv2/RESTFRAGOR.md`:
- 1139;
- 1038;
- D1-luckan 300–500 m;
- konvojfamiljen;
- eta-accuracy-rendered under last.

Ägaren tar upp dem vid behov.

## Tillägg 2026-11-09: eta-accuracy-rendered åtgärdat (eda1839)

Ägaren frågade om uppgiften från agent B var gjord. Den var inte gjord, så den gjordes nu och pushades som eda1839.
- **Orsak:** gränsen 25 s per replay-barn var för snäv under hög last. Där mättes 32–42 s, vilket gav spawnSync ETIMEDOUT.
- **Rättning:** `CHILD_TIMEOUT_MS` = 120 s och `FIELD_SETUP_TIMEOUT_MS` = 300 s. Gränserna vaktar bara mot ett barn som hänger sig.
- **Belägg:**
  - Under 80 busy-loopar gick testet från 4 röda till 17/17 gröna på 121 s.
  - På en ledig maskin tar det 6 s.
  - Lint är grönt, och hela jest gav 375 sviter och 5 444 test.

Produktgrenen står på eda1839. Restfallen kvar är 1139, 1038, D1-luckan 300–500 m och konvojfamiljen.

## Ägarens svar på restfrågorna (2026-11-09, sent)

Svaren var: 1b, 2 ja, 3 godta, 4 godta, 5A, 6 vänta.
- **1b:** "produktion" betyder att ägaren själv kör appen på sin egen Homey. Ingen ny version släpps i App Store.
- **2 ja:** ägaren kör ett fältprov.
- **3 = U25 (1038):** godtas som känd gräns.
- **4 = U26 (1139):** godtas som känd gräns.
- **5A = U27:** D1-luckan behåller 20 min.
- **6:** konvojfrågan väntar till efter fältprovet.

**Gjort:**
- Docs-commit e1759eb, lokal och ännu inte pushad: triagedokumentet, ARCHITECTURE (U27 och M6-hänvisningen) och reliability-spec.
- Familj G arbetar i `varv2/G/wt`, med bas eda1839 och uppdraget i `varv2/G/UPPDRAG.md`. Den lägger två ACCEPTERAD-poster för U25 och U26 i beslutsregistret, med predikat, tester och mutationsprov. Den uppdaterar också BUGGJAKT §7 och ARCHITECTURE. Förväntat utfall är 5 kort, bara ETA.

**Kvar:**
1. Adversariell granskning av G.
2. Integrera G ovanpå e1759eb. Kontrollera ARCHITECTURE-radhänvisningarna i de nya posterna, eftersom e1759eb flyttar raderna efter 1507 med +4.
3. Kontroller: jest, lint, självtest och standard.
4. Pusha.
5. Ge ägaren instruktionen för fältprovet:
   - `git checkout claude/wonderful-wozniak-yhk4kz`;
   - `debug_level` = `full`;
   - `./run-with-logs.sh` (kör `homey app run --remote`), minst 1 dygn;
   - skicka app-, jsonl- och summary-filen zippade via chatten (repot är publikt, så loggarna ska inte committas);
   - efteråt installeras appen permanent med `homey app install`.

**Obs:** registrets radhänvisningar till ARCHITECTURE.md var redan inaktuella på eda1839. Till exempel pekar :1934–1951 för U17 på ETA-text. Det är en känd skönhetsbrist.

## Klart 2026-11-10: U25 och U26 i buggjägaren (e51c7b6, pushad)

Produktgrenen står på e51c7b6. Ovanpå eda1839 ligger:
- e1759eb: ägarbesluten U25–U27 och konvojfrågan i dokumentationen;
- e51c7b6: registerposterna U25-BAKKANT-VID-SEN-BOKFÖRING och U26-STILLA-KÖ-SEN-VARNING, 25 nya test, BUGGJAKT §7 och bilaga A.9.

Appens kod är oförändrad sedan 25862ee (familj D); eda1839 rörde bara ett test.

**Mätt på e51c7b6:**
- jest: 376 sviter, 5 469 test gröna (2 överhoppade);
- lint, självtest och quick gröna, porcelain ren;
- standard i `varv2/G/std` (på eda1839 + G): 5 kort, alla INV-3 ETA;
- mutationsprov i `varv2/G/mut`: U25 och U26 tog inget nytt utslag i någon av fyra mutanter.

**Samma kväll gjordes en egen genomgång av appens tillförlitlighet** (mätfiler i `overblick/`):
- O1: 376 av 378 passager varnade (99,5 %); mot rådata minst 392 av 447 (88 %), 37 okänd ordning, 18 säkra missar.
- O2: av 438 varningar följdes 229 av passage inom 20 min, 117 senare och 92 inte alls.
- ETA: medianfel 1,5 min, p90 21,7 min, bias −14,9 min; Stridsbergsbron sämst.
- Slutsats till ägaren: fältprov först; därefter ETA och för tidiga varningar, sedan konvojfrågan.

**Familj G:** agenten stoppades av en containeromstart. Dirigenten slutförde arbetet utan fler agenter. Se `varv2/G/RESULTAT.md`.

**Känd gräns funnen i mutationsproven:** U17 prövar inte täckningsslutets tid mot händelsen (15 av 18 nya utslag i mutant C togs av U17). Den är dokumenterad i BUGGJAKT §7 men inte åtgärdad.

**Väntar på ägaren:** fältprovet (instruktionen är given i chatten). Loggarna ska skickas zippade via chatten, inte committas.

**Attribution från och med nu:** `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Överlämning 2026-11-13

Ägaren har kört två fältprovskörningar och fortsätter i en ny chatt i VS Code. Överlämningen står i `wip-kampanj/OVERLAMNING.md` på den här grenen. Den beskriver uppdraget (analysera loggarna, rätta fynden, ta hand om det som är kvar), läget på e51c7b6, arbetsgången, batteriet och de öppna punkterna. Loggarna finns bara på ägarens dator.
