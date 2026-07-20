klippy:
	.venv/bin/python klippy/klippy.py config/hotwire.cfg

serial:
	.venv/bin/python -m serial.tools.miniterm --eol LF /tmp/printer
