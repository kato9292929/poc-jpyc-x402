import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { generateKeyPairSync } from 'node:crypto';
import { base58 } from '@scure/base';
import { JinUpstreamBuyer, SOLANA_MAINNET, SOLANA_USDC } from '../src/upstream.ts';

function key() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return base58.encode(Buffer.concat([seed, pub]));
}

// 2026-10 に jin.x402jp.com/api/jin/series が返した 402 と同じ形
const pr = (amount: string) => ({
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'https://jin.x402jp.com/api/jin/series', description: 'JIN', mimeType: '' },
  accepts: [
    {
      scheme: 'exact',
      network: SOLANA_MAINNET,
      amount,
      asset: SOLANA_USDC,
      payTo: '4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf',
      maxTimeoutSeconds: 300,
      extra: { feePayer: 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww' },
    },
  ],
});

test('上流の価格が設定の原価と違えば署名しない', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(pr('20000') as any) } });
  }) as typeof fetch;
  const b = await JinUpstreamBuyer.create({ svmPrivateKey: key(), fetch: fetchImpl });
  const r = await b.buy('https://jin.x402jp.com/api/jin/series', 10_000n);
  assert.equal(r.status, 402);
  assert.equal(r.paid, false);
  assert.match(r.error!, /mismatch/);
  assert.equal(calls, 1);
});

test('無料のルートで 402 が返れば支払わない', async () => {
  const fetchImpl = (async () =>
    new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(pr('10000') as any) } })) as typeof fetch;
  const b = await JinUpstreamBuyer.create({ svmPrivateKey: key(), fetch: fetchImpl });
  const r = await b.buy('https://jin.x402jp.com/api/jin/latest', 0n);
  assert.equal(r.paid, false);
  assert.ok(r.error);
});

test('一致すれば Solana の支払いを付けて再送し、上流の tx を取る', async () => {
  // 実際の Solana 取引の組み立てには RPC が要る（blockhash 等）。ここでは署名の段まで進むことと、
  // 再送の応答の PAYMENT-RESPONSE から tx を読むところを、createPaymentPayload を差し替えて確かめる。
  const seen: Headers[] = [];
  const fetchImpl = (async (_u: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    seen.push(h);
    if (!h.get('payment-signature')) {
      return new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(pr('10000') as any) } });
    }
    return new Response('{"series":[]}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'payment-response': encodePaymentResponseHeader({ success: true, transaction: '5UpstreamSig', network: SOLANA_MAINNET as any }),
      },
    });
  }) as typeof fetch;
  const b = await JinUpstreamBuyer.create({ svmPrivateKey: key(), fetch: fetchImpl });
  (b as any).client.createPaymentPayload = async (p: any) => ({ x402Version: 2, accepted: p.accepts[0], payload: { transaction: 'dGVzdA==' } });
  const r = await b.buy('https://jin.x402jp.com/api/jin/series', 10_000n);
  assert.equal(r.status, 200);
  assert.equal(r.paid, true);
  assert.equal(r.tx, '5UpstreamSig');
  assert.equal(new TextDecoder().decode(r.body), '{"series":[]}');
  assert.ok(seen[1].get('payment-signature'));
});

test('支払い後に上流が 402 を返し直したら、上流の理由をエラーに残す', async () => {
  const fetchImpl = (async (_u: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    if (!h.get('payment-signature')) {
      return new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(pr('20000') as any) } });
    }
    const again = { ...pr('20000'), error: 'invalid_exact_svm_payload_transaction_simulation_failed' };
    return new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(again as any) } });
  }) as typeof fetch;
  const b = await JinUpstreamBuyer.create({ svmPrivateKey: key(), fetch: fetchImpl });
  (b as any).client.createPaymentPayload = async (p: any) => ({ x402Version: 2, accepted: p.accepts[0], payload: { transaction: 'dGVzdA==' } });
  const r = await b.buy('https://jin.x402jp.com/api/jin/movers', 20_000n);
  assert.equal(r.status, 402);
  assert.equal(r.paid, true);
  assert.equal(r.error, 'upstream 402 after payment (invalid_exact_svm_payload_transaction_simulation_failed)');
});

test('PAYMENT-REQUIRED が無ければ本文の先頭を理由として残す', async () => {
  const fetchImpl = (async (_u: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    if (!h.get('payment-signature')) {
      return new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(pr('20000') as any) } });
    }
    return new Response('{"error":"facilitator settle failed"}', { status: 402 });
  }) as typeof fetch;
  const b = await JinUpstreamBuyer.create({ svmPrivateKey: key(), fetch: fetchImpl });
  (b as any).client.createPaymentPayload = async (p: any) => ({ x402Version: 2, accepted: p.accepts[0], payload: { transaction: 'dGVzdA==' } });
  const r = await b.buy('https://jin.x402jp.com/api/jin/movers', 20_000n);
  assert.equal(r.error, 'upstream 402 after payment ({"error":"facilitator settle failed"})');
});
