host := "hotwire.local"
dest := "sd"

# Upload web/ to the controller's SD card (gzipped; FluidNC's WebDAV serves foo.js.gz for foo.js)
deploy:
	#!/usr/bin/env bash
	set -euo pipefail
	base="http://{{host}}/{{dest}}"
	tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
	cd web
	# Create directories (MKCOL fails harmlessly if they already exist)
	curl -sS -o /dev/null -X MKCOL "$base/" || true
	find . -mindepth 1 -type d ! -name '.*' | sed 's|^\./||' | sort | while read -r dir; do
		curl -sS -o /dev/null -X MKCOL "$base/$dir/" || true
	done
	find . -type f ! -name '.*' ! -name '_*' | sed 's|^\./||' | sort | while read -r file; do
		mkdir -p "$tmp/$(dirname "$file")"
		gzip -9 -c "$file" > "$tmp/$file.gz"
		echo "  $file"
		curl -fsS -o /dev/null -T "$tmp/$file.gz" "$base/$file.gz"
	done
	echo "$base/index.html"

# Serve web/ locally for development (ES modules don't load from file://)
serve port="8000":
	python3 -m http.server {{port}} --bind 127.0.0.1 -d web

# Rebuild web/vendor/three.js (tree-shaken three.js subset used by the simulator)
vendor:
	cd tools/three-bundle && pnpm install && pnpm build
