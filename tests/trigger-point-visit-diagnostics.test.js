'use strict';

const { validateInvariants } = require('./replay-validation/invariants');

describe('INV-12: beständigt besöksminne har storleksgräns, levande fartyg ska städas', () => {
  test.each([0, 20, 2048])('%i kvarvarande besök accepteras efter att levande fartyg tagits bort', (count) => {
    expect(validateInvariants({
      leakDiagnostics: { vessels: 0, triggerPointVisits: count },
    })).toEqual([]);
  });

  test.each([2049, NaN, -1, 1.5])('ogiltig besöksräknare %s är ett fatalt invariantbrott', (count) => {
    const violations = validateInvariants({
      leakDiagnostics: { vessels: 0, triggerPointVisits: count },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('BESÖKSMINNE: triggerPointVisits=');
  });

  test.each(['vessels', 'cleanupTimers'])('vanlig läcka i %s förblir fatal bredvid tillåtet besöksminne', (field) => {
    const violations = validateInvariants({
      leakDiagnostics: { triggerPointVisits: 20, [field]: 1 },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(`LÄCKAGE: ${field}=1`);
  });

  test('äldre replayresultat utan besöksräknare behåller sitt kontrakt', () => {
    expect(validateInvariants({ leakDiagnostics: { vessels: 0 } })).toEqual([]);
    expect(validateInvariants({ leakDiagnostics: { vessels: 1 } })).toEqual([
      expect.stringContaining('LÄCKAGE: vessels=1'),
    ]);
  });
});
