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
