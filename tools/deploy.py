#!/usr/bin/env -S uv run --no-project --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["click"]
#
# [tool.uv]
# exclude-newer = "1 week"
# ///
"""Bundle web/ and upload it to the controller's SD card over WebDAV, gzipped, skipping unchanged files.

The upload is the bundled copy built by tools/build/bundle.mjs (one script and one stylesheet
per page), because the controller can't serve more than two files at once. Files deployed
earlier that are no longer part of the build are deleted. FluidNC serves foo.js.gz for foo.js. The controller has no RTC (every file reports the same
mtime), so change detection uses a manifest of source hashes stored on the card at
MANIFEST, plus a size check against a recursive PROPFIND to catch files changed or removed
behind the manifest's back.
"""

import gzip
import hashlib
import json
import re
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import click

MANIFEST = ".deploy-manifest"
TIMEOUT = 30
BUILD_DIR = Path(__file__).parent / "build"


def request(method, url, data=None, headers=None):
    # urllib defaults to application/x-www-form-urlencoded, which makes FluidNC drop PUT bodies.
    headers = {"Content-Type": "application/octet-stream", **(headers or {})}
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def local_files(root):
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if path.is_file() and not any(p.startswith((".", "_")) for p in rel.parts):
            yield rel.as_posix(), path


def remote_listing(base):
    """Map of path -> size for files, plus the set of directories, under base."""
    xml = request("PROPFIND", base + "/", headers={"Depth": "infinity"}).decode()
    prefix = urllib.parse.urlparse(base).path + "/"
    files, dirs = {}, set()
    for resp in re.findall(r"<d:response>(.*?)</d:response>", xml, re.S):
        href = urllib.parse.unquote(re.search(r"<d:href>(.*?)</d:href>", resp).group(1))
        rel = href.removeprefix(prefix).strip("/")
        if "<d:collection/>" in resp:
            dirs.add(rel)
        elif m := re.search(r"<d:getcontentlength>(\d+)<", resp):
            files[rel] = int(m.group(1))
    return files, dirs


def bundle(out):
    subprocess.run(["pnpm", "install", "--frozen-lockfile", "--silent"], cwd=BUILD_DIR, check=True)
    subprocess.run(["pnpm", "run", "--silent", "bundle", str(out)], cwd=BUILD_DIR, check=True)


def remote_manifest(base):
    try:
        return json.loads(request("GET", f"{base}/{MANIFEST}"))
    except (urllib.error.HTTPError, ValueError):
        return {}


@click.command()
@click.option("--host", default="hotwire.local")
@click.option("--dest", default="sd")
@click.option("--all", "upload_all", is_flag=True, help="Upload every file, ignoring the manifest.")
@click.option("-n", "--dry-run", is_flag=True, help="Show what would be uploaded or deleted.")
def main(host, dest, upload_all, dry_run):
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "web"
        bundle(src)
        deploy(f"http://{host}/{dest}", src, upload_all, dry_run)


def deploy(base, src, upload_all, dry_run):
    remote_files, remote_dirs = remote_listing(base)
    deployed = remote_manifest(base)
    old = {} if upload_all else deployed
    new = {}
    pending = []
    for rel, path in local_files(src):
        data = path.read_bytes()
        gz = gzip.compress(data, 9, mtime=0)
        entry = {"sha256": hashlib.sha256(data).hexdigest(), "size": len(gz)}
        new[rel] = entry
        if old.get(rel) != entry or remote_files.get(rel + ".gz") != entry["size"]:
            pending.append((rel, gz))

    # Only files this script deployed are removed; anything else on the card is left alone
    stale = [rel for rel in deployed if rel not in new and rel + ".gz" in remote_files]

    if not pending and not stale:
        click.echo("Up to date.")
        return
    uploaded = {k: v for k, v in old.items() if k in new}
    try:
        for rel in stale:
            click.echo(f"- {rel}")
            if not dry_run:
                request("DELETE", f"{base}/{rel}.gz")
        for rel, gz in pending:
            click.echo(f"+ {rel}")
            if dry_run:
                continue
            parts = rel.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                d = "/".join(parts[:i])
                if d not in remote_dirs:
                    request("MKCOL", f"{base}/{d}/")
                    remote_dirs.add(d)
            request("PUT", f"{base}/{rel}.gz", data=gz)
            uploaded[rel] = new[rel]
    finally:
        if not dry_run:
            request("PUT", f"{base}/{MANIFEST}", data=json.dumps(uploaded, indent=1).encode())
    would = "would be " if dry_run else ""
    click.echo(f"{len(pending)} of {len(new)} files {would}uploaded, {len(stale)} {would}deleted. {base}/index.html")


if __name__ == "__main__":
    main()
