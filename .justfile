setup:
	uv add -r scripts/klippy-requirements.txt

klippy:
	uv run klippy/klippy.py config/hotwire.cfg

serial:
	uv run python -m serial.tools.miniterm --eol LF /tmp/printer
