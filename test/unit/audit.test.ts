import { describe, expect, it } from 'vitest';
import { auditOrders } from '../../scripts/audit-lib';
import { makeOrder } from './helpers';

const at = '2026-01-01T00:00:00.000Z';

describe('auditOrders', () => {
  it('passes clean orders in every state', () => {
    const report = auditOrders([
      makeOrder({ orderId: 'a', idempotencyKey: 'k1' }),
      makeOrder({ orderId: 'b', idempotencyKey: 'k2', status: 'PROCESSING', version: 1, history: [{ status: 'PENDING', at }, { status: 'PROCESSING', at }] }),
      makeOrder({
        orderId: 'c',
        idempotencyKey: 'k3',
        status: 'CONFIRMED',
        version: 2,
        history: [{ status: 'PENDING', at }, { status: 'PROCESSING', at }, { status: 'CONFIRMED', at }],
      }),
    ]);
    expect(report).toMatchObject({ total: 3, duplicateKeys: [], anomalies: [] });
    expect(report.byStatus).toEqual({ PENDING: 1, PROCESSING: 1, CONFIRMED: 1, FAILED: 0 });
  });

  it('flags a transition applied twice', () => {
    const report = auditOrders([
      makeOrder({
        status: 'CONFIRMED',
        version: 3,
        history: [{ status: 'PENDING', at }, { status: 'PROCESSING', at }, { status: 'CONFIRMED', at }, { status: 'CONFIRMED', at }],
      }),
    ]);
    expect(report.anomalies[0].problem).toMatch(/illegal history/);
  });

  it('flags a version that disagrees with history, and duplicate keys', () => {
    const report = auditOrders([
      makeOrder({ orderId: 'a', idempotencyKey: 'same', version: 5 }),
      makeOrder({ orderId: 'b', idempotencyKey: 'same' }),
    ]);
    expect(report.duplicateKeys).toEqual(['same']);
    expect(report.anomalies).toEqual([{ orderId: 'a', problem: 'version 5 but 1 history entries' }]);
  });
});
