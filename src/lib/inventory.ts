import { config } from './config';
import type { Order } from './order';

/** A retryable failure (timeout, throttling). The message goes back to the queue. */
export class TransientInventoryError extends Error {
  constructor(message = 'Inventory service temporarily unavailable') {
    super(message);
    this.name = 'TransientInventoryError';
  }
}

export type ReservationResult = { ok: true } | { ok: false; reason: string };

/** SKUs with this prefix are always out of stock, for deterministic tests. */
export const OUT_OF_STOCK_PREFIX = 'OOS-';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Simulated downstream inventory reservation. It fails on purpose:
 * - with probability TRANSIENT_FAILURE_RATE it throws (exercises SQS retries and the DLQ)
 * - with probability OUT_OF_STOCK_RATE, or for an OOS- SKU, it returns a
 *   business failure (order ends FAILED, no retry)
 *
 * A real reservation call would pass `order.orderId` as its own idempotency
 * key, because concurrent duplicate deliveries can both reach this point.
 */
export async function reserveInventory(order: Order, random: () => number = Math.random): Promise<ReservationResult> {
  const workMs = config.simulatedWorkMs();
  if (workMs > 0) await sleep(workMs);

  if (random() < config.transientFailureRate()) throw new TransientInventoryError();

  const oos = order.items.find((i) => i.sku.startsWith(OUT_OF_STOCK_PREFIX));
  if (oos) return { ok: false, reason: `OUT_OF_STOCK:${oos.sku}` };
  if (random() < config.outOfStockRate()) return { ok: false, reason: 'OUT_OF_STOCK' };

  return { ok: true };
}
