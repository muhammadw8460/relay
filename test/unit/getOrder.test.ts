import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../../src/handlers/getOrder';
import { DynamoDBDocumentClient, apiEvent, makeOrder, setTestEnv } from './helpers';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('getOrder', () => {
  beforeEach(() => {
    setTestEnv();
    ddbMock.reset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns the order without internal fields', async () => {
    const order = makeOrder({ status: 'CONFIRMED', version: 2 });
    ddbMock.on(GetCommand, { Key: { pk: order.pk } }).resolves({ Item: order });

    const res = await handler(apiEvent({ pathParameters: { id: order.orderId } }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body).toMatchObject({ orderId: order.orderId, status: 'CONFIRMED', version: 2 });
    expect(body.pk).toBeUndefined();
    expect(body.requestHash).toBeUndefined();
  });

  it('returns 404 for an unknown ID', async () => {
    ddbMock.on(GetCommand).resolves({});
    const res = await handler(apiEvent({ pathParameters: { id: 'ord_ffffffffffffffffffffffff' } }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body!).error.code).toBe('ORDER_NOT_FOUND');
  });

  it.each(['nope', 'ord_XYZ', '../../etc'])('returns 404 for a malformed ID (%s) without hitting DynamoDB', async (id) => {
    const res = await handler(apiEvent({ pathParameters: { id } }));
    expect(res.statusCode).toBe(404);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('returns 500 on a DynamoDB error', async () => {
    ddbMock.on(GetCommand).rejects(new Error('boom'));
    const res = await handler(apiEvent({ pathParameters: { id: 'ord_ffffffffffffffffffffffff' } }));
    expect(res.statusCode).toBe(500);
  });
});
