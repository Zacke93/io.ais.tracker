'use strict';

/**
 * CaptureJournal (U71, omgång 9): fältfångsten tål hål i loggströmmen.
 *
 * BAKGRUND. Strömmen Homey → `homey app run` tappar ibland 1–3 minuter
 * loggrader (nio gånger på cirka 255 h fältlogg) medan appen går vidare.
 * Kommandoradsverktyget prenumererar utan kvittens, så det som sänds medan
 * anslutningen är bruten är borta. Fångsten ([AIS_REPLAY_SAMPLE]) och de
 * händelser som fältjämförelsen läser försvann med raderna, och körningen
 * kunde inte låsas som korpus.
 *
 * MEKANISMEN. Varje journalförd rad får ett löpnummer i en ström
 * (`#<sid>:<nr> <meddelandet>`), hålls i en begränsad buffert och skrivs
 * igen i minutloopen när den blivit 2 och 10 minuter gammal. Varje minut
 * skrivs en kontrollpunkt med senaste numret och antalet släppta poster.
 * Loggskriptet tar bort dubbletterna på numret och grinden
 * (tests/replay-validation/captureJournal.js) godkänner ett tidshål bara när
 * varje nummer finns.
 *
 * INNESLUTNING (U58). Journalen får aldrig skada appen: inget anrop kastar,
 * varje skrivning sker i try/catch, och ett fel räknas men loggas aldrig
 * (att logga ett loggfel var just slingan i U58). Kastar journalens egen
 * bokföring skrivs meddelandet ändå, utan nummer. Journalen läser inget
 * apptillstånd och startar ingen timer.
 *
 * Journalen skapas bara på debug_level 'full' (se app._syncCaptureJournal);
 * på övriga nivåer finns den inte och loggraderna är som förut.
 */

/** Omsändningarnas ålder i ms (U71: efter 2 och 10 minuter). */
const RESEND_AFTER_MS = Object.freeze([2 * 60 * 1000, 10 * 60 * 1000]);

/**
 * Buffertens tak. Bankens tätaste trafik gav 73 sampel på 10 minuter, så
 * normalt ligger bufferten under ~100 poster. Taket skyddar minnet om
 * minutloopen står (eller klockan hoppar bakåt så att posterna aldrig åldras).
 */
const MAX_ENTRIES = 1000;

const TAG_START = '[CAPTURE_START]';
const TAG_END = '[CAPTURE_END]';
const TAG_RESEND = '[CAPTURE_RESEND]';
const TAG_CHECKPOINT = '[CAPTURE_SEQ]';

class CaptureJournal {
  /**
   * @param {Object} opts
   * @param {Function} opts.log - skriver en rad till stdout (app.log)
   * @param {Function} [opts.error] - skriver en rad till stderr (app.error)
   * @param {Function} [opts.now] - klocka i ms (Date.now)
   * @param {number} opts.bootMs - processens starttid, ger strömmens id
   * @param {number} opts.epoch - aktiveringens nummer i processen
   * @param {number} [opts.maxEntries]
   * @param {Function} [opts.encode] - kodar ett meddelande för omsändning
   */
  constructor(opts = {}) {
    this._log = typeof opts.log === 'function' ? opts.log : () => {};
    this._error = typeof opts.error === 'function' ? opts.error : this._log;
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    this._encode = typeof opts.encode === 'function'
      ? opts.encode
      : (message) => Buffer.from(message, 'utf8').toString('base64');
    this._maxEntries = Number.isInteger(opts.maxEntries) && opts.maxEntries > 0
      ? opts.maxEntries : MAX_ENTRIES;
    const boot = Number.isFinite(opts.bootMs) ? Math.floor(opts.bootMs) : 0;
    const epoch = Number.isInteger(opts.epoch) && opts.epoch > 0 ? opts.epoch : 1;
    this.sid = `${Math.max(0, boot).toString(36)}-${epoch}`;
    this.seq = 0;
    this.dropped = 0;
    this.errors = 0;
    this._buffer = [];
    this._ended = false;
  }

  /** Antal poster i bufferten (för test och kontrollpunkt). */
  get buffered() {
    return this._buffer.length;
  }

  /** Strömmens första post. Journalförs som vilken post som helst. */
  start(reason) {
    this.record(`${TAG_START} sid=${this.sid} reason=${reason || 'okänd'}`);
  }

  /**
   * Skriver en journalförd rad och lägger den i bufferten.
   * @param {string} message - raden som den skulle ha loggats utan journal
   * @param {'log'|'err'} [stream]
   */
  record(message, stream = 'log') {
    const toErr = stream === 'err';
    let line = message;
    try {
      if (!this._ended) {
        const text = String(message);
        const seq = this.seq + 1;
        const entry = {
          seq, at: this._now(), message: text, err: toErr, sent: 0,
        };
        this._buffer.push(entry);
        this.seq = seq;
        if (this._buffer.length > this._maxEntries) {
          this._buffer.shift();
          this.dropped += 1;
        }
        line = `#${this.sid}:${seq} ${text}`;
      }
    } catch (err) {
      // Bokföringen föll: meddelandet skrivs ändå, utan nummer. Grinden ser
      // det som ett sampel utan löpnummer och fäller körningen.
      this.errors += 1;
      line = message;
    }
    this._write(toErr ? this._error : this._log, line);
  }

  /**
   * Minutslaget: omsändningar och kontrollpunkt. Anropas sist i appens
   * befintliga minutloop; ändrar inget annat än loggen.
   */
  tick() {
    if (this._ended) return;
    try {
      const now = this._now();
      const keep = [];
      for (const entry of this._buffer) {
        const age = now - entry.at;
        if (entry.sent === 0 && age >= RESEND_AFTER_MS[0]) {
          entry.sent = 1;
          this._resend(entry);
        }
        if (entry.sent === 1 && age >= RESEND_AFTER_MS[1]) {
          entry.sent = 2;
          this._resend(entry);
        }
        if (entry.sent < 2) keep.push(entry);
      }
      this._buffer = keep;
    } catch (err) {
      this.errors += 1;
    }
    this._write(this._log, `${TAG_CHECKPOINT} sid=${this.sid} seq=${this.seq} `
      + `buffered=${this._buffer.length} dropped=${this.dropped} errors=${this.errors}`);
  }

  /** Strömmens slut: bufferten töms och journalen tar inte emot fler poster. */
  end(reason) {
    if (this._ended) return;
    this._ended = true;
    this._buffer = [];
    this._write(this._log, `${TAG_END} sid=${this.sid} seq=${this.seq} dropped=${this.dropped} `
      + `errors=${this.errors} reason=${reason || 'okänd'}`);
  }

  _resend(entry) {
    let line;
    try {
      const payload = {
        sid: this.sid,
        seq: entry.seq,
        at: new Date(entry.at).toISOString(),
        b64: this._encode(entry.message),
      };
      if (entry.err) payload.e = 1;
      line = `${TAG_RESEND} ${JSON.stringify(payload)}`;
    } catch (err) {
      this.errors += 1;
      return;
    }
    this._write(this._log, line);
  }

  _write(writer, line) {
    try {
      writer(line);
    } catch (err) {
      // Aldrig loggat: ett fel i loggkanalen får inte ge fler loggförsök (U58).
      this.errors += 1;
    }
  }
}

module.exports = {
  CaptureJournal,
  RESEND_AFTER_MS,
  MAX_ENTRIES,
  TAG_START,
  TAG_END,
  TAG_RESEND,
  TAG_CHECKPOINT,
};
