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

module.exports = [
  {
    id: '20260525',
    jsonl: path.join(LOGS_DIR, 'ais-replay-20260525-231934.jsonl'),
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
    jsonl: path.join(LOGS_DIR, 'ais-replay-20260601-231305.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260601-231305.log'),
    hours: 41,
    locked: true,
    expectedNotifications: 78,
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
      + 'tidigare ingen linjekorsningsdetektering alls.',
  },
  {
    id: '20260610-förfix',
    jsonl: path.join(LOGS_DIR, 'ais-replay-20260610-001053.jsonl'),
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
    jsonl: path.join(LOGS_DIR, 'ais-replay-20260611-115443.jsonl'),
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
    jsonl: path.join(LOGS_DIR, 'ais-replay-20260610-012751.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260610-012751.log'),
    hours: 19,
    locked: true,
    expectedNotifications: 47,
    note: '19h-körningen (RC1–RC9-auditens underlag). LÅST 47 (2026-06-11): prod gav '
      + '45 men MISSADE två — SILJA@Klaffbron (RC3: failsafe-stale-skattning med '
      + 'momentan sog) och DIANA@Järnvägsbron (RC2: falsk INFERRED_PASSAGE '
      + 'blockerade äkta passagen). Replay med fixarna ger exakt dessa +2, '
      + 'inga andra fördelningsändringar (verifierat per mmsi+bro 2026-06-11).',
  },
  {
    id: '20260702-11h',
    jsonl: path.join(LOGS_DIR, 'ais-replay-20260702-010825.jsonl'),
    appLog: path.join(LOGS_DIR, 'app-20260702-010825.log'),
    hours: 11,
    locked: true,
    expectedNotifications: 24,
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
      + '(INV-14 vaktar klassen).',
  },
];
