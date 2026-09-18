# J17: verifierade fältföljder 2026-09-18

J17 förnyar en aktiv resas 30-minuterstimer vid en bokförd passage med
rent positionssegment ≥50 m, råfart ≥1 kn och nästa målbro framför båten.
Låg/okänd råfart och GPS-osäkerhet får inte undantaget. AKIRA- och
MISTY-stoppen är oförändrade. En godtycklig gräns för föregående AIS-glapp
skulle däremot utesluta verkliga fortsatta resor nedan.

Kontrollen jämförde identiska råfiler och aktuell app med enbart J17-undantaget
av/på, samt spårade faktiska raderingar och brotextens fartygsmedlemmar.
Tiderna nedan är UTC. Detta underlag motiverar de berörda ändringarna i
förväntade apphändelser och texttider. Rå AIS och oberoende passagefacit
är oförändrade; den samlade låsningen beskrivs i
[fältgranskningen](faltgranskning-2026-09-18.md).

## ANTARES, 20260710-13h

MMSI `230167390`, råfil
`tests/replay-validation/corpora-data/ais-replay-20260710-015254.jsonl`.
Fixarna nedan är från 2026-07-10.

| Råfix | Latitud, longitud | Fart | Bevis |
| --- | --- | --- | --- |
| 11:35:04.852 | 58.287056667, 12.286168333 | 2,5 kn | Järnvägsbron passerad, Klaffbron framför; 11 min 58 s sedan föregående fix |
| 11:49:37.640 | 58.275033333, 12.278840000 | 1,7 kn | Klaffbron passerad, fortfarande norr om Olidebron |
| 11:56:04.963 | 58.270086667, 12.271701667 | 4,2 kn | Söder om Olidebron: faktisk korsning av dess brolinje |

Före J17 raderades båten 11:53:06.491, bara 3 min 29 s efter den färska
Klaffpassagen. Med J17 består resan och Olidepassagen registreras
11:56:04.963. De sex notiserna för ANTARES är oförändrade, utan dubbletter.

Textpost 97 flyttar från 11:54:34.397 till 11:54:30.040. Texten är identisk:
Klaffbron får ”ETA okänd” och Stridsbergsbron ”strax”. Samma fartyg ingår
i båda fallen: PILOT 761 och VIRGO samt den mållösa DELFIN i indata.
ANTARES visas inte där. Skillnaden följer av att dess tidigare radering
inte längre utlöser samma UI-uppdatering.

## SENTA, 20260712-25h

MMSI `230198250`, råfil
`tests/replay-validation/corpora-data/ais-replay-20260712-174434.jsonl`.
Fixarna nedan är från 2026-07-13, under korpusens andra dygn.

| Råfix | Latitud, longitud | Fart | Bevis |
| --- | --- | --- | --- |
| 15:35:47.053 | 58.285100000, 12.284298333 | 1,5 kn | Järnvägsbron passerad, Klaffbron 114 m framför |
| 15:50:47.297 | 58.273290000, 12.276065000 | 3,0 kn | Klaffbron passerad, Olidebron 82 m framför |
| 16:01:49.998 | 58.266023333, 12.264598333 | 0,1 kn | Söder om både Olidebron och Kanalinfarten |

Före J17 raderades båten 16:00:47.247, en minut före nästa verkliga fix.
Med J17 består resan och den fysiska Olidekorsningen registreras
16:01:49.998. Det är två rapportglapp på cirka 15 respektive 11 minuter,
inte ett obrutet 26-minutersglapp.

Kanalinfartsnotisen kommer exakt samma tid, med samma MMSI, bro, sydriktning
och `alreadyPassed=true`. Texten ändras från ”SENTA passerade Kanalinfarten
under AIS-tystnad” till ”SENTA har passerat Kanalinfarten”. Den sammanhängande
resans `trigger-point`-bevis ersätter återfödelsens `passage-fallback`.
Diagnostikavståndet blir segmentets närmaste avstånd 74 m i stället för
den nya punktens avstånd 355 m. Båda texterna beskriver en redan passerad
punkt; ingen ankomst fabriceras. SENTA har fortsatt exakt sex notiser och
hela korpusen 85, utan någon tillagd notis.

## Två följder av ändrad städtid

**20260702-2h, HAJH-LAIF `265800960`:** sista fixen 11:55:11.611
(58.290353333, 12.290278333, 2,4 kn) följs först 12:25:37.829 av nästa.
J17-timern raderar vid exakt 30 minuters AIS-tystnad, 12:25:11.611.
Tidigare sköt brolägets skyddszon fram timerkontrollen, och raderingen
skedde först vid återkomsten 12:25:37.829. UI-samordningen får därför
andra utlösningstider. Följande tre texter och deras fartygsmedlemmar
är identiska före/efter; notiser och passagehändelser är också identiska.

| Textändring | Före | Efter |
| --- | --- | --- |
| Två båtar mot Stridsbergsbron, 7 minuter | 12:25:37.839 | 12:26:07.889 |
| Samma grupp, strax | 12:26:44.538 | 12:26:38.534 |
| Två mot Klaffbron, 6 minuter; en mot Stridsbergsbron, strax | 12:27:14.598 | 12:26:44.563 |

**20260806-42h, VALKYRIA `275049245`:** sista fixen 2026-08-07
15:19:13.221 (58.274510, 12.278160, 5,5 kn) är efter Olidebron.
J17-timern raderar 15:49:13.221, exakt 30 minuter senare, i stället för
15:58:05.143 efter den gamla skyddszonsförlängningen. Båten hade redan
försvunnit ur texten enligt dess 15-minutersgräns. Den ändrade UI-utlösningen
flyttar FARUREJs identiska 17-minuterstext från 15:50:00.393 till
15:49:30.358. Enda medlemmen är i båda fallen FARUREJ `261005370`.
Alla händelser, notiser och textinnehåll är oförändrade.

## Regressioner

`tests/j17-continuing-passage-retention.test.js` kör ANTARES och SENTA genom
hela appen med och utan minutstädning. Testerna kräver obruten resa genom
Olidepassagen, rätt bokföringstid för den rådatabevisade korsningen och exakt en notis per bro/triggerpunkt
för varje båt. Samma fil prövar det syntetiska 19-minutersglappet samt att
AKIRA/MISTY inte får längre livslängd eller spöktext.
