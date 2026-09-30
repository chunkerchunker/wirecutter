host := "hotwire.local"
dest := "sd"

# Upload changed web/ files to the controller's SD card (gzipped; FluidNC's WebDAV serves foo.js.gz for foo.js).
# Flags: --all to re-upload everything, -n for a dry run.
deploy *flags:
	tools/deploy.py --host {{host}} --dest {{dest}} {{flags}}

# Serve web/ locally for development (ES modules don't load from file://)
serve port="8000":
	python3 -m http.server {{port}} --bind 127.0.0.1 -d web

# Rebuild web/vendor/three.js (tree-shaken three.js subset used by the simulator)
vendor:
	cd tools/three-bundle && pnpm install && pnpm build
