# R2: facitförflyttningar (revision 2, efter omgranskningen)

**Inget låst facit flyttas.** Det gäller den första prototypen `e0e8124`,
revision 1 `8318c1a` och revision 2 `c02d88e`. Det finns därför ingen rad att
bedöma enligt U13, och ingenting behöver låsas om.

## Så är det mätt

1. **Hela banken, rad för rad.** Alla 24 korpusar i `corpora.js` kördes med
   `replayRunner.js`, både normalt och med `REPLAY_MONITORING=1`, i `7699cbe`
   och i revision 2 (`K/R2/tmp/scripts/snap.js`, utdata `K/R2/tmp/snap-rev2/`).
   Jämförelsen (`K/R2/tmp/scripts/diffsnap.py`) gäller varje notis (tid, båt,
   bro, riktning, ETA, `already_passed`, källa, meddelande), varje
   öppningsvarning (tid, bro, riktning, händelse, ETA, medlemmar, utlösare),
   varje målpassage, varje mellanpassage, varje brotextövergång och varje
   resaåterställning. Resultat: **0 korpusar med skillnad** (48 körningar,
   0 fel; `K/R2/matningar/bank-snapshot-diff.txt`).
2. **`npm run replay:all`**, normalt och med `REPLAY_MONITORING=1`: alla låsta
   jämförelser gröna, och loggarna är ordagrant lika med revision 1:s.
3. **`npm run replay:openings`**: utdata ordagrant lika med baslinjen
   (O1 376/378, O1b 391/447).

## Varför inget flyttas, fast tre fel rättas

- **F12/F16.** Bankens enda kandidat som släpps (MARY 219028537,
  `20260806-42h`, Stridsbergsbron 11:46:51) bekräftades i baslinjen i samma
  tick som normalvägen bokförde bron. Studsvakten behöll ankaret och
  `passageId` var redan bokfört, så ingen andra bokföring blev av. Nu släpps
  kandidaten redan vid bokföringen. Utfallet är detsamma.
- **F13.** Nordprogressregeln slår aldrig till i banken, varken i dödbandet
  eller utan kurs. En instrumenterad kopia av revision 2 loggade alla 26
  BN2-prövningar där bron låg mellan positionerna (13 per läge, samma 13
  notiser som låstes 2026-11-03). Alla 26 hade färdriktning före regeln: 22 ur
  ruttlåset (4 av dem med dödbandskurs) och 4 ur nordbandet
  (`K/R2/matningar/bn2-banken.txt`). `tests/bn2-tp1-radatalas.test.js` är
  grönt.
- **F08.** De tre bankfall där inträdesbeviset bär en senare passage (OSPREY
  `20260601-41h`, SINE BRES `20260917-16h`, NINA B `20260918-7h`) fick beviset
  i ett senare pass vid samma position redan i baslinjen. Nu kommer det i
  meddelandepasset, sparas, och återställs när zonbesöket startar (25 ms till
  60 s senare, i samma läge som basens senare pass gav). Passagerna bokförs vid
  samma fix som förut:
  - OSPREY: rå-GT 2/6 09:57:07,019–09:59:39,605, bokförd 10:02:39,828;
  - SINE BRES: rå-GT 18/9 02:26:08,016–02:26:30,446, bokförd 02:27:17,778;
  - NINA B: rå-GT 18/9 17:31:26,104–17:32:34,469, bokförd 17:34:15,400.

  FIX O-grenens nya anrop körs 3 gånger per läge i banken (ANTJE och JEANNELLE i
  `20260804-both-21h`, 265573130 i `20260909-80h`). Båtarna låg 38–50 m före
  Stridsbergsbrons linje och hade inte korsat den, så inget bevis sätts och
  inget utfall ändras.

## Det som ändras (utanför låst facit)

Ändringarna syns bara i fasvarianter, i granskarnas prov, i egna prov och i
syntetiska världar. Alla är belagda mot sanningen. Ingen rad är sämre.

| Var | Dimension | Ändring | Belägg | Bedömning |
| --- | --- | --- | --- | --- |
| `20260917-16h`, δ −2,5, −5 och −7 s (M-FAS och omgranskningen) | passage | SINE BRES Järnvägspassage bokförs 02:27:17,778 (förut tappad) | rå-GT 02:26:08,016–02:26:30,446, från 94 m före till 26 m efter linjen; bokförd vid samma fix som basen | rättare |
| Granskarens prov: `20260917-16h` med en extra fix 45 m söder om linjen 02:26:41,6, δ 0, −2,5, −5, −7, −11,52, −15, −20 och −25 s | passage | SINE BRES Järnvägspassage bokförs 02:27:17,778 i alla 8 (förut tappad i alla 8, i både `7699cbe` och `e0e8124`) | samma rå-GT som ovan; den extra fixen ligger efter korsningen, på linjen B→C, och ändrar inte korsningen | rättare |
| Granskarens prov: samma med extra fix 02:27:05 | passage | bokförs i alla 8 (förut tappad vid δ −2,5, −5 och −7 s) | samma | rättare |
| Eget prov (revision 2): `20260917-16h` med en extra fix 02:26:41,6 på 49,1 m, δ 0 | passage | bokförs 02:27:17,778 vid C (förut tappad) | samma rå-GT; fixen ligger efter korsningen | rättare |
| Eget prov (revision 2): samma med extra fix på 60,4 m och 62,9 m | passage och notis | passagen bokförs 02:26:41,600 vid den extra fixen (förut tappad), och notisen där blir "SINE BRES har precis passerat Järnvägsbron" i stället för "SINE BRES närmar sig Järnvägsbron, beräknad ankomst strax" | samma rå-GT; den extra fixen ligger 60–63 m efter linjen, efter korsningen (senast 02:26:30,446), så bokföringen och den passerade formen kommer efter passagen | rättare |
| Eget prov och granskarens v4 (revision 2): samma med extra fix på 50,7, 54,8 och 58,8 m | passage | tappad, som i `7699cbe` (känd lucka i METHOD 1, DESIGN §9) | samma rå-GT; utfallet är identiskt i bas och prototyp, i alla 8 faser för 58,8 m | likvärdig (oförändrad) |
| värld 254 (JOLLY) | passage | andra bokföringen av Stridsbergsbron 16:16:49,875 (gate-confirmed mellanbro) försvinner; notiser, öppningar och brotexter oförändrade | L0: en enda korsning 16:01:52 söderut, därefter kö 126 m söder om bron i 19 min | rättare |
| värld 86 (SALTIS) | notis | Olidebron: "närmar sig …, beräknad ankomst om 1 minut" → "SALTIS passerade Olidebron under AIS-tystnad", eta −1, `already_passed` | L0: korsning 08:56:38,99 norrut, notisfixen 08:57:32 ligger 115 m bortom linjen | rättare |
| värld 86 med kursen 360 eller null på återfödelsefixen (granskarens repro, revision 2) | notis | samma ändring som raden ovan (förut "närmar sig" även i revision 1) | samma L0-korsning 08:56:38,99 norrut; notisfixen ligger 116 m bortom linjen; nordprogressen 1,97 m/s | rättare |
| värld 783 (okänd båt) | notis | Olidebron: förvarningsform → passerad form | L0: korsning 10:54:31 norrut, notisfixen 10:55:19 ligger 107 m bortom linjen | rättare |

Jämförelserna rad för rad:

- Granskarens 16 varianter: bara SINE BRES Järnvägspassage ändras. Notiser,
  öppningar, brotexter och övriga passager är identiska med `7699cbe`
  (`K/R2/tmp/rev/cmp`, jämfört med `diffsnap.py`).
- Revision 2 mot revision 1 (`K/R2/tmp/rev2/cmp/r1-mot-rev2.txt`): SALTIS med
  kursen 360 och null skiljer bara i Olidebron-notisen. Världarna 86, 783, 254,
  1227 och 1731 är identiska.
- De egna proven med en extra fix (`K/R2/tmp/rev2/band-base.jsonl` och
  `band-wt.jsonl`, fingeravtryck per del): vid 49,1 m skiljer bara
  mellanpassagen; vid 60,4 och 62,9 m skiljer mellanpassagen och notisen vid
  den extra fixen; vid 50,7, 54,8 och 58,8 m är allt identiskt med `7699cbe`.
- Hela världarna 254, 86, 783, 1227 och 1731 mot `7699cbe`: utöver tabellens
  rader skiljer ingenting, och 1227 och 1731 är helt oförändrade.
