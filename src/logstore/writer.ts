import { dayOfTs, toLogLine, type PaymentLogEntry } from '../log.ts';
import type { LogStore } from './types.ts';

/**
 * 決済ログを保存先に書く。書き込みの成否はリクエストの処理に影響させない：待たずに書き、
 * 失敗は書けなかった行ごと標準エラーに残す（ホスティングのログから回収できる）。終了時は flush() で待つ。
 */
export class PaymentLogWriter {
  private pending = new Set<Promise<void>>();
  failures = 0;
  /** 直近の書き込み失敗の理由（/healthz に出す。行の中身は含めない） */
  lastError?: string;

  constructor(
    private readonly store: LogStore,
    private readonly onError: (e: unknown, line: string) => void = (e, line) =>
      console.error(`[log] append failed: ${(e as Error)?.message ?? e}\n[log-line] ${line}`),
  ) {}

  write(entry: PaymentLogEntry): void {
    let line: string;
    try {
      line = toLogLine(entry);
    } catch (e) {
      this.failures++;
      this.onError(e, JSON.stringify(entry));
      return;
    }
    const p = this.store
      .append(dayOfTs(entry.ts), line)
      .catch((e) => {
        this.failures++;
        this.lastError = String((e as Error)?.message ?? e).slice(0, 200);
        this.onError(e, line);
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}
