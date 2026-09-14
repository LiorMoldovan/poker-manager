// Bundles tts.ts for Node so the Hebrew text-normalization pipeline can be
// asserted directly. Same stub-swap trick as build.mjs — the browser-only
// modules tts.ts imports are replaced, everything else is the real source.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const SWAP = [
  [/database[\\/]storage$/, 'stubs/storage.ts'],
  [/^\.\/apiProxy$|^\.\/aiEligibility$/, 'stubs/ttsDeps.ts'],
];

const swapPlugin = {
  name: 'swap',
  setup(b) {
    b.onResolve({ filter: /.*/ }, args => {
      if (args.kind === 'entry-point') return null;
      for (const [re, target] of SWAP) {
        if (re.test(args.path)) return { path: join(here, target) };
      }
      return null;
    });
  },
};

await build({
  entryPoints: [resolve(here, '..', '..', 'src', 'utils', 'tts.ts')],
  outfile: resolve(here, 'out', 'tts.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  plugins: [swapPlugin],
  define: { 'import.meta.env': '{}', 'navigator.onLine': 'true' },
});
console.log('bundled → scripts/promptlab/out/tts.mjs');
