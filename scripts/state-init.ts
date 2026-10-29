/**
 * 共有状態の台帳（nonce 16 個・上流の支出 1 個）を Vercel Blob に作る。デプロイ前に 1 回実行する。
 *   DOTENV_CONFIG_PATH=<vercel env pull の出力> npx tsx scripts/state-init.ts
 */
import 'dotenv/config';
import { BlobSharedStore } from '../src/stores.ts';

// BLOB_READ_WRITE_TOKEN、または VERCEL_OIDC_TOKEN + BLOB_STORE_ID（vercel env pull で取れる）
const token = process.env.BLOB_READ_WRITE_TOKEN || undefined;
if (!token && !(process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID)) throw new Error('BLOB_READ_WRITE_TOKEN or VERCEL_OIDC_TOKEN + BLOB_STORE_ID is required');
const n = await new BlobSharedStore(token).init();
console.log(`[state:init] created ${n} ledger(s), ${BlobSharedStore.ledgerPaths().length} expected`);
