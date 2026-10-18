/**
 * 買い手エージェントのローカル実行（npm run buyer）。処理の中身は src/buyer.ts。
 * 記録は BUYER_LOG_DIR（既定 log/buyer）の YYYY-MM-DD.jsonl（JST）。日次上限・1日1回はこの記録から判定する。
 */
import 'dotenv/config';
import { join } from 'node:path';
import { buyerOptionsFromEnv, runBuyer } from '../../src/buyer.ts';
import { FileRecordStore } from '../../src/buyer-store.ts';

const env = process.env;
const store = new FileRecordStore(env.BUYER_LOG_DIR || join(env.LOG_DIR || 'log', 'buyer'));
const r = await runBuyer(buyerOptionsFromEnv(env, store));
for (const [p, b] of Object.entries(r.bodies)) console.log(`[buyer] ${p} -> ${b}${b.length >= 300 ? '…' : ''}`);
