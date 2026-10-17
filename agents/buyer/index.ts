/**
 * 買い手エージェントのローカル実行（npm run buyer）。処理の中身は src/buyer.ts。
 * 記録は BUYER_LOG_DIR（既定 log/buyer）の YYYY-MM-DD.jsonl（JST）。
 * BUYER_RECORD_SINK=blob と BUYER_BLOB_READ_WRITE_TOKEN を入れると、Vercel Cron（vercel/buyer）と同じ Blob の記録を使う
 * （日次上限・1日1回をローカル実行と定期実行で共有するため）。
 */
import 'dotenv/config';
import { join } from 'node:path';
import { buyerOptionsFromEnv, runBuyer } from '../../src/buyer.ts';
import { BlobRecordStore, FileRecordStore } from '../../src/buyer-store.ts';

const env = process.env;
const store =
  env.BUYER_RECORD_SINK === 'blob'
    ? new BlobRecordStore(env.BUYER_BLOB_READ_WRITE_TOKEN || (() => { throw new Error('missing BUYER_BLOB_READ_WRITE_TOKEN'); })())
    : new FileRecordStore(env.BUYER_LOG_DIR || join(env.LOG_DIR || 'log', 'buyer'));
const r = await runBuyer(buyerOptionsFromEnv(env, store));
for (const [p, b] of Object.entries(r.bodies)) console.log(`[buyer] ${p} -> ${b}${b.length >= 300 ? '…' : ''}`);
