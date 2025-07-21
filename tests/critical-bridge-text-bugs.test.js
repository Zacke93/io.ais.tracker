/**
 * KRITISKA BRIDGE_TEXT BUGGAR TEST
 * 
 * Fokuserar på specifika bridge_text-problem från användaranteckningar.
 * Använder same approach som main-test-suite men med verklighetstrogna scenarion.
 */

const {
  createProductionBoat,
  createStationaryBoat,
  createProductionMessageGenerator,
} = require('./helpers/production-test-base');

describe('Kritiska Bridge_Text Buggar', () => {
  let messageGenerator;

  beforeEach(() => {
    messageGenerator = createProductionMessageGenerator(false);
  });

  describe('Problem 1: Ankrade båtar som börjar röra sig', () => {
    test('La Cle-scenario: Ankrad båt 370m från Klaffbron som rör sig mot Järnvägsbron', () => {
      // SCENARIO: La Cle ligger ankrad 370m från Klaffbron
      // Börjar röra sig mot Järnvägsbron men kan få fel target bridge
      
      // Steg 1: La Cle som stillastående båt (ska ignoreras i bridge_text)
      const anchoredLaCle = createStationaryBoat(219000001, 'La Cle', {
        targetBridge: null, // Ingen target bridge för ankrad båt
        currentBridge: null, // Inte nära någon bro
        distance: 370, // För långt från Klaffbron
        sog: 0.1, // Nästan stillastående
      });

      // Verify: Ankrade båtar utan targetBridge ska ge fallback message
      const resultAnchored = messageGenerator.generateBridgeText([anchoredLaCle]);
      expect(resultAnchored).toContain('Båtar upptäckta men tid kan ej beräknas'); // Korrekt fallback enligt app.js
      
      // Steg 2: La Cle börjar röra sig mot Järnvägsbron (norrut från Klaffbron)
      const movingLaCle = createProductionBoat(219000001, 'La Cle', {
        targetBridge: 'Stridsbergsbron', // Norrut från Klaffbron → Stridsbergsbron
        currentBridge: 'Järnvägsbron', // Närmaste bro
        etaMinutes: 8,
        status: 'approaching',
        distance: 250, // Närmare Järnvägsbron
        sog: 2.5, // Nu rör sig båten
        isApproaching: true,
        isWaiting: false,
        distanceToCurrent: 250,
      });

      const resultMoving = messageGenerator.generateBridgeText([movingLaCle]);
      
      // Verify: Ska visa korrekt target bridge (Stridsbergsbron, inte Klaffbron)
      expect(resultMoving).toContain('Stridsbergsbron');
      expect(resultMoving).toContain('beräknad broöppning om 8 minuter');
      expect(resultMoving).not.toContain('Klaffbron'); // Fel target bridge
    });
  });

  describe('Problem 2: Båtar försvinner inom 300m protection zone', () => {
    test('Flera båtar vid Järnvägsbron ska inte försvinna samtidigt', () => {
      // SCENARIO: Flera båtar väntar på broöppning vid Järnvägsbron
      // Systemet ska behålla alla inom 300m protection zone
      
      const jasminWaiting = createProductionBoat(219000002, 'Jasmin', {
        targetBridge: 'Stridsbergsbron',
        currentBridge: 'Järnvägsbron',
        etaMinutes: 5,
        status: 'waiting', // VIKTIGT: waiting status
        distance: 80, // Inom 300m protection zone
        sog: 0.2, // Väntar
        isApproaching: false,
        isWaiting: true, // KRITISK FLAG
        distanceToCurrent: 80,
      });

      const parraApproaching = createProductionBoat(219000003, 'Parra', {
        targetBridge: 'Stridsbergsbron',
        currentBridge: 'Järnvägsbron',
        etaMinutes: 7,
        status: 'approaching',
        distance: 250, // Inom 300m protection zone
        sog: 1.5,
        isApproaching: true,
        isWaiting: false,
        distanceToCurrent: 250,
      });

      const result = messageGenerator.generateBridgeText([jasminWaiting, parraApproaching]);
      
      // Verify: Båda båtarna ska synas i bridge_text - 2 båtar totalt = "ytterligare 1 båt"
      expect(result).toContain('ytterligare 1 båt'); // 2 båtar totalt: 1 main + 1 ytterligare
      expect(result).toContain('inväntar broöppning'); // Jasmin har waiting prioritet
      
      // Verify: Ingen ska "försvinna" från meddelandet
      expect(result).not.toContain('Inga båtar');
    });

    test('Under-bridge scenario har högsta prioritet', () => {
      const underBridgeBoat = createProductionBoat(567890, 'Under_Boat', {
        targetBridge: 'Klaffbron',
        currentBridge: 'Klaffbron',
        etaMinutes: 0, // Triggers under-bridge logic
        status: 'under-bridge',
        distance: 15, // Very close
        sog: 0.3,
        isApproaching: false,
        isWaiting: false,
        distanceToCurrent: 15,
      });

      const waitingBoat = createProductionBoat(123456, 'Waiting_Boat', {
        targetBridge: 'Klaffbron',
        currentBridge: 'Klaffbron',
        etaMinutes: 5,
        status: 'waiting',
        distance: 100,
        sog: 0.1,
        isApproaching: false,
        isWaiting: true,
        distanceToCurrent: 100,
      });

      const result = messageGenerator.generateBridgeText([waitingBoat, underBridgeBoat]);
      
      // Under-bridge ska ha högsta prioritet
      expect(result).toContain('Broöppning pågår vid Klaffbron');
      expect(result).not.toContain('inväntar broöppning');
    });
  });

  describe('Problem 3: Passage detection och "precis passerat"', () => {
    test('Jasmin passerar Stallbackabron - ska visa "precis passerat" information', () => {
      // SCENARIO: Jasmin har passerat Stallbackabron och närmar sig Stridsbergsbron
      
      const jasminAfterPassage = createProductionBoat(219000004, 'Jasmin', {
        targetBridge: 'Stridsbergsbron', // Nya målbro efter passage
        currentBridge: 'Stridsbergsbron', // Närmar sig ny bro
        etaMinutes: 6,
        status: 'approaching',
        distance: 400, // På väg mot Stridsbergsbron
        sog: 3.0,
        isApproaching: true,
        isWaiting: false,
        distanceToCurrent: 400,
        // VIKTIGT: "Precis passerat" data
        passedBridges: ['stallbackabron'], // Har passerat Stallbackabron
        lastPassedBridgeTime: Date.now() - 30000, // 30 sekunder sedan
      });

      const result = messageGenerator.generateBridgeText([jasminAfterPassage]);
      
      // Verify: Ska visa "precis passerat" information
      expect(result).toContain('precis passerat');
      expect(result).toContain('Stallbackabron');
      expect(result).toContain('Stridsbergsbron');
      expect(result).toContain('beräknad broöppning om 6 minuter');
    });
  });

  describe('Problem 4: Target bridge assignment logik', () => {
    test('Båt från söder ska få korrekt target bridge baserat på riktning', () => {
      // SCENARIO: Båt kommer från söder och rör sig norrut
      // Första user bridge = Klaffbron
      
      const southboundBoat = createProductionBoat(219000006, 'Southbound', {
        targetBridge: 'Klaffbron', // Första user bridge norrut
        currentBridge: 'Olidebron', // Kommer från söder
        etaMinutes: 12,
        status: 'approaching',
        distance: 800, // Längre bort men på väg
        sog: 4.0,
        isApproaching: true,
        isWaiting: false,
        distanceToCurrent: 200, // 200m från Olidebron
      });

      const result = messageGenerator.generateBridgeText([southboundBoat]);
      
      // Verify: Ska visa Klaffbron som target (inte andra broar)
      expect(result).toContain('Klaffbron');
      expect(result).toContain('beräknad broöppning om 12 minuter');
      expect(result).not.toContain('Stridsbergsbron'); // Fel target bridge
    });

    test('Båt från norr ska få Stridsbergsbron som target', () => {
      // SCENARIO: Båt kommer från norr (Stallbackabron) mot söder
      // Första user bridge söderut = Stridsbergsbron
      
      const northboundBoat = createProductionBoat(219000007, 'Northbound', {
        targetBridge: 'Stridsbergsbron', // Första user bridge söderut
        currentBridge: 'Stallbackabron', // Kommer från norr
        etaMinutes: 8,
        status: 'approaching',
        distance: 600,
        sog: 3.5,
        isApproaching: true,
        isWaiting: false,
        distanceToCurrent: 150, // 150m från Stallbackabron
      });

      const result = messageGenerator.generateBridgeText([northboundBoat]);
      
      // Verify: Ska visa Stridsbergsbron som target
      expect(result).toContain('Stridsbergsbron');
      expect(result).toContain('beräknad broöppning om 8 minuter');
      expect(result).not.toContain('Klaffbron'); // Fel riktning
    });
  });

  describe('Problem 5: Timing och kontinuitet', () => {
    test('Båt som varit i systemet länge ska inte försvinna oväntat', () => {
      // SCENARIO: Jasmin har varit i systemet och närmar sig korrekt
      // Ska inte "försvinna" från bridge_text utan anledning
      
      const establishedJasmin = createProductionBoat(219000005, 'Jasmin', {
        targetBridge: 'Klaffbron',
        currentBridge: 'Klaffbron',
        etaMinutes: 4,
        status: 'approaching',
        distance: 280, // Nära men inte för nära
        sog: 2.8,
        isApproaching: true,
        isWaiting: false,
        distanceToCurrent: 280,
      });

      const result = messageGenerator.generateBridgeText([establishedJasmin]);
      
      // Verify: Jasmin ska synas i bridge_text
      expect(result).toContain('En båt närmar sig Klaffbron');
      expect(result).toContain('beräknad broöppning om 4 minuter');
      expect(result).not.toContain('Inga båtar'); // Inte försvunnen
    });

    test('Flera uppdateringar av samma båt ska ge konsistent bridge_text', () => {
      // SCENARIO: Samma båt uppdateras flera gånger
      // Bridge_text ska vara konsistent
      
      const update1 = createProductionBoat(111111, 'Consistent', {
        targetBridge: 'Stridsbergsbron',
        currentBridge: 'Stridsbergsbron',
        etaMinutes: 6,
        status: 'approaching',
        distance: 320,
        sog: 2.0,
        isApproaching: true,
        isWaiting: false,
        distanceToCurrent: 320,
      });

      const update2 = createProductionBoat(111111, 'Consistent', {
        targetBridge: 'Stridsbergsbron', // Same target
        currentBridge: 'Stridsbergsbron', // Same current
        etaMinutes: 5, // Slightly closer
        status: 'approaching', // Same status
        distance: 300, // Slightly closer
        sog: 2.0,
        isApproaching: true,
        isWaiting: false,
        distanceToCurrent: 300,
      });

      const result1 = messageGenerator.generateBridgeText([update1]);
      const result2 = messageGenerator.generateBridgeText([update2]);
      
      // Verify: Båda resultaten ska vara konsekventa
      expect(result1).toContain('Stridsbergsbron');
      expect(result2).toContain('Stridsbergsbron');
      expect(result1).toContain('beräknad broöppning');
      expect(result2).toContain('beräknad broöppning');
    });
  });

  describe('Problem 6: Edge cases som orsakar null/undefined', () => {
    test('Båt med inkomplett data ska inte krascha bridge_text generation', () => {
      // SCENARIO: Båt med saknad/korrupt data
      // System ska hantera gracefully utan null/undefined i output
      
      const incompleteBoat = createProductionBoat(999999, '', { // Empty name
        targetBridge: null, // Missing target
        currentBridge: undefined, // Undefined current
        etaMinutes: null, // Null ETA
        status: 'approaching',
        distance: NaN, // Invalid distance
        sog: 0,
        isApproaching: true,
        isWaiting: false,
        distanceToCurrent: 0,
      });

      const result = messageGenerator.generateBridgeText([incompleteBoat]);
      
      // Verify: Ska inte innehålla null/undefined/NaN
      expect(result).not.toContain('null');
      expect(result).not.toContain('undefined');
      expect(result).not.toContain('NaN');
      expect(result).not.toContain('vid null');
      expect(result).not.toContain('vid undefined');
      
      // Should fallback to safe message when no valid phrases can be generated
      expect(result).toContain('Båtar upptäckta men tid kan ej beräknas');
    });

    test('Båt med mycket stor ETA ska hanteras korrekt', () => {
      const extremeEtaBoat = createProductionBoat(888888, 'Extreme', {
        targetBridge: 'Klaffbron',
        currentBridge: 'Klaffbron',
        etaMinutes: 999, // Extrem ETA
        status: 'approaching',
        distance: 299,
        sog: 0.1, // Mycket långsam
        isApproaching: true,
        isWaiting: false,
        distanceToCurrent: 299,
      });

      const result = messageGenerator.generateBridgeText([extremeEtaBoat]);
      
      // Verify: 999 minuter ETA är korrekt - formateras som "om 999 minuter" (exakt 999, inte >999)
      expect(result).toContain('om 999 minuter'); // Korrekt formatering enligt app.js
      expect(result).not.toContain('null');
      expect(result).not.toContain('undefined');
    });

    test('Båt med ETA över 999 minuter ska kappas till 999+', () => {
      const veryExtremeBoat = createProductionBoat(777777, 'VeryExtreme', {
        targetBridge: 'Klaffbron',
        currentBridge: 'Klaffbron',
        etaMinutes: 1500, // Över 999 minuter
        status: 'approaching',
        distance: 299,
        sog: 0.05, // Extremt långsam
        isApproaching: true,
        isWaiting: false,
        distanceToCurrent: 299,
      });

      const result = messageGenerator.generateBridgeText([veryExtremeBoat]);
      
      // Verify: >999 minuter ska kappas till "om 999+ minuter"
      expect(result).toContain('om 999+ minuter'); // Korrekt kappning enligt app.js
      expect(result).not.toContain('om 1500 minuter'); // Ska inte visa den faktiska stora siffran
    });
  });
});