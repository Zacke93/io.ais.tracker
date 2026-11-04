'use strict';

/**
 * Rättningsrundan 2026-11-04, M14: den fristående drivaren lib/synthLane.js
 * raderar sin tempkatalog i finally (om inte --tmp eller --keep-temp
 * angetts), och barnen körs med cwd i tempkatalogen, som i pool.js.
 *
 * child_process.execFile ersätts av en jest-attrapp, så inga barnprocesser
 * startas; drivaren körs med noll världar (ingen replay). os.tmpdir() pekas
 * om till testets egen katalog (jest:s process.env når inte core-modulen os).
 */

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');

let tmp;
let log;
let tmpdir;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-synthlane-test-'));
  tmpdir = jest.spyOn(os, 'tmpdir').mockReturnValue(tmp);
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  tmpdir.mockRestore();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const synthTemp = () => fs.readdirSync(tmp).filter((x) => x.startsWith('ais-tracker-hunt-synth-'));

describe('M14: den fristående sanningsspårsdrivaren', () => {
  test('barnet körs med cwd i tempkatalogen (som pool.js)', async () => {
    const cp = require('child_process');
    cp.execFile.mockImplementation((file, args, opts, cb) => {
      cb(null, '__REPLAY_JSON__{"notifications":[]}__END__', '');
      return {};
    });
    const { makeExecFileRunner } = require('../lib/synthLane');
    const kat = path.join(tmp, 'kat');
    const r = await makeExecFileRunner({ tmpDir: kat })(path.join(kat, 'w1-0-R0.jsonl'), { monitoring: true });
    expect(r.result).toEqual({ notifications: [] });
    expect(cp.execFile).toHaveBeenCalledTimes(1);
    const opts = cp.execFile.mock.calls[0][2];
    expect(opts.cwd).toBe(kat);
    expect(opts.env.TMPDIR).toBe(kat);
    expect(opts.env.REPLAY_MONITORING).toBe('1');
  });

  test('tempkatalogen raderas efteråt, även när körningen kastar; --keep-temp och --tmp behåller', async () => {
    const sl = require('../lib/synthLane');
    await sl.main(['node', 'synthLane.js', '--worlds=0', '--jobs=1']);
    expect(synthTemp()).toEqual([]);
    await expect(sl.main(['node', 'synthLane.js', '--worlds=-1'])).rejects.toThrow(/worlds/);
    expect(synthTemp()).toEqual([]);
    await sl.main(['node', 'synthLane.js', '--worlds=0', '--keep-temp']);
    expect(synthTemp()).toHaveLength(1);
    const egen = path.join(tmp, 'egen');
    fs.mkdirSync(egen);
    fs.writeFileSync(path.join(egen, 'behålls.txt'), 'x\n');
    await sl.main(['node', 'synthLane.js', '--worlds=0', `--tmp=${egen}`]);
    expect(fs.readdirSync(egen)).toEqual(['behålls.txt']);
    expect(() => sl.parseArgs(['node', 'synthLane.js', '--keep-temp=ja'])).toThrow(/Okänd flagga/);
  });
});
