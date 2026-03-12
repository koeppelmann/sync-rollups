/**
 * Mock bundle submitter for Anvil (local development).
 *
 * Implements the same interface as BundleSubmitter but uses Anvil's
 * automine control to ensure all txs land in the same block.
 *
 * Flow:
 *   1. Disable automine
 *   2. Broadcast all signed raw txs to the mempool
 *   3. Set the next block timestamp (if provided)
 *   4. Mine one block (all txs land together)
 *   5. Re-enable automine
 */

import { JsonRpcProvider, Transaction } from "ethers";
import { BundleResult, IL1BundleSubmitter } from "./bundle-submitter.js";

export class MockBundleSubmitter implements IL1BundleSubmitter {
  private provider: JsonRpcProvider;

  constructor(provider: JsonRpcProvider) {
    this.provider = provider;
  }

  /**
   * Submit a bundle of signed raw transactions.
   *
   * All txs are broadcast to Anvil's mempool with automine disabled,
   * then mined in a single block. The targetBlock parameter is ignored
   * (Anvil mines on demand).
   *
   * @param signedRawTxs  Array of "0x…" serialized signed transactions
   * @param targetBlock   Ignored (present for interface compatibility)
   * @param provider      Ignored (uses the provider from constructor)
   * @param timestamp     Optional: force the mined block's timestamp
   */
  async submitAndWait(
    signedRawTxs: string[],
    targetBlock: number,
    provider: JsonRpcProvider,
    timestamp?: number
  ): Promise<BundleResult> {
    const txHashes = signedRawTxs.map((raw) => Transaction.from(raw).hash!);

    console.log(
      `[MockBundle] Submitting ${signedRawTxs.length} txs ` +
      `(${txHashes.map((h) => h.slice(0, 10)).join(", ")})` +
      (timestamp ? ` timestamp=${timestamp}` : "")
    );

    await this.provider.send("evm_setAutomine", [false]);
    try {
      // Broadcast all txs to mempool
      for (const rawTx of signedRawTxs) {
        await this.provider.send("eth_sendRawTransaction", [rawTx]);
      }

      // Set block timestamp if requested
      if (timestamp !== undefined) {
        await this.provider.send("evm_setNextBlockTimestamp", [timestamp]);
      }

      // Mine one block with all txs
      await this.provider.send("evm_mine", []);
    } finally {
      await this.provider.send("evm_setAutomine", [true]);
    }

    // Verify inclusion (use raw RPC to avoid ethers caching)
    const blockNumberHex = await this.provider.send("eth_blockNumber", []);
    const blockNumber = Number(blockNumberHex);
    const blockData = await this.provider.send("eth_getBlockByNumber", [blockNumberHex, false]);
    const blockTxCount = blockData?.transactions?.length ?? 0;

    if (blockTxCount < signedRawTxs.length) {
      console.warn(
        `[MockBundle] WARNING: expected ${signedRawTxs.length} txs in block ${blockNumber}, ` +
        `got ${blockTxCount}`
      );
    }

    const blockTimestamp = blockData ? Number(blockData.timestamp) : 0;
    console.log(
      `[MockBundle] ${blockTxCount} txs mined in block ${blockNumber}` +
      (blockData ? ` (timestamp=${blockTimestamp})` : "")
    );

    return {
      included: blockTxCount >= signedRawTxs.length,
      blockNumber,
      txHashes,
    };
  }
}
