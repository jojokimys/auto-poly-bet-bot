import 'server-only';

import { Contract } from '@ethersproject/contracts';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Wallet } from '@ethersproject/wallet';
import { BigNumber } from '@ethersproject/bignumber';

const POLYGON_RPC = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

// Polymarket contract addresses (Polygon mainnet)
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const ZERO_BYTES32 = '0x' + '00'.repeat(32);

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
];

const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] amounts) public',
  'function mergePositions(bytes32 conditionId, uint256 amount) public',
];

export interface OnChainRedeemResult {
  success: boolean;
  txHash: string | null;
  error: string | null;
}

let providerCache: JsonRpcProvider | null = null;

function getProvider(): JsonRpcProvider {
  if (!providerCache) {
    providerCache = new JsonRpcProvider(POLYGON_RPC);
  }
  return providerCache;
}

/** Check if a condition has been resolved on-chain */
export async function isConditionResolved(conditionId: string): Promise<boolean> {
  const ctf = new Contract(CTF_ADDRESS, CTF_ABI, getProvider());
  const denom: BigNumber = await ctf.payoutDenominator(conditionId);
  return denom.gt(0);
}

/** Get ERC-1155 token balance on the CTF contract */
export async function getTokenBalance(owner: string, tokenId: string): Promise<BigNumber> {
  const ctf = new Contract(CTF_ADDRESS, CTF_ABI, getProvider());
  return ctf.balanceOf(owner, tokenId);
}

/**
 * Redeem resolved positions via on-chain contract call.
 * - Standard CTF: burns winning tokens → returns USDC
 * - NegRisk: passes explicit amounts for YES/NO tokens
 */
export async function redeemPositions(
  privateKey: string,
  conditionId: string,
  negRisk: boolean,
  yesTokenId: string,
  noTokenId: string,
): Promise<OnChainRedeemResult> {
  try {
    const wallet = new Wallet(privateKey, getProvider());

    // Check balances first
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, getProvider());
    const [yesBal, noBal]: [BigNumber, BigNumber] = await Promise.all([
      ctf.balanceOf(wallet.address, yesTokenId),
      ctf.balanceOf(wallet.address, noTokenId),
    ]);

    if (yesBal.isZero() && noBal.isZero()) {
      return { success: true, txHash: null, error: null }; // nothing to redeem
    }

    let tx;
    if (negRisk) {
      const adapter = new Contract(NEG_RISK_ADAPTER, NEG_RISK_ABI, wallet);
      tx = await adapter.redeemPositions(conditionId, [yesBal, noBal]);
    } else {
      const ctfWriter = new Contract(CTF_ADDRESS, CTF_ABI, wallet);
      tx = await ctfWriter.redeemPositions(USDC_E_ADDRESS, ZERO_BYTES32, conditionId, [1, 2]);
    }

    const receipt = await tx.wait();
    return { success: receipt.status === 1, txHash: receipt.transactionHash, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, txHash: null, error: msg };
  }
}

/**
 * Merge equal YES + NO positions back into USDC (no resolution needed).
 * Used for MM round trips to recover capital immediately.
 */
export async function mergePositions(
  privateKey: string,
  conditionId: string,
  negRisk: boolean,
  yesTokenId: string,
  noTokenId: string,
): Promise<OnChainRedeemResult> {
  try {
    const wallet = new Wallet(privateKey, getProvider());

    // Find merge-able amount = min(yesBal, noBal)
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, getProvider());
    const [yesBal, noBal]: [BigNumber, BigNumber] = await Promise.all([
      ctf.balanceOf(wallet.address, yesTokenId),
      ctf.balanceOf(wallet.address, noTokenId),
    ]);

    const mergeAmount = yesBal.lt(noBal) ? yesBal : noBal;
    if (mergeAmount.isZero()) {
      return { success: true, txHash: null, error: null };
    }

    let tx;
    if (negRisk) {
      const adapter = new Contract(NEG_RISK_ADAPTER, NEG_RISK_ABI, wallet);
      tx = await adapter.mergePositions(conditionId, mergeAmount);
    } else {
      const ctfWriter = new Contract(CTF_ADDRESS, CTF_ABI, wallet);
      tx = await ctfWriter.mergePositions(USDC_E_ADDRESS, ZERO_BYTES32, conditionId, [1, 2], mergeAmount);
    }

    const receipt = await tx.wait();
    return { success: receipt.status === 1, txHash: receipt.transactionHash, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, txHash: null, error: msg };
  }
}
