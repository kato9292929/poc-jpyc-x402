/**
 * 新しい鍵を作る。秘密鍵は標準出力に出すだけ（ファイルには書かない）。.env に貼り、コミットしないこと。
 *   npm run wallet:new -- --solana   上流購入用（UPSTREAM_SOLANA_PRIVATE_KEY）。poc-card-credits のゲートウェイ鍵とは別にする（§6）
 *   npm run wallet:new -- --evm      買い手スクリプト用（BUYER_PRIVATE_KEY）。ゲートウェイには置かない
 */
import { generateKeyPairSync } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base58 } from '@scure/base';

const arg = process.argv[2];
if (arg === '--solana') {
  // 64 バイトの秘密鍵（seed 32 ＋ 公開鍵 32）を base58 で（@solana/kit の createKeyPairSignerFromBytes で読める形式）
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  console.log(`# Solana address: ${base58.encode(pub)}\nUPSTREAM_SOLANA_PRIVATE_KEY=${base58.encode(Buffer.concat([seed, pub]))}`);
} else if (arg === '--evm') {
  const pk = generatePrivateKey();
  console.log(`# EVM address: ${privateKeyToAccount(pk).address}\nBUYER_PRIVATE_KEY=${pk}`);
} else {
  console.error('usage: npm run wallet:new -- --solana | --evm');
  process.exit(1);
}
