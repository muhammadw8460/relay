import { createHash } from 'node:crypto';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * The order ID is derived from the Idempotency-Key, so every retry of the same
 * request targets the same DynamoDB item. That is what lets a single
 * `attribute_not_exists(pk)` conditional put act as the duplicate check,
 * without a separate idempotency table or a transaction.
 */
export function orderIdFromKey(idempotencyKey: string): string {
  return `ord_${sha256(`relay:idempotency:${idempotencyKey}`).slice(0, 24)}`;
}

/** Hash of the validated body. zod emits keys in schema order, so this is stable. */
export function requestHash(body: unknown): string {
  return sha256(JSON.stringify(body));
}
