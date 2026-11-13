# Granskning av familj G (registerposterna U25 och U26)

Du granskar familj G:s arbete ADVERSARIELLT. Anta att posterna är för breda eller fel tills dina
egna körningar visar motsatsen. Lita inte på familjens påståenden; mät själv.

Förkortningar: S = /tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad,
V = S/varv2, R = /home/user/io.ais.tracker (huvudträdet, bara läsning).

## Läs

- V/G/UPPDRAG.md (familjens uppdrag, besluten U25 och U26 och kraven på smalhet).
- V/G/DESIGN.md, V/G/RESULTAT.md och V/G/patch.diff.
- docs/BUGGJAKT.md §7 (registrets regler) och de nya raderna i ändringsloggen.
- tests/replay-validation/bugHunt/lib/registry.js (de nya predikaten och grannarna
  `tystRecoverSammaÖppning` och `u24DeladKö`).
- Underlaget för världarna: V/E/DESIGN.md §4, V/B/DESIGN.md §M7, V/tA/TRIAGE-A.md (1139, M7, M10).

## Arbetsplats

- V/G/rwt är en git-worktree detached på familjens HEAD. node_modules är en symlänk.
- Tempfiler i V/G/rtmp (sätt TMPDIR dit). Jest: `--cacheDirectory=V/G/rjest-cache` (absolut).
- Mutationsprov gör du i egna worktrees under V/G/ (till exempel V/G/gmwt) och tar bort dem
  efteråt. Disken har begränsat utrymme: städa.
- Ändra ALDRIG V/G/wt, andra familjers kataloger eller huvudträdet. Ingen git stash, ingen push.
  Prober får du committa lokalt i rwt.

## Pröva

1. **Mekanismen.** Kör `hunt.js --repro` på V/integ/std-final/fynd/F04-… och F05-… i rwt och
   kontrollera att fynden nu registreras under U26 respektive U25, och att DESIGN.md:s tidslinjer
   stämmer med en verbos logg.
2. **Smalheten.** För varje villkor i predikaten: vad händer om det tas bort? Konstruera
   motexempel där ett verkligt appfel skulle döljas, till exempel:
   - appen hade den passerande båtens rad efter korsningen men bokförde passagen senare;
   - bakkanten släpper en tick eller mer efter bokföringen;
   - täckningsslutet kommer senare än motorns räknade slut;
   - en båt i rörelse, eller utanför väntzonen, som U24 borde ha släppt;
   - en avgång som hördes (en levererad rad i rörelse) men inte gav någon tidigare varning.
   Kör dem som jest-fall eller som varianter av världarna.
3. **Mutationsprov, oberoende av familjens.** Minst: bakkanten bortkopplad i `_coverageVerdict`,
   U24-släppet bortkopplat, täckningsslutet förskjutet senare, och U24:s rörelsegrind
   uppskruvad. Kör quick med respektive utan de nya posterna och jämför: inget nytt utslag får
   tas av U25 eller U26 utom exakt deras mekanism.
4. **Testerna.** De ska ta 1038 och 1139 och avvisa motexemplen. Mutera predikatets villkor ett
   i taget (i rwt) och visa att något test fäller varje mutant. Inga tautologiska test.
5. **Dokumentationen.** ARCHITECTURE och BUGGJAKT §7 stämmer med koden: antalet poster,
   posttabellen, ändringsloggen och bilaga A. Klassen ACCEPTERAD och källorna är rimliga.
6. **Körningarna.** Hela jest, lint och självtestet i rwt. Upprepa familjens standardkörning
   (`--profile=standard --seed=1 --out=V/G/rstd`) och kontrollera att talen är desamma
   (determinism) och att bara F04 och F05 skiljer mot V/integ/std-final.

## Leverans

**V/G/GRANSKNING.md** med:
- domen, GODKÄND eller ÄNDRINGAR KRÄVS;
- varje anmärkning med allvar (hög, medel eller låg), belägg (kommando och utdata) och ett
  konkret förslag till rättning.

Hög betyder att en post kan dölja ett verkligt appfel eller att ett krav i uppdraget inte är
uppfyllt. Medel betyder en lucka som kan ge fel i ett rimligt fall, eller ett test som inte prövar
det det påstår. Låg betyder dokumentation, stil eller små förbättringar.

**Slutsvaret** ska vara domen och anmärkningarna i korthet, högst 40 rader på svenska.
