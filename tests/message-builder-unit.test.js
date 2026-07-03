'use strict';

const MessageBuilder = require('../lib/utils/MessageBuilder');

/**
 * Enhetstester för MessageBuilder — kontraktstester för meddelandebyggaren.
 *
 * OBS (upptäckt vid granskning 2026-07-03): MessageBuilder require:as INTE av
 * någon produktionsfil — BridgeTextService bygger sina strängar inline via
 * formatETABroOpeningClause (SSOT i etaValidation). Testerna nedan låser ändå
 * modulens publika kontrakt (karakteriseringstester), inklusive två KÄNDA
 * anomalier som dokumenteras med kommentar vid respektive test:
 *   A1) buildUnderBridge (mellanbro-grenen) ger dubbelt "av" i ETA-suffixet.
 *   A2) ETA-parametern är en färdigformaterad text — modulen lägger själv
 *       till prefixet "beräknad broöppning", så anroparen måste skicka
 *       "om N minuter"-form (inte formatETA:s "N minuter").
 */
describe('MessageBuilder — bridge_text-byggstenar (kontrakt)', () => {
  let builder;

  beforeEach(() => {
    const logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    builder = new MessageBuilder(logger);
  });

  describe('buildETASuffix — ETA-suffix', () => {
    test('null/undefined/tom sträng ger tomt suffix', () => {
      expect(builder.buildETASuffix(null)).toBe('');
      expect(builder.buildETASuffix(undefined)).toBe('');
      expect(builder.buildETASuffix('')).toBe('');
    });

    test('utan målbro: ", beräknad broöppning <eta>"', () => {
      expect(builder.buildETASuffix('om 5 minuter'))
        .toBe(', beräknad broöppning om 5 minuter');
    });

    test('med målbro: ", beräknad broöppning av <målbro> <eta>"', () => {
      expect(builder.buildETASuffix('om 5 minuter', { targetBridge: 'Klaffbron' }))
        .toBe(', beräknad broöppning av Klaffbron om 5 minuter');
    });

    test('eget prefix respekteras', () => {
      expect(builder.buildETASuffix('om 3 minuter', { prefix: 'öppning' }))
        .toBe(', öppning om 3 minuter');
    });
  });

  describe('buildSingle — en båt', () => {
    test('grundform utan ETA och målbro: "En båt <verb> <bro>"', () => {
      expect(builder.buildSingle('närmar sig', 'Klaffbron'))
        .toBe('En båt närmar sig Klaffbron');
    });

    test('med ETA (samma bro som mål): ETA utan "av <bro>"', () => {
      expect(builder.buildSingle('närmar sig', 'Klaffbron', { eta: 'om 5 minuter' }))
        .toBe('En båt närmar sig Klaffbron, beräknad broöppning om 5 minuter');
    });

    test('mellanbro med annan målbro: "på väg mot" + ETA "av <målbro>"', () => {
      expect(builder.buildSingle('inväntar broöppning vid', 'Järnvägsbron', {
        eta: 'om 12 minuter', targetBridge: 'Klaffbron',
      })).toBe(
        'En båt inväntar broöppning vid Järnvägsbron på väg mot Klaffbron,'
        + ' beräknad broöppning av Klaffbron om 12 minuter',
      );
    });

    test('targetBridge === bridge behandlas som målbro (inget "på väg mot")', () => {
      expect(builder.buildSingle('närmar sig', 'Klaffbron', {
        eta: 'om 5 minuter', targetBridge: 'Klaffbron',
      })).toBe('En båt närmar sig Klaffbron, beräknad broöppning om 5 minuter');
    });

    test('eget etaPrefix respekteras', () => {
      expect(builder.buildSingle('passerar', 'Stallbackabron', {
        eta: 'om 8 minuter', targetBridge: 'Stridsbergsbron', etaPrefix: 'beräknad broöppning',
      })).toBe(
        'En båt passerar Stallbackabron på väg mot Stridsbergsbron,'
        + ' beräknad broöppning av Stridsbergsbron om 8 minuter',
      );
    });
  });

  describe('buildMultiple — flera båtar', () => {
    test('alla med samma status: svensk pluralform "Två båtar ..."', () => {
      expect(builder.buildMultiple(2, 'närmar sig', 'Klaffbron', { eta: 'om 5 minuter' }))
        .toBe('Två båtar närmar sig Klaffbron, beräknad broöppning om 5 minuter');
    });

    test('alla med samma status + målbro: "Tre båtar ... på väg mot ..."', () => {
      expect(builder.buildMultiple(3, 'inväntar broöppning vid', 'Järnvägsbron', {
        targetBridge: 'Klaffbron',
      })).toBe('Tre båtar inväntar broöppning vid Järnvägsbron på väg mot Klaffbron');
    });

    test('explicit additionalCount=0 ger samma-status-grenen', () => {
      expect(builder.buildMultiple(3, 'närmar sig', 'Klaffbron', { additionalCount: 0 }))
        .toBe('Tre båtar närmar sig Klaffbron');
    });

    test('ledande båt + ytterligare (additionalCount ≠ 0 och ≠ count-1)', () => {
      expect(builder.buildMultiple(3, 'närmar sig', 'Klaffbron', {
        additionalCount: 1, eta: 'om 5 minuter',
      })).toBe('En båt närmar sig Klaffbron, ytterligare 1 båt på väg, beräknad broöppning om 5 minuter');
    });

    test('ledande båt + flera ytterligare: gemener efter komma ("två")', () => {
      expect(builder.buildMultiple(4, 'närmar sig', 'Klaffbron', { additionalCount: 2 }))
        .toBe('En båt närmar sig Klaffbron, ytterligare två båtar på väg');
    });

    test('antal över tio faller tillbaka på siffra: "11 båtar ..."', () => {
      expect(builder.buildMultiple(11, 'närmar sig', 'Klaffbron'))
        .toBe('11 båtar närmar sig Klaffbron');
    });
  });

  describe('buildWaitingAtTargetBridge — inväntar vid målbro (ALDRIG ETA)', () => {
    test('en båt: "En båt inväntar broöppning vid <bro>"', () => {
      expect(builder.buildWaitingAtTargetBridge(1, 'Klaffbron'))
        .toBe('En båt inväntar broöppning vid Klaffbron');
    });

    test('flera båtar: "Fem båtar inväntar broöppning vid <bro>"', () => {
      expect(builder.buildWaitingAtTargetBridge(5, 'Stridsbergsbron'))
        .toBe('Fem båtar inväntar broöppning vid Stridsbergsbron');
    });
  });

  describe('buildWaitingAtIntermediateBridge — inväntar vid mellanbro (MED mål-ETA)', () => {
    test('en båt utan ETA', () => {
      expect(builder.buildWaitingAtIntermediateBridge(1, 'Järnvägsbron', 'Klaffbron'))
        .toBe('En båt inväntar broöppning av Järnvägsbron på väg mot Klaffbron');
    });

    test('en båt med ETA till målbron', () => {
      expect(builder.buildWaitingAtIntermediateBridge(1, 'Järnvägsbron', 'Klaffbron', 'om 12 minuter'))
        .toBe('En båt inväntar broöppning av Järnvägsbron på väg mot Klaffbron, beräknad broöppning om 12 minuter');
    });

    test('flera båtar med ETA', () => {
      expect(builder.buildWaitingAtIntermediateBridge(2, 'Järnvägsbron', 'Stridsbergsbron', 'om 6 minuter'))
        .toBe('Två båtar inväntar broöppning av Järnvägsbron på väg mot Stridsbergsbron,'
          + ' beräknad broöppning om 6 minuter');
    });
  });

  describe('buildUnderBridge — broöppning pågår', () => {
    test('målbro: "Broöppning pågår vid <bro>" utan ETA (även om ETA skickas)', () => {
      expect(builder.buildUnderBridge('Klaffbron')).toBe('Broöppning pågår vid Klaffbron');
      expect(builder.buildUnderBridge('Klaffbron', { eta: 'om 5 minuter' }))
        .toBe('Broöppning pågår vid Klaffbron');
    });

    test('målbro med ytterligare båtar', () => {
      expect(builder.buildUnderBridge('Klaffbron', { additionalCount: 2 }))
        .toBe('Broöppning pågår vid Klaffbron, ytterligare två båtar på väg');
    });

    // KÄND ANOMALI A1 (rapporterad, ej fixad): prefixet 'beräknad broöppning av'
    // kombineras med buildETASuffix-mallen ", <prefix> av <målbro> <eta>" och
    // ger DUBBELT "av". Testet låser nuvarande beteende som karakterisering.
    test('mellanbro med målbro + ETA — nuvarande utdata har dubbelt "av" (känd anomali)', () => {
      expect(builder.buildUnderBridge('Järnvägsbron', {
        targetBridge: 'Klaffbron', eta: 'om 4 minuter',
      })).toBe('Broöppning pågår vid Järnvägsbron, beräknad broöppning av av Klaffbron om 4 minuter');
    });
  });

  describe('buildPassed — precis passerat', () => {
    test('grundform: "En båt har precis passerat <bro> på väg mot <målbro>"', () => {
      expect(builder.buildPassed('Järnvägsbron', 'Klaffbron'))
        .toBe('En båt har precis passerat Järnvägsbron på väg mot Klaffbron');
    });

    test('med ETA', () => {
      expect(builder.buildPassed('Järnvägsbron', 'Klaffbron', 'om 5 minuter'))
        .toBe('En båt har precis passerat Järnvägsbron på väg mot Klaffbron, beräknad broöppning om 5 minuter');
    });

    test('ytterligare-text kommer FÖRE ETA-suffixet', () => {
      expect(builder.buildPassed('Järnvägsbron', 'Klaffbron', 'om 5 minuter', { additionalCount: 1 }))
        .toBe('En båt har precis passerat Järnvägsbron på väg mot Klaffbron,'
          + ' ytterligare 1 båt på väg, beräknad broöppning om 5 minuter');
    });
  });

  describe('buildApproaching — närmar sig', () => {
    test('utan målbro: "En båt närmar sig <bro>"', () => {
      expect(builder.buildApproaching('Klaffbron')).toBe('En båt närmar sig Klaffbron');
    });

    test('med annan målbro: "på väg mot" men ETA-suffix UTAN "av <målbro>"', () => {
      expect(builder.buildApproaching('Olidebron', {
        targetBridge: 'Klaffbron', eta: 'om 15 minuter',
      })).toBe('En båt närmar sig Olidebron på väg mot Klaffbron, beräknad broöppning om 15 minuter');
    });

    test('med ytterligare båtar och ETA i rätt ordning', () => {
      expect(builder.buildApproaching('Klaffbron', {
        eta: 'om 5 minuter', additionalCount: 3,
      })).toBe('En båt närmar sig Klaffbron, ytterligare tre båtar på väg, beräknad broöppning om 5 minuter');
    });
  });

  describe('buildEnRoute — på väg mot (Variant-1-grammatikens grundform)', () => {
    test('en båt utan ETA: "En båt på väg mot <målbro>"', () => {
      expect(builder.buildEnRoute('Klaffbron')).toBe('En båt på väg mot Klaffbron');
    });

    test('en båt med cirka-ETA (extrapolerad Variant-1-form)', () => {
      expect(builder.buildEnRoute('Klaffbron', 'om cirka 2 minuter'))
        .toBe('En båt på väg mot Klaffbron, beräknad broöppning om cirka 2 minuter');
    });

    test('en båt med ytterligare båtar', () => {
      expect(builder.buildEnRoute('Stridsbergsbron', 'om 20 minuter', { count: 1, additionalCount: 2 }))
        .toBe('En båt på väg mot Stridsbergsbron, ytterligare två båtar på väg, beräknad broöppning om 20 minuter');
    });

    test('flera båtar: pluralform och additionalCount ignoreras (allt räknas i antalet)', () => {
      expect(builder.buildEnRoute('Klaffbron', 'om 10 minuter', { count: 3, additionalCount: 2 }))
        .toBe('Tre båtar på väg mot Klaffbron, beräknad broöppning om 10 minuter');
    });
  });
});
