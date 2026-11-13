# Rättningskampanjen, varv 2 (2026-11-09)

Varv 1 är klart och pushat. Produktgrenen claude/wonderful-wozniak-yhk4kz har HEAD c14938f.
Motorns standardkörning på den koden ligger i S/reg/slut-standard: rapport.md, rapport.json och
fynd/<kort>/ med repro.jsonl, repro.spec.json, repro.truth.json, tidslinje.txt och
fynd.json. Registret har 40 poster.

Förkortningar nedan:
- S = /tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad
- V = S/varv2

**Ägarens beslut:** U13–U22 står i S/kampanj/KAMPANJ.md, med motiv i docs/ARCHITECTURE.md och
docs/BUGGJAKT.md §7. De viktigaste:
- U13: facit låses om bara där rådatan visar att utfallet blir rättare.
- U15: en returresa får egen varning.
- U17: säkerhetsvarningen för en tyst båt behålls. Det gäller när hennes senaste position sa
  att hon skulle hinna igenom den gemensamma öppningen, men appen inte vet om hon gjorde det.
- U18: två positioner krävs innan en vändning tros.
- U22: ETA-korten är uppskjutna.
- Produktprincipen: en missad öppning är värre än ett falsklarm.

**Kort som ska utredas** (i S/reg/slut-standard):
- F02 T2 LEDTID: 9 världar. Varv 1 sorterade dem grovt:
  - 263, 290 och 313: utan täckning och vändning;
  - 936 och 1918: returer där den egna varningen kom vid nästa fix;
  - 979: bakkanten eller RECOVER;
  - 790: K-NÄSTA-sann, med restid 1,34;
  - 1274: en vändning bekräftad via RE_CROSS under en annan bro, målbron hölls tom;
  - representanten: en köledare som väntar i 22–44 min.
- F05 T2 OKLASSAD: 10 världar, bland dem 1208 (NEW_JOURNEY), 1316 (retur), 1317 (som 1274)
  och representanten (AIS-avbrott på 520–741 s).
- F08: stresstvilling till F05, krypfart 1,26–1,3 kn.
- F06 T3 VARNING-EFTER-SANN-PASSAGE: 9 världar, mest RECOVER-släpp vid täckningsslut.
- F07 T3 VARNING-PÅ-FRUSET-FIX: 2 världar.
- B01 D1-KAJZON-DEMOTION: en beslutsfråga.

ETA-korten F01, F03, F04, F09 och F10 rörs INTE (U22).

**Regler:**
- Följ CLAUDE.md i repot.
- Använd inte git stash.
- Skriv på svenska.
- Skriv bara i din egen katalog under V.
- Huvudträdet /home/user/io.ais.tracker är bara för läsning.

**Kommandon** (från din worktree, med TMPDIR i din tmp):
- `node tests/replay-validation/bugHunt/hunt.js --repro <fynd>`
- `REPLAY_VERBOSE=1 node tests/replay-validation/replayRunner.js <fynd>/repro.jsonl`

Världar som inte har en egen fynd-katalog återskapas med motorns generator. Se hur
triagen i S/hunt-fix/tmp/triage-1/scripts gjorde i varv 1.
