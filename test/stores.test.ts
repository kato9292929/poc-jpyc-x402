import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlobSharedStore, WriteConflict, type BlobBackend } from '../src/stores.ts';

const tick = () => new Promise((r) => setTimeout(r, Math.random() * 5));

/**
 * ETag 比較（ifMatch）は原子的、「無ければ作る」は原子的でない（確認と書き込みの間に他が割り込める）Blob の偽物。
 * 最悪の前提でも同じ nonce が 2 回通らないことを確かめる。
 */
class FakeBlob implements BlobBackend {
  files = new Map<string, { text: string; etag: string }>();
  private seq = 0;
  async load(path: string) {
    await tick();
    const f = this.files.get(path);
    return f ? { ...f } : null;
  }
  async put(path: string, text: string, cond: { ifMatch: string } | { create: true }) {
    if ('create' in cond) {
      const exists = this.files.has(path);
      await tick(); // ここで他の書き込みが割り込める
      if (exists) throw new WriteConflict('exists');
      this.files.set(path, { text, etag: `e${++this.seq}` });
      return;
    }
    await tick();
    const f = this.files.get(path);
    if (!f || f.etag !== cond.ifMatch) throw new WriteConflict('precondition');
    this.files.set(path, { text, etag: `e${++this.seq}` });
  }
}

test('同じ nonce が同時に 30 回届いても通るのは 1 回だけ（台帳を先に作った場合）', async () => {
  for (let round = 0; round < 5; round++) {
    const blob = new FakeBlob();
    const store = new BlobSharedStore(blob);
    assert.equal(await store.init(), 17);
    const key = `eip155:137:0xabc:0x${round}`;
    const results = await Promise.all(Array.from({ length: 30 }, () => store.claimNonce(key, Date.now() + 60_000)));
    assert.equal(results.filter(Boolean).length, 1);
  }
});

test('別々の nonce は同時でも全部通る・期限切れは消える', async () => {
  const blob = new FakeBlob();
  const store = new BlobSharedStore(blob);
  await store.init();
  const now = Date.now();
  const r = await Promise.all(Array.from({ length: 20 }, (_, i) => store.claimNonce(`k${i}`, now + 60_000)));
  assert.equal(r.filter(Boolean).length, 20);
  assert.equal(await store.claimNonce('k3', now + 60_000), false);
  // 期限切れの記録は次の書き込みで消える
  assert.equal(await store.claimNonce('old', now + 1, now), true);
  assert.equal(await store.claimNonce('old', now + 120_000, now + 10), true);
});

test('上流の日次支出は同時でも上限を超えない', async () => {
  const blob = new FakeBlob();
  const store = new BlobSharedStore(blob);
  await store.init();
  const r = await Promise.all(Array.from({ length: 25 }, () => store.reserveSpend('2026-10-30', 100_000n, 2_000_000n)));
  assert.equal(r.filter(Boolean).length, 20);
  assert.equal(await store.spent('2026-10-30'), 2_000_000n);
  await store.releaseSpend('2026-10-30', 100_000n);
  assert.equal(await store.spent('2026-10-30'), 1_900_000n);
});
