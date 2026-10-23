import { get, list, put, BlobPreconditionFailedError } from '@vercel/blob';
import { logPath, type LogStore } from './types.ts';

/**
 * Vercel Blob（@vercel/blob 2.8.1）にログを置く。パスは log/YYYY-MM-DD.jsonl（JST の日付）。
 * poc-card-credits の src/logstore/blob.ts と同じ方式（本番の出力先をそろえるため）。
 *
 * - Blob は private（読むには認証が要る）。書き込みには BLOB_READ_WRITE_TOKEN を使い、ゲートウェイだけが持つ
 * - **追記のみ。** 既存の行を書き換える・消す処理は無い（del() は呼ばない）。
 *   ただし Blob には追記の API が無いので、物理的には「読む → 末尾に1行足す → ETag が一致するときだけ書き戻す（ifMatch）」で
 *   オブジェクトを置き換える。書き戻す内容は必ず「読んだ内容そのまま＋新しい行」で、既存部分が変わらないことを
 *   書き込み前に確かめる。別のプロセスと競合したら（BlobPreconditionFailedError）読み直してやり直すので、
 *   複数台で動かしても行は失われない
 * - 同じプロセス内の追記は1本のキューで順に処理する（競合を減らすため）
 */
export interface BlobApi {
  get: typeof get;
  put: typeof put;
  list: typeof list;
}

export class VercelBlobLogStore implements LogStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: { token: string; maxRetries?: number; api?: BlobApi }) {}

  private get api(): BlobApi {
    return this.opts.api ?? { get, put, list };
  }

  private async load(day: string): Promise<{ text: string; etag?: string } | null> {
    const r = await this.api.get(logPath(day), { access: 'private', useCache: false, token: this.opts.token });
    if (!r || r.statusCode !== 200) return null;
    return { text: await new Response(r.stream).text(), etag: r.blob.etag };
  }

  async read(day: string): Promise<string | null> {
    return (await this.load(day))?.text ?? null;
  }

  append(day: string, line: string): Promise<void> {
    const run = this.queue.then(() => this.appendNow(day, line));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async appendNow(day: string, line: string): Promise<void> {
    const max = this.opts.maxRetries ?? 8;
    for (let attempt = 0; ; attempt++) {
      if (line.includes('\n')) throw new Error('a log line must not contain a newline');
      const cur = await this.load(day);
      const prefix = cur?.text ?? '';
      const body = prefix + line + '\n';
      // 追記のみ：既存の内容が先頭にそのまま残ることを確かめてから書く
      if (!body.startsWith(prefix) || body.length <= prefix.length) throw new Error('append-only invariant violated');
      try {
        await this.api.put(logPath(day), body, {
          access: 'private',
          token: this.opts.token,
          contentType: 'application/x-ndjson',
          addRandomSuffix: false,
          // 既存なら ETag が一致するときだけ上書き。新規なら上書きを許さない（同時に作られたら失敗→やり直し）
          ...(cur?.etag ? { ifMatch: cur.etag } : { allowOverwrite: false }),
        });
        return;
      } catch (e) {
        const conflict = e instanceof BlobPreconditionFailedError || /already exists/i.test(String((e as Error).message));
        if (!conflict || attempt >= max) throw e;
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempt + Math.random() * 50));
      }
    }
  }

  async days(): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.api.list({ prefix: 'log/', cursor, token: this.opts.token });
      for (const b of r.blobs) {
        const m = /^log\/(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(b.pathname);
        if (m) out.push(m[1]);
      }
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out.sort();
  }
}
