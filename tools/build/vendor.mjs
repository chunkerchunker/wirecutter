import { build } from 'esbuild';

await build({
  entryPoints: ['entry.js'],
  bundle: true,
  format: 'esm',
  minify: true,
  legalComments: 'eof',
  outfile: '../../web/vendor/three.js',
});
