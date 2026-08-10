'use strict';

/**
 * Manifest över alla replay-korpusar (2026-06-10).
 *
 * Varje korpus = en jsonl med rå AIS-data ur en produktionskörning + facit.
 * "locked" betyder att expectedNotifications är VALIDERAT korrekt beteende
 * (manuellt granskat mot produktionslogg + pelarvalidering) — en avvikelse
 * är en regression. Olåsta korpusar körs informativt tills deras förväntade
 * värden fastställts (t.ex. medan kända buggar i den körningen åtgärdas —
 * facit från en buggig körning är "vad prod gjorde", inte "vad som är rätt").
 *
 * VIKTIGT vid omlåsning: motivera ändringen i `note` med datum + varför.
 *
 * ── FÄLTEN ──────────────────────────────────────────────────────────────────
 *
 * `locked`            — se ovan. Styr ALLA fem facitdimensionerna på en gång.
 * `expectedNotifications` — notisantalet (pelare 2).
 * `knownInvariantExceptions` — EXAKTA utslagssträngar (prefixmatch) som är
 *                     rådataverifierat designenliga; varje post MÅSTE motiveras
 *                     i `note`. Se FP9 2026-07-18.
 * `fusionOf`          — korpusen är en fusionsvariant av en annan; validering
 *                     sker mot PARENTENS fördelnings-/riktningsfacit.
 *
 * `lockOpenings: false` (A9a, etapp 7 2026-08-08) — LÅS ALLT UTOM
 *                     ÖPPNINGSDIMENSIONEN. `runAllCorpora` (a) hoppar
 *                     öppningspost-jämförelsen och (b) EXKLUDERAR korpusen ur
 *                     REGEN-skrivningen av `opening-distribution.json`; A8(iv):s
 *                     complete-vakt känner till undantaget och kräver alltså
 *                     inte en öppningspost för just den korpusen.
 *                     MOTIV: en körning kan vara pelare 1+2-verifierad medan
 *                     öppningsmotorn ännu bär en KÄND, öppen defekt. Låser man
 *                     öppningsmultiseten då förevigas defekten som facit (exakt
 *                     facit-fällan, en dimension upp). Fältet är ALLTID
 *                     tillfälligt: noten ska namnge vilken fix som får ta bort
 *                     det, och när den landat körs REGEN om utan flaggan.
 *                     Frånvarande fält = öppningsdimensionen är låst (default).
 * `pollEraMinutes`    — AISHub-API:ets `interval=`-parameter (datafönstret,
 *                     INTE pollfrekvensen) när korpusen spelades in. Ren
 *                     metadata: den som kalibrerar fixåldersgrindar måste veta
 *                     vilken epok datat kommer ifrån. Saknas fältet är korpusen
 *                     inspelad i aisstream-eran (ingen poll alls).
 */

const path = require('path');

const LOGS_DIR = path.resolve(__dirname, '../../../logs');

// ChatGPT-granskningen 2026-07-10 (B3): de låsta korpusarnas jsonl (~0,5 MB
// totalt) är byte-exakta kopior committade I repot — replay:all fungerar nu
// i en ren checkout/CI utan OneDrive-arkivet. appLog-fälten pekar kvar på
// det externa arkivet (multi-MB, konsumeras ALDRIG av harnessen — enbart
// dokumentära pekare för manuell rotorsaksanalys). VIKTIGT vid ny korpus:
// kopiera jsonl:en hit OFÖRÄNDRAD (facit-fällan — samma bytes, samma facit).
const CORPORA_DATA_DIR = path.resolve(__dirname, 'corpora-data');

module.exports = [
  {
    id: '20260525',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260525-231934.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260525-231934.log'),
    hours: 4,
    locked: true,
    expectedNotifications: 30,
    note: 'Ursprungskorpus. OMLÅST 29→30 (2026-06-11): prod MISSADE AURANA@Klaffbron '
      + '(målbro!) — failsafen ströps av RC3-buggen (prodlogg 07:47:41: "estimated '
      + '472s... sog=3.7kn" med momentan inbromsningsfart). Den 30:e notisen är '
      + 'den rättade missen. Facit-fällan in action: gamla 29 kodifierade buggen. '
      + 'GOLDEN OMLÅST (2026-08-06, B3 gästhamnskapseln): två gästhamnsvobblare '
      + '(244236598 sog 0–1,2 + 244870852 sog 0, båda 100 % i kapseln 10:10–10:40) '
      + 'störde texten kring 10:26–10:28; med kapseln demoteras de och den äkta '
      + 'Klaffbron-båtens text renderas rent ("strax" 10:26:43 i st f "ETA okänd" '
      + '10:27:56). Notis-/fördelnings-/riktningsfacit ORÖRDA (30/30).'
      + 'GOLDEN OMLÅST (2026-08-09, C0b zon-lokal kögrace): 74 → 72 övergångar. Rådataverifierat: MARIANNE (244236598) och JOSEPHINE (244870852) låg BÅDA i gästhamnskapseln 10:10–10:27 (MARIANNE sog 0–0,2 på 3–9 m från kapsellinjen från 10:12:51, JOSEPHINE sog 0 vid 10:11:43 och 10:26:43) — texten "Två båtar på väg mot Klaffbron" räknade alltså två FÖRTÖJDA båtar. Det gamla 600 m-köundantaget (VesselDataService: zoneMinStillMs 3 → 15 min när targetBridge ≤ 600 m) gällde globalt och träffade gästhamnen, som ligger 354–411 m från Klaffbron. Med queueGraceMs=0 på gästhamnsposten demoteras de efter 3 min. Notis-/fördelnings-/riktnings-/öppningsfacit ORÖRDA (30/30).',
  },
  {
    id: '20260601-41h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260601-231305.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260601-231305.log'),
    hours: 41,
    locked: true,
    expectedNotifications: 84,
    note: '41h-korpusen. 75/75 inkl. per-fartyg+bro-fördelning validerat 2026-06-09 '
      + '(prod-loggens 75:e är null-attribuerad — samma notis, 211355290@Stallbackabron). '
      + 'OMLÅST 75→77 (2026-07-01, S-F3 + previousTarget-fixen): BÅDA nya är RÄTTADE '
      + 'missar för 265580000 (EBONITA PRINCESS), verifierade mot rå jsonl: '
      + '(1) Stallbackabron — verklig norrgående korsning 08:45:00 (lat 58.3098→58.3131, '
      + '8,9 kn) som "en passage per update"-breaken tappade; (2) Järnvägsbron — korsad '
      + 'i 15-min-gapet 08:18→08:33 (58.28x→58.2946 spänner 58.2916); gamla koden '
      + 'registrerade fel TARGET_END-bro (stale previousTarget) så RC2b-inferensen '
      + 'aldrig fick fyra. Fixen rättade även riktningstokens (northbound, tidigare '
      + 'felaktigt southbound) och eliminerade dubbel Klaffbron-registrering. '
      + 'Samma facit-fälle-prejudikat som AURANA 29→30. OMLÅST 77→78 (2026-07-02, '
      + 'MOSHE-fixen): 211112870@Stallbackabron är RÄTTAD miss — återfödd målbrolös '
      + 'efter 73-min-gap norr om Stridsbergsbron, live-korsade Stallbackabron '
      + '11:40→11:47 (6,3–6,9 kn, verifierad mot rå jsonl); målbrolösa fartyg fick '
      + 'tidigare ingen linjekorsningsdetektering alls. OMLÅST 78→81 (2026-07-02b, '
      + 'SY FREYJA-fixen: target-gaten i skipped-bridges-failsafen borttagen): alla '
      + 'tre nya är RÄTTADE missar för MÅLLÖSA fartyg, verifierade mot rå jsonl: '
      + '(1) 211112870@Stridsbergsbron — korsad i 72-min-gapet 10:22→11:35 '
      + '(58.28808→58.29902 spänner 58.2935), återfödd mållös 615 m norr om bron '
      + '(Järnvägsbron föll utanför 300s-fönstret, ~302s — medveten policy); '
      + '(2) 231898000@Stallbackabron — 17h ankrad vid Spikön, avgick 13:58 norrut '
      + 'MÅLLÖS, korsade Stallbackabron i 5,5-min-gapet 14:03:54→14:09:22 '
      + '(58.30540→58.31410 spänner 58.31143); (3) 265759700@Klaffbron — södergående, '
      + 'korsade Klaffbron i 30-min-gapet 08:17→08:47 (58.31079→58.27945), återfödd '
      + 'mållös 516 m söder om bron (Jvb/Strids utanför tidsfönstret — policy). '
      + 'Gamla gaten `!targetBridge && !_finalTargetBridge` strök failsafen för '
      + 'utgående/mållösa båtar — samma klass som MOSHE-missen fast i app-lagret. '
      + 'OMLÅST 81→85 (2026-07-03, gap-kedjefixen B2/F8): fyra RÄTTADE missar, '
      + 'verifierade mot rå jsonl: (1) 211112870/BRANIF@Järnvägsbron — korsad i '
      + '72,6-min-gapet 10:22→11:35 (58.28808→58.29902 spänner 58.29164); gamla '
      + '300s-skattningen ströp den (dokumenterad icke-fix i 2026-07-02b, nu '
      + 'levererad av detectionTs-regeln); (2) 211112870/BRANIF@Olidebron — '
      + 'födelseinferens (född 58.28808 norrut i 4,6 kn, Olidebron bakom): '
      + 'F8-ANVÄNDARBESLUTET 2026-07-03 "alltid notis vid bekräftad inferens" '
      + '(kaj-alternativet kan inte uteslutas — accepterad osäkerhet per beslut); '
      + '(3+4) 265759700@Järnvägsbron+Stridsbergsbron — korsade i 30,4-min-gapet '
      + '08:17→08:47 (58.31079→58.27945 spänner båda); tidigare ströps de av '
      + '2000 m-taket/tidsfönstret (dokumenterad policy-icke-fix, nu levererad '
      + 'av inferredFlush-undantaget). OBS: SPIKEN-vakten (sista kända position '
      + 'begränsar återfödelseinferens) hindrar 231898000:s FALSKA Jvb/Strids-'
      + 'notiser som en naiv F8 hade skapat — ankrad norr om broarna hela tiden. '
      + 'OMLÅST 85→86 (2026-07-10b, A4-3/P2-4: exit-gaten för MÅLLÖSA sydgående): '
      + '265759700@Kanalinfarten är RÄTTAD miss, verifierad mot rå jsonl: full '
      + 'sydtransit (58.319→58.272, alla broar korsade söderut), sista sample '
      + '08:53:55 507 m NORR om punkten i 4,5 kn/cog 213 (aktiv transit) → removal. '
      + 'Gamla gaten krävde _finalTargetDirection+_finalTargetBridge (avslutad resa) '
      + '— mållösa transitörer miste exit-notisen strukturellt (samma klass som '
      + 'SY FREYJA-fixen tog i svepet). '
      + 'OMLÅST 86→84 (2026-08-06, B3 gästhamnskapseln): BRANIF:s (211112870) två '
      + 'FÖDELSEINFERENS-notiser @Klaffbron+@Olidebron är BORTTAGNA fantomer. '
      + 'Rådata: född 58.28808/12.28768 (ÖSTRA stranden, 125 m från gästhamns- '
      + 'linjen = inom N7-kajstartsmarginalen, långt öster om farleden ~12.2850) '
      + 'i 4,6 kn cog 36 — NOLL sampel söder om Klaffbron. F8-beslutet 2026-07-03 '
      + 'accepterade inferensen för att "kaj-alternativet inte kunde uteslutas"; '
      + 'B3-kapseln (datahärledd ur fältdygnen 2026-08-04/05) STYRKER nu kaj- '
      + 'alternativet, så N7-kajvakten undertrycker inferensen — samma EUGENIE-/ '
      + 'kajavgångsklass som both-dygn 1 fällde. Järnvägsbron-notisen (äkta '
      + 'gap-korsning med sampel på båda sidor) är OFÖRÄNDRAT kvar. '
      + 'GOLDEN OMLÅST (2026-08-09, C1d skyddszonens närmast-bro-val): 164 → 166 '
      + 'övergångar, FYRA poster, samtliga rådataverifierade mot '
      + 'ais-replay-20260601-231305.jsonl för 265735370 (AQUILA). BORT: '
      + '"Inga båtar är i närheten av Klaffbron eller Stridsbergsbron" 13:18:37 '
      + '— FALSK. IN: "En båt på väg mot Klaffbron, beräknad broöppning om 72 '
      + 'minuter" 13:17:47, "…ETA okänd" 13:28:07 och DEFAULT 13:29:43. '
      + 'Rådata: AQUILA kom söderut från Stallbacka-området (13:07:15 sog 7,7), '
      + 'korsade Stridsbergsbron mellan 13:07:15 och 13:15:45, låg sedan still '
      + '(sog 0–2,8; nettoförflyttning ~42 m på 28 min) 1 103–1 159 m från '
      + 'Klaffbron och 141–197 m från den '
      + 'OPASSERADE Järnvägsbron 13:15:45–13:43:39, korsade Järnvägsbron mellan '
      + '13:43:39 och 13:52:35 och Klaffbron 13:55:37 (sog 5,0). Hon var alltså '
      + 'en ÄKTA köare hela fönstret; den gamla texten påstod att inga båtar '
      + 'fanns. Rotorsak: _isInProtectionZone valde den NÄRMASTE bron '
      + '(Stridsbergsbron, passerad) framför den opasserade Järnvägsbron, varpå '
      + 'F21:s bypass frigav målbron. ETA-värdet 72 min är den kända '
      + 'köfartsöverskattningen (planens C14 — 0,2 kn ⇒ 72 min mot verkliga '
      + '37,8) och ändras inte av C1d. Notis-/fördelnings-/riktnings-/'
      + 'öppningsfacit ORÖRDA (84/84, 27 öppningsvarningar). '
      + 'GOLDEN OMLÅST 166→165 (2026-08-10, P9 kajliggarlivscykeln). '
      + 'HELA DIFFEN mot 5799b7a, LCS + multiset (omskriven av F7 2026-08-10: '
      + 'den ursprungliga noten nämnde ENBART flimmerraden och framställde '
      + 'därmed ändringen som enbart positiv — det var fel). '
      + 'BORT 1 RAD: 08:11:43.863 "Två båtar … Stridsbergsbron … om cirka 5 '
      + 'minuter", livstid 0,082 s (82 ms; ersattes redan .945 av "om 4"). '
      + 'TILLAGT: 0 rader. INNEHÅLLSDIFF vid identisk tidsstämpel: 0 — inget '
      + 'ETA-värde och ingen båträkning ändras någonstans i korpusen. '
      + 'TIDSSKIFT: 5 rader flyttar sig, varav 2 med ≥ 1 s (BÅDA SENARE, 0 '
      + 'tidigare) och 3 under 1 s (+796 ms samt ±10 ms × 2). '
      + 'PRISET — TRE SENARELAGDA "Inga båtar"-ÖVERGÅNGAR, 44,9 s: '
      + '23:00:14.804 → 23:00:37.016 (+22,2 s — "En båt på väg mot Klaffbron, '
      + 'beräknad broöppning strax" står alltså kvar 22 s längre på en båt som '
      + 'inte längre finns), 08:45:15.129 → 08:45:37.016 (+21,9 s, föregående '
      + 'text "En båt på väg mot Klaffbron, ETA okänd") och 01:50:06.220 → '
      + '01:50:07.016 (+0,8 s). '
      + 'DET ÄR P9:s SYSTEMATISKA KOSTNAD, inte en slump: kajliggare överlever '
      + 'churnen, alltså inträffar nedgraderingen till "Inga båtar" senare. '
      + 'Mätt över samtliga sju P9-omlåsta korpusar: 10 senarelagda övergångar '
      + '/ 91,0 s extra visning av föregående text, mot 2 tidigarelagda / '
      + '18,1 s. Vinsten som betalar för det är tidigare förvarning (se '
      + '20260804-17h: JUNO +3 min) och färre flimmerrader. '
      + 'Notis-/riktnings-/öppningsmultiset verifierade exakta av relockGoldenText. '
      + 'GOLDEN OMLÅST 165→165 (2026-08-10, P10C bäringsvillkoret): '
      + 'AMALIA II/265759700 (8,4 kn sydgående, sista fix 08:16:56 195 m S om = '
      + 'FÖRBI Stallbackabron, 30,5 min tyst; verklig Stridsbergsbropassage '
      + '~08:26) släpps 08:32:06 i st.f. 08:37:07 — golden visade "på väg mot '
      + 'Stridsbergsbron" ~11 min EFTER verklig passage, nu ~6. '
      + 'HELA DIFFEN mot ce6a946, LCS + multiset (F7 2026-08-10): EXAKT TVÅ '
      + 'radpositioner byts, allt annat i filen är byte-identiskt. '
      + 'GAMMALT: 08:31:14.712 "Tre båtar … Klaffbron strax; En båt … '
      + 'Stridsbergsbron, ETA okänd" (105,2 s) → 08:32:59.920 "Två båtar … '
      + 'Klaffbron strax; En båt … Stridsbergsbron, ETA okänd" (247,1 s) → '
      + '08:37:07.016 "Två båtar … Klaffbron strax". '
      + 'NYTT: samma första rad (nu 52,1 s) → NY rad 08:32:06.808 "Tre båtar … '
      + 'Klaffbron strax" (53,1 s) → 08:32:59.920 "Två båtar … Klaffbron strax". '
      + 'Stridsbergsklausulen släpps alltså 08:32:06,8 i stället för 08:37:07,0 '
      + '= 5 min 0,2 s mindre spöktext. Klaffbrongruppens nedräkning (3 → 2 vid '
      + '08:32:59.920) är ORÖRD, inga ETA-värden ändras, inga "Inga båtar"-'
      + 'övergångar berörs (13 i båda versionerna) och ingen annan rad flyttar '
      + 'sig — den enda post LCS bokför som tidsskift (−247,1 s) är just den '
      + 'omflyttade "Två båtar … Klaffbron strax"-raden ovan. '
      + 'Samma bakom-bro-klass som SABETH/AKLEJA; alla övriga multiset exakta.',
  },
  {
    id: '20260610-förfix',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260610-001053.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260610-001053.log'),
    hours: 1,
    locked: true,
    expectedNotifications: 0,
    note: 'Kort FÖRFIX-körning. Prods enda notis (22:16:08, 220276000 SKONNERTEN '
      + 'JYLLAND @Klaffbron 240m, status=en-route, ETA=-1) var kajliggarbuggens '
      + 'FALSKA notis — korrekt beteende är 0. Låst 2026-06-10 efter mooring-fixen.',
  },
  {
    id: '20260611-4h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260611-115443.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260611-115443.log'),
    hours: 4,
    locked: true,
    expectedNotifications: 3,
    note: 'Verifieringskörning efter 19h-auditens fixar (2ae66a4). En båt '
      + '(219028819): vänta vid Järnvägsbron → Strids → Stallbacka, 3 korrekta '
      + 'notiser; 503-storm 12:14-12:36 hanterad; 4h tyst kanal med watchdog. '
      + 'Låst 2026-06-12. OBS: RC-S3 flyttar Järnvägsbron-notisen till första '
      + 'rörelsebevisade samplet (09:58) — antal och fördelning oförändrade.',
  },
  {
    id: '20260610-19h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260610-012751.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260610-012751.log'),
    hours: 19,
    locked: true,
    expectedNotifications: 51,
    note: '19h-körningen (RC1–RC9-auditens underlag). LÅST 47 (2026-06-11): prod gav '
      + '45 men MISSADE två — SILJA@Klaffbron (RC3: failsafe-stale-skattning med '
      + 'momentan sog) och DIANA@Järnvägsbron (RC2: falsk INFERRED_PASSAGE '
      + 'blockerade äkta passagen). Replay med fixarna ger exakt dessa +2, '
      + 'inga andra fördelningsändringar (verifierat per mmsi+bro 2026-06-11). '
      + 'OMLÅST 47→49 (2026-07-03, gap-kedjefixen B2/F8), verifierade mot rå '
      + 'jsonl: (1) 211478350/SABETH@Stridsbergsbron — korsad i 41,5-min-gapet '
      + '08:04→08:46 (58.27445→58.30655 spänner 58.29352); (2) 235029263@'
      + 'Klaffbron — södergående född 58.27414 SÖDER om Klaffbron i 3,3 kn: '
      + 'Klaffbron passerades logiskt säkert (både kaj- och Vänern-ursprung '
      + 'ligger norr om bron); gamla 300s-skattningen ströp båda. '
      + 'OMLÅST 49→51 (2026-07-09, fältprov 4 F4-B — SENTA-klassen: '
      + 'inferredFlush gäller nu även scenario A:s positionsbevisade '
      + 'reborn-fönster): +211478350/SABETH@Järnvägsbron + @Klaffbron — '
      + 'BÅDA korsade i samma bevisade 42-min-gap 08:04→08:46 '
      + '(58.27445→58.30655 spänner 58.2841 och 58.2916); gamla '
      + '2000 m-taket ströp dem (2139/1600+ m) medan grannbron i samma '
      + 'fönster notifierades — inkonsekvensen som fältprov 4 blottlade. '
      + 'GOLDEN OMLÅST 99→99 (2026-08-10, P10C bäringsvillkoret på 20-min-nivån): '
      + 'SABETH/211478350 (5,5 kn, 260 m N om redan passerad Olidebron, sedan '
      + '41 min AIS-tyst; interpolerat passerade hon Klaffbron ~08:17) släpps nu '
      + '08:20:05 (15 min) i st.f. 08:25:04 (20 min) — ~5 min bevisad spöktext '
      + '"på väg mot Klaffbron" bort. '
      + 'HELA DIFFEN mot ce6a946, LCS + multiset (F7 2026-08-10): EXAKT TRE '
      + 'radpositioner ([60]–[62]) skrivs om, allt annat är byte-identiskt. '
      + 'GAMMALT: [59] 08:16:47.601 "En båt … Klaffbron, ETA okänd; Två båtar … '
      + 'Stridsbergsbron om 4 minuter" (407,9 s) → [60] 08:23:35.685 "En båt … '
      + 'Klaffbron, ETA okänd; Två båtar … Stridsbergsbron, ETA okänd" (71,4 s) '
      + '→ [61] 08:24:47.058 "En båt … Klaffbron, ETA okänd; Två båtar … '
      + 'Stridsbergsbron strax" (17,7 s) → [62] 08:25:04.775 "Två båtar … '
      + 'Stridsbergsbron strax". '
      + 'NYTT: [59] oförändrad rad men nu 198,1 s → [60] 08:20:05.685 "Två båtar '
      + '… Stridsbergsbron om 4 minuter" (210,0 s) → [61] 08:23:35.685 "Två '
      + 'båtar … Stridsbergsbron, ETA okänd" (71,4 s) → [62] 08:24:47.058 "Två '
      + 'båtar … Stridsbergsbron strax". '
      + 'Klaffbronklausulen försvinner alltså 08:20:05,7 i stället för '
      + '08:25:04,8 = 4 min 59,1 s mindre spöktext. Stridsbergsklausulens egen '
      + 'sekvens (om 4 → ETA okänd → strax) är ORÖRD i innehåll; radantalet är '
      + 'oförändrat (99) eftersom en NY tidsstämpel (08:20:05.685) tillkommer i '
      + 'toppen samtidigt som den gamla 08:25:04.775 faller bort, medan '
      + '08:23:35.685 och 08:24:47.058 skjuts ned ett steg och bär de förkortade '
      + 'texterna. Inga "Inga båtar"-övergångar berörs (7 i båda), inga andra '
      + 'ETA-värden ändras. '
      + 'Notis-/riktnings-/öppningsmultiset verifierade exakta av relockGoldenText.',
  },
  {
    id: '20260702-11h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260702-010825.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260702-010825.log'),
    hours: 11,
    locked: true,
    expectedNotifications: 32,
    note: '11h-valideringskörningen efter helkodsgranskningen (f0cf7c7). LÅST 24 '
      + '(2026-07-02): prod gav 23; +1 är RÄTTAD miss MOSHE/211471090@Olidebron — '
      + 'stale-raderad i 44-min-gap, återfödd målbrolös söder om Klaffbron, '
      + 'live-korsade Olidebron 09:09→09:15 (312 m från bron vid båda samples = '
      + 'utanför proximityzonen) men målbrolösa fartyg fick ingen linjekorsnings- '
      + 'detektering. Nio fartyg inkl. kajavgång (S-F6 verifierad live: '
      + 'INFERRED_PASSAGE_SKIP korrekt), 29-min-gap räddat komplett (SILVERMORK II, '
      + 'alla 6 broar), nattlig 503/429-storm hanterad. Prod-textflappen '
      + '(NO LIMIT: RC7-filtret dolde stillaliggande båt med gles mottagning, '
      + '"Inga båtar" var 10:e minut) fixad — replay har 0 DEFAULT-flashar '
      + '(INV-14 vaktar klassen). OMLÅST 24→25 (2026-07-03, gap-kedjefixen '
      + 'B2/inferredFlush): +1 är RÄTTAD miss 211471090/MOSHE@Klaffbron — '
      + 'korsad i 44,3-min-gapet 08:24→09:09 (58.30775→58.27507 spänner '
      + '58.28409), verifierad mot rå jsonl; ströps tidigare av 2000 m-taket/'
      + 'tidsfönstret (samma klass som ELFKUNGEN F2). OMLÅST 25→30 '
      + '(2026-07-09, fältprov 4 F4-B — SENTA-klassen: inferredFlush även i '
      + 'scenario A:s positionsbevisade reborn-fönster), ALLA verifierade '
      + 'mot rå jsonl: +211471090/MOSHE@Järnvägsbron + @Stridsbergsbron '
      + '(samma bevisade 44-min-gap 08:24→09:09 som Klaffbron-tillägget — '
      + 'fönstret spänner 58.2916 och 58.2935); +265571760/SOLUTION@'
      + 'Järnvägsbron + @Klaffbron + @Stridsbergsbron (53-min-gapet '
      + '09:23→10:16, 58.27920→58.31115 spänner alla tre). 2000 m-taket '
      + 'ströp samtliga trots positionsbevisad korsning. OMLÅST 30→31 '
      + '(2026-07-10, fältprov 5 F5-B — IN-AXXI-klassen: exit-fallbackens '
      + 'radie villkorat utökad 400→800 m vid aktiv sydtransit): '
      + '+265726650@Kanalinfarten — rådataverifierad: kontinuerlig sydresa, '
      + 'sista sample 07:11:15 @529 m från punkten i 4,5 kn/cog 213 med '
      + 'Olidebron passerad; gamla 400 m-gaten strök den äkta exiten tyst. '
      + 'OMLÅST 31→32 (2026-07-10b, A4-3/P2-4: exit-gaten för MÅLLÖSA sydgående): '
      + '+211471090/MOSHE@Kanalinfarten — rådataverifierad: sydtransit '
      + '58.310→58.270 (Strids/Jvb/Klaff/Olide korsade), sista sample 09:15:39 '
      + '316 m NORR om punkten i 4,9 kn/cog 212 → removal. MOSHE var återfödd '
      + 'MÅLLÖS (target aldrig satt) — gamla gaten krävde avslutad resa '
      + '(_finalTargetDirection) och strök hennes exit strukturellt.',
  },
  {
    id: '20260702-2h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260702-132758.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260702-132758.log'),
    hours: 2,
    locked: true,
    expectedNotifications: 33,
    note: 'Eftermiddagskörningen 2026-07-02 (nio fartyg, källa till de åtta felen i '
      + 'docs/korrigeringar-2026-07-02b.md). LÅST 30 (2026-07-02): prod gav 26; '
      + 'diffarna är verifierade mot rå jsonl: −1 CLABBYDOO@Järnvägsbron (trolig '
      + 'FALSK kajavgångsnotis — N7-marginalen), +2 SY FREYJA@Jvb+Strids (korsade '
      + 'i 20-min-gap, target-gaten åt failsafen), +1 ELFKUNGEN@Strids (äkta '
      + 'passage 12:08:30, prod-blockerad av omstarts-dedup som replay saknar), '
      + '+2 ELFKUNGEN@Jvb (korsad i 22-min-gap) + ELFKUNGEN@Kanalinfarten (äkta '
      + 'exit; båda möjliga när kajzonsdemoteringens kö-förtur behåller target). '
      + 'Körningen valideras även med 14 invarianter (rena) — bl.a. tvingade '
      + 'INV-14 mitt-i-passage-nivån 15→20 min (PAX-flashen 12:24:55). '
      + 'OMLÅST 30→32 (2026-07-03, gap-kedjefixen F8): +2 för 257639530/SIVSIN '
      + '— södergående född 58.27549 i 5,7 kn: Klaffbron logiskt säker (både '
      + 'kaj- och Vänern-ursprung ligger norr om bron), Järnvägsbron '
      + 'födelseinferens per F8-ANVÄNDARBESLUTET (säker endast vid Vänern-'
      + 'ursprung — accepterad osäkerhet per beslut). OBS: SPIKEN-vakten '
      + 'hindrar SY FREYJA:s falska Klaffbron-gissning (sist känd 58.28919 '
      + 'NORR om Klaffbron — bron låg aldrig i det belagda fönstret). '
      + 'OMLÅST 32→33 (2026-07-10, fältprov 5 F5-B — IN-AXXI-klassen): '
      + '+265558470/PAX@Kanalinfarten — rådataverifierad: kontinuerlig '
      + 'sydresa, sista sample 12:44:16 @482 m i 6,0 kn/cog 211 med '
      + 'Olidebron passerad; gamla 400 m-exitgaten strök den äkta exiten.',
  },
  {
    id: '20260702-19h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260702-174109.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260702-174109.log'),
    hours: 19.5,
    locked: true,
    expectedNotifications: 55,
    note: '19,5h-körningen 2026-07-02→03 (tolv fartyg, källa till fynden F1–F14 i '
      + 'docs/korrigeringar-2026-07-03.md). LÅST 54 (2026-07-03): prod gav 48; '
      + 'alla 6 diffar är RÄTTADE missar verifierade mot rå jsonl: '
      + '+3 ELFKUNGEN@Klaffbron+Järnvägsbron+Stridsbergsbron (23-min-gap; '
      + 'cog-gaten 50,2° strök scenario B och 2000 m-taket dödade flushen — F2), '
      + '+1 DIANA@Järnvägsbron (2057 m > gamla 2000 m-taket — F5), '
      + '+1 PHILULA@Kanalinfarten + 1 DIAMOND@Kanalinfarten (F8-ANVÄNDARBESLUTET '
      + '2026-07-03: bekräftad födelseinferens notifieras alltid — gamla '
      + '300 s-skattningen ströp dem godtyckligt). VALEN:s 5 notiser hette '
      + '"Unknown" i prod (F1, namnkedjan) — replay från kall cache ger '
      + '"Okänd båt" tills namnet anländer 17:09; namncachen löser det i drift '
      + 'från andra körningen. Förtöjda APHRODITE/SOLUTION 0 notiser (F14). '
      + 'INV-13 kräver no-target-undantaget (NO LIMIT: mållös kajavgång '
      + 'passerade Klaffbron — korrekt intermediate-bokföring). '
      + 'OMLÅST 54→55 (2026-07-10, fältprov 5 F5-B — IN-AXXI-klassen): '
      + '+265741640@Kanalinfarten — rådataverifierad: kontinuerlig sydresa '
      + '(alla fem broar redan i fördelningen), sista sample 17:10:51 @477 m '
      + 'i 5,0 kn/cog 214; gamla 400 m-exitgaten strök den äkta exiten.',
  },
  {
    id: '20260707-14h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260707-092154.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260707-092154.log'),
    hours: 14,
    locked: true,
    expectedNotifications: 74,
    note: '14h-fältprovet 2026-07-07 (femton fartyg, dagtrafik, gles Class B — '
      + 'radgranskat av 47 Opus-agenter + dirigent, se '
      + 'docs/helgranskning-2026-07-06.md §fältprov). LÅST 72 (2026-07-08): '
      + 'prod gav 66; alla 6 diffar är RÄTTADE missar verifierade mot rå '
      + 'jsonl: +4 ELFKUNGEN retur-transiten 12:05–12:39 '
      + '(Stallbacka+Strids+Jvb+Klaffbron — banbevisad N→S-tur-och-retur; '
      + 'sessionsdedupens riktningsundantag saknades medan persistent-lagret '
      + 'korrekt släppte), +1 HERA II@Järnvägsbron (positionsbevisad korsning '
      + 'i 33-min-gapet 08:42→09:15; scenario A:s sog≥2-portgissningsgate '
      + 'ströks för reborn-med-positionsbevis), +1 LYS@Olidebron '
      + '(positionsbevisad 10:04→10:14; timeout-completed-posten + '
      + 'reentry-blocket åt gap-failsafen — completed kräver nu '
      + 'riktningsslutförd resa). LYS@Kanalinfarten INTE facit (sista sample '
      + '58.2689 norr om triggern — korsningen aldrig belagd; stale-gaten '
      + 'stoppar korrekt). Prods null-mmsi-notis är HAVBO@Stallbackabron '
      + '(banbevisad; korrekt attribuerad i replay, loggkosmetiken fixad). '
      + 'Fältbevisade i körningen: watchdog-eskaleringen 20→40→80→120, '
      + 'PASSED_HOLD_UI-klassen (IMPERATOR/BALTIC JONGLEUR terminal-DEFAULT), '
      + '0 fel, 0 textflappar (117 ändringar). '
      + 'OMLÅST 72→73 (2026-07-10b, A4-3/P2-4: exit-gaten för MÅLLÖSA sydgående): '
      + '+265083240@Kanalinfarten — rådataverifierad: full sydtransit '
      + '(58.318→58.271, alla broar korsade söderut), sista sample 15:48:45 '
      + '409 m NORR om punkten i 5,8 kn/cog 214 → removal. Gamla gaten krävde '
      + 'avslutad resa (_finalTargetDirection) och strök exiten strukturellt. '
      + 'GOLDEN OMLÅST (R2 2026-07-11, SR2-3): AKIRA-spöket förkortat 25→6,5 '
      + 'min — stillaliggande kajbåt (0,1 kn @58.2876, sista sample 08:37:10) '
      + 'med retroaktiv Klaffbron-passage fick korrekt passed-status via '
      + 'färsklästa broöppningsfönstret i stället för att spöka i "Fyra båtar '
      + 'på väg mot Stridsbergsbron" med ETA 53 min (F4-I-spökbåtsklassen). '
      + 'OMLÅST 73→74 (R2 2026-07-11, A1R2-3 alt. 1 — ANVÄNDARBESLUT: '
      + 'avfyrad bro-notis räknas som transitbevis i exit-gaten): '
      + '+211321210/LYS@Kanalinfarten är RÄTTAD miss, rådataverifierad: '
      + 'avgång 10:04 i 6 kn syd, Olidebron positionsbevisat korsad '
      + '10:04→10:14 (den redan facit-rättade +1-missen — notisen kom via '
      + 'svepet som INTE bokför i passedBridges, därför nådde hon aldrig '
      + 'exit-gaten i gårdagens omlåsning), sista sample 10:14:39 i 5 kn/'
      + 'cog 210 ENDAST 119 m norr om punkten — närmare än både IN-AXXI '
      + '(546 m) och 265083240 (409 m). Fältprov 2-notens "LYS@Kanalinfarten '
      + 'INTE facit" beskrev dåvarande gate-beteende (mållösa nådde aldrig '
      + 'exit-vägen), inte en dom över den fysiska händelsen — HÄVD med '
      + 'detta rådatabelägg.',
  },
  {
    id: '20260708-21h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260708-001857.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260708-001857.log'),
    hours: 21,
    locked: true,
    expectedNotifications: 55,
    note: '21h-körningen 2026-07-08 (tio fartyg, dagtrafik + tyst natt/'
      + 'eftermiddag — fältprov 3: 28 granskare radläste 59 258 rader, se '
      + 'docs/helgranskning-2026-07-06.md §fältprov 3). LÅST 55 (2026-07-08) '
      + '= prod EXAKT: körningen hade inga missade och inga falska notiser '
      + '(första fältprovet med 100 % pelare 2 ur lådan). HALIFAX Olidebron '
      + '×2 är KORREKT (äkta U-sväng 08:29 syd → 08:39 nord = två öppnings-'
      + 'händelser); ELFKUNGEN 8 notiser (nordresa + sydretur 12:54 — '
      + 'Klaffbron-returen EJ facit: transpondern tystnade 476 m före bron, '
      + 'korsningen aldrig belagd — LYS-regeln). Körningen fällde tre fixar '
      + 'som replayen validerar: AKIRA-reversalen (broskorsningsbevis slår '
      + 'Fix D:s COG-debounce — spöktexten "på väg mot Klaffbron" rättas i '
      + 'korsningsticken, inte 5,5 min senare), riktningsrelativ N1-reset '
      + '(full journey-reset rensade nya benets dedup → Jvb ×2 i replayen '
      + 'tills fixen), och retroaktiv-källa-gaten i persistent-dedupen '
      + '(riktningsflip-undantaget kräver ≥15 min gammal post för '
      + 'passage-fallback/just-passed/exit — AKIRA:s felmärkta approach-post '
      + 'fick inte återutlösa failsafen; approach-vägen behåller '
      + 'HALIFAX-semantiken). KÄND WARN: INV-15 på AKIRA@Järnvägsbron '
      + '07:20:09 (token southbound, rörelse nordlig) — riktningen var '
      + 'genuint obelagd där (cog 101°, 1,5 kn, inlåst syd sedan '
      + 'kajavgången); korsningsbeviset kom först 07:30 och rättade allt '
      + 'nedströms. Medveten avvägning: låst ruttriktning > momentan COG '
      + 'för token (replay-fyndet 2026-06-01).',
  },
  {
    id: '20260710-13h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260710-015254.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260710-015254.log'),
    hours: 13.5,
    locked: true,
    expectedNotifications: 80,
    note: '13,5h-körningen 2026-07-10 (tolv fartyg, intensiv dagtrafik — '
      + 'fältprov 5: 50 Opus-max-läsare radläste 123 989 rader, se '
      + 'docs/helgranskning-2026-07-06.md §fältprov 5). LÅST 79 (2026-07-10): '
      + 'prod gav också 79 men med 2 fel + 2 missar som tar ut varandra i '
      + 'antal — facit är replay-utfallet med F5-A/F5-B, varje diff '
      + 'rådataverifierad: −1 PILOT 761@Stallbackabron 08:25 (FANTOM: '
      + 'stillaliggande vid lots-stationen, sog 0/ANCHOR_BLOCK, '
      + 're-notifierad när 2h-posten prunades — F5-A:s rörelsekrav), '
      + '−1 PILOT 761@Stallbackabron 11:32 (DUBBLETT: expired-släpp under '
      + 'obekräftad reversal med fel riktningstoken; 11:33-notisen efter '
      + 'NEW_JOURNEY-bekräftelsen är den äkta — F5-A:s pending-gate), '
      + '+1 IN-AXXI@Kanalinfarten (ÄKTA missad exit: sista sample 546 m '
      + 'norr om punkten i 6,5 kn sydtransit, Olide passerad — F5-B), '
      + '+1 ELFKUNGEN@Kanalinfarten syd (ÄKTA: sista sample 13:09 @425 m '
      + 'i 6,1 kn sydtransit; prod-loggen dog i wifi-hålet före removal). '
      + 'LOGG-INTEGRITET: håldetektorns utslag (13:12:15–13:18:45, wifi-'
      + 'tapp på loggdatorn) ligger EFTER sista jsonl-samplet 13:09:22 — '
      + 'replaydatat är komplett; hålet drabbar enbart loggsvansen '
      + '(användarbeslut: bortse från slutet). Körningen bekräftade även '
      + 'porten-gissningen (LADY X@Klaffbron obevisbar — F8-beslutet äger), '
      + 'beviskontraktet (JOSELINA/MALVA kajstarter utan bakåtfantomer) '
      + 'och F4-fixarna (loggfångst, staleness-klockan) i drift. '
      + 'OMLÅST 79→80 (2026-07-10b, A4-3/P2-4: exit-gaten för MÅLLÖSA sydgående): '
      + '+244750397@Kanalinfarten — rådataverifierad: sydtransit 58.311→58.272 '
      + '(Strids/Jvb/Klaffbron korsade söderut), sista sample 12:37:22 574 m '
      + 'NORR om punkten i 3,5 kn/cog 216 (aktiv transit) → removal. Gamla '
      + 'gaten krävde avslutad resa (_finalTargetDirection) och strök exiten '
      + 'strukturellt (samma klass som IN-AXXI/ELFKUNGEN-exiterna ovan, men '
      + 'för MÅLLÖS transitör). '
      + 'GOLDEN OMLÅST 135→134 (FP9 2026-07-18, FIX L retrograd-vakten): '
      + 'övergången "cirka 2 minuter" 12:48:06 var en artefaktrendering — '
      + '265606970:s retrograda approaching-flapp för redan passerad '
      + 'Olidebron (frusen position sedan passagen, latch-utgången) skapade '
      + 'extra UI-ticks varav ett råkade rendera ELFKUNGENS extrapolerade '
      + 'mellanvärde. Utan flappen renderas nästa tick 12:48:17 där '
      + 'exhausted-kedjan (IMMINENT_SET_EXHAUSTED @311s → 90 s strax → '
      + 'ETA okänd @12:50:06) äger — samma regelverk, notiserna 80/80 '
      + 'byte-identiska.',
  },
  {
    id: '20260711-7h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260711-134232.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260711-134232.log'),
    hours: 7,
    locked: true,
    expectedNotifications: 12,
    note: '7h-körningen 2026-07-11 (åtta fartyg — fältprov 6: 23 Opus max-'
      + 'läsare radläste 47 560 rader, se docs/faltprov6-2026-07-11.md). '
      + 'LÅST 12 (2026-07-13) = prod EXAKT: pelare 2 var PERFEKT ur lådan '
      + '(12 notiser = 12 verkliga passager, 0 miss/fantom/dubblett). '
      + 'Körningen som hittade KNIGHT OWL-57-min-fabrikatet (FP6-1, '
      + '_postTransitionStationaryHold) — pelare 1-fixen ändrar text, inte '
      + 'notiser. Håldetektorn ren. '
      + 'GOLDEN OMLÅST 25→25 (2026-08-10, P9 kajliggarlivscykeln). '
      + 'HELA DIFFEN mot 5799b7a, LCS + multiset (F7 2026-08-10): korpusens '
      + 'MINSTA P9-diff. 0 borttagna rader, 0 tillagda rader, 0 innehållsdiffar '
      + '(textsekvensen är byte-identisk), 0 tidsskift ≥ 1 s, 0 berörda "Inga '
      + 'båtar"-övergångar (3 i båda versionerna). '
      + 'ÄNDRAT: exakt TVÅ tidsstämplar, båda under 1 s — index 17 '
      + '16:24:06.159 → .144 (−15 ms) OCH index 19 16:26:49.195 → .205 '
      + '(+10 ms). (RÄTTELSE F7 2026-08-10: den ursprungliga noten påstod "enda '
      + 'skillnaden 15 ms på index 17" — index 19 saknades.) '
      + 'Schemaläggningsartefakt när kajliggarchurnens UI-omräkningar försvann; '
      + 'ingen användarsynlig verkan.',
  },
  {
    id: '20260711-16h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260711-232958.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260711-232958.log'),
    hours: 16.5,
    locked: true,
    expectedNotifications: 48,
    note: '16,5h-körningen 2026-07-11/12 (fjorton fartyg — fältprov 7: 59 '
      + 'Opus max-läsare radläste 135 455 rader, se docs/faltprov7-2026-07-12.md). '
      + 'LÅST 48 (2026-07-13) = prod 47 + EN RÄTTAD MISS: '
      + '211844940/CALIMA@Kanalinfarten southbound — rådataverifierad: '
      + 'sydutfarten klev ÖVER 300 m-zonen i ett Class B-glapp (330 m N → '
      + '306 m S, segmentets minsta avstånd 43 m från punkten) och FP7-3-'
      + 'segmentsvepet väcker notisen. Körningen som hittade NICOLINE-101-'
      + 'min-fabrikatet (FP7-1, armStationaryHold). Håldetektorn ren. '
      + 'GOLDEN OMLÅST 64→65 (2026-08-10, P9 kajliggarlivscykeln). '
      + 'HELA DIFFEN mot 5799b7a, LCS + multiset (F7 2026-08-10): '
      + 'TILLAGT 1 RAD: 10:04:55.298 "Två båtar … Stridsbergsbron … om cirka 6 '
      + 'minuter", livstid 15,4 s (mellan "om 4" och "om 3") — timerdriven '
      + 'extrapolation exakt vid Fix G:s SOFT-gräns (5 min efter QUEEN ELAN '
      + 'GT5:s sista fix 09:59:55.223, verifierat: ingen AIS-post vid '
      + '10:04:55). BORTTAGET: 0 rader. INNEHÅLLSDIFF vid identisk tidsstämpel: '
      + '0 — inga ETA-värden och inga båträkningar ändras. '
      + 'TIDSSKIFT: 13 rader, varav 9 med ≥ 1 s (5 senare / 4 tidigare) och 4 '
      + 'under 1 s. Extremer: −30,0 s × 2 (11:33:49.398 → 11:33:19.398 "strax" '
      + 'och 11:35:49.398 → 11:35:19.398 "ETA okänd" — dvs. båda '
      + 'TIDIGARELAGDA), +24,5 s (13:50:54.909 → 13:51:19.398 "ETA okänd"), '
      + '−13,5 s, +10,5 s, +6,2 s, +6,0 s, −3,0 s, +1,5 s. '
      + 'PRISET: 1 senarelagd "Inga båtar"-övergång, 12:12:50.655 → '
      + '12:12:52.178 (+1,5 s); 7 övergångar i båda versionerna. '
      + 'Den tillagda cirka-raden är den enda TEXTFÖRSÄMRINGEN i JUST DEN HÄR '
      + 'korpusen (RÄTTELSE F7 2026-08-10: den ursprungliga noten skrev "ENDA '
      + 'försämringen i P9-omlåsningen" — fel, se 20260804-17h 16:09:37.374, '
      + '20260804-both-21h 07:00-serien och de sammanlagt 91,0 s senarelagda '
      + '"Inga båtar"-nedgraderingarna i 20260601-41h:s not). Accepterad som '
      + 'kosmetisk kostnad (cirka-markerad, 15 s) mot att gravvården räddar '
      + '2h-backstoppen.',
  },
  {
    id: '20260712-25h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260712-174434.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260712-174434.log'),
    hours: 25,
    locked: true,
    expectedNotifications: 86,
    note: '25h-körningen 2026-07-12/13 (27 fartyg, 821 samples — fältprov 8: '
      + '90 Opus max-läsare radläste 214 250 rader, 287 fynd/0 critical, se '
      + 'docs/faltprov8-2026-07-13.md). Projektets renaste fältprov: 0 '
      + 'missar/dubbletter, 0 processfel. LÅST 86 (2026-07-13) = prod 88 '
      + 'MINUS två RÄTTADE FANTOMER (FP8-1, kanalrelevans-gaten för '
      + 'sydgående vid triggerPUNKTEN): −265606970/PILOT 761@Kanalinfarten '
      + '05:42 (förtöjd 14 h vid lotskajen ~130 m från punkten, lade ut '
      + 'SÖDERUT, korsade ALDRIG triggerlatituden — max lat 58.26762 < '
      + '58.268) och −265552060/CAPELLA@Kanalinfarten 06:24 (samma kajstart '
      + 'i zonen; korsade linjen sydgående men fönstret börjar I zonen — '
      + 'återvände norrut 33 min senare; ingen kanalresa). Riktningsfacit: '
      + '219034975@Kanalinfarten southbound→unknown (FP8-2, COG-sydbandets '
      + 'topp 314→270: cog 314,7° är 0,3° från nordbandet — båten var '
      + 'sannolikt på väg IN). Golden-text bär FP8-3 (IDUN-inräkningen: '
      + '"Fem båtar på väg mot Stridsbergsbron" 08:21 — alla fem rådata-'
      + 'verifierade Strids-passager). SENTA-exiten (timeout-reborn med '
      + 'lastKnown norr om punkten) är facit-vakt för fönsterkriteriet. '
      + 'GOLDEN OMLÅST 141→140 (2026-08-10, P9 kajliggarlivscykeln). '
      + 'HELA DIFFEN mot 5799b7a, LCS + multiset (F7 2026-08-10). '
      + 'RÄTTELSE AV DENNA NOTS EGEN TIDIGARE UPPGIFT: den sade "−2 flimmerrader, '
      + '+1 ny 25 ms-rad … samma flimmerklass" — KARAKTÄRISERINGEN VAR OMVÄND. '
      + 'De två BORTTAGNA raderna levde 30,7 s resp. 20,9 s (inte flimmer alls); '
      + 'det är den TILLAGDA raden som är flimret, 0,025 s. '
      + 'BORT 2 RADER: (a) 13:39:01.401 "Två båtar … Stridsbergsbron … om cirka '
      + '9 minuter", livstid 30,7 s — mellansteget i serien 12 → 9 → 8 min '
      + 'försvinner, så 13:38:01.351 "om 12 minuter" står 78,2 s i st.f. 60,1 s '
      + 'och nästa värde ("om cirka 8") kommer i stället 12,5 s TIDIGARE '
      + '(13:39:19.579 mot 13:39:32.113). (b) 15:13:19.579 "En båt … Klaffbron, '
      + 'ETA okänd; En båt … Stridsbergsbron om 13 minuter", livstid 20,9 s — '
      + 'Klaffbronbåtens nedgradering "om cirka 2 minuter" → "ETA okänd" skjuts '
      + '20,9 s framåt och sammanfaller nu med att Stridsbergsräkningen går '
      + '1 → 2 (15:13:40.445); raden 15:12:48.354 lever därmed 52,1 s i st.f. '
      + '31,2 s. Båda är alltså samma systematiska klass som de senarelagda '
      + '"Inga båtar"-övergångarna: fartyget lever längre, nedgraderingen kommer '
      + 'senare. '
      + 'TILLAGT 1 RAD: 12:58:02.774 "En båt … Klaffbron om cirka 2 minuter; En '
      + 'båt … Stridsbergsbron om 12 minuter", livstid 0,025 s (25 ms; ersätts '
      + '12:58:02.799 av "strax"). DET är den nya flimmerraden. '
      + 'INNEHÅLLSDIFF vid identisk tidsstämpel: 0. '
      + 'TIDSSKIFT: 23 rader, varav 13 med ≥ 1 s (6 senare / 7 tidigare) och 10 '
      + 'under 1 s. Extremer: +30,0 s (07:34:16.025 → 07:34:46.070), −30,0 s '
      + '(08:12:49.579 → 08:12:19.579), +30,0 s (13:50:19.579 → 13:50:49.579), '
      + '−30,0 s (15:46:19.579 → 15:45:49.579). '
      + '"Inga båtar": 9 övergångar i båda, INGEN senarelagd — tvärtom en '
      + 'TIDIGARELAGD, 09:30:49.579 → 09:30:45.961 (−3,6 s). Korpusen är alltså '
      + 'undantaget som visar att kostnaden är statistisk, inte absolut.',
  },
  {
    id: '20260713-41h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260713-221737.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260713-221737.log'),
    hours: 41,
    locked: true,
    expectedNotifications: 164,
    note: '41h-körningen 2026-07-13/15 (34 fartyg, 1355 samples, 388 825 '
      + 'rader — störst hittills; fältprov 9: 130 Opus xhigh-läsare + '
      + 'dirigentens korsningsfacit, se docs/faltprov9-2026-07-18.md). '
      + 'LÅST 164 (2026-07-18): prod gav 166 men med 2 dubbletter + 1 '
      + 'fantom + 1 målbro-miss — facit är replay-utfallet med FP9-fixarna '
      + 'A–D, varje diff rådataverifierad: −1 SEEBAER III@Kanalinfarten '
      + '(DUBBLETT: N2-resetten rensade dedup för samma-riktnings-reborn '
      + '15 min efter exit-notisen — FIX A), −1 RONJA@Järnvägsbron '
      + '(DUBBLETT: waiting-notis 15:14 + svep-re-notify 18:35 när 2h-'
      + 'fönstret gått ut, sog 0-båt på 202 min gammal lastKnown — FIX D), '
      + '−1 VIRGO@Kanalinfarten (FANTOM: förtöjd lotskajsbåt, drift-cog '
      + '330° kringgick FP8-1:s syd-gate — FIX C), +1 NORFJELL@'
      + 'Stridsbergsbron (ÄKTA MISS: målbron + Järnvägsbron passerade i '
      + 'samma 5,3-min-gap-tick; lastPassedBridge höll bara den sista — '
      + 'FIX B/MULTI_PASSAGE via passedAt). Golden-text bär FIX H\'-vakten '
      + '(kajvobbel-targets söder om Kanalinfarten nekas utan nordprogress '
      + '— 19 falska "på väg mot Klaffbron, om 33–103 min"-övergångar '
      + 'borta; reborn-spik-klassen kvarstår dokumenterad) och FIX I1 '
      + '(under-målbron-strax kräver färsk position). NAUTILUS-exemplet '
      + '(22h-tystnad → Strids 2 025 m > 2000 m-taket vid porten-gissning) '
      + 'är accepterad avvägning, INTE miss i facit. '
      + 'KÄNDA INVARIANTUTSLAG (rådataverifierade, NORDIC SOLA-klassen): '
      + 'sågtanden 08:48:51 "8→14" + oscillationen 08:50:22 "8→14→9" är EN '
      + 'händelse — NORDIC SOLA (258715000) låg 6 min AIS-tyst (360 s) på '
      + 'gruppledarens gamla 8:a, färska samplet 08:48:51.380 visade 1,7 kn '
      + '(kö-inbromsning inför Järnvägsbron; approaching-notisen avfyrade i '
      + 'SAMMA tick) → progressiv ETA 15,8/13,5 → gruppens 14, och 9:an '
      + '95 s senare är re-accelerationen. Ärlig färsk-data-rättelse — '
      + 'textbaserat oskiljbar från SOKERI-signaturen (studsdiskriminatorn '
      + 'antar färskt belagt ursprungsvärde). Undantagen är EXAKTA strängar; '
      + 'varje NY sågtand/oscillation fäller korpusen med full styrka. '
      + 'GOLDEN OMLÅST (2026-08-06, B3 gästhamnskapseln): PILGRIM (211110880) '
      + 'anlände i 6 kn, förtöjde i gästhamnen (sog 0,1 i kapseln 13:20–13:45 '
      + 'den 14:e) men behöll måltexten — "En båt på väg mot Stridsbergsbron, '
      + 'om 13 min" som FÖRTÖJD är exakt fantomklassen från both-dygn 1 '
      + '(ANDREA/CARAT). Med kapseln demoteras hon och Strids-klausulen försvinner '
      + 'ur texterna kring 13:30–13:39. Notis-/fördelnings-/riktningsfacit ORÖRDA '
      + '(164/164).'
      + 'GOLDEN OMLÅST (2026-08-09, C0b zon-lokal kögrace): 269 → 267 övergångar. Klaffbron-klausulen försvinner ur elva texter 12:07–12:27 för en båt som låg still i gästhamnen; Stridsbergs-klausulen är ORÖRD i varje rad, vilket visar att ingreppet är zon-lokalt och inte rör den äkta trafiken. Notis-/fördelnings-/riktnings-/öppningsfacit ORÖRDA (164/164). '
      + 'GOLDEN OMLÅST 267→265 (2026-08-10, P9 kajliggarlivscykeln). '
      + 'HELA DIFFEN mot 5799b7a, LCS + multiset (F7 2026-08-10). '
      + 'RÄTTELSE AV DENNA NOTS EGEN TIDIGARE UPPGIFT: den sade "ETA-värdeskift '
      + '(Stridsbergsserien 14/9/8→6, Klaffbron 7→6)". STRIDSBERGSVÄRDENA ÄR '
      + 'BYTE-IDENTISKA i gammal och ny golden (8 på 08:48:47.271, 14 på '
      + '08:48:51.405, 9 på 08:50:22.118) — noten påstod en ändring som inte '
      + 'skedde, och det är just de värdena knownInvariantExceptions-strängarna '
      + 'nedan hänger på. Det ENDA ändrade ETA-värdet är Klaffbron 7 → 6 minuter '
      + 'på samma tre rader. '
      + 'BORT 2 RADER (utöver de tre värdeändrade ovan): (a) 11:09:34.672 "En båt '
      + '… Klaffbron strax; En båt … Stridsbergsbron, ETA okänd", livstid 2,4 s '
      + '— äkta flimmerrad, föregående rad lever 46,5 s i st.f. 44,1 s; '
      + '(b) 08:48:47.246 "En båt … Klaffbron om cirka 2 minuter; Tre båtar … '
      + 'Stridsbergsbron om 8 minuter", livstid 0,025 s (25 ms) — också flimmer. '
      + 'TILLAGT: 0 nya rader (LCS bokför 5 borttagna / 3 tillagda, men 3 + 3 av '
      + 'dem är SAMMA rader med Klaffbronvärdet 7 → 6). '
      + 'INNEHÅLLSDIFF vid identisk tidsstämpel: 3 (de tre 7 → 6 ovan, '
      + 'livstider 4,1 / 90,7 / 147,9 s). '
      + 'TIDSSKIFT: 39 rader, varav 22 med ≥ 1 s (16 senare / 6 tidigare) och 17 '
      + 'under 1 s. Extremer: +30,1 s (12:42:22.251 → 12:42:52.301), −30,0 s '
      + '(11:58:16.861 → 11:57:46.826), −26,2 s (06:36:49.136 → 06:36:22.905), '
      + '+15,4 / +15,1 / +15,0 / +14,7 / −14,6 / −14,5 s. '
      + 'PRISET: 2 senarelagda "Inga båtar"-övergångar, 11:11:35.151 → '
      + '11:11:50.559 (+15,4 s) och 10:29:49.612 → 10:29:50.559 (+0,9 s), mot 1 '
      + 'tidigarelagd, 15:41:18.104 → 15:41:03.584 (−14,5 s); 13 övergångar i '
      + 'båda versionerna. Rotorsak till både värdeskiftet och tidsskiften: '
      + 'kajliggarna slutade churna, så ETA-motorn får kontinuerligt underlag.',
    knownInvariantExceptions: [
      'ETA-SÅGTAND UPP: 2026-07-15T08:48:51.405Z Stridsbergsbron 8→14',
      'ETA-OSCILLATION: 2026-07-15T08:50:22.118Z Stridsbergsbron 8→14→9',
    ],
  },
  {
    id: '20260804-17h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-20260804-17h-dag.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260804-024200.log'),
    hours: 17,
    locked: true,
    expectedNotifications: 116,
    note: 'KORPUS #16 — A/B-dagskörningen 2026-08-04, A-ARMEN (enbart aisstream), '
      + '682 sampel / 17,0 h. Det är körningen som fällde GO-BESLUTET för '
      + 'source=both (docs/ab2-dagskorningen-GO-2026-08-04.md): alla P1–P4 '
      + 'uppfyllda, P1 11/0 med p=9,8e-4 över 13 varianter. LÅST 116 (2026-08-08, '
      + 'etapp 7 A9b) = FÄLTET EXAKT: 116 notiser med BYTE-IDENTISKT '
      + '(mmsi,bro)-multiset mot field-facit/20260804-17h/field-notif.txt, och '
      + '40 öppningsvarningar mot fältets 40 [OPENING_TRIGGER_SUCCESS] '
      + '(app-20260804-024200.log). Ingen diff mot prod = inget att '
      + 'rådataverifiera; facit ÄR fältutfallet. '
      + 'VÄRDE: första korpusen från etapp 6-eran där bridge_opening_soon var '
      + 'AKTIV i drift — de 249 öppningsvarningarna i den gamla basen är '
      + 'retro-replayade på för-etapp-6-data, dessa 40 avfyrades på riktigt. '
      + 'Fältfacit (notiser/texter/öppningar) i field-facit/20260804-17h/; '
      + 'rådatafacit i gt-passages/20260804-17h.json (93 korsningar, 19 inferred). '
      + 'Källa: aisstream-eran ⇒ inget pollEraMinutes. '
      + 'KÄNT INVARIANTUTSLAG (1 st, rådataverifierat — SANKTIONERAT DESIGNVAL): '
      + 'INV-2 NOTIS-DUBBLETT 265576720@Kanalinfarten. Detta är F-17-klassen som '
      + 'ANVÄNDARBESLUT U5 (2026-08-08) uttryckligen behåller: ankomstnotis + '
      + 'passagenotis vid lång väntetid är TVÅ händelser, inte en dubblett. '
      + 'Rådata (ais-20260804-17h-dag.jsonl): 13:28:19.388Z 293 m från punkten i '
      + '1,9 kn cog 72,6 = ankomsten (riktning ännu unknown); därefter FÖRTÖJD '
      + '13:36–15:41 på 132–159 m (sog 0, navStatus 5 från 13:47) — 2 h 5 min; '
      + 'sedan 15:45:08.689Z 20 m i 4,1 kn cog 18,1 = utfarten norrut, följd av '
      + 'hela nordtransiten (Olide→Klaff→Jvb→Strids→Stallbacka). Två fysiskt '
      + 'skilda händelser åtskilda av två timmars förtöjning. Utslaget är '
      + 'PERMANENT så länge U5 står fast.'
      + 'GOLDEN OMLÅST (2026-08-09, C0b zon-lokal kögrace): 190 → 188 övergångar — korpusens STÖRSTA enskilda spöktextvinst, 25 minuter. Rådataverifierat: PILLE (211488730) låg sog=0 med **navStatus=null** 14–15 m från gästhamnskapselns linje vid 12:33:08, 12:36:08 och 12:42:11. Utan navStatus biter den vanliga förtöjningsdetekteringen inte, och det gamla 600 m-köundantaget krävde 15 min stillhet — hon hann bara 9 min innan hon slutade sända. Följd: "En båt på väg mot Klaffbron, om 10 minuter" stod 12:42:11 → "ETA okänd" 12:52:37 → borta först 13:07:37. Med queueGraceMs=0 demoteras hon 12:42:41. Fallet är samtidigt belägg för att C9 (förtöjd utan navStatus) behövs: 76 % av fältprovets fartyg saknade navStatus helt. Notis-/fördelnings-/riktnings-/öppningsfacit ORÖRDA (116/116). '
      + 'GOLDEN OMLÅST 188→190 (2026-08-10, P9 kajliggarlivscykeln). '
      + 'HUVUDPOSTEN ÄR EN ÄKTA FÖRBÄTTRING: JUNO/265576720:s avgång norrut får '
      + 'första textrad 15:45:08 ("om 16 minuter") i st.f. 15:48:10 ("om 8"): '
      + '+3 min förvarning. Rådataverifierad i korpusens jsonl (still sog 0–0,5 '
      + '@58.2655 → avgång, sista fix 58.3134 i 8,6 kn); baslinjen '
      + 'FAR_DISTANCE-raderade henne i 3 min 20 s-glappet och kajvobbelvakten '
      + 'höll tillbaka målbron efter återfödelsen — med förtöjningsgrenen '
      + 'överlever hon glappet. '
      + 'HELA DIFFEN mot 5799b7a, LCS + multiset (F7 2026-08-10 — den '
      + 'ursprungliga noten dokumenterade ENBART JUNO): '
      + 'TILLAGT 4 RADER, alla i JUNO-fönstret: 15:45:08.714 (64,4 s), '
      + '15:46:13.161 (69,8 s), 15:47:22.927 (47,1 s), 15:48:10.028 (39,0 s). '
      + 'BORT 2 RADER: (a) 15:46:13.161 "En båt på väg mot Stridsbergsbron, '
      + 'beräknad broöppning strax" (116,9 s) — ERSATT på samma tidsstämpel av '
      + 'samma text med JUNO-klausulen tillagd först, dvs. del av förbättringen; '
      + '(b) 16:09:37.374 "Två båtar på väg mot Stridsbergsbron, beräknad '
      + 'broöppning om cirka 6 minuter", livstid 26,9 s — DEN HÄR var helt '
      + 'odokumenterad. Följd: föregående rad 16:04:47.555 "… om 6 minuter" '
      + '(utan "cirka") står 5 min 17 s i st.f. 4 min 50 s, alltså uteblir '
      + 'osäkerhetsmarkören i 26,9 s medan minutvärdet är detsamma. Kosmetisk '
      + 'men INTE en ren vinst — redovisas här i stället för att tigas ihjäl. '
      + 'INNEHÅLLSDIFF vid identisk tidsstämpel: 2 (15:46:13.161 enligt ovan; '
      + '15:48:10.028 "om 8 minuter" → "om 9 minuter"). '
      + 'TIDSSKIFT: 21 rader, varav 12 med ≥ 1 s (3 senare / 9 tidigare — den '
      + 'korpus där tidigareläggningarna dominerar tydligast; 20260712-25h är '
      + 'den enda andra med övervikt, 6/7) och 9 under 1 s. '
      + 'Extremer: +39,0 s (15:48:10.028 → 15:48:48.986, JUNO-fönstrets kant), '
      + '−30,0 s × 2 (15:01:43.404 → 15:01:13.359 och 10:17:37.374 → '
      + '10:17:07.374), +24,3 s, −21,4 s, −15,9 s, +15,8 s. '
      + 'PRISET: 1 senarelagd "Inga båtar"-övergång, 17:43:28.829 → .834 '
      + '(+5 ms, försumbar); 9 övergångar i båda versionerna.',
    knownInvariantExceptions: [
      'NOTIS-DUBBLETT: 265576720:Kanalinfarten × 2 utan journey-reset emellan',
    ],
  },
  {
    id: '20260804-both-21h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-20260804-both-21h.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260804-224222.log'),
    hours: 21,
    locked: true,
    lockOpenings: false,
    expectedNotifications: 152,
    note: 'KORPUS #17 — BÅDE-DYGN 1 (2026-08-04/05, source=both), 2 748 sampel / '
      + '21,2 h: 691 aisstream + 2 057 ÄKTA AISHub-poster. Enda korpusen med '
      + 'BÅDA källorna live i samma inspelning (fusionskorpusarna är syntetiska '
      + 'ekon). Redundansen bar ett 4,5 h äkta aisstream-avbrott — två transiter '
      + 'gick fram på AISHub ensam. Se docs/both-dygn1-2026-08-05.md. '
      + 'LÅST 152 (2026-08-08, etapp 7 A9b): fältet sände 153, replayen ger 152, '
      + 'och multiset-diffen är EXAKT EN post — 265662320|Klaffbron. '
      + 'DEN 153:e ÄR EN VARMSTARTSDELTA, INTE EN MISS, och appens egen logg '
      + 'bevisar det: 22:44:30.026Z `[FALLBACK_BOAT_NEAR] 265662320: Passage of '
      + 'Klaffbron detected without prior proximity trigger (distance=409m)`, '
      + 'avfyrad 2 min 8 s efter appstart på JEANNELLEs ALLRA FÖRSTA sampel '
      + '(22:44:30.011Z, sog 0, förtöjd i gästhamnen 409 m från bron). Två rader '
      + 'ovanför står varifrån slutsatsen kom: `[PERSISTENT_DEDUP_SAME_DIR_LATE] '
      + '265662320:Kanalinfarten: entry 327 min old` — appen bar PERSISTERAT '
      + 'tillstånd från 5,5 h FÖRE inspelningens början. Replayen startar från '
      + 'kall cache och kan per konstruktion inte återskapa ett förflutet den '
      + 'aldrig såg. Samma klass som ELFKUNGENs omstarts-dedup i 20260702-2h, '
      + 'med omvänt tecken. (Notisen är dessutom `passage-inferred` på 409 m — '
      + 'C13/U7:s klass.) '
      + 'lockOpenings: false — CARAT-FANTOMERNA får INTE förevigas som '
      + 'öppningsfacit. 211452170/CARAT låg i praktiken stilla hela natten '
      + '(70 sampel, sog median 0,7 / max 7,4) och FÄLTET varnade för henne TRE '
      + 'gånger: Stridsbergsbron#5 00:19:14 (eta=33 min), Stridsbergsbron#8 '
      + '01:34:35 (eta=75 min) och Klaffbron#9 03:52:55 (eta=26 min) — alla tre '
      + 'beväpnade med en deadline SOM REDAN PASSERAT (`deadline om −72 s`, '
      + '`−87 s`, `−157 s`; M1-/D8-klassen) på en båt i 0,4–1,6 kn. '
      + 'ÖPPNINGSDIMENSIONEN ÄR DESSUTOM DEN ENDA SOM INTE ÄR FÄLTIDENTISK: '
      + 'replayen ger 34 av fältets 35 varningar, och den enda som saknas är '
      + 'just CARAT@Stridsbergsbron 01:34:35 (dubbelvarningen). Att låsa '
      + 'multiseten nu vore att skriva in två fantomer OCH ett utfall som '
      + 'skiljer sig från fältet. Öppningsdimensionen låses när C8 landat: ta '
      + 'bort flaggan och kör REGEN_DISTRIBUTIONS=1. Alla ÖVRIGA fyra '
      + 'dimensioner är låsta som vanligt. '
      + 'OBS: den ursprungliga planformuleringen "CARAT-fantomvarningen '
      + '05:18:31" är INTE verifierbar — det finns ingen öppningsvarning alls '
      + 'i fältloggen mellan 04:42 och 06:42. Tidsstämpeln är rättad ovan mot '
      + 'field-facit/20260804-both-21h/field-openings.txt. '
      + 'Fältfacit i field-facit/20260804-both-21h/ (field-texts REGENERERAD ur '
      + '[UI_UPDATE]-raderna, A8(i) — den levererade extraktionen tappade '
      + 'fallback-klassen "3 båtar är i närheten av…", 318 → 321 rader; metoden '
      + 'står i field-facit/README.md). Rådatafacit i '
      + 'gt-passages/20260804-both-21h.json (144 korsningar, 16 inferred). '
      + 'AISHub-benet tillhör 10-minuterseran (interval=10) — men korpusen är '
      + 'BLANDAD, så pollEraMinutes sätts inte; #18 är erans referenspunkt. '
      + '── SEX KÄNDA INVARIANTUTSLAG, alla rådataverifierade 2026-08-08. TVÅ '
      + 'KLASSER, och skillnaden är avgörande: '
      + '[A] SANKTIONERAT DESIGNVAL — permanent tills beslutet ändras: '
      + '(1) INV-2 NOTIS-DUBBLETT 219031446@Stridsbergsbron = F-17/U5-klassen. '
      + 'Rådata: ankomst 01:04:08.700Z på 290 m i 1,5 kn (notis 1) → STILLASTÅENDE '
      + 'på 143–149 m från bron 01:08:39–03:17:34 (sog 0 i 2 h 9 min, brokö) → '
      + 'notis 2 03:19:05.996Z på 63 m → passage 03:20:11.437Z. Ankomstnotisen är '
      + 'förvarningen, passagenotisen bekräftelsen. '
      + '(2) INV-10 STRAX-ZOMBIE 01:59:48.635Z (69 min) = SAMMA fartyg och SAMMA '
      + 'väntan. ANVÄNDARBESLUT U6 (2026-08-08): "strax" behålls oförändrat även '
      + 'vid lång kö — texten är sakligt sann (båten står vid bron och väntar på '
      + 'öppning) och felvisningstiden klassas som sanktionerad, inte som defekt. '
      + '(3) INV-3 ETA-SÅGTAND 09:56:02.055Z Klaffbron 12→21 (FÖRE P9 2026-08-10: '
      + '12→27; P9 SÄNKTE alltså toppen — formuleringen "t.o.m. P9" i denna not '
      + 'lästes som motsatsen och är rättad av F7 2026-08-10) = NORDIC SOLA-klassen '
      + '(samma prejudikat som 20260713-41h). Rådata: Klaffbron-gruppens båtar låg '
      + '880–1 041 m ut i 0,2–0,4 kn (LA FEMME 09:55:31 sog 0,3 @984 m; YOLO 2 '
      + '09:54:00 sog 0,2 @1010 m; DIONE 09:57:39 sog 0,2 @1041 m) — en progressiv '
      + 'ETA på nästan noll fart växer ÄRLIGT. Textbaserat oskiljbar från '
      + 'SOKERI-signaturen, därav utslaget. '
      + '[B] ÖPPEN DEFEKT — TILLFÄLLIGA undantag som SKA tas bort när fixen landar '
      + '(de förevigar INGET beteende: strängarna är tidsstämpelexakta och tystar '
      + 'exakt tre händelser; varje NYTT utslag fäller korpusen med full styrka): '
      + '(4+5) COUNT-DEGRADERING 08:27:26.096Z och 08:28:26.908Z — texten '
      + '"3 båtar är i närheten av Stridsbergsbron" är `_generateSafeFallbackText` '
      + 'inklämd mellan "Fyra båtar … strax" och "Tre båtar … strax". Rotorsak: '
      + 'C1(c) ([err]-kedjan, fallback vid renderable=0). Tas bort av C1. '
      + '(6) INV-14 DEFAULT-FLASH 04:40:11.113Z — "Inga båtar" i 140 s mellan två '
      + '"En båt på väg mot Klaffbron"-texter utan mellanliggande passage. '
      + 'Rotorsak: C1. Tas bort av C1. '
      + '── GOLDEN-TEXT OMLÅST 2026-08-09 (etapp 7 fas C, C4b — riktningslåset). '
      + 'ENDA ändrade dimensionen: 325 → 324 övergångar. Notis- (152), '
      + 'riktnings-, fördelnings- och öppningsfacit (34) är BYTE-IDENTISKA, och '
      + 'de 13 → 12 ändrade raderna ligger alla i ETT fönster, '
      + '05:01:30–05:28:39, för ETT fartyg: 211452170 CARAT. '
      + 'MOTIV: C4b lät ACCELERATED-grenens riktningslås ärva F4-J:s bevisregel '
      + '(skriv bara om `_routeDirection` från COG vid sog ≥ 2,0 kn). Grinden '
      + 'fyrade exakt TVÅ gånger i hela korpusen — båda för CARAT (0,4 resp. '
      + '0,7 kn). RÅDATAVERIFIERING (ais-20260804-both-21h.jsonl): CARAT låg '
      + 'still i gästhamnen 384–435 m NORR om Klaffbron från 00:04:32 till '
      + '06:48:58 (70 sampel, sog 0–1,6 utom TRE utslag (7,4 / 2,7 / 2,1 kn — två av dem ÖVER C4b:s egen tröskel 2,0), COG-vobbel '
      + '12,1°–358,1° i ett ~45 m (N–S) × ~62 m (Ö–V)-fönster) och avgick sedan SÖDERUT genom '
      + 'Klaffbron: 06:53:35 lat 58.28309 (redan söder om brons 58.28410, sog '
      + '3,7 cog 186), därefter fallande latitud (fem GPS-jitterreverseringar på 1–10 m efter 07:11, då hon redan låg 2,5 km söder om bron) 58.28203 → 58.27428 '
      + '→ 58.26517 fram till 07:28:45. Hon var ALDRIG på väg mot '
      + 'Stridsbergsbron — avståndet dit växte från 820 m till 3 739 m. '
      + 'Gamla goldens "på väg mot Stridsbergsbron, om 76/99/70/…/37 minuter" '
      + 'pekade alltså ut fel bro OCH fel riktning; nya "på väg mot Klaffbron" '
      + 'pekar ut den bro hon faktiskt använde. '
      + 'ORSAKSKEDJAN i klartext (verbose replay, REPLAY_DEBUG_LEVEL=full): vid '
      + '04:42:30 loggar appen `[TARGET_ASSIGNMENT] 211452170: COG-riktning '
      + 'north motsäger låst ruttriktning south utan rörelsebevis (0.4 kn < '
      + '2.0) — följer låset` och väljer Klaffbron — men den gamla raden i '
      + 'ACCELERATED-grenen skrev DÄREFTER om låset till north från exakt den '
      + 'förkastade COG:n. Vid nästa tilldelning (05:01:30, 0,7 kn, cog 17,8°) '
      + 'fanns därför ingen motsägelse kvar att upptäcka: F4-J tystnade och '
      + 'appen valde "Norrut, mellan broarna → Stridsbergsbron", 820 m bort. '
      + 'Buggen förstörde alltså det lås F4-J skyddar och avväpnade sig själv '
      + 'till nästa sampel. Med C4b står låset kvar och F4-J fyrar igen '
      + '(`[ROUTE_LOCK_KEEP]` + `Söderut, mellan broarna → Klaffbron`). '
      + 'RESTPOST (INTE C4b:s klass): texten är spöktext i BÅDA versionerna — '
      + 'CARAT stod stilla och avgick först 85 min senare. Att den nya '
      + 'sekvensen slutar i "strax" är samma B3/C0b-klass (gästhamnskajen) och '
      + 'ägs av C11/C11b; utslaget varade 51 s och fällde ingen invariant. '
      + 'VARNING TILL FRAMTIDA GRANSKARE: när C1/C2 landar ÄNDRAS golden-texten '
      + 'här ändå (REGEN krävs) — passa då på att RENSA de undantag som blivit '
      + 'döda. Ett dött undantag är inte farligt men det ljuger om nuläget. '
      + '── GOLDEN-TEXT OMLÅST 2026-08-09 (etapp 7 fas C etapp III, C1b — '
      + 'validatorns under-bridge-gräns). ANTALET ÖVERGÅNGAR ÄR OFÖRÄNDRAT '
      + '(324); notis- (152), fördelnings-, riktnings- och öppningsfacit (34) '
      + 'är BYTE-IDENTISKA. (Detta gällde C1b mätt ENSAMT — i det levererade '
      + 'etapp C-III-trädet ändras ÄVEN 20260601-41h, 164→166 övergångar av '
      + 'C1d; se den korpusens egen not.) '
      + 'FYRA radpositioner (163–166) i ETT fönster, 08:27:26–08:28:35, byts: '
      + '[163] "3 båtar är i närheten av Stridsbergsbron" → "Tre båtar på väg '
      + 'mot Stridsbergsbron, beräknad broöppning strax"; raden 08:27:56.154Z '
      + 'försvinner (samma text som 163 ⇒ ingen övergång) och en NY korrekt '
      + 'rad 08:28:35.485Z "En båt … strax" tillkommer i andra änden. '
      + 'MOTIV: `_validateStatusConsistency` dömde appens EGEN '
      + 'BRIDGE_OPENING-hållning som inkonsistens. Hållningen '
      + '(StatusService: "Holding under-bridge state for …") behåller MEDVETET '
      + 'status under-bridge tills båten är >PROTECTION_ZONE_RADIUS (300 m) '
      + 'bort, men validatorns hårdkodade tak var 100 m. '
      + 'RÅDATAVERIFIERING per post (ais-20260804-both-21h.jsonl; OBS 08:27:26.096 '
      + 'är UI-/goldenstämpeln — ANYA ELANs sampel är .094 och JEANNELLEs .645 '
      + '— övriga stämplar är sampelns egna): vid 08:27:26.096 var 265705550 ANYA ELAN 380 på '
      + 'lat 58.29531/lon 12.29751 = 263 m från Stridsbergsbron (hon var 66 m '
      + 'söder om bron 08:26:16 och passerade alltså precis) med aktiv '
      + '30-sekundershållning — 263 < 300, dvs. exakt det hållningen tillåter. '
      + 'De ÖVRIGA tre båtarna i texten var samtidigt 211347380 ANTJE 44 m '
      + '(08:27:13.696), 265788210 EUGENIE 21 m (08:27:25.946) och 265662320 '
      + 'JEANNELLE 306 m på väg in (08:27:25.644, sog 5,9 cog 36,4) ⇒ "Tre '
      + 'båtar på väg mot Stridsbergsbron, beräknad broöppning strax" är '
      + 'SAKLIGT SANN, och den var textmotorns egen utdata. Den gamla raden '
      + 'var `_generateSafeFallbackText`:s beskrivande gren — samma antal (3) '
      + 'men utan bro-öppningsinformationen. Den nya raden 08:28:35.485Z "En '
      + 'båt … strax" är också verifierad: då var EUGENIE 250 m norr om bron '
      + '(passerad), ANTJE 103 m norr (passerad) och endast JEANNELLE 44 m NORR om '
      + 'brolinjen (nyss passerad) vid '
      + 'bron på 44 m. Gamla golden hoppade över det tillståndet. '
      + 'MÄTT VERKAN: degraderingstiden i fönstret går 38,4 s → 0,36 s. '
      + 'INVARIANTUNDANTAG: de två COUNT-DEGRADERING-strängarna (08:27:26.096Z '
      + '"69s" och 08:28:26.908Z "39s") är DÖDA och borttagna; kvar är EN, '
      + '08:28:34.886Z. RÄTTELSE AV DENNA NOTS EGEN TIDIGARE UPPGIFT: '
      + 'rotorsaken angavs som "C1(c) (fallback vid renderable=0)" — det är '
      + 'FEL. Mätning över samtliga 18 korpusar visar att renderable=0-grenen '
      + 'i `_generateSafeFallbackText` nås NOLL gånger; här var renderable=3 '
      + '(därav "3 båtar"), och det som fällde texten var CHECK 2 '
      + '(status-inkonsistens), inte count-checken. Punkt (6) i listan ovan, '
      + 'DEFAULT-FLASH 04:40:11.113Z, är av samma skäl INTE C1:s klass: den '
      + 'kommer från removal-vägens forcerade DEFAULT ("FORCED bridge text '
      + 'update to default"), inte från valideringskedjan, och står kvar. '
      + 'C1a ([err]-kedjans hold-replay) rörde INGEN text i någon korpus — den '
      + 'tog bort 12 no-op-larmpar (24 loggrader) i just den här korpusen och '
      + '0 i övriga 17. C2 (ETA-clampens släppgrind) rörde ingen text alls; '
      + 'dess enda mätbara effekt i hela regressionskorpusen är notistokenen '
      + 'eta_minutes för 265788210 EUGENIE @Stridsbergsbron 21 m, 0 → 2 min '
      + '(faktisk passage 1,2 min senare) — notisens (mmsi,bro,riktning) och '
      + 'antalet är oförändrade och därmed är fördelningsfacit orört. '
      + '── GOLDEN OMLÅST 324→325 (2026-08-10, P9 kajliggarlivscykeln). '
      + 'HELA DIFFEN mot 5799b7a, LCS + multiset (F7 2026-08-10 — den '
      + 'ursprungliga noten nämnde bara raden 00:44:02 och Klaffbronserien '
      + '09:52–10:00, dvs. en bråkdel — detta är den STÖRSTA P9-diffen av alla '
      + 'arton korpusar). '
      + 'BORT 7 RADER: (1) 00:44:02.111 "En båt … Klaffbron om 10 minuter; En båt '
      + '… Stridsbergsbron, ETA okänd" (21,2 s) — Stridsbergsklausulen släpps '
      + 'direkt i stället, dvs. 21,2 s mindre spöktext; (2) 07:02:39.215 (135,4 s, '
      + 'se 07:00-serien nedan); (3) 09:54:00.511 "Två båtar … Klaffbron om cirka '
      + '6 minuter; En båt … Stridsbergsbron, ETA okänd" (13,5 s); (4) '
      + '09:56:02.055 "Tre båtar … Klaffbron om 27 minuter" (340,5 s); (5) '
      + '10:01:42.567 "… om 39 minuter" (100,2 s); (6) 10:09:01.527 "Fyra båtar … '
      + 'om 5 minuter" (68,2 s); (7) 14:44:19.054 "En båt … Stridsbergsbron om 14 '
      + 'minuter" (30,2 s) — ODOKUMENTERAD tidigare: den raden var nedräkningen '
      + '2 → 1 båtar, så nu står 14:43:13.895 "Två båtar … om 14 minuter" i '
      + '95,3 s i st.f. 65,2 s. Samma klass som de senarelagda "Inga båtar"-'
      + 'övergångarna: ett fartyg lever 30 s längre och räknas därför med. '
      + 'TILLAGT 8 RADER: 07:00:22.556 (69,6 s), 07:01:32.203 (67,0 s), '
      + '07:02:39.215 (65,3 s) — 07:00-serien nedan; 08:54:30.851 "Två båtar … '
      + 'Klaffbron om 6 minuter; Tre båtar … Stridsbergsbron om 5 minuter" '
      + '(0,150 s) = NY flimmerrad, odokumenterad tidigare; 09:56:02.055 "om 21 '
      + 'minuter", 10:01:42.567 "om 32 minuter", 10:09:01.527 "om 3 minuter" '
      + '(värdeskiften); samt 10:15:46.395 "Fem båtar på väg mot Klaffbron, '
      + 'beräknad broöppning strax" (30,2 s) — också odokumenterad: en FEMTE båt '
      + 'räknas i 30 s innan texten går tillbaka till fyra. Spegelbilden av post '
      + '(7): P9 håller fartyg vid liv, alltså blir räkneverket högre längre. '
      + 'INNEHÅLLSDIFF vid identisk tidsstämpel: 5 — 07:01:32.203 "om 9" → "om '
      + '16", 07:02:39.215 "om 8" → "om 11", 09:56:02.055 "om 27" → "om 21", '
      + '10:01:42.567 "om 39" → "om 32", 10:09:01.527 "om 5" → "om 3". De tre '
      + 'sista är genomgående LÄGRE värden, dvs. mindre överslag i den kända '
      + 'köfartsöverskattningen (jfr knownInvariantExceptions-strängen 12→21, '
      + 'som före P9 var 12→27). De TVÅ första (07-fönstret) går åt motsatt '
      + 'håll och utreds nedan. '
      + 'TIDSSKIFT: 46 rader, varav 25 med ≥ 1 s (20 senare / 5 tidigare) och 21 '
      + 'under 1 s. Extremer: +132,3 s (07:01:32.203 → 07:03:44.524, "om 9 '
      + 'minuter" — 07:00-serien nedan), −69,7 s (10:09:01.377 → 10:07:51.660: '
      + 'raden "Fyra båtar … om 6 minuter" flyttar från ett 150 ms-flimmer i '
      + 'slutet av nedräkningen till ett 150 ms-flimmer i början av den), '
      + '+30,2 / +30,1 / −30,1 / −30,0 / +24,1 s. '
      + 'PRISET: 3 senarelagda "Inga båtar"-övergångar, 28,2 s totalt — '
      + '00:10:34.510 → 00:10:48.635 (+14,1 s), 05:43:34.535 → 05:43:48.635 '
      + '(+14,1 s) och 03:08:55.185 → .195 (+10 ms); 12 övergångar i båda '
      + 'versionerna, 0 tidigarelagda. '
      + '── 07:00–07:03-SERIEN, RÅDATAUTREDD (F7 2026-08-10). Detta är den '
      + 'enskilt största innehållsändringen i P9-omlåsningen och den saknades '
      + 'helt i noterna. Fartyget är 265705550 ANYA ELAN 380. '
      + 'RÅDATA ur ais-20260804-both-21h.jsonl (avstånd = haversine till '
      + 'klaffbron i lib/constants.js): 06:48:58,5 / 06:50:08,4 / 06:53:34,9 med '
      + 'sog 0 vid kaj 2 168–2 173 m från Klaffbron; 06:56:58,9 sog 0,7 '
      + '(2 163 m); DÄREFTER ETT SAMPELGLAPP PÅ 203,7 s; 07:00:22,5 sog 2,9 '
      + 'cog 35 (2 050 m) = avgångsögonblicket; 07:01:32,2 sog 6,5 (1 791 m); '
      + '07:02:39,2 sog 7,0 (1 572 m); 07:03:44,5 sog 3,7 (1 358 m); framme vid '
      + 'bron 07:11:00,5 på 95 m i 0,2 kn (sedan kö strax söder om bron till '
      + 'efter 07:12:48,9; norr om bron först 07:20:43,7). '
      + 'GAMLA serien 9 → 8 → 7 började 07:01:32 och var nästan perfekt (första '
      + 'prognosen pekade på 07:10:32 mot verklig ankomst 07:11:00 = 28 s fel). '
      + 'MEN den fanns bara därför att FAR_DISTANCE-churnen RÅKADE radera henne '
      + 'vid kajen: >600 m från bro ⇒ 120 s livslängd (TIMEOUT_SETTINGS), och '
      + 'glappet var 203,7 s, så raderingen var garanterad, inte stokastisk. Hon '
      + 'återföddes 07:00:22 utan historik, texten uteblev tills farten var '
      + 'etablerad vid nästa sampel, och ETA:n räknades då på det momentana '
      + '6,5-knopsvärdet. Precisionen var alltså en BIPRODUKT av en bugg. '
      + 'NYA serien 23 → 16 → 11 → 9 → 7 börjar 07:00:22,6 — 69,6 s TIDIGARE och '
      + 'i själva avgångsögonblicket (sog 2,9) — och första värdet är ~12 min '
      + 'FÖR HÖGT (prognos 07:23:22 mot ankomst 07:11:00) därför att ETA:n då '
      + 'räknas på igångsättningsfarten. P9 EXPONERAR alltså en LATENT '
      + 'ETA-svaghet (avgångs-ETA på låg fart) som churnen tidigare maskerade '
      + 'genom att radera fartyget; P9 skapade den inte. '
      + 'Serien är monotont konvergerande (23 → 16 → 11 → 9 → 7 → 6 → 4 → '
      + '"strax"), alltså INGEN INV-3-sågtand och inget invariantutslag. '
      + 'NETTOBEDÖMNING: 70 s tidigare förvarning till priset av en överskattad '
      + 'första-ETA. ACCEPTERAD med denna dokumentation. Ska ETA-svagheten '
      + 'åtgärdas är rätt ställe en fart-/etableringsgrind uppströms '
      + 'ETA-motorn — inte kajliggarlivscykeln, som bara gjorde den synlig.',
    knownInvariantExceptions: [
      'NOTIS-DUBBLETT: 219031446:Stridsbergsbron × 2 utan journey-reset emellan',
      // P9-omlåsningen (2026-08-10): kajliggarlivscykeln (gravvård + moored-
      // timeout) ger ETA-serien kontinuerligt underlag — sågtanden är SAMMA
      // sanktionerade NORDIC SOLA-händelse men toppen sjönk 27 → 21 (mindre
      // överslag). Strängen är värdeexakt, därav uppdateringen.
      'ETA-SÅGTAND UPP: 2026-08-05T09:56:02.055Z Klaffbron 12→21 på 30s',
      // C1b (2026-08-09): de TVÅ gamla strängarna (08:27:26.096Z/69s och
      // 08:28:26.908Z/39s) är DÖDA och borttagna. Kvar är EN degradering,
      // 08:28:34.886Z, som varar 0,36 s i den publicerade strömmen (INV-4:s
      // "69s" är grannspannet t[i+1]−t[i−1], inte textens egen varaktighet).
      'COUNT-DEGRADERING: 2026-08-05T08:28:34.886Z "3 båtar är i närheten av Stridsbergsbron" inklämd (69s)',
      'DEFAULT-FLASH: 2026-08-05T04:40:11.113Z "Inga båtar" inklämd (140s) mellan två "En … Klaffbron"-texter utan passage',
      'STRAX-ZOMBIE: 2026-08-05T01:59:48.635Z "En båt på väg mot Stridsbergsbron, beräknad broöppning strax" stod 69 min utan Stridsbergsbron-passage',
    ],
  },
  {
    id: '20260806-42h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-20260806-42h.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260806-005440.log'),
    hours: 42,
    locked: false,
    lockOpenings: false,
    pollEraMinutes: 10,
    expectedNotifications: 135,
    note: 'KORPUS #18 — 42h-FÄLTPROVET 2026-08-06/07 (AISHub ENSAM; aisstream var '
      + 'tyst hela körningen), 3 922 sampel / 41,8 h. Se '
      + 'FALTRAPPORT-42h-2026-08-08.md. '
      + 'MEDVETET OLÅST — DIRIGENTBESLUT 2026-08-08. Motiveringen i sin helhet: '
      + '(a) FÖRSTA korpusen med `feed`-fältet och AISHubs pollsnapshots. De 15 '
      + 'gamla låsta är ALLA från aisstream-eran, så ingen av dem prövar den '
      + 'ström appen numera faktiskt körs på; kadensen är 2,6× tätare '
      + '(per-fartygs-gap p50 139 s mot 360 s i 20260713-41h). '
      + '(b) TROHETEN ÄR DEN HÖGSTA HITTILLS: 135/135 notiser med BYTE-IDENTISKT '
      + '(mmsi,bro)-multiset mot field-facit/20260806-42h/field-notif.txt och '
      + '36/36 öppningar mot fältets 36 avfyrningar VID INSPELNINGEN. ⚠️ UPPDATERAT 2026-08-09: koden ger sedan C4b (36567f0) **35** öppningsvarningar och **134** notiser. Öppningsdeltat 36→35 är samma rot som notisdeltat 135→134 i punkt (g) — C4b tog bort MARY-fantomen Stridsbergsbron#31, en varning för en bro hon passerat 108 min tidigare. Punkt (g) dokumenterade notisdeltat men glömde öppningsdeltat i samma commit. Båda reconcilieras när #18 låses skarpt; replayen är deterministisk '
      + '(verifierad byte-identisk vid omkörning). Datat duger alltså — det är '
      + 'inte kvaliteten som hindrar låsning. '
      + '(c) MEN SEX FATALA INVARIANTBROTT (INV-2 ×2, INV-3, INV-10, INV-14, '
      + 'INV-13) vars rotorsaker är ÖPPNA DEFEKTER: INV-13 ligger nedströms D1 '
      + '(F-14, 2h-backstoppen bokför en målbropassage som mellanbro) och '
      + 'INV-2-dubbletterna är F-17. Låses posten NU fäller de runAllCorpora, och '
      + 'A8(iv):s REGEN-vakt skriver då inte facit för NÅGON korpus ⇒ hela '
      + 'omlåsningsvägen slås ut mitt under fas C. Ett lås nu skulle dessutom '
      + 'koda in "vad prod gjorde" i stället för "vad som är rätt". '
      + '(d) expectedNotifications 135 — INTE 132. ANVÄNDARBESLUT U5 2026-08-08: '
      + 'ankomstnotis + passagenotis vid långa väntetider är AVSIKTLIGA, inte '
      + 'dubbletter. Ankomstnotisen är äkta förvarning, passagenotisen bekräftar. '
      + 'F-17 är därmed ett DOKUMENTERAT DESIGNVAL, inte en fix (D9 utgår). '
      + 'Framtida granskare ska alltså INTE "rätta" siffran till 132. '
      + '(e) pollEraMinutes: 10 — korpusen är SISTA REFERENSPUNKTEN för '
      + '10-minuterseran innan B4 flippar `interval=` till 3. '
      + '(f) INV-10-utslaget (den 152,9 min långa "strax"-episoden) är '
      + 'U1-sanktionerat per ANVÄNDARBESLUT U6: texten är sakligt sann (båten '
      + 'står vid bron och väntar) och de 256 felvisningsminuterna klassas som '
      + 'sanktionerade, inte som defekt. Utslaget behöver en '
      + 'knownInvariantException OAVSETT när korpusen låses — den skrivs när '
      + 'strängen är stabil (fas C rör INV-10:s väg via C11/C11b). '
      + 'lockOpenings: false av samma skäl som #17 plus att öppningsfacit för en '
      + 'olåst korpus vore meningslöst. '
      + 'VILLKOR FÖRE SKARP LÅSNING: fas C landad (C0b, C4b, C7b, C1d, C8, C11, '
      + 'C13) · invariantutslagen fixade eller bärande rådataverifierade '
      + 'undantagssträngar · gt-passages regenererad med den korrigerade '
      + 'geometrin (A2 — REDAN GJORT: gt-passages/20260806-42h.json, 130 '
      + 'korsningar varav 15 inferred; den gamla fältfilen i field-facit/ saknar '
      + '12 gap-korsningar och har 17 falska Kanalinfarts-intrång). '
      + 'Fältfacit i field-facit/20260806-42h/. '
      + '── (g) C4b-DELTAT 2026-08-09 — expectedNotifications LÄMNAS PÅ 135 '
      + 'MEDVETET, trots att koden nu ger 134. Siffran 135 dokumenterar '
      + 'FÄLTIDENTITETEN (punkt b) och ska inte skrivas om av en fix; den '
      + 'reconcilieras när korpusen låses skarpt. Deltat är EN post, '
      + 'rådataverifierad: 219028537 MARY fick i förfix-koden TVÅ '
      + 'Klaffbron-notiser för EN passage — 13:18:07.142Z (source=target, '
      + 'd=252 m, riktningstoken **northbound**) och 13:41:44.160Z '
      + '(source=current, d=120 m, southbound). Rådata: MARY gick söderut hela '
      + 'tiden (13:18:07 sog 3,7 cog 219,8; lat 58.28714 → 58.28630 → 58.28530 '
      + '→ 58.28485), stod och väntade 84–143 m norr om Klaffbron 13:20–13:30 '
      + 'och var 13:41:44 lat 58.28303 = 120 m SÖDER om bron. Den andra notisen '
      + 'fanns bara därför att samma fysiska passage bokfördes under TVÅ olika '
      + 'riktningstoken (fel lås ⇒ falsk re-cross ⇒ riktningsdedupen bet inte). '
      + 'Med C4b är båda southbound, dedupen håller, och passagen har kvar sin '
      + 'notis (13:18:07, nu med RÄTT token). '
      + 'DETTA ÄR INTE U5-KLASSEN. U5:s två sanktionerade dubbletter — '
      + '219025192:Stridsbergsbron (09:13:57 + 11:43:29) och '
      + '211214850:Stridsbergsbron (09:17:18 + 11:43:29) — har SAMMA '
      + 'riktningstoken i båda posterna, står kvar orörda och fäller sina '
      + 'INV-2-utslag precis som förut. Kontrollera det vid nästa granskning: '
      + 'C4b tar bara bort par som skiljer sig i riktningstoken. '
      + 'Öppningsdimensionen går samtidigt 36 → 35: MARY-fantomen '
      + '`Stridsbergsbron#31` 13:33:26 (norrut, 1 087 m) för en bro hon '
      + 'passerade 11:45:45 — 107,7 min tidigare, och vars öppning redan var '
      + 'varnad av `Stridsbergsbron#29` 13:16:56 (U2-brott) — är borta. '
      + 'Klaffbron-varningarna är fortfarande två men byter ledare till de '
      + 'fartyg som faktiskt öppnade bron: `Klaffbron#30` 13:18:07 MARY '
      + '(d=252 m; passage i AIS-gapet 13:30:28→13:41:44) i stället för DORY '
      + 'MAN 13:23:47 (d=1 365 m, sog 0,3 — hon kom Klaffbron närmast 14:12:01 på 328 m, '
      + 'vände norrut 14:13 och förtöjde i gästhamnen utan att passera), och '
      + '`Klaffbron#31` LENYA 13:29:56 (eta 25 min) i stället för 13:46:56 '
      + '(eta −1 = okänd). '
      + 'ÖPPEN RESTPOST TILL C8: båda Klaffbron-varningarna ligger nu FÖRE '
      + 'MARYs passage (13:18:07 + 13:29:56), dvs. två varningar för en '
      + 'o-passerad händelse — U2-semantiken kräver absorption. I förfix-koden '
      + 'låg den andra efter passagen och dolde samma brist. C4b rör inte '
      + 'medlemskapslogiken; C8 äger den.',
  },
];
