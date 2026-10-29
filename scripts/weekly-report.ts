/**
 * 週次レポート（Markdown）。log/YYYY-MM-DD.jsonl（決済ログ）から、指定した期間（JST、両端を含む）を集計する。
 * 失敗は src/failures.ts の型で分ける。CDP 負担のガス代は summary.json の日別の値を使う（無い日は数えない）。
 *
 * 使い方:
 *   npx tsx scripts/weekly-report.ts                        # 今日（JST）までの 7 日間
 *   npx tsx scripts/weekly-report.ts --from 2026-10-25 --to 2026-10-31 [--out reports/weekly-2026-10-25.md]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatEther } from 'viem';
import { FAILURE_TYPES, classifyFailure, jpycReceived } from '../src/failures.ts';
import { explorerTxUrl, type JpycNetwork } from '../src/jpyc.ts';
import { jstDay } from '../src/log.ts';
import { parseLines } from '../src/logstore/types.ts';

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const to = arg('--to') ?? jstDay();
const from = arg('--from') ?? addDays(to, -6);
for (const d of [from, to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`invalid date ${d}`);

const LOG_DIR = process.env.LOG_DIR || 'log';
const summary = existsSync('summary.json') ? JSON.parse(readFileSync('summary.json', 'utf8')) : {};
const files = existsSync(LOG_DIR) ? readdirSync(LOG_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort() : [];

type Row = Record<string, any>;
const days: { day: string; rows: Row[] }[] = [];
for (const f of files) {
  const day = f.slice(0, 10);
  if (day < from || day > to) continue;
  days.push({ day, rows: parseLines(readFileSync(join(LOG_DIR, f), 'utf8')) });
}
const all = days.flatMap((d) => d.rows);
const ok = all.filter((r) => r.status === 'ok');
const settled = all.filter((r) => jpycReceived(r as any));
const settleMs = all.map((r) => Number(r.settle_ms)).filter((n) => n > 0).sort((a, b) => a - b);
const median = settleMs.length
  ? settleMs.length % 2
    ? settleMs[(settleMs.length - 1) / 2]
    : (settleMs[settleMs.length / 2 - 1] + settleMs[settleMs.length / 2]) / 2
  : null;
const sum = (rows: Row[], k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
const usd = (n: number) => (Math.round(n * 1e6) / 1e6).toFixed(2);
const sec = (ms: number | null) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)} 秒`);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '-');

let gasWei = 0n;
let gasDays = 0;
for (const d of days) {
  const g = summary.days?.[d.day]?.gas_wei;
  if (g !== undefined) {
    gasWei += BigInt(g);
    gasDays++;
  }
}

const lines: string[] = [];
lines.push(`# JPYC × x402 週次レポート（${from}〜${to}、JST）`, '');
lines.push('| 項目 | 値 |', '|---|---|');
lines.push(`| 実行日数 | ${days.length} 日 |`);
lines.push(`| 件数 | ${all.length} 件（成功 ${ok.length}・無料 ${all.filter((r) => r.status === 'free').length}・失敗 ${all.filter((r) => r.status !== 'ok' && r.status !== 'free').length}） |`);
lines.push(`| 成功率 | ${pct(ok.length, all.length)} |`);
lines.push(`| settle 時間 | 中央値 ${sec(median)}、最大 ${sec(settleMs.length ? settleMs[settleMs.length - 1] : null)} |`);
lines.push(`| 受領 JPYC | ${sum(settled, 'price_jpyc')} JPYC |`);
lines.push(`| 上流 USDC | ${usd(sum(all, 'upstream_cost_usd'))} USDC |`);
lines.push(`| CDP 負担ガス | ${gasDays ? `${Number(formatEther(gasWei)).toFixed(3)} POL` : '-'}${gasDays && gasDays < days.length ? `（${gasDays} 日分）` : ''} |`);
lines.push('');

lines.push('## 失敗の型', '');
lines.push('| 型 | 件数 | お金の動き |', '|---|---|---|');
for (const t of FAILURE_TYPES) {
  const n = all.filter((r) => classifyFailure(r as any) === t.type).length;
  lines.push(`| ${t.label} | ${n} | ${t.money} |`);
}
lines.push('');

lines.push('## 日別', '');
lines.push('| 日付 | 件数 | 成功 | 失敗 | 受領 JPYC | 上流 USDC |', '|---|---|---|---|---|---|');
for (const d of days) {
  const dok = d.rows.filter((r) => r.status === 'ok');
  const dset = d.rows.filter((r) => jpycReceived(r as any));
  lines.push(`| ${d.day} | ${d.rows.length} | ${dok.length} | ${d.rows.length - dok.length} | ${sum(dset, 'price_jpyc')} | ${usd(sum(d.rows, 'upstream_cost_usd'))} |`);
}
lines.push('');

const failed = all.filter((r) => r.status !== 'ok' && r.status !== 'free');
lines.push('## 失敗の明細', '');
if (!failed.length) {
  lines.push('この期間の失敗はありません。');
} else {
  lines.push('| 時刻（JST） | エンドポイント | 型 | 理由 | settle tx |', '|---|---|---|---|---|');
  for (const r of failed) {
    const t = FAILURE_TYPES.find((x) => x.type === classifyFailure(r as any))?.label ?? r.status;
    const tx = /^0x[0-9a-fA-F]{64}$/.test(r.settle_tx) ? `[${r.settle_tx.slice(0, 10)}…](${explorerTxUrl((r.network || 'eip155:137') as JpycNetwork, r.settle_tx)})` : '-';
    lines.push(`| ${String(r.ts).slice(0, 19).replace('T', ' ')} | ${r.endpoint} | ${t} | ${String(r.error ?? '').replace(/\|/g, '/').slice(0, 120)} | ${tx} |`);
  }
}
lines.push('');

const md = lines.join('\n');
const out = arg('--out');
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
  console.error(`[weekly] wrote ${out}`);
} else {
  process.stdout.write(md);
}
