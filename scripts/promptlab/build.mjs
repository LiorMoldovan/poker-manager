// Bundles the lab entry for Node, swapping the browser-only modules that
// geminiAI.ts imports for the local stubs. Everything else — the prompt
// builders, milestones engine, combo history — is the real source.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const SWAP = [
  [/database[\\/]storage$/, 'stubs/storage.ts'],
  [/utils[\\/]apiProxy$|^\.\/apiProxy$/, 'stubs/apiProxy.ts'],
  [/^\.\/aiUsageTracker$|^\.\/aiEligibility$|^\.\/localApiKey$|^\.\/chipCountDebug$|trainingData$/, 'stubs/misc.ts'],
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
  entryPoints: [resolve(here, 'entry.ts')],
  outfile: resolve(here, 'out', 'lab.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'info',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  plugins: [swapPlugin],
  // callWithFallback (the summary path) gates on navigator.onLine, which
  // Node exposes as a read-only global without that property.
  define: { 'import.meta.env': '{}', 'navigator.onLine': 'true' },
});
console.log('bundled → scripts/promptlab/out/lab.mjs');
