# io.ais.tracker

Homey-app (SDK v3) som spårar AIS-båttrafik och förutsäger broöppningar.
Svar och kodkommentarer på svenska.

## Kommandon

- Test: `npm test` (jest via `tests/jest.config.js`)
- Full validering: jest + `npm run replay:all`, `replay:synthetic`, `replay:openings`
- **Windows-fallgrop:** `npm run validate` är POSIX-only (subshell + `$TMPDIR`) —
  kör jest och replay-skripten var för sig istället.
- Korpuslåsningens grindar (ingår MEDVETET inte i `validate` — de prövar en
  fältkörning, inte en kodändring): `node tests/replay-validation/checkReplayIntegrity.js`
  (jsonl mot logg) och `npm run replay:phase` (fassvepet). Kriterier i
  `docs/VALIDATION.md` §Fältprov, steg 3 och 4.
  - Ett bart `npm run replay:phase` sveper de OLÅSTA korpusarna och är
    **FÖRVÄNTAT rött** tills `20260806-42h` avgjorts efter K20a (gula paketet).
    Lägg det därför ALDRIG i `npm run validate`/CI; kör rökprov mot en
    NAMNGIVEN korpus: `npm run replay:phase -- <jsonl>`.
- Lint: `npm run lint`

## Struktur (stabila delar)

- `app.js` — huvudapp; `drivers/bridge_status/` — Homey-drivern
- `lib/connection/` — AIS-strömmen (AISStream + fusion), `lib/services/` — logik,
  `lib/utils/` — hjälpare
- `.homeycompose/` — appmanifest, capabilities och flow-kort (genererar `app.json`;
  redigera aldrig `app.json` direkt)
- `docs/ARCHITECTURE.md` — arkitekturen; `docs/bridgeTextFormat.md` — brotextformatet

## Regler och fallgropar

- Använd inte `git stash` — det förstör LF-radslut i repot.
- Brotexterna följer exakt format (se `docs/bridgeTextFormat.md`) och valideras
  av tester — ändra aldrig textformat utan att köra brotext-testerna.
- Radiebeslut och liknande domänbeslut dokumenteras i `docs/` — kolla där innan
  du ifrågasätter till synes godtyckliga konstanter (t.ex. 300 m vid Stallbackabron).

## Uppdatera den här filen

Håll den kort. När ett kommando eller en regel ändras: uppdatera raden i samma
commit. Historik och beslut hör hemma i Ravens minne, inte här.
