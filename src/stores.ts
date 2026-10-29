/**
 * 関数の間で共有する状態（指示書4 §2）。Vercel の関数はリクエストごとに別のインスタンスで動くことがあるので、
 * メモリやファイルではなく共有ストアに置く。共有ストアは使わず、インスタンス内のメモリ（MemorySharedStore）に置く。インスタンスをまたぐ二重の仕入れは上流の日次上限で抑える。
 *
 * - nonce：同じ EIP-3009 署名（network + from + nonce）の再送を、facilitator に投げる前に弾く
 * - payer の受付停止：settle に失敗した payer を 24 時間受け付けない（署名後に JPYC を移して settle を落とす悪用への備え）
 * - 上流への支払いの日次上限：JST の 1 日あたり UPSTREAM_DAILY_CAP_USD まで。超えたら 503
 */

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
