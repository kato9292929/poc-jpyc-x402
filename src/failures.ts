/**
 * 決済ログの失敗を「お金がどこまで動いたか」で分類する（週次レポート・summary.json 用）。
 * JPYC の実証は JPYC の settle を先に行い、そのあと上流（JIN）を買うので、型は次の 4 つになる。
 *
 *   jpyc_not_received        verify / settle の失敗。JPYC を受け取っておらず、上流にも払っていない
 *   upstream_before_payment  上流に支払いを送る前に失敗（到達不可・5xx・価格不一致など）。上流の USDC は動かない
 *   upstream_after_payment   支払いを送った後に上流が失敗（402 を返し直した、送信が途中で切れた等）。
 *                            upstream_tx が無ければ上流の USDC は動いていない（送信途中で切れたものはチェーンで要確認）
 *   upstream_paid_no_data    上流の USDC は支払い済み（upstream_tx あり）なのにデータを渡せなかった。回収できない原価
 *
 * 後ろの 3 つは JPYC を受領済み（買い手にデータを渡していない＝手動返金の対象）。
 */
export type FailureType = 'jpyc_not_received' | 'upstream_before_payment' | 'upstream_after_payment' | 'upstream_paid_no_data';

export const FAILURE_TYPES: { type: FailureType; label: string; money: string }[] = [
  { type: 'jpyc_not_received', label: 'JPYC の verify / settle が失敗', money: 'JPYC 受領なし・上流 USDC 動かない' },
  { type: 'upstream_before_payment', label: '上流が未払いの段階で失敗', money: 'JPYC 受領済み・上流 USDC 動かない' },
  { type: 'upstream_after_payment', label: '上流が支払い受領後に失敗（402 など）', money: 'JPYC 受領済み・上流 USDC 動かない（tx なし）' },
  { type: 'upstream_paid_no_data', label: '上流は支払い済み、データを渡せず', money: 'JPYC 受領済み・上流 USDC 支払い済み（回収できない原価）' },
];

export interface LogRow {
  status: string;
  error?: string;
  upstream_tx?: string;
}

export function classifyFailure(r: LogRow): FailureType | undefined {
  if (r.status === 'ok') return undefined;
  if (r.status === 'verify_failed' || r.status === 'settle_failed') return 'jpyc_not_received';
  if (r.status !== 'upstream_failed') return undefined;
  if (r.upstream_tx && r.upstream_tx !== 'none') return 'upstream_paid_no_data';
  const e = r.error ?? '';
  if (/after payment|after sending/.test(e)) return 'upstream_after_payment';
  return 'upstream_before_payment';
}

export function countFailures(rows: LogRow[]): Record<FailureType, number> {
  const out = Object.fromEntries(FAILURE_TYPES.map((t) => [t.type, 0])) as Record<FailureType, number>;
  for (const r of rows) {
    const t = classifyFailure(r);
    if (t) out[t]++;
  }
  return out;
}
