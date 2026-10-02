import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../../src/handlers/createOrder';
import { orderIdFromKey } from '../../src/lib/ids';
import { DynamoDBDocumentClient, FakeOrdersTable, apiEvent, setTestEnv, validBody } from './helpers';

const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);

const KEY = 'test-key-0001';
const post = (body: unknown = validBody, headers: Record<string, string> = { 'idempotency-key': KEY }) =>
  handler(apiEvent({ body, headers }));
const bodyOf = (res: { body?: string }) => JSON.parse(res.body ?? '{}');

function emfDocs(logSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return logSpy.mock.calls
    .map(([line]) => JSON.parse(String(line)))
    .filter((doc: Record<string, unknown>) => doc._aws !== undefined);
}

describe('createOrder', () => {
  let table: FakeOrdersTable;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setTestEnv();
    ddbMock.reset();
    sqsMock.reset();
    table = new FakeOrdersTable();
    table.install(ddbMock);
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm-1' });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('creates a PENDING order, writes it conditionally, and enqueues it', async () => {
    const res = await post();

    expect(res.statusCode).toBe(201);
    const order = bodyOf(res);
    expect(order).toMatchObject({
      orderId: orderIdFromKey(KEY),
      status: 'PENDING',
      version: 0,
      customerId: 'cust-1',
      totalCents: 2 * 1250 + 499,
      idempotencyKey: KEY,
    });
    expect(order.pk).toBeUndefined();
    expect(order.requestHash).toBeUndefined();

    const put = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(put.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(put.Item?.pk).toBe(`ORDER#${order.orderId}`);

    const sends = sqsMock.commandCalls(SendMessageCommand);
    expect(sends).toHaveLength(1);
    expect(JSON.parse(sends[0].args[0].input.MessageBody!)).toEqual({ orderId: order.orderId });
    expect(sends[0].args[0].input.MessageAttributes?.correlationId.StringValue).toBe('req-123');
  });

  it('propagates a caller-supplied correlation ID to the response and the queue message', async () => {
    const res = await post(validBody, { 'idempotency-key': KEY, 'x-correlation-id': 'trace-abc' });
    expect(res.headers?.['x-correlation-id']).toBe('trace-abc');
    expect(bodyOf(res).correlationId).toBe('trace-abc');
    const attrs = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageAttributes;
    expect(attrs?.correlationId.StringValue).toBe('trace-abc');
  });

  it('returns the original order with 200 on a retry, without writing or enqueuing again', async () => {
    const first = await post();
    const second = await post();

    expect(second.statusCode).toBe(200);
    expect(bodyOf(second)).toEqual(bodyOf(first));
    expect(table.items.size).toBe(1);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    expect(emfDocs(logSpy).some((d) => d.DuplicateRequestsDetected === 1)).toBe(true);
  });

  it('creates exactly one order when many identical requests race', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, () => post()));
    const statuses = results.map((r) => r.statusCode);

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(24);
    expect(new Set(results.map((r) => bodyOf(r).orderId)).size).toBe(1);
    expect(table.items.size).toBe(1);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it('returns 422 when the key is reused with a different body', async () => {
    await post();
    const res = await post({ ...validBody, customerId: 'someone-else' });
    expect(res.statusCode).toBe(422);
    expect(bodyOf(res).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('re-enqueues a duplicate only if the order is still PENDING after the grace period', async () => {
    await post();
    const [item] = table.items.values();
    item.createdAt = new Date(Date.now() - 60_000).toISOString();

    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(2);

    item.status = 'CONFIRMED';
    await post();
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(2);
  });

  it.each([
    ['missing key', validBody, {}, 'INVALID_IDEMPOTENCY_KEY'],
    ['short key', validBody, { 'idempotency-key': 'abc' }, 'INVALID_IDEMPOTENCY_KEY'],
    ['invalid JSON', '{not json', { 'idempotency-key': KEY }, 'INVALID_JSON'],
    ['invalid body', { customerId: 'c', items: [] }, { 'idempotency-key': KEY }, 'VALIDATION_FAILED'],
  ])('returns 400 for %s', async (_name, body, headers, code) => {
    const res = await post(body, headers);
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error.code).toBe(code);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('accepts a base64-encoded body', async () => {
    const event = apiEvent({ body: Buffer.from(JSON.stringify(validBody)).toString('base64'), headers: { 'idempotency-key': KEY } });
    event.isBase64Encoded = true;
    expect((await handler(event)).statusCode).toBe(201);
  });

  it('returns a retryable 500 if enqueueing fails, and the retry repairs it', async () => {
    sqsMock.on(SendMessageCommand).rejectsOnce(new Error('SQS unavailable')).resolves({ MessageId: 'm-2' });
    setTestEnv({ REENQUEUE_AFTER_MS: '0' });

    const first = await post();
    expect(first.statusCode).toBe(500);
    expect(table.items.size).toBe(1);

    const retry = await post();
    expect(retry.statusCode).toBe(200);
    expect(bodyOf(retry).status).toBe('PENDING');
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(2);
  });

  it('emits an OrdersCreated EMF metric', async () => {
    await post();
    const doc = emfDocs(logSpy).find((d) => d.OrdersCreated === 1);
    expect(doc).toBeDefined();
    expect(doc?.Stage).toBe('test');
    expect(doc?._aws).toMatchObject({ CloudWatchMetrics: [{ Namespace: 'Relay', Dimensions: [['Stage']] }] });
  });

  it('returns 500 when DynamoDB fails unexpectedly', async () => {
    ddbMock.on(PutCommand).rejects(new Error('boom'));
    const res = await post();
    expect(res.statusCode).toBe(500);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });
});
