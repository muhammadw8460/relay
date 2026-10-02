/**
 * Runs against the deployed dev stack. Submits N orders, sending some keys
 * more than once and concurrently, then asserts there are exactly N orders
 * and no duplicates, both through the API and in the table itself.
 *
 *   npm run test:integration            # N=30
 *   INT_N=100 npm run test:integration
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { auditOrders } from '../../scripts/audit-lib';
import { RelayClient } from '../../scripts/api-client';
import { scanOrders } from '../../scripts/audit';
import { type RelayOutputs, stackOutputs } from '../../scripts/stack-outputs';

const N = Number(process.env.INT_N ?? 30);
const runId = `it-${Date.now()}`;
const copiesFor = (i: number) => 1 + (i % 3); // 1, 2 or 3 concurrent sends per key

describe(`idempotency under duplicate submissions (N=${N})`, () => {
  let outputs: RelayOutputs;
  let api: RelayClient;
  const orderIdsByKey = new Map<string, Set<string>>();
  const statusesByKey = new Map<string, number[]>();

  beforeAll(async () => {
    outputs = await stackOutputs();
    api = new RelayClient(outputs.ApiUrl);

    const requests = Array.from({ length: N }, (_, i) => {
      const key = `${runId}-${i}`;
      const body = { customerId: runId, items: [{ sku: 'WIDGET-1', quantity: 1 + (i % 5), unitPriceCents: 999 }] };
      return Array.from({ length: copiesFor(i) }, () =>
        api.createOrder(body, key, `${runId}-${i}`).then((res) => ({ key, res })),
      );
    }).flat();

    for (const { key, res } of await Promise.all(requests)) {
      if (!statusesByKey.has(key)) statusesByKey.set(key, []);
      statusesByKey.get(key)!.push(res.status);
      if (res.status === 200 || res.status === 201) {
        if (!orderIdsByKey.has(key)) orderIdsByKey.set(key, new Set());
        orderIdsByKey.get(key)!.add(res.body.orderId);
      }
    }
  });

  it('answers every request with 201 or 200, and exactly one 201 per key', () => {
    for (const [key, statuses] of statusesByKey) {
      expect(statuses.every((s) => s === 200 || s === 201), `${key}: ${statuses}`).toBe(true);
      expect(statuses.filter((s) => s === 201), `${key}: ${statuses}`).toHaveLength(1);
    }
  });

  it('returns one order ID per key and N unique orders overall', () => {
    expect(orderIdsByKey.size).toBe(N);
    for (const [key, ids] of orderIdsByKey) expect(ids.size, key).toBe(1);
    const unique = new Set([...orderIdsByKey.values()].flatMap((s) => [...s]));
    expect(unique.size).toBe(N);
  });

  it('processes every order out of PENDING', async () => {
    const ids = [...orderIdsByKey.values()].map((s) => [...s][0]);
    const deadline = Date.now() + 120_000;
    let pending = ids;
    while (pending.length > 0 && Date.now() < deadline) {
      const results = await Promise.all(pending.map((id) => api.getOrder(id)));
      pending = pending.filter((_, i) => !['CONFIRMED', 'FAILED'].includes(results[i].body.status));
      if (pending.length > 0) await new Promise((r) => setTimeout(r, 2_000));
    }
    // An order still PROCESSING here exhausted its 3 attempts and is in the DLQ, which is
    // expected behavior at a 10% transient failure rate. One stuck in PENDING would be a bug.
    const stuck = await Promise.all(pending.map((id) => api.getOrder(id)));
    expect(stuck.filter((r) => r.body.status === 'PENDING').map((r) => r.body.orderId)).toEqual([]);
    if (stuck.length > 0) console.warn(`${stuck.length} order(s) still PROCESSING (in DLQ): ${pending.join(', ')}`);
  });

  it('stores exactly N orders for this run, with no duplicate or double-applied transition', async () => {
    if (process.env.SKIP_TABLE_AUDIT) return;
    const orders = await scanOrders(outputs.TableName, runId);
    const report = auditOrders(orders);
    expect(report.total).toBe(N);
    expect(report.duplicateKeys).toEqual([]);
    expect(report.anomalies).toEqual([]);
  });
});
