setup:
	uv add -r scripts/klippy-requirements.txt

klippy-web:
	open web/index.html
	uv run klippy/klippy.py config/hotwire.cfg --web

klippy:
	uv run klippy/klippy.py config/hotwire.cfg

serial:
	uv run python -m serial.tools.miniterm --eol LF /tmp/printer
