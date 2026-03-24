/**
 * UMA OptimisticOracleV2 — ProposePrice Event Listener
 *
 * Listens for ProposePrice events on the UMA oracle contracts.
 * When a proposal is submitted for a Polymarket condition, we know
 * the proposed outcome up to 2 hours before CTF settles.
 *
 * Contracts monitored (Polygon mainnet):
 *   - OptimisticOracleV2:        0xee3afe347d5c74317041e2618c49534daf887c24
 *   - ManagedOptimisticOracleV2:  0x2C0367a9DB231dDeBd88a94b4f6461a6e47C58B1
 */

import 'server-only';

import { createPublicClient, http, parseAbiItem, type Log } from 'viem';
import { polygon } from 'viem/chains';
import { POLYGON_RPCS } from '@/lib/polygon/rpc';

// ─── Contract Addresses (Polygon) ───────────────────────

const OOV2_ADDRESS = '0xee3afe347d5c74317041e2618c49534daf887c24' as const;
const MOOV2_ADDRESS = '0x2C0367a9DB231dDeBd88a94b4f6461a6e47C58B1' as const;

// ─── Event ABI ──────────────────────────────────────────

const PROPOSE_PRICE_EVENT = parseAbiItem(
  'event ProposePrice(address indexed requester, address indexed proposer, bytes32 identifier, uint256 timestamp, bytes ancillaryData, int256 proposedPrice, uint256 expirationTimestamp, address currency)',
);

// ─── Types ──────────────────────────────────────────────

export interface UmaProposal {
  /** The requester contract (usually UmaCtfAdapter) */
  requester: string;
  /** Who proposed */
  proposer: string;
  /** YES_OR_NO_QUERY identifier */
  identifier: string;
  /** Request timestamp */
  timestamp: bigint;
  /** Ancillary data (contains market question) */
  ancillaryData: string;
  /** Proposed price: 1e18 = YES (1.0), 0 = NO */
  proposedPrice: bigint;
  /** When the challenge period expires */
  expirationTimestamp: bigint;
  /** Proposed outcome */
  proposedOutcome: 'YES' | 'NO' | 'UNKNOWN';
  /** Block number */
  blockNumber: bigint;
  /** Transaction hash */
  txHash: string;
}

export type ProposalHandler = (proposal: UmaProposal) => void;

// ─── Listener ───────────────────────────────────────────

export class UmaProposalListener {
  private client: ReturnType<typeof createPublicClient> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastBlock: bigint = 0n;
  private onProposal: ProposalHandler | null = null;
  private logFn: (type: string, text: string) => void;

  /** Known Polymarket adapter addresses (requester field in events) */
  private static POLY_ADAPTERS = new Set([
    '0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74'.toLowerCase(), // UmaCtfAdapter 2
    '0x2F5e3684cb1F318ec51b00Edba38d79Ac2c0aA9d'.toLowerCase(), // UmaCtfAdapter V3
    '0x157Ce2d672854c848c9b79C49a8Cc6cc89176a49'.toLowerCase(), // UMA CTF Adapter v3.0
    '0xCB1822859cEF82Cd2Eb4E6276C7916e692995130'.toLowerCase(), // Uma Conditional Tokens Binary Adapter
  ]);

  constructor(logFn: (type: string, text: string) => void) {
    this.logFn = logFn;
  }

  async start(onProposal: ProposalHandler): Promise<void> {
    this.onProposal = onProposal;

    // Use the first available RPC with WebSocket support fallback to HTTP polling
    const rpcUrl = POLYGON_RPCS[0];
    this.client = createPublicClient({
      chain: polygon,
      transport: http(rpcUrl),
    });

    // Get current block as starting point
    try {
      this.lastBlock = await this.client.getBlockNumber();
      this.logFn('watch', `UMA listener started from block ${this.lastBlock}`);
    } catch (err) {
      this.logFn('error', `UMA listener failed to get block: ${err instanceof Error ? err.message : err}`);
      return;
    }

    // Poll for new ProposePrice events every 5 seconds
    this.pollTimer = setInterval(() => this.pollEvents(), 5_000);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.client = null;
  }

  private async pollEvents(): Promise<void> {
    if (!this.client || !this.onProposal) return;

    try {
      const currentBlock = await this.client.getBlockNumber();
      if (currentBlock <= this.lastBlock) return;

      // Fetch ProposePrice logs from both oracle contracts
      const logs = await this.client.getLogs({
        address: [OOV2_ADDRESS, MOOV2_ADDRESS],
        event: PROPOSE_PRICE_EVENT,
        fromBlock: this.lastBlock + 1n,
        toBlock: currentBlock,
      });

      this.lastBlock = currentBlock;

      for (const log of logs) {
        const proposal = this.parseProposal(log);
        if (!proposal) continue;

        // Only care about Polymarket-related proposals
        if (!UmaProposalListener.POLY_ADAPTERS.has(proposal.requester.toLowerCase())) {
          continue;
        }

        this.logFn(
          'watch',
          `UMA PROPOSAL: ${proposal.proposedOutcome} by ${proposal.proposer.slice(0, 10)}... | expires ${new Date(Number(proposal.expirationTimestamp) * 1000).toLocaleTimeString()}`,
        );

        this.onProposal(proposal);
      }
    } catch (err) {
      // Silently handle RPC errors — will retry next poll
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('rate') && !msg.includes('429')) {
        this.logFn('error', `UMA poll error: ${msg.slice(0, 100)}`);
      }
    }
  }

  private parseProposal(log: Log<bigint, number, false, typeof PROPOSE_PRICE_EVENT>): UmaProposal | null {
    try {
      const args = log.args;
      if (!args.requester || !args.proposer || !args.proposedPrice === undefined) return null;

      // Proposed price: 1e18 = YES, 0 = NO, 0.5e18 = unknown/early
      let proposedOutcome: 'YES' | 'NO' | 'UNKNOWN' = 'UNKNOWN';
      const price = args.proposedPrice!;
      if (price === 1000000000000000000n) {
        proposedOutcome = 'YES';
      } else if (price === 0n) {
        proposedOutcome = 'NO';
      }

      return {
        requester: args.requester,
        proposer: args.proposer,
        identifier: args.identifier ?? '',
        timestamp: args.timestamp ?? 0n,
        ancillaryData: args.ancillaryData ?? '',
        proposedPrice: price,
        expirationTimestamp: args.expirationTimestamp ?? 0n,
        proposedOutcome,
        blockNumber: log.blockNumber ?? 0n,
        txHash: log.transactionHash ?? '',
      };
    } catch {
      return null;
    }
  }
}
