/**
 * JPYC の EIP-712 domain（name "JPY Coin" / version "1"）が正しいかを、資金なしで確かめる。
 * 使い捨ての鍵で value=0 の transferWithAuthorization に署名し、eth_call（simulate）でコントラクトに検証させる。
 * domain が違えば "EIP3009: invalid signature" で revert する。
 * 使い方: POLYGON_RPC_URL=... [JPYC_NETWORK=eip155:80002] npm run jpyc:domain-check
 */
import 'dotenv/config';
import { createPublicClient, http, parseAbi, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { polygon, polygonAmoy } from 'viem/chains';
import { JPYC_ADDRESS, JPYC_EIP712, POLYGON_MAINNET, chainIdOf, type JpycNetwork } from '../src/jpyc.ts';

const network = (process.env.JPYC_NETWORK || POLYGON_MAINNET) as JpycNetwork;
const chain = network === POLYGON_MAINNET ? polygon : polygonAmoy;
const rpc = process.env.POLYGON_RPC_URL || (network === POLYGON_MAINNET ? 'https://polygon-bor-rpc.publicnode.com' : 'https://polygon-amoy-bor-rpc.publicnode.com');
const pc = createPublicClient({ chain, transport: http(rpc) });
const abi = parseAbi([
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
]);
const types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const name = await pc.readContract({ address: JPYC_ADDRESS, abi, functionName: 'name' });
const decimals = await pc.readContract({ address: JPYC_ADDRESS, abi, functionName: 'decimals' });
console.log(`${network} name()=${name} decimals()=${decimals}`);

const acct = privateKeyToAccount(generatePrivateKey());
const msg = {
  from: acct.address,
  to: '0x000000000000000000000000000000000000dEaD' as const,
  value: 0n,
  validAfter: 0n,
  validBefore: BigInt(Math.floor(Date.now() / 1000) + 300),
  nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
};
const sig = await acct.signTypedData({
  domain: { ...JPYC_EIP712, chainId: chainIdOf(network), verifyingContract: JPYC_ADDRESS },
  types,
  primaryType: 'TransferWithAuthorization',
  message: msg,
});
const r = sig.slice(0, 66) as `0x${string}`;
const s = `0x${sig.slice(66, 130)}` as `0x${string}`;
const v = parseInt(sig.slice(130, 132), 16);
try {
  await pc.simulateContract({
    address: JPYC_ADDRESS, abi, functionName: 'transferWithAuthorization',
    args: [msg.from, msg.to, msg.value, msg.validAfter, msg.validBefore, msg.nonce, v, r, s],
    account: '0x000000000000000000000000000000000000bEEF',
  });
  console.log(`OK: domain ${JSON.stringify(JPYC_EIP712)} accepted by the contract`);
} catch (e) {
  console.error(`NG: ${(e as Error & { shortMessage?: string }).shortMessage ?? (e as Error).message}`);
  process.exit(1);
}
