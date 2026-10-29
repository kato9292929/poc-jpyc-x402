/**
 * 関数の間で共有する状態（指示書4 §2）。Vercel の関数はリクエストごとに別のインスタンスで動くことがあるので、
 * メモリやファイルではなく共有ストアに置く。本番は Vercel Blob（BlobSharedStore）、テスト・ローカルは MemorySharedStore。
 *
 * - nonce：同じ EIP-3009 署名（network + from + nonce）の再送を、facilitator に投げる前に弾く
 * - payer の受付停止：settle に失敗した payer を 24 時間受け付けない（署名後に JPYC を移して settle を落とす悪用への備え）
 * - 上流への支払いの日次上限：JST の 1 日あたり UPSTREAM_DAILY_CAP_USD まで。超えたら 503
 */
import { BlobPreconditionFailedError, get, put } from '@vercel/blob';

export interface SharedStore {
  /** 初めてなら記録して true、既にあれば false */
  claimNonce(key: string): Promise<boolean>;
  isBlocked(payer: string, nowMs: number): Promise<boolean>;
  block(payer: string, untilMs: number, reason: string): Promise<void>;
  /** day の支出に micro を足して cap 以下なら true（足した状態にする）。超えるなら false（足さない） */
  reserveSpend(day: string, micro: bigint, capMicro: bigint): Promise<boolean>;
  /** 支払わなかった分を戻す */
  releaseSpend(day: string, micro: bigint): Promise<void>;
  spent(day: string): Promise<bigint>;
}

export class MemorySharedStore implements SharedStore {
  readonly nonces = new Set<string>();
  readonly blocked = new Map<string, number>();
  readonly spend = new Map<string, bigint>();
  async claimNonce(key: string) {
    const k = key.toLowerCase();
    if (this.nonces.has(k)) return false;
    this.nonces.add(k);
    return true;
  }
  async isBlocked(payer: string, nowMs: number) {
    return (this.blocked.get(payer.toLowerCase()) ?? 0) > nowMs;
  }
  async block(payer: string, untilMs: number) {
    this.blocked.set(payer.toLowerCase(), untilMs);
  }
  async reserveSpend(day: string, micro: bigint, capMicro: bigint) {
    const cur = this.spend.get(day) ?? 0n;
    if (cur + micro > capMicro) return false;
    this.spend.set(day, cur + micro);
    return true;
  }
  async releaseSpend(day: string, micro: bigint) {
    const cur = this.spend.get(day) ?? 0n;
    this.spend.set(day, cur > micro ? cur - micro : 0n);
  }
  async spent(day: string) {
    return this.spend.get(day) ?? 0n;
  }
}

const safe = (s: string) => s.toLowerCase().replace(/[^0-9a-z:_-]/g, '_');

/** Vercel Blob（private）。作成の排他（allowOverwrite:false）と ETag の比較（ifMatch）で、複数の関数から同時に書いても壊れない */
export class BlobSharedStore implements SharedStore {
  constructor(private readonly token: string, private readonly prefix = 'state') {}

  private async load(path: string): Promise<{ text: string; etag?: string } | null> {
    const r = await get(path, { access: 'private', useCache: false, token: this.token });
    if (!r || r.statusCode !== 200) return null;
    return { text: await new Response(r.stream).text(), etag: r.blob.etag };
  }

  private isConflict(e: unknown) {
    return e instanceof BlobPreconditionFailedError || /already exists|precondition/i.test(String((e as Error)?.message));
  }

  async claimNonce(key: string) {
    try {
      await put(`${this.prefix}/nonce/${safe(key)}`, '1', { access: 'private', token: this.token, addRandomSuffix: false, allowOverwrite: false, contentType: 'text/plain' });
      return true;
    } catch (e) {
      if (this.isConflict(e)) return false;
      throw e;
    }
  }

  async isBlocked(payer: string, nowMs: number) {
    const cur = await this.load(`${this.prefix}/block/${safe(payer)}.json`);
    if (!cur) return false;
    try {
      return Number(JSON.parse(cur.text).until) > nowMs;
    } catch {
      return false;
    }
  }

  async block(payer: string, untilMs: number, reason: string) {
    await put(`${this.prefix}/block/${safe(payer)}.json`, JSON.stringify({ until: untilMs, reason }), {
      access: 'private', token: this.token, addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
    });
  }

  private async updateSpend(day: string, f: (cur: bigint) => bigint | null): Promise<boolean> {
    const path = `${this.prefix}/spend/${safe(day)}.json`;
    for (let attempt = 0; attempt < 10; attempt++) {
      const cur = await this.load(path);
      const value = cur ? BigInt(JSON.parse(cur.text).micro) : 0n;
      const next = f(value);
      if (next === null) return false;
      try {
        await put(path, JSON.stringify({ micro: next.toString() }), {
          access: 'private', token: this.token, addRandomSuffix: false, contentType: 'application/json',
          ...(cur?.etag ? { ifMatch: cur.etag } : { allowOverwrite: false }),
        });
        return true;
      } catch (e) {
        if (!this.isConflict(e)) throw e;
        await new Promise((r) => setTimeout(r, 40 * 2 ** attempt + Math.random() * 40));
      }
    }
    throw new Error('spend counter: too many conflicts');
  }

  reserveSpend(day: string, micro: bigint, capMicro: bigint) {
    return this.updateSpend(day, (cur) => (cur + micro > capMicro ? null : cur + micro));
  }

  async releaseSpend(day: string, micro: bigint) {
    await this.updateSpend(day, (cur) => (cur > micro ? cur - micro : 0n));
  }

  async spent(day: string) {
    const cur = await this.load(`${this.prefix}/spend/${safe(day)}.json`);
    return cur ? BigInt(JSON.parse(cur.text).micro) : 0n;
  }
}
