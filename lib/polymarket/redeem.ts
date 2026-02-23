import 'server-only';

import { Contract } from '@ethersproject/contracts';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Wallet } from '@ethersproject/wallet';
import { BigNumber } from '@ethersproject/bignumber';
import { createWalletClient, createPublicClient, http, encodeFunctionData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { RelayClient, RelayerTxType, type Transaction } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { getBuilderConfig } from '@/lib/config/env';

const POLYGON_RPC = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const POLYGON_RPC2 = process.env.POLYGON_RPC_URL2 || POLYGON_RPC; // separate RPC for direct tx (claim)
const RELAYER_URL = 'https://relayer-v2.polymarket.com';
const CHAIN_ID = 137;

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
  asset: string;          // tokenId we hold (winning side)
  oppositeAsset: string;  // other side tokenId
  outcomeIndex: number;   // 0=Yes, 1=No
  negativeRisk: boolean;
  size: number;
  title: string;
  outcome: string;        // "Yes" or "No"
}

/**
 * Fetch all redeemable positions for a wallet in a single API call.
 * Uses Polymarket Data API — no auth needed, just wallet address.
 */
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

/** Profile info needed for relayer transactions */
export interface RedeemProfile {
  privateKey: string;
  funderAddress: string;
  signatureType?: number; // 0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  builderApiKey?: string;
  builderApiSecret?: string;
  builderApiPassphrase?: string;
}

// ─── RPC Provider (read-only) ───────────────────────────

let providerCache: JsonRpcProvider | null = null;

class FetchJsonRpcProvider extends JsonRpcProvider {
  async send(method: string, params: Array<any>): Promise<any> {
    const request = { method, params, id: 42, jsonrpc: '2.0' };
    const res = await fetch(this.connection.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  }
}

function getProvider(forceNew = false): JsonRpcProvider {
  if (!providerCache || forceNew) {
    providerCache = new FetchJsonRpcProvider(POLYGON_RPC, CHAIN_ID);
  }
  return providerCache;
}

// ─── Relayer Client ─────────────────────────────────────

function createRelayClient(profile: RedeemProfile): RelayClient {
  // Use viem WalletClient — the builder-abstract-signer expects ethers v6 or viem
  const account = privateKeyToAccount(profile.privateKey as Hex);
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(POLYGON_RPC),
  });

  // Builder config: builder creds → CLOB API creds fallback → env fallback
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

  // Map signatureType to relayer tx type
  const relayTxType = profile.signatureType === 2
    ? RelayerTxType.SAFE
    : RelayerTxType.PROXY;

  return new RelayClient(RELAYER_URL, CHAIN_ID, wallet, builderConfig, relayTxType);
}

// ─── Read-only RPC helpers ──────────────────────────────

/** Check if a condition has been resolved on-chain */
export async function isConditionResolved(conditionId: string): Promise<boolean> {
  try {
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, getProvider());
    const denom: BigNumber = await ctf.payoutDenominator(conditionId);
    return denom.gt(0);
  } catch {
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, getProvider(true));
    const denom: BigNumber = await ctf.payoutDenominator(conditionId);
    return denom.gt(0);
  }
}

export async function getWinningSide(conditionId: string): Promise<'YES' | 'NO' | null> {
  try {
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, getProvider());
    const denom: BigNumber = await ctf.payoutDenominator(conditionId);
    if (denom.isZero()) return null;

    const [yesNum, noNum]: [BigNumber, BigNumber] = await Promise.all([
      ctf.payoutNumerators(conditionId, 0),
      ctf.payoutNumerators(conditionId, 1),
    ]);

    if (yesNum.gt(0) && noNum.isZero()) return 'YES';
    if (noNum.gt(0) && yesNum.isZero()) return 'NO';
    return null;
  } catch {
    try {
      const ctf = new Contract(CTF_ADDRESS, CTF_ABI, getProvider(true));
      const denom: BigNumber = await ctf.payoutDenominator(conditionId);
      if (denom.isZero()) return null;

      const [yesNum, noNum]: [BigNumber, BigNumber] = await Promise.all([
        ctf.payoutNumerators(conditionId, 0),
        ctf.payoutNumerators(conditionId, 1),
      ]);

      if (yesNum.gt(0) && noNum.isZero()) return 'YES';
      if (noNum.gt(0) && yesNum.isZero()) return 'NO';
      return null;
    } catch {
      return null;
    }
  }
}

/** Get ERC-1155 token balance on the CTF contract */
export async function getTokenBalance(owner: string, tokenId: string): Promise<BigNumber> {
  const ctf = new Contract(CTF_ADDRESS, CTF_ABI, getProvider());
  return ctf.balanceOf(owner, tokenId);
}

// ─── Relayer-based Redeem & Merge ───────────────────────

/**
 * Redeem resolved positions via Polymarket relayer.
 * No direct RPC write needed — relayer handles gas & submission.
 */
export async function redeemPositions(
  profile: RedeemProfile,
  conditionId: string,
  negRisk: boolean,
  yesTokenId: string,
  noTokenId: string,
): Promise<OnChainRedeemResult> {
  try {
    const ownerAddress = profile.funderAddress || new Wallet(profile.privateKey).address;

    // Read balances (RPC)
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, getProvider());
    const [yesBal, noBal]: [BigNumber, BigNumber] = await Promise.all([
      ctf.balanceOf(ownerAddress, yesTokenId),
      ctf.balanceOf(ownerAddress, noTokenId),
    ]);

    if (yesBal.isZero() && noBal.isZero()) {
      return { success: true, txHash: null, error: null, winningSide: null };
    }

    const winningSide = await getWinningSide(conditionId);

    // Build calldata
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

    // Submit via relayer
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

// ─── Polymarket Proxy Wallet Factory ABI ─────────────────
// ProxyWallet clones are owned by the factory, not the EOA.
// To execute tx: call factory.proxy() which derives your clone from msg.sender.

const PROXY_WALLET_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';

const PROXY_FACTORY_ABI = [{
  name: 'proxy',
  type: 'function',
  stateMutability: 'payable',
  inputs: [{
    name: 'calls',
    type: 'tuple[]',
    components: [
      { name: 'typeCode', type: 'uint8' },  // 1=CALL, 2=DELEGATECALL
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
  }],
  outputs: [{ name: 'returnValues', type: 'bytes[]' }],
}] as const;

/**
 * Redeem via direct RPC transaction (no relayer, needs MATIC for gas).
 * For POLY_PROXY wallets: calls ProxyWalletFactory.proxy() which forwards to clone.
 * For EOA wallets: calls CTF/NR directly.
 */
export async function redeemPositionsRPC(
  profile: RedeemProfile,
  conditionId: string,
  negRisk: boolean,
  yesTokenId: string,
  noTokenId: string,
): Promise<OnChainRedeemResult> {
  try {
    const ownerAddress = profile.funderAddress || new Wallet(profile.privateKey).address;

    // Read balances
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, getProvider());
    const [yesBal, noBal]: [BigNumber, BigNumber] = await Promise.all([
      ctf.balanceOf(ownerAddress, yesTokenId),
      ctf.balanceOf(ownerAddress, noTokenId),
    ]);

    if (yesBal.isZero() && noBal.isZero()) {
      return { success: true, txHash: null, error: null, winningSide: null };
    }

    const winningSide = await getWinningSide(conditionId);

    // Build inner calldata (the actual redeem call)
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
    const walletClient = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC2) });
    const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC2) });

    let txHash: Hex;
    const isProxy = profile.funderAddress && profile.funderAddress.toLowerCase() !== account.address.toLowerCase();

    if (isProxy) {
      // Polymarket ProxyWallet: call factory.proxy() — factory derives clone from msg.sender
      txHash = await walletClient.writeContract({
        chain: polygon,
        address: PROXY_WALLET_FACTORY as Hex,
        abi: PROXY_FACTORY_ABI,
        functionName: 'proxy',
        args: [[{
          typeCode: 1,  // CALL
          to: innerTo as Hex,
          value: 0n,
          data: innerData,
        }]],
      });
    } else {
      // EOA: call CTF/NR directly
      txHash = await walletClient.sendTransaction({
        chain: polygon,
        to: innerTo as Hex,
        data: innerData,
        value: 0n,
      });
    }

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    const success = receipt.status === 'success';

    return { success, txHash, error: success ? null : 'Transaction reverted', winningSide };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, txHash: null, error: msg, winningSide: null };
  }
}

/**
 * Merge equal YES + NO positions back into USDC via relayer.
 * Used for MM round trips to recover capital immediately.
 */
export async function mergePositions(
  profile: RedeemProfile,
  conditionId: string,
  negRisk: boolean,
  yesTokenId: string,
  noTokenId: string,
): Promise<OnChainRedeemResult> {
  try {
    const ownerAddress = profile.funderAddress || new Wallet(profile.privateKey).address;

    // Read balances (RPC)
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, getProvider());
    const [yesBal, noBal]: [BigNumber, BigNumber] = await Promise.all([
      ctf.balanceOf(ownerAddress, yesTokenId),
      ctf.balanceOf(ownerAddress, noTokenId),
    ]);

    const mergeAmount = yesBal.lt(noBal) ? yesBal : noBal;
    if (mergeAmount.isZero()) {
      return { success: true, txHash: null, error: null, winningSide: null };
    }

    // Build calldata
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

    // Submit via relayer
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
