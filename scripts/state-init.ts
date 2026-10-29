/**
 * 共有状態の台帳（nonce 16 個・上流の支出 1 個）を Vercel Blob に作る。デプロイ前に 1 回実行する。
 *   BLOB_READ_WRITE_TOKEN=... npx tsx scripts/state-init.ts
 */
import 'dotenv/config';
import { BlobSharedStore } from '../src/stores.ts';

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required');
const n = await new BlobSharedStore(token).init();
console.log(`[state:init] created ${n} ledger(s), ${BlobSharedStore.ledgerPaths().length} expected`);
