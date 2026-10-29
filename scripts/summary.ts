/**
 * 定期実行の集計（指示書3）。log/YYYY-MM-DD.jsonl（ゲートウェイの決済ログ）から summary.json を作り直す。
 * - 累計件数、status 別件数、成功率（ok / 全決済）
 * - settle 時間（settle_ms）の中央値と最大（settle_ms が記録された行。新方式では verify 開始〜settle 完了で、上流の仕入れを含む）
 * - 累計 JPYC（受領：src/failures.ts の jpycReceived）、累計上流 USDC（upstream_cost_usd の合計＝上流に払った額）
 * - 失敗の型別件数（src/failures.ts：JPYC 未受領／上流が未払いで失敗／上流が支払い後に失敗／上流は支払い済み）
 * - CDP が負担したガス代の合計（settle tx の gasUsed × effectiveGasPrice、POL）。日ごとに保存し、件数が変わった日だけ読み直す
 * 使い方: RUN_START_JST=2026-10-25 [RUN_UNTIL_JST=...] npx tsx scripts/summary.ts
 */
import 'dotenv/config';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, formatEther, http } from 'viem';
import { parseLines } from '../src/logstore/types.ts';
import { countFailures, jpycReceived, type FailureType } from '../src/failures.ts';
import { NETWORK_SPECS, rpcUrlOf } from '../src/networks.ts';
import type { JpycNetwork } from '../src/jpyc.ts';

const LOG_DIR = process.env.LOG_DIR || 'log';
const OUT = process.env.SUMMARY_PATH || 'summary.json';
const since = process.env.RUN_START_JST || '0000-00-00';
const until = process.env.RUN_UNTIL_JST || '9999-99-99';
const clients = new Map<string, ReturnType<typeof createPublicClient>>();
const clientOf = (network: string) => {
  const spec = NETWORK_SPECS[network as JpycNetwork] ?? NETWORK_SPECS['eip155:137'];
  if (!clients.has(spec.network)) clients.set(spec.network, createPublicClient({ chain: spec.chain, transport: http(rpcUrlOf(spec.network)) }));
  return clients.get(spec.network)!;
};

type Day = { payments: number; ok: number; by_status: Record<string, number>; failures: Record<FailureType, number>; jpyc: number; upstream_usdc: number; gas_wei: string; gas_txs: number; gas_by_network?: Record<string, string> };
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
  const d: Day = { payments: rows.length, ok: 0, by_status: {}, failures: countFailures(rows), jpyc: 0, upstream_usdc: 0, gas_wei: '0', gas_txs: 0 };
  const txs: { tx: string; network: string }[] = [];
  for (const r of rows) {
    d.by_status[r.status] = (d.by_status[r.status] ?? 0) + 1;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const e = (byEndpoint[r.endpoint] ??= { payments: 0, ok: 0 });
    e.payments++;
    if (r.status === 'ok') {
      d.ok++;
      e.ok++;
    }
    d.upstream_usdc += Number(r.upstream_cost_usd ?? 0);
    if (jpycReceived(r)) d.jpyc += Number(r.price_jpyc);
    if (Number(r.settle_ms) > 0) settleMs.push(Number(r.settle_ms));
    if (/^0x[0-9a-fA-F]{64}$/.test(r.settle_tx ?? '')) txs.push({ tx: r.settle_tx, network: r.network || 'eip155:137' });
  }
  const cached = prevDays[day];
  if (cached && cached.gas_txs === txs.length && cached.gas_by_network) {
    d.gas_wei = cached.gas_wei;
    d.gas_txs = cached.gas_txs;
    d.gas_by_network = cached.gas_by_network;
  } else {
    const byNet: Record<string, bigint> = {};
    for (const { tx, network } of txs) {
      const rc = await clientOf(network).getTransactionReceipt({ hash: tx as `0x${string}` });
      byNet[network] = (byNet[network] ?? 0n) + rc.gasUsed * rc.effectiveGasPrice;
    }
    // gas_wei は CDP が負担した分（facilitator = cdp のチェーン）。チェーンごとの内訳は gas_by_network（自前ホストは relayer が負担）
    d.gas_wei = Object.entries(byNet).filter(([n]) => (NETWORK_SPECS[n as JpycNetwork]?.facilitator ?? 'cdp') === 'cdp').reduce((s2, [, v]) => s2 + v, 0n).toString();
    d.gas_by_network = Object.fromEntries(Object.entries(byNet).map(([n, v]) => [n, v.toString()]));
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
  failures: Object.values(days).reduce((acc, d) => {
    for (const [k, v] of Object.entries(d.failures)) acc[k] = (acc[k] ?? 0) + v;
    return acc;
  }, {} as Record<string, number>),
  settle_ms: { median: median(settleMs), max: settleMs.length ? Math.max(...settleMs) : null, samples: settleMs.length },
  jpyc_received: sum('jpyc'),
  upstream_usdc_spent: Math.round(sum('upstream_usdc') * 1e6) / 1e6,
  cdp_gas_pol: formatEther(gasWei),
  // チェーンごとのガス代（ネイティブ通貨の単位：POL / AVAX / KAIA）。Polygon は CDP、Avalanche・Kaia は自前の relayer が負担
  gas_by_network: Object.fromEntries(
    Object.entries(
      Object.values(days).reduce((acc, d) => {
        for (const [n, v] of Object.entries(d.gas_by_network ?? {})) acc[n] = (acc[n] ?? 0n) + BigInt(v);
        return acc;
      }, {} as Record<string, bigint>),
    ).map(([n, v]) => [n, formatEther(v)]),
  ),
  days,
};
writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n');
console.log(`[summary] days=${summary.days_run} payments=${payments} ok=${summary.ok} rate=${summary.success_rate} settle_ms median=${summary.settle_ms.median} max=${summary.settle_ms.max} jpyc=${summary.jpyc_received} usdc=${summary.upstream_usdc_spent} gas=${summary.cdp_gas_pol} POL`);
