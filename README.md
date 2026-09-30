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

- `just deploy` uploads it (gzipped) to `http://hotwire.local/sd/hotwire/index.html`
- `just serve` runs it locally at http://127.0.0.1:8000 (ES modules don't load from `file://`)
- `just vendor` rebuilds `web/vendor/three.js` (three.js subset for the G-code simulator)

### hotwire control

The hotwire is configured as FluidNC's Laser spindle (`Laser:` in `config.yaml`), with `speed_map: 0=0% 100=100%` so `S` is the duty cycle in percent. Laser mode applies `S` changes without stopping motion, so power can vary mid-cut.
- `G1 M3 S25` — 25% duty cycle (`G1` needed when idle: laser mode holds the output at 0 unless the modal motion is G1/G2/G3)
- `S40` on a `G1` line — change power mid-cut
- `M5` — off (also forced off on alarm via `off_on_alarm: true`)

`G0` moves run with the wire off; the output returns to `S` on the next `G1`/`G2`/`G3` move. Jogs (`$J=`) keep it at `S`. There is no spin-up delay; add a dwell (`G4 P2`) after `M3` to let the wire heat.
