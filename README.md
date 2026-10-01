# notes

## refs

- [JackpotV2 controller board](https://docs.v1e.com/electronics/jackpot2)
- [FluidNC controler firmware](http://wiki.fluidnc.com/)
- [FluidNC WebUIv3](https://github.com/michmela44/ESP3D-WEBUI)
- [FluidNC WebUIv3 snapshot](./lib/index.html.gz)

## Jackpot/FluidNC config

`config.yaml` has to be uploaded using the Chrome installer (settings don't persist via web ui (?)).

- [config](./config.yaml)
- [Chrome-based FluidNC installer](https://installer.fluidnc.com/fluidnc)

Once installed, and once wifi is configured (also via Chrome installer), access at [WebUI](http://hotwire.local).

## Web control page

`web/` is a static page served from the controller's SD card over FluidNC's WebDAV.

- `just deploy` bundles it and uploads it (gzipped) to `http://hotwire.local/sd/index.html`. Bundling is required: the controller serves at most two files at once and answers a third concurrent request with a 404.
- `config.html` edits the UI defaults, saved as `settings.json` on the SD card (`just settings-get` / `just settings-put`)
- `just serve` runs it locally at http://127.0.0.1:8000 (ES modules don't load from `file://`)
- `just vendor` rebuilds `web/vendor/three.js` (three.js subset for the G-code simulator)

### hotwire control

The hotwire is configured as FluidNC's PWM spindle (`PWM:` in `config.yaml`), with `speed_map: 0=0% 100=100%` so `S` is the duty cycle in percent:
- `M3 S25` — 25% duty cycle (waits `spinup_ms` for the wire to heat)
- `M3 S100` — fully on
- `M5` — off (also forced off on alarm via `off_on_alarm: true`)

`S` is modal and resets to 0 on boot or soft reset, so always give it on the `M3` line. Spindle changes wait for queued motion to finish, so changing `S` mid-program briefly stops motion.

The Jackpot2's outputs can't do fast PWM (see the [Jackpot2 docs](https://docs.v1e.com/electronics/jackpot2/)), so `pwm_hz` stays low (10). This rules out the `Laser:` spindle type, which requires `pwm_hz` >= 1000.
