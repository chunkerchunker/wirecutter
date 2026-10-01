host := "hotwire.local"
dest := "sd"

# Upload changed web/ files to the controller's SD card (gzipped; FluidNC's WebDAV serves foo.js.gz for foo.js).
# Flags: --all to re-upload everything, -n for a dry run.
deploy *flags:
	tools/deploy.py --host {{host}} --dest {{dest}} {{flags}}

# Print the UI defaults saved on the controller (written by config.html)
settings-get:
	curl -fsS http://{{host}}/{{dest}}/settings.json

# Upload a UI defaults file to the controller (octet-stream: FluidNC drops form-encoded PUT bodies)
settings-put file="settings.json":
	curl -fsS -T {{file}} -H "Content-Type: application/octet-stream" http://{{host}}/{{dest}}/settings.json

# Serve web/ locally for development (ES modules don't load from file://)
serve port="8000":
	python3 -m http.server {{port}} --bind 127.0.0.1 -d web

# Rebuild web/vendor/three.js (tree-shaken three.js subset used by the simulator)
vendor:
	cd tools/build && pnpm install && pnpm vendor
