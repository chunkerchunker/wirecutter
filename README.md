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

### hotwire control

user_outputs:
  analog0_pin: gpio.XX  # Replace XX with your specific output pin number
  analog0_hz: 50        # Sets the frequency to 50Hz (or lower, like 10)

Once configured, you can control the duty cycle via G-code using the M67 command. For example:
⚬	M67 E0 Q25 — Sets analog0 to a 25% duty cycle.
⚬	M67 E0 Q100 — Sets analog0 to 100% (fully on).
⚬	M67 E0 Q0 — Turns the output off.
