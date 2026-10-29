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
  /** 初めてなら記録して true、既にあれば false。expiresAtMs を過ぎた記録は消してよい */
  claimNonce(key: string, expiresAtMs?: number): Promise<boolean>;
  isBlocked(payer: string, nowMs: number): Promise<boolean>;
  block(payer: string, untilMs: number, reason: string): Promise<void>;
  /** day の支出に micro を足して cap 以下なら true（足した状態にする）。超えるなら false（足さない） */
  reserveSpend(day: string, micro: bigint, capMicro: bigint): Promise<boolean>;
  /** 支払わなかった分を戻す */
  releaseSpend(day: string, micro: bigint): Promise<void>;
  spent(day: string): Promise<bigint>;
}

const safe = (s: string) => s.toLowerCase().replace(/[^0-9a-z:_-]/g, '_');

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

/** Blob の読み書き（テストで差し替える）。put は ifMatch があればその ETag のときだけ、無ければ「まだ無いときだけ」作る */
export interface BlobBackend {
  load(path: string): Promise<{ text: string; etag: string } | null>;
  put(path: string, text: string, cond: { ifMatch: string } | { create: true }): Promise<void>;
}

/** 条件が合わずに書けなかった（他の関数が先に書いた） */
export class WriteConflict extends Error {}

export class VercelBlobBackend implements BlobBackend {
  /** token が無ければ @vercel/blob が OIDC（Vercel 上の関数、または VERCEL_OIDC_TOKEN + BLOB_STORE_ID）で認証する */
  constructor(private readonly token?: string) {}
  async load(path: string) {
    const r = await get(path, { access: 'private', useCache: false, ...(this.token ? { token: this.token } : {}) });
    if (!r || r.statusCode !== 200) return null;
    return { text: await new Response(r.stream).text(), etag: r.blob.etag };
  }
  async put(path: string, text: string, cond: { ifMatch: string } | { create: true }) {
    try {
      await put(path, text, {
        access: 'private', ...(this.token ? { token: this.token } : {}), addRandomSuffix: false, contentType: 'application/json',
        ...('ifMatch' in cond ? { ifMatch: cond.ifMatch } : { allowOverwrite: false }),
      });
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError || /already exists|precondition/i.test(String((e as Error)?.message))) throw new WriteConflict(String(e));
      throw e;
    }
  }
}

/** nonce の台帳の数。同じ nonce は必ず同じ台帳に入る */
export const NONCE_SHARDS = 16;

const shardOf = (key: string) => {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h % NONCE_SHARDS;
};

/**
 * Vercel Blob（private）での共有状態。
 *
 * 同じ署名が同時に 2 回届いても上流の仕入れが 1 回だけになるよう、nonce の記録は ETag 比較つきの書き込み（ifMatch）だけで行う。
 * 「無ければ作る」（allowOverwrite: false）は同時に来たときの排他が文書で保証されていないので、判定には使わない。
 * そのために、nonce の台帳（state/nonces-0..15.json）と支出の台帳（state/spend.json）はデプロイ前に作っておく（npm run state:init）。
 * 台帳が無いときだけ作成を試すが、作成のあとは必ず読み直して ifMatch で書く。
 *
 * 台帳の中身は { key: 期限(ms) }。期限（validBefore + 余裕）を過ぎた nonce はチェーン側でも通らないので、書くたびに消す。
 */
export class BlobSharedStore implements SharedStore {
  private readonly backend: BlobBackend;
  constructor(tokenOrBackend: string | undefined | BlobBackend, private readonly prefix = 'state') {
    this.backend = tokenOrBackend === undefined || typeof tokenOrBackend === 'string' ? new VercelBlobBackend(tokenOrBackend) : tokenOrBackend;
  }

  static ledgerPaths(prefix = 'state') {
    return [...Array.from({ length: NONCE_SHARDS }, (_, i) => `${prefix}/nonces-${i}.json`), `${prefix}/spend.json`];
  }

  /**
   * 台帳が無ければ空で作る（ゲートウェイの起動時・npm run state:init）。作った数を返す。
   * 起動のたびに 17 回読むと Blob の読み取り回数が増えるので、作り終えた印（ready.json）を 1 回読むだけで済ませる。
   */
  async init(): Promise<number> {
    const marker = `${this.prefix}/ready.json`;
    if (await this.backend.load(marker)) return 0;
    let n = 0;
    for (const p of BlobSharedStore.ledgerPaths(this.prefix)) {
      if (await this.backend.load(p)) continue;
      try {
        await this.backend.put(p, '{}', { create: true });
        n++;
      } catch (e) {
        if (!(e instanceof WriteConflict)) throw e;
      }
    }
    try {
      await this.backend.put(marker, JSON.stringify({ at: new Date().toISOString() }), { create: true });
    } catch (e) {
      if (!(e instanceof WriteConflict)) throw e;
    }
    return n;
  }

  /** 台帳を読んで f で書き換え、ETag が変わっていなければ書く。他の関数と競合したら読み直してやり直す */
  private async update<T>(path: string, f: (cur: Record<string, any>) => { next?: Record<string, any>; result: T }): Promise<T> {
    for (let attempt = 0; attempt < 12; attempt++) {
      let cur = await this.backend.load(path);
      if (!cur) {
        try {
          await this.backend.put(path, '{}', { create: true });
        } catch (e) {
          if (!(e instanceof WriteConflict)) throw e;
        }
        cur = await this.backend.load(path);
        if (!cur) throw new Error(`ledger ${path} missing`);
      }
      const { next, result } = f(JSON.parse(cur.text || '{}'));
      if (!next) return result;
      try {
        await this.backend.put(path, JSON.stringify(next), { ifMatch: cur.etag });
        return result;
      } catch (e) {
        if (!(e instanceof WriteConflict)) throw e;
        await new Promise((r) => setTimeout(r, 30 * 2 ** Math.min(attempt, 5) + Math.random() * 50));
      }
    }
    throw new Error(`ledger ${path}: too many conflicts`);
  }

  async claimNonce(key: string, expiresAtMs = Date.now() + 15 * 60_000, nowMs = Date.now()) {
    const k = key.toLowerCase();
    return this.update(`${this.prefix}/nonces-${shardOf(k)}.json`, (cur) => {
      if (Number(cur[k] ?? 0) > nowMs) return { result: false };
      const next: Record<string, number> = {};
      for (const [kk, v] of Object.entries(cur)) if (Number(v) > nowMs) next[kk] = Number(v);
      next[k] = expiresAtMs;
      return { next, result: true };
    });
  }

  async isBlocked(payer: string, nowMs: number) {
    const cur = await this.backend.load(`${this.prefix}/block/${safe(payer)}.json`);
    if (!cur) return false;
    try {
      return Number(JSON.parse(cur.text).until) > nowMs;
    } catch {
      return false;
    }
  }

  async block(payer: string, untilMs: number, reason: string) {
    // ブロックは上書きでよい（どちらが勝っても 24 時間ブロックされる）
    const path = `${this.prefix}/block/${safe(payer)}.json`;
    const body = JSON.stringify({ until: untilMs, reason });
    const cur = await this.backend.load(path);
    try {
      await this.backend.put(path, body, cur ? { ifMatch: cur.etag } : { create: true });
    } catch (e) {
      if (!(e instanceof WriteConflict)) throw e;
    }
  }

  private updateSpend(day: string, f: (cur: bigint) => bigint | null) {
    return this.update(`${this.prefix}/spend.json`, (cur) => {
      const value = BigInt(cur[day] ?? '0');
      const v = f(value);
      if (v === null) return { result: false };
      // 直近 14 日分だけ残す
      const days = Object.keys(cur).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-13);
      const next: Record<string, string> = Object.fromEntries(days.filter((d) => d !== day).map((d) => [d, String(cur[d])]));
      next[day] = v.toString();
      return { next, result: true };
    });
  }

  reserveSpend(day: string, micro: bigint, capMicro: bigint) {
    return this.updateSpend(day, (cur) => (cur + micro > capMicro ? null : cur + micro));
  }

  async releaseSpend(day: string, micro: bigint) {
    await this.updateSpend(day, (cur) => (cur > micro ? cur - micro : 0n));
  }

  async spent(day: string) {
    const cur = await this.backend.load(`${this.prefix}/spend.json`);
    return cur ? BigInt(JSON.parse(cur.text || '{}')[day] ?? '0') : 0n;
  }
}
