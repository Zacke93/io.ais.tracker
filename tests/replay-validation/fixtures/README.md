# Fixturer för replay-integritetsgrinden (K24)

Fyra filer som fryser nattkörningen **2026-08-19 00:39:35** i repot, så att
`tests/replay-integrity.test.js` kan pröva `checkReplayIntegrity.js` mot det
VERKLIGA fältfallet utan att bero på `~/.ais-tracker-logs`.

## Varför de finns

Testet körde tidigare mot `~/.ais-tracker-logs/ais-replay-20260819-003935.jsonl`
och låste `expect(r.jsonlComplete).toBe(99)`. Samtidigt rekommenderar
`docs/VALIDATION.md` steg 2 att en trunkerad jsonl byggs **om** ur den hela
loggen (`LC_ALL=C grep 'AIS_REPLAY_SAMPLE' … | sed …`). Byggdes den om **på
plats** blev 99 → 146 och testet föll — regressionsprovet kodade in ett
tillstånd projektet uttryckligen vill lämna, i en katalog utanför repot som
ingen granskning ser. Skyddet `fs.existsSync(…) && size > 0` fångade bara att
filen FÖRSVANN, aldrig att den ÄNDRADES. (Granskningsfynd 2026-08-21.)

Nu ligger beviset här, byte-exakt. Ombyggnaden i hemkatalogen kan göras utan att
sviten rör sig.

## Filerna

| Fil | Innehåll | sha256 |
| --- | --- | --- |
| `ais-replay-20260819-003935.truncated.jsonl` | **Byte-exakt kopia** av fältets trunkerade fångstfil: 24 576 B = exakt 6×4096 (blockbuffertens signatur), 99 kompletta rader, sista raden avhuggen mitt i JSON-objektet (140 byte svans). | `e90f4056c29d63cd6a966003fc6d45bb6aa75f3c4c79cebf021081a2c3f6ad5d` |
| `app-20260819-003935.samples.log` | Miniatyrlogg: **exakt de 146 `[AIS_REPLAY_SAMPLE]`-raderna** ur den 1,5 MB stora `app-20260819-003935.log`, byte-äkta och i ordning. Verktyget läser bara sampelraderna, så resten av loggen behövs inte. **Ingen kommentarrad** — filen ska vara ett rent utsnitt. | `bd70000b0d86464014238a1ab01ccdb48643fe68b2d4c5bdafa29beccebb50bd` |
| `app-20260819-003935.first20.log` | De 20 första av samma 146 rader — OK-fallets logg. | `2fecc80e177e3bc87c51fd6232437d9e4fd6c54beec894dc3616fff29f5f0137` |
| `ais-replay-20260819-003935.first20.jsonl` | Den KOMPLETTA fångsten för de 20 raderna, härledd med projektets egen extraktion (samma `grep`+`sed` som `run-with-logs.sh:117-118`). Byte-identiskt prefix av den trunkerade filen (4 866 B). | `f654539b59ee3011765094edc1ed1befd4220623253ce85fa13bb20e7618663e` |

### `.gitignore` i den här katalogen

Repots `.gitignore:7` utesluter `*.log`. Utan den nästlade `.gitignore`:n med
`!*.log` hade de två loggfixturerna **aldrig committats** — och då hade hela
poängen fallit på första färska klon: testet skulle söka en fil som inte finns.
Verifierat: `git status --porcelain -uall --ignored` visar `??` (spåras) för
fixturerna och `!!` för en kontroll-`.log` utanför katalogen.

## Så byggdes de (reproducerbart)

```sh
LIVE=~/.ais-tracker-logs
FIX=tests/replay-validation/fixtures

cp "$LIVE/ais-replay-20260819-003935.jsonl" "$FIX/ais-replay-20260819-003935.truncated.jsonl"

LC_ALL=C grep 'AIS_REPLAY_SAMPLE' "$LIVE/app-20260819-003935.log" \
  > "$FIX/app-20260819-003935.samples.log"

LC_ALL=C head -20 "$FIX/app-20260819-003935.samples.log" \
  > "$FIX/app-20260819-003935.first20.log"

LC_ALL=C sed 's/^.*AIS_REPLAY_SAMPLE\] //' "$FIX/app-20260819-003935.first20.log" \
  > "$FIX/ais-replay-20260819-003935.first20.jsonl"
```

## Förväntade utfall (låsta i tests/replay-integrity.test.js)

- `truncated.jsonl` + `samples.log` ⇒ **FEL**, 99 kompletta rader mot 146 sampel,
  `47 av 146 sampel SAKNAS i jsonl:en (32.2 %)`, blockbuffert-noten
  `24576 B = exakt 6×4096` och PREFIX-noten (rent avhugg, ingen omkastning).
- `first20.jsonl` + `first20.log` ⇒ **OK**, 20 mot 20, inga problem.

Ändras någon fixtur faller sha256-låset i testet — och det är meningen: de här
filerna är facit för själva grinden och ska inte "råka" byggas om.
