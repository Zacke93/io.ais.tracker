'use strict';

const { validateInvariants } = require('./replay-validation/invariants');

// U65 (ägarens beslut 2026-11-24): köbeviset vid målbron ger vänttexten
// "väntar vid <bro>" och bär aldrig "strax". En "strax" som står över 35 min
// utan passage kan därför bara förklaras av köaren vid Kajen (U23), vars väntor
// harnessen bokför för sig i confirmedQuayWaits. Ett resultat utan det fältet
// (äldre fixturer) prövas som förut mot alla bekräftade väntor.
describe('INV-10 efter U65: bara en kö vid Kajen förklarar en lång strax', () => {
  const t = Date.parse('2026-11-24T08:00:00Z');
  const slut = t + 3 * 3600000;
  const bridge = 'Klaffbron';
  const result = {
    notifications: [],
    targetPassages: [],
    bridgeTextTransitions: [
      { t, iso: new Date(t).toISOString(), text: `En båt på väg mot ${bridge}, beräknad broöppning strax` },
      { t: slut, iso: new Date(slut).toISOString(), text: 'Inga båtar är i närheten av Klaffbron eller Stridsbergsbron' },
    ],
  };
  const hela = { bridge, from: t, until: slut };
  const zombies = (extra) => validateInvariants({ ...result, ...extra }).filter((v) => v.startsWith('STRAX-ZOMBIE'));

  test('en väntan med köbevis vid målbron förklarar inte längre en lång strax', () => {
    expect(zombies({ confirmedTargetWaits: [hela], confirmedQuayWaits: [] })).toHaveLength(1);
  });

  test('en bekräftad kö vid Kajen förklarar den', () => {
    expect(zombies({ confirmedTargetWaits: [hela], confirmedQuayWaits: [hela] })).toEqual([]);
  });

  test('en kö vid Kajen som slutar före nästa textbyte förklarar den inte', () => {
    expect(zombies({ confirmedTargetWaits: [hela], confirmedQuayWaits: [{ bridge, from: t, until: t + 10 * 60000 }] }))
      .toHaveLength(1);
  });

  test('en kö vid en annan bro förklarar den inte', () => {
    expect(zombies({ confirmedTargetWaits: [hela], confirmedQuayWaits: [{ ...hela, bridge: 'Stridsbergsbron' }] }))
      .toHaveLength(1);
  });

  test('ett äldre resultat utan confirmedQuayWaits prövas som förut', () => {
    expect(zombies({ confirmedTargetWaits: [hela] })).toEqual([]);
    expect(zombies({ confirmedTargetWaits: [] })).toHaveLength(1);
  });
});
