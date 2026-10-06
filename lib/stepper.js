// lib/stepper.js
// Pure JS 4-wire unipolar stepper driver (28BYJ-48 + ULN2003) for Raspberry Pi 5.
// Includes: wave / full / half step sequences, move N steps, continuous run,
// stop, coil release, drift-compensated step timing, position counter.

const { performance } = require("perf_hooks");
const { GpioOut } = require("./gpio");

// ---------- Step sequences (IN1, IN2, IN3, IN4) ----------
const SEQUENCES = {
  wave: [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ],
  full: [
    [1, 1, 0, 0],
    [0, 1, 1, 0],
    [0, 0, 1, 1],
    [1, 0, 0, 1]
  ],
  half: [
    [1, 0, 0, 0],
    [1, 1, 0, 0],
    [0, 1, 0, 0],
    [0, 1, 1, 0],
    [0, 0, 1, 0],
    [0, 0, 1, 1],
    [0, 0, 0, 1],
    [1, 0, 0, 1]
  ]
};

// ---------- 28BYJ-48 defaults ----------
const DEFAULT_STEPS_PER_TURN = { wave: 2048, full: 2048, half: 4096 };
const MIN_STEP_MS = 1;

function sleep(ms) { return new Promise(r => setTimeout(r, Math.max(0, ms))); }

class Stepper {
  /**
   * @param {object} opts
   * @param {number[]} opts.pins   BCM numbers for IN1..IN4
   * @param {string}  opts.mode    wave | full | half
   * @param {number}  opts.stepMs  time per step in ms
   * @param {boolean} opts.invert  swap left/right
   */
  constructor(opts = {}) {
    const pins = (opts.pins || []).map(Number);
    if (pins.length !== 4 || pins.some(p => !Number.isInteger(p) || p < 0 || p > 27)) {
      throw new Error("need 4 GPIO numbers between 0 and 27");
    }
    if (new Set(pins).size !== 4) throw new Error("the 4 GPIOs must be different");
    if (!SEQUENCES[opts.mode || "half"]) throw new Error(`invalid step mode "${opts.mode}"`);

    this.pins = pins;
    this.mode = opts.mode || "half";
    this.seq = SEQUENCES[this.mode];
    this.stepMs = Math.max(MIN_STEP_MS, Number(opts.stepMs) || 2);
    this.invert = !!opts.invert;

    this.gpios = pins.map(p => new GpioOut(p));
    this.seqIndex = 0;
    this.position = 0;   // + = right, - = left (in steps)
    this.running = false;
    this._runId = 0;
    this._activeRun = null;
  }

  static get DEFAULT_STEPS_PER_TURN() { return Object.assign({}, DEFAULT_STEPS_PER_TURN); }
  static get MODES() { return Object.keys(SEQUENCES); }

  async open() {
    for (const g of this.gpios) await g.open();
  }

  close() {
    this.stop();
    for (const g of this.gpios) g.close();
  }

  _apply(pattern) {
    for (let i = 0; i < 4; i++) this.gpios[i].write(pattern[i]);
  }

  /** All coils off (motor can turn freely, no heat). */
  release() {
    this._apply([0, 0, 0, 0]);
  }

  /** One step: dir +1 = right, -1 = left */
  _step(dir) {
    const d = this.invert ? -dir : dir;
    const n = this.seq.length;
    this.seqIndex = (this.seqIndex + d + n) % n;
    this._apply(this.seq[this.seqIndex]);
    this.position += dir;
  }

  /** Stop the current move / run (resolves the running promise with stopped=true). */
  stop() {
    this._runId++;
  }

  /**
   * Move steps (Infinity = continuous until stop()).
   * @param {number} steps   >= 0
   * @param {number} dir     +1 right, -1 left
   * @param {object} o       { stepMs, release, onProgress(done) }
   * @returns {Promise<{done:number, stopped:boolean, ms:number}>}
   */
  async move(steps, dir, o = {}) {
    this.stop();                       // cancel a previous move
    const runId = ++this._runId;
    const stepMs = Math.max(MIN_STEP_MS, Number(o.stepMs) || this.stepMs);
    const t0 = performance.now();
    let done = 0;
    let nextT = t0;
    this.running = true;
    this._activeRun = runId;

    // energise the current coil pattern before stepping
    this._apply(this.seq[this.seqIndex]);

    try {
      while (done < steps) {
        if (runId !== this._runId) break;
        this._step(dir);
        done++;
        if (o.onProgress && (done % 64 === 0)) o.onProgress(done);
        nextT += stepMs;
        await sleep(nextT - performance.now());   // drift-compensated
      }
    } finally {
      if (this._activeRun === runId) {   // not replaced by a newer move
        this._activeRun = null;
        this.running = false;
        if (o.release) this.release();
      }
    }
    return { done, stopped: done < steps, ms: Math.round(performance.now() - t0) };
  }
}

module.exports = { Stepper, SEQUENCES, DEFAULT_STEPS_PER_TURN };
