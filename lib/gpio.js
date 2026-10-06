// lib/gpio.js
// Pure JS GPIO output for Raspberry Pi 5 via sysfs (/sys/class/gpio). No native addon.
// Includes: auto-detect of the GPIO chip base (Pi 5 RP1 = "pinctrl-rp1", e.g. base 571),
// export / direction / fast value writes on an open file descriptor, unexport.

const fs = require("fs");
const path = require("path");

// ---------- Paths ----------
const SYSFS_GPIO   = "/sys/class/gpio";
const EXPORT_PATH  = path.join(SYSFS_GPIO, "export");
const UNEXPORT_PATH = path.join(SYSFS_GPIO, "unexport");

// ---------- Chip labels (preferred first) ----------
const CHIP_LABELS  = ["pinctrl-rp1", "pinctrl-bcm2712", "pinctrl-bcm2711", "pinctrl-bcm2835"];

// ---------- Timing ----------
const EXPORT_RETRIES  = 40;   // udev needs a moment to set permissions
const EXPORT_RETRY_MS = 25;

const VALUE_0 = Buffer.from("0");
const VALUE_1 = Buffer.from("1");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readTrim(p) {
  return fs.readFileSync(p, "utf8").trim();
}

let cachedBase = null;

/** Find the sysfs number offset of the 40-pin header GPIO chip. */
function findGpioBase() {
  if (cachedBase !== null) return cachedBase;
  let entries;
  try {
    entries = fs.readdirSync(SYSFS_GPIO).filter(n => n.startsWith("gpiochip"));
  } catch (e) {
    throw new Error(`${SYSFS_GPIO} not available (sysfs GPIO disabled in kernel?)`);
  }
  const chips = entries.map(n => {
    const dir = path.join(SYSFS_GPIO, n);
    try {
      return {
        label: readTrim(path.join(dir, "label")),
        base: parseInt(readTrim(path.join(dir, "base")), 10),
        ngpio: parseInt(readTrim(path.join(dir, "ngpio")), 10)
      };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);

  for (const label of CHIP_LABELS) {
    const c = chips.find(x => x.label === label);
    if (c) { cachedBase = c.base; return cachedBase; }
  }
  throw new Error(`no Raspberry Pi GPIO chip found (labels: ${chips.map(c => c.label).join(", ") || "none"})`);
}

class GpioOut {
  /** @param {number} bcm  BCM GPIO number (0..27) */
  constructor(bcm) {
    this.bcm = bcm;
    this.sysNum = null;
    this.fd = null;
    this.exportedByUs = false;
  }

  async open() {
    if (this.fd !== null) return;
    this.sysNum = findGpioBase() + this.bcm;
    const dir = path.join(SYSFS_GPIO, "gpio" + this.sysNum);

    if (!fs.existsSync(dir)) {
      try {
        fs.writeFileSync(EXPORT_PATH, String(this.sysNum));
        this.exportedByUs = true;
      } catch (e) {
        if (e.code === "EBUSY") throw new Error(`GPIO${this.bcm} is busy (used by another driver/overlay?)`);
        if (e.code === "EACCES") throw new Error(`no permission for ${EXPORT_PATH} (user in group gpio?)`);
        throw e;
      }
    }

    // Wait until udev made direction/value writable, then set output low
    let lastErr = null;
    for (let i = 0; i < EXPORT_RETRIES; i++) {
      try {
        fs.writeFileSync(path.join(dir, "direction"), "low");
        this.fd = fs.openSync(path.join(dir, "value"), "r+");
        return;
      } catch (e) {
        lastErr = e;
        await sleep(EXPORT_RETRY_MS);
      }
    }
    throw new Error(`GPIO${this.bcm}: cannot set as output (${lastErr && lastErr.message})`);
  }

  write(v) {
    if (this.fd === null) return;
    fs.writeSync(this.fd, v ? VALUE_1 : VALUE_0, 0, 1, 0);
  }

  close() {
    if (this.fd !== null) {
      try { this.write(0); } catch (e) { /* ignore */ }
      try { fs.closeSync(this.fd); } catch (e) { /* ignore */ }
      this.fd = null;
    }
    if (this.exportedByUs && this.sysNum !== null) {
      try { fs.writeFileSync(UNEXPORT_PATH, String(this.sysNum)); } catch (e) { /* ignore */ }
      this.exportedByUs = false;
    }
  }
}

module.exports = { GpioOut, findGpioBase };
