import type { Order, OrderStatus } from '../src/lib/order';

export interface AuditReport {
  total: number;
  byStatus: Record<OrderStatus, number>;
  /** Idempotency keys that map to more than one stored order. Must be empty. */
  duplicateKeys: string[];
  /** Orders whose history shows a transition applied twice, an illegal sequence, or a version that disagrees. */
  anomalies: { orderId: string; problem: string }[];
}

const VALID_PREFIXES: OrderStatus[][] = [
  ['PENDING'],
  ['PENDING', 'PROCESSING'],
  ['PENDING', 'PROCESSING', 'CONFIRMED'],
  ['PENDING', 'PROCESSING', 'FAILED'],
];

/** Pure, so the same checks run in the audit script, the integration test, and unit tests. */
export function auditOrders(orders: Order[]): AuditReport {
  const byStatus: Record<OrderStatus, number> = { PENDING: 0, PROCESSING: 0, CONFIRMED: 0, FAILED: 0 };
  const keyCounts = new Map<string, number>();
  const anomalies: AuditReport['anomalies'] = [];

  for (const o of orders) {
    byStatus[o.status]++;
    keyCounts.set(o.idempotencyKey, (keyCounts.get(o.idempotencyKey) ?? 0) + 1);

    const seq = (o.history ?? []).map((h) => h.status);
    if (!VALID_PREFIXES.some((p) => p.length === seq.length && p.every((s, i) => s === seq[i]))) {
      anomalies.push({ orderId: o.orderId, problem: `illegal history ${seq.join(' -> ')}` });
    } else if (seq[seq.length - 1] !== o.status) {
      anomalies.push({ orderId: o.orderId, problem: `status ${o.status} disagrees with history` });
    }
    if (o.version !== seq.length - 1) {
      anomalies.push({ orderId: o.orderId, problem: `version ${o.version} but ${seq.length} history entries` });
    }
  }

  return {
    total: orders.length,
    byStatus,
    duplicateKeys: [...keyCounts].filter(([, n]) => n > 1).map(([k]) => k),
    anomalies,
  };
}
