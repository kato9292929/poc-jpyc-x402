/**
 * 直近に受け取った EIP-3009 の nonce を保持し、同じ nonce の再送を facilitator に投げる前に弾く（指示書 §7）。
 * 保持期間は署名の validBefore まで（それ以降はチェーン側でも期限切れで通らない）＋余裕分。
 * プロセス内のメモリだけに持つ。再起動で消えるが、その場合もチェーン側の authorizationState が二重使用を防ぐ。
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly maxEntries = 50_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 初めての nonce なら記録して true。既に見た nonce なら false。 */
  claim(nonce: string, validBeforeSec: number): boolean {
    const key = nonce.toLowerCase();
    this.prune();
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.maxEntries) {
      // 一番古いものから捨てる（Map は挿入順）
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(key, validBeforeSec * 1000 + 60_000);
    return true;
  }

  get size() {
    return this.seen.size;
  }

  private prune() {
    const t = this.now();
    for (const [k, exp] of this.seen) if (exp < t) this.seen.delete(k);
  }
}
