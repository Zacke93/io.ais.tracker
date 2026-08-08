# FÄLTFACIT — vad appen FAKTISKT gjorde i drift (A9b, etapp 7, 2026-08-08)

En katalog per korpus, samma roll som `night-facit/` har för A/B-natten: här
ligger **produktionskörningens egna utfall**, extraherade ur fältloggen, så att
en replay kan jämföras mot verkligheten i stället för mot sig själv.

Filerna är **dokumentära facit** — de konsumeras (ännu) inte av någon grind.
Låsningen sker i `corpora.js` (`expectedNotifications`) och i de fem
facitdimensionerna; det här är underlaget som gjorde låsningen möjlig och det
enda som kan avgöra en framtida tvist om "vad visade appen egentligen?".

| Katalog | Korpus | Fältkörning | Logg |
|---|---|---|---|
| `20260804-17h/` | #16 `20260804-17h` | A/B-dagen 2026-08-04, **A-armen** (aisstream) | `logs/app-20260804-024200.log` |
| `20260804-both-21h/` | #17 `20260804-both-21h` | både-dygn 1, 2026-08-04/05 (`source=both`) | `logs/app-20260804-224222.log` |
| `20260806-42h/` | #18 `20260806-42h` | 42h-fältprovet 2026-08-06/07 (AISHub ensam) | `logs/app-20260806-005440.log` |

## Filerna

| Fil | Innehåll |
|---|---|
| `field-notif.txt` | de `boat_near`-notiser fältet faktiskt skickade (formatet skiljer sig mellan körningarna — se nedan) |
| `field-texts.txt` | hela `bridge_text`-strömmen, `<ISO> <text>`, en rad per **ändring** |
| `field-openings.txt` | `bridge_opening_soon` + armningsspåret (#16/#17 råa loggrader, #18 en rad per avfyrning) |
| `gt-passages.json` | fältkörningens EGET korsningsfacit (**äldre geometri** — se varningen nedan) |

`field-notif.txt` bär `mmsi|bro|distans` i #16/#17 och `<ISO> mmsi bro distans status`
i #18. Formaten är som de levererades av respektive fältanalys och har medvetet
inte harmoniserats — en omskrivning av en observation är en ny observation.

## ⚠️ `gt-passages.json` här är INTE rådatafacit

Katalogens `gt-passages.json` är fältkörningens egen fil, byggd med den
**geometri som gällde före A2** (perpendikelmått mot grannbrons korda,
gapfilter, ogrindad Kanalinfart). Den bevaras som historiskt underlag.

**Sanningen är `tests/replay-validation/gt-passages/<korpusid>.json`** (A2,
`makeGtPassages.js`, farledspolylinje + frusna brostationer). För #18 är
skillnaden materiell: den gamla filen saknar 12 gap-korsningar och innehåller
17 falska Kanalinfarts-intrång (ELFKUNGENs kajvobbel på 295–305 m). Låser man
den som facit låser man in exakt de felen.

`20260804-both-21h/` saknar `gt-passages.json` helt — fältanalysen producerade
aldrig en. A2-facit finns (`gt-passages/20260804-both-21h.json`, 144 korsningar).

## `field-texts.txt` — extraktionsmetoden (A8(i))

**UI_HEAD:** texten användaren ser ändras på exakt två ställen i `app.js`, och
båda loggar under `📱 [UI_UPDATE]`:

| app.js | Loggrad | Roll |
|---|---|---|
| `:3915` | `Bridge text updated: "<text>"` | normala publiceringsvägen, loggas **endast** när texten faktiskt ändrades (`textActuallyChanged`) |
| `:2337` | `FORCED bridge text update to default: "<text>"` | sista fartyget borttaget ⇒ tvinga DEFAULT |

Kanonisk extraktion — **hela** `Bridge text updated`-klassen, i loggordning,
**utan** avduplicering och **utan** textfilter:

```sh
grep -h '\[UI_UPDATE\] Bridge text updated: "' logs/app-<körning>.log \
  | sed -E 's/^([^ ]+) .*Bridge text updated: "(.*)"$/\1 \2/'
```

**FORCED-klassen är MÄTT redundant och ingår därför inte.** Slår man ihop båda
klasserna i tidsordning och tar bort direkta upprepningar ändrade FORCED-raden
texten i **0** fall av 62 (#16), **0** av 69 (#17) och **0** av 265 (#18) — varje
gång stod DEFAULT redan publicerad. Klassen bidrar alltså med noll ny
information och skulle bara lägga in falska övergångar.

### Vad de levererade filerna hade fel (mätt 2026-08-08)

Alla tre filerna kom ur olika ad hoc-extraktioner och alla tre avvek. De är
regenererade här med metoden ovan; diffen är uttömmande:

| Korpus | Levererad | Regenererad | Diff |
|---|---|---|---|
| #16 | 190 | **189** | −1 startrad (`00:42:13.094Z`, appens allra första publicering) · **+2 falska** `Inga båtar…` ur FORCED-klassen (rad 34, 159) som aldrig ändrade texten |
| #17 | 318 | **321** | −1 startrad (`20:42:33.233Z`) · −2 `3 båtar är i närheten av Stridsbergsbron` (`08:27:26.126Z`, `08:28:17.132Z`) — **fallback-klassen** (`_generateSafeFallbackText`, siffra i st f ord) som ett svenskt räkneordsfilter inte matchade |
| #18 | 301 | **302** | −1 startrad (`22:54:52.598Z`) |

Startraden är ingen dubblett att städa bort: appen publicerar DEFAULT vid
uppstart, och den publiceringen ÄR den första texten användaren såg.

**Läxan** (samma klass som fältlist-fällan): en extraktion som räknar upp de
textvarianter den förväntar sig blir blind för varje NY variant — och
fallback-texten är per definition den variant som dyker upp när något gått fel.
Filtrera på **loggtaggen**, aldrig på innehållet.
