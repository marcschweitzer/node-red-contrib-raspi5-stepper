# node-red-contrib-raspi5-stepper

28BYJ-48 stepper motor Node with **ULN2003** driver board for **Raspberry Pi 5** – **pure JavaScript**, no Python, no external daemon, no native addon.

Supports:
- **4 GPIOs selectable** (IN1..IN4) in the node
- Requests by **direction** (`left` / `right`), **steps** or **turns**
- Continuous run until `stop`
- Half step, full step and wave drive
- Steps per turn and step time (ms) configurable
- Position counter, `done` / `stopped` output events
- Dynamic wiring hints and speed display in the Node-RED editor

---

## ⚠️ Prerequisite: sysfs GPIO

This node talks **directly** to `/sys/class/gpio` (works on Raspberry Pi OS Bookworm / Trixie).

Check:
```bash
ls /sys/class/gpio
```
You should see:
```
export  gpiochip571  ...  unexport
```
On the Pi 5 the header GPIOs start at an offset (e.g. `gpiochip571`).  
The node finds this offset **automatically**.

The user running Node-RED must be in the group `gpio` (see *Test / Debug*).

---

## Wiring

The node editor shows **dynamic wiring instructions** for the selected GPIOs.

Default GPIOs (no conflict with SPI0, SPI1 or I2C):

| ULN2003 | Raspberry Pi 5 |
|---|---|
| IN1 | GPIO5 (Pin 29) |
| IN2 | GPIO6 (Pin 31) |
| IN3 | GPIO13 (Pin 33) |
| IN4 | GPIO26 (Pin 37) |
| + (5-12V) | 5V (Pin 2 or 4) or external 5V supply |
| - | GND (Pin 39) |

- Motor: 5-wire plug into the white socket of the ULN2003 board
- ⚠️ **Never** connect the motor coils directly to the GPIOs
- ⚠️ External supply → **common GND** with the Pi
- One 28BYJ-48 (5V) draws ~240 mA

---

## Installation

### Via Node-RED Palette
Search for:
```
node-red-contrib-raspi5-stepper
```

### Manual install
```bash
cd ~/.node-red
npm install node-red-contrib-raspi5-stepper
sudo systemctl restart nodered
```

---

## Node Configuration

Configured **entirely inside the node**:

- IN1, IN2, IN3, IN4 (GPIO numbers, BCM)
- Step mode:
  - `half` – smooth, **4096** steps per turn
  - `full` – more torque, **2048** steps per turn
  - `wave` – one coil, low power, **2048** steps per turn
- Steps per turn
- Step time (ms) – the editor shows the resulting speed (s per turn / rpm)
- Default direction
- Invert (swap left / right)
- Release (coils off after each move: no heat, but no holding torque)

The 28BYJ-48 reaches ~15 rpm max: half step ≥ 1 ms, full step ≥ 2 ms.

---

## Input

**One request per message.** Use `direction` and **one** of `steps` or `turns`.  
The values can be in `msg` or in `msg.payload`.

### Steps
```
msg.direction = "right"
msg.steps     = 512
```

### Turns
```
msg.payload = { direction: "left", turns: 2 }
msg.payload = { turns: 0.25 }          // default direction
```

### Continuous
```
msg.direction = "left"                 // only a direction
msg.payload   = "right"                // or as payload string
```
Runs until `stop` or the next request.

### Commands
```
msg.payload = "stop"                   // stop (release if enabled)
msg.payload = "release"                // stop + all coils off
msg.payload = "zero"                   // position = 0
```

### Notes
- `steps` **and** `turns` in the same request → error
- negative `steps` / `turns` → other direction
- `msg.payload = 200` (number) → 200 steps in the default direction
- `msg.stepMs` → step time for this request only
- a new request **stops the running move** (output `stopped`) and starts the new one

---

## Output Events

### Move finished
```
topic: "done"
payload.event: "done"
```

### Move stopped / replaced
```
topic: "stopped"
payload.event: "stopped"
```

### Payload
```
payload.direction:      "left" | "right"
payload.requestedSteps: <number> | null (continuous)
payload.steps:          <steps done>
payload.turns:          <turns done>
payload.position:       <total steps, right = +>
payload.positionTurns:  <total turns>
payload.stepMs:         <ms>
payload.ms:             <duration>
```

---

## Safety

- ❌ Motor never directly on GPIOs – always via ULN2003
- ❌ The node refuses the same GPIO twice
- ✅ Coils are switched off on deploy / stop of Node-RED
- ✅ Editor warns if a GPIO belongs to SPI / I2C / UART

---

## Test / Debug

Check permissions:
```bash
groups
# user must be in group: gpio
```

Add user if needed:
```bash
sudo usermod -aG gpio $USER
```

Re-login required.

Motor only vibrates / does not turn:
- wrong IN order → check IN1..IN4 wiring
- step time too short → increase `Step time (ms)`
- weak power supply

Turns the wrong way → enable **Invert**.

---

## License
MIT
