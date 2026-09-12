import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const installed = path.join(root, 'node_modules/d3');
const metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
if (!metadata.version.startsWith('7.')) throw new Error('These demos require D3 major version 7');
const destination = path.join(root, 'public/revisitUtilities/vendor');
await mkdir(destination, { recursive: true });
await copyFile(path.join(installed, 'dist/d3.min.js'), path.join(destination, 'd3.min.js'));
await copyFile(path.join(installed, 'LICENSE'), path.join(destination, 'd3-LICENSE.txt'));
await writeFile(path.join(destination, 'README.md'), `# Local demo dependency\n\nD3 ${metadata.version}, copied from the locked installed dependency with its ISC license.\nRegenerate with \`node scripts/sync-demo-d3.mjs\` after an intentional D3 update.\nUsed by HTML demos so rendering does not require a CDN connection.\n`);
