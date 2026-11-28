// Vercel にデプロイするディレクトリを作る：.vercel-stage/<app>/（esbuild で 1 ファイルに束ねた関数 + vercel.json）
// 使い方: node scripts/vercel-stage.mjs gateway
// その後: cd .vercel-stage/<app> && vercel deploy --prod（プロジェクトは vercel link で紐づける）
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const APPS = { gateway: 'api/index.js' };
const app = process.argv[2];
if (!APPS[app]) throw new Error(`usage: node scripts/vercel-stage.mjs ${Object.keys(APPS).join('|')}`);
const out = join('.vercel-stage', app);
// vercel link の結果（.vercel/）は残す
for (const f of ['api', 'vercel.json', 'package.json', 'index.html']) rmSync(join(out, f), { recursive: true, force: true });
mkdirSync(join(out, 'api'), { recursive: true });
await build({
  entryPoints: [join('vercel', app, 'entry.ts')],
  outfile: join(out, APPS[app]),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
cpSync(join('vercel', app, 'vercel.json'), join(out, 'vercel.json'));
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: `poc-jpyc-x402-${app}`, private: true, type: 'module', engines: { node: '22.x' } }, null, 2));
console.log(`staged ${out}${existsSync(join(out, '.vercel')) ? ' (linked)' : ''}`);
