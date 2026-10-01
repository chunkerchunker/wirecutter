// Builds the deployable copy of web/ into the directory given as the first argument.
//
// The controller serves at most two SD-card files at once; a third concurrent request
// gets a 404, and a 404 on any ES module aborts the whole page. So each page is
// bundled into one script and one stylesheet, keeping every page load to html +
// css + js. web/ itself stays unbundled for `just serve`.

import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const web = resolve(import.meta.dirname, '../../web');
const out = process.argv[2];
if (!out) throw new Error('usage: node bundle.mjs <outdir>');

rmSync(out, { recursive: true, force: true });

// Pages and other static files; scripts and styles are bundled below
cpSync(web, out, {
  recursive: true,
  filter: (src) => !/[\\/](js|vendor|\.[^\\/]*)$/.test(src) && !src.endsWith('.css'),
});

await build({
  absWorkingDir: web,
  entryPoints: [
    { in: 'js/app.js', out: 'js/app' },
    { in: 'js/config.js', out: 'js/config' },
    // panel.js loads its worker from new URL('./worker.js', import.meta.url), which
    // esbuild leaves as is; inside the app.js bundle that resolves to js/worker.js
    { in: 'js/sim/worker.js', out: 'js/worker' },
    { in: 'css/app.css', out: 'css/app' },
    { in: 'css/config.css', out: 'css/config' },
  ],
  outdir: out,
  bundle: true,
  format: 'esm',
  minify: true,
  legalComments: 'eof',
  logLevel: 'warning',
});
