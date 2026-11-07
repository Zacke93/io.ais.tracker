# K-familjen — facit som flyttas (revision 3)

Rättningskampanjen 2026-11-04, tredje revisionen 2026-11-05. Jämförelsen gäller 7699cbe mot K/wt
(HEAD `3707636`, se DESIGN.md) över hela korpusbanken: 24 korpusar plus nattfusionen. Verktyg:
`K/tmp/tools/dump-openings.js` och `K/tmp/og1/tools/abdiff.py`; dumparna ligger i
`K/tmp/r3/bank-headB.json` (prototypen), `K/tmp/r3/bank-alt-a.json` (alternativ A) och
`K/tmp/og1/bank-base.json` (7699cbe). Rådatafacit kommer från `tests/replay-validation/gt-passages/`,
samplen i korpusernas jsonl och öppningsgrindarna (`npm run replay:openings`, O1/O1b/O2).

## Kort sammanfattning

- **Låst facit som flyttas: inget.** `golden-events/20260712-25h.json` och dess not i `corpora.js` är
  återställda till 7699cbe. Dirigentens beslut 2026-11-05 säger att en likvärdig låst rad ska undvikas
  genom designen. Revision 3 gör det: täckningsslutet räknas från bokföringen som förut (DESIGN.md §2.7).
- **Notiser, brotexter och målbropassager:** oförändrade i hela banken. `corpora-distribution.json`,
  `corpora-direction-distribution.json` och golden-text behöver inte låsas om.
- **Olåsta öppningsvarningar:** en flyttas, PRINCESS LIZYMAR i 41h, och den är **rättare** (§1).
  LINNEA byter händelsenummer som följd.
- **Grindarna:** O1 (appserien) och O2 är gröna. O1b (rådataserien) går 38 → 37 varningar med okänd
  ordning, och TÄCKNING 391 → 392 av 447. Båda kommer från PRINCESS LIZYMAR.
- **Syntetiskt:** `u-sväng-gles-ais-norr-om-Klaffbron` går 2 → 3 öppningar, rättare (§2).
- **Alternativ A** (`K/alt-korsningstackning.diff`, täckningsslutet från korsningen) flyttar dessutom en
  låst rad i 25h (likvärdig) och två olåsta rader (likvärdiga). Raderna står i §4 så att dirigenten ser
  vad alternativet kostar. Det får inte integreras utan ett uttryckligt undantag från U13.

## 1. 20260713-41h (olåsta öppningar): PRINCESS LIZYMAR — rättare

| | 7699cbe | K |
|---|---|---|
| PRINCESS LIZYMAR (219029305) vid Klaffbron norrut 2026-07-15 | 08:40:41,197, `Klaffbron#43`, 501 m, eta 0 | 08:34:13,934, `Klaffbron#42`, 1189 m, eta 6 min |
| LINNEA (265764760) vid Klaffbron | 08:42:16,654, `Klaffbron#42`, 1535 m, eta 9 | samma tid, avstånd och eta, `Klaffbron#43` |

**Mekanismen: medlemskapet och bakkanten mot korsningen.**
- Ledaren NORDIC SOLA:s passage bokfördes 08:30:41,2. Den skattade korsningen blev 08:29:50,9.
  Rådatans korsning är 08:29:48,6, observerad (inte inferred), med 80 s glapp.
- PRINCESS LIZYMAR beväpnades 08:31:19 på 1658 m och absorberades. Täckningen räknas från bokföringen:
  08:30:41,2 + 600 s = 08:40:41,2, som på 7699cbe.
- Fixet 08:33:22 gav den färska prognosen 08:39:52,4. Det är 1,5 s efter U2-fönstrets slut 08:39:50,9
  (korsningen + 600 s), och fönstret slutar före täckningen. Bakkanten släppte henne därför på det
  fixet, och hon varnades på sin egen deadline med 6 min ledtid.
- Utan bakkanten hade hon släppts vid täckningsslutet 08:40:41 med eta 0, som på 7699cbe.

**Rådatabelägg (U13):**
- Hennes korsning ligger i sampelfönstret 08:36:22,392–08:47:21,137 (gt-passages, punkt 08:42:13,263).
- På 7699cbe låg varningen i fönstret (O1b `TIDPUNKT_OKÄND`). Nu ligger den före fönstrets start, alltså
  säkert före korsningen.
- O1b går 38 → 37. Rådatafacit i 41h går 44/53 → 45/53, och TÄCKNING i hela banken 391 → 392 av 447.

**Bedömning: rättare.** Granskningen har bekräftat bedömningen två gånger.

LINNEA:s rad ändras bara i händelsenumret. PRINCESS LIZYMAR:s händelse öppnas nu 08:33:22, före
LINNEA:s, och tar `#42`. Bedömning: **likvärdig** (räknaren delas mellan broarna).

> Rättelse mot revision 2: där stod LINNEA:s varning som 08:41:50. Den rätta tiden är 08:42:16,654
> (1535 m, eta 9), i båda träden.

## 2. Syntetiskt scenario: `u-sväng-gles-ais-norr-om-Klaffbron` (inget låst facit)

3 öppningar i stället för 2. Notiserna (7) och passagerna (2) är oförändrade, och scenariot är grönt.
- Den nya varningen gäller Klaffbron söderut, 06:24:00 (`fix`).
- Ur samplen: utpassagens korsning 06:15:28,6, bokförd 06:18:00.
- Returen korsar 06:26:31,9, alltså 663 s efter den verkliga korsningen. Enligt U2 är det nästa öppning,
  och varningen kommer 152 s före.
- På 7699cbe räknades medlemskapet från bokföringen. Returen hamnade då 511 s in i fönstret och fick
  ingen varning.
- Golvet gäller inte, eftersom ledtiden är 152 s. Varningen följer av medlemskapet mot korsningen och
  är densamma i revision 3 som i revision 2.

**Bedömning: rättare** (samplen och U15). Det ersätter inte K2:s rättning inom 600 s.

## 3. Det som INTE flyttas i revision 3, och varför

| Rad | Revision 2 | Revision 3 | Varför |
|---|---|---|---|
| 20260712-25h 265806230 (LAENGE LAEUFT), låst | 08:30:11 | **08:37:18, som 7699cbe** | täckningsslutet räknas från bokföringen; raden är likvärdig och får inte flyttas (U13, dirigentens beslut) |
| 20260601-41h AMALIA II (265759700) | 08:41:59,375 | **08:42:59,896, som 7699cbe** | samma mekanism: en tyst båts täckningsslut |
| 20260713-41h ELFKUNGEN (265573130), 2026-07-14 | 10:27:14,518 | **10:27:42,855, som 7699cbe** | samma mekanism |

Korsningsankarets bakåtskattning vid väntan (revision 3, DESIGN.md §2.1) flyttar ingen rad i
prototypen. Den ändrar MALUCAs skattade korsning i 25h från 08:19:39,6 till 08:24:15,9, men den
korsningen styr bara medlemskap och bakkant, och ingen färsk båt prövas mot den.

Varianter som hade flyttat O1-skyddade rader är fortfarande avvisade, och U17 bekräftar valet
(säkerhetsvarningen för en tyst båt behålls). De tog bort RECOVER-varningar för passager med okänd
ordning: 20260702-2h 265558470, 20260707-14h AKIRA, 20260713-41h ELFKUNGEN vid båda broarna, samt
golvets förflyttning av 20260804-17h 211100280 och LYS. Se DESIGN.md §3.1.

## 4. Alternativ A: raderna som det flyttar (för dirigenten)

Alternativ A är prototypen med täckningsslutet räknat från korsningen (`K/alt-korsningstackning.diff`
ovanpå `K/patch.diff`). Mot 7699cbe flyttar det fyra varningar och två händelsenummer. Mot prototypen
flyttar det tre varningar (25h, AMALIA II, ELFKUNGEN). Dumpen är `K/tmp/r3/bank-alt-a.json`.

### 4.1 20260712-25h (låst, golden-events) — likvärdig

| Rad | 7699cbe och prototypen | Alternativ A |
|---|---|---|
| 265806230 (LAENGE LAEUFT) vid Stridsbergsbron söderut | 08:37:18,752, `Stridsbergsbron#16` | 08:34:15,917, `Stridsbergsbron#14` |
| GALADRIEL (265042840) vid Klaffbron, 08:36:40 | `Klaffbron#14` | `Klaffbron#15` |
| VENTICELLO (211844250) vid Klaffbron | `Klaffbron#15` | `Klaffbron#16` |

Avstånd 587 m, `etaMin` −1, `firedBy` deadline och `originalDueMs` 08:21:13,99 är lika. 32 öppningar och
85 notiser är oförändrade.

**Mekanismen** (verbose: `K/tmp/r3/logs/25h-w2m.log` för A, `25h-base.log` för 7699cbe):
- Båten absorberas först i `#10` (NICOLINE), med täckning till 08:30:11,2 (NICOLINEs prognos + 600 s,
  aldrig förlängd). Hon släpps där 08:30:11 i båda träden.
- Hon återabsorberas i `#9` (MALUCA). MALUCAs fix före bron (08:14:16, 403 m söder om bron, 0,1 kn i
  Järnvägskön) visar en köande båt. Korsningen bakåtskattas därför ur fixet 08:27:18 (574 m norr om
  bron, 6,1 kn): 08:24:15,9.
- I A slutar täckningen ur `#9` då 08:34:15,9, och hon varnas där. I prototypen och på 7699cbe räknas
  den från bokföringen 08:27:18 + 600 s = 08:37:18.

**Rådatabelägg (U13):**
- **Hennes passage.** Sista fixet 08:24:16,358 ligger 587 m norr om bron i 8,5 kn söderut. Nästa fix
  är 09:22:38,398, 2363 m söder om bron och 1158 m söder om Klaffbron. gt-passages har en `inferred`
  punkt 08:35:51,4, en rät linje över 58 min glapp, som enligt README inte får användas som punkt.
- **Fönstrets slut.** Det är belagt med sampel. IDUN låg stilla i samma kö 393 m söder om bron
  08:21:19,9, och NICOLINE sågs redan 66 m norr om bron 08:26:19,9. MALUCA låg 574 m bortom bron
  08:27:18 och kan även i 12 kn inte ha korsat senare än cirka 08:25:45. Den gemensamma öppningen låg
  alltså ungefär 08:22:30–08:26:20, och U2-fönstret slutar ungefär 08:32:30–08:36:20. A:s 08:34:15
  ligger i det intervallet; 7699cbe:s 08:37:18 ligger efter det.
- **Andra öppningar vid bron:** 08:59–09:05 (VENTICELLO söderut, GALADRIEL norrut 09:00:49,7, observerad).
- **O1b:** `TIDPUNKT_OKÄND` i båda träden. **O2:** `ACCEPTERAD AVBRUTEN_APPROACH` i båda.

**Bedömning: likvärdig mot hennes passage.**

| Hon korsade … | 7699cbe (08:37:18) | A (08:34:15) |
|---|---|---|
| i den gemensamma öppningen: 587 m i 8,5 kn räcker till 08:26:31, strax efter NICOLINE | efter passagen | efter passagen |
| ensam mellan 08:34:15 och 08:37:18 | efter passagen | före passagen |
| i nästa öppning, 08:59–09:05 | före, 22–28 min ledtid | före, 25–31 min ledtid |

- Bara den mellersta raden gör A bättre, och där korsade ingen annan båt.
- Den översta och den nedersta raden är de troliga, och där är utfallet lika.
- Att fönstrets slut nu stämmer med samplen gör A riktigare i U2-mening, men det visar inte att
  varningen blev rättare för hennes passage. U13 kräver det senare.

> Rättelse mot revision 2: där stod "590 m i 8,5 kn räcker till 08:25:25". Rätt är 587 m på 134 s,
> alltså 08:26:31. Slutsatsen står sig.

### 4.2 20260601-41h AMALIA II (265759700) vid Stridsbergsbron söderut 2026-06-03 — likvärdig

- I A kommer varningen 08:41:59,375 i stället för 08:42:59,896 (`#31`). Kedjan av återabsorptioner blir
  #24 → #26 → #23 → #28 → egen, mot #24 → #26 → #28 → egen (J13+J33).
- **Rådata:** korsningen är inferred, med sampelfönstret 08:16:56,814–08:47:23,353. Båda varningarna
  ligger i fönstret och vilar på samma fix från 08:16:56 (2347 m, 25–26 min gammalt). O2 ger `ACCEPTERAD
  AVBRUTEN_APPROACH` i båda.
- **Bedömning: likvärdig.**

### 4.3 20260713-41h ELFKUNGEN (265573130) vid Klaffbron norrut 2026-07-14 — likvärdig

- I A kommer varningen 10:27:14,518 i stället för 10:27:42,855 (`#19`), på samma fix (1057 m, eta okänd).
- **Rådata:** korsningen är inferred, med sampelfönstret 10:10:50,563–10:32:50,940. Båda varningarna
  ligger i fönstret, 28 s isär. Raden finns inte i O1b:s eller O2:s listor.
- **Bedömning: likvärdig.**

### 4.4 Vad A vinner i stället

A vinner bara i buggjägarens syntetiska världar, där sanningen är känd. Det gäller tysta båtar som
enligt U2 hörde till NÄSTA öppning. Där kommer A:s tidigare täckningsslut före hennes korsning.
- Klustersvepet: 4 världar till blir BORTA (331, 510, 790, 1139).
- Standardprofilen: 3 färre missar eller korta ledtider (790, 1139, 510).
- Samma tidigare slut ger fler falsklarm av U17-slaget. Standardprofilen: 7 fler varningar efter sann
  passage och 1 fler på fruset fix. Snabbprofilen: världarna 5, 21 och 56.

Detaljerna står i DESIGN.md §3.5. Ingen av banken rader kan avgöra saken: alla tre raderna i §4.1–4.3
ligger i inferrerade fönster.
