Spåra ifall båtar åker vid en viss position.

## Installation

1. Klona repot och installera beroenden med `npm install`.
2. Kör `homey app run` för att testa appen lokalt.

## Inställningar

1. Skaffa en API-nyckel från [AISstream](https://aisstream.io).
2. I Homey, öppna appens inställningar och ange nyckeln under "AIS API key".

## Användning

Använd AND-kortet **A boat is near bridge** i ett flöde. Välj vilken bro som ska bevakas så returnerar kortet `true` om en båt passerar inom cirka 300 meter under scansessionen.
