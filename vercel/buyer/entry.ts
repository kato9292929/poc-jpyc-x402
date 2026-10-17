// Vercel Cron（買い手、Phase 2）。1 日 1 回 /api/cron が呼ばれ、series と movers を 1 回ずつ買う。
// 認証：Vercel Cron が付ける Authorization: Bearer $CRON_SECRET。手動実行（Phase 1）も同じヘッダで ?paths=/jin/series を付けて呼ぶ
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { buyerOptionsFromEnv, runBuyer } from '../../src/buyer.ts';
import { BlobRecordStore } from '../../src/buyer-store.ts';

function authorized(req: IncomingMessage): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return false;
  const want = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  return got.length === want.length && timingSafeEqual(got, want);
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, obj: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(obj));
  };
  if (!authorized(req)) return send(401, { error: 'unauthorized' });
  try {
    const token = process.env.BUYER_BLOB_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) throw new Error('missing BLOB_READ_WRITE_TOKEN');
    const opts = buyerOptionsFromEnv(process.env, new BlobRecordStore(token));
    const q = new URL(req.url ?? '/', 'http://x').searchParams.get('paths');
    if (q) opts.paths = q.split(',').map((s) => s.trim()).filter((p) => p === '/jin/series' || p === '/jin/movers');
    const lines: string[] = [];
    const r = await runBuyer({ ...opts, log: (m) => (console.log(m), lines.push(m)) });
    send(200, { ok: true, ...r });
  } catch (e) {
    console.error('[buyer] failed', e);
    send(500, { ok: false, error: (e as Error).message });
  }
}
