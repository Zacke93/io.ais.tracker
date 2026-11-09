'use strict';

jest.mock('homey');
const { __mockHomey: mockHomey } = require('homey');
const App = require('../app');
const geometry = require('../lib/utils/geometry');
const { MOORING_ZONES, MOORING_DETECTION, BRIDGES } = require('../lib/constants');

/**
 * Helgranskningen 2026-11-03: "Kajen norr om Klaffbron" ligger mitt i
 * Klaffbrons väntzon och bär queueGraceMs — förtöjningsklassningen räknar
 * stillhet där som brokö. Öppningslagrets ankomstspärr bekräftade ändå ett
 * "kajstopp" efter 30 s i vilken kajzon som helst, så en båt som väntat ut
 * öppningen vid kajen fick ett andra kort för samma öppning när hon lade ut
 * (TIM och CHARLYS DREAM i both-21h, med båten isolerad). Gästhamnen
 * (queueGraceMs 0) behåller 30 s-regeln: där ÄR ett stopp ett besök (HERA II).
 *
 * Ägarbeslut U23 (2026-11-09): Kajens köundantag är obegränsat. Spärren
 * följer förtöjningsklassningen (VesselDataService.holdsQuayQueue): så länge
 * köaren har kortets bro som målbro, rörelsebevis och inte är förtöjdklassad
 * är stoppet samma ankomst, hur länge hon än väntar. När klassningen släpper
 * henne (navstatus 1/5, 2 h-backstoppen eller ingen målbro) gäller 30 s-regeln
 * och avgången blir en ny ankomst.
 *
 * Granskningen av familj F (L1, 2026-11-09): stoppet minns att klassningen
 * höll henne (heldAsQueue, överlever omstart). Efter en omstart eller ett
 * AIS-glapp mitt i kön är hon ny för appen och klassningen håller henne inte,
 * men minnet gäller så länge hon ligger kvar, inte sänder navstatus 1/5 och
 * inte legat still i 2 h från stoppets första fix — som farledsköaren.
 */
const MMSI = '265000222';
const KEY = `Klaffbron|${MMSI}|southbound`;
const KAJEN = MOORING_ZONES.find((zone) => zone.name === 'Kajen norr om Klaffbron');
const GASTHAMNEN = MOORING_ZONES.find((zone) => zone.name === 'Gästhamnen norr om Klaffbron');
const mid = (zone) => ({
  lat: (zone.start.lat + zone.end.lat) / 2,
  lon: (zone.start.lon + zone.end.lon) / 2,
});
// Utanför båda zonerna, söder om Kajen mot Klaffbron (≈115 m från Kajens mitt).
const DEPARTED = { lat: 58.2852955, lon: 12.2843295 };
// Punkten `meters` m rakt mot Klaffbron från `pos`.
const toward = (pos, meters) => {
  const { lat, lon } = BRIDGES.klaffbron;
  const f = meters / geometry.calculateDistance(pos.lat, pos.lon, lat, lon);
  return { lat: pos.lat + (lat - pos.lat) * f, lon: pos.lon + (lon - pos.lon) * f };
};

describe('Öppningslagret: kort köstopp vid Kajen är samma ankomst', () => {
  let app;
  let savedMode;
  let lastPos;

  beforeEach(async () => {
    lastPos = null;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-03T08:00:00Z'));
    savedMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    app = new App();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    const store = {};
    app.homey = {
      ...mockHomey,
      settings: {
        get: (name) => store[name] ?? null,
        set: (name, value) => {
          store[name] = value;
        },
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    await app.onInit();
    app._persistentOpeningWarnings.set(KEY, { arrivalActive: true, firedAt: Date.now() - 60000 });
    jest.spyOn(app.bridgeOpeningService, 'restartArrival');
  });

  afterEach(async () => {
    await app.onUninit();
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__TEST_MODE__ = savedMode;
  });

  // Fixen bär förtöjningsklassningens fält. En KÖARE (`state` utelämnat) är
  // på väg mot kortets bro med rörelsebevis, som i appen när kortet gick;
  // `{}` är en båt som klassningen inte håller (ingen målbro, t.ex. ny efter
  // ett långt AIS-glapp). Avgångsfixen bär köarens fält. Fixen bär också
  // VDS:s `lastPosition` (föregående fix), som kajavgångens rimlighetskrav
  // läser; varje anrop är nästa fix i ordning.
  const QUEUER = { targetBridge: 'Klaffbron', _hasMovementProof: true, _moored: false };
  const fix = (pos, sog, state = QUEUER) => {
    const vessel = {
      mmsi: MMSI,
      lat: pos.lat,
      lon: pos.lon,
      sog,
      timestamp: Date.now(),
      lastPositionUpdate: Date.now(),
      fixTs: Date.now(),
      lastPosition: lastPos,
      ...state,
    };
    lastPos = { lat: pos.lat, lon: pos.lon };
    return vessel;
  };

  function stopThenDepart(zone, stopMs, stateAt = () => QUEUER) {
    const at = mid(zone);
    app._observeOpeningArrivals(fix(at, 0.1, stateAt(0)));
    for (let elapsed = 30000; elapsed <= stopMs; elapsed += 30000) {
      jest.setSystemTime(Date.now() + 30000);
      app._observeOpeningArrivals(fix(at, 0.1, stateAt(elapsed)));
    }
    jest.setSystemTime(Date.now() + 60000);
    app._observeOpeningArrivals(fix(DEPARTED, 3.0));
  }

  // Båten som klassningen inte håller: ingen målbro, inget rörelsebevis och
  // zonförtöjd (ny för appen efter en omstart eller ett AIS-glapp).
  const LOST = { targetBridge: null, _hasMovementProof: false, _moored: true };

  function stillAt(at, ms, state = QUEUER, sog = 0.1) {
    for (let elapsed = 0; elapsed < ms; elapsed += 30000) {
      jest.setSystemTime(Date.now() + 30000);
      app._observeOpeningArrivals(fix(at, sog, state));
    }
  }

  // Omstart med samma inställningslager: ny app, samma lagrade ankomster.
  // VDS har glömt båten, så nästa fix saknar föregående position.
  async function restart() {
    const { homey } = app;
    await app.onUninit();
    app = new App();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app.homey = homey;
    await app.onInit();
    jest.spyOn(app.bridgeOpeningService, 'restartArrival');
    lastPos = null;
  }

  function departAndExpectSameArrival(expected) {
    jest.setSystemTime(Date.now() + 60000);
    app._observeOpeningArrivals(fix(DEPARTED, 3.0));
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(expected);
    if (expected) expect(app.bridgeOpeningService.restartArrival).not.toHaveBeenCalled();
    else expect(app.bridgeOpeningService.restartArrival).toHaveBeenCalledWith(MMSI, 'Klaffbron');
  }

  test('köstopp på 7 min vid Kajen ⇒ ankomstspärren står kvar, inget nytt kort', () => {
    expect(KAJEN.queueGraceMs).toBeGreaterThan(30000);
    stopThenDepart(KAJEN, 7 * 60 * 1000);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
    expect(app.bridgeOpeningService.restartArrival).not.toHaveBeenCalled();
  });

  // U23-regressionen (fäller c14938f, där spärren bekräftade kajstoppet efter
  // 15 min och avgången gav ett nytt, sent kort — värld 313: 32 s före passagen).
  test('U23: kö på 25 min vid Kajen ⇒ samma ankomst, inget nytt kort vid avgången', () => {
    stopThenDepart(KAJEN, 25 * 60 * 1000);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
    expect(app.bridgeOpeningService.restartArrival).not.toHaveBeenCalled();
  });

  test('U23: köaren som 2 h-backstoppen förtöjer ⇒ avgången är en ny ankomst', () => {
    // Klassningen släpper henne efter MOORING_DETECTION.MAX_STATIONARY_WAIT_MS;
    // från den fixen är hon förtöjd och inte längre en köare i texten.
    const backstopMs = MOORING_DETECTION.MAX_STATIONARY_WAIT_MS;
    stopThenDepart(KAJEN, backstopMs + 60000,
      (elapsed) => (elapsed > backstopMs ? { ...QUEUER, _moored: true, targetBridge: null } : QUEUER));
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(false);
    expect(app.bridgeOpeningService.restartArrival).toHaveBeenCalledWith(MMSI, 'Klaffbron');
  });

  test('U23: navstatus 5 vid Kajen (förtöjd enligt klassningen) ⇒ avgången efter 20 min är en ny ankomst', () => {
    const NAV5 = {
      ...QUEUER, navStatus: 5, _moored: true, targetBridge: null,
    };
    stopThenDepart(KAJEN, 20 * 60 * 1000, () => NAV5);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(false);
    expect(app.bridgeOpeningService.restartArrival).toHaveBeenCalledWith(MMSI, 'Klaffbron');
  });

  test('övernattning vid Kajen med AIS-glapp: avgången nästa morgon är en ny ankomst', () => {
    const at = mid(KAJEN);
    app._observeOpeningArrivals(fix(at, 0.1));
    jest.setSystemTime(Date.now() + 30000);
    app._observeOpeningArrivals(fix(at, 0.1));
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(false);
    // AIS avstängd över natten; nästa fix på samma plats tio timmar senare.
    // Appen har tappat båten: hon är ny, utan målbro, och klassningen håller
    // henne inte som köare. Glappet nollställer inte stoppet i en kajzon med
    // köundantag, så stoppet bekräftas på morgonens första fix.
    jest.setSystemTime(Date.now() + 10 * 60 * 60 * 1000);
    app._observeOpeningArrivals(fix(at, 0.1, {}));
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(true);
    jest.setSystemTime(Date.now() + 60000);
    app._observeOpeningArrivals(fix(DEPARTED, 3.0));
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(false);
    expect(app.bridgeOpeningService.restartArrival).toHaveBeenCalledWith(MMSI, 'Klaffbron');
  });

  // Granskningen av fixvågen 2026-11-04: köskyddet gällde även en båt som
  // kom från ett BEKRÄFTAT stopp. Efter en natt i Gästhamnen och en kort kö
  // vid Kajen tystades då morgonens kort av gårdagens ankomst.
  test('bekräftat stopp i Gästhamnen följt av kort kö vid Kajen ⇒ avgången är en ny ankomst', () => {
    const gasthamnen = mid(GASTHAMNEN);
    app._observeOpeningArrivals(fix(gasthamnen, 0.1));
    jest.setSystemTime(Date.now() + 30000);
    app._observeOpeningArrivals(fix(gasthamnen, 0.1));
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(true);
    // Morgonen: kryper 150 m in i Kajen och köar där i två minuter.
    jest.setSystemTime(Date.now() + 8 * 60 * 60 * 1000);
    stopThenDepart(KAJEN, 2 * 60 * 1000);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(false);
    expect(app.bridgeOpeningService.restartArrival).toHaveBeenCalledWith(MMSI, 'Klaffbron');
  });

  // M3 (granskningen av familj F, 2026-11-09; helgranskning-2026-11-03, S/V
  // REBEL i 20260806-42h): avgången från ett bekräftat stopp godtas inne i
  // en kajzon med köundantag när båten flyttat minst 50 m från stoppet MOT
  // bron. REBEL låg över natten i Gästhamnen; hennes första rörelsefix låg i
  // Kajen 249 m från Klaffbron, och fältappens kort spärrades av gårdagens
  // ankomst.
  test('M3: bekräftat stopp i Gästhamnen, första rörelsefixen i Kajen mot bron ⇒ ny ankomst', () => {
    const gasthamnen = mid(GASTHAMNEN);
    app._observeOpeningArrivals(fix(gasthamnen, 0.1));
    jest.setSystemTime(Date.now() + 30000);
    app._observeOpeningArrivals(fix(gasthamnen, 0.1));
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(true);
    jest.setSystemTime(Date.now() + 8 * 60 * 60 * 1000);
    app._observeOpeningArrivals(fix(mid(KAJEN), 3.0));
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(false);
    expect(app.bridgeOpeningService.restartArrival).toHaveBeenCalledWith(MMSI, 'Klaffbron');
  });

  test('M3: rörelse inne i Kajen BORT från bron är ingen avgång', () => {
    // Bekräftat stopp vid Kajens södra ände (förtöjd enligt klassningen),
    // sedan en rörelsefix vid kapselns norra ände: över 50 m från stoppet
    // men längre från Klaffbron, alltså ingen avgång mot bron.
    const NAV5 = {
      ...QUEUER, navStatus: 5, _moored: true, targetBridge: null,
    };
    const sydande = { lat: KAJEN.start.lat, lon: KAJEN.start.lon };
    const nordande = { lat: KAJEN.end.lat, lon: KAJEN.end.lon };
    app._observeOpeningArrivals(fix(sydande, 0.1, NAV5));
    jest.setSystemTime(Date.now() + 30000);
    app._observeOpeningArrivals(fix(sydande, 0.1, NAV5));
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(true);
    jest.setSystemTime(Date.now() + 60000);
    app._observeOpeningArrivals(fix(nordande, 2.0, { ...QUEUER, _moored: false }));
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
    expect(app.bridgeOpeningService.restartArrival).not.toHaveBeenCalled();
  });

  test('M3: köaren som klassningen håller lägger ut genom Kajen ⇒ fortfarande samma ankomst', () => {
    // Stoppet bekräftas aldrig medan U23 håller henne, så avgången inne i
    // kapseln mot bron ger inget nytt kort.
    const at = mid(KAJEN);
    app._observeOpeningArrivals(fix(at, 0.1));
    for (let elapsed = 30000; elapsed <= 25 * 60 * 1000; elapsed += 30000) {
      jest.setSystemTime(Date.now() + 30000);
      app._observeOpeningArrivals(fix(at, 0.1));
    }
    // Kapselns södra spets, 25 m bortom linjens ände: 167 m från Klaffbron,
    // 73 m närmare bron än stoppet och fortfarande i kapseln.
    jest.setSystemTime(Date.now() + 60000);
    app._observeOpeningArrivals(fix({ lat: 58.285500, lon: 12.284923 }, 3.0));
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
    expect(app.bridgeOpeningService.restartArrival).not.toHaveBeenCalled();
  });

  // Omgranskningen av familj F (revision 2, M3; granskningens prov A5n5 och
  // A5q): en enda fix räcker som avgång inne i Kajen, så steget sedan förra
  // fixen måste vara rimligt för farten. Ett ensamt GPS-hopp på 60 m mot bron
  // i 0,6 kn (utan GPS-hoppflagga) släpper klassningen men är ingen avgång.
  // Utan kravet blev det en falsk varning, och efter 2 h-gränsen förbrukade
  // den ankomsten, så att den verkliga avgången blev utan varning.
  test.each([
    ['förtöjd av 2 h-gränsen', { ...QUEUER, _moored: true, targetBridge: null }],
    ['navstatus 5', {
      ...QUEUER, navStatus: 5, _moored: true, targetBridge: null,
    }],
  ])('M3: ett ensamt GPS-hopp på 60 m mot bron (%s) är ingen avgång, den verkliga avgången är det', (_, moored) => {
    const at = mid(KAJEN);
    app._observeOpeningArrivals(fix(at, 0, moored));
    stillAt(at, 60000, moored, 0);
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(true);
    // Hoppet 30 s senare: 60 m rakt mot bron, fortfarande i kapseln, och
    // klassningen har släppt henne.
    jest.setSystemTime(Date.now() + 30000);
    app._observeOpeningArrivals(fix(toward(at, 60), 0.6));
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(true);
    expect(app.bridgeOpeningService.restartArrival).not.toHaveBeenCalled();
    // Nästa fix är tillbaka vid kajen; sedan lägger hon ut på riktigt.
    jest.setSystemTime(Date.now() + 30000);
    app._observeOpeningArrivals(fix(at, 0, moored));
    departAndExpectSameArrival(false);
  });

  test('M3: en verklig avgång inne i Kajen (60 m på 60 s i 2 kn mot bron) är en avgång', () => {
    const NAV5 = {
      ...QUEUER, navStatus: 5, _moored: true, targetBridge: null,
    };
    const at = mid(KAJEN);
    app._observeOpeningArrivals(fix(at, 0, NAV5));
    stillAt(at, 60000, NAV5, 0);
    jest.setSystemTime(Date.now() + 60000);
    app._observeOpeningArrivals(fix(toward(at, 60), 2.0));
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(false);
    expect(app.bridgeOpeningService.restartArrival).toHaveBeenCalledWith(MMSI, 'Klaffbron');
  });

  // L1 (granskningen av familj F, 2026-11-09). Efter omstarten eller glappet
  // är köaren ny för appen: ingen målbro, inget rörelsebevis, och zonlagrets
  // 3 min förtöjer henne (granskningens prov X2kaj och X5kaj). Utan minnet
  // bekräftades stoppet direkt, och avgången gav ett andra, sent kort som
  // farledstvillingen (X2far, X5far) aldrig får.
  test('L1: omstart mitt i kön vid Kajen ⇒ samma ankomst, inget nytt kort vid avgången', async () => {
    const at = mid(KAJEN);
    app._observeOpeningArrivals(fix(at, 0.1));
    stillAt(at, 30 * 60 * 1000);
    await restart();
    expect(app._persistentOpeningWarnings.get(KEY).quayStop)
      .toMatchObject({ confirmed: false, heldAsQueue: true });
    stillAt(at, 25 * 60 * 1000, LOST);
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(false);
    departAndExpectSameArrival(true);
  });

  test('L1: AIS-glapp på 30 min mitt i kön vid Kajen ⇒ samma ankomst', () => {
    const at = mid(KAJEN);
    app._observeOpeningArrivals(fix(at, 0.1));
    stillAt(at, 10 * 60 * 1000);
    jest.setSystemTime(Date.now() + 30 * 60 * 1000);
    stillAt(at, 15 * 60 * 1000, LOST);
    departAndExpectSameArrival(true);
  });

  test('L1: navstatus 5 efter omstarten släpper minnet ⇒ avgången är en ny ankomst', async () => {
    const at = mid(KAJEN);
    app._observeOpeningArrivals(fix(at, 0.1));
    stillAt(at, 30 * 60 * 1000);
    await restart();
    stillAt(at, 60000, { ...LOST, navStatus: 5 });
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(true);
    departAndExpectSameArrival(false);
  });

  test('L1: minnet gäller inte bortom 2 h från stoppets första fix', async () => {
    const at = mid(KAJEN);
    app._observeOpeningArrivals(fix(at, 0.1));
    stillAt(at, 100 * 60 * 1000);
    await restart();
    stillAt(at, 19 * 60 * 1000, LOST);
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(false);
    stillAt(at, 2 * 60 * 1000, LOST);
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(true);
    departAndExpectSameArrival(false);
  });

  // Negativtest (klarar både 3887254 och L1; omgranskningen av familj F,
  // revision 2): minnet hör till det stopp som klassningen höll. Köaren hålls
  // vid stopp A; efter en omstart ligger hon 60 m bort vid kapselns norra
  // spets (stopp B), där klassningen inte håller henne. Stopp B bekräftas med
  // 30 s-regeln, och avgången är en ny ankomst. Ett minne som följde med från
  // A, eller som gällde varje stopp vid Kajen, hade gjort avgången till samma
  // ankomst.
  test('L1: ett stopp där klassningen aldrig höll henne får inget minne, inte heller från ett tidigare stopp', async () => {
    const a = mid(KAJEN);
    const b = {
      lat: KAJEN.end.lat + (KAJEN.end.lat - KAJEN.start.lat) * 0.1,
      lon: KAJEN.end.lon + (KAJEN.end.lon - KAJEN.start.lon) * 0.1,
    };
    expect(geometry.calculateDistance(a.lat, a.lon, b.lat, b.lon)).toBeGreaterThanOrEqual(50);
    app._observeOpeningArrivals(fix(a, 0.1));
    stillAt(a, 10 * 60 * 1000);
    await restart();
    app._observeOpeningArrivals(fix(b, 0.1, LOST));
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(false);
    stillAt(b, 60000, LOST);
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(true);
    departAndExpectSameArrival(false);
  });

  // Omgranskningen av familj F (revision 2, L1; granskningens prov B3): en
  // ensam fartspik på 0,6 kn vid kajen raderar det obekräftade stoppet, och
  // nästa fix startar ett nytt med senare första fix. Klassningens
  // stillhetsklocka (_stationarySince) startar inte om, så 2 h-gränsen
  // förtöjer henne i tid. Minnet släpps därför också när den klockan nått
  // 2 h; annars blev avgången samma ankomst, utan varning.
  test('L1: en fartspik startar inte om 2 h-gränsen — minnet släpps på klassningens stillhetsklocka', () => {
    const at = mid(KAJEN);
    const HELD = { ...QUEUER, _stationarySince: Date.now() };
    app._observeOpeningArrivals(fix(at, 0.1, HELD));
    stillAt(at, 60 * 60 * 1000, HELD);
    jest.setSystemTime(Date.now() + 30000);
    app._observeOpeningArrivals(fix(at, 0.6, HELD));
    stillAt(at, 60 * 60 * 1000, HELD);
    // 2 h efter klockans start: backstoppen förtöjer henne och släpper målbron.
    const BACKSTOP = {
      ...HELD, _moored: true, targetBridge: null,
    };
    stillAt(at, 30 * 60 * 1000, BACKSTOP);
    expect(app._persistentOpeningWarnings.get(KEY).quayStop.confirmed).toBe(true);
    departAndExpectSameArrival(false);
  });

  // Köskyddet gäller bara när bron ligger inom DISARM_MOORED_MIN_DISTANCE_M
  // (600 m), som i förtöjningsklassningen. Kajen ligger 980 m från
  // Stridsbergsbron: där är ett stopp vid kajen ett besök, inte brokö.
  test('Kajen mot Stridsbergsbron (bortom 600 m): 60 s stopp räcker, inget köskydd', () => {
    const STRIDS_KEY = `Stridsbergsbron|${MMSI}|northbound`;
    app._persistentOpeningWarnings.delete(KEY);
    app._persistentOpeningWarnings.set(STRIDS_KEY, { arrivalActive: true, firedAt: Date.now() - 60000 });
    // Norrgående efter Klaffbron: målbron Stridsbergsbron ligger bortom 600 m,
    // så varken zonens köundantag eller U23 gäller (ELFKUNGEN, SUSANNE).
    stopThenDepart(KAJEN, 60000, () => ({ ...QUEUER, targetBridge: 'Stridsbergsbron' }));
    expect(app._persistentOpeningWarnings.has(STRIDS_KEY)).toBe(false);
    expect(app.bridgeOpeningService.restartArrival).toHaveBeenCalledWith(MMSI, 'Stridsbergsbron');
  });

  test('Gästhamnen: 60 s stopp räcker som förut (HERA II)', () => {
    expect(GASTHAMNEN.queueGraceMs || 0).toBe(0);
    stopThenDepart(GASTHAMNEN, 60000);
    expect(app._persistentOpeningWarnings.has(KEY)).toBe(false);
    expect(app.bridgeOpeningService.restartArrival).toHaveBeenCalledWith(MMSI, 'Klaffbron');
  });
});
