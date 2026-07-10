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
      + 'den rättade missen. Facit-fällan in action: gamla 29 kodifierade buggen.',
  },
  {
    id: '20260601-41h',
    jsonl: path.join(CORPORA_DATA_DIR, 'ais-replay-20260601-231305.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260601-231305.log'),
    hours: 41,
    locked: true,
    expectedNotifications: 86,
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
      + 'SY FREYJA-fixen tog i svepet).',
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
      + 'fönster notifierades — inkonsekvensen som fältprov 4 blottlade.',
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
    expectedNotifications: 73,
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
      + 'avslutad resa (_finalTargetDirection) och strök exiten strukturellt.',
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
      + 'för MÅLLÖS transitör).',
  },
];
