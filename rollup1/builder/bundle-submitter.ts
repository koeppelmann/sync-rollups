/**
 * Flashbots/Titan/etc. bundle submission for Ethereum mainnet.
 *
 * Submits a set of signed raw transactions as an atomic bundle targeting
 * exactly one block. All txs land in the same block in order, or none land.
 *
 * No extra npm dependencies — uses native fetch + ethers Wallet signing.
 */

import { JsonRpcProvider, Wallet, keccak256, toUtf8Bytes, Transaction } from "ethers";

export interface BundleRelayConfig {
  name: string;
  url: string;
}

/** Default relays for Ethereum mainnet. */
export const DEFAULT_RELAYS: BundleRelayConfig[] = [
  { name: "Flashbots", url: "https://relay.flashbots.net" },
  { name: "Titan", url: "https://rpc.titanbuilder.xyz" },
  { name: "Beaver", url: "https://rpc.beaverbuild.org" },
  { name: "rsync", url: "https://rsync-builder.xyz" },
];

/** Relays for Sepolia testnet. */
export const SEPOLIA_RELAYS: BundleRelayConfig[] = [
  { name: "Flashbots Sepolia", url: "https://relay-sepolia.flashbots.net" },
];

/** Relays for Gnosis Chiado testnet. */
export const CHIADO_RELAYS: BundleRelayConfig[] = [
  { name: "Chiado Builder", url: "https://builder.chiado.gcd.ovh" },
];

export interface BundleResult {
  included: boolean;
  blockNumber: number;
  txHashes: string[];
}

/**
 * Common interface for L1 bundle submission.
 * Implementations: BundleSubmitter (Flashbots/Titan/etc.), MockBundleSubmitter (Anvil).
 */
export interface IL1BundleSubmitter {
  submitAndWait(
    signedRawTxs: string[],
    targetBlock: number,
    provider: JsonRpcProvider,
    timestamp?: number
  ): Promise<BundleResult>;
}

export class BundleSubmitter implements IL1BundleSubmitter {
  private relays: BundleRelayConfig[];
  /** Auth signer — any key works; used for Flashbots rate-limit identity. */
  private authWallet: Wallet;

  constructor(
    authWallet: Wallet,
    relays?: BundleRelayConfig[],
  ) {
    this.authWallet = authWallet;
    this.relays = relays ?? DEFAULT_RELAYS;
  }

  /**
   * Submit a bundle targeting exactly one block and wait for that block.
   *
   * @param signedRawTxs    Array of "0x…" serialized signed transactions
   * @param targetBlock     The block number the bundle targets
   * @param provider        L1 JSON-RPC provider (for polling)
   * @returns               Whether the bundle was included, and tx hashes
   */
  async submitAndWait(
    signedRawTxs: string[],
    targetBlock: number,
    provider: JsonRpcProvider,
    timestamp?: number   // ignored — real chains control timestamps via slot timing
  ): Promise<BundleResult> {
    // Derive tx hashes from signed raw txs
    const txHashes = signedRawTxs.map((raw) => Transaction.from(raw).hash!);

    // Submit bundle targeting multiple consecutive blocks for better inclusion.
    const MAX_BLOCKS_AHEAD = 3;
    const tRelay = Date.now();
    for (let offset = 0; offset < MAX_BLOCKS_AHEAD; offset++) {
      const block = targetBlock + offset;
      const blockHex = "0x" + block.toString(16);
      console.log(
        `[Bundle] Submitting ${signedRawTxs.length} txs targeting block ${block} ` +
        `(txs: ${txHashes.map(h => h.slice(0, 10)).join(", ")})`
      );
      await this.sendToRelays(signedRawTxs, blockHex);
    }
    console.log(`[Bundle] Relay submissions took ${Date.now() - tRelay}ms`);

    // Wait for inclusion in any of the target blocks
    const lastTargetBlock = targetBlock + MAX_BLOCKS_AHEAD - 1;
    const tWait = Date.now();
    const included = await this.waitForInclusion(
      provider,
      lastTargetBlock,
      txHashes[0]
    );
    console.log(`[Bundle] Wait for inclusion took ${Date.now() - tWait}ms`);

    // Find the actual block if included
    let actualBlock = targetBlock;
    if (included) {
      try {
        const receipt = await provider.getTransactionReceipt(txHashes[0]);
        if (receipt) actualBlock = receipt.blockNumber;
      } catch {}
      console.log(`[Bundle] Bundle included in block ${actualBlock}`);
    } else {
      console.log(`[Bundle] Bundle NOT included in blocks ${targetBlock}-${lastTargetBlock}`);
    }

    return { included, blockNumber: actualBlock, txHashes };
  }

  /**
   * Send eth_sendBundle to all configured relays in parallel.
   */
  private async sendToRelays(
    signedRawTxs: string[],
    targetBlockHex: string
  ): Promise<void> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendBundle",
      params: [
        {
          txs: signedRawTxs,
          blockNumber: targetBlockHex,
        },
      ],
    });

    // Flashbots auth: X-Flashbots-Signature = <address>:<sig>
    // where sig = wallet.signMessage(id + ":" + keccak256(body))
    // See: https://docs.flashbots.net/flashbots-auction/advanced/rpc-endpoint#authentication
    const bodyHash = keccak256(toUtf8Bytes(body));
    const signature = await this.authWallet.signMessage(bodyHash);
    const authHeader = `${await this.authWallet.getAddress()}:${signature}`;

    const results = await Promise.allSettled(
      this.relays.map(async (relay) => {
        try {
          const resp = await fetch(relay.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Flashbots-Signature": authHeader,
            },
            body,
            signal: AbortSignal.timeout(5000),
          });
          const text = await resp.text();
          let json: any;
          try {
            json = JSON.parse(text);
          } catch {
            console.warn(`[Bundle] ${relay.name}: non-JSON response (HTTP ${resp.status}): ${text.slice(0, 100)}`);
            throw new Error(`Non-JSON response from ${relay.name}: HTTP ${resp.status}`);
          }
          if (json.error) {
            console.warn(
              `[Bundle] ${relay.name}: error: ${JSON.stringify(json.error)}`
            );
          } else {
            console.log(`[Bundle] ${relay.name}: accepted`);
          }
          return json;
        } catch (e: any) {
          console.warn(`[Bundle] ${relay.name}: ${e.message}`);
          throw e;
        }
      })
    );

    const accepted = results.filter((r) => r.status === "fulfilled").length;
    if (accepted === 0) {
      console.warn("[Bundle] WARNING: No relays accepted the bundle");
    }
  }

  /**
   * Wait for the bundle to be included, checking after each new block.
   * Returns as soon as the tx receipt is found, without waiting for all target blocks.
   */
  private rpcUrl: string = "";

  private async uncachedGetBlockNumber(url: string): Promise<number> {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    const json = await resp.json() as { result: string };
    return parseInt(json.result, 16);
  }

  private async uncachedGetReceipt(url: string, txHash: string): Promise<{ blockNumber: number } | null> {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
      signal: AbortSignal.timeout(3000),
    });
    const json = await resp.json() as { result: any };
    if (!json.result) return null;
    return { blockNumber: parseInt(json.result.blockNumber, 16) };
  }

  private async waitForInclusion(
    provider: JsonRpcProvider,
    targetBlock: number,
    firstTxHash: string
  ): Promise<boolean> {
    const maxWaitMs = 24_000;
    const start = Date.now();
    let lastCheckedBlock = 0;
    const url = provider._getConnection().url;

    while (Date.now() - start < maxWaitMs) {
      let current: number;
      try {
        current = await this.uncachedGetBlockNumber(url);
      } catch {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      // Check receipt whenever we see a new block
      if (current > lastCheckedBlock) {
        lastCheckedBlock = current;
        try {
          const receipt = await this.uncachedGetReceipt(url, firstTxHash);
          if (receipt !== null) {
            console.log(`[Bundle] Tx found in block ${receipt.blockNumber} (checked at block ${current})`);
            return true;
          }
        } catch {}

        // If we've passed all target blocks, do one more receipt check then give up
        if (current > targetBlock) {
          // Small delay — receipt may not be immediately available after block
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const receipt = await this.uncachedGetReceipt(url, firstTxHash);
            if (receipt !== null) {
              console.log(`[Bundle] Tx found in block ${receipt.blockNumber} (late check at block ${current})`);
              return true;
            }
          } catch {}
          return false;
        }
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    return false;
  }
}
