# CLAUDE.md

Hot-wire foam cutter driven by a Jackpot V2 (ESP32) board running FluidNC, plus a static browser control page served from the board's SD card. See `README.md` for hardware links and hotwire `M3`/`M5` usage.

## Machine

- **Z** — knife (wire height).
- **Y** + **A** — two motors driving a differential platform. Moving Y and A together translates the bed; moving A alone rotates it. Bed position = Y, rotation (deg) = (A − Y) / `MM_PER_DEG` (`web/js/machine.js`). Assumes Y and A share `steps_per_mm`.
- **Hotwire** — FluidNC `PWM:` spindle on gpio.02, `pwm_hz: 10` (the Jackpot2 outputs can't do fast PWM, which rules out the `Laser:` spindle). `S` = duty cycle %.
- No X axis; status reports still list X,Y,Z,A.

## Layout

- `config.yaml` — FluidNC machine config. Must be uploaded via the Chrome installer (https://installer.fluidnc.com/fluidnc); `$Bye` reboots to reload it. Keep `MAX_FEED` in `web/js/machine.js` in sync with `max_rate_mm_per_min`.
- `web/` — the control page: plain ES modules, no build step, no framework.
  - `js/app.js` — WebSocket connection to FluidNC (`ws://<host>/`, binary frames = output, text frames = control), status polling, jogging (tap/hold), soft-limit capping for synced Y+A bed jogs, move-to-position, G-code streaming with pause/resume/stop and run lockout, terminal.
  - `js/machine.js` — constants shared by UI and simulator.
  - `js/sim/` — 3D cut simulation: `gcode.js` (minimal interpreter → straight-line moves), `carve.js` (voxel carving; runs in `worker.js`), `viewer.js` (three.js scene), `panel.js` (UI + playback).
  - `vendor/three.js` — generated tree-shaken three.js subset. Don't edit; rebuild with `just vendor`.
- `tools/deploy.py` — incremental WebDAV upload of `web/` (gzipped) to the SD card, using a hash manifest on the card since the controller has no RTC.
- `tools/three-bundle/` — esbuild config for `vendor/three.js`. If `viewer.js` needs a new three.js export, add it to `entry.js` and rerun `just vendor`.
- `lib/index.html.gz` — snapshot of the stock FluidNC WebUI v3, for reference.

## Commands

```sh
just serve           # http://127.0.0.1:8000 (ES modules don't load from file://)
just deploy          # upload changed web/ files to http://hotwire.local/sd/
just deploy --all    # re-upload everything; -n for dry run
just vendor          # rebuild web/vendor/three.js (pnpm)
```

There are no tests. Verify UI changes with `just serve` against the live controller (host is editable in the connection popup).

## FluidNC gotchas encoded in app.js

- FluidNC clamps each axis of a jog to its own soft limits, so a Y+A bed jog hitting Y's limit would keep moving A and rotate the platform. Bed jogs are capped to the travel both axes have left (limits read from `$/axes/<axis>` on connect).
- Soft reset while moving raises Abort Cycle; Stop does jog-cancel + feed hold, waits for `Hold:0`, then resets.
- Realtime commands (`?`, `!`, `~`, `0x85`, `0x18`) bypass the line queue and get no `ok`.
- Spindle `S` is modal and resets to 0 on boot/reset — always give it on the `M3` line. Spindle changes wait for queued motion to drain.
- Moves from the UI use `$J` so they can't disturb modal G-code state.
