/**
 * node-red-contrib-raspi5-stepper
 * Node: raspi5-stepper
 *
 * 28BYJ-48 stepper motor with ULN2003 driver board on Raspberry Pi 5 (pure JS, sysfs GPIO).
 *
 * Config:
 * - 4 GPIOs (IN1..IN4), step mode (half / full / wave)
 * - steps per turn, step time (ms), default direction, invert, release coils after move
 *
 * Input (one request per msg, values in msg.* or msg.payload.*):
 * - direction : "left" | "right"            (optional with steps/turns, default from config)
 * - steps     : number of steps             } use ONE of steps / turns
 * - turns     : number of turns (0.25 ok)   } (none = run continuously until "stop")
 * - stepMs    : optional step time override
 * - msg.payload = "stop" | "release" | "zero" | "left" | "right" | <number of steps>
 *
 * Output:
 * - topic "done"    when a move finished
 * - topic "stopped" when a move was stopped / replaced by a new request
 */
module.exports = function(RED) {
  const { Stepper, DEFAULT_STEPS_PER_TURN } = require("../lib/stepper");

  const DIR_WORDS = {
    left: -1, l: -1, ccw: -1, links: -1, gauche: -1, "-1": -1,
    right: 1, r: 1, cw: 1, rechts: 1, droite: 1, "1": 1
  };

  function parseIntSafe(v, dflt) {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  }

  function parseDir(v) {
    if (v === undefined || v === null || v === "") return null;
    const d = DIR_WORDS[String(v).trim().toLowerCase()];
    return d === undefined ? NaN : d;
  }

  function dirName(d) { return d < 0 ? "left" : "right"; }

  function pick(msg, key) {
    if (msg[key] !== undefined) return msg[key];
    if (msg.payload && typeof msg.payload === "object" && msg.payload[key] !== undefined) return msg.payload[key];
    return undefined;
  }

  function StepperNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Config
    const pins = [config.pin1, config.pin2, config.pin3, config.pin4].map(p => parseIntSafe(p, -1));
    const mode = String(config.mode || "half");
    const stepsPerTurn = Math.max(1, parseIntSafe(config.stepsPerTurn, DEFAULT_STEPS_PER_TURN[mode] || 4096));
    const stepMs = Math.max(1, parseIntSafe(config.stepMs, 2));
    const defaultDir = (config.defaultDir === "left") ? -1 : 1;
    const invert = !!config.invert;
    const releaseAfter = (config.release === undefined) ? true : !!config.release;

    let motor = null;
    let ready = null;   // Promise of open()

    function setStatus(fill, shape, text) {
      node.status({ fill, shape, text });
    }

    function idleText() {
      return `GPIO ${pins.join(",")} pos ${motor ? motor.position : 0}`;
    }

    function ensureMotor() {
      if (!ready) {
        motor = new Stepper({ pins, mode, stepMs, invert });
        ready = motor.open().then(() => {
          setStatus("green", "ring", idleText());
        });
        ready.catch(() => { ready = null; });
      }
      return ready;
    }

    function buildMsg(m, topic, req, res) {
      return {
        topic,
        payload: {
          event: topic,
          direction: dirName(req.dir),
          requestedSteps: Number.isFinite(req.steps) ? req.steps : null,
          steps: res.done,
          turns: +(res.done / stepsPerTurn).toFixed(4),
          position: m.position,
          positionTurns: +(m.position / stepsPerTurn).toFixed(4),
          stepMs: req.stepMs,
          ms: res.ms,
          ts: Date.now()
        }
      };
    }

    /** Parse a msg into a request or a command. Throws on invalid input. */
    function parseRequest(msg) {
      const p = msg.payload;

      if (typeof p === "string") {
        const s = p.trim().toLowerCase();
        if (s === "stop" || s === "release" || s === "zero") return { cmd: s };
      }

      let direction = pick(msg, "direction");
      let steps = pick(msg, "steps");
      let turns = pick(msg, "turns");
      const stepMsReq = pick(msg, "stepMs");

      // Shortcuts: payload "left"/"right" or a plain number of steps
      if (direction === undefined && typeof p === "string" && DIR_WORDS[p.trim().toLowerCase()] !== undefined) {
        direction = p;
      }
      if (steps === undefined && turns === undefined && typeof p === "number") {
        steps = p;
      }

      const hasSteps = steps !== undefined && steps !== null && steps !== "";
      const hasTurns = turns !== undefined && turns !== null && turns !== "";
      if (hasSteps && hasTurns) throw new Error("use only ONE of steps or turns per request");

      let dir = parseDir(direction);
      if (Number.isNaN(dir)) throw new Error(`invalid direction "${direction}" (use left / right)`);
      if (dir === null && !hasSteps && !hasTurns) {
        throw new Error("nothing to do: send direction, steps or turns");
      }
      if (dir === null) dir = defaultDir;

      let n = Infinity;   // continuous
      if (hasSteps) {
        n = Number(steps);
        if (!Number.isFinite(n)) throw new Error(`invalid steps "${steps}"`);
        n = Math.round(n);
      } else if (hasTurns) {
        const t = Number(turns);
        if (!Number.isFinite(t)) throw new Error(`invalid turns "${turns}"`);
        n = Math.round(t * stepsPerTurn);
      }
      if (n < 0) { n = -n; dir = -dir; }   // negative value = other direction

      return {
        dir,
        steps: n,
        stepMs: Math.max(1, parseIntSafe(stepMsReq, stepMs))
      };
    }

    function runRequest(req) {
      const label = Number.isFinite(req.steps) ? `/${req.steps}` : " (continuous)";
      setStatus("blue", "dot", `${dirName(req.dir)} 0${label}`);
      const m = motor;   // keep reference (node may be closed while moving)

      m.move(req.steps, req.dir, {
        stepMs: req.stepMs,
        release: releaseAfter,
        onProgress: (done) => setStatus("blue", "dot", `${dirName(req.dir)} ${done}${label}`)
      }).then(res => {
        const topic = res.stopped ? "stopped" : "done";
        node.send(buildMsg(m, topic, req, res));
        if (m === motor && !m.running) {
          setStatus(res.stopped ? "yellow" : "green", res.stopped ? "ring" : "dot",
            `${topic} ${dirName(req.dir)} ${res.done} | pos ${m.position}`);
        }
      }).catch(e => {
        setStatus("red", "ring", e.message || "move error");
        node.error(e, {});
      });
    }

    // Input
    node.on("input", async function(msg, send, done) {
      try {
        const req = parseRequest(msg);
        await ensureMotor();

        if (req.cmd === "stop") {
          motor.stop();
          if (releaseAfter) motor.release();
          setStatus("yellow", "ring", "stop | " + idleText());
        } else if (req.cmd === "release") {
          motor.stop();
          motor.release();
          setStatus("grey", "ring", "released | " + idleText());
        } else if (req.cmd === "zero") {
          motor.position = 0;
          setStatus("green", "ring", idleText());
        } else if (req.steps === 0) {
          setStatus("green", "ring", idleText());
        } else {
          runRequest(req);   // runs in background, output when finished
        }
        done();
      } catch (e) {
        setStatus("red", "ring", e.message || "error");
        done(e);
      }
    });

    node.on("close", function(removed, done) {
      try {
        if (motor) motor.close();
      } catch (e) { /* ignore */ }
      motor = null;
      ready = null;
      node.status({});
      done();
    });

    // Start
    (async () => {
      try {
        await ensureMotor();
      } catch (e) {
        setStatus("red", "ring", e.message || "init error");
        node.error(e, {});
      }
    })();
  }

  RED.nodes.registerType("raspi5-stepper", StepperNode);
};
