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

export interface BundleResult {
  included: boolean;
  blockNumber: number;
  txHashes: string[];
}

export class BundleSubmitter {
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
    provider: JsonRpcProvider
  ): Promise<BundleResult> {
    const targetBlockHex = "0x" + targetBlock.toString(16);

    // Derive tx hashes from signed raw txs
    const txHashes = signedRawTxs.map((raw) => Transaction.from(raw).hash!);

    console.log(
      `[Bundle] Submitting ${signedRawTxs.length} txs targeting block ${targetBlock} ` +
      `(txs: ${txHashes.map(h => h.slice(0, 10)).join(", ")})`
    );

    // Send to all relays in parallel
    await this.sendToRelays(signedRawTxs, targetBlockHex);

    // Wait for the target block to be mined
    const included = await this.waitForInclusion(
      provider,
      targetBlock,
      txHashes[0]
    );

    if (included) {
      console.log(`[Bundle] Bundle included in block ${targetBlock}`);
    } else {
      console.log(`[Bundle] Bundle NOT included in block ${targetBlock}`);
    }

    return { included, blockNumber: targetBlock, txHashes };
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
          const json = await resp.json();
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
   * Wait for a specific block to be mined, then check if our tx was included.
   */
  private async waitForInclusion(
    provider: JsonRpcProvider,
    targetBlock: number,
    firstTxHash: string
  ): Promise<boolean> {
    // Wait up to ~24 seconds (2 Ethereum slots)
    const maxWaitMs = 24_000;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      const current = await provider.getBlockNumber();
      if (current >= targetBlock) {
        try {
          const receipt = await provider.getTransactionReceipt(firstTxHash);
          return receipt !== null && receipt.blockNumber <= targetBlock;
        } catch {
          return false;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    return false;
  }
}
