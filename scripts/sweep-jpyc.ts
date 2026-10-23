/**
 * 買い手ウォレットに残った JPYC を、手元で管理しているウォレットへ戻す。
 * 買い手は POL を持たないので、買い手が EIP-3009（transferWithAuthorization）に署名し、relayer がガスを払って送る。
 * 既定はシミュレーションだけ（送金しない）。--send を付けたときだけ送る。
 *
 * 使い方:
 *   npx tsx scripts/sweep-jpyc.ts <送り先アドレス> [--amount 15] [--send]
 * 鍵は .env.buyer（BUYER_PRIVATE_KEY）と .env.facilitator（RELAYER_PRIVATE_KEY）から読む。値は表示しない。
 */
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { createPublicClient, createWalletClient, erc20Abi, formatEther, getAddress, http, isAddress, parseAbi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { JPYC_ADDRESS, JPYC_EIP712, atomicToJpyc, jpycToAtomic, polygonscanTxUrl } from '../src/jpyc.ts';

const args = process.argv.slice(2);
const to = args[0];
if (!to || !isAddress(to)) throw new Error('usage: npx tsx scripts/sweep-jpyc.ts <toAddress> [--amount N] [--send]');
const send = args.includes('--send');
const amountArg = args.includes('--amount') ? args[args.indexOf('--amount') + 1] : undefined;

const buyer = privateKeyToAccount(parse(readFileSync('.env.buyer')).BUYER_PRIVATE_KEY as `0x${string}`);
const relayer = privateKeyToAccount(parse(readFileSync('.env.facilitator')).RELAYER_PRIVATE_KEY as `0x${string}`);
const rpc = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
const pc = createPublicClient({ chain: polygon, transport: http(rpc) });
const wc = createWalletClient({ account: relayer, chain: polygon, transport: http(rpc) });

const recipient = getAddress(to);
if ([buyer.address, relayer.address].includes(recipient)) throw new Error('recipient must be a different wallet');
const balance = await pc.readContract({ address: JPYC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [buyer.address] });
const value = amountArg ? jpycToAtomic(amountArg) : balance;
if (value <= 0n || value > balance) throw new Error(`invalid amount: balance ${atomicToJpyc(balance)} JPYC`);

const abi = parseAbi([
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
]);
const msg = {
  from: buyer.address,
  to: recipient,
  value,
  validAfter: 0n,
  validBefore: BigInt(Math.floor(Date.now() / 1000) + 300),
  nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
};
const sig = await buyer.signTypedData({
  domain: { ...JPYC_EIP712, chainId: 137, verifyingContract: JPYC_ADDRESS },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: msg,
});
const r = sig.slice(0, 66) as `0x${string}`;
const s = `0x${sig.slice(66, 130)}` as `0x${string}`;
const v = parseInt(sig.slice(130, 132), 16);
const call = {
  address: JPYC_ADDRESS,
  abi,
  functionName: 'transferWithAuthorization' as const,
  args: [msg.from, msg.to, msg.value, msg.validAfter, msg.validBefore, msg.nonce, v, r, s] as const,
  account: relayer,
};

const { request } = await pc.simulateContract(call);
const gas = await pc.estimateContractGas(call);
const gasPrice = await pc.getGasPrice();
console.log(`from ${buyer.address} -> to ${recipient}: ${atomicToJpyc(value)} JPYC (buyer balance ${atomicToJpyc(balance)})`);
console.log(`relayer ${relayer.address} pays gas: ~${formatEther(gas * gasPrice)} POL (balance ${formatEther(await pc.getBalance({ address: relayer.address }))})`);
if (!send) {
  console.log('simulation OK (not sent). Re-run with --send to transfer.');
  process.exit(0);
}
const hash = await wc.writeContract(request);
const receipt = await pc.waitForTransactionReceipt({ hash });
console.log(`status=${receipt.status} ${polygonscanTxUrl('eip155:137', hash)}`);
const after = await pc.readContract({ address: JPYC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [buyer.address] });
console.log(`buyer balance now ${atomicToJpyc(after)} JPYC`);
