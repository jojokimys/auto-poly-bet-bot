import 'server-only';

import { Contract } from '@ethersproject/contracts';
import { Wallet } from '@ethersproject/wallet';
import { BigNumber } from '@ethersproject/bignumber';
import { createWalletClient, createPublicClient, http, encodeFunctionData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { RelayClient, RelayerTxType, type Transaction } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { getBuilderConfig } from '@/lib/config/env';
import {
  POLYGON_RPCS,
  TX_RPCS,
  CHAIN_ID,
  getTxRpcUrl,
  switchToNextRpc,
  isRetryableRpcError,
  withProviderFallback,
  getCachedGasPrice,
  PROXY_REDEEM_GAS,
  EOA_REDEEM_GAS,
} from '@/lib/polygon/rpc';

const RELAYER_URL = 'https://relayer-v2.polymarket.com';

// Polymarket contract addresses (Polygon mainnet)
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

// ─── ABIs (ethers format for reads) ──────────────────────

const CTF_ABI = [
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
];

// ─── ABIs (viem format for relayer tx encoding) ──────────

const CTF_REDEEM_ABI = [{
  name: 'redeemPositions',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'collateralToken', type: 'address' },
    { name: 'parentCollectionId', type: 'bytes32' },
    { name: 'conditionId', type: 'bytes32' },
    { name: 'indexSets', type: 'uint256[]' },
  ],
  outputs: [],
}] as const;

const CTF_MERGE_ABI = [{
  name: 'mergePositions',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'collateralToken', type: 'address' },
    { name: 'parentCollectionId', type: 'bytes32' },
    { name: 'conditionId', type: 'bytes32' },
    { name: 'partition', type: 'uint256[]' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [],
}] as const;

const NR_REDEEM_ABI = [{
  name: 'redeemPositions',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [
    { name: '_conditionId', type: 'bytes32' },
    { name: '_amounts', type: 'uint256[]' },
  ],
  outputs: [],
}] as const;

const NR_MERGE_ABI = [{
  name: 'mergePositions',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'conditionId', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [],
}] as const;

// ─── Data API: Claimable Positions ──────────────────────

const DATA_API_URL = 'https://data-api.polymarket.com';

export interface ClaimablePosition {
  conditionId: string;
  asset: string;
  oppositeAsset: string;
  outcomeIndex: number;
  negativeRisk: boolean;
  size: number;
  title: string;
  outcome: string;
}

export async function fetchClaimablePositions(walletAddress: string): Promise<ClaimablePosition[]> {
  try {
    const res = await fetch(
      `${DATA_API_URL}/positions?user=${walletAddress}&redeemable=true&sizeThreshold=0&limit=500`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data.map((p: any) => ({
      conditionId: p.conditionId,
      asset: p.asset,
      oppositeAsset: p.oppositeAsset,
      outcomeIndex: p.outcomeIndex ?? 0,
      negativeRisk: p.negativeRisk ?? false,
      size: parseFloat(p.size) || 0,
      title: p.title ?? '',
      outcome: p.outcome ?? '',
    }));
  } catch {
    return [];
  }
}

// ─── On-Chain Types ─────────────────────────────────────

export interface OnChainRedeemResult {
  success: boolean;
  txHash: string | null;
  error: string | null;
  winningSide: 'YES' | 'NO' | null;
}

export interface RedeemProfile {
  privateKey: string;
  funderAddress: string;
  signatureType?: number;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  builderApiKey?: string;
  builderApiSecret?: string;
  builderApiPassphrase?: string;
}

// ─── Relayer Client ─────────────────────────────────────

function createRelayClient(profile: RedeemProfile): RelayClient {
  const account = privateKeyToAccount(profile.privateKey as Hex);
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(POLYGON_RPCS[0]),
  });

  const bKey = profile.builderApiKey || profile.apiKey;
  const bSecret = profile.builderApiSecret || profile.apiSecret;
  const bPass = profile.builderApiPassphrase || profile.apiPassphrase;

  let builderConfig: BuilderConfig | undefined;
  if (bKey && bSecret && bPass) {
    builderConfig = new BuilderConfig({
      localBuilderCreds: { key: bKey, secret: bSecret, passphrase: bPass },
    });
  } else {
    builderConfig = getBuilderConfig();
  }

  const relayTxType = profile.signatureType === 2
    ? RelayerTxType.SAFE
    : RelayerTxType.PROXY;

  return new RelayClient(RELAYER_URL, CHAIN_ID, wallet, builderConfig, relayTxType);
}

// ─── Read-only RPC helpers ──────────────────────────────

export async function isConditionResolved(conditionId: string): Promise<boolean> {
  return withProviderFallback(async (provider) => {
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, provider);
    const denom: BigNumber = await ctf.payoutDenominator(conditionId);
    return denom.gt(0);
  });
}

export async function getWinningSide(conditionId: string): Promise<'YES' | 'NO' | null> {
  try {
    return await withProviderFallback(async (provider) => {
      const ctf = new Contract(CTF_ADDRESS, CTF_ABI, provider);
      const denom: BigNumber = await ctf.payoutDenominator(conditionId);
      if (denom.isZero()) return null;

      const [yesNum, noNum]: [BigNumber, BigNumber] = await Promise.all([
        ctf.payoutNumerators(conditionId, 0),
        ctf.payoutNumerators(conditionId, 1),
      ]);

      if (yesNum.gt(0) && noNum.isZero()) return 'YES';
      if (noNum.gt(0) && yesNum.isZero()) return 'NO';
      return null;
    });
  } catch {
    return null;
  }
}

export async function getTokenBalance(owner: string, tokenId: string): Promise<BigNumber> {
  return withProviderFallback(async (provider) => {
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, provider);
    return ctf.balanceOf(owner, tokenId);
  });
}

// ─── Helper: read balances with fallback ─────────────────

async function readBalances(ownerAddress: string, yesTokenId: string, noTokenId: string) {
  return withProviderFallback(async (provider) => {
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, provider);
    const [yesBal, noBal]: [BigNumber, BigNumber] = await Promise.all([
      ctf.balanceOf(ownerAddress, yesTokenId),
      ctf.balanceOf(ownerAddress, noTokenId),
    ]);
    return { yesBal, noBal };
  });
}

// ─── Polymarket Proxy Wallet Factory ABI ─────────────────

const PROXY_WALLET_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';

const PROXY_FACTORY_ABI = [{
  name: 'proxy',
  type: 'function',
  stateMutability: 'payable',
  inputs: [{
    name: 'calls',
    type: 'tuple[]',
    components: [
      { name: 'typeCode', type: 'uint8' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
  }],
  outputs: [{ name: 'returnValues', type: 'bytes[]' }],
}] as const;

// ─── Relayer-based Redeem & Merge ───────────────────────

export async function redeemPositions(
  profile: RedeemProfile,
  conditionId: string,
  negRisk: boolean,
  yesTokenId: string,
  noTokenId: string,
): Promise<OnChainRedeemResult> {
  try {
    const ownerAddress = profile.funderAddress || new Wallet(profile.privateKey).address;
    const { yesBal, noBal } = await readBalances(ownerAddress, yesTokenId, noTokenId);

    if (yesBal.isZero() && noBal.isZero()) {
      return { success: true, txHash: null, error: null, winningSide: null };
    }

    const winningSide = await getWinningSide(conditionId);

    let tx: Transaction;
    if (negRisk) {
      const data = encodeFunctionData({
        abi: NR_REDEEM_ABI,
        functionName: 'redeemPositions',
        args: [conditionId as Hex, [BigInt(yesBal.toString()), BigInt(noBal.toString())]],
      });
      tx = { to: NEG_RISK_ADAPTER, data, value: '0' };
    } else {
      const data = encodeFunctionData({
        abi: CTF_REDEEM_ABI,
        functionName: 'redeemPositions',
        args: [USDC_E_ADDRESS as Hex, `0x${'00'.repeat(32)}` as Hex, conditionId as Hex, [1n, 2n]],
      });
      tx = { to: CTF_ADDRESS, data, value: '0' };
    }

    const relay = createRelayClient(profile);
    const response = await relay.execute([tx], 'redeem positions');
    const result = await response.wait();

    if (!result) {
      return { success: false, txHash: null, error: 'Relayer transaction timed out', winningSide };
    }

    const success = result.state === 'STATE_CONFIRMED' || result.state === 'STATE_MINED';
    return { success, txHash: result.transactionHash || null, error: success ? null : `Relayer state: ${result.state}`, winningSide };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, txHash: null, error: msg, winningSide: null };
  }
}

// ─── Direct RPC Redeem ───────────────────────────────────

export async function redeemPositionsRPC(
  profile: RedeemProfile,
  conditionId: string,
  negRisk: boolean,
  yesTokenId: string,
  noTokenId: string,
): Promise<OnChainRedeemResult> {
  try {
    const ownerAddress = profile.funderAddress || new Wallet(profile.privateKey).address;
    const { yesBal, noBal } = await readBalances(ownerAddress, yesTokenId, noTokenId);

    if (yesBal.isZero() && noBal.isZero()) {
      return { success: true, txHash: null, error: null, winningSide: null };
    }

    const winningSide = await getWinningSide(conditionId);

    let innerTo: string;
    let innerData: Hex;
    if (negRisk) {
      innerData = encodeFunctionData({
        abi: NR_REDEEM_ABI,
        functionName: 'redeemPositions',
        args: [conditionId as Hex, [BigInt(yesBal.toString()), BigInt(noBal.toString())]],
      });
      innerTo = NEG_RISK_ADAPTER;
    } else {
      innerData = encodeFunctionData({
        abi: CTF_REDEEM_ABI,
        functionName: 'redeemPositions',
        args: [USDC_E_ADDRESS as Hex, `0x${'00'.repeat(32)}` as Hex, conditionId as Hex, [1n, 2n]],
      });
      innerTo = CTF_ADDRESS;
    }

    const account = privateKeyToAccount(profile.privateKey as Hex);
    const isProxy = profile.funderAddress && profile.funderAddress.toLowerCase() !== account.address.toLowerCase();

    const rpcUrl = getTxRpcUrl();
    const walletClient = createWalletClient({ account, chain: polygon, transport: http(rpcUrl) });
    const publicClient = createPublicClient({ chain: polygon, transport: http(rpcUrl) });

    const gasPrice = await getCachedGasPrice(publicClient);

    let txHash: Hex;
    if (isProxy) {
      txHash = await walletClient.writeContract({
        chain: polygon,
        address: PROXY_WALLET_FACTORY as Hex,
        abi: PROXY_FACTORY_ABI,
        functionName: 'proxy',
        args: [[{
          typeCode: 1,
          to: innerTo as Hex,
          value: 0n,
          data: innerData,
        }]],
        gas: PROXY_REDEEM_GAS,
        gasPrice,
      });
    } else {
      txHash = await walletClient.sendTransaction({
        chain: polygon,
        to: innerTo as Hex,
        data: innerData,
        value: 0n,
        gas: EOA_REDEEM_GAS,
        gasPrice,
      });
    }

    // Wait for TX receipt to verify it actually confirmed
    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60_000, // 60s timeout
      });
      if (receipt.status === 'reverted') {
        return { success: false, txHash, error: 'TX reverted on-chain', winningSide };
      }
      return { success: true, txHash, error: null, winningSide };
    } catch (receiptErr) {
      // TX was sent but receipt timed out — may still confirm later
      const receiptMsg = receiptErr instanceof Error ? receiptErr.message : String(receiptErr);
      return { success: false, txHash, error: `TX sent but receipt failed: ${receiptMsg}`, winningSide };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, txHash: null, error: msg, winningSide: null };
  }
}

// ─── Relayer-based Merge ─────────────────────────────────

export async function mergePositions(
  profile: RedeemProfile,
  conditionId: string,
  negRisk: boolean,
  yesTokenId: string,
  noTokenId: string,
): Promise<OnChainRedeemResult> {
  try {
    const ownerAddress = profile.funderAddress || new Wallet(profile.privateKey).address;
    const { yesBal, noBal } = await readBalances(ownerAddress, yesTokenId, noTokenId);

    const mergeAmount = yesBal.lt(noBal) ? yesBal : noBal;
    if (mergeAmount.isZero()) {
      return { success: true, txHash: null, error: null, winningSide: null };
    }

    let tx: Transaction;
    if (negRisk) {
      const data = encodeFunctionData({
        abi: NR_MERGE_ABI,
        functionName: 'mergePositions',
        args: [conditionId as Hex, BigInt(mergeAmount.toString())],
      });
      tx = { to: NEG_RISK_ADAPTER, data, value: '0' };
    } else {
      const data = encodeFunctionData({
        abi: CTF_MERGE_ABI,
        functionName: 'mergePositions',
        args: [
          USDC_E_ADDRESS as Hex,
          `0x${'00'.repeat(32)}` as Hex,
          conditionId as Hex,
          [1n, 2n],
          BigInt(mergeAmount.toString()),
        ],
      });
      tx = { to: CTF_ADDRESS, data, value: '0' };
    }

    const relay = createRelayClient(profile);
    const response = await relay.execute([tx], 'merge positions');
    const result = await response.wait();

    if (!result) {
      return { success: false, txHash: null, error: 'Relayer transaction timed out', winningSide: null };
    }

    const success = result.state === 'STATE_CONFIRMED' || result.state === 'STATE_MINED';
    return { success, txHash: result.transactionHash || null, error: success ? null : `Relayer state: ${result.state}`, winningSide: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, txHash: null, error: msg, winningSide: null };
  }
}
