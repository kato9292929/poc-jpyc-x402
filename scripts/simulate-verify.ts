/**
 * facilitator を立てる前に、x402 の参照実装の facilitator（@x402/evm）で、このゲートウェイの 402 に対して
 * 買い手（@x402/evm）が作った JPYC の支払いを verify だけする（settle はしない・送金しない）。
 * 使い捨ての鍵で署名するので残高不足（insufficient_funds）で落ちるのが正しい結果：
 * 署名・domain・金額の形式は通り、残高チェックまで進んだことを示す。domain が違えば署名エラーで落ちる。
 * 使い方: [POLYGON_RPC_URL=...] [JPYC_NETWORK=eip155:80002] npx tsx scripts/simulate-verify.ts [BUYER_PRIVATE_KEY を入れると実残高で verify]
 */
import 'dotenv/config';
import { x402Client } from '@x402/core/client';
import { x402Facilitator } from '@x402/core/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { ExactEvmScheme as ExactEvmClient } from '@x402/evm/exact/client';
import { ExactEvmScheme as ExactEvmFacilitator } from '@x402/evm/exact/facilitator';
import { createWalletClient, http, publicActions } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { polygon, polygonAmoy } from 'viem/chains';
import { POLYGON_MAINNET, type JpycNetwork } from '../src/jpyc.ts';
import { buildPaymentRequired, buildRequirements } from '../src/payment.ts';

const network = (process.env.JPYC_NETWORK || POLYGON_MAINNET) as JpycNetwork;
const chain = network === POLYGON_MAINNET ? polygon : polygonAmoy;
const rpc = process.env.POLYGON_RPC_URL || (network === POLYGON_MAINNET ? 'https://polygon-bor-rpc.publicnode.com' : 'https://polygon-amoy-bor-rpc.publicnode.com');
const payTo = process.env.JPYC_PAY_TO || '0x000000000000000000000000000000000000dEaD';

const buyer = privateKeyToAccount((process.env.BUYER_PRIVATE_KEY as `0x${string}`) ?? generatePrivateKey());
const relayer = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain, transport: http(rpc) }).extend(publicActions);
const facilitator = new x402Facilitator().register(network, new ExactEvmFacilitator(toFacilitatorEvmSigner(relayer as any)));

const requirements = buildRequirements({ network, payTo, priceJpyc: '2' });
const pr = buildPaymentRequired({ url: 'http://localhost/jin/series', description: 'simulate', requirements });
const client = new x402Client().register(network, new ExactEvmClient(buyer));
client.setSpendControls(false);
const payload = await client.createPaymentPayload(pr);
const v = await facilitator.verify(payload, requirements);
console.log(`network=${network} payer=${buyer.address}`);
console.log(JSON.stringify(v));
