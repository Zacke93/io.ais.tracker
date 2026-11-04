'use strict';

/**
 * Rättningsrundan 2026-11-04, M11: hunt:repro väljer domare efter kortets
 * relation och orakel — S-KALIBRERING (T1/T10 mot banksanningen och
 * registret), S-KANARIE (kanariekontrollen), H1–H3 (hälsooraklen), INV-F/LEV
 * (harnessens domare), sanningsspåret och M-FAS — och svarar KAN INTE DÖMAS
 * med exit 2, aldrig BORTA, när ingen domare finns eller körningen fallerar.
 *
 * Kort utan domare avgörs innan något körs (ingen barnprocess). Domarna
 * prövas med en injicerad pool som svarar med sparade resultat; inga
 * barnprocesser och inga git-anrop.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const clone = (x) => JSON.parse(JSON.stringify(x));

/** Ett tomt men komplett replayresultat (inga notiser, varningar eller passager). */
const TOMT = Object.freeze({
  notifications: [],
  openingWarnings: [],
  openingCoverage: [],
  openingSuppressions: [],
  openingServiceFires: 0,
  targetPassages: [],
  intermediatePassages: [],
  bridgeTextTransitions: [],
  journeyResets: [],
  visitReentries: [],
  confirmedTargetWaits: [],
  processErrors: 0,
});

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-repro-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** En fyndkatalog som report.writeCardDir skriver den. */
function kort(namn, {
  mekanism, recept = null, filer = {}, fynd = [],
}) {
  const dir = path.join(tmp, namn);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'fynd.json'), `${JSON.stringify({ mekanism, nyckel: `KANDIDAT|-|${mekanism}`, fynd })}\n`);
  if (recept) fs.writeFileSync(path.join(dir, 'recept.json'), `${JSON.stringify(recept)}\n`);
  for (const [fil, text] of Object.entries(filer)) fs.writeFileSync(path.join(dir, fil), text);
  return dir;
}

/** Poolen ersätts: varje körning svarar med `resultat` (null = körfel). */
function fakePool(resultat, extra = {}) {
  return {
    jobb: 1,
    statistik: {},
    körda: [],
    async run(job) {
      this.körda.push(path.basename(job.jsonl));
      return {
        etikett: job.etikett,
        jsonl: job.jsonl,
        ok: !!resultat,
        häng: false,
        fatal: null,
        fel: resultat ? null : 'konstruerat körfel',
        försök: [],
        ms: 1,
        rader: job.rader || 0,
        simTimmar: job.simTimmar || 1,
        resultat: resultat ? clone(resultat) : null,
        stderr: {
          h3: {}, övrigt: {}, rader: 0, exempel: {},
        },
        ...extra,
      };
    },
    runAll(jobs) {
      return Promise.all(jobs.map((j) => this.run(j)));
    },
  };
}

/**
 * Kör hunt:repro. Utan pool via main (som CLI:t; miljön återställs efteråt,
 * eftersom main skrubbar processens egen miljö), med pool via runRepro.
 */
async function repro(dir, pool = null) {
  const hunt = require('../hunt');
  const rader = [];
  const log = jest.spyOn(console, 'log').mockImplementation((...a) => rader.push(a.join(' ')));
  const err = jest.spyOn(console, 'error').mockImplementation((...a) => rader.push(a.join(' ')));
  const env = { ...process.env };
  try {
    const code = pool
      ? await hunt.runRepro(hunt.parseArgs(['--repro', dir]).flaggor, [], { pool })
      : await hunt.main(['--repro', dir]);
    return { code, text: rader.join('\n') };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
    log.mockRestore();
    err.mockRestore();
  }
}

describe('M11: hunt:repro dömer bara med rätt domare', () => {
  test('ett kort utan domare svarar KAN INTE DÖMAS med exit 2 — aldrig BORTA — och kör ingenting', async () => {
    const jsonl = '{"ctrl":"restart","aisTimestamp":1780000000000}\n';
    const fall = [
      ['T4|FLER-ÄN-EN-VARNING', { relation: 'BAS', korpus: '20260611-4h' }, /ingen domare för oraklet T4/],
      ['INV-F|INV-3 ETA-SÅGTAND UPP', { relation: 'M-ISO' }, /relationen M-ISO har ingen domare/],
      ['INV-F|INV-3 ETA-SÅGTAND UPP', { relation: 'S-KALIBRERING', korpus: '20260611-4h' }, /S-KALIBRERING dömer bara T1 och T10/],
    ];
    for (const [i, [mekanism, recept, skäl]] of fall.entries()) {
      const dir = kort(`K${i}`, { mekanism, recept, filer: { 'repro.jsonl': jsonl } });
      // eslint-disable-next-line no-await-in-loop
      const { code, text } = await repro(dir);
      expect(code).toBe(2);
      expect(text).toMatch(/: KAN INTE DÖMAS för /);
      expect(text).toMatch(skäl);
      expect(text).not.toMatch(/BORTA/);
    }
  });

  test('S-KALIBRERING dömer om basen med T1/T10 mot banksanningen och registret', async () => {
    const bankOps = require('../lib/bankOps');
    const korpus = bankOps.corpusList(['20260611-4h'])[0];
    const bas = { 'bas.jsonl': fs.readFileSync(korpus.jsonl, 'utf8') };
    const recept = { korpus: korpus.id, relation: 'S-KALIBRERING', orakel: 'T1' };
    // Utan notiser saknas de observerade besökens notiser: mekanismen återkommer.
    const kvar = await repro(kort('S01', { mekanism: 'T1|NOTIS-UTEBLIVEN', recept, filer: bas }), fakePool(TOMT));
    expect(kvar.code).toBe(0);
    expect(kvar.text).toMatch(/S-KALIBRERING på 20260611-4h \(T1\), bas\.jsonl 10 rader/);
    expect(kvar.text).toMatch(/utfall mot aktuell HEAD: KVAR \([1-9]\d* oregistrerade utslag av mekanismen; 0 registrerade, som information\)/);
    expect(kvar.text).toMatch(/- T1 NOTIS-UTEBLIVEN \[KANDIDAT\]/);
    // En fantompassage kräver en registrerad passage: borta.
    const borta = await repro(kort('S02', { mekanism: 'T10|FANTOMPASSAGE(target)', recept: { ...recept, orakel: 'T10' }, filer: bas }), fakePool(TOMT));
    expect(borta.code).toBe(0);
    expect(borta.text).toMatch(/utfall mot aktuell HEAD: BORTA \(0 oregistrerade utslag av mekanismen; 0 registrerade/);
    // Basen kan inte köras: KAN INTE DÖMAS, aldrig BORTA.
    const fel = await repro(kort('S03', { mekanism: 'T1|NOTIS-UTEBLIVEN', recept, filer: bas }), fakePool(null));
    expect(fel.code).toBe(2);
    expect(fel.text).toMatch(/KAN INTE DÖMAS för T1\|NOTIS-UTEBLIVEN — basen kunde inte köras/);
    // Okänd korpus.
    const okänd = await repro(kort('S04', { mekanism: 'T1|NOTIS-UTEBLIVEN', recept: { ...recept, korpus: 'finns-inte' }, filer: bas }), fakePool(TOMT));
    expect(okänd.code).toBe(2);
    expect(okänd.text).toMatch(/okänd korpus finns-inte/);
  });

  test('S-KANARIE dömer om kanarien med kanariekontrollen', async () => {
    const st = require('../lib/selftestSynth');
    const { makeFinding, mechanismOf } = require('../lib/finding');
    const FIXTURE = require('./fixtures/kanarie-K1-resultat.json');
    const K1 = st.loadCanaries().find((k) => k.id === 'K1-norr-5kn-A30');
    const mmsi = String(K1.spec.boats[0].mmsi);
    const mekanism = mechanismOf(makeFinding({ orakel: 'S-KANARIE', klass: `PRODUKTFÖRVÄNTAN exakt en notis per punkt för ${mmsi} (6)` }));
    const dir = kort('K1', { mekanism, recept: { relation: 'S-KANARIE', kanarie: K1.id } });
    const grön = await repro(dir, fakePool(FIXTURE.resultat));
    expect(grön.code).toBe(0);
    expect(grön.text).toMatch(/kanarien K1-norr-5kn-A30 \(101 rader, R0; kortet saknar repro\.jsonl\)/);
    expect(grön.text).toMatch(/utfall mot aktuell HEAD: BORTA \(0 brutna produktförväntningar\)/);
    const utanKlaff = clone(FIXTURE.resultat);
    utanKlaff.notifications = utanKlaff.notifications.filter((n) => n.bridge !== 'Klaffbron');
    const röd = await repro(dir, fakePool(utanKlaff));
    expect(röd.code).toBe(0);
    expect(röd.text).toMatch(/utfall mot aktuell HEAD: KVAR/);
    // Ett äldre kort utan recept: kanarien hämtas ur de sparade fynden.
    const äldre = kort('K1-äldre', { mekanism, fynd: [{ orakel: 'S-KANARIE', belägg: { kanarie: K1.id }, ursprung: { kanarie: K1.id } }] });
    expect((await repro(äldre, fakePool(utanKlaff))).text).toMatch(/KVAR/);
    // Blind kanarie (inga varningar): instrumentet kan inte döma.
    const blind = clone(FIXTURE.resultat);
    blind.openingWarnings = [];
    blind.openingCoverage = [];
    const b = await repro(dir, fakePool(blind));
    expect(b.code).toBe(2);
    expect(b.text).toMatch(/KAN INTE DÖMAS .*INSTRUMENT BLINT: öppningsvarningar ≥ 1/);
  });

  test('H1 och H3 döms av hälsooraklen; INV-F av harnessens domare, och körfel ger KAN INTE DÖMAS', async () => {
    const { makeFinding, mechanismOf } = require('../lib/finding');
    const jsonl = { 'bas.jsonl': '{"ctrl":"restart","aisTimestamp":1780000000000}\n' };
    const sig = '[APP ERROR] 🚨 [NY_KLASS] M: något gick snett';
    const h3 = mechanismOf(makeFinding({ orakel: 'H3', klass: sig }));
    const medSig = {
      stderr: {
        h3: { [sig]: 2 }, övrigt: {}, rader: 2, exempel: { [sig]: sig },
      },
    };
    const h3dir = kort('H3', { mekanism: h3, filer: jsonl });
    const h3kvar = await repro(h3dir, fakePool(TOMT, medSig));
    expect(h3kvar.code).toBe(0);
    expect(h3kvar.text).toMatch(/KVAR för H3\|.* — hälsooraklen H1–H3 \(H3 absolut\)/);
    expect((await repro(h3dir, fakePool(TOMT))).text).toMatch(/BORTA för H3\|/);
    const h1dir = kort('H1', { mekanism: 'H1|PROCESSFEL processErrors', recept: { relation: 'BAS', korpus: '20260611-4h' }, filer: jsonl });
    expect((await repro(h1dir, fakePool({ ...TOMT, processErrors: 1 }))).text).toMatch(/KVAR för H1\|PROCESSFEL processErrors/);
    expect((await repro(h1dir, fakePool(TOMT))).text).toMatch(/BORTA för H1\|PROCESSFEL processErrors/);
    // INV-F på ett låst bankkort: harnessens domare; ett körfel kan inte döma en invariant.
    const inv = kort('INV', { mekanism: 'INV-F|INV-3 ETA-SÅGTAND UPP', recept: { relation: 'BAS', korpus: '20260611-4h' }, filer: jsonl });
    const ren = await repro(inv, fakePool(TOMT));
    expect(ren.code).toBe(0);
    expect(ren.text).toMatch(/BORTA för INV-F\|INV-3 ETA-SÅGTAND UPP — befintliga domare/);
    const körfel = await repro(inv, fakePool(null));
    expect(körfel.code).toBe(2);
    expect(körfel.text).toMatch(/KAN INTE DÖMAS för INV-F\|INV-3 ETA-SÅGTAND UPP — körfel: konstruerat körfel/);
  });

  test('domarvalet följer relationen före oraklet', () => {
    const hunt = require('../hunt');
    require('../lib/lanes').discoverLanes();
    const val = (recept, mekanism) => hunt.reproDomare(recept, { mekanism }).id;
    expect(val({ spår: 'synth' }, 'T2|LEDTID<Ns')).toBe('spår');
    expect(val({ relation: 'M-FAS' }, 'H1|PROCESSFEL fatal')).toBe('spår');
    expect(val({ relation: 'S-KALIBRERING' }, 'T10|PASSAGE-EJ-REGISTRERAD')).toBe('S-KALIBRERING');
    expect(val({}, 'S-KANARIE|PRODUKTFÖRVÄNTAN x')).toBe('S-KANARIE');
    expect(val({ relation: 'BAS' }, 'H1|PROCESSFEL fatal')).toBe('hälsa');
    expect(val({}, 'H3|x')).toBe('hälsa');
    expect(val({ relation: 'BAS' }, 'LEV|ÖPPNINGSLEVERANS: N avfyrningar')).toBe('befintliga');
    expect(val({}, 'T9|FEL-RIKTNING')).toBeNull();
    expect(val({ spår: 'okänt' }, 'T2|LEDTID<Ns')).toBeNull();
  });
});
