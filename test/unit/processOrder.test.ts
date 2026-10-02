import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../../src/handlers/processOrder';
import type { Order } from '../../src/lib/order';
import { DynamoDBDocumentClient, FakeOrdersTable, makeOrder, setTestEnv, sqsRecord } from './helpers';

const ddbMock = mockClient(DynamoDBDocumentClient);
const event = (...records: SQSRecord[]): SQSEvent => ({ Records: records });

describe('processOrder', () => {
  let table: FakeOrdersTable;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const seed = (overrides: Partial<Order> = {}): Order => {
    const order = makeOrder(overrides);
    table.items.set(order.pk, structuredClone(order));
    return order;
  };
  const stored = (order: Order) => table.items.get(order.pk)!;
  const emfTotal = (name: string) =>
    logSpy.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .filter((d: Record<string, unknown>) => d._aws !== undefined && d[name] !== undefined)
      .reduce((sum: number, d: Record<string, unknown>) => sum + [d[name]].flat().length, 0);

  beforeEach(() => {
    setTestEnv();
    ddbMock.reset();
    table = new FakeOrdersTable();
    table.install(ddbMock);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('moves PENDING -> PROCESSING -> CONFIRMED with version-conditional writes', async () => {
    const order = seed();

    const res = await handler(event(sqsRecord(order.orderId)));

    expect(res.batchItemFailures).toEqual([]);
    expect(stored(order)).toMatchObject({ status: 'CONFIRMED', version: 2 });
    expect(stored(order).history.map((h) => h.status)).toEqual(['PENDING', 'PROCESSING', 'CONFIRMED']);

    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates).toHaveLength(2);
    expect(updates[0].ConditionExpression).toContain('version = :expected');
    expect(updates[0].ExpressionAttributeValues).toMatchObject({ ':from': 'PENDING', ':to': 'PROCESSING', ':expected': 0, ':next': 1 });
    expect(updates[1].ExpressionAttributeValues).toMatchObject({ ':from': 'PROCESSING', ':to': 'CONFIRMED', ':expected': 1, ':next': 2 });
    expect(emfTotal('OrdersConfirmed')).toBe(1);
    expect(emfTotal('ProcessingLatencyMs')).toBe(1);
  });

  it('marks the order FAILED with a reason when inventory is out of stock', async () => {
    const order = seed({ items: [{ sku: 'OOS-LAMP', quantity: 1, unitPriceCents: 100 }] });

    const res = await handler(event(sqsRecord(order.orderId)));

    expect(res.batchItemFailures).toEqual([]);
    expect(stored(order)).toMatchObject({ status: 'FAILED', failureReason: 'OUT_OF_STOCK:OOS-LAMP', version: 2 });
    expect(emfTotal('OrdersFailed')).toBe(1);
  });

  it('reports a transient failure as a batch item failure and leaves the order resumable', async () => {
    setTestEnv({ TRANSIENT_FAILURE_RATE: '1' });
    const order = seed();

    const res = await handler(event(sqsRecord(order.orderId, { messageId: 'm-1' })));

    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm-1' }]);
    expect(stored(order)).toMatchObject({ status: 'PROCESSING', version: 1 });

    // Redelivery after the transient issue clears resumes from PROCESSING.
    setTestEnv({ TRANSIENT_FAILURE_RATE: '0' });
    const retry = await handler(event(sqsRecord(order.orderId, { messageId: 'm-1', receiveCount: 2 })));
    expect(retry.batchItemFailures).toEqual([]);
    expect(stored(order)).toMatchObject({ status: 'CONFIRMED', version: 2 });
    expect(stored(order).history.map((h) => h.status)).toEqual(['PENDING', 'PROCESSING', 'CONFIRMED']);
  });

  it('only fails the records that failed, not the whole batch', async () => {
    const good = seed({ orderId: 'ord_aaaaaaaaaaaaaaaaaaaaaaaa' });
    const res = await handler(
      event(sqsRecord(good.orderId, { messageId: 'good' }), sqsRecord('x', { messageId: 'poison', body: 'not json' })),
    );
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'poison' }]);
    expect(stored(good).status).toBe('CONFIRMED');
  });

  it('treats a redelivered message for a terminal order as a no-op', async () => {
    const order = seed({ status: 'CONFIRMED', version: 2 });
    const res = await handler(event(sqsRecord(order.orderId)));
    expect(res.batchItemFailures).toEqual([]);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(stored(order).version).toBe(2);
  });

  it('applies each transition exactly once when the same message is delivered concurrently', async () => {
    const order = seed();
    const copies = Array.from({ length: 5 }, (_, i) => sqsRecord(order.orderId, { messageId: `dup-${i}` }));

    const res = await Promise.all([handler(event(...copies.slice(0, 3))), handler(event(...copies.slice(3)))]);

    expect(res.flatMap((r) => r.batchItemFailures)).toEqual([]);
    const final = stored(order);
    expect(final.status).toBe('CONFIRMED');
    expect(final.version).toBe(2);
    expect(final.history.map((h) => h.status)).toEqual(['PENDING', 'PROCESSING', 'CONFIRMED']);
    expect(emfTotal('OrdersConfirmed')).toBe(1);
  });

  it('acknowledges (does not retry) a message for an order that does not exist', async () => {
    const res = await handler(event(sqsRecord('ord_bbbbbbbbbbbbbbbbbbbbbbbb')));
    expect(res.batchItemFailures).toEqual([]);
  });

  it('retries a message with a malformed order ID so it eventually lands in the DLQ', async () => {
    const res = await handler(event(sqsRecord('not-an-order-id', { messageId: 'bad' })));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }]);
  });
});
