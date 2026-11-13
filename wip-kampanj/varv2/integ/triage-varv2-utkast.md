## Rättningskampanjens varv 2 (2026-11-09)

Ägaren beslutade att ett andra varv skulle köras på de restkort som inte gäller ETA:
- F02, T2 LEDTID (9 världar);
- F05, T2 OKLASSAD (11 fynd);
- F06, T3 VARNING-EFTER (10 fynd);
- F07, T3 FRUSET-FIX (2 världar);
- F08, stress (1);
- B01, KONFLIKT D1-KAJZON-DEMOTION.

Två triagerare gick igenom fynden värld för värld. Mekanismerna rättades i sex familjer, och varje familj granskades adversariellt och reviderades tills den godkändes. Granskningarna hittade verkliga fel som provvärldarna missade:
- falska varningar vid GPS-utliggare (A);
- tidiga varningar vid Järnvägsbron när en klass B-båt sänder glest (D);
- att motorns U17-villkor först litade på appens egna flaggor (E).

| Commit | Familj | Rättning | Världar |
|---|---|---|---|
| 811c723 | A | Målbron i samma tick som en bekräftad vändning (NEW_JOURNEY och RE_CROSS), med riktningskontroll och under-bro-vakt | 936, 1208, 1274, 1316, 1317, 1918 |
| b6a4002 | C | Återfödd båt med kurs i dödbandet får målbro ur förflyttningen | 756, 977, 1913 |
| c798e9b | F | U23: köaren vid Kajen står kvar. Kajavgången inne i kapseln och köbeviset genom en kapsel | 313 och kajköerna |
| b38eabc | B | Bakkantens färskhet mot korsningen, krypfartens fysik och U24: egen varning före första passagen | 790, 979, 1094, 1476, 1794 |
| 25862ee | D | Spärren vid en tidigare bro: rask fart efter bron vid onormal tystnad, aldrig före bron | 263 |
| 7b449bb | motorn | U17/K-NÄSTA på appens dom med oberoende fysik, fixtid, gemensam RECOVER, kajpredikatet, U23/U24-posterna och radiomodellen vid avgång | 941, 972, 138, 290, 625 med flera |

Övriga fynd var redan beslutade beteenden som motorn tidigare missade. Exempel är U17-släppen vid täckningsslutet (1973, 537, 625, 1337, 1629, 1752, 479) och K-NÄSTA (510, 1704).

**Ägarens beslut under varv 2:**
- **U23 (kajen norr om Klaffbron):** en båt på väg mot Klaffbron som stannar vid Kajen behandlas som i resten av väntområdet. Hon står kvar tills hon kör vidare, sänder navStatus 1/5 eller har legat stilla i 2 timmar. Andra båtar vid Kajen, och Gästhamnen, behandlas som förut.
- **U24 (C-IV väg b, smal):** en båt i en avfyrad händelse utan bokförd passage får sin egen varning när hennes egen tidsfrist går ut, i stället för vid täckningsslutet. Det gäller när hon är i rörelse, mer än 350 m från bron och efter fönstret enligt båda prognoserna. Ägaren godtog att en köande konvoj ibland får en extra varning.
- **M6 (spärren vid Järnvägsbron):** dirigenten valde den smala varianten EFTER-BRON, eftersom den inte har någon uppmätt kostnad i form av för tidiga varningar eller fantomer.

**Omlåst facit enligt U13**, med rådatabelägg i corpora.js-noterna:
- **20260806-42h:** S/V REBEL:s varning återställd, Klaffbron södergående 18 → 19. Fältappens varning kom 105 s före korsningen.
- **20260713-41h:** två övergångar blir "ETA okänd" för en båt i kö vid Järnvägsbron. Den gamla texten var fel med 41 min.

**Motorn efter varv 2.** Körningen är `npm run hunt`, standard, seed 1, på 7b449bb.
@@UTFALL@@

**Kvar efter varv 2** (frågor till ägaren och kända gränser):
@@KVAR@@
