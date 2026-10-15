/**
 * 決済ログの集計：日付ごと・status ごとの件数と JPYC 受領額。upstream_failed は手動返金の対象として一覧を出す。
 * 使い方: npm run logs:summary [-- YYYY-MM-DD ...]（LOG_SINK=file なら LOG_DIR、blob なら BLOB_READ_WRITE_TOKEN から読む）
 */
import 'dotenv/config';
import { FileLogStore } from '../src/logstore/file.ts';
import { VercelBlobLogStore } from '../src/logstore/blob.ts';
import { parseLines, type LogStore } from '../src/logstore/types.ts';

const sink = process.env.LOG_SINK || 'blob';
const store: LogStore =
  sink === 'file' ? new FileLogStore(process.env.LOG_DIR || 'log') : new VercelBlobLogStore({ token: process.env.BLOB_READ_WRITE_TOKEN || '' });
const days = process.argv.slice(2).length ? process.argv.slice(2) : await store.days();

const refunds: any[] = [];
for (const day of days) {
  const rows = parseLines(await store.read(day));
  const by: Record<string, number> = {};
  let received = 0;
  let upstreamUsd = 0;
  for (const r of rows) {
    by[r.status] = (by[r.status] ?? 0) + 1;
    if (r.status === 'ok' || r.status === 'upstream_failed') received += Number(r.price_jpyc);
    if (r.status === 'ok') upstreamUsd += Number(r.upstream_cost_usd);
    if (r.status === 'upstream_failed') refunds.push(r);
  }
  console.log(`${day} total=${rows.length} ${Object.entries(by).map(([k, v]) => `${k}=${v}`).join(' ')} received_jpyc=${received} upstream_cost_usd=${upstreamUsd.toFixed(2)}`);
}
if (refunds.length) {
  console.log(`\nupstream_failed（手動返金の対象）: ${refunds.length} 件`);
  for (const r of refunds) console.log(`  ${r.ts} ${r.endpoint} ${r.price_jpyc} JPYC payer=${r.payer} settle_tx=${r.settle_tx}`);
}
