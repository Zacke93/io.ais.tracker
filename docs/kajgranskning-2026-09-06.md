# Kajavgångar inför nästa fältprov

## Bekräftat fel och ändring

DORY MAN (211411410) förtöjer i den kända zonen Gästhamnen norr om
Klaffbron den 7 augusti. AIS ger 14:15:24.408 UTC position
58.28747/12.28550, fart 0,2 knop, och 14:18:44.072 position
58.28754/12.28544, fart 0,3 knop. Zonens tre minuters stillhetskrav är
uppfyllt och appen klassar henne som förtöjd.

14:22:03.132 kommer 58.28747/12.28553, fart 0,6 knop och okänd kurs.
Förflyttningen från föregående position är bara cirka nio meter; från
vistelsens ankare ännu mindre. Det tidigare jitterhållet krävde trots den
redan bevisade förtöjningen ett 30 minuter gammalt ankare. Därför rev
fartprovet klassningen, återinförde Klaffbron som mål och publicerade en
falsk öppningsprognos: 21 minuter, följt av 22 minuter. Båten låg kvar vid
kajen och passerade aldrig Klaffbron i inspelningen.

`VesselDataService._stillnessJitterHolds` accepterar nu också en redan
förtöjdsklassad båt som ligger kvar i en känd kajzon. Kraven på tillförlitlig
GPS-position, befintligt ankare och mindre än 50 meters nettoförflyttning
kvarstår. Första positionen med minst 50 meters rörelse släpper klassningen
som tidigare. Utanför denna etablerade kajvistelse gäller fortfarande
30-minuterskravet; initial klassning, köskydd och radier ändras inte.

## Samtliga uppmätta beteendedeltan

A/B kördes över alla 18 korpusar med samma frysta replay-runner som före
ändringen. Fullständiga notisobjekt, öppningsvarningar, målpassager och
mellanbropassager är byte-identiska i samtliga korpusar. Inga notiser eller
öppningsvarningar tappas eller flyttas. Endast brotexten ändras i två korpusar:

| Korpus | Ändring i brotext |
| --- | --- |
| 20260806-42h | Tar bort DORY MAN:s falska prognoser 14:22:03.157 (21 min) och 14:23:10.587 (22 min), samt återgången till standardtext 14:29:53.296. Antal övergångar 303 → 300. |
| 20260804-both-21h | Två verkliga kajavgångar räknas in först vid nästa positionsbevis. Tre gamla textrader ersätts av två; antal övergångar 314 → 313. Detaljer nedan. |

**ADA (265625860), 5 augusti:** positionen 58.28761/12.28615 kl.
06:42:14.799 går till 58.28758/12.28611 kl. 06:45:40.424: bara 4,1 meters
rörelse trots rapporterade 0,9 knop. Nästa prov 06:46:42.257 ligger
87,4 meter därifrån, på 58.2868067/12.28584 i 2,3 knop, och släpper
klassningen. Texten ”Två båtar på väg mot Klaffbron, beräknad broöppning
strax” flyttar från 06:46:10.484 till 06:46:42.282, alltså 31,798 sekunder.
Den nya texten kommer 69,960 sekunder före den oförändrade notisen
06:47:52.242 på 272 meters avstånd. Geometriskt passagefacit: 06:51:30.573.

**ATHENA (219020486), 5 augusti:** 58.28758/12.2855683 kl.
08:50:55.550 går till 58.28745/12.28573 kl. 08:54:30.826: 17,27 meters
rörelse trots 2 knop. Nästa prov 08:55:23.896 på
58.286645/12.2857167 i 2,1 knop ger 89,52 meters förflyttning och släpper
klassningen. Under dessa 53,095 sekunder räknas endast SIESTA mot Klaffbron:
den tillfälliga textraden med två båtar kl. 08:54:30.851 tas bort och
08:54:31.001 visar en båt/9 minuter i stället för två/6 minuter.
08:55:23.921 visas åter två båtar, vilket är 82,722 sekunder före den
oförändrade notisen 08:56:46.643 på 278 meters avstånd.
Geometriskt passagefacit: 08:59:44.273.

Avvägningen är att räkningen kan vänta ett AIS-prov på tydlig avgång från
en redan konstaterad förtöjning. Här behålls full notis- och öppningsledtid.
En oberoende granskare verifierade båda spåren direkt mot JSONL och
passagefacit och jämförde samtliga tre notiser per båt byte för byte.

## Verifiering och facit

Rådataregressionen i `tests/pre-field-mooring-departure.test.js` var röd före
fixen. Den prövar också avgång med finit fart, avgång utan fartgivare och en
ung farledsväntare. Befintliga mooring-, M1- och N7-prov täcker bland annat
GPS-flaggade positioner, köskydd och förflyttning över 50 meter.

N7:s gamla test för ett 20 minuter gammalt kajankare låste den tidigare
avgränsningen att även en redan förtöjd båt skulle släppas av två 0,4-knopsprov
på plats. Det testet ändras med denna rådatamotivering: klassningen ska
behållas när positionsbevis saknas. Det var inget uttryckligt användarval
att fartbrus skulle räknas som kajavgång.

Endast golden-text för `20260804-both-21h` låses om via
`relockGoldenText.js`, vars övriga dimensioner måste passera oförändrade.
42h-korpusen förblir olåst; inga invariantsignaturer undantas och inga
notis- eller öppningsfacit ändras.
