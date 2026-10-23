import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atomicToJpyc, jpycToAtomic } from '../src/jpyc.ts';

test('JPYC は 18 桁（USDC の 6 桁ではない）', () => {
  assert.equal(jpycToAtomic('2'), 2_000_000_000_000_000_000n);
  assert.equal(jpycToAtomic(3), 3n * 10n ** 18n);
  assert.equal(jpycToAtomic('0.5'), 5n * 10n ** 17n);
  assert.equal(jpycToAtomic('0.000000000000000001'), 1n);
  assert.equal(atomicToJpyc(2_000_000_000_000_000_000n), '2');
  assert.equal(atomicToJpyc('1500000000000000000'), '1.5');
  assert.equal(atomicToJpyc(0n), '0');
});

test('不正な金額は拒否する', () => {
  for (const bad of ['-1', '1e18', '0.0000000000000000001', '', 'abc', '1.']) {
    assert.throws(() => jpycToAtomic(bad), /invalid JPYC/);
  }
});
