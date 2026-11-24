'use strict';

// Vakt för U58-testens barnprocesser (laddas med node -r eller require).
// Dödas föräldern (jest) medan ett barn snurrar i en slinga som svälter
// händelseslingan, lever barnet annars för evigt på full processorlast:
// timers körs aldrig. En Worker-tråd har en egen händelseslinga och kan
// därför avsluta processen ändå. Gränsen ligger över testets egen gräns.
// Testverktygen kräver Node 20+ (CLAUDE.md); eslint-konfigurationens nodintervall är äldre.
// eslint-disable-next-line node/no-unsupported-features/node-builtins
const { Worker } = require('worker_threads');

const VAKT_MS = Number(process.env.U58_VAKT_MS || 45000);
new Worker(`setTimeout(() => process.kill(process.pid, 'SIGKILL'), ${VAKT_MS})`, { eval: true }).unref();
