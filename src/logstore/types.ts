/**
 * 決済ログの保存先。log/YYYY-MM-DD.jsonl（JST の日付）に1行ずつ追記する。
 * 本番は poc-card-credits と同じ Vercel Blob（blob.ts）。ローカルファイル（file.ts）は開発時だけ。
 */
export interface LogStore {
  /** 1行（改行なしの JSON）を追記する。 */
  append(day: string, line: string): Promise<void>;
  /** その日のファイルの中身。無ければ null。 */
  read(day: string): Promise<string | null>;
  /** ログがある日付の一覧（昇順） */
  days(): Promise<string[]>;
}

export const logPath = (day: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`invalid log day ${day}`);
  return `log/${day}.jsonl`;
};

export function parseLines(text: string | null): any[] {
  if (!text) return [];
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
