'use strict';

const GPSJumpGateService = require('../lib/services/GPSJumpGateService');

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

// Stridsbergsbron-nära position (target för testet).
// OBS: sedan S-F1 lagrar registerCandidatePassage vesselState.sog från
// vessel.sog, och _isVesselStable jämför .sog — fixturen ska ha `sog`.
const BASE = {
  lat: 58.29495, lon: 12.296806, sog: 6.7, cog: 219,
};
const PASSAGE = { passed: true };

/**
 * F11: confirmStableCandidates droppade tidigare en "gammal nog men instabil"
 * kandidat tyst (varken confirmed eller remaining) → en äkta bropassage kunde
 * tappas om GPS råkade vara brusig precis vid 5s-stabilitetskontrollen.
 * Nu behålls kandidaten (upp till _gateTimeout) så en senare stabil tick
 * bekräftar den.
 */
describe('F11: instabil-men-gammal GPS-gate-kandidat tappas inte', () => {
  let svc;

  beforeEach(() => {
    global.__TEST_MODE__ = true; // hoppar över cleanup-timern
    svc = new GPSJumpGateService(makeLogger(), null);
  });

  const ageCandidate = (vesselId, ms) => {
    const candidates = svc._candidatePassages.get(vesselId);
    candidates.forEach((c) => {
      c.timestamp -= ms;
    });
  };

  test('instabil vid kontroll → behålls, bekräftas på senare stabil tick', () => {
    svc.registerCandidatePassage('111', 'Stridsbergsbron', PASSAGE, BASE);
    ageCandidate('111', 6000); // > confirmationPeriod (5s)

    // Tick 1: position har hoppat >50m (instabil) → får INTE droppas
    const unstable = { ...BASE, lat: BASE.lat + 0.002 }; // ~220m bort
    const r1 = svc.confirmStableCandidates('111', unstable);
    expect(r1).toHaveLength(0);
    expect(svc._candidatePassages.has('111')).toBe(true); // behållen, ej tappad

    // Tick 2: tillbaka till stabil position → bekräftas nu
    const r2 = svc.confirmStableCandidates('111', BASE);
    expect(r2).toHaveLength(1);
    expect(r2[0].bridgeName).toBe('Stridsbergsbron');
  });

  test('stabil vid första kontrollen bekräftas direkt (ingen regression)', () => {
    svc.registerCandidatePassage('222', 'Klaffbron', PASSAGE, BASE);
    ageCandidate('222', 6000);

    const r = svc.confirmStableCandidates('222', BASE);
    expect(r).toHaveLength(1);
    expect(r[0].bridgeName).toBe('Klaffbron');
    expect(svc._candidatePassages.has('222')).toBe(false); // konsumerad
  });

  test('instabil bortom max-ålder (>30s) överges (ingen oändlig retention)', () => {
    svc.registerCandidatePassage('333', 'Järnvägsbron', PASSAGE, BASE);
    ageCandidate('333', 31000); // > _gateTimeout (30s)

    const unstable = { ...BASE, lat: BASE.lat + 0.002 };
    const r = svc.confirmStableCandidates('333', unstable);
    expect(r).toHaveLength(0);
    expect(svc._candidatePassages.has('333')).toBe(false); // övergiven
  });

  test('kandidat inte gammal nog ännu → behålls (oförändrat)', () => {
    svc.registerCandidatePassage('444', 'Klaffbron', PASSAGE, BASE);
    ageCandidate('444', 2000); // < confirmationPeriod

    const r = svc.confirmStableCandidates('444', BASE);
    expect(r).toHaveLength(0);
    expect(svc._candidatePassages.has('444')).toBe(true);
  });
});
