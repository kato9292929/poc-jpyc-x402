/**
 * 決済ログ（指示書 §5）。1 決済 1 行の JSONL。日付の区切りは JST（poc-card-credits と同じ規則）。
 */

const JST_OFFSET_MS = 9 * 3_600_000;

/** JST（UTC+9、夏時間なし）の日付 YYYY-MM-DD。ログのファイル分割・買い手の日次上限はこの日付にそろえる。 */
export function jstDay(d = new Date()): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** JST の ISO 8601（例 2026-10-15T09:00:00.000+09:00） */
export function jstIso(d = new Date()): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().replace('Z', '+09:00');
}

export type PaymentStatus = 'ok' | 'verify_failed' | 'settle_failed' | 'upstream_failed';
export type FacilitatorKind = 'cdp' | 'self';

export interface PaymentLogEntry {
  /** ISO8601（JST） */
  ts: string;
  endpoint: string;
  /** 402 で提示した価格（JPYC、10進文字列を数値化したもの） */
  price_jpyc: number;
  /** 買い手アドレス（署名の from）。読めなければ 'unknown' */
  payer: string;
  pay_to: string;
  network: string;
  facilitator: FacilitatorKind;
  /** Polygon の tx hash。settle まで進まなかった・失敗した場合は 'none' */
  settle_tx: string;
  /** verify 開始から settle 完了までのミリ秒。verify まで進まなかった場合は 0 */
  settle_ms: number;
  upstream_cost_usd: number;
  /** Solana の tx hash（上流購入）。購入していなければ 'none'、払ったが PAYMENT-RESPONSE が読めなければ 'unknown' */
  upstream_tx: string;
  status: PaymentStatus;
  /** 失敗理由（任意） */
  error?: string;
}

const REQUIRED: (keyof PaymentLogEntry)[] = [
  'ts', 'endpoint', 'price_jpyc', 'payer', 'pay_to', 'network', 'facilitator',
  'settle_tx', 'settle_ms', 'upstream_cost_usd', 'upstream_tx', 'status',
];
const STATUSES: PaymentStatus[] = ['ok', 'verify_failed', 'settle_failed', 'upstream_failed'];

/** 必須項目がそろっているかを確かめて1行の JSON にする（キーの順は指示書の表の順）。欠けていれば例外。 */
export function toLogLine(e: PaymentLogEntry): string {
  for (const k of REQUIRED) {
    const v = e[k];
    if (v === undefined || v === null || v === '') throw new Error(`log entry missing required field ${k}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+09:00$/.test(e.ts)) throw new Error(`ts must be JST ISO 8601: ${e.ts}`);
  if (!STATUSES.includes(e.status)) throw new Error(`invalid status ${e.status}`);
  if (e.status === 'ok' && (e.settle_tx === 'none' || e.upstream_tx === 'none')) {
    throw new Error('status=ok requires settle_tx and upstream_tx (use "unknown" if the upstream tx could not be read)');
  }
  const ordered: Record<string, unknown> = {};
  for (const k of REQUIRED) ordered[k] = e[k];
  if (e.error) ordered.error = e.error.replace(/\s+/g, ' ').slice(0, 500);
  return JSON.stringify(ordered);
}

/** ts（JST ISO）からファイルの日付を取る。ts と同じ日付に書くため */
export function dayOfTs(ts: string): string {
  return ts.slice(0, 10);
}
