/**
 * 決済ログの失敗を「お金がどこまで動いたか」で分類する（週次レポート・summary.json 用）。
 *
 * 2026-10-30 から処理の順番が verify → 上流を仕入れ → settle に変わった（ログの flow = 'settle_last'）。
 * それより前の行（flow なし）は settle → 上流の順で、上流で落ちても JPYC は受領済みだった。
 *
 *   jpyc_not_received             verify（事前検査を含む）の失敗。JPYC も上流も動かない
 *   upstream_before_payment       上流に支払いを送る前に失敗（到達不可・5xx・価格不一致・日次上限）。上流の USDC は動かない
 *   upstream_after_payment        支払いを送った後に上流が失敗（402 を返し直した、送信が途中で切れた等）。上流の tx なし
 *   upstream_paid_no_data         上流の USDC は支払い済みなのにデータを受け取れなかった。回収できない原価
 *   settle_failed_after_upstream  上流は仕入れ済み、JPYC の settle が失敗（flow=settle_last のみ）。回収できない原価
 *
 * JPYC を受け取ったかは jpycReceived で見る（新方式では成功時だけ、旧方式では上流で落ちた行も受領済み）。
 */
export type FailureType =
  | 'jpyc_not_received'
  | 'upstream_before_payment'
  | 'upstream_after_payment'
  | 'upstream_paid_no_data'
  | 'settle_failed_after_upstream';

export const FAILURE_TYPES: { type: FailureType; label: string; money: string }[] = [
  { type: 'jpyc_not_received', label: 'JPYC の verify が失敗', money: 'JPYC 受領なし・上流 USDC 動かない' },
  { type: 'upstream_before_payment', label: '上流が未払いの段階で失敗', money: '上流 USDC 動かない' },
  { type: 'upstream_after_payment', label: '上流が支払い受領後に失敗（402 など）', money: '上流 USDC 動かない（上流の tx なし）' },
  { type: 'upstream_paid_no_data', label: '上流は支払い済み、データを受け取れず', money: '上流 USDC 支払い済み（回収できない原価）' },
  { type: 'settle_failed_after_upstream', label: '上流は仕入れ済み、JPYC の settle が失敗', money: '上流 USDC 支払い済み・JPYC 受領なし（回収できない原価）' },
];

export interface LogRow {
  status: string;
  error?: string;
  upstream_tx?: string;
  settle_tx?: string;
  flow?: string;
}

const settleLast = (r: LogRow) => r.flow === 'settle_last';

export function classifyFailure(r: LogRow): FailureType | undefined {
  if (r.status === 'ok' || r.status === 'free') return undefined;
  if (r.status === 'verify_failed') return 'jpyc_not_received';
  if (r.status === 'settle_failed') return settleLast(r) ? 'settle_failed_after_upstream' : 'jpyc_not_received';
  if (r.status !== 'upstream_failed') return undefined;
  if (r.upstream_tx && r.upstream_tx !== 'none') return 'upstream_paid_no_data';
  const e = r.error ?? '';
  if (/after payment|after sending/.test(e)) return 'upstream_after_payment';
  return 'upstream_before_payment';
}

/** この行で買い手から JPYC を受け取ったか */
export function jpycReceived(r: LogRow): boolean {
  if (r.status === 'ok') return true;
  // 旧方式（settle → 上流）では、上流で落ちた行も JPYC は受領済み
  return !settleLast(r) && r.status === 'upstream_failed';
}

export function countFailures(rows: LogRow[]): Record<FailureType, number> {
  const out = Object.fromEntries(FAILURE_TYPES.map((t) => [t.type, 0])) as Record<FailureType, number>;
  for (const r of rows) {
    const t = classifyFailure(r);
    if (t) out[t]++;
  }
  return out;
}
