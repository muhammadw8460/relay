import { describe, expect, it } from 'vitest';
import { orderIdFromKey, requestHash } from '../../src/lib/ids';
import { CreateOrderSchema, IdempotencyKeySchema, OrderIdSchema } from '../../src/lib/schema';
import { validBody } from './helpers';

describe('CreateOrderSchema', () => {
  it('accepts a valid order and defaults currency to USD', () => {
    const { currency: _currency, ...withoutCurrency } = validBody;
    const result = CreateOrderSchema.safeParse(withoutCurrency);
    expect(result.success).toBe(true);
    expect(result.data?.currency).toBe('USD');
  });

  it.each([
    ['missing customerId', { items: validBody.items }],
    ['empty items', { ...validBody, items: [] }],
    ['zero quantity', { ...validBody, items: [{ sku: 'A', quantity: 0, unitPriceCents: 1 }] }],
    ['fractional quantity', { ...validBody, items: [{ sku: 'A', quantity: 1.5, unitPriceCents: 1 }] }],
    ['negative price', { ...validBody, items: [{ sku: 'A', quantity: 1, unitPriceCents: -1 }] }],
    ['price as string', { ...validBody, items: [{ sku: 'A', quantity: 1, unitPriceCents: '100' }] }],
    ['bad sku characters', { ...validBody, items: [{ sku: 'A B', quantity: 1, unitPriceCents: 1 }] }],
    ['unsupported currency', { ...validBody, currency: 'BTC' }],
    ['unknown top-level field', { ...validBody, status: 'CONFIRMED' }],
    ['unknown item field', { ...validBody, items: [{ sku: 'A', quantity: 1, unitPriceCents: 1, discount: 5 }] }],
    ['too many items', { ...validBody, items: Array.from({ length: 51 }, () => ({ sku: 'A', quantity: 1, unitPriceCents: 1 })) }],
  ])('rejects %s', (_name, body) => {
    expect(CreateOrderSchema.safeParse(body).success).toBe(false);
  });
});

describe('IdempotencyKeySchema', () => {
  it('accepts UUIDs and similar tokens', () => {
    expect(IdempotencyKeySchema.safeParse('3f1c2a9e-8b7d-4c6e-9f0a-1b2c3d4e5f60').success).toBe(true);
    expect(IdempotencyKeySchema.safeParse('client:order.42_retry').success).toBe(true);
  });

  it.each([undefined, '', 'short', 'x'.repeat(129), 'has spaces here', 'semi;colon'])('rejects %j', (key) => {
    expect(IdempotencyKeySchema.safeParse(key).success).toBe(false);
  });
});

describe('ids', () => {
  it('derives a stable, well-formed order ID from the idempotency key', () => {
    const a = orderIdFromKey('key-12345678');
    expect(a).toBe(orderIdFromKey('key-12345678'));
    expect(a).not.toBe(orderIdFromKey('key-12345679'));
    expect(OrderIdSchema.safeParse(a).success).toBe(true);
  });

  it('hashes equal bodies equally and different bodies differently', () => {
    const parsed = CreateOrderSchema.parse(validBody);
    expect(requestHash(parsed)).toBe(requestHash(CreateOrderSchema.parse({ ...validBody })));
    expect(requestHash(parsed)).not.toBe(requestHash(CreateOrderSchema.parse({ ...validBody, customerId: 'other' })));
  });

  it('is insensitive to key order in the incoming JSON', () => {
    const reordered = { items: validBody.items, currency: 'USD', customerId: 'cust-1' };
    expect(requestHash(CreateOrderSchema.parse(reordered))).toBe(requestHash(CreateOrderSchema.parse(validBody)));
  });
});
