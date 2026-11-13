export const meta = {
  name: 'rattningskampanj-revision-3',
  description: 'Tredje revisionen för K, K2, N och M efter omgranskningen och dirigentens beslut, med ny granskning',
  phases: [
    { title: 'Revision 3', detail: 'designern åtgärdar omgranskningens krav' },
    { title: 'Granskning 3', detail: 'adversariell granskning i rwt' },
  ],
}
const S = '/tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad'
const KD = S + '/kampanj'
const fams = Array.isArray(args) ? args : ['K', 'K2', 'N', 'M']
const BRIEF = (f) => `Läs först ${KD}/KAMPANJ.md. Där står användarbesluten U13–U21 och dirigentens beslut om R2:s frågor, underlaget, arbetsplatsen, skrivgränserna och leveranserna. Allt gäller hela uppgiften.

Familj: ${f}. Det är samma familj som tidigare i kampanjen. Läs ${KD}/${f}/DESIGN.md.

Arbetsplats:
- worktree: ${KD}/${f}/wt
- granskarens worktree: ${KD}/${f}/rwt
- temp: ${KD}/${f}/tmp
- leveranser: ${KD}/${f}/

Förra revisionens svar finns i ${KD}/${f}/revision1.json, och omgranskningens svar i ${KD}/${f}/omgranskning1.json. S = ${S}.`

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    family: { type: 'string' }, summary: { type: 'string' }, rootCause: { type: 'string' }, fix: { type: 'string' },
    functionsTouched: { type: 'array', items: { type: 'string' } }, tests: { type: 'string' }, battery: { type: 'string' },
    facitChanges: { type: 'array', items: { type: 'object', properties: {
      corpus: { type: 'string' }, dimension: { type: 'string' }, change: { type: 'string' }, evidence: { type: 'string' },
      verdict: { type: 'string', enum: ['rättare', 'likvärdig', 'sämre', 'oklar'] },
    }, required: ['corpus', 'dimension', 'change', 'evidence', 'verdict'] } },
    engineCheck: { type: 'string' }, interplay: { type: 'string' }, docs: { type: 'string' },
    registryRequests: { type: 'array', items: { type: 'string' }, description: 'registerposter som dirigenten ska lägga in i motorn (U17–U19 m.fl.), med källa och predikatförslag' },
    risks: { type: 'array', items: { type: 'string' } }, commit: { type: 'string' }, patchPath: { type: 'string' },
    status: { type: 'string', enum: ['klar', 'delvis', 'misslyckad'] },
  },
  required: ['family', 'summary', 'rootCause', 'fix', 'functionsTouched', 'tests', 'battery', 'facitChanges', 'engineCheck', 'interplay', 'docs', 'registryRequests', 'risks', 'commit', 'patchPath', 'status'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    family: { type: 'string' },
    verdict: { type: 'string', enum: ['godkänd', 'ändringar-krävs', 'underkänd'] },
    issues: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['hög', 'medel', 'låg'] }, title: { type: 'string' }, detail: { type: 'string' }, fix: { type: 'string' },
    }, required: ['severity', 'title', 'detail', 'fix'] } },
    verified: { type: 'string' }, summary: { type: 'string' },
  },
  required: ['family', 'verdict', 'issues', 'verified', 'summary'],
}
const fmt = (x) => JSON.stringify(x, null, 1)

const results = await pipeline(
  fams,
  (f) => agent(`${BRIEF(f)}

Du är designer för familj ${f} och gör den TREDJE revisionen (filerna heter revision1.json och omgranskning1.json men innehåller den senaste revisionen och granskningen). Gör så här:
1. Åtgärda varje issue med allvar medel i omgranskning1.json, och de låga där det är rimligt. Är en issue fel, motbevisa den med belägg i DESIGN.md.
2. Följ KAMPANJ.md §Dirigentens beslut inför revision 3 och användarbesluten U13–U21. Det gäller särskilt U17 för K och U15 för K2. Skriv om frågeavsnitten i DESIGN.md till beslutade avsnitt.
3. Åtgärda issues med allvar hög FÖRST.
3b. Lista i 'registryRequests' de registerposter som dirigenten ska lägga in i motorn: källa, klass, orakel och ett smalt predikatförslag. Det gäller till exempel U17 (F11/F23) för K, och de kvarvarande kända luckorna för varje familj.
4. Uppdatera prototypen (ny commit), DESIGN.md, FACIT.md, mätningarna, motorkontrollen och patch.diff (git diff 7699cbe, utan bugHunt och node_modules).

Svara med StructuredOutput.`, { label: `revision 3 ${f}`, phase: 'Revision 3', schema: DESIGN_SCHEMA }),
  (rev, f) => agent(`${BRIEF(f)}

Du är oberoende och adversariell granskare för familj ${f} efter den tredje revisionen. Utgå från att påståendena är fel tills du har sett belägg.

Gör följande:
1. Återställ granskarens worktree ${KD}/${f}/rwt till 7699cbe: git checkout -- . och git clean för spårade sökvägar. Rör inte bugHunt/ och node_modules.
2. Applicera ${KD}/${f}/patch.diff.
3. Pröva varje punkt i omgranskning1.json: är den åtgärdad eller motbevisad?
4. Leta efter nya fel som revisionen har infört.
5. Kör själv:
   - regressionstesten, och visa att de fälls utan rättningen;
   - npm test;
   - replay:all;
   - replay:synthetic;
   - replay:openings;
   - lint;
   - monitoring och fassvep om ändringen rör tidsstyrning;
   - hunt:repro på familjens kort, och quick (--out=${KD}/${f}/review-quick-3).
6. Pröva FACIT.md mot rådata (U13), och att besluten U13–U21 följs.

verdict är godkänd endast när inga issues med allvar hög eller medel återstår.

Svara med StructuredOutput.

Designerns svar:
${fmt(rev)}`, { label: `granskning 3 ${f}`, phase: 'Granskning 3', schema: REVIEW_SCHEMA }).then((review) => ({ family: f, revision: rev, review })),
)
for (const r of results.filter(Boolean)) log(`${r.family}: ${r.review ? r.review.verdict : 'ingen granskning'}`)
return results
