import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'public/revisitUtilities/vendor');
const core = path.join(root, 'node_modules/@trrack/core');
const metadata = JSON.parse(await readFile(path.join(core, 'package.json'), 'utf8'));
if (metadata.version !== '1.3.0') throw new Error('Review the demo bundle before changing Trrack 1.3.0');
const result = await build({
  configFile: false, root, publicDir: false,
  build: { write: false, copyPublicDir: false, target: 'es2020', minify: true, lib: { entry: path.join(core, 'index.mjs'), formats: ['es'], fileName: 'trrack-core' } },
  define: { 'process.env.NODE_ENV': '"production"' },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap((bundle) => bundle.output);
if (outputs.length !== 1 || outputs[0].type !== 'chunk' || outputs[0].imports.length || outputs[0].dynamicImports.length) throw new Error('Demo bundle must be one self-contained module');
const bundle = outputs[0];
// Collect attribution from the actual bundled package roots. Trrack's published
// entry already embeds uuid and fast-json-patch, so include those licenses too.
const roots = new Set([core, path.join(core, 'node_modules/uuid'), path.join(root, 'node_modules/fast-json-patch')]);
for (const input of Object.keys(bundle.modules).filter((name) => !name.startsWith('\0'))) {
  let directory = path.dirname(path.resolve(root, input));
  while (directory !== root && directory !== path.dirname(directory)) {
    try {
      const candidate = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (candidate.name) { roots.add(directory); break; }
    } catch { /* Subdirectories may not contain package metadata. */ }
    directory = path.dirname(directory);
  }
}
const notices = [];
for (const directory of [...roots].sort()) {
  const dependency = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const licenseName = (await readdir(directory)).find((name) => /^licen[cs]e(?:\..*)?$/i.test(name));
  const license = directory === core
    ? await readFile(path.join(destination, 'trrack-LICENSE.txt'), 'utf8')
    : licenseName ? await readFile(path.join(directory, licenseName), 'utf8') : null;
  if (!license) throw new Error(`Missing license for ${dependency.name}`);
  notices.push(`${dependency.name} ${dependency.version}\n${license}`);
}
await writeFile(path.join(destination, 'trrack-core.js'), bundle.code);
await writeFile(path.join(destination, 'trrack-NOTICES.txt'), notices.join('\n\n----------\n\n'));
await writeFile(path.join(destination, 'trrack-README.md'), `# Local Trrack demo bundle\n\nTrrack ${metadata.version}, bundled from the existing lockfile installation for browser ESM use.\nRegenerate with \`node scripts/sync-demo-trrack.mjs\` after installing locked dependencies.\nNo remote imports or runtime package downloads. See trrack-NOTICES.txt for bundled dependency versions and licenses.\nThe Trrack package omits its license file; trrack-LICENSE.txt preserves the publisher license from https://github.com/Trrack/trrackjs/blob/main/LICENSE (read September 9, 2026).\n`);
