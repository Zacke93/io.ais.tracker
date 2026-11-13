# Omgranskning av familj F (KAJ, U23), revision 1

Granskat: 1893af8 (cf43811, f166adf, c5fdb1c, abaeafe, 1893af8) i V/F/rwt. Jämfört mot
revision 0 (3887254, V/F/pwt) och c14938f (V/F/bwt). Prober ligger i V/F/pwt2 (1893af8,
okommittad). Körningar och scenarier finns i R2 = V/F/rtmp2.

## Dom: ÄNDRINGAR KRÄVS (två små rättningar i app.js, M3 och L1)

- Båda omlåsningarna är tillåtna enligt U13. Varje ändrad rad är rättare enligt rådatan, och inget
  annat i korpusarna rör sig.
- M1 a/b, M1 c, M2 och L3 håller.
- M3 och L1 har vart sitt fel i ett rimligt brusfall. Där ger revision 1 fel beteende som
  revision 0 inte gav. Båda har en provad rättning på en rad.

## 1. Omlåsningarna (U13)

### 20260806-42h: Klaffbron:southbound 18 → 19 (M3). Tillåten.

**Rådata:**
- Fältappen varnade Klaffbron#19 2026-08-07T08:44:41.922 vid 249 m, eta 2 min
  (field-facit/20260806-42h/field-openings.txt:19).
- Rådatafacit, tests/replay-validation/gt-passages/20260806-42h.json, `kind: line`, observerad:
  korsning 08:46:26.407, dp 251 m och dq 239 m.
- Den återställda varningen Klaffbron#24 08:44:41.473 vid 249 m kommer 105 s före korsningen, vid
  samma fix som i fält.

**Resultatet:** alla fält jämförda mellan revision 0 och revision 1 (R2/cmp.py).
- openingWarnings +1, exakt REBEL:s varning, och openingSuppressions −1, exakt
  `same-arrival`-spärren. Golden-events-diffen innehåller bara de två posterna och ingen
  omnumrering.
- Notiser, text, passager och täckning är bitlika.
- Olåsta `confirmedTargetWaits` går från 6 till 7. Den nya posten är SKYBIRD, som köade långsamt
  289–228 m från bron efter transit genom Gästhamnens kapsel (10:34:35, 32 m från linjen,
  2,9 kn). Det är en äkta kö och följer av M1 c.

**O1/O2** (min körning, rbatt mot rbatt2):
- O1 36/36 före och efter. Den stora skillnaden är att REBEL:s passage dag 2 förut "täcktes" av
  dag 1:s varning (ledtid 1 336 min). Nu bär hon sin egen.
- O2 21 → 22 bekräftade inom 20 min, i både app- och rådataserien.
- Inga röda.

### 20260713-41h: golden-text 264 → 262 (M1 c). Tillåten.

Bara två övergångar ändras (R2/cmp.py). Allt annat är identiskt: notiser 165, öppningar,
passager och täckning. Båda raderna gäller LINNEA (265764760).

Rådatan för LINNEA:
- Fix i Kajens kapsel 09:04:18 i 3,1 kn.
- Sista fix 09:07:49, 245 m före Järnvägsbron i 2,4 kn.
- Tyst till 09:32:17. Därefter stilla 124–128 m före Järnvägsbron till 09:53:18.
- gt: Järnvägsbron 09:54:07 och Stridsbergsbron 09:55:48.

| Tid | Revision 0 | Revision 1 | Bedömning |
|---|---|---|---|
| 09:13:00 | "om cirka 2 minuter" (extrapolerat från 09:07:49, alltså cirka 09:15) | "ETA okänd" | Hon korsade 41 min senare. Mekanismen är app.js:7144–7161: mjuk ålder plus `queueAhead` (kö vid en tidigare bro) ger ingen extrapolering. M1 c ger bara tillbaka det bevis koden förväntar sig. **Rättare.** |
| 09:36:30 | "Två båtar …, om 13 minuter" | "ETA okänd" | 13-siffran var LINNEA:s ETA vid 0,1 kn efter `ETA_GAP_RESET` (13,9 min, påhittad ur golvfarten). I revision 1 ger kedjans egen regel `ETA_POST_TRANSITION_HOLD` "unknown" i stället. BLESSING korsade efter 9 min och LINNEA efter 19 min, och bridgeTextFormat säger att en stilla kö vid en tidigare bro inte får någon minutprognos. **Rättare.** |

U22: ingen kod i ETA-kedjan är ändrad, men två ETA-klausuler i ett låst facit ändras. Noten säger
det, så ägaren ser det.

## 2. Adversariella prov

**M1 a/b (harnessen):** rätt. X1kaj och K150 ger 0 fatala. Grenen godtar bara en båt som
`holdsQuayQueue` håller, med färsk position och minst 60 s stillhet. `until` begränsas av
positionens ålder, så en inaktuell zombie kan inte maskeras.

**M3 (kajavgång efter 50 m mot bron):**
- **(medel) Ett GPS-hopp ger en falsk varning.**
  - En förtöjd båt med aktiv ankomst får en enda fix 60 m mot bron i 0,6 kn, utan GPS-hoppflagga.
    Det ger `MOORED_RELEASED` och `TARGET_CHANGE` (ACCELERATED), sedan `OPENING_QUAY_DEPARTURE`
    och en varning vid 226 m.
  - Det gäller A5n5 (navstatus 5) och A5n0. Revision 0 ger ingen varning.
  - I A5q (förtöjd av 2 h-gränsen) förbrukar den falska varningen ankomsten, och den **verkliga
    avgången får ingen varning**. Revision 0 ger 57 s.
  - Rättning (R2/probe-m3-rimlighet.diff): kräv ett rimligt steg sedan föregående fix,
    `stepM ≤ 20 + dt·sog·0,514·2`, med `vessel.lastPosition` och `entry.lastFixTs`.
    - A5 ger ingen falsk varning, och den verkliga avgången varnas (57 s).
    - K150, KNAV5 och B2 är kvar på 73 s.
    - 42h är bitlik (REBEL kvar).
    - 206 av 207 kajtest är gröna. Testet "M3: bekräftat stopp i Gästhamnen…" saknar
      `lastPosition` i fixturen.
- **(låg, ägarens avvägning) Äkta omförtöjning mot bron inne i Kajen.**
  - A4: 100 m med fix var 10:e sekund ger en varning 62 min före korsningen.
  - A4n0: utan navstatus får den verkliga avgången sedan ingen varning.
  - Det är priset för M3:s enfixsregel, som REBEL behöver med gles AIS. Dokumentera det.
- **Ingen falsk varning** i A1 (Gästhamnen → Kajen → bron), A2 och A2nav0 (flytt 60 m). Där är
  revision 0 och revision 1 lika.

**L1 (`heldAsQueue` över omstart):**
- **Som avsett:**
  - B1 (90 min kö, omstart efter 30 min) får ingen andra varning, som farleden.
  - B2 (150 min) får efter 2 h sin varning vid 168 m, 73 s före korsningen.
  - X2kaj, X5kaj och K60 är oförändrade.
- **(medel) L1 kan hålla kvar en båt som 2 h-gränsen har förtöjt.**
  - En ensam fartspik på 0,6 kn vid kajen (samma position) raderar det obekräftade stoppet, och
    nästa fix startar ett nytt med senare `firstFixTs`. VDS:s stillhetsklocka startar inte om.
  - Prov B3 (K150 med spik 09:27:38):
    - backstoppen förtöjer henne 10:28 som vanligt;
    - minnet håller ändå "samma ankomst" till 11:28;
    - avgången 10:58 får ingen varning, och ingen `OPENING_QUAY_DEPARTURE`.
  - Revision 0 ger varningen (101 m).
  - Rättning (R2/probe-m3-l1.diff): `keptQueue` kräver också att
    `Date.now() − vessel._stationarySince < MAX_STATIONARY_WAIT_MS`. Efter en omstart är klockan
    ny, så L1 fungerar som förut.
    - B3 får 73 s.
    - B1, X2kaj, X5kaj och K60 har fortfarande ingen andra varning.
    - B2 och K150 har 73 s.
- **(låg) Testet "L1: en båt som klassningen aldrig höll…"** fäller revision 0 bara på det nya
  fältet `heldAsQueue: false`. Beteendet är detsamma.

## 3. Noter och dokument

- **corpora.js:**
  - 42h-noten stämmer: tiderna mot linjefacit, fältets kort, O1/O2 och "normal och monitoring
    lika".
  - 41h-noten stämmer rad för rad. Mekanismen (app.js:7144–7161, `queueAhead`) nämns inte. Lägg
    gärna till den.
- **Dokumenten:**
  - ARCHITECTURE §lager 4, constants och reliability-spec B1 lovar nu rätt sak för 300–320 m.
  - Helgranskningsposten är markerad rättad.
  - ARCHITECTURE anger 77 s, men min interpolerade korsning ger 73 s. Det är skillnad i metod.

## 4. Batteriet och quick (1893af8, V/F/rbatt2)

**Batteriet:** alla steg har slutkod 0.
- jest 370 sviter (5 289 godkända, 2 hoppade);
- lint;
- replay:all med och utan monitoring (alla låsta korpusar matchar facit);
- synthetic och openings;
- soak med och utan monitoring;
- fassvepet med och utan monitoring;
- självtestet GRÖNT;
- porcelain visar bara `?? node_modules`.

**Revisionstesten mot revision 0** (filerna kopierade till pwt): 6 fel av 94 (M3 1, L1 4, M1 c 1).

**Quick mot V/bas/quick:**
- 40 → 42 råa utslag. Kandidatklustren är **3 → 3** (inget nytt).
- Nytt är MÄTGRÄNS-INV10-VÄNTKEDJA (värld 129, tidigare KANDIDAT F05). U17-TYST-BÅT-RECOVER har
  ökat från 7 till 8 (värld 235).
- Min quick är identisk med familjens V/F/batt-rev1/hunt-quick.

**Rättningsskisserna** (pwt2: M3-rimlighet och L1-klocka): `runAllCorpora` ger "Alla låsta
korpusar matchar facit" med slutkod 0.

## 5. Vad som krävs

1. **M3:** kräv ett rimligt steg sedan föregående fix för avgång inne i kajzonen
   (R2/probe-m3-rimlighet.diff). Ge testfixturen `lastPosition`, och lägg till ett test för
   GPS-hoppet (A5).
2. **L1:** släpp minnet också när klassningens stillhetsklocka (`_stationarySince`) har nått
   MAX_STATIONARY_WAIT_MS (R2/probe-m3-l1.diff), med ett test för fartspiken (B3). Alternativt:
   behåll den hållna starten när stoppet ersätts.
3. **Dokumentation:** omförtöjning inne i Kajen (A4) som ägarens avvägning för M3, och mekanismen i
   41h-noten.
