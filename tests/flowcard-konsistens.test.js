'use strict';

/**
 * =============================================================================
 * FLOW-KORTENS KONSISTENS: .homeycompose ↔ app.json (etapp 6, 2026-08-03)
 * =============================================================================
 *
 * app.json är GENERERAD av `homey app build` ur .homeycompose/ — men den
 * incheckade app.json är samtidigt den fil Homey faktiskt kör och den enda
 * som replay/enhetstester läser. Divergerar de två är felet TYST: kortet
 * fungerar i utvecklarens byggda app men saknas (eller har fel tokens) i
 * repot, och ingen befintlig svit hade märkt det.
 *
 * Testet låser dessutom TVÅ kontrakt som spänner över filgränser och därför
 * inte kan låsas någon annanstans:
 *
 *  (1) TOKENKONTRAKTET. app.js bygger tokens som strängar/tal; Homey kastar
 *      vid typfel (mock-korten i tests/__mocks__/homey.js speglar exakt det
 *      beteendet). Ändras ett tokennamn i JSON:en utan att app.js följer med
 *      levereras en notis UTAN sitt värde.
 *
 *  (2) DROPDOWN-ID ↔ BRIDGE_NAME_TO_ID. Run-listenern jämför flow-kortets
 *      valda dropdown-id med state.bridge, och state.bridge sätts via
 *      BRIDGE_NAME_TO_ID. Divergerar de matchar kortet ALDRIG — en helt tyst
 *      "flow som aldrig kör"-bugg utan ett enda felmeddelande.
 */

const fs = require('fs');
const path = require('path');

const { BRIDGE_NAME_TO_ID, TARGET_BRIDGES } = require('../lib/constants');

const ROOT = path.join(__dirname, '..');
const COMPOSE_TRIGGERS = path.join(ROOT, '.homeycompose', 'flow', 'triggers');
const COMPOSE_CONDITIONS = path.join(ROOT, '.homeycompose', 'flow', 'conditions');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const appJson = readJson(path.join(ROOT, 'app.json'));

const composeCards = (dir) => fs.readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort() // homey app build läser katalogen i filnamnsordning
  .map((f) => ({ file: f, card: readJson(path.join(dir, f)) }));

/** Alla i18n-fält kräver BÅDA språken (publiceringskrav). */
const expectBilingual = (value, label) => {
  expect(typeof value).toBe('object');
  expect(typeof value.en).toBe('string');
  expect(typeof value.sv).toBe('string');
  expect(value.en.trim().length).toBeGreaterThan(0);
  expect(value.sv.trim().length).toBeGreaterThan(0);
  // Ren svenska/engelska, inte samma sträng kopierad (label används bara i
  // felmeddelandet om assertionen faller).
  expect(`${label}:${typeof value.en}`).toBe(`${label}:string`);
};

describe('Flow-kort: .homeycompose ↔ app.json', () => {
  test('triggers: samma id, samma ordning, IDENTISKT innehåll', () => {
    const compose = composeCards(COMPOSE_TRIGGERS);
    const mirrored = appJson.flow.triggers;

    expect(compose.map((c) => c.card.id)).toEqual(mirrored.map((t) => t.id));
    // Regressionslås: båda korten SKA finnas (etapp 6 lade till det andra).
    expect(mirrored.map((t) => t.id)).toEqual(['boat_near', 'bridge_opening_soon']);

    compose.forEach(({ file, card }, i) => {
      // Djupjämförelse: app.json ska vara en exakt spegel, inte en variant.
      expect({ file, card: mirrored[i] }).toEqual({ file, card });
    });
  });

  test('conditions: samma id, samma ordning, IDENTISKT innehåll', () => {
    const compose = composeCards(COMPOSE_CONDITIONS);
    const mirrored = appJson.flow.conditions;

    expect(compose.map((c) => c.card.id)).toEqual(mirrored.map((t) => t.id));
    compose.forEach(({ file, card }, i) => {
      expect({ file, card: mirrored[i] }).toEqual({ file, card });
    });
  });

  test('varje trigger-fil heter som sitt id (annars bryts byggordningen)', () => {
    composeCards(COMPOSE_TRIGGERS).forEach(({ file, card }) => {
      expect(file).toBe(`${card.id}.json`);
    });
  });
});

describe('Flow-kort: publiceringsrena texter (sv + en)', () => {
  const allCards = [...appJson.flow.triggers, ...appJson.flow.conditions];

  test.each(allCards.map((c) => [c.id, c]))('%s har sv+en överallt', (id, card) => {
    expectBilingual(card.title, `${id}.title`);
    if (card.titleFormatted) expectBilingual(card.titleFormatted, `${id}.titleFormatted`);
    if (card.hint) expectBilingual(card.hint, `${id}.hint`);

    for (const arg of card.args || []) {
      expectBilingual(arg.title, `${id}.args.${arg.name}.title`);
      for (const value of arg.values || []) {
        // Bronamn är egennamn och lokaliseras inte (t.ex. "Klaffbron") — de
        // ligger som ren sträng, precis som i boat_near sedan v1.
        if (typeof value.title === 'string') {
          expect(value.title.trim().length).toBeGreaterThan(0);
        } else {
          expectBilingual(value.title, `${id}.args.${arg.name}.${value.id}`);
        }
      }
    }

    for (const token of card.tokens || []) {
      expectBilingual(token.title, `${id}.tokens.${token.name}.title`);
    }
  });

  test.each(allCards.map((c) => [c.id, c]))('%s: titleFormatted refererar bara existerande args', (id, card) => {
    if (!card.titleFormatted) return;
    const argNames = new Set((card.args || []).map((a) => a.name));
    for (const text of Object.values(card.titleFormatted)) {
      const placeholders = [...text.matchAll(/\[\[(\w+)\]\]/g)].map((m) => m[1]);
      for (const p of placeholders) {
        expect({ id, placeholder: p, known: argNames.has(p) })
          .toEqual({ id, placeholder: p, known: true });
      }
    }
  });
});

describe('Flow-kort: tokenkontraktet (låst mot app.js)', () => {
  const tokensOf = (id) => {
    const card = appJson.flow.triggers.find((t) => t.id === id);
    expect(card).toBeDefined();
    return card.tokens.map((t) => `${t.name}:${t.type}`).sort();
  };

  test('boat_near-tokens är OFÖRÄNDRADE (heligt kontrakt)', () => {
    expect(tokensOf('boat_near')).toEqual([
      'bridge_name:string',
      'direction:string',
      'eta_available:boolean',
      'eta_minutes:number',
      'vessel_name:string',
    ]);
  });

  test('bridge_opening_soon har exakt de fem avtalade tokens', () => {
    expect(tokensOf('bridge_opening_soon')).toEqual([
      'bridge_name:string',
      'direction:string',
      'eta_minutes:number',
      'vessel_count:number',
      'vessel_name:string',
    ]);
  });

  test('token-namn är unika per kort', () => {
    for (const card of appJson.flow.triggers) {
      const names = card.tokens.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe('Flow-kort: dropdown-id ↔ BRIDGE_NAME_TO_ID', () => {
  const dropdownIds = (cardId) => {
    const card = appJson.flow.triggers.find((t) => t.id === cardId)
      || appJson.flow.conditions.find((t) => t.id === cardId);
    const arg = card.args.find((a) => a.name === 'bridge');
    return arg.values.map((v) => v.id);
  };

  test('bridge_opening_soon listar BARA de öppningsbara broarna', () => {
    // Stallbackabron öppnar ALDRIG och får inte gå att välja — dess närvaro i
    // dropdownen hade lovat en varning som per konstruktion aldrig kommer.
    const ids = dropdownIds('bridge_opening_soon');
    expect(ids[0]).toBe('any');
    expect(ids.slice(1).sort()).toEqual(
      TARGET_BRIDGES.map((name) => BRIDGE_NAME_TO_ID[name]).sort(),
    );
    expect(ids).not.toContain('stallbackabron');
  });

  test('alla bro-id:n i alla kort är kända i BRIDGE_NAME_TO_ID', () => {
    const known = new Set(Object.values(BRIDGE_NAME_TO_ID));
    for (const cardId of ['boat_near', 'bridge_opening_soon', 'boat_at_bridge']) {
      for (const id of dropdownIds(cardId)) {
        if (id === 'any') continue;
        expect({ cardId, id, known: known.has(id) }).toEqual({ cardId, id, known: true });
      }
    }
  });
});
