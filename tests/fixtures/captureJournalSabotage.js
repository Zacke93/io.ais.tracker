'use strict';

/**
 * U71-test: förladdas i en replay (node -r) och saboterar fångstjournalen
 * inifrån: varje skrivning kastar, bufferten har plats för en post (allt
 * släpps) och kodningen kastar. Appens utfall ska ändå vara bitlika (U58).
 */
const { CaptureJournal } = require('../../lib/utils/CaptureJournal');

const originalStart = CaptureJournal.prototype.start;
CaptureJournal.prototype.start = function sabotagedStart(reason) {
  this._log = () => {
    throw new Error('EPIPE (sabotage)');
  };
  this._error = this._log;
  this._encode = () => {
    throw new Error('kodfel (sabotage)');
  };
  this._maxEntries = 1;
  global.__u71Sabotaged = (global.__u71Sabotaged || 0) + 1;
  return originalStart.call(this, reason);
};
