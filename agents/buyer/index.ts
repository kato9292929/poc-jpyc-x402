/**
 * 買い手エージェントの実行（npm run buyer）。処理の中身は src/buyer.ts。
 * 記録は BUYER_LOG_DIR（既定 log/buyer）の YYYY-MM-DD.jsonl（JST）。日次上限・失敗件数はこの記録から判定する。
 * BUYER_UPSTREAM_SOLANA_ADDRESS があれば、始める前に JPYC と上流 USDC の残高を確かめる（足りなければ支払わない）。
 */
import 'dotenv/config';
import { join } from 'node:path';
import { buyerOptionsFromEnv, runBuyer } from '../../src/buyer.ts';
import { FileRecordStore } from '../../src/buyer-store.ts';
import { makeCheckFunds } from '../../src/funds.ts';
import { loadRoutes } from '../../src/routes.ts';

const env = process.env;
const store = new FileRecordStore(env.BUYER_LOG_DIR || join(env.LOG_DIR || 'log', 'buyer'));
const opts = buyerOptionsFromEnv(env, store);
if (env.BUYER_UPSTREAM_SOLANA_ADDRESS) {
  opts.checkFunds = makeCheckFunds({
    polygonRpcUrl: env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',
    solanaRpcUrl: env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    upstreamSolanaAddress: env.BUYER_UPSTREAM_SOLANA_ADDRESS,
  });
  opts.costs = Object.fromEntries(loadRoutes(env).map((r) => [r.path, { priceJpyc: r.priceJpyc, upstreamCostUsd: r.upstreamCostUsd }]));
}
const r = await runBuyer(opts);
const ok = r.records.filter((x) => x.status === 'ok').length;
console.log(`[buyer] summary: ok=${ok} records=${r.records.length} spent=${r.spentAfterJpyc} JPYC${r.stopReason ? ` stop=${r.stopReason}` : ''}`);
