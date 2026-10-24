/**
 * 定期実行の集計（指示書3）。log/YYYY-MM-DD.jsonl（ゲートウェイの決済ログ）から summary.json を作り直す。
 * - 累計件数、status 別件数、成功率（ok / 全決済）
 * - settle 時間（settle_ms）の中央値と最大（settle まで進んだもの = ok / upstream_failed）
 * - 累計 JPYC（受領 = ok + upstream_failed）、累計上流 USDC（ok の upstream_cost_usd）
 * - CDP が負担したガス代の合計（settle tx の gasUsed × effectiveGasPrice、POL）。日ごとに保存し、件数が変わった日だけ読み直す
 * 使い方: RUN_START_JST=2026-10-25 [RUN_UNTIL_JST=...] npx tsx scripts/summary.ts
 */
import 'dotenv/config';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, formatEther, http } from 'viem';
import { polygon } from 'viem/chains';
import { parseLines } from '../src/logstore/types.ts';

const LOG_DIR = process.env.LOG_DIR || 'log';
const OUT = process.env.SUMMARY_PATH || 'summary.json';
const since = process.env.RUN_START_JST || '0000-00-00';
const until = process.env.RUN_UNTIL_JST || '9999-99-99';
const pc = createPublicClient({ chain: polygon, transport: http(process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com') });

type Day = { payments: number; ok: number; by_status: Record<string, number>; jpyc: number; upstream_usdc: number; gas_wei: string; gas_txs: number };
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const prevDays: Record<string, Day> = prev.days ?? {};

const files = existsSync(LOG_DIR) ? readdirSync(LOG_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort() : [];
const days: Record<string, Day> = {};
const settleMs: number[] = [];
const byStatus: Record<string, number> = {};
const byEndpoint: Record<string, { payments: number; ok: number }> = {};

for (const f of files) {
  const day = f.slice(0, 10);
  if (day < since || day > until) continue;
  const rows = parseLines(readFileSync(join(LOG_DIR, f), 'utf8'));
  const d: Day = { payments: rows.length, ok: 0, by_status: {}, jpyc: 0, upstream_usdc: 0, gas_wei: '0', gas_txs: 0 };
  const txs: string[] = [];
  for (const r of rows) {
    d.by_status[r.status] = (d.by_status[r.status] ?? 0) + 1;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const e = (byEndpoint[r.endpoint] ??= { payments: 0, ok: 0 });
    e.payments++;
    if (r.status === 'ok') {
      d.ok++;
      e.ok++;
      d.upstream_usdc += Number(r.upstream_cost_usd);
    }
    if (r.status === 'ok' || r.status === 'upstream_failed') {
      d.jpyc += Number(r.price_jpyc);
      settleMs.push(Number(r.settle_ms));
      if (/^0x[0-9a-fA-F]{64}$/.test(r.settle_tx)) txs.push(r.settle_tx);
    }
  }
  const cached = prevDays[day];
  if (cached && cached.gas_txs === txs.length) {
    d.gas_wei = cached.gas_wei;
    d.gas_txs = cached.gas_txs;
  } else {
    let wei = 0n;
    for (const tx of txs) {
      const rc = await pc.getTransactionReceipt({ hash: tx as `0x${string}` });
      wei += rc.gasUsed * rc.effectiveGasPrice;
    }
    d.gas_wei = wei.toString();
    d.gas_txs = txs.length;
  }
  d.upstream_usdc = Math.round(d.upstream_usdc * 1e6) / 1e6;
  days[day] = d;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sum = (k: 'payments' | 'ok' | 'jpyc' | 'upstream_usdc') => Object.values(days).reduce((s, d) => s + d[k], 0);
const gasWei = Object.values(days).reduce((s, d) => s + BigInt(d.gas_wei), 0n);
const payments = sum('payments');

const summary = {
  updated_at: new Date().toISOString(),
  period: { start_jst: process.env.RUN_START_JST ?? null, until_jst: process.env.RUN_UNTIL_JST ?? null },
  facilitator: 'cdp',
  network: 'eip155:137',
  days_run: Object.keys(days).length,
  payments,
  ok: sum('ok'),
  success_rate: payments ? Math.round((sum('ok') / payments) * 10000) / 10000 : null,
  by_status: byStatus,
  by_endpoint: byEndpoint,
  settle_ms: { median: median(settleMs), max: settleMs.length ? Math.max(...settleMs) : null, samples: settleMs.length },
  jpyc_received: sum('jpyc'),
  upstream_usdc_spent: Math.round(sum('upstream_usdc') * 1e6) / 1e6,
  cdp_gas_pol: formatEther(gasWei),
  days,
};
writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n');
console.log(`[summary] days=${summary.days_run} payments=${payments} ok=${summary.ok} rate=${summary.success_rate} settle_ms median=${summary.settle_ms.median} max=${summary.settle_ms.max} jpyc=${summary.jpyc_received} usdc=${summary.upstream_usdc_spent} gas=${summary.cdp_gas_pol} POL`);
