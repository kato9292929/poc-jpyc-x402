/**
 * 実際の Vercel Blob で、同じ nonce を同時に N 回 claim して 1 回しか通らないかを確かめる（使い捨ての prefix を使う）。
 * あわせて、参考として「allowOverwrite: false の同時作成」が何回成功するかも数える。
 *   BLOB_READ_WRITE_TOKEN=... npx tsx scripts/blob-race-check.ts [N] [rounds]
 */
import 'dotenv/config';
import { del, list } from '@vercel/blob';
import { BlobSharedStore, VercelBlobBackend, WriteConflict } from '../src/stores.ts';

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required');
const N = Number(process.argv[2] ?? 20);
const rounds = Number(process.argv[3] ?? 3);
const prefix = `race-check-${Date.now()}`;
const backend = new VercelBlobBackend(token);
const store = new BlobSharedStore(backend, prefix);
await store.init();

let ok = true;
for (let r = 0; r < rounds; r++) {
  const key = `eip155:137:0xrace:${r}`;
  const res = await Promise.all(Array.from({ length: N }, () => store.claimNonce(key, Date.now() + 600_000).catch((e) => e as Error)));
  const wins = res.filter((x) => x === true).length;
  const errors = res.filter((x) => x instanceof Error).length;
  console.log(`claimNonce round ${r}: ${wins} win / ${N}${errors ? `, ${errors} error` : ''}`);
  if (wins !== 1) ok = false;

  const created = await Promise.all(
    Array.from({ length: N }, (_, i) => backend.put(`${prefix}/raw-create-${r}`, String(i), { create: true }).then(() => true, (e) => (e instanceof WriteConflict ? false : e))),
  );
  console.log(`  (参考) allowOverwrite:false の同時作成: ${created.filter((x) => x === true).length} 成功 / ${N}`);
}

const { blobs } = await list({ prefix: `${prefix}/`, token });
if (blobs.length) await del(blobs.map((b) => b.url), { token });
console.log(ok ? 'RESULT: ok（同じ nonce は 1 回だけ通った）' : 'RESULT: NG');
process.exit(ok ? 0 : 1);
